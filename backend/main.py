"""
BIMWorks - FastAPI Sidecar Server
Provides high-speed local loopback JSON-RPC & REST endpoints for the React/Three.js frontend.
"""

import os
import sys
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Response, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from ifc_service import bim_manager, CONTAINER_EXTENSION, CONTAINER_EXTENSIONS
from command_bus import command_bus, CommandRequest, TransactionRequest, COMMAND_REGISTRY
from ai_driver import ai_driver, AiPlan, AiContext

app = FastAPI(title="BIMWorks BIM Sidecar", version="2.1.0")

# ============================================================================
# BUS-ONLY MUTATION ADAPTER (P1)
# ============================================================================
# Every mutating REST route below is a *compatibility shim*: it executes the
# equivalent typed command through the CommandBus as a one-command transaction,
# so the mutation is journaled, undoable and identical to a UI/AI/script edit.
#
# Historically these routes called `bim_manager` directly, which is why Ribbon
# actions were unjournaled and Undo silently no-opped. Do not add a route that
# touches `bim_manager` mutably without going through this helper — the
# parity audit (scratch/test_bus_parity_audit.py) fails if you do.
#
# Deliberately NOT routed here (they replace the document rather than edit it,
# so making them undoable would be a surprise, not a feature): /api/load-path,
# /api/load-file, /api/upload/ifc, /api/reset, /api/sample, and the project
# container load. File-open is a document lifecycle action, not an edit.
# ----------------------------------------------------------------------------

# Command names that mutate model state. Read-only/query commands must not be
# journaled; today every registered command mutates.
MUTATING_COMMANDS = frozenset(COMMAND_REGISTRY.keys())


def run_mutation(
    commands: List[CommandRequest],
    description: str,
    origin: str = "ui",
    include_transaction: bool = False,
) -> Dict[str, Any]:
    """
    Executes mutation command(s) as ONE atomic, journaled transaction.

    Returns the single command's result dict when exactly one command is given
    (so compatibility routes can keep their historical response shape), plus
    `transaction_id` so callers can correlate with the undo stack/journal.

    A rejected transaction is a client-side failure (bad parameter, missing
    element), so it surfaces as a 400 with the original validation message —
    `execute_transaction` wraps the cause in a RuntimeError to report the
    rollback, and unwrapping it keeps API error messages actionable instead of
    turning every validation error into a 500.
    """
    for c in commands:
        if c.command not in COMMAND_REGISTRY:
            raise HTTPException(status_code=400, detail=f"Unknown command '{c.command}'")

    try:
        tx = command_bus.execute_transaction(commands, origin=origin, description=description)
    except Exception as e:
        cause = e.__cause__ or e
        raise HTTPException(status_code=400, detail=f"{type(cause).__name__}: {cause}")

    result = dict(tx["results"][0]["result"]) if len(tx["results"]) == 1 else {"results": tx["results"]}
    result["transaction_id"] = tx["transaction_id"]
    if include_transaction:
        result["transaction"] = tx
    if any(
        c.command.startswith("Constraint") or c.command.startswith("Dimension")
        for c in commands
    ):
        result["conflict"] = getattr(bim_manager, "last_constraint_conflict", None)
    return result


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request schemas
class WallRequest(BaseModel):
    start: List[float]
    end: List[float]
    height: float = 3.0
    thickness: float = 0.2
    level_id: Optional[str] = None
    name: str = "Basic Wall : Exterior - 8\" CMU"


class DoorRequest(BaseModel):
    host_wall_guid: str
    offset_along_wall: float
    width: float = 0.95
    height: float = 2.1
    name: str = "Single Flush : 36\" x 84\""
    swing_flipped: bool = False


class WindowRequest(BaseModel):
    host_wall_guid: str
    offset_along_wall: float
    width: float = 1.2
    height: float = 1.2
    sill_height: float = 0.9
    name: str = "Fixed Window : 48\" x 48\""


class SlabRequest(BaseModel):
    polygon: List[List[float]]
    thickness: float = 0.25
    elevation: float = 0.0
    level_id: Optional[str] = None
    name: str = "Floor : 10\" Concrete Slab"


class RoofRequest(BaseModel):
    polygon: List[List[float]]
    thickness: float = 0.3
    elevation: float = 6.0
    pitch_degrees: float = 15.0
    level_id: Optional[str] = None
    name: str = "Roof : Pitched Metal Deck"


class UpdateElementRequest(BaseModel):
    name: Optional[str] = None
    height: Optional[float] = None
    thickness: Optional[float] = None
    elevation: Optional[float] = None
    pitch: Optional[float] = None
    pitch_degrees: Optional[float] = None
    width: Optional[float] = None
    offset_along_wall: Optional[float] = None
    swing_flipped: Optional[bool] = None
    start: Optional[List[float]] = None
    end: Optional[List[float]] = None
    polygon: Optional[List[List[float]]] = None


