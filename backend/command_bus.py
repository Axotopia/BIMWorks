"""
BIMWorks - CommandBus & Transaction Engine (Tier 0)
Complies with GLM Master Specification v2 §3 & §5.
Typed command registry with JSON Schema 2020-12 export,
transactional execution with undo/redo journal, and AI origin tagging.
"""

import time
import uuid
import copy
import threading
from typing import Dict, List, Any, Optional, Literal, Tuple
from pydantic import BaseModel, Field, model_validator

from ifc_service import bim_manager
from references import normalize_reference, resolve_reference


# ============================================================================
# COMMAND PARAMETER SCHEMAS (JSON Schema 2020-12 Compliant)
# ============================================================================

class WallCreateParams(BaseModel):
    start: List[float] = Field(..., description="Start point [x, y, z] in decimal feet or meters")
    end: List[float] = Field(..., description="End point [x, y, z] in decimal feet or meters")
    height: float = Field(default=3.0, gt=0, description="Unconnected wall height")
    thickness: float = Field(default=0.2, gt=0, description="Wall thickness")
    level_id: Optional[str] = Field(default=None, description="Host level GUID")
    name: str = Field(default='Basic Wall : Exterior - 8" CMU', description="Wall type name")


class WallMoveParams(BaseModel):
    guid: str = Field(..., description="Target wall GUID")
    dx: float = Field(..., description="Delta X translation")
    dy: float = Field(..., description="Delta Y translation")
    dz: float = Field(default=0.0, description="Delta Z translation")


class ReferenceMoveParams(BaseModel):
    source: Dict[str, Any] = Field(..., description="Source geometric reference to move")
    target: Dict[str, Any] = Field(..., description="Target geometric reference to place onto")
    axis: str = Field(default="aligned", description="Movement constraint axis: 'x', 'y', 'z', or 'aligned'")
    extras: Optional[List[Tuple[str, Any]]] = Field(default=None, description="Optional drag-time extra constraints")


class DoorInsertParams(BaseModel):
    host_wall_guid: str = Field(..., description="Host wall GUID")
    offset_along_wall: float = Field(..., ge=0, description="Distance from wall start point along baseline")
    width: float = Field(default=0.95, gt=0, description="Door opening width")
    height: float = Field(default=2.1, gt=0, description="Door opening height")
    name: str = Field(default='Single Flush : 36" x 84"', description="Door family/type name")
    swing_flipped: bool = Field(default=False, description="Whether door swing direction is flipped")


class WindowInsertParams(BaseModel):
    host_wall_guid: str = Field(..., description="Host wall GUID")
    offset_along_wall: float = Field(..., ge=0, description="Distance from wall start point along baseline")
    width: float = Field(default=1.2, gt=0, description="Window width")
    height: float = Field(default=1.2, gt=0, description="Window height")
    sill_height: float = Field(default=0.9, ge=0, description="Window sill height from floor")
    name: str = Field(default='Fixed Window : 48" x 48"', description="Window family/type name")


class SlabCreateParams(BaseModel):
    polygon: List[List[float]] = Field(..., description="Closed 2D polygon vertices [[x,y], ...]")
    thickness: float = Field(default=0.25, gt=0, description="Slab thickness")
    elevation: float = Field(default=0.0, description="Base elevation")
    level_id: Optional[str] = Field(default=None, description="Host level GUID")
    name: str = Field(default='Floor : 10" Concrete Slab', description="Floor type name")


class RoofCreateParams(BaseModel):
    polygon: List[List[float]] = Field(..., description="Closed 2D polygon vertices [[x,y], ...]")
    thickness: float = Field(default=0.3, gt=0, description="Roof thickness")
    elevation: float = Field(default=3.0, description="Base roof plate elevation")
    pitch_degrees: float = Field(default=15.0, description="Roof pitch slope in degrees")
    level_id: Optional[str] = Field(default=None, description="Host level GUID")
    name: str = Field(default="Roof : Pitched Metal Deck", description="Roof type name")


class GridCreateParams(BaseModel):
    axis_name: str = Field(..., description="Grid identifier, e.g. 'A', '1'")
    start: List[float] = Field(..., description="Grid start [x, y]")
    end: List[float] = Field(..., description="Grid end [x, y]")


class LevelCreateParams(BaseModel):
    name: str = Field(..., description="Level name, e.g. 'Level 2'")
    elevation: float = Field(..., description="Storey elevation")


class DeleteElementParams(BaseModel):
    guid: str = Field(..., description="GUID of element to delete")


class SetWallJoinParams(BaseModel):
    wall_guid: str = Field(..., description="Wall GUID")
    end_index: int = Field(..., description="Endpoint index (0 for start, 1 for end)")
    allow_join: bool = Field(default=True, description="Whether wall join is allowed at this end")
    mode: Literal["butt", "miter", "square_off"] = Field(default="butt", description="Join display mode")


class ConstraintAlignParams(BaseModel):
    ref_guid: str = Field(..., description="Reference datum/face element GUID")
    target_guid: str = Field(..., description="Target element GUID to align")
    axis: Literal["x", "y"] = Field(default="x", description="Alignment coordinate axis")
    lock: bool = Field(default=True, description="Whether to lock the alignment constraint")


class ConstraintLockDimParams(BaseModel):
    guid_a: str = Field(..., description="First witness element GUID")
    guid_b: str = Field(..., description="Second witness element GUID")
    locked_distance: Optional[float] = Field(default=None, description="Fixed distance constraint value")
    lock: bool = Field(default=True, description="Padlock state")
    axis: Literal["x", "y"] = Field(default="x", description="Measurement axis")


class ConstraintEqualizeParams(BaseModel):
    span_start_guid: str = Field(..., description="Start boundary element GUID")
    span_end_guid: str = Field(..., description="End boundary element GUID")
    interior_guids: List[str] = Field(..., description="Interior elements distributed equally")
    axis: Literal["x", "y"] = Field(default="x", description="Equalization axis")


class DimensionCreateParams(BaseModel):
    dimension_id: Optional[str] = Field(default=None, description="Optional stable dimension identifier")
    kind: Literal["aligned", "linear", "angular", "radial"] = Field(default="aligned", description="Dimension type")
    ref_a: Dict[str, Any] = Field(..., description="First witness reference, e.g. {'guid': str, 'ref': 'start'}")
    ref_b: Dict[str, Any] = Field(..., description="Second witness reference, e.g. {'guid': str, 'ref': 'end'}")
    axis: Literal["x", "y", "aligned"] = Field(default="aligned", description="Measurement axis")
    offset: float = Field(default=1.0, description="Dimension line offset from reference in feet")
    value: Optional[float] = Field(default=None, description="Optional explicit initial value in feet")
    is_locked: bool = Field(default=False, description="Whether dimension is locked as constraint")
    eq_group: Optional[str] = Field(default=None, description="Optional EQ group identifier")
    refs: Optional[List[Dict[str, Any]]] = Field(default=None, description="Optional ordered list of chained references")
    binding: Literal["literal", "parameter", "equal"] = Field(default="literal", description="Binding mode")
    label: Optional[str] = Field(default=None, description="Optional parameter label")
    eq_anchor: Optional[int] = Field(default=None, description="Optional anchor index for equal binding")

    @model_validator(mode="after")
    def _validate_binding_rules(self) -> "DimensionCreateParams":
        if self.binding == "parameter":
            if not self.label:
                raise ValueError("label must be set when binding == 'parameter'")
            if self.is_locked:
                raise ValueError("Dimension binding error: cannot be both locked and labeled")
        else:
            if self.label is not None:
                raise ValueError(f"label cannot be set when binding == '{self.binding}' (only when binding == 'parameter')")
        if self.is_locked and self.refs and len(self.refs) > 2 and self.binding != "equal":
            raise ValueError("Dimension binding error: cannot lock multi-segment dimension without equal binding")
        return self

    @model_validator(mode="before")
    @classmethod
    def _normalize_keys(cls, data: Any) -> Any:
        if isinstance(data, dict):
            mapping = {
                "dimensionId": "dimension_id",
                "isLocked": "is_locked",
                "eqGroup": "eq_group",
                "eqAnchor": "eq_anchor",
                "refA": "ref_a",
                "refB": "ref_b",
            }
            res = dict(data)
            for k_camel, k_snake in mapping.items():
                if k_camel in res and k_snake not in res:
                    res[k_snake] = res[k_camel]
            return res
        return data


class DimensionValueSetParams(BaseModel):
    dimension_id: str = Field(..., description="Identifier of dimension to edit (or element GUID)")
    value: float = Field(..., gt=0.0, description="Target dimension value in decimal feet (must be > 0)")
    anchor: Literal["start", "end", "center"] = Field(default="start", description="Which end is held fixed while resizing")


class DimensionDeleteParams(BaseModel):
    dimension_id: str = Field(..., description="Identifier of dimension to delete")


class DimensionLockToggleParams(BaseModel):
    dimension_id: str = Field(..., description="Identifier of dimension to lock/unlock")
    is_locked: bool = Field(..., description="New lock padlock state")


class ElementUpdateParams(BaseModel):
    guid: str = Field(..., description="GUID of element to update")
    updates: Dict[str, Any] = Field(..., description="Element property updates (polygon, thickness, elevation, pitch, etc.)")


class SketchCurveAddParams(BaseModel):
    guid: str = Field(..., description="Element that owns the sketch")
    curve_id: str = Field(..., description="Stable curve identifier")
    start: List[float] = Field(..., description="Start [u, v] in the sketch plane")
    end: List[float] = Field(..., description="End [u, v] in the sketch plane")
    defines_slope: bool = Field(default=False, description="Revit Defines Slope flag")
    slope_angle: Optional[float] = Field(default=None, description="Per-curve slope in degrees")


class SketchCurveMoveVertexParams(BaseModel):
    guid: str = Field(..., description="Element that owns the sketch")
    curve_id: str = Field(..., description="Curve whose endpoint moves")
    end_index: int = Field(..., description="0 for start, 1 for end")
    to: List[float] = Field(..., description="New [u, v] position")


class SketchCurveMoveEdgeParams(BaseModel):
    guid: str = Field(..., description="Element that owns the sketch")
    curve_id: str = Field(..., description="Curve to translate")
    dx: float = Field(..., description="Delta along the sketch u axis")
    dy: float = Field(..., description="Delta along the sketch v axis")


class SketchCurveSlopeParams(BaseModel):
    guid: str = Field(..., description="Element that owns the sketch")
    curve_id: str = Field(..., description="Curve to toggle")
    defines_slope: bool = Field(..., description="New Defines Slope state")
    slope_angle: Optional[float] = Field(default=None, description="Optional new slope in degrees")


class ElementCopyParams(BaseModel):
    guid: str = Field(..., description="Element to copy")
    dx: float = Field(default=0.0, description="Offset X in internal feet")
    dy: float = Field(default=0.0, description="Offset Y in internal feet")
    dz: float = Field(default=0.0, description="Offset Z in internal feet")


class ElementRotateParams(BaseModel):
    guid: str = Field(..., description="Element to rotate")
    angle_degrees: float = Field(..., description="Rotation angle, counter-clockwise")
    center: Optional[List[float]] = Field(default=None, description="Centre [x, y]; default is the element centroid")


class ElementOffsetParams(BaseModel):
    guid: str = Field(..., description="Wall to offset")
    distance: float = Field(..., description="Perpendicular distance in internal feet")
    side: int = Field(default=1, description="1 offsets to the left of the baseline, -1 to the right")


class WallTrimExtendParams(BaseModel):
    guid: str = Field(..., description="Wall whose end moves")
    end_index: int = Field(..., description="0 for the start point, 1 for the end point")
    target_guid: str = Field(..., description="Wall or datum whose baseline defines the corner")
    corner_mode: bool = Field(default=True, description="Whether to trim both walls into a corner")
    target_end_index: Optional[int] = Field(default=None, description="Optional target end index (0 for start, 1 for end)")


class WallSplitParams(BaseModel):
    guid: str = Field(..., description="Wall to split")
    at_offset: float = Field(..., description="Distance along the baseline from the wall start")
    gap: float = Field(default=0.0, description="Optional gap distance in decimal feet for split-with-gap")


class LevelMoveParams(BaseModel):
    level_id: str = Field(..., description="Storey GUID to move")
    elevation: float = Field(..., description="New storey elevation in decimal feet")


class ConstraintLockToggleParams(BaseModel):
    constraint_id: str = Field(..., description="Constraint identifier to lock/unlock")
    is_locked: bool = Field(..., description="New padlock state")


