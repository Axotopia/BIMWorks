"""
BIMWorks - sketch data model (P4).

Spec principle 3: "sketch mode is a skin, not a gate". Footprints and profiles are
first-class overlay data, and *both* editing skins — the precision 2D sketch
editor and direct manipulation (dragging an edge or vertex) — emit the same
`SketchCurve*` commands against this model. Neither skin owns the geometry, so
they cannot diverge.

Before P4 the sketch lived only in the browser (`sketchSession` in the Zustand
store): closing the tab lost the work, and the backend could not rebuild a roof
from its own slope lines (review finding N13). This module is the authoritative
model, persisted in `parametric.json`.

Defines-Slope semantics
-----------------------
In Revit a roof footprint is a closed loop, and any *interior* line marked
"Defines Slope" is a ridge/hip up which the roof rises; the loop edges are the
eaves. A curve may also carry its own slope angle, otherwise the sketch default
applies. That is what turns a flat extrusion into a gable — so the geometry
builder here reads the slope lines rather than a single global pitch, which is
what the old `add_roof(pitch_degrees=...)` did.
"""

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

Point = Tuple[float, float]


def _dist(a: Point, b: Point) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def _point_segment_distance(p: Point, a: Point, b: Point) -> float:
    """Shortest distance from `p` to segment `a-b` (used for slope falloff)."""
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq < 1e-12:
        return _dist(p, a)
    t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / length_sq
    t = max(0.0, min(1.0, t))
    return _dist(p, (ax + t * dx, ay + t * dy))


@dataclass
class SketchCurve:
    """One 2D line segment in a sketch, with Revit's Defines-Slope flag."""

    id: str
    start: Point
    end: Point
    defines_slope: bool = False
    slope_angle: Optional[float] = None      # degrees; None -> sketch default
    overhang: float = 0.0
    picked_wall_guid: Optional[str] = None   # "Pick Walls" provenance

    def to_dict(self) -> Dict:
        out: Dict = {
            "id": self.id,
            "start": [float(self.start[0]), float(self.start[1])],
            "end": [float(self.end[0]), float(self.end[1])],
        }
        if self.defines_slope:
            out["defines_slope"] = True
        if self.slope_angle is not None:
            out["slope_angle"] = float(self.slope_angle)
        if self.overhang:
            out["overhang"] = float(self.overhang)
        if self.picked_wall_guid:
            out["picked_wall_guid"] = self.picked_wall_guid
        return out

    @classmethod
    def from_dict(cls, d: Dict) -> "SketchCurve":
        s = d.get("start", [0.0, 0.0])
        e = d.get("end", [0.0, 0.0])
        return cls(
            id=str(d.get("id")),
            start=(float(s[0]), float(s[1])),
            end=(float(e[0]), float(e[1])),
            defines_slope=bool(d.get("defines_slope", False)),
            slope_angle=(float(d["slope_angle"]) if d.get("slope_angle") is not None else None),
            overhang=float(d.get("overhang", 0.0) or 0.0),
            picked_wall_guid=d.get("picked_wall_guid"),
        )


