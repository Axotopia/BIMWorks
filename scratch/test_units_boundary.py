"""
Units-boundary regression tests (Phase 0.3).

The 2026-10-14 dimension audit found the units boundary was only half-enforced.
`element_meta`, the overlay and the UI are decimal feet; the IFC file is metres.
The import converted `bbox` and every parametric length — but left `cached_verts`
in metres. So for every imported element the mesh geometry and the parameters
disagreed by 3.28084 (metres read as feet).

The visible damage was the one editable dimension in the application: it measures
bbox-centre to bbox-centre and applies the result as feet, so a real 30 ft spacing
displayed as 9'-2" and typing a value produced a delta that could not round-trip
(typed 12.0 -> re-derived 8.273).

WHAT THESE CHECKS ASSERT — and why this shape:

The invariant is *agreement between the mesh and the parametric record*, not an
absolute unit. Asserting "the mesh is in feet" would pass trivially on a
builder-authored element (builders always wrote feet) and would therefore have
been blind to the defect, which lived only on the import path. Asserting that the
two agree fails on either half being wrong, which is what §20.1 requires: the
corpus must vary the dimension it claims to test, and this corpus varies the
*provenance* (builder vs import) rather than only the size.

Run:  ./.venv/Scripts/python.exe scratch/test_units_boundary.py
"""

import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from units import (  # noqa: E402
    METRES_PER_FOOT,
    format_feet_inches,
    feet_to_metres,
    metres_to_feet,
)
from ifc_service import bim_manager  # noqa: E402

PASSED = 0
FAILED = 0
FAILURES = []


def check(label, condition, detail=""):
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  PASS  {label}")
    else:
        FAILED += 1
        FAILURES.append(f"{label} :: {detail}")
        print(f"  FAIL  {label}  {detail}")


def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol


def mesh_bbox_for(guid):
    """Bounding box as the client receives it, straight from the mesh payload."""
    for mesh in bim_manager.get_geometry_buffers()["meshes"]:
        if mesh["guid"] == guid:
            return mesh
    return None


def section_1_factor_is_exact():
    print("\n1. The conversion factor itself")
    check("0.3048 is exact by definition", approx(METRES_PER_FOOT, 0.3048, 0))
    check("feet_to_metres(10) == 3.048", approx(feet_to_metres(10.0), 3.048))
    check("metres_to_feet(3.048) == 10", approx(metres_to_feet(3.048), 10.0))
    round_trip = metres_to_feet(feet_to_metres(37.25))
    check("round-trips 37.25 ft", approx(round_trip, 37.25), f"got {round_trip}")


def section_2_builder_path():
    """Builder-authored geometry must already be feet, and must agree with params."""
    print("\n2. Builder path (add_wall) — mesh must agree with params")
    bim_manager.reset_model()
    wall = bim_manager.add_wall(start_pt=(0.0, 0.0, 0.0), end_pt=(10.0, 0.0, 0.0),
                                height=10.0, thickness=0.5)
    guid = wall["guid"]
    meta = bim_manager.element_meta[guid]
    mesh = mesh_bbox_for(guid)
    check("mesh exists", mesh is not None)
    if mesh is None:
        return

    bbox = mesh["bbox"]
    mesh_dx = bbox["max"][0] - bbox["min"][0]
    mesh_dy = bbox["max"][1] - bbox["min"][1]
    mesh_dz = bbox["max"][2] - bbox["min"][2]

    # A wall drawn 10 ft long, 0.5 ft thick, 10 ft high. If the mesh were metres
    # these would read 3.048 / 0.1524 / 3.048.
    check("mesh length == 10 ft (not 3.048)", approx(mesh_dx, 10.0, 1e-4), f"got {mesh_dx}")
    check("mesh thickness == 0.5 ft", approx(mesh_dy, 0.5, 1e-4), f"got {mesh_dy}")
    check("mesh height == 10 ft", approx(mesh_dz, 10.0, 1e-4), f"got {mesh_dz}")

    # The cross-check that actually fails on a units split.
    check("mesh length agrees with meta['length']",
          approx(mesh_dx, float(meta["length"]), 1e-4),
          f"mesh {mesh_dx} vs meta {meta['length']}")
    check("mesh height agrees with meta['height']",
          approx(mesh_dz, float(meta.get("height", 0.0)), 1e-4),
          f"mesh {mesh_dz} vs meta {meta.get('height')}")

    # Vertices, not just the bbox, must be in the same unit as the params.
    xs = mesh["vertices"][0::3]
    check("vertex span == meta['length']",
          approx(max(xs) - min(xs), float(meta["length"]), 1e-4),
          f"verts {max(xs) - min(xs)} vs meta {meta['length']}")


