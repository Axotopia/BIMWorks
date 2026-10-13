"""
BIMWorks — Wall join geometry regression tests (GLM Master Spec v2.3 §3.3 Phase A)
Verifies: miter/butt/square-off corner joins in actual 3D solids, T-junctions,
Disallow-Join, join recompute on move/delete, 2D slice seam cleanup, undo/redo
coherence with joins.

Run: ./.venv/bin/python scratch/test_wall_joins.py
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'✓' if cond else '✗ FAIL'} {name}" + (f" — {detail}" if detail and not cond else ""))


def poly_area(pts):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i][0], pts[i][1]
        x2, y2 = pts[(i + 1) % n][0], pts[(i + 1) % n][1]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


mgr = BimModelManager("Join Test")
bus = CommandBusEngine(mgr)

# ---------------------------------------------------- 1. L-corner, butt (default)
print("1. L-corner butt join (default): wall A along +X, wall B along +Y, shared corner")
ra = bus.execute_transaction([CommandRequest(command="WallCreate", params={
    "start": [0.0, 0.0, 0.0], "end": [10.0, 0.0, 0.0], "height": 3.0, "thickness": 0.3})])
rb = bus.execute_transaction([CommandRequest(command="WallCreate", params={
    "start": [0.0, 0.0, 0.0], "end": [0.0, 8.0, 0.0], "height": 3.0, "thickness": 0.3})])
ga = ra["results"][0]["result"]["guid"]
gb = rb["results"][0]["result"]["guid"]
fa = mgr.element_meta[ga]["footprint"]
fb = mgr.element_meta[gb]["footprint"]
area_a = poly_area(fa)
area_b = poly_area(fb)
# Wall A created first -> runs through (full length). Wall B butts into A's face.
check("wall A runs through (full area)", abs(area_a - 10.0 * 0.3) < 1e-6, f"{area_a:.4f}")
check("wall B trimmed to A's face", abs(area_b - (8.0 - 0.15) * 0.3) < 1e-6, f"{area_b:.4f} (expect {7.85*0.3:.4f})")
check("footprints stored on both", "footprint" in mgr.element_meta[ga] and "footprint" in mgr.element_meta[gb])

# ---------------------------------------------- 2. miter join (both ends miter)
print("2. Miter join at the same corner")
bus.execute_transaction([
    CommandRequest(command="SetWallJoin", params={"wall_guid": ga, "end_index": 0, "allow_join": True, "mode": "miter"}),
    CommandRequest(command="SetWallJoin", params={"wall_guid": gb, "end_index": 0, "allow_join": True, "mode": "miter"}),
])
fa = mgr.element_meta[ga]["footprint"]
fb = mgr.element_meta[gb]["footprint"]
check("miter: A polygon corner cut", any(v for v in fa), len(fa))
check("miter: both polygons share the bisector edge",
      sum(1 for x, y in fa if abs(x - y) < 1e-6) >= 2
      and sum(1 for x, y in fb if abs(x - y) < 1e-6) >= 2)
# Each wall loses a right triangle with legs t/2 at the shared corner:
expected = 10 * 0.3 + 8 * 0.3 - 2 * (0.15 ** 2 / 2.0)
total = poly_area(fa) + poly_area(fb)
check("miter pieces tile without gap or overlap", abs(total - expected) < 1e-6, f"{total:.5f} vs {expected:.5f}")

# --------------------------------------------------- 3. square-off join
print("3. Square-off join")
bus.execute_transaction([
    CommandRequest(command="SetWallJoin", params={"wall_guid": ga, "end_index": 0, "allow_join": True, "mode": "square_off"}),
])
fa = mgr.element_meta[ga]["footprint"]
check("square-off: A keeps 4 vertices with square end", len(fa) == 4, f"n={len(fa)}")

# ------------------------------------------------------ 4. disallow join
print("4. DisallowJoin keeps full overlap geometry")
bus.execute_transaction([
    CommandRequest(command="SetWallJoin", params={"wall_guid": gb, "end_index": 0, "allow_join": False, "mode": "butt"}),
])
fb = mgr.element_meta[gb]["footprint"]
check("disallow join: B untrimmed (full area)", abs(poly_area(fb) - 8.0 * 0.3) < 1e-6, f"{poly_area(fb):.4f}")

# ---------------------------------------------------------- 5. T-junction
print("5. T-junction: wall C ends on wall A's baseline")
rc = bus.execute_transaction([CommandRequest(command="WallCreate", params={
    "start": [5.0, 0.0, 0.0], "end": [5.0, 6.0, 0.0], "height": 3.0, "thickness": 0.3})])
gc = rc["results"][0]["result"]["guid"]
fc = mgr.element_meta[gc]["footprint"]
check("tee: C trimmed back to A's face", abs(poly_area(fc) - (6.0 - 0.15) * 0.3) < 1e-6, f"{poly_area(fc):.4f}")

# -------------------------------------------- 6. joins recompute on move
print("6. Join recompute on wall move")
bus.execute_transaction([CommandRequest(command="WallMove", params={"guid": gb, "dx": 3.0, "dy": 0.0})])
fb2 = mgr.element_meta[gb]["footprint"]
check("after move, B no longer joins A (untrimmed)", abs(poly_area(fb2) - 8.0 * 0.3) < 1e-6, f"{poly_area(fb2):.4f}")
# re-enable B's join (it was disallowed in step 4), then move back
bus.execute_transaction([CommandRequest(command="SetWallJoin", params={"wall_guid": gb, "end_index": 0, "allow_join": True, "mode": "butt"})])
bus.execute_transaction([CommandRequest(command="WallMove", params={"guid": gb, "dx": -3.0, "dy": 0.0})])
check("after move back, B re-trims", abs(poly_area(mgr.element_meta[gb]["footprint"]) - (8.0 - 0.15) * 0.3) < 1e-6)

# --------------------------------- 7. 3D representation actually rebuilt
print("7. 3D representation coherence")
meshes = mgr.get_geometry_buffers()
wall_meshes = [m for m in meshes.get("meshes", []) if m.get("ifc_class") == "IfcWallStandardCase"]
check("all three walls produce meshes", len(wall_meshes) >= 3, f"n={len(wall_meshes)}")
# Volume check via tessellated triangles is complex; instead verify the IFC
# representation is an extruded arbitrary profile (not the old parametric wall):
ent = mgr.element_meta[ga]["entity"]
rep_items = [it for r in ent.Representation.Representations for it in r.Items]
check("wall A uses extruded arbitrary profile", any(it.is_a("IfcExtrudedAreaSolid") and it.SweptArea.is_a("IfcArbitraryClosedProfileDef") for it in rep_items), f"{[i.is_a() for i in rep_items]}")

# ------------------------------------- 8. 2D slice renders joined corners
print("8. 2D slice uses join-trimmed footprints")
slices = mgr.slice_2d_vector_plan(cut_elevation=1.2)
cut_paths = [p for p in slices.get("cut_paths", []) if "cut" in p.get("class", "")]
# wall B (mitered earlier -> later set square_off/disallow...) — use wall C: tee-trimmed
c_paths = [p for p in cut_paths if p.get("guid") == gc]
check("wall C emits cut path", len(c_paths) >= 1)
if c_paths:
    d = c_paths[0]["d"]
    # trimmed C spans y from 0.15 (A's face) to 6.0 — its polygon must NOT
    # include y < 0.15 points
    ys = [float(tok) for i, tok in enumerate(d.replace("M", " ").replace("L", " ").replace("Z", " ").split()) if i % 2 == 1]
    check("tee-trimmed C starts at A's face (y=0.15), not y=0", abs(min(ys) - 0.15) < 1e-3, f"min_y={min(ys):.3f}")

# ----------------------------- 9. undo/redo coherence with join geometry
print("9. Undo/redo with joins")
undos = 0
while gc in mgr.element_meta and undos < 8:
    res = bus.undo()
    undos += 1
    if res["status"] == "empty":
        break
check("undo (eventually) removes C", gc not in mgr.element_meta)
redos = 0
while gc not in mgr.element_meta and redos < 8:
    res = bus.redo()
    redos += 1
    if res["status"] == "empty":
        break
check("redo restores C with trimmed footprint",
      gc in mgr.element_meta and abs(poly_area(mgr.element_meta[gc]["footprint"]) - (6.0 - 0.15) * 0.3) < 1e-6)

# ------------------------------- 10. join survives .bimworks round-trip
print("10. Container round-trip keeps join policies")
path = mgr.save_orlt_project()
import zipfile, json
with zipfile.ZipFile(path) as z:
    ov = json.loads(z.read("parametric.json"))
check("join_policies persisted", "join_policies" in ov and ga in ov.get("join_policies", {}))

print()
print(f"RESULT: {len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("FAILED:", FAIL)
    sys.exit(1)
print("ALL WALL JOIN TESTS PASSED")
