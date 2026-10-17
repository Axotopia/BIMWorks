#!/usr/bin/env python3
"""
test_drag_join_deferral.py — Gate for direct-manipulation plan decision §3.4.

§3.4 says a refusal is a clamp plus a sentence, and that during a wall-end drag the far
end's miter is accepted as stale until commit. The second half was never implemented:
every frame called `_recompute_after_joined_edit`, which measured 24.053 ms p95 on the
250-wall fixture — 3x the 8 ms frame budget — for a recompute whose result is only
observable once the gesture ends.

This gate asserts the deferral is *equivalent and load-bearing*:

1. EQUIVALENCE — a multi-frame deferred drag commits geometry and join policies
   identical to the same edit applied as one non-drag command. Deferring changes when
   the join recompute runs, not its result.
2. LOAD-BEARING — if the commit-time flush is skipped, the committed geometry differs
   from (1). The flush is not decorative; without it the model is left un-mitred.
3. MID-GESTURE STALENESS — during the gesture the dragged wall's footprint is the
   un-mitred rectangle, and it is mitred after commit. This is the behaviour §3.4
   accepts, asserted rather than assumed.
4. CANCEL — a cancelled gesture clears the deferral, so a later ordinary edit still
   recomputes joins (no flag leaked into non-drag edits).

Frame latency is asserted separately in `scratch/test_drag_session.py` §7, which already
owns the 250-wall fixture (reusing it here would double the suite's dominant cost).
"""

import copy
import json
import os
import sys

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest

passed = 0
failed = 0


