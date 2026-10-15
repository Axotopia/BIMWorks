# Audit — BIMWorks 2D/3D viewports vs Revit's viewing & direct-manipulation behaviour

**Subject:** `C:\Users\desig\Documents\GitHub\BIMWorks`, branch `gemini`, HEAD `318ce26` ("Correction").
**Scope:** `src/components/drafting/PlanViewport2D.tsx`, `src/components/viewport/Viewport3D.tsx`,
`src/components/layout/Workspace.tsx`, `src/store/useBimStore.ts`, `src/utils/geometry.ts`,
`src/interaction/toolCaptions.ts`, `backend/hlr_renderer.py`, `backend/mesh_hlr.py`, and the
view-related paths of `backend/ifc_service.py` and `backend/main.py`.
**Written:** 2026-10-15. Nothing outside `review/AUDIT-viewport-interaction-vs-revit.md` and
`scratch/_probe_*.py` was created or modified.
**Revit side:** the REA corpus in `C:\Users\desig\DSH\BIMWorks\` (`direct-manipulation-datums-walls-placements.md`,
`revit-editing-interaction-architecture.md`, `uncoupling-the-2d-editor.md`,
`views-sheets-and-tag-tracking.md`, `wall-corner-resolution.md`), treated as the authoritative
description of what Revit does.

**Method.** Every verdict below is from reading the cited line, and the performance claims are from
probes I ran against this checkout (`.venv/Scripts/python.exe`), not from documentation. Where the
corpus is a symbol-name inference rather than decompiled behaviour I say so. Read-only on source:
the only file created under `src/` or `backend/` is nothing; measurement probes were written to
`scratch/` (`_probe_scaling.py`, `_probe_e2e.py`, `_probe_snapshot_cost.py`, `_probe_slice_only.py`,
`_probe_c.py`) and the audit you are reading.

A standing distinction used throughout: **renders something** (linework appears on screen) is not the
same as **behaves like Revit** (the gesture, the model relationship, and the update contract are the
same). Several areas below pass the first and fail the second.

---

## Summary table

| # | Area | Verdict | Highest-impact gap | Evidence (file:line) |
|---|---|---|---|---|
| 1 | Plan as live model-driven document | **PARTIAL** | Live and model-driven, but regenerated **in full on every edit** (measured O(model), ~0.9 ms/wall) instead of incrementally; no in-process drag, so the 16 ms budget is 2–4× blown at small N and 100× at 2 000 elements | `useBimStore.ts:2193`, `main.py:1025-1027`, `ifc_service.py:3590-3594`; probe `_probe_slice_only.py` |
| 2 | Direct manipulation | **ABSENT** | No grips, no drag, no witness lines. Zero `onPointerMove`/drag handlers and zero `grip` references in all 22 `src` files. Backend drag machinery exists and is untriggerable | `PlanViewport2D.tsx:288-410`, `Viewport3D.tsx:490-763`; `useBimStore.ts:1762` |
| 3 | Temporary dimensions | **PARTIAL** | Real measured distance, but it is a **centre-to-centre bbox** dimension on a detached HTML pill at the viewport's top-centre — not in-canvas, no witness geometry, and editing translates the whole element | `useBimStore.ts:952-1027`, `PlanViewport2D.tsx:1299-1348` |
| 4 | Snapping & inference | **ABSENT** | Only a blanket 0.25 ft grid snap plus sketch-vertex snap; no endpoint/midpoint/intersection/face snap, no alignment guides during a drag, no override, no toggle | `PlanViewport2D.tsx:249-263`, `:153-175`, `:532-533` |
| 5 | Selection model | **PARTIAL** | Single-click raycast/path-click only: no window vs crossing, no Ctrl-add, no filter, no Tab-cycling; hover pre-highlight is wired but **never fires** | `Viewport3D.tsx:656-664`, `:104-105` vs `:1029`; `PlanViewport2D.tsx:189-220` |
| 6 | Grids and levels in views | **PARTIAL** | Grids render with bubbles and tags and are not draggable; **levels are never drawn at all** and the level-drag path (`moveLevel`) has no UI caller | `PlanViewport2D.tsx:654-689`; `useBimStore.ts:2137` (only 4 refs total, none in a component) |
| 7 | View Range and cut plane | **PARTIAL** | Per-view and persisted, but `top`/`bottom` test a mesh's **base** only, `view_depth` is a nearest-element flood fill, and the <6 ft rule is applied **by height, not by the 6 ft-above-level rule** | `mesh_hlr.py:166-218`, `:231-266`; `ifc_service.py:4132-4147`; `ViewRangeModal.tsx:56-59` |
| 8 | View types | **PARTIAL** | floor plan / section / elevation / 3D / sheet exist; **ceiling plan and camera-perspective do not**, and there is no way to create a new view | `types/bim.ts:138`; `ifc_service.py:3922-3939`; `useBimStore.ts:669-716` |
| 9 | 3D navigation | **PARTIAL** | Orbit/pan/zoom/zoom-extents present; **no walkthrough**; 2D↔3D link is selection-only (shared store), not view-linkage | `Viewport3D.tsx:499-507`, `:683-705`, `:823-829`; `Workspace.tsx:68-87` |
| 10 | Annotation & dimensions | **ABSENT** | Text/dimension/tag tools are disabled stubs; dimensions are a renderer output (2 overall extents) and tags are element string properties — **no independent tag objects tracking the tagged element** | `toolCaptions.ts:38-45`; `Ribbon.tsx:578-581`; `ifc_service.py:4311-4364`, `:4485` |
| 11 | Graphics fidelity / HLR | **PARTIAL** | Real cut/projection/hidden partitioning (not a stub), but occlusion is **per-mesh union, not true B-rep HLR**, and the frontend ignores the lineweight table it is sent | `mesh_hlr.py:390-476`; `hlr_renderer.py:144-171`; `PlanViewport2D.tsx:695-711` |
| 12 | Undo/redo & interaction contract | **PARTIAL** | Atomic rollback, modeless repeat-placement, working Esc — but **Ctrl+Z/Y are not bound** despite the button's tooltip, and the per-edit cost is two full-state snapshots | `App.tsx:40-64`; `Ribbon.tsx:181`; `command_bus.py:642,677` |

---

## 1. Plan view as a live, model-driven document

**Verdict: PARTIAL.** It is genuinely live and model-driven — but it is a full re-derivation on every
committed edit, not an incremental update, and there is no in-process drag for it to drive.

### It is live, not a snapshot — confirmed

The store holds no independent document state for the plan. `executeTransaction` POSTs the command
and then refreshes everything from the engine in one round trip
(`src/store/useBimStore.ts:2168-2200`, the `await get().fetchStateBundle()` at `:2193`), and the
bundle carries the 2D contract (`:1373` for the delta branch, `:1407` for the full branch). The plan
SVG renders `sliced2D.cut_paths` / `projection_paths` / `hidden_paths` / `grids` / `swing_paths` /
`window_paths` / `dimensions` directly from that contract (`PlanViewport2D.tsx:576-985`). So an edit
that reaches the engine reappears in the plan after one refresh — this is the right architecture and
it is the same shape as Revit's "the view is derived, the model is the document" (corpus:
`revit-editing-interaction-architecture.md:283-302`, picking resolved against the graphics
representation rather than a stored drawing).

Two supporting behaviours are also correct and worth recording, because they were previously broken:

- The plan fits once per project rather than re-fitting on every edit (`PlanViewport2D.tsx:513-538`).
- Zoom Extents is one shared event both viewports listen to (`:505-511`, mirrored in
  `Viewport3D.tsx:821-829`).

### The performance claim in `docs/IMPLEMENTATION-PLAN-2026-10-14.md` §0.2 — verified, with the path named

§0.2 says: *"Measured p50 36.7 ms / p95 66.9 ms end-to-end against a 16 ms budget, with roughly 30 ms
in refetches"* and *"Seven requests become one"*. Both halves are true of the current code.

**The path taken by one edit** (this is the chain, and it is what §0.2 replaced):

```
PlanViewport2D.handleMouseDown  (PlanViewport2D.tsx:288)
  → createWall / createDoor / …  (store action)
    → dispatchTransaction        (useBimStore.ts:2202-2209)
      → executeTransaction → POST /api/transaction   (useBimStore.ts:2170)
        → CommandBus.execute_transaction             (command_bus.py:625)
             snapshot_state()          ← full model, 1×   (command_bus.py:642)
             execute_single_command(...)                  (command_bus.py:647)
             snapshot_state()          ← full model, 2×   (command_bus.py:677, for the undo entry)
        → await fetchStateBundle()   ← ONE round trip     (useBimStore.ts:2193)
             → GET /api/state?since=<rev>…                (useBimStore.ts:1263)
                  Response B branch                       (main.py:1030)
                    timed_soft("slice2d", _slice)         (main.py:1062)
                      → bim_manager.slice_2d_vector_plan(…) (main.py:1025)
                        → _mesh_hlr_plan_contract → MeshHlrProjector.render()  (ifc_service.py:3592, 4116-4127)
             → set({ … sliced2D: data.slice2d … })        (useBimStore.ts:1373)
  → React re-renders the plan SVG                          (PlanViewport2D.tsx:576)
