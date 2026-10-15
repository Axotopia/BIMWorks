import json, sys, os
sys.path.insert(0, os.path.abspath("backend"))
from ifc_service import BimModelManager
m = BimModelManager()
m.reset_model()
m.add_wall((0,0,0),(10,0,0))
c = m.slice_2d_vector_plan(cut_elevation=4.0)
print("renderer:", c.get("renderer"))
print("top-level keys:", sorted(c.keys()))
print("partitions:", c.get("partitions"))
for k in sorted(c.keys()):
    v = c[k]
    if isinstance(v, list):
        print(f"  {k}: list len={len(v)}", (sorted(v[0].keys()) if v and isinstance(v[0], dict) else ""))
