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
import copy

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
    check("dim_p2 reports exact status after witness moves", dim_p2.get("status") == "exact")
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
        mgr.add_dimension(refs_d[:2], is_locked=True, binding="parameter", label="LengthParam")
    except ValueError:
        val_err_lock_label = True
    check("validator rejects locked + label together", val_err_lock_label)

    val_err_literal_label = False
    try:
        mgr.add_dimension(refs_d[:2], binding="literal", label="ForbiddenLabel")
    except ValueError:
        val_err_literal_label = True
    check("validator rejects label when binding == 'literal'", val_err_literal_label)

    val_err_param_nolabel = False
    try:
        mgr.add_dimension(refs_d[:2], binding="parameter", label=None)
    except ValueError:
        val_err_param_nolabel = True
    check("validator rejects binding == 'parameter' without label", val_err_param_nolabel)

    dim_param = mgr.add_dimension(refs_d[:2], binding="parameter", label="ValidParam")
    check("binding == 'parameter' with label succeeds", dim_param is not None and dim_param.get("binding") == "parameter" and dim_param.get("label") == "ValidParam")

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
    cid_oc2 = mgr.dimensions[dim_oc2["id"]].get("constraint_id")
    check("DimensionLockToggle executed", dim_oc2["id"] in mgr.dimensions and mgr.dimensions[dim_oc2["id"]].get("is_locked") is True)
    check("DimensionLockToggle created constraint in manager.constraints", cid_oc2 is not None and cid_oc2 in mgr.constraints)
    engine.undo()
    check("undo restores unlocked state", mgr.dimensions[dim_oc2["id"]].get("is_locked") is False)
    check("undo removes constraint from manager.constraints", cid_oc2 not in mgr.constraints)
    engine.redo()
    check("redo restores locked state", mgr.dimensions[dim_oc2["id"]].get("is_locked") is True)
    check("redo restores constraint in manager.constraints", cid_oc2 in mgr.constraints)

    # 19f. H1: Same-wall reference pairs (not length dimensions) round-trip without corrupting wall length
    w_h1 = mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], height=10.0, thickness=0.5)
    dim_sc = mgr.add_dimension([
        {"kind": "wall_start", "sources": [{"element_guid": w_h1["guid"], "ordinal": 0}]},
        {"kind": "wall_center", "sources": [{"element_guid": w_h1["guid"], "ordinal": 0}]},
    ], axis="x")
    check("start<->center dimension initial value is 5.0", abs(mgr.resolve_dimension(dim_sc["id"]) - 5.0) < 1e-4)
    res_sc = mgr.set_dimension_value(dim_sc["id"], 3.0)
    check("start<->center set_dimension_value succeeds", res_sc.get("status") == "updated")
    check("start<->center resolve_dimension returns 3.0 ft", abs(mgr.resolve_dimension(dim_sc["id"]) - 3.0) < 1e-4)
    check("start<->center resized wall length to 6.0 ft (not forced to 3.0 ft)", abs(mgr.element_meta[w_h1["guid"]]["length"] - 6.0) < 1e-4)

    # 19g. H2: DimensionLockToggle synchronizes with self.constraints (releases lock)
    dim_locked_h2 = mgr.create_dimension(
        ref_a={"guid": w_oc1["guid"], "ref": "start"},
        ref_b={"guid": w_oc2["guid"], "ref": "end"},
        axis="x",
        is_locked=True,
    )
    cid_h2 = dim_locked_h2.get("constraint_id")
    check("locked dimension created constraint_id", cid_h2 is not None and cid_h2 in mgr.constraints)
    check("constraint is active and locked", mgr.constraints[cid_h2].get("is_locked") is True)
    engine.execute_single_command("DimensionLockToggle", {"dimension_id": dim_locked_h2["id"], "is_locked": False})
    check("dim['is_locked'] toggled to False", mgr.dimensions[dim_locked_h2["id"]].get("is_locked") is False)
    check("constraints[cid]['is_locked'] toggled to False (released)", mgr.constraints[cid_h2].get("is_locked") is False)
    engine.execute_single_command("DimensionLockToggle", {"dimension_id": dim_locked_h2["id"], "is_locked": True})
    check("constraints[cid]['is_locked'] restored to True", mgr.constraints[cid_h2].get("is_locked") is True)

    # 19h. H3: Dimension from wall to level_plane drives level elevation relatively and round-trips
    lvl_base = mgr.add_level("Level Base", elevation=20.0)
    w_h3 = mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], level_id=lvl_base)
    # Check creation value to hosting level is 0.0
    dim_lvl_same = mgr.create_dimension(
        ref_a={"kind": "wall_start", "sources": [{"element_guid": w_h3["guid"], "ordinal": 0}]},
        ref_b={"kind": "level_plane", "sources": [{"element_guid": lvl_base, "ordinal": 0}]},
        axis="z",
    )
    check("wall to its hosting level measures 0.0 ft", abs(mgr.resolve_dimension(dim_lvl_same["id"]) - 0.0) < 1e-4)

    lvl_h3 = mgr.add_level("Level H3", elevation=30.0)
    dim_lvl = mgr.create_dimension(
        ref_a={"kind": "wall_start", "sources": [{"element_guid": w_h3["guid"], "ordinal": 0}]},
        ref_b={"kind": "level_plane", "sources": [{"element_guid": lvl_h3, "ordinal": 0}]},
        axis="z",
    )
    check("initial level dimension value is 10.0 ft", abs(mgr.resolve_dimension(dim_lvl["id"]) - 10.0) < 1e-4)
    res_lvl = mgr.set_dimension_value(dim_lvl["id"], 15.0)
    check("level dimension set to 15.0 updated", res_lvl.get("status") == "updated")
    check("level elevation is 35.0 ft (20 + 15 relative)", abs(float(mgr.levels[lvl_h3]["elevation"]) - 35.0) < 1e-4)
    check("resolve_dimension to level returns 15.0 ft", abs(mgr.resolve_dimension(dim_lvl["id"]) - 15.0) < 1e-4)
    check("dim['value'] recorded as 15.0 ft", abs(mgr.dimensions[dim_lvl["id"]]["value"] - 15.0) < 1e-4)

    # 19i. H4: Failed solve refusal does not mutate dim['value']
    dim_fail = copy.deepcopy(dim_g3_len)
    dim_fail["id"] = "dim_test_fail"
    dim_fail["ref_b"] = {"kind": "wall_end", "sources": [{"element_guid": "non_existent_wall", "ordinal": 0}]}
    mgr.dimensions[dim_fail["id"]] = dim_fail
    res_fail = mgr.set_dimension_value("dim_test_fail", 99.0)
    check("failed solve returns error or failed status", res_fail.get("status") in ("error", "failed", "conflict"))
    check("failed solve does not mutate dimension value to 99.0", mgr.dimensions["dim_test_fail"].get("value") != 99.0)

    # Test forced failure in solver
    from constraint_solver import ConstraintSolver, ConstraintSolve
    orig_solve_dims = ConstraintSolver.solve_dimensions
    ConstraintSolver.solve_dimensions = lambda self, axis, d, pins=None: ConstraintSolve(axis=axis, status="failed", conflicting=["forced_error"])
    res_solver_fail = mgr.set_dimension_value(dim_g3_len["id"], 99.0)
    ConstraintSolver.solve_dimensions = orig_solve_dims
    check("forced solver failure returns failed status", res_solver_fail.get("status") == "failed")
    check("forced solver failure preserves original dim value", mgr.dimensions[dim_g3_len["id"]].get("value") != 99.0)

    # 19j. M1: Valid set_dimension_value clears last_constraint_conflict
    mgr.set_dimension_value(dim_oc2["id"], 30.0)
    check("conflict populated after over-constraint", mgr.last_constraint_conflict is not None)
    mgr.set_dimension_value(dim_g3_len["id"], 14.0)
    check("valid set_dimension_value clears last_constraint_conflict to None", mgr.last_constraint_conflict is None)

    # 19k. Section 7 variations: Axis 'y' and shrink
    w_y = mgr.add_wall([0.0, 0.0, 0.0], [0.0, 10.0, 0.0], height=10.0, thickness=0.5)
    dim_y = mgr.add_dimension([
        {"kind": "wall_start", "sources": [{"element_guid": w_y["guid"], "ordinal": 0}]},
        {"kind": "wall_end", "sources": [{"element_guid": w_y["guid"], "ordinal": 0}]},
    ], axis="y")
    check("y-axis dimension initial length is 10.0", abs(mgr.resolve_dimension(dim_y["id"]) - 10.0) < 1e-4)
    mgr.set_dimension_value(dim_y["id"], 4.0, anchor="start")
    check("y-axis wall length set to 4.0 ft", abs(mgr.element_meta[w_y["guid"]]["length"] - 4.0) < 1e-4)
    check("y-axis resolve_dimension returns 4.0 ft", abs(mgr.resolve_dimension(dim_y["id"]) - 4.0) < 1e-4)

    # Shrink variation (14.0 -> 8.0 ft)
    mgr.set_dimension_value(dim_g3_len["id"], 8.0, anchor="start")
    check("wall length shrinks to 8.0 ft", abs(mgr.element_meta[w_g3["guid"]]["length"] - 8.0) < 1e-4)
    check("resolve_dimension returns 8.0 ft on shrink", abs(mgr.resolve_dimension(dim_g3_len["id"]) - 8.0) < 1e-4)

    # 19l. Lock semantics: locked dimension holds value across witness drag
    w_la = mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0])  # center x=5.0
    w_lb = mgr.add_wall([20.0, 0.0, 0.0], [20.0, 10.0, 0.0])  # center x=20.0, wall_end x=20.0
    dim_lock_drag = mgr.create_dimension(
        ref_a={"kind": "wall_start", "sources": [{"element_guid": w_la["guid"], "ordinal": 0}]},
        ref_b={"kind": "wall_end", "sources": [{"element_guid": w_lb["guid"], "ordinal": 0}]},
        axis="x",
        is_locked=True,
    )
    check("locked dimension initial value is 20.0 ft", abs(mgr.resolve_dimension(dim_lock_drag["id"]) - 20.0) < 1e-4)
    mgr.translate_element(w_la["guid"], 5.0, 0.0, 0.0)
    meas_after_drag = mgr.resolve_dimension(dim_lock_drag["id"])
    check("locked dimension held its value after drag (+5 ft)", abs(meas_after_drag - 20.0) < 1e-4)

    # 19m. H1: Kind-Pair matrix sweep across wall orientations
    # (1) x-aligned wall: face_pos <-> face_neg
    w_xmat = mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], thickness=0.5)
    dim_th = mgr.create_dimension(
        ref_a={"kind": "wall_face_pos", "sources": [{"element_guid": w_xmat["guid"], "ordinal": 0}]},
        ref_b={"kind": "wall_face_neg", "sources": [{"element_guid": w_xmat["guid"], "ordinal": 0}]},
        axis="aligned",
    )
    check("aligned thickness initial is 0.5", abs(mgr.resolve_dimension(dim_th["id"]) - 0.5) < 1e-4)
    res_th = mgr.set_dimension_value(dim_th["id"], 0.3)
    check("aligned thickness set 0.3 succeeds", res_th.get("status") == "updated")
    check("aligned thickness resolve is 0.3", abs(mgr.resolve_dimension(dim_th["id"]) - 0.3) < 1e-4)
    check("aligned thickness update leaves wall length intact at 10.0", abs(mgr.element_meta[w_xmat["guid"]]["length"] - 10.0) < 1e-4)

    # face_pos <-> face_neg on axis="x" for x-aligned wall must refuse safely
    dim_th_x = mgr.create_dimension(
        ref_a={"kind": "wall_face_pos", "sources": [{"element_guid": w_xmat["guid"], "ordinal": 0}]},
        ref_b={"kind": "wall_face_neg", "sources": [{"element_guid": w_xmat["guid"], "ordinal": 0}]},
        axis="x",
    )
    res_th_x = mgr.set_dimension_value(dim_th_x["id"], 0.3)
    check("thickness along x for x-aligned wall safely refused", res_th_x.get("status") == "failed")
    check("refused thickness does not corrupt wall length", abs(mgr.element_meta[w_xmat["guid"]]["length"] - 10.0) < 1e-4)

    # (2) diagonal wall: start <-> center on axis="x"
    w_diag = mgr.add_wall([0.0, 0.0, 0.0], [6.0, 8.0, 0.0], thickness=0.5)  # len=10, ux=0.6, uy=0.8
    dim_diag_sc = mgr.create_dimension(
        ref_a={"kind": "wall_start", "sources": [{"element_guid": w_diag["guid"], "ordinal": 0}]},
        ref_b={"kind": "wall_center", "sources": [{"element_guid": w_diag["guid"], "ordinal": 0}]},
        axis="x",
    )
    check("diagonal start<->center on x initial is 3.0", abs(mgr.resolve_dimension(dim_diag_sc["id"]) - 3.0) < 1e-4)
    res_dsc = mgr.set_dimension_value(dim_diag_sc["id"], 1.8)
    check("diagonal start<->center on x set 1.8 succeeds", res_dsc.get("status") == "updated")
    check("diagonal start<->center on x resolve is 1.8", abs(mgr.resolve_dimension(dim_diag_sc["id"]) - 1.8) < 1e-4)
    check("diagonal start<->center resizes wall to 6.0", abs(mgr.element_meta[w_diag["guid"]]["length"] - 6.0) < 1e-4)

    # (3) diagonal wall: center <-> face_pos on axis="y"
    dim_diag_cf = mgr.create_dimension(
        ref_a={"kind": "wall_center", "sources": [{"element_guid": w_diag["guid"], "ordinal": 0}]},
        ref_b={"kind": "wall_face_pos", "sources": [{"element_guid": w_diag["guid"], "ordinal": 0}]},
        axis="y",
    )
    check("diagonal center<->face_pos on y initial is 0.15", abs(mgr.resolve_dimension(dim_diag_cf["id"]) - 0.15) < 1e-4)
    res_dcf = mgr.set_dimension_value(dim_diag_cf["id"], 0.09)
    check("diagonal center<->face_pos on y set 0.09 succeeds", res_dcf.get("status") == "updated")
    check("diagonal center<->face_pos on y resolve is 0.09", abs(mgr.resolve_dimension(dim_diag_cf["id"]) - 0.09) < 1e-4)
    check("diagonal center<->face_pos leaves wall length at 6.0", abs(mgr.element_meta[w_diag["guid"]]["length"] - 6.0) < 1e-4)

    # (4) start <-> face_pos on axis="aligned"
    dim_s_fp = mgr.create_dimension(
        ref_a={"kind": "wall_start", "sources": [{"element_guid": w_xmat["guid"], "ordinal": 0}]},
        ref_b={"kind": "wall_face_pos", "sources": [{"element_guid": w_xmat["guid"], "ordinal": 0}]},
        axis="aligned",
    )
    res_s_fp = mgr.set_dimension_value(dim_s_fp["id"], 4.0)
    check("start<->face_pos aligned set 4.0 succeeds", res_s_fp.get("status") == "updated")
    check("start<->face_pos aligned resolve returns 4.0", abs(mgr.resolve_dimension(dim_s_fp["id"]) - 4.0) < 1e-4)

    # === ROUND 3 TESTS ===
    def create_test_manager():
        return BimModelManager()

    # N1: Single-axis conflict retention
    # An over-constraint on x with a clean solve on y must preserve the x conflict report
    mgr_n1 = create_test_manager()
    w_n1_a = mgr_n1.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], thickness=0.5)
    w_n1_b = mgr_n1.add_wall([20.0, 5.0, 0.0], [30.0, 5.0, 0.0], thickness=0.5)
    # Add align constraint on x between w_n1_a and w_n1_b
    mgr_n1.add_align_constraint(w_n1_a["guid"], w_n1_b["guid"], axis="x")
    # Add a conflicting locked dimension on x between them
    mgr_n1.add_dimension_lock(w_n1_a["guid"], w_n1_b["guid"], locked_distance=10.0, axis="x")
    # Move w_n1_a on x
    mgr_n1._solve_constraints_after_move(w_n1_a["guid"])
    check("N1: single-axis conflict preserved on last_constraint_conflict", mgr_n1.last_constraint_conflict is not None)
    if mgr_n1.last_constraint_conflict:
        check("N1: conflict reports axis x", mgr_n1.last_constraint_conflict.get("axis") == "x")
        check("N1: conflict status is 'conflict'", mgr_n1.last_constraint_conflict.get("status") == "conflict")

    # N2: Same-element lock does not poison multi-element scope
    mgr_n2 = create_test_manager()
    w_n2_a = mgr_n2.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], thickness=0.5)
    w_n2_b = mgr_n2.add_wall([0.0, 10.0, 0.0], [10.0, 10.0, 0.0], thickness=0.5)
    # Align w_n2_a and w_n2_b on axis x
    mgr_n2.add_align_constraint(w_n2_a["guid"], w_n2_b["guid"], axis="x")
    # Add a same-element locked dimension on w_n2_a
    dim_n2 = mgr_n2.create_dimension(
        ref_a={"kind": "wall_start", "sources": [{"element_guid": w_n2_a["guid"], "ordinal": 0}]},
        ref_b={"kind": "wall_end", "sources": [{"element_guid": w_n2_a["guid"], "ordinal": 0}]},
        axis="aligned",
        is_locked=True,
    )
    cid_n2 = dim_n2.get("constraint_id")
    check("N2: same-element lock constraint created", cid_n2 is not None and cid_n2 in mgr_n2.constraints)
    check("N2: same-element lock type is length_lock", mgr_n2.constraints[cid_n2].get("type") == "length_lock")
    # Now solve after move in multi-element scope (size 2)
    mgr_n2._solve_constraints_after_move(w_n2_a["guid"])
    check("N2: no false conflict in multi-element scope with same-element lock", mgr_n2.last_constraint_conflict is None)

    # N3: Refresh origin_distance when locked dimension target is edited
    mgr_n3 = create_test_manager()
    w_n3_a = mgr_n3.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], thickness=0.5)
    w_n3_b = mgr_n3.add_wall([20.0, 0.0, 0.0], [30.0, 0.0, 0.0], thickness=0.5)
    dim_n3 = mgr_n3.create_dimension(
        ref_a={"kind": "wall_start", "sources": [{"element_guid": w_n3_a["guid"], "ordinal": 0}]},
        ref_b={"kind": "wall_start", "sources": [{"element_guid": w_n3_b["guid"], "ordinal": 0}]},
        axis="x",
        is_locked=True,
    )
    cid_n3 = dim_n3.get("constraint_id")
    check("N3: initial locked distance is 20.0", abs(mgr_n3.constraints[cid_n3]["locked_distance"] - 20.0) < 1e-4)
    # Set locked dimension to 25.0
    res_n3 = mgr_n3.set_dimension_value(dim_n3["id"], 25.0)
    check("N3: set_dimension_value on locked dim succeeds", res_n3.get("status") == "updated")
    check("N3: stored dimension value is 25.0", abs(mgr_n3.dimensions[dim_n3["id"]]["value"] - 25.0) < 1e-4)
    measured_n3 = mgr_n3.resolve_dimension(dim_n3["id"])
    check("N3: resolve_dimension matches target 25.0", abs(measured_n3 - 25.0) < 1e-4)
    check("N3: constraint locked_distance updated to 25.0", abs(mgr_n3.constraints[cid_n3]["locked_distance"] - 25.0) < 1e-4)
    check("N3: constraint origin_distance updated to 25.0", abs(mgr_n3.constraints[cid_n3]["origin_distance"] - 25.0) < 1e-4)

    # N4: Reject axis="z" for non-level references
    mgr_n4 = create_test_manager()
    w_n4_a = mgr_n4.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], thickness=0.5)
    w_n4_b = mgr_n4.add_wall([0.0, 5.0, 0.0], [10.0, 5.0, 0.0], thickness=0.5)
    z_rejected = False
    try:
        mgr_n4.create_dimension(
            ref_a={"kind": "wall_start", "sources": [{"element_guid": w_n4_a["guid"], "ordinal": 0}]},
            ref_b={"kind": "wall_start", "sources": [{"element_guid": w_n4_b["guid"], "ordinal": 0}]},
            axis="z",
        )
    except ValueError:
        z_rejected = True
    check("N4: create_dimension rejects axis='z' for walls", z_rejected)

    # Bus rejects axis="z"
    bus_z_rejected = False
    try:
        from command_bus import DimensionCreateParams
        DimensionCreateParams(
            ref_a={"kind": "wall_start", "sources": [{"element_guid": w_n4_a["guid"], "ordinal": 0}]},
            ref_b={"kind": "wall_start", "sources": [{"element_guid": w_n4_b["guid"], "ordinal": 0}]},
            axis="z",
        )
    except Exception:
        bus_z_rejected = True
    check("N4: DimensionCreateParams rejects axis='z'", bus_z_rejected)

    # H1 Cross-Axis: x-aligned wall start<->face on axis y
    mgr_h1 = create_test_manager()
    w_h1_x = mgr_h1.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], thickness=0.5) # half-thickness = 0.25
    dim_h1_xy = mgr_h1.create_dimension(
        ref_a={"kind": "wall_start", "sources": [{"element_guid": w_h1_x["guid"], "ordinal": 0}]},
        ref_b={"kind": "wall_face_pos", "sources": [{"element_guid": w_h1_x["guid"], "ordinal": 0}]},
        axis="y",
    )
    check("H1: x-aligned start<->face_pos on y initial is 0.25", abs(mgr_h1.resolve_dimension(dim_h1_xy["id"]) - 0.25) < 1e-4)
    res_h1_xy = mgr_h1.set_dimension_value(dim_h1_xy["id"], 0.4)
    check("H1: x-aligned start<->face_pos on y set 0.4 succeeds", res_h1_xy.get("status") == "updated")
    check("H1: x-aligned start<->face_pos on y resolve returns 0.4", abs(mgr_h1.resolve_dimension(dim_h1_xy["id"]) - 0.4) < 1e-4)
    check("H1: x-aligned thickness updated to 0.8", abs(mgr_h1.element_meta[w_h1_x["guid"]]["thickness"] - 0.8) < 1e-4)
    check("H1: x-aligned wall length remains 10.0", abs(mgr_h1.element_meta[w_h1_x["guid"]]["length"] - 10.0) < 1e-4)

    # H1 Cross-Axis: y-aligned wall start<->face on axis x
    w_h1_y = mgr_h1.add_wall([0.0, 0.0, 0.0], [0.0, 10.0, 0.0], thickness=0.5)
    dim_h1_yx = mgr_h1.create_dimension(
        ref_a={"kind": "wall_start", "sources": [{"element_guid": w_h1_y["guid"], "ordinal": 0}]},
        ref_b={"kind": "wall_face_pos", "sources": [{"element_guid": w_h1_y["guid"], "ordinal": 0}]},
        axis="x",
    )
    check("H1: y-aligned start<->face_pos on x initial is 0.25", abs(mgr_h1.resolve_dimension(dim_h1_yx["id"]) - 0.25) < 1e-4)
    res_h1_yx = mgr_h1.set_dimension_value(dim_h1_yx["id"], 0.35)
    check("H1: y-aligned start<->face_pos on x set 0.35 succeeds", res_h1_yx.get("status") == "updated")
    check("H1: y-aligned start<->face_pos on x resolve returns 0.35", abs(mgr_h1.resolve_dimension(dim_h1_yx["id"]) - 0.35) < 1e-4)
    check("H1: y-aligned thickness updated to 0.7", abs(mgr_h1.element_meta[w_h1_y["guid"]]["thickness"] - 0.7) < 1e-4)
    check("H1: y-aligned wall length remains 10.0", abs(mgr_h1.element_meta[w_h1_y["guid"]]["length"] - 10.0) < 1e-4)

    # Full Matrix Sweep (§3.5): 10 pairs x 3 axes x 3 orientations
    KINDS = ["wall_start", "wall_end", "wall_center", "wall_face_pos", "wall_face_neg"]
    kind_pairs = []
    for i in range(len(KINDS)):
        for j in range(i + 1, len(KINDS)):
            kind_pairs.append((KINDS[i], KINDS[j]))

    orientations = [
        ("x_aligned", [0.0, 0.0, 0.0], [10.0, 0.0, 0.0]),
        ("y_aligned", [0.0, 0.0, 0.0], [0.0, 10.0, 0.0]),
        ("diagonal",  [0.0, 0.0, 0.0], [6.0, 8.0, 0.0]),
    ]
    axes = ["aligned", "x", "y"]

    matrix_successes = 0
    matrix_safe_refusals = 0
    matrix_corruptions = 0

    for ori_name, sp, ep in orientations:
        for ka, kb in kind_pairs:
            for ax in axes:
                sw_mgr = create_test_manager()
                w = sw_mgr.add_wall(sp, ep, thickness=0.5)
                gid = w["guid"]
                orig_len = sw_mgr.element_meta[gid]["length"]
                orig_th = sw_mgr.element_meta[gid]["thickness"]
                try:
                    d = sw_mgr.create_dimension(
                        ref_a={"kind": ka, "sources": [{"element_guid": gid, "ordinal": 0}]},
                        ref_b={"kind": kb, "sources": [{"element_guid": gid, "ordinal": 0}]},
                        axis=ax,
                    )
                except Exception:
                    continue

                cur_val = sw_mgr.resolve_dimension(d["id"])
                if cur_val is None or cur_val < 1e-3:
                    # Degenerate zero distance
                    continue

                target = cur_val * 1.2
                res = sw_mgr.set_dimension_value(d["id"], target)
                if res.get("status") == "updated":
                    new_val = sw_mgr.resolve_dimension(d["id"])
                    if new_val is not None and abs(new_val - target) < 1e-3:
                        matrix_successes += 1
                    else:
                        matrix_corruptions += 1
                elif res.get("status") in ("failed", "error"):
                    # Safe refusal: verify geometry untouched
                    cur_len = sw_mgr.element_meta[gid]["length"]
                    cur_th = sw_mgr.element_meta[gid]["thickness"]
                    if abs(cur_len - orig_len) < 1e-4 and abs(cur_th - orig_th) < 1e-4:
                        matrix_safe_refusals += 1
                    else:
                        matrix_corruptions += 1

    check("Matrix sweep: zero corruptions across all combinations", matrix_corruptions == 0)
    check("Matrix sweep: 78/78 non-degenerate combinations round-trip", matrix_successes == 78)

    # 19n. length_lock enforcement: an intra-element lock restores the element after an edit.
    # The element-node solver cannot express an intra-element distance, so these locks are
    # enforced by BimModelManager._enforce_length_locks. The case that matters is an edit
    # that does NOT go through the dimension: without enforcement the lock is inert.
    lk_mgr = BimModelManager()
    lk_guid = lk_mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], height=10.0, thickness=0.5)["guid"]
    lk_dim = lk_mgr.add_dimension([
        {"kind": "wall_start", "sources": [{"element_guid": lk_guid, "ordinal": 0}]},
        {"kind": "wall_end", "sources": [{"element_guid": lk_guid, "ordinal": 0}]},
    ], axis="x", is_locked=True)
    lk_cid = lk_dim.get("constraint_id")
    check("intra-element lock records a length_lock constraint",
          lk_cid is not None and lk_mgr.constraints.get(lk_cid, {}).get("type") == "length_lock",
          lk_mgr.constraints.get(lk_cid, {}).get("type"))
    check("length lock starts at 10.0 ft", abs(lk_mgr.element_meta[lk_guid]["length"] - 10.0) < 1e-4)

    # (a) an unrelated edit through update_element must be pulled back
    lk_res = lk_mgr.update_element(lk_guid, {"end": [18.0, 0.0, 0.0]})
    check("lock restores the length after update_element stretches the wall",
          abs(lk_mgr.element_meta[lk_guid]["length"] - 10.0) < 1e-4,
          f"length became {lk_mgr.element_meta[lk_guid]['length']}")
    check("the restored length is what the edit reports back",
          abs(float(lk_res.get("length", 0.0)) - 10.0) < 1e-4, f"reported {lk_res.get('length')}")

    # (b) the same through move_reference, which is the driver the dimension path uses
    lk_mgr.move_reference(
        {"kind": "wall_end", "sources": [{"element_guid": lk_guid, "ordinal": 0}]}, "x", 25.0)
    check("lock restores the length after move_reference moves a locked reference",
          abs(lk_mgr.element_meta[lk_guid]["length"] - 10.0) < 1e-4,
          f"length became {lk_mgr.element_meta[lk_guid]['length']}")

    # (c) a thickness lock holds the thickness and leaves the length alone
    th_mgr = BimModelManager()
    th_guid = th_mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], height=10.0, thickness=0.5)["guid"]
    th_mgr.add_dimension([
        {"kind": "wall_face_pos", "sources": [{"element_guid": th_guid, "ordinal": 0}]},
        {"kind": "wall_face_neg", "sources": [{"element_guid": th_guid, "ordinal": 0}]},
    ], axis="aligned", is_locked=True)
    th_mgr.update_element(th_guid, {"thickness": 1.2})
    check("thickness lock restores the thickness",
          abs(th_mgr.element_meta[th_guid]["thickness"] - 0.5) < 1e-4,
          f"thickness became {th_mgr.element_meta[th_guid]['thickness']}")
    check("thickness lock leaves the length alone",
          abs(th_mgr.element_meta[th_guid]["length"] - 10.0) < 1e-4)

    # (d) control: with no lock the edit must stand (the pass must not fight ordinary edits)
    free_mgr = BimModelManager()
    free_guid = free_mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], height=10.0, thickness=0.5)["guid"]
    free_mgr.add_dimension([
        {"kind": "wall_start", "sources": [{"element_guid": free_guid, "ordinal": 0}]},
        {"kind": "wall_end", "sources": [{"element_guid": free_guid, "ordinal": 0}]},
    ], axis="x")  # deliberately NOT locked
    free_mgr.update_element(free_guid, {"end": [18.0, 0.0, 0.0]})
    check("an unlocked dimension does not fight an edit",
          abs(free_mgr.element_meta[free_guid]["length"] - 18.0) < 1e-4,
          f"length became {free_mgr.element_meta[free_guid]['length']}")

    # (e) an edit that does not touch the locked quantity must not churn revisions
    rev_before = lk_mgr.project_rev
    lk_mgr.update_element(lk_guid, {"height": 12.0})
    check("an edit clear of the locked quantity does not re-drive the lock",
          lk_mgr.project_rev == rev_before, f"project_rev moved by {lk_mgr.project_rev - rev_before}")

    # (f) locks on independent degrees of freedom both hold and are not a conflict
    ind_mgr = BimModelManager()
    ind_guid = ind_mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], height=10.0, thickness=0.5)["guid"]
    ind_mgr.add_dimension([
        {"kind": "wall_start", "sources": [{"element_guid": ind_guid, "ordinal": 0}]},
        {"kind": "wall_end", "sources": [{"element_guid": ind_guid, "ordinal": 0}]},
    ], axis="x", is_locked=True)
    ind_mgr.add_dimension([
        {"kind": "wall_face_pos", "sources": [{"element_guid": ind_guid, "ordinal": 0}]},
        {"kind": "wall_face_neg", "sources": [{"element_guid": ind_guid, "ordinal": 0}]},
    ], axis="aligned", is_locked=True)
    ind_mgr.last_constraint_conflict = None
    ind_mgr.update_element(ind_guid, {"end": [18.0, 0.0, 0.0], "thickness": 1.2})
    check("a length lock and a thickness lock on one element both hold",
          abs(ind_mgr.element_meta[ind_guid]["length"] - 10.0) < 1e-4
          and abs(ind_mgr.element_meta[ind_guid]["thickness"] - 0.5) < 1e-4,
          f"length {ind_mgr.element_meta[ind_guid]['length']}, "
          f"thickness {ind_mgr.element_meta[ind_guid]['thickness']}")
    check("independent locks are not reported as a conflict",
          ind_mgr.last_constraint_conflict is None, str(ind_mgr.last_constraint_conflict))

    # (g) two locks disagreeing on the SAME degree of freedom are reported, not fought
    oc_mgr = BimModelManager()
    oc_guid = oc_mgr.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], height=10.0, thickness=0.5)["guid"]
    oc_full = oc_mgr.add_dimension([
        {"kind": "wall_start", "sources": [{"element_guid": oc_guid, "ordinal": 0}]},
        {"kind": "wall_end", "sources": [{"element_guid": oc_guid, "ordinal": 0}]},
    ], axis="x", is_locked=True)
    oc_half = oc_mgr.add_dimension([
        {"kind": "wall_start", "sources": [{"element_guid": oc_guid, "ordinal": 0}]},
        {"kind": "wall_center", "sources": [{"element_guid": oc_guid, "ordinal": 0}]},
    ], axis="x", is_locked=True)
    oc_mgr.set_dimension_value(oc_half["id"], 6.0)   # implies a 12 ft wall, against the 10 ft lock
    oc_mgr.last_constraint_conflict = None
    oc_mgr.update_element(oc_guid, {"end": [20.0, 0.0, 0.0]})
    oc_conflict = oc_mgr.last_constraint_conflict or {}
    oc_unsatisfied = [
        d["id"] for d in (oc_full, oc_half)
        if not abs(oc_mgr.dimensions[d["id"]]["value"] - (oc_mgr.resolve_dimension(d["id"]) or 0.0)) < 1e-4
    ]
    check("disagreeing same-element locks report a conflict", oc_conflict.get("status") == "conflict",
          str(oc_conflict))
    check("the conflict names exactly the locks the model cannot satisfy",
          bool(oc_unsatisfied) and set(oc_conflict.get("dimensions", [])) == set(oc_unsatisfied),
          f"reported {oc_conflict.get('dimensions')}, unsatisfied {oc_unsatisfied}")
    check("a disputed lock does not oscillate the geometry",
          min(abs(oc_mgr.element_meta[oc_guid]["length"] - v) for v in (10.0, 12.0)) < 1e-4,
          f"length {oc_mgr.element_meta[oc_guid]['length']}")

    print(f"\nRESULTS: {passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)

if __name__ == "__main__":
    run_tests()


