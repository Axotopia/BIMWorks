"""
Probe — Phase 4: the ReferenceMove `extras` payload is inert in the gate's own scenario.

Backs the Phase 4 finding in review/REVIEW-geometric-references-refactor-2026-10-15.md.

`scratch/test_reference_move.py` step 3 passes `extras=[("align", (grid_guid, w1_guid))]` and then
asserts "Wall 2 followed Wall 1 (constraint held)". But the grid is not in the solve scope, so the
extra is skipped: `applied` contains only the PRE-EXISTING persisted align constraint
(`align_<id>`), never `extra:align`. The assertion is satisfied by
`_solve_constraints_after_move`, not by the new drag-time extras seam.

Only the test's step 6 (a direct `solver.solve(..., extras=...)` call) exercises the seam.

Expected on a correct tree: "extra:align" appears in applied, or the scenario is re-specified.
Expected at e4b9dd9:           applied == ['align_<id>'] only.

Run:  .venv/bin/python scratch/_probe_reference_move_extras.py
"""

import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from ifc_service import BimModelManager  # noqa: E402
from command_bus import CommandBusEngine  # noqa: E402
from constraint_solver import ConstraintSolver  # noqa: E402


def main() -> int:
    mgr = BimModelManager()
    bus = CommandBusEngine(mgr)

    w1 = bus.execute_single_command(
        "WallCreate", {"start": [0.0, 0.0], "end": [10.0, 0.0], "height": 10.0, "thickness": 0.5})["guid"]
    w2 = bus.execute_single_command(
        "WallCreate", {"start": [0.0, 8.0], "end": [10.0, 8.0], "height": 10.0, "thickness": 0.5})["guid"]
    mgr.add_align_constraint(ref_guid=w1, target_guid=w2, axis="x")
    grid = mgr.add_grid(axis_name="Grid-A", start_pt=(15.0, -10.0), end_pt=(15.0, 30.0))["guid"]

    solver = ConstraintSolver(mgr)
    scope = solver.affected_guids([w1])
    print("affected_guids([w1]) =", scope)
    print("grid in scope?", grid in scope)
    print("grid in element_meta?", grid in mgr.element_meta)

    # Replicate the ReferenceMove handler's extras pass:
    # Grids/datums are fixed references; the dragged element moves to satisfy the constraint.
    pins = {grid: mgr.get_element_coord(grid, "x")}
    res = solver.solve(axis="x", pins=pins, scope=scope, extras=[("align", (grid, w1))])
    print("extras apply result: ok =", res.ok, "applied =", res.applied)

    extra_applied = any(c.startswith("extra:") for c in res.applied)
    print("drag-time extra actually applied?", extra_applied)
    return 0 if extra_applied else 1


if __name__ == "__main__":
    sys.exit(main())