class GridRequest(BaseModel):
    axis_name: str
    start: List[float]
    end: List[float]


class LevelRequest(BaseModel):
    name: str
    elevation: float


class TranslateRequest(BaseModel):
    dx: float
    dy: float
    dz: float = 0.0


class GeoreferenceRequest(BaseModel):
    projected_crs: str
    eastings: float
    northings: float
    elevation: float
    true_north: float
    scale: float


class SheetPdfRequest(BaseModel):
    svg_content: str
    sheet_name: Optional[str] = "Sheet_Export"


class AlignRequest(BaseModel):
    ref_guid: str
    target_guid: str
    axis: str = "x"
    lock: bool = True


class DimensionLockRequest(BaseModel):
    guid_a: str
    guid_b: str
    locked_distance: Optional[float] = None
    lock: bool = True
    axis: str = "x"


class EqualizeRequest(BaseModel):
    span_start_guid: str
    span_end_guid: str
    interior_guids: List[str]
    axis: str = "x"


class ToggleLockRequest(BaseModel):
    is_locked: bool


class LoadFileRequest(BaseModel):
    content: str
    filename: Optional[str] = "Imported.ifc"


class LoadPathRequest(BaseModel):
    path: str


class WallJoinRequest(BaseModel):
    wall_guid: str
    end_index: int
    allow_join: bool = True
    mode: str = "butt"


class SheetCreateRequest(BaseModel):
    sheet_number: str
    sheet_title: Optional[str] = "Unnamed Sheet"
    paper_size: Optional[str] = "ARCH_D"
    is_placeholder: bool = False
    sheet_id: Optional[str] = None
    drawn_by: Optional[str] = "BIMWorks Architect"
    date: Optional[str] = None


class ViewportAddRequest(BaseModel):
    view_id: str
    x: float
    y: float
    width: Optional[float] = 480.0
    height: Optional[float] = 360.0
    scale_factor: Optional[float] = 1.0
    viewport_id: Optional[str] = None


class ViewportMoveRequest(BaseModel):
    x: float
    y: float
    sheet_id: Optional[str] = None


class BatchSheetPdfRequest(BaseModel):
    sheets: List[SheetPdfRequest]
    filename: Optional[str] = "Batch_Sheets_Export"


class AiPlanRequest(BaseModel):
    prompt: str
    active_view_id: Optional[str] = "view-level-1"
    active_level_id: Optional[str] = None
    selected_guids: List[str] = []


class AiExecuteRequest(BaseModel):
    plan: Optional[Dict[str, Any]] = None
    prompt: Optional[str] = None
    active_view_id: Optional[str] = "view-level-1"
    selected_guids: List[str] = []


class AiQueryRequest(BaseModel):
    category: Optional[str] = None
    level_id: Optional[str] = None
    host_wall_guid: Optional[str] = None
    min_x: Optional[float] = None
    max_x: Optional[float] = None
    min_y: Optional[float] = None
    max_y: Optional[float] = None


# Endpoints
@app.get("/health")
@app.get("/api/health")
def health():
    from constraint_solver import ConstraintSolver
    return {
        "status": "ok",
        "engine": "IfcOpenShell / IFC4",
        "version": "1.0.0",
        "solver_available": ConstraintSolver._solver_available(),
    }


@app.get("/api/project")
def get_project_state():
    return {
        "project_name": bim_manager.project_name,
        "levels": list(bim_manager.levels.values()),
        "elements_count": len(bim_manager.element_meta),
        "georeference": bim_manager.georeference_data,
    }


@app.post("/api/load-path")
def load_path(req: LoadPathRequest):
    """Loads an IFC STEP file directly from a local filesystem path into the active workspace."""
    if not os.path.exists(req.path):
        raise HTTPException(status_code=404, detail=f"File not found: {req.path}")
    try:
        res = bim_manager.load_ifc_file(req.path, os.path.basename(req.path))
        command_bus.rev += 1
        return res
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to load IFC file from path: {str(e)}")


@app.post("/api/load-file")
def load_file(req: LoadFileRequest):
    """Loads an arbitrary IFC STEP file from text content into the active workspace."""
    try:
        res = bim_manager.load_ifc_content(req.content, req.filename or "Imported.ifc")
        command_bus.rev += 1
        return res
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to load IFC file: {str(e)}")


@app.post("/api/upload/ifc")
async def upload_ifc(file: UploadFile = File(...)):
    """Accepts multipart IFC upload and loads it directly into the BIM model."""
    try:
        raw_bytes = await file.read()
        text_content = raw_bytes.decode("utf-8", errors="replace")
        res = bim_manager.load_ifc_content(text_content, file.filename or "Uploaded.ifc")
        command_bus.rev += 1
        return res
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to upload IFC file: {str(e)}")