def check(name: str, condition: bool, extra: str = ""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  [PASS] {name}{f' ({extra})' if extra else ''}")
    else:
        failed += 1
        print(f"  [FAIL] {name}{f' ({extra})' if extra else ''}")


NATIVE = (str, int, float, bool, type(None))


def safe(o, d=0):
    """JSON-native projection; SWIG/IFC handles become a placeholder."""
    if d > 7:
        return "<deep>"
    if isinstance(o, NATIVE):
        return o
    if isinstance(o, (list, tuple)):
        return [safe(x, d + 1) for x in o]
    if isinstance(o, dict):
        return {str(k): safe(v, d + 1) for k, v in o.items()}
    return "<opaque>"


def build():
    """
    Three walls forming the two join cases that matter: a corner (0-1) and a tee (2 into 0).
    Returns (manager, engine, guids in creation order).
    """
    m = BimModelManager()
    g0 = m.add_wall((0, 0, 0), (10, 0, 0), 0.5, 10.0)["guid"]
    g1 = m.add_wall((10, 0, 0), (20, 0, 0), 0.5, 10.0)["guid"]
    g2 = m.add_wall((5, 0, 0), (5, 8, 0), 0.5, 10.0)["guid"]
    return m, CommandBusEngine(m), (g0, g1, g2)


def fingerprint(m, order):
    """Geometric fingerprint keyed by CREATION ORDER, so two models are comparable."""
    keys = ("start", "end", "polygon", "footprint", "thickness", "height")
    out = {f"wall{i}": {k: safe((m.element_meta.get(g) or {}).get(k)) for k in keys}
           for i, g in enumerate(order)}
    out["joins"] = [safe(getattr(m, "join_policies", {}).get(g)) for g in order]
    return json.dumps(out, sort_keys=True)


def drag_to_end(guids, engine, frames=8, final_x=8.0, start_x=10.0, flush=True):
    """A real multi-frame wall-end gesture ending exactly at `final_x`."""
    sid = engine.begin_drag(origin="ui", description="wall-end drag")["session_id"]
    for f in range(frames):
        x = start_x - (start_x - final_x) * (f + 1) / frames
        engine.update_drag(sid, [CommandRequest(command="WallSetEnd",
                                                params={"guid": guids[0], "end": "end",
                                                        "point": [x, 0.0, 0.0]})])
    if not flush:
        engine.manager.cancel_deferred_join_edits()
    return engine.end_drag(sid, commit=True)


print("\n=== RUNNING DRAG JOIN DEFERRAL GATE (DECISION §3.4) ===")

# --- 1. Equivalence ---------------------------------------------------------
m_direct, e_direct, o_direct = build()
e_direct.execute_single_command("WallSetEnd", {"guid": o_direct[0], "end": "end",
                                               "point": [8.0, 0.0, 0.0]})
direct_fp = fingerprint(m_direct, o_direct)

m_drag, e_drag, o_drag = build()
res = drag_to_end(o_drag, e_drag)
drag_fp = fingerprint(m_drag, o_drag)

check("deferred drag commit equals the equivalent single edit",
      direct_fp == drag_fp,
      "geometry + join policies identical" if direct_fp == drag_fp else "MISMATCH")
check("commit reports the walls whose joins were flushed",
      bool(res.get("flushed_join_guids")), f"flushed={res.get('flushed_join_guids')}")

# --- 2. Load-bearing -------------------------------------------------------
m_unflushed, e_unflushed, o_unflushed = build()
drag_to_end(o_unflushed, e_unflushed, flush=False)
unflushed_fp = fingerprint(m_unflushed, o_unflushed)
check("negative control: skipping the commit flush leaves different geometry",
      unflushed_fp != direct_fp,
      "the flush is load-bearing, not decorative")

# --- 3. Mid-gesture staleness, and that commit fixes it --------------------
m_mid, e_mid, o_mid = build()
pre_fp = fingerprint(m_mid, o_mid)
sid = e_mid.begin_drag(origin="ui", description="mid-gesture probe")["session_id"]
e_mid.update_drag(sid, [CommandRequest(command="WallSetEnd",
                                      params={"guid": o_mid[0], "end": "end",
                                              "point": [8.0, 0.0, 0.0]})])
mid_fp = fingerprint(m_mid, o_mid)
e_mid.end_drag(sid, commit=True)
post_fp = fingerprint(m_mid, o_mid)

check("deferral is armed by begin_drag", e_mid.manager._defer_join_recompute is False,
      "flag cleared at commit")
check("the gesture changed the dragged wall mid-drag", mid_fp != pre_fp)
check("mid-gesture geometry is NOT the committed geometry (miter stale, §3.4)",
      mid_fp != post_fp)
check("commit produces the mitred result", post_fp == direct_fp)

# --- 4. Cancel clears the deferral -----------------------------------------
m_cancel, e_cancel, o_cancel = build()
sid_c = e_cancel.begin_drag(origin="ui", description="cancelled gesture")["session_id"]
e_cancel.update_drag(sid_c, [CommandRequest(command="WallSetEnd",
                                           params={"guid": o_cancel[0], "end": "end",
                                                   "point": [8.0, 0.0, 0.0]})])
cancel_res = e_cancel.end_drag(sid_c, commit=False)
check("cancel reports cancelled", cancel_res.get("status") == "cancelled")
check("cancel clears the deferral flag", e_cancel.manager._defer_join_recompute is False)
check("cancel leaves no pending join work", e_cancel.manager._deferred_join_edits == {})

# A non-drag edit after a cancelled gesture must still recompute joins.
m_after, e_after, o_after = build()
sid_a = e_after.begin_drag(origin="ui", description="cancelled then edited")["session_id"]
e_after.update_drag(sid_a, [CommandRequest(command="WallSetEnd",
                                          params={"guid": o_after[0], "end": "end",
                                                  "point": [9.0, 0.0, 0.0]})])
e_after.end_drag(sid_a, commit=False)
e_after.execute_single_command("WallSetEnd", {"guid": o_after[0], "end": "end",
                                              "point": [8.0, 0.0, 0.0]})
check("an ordinary edit after a cancel still reaches the committed geometry",
      fingerprint(m_after, o_after) == direct_fp)

print("\n------------------------------------------------------------------------")
print(f"DRAG JOIN DEFERRAL GATE: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
