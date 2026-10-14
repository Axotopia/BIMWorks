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
        ifcopenshell.api.run(
            "unit.assign_unit", self.model, length={"is_metric": True, "raw": "METERS"}
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

        # Storeys (Levels)
        self.levels: Dict[str, Any] = {}
        self.add_level("Level 1", 0.0)
        self.add_level("Level 2", 3.0)
        self.add_level("Roof", 6.0)

        # Elements internal tracking
        self.element_meta: Dict[str, Dict[str, Any]] = {}
        self.undo_stack: List[str] = []
        self.redo_stack: List[str] = []

        # 1D/2D Parametric Constraints Manager
        self.constraints: Dict[str, Dict[str, Any]] = {}

        # Wall Join Policies (Butt / Miter / Square-off and per-endpoint allowJoin)
        self.join_policies: Dict[str, Dict[str, Any]] = {}

        # Default Georeferencing (EPSG:2285 - NAD83 / Washington North)
        self.georeference_data = {
            "projected_crs": "EPSG:2285 - NAD83 / Washington North",
            "eastings": 1275432.10,
            "northings": 234567.89,
            "elevation": 45.0,
            "true_north": 12.5,  # degrees
            "scale": 1.0,
        }
        self.apply_georeferencing()
        self.load_constraints_from_ifc()

    # ------------------------------------------------------------------
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
            "georeference_data": copy.deepcopy(self.georeference_data),
            "project_name": self.project_name,
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
        self.georeference_data = copy.deepcopy(snap["georeference_data"])
        self.project_name = snap["project_name"]

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
        return level_id

    def apply_georeferencing(self):
        """Applies buildingSMART IFC4 IfcProjectedCRS and IfcMapConversion."""
        try:
            angle_rad = math.radians(self.georeference_data["true_north"])
            cos_a = math.cos(angle_rad)
            sin_a = math.sin(angle_rad)

            ifcopenshell.api.run("georeference.add_georeferencing", self.model, name=self.georeference_data["projected_crs"])
            ifcopenshell.api.run(
                "georeference.edit_georeferencing",
                self.model,
                projected_crs={"Name": self.georeference_data["projected_crs"]},
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
        if storey_id and storey_id in self.levels:
            return self.levels[storey_id]["entity"]
        # Default to Level 1
        for lvl in self.levels.values():
            if lvl["elevation"] == 0.0 or "Level 1" in lvl["name"]:
                return lvl["entity"]
        return list(self.levels.values())[0]["entity"]

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
        # world position = baseline start + offset along u + local_y along the normal
        matrix[0, 3] = float(sp[0]) + ux * offset_along_wall - uy * local_y
        matrix[1, 3] = float(sp[1]) + uy * offset_along_wall + ux * local_y
        matrix[2, 3] = base_z + local_z
        return matrix

    def add_wall(
        self,
        start_pt: Tuple[float, float, float],
        end_pt: Tuple[float, float, float],
        height: float = 3.0,
        thickness: float = 0.2,
        level_id: Optional[str] = None,
        name: str = "Basic Wall : Exterior - 8\" CMU",
        wall_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Creates an IfcWallStandardCase defined by 2D baseline, height, and thickness.
        Places wall in spatial structure and computes representation.
        """
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
        guid = wall.GlobalId

        ifcopenshell.api.run(
            "spatial.assign_container", self.model, relating_structure=storey, products=[wall]
        )

        # 3D Extrusion representation
        rep = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            self.model,
            context=self.context_body,
            length=float(length),
            height=float(height),
            thickness=float(thickness),
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
        matrix[0, 3] = start_pt[0]
        matrix[1, 3] = start_pt[1]
        matrix[2, 3] = start_pt[2] if len(start_pt) > 2 else base_z

        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=wall, matrix=matrix
        )

        meta = {
            "guid": guid,
            "ifc_class": "IfcWallStandardCase",
            "name": name,
            "start": list(start_pt),
            "end": list(end_pt),
            "length": length,
            "height": height,
            "thickness": thickness,
            "angle": angle,
            "level_id": storey.GlobalId,
            "hosted_openings": [],
            "entity": wall,
            "type_properties": {
                "Type Name": name,
                "Thickness": f"{int(thickness * 1000)} mm",
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
        self.recompute_wall_joins()
        return meta

    def add_door(
        self,
        host_wall_guid: str,
        offset_along_wall: float,
        width: float = 0.95,
        height: float = 2.1,
        name: str = "Single Flush : 36\" x 84\"",
        swing_flipped: bool = False,
    ) -> Dict[str, Any]:
        """
        Creates an IfcDoor hosted inside host wall.
        Instantiates IfcOpeningElement, establishes IfcRelVoidsElement and IfcRelFillsElement.
        """
        if host_wall_guid not in self.element_meta:
            raise ValueError(f"Host wall {host_wall_guid} not found.")

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
            length=float(width),
            height=float(height),
            thickness=float(wall_thickness + 0.1),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=opening, representation=op_rep
        )

        # Placement follows the host wall's own baseline/angle (world coords).
        op_matrix = self._hosted_placement_matrix(wall_meta, offset_along_wall, local_y=-0.05)
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=opening, matrix=op_matrix
        )

        # Cut the wall
        ifcopenshell.api.run("feature.add_feature", self.model, feature=opening, element=wall)

        # 2. Create Door element
        door = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcDoor", name=name
        )
        door_guid = door.GlobalId
        storey = self.get_storey_by_id(wall_meta["level_id"])
        ifcopenshell.api.run(
            "spatial.assign_container", self.model, relating_structure=storey, products=[door]
        )

        # Door 3D panel representation
        door_rep = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            self.model,
            context=self.context_body,
            length=float(width),
            height=float(height),
            thickness=0.045,  # 45mm panel
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=door, representation=door_rep
        )
        door_matrix = self._hosted_placement_matrix(wall_meta, offset_along_wall, local_y=0.0)
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=door, matrix=door_matrix
        )

        # Link door as filling of opening
        ifcopenshell.api.run("feature.add_filling", self.model, opening=opening, element=door)

        door_meta = {
            "guid": door_guid,
            "opening_guid": opening_guid,
            "ifc_class": "IfcDoor",
            "name": name,
            "host_wall_guid": host_wall_guid,
            "offset_along_wall": offset_along_wall,
            "width": width,
            "height": height,
            "swing_flipped": swing_flipped,
            "entity": door,
            "opening_entity": opening,
            "type_properties": {
                "Type Name": name,
                "Width": f"{int(width * 1000)} mm",
                "Height": f"{int(height * 1000)} mm",
                "Fire Rating": "90 MIN",
                "Operation": "Single Swing Left",
            },
        }
        self.element_meta[door_guid] = door_meta
        wall_meta["hosted_openings"].append(door_guid)
        return door_meta

    def add_window(
        self,
        host_wall_guid: str,
        offset_along_wall: float,
        width: float = 1.2,
        height: float = 1.2,
        sill_height: float = 0.9,
        name: str = "Fixed Window : 48\" x 48\"",
    ) -> Dict[str, Any]:
        """Creates an IfcWindow hosted in wall with automated IfcOpeningElement."""
        if host_wall_guid not in self.element_meta:
            raise ValueError(f"Host wall {host_wall_guid} not found.")

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
            length=float(width),
            height=float(height),
            thickness=float(wall_thickness + 0.1),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=opening, representation=op_rep
        )

        op_matrix = self._hosted_placement_matrix(
            wall_meta, offset_along_wall, local_y=-0.05, local_z=sill_height
        )
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=opening, matrix=op_matrix
        )

        ifcopenshell.api.run("feature.add_feature", self.model, feature=opening, element=wall)

        # 2. Window
        window = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcWindow", name=name
        )
        win_guid = window.GlobalId
        storey = self.get_storey_by_id(wall_meta["level_id"])
        ifcopenshell.api.run(
            "spatial.assign_container", self.model, relating_structure=storey, products=[window]
        )

        win_rep = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            self.model,
            context=self.context_body,
            length=float(width),
            height=float(height),
            thickness=0.06,  # 60mm frame
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=window, representation=win_rep
        )
        win_matrix = self._hosted_placement_matrix(
            wall_meta, offset_along_wall, local_y=0.0, local_z=sill_height
        )
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=window, matrix=win_matrix
        )

        ifcopenshell.api.run("feature.add_filling", self.model, opening=opening, element=window)

        win_meta = {
            "guid": win_guid,
            "opening_guid": opening_guid,
            "ifc_class": "IfcWindow",
            "name": name,
            "host_wall_guid": host_wall_guid,
            "offset_along_wall": offset_along_wall,
            "width": width,
            "height": height,
            "sill_height": sill_height,
            "entity": window,
            "opening_entity": opening,
            "type_properties": {
                "Type Name": name,
                "Width": f"{int(width * 1000)} mm",
                "Height": f"{int(height * 1000)} mm",
                "Sill Height": f"{int(sill_height * 1000)} mm",
                "Glazing": "Double Glazed Low-E",
            },
        }
        self.element_meta[win_guid] = win_meta
        wall_meta["hosted_openings"].append(win_guid)
        return win_meta

    def add_slab(
        self,
        polygon_pts: List[Tuple[float, float]],
        thickness: float = 0.25,
        elevation: float = 0.0,
        level_id: Optional[str] = None,
        name: str = "Floor : 10\" Concrete Slab",
    ) -> Dict[str, Any]:
        """Creates an IfcSlab with boundary polygon."""
        storey = self.get_storey_by_id(level_id)
        slab = ifcopenshell.api.run("root.create_entity", self.model, ifc_class="IfcSlab", name=name)
        guid = slab.GlobalId

        ifcopenshell.api.run(
            "spatial.assign_container", self.model, relating_structure=storey, products=[slab]
        )

        # Compute bounding rectangle for basic representation or custom profile
        xs = [p[0] for p in polygon_pts]
        ys = [p[1] for p in polygon_pts]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        w = max_x - min_x
        l = max_y - min_y

        rep = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            self.model,
            context=self.context_body,
            length=float(w),
            height=float(thickness),
            thickness=float(l),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=slab, representation=rep
        )

        matrix = np.identity(4)
        matrix[0, 3] = min_x
        matrix[1, 3] = min_y
        matrix[2, 3] = elevation - thickness  # top of slab at elevation
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=slab, matrix=matrix
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
                "Thickness": f"{int(thickness * 1000)} mm",
                "Material": "Cast-in-Place Concrete",
                "Structural": "True",
            },
        }
        self.element_meta[guid] = meta
        return meta

    def add_roof(
        self,
        polygon_pts: List[Tuple[float, float]],
        thickness: float = 0.3,
        elevation: float = 6.0,
        pitch_degrees: float = 15.0,
        level_id: Optional[str] = None,
        name: str = "Roof : Pitched Metal Deck",
    ) -> Dict[str, Any]:
        """Creates an IfcRoof."""
        storey = self.get_storey_by_id(level_id)
        roof = ifcopenshell.api.run("root.create_entity", self.model, ifc_class="IfcRoof", name=name)
        guid = roof.GlobalId

        ifcopenshell.api.run(
            "spatial.assign_container", self.model, relating_structure=storey, products=[roof]
        )

        xs = [p[0] for p in polygon_pts]
        ys = [p[1] for p in polygon_pts]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        w = max_x - min_x
        l = max_y - min_y

        rep = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            self.model,
            context=self.context_body,
            length=float(w),
            height=float(thickness),
            thickness=float(l),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=roof, representation=rep
        )

        matrix = np.identity(4)
        matrix[0, 3] = min_x
        matrix[1, 3] = min_y
        matrix[2, 3] = elevation
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=roof, matrix=matrix
        )

        meta = {
            "guid": guid,
            "ifc_class": "IfcRoof",
            "name": name,
            "polygon": polygon_pts,
            "thickness": thickness,
            "elevation": elevation,
            "pitch": pitch_degrees,
            "level_id": storey.GlobalId,
            "entity": roof,
            "type_properties": {
                "Type Name": name,
                "Pitch": f"{pitch_degrees}°",
                "Thickness": f"{int(thickness * 1000)} mm",
                "Finish": "Standing Seam Metal",
            },
        }
        self.element_meta[guid] = meta
        return meta

    def add_grid(
        self,
        axis_name: str,
        start_pt: Tuple[float, float],
        end_pt: Tuple[float, float],
    ) -> Dict[str, Any]:
        """Creates an architectural grid line."""
        grid_id = str(uuid.uuid4())
        meta = {
            "guid": grid_id,
            "ifc_class": "IfcGrid",
            "name": f"Grid {axis_name}",
            "tag": axis_name,
            "start": list(start_pt),
            "end": list(end_pt),
            "type_properties": {
                "Bubble": "Circle 1/4\"",
                "Lineweight": "0.25mm",
                "Line Pattern": "Centerline",
            },
        }
        self.element_meta[grid_id] = meta
        return meta

    def delete_element(self, guid: str) -> bool:
        """
        Deletes an element.
        If it's a hosted Door or Window: removes opening feature and heals the wall solid!
        If it's a wall: deletes hosted openings as well.
        """
        if guid not in self.element_meta:
            return False

        meta = self.element_meta[guid]
        ifc_class = meta.get("ifc_class")

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
        return True

    def translate_element(
        self, guid: str, dx: float, dy: float, dz: float = 0.0, visited: Optional[set] = None
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

        if ifc_class == "IfcWallStandardCase":
            meta["start"][0] += dx
            meta["start"][1] += dy
            meta["start"][2] += dz
            meta["end"][0] += dx
            meta["end"][1] += dy
            meta["end"][2] += dz
            translated = True
            # Rebuild join-trimmed geometry and placement from the new baseline
            self.recompute_wall_joins()

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
            opening = meta["opening_entity"]
            door_win = meta["entity"]
            sill = float(meta.get("sill_height", 0.0))

            op_matrix = self._hosted_placement_matrix(
                host_meta, meta["offset_along_wall"], local_y=-0.05, local_z=sill
            )
            ifcopenshell.api.run(
                "geometry.edit_object_placement", self.model, product=opening, matrix=op_matrix
            )

            dw_matrix = self._hosted_placement_matrix(
                host_meta, meta["offset_along_wall"], local_y=0.0, local_z=sill
            )
            ifcopenshell.api.run(
                "geometry.edit_object_placement", self.model, product=door_win, matrix=dw_matrix
            )
            translated = True

        elif ifc_class == "IfcGrid":
            meta["start"][0] += dx
            meta["start"][1] += dy
            meta["end"][0] += dx
            meta["end"][1] += dy
            translated = True

        # =====================================================================
        # CONSTRAINT PROPAGATION (Dependency Graph)
        # =====================================================================
        if translated:
            for cid, c in list(self.constraints.items()):
                # 1. Align & Lock: Reference moves -> locked target moves by identical delta
                if c.get("type") == "align" and c.get("is_locked", True):
                    if c.get("ref_guid") == guid:
                        target = c.get("target_guid")
                        if target and target not in visited:
                            self.translate_element(target, dx, dy, dz, visited)

                # 2. Locked Dimension: Rigid delta binding between referenced elements
                elif c.get("type") == "dimension_lock" and c.get("is_locked", True):
                    if c.get("guid_a") == guid:
                        other = c.get("guid_b")
                        if other and other not in visited:
                            self.translate_element(other, dx, dy, dz, visited)
                    elif c.get("guid_b") == guid:
                        other = c.get("guid_a")
                        if other and other not in visited:
                            self.translate_element(other, dx, dy, dz, visited)

        return translated

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

    def add_dimension_lock(
        self,
        guid_a: str,
        guid_b: str,
        locked_distance: Optional[float] = None,
        is_locked: bool = True,
        axis: str = "x",
    ) -> Dict[str, Any]:
        """Locks the dimension delta between two elements."""
        if guid_a not in self.element_meta or guid_b not in self.element_meta:
            raise ValueError("Element A or B not found.")

        if locked_distance is None:
            pos_a = self.get_element_coord(guid_a, axis)
            pos_b = self.get_element_coord(guid_b, axis)
            locked_distance = abs(pos_b - pos_a)

        cid = f"dimlock_{uuid.uuid4().hex[:8]}"
        constraint = {
            "id": cid,
            "type": "dimension_lock",
            "guid_a": guid_a,
            "guid_b": guid_b,
            "locked_distance": float(locked_distance),
            "axis": axis,
            "is_locked": is_locked,
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

        pos_start = self.get_element_coord(span_start_guid, axis)
        pos_end = self.get_element_coord(span_end_guid, axis)
        total_span = pos_end - pos_start

        num_segments = len(interior_guids) + 1
        spacing = total_span / num_segments

        # Reposition each interior element to equalized position
        for i, int_guid in enumerate(interior_guids):
            meta = self.element_meta.get(int_guid)
            if not meta:
                continue
            target_pos = pos_start + (i + 1) * spacing

            if meta.get("ifc_class") in ("IfcDoor", "IfcWindow"):
                # If hosted on a wall starting at (0,0), offset corresponds directly to spacing
                current_off = meta.get("offset_along_wall", 0.0)
                desired_off = (i + 1) * spacing - (meta.get("width", 1.0) / 2.0)
                delta_off = desired_off - current_off
                self.translate_element(int_guid, delta_off, 0.0, 0.0)
            else:
                curr_pos = self.get_element_coord(int_guid, axis)
                d = target_pos - curr_pos
                dx = d if axis == "x" else 0.0
                dy = d if axis == "y" else 0.0
                self.translate_element(int_guid, dx, dy, 0.0)

        cid = f"eq_{uuid.uuid4().hex[:8]}"
        constraint = {
            "id": cid,
            "type": "equalize",
            "span_start_guid": span_start_guid,
            "span_end_guid": span_end_guid,
            "interior_guids": interior_guids,
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

    def _wall_rect(self, meta):
        """Plain (untrimmed) rectangular footprint of a wall, world XY."""
        sp, ep = meta["start"], meta["end"]
        ang = meta["angle"]
        t = meta["thickness"]
        nx, ny = -math.sin(ang) * (t / 2.0), math.cos(ang) * (t / 2.0)
        return [
            (sp[0] + nx, sp[1] + ny),
            (ep[0] + nx, ep[1] + ny),
            (ep[0] - nx, ep[1] - ny),
            (sp[0] - nx, sp[1] - ny),
        ]

    def _find_join_partner(self, guid, end_index, walls):
        """Finds the wall connected at this endpoint.
        Returns (partner_guid, kind, partner_end_index) where kind is
        'corner' (endpoint-to-endpoint) or 'tee' (endpoint on baseline), or None."""
        meta = self.element_meta[guid]
        E = (meta["start"][0], meta["start"][1]) if end_index == 0 else (meta["end"][0], meta["end"][1])

        for other_guid, om in walls.items():
            if other_guid == guid:
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

    def recompute_wall_joins(self):
        """Global pass: recomputes trimmed footprint polygons for all walls
        from baseline + thickness + join policies, and rebuilds 3D
        representations where the footprint changed. Also refreshes placements."""
        walls = {
            g: m for g, m in self.element_meta.items()
            if m.get("ifc_class") == "IfcWallStandardCase" and "entity" in m
        }
        # creation order for deterministic butt "through wall" decisions
        order = {g: i for i, g in enumerate(self.element_meta.keys())}

        for guid, meta in walls.items():
            sp, ep = meta["start"], meta["end"]
            t = meta["thickness"]
            ang = meta["angle"]
            ux, uy = math.cos(ang), math.sin(ang)
            poly = self._wall_rect(meta)

            for end_index in (0, 1):
                policy = self.join_policies.get(guid, {}).get(
                    f"end{end_index}", {"allow_join": True, "mode": "butt"})
                if not policy.get("allow_join", True):
                    continue
                E = (sp[0], sp[1]) if end_index == 0 else (ep[0], ep[1])
                other = self._wall_rect_end_probe(meta, end_index)  # far-end centerline point
                far = other

                partner_guid, kind, oe = self._find_join_partner(guid, end_index, walls)
                if not partner_guid:
                    continue
                om = walls[partner_guid]

                if kind == "tee":
                    # Butt into the partner's face (square-off cut: our end
                    # stays square to our own wall).
                    poly = self._clip_to_partner_face(meta, poly, om, far, E, square_off=True)
                    continue

                # Corner join
                mode = policy.get("mode", "butt")
                oend_pol = self.join_policies.get(partner_guid, {}).get(
                    f"end{oe}", {"allow_join": True, "mode": "butt"})
                omode = oend_pol.get("mode", "butt")

                if mode == "miter" and omode == "miter":
                    uW = (far[0] - E[0], far[1] - E[1])
                    uXf = self._partner_far_point(om, oe)
                    uX = (uXf[0] - E[0], uXf[1] - E[1])
                    nw = math.hypot(*uW) or 1.0
                    nxm = math.hypot(*uX) or 1.0
                    uW = (uW[0] / nw, uW[1] / nw)
                    uX = (uX[0] / nxm, uX[1] / nxm)
                    dot = uW[0] * uX[0] + uW[1] * uX[1]
                    angle_deg = math.degrees(math.acos(max(-1.0, min(1.0, dot))))
                    if self._MITER_MIN_ANGLE <= angle_deg <= 180 - self._MITER_MIN_ANGLE:
                        # Miter line = internal bisector of the two into-wall
                        # directions through the shared point: it splits the
                        # overlap wedge evenly between the two walls.
                        bis = (uW[0] + uX[0], uW[1] + uX[1])
                        nb = math.hypot(*bis)
                        if nb > 1e-6:
                            poly = self._clip_poly_line(poly, E, (bis[0] / nb, bis[1] / nb), far)
                            continue
                if mode == "square_off":
                    poly = self._clip_to_partner_face(meta, poly, om, far, E, square_off=True)
                    continue

                # Butt: earlier-created wall runs through; later wall butts.
                if order.get(guid, 0) < order.get(partner_guid, 0):
                    continue  # we are the through wall — no trim
                poly = self._clip_to_partner_face(meta, poly, om, far, E, square_off=False)

            # Store footprint; rebuild representation if it changed
            new_fp = [[round(x, 6), round(y, 6)] for x, y in poly]
            if meta.get("footprint") != new_fp:
                meta["footprint"] = new_fp
                self._rebuild_wall_representation(guid)
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
        matrix[0, 3], matrix[1, 3], matrix[2, 3] = sp[0], sp[1], sp[2]
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=wall, matrix=matrix
        )

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
            profile=[[float(x), float(y)] for x, y in local],
            name=f"Wall-Footprint-{guid}",
        )
        # remove old representations
        old_rep = getattr(wall, "Representation", None)
        if old_rep is not None:
            for r in list(old_rep.Representations):
                try:
                    ifcopenshell.api.run(
                        "geometry.remove_representation", self.model, representation=r
                    )
                except Exception:
                    pass
        rep = ifcopenshell.api.run(
            "geometry.add_profile_representation",
            self.model,
            context=self.context_body,
            profile=profile,
            depth=float(meta["height"]),
        )
        ifcopenshell.api.run(
            "geometry.assign_representation", self.model, product=wall, representation=rep
        )
        meta["representation_entity"] = rep
        self._refresh_wall_placement(guid)

    def save_constraints_to_ifc(self):
        """
        Persists active constraint relationships into standard IFC4
        under custom property set Pset_ORLT_Constraints on IfcProject.
        """
        try:
            import json
            import ifcopenshell.api.pset

            payload = json.dumps(list(self.constraints.values()))
            pset = None
            for rel in getattr(self.project, "IsDefinedBy", []):
                if hasattr(rel, "RelatingPropertyDefinition"):
                    p_def = rel.RelatingPropertyDefinition
                    if hasattr(p_def, "Name") and p_def.Name == "Pset_ORLT_Constraints":
                        pset = p_def
                        break
            if not pset:
                pset = ifcopenshell.api.pset.add_pset(
                    self.model, product=self.project, name="Pset_ORLT_Constraints"
                )
            ifcopenshell.api.pset.edit_pset(
                self.model, pset=pset, properties={"ConstraintGraph": payload}
            )
        except Exception as e:
            print(f"Notice persisting constraints to IFC: {e}")

    def load_constraints_from_ifc(self):
        """Loads and deserializes active constraint graph from Pset_ORLT_Constraints."""
        try:
            import json
            for rel in getattr(self.project, "IsDefinedBy", []):
                if hasattr(rel, "RelatingPropertyDefinition"):
                    p_def = rel.RelatingPropertyDefinition
                    if hasattr(p_def, "Name") and p_def.Name == "Pset_ORLT_Constraints":
                        for prop in getattr(p_def, "HasProperties", []):
                            if prop.Name == "ConstraintGraph":
                                data = json.loads(prop.NominalValue.wrappedValue)
                                self.constraints = {c["id"]: c for c in data}
                                return
        except Exception as e:
            print(f"Notice loading constraints from IFC: {e}")

    # =========================================================================
    # 3D GEOMETRY EXTRACTION (Three.js Buffer Geometry Generation)
    # =========================================================================

    # Parametric fields that the shadow `element_meta` dict holds and that no
    # mesh/bbox can reconstruct. Serialized to the frontend so the store's
    # element record (and the AI planner) has real baselines and hosting info.
    ELEMENT_PARAM_FIELDS = (
        "ifc_class",
        "name",
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

    def get_geometry_buffers(self) -> Dict[str, Any]:
        """
        Extracts 3D triangulated meshes from active IFC entities using IfcGeom.
        Returns vertices, face indices, normals, colors, and bounding boxes ready for Three.js.
        """
        settings = ifcopenshell.geom.settings()
        settings.set(settings.USE_WORLD_COORDS, True)

        meshes = []

        # Color palette for consistent shaded viewport (Revit Consistent Colors style)
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

        for guid, meta in self.element_meta.items():
            entity = meta.get("entity")
            if not entity:
                continue
            ifc_class = meta.get("ifc_class", "IfcProduct")

            try:
                cached_v = meta.get("cached_verts")
                cached_f = meta.get("cached_faces")
                if cached_v and cached_f:
                    raw_verts = cached_v
                    raw_faces = cached_f
                else:
                    shape = ifcopenshell.geom.create_shape(settings, entity)
                    geom = shape.geometry
                    raw_verts = list(geom.verts)  # flat [x, y, z, ...]
                    raw_faces = list(geom.faces)  # flat [i1, i2, i3, ...]
                    meta["cached_verts"] = raw_verts
                    meta["cached_faces"] = raw_faces

                # In IFC: Z is up, Three.js: Y is up or Z is up.
                # We keep coordinates in Z-up (standard architectural convention)
                # and orient Three.js camera with Object3D.DEFAULT_UP = (0, 0, 1).
                style = category_colors.get(ifc_class, {"color": "#94a3b8", "opacity": 1.0, "cut_color": "#334155"})

                # Compute or retrieve element bounding box
                if "bbox" in meta:
                    bbox = meta["bbox"]
                else:
                    xs = raw_verts[0::3]
                    ys = raw_verts[1::3]
                    zs = raw_verts[2::3]
                    bbox = {
                        "min": [min(xs), min(ys), min(zs)],
                        "max": [max(xs), max(ys), max(zs)],
                    }
                    meta["bbox"] = bbox

                meshes.append({
                    "guid": guid,
                    "ifc_class": ifc_class,
                    "name": meta.get("name", ifc_class),
                    "vertices": raw_verts,
                    "indices": raw_faces,
                    "color": style["color"],
                    "cut_color": style["cut_color"],
                    "opacity": style["opacity"],
                    "bbox": bbox,
                    # Parametric definition (baseline, hosting, offsets) so the
                    # frontend element record is real data, not a mesh guess.
                    "params": self._serialize_element_params(guid, meta),
                })
            except Exception as e:
                # Fallback simple bounding geometry if shape creation fails
                pass

        return {
            "meshes": meshes,
            "levels": [
                {"id": l["id"], "name": l["name"], "elevation": l["elevation"]}
                for l in self.levels.values()
            ],
            "grids": [
                {
                    "guid": m["guid"],
                    "name": m["name"],
                    "tag": m["tag"],
                    "start": m["start"],
                    "end": m["end"],
                }
                for m in self.element_meta.values()
                if m.get("ifc_class") == "IfcGrid"
            ],
        }

    # =========================================================================
    # 2D VECTOR SLICING & HIDDEN LINE REMOVAL (HLR) PIPELINE
    # =========================================================================

    def slice_2d_vector_plan(self, cut_elevation: float = 1.2) -> Dict[str, Any]:
        """
        Slices the BIM model at a specified cut elevation (e.g. 4'-0" / 1.2m above storey).
        Generates 2D SVG vector paths decorated with semantic CSS classes:
        - .cut: Intersected wall and column solids with hatch patterns
        - .projection: Low walls, sills, and floor outlines
        - .overhead: Overhead headers and door swings
        """
        svg_cut_paths = []
        svg_projection_paths = []
        svg_swing_paths = []
        dimensions_list = []

        # Process walls
        for guid, meta in self.element_meta.items():
            if meta.get("ifc_class") == "IfcWallStandardCase":
                sp = meta["start"]
                ep = meta["end"]
                th = meta["thickness"]
                length = meta["length"]
                ang = meta["angle"]
                wall_h = meta.get("height", 3.0)

                # Revit View Range Rule (Spec §1.6 & §4.1):
                # Walls shorter than 6 ft (1.8288 m) are NOT cut, even if intersecting cut plane;
                # they render in projection style without hatch poché.
                is_wall_cut = wall_h >= 1.8288
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
                    banded = sorted(
                        (
                            (
                                om.get("offset_along_wall", 0.0),
                                om.get("offset_along_wall", 0.0) + om.get("width", 0.95),
                                om.get("ifc_class", "IfcDoor"),
                                op_id,
                                om,
                            )
                            for op_id, om in (
                                (op_id, self.element_meta.get(op_id, {}))
                                for op_id in openings
                            )
                        ),
                        key=lambda x: x[0],
                    )
                    pieces = [footprint]
                    for s0, s1, op_type, op_id, op_meta in banded:
                        nxt = []
                        for piece in pieces:
                            nxt.extend(self._clip_poly_s(piece, sp, (ux, uy), s_max=s0))
                            nxt.extend(self._clip_poly_s(piece, sp, (ux, uy), s_min=s1))
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

                            # Standard 90-degree Door swing arc + door panel
                            swing_flip = op_meta.get("swing_flipped", False)
                            swing_sign = -1.0 if swing_flip else 1.0
                            panel_end = (
                                op_pt[0] - math.sin(ang) * w * swing_sign,
                                op_pt[1] + math.cos(ang) * w * swing_sign,
                            )
                            # Door panel line
                            svg_swing_paths.append({
                                "guid": op_id,
                                "class": "IfcDoor swing-panel",
                                "d": f"M {op_pt[0]:.3f} {op_pt[1]:.3f} L {panel_end[0]:.3f} {panel_end[1]:.3f}",
                            })
                            # Door swing quarter arc
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

                # Aligned dimensions along wall
                dimensions_list.append({
                    "guid": guid,
                    "start": sp[:2],
                    "end": ep[:2],
                    "length": length,
                    "text": f"{length:.2f} m ({length * 3.28084:.1f}')",
                    "offset_norm": [nx, ny],
                })

        # Process grids
        grids_svg = []
        for meta in self.element_meta.values():
            if meta.get("ifc_class") == "IfcGrid":
                sp = meta["start"]
                ep = meta["end"]
                tag = meta.get("tag", "1")
                grids_svg.append({
                    "guid": meta["guid"],
                    "tag": tag,
                    "d": f"M {sp[0]:.3f} {sp[1]:.3f} L {ep[0]:.3f} {ep[1]:.3f}",
                    "circle_center": ep,
                })

        # Process Slabs
        slabs_svg = []
        for meta in self.element_meta.values():
            if meta.get("ifc_class") == "IfcSlab":
                pts = meta.get("polygon", [])
                if pts:
                    path_str = f"M {pts[0][0]:.3f} {pts[0][1]:.3f} " + " ".join(
                        f"L {p[0]:.3f} {p[1]:.3f}" for p in pts[1:]
                    ) + " Z"
                    slabs_svg.append({"guid": meta["guid"], "d": path_str, "class": "IfcSlab projection"})

        return {
            "cut_paths": svg_cut_paths,
            "projection_paths": svg_projection_paths,
            "swing_paths": svg_swing_paths,
            "slabs": slabs_svg,
            "grids": grids_svg,
            "dimensions": dimensions_list,
        }

    # =========================================================================
    # VECTOR PDF COMPILATION & SHEET ENGINE
    # =========================================================================

    def compile_sheet_to_vector_pdf(self, svg_content: str) -> bytes:
        """
        Compiles pure vector Sheet SVG into print-ready, vectorized PDF.
        Maintains 100% scalable vector linework and searchable text.
        """
        # Ensure standard XML header
        clean_svg = svg_content.strip()
        if not clean_svg.startswith("<?xml"):
            clean_svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + clean_svg

        svg_bytes = clean_svg.encode("utf-8")
        svg_doc = pymupdf.open("svg", svg_bytes)
        pdf_bytes = svg_doc.convert_to_pdf()
        return pdf_bytes

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
        ├── parametric.json    # overlay: constraints, join policies, parameters in decimal feet
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

        # 1. Generate IFC4 STEP model of record
        ifc_temp = tempfile.NamedTemporaryFile(suffix=".ifc", delete=False)
        ifc_temp.close()
        self.model.write(ifc_temp.name)

        # 2. Parametric overlay (all values in decimal feet / internal units)
        parametric_overlay = {
            "schema_version": "2.1",
            "internal_units": "decimal_feet",
            "constraints": self.constraints,
            "join_policies": self.join_policies,
            "elements": {
                guid: {
                    "ifc_class": m.get("ifc_class"),
                    "name": m.get("name"),
                    "type_properties": m.get("type_properties", {}),
                    "join_policy": self.join_policies.get(guid, {}),
                }
                for guid, m in self.element_meta.items()
            },
        }

        # 3. View templates and settings
        views_data = {
            "views": [
                {
                    "id": "floor_plan_level_1",
                    "name": "Level 1 Floor Plan",
                    "view_type": "floor_plan",
                    "cut_elevation": 1.2,
                    "top_clip": 2.3,
                    "bottom_clip": 0.0,
                    "view_depth": -1.2,
                    "detail_level": "medium",
                    "visual_style": "consistent_colors",
                }
            ]
        }

        # 4. Meta manifest
        meta_data = {
            "app": "BIMWorks",
            "version": "2.1",
            "spec": "GLM Master Spec v2.1",
            "container_format": CONTAINER_FORMAT_ID,
            "license": "GPL-3.0",
            "internal_units": "decimal_feet",
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
        Loads a BIMWorks hybrid container (.bimworks; legacy .orlt also accepted):
        1. Reads and loads model.ifc as the geometric and spatial model of record.
        2. Parses parametric.json and binds constraints, join policies, and type properties to GUIDs.
        3. Stale overlay records (elements edited or removed externally) are gracefully ignored.

        The `filename` argument is decorative only — the payload is identified by its
        zip members, so a mislabelled extension still loads. It is used for the
        imported IFC's display name and log messages.
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

        with z_file as z:
            names = z.namelist()
            if "model.ifc" not in names:
                raise ValueError("Project container missing required 'model.ifc'")

            ifc_content = z.read("model.ifc").decode("utf-8", errors="replace")
            load_res = self.load_ifc_content(ifc_content, ifc_display_name)

            if "parametric.json" in names:
                try:
                    param_data = json.loads(z.read("parametric.json").decode("utf-8"))
                    self.constraints = param_data.get("constraints", {})
                    self.join_policies = param_data.get("join_policies", {})
                    elements_overlay = param_data.get("elements", {})
                    for g, o_meta in elements_overlay.items():
                        if g in self.element_meta:
                            if "type_properties" in o_meta:
                                self.element_meta[g].setdefault("type_properties", {}).update(o_meta["type_properties"])
                except Exception as pe:
                    print(f"Notice loading parametric.json overlay: {pe}")

            if "meta.json" in names:
                try:
                    meta = json.loads(z.read("meta.json").decode("utf-8"))
                    if "project_name" in meta:
                        self.project_name = meta["project_name"]
                except Exception:
                    pass

        return {
            "status": "loaded",
            "container_format": CONTAINER_FORMAT_ID,
            "project_name": self.project_name,
            "elements_count": len(self.element_meta),
            "constraints_count": len(self.constraints),
            "join_policies_count": len(self.join_policies),
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

    def load_ifc_file(self, file_path: str, filename: str = "Imported.ifc") -> Dict[str, Any]:
        """Loads IFC model directly from a file path and sets up the active scene."""
        self.model = ifcopenshell.open(file_path)

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

        # 3. Storeys (Levels)
        storeys = self.model.by_type("IfcBuildingStorey")
        for storey in storeys:
            elevation = 0.0
            if hasattr(storey, "Elevation") and storey.Elevation is not None:
                try:
                    elevation = float(storey.Elevation)
                except Exception:
                    elevation = 0.0
            self.levels[storey.GlobalId] = {
                "id": storey.GlobalId,
                "name": storey.Name or f"Level {len(self.levels) + 1}",
                "elevation": elevation,
                "entity": storey,
            }

        if not self.levels:
            self.levels["level_1"] = {
                "id": "level_1",
                "name": "Level 1",
                "elevation": 0.0,
            }
            self.levels["level_2"] = {
                "id": "level_2",
                "name": "Level 2",
                "elevation": 3.0,
            }
            self.levels["roof"] = {
                "id": "roof",
                "name": "Roof",
                "elevation": 6.0,
            }

        # 4. Grids
        for grid in self.model.by_type("IfcGrid"):
            guid = grid.GlobalId
            name = grid.Name or "Grid"
            tag = name.replace("Grid ", "").strip()
            self.element_meta[guid] = {
                "entity": grid,
                "guid": guid,
                "ifc_class": "IfcGrid",
                "name": name,
                "tag": tag,
                "start": [-5.0, 0.0],
                "end": [15.0, 0.0],
            }

        # 5. Map Voids and Fills for door/window hosting
        wall_to_openings: Dict[str, List[str]] = {}
        for rel in self.model.by_type("IfcRelVoidsElement"):
            if hasattr(rel, "RelatingBuildingElement") and hasattr(rel, "RelatedOpeningElement"):
                w_guid = rel.RelatingBuildingElement.GlobalId
                op_guid = rel.RelatedOpeningElement.GlobalId
                wall_to_openings.setdefault(w_guid, []).append(op_guid)

        opening_to_filling: Dict[str, str] = {}
        for rel in self.model.by_type("IfcRelFillsElement"):
            if hasattr(rel, "RelatingOpeningElement") and hasattr(rel, "RelatedBuildingElement"):
                op_guid = rel.RelatingOpeningElement.GlobalId
                fill_guid = rel.RelatedBuildingElement.GlobalId
                opening_to_filling[op_guid] = fill_guid

        filling_to_wall: Dict[str, str] = {}
        for w_guid, op_guids in wall_to_openings.items():
            for op_guid in op_guids:
                fill_guid = opening_to_filling.get(op_guid)
                if fill_guid:
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

            meta: Dict[str, Any] = {
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
                    "polygon": [
                        [min_x, min_y],
                        [max_x, min_y],
                        [max_x, max_y],
                        [min_x, max_y],
                    ],
                })

            elif ifc_class == "IfcRoof":
                meta.update({
                    "thickness": max(dz, 0.2),
                    "elevation": min_z,
                })

            self.element_meta[guid] = meta

        # Second pass: calculate offset_along_wall for doors and windows
        for guid, meta in self.element_meta.items():
            if meta.get("ifc_class") in ("IfcDoor", "IfcWindow"):
                host_guid = meta.get("host_wall_guid")
                if host_guid and host_guid in self.element_meta:
                    h_meta = self.element_meta[host_guid]
                    h_start = h_meta.get("start", [0, 0, 0])
                    b_min = meta.get("bbox", {}).get("min", [0, 0, 0])
                    b_max = meta.get("bbox", {}).get("max", [0, 0, 0])
                    center_x = (b_min[0] + b_max[0]) / 2.0
                    center_y = (b_min[1] + b_max[1]) / 2.0
                    dist = math.sqrt((center_x - h_start[0]) ** 2 + (center_y - h_start[1]) ** 2)
                    meta["offset_along_wall"] = dist
                    if guid not in h_meta.get("hosted_openings", []):
                        h_meta.setdefault("hosted_openings", []).append(guid)

        # Load constraints if present in IFC
        self.load_constraints_from_ifc()

        return {
            "status": "loaded",
            "project_name": self.project_name,
            "elements_count": len(self.element_meta),
            "levels_count": len(self.levels),
        }


# Singleton instance for sidecar
bim_manager = BimModelManager()