class ConstraintDeleteParams(BaseModel):
    constraint_id: str = Field(..., description="Constraint identifier to remove")


class SheetCreateParams(BaseModel):
    sheet_number: str = Field(..., description="Sheet number identifier, e.g. 'A101'")
    sheet_title: str = Field(default="Unnamed Sheet", description="Sheet title")
    paper_size: str = Field(default="ARCH_D", description="Paper size: ARCH_D, ARCH_C, ISO_A1")
    is_placeholder: bool = Field(default=False, description="Whether this is a placeholder sheet")
    sheet_id: Optional[str] = Field(default=None, description="Optional explicit sheet ID")
    drawn_by: str = Field(default="BIMWorks Architect", description="Drawn by author string")
    date: Optional[str] = Field(default=None, description="Authored date string")
    orientation: str = Field(default="landscape", description="Paper orientation: landscape or portrait")

    @model_validator(mode="before")
    @classmethod
    def _normalize_keys(cls, data: Any) -> Any:
        if isinstance(data, dict):
            mapping = {
                "sheetNumber": "sheet_number",
                "sheetTitle": "sheet_title",
                "paperSize": "paper_size",
                "isPlaceholder": "is_placeholder",
                "sheetId": "sheet_id",
                "drawnBy": "drawn_by",
            }
            res = dict(data)
            for k_camel, k_snake in mapping.items():
                if k_camel in res and k_snake not in res:
                    res[k_snake] = res[k_camel]
            return res
        return data


class SheetDeleteParams(BaseModel):
    sheet_id: str = Field(..., description="ID of sheet to delete")

    @model_validator(mode="before")
    @classmethod
    def _normalize_keys(cls, data: Any) -> Any:
        if isinstance(data, dict):
            if "sheetId" in data and "sheet_id" not in data:
                res = dict(data)
                res["sheet_id"] = res["sheetId"]
                return res
        return data


class SheetUpdateParams(BaseModel):
    sheet_id: str = Field(..., description="Target sheet ID")
    updates: Dict[str, Any] = Field(..., description="Dictionary of sheet property updates")

    @model_validator(mode="before")
    @classmethod
    def _normalize_keys(cls, data: Any) -> Any:
        if isinstance(data, dict):
            res = dict(data)
            if "sheetId" in res and "sheet_id" not in res:
                res["sheet_id"] = res["sheetId"]
            if "updates" in res and isinstance(res["updates"], dict):
                norm_updates = {}
                for k, v in res["updates"].items():
                    if k == "sheetTitle":
                        norm_updates["sheet_title"] = v
                    elif k == "sheetNumber":
                        norm_updates["sheet_number"] = v
                    elif k == "drawnBy":
                        norm_updates["drawn_by"] = v
                    elif k == "paperSize":
                        norm_updates["paper_size"] = v
                    else:
                        norm_updates[k] = v
                res["updates"] = norm_updates
            return res
        return data


class ViewportAddParams(BaseModel):
    sheet_id: str = Field(..., description="Target sheet ID")
    view_id: str = Field(..., description="Target view ID to place on sheet")
    x: float = Field(..., description="X coordinate on sheet")
    y: float = Field(..., description="Y coordinate on sheet")
    width: float = Field(default=480.0, description="Viewport crop width")
    height: float = Field(default=360.0, description="Viewport crop height")
    scale_factor: float = Field(default=1.0, description="Viewport scale factor")
    viewport_id: Optional[str] = Field(default=None, description="Optional explicit viewport ID")

    @model_validator(mode="before")
    @classmethod
    def _normalize_keys(cls, data: Any) -> Any:
        if isinstance(data, dict):
            mapping = {
                "sheetId": "sheet_id",
                "viewId": "view_id",
                "scaleFactor": "scale_factor",
                "viewportId": "viewport_id",
            }
            res = dict(data)
            for k_camel, k_snake in mapping.items():
                if k_camel in res and k_snake not in res:
                    res[k_snake] = res[k_camel]
            return res
        return data


class ViewportRemoveParams(BaseModel):
    viewport_id: str = Field(..., description="ID of viewport to remove")
    sheet_id: Optional[str] = Field(default=None, description="Optional sheet ID containing the viewport")

    @model_validator(mode="before")
    @classmethod
    def _normalize_keys(cls, data: Any) -> Any:
        if isinstance(data, dict):
            mapping = {
                "viewportId": "viewport_id",
                "sheetId": "sheet_id",
            }
            res = dict(data)
            for k_camel, k_snake in mapping.items():
                if k_camel in res and k_snake not in res:
                    res[k_snake] = res[k_camel]
            return res
        return data


class ViewportMoveParams(BaseModel):
    viewport_id: str = Field(..., description="ID of viewport to move")
    x: float = Field(..., description="New X coordinate on sheet")
    y: float = Field(..., description="New Y coordinate on sheet")
    sheet_id: Optional[str] = Field(default=None, description="Optional sheet ID containing the viewport")

    @model_validator(mode="before")
    @classmethod
    def _normalize_keys(cls, data: Any) -> Any:
        if isinstance(data, dict):
            mapping = {
                "viewportId": "viewport_id",
                "sheetId": "sheet_id",
            }
            res = dict(data)
            for k_camel, k_snake in mapping.items():
                if k_camel in res and k_snake not in res:
                    res[k_snake] = res[k_camel]
            return res
        return data


class TypeCreateParams(BaseModel):
    type_id: str = Field(..., description="Unique type identifier")
    name: str = Field(..., description="Human-readable family and type name")
    ifc_class: str = Field(default="IfcWallType", description="IFC type class")
    parameters: Dict[str, Any] = Field(default_factory=dict, description="Type parameters dict")


class TypeUpdateParams(BaseModel):
    type_id: str = Field(..., description="Target type ID to update")
    parameters: Dict[str, Any] = Field(..., description="Dictionary of parameter updates")


class TypeDuplicateParams(BaseModel):
    source_type_id: str = Field(..., description="Existing type ID to clone")
    new_type_id: str = Field(..., description="New unique type ID")
    new_name: str = Field(..., description="New human-readable type name")


class ElementSetTypeParams(BaseModel):
    guid: str = Field(..., description="Target element GUID")
    type_id: str = Field(..., description="Type ID to assign")


class WallSetHeightParams(BaseModel):
    guid: str = Field(..., description="Target wall GUID")
    height: float = Field(..., gt=0.0, description="New wall height in feet or meters (> 0)")


class WallSetThicknessParams(BaseModel):
    guid: str = Field(..., description="Target wall GUID")
    thickness: float = Field(..., gt=0.0, description="New wall thickness in feet or meters (> 0)")


class WallSetEndParams(BaseModel):
    guid: str = Field(..., description="Target wall GUID")
    end: Literal["start", "end"] = Field(..., description="Which endpoint to modify ('start' or 'end')")
    point: List[float] = Field(..., min_length=2, max_length=3, description="New endpoint coordinates [x, y] or [x, y, z]")
    clamp: bool = Field(default=False, description="Whether to clamp to safe bounds fitting hosted openings")


class OpeningSetOffsetParams(BaseModel):
    guid: str = Field(..., description="Target opening GUID")
    offset: float = Field(..., ge=0.0, description="New offset along wall in feet (>= 0)")
    clamp: bool = Field(default=False, description="Whether to clamp to safe bounds within host wall")


class OpeningSetWidthParams(BaseModel):
    guid: str = Field(..., description="Target opening GUID")
    width: float = Field(..., gt=0.0, description="New opening width in feet (> 0)")


class OpeningSetSillHeightParams(BaseModel):
    guid: str = Field(..., description="Target opening GUID")
    sill_height: float = Field(..., ge=0.0, description="New opening sill height in feet (>= 0)")


class OpeningFlipParams(BaseModel):
    guid: str = Field(..., description="Target opening GUID")


class GridSetEndpointParams(BaseModel):
    guid: str = Field(..., description="Target grid GUID")
    end: Literal["start", "end"] = Field(..., description="Which endpoint to modify ('start' or 'end')")
    point: List[float] = Field(..., min_length=2, max_length=2, description="New endpoint [x, y]")


class PolygonSetVertexParams(BaseModel):
    guid: str = Field(..., description="Target slab or roof GUID")
    vertex_index: int = Field(..., ge=0, description="Index of vertex in polygon")
    point: List[float] = Field(..., min_length=2, max_length=2, description="New vertex coordinates [x, y]")


# Registry of command names to parameter classes
COMMAND_REGISTRY = {
    "WallCreate": WallCreateParams,
    "WallMove": WallMoveParams,
    "WallSetHeight": WallSetHeightParams,
    "WallSetThickness": WallSetThicknessParams,
    "WallSetEnd": WallSetEndParams,
    "OpeningSetOffset": OpeningSetOffsetParams,
    "OpeningSetWidth": OpeningSetWidthParams,
    "OpeningSetSillHeight": OpeningSetSillHeightParams,
    "OpeningFlip": OpeningFlipParams,
    "GridSetEndpoint": GridSetEndpointParams,
    "PolygonSetVertex": PolygonSetVertexParams,
    "DoorInsert": DoorInsertParams,
    "WindowInsert": WindowInsertParams,
    "SlabCreate": SlabCreateParams,
    "RoofCreate": RoofCreateParams,
    "GridCreate": GridCreateParams,
    "LevelCreate": LevelCreateParams,
    "DeleteElement": DeleteElementParams,
    "SetWallJoin": SetWallJoinParams,
    "ConstraintAlign": ConstraintAlignParams,
    "ConstraintLockDim": ConstraintLockDimParams,
    "ConstraintEqualize": ConstraintEqualizeParams,
    "SketchCurveAdd": SketchCurveAddParams,
    "SketchCurveMoveVertex": SketchCurveMoveVertexParams,
    "SketchCurveMoveEdge": SketchCurveMoveEdgeParams,
    "SketchCurveSetSlope": SketchCurveSlopeParams,
    "ElementCopy": ElementCopyParams,
    "ElementRotate": ElementRotateParams,
    "ElementOffset": ElementOffsetParams,
    "WallTrimExtend": WallTrimExtendParams,
    "WallSplit": WallSplitParams,
    "LevelMove": LevelMoveParams,
    "ConstraintLockToggle": ConstraintLockToggleParams,
    "ConstraintDelete": ConstraintDeleteParams,
    "ElementUpdate": ElementUpdateParams,
    "SheetCreate": SheetCreateParams,
    "SheetDelete": SheetDeleteParams,
    "SheetUpdate": SheetUpdateParams,
    "ViewportAdd": ViewportAddParams,
    "ViewportRemove": ViewportRemoveParams,
    "ViewportMove": ViewportMoveParams,
    "DimensionCreate": DimensionCreateParams,
    "DimensionValueSet": DimensionValueSetParams,
    "DimensionDelete": DimensionDeleteParams,
    "DimensionLockToggle": DimensionLockToggleParams,
    "TypeCreate": TypeCreateParams,
    "TypeUpdate": TypeUpdateParams,
    "TypeDuplicate": TypeDuplicateParams,
    "ElementSetType": ElementSetTypeParams,
    "ReferenceMove": ReferenceMoveParams,
}


class CommandRequest(BaseModel):
    command: str = Field(..., description="Registered command identifier")
    params: Dict[str, Any] = Field(default_factory=dict, description="Command parameters payload")
    origin: Literal["ui", "ai", "script", "cli"] = Field(default="ui", description="Execution origin tag")


class TransactionRequest(BaseModel):
    commands: List[CommandRequest] = Field(..., description="Ordered list of commands in transaction")
    origin: Literal["ui", "ai", "script", "cli"] = Field(default="ui", description="Transaction origin")
    description: str = Field(default="Transaction", description="Human-readable transaction description")


# ============================================================================
# TRANSACTION & REPLAY JOURNAL ENGINE (Command-Scoped Mementos)
# ============================================================================

def restorable_meta(meta: Dict[str, Any]) -> Dict[str, Any]:
    """
    Deep-copy the *restorable* subset of an `element_meta` entry.

    An entry carries `entity`, a SWIG IFC handle that raises
    `TypeError: cannot pickle 'SwigPyObject' object` under `deepcopy`. A geometry edit
    never changes that handle, so restoring it is neither possible nor wanted — but a
    memento that deep-copies the whole entry cannot even be constructed, which aborts
    the very command it was meant to make reversible.

    Regression this fixes: `ConstraintEqualize` executed before W8 (`71aa5ec`) and
    aborted from it onward, because its new memento captured whole entries. Probe check
    G did not catch it — that check only asserts the command *name* appears in the
    memento region. `scratch/test_memento_reversibility.py` now executes it.
    """
    out: Dict[str, Any] = {}
    for key, value in meta.items():
        try:
            out[key] = copy.deepcopy(value)
        except Exception:
            continue
    return out


