import os
import sys
import tempfile
import math

backend_path = os.path.abspath("backend")
if backend_path not in sys.path:
    sys.path.insert(0, backend_path)

import ifcopenshell
import ifcopenshell.geom
from ifc_service import bim_manager
from main import load_sample_building

# Step 1: Create sample building & export
load_sample_building()
ifc_path = bim_manager.export_ifc_step()

with open(ifc_path, "r", encoding="utf-8") as f:
    ifc_text = f.read()

# Step 2: Define load_ifc_content on a fresh instance
from ifc_service import BimModelManager
mgr = BimModelManager()

# Let's run the proposed load_ifc_content logic
mgr.model = ifcopenshell.open(ifc_path)
projects = mgr.model.by_type("IfcProject")
mgr.project = projects[0]
mgr.project_name = mgr.project.Name or "Imported"
mgr.element_meta = {}
mgr.levels = {}
mgr.constraints = {}

storeys = mgr.model.by_type("IfcBuildingStorey")
for storey in storeys:
    elevation = 0.0
    if hasattr(storey, "Elevation") and storey.Elevation is not None:
        try:
            elevation = float(storey.Elevation)
        except Exception:
            pass
    mgr.levels[storey.GlobalId] = {
        "id": storey.GlobalId,
        "name": storey.Name or f"Level {len(mgr.levels) + 1}",
        "elevation": elevation,
        "entity": storey,
    }

print("Loaded storeys:", len(mgr.levels))

wall_to_openings = {}
for rel in mgr.model.by_type("IfcRelVoidsElement"):
    if hasattr(rel, "RelatingBuildingElement") and hasattr(rel, "RelatedOpeningElement"):
        w_guid = rel.RelatingBuildingElement.GlobalId
        op_guid = rel.RelatedOpeningElement.GlobalId
        wall_to_openings.setdefault(w_guid, []).append(op_guid)

opening_to_filling = {}
for rel in mgr.model.by_type("IfcRelFillsElement"):
    if hasattr(rel, "RelatingOpeningElement") and hasattr(rel, "RelatedBuildingElement"):
        op_guid = rel.RelatingOpeningElement.GlobalId
        fill_guid = rel.RelatedBuildingElement.GlobalId
        opening_to_filling[op_guid] = fill_guid

filling_to_wall = {}
for w_guid, op_guids in wall_to_openings.items():
    for op_guid in op_guids:
        fill_guid = opening_to_filling.get(op_guid)
        if fill_guid:
            filling_to_wall[fill_guid] = w_guid

settings = ifcopenshell.geom.settings()
settings.set(settings.USE_WORLD_COORDS, True)

for p in mgr.model.by_type("IfcProduct"):
    if p.is_a("IfcOpeningElement") or p.is_a("IfcSpatialStructureElement") or p.is_a("IfcGrid"):
        continue
    guid = p.GlobalId
    name = p.Name or p.is_a()
    ifc_class = p.is_a()
    raw_verts, raw_faces = [], []
    min_x, max_x, min_y, max_y, min_z, max_z = 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
    try:
        shape = ifcopenshell.geom.create_shape(settings, p)
        geom = shape.geometry
        raw_verts = list(geom.verts)
        raw_faces = list(geom.faces)
        if raw_verts:
            xs = raw_verts[0::3]
            ys = raw_verts[1::3]
            zs = raw_verts[2::3]
            min_x, max_x = min(xs), max(xs)
            min_y, max_y = min(ys), max(ys)
            min_z, max_z = min(zs), max(zs)
    except Exception:
        pass

    dx = max_x - min_x
    dy = max_y - min_y
    dz = max_z - min_z

    meta = {
        "entity": p,
        "guid": guid,
        "ifc_class": ifc_class,
        "name": name,
        "cached_verts": raw_verts,
        "cached_faces": raw_faces,
        "bbox": {"min": [min_x, min_y, min_z], "max": [max_x, max_y, max_z]},
    }
    if ifc_class in ("IfcWall", "IfcWallStandardCase"):
        if dx >= dy:
            start = [min_x, (min_y + max_y) / 2.0, min_z]
            end = [max_x, (min_y + max_y) / 2.0, min_z]
            thickness = max(dy, 0.15)
            length = dx
            angle = 0.0
        else:
            start = [(min_x + max_x) / 2.0, min_y, min_z]
            end = [(min_x + max_x) / 2.0, max_y, min_z]
            thickness = max(dx, 0.15)
            length = dy
            angle = math.pi / 2.0

        meta.update({
            "start": start,
            "end": end,
            "thickness": thickness,
            "height": max(dz, 2.5),
            "length": length,
            "angle": angle,
            "hosted_openings": wall_to_openings.get(guid, []),
        })
    elif ifc_class in ("IfcDoor", "IfcWindow"):
        host_w_guid = filling_to_wall.get(guid)
        width = max(dx, dy)
        meta.update({
            "host_wall_guid": host_w_guid,
            "width": max(width, 0.8),
            "height": max(dz, 1.0),
            "offset_along_wall": 0.0,
            "swing_flipped": False,
        })
    elif ifc_class == "IfcSlab":
        meta.update({
            "thickness": max(dz, 0.1),
            "elevation": min_z,
            "polygon": [[min_x, min_y], [max_x, min_y], [max_x, max_y], [min_x, max_y]],
        })
    elif ifc_class == "IfcRoof":
        meta.update({
            "thickness": max(dz, 0.2),
            "elevation": min_z,
        })

    mgr.element_meta[guid] = meta

print("Loaded elements:", len(mgr.element_meta))

# Test geometry buffer generation
geom_data = mgr.get_geometry_buffers()
print("Geometry meshes count:", len(geom_data["meshes"]))

# Test 2D slice generation
slice_data = mgr.slice_2d_vector_plan()
print("2D cut paths:", len(slice_data["cut_paths"]), "projections:", len(slice_data["projection_paths"]))
print("ALL TESTS PASSED!")
