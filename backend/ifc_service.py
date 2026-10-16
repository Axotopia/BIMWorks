"""
BIMWorks - Native IFC4 BIM Engine Sidecar
Powered by IfcOpenShell, IfcGeom, and PyMuPDF.
Strict buildingSMART IFC4 Schema compliance.
"""

import os
import math
import copy
import uuid
import tempfile
import zipfile
import io
import json
import time
from typing import Dict, List, Optional, Tuple, Any
import numpy as np

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.api.root
import ifcopenshell.api.unit
import ifcopenshell.api.context
import ifcopenshell.api.aggregate
import ifcopenshell.api.spatial
import ifcopenshell.api.geometry
import ifcopenshell.api.feature
import ifcopenshell.api.georeference
import ifcopenshell.geom
import ifcopenshell.util.placement as plc
import ifcopenshell.util.unit as unit_util
import ifcopenshell.util.element as elem_util

try:
    import pymupdf
except ImportError:
    import fitz as pymupdf


# Hybrid project container (zip: model.ifc + parametric.json + views + meta).
# `.bimworks` is the canonical extension (spec §0.1 / §11.2). `.orlt` is the
# pre-rename "Open-Revit-LT" leftover retained as a load-recognized alias so
# projects saved by the 2026-10-13 prototype still open.
CONTAINER_EXTENSION = ".bimworks"
LEGACY_CONTAINER_EXTENSION = ".orlt"
CONTAINER_EXTENSIONS = (CONTAINER_EXTENSION, LEGACY_CONTAINER_EXTENSION)
CONTAINER_FORMAT_ID = "bimworks_hybrid_v3"

# Overlay schema. v2.1 stored only type properties (no geometry), which forced
# the loader to reconstruct walls from tessellated bounding boxes. v3 stores the
# full parametric definition per element. v4 adds canonical Reference schemas
# with durable kinds, sources, and hints.
OVERLAY_SCHEMA_VERSION = 4
LEGACY_OVERLAY_SCHEMA_VERSIONS = ("2.1", 3)

# ---------------------------------------------------------------------------
# UNITS (P2-F). Read backend/units.py before touching any dimension.
#
# The internal unit is DECIMAL FEET (spec §11.3) and this module imports its
# dimensions from `units` rather than carrying metric literals. The IFC declares a
# conversion-based foot unit, so model.ifc, the overlay and every stored parameter
# are all in feet — there is exactly one unit in the system and no conversion to
# get wrong.
#
# Re-exported here so existing imports (`from ifc_service import INTERNAL_UNIT`)
# keep working, and so the overlay/meta declarations have a single source.
# ---------------------------------------------------------------------------
from units import (  # noqa: E402  (kept beside the constants it documents)
    INTERNAL_UNIT,
    IFC_LENGTH_UNIT,
    UNIT_CONVERSION_SOURCE,
    METRES_PER_FOOT,
    inches_to_feet,
    FEET_0, FEET_1, FEET_2, FEET_4, FEET_6, FEET_8, FEET_10, FEET_12,
    INCHES_4, INCHES_8, INCHES_4_7_8, INCHES_10, INCHES_12, INCHES_0_625,
    DOOR_WIDTH_36, DOOR_HEIGHT_84,
    WINDOW_WIDTH_48, WINDOW_HEIGHT_48, WINDOW_SILL_36,
    DOOR_PANEL_THICKNESS, WINDOW_FRAME_THICKNESS,
    format_feet_inches,
    feet_to_metres,
)
from references import (
    normalize_reference,
    reference_key,
    resolve_reference,
    resolve_reference_axis,
    repair_reference,
    referenceable_kinds,
    worst_outcome,
)




# NOTE ON IFC GEOMETRY UNITS (established by tracing raw STEP output against
# ifcopenshell 0.9, because the docs do not state it and the behaviour is
# inconsistent):
#
#   * The profile OUTLINE from `profile.add_arbitrary_profile` and the axis curve
#     from `grid.create_axis_curve` are unit-converted: supply SI metres.
#   * `geometry.add_profile_representation(depth)` and
#     `geometry.add_wall_representation(length/height/thickness)` are NOT
#     converted the same way - a value passed as 10 serialised as 32.8 in a
#     foot-based file while the outline beside it serialised 98.4 for an input of
#     30. A single file therefore ended up mixed-unit.
#   * `geometry.edit_object_placement(matrix)` converts unless `is_si=False`,
#     which is why every placement call here passes `is_si=False`.
#
# The IFC is therefore authored in METERS - the one setting under which every one
# of those paths agrees - and the builders convert decimal feet to metres on the
# way in. The overlay stays in decimal feet because that is the spec's internal
# unit and what the UI edits. One conversion, at this boundary.

def _scale_path(d: str, fn) -> str:
    """
    Scales every coordinate in an SVG path string.

    Used for the units boundary: mesh geometry is metric (the IFC's unit) while the
    2D view contract is decimal feet.
    """
    import re as _re

    if not d:
        return d
    nums = _re.findall(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", d)
    cmds = _re.findall(r"[MLZ]", d.upper())
    if not nums or not cmds:
        return d
    out = []
    idx = 0
    for cmd in cmds:
        if cmd == "Z":
            out.append("Z")
            continue
        if idx + 1 >= len(nums):
            break
        x = fn(float(nums[idx]))
        y = fn(float(nums[idx + 1]))
        idx += 2
        out.append(f"{cmd} {x:.4f} {y:.4f}")
    return " ".join(out) if out else d


class BimModelManager:
    """
    Manages an active IFC4 document in memory with parametric dependency graph,
    3D mesh generation via IfcGeom, 2D vector slicing, and vector PDF compilation.
    """

    def __init__(self, project_name: str = "BIMWorks Project"):
        self.project_name = project_name
        self.reset_model()

    def reset_model(self):
        """Initializes a clean, standard IFC4 building model structure."""
        self.model = ifcopenshell.api.run("project.create_file", version="IFC4")
        self.project = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcProject", name=self.project_name
        )
        # UNITS AT THIS BOUNDARY (spec §11.3, P2-F).
        #
        # Decimal feet is the parametric/internal unit, but the IFC is authored in
        # METERS: that is IFC's native convention, it is what IFC-native tools
        # expect, and it avoids ifcopenshell's geometry usecases applying scale
        # inconsistently (verified: one file serialised a wall outline in metres
        # while its extrusion depth and placement were in feet).
        #
        # So: `element_meta`, the overlay and the UI are decimal feet; the IFC file
        # is metres; the builders convert on the way in and the import converts on
        # the way out. backend/units.py owns the factor.
        ifcopenshell.api.run(
            "unit.assign_unit",
            self.model,
            length={"is_metric": True, "raw": "METERS"},
            area={"is_metric": True, "raw": "SQUARE_METERS"},
            volume={"is_metric": True, "raw": "CUBIC_METERS"},
        )

        # Contexts
        self.context_model = ifcopenshell.api.run(
            "context.add_context", self.model, context_type="Model"
        )
        self.context_body = ifcopenshell.api.run(
            "context.add_context",
            self.model,
            context_type="Model",
            context_identifier="Body",
            target_view="MODEL_VIEW",
            parent=self.context_model,
        )
        self.context_plan = ifcopenshell.api.run(
            "context.add_context",
            self.model,
            context_type="Plan",
            context_identifier="FootPrint",
            target_view="PLAN_VIEW",
            parent=self.context_model,
        )

        # Spatial Hierarchy: Project -> Site -> Building -> Storeys
        self.site = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcSite", name="Default Site"
        )
        ifcopenshell.api.run(
            "aggregate.assign_object", self.model, relating_object=self.project, products=[self.site]
        )

        self.building = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcBuilding", name="Main Building"
        )
        ifcopenshell.api.run(
            "aggregate.assign_object", self.model, relating_object=self.site, products=[self.building]
        )

        # Document epoch ID and section revisions (N1, N4)
        self.doc_id: str = str(uuid.uuid4())
        self.levels_rev: int = 0
        self.grids_rev: int = 0
        self.sheets_rev: int = 0
        self.views_rev: int = 0
        self.constraints_rev: int = 0
        self.wall_joins_rev: int = 0
        self.project_rev: int = 0
        self.dimensions_rev: int = 0
        self.types_rev: int = 0
        self.type_registry: Dict[str, Dict[str, Any]] = {}

        # Storeys (Levels)
        self.levels: Dict[str, Any] = {}
        self.add_level("Level 1", 0.0)
        self.add_level("Level 2", FEET_10)
        self.add_level("Roof", FEET_10 * 2)

        # Elements internal tracking
        self.element_meta: Dict[str, Dict[str, Any]] = {}
        self.undo_stack: List[str] = []
        self.redo_stack: List[str] = []
        self.mesh_revs: Dict[str, int] = {}
        self.dirty_mesh_guids: Set[str] = set()
        self.removed_guids_by_rev: Dict[int, List[str]] = {}
        self._pending_removed_guids: List[str] = []
        self.removed_items_by_rev: Dict[int, List[Dict[str, Any]]] = {}
        self._pending_removed_items: List[Dict[str, Any]] = []

        # Mesh HLR projection caches (Phase 1.3c)
        self._prepared_mesh_cache: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
        self._cut_mesh_cache: Dict[Tuple[Any, ...], List[Dict[str, Any]]] = {}

        # 1D/2D Parametric Constraints Manager
        self.constraints: Dict[str, Dict[str, Any]] = {}
        # Parametric Overlay Dimensions (Phase 2)
        self.dimensions: Dict[str, Dict[str, Any]] = {}
        # Last over-constraint/conflict report from the solver (None when clean).
        self.last_constraint_conflict: Optional[Dict[str, Any]] = None
        # Counters from the most recent incremental recompute (P3), used by the
        # latency measurement and to show the recompute is local.
        self.last_join_stats: Dict[str, Any] = {}
        self._dependency_graph = None

        # Wall Join Policies (Butt / Miter / Square-off and per-endpoint allowJoin)
        self.join_policies: Dict[str, Dict[str, Any]] = {}

        # Bulk-rebuild guard. While replaying the overlay we create elements in
        # dependency order, and per-element join recomputation is both wrong
        # (partners do not exist yet) and dangerous: `_rebuild_wall_representation`
        # calls `remove_representation` on a wall whose representation graph is
        # still being assembled, which segfaults inside ifcopenshell. Joins are
        # therefore suppressed during the replay and recomputed once at the end.
        self._suppress_join_recompute = False

        # UI-P0-7: georeferencing starts UNSET. It used to be seeded with a real
        # EPSG:2285 / NAD83 Washington North position, which meant a new project
        # could be saved carrying survey coordinates that belong to nobody. The
        # user sets a CRS explicitly through /api/georeference (the dialog shows
        # "Not set" until they do).
        self.georeference_data = {
            "projected_crs": "",
            "eastings": 0.0,
            "northings": 0.0,
            "elevation": 0.0,
            "true_north": 0.0,  # degrees
            "scale": 1.0,
        }
        self.apply_georeferencing()
        self.load_constraints_from_ifc()

        # Views & Sheets subsystem (P6 / SPECIFICATION-v0.2.md §13)
        self.views: Dict[str, Dict[str, Any]] = {
            "view-3d": {
                "id": "view-3d",
                "name": "{3D}",
                "type": "3d",
                "scale": '1/8" = 1\'-0"',
                "detail_level": "medium",
                "visual_style": "consistent_colors",
                "view_range": {"top": 8.0, "cut": 4.0, "bottom": 0.0, "view_depth": 0.0},
            },
            "view-level-1": {
                "id": "view-level-1",
                "name": "Floor Plan: Level 1",
                "type": "floor_plan",
                "level_id": "level_1",
                "scale": '1/4" = 1\'-0"',
                "detail_level": "medium",
                "visual_style": "hidden_line",
                "view_range": {"top": 8.0, "cut": 4.0, "bottom": 0.0, "view_depth": 0.0},
            },
            "view-level-2": {
                "id": "view-level-2",
                "name": "Floor Plan: Level 2",
                "type": "floor_plan",
                "level_id": "level_2",
                "scale": '1/4" = 1\'-0"',
                "detail_level": "medium",
                "visual_style": "hidden_line",
                "view_range": {"top": 8.0, "cut": 4.0, "bottom": 0.0, "view_depth": 0.0},
            },
            "view-roof": {
                "id": "view-roof",
                "name": "Floor Plan: Roof",
                "type": "floor_plan",
                "level_id": "roof",
                "scale": '1/4" = 1\'-0"',
                "detail_level": "medium",
                "visual_style": "hidden_line",
                "view_range": {"top": 30.0, "cut": 20.0, "bottom": 0.0, "view_depth": 0.0},
            },
            "view-elev-s": {
                "id": "view-elev-s",
                "name": "Elevation: South",
                "type": "elevation",
                "scale": '1/4" = 1\'-0"',
                "detail_level": "medium",
                "visual_style": "hidden_line",
                "view_range": {"top": 8.0, "cut": 4.0, "bottom": 0.0, "view_depth": 0.0},
            },
            "view-elev-n": {
                "id": "view-elev-n",
                "name": "Elevation: North",
                "type": "elevation",
                "scale": '1/4" = 1\'-0"',
                "detail_level": "medium",
                "visual_style": "hidden_line",
                "view_range": {"top": 8.0, "cut": 4.0, "bottom": 0.0, "view_depth": 0.0},
            },
            "view-elev-e": {
                "id": "view-elev-e",
                "name": "Elevation: East",
                "type": "elevation",
                "scale": '1/4" = 1\'-0"',
                "detail_level": "medium",
                "visual_style": "hidden_line",
                "view_range": {"top": 8.0, "cut": 4.0, "bottom": 0.0, "view_depth": 0.0},
            },
            "view-elev-w": {
                "id": "view-elev-w",
                "name": "Elevation: West",
                "type": "elevation",
                "scale": '1/4" = 1\'-0"',
                "detail_level": "medium",
                "visual_style": "hidden_line",
                "view_range": {"top": 8.0, "cut": 4.0, "bottom": 0.0, "view_depth": 0.0},
            },
            "view-sect-a": {
                "id": "view-sect-a",
                "name": "Section: Building Section 1",
                "type": "section",
                "scale": '1/4" = 1\'-0"',
                "detail_level": "medium",
                "visual_style": "hidden_line",
                "view_range": {"top": 8.0, "cut": 4.0, "bottom": 0.0, "view_depth": 0.0},
            },
        }

        self.sheets: Dict[str, Dict[str, Any]] = {
            "sheet-a101": {
                "id": "sheet-a101",
                "sheet_number": "A101",
                "sheet_title": "FLOOR PLAN & SECTIONS",
                "paper_size": "ARCH_D",
                "project_name": self.project_name,
                "date": "2026-10-13",
                "drawn_by": "BIMWorks Architect",
                "is_placeholder": False,
                "viewports": [
                    {
                        "id": "vp-1",
                        "view_id": "view-level-1",
                        "x": 80.0,
                        "y": 120.0,
                        "width": 480.0,
                        "height": 380.0,
                        "scale_factor": 1.0,
                    }
                ],
            },
            "sheet-a201": {
                "id": "sheet-a201",
                "sheet_number": "A201",
                "sheet_title": "BUILDING ELEVATIONS",
                "paper_size": "ARCH_D",
                "project_name": self.project_name,
                "date": "2026-10-13",
                "drawn_by": "BIMWorks Architect",
                "is_placeholder": False,
                "viewports": [],
            },
        }

        self._init_default_types()

    def _init_default_types(self) -> None:
        """Initializes the default Revit-style type registry and links IFC type products."""
        defaults = [
            {
                "id": "wall-type-cmu-10",
                "name": 'Basic Wall : Exterior - 10" CMU',
                "ifc_class": "IfcWallType",
                "parameters": {
                    "thickness": 10.0 / 12.0,
                    "function": "Exterior",
                    "fire_rating": "2 HR",
                    "structural_material": "Concrete Masonry Units",
                    "thermal_resistance": "R-19.0",
                    "layers": [
                        {"name": "Exterior Finish", "thickness": 1.0 / 12.0, "material": "Stucco", "function": "Finish 1"},
                        {"name": "Core", "thickness": 8.0 / 12.0, "material": "Concrete Masonry Units", "function": "Structure"},
                        {"name": "Interior Finish", "thickness": 1.0 / 12.0, "material": "Gypsum Wall Board", "function": "Finish 2"},
                    ],
                },
            },
            {
                "id": "wall-type-cmu-8",
                "name": 'Basic Wall : Exterior - 8" CMU',
                "ifc_class": "IfcWallType",
                "parameters": {
                    "thickness": 8.0 / 12.0,
                    "function": "Exterior",
                    "fire_rating": "2 HR",
                    "structural_material": "Concrete Masonry Units",
                    "thermal_resistance": "R-15.0",
                    "layers": [
                        {"name": "Core", "thickness": 8.0 / 12.0, "material": "Concrete Masonry Units", "function": "Structure"},
                    ],
                },
            },
            {
                "id": "wall-type-partition-478",
                "name": 'Basic Wall : Interior - 4 7/8" Partition',
                "ifc_class": "IfcWallType",
                "parameters": {
                    "thickness": 4.875 / 12.0,
                    "function": "Interior",
                    "fire_rating": "1 HR",
                    "structural_material": "Gypsum Wall Board on Metal Stud",
                    "thermal_resistance": "R-11.0",
                    "layers": [
                        {"name": "Finish 1", "thickness": 0.625 / 12.0, "material": "Gypsum Wall Board", "function": "Finish 1"},
                        {"name": "Core", "thickness": 3.625 / 12.0, "material": "Metal Stud Layer", "function": "Structure"},
                        {"name": "Finish 2", "thickness": 0.625 / 12.0, "material": "Gypsum Wall Board", "function": "Finish 2"},
                    ],
                },
            },
            {
                "id": "wall-type-partition-6",
                "name": 'Basic Wall : Interior - 6" Partition',
                "ifc_class": "IfcWallType",
                "parameters": {
                    "thickness": 6.0 / 12.0,
                    "function": "Interior",
                    "fire_rating": "1 HR",
                    "structural_material": "Metal Stud",
                    "thermal_resistance": "R-13.0",
                    "layers": [
                        {"name": "Core", "thickness": 6.0 / 12.0, "material": "Metal Stud", "function": "Structure"},
                    ],
                },
            },
            {
                "id": "door-type-single-flush-36",
                "name": 'Single-Flush : 36" x 84"',
                "ifc_class": "IfcDoorType",
                "parameters": {
                    "width": 3.0,
                    "height": 7.0,
                    "fire_rating": "20 MIN",
                    "material": "Wood Flush Panel",
                    "function": "Interior",
                },
            },
            {
                "id": "door-type-single-flush-30",
                "name": 'Single-Flush : 30" x 84"',
                "ifc_class": "IfcDoorType",
                "parameters": {
                    "width": 2.5,
                    "height": 7.0,
                    "fire_rating": "20 MIN",
                    "material": "Wood Flush Panel",
                    "function": "Interior",
                },
            },
            {
                "id": "window-type-fixed-36x48",
                "name": 'Fixed : 36" x 48"',
                "ifc_class": "IfcWindowType",
                "parameters": {
                    "width": 3.0,
                    "height": 4.0,
                    "sill_height": 3.0,
                    "thermal_resistance": "U-0.28",
                    "material": "Double Glazed Low-E Aluminum",
                    "function": "Exterior",
                },
            },
            {
                "id": "window-type-fixed-48x48",
                "name": 'Fixed : 48" x 48"',
                "ifc_class": "IfcWindowType",
                "parameters": {
                    "width": 4.0,
                    "height": 4.0,
                    "sill_height": 3.0,
                    "thermal_resistance": "U-0.28",
                    "material": "Double Glazed Low-E Aluminum",
                    "function": "Exterior",
                },
            },
        ]
        for d in defaults:
            self._register_type_entity(d["id"], d["name"], d["ifc_class"], d["parameters"])

    def _register_type_entity(
        self, type_id: str, name: str, ifc_class: str, parameters: Dict[str, Any]
    ) -> Dict[str, Any]:
        entity = None
        try:
            entity = ifcopenshell.api.run("root.create_entity", self.model, ifc_class=ifc_class, name=name)
            pset_name = "Pset_WallCommon" if "Wall" in ifc_class else ("Pset_DoorCommon" if "Door" in ifc_class else "Pset_WindowCommon")
            pset = ifcopenshell.api.run("pset.add_pset", self.model, product=entity, name=pset_name)
            props = {}
            if "fire_rating" in parameters:
                props["FireRating"] = str(parameters["fire_rating"])
            if "thermal_resistance" in parameters:
                props["ThermalTransmittance"] = str(parameters["thermal_resistance"])
            if props:
                ifcopenshell.api.run("pset.edit_pset", self.model, pset=pset, properties=props)
        except Exception:
            pass

        rec = {
            "id": type_id,
            "name": name,
            "ifc_class": ifc_class,
            "parameters": copy.deepcopy(parameters),
            "entity": entity,
        }
        self.type_registry[type_id] = rec
        self.types_rev += 1
        return rec

    def get_types(self) -> List[Dict[str, Any]]:
        out = []
        for tid, t in sorted(self.type_registry.items(), key=lambda x: x[0]):
            out.append({
                "id": t["id"],
                "name": t["name"],
                "ifc_class": t["ifc_class"],
                "parameters": self._jsonable(t["parameters"]),
            })
        return out

    def create_type(
        self, type_id: str, name: str, ifc_class: str = "IfcWallType", parameters: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        if parameters is None:
            parameters = {}
        rec = self._register_type_entity(type_id, name, ifc_class, parameters)
        self.project_rev += 1
        return {"status": "created", "type_id": type_id, "name": name}

    def duplicate_type(self, source_type_id: str, new_type_id: str, new_name: str) -> Dict[str, Any]:
        if source_type_id not in self.type_registry:
            raise KeyError(f"Source type '{source_type_id}' not found in registry")
        source = self.type_registry[source_type_id]
        rec = self._register_type_entity(new_type_id, new_name, source["ifc_class"], source["parameters"])
        self.project_rev += 1
        return {"status": "duplicated", "type_id": new_type_id, "name": new_name}

    def update_type(self, type_id: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
        if type_id not in self.type_registry:
            raise KeyError(f"Type '{type_id}' not found in registry")
        t = self.type_registry[type_id]
        t["parameters"].update(copy.deepcopy(parameters))

        # Propagate to all instances referencing this type
        affected_walls = []
        for guid, meta in self.element_meta.items():
            if meta.get("type_id") == type_id:
                if meta.get("ifc_class") in ("IfcWallStandardCase", "IfcWall"):
                    if "thickness" in parameters:
                        meta["thickness"] = float(parameters["thickness"])
                        meta["footprint"] = None
                        self._rebuild_wall_representation(guid)
                        self._invalidate_geometry_cache(guid)
                        self.mark_mesh_dirty(guid)
                        affected_walls.append(guid)
                elif meta.get("ifc_class") == "IfcDoor":
                    if "width" in parameters:
                        meta["width"] = float(parameters["width"])
                    if "height" in parameters:
                        meta["height"] = float(parameters["height"])
                    self._invalidate_geometry_cache(guid)
                    self.mark_mesh_dirty(guid)
                elif meta.get("ifc_class") == "IfcWindow":
                    if "width" in parameters:
                        meta["width"] = float(parameters["width"])
                    if "height" in parameters:
                        meta["height"] = float(parameters["height"])
                    self._invalidate_geometry_cache(guid)
                    self.mark_mesh_dirty(guid)

        if affected_walls:
            self.recompute_wall_joins(only=affected_walls)

        self.types_rev += 1
        self.project_rev += 1
        return {"status": "updated", "type_id": type_id, "parameters": t["parameters"]}

    def delete_type(self, type_id: str) -> bool:
        if type_id in self.type_registry:
            del self.type_registry[type_id]
            self.types_rev += 1
            return True
        return False

    def set_element_type(self, guid: str, type_id: str) -> Dict[str, Any]:
        if guid not in self.element_meta:
            raise KeyError(f"Element '{guid}' not found")
        if type_id not in self.type_registry:
            raise KeyError(f"Type '{type_id}' not found in registry")

        meta = self.element_meta[guid]
        t = self.type_registry[type_id]
        meta["type_id"] = type_id
        meta["name"] = t["name"]

        # Re-link IfcRelDefinesByType
        entity = meta.get("entity")
        type_ent = t.get("entity")
        if entity and type_ent:
            try:
                for rel in self.model.by_type("IfcRelDefinesByType"):
                    if entity in rel.RelatedObjects:
                        rel_objs = [o for o in rel.RelatedObjects if o != entity]
                        if rel_objs:
                            rel.RelatedObjects = rel_objs
                        else:
                            self.model.remove(rel)
                        break
                ifcopenshell.api.run("type.assign_type", self.model, related_objects=[entity], relating_type=type_ent)
            except Exception:
                pass

        if meta.get("ifc_class") in ("IfcWallStandardCase", "IfcWall"):
            if "thickness" in t["parameters"]:
                meta["thickness"] = float(t["parameters"]["thickness"])
            meta["footprint"] = None
            self._rebuild_wall_representation(guid)
            self._invalidate_geometry_cache(guid)
            self.mark_mesh_dirty(guid)
            self.recompute_wall_joins(only=[guid])
        elif meta.get("ifc_class") == "IfcDoor":
            if "width" in t["parameters"]:
                meta["width"] = float(t["parameters"]["width"])
            if "height" in t["parameters"]:
                meta["height"] = float(t["parameters"]["height"])
            self._invalidate_geometry_cache(guid)
            self.mark_mesh_dirty(guid)
        elif meta.get("ifc_class") == "IfcWindow":
            if "width" in t["parameters"]:
                meta["width"] = float(t["parameters"]["width"])
            if "height" in t["parameters"]:
                meta["height"] = float(t["parameters"]["height"])
            self._invalidate_geometry_cache(guid)
            self.mark_mesh_dirty(guid)

        self.project_rev += 1
        return {"status": "updated", "guid": guid, "type_id": type_id, "name": t["name"]}
    # Transactional state snapshots (GLM Master Spec v2.3 §3.2)
    # A snapshot captures the complete IFC STEP text plus all in-memory
    # tracking state. Entity references are excluded (they are re-resolved
    # by GUID on restore, since they belong to the previous file object).
    # ------------------------------------------------------------------
    def snapshot_state(self) -> Dict[str, Any]:
        def _clean_meta(meta: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, str]]:
            """Strips live entity refs; records their GlobalIds for re-attachment."""
            safe: Dict[str, Any] = {}
            refs: Dict[str, str] = {}
            for k, v in meta.items():
                if k == "entity" or k.endswith("_entity"):
                    gid = getattr(v, "GlobalId", None)
                    if gid:
                        refs[k] = gid
                    continue
                safe[k] = copy.deepcopy(v)
            return safe, refs

        element_state, element_refs = {}, {}
        for guid, meta in self.element_meta.items():
            element_state[guid], element_refs[guid] = _clean_meta(meta)

        levels_state, levels_refs = {}, {}
        for lid, lv in self.levels.items():
            levels_state[lid], levels_refs[lid] = _clean_meta(lv)

        return {
            "ifc_text": self.model.to_string(),
            "element_meta": element_state,
            "element_entity_refs": element_refs,
            "levels": levels_state,
            "levels_entity_refs": levels_refs,
            "constraints": copy.deepcopy(self.constraints),
            "join_policies": copy.deepcopy(self.join_policies),
            "sheets": copy.deepcopy(self.sheets),
            "views": copy.deepcopy(self.views),
            "dimensions": copy.deepcopy(getattr(self, "dimensions", {})),
            "georeference_data": copy.deepcopy(self.georeference_data),
            "project_name": self.project_name,
            "type_registry": {
                tid: {k: copy.deepcopy(v) for k, v in trec.items() if k != "entity"}
                for tid, trec in getattr(self, "type_registry", {}).items()
            },
            "types_rev": getattr(self, "types_rev", 0),
            "mesh_revs": copy.deepcopy(self.mesh_revs),
            "dirty_mesh_guids": copy.copy(self.dirty_mesh_guids),
            "removed_guids_by_rev": copy.deepcopy(self.removed_guids_by_rev),
            "pending_removed_guids": list(self._pending_removed_guids),
            "removed_items_by_rev": copy.deepcopy(self.removed_items_by_rev),
            "pending_removed_items": list(self._pending_removed_items),
            "doc_id": self.doc_id,
            "levels_rev": self.levels_rev,
            "grids_rev": self.grids_rev,
            "sheets_rev": self.sheets_rev,
            "views_rev": self.views_rev,
            "constraints_rev": self.constraints_rev,
            "wall_joins_rev": self.wall_joins_rev,
            "project_rev": self.project_rev,
            "dimensions_rev": getattr(self, "dimensions_rev", 0),
        }

    def restore_state(self, snap: Dict[str, Any]) -> None:
        """Restores a full-state snapshot taken by snapshot_state()."""
        self.model = ifcopenshell.file.from_string(snap["ifc_text"])

        # Re-resolve structural entities
        projects = self.model.by_type("IfcProject")
        self.project = projects[0] if projects else None
        sites = self.model.by_type("IfcSite")
        self.site = sites[0] if sites else None
        buildings = self.model.by_type("IfcBuilding")
        self.building = buildings[0] if buildings else None

        # Re-resolve representation contexts (recreate as fallback)
        def _ctx(ctx_type: str, identifier: Optional[str]):
            for c in self.model.by_type("IfcGeometricRepresentationContext"):
                if getattr(c, "ContextType", None) != ctx_type:
                    continue
                cid = getattr(c, "ContextIdentifier", None)
                if (identifier is None and cid in (None, "")) or (
                    identifier is not None and cid == identifier
                ):
                    return c
            return None

        self.context_model = _ctx("Model", None)
        self.context_body = _ctx("Model", "Body")
        self.context_plan = _ctx("Plan", "FootPrint")
        if self.context_model is None:
            self.context_model = ifcopenshell.api.run(
                "context.add_context", self.model, context_type="Model"
            )
        if self.context_body is None:
            self.context_body = ifcopenshell.api.run(
                "context.add_context",
                self.model,
                context_type="Model",
                context_identifier="Body",
                target_view="MODEL_VIEW",
                parent=self.context_model,
            )
        if self.context_plan is None:
            self.context_plan = ifcopenshell.api.run(
                "context.add_context",
                self.model,
                context_type="Plan",
                context_identifier="FootPrint",
                target_view="PLAN_VIEW",
                parent=self.context_model,
            )

        # Restore in-memory tracking and re-attach live entity references
        self.element_meta = copy.deepcopy(snap["element_meta"])
        element_refs = snap.get("element_entity_refs", {})
        for guid, meta in self.element_meta.items():
            try:
                meta["entity"] = self.model.by_guid(guid)
            except Exception:
                meta.pop("entity", None)
            for ref_key, ref_gid in element_refs.get(guid, {}).items():
                try:
                    meta[ref_key] = self.model.by_guid(ref_gid)
                except Exception:
                    pass  # referenced entity no longer exists (e.g. healed opening)

        self.levels = copy.deepcopy(snap["levels"])
        levels_refs = snap.get("levels_entity_refs", {})
        for lid, lv in self.levels.items():
            try:
                lv["entity"] = self.model.by_guid(lid)
            except Exception:
                lv.pop("entity", None)
            for ref_key, ref_gid in levels_refs.get(lid, {}).items():
                try:
                    lv[ref_key] = self.model.by_guid(ref_gid)
                except Exception:
                    pass

        self.constraints = copy.deepcopy(snap["constraints"])
        self.join_policies = copy.deepcopy(snap["join_policies"])
        self.sheets = copy.deepcopy(snap.get("sheets", {}))
        self.views = copy.deepcopy(snap.get("views", {}))
        self.dimensions = copy.deepcopy(snap.get("dimensions", {}))
        self.georeference_data = copy.deepcopy(snap["georeference_data"])
        self.project_name = snap["project_name"]
        self.mesh_revs = copy.deepcopy(snap.get("mesh_revs", {}))
        self.dirty_mesh_guids = copy.copy(snap.get("dirty_mesh_guids", set()))
        self.removed_guids_by_rev = copy.deepcopy(snap.get("removed_guids_by_rev", {}))
        self._pending_removed_guids = list(snap.get("pending_removed_guids", []))
        self.removed_items_by_rev = copy.deepcopy(snap.get("removed_items_by_rev", {}))
        self._pending_removed_items = list(snap.get("pending_removed_items", []))
        self.doc_id = snap.get("doc_id", getattr(self, "doc_id", str(uuid.uuid4())))
        self.levels_rev = snap.get("levels_rev", 0)
        self.grids_rev = snap.get("grids_rev", 0)
        self.sheets_rev = snap.get("sheets_rev", 0)
        self.views_rev = snap.get("views_rev", 0)
        self.constraints_rev = snap.get("constraints_rev", 0)
        self.wall_joins_rev = snap.get("wall_joins_rev", 0)
        self.project_rev = snap.get("project_rev", 0)
        self.dimensions_rev = snap.get("dimensions_rev", 0)
        self.types_rev = snap.get("types_rev", 0)
        self.type_registry = copy.deepcopy(snap.get("type_registry", {}))
        for trec in self.type_registry.values():
            if trec.get("ifc_class") and trec.get("name"):
                ents = [e for e in self.model.by_type(trec["ifc_class"]) if getattr(e, "Name", None) == trec["name"]]
                trec["entity"] = ents[0] if ents else None

    def mark_mesh_dirty(self, *guids: str, clear_cache: bool = True) -> None:
        """Marks elements as having modified geometry/placement."""
        for guid in guids:
            if not guid:
                continue
            self.dirty_mesh_guids.add(guid)
            if clear_cache:
                meta = self.element_meta.get(guid)
                if meta:
                    meta.pop("cached_verts", None)
                    meta.pop("cached_faces", None)
                    meta.pop("bbox", None)
                    meta["geom_rev"] = meta.get("geom_rev", 0) + 1

    def mark_element_removed(self, guid: str) -> None:
        """Records an element deletion so delta queries report remove_guids."""
        lid = None
        if guid in self.element_meta:
            lid = self.element_meta[guid].get("level_id")
        self._pending_removed_guids.append(guid)
        self._pending_removed_items.append({"guid": guid, "level_id": lid})
        self.dirty_mesh_guids.discard(guid)
        self.mesh_revs.pop(guid, None)
        if hasattr(self, "_prepared_mesh_cache"):
            for k in [k for k in self._prepared_mesh_cache if k[0] == guid]:
                self._prepared_mesh_cache.pop(k, None)
        if hasattr(self, "_cut_mesh_cache"):
            for k in [k for k in self._cut_mesh_cache if k[0] == guid]:
                self._cut_mesh_cache.pop(k, None)

    def commit_revision(self, rev: int) -> None:
        """Advances dirty elements and removed elements to rev."""
        for guid in self.dirty_mesh_guids:
            if guid in self.element_meta:
                self.mesh_revs[guid] = rev
        self.dirty_mesh_guids.clear()
        if self._pending_removed_guids:
            self.removed_guids_by_rev.setdefault(rev, []).extend(self._pending_removed_guids)
            self._pending_removed_guids = []
        if self._pending_removed_items:
            self.removed_items_by_rev.setdefault(rev, []).extend(self._pending_removed_items)
            self._pending_removed_items = []

    def add_level(self, name: str, elevation: float) -> str:
        """Adds an IfcBuildingStorey level."""
        storey = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcBuildingStorey", name=name
        )
        storey.Elevation = float(elevation)
        ifcopenshell.api.run(
            "aggregate.assign_object", self.model, relating_object=self.building, products=[storey]
        )
        level_id = storey.GlobalId
        self.levels[level_id] = {
            "id": level_id,
            "name": name,
            "elevation": float(elevation),
            "entity": storey,
        }
        self.levels_rev += 1
        return level_id

    # =========================================================================
    # SKETCH DATA MODEL (P4): sketch edits and sketch-driven recompute
    # =========================================================================
    # Both editing skins — the precision 2D sketch editor and direct manipulation
    # (dragging an edge or a vertex) — go through these operations. The editor and
    # the drag handlers convert their gesture into the same call, so the two skins
    # cannot produce different geometry for the same intent.

    @staticmethod
    def _seed_roof_sketch(polygon_pts) -> Any:
        """An eave-only sketch for a roof created from a bare polygon."""
        from sketch_model import Sketch, SketchCurve

        sk = Sketch(kind="roof")
        for i in range(len(polygon_pts)):
            a = polygon_pts[i]
            b = polygon_pts[(i + 1) % len(polygon_pts)]
            sk.add_curve(SketchCurve(id=f"eave{i + 1}",
                                     start=(float(a[0]), float(a[1])),
                                     end=(float(b[0]), float(b[1]))))
        return sk

    def get_sketch(self, guid: str) -> Optional[Any]:
        """Returns the element's sketch, or None when it has none."""
        meta = self.element_meta.get(guid)
        if not meta or not meta.get("sketch"):
            return None
        from sketch_model import Sketch

        return Sketch.from_dict(meta["sketch"])

    def set_roof_sketch(self, guid: str, sketch: Any) -> Dict[str, Any]:
        """
        Installs (or replaces) a roof's sketch and regenerates its geometry.

        This is the single entry point both skins use: the sketch editor calls it
        on Finish, and a drag calls it with the mutating operation already applied.
        """
        if guid not in self.element_meta:
            raise KeyError(f"Element {guid} not found")
        meta = self.element_meta[guid]
        if meta.get("ifc_class") != "IfcRoof":
            raise ValueError("set_roof_sketch expects a roof")

        problem = sketch.validate()
        if problem:
            raise ValueError(problem)

        meta["sketch"] = sketch.to_dict()
        footprint = sketch.footprint()
        meta["polygon"] = [[float(x), float(y)] for x, y in footprint]
        if sketch.thickness:
            meta["thickness"] = float(sketch.thickness)
        if sketch.slope_curves():
            meta["pitch"] = float(
                sketch.slope_curves()[0].slope_angle
                if sketch.slope_curves()[0].slope_angle is not None
                else sketch.default_slope_angle
            )
        self._regenerate_sketch_geometry(guid)
        self._recompute_after_sketch(guid)
        return {
            "status": "sketch-applied",
            "guid": guid,
            "curves": len(sketch.curves),
            "slope_lines": len(sketch.slope_curves()),
            "footprint": meta["polygon"],
        }

    def move_sketch_vertex(self, guid: str, curve_id: str, end_index: int,
                           to: Tuple[float, float]) -> Dict[str, Any]:
        """Direct manipulation: drag one sketch vertex (the 'drag a vertex' skin)."""
        return self._edit_sketch(
            guid, lambda sk: sk.move_vertex(curve_id, end_index, (float(to[0]), float(to[1]))),
            "vertex-moved",
        )

    def move_sketch_curve(self, guid: str, curve_id: str, dx: float, dy: float) -> Dict[str, Any]:
        """Direct manipulation: drag a whole sketch edge (the 'drag an edge' skin)."""
        return self._edit_sketch(
            guid, lambda sk: sk.move_curve(curve_id, float(dx), float(dy)), "edge-moved"
        )

    def set_sketch_slope(self, guid: str, curve_id: str, defines: bool,
                         angle: Optional[float] = None) -> Dict[str, Any]:
        """Toggles Revit's Defines-Slope on a sketch curve, optionally setting its angle."""
        return self._edit_sketch(
            guid, lambda sk: sk.set_defines_slope(curve_id, defines, angle), "slope-set"
        )

    def add_sketch_curve(self, guid: str, curve_id: str, start: Tuple[float, float],
                         end: Tuple[float, float], defines_slope: bool = False,
                         slope_angle: Optional[float] = None) -> Dict[str, Any]:
        """Adds a sketch curve (what the editor's Line/Rectangle tool emits)."""
        from sketch_model import SketchCurve

        def op(sk):
            sk.add_curve(SketchCurve(
                id=curve_id, start=(float(start[0]), float(start[1])),
                end=(float(end[0]), float(end[1])),
                defines_slope=bool(defines_slope), slope_angle=slope_angle,
            ))
            return True

        return self._edit_sketch(guid, op, "curve-added")

    def remove_sketch_curve(self, guid: str, curve_id: str) -> Dict[str, Any]:
        return self._edit_sketch(guid, lambda sk: sk.remove_curve(curve_id), "curve-removed")

    def _edit_sketch(self, guid: str, operation, status: str) -> Dict[str, Any]:
        """
        Loads the sketch, applies one mutation, then re-applies it to the model.

        Keeping mutation and application in one place is what guarantees the two
        skins agree: a drag and an editor commit differ only in which `operation`
        they pass.
        """
        sketch = self.get_sketch(guid)
        if sketch is None:
            raise ValueError(f"Element {guid} has no sketch")
        if not operation(sketch):
            raise ValueError("Sketch operation had no effect (unknown curve?)")
        result = self.set_roof_sketch(guid, sketch)
        result["status"] = status
        return result

    # -- wall profiles (P4 exit criterion: profile edit -> awning) ------------
    def set_wall_profile(self, guid: str, profile_sketch: Any) -> Dict[str, Any]:
        """
        Applies a vertical wall profile: a closed outline in the wall's own U-Z
        plane (U along the baseline from its start, Z the elevation above the
        wall's base), swept across the wall thickness.

        This is how a wall gets an awning: the outline keeps the eaves at the base
        height and pushes a band of it outwards/upwards, and because the geometry is
        rebuilt from the profile the host wall changes shape *around* its openings
        rather than replacing them.

        The wall must be axis-aligned in plan for this to be geometrically
        well-defined without a general sweep (the same restriction the rest of the
        V1 pipeline has); an angled wall is rejected rather than silently
        approximated.
        """
        if guid not in self.element_meta:
            raise KeyError(f"Wall {guid} not found")
        meta = self.element_meta[guid]
        if meta.get("ifc_class") not in ("IfcWallStandardCase", "IfcWall"):
            raise ValueError("set_wall_profile expects a wall")

        problem = profile_sketch.validate()
        if problem:
            raise ValueError(problem)

        angle = float(meta.get("angle", 0.0))
        if abs(math.sin(angle)) > 1e-9 and abs(math.cos(angle)) > 1e-9:
            raise ValueError(
                "Profile editing currently needs an axis-aligned wall; "
                "angled walls would need a general sweep"
            )

        meta["profile"] = profile_sketch.to_dict()
        self._regenerate_profile_geometry(guid)

        # The openings' own placement is expressed relative to the wall baseline,
        # so it survives a profile change untouched. Re-run joins so any
        # neighbour whose trim depended on this wall follows.
        self.recompute_wall_joins()
        return {
            "status": "profile-applied",
            "guid": guid,
            "curves": len(profile_sketch.curves),
            "hosted_openings": list(meta.get("hosted_openings", [])),
        }

    def _regenerate_profile_geometry(self, guid: str) -> None:
        """
        Builds `profile_mesh` for a wall from its stored profile and makes the IFC
        representation contain that region.

        The mesh is derived from the profile alone: front/back faces plus a swept
        side wall, in world coordinates (local U along the baseline from its start,
        V across the thickness).
        """
        meta = self.element_meta.get(guid)
        if not meta or not meta.get("profile"):
            return
        from sketch_model import Sketch

        sketch = Sketch.from_dict(meta["profile"])
        ring = sketch.footprint()
        if len(ring) < 3:
            return

        sp = meta.get("start", [0.0, 0.0, 0.0])
        ep = meta.get("end", [1.0, 0.0, 0.0])
        thickness = float(meta.get("thickness", INCHES_8))
        base_z = float(sp[2]) if len(sp) > 2 else 0.0
        length = float(meta.get("length") or math.hypot(ep[0] - sp[0], ep[1] - sp[1]))

        # Local U is measured from the fixed (start) end. When the sketch runs from
        # the far end, flip it so "the awning is at the door end" behaves sensibly.
        xs = [p[0] for p in ring]
        if min(xs) >= -1e-9 and max(xs) > length + 1e-6:
            ring = [(length - u, z) for u, z in ring]

        verts: List[float] = []
        front: List[int] = []
        back: List[int] = []
        for u, z in ring:
            verts.extend([sp[0] + float(u), sp[1], base_z + float(z)])          # front face
            front.append(len(verts) // 3 - 1)
        for u, z in ring:
            verts.extend([sp[0] + float(u), sp[1] + thickness, base_z + float(z)])  # back face
            back.append(len(verts) // 3 - 1)

        faces: List[int] = []
        n = len(ring)

        def as_plan(u: float, v: float) -> Tuple[float, float]:
            return (sp[0] + float(u), sp[1] + float(v))

        faces = []
        # Side walls of the sweep (quads around the outline).
        for i in range(n):
            nxt = (i + 1) % n
            faces.extend([front[i], front[nxt], back[nxt]])
            faces.extend([front[i], back[nxt], back[i]])
        # End caps, triangulated as fans from the first vertex.
        for i in range(1, n - 1):
            faces.extend([front[0], front[i + 1], front[i]])
        for i in range(1, n - 1):
            faces.extend([back[0], back[i], back[i + 1]])

        meta["profile_mesh"] = {"vertices": verts, "indices": faces}
        xs3 = verts[0::3]; ys3 = verts[1::3]; zs3 = verts[2::3]
        meta["bbox"] = {
            "min": [min(xs3), min(ys3), min(zs3)],
            "max": [max(xs3), max(ys3), max(zs3)],
        }

        # Make the IFC representation cover the profiled region as well, so the
        # model of record is not a plain rectangle for a wall that now has an
        # awning. The swept outline is projected into plan space and unioned with
        # the footprint polygon used by the join engine.
        try:
            plan_outline = [
                as_plan(u, 0.0) for u, _z in ring
            ] + [as_plan(u, thickness) for u, _z in reversed(ring)]
            base_footprint = meta.get("footprint") or self._wall_rect(meta)
            meta["footprint"] = self._get_2d_hull(list(base_footprint) + plan_outline)
        except Exception as e:
            print(f"Notice: could not fold the profile into the wall footprint: {e}")

    def _regenerate_sketch_geometry(self, guid: str) -> None:
        """
        Rebuilds a roof's display geometry from its sketch.

        Stored on the meta as `sketch_mesh` rather than as the IFC Body
        representation: an arbitrary pitched surface is not representable as the
        extruded profile the rest of the pipeline writes, and silently flattening it
        into an extrusion is exactly the "model looks right but is wrong" failure
        this project has been fixing. The parametric truth (the sketch) is what
        persists; the IFC keeps a valid bounding extrusion for interop.
        """
        meta = self.element_meta.get(guid)
        if not meta or not meta.get("sketch"):
            return
        from sketch_model import Sketch, build_roof_mesh

        sketch = Sketch.from_dict(meta["sketch"])
        try:
            verts, faces = build_roof_mesh(sketch)
        except Exception as e:
            print(f"Notice: could not build sketch geometry for {guid}: {e}")
            return
        if not verts:
            return
        meta["sketch_mesh"] = {"vertices": verts, "indices": faces}
        # `build_roof_mesh` authors in decimal feet (the sketch is overlay data); the
        # element cache is kept in the file's unit, so normalise through the one writer.
        self._cache_verts(guid, verts, faces, in_feet=True)
        xs = verts[0::3]
        ys = verts[1::3]
        zs = verts[2::3]
        meta["bbox"] = {"min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]}

    def _recompute_after_sketch(self, guid: str) -> None:
        """Routes a sketch edit through the P3 dependency graph."""
        try:
            from dependency_graph import DependencyGraph

            graph = DependencyGraph.build(self)
            self.last_join_stats = graph.recompute([guid])
        except Exception as e:
            print(f"Notice: recompute after sketch edit failed: {e}")

    # =========================================================================
    # MODIFY TOOLS (P3): Copy / Rotate / Offset / Mirror / Trim-Extend / Split
    # =========================================================================
    # Each is a plain geometry operation so it can be driven from the CommandBus
    # (and therefore journaled, undoable and usable by the AI planner) rather than
    # only from a UI handler.

    def copy_element(self, guid: str, dx: float, dy: float, dz: float = 0.0) -> Dict[str, Any]:
        """Copies an element, offset by (dx, dy, dz). The copy gets a new GUID."""
        if guid not in self.element_meta:
            raise KeyError(f"Element {guid} not found")
        src = self.element_meta[guid]
        ifc_class = src.get("ifc_class")

        if ifc_class in ("IfcWallStandardCase", "IfcWall"):
            start = src["start"]; end = src["end"]
            new = self.add_wall(
                (start[0] + dx, start[1] + dy, start[2] + dz),
                (end[0] + dx, end[1] + dy, end[2] + dz),
                height=src.get("height", FEET_10),
                thickness=src.get("thickness", INCHES_8),
                level_id=src.get("level_id"),
                name=f"{src.get('name')} (copy)",
            )
        elif ifc_class in ("IfcDoor", "IfcWindow"):
            host = src.get("host_wall_guid")
            if host not in self.element_meta:
                raise ValueError("Hosted element's host wall is missing")
            insert = self.add_door if ifc_class == "IfcDoor" else self.add_window
            kwargs = {
                "host_wall_guid": host,
                "offset_along_wall": src.get("offset_along_wall", 0.0) + float(dx),
                "width": src.get("width", 3.0),
                "height": src.get("height", 7.0),
                "name": f"{src.get('name')} (copy)",
            }
            if ifc_class == "IfcWindow":
                kwargs["sill_height"] = src.get("sill_height", 3.0)
            new = insert(**kwargs)
        elif ifc_class == "IfcSlab":
            new = self.add_slab(
                [(x + dx, y + dy) for x, y in src.get("polygon", [])],
                thickness=src.get("thickness", INCHES_10),
                elevation=src.get("elevation", 0.0) + dz,
                level_id=src.get("level_id"), name=f"{src.get('name')} (copy)",
            )
        elif ifc_class == "IfcRoof":
            new = self.add_roof(
                [(x + dx, y + dy) for x, y in src.get("polygon", [])],
                thickness=src.get("thickness", INCHES_12),
                elevation=src.get("elevation", FEET_10) + dz,
                pitch_degrees=src.get("pitch", 15.0),
                level_id=src.get("level_id"), name=f"{src.get('name')} (copy)",
            )
        elif ifc_class == "IfcGrid":
            new = self.add_grid(
                src.get("tag", "1"),
                (src["start"][0] + dx, src["start"][1] + dy),
                (src["end"][0] + dx, src["end"][1] + dy),
            )
        else:
            raise ValueError(f"Copy is not supported for {ifc_class}")
        return {"status": "created", "guid": new["guid"], "source_guid": guid}

    def rotate_element(self, guid: str, angle_degrees: float,
                       center: Optional[Tuple[float, float]] = None) -> Dict[str, Any]:
        """
        Rotates an element about `center` (default: its own centroid).

        Currently supports walls (the case the modelling tools need), rebuilding
        the baseline from the rotated endpoints and re-running joins.
        """
        if guid not in self.element_meta:
            raise KeyError(f"Element {guid} not found")
        meta = self.element_meta[guid]
        if meta.get("ifc_class") not in ("IfcWallStandardCase", "IfcWall"):
            raise ValueError("Rotate is currently supported for walls")

        sp, ep = meta["start"], meta["end"]
        # A wall's stored placement is "start point + rotation", and the profile is
        # built in that local frame, so the baseline must be rotated about the
        # START. Rotating about an arbitrary centre would need the start point
        # moved as well; rotating about the start keeps `angle` and the placement
        # consistent, which is what the geometry rebuild depends on.
        center = (sp[0], sp[1]) if center is None else (float(center[0]), float(center[1]))
        rad = math.radians(float(angle_degrees))
        ca, sa = math.cos(rad), math.sin(rad)

        def rot(p):
            x, y = p[0] - center[0], p[1] - center[1]
            return (center[0] + x * ca - y * sa, center[1] + x * sa + y * ca)

        ns, ne = rot(sp), rot(ep)
        meta["start"] = [ns[0], ns[1], sp[2]]
        meta["end"] = [ne[0], ne[1], ep[2]]
        length = math.hypot(ne[0] - ns[0], ne[1] - ns[1])
        meta["length"] = length
        meta["angle"] = math.atan2(ne[1] - ns[1], ne[0] - ns[0])
        # Rebuild through the same path a translate uses so geometry and joins stay
        # consistent with every other edit.
        meta["footprint"] = None
        self._rebuild_wall_representation(guid)
        self.mark_mesh_dirty(guid)
        self.recompute_wall_joins()
        return {"status": "rotated", "guid": guid, "angle": meta["angle"], "length": length}

    def offset_element(self, guid: str, distance: float,
                       side: int = 1) -> Dict[str, Any]:
        """Offsets a wall perpendicular to its baseline (`side` 1 = left, -1 = right)."""
        if guid not in self.element_meta:
            raise KeyError(f"Element {guid} not found")
        meta = self.element_meta[guid]
        if meta.get("ifc_class") not in ("IfcWallStandardCase", "IfcWall"):
            raise ValueError("Offset is currently supported for walls")
        ang = float(meta.get("angle", 0.0))
        nx, ny = -math.sin(ang) * float(distance) * int(side), math.cos(ang) * float(distance) * int(side)
        ok = self.translate_element(guid, nx, ny, 0.0)
        return {"status": "offset", "guid": guid, "dx": nx, "dy": ny, "moved": bool(ok)}

    def _wall_baseline_line(self, meta: Dict[str, Any]):
        sp, ep = meta["start"], meta["end"]
        return (sp[0], sp[1]), (ep[0] - sp[0], ep[1] - sp[1])

    def trim_extend_wall(
        self,
        guid: str,
        end_index: int,
        target_guid: str,
        corner_mode: bool = True,
        target_end_index: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Moves wall endpoints onto their intersection with another wall or datum.
        - corner_mode=True (TR): moves BOTH guid and target_guid endpoints to the intersection.
        - corner_mode=False: moves guid's endpoint clamped to target's body.
        - Datum trimming: supports trimming/extending to IfcGrid and Level datums.
        Uses scoped join recomputes.
        """
        if guid not in self.element_meta:
            raise KeyError(f"Wall {guid} not found")
        meta = self.element_meta[guid]
        if meta.get("ifc_class") not in ("IfcWallStandardCase", "IfcWall"):
            raise ValueError("Trim/Extend source must be a wall")

        # 1. Datum trimming to Level
        level_record = self.levels.get(target_guid)
        if not level_record:
            for lid, lv in self.levels.items():
                if lv.get("name") == target_guid:
                    level_record = lv
                    break
        if level_record is not None:
            target_elev = float(level_record["elevation"])
            old_base = meta["start"][2]
            old_height = float(meta.get("height", FEET_10))
            if int(end_index) == 1:
                # Trim / extend top of wall to level
                new_height = max(0.1, target_elev - old_base)
                meta["height"] = new_height
            else:
                # Trim / extend base of wall to level
                new_base = target_elev
                meta["start"][2] = new_base
                meta["end"][2] = new_base
                meta["height"] = max(0.1, old_height - (new_base - old_base))
            meta["footprint"] = None
            self._rebuild_wall_representation(guid)
            self.mark_mesh_dirty(guid)
            return {
                "status": "datum_trimmed",
                "guid": guid,
                "level_id": level_record.get("id", target_guid),
                "height": meta["height"],
            }

        if target_guid not in self.element_meta:
            raise KeyError(f"Target {target_guid} not found")
        target = self.element_meta[target_guid]

        # 2. Datum trimming to IfcGrid
        if target.get("ifc_class") == "IfcGrid":
            p1, d1 = self._wall_baseline_line(meta)
            p2, d2 = self._wall_baseline_line(target)
            hit = self._line_intersect(p1, d1, p2, d2)
            if hit is None:
                raise ValueError("Wall and grid line are parallel")
            key = "start" if int(end_index) == 0 else "end"
            old = list(meta[key])
            meta[key] = [float(hit[0]), float(hit[1]), old[2]]
            sp, ep = meta["start"], meta["end"]
            meta["length"] = math.hypot(ep[0] - sp[0], ep[1] - sp[1])
            meta["angle"] = math.atan2(ep[1] - sp[1], ep[0] - sp[0])
            meta["footprint"] = None
            self._rebuild_wall_representation(guid)
            self.mark_mesh_dirty(guid)
            self.recompute_wall_joins(only=[guid])
            return {
                "status": "datum_trimmed",
                "guid": guid,
                "end_index": int(end_index),
                "target_guid": target_guid,
                "new_point": [float(hit[0]), float(hit[1])],
                "length": meta["length"],
            }

        # 3. Wall to Wall trimming
        if target.get("ifc_class") not in ("IfcWallStandardCase", "IfcWall"):
            raise ValueError("Trim/Extend target must be a wall, grid, or level")

        p1, d1 = self._wall_baseline_line(meta)
        p2, d2 = self._wall_baseline_line(target)
        hit = self._line_intersect(p1, d1, p2, d2)
        if hit is None:
            raise ValueError("Walls are parallel; there is no corner to trim to")

        if corner_mode:
            # Wall 1 endpoint
            key1 = "start" if int(end_index) == 0 else "end"
            old1 = list(meta[key1])
            meta[key1] = [float(hit[0]), float(hit[1]), old1[2]]
            sp1, ep1 = meta["start"], meta["end"]
            meta["length"] = math.hypot(ep1[0] - sp1[0], ep1[1] - sp1[1])
            meta["angle"] = math.atan2(ep1[1] - sp1[1], ep1[0] - sp1[0])
            meta["footprint"] = None
            self._rebuild_wall_representation(guid)
            self.mark_mesh_dirty(guid)

            # Target wall endpoint
            if target_end_index is not None:
                t_idx = int(target_end_index)
            else:
                d_start = math.hypot(target["start"][0] - hit[0], target["start"][1] - hit[1])
                d_end = math.hypot(target["end"][0] - hit[0], target["end"][1] - hit[1])
                t_idx = 0 if d_start <= d_end else 1

            key2 = "start" if t_idx == 0 else "end"
            old2 = list(target[key2])
            target[key2] = [float(hit[0]), float(hit[1]), old2[2]]
            sp2, ep2 = target["start"], target["end"]
            target["length"] = math.hypot(ep2[0] - sp2[0], ep2[1] - sp2[1])
            target["angle"] = math.atan2(ep2[1] - sp2[1], ep2[0] - sp2[0])
            target["footprint"] = None
            self._rebuild_wall_representation(target_guid)
            self.mark_mesh_dirty(target_guid)

            self.recompute_wall_joins(only=[guid, target_guid])
            return {
                "status": "corner_trimmed",
                "guid": guid,
                "end_index": int(end_index),
                "target_guid": target_guid,
                "target_end_index": t_idx,
                "new_point": [float(hit[0]), float(hit[1])],
                "length": meta["length"],
                "target_length": target["length"],
            }
        else:
            # Single trim / extend: clamp hit to target wall body [target["start"], target["end"]]
            A = target["start"]
            B = target["end"]
            ab_x = B[0] - A[0]
            ab_y = B[1] - A[1]
            ab_len_sq = ab_x * ab_x + ab_y * ab_y
            if ab_len_sq > 1e-12:
                t = ((hit[0] - A[0]) * ab_x + (hit[1] - A[1]) * ab_y) / ab_len_sq
                t_clamped = max(0.0, min(1.0, t))
                clamped_hit = (A[0] + t_clamped * ab_x, A[1] + t_clamped * ab_y)
            else:
                clamped_hit = (A[0], A[1])

            key = "start" if int(end_index) == 0 else "end"
            old = list(meta[key])
            meta[key] = [float(clamped_hit[0]), float(clamped_hit[1]), old[2]]
            sp, ep = meta["start"], meta["end"]
            meta["length"] = math.hypot(ep[0] - sp[0], ep[1] - sp[1])
            meta["angle"] = math.atan2(ep[1] - sp[1], ep[0] - sp[0])
            meta["footprint"] = None
            self._rebuild_wall_representation(guid)
            self.mark_mesh_dirty(guid)
            self.recompute_wall_joins(only=[guid, target_guid])
            return {
                "status": "trimmed",
                "guid": guid,
                "end_index": int(end_index),
                "new_point": [float(clamped_hit[0]), float(clamped_hit[1])],
                "length": meta["length"],
            }

    def split_wall(self, guid: str, at_offset: float, gap: float = 0.0) -> Dict[str, Any]:
        """
        Splits a wall at `at_offset` along its baseline into two walls, optionally with a `gap`.
        - Re-hosts openings beyond the cut onto the new wall with updated offset and IFC rel.
        - Strictly refuses if an opening straddles the cut point or gap.
        - Carries join policy to the second segment.
        - Uses scoped join recomputation.
        """
        if guid not in self.element_meta:
            raise KeyError(f"Wall {guid} not found")
        meta = self.element_meta[guid]
        if meta.get("ifc_class") not in ("IfcWallStandardCase", "IfcWall"):
            raise ValueError("Split is currently supported for walls")
        length = float(meta.get("length", 0.0))
        offset = float(at_offset)
        gap = float(gap)
        if gap < 0.0:
            raise ValueError(f"Split gap {gap} cannot be negative")

        half_gap = gap / 2.0
        cut_start = offset - half_gap
        cut_end = offset + half_gap

        if gap > 0.0:
            if cut_start <= 0.0 or cut_end >= length:
                raise ValueError(
                    f"Split-with-gap {gap} at offset {offset} must fit within wall (0..{length:.3f})"
                )
        else:
            if not (0.0 < offset < length):
                raise ValueError(f"Split offset {offset} must be inside the wall (0..{length:.3f})")

        # Check hosted openings for straddle refusal
        hosted_openings = list(meta.get("hosted_openings") or [])
        for op_guid in hosted_openings:
            op_meta = self.element_meta.get(op_guid)
            if not op_meta:
                continue
            op_offset = float(op_meta.get("offset_along_wall", 0.0))
            op_width = float(op_meta.get("width", 0.0))
            op_start = op_offset
            op_end = op_offset + op_width
            # Straddle condition: cut intersects opening interior
            if (op_start < cut_end and cut_start < op_end) or (op_start < offset < op_end):
                raise ValueError(
                    f"Cannot split wall across hosted opening '{op_meta.get('name', op_guid)}' "
                    f"at offset {op_start:.2f}..{op_end:.2f} (cut at {offset:.2f})"
                )

        sp, ep = meta["start"], meta["end"]
        ang = float(meta.get("angle", 0.0))
        ux, uy = math.cos(ang), math.sin(ang)

        p1_end = [sp[0] + ux * cut_start, sp[1] + uy * cut_start, sp[2]]
        p2_start = [sp[0] + ux * cut_end, sp[1] + uy * cut_end, sp[2]]
        p2_end = [ep[0], ep[1], ep[2]]

        # New wall for the second half
        second = self.add_wall(
            (p2_start[0], p2_start[1], p2_start[2]),
            (p2_end[0], p2_end[1], p2_end[2]),
            height=meta.get("height", FEET_10),
            thickness=meta.get("thickness", INCHES_8),
            level_id=meta.get("level_id"),
            name=f"{meta.get('name')} (2)",
        )
        second_guid = second["guid"]
        second_meta = self.element_meta[second_guid]

        # Transfer join policy if present
        if guid in self.join_policies:
            self.join_policies[second_guid] = copy.deepcopy(self.join_policies[guid])

        # Shorten the original in place, keeping its identity
        meta["end"] = p1_end
        meta["length"] = cut_start
        meta["footprint"] = None
        self._rebuild_wall_representation(guid)

        # Re-host openings whose offset is beyond cut_end
        openings_to_rehost = []
        for op_guid in list(meta.get("hosted_openings") or []):
            op_meta = self.element_meta.get(op_guid)
            if not op_meta:
                continue
            op_offset = float(op_meta.get("offset_along_wall", 0.0))
            if op_offset >= cut_end:
                openings_to_rehost.append(op_guid)

        for op_guid in openings_to_rehost:
            op_meta = self.element_meta[op_guid]
            old_offset = float(op_meta.get("offset_along_wall", 0.0))
            new_offset = old_offset - cut_end
            op_meta["host_wall_guid"] = second_guid
            op_meta["offset_along_wall"] = new_offset
            if "hosted_openings" not in second_meta:
                second_meta["hosted_openings"] = []
            second_meta["hosted_openings"].append(op_guid)
            if "hosted_openings" in meta and op_guid in meta["hosted_openings"]:
                meta["hosted_openings"].remove(op_guid)

            # Relink IfcRelVoidsElement in IFC model
            opening_ent = op_meta.get("opening_entity")
            if opening_ent is not None:
                try:
                    for rel in self.model.by_type("IfcRelVoidsElement"):
                        if rel.RelatedOpeningElement == opening_ent:
                            rel.RelatingBuildingElement = second_meta["entity"]
                            break
                except Exception:
                    pass

            self.mark_mesh_dirty(op_guid)

        self._invalidate_geometry_cache(guid)
        self._invalidate_geometry_cache(second_guid)
        self.mark_mesh_dirty(guid, second_guid)
        self.recompute_wall_joins(only=[guid, second_guid])

        return {
            "status": "split",
            "guid": guid,
            "new_guid": second_guid,
            "at_offset": offset,
            "gap": gap,
            "original_length": meta["length"],
            "new_length": second_meta["length"],
        }

    # =========================================================================
    # LEVEL-DRIVEN ELEMENTS (P3 / README M2 gate)
    # =========================================================================

    def move_level(self, level_id: str, new_elevation: float) -> Dict[str, Any]:
        """
        Moves a storey and brings its elements with it.

        Before P3 a level was inert: `add_level` wrote an IfcBuildingStorey and the
        README M2 gate's "move Level 2 -> constrained walls follow" was simply not
        implemented. Elements are now linked to their level in the dependency
        graph, so moving the datum moves everything hosted on it and re-solves the
        constraints that follow.

        Elevation is the z datum, so elements translate in z; the constraint solver
        then re-derives anything tied to them (a wall aligned to a moved wall, an
        EQ span that must redistribute).
        """
        if level_id not in self.levels:
            raise KeyError(f"Level {level_id} not found")
        level = self.levels[level_id]
        delta = float(new_elevation) - float(level["elevation"])
        if abs(delta) < 1e-12:
            return {"status": "unchanged", "level_id": level_id, "moved_elements": 0}

        storey = level.get("entity")
        if storey is not None:
            storey.Elevation = float(new_elevation)
        level["elevation"] = float(new_elevation)
        self.levels_rev += 1

        # Every element on this storey follows. Explicit membership from the graph
        # rather than "all elements": elements on other levels must not move.
        members = [
            g for g, m in self.element_meta.items()
            if m.get("level_id") == level_id
        ]
        moved = 0
        for guid in members:
            if self.translate_element(guid, 0.0, 0.0, delta, _propagate=False):
                moved += 1

        # Recompute geometry for the affected neighbourhood only.
        try:
            from dependency_graph import DependencyGraph

            graph = DependencyGraph.build(self)
            graph.recompute(members)
            self.last_join_stats = graph.last_stats
        except Exception as e:
            print(f"Notice: recompute after moving level failed: {e}")

        return {
            "status": "moved",
            "level_id": level_id,
            "name": level.get("name"),
            "elevation": float(new_elevation),
            "delta": delta,
            "moved_elements": moved,
        }

    def apply_georeferencing(self):
        """Applies buildingSMART IFC4 IfcProjectedCRS and IfcMapConversion.

        UI-P0-7: an unset CRS is a real state, not an empty string, and this method
        used to run unconditionally against a *seeded* EPSG:2285 / NAD83 Washington
        North coordinate operation (~1,275,432 E, 234,568 N) — so a brand-new model
        could carry a real survey position belonging to nobody. If the user has not
        chosen a CRS we write no georeferencing at all, and clear anything a
        previous value left behind rather than leaving a stale conversion in the file.
        """
        self.project_rev += 1
        crs = (self.georeference_data.get("projected_crs") or "").strip()
        if not crs:
            for entity in list(self.model.by_type("IfcMapConversion")) + list(self.model.by_type("IfcProjectedCRS")):
                try:
                    self.model.remove(entity)
                except Exception as e:
                    print(f"Notice clearing georeference: {e}")
            return
        try:
            angle_rad = math.radians(self.georeference_data["true_north"])
            cos_a = math.cos(angle_rad)
            sin_a = math.sin(angle_rad)

            ifcopenshell.api.run("georeference.add_georeferencing", self.model, name=crs)
            ifcopenshell.api.run(
                "georeference.edit_georeferencing",
                self.model,
                projected_crs={"Name": crs},
                coordinate_operation={
                    "Eastings": float(self.georeference_data["eastings"]),
                    "Northings": float(self.georeference_data["northings"]),
                    "XAxisAbscissa": cos_a,
                    "XAxisOrdinate": sin_a,
                    "Scale": float(self.georeference_data["scale"]),
                },
            )
        except Exception as e:
            print(f"Notice applying georeference: {e}")

    def get_storey_by_id(self, storey_id: Optional[str]):
        if not storey_id:
            for lvl in self.levels.values():
                if lvl["elevation"] == 0.0 or "Level 1" in lvl["name"]:
                    return lvl["entity"]
            return list(self.levels.values())[0]["entity"] if self.levels else None
        if storey_id in self.levels:
            return self.levels[storey_id]["entity"]
        s_norm = storey_id.lower().replace(" ", "").replace("_", "").replace("-", "")
        for lid, lvl in self.levels.items():
            l_norm = lvl["name"].lower().replace(" ", "").replace("_", "").replace("-", "")
            if s_norm in (l_norm, lid.lower()):
                return lvl["entity"]
        # Default to Level 1
        for lvl in self.levels.values():
            if lvl["elevation"] == 0.0 or "Level 1" in lvl["name"]:
                return lvl["entity"]
        return list(self.levels.values())[0]["entity"] if self.levels else None

    # =========================================================================
    # GUID PRESERVATION (P2 overlay-as-truth)
    # =========================================================================
    # Rebuilding a model from the overlay must not renumber its elements: every
    # GUID the overlay, constraints, join policies and hosted-element links refer
    # to has to survive the rebuild. The builders below therefore accept an
    # explicit `guid`, and this helper applies it. `by_guid` is a live lookup
    # into the IFC file's own map, so assigning the attribute is sufficient —
    # no reference bookkeeping is needed (verified against ifcopenshell 0.9).

    @staticmethod
    def _apply_guid(entity, guid: Optional[str]) -> str:
        """Forces an entity's GlobalId (used when replaying the overlay)."""
        if guid:
            entity.GlobalId = guid
        return entity.GlobalId

    @staticmethod
    def _jsonable(value: Any) -> Any:
        """Converts numpy arrays/scalars to plain JSON types, stripping entity references."""
        if isinstance(value, np.ndarray):
            return value.tolist()
        if isinstance(value, (np.floating, np.integer)):
            return value.item()
        if isinstance(value, (list, tuple)):
            return [BimModelManager._jsonable(v) for v in value]
        if isinstance(value, dict):
            return {
                k: BimModelManager._jsonable(v)
                for k, v in value.items()
                if k != "entity" and not k.endswith("_entity") and not hasattr(v, "is_a") and "entity_instance" not in str(type(v))
            }
        if hasattr(value, "is_a") or "entity_instance" in str(type(value)):
            return None
        return value

    def _build_overlay_element(self, guid: str, meta: Dict[str, Any]) -> Dict[str, Any]:
        """
        Full parametric record for one element (overlay schema v3).

        Deliberately excludes: live entity refs, cached tessellation (`cached_verts`
        / `cached_faces` / `bbox`), and anything derivable — those are regenerated.
        Both builder-produced and import-produced cache entries are decimal feet since
        the import unit fix, so a regenerated mesh agrees with the parametric record.
        Includes the footprint because join trimming is real geometry the overlay
        must not silently re-derive.
        """
        record: Dict[str, Any] = {
            "ifc_class": meta.get("ifc_class"),
            "name": meta.get("name"),
            "type_properties": self._jsonable(meta.get("type_properties", {})),
        }
        for key in self.ELEMENT_PARAM_FIELDS:
            if key in ("ifc_class", "name", "type_properties"):
                continue
            if meta.get(key) is not None:
                record[key] = self._jsonable(meta[key])
        if meta.get("footprint"):
            record["footprint"] = self._jsonable(meta["footprint"])
        if meta.get("sketch"):
            # P4: the sketch is first-class overlay data, so a roof/floor/profile
            # drawn in either skin survives save/load. Before this the sketch lived
            # only in the browser and was lost on reload (finding N13).
            record["sketch"] = self._jsonable(meta["sketch"])
        if meta.get("hosted_openings"):
            record["hosted_openings"] = list(meta["hosted_openings"])
        if meta.get("refs"):
            record["refs"] = self._jsonable(meta["refs"])
        elif meta.get("ifc_class") in ("IfcWall", "IfcWallStandardCase") and meta.get("start") and meta.get("end"):
            record["refs"] = [
                {
                    "kind": "wall_start",
                    "sources": [{"element_guid": guid, "ordinal": 0}],
                    "hint": {"point": list(meta["start"]), "normal": None},
                },
                {
                    "kind": "wall_end",
                    "sources": [{"element_guid": guid, "ordinal": 0}],
                    "hint": {"point": list(meta["end"]), "normal": None},
                },
            ]
        record["join_policy"] = self._jsonable(self.join_policies.get(guid, {}))
        return record

    # =========================================================================
    # ARCHITECTURAL MODELING: WALLS, DOORS, WINDOWS, SLABS, ROOFS, GRIDS
    # =========================================================================

    @staticmethod
    def _hosted_placement_matrix(
        host_meta: Dict[str, Any],
        offset_along_wall: float,
        local_y: float = 0.0,
        local_z: float = 0.0,
    ) -> np.ndarray:
        """
        Rigid placement for an element hosted on a wall, in world coordinates.

        The host wall is placed at its baseline start, rotated by its baseline
        angle. A hosted door/window/opening must follow the same convention or it
        will not sit on the wall: the translation is `start + u * offset` and the
        local X axis is rotated to the wall direction. Previously these elements
        were placed with a bare `[offset, 0, 0]` translation and no rotation, so
        a door on an angled wall floated off it in world space (only the metadata
        offset was correct).

        `local_y` is the element's own cross-wall offset from the baseline
        (an opening is nudged to sit on the wall face), `local_z` its sill.
        """
        ang = float(host_meta.get("angle", 0.0))
        ux, uy = math.cos(ang), math.sin(ang)
        sp = host_meta.get("start", [0.0, 0.0, 0.0])
        base_z = float(sp[2]) if len(sp) > 2 else 0.0

        matrix = np.identity(4)
        matrix[0, 0], matrix[0, 1] = ux, -uy
        matrix[1, 0], matrix[1, 1] = uy, ux
        # world position = baseline start + offset along u + local_y along the normal.
        # The result is in DECIMAL FEET, like every other matrix this module builds;
        # callers convert at the IFC boundary (see `_placement_for_ifc`).
        matrix[0, 3] = float(sp[0]) + ux * offset_along_wall - uy * local_y
        matrix[1, 3] = float(sp[1]) + uy * offset_along_wall + ux * local_y
        matrix[2, 3] = base_z + local_z
        return matrix

    @staticmethod
    def _placement_for_ifc(matrix):
        """
        Converts a placement matrix from internal decimal feet to the IFC's metres.

        The rotation is dimensionless and passes through unchanged; only the
        translation is unit-bearing. Every `edit_object_placement` call must go
        through this, because the file is a metric IFC while the model is in feet —
        feeding feet straight in put every element away from the origin out by 3.28x.
        """
        converted = np.array(matrix, dtype=float)
        converted[0, 3] = feet_to_metres(float(matrix[0, 3]))
        converted[1, 3] = feet_to_metres(float(matrix[1, 3]))
        converted[2, 3] = feet_to_metres(float(matrix[2, 3]))
        return converted

    #: Vertical placement of a hosted child's own product, in feet of local Z, when
    #: the record does not carry an explicit `sill_height`. Doors are made at floor
    #: level and windows carry their sill explicitly, so 0.0 is the correct default
    #: for both -- and it must match what `add_door` actually used at creation, or a
    #: reseat would silently move every door.
    _HOSTED_LOCAL_Z_DEFAULT = 0.0

    def _reseat_hosted_openings(self, host_guid: str) -> int:
        """
        Re-asserts every door/window hosted on a wall from its wall-relative offset.

        Why this exists
        ---------------
        A hosted child is a placed product whose position is defined relative to its
        host, so it follows the host *provided the host's own placement is current*.
        Nothing refreshed the host's placement on every edit path, and the child's
        local offsets were written as world coordinates at creation, so in practice
        the two frames disagreed and the opening stayed where it was made.

        Measured before the fix: a wall moved +30 ft reported the wall solid at
        9.144..15.240 m while its opening was still at 1.524..2.438 m -- the hole did
        not move with the wall, because `IfcRelVoidsElement` kept cutting the wall with
        a void that now floated in mid-air.

        Idempotent: placement is recomputed from `offset_along_wall` alone, never
        composed onto the previous position, so re-running it -- or running it on an
        unmoved wall -- changes nothing.

        Returns the number of children reseated, so tests and callers can assert on it.
        """
        host_meta = self.element_meta.get(host_guid)
        if not host_meta:
            return 0
        reseated = 0
        for child_guid in list(host_meta.get("hosted_openings") or []):
            child = self.element_meta.get(child_guid)
            if not child:
                continue
            offset = float(child.get("offset_along_wall", 0.0))
            local_z = float(child.get("sill_height", self._HOSTED_LOCAL_Z_DEFAULT))
            # Desired WORLD transform for each part, from the wall's current baseline.
            # The opening box is nudged out of the wall face so the boolean cut is
            # clean; the door/panel sits on the baseline. These two must match what
            # creation used or the void drifts relative to its own door.
            jobs = (
                (child.get("opening_entity"), -INCHES_0_625, local_z),
                (child.get("entity"), 0.0, local_z),
            )
            wrote = False
            for entity, local_y, lz in jobs:
                if entity is None:
                    continue
                desired = self._hosted_placement_matrix(
                    host_meta, offset, local_y=local_y, local_z=lz
                )
                # The frame is read from the entity itself, never assumed: an opening
                # is parented to its wall, but a door's placement is top-level even
                # though it fills that opening (measured). Using the wrong frame puts
                # the part out by exactly the parent's offset.
                parent = self._placement_parent_entity(entity)
                if self._write_relative_placement(entity, parent, desired):
                    wrote = True
            if wrote:
                reseated += 1
                # The child moved, so its own tessellation is stale. This is not a user
                # edit, so it must not start a constraint solve (`_propagate=False`
                # semantics); `mark_mesh_dirty` only flags geometry.
                self.mark_mesh_dirty(child_guid)
        return reseated

    @staticmethod
    def _placement_parent_entity(product):
        """
        The element that `product`'s ObjectPlacement is expressed relative to, or None
        when the placement is top-level (i.e. the frame is the world).

        This is read from `PlacementRelTo.PlacesObject`, NOT assumed. The assumption is
        what makes this area treacherous: a door IS a filling of its opening, so
        `edit_object_placement` parents it to the opening's placement, but only while
        that call happens -- and `add_door` writes the door's placement with that call,
        then `feature.add_filling` runs. Measured, a door's `PlacementRelTo` is None and
        its placement is top-level, while its opening's IS the wall. So the door's
        offset must be expressed in WORLD terms while the opening's is expressed in the
        WALL's frame, and treating them the same is wrong in one direction or the other.

        Reading the link also survives ifcopenshell re-parenting a product later.
        """
        placement = getattr(product, "ObjectPlacement", None)
        if placement is None:
            return None
        rel_to = getattr(placement, "PlacementRelTo", None)
        if rel_to is None:
            return None
        owners = getattr(rel_to, "PlacesObject", None)
        if owners is None:
            return None
        if isinstance(owners, (tuple, list)):
            owners = owners[0] if owners else None
        return owners

    @staticmethod
    def _write_relative_placement(product, parent_entity, matrix_feet) -> bool:
        """
        Sets a product's local placement so its WORLD transform equals `matrix_feet`,
        given that its `IfcLocalPlacement` hangs off `parent_entity`'s.

        Why not `ifcopenshell.api.geometry.edit_object_placement`
        --------------------------------------------------------
        That usecase is unusable for a hosted child. It rewrites the product's OWN
        children as a side effect: at the default `should_transform_children=False` it
        rewrites them to hold their *world* position (documented), and at `True` it
        treats their current local values as world positions and adds the parent's
        motion. Both were measured on a +30 ft wall move -- the opening ended at local
        x = -7.62, exactly `1.524 - 9.144`, the correct local value (5 ft) minus the
        wall's displacement (30 ft). It also replaces the placement entity, so children
        get re-parented to the new one.

        This helper does only the `get_relative_placement` arithmetic, then writes the
        existing placement entity in place. Children are never consulted, so nothing is
        compensated or double-applied, and `ReferencedByPlacements` is preserved.

        `matrix_feet` is the desired WORLD transform in decimal feet. The stored value
        is relative to the parent, which is what `PlacementRelTo` means:

            local = inverse(parent_world) @ desired_world

        BOTH SIDES MUST BE IN THE SAME UNIT before that product. The parent's matrix
        comes back from ifcopenshell in METRES (the IFC's unit) while `matrix_feet` is
        in feet, so the feet translation is converted to metres FIRST. Composing
        `inverse(metres) @ feet` is a silently plausible-looking bug: on a door slide it
        produced `4.5 - 1.3716 = 3.1284` ft of local offset where the answer was
        `1.3716 - 1.3716 = 0`, i.e. a 0.95 m error in the door's position.

        The frame matters too, and getting it wrong is not cosmetic. A door is parented
        to its OPENING, and that opening already carries the wall's rotation, so on a
        90-degree wall the door's correct local offset is `(0, 1.524)` -- not
        `(1.524, 0)`. Writing the wall-frame value straight through bends the model;
        measured as test_hosted_openings.py "90 deg door slide" off by 1.293 ft.
        """
        placement = getattr(product, "ObjectPlacement", None)
        if placement is None or not placement.is_a("IfcLocalPlacement"):
            return False
        axis = getattr(placement, "RelativePlacement", None)
        if axis is None or not hasattr(axis, "Location") or axis.Location is None:
            return False

        # Bring the desired transform into the IFC's unit (metres). Only the translation
        # is unit-bearing; the rotation is dimensionless, exactly as `_placement_for_ifc`
        # assumes.
        desired = np.array(matrix_feet, dtype=float)
        desired[0, 3] = feet_to_metres(float(desired[0, 3]))
        desired[1, 3] = feet_to_metres(float(desired[1, 3]))
        desired[2, 3] = feet_to_metres(float(desired[2, 3]))

        parent_world = np.identity(4)
        if parent_entity is not None:
            parent_placement = getattr(parent_entity, "ObjectPlacement", None)
            if parent_placement is not None:
                parent_world = np.array(
                    plc.get_local_placement(parent_placement), dtype=float
                )
        # Both operands are now metres; the result is metres and is stored as-is.
        local = np.linalg.inv(parent_world) @ desired

        # Translation only: this module authors no rotation for a hosted child, so the
        # existing axis directions are already right and are left alone. A caller needing
        # a ROTATED child would have to rewrite RefDirection/Axis here too -- flagging it
        # because silently omitting that is this helper's obvious future failure mode.
        axis.Location.Coordinates = (
            float(local[0, 3]),
            float(local[1, 3]),
            float(local[2, 3]),
        )
        return True

    def add_wall(
        self,
        start_pt: Tuple[float, float, float],
        end_pt: Tuple[float, float, float],
        height: float = FEET_10,
        thickness: float = INCHES_8,
        level_id: Optional[str] = None,
        name: str = "Basic Wall : Exterior - 8\" CMU",
        wall_id: Optional[str] = None,
        guid: Optional[str] = None,
        type_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Creates an IfcWallStandardCase defined by 2D baseline, height, and thickness.
        Places wall in spatial structure and computes representation.

        `guid` re-uses the caller's GUID (overlay replay); `wall_id` is the legacy
        alias kept for callers that predate it.
        """
        if not type_id:
            if name == "Basic Wall : Exterior - 8\" CMU":
                if thickness == INCHES_8:
                    type_id = "wall-type-cmu-8"
            else:
                for tid, trec in getattr(self, "type_registry", {}).items():
                    if trec["name"] == name:
                        type_id = tid
                        break

        type_rec = getattr(self, "type_registry", {}).get(type_id) if type_id else None
        if type_rec:
            if "thickness" in type_rec.get("parameters", {}) and (thickness == INCHES_8 or thickness is None):
                thickness = float(type_rec["parameters"]["thickness"])
            if name == "Basic Wall : Exterior - 8\" CMU":
                name = type_rec.get("name", name)

        dx = end_pt[0] - start_pt[0]
        dy = end_pt[1] - start_pt[1]
        length = math.hypot(dx, dy)
        if length < 0.01:
            raise ValueError("Wall length must be greater than zero.")

        angle = math.atan2(dy, dx)
        storey = self.get_storey_by_id(level_id)
        base_z = float(storey.Elevation) if hasattr(storey, "Elevation") and storey.Elevation else 0.0

        wall = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcWallStandardCase", name=name
        )
        guid = self._apply_guid(wall, guid or wall_id)

        if type_rec and type_rec.get("entity") is not None:
            try:
                ifcopenshell.api.run(
                    "type.assign_type", self.model, related_objects=[wall], relating_type=type_rec["entity"]
                )
            except Exception:
                pass

        ifcopenshell.api.run(
            "spatial.assign_container", self.model, relating_structure=storey, products=[wall]
        )

        # 3D Extrusion representation
        rep = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            self.model,
            context=self.context_body,
            # IFC geometry is metres: convert from the internal decimal feet here.
            length=feet_to_metres(float(length)),
            height=feet_to_metres(float(height)),
            thickness=feet_to_metres(float(thickness)),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=wall, representation=rep
        )

        # Placement matrix: Position at start_pt with rotation angle
        matrix = np.identity(4)
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        matrix[0, 0] = cos_a
        matrix[0, 1] = -sin_a
        matrix[1, 0] = sin_a
        matrix[1, 1] = cos_a
        # Placements go into a metric IFC (`is_si=False` means "file units", which
        # are metres here), while the baseline is stored in decimal feet. Converting
        # here is the units boundary; without it a wall at model x=10 ft landed at
        # x=10 m — a 3.28x error, and the cause of the mixed-unit meshes.
        matrix[0, 3] = float(start_pt[0])
        matrix[1, 3] = float(start_pt[1])
        matrix[2, 3] = float(start_pt[2]) if len(start_pt) > 2 else float(base_z)

        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=wall,
            matrix=self._placement_for_ifc(matrix), is_si=False
        )

        meta = {
            "guid": guid,
            "ifc_class": "IfcWallStandardCase",
            "name": name,
            "type_id": type_id,
            "start": list(start_pt),
            "end": list(end_pt),
            "length": length,
            "height": height,
            "thickness": thickness,
            "angle": angle,
            "level_id": storey.GlobalId,
            "hosted_openings": [],
            "refs": [
                {
                    "kind": "wall_start",
                    "sources": [{"element_guid": guid, "ordinal": 0}],
                    "hint": {"point": list(start_pt), "normal": None},
                },
                {
                    "kind": "wall_end",
                    "sources": [{"element_guid": guid, "ordinal": 0}],
                    "hint": {"point": list(end_pt), "normal": None},
                },
            ],
            "entity": wall,
            "type_properties": {
                "Type Name": name,
                "Thickness": format_feet_inches(thickness),
                "Fire Rating": "2 HR",
                "Thermal Resistance": "R-19",
                "Function": "Exterior",
            },
        }
        self.element_meta[guid] = meta
        self.join_policies[guid] = {
            "end0": {"allow_join": True, "mode": "butt"},
            "end1": {"allow_join": True, "mode": "butt"},
        }
        self.mark_mesh_dirty(guid)
        wall_candidates = {
            g: m for g, m in self.element_meta.items()
            if m.get("ifc_class") in ("IfcWall", "IfcWallStandardCase") and "start" in m and "end" in m
        }
        join_index = self._build_join_index(wall_candidates)
        for end_idx in (0, 1):
            partner_guid, _kind, _oe = self._find_join_partner(
                guid, end_idx, wall_candidates, join_index)
            if partner_guid:
                self.mark_mesh_dirty(partner_guid)
        if not self._suppress_join_recompute:
            self.recompute_wall_joins()
        return meta

    def add_door(
        self,
        host_wall_guid: str,
        offset_along_wall: float,
        width: float = DOOR_WIDTH_36,
        height: float = DOOR_HEIGHT_84,
        name: str = "Single Flush : 36\" x 84\"",
        swing_flipped: bool = False,
        guid: Optional[str] = None,
        type_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Creates an IfcDoor hosted inside host wall.
        Instantiates IfcOpeningElement, establishes IfcRelVoidsElement and IfcRelFillsElement.
        """
        if host_wall_guid not in self.element_meta:
            raise ValueError(f"Host wall {host_wall_guid} not found.")

        if not type_id:
            if name == 'Single-Flush : 36" x 84"':
                if width == DOOR_WIDTH_36 and height == DOOR_HEIGHT_84:
                    type_id = "door-type-single-flush-36"
            else:
                for tid, trec in getattr(self, "type_registry", {}).items():
                    if trec["name"] == name:
                        type_id = tid
                        break

        type_rec = getattr(self, "type_registry", {}).get(type_id) if type_id else None
        if type_rec:
            if "width" in type_rec.get("parameters", {}) and (width == DOOR_WIDTH_36 or width is None):
                width = float(type_rec["parameters"]["width"])
            if "height" in type_rec.get("parameters", {}) and (height == DOOR_HEIGHT_84 or height is None):
                height = float(type_rec["parameters"]["height"])
            if name == 'Single-Flush : 36" x 84"':
                name = type_rec.get("name", name)

        wall_meta = self.element_meta[host_wall_guid]
        wall = wall_meta["entity"]
        wall_thickness = wall_meta["thickness"]

        # 1. Create Opening Element
        opening = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcOpeningElement", name=f"Opening for {name}"
        )
        opening_guid = opening.GlobalId

        # Opening representation with slight extra thickness for clean boolean cut
        op_rep = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            self.model,
            context=self.context_body,
            length=feet_to_metres(float(width)),
            height=feet_to_metres(float(height)),
            thickness=feet_to_metres(float(wall_thickness + INCHES_4)),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=opening, representation=op_rep
        )

        # Placement follows the host wall's own baseline/angle (world coords).
        op_matrix = self._hosted_placement_matrix(wall_meta, offset_along_wall, local_y=-INCHES_0_625)
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=opening,
            matrix=self._placement_for_ifc(op_matrix), is_si=False
        )

        # Cut the wall
        ifcopenshell.api.run("feature.add_feature", self.model, feature=opening, element=wall)

        # 2. Create Door element
        door = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcDoor", name=name
        )
        door_guid = self._apply_guid(door, guid)

        if type_rec and type_rec.get("entity") is not None:
            try:
                ifcopenshell.api.run(
                    "type.assign_type", self.model, related_objects=[door], relating_type=type_rec["entity"]
                )
            except Exception:
                pass

        storey = self.get_storey_by_id(wall_meta["level_id"])
        ifcopenshell.api.run(
            "spatial.assign_container", self.model, relating_structure=storey, products=[door]
        )

        # Door 3D panel representation
        door_rep = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            self.model,
            context=self.context_body,
            length=feet_to_metres(float(width)),
            height=feet_to_metres(float(height)),
            thickness=feet_to_metres(DOOR_PANEL_THICKNESS),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=door, representation=door_rep
        )
        door_matrix = self._hosted_placement_matrix(wall_meta, offset_along_wall, local_y=0.0)
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=door,
            matrix=self._placement_for_ifc(door_matrix), is_si=False
        )

        # Link door as filling of opening
        ifcopenshell.api.run("feature.add_filling", self.model, opening=opening, element=door)

        door_meta = {
            "guid": door_guid,
            "opening_guid": opening_guid,
            "ifc_class": "IfcDoor",
            "name": name,
            "type_id": type_id,
            "host_wall_guid": host_wall_guid,
            "offset_along_wall": offset_along_wall,
            "width": width,
            "height": height,
            "swing_flipped": swing_flipped,
            "entity": door,
            "opening_entity": opening,
            "type_properties": {
                "Type Name": name,
                "Width": format_feet_inches(width),
                "Height": format_feet_inches(height),
                "Fire Rating": "90 MIN",
                "Operation": "Single Swing Left",
            },
        }
        self.element_meta[door_guid] = door_meta
        wall_meta["hosted_openings"].append(door_guid)
        # The host wall's tessellation is now stale: the IFC void subtracts the
        # opening from the wall solid, but the cached mesh was built before the void
        # existed. Without this the wall renders (and slices) as an unvoided box even
        # though the IFC has the opening, which is a "looks right but is wrong"
        # failure: the plan showed no door at all.
        self._invalidate_geometry_cache(host_wall_guid)
        self.mark_mesh_dirty(door_guid, host_wall_guid)
        return door_meta

    def add_window(
        self,
        host_wall_guid: str,
        offset_along_wall: float,
        width: float = WINDOW_WIDTH_48,
        height: float = WINDOW_HEIGHT_48,
        sill_height: float = WINDOW_SILL_36,
        name: str = "Fixed Window : 48\" x 48\"",
        guid: Optional[str] = None,
        type_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Creates an IfcWindow hosted in wall with automated IfcOpeningElement."""
        if host_wall_guid not in self.element_meta:
            raise ValueError(f"Host wall {host_wall_guid} not found.")

        if not type_id:
            if name == 'Fixed Window : 48" x 48"':
                if width == WINDOW_WIDTH_48 and height == WINDOW_HEIGHT_48 and sill_height == WINDOW_SILL_36:
                    type_id = "window-type-fixed-48x48"
            else:
                for tid, trec in getattr(self, "type_registry", {}).items():
                    if trec["name"] == name:
                        type_id = tid
                        break

        type_rec = getattr(self, "type_registry", {}).get(type_id) if type_id else None
        if type_rec:
            if "width" in type_rec.get("parameters", {}) and (width == WINDOW_WIDTH_48 or width is None):
                width = float(type_rec["parameters"]["width"])
            if "height" in type_rec.get("parameters", {}) and (height == WINDOW_HEIGHT_48 or height is None):
                height = float(type_rec["parameters"]["height"])
            if "sill_height" in type_rec.get("parameters", {}) and (sill_height == WINDOW_SILL_36 or sill_height is None):
                sill_height = float(type_rec["parameters"]["sill_height"])
            if name == 'Fixed Window : 48" x 48"':
                name = type_rec.get("name", name)

        wall_meta = self.element_meta[host_wall_guid]
        wall = wall_meta["entity"]
        wall_thickness = wall_meta["thickness"]

        # 1. Opening
        opening = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcOpeningElement", name=f"Opening for {name}"
        )
        opening_guid = opening.GlobalId

        op_rep = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            self.model,
            context=self.context_body,
            length=feet_to_metres(float(width)),
            height=feet_to_metres(float(height)),
            thickness=feet_to_metres(float(wall_thickness + INCHES_4)),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=opening, representation=op_rep
        )

        op_matrix = self._hosted_placement_matrix(
            wall_meta, offset_along_wall, local_y=-INCHES_0_625, local_z=sill_height
        )
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=opening,
            matrix=self._placement_for_ifc(op_matrix), is_si=False
        )

        ifcopenshell.api.run("feature.add_feature", self.model, feature=opening, element=wall)

        # 2. Window
        window = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcWindow", name=name
        )
        win_guid = self._apply_guid(window, guid)

        if type_rec and type_rec.get("entity") is not None:
            try:
                ifcopenshell.api.run(
                    "type.assign_type", self.model, related_objects=[window], relating_type=type_rec["entity"]
                )
            except Exception:
                pass

        storey = self.get_storey_by_id(wall_meta["level_id"])
        ifcopenshell.api.run(
            "spatial.assign_container", self.model, relating_structure=storey, products=[window]
        )

        win_rep = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            self.model,
            context=self.context_body,
            length=feet_to_metres(float(width)),
            height=feet_to_metres(float(height)),
            thickness=feet_to_metres(WINDOW_FRAME_THICKNESS),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=window, representation=win_rep
        )
        win_matrix = self._hosted_placement_matrix(
            wall_meta, offset_along_wall, local_y=0.0, local_z=sill_height
        )
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=window,
            matrix=self._placement_for_ifc(win_matrix), is_si=False
        )

        ifcopenshell.api.run("feature.add_filling", self.model, opening=opening, element=window)

        win_meta = {
            "guid": win_guid,
            "opening_guid": opening_guid,
            "ifc_class": "IfcWindow",
            "name": name,
            "type_id": type_id,
            "host_wall_guid": host_wall_guid,
            "offset_along_wall": offset_along_wall,
            "width": width,
            "height": height,
            "sill_height": sill_height,
            "entity": window,
            "opening_entity": opening,
            "type_properties": {
                "Type Name": name,
                "Width": format_feet_inches(width),
                "Height": format_feet_inches(height),
                "Sill Height": format_feet_inches(sill_height),
                "Glazing": "Double Glazed Low-E",
            },
        }
        self.element_meta[win_guid] = win_meta
        wall_meta["hosted_openings"].append(win_guid)
        self._invalidate_geometry_cache(host_wall_guid)
        self.mark_mesh_dirty(win_guid, host_wall_guid)
        return win_meta

    def add_slab(
        self,
        polygon_pts: List[Tuple[float, float]],
        thickness: float = INCHES_10,
        elevation: float = FEET_0,
        level_id: Optional[str] = None,
        name: str = "Floor : 10\" Concrete Slab",
        guid: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Creates an IfcSlab with boundary polygon."""
        storey = self.get_storey_by_id(level_id)
        slab = ifcopenshell.api.run("root.create_entity", self.model, ifc_class="IfcSlab", name=name)
        guid = self._apply_guid(slab, guid)

        ifcopenshell.api.run(
            "spatial.assign_container", self.model, relating_structure=storey, products=[slab]
        )

        # The representation must extrude the actual boundary polygon. This used
        # to build a box from the polygon's bounding rectangle, which meant a
        # concave or non-rectangular floor became a rectangle in the IFC — the
        # overlay could preserve the polygon all it liked and the model of record
        # would still be wrong (review N1's "slab/roof polygons degrade").
        xs = [p[0] for p in polygon_pts]
        ys = [p[1] for p in polygon_pts]
        min_x, min_y = min(xs), min(ys)
        # Profile in local coordinates relative to the placement below.
        local = [[float(p[0]) - min_x, float(p[1]) - min_y] for p in polygon_pts]
        profile = ifcopenshell.api.run(
            "profile.add_arbitrary_profile",
            self.model,
            # Points are passed through literally while `Depth` is unit-converted,
            # so both must be SI metres or the profile and its extrusion disagree.
            # IFC profile outlines are metres.
            profile=[[feet_to_metres(float(x)), feet_to_metres(float(y))] for x, y in local],
            name=f"Slab-Boundary-{guid}",
        )
        rep = ifcopenshell.api.run(
            "geometry.add_profile_representation",
            self.model,
            context=self.context_body,
            profile=profile,
            depth=feet_to_metres(float(thickness)),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=slab, representation=rep
        )

        matrix = np.identity(4)
        matrix[0, 3] = float(min_x)
        matrix[1, 3] = float(min_y)
        matrix[2, 3] = float(elevation) - float(thickness)  # top of slab at elevation
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=slab,
            matrix=self._placement_for_ifc(matrix), is_si=False
        )

        meta = {
            "guid": guid,
            "ifc_class": "IfcSlab",
            "name": name,
            "polygon": polygon_pts,
            "thickness": thickness,
            "elevation": elevation,
            "level_id": storey.GlobalId,
            "entity": slab,
            "type_properties": {
                "Type Name": name,
                "Thickness": format_feet_inches(thickness),
                "Material": "Cast-in-Place Concrete",
                "Structural": "True",
            },
        }
        self.element_meta[guid] = meta
        self.mark_mesh_dirty(guid)
        return meta

    def add_roof(
        self,
        polygon_pts: List[Tuple[float, float]],
        thickness: float = INCHES_12,
        elevation: float = FEET_10,
        pitch_degrees: float = 15.0,
        level_id: Optional[str] = None,
        name: str = "Roof : Pitched Metal Deck",
        guid: Optional[str] = None,
        sketch: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """
        Creates an IfcRoof.

        `sketch` (P4) is the authoritative parametric definition — footprint plus
        Defines-Slope lines. When supplied, the display geometry is generated from
        the sketch (so a gable actually has a ridge) and the sketch is persisted to
        the overlay; `polygon_pts`/`pitch_degrees` remain for the simple case and
        for callers that predate sketches.
        """
        storey = self.get_storey_by_id(level_id)
        roof = ifcopenshell.api.run("root.create_entity", self.model, ifc_class="IfcRoof", name=name)
        guid = self._apply_guid(roof, guid)

        ifcopenshell.api.run(
            "spatial.assign_container", self.model, relating_structure=storey, products=[roof]
        )

        # Same as the slab: extrude the real footprint, not its bounding box.
        xs = [p[0] for p in polygon_pts]
        ys = [p[1] for p in polygon_pts]
        min_x, min_y = min(xs), min(ys)
        local = [[float(p[0]) - min_x, float(p[1]) - min_y] for p in polygon_pts]
        profile = ifcopenshell.api.run(
            "profile.add_arbitrary_profile",
            self.model,
            profile=[[feet_to_metres(x), feet_to_metres(y)] for x, y in local],
            name=f"Roof-Boundary-{guid}",
        )
        rep = ifcopenshell.api.run(
            "geometry.add_profile_representation",
            self.model,
            context=self.context_body,
            profile=profile,
            depth=feet_to_metres(float(thickness)),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=roof, representation=rep
        )

        matrix = np.identity(4)
        matrix[0, 3] = float(min_x)
        matrix[1, 3] = float(min_y)
        matrix[2, 3] = float(elevation)
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=roof,
            matrix=self._placement_for_ifc(matrix), is_si=False
        )

        meta = {
            "guid": guid,
            "ifc_class": "IfcRoof",
            "name": name,
            "polygon": polygon_pts,
            # A roof always owns a sketch. If the caller did not supply one, seed an
            # empty sketch with just the eave loop, so the editor or a drag can take
            # over immediately instead of failing with "no sketch".
            "sketch": (
                sketch.to_dict() if sketch is not None and hasattr(sketch, "to_dict")
                else self._seed_roof_sketch(polygon_pts).to_dict()
            ),
            "thickness": thickness,
            "elevation": elevation,
            "pitch": pitch_degrees,
            "level_id": storey.GlobalId,
            "entity": roof,
            "type_properties": {
                "Type Name": name,
                "Pitch": f"{pitch_degrees}°",
                "Thickness": format_feet_inches(thickness),
                "Finish": "Standing Seam Metal",
            },
        }
        self.element_meta[guid] = meta
        self.mark_mesh_dirty(guid)
        return meta

    def add_grid(
        self,
        axis_name: str,
        start_pt: Tuple[float, float],
        end_pt: Tuple[float, float],
        guid: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Creates an architectural grid line as a real IfcGrid + IfcGridAxis.

        P2: grids used to be a Python-dict only — `str(uuid.uuid4())` as the id and
        no ifcopenshell call at all — so they never reached `model.ifc` and were
        lost on every reload (review N2). Each BIMWorks grid line is authored as
        its own IfcGrid holding one axis, because that is how the application
        models them (one independent line per element, not a rectangular system).
        The axis curve is in world coordinates and the grid sits at the origin, so
        the importer's placement matrix reads back as identity.
        """
        import ifcopenshell.api.grid

        grid = ifcopenshell.api.run("root.create_entity", self.model, ifc_class="IfcGrid",
                                    name=f"Grid {axis_name}")
        grid_guid = self._apply_guid(grid, guid)

        # A grid is a spatial datum: hang it off the site (else the building)
        # rather than inside a storey.
        container = getattr(self, "site", None) or getattr(self, "building", None)
        if container is not None:
            try:
                ifcopenshell.api.run(
                    "spatial.assign_container", self.model,
                    relating_structure=container, products=[grid],
                )
            except Exception:
                pass

        origin = self.model.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0))
        axis_placement = self.model.create_entity("IfcAxis2Placement3D", Location=origin)
        grid.ObjectPlacement = self.model.create_entity(
            "IfcLocalPlacement", RelativePlacement=axis_placement
        )

        axis = ifcopenshell.api.run(
            "grid.create_grid_axis", self.model,
            grid=grid, axis_tag=str(axis_name), uvw_axes="UAxes",
        )
        ifcopenshell.api.run(
            "grid.create_axis_curve", self.model,
            grid_axis=axis,
            # IFC axis curves are metres.
            p1=[feet_to_metres(float(start_pt[0])), feet_to_metres(float(start_pt[1])), 0.0],
            p2=[feet_to_metres(float(end_pt[0])), feet_to_metres(float(end_pt[1])), 0.0],
        )

        meta = {
            "guid": grid_guid,
            "ifc_class": "IfcGrid",
            "name": f"Grid {axis_name}",
            "tag": axis_name,
            "start": list(start_pt),
            "end": list(end_pt),
            "entity": grid,
            "type_properties": {
                "Bubble": "Circle 1/4\"",
                "Lineweight": "0.25mm",
                "Line Pattern": "Centerline",
            },
        }
        self.element_meta[grid_guid] = meta
        self.grids_rev += 1
        return meta

    def delete_element(self, guid: str) -> bool:
        """
        Deletes an element.
        If it's a hosted Door or Window: removes opening feature and heals the wall solid!
        If it's a wall: deletes hosted openings as well.
        """
        if guid not in self.element_meta:
            return False

        if hasattr(self, "dimensions") and self.dimensions:
            dead_dims = [
                did for did, d in self.dimensions.items()
                if (
                    d.get("ref_a", {}).get("guid") == guid
                    or d.get("ref_b", {}).get("guid") == guid
                    or any(s.get("element_guid") == guid for s in (d.get("ref_a", {}).get("sources", []) + d.get("ref_b", {}).get("sources", [])))
                )
            ]
            for did in dead_dims:
                self.delete_dimension(did)

        if hasattr(self, "constraints") and self.constraints:
            dead_constraints = [
                cid for cid, c in self.constraints.items()
                if (
                    c.get("ref_guid") == guid
                    or c.get("target_guid") == guid
                    or c.get("guid_a") == guid
                    or c.get("guid_b") == guid
                    or c.get("span_start_guid") == guid
                    or c.get("span_end_guid") == guid
                    or guid in (c.get("interior_guids") or [])
                )
            ]
            for cid in dead_constraints:
                del self.constraints[cid]
            if dead_constraints:
                self.constraints_rev += 1

        meta = self.element_meta[guid]
        ifc_class = meta.get("ifc_class")
        if ifc_class == "IfcGrid":
            self.grids_rev += 1

        # Case 1: Hosted Door or Window
        if ifc_class in ("IfcDoor", "IfcWindow"):
            opening = meta.get("opening_entity")
            door_win = meta.get("entity")
            host_wall_guid = meta.get("host_wall_guid")

            if host_wall_guid in self.element_meta:
                host_wall_meta = self.element_meta[host_wall_guid]
                if guid in host_wall_meta["hosted_openings"]:
                    host_wall_meta["hosted_openings"].remove(guid)

            if opening:
                try:
                    ifcopenshell.api.run("root.remove_product", self.model, product=opening)
                except Exception as e:
                    print(f"Notice removing opening: {e}")

            if door_win:
                try:
                    ifcopenshell.api.run("root.remove_product", self.model, product=door_win)
                except Exception as e:
                    print(f"Notice removing filling: {e}")

            del self.element_meta[guid]
            self.mark_element_removed(guid)
            if host_wall_guid in self.element_meta:
                self._invalidate_geometry_cache(host_wall_guid)
                self.mark_mesh_dirty(host_wall_guid)
            return True

        # Case 2: Wall with hosted openings
        if ifc_class == "IfcWallStandardCase":
            for op_guid in list(meta.get("hosted_openings", [])):
                self.delete_element(op_guid)
            entity = meta.get("entity")
            if entity:
                try:
                    ifcopenshell.api.run("root.remove_product", self.model, product=entity)
                except Exception as e:
                    print(f"Notice removing wall: {e}")
            del self.element_meta[guid]
            self.mark_element_removed(guid)
            # Neighbours may need to un-trim / re-trim at the removed junction
            self.recompute_wall_joins()
            return True

        # Other elements
        entity = meta.get("entity")
        if entity:
            try:
                ifcopenshell.api.run("root.remove_product", self.model, product=entity)
            except Exception as e:
                print(f"Notice removing entity: {e}")
        del self.element_meta[guid]
        self.mark_element_removed(guid)
        return True

    def translate_element(
        self,
        guid: str,
        dx: float,
        dy: float,
        dz: float = 0.0,
        visited: Optional[set] = None,
        _propagate: bool = True,
    ) -> bool:
        """
        Translates an element.
        Enforces 1D/2D Parametric Dependency Constraints (Align Lock, Dimension Lock, and Equalize).
        """
        if guid not in self.element_meta:
            return False

        if visited is None:
            visited = set()
        if guid in visited:
            return True
        visited.add(guid)

        meta = self.element_meta[guid]
        ifc_class = meta.get("ifc_class")
        translated = False

        if ifc_class in ("IfcWall", "IfcWallStandardCase"):
            # Capture the pre-edit ends: the join radius needs them to find the partners
            # this move might pull away from (see `_recompute_after_joined_edit`).
            _old_pts = [
                (float(p[0]), float(p[1]))
                for p in (meta.get("start"), meta.get("end")) if p
            ]
            if "start" in meta and meta["start"]:
                meta["start"][0] += dx
                meta["start"][1] += dy
                if len(meta["start"]) > 2:
                    meta["start"][2] += dz
                elif dz != 0.0:
                    meta["start"].append(dz)
            if "end" in meta and meta["end"]:
                meta["end"][0] += dx
                meta["end"][1] += dy
                if len(meta["end"]) > 2:
                    meta["end"][2] += dz
                elif dz != 0.0:
                    meta["end"].append(dz)
            if "cached_verts" in meta and meta["cached_verts"]:
                # The cache is in the FILE's unit (metres); dx/dy/dz are decimal feet.
                _mpu = self._metres_per_unit()
                _dx, _dy, _dz = dx * _mpu, dy * _mpu, dz * _mpu
                cv = meta["cached_verts"]
                meta["cached_verts"] = [
                    cv[i] + _dx if i % 3 == 0 else (cv[i] + _dy if i % 3 == 1 else cv[i] + _dz)
                    for i in range(len(cv))
                ]
                meta["geom_rev"] = meta.get("geom_rev", 0) + 1
            if "bbox" in meta and "min" in meta["bbox"]:
                meta["bbox"]["min"][0] += dx
                meta["bbox"]["min"][1] += dy
                meta["bbox"]["min"][2] += dz
                meta["bbox"]["max"][0] += dx
                meta["bbox"]["max"][1] += dy
                meta["bbox"]["max"][2] += dz
            translated = True
            # Order matters, and it is the whole fix:
            #   1. refresh the WALL's own ObjectPlacement from its new baseline. The
            #      wall's body profile is authored in wall-local XY, so this placement
            #      is what positions it in the world.
            #   2. re-assert each hosted child in that same (now current) local frame.
            # Doing 2 before 1 was measured to put an opening at 19.8 m instead of
            # 10.67 m on a +30 ft wall move.
            self._refresh_wall_placement(guid)
            self._reseat_hosted_openings(guid)
            # Rebuild join-trimmed geometry and placement from the new baseline, scoped
            # to this wall and the walls it joined before or joins now.
            _new_pts = [
                (float(p[0]), float(p[1]))
                for p in (meta.get("start"), meta.get("end")) if p
            ]
            self._recompute_after_joined_edit(guid, old_points=_old_pts, new_points=_new_pts)

        elif ifc_class in ("IfcDoor", "IfcWindow"):
            # Slide along the host wall.
            #
            # The incoming (dx, dy) is a WORLD delta, but `offset_along_wall` is a
            # distance along the wall's own axis. Projecting the world delta onto
            # the wall direction is what makes the slide follow the wall: on a
            # wall running at 90° a world +X drag contributes nothing, and on a
            # 45° wall a +X drag contributes only its 1/√2 component. The previous
            # code added the raw world dx, so doors jumped off angled walls.
            host_meta = self.element_meta.get(meta.get("host_wall_guid"))
            if host_meta is None:
                return False
            host_angle = float(host_meta.get("angle", 0.0))
            ux, uy = math.cos(host_angle), math.sin(host_angle)
            meta["offset_along_wall"] += dx * ux + dy * uy
            # One placement implementation for the opening/product pair, shared with
            # the host-move path above. Duplicating the matrix maths here is how the
            # two paths drifted apart in the first place.
            self._reseat_hosted_openings(meta["host_wall_guid"])
            translated = True

        elif ifc_class == "IfcGrid":
            meta["start"][0] += dx
            meta["start"][1] += dy
            meta["end"][0] += dx
            meta["end"][1] += dy
            entity = meta.get("entity")
            if entity and hasattr(entity, "UAxes") and entity.UAxes:
                axis_curve = entity.UAxes[0].AxisCurve
                if axis_curve and hasattr(axis_curve, "Points") and len(axis_curve.Points) >= 2:
                    axis_curve.Points[0].Coordinates = (feet_to_metres(meta["start"][0]), feet_to_metres(meta["start"][1]))
                    axis_curve.Points[1].Coordinates = (feet_to_metres(meta["end"][0]), feet_to_metres(meta["end"][1]))
            translated = True

        elif ifc_class in ("IfcSlab", "IfcRoof"):
            meta["elevation"] = meta.get("elevation", 0.0) + dz
            if "polygon" in meta and meta["polygon"]:
                meta["polygon"] = [(p[0] + dx, p[1] + dy) for p in meta["polygon"]]
            if "cached_verts" in meta and meta["cached_verts"]:
                # The cache is in the FILE's unit (metres); dx/dy/dz are decimal feet.
                _mpu = self._metres_per_unit()
                _dx, _dy, _dz = dx * _mpu, dy * _mpu, dz * _mpu
                cv = meta["cached_verts"]
                meta["cached_verts"] = [
                    cv[i] + _dx if i % 3 == 0 else (cv[i] + _dy if i % 3 == 1 else cv[i] + _dz)
                    for i in range(len(cv))
                ]
                meta["geom_rev"] = meta.get("geom_rev", 0) + 1
            if "bbox" in meta and "min" in meta["bbox"]:
                meta["bbox"]["min"][0] += dx
                meta["bbox"]["min"][1] += dy
                meta["bbox"]["min"][2] += dz
                meta["bbox"]["max"][0] += dx
                meta["bbox"]["max"][1] += dy
                meta["bbox"]["max"][2] += dz
            translated = True

        # =====================================================================
        # CONSTRAINT PROPAGATION (P3: solved, not recursively delta-copied)
        # =====================================================================
        # The old implementation copied the delta to "locked" partners and had no
        # branch for `equalize` at all, so an EQ span held at creation and then
        # silently stopped holding (review N6). Constraints are now equations
        # solved by PlaneGCS, so EQ redistributes and conflicts are reported.
        #
        # `_propagate` is False when the solver is writing its own result back
        # through this method: that pass has already been solved, so it must not
        # start another solve. (Guarding on `visited` was wrong — `.add()` mutates
        # it, so it is truthy on the first call and the hook never ran.)
        if translated:
            self.mark_mesh_dirty(guid)
            if ifc_class in ("IfcWall", "IfcWallStandardCase"):
                # The wall's own mesh changed AND its hosted children moved with it
                # (`_reseat_hosted_openings`, which dirties each child itself).
                for child_guid in list(meta.get("hosted_openings") or []):
                    self.mark_mesh_dirty(child_guid)
            elif ifc_class in ("IfcDoor", "IfcWindow"):
                # The host wall's solid is unchanged by a slide, but its cached
                # tessellation and the plan slice derived from it are still keyed to
                # the opening's old position, so re-send it.
                self.mark_mesh_dirty(meta.get("host_wall_guid"))
        if translated and _propagate:
            try:
                self._solve_constraints_after_move(guid)
            except Exception as e:
                if type(e).__name__ == "SolverUnavailable":
                    raise
                print(f"Notice: constraint solve after moving {guid} failed: {e}")

        if translated:
            self._re_resolve_dimensions_after_move(guid)

        return translated

    def _solve_constraints_after_move(self, moved_guid: str) -> None:
        """
        Re-solves the constraint system around a completed move.

        Runs on both axes because a constraint may pin an element on the axis the
        user did not drag.
        """
        try:
            from constraint_solver import ConstraintSolver, SolverUnavailable

            solver = ConstraintSolver(self)
            scope = solver.affected_guids([moved_guid])
            if len(scope) <= 1:
                return
            axis_conflict = None
            for axis in ("x", "y"):
                pins = {
                    g: self.get_element_coord(g, axis)
                    for g in (moved_guid,)
                    if g in self.element_meta
                }
                result = solver.solve(axis=axis, pins=pins, scope=scope)
                if result.ok:
                    solver.apply_solve(result)
                elif result.status == "conflict" and axis_conflict is None:
                    resolutions = []
                    conflicting_cids = result.conflicting or []
                    conflicting_dids = []
                    for cid in conflicting_cids:
                        matched_did = None
                        for d_id, d_val in self.dimensions.items():
                            if d_val.get("constraint_id") == cid:
                                matched_did = d_id
                                break
                        if matched_did:
                            conflicting_dids.append(matched_did)
                            resolutions.append({
                                "kind": "unlock_dimension",
                                "dimension_id": matched_did,
                                "segment_index": 0,
                                "constraint_id": cid,
                            })
                        else:
                            resolutions.append({
                                "kind": "unlock_constraint",
                                "constraint_id": cid,
                            })
                    axis_conflict = {
                        "status": "conflict",
                        "axis": axis,
                        "constraints": conflicting_cids,
                        "dimensions": conflicting_dids,
                        "triggered_by": moved_guid,
                        "resolutions": resolutions,
                    }
            self.last_constraint_conflict = axis_conflict
        except SolverUnavailable:
            # Solver unavailable (e.g. planegcs not installed): surfaced error per Gate 0
            raise
        except Exception as e:
            # conflict or other: keep model intact
            return

        # EQ is a relation over the whole span, so it is re-asserted last: if the
        # user moved an interior element of an equalized span, the constraint wins
        # and the span is re-equalized. (Moving an interior element of an EQ span
        # is not a well-defined edit in parametric CAD — the constraint defines
        # where it sits — so snapping it back is the honest behaviour rather than
        # silently letting the constraint lapse, which is what the old code did.)
        for c in list(self.constraints.values()):
            if c.get("type") != "equalize" or not c.get("is_locked", True):
                continue
            span = {c.get("span_start_guid"), c.get("span_end_guid")}
            interiors = set(c.get("interior_guids") or [])
            if not ({moved_guid} | set(scope)) & (span | interiors):
                continue
            axis = c.get("axis", "x")
            try:
                if c.get("span_start_guid") == c.get("span_end_guid"):
                    self.equalize_span(
                        c.get("span_start_guid"), c.get("span_end_guid"),
                        list(c.get("interior_guids") or []), axis,
                    )
                else:
                    eq = solver.equalize(
                        c.get("span_start_guid"), c.get("span_end_guid"),
                        list(c.get("interior_guids") or []), axis,
                    )
                    if eq.ok:
                        solver.apply_solve(eq)
            except Exception as e:
                print(f"Notice: re-equalizing span {c.get('id')} failed: {e}")

    def _re_resolve_dimensions_after_move(self, moved_guid: str) -> None:
        """
        Re-resolves affected dimensions after translate_element.
        Surfaces outcomes: 'repaired', 'ambiguous', 'lost'.
        Updates dimension values so they do not report wrong numbers (Phase 2).
        """
        if not hasattr(self, "dimensions") or not self.dimensions:
            return

        for did, d in self.dimensions.items():
            ref_a = d.get("ref_a") or {}
            ref_b = d.get("ref_b") or {}
            srcs_a = [s.get("element_guid") for s in ref_a.get("sources", [])]
            srcs_b = [s.get("element_guid") for s in ref_b.get("sources", [])]
            is_affected = (
                moved_guid in srcs_a
                or moved_guid in srcs_b
                or ref_a.get("guid") == moved_guid
                or ref_b.get("guid") == moved_guid
            )
            if not is_affected:
                continue

            pa, out_a = resolve_reference(self, ref_a)
            pb, out_b = resolve_reference(self, ref_b)
            if (out_a in ("lost", "ambiguous") or pa is None) and ref_a.get("hint"):
                rep_a, rep_out_a = repair_reference(self, ref_a)
                if rep_out_a in ("exact", "repaired"):
                    ref_a.update(rep_a)
                    pa, out_a = resolve_reference(self, ref_a)
            if (out_b in ("lost", "ambiguous") or pb is None) and ref_b.get("hint"):
                rep_b, rep_out_b = repair_reference(self, ref_b)
                if rep_out_b in ("exact", "repaired"):
                    ref_b.update(rep_b)
                    pb, out_b = resolve_reference(self, ref_b)

            if out_a == "lost" or out_b == "lost" or pa is None or pb is None:
                d["status"] = "lost"
                self.dimensions_rev += 1
            elif out_a == "ambiguous" or out_b == "ambiguous":
                d["status"] = "ambiguous"
                self.dimensions_rev += 1
            else:
                axis = d.get("axis", "aligned")
                if axis == "x":
                    val = abs(pb[0] - pa[0])
                elif axis == "y":
                    val = abs(pb[1] - pa[1])
                else:
                    val = float(math.hypot(pb[0] - pa[0], pb[1] - pa[1]))
                if not d.get("is_locked"):
                    d["value"] = val
                d["status"] = "repaired" if (out_a == "repaired" or out_b == "repaired") else "exact"
                if "hint" in ref_a and isinstance(ref_a["hint"], dict):
                    ref_a["hint"]["point"] = [pa[0], pa[1], 0.0]
                if "hint" in ref_b and isinstance(ref_b["hint"], dict):
                    ref_b["hint"]["point"] = [pb[0], pb[1], 0.0]
                self.dimensions_rev += 1

    @staticmethod
    def _triangulate_polygon_2d(poly):
        """Triangulates a simple 2D polygon into vertex index triples for arbitrary concave/complex shapes."""
        n = len(poly)
        if n < 3:
            return []
        if n == 3:
            return [[0, 1, 2]]
        try:
            from shapely.geometry import Polygon
            from shapely.ops import triangulate
            shp_poly = Polygon(poly)
            if shp_poly.is_valid and shp_poly.area > 1e-4:
                tris = triangulate(shp_poly)
                tri_indices = []
                for tri in tris:
                    if shp_poly.contains(tri.representative_point()):
                        coords = list(tri.exterior.coords)[:3]
                        idx = []
                        for cx, cy in coords:
                            best_i = min(range(n), key=lambda i: (poly[i][0] - cx)**2 + (poly[i][1] - cy)**2)
                            idx.append(best_i)
                        if len(set(idx)) == 3:
                            tri_indices.append(idx)
                if tri_indices:
                    return tri_indices
        except Exception:
            pass
        return [[0, i, i + 1] for i in range(1, n - 1)]

    @staticmethod
    def _build_flat_slab_mesh(poly, elevation=FEET_0, thickness=INCHES_10):
        """Builds triangulated 3D mesh for flat slab."""
        n = len(poly)
        verts = []
        for x, y in poly:
            verts.extend([float(x), float(y), float(elevation - thickness)])
        for x, y in poly:
            verts.extend([float(x), float(y), float(elevation)])
        faces = []
        tri_indices = BimModelManager._triangulate_polygon_2d(poly)
        for a, b, c in tri_indices:
            faces.extend([a, c, b])
        for a, b, c in tri_indices:
            faces.extend([n + a, n + b, n + c])
        for i in range(n):
            nxt = (i + 1) % n
            faces.extend([i, n + i, n + nxt])
            faces.extend([i, n + nxt, nxt])
        return verts, faces

    @staticmethod
    def _build_pitched_roof_mesh(poly, elevation=FEET_10, thickness=INCHES_12, pitch_deg=15.0):
        """Builds triangulated 3D mesh for pitched roof."""
        n = len(poly)
        rad = math.radians(pitch_deg)
        ys = [p[1] for p in poly]
        min_y, max_y = min(ys), max(ys)
        mid_y = (min_y + max_y) / 2.0
        half_span = (max_y - min_y) / 2.0 if max_y > min_y else 1.0

        verts = []
        for x, y in poly:
            rise = (half_span - abs(y - mid_y)) * math.tan(rad)
            verts.extend([float(x), float(y), float(elevation + max(0.0, rise))])
        for x, y in poly:
            rise = (half_span - abs(y - mid_y)) * math.tan(rad)
            verts.extend([float(x), float(y), float(elevation + max(0.0, rise) + thickness)])

        faces = []
        tri_indices = BimModelManager._triangulate_polygon_2d(poly)
        for a, b, c in tri_indices:
            faces.extend([a, c, b])
        for a, b, c in tri_indices:
            faces.extend([n + a, n + b, n + c])
        for i in range(n):
            nxt = (i + 1) % n
            faces.extend([i, n + i, n + nxt])
            faces.extend([i, n + nxt, nxt])
        return verts, faces

    @staticmethod
    def _build_wall_mesh(sp, ep, height=FEET_10, thickness=INCHES_8):
        """Builds triangulated 3D mesh for wall solid."""
        dx = ep[0] - sp[0]
        dy = ep[1] - sp[1]
        L = math.hypot(dx, dy)
        if L < 0.001:
            return [], []
        ux, uy = dx / L, dy / L
        nx, ny = -uy * (thickness / 2.0), ux * (thickness / 2.0)
        z0 = sp[2] if len(sp) > 2 else 0.0
        z1 = z0 + height

        poly = [
            (sp[0] + nx, sp[1] + ny),
            (sp[0] - nx, sp[1] - ny),
            (ep[0] - nx, ep[1] - ny),
            (ep[0] + nx, ep[1] + ny),
        ]
        verts = []
        for x, y in poly:
            verts.extend([float(x), float(y), float(z0)])
        for x, y in poly:
            verts.extend([float(x), float(y), float(z1)])

        faces = [
            0, 2, 1, 0, 3, 2,
            4, 5, 6, 4, 6, 7,
            0, 4, 5, 0, 5, 1,
            2, 6, 7, 2, 7, 3,
            1, 5, 6, 1, 6, 2,
            3, 7, 4, 3, 4, 0,
        ]
        return verts, faces

    def update_element(self, guid: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        """
        Updates parameters and geometry of any IFC element (Roof, Wall, Floor, Door, Window).
        Rebuilds 3D representation and updates 2D linework in real-time.
        """
        if guid not in self.element_meta:
            raise KeyError(f"Element {guid} not found")

        meta = self.element_meta[guid]
        ifc_class = meta.get("ifc_class")
        # Pre-edit ends, captured before any branch mutates them. The join radius needs
        # them to find partners a reshape might pull away from.
        _old_ends = [
            (float(p[0]), float(p[1]))
            for p in (meta.get("start"), meta.get("end")) if p
        ]
        # Case 1: Roof or Slab
        if ifc_class in ("IfcRoof", "IfcSlab"):
            if "name" in updates and updates["name"]:
                meta["name"] = updates["name"]
            if "pitch" in updates or "pitch_degrees" in updates:
                val = updates.get("pitch") if updates.get("pitch") is not None else updates.get("pitch_degrees")
                meta["pitch"] = float(val)
            if "elevation" in updates and updates["elevation"] is not None:
                meta["elevation"] = float(updates["elevation"])
            if "thickness" in updates and updates["thickness"] is not None:
                meta["thickness"] = float(updates["thickness"])
            if "polygon" in updates and updates["polygon"]:
                meta["polygon"] = [tuple(p) for p in updates["polygon"]]

            is_roof = ifc_class == "IfcRoof" or "roof" in (meta.get("name") or "").lower()
            poly = meta.get("polygon")
            if is_roof and poly and len(poly) >= 3:
                elev = meta.get("elevation", 6.0)
                th = meta.get("thickness", 0.3)
                pitch = meta.get("pitch", 15.0)
                verts, faces = self._build_pitched_roof_mesh(poly, elev, th, pitch)
                self._cache_verts(guid, verts, faces, in_feet=True)
                xs = [p[0] for p in poly]
                ys = [p[1] for p in poly]
                zs = [verts[i] for i in range(2, len(verts), 3)]
                meta["bbox"] = {
                    "min": [min(xs), min(ys), min(zs)],
                    "max": [max(xs), max(ys), max(zs)],
                }
            elif poly and len(poly) >= 3:
                elev = meta.get("elevation", 0.0)
                th = meta.get("thickness", 0.25)
                verts, faces = self._build_flat_slab_mesh(poly, elev, th)
                self._cache_verts(guid, verts, faces, in_feet=True)
                xs = [p[0] for p in poly]
                ys = [p[1] for p in poly]
                meta["bbox"] = {
                    "min": [min(xs), min(ys), elev - th],
                    "max": [max(xs), max(ys), elev],
                }

        # Case 2: Wall
        elif ifc_class in ("IfcWall", "IfcWallStandardCase"):
            if "name" in updates and updates["name"]:
                meta["name"] = updates["name"]
            if "height" in updates and updates["height"] is not None:
                meta["height"] = float(updates["height"])
            if "thickness" in updates and updates["thickness"] is not None:
                meta["thickness"] = float(updates["thickness"])
            if "start" in updates and updates["start"]:
                meta["start"] = list(updates["start"])
            if "end" in updates and updates["end"]:
                meta["end"] = list(updates["end"])

            sp = meta["start"]
            ep = meta["end"]
            h = meta.get("height", FEET_10)
            th = meta.get("thickness", 0.2)
            meta["length"] = math.hypot(ep[0] - sp[0], ep[1] - sp[1])
            meta["angle"] = math.atan2(ep[1] - sp[1], ep[0] - sp[0])
            verts, faces = self._build_wall_mesh(sp, ep, h, th)
            self._cache_verts(guid, verts, faces, in_feet=True)
            meta["bbox"] = {
                "min": [min(sp[0], ep[0]) - th, min(sp[1], ep[1]) - th, sp[2] if len(sp) > 2 else 0.0],
                "max": [max(sp[0], ep[0]) + th, max(sp[1], ep[1]) + th, (sp[2] if len(sp) > 2 else 0.0) + h],
            }
            _new_ends = [
                (float(p[0]), float(p[1])) for p in (sp, ep) if p
            ]
            # A changed start/end moves the baseline, so refresh the wall's own
            # placement and then re-assert its hosted openings in that frame. Without
            # this, resizing a wall orphans its doors exactly as translating one did.
            self._refresh_wall_placement(guid)
            self._reseat_hosted_openings(guid)
            self._recompute_after_joined_edit(guid, old_points=_old_ends, new_points=_new_ends)

        # Case 3: Door / Window
        elif ifc_class in ("IfcDoor", "IfcWindow"):
            if "offset_along_wall" in updates and updates["offset_along_wall"] is not None:
                meta["offset_along_wall"] = float(updates["offset_along_wall"])
            if "width" in updates and updates["width"] is not None:
                meta["width"] = float(updates["width"])
            if "height" in updates and updates["height"] is not None:
                meta["height"] = float(updates["height"])
            if "swing_flipped" in updates and updates["swing_flipped"] is not None:
                meta["swing_flipped"] = bool(updates["swing_flipped"])
            # Any of these changes where the opening/product pair must sit.
            self._reseat_hosted_openings(meta.get("host_wall_guid"))

        self.mark_mesh_dirty(guid, clear_cache=False)
        return {
            "guid": guid,
            "ifc_class": meta.get("ifc_class"),
            "name": meta.get("name"),
            "elevation": meta.get("elevation", 0.0),
            "thickness": meta.get("thickness", 0.2),
            "height": meta.get("height", FEET_10),
            "pitch": meta.get("pitch", 15.0),
            "length": meta.get("length", 0.0),
            "start": meta.get("start"),
            "end": meta.get("end"),
            "polygon": meta.get("polygon"),
            "offset_along_wall": meta.get("offset_along_wall", 0.0),
            "width": meta.get("width", 0.9),
            "swing_flipped": meta.get("swing_flipped", False),
        }

    # =========================================================================
    # PARAMETRIC CONSTRAINT ENGINE: ALIGN, LOCK, EQUALIZE (EQ), PERSISTENCE
    # =========================================================================

    def get_element_coord(self, guid: str, axis: str = "x") -> float:
        """Computes current spatial coordinate of an element along an axis."""
        meta = self.element_meta.get(guid)
        if not meta:
            return 0.0
        idx = 0 if axis == "x" else (1 if axis == "y" else 2)

        if meta.get("ifc_class") == "IfcWallStandardCase":
            return (meta["start"][idx] + meta["end"][idx]) / 2.0
        elif meta.get("ifc_class") in ("IfcDoor", "IfcWindow"):
            host_meta = self.element_meta.get(meta.get("host_wall_guid"))
            if host_meta:
                ang = host_meta.get("angle", 0.0)
                off = meta.get("offset_along_wall", 0.0)
                if axis == "x":
                    return host_meta["start"][0] + math.cos(ang) * off
                else:
                    return host_meta["start"][1] + math.sin(ang) * off
            return meta.get("offset_along_wall", 0.0)
        elif meta.get("ifc_class") == "IfcGrid":
            return (meta["start"][idx] + meta["end"][idx]) / 2.0
        return 0.0

    def add_align_constraint(
        self, ref_guid: str, target_guid: str, axis: str = "x", lock: bool = True
    ) -> Dict[str, Any]:
        """
        Aligns target element to reference element along specified axis.
        Registers a 1D rigid constraint with interactive padlock toggle.
        """
        if ref_guid not in self.element_meta or target_guid not in self.element_meta:
            raise ValueError("Reference or target element not found.")

        ref_pos = self.get_element_coord(ref_guid, axis)
        target_pos = self.get_element_coord(target_guid, axis)
        delta = ref_pos - target_pos

        # Align target to reference
        if abs(delta) > 1e-4:
            dx = delta if axis == "x" else 0.0
            dy = delta if axis == "y" else 0.0
            dz = delta if axis == "z" else 0.0
            self.translate_element(target_guid, dx, dy, dz)

        cid = f"align_{uuid.uuid4().hex[:8]}"
        constraint = {
            "id": cid,
            "type": "align",
            "ref_guid": ref_guid,
            "target_guid": target_guid,
            "axis": axis,
            "offset": 0.0,
            "is_locked": lock,
        }
        self.constraints[cid] = constraint
        self.save_constraints_to_ifc()
        return constraint

    def toggle_constraint_lock(self, constraint_id: str, is_locked: bool) -> bool:
        """Toggles the padlock lock state on an alignment or dimension constraint."""
        if constraint_id not in self.constraints:
            return False
        self.constraints[constraint_id]["is_locked"] = is_locked
        self.save_constraints_to_ifc()
        return True

    def _recalculate_origin_distance(self, constraint: Dict[str, Any], new_locked_dist: float) -> float:
        origin_distance = float(new_locked_dist)
        ref_a = constraint.get("ref_a")
        ref_b = constraint.get("ref_b")
        guid_a = constraint.get("guid_a")
        guid_b = constraint.get("guid_b")
        axis = constraint.get("axis", "x")
        if ref_a and ref_b and guid_a and guid_b and guid_a != guid_b and guid_a in self.element_meta and guid_b in self.element_meta:
            ca, _ = resolve_reference_axis(self, ref_a, axis)
            cb, _ = resolve_reference_axis(self, ref_b, axis)
            oa = self.get_element_coord(guid_a, axis)
            ob = self.get_element_coord(guid_b, axis)
            if ca is not None and cb is not None:
                delta_a = ca - oa
                delta_b = cb - ob
                s = 1.0 if (cb - ca) >= 0 else -1.0
                origin_distance = abs(s * float(new_locked_dist) - (delta_b - delta_a))
        return float(origin_distance)

    def add_dimension_lock(
        self,
        guid_a: str,
        guid_b: str,
        locked_distance: Optional[float] = None,
        is_locked: bool = True,
        axis: str = "x",
        ref_a: Optional[Dict[str, Any]] = None,
        ref_b: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Locks the dimension delta between two elements."""
        if guid_a not in self.element_meta or guid_b not in self.element_meta:
            raise ValueError("Element A or B not found.")

        if guid_a == guid_b:
            cid = f"lenlock_{uuid.uuid4().hex[:8]}"
            if locked_distance is None:
                meta = self.element_meta[guid_a]
                sp, ep = meta.get("start", [0, 0]), meta.get("end", [0, 0])
                locked_distance = float(math.hypot(ep[0] - sp[0], ep[1] - sp[1]))
            constraint = {
                "id": cid,
                "type": "length_lock",
                "guid": guid_a,
                "guid_a": guid_a,
                "guid_b": guid_a,
                "locked_length": float(locked_distance),
                "locked_distance": float(locked_distance),
                "axis": axis,
                "is_locked": is_locked,
                "ref_a": ref_a,
                "ref_b": ref_b,
            }
            self.constraints[cid] = constraint
            self.save_constraints_to_ifc()
            return constraint

        if locked_distance is None:
            pos_a = self.get_element_coord(guid_a, axis)
            pos_b = self.get_element_coord(guid_b, axis)
            locked_distance = abs(pos_b - pos_a)

        origin_distance = float(locked_distance)
        if ref_a and ref_b:
            ca, _ = resolve_reference_axis(self, ref_a, axis)
            cb, _ = resolve_reference_axis(self, ref_b, axis)
            oa = self.get_element_coord(guid_a, axis)
            ob = self.get_element_coord(guid_b, axis)
            if ca is not None and cb is not None:
                delta_a = ca - oa
                delta_b = cb - ob
                s = 1.0 if (cb - ca) >= 0 else -1.0
                origin_distance = abs(s * float(locked_distance) - (delta_b - delta_a))

        cid = f"dimlock_{uuid.uuid4().hex[:8]}"
        constraint = {
            "id": cid,
            "type": "dimension_lock",
            "guid_a": guid_a,
            "guid_b": guid_b,
            "locked_distance": float(locked_distance),
            "origin_distance": float(origin_distance),
            "axis": axis,
            "is_locked": is_locked,
            "ref_a": ref_a,
            "ref_b": ref_b,
        }
        self.constraints[cid] = constraint
        self.save_constraints_to_ifc()
        return constraint

    def equalize_span(
        self,
        span_start_guid: str,
        span_end_guid: str,
        interior_guids: List[str],
        axis: str = "x",
    ) -> Dict[str, Any]:
        """
        Calculates equal spacing along the shared span and distributes interior elements proportionally (EQ).
        """
        if not interior_guids:
            raise ValueError("At least one interior element required to equalize.")

        is_same_host = (span_start_guid == span_end_guid)
        host_meta = self.element_meta.get(span_start_guid) if is_same_host else None

        if is_same_host and host_meta and host_meta.get("ifc_class") in ("IfcWall", "IfcWallStandardCase"):
            pos_start = 0.0
            total_span = float(host_meta.get("length", 0.0))
            pos_end = total_span
        else:
            pos_start = self.get_element_coord(span_start_guid, axis)
            pos_end = self.get_element_coord(span_end_guid, axis)
            total_span = pos_end - pos_start

        num_segments = len(interior_guids) + 1
        spacing = total_span / num_segments if num_segments > 0 else 0.0

        # Reposition each interior element to equalized position
        for i, int_guid in enumerate(interior_guids):
            meta = self.element_meta.get(int_guid)
            if not meta:
                continue
            target_pos = pos_start + (i + 1) * spacing

            if meta.get("ifc_class") in ("IfcDoor", "IfcWindow"):
                h_meta = self.element_meta.get(meta.get("host_wall_guid"))
                h_angle = float(h_meta.get("angle", 0.0)) if h_meta else 0.0
                ux, uy = math.cos(h_angle), math.sin(h_angle)
                current_off = meta.get("offset_along_wall", 0.0)
                desired_off = (i + 1) * spacing - (meta.get("width", 1.0) / 2.0)
                delta_off = desired_off - current_off
                self.translate_element(int_guid, delta_off * ux, delta_off * uy, 0.0)
            else:
                curr_pos = self.get_element_coord(int_guid, axis)
                d = target_pos - curr_pos
                dx = d if axis == "x" else 0.0
                dy = d if axis == "y" else 0.0
                self.translate_element(int_guid, dx, dy, 0.0)

        # Re-use an existing EQ span over the same endpoints/axis instead of
        # appending a duplicate. The old code created a new constraint on every
        # call, so two identical calls left two constraints and wiring propagation
        # into it would have accumulated one per drag.
        cid = None
        for existing_id, existing in self.constraints.items():
            if (
                existing.get("type") == "equalize"
                and existing.get("span_start_guid") == span_start_guid
                and existing.get("span_end_guid") == span_end_guid
                and existing.get("axis", "x") == axis
            ):
                cid = existing_id
                break
        if cid is None:
            cid = f"eq_{uuid.uuid4().hex[:8]}"
        constraint = {
            "id": cid,
            "type": "equalize",
            "span_start_guid": span_start_guid,
            "span_end_guid": span_end_guid,
            "interior_guids": list(interior_guids),
            "axis": axis,
            "spacing": spacing,
            "is_equalized": True,
            "is_locked": True,
        }
        self.constraints[cid] = constraint
        self.save_constraints_to_ifc()
        return constraint

    def delete_constraint(self, constraint_id: str) -> bool:
        if constraint_id in self.constraints:
            del self.constraints[constraint_id]
            self.save_constraints_to_ifc()
            return True
        return False

    # =========================================================================
    # PARAMETRIC OVERLAY DIMENSIONS & DIMENSION-DRIVEN EDITING (Phase 2)
    # =========================================================================

    def _resolve_ref_coords(self, ref: Dict[str, Any]) -> Tuple[Optional[Tuple[float, float]], str]:
        """
        Resolves 2D coordinates [x, y] in decimal feet for a dimension witness reference.
        Delegates to references.resolve_reference, returning (point, status).
        """
        if not isinstance(ref, dict):
            return (None, "lost")
        return resolve_reference(self, ref)

    def create_dimension(
        self,
        ref_a: Dict[str, Any],
        ref_b: Dict[str, Any],
        kind: str = "aligned",
        axis: str = "aligned",
        offset: float = 1.0,
        value: Optional[float] = None,
        is_locked: bool = False,
        eq_group: Optional[str] = None,
        dimension_id: Optional[str] = None,
        refs: Optional[List[Dict[str, Any]]] = None,
        binding: str = "literal",
        label: Optional[str] = None,
        eq_anchor: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Creates a persistent parametric dimension object in the overlay (A4).
        If `is_locked` is True, registers an active distance constraint lock.
        References are normalized to the canonical Reference schema (Phase 1).
        """
        # Phase 5.2 & §2 Rule 1 binding validation
        if binding == "parameter":
            if not label:
                raise ValueError("label must be set when binding == 'parameter'")
            if is_locked:
                raise ValueError("Dimension binding error: cannot be both locked and labeled")
        else:
            if label is not None:
                raise ValueError(f"label cannot be set when binding == '{binding}' (only when binding == 'parameter')")
        if is_locked and refs and len(refs) > 2 and binding != "equal":
            raise ValueError("Dimension binding error: cannot lock multi-segment dimension without equal binding")

        dim_id = dimension_id or f"dim_{uuid.uuid4().hex[:8]}"
        norm_ref_a = normalize_reference(ref_a)
        norm_ref_b = normalize_reference(ref_b)
        norm_refs = [normalize_reference(r) for r in refs] if refs else None

        # Derive initial value if not explicitly passed
        if value is None:
            if (
                norm_ref_a.get("guid") == norm_ref_b.get("guid")
                and norm_ref_a.get("guid") in self.element_meta
                and {norm_ref_a.get("kind"), norm_ref_b.get("kind")} == {"wall_start", "wall_end"}
                and axis.lower() == "aligned"
            ):
                meta = self.element_meta[norm_ref_a["guid"]]
                if "start" in meta and "end" in meta and meta["start"] and meta["end"]:
                    sp, ep = meta["start"], meta["end"]
                    value = float(math.hypot(ep[0] - sp[0], ep[1] - sp[1]))
            if value is None:
                if axis.lower() == "z" and not (norm_ref_a.get("kind") == "level_plane" or norm_ref_b.get("kind") == "level_plane"):
                    raise ValueError("Measurement axis 'z' is only supported for level datums")
                if norm_ref_a.get("kind") == "level_plane" or norm_ref_b.get("kind") == "level_plane" or axis.lower() == "z":
                    za, _ = resolve_reference_axis(self, norm_ref_a, "z")
                    zb, _ = resolve_reference_axis(self, norm_ref_b, "z")
                    if za is not None and zb is not None:
                        value = abs(zb - za)
                else:
                    pa, out_a = resolve_reference(self, norm_ref_a)
                    pb, out_b = resolve_reference(self, norm_ref_b)
                    if pa is not None and pb is not None:
                        if axis == "x":
                            value = abs(pb[0] - pa[0])
                        elif axis == "y":
                            value = abs(pb[1] - pa[1])
                        else:
                            value = float(math.hypot(pb[0] - pa[0], pb[1] - pa[1]))

        if value is None:
            raise ValueError(
                f"Cannot derive dimension value: references {norm_ref_a} and {norm_ref_b} cannot be resolved and no value was provided"
            )
        val_float = float(value)

        pa, out_a = resolve_reference(self, norm_ref_a)
        pb, out_b = resolve_reference(self, norm_ref_b)
        if out_a == "lost" or out_b == "lost" or pa is None or pb is None:
            init_status = "lost"
        elif out_a == "ambiguous" or out_b == "ambiguous":
            init_status = "ambiguous"
        elif out_a == "repaired" or out_b == "repaired":
            init_status = "repaired"
        else:
            init_status = "exact"

        constraint_id = None
        if is_locked:
            guid_a = norm_ref_a.get("guid")
            guid_b = norm_ref_b.get("guid")
            if guid_a and guid_a in self.element_meta:
                if guid_b and guid_b in self.element_meta and guid_a != guid_b:
                    c = self.add_dimension_lock(
                        guid_a=guid_a,
                        guid_b=guid_b,
                        locked_distance=val_float,
                        is_locked=True,
                        axis=axis if axis in ("x", "y") else "x",
                        ref_a=norm_ref_a,
                        ref_b=norm_ref_b,
                    )
                    constraint_id = c.get("id")
                elif not guid_b or guid_a == guid_b:
                    cid = f"lenlock_{uuid.uuid4().hex[:8]}"
                    c = {
                        "id": cid,
                        "type": "length_lock",
                        "guid": guid_a,
                        "guid_a": guid_a,
                        "guid_b": guid_a,
                        "locked_length": val_float,
                        "locked_distance": val_float,
                        "axis": axis,
                        "is_locked": True,
                        "ref_a": norm_ref_a,
                        "ref_b": norm_ref_b,
                    }
                    self.constraints[cid] = c
                    constraint_id = cid

        dim = {
            "id": dim_id,
            "kind": kind,
            "ref_a": norm_ref_a,
            "ref_b": norm_ref_b,
            "axis": axis,
            "offset": float(offset),
            "value": val_float,
            "is_locked": bool(is_locked),
            "constraint_id": constraint_id,
            "eq_group": eq_group,
            "refs": norm_refs,
            "status": init_status,
            "binding": binding,
            "label": label,
            "eq_anchor": eq_anchor,
        }
        self.dimensions[dim_id] = dim
        self.dimensions_rev += 1
        self.constraints_rev += 1
        self.project_rev += 1
        return dim

    def add_dimension(
        self,
        refs: List[Dict[str, Any]],
        axis: str = "aligned",
        offset: float = 1.0,
        is_locked: bool = False,
        binding: str = "literal",
        label: Optional[str] = None,
        eq_anchor: Optional[int] = None,
        dimension_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Creates a dimension record taking an ordered reference list and deriving segment values from
        current geometry. Takes NO value parameter (Phase 2.2 / §2 Rule 4).
        """
        if not refs or len(refs) < 2:
            raise ValueError("add_dimension requires an ordered list of at least 2 references")

        # Phase 5.2 & §2 Rule 1 binding validation
        if binding == "parameter":
            if not label:
                raise ValueError("label must be set when binding == 'parameter'")
            if is_locked:
                raise ValueError("Dimension binding error: cannot be both locked and labeled")
        else:
            if label is not None:
                raise ValueError(f"label cannot be set when binding == '{binding}' (only when binding == 'parameter')")
        if is_locked and len(refs) > 2 and binding != "equal":
            raise ValueError("Dimension binding error: cannot lock multi-segment dimension without equal binding")

        norm_refs = [normalize_reference(r) for r in refs]
        segments = []
        for i in range(len(norm_refs) - 1):
            ra, rb = norm_refs[i], norm_refs[i + 1]
            if ra.get("kind") == "level_plane" or rb.get("kind") == "level_plane" or axis.lower() == "z":
                za, _ = resolve_reference_axis(self, ra, "z")
                zb, _ = resolve_reference_axis(self, rb, "z")
                seg_val = abs(zb - za) if za is not None and zb is not None else 0.0
            else:
                pa, out_a = resolve_reference(self, ra)
                pb, out_b = resolve_reference(self, rb)
                if pa is not None and pb is not None:
                    if axis == "x":
                        seg_val = abs(pb[0] - pa[0])
                    elif axis == "y":
                        seg_val = abs(pb[1] - pa[1])
                    else:
                        seg_val = float(math.hypot(pb[0] - pa[0], pb[1] - pa[1]))
                else:
                    seg_val = 0.0
            segments.append({
                "value": seg_val,
                "locked": bool(is_locked),
                "value_override": None,
            })

        dim_id = dimension_id or f"dim_{uuid.uuid4().hex[:8]}"
        dim = self.create_dimension(
            ref_a=norm_refs[0],
            ref_b=norm_refs[1],
            axis=axis,
            offset=offset,
            is_locked=is_locked,
            dimension_id=dim_id,
            refs=norm_refs,
            binding=binding,
            label=label,
            eq_anchor=eq_anchor,
        )
        dim["segments"] = segments
        dim["binding"] = binding
        dim["label"] = label
        dim["eq_anchor"] = eq_anchor
        return dim

    def resolve_dimension(self, dim_id: str, segment_index: int = 0) -> Optional[float]:
        """
        Recomputes a dimension segment's measured value from current reference positions (Phase 2.5).
        Returns None if references cannot be resolved or dimension is not found.
        """
        if dim_id not in self.dimensions:
            return None
        dim = self.dimensions[dim_id]
        refs = dim.get("refs")
        if refs and len(refs) > segment_index + 1:
            ra = refs[segment_index]
            rb = refs[segment_index + 1]
        else:
            ra = dim.get("ref_a")
            rb = dim.get("ref_b")

        if not ra or not rb:
            return None

        if ra.get("kind") == "level_plane" or rb.get("kind") == "level_plane" or dim.get("axis", "aligned").lower() == "z":
            za, out_a = resolve_reference_axis(self, ra, "z")
            zb, out_b = resolve_reference_axis(self, rb, "z")
            if za is None or zb is None or out_a == "lost" or out_b == "lost":
                return None
            return abs(zb - za)

        pa, out_a = resolve_reference(self, ra)
        pb, out_b = resolve_reference(self, rb)
        if pa is None or pb is None or out_a == "lost" or out_b == "lost":
            return None

        axis = dim.get("axis", "aligned")
        if axis == "x":
            return abs(pb[0] - pa[0])
        elif axis == "y":
            return abs(pb[1] - pa[1])
        else:
            return float(math.hypot(pb[0] - pa[0], pb[1] - pa[1]))

    def delete_dimension(self, dimension_id: str) -> bool:
        """Deletes a dimension object and releases any associated constraint lock."""
        if dimension_id not in self.dimensions:
            return False
        dim = self.dimensions.pop(dimension_id)
        cid = dim.get("constraint_id")
        if cid and cid in self.constraints:
            self.delete_constraint(cid)
        self.dimensions_rev += 1
        self.constraints_rev += 1
        self.project_rev += 1
        return True

    def referenceable_kinds(self, guid: str) -> List[str]:
        """Returns the set of reference kinds an element publishes (Phase 4.1 / §2.1)."""
        return referenceable_kinds(self, guid)

    def move_reference(
        self,
        ref: Dict[str, Any],
        axis: str,
        new_coord: float,
        *,
        _propagate: bool = False,
    ) -> bool:
        """
        Moves the geometry a reference designates so its coordinate on `axis` becomes
        new_coord (Phase 3.2 & 4.2 / §3.3).
        - wall_start/wall_end: adjust the baseline endpoint (changing length).
        - wall_center: translates the wall along axis.
        - wall_face_pos/wall_face_neg: offsets the baseline so the face lands at new_coord.
        - host_offset: rewrites offset_along_wall.
        - level_plane: rewrites the storey elevation.
        - grid_axis: moves the axis curve and updates IFC entity.
        """
        norm = normalize_reference(ref)
        kind = norm.get("kind")
        sources = norm.get("sources", [])
        if not sources and kind not in ("level_plane", "grid_axis"):
            return False

        axis = axis.lower()
        val = float(new_coord)

        if kind == "wall_start":
            guid = sources[0]["element_guid"]
            if guid not in self.element_meta:
                return False
            meta = self.element_meta[guid]
            sp = list(meta.get("start", [0.0, 0.0, 0.0]))
            if axis == "x":
                sp[0] = val
            elif axis == "y":
                sp[1] = val
            elif axis == "z":
                if len(sp) > 2:
                    sp[2] = val
                else:
                    sp.append(val)
            self.update_element(guid, {"start": sp})
            if _propagate:
                self._solve_constraints_after_move(guid)
            return True

        elif kind == "wall_end":
            guid = sources[0]["element_guid"]
            if guid not in self.element_meta:
                return False
            meta = self.element_meta[guid]
            ep = list(meta.get("end", [0.0, 0.0, 0.0]))
            if axis == "x":
                ep[0] = val
            elif axis == "y":
                ep[1] = val
            elif axis == "z":
                if len(ep) > 2:
                    ep[2] = val
                else:
                    ep.append(val)
            self.update_element(guid, {"end": ep})
            if _propagate:
                self._solve_constraints_after_move(guid)
            return True

        elif kind == "wall_center":
            guid = sources[0]["element_guid"]
            if guid not in self.element_meta:
                return False
            meta = self.element_meta[guid]
            sp = meta.get("start", [0.0, 0.0, 0.0])
            ep = meta.get("end", [0.0, 0.0, 0.0])
            if axis == "x":
                cur_c = (float(sp[0]) + float(ep[0])) / 2.0
                dx = val - cur_c
                dy = 0.0
            elif axis == "y":
                cur_c = (float(sp[1]) + float(ep[1])) / 2.0
                dx = 0.0
                dy = val - cur_c
            else:
                dx = dy = 0.0
            return self.translate_element(guid, dx, dy, 0.0, _propagate=_propagate)

        elif kind in ("wall_face_pos", "wall_face_neg"):
            guid = sources[0]["element_guid"]
            if guid not in self.element_meta:
                return False
            coords, outcome = resolve_reference(self, norm)
            if coords is None:
                return False
            if axis == "x":
                dx = val - coords[0]
                dy = 0.0
            elif axis == "y":
                dx = 0.0
                dy = val - coords[1]
            else:
                dx = dy = 0.0
            return self.translate_element(guid, dx, dy, 0.0, _propagate=_propagate)

        elif kind == "host_offset":
            guid = sources[0]["element_guid"]
            if guid not in self.element_meta:
                return False
            meta = self.element_meta[guid]
            host_guid = meta.get("host_wall_guid")
            if not host_guid or host_guid not in self.element_meta:
                return False
            hm = self.element_meta[host_guid]
            sp, ep = hm.get("start"), hm.get("end")
            if not sp or not ep:
                return False
            dx = float(ep[0]) - float(sp[0])
            dy = float(ep[1]) - float(sp[1])
            L = math.hypot(dx, dy)
            if L < 1e-6:
                return False
            ux, uy = dx / L, dy / L
            if axis == "x" and abs(ux) > 1e-6:
                new_offset = (val - float(sp[0])) / ux
            elif axis == "y" and abs(uy) > 1e-6:
                new_offset = (val - float(sp[1])) / uy
            else:
                new_offset = val
            self.update_element(guid, {"offset_along_wall": new_offset})
            if _propagate:
                self._solve_constraints_after_move(guid)
            return True

        elif kind == "level_plane":
            lid = sources[0]["element_guid"] if sources else norm.get("guid")
            if not lid or not hasattr(self, "levels"):
                return False
            target_lid = lid if lid in self.levels else None
            if not target_lid:
                for k, lv in self.levels.items():
                    if k.lower() == str(lid).lower() or lv.get("name", "").lower() == str(lid).lower():
                        target_lid = k
                        break
            if not target_lid:
                return False
            self.move_level(target_lid, val)
            return True

        elif kind == "grid_axis":
            gid = sources[0]["element_guid"] if sources else norm.get("guid")
            if not gid or gid not in self.element_meta:
                return False
            meta = self.element_meta[gid]
            sp = list(meta.get("start", [0.0, 0.0]))
            ep = list(meta.get("end", [0.0, 0.0]))
            if axis == "x":
                cur_x = (float(sp[0]) + float(ep[0])) / 2.0
                dx = val - cur_x
                dy = 0.0
            elif axis == "y":
                cur_y = (float(sp[1]) + float(ep[1])) / 2.0
                dx = 0.0
                dy = val - cur_y
            else:
                dx = dy = 0.0
            meta["start"][0] += dx
            meta["start"][1] += dy
            meta["end"][0] += dx
            meta["end"][1] += dy
            entity = meta.get("entity")
            if entity and hasattr(entity, "UAxes") and entity.UAxes:
                axis_curve = entity.UAxes[0].AxisCurve
                if axis_curve and hasattr(axis_curve, "Points") and len(axis_curve.Points) >= 2:
                    axis_curve.Points[0].Coordinates = (feet_to_metres(meta["start"][0]), feet_to_metres(meta["start"][1]))
                    axis_curve.Points[1].Coordinates = (feet_to_metres(meta["end"][0]), feet_to_metres(meta["end"][1]))
            self.grids_rev += 1
            self.project_rev += 1
            if _propagate:
                self._solve_constraints_after_move(gid)
            return True

        return False

    def set_dimension_value(
        self,
        dimension_id: str,
        value: float,
        anchor: str = "start",
        segment_index: int = 0,
    ) -> Dict[str, Any]:
        """
        Sets the value of a dimension and re-solves the geometry (Phase 2.5 & Phase 3.3).
        Carries the TARGET VALUE (not a delta).
        - For a single-wall dimension (start <-> end), resizes the wall along its baseline.
        - For a reference-driven dimension, solves via ConstraintSolver and moves references directly.
        """
        if value <= 0:
            raise ValueError(f"Dimension value must be positive, got {value}")

        val_float = float(value)

        # Helper to find level ID by ID or Name
        def _lookup_level(ident):
            if not ident or not hasattr(self, "levels"):
                return None
            if ident in self.levels:
                return ident
            for lid, lv in self.levels.items():
                if lv.get("name", "").lower() == str(ident).lower() or lid.lower() == str(ident).lower():
                    return lid
            return None

        # Case 0: dimension_id is directly a level_id in self.levels (Task 2.7)
        lvl_target = _lookup_level(dimension_id)
        if lvl_target:
            self.move_level(lvl_target, val_float)
            self.dimensions_rev += 1
            self.constraints_rev += 1
            self.project_rev += 1
            return {"status": "updated", "level_id": lvl_target, "elevation": val_float}

        # Case 1: dimension_id exists in self.dimensions
        if dimension_id in self.dimensions:
            dim = self.dimensions[dimension_id]
            ref_a = normalize_reference(dim.get("ref_a", {}))
            ref_b = normalize_reference(dim.get("ref_b", {}))
            refs = dim.get("refs")
            if not refs:
                refs = [ref_a, ref_b]
            refs = [normalize_reference(r) for r in refs if r]
            guid_a = ref_a.get("guid") or (ref_a.get("sources") and ref_a["sources"][0]["element_guid"])
            guid_b = ref_b.get("guid") or (ref_b.get("sources") and ref_b["sources"][0]["element_guid"])

            # Check if this dimension targets a level (H3)
            lvl_b = _lookup_level(guid_b) or (_lookup_level(ref_b.get("guid")) if isinstance(ref_b, dict) else None)
            lvl_a = _lookup_level(guid_a) or (_lookup_level(ref_a.get("guid")) if isinstance(ref_a, dict) else None)
            if lvl_b or lvl_a or ref_a.get("kind") == "level_plane" or ref_b.get("kind") == "level_plane":
                if lvl_b or ref_b.get("kind") == "level_plane":
                    move_lvl = lvl_b or (ref_b.get("sources") and ref_b["sources"][0]["element_guid"])
                    other_ref = ref_a
                else:
                    move_lvl = lvl_a or (ref_a.get("sources") and ref_a["sources"][0]["element_guid"])
                    other_ref = ref_b

                move_lvl = _lookup_level(move_lvl)
                if move_lvl and move_lvl in self.levels:
                    elev_other, _ = resolve_reference_axis(self, other_ref, "z")
                    if elev_other is None:
                        elev_other = 0.0
                    cur_lvl_elev = float(self.levels[move_lvl].get("elevation", 0.0))
                    sign = 1.0 if cur_lvl_elev >= elev_other else -1.0
                    target_elev = elev_other + sign * val_float
                    self.move_level(move_lvl, target_elev)
                    self.last_constraint_conflict = None
                    dim["value"] = val_float
                    if "segments" in dim and len(dim["segments"]) > segment_index:
                        dim["segments"][segment_index]["value"] = val_float
                    self.dimensions_rev += 1
                    self.constraints_rev += 1
                    self.project_rev += 1
                    return {"status": "updated", "dimension_id": dimension_id, "value": val_float}

            if dim.get("axis") == "z":
                return {
                    "status": "failed",
                    "dimension_id": dimension_id,
                    "error": "Measurement axis 'z' is only supported for level datums",
                }

            kind_a = ref_a.get("kind")
            kind_b = ref_b.get("kind")
            is_same_element = guid_a and (guid_a == guid_b or not guid_b)

            if is_same_element:
                meta = self.element_meta.get(guid_a, {})
                sp = meta.get("start", [0.0, 0.0])
                ep = meta.get("end", [0.0, 0.0])
                dx = float(ep[0]) - float(sp[0])
                dy = float(ep[1]) - float(sp[1])
                cur_L = math.hypot(dx, dy)
                if cur_L < 1e-6:
                    return {"status": "failed", "dimension_id": dimension_id, "error": "Wall has degenerate zero length"}
                ux, uy = dx / cur_L, dy / cur_L
                nx, ny = -uy, ux
                th = float(meta.get("thickness", 0.5))
                dim_axis = dim.get("axis", "aligned").lower()

                # Case A: Thickness between positive and negative faces
                if {kind_a, kind_b} == {"wall_face_pos", "wall_face_neg"}:
                    if dim_axis == "aligned":
                        new_th = val_float
                    elif dim_axis == "x":
                        if abs(nx) < 1e-4:
                            return {"status": "failed", "dimension_id": dimension_id, "error": f"Cannot change thickness along x for wall on axis {dim_axis}"}
                        new_th = val_float / abs(nx)
                    elif dim_axis == "y":
                        if abs(ny) < 1e-4:
                            return {"status": "failed", "dimension_id": dimension_id, "error": f"Cannot change thickness along y for wall on axis {dim_axis}"}
                        new_th = val_float / abs(ny)
                    else:
                        return {"status": "failed", "dimension_id": dimension_id, "error": f"Unsupported axis {dim_axis}"}

                    if new_th <= 0.0:
                        return {"status": "failed", "dimension_id": dimension_id, "error": "Target thickness must be positive"}

                    self.update_element(guid_a, {"thickness": new_th})
                    self.last_constraint_conflict = None
                    dim["value"] = val_float
                    if "segments" in dim and len(dim["segments"]) > segment_index:
                        dim["segments"][segment_index]["value"] = val_float
                    cid = dim.get("constraint_id")
                    if cid and cid in self.constraints:
                        c = self.constraints[cid]
                        c["locked_distance"] = val_float
                        c["origin_distance"] = self._recalculate_origin_distance(c, val_float)
                        if c.get("type") == "length_lock":
                            c["locked_length"] = val_float
                    self._solve_constraints_after_move(guid_a)
                    self.dimensions_rev += 1
                    self.constraints_rev += 1
                    self.project_rev += 1
                    return {"status": "updated", "dimension_id": dimension_id, "value": val_float}

                # Case B: Half-thickness between center and a face
                elif {kind_a, kind_b} in ({"wall_center", "wall_face_pos"}, {"wall_center", "wall_face_neg"}):
                    if dim_axis == "aligned":
                        new_th = 2.0 * val_float
                    elif dim_axis == "x":
                        if abs(nx) < 1e-4:
                            return {"status": "failed", "dimension_id": dimension_id, "error": f"Cannot change thickness along x for wall on axis {dim_axis}"}
                        new_th = 2.0 * val_float / abs(nx)
                    elif dim_axis == "y":
                        if abs(ny) < 1e-4:
                            return {"status": "failed", "dimension_id": dimension_id, "error": f"Cannot change thickness along y for wall on axis {dim_axis}"}
                        new_th = 2.0 * val_float / abs(ny)
                    else:
                        return {"status": "failed", "dimension_id": dimension_id, "error": f"Unsupported axis {dim_axis}"}

                    if new_th <= 0.0:
                        return {"status": "failed", "dimension_id": dimension_id, "error": "Target thickness must be positive"}

                    self.update_element(guid_a, {"thickness": new_th})
                    self.last_constraint_conflict = None
                    dim["value"] = val_float
                    if "segments" in dim and len(dim["segments"]) > segment_index:
                        dim["segments"][segment_index]["value"] = val_float
                    cid = dim.get("constraint_id")
                    if cid and cid in self.constraints:
                        c = self.constraints[cid]
                        c["locked_distance"] = val_float
                        c["origin_distance"] = self._recalculate_origin_distance(c, val_float)
                        if c.get("type") == "length_lock":
                            c["locked_length"] = val_float
                    self._solve_constraints_after_move(guid_a)
                    self.dimensions_rev += 1
                    self.constraints_rev += 1
                    self.project_rev += 1
                    return {"status": "updated", "dimension_id": dimension_id, "value": val_float}

                # Case C: Full length between start and end
                elif {kind_a, kind_b} == {"wall_start", "wall_end"}:
                    if dim_axis == "aligned":
                        target_len = val_float
                    elif dim_axis == "x":
                        if abs(ux) < 1e-4:
                            return {"status": "failed", "dimension_id": dimension_id, "error": "Cannot change wall length along x for y-aligned wall"}
                        target_len = val_float / abs(ux)
                    elif dim_axis == "y":
                        if abs(uy) < 1e-4:
                            return {"status": "failed", "dimension_id": dimension_id, "error": "Cannot change wall length along y for x-aligned wall"}
                        target_len = val_float / abs(uy)
                    else:
                        return {"status": "failed", "dimension_id": dimension_id, "error": f"Unsupported axis {dim_axis}"}

                # Case D: Half length between start/end and center
                elif {kind_a, kind_b} in ({"wall_start", "wall_center"}, {"wall_end", "wall_center"}):
                    if dim_axis == "aligned":
                        target_len = 2.0 * val_float
                    elif dim_axis == "x":
                        if abs(ux) < 1e-4:
                            return {"status": "failed", "dimension_id": dimension_id, "error": "Cannot change wall length along x for y-aligned wall"}
                        target_len = 2.0 * val_float / abs(ux)
                    elif dim_axis == "y":
                        if abs(uy) < 1e-4:
                            return {"status": "failed", "dimension_id": dimension_id, "error": "Cannot change wall length along y for x-aligned wall"}
                        target_len = 2.0 * val_float / abs(uy)
                    else:
                        return {"status": "failed", "dimension_id": dimension_id, "error": f"Unsupported axis {dim_axis}"}

                # Case E: Distance between start/end and a face
                elif {kind_a, kind_b} in (
                    {"wall_start", "wall_face_pos"}, {"wall_start", "wall_face_neg"},
                    {"wall_end", "wall_face_pos"}, {"wall_end", "wall_face_neg"}
                ):
                    pa, out_a = resolve_reference(self, ref_a)
                    pb, out_b = resolve_reference(self, ref_b)
                    if pa is None or pb is None or out_a == "lost" or out_b == "lost":
                        return {"status": "failed", "dimension_id": dimension_id, "error": "Witness references unresolved"}

                    face_ref = ref_a if "face" in kind_a else ref_b
                    sign_face = 1.0 if face_ref.get("kind") == "wall_face_pos" else -1.0
                    c_L = 1.0 if ("wall_start" in {kind_a, kind_b}) else -1.0

                    if dim_axis == "aligned":
                        if val_float <= (th / 2.0):
                            return {"status": "failed", "dimension_id": dimension_id, "error": "Target dimension less than or equal to half-thickness"}
                        target_len = 2.0 * math.sqrt(val_float**2 - (th / 2.0)**2)
                    elif dim_axis == "x":
                        if abs(ux) < 1e-4:
                            # y-aligned wall: distance along x to face is purely face offset (thickness)
                            new_th = 2.0 * val_float / abs(nx)
                            if new_th <= 0.0:
                                return {"status": "failed", "dimension_id": dimension_id, "error": "Target thickness must be positive"}
                            self.update_element(guid_a, {"thickness": new_th})
                            self.last_constraint_conflict = None
                            dim["value"] = val_float
                            if "segments" in dim and len(dim["segments"]) > segment_index:
                                dim["segments"][segment_index]["value"] = val_float
                            cid = dim.get("constraint_id")
                            if cid and cid in self.constraints:
                                c = self.constraints[cid]
                                c["locked_distance"] = val_float
                                c["origin_distance"] = self._recalculate_origin_distance(c, val_float)
                                if c.get("type") == "length_lock":
                                    c["locked_length"] = val_float
                            self._solve_constraints_after_move(guid_a)
                            self.dimensions_rev += 1
                            self.constraints_rev += 1
                            self.project_rev += 1
                            return {"status": "updated", "dimension_id": dimension_id, "value": val_float}

                        cur_dx = pb[0] - pa[0] if (ref_b == face_ref) else pa[0] - pb[0]
                        cur_sign = 1.0 if cur_dx >= 0 else -1.0
                        th_term = sign_face * (th / 2.0) * nx
                        target_len = 2.0 * (cur_sign * val_float - th_term) / (c_L * ux)
                    elif dim_axis == "y":
                        if abs(uy) < 1e-4:
                            # x-aligned wall: distance along y to face is purely face offset (thickness)
                            new_th = 2.0 * val_float / abs(ny)
                            if new_th <= 0.0:
                                return {"status": "failed", "dimension_id": dimension_id, "error": "Target thickness must be positive"}
                            self.update_element(guid_a, {"thickness": new_th})
                            self.last_constraint_conflict = None
                            dim["value"] = val_float
                            if "segments" in dim and len(dim["segments"]) > segment_index:
                                dim["segments"][segment_index]["value"] = val_float
                            cid = dim.get("constraint_id")
                            if cid and cid in self.constraints:
                                c = self.constraints[cid]
                                c["locked_distance"] = val_float
                                c["origin_distance"] = self._recalculate_origin_distance(c, val_float)
                                if c.get("type") == "length_lock":
                                    c["locked_length"] = val_float
                            self._solve_constraints_after_move(guid_a)
                            self.dimensions_rev += 1
                            self.constraints_rev += 1
                            self.project_rev += 1
                            return {"status": "updated", "dimension_id": dimension_id, "value": val_float}

                        cur_dy = pb[1] - pa[1] if (ref_b == face_ref) else pa[1] - pb[1]
                        cur_sign = 1.0 if cur_dy >= 0 else -1.0
                        th_term = sign_face * (th / 2.0) * ny
                        target_len = 2.0 * (cur_sign * val_float - th_term) / (c_L * uy)
                    else:
                        return {"status": "failed", "dimension_id": dimension_id, "error": f"Unsupported axis {dim_axis}"}

                else:
                    return {
                        "status": "failed",
                        "dimension_id": dimension_id,
                        "error": f"Unsupported same-element dimension pair ({kind_a}, {kind_b}) on axis {dim_axis}",
                    }

                if target_len <= 0.0:
                    return {
                        "status": "failed",
                        "dimension_id": dimension_id,
                        "error": "Target dimension requires non-positive wall length",
                    }

                from constraint_solver import ConstraintSolver
                solver = ConstraintSolver(self)
                dim_axis = dim.get("axis", "aligned")
                sp, ep = meta.get("start", [0.0, 0.0]), meta.get("end", [0.0, 0.0])
                if dim_axis in ("x", "y"):
                    solve_axis = dim_axis
                elif abs(ep[1] - sp[1]) < 1e-4:
                    solve_axis = "x"
                elif abs(ep[0] - sp[0]) < 1e-4:
                    solve_axis = "y"
                else:
                    solve_axis = None

                if anchor == "center" or solve_axis is None or {kind_a, kind_b} != {"wall_start", "wall_end"}:
                    self._resize_wall_length(guid_a, target_len, anchor=anchor)
                    self.last_constraint_conflict = None
                    dim["value"] = val_float
                    if "segments" in dim and len(dim["segments"]) > segment_index:
                        dim["segments"][segment_index]["value"] = val_float
                    cid = dim.get("constraint_id")
                    if cid and cid in self.constraints:
                        c = self.constraints[cid]
                        c["locked_distance"] = val_float
                        c["origin_distance"] = self._recalculate_origin_distance(c, val_float)
                        if c.get("type") == "length_lock":
                            c["locked_length"] = val_float
                    self._solve_constraints_after_move(guid_a)
                else:
                    if anchor == "start":
                        pin_ref = ref_a if kind_a == "wall_start" else ref_b
                        move_ref = ref_b if kind_b == "wall_end" else ref_a
                    else:
                        pin_ref = ref_b if kind_b == "wall_end" else ref_a
                        move_ref = ref_a if kind_a == "wall_start" else ref_b

                    pins = {}
                    c_pin, _ = resolve_reference_axis(self, pin_ref, solve_axis)
                    if c_pin is not None:
                        pins[reference_key(pin_ref)] = float(c_pin)

                    temp_dim = copy.deepcopy(dim)
                    temp_dim["value"] = val_float
                    if "segments" in temp_dim and len(temp_dim["segments"]) > segment_index:
                        temp_dim["segments"][segment_index]["value"] = val_float
                    else:
                        temp_dim["segments"] = [{"value": val_float, "locked": True}]

                    solve_res = solver.solve_dimensions(solve_axis, temp_dim, pins)
                    if solve_res.status == "conflict":
                        return {
                            "status": "conflict",
                            "dimension_id": dimension_id,
                            "value": val_float,
                            "conflict": self.last_constraint_conflict,
                        }
                    if solve_res.status != "success":
                        return {
                            "status": "failed",
                            "dimension_id": dimension_id,
                            "value": val_float,
                            "reason": solve_res.status,
                        }

                    move_k = reference_key(move_ref)
                    if move_k not in solve_res.coordinates:
                        return {
                            "status": "failed",
                            "dimension_id": dimension_id,
                            "value": val_float,
                            "reason": f"No solved coordinate for '{move_k}'",
                        }

                    target_coord = solve_res.coordinates[move_k]
                    dim["value"] = val_float
                    if "segments" in dim and len(dim["segments"]) > segment_index:
                        dim["segments"][segment_index]["value"] = val_float
                    cid = dim.get("constraint_id")
                    if cid and cid in self.constraints:
                        c = self.constraints[cid]
                        c["locked_distance"] = val_float
                        c["origin_distance"] = self._recalculate_origin_distance(c, val_float)
                        if c.get("type") == "length_lock":
                            c["locked_length"] = val_float
                    self.move_reference(move_ref, solve_axis, target_coord, _propagate=True)
                    self.last_constraint_conflict = None

            elif guid_a and guid_b:
                # Multi-element or non-length same-element reference-driven dimension (Phase 3.3 / H1)
                from constraint_solver import ConstraintSolver
                solver = ConstraintSolver(self)
                pa, out_a = resolve_reference(self, ref_a)
                pb, out_b = resolve_reference(self, ref_b)
                if pa is None or pb is None or out_a == "lost" or out_b == "lost":
                    return {"status": "error", "error": "Dimension witness references lost"}

                dim_axis = dim.get("axis", "aligned")
                if dim_axis in ("x", "y"):
                    solve_axis = dim_axis
                else:
                    solve_axis = "x" if abs(pb[0] - pa[0]) >= abs(pb[1] - pa[1]) else "y"

                is_datum_a = ref_a.get("kind") in ("grid_axis", "level_plane")
                is_datum_b = ref_b.get("kind") in ("grid_axis", "level_plane")
                if is_datum_b and not is_datum_a:
                    pin_ref, move_ref = ref_b, ref_a
                elif is_datum_a and not is_datum_b:
                    pin_ref, move_ref = ref_a, ref_b
                elif anchor == "end":
                    pin_ref, move_ref = ref_b, ref_a
                else:
                    pin_ref, move_ref = ref_a, ref_b

                pin_coord, _ = resolve_reference_axis(self, pin_ref, solve_axis)
                pins = {}
                if pin_coord is not None:
                    pins[reference_key(pin_ref)] = float(pin_coord)

                temp_dim = copy.deepcopy(dim)
                temp_dim["value"] = val_float
                if "segments" in temp_dim and len(temp_dim["segments"]) > segment_index:
                    temp_dim["segments"][segment_index]["value"] = val_float
                else:
                    temp_dim["segments"] = [{"value": val_float, "locked": True}]

                solve_res = solver.solve_dimensions(solve_axis, temp_dim, pins)
                if solve_res.status == "conflict":
                    return {
                        "status": "conflict",
                        "dimension_id": dimension_id,
                        "value": val_float,
                        "conflict": self.last_constraint_conflict,
                    }

                if solve_res.status != "success":
                    return {
                        "status": "failed",
                        "dimension_id": dimension_id,
                        "value": val_float,
                        "reason": solve_res.status,
                    }

                move_k = reference_key(move_ref)
                if move_k not in solve_res.coordinates:
                    return {
                        "status": "failed",
                        "dimension_id": dimension_id,
                        "value": val_float,
                        "reason": f"No solved coordinate for '{move_k}'",
                    }

                target_coord = solve_res.coordinates[move_k]
                dim["value"] = val_float
                if "segments" in dim and len(dim["segments"]) > segment_index:
                    dim["segments"][segment_index]["value"] = val_float
                cid = dim.get("constraint_id")
                if cid and cid in self.constraints:
                    c = self.constraints[cid]
                    c["locked_distance"] = val_float
                    c["origin_distance"] = self._recalculate_origin_distance(c, val_float)
                    if c.get("type") == "length_lock":
                        c["locked_length"] = val_float
                self.move_reference(move_ref, solve_axis, target_coord, _propagate=True)
                self.last_constraint_conflict = None

        # Case 2: dimension_id is an element GUID directly in self.element_meta
        elif dimension_id in self.element_meta:
            self._resize_wall_length(dimension_id, val_float, anchor=anchor)
            # Synchronize any single-wall dimensions monitoring this element
            for d in self.dimensions.values():
                if d.get("ref_a", {}).get("guid") == dimension_id and d.get("ref_b", {}).get("guid") == dimension_id:
                    d["value"] = val_float
                    if "segments" in d and len(d["segments"]) > 0:
                        d["segments"][0]["value"] = val_float
            try:
                self._solve_constraints_after_move(dimension_id)
            except Exception:
                pass
        else:
            raise KeyError(f"Dimension or element '{dimension_id}' not found")

        self.dimensions_rev += 1
        self.constraints_rev += 1
        self.project_rev += 1
        return {"status": "updated", "dimension_id": dimension_id, "value": val_float}

    def _resize_wall_length(self, guid: str, new_length: float, anchor: str = "start") -> None:
        """Resizes a wall along its existing baseline to `new_length` in decimal feet."""
        if guid not in self.element_meta:
            raise KeyError(f"Wall {guid} not found")
        meta = self.element_meta[guid]
        if meta.get("ifc_class") not in ("IfcWall", "IfcWallStandardCase"):
            raise ValueError(f"Length resize only supported for walls, got {meta.get('ifc_class')}")

        sp = list(meta["start"])
        ep = list(meta["end"])
        cur_len = math.hypot(ep[0] - sp[0], ep[1] - sp[1])
        if cur_len < 1e-6:
            ux, uy = 1.0, 0.0
        else:
            ux = (ep[0] - sp[0]) / cur_len
            uy = (ep[1] - sp[1]) / cur_len

        if anchor == "end":
            new_sp = [ep[0] - ux * new_length, ep[1] - uy * new_length, sp[2] if len(sp) > 2 else 0.0]
            self.update_element(guid, {"start": new_sp})
        elif anchor == "center":
            mx, my = (sp[0] + ep[0]) / 2.0, (sp[1] + ep[1]) / 2.0
            hl = new_length / 2.0
            new_sp = [mx - ux * hl, my - uy * hl, sp[2] if len(sp) > 2 else 0.0]
            new_ep = [mx + ux * hl, my + uy * hl, ep[2] if len(ep) > 2 else 0.0]
            self.update_element(guid, {"start": new_sp, "end": new_ep})
        else:  # default "start" (end moves along baseline)
            new_ep = [sp[0] + ux * new_length, sp[1] + uy * new_length, ep[2] if len(ep) > 2 else 0.0]
            self.update_element(guid, {"end": new_ep})

    def set_wall_join(
        self,
        wall_guid: str,
        end_index: int,
        allow_join: bool = True,
        mode: str = "butt",
    ) -> Dict[str, Any]:
        """
        Configures wall join behavior for a specific wall endpoint:
        - allow_join: True/False (Revit: WallUtils.IsWallJoinAllowedAtEnd)
        - mode: "butt" (default), "miter", or "square_off"
        """
        if wall_guid not in self.element_meta:
            raise ValueError(f"Wall {wall_guid} not found")
        end_key = f"end{end_index}"
        if wall_guid not in self.join_policies:
            self.join_policies[wall_guid] = {
                "end0": {"allow_join": True, "mode": "butt"},
                "end1": {"allow_join": True, "mode": "butt"},
            }
        self.join_policies[wall_guid][end_key] = {
            "allow_join": allow_join,
            "mode": mode if mode in ("butt", "miter", "square_off") else "butt",
        }
        self.recompute_wall_joins()
        return self.join_policies[wall_guid]

    def get_wall_joins(self) -> Dict[str, Dict[str, Any]]:
        return self.join_policies

    # =====================================================================
    # WALL JOIN GEOMETRY ENGINE (GLM Master Spec v2.3 §3.3 Phase A)
    # Computes trimmed footprint polygons per join type (miter via angle
    # bisector half-plane clip; butt / square-off / T-junction via face-line
    # clips) and rebuilds each wall's 3D representation as an extruded
    # arbitrary profile. The 2D plan slice consumes the same polygons, so
    # joined corners render without seam lines — matching Revit's plan
    # cleanup semantics (butt is the default; per-endpoint Disallow Join).
    # =====================================================================

    _JOIN_TOL = 0.05          # endpoint coincidence tolerance (ft, ~15 mm)
    _MITER_MIN_ANGLE = 15.0   # degrees; outside [15, 165] miter falls back to butt

    @staticmethod
    def _get_2d_hull(points_2d):
        """Computes 2D convex hull of points using Monotone Chain."""
        pts = sorted(set((round(float(p[0]), 4), round(float(p[1]), 4)) for p in points_2d))
        if len(pts) <= 2:
            return pts
        def cross(o, a, b):
            return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
        lower = []
        for p in pts:
            while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
                lower.pop()
            lower.append(p)
        upper = []
        for p in reversed(pts):
            while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
                upper.pop()
            upper.append(p)
        return lower[:-1] + upper[:-1]

    @staticmethod
    def _clip_poly_s(poly, sp, u, s_min=None, s_max=None):
        """Clips a polygon to the slab s_min <= dot(p - sp, u) <= s_max.
        Band lines are perpendicular to the baseline direction u."""
        def proj(p):
            return (p[0] - sp[0]) * u[0] + (p[1] - sp[1]) * u[1]

        def clip_once(pts, limit, keep_less):
            if not pts or limit is None:
                return pts
            out = []
            n = len(pts)
            for i in range(n):
                a, b = pts[i], pts[(i + 1) % n]
                sa, sb = proj(a) - limit, proj(b) - limit
                in_a = (sa <= 0) if keep_less else (sa >= 0)
                in_b = (sb <= 0) if keep_less else (sb >= 0)
                if in_a:
                    out.append(a)
                if in_a != in_b:
                    t = sa / (sa - sb)
                    out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            return out

        pts = list(poly)
        if s_min is not None:
            pts = clip_once(pts, s_min, keep_less=False)
        if s_max is not None:
            pts = clip_once(pts, s_max, keep_less=True)
        return pts

    @staticmethod
    def _clip_poly_line(poly, p0, d, keep_point):
        """Clips a convex polygon against the half-plane bounded by the line
        through p0 with direction d, keeping the side containing keep_point."""
        n = (-d[1], d[0])
        s0 = (keep_point[0] - p0[0]) * n[0] + (keep_point[1] - p0[1]) * n[1]
        keep_sign = 1.0 if s0 >= 0 else -1.0

        def side(p):
            return ((p[0] - p0[0]) * n[0] + (p[1] - p0[1]) * n[1]) * keep_sign

        out = []
        N = len(poly)
        for i in range(N):
            a, b = poly[i], poly[(i + 1) % N]
            sa, sb = side(a), side(b)
            if sa >= 0:
                out.append(a)
            if (sa >= 0) != (sb >= 0):
                t = sa / (sa - sb)
                out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        return out

    @staticmethod
    def _miter_joint_line(E, uW, tW, uX, tX, farW, farX):
        """The miter joint line, built from the two walls' SIDE FACES.

        Revit 2025 `HostObjDB.dll` exports `MiterBySideFacesTargetData`. Each wall
        contributes two face lines parallel to its baseline, offset half a
        thickness. The joint plane passes through the intersection of the pair of
        faces that forms the corner; which pair that is follows from the miter's
        defining property - the plane must separate the two wall bodies, so each
        wall's far end lies on an opposite side of it.

        For equal thickness this coincides with the angle bisector, which is why a
        single-thickness fixture corpus cannot distinguish the two
        implementations. For unequal thickness it does not: perpendicular walls of
        thickness tW and tX meet at an outer corner of (tX/2, tW/2) with joint
        slope tW/tX, whereas a bisector always gives (tW/2, tW/2) and slope 1.

        Returns (point_on_line, direction), or None when neither pairing separates
        the bodies (near-collinear walls); the caller then falls back.
        """
        def face_lines(P, u, thickness):
            n = (-u[1], u[0])
            return (
                ((P[0] + n[0] * thickness / 2.0, P[1] + n[1] * thickness / 2.0), u),
                ((P[0] - n[0] * thickness / 2.0, P[1] - n[1] * thickness / 2.0), u),
            )

        def side(p0, d, q):
            n = (-d[1], d[0])
            return (q[0] - p0[0]) * n[0] + (q[1] - p0[1]) * n[1]

        fw = face_lines(E, uW, tW)
        fx = face_lines(E, uX, tX)

        for fa, fb, fc, fd in (
            (fw[0], fx[1], fw[1], fx[0]),
            (fw[0], fx[0], fw[1], fx[1]),
        ):
            P1 = BimModelManager._line_intersect(fa[0], fa[1], fb[0], fb[1])
            P2 = BimModelManager._line_intersect(fc[0], fc[1], fd[0], fd[1])
            if P1 is None or P2 is None:
                continue
            d = (P2[0] - P1[0], P2[1] - P1[1])
            if math.hypot(d[0], d[1]) < 1e-9:
                continue
            if side(P1, d, farW) * side(P1, d, farX) < 0:
                return P1, d
        return None

    def _wall_rect(self, meta, ext_start: float = 0.0, ext_end: float = 0.0):
        """Plain (untrimmed) rectangular footprint of a wall, world XY.

        `ext_start` / `ext_end` push the corresponding end outward along the
        baseline. A miter joint plane can lie up to half the PARTNER's thickness
        beyond our own endpoint, so an unextended rectangle has no material there
        and the joint silently loses its inner-corner sliver (measured: a
        0.15 x 0.15 square at 0.3 ft thickness, with the corner misplaced by up to
        0.4 ft when the thicknesses differ by 9:1). Extension is only ever applied
        to a mitered end.
        """
        sp, ep = meta["start"], meta["end"]
        ang = meta["angle"]
        t = meta["thickness"]
        nx, ny = -math.sin(ang) * (t / 2.0), math.cos(ang) * (t / 2.0)
        ux, uy = math.cos(ang), math.sin(ang)
        sx, sy = sp[0] - ux * ext_start, sp[1] - uy * ext_start
        ex, ey = ep[0] + ux * ext_end, ep[1] + uy * ext_end
        return [
            (sx + nx, sy + ny),
            (ex + nx, ey + ny),
            (ex - nx, ey - ny),
            (sx - nx, sy - ny),
        ]

    #: Grid cell (feet) for the join-partner candidate index. See `_join_candidates`.
    #: 1 ft >> the 0.05 ft coincidence tolerance, so a 3x3 neighbourhood lookup is a
    #: superset of every candidate the old full scan could match.
    _JOIN_INDEX_CELL = 1.0

    def _build_join_index(self, walls):
        """
        Candidate index for `_find_join_partner`, built once per join pass.

        The partner search used to scan every wall for every wall end, which is the
        O(N^2) term that dominated an edit once the plan cache removed the view cost
        (measured: 2,004,002 wall visits for a single move at N=1000). Two lookups:

          * `endpoints` buckets wall ends by grid cell. A corner partner must have an
            endpoint within `_JOIN_TOL` (0.05 ft), and 0.05 < 1.0 cell, so every
            possible corner partner is in the query point's own or one adjacent cell.
          * `baselines` buckets each wall by every grid cell its bounding box touches.
            A tee partner must have the query point within `tol + thickness/2` of its
            baseline, so its bbox is within that of the point — hence in the point's
            cell or one adjacent.

        Both yield a SUPERSET of the old scan's candidates; the exact tolerance tests
        in `_find_join_partner` are unchanged, so results are identical. Candidates are
        returned in `walls` iteration order so the first match, and therefore the
        chosen partner, does not change.
        """
        endpoints: Dict[Tuple[int, int], List[Tuple[str, int]]] = {}
        baselines: Dict[Tuple[int, int], List[str]] = {}
        cell = self._JOIN_INDEX_CELL
        for other_guid, om in walls.items():
            if "start" not in om or "end" not in om:
                continue
            osp, oep = om["start"], om["end"]
            for oe, P in ((0, osp), (1, oep)):
                key = (int(math.floor(P[0] / cell)), int(math.floor(P[1] / cell)))
                endpoints.setdefault(key, []).append((other_guid, oe))
            t = float(om.get("thickness", 0.0) or 0.0)
            xs = (osp[0], oep[0])
            ys = (osp[1], oep[1])
            for cx in range(int(math.floor((min(xs) - t) / cell)),
                            int(math.floor((max(xs) + t) / cell)) + 1):
                for cy in range(int(math.floor((min(ys) - t) / cell)),
                                int(math.floor((max(ys) + t) / cell)) + 1):
                    baselines.setdefault((cx, cy), []).append(other_guid)
        return {"endpoints": endpoints, "baselines": baselines, "cell": cell}

    def _join_candidates(self, index, walls, guid, E, tol: float) -> List[str]:
        """
        Partner candidates for one wall end, in `walls` iteration order.

        Exact duplicate of the old `for other_guid, om in walls.items()` sequence,
        restricted to the buckets the index says can possibly match.
        """
        cell = index["cell"]
        span = int(math.floor(tol / cell)) + 1
        cx0, cy0 = int(math.floor(E[0] / cell)), int(math.floor(E[1] / cell))
        hit: set = set()
        endpoints = index["endpoints"]
        for dx in range(-span, span + 1):
            for dy in range(-span, span + 1):
                for g, _oe in endpoints.get((cx0 + dx, cy0 + dy), ()):
                    if g != guid:
                        hit.add(g)
        baselines = index["baselines"]
        for dx in range(-span, span + 1):
            for dy in range(-span, span + 1):
                for g in baselines.get((cx0 + dx, cy0 + dy), ()):
                    if g != guid:
                        hit.add(g)
        return [g for g in walls if g in hit]

    def _find_join_partner(self, guid, end_index, walls, index=None):
        """Finds the wall connected at this endpoint.
        Returns (partner_guid, kind, partner_end_index) where kind is
        'corner' (endpoint-to-endpoint) or 'tee' (endpoint on baseline), or None."""
        meta = self.element_meta[guid]
        E = (meta["start"][0], meta["start"][1]) if end_index == 0 else (meta["end"][0], meta["end"][1])

        if index is not None:
            candidates = self._join_candidates(index, walls, guid, E, self._JOIN_TOL)
        else:
            candidates = list(walls.keys())

        for other_guid in candidates:
            om = walls.get(other_guid)
            if om is None or other_guid == guid or "start" not in om or "end" not in om:
                continue
            osp, oep = om["start"], om["end"]
            ox, oy = osp[0], osp[1]
            oux, ouy = math.cos(om["angle"]), math.sin(om["angle"])
            olen = om["length"]

            # Corner: partner endpoint coincides with our endpoint
            for oe in (0, 1):
                P = (osp[0], osp[1]) if oe == 0 else (oep[0], oep[1])
                if math.hypot(P[0] - E[0], P[1] - E[1]) <= self._JOIN_TOL:
                    pol = self.join_policies.get(other_guid, {}).get(
                        f"end{oe}", {"allow_join": True, "mode": "butt"})
                    if pol.get("allow_join", True):
                        return other_guid, "corner", oe

            # Tee: our endpoint lies on the partner baseline (strictly inside)
            qx = (E[0] - ox) * oux + (E[1] - oy) * ouy
            qy = -(E[0] - ox) * ouy + (E[1] - oy) * oux
            if 0.01 < qx < olen - 0.01 and abs(qy) <= self._JOIN_TOL + om["thickness"] / 2.0:
                return other_guid, "tee", None
        return None, None, None

    def _partner_far_point(self, om, oe):
        """The partner's endpoint opposite the shared corner."""
        P = om["end"] if oe == 0 else om["start"]
        return (P[0], P[1])

    def recompute_wall_joins(self, only: Optional[List[str]] = None):
        """
        Recomputes trimmed footprint polygons for walls from baseline + thickness +
        join policies, and rebuilds 3D representations where the footprint changed.

        `only` restricts the pass to a subset (P3). A join is a *pairwise*
        relationship, so a subset must be widened by its join partners before the
        pass is correct — `DependencyGraph` does that widening and passes the
        result here. Without `only` this is the historical global pass.

        Why it matters: this used to be O(N) work with an O(N) partner search per
        wall (so O(N^2)) on *every* edit, which is what made the 2,000-element
        budget unreachable. Restricting the wall set makes a local edit cost
        local work; the partner search still scans `walls`, so the per-wall
        partner lookup is bounded by the subset rather than the model.
        """
        self.wall_joins_rev += 1
        all_walls = {
            g: m for g, m in self.element_meta.items()
            if m.get("ifc_class") == "IfcWallStandardCase" and "entity" in m
        }
        if only is not None:
            selected = set(only)
            walls = {g: m for g, m in all_walls.items() if g in selected}
        else:
            walls = all_walls
        # creation order for deterministic butt "through wall" decisions
        order = {g: i for i, g in enumerate(self.element_meta.keys())}

        # Candidate index built ONCE per pass. Note it is built over `all_walls`, not
        # the `only` subset: a selected wall's partner may be outside the subset even
        # though the subset was widened by the dependency graph, and the historical
        # behaviour scans every wall, so narrowing this would change results.
        join_index = self._build_join_index(all_walls)

        def _unit(dx, dy):
            n = math.hypot(dx, dy)
            return None if n < 1e-9 else (dx / n, dy / n)

        for guid, meta in walls.items():
            sp, ep = meta["start"], meta["end"]
            t = meta["thickness"]

            # --- pre-pass: resolve partners, and flag mitered ends ----------
            # A mitered end's footprint must be extended past its own endpoint
            # before clipping, because the joint plane can lie up to half the
            # PARTNER's thickness beyond it. Resolving partners here rather than in
            # the clip loop costs nothing: the old code searched once per end.
            resolved = {}
            ext = {0: 0.0, 1: 0.0}
            for end_index in (0, 1):
                policy = self.join_policies.get(guid, {}).get(
                    f"end{end_index}", {"allow_join": True, "mode": "butt"})
                if not policy.get("allow_join", True):
                    resolved[end_index] = None
                    continue
                # Search the full wall set: a subset pass must still see partners
                # that are not themselves being recomputed.
                partner_guid, kind, oe = self._find_join_partner(guid, end_index, all_walls, join_index)
                resolved[end_index] = (partner_guid, kind, oe, policy)
                if not partner_guid or kind != "corner":
                    continue
                om = all_walls[partner_guid]
                omode = self.join_policies.get(partner_guid, {}).get(
                    f"end{oe}", {"allow_join": True, "mode": "butt"}).get("mode", "butt")
                if policy.get("mode", "butt") != "miter" or omode != "miter":
                    continue
                E = (sp[0], sp[1]) if end_index == 0 else (ep[0], ep[1])
                far = self._wall_rect_end_probe(meta, end_index)
                uXf = self._partner_far_point(om, oe)
                uW = _unit(far[0] - E[0], far[1] - E[1])
                uX = _unit(uXf[0] - E[0], uXf[1] - E[1])
                if uW is None or uX is None:
                    continue
                dot = max(-1.0, min(1.0, uW[0] * uX[0] + uW[1] * uX[1]))
                angle_deg = math.degrees(math.acos(dot))
                if self._MITER_MIN_ANGLE <= angle_deg <= 180 - self._MITER_MIN_ANGLE:
                    sin_theta = math.sin(math.radians(angle_deg))
                    cos_theta = abs(dot)
                    if sin_theta > 1e-4:
                        ext[end_index] = (om["thickness"] / 2.0 + (t / 2.0) * cos_theta) / sin_theta + 0.05
                    else:
                        ext[end_index] = om["thickness"] / 2.0

            poly = self._wall_rect(meta, ext_start=ext[0], ext_end=ext[1])

            # --- clip pass --------------------------------------------------
            for end_index in (0, 1):
                info = resolved[end_index]
                if info is None:
                    continue
                partner_guid, kind, oe, policy = info
                if not partner_guid:
                    continue
                E = (sp[0], sp[1]) if end_index == 0 else (ep[0], ep[1])
                far = self._wall_rect_end_probe(meta, end_index)
                om = all_walls[partner_guid]

                if kind == "tee":
                    # Butt into the partner's face (square-off cut: our end
                    # stays square to our own wall).
                    poly = self._clip_to_partner_face(meta, poly, om, far, E, square_off=True)
                    continue

                # Corner join
                mode = policy.get("mode", "butt")
                omode = self.join_policies.get(partner_guid, {}).get(
                    f"end{oe}", {"allow_join": True, "mode": "butt"}).get("mode", "butt")

                if mode == "miter" and omode == "miter":
                    uXf = self._partner_far_point(om, oe)
                    uW = _unit(far[0] - E[0], far[1] - E[1])
                    uX = _unit(uXf[0] - E[0], uXf[1] - E[1])
                    angle_ok = False
                    if uW is not None and uX is not None:
                        dot = max(-1.0, min(1.0, uW[0] * uX[0] + uW[1] * uX[1]))
                        angle_deg = math.degrees(math.acos(dot))
                        angle_ok = (
                            self._MITER_MIN_ANGLE <= angle_deg <= 180 - self._MITER_MIN_ANGLE
                        )
                    if angle_ok:
                        # Joint line built from the walls' SIDE FACES, not from an
                        # angle bisector (Revit: MiterBySideFacesTargetData).
                        joint = self._miter_joint_line(
                            E, uW, t, uX, om["thickness"], far, uXf)
                        if joint is not None:
                            poly = self._clip_poly_line(poly, joint[0], joint[1], far)
                            continue
                        # Neither face pairing separated the two bodies; fall back.
                        bis = (uW[0] + uX[0], uW[1] + uX[1])
                        nb = math.hypot(bis[0], bis[1])
                        if nb > 1e-6:
                            poly = self._clip_poly_line(
                                poly, E, (bis[0] / nb, bis[1] / nb), far)
                            continue
                if mode == "square_off":
                    poly = self._clip_to_partner_face(meta, poly, om, far, E, square_off=True)
                    continue

                # Butt: earlier-created wall runs through; later wall butts.
                if order.get(guid, 0) < order.get(partner_guid, 0):
                    continue  # we are the through wall - no trim
                poly = self._clip_to_partner_face(meta, poly, om, far, E, square_off=False)

            # Store footprint; rebuild representation if it changed
            new_fp = [[round(x, 6), round(y, 6)] for x, y in poly]
            if meta.get("footprint") != new_fp:
                meta["footprint"] = new_fp
                self._rebuild_wall_representation(guid)
                self.mark_mesh_dirty(guid)
            else:
                self._refresh_wall_placement(guid)

    def _wall_rect_end_probe(self, meta, end_index):
        """Centerline point at the opposite end from the join endpoint."""
        sp, ep = meta["start"], meta["end"]
        P = sp if end_index == 1 else ep
        return (P[0], P[1])

    def _clip_to_partner_face(self, meta, poly, om, far, E, square_off=False):
        """Clips our polygon back to the partner wall's nearest face.
        square_off=False: cut follows the partner's face line (plain butt).
        square_off=True: cut is perpendicular to OUR baseline, through the
        point where our centerline crosses the partner's face (Revit
        'square-off' — the end remains square to its own wall)."""
        osp, oep = om["start"], om["end"]
        tX = om["thickness"]
        oux, ouy = math.cos(om["angle"]), math.sin(om["angle"])
        onx, ony = -ouy, oux

        # Partner's two face lines; pick the one nearer to our body (far end)
        cand = [
            ((osp[0] + onx * tX / 2.0, osp[1] + ony * tX / 2.0), (oux, ouy)),
            ((osp[0] - onx * tX / 2.0, osp[1] - ony * tX / 2.0), (oux, ouy)),
        ]
        face_p, face_d = min(
            cand, key=lambda c: math.hypot(c[0][0] - far[0], c[0][1] - far[1])
        )

        if not square_off:
            return self._clip_poly_line(poly, face_p, face_d, far)

        # Square-off: perpendicular to our own baseline through the
        # centerline/face intersection point.
        ux, uy = math.cos(meta["angle"]), math.sin(meta["angle"])
        Q = self._line_intersect(E, (ux, uy), face_p, (face_d[0], face_d[1]))
        if Q is None:
            return self._clip_poly_line(poly, face_p, face_d, far)
        return self._clip_poly_line(poly, Q, (-uy, ux), far)

    @staticmethod
    def _line_intersect(p1, d1, p2, d2):
        """Intersection of infinite lines p1+t*d1 and p2+s*d2, or None."""
        det = d1[0] * d2[1] - d1[1] * d2[0]
        if abs(det) < 1e-9:
            return None
        t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / det
        return (p1[0] + d1[0] * t, p1[1] + d1[1] * t)

    def _refresh_wall_placement(self, guid):
        """
        Writes the wall's own ObjectPlacement from its baseline.

        Children are deliberately NOT transformed here (`should_transform_children`
        stays at its default). `_reseat_hosted_openings` is the single authority for
        where a hosted opening sits: it writes each child's placement in the wall's
        LOCAL frame, which is the frame ifcopenshell already parents them in (the
        opening's `PlacementRelTo` is the wall's placement).

        Passing `should_transform_children=True` here was tried and is WRONG: that flag
        treats the children's current local values as world positions and adds the
        wall's motion to them, so it double-applies the move. Measured on a +30 ft wall
        move, the opening ended at local x = -7.62 -- exactly `1.524 - 9.144`, the
        reseat's correct local value (5 ft) minus the wall's displacement (30 ft).
        """
        meta = self.element_meta[guid]
        wall = meta.get("entity")
        if wall is None:
            return
        sp = meta["start"]
        ang = meta["angle"]
        matrix = np.identity(4)
        cos_a, sin_a = math.cos(ang), math.sin(ang)
        matrix[0, 0], matrix[0, 1] = cos_a, -sin_a
        matrix[1, 0], matrix[1, 1] = sin_a, cos_a
        # `sp` is decimal feet; the IFC is metric and `is_si=False` means the matrix
        # is already in file units (metres). Converting here is the units boundary.
        # Without it every wall placed away from the origin was out by 3.28x — the
        # cause of the mixed-unit meshes and of the x~98 anomaly in the drawing path.
        matrix[0, 3] = float(sp[0])
        matrix[1, 3] = float(sp[1])
        matrix[2, 3] = float(sp[2]) if len(sp) > 2 else 0.0
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=wall,
            matrix=self._placement_for_ifc(matrix), is_si=False,
        )

    def _invalidate_geometry_cache(self, *guids: str) -> None:
        """
        Drops cached tessellation for the given elements so it is rebuilt on demand.

        Necessary because openings are modelled as IFC voids: adding a door changes
        the HOST wall's solid, so the host's cached mesh must be discarded or it keeps
        showing the pre-void geometry.
        """
        for guid in guids:
            meta = self.element_meta.get(guid)
            if not meta:
                continue
            for key in ("cached_verts", "cached_faces"):
                meta.pop(key, None)

    def _rebuild_wall_representation(self, guid):
        """Rebuilds the wall's Body representation as an extruded arbitrary
        profile from its (possibly join-trimmed) footprint polygon."""
        meta = self.element_meta[guid]
        wall = meta.get("entity")
        if wall is None or not meta.get("footprint"):
            return
        sp = meta["start"]
        ang = meta["angle"]
        ca, sa = math.cos(ang), math.sin(ang)
        # world -> wall-local (rotate by -angle around the baseline start)
        local = [
            ((x - sp[0]) * ca + (y - sp[1]) * sa,
             -(x - sp[0]) * sa + (y - sp[1]) * ca)
            for x, y in meta["footprint"]
        ]
        profile = ifcopenshell.api.run(
            "profile.add_arbitrary_profile",
            self.model,
            profile=[[feet_to_metres(float(x)), feet_to_metres(float(y))] for x, y in local],
            name=f"Wall-Footprint-{guid}",
        )
        # Drop the wall's previous representation before assigning the new one.
        # Deliberately not `ifcopenshell.api.geometry.remove_representation`: that
        # usecase walks the representation graph's inverse attributes and
        # segfaults inside the C++ wrapper on a file that has been rebuilt
        # (reproducible here, and it takes the process down rather than raising).
        # Detaching the representation from the product and deleting it directly
        # leaves an unreferenced profile/solid behind, which is valid IFC and
        # cheap, and it cannot crash.
        self._detach_representations(wall)
        rep = ifcopenshell.api.run(
            "geometry.add_profile_representation",
            self.model,
            context=self.context_body,
            profile=profile,
            depth=feet_to_metres(float(meta["height"])),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=wall, representation=rep
        )
        meta["representation_entity"] = rep
        # Re-assert the placement from the (unchanged) baseline. Children are not
        # transformed here -- `_reseat_hosted_openings` owns them, in the wall's local
        # frame. See `_refresh_wall_placement` for why transforming them here is wrong.
        self._refresh_wall_placement(guid)

    def _detach_representations(self, product) -> int:
        """
        Removes a product's IfcProductDefinitionShape and its representations.

        Returns the number of representation items detached. Safe to call on a
        product with no representation, and safe during a bulk rebuild.
        """
        shape = getattr(product, "Representation", None)
        if shape is None:
            return 0
        removed = 0
        for representation in list(getattr(shape, "Representations", []) or []):
            try:
                self.model.remove(representation)
                removed += 1
            except Exception:
                pass
        try:
            self.model.remove(shape)
        except Exception:
            pass
        try:
            product.Representation = None
        except Exception:
            pass
        return removed

    # Name of the custom property set that used to hold the constraint graph.
    # README/spec §0.1 explicitly rejected this pset: property sets are static
    # data, so "persisting" constraints there never made them re-executable, and
    # a custom pset on IfcProject undermines the interop promise (hand model.ifc
    # to Revit/Bonsai). Constraints live in the overlay only (P2-E).
    LEGACY_CONSTRAINT_PSET = "Pset_ORLT_Constraints"

    def save_constraints_to_ifc(self):
        """
        Removed in P2. Constraints are overlay-only.

        Retained as a no-op so the existing call sites stay honest rather than
        silently disappearing: writing the constraint graph into the IFC is the
        rejected design, and `strip_legacy_constraint_pset()` actively removes any
        pset a previously saved container may still carry.
        """
        self.constraints_rev += 1
        return None

    def strip_legacy_constraint_pset(self) -> int:
        """
        Deletes any `Pset_ORLT_Constraints` from the model. Returns how many were
        removed. Applied before serializing so the container cannot keep shipping
        the pset after an upgrade from an older build.
        """
        removed = 0
        try:
            import ifcopenshell.api.pset  # noqa: F401  (kept for parity of imports)
            for pset in list(self.model.by_type("IfcPropertySet")):
                if getattr(pset, "Name", None) == self.LEGACY_CONSTRAINT_PSET:
                    try:
                        self.model.remove(pset)
                        removed += 1
                    except Exception:
                        pass
        except Exception as e:
            print(f"Notice stripping legacy constraint pset: {e}")
        return removed

    def load_constraints_from_ifc(self):
        """
        Removed in P2. Constraints are read from the overlay, never from IFC.

        Left as a no-op for callers that predate the overlay (and to make the
        deliberate absence visible in a search for the pset name).
        """
        return None

    # =========================================================================
    # 3D GEOMETRY EXTRACTION (Three.js Buffer Geometry Generation)
    # =========================================================================

    # Parametric fields that the shadow `element_meta` dict holds and that no
    # mesh/bbox can reconstruct. Serialized to the frontend so the store's
    # element record (and the AI planner) has real baselines and hosting info.
    ELEMENT_PARAM_FIELDS = (
        "ifc_class",
        "name",
        "type_id",
        "start",
        "end",
        "length",
        "height",
        "thickness",
        "angle",
        "level_id",
        "host_wall_guid",
        "offset_along_wall",
        "width",
        "sill_height",
        "swing_flipped",
        "elevation",
        "pitch",
        # Sketch geometry. Without this the overlay silently dropped slab/roof
        # polygons, so a reload could not rebuild them (found by the P2 round-trip
        # test, not by reading: the IFC carries the bbox rectangle, so the model
        # still "looked" fine while the polygon was gone).
        "polygon",
        "tag",
        "type_properties",
    )

    def _serialize_element_params(self, guid: str, meta: Dict[str, Any]) -> Dict[str, Any]:
        """Compact parametric record for one element (no live entity refs)."""
        record: Dict[str, Any] = {"guid": guid}
        for key in self.ELEMENT_PARAM_FIELDS:
            if key in meta and meta[key] is not None:
                record[key] = meta[key]
        record["hosted_openings"] = list(meta.get("hosted_openings", []))
        return record

    def _rebuild_element_from_overlay(self, guid: str, rec: Dict[str, Any]) -> bool:
        """
        Rebuilds a single element from its overlay record, preserving its GUID.

        Returns False when the record cannot be rebuilt (unknown class, missing
        host, malformed geometry) so the caller can report it instead of silently
        dropping the element.
        """
        ifc_class = rec.get("ifc_class")
        name = rec.get("name") or ifc_class or "Element"
        level_id = rec.get("level_id")
        type_id = rec.get("type_id")

        try:
            if ifc_class in ("IfcWallStandardCase", "IfcWall"):
                start = rec.get("start")
                end = rec.get("end")
                if not start or not end:
                    return False
                meta = self.add_wall(
                    start_pt=tuple(start), end_pt=tuple(end),
                    height=float(rec.get("height", FEET_10)),
                    thickness=float(rec.get("thickness", 0.2)),
                    level_id=level_id, name=name, guid=guid,
                    type_id=type_id,
                )

            elif ifc_class in ("IfcDoor", "IfcWindow"):
                host_guid = rec.get("host_wall_guid")
                if not host_guid or host_guid not in self.element_meta:
                    # The host is genuinely unknown (stale reference), not a crash.
                    return False
                if ifc_class == "IfcDoor":
                    meta = self.add_door(
                        host_wall_guid=host_guid,
                        offset_along_wall=float(rec.get("offset_along_wall", 0.0)),
                        width=float(rec.get("width", 0.95)),
                        height=float(rec.get("height", DOOR_HEIGHT_84)),
                        name=name,
                        swing_flipped=bool(rec.get("swing_flipped", False)),
                        guid=guid,
                        type_id=type_id,
                    )
                else:
                    meta = self.add_window(
                        host_wall_guid=host_guid,
                        offset_along_wall=float(rec.get("offset_along_wall", 0.0)),
                        width=float(rec.get("width", 1.2)),
                        height=float(rec.get("height", WINDOW_HEIGHT_48)),
                        sill_height=float(rec.get("sill_height", WINDOW_SILL_36)),
                        name=name, guid=guid,
                        type_id=type_id,
                    )

            elif ifc_class == "IfcSlab":
                polygon = rec.get("polygon")
                if not polygon:
                    return False
                meta = self.add_slab(
                    polygon_pts=[tuple(p) for p in polygon],
                    thickness=float(rec.get("thickness", 0.25)),
                    elevation=float(rec.get("elevation", 0.0)),
                    level_id=level_id, name=name, guid=guid,
                )

            elif ifc_class == "IfcRoof":
                polygon = rec.get("polygon")
                if not polygon:
                    return False
                roof_sketch = None
                if rec.get("sketch"):
                    from sketch_model import Sketch

                    roof_sketch = Sketch.from_dict(rec["sketch"])
                meta = self.add_roof(
                    polygon_pts=[tuple(p) for p in polygon],
                    thickness=float(rec.get("thickness", 0.3)),
                    elevation=float(rec.get("elevation", 6.0)),
                    pitch_degrees=float(rec.get("pitch", 15.0)),
                    level_id=level_id, name=name, guid=guid,
                    sketch=roof_sketch,
                )
                if roof_sketch is not None:
                    self._regenerate_sketch_geometry(guid)

            elif ifc_class == "IfcGrid":
                start = rec.get("start")
                end = rec.get("end")
                if not start or not end:
                    return False
                meta = self.add_grid(
                    axis_name=str(rec.get("tag") or name),
                    start_pt=(start[0], start[1]),
                    end_pt=(end[0], end[1]),
                    guid=guid,
                )

            else:
                return False
        except Exception as e:
            print(f"Notice: could not rebuild element {guid} ({ifc_class}): {e}")
            return False

        # Restore the non-geometric payload the builders do not take.
        if rec.get("type_properties"):
            meta.setdefault("type_properties", {}).update(rec["type_properties"])

        # Restore references from overlay (Phase 1.3)
        if rec.get("refs") and isinstance(rec["refs"], list):
            from references import ReferenceKind, normalize_reference
            valid_refs = []
            dropped_count = 0
            for r in rec["refs"]:
                if isinstance(r, dict) and r.get("kind") in ReferenceKind:
                    valid_refs.append(normalize_reference(r))
                else:
                    dropped_count += 1
            if dropped_count > 0:
                print(f"Notice: dropped {dropped_count} unknown or invalid reference(s) for element {guid}")
            if valid_refs:
                meta["refs"] = valid_refs
        return True

    def rebuild_from_overlay(self, overlay: Dict[str, Any]) -> Dict[str, Any]:
        """
        Rebuilds `element_meta`, join policies and constraints from the overlay.

        P2 (the decisive change): the overlay is authoritative. Geometry is
        regenerated through the normal builders rather than inferred from the
        tessellated IFC that happened to be in the container, which is what made
        diagonal walls snap to 0°/90° and slab polygons degrade to rectangles.

        The IFC is *not* trusted as the parametric source, but it is still used to
        detect staleness: an overlay record whose GUID is absent from the saved
        IFC is reported as `stale` and skipped (spec §3.1 — flagged, never
        silently applied). Records present in the IFC but absent from the overlay
        are reported as `unparametrized`.
        """
        reported_ifc_guids = set(overlay.get("_ifc_guids", []))
        elements = overlay.get("elements", {}) or {}
        report: Dict[str, Any] = {
            "rebuilt": [],
            "stale": [],           # in overlay, absent from the saved IFC
            "unparametrized": [],  # in the saved IFC, absent from the overlay
            "failed": [],          # present but could not be reconstructed
            "schema_version": overlay.get("schema_version"),
        }

        self.element_meta = {}
        self.join_policies = {}
        self.constraints = self._jsonable(overlay.get("constraints", {}) or {})

        # Restore types from overlay if present
        if overlay.get("types"):
            for t in overlay["types"]:
                tid = t.get("id")
                if tid:
                    self._register_type_entity(tid, t.get("name", tid), t.get("ifc_class", "IfcWallType"), t.get("parameters", {}))

        # Levels: keep whatever the IFC import produced (storeys are structural)
        # but adopt overlay names/elevations where they exist.
        for lv in overlay.get("levels", []) or []:
            lid = lv.get("id")
            if lid and lid in self.levels:
                self.levels[lid]["name"] = lv.get("name", self.levels[lid]["name"])
                if lv.get("elevation") is not None:
                    self.levels[lid]["elevation"] = lv["elevation"]

        # Rebuild order matters: hosts before hosted, walls before join recompute.
        order = {
            "IfcWallStandardCase": 0, "IfcWall": 0,
            "IfcGrid": 1,
            "IfcDoor": 2, "IfcWindow": 2,
            "IfcSlab": 3, "IfcRoof": 3,
        }
        ordered = sorted(
            elements.items(),
            key=lambda kv: order.get((kv[1] or {}).get("ifc_class"), 4),
        )

        # Joins are recomputed once, after the whole model exists: per-wall
        # recomputation during the replay is both premature (partners are not
        # there yet) and segfault-prone inside ifcopenshell.
        self._suppress_join_recompute = True
        try:
            for guid, rec in ordered:
                if not isinstance(rec, dict):
                    continue
                if reported_ifc_guids and guid not in reported_ifc_guids:
                    report["stale"].append({
                        "guid": guid,
                        "ifc_class": rec.get("ifc_class"),
                        "name": rec.get("name"),
                        "reason": "GUID not present in the container's model.ifc",
                    })
                    continue
                if self._rebuild_element_from_overlay(guid, rec):
                    report["rebuilt"].append(guid)
                else:
                    report["failed"].append({
                        "guid": guid,
                        "ifc_class": rec.get("ifc_class"),
                        "name": rec.get("name"),
                    })
        finally:
            self._suppress_join_recompute = False

        # Join policies from the overlay, then recompute geometry from baselines.
        self.join_policies = self._jsonable(overlay.get("join_policies", {}) or {})
        for guid in list(self.join_policies.keys()):
            if guid not in self.element_meta:
                self.join_policies.pop(guid, None)
        try:
            self.recompute_wall_joins()
        except Exception as e:
            print(f"Notice: join recompute after overlay rebuild failed: {e}")

        # Sheets and Views from the overlay (P6 / SPECIFICATION-v0.2.md §13)
        if "sheets" in overlay and isinstance(overlay["sheets"], (list, dict)):
            raw_sheets = overlay["sheets"]
            self.sheets = {}
            if isinstance(raw_sheets, list):
                for s in raw_sheets:
                    sid = s.get("id") or f"sheet-{uuid.uuid4().hex[:8]}"
                    self.sheets[sid] = copy.deepcopy(s)
            elif isinstance(raw_sheets, dict):
                self.sheets = copy.deepcopy(raw_sheets)

        if "views" in overlay and isinstance(overlay["views"], (list, dict)):
            raw_views = overlay["views"]
            self.views = {}
            if isinstance(raw_views, list):
                for v in raw_views:
                    vid = v.get("id") or f"view-{uuid.uuid4().hex[:8]}"
                    self.views[vid] = copy.deepcopy(v)
            elif isinstance(raw_views, dict):
                self.views = copy.deepcopy(raw_views)

        if "dimensions" in overlay and isinstance(overlay["dimensions"], (list, dict)):
            raw_dims = overlay["dimensions"]
            self.dimensions = {}
            if isinstance(raw_dims, list):
                for d in raw_dims:
                    did = d.get("id") or f"dim_{uuid.uuid4().hex[:8]}"
                    d_copy = copy.deepcopy(d)
                    if "ref_a" in d_copy:
                        d_copy["ref_a"] = normalize_reference(d_copy["ref_a"])
                    if "ref_b" in d_copy:
                        d_copy["ref_b"] = normalize_reference(d_copy["ref_b"])
                    if "refs" in d_copy and isinstance(d_copy["refs"], list):
                        d_copy["refs"] = [normalize_reference(r) for r in d_copy["refs"]]
                    self.dimensions[did] = d_copy
            elif isinstance(raw_dims, dict):
                for did, d in raw_dims.items():
                    d_copy = copy.deepcopy(d)
                    if "ref_a" in d_copy:
                        d_copy["ref_a"] = normalize_reference(d_copy["ref_a"])
                    if "ref_b" in d_copy:
                        d_copy["ref_b"] = normalize_reference(d_copy["ref_b"])
                    if "refs" in d_copy and isinstance(d_copy["refs"], list):
                        d_copy["refs"] = [normalize_reference(r) for r in d_copy["refs"]]
                    self.dimensions[did] = d_copy

        if reported_ifc_guids:
            overlay_guids = set(elements.keys())
            report["unparametrized"] = sorted(reported_ifc_guids - overlay_guids - set(report["rebuilt"]))

        report["elements_count"] = len(self.element_meta)
        return report

    @staticmethod
    def _get_product_shape(settings, p):
        """
        Creates geometric shape for an IFC product, ensuring 3D 'Body' representation is selected
        when multiple representations (like 'Axis' + 'Body' in Revit walls) exist.
        """
        rep = None
        if hasattr(p, "Representation") and p.Representation and hasattr(p.Representation, "Representations"):
            reps = p.Representation.Representations
            for r in reps:
                ident = (getattr(r, "RepresentationIdentifier", "") or "").lower()
                if ident in ("body", "facetation", "brep", "surface", "model"):
                    rep = r
                    break
            if rep is None:
                for r in reps:
                    rtype = (getattr(r, "RepresentationType", "") or "").lower()
                    if rtype in ("sweptsolid", "brep", "csg", "clipping", "advancedsweptsolid", "surface"):
                        rep = r
                        break
        if rep is not None:
            return ifcopenshell.geom.create_shape(settings, p, rep)
        return ifcopenshell.geom.create_shape(settings, p)

    #: Endpoint-proximity radius (feet) for finding the walls an edit can re-join.
    #: Must exceed the largest join tolerance, which is `_JOIN_TOL + thickness/2` for a
    #: tee (0.05 + ~0.35 for an 8" CMU wall), so 1 ft is comfortably conservative.
    _JOIN_EDIT_RADIUS = 1.0

    def _recompute_after_joined_edit(self, guid: Optional[str] = None,
                                     old_points: Optional[List[Tuple[float, float]]] = None,
                                     new_points: Optional[List[Tuple[float, float]]] = None) -> None:
        """
        Recompute joins for the walls an edit can affect, not the whole model.

        An edit both GAINS and LOSES joins: moving a wall end away from a partner drops
        a tee, and moving it onto one creates a tee. The correct radius is therefore
        every wall with an endpoint near the wall's OLD or NEW baseline ends — the old
        positions are passed in because the metadata has already been mutated by the
        time this runs, and a graph rebuilt from current state cannot see the join that
        just disappeared (its partner would keep a stale footprint permanently).

        Falls back to the global pass whenever the radius cannot be established, because
        a wrong subset leaves stale join geometry, which is worse than a slow edit.
        """
        if guid is None or guid not in self.element_meta:
            self.recompute_wall_joins()
            return
        # The caller must supply the pre-edit ends: a graph rebuilt from current state
        # cannot see a join the edit just removed. Without them the radius is unsound,
        # so take the slow-but-correct path.
        if not old_points:
            self.recompute_wall_joins()
            return

        points: List[Tuple[float, float]] = []
        for p in list(old_points) + list(new_points or []):
            if p:
                points.append((float(p[0]), float(p[1])))
        if not points:
            self.recompute_wall_joins()
            return

        try:
            all_walls = {
                g: m for g, m in self.element_meta.items()
                if m.get("ifc_class") in ("IfcWall", "IfcWallStandardCase")
                and "start" in m and "end" in m
            }
            index = self._build_join_index(all_walls)
            affected: set = {guid}
            for px, py in points:
                for other in self._join_candidates(index, all_walls, guid, (px, py),
                                                   self._JOIN_EDIT_RADIUS):
                    affected.add(other)
        except Exception:
            self.recompute_wall_joins()
            return

        affected = {
            g for g in affected
            if g in self.element_meta
            and self.element_meta[g].get("ifc_class") in ("IfcWall", "IfcWallStandardCase")
        }
        if not affected:
            self.recompute_wall_joins()
            return
        self.recompute_wall_joins(only=sorted(affected))

    def _cache_verts(self, guid: str, verts, faces, in_feet: bool = True) -> None:
        """
        Stores a tessellation in `element_meta`, ALWAYS in the file's unit (metres).

        Every writer goes through here so the cache has exactly one unit. The mesh
        builders (`_build_wall_mesh`, `_build_flat_slab_mesh`, `_build_pitched_roof_mesh`,
        `build_roof_mesh`) author in decimal feet because that is the internal unit;
        `_get_product_shape` returns the file's unit. Both are normalised here.

        This exists because the ambiguity was not theoretical. With the cache holding
        whichever unit the writer happened to use:
          * `_build_element_mesh` emitted metres while `params` were feet, so the mesh
            and the parametric record disagreed by 3.28084 and the app's dimension read
            9'-2" for a 30 ft spacing;
          * caching a *converted* value made the conversion self-amplifying — one 30 ft
            wall returned 30, 98.425, 322.92, 1059.44 on four successive calls;
          * feeding the feet buffers to `mesh_hlr` (which is given `cut_z` in metres)
            put every cut path out by 3.28084 and made door openings disappear.
        """
        meta = self.element_meta.get(guid)
        if meta is None or not verts:
            return
        if in_feet:
            # Builder geometry is decimal FEET (the internal unit), and the cache is
            # kept in METRES (the file's unit). Two different factors are easy to
            # confuse here and the first attempt did: `_metres_per_unit()` is metres
            # per FILE unit (1.0 for a metres model), whereas converting geometry that
            # was authored in feet needs `METRES_PER_FOOT` (0.3048). Using the former
            # left the cache in feet, so a 12 ft slab came back as 39.37 ft once the
            # output boundary multiplied by 3.28084.
            verts = [v * METRES_PER_FOOT for v in verts]
        meta["cached_verts"] = verts
        meta["cached_faces"] = faces
        meta["cached_verts_is_feet"] = False
        meta["geom_rev"] = meta.get("geom_rev", 0) + 1

    def _meshes_for_projection(self) -> List[Dict[str, Any]]:
        """
        Geometry buffers for the HLR projector, in the FILE's unit — not feet.

        `mesh_hlr` is unit-agnostic: it projects whatever coordinates it is handed.
        The projection pipeline hands it `cut_z=feet_to_metres(...)`, so its input must
        be metric, and its output is then scaled to feet by `_scale_path`. Feeding it
        the feet buffers that `get_geometry_buffers()` returns put every cut path out
        by 3.28084 — measured as a 30 ft wall drawing cut segments out to 98.43, and as
        a door opening that no longer appeared because the cut plane passed through
        nothing.

        So both consumers read the one cache: `get_geometry_buffers()` for the client,
        this for the projector. The cache itself is always in the file's unit.
        """
        settings = ifcopenshell.geom.settings()
        settings.set(settings.USE_WORLD_COORDS, True)
        meshes: List[Dict[str, Any]] = []
        for guid, meta in self.element_meta.items():
            entity = meta.get("entity")
            if not entity:
                continue
            cached_v = meta.get("cached_verts")
            cached_f = meta.get("cached_faces")
            if cached_v and cached_f:
                verts, faces = cached_v, cached_f
            else:
                try:
                    shape = self._get_product_shape(settings, entity)
                    verts = list(shape.geometry.verts)
                    faces = list(shape.geometry.faces)
                    meta["cached_verts"] = verts
                    meta["cached_faces"] = faces
                except Exception:
                    continue
            # A builder-authored cache (`_build_wall_mesh` and friends) is written in
            # decimal feet, so it must be normalised back to the file's unit; every
            # other source is already in it.
            if meta.get("cached_verts_is_feet") and verts:
                metres_per_unit = self._metres_per_unit()
                verts = [v * metres_per_unit for v in verts]
            meshes.append({
                "guid": guid,
                "ifc_class": meta.get("ifc_class", "IfcProduct"),
                "name": meta.get("name"),
                "vertices": verts,
                "indices": faces,
                "geom_rev": meta.get("geom_rev", 0),
            })
        return meshes

    def _metres_per_unit(self) -> float:
        """
        Metres per length unit of the model of record, cached per model identity.

        This is the one place the mesh boundary asks the file what its own unit is, so
        a metric IFC, an imperial IFC and a feet-authored builder all convert
        correctly without any caller knowing which it holds. Cached because
        `_build_element_mesh` runs once per element and `calculate_unit_scale` walks
        the unit assignment each time.

        Falls back to METRES_PER_FOOT — i.e. "already feet, do not convert" — rather
        than 1.0, so a failure here degrades to leaving builder-authored feet geometry
        untouched instead of multiplying it by 3.28084.
        """
        model = getattr(self, "model", None)
        if model is None:
            return METRES_PER_FOOT
        cached = getattr(self, "_metres_per_unit_cache", None)
        if cached is not None and cached[0] is model:
            return cached[1]
        try:
            import ifcopenshell.util.unit as unit_util
            scale = unit_util.calculate_unit_scale(model)
        except Exception:
            scale = None
        if not scale or scale <= 0.0:
            scale = METRES_PER_FOOT
        self._metres_per_unit_cache = (model, float(scale))
        return float(scale)

    def _build_element_mesh(self, guid: str, meta: Dict[str, Any], settings=None) -> Optional[Dict[str, Any]]:
        entity = meta.get("entity")
        if not entity:
            return None
        ifc_class = meta.get("ifc_class", "IfcProduct")

        category_colors = {
            "IfcWallStandardCase": {"color": "#e2e8f0", "opacity": 1.0, "cut_color": "#475569"},
            "IfcWall": {"color": "#e2e8f0", "opacity": 1.0, "cut_color": "#475569"},
            "IfcDoor": {"color": "#c2410c", "opacity": 1.0, "cut_color": "#9a3412"},
            "IfcWindow": {"color": "#38bdf8", "opacity": 0.55, "cut_color": "#0284c7"},
            "IfcSlab": {"color": "#cbd5e1", "opacity": 1.0, "cut_color": "#64748b"},
            "IfcRoof": {"color": "#94a3b8", "opacity": 1.0, "cut_color": "#475569"},
            "IfcColumn": {"color": "#cbd5e1", "opacity": 1.0, "cut_color": "#334155"},
            "IfcBeam": {"color": "#94a3b8", "opacity": 1.0, "cut_color": "#334155"},
            "IfcStair": {"color": "#d1d5db", "opacity": 1.0, "cut_color": "#4b5563"},
            "IfcRailing": {"color": "#9ca3af", "opacity": 0.9, "cut_color": "#374151"},
            "IfcCovering": {"color": "#e5e7eb", "opacity": 1.0, "cut_color": "#6b7280"},
            "IfcCurtainWall": {"color": "#bae6fd", "opacity": 0.6, "cut_color": "#0284c7"},
            "IfcPlate": {"color": "#93c5fd", "opacity": 0.7, "cut_color": "#1d4ed8"},
            "IfcMember": {"color": "#cbd5e1", "opacity": 1.0, "cut_color": "#475569"},
            "IfcFurnishingElement": {"color": "#fbbf24", "opacity": 1.0, "cut_color": "#d97706"},
            "IfcBuildingElementProxy": {"color": "#a8a29e", "opacity": 1.0, "cut_color": "#57534e"},
        }

        if settings is None:
            settings = ifcopenshell.geom.settings()
            settings.set(settings.USE_WORLD_COORDS, True)

        try:
            cached_v = meta.get("cached_verts")
            cached_f = meta.get("cached_faces")
            if cached_v and cached_f:
                raw_verts = cached_v
                raw_faces = cached_f
            else:
                shape = self._get_product_shape(settings, entity)
                geom = shape.geometry
                raw_verts = list(geom.verts)
                raw_faces = list(geom.faces)
                meta["cached_verts"] = raw_verts
                meta["cached_faces"] = raw_faces

            style = category_colors.get(ifc_class, {"color": "#94a3b8", "opacity": 1.0, "cut_color": "#334155"})

            # ------------------------------------------------------------------
            # THE UNITS BOUNDARY FOR MESH GEOMETRY (spec §11.3).
            #
            # `_get_product_shape` returns a world-coordinate shape in the IFC's own
            # unit, and the model of record is authored in METRES (see `reset_model`).
            # Every parametric length — `meta["length"]`, `thickness`, `height`,
            # elevations, command parameters — is decimal FEET. This method is the
            # boundary, so what it RETURNS is feet.
            #
            # The cache stays in the file's unit and is the single source both consumers
            # read: this method converts metres -> feet on output, and
            # `_meshes_for_projection()` hands the projection pipeline the same raw
            # cache untouched, because `mesh_hlr` works in the file's unit (it is given
            # `cut_z=feet_to_metres(...)`).
            #
            # Getting this wrong is not cosmetic, and two specific failures were
            # measured while implementing it:
            #   * emitting metres here left the mesh and the parametric record
            #     disagreeing by 3.28084, so the app's one editable dimension showed
            #     9'-2" for a real 30 ft spacing and could not round-trip;
            #   * caching the *converted* value and re-converting on each read
            #     self-amplified — one 30 ft wall returned x = 30, 98.425, 322.92,
            #     1059.44 on four successive calls. The cache therefore must never hold
            #     a converted value.
            metres_per_unit = self._metres_per_unit()
            file_scale = metres_per_unit / METRES_PER_FOOT
            if raw_verts and file_scale != 1.0:
                raw_verts = [v * file_scale for v in raw_verts]

            # The bounds are ALWAYS derived from the vertices just converted, never
            # read from a cached `meta["bbox"]` — the cache was written in different
            # units by different paths, and trusting it is how the two halves of a
            # record drift apart. The bounds are in feet, like the frontend expects.
            xs = raw_verts[0::3]
            ys = raw_verts[1::3]
            zs = raw_verts[2::3]
            bbox = {
                "min": [min(xs), min(ys), min(zs)],
                "max": [max(xs), max(ys), max(zs)],
            }
            meta["bbox"] = bbox

            return {
                "guid": guid,
                "ifc_class": ifc_class,
                "name": meta.get("name", ifc_class),
                "vertices": raw_verts,
                "indices": raw_faces,
                "color": style["color"],
                "cut_color": style["cut_color"],
                "opacity": style["opacity"],
                "bbox": bbox,
                "params": self._serialize_element_params(guid, meta),
            }
        except Exception:
            return None

    def get_geometry_buffers(self, since: Optional[int] = None) -> Dict[str, Any]:
        """
        Extracts 3D triangulated meshes from active IFC entities using IfcGeom.
        Returns vertices, face indices, normals, colors, and bounding boxes ready for Three.js.
        If `since` is specified (monotonic rev), returns delta {upsert_meshes, remove_guids}.
        """
        settings = ifcopenshell.geom.settings()
        settings.set(settings.USE_WORLD_COORDS, True)

        levels_data = [
            {"id": l["id"], "name": l["name"], "elevation": l["elevation"]}
            for l in self.levels.values()
        ]
        grids_data = [
            {
                "guid": m["guid"],
                "name": m["name"],
                "tag": m["tag"],
                "start": m["start"],
                "end": m["end"],
            }
            for m in self.element_meta.values()
            if m.get("ifc_class") == "IfcGrid"
        ]

        if since is not None:
            upsert_meshes = []
            for guid, meta in self.element_meta.items():
                if self.mesh_revs.get(guid, 0) > since or guid in self.dirty_mesh_guids:
                    m = self._build_element_mesh(guid, meta, settings)
                    if m is not None:
                        upsert_meshes.append(m)
            remove_guids = []
            for rev, guids in self.removed_guids_by_rev.items():
                if rev > since:
                    remove_guids.extend(guids)
            remove_items = []
            for rev, items in getattr(self, "removed_items_by_rev", {}).items():
                if rev > since:
                    remove_items.extend(items)
            return {
                "upsert_meshes": upsert_meshes,
                "remove_guids": sorted(set(remove_guids)),
                "removed_items": remove_items,
                "levels": levels_data,
                "grids": grids_data,
            }

        meshes = []
        for guid, meta in self.element_meta.items():
            m = self._build_element_mesh(guid, meta, settings)
            if m is not None:
                meshes.append(m)

        return {
            "meshes": meshes,
            "levels": levels_data,
            "grids": grids_data,
        }

    # =========================================================================
    # 2D VECTOR SLICING & HIDDEN LINE REMOVAL (HLR) PIPELINE
    # =========================================================================

    def slice_2d_vector_plan(
        self, cut_elevation: float = FEET_4, renderer: str = "mesh-hlr",
        level_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Produces the 2D plan as vector paths in the frontend's existing contract.

        Two renderers are available and the choice is explicit:

        * `"analytic"` (default) intersects stored metadata with the cut plane. Its
          coordinates are exact model feet, which is what the viewport draws
          annotations against, but it cannot produce hidden lines.
        * `"hlr"` drives OCCT hidden-line removal through ifcopenshell's SVG
          serializer and reads its cut/projection partitions. The partitioning is
          genuine, but on the ifcopenshell build in use the serializer places its
          drawing plane in a frame that could not be reliably mapped back to model
          coordinates (see `hlr_renderer` for the measurements), so it is opt-in and
          unverified rather than the default.

        Annotation that has no B-rep — grid lines, dimension strings, swing arcs,
        slab/roof references — is read from metadata in both renderers, because
        those are datums and drawings rather than geometry.
        """
        if renderer == "mesh-hlr":
            try:
                contract = self._mesh_hlr_plan_contract(cut_elevation, level_id=level_id)
                if contract is not None:
                    return self._finish_plan_contract(contract, cut_elevation)
            except Exception as e:
                print(f"Notice: mesh HLR unavailable ({e}); trying the SVG serialiser")
        if renderer in ("mesh-hlr", "hlr"):
            try:
                contract = self._hlr_plan_contract(cut_elevation)
                if contract is not None:
                    # Annotation drives are merged in below, from metadata.
                    return self._finish_plan_contract(contract, cut_elevation)
            except Exception as e:
                print(f"Notice: HLR renderer unavailable ({e}); using the analytic slicer")

        svg_cut_paths = []
        svg_projection_paths = []
        svg_swing_paths = []
        dimensions_list = []

        # Process walls
        for guid, meta in self.element_meta.items():
            if meta.get("ifc_class") in ("IfcWall", "IfcWallStandardCase"):
                sp = meta["start"]
                ep = meta["end"]
                th = meta["thickness"]
                length = meta["length"]
                ang = meta["angle"]
                wall_h = meta.get("height", FEET_10)

                # Revit View Range Rule (Spec §1.6 & §4.1):
                # Walls shorter than 6 ft are NOT cut, even if intersecting the cut plane;
                # they render in projection style without hatch poché.
                is_wall_cut = wall_h >= FEET_6
                wall_class = "IfcWall cut" if is_wall_cut else "IfcWall projection"
                wall_fill = "url(#hatch-concrete)" if is_wall_cut else "none"
                target_paths = svg_cut_paths if is_wall_cut else svg_projection_paths

                # 2D offset normal vector
                nx = -math.sin(ang) * (th / 2.0)
                ny = math.cos(ang) * (th / 2.0)
                ux, uy = math.cos(ang), math.sin(ang)

                # Join-trimmed footprint when available (GLM Spec §3.3 Phase A);
                # falls back to the plain rectangle for legacy/external data.
                footprint = meta.get("footprint") or self._wall_rect(meta)
                footprint = [(float(p[0]), float(p[1])) for p in footprint]

                # Check if wall has openings
                openings = meta.get("hosted_openings", [])
                if not openings:
                    d = "M " + " L ".join(f"{p[0]:.3f} {p[1]:.3f}" for p in footprint) + " Z"
                    target_paths.append({
                        "guid": guid,
                        "class": wall_class,
                        "d": d,
                        "fill": wall_fill,
                    })
                else:
                    # Segment wall around openings by clipping the (possibly
                    # join-trimmed) footprint with each opening's perpendicular
                    # band lines — preserves mitered/butted corner cuts.
                    banded = []
                    for op_id in openings:
                        om = self.element_meta.get(op_id)
                        if not om:
                            continue
                        offset = om.get("offset_along_wall", 0.0)
                        w = om.get("width", 0.90)
                        if w <= 0.05 or offset < 0:
                            continue
                        s0 = max(0.0, min(length, offset))
                        s1 = max(0.0, min(length, offset + w))
                        if s1 - s0 < 0.08:
                            continue
                        banded.append((s0, s1, om.get("ifc_class", "IfcDoor"), op_id, om))
                    banded.sort(key=lambda x: x[0])

                    pieces = [footprint]
                    for s0, s1, op_type, op_id, op_meta in banded:
                        nxt = []
                        for piece in pieces:
                            p_left = self._clip_poly_s(piece, sp, (ux, uy), s_max=s0)
                            if len(p_left) >= 3:
                                nxt.append(p_left)
                            p_right = self._clip_poly_s(piece, sp, (ux, uy), s_min=s1)
                            if len(p_right) >= 3:
                                nxt.append(p_right)
                        pieces = nxt
                    for piece in pieces:
                        if len(piece) < 3:
                            continue
                        d = "M " + " L ".join(f"{p[0]:.3f} {p[1]:.3f}" for p in piece) + " Z"
                        target_paths.append({
                            "guid": guid,
                            "class": wall_class,
                            "d": d,
                            "fill": wall_fill,
                        })

                    for s0, s1, op_type, op_id, op_meta in banded:
                        offset, w = s0, s1 - s0

                        # Door / Window representation in plan
                        op_pt = (sp[0] + math.cos(ang) * offset, sp[1] + math.sin(ang) * offset)
                        op_end_pt = (sp[0] + math.cos(ang) * (offset + w), sp[1] + math.sin(ang) * (offset + w))

                        if op_type == "IfcDoor":
                            # Door jambs / opening projection lines
                            svg_projection_paths.append({
                                "guid": op_id,
                                "class": "IfcDoor projection",
                                "d": f"M {op_pt[0] + nx:.3f} {op_pt[1] + ny:.3f} L {op_pt[0] - nx:.3f} {op_pt[1] - ny:.3f}",
                            })
                            svg_projection_paths.append({
                                "guid": op_id,
                                "class": "IfcDoor projection",
                                "d": f"M {op_end_pt[0] + nx:.3f} {op_end_pt[1] + ny:.3f} L {op_end_pt[0] - nx:.3f} {op_end_pt[1] - ny:.3f}",
                            })

                            door_name = (op_meta.get("name") or "").lower()
                            is_sliding = "slide" in door_name or "pocket" in door_name or "closet" in door_name
                            is_overhead = "garage" in door_name or "overhead" in door_name or w > FEET_8

                            if is_sliding or is_overhead:
                                # Sliding / Pocket / Overhead door: drawn along wall opening centerline
                                svg_projection_paths.append({
                                    "guid": op_id,
                                    "class": "IfcDoor sliding-panel",
                                    "d": f"M {op_pt[0]:.3f} {op_pt[1]:.3f} L {op_end_pt[0]:.3f} {op_end_pt[1]:.3f}",
                                })
                            else:
                                # Standard swinging door: 90-degree swing arc + door panel
                                swing_flip = op_meta.get("swing_flipped", False)
                                swing_sign = -1.0 if swing_flip else 1.0
                                panel_end = (
                                    op_pt[0] - math.sin(ang) * w * swing_sign,
                                    op_pt[1] + math.cos(ang) * w * swing_sign,
                                )
                                svg_swing_paths.append({
                                    "guid": op_id,
                                    "class": "IfcDoor swing-panel",
                                    "d": f"M {op_pt[0]:.3f} {op_pt[1]:.3f} L {panel_end[0]:.3f} {panel_end[1]:.3f}",
                                })
                                sweep = 0 if swing_flip else 1
                                svg_swing_paths.append({
                                    "guid": op_id,
                                    "class": "IfcDoor swing",
                                    "d": f"M {panel_end[0]:.3f} {panel_end[1]:.3f} A {w:.3f} {w:.3f} 0 0 {sweep} {op_end_pt[0]:.3f} {op_end_pt[1]:.3f}",
                                })
                        elif op_type == "IfcWindow":
                            # Window sill projection and glass center lines
                            svg_projection_paths.append({
                                "guid": op_id,
                                "class": "IfcWindow projection",
                                "d": f"M {op_pt[0] + nx:.3f} {op_pt[1] + ny:.3f} L {op_end_pt[0] + nx:.3f} {op_end_pt[1] + ny:.3f}",
                            })
                            svg_projection_paths.append({
                                "guid": op_id,
                                "class": "IfcWindow projection",
                                "d": f"M {op_pt[0] - nx:.3f} {op_pt[1] - ny:.3f} L {op_end_pt[0] - nx:.3f} {op_end_pt[1] - ny:.3f}",
                            })
                            # Glass centerline
                            svg_projection_paths.append({
                                "guid": op_id,
                                "class": "IfcWindow glass",
                                "d": f"M {op_pt[0]:.3f} {op_pt[1]:.3f} L {op_end_pt[0]:.3f} {op_end_pt[1]:.3f}",
                            })

                # Aligned dimensions along wall (only for significant walls to avoid clumping)
                if length >= 1.0:
                    dimensions_list.append({
                        "guid": guid,
                        "start": sp[:2],
                        "end": ep[:2],
                        "length": length,
                        # `length` is decimal feet (see the units boundary). This
                        # previously read `f"{length:.2f} m ({length * 3.28084:.1f}')"`,
                        # which labelled feet as metres AND multiplied by 3.28084, so a
                        # 30 ft wall drew as "30.00 m (98.4')". Every other length on
                        # the drawing already goes through `format_feet_inches`.
                        "text": format_feet_inches(length),
                        "offset_norm": [nx, ny],
                    })

        # Deduplicate overlapping parallel dimensions (Revit clean-drawing rule)
        deduped_dims = []
        for d in dimensions_list:
            dsp = d["start"]
            dep = d["end"]
            ddx = dep[0] - dsp[0]
            ddy = dep[1] - dsp[1]
            dlen = math.hypot(ddx, ddy)
            if dlen < 0.8:
                continue
            dang = math.atan2(ddy, ddx) % math.pi
            dmx = (dsp[0] + dep[0]) / 2.0
            dmy = (dsp[1] + dep[1]) / 2.0
            d_perp = dmx * math.sin(dang) - dmy * math.cos(dang)

            duplicate = False
            for i, existing in enumerate(deduped_dims):
                e_ang = existing["_ang"]
                e_d_perp = existing["_d_perp"]
                ang_diff = abs(dang - e_ang)
                if ang_diff > math.pi / 2:
                    ang_diff = abs(ang_diff - math.pi)
                if ang_diff < 0.08 and abs(d_perp - e_d_perp) < 0.40:
                    duplicate = True
                    if dlen > existing["length"]:
                        deduped_dims[i] = {**d, "_ang": dang, "_d_perp": d_perp}
                    break

            if not duplicate:
                deduped_dims.append({**d, "_ang": dang, "_d_perp": d_perp})

        for d in deduped_dims:
            d.pop("_ang", None)
            d.pop("_d_perp", None)

        # Process grids (extend outward past building envelope so bubbles never land on walls)
        grids_svg = []
        for meta in self.element_meta.values():
            if meta.get("ifc_class") == "IfcGrid":
                sp = list(meta["start"])
                ep = list(meta["end"])
                tag = meta.get("tag", "1")
                gdx = ep[0] - sp[0]
                gdy = ep[1] - sp[1]
                glen = math.hypot(gdx, gdy)
                if glen > 0.001:
                    ux = gdx / glen
                    uy = gdy / glen
                    # Extend the grid line past the building envelope so bubbles never
                    # land on walls. These offsets were 1.2/0.6 — metres left over from
                    # before the units boundary — in a contract that is decimal feet, so
                    # every bubble sat 3.28x too far out. Now in feet.
                    bubble_center = [ep[0] + ux * FEET_4, ep[1] + uy * FEET_4]
                    tail = [sp[0] - ux * FEET_2, sp[1] - uy * FEET_2]
                else:
                    bubble_center = ep
                    tail = sp
                grids_svg.append({
                    "guid": meta["guid"],
                    "tag": tag,
                    "d": f"M {tail[0]:.3f} {tail[1]:.3f} L {bubble_center[0]:.3f} {bubble_center[1]:.3f}",
                    "circle_center": bubble_center,
                })

        # Process Slabs (only true floor slabs at ground/storey level; skip roofs, awnings, footings)
        slabs_svg = []
        for meta in self.element_meta.values():
            if meta.get("ifc_class") == "IfcSlab":
                name = (meta.get("name") or "").lower()
                if "roof" in name or "awning" in name or "footing" in name:
                    continue
                pts = meta.get("polygon", [])
                if pts and len(pts) >= 3:
                    path_str = f"M {pts[0][0]:.3f} {pts[0][1]:.3f} " + " ".join(
                        f"L {p[0]:.3f} {p[1]:.3f}" for p in pts[1:]
                    ) + " Z"
                    slabs_svg.append({"guid": meta["guid"], "d": path_str, "class": "IfcSlab projection"})

        # Process Roofs (footprint polygon, ridge line, pitch tag, slope indicators)
        roofs_svg = []
        for meta in self.element_meta.values():
            ifc_cls = meta.get("ifc_class")
            name = (meta.get("name") or "").lower()
            if ifc_cls == "IfcRoof" or (ifc_cls == "IfcSlab" and ("roof" in name or "awning" in name)):
                pts = meta.get("polygon", [])
                if pts and len(pts) >= 3:
                    path_str = f"M {pts[0][0]:.3f} {pts[0][1]:.3f} " + " ".join(
                        f"L {p[0]:.3f} {p[1]:.3f}" for p in pts[1:]
                    ) + " Z"

                    xs = [p[0] for p in pts]
                    ys = [p[1] for p in pts]
                    min_x, max_x = min(xs), max(xs)
                    min_y, max_y = min(ys), max(ys)
                    mid_y = (min_y + max_y) / 2.0
                    mid_x = (min_x + max_x) / 2.0

                    ridge_d = None
                    if (max_x - min_x) >= (max_y - min_y):
                        ridge_d = f"M {min_x:.3f} {mid_y:.3f} L {max_x:.3f} {mid_y:.3f}"
                    else:
                        ridge_d = f"M {mid_x:.3f} {min_y:.3f} L {mid_x:.3f} {max_y:.3f}"

                    pitch_deg = meta.get("pitch", 15.0)
                    roof_elev = meta.get("elevation", 6.0)
                    roofs_svg.append({
                        "guid": meta["guid"],
                        "name": meta.get("name", "Roof"),
                        "d": path_str,
                        "ridge_d": ridge_d,
                        "pitch": pitch_deg,
                        "pitch_text": f"{pitch_deg:.1f}° Slope" if pitch_deg > 0 else "Flat (0°)",
                        "center": [mid_x, mid_y],
                        "class": "IfcRoof projection",
                        "is_overhead": cut_elevation < (roof_elev - 0.5),
                    })

        return {
            "cut_paths": svg_cut_paths,
            "projection_paths": svg_projection_paths,
            "swing_paths": svg_swing_paths,
            "slabs": slabs_svg,
            "roofs": roofs_svg,
            "grids": grids_svg,
            "dimensions": deduped_dims,
            "renderer": "analytic",
            "partitions": {
                "cut": len(svg_cut_paths),
                "projection": len(svg_projection_paths),
            },
        }

    # -- P5: HLR-backed plan ------------------------------------------------
    def render_2d_view(self, view_type: str = "floor_plan",
                       cut_elevation: float = FEET_4,
                       direction: str = "south",
                       view_range: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
        """
        Renders a plan, section or elevation into the 2D vector contract.

        The mesh projector is orthographic, so the view is chosen by camera:
        a plan looks down (-Z); a section or elevation looks horizontally. `direction`
        names which way the horizontal views look, so "north" shows the south face.

        `view_range` carries the Revit view-range fields (cut/top/bottom/view_depth)
        in decimal feet. The cut applies to plans (and to sections that cut); an
        elevation does not cut, matching how elevations are drawn.
        """
        from mesh_hlr import MeshHlrProjector, ViewCamera
        from units import feet_to_metres, metres_to_feet

        view_type = (view_type or "floor_plan").lower()
        if view_type not in ("floor_plan", "plan", "section", "elevation"):
            raise ValueError(f"Unsupported view type {view_type!r}")

        # (right, up) in world terms, with the direction the camera looks along.
        cameras = {
            "south": ViewCamera(right=(1.0, 0.0, 0.0), up=(0.0, 0.0, 1.0),
                                direction=(0.0, -1.0, 0.0)),
            "north": ViewCamera(right=(1.0, 0.0, 0.0), up=(0.0, 0.0, 1.0),
                                direction=(0.0, 1.0, 0.0)),
            "east": ViewCamera(right=(0.0, 1.0, 0.0), up=(0.0, 0.0, 1.0),
                               direction=(1.0, 0.0, 0.0)),
            "west": ViewCamera(right=(0.0, 1.0, 0.0), up=(0.0, 0.0, 1.0),
                               direction=(-1.0, 0.0, 0.0)),
            "top": ViewCamera(),
        }
        key = "top" if view_type in ("floor_plan", "plan") else (direction or "south")
        camera = cameras.get(key, cameras["south"])

        meshes = self._meshes_for_projection()
        if not meshes:
            return {"cut_paths": [], "projection_paths": [], "hidden_paths": [],
                    "partitions": {"cut": 0, "projection": 0, "hidden": 0},
                    "renderer": "mesh-hlr", "view_type": view_type,
                    "error": "no geometry"}

        projector = MeshHlrProjector(
            meshes,
            prepared_cache=getattr(self, "_prepared_mesh_cache", None),
            cut_cache=getattr(self, "_cut_mesh_cache", None),
        )
        # A plan cuts; an elevation does not; a section does.
        cut_z = None
        if view_type in ("floor_plan", "plan", "section"):
            cut_z = feet_to_metres(float(cut_elevation))

        # The view range is applied in MODEL units, so convert from feet (the
        # parametric unit) to metres (the geometry's unit) before filtering.
        metric_range = None
        if view_range:
            metric_range = {
                k: feet_to_metres(float(v))
                for k, v in view_range.items()
                if v not in (None, "") and k in ("cut", "top", "bottom", "view_depth")
            }

        # Lineweights come from a table rather than being hard-coded here, so a view
        # template can restyle a drawing without touching the renderer.
        from hlr_renderer import LineweightTable

        table = LineweightTable()
        view = projector.render(camera=camera, cut_z=cut_z, view_range=metric_range)
        contract = projector.to_contract(view, lineweights=table, view_range=view_range)
        for path_key in ("cut_paths", "projection_paths", "hidden_paths"):
            for entry in contract.get(path_key, []):
                entry["d"] = _scale_path(entry.get("d", ""), metres_to_feet)

        contract["view_type"] = view_type
        contract["direction"] = key
        contract["view_range"] = dict(view_range or {})
        contract["cut_elevation"] = float(cut_elevation)
        contract["renderer"] = "mesh-hlr"
        # Annotation for every view type, not just plans.
        return self._annotate_view(contract, cut_elevation, view_type)

    def _plan_rotation(self) -> float:
        """
        The angle to rotate a plan by so the building's own axes are the drawing axes.

        A plan is drawn in the building's frame, not the world's. A real Revit export
        often has a rotated site/building placement (this house is 17 degrees off), so
        rendering world coordinates directly gives a skewed drawing. The rotation is
        taken from the building placement's x-axis and applied to the finished linework,
        which keeps the projector in world coordinates and only orients the output.
        """
        import math

        ref = self.building or self.site
        placement = getattr(ref, "ObjectPlacement", None) if ref else None
        if placement is None:
            return 0.0
        try:
            import ifcopenshell.util.placement as _plc

            matrix = _plc.get_local_placement(placement)
            x_axis = (float(matrix[0][0]), float(matrix[1][0]))
        except Exception:
            return 0.0
        if abs(x_axis[0]) < 1e-9 and abs(x_axis[1]) < 1e-9:
            return 0.0
        return math.atan2(x_axis[1], x_axis[0])

    def _orient_plan(self, contract: Dict[str, Any], angle: float) -> Dict[str, Any]:
        """
        Rotates a plan's linework so the building is axis-aligned.

        Applied to the whole contract after rendering, so the cut, projection and hidden
        partitions cannot drift apart.
        """
        import math
        import re as _re

        if abs(angle) < 1e-9:
            contract["plan_rotation"] = 0.0
            return contract
        cos_a, sin_a = math.cos(-angle), math.sin(-angle)

        def rotate_path(d: str) -> str:
            out = []
            for cmd, args in _re.findall(r"([MLZ])([^MLZ]*)", d):
                if cmd == "Z":
                    out.append("Z")
                    continue
                nums = [float(v) for v in _re.findall(r"-?\d+\.?\d*", args)]
                pts = []
                for i in range(0, len(nums) - 1, 2):
                    x, y = nums[i], nums[i + 1]
                    pts.append((x * cos_a - y * sin_a, x * sin_a + y * cos_a))
                if pts:
                    out.append(cmd + " " + " L ".join(f"{x:.4f} {y:.4f}" for x, y in pts))
            return " ".join(out)

        for key in ("cut_paths", "projection_paths", "hidden_paths"):
            for entry in contract.get(key, []) or []:
                if entry.get("d"):
                    entry["d"] = rotate_path(entry["d"])
        contract["plan_rotation"] = angle
        return contract

    def _resolve_plan_level(self, level_id: Optional[str],
                            cut_elevation: Optional[float]) -> Optional[str]:
        """
        Chooses the storey a plan belongs to.

        An explicit `level_id` wins. Otherwise the storey whose elevation is at or just
        below the requested cut is used, which is what a user means by "cut at 4 ft"
        when they have a level at 0. On a model with no levels, None (whole model).
        """
        if level_id and level_id in self.levels:
            return level_id
        if not self.levels:
            return None
        if cut_elevation is None:
            return None
        eligible = [
            (lid, float(lv.get("elevation", 0.0)))
            for lid, lv in self.levels.items()
            if float(lv.get("elevation", 0.0)) <= float(cut_elevation) + 1e-6
        ]
        if not eligible:
            # Below every level: fall back to the lowest so the view is not empty.
            return min(self.levels, key=lambda k: float(self.levels[k].get("elevation", 0.0)))
        return max(eligible, key=lambda pair: pair[1])[0]

    def _level_plan_guids(self, level_id: Optional[str]) -> Optional[set]:
        """
        The elements a plan of `level_id` draws, or None for "everything".

        Elements with no storey are included: a door or a grid that belongs to no level
        in the file would otherwise silently vanish, and omitting real geometry is worse
        than showing it in the storey it was cut at.
        """
        if level_id is None:
            return None
        return {
            guid for guid, meta in self.element_meta.items()
            if meta.get("level_id") in (None, level_id)
        }

    def _doc_revision(self) -> tuple:
        """
        A revision key for caching derived view data.

        `commit_revision` advances `mesh_revs` per element, but the level→element
        membership used below is derived from `element_meta` and is NOT covered by a
        counter, so the sorted element GUIDs are folded in as well: adding or deleting
        an element, or moving one to another storey, changes the key even when no
        counter moved. That makes the key conservative rather than clever, which is the
        correct bias for a cache that would otherwise draw a stale plan.
        """
        return (
            getattr(self, "doc_id", ""),
            getattr(self, "levels_rev", 0),
            getattr(self, "grids_rev", 0),
            getattr(self, "wall_joins_rev", 0),
            getattr(self, "constraints_rev", 0),
            len(self.element_meta),
            tuple(sorted(self.element_meta.keys())),
        )

    def _mesh_hlr_plan_contract(self, cut_elevation: float,
                                level_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """
        Renders the plan through the in-process geometric hidden-line projector.

        `level_id` scopes the view to one storey and makes `cut_elevation` a height
        ABOVE THAT STOREY rather than an absolute elevation, which is the Revit view
        range convention and the only thing that works on a real model: a storey at
        -55 ft with an absolute 4 ft cut plane would section empty space. When
        `level_id` is None the storey is inferred from the cut elevation.

        Meshes are metric (the IFC's unit) while the 2D contract is decimal feet, so
        this converts at the boundary. Returns None when there is no geometry, so the
        caller can fall back rather than emit an empty drawing.

        CACHED by document revision and view parameters. Measured, this projection is
        the dominant cost of an edit — 542 ms of a 629 ms edit at 196 walls, 86 % —
        and the profile attributes 77 % of the whole slice to `shapely.union_all`,
        called ~2x per mesh to union each mesh's projected triangles (twice: once for
        its silhouette, once to grow the occluder). `/api/state` asks for the same view
        repeatedly (post-commit, tab focus, poll), so recomputing an identical drawing
        was the single largest waste in the engine.
        """
        from mesh_hlr import MeshHlrProjector
        from units import feet_to_metres, metres_to_feet

        meshes = self._meshes_for_projection()
        if not meshes:
            return None

        # Resolve the storey and make the cut relative to it, so "cut 4 ft" means 4 ft
        # above the level rather than 4 ft above the project origin.
        resolved_level = self._resolve_plan_level(level_id, cut_elevation)
        level_meta = self.levels.get(resolved_level) if resolved_level else None
        base = float(level_meta.get("elevation", 0.0)) if level_meta else 0.0
        absolute_cut = base + float(cut_elevation)

        allowed = self._level_plan_guids(resolved_level)
        cache_key = (
            self._doc_revision(),
            resolved_level,
            round(absolute_cut, 6),
            tuple(sorted(allowed)) if allowed is not None else None,
        )
        cached = getattr(self, "_plan_contract_cache", None)
        if cached is not None and cached[0] == cache_key:
            # Deep copy: `_finish_plan_contract` rewrites the path strings in place, so
            # handing out the cached object would corrupt it for the next caller.
            return copy.deepcopy(cached[1])

        projector = MeshHlrProjector(
            meshes,
            prepared_cache=getattr(self, "_prepared_mesh_cache", None),
            cut_cache=getattr(self, "_cut_mesh_cache", None),
        )
        # The lineweight table is applied here too, so the plan entry point and
        # `render_2d_view` produce identically styled output. Applying it on only one
        # of the two paths is the kind of inconsistency that makes the same drawing
        # look different depending on how it was requested.
        from hlr_renderer import LineweightTable

        view = projector.render(
            cut_z=feet_to_metres(absolute_cut),
            include_guids=allowed,
        )
        contract = projector.to_contract(view, lineweights=LineweightTable())
        for key in ("cut_paths", "projection_paths", "hidden_paths"):
            for entry in contract.get(key, []):
                entry["d"] = _scale_path(entry.get("d", ""), metres_to_feet)

        self._plan_contract_cache = (cache_key, copy.deepcopy(contract))
        return contract

    def _hlr_plan_contract(self, cut_elevation: float) -> Optional[Dict[str, Any]]:
        """
        Renders the current level's plan through OCCT HLR, or None when the
        pipeline is unavailable (so the caller can fall back).
        """
        from hlr_renderer import HlrRenderer, ViewDefinition, ViewRange

        if not HlrRenderer.available():
            return None
        level_id = None
        # The view range's cut height is what the user asked for; map it onto the
        # storey whose plan that cut belongs to.
        for lid, lv in self.levels.items():
            if float(lv.get("elevation", 0.0)) <= float(cut_elevation):
                if level_id is None or float(lv["elevation"]) > float(self.levels[level_id]["elevation"]):
                    level_id = lid
        view = ViewDefinition(
            id=f"plan-{level_id or 'l1'}",
            name="Floor Plan",
            view_type="floor_plan",
            level_id=level_id,
            view_range=ViewRange(cut=float(cut_elevation)),
        )
        contract = HlrRenderer(self).render_to_contract(view, cut_elevation)
        contract["cut_elevation"] = float(cut_elevation)
        return contract

    def _window_symbol_paths(self, op_meta: Dict[str, Any],
                             host_meta: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Builds the plan window symbol: the glazing line(s) across the opening plus its
        jamb lines.

        Like the door swing, this is a drafting symbol rather than geometry — hidden
        line removal cannot produce it, because the symbol represents the window's
        construction in a way the solid does not. Without it a window is just a gap in
        the wall, which is not how a plan shows a window.

        Drawn in the host wall's own frame: `u` runs along the wall, `n` across it.
        """
        sp = host_meta.get("start")
        if not sp:
            return []
        ang = float(host_meta.get("angle", 0.0))
        offset = float(op_meta.get("offset_along_wall", 0.0) or 0.0)
        width = float(op_meta.get("width", 3.0) or 3.0)
        thickness = float(host_meta.get("thickness", INCHES_8) or INCHES_8)
        if width <= 0:
            return []

        ux, uy = math.cos(ang), math.sin(ang)
        nx, ny = -uy, ux
        # The window sits in the middle of the wall's thickness.
        half = thickness / 2.0

        def point(u: float, across: float):
            return (sp[0] + ux * u + nx * across, sp[1] + uy * u + ny * across)

        def line(u0: float, a0: float, u1: float, a1: float, cls: str) -> Dict[str, Any]:
            p0 = point(u0, a0)
            p1 = point(u1, a1)
            return {
                "guid": op_meta.get("guid"),
                "class": cls,
                "d": f"M {p0[0]:.3f} {p0[1]:.3f} L {p1[0]:.3f} {p1[1]:.3f}",
            }

        end = offset + width
        out = [
            # Four jamb lines closing the opening's reveal.
            line(offset, -half, offset, half, "IfcWindow jamb"),
            line(end, -half, end, half, "IfcWindow jamb"),
            # The glazing: a line across the middle of the opening, in plan.
            line(offset, 0.0, end, 0.0, "IfcWindow glazing"),
        ]
        # A second glazing line, offset across the wall, reads as a double-glazed
        # unit and is the common convention for a plan window symbol.
        out.append(line(offset, -half / 2.0, end, -half / 2.0, "IfcWindow glazing"))
        out.append(line(offset, half / 2.0, end, half / 2.0, "IfcWindow glazing"))
        return out

    def _door_swing_paths(self, op_meta: Dict[str, Any], host_meta: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Builds the plan door-swing symbol (panel line + 90-degree arc) for one
        opening, in model coordinates.

        Shared by both renderers. Hidden-line removal cannot produce this: a swing
        arc is a drafting symbol, not geometry, so it is generated from the door's
        parameters regardless of which engine drew the building linework.
        """
        sp = host_meta.get("start")
        ang = float(host_meta.get("angle", 0.0))
        offset = float(op_meta.get("offset_along_wall", 0.0) or 0.0)
        w = float(op_meta.get("width", 3.0) or 3.0)
        if not sp or w <= 0:
            return []

        op_pt = (sp[0] + math.cos(ang) * offset, sp[1] + math.sin(ang) * offset)
        op_end_pt = (sp[0] + math.cos(ang) * (offset + w), sp[1] + math.sin(ang) * (offset + w))
        name = (op_meta.get("name") or "").lower()
        is_sliding = "slide" in name or "pocket" in name
        is_overhead = "garage" in name or "overhead" in name or w > FEET_8

        if is_sliding or is_overhead:
            # Drawn along the opening centreline, no arc.
            return [{
                "guid": op_meta.get("guid"),
                "class": "IfcDoor sliding-panel",
                "d": f"M {op_pt[0]:.3f} {op_pt[1]:.3f} L {op_end_pt[0]:.3f} {op_end_pt[1]:.3f}",
            }]

        swing_flip = bool(op_meta.get("swing_flipped", False))
        swing_sign = -1.0 if swing_flip else 1.0
        panel_end = (
            op_pt[0] - math.sin(ang) * w * swing_sign,
            op_pt[1] + math.cos(ang) * w * swing_sign,
        )
        sweep = 0 if swing_flip else 1
        return [
            {
                "guid": op_meta.get("guid"),
                "class": "IfcDoor swing-panel",
                "d": f"M {op_pt[0]:.3f} {op_pt[1]:.3f} L {panel_end[0]:.3f} {panel_end[1]:.3f}",
            },
            {
                "guid": op_meta.get("guid"),
                "class": "IfcDoor swing",
                "d": (f"M {panel_end[0]:.3f} {panel_end[1]:.3f} "
                      f"A {w:.3f} {w:.3f} 0 0 {sweep} {op_end_pt[0]:.3f} {op_end_pt[1]:.3f}"),
            },
        ]

    def _annotate_view(self, contract: Dict[str, Any], cut_elevation: float,
                       view_type: str = "floor_plan") -> Dict[str, Any]:
        """
        Adds annotation drives and dimensions to any view's contract.

        One entry point so a plan, section and elevation cannot drift apart — the
        earlier shape of this code applied annotation on one code path only, which is
        how sections ended up bare.
        """
        contract = self._finish_plan_contract(contract, cut_elevation, view_type)
        if not contract.get("dimensions") and not getattr(self, "dimensions", None):
            contract["dimensions"] = self._overall_dimensions(contract)
        return contract

    def _overall_dimensions(self, contract: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Overall width and depth dimensions for a plan, in decimal feet.

        Dimension strings are a renderer's output, not model data: the same plan at a
        different scale would carry the same dimensions, but a renderer that is not
        dimensioning should not have to suppress them. This is therefore produced here
        from the drawing's own extents rather than stored on the elements.

        Values are formatted with `format_feet_inches`, the same formatter the type
        parameters use, so a drawing and a properties palette agree.
        """
        import re as _re

        from units import format_feet_inches

        xs: List[float] = []
        ys: List[float] = []
        for key in ("cut_paths", "projection_paths"):
            for entry in contract.get(key, []) or []:
                nums = [float(v) for v in _re.findall(r"-?\d+\.?\d*", entry.get("d", ""))]
                xs.extend(nums[0::2])
                ys.extend(nums[1::2])
        if not xs or not ys:
            return []

        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        width, depth = x1 - x0, y1 - y0
        if width <= 0 and depth <= 0:
            return []
        return [
            {
                "guid": None,
                "kind": "overall_width",
                "start": [x0, y0], "end": [x1, y0],
                "length": width,
                "text": format_feet_inches(width),
                # `offset_norm` is the direction the dimension line is displaced in,
                # and the viewport indexes it directly. Emitting only `offset` (a
                # distance) crashed the plan with "Cannot read properties of undefined
                # (reading '0')". Width runs along +X, so its offset is along -Y.
                "offset_norm": [0.0, -1.0],
            },
            {
                "guid": None,
                "kind": "overall_depth",
                "start": [x0, y0], "end": [x0, y1],
                "length": depth,
                "text": format_feet_inches(depth),
                # Depth runs along +Y, so its offset is along -X.
                "offset_norm": [-1.0, 0.0],
            },
        ]

    def _finish_plan_contract(self, contract: Dict[str, Any], cut_elevation: float,
                              view_type: str = "floor_plan") -> Dict[str, Any]:
        """
        Adds the annotation drives that hidden-line removal cannot supply.

        Serves EVERY view type, not just plans: a section or elevation needs the same
        datums, opening symbols and dimensions. It was previously applied only to the
        `slice_2d_vector_plan` result, so `render_2d_view` returned sections and
        elevations with no annotation, no grids and no dimensions at all.

        These are not modelled geometry, so there is nothing for HLR to compute; they
        stay metadata-driven whichever renderer produced the linework.
        """
        import math as _math

        grids_svg = []
        for guid, meta in self.element_meta.items():
            if meta.get("ifc_class") != "IfcGrid":
                continue
            start, end = meta.get("start"), meta.get("end")
            if not start or not end:
                continue
            # The grid record must carry the same fields the analytic renderer
            # produced, because the viewport reads them: it draws the axis from `d` and
            # the bubble at `circle_center`, and labels it with `tag`. Omitting `tag`
            # and `circle_center` crashed the 2D plan with
            # "Cannot read properties of undefined (reading '0')" — a real regression
            # from switching the renderer, and exactly why the contract has to be kept.
            gdx, gdy = end[0] - start[0], end[1] - start[1]
            glen = _math.hypot(gdx, gdy)
            if glen > 1e-6:
                ux, uy = gdx / glen, gdy / glen
                # Offsets in FEET, since this contract is decimal feet. (The analytic
                # renderer used 1.2/0.6, which were metres carried over from before the
                # units boundary and put every bubble 3.28x too far out.)
                bubble_center = [end[0] + ux * FEET_4, end[1] + uy * FEET_4]
                tail = [start[0] - ux * FEET_2, start[1] - uy * FEET_2]
            else:
                bubble_center, tail = [end[0], end[1]], [start[0], start[1]]
            grids_svg.append({
                "guid": guid,
                "tag": meta.get("tag") or meta.get("name") or "?",
                "name": meta.get("name", "Grid"),
                "d": f"M {tail[0]:.3f} {tail[1]:.3f} L {bubble_center[0]:.3f} {bubble_center[1]:.3f}",
                "circle_center": bubble_center,
                "class": "grid-line",
            })

        swing_paths = []
        window_paths = []
        for guid, meta in self.element_meta.items():
            if meta.get("ifc_class") not in ("IfcDoor", "IfcWindow"):
                continue
            host = self.element_meta.get(meta.get("host_wall_guid"))
            if not host:
                continue
            # A door swing is a PLAN symbol: it says which way the leaf opens, which
            # a section or elevation states differently (and drawing an arc across an
            # elevation is simply wrong). Window jamb/glazing lines read correctly in
            # both, so they are drawn in either.
            is_plan = view_type in ("floor_plan", "plan")
            try:
                if meta.get("ifc_class") == "IfcWindow":
                    window_paths.extend(self._window_symbol_paths(meta, host))
                elif is_plan:
                    swing_paths.extend(self._door_swing_paths(meta, host))
            except Exception as e:
                print(f"Notice: opening symbol for {guid} failed: {e}")

        slabs_svg = []
        for guid, meta in self.element_meta.items():
            if meta.get("ifc_class") != "IfcSlab" or not meta.get("polygon"):
                continue
            poly = meta["polygon"]
            d = "M " + " L ".join(f"{p[0]:.3f} {p[1]:.3f}" for p in poly) + " Z"
            slabs_svg.append({"guid": guid, "d": d, "class": "IfcSlab projection"})

        roofs_svg = []
        for guid, meta in self.element_meta.items():
            if meta.get("ifc_class") != "IfcRoof" or not meta.get("polygon"):
                continue
            poly = meta["polygon"]
            d = "M " + " L ".join(f"{p[0]:.3f} {p[1]:.3f}" for p in poly) + " Z"
            # The viewport draws the ridge from `ridge_d`, labels the pitch from
            # `pitch_text`, and keys its overhead treatment off `center`/`is_overhead`.
            # Omitting them would crash the plan the same way the grids did.
            xs = [p[0] for p in poly]
            ys = [p[1] for p in poly]
            min_x, max_x = min(xs), max(xs)
            min_y, max_y = min(ys), max(ys)
            mid_x, mid_y = (min_x + max_x) / 2.0, (min_y + max_y) / 2.0
            if (max_x - min_x) >= (max_y - min_y):
                ridge_d = f"M {min_x:.3f} {mid_y:.3f} L {max_x:.3f} {mid_y:.3f}"
            else:
                ridge_d = f"M {mid_x:.3f} {min_y:.3f} L {mid_x:.3f} {max_y:.3f}"
            pitch_deg = float(meta.get("pitch", 15.0) or 0.0)
            roof_elev = float(meta.get("elevation", FEET_10) or 0.0)
            roofs_svg.append({
                "guid": guid,
                "name": meta.get("name", "Roof"),
                "d": d,
                "ridge_d": ridge_d,
                "pitch": pitch_deg,
                "pitch_text": f"{pitch_deg:.1f}\u00b0 Slope" if pitch_deg > 0 else "Flat (0\u00b0)",
                "center": [mid_x, mid_y],
                "class": "IfcRoof projection",
                "is_overhead": cut_elevation < (roof_elev - 0.5),
            })

        # Assign, don't setdefault: the HLR contract already carries these keys as
        # empty lists, so setdefault would silently keep the empty one. (That bug
        # dropped every slab and roof from the plan.)
        contract["slabs"] = slabs_svg
        contract["roofs"] = roofs_svg
        contract["grids"] = grids_svg
        contract["swing_paths"] = swing_paths
        # Window symbols are a separate drive so a consumer can style them apart from
        # door swings (both are annotation, neither is geometry).
        contract["window_paths"] = window_paths
        contract.setdefault("dimensions", [])
        contract["cut_elevation"] = float(cut_elevation)

        levels_svg = []
        is_vert_view = view_type in ("elevation", "section")
        if is_vert_view and hasattr(self, "levels") and self.levels:
            import re as _re
            xs: List[float] = []
            for pkey in ("cut_paths", "projection_paths"):
                for entry in contract.get(pkey, []) or []:
                    nums = [float(v) for v in _re.findall(r"-?\d+\.?\d*", entry.get("d", ""))]
                    xs.extend(nums[0::2])
            min_x = min(xs) if xs else -20.0
            max_x = max(xs) if xs else 20.0
            tail_x = min_x - FEET_4
            bubble_x = max_x + FEET_6

            for lid, lv in sorted(self.levels.items(), key=lambda item: float(item[1].get("elevation", 0.0))):
                elev = float(lv.get("elevation", 0.0))
                name = lv.get("name", f"Level {lid}")
                levels_svg.append({
                    "id": lid,
                    "name": name,
                    "elevation": elev,
                    "text": f"{name}  {format_feet_inches(elev)}",
                    "elevation_text": format_feet_inches(elev),
                    "d": f"M {tail_x:.3f} {elev:.3f} L {bubble_x:.3f} {elev:.3f}",
                    "circle_center": [bubble_x, elev],
                    "class": "level-line",
                })
        contract["levels"] = levels_svg

        # Apply the drafting rule that hidden-line removal alone cannot know: a wall
        # shorter than 6 ft is DRAWN IN PROJECTION even when the cut plane passes
        # through it, because a 4 ft wall is not sectioned in a plan. This lives here,
        # in the finisher, so every renderer path gets it — it was previously in the
        # mesh-HLR builder only, and moving the cache underneath that builder silently
        # dropped it (`test_hlr.py` "low wall is projected, not cut" caught it).
        low = {
            guid for guid, meta in self.element_meta.items()
            if meta.get("ifc_class") in ("IfcWall", "IfcWallStandardCase")
            and 0.0 < float(meta.get("height", 0.0) or 0.0) < FEET_6
        }
        if low:
            keep, moved = [], []
            for entry in contract.get("cut_paths", []):
                (moved if entry.get("guid") in low else keep).append(entry)
            contract["cut_paths"] = keep
            contract["projection_paths"] = contract.get("projection_paths", []) + moved

        # Orient the plan into the building's own frame BEFORE measuring, so the drawing
        # is axis-aligned and its dimensions are square to the building. This call was
        # the only caller of `_orient_plan`, and deleting it with the old tail of
        # `_mesh_hlr_plan_contract` silently stopped rotating plans for a rotated model
        # (`plan_rotation` is -17.1 deg on the reference building).
        contract = self._orient_plan(contract, self._plan_rotation())
        dims_out = []
        if hasattr(self, "dimensions") and self.dimensions:
            for did, d in self.dimensions.items():
                ref_a = d.get("ref_a", {})
                ref_b = d.get("ref_b", {})
                pa, out_a = resolve_reference(self, ref_a)
                pb, out_b = resolve_reference(self, ref_b)
                # Visibility follows the LIVE resolution only. A persisted `status` is a historical
                # fact ("lost" while a witness was missing), so trusting it here kept a dimension
                # hidden forever once its witness came back — a re-added GUID, a re-imported IFC or
                # a re-opened overlay never cleared it. See review round 3, finding F1.
                if pa is None or pb is None or out_a == "lost" or out_b == "lost":
                    val = float(d.get("value", 0.0))
                    dims_out.append({
                        "id": did,
                        "guid": ref_a.get("guid"),
                        "kind": d.get("kind", "aligned"),
                        # `length`/`text` are the last stored value, NOT a live measurement: the
                        # witnesses cannot be resolved, so there is nothing to measure. Consumers
                        # must key off `status`, never off `text`.
                        "start": None,
                        "end": None,
                        "length": val,
                        "text": format_feet_inches(val),
                        "offset_norm": [0.0, 1.0],
                        "is_locked": bool(d.get("is_locked", False)),
                        "ref_a": ref_a,
                        "ref_b": ref_b,
                        "axis": d.get("axis", "aligned"),
                        "status": "lost",
                    })
                    continue
                dx, dy = pb[0] - pa[0], pb[1] - pa[1]
                dist = _math.hypot(dx, dy)
                if dist > 1e-6:
                    nx, ny = -dy / dist, dx / dist
                else:
                    nx, ny = 0.0, 1.0
                val = float(d.get("value", dist))
                # Reconcile the persisted status with the fresh outcome. The move path stamps
                # "repaired" for a re-resolved witness and plan §4 Phase 2 requires that to survive;
                # a stale "lost" must not, and a newly-ambiguous reference must not be masked by an
                # older "exact".
                persisted = d.get("status")
                live_outcome = worst_outcome(out_a, out_b)
                status = live_outcome if persisted == "lost" else worst_outcome(persisted, live_outcome)
                dims_out.append({
                    "id": did,
                    "guid": ref_a.get("guid"),
                    "kind": d.get("kind", "aligned"),
                    "start": [float(pa[0]), float(pa[1])],
                    "end": [float(pb[0]), float(pb[1])],
                    "length": val,
                    "text": format_feet_inches(val),
                    "offset_norm": [float(nx), float(ny)],
                    "is_locked": bool(d.get("is_locked", False)),
                    "ref_a": ref_a,
                    "ref_b": ref_b,
                    "axis": d.get("axis", "aligned"),
                    "status": status,
                })
        if not dims_out and not getattr(self, "dimensions", None):
            dims_out = self._overall_dimensions(contract)
        contract["dimensions"] = dims_out
        return contract

    # =========================================================================
    # VECTOR PDF COMPILATION & SHEET ENGINE (P6 / SPECIFICATION-v0.2.md §13)
    # =========================================================================

    def add_sheet(
        self,
        sheet_number: str,
        sheet_title: str = "Unnamed Sheet",
        paper_size: str = "ARCH_D",
        is_placeholder: bool = False,
        sheet_id: Optional[str] = None,
        drawn_by: str = "BIMWorks Architect",
        date: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Creates a new sheet in the model.
        Enforces §13.2 constraints:
          - Sheet number required (cannot be empty)
          - Sheet number unique per scope
        """
        if not sheet_number or not sheet_number.strip():
            raise ValueError("Sheet Number is empty")

        num_clean = sheet_number.strip()
        if sheet_id and sheet_id in self.sheets:
            raise ValueError(f"Sheet ID '{sheet_id}' already exists in model")

        for sid, s in self.sheets.items():
            if s.get("sheet_number", "").strip().lower() == num_clean.lower():
                raise ValueError(f"Sheet Number is already in use. Enter a unique number: '{num_clean}'")

        sid = sheet_id or f"sheet-{uuid.uuid4().hex[:8]}"
        new_sheet = {
            "id": sid,
            "sheet_number": num_clean,
            "sheet_title": sheet_title.strip() if sheet_title else "Unnamed Sheet",
            "paper_size": paper_size,
            "project_name": self.project_name,
            "date": date or "2026-10-13",
            "drawn_by": drawn_by,
            "is_placeholder": is_placeholder,
            "viewports": [],
        }
        self.sheets[sid] = new_sheet
        self.sheets_rev += 1
        return new_sheet

    def delete_sheet(self, sheet_id: str) -> bool:
        """
        Deletes a sheet and its placed viewports.
        Invariant §13.1: Deleting a viewport/sheet removes placements,
        but NEVER deletes the referenced view.
        """
        if sheet_id not in self.sheets:
            raise ValueError(f"Sheet '{sheet_id}' not found")
        del self.sheets[sheet_id]
        self.sheets_rev += 1
        return True

    def update_sheet(self, sheet_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        """
        Updates metadata of an existing sheet (e.g. sheet_title, sheet_number, drawn_by, date).
        """
        if sheet_id not in self.sheets:
            raise ValueError(f"Sheet '{sheet_id}' not found")
        s = self.sheets[sheet_id]
        if "sheet_number" in updates or "sheetNumber" in updates:
            raw_num = updates.get("sheet_number") if "sheet_number" in updates else updates.get("sheetNumber")
            if raw_num:
                num_clean = str(raw_num).strip()
                for other_id, other_s in self.sheets.items():
                    if other_id != sheet_id and other_s.get("sheet_number", "").strip().lower() == num_clean.lower():
                        raise ValueError(f"Sheet Number is already in use: '{num_clean}'")
                s["sheet_number"] = num_clean
        if "sheet_title" in updates or "sheetTitle" in updates:
            val = updates.get("sheet_title") if "sheet_title" in updates else updates.get("sheetTitle")
            if val is not None:
                s["sheet_title"] = str(val).strip()
        if "drawn_by" in updates or "drawnBy" in updates:
            val = updates.get("drawn_by") if "drawn_by" in updates else updates.get("drawnBy")
            if val is not None:
                s["drawn_by"] = str(val).strip()
        if "date" in updates and updates["date"] is not None:
            s["date"] = str(updates["date"]).strip()
        if "paper_size" in updates or "paperSize" in updates:
            val = updates.get("paper_size") if "paper_size" in updates else updates.get("paperSize")
            if val is not None:
                s["paper_size"] = str(val).strip()
        self.sheets_rev += 1
        return s

    def convert_placeholder_sheet(self, sheet_id: str) -> Dict[str, Any]:
        """Converts a placeholder sheet into a real printable sheet (SPEC §13.2)."""
        if sheet_id not in self.sheets:
            raise ValueError(f"Sheet '{sheet_id}' not found")
        self.sheets[sheet_id]["is_placeholder"] = False
        self.sheets_rev += 1
        return self.sheets[sheet_id]

    def add_viewport_to_sheet(
        self,
        sheet_id: str,
        view_id: str,
        x: float,
        y: float,
        width: float = 480.0,
        height: float = 360.0,
        scale_factor: float = 1.0,
        viewport_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Places a view on a sheet.
        Enforces §13.1 and §13.2 invariants & constraints:
          - Views and placement are separate objects
          - View must exist in self.views
          - A view appears at most once per sheet
          - A view appears at most once across all sheets in the model
          - Cannot place views on placeholder sheets
        """
        if sheet_id not in self.sheets:
            raise ValueError(f"Sheet '{sheet_id}' not found")
        if view_id not in self.views:
            raise ValueError(f"View '{view_id}' not found")

        target_sheet = self.sheets[sheet_id]
        if target_sheet.get("is_placeholder", False):
            raise ValueError(f"Cannot place view on placeholder sheet '{target_sheet.get('sheet_number')}'")

        view_def = self.views[view_id]
        view_name = view_def.get("name", view_id)

        # §13.2 Constraint: A view appears at most once per sheet
        for vp in target_sheet.get("viewports", []):
            if vp.get("view_id") == view_id:
                raise ValueError(f"Sheet views cannot contain more than one instance of '{view_name}'")

        # §13.2 Constraint: A view appears at most once in the model across sheets
        for sid, s in self.sheets.items():
            for vp in s.get("viewports", []):
                if vp.get("view_id") == view_id:
                    raise ValueError(f"Sheet views in this model cannot contain more than one instance of '{view_name}'")

        vp_id = viewport_id or f"vp-{uuid.uuid4().hex[:8]}"
        vp = {
            "id": vp_id,
            "view_id": view_id,
            "x": float(x),
            "y": float(y),
            "width": float(width),
            "height": float(height),
            "scale_factor": float(scale_factor),
        }
        target_sheet.setdefault("viewports", []).append(vp)
        self.sheets_rev += 1
        return vp

    def remove_viewport_from_sheet(self, viewport_id: str, sheet_id: Optional[str] = None) -> bool:
        """
        Removes a viewport from its sheet.
        Invariant §13.1: Deleting a viewport removes placement, NEVER deletes the view.
        """
        found = False
        for sid, s in self.sheets.items():
            if sheet_id and sid != sheet_id:
                continue
            vps = s.get("viewports", [])
            new_vps = [vp for vp in vps if vp.get("id") != viewport_id]
            if len(new_vps) < len(vps):
                s["viewports"] = new_vps
                found = True
                break
        if not found:
            raise ValueError(f"Viewport '{viewport_id}' not found")
        self.sheets_rev += 1
        return True

    def move_viewport(self, viewport_id: str, x: float, y: float, sheet_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Translates a placed viewport in sheet coordinates.
        """
        for sid, s in self.sheets.items():
            if sheet_id and sid != sheet_id:
                continue
            for vp in s.get("viewports", []):
                if vp.get("id") == viewport_id:
                    vp["x"] = float(x)
                    vp["y"] = float(y)
                    self.sheets_rev += 1
                    return vp
        raise ValueError(f"Viewport '{viewport_id}' not found")

    def get_sheets(self) -> List[Dict[str, Any]]:
        """
        Returns all sheets with both snake_case and camelCase keys for UI compatibility.
        """
        res = []
        for sid in sorted(self.sheets.keys()):
            s = self.sheets[sid]
            item = copy.deepcopy(s)
            item["sheetNumber"] = item.get("sheet_number")
            item["sheetTitle"] = item.get("sheet_title")
            item["paperSize"] = item.get("paper_size")
            item["projectName"] = item.get("project_name")
            item["drawnBy"] = item.get("drawn_by")
            item["isPlaceholder"] = item.get("is_placeholder", False)
            vps = []
            for vp in item.get("viewports", []):
                v_copy = copy.deepcopy(vp)
                v_copy["viewId"] = v_copy.get("view_id")
                v_copy["scaleFactor"] = v_copy.get("scale_factor", 1.0)
                vps.append(v_copy)
            item["viewports"] = vps
            res.append(item)
        return res

    def get_views(self) -> List[Dict[str, Any]]:
        """
        Returns all registered views with both snake_case and camelCase keys for UI compatibility.
        """
        res = []
        for vid in sorted(self.views.keys()):
            v = copy.deepcopy(self.views[vid])
            vr = v.get("view_range") or v.get("viewRange") or {}
            normalized_vr = {
                "top": float(vr.get("top", 8.0)),
                "cut": float(vr.get("cut", 4.0)),
                "bottom": float(vr.get("bottom", 0.0)),
                "viewDepth": float(vr.get("viewDepth", vr.get("view_depth", 0.0))),
                "view_depth": float(vr.get("view_depth", vr.get("viewDepth", 0.0))),
            }
            v["viewRange"] = normalized_vr
            v["view_range"] = normalized_vr
            v["levelId"] = v.get("level_id", v.get("levelId"))
            v["detailLevel"] = v.get("detail_level", v.get("detailLevel", "medium"))
            v["visualStyle"] = v.get("visual_style", v.get("visualStyle", "hidden_line"))
            res.append(v)
        return res

    def compile_sheet_to_vector_pdf(self, svg_content: str) -> bytes:
        """
        Compiles pure vector Sheet SVG into print-ready, vectorized PDF.
        Maintains 100% scalable vector linework and searchable text.
        """
        clean_svg = svg_content.strip()
        if not clean_svg.startswith("<?xml"):
            clean_svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + clean_svg

        svg_bytes = clean_svg.encode("utf-8")
        svg_doc = pymupdf.open("svg", svg_bytes)
        pdf_bytes = svg_doc.convert_to_pdf()
        return pdf_bytes

    def compile_batch_to_vector_pdf(self, svg_contents: List[str]) -> bytes:
        """
        Compiles multiple Sheet SVGs into a single multi-page vectorized PDF.
        """
        if not svg_contents:
            return b""
        combined_doc = pymupdf.open()
        for svg_content in svg_contents:
            clean_svg = svg_content.strip()
            if not clean_svg.startswith("<?xml"):
                clean_svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + clean_svg
            svg_bytes = clean_svg.encode("utf-8")
            page_svg_doc = pymupdf.open("svg", svg_bytes)
            page_pdf_bytes = page_svg_doc.convert_to_pdf()
            page_pdf = pymupdf.open("pdf", page_pdf_bytes)
            combined_doc.insert_pdf(page_pdf)
        return combined_doc.tobytes()

    def export_ifc_step(self, filepath: Optional[str] = None) -> str:
        """Serializes in-memory model to valid standard IFC4 STEP file."""
        if not filepath:
            temp_dir = tempfile.gettempdir()
            filepath = os.path.join(temp_dir, f"{self.project_name.replace(' ', '_')}.ifc")
        self.model.write(filepath)
        return filepath

    def save_orlt_project(self, filepath: Optional[str] = None) -> str:
        """
        Exports the project as a BIMWorks hybrid container (.bimworks zip).

        Per GLM Master Spec v2 §3.1:
        myproject.bimworks (zip container)
        ├── model.ifc          # IFC4 ADD2 STEP file — model of record
        ├── parametric.json    # overlay: constraints, join policies, parametric geometry
        ├── views/default.json # view range, detail level, filters, templates
        └── meta.json          # schema version (2.1), license (GPL-3.0), units (decimal_feet)

        The method name keeps its historical `_orlt_` spelling so existing callers
        (CommandBus handlers, tests, scratch scripts) are unaffected; the emitted
        container is `.bimworks`.
        """
        if not filepath:
            temp_dir = tempfile.gettempdir()
            safe_name = "".join(c for c in self.project_name if c.isalnum() or c in ("-", "_")).strip() or "Project"
            filepath = os.path.join(temp_dir, f"{safe_name}{CONTAINER_EXTENSION}")

        # 1. Generate IFC4 STEP model of record. Strip the rejected constraint
        #    pset first so a container upgraded from an older build cannot keep
        #    shipping it (constraints are overlay-only, P2-E).
        self.strip_legacy_constraint_pset()
        ifc_temp = tempfile.NamedTemporaryFile(suffix=".ifc", delete=False)
        ifc_temp.close()
        self.model.write(ifc_temp.name)

        # 2. Parametric overlay — schema v3: the overlay is the parametric truth.
        #    Every element carries the data needed to rebuild it from scratch
        #    (baseline, polygon, host + offset, pitch, levels, grids), so a load
        #    never has to infer geometry from tessellation. Live entity refs and
        #    cached tessellation are excluded; footprints are excluded because the
        #    join engine recomputes them deterministically from baselines +
        #    policies (storing them would add a second source of truth).
        parametric_overlay = {
            "schema_version": OVERLAY_SCHEMA_VERSION,
            "units": {
                "internal": INTERNAL_UNIT,
                "ifc_length": IFC_LENGTH_UNIT,
                "conversion": UNIT_CONVERSION_SOURCE,
            },
            "internal_units": INTERNAL_UNIT,
            "constraints": self._jsonable(self.constraints),
            "join_policies": self._jsonable(self.join_policies),
            "dimensions": self._jsonable(list(self.dimensions.values())),
            "types": self._jsonable([
                {k: v for k, v in trec.items() if k != "entity"}
                for trec in self.type_registry.values()
            ]),
            "sheets": self._jsonable(sorted(list(self.sheets.values()), key=lambda s: s["id"])),
            "views": self._jsonable(sorted(list(self.views.values()), key=lambda v: v["id"])),
            "levels": [
                {"id": lid, "name": lv.get("name"), "elevation": self._jsonable(lv.get("elevation", 0.0))}
                for lid, lv in self.levels.items()
            ],
            "elements": {
                guid: self._build_overlay_element(guid, meta)
                for guid, meta in self.element_meta.items()
            },
        }

        # 3. View templates and settings
        views_data = {
            "views": self._jsonable(sorted(list(self.views.values()), key=lambda v: v["id"]))
        }

        # 4. Meta manifest
        meta_data = {
            "app": "BIMWorks",
            "version": "2.1",
            "spec": "GLM Master Spec v2.1",
            "container_format": CONTAINER_FORMAT_ID,
            "schema_version": OVERLAY_SCHEMA_VERSION,
            "license": "GPL-3.0",
            "internal_units": INTERNAL_UNIT,
            "ifc_length_unit": IFC_LENGTH_UNIT,
            "project_name": self.project_name,
            "element_count": len(self.element_meta),
            "timestamp": time.time(),
        }

        with zipfile.ZipFile(filepath, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.write(ifc_temp.name, arcname="model.ifc")
            z.writestr("parametric.json", json.dumps(parametric_overlay, indent=2))
            z.writestr("views/default.json", json.dumps(views_data, indent=2))
            z.writestr("meta.json", json.dumps(meta_data, indent=2))

        try:
            os.remove(ifc_temp.name)
        except Exception:
            pass

        return filepath

    def load_orlt_project(self, file_bytes_or_path: Any, filename: str = "Project.bimworks") -> Dict[str, Any]:
        """
        Loads a BIMWorks hybrid container (.bimworks; legacy .orlt also accepted).

        P2 load path — the overlay is authoritative:
          1. Read `parametric.json` first; it holds the parametric definition.
          2. Import `model.ifc` for the spatial structure (project, storeys, site)
             and to learn which GUIDs the file actually contains.
          3. Rebuild every element from the overlay with GUID preservation and
             regenerate its geometry through the normal builders — never infer
             geometry from tessellation.
          4. Flag overlay records whose GUIDs are absent from the IFC as `stale`
             and never apply them silently.

        Containers from schema v2.1 have no parametric geometry in the overlay, so
        they fall back to the legacy tessellation import (with the fidelity limits
        that implies) and additionally receive their type properties.

        The `filename` argument is decorative only — the payload is identified by
        its zip members, so a mislabelled extension still loads.
        """
        if isinstance(file_bytes_or_path, (bytes, bytearray)):
            z_file = zipfile.ZipFile(io.BytesIO(file_bytes_or_path))
        elif isinstance(file_bytes_or_path, str):
            z_file = zipfile.ZipFile(file_bytes_or_path, "r")
        else:
            raise ValueError("Invalid file input for project container")

        # Normalize a display name with a real .ifc suffix for the IFC import path
        # (works for .bimworks, legacy .orlt, and mislabelled/extensionless names).
        display_name = filename or "Project.bimworks"
        stem = display_name
        for ext in CONTAINER_EXTENSIONS:
            if stem.lower().endswith(ext):
                stem = stem[: -len(ext)]
                break
        else:
            if "." in os.path.basename(stem):
                stem = os.path.splitext(stem)[0]
        ifc_display_name = f"{stem}.ifc"

        overlay: Dict[str, Any] = {}
        schema_version: Any = None
        meta_payload: Dict[str, Any] = {}

        with z_file as z:
            names = z.namelist()
            if "model.ifc" not in names:
                raise ValueError("Project container missing required 'model.ifc'")

            if "parametric.json" in names:
                try:
                    overlay = json.loads(z.read("parametric.json").decode("utf-8"))
                    schema_version = overlay.get("schema_version")
                except Exception as pe:
                    print(f"Notice loading parametric.json overlay: {pe}")
                    overlay = {}

            if "meta.json" in names:
                try:
                    meta_payload = json.loads(z.read("meta.json").decode("utf-8"))
                except Exception:
                    meta_payload = {}

            ifc_content = z.read("model.ifc").decode("utf-8", errors="replace")

        # Import the IFC for spatial structure + the authoritative GUID list. This
        # also populates element_meta via the legacy path, which the overlay
        # rebuild then replaces wholesale when the schema supports it.
        self.load_ifc_content(ifc_content, ifc_display_name)
        # Every GUID the saved IFC actually contains. `element_meta` keys are the
        # authoritative list (they are derived from the IFC's own products), and
        # using the keys rather than `meta["entity"]` matters because some
        # elements are metadata-only in a legacy file and must not be mistaken
        # for stale just because they have no entity handle.
        ifc_guids = sorted(self.element_meta.keys())

        if meta_payload.get("project_name"):
            self.project_name = meta_payload["project_name"]

        is_authoritative = schema_version in (3, 4, OVERLAY_SCHEMA_VERSION)
        load_report: Dict[str, Any]
        if is_authoritative:
            overlay["_ifc_guids"] = ifc_guids
            load_report = self.rebuild_from_overlay(overlay)
            load_report.pop("_ifc_guids", None)
        else:
            # Legacy container: no parametric geometry in the overlay. Keep the
            # tessellation import and only re-attach metadata that is GUID-gated.
            self.constraints = self._jsonable(overlay.get("constraints", {}) or {})
            self.join_policies = self._jsonable(overlay.get("join_policies", {}) or {})
            elements_overlay = overlay.get("elements", {}) or {}
            legacy_dims = self._jsonable(overlay.get("dimensions", {}) or {})
            self.dimensions = {}
            if isinstance(legacy_dims, list):
                for d in legacy_dims:
                    did = d.get("id") or f"dim_{uuid.uuid4().hex[:8]}"
                    d_copy = copy.deepcopy(d)
                    if "ref_a" in d_copy:
                        d_copy["ref_a"] = normalize_reference(d_copy["ref_a"])
                    if "ref_b" in d_copy:
                        d_copy["ref_b"] = normalize_reference(d_copy["ref_b"])
                    if "refs" in d_copy and isinstance(d_copy["refs"], list):
                        d_copy["refs"] = [normalize_reference(r) for r in d_copy["refs"]]
                    self.dimensions[did] = d_copy
            elif isinstance(legacy_dims, dict):
                for did, d in legacy_dims.items():
                    d_copy = copy.deepcopy(d)
                    if "ref_a" in d_copy:
                        d_copy["ref_a"] = normalize_reference(d_copy["ref_a"])
                    if "ref_b" in d_copy:
                        d_copy["ref_b"] = normalize_reference(d_copy["ref_b"])
                    if "refs" in d_copy and isinstance(d_copy["refs"], list):
                        d_copy["refs"] = [normalize_reference(r) for r in d_copy["refs"]]
                    self.dimensions[did] = d_copy
            applied, stale = [], []
            for g, o_meta in elements_overlay.items():
                if g in self.element_meta:
                    if "type_properties" in o_meta:
                        self.element_meta[g].setdefault("type_properties", {}).update(o_meta["type_properties"])
                    applied.append(g)
                else:
                    stale.append(g)
            load_report = {
                "schema_version": schema_version,
                "legacy": True,
                "rebuilt": [],
                "stale": [{"guid": g, "reason": "GUID not present in the container's model.ifc"} for g in stale],
                "unparametrized": [],
                "failed": [],
                "metadata_applied": applied,
                "elements_count": len(self.element_meta),
                "note": (
                    "schema v2.1 container: the overlay carries no parametric geometry, "
                    "so geometry was reconstructed from the tessellated IFC (lossy for "
                    "angled walls and non-rectangular polygons). Re-save to upgrade to v3."
                ),
            }

        return {
            "status": "loaded",
            "container_format": CONTAINER_FORMAT_ID,
            "project_name": self.project_name,
            "schema_version": schema_version,
            "overlay_authoritative": is_authoritative,
            "elements_count": len(self.element_meta),
            "constraints_count": len(self.constraints),
            "join_policies_count": len(self.join_policies),
            "load_report": load_report,
        }

    def load_ifc_content(self, ifc_content: str, filename: str = "Imported.ifc") -> Dict[str, Any]:
        """
        Loads an arbitrary standard IFC4 / IFC2X3 file from string content into the BIM engine.
        Extracts Project, Storeys (Levels), Grids, and Products (Walls, Doors, Windows, Slabs, Roofs, etc.).
        Tessellates geometric meshes and populates element_meta.
        """
        temp_dir = tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, f"imported_{uuid.uuid4().hex[:8]}.ifc")
        with open(temp_path, "w", encoding="utf-8") as f:
            f.write(ifc_content)
        return self.load_ifc_file(temp_path, filename)

    @staticmethod
    def _extruded_profile(p) -> Optional[Dict[str, Any]]:
        """
        Reads a product's extruded-solid parameters without assuming a wall.

        Returns the profile outline in the product's local frame, the extrusion's
        placement matrix and its depth, or None when the product has no extruded
        area solid. Shared by wall baselines and slab/roof outlines.
        """
        try:
            representation = getattr(p, "Representation", None)
            if not representation:
                return None
            item = None
            for r in getattr(representation, "Representations", []) or []:
                ident = (getattr(r, "RepresentationIdentifier", "") or "").lower()
                if ident in ("body", "model", ""):
                    for candidate in getattr(r, "Items", []) or []:
                        if candidate.is_a("IfcExtrudedAreaSolid"):
                            item = candidate
                            break
                if item is not None:
                    break
            if item is None:
                return None

            profile = getattr(item, "SweptArea", None)
            position = getattr(item, "Position", None)
            if profile is None or position is None:
                return None

            coords: List[Tuple[float, float]] = []
            if profile.is_a("IfcArbitraryClosedProfileDef"):
                curve = getattr(profile, "OuterCurve", None)
                for pt in (getattr(curve, "Points", None) or []):
                    # Three shapes are observed in the wild: an IfcCartesianPoint
                    # entity, a coordinate tuple, or a nested sequence of points.
                    c = getattr(pt, "Coordinates", pt)
                    if c is not None and len(c) and isinstance(c[0], (tuple, list)):
                        for inner in c:
                            if len(inner) >= 2:
                                coords.append((float(inner[0]), float(inner[1])))
                    elif c is not None and len(c) >= 2:
                        coords.append((float(c[0]), float(c[1])))
            elif profile.is_a("IfcRectangleProfileDef"):
                hx = float(getattr(profile, "XDim", 0.0)) / 2.0
                hy = float(getattr(profile, "YDim", 0.0)) / 2.0
                coords = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
            else:
                return None

            if len(coords) < 3:
                return None
            return {
                "coords": coords,
                "local_matrix": plc.get_axis2placement(position),
                "depth": float(getattr(item, "Depth", 0.0) or 0.0),
            }
        except Exception:
            return None

    @staticmethod
    def _product_translation(p) -> np.ndarray:
        """World translation of a product's own placement (zeros if none)."""
        try:
            if getattr(p, "ObjectPlacement", None) is None:
                return np.zeros(3)
            return plc.get_local_placement(p.ObjectPlacement)[:3, 3]
        except Exception:
            return np.zeros(3)

    @staticmethod
    def _wall_from_extruded_profile(p, unit_scale: float, fallback_z: float) -> Optional[Dict[str, Any]]:
        """
        Reconstructs a wall baseline from its extruded-solid parameters.

        Used for foreign IFC files whose walls carry no `Axis` representation.
        Reading the swept profile is what makes this honest: the extrusion's
        width is the wall length along its own X axis and its position gives the
        start, so an angled wall keeps its angle. The previous fallback took the
        tessellation's bounding box, which snapped every wall to 0°/90°.

        Returns None when the shape is not an extruded area solid (then the
        caller must treat the element as geometry-only rather than guess).
        """
        try:
            representation = getattr(p, "Representation", None)
            if not representation:
                return None
            item = None
            for r in getattr(representation, "Representations", []) or []:
                ident = (getattr(r, "RepresentationIdentifier", "") or "").lower()
                if ident in ("body", "model", ""):
                    for candidate in getattr(r, "Items", []) or []:
                        if candidate.is_a("IfcExtrudedAreaSolid"):
                            item = candidate
                            break
                if item is not None:
                    break
            if item is None:
                return None

            profile = getattr(item, "SweptArea", None)
            if profile is None:
                return None
            position = getattr(item, "Position", None)
            if position is None or getattr(position, "Location", None) is None:
                return None

            # Local axes of the extrusion, in the product's own frame. `Position`
            # here is an IfcAxis2Placement3D, so it must be parsed with
            # get_axis2placement — get_local_placement only accepts
            # IfcLocalPlacement. The extrusion is expressed in the wall's local
            # frame, so it has to be composed with the wall's own placement to
            # reach world coordinates (an earlier version skipped this and put
            # every wall at the origin).
            local_matrix = plc.get_axis2placement(position)
            product_matrix = (
                plc.get_local_placement(p.ObjectPlacement) if getattr(p, "ObjectPlacement", None) is not None
                else np.identity(4)
            )
            matrix = product_matrix @ local_matrix

            # Extent along the extrusion's own X axis (the wall's run) and along
            # its Y axis (the thickness). Both come from the profile's bounds,
            # which is exact for the extruded solids exporters emit.
            coords: List[Tuple[float, float]] = []
            if profile.is_a("IfcArbitraryClosedProfileDef"):
                curve = getattr(profile, "OuterCurve", None)
                for pt in (getattr(curve, "Points", None) or []):
                    # Three shapes are observed in the wild, so normalise them all:
                    #   IfcCartesianPoint entity   -> pt.Coordinates
                    #   a coordinate tuple         -> pt itself, e.g. (1.0, 2.0)
                    #   a nested sequence of points (some writers) -> recurse one level
                    c = getattr(pt, "Coordinates", pt)
                    if c is not None and len(c) and isinstance(c[0], (tuple, list)):
                        for inner in c:
                            if len(inner) >= 2:
                                coords.append((float(inner[0]), float(inner[1])))
                    elif c is not None and len(c) >= 2:
                        coords.append((float(c[0]), float(c[1])))
            elif profile.is_a("IfcRectangleProfileDef"):
                hx = float(getattr(profile, "XDim", 0.0)) / 2.0
                hy = float(getattr(profile, "YDim", 0.0)) / 2.0
                coords = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
            if len(coords) < 2:
                return None

            xs = [c[0] for c in coords]
            ys = [c[1] for c in coords]
            run = max(xs) - min(xs)
            thickness = max(ys) - min(ys)
            if run <= 1e-6:
                return None

            # The profile's mid-thickness line is the baseline.
            centre_y = (min(ys) + max(ys)) / 2.0
            a_local = np.array([min(xs), centre_y, 0.0])
            b_local = np.array([max(xs), centre_y, 0.0])
            a_world = (matrix @ np.append(a_local, 1.0))[:3] * unit_scale
            b_world = (matrix @ np.append(b_local, 1.0))[:3] * unit_scale
            return {
                "start": [float(a_world[0]), float(a_world[1]), float(fallback_z)],
                "end": [float(b_world[0]), float(b_world[1]), float(fallback_z)],
                "length": float(run * unit_scale),
                "thickness": float(thickness * unit_scale) if thickness > 1e-6 else None,
            }
        except Exception:
            return None

    def load_ifc_file(self, file_path: str, filename: str = "Imported.ifc") -> Dict[str, Any]:
        """Loads IFC model directly from a file path and sets up the active scene."""
        self.model = ifcopenshell.open(file_path)
        # Per-element reconstruction quality for foreign files (P2-G). Kept on the
        # instance so callers can surface which elements are geometry-only.
        self.import_report: Dict[str, Any] = {
            "source": os.path.basename(filename),
            "parametrized": [],
            "geometry_only": [],
            "levels": 0,
            "grids": 0,
        }
        bbox_derived_walls: List[str] = []

        # 1. Project metadata
        projects = self.model.by_type("IfcProject")
        if projects:
            self.project = projects[0]
            self.project_name = self.project.Name or os.path.splitext(os.path.basename(filename))[0]
        else:
            self.project = None
            self.project_name = os.path.splitext(os.path.basename(filename))[0]

        sites = self.model.by_type("IfcSite")
        self.site = sites[0] if sites else None
        buildings = self.model.by_type("IfcBuilding")
        self.building = buildings[0] if buildings else None

        # 2. Reset containers
        self.element_meta = {}
        self.levels = {}
        self.constraints = {}
        self.undo_stack = []
        self.redo_stack = []
        self.mesh_revs = {}
        self.dirty_mesh_guids = set()
        self.removed_guids_by_rev = {}
        self._pending_removed_guids = []
        self.removed_items_by_rev = {}
        self._pending_removed_items = []

        # New epoch ID and bump all section revisions on file load (N1)
        self.doc_id = str(uuid.uuid4())
        self.levels_rev += 1
        self.grids_rev += 1
        self.sheets_rev += 1
        self.views_rev += 1
        self.constraints_rev += 1
        self.wall_joins_rev += 1
        self.project_rev += 1

        # 3. Storeys (Levels)
        #
        # `IfcBuildingStorey.Elevation` is a length in the FILE's unit (metres for a
        # metric IFC) while levels are decimal feet internally, so it must be
        # converted. Read raw, a -55.67 m storey became -55.67 ft — wrong by 3.28x.
        metres_per_unit = unit_util.calculate_unit_scale(self.model) or 1.0
        unit_scale = metres_per_unit / METRES_PER_FOOT

        storeys = self.model.by_type("IfcBuildingStorey")
        for storey in storeys:
            elevation = 0.0
            if hasattr(storey, "Elevation") and storey.Elevation is not None:
                try:
                    elevation = float(storey.Elevation) * unit_scale
                except Exception:
                    elevation = 0.0
            self.levels[storey.GlobalId] = {
                "id": storey.GlobalId,
                "name": storey.Name or f"Level {len(self.levels) + 1}",
                "elevation": elevation,
                "entity": storey,
            }

        # Which storey each element belongs to, from the file's own spatial
        # containment. Without this every element has `level_id = None`, so a floor
        # plan cannot be built for any level: the view has no way to know what belongs
        # to it. Assigning from `IfcRelContainedInSpatialStructure` is exact, unlike
        # guessing from z, which fails outright on a georeferenced model where the
        # storey elevations and the element coordinates are in different spaces.
        element_level: Dict[str, str] = {}
        storey_members: Dict[str, List[str]] = {}
        for rel in self.model.by_type("IfcRelContainedInSpatialStructure"):
            structure = getattr(rel, "RelatingStructure", None)
            if structure is None or not structure.is_a("IfcBuildingStorey"):
                continue
            level_id = structure.GlobalId
            if level_id not in self.levels:
                continue
            for product in (getattr(rel, "RelatedElements", None) or []):
                guid = getattr(product, "GlobalId", None)
                if guid:
                    element_level[guid] = level_id
                    storey_members.setdefault(level_id, []).append(guid)

        if not self.levels:
            self.levels["level_1"] = {
                "id": "level_1",
                "name": "Level 1",
                "elevation": 0.0,
            }
            self.levels["level_2"] = {
                "id": "level_2",
                "name": "Level 2",
                "elevation": FEET_10,
            }
            self.levels["roof"] = {
                "id": "roof",
                "name": "Roof",
                "elevation": 6.0,
            }

        # 4. Grids
        # Raw IFC attribute values are expressed in the *file's* unit (a metric
        # sample gives metres, our own foot-based export gives feet — verified
        # against both). `calculate_unit_scale` returns that unit in metres, so
        # converting a raw value into the internal decimal feet is:
        #     raw * metres_per_unit  ->  metres  ->  / METRES_PER_FOOT -> feet
        # which is the metres-per-unit divided by metres-per-foot.
        #
        # Note the asymmetry with the *build* path: ifcopenshell's geometry
        # usecases (`add_profile_representation`, `add_axis_curve`) take SI values
        # and convert to the file unit themselves, while `edit_object_placement`
        # takes file units when `is_si=False`. Hence creation passes SI/foot
        # values as those usecases expect, and only the read path scales here.
        # The IFC is authored uniformly in SI metres (see `si()` for why), so every
        # geometry value read back is SI and converts to the internal decimal feet
        # with the same factor. `metres_per_unit` is only needed to interpret a
        # *foreign* file that is itself imperial.
        # Raw IFC values are in the file's own unit. Convert into the internal
        # decimal feet: metres (our own files, and most foreign ones) -> feet.
        metres_per_unit = unit_util.calculate_unit_scale(self.model) or 1.0
        unit_scale = metres_per_unit / METRES_PER_FOOT
        grid_unit_scale = unit_scale
        seen_grid_tags = set()
        for grid in self.model.by_type("IfcGrid"):
            grid_guid = grid.GlobalId
            grid_matrix = plc.get_local_placement(grid.ObjectPlacement) if grid.ObjectPlacement else None
            axes = list(grid.UAxes or []) + list(grid.VAxes or []) + list(getattr(grid, "WAxes", []) or [])
            for axis_index, axis in enumerate(axes):
                tag = axis.AxisTag or "1"
                curve = axis.AxisCurve
                if curve and curve.is_a("IfcPolyline") and len(curve.Points) >= 2:
                    pts = [list(p.Coordinates) + [0.0, 1.0] for p in curve.Points[:2]]
                    if grid_matrix is not None:
                        w_pts = [grid_matrix.dot(p)[:2] * grid_unit_scale for p in pts]
                    else:
                        w_pts = [p[:2] for p in pts]
                    sp = [float(w_pts[0][0]), float(w_pts[0][1])]
                    ep = [float(w_pts[1][0]), float(w_pts[1][1])]
                    sig = (grid_guid, tag, round(sp[0], 1), round(sp[1], 1), round(ep[0], 1), round(ep[1], 1))
                    if sig in seen_grid_tags:
                        continue
                    seen_grid_tags.add(sig)
                    # Address a grid by its real GlobalId. This used to mint
                    # `f"{guid}_{tag}_{n}"`, which meant the overlay could never
                    # match an imported grid back to its IFC entity — staleness
                    # gating then discarded every grid on load (finding N15).
                    # Only a grid with several axes needs a derived id, and then
                    # it is derived from the axis's own identity.
                    axis_guid = (
                        grid_guid if len(axes) == 1
                        else f"{grid_guid}_{tag}_{axis_index}"
                    )
                    self.element_meta[axis_guid] = {
                        "entity": grid,
                        "guid": axis_guid,
                        "ifc_class": "IfcGrid",
                        "name": f"Grid {tag}",
                        "tag": tag,
                        "start": sp,
                        "end": ep,
                    }

        # 4b. Reconcile storey elevations with where the geometry actually is.
        #
        # A georeferenced file (a real Revit export) places geometry in WORLD coordinates
        # — this house sits at z ~= 553 m — while `IfcBuildingStorey.Elevation` is
        # relative to the project datum (-19.5 m for the same floor). Reading one against
        # the other puts the cut plane ~560 m above the building, so a level cut sections
        # empty space and the plan comes back with no cut linework at all.
        #
        # Rather than shifting the model (which would move the user's building), each
        # storey is re-anchored on the lowest z of its own contained elements, and the
        # RELATIVE spacing between storeys — which the file does state correctly — is
        # applied on top. That keeps plans correct without touching geometry.
        if storey_members and unit_scale:
            import ifcopenshell.util.placement as _plc

            bottoms: Dict[str, float] = {}
            for level_id, guids in storey_members.items():
                zs: List[float] = []
                for guid in guids:
                    product = self.model.by_guid(guid)
                    if product is None or not getattr(product, "ObjectPlacement", None):
                        continue
                    try:
                        matrix = _plc.get_local_placement(product.ObjectPlacement)
                        z = matrix[2][3]
                    except Exception:
                        continue
                    if z == z == float(z):  # not NaN
                        zs.append(float(z))
                if zs:
                    bottoms[level_id] = min(zs) * unit_scale

            if bottoms:
                ordered = sorted(
                    ((lid, self.levels[lid].get("elevation", 0.0)) for lid in bottoms),
                    key=lambda pair: pair[1],
                )
                # Anchor the lowest storey on the lowest real geometry; keep the file's
                # relative spacing for the rest.
                base_level, base_relative = ordered[0]
                offset = bottoms[base_level] - float(base_relative)
                for level_id, _relative in ordered:
                    if level_id in self.levels:
                        self.levels[level_id]["elevation"] = float(
                            self.levels[level_id].get("elevation", 0.0)
                        ) + offset
                self.level_datums = {
                    "reconciled": True,
                    "offset": offset,
                    "reason": "georeferenced geometry vs relative storey elevations",
                }

        # 5. Map Voids and Fills for door/window hosting
        wall_to_voids: Dict[str, List[str]] = {}
        for rel in self.model.by_type("IfcRelVoidsElement"):
            if hasattr(rel, "RelatingBuildingElement") and hasattr(rel, "RelatedOpeningElement"):
                w_guid = rel.RelatingBuildingElement.GlobalId
                op_guid = rel.RelatedOpeningElement.GlobalId
                wall_to_voids.setdefault(w_guid, []).append(op_guid)

        opening_to_filling: Dict[str, str] = {}
        for rel in self.model.by_type("IfcRelFillsElement"):
            if hasattr(rel, "RelatingOpeningElement") and hasattr(rel, "RelatedBuildingElement"):
                op_guid = rel.RelatingOpeningElement.GlobalId
                fill_guid = rel.RelatedBuildingElement.GlobalId
                opening_to_filling[op_guid] = fill_guid

        wall_to_fills: Dict[str, List[str]] = {}
        filling_to_wall: Dict[str, str] = {}
        for w_guid, op_guids in wall_to_voids.items():
            for op_guid in op_guids:
                fill_guid = opening_to_filling.get(op_guid)
                if fill_guid:
                    wall_to_fills.setdefault(w_guid, []).append(fill_guid)
                    filling_to_wall[fill_guid] = w_guid

        # 6. Extract Products with IfcGeom
        settings = ifcopenshell.geom.settings()
        settings.set(settings.USE_WORLD_COORDS, True)

        for p in self.model.by_type("IfcProduct"):
            if p.is_a("IfcOpeningElement") or p.is_a("IfcSpatialStructureElement") or p.is_a("IfcGrid"):
                continue

            guid = p.GlobalId
            name = p.Name or p.is_a()
            ifc_class = p.is_a()

            raw_verts, raw_faces = [], []
            min_x, max_x, min_y, max_y, min_z, max_z = 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
            try:
                shape = self._get_product_shape(settings, p)
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

            # `raw_verts` come from a world-coordinate shape, which is METRIC (see the
            # units boundary: the IFC is metres, internals are decimal feet). Every use
            # of dx/dy/dz below is in feet — thresholds like `width < 0.4` and the
            # `max(dz, FEET_10)` default — so they must be converted here. Left raw, an
            # imported 48" window came back as 1.40 (metres read as feet), i.e. every
            # imported opening was drawn 3.28x too small.
            dx = (max_x - min_x) * unit_scale
            dy = (max_y - min_y) * unit_scale
            dz = (max_z - min_z) * unit_scale
            # The cached tessellation is NOT converted here. Every mesh in the app is
            # produced from the IFC representation by `_build_element_mesh`, which
            # converts once at that boundary — converting here as well would apply the
            # factor twice. See `_build_element_mesh`.
            min_x, max_x = min_x * unit_scale, max_x * unit_scale
            min_y, max_y = min_y * unit_scale, max_y * unit_scale
            min_z, max_z = min_z * unit_scale, max_z * unit_scale

            meta: Dict[str, Any] = {
                "entity": p,
                "guid": guid,
                "ifc_class": ifc_class,
                "name": name,
                # Its storey, from the file's own containment. A floor plan view and
                # the per-level cut plane both depend on this.
                "level_id": element_level.get(guid),
                "bbox": {"min": [min_x, min_y, min_z], "max": [max_x, max_y, max_z]},
            }
            # Raw shape vertices are already in the file's unit, which is exactly what
            # the cache stores, so no conversion: `in_feet=False`. (The in-memory model
            # is metres, hence `_metres_per_unit()` is 1.0; `unit_scale` describes the
            # *imported* file and must not be applied a second time.)
            self.element_meta[guid] = meta
            self._cache_verts(guid, raw_verts, raw_faces, in_feet=False)

            if ifc_class in ("IfcWall", "IfcWallStandardCase"):
                profile_thickness: Optional[float] = None
                # Check for Axis representation first (Revit & IFC standard centerline)
                matrix = plc.get_local_placement(p.ObjectPlacement) if p.ObjectPlacement else None
                axis_rep = None
                if hasattr(p, "Representation") and p.Representation:
                    for r in getattr(p.Representation, "Representations", []):
                        if (getattr(r, "RepresentationIdentifier", "") or "").lower() == "axis":
                            axis_rep = r
                            break

                sp, ep = None, None
                if axis_rep and getattr(axis_rep, "Items", None) and matrix is not None:
                    curve = axis_rep.Items[0]
                    if hasattr(curve, "Points") and len(curve.Points) >= 2:
                        pts = [list(pt.Coordinates) + [0.0, 1.0] for pt in curve.Points[:2]]
                        w_pts = [matrix.dot(pt)[:3] * unit_scale for pt in pts]
                        sp = [float(w_pts[0][0]), float(w_pts[0][1]), float(min_z)]
                        ep = [float(w_pts[1][0]), float(w_pts[1][1]), float(min_z)]

                if sp is None or ep is None or math.hypot(ep[0] - sp[0], ep[1] - sp[1]) < 0.05:
                    # No usable Axis curve (the export omitted it, as many do).
                    # Read the extruded profile instead of the bounding box so an
                    # angled wall keeps its angle.
                    from_profile = self._wall_from_extruded_profile(p, unit_scale, min_z)
                    if from_profile is not None:
                        sp = from_profile["start"]
                        ep = from_profile["end"]
                        if from_profile.get("thickness"):
                            profile_thickness = from_profile["thickness"]
                        else:
                            profile_thickness = None
                    else:
                        # Nothing parametric to read: reconstruct an axis through
                        # the bbox centre and record that this is derived, not
                        # recovered.
                        if dx >= dy:
                            sp = [min_x, (min_y + max_y) / 2.0, min_z]
                            ep = [max_x, (min_y + max_y) / 2.0, min_z]
                        else:
                            sp = [(min_x + max_x) / 2.0, min_y, min_z]
                            ep = [(min_x + max_x) / 2.0, max_y, min_z]
                        bbox_derived_walls.append(guid)

                length = math.hypot(ep[0] - sp[0], ep[1] - sp[1])
                angle = math.atan2(ep[1] - sp[1], ep[0] - sp[0])

                # Thickness from MaterialLayerSet or psets
                thickness = 0.20
                try:
                    mat = elem_util.get_material(p)
                    if mat:
                        mls = getattr(mat, "ForLayerSet", mat)
                        if mls and hasattr(mls, "MaterialLayers"):
                            thickness = sum(l.LayerThickness for l in mls.MaterialLayers) * unit_scale
                except Exception:
                    pass

                resolved_thickness = profile_thickness or thickness
                meta.update({
                    "start": sp,
                    "end": ep,
                    "thickness": max(resolved_thickness, 0.10),
                    "height": max(dz, FEET_10),
                    "length": length,
                    "angle": angle,
                    "parametrized": guid not in bbox_derived_walls,
                    "hosted_openings": wall_to_fills.get(guid, []),
                })

            elif ifc_class in ("IfcDoor", "IfcWindow"):
                host_w_guid = filling_to_wall.get(guid)
                width = math.hypot(dx, dy) if (dx > 0 and dy > 0) else max(dx, dy)
                if width < 0.4:
                    width = 0.90
                meta.update({
                    "host_wall_guid": host_w_guid,
                    "width": width,
                    "height": max(dz, 1.0),
                    "offset_along_wall": 0.0,
                    "swing_flipped": False,
                })

            elif ifc_class in ("IfcSlab", "IfcRoof"):
                # Prefer the real profile over a tessellation hull: a hull of the
                # triangulation loses concavity and any interior boundary, so a
                # non-rectangular floor came back as its outline rectangle.
                profile_data = self._extruded_profile(p)
                footprint: Optional[List[List[float]]] = None
                profile_thickness_2d: Optional[float] = None
                if profile_data is not None:
                    lm = profile_data["local_matrix"]
                    translation = self._product_translation(p)
                    # The extrusion is expressed in the product's frame. Recover
                    # world coordinates exactly when the product placement is a
                    # pure translation (what exporters emit for a level-based
                    # slab); if the product is rotated, the profile is rotated too
                    # and this falls back to the hull rather than guessing.
                    rot = lm[:2, :2]
                    is_axis_aligned = (
                        abs(rot[0][1]) < 1e-9 and abs(rot[1][0]) < 1e-9
                    )
                    if is_axis_aligned:
                        lx = float(lm[0, 3]) * unit_scale
                        ly = float(lm[1, 3]) * unit_scale
                        footprint = [
                            [
                                float(cx) * unit_scale + lx + float(translation[0]) * unit_scale,
                                float(cy) * unit_scale + ly + float(translation[1]) * unit_scale,
                            ]
                            for cx, cy in profile_data["coords"]
                        ]
                        profile_thickness_2d = profile_data["depth"] * unit_scale or None

                if footprint is None:
                    pts_2d = [(raw_verts[i], raw_verts[i + 1]) for i in range(0, len(raw_verts), 3)] if raw_verts else []
                    footprint = self._get_2d_hull(pts_2d) if len(pts_2d) >= 3 else [
                        [min_x, min_y],
                        [max_x, min_y],
                        [max_x, max_y],
                        [min_x, max_y],
                    ]
                    meta["parametrized"] = False
                    meta["parametrized_note"] = (
                        "profile could not be read in world coordinates; footprint is a "
                        "hull of the tessellation"
                    )

                if ifc_class == "IfcSlab":
                    meta.update({
                        "thickness": profile_thickness_2d or max(dz, INCHES_4),
                        "elevation": min_z,
                        "polygon": footprint,
                    })
                else:
                    span = min(dx, dy) / 2.0 if min(dx, dy) > 0.1 else 1.0
                    est_pitch = math.degrees(math.atan2(dz, span)) if dz > 0.4 else 0.0
                    meta.update({
                        "thickness": profile_thickness_2d or max(min(dz, 0.4), 0.2),
                        "elevation": min_z,
                        "pitch": round(est_pitch, 1),
                        "polygon": footprint,
                    })

            # `meta` is already registered above, together with its cached tessellation.

        # Second pass: calculate offset_along_wall for doors and windows
        for guid, meta in self.element_meta.items():
            if meta.get("ifc_class") in ("IfcDoor", "IfcWindow"):
                host_guid = meta.get("host_wall_guid")
                if host_guid and host_guid in self.element_meta:
                    h_meta = self.element_meta[host_guid]
                    h_start = h_meta.get("start", [0, 0, 0])
                    h_ang = h_meta.get("angle", 0.0)
                    h_len = h_meta.get("length", 1.0)
                    b_min = meta.get("bbox", {}).get("min", [0, 0, 0])
                    b_max = meta.get("bbox", {}).get("max", [0, 0, 0])
                    cx = (b_min[0] + b_max[0]) / 2.0
                    cy = (b_min[1] + b_max[1]) / 2.0
                    w = meta.get("width", 0.90)
                    # Project opening center onto wall baseline direction
                    proj = (cx - h_start[0]) * math.cos(h_ang) + (cy - h_start[1]) * math.sin(h_ang)
                    offset = max(0.0, min(max(0.0, h_len - w), proj - (w / 2.0)))
                    meta["offset_along_wall"] = offset
                    # The bbox-centre projection is exact for an axis-aligned host
                    # and approximate on an angled one, so only claim to have
                    # recovered a parametric opening when the host is axis-aligned.
                    meta["parametrized"] = abs(math.sin(h_ang)) < 1e-9 or abs(math.cos(h_ang)) < 1e-9
                    if not meta["parametrized"]:
                        meta["parametrized_note"] = (
                            "host is not axis-aligned; offset recovered by projecting the "
                            "opening's bounding-box centre onto the baseline"
                        )
                    if guid not in h_meta.get("hosted_openings", []):
                        h_meta.setdefault("hosted_openings", []).append(guid)

        # Load constraints if present in IFC
        self.load_constraints_from_ifc()

        # Foreign-import quality report (P2-G). "Parametrized" means the element
        # carries a real baseline/polygon recovered from IFC parameters;
        # "geometry_only" means its solid loaded but its parametric definition
        # could not be recovered, so it cannot be edited as a parametric object.
        for guid, meta in self.element_meta.items():
            entry = {
                "guid": guid,
                "ifc_class": meta.get("ifc_class"),
                "name": meta.get("name"),
            }
            if meta.get("ifc_class") == "IfcGrid":
                self.import_report["grids"] += 1
            if meta.get("parametrized") is False:
                entry["reason"] = meta.get("parametrized_note") or (
                    "no axis/profile representation; baseline derived from bounding box"
                )
                self.import_report["geometry_only"].append(entry)
            elif (
                meta.get("start")
                or meta.get("polygon")
                or meta.get("ifc_class") == "IfcGrid"
                or (meta.get("host_wall_guid") and meta.get("offset_along_wall") is not None)
            ):
                # An opening is fully parametric once its host and offset are
                # known; that is the same definition the overlay stores for it.
                self.import_report["parametrized"].append(entry)
            else:
                entry["reason"] = "no recoverable parametric definition"
                self.import_report["geometry_only"].append(entry)
        self.import_report["levels"] = len(self.levels)

        return {
            "status": "loaded",
            "project_name": self.project_name,
            "elements_count": len(self.element_meta),
            "levels_count": len(self.levels),
            "grids_count": self.import_report["grids"],
            "import_report": self.import_report,
        }


# Singleton instance for sidecar
bim_manager = BimModelManager()

