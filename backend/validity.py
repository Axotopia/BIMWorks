"""
backend/validity.py — BIMWorks Validity Predicates & Clamping.

Implements architectural validity rules across element creation and interactive
direct manipulation:
1. Coordinates must be finite (no NaN, no Inf).
2. Wall thickness > 0 (minimum 1 inch / 0.0833 ft).
3. Wall height > 0.
4. Wall must be longer than the hosted openings it contains.
5. Opening must be strictly inside its host wall baseline (offset >= 0, offset + width <= wall_length).
6. Polygon footprints (slabs, roofs) must have non-zero signed area and >= 3 vertices.
7. Clamping and graceful degradation:
   - When a user drags a wall end past an opening, clamp to the minimum required length
     and explain why rather than failing the transaction.
   - When an invalid value is committed directly without clamping, refuse with an
     explanatory error message.
"""

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple


MIN_THICKNESS_FT = 1.0 / 12.0  # 1 inch
MIN_WALL_LENGTH_FT = 0.5        # 6 inches
MIN_POLYGON_AREA = 1e-4


def is_finite_coord(val: Any) -> bool:
    """Returns True if the value is a real, finite number."""
    try:
        f = float(val)
        return math.isfinite(f)
    except (TypeError, ValueError):
        return False


def validate_finite_point(point: Sequence[Any], name: str = "Point") -> None:
    """Raises ValueError if any coordinate in the point is non-finite."""
    if not point or not all(is_finite_coord(c) for c in point):
        raise ValueError(f"{name} coordinates must be finite, got {point}")


def polygon_signed_area(points: Sequence[Sequence[float]]) -> float:
    """Computes the signed 2D area of a polygon using the Shoelace formula."""
    if len(points) < 3:
        return 0.0
    area = 0.0
    n = len(points)
    for i in range(n):
        x1, y1 = points[i][0], points[i][1]
        x2, y2 = points[(i + 1) % n][0], points[(i + 1) % n][1]
        area += (x1 * y2 - x2 * y1)
    return 0.5 * area


def validate_polygon_footprint(polygon: Sequence[Sequence[float]], name: str = "Footprint") -> None:
    """Validates that a polygon has at least 3 vertices, all finite, and non-zero area."""
    if not polygon or len(polygon) < 3:
        raise ValueError(f"{name} must contain at least 3 vertices (got {len(polygon) if polygon else 0})")
    for idx, pt in enumerate(polygon):
        validate_finite_point(pt, f"{name} vertex {idx}")
    area = abs(polygon_signed_area(polygon))
    if area < MIN_POLYGON_AREA:
        raise ValueError(f"{name} area must be positive (> 0), got {area:.6f} sq ft")


def validate_thickness(thickness: float, min_thickness: float = MIN_THICKNESS_FT) -> None:
    """Validates that element thickness is positive and above the minimum threshold."""
    if not is_finite_coord(thickness) or float(thickness) <= 0:
        raise ValueError(f"Thickness must be positive (> 0), got {thickness}")
    if float(thickness) < min_thickness - 1e-6:
        raise ValueError(
            f"Thickness {thickness:.4f} ft is below minimum allowable thickness {min_thickness:.4f} ft (1 inch)"
        )


def validate_wall_height(height: float) -> None:
    """Validates that wall height is positive and finite."""
    if not is_finite_coord(height) or float(height) <= 0:
        raise ValueError(f"Wall height must be positive (> 0), got {height}")


def get_wall_min_length_for_openings(manager: Any, wall_guid: str) -> Tuple[float, Optional[str]]:
    """
    Computes the minimum length required for a wall to comfortably host all its
    currently assigned openings (doors, windows).
    Returns (min_length, explanation).
    """
    wall_meta = getattr(manager, "element_meta", {}).get(wall_guid)
    if not wall_meta:
        return MIN_WALL_LENGTH_FT, None

    openings = wall_meta.get("hosted_openings", [])
    if not openings:
        return MIN_WALL_LENGTH_FT, None

    max_extent = 0.0
    for og in openings:
        ometa = manager.element_meta.get(og)
        if not ometa:
            continue
        offset = float(ometa.get("offset_along_wall", 0.0))
        width = float(ometa.get("width", 3.0))
        extent = offset + width
        if extent > max_extent:
            max_extent = extent

    if max_extent <= 0.0:
        return MIN_WALL_LENGTH_FT, None

    # Wall must extend at least to the end of the furthest opening
    min_length = max(max_extent, MIN_WALL_LENGTH_FT)
    explanation = f"Wall length cannot be shorter than hosted openings (minimum {min_length:.2f} ft)"
    return min_length, explanation


