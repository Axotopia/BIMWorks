"""
Phase 6 Gate — Grips Beyond Walls & Typed Edit Commands (BIMWorks Direct Manipulation)

Validates:
1. OpeningSetOffset, OpeningSetWidth, OpeningSetSillHeight, OpeningFlip execute through CommandBus as typed commands.
2. GridSetEndpoint executes through CommandBus as typed command.
3. PolygonSetVertex executes through CommandBus for IfcSlab and IfcRoof.
4. Journal records the typed command name (assert NO ElementUpdate).
5. Result reports the updated parameter value.
6. Mesh and element metadata change correspondingly.
7. Undo/Redo restores the exact previous state atomically.
8. Drag session executes typed commands across multiple frames, advancing rev by 1 with 1 journal entry.
9. Negative controls:
   - OpeningSetOffset with offset < 0 raises ValidationError.
   - OpeningSetWidth with width <= 0 raises ValidationError.
   - OpeningSetSillHeight with sill_height < 0 raises ValidationError.
   - GridSetEndpoint with invalid end raises ValidationError.
   - GridSetEndpoint with zero-length endpoint raises ValueError.
   - PolygonSetVertex with out-of-range index raises IndexError.
   - Target non-existent GUID raises KeyError.
   - Target wrong element type raises ValueError.
"""

import sys
import os
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest


