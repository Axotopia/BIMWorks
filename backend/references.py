"""
BIMWorks Geometric Reference Primitive (Normative: review/IMPLEMENTATION-PLAN-geometric-references.md)

A durable, comparable, repairable name for a piece of geometry (as opposed to a whole element).
Owns reference construction, comparison, normalisation, resolution, and repair.
"""

from typing import Dict, List, Tuple, Optional, Any, Union
import math
import copy


ReferenceKind = (
    # single-source, local to an element
    "wall_start",
    "wall_end",
    "wall_center",
    "wall_face_pos",
    "wall_face_neg",
    "host_offset",
    # datums
    "level_plane",
    "grid_axis",
    # free
    "point",
    # derived — multi-source
    "intersection",
    "extension",
)


def normalize_reference(raw: Any) -> Dict[str, Any]:
    """
    Normalizes any reference representation (legacy dict or canonical dict)
    into the canonical Reference schema:
    {
        "kind": ReferenceKind,
        "sources": [ {"element_guid": str, "ordinal": int}, ... ],
        "hint": { "point": [x, y, z], "normal": [x, y, z] | None }
    }
    Idempotent. Preserves backward-compatible top-level 'guid' and 'ref' keys.
    """
    if not isinstance(raw, dict):
        return {
            "kind": "point",
            "sources": [],
            "hint": {"point": [0.0, 0.0, 0.0], "normal": None},
        }

    # Already canonical if kind and sources are present
    if "kind" in raw and raw["kind"] in ReferenceKind and "sources" in raw:
        sources = []
        for s in raw.get("sources", []):
            if isinstance(s, dict) and "element_guid" in s:
                sources.append({
                    "element_guid": str(s["element_guid"]),
                    "ordinal": int(s.get("ordinal", 0)),
                })
            elif isinstance(s, str):
                sources.append({"element_guid": s, "ordinal": 0})

        hint_in = raw.get("hint") or {}
        pt = hint_in.get("point") or raw.get("point")
        norm = hint_in.get("normal") or raw.get("normal")
        hint = {
            "point": [float(c) for c in pt[:3]] if pt and len(pt) >= 2 else None,
            "normal": [float(c) for c in norm[:3]] if norm and len(norm) >= 2 else None,
        }

        res: Dict[str, Any] = {
            "kind": raw["kind"],
            "sources": sources,
            "hint": hint,
        }
        # Backward-compatibility shims
        if sources:
            res["guid"] = sources[0]["element_guid"]
        if raw.get("ref"):
            res["ref"] = raw["ref"]
        return res

    # Legacy migration path
    sources: List[Dict[str, Any]] = []
    level_id = raw.get("level_id")
    guid = raw.get("guid") or level_id
    ref_prop = raw.get("ref", "center")

    pt = raw.get("point")
    norm = raw.get("normal")
    hint = {
        "point": [float(c) for c in pt[:3]] if pt and len(pt) >= 2 else None,
        "normal": [float(c) for c in norm[:3]] if norm and len(norm) >= 2 else None,
    }

    if level_id:
        kind = "level_plane"
        sources.append({"element_guid": str(level_id), "ordinal": 0})
    elif guid:
        if ref_prop == "start":
            kind = "wall_start"
        elif ref_prop == "end":
            kind = "wall_end"
        elif ref_prop in ("center", "midpoint"):
            kind = "wall_center"
        elif ref_prop in ("face_pos", "wall_face_pos"):
            kind = "wall_face_pos"
        elif ref_prop in ("face_neg", "wall_face_neg"):
            kind = "wall_face_neg"
        elif ref_prop in ("offset", "host_offset"):
            kind = "host_offset"
        elif ref_prop in ReferenceKind:
            kind = ref_prop
        else:
            kind = "wall_center"

        ordinal = int(raw.get("ordinal", 0))
        sources.append({"element_guid": str(guid), "ordinal": ordinal})
    elif pt and len(pt) >= 2:
        kind = "point"
    else:
        kind = "point"

    res = {
        "kind": kind,
        "sources": sources,
        "hint": hint,
    }
    if sources:
        res["guid"] = sources[0]["element_guid"]
    if ref_prop:
        res["ref"] = ref_prop
    return res


