"""
Test script for GLM Master Spec v2 implementation:
- .orlt Hybrid Container export & load
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
    # Wall 1: 10m long, 3.0m high
    res_w1 = command_bus.execute_single_command("WallCreate", {
        "start": [0.0, 0.0, 0.0],
        "end": [10.0, 0.0, 0.0],
        "height": 3.0,
        "thickness": 0.25,
        "name": 'Basic Wall : Exterior - 10" CMU',
    })
    w1_guid = res_w1["guid"]
    assert w1_guid in bim_manager.element_meta

    # Wall 2: Short wall (1.5m < 1.8288m / 6ft) to test 6-foot Revit view range rule
    res_w2 = command_bus.execute_single_command("WallCreate", {
        "start": [10.0, 0.0, 0.0],
        "end": [10.0, 5.0, 0.0],
        "height": 1.5,
        "thickness": 0.2,
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
    # Wall 1 (3m >= 1.8288m) should be in cut_paths
    cut_guids = [p["guid"] for p in slice_data["cut_paths"]]
    # Wall 2 (1.5m < 1.8288m) should be in projection_paths
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
                "offset_along_wall": 3.0,
                "width": 1.0,
                "height": 2.1,
                "name": 'Single Flush : 36" x 84"',
            },
            origin="ai",
        )
    ], origin="ai", description="AI Plan: Insert exterior entrance door")
    assert tx_res["status"] == "committed"
    assert tx_res["origin"] == "ai"

    # Test .orlt Hybrid Container export and reload
    print("6. Testing .orlt Hybrid Container export & round-trip reload...")
    orlt_path = bim_manager.save_orlt_project()
    assert os.path.exists(orlt_path)
    assert orlt_path.endswith(".orlt")
    file_size = os.path.getsize(orlt_path)
    print(f"   -> .orlt exported successfully ({file_size} bytes)")

    # Read bytes and reload
    with open(orlt_path, "rb") as f:
        orlt_bytes = f.read()
    
    # Reset model to empty
    bim_manager.reset_model()
    assert len(bim_manager.element_meta) == 0

    # Load .orlt
    load_res = bim_manager.load_orlt_project(orlt_bytes, "TestProject.orlt")
    assert load_res["status"] == "loaded"
    assert len(bim_manager.element_meta) >= 2
    assert w1_guid in bim_manager.element_meta
    print("   -> .orlt reloaded successfully! Elements restored:", len(bim_manager.element_meta))

    print("7. Testing Command Schema Export...")
    schemas = command_bus.get_schemas()
    assert "WallCreate" in schemas["commands"]
    assert "DoorInsert" in schemas["commands"]
    print(f"   -> Exported {len(schemas['commands'])} typed command schemas (JSON Schema 2020-12)")

    print("\nALL V2 CORE TESTS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    test_v2_core()
