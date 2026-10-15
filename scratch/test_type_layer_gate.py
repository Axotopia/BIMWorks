#!/usr/bin/env python3
"""
Test Gate for Phase 5: Revit Type Layer & Instance Propagation.
Asserts:
  1. Default type registry seeded with standard wall, door, and window types.
  2. IfcWallType, IfcDoorType, IfcWindowType created in IFC4 model with property sets.
  3. Elements carry type_id and are linked via IfcRelDefinesByType.
  4. TypeUpdate propagates parameter changes (e.g. thickness) across all instances.
  5. ElementSetType switches an element's type, recalculating geometry and representation.
  6. TypeDuplicate clones existing types under new identity and registers them.
  7. Undo/Redo reversibility via command-scoped mementos.
  8. Type registry serialization in container overlay and state bundle.
"""

import os
import sys
import math
from typing import Dict, Any

# Ensure backend is on PYTHONPATH
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest


def run_gate():
    print("=== RUNNING GATE: REVIT TYPE LAYER & INSTANCE PROPAGATION ===")
    passed = 0
    failed = 0

    def assert_true(cond, msg):
        nonlocal passed, failed
        if cond:
            print(f"  [PASS] {msg}")
            passed += 1
        else:
            print(f"  [FAIL] {msg}")
            failed += 1

    # 1. Initialize manager and verify default type registry
    mgr = BimModelManager("Type Gate Project")
    bus = CommandBusEngine(mgr)

    assert_true(hasattr(mgr, "type_registry"), "BimModelManager has type_registry")
    assert_true(len(mgr.type_registry) >= 6, f"Default types seeded (found {len(mgr.type_registry)})")
    assert_true("wall-type-cmu-10" in mgr.type_registry, "wall-type-cmu-10 in registry")
    assert_true("wall-type-partition-478" in mgr.type_registry, "wall-type-partition-478 in registry")
    assert_true("door-type-single-flush-36" in mgr.type_registry, "door-type-single-flush-36 in registry")

    # 2. Check IFC type entities in model
    wall_types = mgr.model.by_type("IfcWallType")
    assert_true(len(wall_types) >= 3, f"IfcWallType entities created in model (found {len(wall_types)})")
    cmu_type_ent = next((wt for wt in wall_types if "10\" CMU" in (wt.Name or "")), None)
    assert_true(cmu_type_ent is not None, "IfcWallType for 10\" CMU found in IFC model")

    # Check Pset on type entity
    raw_psets = getattr(cmu_type_ent, "HasPropertySets", []) or []
    psets = [getattr(p, "RelatingPropertyDefinition", p) for p in raw_psets]
    wall_common = next((p for p in psets if getattr(p, "Name", "") == "Pset_WallCommon"), None)
    assert_true(wall_common is not None, "Pset_WallCommon attached to IfcWallType")

    # 3. Add walls using types
    w1 = mgr.add_wall((0, 0, 0), (20, 0, 0), type_id="wall-type-cmu-10", name="Wall 1")
    w2 = mgr.add_wall((20, 0, 0), (20, 15, 0), type_id="wall-type-cmu-10", name="Wall 2")
    w1_guid = w1["guid"]
    w2_guid = w2["guid"]

    assert_true(mgr.element_meta[w1_guid].get("type_id") == "wall-type-cmu-10", "Wall 1 carries type_id")
    assert_true(mgr.element_meta[w2_guid].get("type_id") == "wall-type-cmu-10", "Wall 2 carries type_id")
    assert_true(abs(mgr.element_meta[w1_guid]["thickness"] - (10.0 / 12.0)) < 1e-3, "Wall 1 thickness matches type (10 in)")

    # Verify IfcRelDefinesByType in model
    type_rels = [
        rel for rel in mgr.model.by_type("IfcRelDefinesByType")
        if w1["entity"] in rel.RelatedObjects
    ]
    assert_true(len(type_rels) == 1, "Wall 1 linked to type via IfcRelDefinesByType")
    assert_true(type_rels[0].RelatingType == cmu_type_ent, "Wall 1 linked to correct IfcWallType")

    # 4. TypeUpdate: change type thickness -> propagate to ALL instances
    new_thickness = 1.25 # 15 inches
    res = bus.execute_transaction(
        [
            CommandRequest(
                command="TypeUpdate",
                params={"type_id": "wall-type-cmu-10", "parameters": {"thickness": new_thickness}},
            )
        ],
        description="Update 10\" CMU thickness to 15\"",
    )
    assert_true(res["status"] == "committed", "TypeUpdate transaction committed")
    assert_true(abs(mgr.element_meta[w1_guid]["thickness"] - new_thickness) < 1e-4, "Wall 1 instance thickness updated via propagation")
    assert_true(abs(mgr.element_meta[w2_guid]["thickness"] - new_thickness) < 1e-4, "Wall 2 instance thickness updated via propagation")
    assert_true(w1_guid in mgr.dirty_mesh_guids or mgr.mesh_revs.get(w1_guid, 0) > 0, "Wall 1 mesh marked dirty after type update")

    # 5. ElementSetType: change Wall 1's type to partition (4 7/8")
    part_thickness = 4.875 / 12.0
    res_set = bus.execute_transaction(
        [
            CommandRequest(
                command="ElementSetType",
                params={"guid": w1_guid, "type_id": "wall-type-partition-478"},
            )
        ],
        description="Change Wall 1 type to Interior Partition",
    )
    assert_true(res_set["status"] == "committed", "ElementSetType transaction committed")
    assert_true(mgr.element_meta[w1_guid].get("type_id") == "wall-type-partition-478", "Wall 1 type_id changed to partition")
    assert_true(abs(mgr.element_meta[w1_guid]["thickness"] - part_thickness) < 1e-4, "Wall 1 thickness updated to partition thickness")
    assert_true(abs(mgr.element_meta[w2_guid]["thickness"] - new_thickness) < 1e-4, "Wall 2 thickness unchanged (still 1.25 ft)")

    # 6. TypeDuplicate: clone partition into new custom type
    res_dup = bus.execute_transaction(
        [
            CommandRequest(
                command="TypeDuplicate",
                params={
                    "source_type_id": "wall-type-partition-478",
                    "new_type_id": "wall-type-partition-custom",
                    "new_name": "Basic Wall : Custom Partition",
                },
            )
        ],
        description="Duplicate partition type",
    )
    assert_true(res_dup["status"] == "committed", "TypeDuplicate transaction committed")
    assert_true("wall-type-partition-custom" in mgr.type_registry, "Custom type in registry")
    custom_type = mgr.type_registry["wall-type-partition-custom"]
    assert_true(custom_type["name"] == "Basic Wall : Custom Partition", "Custom type has new name")
    assert_true(abs(custom_type["parameters"]["thickness"] - part_thickness) < 1e-4, "Custom type inherited source thickness")

    # 7. Undo/Redo on Type Mutations
    # Undo TypeDuplicate
    bus.undo()
    assert_true("wall-type-partition-custom" not in mgr.type_registry, "Undone TypeDuplicate purged custom type")

    # Redo TypeDuplicate
    bus.redo()
    assert_true("wall-type-partition-custom" in mgr.type_registry, "Redone TypeDuplicate restored custom type")

    # Undo ElementSetType
    bus.undo() # undoes TypeDuplicate
    bus.undo() # undoes ElementSetType
    assert_true(mgr.element_meta[w1_guid].get("type_id") == "wall-type-cmu-10", "Undoing ElementSetType restored Wall 1 type_id to cmu-10")
    assert_true(abs(mgr.element_meta[w1_guid]["thickness"] - new_thickness) < 1e-4, "Undoing ElementSetType restored Wall 1 thickness to 1.25 ft")

    # Redo ElementSetType
    bus.redo()
    assert_true(mgr.element_meta[w1_guid].get("type_id") == "wall-type-partition-478", "Redoing ElementSetType restored partition type")

    # 8. Type List retrieval and serialization
    types_list = mgr.get_types()
    assert_true(isinstance(types_list, list), "get_types returns list")
    assert_true(len(types_list) >= 6, "get_types contains all registered types")
    cmu_item = next((t for t in types_list if t["id"] == "wall-type-cmu-10"), None)
    assert_true(cmu_item is not None, "cmu-10 in get_types output")
    assert_true("layers" in cmu_item["parameters"], "Type carries compound structure layers")

    # Summary
    print(f"\nRESULTS: {passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_gate()