@app.post("/api/reset")
def reset_project(project_name: Optional[str] = "BIMWorks Project"):
    bim_manager.project_name = project_name
    bim_manager.reset_model()
    command_bus.rev += 1
    return {
        "status": "reset",
        "levels": list(bim_manager.levels.values()),
        "doc_id": bim_manager.doc_id,
        "rev": command_bus.rev,
    }


@app.post("/api/sample")
def load_sample_building():
    """Populates the shipped sample building (sample_building.ifc) with 13 parametrized elements and 3 storeys."""
    bim_manager.reset_model()
    command_bus.rev += 1

    sample_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "sample_building.ifc"))
    if os.path.exists(sample_path):
        bim_manager.load_ifc_file(sample_path, "sample_building.ifc")
    else:
        # Fallback to current working directory if relative path differs
        fallback = os.path.abspath("sample_building.ifc")
        if os.path.exists(fallback):
            bim_manager.load_ifc_file(fallback, "sample_building.ifc")

    return {
        "status": "sample_loaded",
        "elements_count": len(bim_manager.element_meta),
        "levels_count": len(bim_manager.levels),
        "project_name": bim_manager.project_name,
    }


# Auto-populate default sample building model on sidecar startup
load_sample_building()



@app.post("/api/wall")
def create_wall(req: WallRequest):
    """Compatibility shim for WallCreate (bus-backed, journaled)."""
    return run_mutation(
        [CommandRequest(command="WallCreate", params=req.model_dump())],
        description=f'Create wall "{req.name}"',
    )


@app.post("/api/door")
def create_door(req: DoorRequest):
    """Compatibility shim for DoorInsert (bus-backed, journaled)."""
    res = run_mutation(
        [CommandRequest(command="DoorInsert", params=req.model_dump())],
        description=f'Insert door "{req.name}"',
    )
    return {"status": "created", "guid": res.get("guid"), "opening_guid": res.get("opening_guid"),
            "transaction_id": res.get("transaction_id")}


@app.post("/api/window")
def create_window(req: WindowRequest):
    """Compatibility shim for WindowInsert (bus-backed, journaled)."""
    res = run_mutation(
        [CommandRequest(command="WindowInsert", params=req.model_dump())],
        description=f'Insert window "{req.name}"',
    )
    return {"status": "created", "guid": res.get("guid"), "opening_guid": res.get("opening_guid"),
            "transaction_id": res.get("transaction_id")}


@app.post("/api/slab")
def create_slab(req: SlabRequest):
    """Compatibility shim for SlabCreate (bus-backed, journaled)."""
    res = run_mutation(
        [CommandRequest(command="SlabCreate", params=req.model_dump())],
        description=f'Create slab "{req.name}"',
    )
    return {"status": "created", "guid": res.get("guid"), "transaction_id": res.get("transaction_id")}


@app.post("/api/roof")
def create_roof(req: RoofRequest):
    """Compatibility shim for RoofCreate (bus-backed, journaled)."""
    res = run_mutation(
        [CommandRequest(command="RoofCreate", params=req.model_dump())],
        description=f'Create roof "{req.name}"',
    )
    return {"status": "created", "guid": res.get("guid"), "transaction_id": res.get("transaction_id")}


@app.post("/api/grid")
def create_grid(req: GridRequest):
    """Compatibility shim for GridCreate (bus-backed, journaled)."""
    res = run_mutation(
        [CommandRequest(command="GridCreate", params=req.model_dump())],
        description=f'Create grid axis "{req.axis_name}"',
    )
    return {"status": "created", "guid": res.get("guid"), "transaction_id": res.get("transaction_id")}


@app.post("/api/level")
def create_level(req: LevelRequest):
    """Compatibility shim for LevelCreate (bus-backed, journaled)."""
    res = run_mutation(
        [CommandRequest(command="LevelCreate", params=req.model_dump())],
        description=f'Create level "{req.name}"',
    )
    return {"status": "created", "id": res.get("level_id"), "name": req.name,
            "elevation": req.elevation, "transaction_id": res.get("transaction_id")}


@app.delete("/api/element/{guid}")
def delete_element(guid: str):
    """Compatibility shim for DeleteElement (bus-backed, journaled)."""
    if guid not in bim_manager.element_meta:
        raise HTTPException(status_code=404, detail="Element not found")
    return run_mutation(
        [CommandRequest(command="DeleteElement", params={"guid": guid})],
        description="Delete element",
    )


