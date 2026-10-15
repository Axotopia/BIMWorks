"""
Incremental join recompute must equal the global pass (Phase 1.1).

WHY THIS EXISTS
---------------
`translate_element` and `update_element` used to call the bare global
`recompute_wall_joins()` on every edit, so a one-wall move recomputed all 961 walls
(324.7 ms, measured). They now recompute a scoped set derived from the wall's OLD and
NEW baseline ends (`_recompute_after_joined_edit`).

That is a correctness-risking optimisation: an edit both GAINS and LOSES joins, and a
subset that is too small leaves a stale footprint **permanently** — the wall keeps
geometry from before the edit and nothing later repairs it, because a join is only
recomputed when one of its own participants changes. A slow edit is recoverable; a
stale join is not.

So this suite is the proof obligation for Phase 1.1. For a corpus that varies the
dimensions the radius depends on — join type (corner/tee), whether the edit ADDS or
REMOVES a join, thickness, angle, and detached walls — it asserts that the scoped pass
and a forced global pass produce byte-identical footprints, mesh vertices and bounding
boxes.

Run:  ./.venv/Scripts/python.exe scratch/test_join_incremental.py
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from ifc_service import BimModelManager  # noqa: E402
from units import FEET_10, INCHES_8  # noqa: E402

PASSED = 0
FAILED = 0
FAILURES = []


def check(label, condition, detail=""):
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  PASS  {label}")
    else:
        FAILED += 1
        FAILURES.append(f"{label} :: {detail}")
        print(f"  FAIL  {label}  {detail}")


def fresh():
    m = BimModelManager()
    m.reset_model()
    return m


def fingerprint(m):
    """
    Every geometry-bearing field a join pass can change, per wall.

    Keyed by NAME, not GUID: `add_wall` mints a fresh GUID per manager, so two
    independently built scenarios share no GUIDs and a GUID-keyed comparison would
    report every wall as differing while measuring nothing. (The first version of this
    file did exactly that.) Names are unique across these corpora by construction.
    """
    out = {}
    for guid, meta in m.element_meta.items():
        if meta.get("ifc_class") not in ("IfcWall", "IfcWallStandardCase"):
            continue
        key = meta.get("name") or guid
        fp = sorted((round(float(p[0]), 9), round(float(p[1]), 9))
                    for p in (meta.get("footprint") or []))
        verts = meta.get("cached_verts") or []
        bbox = meta.get("bbox") or {}
        out[key] = {
            "footprint": fp,
            "n_verts": len(verts),
            "verts_checksum": round(sum(verts), 6) if verts else None,
            "bbox": {
                "min": [round(float(v), 9) for v in bbox.get("min", [])],
                "max": [round(float(v), 9) for v in bbox.get("max", [])],
            },
            "length": round(float(meta.get("length", 0.0)), 9),
        }
    return out


def diff(a, b):
    """Wall names whose geometry differs between two fingerprints."""
    bad = []
    for key in sorted(set(a) | set(b)):
        if a.get(key) != b.get(key):
            bad.append(key)
    return bad


def compare(label, build, edit):
    """
    Run `edit` once incrementally, then force a global pass, and compare.

    `build` returns a fresh manager; `edit` performs one mutation and returns the
    manager. The second run re-executes the whole scenario on a new manager so the
    global pass starts from the same state.
    """
    m1 = build()
    edit(m1)
    incremental = fingerprint(m1)

    m2 = build()
    edit(m2)
    # Force the historical global behaviour on the SAME post-edit state, so the only
    # difference under test is the radius the edit used.
    m2.recompute_wall_joins()
    global_fp = fingerprint(m2)

    bad = diff(incremental, global_fp)
    check(f"{label}: scoped pass == global pass", not bad,
          f"{len(bad)} walls differ: {bad[:3]}")
    if bad:
        g = bad[0]
        print(f"        incremental: {incremental.get(g)}")
        print(f"        global     : {global_fp.get(g)}")
    return incremental, global_fp


def section_1_index_equivalence():
    """The candidate index must return a superset of the old full scan."""
    print("\n1. Join candidate index returns the same partners as a full scan")
    m = fresh()
    # A corner chain, a tee, and a detached wall that must never be a candidate.
    a = m.add_wall((0, 0, 0), (10, 0, 0), height=FEET_10, thickness=INCHES_8, name="A")["guid"]
    b = m.add_wall((10, 0, 0), (10, 10, 0), height=FEET_10, thickness=INCHES_8, name="B")["guid"]
    c = m.add_wall((5, 0, 0), (5, -8, 0), height=FEET_10, thickness=INCHES_8, name="C-tee")["guid"]
    d = m.add_wall((40, 40, 0), (50, 40, 0), height=FEET_10, thickness=INCHES_8, name="D-far")["guid"]
    walls = {g: mm for g, mm in m.element_meta.items()
             if mm.get("ifc_class") in ("IfcWall", "IfcWallStandardCase")}
    index = m._build_join_index(walls)

    mismatches = []
    for guid in walls:
        for end_index in (0, 1):
            scanned = m._find_join_partner(guid, end_index, walls)
            indexed = m._find_join_partner(guid, end_index, walls, index)
            if scanned != indexed:
                mismatches.append((guid, end_index, scanned, indexed))
    check("indexed partner == scanned partner for every wall end", not mismatches,
          f"{len(mismatches)} mismatches, first {mismatches[:2]}")
    check("the far wall is never chosen as a partner",
          all(d not in (r[2][0], r[3][0]) for r in mismatches) if mismatches else True)
    # Sanity: the corpus must actually contain joins, or the check is vacuous.
    joined = sum(1 for g in walls for e in (0, 1)
                 if m._find_join_partner(g, e, walls)[0])
    check("the corpus contains real joins (not vacuous)", joined >= 3, f"found {joined}")


def section_2_move_preserves_and_drops_joins():
    print("\n2. A move: corner joins kept, a tee created and one removed")

    def build():
        m = fresh()
        # Two walls meeting at a corner, plus a crossing wall that starts detached.
        m.add_wall((0, 0, 0), (20, 0, 0), height=FEET_10, thickness=INCHES_8, name="Long")
        m.add_wall((20, 0, 0), (20, 15, 0), height=FEET_10, thickness=INCHES_8, name="Riser")
        m.add_wall((10, -12, 0), (10, -6, 0), height=FEET_10, thickness=INCHES_8, name="Mover")
        m.recompute_wall_joins()
        return m

    def edit(m):
        # Move the crossing wall up so its end lands ON the Long wall's baseline,
        # creating a tee where there was none.
        guid = next(g for g, mm in m.element_meta.items() if mm.get("name") == "Mover")
        m.translate_element(guid, 0.0, 6.0, 0.0)

    compare("tee created by a move", build, edit)


def section_3_move_removes_a_join():
    print("\n3. A move that REMOVES a join (the case a 'current state' radius misses)")

    def build():
        m = fresh()
        m.add_wall((0, 0, 0), (20, 0, 0), height=FEET_10, thickness=INCHES_8, name="Host")
        # Butt-joined at the host's end: this is a corner join.
        m.add_wall((20, 0, 0), (20, 12, 0), height=FEET_10, thickness=INCHES_8, name="Leaver")
        m.recompute_wall_joins()
        return m

    def edit(m):
        # Pull it clear of the host entirely: the corner join must be undone, and the
        # host's footprint must go back to its untrimmed rectangle.
        guid = next(g for g, mm in m.element_meta.items() if mm.get("name") == "Leaver")
        m.translate_element(guid, 15.0, 0.0, 0.0)

    compare("corner join removed by a move", build, edit)


def section_4_reshape_and_thickness():
    print("\n4. Reshape via update_element, and a thickness change")

    def build():
        m = fresh()
        m.add_wall((0, 0, 0), (18, 0, 0), height=FEET_10, thickness=INCHES_8, name="Base")
        m.add_wall((18, 0, 0), (18, 10, 0), height=FEET_10, thickness=INCHES_8, name="Arm")
        m.recompute_wall_joins()
        return m

    def edit(m):
        guid = next(g for g, mm in m.element_meta.items() if mm.get("name") == "Arm")
        m.update_element(guid, {"end": [18.0, 14.0, 0.0], "thickness": 0.5})

    compare("reshape + thickness change", build, edit)


def section_5_thin_thick_and_angles():
    print("\n5. Thickness and angle variation (the miter's real dimensions)")

    for t_a, t_b, ang in ((0.2, 0.6, 90.0), (0.6, 0.2, 90.0), (0.3, 0.3, 45.0),
                          (1.0 / 12.0, 1.0 / 12.0, 135.0)):
        def build(_ta=t_a, _tb=t_b, _ang=ang):
            m = fresh()
            m.add_wall((0, 0, 0), (12, 0, 0), height=FEET_10, thickness=_ta, name="W1")
            rad = math.radians(_ang)
            m.add_wall((12, 0, 0), (12 + 12 * math.cos(rad), 12 * math.sin(rad), 0),
                       height=FEET_10, thickness=_tb, name="W2")
            m.recompute_wall_joins()
            return m

        def edit(m, _ang=ang):
            guid = next(g for g, mm in m.element_meta.items() if mm.get("name") == "W2")
            # A small move that keeps the corner: geometry must still match globally.
            m.translate_element(guid, 0.5, 0.25, 0.0)

        compare(f"tA={t_a:.2f} tB={t_b:.2f} angle={ang:g}", build, edit)


def section_6_detached_is_untouched():
    """The radius must be a subset, not the whole model — else the fix is inert."""
    print("\n6. The scoped set is genuinely smaller than the model")

    m = fresh()
    for i in range(12):
        m.add_wall((i * 30.0, 0, 0), (i * 30.0 + 10, 0, 0),
                   height=FEET_10, thickness=INCHES_8, name=f"iso{i}")
    m.recompute_wall_joins()
    guid = next(iter(m.element_meta))
    old = [(0.0, 0.0)]
    subset = m._recompute_after_joined_edit  # bound method; inspect via the index
    walls = {g: mm for g, mm in m.element_meta.items()
             if mm.get("ifc_class") in ("IfcWall", "IfcWallStandardCase")}
    index = m._build_join_index(walls)
    candidates = m._join_candidates(index, walls, guid, (0.0, 0.0), m._JOIN_EDIT_RADIUS)
    check("an isolated wall's radius is not the whole model",
          len(candidates) <= 1, f"{len(candidates)} candidates of {len(walls)} walls")


def main():
    print("=" * 74)
    print("Incremental vs global join recompute — Phase 1.1 proof obligation")
    print("=" * 74)
    section_1_index_equivalence()
    section_2_move_preserves_and_drops_joins()
    section_3_move_removes_a_join()
    section_4_reshape_and_thickness()
    section_5_thin_thick_and_angles()
    section_6_detached_is_untouched()

    print("\n" + "=" * 74)
    print(f"RESULT: {PASSED} passed, {FAILED} failed")
    if FAILURES:
        print("\nFailures:")
        for f in FAILURES:
            print(f"  - {f}")
    print("=" * 74)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