@dataclass
class Sketch:
    """
    A sketch: a set of curves plus the parameters that turn it into a solid.

    `kind` is "roof", "floor" or "profile". Profiles use `profile_side` to say
    which vertical elevation a curve's offset applies at (Revit's wall-profile
    editing), so an awning is expressible as "push the top edge outwards".
    """

    kind: str = "floor"
    curves: List[SketchCurve] = field(default_factory=list)
    default_slope_angle: float = 15.0
    thickness: float = 0.0
    elevation: float = 0.0
    #: For `kind == "profile"`: {curve_id: "base"|"top"} vertical side, and the
    #: vertical extent the profile is swept over.
    profile_side: Dict[str, str] = field(default_factory=dict)
    profile_height: float = 0.0
    #: Tolerance for treating endpoints as coincident (feet). The UI snap radius
    #: is separate; this is the topology tolerance.
    tolerance: float = 1e-6

    # -- persistence --------------------------------------------------------
    def to_dict(self) -> Dict:
        d: Dict = {
            "kind": self.kind,
            "default_slope_angle": float(self.default_slope_angle),
            "curves": [c.to_dict() for c in self.curves],
        }
        if self.thickness:
            d["thickness"] = float(self.thickness)
        if self.elevation:
            d["elevation"] = float(self.elevation)
        if self.profile_side:
            d["profile_side"] = dict(self.profile_side)
        if self.profile_height:
            d["profile_height"] = float(self.profile_height)
        return d

    @classmethod
    def from_dict(cls, d: Dict) -> "Sketch":
        return cls(
            kind=str(d.get("kind", "floor")),
            curves=[SketchCurve.from_dict(c) for c in (d.get("curves") or [])],
            default_slope_angle=float(d.get("default_slope_angle", 15.0) or 15.0),
            thickness=float(d.get("thickness", 0.0) or 0.0),
            elevation=float(d.get("elevation", 0.0) or 0.0),
            profile_side=dict(d.get("profile_side") or {}),
            profile_height=float(d.get("profile_height", 0.0) or 0.0),
        )

    # -- mutation (the SketchCurve* command vocabulary) ----------------------
    def curve(self, curve_id: str) -> Optional[SketchCurve]:
        return next((c for c in self.curves if c.id == curve_id), None)

    def add_curve(self, curve: SketchCurve) -> SketchCurve:
        self.curves.append(curve)
        return curve

    def remove_curve(self, curve_id: str) -> bool:
        before = len(self.curves)
        self.curves = [c for c in self.curves if c.id != curve_id]
        self.profile_side.pop(curve_id, None)
        return len(self.curves) != before

    def move_vertex(self, curve_id: str, end_index: int, to: Point) -> bool:
        """
        Moves one endpoint of a curve. `end_index` 0 = start, 1 = end.

        Any other curve that shared the old position moves with it, which is what
        makes dragging a footprint corner behave like a connected loop rather than
        tearing the sketch apart.
        """
        c = self.curve(curve_id)
        if c is None:
            return False
        old = c.start if int(end_index) == 0 else c.end
        if int(end_index) == 0:
            c.start = (float(to[0]), float(to[1]))
        else:
            c.end = (float(to[0]), float(to[1]))
        for other in self.curves:
            if other is c:
                continue
            if _dist(other.start, old) <= self.tolerance:
                other.start = (float(to[0]), float(to[1]))
            if _dist(other.end, old) <= self.tolerance:
                other.end = (float(to[0]), float(to[1]))
        return True

    def move_curve(self, curve_id: str, dx: float, dy: float) -> bool:
        """
        Translates a whole curve — the "drag an edge" operation.

        Endpoints shared with neighbouring curves move too, so the loop follows,
        which is what makes edge-drag and vertex-drag the same model change.
        """
        c = self.curve(curve_id)
        if c is None:
            return False
        new_start = (c.start[0] + float(dx), c.start[1] + float(dy))
        new_end = (c.end[0] + float(dx), c.end[1] + float(dy))
        old_start, old_end = c.start, c.end
        c.start, c.end = new_start, new_end
        for other in self.curves:
            if other is c:
                continue
            if _dist(other.start, old_start) <= self.tolerance:
                other.start = new_start
            if _dist(other.end, old_start) <= self.tolerance:
                other.end = new_start
            if _dist(other.start, old_end) <= self.tolerance:
                other.start = new_end
            if _dist(other.end, old_end) <= self.tolerance:
                other.end = new_end
        return True

    def set_defines_slope(self, curve_id: str, defines: bool,
                          angle: Optional[float] = None) -> bool:
        c = self.curve(curve_id)
        if c is None:
            return False
        c.defines_slope = bool(defines)
        if angle is not None:
            c.slope_angle = float(angle)
        return True

    def set_default_slope(self, angle: float) -> None:
        self.default_slope_angle = float(angle)

    # -- topology -----------------------------------------------------------
    def closed_loops(self) -> List[List[Point]]:
        """
        Traces the sketch's closed loops and returns their vertex rings.

        Needed because a valid floor/roof footprint is a closed profile while
        slope lines are typically *interior* (not part of the boundary), so the
        geometry builder has to distinguish them. Uses endpoint connectivity with
        the sketch tolerance, mirroring the client's loop tracer so both skins
        agree on what the outline is.
        """
        unused = set(range(len(self.curves)))
        loops: List[List[Point]] = []

        def neighbours(point: Point, exclude: int) -> List[int]:
            return [
                i for i in unused
                if i != exclude
                and (_dist(self.curves[i].start, point) <= self.tolerance
                     or _dist(self.curves[i].end, point) <= self.tolerance)
            ]

        while unused:
            start_index = min(unused)
            ring: List[Point] = []
            current_index = start_index
            current_point = self.curves[current_index].start
            first_point = current_point
            guard = 0
            while True:
                guard += 1
                if guard > len(self.curves) + 2:
                    break
                unused.discard(current_index)
                ring.append(current_point)
                curve = self.curves[current_index]
                next_point = (
                    curve.end if _dist(curve.start, current_point) <= self.tolerance else curve.start
                )
                if _dist(next_point, first_point) <= self.tolerance and len(ring) >= 3:
                    break
                candidates = neighbours(next_point, current_index)
                if not candidates:
                    break
                current_index = candidates[0]
                current_point = next_point
            if len(ring) >= 3:
                loops.append(ring)
            unused.discard(start_index)
        return loops

    def footprint(self) -> List[Point]:
        """
        Largest closed loop, or (if the sketch is a single open chain) the ordered
        chain itself. Falls back to the curve endpoints so a partially drawn sketch
        still yields something usable rather than nothing.
        """
        loops = self.closed_loops()
        if loops:
            return max(loops, key=lambda r: abs(_signed_area(r)))
        pts: List[Point] = []
        for c in self.curves:
            if not pts or _dist(pts[-1], c.start) > self.tolerance:
                pts.append(c.start)
            pts.append(c.end)
        return pts

    def slope_curves(self) -> List[SketchCurve]:
        return [c for c in self.curves if c.defines_slope]

    def is_closed(self) -> bool:
        return bool(self.closed_loops())

    def validate(self) -> Optional[str]:
        """Returns a human-readable problem, or None when the sketch is usable."""
        if self.kind in ("floor", "roof", "profile") and len(self.curves) < 3:
            return "A boundary needs at least 3 connected lines."
        if not self.is_closed():
            return "Boundary must form a closed loop (check for gaps at the corners)."
        if self.kind == "roof":
            for c in self.slope_curves():
                angle = c.slope_angle if c.slope_angle is not None else self.default_slope_angle
                if angle <= 0 or angle >= 90:
                    return f"Slope angle {angle}° must be between 0 and 90."
        return None

    # -- geometry -----------------------------------------------------------
    def roof_heights(self) -> Dict[int, float]:
        """
        Elevation above the roof plate for each footprint vertex.

        Revit semantics: "Defines Slope" marks the line the roof rises *to* — a
        ridge or hip — and the footprint edges are the eaves. So the roof peaks on
        the slope line and falls away to zero at the eaves:

            height = rise * (1 - distance_to_slope_line / max_distance)

        That gives the classic gable for a single interior ridge (ridge at full
        rise, four eaves at zero) and a hip when the slope lines reach a corner.

        An earlier version had this inverted (peak at the eaves), which also
        collapsed every vertex of a rectangular footprint to one height because
        they are all equidistant from a centreline ridge.
        """
        footprint = self.footprint()
        slopes = self.slope_curves()
        if not footprint or not slopes:
            return {i: 0.0 for i in range(len(footprint))}

        def slope_angle(c: SketchCurve) -> float:
            return c.slope_angle if c.slope_angle is not None else self.default_slope_angle

        distances = [
            min(_point_segment_distance(p, c.start, c.end) for c in slopes)
            for p in footprint
        ]
        span = max(distances) if distances else 0.0
        if span <= 1e-9:
            # The whole footprint lies on the slope line: flat at full rise.
            rise = max(math_tan(slope_angle(c)) for c in slopes) * span
            return {i: rise for i in range(len(footprint))}

        rise = span * max(math_tan(slope_angle(c)) for c in slopes)
        return {i: (1.0 - d / span) * rise for i, d in enumerate(distances)}