@app.post("/api/element/{guid}/translate")
def translate_element(guid: str, req: TranslateRequest):
    """Compatibility shim for WallMove (bus-backed, journaled)."""
    if guid not in bim_manager.element_meta:
        raise HTTPException(status_code=404, detail="Element not found")
    return run_mutation(
        [CommandRequest(command="WallMove", params={"guid": guid, "dx": req.dx, "dy": req.dy, "dz": req.dz})],
        description="Move element",
    )


@app.get("/api/element/{guid}")
def get_element(guid: str):
    if guid not in bim_manager.element_meta:
        raise HTTPException(status_code=404, detail="Element not found")
    meta = bim_manager.element_meta[guid]
    return {
        "guid": guid,
        "ifc_class": meta.get("ifc_class"),
        "name": meta.get("name"),
        "elevation": meta.get("elevation", 0.0),
        "thickness": meta.get("thickness", 0.2),
        "height": meta.get("height", 3.0),
        "pitch": meta.get("pitch", 15.0),
        "length": meta.get("length", 0.0),
        "angle": meta.get("angle", 0.0),
        "start": meta.get("start"),
        "end": meta.get("end"),
        "polygon": meta.get("polygon"),
        "offset_along_wall": meta.get("offset_along_wall", 0.0),
        "width": meta.get("width", 0.9),
        "swing_flipped": meta.get("swing_flipped", False),
        "type_properties": meta.get("type_properties", {}),
        "bbox": meta.get("bbox", {}),
    }


@app.post("/api/element/{guid}/update")
def update_element_endpoint(guid: str, req: UpdateElementRequest):
    """Compatibility shim for ElementUpdate (bus-backed, journaled)."""
    if guid not in bim_manager.element_meta:
        raise HTTPException(status_code=404, detail="Element not found")
    return run_mutation(
        [CommandRequest(command="ElementUpdate",
                        params={"guid": guid, "updates": req.model_dump(exclude_unset=True)})],
        description="Edit element geometry",
    )


@app.get("/api/geometry")
def get_geometry():
    """Returns 3D tessellated geometry buffers for Three.js."""
    return bim_manager.get_geometry_buffers()


@app.get("/api/types")
def get_types():
    """Returns the type catalog."""
    return bim_manager.get_types()


@app.get("/api/view/2d")
def get_2d_view(
    view_type: str = "floor_plan",
    cut_elevation: float = 4.0,
    direction: str = "south",
    view_depth: Optional[float] = None,
    top: Optional[float] = None,
    bottom: Optional[float] = None,
):
    """
    Returns 2D linework for a plan, section or elevation.

    Separate from `/api/slice/2d` because that endpoint is the plan path the viewport
    has always called; this one exposes the view engine, so a section or elevation can
    be requested at all. The view-range fields are optional and in decimal feet.
    """
    view_range = {
        k: v for k, v in (("top", top), ("bottom", bottom), ("view_depth", view_depth))
        if v is not None
    }
    view_range["cut"] = cut_elevation
    try:
        return bim_manager.render_2d_view(
            view_type=view_type,
            cut_elevation=cut_elevation,
            direction=direction,
            view_range=view_range,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/slice/2d")
def get_2d_slice(cut_elevation: float = 4.0, level_id: Optional[str] = None):
    """
    Returns 2D vector linework for a plan view.

    Since P5 the linework comes from the in-process hidden-line projector, so the
    response carries `cut_paths`, `projection_paths` and `hidden_paths` (separated),
    plus annotation drives (`grids`, `swing_paths`, `window_paths`, `dimensions`),
    the `lineweights` table used to draw them, and the `renderer` that produced it.
    """
    return bim_manager.slice_2d_vector_plan(
        cut_elevation=cut_elevation, level_id=level_id
    )


@app.post("/api/georeference")
def update_georeference(req: GeoreferenceRequest):
    bim_manager.georeference_data = {
        "projected_crs": req.projected_crs,
        "eastings": req.eastings,
        "northings": req.northings,
        "elevation": req.elevation,
        "true_north": req.true_north,
        "scale": req.scale,
    }
    bim_manager.apply_georeferencing()
    return {"status": "updated", "georeference": bim_manager.georeference_data}


@app.post("/api/export/sheet-pdf")
def export_sheet_pdf(req: SheetPdfRequest):
    """Compiles SVG into pure vector PDF."""
    try:
        pdf_bytes = bim_manager.compile_sheet_to_vector_pdf(req.svg_content)
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{req.sheet_name}.pdf"'},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/export/batch-pdf")
def export_batch_pdf(req: BatchSheetPdfRequest):
    """Compiles multiple Sheet SVGs into a single multi-page vector PDF."""
    try:
        svg_list = [s.svg_content for s in req.sheets]
        pdf_bytes = bim_manager.compile_batch_to_vector_pdf(svg_list)
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{req.filename}.pdf"'},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/sheets")
def get_sheets():
    """Returns all sheets with placed viewports."""
    return bim_manager.get_sheets()