```

Two numbers are recorded separately and correctly: `clientMs` (what the user waits) and `engineMs`
(engine compute only), in `recordRefresh` / `refreshStats` (`useBimStore.ts:243-273`), reachable at
runtime as `globalThis.__bimworksRefresh`. They are never averaged. That is honest instrumentation.

**Measured now.** I timed the engine side of exactly that path in a clean process per size
(`scratch/_probe_slice_only.py`, best of 5, warm cache, the same manager calls the endpoint makes):

| walls | `slice_2d_vector_plan` | `snapshot_state` | per-edit engine cost (2 snapshots + slice) |
|---|---|---|---|
| 6 | 3.1 ms | 0.7 ms | 4.5 ms |
| 10 | 6.2 ms | 1.2 ms | 8.6 ms |
| 14 | 10.4 ms | 1.7 ms | 13.8 ms |
| 18 | 14.5 ms | 2.3 ms | 19.1 ms |
| 22 | 21.6 ms | 2.8 ms | 27.2 ms |

Both terms are **linear in model size**, ≈0.9 ms/wall for the slice and ≈0.13 ms/wall for the
snapshot. At the sample model's size (10 walls) the engine alone is 8.6 ms and the plan is within
budget. At 86 walls `slice2d` alone was 39.7 ms (`scratch/_probe_e2e.py`). The repo's own
`docs/DELTA-MEASUREMENT.md:48-49` records the same curve from the other end: **904 ms** engine
latency for a viewed-level 2D slice at 2 000 elements, with the note *"the geometric HLR slice step
(`slice_2d_vector_plan`) currently evaluates global geometric intersections on the queried storey,
which is O(model)"*. My 0.9 ms/wall fit lands at ~1.8 s for 2 000 walls, i.e. the same order as the
documented 904 ms with a different model mix. **The O(model) claim is confirmed by two independent
measurements.**

**Verdict on the latency question as asked.** §0.2's p50/p95 describes the *pre-fix* seven-request
path and is quoted as the reason for the fix, not as a post-fix measurement; the current code takes
the one-round-trip path, so §0.2 is accurate about the path and honest about the residual problem it
left (`docs/IMPLEMENTATION-PLAN-2026-10-14.md:141-154`). What it does not say, and what the numbers
above show, is that the 16 ms budget is still unreachable for any non-trivial model, and the reason
is now entirely the view regeneration, not the transport.

### What is missing against Revit

Revit's plan is derived through a regeneration pipeline with an explicit step repository and dirty
episodes, and the corpus establishes that the *model* regenerates through `RegenStepRepository` with
undo tracked as `DocumentIncrement` episodes, each `DBView` owning its graphics representation
(`revit2010-reverse-engineering.md:159-164`, from the REA symbol inventory). Revit re-derives what
changed. BIMWorks re-derives the whole view every time, and pays the demo cost twice more in
full-state snapshots.

### Change items

- `backend/ifc_service.py` `slice_2d_vector_plan` / `_mesh_hlr_plan_contract`: accept a dirty-GUID set
  and re-project only those elements, reusing the previous contract's untouched partitions. `MeshHlrProjector`
  already takes `include_guids` (`mesh_hlr.py:393`) — the missing piece is a *delta* mode that keeps
  the paths it already emitted for clean elements and re-unions only against the dirty set.
- `backend/mesh_hlr.py` `MeshHlrProjector._prepare`: cache the prepared polygon list per mesh GUID and
  invalidate on the mesh's dirty flag rather than rebuilding every polygon on every call (`:116-164`).
- `backend/command_bus.py:642,677`: replace the two full `snapshot_state()` calls with a
  copy-on-write record or a command-inverse journal, so per-edit cost is O(changed) rather than O(model).
- `src/store/useBimStore.ts:1263`: consume a push/delta contract per changed view instead of re-requesting
  the slice on every commit, which `SPEC.md` §3.2 already specifies (`IMPLEMENTATION-PLAN-2026-10-14.md:150`).

---

## 2. Direct manipulation — grips, drag-to-move, rotate, mirror, offset

**Verdict: ABSENT.** There is no grip, no drag, and no witness line anywhere in either viewport.

### Evidence of absence

- A search of all 22 `src` `.ts`/`.tsx` files for `grip` and `Grip` returns **0 hits**. `onPointerMove`
  returns **0 hits**. The only `onDragStart`/`onDragOver` hits (2 and 1) are the Sheet canvas's
  drag-a-view-from-the-browser drop target and the Project Browser's drag source
  (`SheetCanvas.tsx:38-42`, `ProjectBrowser.tsx:61`), not element manipulation.
- `PlanViewport2D.handleMouseDown` (`PlanViewport2D.tsx:288-387`) branches on `activeTool` into:
  sketch drawing (`:308-330`), wall two-point (`:332-341`), roof/slab sketch entry (`:342-345`),
  and door/window host picking (`:346-385`). In `activeTool === 'select'` it sets
  `isPanningRef.current = true` (`:298-302`) — **a left-click in select mode starts a pan, not a drag
  of the element under the cursor.**
- `handleMouseMove` (`:389-406`) only pans or updates a rubber-band preview point, and it is gated on
  `activeTool !== 'select'` (`:400`), so in select mode the viewport tracks nothing about the element.
- `Viewport3D.handleMouseDown` (`Viewport3D.tsx:490-666`): middle-drag = pan, shift+middle = orbit
  (`:499-508`), left = tool placement or raycast selection (`:511-665`). No drag of a selected element.
- `useBimStore` contains **no** drag/begin-drag/end-drag state at all: the interaction state is
  `selectedGuid`, `hoveredGuid`, `activeTool`, `alignPickState`, `sketchSession`,
  `interactionResetToken` (`useBimStore.ts:413-530`).

### The backend already has the operations — they are unreachable from a viewport

`ElementCopy / ElementRotate / ElementOffset / WallTrimExtend / WallSplit / LevelMove` are registered
bus commands and their store wrappers exist (`useBimStore.ts:590-595`, `:2080-2148`), and they are
tested (`scratch/test_dependency_graph.py` §7, which I ran: 41/41 pass). But:

- No component calls `copyElement`, `rotateElement`, `offsetElement`, `trimExtendWall`, or `splitWall`.
  A search of `src` for those call sites returns only the store's own declarations and definitions.
- They are reachable only from the AI/Prompt surface, which is why the parameter-binding problem has
  never surfaced.

So the Revit operations exist as *commands* with no *gesture*. That is the exact inverse of Revit's
architecture, where the gesture and the command are the same object: `ACommandHandler::getEditor`
returns the Editor that performs the interaction, and the commit arrives via
`requestTransactionInterrupt` → `finishTransactionInterrupt` →
`ACommandHandler::execute` (`revit-editing-interaction-architecture.md:26-40`). Revit has no
"operation with no gesture" state.

### What Revit actually does, and the concrete consequence for BIMWorks

The corpus is unusually specific here, and its central correction is worth taking literally:

> **There is no `Grip` class anywhere in Revit's UI modules.** A search across `RevitUI.dll` for
> `Grip|Maneuver` returns **zero** symbols. […] So a **shape handle is a pick** (element id + tag)
> that the *Move helper* recognises as a handle control. — `direct-manipulation-datums-walls-placements.md:17-35`

The consequences the corpus draws, each of which BIMWorks currently violates:

1. **Handles are tagged picks resolved by a move helper**, not a grip subsystem
   (`…placements.md:23-27`, `MoveHelperUI::getPicks4KnownShapeHandleCtrls`). That is why Revit's
   handles work uniformly across walls, grids, dimensions and columns (`:33-35`). BIMWorks has no
   pick-with-tag concept at all: `PlanViewport2D` selection is `onClick` per `<path>`
   (`PlanViewport2D.tsx:593-596`, `:704-707`) and 3D selection is `raycaster.intersectObjects` taking
   `intersects[0].object.userData.guid` (`Viewport3D.tsx:656-661`). No sub-element reference exists,
   so there is nothing for a handle to be.
2. **Joins are recomputed *during* the drag**, with both establish and remove paths
   (`EstablishJoinsForDragHelper::establishJoinsBetweenElements` / `removeJoinsToExternalElements`,
   `…placements.md:109-118`). BIMWorks has the join engine and an incremental recompute
   (`recompute_wall_joins(only=[...])`, exercised by `scratch/test_dependency_graph.py` §6) — it is
   simply never called from a drag, because there is no drag.
3. **Ctrl+drag = copy + temporary dimensions**, a single named behaviour
   (`MoveMgr::makeDimsForCtrlDrag`, `…placements.md:130-136`). BIMWorks binds no `ctrlKey` handling in
   either viewport: the only `ctrlKey` uses in `src` are Ctrl+S save (`App.tsx:42`), Ctrl+Enter in the
   prompt bar (`PromptBar.tsx:40`) and Ctrl+O open (`Ribbon.tsx:58`). Ctrl as a *modifier for a
   manipulation* is unbound.
4. **`MultiEndDragEditor`** drags several ends at once (`…placements.md:79-80`) — not modelled, and
   not even representable: there is no multi-selection (see §5).
5. **Transient alignment lines are a scoped, acquired/relinquished resource**
   (`SnappingHelper::acquireTransientAlignmentId` / `relinquishTransientAlignments`,
   `…placements.md:64-74`). BIMWorks draws persistent alignment-constraint overlays from stored
   constraints (`PlanViewport2D.tsx:912-984`) — a different thing, and it has a rendering defect
   (see §4).
6. **Editors tear down sub-editors on a handled command** (`abortSubEditorsOnHandledCommand` recurs
   across ≥4 editors, `…placements.md:287-296`). BIMWorks' equivalent is the single
   `interactionResetToken` broadcast (`useBimStore.ts:833-837`, consumed at
   `PlanViewport2D.tsx:279-285` and `Viewport3D.tsx:175-185`) — a commendably single cancel path, but
   it has no notion of a sub-editor to abort.

### The one place Revit's shape *is* present

Sketch mode is the closest thing to an editor: it has a session object, a draw tool, a rubber band, a
cancel/finish contract, and a per-line selection (`useBimStore.ts:629-639`,
`PlanViewport2D.tsx:988-1228`). But even there, moving a vertex is a *typed numeric* command
(`sketchMoveVertex(guid, curveId, endIndex, to)` at `useBimStore.ts:2036-2047`), not a drag — and no
component calls it. The store even labels the transaction *"Sketch: drag vertex"*
(`useBimStore.ts:2041`) while no drag exists; the label is aspirational, and the plan is candid about
this (`IMPLEMENTATION-PLAN-2026-10-14.md:321`, `:351`).

### Change items

- Introduce a typed pick: `{ guid, tag?, kind }` returned by hit-testing in both viewports, filtered
  by a per-tool predicate. Revit's `GRAPHICS.DLL::Pick` carries exactly `getElemId` + `getTag`
  (`revit-editing-interaction-architecture.md:286-288`).
- Add a `moveHelper` that maps a pick with a handle tag to a `DragEndEditor`-shaped state machine
  (`direct-manipulation-datums-walls-placements.md:302-307`), driving the *existing*
  `WallTrimExtend` / `translateElement` commands so the CommandBus invariant is preserved.
- Bind Ctrl+drag to `ElementCopy` + a temporary dimension (`…placements.md:130-136`).
- Give `PlanViewport2D` a real drag state (`dragRef` with `{ guid, handle, startModel, constraint }`)
  and remove the `activeTool === 'select'` → pan coupling at `PlanViewport2D.tsx:298-302`.

---

## 3. Temporary dimensions

**Verdict: PARTIAL.** They are real and measured (plan finding N11's hardcoded default is genuinely
gone), but they are not Revit's temporary dimensions in placement, geometry, or semantics.

### What exists, precisely

- On selection, `setSelectedGuid` computes a distance to the **nearest other element's bounding-box
  centre** (`useBimStore.ts:967-990`) and sets `tempDimension` with `distance`, `displayValue`,
  `witnessP1/P2`, `center`, `axis` (`:1011-1025`). The comment at `:959-966` is honest that the engine
  exposes no witness-line model. If the element is the only one in the model, no dimension is created
  rather than a fabricated default (`:992-995`) — N11 is fixed.
- `applyTemporaryDimensionChange` computes `delta = newValue - tempDimension.distance` and calls
  `translateElement(guid, dx, dy, 0)` along the dominant axis (`useBimStore.ts:1066-1077`).
- The UI is an **HTML pill at the top-centre of the viewport**, absolutely positioned
  (`PlanViewport2D.tsx:1300-1301`: `absolute top-14 left-1/2 -translate-x-1/2`), duplicated verbatim in
  the 3D viewport (`Viewport3D.tsx:910-911`). It shows `tempDimension.displayValue` and, on click,
  swaps to a text input whose Enter handler parses with `tryParseLength` and applies
  (`PlanViewport2D.tsx:1303-1346`).

### Where it diverges from Revit

| Revit (from the corpus) | BIMWorks |
|---|---|
| `PreviewMgr::showPreviewDims`, temp wall dims **keyed by element id**, `getTempWallDimIds`; the editor registers a `getListenDimId` and is told `onListenDimDone` (`uncoupling-the-2d-editor.md:144-172`) | Dimensions live in one store field, `tempDimension`, overwritten on each selection (`useBimStore.ts:1011`). Not keyed by element, not listened to, no preview-manager equivalent. |
| A reusable **typed inline editor family** — `TextLengthEditor`, `TextAngleEditor`, `TextDoubleEditor`, `TextParamEditor` — with `computeButtonPos`, `createButtons`, `onUserCommit`/`onUserCancel`, `validate` (`revit-editing-interaction-architecture.md:184-226`) — i.e. the **✓ / ✗ pair beside the in-canvas box** | One hand-rolled `<input>` per viewport, duplicated (`PlanViewport2D.tsx:1304-1331` and `Viewport3D.tsx:914-938`), no commit/cancel buttons, Escape closes the editor only (`:1325-1328`). |
| Dimensions are **in-canvas geometry** at the measured faces, with witness lines and a draggable dimension line | A floating pill at viewport top-centre, geometrically unrelated to the element. The `witnessP1`/`witnessP2`/`center` values are computed and **never read** — a search for `witnessP1|witnessP2` across `src` returns only the store's write and the type declarations (`useBimStore.ts:1016-1017`, `types/bim.ts:186-187`). No renderer consumes them. |
| Editing a temporary dimension moves **the face it references** — the opposite end stays put | Editing moves **the entire element** by the delta (`useBimStore.ts:1072-1075`). Measured against Revit this is the wrong verb: Revit's temporary dimension between a wall face and a gridline adjusts the wall, not the gridline, and never translates both. |
| `DragEndEditor::statusPrompt`, `onLoadEditor`/`onAbortEditor` lifecycle (`direct-manipulation-datums-walls-placements.md:77-83`) | No lifecycle; the dimension appears and disappears with selection. |

Two further concrete defects in the current implementation:

1. **The dimension measures a meaningless pair.** Centre-to-centre of the two nearest bounding boxes
   is not a Revit dimension. Revit measures between *references* (faces, centrelines, gridlines) and
   lets the user pick which. Selecting a wall in a 4-wall room yields a diagonal-ish centre offset
   (the axis is chosen by `Math.abs(...) >= Math.abs(...)` at `useBimStore.ts:1006-1009`), which will
   usually read as a number the user did not ask for and cannot re-target.
2. **The rendered units are wrong in the analytic fallback.** `ifc_service.py:3767` builds dimension
   text as `f"{length:.2f} m ({length * 3.28084:.1f}')"` — the length is decimal feet (the project's
   locked internal unit, `IMPLEMENTATION-PLAN-2026-10-14.md:16`) but is printed with an `m` label and
   converted as if it were metres, so a 30 ft wall reads `30.00 m (98.4')`. This is the same class of
   bug the plan records as fixed twice already (UI-P0-2, `PlanViewport2D.tsx:1282-1285`) and it
   survives in this path. The mesh-HLR path does not hit it (`_overall_dimensions` uses
   `format_feet_inches`, `ifc_service.py:4325-4348`), so the defect is latent until the analytic
   renderer is selected.

### Change items

- `src/store/useBimStore.ts:952-1027`: derive the temporary dimension from an element *reference*
  (wall face / baseline endpoint / grid line), not a bbox centre, and key it by element id so more
  than one can coexist as Revit's preview manager does.
- `PlanViewport2D.tsx` / `Viewport3D.tsx`: render the dimension as SVG/canvas geometry using the
  `witnessP1`/`witnessP2` values that are already computed, with a draggable dimension line.
- Extract one typed inline editor component (`TextLengthEditor` analogue) shared by both viewports,
  with `onUserCommit` / `onUserCancel` and a ✓/✗ affordance
  (`revit-editing-interaction-architecture.md:214-226`).
- `backend/ifc_service.py:3760-3769`: fix the `m` label / 3.28084 conversion in the analytic
  dimension text, or delete the analytic dimension drive in favour of `_overall_dimensions`.
- `applyTemporaryDimensionChange` (`useBimStore.ts:1066`): move the referenced face via
  `ElementUpdate` on `start`/`end` rather than translating the whole element.

---

## 4. Snapping and inference

**Verdict: ABSENT** in the Revit sense. What exists is a uniform coordinate quantiser plus one
sketch-local vertex snap.

### What exists

- `getModelCoords` rounds every model coordinate to a 0.25 ft grid unconditionally
  (`PlanViewport2D.tsx:249-263`, `const snap = 0.25; Math.round(modelX / snap) * snap`). Its own
  comment states the intent: *"UI-P1-3 replaces this blanket grid with a real SnapEngine (endpoint /
  midpoint / face / intersection), with the grid as one opt-in candidate type"* (`:246-248`). That
  replacement has not happened — a search of `src` for `SnapEngine` returns 0 hits.
