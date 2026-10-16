"""
Probe — is BIMWorks actually working? Engine-level smoke, no browser required.

Answers the question "how do I know the app works despite the backend refactors?"
by exercising the *engine* directly, which is where the refactors live. The UI
cannot answer it today: `src/interaction/toolCaptions.ts` declares DI (Aligned
Dimension), SEC (Section), SHT (Sheet), GR, LL, DL, TG and TX as
`implemented: false`, and there is no elevation tool in `ActiveTool` at all, so
there is no UI entry point for the two refactors this probe covers.

Six checks, each independently falsifiable:

  A. SAMPLE SANITY   the shipped sample's walls are architecturally plausible
  B. DEFAULT CUT     a plan at the default 4.0 ft cut produces cut geometry
  C. DIM UNLOCKED    driving an unlocked dimension moves the geometry to match
  D. DIM LOCKED      driving a *locked* dimension moves the geometry to match
  E. FAILURE HONESTY a failed solve does not report success
  F. VIEWS           section and elevation return linework
  G. UNDO UNIT       no registered command silently falls back to a full-state
                     snapshot (V1 of docs/DECISION-live-edit-transaction-unit.md)

Expected on the current tree (2026-10-16, 3762c0c):
  A FAIL  the startup model is the legacy generator: 3.0 ft walls
  B FAIL  the default 4.0 ft cut therefore yields 0 cut paths
  C PASS
  D PASS  -- fixed 3762c0c; all three anchors land on the asked value
  E FAIL  failed solve returns an envelope status of "updated"
  F PASS
  G FAIL  10 of 41 commands fall back to snapshot_state()

3 passed, 4 failed at 3762c0c.

Run:  .venv/bin/python scratch/_probe_engine_smoke.py
"""

import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from command_bus import CommandBusEngine, CommandRequest  # noqa: E402
from ifc_service import BimModelManager  # noqa: E402

results = []