@app.get("/api/views")
def get_views():
    """Returns all views in the model."""
    return bim_manager.get_views()


@app.post("/api/sheet")
def create_sheet(req: SheetCreateRequest):
    """Creates a new sheet via CommandBus."""
    return run_mutation(
        [CommandRequest(command="SheetCreate", params=req.model_dump())],
        description=f"Create Sheet {req.sheet_number}",
    )


@app.delete("/api/sheet/{sheet_id}")
def delete_sheet(sheet_id: str):
    """Deletes a sheet via CommandBus."""
    return run_mutation(
        [CommandRequest(command="SheetDelete", params={"sheet_id": sheet_id})],
        description=f"Delete Sheet {sheet_id}",
    )


@app.post("/api/sheet/{sheet_id}/viewport")
def add_viewport_to_sheet(sheet_id: str, req: ViewportAddRequest):
    """Places a viewport on a sheet via CommandBus."""
    params = req.model_dump()
    params["sheet_id"] = sheet_id
    return run_mutation(
        [CommandRequest(command="ViewportAdd", params=params)],
        description=f"Add Viewport to Sheet {sheet_id}",
    )


@app.delete("/api/sheet/viewport/{viewport_id}")
def remove_viewport_from_sheet(viewport_id: str, sheet_id: Optional[str] = None):
    """Removes a viewport from a sheet via CommandBus."""
    return run_mutation(
        [CommandRequest(command="ViewportRemove", params={"viewport_id": viewport_id, "sheet_id": sheet_id})],
        description=f"Remove Viewport {viewport_id}",
    )


@app.post("/api/sheet/viewport/{viewport_id}/move")
def move_viewport(viewport_id: str, req: ViewportMoveRequest):
    """Moves a viewport on a sheet via CommandBus."""
    params = req.model_dump()
    params["viewport_id"] = viewport_id
    if req.sheet_id:
        params["sheet_id"] = req.sheet_id
    return run_mutation(
        [CommandRequest(command="ViewportMove", params=params)],
        description=f"Move Viewport {viewport_id}",
    )


@app.get("/api/export/ifc")
def export_ifc():
    """Generates and returns standard IFC4 STEP file."""
    filepath = bim_manager.export_ifc_step()
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
    return Response(
        content=content,
        media_type="application/x-step",
        headers={"Content-Disposition": 'attachment; filename="BIMWorks_Model.ifc"'},
    )


@app.get("/api/constraints")
def get_constraints():
    return list(bim_manager.constraints.values())


@app.get("/api/constraints/conflict")
def get_constraint_conflict():
    """Returns the last constraint conflict report (Phase 3.6)."""
    return getattr(bim_manager, "last_constraint_conflict", None)



@app.post("/api/constraints/align")
def create_align_constraint(req: AlignRequest):
    """Compatibility shim for ConstraintAlign (bus-backed, journaled)."""
    return run_mutation(
        [CommandRequest(command="ConstraintAlign", params=req.model_dump())],
        description="Align & lock elements",
    )


@app.post("/api/constraints/lock_dimension")
def lock_dimension(req: DimensionLockRequest):
    """Compatibility shim for ConstraintLockDim (bus-backed, journaled)."""
    return run_mutation(
        [CommandRequest(command="ConstraintLockDim", params=req.model_dump())],
        description="Lock dimension",
    )


@app.post("/api/constraints/equalize")
def equalize_span(req: EqualizeRequest):
    """Compatibility shim for ConstraintEqualize (bus-backed, journaled)."""
    return run_mutation(
        [CommandRequest(command="ConstraintEqualize", params=req.model_dump())],
        description="Equalize spacing (EQ)",
    )


@app.post("/api/constraints/{constraint_id}/toggle_lock")
def toggle_constraint_lock(constraint_id: str, req: ToggleLockRequest):
    """Compatibility shim for ConstraintLockToggle (bus-backed, journaled)."""
    if constraint_id not in bim_manager.constraints:
        raise HTTPException(status_code=404, detail="Constraint not found")
    return run_mutation(
        [CommandRequest(command="ConstraintLockToggle",
                        params={"constraint_id": constraint_id, "is_locked": req.is_locked})],
        description=f"{'Lock' if req.is_locked else 'Unlock'} constraint",
    )


