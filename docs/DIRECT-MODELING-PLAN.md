# BIMWorks — Direct 3D Modeling ("Model" Ribbon) Implementation Plan

**Objective:** Equip BIMWorks with intuitive, high-performance 3D object creation and editing (SketchUp format) inspired by [IngeTrazo](https://github.com/ingelibre/ingetrazo), while preserving the **Revit theme, ribbon ergonomics, and workflow** for users trained in Revit.

---

## 1. Architectural Strategy: Revit Shell + SketchUp Core

To maintain continuity for Revit users without compromising 3D ergonomics:
1. **Revit Visual Theme & Layout Preserved**:
   - Ribbon styling remains untouched: `#f3f4f6` background, `#094771` Revit-blue active tabs, panel dividers, 58px button layout, and two-letter hotkeys.
   - Existing tabs (`Architecture`, `Insert`, `Annotate`, `Massing&Site`, `View`, `Manage`, `Modify`) remain intact with their familiar tools (`WA`, `DR`, `WN`, `SB`, `RF`, `AL`, `TR`, `SL`).
2. **Dedicated "Model" Ribbon Tab**:
   - Introduces a first-class **"Model"** tab focused on direct 3D sketching, push/pull manipulation, and geometry classification.
3. **"Modify" Ribbon Enhancements**:
   - Adds a **"Direct Edit"** panel containing Push/Pull (`PP`) and Offset (`OF`) to the existing Modify tab so users can edit faces without leaving their standard modification workflows.
4. **BlenderBIM / IngeTrazo Semantic Tagging**:
   - Rather than forcing rigid parametric types upfront, geometry is modeled with freeform push/pull speed, then tagged with IFC semantics (`IfcWall`, `IfcSlab`, `IfcColumn`, `IfcRoof`). Watertight volumes and net surface areas are computed honestly for IFC takeoff.

---

## 2. Ribbon UI Specification

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Architecture  Insert  Annotate  Massing&Site  [ MODEL ]  View  Manage  [ MODIFY ]                                │
├─────────────────────┬─────────────────────┬─────────────────────┬──────────────────────────┬─────────────────────┤
│  [Line (LI)]        │  [Push/Pull (PP)]   │  [Move (MV)]        │  [Tag Wall (TW)]         │  [Create Group (GP)]│
│  [Rectangle (REC)]  │  [Offset (OF)]      │  [Rotate (RO)]      │  [Tag Floor (TF)]        │  [Explode Group]    │
│  [Circle (CI)]      │  [Follow Me (FM)]   │  [Scale (SC)]       │  [Tag Column (TC)]       │  [Edit Context]     │
│  [Arc 3-Pt (AR)]    │                     │  [Tape Meas (TP)]   │  [Tag Roof (TR)]         │                     │
│  [Plane Lock: Z ▼]  │                     │                     │  [Tag Opening] / [Clear] │                     │
├─────────────────────┼─────────────────────┼─────────────────────┼──────────────────────────┼─────────────────────┤
│        Draw         │      Push/Pull      │      Transform      │       BIM Tagging        │        Groups       │
└─────────────────────┴─────────────────────┴─────────────────────┴──────────────────────────┴─────────────────────┘
```

### 2.1 The "Model" Tab Panels
- **Panel 1: Draw**
  - **Line (`LI` / `L`)**: 3D line drawing on active work plane or existing faces.
  - **Rectangle (`REC` / `R`)**: 2-corner or center-corner rectangle in 3D.
  - **Circle (`CI` / `C`)**: Circle defined by center and radius point.
  - **Arc (`AR` / `A`)**: 2-point or 3-point arc with chord and bulge.
  - **Plane Lock Indicator**: Visual dropdown / status showing locked orientation ($\uparrow$ XY/Blue, $\rightarrow$ YZ/Red, $\leftarrow$ XZ/Green, $\downarrow$ Face Reference).
- **Panel 2: Push/Pull**
  - **Push/Pull (`PP` / `P`)**: Hover planar face to highlight, drag along normal to extrude a solid or recess/cut a hole. Enter exact distance in VCB.
  - **Offset (`OF` / `F`)**: Inset or outset face boundary loop.
  - **Follow Me (`FM`)**: Extrude profile along a 3D path.
- **Panel 3: Transform**
  - **Move (`MV` / `M`)**, **Rotate (`RO` / `Q`)**, **Scale (`SC` / `S`)**: 3D transforms with inference snaps.
  - **Tape Measure (`TP` / `T`)**: Create dashed guide lines and measure distances.
- **Panel 4: BIM Tagging (Semantics on Geometry)**
  - **Tag Wall (`TW`)** $\to$ tags selected solid as `IfcWall`.
  - **Tag Floor (`TF`)** $\to$ tags selected solid as `IfcSlab`.
  - **Tag Column (`TC`)** $\to$ tags selected solid as `IfcColumn`.
  - **Tag Roof (`TR`)** $\to$ tags selected solid as `IfcRoof`.
  - **Tag Opening (`TO`)** $\to$ tags volume as `IfcOpeningElement`.
  - **Clear Tag** $\to$ reverts to untagged massing geometry.
- **Panel 5: Groups**
  - **Create Group (`GP`)** $\to$ isolates geometry into a component.
  - **Explode Group (`EX`)** $\to$ ungroups back into loose geometry.

### 2.2 Additions to the "Modify" Tab
On `src/components/ribbon/Ribbon.tsx` under `activeRibbonTab === 'Modify'`:
- Add a new **Direct Edit** panel placed between *Modify* and *View*:
  - **Push/Pull (`PP`)**: Large 58px button.
  - **Offset (`OF`)**: Medium button.

---

## 3. IngeTrazo Methodology & Performance Reference

The following algorithms and optimizations are adapted from `ingelibre/ingetrazo` to ensure 60 FPS performance and watertight solid integrity:

### 3.1 3D Plane Locking & Axis Magnet
- **Source**: `scratch/ingetrazo/tools/base.py` (`PlaneLock` lines 101–240, `AxisMagnet` lines 38–100).
- **Behavior**:
  - Arrow keys lock drawing plane prior to or during drawing:
    - **Right Arrow**: X-axis normal (YZ vertical plane, Red cue).
    - **Left Arrow**: Y-axis normal (XZ vertical plane, Green cue).
    - **Up Arrow**: Z-axis normal (XY horizontal plane, Blue cue).
    - **Down Arrow**: Perpendicular to hovered edge or parallel to hovered face (Magenta cue).
    - **Shift (Held)**: Contextual lock — freezes whatever inference or plane is under the cursor.
  - `_MAGNET_DEG = 3.0`: Snaps rubber-band ray to the nearest coordinate axis within 3° of deviation.

### 3.2 Planar Arrangement (Face Splitting Without Booleans)
- **Source**: `scratch/ingetrazo/core/arrangement.py` (`planar_arrangement` lines 1–150).
- **Problem**: When a user draws a rectangle on a wall or slab face in 3D, raw boolean CSG libraries often fail on coplanar faces or generate slivers.
- **IngeTrazo Solution**:
  1. Project 3D drawing segments onto the 2D plane basis $(u, v)$ via Newell normal projection.
  2. Quantize vertices to tolerance $\delta = 10^{-4}$ ($0.1\text{ mm}$) to merge coincident vertices cleanly.
  3. Split intersecting segments into atomic non-intersecting edges.
  4. Build a DCEL (Doubly Connected Edge List): at each vertex, sort outgoing half-edges by angle (`Math.atan2`).
  5. Trace bounded cycles clockwise to extract CCW outer boundary loops and CW hole loops.
  6. **Result**: Drawing any shape onto an existing face splits it into independent sub-faces ready for Push/Pull in $O(N \log N)$ time with zero boolean degeneration.

### 3.3 Push/Pull & Hermetic Cap Rebuild
- **Source**: `scratch/ingetrazo/tools/pushpull.py` & `scratch/ingetrazo/core/cap_rebuild.py` (`RebuildCache` & `apply_rebuild`).
- **Performance Optimization (`RebuildCache`)**:
  - In Three.js, re-triangulating an entire model on every mouse-move frame causes severe frame drops.
  - `RebuildCache` memos face normals, bounding boxes, and triangulations during a drag gesture. Only the active extruded face, its adjacent side quads, and affected coplanar planes are rebuilt.
- **Volumetric Parity Classification**:
  - Pushing outwards adds side quads and advances the cap.
  - Pushing inwards into a solid performs parity ray-casting:
    - Material on 1 side $\to$ creates boundary face.
    - Material on both sides $\to$ interior partition (discarded to avoid internal debris).
    - Material on 0 sides $\to$ through-hole (punches opening through the rear face).

### 3.4 Semantic BIM Tagging & Takeoff Volume
- **Source**: `scratch/ingetrazo/core/bim.py` (`face_set_volume` lines 98–120).
- **Watertight Solid Guard**:
  - An element reports honest volume only if manifold and watertight: every edge must be bordered by exactly 2 faces.
  - Volume is computed via signed tetrahedron summation:
    $$V = \frac{1}{6} \left| \sum_{i} t_{0,i} \cdot (t_{1,i} \times t_{2,i}) \right|$$
  - Net area subtracts hole loops (doors/windows) from the gross boundary.

---

## 4. File-by-File Changes in BIMWorks

### 4.1 Frontend Changes

| Target File | Changes Required |
| :--- | :--- |
| [`src/types/bim.ts`](file:///c:/Users/desig/Documents/GitHub/BIMWorks/src/types/bim.ts) | • Add `'Model'` to `RibbonTab` type.<br>• Add `ActiveTool` variants: `'LI'` (Line), `'REC'` (Rectangle), `'CI'` (Circle), `'AR'` (Arc), `'PP'` (Push/Pull), `'OF'` (Offset), `'FM'` (Follow Me), `'TP'` (Tape Measure).<br>• Add `BimDirectSolid` interface (vertices, faces, ifc_class, volume, area, tags). |
| [`src/interaction/toolCaptions.ts`](file:///c:/Users/desig/Documents/GitHub/BIMWorks/src/interaction/toolCaptions.ts) | • Register captions, shortcuts, and phase prompts for `LI`, `REC`, `CI`, `AR`, `PP`, `OF`, `FM`, `TP`. |
| [`src/components/ribbon/Ribbon.tsx`](file:///c:/Users/desig/Documents/GitHub/BIMWorks/src/components/ribbon/Ribbon.tsx) | • Add `'Model'` to `tabs` array.<br>• Render panels: `Draw`, `Push/Pull`, `Transform`, `BIM Tagging`, `Groups`.<br>• Add `Direct Edit` panel to `activeRibbonTab === 'Modify'`. |
| [`src/components/viewport/Viewport3D.tsx`](file:///c:/Users/desig/Documents/GitHub/BIMWorks/src/components/viewport/Viewport3D.tsx) | • Add Arrow-Key plane lock listener (`PlaneLock`).<br>• Implement 3D drawing raycasting (projecting onto plane/faces).<br>• Implement face hover highlight & push/pull extrusion preview.<br>• Wire live dimensions into `<ValueControlBox />`. |
| [`src/interaction/directModeling.ts`](file:///c:/Users/desig/Documents/GitHub/BIMWorks/src/interaction/directModeling.ts) *(New)* | • Client-side 2D planar projection & arrangement helper (`plane_basis`, `project_to_plane`, `unproject_from_plane`).<br>• Fast Three.js mesh builder for extruded solids and preview wireframes. |
| [`src/store/useBimStore.ts`](file:///c:/Users/desig/Documents/GitHub/BIMWorks/src/store/useBimStore.ts) | • Action `createDirectSolid(faces, normal, depth, ifcClass)`.<br>• Action `tagSelectedSolid(guid, ifcClass)`.<br>• Action `setDrawingPlaneLock(lock: 'x' \| 'y' \| 'z' \| 'ref' \| null)`. |

### 4.2 Backend Changes

| Target File | Changes Required |
| :--- | :--- |
| [`backend/command_bus.py`](file:///c:/Users/desig/Documents/GitHub/BIMWorks/backend/command_bus.py) | • Add command `DirectSolidCreate`: creates 3D solid from boundary polygons + extrusion vector.<br>• Add command `ElementTagBim`: updates element IFC class, calculates honest volume/area, records in transaction journal with undo/redo. |
| [`backend/geometry_engine.py`](file:///c:/Users/desig/Documents/GitHub/BIMWorks/backend/geometry_engine.py) *(New)* | • Port `planar_arrangement` and `face_set_volume` from IngeTrazo into clean Python service.<br>• Generates manifold Brep meshes for Three.js state bundle. |
| [`backend/ifc_service.py`](file:///c:/Users/desig/Documents/GitHub/BIMWorks/backend/ifc_service.py) | • Serializes tagged direct-modeled solids to `IfcExtrudedAreaSolid` or `IfcFacetedBrep` during `.ifc` file export. |

---

## 5. Phased Execution Roadmap

### Phase 1: Ribbon UI & Direct Modeling Hooks (MVP UI)
- [ ] Add `'Model'` tab to `src/types/bim.ts` and `Ribbon.tsx`.
- [ ] Create Revit-styled panels: `Draw`, `Push/Pull`, `Transform`, `BIM Tagging`, `Groups`.
- [ ] Add `Direct Edit` panel to `activeRibbonTab === 'Modify'`.
- [ ] Update `src/interaction/toolCaptions.ts` with labels and prompts.
- [ ] Gate check: `npm run check:bus` and `npm run check:ui` pass.

### Phase 2: 3D Viewport Drawing & Arrow-Key Plane Locking
- [ ] Implement `PlaneLock` in `Viewport3D.tsx` (Arrow keys: Up=XY, Right=YZ, Left=XZ, Down=Ref).
- [ ] Implement 3D Line (`LI`) and Rectangle (`REC`) drawing on the active plane or on existing faces.
- [ ] Display plane indicator disc and 3° magnetic snap guides.
- [ ] Connect length/dimension readout to `ValueControlBox`.

### Phase 3: Push/Pull Engine & Watertight Extrusions
- [ ] Implement face hover detection: raycast planar faces across all scene meshes.
- [ ] Implement push/pull drag gesture: extrude face along normal with real-time Three.js preview.
- [ ] Implement direct numeric input: typing `10'` or `2.5` in VCB commits exact extrusion.
- [ ] Implement backend `DirectSolidCreate` command on `command_bus.py`.
- [ ] Verify hermeticity: test that extruded boxes form valid watertight meshes.

### Phase 4: Semantic BIM Tagging & IFC Export
- [ ] Implement `tagSelectedSolid` action in `useBimStore.ts`.
- [ ] Wire ribbon buttons: Tag as Wall (`IfcWall`), Floor (`IfcSlab`), Column (`IfcColumn`), Roof (`IfcRoof`).
- [ ] Compute watertight solid volume and net surface area; display in Properties Palette.
- [ ] Verify IFC export: export sample model to `.ifc` and confirm tagged solids appear with correct classes.

---

## 6. Verification Gates

1. **Bus Parity Gate**: Every direct modeling and tagging mutation dispatches through `dispatchTransaction` via `CommandBus`. `npm run check:bus` must exit 0.
2. **UI-P0 Gate**: Tool state transitions, Escape cancellation, and two-letter hotkey routing clean. `npm run check:ui` must exit 0.
3. **Push/Pull Engine Gate**: `node scripts/check-pushpull-engine.mjs` extended to assert face extrusion, plane locking, and watertight volume calculation.
4. **TypeScript Clean**: `tsc --noEmit` must produce 0 errors.
