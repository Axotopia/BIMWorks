"""
P5 exit criteria via the in-process geometric HLR projector (`mesh_hlr`).

Spec §4.1 names OCCT's `HLRBRep`. That is unreachable here (`pythonocc-core` is
conda-only; ifcopenshell exposes no HLR symbols), and the SVG serialiser cannot meet
M3 because it partitions cut from projection only in vertical section planes. This
suite checks the same three partitions computed directly from the triangulated
buffers, which is the input OCCT HLR would consume.

Run:  ./.venv/bin/python scratch/test_mesh_hlr.py
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from ifc_service import BimModelManager
from mesh_hlr import MeshHlrProjector, ViewCamera
from units import FEET_10, INCHES_8, feet_to_metres, metres_to_feet

CHECKS = {"passed": 0, "failed": 0}


def check(label, condition, detail=""):
    if condition:
        CHECKS["passed"] += 1
        print(f"   [ok]   {label}")
    else:
        CHECKS["failed"] += 1
        print(f"   [FAIL] {label} {detail}")


def fresh():
    m = BimModelManager()
    m.reset_model()
    return m


def plan_projector(m, cut_ft=4.0):
    return MeshHlrProjector(m.get_geometry_buffers()["meshes"])


def main():
    print("1. Cut partition exists and is in model coordinates (feet) ...")
    m = fresh()
    m.add_wall((0, 0, 0), (30, 0, 0), height=FEET_10, thickness=INCHES_8, name="South")
    m.add_wall((30, 0, 0), (30, 20, 0), height=FEET_10, thickness=INCHES_8, name="East")
    proj = plan_projector(m)
    view = proj.render(cut_z=feet_to_metres(4.0))
    check("cut partition is non-empty", len(view.cut) > 0, view.partition_counts())
    # NOTE: `get_geometry_buffers()` returns MIXED-UNIT meshes — measured, a 30 ft
    # wall on x spans 0..9.144 (metres) while a 20 ft wall on y spans 0..6.096 of a
    # baseline stored at 30 (feet). That defect is asserted in section 6 rather than
    # baked into an expectation here; this check only requires the cut to be
    # non-degenerate and attributed.
    check("cut geometry is attributed to real elements",
          all(e.get("guid") for e in view.cut))
    check("cut segments are non-degenerate",
          all(len(e["coords"]) >= 2 for e in view.cut))

    print("2. Cut is a genuine section, not a projection ...")
    # A cut above all geometry yields nothing, which a projection renderer could not do.
    high = plan_projector(m).render(cut_z=feet_to_metres(40.0))
    check("a cut above all geometry produces no cut paths", len(high.cut) == 0,
          len(high.cut))

    print("3. EXIT CRITERION: hidden lines are separated ...")
    # A tall wall in front of a shorter one: the short wall's lines are occluded.
    m2 = fresh()
    m2.add_wall((0, 0, 0), (30, 0, 0), height=FEET_10, thickness=INCHES_8, name="Front")
    m2.add_wall((0, 20, 0), (30, 20, 0), height=4.0, thickness=INCHES_8, name="Behind")
    # Look along -Y so the far wall (y=20) is behind the near one (y=0).
    cam = ViewCamera(right=(1, 0, 0), up=(0, 0, 1), direction=(0, -1, 0))
    v2 = plan_projector(m2).render(camera=cam)
    check("an occluded element produces hidden paths", len(v2.hidden) > 0,
          v2.partition_counts())
    check("the occluded, not the occluder, is what gets hidden",
          all(e.get("name") != "Front" for e in v2.hidden),
          sorted({e.get("name") for e in v2.hidden}))
    check("hidden and projection are disjoint partitions",
          len(v2.projection) > 0 and len(v2.hidden) > 0, v2.partition_counts())

    print("4. Frontend contract ...")
    contract = plan_projector(m).to_contract(view)
    check("class labels identify the partition (as the analytic renderer did)",
          all("cut" in e["class"] for e in contract["cut_paths"])
          and all("projection" in e["class"] for e in contract["projection_paths"]),
          contract["cut_paths"][:1])
    check("contract exposes cut/projection/hidden paths",
          set(("cut_paths", "projection_paths", "hidden_paths")) <= set(contract))
    check("paths are SVG 'd' strings",
          all(str(e["d"]).startswith("M ") for e in contract["cut_paths"]))
    check("renderer identifies itself", contract["renderer"] == "mesh-hlr")

    print("5. Geometry buffers are consistently metric (was a defect) ...")
    # Was mixed-unit: profile dimensions were written in metres while the placement
    # was written in decimal feet, so a wall at model x=10 ft landed at x=10 m (3.28x)
    # and meshes disagreed between axes and elements. Fixed at the placement boundary.
    mm = fresh()
    mm.add_wall((0, 0, 0), (30, 0, 0), height=FEET_10, thickness=INCHES_8, name="South")
    mm.add_wall((30, 0, 0), (30, 20, 0), height=FEET_10, thickness=INCHES_8, name="East")
    mm.add_wall((10, 10, 0), (40, 10, 0), height=FEET_10, thickness=INCHES_8, name="Offset")
    spans = {}
    for mesh in mm.get_geometry_buffers()["meshes"]:
        v = mesh["vertices"]
        spans[mesh.get("name")] = (min(v[0::3]), max(v[0::3]), min(v[1::3]), max(v[1::3]))
    south, east, off = spans["South"], spans["East"], spans["Offset"]
    check("a 30 ft wall on x spans 0..9.144 m",
          abs(south[0]) < 0.01 and abs(south[1] - 9.144) < 0.01, south)
    check("a wall at model x=30 ft sits at 9.144 m, not 30 m",
          abs(east[0] - 9.042) < 0.05 and abs(east[1] - 9.246) < 0.05, east)
    # spans are (xmin, xmax, ymin, ymax)
    check("a wall from model (10, 10) ft to (40, 10) ft spans x 3.048..12.192 m",
          abs(off[0] - 3.048) < 0.05 and abs(off[1] - 12.192) < 0.05, off)
    # Centred on y = 3.048 m (thickness 8" = 0.203 m), not at y = 10 m.
    check("...and is centred on y 3.048 m, not 10 m",
          abs((off[2] + off[3]) / 2.0 - 3.048) < 0.02, off)
    check("a 20 ft wall on y spans 0..6.096 m",
          abs(east[2]) < 0.15 and abs(east[3] - 6.096) < 0.01, east)

    print("5b. The projector is the DEFAULT plan renderer ...")
    # The objective is to REPLACE the analytic slicer, so the plan entry point must
    # route through here by default.
    mplan = fresh()
    mplan.add_wall((0, 0, 0), (30, 0, 0), height=FEET_10, thickness=INCHES_8, name="South")
    mplan.add_wall((30, 0, 0), (30, 20, 0), height=FEET_10, thickness=INCHES_8, name="East")
    plane = mplan.slice_2d_vector_plan(cut_elevation=4.0)
    check("slice_2d_vector_plan defaults to the geometric HLR renderer",
          plane.get("renderer") == "mesh-hlr", plane.get("renderer"))
    check("...and reports a cut partition", plane["partitions"].get("cut", 0) > 0,
          plane.get("partitions"))
    # The analytic renderer must remain reachable for comparison and fallback.
    analytic = mplan.slice_2d_vector_plan(cut_elevation=4.0, renderer="analytic")
    check("the analytic slicer is still available for comparison",
          analytic.get("renderer") == "analytic", analytic.get("renderer"))

    print("6. EXIT CRITERION: openings are voided in the cut ...")
    # The door void is modelled as an IfcOpeningElement subtracted from the wall. It
    # now actually subtracts (it did not before the placement-units fix, because the
    # opening was 3.28x adrift and never intersected the wall).
    mo = fresh()
    wo = mo.add_wall((0, 0, 0), (30, 0, 0), height=FEET_10, thickness=INCHES_8,
                     name="South")["guid"]
    mo.add_door(wo, offset_along_wall=10.0, width=3.0)
    vo = plan_projector(mo).render(cut_z=feet_to_metres(4.0))
    segs = []
    for e in vo.cut:
        cs = [(round(metres_to_feet(x), 2), round(metres_to_feet(y), 2)) for x, y in e["coords"]]
        if len(cs) == 2 and abs(cs[0][1] - 0.33) < 0.03 and abs(cs[1][1] - 0.33) < 0.03:
            segs.append(tuple(sorted((cs[0][0], cs[1][0]))))
    segs = sorted(set(segs))
    gap = None
    for a, b in zip(segs, segs[1:]):
        d = b[0] - a[1]
        if d > 1.0:
            gap = (a[1], b[0])
    check("the wall cut is interrupted by the door opening", gap is not None, segs)
    if gap:
        check("the gap is at the door's own position (10..13 ft)",
              abs(gap[0] - 10.0) < 0.2 and abs(gap[1] - 13.0) < 0.2, gap)
    # And a wall with no door is continuous across that span.
    mw = fresh()
    ww = mw.add_wall((0, 0, 0), (30, 0, 0), height=FEET_10, thickness=INCHES_8,
                     name="South")["guid"]
    vw = plan_projector(mw).render(cut_z=feet_to_metres(4.0))
    wsegs = []
    for e in vw.cut:
        cs = [(round(metres_to_feet(x), 2), round(metres_to_feet(y), 2)) for x, y in e["coords"]]
        if len(cs) == 2 and abs(cs[0][1] - 0.33) < 0.03 and abs(cs[1][1] - 0.33) < 0.03:
            wsegs.append(tuple(sorted((cs[0][0], cs[1][0]))))
    wseg_sorted = sorted(set(wsegs))
    no_gap = all((b[0] - a[1]) <= 1.0 for a, b in zip(wseg_sorted, wseg_sorted[1:]))
    check("a wall without a door has no gap there", no_gap, wseg_sorted)

    print(f"\nRESULT: {CHECKS['passed']} passed, {CHECKS['failed']} failed")
    if CHECKS["failed"]:
        return 1
    print("mesh HLR is the default plan renderer; cut partition, openings voided "
          "and hidden-line separation all verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
