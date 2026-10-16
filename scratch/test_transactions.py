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
from references import resolve_reference

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'[OK]' if cond else '[FAIL]'} {name}" + (f" - {detail}" if detail and not cond else ""))


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

# ------------------------------------- 10. Phase 5: Reference-aware memento in Undo/Redo
print("10. Reference-aware memento in Undo/Redo")
# Create Wall D
rd = bus.execute_transaction([CommandRequest(command="WallCreate", params={
    "start": [50.0, 0.0, 0.0], "end": [60.0, 0.0, 0.0], "height": 3.0, "thickness": 0.2})],
    description="wall D")
guid_d = rd["results"][0]["result"]["guid"]

# Create dimension between Wall A and Wall D
r_dim = bus.execute_transaction([CommandRequest(command="DimensionCreate", params={
    "ref_a": {"guid": guid_a, "ref": "end"},
    "ref_b": {"guid": guid_d, "ref": "start"},
    "axis": "x",
})], description="dim A-D")
dim_id = r_dim["results"][0]["result"]["dimension_id"]
check("dimension created via transaction", dim_id in mgr.dimensions)

# Verify references resolve as exact initially
pt_a, out_a = resolve_reference(mgr, mgr.dimensions[dim_id]["ref_a"])
pt_b, out_b = resolve_reference(mgr, mgr.dimensions[dim_id]["ref_b"])
check("dimension ref_a resolves exact", out_a == "exact" and pt_a is not None)
check("dimension ref_b resolves exact", out_b == "exact" and pt_b is not None)

# Verify snapshot_state / restore_state round-trips dimensions and resolvable references
snap = mgr.snapshot_state()
check("snapshot captures dimensions", dim_id in snap["dimensions"])
mgr.restore_state(snap)
check("restore_state restores dimensions", dim_id in mgr.dimensions)
pt_a2, out_a2 = resolve_reference(mgr, mgr.dimensions[dim_id]["ref_a"])
check("restored ref_a resolves exact", out_a2 == "exact" and pt_a2 == pt_a)

# Delete Wall D via transaction: dimension should be cleaned up
bus.execute_transaction([CommandRequest(command="DeleteElement", params={"guid": guid_d})], description="delete D")
check("Wall D deleted", guid_d not in mgr.element_meta)
check("referencing dimension removed upon element delete", dim_id not in mgr.dimensions)

# Undo delete: Wall D resurrected AND referencing dimension restored with resolvable references
bus.undo()
check("undo restores Wall D", guid_d in mgr.element_meta)
check("undo restores referencing dimension", dim_id in mgr.dimensions)
pt_b_restored, out_b_restored = resolve_reference(mgr, mgr.dimensions[dim_id]["ref_b"])
check("restored dimension ref_b resolves exact after undo", out_b_restored == "exact" and pt_b_restored is not None)

# Redo delete: Wall D deleted again, dimension removed again
bus.redo()
check("redo re-deletes Wall D", guid_d not in mgr.element_meta)
check("redo removes dimension again", dim_id not in mgr.dimensions)

# Undo once more to leave in clean state
bus.undo()
check("second undo brings Wall D and dimension back", guid_d in mgr.element_meta and dim_id in mgr.dimensions)

print()
print(f"RESULT: {len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("FAILED:", FAIL)
    sys.exit(1)
print("ALL TRANSACTION TESTS PASSED")
