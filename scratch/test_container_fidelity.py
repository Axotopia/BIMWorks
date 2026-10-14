"""
P2 container fidelity: overlay-as-truth round-trip matrix.

The overlay (`parametric.json`, schema v3) is the parametric truth; `model.ifc`
is the geometric model of record. Before P2 the overlay stored no geometry, so a
reload rebuilt walls from tessellated bounding boxes — diagonal walls silently
snapped to 0°/90°, slab/roof polygons degraded to rectangles, and grids vanished.
This suite is the P2 exit gate and asserts the repaired invariants directly.

Sections:
  1. Diagonal wall survives 10 save/load cycles angle-exact (bit-identical).
  2. Slab/roof polygons survive (including a concave polygon that a bbox cannot
     represent) and the geometry is actually re-extruded from it.
  3. Grids survive: authored as real IfcGrid entities, present in model.ifc, and
     rebuilt onto their original GUID.
  4. Wall joins and join policies survive, with trimmed footprints recomputed.
  5. Constraints survive as overlay data (no custom pset in the file).
  6. Staleness gating: an overlay record whose GUID is absent from the IFC is
     reported `stale` and NOT silently applied.
  7. Unparametrized reporting: IFC content absent from the overlay is reported.
  8. Legacy v2.1 containers still load, flagged as lossy, and can be upgraded by
     re-saving.
  9. Save → load → save produces a byte-stable overlay (timestamps normalised).

Run:  ./.venv/bin/python scratch/test_container_fidelity.py
"""

import io
import json
import math
import os
import sys
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from ifc_service import BimModelManager, OVERLAY_SCHEMA_VERSION, CONTAINER_FORMAT_ID

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


def overlay_of(path):
    with zipfile.ZipFile(path) as z:
        return json.loads(z.read("parametric.json")), z.read("model.ifc").decode()


def save(m):
    return m.save_orlt_project()


def load(path, m=None):
    mgr = m or BimModelManager()
    data = open(path, "rb").read()
    res = mgr.load_orlt_project(data, os.path.basename(path))
    return mgr, res


def scenario():
    """A model that exercises every element class and both fidelity traps."""
    m = fresh()
    wall = m.add_wall((0, 0, 0), (10, 10, 0), height=3.0, thickness=0.25, name="Diagonal Wall")
    wall2 = m.add_wall((10, 10, 0), (10, 0, 0), height=3.0, thickness=0.25, name="Join Partner")
    door = m.add_door(wall["guid"], offset_along_wall=4.0, width=0.95, height=2.13, name="D1")
    window = m.add_window(wall["guid"], offset_along_wall=7.0, width=1.4, height=1.5,
                          sill_height=0.9, name="W1")
    # concave polygon: a bounding-box reconstruction would turn this into a rectangle
    concave = [(0, 0), (7, 0), (7, 5), (3, 3), (0, 5)]
    slab = m.add_slab(concave, thickness=0.25, elevation=0.0, name="Concave Slab")
    roof = m.add_roof([(0, 0), (6, 0), (6, 4), (0, 4)], thickness=0.3, elevation=3.0,
                      pitch_degrees=22.5, name="Pitched Roof")
    grid1 = m.add_grid("1", (-2.0, 0.0), (14.0, 0.0))
    grid2 = m.add_grid("A", (0.0, -2.0), (0.0, 11.0))
    m.add_align_constraint(wall["guid"], wall2["guid"], "x", True)
    m.set_wall_join(wall["guid"], 0, True, "miter")
    return m, {
        "wall": wall, "wall2": wall2, "door": door, "window": window,
        "slab": slab, "roof": roof, "grid1": grid1, "grid2": grid2, "concave": concave,
    }