- `findSnapVertex` snaps only to endpoints of lines in the **active sketch session**, tolerance 0.35 ft
  (`PlanViewport2D.tsx:153-175`), and posts a hardcoded "Endpoint Snap" label
  (`:1222`). It returns `null` whenever `sketchSession` is null (`:155`), i.e. during all normal
  modelling.
- Both viewports quantise to 0.5 ft for wall/roof/slab points (`Viewport3D.tsx:532-533`, `:553-558`,
  `:579-584`), with the same "UI-P1-3 will replace this" comment (`:530-531`).

### Absent, by search across all 22 `src` files (each 0 hits)

`UsefulSnap`, `snapToggle`, `IntersectionSnap`, `preHilite`, alignment-guide-during-drag, snap
override, snap settings. There is also no snap UI in the Ribbon or Status bar: the Status bar's
toggles are visual style / detail level / view range (`StatusBar.tsx:107-119`).

### Against Revit

Revit's snapping is a **composable filter pipeline that emits snaps**, not a coordinate rounder:
`DatumSnapFilterTmpl<CachingPickFilter<SnapMoveFilter>>::addCustomSnaps(…, const Plane&,
OwnerArr<RawSnap>*)` — a template over a caching filter over a move filter, given a plane, emitting
`RawSnap` objects (`direct-manipulation-datums-walls-placements.md:49-63`). Supporting machinery —
`PointSnappingHelper`, `LineAndArcSnappingHelper::getAllowNonPlanarChain`,
`SnappingHelper::acquireTransientAlignmentId` — is per-element-type and *scoped*
(`:64-74`). The consequences the corpus draws are exactly the ones BIMWorks lacks: caching as an
explicit layer (`:55-62`), snaps as data rather than coordinates, and transient alignment lines that
are acquired and relinquished rather than permanently drawn.

### A concrete defect in the alignment-guide overlay

