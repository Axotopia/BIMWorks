"""
OpenRevitLT (ORLT) - FastAPI Sidecar Server
Provides high-speed local loopback JSON-RPC & REST endpoints for the React/Three.js frontend.
"""

from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from ifc_service import bim_manager

app = FastAPI(title="OpenRevitLT BIM Sidecar", version="1.0.0")

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


# Endpoints
@app.get("/health")
def health():
    return {"status": "ok", "engine": "IfcOpenShell / IFC4", "version": "1.0.0"}


@app.get("/api/project")
def get_project_state():
    return {
        "project_name": bim_manager.project_name,
        "levels": list(bim_manager.levels.values()),
        "elements_count": len(bim_manager.element_meta),
        "georeference": bim_manager.georeference_data,
    }


@app.post("/api/reset")
def reset_project(project_name: Optional[str] = "OpenRevitLT BIM Project"):
    bim_manager.project_name = project_name
    bim_manager.reset_model()
    return {"status": "reset", "levels": list(bim_manager.levels.values())}


@app.post("/api/sample")
def load_sample_building():
    """Populates a realistic architectural building with walls, doors, windows, slab, roof, grids."""
    bim_manager.reset_model()

    # 4 Perimeter walls
    w1 = bim_manager.add_wall((0, 0, 0), (12, 0, 0), height=3.0, thickness=0.25, name="Basic Wall : Exterior - 10\" CMU")
    w2 = bim_manager.add_wall((12, 0, 0), (12, 9, 0), height=3.0, thickness=0.25, name="Basic Wall : Exterior - 10\" CMU")
    w3 = bim_manager.add_wall((12, 9, 0), (0, 9, 0), height=3.0, thickness=0.25, name="Basic Wall : Exterior - 10\" CMU")
    w4 = bim_manager.add_wall((0, 9, 0), (0, 0, 0), height=3.0, thickness=0.25, name="Basic Wall : Exterior - 10\" CMU")

    # Interior partition wall
    w_int = bim_manager.add_wall((6, 0, 0), (6, 9, 0), height=3.0, thickness=0.15, name="Basic Wall : Interior - 4 7/8\" Partition")

    # Exterior Entrance Door
    bim_manager.add_door(w1["guid"], offset_along_wall=4.5, width=1.0, height=2.13, name="Single Flush : 36\" x 84\"")

    # Interior Door
    bim_manager.add_door(w_int["guid"], offset_along_wall=3.0, width=0.9, height=2.13, name="Single Flush : 36\" x 84\"")

    # Windows on exterior walls
    bim_manager.add_window(w1["guid"], offset_along_wall=1.8, width=1.4, height=1.5, sill_height=0.9, name="Fixed Window : 48\" x 48\"")
    bim_manager.add_window(w1["guid"], offset_along_wall=8.5, width=1.4, height=1.5, sill_height=0.9, name="Fixed Window : 48\" x 48\"")
    bim_manager.add_window(w3["guid"], offset_along_wall=3.5, width=1.6, height=1.5, sill_height=0.9, name="Fixed Window : 48\" x 48\"")
    bim_manager.add_window(w3["guid"], offset_along_wall=8.0, width=1.6, height=1.5, sill_height=0.9, name="Fixed Window : 48\" x 48\"")

    # Ground floor slab
    bim_manager.add_slab([(0, 0), (12, 0), (12, 9), (0, 9)], thickness=0.25, elevation=0.0)

    # Roof slab
    bim_manager.add_roof([(0, 0), (12, 0), (12, 9), (0, 9)], thickness=0.3, elevation=3.0)

    # Grids
    bim_manager.add_grid("1", (-2, 0), (14, 0))
    bim_manager.add_grid("2", (-2, 4.5), (14, 4.5))
    bim_manager.add_grid("3", (-2, 9), (14, 9))
    bim_manager.add_grid("A", (0, -2), (0, 11))
    bim_manager.add_grid("B", (6, -2), (6, 11))
    bim_manager.add_grid("C", (12, -2), (12, 11))

    return {"status": "sample_loaded", "elements_count": len(bim_manager.element_meta)}


