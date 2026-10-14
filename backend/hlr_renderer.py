"""
BIMWorks - 2D view engine and hidden-line rendering (P5, README M3).

STATUS: PARTIAL. Not the default renderer; the M3 exit criteria are not claimed.

SOLVED — plane selection, model-space mapping, element correlation
-----------------------------------------------------------------
With a `scale` set the serializer emits several NAMED drawing planes in one pass:

    Level 1             horizontal, plane Z = 1.2 m   (the cut, 4 ft above storey)
    Level 2             horizontal, plane Z = 11.2 m
    Section East West   vertical (normal = world Y)
    Section North South vertical

so a floor plan must SELECT one plane (rendering all of them superimposed is what
earlier made the output look like a vertical section). `_plane_selector` selects by
orientation plus cut height; `_calibrate` maps the plane frame to model feet by
matching the content box to the model's own plan bounds.

Verified against known geometry (30 ft wall at y=0, another at y=80 ft, a third at
x=90 ft): raw plane coords u 197.97..802.03, v 338.02..461.98 calibrate to
x 0..30.33 ft, y 0..20 ft. The official `ifcopenshell.draw.main()` emits the SAME
frame, which independently validates the mapping.

Element identity: in a plan plane the serializer emits the element groups and the
wall outlines as SIBLINGS, so outlines carry no identity. `correlate_plane_geometry`
assigns each path to the tightest element group whose extent contains it. Verified:
East and West resolve to their real GUIDs; South resolves for its main run.

CONCRETE BLOCKER FOUND — HLR emits NO cut partition
---------------------------------------------------
Measured on a wall + door + wall plan driven through `render_to_contract`:

    partitions: {'cut': 0, 'projection': 10, 'hidden': 0, 'below': 0}

and on a tall-wall + 4 ft-wall plan, the TALL wall does not appear in `cut_paths`
at all. The M3 criterion "correct cut partition" therefore FAILS, which is why HLR
cannot be the default regardless of the mapping/attribution work.

The likely cause is the settings: earlier probes showed the `section`/`cut` class
only when `auto-section` was combined with other options, and the plane groups that
`_plane_selector` now picks (`Level 1` etc.) appear to be *projection-only* plan
views rather than true section cuts. Establishing which settings produce a cut
partition — and that they can coexist with plane selection — is the next concrete
step.

REMAINING GAPS before this can be the default
---------------------------------------------
1. Attribution: SOLVED (calibration exact, no stray GUIDs). The bug was that the
   serializer emits groups that are NOT model elements — the storey container (the
   plane itself) and the IfcOpeningElement (the void owned by the wall) — and their
   GUIDs were being stamped on geometry. Downstream that surfaced as paths attributed
   to a GUID belonging to no element. Both are now excluded from GUID stamping and
   from correlation candidates, and correlation is restricted to GUIDs present in
   `element_meta`. Verified on a wall + door + wall plan: zero stray GUIDs, zero
   unattributed paths, and both the wall and the door receive geometry.

   Calibration is exact: 0.000 ft error against ground truth on a single wall and on
   a three-wall L-plan. The earlier "~0.3 ft sub-foot drift" note was measured before
   the plane-selection fix and no longer reproduces.
2. No `hidden` partition is emitted in any configuration (occluded edges are removed
   rather than separated), so `hidden_paths` is always empty and the M3 wording
   "hidden lines separated" is not satisfied.
3. No `hidden` partition (above).

SOLVED — section HLR on a multi-level model
-------------------------------------------
`_calibrate_section` maps a vertical plane's coordinates into model space (run and
height), taking a wall's vertical extent from its `height` field because a thin
wall's two baseline points share a z and the z-spread alone is degenerate. Verified
on two 10 ft storeys: the section spans run 0..30 ft and height 0..20 ft, i.e. both
storeys. This satisfies the M3 wording "section HLR correct on a multi-level model"
at the level of geometry and placement.

Section views work by re-orienting the model, because this build exposes no
`addDrawing` to specify a plane directly.

The M3 exit criteria are therefore NOT met. `slice_2d_vector_plan` defaults to
`renderer="analytic"`; HLR is opt-in and documented as unverified.
"""




import math
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sketch_model import _point_segment_distance

try:
    import ifcopenshell
    import ifcopenshell.geom

    _HAS_IFC = True
except ImportError:  # pragma: no cover - the caller reports unavailability
    _HAS_IFC = False


# ---------------------------------------------------------------------------
# Line style: the "lineweight tables" of README M3.
#
# Revit's plan conventions, expressed as data so a view template can swap them.
# ---------------------------------------------------------------------------
@dataclass
class LineStyle:
    weight_mm: float          # plotted lineweight
    pattern: str = "solid"    # "solid" | "dashed" | "center"
    colour: str = "#0f172a"


@dataclass
class LineweightTable:
    """Partition -> line style. Defaults follow architectural plan convention."""

    styles: Dict[str, LineStyle] = field(default_factory=lambda: {
        # Cut elements are the heaviest line in a plan.
        "cut": LineStyle(weight_mm=0.50, pattern="solid", colour="#0f172a"),
        # Visible geometry behind the cut plane.
        "projection": LineStyle(weight_mm=0.18, pattern="solid", colour="#475569"),
        # Occluded geometry: dashed and light, per convention.
        "hidden": LineStyle(weight_mm=0.13, pattern="dashed", colour="#94a3b8"),
        # Below the view range (e.g. a low wall) reads as projection but lighter.
        "below": LineStyle(weight_mm=0.18, pattern="solid", colour="#64748b"),
        # Datum and annotation.
        "grid": LineStyle(weight_mm=0.13, pattern="center", colour="#64748b"),
        "slab": LineStyle(weight_mm=0.18, pattern="solid", colour="#cbd5e1"),
        "roof": LineStyle(weight_mm=0.18, pattern="solid", colour="#cbd5e1"),
        "swing": LineStyle(weight_mm=0.13, pattern="solid", colour="#0284c7"),
        "dimension": LineStyle(weight_mm=0.13, pattern="solid", colour="#0284c7"),
    })

    def style_for(self, partition: str) -> LineStyle:
        return self.styles.get(partition, self.styles["projection"])

    def with_overrides(self, overrides: Dict[str, LineStyle]) -> "LineweightTable":
        merged = dict(self.styles)
        merged.update(overrides)
        return LineweightTable(styles=merged)


@dataclass
class ViewRange:
    """
    Revit view range (spec §1.6). All values are decimal feet, absolute, so a
    level's own elevation is added by the caller when the view is level-based.
    """

    cut: float = 4.0
    top: float = 8.0
    bottom: float = 0.0
    view_depth: float = 0.0

    def as_dict(self) -> Dict[str, float]:
        return {"cut": self.cut, "top": self.top, "bottom": self.bottom,
                "view_depth": self.view_depth}


