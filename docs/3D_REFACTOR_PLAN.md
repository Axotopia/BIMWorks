# Implementation Plan: Refactoring BIMWorks 3D Functions (Adopting N:\lapin)

## 1. Executive Summary & Architectural Goals
This plan establishes the architecture and execution steps for refactoring BIMWorks' 3D viewport systems based on the proven methods in `N:\lapin` (`apps/viewer/src/components/viewer` and `components/viewport-ui`).

### Core Deficiencies in Current BIMWorks 3D:
1. **Fixed Camera Orbit Pivot**: Orbiting always rotates around a distant target or world origin, causing geometry to fly off-screen after panning.
2. **Coarse Wheel Zooming**: Fixed 15% zoom increments without physical modifier key tracking (Ctrl/Cmd) or cursor ray surface anchoring.
3. **No Viewport HUD / Visibility Feedback**: Hidden or isolated elements provide no visual badges or quick-reset controls directly in the viewport.
4. **Lack of 3D Marquee Selection**: Selecting multiple 3D elements requires clicking one-by-one; no window/crossing box drag.
5. **Basic Measurement**: No orthogonal triad axis locking (Shift-lock) or $\Delta X, \Delta Y, \Delta Z$ coordinate deltas in 3D.

---

## 2. Architectural Blueprint from `N:\lapin`

### A. Cursor-Anchored Surface Zoom & Fine Modifier Tracking
- **Modifier Tracking (`wheelZoom.ts`)**:
  - `createFineZoomModifierTracker()` listens on window `keydown`/`keyup`/`blur` in the **capture phase** to verify physical key presses.
  - Distinguishes physical Ctrl/Cmd keys from trackpad pinch gestures (which browsers synthesize with `ctrlKey: true`).
  - When physically held, scales zoom step by `FINE_ZOOM_STEP_FACTOR = 0.2` (approx. 2.5% step vs 15%).
- **Surface Anchoring (`zoomSurface.ts`)**:
  - Raycasts into the 3D scene from cursor coordinates $(cx, cy)$.
  - Interpolates camera target towards the hit point during zoom-in, preventing thin surface overshoot and keeping the target feature centered under cursor.

### B. Dynamic Surface Orbit Pivot (`orbitPivot.ts`)
- On pointer down for orbit (Shift+MMB or Right-Click drag):
  - Raycasts against visible scene meshes.
  - If a surface is struck, sets `targetRef` to the 3D intersection point.
  - If no surface is struck but an element is selected, anchors to the element's bounding center.
  - Otherwise, falls back to the current view distance along the ray.
- Guarantees natural, CAD-grade rotation centered on what the user is actively inspecting.

### C. Six-Region Viewport HUD & Visibility Chips (`hud/ViewportHud.tsx`)
- Floating overlay with `pointer-events-none` container so canvas orbit/pan gestures are never obstructed.
- `VisibilityChips.tsx` at `top-left`:
  - `Isolated: N elements` chip with `[X]` to reset isolation.
  - `Hidden: N elements` chip with `[X]` to unhide all.
  - `Section Cut: Active` chip with toggle/reset.
  - `Projection: Persp/Ortho` badge with quick-toggle.
  - `Snaps: OFF` indicator chip when snapping is disabled.

### D. Window vs. Crossing 3D Marquee Selection (`RectSelection3D.tsx`)
- Drag marquee box in 3D:
  - **Left-to-Right (Window Selection)**: Solid sky-blue border (`#38bdf8`), sky-blue fill. Strictly selects meshes whose screen-projected bounds are fully enclosed (`isBoxInside`).
  - **Right-to-Left (Crossing Selection)**: Dashed emerald-green border (`#34d399`), emerald fill. Selects meshes whose screen-projected bounds intersect (`isBoxCrossing`).
- Uses existing `project3DToScreen` from `snapEngine.ts`.

### E. 3D Triad Axis Lock & Measurement (`measure3D.ts`)
- Snaps start and end points to mesh vertices and edges.
- Holding `Shift` engages world orthogonal triad locking (`projectOntoConstraintAxis` along X, Y, or Z).
- Live overlay displays:
  - 3D Direct Distance ($L = \sqrt{\Delta X^2 + \Delta Y^2 + \Delta Z^2}$)
  - Orthogonal deltas ($\Delta X$, $\Delta Y$, $\Delta Z$)
  - Colored triad guide lines (Red: X, Green: Y, Blue: Z).

---

## 3. Phased Execution Roadmap

| Phase | Description | Deliverables | Verification Gates |
|---|---|---|---|
| **Phase 1** | Fine Wheel Zoom & Modifier Tracker | `wheelZoom.ts`, `zoomSurface.ts` | `tsc --noEmit`, wheel responsiveness check |
| **Phase 2** | Dynamic Orbit Pivot | `orbitPivot.ts` | `tsc --noEmit`, orbit anchor check |
| **Phase 3** | Viewport HUD & Visibility Chips | `hud/ViewportHud.tsx`, `hud/VisibilityChips.tsx` | `tsc --noEmit`, `scripts/check-ui-p0.mjs` |
| **Phase 4** | 3D Window/Crossing Selection | `RectSelection3D.tsx` | `tsc --noEmit`, `check-snap-engine.mjs` |
| **Phase 5** | 3D Triad Measurement | `measure3D.ts` | `tsc --noEmit`, delta calculation check |
| **Phase 6** | `Viewport3D.tsx` Integration & Full Verification | `Viewport3D.tsx` refactor | Full `npm run check` (all 10 gate suites) |

---

## 4. Invariants & Safety Guardrails
- **No speculative dependencies**: All Three.js math and React portals use existing libraries.
- **Bus Parity**: No direct mutation; all state changes route through `useBimStore` / CommandBus.
- **No ad-hoc conversions**: Adhere to `scripts/check-ui-p0.mjs` Gate B1 (all lengths in architectural feet, formatting via `utils/units.ts`).
- **Resource Disposal**: Retain full Three.js geometry/material disposal on unmount/re-render to prevent GPU memory leaks.
