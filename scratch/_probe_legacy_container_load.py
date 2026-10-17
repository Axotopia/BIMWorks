"""
Probe — B1: legacy container load crashes with NameError (geometric-references refactor).

Backs finding B1 in review/archive/REVIEW-geometric-references-refactor-2026-10-15.md.

`backend/ifc_service.py:load_orlt_project` legacy branch (`schema_version != 3`) consumes
`elements_overlay`, which commit cc0ddef deleted while reworking dimension normalization in
the same hunk. Result: every schema < 3 container fails to open.

Expected on a correct tree: prints "LOAD OK" and exits 0.
Expected at e4b9dd9:           prints the NameError and exits 7.

Run:  .venv/bin/python scratch/_probe_legacy_container_load.py
"""

import io
import json
import os
import sys
import traceback
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import ifc_service  # noqa: E402

IFC = os.path.join(ROOT, "sample_building.ifc")


def build_legacy_container() -> bytes:
    """A minimal schema 2.1 container: overlay carries no parametric geometry."""
    overlay = {
        "schema_version": "2.1",
        "elements": {"some-guid": {"type_properties": {"a": 1}}},
        "join_policies": {"g1": {"start": {"mode": "miter"}}},
        "dimensions": {
            "dim_x": {
                "id": "dim_x",
                "kind": "linear",
                "ref_a": {"guid": "w1", "ref": "start"},
                "ref_b": {"guid": "w1", "ref": "end"},
                "axis": "aligned",
                "offset": 1.0,
                "value": 10.0,
                "is_locked": False,
            }
        },
        "constraints": {},
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("model.ifc", open(IFC, "rb").read())
        z.writestr("parametric.json", json.dumps(overlay))
        z.writestr("meta.json", json.dumps({"project_name": "LegacyProj", "schema_version": "2.1"}))
    return buf.getvalue()


def main() -> int:
    payload = build_legacy_container()
    mgr = ifc_service.BimModelManager()
    try:
        report = mgr.load_orlt_project(payload, "Legacy.bimworks")
    except Exception as exc:  # noqa: BLE001 - the probe reports whatever escaped
        print(f"!!! EXCEPTION: {type(exc).__name__}: {exc}")
        traceback.print_exc(limit=3)
        return 7
    print("LOAD OK ->", json.dumps(report, default=str)[:200])
    print("elements_count:", report.get("elements_count"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