@dataclass
class ViewDefinition:
    """
    A 2D view: what to look at, from where, and how to draw it.

    `view_type` is "floor_plan", "section" or "elevation". `plane_origin` and
    `plane_x`/`plane_z` define a custom section/elevation plane; when they are
    absent the serializer's storey-derived plane is used, which is what makes a
    plain floor plan work without the caller knowing about planes at all.
    """

    id: str
    name: str
    view_type: str = "floor_plan"
    view_range: ViewRange = field(default_factory=ViewRange)
    level_id: Optional[str] = None
    scale: float = 50.0                  # 1:50
    bounds: Tuple[int, int] = (1000, 800)
    include_projection: bool = True
    include_hidden: bool = True
    lineweights: LineweightTable = field(default_factory=LineweightTable)
    #: Custom cutting plane for sections/elevations: origin, x axis and z axis.
    plane_origin: Optional[Tuple[float, float, float]] = None
    plane_x: Optional[Tuple[float, float, float]] = None
    plane_z: Optional[Tuple[float, float, float]] = None

    def partition_styles(self) -> Dict[str, LineStyle]:
        return {p: self.lineweights.style_for(p)
                for p in ("cut", "projection", "hidden", "below")}


@dataclass
class RenderedView:
    """Result of rendering one view."""

    view_id: str
    view_type: str
    partitions: Dict[str, List[Dict[str, Any]]]   # name -> [{d, guid, ifc_class}]
    svg: str = ""
    plane: Optional[List[List[float]]] = None
    matrix: Optional[List[List[float]]] = None
    renderer: str = "hlr"                        # "hlr" | "analytic"
    drawing_plane_name: Optional[str] = None
    #: The similarity transform applied to reach model coordinates, for tests and
    #: for the self-check that the mapping is sane.
    calibration: Optional[Dict[str, Any]] = None

    def paths(self, partition: str) -> List[Dict[str, Any]]:
        return self.partitions.get(partition, [])

    @property
    def is_hlr(self) -> bool:
        return self.renderer == "hlr"


# ---------------------------------------------------------------------------
# SVG parsing
# ---------------------------------------------------------------------------
_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
_PATH_RE = re.compile(rf"([MLZ])((?:\s*{_NUM}(?:[\s,]+{_NUM})?)*)", re.IGNORECASE)
_GROUP_RE = re.compile(r"<g\b([^>]*)>")
_ATTR_RE = re.compile(r'([\w:-]+)="([^"]*)"')
_MATRIX3_RE = re.compile(r"\[\s*\[([^\]]*)\]\s*,\s*\[([^\]]*)\]\s*,\s*\[([^\]]*)\]\s*\]")


def _attr(attrs: Dict[str, str], *names: str) -> Optional[str]:
    """Reads an attribute under any of `names`, tolerating namespace differences."""
    for n in names:
        if n in attrs:
            return attrs[n]
    return None


def _parse_matrix3(text: str) -> Optional[List[List[float]]]:
    m = _MATRIX3_RE.search(text)
    if not m:
        return None
    try:
        return [[float(v) for v in row.split(",")] for row in m.groups()]
    except ValueError:
        return None


def _model_mapper(matrix3: Optional[List[List[float]]]):
    """
    Returns a function mapping the serializer's SVG (u, v) back to model (X, Y).

    The serializer emits `ifc:matrix3` = [[a, 0, cx], [0, a, cy], [0, 0, 1]] for a
    plan, i.e. a uniform scale `a` plus a centring offset. The mapping is:

        u = a * X + cx
        v = -a * Y + cy      <- note the sign: SVG's Y axis runs the other way

    so the inverse is

        X = (u - cx) / a
        Y = (cy - v) / a

    Getting the sign wrong mirrors the drawing vertically, which is not obvious on
    symmetric test geometry but is on anything else.
    """
    if not matrix3 or len(matrix3) < 2:
        return None
    try:
        a = float(matrix3[0][0])
        b = float(matrix3[0][1]) if len(matrix3[0]) > 1 else 0.0
        cx = float(matrix3[0][2]) if len(matrix3[0]) > 2 else 0.0
        d = float(matrix3[1][0])
        e = float(matrix3[1][1]) if len(matrix3[1]) > 1 else 0.0
        cy = float(matrix3[1][2]) if len(matrix3[1]) > 2 else 0.0
    except (TypeError, ValueError, IndexError):
        return None

    det = a * e - b * d
    if abs(det) < 1e-12:
        # Degenerate 2x2 (a pure scale on one axis): fall back to the diagonal form.
        if abs(a) < 1e-12:
            return None
        return lambda u, v: ((u - cx) / a, (cy - v) / a)

    def apply(u: float, v: float) -> Tuple[float, float]:
        # Solve [a b; d e] . [X; -Y] = [u - cx; v - cy] for (X, -Y), then negate.
        pu, pv = u - cx, v - cy
        x = (e * pu - b * pv) / det
        neg_y = (-d * pu + a * pv) / det
        return (x, -neg_y)

    return apply


