#!/usr/bin/env python3
"""
scratch/test_snap_engine.py
Gate for src/interaction/snapEngine.ts.

Verifies:
1. All six typed snap candidate kinds:
   - intersection
   - endpoint
   - midpoint
   - perpendicular
   - extension (forward and backward collinear)
   - grid
2. Snap priority hierarchy:
   intersection > endpoint > midpoint > perpendicular > extension > grid
3. Range and fallthrough guards:
   - off-axis cursor does not trigger extension (falls through to grid)
   - far-beyond-reach cursor does not trigger extension (falls through to grid)
4. Window vs Crossing selection box containment helpers:
   - isBoxInside
   - isBoxCrossing
"""

import os
import subprocess
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
GATE_SCRIPT = os.path.join(REPO_ROOT, "scripts", "check-snap-engine.mjs")


def main():
    print("=" * 78)
    print("SnapEngine Gate -- Candidate Resolution, Priority & Selection Containment")
    print("=" * 78)

    cmd = ["node", GATE_SCRIPT]
    try:
        proc = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True)
    except FileNotFoundError:
        print("Error: node is required to run snapEngine tests.")
        sys.exit(1)

    print(proc.stdout)
    if proc.stderr:
        print(proc.stderr, file=sys.stderr)

    if proc.returncode != 0:
        print("=" * 78)
        print("RESULT: FAILED")
        print("=" * 78)
        sys.exit(proc.returncode)

    print("=" * 78)
    print("RESULT: ALL CHECKS PASSED")
    print("=" * 78)
    sys.exit(0)


if __name__ == "__main__":
    main()
