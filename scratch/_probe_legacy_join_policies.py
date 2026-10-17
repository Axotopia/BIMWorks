"""
Probe — B2: legacy load silently discards join_policies (geometric-references refactor).

Backs finding B2 in review/archive/REVIEW-geometric-references-refactor-2026-10-15.md.

Commit cc0ddef deleted `self.join_policies = self._jsonable(overlay.get("join_policies", {}) or {})`
from `load_orlt_project`'s legacy branch, alongside the `elements_overlay` line (B1). This probe
pre-seeds `join_policies` with a sentinel: if the sentinel survives, the overlay's join policies
were never read. B2 is therefore independent of B1 — it survives fixing the NameError.

Expected on a correct tree: "overlay join_policies was READ? True".
Expected at e4b9dd9:           "False" (probe still exits 0; the crash is B1's).

Run:  .venv/bin/python scratch/_probe_legacy_join_policies.py
"""

import io
import json
import os
import sys
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import ifc_service  # noqa: E402

IFC = os.path.join(ROOT, "sample_building.ifc")
SENTINEL = {"__sentinel__": {"start": {"mode": "sentinel"}}}


def main() -> int:
    overlay = {
        "schema_version": "2.1",
        "elements": {},
        "join_policies": {"g1": {"start": {"mode": "miter"}}},
        "dimensions": {},
        "constraints": {},
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("model.ifc", open(IFC, "rb").read())
        z.writestr("parametric.json", json.dumps(overlay))
        z.writestr("meta.json", "{}")

    mgr = ifc_service.BimModelManager()
    mgr.join_policies = dict(SENTINEL)
    try:
        mgr.load_orlt_project(buf.getvalue(), "Legacy.bimworks")
        print("loaded without crash")
    except NameError as exc:
        print(f"crash (B1, expected at e4b9dd9): {exc}")

    print("join_policies after legacy load:", mgr.join_policies)
    read = mgr.join_policies != SENTINEL
    print("overlay join_policies was READ?", read)
    return 0 if read else 1


if __name__ == "__main__":
    sys.exit(main())
