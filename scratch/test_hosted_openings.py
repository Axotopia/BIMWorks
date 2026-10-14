"""
Hosted opening placement & slide regression tests (P0-6).

The 2026-10-14 review found two linked defects in `ifc_service.py`:

  N6a  `translate_element` moved a door/window by adding the raw WORLD `dx` to
       `offset_along_wall` (a distance along the wall's own axis). On a wall at
       90° a world +X drag did nothing sensible; on a 45° wall it over/under-shot
       by the projection factor.
  N6b  Doors/windows/openings were placed with a bare `[offset, 0, 0]` world
       translation and no rotation, so on an angled wall the IFC geometry sat
       off the wall even though the metadata offset was right.

These checks assert the invariant that makes both testable without hardcoding
geometry: the hosted element's world placement must equal the host wall's
`start + u * offset_along_wall` (u = wall direction). No host IFC placement
hierarchy is used, so this is the actual world position.

Run:  ./.venv/bin/python scratch/test_hosted_openings.py
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

import ifcopenshell.util.placement as placement_util
from units import feet_to_metres
from ifc_service import bim_manager
from units import INCHES_0_625 as OPENING_FACE_NUDGE


def world_xy(entity):
    """World-space XY of an IFC element's placement origin."""
    matrix = placement_util.get_local_placement(entity.ObjectPlacement)
    return float(matrix[0][3]), float(matrix[1][3])


def expected_xy(host_meta, offset, local_y=0.0):
    """
    Host-relative placement: start + u*offset + n*local_y (u = wall direction).

    Computed in decimal feet (the model's unit) and then converted to metres, because
    `world_xy` reads the IFC placement and the IFC is metric. Comparing feet against
    metres is what made this check pass at 0.9144 m before the placement boundary was
    fixed.
    """
    ang = float(host_meta["angle"])
    sp = host_meta["start"]
    ux, uy = math.cos(ang), math.sin(ang)
    return (
        feet_to_metres(sp[0] + ux * offset - uy * local_y),
        feet_to_metres(sp[1] + uy * offset + ux * local_y),
    )


def assert_on_wall(label, host_meta, meta, xy, local_y=0.0, tol=1e-6):
    ex, ey = expected_xy(host_meta, meta["offset_along_wall"], local_y)
    dx, dy = xy[0] - ex, xy[1] - ey
    dist = math.hypot(dx, dy)
    assert dist < tol, (
        f"{label}: placement off the host-relative position by {dist:.6f} ft "
        f"(got {xy[0]:.6f},{xy[1]:.6f}; expected {ex:.6f},{ey:.6f})"
    )
    return dist


def check_case(label, start, end, insert_offset, drag_dx, drag_dy):
    """Insert a door and window on a wall, then drag and re-verify placement."""
    bim_manager.reset_model()
    wall = bim_manager.add_wall(start, end, height=10.0, thickness=0.8333, name=f"Host ({label})")
    door = bim_manager.add_door(wall["guid"], offset_along_wall=insert_offset, width=0.95, height=2.13)
    window = bim_manager.add_window(
        wall["guid"], offset_along_wall=insert_offset + 1.0, width=1.2, height=1.2, sill_height=0.9
    )

    ang_deg = math.degrees(wall["angle"])

    # --- insertion placement sits on the wall baseline ------------------------
    assert_on_wall(f"{label} door insert", wall, door, world_xy(door["entity"]))
    # The opening is nudged 5/8" onto the wall face (local_y), so the
    # expected position uses the same offset the builder applies.
    assert_on_wall(
        f"{label} opening insert", wall, door, world_xy(door["opening_entity"]), local_y=-OPENING_FACE_NUDGE
    )
    assert_on_wall(f"{label} window insert", wall, window, world_xy(window["entity"]))

    # --- slide: the offset must advance by the projection of the world delta --
    before = door["offset_along_wall"]
    expected_delta = drag_dx * math.cos(wall["angle"]) + drag_dy * math.sin(wall["angle"])
    ok = bim_manager.translate_element(door["guid"], drag_dx, drag_dy, 0.0)
    assert ok, f"{label}: translate_element returned False"
    actual_delta = door["offset_along_wall"] - before
    assert abs(actual_delta - expected_delta) < 1e-9, (
        f"{label}: slide advanced {actual_delta:.9f} ft but the wall-projected world "
        f"delta is {expected_delta:.9f} m (raw world dx was {drag_dx})"
    )

    # --- and the geometry actually moved with the metadata --------------------
    assert_on_wall(f"{label} door slide", wall, door, world_xy(door["entity"]))
    assert_on_wall(
        f"{label} opening slide", wall, door, world_xy(door["opening_entity"]), local_y=-OPENING_FACE_NUDGE
    )

    # --- a drag perpendicular to the wall must not slide the door at all ------
    perp_offset = door["offset_along_wall"]
    bim_manager.translate_element(door["guid"], -math.sin(wall["angle"]) * 1.5, math.cos(wall["angle"]) * 1.5, 0.0)
    assert abs(door["offset_along_wall"] - perp_offset) < 1e-9, (
        f"{label}: a perpendicular drag changed offset_along_wall by "
        f"{door['offset_along_wall'] - perp_offset:.9f} m"
    )
    assert_on_wall(f"{label} door perpendicular drag", wall, door, world_xy(door["entity"]))

    print(
        f"   -> {label}: angle {ang_deg:5.1f}°, "
        f"slide Δ{actual_delta:+.6f} ft (projected), placement on-baseline ✓"
    )


