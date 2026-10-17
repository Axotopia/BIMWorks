"""
Test gate for Phase 4: ReferenceMove verb & drag-time extras wiring.
Normative: review/archive/IMPLEMENTATION-PLAN-geometric-references.md §4 Phase 4.

Verifies:
1. ReferenceMove verb registered on CommandBusEngine.
2. Dragging/moving a constrained wall end onto a grid axis holds the constraint relation.
3. Release re-solves once via ConstraintSolver authority (§3.7).
4. Drag-time extras constraint wiring in ConstraintSolver.
"""

import sys
import os
import math

sys.path.insert(0, os.path.abspath("backend"))

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest
from references import normalize_reference, resolve_reference

passed = 0
failed = 0


def check(name: str, condition: bool, detail: str = ""):
    global passed, failed
    if condition:
        print(f"  [PASS] {name}")
        passed += 1
    else:
        print(f"  [FAIL] {name}: {detail}")
        failed += 1


def run_tests():
    global passed, failed
    print("=== RUNNING REFERENCEMOVE & DRAG-TIME EXTRAS TEST GATE (PHASE 4) ===")

    mgr = BimModelManager()
    bus = CommandBusEngine(mgr)

    # 1. Setup: Wall 1 from (0, 0) to (10, 0)
    w1_res = bus.execute_single_command(
        "WallCreate",
        {"start": [0.0, 0.0], "end": [10.0, 0.0], "height": 10.0, "thickness": 0.5}
    )
    w1_guid = w1_res["guid"]

    # Wall 2 from (0, 8) to (10, 8), constrained to Wall 1 along X via align constraint
    w2_res = bus.execute_single_command(
        "WallCreate",
        {"start": [0.0, 8.0], "end": [10.0, 8.0], "height": 10.0, "thickness": 0.5}
    )
    w2_guid = w2_res["guid"]

    # Align constraint: Wall 2 follows Wall 1 along X
    align_c = mgr.add_align_constraint(ref_guid=w1_guid, target_guid=w2_guid, axis="x")
    check("align constraint created between W1 and W2", align_c["id"] in mgr.constraints)

    # 2. Grid axis: Grid line at X = 15.0
    grid_meta = mgr.add_grid(axis_name="Grid-A", start_pt=(15.0, -10.0), end_pt=(15.0, 30.0))
    grid_guid = grid_meta["guid"]
    check("grid axis created at x=15.0", grid_guid in mgr.element_meta)

    # 3. ReferenceMove: Move Wall 1 end onto Grid axis (moving along X by +5.0)
    # Wall 1 end was at (10, 0); Grid is at x=15.0. Delta dx should be +5.0.
    ref_src = {"guid": w1_guid, "ref": "end"}
    ref_tgt = {"kind": "grid_axis", "sources": [{"element_guid": grid_guid, "ordinal": 0}]}

    tx_res = bus.execute_transaction(
        [CommandRequest(command="ReferenceMove", params={
            "source": ref_src,
            "target": ref_tgt,
            "axis": "x",
            "extras": [("align", (w1_guid, w2_guid))],
        })],
        description="move wall to grid",
    )
    move_res = tx_res["results"][0]["result"]
    check("ReferenceMove executed successfully", move_res["status"] == "moved")
    check("ReferenceMove delta X is 5.0", abs(move_res["dx"] - 5.0) < 1e-4)

    # 4. Verify Wall 1 endpoint moved onto grid axis
    w1_meta = mgr.element_meta[w1_guid]
    check("Wall 1 end reached x=15.0 (on grid axis)", abs(w1_meta["end"][0] - 15.0) < 1e-4)
    check("Wall 1 start moved with wall to x=5.0", abs(w1_meta["start"][0] - 5.0) < 1e-4)

    # 5. Verify Wall 2 (constrained) followed Wall 1, holding the relation
    w2_meta = mgr.element_meta[w2_guid]
    check("Wall 2 followed Wall 1 along X (constraint held)", abs(w2_meta["start"][0] - 5.0) < 1e-4)
    check("Wall 2 end reached x=15.0", abs(w2_meta["end"][0] - 15.0) < 1e-4)

    # 6. Verify Solver extras seam directly
    from constraint_solver import ConstraintSolver
    solver = ConstraintSolver(mgr)
    # Solve with drag-time extra dimension_lock between W1 and W2
    solve_res = solver.solve(
        axis="x",
        pins={w1_guid: 5.0},
        scope=[w1_guid, w2_guid],
        extras=[("align", (w1_guid, w2_guid))],
    )
    check("ConstraintSolver.solve with extras succeeds", solve_res.ok)
    check("ConstraintSolver extras reported in applied", any("extra:" in c for c in solve_res.applied))

    # 7. Journal integrity
    journal = bus.get_journal()
    ref_move_entry = next((e for e in journal if any(cmd.get("command") == "ReferenceMove" for cmd in e.get("commands", []))), None)
    check("ReferenceMove recorded in command bus transaction journal", ref_move_entry is not None)

    print(f"\nRESULTS: {passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_tests()