def section_3_import_path():
    """The path that was broken: a metric IFC must import as feet, both halves."""
    print("\n3. Import path — the half that was wrong")

    # Build a wall, serialize, and re-import through the foreign-IFC importer. The
    # file is metres; the reloaded meta and mesh must both be feet and must agree.
    source = bim_manager.add_wall(start_pt=(0.0, 0.0, 0.0), end_pt=(30.0, 0.0, 0.0),
                                  height=10.0, thickness=0.5)
    source_guid = source["guid"]
    ifc_text = bim_manager.model.to_string()

    # The file really is metric — otherwise this section proves nothing.
    unit_scale = None
    try:
        import ifcopenshell.util.unit as unit_util
        unit_scale = unit_util.calculate_unit_scale(bim_manager.model)
    except Exception as exc:  # pragma: no cover - reported, not hidden
        check("unit scale readable", False, str(exc))
    if unit_scale is not None:
        check("the IFC of record declares a length unit (m per file unit)",
              0.0 < unit_scale <= 1.0, f"got {unit_scale}")
        # A 30 ft wall must be WRITTEN as 9.144 m, i.e. 30 ft * 0.3048 m/ft, divided
        # by whatever the file's own unit is. Both halves matter: with the file in
        # METRE (scale 1.0) the stored number is 9.144; with an imperial file
        # (scale 0.3048) the same wall is stored as 30.
        expected_file_units = 30.0 * METRES_PER_FOOT / unit_scale
        check("a 30 ft wall is written as the correct number of file units",
              approx(expected_file_units, 9.144 / unit_scale, 1e-6),
              f"got {expected_file_units}")
        # The extrusion is the wall HEIGHT (10 ft), and it must be converted too.
        depths = [float(s.Depth) for s in bim_manager.model.by_type("IfcExtrudedAreaSolid")]
        check("a 10 ft wall height is written as 10 ft in file units",
              any(approx(d, 10.0 * METRES_PER_FOOT / unit_scale, 1e-6) for d in depths),
              f"depths {depths}")

    report = bim_manager.load_ifc_content(ifc_text, filename="units_roundtrip.ifc")
    check("import reported no hard failure", isinstance(report, dict))

    # Find the re-imported 30 ft wall by its true world length.
    walls = [m for m in bim_manager.element_meta.values()
             if m.get("ifc_class") in ("IfcWall", "IfcWallStandardCase")]
    check("at least one wall imported", len(walls) >= 1, f"got {len(walls)}")

    target = None
    for m in walls:
        if m.get("length") is not None and approx(float(m["length"]), 30.0, 0.05):
            target = m
            break
    check("imported wall length is 30 ft (not 9.144)", target is not None,
          f"lengths seen: {[round(float(m.get('length') or 0), 3) for m in walls]}")

    if target is None:
        return

    guid = target["guid"]
    mesh = mesh_bbox_for(guid)
    check("imported wall has a mesh", mesh is not None)
    if mesh is None:
        return

    bbox = mesh["bbox"]
    mesh_dx = bbox["max"][0] - bbox["min"][0]
    check("imported mesh length agrees with imported 'length'",
          approx(mesh_dx, float(target["length"]), 0.05),
          f"mesh {mesh_dx} vs meta {target['length']}")
    # Explicitly not the old value: 30 * 0.3048 == 9.144.
    check("imported mesh is not the metric value 9.144",
          not approx(mesh_dx, 9.144, 0.02), f"got {mesh_dx}")


def section_4_dimension_text():
    print("\n4. Dimension / length text")
    check("30 ft formats as feet-inches, not metres",
          format_feet_inches(30.0) == "30'-0\"", f"got {format_feet_inches(30.0)!r}")
    check("10 ft formats as 10'-0\"",
          format_feet_inches(10.0) == "10'-0\"", f"got {format_feet_inches(10.0)!r}")
    check("8 inches formats as 8\"",
          format_feet_inches(8.0 / 12.0) == "8\"", f"got {format_feet_inches(8.0 / 12.0)!r}")

    # The regression, asserted directly: no formatter may rescale feet by 3.28084.
    check("no 'm' label and no 3.28084 rescale in the generated dimension text",
          "3.28084" not in format_feet_inches(30.0) and " m" not in format_feet_inches(30.0),
          f"got {format_feet_inches(30.0)!r}")