@app.delete("/api/constraints/{constraint_id}")
def delete_constraint(constraint_id: str):
    """Compatibility shim for ConstraintDelete (bus-backed, journaled)."""
    if constraint_id not in bim_manager.constraints:
        raise HTTPException(status_code=404, detail="Constraint not found")
    res = run_mutation(
        [CommandRequest(command="ConstraintDelete", params={"constraint_id": constraint_id})],
        description="Delete constraint",
    )
    return {"status": "deleted", "id": res.get("constraint_id"), "transaction_id": res.get("transaction_id")}


# ============================================================================
# PROJECT CONTAINER: HYBRID .BIMWORKS (zip), WALL JOINS, COMMAND BUS
# ============================================================================

@app.get("/api/project/export-bimworks")
def export_bimworks_project():
    """Exports the full .bimworks hybrid zip container per Master Spec §3.1."""
    try:
        filepath = bim_manager.save_orlt_project()
        with open(filepath, "rb") as f:
            data = f.read()
        safe_name = "".join(
            c for c in bim_manager.project_name if c.isalnum() or c in ("-", "_")
        ).strip() or "Project"
        return Response(
            content=data,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}{CONTAINER_EXTENSION}"'},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/project/load-bimworks")
async def load_bimworks_project(file: UploadFile = File(...)):
    """Loads a .bimworks hybrid container (legacy .orlt also accepted)."""
    try:
        raw_bytes = await file.read()
        res = bim_manager.load_orlt_project(raw_bytes, file.filename or f"Project{CONTAINER_EXTENSION}")
        command_bus.rev += 1
        return res
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to load project container: {str(e)}")


@app.get("/api/project/export-orlt", deprecated=True)
def export_orlt_project():
    """Deprecated alias of /api/project/export-bimworks (pre-rename path)."""
    return export_bimworks_project()


@app.post("/api/project/load-orlt", deprecated=True)
async def load_orlt_project(file: UploadFile = File(...)):
    """Deprecated alias of /api/project/load-bimworks; accepts .orlt and .bimworks."""
    return await load_bimworks_project(file)


@app.get("/api/wall/joins")
def get_wall_joins():
    """Returns active wall join policies."""
    return bim_manager.get_wall_joins()


@app.post("/api/wall/join")
def set_wall_join(req: WallJoinRequest):
    """Compatibility shim for SetWallJoin (bus-backed, journaled).

    Revit: IsWallJoinAllowedAtEnd.
    """
    if req.wall_guid not in bim_manager.element_meta:
        raise HTTPException(status_code=404, detail="Wall not found")
    return run_mutation(
        [CommandRequest(command="SetWallJoin", params=req.model_dump())],
        description="Change wall join",
    )


# Tier 0 & Tier 1 CommandBus Endpoints
@app.get("/api/commands/schema")
def get_commands_schema():
    """Returns JSON Schema 2020-12 specifications for AI drivers and programmatic clients."""
    return command_bus.get_schemas()


@app.post("/api/command")
def execute_command(req: CommandRequest):
    """
    Executes a single typed command against the CommandBus.

    P1: mutating commands are wrapped in a one-command transaction so this route
    cannot be used to mutate the model without a journal/undo entry.
    """
    try:
        if req.command in MUTATING_COMMANDS:
            result = run_mutation([req], description=f"Command {req.command}", origin=req.origin)
            return {"status": "executed", "command": req.command, "result": result}
        res = command_bus.execute_single_command(req.command, req.params)
        return {"status": "executed", "command": req.command, "result": res}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/transaction")
def execute_transaction(req: TransactionRequest):
    """Executes a batched atomic transaction (used by UI & AI drivers)."""
    try:
        res = command_bus.execute_transaction(req.commands, origin=req.origin, description=req.description)
        if any(
            c.command.startswith("Constraint") or c.command.startswith("Dimension")
            for c in req.commands
        ):
            res["conflict"] = getattr(bim_manager, "last_constraint_conflict", None)
        return res
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/transaction/undo")
def undo_transaction():
    """Rolls back the latest transaction."""
    return command_bus.undo()


@app.post("/api/transaction/redo")
def redo_transaction():
    """Re-applies the latest undone transaction."""
    return command_bus.redo()


@app.get("/api/transaction/journal")
def get_transaction_journal(limit: int = 50):
    """Returns the append-only transaction journal."""
    return command_bus.get_journal(limit=limit)


# ============================================================================
# TIER 1 & TIER 2 AI DRIVER ENDPOINTS
# ============================================================================

@app.get("/api/ai/tools")
def get_ai_tools():
    """Returns tools catalog and JSON Schema 2020-12 specifications for external AI agents and MCP."""
    return ai_driver.get_tool_catalog()


@app.get("/api/ai/describe")
def describe_ai_scene():
    """Returns semantic scene description (envelope bounds, cardinal walls, element counts)."""
    return ai_driver.query_engine.describe_scene()


