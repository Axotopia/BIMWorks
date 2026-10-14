"""
P4 exit criteria: sketch-based elements and direct profile editing.

Spec principle 3 — "sketch mode is a skin, not a gate" — is only true if both
skins write the same data. The plan's exit criteria state it directly:

    a gable roof (footprint + slope lines) built by direct drag and by sketch mode
    produce identical geometry; editing a wall profile to create an awning
    regenerates the wall solid and keeps its door hosted and swinging correctly.

Run:  ./.venv/bin/python scratch/test_sketch_model.py
"""

import json
import os
import sys
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from ifc_service import BimModelManager
from sketch_model import Sketch, SketchCurve, gable_roof_sketch
from units import FEET_10, INCHES_8, INCHES_12

CHECKS = {"passed": 0, "failed": 0}
FOOTPRINT = [(0, 0), (20, 0), (20, 12), (0, 12)]


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


# ---------------------------------------------------------------------------
# The two skins. Each returns (manager, roof_guid).
# ---------------------------------------------------------------------------
def build_by_editor_skin():
    """Precision 2D editor: place each curve numerically, then toggle slope."""
    m = fresh()
    roof = m.add_roof(FOOTPRINT, thickness=INCHES_12, elevation=10.0, name="Roof")["guid"]
    m.add_sketch_curve(roof, "ridge", (0, 6), (20, 6), defines_slope=True, slope_angle=30.0)
    return m, roof


def build_by_drag_skin():
    """Direct manipulation: draw the ridge roughly, then drag it into place."""
    m = fresh()
    roof = m.add_roof(FOOTPRINT, thickness=INCHES_12, elevation=10.0, name="Roof")["guid"]
    m.add_sketch_curve(roof, "ridge", (5, 4), (15, 8))
    m.move_sketch_curve(roof, "ridge", -5.0, 2.0)     # drag the edge
    m.move_sketch_vertex(roof, "ridge", 1, (10, 6))    # drag a vertex
    m.move_sketch_vertex(roof, "ridge", 0, (0, 6))     # drag a vertex
    m.move_sketch_vertex(roof, "ridge", 1, (20, 6))    # drag a vertex
    m.set_sketch_slope(roof, "ridge", True, 30.0)
    return m, roof


def awning_profile() -> Sketch:
    """A wall outline that keeps full height and pushes a band out at the top."""
    outline = [(0, 0), (20, 0), (20, 10), (6, 10), (6, 13), (0, 13)]
    sk = Sketch(kind="profile")
    for i in range(len(outline)):
        a, b = outline[i], outline[(i + 1) % len(outline)]
        sk.add_curve(SketchCurve(id=f"p{i + 1}", start=a, end=b))
    return sk


