"""
Gate 0: Solver Capability Inventory and Primitive Verification.
Verifies the actual installed planegcs Python API surface and asserts that
ConstraintSolver primitives (points, fixed points, p2p distance, lines, equal length,
solve, get_point) exist, behave as expected, and that solver absence raises loudly.
"""

import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

CHECKS = {"passed": 0, "failed": 0}


def check(label, condition, detail=""):
    if condition:
        CHECKS["passed"] += 1
        print(f"  [PASS] {label}")
    else:
        CHECKS["failed"] += 1
        print(f"  [FAIL] {label}: {detail}")


def main():
    print("=== RUNNING SOLVER CAPABILITY INVENTORY (GATE 0) ===")

    # 1. Import planegcs
    try:
        import planegcs
        from planegcs import Sketch, SolveStatus
        planegcs_available = True
    except ImportError as e:
        planegcs_available = False
        print(f"planegcs import error: {e}")

    check("planegcs is installed and importable", planegcs_available)
    if not planegcs_available:
        print(f"RESULT: {CHECKS['passed']} passed, {CHECKS['failed']} failed")
        return 1

    # 2. Inspect Sketch attributes
    sketch = Sketch()
    expected_primitives = [
        "add_point",
        "add_fixed_point",
        "set_p2p_distance",
        "coincident",
        "add_line",
        "equal_length",
        "get_point",
        "solve",
        "point_on_line",
    ]

    print("\n--- Primitive Inventory ---")
    for prim in expected_primitives:
        present = hasattr(sketch, prim)
        check(f"Sketch has '{prim}'", present)

    # 3. Functional check of point & distance solving
    s = Sketch()
    p0 = s.add_fixed_point(0.0, 0.0)
    p1 = s.add_point(5.0, 0.0)
    s.set_p2p_distance(p0, p1, 12.0)
    status = s.solve()
    name = getattr(status, "name", str(status))
    check("solve converged for p2p distance", name in ("Success", "Converged"), name)
    pt1 = s.get_point(p1)
    check("solved point p1 distance matches 12.0", abs(pt1[0] - 12.0) < 1e-4, pt1)

    # 4. Functional check of equal_length chain (EQ)
    s2 = Sketch()
    sp_start = s2.add_fixed_point(0.0, 0.0)
    sp_mid = s2.add_point(4.0, 0.0)
    sp_end = s2.add_fixed_point(20.0, 0.0)
    l1 = s2.add_line(sp_start, sp_mid)
    l2 = s2.add_line(sp_mid, sp_end)
    s2.equal_length(l1, l2)
    status2 = s2.solve()
    name2 = getattr(status2, "name", str(status2))
    check("solve converged for equal_length", name2 in ("Success", "Converged"), name2)
    mid_pt = s2.get_point(sp_mid)
    check("midpoint equally spaced at 10.0", abs(mid_pt[0] - 10.0) < 1e-4, mid_pt)

    # 5. Verify SolverUnavailable is raised when Sketch is None
    import constraint_solver
    orig_sketch = constraint_solver.Sketch
    try:
        constraint_solver.Sketch = None
        raised = False
        try:
            constraint_solver.ConstraintSolver._require_solver()
        except constraint_solver.SolverUnavailable:
            raised = True
        check("SolverUnavailable is raised when solver is missing", raised)
    finally:
        constraint_solver.Sketch = orig_sketch

    # 6. Verify distinct endpoints EQ holds across move in BimModelManager
    from ifc_service import BimModelManager
    m = BimModelManager()
    m.reset_model()
    w_start = m.add_wall((0, 0, 0), (0, 10, 0), height=10.0, thickness=0.8333, name="StartWall")["guid"]
    w_end = m.add_wall((30, 0, 0), (30, 10, 0), height=10.0, thickness=0.8333, name="EndWall")["guid"]
    w_int1 = m.add_wall((5, 0, 0), (5, 10, 0), height=10.0, thickness=0.8333, name="IntWall1")["guid"]
    w_int2 = m.add_wall((15, 0, 0), (15, 10, 0), height=10.0, thickness=0.8333, name="IntWall2")["guid"]

    eq_res = m.equalize_span(w_start, w_end, [w_int1, w_int2], axis="x")
    check("EQ constraint created", eq_res.get("type") == "equalize")

    # Move endpoint and check that interiors follow with equal spacing
    m.translate_element(w_end, 15.0, 0.0, 0.0) # Move to x=45.0
    x_start = m.get_element_coord(w_start, "x")
    x_i1 = m.get_element_coord(w_int1, "x")
    x_i2 = m.get_element_coord(w_int2, "x")
    x_end = m.get_element_coord(w_end, "x")

    gap1 = x_i1 - x_start
    gap2 = x_i2 - x_i1
    gap3 = x_end - x_i2
    gaps_equal = max(abs(gap1 - gap2), abs(gap2 - gap3)) < 1e-4
    check("EQ spacing holds across endpoint move (equal gaps)", gaps_equal, (gap1, gap2, gap3))

    print(f"\nRESULTS: {CHECKS['passed']} passed, {CHECKS['failed']} failed")
    return 0 if CHECKS["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
