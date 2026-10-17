#!/usr/bin/env python3
"""
test_memento_reversibility.py — behavioural undo coverage for the ten commands W8 added.

WHY THIS EXISTS. `scratch/_probe_engine_smoke.py` check G asserts that every registered
command *declares* a memento, by slicing `command_bus.py` as text between
`def _execute_with_memento` and `def execute_transaction` and looking for the command
name. A comment satisfies it, and it says nothing about whether undo restores anything.

That gap was not hypothetical. W8 (`71aa5ec`) added a memento for `ConstraintEqualize`
that deep-copied a whole `element_meta` entry, including the `entity` SWIG handle. The
command had worked via the snapshot fallback before W8 and **aborted on every call from
W8 onward** — `TypeError: cannot pickle 'SwigPyObject' object` — while check G stayed
green. Nothing executed these ten commands. This gate does.

Covers the ten W8 commands: SetWallJoin, ConstraintAlign, ConstraintLockDim,
ConstraintEqualize, ConstraintLockToggle, ConstraintDelete, SketchCurveAdd,
SketchCurveMoveVertex, SketchCurveMoveEdge, SketchCurveSetSlope.

For each: execute → fingerprint → undo → fingerprint, asserting the command ran, that it
changed something, and that undo restored the pre-command state. Frame/undo equivalence
with a non-drag edit is a different property and lives in `test_drag_join_deferral.py`.

Negative control: a deliberately no-op undo must fail the restore assertion, proving the
fingerprint comparison discriminates rather than always agreeing.

NOTE ON COVERAGE. This is behavioural coverage for ten commands, not all fifty. The other
forty are covered by declaration (probe check G) plus, where they have one, their own
suite (`test_session_undo_memento.py` round-trips WallCreate, WallMove, WallTrimExtend,
WallSplit, DimensionValueSet). The count is printed at the end so the claim cannot drift.
"""

import copy
import json
import os
import sys

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest, COMMAND_REGISTRY

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

# Keys that are NOT model state, excluded explicitly so that every genuine field change
# still fails the comparison:
#   geom_rev      monotonic counter advanced by every geometry write, undo included
#   bbox          derived extent, recomputed on mesh build
#   cached_verts  derived mesh geometry, invalidated (set to None) so it rebuilds lazily
#   cached_faces  derived mesh topology, same
# An undo that nulls a mesh cache has restored the model; the cache is rebuilt from the
# restored sketch/polygon, which ARE compared. Without these exclusions the gate reported
# four false failures — verified by diffing field-by-field, not assumed.
NON_STATE_KEYS = ("geom_rev", "bbox", "cached_verts", "cached_faces")


def strip_non_state(meta):
    return {g: {k: v for k, v in (md or {}).items() if k not in NON_STATE_KEYS}
            for g, md in meta.items()}


def safe(o, d=0):
    if d > 7:
        return "<deep>"
    if isinstance(o, NATIVE):
        return o
    if isinstance(o, (list, tuple)):
        return [safe(x, d + 1) for x in o]
    if isinstance(o, dict):
        return {str(k): safe(v, d + 1) for k, v in o.items()}
    return "<opaque>"


def fingerprint(m):
    """Everything these ten commands can touch, minus monotonic counters, SWIG elided."""
    return json.dumps({
        "meta": safe(strip_non_state(m.element_meta)),
        "joins": safe(getattr(m, "join_policies", {})),
        "constraints": safe(getattr(m, "constraints", {})),
        "dims": safe(getattr(m, "dimensions", {})),
    }, sort_keys=True)


def walls():
    m = BimModelManager()
    g0 = m.add_wall((0, 0, 0), (10, 0, 0), 0.5, 10.0)["guid"]
    g1 = m.add_wall((10, 0, 0), (20, 0, 0), 0.5, 10.0)["guid"]
    g2 = m.add_wall((5, 0, 0), (5, 8, 0), 0.5, 10.0)["guid"]
    return m, CommandBusEngine(m), (g0, g1, g2)


def roof():
    m = BimModelManager()
    rg = m.add_roof([(0, 0), (12, 0), (12, 10), (0, 10)], thickness=0.3, elevation=3.0)["guid"]
    m.add_sketch_curve(rg, "c1", (0.0, 0.0), (5.0, 0.0), False, None)
    return m, CommandBusEngine(m), (rg,)


def seed_align(m, ids):
    """A persisted constraint, so LockToggle/Delete have something real to act on."""
    res = m.add_align_constraint(ids[0], ids[1], "y", True)
    return res.get("id") if isinstance(res, dict) else None


