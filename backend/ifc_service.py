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
# full parametric definition per element; the loader rebuilds from it.
OVERLAY_SCHEMA_VERSION = 3
LEGACY_OVERLAY_SCHEMA_VERSIONS = ("2.1",)

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
    FEET_0, FEET_1, FEET_4, FEET_6, FEET_8, FEET_10, FEET_12,
    INCHES_4, INCHES_8, INCHES_4_7_8, INCHES_10, INCHES_12, INCHES_0_625,
    DOOR_WIDTH_36, DOOR_HEIGHT_84,
    WINDOW_WIDTH_48, WINDOW_HEIGHT_48, WINDOW_SILL_36,
    DOOR_PANEL_THICKNESS, WINDOW_FRAME_THICKNESS,
    format_feet_inches,
    feet_to_metres,
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

        # Storeys (Levels)
        self.levels: Dict[str, Any] = {}
        self.add_level("Level 1", 0.0)
        self.add_level("Level 2", FEET_10)
        self.add_level("Roof", FEET_10 * 2)

        # Elements internal tracking
        self.element_meta: Dict[str, Dict[str, Any]] = {}
        self.undo_stack: List[str] = []
        self.redo_stack: List[str] = []

        # 1D/2D Parametric Constraints Manager
        self.constraints: Dict[str, Dict[str, Any]] = {}
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
        """Converts numpy arrays/scalars to plain JSON types."""
        if isinstance(value, np.ndarray):
            return value.tolist()
        if isinstance(value, (np.floating, np.integer)):
            return value.item()
        if isinstance(value, (list, tuple)):
            return [BimModelManager._jsonable(v) for v in value]
        if isinstance(value, dict):
            return {k: BimModelManager._jsonable(v) for k, v in value.items()}
        return value

    def _build_overlay_element(self, guid: str, meta: Dict[str, Any]) -> Dict[str, Any]:
        """
        Full parametric record for one element (overlay schema v3).

        Deliberately excludes: live entity refs, cached tessellation (`cached_verts`
        / `cached_faces` / `bbox`), and anything derivable — those are regenerated.
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
        if meta.get("hosted_openings"):
            record["hosted_openings"] = list(meta["hosted_openings"])
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
        # world position = baseline start + offset along u + local_y along the normal
        matrix[0, 3] = float(sp[0]) + ux * offset_along_wall - uy * local_y
        matrix[1, 3] = float(sp[1]) + uy * offset_along_wall + ux * local_y
        matrix[2, 3] = base_z + local_z
        return matrix

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
    ) -> Dict[str, Any]:
        """
        Creates an IfcWallStandardCase defined by 2D baseline, height, and thickness.
        Places wall in spatial structure and computes representation.

        `guid` re-uses the caller's GUID (overlay replay); `wall_id` is the legacy
        alias kept for callers that predate it.
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
        guid = self._apply_guid(wall, guid or wall_id)

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
        matrix[0, 3] = start_pt[0]
        matrix[1, 3] = start_pt[1]
        matrix[2, 3] = start_pt[2] if len(start_pt) > 2 else base_z

        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=wall, matrix=matrix, is_si=False
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
            "geometry.edit_object_placement", self.model, product=opening, matrix=op_matrix, is_si=False
        )

        # Cut the wall
        ifcopenshell.api.run("feature.add_feature", self.model, feature=opening, element=wall)

        # 2. Create Door element
        door = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcDoor", name=name
        )
        door_guid = self._apply_guid(door, guid)
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
            "geometry.edit_object_placement", self.model, product=door, matrix=door_matrix, is_si=False
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
                "Width": format_feet_inches(width),
                "Height": format_feet_inches(height),
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
        width: float = WINDOW_WIDTH_48,
        height: float = WINDOW_HEIGHT_48,
        sill_height: float = WINDOW_SILL_36,
        name: str = "Fixed Window : 48\" x 48\"",
        guid: Optional[str] = None,
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
            "geometry.edit_object_placement", self.model, product=opening, matrix=op_matrix, is_si=False
        )

        ifcopenshell.api.run("feature.add_feature", self.model, feature=opening, element=wall)

        # 2. Window
        window = ifcopenshell.api.run(
            "root.create_entity", self.model, ifc_class="IfcWindow", name=name
        )
        win_guid = self._apply_guid(window, guid)
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
            "geometry.edit_object_placement", self.model, product=window, matrix=win_matrix, is_si=False
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
                "Width": format_feet_inches(width),
                "Height": format_feet_inches(height),
                "Sill Height": format_feet_inches(sill_height),
                "Glazing": "Double Glazed Low-E",
            },
        }
        self.element_meta[win_guid] = win_meta
        wall_meta["hosted_openings"].append(win_guid)
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
        matrix[0, 3] = min_x
        matrix[1, 3] = min_y
        matrix[2, 3] = elevation - thickness  # top of slab at elevation
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=slab, matrix=matrix, is_si=False
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
    ) -> Dict[str, Any]:
        """Creates an IfcRoof."""
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
        matrix[0, 3] = min_x
        matrix[1, 3] = min_y
        matrix[2, 3] = elevation
        ifcopenshell.api.run(
            "geometry.edit_object_placement", self.model, product=roof, matrix=matrix, is_si=False
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
                "Thickness": format_feet_inches(thickness),
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
            if "start" in meta and meta["start"]:
                meta["start"][0] += dx
                meta["start"][1] += dy
                meta["start"][2] = (meta["start"][2] if len(meta["start"]) > 2 else 0.0) + dz
            if "end" in meta and meta["end"]:
                meta["end"][0] += dx
                meta["end"][1] += dy
                meta["end"][2] = (meta["end"][2] if len(meta["end"]) > 2 else 0.0) + dz
            if "cached_verts" in meta and meta["cached_verts"]:
                cv = meta["cached_verts"]
                meta["cached_verts"] = [
                    cv[i] + dx if i % 3 == 0 else (cv[i] + dy if i % 3 == 1 else cv[i] + dz)
                    for i in range(len(cv))
                ]
            if "bbox" in meta and "min" in meta["bbox"]:
                meta["bbox"]["min"][0] += dx
                meta["bbox"]["min"][1] += dy
                meta["bbox"]["min"][2] += dz
                meta["bbox"]["max"][0] += dx
                meta["bbox"]["max"][1] += dy
                meta["bbox"]["max"][2] += dz
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
                host_meta, meta["offset_along_wall"], local_y=-INCHES_0_625, local_z=sill
            )
            ifcopenshell.api.run(
                "geometry.edit_object_placement", self.model, product=opening, matrix=op_matrix, is_si=False
            )

            dw_matrix = self._hosted_placement_matrix(
                host_meta, meta["offset_along_wall"], local_y=0.0, local_z=sill
            )
            ifcopenshell.api.run(
                "geometry.edit_object_placement", self.model, product=door_win, matrix=dw_matrix, is_si=False
            )
            translated = True

        elif ifc_class == "IfcGrid":
            meta["start"][0] += dx
            meta["start"][1] += dy
            meta["end"][0] += dx
            meta["end"][1] += dy
            translated = True

        elif ifc_class in ("IfcSlab", "IfcRoof"):
            meta["elevation"] = meta.get("elevation", 0.0) + dz
            if "polygon" in meta and meta["polygon"]:
                meta["polygon"] = [(p[0] + dx, p[1] + dy) for p in meta["polygon"]]
            if "cached_verts" in meta and meta["cached_verts"]:
                cv = meta["cached_verts"]
                meta["cached_verts"] = [
                    cv[i] + dx if i % 3 == 0 else (cv[i] + dy if i % 3 == 1 else cv[i] + dz)
                    for i in range(len(cv))
                ]
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
        if translated and _propagate:
            try:
                self._solve_constraints_after_move(guid)
            except Exception as e:  # never let a solver problem corrupt an edit
                print(f"Notice: constraint solve after moving {guid} failed: {e}")

        return translated

    def _solve_constraints_after_move(self, moved_guid: str) -> None:
        """
        Re-solves the constraint system around a completed move.

        Runs on both axes because a constraint may pin an element on the axis the
        user did not drag.
        """
        from constraint_solver import ConstraintSolver

        solver = ConstraintSolver(self)
        scope = solver.affected_guids([moved_guid])
        if len(scope) <= 1:
            return
        for axis in ("x", "y"):
            pins = {
                g: self.get_element_coord(g, axis)
                for g in (moved_guid,)
                if g in self.element_meta
            }
            result = solver.solve(axis=axis, pins=pins, scope=scope)
            if result.ok:
                solver.apply_solve(result)
            elif result.status == "conflict":
                self.last_constraint_conflict = {
                    "axis": axis,
                    "constraints": result.conflicting,
                    "triggered_by": moved_guid,
                }

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
                eq = solver.equalize(
                    c.get("span_start_guid"), c.get("span_end_guid"),
                    list(c.get("interior_guids") or []), axis,
                )
                if eq.ok:
                    solver.apply_solve(eq)
            except Exception as e:
                print(f"Notice: re-equalizing span {c.get('id')} failed: {e}")

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
                meta["cached_verts"] = verts
                meta["cached_faces"] = faces
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
                meta["cached_verts"] = verts
                meta["cached_faces"] = faces
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
            meta["cached_verts"] = verts
            meta["cached_faces"] = faces
            meta["bbox"] = {
                "min": [min(sp[0], ep[0]) - th, min(sp[1], ep[1]) - th, sp[2] if len(sp) > 2 else 0.0],
                "max": [max(sp[0], ep[0]) + th, max(sp[1], ep[1]) + th, (sp[2] if len(sp) > 2 else 0.0) + h],
            }
            self.recompute_wall_joins()

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

                # Search the full wall set: a subset pass must still see partners
                # that are not themselves being recomputed.
                partner_guid, kind, oe = self._find_join_partner(guid, end_index, all_walls)
                if not partner_guid:
                    continue
                # partner was found in `all_walls`, which may include walls
                # outside the subset being recomputed.
                om = all_walls[partner_guid]

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
            "geometry.edit_object_placement", self.model, product=wall, matrix=matrix, is_si=False
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
                    )
                else:
                    meta = self.add_window(
                        host_wall_guid=host_guid,
                        offset_along_wall=float(rec.get("offset_along_wall", 0.0)),
                        width=float(rec.get("width", 1.2)),
                        height=float(rec.get("height", WINDOW_HEIGHT_48)),
                        sill_height=float(rec.get("sill_height", WINDOW_SILL_36)),
                        name=name, guid=guid,
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
                meta = self.add_roof(
                    polygon_pts=[tuple(p) for p in polygon],
                    thickness=float(rec.get("thickness", 0.3)),
                    elevation=float(rec.get("elevation", 6.0)),
                    pitch_degrees=float(rec.get("pitch", 15.0)),
                    level_id=level_id, name=name, guid=guid,
                )

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
                    shape = self._get_product_shape(settings, entity)
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

    def slice_2d_vector_plan(self, cut_elevation: float = FEET_4) -> Dict[str, Any]:
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
                        "text": f"{length:.2f} m ({length * 3.28084:.1f}')",
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
                    # Extend grid line by 1.2m at bubble end and 0.6m at tail
                    bubble_center = [ep[0] + ux * 1.2, ep[1] + uy * 1.2]
                    tail = [sp[0] - ux * 0.6, sp[1] - uy * 0.6]
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

        is_v3 = schema_version == OVERLAY_SCHEMA_VERSION
        load_report: Dict[str, Any]
        if is_v3:
            overlay["_ifc_guids"] = ifc_guids
            load_report = self.rebuild_from_overlay(overlay)
            load_report.pop("_ifc_guids", None)
        else:
            # Legacy container: no parametric geometry in the overlay. Keep the
            # tessellation import and only re-attach metadata that is GUID-gated.
            self.constraints = self._jsonable(overlay.get("constraints", {}) or {})
            self.join_policies = self._jsonable(overlay.get("join_policies", {}) or {})
            elements_overlay = overlay.get("elements", {}) or {}
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
            "overlay_authoritative": is_v3,
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

            self.element_meta[guid] = meta

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