def math_tan(degrees: float) -> float:
    """tan of an angle in degrees (kept local so this module stays dependency-free)."""
    import math

    return math.tan(math.radians(max(0.0, min(89.9, float(degrees)))))


def _segment_intersection(p1, d1, p2, d2):
    """Intersection of two infinite lines, or None when parallel."""
    det = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(det) < 1e-12:
        return None
    t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / det
    return (p1[0] + d1[0] * t, p1[1] + d1[1] * t)


def _clip_line_to_ring(a: Point, b: Point, ring: Sequence[Point]) -> List[Point]:
    """Points where segment a-b crosses the ring edges (for densifying a ridge)."""
    hits: List[Point] = []
    d = (b[0] - a[0], b[1] - a[1])
    for i in range(len(ring)):
        c, e = ring[i], ring[(i + 1) % len(ring)]
        de = (e[0] - c[0], e[1] - c[1])
        hit = _segment_intersection(a, d, c, de)
        if hit is None:
            continue
        # Inside both segments (with a small slack for ends on the boundary)?
        def within(p, s, t, tol=1e-9):
            lo_x, hi_x = sorted((s[0], t[0]))
            lo_y, hi_y = sorted((s[1], t[1]))
            return (lo_x - tol <= p[0] <= hi_x + tol) and (lo_y - tol <= p[1] <= hi_y + tol)
        if within(hit, a, b) and within(hit, c, e):
            hits.append((float(hit[0]), float(hit[1])))
    return hits


