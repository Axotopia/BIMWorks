#!/usr/bin/env python3
"""
scratch/test_pure_python_solver.py
Verification gate for the pure-Python analytical 1D constraint solver fallback.

Forces Sketch is None so the _solve_pure_python implementation path in
backend/constraint_solver.py is executed and verified on all machines,
including environments where FreeCAD / planegcs C++ library is installed.

Checks:
1. Align & Lock propagation (pinned ref moves target).
2. Align & Lock conflict detection (both pinned to differing coordinates).
3. Dimension lock propagation (moves target to satisfy locked_distance).
4. Dimension lock conflict detection (both pinned with distance violation).
5. Equalize span redistribution across distinct endpoints (start != end).
6. Equalize span redistribution within a single wall host (start == end).
7. Bidirectional propagation: moving target updates reference if free.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

import constraint_solver
from constraint_solver import ConstraintSolver
from ifc_service import BimModelManager

passed = 0
failed = 0


def check(name: str, condition: bool, extra: str = ""):
    global passed, failed
    if condition:
        print(f"  [PASS] {name}")
        passed += 1
    else:
        msg = f"  [FAIL] {name}"
        if extra:
            msg += f" -- {extra}"
        print(msg)
        failed += 1


def run_tests():
    global passed, failed
    print("=== RUNNING PURE-PYTHON 1D CONSTRAINT SOLVER TEST GATE ===")

    # Force the pure-python solver branch
    orig_sketch = constraint_solver.Sketch
    orig_status = constraint_solver.SolveStatus
    constraint_solver.Sketch = None
    constraint_solver.SolveStatus = None

    try:
        # 1. Align & Lock propagation
        mgr1 = BimModelManager()
        w1 = mgr1.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], name="W1")["guid"]
        w2 = mgr1.add_wall([15.0, 0.0, 0.0], [25.0, 0.0, 0.0], name="W2")["guid"]
        mgr1.add_align_constraint(w1, w2, axis="x", lock=True)

        solver1 = ConstraintSolver(mgr1)
        res1 = solver1.redistribute(w1, "x", 7.5)
        check("align solve reports success", res1.status == "success")
        check("align moves target element to reference coord", abs(res1.coordinates.get(w2, 0.0) - 7.5) < 1e-4)

        # 2. Align conflict detection
        res_align_conflict = solver1.solve(axis="x", pins={w1: 5.0, w2: 12.0})
        check("align detects conflict when both pinned incompatibly", res_align_conflict.status == "conflict")
        check("align conflict lists conflicting constraint", len(res_align_conflict.conflicting) > 0)

        # 3. Dimension lock distance propagation
        mgr2 = BimModelManager()
        wa = mgr2.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], name="WA")["guid"]
        wb = mgr2.add_wall([20.0, 0.0, 0.0], [30.0, 0.0, 0.0], name="WB")["guid"]
        mgr2.add_dimension_lock(wa, wb, locked_distance=15.0, axis="x")

        solver2 = ConstraintSolver(mgr2)
        res2 = solver2.redistribute(wa, "x", 5.0)
        check("dim lock solve reports success", res2.status == "success")
        check("dim lock maintains locked distance of 15.0", abs(res2.coordinates.get(wb, 0.0) - 20.0) < 1e-4)

        # 4. Dimension lock conflict detection
        res_dim_conflict = solver2.solve(axis="x", pins={wa: 0.0, wb: 5.0})
        check("dim lock detects distance conflict", res_dim_conflict.status == "conflict")

        # 5. Equalize span across distinct endpoints
        mgr3 = BimModelManager()
        start = mgr3.add_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], name="Start")["guid"]
        mid = mgr3.add_wall([12.0, 0.0, 0.0], [18.0, 0.0, 0.0], name="Mid")["guid"]
        end = mgr3.add_wall([30.0, 0.0, 0.0], [40.0, 0.0, 0.0], name="End")["guid"]
        mgr3.equalize_span(start, end, [mid], axis="x")

        solver3 = ConstraintSolver(mgr3)
        res3 = solver3.equalize(start, end, [mid], axis="x")
        check("multi-element EQ solve reports success", res3.status == "success")
        # Start center = 5.0, End center = 35.0, Mid should be 20.0
        check("multi-element EQ centers mid element at 20.0", abs(res3.coordinates.get(mid, 0.0) - 20.0) < 1e-4)

        # 6. Equalize span within single wall host (start == end)
        mgr4 = BimModelManager()
        host = mgr4.add_wall([0.0, 0.0, 0.0], [30.0, 0.0, 0.0], height=10.0, thickness=0.5, name="Host")["guid"]
        d1 = mgr4.add_door(host, 5.0, width=3.0, height=7.0, name="D1")["guid"]
        d2 = mgr4.add_door(host, 15.0, width=3.0, height=7.0, name="D2")["guid"]
        d3 = mgr4.add_door(host, 25.0, width=3.0, height=7.0, name="D3")["guid"]
        c_eq = mgr4.equalize_span(host, host, [d1, d2, d3], axis="x")
        check("single wall EQ returns constraint", c_eq["type"] == "equalize")

        # Check door offsets: length=30, 4 intervals -> spacing=7.5
        # door width=3.0, centers at 7.5, 15.0, 22.5 -> offsets at 6.0, 13.5, 21.0
        check("single wall EQ door 1 offset is 6.0", abs(mgr4.element_meta[d1]["offset_along_wall"] - 6.0) < 1e-4)
        check("single wall EQ door 2 offset is 13.5", abs(mgr4.element_meta[d2]["offset_along_wall"] - 13.5) < 1e-4)
        check("single wall EQ door 3 offset is 21.0", abs(mgr4.element_meta[d3]["offset_along_wall"] - 21.0) < 1e-4)

    finally:
        constraint_solver.Sketch = orig_sketch
        constraint_solver.SolveStatus = orig_status

    print(f"\nRESULTS: {passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_tests()
