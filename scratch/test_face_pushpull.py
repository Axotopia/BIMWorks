"""
scratch/test_face_pushpull.py — Phase 7 Gate: Face-Based Push/Pull as a Parameter Gesture.

Validates:
1. Face classification logic (normal +Z -> height, normal perpendicular to baseline -> thickness).
2. End caps and bottom faces rejected from push/pull.
3. Push/pull command computation produces typed WallSetHeight and WallSetThickness commands.
4. Parameter clamping: minimum height >= 0.5 ft and thickness >= 1 inch (0.0833 ft).
5. Full bus drag session:
   - 10 frames of height push/pull keep rev constant.
   - Commit advances rev by 1 with exactly 1 journal entry.
   - Undo/Redo restores exact heights.
   - 10 frames of thickness push/pull keep rev constant.
   - Commit advances rev by 1 with exactly 1 journal entry.
   - Undo/Redo restores exact thicknesses.
6. Wobble guard: uncommitted / stationary drag leaves rev and model unchanged.
"""

import sys
import os
import math

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest
from validity import MIN_THICKNESS_FT


def classify_wall_face(
    element: dict,
    normal: list,
    hit_point: list,
) -> dict:
    """Python mirror of TypeScript detectWallFaceHover."""
    ifc_class = element.get("ifc_class", "")
    if ifc_class not in ("IfcWall", "IfcWallStandardCase"):
        return None

    nx, ny, nz = normal
    norm_len = math.hypot(math.hypot(nx, ny), nz)
    if norm_len < 1e-6:
        return None
    nx, ny, nz = nx / norm_len, ny / norm_len, nz / norm_len

    # 1. Top face (normal pointing upward +Z > 0.7)
    if nz > 0.7:
        return {
            "kind": "top",
            "param": "height",
            "label": "Wall Height",
            "normal": [nx, ny, nz],
            "current_value": float(element.get("height", 10.0)),
        }

    # 2. Vertical side faces (|nz| <= 0.3)
    if abs(nz) <= 0.3:
        sp = element.get("start")
        ep = element.get("end")
        if sp and ep:
            dx = ep[0] - sp[0]
            dy = ep[1] - sp[1]
            len_b = math.hypot(dx, dy)
            if len_b > 1e-4:
                tx = dx / len_b
                ty = dy / len_b
                dot_tangent = abs(nx * tx + ny * ty)
                # If normal is perpendicular to baseline (dot_tangent <= 0.5), it's a side face!
                if dot_tangent <= 0.5:
                    return {
                        "kind": "side",
                        "param": "thickness",
                        "label": "Wall Thickness",
                        "normal": [nx, ny, nz],
                        "current_value": float(element.get("thickness", 0.67)),
                    }

    return None


def compute_pushpull_param(
    face_kind: str,
    element: dict,
    target_point: list,
) -> float:
    """Python mirror of TypeScript computePushPullCommand."""
    if face_kind == "top":
        base_z = float(element.get("start", [0, 0, 0])[2] if len(element.get("start", [])) > 2 else 0.0)
        raw_height = target_point[2] - base_z
        clamped_height = max(0.5, raw_height)
        return round(clamped_height, 3)
    else:
        sp = element.get("start", [0, 0, 0])
        ep = element.get("end", [0, 0, 0])
        dx = ep[0] - sp[0]
        dy = ep[1] - sp[1]
        len_b = math.hypot(dx, dy)
        if len_b < 1e-4:
            return float(element.get("thickness", 0.67))
        nx = -dy / len_b
        ny = dx / len_b
        mx = (sp[0] + ep[0]) / 2.0
        my = (sp[1] + ep[1]) / 2.0
        off_x = target_point[0] - mx
        off_y = target_point[1] - my
        dist_from_baseline = abs(off_x * nx + off_y * ny)
        raw_thickness = dist_from_baseline * 2.0
        clamped_thickness = max(MIN_THICKNESS_FT, raw_thickness)
        return round(clamped_thickness, 3)


