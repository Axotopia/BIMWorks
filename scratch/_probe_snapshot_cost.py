"""Transaction-overhead probe: full-state snapshot cost per edit.

`CommandBus.execute_transaction` takes `snapshot_state()` twice per transaction
(backend/command_bus.py:642 pre-state, :677 post_state for the undo entry), and
`undo`/`redo` deep-copy full state. This measures that cost against model size.

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


print(f"{'walls':>6} {'snapshot ms':>12} {'x2 + slice ms':>14}")
for n in (4, 10, 18, 26, 34, 42):
    m = build(n)
    m.get_geometry_buffers()
    m.slice_2d_vector_plan(cut_elevation=4.0)
    t_snap = ms(lambda: m.snapshot_state(), repeats=3)
    t_slice = ms(lambda: m.slice_2d_vector_plan(cut_elevation=4.0), repeats=3)
    print(f"{2 * (n + 1):>6} {t_snap:>12.1f} {2 * t_snap + t_slice:>14.1f}")
    sys.stdout.flush()
print("done")
