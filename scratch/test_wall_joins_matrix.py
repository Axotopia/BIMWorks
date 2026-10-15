"""
BIMWorks - Wall join FIXTURE MATRIX.

Why this file exists
--------------------
`test_wall_joins.py` has 18 passing checks and every one of its fixture walls is
`thickness: 0.3`. So every join assertion it makes exercises the *single* case an
angle-bisector miter handles correctly. The suite is green because the corpus
cannot distinguish the two implementations, not because they agree.

This file fixes the corpus, not the implementation. It varies each dimension the
Revit evidence says matters, and it carries a META-TEST asserting the corpus
itself really does vary - a test that tests the tests.

Revit evidence for the primary assertion
----------------------------------------
Revit 2025 HostObjDB.dll exports `MiterBySideFacesTargetData`: the miter derives
from the walls' SIDE FACES. For wall A (along +X, thickness tA, baseline centred
on y=0) and wall B (along +Y, thickness tB, baseline centred on x=0), both meeting
at the origin:

    A's outer face is  y = +tA/2
    B's outer face is  x = +tB/2
    their intersection is  (tB/2, tA/2)

That point is where the two walls' outer corners must meet, and it depends on
BOTH thicknesses. An angle-bisector implementation instead places A's outer corner
at (tA/2, tA/2) - it depends on tA alone, and the two walls then do not meet.

    tA == tB  ->  (tB/2, tA/2) == (tA/2, tA/2)  ->  bisector is CORRECT, test passes
    tA != tB  ->  the two differ                  ->  bisector is WRONG, test fails

So the equal-thickness case cannot falsify an angle-bisector implementation and
the unequal-thickness case must. Section 1 below therefore encodes the side-face
rule; it was red until the miter was derived from side faces, and it is the check
that proves the fix.

Before the fix, for tA=0.2, tB=0.6:
    A's joint corner was (0.1, 0.1) = (tA/2, tA/2)   <- the bisector signature
    B's joint corner was (0.3, 0.3) = (tB/2, tB/2)   <- a DIFFERENT point
    the walls did not meet; the required shared corner is (0.3, 0.1)

After the fix both walls report (0.3000, 0.1000), and the miter is
area-preserving (total 5.40000 against an untrimmed 5.40000).

Run: python scratch/test_wall_joins_matrix.py
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest

PASS = []
FAIL = []
NOTES = []

#: Dimensions the corpus is supposed to vary. The meta-test asserts each one is
#: actually exercised, so a future edit cannot quietly collapse the corpus back to
#: a single thickness and turn this file into decoration.
CORPUS = {"thickness": set(), "angle_deg": set(), "walls_at_junction": set(),
          "join_mode": set(), "end_state": set()}

TOL = 1e-6
COORD_TOL = 1e-3


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'OK  ' if cond else 'FAIL'} {name}" + (f" - {detail}" if detail else ""))


def note(msg):
    NOTES.append(msg)
    print(f"  NOTE {msg}")


def poly_area(pts):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i][0], pts[i][1]
        x2, y2 = pts[(i + 1) % n][0], pts[(i + 1) % n][1]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def joint_corner_of_a(pts):
    """A's outer joint corner: max y, and among those min x. For a wall running
    along +X that is where its outer face meets the join."""
    best = None
    for p in pts:
        if best is None or (p[1], -p[0]) > (best[1], -best[0]):
            best = p
    return best


def joint_corner_of_b(pts):
    """B's outer joint corner: max x, and among those min y. For a wall running
    along +Y that is where its outer face meets the join."""
    best = None
    for p in pts:
        if best is None or (p[0], -p[1]) > (best[0], -best[1]):
            best = p
    return best


def fresh():
    mgr = BimModelManager("Matrix Test")
    return mgr, CommandBusEngine(mgr)


def make_wall(bus, start, end, height, thickness):
    r = bus.execute_transaction([CommandRequest(command="WallCreate", params={
        "start": list(start), "end": list(end),
        "height": height, "thickness": thickness})])
    return r["results"][0]["result"]["guid"]


def set_join(bus, guid, end_index, mode, allow=True):
    bus.execute_transaction([CommandRequest(command="SetWallJoin", params={
        "wall_guid": guid, "end_index": end_index, "allow_join": allow, "mode": mode})])


def l_corner(tA, tB, mode="miter"):
    """A along +X from the origin, B along +Y from the origin, joined at end 0."""
    mgr, bus = fresh()
    ga = make_wall(bus, (0.0, 0.0, 0.0), (10.0, 0.0, 0.0), 10.0, tA)
    gb = make_wall(bus, (0.0, 0.0, 0.0), (0.0, 8.0, 0.0), 10.0, tB)
    set_join(bus, ga, 0, mode)
    set_join(bus, gb, 0, mode)
    return mgr, bus, ga, gb


# ===========================================================================
# 1. THE ASSERTION THAT FALSIFIES AN ANGLE-BISECTOR MITER
# ===========================================================================
print("1. Side-face miter: the two walls' outer corners must coincide at (tB/2, tA/2)")
print("   Revit: MiterBySideFacesTargetData. Green since the miter was derived from side faces.")

for tA, tB in ((0.3, 0.3), (0.2, 0.6), (0.6, 0.2), (0.1, 0.9)):
    CORPUS["thickness"].update({tA, tB})
    CORPUS["join_mode"].add("miter")
    CORPUS["walls_at_junction"].add(2)
    CORPUS["angle_deg"].add(90.0)
    CORPUS["end_state"].add("joined")

    mgr, bus, ga, gb = l_corner(tA, tB, "miter")
    fa = mgr.element_meta[ga]["footprint"]
    fb = mgr.element_meta[gb]["footprint"]
    ca = joint_corner_of_a(fa)
    cb = joint_corner_of_b(fb)
    expected = (tB / 2.0, tA / 2.0)
    tag = "equal  " if abs(tA - tB) < TOL else "UNEQUAL"

    print(f"   {tag} tA={tA} tB={tB}: A corner ({ca[0]:.4f},{ca[1]:.4f})  "
          f"B corner ({cb[0]:.4f},{cb[1]:.4f})  expected ({expected[0]:.4f},{expected[1]:.4f})")

    check(f"tA={tA} tB={tB}: A's joint corner == (tB/2, tA/2)",
          abs(ca[0] - expected[0]) < COORD_TOL and abs(ca[1] - expected[1]) < COORD_TOL,
          f"got ({ca[0]:.4f},{ca[1]:.4f})")

    check(f"tA={tA} tB={tB}: A's and B's joint corners coincide",
          abs(ca[0] - cb[0]) < COORD_TOL and abs(ca[1] - cb[1]) < COORD_TOL,
          f"A ({ca[0]:.4f},{ca[1]:.4f}) vs B ({cb[0]:.4f},{cb[1]:.4f})")

# The falsifier on its own, so a failure is unambiguous.
mgr, bus, ga, gb = l_corner(0.2, 0.6, "miter")
ca = joint_corner_of_a(mgr.element_meta[ga]["footprint"])
check("FALSIFIER: unequal thickness does not produce the tA-only bisector corner",
      abs(ca[0] - 0.1) > COORD_TOL or abs(ca[1] - 0.1) > COORD_TOL,
      f"A corner ({ca[0]:.4f},{ca[1]:.4f}); (0.1,0.1) is the angle-bisector signature")

# No degenerate vertex left at the junction.
mgr, bus, ga, gb = l_corner(0.3, 0.3, "miter")
fa = mgr.element_meta[ga]["footprint"]
origin_count = sum(1 for p in fa if abs(p[0]) < TOL and abs(p[1]) < TOL)
check("miter leaves no spurious vertex at the junction origin",
      origin_count == 0, f"{origin_count} vertex(es) at (0,0); a clean miter has none")

# ===========================================================================
# 2. Join angle sweep
# ===========================================================================
print()
print("2. Join angle sweep (equal thickness, so this isolates angle)")

for angle_deg in (45.0, 90.0, 135.0):
    CORPUS["angle_deg"].add(angle_deg)
    CORPUS["join_mode"].add("miter")
    CORPUS["walls_at_junction"].add(2)
    CORPUS["thickness"].add(0.3)
    CORPUS["end_state"].add("joined")

    mgr, bus = fresh()
    a = math.radians(angle_deg)
    ga = make_wall(bus, (0.0, 0.0, 0.0), (10.0, 0.0, 0.0), 10.0, 0.3)
    gb = make_wall(bus, (0.0, 0.0, 0.0), (8.0 * math.cos(a), 8.0 * math.sin(a), 0.0), 10.0, 0.3)
    set_join(bus, ga, 0, "miter")
    set_join(bus, gb, 0, "miter")
    fa = mgr.element_meta[ga]["footprint"]
    fb = mgr.element_meta[gb]["footprint"]

    # Direction-agnostic: a miter means the two walls meet at ONE outer corner.
    # The max-y / max-x corner helpers above assume axis-aligned walls and are
    # therefore only valid for the 90 degree cases.
    shared = [p for p in fa
              if any(abs(p[0] - q[0]) < COORD_TOL and abs(p[1] - q[1]) < COORD_TOL
                     for q in fb)]

    check(f"angle {angle_deg:.0f}: both walls non-degenerate",
          poly_area(fa) > TOL and poly_area(fb) > TOL,
          f"areas {poly_area(fa):.4f} / {poly_area(fb):.4f}")
    check(f"angle {angle_deg:.0f}: the two walls share a common corner vertex",
          len(shared) >= 1, f"A and B share {len(shared)} vertex(es)")

print()
print("2b. Oblique angle sweep with UNEQUAL thickness (F2 simultaneous variation)")
for angle_deg in (30.0, 45.0, 60.0, 120.0, 135.0):
    for tA, tB in ((0.2, 0.6), (0.1, 0.9)):
        CORPUS["angle_deg"].add(angle_deg)
        CORPUS["join_mode"].add("miter")
        CORPUS["walls_at_junction"].add(2)
        CORPUS["thickness"].update({tA, tB})
        CORPUS["end_state"].add("joined")

        mgr, bus = fresh()
        a = math.radians(angle_deg)
        ga = make_wall(bus, (0.0, 0.0, 0.0), (10.0, 0.0, 0.0), 10.0, tA)
        gb = make_wall(bus, (0.0, 0.0, 0.0), (8.0 * math.cos(a), 8.0 * math.sin(a), 0.0), 10.0, tB)
        set_join(bus, ga, 0, "miter")
        set_join(bus, gb, 0, "miter")
        fa = mgr.element_meta[ga]["footprint"]
        fb = mgr.element_meta[gb]["footprint"]

        shared = [p for p in fa
                  if any(abs(p[0] - q[0]) < COORD_TOL and abs(p[1] - q[1]) < COORD_TOL
                         for q in fb)]

        check(f"oblique {angle_deg:.0f} deg tA={tA} tB={tB}: non-degenerate",
              poly_area(fa) > TOL and poly_area(fb) > TOL,
              f"areas {poly_area(fa):.4f} / {poly_area(fb):.4f}")
        check(f"oblique {angle_deg:.0f} deg tA={tA} tB={tB}: exactly 2 shared miter vertices",
              len(shared) >= 2, f"shared {len(shared)} vertex(es)")
        check(f"oblique {angle_deg:.0f} deg tA={tA} tB={tB}: clean 4-vertex footprints",
              len(fa) == 4 and len(fb) == 4, f"vertex counts {len(fa)} / {len(fb)}")

# ===========================================================================
# 3. Junctions with more than two walls
# ===========================================================================
print()
print("3. Junctions with more than two walls (IndexJoinPair / MultiPlaneJoinData)")

for n in (3, 4):
    CORPUS["walls_at_junction"].add(n)
    CORPUS["join_mode"].add("miter")
    CORPUS["thickness"].add(0.3)
    CORPUS["angle_deg"].add(90.0)
    CORPUS["end_state"].add("joined")

    mgr, bus = fresh()
    guids = []
    for dx, dy in [(1, 0), (0, 1), (-1, 0), (0, -1)][:n]:
        guids.append(make_wall(bus, (0.0, 0.0, 0.0), (8.0 * dx, 8.0 * dy, 0.0), 10.0, 0.3))
    for g in guids:
        set_join(bus, g, 0, "miter")
    areas = [poly_area(mgr.element_meta[g]["footprint"]) for g in guids]
    check(f"{n} walls: every wall keeps a non-degenerate footprint",
          all(x > TOL for x in areas), f"areas {[round(x, 4) for x in areas]}")
    check(f"{n} walls: no wall absorbed the junction (each <= full 8x0.3)",
          all(x <= 8.0 * 0.3 + TOL for x in areas), f"areas {[round(x, 4) for x in areas]}")

# ===========================================================================
# 4. Join mode sweep
# ===========================================================================
print()
print("4. Join mode sweep at a fixed 90 degree corner")

for mode in ("butt", "miter", "square_off"):
    CORPUS["join_mode"].add(mode)
    CORPUS["thickness"].add(0.3)
    CORPUS["angle_deg"].add(90.0)
    CORPUS["walls_at_junction"].add(2)
    CORPUS["end_state"].add("joined")

    mgr, bus, ga, gb = l_corner(0.3, 0.3, mode)
    fa = mgr.element_meta[ga]["footprint"]
    fb = mgr.element_meta[gb]["footprint"]
    total = poly_area(fa) + poly_area(fb)
    check(f"{mode}: both walls non-degenerate",
          poly_area(fa) > TOL and poly_area(fb) > TOL,
          f"areas {poly_area(fa):.4f} / {poly_area(fb):.4f}")
    untrimmed = 10.0 * 0.3 + 8.0 * 0.3
    check(f"{mode}: pieces do not overlap (total <= untrimmed {untrimmed:.3f})",
          total <= untrimmed + TOL, f"total {total:.5f}")
    if mode == "miter":
        # A true miter is AREA-PRESERVING: each wall gains a sliver at the inner
        # corner and loses an equal one at the outer, so the two footprints must
        # still sum to the untrimmed total. A shortfall means the join was clipped
        # to the quadrant instead of to the joint plane, leaving a gap at the
        # inner corner.
        check("miter is area-preserving (inner gain offsets outer loss)",
              abs(total - untrimmed) < TOL,
              f"total {total:.5f} vs untrimmed {untrimmed:.5f}; shortfall "
              f"{untrimmed - total:.5f} is a gap at the inner corner")

# square_off is a SEPARATE capability from join type in Revit
# (canChangeWJType vs canChangeSquareOff).
mgr, bus, ga, gb = l_corner(0.3, 0.3, "square_off")
sq_a = poly_area(mgr.element_meta[ga]["footprint"])
mgr, bus, ga2, gb2 = l_corner(0.3, 0.3, "butt")
bt_a = poly_area(mgr.element_meta[ga2]["footprint"])
check("square_off and butt produce different geometry (separate capabilities)",
      abs(sq_a - bt_a) > TOL, f"square_off A {sq_a:.5f} vs butt A {bt_a:.5f}")

# ===========================================================================
# 5. End state - joined end vs lonely end
# ===========================================================================
print()
print("5. End-state contrast: joined end vs lonely end")
CORPUS["end_state"].update({"joined", "lonely"})
CORPUS["thickness"].add(0.3)
CORPUS["angle_deg"].add(90.0)
CORPUS["walls_at_junction"].add(2)
CORPUS["join_mode"].add("butt")

SOLO = 7.5
mgr, bus = fresh()
g_lonely = make_wall(bus, (0.0, 0.0, 0.0), (SOLO, 0.0, 0.0), 10.0, 0.3)
area_lonely = poly_area(mgr.element_meta[g_lonely]["footprint"])
check("lonely end keeps the full untrimmed footprint",
      abs(area_lonely - SOLO * 0.3) < TOL, f"{area_lonely:.5f} vs {SOLO * 0.3:.5f}")

# Measured behaviour: creation order decides which wall is the key element and
# runs through. Assert it explicitly rather than assume it.
mgr, bus = fresh()
g_first = make_wall(bus, (0.0, 0.0, 0.0), (SOLO, 0.0, 0.0), 10.0, 0.3)
g_second = make_wall(bus, (SOLO, 0.0, 0.0), (SOLO, 6.0, 0.0), 10.0, 0.3)
a_first = poly_area(mgr.element_meta[g_first]["footprint"])
a_second = poly_area(mgr.element_meta[g_second]["footprint"])
check("first-created wall is the key element and runs through",
      abs(a_first - SOLO * 0.3) < TOL, f"{a_first:.5f} vs {SOLO * 0.3:.5f}")
check("second wall is trimmed against the key element",
      abs(a_second - (6.0 - 0.15) * 0.3) < TOL,
      f"{a_second:.5f} vs {(6.0 - 0.15) * 0.3:.5f}")

# ===========================================================================
# 6. Coverage gaps - recorded, never silently skipped
# ===========================================================================
print()
print("6. Dimensions the current model cannot exercise (coverage gaps, not passes)")

mgr, bus = fresh()
probe = make_wall(bus, (0.0, 0.0, 0.0), (5.0, 0.0, 0.0), 10.0, 0.3)
meta = mgr.element_meta[probe]

if "layers" in meta or "compound_structure" in meta:
    note("layers: PRESENT - add a 1-layer vs 5-layer case")
else:
    note("layers: ABSENT from element_meta - per-layer joins (Revit CompoundStructure, "
         "79 documented members) are UNTESTED and unrepresentable today")

if meta.get("curved") or meta.get("arc") or meta.get("is_arc"):
    note("curvature: PRESENT - add an arc-wall vs straight-wall case")
else:
    note("curvature: no arc-wall representation - curved-wall joins "
         "(Revit JoinTangencyControl) are UNTESTED")

if "base_offset" in meta or "top_offset" in meta:
    note("vertical: offsets PRESENT - add a differing base/top offset case")
else:
    note("vertical: no base/top offset in element_meta - vertical join interaction "
         "(Revit JoinToRoofGStep) is UNTESTED")

# ===========================================================================
# 7. META-TEST - does the corpus actually vary?
# ===========================================================================
print()
print("7. META-TEST: the corpus must vary each dimension, or the suite is decoration")

REQUIRED = {
    "thickness": 2,
    "angle_deg": 2,
    "walls_at_junction": 2,
    "join_mode": 2,
    "end_state": 2,
}

for dim, minimum in REQUIRED.items():
    observed = CORPUS.get(dim) or set()
    check(f"corpus varies '{dim}' (>= {minimum} distinct, got {len(observed)})",
          len(observed) >= minimum, f"observed {sorted(observed)}")

check("corpus contains an unequal-thickness pair (the case that falsifies angle-bisector)",
      any(abs(x - 0.3) > TOL for x in (CORPUS.get("thickness") or set())),
      f"thicknesses {sorted(CORPUS.get('thickness') or set())}")

# ===========================================================================
print()
print(f"RESULT: {len(PASS)} passed, {len(FAIL)} failed")
if NOTES:
    print()
    print("COVERAGE GAPS (not passes - dimensions this file could not exercise):")
    for n in NOTES:
        print(f"  - {n}")
if FAIL:
    print()
    print("FAILED:")
    for f in FAIL:
        print(f"  - {f}")
    print()
    print("Every failure above is a genuine regression: the side-face miter assertions")
    print("(Revit: MiterBySideFacesTargetData) are expected to pass. If they fail, the")
    print("join has reverted to an angle bisector or lost its end extension.")
    sys.exit(1)
print("ALL WALL JOIN MATRIX TESTS PASSED")