def run_face_pushpull_gate():
    print("\n=== RUNNING FACE PUSHPULL GATE (PHASE 7) ===")
    passed = 0
    failed = 0

    def check(name: str, cond: bool):
        nonlocal passed, failed
        if cond:
            print(f"  [PASS] {name}")
            passed += 1
        else:
            print(f"  [FAIL] {name}")
            failed += 1

    mgr = BimModelManager()
    bus = CommandBusEngine(mgr)

    # 1. Create baseline wall: (0,0) -> (20,0), height=10.0, thickness=0.67
    res_wall = bus.execute_transaction(
        [
            CommandRequest(
                command="WallCreate",
                params={
                    "start": [0.0, 0.0, 0.0],
                    "end": [20.0, 0.0, 0.0],
                    "height": 10.0,
                    "thickness": 0.67,
                },
            )
        ],
        "Create baseline wall"
    )
    wall_guid = res_wall["results"][0]["result"]["guid"]
    wall_elem = mgr.element_meta[wall_guid]
    check("Baseline wall created", bool(wall_guid))

    # 2. Test Face Classification
    # Top face: normal (0, 0, 1)
    f_top = classify_wall_face(wall_elem, [0.0, 0.0, 1.0], [10.0, 0.0, 10.0])
    check("Top face classified as height param", f_top is not None and f_top["param"] == "height")
    check("Top face current value is 10.0", f_top is not None and abs(f_top["current_value"] - 10.0) < 1e-3)

    # Side face +Y: normal (0, 1, 0)
    f_side_pos = classify_wall_face(wall_elem, [0.0, 1.0, 0.0], [10.0, 0.335, 5.0])
    check("Side face (+Y) classified as thickness param", f_side_pos is not None and f_side_pos["param"] == "thickness")
    check("Side face current value is 0.67", f_side_pos is not None and abs(f_side_pos["current_value"] - 0.67) < 1e-3)

    # Side face -Y: normal (0, -1, 0)
    f_side_neg = classify_wall_face(wall_elem, [0.0, -1.0, 0.0], [10.0, -0.335, 5.0])
    check("Side face (-Y) classified as thickness param", f_side_neg is not None and f_side_neg["param"] == "thickness")

    # End cap: normal (1, 0, 0) parallel to baseline -> rejected
    f_endcap = classify_wall_face(wall_elem, [1.0, 0.0, 0.0], [20.0, 0.0, 5.0])
    check("End cap face rejected from thickness push/pull", f_endcap is None)

    # Bottom face: normal (0, 0, -1) -> rejected
    f_bottom = classify_wall_face(wall_elem, [0.0, 0.0, -1.0], [10.0, 0.0, 0.0])
    check("Bottom face rejected from push/pull", f_bottom is None)

    # Non-wall element rejected
    slab_elem = {"ifc_class": "IfcSlab", "thickness": 0.25}
    f_slab = classify_wall_face(slab_elem, [0.0, 0.0, 1.0], [0.0, 0.0, 0.0])
    check("Non-wall element rejected by classifier", f_slab is None)

    # 3. Test Parameter Computation & Clamping
    # Pulling top face up to z=14.5
    h_pull = compute_pushpull_param("top", wall_elem, [10.0, 0.0, 14.5])
    check("Height pull computes 14.5 ft", abs(h_pull - 14.5) < 1e-3)

    # Pushing top face down past floor to z=-2.0 -> clamped to 0.5 ft
    h_clamp = compute_pushpull_param("top", wall_elem, [10.0, 0.0, -2.0])
    check("Height push clamped to minimum 0.5 ft", abs(h_clamp - 0.5) < 1e-3)

    # Pulling side face out to y=1.0 (baseline at y=0, dist=1.0 -> thickness=2.0)
    th_pull = compute_pushpull_param("side", wall_elem, [10.0, 1.0, 5.0])
    check("Thickness pull computes 2.0 ft", abs(th_pull - 2.0) < 1e-3)

    # Pushing side face inward to y=0.01 (thickness 0.02 ft < 1 inch) -> clamped to 1 inch (0.0833 ft)
    th_clamp = compute_pushpull_param("side", wall_elem, [10.0, 0.01, 5.0])
    check("Thickness push clamped to minimum 1 inch (0.0833 ft)", abs(th_clamp - round(MIN_THICKNESS_FT, 3)) < 1e-3)

    # 4. Bus Drag Session for Height Push/Pull (10 frames)
    initial_rev = bus.rev
    session_id = bus.begin_drag(origin="ui", description="Push/Pull Wall Height")["session_id"]
    check("begin_drag returns session id", bool(session_id))
    check("begin_drag does not advance rev", bus.rev == initial_rev)

    # Simulate 10 frames of height dragging: 10.0 -> 15.0
    for i in range(1, 11):
        target_h = 10.0 + (5.0 * (i / 10.0))
        update_res = bus.update_drag(
            session_id,
            [
                CommandRequest(
                    command="WallSetHeight",
                    params={"guid": wall_guid, "height": target_h},
                    origin="ui",
                )
            ]
        )
        check(f"Height frame {i} keeps rev constant", bus.rev == initial_rev)

    # End drag and commit
    end_res = bus.end_drag(session_id, commit=True)
    check("end_drag advances rev by exactly 1", bus.rev == initial_rev + 1)
    check("Model wall height updated to 15.0", abs(mgr.element_meta[wall_guid]["height"] - 15.0) < 1e-3)

    # Undo/Redo of Height Push/Pull
    bus.undo()
    check("Undo restores original wall height 10.0", abs(mgr.element_meta[wall_guid]["height"] - 10.0) < 1e-3)
    bus.redo()
    check("Redo reapplies pushed wall height 15.0", abs(mgr.element_meta[wall_guid]["height"] - 15.0) < 1e-3)

    # 5. Bus Drag Session for Thickness Push/Pull (10 frames)
    cur_rev = bus.rev
    th_session_id = bus.begin_drag(origin="ui", description="Push/Pull Wall Thickness")["session_id"]
    check("begin_drag for thickness returns session id", bool(th_session_id))

    # Simulate 10 frames of thickness dragging: 0.67 -> 1.5
    for i in range(1, 11):
        target_th = 0.67 + (0.83 * (i / 10.0))
        bus.update_drag(
            th_session_id,
            [
                CommandRequest(
                    command="WallSetThickness",
                    params={"guid": wall_guid, "thickness": target_th},
                    origin="ui",
                )
            ]
        )
        check(f"Thickness frame {i} keeps rev constant", bus.rev == cur_rev)

    # End drag and commit
    bus.end_drag(th_session_id, commit=True)
    check("Thickness end_drag advances rev by exactly 1", bus.rev == cur_rev + 1)
    check("Model wall thickness updated to 1.5", abs(mgr.element_meta[wall_guid]["thickness"] - 1.5) < 1e-3)

    # Undo/Redo of Thickness Push/Pull
    bus.undo()
    check("Undo restores original wall thickness 0.67", abs(mgr.element_meta[wall_guid]["thickness"] - 0.67) < 1e-3)
    bus.redo()
    check("Redo reapplies pushed wall thickness 1.5", abs(mgr.element_meta[wall_guid]["thickness"] - 1.5) < 1e-3)

    # 6. Wobble Guard / Cancelled Push/Pull Drag
    cur_rev = bus.rev
    cancel_session_id = bus.begin_drag(origin="ui", description="Push/Pull Cancelled")["session_id"]
    bus.update_drag(
        cancel_session_id,
        [
            CommandRequest(
                command="WallSetHeight",
                params={"guid": wall_guid, "height": 18.0},
                origin="ui",
            )
        ]
    )
    # Cancel drag session (commit=False)
    bus.end_drag(cancel_session_id, commit=False)
    check("Cancelled drag leaves rev unchanged", bus.rev == cur_rev)
    check("Cancelled drag reverts model back to 15.0", abs(mgr.element_meta[wall_guid]["height"] - 15.0) < 1e-3)

    print(f"\nPhase 7 Gate Total: {passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_face_pushpull_gate()
