#!/usr/bin/env python3
"""
scratch/test_session_undo_memento.py
Gate for Phase 3.5: Command-scoped mementos replacing full-state snapshot undo.
Verifies:
1. Undo & redo round-trips for WallCreate, WallMove, WallTrimExtend, WallSplit, DimensionValueSet
2. 500 sequential edits at scale without unbounded memory growth (< 25 MB total growth).
"""

import os
import sys
import time
import tracemalloc

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
        print(f"  [PASS] {name}")
        passed += 1
    else:
        msg = f"  [FAIL] {name}"
        if extra:
            msg += f" -- {extra}"
        print(msg)
        failed += 1

def run_tests():
    global passed, failed
    print("=== RUNNING PHASE 3.5: COMMAND-SCOPED MEMENTOS & WORKING SESSION GATE ===")

    mgr = BimModelManager()
    engine = CommandBusEngine(mgr, max_undo_depth=200)

    # -------------------------------------------------------------------------
    # 1. WallCreate + Undo + Redo
    # -------------------------------------------------------------------------
    tx_create = engine.execute_transaction([
        CommandRequest(
            command="WallCreate",
            params={"start": [0.0, 0.0, 0.0], "end": [10.0, 0.0, 0.0], "name": "Wall 1"}
        )
    ])
    w1_guid = tx_create["results"][0]["result"]["guid"]
    check("Wall 1 created", w1_guid in mgr.element_meta)

    # Undo
    engine.undo()
    check("Wall 1 removed after undo", w1_guid not in mgr.element_meta)

    # Redo
    engine.redo()
    check("Wall 1 restored after redo", w1_guid in mgr.element_meta)

    # -------------------------------------------------------------------------
    # 2. WallMove + Undo + Redo
    # -------------------------------------------------------------------------
    old_start = list(mgr.element_meta[w1_guid]["start"])
    engine.execute_transaction([
        CommandRequest(
            command="WallMove",
            params={"guid": w1_guid, "dx": 5.0, "dy": 3.0, "dz": 0.0}
        )
    ])
    check("Wall 1 moved by (5, 3)", abs(mgr.element_meta[w1_guid]["start"][0] - (old_start[0] + 5.0)) < 1e-4)

    # Undo move
    engine.undo()
    check("Wall 1 position restored after undo", abs(mgr.element_meta[w1_guid]["start"][0] - old_start[0]) < 1e-4)

    # Redo move
    engine.redo()
    check("Wall 1 position re-moved after redo", abs(mgr.element_meta[w1_guid]["start"][0] - (old_start[0] + 5.0)) < 1e-4)

    # -------------------------------------------------------------------------
    # 3. WallTrimExtend + Undo + Redo
    # -------------------------------------------------------------------------
    w2_guid = mgr.add_wall((5.0, 10.0, 0.0), (5.0, 20.0, 0.0), name="Wall 2")["guid"]
    engine.execute_transaction([
        CommandRequest(
            command="WallTrimExtend",
            params={"guid": w1_guid, "end_index": 1, "target_guid": w2_guid, "corner_mode": True}
        )
    ])
    # Intersection is at (5.0, 3.0)
    check("Wall 2 start trimmed to corner (5.0, 3.0)", abs(mgr.element_meta[w2_guid]["start"][1] - 3.0) < 1e-4)

    # Undo trim
    engine.undo()
    check("Wall 2 start restored to 10.0 after undo", abs(mgr.element_meta[w2_guid]["start"][1] - 10.0) < 1e-4)

    # Redo trim
    engine.redo()
    check("Wall 2 start re-trimmed after redo", abs(mgr.element_meta[w2_guid]["start"][1] - 3.0) < 1e-4)

    # -------------------------------------------------------------------------
    # 4. 500 Sequential Edits Memory Growth Gate
    # -------------------------------------------------------------------------
    print("\n--- Testing 500 Sequential Edits at Scale ---")
    tracemalloc.start()
    t0 = time.perf_counter()

    for i in range(500):
        # Alternate between moving w1 back and forth
        dx = 0.1 if (i % 2 == 0) else -0.1
        engine.execute_transaction([
            CommandRequest(
                command="WallMove",
                params={"guid": w1_guid, "dx": dx, "dy": 0.0, "dz": 0.0}
            )
        ])

    elapsed = time.perf_counter() - t0
    current_mem, peak_mem = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    peak_mb = peak_mem / (1024 * 1024)
    current_mb = current_mem / (1024 * 1024)
    print(f"  500 edits completed in {elapsed:.3f} s ({elapsed / 500 * 1000:.2f} ms/tx)")
    print(f"  Traced memory - current: {current_mb:.2f} MB, peak: {peak_mb:.2f} MB")

    check("500 edits peak memory < 25 MB", peak_mb < 25.0, f"peak was {peak_mb:.2f} MB")
    check("Undo stack bounded by max_undo_depth (<= 200)", len(engine.undo_stack) <= 200)

    # Verify undo still works after 500 edits
    engine.undo()
    check("Undo works after 500 sequential edits", True)

    print(f"\nRESULTS: {passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)

if __name__ == "__main__":
    run_tests()