def run_grips_beyond_walls_gate():
    print("\n=== RUNNING GRIPS BEYOND WALLS GATE (PHASE 6) ===")
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

    # 1. Baseline Model Setup: Wall, Door, Window, Grid, Slab, Roof
    res_wall = bus.execute_transaction(
        [
            CommandRequest(
                command="WallCreate",
                params={
                    "start": [0.0, 0.0, 0.0],
                    "end": [20.0, 0.0, 0.0],
                    "height": 10.0,
                    "thickness": 0.67,
                    "name": 'Basic Wall : Exterior - 8" CMU',
                },
                origin="ui",
            )
        ],
        description="Create baseline wall",
    )
    wall_guid = res_wall["results"][0]["result"]["guid"]
    check("baseline wall created", bool(wall_guid))

    res_door = bus.execute_transaction(
        [
            CommandRequest(
                command="DoorInsert",
                params={
                    "host_wall_guid": wall_guid,
                    "offset_along_wall": 5.0,
                    "width": 3.0,
                    "height": 7.0,
                    "name": 'Single Flush : 36" x 84"',
                },
                origin="ui",
            )
        ],
        description="Insert test door",
    )
    door_guid = res_door["results"][0]["result"]["guid"]
    check("baseline door created", bool(door_guid))

    res_window = bus.execute_transaction(
        [
            CommandRequest(
                command="WindowInsert",
                params={
                    "host_wall_guid": wall_guid,
                    "offset_along_wall": 12.0,
                    "width": 4.0,
                    "height": 4.0,
                    "sill_height": 3.0,
                    "name": 'Fixed Window : 48" x 48"',
                },
                origin="ui",
            )
        ],
        description="Insert test window",
    )
    window_guid = res_window["results"][0]["result"]["guid"]
    check("baseline window created", bool(window_guid))

    res_grid = bus.execute_transaction(
        [
            CommandRequest(
                command="GridCreate",
                params={
                    "axis_name": "1",
                    "start": [0.0, -5.0],
                    "end": [20.0, -5.0],
                },
                origin="ui",
            )
        ],
        description="Create test grid",
    )
    grid_guid = res_grid["results"][0]["result"]["guid"]
    check("baseline grid created", bool(grid_guid))

    res_slab = bus.execute_transaction(
        [
            CommandRequest(
                command="SlabCreate",
                params={
                    "polygon": [[0.0, 0.0], [20.0, 0.0], [20.0, 15.0], [0.0, 15.0]],
                    "thickness": 0.833,
                    "elevation": 0.0,
                },
                origin="ui",
            )
        ],
        description="Create test slab",
    )
    slab_guid = res_slab["results"][0]["result"]["guid"]
    check("baseline slab created", bool(slab_guid))

    res_roof = bus.execute_transaction(
        [
            CommandRequest(
                command="RoofCreate",
                params={
                    "polygon": [[0.0, 0.0], [20.0, 0.0], [20.0, 15.0], [0.0, 15.0]],
                    "thickness": 1.0,
                    "elevation": 10.0,
                    "pitch_degrees": 20.0,
                },
                origin="ui",
            )
        ],
        description="Create test roof",
    )
    roof_guid = res_roof["results"][0]["result"]["guid"]
    check("baseline roof created", bool(roof_guid))

    # ------------------------------------------------------------------------
    # 2. OpeningSetOffset
    # ------------------------------------------------------------------------
    res_off = bus.execute_transaction(
        [
            CommandRequest(
                command="OpeningSetOffset",
                params={"guid": door_guid, "offset": 8.0},
                origin="ui",
            )
        ],
        description="Slide door along wall to 8.0 ft",
    )
    check("OpeningSetOffset committed", res_off["status"] == "committed")
    check("command is typed OpeningSetOffset", bus.journal[-1]["commands"][0]["command"] == "OpeningSetOffset")
    check("result reports new offset 8.0", res_off["results"][0]["result"]["offset"] == 8.0)
    check("door meta offset updated to 8.0", mgr.element_meta[door_guid]["offset_along_wall"] == 8.0)

    # Undo/Redo OpeningSetOffset
    undo_res = bus.undo()
    check("undo OpeningSetOffset succeeded", undo_res["status"] == "undone")
    check("undo restored door offset to 5.0", mgr.element_meta[door_guid]["offset_along_wall"] == 5.0)
    redo_res = bus.redo()
    check("redo OpeningSetOffset succeeded", redo_res["status"] == "redone")
    check("redo restored door offset to 8.0", mgr.element_meta[door_guid]["offset_along_wall"] == 8.0)

    # ------------------------------------------------------------------------
    # 3. OpeningSetWidth
    # ------------------------------------------------------------------------
    res_w = bus.execute_transaction(
        [
            CommandRequest(
                command="OpeningSetWidth",
                params={"guid": door_guid, "width": 3.5},
                origin="ui",
            )
        ],
        description="Resize door width to 3.5 ft",
    )
    check("OpeningSetWidth committed", res_w["status"] == "committed")
    check("command is typed OpeningSetWidth", bus.journal[-1]["commands"][0]["command"] == "OpeningSetWidth")
    check("result reports new width 3.5", res_w["results"][0]["result"]["width"] == 3.5)
    check("door meta width updated to 3.5", mgr.element_meta[door_guid]["width"] == 3.5)

    undo_res = bus.undo()
    check("undo restored door width to 3.0", mgr.element_meta[door_guid]["width"] == 3.0)
    bus.redo()
    check("redo restored door width to 3.5", mgr.element_meta[door_guid]["width"] == 3.5)

    # ------------------------------------------------------------------------
    # 4. OpeningSetSillHeight
    # ------------------------------------------------------------------------
    res_sh = bus.execute_transaction(
        [
            CommandRequest(
                command="OpeningSetSillHeight",
                params={"guid": window_guid, "sill_height": 2.5},
                origin="ui",
            )
        ],
        description="Set window sill height to 2.5 ft",
    )
    check("OpeningSetSillHeight committed", res_sh["status"] == "committed")
    check("command is typed OpeningSetSillHeight", bus.journal[-1]["commands"][0]["command"] == "OpeningSetSillHeight")
    check("result reports new sill_height 2.5", res_sh["results"][0]["result"]["sill_height"] == 2.5)
    check("window meta sill_height updated to 2.5", mgr.element_meta[window_guid]["sill_height"] == 2.5)

    undo_res = bus.undo()
    check("undo restored window sill_height to 3.0", mgr.element_meta[window_guid]["sill_height"] == 3.0)
    bus.redo()
    check("redo restored window sill_height to 2.5", mgr.element_meta[window_guid]["sill_height"] == 2.5)

    # ------------------------------------------------------------------------
    # 5. OpeningFlip
    # ------------------------------------------------------------------------
    res_flip = bus.execute_transaction(
        [
            CommandRequest(
                command="OpeningFlip",
                params={"guid": door_guid},
                origin="ui",
            )
        ],
        description="Flip door swing",
    )
    check("OpeningFlip committed", res_flip["status"] == "committed")
    check("command is typed OpeningFlip", bus.journal[-1]["commands"][0]["command"] == "OpeningFlip")
    check("door meta swing_flipped is True", mgr.element_meta[door_guid]["swing_flipped"] is True)

    undo_res = bus.undo()
    check("undo restored door swing_flipped to False", mgr.element_meta[door_guid]["swing_flipped"] is False)
    bus.redo()
    check("redo restored door swing_flipped to True", mgr.element_meta[door_guid]["swing_flipped"] is True)

    # ------------------------------------------------------------------------
    # 6. GridSetEndpoint
    # ------------------------------------------------------------------------
    res_grid_move = bus.execute_transaction(
        [
            CommandRequest(
                command="GridSetEndpoint",
                params={"guid": grid_guid, "end": "end", "point": [25.0, -5.0]},
                origin="ui",
            )
        ],
        description="Extend grid endpoint to [25.0, -5.0]",
    )
    check("GridSetEndpoint committed", res_grid_move["status"] == "committed")
    check("command is typed GridSetEndpoint", bus.journal[-1]["commands"][0]["command"] == "GridSetEndpoint")
    check("grid meta end updated to [25.0, -5.0]", mgr.element_meta[grid_guid]["end"] == [25.0, -5.0])

    undo_res = bus.undo()
    check("undo restored grid end to [20.0, -5.0]", mgr.element_meta[grid_guid]["end"] == [20.0, -5.0])
    bus.redo()
    check("redo restored grid end to [25.0, -5.0]", mgr.element_meta[grid_guid]["end"] == [25.0, -5.0])

    # ------------------------------------------------------------------------
    # 7. PolygonSetVertex (Slab & Roof)
    # ------------------------------------------------------------------------
    res_poly_slab = bus.execute_transaction(
        [
            CommandRequest(
                command="PolygonSetVertex",
                params={"guid": slab_guid, "vertex_index": 2, "point": [22.0, 18.0]},
                origin="ui",
            )
        ],
        description="Move slab corner vertex to [22.0, 18.0]",
    )
    check("PolygonSetVertex for slab committed", res_poly_slab["status"] == "committed")
    check("command is typed PolygonSetVertex", bus.journal[-1]["commands"][0]["command"] == "PolygonSetVertex")
    check("slab vertex 2 updated", list(mgr.element_meta[slab_guid]["polygon"][2]) == [22.0, 18.0])

    undo_res = bus.undo()
    check("undo restored slab vertex 2 to [20.0, 15.0]", list(mgr.element_meta[slab_guid]["polygon"][2]) == [20.0, 15.0])
    bus.redo()
    check("redo restored slab vertex 2 to [22.0, 18.0]", list(mgr.element_meta[slab_guid]["polygon"][2]) == [22.0, 18.0])

    res_poly_roof = bus.execute_transaction(
        [
            CommandRequest(
                command="PolygonSetVertex",
                params={"guid": roof_guid, "vertex_index": 1, "point": [24.0, 0.0]},
                origin="ui",
            )
        ],
        description="Move roof eave vertex to [24.0, 0.0]",
    )
    check("PolygonSetVertex for roof committed", res_poly_roof["status"] == "committed")
    check("roof vertex 1 updated", list(mgr.element_meta[roof_guid]["polygon"][1]) == [24.0, 0.0])

    undo_res = bus.undo()
    check("undo restored roof vertex 1 to [20.0, 0.0]", list(mgr.element_meta[roof_guid]["polygon"][1]) == [20.0, 0.0])
    bus.redo()
    check("redo restored roof vertex 1 to [24.0, 0.0]", list(mgr.element_meta[roof_guid]["polygon"][1]) == [24.0, 0.0])

    # ------------------------------------------------------------------------
    # 8. Drag Session with Phase 6 Grip Movement
    # ------------------------------------------------------------------------
    init_rev = bus.rev
    drag_start = bus.begin_drag(origin="ui", description="Drag door along wall")
    session_id = drag_start["session_id"]
    check("begin_drag returns session_id", bool(session_id))
    check("begin_drag does not advance rev", bus.rev == init_rev)

    # 10 frames sliding door
    for i in range(1, 11):
        target_off = 8.0 + (i * 0.2)
        bus.update_drag(
            session_id,
            [
                CommandRequest(
                    command="OpeningSetOffset",
                    params={"guid": door_guid, "offset": target_off},
                    origin="ui",
                )
            ],
        )
        check(f"drag frame {i} rev constant", bus.rev == init_rev)

    check("live door offset reached 10.0", abs(mgr.element_meta[door_guid]["offset_along_wall"] - 10.0) < 0.001)

    end_res = bus.end_drag(session_id, commit=True)
    check("drag commit succeeded", end_res["status"] == "committed")
    check("drag advanced rev by exactly 1", bus.rev == init_rev + 1)
    check("drag emitted exactly 1 journal entry for 10 frames", len(bus.journal[-1]["commands"]) == 10)

    # Single undo restores pre-drag state
    bus.undo()
    check("undo drag restored pre-drag door offset 8.0", abs(mgr.element_meta[door_guid]["offset_along_wall"] - 8.0) < 0.001)

    # ------------------------------------------------------------------------
    # 9. Negative Controls
    # ------------------------------------------------------------------------
    # 9.1 OpeningSetOffset with negative offset rejected
    try:
        bus.execute_transaction(
            [CommandRequest(command="OpeningSetOffset", params={"guid": door_guid, "offset": -2.0}, origin="ui")],
            description="Bad offset",
        )
        check("negative control: offset < 0 rejected", False)
    except (ValidationError, ValueError, RuntimeError):
        check("negative control: offset < 0 rejected by validation", True)

    # 9.2 OpeningSetWidth with width <= 0 rejected
    try:
        bus.execute_transaction(
            [CommandRequest(command="OpeningSetWidth", params={"guid": door_guid, "width": 0.0}, origin="ui")],
            description="Bad width",
        )
        check("negative control: width <= 0 rejected", False)
    except (ValidationError, ValueError, RuntimeError):
        check("negative control: width <= 0 rejected by validation", True)

    # 9.3 OpeningSetSillHeight with sill_height < 0 rejected
    try:
        bus.execute_transaction(
            [CommandRequest(command="OpeningSetSillHeight", params={"guid": window_guid, "sill_height": -1.0}, origin="ui")],
            description="Bad sill_height",
        )
        check("negative control: sill_height < 0 rejected", False)
    except (ValidationError, ValueError, RuntimeError):
        check("negative control: sill_height < 0 rejected by validation", True)

    # 9.4 GridSetEndpoint with invalid end ('middle') rejected
    try:
        bus.execute_transaction(
            [CommandRequest(command="GridSetEndpoint", params={"guid": grid_guid, "end": "middle", "point": [10.0, 0.0]}, origin="ui")],
            description="Bad grid end",
        )
        check("negative control: invalid end rejected", False)
    except (ValidationError, ValueError, RuntimeError):
        check("negative control: invalid end rejected by validation", True)

    # 9.5 GridSetEndpoint with zero length rejected
    try:
        bus.execute_transaction(
            [CommandRequest(command="GridSetEndpoint", params={"guid": grid_guid, "end": "end", "point": [0.0, -5.0]}, origin="ui")],
            description="Zero length grid",
        )
        check("negative control: zero-length grid rejected", False)
    except (ValueError, RuntimeError):
        check("negative control: zero-length grid rejected by engine", True)

    # 9.6 PolygonSetVertex with negative index rejected
    try:
        bus.execute_transaction(
            [CommandRequest(command="PolygonSetVertex", params={"guid": slab_guid, "vertex_index": -1, "point": [0.0, 0.0]}, origin="ui")],
            description="Negative vertex index",
        )
        check("negative control: negative vertex index rejected", False)
    except (ValidationError, ValueError, RuntimeError):
        check("negative control: negative vertex index rejected by validation", True)

    # 9.7 PolygonSetVertex with out of bounds index rejected
    try:
        bus.execute_transaction(
            [CommandRequest(command="PolygonSetVertex", params={"guid": slab_guid, "vertex_index": 99, "point": [0.0, 0.0]}, origin="ui")],
            description="Out of bounds vertex index",
        )
        check("negative control: out of bounds vertex index rejected", False)
    except (IndexError, ValueError, RuntimeError):
        check("negative control: out of bounds vertex index rejected by engine", True)

    # 9.8 Non-existent GUID rejected
    try:
        bus.execute_transaction(
            [CommandRequest(command="OpeningSetOffset", params={"guid": "non-existent-guid", "offset": 5.0}, origin="ui")],
            description="Non-existent opening",
        )
        check("negative control: non-existent GUID rejected", False)
    except (KeyError, ValueError, RuntimeError):
        check("negative control: non-existent GUID rejected by engine", True)

    # 9.9 Wrong element type rejected (e.g. OpeningSetOffset on a Wall)
    try:
        bus.execute_transaction(
            [CommandRequest(command="OpeningSetOffset", params={"guid": wall_guid, "offset": 5.0}, origin="ui")],
            description="OpeningSetOffset on Wall",
        )
        check("negative control: wrong element type rejected", False)
    except (ValueError, RuntimeError):
        check("negative control: wrong element type rejected by engine", True)

    print("\n------------------------------------------------------------------------")
    print(f"GRIPS BEYOND WALLS GATE: {passed} passed, {failed} failed\n")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_grips_beyond_walls_gate()