# `_mutate_sketch` derives these from the sketch. `pitch` is the dangerous one: it is
# only ever ASSIGNED when the sketch has a slope curve and never cleared, so removing the
# last slope leaves the previous pitch behind. A memento that restores only `sketch`
# therefore leaves the roof claiming a slope that no curve defines — `SketchCurveSetSlope`
# undid to pitch 30 where it started at 15. Capture and re-apply these with the sketch.
SKETCH_DERIVED_KEYS = ("polygon", "thickness", "pitch")


def capture_sketch_derived(meta: Dict[str, Any]) -> Dict[str, Any]:
    return {k: copy.deepcopy(meta[k]) for k in SKETCH_DERIVED_KEYS if k in meta}


def restore_sketch_derived(mgr: Any, guid: str, captured: Dict[str, Any]) -> None:
    """
    Re-assert the derived scalars. Called BEFORE re-applying the sketch, because
    `set_roof_sketch` regenerates geometry from the sketch and that regeneration must see
    the pre-command pitch rather than the one the command just wrote.
    """
    meta = mgr.element_meta.get(guid)
    if not meta:
        return
    for key, value in captured.items():
        meta[key] = copy.deepcopy(value)


class CommandMemento:
    """
    Tier-0 Command-Scoped Memento.
    Captures surgical undo/redo closures for each command without
    full-model STEP string serialization.
    """
    def __init__(self, command: str, undo_fn, redo_fn=None, description: str = ""):
        self.command = command
        self.undo_fn = undo_fn
        self.redo_fn = redo_fn
        self.description = description

    def undo(self, manager):
        if callable(self.undo_fn):
            return self.undo_fn(manager)

    def redo(self, manager):
        if callable(self.redo_fn):
            return self.redo_fn(manager)


