"""
Probe — Phase 0: adversarial properties of backend/references.py.

Backs the Phase 0 findings in review/archive/REVIEW-geometric-references-refactor-2026-10-15.md.

These are deliberately NOT the shipped assertions in `scratch/test_references.py`; they probe the
key/identity semantics the plan (§5.1) calls the actual risk, plus the §3.3 decisions.

Findings exercised here:
  * `reference_key` for unresolved points. An earlier revision of this probe asserted only that two
    inline dict literals differ — which a memory-address-based key satisfies trivially — so it did not
    establish the plan's contract ("canonical, order-stable, for dedup + equality"). That weakness is
    recorded here deliberately: the key was briefly made non-deterministic via `str(id(ref))`, and
    this probe did not catch it. Stability is asserted properly in the dedicated probe
    `scratch/_probe_reference_key_stability.py`. The key is now a deterministic sentinel, and the
    assertions below pin that behaviour down explicitly, including that identity comes from `guid`/`id`.
  * §3.3.1 is unresolved: 2D `level_plane` still returns (0.0, elevation) labelled "exact", while
    the axis form that fixes it is never called by production code.
  * §3.3.2: the level NAME fallback was retained (relabelled "repaired"), not dropped.
  * `wall_face_*` resolution ignores `ordinal` even though the key uses it.
  * A diagonal `grid_axis` asked for one axis returns the grid MIDPOINT labelled "exact".

The unresolved-point assertions below document INTENDED behaviour (they are not defect checks):
hint-less points share one deterministic sentinel by design. The genuine findings are the §3.3 items,
`wall_face_*` ordinal, and the diagonal-grid substitution.
Run:  .venv/bin/python scratch/_probe_references_adversarial.py
"""

import copy
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from references import (  # noqa: E402
    normalize_reference,
    reference_key,
    resolve_reference,
    resolve_reference_axis,
)

FAILS = []


class M:
    def __init__(self):
        self.levels = {"lv1": {"name": "Level 1", "elevation": 10.0}}
        self.element_meta = {
            "w1": {"start": [0, 0, 0], "end": [10, 0, 0], "thickness": 0.5, "elevation": 0.0},
            "w2": {"start": [5, -5, 0], "end": [5, 5, 0], "thickness": 0.5, "elevation": 0.0},
        }
        self.grids = {}


def ck(label, cond, extra=""):
    print(("  OK   " if cond else " FAIL  ") + label + (f" | {extra}" if extra else ""))
    if not cond:
        FAILS.append(label)


def main() -> int:
    m = M()

    print("== 1. normalize_reference idempotency ==")
    legacy = {"guid": "w1", "ref": "start", "point": [1.0, 2.0, 0.0]}
    n1 = normalize_reference(legacy)
    ck("idempotent (1 == 2)", n1 == normalize_reference(n1))
    ck("idempotent (2 == 3)", n1 == normalize_reference(normalize_reference(n1)))

    print("== 2. reference_key semantics (plan §5.1) ==")
    i_ab = {"kind": "intersection", "sources": [{"element_guid": "w1"}, {"element_guid": "w2"}],
            "hint": {"point": None, "normal": None}}
    i_ba = {"kind": "intersection", "sources": [{"element_guid": "w2"}, {"element_guid": "w1"}],
            "hint": {"point": None, "normal": None}}
    ck("multi-source key is order-stable", reference_key(i_ab) == reference_key(i_ba),
       reference_key(i_ab))
    single = {"kind": "wall_start", "sources": [{"element_guid": "w1"}],
              "hint": {"point": None, "normal": None}}
    ck("multi-source key does not collide with a single source", reference_key(i_ab) != reference_key(single))
    ck("ordinal participates in identity",
       reference_key({"kind": "wall_face_pos", "sources": [{"element_guid": "w1", "ordinal": 0}]})
       != reference_key({"kind": "wall_face_pos", "sources": [{"element_guid": "w1", "ordinal": 1}]}))
    p_unres = {"kind": "point", "sources": [], "hint": {"point": None, "normal": None}}
    key_unres = reference_key(p_unres)
    ck("unresolved point key is deterministic sentinel", key_unres == "point:unresolved", key_unres)
    ck("unresolved point key is stable across deepcopy", reference_key(copy.deepcopy(p_unres)) == key_unres)
    ck("unresolved point key is stable across JSON round-trip", reference_key(json.loads(json.dumps(p_unres))) == key_unres)
    ck("unresolved point key is stable across normalize_reference", reference_key(normalize_reference(p_unres)) == key_unres)
    ck("points with distinct guid/id keep distinct identity",
       reference_key({"kind": "point", "guid": "pt1"}) != reference_key({"kind": "point", "guid": "pt2"}))

    print("== 3. resolution never returns a silent (0, 0) ==")
    for ref in [{"guid": "nope", "ref": "start"}, {"level_id": "nope"},
                {"kind": "wall_start", "sources": [{"element_guid": "ghost"}]}, {"kind": "point"}]:
        pt, out = resolve_reference(m, ref)
        ck(f"lost, not (0,0): {out}", pt is None and out == "lost", pt)

    print("== 4. §3.3.1 level_plane in 2D is still (0.0, elev) labelled 'exact' ==")
    pt, out = resolve_reference(m, {"level_id": "lv1"})
    ck("level 2D returns (0.0, elev) as 'exact'", pt == (0.0, 10.0) and out == "exact", (pt, out))
    xv, xout = resolve_reference_axis(m, {"level_id": "lv1"}, "x")
    ck("axis form reports X as ambiguous", xv is None and xout == "ambiguous", (xv, xout))
    zv, zout = resolve_reference_axis(m, {"level_id": "lv1"}, "z")
    ck("axis form resolves Z elevation", zv == 10.0 and zout == "exact", (zv, zout))

    print("== 5. §3.3.2 level NAME fallback retained (plan said drop) ==")
    pt, out = resolve_reference(m, {"level_id": "Level 1"})
    ck("name fallback still resolves, relabelled 'repaired'", pt == (0.0, 10.0) and out == "repaired",
       (pt, out))

    print("== 6. wall_face_* resolution ignores ordinal ==")
    p0, _ = resolve_reference(m, {"kind": "wall_face_pos", "sources": [{"element_guid": "w1", "ordinal": 0}]})
    p1, _ = resolve_reference(m, {"kind": "wall_face_pos", "sources": [{"element_guid": "w1", "ordinal": 1}]})
    ck("ordinal 0 and 1 resolve identically (ordinal unused)", p0 == p1, (p0, p1))

    print("== 7. diagonal grid_axis on the axis form ==")
    m.element_meta["gd"] = {"start": [0, 0], "end": [10, 10]}
    gx, gout = resolve_reference_axis(m, {"kind": "grid_axis", "sources": [{"element_guid": "gd"}]}, "x")
    ck("diagonal grid returns a midpoint labelled 'exact' (silent substitution)",
       gout == "exact", (gx, gout))

    print()
    print("ADVERSARIAL FAILURES:", FAILS if FAILS else "none")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
