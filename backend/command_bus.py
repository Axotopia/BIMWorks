"""
BIMWorks - CommandBus & Transaction Engine (Tier 0)
Complies with GLM Master Specification v2 §3 & §5.
Typed command registry with JSON Schema 2020-12 export,
transactional execution with undo/redo journal, and AI origin tagging.
"""

import time
import uuid
from typing import Dict, List, Any, Optional, Literal
from pydantic import BaseModel, Field

from ifc_service import bim_manager


# ============================================================================
# COMMAND PARAMETER SCHEMAS (JSON Schema 2020-12 Compliant)
# ============================================================================

class WallCreateParams(BaseModel):
    start: List[float] = Field(..., description="Start point [x, y, z] in decimal feet or meters")
    end: List[float] = Field(..., description="End point [x, y, z] in decimal feet or meters")
    height: float = Field(default=3.0, description="Unconnected wall height")
    thickness: float = Field(default=0.2, description="Wall thickness")
    level_id: Optional[str] = Field(default=None, description="Host level GUID")
    name: str = Field(default='Basic Wall : Exterior - 8" CMU', description="Wall type name")


class WallMoveParams(BaseModel):
    guid: str = Field(..., description="Target wall GUID")
    dx: float = Field(..., description="Delta X translation")
    dy: float = Field(..., description="Delta Y translation")
    dz: float = Field(default=0.0, description="Delta Z translation")


class DoorInsertParams(BaseModel):
    host_wall_guid: str = Field(..., description="Host wall GUID")
    offset_along_wall: float = Field(..., description="Distance from wall start point along baseline")
    width: float = Field(default=0.95, description="Door opening width")
    height: float = Field(default=2.1, description="Door opening height")
    name: str = Field(default='Single Flush : 36" x 84"', description="Door family/type name")
    swing_flipped: bool = Field(default=False, description="Whether door swing direction is flipped")


class WindowInsertParams(BaseModel):
    host_wall_guid: str = Field(..., description="Host wall GUID")
    offset_along_wall: float = Field(..., description="Distance from wall start point along baseline")
    width: float = Field(default=1.2, description="Window width")
    height: float = Field(default=1.2, description="Window height")
    sill_height: float = Field(default=0.9, description="Window sill height from floor")
    name: str = Field(default='Fixed Window : 48" x 48"', description="Window family/type name")


class SlabCreateParams(BaseModel):
    polygon: List[List[float]] = Field(..., description="Closed 2D polygon vertices [[x,y], ...]")
    thickness: float = Field(default=0.25, description="Slab thickness")
    elevation: float = Field(default=0.0, description="Base elevation")
    level_id: Optional[str] = Field(default=None, description="Host level GUID")
    name: str = Field(default='Floor : 10" Concrete Slab', description="Floor type name")


class RoofCreateParams(BaseModel):
    polygon: List[List[float]] = Field(..., description="Closed 2D polygon vertices [[x,y], ...]")
    thickness: float = Field(default=0.3, description="Roof thickness")
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


class ElementUpdateParams(BaseModel):
    guid: str = Field(..., description="GUID of element to update")
    updates: Dict[str, Any] = Field(..., description="Element property updates (polygon, thickness, elevation, pitch, etc.)")


class ConstraintLockToggleParams(BaseModel):
    constraint_id: str = Field(..., description="Constraint identifier to lock/unlock")
    is_locked: bool = Field(..., description="New padlock state")


class ConstraintDeleteParams(BaseModel):
    constraint_id: str = Field(..., description="Constraint identifier to remove")


# Registry of command names to parameter classes
COMMAND_REGISTRY = {
    "WallCreate": WallCreateParams,
    "WallMove": WallMoveParams,
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
    "ConstraintLockToggle": ConstraintLockToggleParams,
    "ConstraintDelete": ConstraintDeleteParams,
    "ElementUpdate": ElementUpdateParams,
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
# TRANSACTION & REPLAY JOURNAL ENGINE
# ============================================================================

class CommandBusEngine:
    """
    Tier-0 Command Bus & Transaction Engine.
    Executes typed commands transactionally against BimModelManager,
    records an append-only replay journal, and manages undo/redo stacks.
    """

    def __init__(self, manager=bim_manager):
        self.manager = manager
        self.journal: List[Dict[str, Any]] = []
        self.undo_stack: List[Dict[str, Any]] = []
        self.redo_stack: List[Dict[str, Any]] = []

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

        raise ValueError(f"Unhandled command execution: {cmd_name}")

    def execute_transaction(
        self,
        commands: List[CommandRequest],
        origin: str = "ui",
        description: str = "Transaction",
    ) -> Dict[str, Any]:
        """
        Executes an atomic transaction containing one or more typed commands.
        Emits one journal step and creates one undo entry tagged with origin.

        Atomicity (GLM Master Spec v2.3 §3.2): a full-state snapshot is taken
        before execution; any command failure restores that snapshot so the
        model is never left partially mutated. Undo/redo use state snapshots,
        so every command type (create/move/delete/constraint) round-trips.
        """
        tx_id = f"tx_{uuid.uuid4().hex[:8]}"
        pre_state = self.manager.snapshot_state()
        results = []

        try:
            for item in commands:
                res = self.execute_single_command(item.command, item.params)
                results.append({"command": item.command, "result": res})
        except Exception as e:
            # Roll back the model to the exact pre-transaction state.
            self.manager.restore_state(pre_state)
            raise RuntimeError(
                f"Transaction '{tx_id}' aborted and rolled back: {str(e)}"
            ) from e

        tx_record = {
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
                "transaction_id": tx_id,
                "origin": origin,
                "description": description,
                "pre_state": pre_state,
                "post_state": self.manager.snapshot_state(),
            }
        )
        self.redo_stack.clear()

        return {
            "status": "committed",
            "transaction_id": tx_id,
            "origin": origin,
            "commands_executed": len(results),
            "results": results,
            "description": description,
        }

    def undo(self) -> Dict[str, Any]:
        """Rolls back the latest transaction via its pre-state snapshot."""
        if not self.undo_stack:
            return {"status": "empty", "message": "Nothing to undo"}

        tx = self.undo_stack.pop()
        self.manager.restore_state(tx["pre_state"])
        self.redo_stack.append(tx)

        return {
            "status": "undone",
            "transaction_id": tx["transaction_id"],
            "origin": tx["origin"],
            "description": tx.get("description", ""),
        }

    def redo(self) -> Dict[str, Any]:
        """Re-applies the latest undone transaction via its post-state snapshot."""
        if not self.redo_stack:
            return {"status": "empty", "message": "Nothing to redo"}

        tx = self.redo_stack.pop()
        self.manager.restore_state(tx["post_state"])
        self.undo_stack.append(tx)

        return {
            "status": "redone",
            "transaction_id": tx["transaction_id"],
            "origin": tx["origin"],
            "description": tx.get("description", ""),
        }

    def get_journal(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Returns the replay journal history."""
        return self.journal[-limit:]


# Singleton CommandBus instance
command_bus = CommandBusEngine(bim_manager)