`alignmentGuide` (`PlanViewport2D.tsx:67-104`) computes the guide position as the **midpoint of the
union of the two elements' bounds**: `const guide = (span.min[0] + span.max[0]) / 2` for an x-axis
constraint (`:83`) and the y analogue at `:95`. A Revit alignment guide is drawn **at the constrained
coordinate** (the shared face/centreline), not at the average of two elements' extents. For two walls
of different lengths the guide will visibly miss the alignment it is depicting — which is worse than
not drawing it, because it is labelled as a constraint. The comment block at `:7-14` explains that an
earlier version drew a fixed line at `x -5..18, y 0`, and that this was replaced with "the constrained
elements' real extents" — but the midpoint of a union is not the constrained coordinate either. The
fix is to read the constraint's own coordinate (`c` carries `ref_guid`/`target_guid`/`axis` but the
solver's resolved value is not in the payload; `add_align_constraint` at `ifc_service.py:2417`
computes `get_element_coord(guid, axis)`, so the value exists engine-side and should be emitted).

### Change items

- `backend/ifc_service.py`: emit each `align` constraint's **resolved coordinate** so the overlay can
  draw the guide where the constraint actually is, and consume it in `alignmentGuide`.
- Introduce a `SnapEngine` in `src/interaction/` returning typed candidates
  (`{kind: 'endpoint'|'midpoint'|'intersection'|'face'|'grid', point, priority}`), with the 0.25 ft
  grid as one opt-in candidate type, and route `getModelCoords` (`PlanViewport2D.tsx:249`) through it.
- Add snap override (Revit's Shift+right-click menu is a UI choice; the *capability* is the point) and
  a Status-bar snap toggle.
- Draw transient alignment guides from snap results during a drag, scoped to the gesture
  (`direct-manipulation-datums-walls-placements.md:64-74`).

---

## 5. Selection model

**Verdict: PARTIAL.** Single-click selection works in both viewports. Everything else Revit does is
missing, and one implemented affordance is dead.

### What exists

- 2D: per-path `onClick` → `handleElementClick` (`PlanViewport2D.tsx:189-220`), which routes sketch
  pick-walls, align picks, and `setSelectedGuid` (`:219`). Paths are the `cut_paths`, `slabs`, and
  `roofs` SVG elements (`:593`, `:608`, `:704`).
- 3D: raycast against `threeMeshesRef`, take `intersects[0]`, `setSelectedGuid` or `null`
  (`Viewport3D.tsx:656-664`).
- Shared selection state links the two viewports directionally through the store: 3D highlights on
  `isSelected` (`Viewport3D.tsx:428-432`), 2D restyles its paths (`PlanViewport2D.tsx:693-703`).
- Escape clears selection and the active tool in one path (`useBimStore.ts:855-865`).
- Temporary hide/isolate exist as keystrokes `HH`/`HI`/`HR` (`useBimStore.ts:905-907`) and filter the
  3D mesh build (`Viewport3D.tsx:403-404`) — a Revit behaviour, though it is a keystroke rather than a
  context-menu item, and it is **3D-only**: the plan does not honour `hiddenGuids`/`isolatedGuids`
  anywhere in `PlanViewport2D.tsx`.

### Absent

| Revit behaviour | Status | Evidence |
|---|---|---|
| Window selection (left→right) vs crossing selection (right→left) direction semantics | **Absent.** No marquee/rubber-band selection exists. Searched `src` for `marquee`, `window.?select`, `crossing`: 0 hits. `SelectRectEditor` (`revit-editing-interaction-architecture.md:168`) has no analogue — `handleMouseMove`'s only rubber band is the wall/box *preview* (`PlanViewport2D.tsx:1231-1269`). |
| Ctrl-add / Shift-remove selection | **Absent.** `setSelectedGuid` is a single nullable string (`useBimStore.ts:514`). No `ctrlKey`/`shiftKey`/`metaKey` inspection in either viewport's mouse handlers. |
| Selection filter ("Filter" dialog) | **Absent.** No filter predicate type anywhere; picking is unconditional. |
| **Tab-cycling through overlapping elements** | **Absent.** `PickEditor::onTab` / `addGenericCandidatesAfterCurrent` (`revit-editing-interaction-architecture.md:162,179-180`) has no analogue; the raycast takes `intersects[0]` (`Viewport3D.tsx:660`) and the SVG takes whichever path the browser hit-tests first. |
| Hover **pre-highlight** (`getSelectionToPreHilite`, `HighLightContextualLine`) | **Declared but dead.** `Viewport3D` destructures `hoveredGuid, setHoveredGuid` (`Viewport3D.tsx:104-105`), uses `isHovered` to colour the mesh (`:417`, `:430-431`), and lists `hoveredGuid` in the effect deps (`:483`) — but `setHoveredGuid` is **never called**: a search of `src` for `setHoveredGuid(` returns only its definition (`useBimStore.ts:1029`). There is no `onMouseMove` hover raycast on the canvas (the move handler at `:668-748` only handles navigation and tool previews). `PlanViewport2D` has no hover state at all. |
| Sub-element (edge/face) pick, `EdgePickEditor`/`FacePickEditor` | **Absent.** No sub-element reference concept; see §2. |
| Multi-selection as a set | **Absent.** `MultiElementPickEditor` (`revit-editing-interaction-architecture.md:164`) has no analogue: no `selectedGuids` array exists in the store's state interface (`useBimStore.ts:422-530` uses the singular `selectedGuid` at `:514`). |

### Change items

- `src/store/useBimStore.ts`: change `selectedGuid: string | null` to a selection *set* with
  add/remove/toggle semantics, keeping a derived "primary" for the Properties palette.
- Add marquee selection to `PlanViewport2D` with Revit's direction convention (L→R window = fully
  contained; R→L crossing = intersect), which requires hit-testing path extents against the rubber
  band rather than relying on browser hit-testing.
- Wire `setHoveredGuid` from a `mousemove` raycast in `Viewport3D` and from `onMouseEnter`/`onMouseLeave`
  per path in `PlanViewport2D`, styled distinctly from selection (Revit: pre-highlight ≠ highlight,
  `revit-editing-interaction-architecture.md:121-124`).
- Add Tab-cycling: collect all intersections under the cursor, keep a cycling index, advance on Tab.
- Honour `hiddenGuids`/`isolatedGuids` in `PlanViewport2D`'s path filters so hide/isolate is view-wide.

---

## 6. Grids and levels in views

**Verdict: PARTIAL.** Grids render properly. Levels do not render at all, and neither can be dragged.

### Grids — present and reasonably faithful

The contract carries grids with an axis path, a bubble centre and a tag:
`ifc_service.py:4381-4412` (`_finish_plan_contract`, the path that actually runs) and the analytic
equivalent at `:3806-3833`. The bubble offsets are in feet (`FEET_4` / `FEET_2` at `:4401-4402`, with a
comment recording that they were metres and 3.28× too far out — a fixed defect). The viewport draws
the dashed axis, a white bubble circle of radius 0.26, and the tag text
(`PlanViewport2D.tsx:654-689`). Bubble **heads** therefore exist, and the label is the grid's `tag`.
The `_finish_plan_contract` comment at `:4388-4393` records that omitting `tag`/`circle_center` once
crashed the viewport — the contract is load-bearing and now complete.

What is missing against Revit: grids are **not selectable or draggable** (they are drawn inside the
same SVG `<g>` but have no `onClick` — compare `PlanViewport2D.tsx:655-689` with the walls at
`:704-707`), grid **bubble size/position is not adjustable per view**, there is no 2D/3D extent model
(Revit grids have independent 2D and 3D extents), and there is no way to create a grid — `GR` is
disabled (`toolCaptions.ts:38`, `Ribbon.tsx:467-473`). Revit's grid dragging is the canonical
`DatumLinearElemWrapper` + `DatumSnapFilterTmpl` case with `CheckViewForLevelRelatedToolOptions`
offering to take you to a valid view (`direct-manipulation-datums-walls-placements.md:39-95`).

### Levels — absent from views

- **No level is ever drawn in the plan.** `PlanViewport2D.tsx` renders slabs (`:580`), roofs (`:602`),
  grids (`:655`), cut paths (`:692`), projections (`:714`), hidden (`:730`), windows (`:746`), swings
  (`:760`), dimensions (`:774`), align guides (`:914`), sketch (`:988`). There is no level branch, and
  the store's `levels` are never mapped into a `sliced2D` drive: the plan contract's key set
  (verified by execution) is `cut_absolute, cut_elevation, cut_paths, dimensions, grids,
  hidden_paths, level_elevation, level_id, level_name, lineweights, partitions, plan_rotation,
  projection_paths, renderer, roofs, slabs, swing_paths, window_paths` — **no `levels` key**. So
  levels exist only as Project Browser rows and as the Properties palette's level selector, not as
  view datums.
- **Dragging a level is impossible in the UI.** `moveLevel` exists as a store action and dispatches
  the `LevelMove` command (`useBimStore.ts:2137-2147`, mapping at `:125`), and the backend
  implementation is real and tested — I ran `scratch/test_dependency_graph.py` §3, which asserts
  *"move Level 2 → constrained walls follow"*, *"elements on the moved level followed"*, *"elements on
  other levels did not move"*, and *"aligned wall followed its reference (solver propagation)"*: all
  pass. But a search of all of `src` for `moveLevel|LevelMove` returns **only 4 hits, all inside
  `useBimStore.ts`** (the map entry, the interface declaration, and the action definition). **No
  component ever calls it.** The capability is complete and unreachable.
- Creating a level is also unreachable: `LL` is disabled (`toolCaptions.ts:39`, `Ribbon.tsx:475-481`).

This is the single clearest "backend ahead of UI" gap in the audit: P3's headline exit criterion
(`IMPLEMENTATION-PLAN-2026-10-14.md:289`) is *met by the engine and not exposed by either viewport*.

### Change items

- `backend/ifc_service.py` `_finish_plan_contract` / `_mesh_hlr_plan_contract`: add a `levels` drive
  (elevation, name, extent) so a plan can draw level datums, and a `grids[].extent` per view.
- `PlanViewport2D.tsx`: render level datums and make grids and levels `onClick`-selectable; add a
  level-drag gesture that calls the existing `moveLevel` (one binding, since the backend path is done).