CASES = [
    ("SetWallJoin", walls,
     lambda ctx: {"wall_guid": ctx["ids"][0], "end_index": 1, "allow_join": False, "mode": "square_off"}),
    ("ConstraintAlign", walls,
     lambda ctx: {"ref_guid": ctx["ids"][0], "target_guid": ctx["ids"][1], "axis": "y", "lock": True}),
    ("ConstraintLockDim", walls,
     lambda ctx: {"guid_a": ctx["ids"][0], "guid_b": ctx["ids"][1], "locked_distance": 10.0,
                  "lock": True, "axis": "x"}),
    ("ConstraintEqualize", walls,
     lambda ctx: {"span_start_guid": ctx["ids"][0], "span_end_guid": ctx["ids"][2],
                  "interior_guids": [ctx["ids"][1]], "axis": "x"}),
    ("ConstraintLockToggle", walls,
     lambda ctx: {"constraint_id": ctx["cid"], "is_locked": False}, seed_align),
    ("ConstraintDelete", walls,
     lambda ctx: {"constraint_id": ctx["cid"]}, seed_align),
    ("SketchCurveAdd", roof,
     lambda ctx: {"guid": ctx["ids"][0], "curve_id": "c2", "start": [5.0, 0.0], "end": [10.0, 0.0],
                  "defines_slope": False, "slope_angle": None}),
    ("SketchCurveMoveVertex", roof,
     lambda ctx: {"guid": ctx["ids"][0], "curve_id": "c1", "end_index": 1, "to": [6.0, 2.0]}),
    ("SketchCurveMoveEdge", roof,
     lambda ctx: {"guid": ctx["ids"][0], "curve_id": "c1", "dx": 1.5, "dy": 0.0}),
    ("SketchCurveSetSlope", roof,
     lambda ctx: {"guid": ctx["ids"][0], "curve_id": "c1", "defines_slope": True, "slope_angle": 30.0}),
]


print("\n=== RUNNING MEMENTO REVERSIBILITY GATE (W8's ten commands) ===")

behaviourally_covered = []
for case in CASES:
    name, builder, params_fn = case[0], case[1], case[2]
    setup = case[3] if len(case) > 3 else None

    m, b, ids = builder()
    ctx = {"m": m, "b": b, "ids": ids}
    if setup:
        ctx["cid"] = setup(m, ids)
        if not ctx["cid"]:
            check(f"{name}: scenario seeded a real constraint", False)
            continue
    params = params_fn(ctx)

    before = fingerprint(m)
    try:
        b.execute_transaction([CommandRequest(command=name, params=params)])
    except Exception as e:
        check(f"{name}: executes", False, f"{type(e).__name__}: {str(e)[:90]}")
        continue
    check(f"{name}: executes", True)

    changed = fingerprint(m) != before
    check(f"{name}: changed model state", changed)
    if not changed:
        continue

    try:
        b.undo()
    except Exception as e:
        check(f"{name}: undo restores pre-command state", False, f"undo raised {type(e).__name__}: {str(e)[:80]}")
        continue
    restored = fingerprint(m) == before
    check(f"{name}: undo restores pre-command state", restored,
          "state fingerprint matches" if restored else "STATE NOT RESTORED")
    if restored:
        behaviourally_covered.append(name)

# --- The one real state defect this gate found, asserted directly -------------
# `_mutate_sketch` writes `pitch` from the slope curve and never clears it, so undoing
# SketchCurveSetSlope left the roof at the new pitch while the sketch reverted. The
# generic loop above only says "some field differed"; this pins the specific field.
_m, _b, _ids = roof()
_pitch_before = _m.element_meta[_ids[0]].get("pitch")
_b.execute_transaction([CommandRequest(command="SketchCurveSetSlope",
                                       params={"guid": _ids[0], "curve_id": "c1",
                                               "defines_slope": True, "slope_angle": 30.0})])
_pitch_after = _m.element_meta[_ids[0]].get("pitch")
_b.undo()
_pitch_undone = _m.element_meta[_ids[0]].get("pitch")
check("SketchCurveSetSlope: command moved pitch", _pitch_after != _pitch_before,
      f"{_pitch_before} -> {_pitch_after}")
check("SketchCurveSetSlope: undo restores pitch (not just the sketch)",
      _pitch_undone == _pitch_before,
      f"pitch back to {_pitch_undone} (expected {_pitch_before})")

# --- Negative control: the comparison must be able to disagree ---------------
_m, _b, _ids = walls()
_before = fingerprint(_m)
_b.execute_transaction([CommandRequest(command="SetWallJoin",
                                       params={"wall_guid": _ids[0], "end_index": 1,
                                               "allow_join": False, "mode": "square_off"})])
noop_undo_state = fingerprint(_m)   # simulate an undo that did nothing
check("negative control: a no-op undo fails the restore assertion",
      noop_undo_state != _before,
      "the fingerprint comparison discriminates")

# --- Coverage statement, asserted so it cannot drift ------------------------
declared = set(COMMAND_REGISTRY.keys())
check("all ten W8 commands are registered", all(c[0] in declared for c in CASES))
check(f"behavioural undo coverage: {len(behaviourally_covered)}/10 W8 commands",
      len(behaviourally_covered) == 10,
      f"covered={sorted(behaviourally_covered)}")

print(f"\n  coverage: {len(behaviourally_covered)} of {len(CASES)} W8 commands behaviourally "
      f"verified; {len(declared)} commands registered and declaration-checked by probe G")
print("  note: this is NOT behavioural coverage of all registered commands — "
      "see the module docstring")

print("\n------------------------------------------------------------------------")
print(f"MEMENTO REVERSIBILITY GATE: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