def main():
    print("1. Sketch model basics ...")
    m = fresh()
    roof = m.add_roof(FOOTPRINT, thickness=INCHES_12, elevation=10.0, name="R")["guid"]
    sk = m.get_sketch(roof)
    check("a roof owns a sketch from creation", sk is not None)
    check("the seeded sketch is the eave loop", len(sk.curves) == 4, len(sk.curves))
    check("seeded sketch is a closed loop", sk.is_closed())
    sk.add_curve(SketchCurve(id="ridge", start=(0, 6), end=(20, 6), defines_slope=True,
                             slope_angle=30.0))
    check("sketch validates once the ridge is added", sk.validate() is None, sk.validate())
    check("slope curves are reported", len(sk.slope_curves()) == 1)
    bad = Sketch(kind="roof")
    bad.add_curve(SketchCurve(id="a", start=(0, 0), end=(1, 0)))
    check("an open sketch is rejected with a reason", bad.validate() is not None, bad.validate())

    print("2. Defines-Slope has real semantics (not a global pitch) ...")
    gable = gable_roof_sketch(FOOTPRINT, slope_angle=30.0)
    heights = gable.roof_heights()
    check("all four eaves sit at the plate", all(abs(v) < 1e-9 for v in heights.values()),
          {k: round(v, 4) for k, v in heights.items()})
    # the peak lives on the interior ridge, so the *mesh* must contain it
    from sketch_model import build_roof_mesh

    verts, faces = build_roof_mesh(gable, segments=16)
    peak = max(verts[2::3])
    run = 6.0
    import math

    expected = run * math.tan(math.radians(30.0))
    check("roof mesh peaks exactly at run * tan(angle)",
          abs(peak - expected) < 1e-9, (peak, expected))
    check("roof mesh is a valid triangulation",
          len(faces) % 3 == 0 and all(i < len(verts) // 3 for i in faces))
    steeper = gable_roof_sketch(FOOTPRINT, slope_angle=45.0)
    steeper_peak = max(build_roof_mesh(steeper, segments=16)[0][2::3])
    check("a steeper slope produces a taller roof", steeper_peak > peak,
          (steeper_peak, peak))
    flat = gable_roof_sketch(FOOTPRINT)
    flat.curves = [c for c in flat.curves if not c.defines_slope]
    check("with no slope line the roof is flat",
          all(abs(v) < 1e-9 for v in flat.roof_heights().values()))

    print("3. EXIT CRITERION: both skins produce identical geometry ...")
    m1, r1 = build_by_editor_skin()
    m2, r2 = build_by_drag_skin()
    mesh1 = m1.element_meta[r1]["sketch_mesh"]
    mesh2 = m2.element_meta[r2]["sketch_mesh"]
    check("editor skin produced a pitched mesh", len(mesh1["vertices"]) > 0)
    check("drag skin produced a pitched mesh", len(mesh2["vertices"]) > 0)
    check("identical vertex buffers from both skins", mesh1["vertices"] == mesh2["vertices"],
          (len(mesh1["vertices"]), len(mesh2["vertices"])))
    check("identical index buffers from both skins", mesh1["indices"] == mesh2["indices"])
    check("identical sketch records from both skins",
          m1.get_sketch(r1).to_dict() == m2.get_sketch(r2).to_dict())
    check("identical footprint from both skins",
          m1.get_sketch(r1).footprint() == m2.get_sketch(r2).footprint())
    check("both peaks equal run * tan(30)",
          abs(max(mesh1["vertices"][2::3]) - max(mesh2["vertices"][2::3])) < 1e-12)

    print("4. Sketch edits recompute the solid ...")
    m = fresh()
    roof = m.add_roof(FOOTPRINT, thickness=INCHES_12, elevation=10.0, name="R")["guid"]
    m.add_sketch_curve(roof, "ridge", (0, 6), (20, 6), defines_slope=True, slope_angle=30.0)
    before = list(m.element_meta[roof]["sketch_mesh"]["vertices"])
    # drag an eave outward: the whole solid must change
    m.move_sketch_vertex(roof, "eave2", 1, (24, 0))
    after = m.element_meta[roof]["sketch_mesh"]["vertices"]
    check("editing the footprint regenerates the mesh", before != after)
    check("the footprint picked up the dragged corner",
          any(abs(p[0] - 24.0) < 1e-9 for p in m.get_sketch(roof).footprint()),
          m.get_sketch(roof).footprint())
    check("the roof is still valid after the edit", m.get_sketch(roof).validate() is None)
    # raising the slope angle raises the roof
    m.set_sketch_slope(roof, "ridge", True, 45.0)
    raised = max(m.element_meta[roof]["sketch_mesh"]["vertices"][2::3])
    check("changing the slope angle re-pitches the roof", raised > max(before[2::3]),
          (raised, max(before[2::3])))

    print("5. Sketches persist through the container (N13) ...")
    m = fresh()
    roof = m.add_roof(FOOTPRINT, thickness=INCHES_12, elevation=10.0, name="R")["guid"]
    m.add_sketch_curve(roof, "ridge", (0, 6), (20, 6), defines_slope=True, slope_angle=30.0)
    original_mesh = m.element_meta[roof]["sketch_mesh"]
    path = m.save_orlt_project()
    with zipfile.ZipFile(path) as z:
        overlay = json.loads(z.read("parametric.json"))
    check("the overlay carries the sketch record", "sketch" in overlay["elements"][roof])
    reloaded = BimModelManager()
    reloaded.load_orlt_project(open(path, "rb").read(), "T.bimworks")
    restored = reloaded.get_sketch(roof)
    check("the sketch survives a reload", restored is not None and len(restored.curves) == 5,
          restored and len(restored.curves))
    check("slope definition survives", len(restored.slope_curves()) == 1)
    check("the regenerated mesh is identical to the saved one",
          reloaded.element_meta[roof]["sketch_mesh"] == original_mesh)

    print("6. EXIT CRITERION: wall profile -> awning keeps the door hosted ...")
    m = fresh()
    wall = m.add_wall((0, 0, 0), (20, 0, 0), height=FEET_10, thickness=INCHES_8, name="Wall")["guid"]
    door = m.add_door(wall, offset_along_wall=9.0, width=3.0, height=7.0)["guid"]
    opening = m.element_meta[door].get("opening_guid")
    check("door is hosted before the profile edit", door in m.element_meta[wall]["hosted_openings"])
    check("door has an opening element", opening is not None)
    check("door has a plan swing", any(
        p.get("guid") == door for p in m.slice_2d_vector_plan()["swing_paths"]))

    res = m.set_wall_profile(wall, awning_profile())
    check("profile applied", res["status"] == "profile-applied")
    check("profile reports the hosted opening", res["hosted_openings"] == [door], res["hosted_openings"])
    mesh = m.element_meta[wall].get("profile_mesh")
    check("wall solid regenerated from the profile", mesh is not None and len(mesh["vertices"]) > 0)
    zs = mesh["vertices"][2::3]
    check("the awning rises above the original wall height", max(zs) > FEET_10, max(zs))
    check("the wall base is unchanged", abs(min(zs)) < 1e-9, min(zs))

    check("door is STILL hosted after the profile edit",
          door in m.element_meta[wall]["hosted_openings"])
    check("door keeps its opening element",
          m.element_meta[door].get("opening_guid") == opening)
    check("door keeps its position along the wall",
          abs(m.element_meta[door]["offset_along_wall"] - 9.0) < 1e-9,
          m.element_meta[door]["offset_along_wall"])
    check("door keeps its swing state", "swing_flipped" in m.element_meta[door])
    check("door still swings in plan after the profile edit", any(
        p.get("guid") == door for p in m.slice_2d_vector_plan()["swing_paths"]))
    # and it still swings after being moved
    m.translate_element(door, 2.0, 0.0, 0.0)
    check("door still swings after a move", any(
        p.get("guid") == door for p in m.slice_2d_vector_plan()["swing_paths"]))

    print("7. Profile editing is guarded where it would be ill-defined ...")
    m = fresh()
    angled = m.add_wall((0, 0, 0), (10, 10, 0), height=FEET_10, thickness=INCHES_8, name="A")["guid"]
    try:
        m.set_wall_profile(angled, awning_profile())
        check("an angled wall is rejected rather than approximated", False,
              "no error raised")
    except ValueError as e:
        check("an angled wall is rejected rather than approximated", "axis-aligned" in str(e), e)
    slab = m.add_slab(FOOTPRINT, name="S")["guid"]
    try:
        m.set_wall_profile(slab, awning_profile())
        check("a non-wall is rejected", False, "no error raised")
    except ValueError:
        check("a non-wall is rejected", True)

    print(f"\nRESULT: {CHECKS['passed']} passed, {CHECKS['failed']} failed")
    if CHECKS["failed"]:
        return 1
    print("ALL P4 SKETCH TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
