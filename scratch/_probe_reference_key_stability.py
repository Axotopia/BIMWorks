"""
Probe — P0: `reference_key` is non-deterministic for unresolved point references.

Backs the P0 finding in review/archive/REVIEW-geometric-references-fixes-2026-10-15.md.

The fix for the original "all unresolved points collapse to point:unresolved" collision was:

    uid = norm.get("id") or norm.get("guid") or str(id(ref))

`id(ref)` is the CPython memory address of the dict — an allocation detail, not an identity. A key
built from it cannot satisfy the contract the plan states for this function
(IMPLEMENTATION-PLAN-geometric-references.md §3.1: "canonical, order-stable, for dedup + equality";
§5.1: "The identity model is the risk").

This probe therefore tests STABILITY, not mere distinctness. Two equal references must compare equal,
and the same reference must keep its key across a copy, a save/load round-trip, re-normalization and
a separate process. `scratch/_probe_references_adversarial.py` asserted only that two inline dict
literals differ, which `id()` satisfies trivially — it passed for the wrong reason.

Exits 0 when the key is stable (defect fixed). Confirmed fixed in Round 2.

Run:  .venv/bin/python scratch/_probe_reference_key_stability.py
"""

import copy
import json
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from references import normalize_reference, reference_key  # noqa: E402

FAILS = []


def ck(label, cond, detail=""):
    print(("  OK   " if cond else " FAIL  ") + label + (f" | {detail}" if detail else ""))
    if not cond:
        FAILS.append(label)


def dangling_point():
    """A structurally identical, hint-less point reference."""
    return {"kind": "point", "sources": [], "hint": {"point": None, "normal": None}}


def emit_only() -> int:
    """Subprocess mode: print the key for a fresh dangling point, for cross-process comparison."""
    print(reference_key(dangling_point()))
    return 0


def main() -> int:
    if "--emit" in sys.argv:
        return emit_only()

    a, b = dangling_point(), dangling_point()

    print("== reference_key semantics for unresolved points ==")
    print("   key(a) =", reference_key(a))

    ck("same object is stable", reference_key(a) == reference_key(a))
    ck("equal VALUES compare equal (dedup/equality)", reference_key(a) == reference_key(b),
       f"{reference_key(a)} vs {reference_key(b)}")
    ck("stable across copy.deepcopy", reference_key(a) == reference_key(copy.deepcopy(a)))
    ck("stable across a save/load (JSON) round-trip",
       reference_key(a) == reference_key(json.loads(json.dumps(a))))
    ck("stable across re-normalization (as create_dimension does)",
       reference_key(a) == reference_key(normalize_reference(a)))

    proc = subprocess.run([sys.executable, os.path.abspath(__file__), "--emit"],
                          capture_output=True, text=True)
    other = (proc.stdout or "").strip()
    ck("stable across a separate process", reference_key(a) == other,
       f"this={reference_key(a)} other={other}")

    print()
    if FAILS:
        print(f"FINDING PRESENT — reference_key is non-deterministic ({len(FAILS)} propert"
              f"{'y' if len(FAILS) == 1 else 'ies'} violated)")
        print("Unresolved points need a persisted stable id, or an honest deterministic sentinel.")
        return 1
    print("reference_key is deterministic and stable for unresolved points")
    return 0


if __name__ == "__main__":
    sys.exit(main())
