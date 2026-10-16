"""Snapshot-cost probe: what a full-state snapshot costs, by model size.

READ THIS BEFORE QUOTING A NUMBER FROM IT. The bus no longer snapshots twice per
transaction: `execute_transaction` emits one journal step and one undo entry made
of **command-scoped mementos** (backend/command_bus.py:1536), and 31 of 41
registered commands return one. `WallMove` -- the drag path -- is an O(1) inverse
operation and never calls `snapshot_state()`.

`snapshot_state()` now survives only as the **fallback** for the ten commands that
declare no memento (backend/command_bus.py:1519-1523, where `undo_fn` calls
`restore_state`). So the numbers below are the cost of *that* path, not the cost of
a wall edit. A fallback transaction calls it once, not twice; the doubled column is
retained only to show what the pre-memento design paid, and must not be read as
current per-edit latency.

The 66%-of-cost attribution (STEP serialisation vs parametric copies) is in
docs/DECISION-live-edit-transaction-unit.md section 4.

Run: ./.venv/Scripts/python.exe scratch/_probe_snapshot_cost.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from ifc_service import BimModelManager
from units import FEET_10, INCHES_8


def build(n_cells):
    m = BimModelManager()
    m.reset_model()
    size = 12.0 * n_cells
    for i in range(n_cells + 1):
        x = i * 12.0
        m.add_wall((x, 0, 0), (x, size, 0), height=FEET_10, thickness=INCHES_8)
        y = i * 12.0
        m.add_wall((0, y, 0), (size, y, 0), height=FEET_10, thickness=INCHES_8)
    return m


def ms(fn, repeats=5):
    best = None
    for _ in range(repeats):
        t0 = time.perf_counter()
        fn()
        dt = (time.perf_counter() - t0) * 1000.0
        best = dt if best is None else min(best, dt)
    return best


print(f"{'walls':>6} {'snapshot ms':>12} {'2x + slice ms':>14}  <- pre-memento model")
for n in (4, 10, 18, 26, 34, 42):
    m = build(n)
    m.get_geometry_buffers()
    m.slice_2d_vector_plan(cut_elevation=4.0)
    t_snap = ms(lambda: m.snapshot_state(), repeats=3)
    t_slice = ms(lambda: m.slice_2d_vector_plan(cut_elevation=4.0), repeats=3)
    print(f"{2 * (n + 1):>6} {t_snap:>12.1f} {2 * t_snap + t_slice:>14.1f}")
    sys.stdout.flush()
print("done")