- Add a level-drag handle in an elevation/section view, which is where Revit expects it.

---

## 7. View Range and cut plane

**Verdict: PARTIAL.** The four fields exist, are per-view, and are persisted — but two of the four
fields do not mean what Revit means, and the famous <6 ft rule is implemented on the wrong axis.

### What is implemented and correct

- Fields are per-view and persisted: `DEFAULT_VIEW_RANGE = { top: 8.0, cut: 4.0, bottom: 0.0,
  viewDepth: 0.0 }` (`useBimStore.ts:648`), `ROOF_VIEW_RANGE` for the roof plan (`:649`), seeded per
  view (`:669-716`), edited through a modal that reads and writes the active view
  (`ViewRangeModal.tsx:56-59`, `:27-32`) and shows the resulting absolute elevation (`:159-165`) —
  which is genuinely good UX and matches Revit's mental model.
- The engine honours the fields rather than merely echoing them: `_apply_view_range`
  (`mesh_hlr.py:166-218`) and the `view_depth` filter (`:231-266`), wired from the request in
  `main.py:1011-1027` and applied at `mesh_hlr.py:421-422`.
- `cut` is **level-relative**, which is the Revit convention and the only thing that works on a real
  model: `absolute_cut = base + cut_elevation` where `base` is the resolved storey elevation
  (`ifc_service.py:4109-4114`), with the reasoning recorded at `:4092-4096`.

### Where it diverges from Revit

1. **`top`/`bottom` are tested against the mesh's base, not its extent.** `_apply_view_range` comments
   this explicitly: *"`top`/`bottom` bound where the mesh's BASE sits, not its whole height: a wall
   whose base is inside the view range is part of the view even though its top runs past the range's
   top (otherwise every 10 ft wall is excluded by a range whose top is 8 ft, which is what happened
   first)"* (`mesh_hlr.py:205-212`). That is a workaround for the absence of a cut-at-the-range-top
   step, and it means **BIMWorks never clips geometry to the View Range's Top** — a 20 ft wall in a
   view whose Top is 8 ft is drawn in full projection instead of being cut at 8 ft. Revit's View Range
   defines a Primary Range (Top / Cut plane / Bottom) plus a View Depth, and geometry above Top is
   **not** drawn at all.
2. **`view_depth` is a nearest-element flood fill, not a distance from the cut plane.** `_depth_filter`
   anchors on the nearest element's bbox and keeps anything within `depth` of the *already kept set*,
   iterating until stable (`mesh_hlr.py:231-266`). The docstring is candid: *"Two earlier attempts were
   wrong in instructive ways […] Anchoring on the nearest element is stable in both cases"* (`:235-241`),
   and `IMPLEMENTATION-PLAN-2026-10-14.md:368` records it as *"a simple approximation of Revit's view
   range rather than a full implementation."* Note the loop structure at `:254-265` is a
   fixpoint-until-stable scan, which is O(N²) in the worst case.
3. **The <6 ft rule is applied by wall *height*, not by the cut plane's height above the level.**
   `ifc_service.py:4132-4147` builds `low` from `0.0 < meta['height'] < FEET_6` and moves those walls'
   cut paths into projection; the analytic fallback does the same via `is_wall_cut = wall_h >= FEET_6`
   (`:3621-3627`). Revit's actual rule is about the **cut plane's** relationship to the element — the
   corpus frames the cut plane and Primary Range as the operative concepts
   (`views-sheets-and-tag-tracking.md`; and `revit2010-reverse-engineering.md:159-164` for the
   per-`DBView` graphics ownership). Concretely: a 7 ft wall whose base is 5 ft above the level, under
   a 4 ft cut, is *below* the cut and should be drawn in projection by elevation — BIMWorks calls it
   "cut" because 7 ≥ 6. The height test happens to approximate the common case and misclassifies
   offset cases. It is at least tested (`scratch/test_hlr.py` §3: *"low wall is projected, not cut"*,
   *"tall wall is cut"* — I ran it: 31 passed / 0 failed), so the behaviour is deliberate rather than
   accidental, but it is an approximation presented as the rule.
4. **"View Depth 0 means not set" is a convention, not Revit.** Handled at `mesh_hlr.py:189-194` and
   `useBimStore.ts:1244-1245`, with the reason stated. Revit's View Depth "Beyond" is a real value; the
   overload means a user who genuinely wants a 0-depth view cannot express it.

### Change items

- `backend/mesh_hlr.py:_apply_view_range` (`:166-218`): clip geometry to `top` and `bottom` as true
  z-intervals (cut at `top`, drop below `bottom`) instead of testing the mesh base.
- `backend/mesh_hlr.py:_depth_filter` (`:231-266`): measure from the cut plane, per Revit's View
  Depth semantics, and drop the flood-fill.
- `backend/ifc_service.py:4132-4147` and `:3621-3627`: re-express the not-cut rule against the cut
  plane's position relative to the element's base/top rather than the element's height.
- `ViewRangeModal.tsx`: distinguish "unset" from 0 for View Depth rather than overloading 0.

---

## 8. View types

**Verdict: PARTIAL.** Four of Revit's six exist; ceiling plan and camera-perspective do not, and
nothing can create a view.

### Present

`ViewType = 'floor_plan' | '3d' | 'section' | 'elevation' | 'sheet'` (`src/types/bim.ts:138`). Seeded
views: `view-3d` (`useBimStore.ts:669-677`), `view-level-1` and `view-level-2` (`:679-698`),
`view-roof-plan` (`:699-708`, a floor plan with the taller `ROOF_VIEW_RANGE`), `view-section-1`
(`:709-716`). Backend `render_2d_view` accepts `floor_plan | plan | section | elevation` and selects a
camera from five directions (`ifc_service.py:3922-3939`); a plan cuts, an elevation does not, a section
does (`:3949-3952`). The store routes by the active view's own type, including sections and elevations
(`useBimStore.ts:1493-1524`), and `setActiveViewId` fetches a slice for any non-3D, non-sheet view
(`:940-948`). Sheets and viewports on sheets are a separate, working subsystem
(`SheetCanvas.tsx`, `useBimStore.ts:562-567`).

### Absent

- **Ceiling plan: absent.** Searched all `src` files and all `backend/*.py` for `ceiling` — **0 hits**.
  There is no ceiling-plan view type, no "look up" camera, and no mirrored view-range semantics. Revit's
  ceiling plan is a distinct view type with its own range direction; BIMWorks cannot express it.
- **Camera / perspective: absent.** Searched `backend` for `perspective` and `camera`-as-view-type —
  0 hits (`ViewCamera` is an orthographic projector, `mesh_hlr.py:52-71`). The 3D viewport is a
  `PerspectiveCamera` (`Viewport3D.tsx:231`) but it is a navigation viewport, not a document view type:
  it cannot be saved, named, placed on a sheet, or given a view range, and there is no walkthrough.
- **No view creation.** `setActiveViewId` (`useBimStore.ts:940`) only *selects*; `Workspace.tsx:114-133`
  can *add a dockview panel* for a view that already exists in the store, but nothing creates a new
  `ViewDefinition`. So the seeded five views are the only views a session can ever have (unless the
  backend's `views_rev` gating supplies more, `main.py:1079`).
- **A real defect in the plan header.** `PlanViewport2D.tsx:1274-1297` falls back to a fabricated view
  when the active view id does not resolve: `{ name: 'Floor Plan: Level 1', viewRange: { cut: 4.0 } }`.
  The header at `:1281-1285` then prints that name and cut plane. Because `Workspace.tsx:105-107` sets
  `activeViewId` to any panel id starting with `view-`, opening the **Roof Plan** panel (id
  `view-roof-plan`) or a dynamically added panel whose id is not in `views` renders
  "Floor Plan: Level 1 (Cut Plane: 4'-0\")" over the roof plan, which is in fact drawn at the roof
  view range. This is precisely the N11 class of defect (a hardcoded value presented as live data)
  surviving in a corner the P0-5 sweep did not reach.

### Change items

- Add `ceiling_plan` to `ViewType` (`src/types/bim.ts:138`), to the backend's accepted set with an
  upward-looking camera and inverted range semantics (`ifc_service.py:3922-3939`), and a seeded view.
- Give 3D/camera views a `ViewDefinition` representation so they can be named, saved and placed on a
  sheet, and add a walkthrough motion mode.
- Add a "create view" path in the Project Browser (New Floor Plan / Section / Elevation / 3D).
- `PlanViewport2D.tsx:1275-1278`: replace the fabricated fallback with the real view or an explicit
  "unknown view" state — never a plausible-looking wrong label.

---

## 9. 3D navigation, and the 2D↔3D link

**Verdict: PARTIAL.** The four navigation primitives exist; walkthrough does not, and the views are
selection-linked but not view-linked.

### Present

- **Orbit:** Shift + middle-drag (`Viewport3D.tsx:499-508`, applied at `:683-690`). Revit's canonical
  gesture is Shift+MMB, so this matches.
- **Pan:** middle-drag (`:504-505`, applied `:691-705`), panning parallel to the screen plane with a
  radius-scaled factor.
- **Zoom:** native non-passive wheel listener, radius-clamped 0.5…10 000 (`:279-290`), registered
  natively with `{passive:false}` and an explicit comment on why React's passive wheel could not
  `preventDefault` (`:274-278`). This is correct and hard-won.
- **Zoom-to-fit:** `fitToExtents` over the model bbox, also fixing `camera.far` for large models
  (`:765-798`), fired once per project rather than per edit (`:800-819`, the same UI-P0-6 class of fix
  as the plan), and reachable from three routes: the `ZE` hotkey (`useBimStore.ts:908-910`), the button
  (`Viewport3D.tsx:900-906`), and the shared event both viewports listen to (`:823-829`).
- Pointer capture on mousedown with release on mouseup and a `buttons & 4` safety check
  (`:495-496`, `:672-674`, `:750-758`), so a gesture that ends off-canvas does not latch.
- Section box: six `THREE.Plane`s driven from `sectionBox.min/max` (`:338-386`), toggled by `BX`
  (`useBimStore.ts:899`, `Ribbon.tsx:623-625`).

### Absent or wrong

- **Walkthrough: absent.** Searched `src` and `backend` for `walkthrough` — 0 hits. Revit's
  `ShowMotionEditor` (`revit-editing-interaction-architecture.md:172`) has no analogue.
- **The section box is a fixed hardcoded volume.** `sectionBox: { enabled: false, min: [-2,-2,-0.5],
  max: [14,11,4.0] }` (`useBimStore.ts:676`) — it matches the sample building's extents, not the loaded
  model's. `setSectionBoxBounds` exists (`:1039-1046`) but **no component ever calls it** (a search of
  `src` for `setSectionBoxBounds(` returns only the interface and the definition). So toggling `BX` on
  an imported IFC clips to a 16 × 13 × 4.5 ft box around the origin regardless of the model — and it
  silently shows nothing rather than reporting that the box is elsewhere. Also, clipping planes give no
  **capped** cut surface, so it does not look like a Revit section box.