def validate_wall_length_for_openings(manager: Any, wall_guid: str, proposed_length: float) -> None:
    """
    Validates that a proposed wall length is sufficient to host all openings.
    Raises ValueError if proposed length cuts through or excludes any opening.
    """
    if proposed_length <= 0:
        raise ValueError(f"Wall length must be positive (> 0), got {proposed_length}")

    min_len, expl = get_wall_min_length_for_openings(manager, wall_guid)
    if proposed_length < min_len - 0.001:
        raise ValueError(
            f"Wall length {proposed_length:.2f} ft is too short for hosted openings (requires at least {min_len:.2f} ft)"
        )


def clamp_wall_end(
    manager: Any,
    wall_guid: str,
    end: str,
    target_point: Sequence[float],
) -> Tuple[List[float], Optional[str]]:
    """
    Gracefully clamps a wall endpoint drag so that the wall never shrinks past
    its hosted openings.
    Returns (clamped_point, explanation_if_clamped).
    """
    validate_finite_point(target_point, f"Target wall {end}")
    wall_meta = getattr(manager, "element_meta", {}).get(wall_guid)
    if not wall_meta:
        return [float(target_point[0]), float(target_point[1])], None

    sp = wall_meta.get("start", [0.0, 0.0, 0.0])
    ep = wall_meta.get("end", [0.0, 0.0, 0.0])
    fixed_pt = sp if end == "end" else ep

    tx = float(target_point[0])
    ty = float(target_point[1])
    dx = tx - fixed_pt[0] if end == "end" else fixed_pt[0] - tx
    dy = ty - fixed_pt[1] if end == "end" else fixed_pt[1] - ty
    dist = math.hypot(dx, dy)

    min_len, expl = get_wall_min_length_for_openings(manager, wall_guid)

    if dist < min_len:
        # Clamp along direction vector to fixed point
        if dist > 1e-6:
            factor = min_len / dist
            if end == "end":
                clamped_x = fixed_pt[0] + dx * factor
                clamped_y = fixed_pt[1] + dy * factor
            else:
                clamped_x = fixed_pt[0] - dx * factor
                clamped_y = fixed_pt[1] - dy * factor
        else:
            # Fallback to current baseline direction
            curr_dx = ep[0] - sp[0]
            curr_dy = ep[1] - sp[1]
            curr_len = math.hypot(curr_dx, curr_dy)
            ux = curr_dx / curr_len if curr_len > 1e-6 else 1.0
            uy = curr_dy / curr_len if curr_len > 1e-6 else 0.0
            if end == "end":
                clamped_x = fixed_pt[0] + ux * min_len
                clamped_y = fixed_pt[1] + uy * min_len
            else:
                clamped_x = fixed_pt[0] - ux * min_len
                clamped_y = fixed_pt[1] - uy * min_len

        return [clamped_x, clamped_y], expl

    return [tx, ty], None


def validate_opening_placement(
    manager: Any,
    host_wall_guid: str,
    offset: float,
    width: float,
) -> None:
    """
    Validates that a door or window fits strictly inside its host wall baseline.
    Raises ValueError if the opening is placed out of bounds.
    """
    if not is_finite_coord(offset) or offset < 0:
        raise ValueError(f"Opening offset cannot be negative, got {offset}")
    if not is_finite_coord(width) or width <= 0:
        raise ValueError(f"Opening width must be positive, got {width}")

    wall_meta = getattr(manager, "element_meta", {}).get(host_wall_guid)
    if not wall_meta:
        return

    wall_len = float(wall_meta.get("length", 0.0))
    if wall_len > 0 and (offset + width > wall_len + 0.001):
        raise ValueError(
            f"Opening extent ({offset:.2f} + {width:.2f} = {offset + width:.2f} ft) exceeds host wall length ({wall_len:.2f} ft)"
        )


def clamp_opening_offset(
    manager: Any,
    host_wall_guid: str,
    proposed_offset: float,
    opening_width: float,
) -> Tuple[float, Optional[str]]:
    """
    Clamps proposed offset along wall baseline to keep opening inside the host wall.
    """
    wall_meta = getattr(manager, "element_meta", {}).get(host_wall_guid)
    if not wall_meta:
        return max(0.0, proposed_offset), None

    wall_len = float(wall_meta.get("length", 0.0))
    if wall_len <= 0:
        return max(0.0, proposed_offset), None

    max_offset = max(0.0, wall_len - opening_width)
    if proposed_offset < 0.0:
        return 0.0, "Opening offset clamped to wall start (0'-0\")"
    if proposed_offset > max_offset:
        return max_offset, f"Opening offset clamped to fit within wall length ({wall_len:.2f} ft)"

    return proposed_offset, None
