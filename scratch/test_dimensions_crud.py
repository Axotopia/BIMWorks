"""
Backend test gate for Dimension-driven editing (Phase 2, Tasks 2.2, 2.3, 2.5).

Verifies:
1. Overlay dimension object creation (single-wall baseline and 2-element distance).
2. DimensionValueSet: wall length resize along baseline (moves end point, recalculates length/mesh).
3. DimensionValueSet with anchor="end" (moves start point).
4. DimensionValueSet with anchor="center" (moves both start and end symmetrically).
5. DimensionValueSet rejects non-positive values (value <= 0).
6. Locked dimensions bind an active distance constraint in manager.constraints.
7. DimensionValueSet on locked dimension moves target element and updates constraint.
8. Dimension deletion cleans up both dimension and linked constraint.
9. Container round-trip: dimensions persist in parametric.json overlay and restore on load.
10. Bus command parity: DimensionCreate, DimensionValueSet, DimensionDelete work via CommandBusEngine.
11. Contract emission: _finish_plan_contract formats overlay dimensions with valid text, length, and witness points.
"""

import sys
import os
import math
import tempfile

sys.path.insert(0, os.path.abspath("backend"))

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest
from units import format_feet_inches
from references import resolve_reference

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
    print("=== RUNNING DIMENSIONS CRUD & SEMANTICS TEST GATE ===")

    # 1. Single Wall Length Dimension
    mgr = BimModelManager()
    w1 = mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], height=10.0, thickness=0.5)
    w1_guid = w1["guid"]

    dim1 = mgr.create_dimension(
        ref_a={"guid": w1_guid, "ref": "start"},
        ref_b={"guid": w1_guid, "ref": "end"},
        kind="aligned",
        offset=1.5,
    )
    check("create single-wall dimension", dim1["id"] in mgr.dimensions)
    check("derived initial value is 10.0 ft", abs(dim1["value"] - 10.0) < 1e-4, f"got {dim1['value']}")
    check("dimensions_rev incremented", mgr.dimensions_rev >= 1)

    # 2. Resize Wall via DimensionValueSet
    res = mgr.set_dimension_value(dim1["id"], 16.5, anchor="start")
    w1_meta = mgr.element_meta[w1_guid]
    check("wall length updated to 16.5", abs(w1_meta["length"] - 16.5) < 1e-4, f"got {w1_meta['length']}")
    check("wall start remained (0,0)", abs(w1_meta["start"][0]) < 1e-4 and abs(w1_meta["start"][1]) < 1e-4)
    check("wall end moved to (16.5, 0)", abs(w1_meta["end"][0] - 16.5) < 1e-4 and abs(w1_meta["end"][1]) < 1e-4)
    check("dim value updated to 16.5", abs(dim1["value"] - 16.5) < 1e-4)

    # 3. Resize Wall with anchor="end"
    mgr.set_dimension_value(dim1["id"], 20.0, anchor="end")
    w1_meta = mgr.element_meta[w1_guid]
    check("wall end remained (16.5, 0)", abs(w1_meta["end"][0] - 16.5) < 1e-4)
    check("wall start moved to (-3.5, 0)", abs(w1_meta["start"][0] - (-3.5)) < 1e-4)
    check("wall length updated to 20.0", abs(w1_meta["length"] - 20.0) < 1e-4)

    # 4. Resize Wall with anchor="center"
    mgr.set_dimension_value(dim1["id"], 10.0, anchor="center")
    w1_meta = mgr.element_meta[w1_guid]
    # Center was (-3.5 + 16.5) / 2 = 6.5. Half-length = 5.0. New start = 1.5, end = 11.5.
    check("wall start at 1.5", abs(w1_meta["start"][0] - 1.5) < 1e-4)
    check("wall end at 11.5", abs(w1_meta["end"][0] - 11.5) < 1e-4)
    check("wall length is 10.0", abs(w1_meta["length"] - 10.0) < 1e-4)

    # 5. Non-positive value rejected
    try:
        mgr.set_dimension_value(dim1["id"], -5.0)
        check("negative value rejected", False, "Should have raised ValueError")
    except ValueError:
        check("negative value rejected", True)

    try:
        mgr.set_dimension_value(dim1["id"], 0.0)
        check("zero value rejected", False, "Should have raised ValueError")
    except ValueError:
        check("zero value rejected", True)

    # 6. Direct Element Dimension Edit (editing by GUID directly)
    mgr.set_dimension_value(w1_guid, 12.0)
    w1_meta = mgr.element_meta[w1_guid]
    check("direct guid length edit updated wall to 12.0", abs(w1_meta["length"] - 12.0) < 1e-4)

    # 7. Two-element Dimension with Active Lock Constraint
    w2 = mgr.add_wall([1.5, 10.0, 0.0], [13.5, 10.0, 0.0], height=10.0, thickness=0.5)
    w2_guid = w2["guid"]

    dim_between = mgr.create_dimension(
        ref_a={"guid": w1_guid, "ref": "start"},
        ref_b={"guid": w2_guid, "ref": "start"},
        axis="y",
        is_locked=True,
    )
    check("locked dimension created", dim_between["is_locked"] is True)
    check("initial y distance is 10.0", abs(dim_between["value"] - 10.0) < 1e-4)
    cid = dim_between["constraint_id"]
    check("constraint lock registered in constraints", cid in mgr.constraints)
    check("constraint locked_distance is 10.0", abs(mgr.constraints[cid]["locked_distance"] - 10.0) < 1e-4)

    # 8. Re-value Two-element Dimension
    mgr.set_dimension_value(dim_between["id"], 15.0)
    w2_meta = mgr.element_meta[w2_guid]
    check("w2 moved along Y to 15.0", abs(w2_meta["start"][1] - 15.0) < 1e-4, f"got {w2_meta['start'][1]}")
    check("constraint updated locked_distance to 15.0", abs(mgr.constraints[cid]["locked_distance"] - 15.0) < 1e-4)

    # 9. Delete Dimension
    mgr.delete_dimension(dim_between["id"])
    check("dimension removed from manager.dimensions", dim_between["id"] not in mgr.dimensions)
    check("associated constraint lock removed", cid not in mgr.constraints)

    # 10. Element Deletion Cleans Up Referencing Dimensions
    dim_temp = mgr.create_dimension(
        ref_a={"guid": w2_guid, "ref": "start"},
        ref_b={"guid": w2_guid, "ref": "end"},
    )
    dim_temp_id = dim_temp["id"]
    check("dim_temp exists", dim_temp_id in mgr.dimensions)
    mgr.delete_element(w2_guid)
    check("dim_temp cleaned up on element deletion", dim_temp_id not in mgr.dimensions)

    # 11. Container Round-trip (persistence in parametric.json overlay)
    tmp_path = os.path.join(tempfile.gettempdir(), "test_dim_persist.bimworks")
    mgr.save_orlt_project(tmp_path)

    mgr2 = BimModelManager()
    mgr2.load_orlt_project(tmp_path)
    check("dimensions restored from container", dim1["id"] in mgr2.dimensions)
    restored_dim = mgr2.dimensions[dim1["id"]]
    check("restored dim value matches", abs(restored_dim["value"] - 12.0) < 1e-4)
    check("restored dim ref_a guid matches", restored_dim["ref_a"]["guid"] == w1_guid)

    try:
        os.remove(tmp_path)
    except Exception:
        pass

    # 12. Bus Command Parity via CommandBusEngine
    engine = CommandBusEngine(mgr)
    w3_res = engine.execute_single_command(
        "WallCreate",
        {"start": [0.0, 30.0], "end": [25.0, 30.0], "height": 10.0, "thickness": 0.5}
    )
    w3_guid = w3_res["guid"]

    dim_bus = engine.execute_single_command(
        "DimensionCreate",
        {
            "ref_a": {"guid": w3_guid, "ref": "start"},
            "ref_b": {"guid": w3_guid, "ref": "end"},
            "kind": "aligned",
            "offset": 2.0,
        }
    )
    check("DimensionCreate via bus", dim_bus["status"] == "created")
    dim_bus_id = dim_bus["dimension_id"]

    edit_bus = engine.execute_single_command(
        "DimensionValueSet",
        {"dimension_id": dim_bus_id, "value": 30.0, "anchor": "start"}
    )
    check("DimensionValueSet via bus", edit_bus["status"] == "updated")
    check("w3 length resized to 30.0", abs(mgr.element_meta[w3_guid]["length"] - 30.0) < 1e-4)

    del_bus = engine.execute_single_command(
        "DimensionDelete",
        {"dimension_id": dim_bus_id}
    )
    check("DimensionDelete via bus", del_bus["status"] == "deleted")
    check("dim removed after bus delete", dim_bus_id not in mgr.dimensions)

    # 13. Contract Output in Plan View
    dim_final = mgr.create_dimension(
        ref_a={"guid": w3_guid, "ref": "start"},
        ref_b={"guid": w3_guid, "ref": "end"},
    )
    plan = mgr.slice_2d_vector_plan(cut_elevation=4.0)
    check("plan contract carries dimensions", "dimensions" in plan and len(plan["dimensions"]) > 0)
    found_contract_dim = next((d for d in plan["dimensions"] if d.get("id") == dim_final["id"]), None)
    check("dim_final emitted in plan dimensions", found_contract_dim is not None)
    if found_contract_dim:
        check("contract dim has length 30.0", abs(found_contract_dim["length"] - 30.0) < 1e-4)
        check("contract dim text is 30'-0\"", found_contract_dim["text"] == '30\'-0"')
        check("contract dim has witness start/end", len(found_contract_dim["start"]) == 2 and len(found_contract_dim["end"]) == 2)
        check("contract dim has offset_norm", len(found_contract_dim["offset_norm"]) == 2)

    # 14. Level Dimensions & Controls (Task 2.7)
    lvl2_id = next((lid for lid, lv in mgr.levels.items() if lv.get("name") == "Level 2"), list(mgr.levels.keys())[1])
    lvl1_id = next((lid for lid, lv in mgr.levels.items() if lv.get("name") == "Level 1"), list(mgr.levels.keys())[0])

    # Direct edit of level elevation via set_dimension_value (by name "Level 2")
    mgr.set_dimension_value("Level 2", 14.0)
    check("direct level edit updated elevation to 14.0", abs(mgr.levels[lvl2_id]["elevation"] - 14.0) < 1e-4)

    # Dimension between Level 1 and Level 2
    dim_lvl = mgr.create_dimension(
        ref_a={"level_id": lvl1_id},
        ref_b={"level_id": lvl2_id},
        axis="y",
    )
    check("level dimension created", dim_lvl["id"] in mgr.dimensions)
    check("level dimension initial value 14.0", abs(dim_lvl["value"] - 14.0) < 1e-4)

    # Edit level dimension to 12.0
    mgr.set_dimension_value(dim_lvl["id"], 12.0)
    check("level_2 elevation moved to 12.0 via dimension", abs(mgr.levels[lvl2_id]["elevation"] - 12.0) < 1e-4)

    # Elevation contract carries levels linework & bubbles
    elev_contract = mgr.render_2d_view("elevation")
    check("elevation contract carries levels key", "levels" in elev_contract)
    check("elevation contract has level lines", len(elev_contract["levels"]) >= 2)
    lvl2_svg = next((lv for lv in elev_contract["levels"] if lv["id"] == lvl2_id), None)
    check("level_2 in elevation contract", lvl2_svg is not None)
    if lvl2_svg:
        check("level_2 svg has elevation 12.0", abs(lvl2_svg["elevation"] - 12.0) < 1e-4)
        check("level_2 text formatted feet-inches", "12'-0\"" in lvl2_svg["text"])
        check("level_2 has valid path d", lvl2_svg["d"].startswith("M "))
        check("level_2 has bubble center", len(lvl2_svg["circle_center"]) == 2)

    # 15. Chained Dimensions with refs (Task 2.6)
    dim_chain = mgr.create_dimension(
        ref_a={"guid": w3_guid, "ref": "start"},
        ref_b={"guid": w3_guid, "ref": "end"},
        refs=[
            {"guid": w3_guid, "ref": "start"},
            {"guid": w3_guid, "ref": "midpoint"},
            {"guid": w3_guid, "ref": "end"},
        ],
        eq_group="chain_1",
    )
    check("chained dimension created with refs", dim_chain.get("refs") is not None and len(dim_chain["refs"]) == 3)
    check("chained dimension has eq_group", dim_chain.get("eq_group") == "chain_1")

    # 16. Geometric References & Lost Reference Assertions (Phase 1)
    # 16a. Verify ref_a and ref_b are normalized on create
    check("dim_chain ref_a is canonical wall_start", dim_chain["ref_a"]["kind"] == "wall_start")
    check("dim_chain ref_b is canonical wall_end", dim_chain["ref_b"]["kind"] == "wall_end")
    check("dim_chain refs[1] is canonical wall_center", dim_chain["refs"][1]["kind"] == "wall_center")

    # 16b. Lost reference returns 'lost' outcome and None coords, NEVER (0.0, 0.0)
    lost_ref = {"guid": "deleted-or-invalid-guid", "ref": "start"}
    pt_lost, outcome_lost = resolve_reference(mgr, lost_ref)
    check("lost reference outcome is 'lost'", outcome_lost == "lost")
    check("lost reference coords is None (never silent 0,0)", pt_lost is None)

    # 16c. Creating / updating dimension with lost reference handled gracefully
    dim_dangling = mgr.create_dimension(
        ref_a={"guid": w3_guid, "ref": "start"},
        ref_b=lost_ref,
        value=15.0,
    )
    edit_dangling = mgr.set_dimension_value(dim_dangling["id"], 20.0)
    check("set_dimension_value on lost reference returns error", edit_dangling.get("status") == "error")

    # 16d. Plan contract surfaces lost dimensions with status 'lost' and None start/end (never anchored to 0,0)
    plan_with_dangling = mgr.slice_2d_vector_plan(cut_elevation=4.0)
    dangling_dim = next((d for d in plan_with_dangling.get("dimensions", []) if d.get("id") == dim_dangling["id"]), None)
    check("lost reference dimension emitted in plan contract", dangling_dim is not None)
    check("lost reference dimension has status 'lost'", dangling_dim is not None and dangling_dim.get("status") == "lost")
    check("lost reference dimension start is None (not anchored to 0,0)", dangling_dim is not None and dangling_dim.get("start") is None)
    check("lost reference dimension end is None (not anchored to 0,0)", dangling_dim is not None and dangling_dim.get("end") is None)

    # 16e. Round 3 F1: a persisted 'lost' must not keep a dimension hidden once its witness
    # exists. The contract keys visibility off the LIVE resolution, not off the stored status —
    # otherwise a re-added GUID / re-imported IFC / re-opened overlay leaves it invisible forever.
    dim_recover = mgr.create_dimension(
        ref_a={"guid": "ghost-recover-guid", "ref": "start"},
        ref_b={"guid": w3_guid, "ref": "start"},
        value=5.0,
    )
    check("dim_recover stored status is 'lost' while witness is missing", dim_recover.get("status") == "lost")
    pre_contract = mgr.slice_2d_vector_plan(cut_elevation=4.0)
    pre = next((d for d in pre_contract.get("dimensions", []) if d.get("id") == dim_recover["id"]), None)
    check("dim_recover emitted as 'lost' with no coordinates", pre is not None and pre.get("status") == "lost" and pre.get("start") is None)
    # The witness appears (re-added GUID / re-imported IFC / re-opened overlay). Placed far from the
    # existing model so wall joins cannot perturb the geometry other assertions depend on.
    mgr.add_wall([200.0, 200.0, 0.0], [204.0, 200.0, 0.0], height=10.0, thickness=0.5, guid="ghost-recover-guid")
    post_contract = mgr.slice_2d_vector_plan(cut_elevation=4.0)
    post = next((d for d in post_contract.get("dimensions", []) if d.get("id") == dim_recover["id"]), None)
    check("dim_recover visible again once the witness exists (stale 'lost' discarded)", post is not None and post.get("status") != "lost")
    check("dim_recover has live coordinates again (not None)", post is not None and post.get("start") is not None)
    mgr.delete_dimension(dim_recover["id"])

    # Clean up test dimension
    mgr.delete_dimension(dim_dangling["id"])

    # 17. Witness Move Repair & Element Deletion (Phase 2 Gate)
    # 17a. Witness moves: dimension reports 'repaired' and updates value to 15.0, not a wrong number
    w_p2a = mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], height=10.0, thickness=0.5)
    w_p2b = mgr.add_wall([0.0, 10.0, 0.0], [10.0, 10.0, 0.0], height=10.0, thickness=0.5)
    dim_p2 = mgr.create_dimension(
        ref_a={"guid": w_p2a["guid"], "ref": "start"},
        ref_b={"guid": w_p2b["guid"], "ref": "start"},
        axis="y",
    )
    check("dim_p2 initial status is exact", dim_p2.get("status") == "exact")
    check("dim_p2 initial value is 10.0", abs(dim_p2["value"] - 10.0) < 1e-4)

    # Translate w_p2b by +5.0 in Y
    mgr.translate_element(w_p2b["guid"], 0.0, 5.0, 0.0)
    check("dim_p2 reports repaired after witness moves", dim_p2.get("status") == "repaired")
    check("dim_p2 value updated to 15.0 (not a wrong number)", abs(dim_p2["value"] - 15.0) < 1e-4)

    # 17b. Delete referenced element: reference resolution yields 'lost', never (0.0, 0.0)
    p2b_guid = w_p2b["guid"]
    mgr.delete_element(p2b_guid)
    p2b_ref = {"guid": p2b_guid, "ref": "start"}
    pt_p2b, out_p2b = resolve_reference(mgr, p2b_ref)
    check("deleting referenced element yields 'lost'", out_p2b == "lost")
    check("deleting referenced element yields None coords (never 0.0, 0.0)", pt_p2b is None)

    # 18. Phase 2: add_dimension and resolve_dimension (§2 Rule 4 / Phase 2.2 / Phase 2.5)
    w_d1 = mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], height=10.0, thickness=0.5)
    w_d2 = mgr.add_wall([10.0, 0.0, 0.0], [20.0, 0.0, 0.0], height=10.0, thickness=0.5)
    refs_d = [
        {"kind": "wall_start", "sources": [{"element_guid": w_d1["guid"], "ordinal": 0}], "hint": {"point": [0.0, 0.0, 0.0], "normal": None}},
        {"kind": "wall_end", "sources": [{"element_guid": w_d1["guid"], "ordinal": 0}], "hint": {"point": [10.0, 0.0, 0.0], "normal": None}},
        {"kind": "wall_end", "sources": [{"element_guid": w_d2["guid"], "ordinal": 0}], "hint": {"point": [20.0, 0.0, 0.0], "normal": None}},
    ]
    # 18a: add_dimension derives segment values without taking value
    dim_multi = mgr.add_dimension(refs_d, axis="x")
    check("add_dimension creates segments array of length 2", len(dim_multi.get("segments", [])) == 2)
    check("segment 0 measured value is 10.0", abs(dim_multi["segments"][0]["value"] - 10.0) < 1e-4)
    check("segment 1 measured value is 10.0", abs(dim_multi["segments"][1]["value"] - 10.0) < 1e-4)

    # 18b: resolve_dimension reads model dynamically
    init_res0 = mgr.resolve_dimension(dim_multi["id"], 0)
    check("resolve_dimension segment 0 is 10.0", init_res0 is not None and abs(init_res0 - 10.0) < 1e-4)
    mgr.translate_element(w_d2["guid"], 4.0, 0.0, 0.0)
    updated_res1 = mgr.resolve_dimension(dim_multi["id"], 1)
    check("resolve_dimension segment 1 updates to 14.0 after wall move", updated_res1 is not None and abs(updated_res1 - 14.0) < 1e-4)

    # 18c: binding slot validations
    val_err_lock_label = False
    try:
        mgr.add_dimension(refs_d[:2], is_locked=True, label="LengthParam")
    except ValueError:
        val_err_lock_label = True
    check("validator rejects locked + label together", val_err_lock_label)

    val_err_multi_locked = False
    try:
        mgr.add_dimension(refs_d, is_locked=True, binding="literal")
    except ValueError:
        val_err_multi_locked = True
    check("validator rejects locked on multi-segment unless binding == 'equal'", val_err_multi_locked)

    dim_eq = mgr.add_dimension(refs_d, is_locked=True, binding="equal")
    check("multi-segment dimension with binding == 'equal' succeeds", dim_eq is not None and dim_eq.get("binding") == "equal")

    # 19. Gate 3: The dimension drives geometry & conflict reporting (Phase 3 & 4)
    # 19a. Referenceable kinds opt-in publication (Phase 4.1 / §2.1)
    wall_kinds = mgr.referenceable_kinds(w_d1["guid"])
    check("wall publishes wall_start", "wall_start" in wall_kinds)
    check("wall publishes wall_end", "wall_end" in wall_kinds)
    check("wall publishes wall_face_pos", "wall_face_pos" in wall_kinds)
    grid_g3 = mgr.add_grid("G3", [15.0, 0.0], [15.0, 20.0])
    grid_kinds = mgr.referenceable_kinds(grid_g3["guid"])
    check("grid publishes grid_axis", "grid_axis" in grid_kinds)
    level_kinds = mgr.referenceable_kinds("Level 1")
    check("level publishes level_plane", "level_plane" in level_kinds)

    # 19b. Gate 3 Case 1: Dimension wall_start <-> wall_end drives length to 12.0 ft
    w_g3 = mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], height=10.0, thickness=0.5)
    dim_g3_len = mgr.add_dimension([
        {"kind": "wall_start", "sources": [{"element_guid": w_g3["guid"], "ordinal": 0}]},
        {"kind": "wall_end", "sources": [{"element_guid": w_g3["guid"], "ordinal": 0}]},
    ], axis="x")
    check("initial wall length is 10.0", abs(mgr.element_meta[w_g3["guid"]]["length"] - 10.0) < 1e-4)
    engine.execute_single_command("DimensionValueSet", {
        "dimension_id": dim_g3_len["id"],
        "value": 12.0,
        "anchor": "start",
    })
    check("DimensionValueSet to 12.0 resizes wall to 12.0 ft", abs(mgr.element_meta[w_g3["guid"]]["length"] - 12.0) < 1e-4)
    check("resolve_dimension returns 12.0 ft", abs(mgr.resolve_dimension(dim_g3_len["id"]) - 12.0) < 1e-4)

    # 19c. Gate 3 Case 2: Dimension wall_start <-> grid_axis drives wall coordinate
    dim_g3_grid = mgr.create_dimension(
        ref_a={"guid": w_g3["guid"], "ref": "start"},
        ref_b={"guid": grid_g3["guid"], "ref": "grid_axis"},
        axis="x",
    )
    # Wall start is at 0.0, Grid is at 15.0. Set dimension to 5.0 ft -> wall start lands on 10.0 ft.
    mgr.set_dimension_value(dim_g3_grid["id"], 5.0)
    w_g3_start_x = mgr.element_meta[w_g3["guid"]]["start"][0]
    check("wall start coordinate landed on 10.0 ft", abs(w_g3_start_x - 10.0) < 1e-4, f"got {w_g3_start_x}")
    check("resolve_dimension to grid returns 5.0 ft", abs(mgr.resolve_dimension(dim_g3_grid["id"]) - 5.0) < 1e-4)

    # 19d. Gate 3 Case 3: Deliberately over-constrain returns structured conflict with >=1 resolution and zero geometry change
    w_oc1 = mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0])
    w_oc2 = mgr.add_wall([10.0, 0.0, 0.0], [20.0, 0.0, 0.0])
    dim_oc1 = mgr.create_dimension(
        ref_a={"guid": w_oc1["guid"], "ref": "start"},
        ref_b={"guid": w_oc2["guid"], "ref": "end"},
        axis="x",
        is_locked=True,
    )
    dim_oc2 = mgr.create_dimension(
        ref_a={"guid": w_oc1["guid"], "ref": "start"},
        ref_b={"guid": w_oc2["guid"], "ref": "end"},
        axis="x",
    )
    # Attempt contradictory distance of 30.0 while dim_oc1 is locked at 20.0
    pre_w1_start = list(mgr.element_meta[w_oc1["guid"]]["start"])
    pre_w2_end = list(mgr.element_meta[w_oc2["guid"]]["end"])
    oc_res = mgr.set_dimension_value(dim_oc2["id"], 30.0)
    check("over-constraint returns conflict status", oc_res.get("status") == "conflict")
    check("over-constraint returns conflict object", "conflict" in oc_res and oc_res["conflict"] is not None)
    resolutions = oc_res.get("conflict", {}).get("resolutions", [])
    check("conflict contains resolutions", len(resolutions) >= 1)
    check("resolution offers unlock_dimension", any(r.get("kind") == "unlock_dimension" for r in resolutions))
    check("geometry unchanged: w1 start untouched", mgr.element_meta[w_oc1["guid"]]["start"] == pre_w1_start)
    check("geometry unchanged: w2 end untouched", mgr.element_meta[w_oc2["guid"]]["end"] == pre_w2_end)

    # 19e. Phase 6.1: DimensionLockToggle via Command Bus with undo/redo
    tx_lock = engine.execute_transaction([
        CommandRequest(command="DimensionLockToggle", params={"dimension_id": dim_oc2["id"], "is_locked": True})
    ], origin="ui", description="Lock dimension")
    check("DimensionLockToggle executed", dim_oc2["id"] in mgr.dimensions and mgr.dimensions[dim_oc2["id"]].get("is_locked") is True)
    engine.undo()
    check("undo restores unlocked state", mgr.dimensions[dim_oc2["id"]].get("is_locked") is False)
    engine.redo()
    check("redo restores locked state", mgr.dimensions[dim_oc2["id"]].get("is_locked") is True)

    print(f"\nRESULTS: {passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)

if __name__ == "__main__":
    run_tests()