- **The 3D camera does not follow the active view.** `sphericalRef` is initialised once
  (`Viewport3D.tsx:196-201`) and only ever mutated by navigation and `fitToExtents`. There is no
  orientation preset, no "orient to plan/section", and no `ViewDefinition`-driven camera. `Workspace.tsx`
  holds one `threeD` component for the single `view-3d` panel (`:63-66`), so a second 3D view of a
  different orientation is not constructible.
- **The 2D↔3D link is selection-only.** The two viewports are independent dockview panels
  (`Workspace.tsx:61-87`) that share `useBimStore`, so `selectedGuid` propagates
  (`Viewport3D.tsx:416`, `PlanViewport2D.tsx:582`) — but there is no section-box↔plan linkage, no
  camera↔section-view linkage, and no shared view scale. Revit's equivalent is that a `DBView` owns its
  `Viewer`/camera and its `GRep` while all views regenerate from one document
  (`revit2010-reverse-engineering.md:159-164`). BIMWorks has the shared document (the store) and not
  the shared derivation.

### Change items

- `useBimStore.ts:676` / `toggleSectionBox` (`:1031-1037`): seed section-box bounds from the model bbox
  on load and expose `setSectionBoxBounds` through a drag-handles UI; add capped cut faces.
- Add a walkthrough mode to `Viewport3D` (a camera path with Play, Revit's `ShowMotionEditor` analogue).
- Add orientation presets and let a 3D `ViewDefinition` carry the camera so more than one 3D view can
  exist and be saved.

---

## 10. Annotation and dimensions as document objects

**Verdict: ABSENT.** Revit's annotation is a class of element that lives in the document, has its own
identity, and tracks the element it annotates. BIMWorks has none of that: dimension strings are a
renderer output and tags are string properties on the tagged element.

### Text, dimensions, tags are all disabled stubs

`src/interaction/toolCaptions.ts:38-45` marks `GR, LL, DI, DL, TG, TX, SEC, SHT` as
`implemented: false`, and the Ribbon renders them disabled with a reason
(`Ribbon.tsx:135-136`, `:578-581` for `DI/DL/TG/TX`, `:467-481` for `GR/LL`). `isToolImplemented` is
the single source of truth (`toolCaptions.ts:52-54`). So there is no way to place a dimension, a text
note, or a tag.

### Dimensions are renderer output, not document objects

`_overall_dimensions` (`ifc_service.py:4311-4364`) exists specifically to *avoid* document objects:
*"Dimension strings are a renderer's output, not model data: the same plan at a different scale would
carry the same dimensions, but a renderer that is not dimensioning should not have to suppress them.
This is therefore produced here from the drawing's own extents rather than stored on the elements."*
It emits exactly two dimensions — overall width and overall depth — from the union of all cut and
projection path coordinates (`:4327-4338`), with `guid: None` (`:4344`, `:4357`). Consequences:

- A user cannot create a dimension between two chosen references, cannot delete one, cannot move one,
  cannot override its text.
- The number of dimensions is a function of the renderer, not the drawing: `render_2d_view` gets them
  through `_annotate_view` (`:3981`), and the analytic path builds them per wall with a
  dedup pass (`:3760-3804`, an O(D²) nested scan at `:3787-3797`). So switching renderer changes the
  annotation — which is the opposite of a document.
- `guid: None` means the plan's dimension padlock and EQ affordances
  (`PlanViewport2D.tsx:849-907`) key off `dim.guid` and can never resolve a constraint for these
  (`:783-794`), so the badges render as unlocked/unequalised always. The padlock click path at
  `:855-859` calls `lockDimension(dim.guid, dim.guid, dim.length)`, which with `guid === null` would
  lock a null GUID against itself; `lockDimension` (`useBimStore.ts:1149`) does not guard against it.
  This is a latent defect: the affordance is offered on a dimension that structurally cannot carry a
  constraint.

### Tags: no independent tracking — the exact opposite of Revit's model

The corpus establishes that Revit tags are **picked as references to a host and tracked separately
from the tagged element**: `GRAPHICS.DLL::Pick` carries `getElemId` *and* `getTag`/`getLastTag`
(`revit-editing-interaction-architecture.md:286-288`), and `IndependentTagPickNewHostHandler` is a
command handler that *returns an editor* for re-hosting a tag
(`direct-manipulation-datums-walls-placements.md:243-253`). A Revit tag therefore: has its own element
id, has its own host reference, survives the host's geometry changing, can be moved independently, and
can be re-hosted.

In BIMWorks, `tag` is a plain optional string on `BimElement` (`src/types/bim.ts:30`, `:74`) and is
serialized as an element parameter (`ifc_service.py:3179`, consumed at `useBimStore.ts:1351`). It is a
*property of the tagged element*. There is no tag element, no host reference, no independent
placement, no re-host path, and no tag geometry in the contract (the plan contract's only text drives
are grid labels and dimension strings — `grids[].tag` at `ifc_service.py:4407`, roof
`pitch_text` at `:4469`). Searching `src` for `TG`/tag placement yields only the disabled caption and
the disabled Ribbon button.

### Change items

- Introduce an annotation element class (`{ guid, kind: 'dimension'|'text'|'tag', host_ref, refs, position, text_override }`)
  persisted in the overlay, with the CommandBus types to create/edit/delete it — this is the
  prerequisite for `DI/TX/TG` becoming implementable, and the corpus's
  `IndependentTagPickNewHostHandler::getEditor` shape (`…placements.md:251-253`) is the pattern to copy.
- Keep `_overall_dimensions` as a *view* drive but stop presenting it as the dimension system; give
  document dimensions their own GUIDs so the existing padlock/EQ affordances have something to bind to.
- Guard `lockDimension` / `equalize` against `guid === null` (`PlanViewport2D.tsx:855-859`,
  `useBimStore.ts:1149`) so the disabled case is explicit rather than silently wrong.

---

## 11. Graphics fidelity — vector output, line weights, HLR, and its scaling

**Verdict: PARTIAL.** The HLR is genuinely real — three partitions, computed, not a stub — but it is a
2D-union approximation rather than B-rep hidden-line removal, the frontend discards the lineweight
table it is sent, and the per-edit cost is O(model).

### The HLR is real

`backend/mesh_hlr.py` (533 lines) is not a placeholder. It projects every triangle, sorts meshes
nearest-first, and accumulates the nearer silhouette as an occluder against which each candidate edge
is split into visible (`line.difference(occluder)`, `:442-450`) and hidden (`line.intersection(occluder)`,
`:451-461`) pieces. The cut partition comes from intersecting each triangle with the plane
(`_triangle_plane_segments`, `:326-343`), and openings need no special casing because they are voids in
the wall's triangulation (`:35-37`). I ran the suite: `scratch/test_hlr.py` → **31 passed, 0 failed**,
including *"tall wall is cut"*, *"low wall is projected, not cut"*, *"the default plan renderer is the
in-process geometric HLR"*, and a multi-level section spanning both storeys. `mesh_hlr` is the default
renderer for plans (`ifc_service.py:3568`, `:3590-3594`), so the plan really is drawn from HLR output.

Line weights exist as a real table: `hlr_renderer.py:144-171` defines `cut 0.50 mm solid`,
`projection 0.18 mm solid`, `hidden 0.13 mm dashed`, `below/grid/slab/roof/swing/dimension`, with
`style_for` and `with_overrides` for view templates. `to_contract` stamps every path with its
`{weight_mm, pattern, colour}` and emits the whole table (`mesh_hlr.py:517-530`).

### Fidelity gaps

1. **The frontend ignores the lineweight table.** `PlanViewport2D.tsx:695-711` hardcodes
   `strokeWidth={isSelected ? '2.5' : '1.75'}` for cut paths and `#0f172a`/`#0284c7` for the stroke —
   the `style` object the contract carries (verified present on every path when I dumped the contract)
   is never read anywhere in `src`. Searched `src` for `weight_mm`: **0 hits**. So `lineweights` and
   view-template restyling are engine-side only, and `IMPLEMENTATION-PLAN-2026-10-14.md:369`'s claim
   that lineweights are "MET" is true of the contract and not of the drawing. Hidden lines at least
   use a dashed pattern matching the table's intent (`:737`), but with a hand-picked `0.8` width.
2. **Occlusion is per-mesh union, not surface occlusion.** `_silhouette_edges` takes the union of a
   mesh's projected triangles and uses its boundary rings (`mesh_hlr.py:301-322`), and the occluder is
   the union of those polygons across meshes (`:469-470`). Interior edges of a single mesh are never
   produced, and *self*-occlusion within one mesh is therefore invisible: a U-shaped wall, a wall with a
   deep recess, or any non-convex solid hides nothing behind its own near faces. OCCT's `HLRBRep` (what
   spec §4.1 asked for) works on the B-rep and does produce those edges. The module's own docstring is
   honest about the substitution and why (`:4-24`), and the plan records the reason
   (`IMPLEMENTATION-PLAN-2026-10-14.md:359`).