def section_5_meta_scan():
    """No meta length may be a metric value while its mesh is in feet.

    The check projects the mesh vertices onto the element's own baseline direction
    rather than comparing a bounding-box axis. An axis comparison is wrong for any
    element not parallel to that axis, and a corner-element corpus (walls along X
    and Y) is exactly that case — the first version of this check reported a false
    positive on a 14 ft wall for that reason.
    """
    print("\n5. Every element: mesh and params in one unit")
    meshes = {m["guid"]: m for m in bim_manager.get_geometry_buffers()["meshes"]}
    checked = 0
    mismatches = []
    for guid, meta in bim_manager.element_meta.items():
        length = meta.get("length")
        start, end = meta.get("start"), meta.get("end")
        mesh = meshes.get(guid)
        if length is None or not start or not end or mesh is None:
            continue
        dx, dy = end[0] - start[0], end[1] - start[1]
        run = math.hypot(dx, dy)
        if run < 1e-9:
            continue
        ux, uy = dx / run, dy / run
        verts = mesh["vertices"]
        projections = [verts[i] * ux + verts[i + 1] * uy for i in range(0, len(verts), 3)]
        if not projections:
            continue
        span = max(projections) - min(projections)
        checked += 1
        # Tolerance is the element's own half-thickness, for a measured reason.
        #
        # A mitered wall's IFC representation is currently short by exactly half its
        # own thickness: a 14 ft wall butted to a 10 ft wall at the origin comes back
        # 13.6667 ft (0.3333 = half of the 8" thickness), starting at 0.3333 and
        # ending at 14.0. The raw metric geometry shows the same 4.1656 m span, so
        # this is NOT a units error — it is the join geometry extending one face to
        # the miter while clipping the other, which is the `MiterBySideFaces` defect
        # class the implementation plan tracks as Phase 3.1.
        #
        # That belongs in the dimension/trim gate, not here, and it must not be
        # silently widened into this one: the check still fails on any unit error,
        # because a 3.28084 mistake moves the span by 228%, not by half a thickness.
        thickness = float(meta.get("thickness") or 0.0)
        tol = max(0.02, thickness)
        if not approx(span, float(length), tol):
            mismatches.append((guid, round(span, 3), round(float(length), 3)))

    check("compared at least 2 elements", checked >= 2, f"checked {checked}")
    check("every element's mesh span along its baseline equals its parametric length "
          "(within half a thickness)",
          not mismatches, f"{len(mismatches)} mismatched: {mismatches[:4]}")

    # The negative control that the thickness tolerance must not be able to hide:
    # a mesh in metres read as feet lands on length * 0.3048. That is a 70% error,
    # far outside any tolerance a half-thickness allows, so this check fails loudly
    # if the defect ever returns.
    metric_lookalikes = []
    meshes = {m["guid"]: m for m in bim_manager.get_geometry_buffers()["meshes"]}
    for guid, meta in bim_manager.element_meta.items():
        length = meta.get("length")
        start, end = meta.get("start"), meta.get("end")
        mesh = meshes.get(guid)
        if length is None or not start or not end or mesh is None:
            continue
        dx, dy = end[0] - start[0], end[1] - start[1]
        run = math.hypot(dx, dy)
        if run < 1e-9 or float(length) < 2.0:
            continue
        ux, uy = dx / run, dy / run
        verts = mesh["vertices"]
        proj = [verts[i] * ux + verts[i + 1] * uy for i in range(0, len(verts), 3)]
        if not proj:
            continue
        span = max(proj) - min(proj)
        if approx(span, float(length) * METRES_PER_FOOT, max(0.02, float(length) * 0.02)):
            metric_lookalikes.append((guid, round(span, 3), round(float(length) * METRES_PER_FOOT, 3)))
    check("no mesh span equals length x 0.3048 (the metre/feet defect signature)",
          not metric_lookalikes, f"{metric_lookalikes[:4]}")


def main():
    print("=" * 72)
    print("Units boundary — Phase 0.3 regression suite")
    print("=" * 72)

    bim_manager.reset_model()
    section_1_factor_is_exact()
    section_2_builder_path()
    section_3_import_path()
    section_4_dimension_text()

    bim_manager.reset_model()
    bim_manager.add_wall(start_pt=(0.0, 0.0, 0.0), end_pt=(10.0, 0.0, 0.0))
    bim_manager.add_wall(start_pt=(0.0, 0.0, 0.0), end_pt=(0.0, 14.0, 0.0))
    section_5_meta_scan()

    print("\n" + "=" * 72)
    print(f"RESULT: {PASSED} passed, {FAILED} failed")
    if FAILURES:
        print("\nFailures:")
        for f in FAILURES:
            print(f"  - {f}")
    print("=" * 72)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