def check(label, ok, detail):
    results.append((ok, label, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}\n         {detail}")


def bus_for(mgr):
    return CommandBusEngine(mgr)


def two_walls(mgr, bus):
    """Two 10 ft walls, 10 ft apart along x. Returns (guid_a, guid_b)."""
    res = bus.execute_transaction([
        CommandRequest(command="WallCreate", params={
            "start": [0.0, 0.0, 0.0], "end": [10.0, 0.0, 0.0],
            "height": 9.0, "thickness": 0.5}),
        CommandRequest(command="WallCreate", params={
            "start": [20.0, 0.0, 0.0], "end": [30.0, 0.0, 0.0],
            "height": 9.0, "thickness": 0.5}),
    ], description="two walls")
    return (res["results"][0]["result"]["guid"],
            res["results"][1]["result"]["guid"])


def endpoints(mgr, guid):
    meta = mgr.element_meta[guid]
    return float(meta["start"][0]), float(meta["end"][0])


def make_dimension(bus, guid_a, guid_b, locked, value=None):
    params = {
        "dimension_id": "SMOKE_D1", "kind": "aligned",
        "ref_a": {"guid": guid_a, "ref": "end"},
        "ref_b": {"guid": guid_b, "ref": "start"},
        "axis": "x", "is_locked": locked,
    }
    if value is not None:
        params["value"] = value
    res = bus.execute_transaction(
        [CommandRequest(command="DimensionCreate", params=params)], description="dimension")
    return res["results"][0]["result"]


def drive(bus, value):
    res = bus.execute_transaction([
        CommandRequest(command="DimensionValueSet", params={
            "dimension_id": "SMOKE_D1", "value": value, "anchor": "start"}),
    ], description="set dimension")
    return res["results"][0]["result"]


def main() -> int:
    # ---- A/B: the shipped sample, exactly as /api/sample builds it ----------
    import main as backend_main

    mgr = backend_main.bim_manager
    walls = [m for m in mgr.element_meta.values()
             if m.get("ifc_class") in ("IfcWall", "IfcWallStandardCase")]
    heights = sorted({round(float(m.get("height", 0.0)), 3) for m in walls})
    plausible = heights and all(7.0 <= h <= 14.0 for h in heights)
    check("A. the model a fresh boot loads is architecturally plausible",
          plausible,
          f"startup wall heights = {heights} ft (a storey wall is 8-12 ft; 3.0 means "
          f"main.py:402 still loads the legacy metric-magnitude generator instead of "
          f"sample_building.ifc)")

    plan = mgr.render_2d_view(view_type="floor_plan", cut_elevation=4.0,
                              direction="top", view_range={"cut": 4.0})
    cut = len(plan.get("cut_paths") or [])
    check("B. the startup model's default 4.0 ft plan cut produces cut geometry",
          cut > 0,
          f"cut_paths = {cut} at the default cut; a 10 ft wall must be sliced by a "
          f"4 ft cut plane. Compare: cut at 2.0 ft gives "
          f"{len(mgr.render_2d_view(view_type='floor_plan', cut_elevation=2.0, direction='top', view_range={'cut': 2.0}).get('cut_paths') or [])} paths")

    # Contrast, for diagnosis: the sample the repo actually ships.
    ifc = BimModelManager()
    ifc.load_ifc_file(os.path.join(ROOT, "sample_building.ifc"), "sample_building.ifc")
    iw = sorted({round(float(m.get("height", 0.0)), 3) for m in ifc.element_meta.values()
                 if m.get("ifc_class") in ("IfcWall", "IfcWallStandardCase")})
    ip = ifc.render_2d_view(view_type="floor_plan", cut_elevation=4.0, direction="top",
                            view_range={"cut": 4.0})
    print(f"         contrast: sample_building.ifc has {len(ifc.element_meta)} elements, "
          f"wall heights {iw} ft, {len(ip.get('cut_paths') or [])} cut paths at the same "
          f"4.0 ft cut")

    # ---- C/D: dimension as a control ---------------------------------------
    mgr.reset_model()
    bus = bus_for(mgr)
    a, b = two_walls(mgr, bus)

    for label, locked, expect in (("C. unlocked dimension drives geometry", False, 14.0),
                                  ("D. locked dimension drives geometry", True, 14.0)):
        mgr.reset_model()
        bus = bus_for(mgr)
        a, b = two_walls(mgr, bus)
        d = make_dimension(bus, a, b, locked)
        measured = float(d["dimension"]["value"])
        res = drive(bus, expect)
        a0, a1 = endpoints(mgr, a)
        b0, b1 = endpoints(mgr, b)
        gap = b0 - a1
        check(label,
              abs(gap - expect) < 1e-6,
              f"created value={measured} ft; asked {expect} ft; "
              f"geometry now A.end={a1} B.start={b0} -> gap={gap} ft")

    # ---- E: failure honesty ------------------------------------------------
    # Creation validates only when it can derive a value: given an explicit
    # `value`, a dimension against unresolvable references is stored with
    # point-less witnesses. Driving it must then fail, and the envelope must not
    # claim it did not.
    mgr.reset_model()
    bus = bus_for(mgr)
    a, b = two_walls(mgr, bus)
    created = make_dimension(bus, a, "NO_SUCH_ELEMENT", locked=False, value=10.0)
    hint = created["dimension"]["ref_b"].get("hint")
    try:
        res = drive(bus, 14.0)
        solved = res.get("result") or {}
        nested_error = solved.get("status") == "error" or "error" in solved
        buried = nested_error and res.get("status") == "updated"
        check("E. a failed solve is visible to the caller",
              not buried,
              f"unresolvable witness stored as {hint}; envelope status="
              f"{res.get('status')!r} with nested result={solved.get('status')!r} "
              f"{solved.get('error')!r}"
              + (" — the failure is buried: a caller reading `status` sees success"
                 if buried else ""))
    except Exception as exc:  # noqa: BLE001 - an abort is a result, not a crash
        check("E. a failed solve is visible to the caller", True,
              f"transaction aborted loudly instead of reporting success: "
              f"{type(exc).__name__}: {exc}")

    # ---- F: section and elevation ------------------------------------------
    mgr.reset_model()
    bus = bus_for(mgr)
    two_walls(mgr, bus)
    counts = {}
    for vt in ("section", "elevation"):
        v = mgr.render_2d_view(view_type=vt, cut_elevation=4.0, direction="south",
                               view_range={"cut": 4.0})
        counts[vt] = len(v.get("projection_paths") or []) + len(v.get("hidden_paths") or [])
    check("F. section and elevation return linework",
          all(n > 0 for n in counts.values()),
          f"paths per view = {counts} (engine-side; the UI has no SEC renderer and "
          f"no elevation tool, so this is not reachable from the app)")

    # ---- G: the undo unit (V1 of docs/DECISION-live-edit-transaction-unit.md) --
    # A full-state snapshot must not be a SILENT fallback for commands that
    # declare no memento: it never fails, it only gets slower as models grow,
    # which is how it survived an audit, a plan and a green gate suite.
    import pathlib as _pathlib
    import re as _re

    src = _pathlib.Path(ROOT, "backend", "command_bus.py").read_text()
    body = src[src.index("def _execute_with_memento"):src.index("def execute_transaction")]
    covered = set(_re.findall(r'cmd_name == "([A-Za-z]+)"', body))
    registry = src[src.index("COMMAND_REGISTRY"):]
    registered = set(_re.findall(r'"([A-Za-z]+)":\s*[A-Za-z]+Params', registry))
    uncovered = sorted(registered - covered)
    check("G. every registered command declares its undo memento",
          not uncovered,
          f"{len(uncovered)} of {len(registered)} commands fall back to a full-state "
          f"snapshot ({len(registered) - len(uncovered)} declare one): "
          f"{', '.join(uncovered)}")

    failed = [r for r in results if not r[0]]
    print(f"\nSMOKE RESULT: {len(results) - len(failed)} passed, {len(failed)} failed")
    for ok, label, _ in failed:
        print(f"  FAILED: {label}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