3. **`to_contract`'s `view_range` argument is dead on the live path.** `mesh_hlr.py:531-532` echoes
   `view_range` only `if view_range` — but the plan caller passes only `lineweights=LineweightTable()`
   (`ifc_service.py:4127`), so the plan contract carries no `view_range` echo. The section/elevation
   path does pass it (`ifc_service.py:3970`). Minor, but it means a consumer cannot tell what range a
   plan was drawn with.

### Complexity — what is O(N), what is O(N²), and which one dominates

I measured the whole view path (`scratch/_probe_slice_only.py`, clean process per size, best of 5):

| walls | `slice_2d_vector_plan` (ms) | ms/wall |
|---|---|---|
| 6 | 3.1 | 0.52 |
| 10 | 6.2 | 0.62 |
| 14 | 10.4 | 0.74 |
| 18 | 14.5 | 0.81 |
| 22 | 21.6 | 0.98 |

**Measured: superlinear in the small range, approaching linear-plus at ~0.9 ms/wall.** The repo's own
measurement puts a viewed-level slice at **904 ms for a 2 000-element model**
(`docs/DELTA-MEASUREMENT.md:48-49`), which my fit reproduces (~1.8 s) to within the model-mix
difference. Two independent measurements agree that **a plan rebuild costs O(model) time per edit**.

The code contains three distinct superlinear terms. From the call path:

**(a) `_prepare` — O(T) shapely work, per view, per edit.** For every triangle of every mesh it builds
a `Polygon`, validity-tests it, and calls `buffer(0)` on invalid ones
(`mesh_hlr.py:124-148`, with the comment recording that real Revit exports contain self-intersecting
profiles). `buffer(0)` is an expensive GEOS repair and `_prepare` is reset to `None` on **every**
`render()` (`:411`), so nothing is cached across edits. Total O(total triangles), and T is the
dominant constant in the measurement above (a 22-wall lattice is 276 triangles).

**(b) The occluder accumulation — the structural O(N²).** For each mesh, in order:
`occluder = self._safe_union([occluder, mesh_union])` (`:470`), after having computed
`line.difference(occluder)` and `line.intersection(occluder)` for that mesh's every boundary ring
(`:442`, `:451`). The occluder is a union that grows monotonically and is never reduced, so the
boolean operations run against an increasingly complex polygon: the k-th mesh's difference/intersection
costs at least O(polygon complexity so far) and the union costs the same again. Summed over N meshes
that is **O(N²) in boolean-operation cost on growing polygons**. In the size range I could measure
(≤22 walls, ≤276 triangles) the polygons stay simple enough that term (a) dominates and the curve
looks near-linear; the 904 ms at 2 000 elements is where (b) becomes visible. **Note the honest
limit:** I measured the aggregate and the code path, not (b) in isolation — I did not run a 2 000-wall
model to completion. The O(N²) claim for (b) is from reading the loop at `:438-470` and is marked here
as **inferred, not measured**; the aggregate curve that it explains is measured.

**(c) `_depth_filter` — fixpoint flood fill, O(N²) worst case.** `while changed:` over `remaining`
scanning `kept` (`mesh_hlr.py:254-265`). Only reachable when `view_depth > 0` (`:193-195`, `:216`), and
the default `viewDepth` is 0 (`useBimStore.ts:648`), which is why my probes did not hit it. Each
element appended can force another full pass, giving O(N²) bbox comparisons in the worst case.

**(d) Analytic fallback only: O(D²) dimension dedup** (`ifc_service.py:3773-3800`, the inner
`for i, existing in enumerate(deduped_dims)` at `:3787`). Not on the default path.

**(e) `_orient_plan` re-serializes every path string through `rotate_path`** (`ifc_service.py:4010-4045`,
called at `:4160`) — O(total coordinates) with a regex `_scale_path` pass before it (`:4128-4130`).

So: **the measured per-edit cost is O(model) with a large constant; two structural O(N²) terms
(occluder accumulation, depth flood fill) are latent and gate the spec's 2 000-element budget.**
Revit's approach is the opposite shape: one shared curve/sketch engine parameterised by family, with a
model↔view transform component (`CurveEdHpr::TrfComputer::compute(const DBView*, Trf*)`,
`uncoupling-the-2d-editor.md:54-62`), so view space carries no model knowledge and nothing re-derives
the model to draw a view. BIMWorks has no such separation: `PlanViewport2D` computes model coordinates
inline (`getModelCoords`, `:249-263`) and re-reads `elements`/`meshes` for annotation geometry
(`alignmentGuide`, `:67-104`).

### Change items

- `PlanViewport2D.tsx:695-757`: consume `path.style.{weight_mm,pattern,colour}` instead of hardcoded
  stroke widths, so the emitted `lineweights` table and any view template actually reach the drawing.
- `mesh_hlr.py:116-164`: cache `_prepare` results per mesh GUID keyed by a mesh revision, and stop
  resetting `_prepared = None` on every `render()` (`:411`).
- `mesh_hlr.py:438-470`: bound the occluder. Practical options: bucket occluders by spatial index
  (`shapely.STRtree`) and test each edge only against the occluders whose bounds intersect it; or
  simplify the accumulated occluder with a tolerance (a drawing does not need sub-millimetre
  accuracy in the occluder); or cap the occluder to the union of the nearest K meshes with an explicit
  documented approximation.
- `mesh_hlr.py:231-266`: replace the flood fill with a single pass against a cut-plane-relative
  distance.
- Emit self-occlusion for a mesh by keeping its internal silhouette edges (dihedral-angle edges) rather
  than only its projected outline boundary, so a non-convex wall hides what is behind its own faces.
- `ifc_service.py:4127`: pass the view range through `to_contract` on the plan path too.

---

## 12. Undo/redo and the interaction contract

**Verdict: PARTIAL.** Three of Revit's four contract behaviours are right, and the fourth is broken by
one missing line.

### Esc cancels a tool — yes, and it is a single path

`handleKeyStroke` handles `Escape` (`useBimStore.ts:844-867`): in a sketch it first clears the selected
line, else cancels the sketch (`:847-853`); otherwise it sets `activeTool: 'select'`, clears
`selectedGuid` and `tempDimension`, resets `alignPickState`, and bumps `interactionResetToken`
(`:855-865`). Both viewports clear their local in-progress state from that token in one effect
(`PlanViewport2D.tsx:279-285`, `Viewport3D.tsx:175-185`), and the comment at `PlanViewport2D.tsx:265-278`
records that this replaced two disagreeing Escape listeners. This is the correct shape: one cancel
path, broadcast, not duplicated per tool. Revit's equivalent is `onAbortEditor` / `cancelDirtyEditor` /
`abortSubEditorsOnHandledCommand` (`revit-editing-interaction-architecture.md:71-79`).

Everything else Esc does is **unverified** against Revit: the corpus does not settle whether Revit's
Esc deselects. The code does deselect (`:857`), and I flag that as an unverified choice rather than a
defect.

### Repeated/modeless placement — yes

Placement tools stay armed. Drawing a wall completes and clears only the two points, not the tool
(`PlanViewport2D.tsx:332-341`; the banner's own text says *"The tool stays armed — Esc to finish."*,
`toolCaptions.ts:60`). The `PLACEMENT_TOOLS` list (`:187`) plus `placementGuidRef` (`:179-186`,
`:200-204`) ensures the click that completes a placement does not also re-select — the same concern
Revit handles with `EssentialsUI::canPlaceMultiple_` and the created-id set
(`EscCuttingEnvironmentUI::canPlaceMultiple_`, and `CreationPlaceHelper::addRequestedId` /
`deletePlaceElements` / `clearArrays` for abort cleanup,
`direct-manipulation-datums-walls-placements.md:174-202`). BIMWorks gets the "place many" half right;
it has no created-id set, so aborting a multi-placement cannot clean up the instances already placed —
which matters once multi-placement is more than one click long.

### Atomic rollback — yes, and tested

`CommandBus.execute_transaction` snapshots before, and on any exception calls
`self.manager.restore_state(pre_state)` and re-raises as `RuntimeError` (`command_bus.py:640-654`);
`run_mutation` unwraps the cause to a 400 with the original validation message
(`main.py:69-73`). `scratch/test_bus_parity_audit.py` covers atomic rollback and clean 400s
(`IMPLEMENTATION-PLAN-2026-10-14.md:228`). This is Revit's transaction model done deliberately, and it
is the strongest part of the interaction contract.

### Undo/redo — commands work, keyboard does not

`undoTransaction` / `redoTransaction` POST and refresh (`useBimStore.ts:2211-2235`) and are wired to
Ribbon buttons (`Ribbon.tsx:179`, `:186`). But:

- **`Ctrl+Z` and `Ctrl+Y` are not bound.** The global keydown handler (`App.tsx:40-64`) handles only
  Ctrl+S (`:42`) and Delete (`:52`, via `handleDeleteKey`). `Ribbon.tsx:58` adds Ctrl+O. A search of
  `src` for `ctrlKey` finds exactly those three. Meanwhile the Undo and Redo buttons advertise
  `"Undo Transaction (Ctrl+Z)"` (`Ribbon.tsx:181`) and `"Redo Transaction (Ctrl+Y)"` (`:188`).
  **Both tooltips claim a binding that does not exist** — an N11-class affordance lie, and the single
  cheapest fix in this audit.