def test_hosted_openings():
    print("1. Axis-aligned wall (0°) ...")
    check_case("0°", (0, 0, 0), (10, 0, 0), insert_offset=4.0, drag_dx=1.5, drag_dy=0.0)

    print("2. Vertical wall (90°) — the case the old code moved on raw world X ...")
    check_case("90°", (0, 0, 0), (0, 10, 0), insert_offset=3.0, drag_dx=1.5, drag_dy=0.0)

    print("3. Diagonal wall (45°) ...")
    check_case("45°", (0, 0, 0), (10, 10, 0), insert_offset=5.0, drag_dx=1.0, drag_dy=1.0)

    print("4. Diagonal wall (30°) with an off-axis drag ...")
    ang = math.radians(30)
    check_case(
        "30°",
        (2, 1, 0),
        (2 + 8 * math.cos(ang), 1 + 8 * math.sin(ang), 0),
        insert_offset=2.5,
        drag_dx=1.2,
        drag_dy=-0.4,
    )

    print("5. Negative-angle wall (-60°) ...")
    ang = math.radians(-60)
    check_case(
        "-60°",
        (5, 5, 0),
        (5 + 6 * math.cos(ang), 5 + 6 * math.sin(ang), 0),
        insert_offset=1.5,
        drag_dx=0.8,
        drag_dy=0.8,
    )

    # --- 6. Slide must survive a project-container round-trip -----------------
    print("6. Slide + round-trip through a .bimworks container ...")
    bim_manager.reset_model()
    wall = bim_manager.add_wall((0, 0, 0), (6, 6, 0), height=10.0, thickness=0.8333, name="RoundTrip")
    door = bim_manager.add_door(wall["guid"], offset_along_wall=1.0, width=0.95, height=2.13)
    bim_manager.translate_element(door["guid"], 1.0, 1.0, 0.0)
    slid_offset = door["offset_along_wall"]

    path = bim_manager.save_orlt_project()
    assert path.endswith(".bimworks"), path
    with open(path, "rb") as f:
        payload = f.read()

    bim_manager.reset_model()
    res = bim_manager.load_orlt_project(payload, "RoundTrip.bimworks")
    assert res["status"] == "loaded"

    # The bbox-based importer reconstructs the host from tessellation, so a
    # diagonal wall comes back axis-aligned and the door's world placement is
    # NOT re-projected onto the new baseline. That pre-existing load-path defect
    # (review N1) is what the P2 overlay-as-truth rewrite removes; asserting the
    # placement invariant on imported geometry would either fail for the wrong
    # reason or have to hardcode the bbox heuristic. So this check verifies what
    # the slide fix is responsible for: the offset survives the round trip and
    # the door is still bound to a host wall.
    reloaded_door = next(
        m for m in bim_manager.element_meta.values() if m["ifc_class"] == "IfcDoor"
    )
    host = bim_manager.element_meta[reloaded_door["host_wall_guid"]]
    assert host is not None, "reloaded door lost its host wall binding"
    # The importer re-derives the offset from the fill's bbox centre, an
    # approximation, so allow a tolerance while still catching gross drift.
    assert abs(reloaded_door["offset_along_wall"] - slid_offset) < 0.75, (
        f"reloaded offset {reloaded_door['offset_along_wall']:.3f} ft is far from the "
        f"saved {slid_offset:.3f} m"
    )
    print(
        f"   -> offset {slid_offset:.3f} ft survived save/load as "
        f"{reloaded_door['offset_along_wall']:.3f} ft on the re-imported "
        f"{math.degrees(host['angle']):.0f}° baseline; host binding intact"
    )

    print("\nALL HOSTED-OPENING PLACEMENT/SLIDE TESTS PASSED")


if __name__ == "__main__":
    test_hosted_openings()