def build_roof_mesh(sketch: "Sketch", segments: int = 24) -> Tuple[List[float], List[int]]:
    """
    Builds a pitched roof mesh from a sketch: apexes at the top, eaves at the bottom.

    The subtlety is that a gable's peak lies along the slope line, which is usually
    *interior* to the footprint — so a mesh made only of footprint corners has no
    vertex at the peak and the roof comes out flat. The footprint is therefore
    densified, in a local frame aligned with the dominant slope line, into two
    halves (each a channel between the gradient profile and the boundary), and the
    ridge samples land exactly on the peak.

    Both editing skins call `set_roof_sketch`, so this builder sees identical
    sketches regardless of how they were drawn.
    """
    ring = list(sketch.footprint())
    if len(ring) < 3:
        return [], []
    slopes = sketch.slope_curves()
    if not slopes:
        return _extrude_flat(ring, sketch.thickness)

    eave_offset = float(sketch.elevation)
    angle = (slopes[0].slope_angle if slopes[0].slope_angle is not None
             else sketch.default_slope_angle)
    tan_a = math_tan(angle)

    # Local frame: +x along the slope line, +y perpendicular to it. Distance along
    # +y is the run, so elevation = y_distance * tan(angle) up to the peak.
    lx = (slopes[0].end[0] - slopes[0].start[0], slopes[0].end[1] - slopes[0].start[1])
    ln = (lx[0] ** 2 + lx[1] ** 2) ** 0.5
    if ln < 1e-9:
        return _extrude_flat(ring, sketch.thickness)
    ux, uy = lx[0] / ln, lx[1] / ln
    nx, ny = -uy, ux

    def to_local(p: Point) -> Point:
        return (p[0] * ux + p[1] * uy, p[0] * nx + p[1] * ny)

    local = [to_local(p) for p in ring]
    peak_local_y = 0.0 if False else None
    # The peak is the slope line itself: distance 0 in this frame, i.e. local y = c0.
    c0 = to_local(slopes[0].start)[1]

    ys = [p[1] for p in local]
    y_min, y_max = min(ys), max(ys)

    def height_at_local(p: Point) -> float:
        return max(0.0, (p[1] - c0) * tan_a) if p[1] >= c0 else max(0.0, (c0 - p[1]) * tan_a)

    def boundary_x_at(y: float) -> Optional[Tuple[float, float]]:
        """x-range where the horizontal line at local y crosses the boundary."""
        xs: List[float] = []
        for i in range(len(local)):
            a, b = local[i], local[(i + 1) % len(local)]
            if abs(b[1] - a[1]) < 1e-12:
                continue
            if min(a[1], b[1]) - 1e-12 <= y <= max(a[1], b[1]) + 1e-12:
                t = (y - a[1]) / (b[1] - a[1])
                xs.append(a[0] + t * (b[0] - a[0]))
        if len(xs) < 2:
            return None
        return (min(xs), max(xs))

    verts: List[float] = []
    faces: List[int] = []

    def emit(p_local: Point) -> int:
        idx = len(verts) // 3
        world_x = p_local[0] * ux + p_local[1] * nx
        world_y = p_local[0] * uy + p_local[1] * ny
        verts.extend([world_x, world_y, eave_offset + height_at_local(p_local)])
        return idx

    # Sweep from one local-y extreme to the other; the sample at c0 is the ridge.
    lo, hi = y_min, y_max
    n = max(2, int(segments))
    prev: Optional[Tuple[int, int]] = None
    c0_in_range = lo <= c0 <= hi
    ys_samples = [lo + (hi - lo) * i / n for i in range(n + 1)]
    if c0_in_range and all(abs(y - c0) > 1e-9 for y in ys_samples):
        ys_samples.append(c0)
        ys_samples.sort()

    for y in ys_samples:
        span = boundary_x_at(y)
        if span is None:
            continue
        a_idx = emit((span[0], y))
        b_idx = emit((span[1], y))
        if prev is not None:
            pa, pb = prev
            faces.extend([pa, pb, b_idx])
            faces.extend([pa, b_idx, a_idx])
        prev = (a_idx, b_idx)

    if not faces and len(verts) >= 9:
        return _extrude_flat(ring, sketch.thickness)
    return verts, faces


