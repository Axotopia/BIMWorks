"""
Unit test gate for Geometric References (Phase 0).
Normative: review/IMPLEMENTATION-PLAN-geometric-references.md §4 Phase 0.

Verifies:
1. Every kind resolves.
2. reference_key is order-stable and distinguishes multi-source refs.
3. Two-source intersection does NOT collide with either single source.
4. Normalization of legacy and canonical formats (idempotent, read-old/write-new).
5. Resolution returns outcomes in {"exact", "repaired", "ambiguous", "lost"}, never silent (0.0, 0.0).
6. Axis resolution handles datum planes and spatial axes.
7. Repair uses hint to recover or reports ambiguous/lost.
"""

import sys
import os
import math

sys.path.insert(0, os.path.abspath("backend"))

from ifc_service import BimModelManager
from references import (
    ReferenceKind,
    normalize_reference,
    reference_key,
    resolve_reference,
    resolve_reference_axis,
    repair_reference,
)

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
    print("=== RUNNING GEOMETRIC REFERENCES UNIT GATE (PHASE 0) ===")

    # -------------------------------------------------------------
    # 1. reference_key semantics: order-stability and collision resistance
    # -------------------------------------------------------------
    g1 = "wall-guid-001"
    g2 = "wall-guid-002"

    ref_start_1 = {"guid": g1, "ref": "start"}
    ref_end_1 = {"guid": g1, "ref": "end"}
    ref_start_2 = {"guid": g2, "ref": "start"}

    k_start_1 = reference_key(ref_start_1)
    k_end_1 = reference_key(ref_end_1)
    k_start_2 = reference_key(ref_start_2)

    check("different kinds on same element have distinct keys", k_start_1 != k_end_1)
    check("same kind on different elements have distinct keys", k_start_1 != k_start_2)
    check("wall_start key format", k_start_1 == f"wall_start:{g1}#0")

    # Multi-source derived references
    ref_inter_ab = {
        "kind": "intersection",
        "sources": [{"element_guid": g1, "ordinal": 0}, {"element_guid": g2, "ordinal": 0}],
    }
    ref_inter_ba = {
        "kind": "intersection",
        "sources": [{"element_guid": g2, "ordinal": 0}, {"element_guid": g1, "ordinal": 0}],
    }

    k_inter_ab = reference_key(ref_inter_ab)
    k_inter_ba = reference_key(ref_inter_ba)

    check("multi-source intersection is order-stable (ab == ba)", k_inter_ab == k_inter_ba)
    check("intersection does not collide with single source 1", k_inter_ab != k_start_1)
    check("intersection does not collide with single source 2", k_inter_ab != k_start_2)

    # -------------------------------------------------------------
    # 2. normalize_reference: legacy migration & idempotence
    # -------------------------------------------------------------
    norm_legacy_start = normalize_reference({"guid": g1, "ref": "start"})
    check("legacy start normalizes to wall_start", norm_legacy_start["kind"] == "wall_start")
    check("legacy start has sources", norm_legacy_start["sources"] == [{"element_guid": g1, "ordinal": 0}])
    check("legacy start keeps backward-compatible guid", norm_legacy_start.get("guid") == g1)

    norm_legacy_lvl = normalize_reference({"level_id": "lvl_ground"})
    check("legacy level_id normalizes to level_plane", norm_legacy_lvl["kind"] == "level_plane")
    check("legacy level_id has source", norm_legacy_lvl["sources"] == [{"element_guid": "lvl_ground", "ordinal": 0}])

    norm_pt = normalize_reference({"point": [3.5, 7.25, 0.0]})
    check("raw point normalizes to point kind", norm_pt["kind"] == "point")
    check("raw point populates hint point", norm_pt["hint"]["point"][:2] == [3.5, 7.25])

    # Idempotence: normalizing twice yields deep equality
    norm_twice = normalize_reference(norm_legacy_start)
    check("normalization is idempotent", norm_legacy_start == norm_twice)

    # -------------------------------------------------------------
    # 3. resolve_reference: every kind resolves
    # -------------------------------------------------------------
    mgr = BimModelManager()
    # Wall A: horizontal (0, 0) -> (20, 0), thickness=0.5
    wa = mgr.add_wall([0.0, 0.0, 0.0], [20.0, 0.0, 0.0], height=10.0, thickness=0.5)
    ga = wa["guid"]

    # Wall B: vertical (10, -5) -> (10, 15), thickness=0.5, crosses A at (10, 0)
    wb = mgr.add_wall([10.0, -5.0, 0.0], [10.0, 15.0, 0.0], height=10.0, thickness=0.5)
    gb = wb["guid"]

    # Wall start/end
    pt_start, out_start = resolve_reference(mgr, {"guid": ga, "ref": "start"})
    check("wall_start resolves exactly", out_start == "exact" and pt_start == (0.0, 0.0))

    pt_end, out_end = resolve_reference(mgr, {"guid": ga, "ref": "end"})
    check("wall_end resolves exactly", out_end == "exact" and pt_end == (20.0, 0.0))

    # Wall center
    pt_ctr, out_ctr = resolve_reference(mgr, {"guid": ga, "ref": "center"})
    check("wall_center resolves to midpoint", out_ctr == "exact" and pt_ctr == (10.0, 0.0))

    # Wall faces (positive and negative offset by thickness/2 = 0.25)
    # Baseline from (0,0) to (20,0) runs along +X; normal in 2D is (0, 1)
    pt_fpos, out_fpos = resolve_reference(mgr, {"kind": "wall_face_pos", "sources": [{"element_guid": ga, "ordinal": 0}]})
    check("wall_face_pos is offset along +normal", out_fpos == "exact" and abs(pt_fpos[1] - 0.25) < 1e-4)

    pt_fneg, out_fneg = resolve_reference(mgr, {"kind": "wall_face_neg", "sources": [{"element_guid": ga, "ordinal": 0}]})
    check("wall_face_neg is offset along -normal", out_fneg == "exact" and abs(pt_fneg[1] - (-0.25)) < 1e-4)

    # Hosted door offset
    door = mgr.add_door(host_wall_guid=ga, offset_along_wall=6.0, width=3.0, height=7.0)
    gdoor = door["guid"]
    pt_door, out_door = resolve_reference(mgr, {"kind": "host_offset", "sources": [{"element_guid": gdoor, "ordinal": 0}]})
    check("host_offset resolves along host wall baseline", out_door == "exact" and abs(pt_door[0] - 6.0) < 1e-4 and abs(pt_door[1] - 0.0) < 1e-4)

    # Level plane
    lvl1_id = next(iter(mgr.levels.keys()))
    mgr.levels[lvl1_id]["elevation"] = 12.0
    pt_lvl, out_lvl = resolve_reference(mgr, {"level_id": lvl1_id})
    check("level_plane resolves elevation in Y/2D", out_lvl == "exact" and abs(pt_lvl[1] - 12.0) < 1e-4)

    # Derived: Intersection
    ref_cross = {
        "kind": "intersection",
        "sources": [{"element_guid": ga, "ordinal": 0}, {"element_guid": gb, "ordinal": 0}],
    }
    pt_cross, out_cross = resolve_reference(mgr, ref_cross)
    check("intersection resolves to crossing point (10, 0)", out_cross == "exact" and abs(pt_cross[0] - 10.0) < 1e-4 and abs(pt_cross[1] - 0.0) < 1e-4)

    # Derived: Extension
    ref_ext = {
        "kind": "extension",
        "sources": [{"element_guid": ga, "ordinal": 0}],
        "hint": {"point": [25.0, 0.5, 0.0]},
    }
    pt_ext, out_ext = resolve_reference(mgr, ref_ext)
    check("extension projects hint onto baseline", out_ext == "exact" and abs(pt_ext[0] - 25.0) < 1e-4 and abs(pt_ext[1] - 0.0) < 1e-4)

    # Free point
    pt_free, out_free = resolve_reference(mgr, {"point": [14.0, 8.0]})
    check("free point resolves hint coordinates", out_free == "exact" and pt_free == (14.0, 8.0))

    # -------------------------------------------------------------
    # 4. Failure outcome: NEVER a silent (0.0, 0.0)
    # -------------------------------------------------------------
    pt_lost, out_lost = resolve_reference(mgr, {"guid": "non-existent-guid", "ref": "start"})
    check("missing guid returns lost outcome", out_lost == "lost")
    check("missing guid returns None coordinates, not (0.0, 0.0)", pt_lost is None)

    # -------------------------------------------------------------
    # 5. resolve_reference_axis
    # -------------------------------------------------------------
    z_val, z_out = resolve_reference_axis(mgr, {"level_id": lvl1_id}, "z")
    check("level plane on Z axis returns elevation", z_out == "exact" and abs(z_val - 12.0) < 1e-4)

    x_val, x_out = resolve_reference_axis(mgr, {"level_id": lvl1_id}, "x")
    check("level plane on X axis reports ambiguous", x_out == "ambiguous" and x_val is None)

    w_x, w_x_out = resolve_reference_axis(mgr, {"guid": ga, "ref": "end"}, "x")
    check("wall_end on X axis returns 20.0", w_x_out == "exact" and abs(w_x - 20.0) < 1e-4)

    # -------------------------------------------------------------
    # 6. repair_reference
    # -------------------------------------------------------------
    rep_ref, rep_out = repair_reference(mgr, {"guid": ga, "ref": "start"})
    check("intact reference repairs as exact", rep_out == "exact")

    # Move/replace reference: suppose ga was deleted but hint point is at (0.0, 0.1)
    # Create wall C starting at (0.0, 0.0)
    mgr.delete_element(ga)
    wc = mgr.add_wall([0.0, 0.0, 0.0], [5.0, 0.0, 0.0])
    gc = wc["guid"]

    stale_ref = {
        "kind": "wall_start",
        "sources": [{"element_guid": ga, "ordinal": 0}],
        "hint": {"point": [0.1, 0.1, 0.0]},
    }
    repaired, rep_status = repair_reference(mgr, stale_ref)
    check("stale reference repaired to nearby candidate", rep_status == "repaired" and repaired["sources"][0]["element_guid"] == gc)

    stale_distant = {
        "kind": "wall_start",
        "sources": [{"element_guid": ga, "ordinal": 0}],
        "hint": {"point": [100.0, 100.0, 0.0]},
    }
    _, distant_status = repair_reference(mgr, stale_distant)
    check("unrecoverable reference reports lost", distant_status == "lost")

    print(f"\nRESULTS: {passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_tests()
