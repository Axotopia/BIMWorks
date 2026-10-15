"""End-to-end engine latency probe for the post-commit plan refresh path.

Mirrors exactly what `GET /api/state?since=<rev>` does section by section
(backend/main.py:1031-1063) so the cost of one edit's plan regeneration can be
attributed. Read-only: builds models in memory, touches no source file.

Run: ./.venv/Scripts/python.exe scratch/_probe_e2e.py
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
    walls = []
    for i in range(n_cells + 1):
        x = i * 12.0
        walls.append(m.add_wall((x, 0, 0), (x, size, 0), height=FEET_10, thickness=INCHES_8))
        y = i * 12.0
        walls.append(m.add_wall((0, y, 0), (size, y, 0), height=FEET_10, thickness=INCHES_8))
    m.add_slab([(0, 0), (size, 0), (size, size), (0, size)], thickness=0.25, elevation=0.0)
    return m, walls


def ms(fn, repeats=3):
    best = None
    for _ in range(repeats):
        t0 = time.perf_counter()
        fn()
        dt = (time.perf_counter() - t0) * 1000.0
        best = dt if best is None else min(best, dt)
    return best


print(f"{'walls':>6} {'geom_delta ms':>14} {'slice2d ms':>11} {'sum ms (B)':>11} {'geom_full ms':>13} {'resync C ms':>12}")
for n in (4, 10, 18, 26, 34, 42):
    m, walls = build(n)
    m.slice_2d_vector_plan(cut_elevation=4.0)          # warm caches

    # Simulate one edit: move one wall, which dirties just that mesh.
    m.translate_element(walls[0]["guid"], 0.0, 0.25, 0.0)
    rev = 2
    t_geom_delta = ms(lambda: m.get_geometry_buffers(since=1), repeats=3)
    t_slice = ms(lambda: m.slice_2d_vector_plan(cut_elevation=4.0), repeats=3)
    t_geom_full = ms(lambda: m.get_geometry_buffers(), repeats=2)
    t_resync = t_geom_full + t_slice
    print(f"{len(walls):>6} {t_geom_delta:>14.1f} {t_slice:>11.1f} {t_geom_delta + t_slice:>11.1f} "
          f"{t_geom_full:>13.1f} {t_resync:>12.1f}")
    sys.stdout.flush()
print("done")