def reference_key(ref: Dict[str, Any]) -> str:
    """
    Returns an order-stable, collision-resistant canonical string key.
    Multi-source references (e.g. intersection) are sorted by source identity so
    order of operands does not affect key.
    A multi-source intersection does not collide with single sources.
    """
    norm = normalize_reference(ref)
    kind = norm["kind"]
    sources = norm.get("sources", [])

    if kind == "point":
        pt = norm.get("hint", {}).get("point")
        if pt and len(pt) >= 2:
            return f"point:{pt[0]:.4f},{pt[1]:.4f}"
        return "point:unresolved"

    sorted_sources = sorted(sources, key=lambda s: (s["element_guid"], s.get("ordinal", 0)))
    src_str = ",".join(f"{s['element_guid']}#{s.get('ordinal', 0)}" for s in sorted_sources)
    return f"{kind}:{src_str}"


def _line_intersection_2d(
    p1: Tuple[float, float],
    p2: Tuple[float, float],
    p3: Tuple[float, float],
    p4: Tuple[float, float],
) -> Optional[Tuple[float, float]]:
    """Intersection of line segment (p1->p2) and line segment (p3->p4), or full infinite lines if collinear."""
    x1, y1 = p1
    x2, y2 = p2
    x3, y3 = p3
    x4, y4 = p4

    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-9:
        return None  # Parallel or collinear

    px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / denom
    py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / denom
    return (px, py)


def _project_point_to_line_2d(
    pt: Tuple[float, float],
    p1: Tuple[float, float],
    p2: Tuple[float, float],
) -> Tuple[float, float]:
    """Orthogonal projection of pt onto infinite line (p1->p2)."""
    dx = p2[0] - p1[0]
    dy = p2[1] - p1[1]
    L2 = dx * dx + dy * dy
    if L2 < 1e-9:
        return p1
    t = ((pt[0] - p1[0]) * dx + (pt[1] - p1[1]) * dy) / L2
    return (p1[0] + t * dx, p1[1] + t * dy)


