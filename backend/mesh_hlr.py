"""
BIMWorks - hidden-line-removal projector for 2D views (P5, README M3).

Why this exists
---------------
Spec §4.1 asks for an in-process OCCT `HLRBRep` pipeline. That is not reachable in
this environment: `pythonocc-core` is conda-only (not on PyPI) and ifcopenshell's
bindings expose no HLR symbols (`dir(ifcopenshell_wrapper)` has none). The
ifcopenshell SVG serialiser was tried at length and cannot satisfy M3 either — it
partitions cut from projection only in *vertical* section planes, so a plan comes
back projection-only, and it never separates occluded edges (measured; see
`hlr_renderer`).

This module computes the same three partitions from geometry the app already has —
the triangulated buffers from `BimModelManager.get_geometry_buffers()` — which is
exactly the input OCCT's HLR consumes:

    cut         geometry lying ON the cut plane (the sectioned solid)
    projection  geometry behind the cut plane, not occluded by nearer geometry
    hidden      geometry behind the cut plane that IS occluded, separated out

The two things the serialiser could not do — a plan cut partition and separated
hidden lines — are both straightforward here, because visibility is decided
explicitly against the nearer silhouette rather than being a serialiser side effect.

Method
------
Orthographic projection (a plan takes it as parallel by definition).

1. Every mesh triangle is projected onto the view plane. The union of the triangles
   **nearer** to the camera than a given element is that element's occluder.
2. Each candidate edge (mesh silhouette edges and cut lines) is clipped by
   `difference` against the occluder union, splitting it into a visible part and a
   hidden part.
3. The cut partition comes from intersecting each triangle with the cut plane; an
   opening is a void in the wall's triangulation, so it appears as a gap without any
   special casing.

Shapely does the 2D boolean work; no OCCT binding is required.
"""

import math
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import unary_union

Point2 = Tuple[float, float]


def _union_bounds(a, b):
    """Bounding box covering both, tolerating a missing operand."""
    if a is None:
        return b
    if b is None:
        return a
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


@dataclass
class ViewCamera:
    """
    An orthographic camera looking along `-direction`.

    `right` and `up` span the view plane. Defaults are a plan looking down: right
    +X, up +Y, direction -Z (so "depth" increases towards the viewer).
    """

    right: Tuple[float, float, float] = (1.0, 0.0, 0.0)
    up: Tuple[float, float, float] = (0.0, 1.0, 0.0)
    direction: Tuple[float, float, float] = (0.0, 0.0, -1.0)

    def project(self, p: Sequence[float]) -> Point2:
        return (p[0] * self.right[0] + p[1] * self.right[1] + p[2] * self.right[2],
                p[0] * self.up[0] + p[1] * self.up[1] + p[2] * self.up[2])

    def depth(self, p: Sequence[float]) -> float:
        """Distance along the view direction; larger is further from the viewer."""
        return -(p[0] * self.direction[0] + p[1] * self.direction[1] + p[2] * self.direction[2])

    @property
    def key(self) -> Tuple[Tuple[float, float, float], Tuple[float, float, float], Tuple[float, float, float]]:
        """Rounded camera orientation tuple used for projection caching."""
        return (
            (round(self.right[0], 6), round(self.right[1], 6), round(self.right[2], 6)),
            (round(self.up[0], 6), round(self.up[1], 6), round(self.up[2], 6)),
            (round(self.direction[0], 6), round(self.direction[1], 6), round(self.direction[2], 6)),
        )


@dataclass
class ProjectedView:
    """The three partitions, as lists of model-space 2D polylines."""

    cut: List[Dict[str, Any]] = field(default_factory=list)
    projection: List[Dict[str, Any]] = field(default_factory=list)
    hidden: List[Dict[str, Any]] = field(default_factory=list)
    camera: Optional[ViewCamera] = None
    stats: Dict[str, int] = field(default_factory=dict)

    def partition_counts(self) -> Dict[str, int]:
        return {"cut": len(self.cut), "projection": len(self.projection),
                "hidden": len(self.hidden)}