@app.post("/api/wall")
def create_wall(req: WallRequest):
    try:
        meta = bim_manager.add_wall(
            start_pt=tuple(req.start),
            end_pt=tuple(req.end),
            height=req.height,
            thickness=req.thickness,
            level_id=req.level_id,
            name=req.name,
        )
        return {
            "status": "created",
            "guid": meta["guid"],
            "ifc_class": meta["ifc_class"],
            "name": meta["name"],
            "length": meta["length"],
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/door")
def create_door(req: DoorRequest):
    try:
        meta = bim_manager.add_door(
            host_wall_guid=req.host_wall_guid,
            offset_along_wall=req.offset_along_wall,
            width=req.width,
            height=req.height,
            name=req.name,
            swing_flipped=req.swing_flipped,
        )
        return {"status": "created", "guid": meta["guid"], "opening_guid": meta["opening_guid"]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/window")
def create_window(req: WindowRequest):
    try:
        meta = bim_manager.add_window(
            host_wall_guid=req.host_wall_guid,
            offset_along_wall=req.offset_along_wall,
            width=req.width,
            height=req.height,
            sill_height=req.sill_height,
            name=req.name,
        )
        return {"status": "created", "guid": meta["guid"], "opening_guid": meta["opening_guid"]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/slab")
def create_slab(req: SlabRequest):
    try:
        pts = [tuple(p) for p in req.polygon]
        meta = bim_manager.add_slab(
            polygon_pts=pts,
            thickness=req.thickness,
            elevation=req.elevation,
            level_id=req.level_id,
            name=req.name,
        )
        return {"status": "created", "guid": meta["guid"]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/roof")
def create_roof(req: RoofRequest):
    try:
        pts = [tuple(p) for p in req.polygon]
        meta = bim_manager.add_roof(
            polygon_pts=pts,
            thickness=req.thickness,
            elevation=req.elevation,
            pitch_degrees=req.pitch_degrees,
            level_id=req.level_id,
            name=req.name,
        )
        return {"status": "created", "guid": meta["guid"]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/grid")
def create_grid(req: GridRequest):
    try:
        meta = bim_manager.add_grid(
            axis_name=req.axis_name,
            start_pt=tuple(req.start),
            end_pt=tuple(req.end),
        )
        return {"status": "created", "guid": meta["guid"]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/level")
def create_level(req: LevelRequest):
    level_id = bim_manager.add_level(name=req.name, elevation=req.elevation)
    return {"status": "created", "id": level_id, "name": req.name, "elevation": req.elevation}


@app.delete("/api/element/{guid}")
def delete_element(guid: str):
    success = bim_manager.delete_element(guid)
    if not success:
        raise HTTPException(status_code=404, detail="Element not found")
    return {"status": "deleted", "guid": guid}


@app.post("/api/element/{guid}/translate")
def translate_element(guid: str, req: TranslateRequest):
    success = bim_manager.translate_element(guid, req.dx, req.dy, req.dz)
    if not success:
        raise HTTPException(status_code=404, detail="Element not found or not translatable")
    return {"status": "translated", "guid": guid}


@app.get("/api/geometry")
def get_geometry():
    """Returns 3D tessellated geometry buffers for Three.js."""
    return bim_manager.get_geometry_buffers()


@app.get("/api/slice/2d")
def get_2d_slice(cut_elevation: float = 1.2):
    """Returns 2D vector linework with .cut, .projection, .overhead classes."""
    return bim_manager.slice_2d_vector_plan(cut_elevation=cut_elevation)


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


@app.get("/api/export/ifc")
def export_ifc():
    """Generates and returns standard IFC4 STEP file."""
    filepath = bim_manager.export_ifc_step()
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
    return Response(
        content=content,
        media_type="application/x-step",
        headers={"Content-Disposition": 'attachment; filename="OpenRevitLT_Model.ifc"'},
    )


@app.get("/api/constraints")
def get_constraints():
    return list(bim_manager.constraints.values())


@app.post("/api/constraints/align")
def create_align_constraint(req: AlignRequest):
    try:
        c = bim_manager.add_align_constraint(req.ref_guid, req.target_guid, req.axis, req.lock)
        return {"status": "aligned", "constraint": c}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/constraints/lock_dimension")
def lock_dimension(req: DimensionLockRequest):
    try:
        c = bim_manager.add_dimension_lock(
            req.guid_a, req.guid_b, req.locked_distance, req.lock, req.axis
        )
        return {"status": "locked", "constraint": c}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/constraints/equalize")
def equalize_span(req: EqualizeRequest):
    try:
        c = bim_manager.equalize_span(
            req.span_start_guid, req.span_end_guid, req.interior_guids, req.axis
        )
        return {"status": "equalized", "constraint": c}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/constraints/{constraint_id}/toggle_lock")
def toggle_constraint_lock(constraint_id: str, req: ToggleLockRequest):
    success = bim_manager.toggle_constraint_lock(constraint_id, req.is_locked)
    if not success:
        raise HTTPException(status_code=404, detail="Constraint not found")
    return {"status": "updated", "is_locked": req.is_locked}


@app.delete("/api/constraints/{constraint_id}")
def delete_constraint(constraint_id: str):
    success = bim_manager.delete_constraint(constraint_id)
    if not success:
        raise HTTPException(status_code=404, detail="Constraint not found")
    return {"status": "deleted", "id": constraint_id}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8008)