class CommandBusEngine:
    """
    Tier-0 Command Bus & Transaction Engine.
    Executes typed commands transactionally against BimModelManager,
    records an append-only replay journal, and manages undo/redo stacks.
    """

    def __init__(self, manager=bim_manager, max_undo_depth: int = 200):
        self.manager = manager
        self.journal: List[Dict[str, Any]] = []
        self.undo_stack: List[Dict[str, Any]] = []
        self.redo_stack: List[Dict[str, Any]] = []
        self.rev: int = 0
        self.max_undo_depth = max_undo_depth
        self._lock = threading.RLock()
        self.drag_sessions: Dict[str, Dict[str, Any]] = {}

    def get_schemas(self) -> Dict[str, Any]:
        """Exports JSON Schema 2020-12 specifications for all registered commands."""
        schemas = {}
        for cmd_name, param_cls in COMMAND_REGISTRY.items():
            schemas[cmd_name] = param_cls.model_json_schema()
        return {
            "version": "2.1",
            "bus_protocol": "BIMWorks_CommandBus_v2.1",
            "commands": schemas,
        }

    def execute_single_command(self, cmd_name: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Dispatches an individual command to BimModelManager."""
        if cmd_name not in COMMAND_REGISTRY:
            raise ValueError(f"Unknown command '{cmd_name}'. Available: {list(COMMAND_REGISTRY.keys())}")

        param_cls = COMMAND_REGISTRY[cmd_name]
        validated = param_cls(**params)

        if cmd_name == "WallCreate":
            p: WallCreateParams = validated
            res = self.manager.add_wall(
                start_pt=tuple(p.start),
                end_pt=tuple(p.end),
                height=p.height,
                thickness=p.thickness,
                level_id=p.level_id,
                name=p.name,
            )
            return {"status": "created", "guid": res["guid"], "class": "IfcWallStandardCase"}

        elif cmd_name == "WallMove":
            p: WallMoveParams = validated
            ok = self.manager.translate_element(p.guid, p.dx, p.dy, p.dz)
            if not ok:
                raise ValueError(f"Element {p.guid} could not be moved")
            return {"status": "moved", "guid": p.guid}

        elif cmd_name == "WallSetHeight":
            p: WallSetHeightParams = validated
            res = self.manager.set_wall_height(p.guid, p.height)
            return {"status": "updated", "guid": p.guid, "height": p.height, "element": res}

        elif cmd_name == "WallSetThickness":
            p: WallSetThicknessParams = validated
            res = self.manager.set_wall_thickness(p.guid, p.thickness)
            return {"status": "updated", "guid": p.guid, "thickness": p.thickness, "element": res}

        elif cmd_name == "WallSetEnd":
            p: WallSetEndParams = validated
            res = self.manager.set_wall_end(p.guid, p.end, p.point, clamp=p.clamp)
            final_pt = res.get(p.end, p.point)
            envelope = {"status": "updated", "guid": p.guid, "end": p.end, "point": final_pt, "element": res}
            if "clamp_reason" in res:
                envelope["clamp_reason"] = res["clamp_reason"]
            return envelope

        elif cmd_name == "OpeningSetOffset":
            p: OpeningSetOffsetParams = validated
            res = self.manager.set_opening_offset(p.guid, p.offset, clamp=p.clamp)
            final_off = float(res.get("offset_along_wall", p.offset))
            envelope = {"status": "updated", "guid": p.guid, "offset": final_off, "element": res}
            if "clamp_reason" in res:
                envelope["clamp_reason"] = res["clamp_reason"]
            return envelope

        elif cmd_name == "OpeningSetWidth":
            p: OpeningSetWidthParams = validated
            res = self.manager.set_opening_width(p.guid, p.width)
            return {"status": "updated", "guid": p.guid, "width": p.width, "element": res}

        elif cmd_name == "OpeningSetSillHeight":
            p: OpeningSetSillHeightParams = validated
            res = self.manager.set_opening_sill_height(p.guid, p.sill_height)
            return {"status": "updated", "guid": p.guid, "sill_height": p.sill_height, "element": res}

        elif cmd_name == "OpeningFlip":
            p: OpeningFlipParams = validated
            res = self.manager.flip_opening(p.guid)
            return {"status": "updated", "guid": p.guid, "swing_flipped": res.get("swing_flipped"), "element": res}

        elif cmd_name == "GridSetEndpoint":
            p: GridSetEndpointParams = validated
            res = self.manager.set_grid_endpoint(p.guid, p.end, p.point)
            return {"status": "updated", "guid": p.guid, "end": p.end, "point": p.point, "grid": res}

        elif cmd_name == "PolygonSetVertex":
            p: PolygonSetVertexParams = validated
            res = self.manager.set_polygon_vertex(p.guid, p.vertex_index, p.point)
            return {"status": "updated", "guid": p.guid, "vertex_index": p.vertex_index, "point": p.point, "element": res}

        elif cmd_name == "ReferenceMove":
            p: ReferenceMoveParams = validated
            norm_src = normalize_reference(p.source)
            norm_tgt = normalize_reference(p.target)

            src_pt, out_src = resolve_reference(self.manager, norm_src)
            tgt_pt, out_tgt = resolve_reference(self.manager, norm_tgt)

            if src_pt is None or tgt_pt is None:
                raise ValueError(
                    f"ReferenceMove could not resolve references: source={out_src}, target={out_tgt}"
                )

            dx = tgt_pt[0] - src_pt[0]
            dy = tgt_pt[1] - src_pt[1]

            if p.axis == "x":
                dy = 0.0
            elif p.axis == "y":
                dx = 0.0

            src_guid = norm_src.get("sources", [{}])[0].get("element_guid") or norm_src.get("guid")
            if not src_guid:
                raise ValueError("Source reference has no element guid to move")

            ok = self.manager.translate_element(src_guid, dx, dy, 0.0, _propagate=(not bool(p.extras)))
            if not ok:
                raise ValueError(f"Element {src_guid} could not be moved to reference target")

            applied_extras = []
            if p.extras:
                from constraint_solver import ConstraintSolver
                solver = ConstraintSolver(self.manager)
                extra_guids = set()
                for k, payload in p.extras:
                    if k in ("align", "dimension_lock"):
                        extra_guids.update([str(g) for g in payload[:2] if g])
                    elif k == "equalize":
                        start, end, interiors = payload
                        extra_guids.update([start, end] + list(interiors))
                scope = solver.affected_guids(list(set([src_guid]) | extra_guids))
                axes = [p.axis] if p.axis in ("x", "y") else ["x", "y"]
                for ax in axes:
                    pins = {}
                    if src_guid in self.manager.element_meta:
                        pins[src_guid] = self.manager.get_element_coord(src_guid, ax)
                    for eg in (extra_guids | {src_guid}):
                        if eg in self.manager.element_meta and self.manager.element_meta[eg].get("ifc_class") == "IfcGrid":
                            c = self.manager.get_element_coord(eg, ax)
                            if c is not None:
                                pins[eg] = c
                    res = solver.solve(axis=ax, pins=pins, scope=scope, extras=p.extras)
                    if res.ok:
                        solver.apply_solve(res)
                        applied_extras.extend(res.applied)
                    elif res.status == "conflict":
                        raise ValueError(f"Constraint conflict during ReferenceMove on axis {ax}: {res.conflicting}")
                    elif res.status == "failed":
                        raise ValueError(f"Constraint solver failure during ReferenceMove on axis {ax}: {res.conflicting}")

            return {
                "status": "moved",
                "guid": src_guid,
                "source": norm_src,
                "target": norm_tgt,
                "dx": dx,
                "dy": dy,
                "applied_extras": applied_extras,
            }

        elif cmd_name == "DoorInsert":
            p: DoorInsertParams = validated
            res = self.manager.add_door(
                host_wall_guid=p.host_wall_guid,
                offset_along_wall=p.offset_along_wall,
                width=p.width,
                height=p.height,
                name=p.name,
                swing_flipped=p.swing_flipped,
            )
            return {"status": "created", "guid": res["guid"], "opening_guid": res["opening_guid"]}

        elif cmd_name == "WindowInsert":
            p: WindowInsertParams = validated
            res = self.manager.add_window(
                host_wall_guid=p.host_wall_guid,
                offset_along_wall=p.offset_along_wall,
                width=p.width,
                height=p.height,
                sill_height=p.sill_height,
                name=p.name,
            )
            return {"status": "created", "guid": res["guid"], "opening_guid": res["opening_guid"]}

        elif cmd_name == "SlabCreate":
            p: SlabCreateParams = validated
            pts = [tuple(pt) for pt in p.polygon]
            res = self.manager.add_slab(
                polygon_pts=pts,
                thickness=p.thickness,
                elevation=p.elevation,
                level_id=p.level_id,
                name=p.name,
            )
            return {"status": "created", "guid": res["guid"]}

        elif cmd_name == "RoofCreate":
            p: RoofCreateParams = validated
            pts = [tuple(pt) for pt in p.polygon]
            res = self.manager.add_roof(
                polygon_pts=pts,
                thickness=p.thickness,
                elevation=p.elevation,
                pitch_degrees=p.pitch_degrees,
                level_id=p.level_id,
                name=p.name,
            )
            return {"status": "created", "guid": res["guid"]}

        elif cmd_name == "GridCreate":
            p: GridCreateParams = validated
            res = self.manager.add_grid(
                axis_name=p.axis_name,
                start_pt=tuple(p.start),
                end_pt=tuple(p.end),
            )
            return {"status": "created", "guid": res["guid"]}

        elif cmd_name == "LevelCreate":
            p: LevelCreateParams = validated
            lid = self.manager.add_level(name=p.name, elevation=p.elevation)
            return {"status": "created", "id": lid}

        elif cmd_name == "DeleteElement":
            p: DeleteElementParams = validated
            ok = self.manager.delete_element(p.guid)
            if not ok:
                raise ValueError(f"Element {p.guid} could not be deleted")
            return {"status": "deleted", "guid": p.guid}

        elif cmd_name == "SetWallJoin":
            p: SetWallJoinParams = validated
            res = self.manager.set_wall_join(
                wall_guid=p.wall_guid,
                end_index=p.end_index,
                allow_join=p.allow_join,
                mode=p.mode,
            )
            return {"status": "updated", "join_policy": res}

        elif cmd_name == "ConstraintAlign":
            p: ConstraintAlignParams = validated
            c = self.manager.add_align_constraint(p.ref_guid, p.target_guid, p.axis, p.lock)
            return {"status": "aligned", "constraint": c}

        elif cmd_name == "ConstraintLockDim":
            p: ConstraintLockDimParams = validated
            c = self.manager.add_dimension_lock(p.guid_a, p.guid_b, p.locked_distance, p.lock, p.axis)
            return {"status": "locked", "constraint": c}

        elif cmd_name == "ConstraintEqualize":
            p: ConstraintEqualizeParams = validated
            c = self.manager.equalize_span(p.span_start_guid, p.span_end_guid, p.interior_guids, p.axis)
            return {"status": "equalized", "constraint": c}

        elif cmd_name == "SketchCurveAdd":
            p: SketchCurveAddParams = validated
            return self.manager.add_sketch_curve(
                p.guid, p.curve_id, (p.start[0], p.start[1]), (p.end[0], p.end[1]),
                p.defines_slope, p.slope_angle,
            )

        elif cmd_name == "SketchCurveMoveVertex":
            p: SketchCurveMoveVertexParams = validated
            return self.manager.move_sketch_vertex(
                p.guid, p.curve_id, p.end_index, (p.to[0], p.to[1])
            )

        elif cmd_name == "SketchCurveMoveEdge":
            p: SketchCurveMoveEdgeParams = validated
            return self.manager.move_sketch_curve(p.guid, p.curve_id, p.dx, p.dy)

        elif cmd_name == "SketchCurveSetSlope":
            p: SketchCurveSlopeParams = validated
            return self.manager.set_sketch_slope(
                p.guid, p.curve_id, p.defines_slope, p.slope_angle
            )

        elif cmd_name == "ElementCopy":
            p: ElementCopyParams = validated
            return self.manager.copy_element(p.guid, p.dx, p.dy, p.dz)

        elif cmd_name == "ElementRotate":
            p: ElementRotateParams = validated
            centre = tuple(p.center) if p.center else None
            return self.manager.rotate_element(p.guid, p.angle_degrees, centre)

        elif cmd_name == "ElementOffset":
            p: ElementOffsetParams = validated
            return self.manager.offset_element(p.guid, p.distance, p.side)

        elif cmd_name == "WallTrimExtend":
            p: WallTrimExtendParams = validated
            return self.manager.trim_extend_wall(
                p.guid,
                p.end_index,
                p.target_guid,
                corner_mode=p.corner_mode,
                target_end_index=p.target_end_index,
            )

        elif cmd_name == "WallSplit":
            p: WallSplitParams = validated
            return self.manager.split_wall(p.guid, p.at_offset, gap=p.gap)

        elif cmd_name == "LevelMove":
            p: LevelMoveParams = validated
            res = self.manager.move_level(p.level_id, p.elevation)
            return {"status": res.get("status", "moved"), "level_id": p.level_id,
                    "elevation": p.elevation, "moved_elements": res.get("moved_elements", 0)}

        elif cmd_name == "ConstraintLockToggle":
            p: ConstraintLockToggleParams = validated
            ok = self.manager.toggle_constraint_lock(p.constraint_id, p.is_locked)
            if not ok:
                raise ValueError(f"Constraint {p.constraint_id} not found")
            return {"status": "updated", "constraint_id": p.constraint_id, "is_locked": p.is_locked}

        elif cmd_name == "ConstraintDelete":
            p: ConstraintDeleteParams = validated
            ok = self.manager.delete_constraint(p.constraint_id)
            if not ok:
                raise ValueError(f"Constraint {p.constraint_id} not found")
            return {"status": "deleted", "constraint_id": p.constraint_id}

        elif cmd_name == "ElementUpdate":
            p: ElementUpdateParams = validated
            res = self.manager.update_element(p.guid, p.updates)
            return {"status": "updated", "guid": p.guid, "element": res}

        elif cmd_name == "SheetCreate":
            p: SheetCreateParams = validated
            sheet = self.manager.add_sheet(
                sheet_number=p.sheet_number,
                sheet_title=p.sheet_title,
                paper_size=p.paper_size,
                is_placeholder=p.is_placeholder,
                sheet_id=p.sheet_id,
                drawn_by=p.drawn_by,
                date=p.date,
                orientation=p.orientation,
            )
            return {"status": "created", "sheet": sheet, "sheet_id": sheet["id"]}

        elif cmd_name == "SheetDelete":
            p: SheetDeleteParams = validated
            ok = self.manager.delete_sheet(p.sheet_id)
            if not ok:
                raise ValueError(f"Sheet {p.sheet_id} could not be deleted")
            return {"status": "deleted", "sheet_id": p.sheet_id}

        elif cmd_name == "SheetUpdate":
            p: SheetUpdateParams = validated
            sheet = self.manager.update_sheet(p.sheet_id, p.updates)
            return {"status": "updated", "sheet": sheet, "sheet_id": p.sheet_id}

        elif cmd_name == "ViewportAdd":
            p: ViewportAddParams = validated
            vp = self.manager.add_viewport_to_sheet(
                sheet_id=p.sheet_id,
                view_id=p.view_id,
                x=p.x,
                y=p.y,
                width=p.width,
                height=p.height,
                scale_factor=p.scale_factor,
                viewport_id=p.viewport_id,
            )
            return {"status": "created", "viewport": vp, "viewport_id": vp["id"]}

        elif cmd_name == "ViewportRemove":
            p: ViewportRemoveParams = validated
            ok = self.manager.remove_viewport_from_sheet(p.viewport_id, p.sheet_id)
            if not ok:
                raise ValueError(f"Viewport {p.viewport_id} could not be removed")
            return {"status": "deleted", "viewport_id": p.viewport_id}

        elif cmd_name == "ViewportMove":
            p: ViewportMoveParams = validated
            vp = self.manager.move_viewport(p.viewport_id, p.x, p.y, p.sheet_id)
            return {"status": "moved", "viewport_id": p.viewport_id, "x": vp["x"], "y": vp["y"]}

        elif cmd_name == "DimensionCreate":
            p: DimensionCreateParams = validated
            dim = self.manager.create_dimension(
                ref_a=p.ref_a,
                ref_b=p.ref_b,
                kind=p.kind,
                axis=p.axis,
                offset=p.offset,
                value=p.value,
                is_locked=p.is_locked,
                eq_group=p.eq_group,
                dimension_id=p.dimension_id,
                refs=p.refs,
                binding=p.binding,
                label=p.label,
                eq_anchor=p.eq_anchor,
            )
            return {"status": "created", "dimension": dim, "dimension_id": dim["id"]}

        elif cmd_name == "DimensionValueSet":
            p: DimensionValueSetParams = validated
            res = self.manager.set_dimension_value(p.dimension_id, p.value, p.anchor)
            status = "error" if (isinstance(res, dict) and (res.get("status") == "error" or "error" in res)) else "updated"
            out = {"status": status, "dimension_id": p.dimension_id, "value": p.value, "result": res}
            if status == "error" and isinstance(res, dict) and "error" in res:
                out["error"] = res["error"]
            return out

        elif cmd_name == "DimensionDelete":
            p: DimensionDeleteParams = validated
            ok = self.manager.delete_dimension(p.dimension_id)
            if not ok:
                raise ValueError(f"Dimension {p.dimension_id} not found")
            return {"status": "deleted", "dimension_id": p.dimension_id}

        elif cmd_name == "DimensionLockToggle":
            p: DimensionLockToggleParams = validated
            if p.dimension_id not in self.manager.dimensions:
                raise ValueError(f"Dimension {p.dimension_id} not found")
            dim = self.manager.dimensions[p.dimension_id]
            dim["is_locked"] = p.is_locked
            if "segments" in dim:
                for s in dim["segments"]:
                    s["locked"] = p.is_locked

            cid = dim.get("constraint_id")
            if p.is_locked:
                if cid and cid in self.manager.constraints:
                    c = self.manager.constraints[cid]
                    c["is_locked"] = True
                    val_float = float(dim.get("value", 0.0))
                    c["locked_distance"] = val_float
                    if c.get("type") == "length_lock":
                        c["locked_length"] = val_float
                    ref_a = c.get("ref_a") or dim.get("ref_a", {})
                    ref_b = c.get("ref_b") or dim.get("ref_b", {})
                    guid_a = c.get("guid_a")
                    guid_b = c.get("guid_b")
                    axis = c.get("axis", "x")
                    if ref_a and ref_b and guid_a and guid_b and guid_a != guid_b and guid_a in self.manager.element_meta and guid_b in self.manager.element_meta:
                        from references import resolve_reference_axis
                        ca, _ = resolve_reference_axis(self.manager, ref_a, axis)
                        cb, _ = resolve_reference_axis(self.manager, ref_b, axis)
                        oa = self.manager.get_element_coord(guid_a, axis)
                        ob = self.manager.get_element_coord(guid_b, axis)
                        if ca is not None and cb is not None:
                            delta_a = ca - oa
                            delta_b = cb - ob
                            s = 1.0 if (cb - ca) >= 0 else -1.0
                            c["origin_distance"] = abs(s * val_float - (delta_b - delta_a))
                else:
                    ref_a = dim.get("ref_a", {})
                    ref_b = dim.get("ref_b", {})
                    guid_a = ref_a.get("guid") or (ref_a.get("sources") and ref_a["sources"][0]["element_guid"])
                    guid_b = ref_b.get("guid") or (ref_b.get("sources") and ref_b["sources"][0]["element_guid"])
                    if guid_a and guid_a in self.manager.element_meta:
                        if guid_b and guid_b in self.manager.element_meta and guid_a != guid_b:
                            c = self.manager.add_dimension_lock(
                                guid_a=guid_a,
                                guid_b=guid_b,
                                locked_distance=float(dim.get("value", 0.0)),
                                is_locked=True,
                                axis=dim.get("axis", "x") if dim.get("axis") in ("x", "y") else "x",
                                ref_a=ref_a,
                                ref_b=ref_b,
                            )
                            dim["constraint_id"] = c.get("id")
                        elif not guid_b or guid_a == guid_b:
                            c_id = f"lenlock_{uuid.uuid4().hex[:8]}"
                            c = {
                                "id": c_id,
                                "type": "length_lock",
                                "guid": guid_a,
                                "guid_a": guid_a,
                                "guid_b": guid_a,
                                "locked_length": float(dim.get("value", 0.0)),
                                "locked_distance": float(dim.get("value", 0.0)),
                                "axis": dim.get("axis", "aligned"),
                                "is_locked": True,
                                "ref_a": ref_a,
                                "ref_b": ref_b,
                            }
                            self.manager.constraints[c_id] = c
                            dim["constraint_id"] = c_id
            else:
                if cid and cid in self.manager.constraints:
                    self.manager.constraints[cid]["is_locked"] = False

            self.manager.dimensions_rev += 1
            self.manager.constraints_rev += 1
            self.manager.project_rev += 1
            return {"status": "updated", "dimension_id": p.dimension_id, "is_locked": p.is_locked}

        elif cmd_name == "TypeCreate":
            p: TypeCreateParams = validated
            return self.manager.create_type(p.type_id, p.name, p.ifc_class, p.parameters)

        elif cmd_name == "TypeUpdate":
            p: TypeUpdateParams = validated
            return self.manager.update_type(p.type_id, p.parameters)

        elif cmd_name == "TypeDuplicate":
            p: TypeDuplicateParams = validated
            return self.manager.duplicate_type(p.source_type_id, p.new_type_id, p.new_name)

        elif cmd_name == "ElementSetType":
            p: ElementSetTypeParams = validated
            return self.manager.set_element_type(p.guid, p.type_id)

        raise ValueError(f"Unhandled command execution: {cmd_name}")

    def _execute_with_memento(self, cmd_name: str, params: Dict[str, Any]) -> Tuple[CommandMemento, Any]:
        """Executes command and returns a surgical CommandMemento for undo/redo."""
        if cmd_name not in COMMAND_REGISTRY:
            raise ValueError(f"Unknown command: {cmd_name}")
        param_cls = COMMAND_REGISTRY[cmd_name]
        validated = param_cls(**params)

        if cmd_name == "WallCreate":
            p: WallCreateParams = validated
            res = self.manager.add_wall(
                p.start, p.end, height=p.height, thickness=p.thickness,
                level_id=p.level_id, name=p.name
            )
            guid = res["guid"]
            def undo_fn(mgr):
                mgr.delete_element(guid)
            def redo_fn(mgr):
                mgr.add_wall(p.start, p.end, height=p.height, thickness=p.thickness, level_id=p.level_id, name=p.name, guid=guid)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "WallMove":
            p: WallMoveParams = validated
            guid, dx, dy, dz = p.guid, p.dx, p.dy, p.dz
            ok = self.manager.translate_element(guid, dx, dy, dz)
            if not ok:
                raise ValueError(f"Wall {guid} could not be moved")
            def undo_fn(mgr):
                mgr.translate_element(guid, -dx, -dy, -dz)
            def redo_fn(mgr):
                mgr.translate_element(guid, dx, dy, dz)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "moved", "guid": guid, "dx": dx, "dy": dy, "dz": dz}

        elif cmd_name == "WallSetHeight":
            p: WallSetHeightParams = validated
            meta = self.manager.element_meta.get(p.guid)
            if not meta:
                raise KeyError(f"Wall {p.guid} not found")
            old_h = float(meta.get("height", 10.0))
            new_h = float(p.height)
            res = self.manager.set_wall_height(p.guid, new_h)
            def undo_fn(mgr):
                mgr.set_wall_height(p.guid, old_h)
            def redo_fn(mgr):
                mgr.set_wall_height(p.guid, new_h)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "updated", "guid": p.guid, "height": new_h, "element": res}

        elif cmd_name == "WallSetThickness":
            p: WallSetThicknessParams = validated
            meta = self.manager.element_meta.get(p.guid)
            if not meta:
                raise KeyError(f"Wall {p.guid} not found")
            old_th = float(meta.get("thickness", 0.2))
            new_th = float(p.thickness)
            res = self.manager.set_wall_thickness(p.guid, new_th)
            def undo_fn(mgr):
                mgr.set_wall_thickness(p.guid, old_th)
            def redo_fn(mgr):
                mgr.set_wall_thickness(p.guid, new_th)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "updated", "guid": p.guid, "thickness": new_th, "element": res}

        elif cmd_name == "WallSetEnd":
            p: WallSetEndParams = validated
            meta = self.manager.element_meta.get(p.guid)
            if not meta:
                raise KeyError(f"Wall {p.guid} not found")
            old_pt = list(meta.get(p.end, [0.0, 0.0, 0.0]))
            res = self.manager.set_wall_end(p.guid, p.end, p.point, clamp=p.clamp)
            final_pt = res.get(p.end, p.point)
            def undo_fn(mgr):
                mgr.set_wall_end(p.guid, p.end, old_pt, clamp=False)
            def redo_fn(mgr):
                mgr.set_wall_end(p.guid, p.end, final_pt, clamp=False)
            envelope = {"status": "updated", "guid": p.guid, "end": p.end, "point": final_pt, "element": res}
            if "clamp_reason" in res:
                envelope["clamp_reason"] = res["clamp_reason"]
            return CommandMemento(cmd_name, undo_fn, redo_fn), envelope

        elif cmd_name == "OpeningSetOffset":
            p: OpeningSetOffsetParams = validated
            meta = self.manager.element_meta.get(p.guid)
            if not meta:
                raise KeyError(f"Opening {p.guid} not found")
            old_off = float(meta.get("offset_along_wall", 0.0))
            res = self.manager.set_opening_offset(p.guid, p.offset, clamp=p.clamp)
            final_off = float(res.get("offset_along_wall", p.offset))
            def undo_fn(mgr):
                mgr.set_opening_offset(p.guid, old_off, clamp=False)
            def redo_fn(mgr):
                mgr.set_opening_offset(p.guid, final_off, clamp=False)
            envelope = {"status": "updated", "guid": p.guid, "offset": final_off, "element": res}
            if "clamp_reason" in res:
                envelope["clamp_reason"] = res["clamp_reason"]
            return CommandMemento(cmd_name, undo_fn, redo_fn), envelope

        elif cmd_name == "OpeningSetWidth":
            p: OpeningSetWidthParams = validated
            meta = self.manager.element_meta.get(p.guid)
            if not meta:
                raise KeyError(f"Opening {p.guid} not found")
            old_w = float(meta.get("width", 0.9))
            new_w = float(p.width)
            res = self.manager.set_opening_width(p.guid, new_w)
            def undo_fn(mgr):
                mgr.set_opening_width(p.guid, old_w)
            def redo_fn(mgr):
                mgr.set_opening_width(p.guid, new_w)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "updated", "guid": p.guid, "width": new_w, "element": res}

        elif cmd_name == "OpeningSetSillHeight":
            p: OpeningSetSillHeightParams = validated
            meta = self.manager.element_meta.get(p.guid)
            if not meta:
                raise KeyError(f"Opening {p.guid} not found")
            old_sh = float(meta.get("sill_height") or 0.0)
            new_sh = float(p.sill_height)
            res = self.manager.set_opening_sill_height(p.guid, new_sh)
            def undo_fn(mgr):
                mgr.set_opening_sill_height(p.guid, old_sh)
            def redo_fn(mgr):
                mgr.set_opening_sill_height(p.guid, new_sh)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "updated", "guid": p.guid, "sill_height": new_sh, "element": res}

        elif cmd_name == "OpeningFlip":
            p: OpeningFlipParams = validated
            res = self.manager.flip_opening(p.guid)
            def undo_fn(mgr):
                mgr.flip_opening(p.guid)
            def redo_fn(mgr):
                mgr.flip_opening(p.guid)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "updated", "guid": p.guid, "swing_flipped": res.get("swing_flipped"), "element": res}

        elif cmd_name == "GridSetEndpoint":
            p: GridSetEndpointParams = validated
            meta = self.manager.element_meta.get(p.guid)
            if not meta:
                raise KeyError(f"Grid {p.guid} not found")
            old_pt = list(meta.get(p.end, [0.0, 0.0]))
            new_pt = list(p.point)
            res = self.manager.set_grid_endpoint(p.guid, p.end, new_pt)
            def undo_fn(mgr):
                mgr.set_grid_endpoint(p.guid, p.end, old_pt)
            def redo_fn(mgr):
                mgr.set_grid_endpoint(p.guid, p.end, new_pt)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "updated", "guid": p.guid, "end": p.end, "point": new_pt, "grid": res}

        elif cmd_name == "PolygonSetVertex":
            p: PolygonSetVertexParams = validated
            meta = self.manager.element_meta.get(p.guid)
            if not meta:
                raise KeyError(f"Element {p.guid} not found")
            poly = meta.get("polygon", [])
            old_pt = list(poly[p.vertex_index])
            new_pt = list(p.point)
            res = self.manager.set_polygon_vertex(p.guid, p.vertex_index, new_pt)
            def undo_fn(mgr):
                mgr.set_polygon_vertex(p.guid, p.vertex_index, old_pt)
            def redo_fn(mgr):
                mgr.set_polygon_vertex(p.guid, p.vertex_index, new_pt)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "updated", "guid": p.guid, "vertex_index": p.vertex_index, "point": new_pt, "element": res}

        elif cmd_name == "ReferenceMove":
            pre_coords = {
                g: (self.manager.get_element_coord(g, "x"), self.manager.get_element_coord(g, "y"))
                for g in self.manager.element_meta
            }
            res = self.execute_single_command(cmd_name, params)
            moved_deltas = {}
            for g, (ox, oy) in pre_coords.items():
                if g in self.manager.element_meta:
                    cx, cy = self.manager.get_element_coord(g, "x"), self.manager.get_element_coord(g, "y")
                    if abs(cx - ox) > 1e-6 or abs(cy - oy) > 1e-6:
                        moved_deltas[g] = (cx - ox, cy - oy)
            def undo_fn(mgr):
                for mg, (mdx, mdy) in moved_deltas.items():
                    mgr.translate_element(mg, -mdx, -mdy, 0.0, _propagate=False)
            def redo_fn(mgr):
                for mg, (mdx, mdy) in moved_deltas.items():
                    mgr.translate_element(mg, mdx, mdy, 0.0, _propagate=False)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "DoorInsert":
            p: DoorInsertParams = validated
            res = self.manager.add_door(
                p.host_wall_guid, p.offset_along_wall, width=p.width, height=p.height,
                name=p.name, swing_flipped=p.swing_flipped
            )
            guid = res["guid"]
            def undo_fn(mgr):
                mgr.delete_element(guid)
            def redo_fn(mgr):
                mgr.add_door(p.host_wall_guid, p.offset_along_wall, width=p.width, height=p.height, name=p.name, swing_flipped=p.swing_flipped, guid=guid)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "WindowInsert":
            p: WindowInsertParams = validated
            res = self.manager.add_window(
                p.host_wall_guid, p.offset_along_wall, width=p.width, height=p.height,
                sill_height=p.sill_height, name=p.name
            )
            guid = res["guid"]
            def undo_fn(mgr):
                mgr.delete_element(guid)
            def redo_fn(mgr):
                mgr.add_window(p.host_wall_guid, p.offset_along_wall, width=p.width, height=p.height, sill_height=p.sill_height, name=p.name, guid=guid)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "SlabCreate":
            p: SlabCreateParams = validated
            res = self.manager.add_slab(
                p.polygon, thickness=p.thickness, elevation=p.elevation,
                level_id=p.level_id, name=p.name
            )
            guid = res["guid"]
            def undo_fn(mgr):
                mgr.delete_element(guid)
            def redo_fn(mgr):
                mgr.add_slab(p.polygon, thickness=p.thickness, elevation=p.elevation, level_id=p.level_id, name=p.name, guid=guid)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "RoofCreate":
            p: RoofCreateParams = validated
            res = self.manager.add_roof(
                p.polygon, thickness=p.thickness, elevation=p.elevation,
                pitch_degrees=p.pitch_degrees, level_id=p.level_id, name=p.name
            )
            guid = res["guid"]
            def undo_fn(mgr):
                mgr.delete_element(guid)
            def redo_fn(mgr):
                mgr.add_roof(p.polygon, thickness=p.thickness, elevation=p.elevation, pitch_degrees=p.pitch_degrees, level_id=p.level_id, name=p.name, guid=guid)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "GridCreate":
            p: GridCreateParams = validated
            res = self.manager.add_grid(p.axis_name, p.start, p.end)
            guid = res["guid"]
            def undo_fn(mgr):
                mgr.delete_element(guid)
            def redo_fn(mgr):
                mgr.add_grid(p.axis_name, p.start, p.end, guid=guid)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "LevelCreate":
            p: LevelCreateParams = validated
            lid = self.manager.add_level(p.name, p.elevation)
            def undo_fn(mgr):
                if lid in mgr.levels:
                    del mgr.levels[lid]
                    mgr.levels_rev += 1
            def redo_fn(mgr):
                mgr.add_level(p.name, p.elevation)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "created", "id": lid}

        elif cmd_name == "DeleteElement":
            p: DeleteElementParams = validated
            guid = p.guid
            raw_meta = self.manager.element_meta.get(guid)
            meta_pre = {k: copy.deepcopy(v) for k, v in raw_meta.items() if k != "entity" and not k.endswith("_entity") and not hasattr(v, "is_a")} if raw_meta else None
            dims_pre = copy.deepcopy({
                did: d for did, d in getattr(self.manager, "dimensions", {}).items()
                if (
                    d.get("ref_a", {}).get("guid") == guid
                    or d.get("ref_b", {}).get("guid") == guid
                    or any(s.get("element_guid") == guid for s in (d.get("ref_a", {}).get("sources", []) + d.get("ref_b", {}).get("sources", [])))
                )
            })
            cids_pre = [d["constraint_id"] for d in dims_pre.values() if d.get("constraint_id")]
            constraints_pre = copy.deepcopy({
                cid: self.manager.constraints[cid] for cid in cids_pre if cid in getattr(self.manager, "constraints", {})
            })
            ok = self.manager.delete_element(guid)
            if not ok:
                raise ValueError(f"Element {guid} could not be deleted")
            def undo_fn(mgr):
                if meta_pre:
                    ifc_cls = meta_pre.get("ifc_class")
                    if ifc_cls in ("IfcWallStandardCase", "IfcWall"):
                        mgr.add_wall(meta_pre["start"], meta_pre["end"], height=meta_pre.get("height", 10.0), thickness=meta_pre.get("thickness", 0.67), level_id=meta_pre.get("level_id"), name=meta_pre.get("name", "Wall"), guid=guid, type_id=meta_pre.get("type_id"))
                    elif ifc_cls == "IfcDoor":
                        mgr.add_door(meta_pre["host_wall_guid"], meta_pre["offset_along_wall"], width=meta_pre.get("width", 3.0), height=meta_pre.get("height", 7.0), name=meta_pre.get("name", "Door"), guid=guid, type_id=meta_pre.get("type_id"))
                    elif ifc_cls == "IfcWindow":
                        mgr.add_window(meta_pre["host_wall_guid"], meta_pre["offset_along_wall"], width=meta_pre.get("width", 4.0), height=meta_pre.get("height", 4.0), sill_height=meta_pre.get("sill_height", 3.0), name=meta_pre.get("name", "Window"), guid=guid, type_id=meta_pre.get("type_id"))
                    elif ifc_cls == "IfcSlab":
                        mgr.add_slab(meta_pre.get("polygon", []), elevation=meta_pre.get("elevation", 0.0), thickness=meta_pre.get("thickness", 0.25), name=meta_pre.get("name", "Floor"), guid=guid)
                    elif ifc_cls == "IfcRoof":
                        mgr.add_roof(meta_pre.get("polygon", []), elevation=meta_pre.get("elevation", 6.0), thickness=meta_pre.get("thickness", 0.3), pitch=meta_pre.get("pitch", 15.0), name=meta_pre.get("name", "Roof"), guid=guid)
                if constraints_pre:
                    mgr.constraints.update(copy.deepcopy(constraints_pre))
                    mgr.constraints_rev += 1
                if dims_pre:
                    mgr.dimensions.update(copy.deepcopy(dims_pre))
                    mgr.dimensions_rev += 1
            def redo_fn(mgr):
                mgr.delete_element(guid)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "deleted", "guid": guid}

        elif cmd_name == "WallTrimExtend":
            p: WallTrimExtendParams = validated
            w1_pre = copy.deepcopy({k: self.manager.element_meta[p.guid][k] for k in ("start", "end", "length", "angle", "height") if k in self.manager.element_meta.get(p.guid, {})})
            w2_pre = copy.deepcopy({k: self.manager.element_meta[p.target_guid][k] for k in ("start", "end", "length", "angle", "height") if k in self.manager.element_meta.get(p.target_guid, {})}) if p.target_guid in self.manager.element_meta else None
            res = self.manager.trim_extend_wall(p.guid, p.end_index, p.target_guid, corner_mode=p.corner_mode, target_end_index=p.target_end_index)
            def undo_fn(mgr):
                if p.guid in mgr.element_meta and w1_pre:
                    mgr.element_meta[p.guid].update(w1_pre)
                    mgr.element_meta[p.guid]["footprint"] = None
                    mgr._rebuild_wall_representation(p.guid)
                    mgr.mark_mesh_dirty(p.guid)
                if p.target_guid in mgr.element_meta and w2_pre:
                    mgr.element_meta[p.target_guid].update(w2_pre)
                    mgr.element_meta[p.target_guid]["footprint"] = None
                    mgr._rebuild_wall_representation(p.target_guid)
                    mgr.mark_mesh_dirty(p.target_guid)
                mgr.recompute_wall_joins(only=[g for g in (p.guid, p.target_guid) if g in mgr.element_meta])
            def redo_fn(mgr):
                mgr.trim_extend_wall(p.guid, p.end_index, p.target_guid, corner_mode=p.corner_mode, target_end_index=p.target_end_index)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "WallSplit":
            p: WallSplitParams = validated
            w_pre = copy.deepcopy({k: self.manager.element_meta[p.guid][k] for k in ("start", "end", "length", "hosted_openings") if k in self.manager.element_meta.get(p.guid, {})})
            res = self.manager.split_wall(p.guid, p.at_offset, gap=p.gap)
            new_guid = res["new_guid"]
            def undo_fn(mgr):
                mgr.delete_element(new_guid)
                if p.guid in mgr.element_meta and w_pre:
                    mgr.element_meta[p.guid].update(w_pre)
                    mgr.element_meta[p.guid]["footprint"] = None
                    mgr._rebuild_wall_representation(p.guid)
                    mgr.mark_mesh_dirty(p.guid)
                    mgr.recompute_wall_joins(only=[p.guid])
            def redo_fn(mgr):
                mgr.split_wall(p.guid, p.at_offset, gap=p.gap)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "DimensionCreate":
            p: DimensionCreateParams = validated
            dim = self.manager.create_dimension(
                ref_a=p.ref_a,
                ref_b=p.ref_b,
                kind=p.kind,
                axis=p.axis,
                offset=p.offset,
                value=p.value,
                is_locked=p.is_locked,
                eq_group=p.eq_group,
                dimension_id=p.dimension_id,
                refs=p.refs,
                binding=p.binding,
                label=p.label,
                eq_anchor=p.eq_anchor,
            )
            dim_id = dim["id"]
            def undo_fn(mgr):
                mgr.delete_dimension(dim_id)
            def redo_fn(mgr):
                mgr.create_dimension(
                    ref_a=p.ref_a,
                    ref_b=p.ref_b,
                    kind=p.kind,
                    axis=p.axis,
                    offset=p.offset,
                    value=p.value,
                    is_locked=p.is_locked,
                    eq_group=p.eq_group,
                    dimension_id=dim_id,
                    refs=p.refs,
                    binding=p.binding,
                    label=p.label,
                    eq_anchor=p.eq_anchor,
                )
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "created", "dimension": dim, "dimension_id": dim_id}

        elif cmd_name == "DimensionValueSet":
            p: DimensionValueSetParams = validated
            dim_pre = copy.deepcopy(getattr(self.manager, "dimensions", {}).get(p.dimension_id))
            res = self.manager.set_dimension_value(p.dimension_id, p.value, p.anchor)
            status = "error" if (isinstance(res, dict) and (res.get("status") == "error" or "error" in res)) else "updated"
            def undo_fn(mgr):
                if dim_pre and "value" in dim_pre:
                    mgr.set_dimension_value(p.dimension_id, dim_pre["value"], p.anchor)
            def redo_fn(mgr):
                mgr.set_dimension_value(p.dimension_id, p.value, p.anchor)
            out = {"status": status, "dimension_id": p.dimension_id, "value": p.value, "result": res}
            if status == "error" and isinstance(res, dict) and "error" in res:
                out["error"] = res["error"]
            return CommandMemento(cmd_name, undo_fn, redo_fn), out

        elif cmd_name == "DimensionDelete":
            p: DimensionDeleteParams = validated
            dim_pre = copy.deepcopy(getattr(self.manager, "dimensions", {}).get(p.dimension_id))
            ok = self.manager.delete_dimension(p.dimension_id)
            def undo_fn(mgr):
                if dim_pre:
                    mgr.dimensions[p.dimension_id] = dim_pre
                    mgr.dimensions_rev += 1
            def redo_fn(mgr):
                mgr.delete_dimension(p.dimension_id)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "deleted", "dimension_id": p.dimension_id}

        elif cmd_name == "DimensionLockToggle":
            p: DimensionLockToggleParams = validated
            dim = self.manager.dimensions.get(p.dimension_id)
            prev_locked = dim.get("is_locked", False) if dim else False
            did = p.dimension_id
            cid = dim.get("constraint_id") if dim else None
            prev_constraint = copy.deepcopy(self.manager.constraints.get(cid)) if cid and cid in self.manager.constraints else None

            res = self.execute_single_command(cmd_name, p.model_dump())

            post_cid = self.manager.dimensions.get(did, {}).get("constraint_id")
            post_constraint = copy.deepcopy(self.manager.constraints.get(post_cid)) if post_cid and post_cid in self.manager.constraints else None

            def undo_fn(mgr):
                if did in mgr.dimensions:
                    mgr.dimensions[did]["is_locked"] = prev_locked
                    if "segments" in mgr.dimensions[did]:
                        for s in mgr.dimensions[did]["segments"]:
                            s["locked"] = prev_locked
                    mgr.dimensions_rev += 1
                if cid:
                    if prev_constraint is not None:
                        mgr.constraints[cid] = copy.deepcopy(prev_constraint)
                    elif cid in mgr.constraints:
                        del mgr.constraints[cid]
                    mgr.constraints_rev += 1
                elif post_cid and post_cid in mgr.constraints:
                    del mgr.constraints[post_cid]
                    if did in mgr.dimensions:
                        mgr.dimensions[did]["constraint_id"] = None
                    mgr.constraints_rev += 1
                mgr.project_rev += 1

            def redo_fn(mgr):
                if did in mgr.dimensions:
                    mgr.dimensions[did]["is_locked"] = p.is_locked
                    if "segments" in mgr.dimensions[did]:
                        for s in mgr.dimensions[did]["segments"]:
                            s["locked"] = p.is_locked
                    mgr.dimensions_rev += 1
                if post_cid and post_constraint is not None:
                    mgr.constraints[post_cid] = copy.deepcopy(post_constraint)
                    if did in mgr.dimensions:
                        mgr.dimensions[did]["constraint_id"] = post_cid
                    mgr.constraints_rev += 1
                elif cid and cid in mgr.constraints:
                    mgr.constraints[cid]["is_locked"] = p.is_locked
                    mgr.constraints_rev += 1
                mgr.project_rev += 1

            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "LevelMove":
            p: LevelMoveParams = validated
            old_elev = float(self.manager.levels[p.level_id]["elevation"])
            res = self.manager.move_level(p.level_id, p.elevation)
            def undo_fn(mgr):
                mgr.move_level(p.level_id, old_elev)
            def redo_fn(mgr):
                mgr.move_level(p.level_id, p.elevation)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "ElementRotate":
            p: ElementRotateParams = validated
            centre = tuple(p.center) if p.center else None
            res = self.manager.rotate_element(p.guid, p.angle_degrees, centre)
            def undo_fn(mgr):
                mgr.rotate_element(p.guid, -p.angle_degrees, centre)
            def redo_fn(mgr):
                mgr.rotate_element(p.guid, p.angle_degrees, centre)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "ElementOffset":
            p: ElementOffsetParams = validated
            res = self.manager.offset_element(p.guid, p.distance, p.side)
            def undo_fn(mgr):
                mgr.offset_element(p.guid, p.distance, -p.side)
            def redo_fn(mgr):
                mgr.offset_element(p.guid, p.distance, p.side)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "TypeCreate":
            p: TypeCreateParams = validated
            res = self.manager.create_type(p.type_id, p.name, p.ifc_class, p.parameters)
            def undo_fn(mgr):
                mgr.delete_type(p.type_id)
            def redo_fn(mgr):
                mgr.create_type(p.type_id, p.name, p.ifc_class, p.parameters)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "TypeUpdate":
            p: TypeUpdateParams = validated
            old_type = self.manager.type_registry.get(p.type_id)
            old_params = copy.deepcopy(old_type.get("parameters", {})) if old_type else {}
            res = self.manager.update_type(p.type_id, p.parameters)
            def undo_fn(mgr):
                mgr.update_type(p.type_id, old_params)
            def redo_fn(mgr):
                mgr.update_type(p.type_id, p.parameters)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "TypeDuplicate":
            p: TypeDuplicateParams = validated
            res = self.manager.duplicate_type(p.source_type_id, p.new_type_id, p.new_name)
            def undo_fn(mgr):
                mgr.delete_type(p.new_type_id)
            def redo_fn(mgr):
                mgr.duplicate_type(p.source_type_id, p.new_type_id, p.new_name)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "ElementSetType":
            p: ElementSetTypeParams = validated
            old_meta = self.manager.element_meta.get(p.guid, {})
            old_type_id = old_meta.get("type_id")
            res = self.manager.set_element_type(p.guid, p.type_id)
            def undo_fn(mgr):
                if old_type_id:
                    mgr.set_element_type(p.guid, old_type_id)
            def redo_fn(mgr):
                mgr.set_element_type(p.guid, p.type_id)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "SheetUpdate":
            p: SheetUpdateParams = validated
            old_sheet = copy.deepcopy(self.manager.sheets.get(p.sheet_id, {}))
            sheet = self.manager.update_sheet(p.sheet_id, p.updates)
            def undo_fn(mgr):
                mgr.update_sheet(p.sheet_id, old_sheet)
            def redo_fn(mgr):
                mgr.update_sheet(p.sheet_id, p.updates)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "updated", "sheet": sheet, "sheet_id": p.sheet_id}

        elif cmd_name == "ElementCopy":
            p: ElementCopyParams = validated
            res = self.manager.copy_element(p.guid, p.dx, p.dy, p.dz)
            new_guid = res.get("guid")
            def undo_fn(mgr):
                if new_guid:
                    mgr.delete_element(new_guid)
            def redo_fn(mgr):
                mgr.copy_element(p.guid, p.dx, p.dy, p.dz)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "ElementUpdate":
            p: ElementUpdateParams = validated
            raw_meta = self.manager.element_meta.get(p.guid, {})
            old_vals = {}
            for k in p.updates.keys():
                if k in raw_meta:
                    old_vals[k] = copy.deepcopy(raw_meta[k])
            res = self.manager.update_element(p.guid, p.updates)
            def undo_fn(mgr):
                if old_vals:
                    mgr.update_element(p.guid, old_vals)
            def redo_fn(mgr):
                mgr.update_element(p.guid, p.updates)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "updated", "guid": p.guid, "element": res}

        elif cmd_name == "SheetCreate":
            p: SheetCreateParams = validated
            sheet = self.manager.add_sheet(
                sheet_number=p.sheet_number,
                sheet_title=p.sheet_title,
                paper_size=p.paper_size,
                drawn_by=p.drawn_by,
                is_placeholder=p.is_placeholder,
                sheet_id=p.sheet_id,
                orientation=p.orientation,
            )
            sid = sheet["id"]
            def undo_fn(mgr):
                mgr.delete_sheet(sid)
            def redo_fn(mgr):
                mgr.add_sheet(
                    sheet_number=p.sheet_number,
                    sheet_title=p.sheet_title,
                    paper_size=p.paper_size,
                    drawn_by=p.drawn_by,
                    is_placeholder=p.is_placeholder,
                    sheet_id=sid,
                    orientation=p.orientation,
                )
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "created", "sheet": sheet, "sheet_id": sid}

        elif cmd_name == "SheetDelete":
            p: SheetDeleteParams = validated
            old_sheet = copy.deepcopy(self.manager.sheets.get(p.sheet_id))
            self.manager.delete_sheet(p.sheet_id)
            def undo_fn(mgr):
                if old_sheet:
                    mgr.sheets[p.sheet_id] = copy.deepcopy(old_sheet)
                    mgr.sheets_rev += 1
            def redo_fn(mgr):
                mgr.delete_sheet(p.sheet_id)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "deleted", "sheet_id": p.sheet_id}

        elif cmd_name == "ViewportAdd":
            p: ViewportAddParams = validated
            vp = self.manager.add_viewport_to_sheet(
                sheet_id=p.sheet_id,
                view_id=p.view_id,
                x=p.x,
                y=p.y,
                width=p.width,
                height=p.height,
                scale_factor=p.scale_factor,
                viewport_id=p.viewport_id,
            )
            vpid = vp["id"]
            def undo_fn(mgr):
                mgr.remove_viewport_from_sheet(vpid, p.sheet_id)
            def redo_fn(mgr):
                mgr.add_viewport_to_sheet(
                    sheet_id=p.sheet_id,
                    view_id=p.view_id,
                    x=p.x,
                    y=p.y,
                    width=p.width,
                    height=p.height,
                    scale_factor=p.scale_factor,
                    viewport_id=vpid,
                )
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "created", "viewport": vp, "viewport_id": vpid}

        elif cmd_name == "ViewportRemove":
            p: ViewportRemoveParams = validated
            old_sheet = copy.deepcopy(self.manager.sheets.get(p.sheet_id)) if p.sheet_id else None
            if not old_sheet:
                for s in self.manager.sheets.values():
                    if any(vp.get("id") == p.viewport_id for vp in s.get("viewports", [])):
                        old_sheet = copy.deepcopy(s)
                        break
            ok = self.manager.remove_viewport_from_sheet(p.viewport_id, p.sheet_id)
            if not ok:
                raise ValueError(f"Viewport {p.viewport_id} could not be removed")
            def undo_fn(mgr):
                if old_sheet:
                    mgr.sheets[old_sheet["id"]] = copy.deepcopy(old_sheet)
                    mgr.sheets_rev += 1
            def redo_fn(mgr):
                mgr.remove_viewport_from_sheet(p.viewport_id, p.sheet_id)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "deleted", "viewport_id": p.viewport_id}

        elif cmd_name == "ViewportMove":
            p: ViewportMoveParams = validated
            old_vp = None
            for s in self.manager.sheets.values():
                for vp_item in s.get("viewports", []):
                    if vp_item.get("id") == p.viewport_id:
                        old_vp = copy.deepcopy(vp_item)
                        break
                if old_vp:
                    break
            old_x = old_vp.get("x", 0.0) if old_vp else 0.0
            old_y = old_vp.get("y", 0.0) if old_vp else 0.0
            vp = self.manager.move_viewport(p.viewport_id, p.x, p.y, p.sheet_id)
            def undo_fn(mgr):
                mgr.move_viewport(p.viewport_id, old_x, old_y, p.sheet_id)
            def redo_fn(mgr):
                mgr.move_viewport(p.viewport_id, p.x, p.y, p.sheet_id)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "moved", "viewport_id": p.viewport_id, "x": vp["x"], "y": vp["y"]}

        elif cmd_name == "SetWallJoin":
            p: SetWallJoinParams = validated
            prev_policy = copy.deepcopy(self.manager.join_policies.get(p.wall_guid))
            res = self.manager.set_wall_join(
                wall_guid=p.wall_guid,
                end_index=p.end_index,
                allow_join=p.allow_join,
                mode=p.mode,
            )
            def undo_fn(mgr):
                if prev_policy is not None:
                    mgr.join_policies[p.wall_guid] = copy.deepcopy(prev_policy)
                else:
                    mgr.join_policies.pop(p.wall_guid, None)
                mgr.recompute_wall_joins()
            def redo_fn(mgr):
                mgr.set_wall_join(
                    wall_guid=p.wall_guid,
                    end_index=p.end_index,
                    allow_join=p.allow_join,
                    mode=p.mode,
                )
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "updated", "join_policy": res}

        elif cmd_name == "ConstraintAlign":
            p: ConstraintAlignParams = validated
            if p.ref_guid not in self.manager.element_meta or p.target_guid not in self.manager.element_meta:
                raise ValueError("Reference or target element not found.")
            ref_pos = self.manager.get_element_coord(p.ref_guid, p.axis)
            target_pos = self.manager.get_element_coord(p.target_guid, p.axis)
            delta = ref_pos - target_pos
            dx = delta if p.axis == "x" else 0.0
            dy = delta if p.axis == "y" else 0.0
            dz = delta if p.axis == "z" else 0.0

            c = self.manager.add_align_constraint(p.ref_guid, p.target_guid, p.axis, p.lock)
            cid = c["id"]
            saved_c = copy.deepcopy(c)

            def undo_fn(mgr):
                if abs(delta) > 1e-4:
                    mgr.translate_element(p.target_guid, -dx, -dy, -dz)
                if cid in mgr.constraints:
                    del mgr.constraints[cid]
                    mgr.save_constraints_to_ifc()
            def redo_fn(mgr):
                if abs(delta) > 1e-4:
                    mgr.translate_element(p.target_guid, dx, dy, dz)
                mgr.constraints[cid] = copy.deepcopy(saved_c)
                mgr.save_constraints_to_ifc()
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "aligned", "constraint": c}

        elif cmd_name == "ConstraintLockDim":
            p: ConstraintLockDimParams = validated
            c = self.manager.add_dimension_lock(p.guid_a, p.guid_b, p.locked_distance, p.lock, p.axis)
            cid = c["id"]
            saved_c = copy.deepcopy(c)
            def undo_fn(mgr):
                if cid in mgr.constraints:
                    del mgr.constraints[cid]
                    mgr.save_constraints_to_ifc()
            def redo_fn(mgr):
                mgr.constraints[cid] = copy.deepcopy(saved_c)
                mgr.save_constraints_to_ifc()
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "locked", "constraint": c}

        elif cmd_name == "ConstraintEqualize":
            p: ConstraintEqualizeParams = validated
            prev_meta = {
                g: restorable_meta(self.manager.element_meta[g])
                for g in p.interior_guids if g in self.manager.element_meta
            }
            prev_c_id = None
            prev_c_val = None
            for existing_id, existing in self.manager.constraints.items():
                if (
                    existing.get("type") == "equalize"
                    and existing.get("span_start_guid") == p.span_start_guid
                    and existing.get("span_end_guid") == p.span_end_guid
                    and existing.get("axis", "x") == p.axis
                ):
                    prev_c_id = existing_id
                    prev_c_val = copy.deepcopy(existing)
                    break

            c = self.manager.equalize_span(p.span_start_guid, p.span_end_guid, p.interior_guids, p.axis)
            cid = c["id"]

            def undo_fn(mgr):
                for g, meta in prev_meta.items():
                    if g in mgr.element_meta:
                        mgr.element_meta[g].update(copy.deepcopy(meta))
                        mgr.mark_mesh_dirty(g)
                if prev_c_id and prev_c_val:
                    mgr.constraints[prev_c_id] = copy.deepcopy(prev_c_val)
                elif cid in mgr.constraints:
                    del mgr.constraints[cid]
                mgr.save_constraints_to_ifc()

            def redo_fn(mgr):
                mgr.equalize_span(p.span_start_guid, p.span_end_guid, p.interior_guids, p.axis)

            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "equalized", "constraint": c}

        elif cmd_name == "SketchCurveAdd":
            p: SketchCurveAddParams = validated
            prev_sketch_dict = copy.deepcopy(self.manager.element_meta.get(p.guid, {}).get("sketch"))
            prev_derived = capture_sketch_derived(self.manager.element_meta.get(p.guid, {}))
            res = self.manager.add_sketch_curve(
                p.guid, p.curve_id, (p.start[0], p.start[1]), (p.end[0], p.end[1]),
                p.defines_slope, p.slope_angle,
            )
            def undo_fn(mgr):
                restore_sketch_derived(mgr, p.guid, prev_derived)
                if prev_sketch_dict:
                    from sketch_model import Sketch
                    mgr.set_roof_sketch(p.guid, Sketch.from_dict(prev_sketch_dict))
                else:
                    mgr.remove_sketch_curve(p.guid, p.curve_id)
                mgr.mark_mesh_dirty(p.guid)
            def redo_fn(mgr):
                mgr.add_sketch_curve(
                    p.guid, p.curve_id, (p.start[0], p.start[1]), (p.end[0], p.end[1]),
                    p.defines_slope, p.slope_angle,
                )
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "SketchCurveMoveVertex":
            p: SketchCurveMoveVertexParams = validated
            prev_sketch_dict = copy.deepcopy(self.manager.element_meta.get(p.guid, {}).get("sketch"))
            prev_derived = capture_sketch_derived(self.manager.element_meta.get(p.guid, {}))
            res = self.manager.move_sketch_vertex(
                p.guid, p.curve_id, p.end_index, (p.to[0], p.to[1])
            )
            def undo_fn(mgr):
                restore_sketch_derived(mgr, p.guid, prev_derived)
                if prev_sketch_dict:
                    from sketch_model import Sketch
                    mgr.set_roof_sketch(p.guid, Sketch.from_dict(prev_sketch_dict))
                mgr.mark_mesh_dirty(p.guid)
            def redo_fn(mgr):
                mgr.move_sketch_vertex(p.guid, p.curve_id, p.end_index, (p.to[0], p.to[1]))
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "SketchCurveMoveEdge":
            p: SketchCurveMoveEdgeParams = validated
            res = self.manager.move_sketch_curve(p.guid, p.curve_id, p.dx, p.dy)
            def undo_fn(mgr):
                mgr.move_sketch_curve(p.guid, p.curve_id, -p.dx, -p.dy)
            def redo_fn(mgr):
                mgr.move_sketch_curve(p.guid, p.curve_id, p.dx, p.dy)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "SketchCurveSetSlope":
            p: SketchCurveSlopeParams = validated
            prev_sketch_dict = copy.deepcopy(self.manager.element_meta.get(p.guid, {}).get("sketch"))
            # `pitch` is written from the slope curve and never cleared when the slope is
            # removed, so restoring the sketch alone left the roof at the new pitch.
            prev_derived = capture_sketch_derived(self.manager.element_meta.get(p.guid, {}))
            res = self.manager.set_sketch_slope(
                p.guid, p.curve_id, p.defines_slope, p.slope_angle
            )
            def undo_fn(mgr):
                restore_sketch_derived(mgr, p.guid, prev_derived)
                if prev_sketch_dict:
                    from sketch_model import Sketch
                    mgr.set_roof_sketch(p.guid, Sketch.from_dict(prev_sketch_dict))
                mgr.mark_mesh_dirty(p.guid)
            def redo_fn(mgr):
                mgr.set_sketch_slope(p.guid, p.curve_id, p.defines_slope, p.slope_angle)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

        elif cmd_name == "ConstraintLockToggle":
            p: ConstraintLockToggleParams = validated
            prev_locked = self.manager.constraints.get(p.constraint_id, {}).get("is_locked")
            ok = self.manager.toggle_constraint_lock(p.constraint_id, p.is_locked)
            if not ok:
                raise ValueError(f"Constraint {p.constraint_id} not found")
            def undo_fn(mgr):
                if prev_locked is not None:
                    mgr.toggle_constraint_lock(p.constraint_id, prev_locked)
            def redo_fn(mgr):
                mgr.toggle_constraint_lock(p.constraint_id, p.is_locked)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "updated", "constraint_id": p.constraint_id, "is_locked": p.is_locked}

        elif cmd_name == "ConstraintDelete":
            p: ConstraintDeleteParams = validated
            prev_c = copy.deepcopy(self.manager.constraints.get(p.constraint_id))
            ok = self.manager.delete_constraint(p.constraint_id)
            if not ok:
                raise ValueError(f"Constraint {p.constraint_id} not found")
            def undo_fn(mgr):
                if prev_c is not None:
                    mgr.constraints[p.constraint_id] = copy.deepcopy(prev_c)
                    mgr.save_constraints_to_ifc()
            def redo_fn(mgr):
                mgr.delete_constraint(p.constraint_id)
            return CommandMemento(cmd_name, undo_fn, redo_fn), {"status": "deleted", "constraint_id": p.constraint_id}

        else:
            # Fallback for any other registered command (e.g. constraints, sketch curves, etc.)
            pre_snap = self.manager.snapshot_state()
            res = self.execute_single_command(cmd_name, params)
            def undo_fn(mgr):
                mgr.restore_state(pre_snap)
            def redo_fn(mgr):
                self.execute_single_command(cmd_name, params)
            return CommandMemento(cmd_name, undo_fn, redo_fn), res

    def execute_transaction(
        self,
        commands: List[CommandRequest],
        origin: str = "ui",
        description: str = "Transaction",
    ) -> Dict[str, Any]:
        """
        Executes an atomic transaction containing one or more typed commands.
        Emits one journal step and creates one undo entry with command-scoped mementos.
        """
        with self._lock:
            tx_id = f"tx_{uuid.uuid4().hex[:8]}"
            mementos: List[CommandMemento] = []
            results = []

            try:
                for item in commands:
                    memento, res = self._execute_with_memento(item.command, item.params)
                    mementos.append(memento)
                    results.append({"command": item.command, "result": self.manager._jsonable(res)})
            except Exception as e:
                # Roll back partially executed commands in reverse order using surgical mementos
                for m in reversed(mementos):
                    try:
                        m.undo(self.manager)
                    except Exception as rb_err:
                        print(f"Warning: rollback error on {m.command}: {rb_err}")
                raise RuntimeError(
                    f"Transaction '{tx_id}' aborted and rolled back: {str(e)}"
                ) from e

            self.rev += 1
            if hasattr(self.manager, "commit_revision"):
                self.manager.commit_revision(self.rev)
            tx_record = {
                "rev": self.rev,
                "transaction_id": tx_id,
                "origin": origin,
                "description": description,
                "timestamp": time.time(),
                "commands": [{"command": c.command, "params": c.params} for c in commands],
                "results": results,
            }

            self.journal.append(tx_record)
            self.undo_stack.append(
                {
                    "rev": self.rev,
                    "transaction_id": tx_id,
                    "origin": origin,
                    "description": description,
                    "mementos": mementos,
                }
            )
            # Bound undo stack depth to prevent unbounded memory growth
            if len(self.undo_stack) > self.max_undo_depth:
                self.undo_stack.pop(0)

            self.redo_stack.clear()

            return {
                "status": "committed",
                "rev": self.rev,
                "transaction_id": tx_id,
                "origin": origin,
                "commands_executed": len(results),
                "results": results,
                "description": description,
            }

    def abort_transaction(self, transaction_id: str) -> Dict[str, Any]:
        """
        Rolls back and discards a committed transaction.
        """
        with self._lock:
            if not self.undo_stack:
                raise RuntimeError(f"Cannot abort transaction '{transaction_id}': undo stack is empty")
            tx = self.undo_stack[-1]
            if tx["transaction_id"] != transaction_id:
                raise RuntimeError(
                    f"Cannot abort transaction '{transaction_id}': top of undo stack is '{tx['transaction_id']}'"
                )
            self.undo_stack.pop()
            mementos = tx.get("mementos", [])
            for m in reversed(mementos):
                m.undo(self.manager)
            self.journal = [j for j in self.journal if j.get("transaction_id") != transaction_id]
            self.redo_stack = [r for r in self.redo_stack if r.get("transaction_id") != transaction_id]
            self.rev += 1
            if hasattr(self.manager, "commit_revision"):
                self.manager.commit_revision(self.rev)
            return {
                "status": "aborted",
                "rev": self.rev,
                "transaction_id": transaction_id,
                "origin": tx["origin"],
                "description": tx.get("description", ""),
            }

    def undo(self, transaction_id: Optional[str] = None) -> Dict[str, Any]:
        """Rolls back the latest transaction via surgical command-scoped mementos."""
        with self._lock:
            if not self.undo_stack:
                return {"status": "empty", "message": "Nothing to undo"}

            if transaction_id is not None and self.undo_stack[-1]["transaction_id"] != transaction_id:
                raise RuntimeError(
                    f"Transaction mismatch: expected '{transaction_id}', top of stack is '{self.undo_stack[-1]['transaction_id']}'"
                )

            tx = self.undo_stack.pop()
            mementos = tx.get("mementos", [])
            for m in reversed(mementos):
                m.undo(self.manager)

            self.redo_stack.append(tx)
            if len(self.redo_stack) > self.max_undo_depth:
                self.redo_stack.pop(0)

            self.rev += 1
            if hasattr(self.manager, "commit_revision"):
                self.manager.commit_revision(self.rev)

            return {
                "status": "undone",
                "rev": self.rev,
                "transaction_id": tx["transaction_id"],
                "origin": tx["origin"],
                "description": tx.get("description", ""),
            }

    def redo(self) -> Dict[str, Any]:
        """Re-applies the latest undone transaction via surgical command-scoped mementos."""
        with self._lock:
            if not self.redo_stack:
                return {"status": "empty", "message": "Nothing to redo"}

            tx = self.redo_stack.pop()
            mementos = tx.get("mementos", [])
            for m in mementos:
                m.redo(self.manager)

            self.undo_stack.append(tx)
            self.rev += 1
            if hasattr(self.manager, "commit_revision"):
                self.manager.commit_revision(self.rev)

            return {
                "status": "redone",
                "rev": self.rev,
                "transaction_id": tx["transaction_id"],
                "origin": tx["origin"],
                "description": tx.get("description", ""),
            }

    def get_journal(self, limit: int = 50, since: Optional[int] = None) -> List[Dict[str, Any]]:
        """Returns the replay journal history, optionally filtered since a revision."""
        with self._lock:
            if since is not None:
                entries = [j for j in self.journal if j.get("rev", 0) > since]
                return entries[-limit:] if limit else entries
            return list(self.journal[-limit:])

    def begin_drag(self, origin: str = "ui", description: str = "Drag gesture") -> Dict[str, Any]:
        """
        Begins an interactive drag gesture session.
        Takes ONE snapshot of pre-drag state and returns a unique session_id.
        Does NOT advance revision.
        """
        with self._lock:
            session_id = f"drag_{uuid.uuid4().hex[:8]}"
            snapshot = self.manager.snapshot_state()
            # Plan decision §3.4: during a wall-end drag the miter is stale until commit.
            # Frames therefore skip the join recompute (~24 ms p95 at N=250, 3x the 8 ms
            # frame budget) and it runs once in end_drag. Prior to this, every frame paid
            # it; the participant walls keep their pre-drag footprints during the gesture.
            if hasattr(self.manager, "begin_join_deferral"):
                self.manager.begin_join_deferral()
            self.drag_sessions[session_id] = {
                "session_id": session_id,
                "origin": origin,
                "description": description,
                "snapshot": snapshot,
                "commands": [],
                "mementos": [],
                "dirty_guids": set(),
                "start_rev": self.rev,
                "timestamp": time.time(),
            }
            return {
                "status": "started",
                "session_id": session_id,
                "rev": self.rev,
            }

    def update_drag(self, session_id: str, commands: List[Any]) -> Dict[str, Any]:
        """
        Executes one frame of drag updates against the live model WITHOUT snapshotting.
        Does NOT advance revision.
        Marks dirty guids and returns the changed meshes (slice2d: null).
        """
        with self._lock:
            if session_id not in self.drag_sessions:
                raise RuntimeError(f"Unknown or expired drag session '{session_id}'")
            session = self.drag_sessions[session_id]
            results = []

            for item in commands:
                cmd_name = item.command if hasattr(item, "command") else item.get("command")
                params = item.params if hasattr(item, "params") else item.get("params", {})
                memento, res = self._execute_with_memento(cmd_name, params)
                session["commands"].append({"command": cmd_name, "params": params})
                session["mementos"].append(memento)
                results.append({"command": cmd_name, "result": self.manager._jsonable(res)})

                if "guid" in params:
                    session["dirty_guids"].add(params["guid"])
                if isinstance(res, dict):
                    for k in ("guid", "wall_id", "element_id"):
                        if k in res and res[k]:
                            session["dirty_guids"].add(res[k])

            changed_meshes = []
            for guid in session["dirty_guids"]:
                meta = self.manager.element_meta.get(guid)
                if meta:
                    try:
                        m = self.manager._build_element_mesh(guid, meta)
                        if m:
                            changed_meshes.append(self.manager._jsonable(m))
                    except Exception:
                        pass

            clamp_reasons = [
                r["result"].get("clamp_reason")
                for r in results
                if isinstance(r.get("result"), dict) and r["result"].get("clamp_reason")
            ]

            return {
                "status": "updated",
                "session_id": session_id,
                "rev": self.rev,
                "commands_executed": len(commands),
                "dirty_guids": list(session["dirty_guids"]),
                "changed_meshes": changed_meshes,
                "slice2d": None,
                "results": results,
                "clamp_reason": clamp_reasons[0] if clamp_reasons else None,
            }

    def end_drag(self, session_id: str, commit: bool = True) -> Dict[str, Any]:
        """
        Ends an interactive drag session.
        If commit=True:
            Advances rev ONCE, creates ONE journal entry and ONE undo entry.
        If commit=False:
            Restores the begin snapshot, leaves rev unchanged and geometry byte-identical.
        """
        with self._lock:
            if session_id not in self.drag_sessions:
                raise RuntimeError(f"Unknown or expired drag session '{session_id}'")
            session = self.drag_sessions.pop(session_id)

            if not commit:
                if hasattr(self.manager, "cancel_deferred_join_edits"):
                    self.manager.cancel_deferred_join_edits()
                self.manager.restore_state(session["snapshot"])
                return {
                    "status": "cancelled",
                    "session_id": session_id,
                    "rev": self.rev,
                    "committed": False,
                }

            # Plan decision §3.4: apply the deferred join recompute once, before the rev
            # bump and journal entry, so the committed geometry is mitred and the undo
            # snapshot (captured at begin_drag) still restores the pre-drag joins.
            flushed_joins: List[str] = []
            if hasattr(self.manager, "flush_deferred_join_edits"):
                flushed_joins = self.manager.flush_deferred_join_edits()

            self.rev += 1
            if hasattr(self.manager, "commit_revision"):
                self.manager.commit_revision(self.rev)

            tx_id = f"tx_{uuid.uuid4().hex[:8]}"
            tx_record = {
                "rev": self.rev,
                "transaction_id": tx_id,
                "origin": session["origin"],
                "description": session["description"],
                "timestamp": time.time(),
                "commands": session["commands"],
                "results": [],
            }
            self.journal.append(tx_record)

            snap = session["snapshot"]
            def undo_drag(mgr):
                mgr.restore_state(snap)

            def redo_drag(mgr):
                for c in session["commands"]:
                    self.execute_single_command(c["command"], c["params"])

            undo_memento = CommandMemento("DragGesture", undo_drag, redo_drag, session["description"])

            self.undo_stack.append({
                "rev": self.rev,
                "transaction_id": tx_id,
                "origin": session["origin"],
                "description": session["description"],
                "mementos": [undo_memento],
            })
            if len(self.undo_stack) > self.max_undo_depth:
                self.undo_stack.pop(0)
            self.redo_stack.clear()

            return {
                "status": "committed",
                "session_id": session_id,
                "transaction_id": tx_id,
                "rev": self.rev,
                "committed": True,
                "commands_executed": len(session["commands"]),
                "dirty_guids": list(session["dirty_guids"]),
                "flushed_join_guids": flushed_joins,
            }


# Singleton CommandBus instance
command_bus = CommandBusEngine(bim_manager)