@app.post("/api/ai/query")
def query_ai_elements(req: AiQueryRequest):
    """Executes semantic filter queries against active architectural model."""
    return ai_driver.query_engine.query_elements(
        category=req.category,
        level_id=req.level_id,
        host_wall_guid=req.host_wall_guid,
        min_x=req.min_x,
        max_x=req.max_x,
        min_y=req.min_y,
        max_y=req.max_y,
    )


@app.post("/api/ai/plan")
def plan_ai_prompt(req: AiPlanRequest):
    """Synthesizes and validates a typed plan against CommandBus schemas."""
    try:
        ctx = AiContext(
            active_view_id=req.active_view_id,
            active_level_id=req.active_level_id,
            selected_guids=req.selected_guids,
        )
        plan = ai_driver.plan(req.prompt, ctx)
        return plan.model_dump()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/ai/execute")
def execute_ai_plan(req: AiExecuteRequest):
    """Executes a plan (or plans and executes a prompt) with atomic rollback on assertion failure."""
    try:
        if req.plan:
            plan = AiPlan(**req.plan)
        elif req.prompt:
            ctx = AiContext(
                active_view_id=req.active_view_id,
                selected_guids=req.selected_guids,
            )
            plan = ai_driver.plan(req.prompt, ctx)
        else:
            raise ValueError("Either 'plan' or 'prompt' must be provided")

        return ai_driver.execute_plan(plan)
    except AssertionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------------------------------------------------------------------------
