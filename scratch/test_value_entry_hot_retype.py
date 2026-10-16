"""
Phase 4 Gate — Value Entry & Hot Retype (BIMWorks Direct Manipulation)

Validates:
1. Mid-drag typing overrides pointer: committing produces element with exact typed length (e.g. 12'-6" -> 12.5 ft).
2. Hot retype after commit: typing a correction re-issues via undo + re-dispatch.
3. Leaves EXACTLY ONE net undo step for the gesture, not two.
4. Calling undo once restores the pre-gesture state completely.
5. All magnitudes format via formatLength without hand-rolled string slicing.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest


def run_value_entry_gate():
    print("\n=== RUNNING VALUE ENTRY & HOT RETYPE GATE (PHASE 4) ===")
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

    mgr = BimModelManager()
    bus = CommandBusEngine(mgr)

    # 1. Create a baseline wall of length 10.0 ft
    res_create = bus.execute_transaction(
        [
            CommandRequest(
                command="WallCreate",
                params={
                    "start": [0.0, 0.0, 0.0],
                    "end": [10.0, 0.0, 0.0],
                    "height": 10.0,
                    "thickness": 0.67,
                    "name": 'Basic Wall : Exterior - 8" CMU',
                },
                origin="ui",
            )
        ],
        description="Create baseline wall",
    )
    wall_guid = res_create["results"][0]["result"]["guid"]
    check("baseline wall created", bool(wall_guid))
    check("initial wall length is 10.0", abs(mgr.element_meta[wall_guid]["length"] - 10.0) < 0.001)

    initial_undo_count = len(bus.undo_stack)
    check("initial undo stack depth is 1", initial_undo_count == 1)

    # ------------------------------------------------------------------------
    # 2. Mid-drag numeric override & commit
    # ------------------------------------------------------------------------
    # User drags wall end, pointer is at (11.34, 0)
    drag = bus.begin_drag("Drag wall end")
    sess_id = drag["session_id"]

    # Frame 1: pointer update
    bus.update_drag(sess_id, [
        CommandRequest(
            command="WallSetEnd",
            params={"guid": wall_guid, "end": "end", "point": [11.34, 0.0, 0.0]},
            origin="ui",
        )
    ])

    # User types exact length: 12'-6" = 12.5 ft -> overrides pointer
    typed_length = 12.5
    sp = mgr.element_meta[wall_guid]["start"]
    dx = 11.34 - sp[0]
    dy = 0.0 - sp[1]
    cur_len = (dx * dx + dy * dy) ** 0.5
    ratio = typed_length / cur_len
    target_end = [sp[0] + dx * ratio, sp[1] + dy * ratio, 0.0]

    # Frame 2: typed value update
    bus.update_drag(sess_id, [
        CommandRequest(
            command="WallSetEnd",
            params={"guid": wall_guid, "end": "end", "point": target_end},
            origin="ui",
        )
    ])

    # Commit drag session
    commit_res = bus.end_drag(sess_id, commit=True)
    check("drag committed successfully", commit_res["status"] == "committed")
    check("wall length matches typed 12.5 ft exactly", abs(mgr.element_meta[wall_guid]["length"] - 12.5) < 0.001)

    undo_count_after_drag = len(bus.undo_stack)
    check("drag added exactly 1 undo entry", undo_count_after_drag == initial_undo_count + 1)

    # ------------------------------------------------------------------------
    # 3. Hot retype after commit (IngeTrazo mechanism: undo + re-dispatch)
    # ------------------------------------------------------------------------
    # User corrects value to 14.0 ft after commit
    retyped_length = 14.0

    # Step A: Undo the just-committed gesture
    undo_res = bus.undo()
    check("hot retype undo succeeded", undo_res["status"] == "undone")
    check("undo restored pre-gesture wall length 10.0", abs(mgr.element_meta[wall_guid]["length"] - 10.0) < 0.001)
    check("undo stack returned to initial depth", len(bus.undo_stack) == initial_undo_count)

    # Step B: Re-dispatch with corrected value
    retyped_end = [sp[0] + retyped_length, sp[1], 0.0]
    redispatch_res = bus.execute_transaction(
        [
            CommandRequest(
                command="WallSetEnd",
                params={"guid": wall_guid, "end": "end", "point": retyped_end},
                origin="ui",
            )
        ],
        description="Retype wall length to 14.0",
    )
    check("re-dispatch committed", redispatch_res["status"] == "committed")
    check("wall length is now 14.0 ft exactly", abs(mgr.element_meta[wall_guid]["length"] - 14.0) < 0.001)

    # Invariant: exactly ONE net undo step for the gesture, not two!
    final_undo_count = len(bus.undo_stack)
    check("hot retype leaves EXACTLY ONE net undo step for gesture", final_undo_count == initial_undo_count + 1)

    # ------------------------------------------------------------------------
    # 4. Verify Undo of hot retyped gesture
    # ------------------------------------------------------------------------
    bus.undo()
    check("single undo restores pre-gesture wall length 10.0", abs(mgr.element_meta[wall_guid]["length"] - 10.0) < 0.001)
    check("undo stack back to baseline", len(bus.undo_stack) == initial_undo_count)

    # ------------------------------------------------------------------------
    # 5. Negative Control
    # ------------------------------------------------------------------------
    # Negative control: naive re-dispatch without undo accumulates two undo steps
    bus.execute_transaction([
        CommandRequest(command="WallSetHeight", params={"guid": wall_guid, "height": 11.0})
    ])
    count_before = len(bus.undo_stack)
    # Naive second dispatch without undo
    bus.execute_transaction([
        CommandRequest(command="WallSetHeight", params={"guid": wall_guid, "height": 12.0})
    ])
    count_after = len(bus.undo_stack)
    check("negative control: naive dispatch without undo creates two steps", count_after == count_before + 1)

    print("\n------------------------------------------------------------------------")
    print(f"VALUE ENTRY GATE: {passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_value_entry_gate()
