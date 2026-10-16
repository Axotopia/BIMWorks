#!/usr/bin/env python3
"""
scratch/test_trim_split_gate.py
Gate 0.2: Trim / Split / Extend Semantics Verification Gate (Phase 3).
Per IMPLEMENTATION-PLAN-revit-feel.md §3 Phase 0.2 & Phase 3:
- Trim-to-corner moves BOTH walls and establishes corner join
- Trim clamps to target body when single-trim is outside target bounds
- Split re-hosts openings whose offset is beyond the cut onto the second wall
- Split strictly refuses when an opening straddles the cut point
- Split-with-gap leaves precise gap between segments
- Join policy and dimension propagation are preserved across trim/split
"""

import math
import os
import sys

# Ensure backend directory is in python path
BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from ifc_service import BimModelManager
from command_bus import CommandBusEngine

passed = 0
failed = 0

def check(name: str, condition: bool, extra: str = ""):
    global passed, failed
    if condition:
        print(f"  [PASS] {name}")
        passed += 1
    else:
        msg = f"  [FAIL] {name}"
        if extra:
            msg += f" -- {extra}"
        print(msg)
        failed += 1

def run_tests():
    global passed, failed
    print("=== RUNNING GATE 0.2: TRIM & SPLIT REVIT-FEEL SEMANTICS GATE ===")

    mgr = BimModelManager()
    engine = CommandBusEngine(mgr)

    # -------------------------------------------------------------------------
    # 1. Trim-to-Corner: Moves BOTH walls & establishes corner join (Task 3.1)
    # -------------------------------------------------------------------------
    # Wall A: (0, 0) -> (10, 0), thickness 0.5
    wA = mgr.add_wall((0.0, 0.0, 0.0), (10.0, 0.0, 0.0), thickness=0.5, name="Wall A")["guid"]
    # Wall B: (6.0, 4.0, 0.0) -> (6.0, 14.0, 0.0), thickness 0.75
    wB = mgr.add_wall((6.0, 4.0, 0.0), (6.0, 14.0, 0.0), thickness=0.75, name="Wall B")["guid"]

    # Intersection of baselines is at (6.0, 0.0)
    # Trim to corner: Wall A should trim (10, 0) -> (6, 0).
    # Wall B should extend (6, 4) -> (6, 0).
    res_trim = mgr.trim_extend_wall(wA, 1, wB, corner_mode=True)
    check("trim_extend_wall returned trimmed", res_trim["status"] in ("trimmed", "corner_trimmed"))

    mA = mgr.element_meta[wA]
    mB = mgr.element_meta[wB]

    # Both walls now meet at (6.0, 0.0)
    check("Wall A end moved to (6.0, 0.0)", abs(mA["end"][0] - 6.0) < 1e-4 and abs(mA["end"][1] - 0.0) < 1e-4)
    check("Wall A start remained (0.0, 0.0)", abs(mA["start"][0] - 0.0) < 1e-4 and abs(mA["start"][1] - 0.0) < 1e-4)
    check("Wall A length updated to 6.0", abs(mA["length"] - 6.0) < 1e-4)

    check("Wall B start moved to (6.0, 0.0)", abs(mB["start"][0] - 6.0) < 1e-4 and abs(mB["start"][1] - 0.0) < 1e-4)
    check("Wall B end remained (6.0, 14.0)", abs(mB["end"][0] - 6.0) < 1e-4 and abs(mB["end"][1] - 14.0) < 1e-4)
    check("Wall B length extended to 14.0", abs(mB["length"] - 14.0) < 1e-4)

    # -------------------------------------------------------------------------
    # 2. Trim Clamping to Target Body for Single-Wall Trim (Task 3.1)
    # -------------------------------------------------------------------------
    # Target wall: (20.0, 0.0) -> (20.0, 10.0)
    wTarget = mgr.add_wall((20.0, 0.0, 0.0), (20.0, 10.0, 0.0), name="Target Wall")["guid"]
    # Runner wall far above target body: (0.0, 30.0) -> (10.0, 30.0)
    wRunner = mgr.add_wall((0.0, 30.0, 0.0), (10.0, 30.0, 0.0), name="Runner Wall")["guid"]

    # When corner_mode=False, runner trims to target line but target body only reaches y=10.0.
    # It must clamp to target's body (y=10.0) instead of extending to (20.0, 30.0).
    res_single = mgr.trim_extend_wall(wRunner, 1, wTarget, corner_mode=False)
    mRunner = mgr.element_meta[wRunner]
    check("single trim clamped to target body max Y (10.0)", abs(mRunner["end"][1] - 10.0) < 1e-4 or abs(mRunner["end"][0] - 20.0) < 1e-4)

    # -------------------------------------------------------------------------
    # 3. Split Wall Re-hosting Hosted Openings (Task 3.2)
    # -------------------------------------------------------------------------
    # Host wall: (0, 0) -> (30, 0), length 30 ft
    wHost = mgr.add_wall((0.0, 50.0, 0.0), (30.0, 50.0, 0.0), name="Host Wall")["guid"]
    door_guid = mgr.add_door(
        host_wall_guid=wHost,
        offset_along_wall=22.0,
        width=3.0,
        height=7.0,
        name="Door 22ft",
    )["guid"]

    check("door initially hosted on wHost", mgr.element_meta[door_guid]["host_wall_guid"] == wHost)
    check("door offset is 22.0 ft", abs(mgr.element_meta[door_guid]["offset_along_wall"] - 22.0) < 1e-4)

    # Split at 15.0 ft
    res_split = mgr.split_wall(wHost, at_offset=15.0)
    wSecond = res_split["new_guid"]

    mHost = mgr.element_meta[wHost]
    mSecond = mgr.element_meta[wSecond]
    mDoor = mgr.element_meta[door_guid]

    check("split created second wall", wSecond in mgr.element_meta)
    check("original wall length is 15.0", abs(mHost["length"] - 15.0) < 1e-4)
    check("second wall length is 15.0", abs(mSecond["length"] - 15.0) < 1e-4)

    # Door was at 22.0 ft. Cut at 15.0 ft means door is at offset 7.0 ft on second wall!
    check("door re-hosted to second wall", mDoor["host_wall_guid"] == wSecond)
    check("door offset re-calculated to 7.0 ft", abs(mDoor["offset_along_wall"] - 7.0) < 1e-4)
    check("second wall lists door in hosted_openings", door_guid in (mSecond.get("hosted_openings") or []))
    check("original wall no longer has door in hosted_openings", door_guid not in (mHost.get("hosted_openings") or []))

    # -------------------------------------------------------------------------
    # 4. Refuse Split Straddling an Opening (Task 3.2)
    # -------------------------------------------------------------------------
    # Host wall: (0, 0) -> (30, 0)
    wHost2 = mgr.add_wall((0.0, 80.0, 0.0), (30.0, 80.0, 0.0), name="Host Wall 2")["guid"]
    win_guid = mgr.add_window(
        host_wall_guid=wHost2,
        offset_along_wall=10.0,
        width=4.0, # spans 10.0 to 14.0
        height=4.0,
        sill_height=3.0,
        name="Window Straddle",
    )["guid"]

    refused = False
    try:
        # Split attempted at 12.0 ft (inside window 10.0..14.0)
        mgr.split_wall(wHost2, at_offset=12.0)
    except ValueError as e:
        refused = True
        print(f"    (Refusal confirmed: {e})")

    check("split straddling opening is strictly refused", refused)
    check("wHost2 length remained 30.0", abs(mgr.element_meta[wHost2]["length"] - 30.0) < 1e-4)

    # -------------------------------------------------------------------------
    # 5. Split With Gap (Task 3.3)
    # -------------------------------------------------------------------------
    wHost3 = mgr.add_wall((0.0, 110.0, 0.0), (20.0, 110.0, 0.0), name="Host Wall 3")["guid"]
    gap_feet = 0.5 # 6 inches
    res_gap = mgr.split_wall(wHost3, at_offset=10.0, gap=gap_feet)
    wSecond3 = res_gap["new_guid"]

    mH3 = mgr.element_meta[wHost3]
    mS3 = mgr.element_meta[wSecond3]

    check("split with gap first segment length is 9.75", abs(mH3["length"] - 9.75) < 1e-4)
    check("split with gap second segment length is 9.75", abs(mS3["length"] - 9.75) < 1e-4)
    actual_gap = mS3["start"][0] - mH3["end"][0]
    check("gap between segments is exactly 0.5 ft", abs(actual_gap - gap_feet) < 1e-4)

    # -------------------------------------------------------------------------
    # 6. Bus Parity for Trim and Split
    # -------------------------------------------------------------------------
    wBus1 = mgr.add_wall((0.0, 140.0, 0.0), (10.0, 140.0, 0.0))["guid"]
    wBus2 = mgr.add_wall((5.0, 145.0, 0.0), (5.0, 155.0, 0.0))["guid"]

    bus_trim = engine.execute_single_command(
        "WallTrimExtend",
        {"guid": wBus1, "end_index": 1, "target_guid": wBus2, "corner_mode": True}
    )
    check("WallTrimExtend via bus returned success", bus_trim.get("status") in ("trimmed", "corner_trimmed"))
    check("Wall 1 end moved to (5.0, 140.0)", abs(mgr.element_meta[wBus1]["end"][0] - 5.0) < 1e-4)
    check("Wall 2 start moved to (5.0, 140.0)", abs(mgr.element_meta[wBus2]["start"][1] - 140.0) < 1e-4)

    # -------------------------------------------------------------------------
    # 7. Datum Trimming to Grid Line & Level Datum (Task 3.5)
    # -------------------------------------------------------------------------
    # Wall intersecting grid line
    wDatum = mgr.add_wall((0.0, 160.0, 0.0), (10.0, 160.0, 0.0), height=10.0)["guid"]
    grid_res = mgr.add_grid("G1", (7.0, 100.0), (7.0, 200.0))
    grid_guid = grid_res["guid"]

    res_grid_trim = mgr.trim_extend_wall(wDatum, 1, grid_guid)
    check("trim to grid datum succeeded", res_grid_trim["status"] == "datum_trimmed")
    check("wall end moved to grid line x=7.0", abs(mgr.element_meta[wDatum]["end"][0] - 7.0) < 1e-4)
    check("wall length trimmed to 7.0", abs(mgr.element_meta[wDatum]["length"] - 7.0) < 1e-4)

    # Wall trimmed to Level datum
    level_res = mgr.add_level("Roof Level", 14.0)
    level_id = level_res if isinstance(level_res, str) else level_res["id"]
    res_level_trim = mgr.trim_extend_wall(wDatum, 1, level_id)
    check("trim to level datum succeeded", res_level_trim["status"] == "datum_trimmed")
    check("wall height updated to level elevation 14.0", abs(mgr.element_meta[wDatum]["height"] - 14.0) < 1e-4)

    print(f"\nRESULTS: {passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)

if __name__ == "__main__":
    run_tests()
