"""Scaling probe: how does plan generation cost grow with model size?

Read-only measurement probe written for the viewport-interaction audit. Creates
N grid-cell walls + a slab, then times the mesh-HLR plan path and the analytic path.

Run: ./.venv/Scripts/python.exe scratch/_probe_scaling.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from ifc_service import BimModelManager
from units import FEET_10, INCHES_8


def build(n_cells):
    """A square lattice of n_cells x n_cells partitions -> 2*n*(n+1) wall runs."""
    m = BimModelManager()
    m.reset_model()
    size = 12.0 * n_cells
    n_walls = 0
    for i in range(n_cells + 1):
        x = i * 12.0
        m.add_wall((x, 0, 0), (x, size, 0), height=FEET_10, thickness=INCHES_8)
        n_walls += 1
        y = i * 12.0
        m.add_wall((0, y, 0), (size, y, 0), height=FEET_10, thickness=INCHES_8)
        n_walls += 1
    m.add_slab([(0, 0), (size, 0), (size, size), (0, size)], thickness=0.25, elevation=0.0)
    return m, n_walls


def timeit(fn, repeats=3):
    best = None
    for _ in range(repeats):
        t0 = time.perf_counter()
        fn()
        dt = (time.perf_counter() - t0) * 1000.0
        best = dt if best is None else min(best, dt)
    return best


print(f"{'walls':>6} {'tris':>8} {'geq':>6} {'geom ms':>9} {'plan ms':>9} {'analytic ms':>11} {'partitions':>22}")
for n in (10, 20, 24, 28, 32):
    m, n_walls = build(n)
    geoms = m.get_geometry_buffers()
    meshes = geoms["meshes"]
    tris = sum(len(x["indices"]) // 3 for x in meshes)
    t_geom = timeit(lambda: m.get_geometry_buffers())

    # Warm the caches the way a real edit does, then measure the view rebuild.
    m.slice_2d_vector_plan(cut_elevation=4.0)
    t_plan = timeit(lambda: m.slice_2d_vector_plan(cut_elevation=4.0), repeats=3)
    t_analytic = timeit(lambda: m.slice_2d_vector_plan(cut_elevation=4.0, renderer="analytic"), repeats=3)

    c = m.slice_2d_vector_plan(cut_elevation=4.0)
    p = c.get("partitions") or {}
    print(f"{n_walls:>6} {tris:>8} {len(meshes):>6} {t_geom:>9.1f} {t_plan:>9.1f} {t_analytic:>11.1f} "
          f"{str(p):>22}")
    sys.stdout.flush()
print("done")