# Post-commit state bundle - SPECIFICATION-v0.2.md 6.3
# ---------------------------------------------------------------------------
@app.get("/api/state")
def get_state_bundle(
    since: Optional[str] = None,
    doc_id: Optional[str] = None,
    cut_elevation: float = 4.0,
    level_id: Optional[str] = None,
    view_type: str = "floor_plan",
    direction: str = "south",
    view_depth: Optional[float] = None,
    top: Optional[float] = None,
    bottom: Optional[float] = None,
    journal_limit: int = 25,
):
    """
    Post-commit state delta and bundle protocol (SPECIFICATION-v0.2.md §6.3).

    Supports since=<rev> for Response A (unchanged), Response B (delta with
    upsert_meshes, remove_guids, and view-filtered slice2d), and Response C
    (full-state resync).
    """
    import time as _time

    t_total = _time.perf_counter()
    timings: Dict[str, float] = {}
    errors: Dict[str, str] = {}
    current_rev = command_bus.rev
    current_doc_id = getattr(bim_manager, "doc_id", "")

    parsed_since: Optional[int] = None
    if since is not None and since != "":
        try:
            parsed_since = int(since)
        except (ValueError, TypeError):
            parsed_since = None

    # Epoch mismatch or missing doc_id forces Response C (full resync)
    if doc_id is None or doc_id != current_doc_id:
        parsed_since = None

    # Response A — nothing changed. This must be cheap; it is the common case.
    if parsed_since is not None and parsed_since == current_rev:
        return {
            "rev": current_rev,
            "doc_id": current_doc_id,
            "unchanged": True,
            "timings": timings,
            "engine_ms": round((_time.perf_counter() - t_total) * 1000.0, 2),
        }

    def timed(key, fn):
        t0 = _time.perf_counter()
        value = fn()
        timings[key] = round((_time.perf_counter() - t0) * 1000.0, 2)
        return value

    def timed_soft(key, fn):
        """A failing section must not discard the sections that succeeded."""
        t0 = _time.perf_counter()
        try:
            value = fn()
        except Exception as exc:
            errors[key] = f"{type(exc).__name__}: {exc}"
            value = None
        timings[key] = round((_time.perf_counter() - t0) * 1000.0, 2)
        return value

    def _slice():
        if view_type in ("section", "elevation"):
            view_range = {
                k: v
                for k, v in (("top", top), ("bottom", bottom), ("view_depth", view_depth))
                if v is not None
            }
            view_range["cut"] = cut_elevation
            return bim_manager.render_2d_view(
                view_type=view_type,
                cut_elevation=cut_elevation,
                direction=direction,
                view_range=view_range,
            )
        return bim_manager.slice_2d_vector_plan(
            cut_elevation=cut_elevation, level_id=level_id
        )

    # Response B — a delta
    if parsed_since is not None and 0 <= parsed_since < current_rev:
        geom_delta = timed_soft("geometry", lambda: bim_manager.get_geometry_buffers(since=parsed_since))
        upsert_meshes = geom_delta.get("upsert_meshes", []) if geom_delta else []
        remove_guids = geom_delta.get("remove_guids", []) if geom_delta else []
        removed_items = geom_delta.get("removed_items", []) if geom_delta else []

        # D5: dirty-view slice filter (R5, N3)
        needs_slice = True
        if view_type == "floor_plan" and level_id:
            req_storey = bim_manager.get_storey_by_id(level_id)
            req_gid = req_storey.GlobalId if req_storey else level_id
            affected_gids = set()
            for m in upsert_meshes:
                lid = (m.get("params") or {}).get("level_id")
                if lid:
                    st = bim_manager.get_storey_by_id(lid)
                    affected_gids.add(st.GlobalId if st else lid)

            unknown_removed_level = False
            for item in removed_items:
                lid = item.get("level_id")
                if lid:
                    st = bim_manager.get_storey_by_id(lid)
                    affected_gids.add(st.GlobalId if st else lid)
                else:
                    unknown_removed_level = True

            # If any removed item has unknown level, slice is needed.
            # Only skip if we know all affected levels and req_gid is not among them:
            if not unknown_removed_level and affected_gids and req_gid not in affected_gids:
                needs_slice = False

        slice2d = timed_soft("slice2d", _slice) if needs_slice else None
        journal_append = timed_soft("journal", lambda: command_bus.get_journal(limit=journal_limit, since=parsed_since))

        # Include non-mesh sections if modified since parsed_since (N4)
        levels_section = list(bim_manager.levels.values()) if getattr(bim_manager, "levels_rev", 0) > parsed_since else None
        grids_data = [
            {
                "guid": m["guid"],
                "name": m["name"],
                "tag": m["tag"],
                "start": m["start"],
                "end": m["end"],
            }
            for m in bim_manager.element_meta.values()
            if m.get("ifc_class") == "IfcGrid"
        ] if getattr(bim_manager, "grids_rev", 0) > parsed_since else None
        sheets_section = bim_manager.get_sheets() if getattr(bim_manager, "sheets_rev", 0) > parsed_since else None
        views_section = bim_manager.get_views() if getattr(bim_manager, "views_rev", 0) > parsed_since else None
        types_section = bim_manager.get_types() if getattr(bim_manager, "types_rev", 0) > parsed_since else None
        constraints_section = list(bim_manager.constraints.values()) if getattr(bim_manager, "constraints_rev", 0) > parsed_since else None
        wall_joins_section = bim_manager.get_wall_joins() if getattr(bim_manager, "wall_joins_rev", 0) > parsed_since else None
        project_section = {
            "project_name": bim_manager.project_name,
            "levels": list(bim_manager.levels.values()),
            "elements_count": len(bim_manager.element_meta),
            "georeference": bim_manager.georeference_data,
        } if getattr(bim_manager, "project_rev", 0) > parsed_since else None

        total_ms = round((_time.perf_counter() - t_total) * 1000.0, 2)
        return {
            "rev": current_rev,
            "base_rev": parsed_since,
            "doc_id": current_doc_id,
            "unchanged": False,
            "upsert_meshes": upsert_meshes,
            "remove_guids": remove_guids,
            "levels": levels_section,
            "grids": grids_data,
            "sheets": sheets_section,
            "views": views_section,
            "types": types_section,
            "project": project_section,
            "constraints": constraints_section,
            "wall_joins": wall_joins_section,
            "slice2d": slice2d,
            "journal_append": journal_append,
            "errors": errors,
            "timings": timings,
            "engine_ms": total_ms,
        }

    # Response C — resynchronise (full bundle when since is omitted, forged, or gapped)
    project = timed("project", lambda: {
        "project_name": bim_manager.project_name,
        "levels": list(bim_manager.levels.values()),
        "elements_count": len(bim_manager.element_meta),
        "georeference": bim_manager.georeference_data,
    })
    constraints = timed_soft("constraints", lambda: list(bim_manager.constraints.values()))
    wall_joins = timed_soft("wall_joins", lambda: bim_manager.get_wall_joins())
    geometry = timed_soft("geometry", lambda: bim_manager.get_geometry_buffers())
    slice2d = timed_soft("slice2d", _slice)
    journal = timed_soft("journal", lambda: command_bus.get_journal(limit=journal_limit))
    sheets = timed_soft("sheets", lambda: bim_manager.get_sheets())
    views = timed_soft("views", lambda: bim_manager.get_views())
    types = timed_soft("types", lambda: bim_manager.get_types())

    total_ms = round((_time.perf_counter() - t_total) * 1000.0, 2)
    return {
        "rev": current_rev,
        "doc_id": current_doc_id,
        "full": True,
        "unchanged": False,
        "project": project,
        "constraints": constraints,
        "wall_joins": wall_joins,
        "geometry": geometry,
        "slice2d": slice2d,
        "journal": journal,
        "sheets": sheets,
        "views": views,
        "types": types,
        "timings": timings,
        "errors": errors,
        "engine_ms": total_ms,
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8008)