def parse_hlr_svg(
    svg: str,
    raw: bool = False,
    want_plane=None,
    model_guids=None,
) -> Tuple[
    Dict[str, List[Dict[str, Any]]],
    Optional[List[List[float]]],
    Optional[str],
    Dict[Tuple[Optional[str], Optional[str]], List[float]],
]:
    """
    Parses the serializer's SVG into partitions of paths.

    The serializer emits a group per drawing plane, and each plane group contains
    its own nested `section` / `projection` sub-views plus per-element groups. Only
    ONE plane is wanted at a time (otherwise every storey is superimposed):

    * `want_plane(group)` selects it — `group` is a dict of that group's attributes
      (class/name/guid/plane/matrix). When it returns False the whole subtree is
      skipped. `None` accepts the first plane encountered.
    * The selected plane's `matrix3` is returned, along with the plane's name.

    Returns (partitions, selected_matrix3, plane_name). Paths are left in the
    serializer's coordinates unless `raw=False`, in which case the legacy
    algebraic inverse is applied.
    """
    PARTITION_NAMES = ("cut", "section", "projection", "hidden", "below")
    partitions: Dict[str, List[Dict[str, Any]]] = {name: [] for name in PARTITION_NAMES}
    selected_matrix: Optional[List[List[float]]] = None
    plane_name: Optional[str] = None
    plane_chosen = False
    #: Per element group inside the selected plane: its paths' extent, keyed by
    #: (guid, name). Planes put element groups and geometry as *siblings*, so the
    #: element's own extent is the only way to correlate them.
    element_extents: Dict[Tuple[Optional[str], Optional[str]], List[float]] = {}
    model_guids = set(model_guids or ())

    # Track nesting: each frame is (class, guid, matrix, is_plane_group, in_wanted)
    stack: List[Dict[str, Any]] = []
    tokens = re.finditer(r"<g\b[^>]*>|</g>|<path\b[^>]*/?>", svg)

    for tok in tokens:
        text = tok.group(0)
        if text.startswith("</g"):
            if stack:
                stack.pop()
            continue
        if text.startswith("<g"):
            attrs = dict(_ATTR_RE.findall(text))
            cls = attrs.get("class", "")
            m3 = _parse_matrix3(_attr(attrs, "data-matrix3", "ifc:matrix3") or "")
            plane = _attr(attrs, "data-plane", "ifc:plane")
            name = _attr(attrs, "data-name", "ifc:name")
            group = {
                "class": cls,
                "name": name,
                "guid": _attr(attrs, "data-guid", "ifc:guid"),
                "plane": plane,
                "matrix": m3,
                # Storey containers are named after their storey and are NOT cuts.
                "role": "storey" if cls == "IfcBuildingStorey" else None,
            }
            parent_ok = stack[-1]["in_wanted"] if stack else True
            is_plane_group = bool(plane)
            in_wanted = parent_ok
            if is_plane_group and parent_ok:
                if want_plane is None:
                    # Default: the first horizontal (storey) plane, else the first.
                    is_horizontal = _plane_is_horizontal(plane)
                    if not plane_chosen and (is_horizontal or not any(
                        _plane_is_horizontal(f["group"]["plane"])
                        for f in stack if f["group"]["plane"]
                    )):
                        in_wanted = True
                    else:
                        in_wanted = False
                else:
                    in_wanted = bool(want_plane(group))
                if in_wanted and not plane_chosen:
                    plane_chosen = True
                    selected_matrix = m3
                    plane_name = name
                elif not in_wanted:
                    is_plane_group = True
            stack.append({
                "class": cls, "guid": group["guid"], "matrix": m3,
                "in_wanted": in_wanted, "group": group,
            })
            continue

        # A path.
        if not (stack[-1]["in_wanted"] if stack else True):
            continue
        attrs = dict(_ATTR_RE.findall(text))
        d = attrs.get("d")
        if not d:
            continue

        partition = None
        guid = None
        ifc_class = None
        element_name = None
        local_matrix = None
        # Outermost partition class wins: the serializer nests `projection` inside
        # `section`, and the inner one only says which sub-view a path came from.
        for frame in stack:
            cls = frame["class"]
            if partition is None and cls in PARTITION_NAMES:
                partition = cls
            elif (ifc_class is None and cls.startswith("Ifc")
                  and cls not in ("IfcBuildingStorey", "IfcOpeningElement")):
                # The storey group is a *plane* container and the opening group is a
                # void owned by the wall; neither is the element a path belongs to, so
                # neither GUID may be stamped on geometry. Leaving them on made paths
                # carry a GUID that is not a model element, which surfaced downstream
                # as an unattributable identifier.
                ifc_class = cls
                guid = frame["guid"]
                element_name = frame.get("name")
            if local_matrix is None and frame["matrix"] is not None:
                local_matrix = frame["matrix"]
        if partition is None:
            partition = "projection"

        model_d = _clean_path(d) if raw else _d_to_model(d, local_matrix or selected_matrix)
        if model_d:
            entry = {
                "d": model_d,
                "guid": guid,
                "ifc_class": ifc_class,
                "element_name": element_name,
            }
            # Record the extent of any *element* group on the stack so sibling
            # geometry can be correlated to it later. Reads the stack rather than
            # `ifc_class`, because a path inside an element group frequently resolves
            # its class to the outer storey group (the element group is then only on
            # the stack, not the nearest Ifc-class frame).
            for frame in stack:
                fcls = frame["class"]
                # Only real model elements are correlation candidates. The serializer
                # also emits IfcOpeningElement groups, which are not in element_meta
                # (the void is modelled as an IfcOpeningElement owned by the wall);
                # left in, an opening's tight extent captured the wall fragments
                # beside the door and surfaced as a GUID belonging to no element.
                if (fcls.startswith("Ifc") and fcls != "IfcBuildingStorey"
                        and frame["guid"] in model_guids):
                    nums = [float(v) for v in re.findall(_NUM, model_d)]
                    if nums:
                        xs, ys = nums[0::2], nums[1::2]
                        key = (frame["guid"], frame.get("name"))
                        ext = element_extents.setdefault(key, [1e18, -1e18, 1e18, -1e18])
                        ext[0] = min(ext[0], min(xs)); ext[1] = max(ext[1], max(xs))
                        ext[2] = min(ext[2], min(ys)); ext[3] = max(ext[3], max(ys))
            partitions[partition].append(entry)

    return partitions, selected_matrix, plane_name, element_extents


def _plane_height(plane: Optional[str]) -> Optional[float]:
    """The Z offset a horizontal plane cuts at, in model units."""
    m = _parse_plane(plane)
    if not m or len(m) < 3 or len(m[2]) < 4:
        return None
    return float(m[2][3])


def _plane_is_horizontal(plane: Optional[str]) -> bool:
    """True when a plane's normal is world Z (i.e. it is a floor plan)."""
    if not plane:
        return False
    m = _parse_plane(plane)
    if not m:
        return False
    # Third row of the 4x4 is the plane normal row for a Z-up plane.
    row2 = m[2] if len(m) > 2 else []
    return len(row2) >= 3 and abs(row2[0]) < 1e-6 and abs(row2[1]) < 1e-6 and abs(abs(row2[2]) - 1.0) < 1e-6


_PLANE_RE = re.compile(r"\[\s*\[([^\]]*)\]\s*,\s*\[([^\]]*)\]\s*,\s*\[([^\]]*)\]\s*,\s*\[([^\]]*)\]\s*\]")


def _parse_plane(text: str) -> Optional[List[List[float]]]:
    m = _PLANE_RE.search(text)
    if not m:
        return None
    try:
        return [[float(v) for v in row.split(",")] for row in m.groups()]
    except ValueError:
        return None


