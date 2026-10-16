"""
Phase 3 Gate — Typed Wall Commands and Grips (BIMWorks Direct Manipulation)

Validates:
1. WallSetHeight, WallSetThickness, WallSetEnd execute through CommandBus as typed commands.
2. Journal records the typed command name (assert NO ElementUpdate).
3. Result reports the updated parameter value.
4. Mesh and element metadata change correspondingly.
5. Undo/Redo restores the exact previous state without full model reload.
6. Drag session executes typed commands across multiple frames, advancing rev by 1 with 1 journal entry.
7. Negative controls:
   - Misspelled key on ElementUpdate raises ValueError.
   - Height <= 0 raises ValidationError.
   - Thickness <= 0 raises ValidationError.
   - WallSetEnd zero-length endpoint raises ValueError.
"""

import sys
import os
import math
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest


def run_wall_grips_gate():
    print("\n=== RUNNING WALL GRIPS & TYPED COMMANDS GATE (PHASE 3) ===")
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

    # 1. Create a baseline wall
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
        description="Create test wall",
    )
    wall_guid = res_create["results"][0]["result"]["guid"]
    check("wall created successfully", bool(wall_guid))

    # ------------------------------------------------------------------------
    # 2. WallSetHeight
    # ------------------------------------------------------------------------
    res_h = bus.execute_transaction(
        [
            CommandRequest(
                command="WallSetHeight",
                params={"guid": wall_guid, "height": 14.0},
                origin="ui",
            )
        ],
        description="Set wall height to 14.0",
    )
    check("WallSetHeight committed", res_h["status"] == "committed")

    # Assert exactly 1 command in journal and NOT ElementUpdate
    last_entry = bus.journal[-1]
    cmds = last_entry["commands"]
    check("journal has 1 command for WallSetHeight", len(cmds) == 1)
    check("command is typed WallSetHeight (NOT ElementUpdate)", cmds[0]["command"] == "WallSetHeight")
    check("no ElementUpdate in journal", all(c["command"] != "ElementUpdate" for c in cmds))

    # Result reports new height
    h_result = res_h["results"][0]["result"]
    check("result reports new height 14.0", h_result["height"] == 14.0)

    # Element meta reflects new height
    meta = mgr.element_meta[wall_guid]
    check("element_meta height updated to 14.0", meta["height"] == 14.0)
    check("element_meta bbox max Z updated to 14.0", abs(meta["bbox"]["max"][2] - 14.0) < 0.01)

    # Undo restores 10.0
    undo_res = bus.undo()
    check("undo WallSetHeight succeeded", undo_res["status"] == "undone")
    check("undo restored height to 10.0", mgr.element_meta[wall_guid]["height"] == 10.0)
    check("undo restored bbox max Z to 10.0", abs(mgr.element_meta[wall_guid]["bbox"]["max"][2] - 10.0) < 0.01)

    # Redo sets 14.0
    redo_res = bus.redo()
    check("redo WallSetHeight succeeded", redo_res["status"] == "redone")
    check("redo restored height to 14.0", mgr.element_meta[wall_guid]["height"] == 14.0)

    # ------------------------------------------------------------------------
    # 3. WallSetThickness
    # ------------------------------------------------------------------------
    res_t = bus.execute_transaction(
        [
            CommandRequest(
                command="WallSetThickness",
                params={"guid": wall_guid, "thickness": 1.25},
                origin="ui",
            )
        ],
        description="Set wall thickness to 1.25",
    )
    check("WallSetThickness committed", res_t["status"] == "committed")
    last_entry = bus.journal[-1]
    check("command is typed WallSetThickness", last_entry["commands"][0]["command"] == "WallSetThickness")
    check("result reports new thickness 1.25", res_t["results"][0]["result"]["thickness"] == 1.25)
    check("element_meta thickness updated to 1.25", mgr.element_meta[wall_guid]["thickness"] == 1.25)

    # Undo restores 0.67
    bus.undo()
    check("undo restored thickness to 0.67", mgr.element_meta[wall_guid]["thickness"] == 0.67)

    # ------------------------------------------------------------------------
    # 4. WallSetEnd
    # ------------------------------------------------------------------------
    res_end = bus.execute_transaction(
        [
            CommandRequest(
                command="WallSetEnd",
                params={"guid": wall_guid, "end": "start", "point": [-5.0, 0.0, 0.0]},
                origin="ui",
            )
        ],
        description="Extend wall start to -5.0",
    )
    check("WallSetEnd committed", res_end["status"] == "committed")
    last_entry = bus.journal[-1]
    check("command is typed WallSetEnd", last_entry["commands"][0]["command"] == "WallSetEnd")
    check("start coordinate moved to -5.0", mgr.element_meta[wall_guid]["start"][0] == -5.0)
    check("wall length updated to 15.0", abs(mgr.element_meta[wall_guid]["length"] - 15.0) < 0.001)

    # Undo restores [0, 0, 0]
    bus.undo()
    check("undo restored start to 0.0", mgr.element_meta[wall_guid]["start"][0] == 0.0)
    check("undo restored length to 10.0", abs(mgr.element_meta[wall_guid]["length"] - 10.0) < 0.001)

    # ------------------------------------------------------------------------
    # 5. Drag session with typed commands
    # ------------------------------------------------------------------------
    pre_drag_h = mgr.element_meta[wall_guid]["height"]
    drag = bus.begin_drag("Interactive drag wall height")
    sess_id = drag["session_id"]
    rev_before = bus.rev

    # Emit 15 frames of height updates
    for i in range(1, 16):
        h = 10.0 + (i * 0.2)
        up = bus.update_drag(sess_id, [
            CommandRequest(
                command="WallSetHeight",
                params={"guid": wall_guid, "height": h},
                origin="ui",
            )
        ])
        check(f"frame {i} rev constant", bus.rev == rev_before)

    check("live height reached 13.0 at end of drag", abs(mgr.element_meta[wall_guid]["height"] - 13.0) < 0.001)

    # Commit drag session
    end_res = bus.end_drag(sess_id, commit=True)
    check("drag commit succeeded", end_res["status"] == "committed")
    check("drag advanced rev by exactly 1", bus.rev == rev_before + 1)
    check("drag emitted exactly 1 journal entry for 15 frames", len(bus.journal[-1]["commands"]) == 15)

    # Undo drag restores pre-drag height
    bus.undo()
    check(f"undo drag restores pre-drag height {pre_drag_h}", abs(mgr.element_meta[wall_guid]["height"] - pre_drag_h) < 0.001)

    # ------------------------------------------------------------------------
    # 6. Negative Controls
    # ------------------------------------------------------------------------
    # Control A: ElementUpdate with misspelled key raises ValueError
    misspelled_error = False
    try:
        mgr.update_element(wall_guid, {"heigt": 15.0})
    except ValueError as e:
        misspelled_error = True
        check("negative control: misspelled key in ElementUpdate rejected", "Unrecognized" in str(e))
    if not misspelled_error:
        check("negative control: misspelled key in ElementUpdate rejected", False)

    # Control B: Height <= 0 rejected by schema validation
    invalid_height_error = False
    try:
        bus.execute_transaction([
            CommandRequest(command="WallSetHeight", params={"guid": wall_guid, "height": -2.0})
        ])
    except (ValidationError, ValueError, RuntimeError):
        invalid_height_error = True
    check("negative control: height <= 0 rejected by validation", invalid_height_error)

    # Control C: Thickness <= 0 rejected by schema validation
    invalid_thick_error = False
    try:
        bus.execute_transaction([
            CommandRequest(command="WallSetThickness", params={"guid": wall_guid, "thickness": 0.0})
        ])
    except (ValidationError, ValueError, RuntimeError):
        invalid_thick_error = True
    check("negative control: thickness <= 0 rejected by validation", invalid_thick_error)

    # Control D: Degenerate zero-length wall rejected
    zero_len_error = False
    try:
        bus.execute_transaction([
            CommandRequest(command="WallSetEnd", params={"guid": wall_guid, "end": "start", "point": [10.0, 0.0, 0.0]})
        ])
    except (ValidationError, ValueError, RuntimeError):
        zero_len_error = True
    check("negative control: zero-length wall rejected", zero_len_error)

    # Control E: Typed command on non-existent element raises error
    missing_guid_error = False
    try:
        bus.execute_transaction([
            CommandRequest(command="WallSetHeight", params={"guid": "non-existent-guid", "height": 12.0})
        ])
    except (KeyError, ValueError, RuntimeError):
        missing_guid_error = True
    check("negative control: non-existent element rejected", missing_guid_error)

    print("\n------------------------------------------------------------------------")
    print(f"WALL GRIPS GATE: {passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_wall_grips_gate()