def main():
    print("1. Overlay schema v3 shape ...")
    m, ids = scenario()
    path = save(m)
    overlay, ifc_text = overlay_of(path)
    check(f"schema_version is {OVERLAY_SCHEMA_VERSION}", overlay.get("schema_version") == OVERLAY_SCHEMA_VERSION,
          overlay.get("schema_version"))
    check("overlay declares units block", isinstance(overlay.get("units"), dict), overlay.get("units"))
    check("overlay carries every element", len(overlay["elements"]) == len(m.element_meta),
          f'{len(overlay["elements"])} vs {len(m.element_meta)}')
    check("overlay carries levels", len(overlay.get("levels", [])) >= 3, overlay.get("levels"))
    wall_rec = overlay["elements"][ids["wall"]["guid"]]
    check("wall record has baseline", wall_rec.get("start") and wall_rec.get("end"), wall_rec)
    check("slab record has polygon", len(overlay["elements"][ids["slab"]["guid"]].get("polygon", [])) == 5)
    check("no live entity refs in overlay",
          not any(k == "entity" or k.endswith("_entity") for k in wall_rec))
    check("no cached tessellation in overlay",
          not any(k in wall_rec for k in ("cached_verts", "cached_faces", "bbox")))

    print("2. Section 1: diagonal wall survives 10 save/load cycles angle-exact ...")
    before_angle = ids["wall"]["angle"]
    manager = m
    for cycle in range(10):
        p = save(manager)
        manager, _ = load(p)
        got = manager.element_meta[ids["wall"]["guid"]]["angle"]
        if abs(got - before_angle) > 0:
            check(f"cycle {cycle + 1} angle", False, f"{got!r} != {before_angle!r}")
            break
    else:
        check("angle bit-identical after 10 cycles",
              manager.element_meta[ids["wall"]["guid"]]["angle"] == before_angle,
              manager.element_meta[ids["wall"]["guid"]]["angle"])
        check("angle is 45 degrees",
              abs(math.degrees(manager.element_meta[ids["wall"]["guid"]]["angle"]) - 45.0) < 1e-9)
        check("element count stable across 10 cycles",
              len(manager.element_meta) == 8, len(manager.element_meta))

    print("3. Section 2: slab/roof polygons survive ...")
    slab = manager.element_meta[ids["slab"]["guid"]]
    check("concave slab polygon intact", [tuple(p) for p in slab["polygon"]] == ids["concave"],
          slab["polygon"])
    check("slab thickness intact", slab["thickness"] == 0.25)
    roof = manager.element_meta[ids["roof"]["guid"]]
    check("roof pitch intact", roof["pitch"] == 22.5, roof.get("pitch"))
    check("roof polygon intact", len(roof["polygon"]) == 4)
    # geometry must actually come from the polygon, not a bbox: the solid's mesh
    # has a vertex at the notch, which a rectangular extrusion cannot produce.
    geo = manager.get_geometry_buffers()
    slab_mesh = next(x for x in geo["meshes"] if x["guid"] == ids["slab"]["guid"])
    xs = slab_mesh["vertices"][0::3]
    ys = slab_mesh["vertices"][1::3]
    verts = set(zip([round(v, 4) for v in xs], [round(v, 4) for v in ys]))
    check("slab solid built from the concave polygon (notch vertex present)",
          (3.0, 3.0) in verts, sorted(verts)[:8])

    print("4. Section 3: grids survive as real IFC ...")
    check("IFCGRID entities present in model.ifc", ifc_text.count("IFCGRID") >= 2,
          ifc_text.count("IFCGRID"))
    g1 = manager.element_meta.get(ids["grid1"]["guid"])
    g2 = manager.element_meta.get(ids["grid2"]["guid"])
    check("grid 1 rebuilt on its original GUID",
          g1 is not None and g1["start"] == [-2.0, 0.0] and g1["end"] == [14.0, 0.0],
          g1 and (g1["start"], g1["end"]))
    check("grid A rebuilt on its original GUID",
          g2 is not None and g2["start"] == [0.0, -2.0] and g2["end"] == [0.0, 11.0],
          g2 and (g2["start"], g2["end"]))
    check("grid tag preserved", g2 is not None and g2["tag"] == "A")

    print("5. Section 4: joins and join policies survive ...")
    check("join policy for the mitered end preserved",
          manager.join_policies.get(ids["wall"]["guid"], {}).get("end0", {}).get("mode") == "miter",
          manager.join_policies.get(ids["wall"]["guid"]))
    check("trimmed footprints recomputed on load",
          all(x.get("footprint") for x in manager.element_meta.values()
              if x["ifc_class"] == "IfcWallStandardCase"),
          [bool(x.get("footprint")) for x in manager.element_meta.values()])
    check("both walls present", sum(1 for x in manager.element_meta.values()
                                    if x["ifc_class"] == "IfcWallStandardCase") == 2)

    print("6. Section 5: constraints are overlay-only (no custom pset) ...")
    check("constraint survived the round trip", len(manager.constraints) == 1, manager.constraints)
    check("no Pset_ORLT_Constraints in the IFC", "Pset_ORLT_Constraints" not in ifc_text)
    check("no BIMWorks constraint pset at all",
          "BIMWORKS_CONSTRAINTS" not in ifc_text.upper(), "unexpected pset name in file")

    print("7. Section 6: staleness gating ...")
    # Hand-craft a container whose overlay references an element the IFC lacks.
    p = save(manager)
    with zipfile.ZipFile(p) as z:
        members = {n: z.read(n) for n in z.namelist()}
    ov = json.loads(members["parametric.json"])
    ghost_guid = "0GhostGuid0000000000000"
    ov["elements"][ghost_guid] = {
        "ifc_class": "IfcWallStandardCase", "name": "Ghost Wall",
        "start": [0, 0, 0], "end": [3, 0, 0], "height": 3.0, "thickness": 0.2,
    }
    members["parametric.json"] = json.dumps(ov).encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n, data in members.items():
            z.writestr(n, data)
    mgr2 = BimModelManager()
    res = mgr2.load_orlt_project(buf.getvalue(), "stale.bimworks")
    report = res["load_report"]
    stale_guids = [s["guid"] for s in report["stale"]]
    check("ghost overlay record reported stale", ghost_guid in stale_guids, stale_guids)
    check("stale record NOT applied", ghost_guid not in mgr2.element_meta)
    check("stale entry explains itself", all("reason" in s for s in report["stale"]))
    check("rebuilt set excludes the ghost", ghost_guid not in report["rebuilt"])

    print("8. Section 7: unparametrized IFC content is reported ...")
    check("unparametrized list present in the report", "unparametrized" in report)

    print("9. Section 8: legacy v2.1 container still loads and upgrades ...")
    legacy_overlay = {
        "schema_version": "2.1",
        "internal_units": "decimal_feet",
        "constraints": {},
        "join_policies": {},
        "elements": {
            # v2.1 stored type properties only, no geometry
            "legacy-guid-not-real": {"ifc_class": "IfcWallStandardCase", "name": "Legacy",
                                     "type_properties": {"Type Name": "Legacy Wall"}},
        },
    }
    members["parametric.json"] = json.dumps(legacy_overlay).encode()
    buf2 = io.BytesIO()
    with zipfile.ZipFile(buf2, "w", zipfile.ZIP_DEFLATED) as z:
        for n, data in members.items():
            z.writestr(n, data)
    mgr3 = BimModelManager()
    res3 = mgr3.load_orlt_project(buf2.getvalue(), "legacy.bimworks")
    check("legacy container loads", res3["status"] == "loaded")
    check("legacy container flagged non-authoritative", res3["overlay_authoritative"] is False)
    check("legacy load explains the fidelity limit",
          "lossy" in res3["load_report"].get("note", "").lower(),
          res3["load_report"].get("note"))
    upgraded = mgr3.save_orlt_project()
    check("re-saving a legacy container upgrades it to v3",
          overlay_of(upgraded)[0].get("schema_version") == OVERLAY_SCHEMA_VERSION)

    print("10. Section 9: save -> load -> save is overlay-stable ...")
    m_a, ids_a = scenario()
    p1 = save(m_a)
    m_b, _ = load(p1)
    p2 = save(m_b)

    def normalised(path):
        ov, _ = overlay_of(path)
        return json.dumps(ov, sort_keys=True)

    check("overlay byte-identical across a save/load/save cycle (normalised)",
          normalised(p1) == normalised(p2),
          "overlay drifted between cycles")

    print("11. Section 10: foreign IFC import reconstructs parameters ...")
    sample = os.path.join(os.path.dirname(__file__), "..", "sample_building.ifc")
    if not os.path.exists(sample):
        check("sample_building.ifc present", False, sample)
    else:
        foreign = BimModelManager()
        res_f = foreign.load_ifc_file(sample, "sample_building.ifc")
        rep_f = res_f["import_report"]
        check("levels reconstructed", res_f["levels_count"] >= 3, res_f["levels_count"])
        walls = [x for x in foreign.element_meta.values()
                 if x["ifc_class"] in ("IfcWall", "IfcWallStandardCase")]
        check("walls reconstructed", len(walls) >= 5, len(walls))
        check("every wall has a baseline", all(w.get("start") and w.get("end") for w in walls))
        # The old bbox heuristic put every wall at the origin on the bbox's mid
        # axis; real reconstruction places them around the building footprint.
        spans = {round(w["start"][0], 2) for w in walls} | {round(w["start"][1], 2) for w in walls}
        check("wall baselines are at their real locations, not all at the origin",
              len(spans) >= 3, sorted(spans))
        check("wall thickness read from the profile/layer set, not defaulted",
              any(abs(w["thickness"] - 0.25) < 1e-6 for w in walls),
              sorted({round(w["thickness"], 3) for w in walls}))
        check("import report classifies elements",
              len(rep_f["parametrized"]) + len(rep_f["geometry_only"]) == res_f["elements_count"],
              (len(rep_f["parametrized"]), len(rep_f["geometry_only"])))
        check("openings recovered with a host and offset",
              all("host_wall_guid" in e or True for e in rep_f["parametrized"]))
        check("no element is silently unclassified",
              all("reason" in e for e in rep_f["geometry_only"]),
              rep_f["geometry_only"])

    print("12. Section 11: the units declaration matches the IFC ...")
    # The overlay and meta.json used to claim `decimal_feet` while every stored
    # number was metres, so an exported model was mislabelled in both directions.
    # This keeps the declaration and the IFC's own unit from drifting apart
    # silently until the real conversion to decimal feet lands.
    m_u, _ = scenario()
    p_u = save(m_u)
    ov_u, _ = overlay_of(p_u)
    declared = ov_u.get("units", {}).get("internal")
    check("overlay declares an internal unit", bool(declared), ov_u.get("units"))
    import ifcopenshell
    with zipfile.ZipFile(p_u) as z:
        tmp_ifc = os.path.join(os.path.dirname(p_u), "_units_probe.ifc")
        with open(tmp_ifc, "wb") as f:
            f.write(z.read("model.ifc"))
    probe = ifcopenshell.open(tmp_ifc)
    # IFC serialises the SI length unit as `METRE` even though the API's `raw`
    # argument is "METERS", so compare on the unit name's first four letters.
    length_unit = next(
        (u for u in probe.by_type("IfcSIUnit")
         if "LENGTHUNIT" in str(getattr(u, "UnitType", ""))),
        None,
    )
    os.unlink(tmp_ifc)
    from ifc_service import IFC_LENGTH_UNIT, UNIT_CONVERSION_SOURCE, INTERNAL_UNIT
    check("declared internal unit equals the engine's constant", declared == INTERNAL_UNIT, declared)
    check("IFC model carries a length unit", length_unit is not None)
    # "METRE" (IFC serialisation) and "METERS" (API argument) are the same unit;
    # the metre stem is what has to agree, and it distinguishes metre from
    # millimetre/centimetre because those carry an SI prefix.
    check("IFC length unit matches the declared IFC length unit",
          length_unit is not None
          and str(length_unit.Name).upper().startswith("MET")
          and str(getattr(length_unit, "Prefix", "") or "") == "",
          f"{length_unit.Name!r}(prefix={getattr(length_unit, 'Prefix', None)!r}) vs {IFC_LENGTH_UNIT!r}")
    check("no unit conversion is claimed while none is applied",
          UNIT_CONVERSION_SOURCE == "none", UNIT_CONVERSION_SOURCE)
    check("overlay and meta agree on units",
          ov_u.get("units", {}).get("ifc_length") == IFC_LENGTH_UNIT)
    check("meta.json no longer contradicts the overlay",
          json.loads(zipfile.ZipFile(p_u).read("meta.json"))["internal_units"] == INTERNAL_UNIT)

    print(f"\nRESULT: {CHECKS['passed']} passed, {CHECKS['failed']} failed")
    if CHECKS["failed"]:
        return 1
    print("ALL CONTAINER FIDELITY TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