def _extrude_flat(ring: Sequence[Point], thickness: float) -> Tuple[List[float], List[int]]:
    """Triangulates a flat polygon into a closed prism of the given thickness."""
    pts = [(float(p[0]), float(p[1])) for p in ring]
    n = len(pts)
    verts: List[float] = []
    for p in pts:
        verts.extend([p[0], p[1], 0.0])
    for p in pts:
        verts.extend([p[0], p[1], -float(thickness)])
    faces: List[int] = []
    for i in range(1, n - 1):
        faces.extend([0, i + 1, i])
        faces.extend([n, n + i, n + i + 1])
    for i in range(n):
        nxt = (i + 1) % n
        faces.extend([i, n + i, n + nxt])
        faces.extend([i, n + nxt, nxt])
    return verts, faces


def _signed_area(ring: Sequence[Point]) -> float:
    total = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        total += x1 * y2 - x2 * y1
    return total / 2.0


def gable_roof_sketch(
    footprint: Sequence[Point],
    ridge: Optional[Tuple[Point, Point]] = None,
    slope_angle: float = 30.0,
    thickness: float = 0.5,
    elevation: float = 0.0,
) -> Sketch:
    """
    Builds a gable-roof sketch: the footprint loop plus one interior slope line.

    `ridge` defaults to a line through the footprint's centre running along its
    longer axis, which is the ridge a user would get by drawing it by eye. Both
    editing skins construct the sketch this way, so "built by drag" and "built by
    sketch mode" are literally the same data.
    """
    pts = [(float(p[0]), float(p[1])) for p in footprint]
    sketch = Sketch(kind="roof", thickness=thickness, elevation=elevation,
                    default_slope_angle=float(slope_angle))

    if ridge is None:
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        cx, cy = (min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0
        span_x, span_y = max(xs) - min(xs), max(ys) - min(ys)
        if span_x >= span_y:
            ridge = ((min(xs), cy), (max(xs), cy))   # ridge runs along X
        else:
            ridge = ((cx, min(ys)), (cx, max(ys)))   # ridge runs along Y

    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        sketch.add_curve(SketchCurve(id=f"eave{i + 1}", start=a, end=b))
    sketch.add_curve(
        SketchCurve(id="ridge", start=ridge[0], end=ridge[1],
                    defines_slope=True, slope_angle=float(slope_angle))
    )
    return sketch
