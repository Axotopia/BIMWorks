import sys, os
sys.path.insert(0, os.path.abspath('backend'))

from ifc_service import bim_manager
from command_bus import command_bus, CommandRequest

def test_sketch_mode_backend():
    print("1. Resetting model...")
    bim_manager.reset_model()
    
    print("2. Creating L-shaped slab via SlabCreate command...")
    l_polygon = [
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 5.0],
        [5.0, 5.0],
        [5.0, 10.0],
        [0.0, 10.0]
    ]
    res_slab = command_bus.execute_single_command("SlabCreate", {
        "polygon": l_polygon,
        "thickness": 0.25,
        "elevation": 0.0,
        "name": "Floor : 10\" Concrete Slab"
    })
    assert res_slab["status"] == "created"
    slab_guid = res_slab["guid"]
    
    # Verify 3D mesh was built and is non-empty
    geom = bim_manager.get_geometry_buffers()
    slab_mesh = next(m for m in geom["meshes"] if m["guid"] == slab_guid)
    assert len(slab_mesh["vertices"]) > 0
    assert len(slab_mesh["indices"]) > 0
    print(f"   -> Slab created: {len(slab_mesh['vertices'])//3} verts, {len(slab_mesh['indices'])//3} tris")
    
    print("3. Updating slab boundary via ElementUpdate inside an atomic transaction...")
    updated_polygon = [
        [0.0, 0.0],
        [12.0, 0.0],
        [12.0, 8.0],
        [0.0, 8.0]
    ]
    tx_res = command_bus.execute_transaction([
        CommandRequest(
            command="ElementUpdate",
            params={
                "guid": slab_guid,
                "updates": {
                    "polygon": updated_polygon,
                    "thickness": 0.3
                }
            }
        )
    ], origin="ui", description="Edit Floor Boundary")
    assert tx_res["status"] == "committed"
    
    # Check updated polygon and mesh
    meta = bim_manager.element_meta[slab_guid]
    assert len(meta["polygon"]) == 4
    assert meta["thickness"] == 0.3
    geom2 = bim_manager.get_geometry_buffers()
    slab_mesh2 = next(m for m in geom2["meshes"] if m["guid"] == slab_guid)
    assert slab_mesh2["bbox"]["max"][0] == 12.0
    print("   -> Slab updated boundary successfully!")
    
    print("4. Testing undo of boundary edit...")
    undo_res = command_bus.undo()
    assert undo_res["status"] == "undone"
    meta_undone = bim_manager.element_meta[slab_guid]
    assert len(meta_undone["polygon"]) == 6 # back to L-shape
    print("   -> Undo restored pre-sketch L-shape polygon!")
    
    print("5. Testing redo of boundary edit...")
    redo_res = command_bus.redo()
    assert redo_res["status"] == "redone"
    meta_redone = bim_manager.element_meta[slab_guid]
    assert len(meta_redone["polygon"]) == 4
    print("   -> Redo restored updated boundary!")
    
    print("6. Testing 2D plan slice generation with edited boundary...")
    slice_2d = bim_manager.slice_2d_vector_plan(1.2)
    assert any(s["guid"] == slab_guid for s in slice_2d["slabs"])
    print("   -> 2D slice rendered slab polygon correctly!")

    print("\nALL SKETCH MODE BACKEND TESTS PASSED!")

if __name__ == "__main__":
    test_sketch_mode_backend()
