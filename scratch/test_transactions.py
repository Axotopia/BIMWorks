"""
BIMWorks — Transaction engine regression tests (GLM Master Spec v2.3 §3.2)
Verifies: atomic rollback, true multi-step undo/redo of ALL command types
(create / move / delete / constraints), journal integrity, redo invalidation.

Run: ./.venv/bin/python scratch/test_transactions.py
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from ifc_service import BimModelManager
from command_bus import CommandBusEngine
from command_bus import CommandRequest, TransactionRequest

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'✓' if cond else '✗ FAIL'} {name}" + (f" — {detail}" if detail and not cond else ""))


mgr = BimModelManager("Tx Test")
bus = CommandBusEngine(mgr)

# ---------------------------------------------------------------- 1. setup
print("1. Setup: two walls")
r1 = bus.execute_transaction([CommandRequest(command="WallCreate", params={
    "start": [0.0, 0.0, 0.0], "end": [10.0, 0.0, 0.0], "height": 3.0, "thickness": 0.2})],
    description="wall A")
r2 = bus.execute_transaction([CommandRequest(command="WallCreate", params={
    "start": [0.0, 5.0, 0.0], "end": [10.0, 5.0, 0.0], "height": 3.0, "thickness": 0.2})],
    description="wall B")
guid_a = r1["results"][0]["result"]["guid"]
guid_b = r2["results"][0]["result"]["guid"]
check("two walls created", len(mgr.element_meta) == 2)

# ------------------------------------------------- 2. undo of a WallMove
print("2. Undo/redo of WallMove")
bus.execute_transaction([CommandRequest(command="WallMove", params={
    "guid": guid_a, "dx": 4.0, "dy": 2.0})], description="move A")
sx = mgr.element_meta[guid_a]["start"]
check("wall moved", abs(sx[0] - 4.0) < 1e-9 and abs(sx[1] - 2.0) < 1e-9, f"start={sx}")

u = bus.undo()
sx = mgr.element_meta[guid_a]["start"]
check("undo restores position", abs(sx[0]) < 1e-9 and abs(sx[1]) < 1e-9, f"start={sx}")
check("undo reports transaction", u["status"] == "undone" and u["description"] == "move A")

r = bus.redo()
sx = mgr.element_meta[guid_a]["start"]
check("redo re-applies move", abs(sx[0] - 4.0) < 1e-9 and abs(sx[1] - 2.0) < 1e-9, f"start={sx}")
check("redo reports transaction", r["status"] == "redone")

# ----------------------------- 3. multi-step undo + multi-step redo
print("3. Multi-step undo/redo")
u1 = bus.undo()  # undone: move A
u2 = bus.undo()  # undone: wall B create
check("wall B gone after undo", guid_b not in mgr.element_meta)
check("wall A still present", guid_a in mgr.element_meta)

r1_ = bus.redo()  # redo: wall B create
check("redo 1: wall B back", guid_b in mgr.element_meta)
r2_ = bus.redo()  # redo: move A
sx = mgr.element_meta[guid_a]["start"]
check("redo 2: move re-applied", abs(sx[0] - 4.0) < 1e-9, f"start={sx}")

# redo stack must be empty now (no more redos)
r_extra = bus.redo()
check("redo stack exhausted", r_extra["status"] == "empty")

# ------------------------------- 4. undo of DeleteElement restores it
print("4. Undo of DeleteElement")
bus.execute_transaction([CommandRequest(command="DeleteElement", params={"guid": guid_b})])
check("wall B deleted", guid_b not in mgr.element_meta)
bus.undo()
check("undo resurrects deleted wall", guid_b in mgr.element_meta)
try:
    ent = mgr.model.by_guid(guid_b)
    check("resurrected wall exists in IFC file", ent is not None)
except Exception as e:
    check("resurrected wall exists in IFC file", False, str(e))

# -------------------------------------------------- 5. atomic rollback
print("5. Atomic rollback on failed transaction")
walls_before = len(mgr.element_meta)
undo_depth_before = len(bus.undo_stack)
journal_len_before = len(bus.journal)
try:
    bus.execute_transaction([
        CommandRequest(command="WallCreate", params={
            "start": [20.0, 0.0, 0.0], "end": [25.0, 0.0, 0.0]}),
        CommandRequest(command="DeleteElement", params={"guid": "nonexistent-guid"}),
    ], description="doomed tx")
    check("failed transaction raises", False)
except RuntimeError as e:
    check("failed transaction raises", "rolled back" in str(e))
check("rollback: no wall left behind", len(mgr.element_meta) == walls_before,
      f"before={walls_before} after={len(mgr.element_meta)}")
check("failed tx is not on undo stack", len(bus.undo_stack) == undo_depth_before,
      f"undo depth {undo_depth_before} -> {len(bus.undo_stack)}")
check("failed tx is not journalled", len(bus.journal) == journal_len_before)

# ------------------------------------- 6. redo invalidated by new transaction
print("6. Redo stack invalidation")
bus.undo()  # undo the delete (wall B back)
bus.execute_transaction([CommandRequest(command="WallCreate", params={
    "start": [30.0, 0.0, 0.0], "end": [35.0, 0.0, 0.0]})], description="wall C")
r_stale = bus.redo()
check("redo stack cleared by new transaction", r_stale["status"] == "empty")

# ---------------------------------------------------- 7. journal integrity
print("7. Journal")
j = bus.get_journal(limit=100)
check("journal has one entry per committed tx", len(j) == 5, f"entries={len(j)}")
check("journal entries carry commands", all("commands" in e for e in j))
check("journal entries carry origin", all("origin" in e for e in j))

# ------------------------------------- 8. geometry pipeline still coherent
print("8. Post-rollback geometry coherence")
meshes = mgr.get_geometry_buffers()
check("geometry buffers generate", meshes is not None)

# ------------------------------------- 9. hosted openings (opening_entity refs)
print("9. Door with opening_entity survives undo/redo")
d = bus.execute_transaction([CommandRequest(command="DoorInsert", params={
    "host_wall_guid": guid_a, "offset_along_wall": 5.0})], description="door in A")
door_guid = d["results"][0]["result"]["guid"]
check("door created with opening ref", "opening_entity" in mgr.element_meta[door_guid])
bus.undo()
check("undo removes door", door_guid not in mgr.element_meta)
check("undo heals wall (no hosted_openings left)",
      not mgr.element_meta[guid_a].get("hosted_openings"))
bus.redo()
check("redo restores door", door_guid in mgr.element_meta)
check("redo restores opening entity ref",
      isinstance(mgr.element_meta[door_guid].get("opening_entity"), object)
      and mgr.element_meta[door_guid]["opening_entity"] is not None
      and hasattr(mgr.element_meta[door_guid]["opening_entity"], "GlobalId"))

print()
print(f"RESULT: {len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("FAILED:", FAIL)
    sys.exit(1)
print("ALL TRANSACTION TESTS PASSED")
