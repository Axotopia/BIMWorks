"""
Probe — Phase 5: undo of a locked-dimension cascade leaves a dangling constraint_id.

Backs the Phase 5 finding in review/REVIEW-geometric-references-refactor-2026-10-15.md.

`delete_dimension` releases the dimension's lock via `delete_constraint(cid)`. The DeleteElement
memento's `undo_fn` restores `mgr.dimensions` but not `mgr.constraints`. So after undo the
dimension still reports `is_locked: True` with a `constraint_id` that no longer exists — a
silently inert lock (plan §3.8's failure mode, in the constraint direction).

`scratch/test_transactions.py` covers only an UNLOCKED dimension, where `constraint_id` is None
and nothing cascades — which is why its 42/42 does not catch this.

Expected on a correct tree: "DANGLING constraint_id: False", exit 0.
Expected at e4b9dd9:           "DANGLING constraint_id: True", exit 7.

Run:  .venv/bin/python scratch/_probe_locked_dimension_undo.py
"""

import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from ifc_service import BimModelManager  # noqa: E402
from command_bus import CommandBusEngine, CommandRequest  # noqa: E402


def main() -> int:
    mgr = BimModelManager()
    bus = CommandBusEngine(mgr)

    def create_wall(start, end, desc):
        res = bus.execute_transaction(
            [CommandRequest(command="WallCreate", params={
                "start": start, "end": end, "height": 3.0, "thickness": 0.2})],
            description=desc,
        )
        return res["results"][0]["result"]["guid"]

    guid_a = create_wall([0.0, 0.0, 0.0], [10.0, 0.0, 0.0], "wall A")
    guid_d = create_wall([50.0, 0.0, 0.0], [60.0, 0.0, 0.0], "wall D")

    # LOCKED -> registers an active distance constraint lock (constraint_id is not None).
    r_dim = bus.execute_transaction(
        [CommandRequest(command="DimensionCreate", params={
            "ref_a": {"guid": guid_a, "ref": "end"},
            "ref_b": {"guid": guid_d, "ref": "start"},
            "axis": "x",
            "is_locked": True,
        })],
        description="locked dim A-D",
    )
    dim_id = r_dim["results"][0]["result"]["dimension_id"]
    cid = mgr.dimensions[dim_id].get("constraint_id")
    print("dimension:", dim_id, "constraint_id:", cid)
    print("constraint present after create:", cid in mgr.constraints if cid else "n/a",
          "| constraints:", list(mgr.constraints.keys()))

    bus.execute_transaction(
        [CommandRequest(command="DeleteElement", params={"guid": guid_d})], description="delete D")
    print("after delete -> dim gone:", dim_id not in mgr.dimensions,
          "| constraints:", list(mgr.constraints.keys()))

    bus.undo()
    print("after undo   -> dim back:", dim_id in mgr.dimensions,
          "| constraints:", list(mgr.constraints.keys()))

    if dim_id not in mgr.dimensions:
        print("dimension was not restored at all")
        return 8

    cid2 = mgr.dimensions[dim_id].get("constraint_id")
    dangling = bool(cid2) and cid2 not in mgr.constraints
    print("restored dimension constraint_id:", cid2)
    print("dimension is_locked:", mgr.dimensions[dim_id].get("is_locked"))
    print("DANGLING constraint_id:", dangling)
    return 7 if dangling else 0


if __name__ == "__main__":
    sys.exit(main())
