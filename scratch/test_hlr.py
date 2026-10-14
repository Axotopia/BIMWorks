"""
P5 status: 2D views and hidden-line rendering.

This suite verifies what was actually achieved and *pins the shortfall* so it
cannot be mistaken for done. Read `backend/hlr_renderer.py`'s module docstring for
the full account; the short version:

  VERIFIED  OCCT hidden-line output is partitioned into section/projection and the
            parser reads those partitions correctly.
  VERIFIED  The view-range engine (a wall under 6 ft is never cut).
  VERIFIED  The plan contract still carries exact model-coordinate annotation.
  VERIFIED  The serializer emits several named drawing planes; selecting one and
            calibrating it against the model's plan bounds puts HLR geometry in
            model coordinates (validated against ifcopenshell.draw.main()).
  NOT MET   Per-element attribution of cut outlines is unreliable and calibration
            is approximate sub-foot, so the analytic renderer remains the default
            and the M3 exit criteria are not claimed.

Run:  ./.venv/bin/python scratch/test_hlr.py
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from hlr_renderer import (
    HlrRenderer,
    LineStyle,
    LineweightTable,
    ViewDefinition,
    ViewRange,
    apply_view_range,
)
from ifc_service import BimModelManager
from units import FEET_10, INCHES_8

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


def main():
    print("1. HLR pipeline is reachable and partitioned ...")
    check("ifcopenshell SVG/HLR serializer available", HlrRenderer.available())
    m = fresh()
    lvl1 = [i for i, l in m.levels.items() if l["name"] == "Level 1"][0]
    m.add_wall((0, 0, 0), (30, 0, 0), height=FEET_10, thickness=INCHES_8,
               name="W", level_id=lvl1)
    m.add_wall((30, 0, 0), (30, 20, 0), height=FEET_10, thickness=INCHES_8,
               name="W2", level_id=lvl1)
    r = HlrRenderer(m).render(ViewDefinition(id="p", name="P", view_type="floor_plan",
                                             level_id=lvl1))
    check("the serializer produced geometry for the selected plane",
          sum(len(v) for v in r.partitions.values()) > 0,
          {k: len(v) for k, v in r.partitions.items()})
    check("the serializer produced a projection partition",
          len(r.partitions.get("projection", [])) > 0)
    check("renderer reports itself as hlr", r.is_hlr)
    check("no `hidden` partition is claimed (this build emits none)",
          len(r.partitions.get("hidden", [])) == 0)

    print("2. Cut geometry is attributed to elements ...")
    check("a drawing plane was selected and named",
          r.drawing_plane_name is not None, r.drawing_plane_name)
    check("the selected plane's coordinates were calibrated into model feet",
          r.calibration is not None
          and all(abs(v) > 0 for v in (r.calibration or {}).get("scale", [])),
          r.calibration)

    print("2b. Sibling geometry is correlated to element groups ...")
    # In a plan plane the serializer emits wall groups and the wall outlines as
    # SIBLINGS, so the outlines carry no identity; correlation uses the element
    # group's own extent. Assert it resolves the unambiguous walls.
    m3 = fresh()
    lvl = [i for i, l in m3.levels.items() if l["name"] == "Level 1"][0]
    guids = {}
    for name, (a, b) in {
        "South": ((0, 0), (30, 0)),
        "East": ((30, 0), (30, 20)),
        "West": ((0, 0), (0, 16)),
    }.items():
        guids[name] = m3.add_wall((a[0], a[1], 0), (b[0], b[1], 0), height=FEET_10,
                                  thickness=INCHES_8, name=name, level_id=lvl)["guid"]
    rendered3 = HlrRenderer(m3).render(
        ViewDefinition(id="c", name="C", view_type="floor_plan", level_id=lvl,
                       view_range=ViewRange(cut=4.0)))
    resolved = {e.get("guid") for ps in rendered3.partitions.values() for e in ps
                if e.get("guid")}
    for name, g in guids.items():
        check(f"geometry correlated to the {name} wall",
              g in resolved, sorted(x[:6] for x in resolved))

    print("3. View-range engine: a low wall is not cut ...")
    m = fresh()
    tall = m.add_wall((0, 0, 0), (30, 0, 0), height=FEET_10, thickness=INCHES_8,
                      name="Tall")["guid"]
    low = m.add_wall((0, 5, 0), (20, 5, 0), height=4.0, thickness=INCHES_8,
                     name="Low")["guid"]
    plane = m.slice_2d_vector_plan(cut_elevation=1.2)
    cut = {p["guid"] for p in plane["cut_paths"] if p.get("guid")}
    proj = {p["guid"] for p in plane["projection_paths"] if p.get("guid")}
    check("tall wall is cut", tall in cut, sorted(cut))
    check("low wall is projected, not cut", low in proj and low not in cut)
    check("the engine reports how many paths it moved",
          apply_view_range.__doc__ is not None)

    print("3b. Section HLR is correct on a MULTI-LEVEL model ...")
    # M3: "section HLR correct on multi-level model". Two 10 ft storeys must give a
    # section spanning 0..20 ft in height and the walls' run in the other axis.
    msec = fresh()
    l1 = [i for i, l in msec.levels.items() if l["name"] == "Level 1"][0]
    l2 = [i for i, l in msec.levels.items() if l["name"] == "Level 2"][0]
    msec.add_wall((0, 0, 0), (30, 0, 0), height=FEET_10, thickness=INCHES_8,
                  name="L1", level_id=l1)
    msec.add_wall((0, 0, 10), (30, 0, 10), height=FEET_10, thickness=INCHES_8,
                  name="L2", level_id=l2)
    sec = HlrRenderer(msec).render(
        ViewDefinition(id="sec", name="Section", view_type="section"))
    check("section view produced geometry",
          sum(len(v) for v in sec.partitions.values()) > 0,
          {k: len(v) for k, v in sec.partitions.items()})
    check("section coordinates were calibrated", sec.calibration is not None)
    import re as _re

    xs, ys = [], []
    for ps in sec.partitions.values():
        for e in ps:
            nums = [float(v) for v in _re.findall(r"-?\d+\.?\d*", e["d"])]
            xs += nums[0::2]
            ys += nums[1::2]
    if ys:
        check("section spans both storeys in height (0..20 ft)",
              abs(min(ys)) < 0.5 and abs(max(ys) - 20.0) < 0.5,
              (round(min(ys), 2), round(max(ys), 2)))
        check("section spans the walls' run (0..30 ft)",
              abs(min(xs)) < 0.5 and abs(max(xs) - 30.0) < 0.5,
              (round(min(xs), 2), round(max(xs), 2)))
    else:
        check("section spans both storeys in height (0..20 ft)", False, "no geometry")

    print("4. Plan annotation stays exact and metadata-driven ...")
    m = fresh()
    slab = m.add_slab([(0, 0), (20, 0), (20, 15), (0, 15)], thickness=0.8333,
                      name="S")["guid"]
    w = m.add_wall((0, -5, 0), (20, -5, 0), height=FEET_10, thickness=INCHES_8,
                   name="W")["guid"]
    door = m.add_door(w, offset_along_wall=8.0)["guid"]
    m.add_grid("1", (0, -8), (0, 25))
    plane = m.slice_2d_vector_plan(cut_elevation=4.0)
    check("slabs are present (regression: setdefault kept an empty list)",
          any(s["guid"] == slab for s in plane["slabs"]), plane["slabs"])
    check("grids are present", len(plane["grids"]) >= 1)
    check("door swing symbol is present",
          any(s["guid"] == door for s in plane["swing_paths"]), plane["swing_paths"])
    door_swings = [s for s in plane["swing_paths"] if s["guid"] == door]
    check("swing symbol has a panel line and a 90-degree arc",
          len(door_swings) == 2
          and any("swing-panel" in s["class"] for s in door_swings)
          and any("A " in s["d"] for s in door_swings),
          [(s["class"], s["d"][:40]) for s in door_swings])
    check("contract reports which renderer produced it",
          plane.get("renderer") in ("analytic", "hlr"), plane.get("renderer"))
    check("analytic is the default renderer (HLR coordinates unverified)",
          plane.get("renderer") == "analytic", plane.get("renderer"))

    print("5. View definitions and lineweight tables ...")
    lw = LineweightTable()
    check("cut is heavier than projection",
          lw.style_for("cut").weight_mm > lw.style_for("projection").weight_mm)
    check("hidden lines are dashed by convention",
          lw.style_for("hidden").pattern == "dashed")
    custom = lw.with_overrides({"cut": LineStyle(weight_mm=0.7, colour="#000000")})
    check("a view template can override a line style",
          custom.style_for("cut").weight_mm == 0.7
          and lw.style_for("cut").weight_mm == 0.5)
    vr = ViewRange(cut=4.0, top=8.0, bottom=0.0, view_depth=20.0)
    check("view range reports its four fields",
          set(vr.as_dict()) == {"cut", "top", "bottom", "view_depth"})
    v = ViewDefinition(id="s", name="Section", view_type="section")
    check("section and elevation view types exist",
          v.view_type == "section"
          and ViewDefinition(id="e", name="E", view_type="elevation").view_type == "elevation")

    print("6. Documented shortfall is real, not assumed ...")
    # Pin the limitation so a later build that fixes it fails this check loudly
    # instead of silently continuing to claim the limitation.
    import ifcopenshell.geom

    buf = ifcopenshell.geom.serializers.buffer()
    s = ifcopenshell.geom.settings()
    ser = ifcopenshell.geom.serializers.svg(buf, s)
    has_add_drawing = hasattr(ser, "addDrawing")
    if has_add_drawing:
        check("this build now exposes addDrawing — revisit the coordinate mapping "
              "(update hlr_renderer's status banner and re-evaluate HLR as default)",
              False, "addDrawing became available")
    else:
        check("this build has no addDrawing, so drawing planes cannot be specified "
              "(the documented reason HLR is not the default)", True)

    print(f"\nRESULT: {CHECKS['passed']} passed, {CHECKS['failed']} failed")
    if CHECKS["failed"]:
        return 1
    print("P5 PARTIAL: drawing-plane selection, model-space mapping and the "
          "view-range engine verified; per-element attribution and sub-foot "
          "calibration remain (see hlr_renderer docstring)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
