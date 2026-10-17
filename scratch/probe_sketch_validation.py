#!/usr/bin/env python3
"""
Reproduction probe: BIMWorks sketch boundary validation.

Companion to REVIEW-ingetrazo-object-creation-and-editing-2026-10-15.md, section 4.2.
Read-only: imports backend/sketch_model.py and calls it. Modifies nothing.

    python3 probe-sketch-validation.py

`backend/sketch_model.py` imports only `dataclasses` and `typing`, so this runs
without numpy / ifcopenshell installed.

What it shows (findings verified 2026-10-15 against BIMWorks@cc213fc and
re-verified unchanged at 22705ce; `backend/sketch_model.py` and
`backend/ifc_service.py` are identical across those two commits):

  1. An OPEN 3-segment chain reports is_closed() == True and validate() == None,
     and its footprint() is identical to the closed triangle's. So the only gate
     on the sketch commit path (ifc_service.py:644-649, reached from _edit_sketch
     and therefore from BOTH editing skins) does not reject an open boundary, and
     the missing closing edge is inferred rather than reported.

  2. Crossing segments ARE refused by validate() (fair), but footprint() still
     returns a self-intersecting 6-point fallback polygon for that input.

  3. A spur of >= 3 segments is reported as a SECOND closed loop, even though it
     is open. closed_loops() is the function whose docstring says it exists to
     distinguish a closed footprint from interior slope lines, so that
     distinction cannot be trusted for chains of >= 3 segments.

  4. Only the largest loop becomes footprint(). Two rooms drawn as two closed
     loops yield one slab; an inner loop (atrium, shaft) is dropped, not nested
     as a hole.

For contrast, IngeTrazo solves all four deterministically with a DCEL planar
arrangement and asserts exactly these cases in tests/test_arrangement.py.
"""
import sys
from pathlib import Path


def _backend_dir() -> Path:
    """Locate BIMWorks' backend/ wherever this script happens to be placed:
    <repo>/review/, <repo>/, or a workspace holding the checkout beside it."""
    here = Path(__file__).resolve().parent
    for candidate in (
        here.parent / "backend",          # <repo>/review/probe-*.py
        here / "backend",                 # <repo>/probe-*.py
        here / "BIMWorks" / "backend",    # <workdir>/probe-*.py beside a checkout
    ):
        if (candidate / "sketch_model.py").is_file():
            return candidate
    raise SystemExit(
        "Could not find backend/sketch_model.py. Run this from the BIMWorks "
        "repo root or its review/ folder, or add your checkout path to the "
        "candidate list above.")


BACKEND = _backend_dir()
sys.path.insert(0, str(BACKEND))

from sketch_model import Sketch, SketchCurve  # noqa: E402


def sk(kind, segs, tol=1e-6):
    return Sketch(
        kind=kind,
        curves=[SketchCurve(id=f"c{i}", start=a, end=b) for i, (a, b) in enumerate(segs)],
        tolerance=tol,
    )


def report(name, sketch):
    loops = sketch.closed_loops()
    print(f"--- {name}")
    print(f"    is_closed() = {sketch.is_closed():<5} loops = {len(loops)}  "
          f"validate() = {sketch.validate()!r}")
    print(f"    footprint() = {sketch.footprint()}")
    for i, ring in enumerate(loops):
        print(f"      loop[{i}] ({len(ring)} pts) = {ring}")


SQ = [((0, 0), (4, 0)), ((4, 0), (4, 4)), ((4, 4), (0, 4)), ((0, 4), (0, 0))]

print("=" * 78)
print("1. OPEN 3-segment chain -- the third edge (4,3)->(0,3) is never drawn")
print("=" * 78)
report("open chain", sk("floor", [((0, 0), (4, 0)), ((4, 0), (4, 3)), ((4, 3), (0, 3))]))
report("closed triangle (control)", sk("floor", [((0, 0), (4, 0)), ((4, 0), (4, 3)), ((4, 3), (0, 0))]))
print("    => identical is_closed/validate/footprint: nothing downstream can tell")
print("       that the closing edge was never drawn.\n")

print("=" * 78)
print("2. Crossing segments (X), endpoint-disjoint")
print("=" * 78)
report("X + a side", sk("floor", [((0, 0), (4, 4)), ((0, 4), (4, 0)), ((0, 0), (0, 4))]))
print("    => validate() refuses (good), but footprint() is still a")
print("       self-intersecting fallback polygon.\n")

print("=" * 78)
print("3. Closed square + spur of 3 segments")
print("=" * 78)
report("square + 3-segment spur",
       sk("floor", SQ + [((4, 0), (6, 0)), ((6, 0), (6, 2)), ((6, 2), (8, 0))]))
print("    => the OPEN spur is reported as loop[1], a second 'closed' loop.\n")

print("=" * 78)
print("4. Two rooms / inner loop")
print("=" * 78)
report("two separate squares",
       sk("floor", SQ + [((6, 0), (10, 0)), ((10, 0), (10, 4)), ((10, 4), (6, 4)), ((6, 4), (6, 0))]))
report("outer square + inner square",
       sk("floor", SQ + [((1, 1), (2, 1)), ((2, 1), (2, 2)), ((2, 2), (1, 2)), ((1, 2), (1, 1))]))
print("    => footprint() is the LARGEST loop only; the second is dropped,")
print("       never nested as a hole.")