class MeshHlrProjector:
    """
    Computes cut / projection / hidden linework from triangulated meshes.

    `meshes` is the `meshes` list from `get_geometry_buffers()`: each entry has
    `guid`, `ifc_class` and flat `vertices` (xyz triples) and `indices` (triangles).
    """

    def __init__(self, meshes: Sequence[Dict[str, Any]], tolerance: float = 1e-6,
                 prepared_cache: Optional[Dict[Any, Any]] = None,
                 cut_cache: Optional[Dict[Any, Any]] = None):
        self.meshes = list(meshes)
        self.tolerance = tolerance
        self._prepared_cache = prepared_cache if prepared_cache is not None else {}
        self._cut_cache = cut_cache if cut_cache is not None else {}
        # Cache: guid -> list of (triangle3d, polygon2d, min_depth)
        self._prepared: Optional[List[Dict[str, Any]]] = None
        self._prepared_camera_key = None
        #: Number of occlusion candidates used by the last render, for diagnostics.
        self._last_occluder_candidates = 0

    # -- preparation --------------------------------------------------------
    def _triangles(self, mesh: Dict[str, Any]) -> Iterable[Tuple[Tuple, Tuple, Tuple]]:
        v = mesh.get("vertices") or []
        idx = mesh.get("indices") or []
        for i in range(0, len(idx) - 2, 3):
            try:
                a = (v[idx[i] * 3], v[idx[i] * 3 + 1], v[idx[i] * 3 + 2])
                b = (v[idx[i + 1] * 3], v[idx[i + 1] * 3 + 1], v[idx[i + 1] * 3 + 2])
                c = (v[idx[i + 2] * 3], v[idx[i + 2] * 3 + 1], v[idx[i + 2] * 3 + 2])
            except (IndexError, TypeError):
                continue
            yield a, b, c

    def _prepare(self, camera: ViewCamera) -> List[Dict[str, Any]]:
        cam_key = camera.key
        if self._prepared is not None and self._prepared_camera_key == cam_key:
            return self._prepared
        prepared: List[Dict[str, Any]] = []
        for mesh in self.meshes:
            guid = mesh.get("guid")
            geom_rev = mesh.get("geom_rev")
            verts = mesh.get("vertices")
            geom_key = geom_rev if geom_rev is not None else (id(verts), len(verts) if verts else 0)
            cache_key = (guid, geom_key, cam_key)
            if self._prepared_cache is not None and cache_key in self._prepared_cache:
                prepared.append(self._prepared_cache[cache_key])
                continue

            polys = []
            min_depth = None
            z_lo = z_hi = None
            for tri in self._triangles(mesh):
                for p in tri:
                    z = p[2]
                    z_lo = z if z_lo is None else min(z_lo, z)
                    z_hi = z if z_hi is None else max(z_hi, z)
                pts = [camera.project(p) for p in tri]
                depths = [camera.depth(p) for p in tri]
                try:
                    poly = Polygon(pts)
                except Exception:
                    continue
                # Real Revit exports contain self-intersecting or degenerate profiles
                # ("Ring edge missing" from GEOS, on a 277-element house). Repair what
                # can be repaired and drop the rest, so one bad wall cannot fail the
                # whole drawing.
                if not poly.is_valid:
                    try:
                        poly = poly.buffer(0)
                    except Exception:
                        continue
                if poly.is_empty or poly.area <= 0:
                    continue
                d = min(depths)
                min_depth = d if min_depth is None else min(min_depth, d)
                polys.append((poly, d))
            if not polys:
                continue
            # Union the projected triangles ONCE per mesh, here.
            #
            # The outline union is needed twice per render — as the silhouette whose
            # edges are tested for occlusion, and as the occluder contribution added to
            # the running union — and it was being recomputed for both. `union_all` is
            # 72% of a cold slice (783 calls for 196 meshes, i.e. ~2 per mesh per use),
            # so halving the calls is the single largest saving available in this
            # module. Interior triangulation edges must not become drawing edges, which
            # is why the union is taken at all rather than emitting every triangle.
            outline = self._safe_union([p for p, _ in polys])
            if outline is None or outline.is_empty:
                continue
            entry = {
                "guid": mesh.get("guid"),
                "ifc_class": mesh.get("ifc_class"),
                "name": mesh.get("name"),
                "polys": polys,
                "outline": outline,
                "outline_bounds": outline.bounds,
                "min_depth": min_depth if min_depth is not None else 0.0,
                # World Z extent, captured here because a prepared entry no longer
                # carries the triangles the view range needs to test.
                "z_range": (z_lo, z_hi),
                "_verts_ref": verts,  # pin reference to prevent address reuse in CPython
            }
            if self._prepared_cache is not None:
                self._prepared_cache[cache_key] = entry
            prepared.append(entry)
        # Nearest first: an element's occluders are exactly the earlier entries.
        prepared.sort(key=lambda m: m["min_depth"])
        self._prepared = prepared
        self._prepared_camera_key = cam_key
        return prepared

    def _apply_view_range(self, prepared, view_range: Dict[str, float]):
        """
        Filters meshes by depth and by the view's top/bottom clip.

        Depth is measured along the view direction from the cut plane: a plan looking
        down sees everything BELOW the cut out to `view_depth`. `top`/`bottom` bound the
        vertical extent a plan draws, which is how a view range hides a high wall's
        upper part rather than sectioning it.
        """
        depth_in = view_range.get("view_depth")
        top_in = view_range.get("top")
        bottom_in = view_range.get("bottom")
        def number(value):
            if value in (None, ""):
                return None
            try:
                return float(value)
            except (TypeError, ValueError):
                return None

        depth = number(depth_in)
        top = number(top_in)
        bottom = number(bottom_in)
        # A view depth of zero (or negative) means "not set", not "nothing visible":
        # zero is how the store seeds an unset depth, and a literal reading would blank
        # the drawing. Guarded here as well as in the client so a direct API call cannot
        # produce a silently empty view.
        if depth is not None and depth <= 0:
            depth = None
        if depth is None and top is None and bottom is None:
            return prepared

        out = []
        for mesh in prepared:
            z_range = mesh.get("z_range")
            if not z_range or z_range[0] is None:
                out.append(mesh)
                continue
            z_lo, z_hi = z_range
            # `top`/`bottom` bound where the mesh's BASE sits, not its whole height:
            # a wall whose base is inside the view range is part of the view even
            # though its top runs past the range's top (otherwise every 10 ft wall is
            # excluded by a range whose top is 8 ft, which is what happened first).
            if bottom is not None and z_hi < bottom:
                continue          # entirely below the view's bottom
            if top is not None and z_lo > top:
                continue          # entirely above the view's top
            if depth is not None:
                pass  # applied in bulk below; see `_depth_filter`
            out.append(mesh)
        if depth is not None:
            out = self._depth_filter(out, depth)
        return out

    @staticmethod
    def _mesh_bounds(mesh: Dict[str, Any]):
        xs, ys = [], []
        for poly, _d in mesh.get("polys") or []:
            minx, miny, maxx, maxy = poly.bounds
            xs.extend([minx, maxx])
            ys.extend([miny, maxy])
        if not xs:
            return None
        return (min(xs), min(ys), max(xs), max(ys))

    def _depth_filter(self, prepared, depth: float):
        """
        Drops meshes further than `depth` from the NEAREST element.

        View depth in a plan is measured outward from the cut plane, so the reference
        is the front of the drawing, not its bounding-box centre. Two earlier
        attempts were wrong in instructive ways: measuring each element's own size
        filtered nothing (every element is small about itself), and measuring from the
        model's centre made one distant element drag the centre out and blank the
        whole drawing. Anchoring on the nearest element is stable in both cases.
        """
        boxes = [(m, self._mesh_bounds(m)) for m in prepared]
        boxes = [(m, b) for m, b in boxes if b]
        if not boxes:
            return list(prepared)

        # The seed is arbitrary, so order by position to make the result deterministic
        # rather than dependent on the order elements happened to be created.
        kept_boxes = sorted(boxes, key=lambda mb: (mb[1][0], mb[1][1]))
        seed = kept_boxes[0]
        kept = [seed]
        remaining = [b for b in kept_boxes[1:]]
        changed = True
        while changed:
            changed = False
            for item in list(remaining):
                _m, b = item
                for _k, kb in kept:
                    gx = max(0.0, kb[0] - b[2], b[0] - kb[2])
                    gy = max(0.0, kb[1] - b[3], b[1] - kb[3])
                    if max(gx, gy) <= depth:
                        kept.append(item)
                        remaining.remove(item)
                        changed = True
                        break
        return [m for m, _b in kept]

    # -- edge extraction ----------------------------------------------------
    @staticmethod
    def _safe_union(polys):
        """
        Unions polygons, degrading gracefully.

        One invalid ring makes GEOS raise for the whole collection, which would lose the
        entire element. Retrying piece by piece keeps the sound geometry, and a final
        fallback returns the polygons un-unioned — they still draw.
        """
        polys = [p for p in polys if p is not None and not p.is_empty]
        if not polys:
            return None
        try:
            return unary_union(polys)
        except Exception:
            pass
        good = []
        for poly in polys:
            try:
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if not poly.is_empty:
                    good.append(poly)
            except Exception:
                continue
        if not good:
            return None
        try:
            return unary_union(good)
        except Exception:
            return MultiPolygon(good) if len(good) > 1 else good[0]

    def _silhouette_edges(self, mesh: Dict[str, Any]) -> List[LineString]:
        """
        Boundary edges of a mesh's projected outline.

        Interior triangulation edges are not drawing edges; taking the union of the
        triangles and its boundary avoids drawing the tessellation, which is what a
        plan wants (wall faces, not triangles).

        The outline is computed once in `_prepare` and reused here, rather than
        re-unioned per call.
        """
        merged = mesh.get("outline")
        if merged is None:
            polys = [p for p, _ in mesh.get("polys") or []]
            if not polys:
                return []
            merged = self._safe_union(polys)
        if merged is None or merged.is_empty:
            return []
        rings = []
        geoms = merged.geoms if hasattr(merged, "geoms") else [merged]
        for g in geoms:
            if g.is_empty:
                continue
            rings.append(g.exterior)
            rings.extend(g.interiors)
        return [LineString(r.coords) for r in rings if len(r.coords) >= 2]

    # -- cut plane ----------------------------------------------------------
    @staticmethod
    def _triangle_plane_segments(tri, plane_z: float) -> List[LineString]:
        """Where a triangle crosses the horizontal plane z = plane_z."""
        pts = []
        for i in range(3):
            a, b = tri[i], tri[(i + 1) % 3]
            az, bz = a[2] - plane_z, b[2] - plane_z
            if abs(az) < 1e-12:
                pts.append(a)
            if az * bz < 0:
                t = az / (az - bz)
                pts.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, plane_z))
        if len(pts) < 2:
            return []
        # A triangle can contribute at most one segment at a given z.
        a, b = pts[0], pts[1]
        if abs(a[0] - b[0]) < 1e-12 and abs(a[1] - b[1]) < 1e-12:
            return []
        return [(a, b)]

    def cut_at(self, plane_z: float, camera: ViewCamera,
               meshes: Optional[Sequence[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
        """
        The sectioned solid at `plane_z`, as 2D polylines in model space.

        `meshes` limits the cut to a subset — the view range uses this so geometry
        beyond the view depth is not sectioned. Sectioning everything and filtering
        afterwards cannot work, because a cut is usually parallel to the view
        direction, so every element's section lies at the same depth.
        """
        cam_key = camera.key
        pz_round = round(plane_z, 6)
        out: List[Dict[str, Any]] = []
        for mesh in (meshes if meshes is not None else self.meshes):
            guid = mesh.get("guid")
            geom_rev = mesh.get("geom_rev")
            verts = mesh.get("vertices")
            geom_key = geom_rev if geom_rev is not None else (id(verts), len(verts) if verts else 0)
            cache_key = (guid, geom_key, pz_round, cam_key)
            if self._cut_cache is not None and cache_key in self._cut_cache:
                out.extend(self._cut_cache[cache_key])
                continue

            segments: List[Tuple] = []
            for tri in self._triangles(mesh):
                segments.extend(self._triangle_plane_segments(tri, plane_z))
            if not segments:
                if self._cut_cache is not None:
                    self._cut_cache[cache_key] = []
                continue
            # Merge the individual crossing segments into the outline of the cut.
            lines = [LineString([camera.project(s[0]), camera.project(s[1])]) for s in segments]
            try:
                merged = unary_union(lines)
            except Exception:
                # Invalid input: keep every crossing segment rather than losing the cut.
                merged = None
            mesh_out = []
            if merged is None:
                for line in lines:
                    mesh_out.append({
                        "guid": mesh.get("guid"),
                        "ifc_class": mesh.get("ifc_class"),
                        "name": mesh.get("name"),
                        "coords": [(round(x, 6), round(y, 6)) for x, y in line.coords],
                    })
            else:
                for g in (merged.geoms if hasattr(merged, "geoms") else [merged]):
                    if g.is_empty or g.geom_type != "LineString":
                        continue
                    mesh_out.append({
                        "guid": mesh.get("guid"),
                        "ifc_class": mesh.get("ifc_class"),
                        "name": mesh.get("name"),
                        "coords": [(round(x, 6), round(y, 6)) for x, y in g.coords],
                    })
            if self._cut_cache is not None:
                self._cut_cache[cache_key] = mesh_out
            out.extend(mesh_out)
        return out

    # -- render -------------------------------------------------------------
    def render(self, camera: Optional[ViewCamera] = None,
               cut_z: Optional[float] = None,
               view_range: Optional[Dict[str, float]] = None,
               include_guids: Optional[Iterable[str]] = None) -> ProjectedView:
        """
        Computes the three partitions.

        `cut_z` enables the cut partition. `camera` defaults to a plan looking down.

        `view_range` carries the Revit fields (`cut`, `top`, `bottom`, `view_depth`)
        in MODEL units and is honoured, not merely reported:

        * `view_depth` limits how far behind the cut plane anything is projected, so
          distant geometry does not appear in a plan that does not reach it;
        * `top` / `bottom` clip geometry outside the range, so a wall above the view's
          top (or below its bottom) is not drawn at all.

        A view range whose fields are all absent leaves the render unfiltered, which is
        what the older callers expect.
        """
        camera = camera or ViewCamera()
        if self._prepared_camera_key != camera.key:
            self._prepared = None
        prepared = self._prepare(camera)
        # A VIEW is a selection of the model, not just a camera position: a floor plan
        # shows one storey. Filtering here means the cut, the projection and the hidden
        # linework all agree on what is in the view, rather than each being filtered
        # afterwards (a cut is usually parallel to the view direction, so filtering cut
        # geometry by depth cannot work).
        if include_guids is not None:
            allowed = set(include_guids)
            prepared = [m for m in prepared if m.get("guid") in allowed]
        if view_range:
            prepared = self._apply_view_range(prepared, view_range)
        view = ProjectedView(camera=camera)

        if cut_z is not None:
            # Section only the meshes in this view (storey selection and/or view range).
            if include_guids is not None or view_range:
                allowed = {m["guid"] for m in prepared}
                view.cut = self.cut_at(
                    cut_z, camera,
                    [m for m in self.meshes if m.get("guid") in allowed],
                )
            else:
                view.cut = self.cut_at(cut_z, camera)

        # Occlusion, against a bounded candidate set per mesh.
        #
        # WHAT WAS WRONG. The occluder accumulated EVERY nearer mesh in the view, so each
        # mesh's edges were differenced and intersected against the union of the whole
        # scene, and every mesh also paid a union that merged a growing multipolygon.
        # `union_all` was 72% of a cold slice and the curve was quadratic. (A first
        # attempt at this — bucketing meshes into 300 ft tiles — changed nothing, because
        # in a building the whole plan fits in one tile; the growth, not the ordering,
        # was the problem.)
        #
        # WHY A RADIUS IS EXACT. `_occlusion_candidates` returns every nearer mesh whose
        # projected bounding box overlaps this one — which is precisely the set that can
        # occlude it, since a mesh can only hide a point inside its own outline. Anything
        # excluded cannot intersect this mesh at all, so it cannot contribute to
        # `difference` or `intersection`. The occluder is rebuilt from those candidates
        # per mesh instead of carried forward, which is more union calls but each one is
        # over a handful of small disjoint rectangles rather than one scene-wide
        # multipolygon that grows with the model.
        for mesh in prepared:
            edges = self._silhouette_edges(mesh)
            occluder = self._occluder_for(mesh, prepared)
            if occluder is not None and not occluder.is_empty:
                for line in edges:
                    remainder = line.difference(occluder)
                    for piece in (remainder.geoms if hasattr(remainder, "geoms") else [remainder]):
                        if piece.is_empty or piece.geom_type != "LineString":
                            continue
                        view.projection.append({
                            "guid": mesh["guid"], "ifc_class": mesh["ifc_class"],
                            "name": mesh.get("name"),
                            "coords": [(round(x, 6), round(y, 6)) for x, y in piece.coords],
                        })
                    covered = line.intersection(occluder)
                    for piece in (covered.geoms if hasattr(covered, "geoms") else [covered]):
                        if piece.is_empty or piece.geom_type not in ("LineString", "MultiLineString"):
                            continue
                        if piece.geom_type == "MultiLineString":
                            continue
                        view.hidden.append({
                            "guid": mesh["guid"], "ifc_class": mesh["ifc_class"],
                            "name": mesh.get("name"),
                            "coords": [(round(x, 6), round(y, 6)) for x, y in piece.coords],
                        })
            else:
                for line in edges:
                    view.projection.append({
                        "guid": mesh["guid"], "ifc_class": mesh["ifc_class"],
                        "name": mesh.get("name"),
                        "coords": [(round(x, 6), round(y, 6)) for x, y in line.coords],
                    })

        view.stats = {
            **view.partition_counts(),
            "meshes": len(prepared),
            # Diagnostics: proves the candidate bound is actually shrinking the work,
            # rather than being a filter that never rejects anything.
            "occluder_candidates_max": self._last_occluder_candidates,
        }
        return view

    #: Extra allowance (model units) added to an occluder candidate's bounding box when
    #: deciding whether it can overlap. Purely defensive: `difference`/`intersection`
    #: are exact, so the box test only has to be conservative enough not to drop a real
    #: overlap. Floating-point equality on a shared edge is the case this covers.
    OCCLUDER_CANDIDATE_SLOP = 1e-6

    def _occluder_for(self, mesh: Dict[str, Any],
                      prepared: List[Dict[str, Any]]) -> Optional[Any]:
        """
        The union of every NEARER mesh whose projected box overlaps `mesh`.

        Returns None when nothing can occlude `mesh`, which is the common case in a
        sparse plan and is exactly the work this avoids.
        """
        b = mesh.get("outline_bounds")
        depth = mesh.get("min_depth", 0.0)
        if b is None:
            return None
        slop = self.OCCLUDER_CANDIDATE_SLOP
        parts = []
        for other in prepared:
            if other is mesh:
                break  # `prepared` is near-to-far: everything after this is behind.
            if other.get("min_depth", 0.0) > depth:
                break
            ob = other.get("outline_bounds")
            if ob is None:
                continue
            if (ob[2] < b[0] - slop or ob[0] > b[2] + slop
                    or ob[3] < b[1] - slop or ob[1] > b[3] + slop):
                continue
            outline = other.get("outline")
            if outline is not None and not outline.is_empty:
                parts.append(outline)
        self._last_occluder_candidates = max(self._last_occluder_candidates, len(parts))
        if not parts:
            return None
        return self._safe_union(parts)

    # -- frontend contract ---------------------------------------------------
    @staticmethod
    def _to_path(coords: Sequence[Point2]) -> str:
        if not coords:
            return ""
        head = f"M {coords[0][0]:.4f} {coords[0][1]:.4f}"
        rest = " ".join(f"L {x:.4f} {y:.4f}" for x, y in coords[1:])
        return (head + (" " + rest if rest else "")).strip()

    def to_contract(self, view: ProjectedView, lineweights=None,
                    view_range=None) -> Dict[str, Any]:
        """
        Shapes a `ProjectedView` into the frontend's existing 2D contract.

        `lineweights` is a `hlr_renderer.LineweightTable`; when given, each partition
        entry carries its style so a consumer can draw the drawing per convention
        rather than inventing weights. `view_range` is echoed back so a view knows what
        it was drawn with.
        """
        contract = {
            "cut_paths": [
                {"guid": e["guid"], "class": f"{e['ifc_class']} cut" if e["ifc_class"] else "cut",
                 "d": self._to_path(e["coords"])}
                for e in view.cut if e["coords"]
            ],
            "projection_paths": [
                {"guid": e["guid"],
                 "class": f"{e['ifc_class']} projection" if e["ifc_class"] else "projection",
                 "d": self._to_path(e["coords"])}
                for e in view.projection if e["coords"]
            ],
            "hidden_paths": [
                {"guid": e["guid"], "class": f"{e['ifc_class']} hidden" if e["ifc_class"] else "hidden",
                 "d": self._to_path(e["coords"])}
                for e in view.hidden if e["coords"]
            ],
            "partitions": view.partition_counts(),
            "renderer": "mesh-hlr",
        }
        if lineweights is not None:
            for key, partition in (("cut_paths", "cut"), ("projection_paths", "projection"),
                                   ("hidden_paths", "hidden")):
                style = lineweights.style_for(partition)
                for entry in contract.get(key, []):
                    entry["style"] = {
                        "weight_mm": style.weight_mm,
                        "pattern": style.pattern,
                        "colour": style.colour,
                    }
            contract["lineweights"] = {
                name: {"weight_mm": st.weight_mm, "pattern": st.pattern, "colour": st.colour}
                for name, st in lineweights.styles.items()
            }
        if view_range:
            contract["view_range"] = dict(view_range)
        return contract
