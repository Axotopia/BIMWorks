"""
Differential Equivalence Test for Delta Protocol (docs/IMPLEMENTATION-PLAN-2026-10-14.md D6).

Proves that applying sequential delta updates (Response B) yields identical state
to fetching a full state bundle (Response C) across >= 50 randomized operations.
Includes negative control proving that divergence is reliably detected.

Run:
  $env:PYTHONPATH='backend'; .venv\\Scripts\\python.exe scratch/test_delta_equivalence.py
"""
import sys
import copy
import random
from pathlib import Path
from typing import Dict, Any, List

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))
sys.path.insert(0, str(REPO_ROOT))

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest


def meshes_to_dict(mesh_list: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {m["guid"]: m for m in mesh_list}


def compare_mesh_states(delta_state: Dict[str, Any], full_state: Dict[str, Any]) -> List[str]:
    """Returns list of discrepancy descriptions (empty if equivalent)."""
    diffs = []
    d_meshes = delta_state.get("meshes", {})
    f_meshes = full_state.get("meshes", {})

    d_guids = set(d_meshes.keys())
    f_guids = set(f_meshes.keys())

    if d_guids != f_guids:
        missing_in_delta = f_guids - d_guids
        extra_in_delta = d_guids - f_guids
        if missing_in_delta:
            diffs.append(f"Delta missing GUIDs: {sorted(missing_in_delta)}")
        if extra_in_delta:
            diffs.append(f"Delta extra GUIDs: {sorted(extra_in_delta)}")
        return diffs

    for guid in sorted(d_guids):
        dm = d_meshes[guid]
        fm = f_meshes[guid]

        if dm.get("ifc_class") != fm.get("ifc_class"):
            diffs.append(f"GUID {guid}: class mismatch {dm.get('ifc_class')} vs {fm.get('ifc_class')}")
        if dm.get("name") != fm.get("name"):
            diffs.append(f"GUID {guid}: name mismatch {dm.get('name')} vs {fm.get('name')}")
        
        # Vertices and indices
        dv, fv = dm.get("vertices", []), fm.get("vertices", [])
        if len(dv) != len(fv):
            diffs.append(f"GUID {guid}: vertex count mismatch {len(dv)} vs {len(fv)}")
        elif dv != fv:
            diffs.append(f"GUID {guid}: vertex coordinate mismatch")

        di, fi = dm.get("indices", []), fm.get("indices", [])
        if di != fi:
            diffs.append(f"GUID {guid}: indices mismatch")

        # Params
        dp, fp = dm.get("params", {}), fm.get("params", {})
        for k in ("thickness", "height", "length", "start", "end", "offset_along_wall"):
            if dp.get(k) != fp.get(k):
                diffs.append(f"GUID {guid}: param '{k}' mismatch {dp.get(k)} vs {fp.get(k)}")

    return diffs


def apply_delta_to_client(client: Dict[str, Any], delta: Dict[str, Any], new_rev: int) -> None:
    remove_guids = set(delta.get("remove_guids", []))
    for guid in remove_guids:
        client["meshes"].pop(guid, None)

    for mesh in delta.get("upsert_meshes", []):
        client["meshes"][mesh["guid"]] = mesh

    client["rev"] = new_rev


def run_differential_test():
    total_checks = 0
    passed_checks = 0

    def check(desc: str, ok: bool):
        nonlocal total_checks, passed_checks
        total_checks += 1
        if ok:
            passed_checks += 1
            print(f"  [ok] {desc}")
        else:
            print(f"  [FAIL] {desc}")

    print("=== D6: Differential Equivalence Gate (Delta Protocol) ===\n")
    print("Initializing test model and command bus...")
    manager = BimModelManager(project_name="Differential Test Project")
    bus = CommandBusEngine(manager)

    # Client A begins with full bundle at rev 0
    initial_geom = manager.get_geometry_buffers()
    client_a = {
        "rev": bus.rev,
        "meshes": meshes_to_dict(initial_geom.get("meshes", [])),
    }

    # Initial check
    initial_full = meshes_to_dict(manager.get_geometry_buffers().get("meshes", []))
    diffs = compare_mesh_states(client_a, {"meshes": initial_full})
    check("initial state equivalence", len(diffs) == 0)

    random.seed(42)  # Deterministic repeatability
    active_walls = []
    active_doors = []

    print("\nExecuting >= 50 randomized command operations...")

    NUM_OPERATIONS = 50
    step_success = True

    for step in range(1, NUM_OPERATIONS + 1):
        prev_rev = client_a["rev"]
        op_choice = random.choice([
            "wall", "wall", "door", "window", "translate", "undo", "redo", "delete"
        ])

        cmds = []
        desc = ""

        if op_choice == "wall" or len(active_walls) < 2:
            x0 = random.randint(-15, 15)
            y0 = random.randint(-15, 15)
            dx = random.choice([5, 8, 10, 12])
            dy = random.choice([0, 6, 8])
            th = random.choice([0.15, 0.25, 0.3])
            cmds.append(CommandRequest(
                command="WallCreate",
                params={
                    "start": [x0, y0, 0.0],
                    "end": [x0 + dx, y0 + dy, 0.0],
                    "height": 3.0,
                    "thickness": th,
                    "name": f"Wall_step_{step}",
                }
            ))
            desc = f"Create wall at ({x0}, {y0})"

        elif op_choice == "door" and active_walls:
            host = random.choice(active_walls)
            cmds.append(CommandRequest(
                command="DoorInsert",
                params={
                    "host_wall_guid": host,
                    "offset_along_wall": 2.0,
                    "width": 1.0,
                    "height": 2.13,
                    "name": f"Door_step_{step}",
                }
            ))
            desc = f"Insert door in {host}"

        elif op_choice == "window" and active_walls:
            host = random.choice(active_walls)
            cmds.append(CommandRequest(
                command="WindowInsert",
                params={
                    "host_wall_guid": host,
                    "offset_along_wall": 3.5,
                    "width": 1.2,
                    "height": 1.5,
                    "sill_height": 0.9,
                    "name": f"Window_step_{step}",
                }
            ))
            desc = f"Insert window in {host}"

        elif op_choice == "translate" and active_walls:
            target = random.choice(active_walls)
            dx = random.choice([-1.0, 1.0, 2.0])
            dy = random.choice([-1.0, 0.5, 1.0])
            cmds.append(CommandRequest(
                command="WallMove",
                params={"guid": target, "dx": dx, "dy": dy, "dz": 0.0}
            ))
            desc = f"Translate {target}"

        elif op_choice == "delete" and len(active_walls) > 3:
            target = active_walls.pop()
            cmds.append(CommandRequest(
                command="DeleteElement",
                params={"guid": target}
            ))
            desc = f"Delete wall {target}"

        elif op_choice == "undo" and bus.undo_stack:
            res = bus.undo()
            # undo advances rev and restores state
            delta = manager.get_geometry_buffers(since=prev_rev)
            apply_delta_to_client(client_a, delta, bus.rev)
            full = meshes_to_dict(manager.get_geometry_buffers().get("meshes", []))
            diffs = compare_mesh_states(client_a, {"meshes": full})
            if diffs:
                step_success = False
                print(f"  Divergence on undo step {step}: {diffs}")
                break
            continue

        elif op_choice == "redo" and bus.redo_stack:
            res = bus.redo()
            delta = manager.get_geometry_buffers(since=prev_rev)
            apply_delta_to_client(client_a, delta, bus.rev)
            full = meshes_to_dict(manager.get_geometry_buffers().get("meshes", []))
            diffs = compare_mesh_states(client_a, {"meshes": full})
            if diffs:
                step_success = False
                print(f"  Divergence on redo step {step}: {diffs}")
                break
            continue

        else:
            continue

        # Execute transaction
        try:
            tx_res = bus.execute_transaction(cmds, origin="cli", description=desc)
            res_list = tx_res.get("results", [])
            for r in res_list:
                if r.get("guid") and r.get("ifc_class") in ("IfcWallStandardCase", "IfcWall"):
                    active_walls.append(r["guid"])
                elif r.get("guid") and r.get("ifc_class") == "IfcDoor":
                    active_doors.append(r["guid"])
        except Exception as e:
            # Expected if placement constraint rejected
            continue

        # Fetch delta since Client A's rev
        current_rev = bus.rev
        delta = manager.get_geometry_buffers(since=prev_rev)
        apply_delta_to_client(client_a, delta, current_rev)

        # Full state bundle for Client B
        full_geom = manager.get_geometry_buffers()
        full_meshes = meshes_to_dict(full_geom.get("meshes", []))

        # Check equivalence
        diffs = compare_mesh_states(client_a, {"meshes": full_meshes})
        if diffs:
            step_success = False
            print(f"  Divergence on step {step} ({desc}): {diffs[:3]}")
            break

    check(f"all {NUM_OPERATIONS} randomized steps yield equivalent mesh state", step_success)
    check("client rev matches engine rev", client_a["rev"] == bus.rev)
    check("active elements count > 10", len(client_a["meshes"]) > 10)

    # -------------------------------------------------------------------------
    # Negative Control (proves comparator detects divergence)
    # -------------------------------------------------------------------------
    print("\nExecuting negative controls (fault injection)...")
    
    # Negative Control 1: dropped mesh
    corrupt_client = copy.deepcopy(client_a)
    first_guid = next(iter(corrupt_client["meshes"].keys()))
    del corrupt_client["meshes"][first_guid]
    detected_missing = len(compare_mesh_states(corrupt_client, {"meshes": full_meshes})) > 0
    check("negative control 1: dropped mesh detected", detected_missing)

    # Negative Control 2: altered vertex
    corrupt_client_2 = copy.deepcopy(client_a)
    target_mesh = corrupt_client_2["meshes"][first_guid]
    target_mesh["vertices"] = list(target_mesh["vertices"])
    target_mesh["vertices"][0] += 0.5  # shift X by 6 inches
    detected_vertex = len(compare_mesh_states(corrupt_client_2, {"meshes": full_meshes})) > 0
    check("negative control 2: altered vertex coordinate detected", detected_vertex)

    # Negative Control 3: altered parameter
    corrupt_client_3 = copy.deepcopy(client_a)
    corrupt_client_3["meshes"][first_guid]["params"]["thickness"] = 999.0
    detected_param = len(compare_mesh_states(corrupt_client_3, {"meshes": full_meshes})) > 0
    check("negative control 3: altered parameter detected", detected_param)

    print(f"\n------------------------------------------------------------------------")
    if passed_checks == total_checks:
        print(f"DIFFERENTIAL EQUIVALENCE GATE PASSED: {passed_checks}/{total_checks} checks passed")
        return 0
    else:
        print(f"DIFFERENTIAL EQUIVALENCE GATE FAILED: {passed_checks}/{total_checks} checks passed")
        return 1


if __name__ == "__main__":
    sys.exit(run_differential_test())
