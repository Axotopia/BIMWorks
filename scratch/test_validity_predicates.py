"""
scratch/test_validity_predicates.py — Phase 8 Gate: Validity Predicates & Clamping.

Validates:
1. Coordinate finiteness: NaN and Inf coordinates rejected.
2. Thickness validity: <= 0 and < 1 inch rejected.
3. Wall height validity: <= 0 rejected.
4. Polygon footprint validity: < 3 vertices and zero/negative area rejected.
5. Sketch boundary closure: open chains rejected by validate().
6. Opening placement: offsets out of wall bounds rejected by validate_opening_placement.
7. Opening offset clamping: clamped to [0, wall_length - width] with explanation.
8. Wall end clamping (Gate B8): dragging wall end past hosted opening clamps to safe minimum length and explains why.
9. Refusal without clamp: committing wall end past opening without clamp fails with ValueError/RuntimeError.
10. Bus transactions & Mementos: clamped WallSetEnd and OpeningSetOffset undo/redo cleanly.
"""

import sys
import os
import math
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from validity import (
    is_finite_coord,
    validate_finite_point,
    polygon_signed_area,
    validate_polygon_footprint,
    validate_thickness,
    validate_wall_height,
    get_wall_min_length_for_openings,
    validate_wall_length_for_openings,
    clamp_wall_end,
    validate_opening_placement,
    clamp_opening_offset,
    MIN_THICKNESS_FT,
)
from sketch_model import Sketch, SketchCurve, Point
from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest


