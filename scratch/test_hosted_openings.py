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
        f"   -> {label}: angle {ang_deg:5.1f} deg, "
        f"slide delta={actual_delta:+.6f} ft (projected), placement on-baseline [OK]"
    )


def wall_cut_axis(guid, axis):
    """
    Distinct values of one axis of the HOST WALL's own tessellation, in metres.

    A void cut into the wall shows up as interior values clustered on the opening's
    two jambs; a solid (or un-voided) box has only its two end values. That makes the
    question "is the hole where it should be?" answerable without guessing.

    `axis` must be the wall's OWN direction: a 20 ft wall along Y has a void that varies
    in Y and only its thickness in X, so checking X there would find the wall's faces and
    call them jambs.
    """
    import ifcopenshell.geom

    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    entity = bim_manager.element_meta[guid]["entity"]
    verts = list(ifcopenshell.geom.create_shape(settings, entity).geometry.verts)
    return sorted({round(v, 4) for v in verts[axis::3]})


def interior_of(values, tol=0.05):
    """The non-endpoint values: the hole's jambs."""
    if len(values) < 3:
        return []
    return [v for v in values if v > values[0] + tol and v < values[-1] - tol]


def test_host_move_carries_openings():
    """
    Moving/editing the HOST WALL must carry its openings and doors with it.

    This is the invariant that was missing. `translate_element` mutated the wall's
    baseline metadata and rebuilt the wall's own body, but nothing refreshed the wall's
    `ObjectPlacement`, and nothing re-derived its children -- and because a hosted
    product is a PLACED product, the opening stayed at its creation coordinates. The
    wall kept rendering correctly and stayed "cut" by `IfcRelVoidsElement`, but the void
    no longer coincided with the wall body: the hole floated in mid-air.

    Measured before the fix (a 20 ft wall, door at 5 ft, wall moved +30 ft):

        wall solid  9.144 .. 15.240 m      (moved, correct)
        opening     1.524 ..  2.438 m      (did NOT move)

    Every assertion here is on the assembled world transform, so it would also catch a
    regression in the parent/child frame handling or in the feet/metres boundary.
    """
    print("7. Moving the HOST WALL carries its openings and doors ...")
    for label, end in (("0 deg (X axis)", (20, 0)), ("90 deg (Y axis)", (0, 20))):
        bim_manager.reset_model()
        wall = bim_manager.add_wall((0, 0, 0), (end[0], end[1], 0), height=10.0,
                                    thickness=0.8333, name=f"HostMove ({label})")
        door = bim_manager.add_door(wall["guid"], offset_along_wall=5.0,
                                    width=3.0, height=7.0)
        opening = door["opening_entity"]
        door_entity = door["entity"]

        # Capture the child's position relative to the wall BEFORE the move, as a
        # distance along the wall. After the move it must be unchanged.
        wall_start = list(bim_manager.element_meta[wall["guid"]]["start"])
        axis = 0 if end[1] == 0 else 1
        before_rel = (float(placement_util.get_local_placement(opening.ObjectPlacement)[axis][3])
                      - feet_to_metres(wall_start[axis]))

        # Move the wall 30 ft along its own axis; the door keeps its 5 ft offset.
        dx = 30.0 if axis == 0 else 0.0
        dy = 0.0 if axis == 0 else 30.0
        assert bim_manager.translate_element(wall["guid"], dx, dy, 0.0, _propagate=False)

        new_start = list(bim_manager.element_meta[wall["guid"]]["start"])
        op_xy = world_xy(opening)
        door_xy = world_xy(door_entity)
        after_rel = op_xy[axis] - feet_to_metres(new_start[axis])

        assert abs(after_rel - before_rel) < 1e-6, (
            f"{label}: the opening's offset along the wall changed with the wall move: "
            f"{before_rel:.6f} m -> {after_rel:.6f} m (it must be invariant)"
        )

        wall_xy = world_xy(bim_manager.element_meta[wall["guid"]]["entity"])
        assert abs(op_xy[axis] - wall_xy[axis]) < 30.0 + 1.0, f"{label}: opening left the wall"
        assert abs(op_xy[axis] - door_xy[axis]) < 1e-9, (
            f"{label}: opening and door diverged: {op_xy} vs {door_xy}"
        )

        # And the void must still be cut into the wall body, at the opening's position.
        # Check along the wall's OWN direction, not always X.
        values = wall_cut_axis(wall["guid"], axis)
        jambs = interior_of(values)
        assert jambs, (
            f"{label}: the wall solid has no interior vertices along its axis, so the void "
            f"is no longer cutting it (values: {values})"
        )
        assert abs(jambs[0] - op_xy[axis]) < 0.05, (
            f"{label}: the void sits at {jambs} but the opening is at {op_xy[axis]}"
        )

        moved_ft = 30.0
        print(
            f"   -> {label}: wall moved {moved_ft:.0f} ft; opening held its "
            f"{after_rel / feet_to_metres(1.0):.3f} ft offset, void still cut at "
            f"{[round(j, 3) for j in jambs]} m [OK]"
        )

    # Deleting the door afterwards must heal the wall back to a solid box.
    bim_manager.delete_element(door["guid"])
    values = wall_cut_axis(wall["guid"], axis)
    assert not interior_of(values), (
        f"deleting the door left a void behind: wall values {values}"
    )
    print("   -> deleting the door healed the wall to a solid box [OK]")


def test_hosted_openings():
    print("1. Axis-aligned wall (0 deg) ...")
    check_case("0 deg", (0, 0, 0), (10, 0, 0), insert_offset=4.0, drag_dx=1.5, drag_dy=0.0)

    print("2. Vertical wall (90 deg) - the case the old code moved on raw world X ...")
    check_case("90 deg", (0, 0, 0), (0, 10, 0), insert_offset=3.0, drag_dx=1.5, drag_dy=0.0)

    print("3. Diagonal wall (45 deg) ...")
    check_case("45 deg", (0, 0, 0), (10, 10, 0), insert_offset=5.0, drag_dx=1.0, drag_dy=1.0)

    print("4. Diagonal wall (30 deg) with an off-axis drag ...")
    ang = math.radians(30)
    check_case(
        "30 deg",
        (2, 1, 0),
        (2 + 8 * math.cos(ang), 1 + 8 * math.sin(ang), 0),
        insert_offset=2.5,
        drag_dx=1.2,
        drag_dy=-0.4,
    )

    print("5. Negative-angle wall (-60 deg) ...")
    ang = math.radians(-60)
    check_case(
        "-60 deg",
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
        f"{math.degrees(host['angle']):.0f} deg baseline; host binding intact"
    )

    print("\nALL HOSTED-OPENING PLACEMENT/SLIDE TESTS PASSED")


def main():
    test_hosted_openings()
    test_host_move_carries_openings()
    print("\nALL HOSTED-OPENING TESTS PASSED")


if __name__ == "__main__":
    main()