- Undo/redo are snapshot-based (`command_bus.py:670-678` stores `pre_state` and `post_state`), so each
  of the 50-odd retained entries holds two full model states. Combined with the two snapshots per
  transaction (`:642`, `:677`), the memory and time cost are both O(model) per edit and O(model ×
  depth) resident. At 2 000 elements with a deep stack this is the "snapshot/refetch costs" the test's
  own note flags (`scratch/test_dependency_graph.py:265`).
- **The 16 ms budget is claimed on a measurement that is not the user's path.** The P3 exit criterion
  is *"wall-drag p95 measured and logged"* (`IMPLEMENTATION-PLAN-2026-10-14.md:289`) and the logged
  number is **p50 4.12 ms / p95 5.93 ms** (I ran it: `scratch/test_dependency_graph.py` §8 passed
  41/41). But that loop times `m.translate_element(...)` plus `graph.recompute(...)` **on the manager
  object directly** (`scratch/test_dependency_graph.py:246-250`) — it bypasses `CommandBus`, the two
  snapshots, HTTP, `/api/state`, the slice, and the React render. It is a fair measure of the
  dependency-graph recompute, and it is not a measure of a drag the user performs. The honest
  decomposition, from my probes: engine slice 3.1 ms at 6 walls and 21.6 ms at 22 walls, ×2 snapshots,
  ＋ HTTP round trip, while the pre-fix end-to-end figure was p50 36.7 ms
  (`IMPLEMENTATION-PLAN-2026-10-14.md:146`). **The M0 budget is not met on the user-visible path, and
  no measurement in the repo claims otherwise once the paths are separated.** The test's own comment
  says as much (`:257-259`).
- `handleDeleteKey` (`useBimStore.ts:1638-1660`) deletes through the bus and is bound to Delete
  (`App.tsx:52`) — correct, and worth noting because it is the one destructive action that *is*
  keyboard-bound.

### Change items

- `App.tsx:40-64`: bind `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` to `undoTransaction` / `redoTransaction`,
  or remove the tooltip's claim (`Ribbon.tsx:181`). Prefer the former.
- `command_bus.py:642,677`: replace full-state snapshots with an inverse-command journal or
  copy-on-write, which removes two O(model) costs per edit and bounds undo memory.
- `useBimStore.ts:833-837`: carry a created-id set through a multi-placement session so an aborted
  placement deletes what it made (`CreationPlaceHelper::deletePlaceElements`,
  `direct-manipulation-datums-walls-placements.md:196-202`).
- `scratch/test_dependency_graph.py:246-250`: measure the drag through `execute_transaction` +
  `slice_2d_vector_plan` so the logged p95 matches what a user waits for.

---

## Ranked defects worth fixing regardless of feature work

These surfaced while auditing and are cheap, independent, and currently produce wrong output:

1. **`ifc_service.py:3767`** — analytic dimension text labels decimal feet as metres and scales by
   3.28084: `f"{length:.2f} m ({length * 3.28084:.1f}')"`. A 30 ft wall reads `30.00 m (98.4')`.
2. **`Ribbon.tsx:181`, `:188`** — the Undo and Redo tooltips claim `Ctrl+Z` / `Ctrl+Y`, neither of
   which is bound (`App.tsx:40-64`).
3. **`PlanViewport2D.tsx:1274-1297`** — the plan header falls back to a hardcoded
   `'Floor Plan: Level 1'` / `cut: 4.0` for any unresolved active view, so the Roof Plan can be
   labelled as Level 1 with the wrong cut plane.
4. **`PlanViewport2D.tsx:67-104`** — the alignment guide is drawn at the midpoint of the two elements'
   union bounds, not at the constrained coordinate, so a constraint overlay points at the wrong place.
5. **`useBimStore.ts:676`** — the section box defaults to a hardcoded volume around the origin; on any
   imported model `BX` clips to the wrong region and `setSectionBoxBounds` is never called.
6. **`PlanViewport2D.tsx:849-907`** vs **`ifc_service.py:4344`** — dimension padlock/EQ affordances are
   offered on `guid: None` dimensions that cannot carry a constraint, and `lockDimension` does not
   guard the null.

---

## Top 10 changes to make the viewports behave like Revit

Ordered by (behavioural fidelity gained) ÷ (effort). Effort: **S** ≤ 1 day, **M** ≤ 1 week,
**L** > 1 week.

| # | Change | Effort | Files touched |
|---|---|---|---|
| 1 | **Bind keyboard to the interactive contract:** `Ctrl+Z`/`Ctrl+Y` undo/redo, and guarantee Esc cancels every tool from one path (already true) — plus fix the tooltip lie. Instantly makes the app feel like an editor rather than a form. | **S** | `src/App.tsx:40-64`, `src/components/ribbon/Ribbon.tsx:181` |
| 2 | **Expose the finished level-drag path.** `moveLevel` / `LevelMove` is implemented, solver-propagated and tested (`test_dependency_graph.py` §3) but has zero callers. Bind a level drag (properties row + datum drag once #3 lands) and add a level datum to the plan contract. | **S–M** | `src/store/useBimStore.ts:2137`, `backend/ifc_service.py:4366-4487`, `src/components/drafting/PlanViewport2D.tsx` |
| 3 | **Levels and grids as draggable datums.** Add a `levels` drive to the plan contract, render level datums, make grids/levels selectable, and wire dragging to `moveLevel` — Revit's `DatumLinearElemWrapper` + `DatumSnapFilterTmpl` case. | **M** | `backend/ifc_service.py:4366-4487`, `:3567-3901`; `PlanViewport2D.tsx:654-689` |
| 4 | **A typed pick + shape handles + wall-endpoint drag.** Introduce `{guid, tag, kind}` picks, then a move-helper that recognises handle tags and drives the existing `WallTrimExtend`, with joins recomputed in the drag path. This is the §2 headline and it unlocks #5–#7. | **L** | new `src/interaction/pick.ts`, `src/interaction/moveHelper.ts`; `PlanViewport2D.tsx:288-410`, `Viewport3D.tsx:490-666`; `backend/ifc_service.py:2796` |
| 5 | **Real temporary dimensions.** Replace the bbox-centre pill with a reference-based in-canvas dimension using the already-computed `witnessP1`/`witnessP2`, keyed by element id, with one shared typed inline editor (commit/cancel) and editing that moves the referenced face rather than translating the element. | **M** | `src/store/useBimStore.ts:952-1027`, `:1066-1077`; `PlanViewport2D.tsx:1299-1348`; `Viewport3D.tsx:909-953`; new inline-editor component |
| 6 | **A real SnapEngine with alignment guides and a toggle.** Typed snap candidates (endpoint/midpoint/intersection/face/grid), replacing the blanket 0.25 ft quantiser; transient guides scoped to the gesture; fix the alignment-overlay coordinate via a new engine-emitted constraint value. | **M** | new `src/interaction/snapEngine.ts`; `PlanViewport2D.tsx:249-263`, `:67-104`; `Viewport3D.tsx:530-533`; `backend/ifc_service.py:2417` |
| 7 | **Incremental plan regeneration.** Cache `_prepare`, re-project only dirty GUIDs while keeping clean partitions, and bound the occluder with an STRtree or a simplified accumulator — this is what makes a 60 fps drag possible at all (#4 depends on it), and it removes the two O(N²) terms that gate the 2 000-element budget. | **L** | `backend/mesh_hlr.py:116-164`, `:231-266`, `:390-476`; `backend/ifc_service.py:3590-3594`, `:4087-4163`; `backend/command_bus.py:642,677` |
| 8 | **Window vs crossing selection, Ctrl-add, and hover pre-highlight.** A selection *set* in the store, a marquee with Revit's direction semantics, and finally calling the `setHoveredGuid` that is already wired and never fires. | **M** | `src/store/useBimStore.ts:514`, `:1029`; `PlanViewport2D.tsx:288-410`; `Viewport3D.tsx:104-105`, `:668-748` |
| 9 | **True View Range semantics.** Clip to `top`/`bottom` as real z-intervals, measure `view_depth` from the cut plane instead of a nearest-element flood fill, restate the not-cut rule against the cut plane, and stop overloading `viewDepth = 0` as "unset". | **M** | `backend/mesh_hlr.py:166-218`, `:231-266`; `backend/ifc_service.py:4132-4147`, `:3621-3627`; `src/components/modals/ViewRangeModal.tsx` |
| 10 | **Annotation as document objects.** An overlay-persisted annotation class with host references (Revit's independent tag tracked separately from the tagged element), its CommandBus types, and the in-canvas editors to place and edit them — the prerequisite for `DI`/`DL`/`TG`/`TX` to stop being disabled stubs. | **L** | `backend/ifc_service.py` (overlay schema + `_overall_dimensions` refactor), `backend/command_bus.py`, `src/types/bim.ts:138`, `src/interaction/toolCaptions.ts:38-45`, `PlanViewport2D.tsx:773-910` |

**Sequencing note.** #4 (direct manipulation) is the headline fidelity gap and the one Revit behaviour a
user notices within seconds, but it is last in dependency order for a reason: a drag needs picks, and a
*smooth* drag needs #7's incremental regeneration, because the measured per-edit slice cost is
0.9 ms/wall and the drag round trip would otherwise exceed the 16 ms budget above ~15 walls. The
cheapest path to a viewport that *feels* like Revit is therefore #1 → #2 → #3, then #7 before #4.

**One scoping caveat.** The corpus's direct-manipulation evidence is export names and signatures, not
decompiled bodies — Ghidra auto-analysis timed out on those modules
(`direct-manipulation-datums-walls-placements.md:12-13`, `:321-329`). The architectural conclusions
(handles are tagged picks; joins recompute during the drag; Ctrl+drag copies and dimensions) are
therefore well-founded inferences, and drag *feel* — thresholds, snap tolerances, timing — is explicitly
not recoverable from symbols (`:327-329`). Anything in this audit that depends on gesture feel should be
confirmed against live Revit before it is treated as a specification.