def run_validity_predicates_gate():
    print("\n=== RUNNING VALIDITY PREDICATES & CLAMPING GATE (PHASE 8) ===")
    passed = 0
    failed = 0

    def check(name: str, cond: bool):
        nonlocal passed, failed
        if cond:
            print(f"  [PASS] {name}")
            passed += 1
        else:
            print(f"  [FAIL] {name}")
            failed += 1

    # -------------------------------------------------------------------------
    # 1. Coordinate Finiteness
    # -------------------------------------------------------------------------
    check("is_finite_coord: 0.0 is finite", is_finite_coord(0.0))
    check("is_finite_coord: -123.45 is finite", is_finite_coord(-123.45))
    check("is_finite_coord: NaN is not finite", not is_finite_coord(float('nan')))
    check("is_finite_coord: Inf is not finite", not is_finite_coord(float('inf')))
    check("is_finite_coord: -Inf is not finite", not is_finite_coord(float('-inf')))
    check("is_finite_coord: None is not finite", not is_finite_coord(None))

    try:
        validate_finite_point([1.0, 2.0, 3.0])
        check("validate_finite_point: valid 3D point accepted", True)
    except Exception:
        check("validate_finite_point: valid 3D point accepted", False)

    try:
        validate_finite_point([1.0, float('nan'), 3.0])
        check("validate_finite_point: NaN point rejected", False)
    except ValueError as e:
        check("validate_finite_point: NaN point rejected", "finite" in str(e))

    try:
        validate_finite_point([1.0, float('inf')])
        check("validate_finite_point: Inf point rejected", False)
    except ValueError as e:
        check("validate_finite_point: Inf point rejected", "finite" in str(e))

    # -------------------------------------------------------------------------
    # 2. Thickness & Wall Height
    # -------------------------------------------------------------------------
    try:
        validate_thickness(0.5)
        check("validate_thickness: 0.5 ft accepted", True)
    except Exception:
        check("validate_thickness: 0.5 ft accepted", False)

    try:
        validate_thickness(0.0)
        check("validate_thickness: 0.0 ft rejected", False)
    except ValueError as e:
        check("validate_thickness: 0.0 ft rejected", "positive" in str(e))

    try:
        validate_thickness(-0.2)
        check("validate_thickness: negative thickness rejected", False)
    except ValueError as e:
        check("validate_thickness: negative thickness rejected", "positive" in str(e))

    try:
        validate_thickness(0.04)  # ~0.5 inch, below 1 inch min
        check("validate_thickness: sub-1-inch thickness rejected", False)
    except ValueError as e:
        check("validate_thickness: sub-1-inch thickness rejected", "minimum allowable" in str(e))

    try:
        validate_wall_height(10.0)
        check("validate_wall_height: 10 ft accepted", True)
    except Exception:
        check("validate_wall_height: 10 ft accepted", False)

    try:
        validate_wall_height(0.0)
        check("validate_wall_height: 0 ft rejected", False)
    except ValueError as e:
        check("validate_wall_height: 0 ft rejected", "positive" in str(e))

    try:
        validate_wall_height(-5.0)
        check("validate_wall_height: negative height rejected", False)
    except ValueError as e:
        check("validate_wall_height: negative height rejected", "positive" in str(e))

    # -------------------------------------------------------------------------
    # 3. Polygon Footprint & Area
    # -------------------------------------------------------------------------
    sq_poly = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]
    area = polygon_signed_area(sq_poly)
    check("polygon_signed_area: 10x10 square area == 100", abs(area - 100.0) < 1e-4)

    try:
        validate_polygon_footprint(sq_poly)
        check("validate_polygon_footprint: 10x10 square accepted", True)
    except Exception:
        check("validate_polygon_footprint: 10x10 square accepted", False)

    # Degenerate polygon: 2 points
    try:
        validate_polygon_footprint([[0.0, 0.0], [10.0, 0.0]])
        check("validate_polygon_footprint: 2 vertices rejected", False)
    except ValueError as e:
        check("validate_polygon_footprint: 2 vertices rejected", "at least 3 vertices" in str(e))

    # Collinear polygon (zero area)
    collinear = [[0.0, 0.0], [5.0, 0.0], [10.0, 0.0]]
    try:
        validate_polygon_footprint(collinear)
        check("validate_polygon_footprint: zero area polygon rejected", False)
    except ValueError as e:
        check("validate_polygon_footprint: zero area polygon rejected", "positive" in str(e))

    # -------------------------------------------------------------------------
    # 4. Sketch Model Closed Loops & Boundary Validation
    # -------------------------------------------------------------------------
    # Open chain of 3 segments (not returning to start)
    open_sketch = Sketch(
        kind="floor",
        curves=[
            SketchCurve(id="c1", start=(0.0, 0.0), end=(10.0, 0.0)),
            SketchCurve(id="c2", start=(10.0, 0.0), end=(10.0, 10.0)),
            SketchCurve(id="c3", start=(10.0, 10.0), end=(0.0, 10.0)),
        ]
    )
    check("Sketch.is_closed: open 3-curve chain is not closed", not open_sketch.is_closed())
    validation_err = open_sketch.validate()
    check("Sketch.validate: open 3-curve chain rejected", validation_err is not None and "closed loop" in validation_err)

    # Closed 4-curve rectangle
    closed_sketch = Sketch(
        kind="floor",
        curves=[
            SketchCurve(id="r1", start=(0.0, 0.0), end=(10.0, 0.0)),
            SketchCurve(id="r2", start=(10.0, 0.0), end=(10.0, 10.0)),
            SketchCurve(id="r3", start=(10.0, 10.0), end=(0.0, 10.0)),
            SketchCurve(id="r4", start=(0.0, 10.0), end=(0.0, 0.0)),
        ]
    )
    check("Sketch.is_closed: closed rectangle is closed", closed_sketch.is_closed())
    check("Sketch.validate: closed rectangle has no errors", closed_sketch.validate() is None)

    # -------------------------------------------------------------------------
    # 5. Model Setup for Architectural Clamping & Refusal
    # -------------------------------------------------------------------------
    mgr = BimModelManager()
    bus = CommandBusEngine(mgr)

    # Create a 20ft wall: (0,0) -> (20,0)
    res_wall = bus.execute_transaction(
        [
            CommandRequest(
                command="WallCreate",
                params={
                    "start": [0.0, 0.0, 0.0],
                    "end": [20.0, 0.0, 0.0],
                    "height": 10.0,
                    "thickness": 0.67,
                },
            )
        ],
        "Create 20ft wall"
    )
    wall_guid = res_wall["results"][0]["result"]["guid"]

    # Insert a 3ft wide door at offset 12ft (occupies 12.0 to 15.0 ft)
    res_door = bus.execute_transaction(
        [
            CommandRequest(
                command="DoorInsert",
                params={
                    "host_wall_guid": wall_guid,
                    "offset_along_wall": 12.0,
                    "width": 3.0,
                    "height": 7.0,
                },
            )
        ],
        "Insert door at offset 12"
    )
    door_guid = res_door["results"][0]["result"]["guid"]

    # Wall hosted opening minimum length
    min_len, expl = get_wall_min_length_for_openings(mgr, wall_guid)
    check("get_wall_min_length_for_openings: min length is 15.0 ft", abs(min_len - 15.0) < 0.01)
    check("get_wall_min_length_for_openings: explanation provided", expl is not None and "15.00" in expl)

    # -------------------------------------------------------------------------
    # 6. Opening Placement Validity & Clamping
    # -------------------------------------------------------------------------
    # Valid placement: offset 5.0, width 3.0 on 20ft wall
    try:
        validate_opening_placement(mgr, wall_guid, 5.0, 3.0)
        check("validate_opening_placement: offset 5 on 20ft wall accepted", True)
    except Exception:
        check("validate_opening_placement: offset 5 on 20ft wall accepted", False)

    # Invalid placement: offset 18.0, width 3.0 (extends to 21.0 on 20ft wall)
    try:
        validate_opening_placement(mgr, wall_guid, 18.0, 3.0)
        check("validate_opening_placement: offset 18 on 20ft wall rejected", False)
    except ValueError as e:
        check("validate_opening_placement: offset 18 on 20ft wall rejected", "exceeds host wall length" in str(e))

    # Clamping opening offset
    clamped_off, c_expl = clamp_opening_offset(mgr, wall_guid, 19.0, 3.0)
    check("clamp_opening_offset: clamps 19.0 to 17.0 (20 - 3)", abs(clamped_off - 17.0) < 0.01)
    check("clamp_opening_offset: explains why clamped", c_expl is not None and "clamped" in c_expl)

    clamped_neg, n_expl = clamp_opening_offset(mgr, wall_guid, -5.0, 3.0)
    check("clamp_opening_offset: clamps negative offset to 0.0", abs(clamped_neg - 0.0) < 0.01)

    # -------------------------------------------------------------------------
    # 7. Gate B8: Wall End Drag Past Opening Clamps to Safe Minimum Length
    # -------------------------------------------------------------------------
    # Dragging end point to (10.0, 0.0): wall would be 10ft, but door ends at 15ft
    clamped_pt, w_expl = clamp_wall_end(mgr, wall_guid, "end", [10.0, 0.0])
    check("Gate B8: clamp_wall_end clamps end to x=15.0", abs(clamped_pt[0] - 15.0) < 0.01 and abs(clamped_pt[1] - 0.0) < 0.01)
    check("Gate B8: clamp_wall_end provides explanation", w_expl is not None and "15.00" in w_expl)

    # -------------------------------------------------------------------------
    # 8. Negative Control: Wall End Past Opening Refused Without Clamp
    # -------------------------------------------------------------------------
    try:
        mgr.set_wall_end(wall_guid, "end", [10.0, 0.0], clamp=False)
        check("Refusal: set_wall_end without clamp rejected", False)
    except ValueError as e:
        check("Refusal: set_wall_end without clamp rejected with ValueError", "too short for hosted openings" in str(e))

    # Verify wall endpoint remains at original (20.0, 0.0)
    w_meta = mgr.element_meta[wall_guid]
    check("Refusal: wall endpoint untouched after refused edit", abs(w_meta["end"][0] - 20.0) < 0.01)

    # -------------------------------------------------------------------------
    # 9. Bus Transaction Execution: WallSetEnd with clamp=True & clamp=False
    # -------------------------------------------------------------------------
    # Bus with clamp=False: aborted transaction raises RuntimeError
    try:
        bus.execute_transaction(
            [
                CommandRequest(
                    command="WallSetEnd",
                    params={
                        "guid": wall_guid,
                        "end": "end",
                        "point": [8.0, 0.0],
                        "clamp": False,
                    },
                )
            ],
            "Shorten wall without clamp"
        )
        check("Bus transaction without clamp rejected", False)
    except RuntimeError as e:
        check("Bus transaction without clamp rolled back with RuntimeError", "too short" in str(e))

    # Bus with clamp=True: succeeds and clamps to 15.0
    res_clamped = bus.execute_transaction(
        [
            CommandRequest(
                command="WallSetEnd",
                params={
                    "guid": wall_guid,
                    "end": "end",
                    "point": [8.0, 0.0],
                    "clamp": True,
                },
            )
        ],
        "Shorten wall with clamp"
    )
    clamped_result_pt = res_clamped["results"][0]["result"]["point"]
    check("Bus transaction with clamp=True succeeded", abs(clamped_result_pt[0] - 15.0) < 0.01)
    check("Model element updated to clamped endpoint", abs(mgr.element_meta[wall_guid]["end"][0] - 15.0) < 0.01)

    # Undo/Redo of clamped WallSetEnd
    bus.undo()
    check("Undo restores original wall endpoint (20.0)", abs(mgr.element_meta[wall_guid]["end"][0] - 20.0) < 0.01)
    bus.redo()
    check("Redo reapplies clamped wall endpoint (15.0)", abs(mgr.element_meta[wall_guid]["end"][0] - 15.0) < 0.01)

    # Restore wall back to 20ft for next tests
    bus.undo()
    check("Restored wall back to 20.0ft", abs(mgr.element_meta[wall_guid]["end"][0] - 20.0) < 0.01)

    # -------------------------------------------------------------------------
    # 10. Bus Transaction Execution: OpeningSetOffset with clamp=True & clamp=False
    # -------------------------------------------------------------------------
    # Bus with clamp=False setting offset=19.0 (exceeds 20.0): fails
    try:
        bus.execute_transaction(
            [
                CommandRequest(
                    command="OpeningSetOffset",
                    params={
                        "guid": door_guid,
                        "offset": 19.0,
                        "clamp": False,
                    },
                )
            ],
            "Set door offset past wall without clamp"
        )
        check("OpeningSetOffset without clamp past wall rejected", False)
    except RuntimeError as e:
        check("OpeningSetOffset without clamp rolled back with RuntimeError", "exceeds host wall length" in str(e))

    # Bus with clamp=True setting offset=19.0: clamps to 17.0
    res_door_clamp = bus.execute_transaction(
        [
            CommandRequest(
                command="OpeningSetOffset",
                params={
                    "guid": door_guid,
                    "offset": 19.0,
                    "clamp": True,
                },
            )
        ],
        "Set door offset past wall with clamp"
    )
    door_clamped_off = res_door_clamp["results"][0]["result"]["offset"]
    check("OpeningSetOffset with clamp=True clamped to 17.0", abs(door_clamped_off - 17.0) < 0.01)
    check("Model door element updated to clamped offset 17.0", abs(mgr.element_meta[door_guid]["offset_along_wall"] - 17.0) < 0.01)

    # Undo/Redo of clamped OpeningSetOffset
    bus.undo()
    check("Undo restores original door offset (12.0)", abs(mgr.element_meta[door_guid]["offset_along_wall"] - 12.0) < 0.01)
    bus.redo()
    check("Redo reapplies clamped door offset (17.0)", abs(mgr.element_meta[door_guid]["offset_along_wall"] - 17.0) < 0.01)

    # -------------------------------------------------------------------------
    # 11. CommandBus Negative Controls for Thickness & Height
    # -------------------------------------------------------------------------
    try:
        bus.execute_transaction(
            [
                CommandRequest(
                    command="WallSetThickness",
                    params={"guid": wall_guid, "thickness": 0.02},  # sub-1-inch
                )
            ],
            "Set sub-1-inch thickness"
        )
        check("WallSetThickness sub-1-inch rejected by bus", False)
    except RuntimeError as e:
        check("WallSetThickness sub-1-inch rolled back with RuntimeError", "minimum allowable" in str(e))

    # WallSetHeight with 0 or negative
    try:
        bus.execute_transaction(
            [
                CommandRequest(
                    command="WallSetHeight",
                    params={"guid": wall_guid, "height": -2.0},
                )
            ],
            "Set negative height"
        )
        check("WallSetHeight negative rejected", False)
    except (ValidationError, RuntimeError):
        check("WallSetHeight negative rejected with ValidationError/RuntimeError", True)

    print(f"\nPhase 8 Gate Total: {passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_validity_predicates_gate()
