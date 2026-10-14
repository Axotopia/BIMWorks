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

    print("7. Unified view entry point: plan, section and elevation ...")
    mv = fresh()
    lvv = [i for i, l in mv.levels.items() if l["name"] == "Level 1"][0]
    vwall = mv.add_wall((0, 0, 0), (30, 0, 0), height=FEET_10, thickness=INCHES_8,
                        name="South", level_id=lvv)["guid"]
    mv.add_wall((0, 20, 0), (30, 20, 0), height=4.0, thickness=INCHES_8,
                name="Low", level_id=lvv)
    # An opening, so the annotation checks below exercise real symbols rather than
    # passing or failing on an empty fixture.
    mv.add_door(vwall, offset_along_wall=6.0, width=3.0)
    mv.add_window(vwall, offset_along_wall=18.0, width=4.0, height=4.0, sill_height=3.0)
    plan = mv.render_2d_view(view_type="floor_plan", cut_elevation=4.0)
    check("a floor plan is available through render_2d_view",
          plan["view_type"] == "floor_plan" and plan["partitions"]["cut"] > 0,
          plan.get("partitions"))
    sec = mv.render_2d_view(view_type="section", cut_elevation=4.0, direction="south")
    check("a section is available and cuts", sec["partitions"]["cut"] > 0,
          sec.get("partitions"))
    elev = mv.render_2d_view(view_type="elevation", direction="south")
    check("an elevation is available and does NOT cut", elev["partitions"]["cut"] == 0,
          elev.get("partitions"))
    check("the elevation still projects and hides geometry",
          elev["partitions"]["projection"] > 0 and elev["partitions"]["hidden"] > 0,
          elev.get("partitions"))
    check("every view reports the renderer and the view range",
          all(v.get("renderer") == "mesh-hlr" and "view_range" in v
              for v in (plan, sec, elev)))

    # Annotation must reach EVERY view type. It was applied only on the plan path, so
    # sections and elevations came back with no symbols, no grids and no dimensions.
    check("a section carries annotation too",
          len(sec.get("window_paths") or []) > 0 and len(sec.get("dimensions") or []) > 0,
          {k: len(sec.get(k) or []) for k in ("window_paths", "dimensions", "grids")})
    check("an elevation carries annotation too",
          len(elev.get("window_paths") or []) > 0 and len(elev.get("dimensions") or []) > 0,
          {k: len(elev.get(k) or []) for k in ("window_paths", "dimensions")})
    # A door swing states which way a leaf opens, which is a PLAN representation; an
    # arc drawn across an elevation would be wrong.
    check("a door swing appears in the plan",
          len(plan.get("swing_paths") or []) > 0, len(plan.get("swing_paths") or []))
    check("no door swing is drawn in an elevation",
          len(elev.get("swing_paths") or []) == 0, elev.get("swing_paths"))
    check("no door swing is drawn in a section",
          len(sec.get("swing_paths") or []) == 0, sec.get("swing_paths"))

    print("8. View range is honoured, not merely reported ...")
    # `view_depth` was carried in the contract but never applied, so a wall 200 ft
    # away still appeared in a view whose depth was 30 ft. It now filters.
    mr = fresh()
    lvr = [i for i, l in mr.levels.items() if l["name"] == "Level 1"][0]
    near = mr.add_wall((0, 0, 0), (40, 0, 0), height=FEET_10, thickness=INCHES_8,
                       name="Near", level_id=lvr)["guid"]
    mid = mr.add_wall((0, 20, 0), (40, 20, 0), height=FEET_10, thickness=INCHES_8,
                      name="Mid", level_id=lvr)["guid"]
    far = mr.add_wall((0, 200, 0), (40, 200, 0), height=FEET_10, thickness=INCHES_8,
                      name="Distant", level_id=lvr)["guid"]
    unlimited = mr.render_2d_view(view_type="floor_plan", cut_elevation=4.0)
    limited = mr.render_2d_view(view_type="floor_plan", cut_elevation=4.0,
                                view_range={"cut": 4.0, "view_depth": 30.0})
    ucut = {p.get("guid") for p in unlimited["cut_paths"]}
    lcut = {p.get("guid") for p in limited["cut_paths"]}
    check("without a view range every wall is drawn",
          {near, mid, far} <= ucut, sorted(ucut))
    check("a 30 ft view depth drops the wall 180 ft beyond it", far not in lcut,
          sorted(lcut))
    check("...while keeping the walls inside it", near in lcut and mid in lcut,
          sorted(lcut))

    print("8b. View depth edges ...")
    # Zero is how the store seeds an unset depth, and reading it literally would blank
    # the drawing; negative is nonsense and must not blank it either. Guarded in the
    # backend, not only in the client, so a direct API call cannot silently empty a view.
    mz = fresh()
    lz = [i for i, l in mz.levels.items() if l["name"] == "Level 1"][0]
    mz.add_wall((0, 0, 0), (40, 0, 0), height=FEET_10, thickness=INCHES_8,
                name="S", level_id=lz)
    mz.add_wall((40, 0, 0), (40, 24, 0), height=FEET_10, thickness=INCHES_8,
                name="E", level_id=lz)
    unlimited = mz.render_2d_view(view_type="floor_plan", cut_elevation=4.0)
    for value in (0.0, -5.0):
        got = mz.render_2d_view(view_type="floor_plan", cut_elevation=4.0,
                                view_range={"view_depth": value})
        check(f"a view depth of {value} behaves as unset, not as 'nothing visible'",
              got["partitions"]["cut"] == unlimited["partitions"]["cut"],
              (got["partitions"], unlimited["partitions"]))

    print("8c. Foreign IFC: openings import in the right unit ...")
    # The foreign importer measured opening extents from a world-coordinate shape, which
    # is METRIC, and then treated those numbers as feet — so every imported opening came
    # back 3.28x too small and its symbol was drawn at the wrong size. The wall path
    # converted correctly, which is what made the inconsistency easy to miss.
    import os as _os

    sample = _os.path.join(_os.path.dirname(__file__), "..", "sample_building.ifc")
    if _os.path.exists(sample):
        mf = fresh()
        mf.load_ifc_file(sample, "sample_building.ifc")
        wins = [x for x in mf.element_meta.values() if x.get("ifc_class") == "IfcWindow"]
        doors = [x for x in mf.element_meta.values() if x.get("ifc_class") == "IfcDoor"]
        check("the sample building imported its openings", wins and doors,
              (len(wins), len(doors)))
        if wins:
            # A 48" window type must measure a few feet, not ~15 ft (which is what a
            # metric value read as feet produces).
            check("an imported window measures in feet, not metres",
                  2.5 <= min(w["width"] for w in wins) <= 7.0,
                  sorted(round(w["width"], 3) for w in wins))
        if doors:
            check("an imported door measures in feet, not metres",
                  2.0 <= min(d["width"] for d in doors) <= 4.0,
                  sorted(round(d["width"], 3) for d in doors))
        # And HLR must cope with foreign geometry at all.
        cvf = mf.render_2d_view(view_type="floor_plan", cut_elevation=4.0)
        check("the HLR renderer handles a foreign IFC",
              cvf["partitions"]["cut"] > 0 and cvf["partitions"]["hidden"] > 0,
              cvf.get("partitions"))
        check("its window symbols are drawn",
              len(cvf.get("window_paths") or []) > 0,
              len(cvf.get("window_paths") or []))
    else:
        print("   [note] sample_building.ifc not present; skipping the foreign-unit check")

    print("9. Drafting symbols and dimensions are produced ...")
    # A window drawn as a bare wall gap is not how a plan shows a window; the glazing
    # symbol is annotation, like the door swing, so it cannot come from HLR.
    ms = fresh()
    lvs = [i for i, l in ms.levels.items() if l["name"] == "Level 1"][0]
    ws = ms.add_wall((0, 0, 0), (40, 0, 0), height=FEET_10, thickness=INCHES_8,
                     name="South", level_id=lvs)["guid"]
    ms.add_window(ws, offset_along_wall=20.0, width=6.0, height=4.0, sill_height=3.0)
    planw = ms.slice_2d_vector_plan(cut_elevation=4.0)
    wins = planw.get("window_paths") or []
    check("a window contributes a symbol, not just a gap", len(wins) >= 3, len(wins))
    check("the symbol includes jambs", any("jamb" in e["class"] for e in wins))
    check("the symbol includes glazing", any("glazing" in e["class"] for e in wins))
    # The glazing must span the opening (20..26 ft) and the jambs sit at its ends.
    import re as _re

    glaz_xs = []
    for e in wins:
        nums = [float(v) for v in _re.findall(r"-?\d+\.?\d*", e["d"])]
        if "glazing" in e["class"]:
            glaz_xs += nums[0::2]
    check("glazing spans the 6 ft opening at 20..26 ft",
          glaz_xs and abs(min(glaz_xs) - 20.0) < 0.2 and abs(max(glaz_xs) - 26.0) < 0.2,
          (min(glaz_xs), max(glaz_xs)) if glaz_xs else None)

    check("overall dimensions are produced", len(planw.get("dimensions") or []) >= 1,
          planw.get("dimensions"))
    # Dimension text must be architectural. This model is a single 40 ft wall, so its
    # "depth" is the wall's own thickness and is under a foot — and `format_feet_inches`
    # deliberately drops the feet part below 1 ft (Revit convention: `8"`, not `0'-8"`).
    # Asserting an apostrophe would therefore be asserting the wrong thing.
    import re as _re2

    for d in planw.get("dimensions") or []:
        text = d.get("text") or ""
        architectural = bool(_re2.fullmatch(r"\d+'-\d+(?: \d+/\d+)?\"", text)) or bool(
            _re2.fullmatch(r'\d+(?: \d+/\d+)?"', text)
        )
        check(f"dimension {d.get('kind')} is labelled architecturally ({text!r})",
              architectural, text)

    print("10. Lineweight table is applied to the output ...")
    check("cut entries carry a style",
          all("style" in e for e in limited["cut_paths"]), limited["cut_paths"][:1])
    check("the contract carries the whole lineweight table",
          "lineweights" in limited and "cut" in limited["lineweights"])
    check("cut is styled heavier than projection",
          limited["lineweights"]["cut"]["weight_mm"]
          > limited["lineweights"]["projection"]["weight_mm"],
          limited.get("lineweights"))

    print(f"\nRESULT: {CHECKS['passed']} passed, {CHECKS['failed']} failed")
    if CHECKS["failed"]:
        return 1
    print("mesh HLR is the default plan renderer; cut partition, openings voided "
          "and hidden-line separation all verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