def resolve_reference(
    manager: Any,
    ref: Dict[str, Any],
) -> Tuple[Optional[Tuple[float, float]], str]:
    """
    Resolves 2D coordinates (x, y) in decimal feet for a geometric reference.
    Returns: (coords, outcome) where outcome in {"exact", "repaired", "ambiguous", "lost"}.
    NEVER returns a silent (0.0, 0.0) on failure.
    """
    norm = normalize_reference(ref)
    kind = norm["kind"]
    sources = norm.get("sources", [])
    hint = norm.get("hint") or {}

    # 1. Free point
    if kind == "point":
        pt = hint.get("point")
        if pt and len(pt) >= 2:
            return ((float(pt[0]), float(pt[1])), "exact")
        return (None, "lost")

    # 2. Datum: Level plane
    if kind == "level_plane":
        if not sources:
            return (None, "lost")
        lid = sources[0]["element_guid"]
        if hasattr(manager, "levels") and manager.levels:
            if lid in manager.levels:
                elev = float(manager.levels[lid].get("elevation", 0.0))
                return ((0.0, elev), "exact")
            # Case-insensitive guid match
            for k, lv in manager.levels.items():
                if k.lower() == str(lid).lower():
                    return ((0.0, float(lv.get("elevation", 0.0))), "exact")
            # Fallback by display name: surfaced as 'repaired'
            for k, lv in manager.levels.items():
                if lv.get("name", "").lower() == str(lid).lower():
                    return ((0.0, float(lv.get("elevation", 0.0))), "repaired")
        return (None, "lost")

    # 3. Datum: Grid axis
    if kind == "grid_axis":
        if not sources:
            return (None, "lost")
        gid = sources[0]["element_guid"]
        meta = getattr(manager, "element_meta", {})
        gr = meta.get(gid)
        if not gr and hasattr(manager, "grids") and gid in manager.grids:
            gr = manager.grids[gid]
        if gr:
            sp = gr.get("start") or gr.get("p1")
            ep = gr.get("end") or gr.get("p2")
            if sp and ep:
                return (((float(sp[0]) + float(ep[0])) / 2.0, (float(sp[1]) + float(ep[1])) / 2.0), "exact")
        return (None, "lost")

    # 4. Derived: Intersection (multi-source)
    if kind == "intersection":
        if len(sources) < 2:
            return (None, "lost")
        g1 = sources[0]["element_guid"]
        g2 = sources[1]["element_guid"]
        meta = getattr(manager, "element_meta", {})
        if g1 not in meta or g2 not in meta:
            return (None, "lost")
        m1, m2 = meta[g1], meta[g2]
        if not (m1.get("start") and m1.get("end") and m2.get("start") and m2.get("end")):
            return (None, "lost")
        hit = _line_intersection_2d(
            (float(m1["start"][0]), float(m1["start"][1])),
            (float(m1["end"][0]), float(m1["end"][1])),
            (float(m2["start"][0]), float(m2["start"][1])),
            (float(m2["end"][0]), float(m2["end"][1])),
        )
        if hit is not None:
            return (hit, "exact")
        return (None, "lost")

    # 5. Derived: Extension
    if kind == "extension":
        if not sources:
            return (None, "lost")
        guid = sources[0]["element_guid"]
        meta = getattr(manager, "element_meta", {})
        if guid not in meta:
            return (None, "lost")
        m = meta[guid]
        if not (m.get("start") and m.get("end")):
            return (None, "lost")
        hint_pt = hint.get("point")
        if hint_pt and len(hint_pt) >= 2:
            proj = _project_point_to_line_2d(
                (float(hint_pt[0]), float(hint_pt[1])),
                (float(m["start"][0]), float(m["start"][1])),
                (float(m["end"][0]), float(m["end"][1])),
            )
            return (proj, "exact")
        return (None, "lost")

    # 6. Single-source element references
    if not sources:
        return (None, "lost")
    guid = sources[0]["element_guid"]
    meta = getattr(manager, "element_meta", {})
    if guid not in meta:
        return (None, "lost")
    m = meta[guid]

    if kind == "wall_start":
        if "start" in m and m["start"]:
            return ((float(m["start"][0]), float(m["start"][1])), "exact")
        return (None, "lost")

    if kind == "wall_end":
        if "end" in m and m["end"]:
            return ((float(m["end"][0]), float(m["end"][1])), "exact")
        return (None, "lost")

    if kind == "wall_center":
        if "start" in m and "end" in m and m["start"] and m["end"]:
            sp, ep = m["start"], m["end"]
            return (((float(sp[0]) + float(ep[0])) / 2.0, (float(sp[1]) + float(ep[1])) / 2.0), "exact")
        if "bbox" in m and "min" in m["bbox"] and "max" in m["bbox"]:
            b = m["bbox"]
            return (((float(b["min"][0]) + float(b["max"][0])) / 2.0, (float(b["min"][1]) + float(b["max"][1])) / 2.0), "exact")
        return (None, "lost")

    if kind in ("wall_face_pos", "wall_face_neg"):
        if "start" in m and "end" in m and m["start"] and m["end"]:
            sp, ep = m["start"], m["end"]
            dx = float(ep[0]) - float(sp[0])
            dy = float(ep[1]) - float(sp[1])
            L = math.hypot(dx, dy)
            if L > 1e-6:
                nx, ny = -dy / L, dx / L
                th = float(m.get("thickness", 0.5))
                sign = 1.0 if kind == "wall_face_pos" else -1.0
                mx, my = (float(sp[0]) + float(ep[0])) / 2.0, (float(sp[1]) + float(ep[1])) / 2.0
                return ((mx + sign * nx * (th / 2.0), my + sign * ny * (th / 2.0)), "exact")
        return (None, "lost")

    if kind == "host_offset":
        host_guid = m.get("host_wall_guid")
        offset = float(m.get("offset_along_wall", 0.0))
        if host_guid and host_guid in meta:
            hm = meta[host_guid]
            if "start" in hm and "end" in hm and hm["start"] and hm["end"]:
                sp, ep = hm["start"], hm["end"]
                dx, dy = float(ep[0]) - float(sp[0]), float(ep[1]) - float(sp[1])
                L = math.hypot(dx, dy)
                if L > 1e-6:
                    ux, uy = dx / L, dy / L
                    return ((float(sp[0]) + ux * offset, float(sp[1]) + uy * offset), "exact")
        return (None, "lost")

    return (None, "lost")


