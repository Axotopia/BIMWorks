"""Isolated slice timing, clean process per size.

Run: ./.venv/Scripts/python.exe scratch/_probe_slice_only.py <n_cells>
"""
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from ifc_service import BimModelManager
from units import FEET_10, INCHES_8

n = int(sys.argv[1]) if len(sys.argv) > 1 else 4
m = BimModelManager()
m.reset_model()
size = 12.0 * n
for i in range(n + 1):
    x = i * 12.0
    m.add_wall((x, 0, 0), (x, size, 0), height=FEET_10, thickness=INCHES_8)
    y = i * 12.0
    m.add_wall((0, y, 0), (size, y, 0), height=FEET_10, thickness=INCHES_8)

walls = len(m.element_meta)
m.get_geometry_buffers()
m.slice_2d_vector_plan(cut_elevation=4.0)   # warm

t = []
for _ in range(5):
    t0 = time.perf_counter()
    m.slice_2d_vector_plan(cut_elevation=4.0)
    t.append((time.perf_counter() - t0) * 1000.0)
t_snap = []
for _ in range(5):
    t0 = time.perf_counter()
    m.snapshot_state()
    t_snap.append((time.perf_counter() - t0) * 1000.0)

print(f"walls={walls} slice_best={min(t):.1f}ms slice_all={[round(x,1) for x in t]} "
      f"snapshot_best={min(t_snap):.1f}ms snapshot_all={[round(x,1) for x in t_snap]}")