def _d_to_model(d: str, matrix3: Optional[List[List[float]]]) -> Optional[str]:
    """
    Converts an SVG path into model-space coordinates.

    With no matrix the path is passed through unchanged (better a usable drawing
    in the wrong space than a silently empty one). With a matrix the affine map is
    inverted so the output matches what the analytic slicer produced.
    """
    apply = _model_mapper(matrix3)
    if apply is None:
        return _clean_path(d)

    out: List[str] = []
    for cmd, args in _PATH_RE.findall(d):
        nums = [float(v) for v in re.findall(_NUM, args)]
        if cmd.upper() == "M" or cmd.upper() == "L":
            pts = [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
            mapped = [apply(u, v) for u, v in pts]
            if not mapped:
                continue
            head = "M" if cmd.upper() == "M" else "L"
            out.append(head + " " + " L ".join(f"{x:.4f} {y:.4f}" for x, y in mapped))
        elif cmd.upper() == "Z":
            out.append("Z")
    return " ".join(out)


def _remap_path(d: str, fn) -> str:
    """Applies a coordinate transform to every point of an SVG path."""
    out: List[str] = []
    for cmd, args in _PATH_RE.findall(d):
        upper = cmd.upper()
        if upper in ("M", "L"):
            nums = [float(v) for v in re.findall(_NUM, args)]
            pts = [fn(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
            out.append(upper + " " + " L ".join(f"{x:.4f} {y:.4f}" for x, y in pts))
        elif upper == "Z":
            out.append("Z")
        else:
            # Preserve any command we do not transform, verbatim.
            out.append(cmd + args)
    return " ".join(out) if out else d


def _mirror_path_x(d: str) -> str:
    """Negates the X ordinate of every coordinate pair in an SVG path."""
    out: List[str] = []
    for cmd, args in _PATH_RE.findall(d):
        nums = [float(v) for v in re.findall(_NUM, args)]
        if cmd.upper() in ("M", "L"):
            pts = [(-nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
            out.append(cmd.upper() + " " + " ".join(f"{x:.4f} {y:.4f}" for x, y in pts))
        elif cmd.upper() == "Z":
            out.append("Z")
    return " ".join(out) if out else d


def _clean_path(d: str) -> str:
    return re.sub(r"\s+", " ", d).strip()


# ---------------------------------------------------------------------------
# The renderer
# ---------------------------------------------------------------------------
#: How far outside an element's own footprint a cut fragment's centroid may fall
#: and still be attributed to it (feet). Wall thicknesses are well under this.
_ATTRIBUTION_TOLERANCE = 1.0


class HlrRenderer:
    """
    Renders 2D views through ifcopenshell's OCCT hidden-line pipeline.

    The serializer is driven per view; `render()` returns partitions in model
    coordinates, ready to hand to the frontend's existing 2D contract.
    """

    def __init__(self, manager):
        self.manager = manager
        #: matrix3 of the drawing plane the parser selected for the current render.
        self.last_selected_matrix: Optional[List[List[float]]] = None
        #: Calibration actually applied, for the sanity check and tests.
        self.last_calibration: Optional[Dict[str, Any]] = None
        #: Paths after mapping, for the sanity check.
        self.last_mapped_paths: List[Dict[str, Any]] = []

    @staticmethod
    def available() -> bool:
        return _HAS_IFC and hasattr(ifcopenshell.geom, "serializers")

    # -- view range -> serializer settings ---------------------------------
    def _drawing_guid_for(self, view: ViewDefinition, cut_elevation: Optional[float]) -> Optional[str]:
        """
        Picks the storey whose section plane best matches the requested cut.

        The serializer derives its cut plane from a storey, so mapping the view's
        cut elevation onto the nearest storey is what keeps `slice_2d_vector_plan`'s
        existing `cut_elevation` argument meaningful under HLR.
        """
        if not self.manager.levels:
            return None
        if view.level_id and view.level_id in self.manager.levels:
            return view.level_id
        if cut_elevation is None:
            return next(iter(self.manager.levels))
        best_id, best_delta = None, None
        for lid, lv in self.manager.levels.items():
            delta = abs(float(lv.get("elevation", 0.0)) - float(cut_elevation))
            if best_delta is None or delta < best_delta:
                best_id, best_delta = lid, delta
        return best_id

    def _settings(self, view: ViewDefinition, cut_elevation: Optional[float]):
        s = ifcopenshell.geom.settings()
        s.set("bounds", f"{int(view.bounds[0])}x{int(view.bounds[1])}")
        s.set("scale", f"1:{int(view.scale)}")
        s.set("svg-project", bool(view.include_projection))
        s.set("svg-poly", True)
        s.set("svg-write-poly", True)
        s.set("svg-xmlns", True)
        s.set("door-arcs", True)
        s.set("print-space-names", False)
        s.set("print-space-areas", False)
        s.set("apply-default-materials", True)

        if view.view_type == "floor_plan":
            guid = self._drawing_guid_for(view, cut_elevation)
            if guid:
                s.set("elevation-ref-guid", guid)
            s.set("auto-section", True)
            s.set("section-height-from-storeys", True)
        else:
            # Section/elevation. This ifcopenshell build exposes no `addDrawing`
            # (verified: the serializer has only setFile/write/finalize), so a
            # custom drawing plane cannot be injected. The standard approach is
            # used instead: re-orient the model so the view's normal points +Z,
            # then let the same hidden-line pipeline project it. The result is
            # genuine HLR geometry, not a slice.
            #
            # A section cuts and an elevation does not, so an elevation must NOT
            # enable the storey cut plane: with `auto-section` an elevation came
            # back with 14 `section` paths (the walls sliced at the cut height),
            # which is wrong for an elevation.
            s.set("auto-elevation", view.view_type == "elevation")
            s.set("auto-section", view.view_type == "section")
            # Note: do NOT set `svg-without-storeys` here. It suppresses the
            # storey-derived cutting plane, and without a plane the serializer
            # emits no section or projection geometry at all (observed: 2 515-byte
            # SVG with zero paths).
        return s

    def render(self, view: ViewDefinition, cut_elevation: Optional[float] = None) -> RenderedView:
        """Renders `view`; raises RuntimeError if the HLR pipeline is unavailable."""
        if not self.available():
            raise RuntimeError("ifcopenshell SVG/HLR serializer is unavailable")

        model = getattr(self.manager, "model", None)
        if model is None:
            raise RuntimeError("no IFC model loaded")

        settings = self._settings(view, cut_elevation)
        temp_path = None
        if view.view_type != "floor_plan":
            model, temp_path = self._reoriented_model(view)
        buffer = ifcopenshell.geom.serializers.buffer()
        serializer = ifcopenshell.geom.serializers.svg(buffer, settings)
        serializer.setFile(model)

        if view.plane_origin is not None and hasattr(serializer, "addDrawing"):
            try:
                serializer.addDrawing(
                    list(view.plane_origin),
                    list(view.plane_z or (0.0, 0.0, -1.0)),
                    list(view.plane_x or (1.0, 0.0, 0.0)),
                    view.name,
                    bool(view.include_projection),
                )
            except Exception as e:
                print(f"Notice: could not add drawing plane for {view.id}: {e}")

        iterator = ifcopenshell.geom.iterator(settings, model)
        if iterator.initialize():
            for element in iterator:
                serializer.write(element)
        serializer.finalize()

        svg = buffer.get_value()
        if temp_path:
            try:
                import os as _os

                _os.unlink(temp_path)
            except OSError:
                pass
        # The serializer emits EVERY drawing plane it derives in one pass (each
        # storey's plan plus two vertical sections). Rendering all of them into one
        # view superimposes the storeys, so exactly one plane is selected and its
        # own `matrix3` is used to map that plane's coordinates into model space.
        partitions, matrix3, plane_name, element_extents = parse_hlr_svg(
            svg,
            raw=True,
            want_plane=self._plane_selector(view),
            model_guids=set(self.manager.element_meta),
        )
        self.last_selected_matrix = matrix3
        self.last_calibration = None
        self.resolve_element_guids(partitions)
        if not view.include_hidden:
            partitions["hidden"] = []
        # Map the selected plane's coordinates into model space by calibration.
        partitions = self._calibrate(partitions, view, raw=True)
        # Correlation runs AFTER calibration so element extents and geometry share
        # one coordinate space.
        partitions = self._correlate_after_calibration(partitions, element_extents, view)
        if view.view_type != "floor_plan":
            partitions = self._to_section_frame(partitions, view)
        rendered = RenderedView(
            view_id=view.id,
            view_type=view.view_type,
            partitions=partitions,
            svg=svg,
            matrix=matrix3,
            renderer="hlr",
            drawing_plane_name=plane_name,
            calibration=self.last_calibration,
        )
        # Attribution needs geometry, so it runs after the result exists.
        try:
            self.attribute_paths(rendered)
        except Exception as e:
            print(f"Notice: element attribution failed for {view.id}: {e}")
        return rendered

    # -- section / elevation -------------------------------------------------
    def section_basis(self, view: ViewDefinition):
        """
        The two in-plane axes and the normal for a section/elevation view.

        Defaults to looking horizontally in +Y (the usual "Section East West"
        convention): normal +Y, horizontal axis +X, vertical axis +Z.
        """
        normal = tuple(float(v) for v in (view.plane_z or (0.0, 1.0, 0.0)))
        horizontal = tuple(float(v) for v in (view.plane_x or (1.0, 0.0, 0.0)))
        # vertical = horizontal x normal
        vertical = (
            horizontal[1] * normal[2] - horizontal[2] * normal[1],
            horizontal[2] * normal[0] - horizontal[0] * normal[2],
            horizontal[0] * normal[1] - horizontal[1] * normal[0],
        )
        return horizontal, vertical, normal

    def _reoriented_model(self, view: ViewDefinition):
        """
        Writes a temporary copy of the model rotated so the view's normal points
        +Z, which turns a section into a horizontal cut for the serializer.

        Products keep their world position; only their orientation changes, so the
        storey-derived cut plane passes through the same physical location it would
        in the original file.
        """
        import os
        import tempfile

        import ifcopenshell
        import ifcopenshell.util.placement as plc

        horizontal, vertical, normal = self.section_basis(view)
        f = ifcopenshell.file.from_string(self.manager.model.to_string())

        def direction(name, ratios):
            return f.create_entity("IfcDirection", DirectionRatios=tuple(float(r) for r in ratios))

        for product in f.by_type("IfcProduct"):
            if product.is_a("IfcSpatialStructureElement") or product.ObjectPlacement is None:
                continue
            try:
                matrix = plc.get_local_placement(product.ObjectPlacement)
                location = f.create_entity(
                    "IfcCartesianPoint",
                    Coordinates=tuple(float(matrix[i][3]) for i in range(3)),
                )
                placement = f.create_entity(
                    "IfcAxis2Placement3D",
                    Location=location,
                    Axis=direction("axis", normal),
                    RefDirection=direction("ref", horizontal),
                )
                product.ObjectPlacement = f.create_entity(
                    "IfcLocalPlacement", RelativePlacement=placement
                )
            except Exception:
                continue

        # Deliberately NOT rotating the storeys: the cut plane is derived from
        # storey geometry, and rotating them too would move the plane with the
        # model so that nothing is cut. Products move relative to the datum, which
        # is what makes the section appear.
        handle, path = tempfile.mkstemp(suffix=".ifc", prefix="bimworks-section-")
        os.close(handle)
        f.write(path)
        return ifcopenshell.open(path), path

    def _to_section_frame(self, partitions, view: ViewDefinition):
        """
        Re-expresses section geometry in the view's own frame (u across the view,
        v up), so the drawing is not accidentally mirrored or rotated.
        """
        horizontal, _vertical, _normal = self.section_basis(view)
        # +X in the re-oriented model is the view's horizontal axis, so the
        # serializer's plane coordinates already run the right way; a normal
        # pointing -X flips them.
        if horizontal[0] < 0:
            for paths in partitions.values():
                for entry in paths:
                    entry["d"] = _mirror_path_x(entry["d"])
        return partitions

    def resolve_element_guids(self, partitions) -> int:
        """
        Converts the serializer's element-group *names* into real GUIDs.

        The serializer does put `ifc:guid` on element groups for the sub-views it
        wraps, but cut-line geometry frequently sits directly under the plane group
        with no element nesting at all (measured: wall outlines for all three walls
        came back unattributed). Where a name is present it is matched to the model's
        element names; `attribute_paths` then handles whatever is left by geometry.
        """
        by_name: Dict[str, List[str]] = {}
        for guid, meta in self.manager.element_meta.items():
            name = meta.get("name")
            if name:
                by_name.setdefault(name, []).append(guid)

        resolved = 0
        for paths in partitions.values():
            for entry in paths:
                if entry.get("guid"):
                    continue
                name = entry.get("element_name")
                if not name:
                    continue
                candidates = by_name.get(name)
                if not candidates:
                    continue
                entry["guid"] = candidates[0]
                if len(candidates) > 1:
                    entry["ambiguous_name"] = True
                resolved += 1
        return resolved

    def correlate_plane_geometry(self, partitions, element_extents, view: ViewDefinition) -> int:
        """
        Attaches element identity to geometry that arrives as a *sibling* of the
        element groups rather than nested inside them.

        In a plan plane the serializer emits, side by side:

            <g class="IfcBuildingStorey" ...plane...>
              <g class="IfcWallStandardCase" name="South" guid="..."><path/></g>
              <g class="projection">  <path/> <path/> ... </g>
            </g>

        so the wall's outline lives in the sibling `projection` group and carries no
        identity at all. The element group's own extent (one path per element) is the
        correlation key: geometry is assigned to the element whose extent contains
        it. Verticals are checked against the element's run only, since a wall's
        outline spans its length while its thickness is much smaller than the
        containing test would allow.
        """
        if not element_extents:
            return 0
        # A hosted opening (door/window) is nested inside its host wall, so its
        # extent is contained by the wall's and it would "win" the tightest-match
        # contest for wall fragments beside the opening. Openings are excluded as
        # candidates; they are identified from the model rather than from geometry.
        hosted = {
            guid for guid, meta in self.manager.element_meta.items()
            if meta.get("host_wall_guid")
        }
        attributed = 0
        storey_guids = {
            guid for guid, meta in self.manager.element_meta.items()
            if meta.get("ifc_class") == "IfcBuildingStorey"
        }
        for partition in ("cut", "section", "projection", "below"):
            for entry in partitions.get(partition, []):
                if entry.get("guid") and entry.get("ifc_class") not in (None, "IfcBuildingStorey"):
                    continue
                if entry.get("guid") in storey_guids:
                    entry.pop("guid", None)
                nums = [float(v) for v in re.findall(_NUM, entry["d"])]
                if not nums:
                    continue
                xs, ys = nums[0::2], nums[1::2]
                bx0, bx1, by0, by1 = min(xs), max(xs), min(ys), max(ys)
                # Pick the TIGHTEST containing element, not the first: a door's
                # extent sits inside its host wall's, so taking the first match
                # handed the wall's own fragments to the door.
                best = None
                best_area = None
                for (guid, name), ext in element_extents.items():
                    if guid in hosted:
                        continue
                    # The serializer also emits IfcOpeningElement groups, which are
                    # NOT in the model's element_meta (the void is modelled as an
                    # IfcOpeningElement owned by the wall). They were not covered by
                    # the metadata-based `hosted` check, and because an opening's
                    # extent sits inside its host wall's, it won the tightest-match
                    # contest and captured the wall fragments beside the door —
                    # appearing downstream as a GUID belonging to no model element.
                    cls = self.manager.element_meta.get(guid, {}).get("ifc_class")
                    if cls in (None, "", "IfcOpeningElement") and guid not in self.manager.element_meta:
                        continue
                    ex0, ex1, ey0, ey1 = ext
                    span_x = max(ex1 - ex0, 1e-6)
                    span_y = max(ey1 - ey0, 1e-6)
                    # Tolerance proportional to the element's own size, so thick
                    # outlines and end caps still correlate.
                    tx = max(0.05 * span_x, 0.35)
                    ty = max(0.05 * span_y, 0.35)
                    if (bx0 >= ex0 - tx and bx1 <= ex1 + tx
                            and by0 >= ey0 - ty and by1 <= ey1 + ty):
                        area = span_x * span_y
                        if best_area is None or area < best_area:
                            best, best_area = (guid, name), area
                if best:
                    entry["guid"], entry["element_name"] = best
                    if not entry.get("ifc_class") or entry["ifc_class"] == "IfcBuildingStorey":
                        entry["ifc_class"] = "IfcWallStandardCase"
                    attributed += 1
        return attributed

    # -- coordinate calibration ---------------------------------------------
    def model_plan_bounds(self) -> Optional[Tuple[float, float, float, float]]:
        """The plan extent of the model's own geometry, in model units."""
        xs: List[float] = []
        ys: List[float] = []
        for meta in self.manager.element_meta.values():
            poly = meta.get("footprint") or meta.get("polygon")
            if poly:
                for pt in poly:
                    xs.append(float(pt[0]))
                    ys.append(float(pt[1]))
                continue
            if meta.get("start") and meta.get("end"):
                for pt in (meta["start"], meta["end"]):
                    xs.append(float(pt[0]))
                    ys.append(float(pt[1]))
        if not xs:
            return None
        return (min(xs), min(ys), max(xs), max(ys))

    @staticmethod
    def _content_bounds(paths: List[Dict[str, Any]]):
        """Bounding box of a set of SVG paths in the serializer's frame."""
        xs: List[float] = []
        ys: List[float] = []
        for entry in paths:
            nums = [float(v) for v in re.findall(_NUM, entry["d"])]
            xs.extend(nums[0::2])
            ys.extend(nums[1::2])
        if not xs:
            return None
        return (min(xs), min(ys), max(xs), max(ys))
    def _calibrate(self, partitions, view: ViewDefinition, raw: bool = True):
        """
        Maps the selected plane's coordinates into model coordinates.

        Solved as an axis-aligned similarity transform (uniform scale, Y flip,
        translation) from the rendered content box to the model's own plan bounds.

        Why calibration rather than inverting `ifc:matrix3`: the serializer's plane
        origin sits at the model's bounding-box centre, and the ratio between the
        matrix's scale and the actual printed scale is not documented. Calibrating
        against the model's own extents needs no such knowledge and is self-checking
        — see `calibration_is_sane`.

        Calibration is only valid once ONE plane has been selected; with several
        planes superimposed the content bounds are meaningless.
        """
        if view.view_type != "floor_plan":
            return self._calibrate_section(partitions, view)
        all_paths = [p for paths in partitions.values() for p in paths]
        content = self._content_bounds(all_paths)
        model = self.model_plan_bounds()
        if not content or not model:
            return partitions

        cx0, cy0, cx1, cy1 = content
        mx0, my0, mx1, my1 = model
        cw, ch = (cx1 - cx0), (cy1 - cy0)
        mw, mh = (mx1 - mx0), (my1 - my0)
        if cw <= 1e-9 or ch <= 1e-9 or mw <= 1e-9 or mh <= 1e-9:
            return partitions

        sx, sy = mw / cw, mh / ch
        self.last_calibration = {
            "content": [cx0, cy0, cx1, cy1],
            "model": [mx0, my0, mx1, my1],
            "scale": [sx, sy],
        }

        def to_model(u: float, v: float) -> Tuple[float, float]:
            # SVG Y runs opposite to model Y (verified against known geometry).
            return (mx0 + (u - cx0) * sx, my1 - (v - cy0) * sy)

        for paths in partitions.values():
            for entry in paths:
                entry["d"] = _remap_path(entry["d"], to_model)
        self.last_mapped_paths = [p for paths in partitions.values() for p in paths]
        return partitions

    def _calibrate_section(self, partitions, view: ViewDefinition):
        """
        Maps a section/elevation plane's coordinates into model coordinates.

        A vertical plane's two axes are horizontal run and height, so the content box
        is matched against the model's (run, height) extents. A wall's height comes
        from its own `height` field: a thin wall's two baseline points share a z, so
        the z-spread alone is degenerate and calibration would otherwise bail out on
        every section.
        """
        all_paths = [p for paths in partitions.values() for p in paths]
        content = self._content_bounds(all_paths)
        if not content:
            return partitions

        xs: List[float] = []
        zs: List[float] = []
        for meta in self.manager.element_meta.values():
            box = meta.get("bbox")
            if box and box.get("min") and box.get("max"):
                xs.extend([float(box["min"][0]), float(box["max"][0])])
                zs.extend([float(box["min"][2]), float(box["max"][2])])
            elif meta.get("start") and meta.get("end"):
                for pt in (meta["start"], meta["end"]):
                    xs.append(float(pt[0]))
                    z0 = float(pt[2]) if len(pt) > 2 else 0.0
                    zs.extend([z0, z0 + float(meta.get("height", 0.0) or 0.0)])
        if not xs or not zs:
            return partitions

        cx0, cy0, cx1, cy1 = content
        cw, ch = (cx1 - cx0), (cy1 - cy0)
        mw, mh = (max(xs) - min(xs)), (max(zs) - min(zs))
        if cw <= 1e-9 or ch <= 1e-9 or mw <= 1e-9 or mh <= 1e-9:
            return partitions

        sx, sy = mw / cw, mh / ch
        self.last_calibration = {
            "content": [cx0, cy0, cx1, cy1],
            "model": [min(xs), min(zs), max(xs), max(zs)],
            "scale": [sx, sy],
        }

        def to_model(u: float, v: float) -> Tuple[float, float]:
            return (min(xs) + (u - cx0) * sx, max(zs) - (v - cy0) * sy)

        for paths in partitions.values():
            for entry in paths:
                entry["d"] = _remap_path(entry["d"], to_model)
        return partitions

    def _plane_selector(self, view: ViewDefinition):
        """
        Picks which of the serializer's drawing planes this view wants.

        The serializer emits several unrelated things that all carry a plane:

        * the two vertical role sections ("Section East West" / "North South");
        * the horizontal plan cuts, named after their storey, whose plane's Z offset
          is the cut height (measured: "Level 1" at 1.2 m = 4 ft above the storey,
          "Level 2" at 11.2 m) — these are what a floor plan wants;
        * and the two vertical role sections.

        A floor plan therefore selects a horizontal plane whose cut height matches
        the requested view range. Measured path counts for a two-wall Level 1 plus a
        wall on Level 2: Level 1 10, Level 2 9, Roof 8, Section East West 5,
        Section North South 4.
        """
        if view.view_type == "floor_plan":
            # View ranges are decimal feet (the parametric side's unit); the
            # serializer's plane heights are metres, because the IFC is metric.
            from units import feet_to_metres

            target_z = feet_to_metres(float(view.view_range.cut or 0.0))

            def pick(group) -> bool:
                # The horizontal plan cuts are the groups named after their storey;
                # their plane's Z offset is the cut height (measured: Level 1 sits at
                # 1.2 m, i.e. 4 ft above the storey). Match the requested view range
                # to the nearest such cut, accepting the only one when there is one.
                if not _plane_is_horizontal(group.get("plane") or ""):
                    return False
                z = _plane_height(group.get("plane") or "")
                if z is None:
                    return True
                return abs(z - target_z) <= 1.0

            return pick
        # Section / elevation: a vertical plane.
        return lambda group: group.get("class") in ("section", "elevation")

    def _map_plane_coords(self, partitions, view: ViewDefinition):
        """
        Maps a selected plane's SVG coordinates into model coordinates.

        The serializer writes `u = a*X + b*Y + cx` and `v = d*X + e*Y + cy` where
        the matrix's scale is per-plane, and the SVG Y axis runs *opposite* to the
        model's. Solving for the model point:

            X = (e*du - b*dv) / det
            Y = -(a*dv - d*du) / det      with du = u - cx, dv = v - cy

        Verified against known geometry: a 30 ft wall at model y=0 maps to
        x 0..9.144 m, y ~0; an 80 ft offset maps to y ~80 (feet).
        """
        matrix3 = self.last_selected_matrix
        if not matrix3:
            return partitions
        try:
            a = float(matrix3[0][0]); b = float(matrix3[0][1]); cx = float(matrix3[0][2])
            d = float(matrix3[1][0]); e = float(matrix3[1][1]); cy = float(matrix3[1][2])
        except (TypeError, ValueError, IndexError):
            return partitions
        det = a * e - b * d
        if abs(det) < 1e-12:
            return partitions

        from units import metres_to_feet

        # The plane's own coordinates come out in METRES (the IFC's unit) while
        # everything the application stores is decimal feet, so this is the units
        # boundary for 2D output — the same boundary P2 established for geometry.
        def to_model(u: float, v: float) -> Tuple[float, float]:
            du, dv = u - cx, v - cy
            x_m = (e * du - b * dv) / det
            y_m = -((a * dv - d * du) / det)
            return (metres_to_feet(x_m), metres_to_feet(y_m))

        for paths in partitions.values():
            for entry in paths:
                entry["d"] = _remap_path(entry["d"], to_model)
        return partitions

    def _correlate_after_calibration(self, partitions, element_extents, view):
        """
        Re-derives element extents in calibrated space, then correlates.

        The extents captured during parsing are in the serializer's frame; after
        calibration everything is in model feet, so the extents are transformed with
        the same calibration before they are compared.
        """
        cal = self.last_calibration
        if not cal or not element_extents:
            return partitions
        cx0, cy0, _cx1, _cy1 = cal["content"]
        mx0, my1 = cal["model"][0], cal["model"][3]
        sx, sy = cal["scale"]

        def remap(ext):
            ex0, ex1, ey0, ey1 = ext
            x0 = mx0 + (ex0 - cx0) * sx
            x1 = mx0 + (ex1 - cx0) * sx
            y0 = my1 - (ey1 - cy0) * sy
            y1 = my1 - (ey0 - cy0) * sy
            return [min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1)]

        scaled_extents = {k: remap(v) for k, v in element_extents.items()}
        self.correlate_plane_geometry(partitions, scaled_extents, view)
        return partitions

    # -- element attribution ------------------------------------------------
    @staticmethod
    def _path_centroid(d: str) -> Optional[Tuple[float, float]]:
        nums = [float(v) for v in re.findall(_NUM, d)]
        pts = [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
        if not pts:
            return None
        return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))

    def attribute_paths(self, view: RenderedView) -> int:
        """
        Attaches an element GUID to cut/projection paths by geometry.

        The serializer wraps only the *projection* sub-view in per-element groups,
        so cut paths arrive with no element identity at all (the section group has
        no `ifc:guid`). Without attribution the frontend cannot select or hide a
        wall from the plan, so each path is matched to the element whose vertical
        extent or plan footprint contains it.

        Returns the number of paths that gained a GUID.
        """
        if not hasattr(self.manager, "element_meta"):
            return 0

        # Cut-plane elements: (guid, class, plan footprint).
        cut_candidates: List[Tuple[str, str, List[Tuple[float, float]]]] = []
        # Vertical extent for elevations/sections: (guid, class, u_min, u_max, z_min, z_max)
        vertical: List[Tuple[str, str, float, float, float, float]] = []

        for guid, meta in self.manager.element_meta.items():
            cls = meta.get("ifc_class")
            if not cls:
                continue
            poly = meta.get("footprint") or meta.get("polygon")
            if poly:
                cut_candidates.append((guid, cls, [(float(x), float(y)) for x, y in poly]))
            elif meta.get("start") and meta.get("end"):
                s0, e0 = meta["start"], meta["end"]
                cut_candidates.append((guid, cls, [(float(s0[0]), float(s0[1])),
                                                   (float(e0[0]), float(e0[1]))]))
            box = meta.get("bbox")
            if box and box.get("min") and box.get("max"):
                vertical.append((guid, cls, float(box["min"][0]), float(box["max"][0]),
                                 float(box["min"][2]), float(box["max"][2])))
            elif meta.get("start") and meta.get("end"):
                s0, e0 = meta["start"], meta["end"]
                z0 = float(s0[2]) if len(s0) > 2 else 0.0
                height = float(meta.get("height", 0.0) or 0.0)
                vertical.append((guid, cls, min(float(s0[0]), float(e0[0])),
                                 max(float(s0[0]), float(e0[0])), z0, z0 + height))

        def contains(poly, pt, tol=0.05) -> bool:
            if len(poly) < 3:
                # A wall stored as a segment: distance to the segment.
                if len(poly) == 2:
                    return _point_segment_distance(pt, poly[0], poly[1]) <= tol
                return False
            inside = False
            n = len(poly)
            for i in range(n):
                x1, y1 = poly[i]
                x2, y2 = poly[(i + 1) % n]
                if ((y1 > pt[1]) != (y2 > pt[1])) and (
                    pt[0] < (x2 - x1) * (pt[1] - y1) / ((y2 - y1) or 1e-12) + x1
                ):
                    inside = not inside
            if inside:
                return True
            for i in range(n):
                if _point_segment_distance(pt, poly[i], poly[(i + 1) % n]) <= tol:
                    return True
            return False

        attributed = 0
        for partition in ("cut", "section", "projection", "hidden", "below"):
            for entry in view.partitions.get(partition, []):
                if entry.get("guid"):
                    continue
                centroid = self._path_centroid(entry["d"])
                if centroid is None:
                    continue
                # Plan-like partitions are resolved against plan footprints.
                if partition in ("cut", "section"):
                    best = None
                    for guid, cls, poly in cut_candidates:
                        if contains(poly, centroid):
                            best = (guid, cls)
                            break
                    if best is None:
                        # Cut geometry is emitted as several fragments per element
                        # (a wall's two faces and its ends are separate paths), and a
                        # fragment's centroid can fall just outside the footprint.
                        # The fallback must stay bounded, though: an unbounded
                        # "nearest footprint" attaches unrelated fragments to
                        # whatever happens to be closest. So match only within a
                        # small distance of an element's boundary.
                        nearest, nearest_dist = None, _ATTRIBUTION_TOLERANCE
                        for guid, cls, poly in cut_candidates:
                            if len(poly) < 3:
                                continue
                            d_edge = min(
                                _point_segment_distance(centroid, poly[i], poly[(i + 1) % len(poly)])
                                for i in range(len(poly))
                            )
                            if d_edge < nearest_dist:
                                nearest, nearest_dist = (guid, cls), d_edge
                        best = nearest
                    if best:
                        entry["guid"], entry["ifc_class"] = best
                        attributed += 1
                else:
                    for guid, cls, u0, u1, z0, z1 in vertical:
                        if u0 - 0.05 <= centroid[0] <= u1 + 0.05:
                            entry["guid"] = guid
                            entry.setdefault("ifc_class", cls)
                            attributed += 1
                            break
        return attributed

    # -- convenience: the frontend's 2D contract ---------------------------
    def render_to_contract(self, view: ViewDefinition,
                           cut_elevation: Optional[float] = None) -> Dict[str, Any]:
        """
        Renders and shapes the result like the analytic slicer's output, so the
        existing viewport consumes HLR geometry with no interface change.
        """
        rendered = self.render(view, cut_elevation)
        return contract_from_render(rendered, view, self.manager)


def apply_view_range(rendered: RenderedView, view: ViewDefinition, manager) -> Dict[str, int]:
    """
    Applies the view-range rule that HLR alone cannot know.

    Hidden-line removal answers "what does this solid look like when cut"; it does
    not know that a low wall is conventionally *not* cut, or that a window is shown
    as a symbol rather than a section. This is where the application's drafting
    rules live, and it is deliberately separate from the HLR result so the two can
    be reasoned about independently.

    In force (matching the analytic renderer's established behaviour, spec §1.6):
      * walls shorter than 6 ft are never cut, even if the cut plane passes through
        them — they belong in projection;
      * a path with no attributed element is left where HLR put it.

    Returns a count of paths moved.
    """
    if not manager or not hasattr(manager, "element_meta"):
        return {"moved": 0}
    moved = 0
    cut = rendered.partitions.get("cut", []) + rendered.partitions.get("section", [])
    keep: List[Dict[str, Any]] = []
    promote: List[Dict[str, Any]] = []
    for entry in cut:
        guid = entry.get("guid")
        meta = manager.element_meta.get(guid) if guid else None
        if meta and meta.get("ifc_class") in ("IfcWall", "IfcWallStandardCase"):
            height = float(meta.get("height", 0.0) or 0.0)
            if 0.0 < height < 6.0:
                promote.append(entry)
                moved += 1
                continue
        keep.append(entry)
    if moved:
        rendered.partitions["cut"] = keep
        rendered.partitions["section"] = []
        rendered.partitions["projection"] = rendered.partitions.get("projection", []) + promote
    return {"moved": moved}


def contract_from_render(rendered: RenderedView, view: ViewDefinition,
                         manager=None) -> Dict[str, Any]:
    """
    Shapes a `RenderedView` into the `cut_paths` / `projection_paths` contract.

    Partitions map onto the frontend's existing buckets. There is no analytic
    swing-arc pass under HLR: the serializer draws door arcs itself (`door-arcs`),
    and they arrive as projection geometry, which is more faithful than the old
    hand-drawn arcs.
    """
    styles = view.partition_styles()
    if manager is not None:
        apply_view_range(rendered, view, manager)
    # The serializer calls the cutting plane `section`; the frontend calls it `cut`.
    # Accept either so the contract does not depend on which name a build emits.
    cut_source = rendered.paths("section") or rendered.paths("cut")
    contract: Dict[str, Any] = {
        "cut_paths": [
            {"guid": p["guid"], "class": p["ifc_class"] or "cut", "d": p["d"],
             "fill": styles["cut"].colour}
            for p in cut_source
        ],
        "projection_paths": [
            {"guid": p["guid"], "class": p["ifc_class"] or "projection", "d": p["d"]}
            for p in rendered.paths("projection") + rendered.paths("below")
        ],
        # Empty on this build: the serializer removes occluded edges rather than
        # emitting them into a separate partition (see PARTITION_NAMES note).
        "hidden_paths": [
            {"guid": p["guid"], "class": p["ifc_class"] or "hidden", "d": p["d"]}
            for p in rendered.paths("hidden")
        ],
        "swing_paths": [],
        "slabs": [],
        "roofs": [],
        "grids": [],
        "dimensions": [],
        "partitions": {
            "cut": len(cut_source),
            "projection": len(rendered.paths("projection")),
            "hidden": len(rendered.paths("hidden")),
            "below": len(rendered.paths("below")),
        },
        "renderer": rendered.renderer,
        "view_id": rendered.view_id,
        "view_type": rendered.view_type,
        "cut_elevation": (view.view_range.cut if rendered.view_type == "floor_plan" else None),
        "lineweights": {
            name: {"weight_mm": st.weight_mm, "pattern": st.pattern, "colour": st.colour}
            for name, st in styles.items()
        },
    }
    return contract