def resolve_reference_axis(
    manager: Any,
    ref: Dict[str, Any],
    axis: str,
) -> Tuple[Optional[float], str]:
    """
    Resolves a 1D scalar coordinate along the specified axis ('x', 'y', or 'z').
    Handles datum planes (e.g. level elevation on z-axis).
    Returns (coord, outcome).
    """
    norm = normalize_reference(ref)
    kind = norm["kind"]
    sources = norm.get("sources", [])

    if kind == "level_plane":
        if axis.lower() == "z":
            if not sources:
                return (None, "lost")
            lid = sources[0]["element_guid"]
            if hasattr(manager, "levels") and manager.levels:
                if lid in manager.levels:
                    return (float(manager.levels[lid].get("elevation", 0.0)), "exact")
                for k, lv in manager.levels.items():
                    if k.lower() == str(lid).lower():
                        return (float(lv.get("elevation", 0.0)), "exact")
                    if lv.get("name", "").lower() == str(lid).lower():
                        return (float(lv.get("elevation", 0.0)), "repaired")
            return (None, "lost")
        else:
            # A level plane spans all X and Y; resolving along X/Y is ambiguous
            return (None, "ambiguous")

    if kind == "grid_axis":
        if not sources:
            return (None, "lost")
        gid = sources[0]["element_guid"]
        meta = getattr(manager, "element_meta", {})
        gr = meta.get(gid)
        if not gr and hasattr(manager, "grids") and gid in manager.grids:
            gr = manager.grids[gid]
        if gr:
            sp = gr.get("start") or gr.get("p1")
            ep = gr.get("end") or gr.get("p2")
            if sp and ep:
                x1, y1 = float(sp[0]), float(sp[1])
                x2, y2 = float(ep[0]), float(ep[1])
                ax = axis.lower()
                if ax == "x" and abs(x1 - x2) < 1e-4:
                    return (x1, "exact")
                elif ax == "y" and abs(y1 - y2) < 1e-4:
                    return (y1, "exact")

    coords, outcome = resolve_reference(manager, norm)
    if coords is None:
        return (None, outcome)

    ax = axis.lower()
    if ax == "x":
        return (coords[0], outcome)
    elif ax == "y":
        return (coords[1], outcome)
    elif ax == "z":
        if sources:
            guid = sources[0]["element_guid"]
            meta = getattr(manager, "element_meta", {})
            if guid in meta:
                return (float(meta[guid].get("elevation", 0.0)), outcome)
        return (0.0, outcome)

    return (None, "lost")


def repair_reference(
    manager: Any,
    ref: Dict[str, Any],
) -> Tuple[Dict[str, Any], str]:
    """
    Attempts to repair an unresolved reference using hints or nearby geometry.
    Returns (updated_ref_dict, outcome) where outcome in {"exact", "repaired", "ambiguous", "lost"}.
    """
    norm = normalize_reference(ref)
    coords, outcome = resolve_reference(manager, norm)
    if outcome in ("exact", "repaired"):
        return (norm, outcome)

    hint = norm.get("hint") or {}
    hint_pt = hint.get("point")
    if not hint_pt or len(hint_pt) < 2:
        return (norm, "lost")

    hx, hy = float(hint_pt[0]), float(hint_pt[1])
    kind = norm["kind"]
    meta = getattr(manager, "element_meta", {})

    # Candidate search among elements matching kind within 1.0 ft tolerance
    matches: List[Tuple[str, float]] = []
    tol = 1.0
    for guid, m in meta.items():
        test_ref = {"kind": kind, "sources": [{"element_guid": guid, "ordinal": 0}]}
        pt, res = resolve_reference(manager, test_ref)
        if pt is not None:
            dist = math.hypot(pt[0] - hx, pt[1] - hy)
            if dist <= tol:
                matches.append((guid, dist))

    if len(matches) == 1:
        repaired_guid = matches[0][0]
        repaired = copy.deepcopy(norm)
        repaired["sources"] = [{"element_guid": repaired_guid, "ordinal": 0}]
        repaired["guid"] = repaired_guid
        return (repaired, "repaired")
    elif len(matches) > 1:
        return (norm, "ambiguous")

    return (norm, "lost")
