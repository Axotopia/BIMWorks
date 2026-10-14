"""
Test script for GLM Master Spec v2 implementation:
- .bimworks Hybrid Container export & load
- Wall Join policy setting
- CommandBus schema export & transaction execution (Tier 0)
- 6-foot wall rule verification
"""

import sys
import os

# Add backend to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from ifc_service import bim_manager
from command_bus import command_bus, CommandRequest

def test_v2_core():
    print("1. Testing clean model setup...")
    bim_manager.reset_model()
    assert len(bim_manager.element_meta) == 0

    print("2. Testing CommandBus execution (WallCreate, DoorInsert)...")
    # Wall 1: 10 ft long, 10 ft high
    res_w1 = command_bus.execute_single_command("WallCreate", {
        "start": [0.0, 0.0, 0.0],
        "end": [10.0, 0.0, 0.0],
        "height": 10.0,
        "thickness": 0.8333,
        "name": 'Basic Wall : Exterior - 10" CMU',
    })
    w1_guid = res_w1["guid"]
    assert w1_guid in bim_manager.element_meta

    # Wall 2: short wall (4 ft < 6 ft) to test the 6-foot Revit view range rule
    # (internal unit is decimal feet since P2)
    res_w2 = command_bus.execute_single_command("WallCreate", {
        "start": [10.0, 0.0, 0.0],
        "end": [10.0, 5.0, 0.0],
        "height": 4.0,          # < 6 ft: must not be cut
        "thickness": 0.6667,
        "name": 'Basic Wall : 4" Partition Low',
    })
    w2_guid = res_w2["guid"]

    # Wall joins
    print("3. Testing Wall Joins...")
    bim_manager.set_wall_join(w1_guid, end_index=1, allow_join=True, mode="butt")
    bim_manager.set_wall_join(w2_guid, end_index=0, allow_join=True, mode="butt")
    joins = bim_manager.get_wall_joins()
    assert joins[w1_guid]["end1"]["mode"] == "butt"

    # Testing 2D slicing for 6-foot rule
    print("4. Testing 2D slicing and 6-foot wall view range rule...")
    slice_data = bim_manager.slice_2d_vector_plan(cut_elevation=1.2)
    # Wall 1 (10 ft >= 6 ft) should be in cut_paths
    cut_guids = [p["guid"] for p in slice_data["cut_paths"]]
    # Wall 2 (4 ft < 6 ft) should be in projection_paths
    proj_guids = [p["guid"] for p in slice_data["projection_paths"]]
    assert w1_guid in cut_guids, f"Wall 1 should be cut, found in: {cut_guids}"
    assert w2_guid in proj_guids, f"Wall 2 (low wall < 6ft) should be in projection_paths, found in: {proj_guids}"
    print("   -> Slicing verified: Wall 1 is .cut, Wall 2 is .projection (< 6ft)!")

    # Test Transaction Execution & AI Origin
    print("5. Testing Transaction batching with AI origin...")
    tx_res = command_bus.execute_transaction([
        CommandRequest(
            command="DoorInsert",
            params={
                "host_wall_guid": w1_guid,
                "offset_along_wall": 8.0,
                "width": 3.0,
                "height": 7.0,
                "name": 'Single Flush : 36" x 84"',
            },
            origin="ai",
        )
    ], origin="ai", description="AI Plan: Insert exterior entrance door")
    assert tx_res["status"] == "committed"
    assert tx_res["origin"] == "ai"

    # Test .bimworks Hybrid Container export and reload
    print("6. Testing .bimworks Hybrid Container export & round-trip reload...")
    project_path = bim_manager.save_orlt_project()
    assert os.path.exists(project_path)
    assert project_path.endswith(".bimworks"), f"expected .bimworks, got {project_path}"
    file_size = os.path.getsize(project_path)
    print(f"   -> .bimworks exported successfully ({file_size} bytes)")

    # Read bytes and reload
    with open(project_path, "rb") as f:
        project_bytes = f.read()
    
    # Reset model to empty
    bim_manager.reset_model()
    assert len(bim_manager.element_meta) == 0

    # Load .bimworks
    load_res = bim_manager.load_orlt_project(project_bytes, "TestProject.bimworks")
    assert load_res["status"] == "loaded"
    assert len(bim_manager.element_meta) >= 2
    assert w1_guid in bim_manager.element_meta
    print("   -> .bimworks reloaded successfully! Elements restored:", len(bim_manager.element_meta))

    # Legacy `.orlt` container name must still load (pre-rename projects)
    bim_manager.reset_model()
    legacy_res = bim_manager.load_orlt_project(project_bytes, "TestProject.orlt")
    assert legacy_res["status"] == "loaded"
    assert w1_guid in bim_manager.element_meta
    print("   -> legacy .orlt filename alias still loads (backward compatible)")

    print("7. Testing Command Schema Export...")
    schemas = command_bus.get_schemas()
    assert "WallCreate" in schemas["commands"]
    assert "DoorInsert" in schemas["commands"]
    print(f"   -> Exported {len(schemas['commands'])} typed command schemas (JSON Schema 2020-12)")

    print("\nALL V2 CORE TESTS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    test_v2_core()
