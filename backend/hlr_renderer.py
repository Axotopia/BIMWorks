"""
BIMWorks - 2D view engine and hidden-line rendering (P5, README M3).

STATUS: EXPERIMENTAL / NOT WIRED IN AS THE DEFAULT.

What works and is verified
--------------------------
* ifcopenshell's SVG serializer does run OCCT hidden-line removal and does emit
  geometry partitioned into `section` (the cutting plane) and `projection`. The
  parser below reads those partitions, and the `cut` / `projection` split is
  correct.
* The view-range engine (`apply_view_range`) implements the drafting rule that a
  wall under 6 ft is never cut even when the cut plane passes through it. This is
  real and is exercised by the test suite.
* Element attribution recovers a GUID for cut geometry, which the serializer does
  not provide (only projection sub-views carry `ifc:guid`).

What does NOT work, and why this is not the default
---------------------------------------------------
The serializer does not expose a documented, reliable mapping from its drawing
frame back to model coordinates on this build:

* `serializer.addDrawing(...)` — the documented way to specify a drawing plane —
  is **absent** (the serializer exposes only setFile/write/finalize).
* With `auto-section` on a two-wall probe, the emitted `ifc:plane` maps world Y
  into the plane's local Z, i.e. the "plan" is produced as a *vertical section*.
  Measured on an L-shaped plan: the wall at model x=30 reads as x≈30.3 and the wall
  at x=0 as x≈-0.2, while all three walls share a single Y band of ~4.8..14.8
  (a height band), which is an elevation, not a plan.
* Inverting `matrix3` algebraically gives mirrored/offset results; calibrating the
  content box against the model's plan bounds only works when the serializer's
  plane actually is the world XY plane, which here it is not.

Because a CAD viewport needs geometry in model coordinates, `slice_2d_vector_plan`
defaults to the analytic renderer and this module is reached only via
`renderer="hlr"`. The M3 exit criteria are therefore **not** claimed as met.

The partitioning logic here is kept because it is correct and reusable: if the
serializer gains `addDrawing`, or a build is used whose storey plane is genuinely
horizontal, the calibration step is the only piece that needs revisiting.
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


def parse_hlr_svg(svg: str, raw: bool = False) -> Tuple[Dict[str, List[Dict[str, Any]]], Optional[List[List[float]]], Optional[str]]:
    """
    Parses the serializer's SVG into partitions of paths in model coordinates.

    Returns (partitions, matrix3, drawing_plane_name). Groups are walked in order
    so each path is attributed to the nearest enclosing group that carries a
    partition class; product groups (class="IfcWallStandardCase") are tracked so a
    path keeps the GUID of the element it belongs to.
    """
    # `section` is the serializer's name for the cutting plane; `cut` is Revit's
    # for the same thing, and the frontend consumes `cut`. It was missing from
    # this key set, so `cls in partitions` was False for every section group and
    # all cut geometry silently fell through to the projection bucket.
    # `hidden` is kept as a bucket because some serializers/builds emit it, but
    # this build does not: OCCT removes occluded edges during hidden-line
    # computation and everything surviving lands in `projection` (verified: no
    # configuration produced a `hidden` group). We therefore do not claim a
    # hidden-line partition we cannot actually deliver.
    PARTITION_NAMES = ("cut", "section", "projection", "hidden", "below")
    partitions: Dict[str, List[Dict[str, Any]]] = {name: [] for name in PARTITION_NAMES}
    matrix3: Optional[List[List[float]]] = None
    plane_name: Optional[str] = None

    # Track nesting: (depth, class, guid, matrix, plane)
    stack: List[Tuple[str, Optional[str], Optional[List[List[float]]]]] = []
    depth = 0
    pos = 0
    tokens = re.finditer(r"<g\b[^>]*>|</g>|<path\b[^>]*/?>", svg)

    for tok in tokens:
        text = tok.group(0)
        if text.startswith("</g"):
            if stack:
                stack.pop()
            depth = max(0, depth - 1)
            continue
        if text.startswith("<g"):
            attrs = dict(_ATTR_RE.findall(text))
            cls = attrs.get("class", "")
            m3 = _parse_matrix3(_attr(attrs, "data-matrix3", "ifc:matrix3") or "")
            if m3 is not None and matrix3 is None:
                matrix3 = m3
            if _attr(attrs, "data-plane", "ifc:plane"):
                plane_name = _attr(attrs, "data-name", "ifc:name")
            depth += 1
            stack.append((cls, _attr(attrs, "data-guid", "ifc:guid"), m3))
            continue

        # a path: attribute it to the nearest enclosing partition class
        attrs = dict(_ATTR_RE.findall(text))
        d = attrs.get("d")
        if not d:
            continue
        partition = None
        guid = None
        ifc_class = None
        local_matrix = None
        # The serializer nests `projection` inside `section` (and vice versa) for
        # the sub-views of one drawing plane. The OUTERMOST partition class is the
        # real one — the inner one only says which sub-view the path came from, and
        # taking the inner one put every cut line into the projection bucket.
        for cls, g, m3 in stack:
            if partition is None and cls in partitions:
                partition = cls
            elif ifc_class is None and cls.startswith("Ifc"):
                ifc_class = cls
                guid = g
            if m3 is not None and local_matrix is None:
                local_matrix = m3
        if partition is None:
            # Unpartitioned geometry (e.g. annotation the serializer already
            # resolved); treat it as projection rather than dropping it.
            partition = "projection"

        model_d = _clean_path(d) if raw else _d_to_model(d, local_matrix or matrix3)
        if model_d:
            partitions[partition].append(
                {"d": model_d, "guid": guid, "ifc_class": ifc_class}
            )

    return partitions, matrix3, plane_name


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
        partitions, matrix3, plane_name = parse_hlr_svg(svg, raw=True)
        if not view.include_hidden:
            partitions["hidden"] = []
        # Map the serializer's frame onto model coordinates by *calibration*, not
        # by inverting `matrix3` algebraically. The serializer's plane is centred on
        # the model's bounding box and its local axes do not map to world axes the
        # way the matrix suggests for every view type, so an algebraic inverse
        # silently produced mirrored/offset drawings. Matching the rendered content
        # box to the model's own plan bounds is robust to all of that.
        partitions = self._calibrate(partitions, view, raw=True)
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
        Rewrites paths from the serializer frame into model coordinates.

        Solved as an axis-aligned similarity transform (uniform scale, optional
        axis flip, translation) from the rendered content box to the model's plan
        bounds. `scale` is not trusted as a unit conversion because the serializer
        mixes model units and plane units.
        """
        if view.view_type != "floor_plan":
            return partitions
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
        # SVG Y runs opposite to model Y (verified against known geometry).
        def to_model(u: float, v: float) -> Tuple[float, float]:
            return (mx0 + (u - cx0) * sx, my1 - (v - cy0) * sy)

        for paths in partitions.values():
            for entry in paths:
                entry["d"] = _remap_path(entry["d"], to_model)
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
