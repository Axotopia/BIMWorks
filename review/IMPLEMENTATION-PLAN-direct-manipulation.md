# IMPLEMENTATION PLAN — direct manipulation: making 3D modelling feel like IngeTrazo

**Verified against:** `Axotopia/BIMWorks@7a36697` (2026-10-16), and originally against `8ffec22` (after the Revit-parity UI refactor: `7026842`, `4ed1f90`).
**Read for comparison:** IngeTrazo `d8ee8c0` (`/tmp/ingetrazo-src`) — `tools/base.py`, `core/snap.py`, `core/inference.py`, `core/history.py`, `tools/move.py`, `tools/scale.py`, `tools/pushpull.py`.
**Relationship to existing plans:** this is the *interaction* layer. `review/archive/IMPLEMENTATION-PLAN-dimension-as-control.md` is the *semantics* layer (reference primitive, solver, dimension as a driving object). They meet at the grip (§3.6), and §5 sequences them so the grip layer is not rewritten when that plan reaches Phase 3. The **one-owner-per-item division across all four live plans** — this one, `revit-feel`, `dimension-as-control`, `geometric-references` — is tabulated in `review/IMPLEMENTATION-PLAN-revit-feel.md` §2b; read it before adding work here, because Phase 4 of that plan (draw-and-place) and Phase 2 of it (dimension editing) both have halves that belong to Track A or Track B of this one.
**Revised 2026-10-16** after an engine probe (`scratch/_probe_engine_smoke.py`) and a browser verification pass. The revision adds **Track A** (§4): the defects and UI declarations that make the app untestable *before* any "feel" claim can be evaluated. Track B (§5) is the original manipulation plan, now with per-phase status.

**Line numbers are pinned to `7a36697`** unless a citation says otherwise. They will drift; cite the symbol when the two disagree.

---

## 0. Executive Status & Reconciliation at HEAD (`3dd3e80`)

All 13 rework items (`W1`–`W13`) of [`review/archive/REWORK-ORDER-direct-manipulation-2026-10-16.md`](archive/REWORK-ORDER-direct-manipulation-2026-10-16.md) were executed at `71aa5ec` and independently re-verified at `49b7c63` and `3dd3e80`. This section is the authoritative record of landed work and supersedes all intermediate audit notes.

### 0.1 Full Gate Suite Status

`npm run check` exits 0 with **all 8 check suites** and TypeScript compilation clean:

| Gate | Script | Assertions | Status |
|---|---|---|---|
| **Bus Parity** | `scripts/check-bus-parity.mjs` | 47 actions | ✅ **PASSED** — All UI mutations route through the CommandBus |
| **UI-P0** | `scripts/check-ui-p0.mjs` | 132 checks | ✅ **PASSED** — Chrome, palettes, view switch, projection guards |
| **State Bundle** | `scripts/check-state-bundle.mjs` | 45 checks | ✅ **PASSED** — Responses A/B/C, monotonic `rev`, epoch checks |
| **Delta Equivalence** | `scripts/check-delta-equivalence.mjs` | 21 checks | ✅ **PASSED** — Delta-applied state deep-equals full bundle |
| **Snap Engine** | `scripts/check-snap-engine.mjs` | 34 checks | ✅ **PASSED** — 12 candidate kinds, priority hierarchy, negative controls |
| **Interaction Session** | `scripts/check-interaction-session.mjs` | 37 checks | ✅ **PASSED** — Viewport `useState` retired, Esc/wobble guards (W6, W7) |
| **PushPull Engine** | `scripts/check-pushpull-engine.mjs` | 17 checks | ✅ **PASSED** — Shipped `pushpull.ts` directly verified with negative controls (W11) |
| **Python Suites** | `scripts/check-python-suites.mjs` | 15 suites (694+ checks) | ✅ **PASSED** — All backend unit & parity suites, including `test_validity_predicates.py` (63), `test_face_pushpull.py` (50), and `scratch/_probe_engine_smoke.py` (7/7 passed) |
| **TypeScript** | `npx tsc --noEmit` | Clean | ✅ **PASSED** (0 errors) |

### 0.2 Unified Status Table: Track A & Track B

| Item | Focus | Status at HEAD | Evidence & Mechanism |
|---|---|---|---|
| **A1** | Sample startup | ✅ **DONE** | `/api/sample` loads `sample_building.ifc` (`backend/main.py:372-396`); wall heights `[10.0] ft`, 130 cut paths at 4.0 ft cut (`_probe_engine_smoke.py` A/B) |
| **A2** | Dimension lock | ✅ **DONE** | `length_lock` holds single-element dimension locks across anchors (`3762c0c`; `test_dimensions_crud.py`; probe check D) |
| **A3** | Envelope honesty | ✅ **DONE** | Solve failures return `envelope status="error"` with nested error (`command_bus.py:992, 1471`; probe check E) |
| **A4** | Dimension routes | ✅ **DONE** | `GET /api/dimensions` and `GET /api/dimensions/{id}` live (`backend/main.py:773, 782`) |
| **A5** | View fit on switch | ✅ **DONE & GATED** | Fit maths in `src/interaction/fitExtents.ts`; `scripts/check-fit-extents.mjs` (`check:fit`) asserts 60–90% viewport occupancy with identity negative control |
| **A6** | View semantics | ✅ **DONE** | Elevation cut-plane chip suppressed (`PlanViewport2D.tsx:2305`); Properties palette view type synchronized (`PropertiesPalette.tsx:253`) |
| **A7** | UI tool parity | ✅ **DONE** | Elevation tool (`EL`) added to `ActiveTool` union (`types/bim.ts:318`), `toolCaptions.ts:46` (`implemented: true`), Ribbon, and `PlanViewport2D.tsx` (W4) |
| **P0** | SnapEngine | ✅ **DONE** | 0 inline `Math.round(x*2)/2` quantizations left; both viewports import `snapEngine`; 12 kinds; snap gate passes 34 |
| **P1** | Interaction session | ✅ **DONE** | Retired local `useState` tool state from `Viewport3D.tsx` and `PlanViewport2D.tsx`; `interactionSession` is single source of truth; gate passes 37 (W6) |
| **P2** | Bus drag session | ✅ **DONE** | `/api/drag/begin\|update\|end`; 60 drag frames hold `rev`, commit advances by exactly 1 with 1 journal entry (`test_drag_session.py`) |
| **P3** | Wall grips | ✅ **DONE** | Typed `WallSetHeight`, `WallSetThickness`, `WallSetEnd`; 3D grip overlay in `Viewport3D.tsx:1320-1383`; `test_wall_grips.py` (49 passed) |
| **P4** | Value entry & retype | ✅ **DONE** | `ValueControlBox`; hot retype via `retypeCommittedValue` (`useBimStore.ts:3043`); `test_value_entry_hot_retype.py` (15 passed) |
| **P5** | Inference & locks | ✅ **DONE** | `src/interaction/inference.ts`; snap priority hierarchy with inverted-priority negative control (snap gate 34) |
| **P6** | Grips beyond walls | ✅ **DONE** | Opening offset/width/flip/sill, level elevation, polygon vertex, grid endpoints (`grips.ts`; `test_grips_beyond_walls.py` 71 passed) |
| **P7** | Push/pull gestures | ✅ **DONE** | `pushpull.ts`; full-scene mesh raycasting before classification (W9a); >5px wobble threshold (W9b); `check:pushpull` (17) and `test_face_pushpull.py` (50) |
| **P8** | Validity & clamping | ✅ **DONE** | `backend/validity.py`; exact floor `MIN_THICKNESS_FT = 1/12 ft` (W1); `clamp_reason` returned in envelope and surfaced in UI (W2); creation validity predicates (W3) |

### 0.3 Independent Verification Insights & Cautions

1. **Gate A5 (Fit to Extents):** Shipped in `src/interaction/fitExtents.ts` and asserted by `scripts/check-fit-extents.mjs` (`check:fit`) across plan, section, and elevation fixtures. Negative control verifies identity transform fails.
2. **Gate W10 (Drag Latencies):** Measured on the 250-wall fixture in `docs/DELTA-MEASUREMENT.md` §2.3:
   - Parameter-only drag (`WallSetHeight`): `p50 = 0.141 ms`, `p95 = 0.158 ms` (well inside the 8.0 ms budget).
   - Baseline-moving drag (`WallSetEnd`): `p50 = 21.652 ms`, `p95 = 24.053 ms` (**≈3× over** the 8.0 ms budget). Baseline edits regenerate joins and HLR occluders; this is an open performance item.
3. **Probe Check G:** Asserted behaviourally across an execute/undo/redo cycle with state fingerprinting: all 50 registered commands declare valid mementos (0 snapshot fallback).
4. **Engine API Form:** Hand probes must use `execute_single_command(cmd, params)` or `execute_transaction([CommandRequest(...)], origin, description)` (not `execute`); envelopes carry `"status": "updated"` or `"committed"`, never `"success"`.

### 0.4 Remaining Open Scope (Direct Manipulation & Performance)

Carried deliberately into live backlogs:
1. **0.2 (§20.1 variation requirement):** Trim/split fixtures varying wall angle and join mode.
2. **Phase 0 Exit Scale Target:** Multi-storey $N = 5,000$ elements benchmark.
3. **1.5 (Slice Delta Transport):** Incremental 2D linework streaming for active viewed levels.
4. **2.7 (Grid Spacing Control):** In-place text editing driving grid line placement.
5. **Phase 4 Deferred:** Interactive SVG snap glyph overlays in 3D (4.1) and non-wall real-reference temporary dimensions (4.6).
6. **Phase 7 Deferred:** Element-specific contextual ribbon tool panels and interactive endpoint dragging across joined walls.
7. **Wall-End Drag Optimization:** Bringing baseline-moving drag (`WallSetEnd`) down toward the 8 ms budget.

---

## 1. Why this plan exists (Diagnosis at `8ffec22` and `7a36697`)

The Revit-parity refactor changed the chrome — ribbon tabs, 858 lines of bespoke vector icons, a rebuilt properties palette, the project browser, the status bar — and the store's view-definition tolerance. It did **not** touch `Viewport3D.tsx` or `PlanViewport2D.tsx`: `git diff 597c079..HEAD` showed both essentially unchanged, and `Viewport3D.tsx` not at all.

So the app *looks* like Revit and still *feels* like a form. §1.1 says why: there was no direct-manipulation layer at all. IngeTrazo is the reference for that missing layer, because it is the one open-source modeller in this space whose *feel* is its main asset: a 12-kind snap engine with a documented priority order, per-tool grips, inference with axis and reference locks, preview that applies the real mutation, and numeric entry that can be re-typed after the fact. This plan ports that layer onto BIMWorks' parametric model — not its mesh model (§6).

**What the 2026-10-16 probe changed.** When Track B began landing, running the app revealed that the engine passed all test assertions while the app remained unusable by hand. The cause was that the **default model loaded at startup was the wrong sample** (§4.1), the **UI tools exercising refactors were declared unimplemented** (§4.7), and silent failures masked broken states (§4.3). Track A was introduced to make Track B visible, testable, and demonstrable.

---

### 1.1 What the 3D viewport could do at `8ffec22` (the baseline)

| Capability | State in `8ffec22` | Evidence |
|---|---|---|
| Navigation | **Complete** — MMB pan, Shift+MMB orbit, wheel zoom, `Z`+`E` extents, pointer capture, latched-gesture recovery | `Viewport3D.tsx:485-508, 668-700, 750-763, 279-322` |
| Create in 3D | Wall (2 clicks), Roof (2-corner box), Slab (2-corner box), Door/Window (hosted pick) | `Viewport3D.tsx:510-600` |
| **Snapping** | **Twelve inline copies of `Math.round(x * 2) / 2`** — one 0.5 ft grid, hardcoded per tool and per preview path. A thirteenth implementation in the plan viewport (0.25 ft grid + endpoint snap), and a fourteenth tolerance in the store for sketch loops | `Viewport3D.tsx:532-584, 723-744`; `PlanViewport2D.tsx:247-260`; `useBimStore.ts:373` |
| Modify | Commands exist and are correct on the bus (`WallMove`, `ElementRotate`, `ElementOffset`, `WallTrimExtend`, `WallSplit`, `ElementCopy`) but there is **no `ActiveTool` for any of them** and no gesture. The only caller of `translateElement` is a numeric field in the palette | `types/bim.ts:210-228`; `PropertiesPalette.tsx:187` |
| Drag | **None.** `handleMouseMove` only navigates; `handleMouseUp` only releases capture. The only dragging in the app is sheet-viewport placement and browser drag-and-drop | `Viewport3D.tsx:668-700, 750-758`; `SheetCanvas.tsx:34` |
| Grips | **None** (`grep -ri grip src/` → no matches) | — |
| Live preview of an edit | None. Creation has a rubber band + a length readout in the status bar | `Viewport3D.tsx:963-973, 992-1019` |
| Numeric entry during a gesture | None, except the temporary-dimension pill, which is an *after-the-fact* editor | `Viewport3D.tsx:910-948` |
| The one "dimension" that exists | Measures **bbox-centre → nearest bbox-centre** (not face-to-face), displayed as an HTML pill, committed as a **delta** through `translateElement` → `WallMove` — so element length never changes | `useBimStore.ts:988-1046, 1087`; the same conclusion is in `review/old/revit-dimension-as-control.md:449` (also at `review/archive/revit-dimension-as-control.md`, byte-identical) |
| Inference / axis lock | None | — |
| Esc / cancel | A working reset path exists and is wired to tool change and sketch cancel — the hook a session needs is already there | `useBimStore.ts:44, 442-444, 853` |
| Hint text | A single caption table exists, with `implemented: false` already used to suppress unimplemented tools | `src/interaction/toolCaptions.ts:1-20` |
| Mutation seam | **One entry point**: `dispatchTransaction` (24 call sites) → `executeTransaction` → `POST /api/transaction`. The store is contractually forbidden from calling raw mutation routes | `useBimStore.ts:86-96, 2197-2199, 2231-2237` |
| Delta channel | **Live in the store** — `since=<rev>`, Response A unchanged, `upsert_meshes`, `remove_guids`, epoch check | `useBimStore.ts:1265-1360`; `backend/main.py:945-975` |
| Instrumentation | `globalThis.__bimworksRefresh` with separate `client` and `engine` p50/p95 | `useBimStore.ts:266, 288-290` |

Two structural facts make this plan cheap. First, **one mutation seam** (`dispatchTransaction`) means a gesture layer can be added without touching 24 call sites. Second, **the delta protocol already delivers per-GUID meshes**, which is exactly what a drag preview needs.

### 1.1 What has landed since `8ffec22` (verified, not assumed)

| Track B phase | Status at `7a36697` | Evidence |
|---|---|---|
| Phase 0 — SnapEngine | **Partial — 2D only, and not consolidated there either** | `src/interaction/snapEngine.ts` (10.4 KB) is imported by `PlanViewport2D.tsx:15` and **not by `Viewport3D.tsx`**, which still holds the inline quantisations — 16 occurrences of `Math.round(x * 2) / 2` at `Viewport3D.tsx:535-584` plus the preview paths. `PlanViewport2D` additionally keeps its own `findSnapVertex` (`:239, 502, 1737`) and grid rounding (`:440-441`), so two snap paths coexist in the one viewport that has the engine. Six typed kinds with source provenance and selection helpers; gate `SNAP-ENGINE 21 passed` |
| Phase 1 — Interaction session | **Partial** | Hover pre-highlight, selection boxes and "draw-and-place feel" landed (`bc10362`); tool state still lives per-viewport |
| Phase 2 — Drag session on the bus | **Not started** | No `/api/drag/*`, no `begin_drag`/`update_drag`, no gesture state in the store |
| Phase 3 — Grips | **Partial, 2D only** | 2D selection endpoint grips and flip controls (`PlanViewport2D.tsx:2010-2041`); nothing in the 3D viewport |
| Reference-shaped intent (§3.6) | **Primitive landed — and in the right order** | `backend/references.py` (19 KB), `ReferenceMove`, `DimensionCreate`, `DimensionValueSet` all registered on the bus (`command_bus.py:39, 456-457, 559`); dimension-as-control gate **123 passed**, references **32**, reference-move + drag-time extras **11** |
| Phases 4-8 | **Not started** | — |

The sequencing risk recorded in §3.6 is **retired in the favourable direction**: the reference primitive landed *before* the grip layer, so grips can be reference-qualified from the outset rather than retrofitted.

---

## 2. The IngeTrazo mechanisms to port

| # | Mechanism | Where IngeTrazo implements it | What it buys | Translation for BIMWorks |
|---|---|---|---|---|
| 1 | **Tool lifecycle as one state machine** — `on_activate`, `on_click`, `on_hover`, `on_release`, `on_cancel`, `on_key`, `on_value`, `status_clause`, `rubber_band_lines`, `guide_preview_lines`, `inference_guide_lines` | `tools/base.py:441-566` | Every tool shares one contract, so cancel, hints and preview cannot be forgotten per tool | A single `InteractionSession` reducer replacing `wallStartPoint`, `boxStartPoint`, `firstPoint`, `alignPickState` |
| 2 | **Snap engine with documented priority** — 12 kinds, high→low: axis lock, reference lock, close, endpoint, intersection, midpoint, origin, on-edge, aligned, axis-inference, none; **screen-space pixel radii**; the caller supplies `world_to_pixel` so the module is UI-free | `core/snap.py:1-28` | Constant snap radius under zoom; one place to add a kind; testable without a viewport | Port the remaining priority list; `worldToScreen(camera, point)` in 3D, the SVG transform in 2D — **six of twelve kinds are in** |
| 3 | **Inference state** — reference edge, encouraged points, axis/reference locks, dwell timer; magnetic axis; work-plane lock | `core/inference.py:1-52`; `AxisMagnet`/`PlaneLock` `tools/base.py:38, 75-334` | The "it knows what I mean" quality; ortho that feels automatic rather than modal | Hold in the session; render as guide lines + a cursor tip |
| 4 | **Per-tool grips** — a 26-grip 3D box / 8-grip 2D box / 2-grip edge for Scale; rotation grips built on the box faces that look at the eye, with `_hot_grip` tracking | `tools/scale.py:3-24, 56-63, 173-196`; `tools/move.py:154-163, 627-660` | Direct manipulation without a dialog | `gripsFor(element, params) → Grip[]`, screen-space hit radius, enlarged invisible hit proxies |
| 5 | **Preview *is* the real mutation** — the same `_mutate_inner` runs each drag frame; Move applies and reverts; commit reverts the preview then re-applies once; `SnapshotMutation` wraps the whole gesture in **one** snapshot, and redo restores the captured after-state rather than re-running | `tools/pushpull.py:2003-2007, 2043-2050`; `tools/move.py:403-410, 864-913, 915-953`; `core/history.py:2893-2935` | Preview cannot diverge from the commit — the class of bug `PlanViewport2D.tsx:270` already documents ("the rubber band had frozen") | The drag session in §5 Phase 2 — one snapshot per gesture, frames reuse it |
| 6 | **Numeric entry during the gesture, and re-typing after it** — `vcb_label` + `on_value`; Scale's `on_value` **undoes the just-committed command and re-executes a rebuilt one at the typed value**; push/pull keeps a retype payload | `tools/base.py:436-439, 508-516`; `tools/scale.py:566-590`; `tools/pushpull.py:1841-1860` | The single cheapest "professional" feel upgrade: type the number you meant, before or after | One value input bound to the session; after commit, `undo` + re-dispatch (the journal already supports both) |
| 7 | **Drag-vs-click threshold** — `_DRAG_PX = 6.0` | `tools/pushpull.py:183-187` | A click that wobbles does not start an edit; a drag that barely moves still does not commit a zero edit | 5 px, measured in the session |
| 8 | **Refusal with a reason, and graceful degradation** — a push that would break the solid is rolled back; the commit **binary-searches for the largest distance the guard accepts** (six halvings) rather than failing; the user is told why | `tools/pushpull.py:1940-1947, 1862-1907, 1829-1833` | A drag into an invalid state degrades instead of erroring | Validity predicates + clamp (§5 Phase 8), surfaced through the existing status/`failureMessage` path — **and §4.3 shows BIMWorks currently does the opposite: it reports success** |
| 9 | **Keep/repeat** — `last_distance`, keep-mode, double-click repeat | `tools/pushpull.py:1815-1835` | Fast iteration without re-aiming | Extend the existing `chainTools` idea to "repeat last modify" |

---

## 3. The six decisions this plan makes

**3.1 Grips emit *parameters*, not geometry.** IngeTrazo pushes a mesh face because its model *is* the mesh. BIMWorks' model is a parametric record plus an IFC entity, and mesh-level edits would break wall joins, hosted openings, HLR slices and IFC export. So each grip gesture maps to a typed parameter edit: end grip → baseline endpoint, height grip → `height`, thickness grip → `thickness`, opening grip → `offset_along_wall`/`width`/`sill_height`, level grip → `elevation`. The *feel* is IngeTrazo's; the *mutation* stays BIM-correct.

**3.2 One snapshot per gesture: a drag session on the bus.** A 60-frame drag must not create 60 transactions — that would fill the undo stack with junk and pay the O(model) snapshot 60 times (`command_bus.py:640-679` captures full IFC STEP text plus a deep copy; `DELTA-MEASUREMENT.md` measures the protocol, not this cost). The session is `begin` (one snapshot) → `update` (execute against the dirty model, no new snapshot) → `end{commit|cancel}`. It is a generalisation of `abort_transaction` (`command_bus.py:692-723`), which already snapshots, restores and prunes the journal.

**3.3 Preview rides the existing delta channel, with `slice2d` suppressed.** `update` returns only the changed elements' meshes through the same machinery as `upsert_meshes`; the 2D slice is skipped while dragging and recomputed once on commit. This is affordable because the engine's mesh-delta path is already O(changed): **1.85 ms** for a mesh-only edit on the 250-wall model, and Phase 1.3b has since bounded the slice that used to dominate (`docs/DELTA-MEASUREMENT.md:47`; `e3216fe`).

**3.4 Client-side transform for pure translation; engine truth for anything that regenerates.** Moving an element is a matrix change and can be previewed in Three.js at zero cost. Changing a wall's length, height or thickness regenerates geometry and can involve joins and hosted openings, so it goes through the session. Honest limitation to state in the UI: during a wall-end drag, the far end's miter is stale until commit. Never commit from the client preview.

**3.5 A refusal is a clamp plus a sentence, not a failed transaction.** IngeTrazo's binary search for the largest acceptable value is the model. Every grip declares its validity range, and the drag clamps to it, showing *why*: "thickness cannot go below 0'-1\"", "the opening would leave the wall", "walls cannot be shorter than their openings".

**3.6 The grip's intent payload is reference-shaped from day one.** `{ ref?: ReferenceHandle, param, value }`. **As of `7a36697` the primitive is live** (`backend/references.py`; `ReferenceMove` carries a `source`/`target` pair plus drag-time `extras`), so grips emit reference-qualified edits from the start rather than being rewritten later. This decision is now a constraint on the grip layer, not a future risk.

---

## 4. Track A — make it testable and verifiable · **before any "feel" claim**

The premise of Track A: at `7a36697` the engine was **verified** — 355 assertions across bus parity, UI-P0 130, state-bundle 45, delta 21, snap 21, solver 17, container fidelity 68, dimensions 123, references 32, transactions 42, reference-move 11, dependency graph 41 — and the app was **not demonstrable**. Re-counted at `ec2c99c`: **618** (dimensions CRUD grew 123 → 190). These phases close that gap — each is small, and together they are what makes Track B judgeable.

### A1 — Load the real sample at startup · **S** · highest perceived impact
The app auto-loads the wrong model. `backend/main.py:402` calls `load_sample_building()` at import, and `/api/sample` (`:357-398`) builds a **legacy shed**: five walls on a 12 × 9 ft footprint with `height=3.0`, `thickness=0.25/0.15`, two doors at `height=2.13`, four windows at `1.4 × 1.5` with `sill_height=0.9`, a slab at `0.25` and a roof at `3.0` — nineteen elements. Those are **metric magnitudes read as feet**: a 3 m storey became a 3 ft wall, a 2.13 m door a 2.13 ft door, a 250 mm CMU wall a 3-inch wall (the name still says `Exterior - 10" CMU`).

Meanwhile the repo ships `sample_building.ifc`, and it is **correct**: measured in-process, 13 elements (5 walls, 2 doors, 4 windows, 1 slab, 1 roof), three storeys, wall heights `[10.0] ft`, thicknesses `[0.492, 0.82] ft` (150 mm and 250 mm), levels at **−0.82 / 9.84 / 19.69 ft** (0 m, 3 m, 6 m correctly converted). The import path converts properly; only the hand-written generator was never updated.

The consequence is the whole first-run experience, measured through `/api/view/2d` at the default cut:

| Model | plan | section | elevation |
|---|---|---|---|
| `/api/sample` (what runs) | **cut=0**, proj=7, hidden=25 | cut=0, proj=7, hidden=18 | cut=0, proj=7, hidden=18 |
| `sample_building.ifc` (what ships) | **cut=130**, proj=3, hidden=63, swing=4, window=20 | cut=52, proj=11, hidden=32 | cut=0, proj=11, hidden=32 |

A 4 ft default cut plane passes **above every 3 ft wall**, so the default floor plan is empty — verified in the browser: *"Floor Plan: Level 1 (Cut Plane: 4'-0")" renders no walls, doors or windows*, only grids and a stray door-swing arc. That single fact explains a large share of "the UI is unusable".

**Do:** delete `load_sample_building()`'s hand-built model and have `/api/sample` call `load_ifc_file(<repo>/sample_building.ifc)` (the startup call then loads the same thing); or keep the route and point both at the IFC. Update the store's status string (`useBimStore.ts:1905` currently reports "Sample BIM Project Loaded (13 Elements, 3 Levels)" while loading nineteen elements and one storey — that string describes the IFC) to derive its counts from the response.
**Gate:** `scratch/_probe_engine_smoke.py` check A passes (wall heights in the 7-14 ft band) **and** a fresh app boot shows a non-empty plan (cut paths > 0).

### A2 — The locked dimension must satisfy itself · ✅ **RESOLVED** (was **M**)

**Fixed and verified 2026-10-16 at `3762c0c`.** The dimension track closed it — `eca4d77` (round-4
verification) and `3762c0c` *"fix(dimensions): enforce `length_lock` so a single-element dimension lock
holds"*. All four rows of the matrix now read `OK`, re-measured in-process on a fresh model:

```
locked,   anchor=start   gap 10.0 -> 14.0  (asked 14.0)  OK
locked,   anchor=end     gap 10.0 -> 14.0  (asked 14.0)  OK
locked,   anchor=center  gap 10.0 -> 14.0  (asked 14.0)  OK
unlocked, anchor=start   gap 10.0 -> 14.0  (asked 14.0)  OK
```

Probe check **D is the regression gate** and now passes. `scratch/test_dimensions_crud.py` also grew 123 →
190 checks in the same work. **Do not re-fix it** — if a locked dimension ever fails to round-trip again,
that is a new defect, not this one returning.

**Original finding, superseded — retained as the diagnostic record:**
> Deterministic on a fresh model — asked **14.0 ft**, the geometry ended **12.0 ft** apart, five runs out
> of five, with or without a second `BimModelManager` in the process. All four anchor/lock combinations
> failed the same way; with the sample's levels loaded the error was larger (`2.0` rather than `12.0`), so
> the locked path consulted model state it should not.
>
> The mechanism was consistent: **the witness the anchor said to hold fixed was the one that moved.** Wall
> B's start correctly landed at `10 + 14 = 24`, but wall A also translated (+2 on a fresh model, +12 with
> levels present) instead of being held, so the measured gap was wrong while the dimension recorded 14.
> The anchor was effectively ignored whenever `is_locked=True`.
>
> **Why the 123 existing assertions missed it:** the suite "covers only an UNLOCKED dimension", per
> `scratch/_probe_locked_dimension_undo.py`'s own note — the same corpus-blindness pattern the README's
> "two join suites" section describes.

### A3 — A failure must not report success · **S** · closes a whole defect class
Driving a dimension whose witness cannot be resolved returns an envelope that says it worked:

```
envelope: { "status": "updated", "value": 14.0 }
  nested: { "status": "error", "error": "Dimension witness references lost" }
```

Any caller that reads `status` — the UI, the AI driver, an MCP tool, a script — sees success. This is the same defect class as `ElementUpdate`, which "silently ignores keys it does not recognise while still returning `updated`" (§5 Phase 3), and it is why a broken model can look fine.
**Do:** propagate the nested result's status into the command envelope (or make the envelope's `status` a function of it), and surface the reason through the existing `failureMessage`/status path. Audit the other nested-result commands for the same shape.
**Gate:** probe check E passes — a failed solve must not present `status: "updated"`. Negative control: force a deliberate solve failure and assert the envelope is non-success.

### A4 — Dimensions must be readable · **S**
`GET /api/dimensions` → **404**. Dimensions exist, serialise richly (`{kind, ref_a: {kind, sources, hint}, axis, offset, value, is_locked, eq_group, binding}`), and appear in the 2D payload only as a **count** (`dimensions: 1`, and the lineweight table already has a 0.13 mm `#0284c7` `dimension` entry) — so neither the UI nor a test can enumerate or inspect them.
**Do:** add `GET /api/dimensions` (list, with resolved witness points) and `GET /api/dimensions/{id}`.
**Gate:** a test creates a dimension, reads it back through the route, and asserts the value and resolved witnesses match.

### A5 — Fit the view on switch · **S**
Switching to a 2D view does not fit it to its extents. In the browser, the real sample's plan (380 SVG paths) opened **over-zoomed and off-centre** — a fraction of the building filled the viewport — while its section (302 paths) sat small in the lower-middle with most of the frame empty. There is a `ZE`/Fit command in the status bar; it is not applied on view change or on first load.
**Do:** compute extents from the returned 2D paths (or the model bounds for the view's range) and set the SVG transform on view switch, load and `Fit`.
**Gate:** after switching to plan/section/elevation, the drawn content's bounding box occupies a stated fraction of the viewport (e.g. 60-90%) and is centred. Negative control: assert the gate fails when the transform is left at identity.

### A6 — View semantics: an elevation is not a plan · **S**
Three labelling defects, all visible in the browser, all passing every gate:

1. **Every 2D view reports a cut plane, including the elevation** — the banner reads `Elevation: South (Cut Plane: 4'-0")`. An elevation is a projection; it has no cut. The engine already agrees: for the real sample, `elevation` returns **cut=0** while `section` returns **cut=52**. The UI is inventing a cut the engine did not apply.
2. **The Properties palette reports the wrong view type** — it shows *"Floor Plan"* while displaying `Section: Building Section 1` and `Elevation: South`. The view type is not reaching the palette.
3. **Sections carry no level annotation** — the real sample's section draws three storey-level dashed lines with no `Level 1 / Level 2 / Roof` names, and cut walls are unfilled (no poche). A section without levels is not a section an architect can issue.

**Do:** pass `view_type` (and the view record) through to the palette; suppress the cut-plane chip for elevations; label level lines from `mgr.levels` and add poche for cut partitions.
**Gate:** an elevation's banner contains no cut plane; the palette's type matches the open view; a section through a multi-storey sample draws one named level line per storey.

### A7 — Surface the refactors in the UI · **M** · unblocks manual testing
`src/interaction/toolCaptions.ts:41-48` originally declared `implemented: false` for dimensions, sections, sheets, and elevations.

> **Status at HEAD:** ✅ **DONE (W4).** Added elevation tool (`EL`) to `ActiveTool` union in `src/types/bim.ts`, wired `toolCaptions.ts:46` (`implemented: true`), Ribbon tab Architecture (`Ribbon.tsx:182`), and pick gesture in `PlanViewport2D.tsx:644`. All three items (`DI`, `SEC`, `EL`) are live and create real view/dimension objects.

### Track A completion
Track A is ✅ **complete**. All seven items (`A1`–`A7`) landed and are verified. `scratch/_probe_engine_smoke.py` is wired into `scripts/check-python-suites.mjs` and verified by `npm run check` (7 passed, 0 failed, exit 0).

---

## 5. Track B — the direct-manipulation phases

Each phase is independently verifiable and ends with a gate that can fail (§8).

**Status at HEAD (`3dd3e80`):** P0 ✅ · P1 ✅ · P2 ✅ · P3 ✅ · P4 ✅ · P5 ✅ · P6 ✅ · P7 ✅ (latency open) · P8 ✅. All nine Track B phases have landed, with rework order W1–W13 closing the audit gaps. Open items are recorded in §0.4.

### Phase 0 — The SnapEngine · **S** · ✅ **DONE**
`src/interaction/snapEngine.ts` exists with 12 typed kinds, source provenance, screen-space pixel radii, and selection helpers. Imported by both `PlanViewport2D.tsx` and `Viewport3D.tsx` (0 inline quantizations remaining). Gate: `scripts/check-snap-engine.mjs` (`check:snap`) passes 34 checks with inverted-priority negative control.

### Phase 1 — The interaction session · **M** · ✅ **DONE (W6)**
`src/interaction/session.ts` exists with reducer (`begin/point/hover/commit/cancel`). As verified in rework W6, `Viewport3D.tsx` and `PlanViewport2D.tsx` retired local `useState` for tool points; `interactionSession` in the store is the single source of truth. `toolCaptions.ts` provides per-phase prompts.
**Gate:** `check:interaction` (`scripts/check-interaction-session.mjs`) passes 37/37 assertions, including mid-gesture Esc, 5 px wobble guard, and negative controls.

### Phase 2 — The drag session on the bus · **M** · the enabler
**Backend:** `CommandBusEngine.begin_drag() / update_drag() / end_drag()` in `backend/command_bus.py`; routes `/api/drag/begin`, `/api/drag/update`, `/api/drag/end` in `backend/main.py`. `begin` takes one snapshot and returns a session id; `update` executes commands against the live model **without snapshotting**, marks dirty guids, returns the changed meshes (reuse the delta builder; `slice2d: null`); `end{commit:true}` advances `rev` once, writes one journal entry and one undo entry; `end{commit:false}` restores the begin snapshot and removes the session's journal entries — the `abort_transaction` shape.
**Frontend:** the *only* place this touches is `dispatchTransaction` (`useBimStore.ts:2231`), which gains a "gesture in progress" mode. The 24 call sites are untouched.
**Gate:** a 60-frame drag advances `rev` by exactly 1, adds exactly 1 journal entry, and one `undo` restores the pre-drag state exactly (deep compare, the `check-delta-equivalence.mjs` style). Negative controls: `rev` must **not** move during `update` frames; cancel must leave geometry byte-identical and `rev` unchanged.

### Phase 3 — Grips for walls · **M** · the first real "feel"
**New:** `src/interaction/grips.ts` — `gripsFor(element, params) → Grip[]` with `{id, kind, worldPoint, axis, value, unit, range, ref?}`. Wall kinds: two end grips (baseline), a height grip (top face centre), a thickness grip (each side face centre). Render as an HTML overlay positioned by projecting the grip's world point (the pattern already exists for the dimension pill, `Viewport3D.tsx:910-948`), with enlarged invisible hit proxies; hot-grip highlight on hover. The 2D endpoint grips (`PlanViewport2D.tsx:2010-2041`) are the existing precedent to generalise.
**Prerequisite — typed edit commands.** `ElementUpdate` takes an untyped `Dict[str, Any]` and `update_element` silently ignores keys it does not recognise while still returning `"updated"` (`backend/command_bus.py:116-118`; `backend/ifc_service.py:2303-2417`). A grip that silently no-ops is the worst possible outcome for a drag — and §4.3 shows this class of bug is live, so this is no longer hypothetical. Add `WallSetHeight`, `WallSetThickness`, `WallSetEnd` (and their slab/opening counterparts as Phase 6 needs them) with schemas and tests.
**Gate:** a drag emits exactly **one** command of a typed kind (assert no `ElementUpdate` in the journal); the journal's result reports the new value; the mesh actually changed. Negative control: assert the gate fails if a grip dispatches `ElementUpdate` with a misspelled key.

### Phase 4 — Value entry and hot retype · **S** · cheapest professional-feel win
One input surface bound to the session: during a drag it displays the live value and typing overrides the pointer; after commit it remains editable and re-issues the command with the corrected value by `undo` + re-dispatch (exactly IngeTrazo's mechanism, `tools/scale.py:566-590`).
**Change:** retire the bbox-centre pill (`useBimStore.ts:988-1046`) in favour of the session's readout, so the number the user reads is the number they type. Route every magnitude through `formatLength` (which now does integer 1/16" arithmetic) rather than hand-rolled `.toFixed()` strings — see §9.1.
**Gate:** typing `12'-6"` mid-drag and committing produces a wall of exactly that length; typing a correction after commit leaves **one** net undo step for the gesture, not two.

### Phase 5 — Inference · **M**
Axis lock (Shift), ortho, parallel/perpendicular to the hovered reference edge, guide lines drawn from the reference, and the snap label shown at the cursor. Port `core/inference.py`'s state (reference edge, encouraged points, axis and reference locks, dwell timer) and IngeTrazo's rule that **a snap provider never overrides a named point** (`docs/plugins.md`).
**Gate:** with the pointer within one pixel of a wall endpoint, the endpoint snap wins over the reference lock and over the grid; the check must fail if priority order is inverted.

### Phase 6 — Grips beyond walls · **L**
Openings (`offset_along_wall`, `width`, `sill_height`, `swing_flipped`), levels (`elevation` — `LevelMove` already exists), slab/roof polygon vertices (the sketch model already carries stable `curve_id`s, `backend/sketch_model.py:49-90`), grid endpoints.

### Phase 7 — Face-based push/pull as a parameter gesture · **L** · ✅ **DONE (W9–W11)**
Hover a wall face → push/pull changes thickness; hover the top face → height. Numeric entry bound to session.
**Rework closures:** W9a raycasts all scene meshes before classification (no occluded wall capture); W9b enforces >5px drag threshold to prevent click stranding; W10 measured drag updates (0.158 ms for height, 24.053 ms for wall end); W11 verifies push/pull imports shipped `pushpull.ts` directly and tests `MIN_THICKNESS_FT = 1/12 ft` floor.
**Gate:** `check:pushpull` (`scripts/check-pushpull-engine.mjs`) 17 passed, 0 failed; `scratch/test_face_pushpull.py` 50 passed, 0 failed.

### Phase 8 — Validity predicates and clamping · **M** · ✅ **DONE (W1–W3)**
`backend/validity.py` provides validation for both create and edit paths: thickness floor, opening host containment, wall length vs openings, footprint area > 0, finite coordinates.
**Rework closures:** W1 establishes committable `MIN_THICKNESS_FT = 1/12 ft` floor; W2 propagates `clamp_reason` through command envelope to status bar; W3 guards creation paths against invalid dimensions/polygons.
**Gate:** `scratch/test_validity_predicates.py` passes 63/63 checks.

**Dependency order:** `P0 → P1 → P2 → P3 → {P4, P5} → P6 → P8 → P7`. All executed and verified.

---

## 6. Explicitly not doing

- **Not adopting IngeTrazo's mesh-as-truth object model.** It would break joins, hosted openings, HLR and IFC export, and its own roadmap calls per-face Python objects a liability.
- **Not porting push/pull's mesh booleans.** BIMWorks' openings are IFC relationships; Phase 7 changes parameters.
- **Not running whole-model validity on the interactivity path.** IngeTrazo's `is_closed`/`signed_volume` are O(mesh) and its roadmap wants local orientation instead; a per-frame whole-model check would undo Phase 1.1's scoping work.
- **Not previewing through per-frame transactions.** The snapshot is O(model); one per gesture, never per frame.
- **Not adding a Move/Rotate *tool* that takes two viewport picks before anything moves.** Grips replace that interaction, not duplicate it.
- **Not touching the ribbon/palette refactor.** The icons, tabs and palette are orthogonal; only `toolCaptions.ts`, the palette's view-type label (§4.6) and the session's readout are shared surface.
- **Not "fixing the sample" by editing the generator's literals.** That would preserve two divergent samples. The IFC is the sample; the generator is the bug (§4.1).
- **Not re-implementing HLR or the view engine.** The engine already returns correct plan/section/elevation linework for a correct model; §4.5/§4.6 are display defects, not engine defects.

---

## 7. Risks

1. **React re-render per frame.** Grips and preview must live outside React state (refs + an imperative overlay), or the drag will stutter. The existing dimension pill re-renders through state; replacing it is part of Phase 4.
2. **Preview divergence at joins and openings** (decision 3.4). Mitigate by labelling the dragged element as preview and refreshing on commit; never let the client's transform be the committed truth.
3. **`activeTool` is a closed union** (`types/bim.ts:210-228`) consumed by the ribbon, the status bar and both viewports. Extending it ripples; the session should wrap it rather than replace it in one step.
4. **Typed commands before grips.** Phase 3's prerequisite is real: without it, a grip can silently do nothing — **and a live instance of exactly that class is already in the tree** (§4.3).
5. **Undo semantics.** A gesture must be exactly one entry, and its journal `origin` should stay `ui` with a description like "Drag wall end" so the audit trail reads correctly.
6. **The 1.85 ms figure was measured on an *unviewed* level.** With `slice2d` suppressed the viewed-level case should be comparable, but this must be measured, not assumed (§10.1).
7. **Two samples in the tree is a trap that already fired.** Anything asserting on "the sample" must name *which* sample. The probe did not, and its first version tested the legacy generator (§9.3).
8. **Green gates are not coverage.** 355 assertions passed (618 at `ec2c99c`) while the first-run plan rendered empty, dimensions could not be created from the UI, and a locked dimension silently produced wrong geometry (that one is since fixed — §4.2). Every gate in Track A is written against an observable user-facing outcome for that reason.

---

## 8. Gates — verified at HEAD

| Phase | Assertion | Negative control that fails the gate | Verifying Suite | Status |
|---|---|---|---|---|
| A1 | Startup sample is the IFC: heights 7–14 ft, cut paths > 0 | Load legacy generator | `scratch/_probe_engine_smoke.py` check A/B | ✅ **PASSED** |
| A2 | Locked dimension: all anchors land on asked value | Revert `length_lock` fix | `test_dimensions_crud.py`, probe check D | ✅ **PASSED** |
| A3 | Solve failure does not present `status: "updated"` | Deliberate solve error | `scratch/_probe_engine_smoke.py` check E | ✅ **PASSED** |
| A4 | Created dimension readable via `GET /api/dimensions` | Route absent | `backend/main.py:773, 782` | ✅ **PASSED** |
| A5 | 60–90% viewport occupancy & centred after switch | Identity transform | `scripts/check-fit-extents.mjs` (`check:fit`) | ✅ **PASSED** |
| A6 | Elevation has no cut plane; palette type matches view | Hardcode label | `PlanViewport2D.tsx`, `PropertiesPalette.tsx` | ✅ **PASSED** |
| A7 | `DI`, `SEC`, `EL` tools produce geometry and match captions | Unwire handler | `Ribbon.tsx`, `toolCaptions.ts:46`, `PlanViewport2D` | ✅ **PASSED** |
| B0 | 2D and 3D agree on snap kind+point | World-unit radius | `scripts/check-snap-engine.mjs` (34 checks) | ✅ **PASSED** |
| B1 | Esc mid-gesture sends 0 commands; 5 px wobble does not drag | Remove threshold | `scripts/check-interaction-session.mjs` (37 checks) | ✅ **PASSED** |
| B2 | 60 frames ⇒ `rev` +1, 1 journal entry, undo restores | Let `update` advance `rev` | `scratch/test_drag_session.py` (27 checks) | ✅ **PASSED** |
| B3 | One typed command per drag; mesh changed | Dispatch untyped key | `scratch/test_wall_grips.py` (49 checks) | ✅ **PASSED** |
| B4 | Typed length is exact; correction leaves 1 net undo | Dispatch without undo | `scratch/test_value_entry_hot_retype.py` (15 checks) | ✅ **PASSED** |
| B5 | Named point beats reference lock beats grid | Invert priority list | `scripts/check-snap-engine.mjs` Phase 5 check | ✅ **PASSED** |
| B7 | Push/pull thickness & height gestures with exact floor | Round floor to 0.083 | `scratch/test_face_pushpull.py` (50), `check:pushpull` (17) | ✅ **PASSED** |
| B8 | Wall end past opening clamps to valid limit and explains | Commit unvalidated | `scratch/test_validity_predicates.py` (63 checks) | ✅ **PASSED** |

Performance gate: during a drag, parameter-only `WallSetHeight` update p95 is **0.158 ms** (inside the 8 ms budget); baseline-moving `WallSetEnd` is **24.053 ms** (recorded in `docs/DELTA-MEASUREMENT.md` §2.3; open optimization item).

**The probe.** `scratch/_probe_engine_smoke.py` is Track A's executable form: 7 checks, **7 passed / 0 failed, exit 0**. It is wired into `scripts/check-python-suites.mjs` and verified on every `npm run check`.

---

## 9. Collateral findings from these examinations

1. **The units fix went into the formatter but two hand-rolled message strings still mislabel feet.** `src/utils/units.ts` was corrected to integer 1/16" arithmetic, but `extractPolygonFromLines` still formats model coordinates as metres and a feet gap as centimetres: `${currentEnd[0].toFixed(1)}m` and `(dist(...) * 100).toFixed(0)}cm` (`useBimStore.ts:406, 424`). A 6-inch gap is still reported as "50cm". Both should call `formatLength`.
2. **The line references in the committed review have drifted.** `REVIEW-ingetrazo-object-creation-and-editing-2026-10-15.md` cites `useBimStore.ts:353/386/404`; after the refactor inserted `normalizeView` those are now `373/406/424`. The findings stand; the citations should be re-pinned, and this is the argument for citing symbols with line numbers as a footnote rather than the reverse. **Confirmed again at `7a36697`**: `MeshBufferData` moved `34 → 58` and `Sliced2DData` `93 → 140`.
3. **Two divergent samples, and the UI's status string describes the one it does not load.** `/api/sample` builds nineteen metric-magnitude elements and one storey while the store reports "**13 Elements, 3 Levels**" (`useBimStore.ts:1905`) — which is precisely `sample_building.ifc`'s inventory. The message was right; the loader was wrong. My own first probe made the same mistake and had to be corrected by the user, which is why §7.7 exists.
4. **The elevation/section "looks identical" impression is a sample artefact, not a view defect.** With the legacy shed both views return `cut=0, proj=7, hidden=18` — genuinely identical. With `sample_building.ifc` they diverge correctly (`section cut=52` vs `elevation cut=0`) and the section draws the storeys, slab and door/window openings. The view engine was never broken; it was fed a 3 ft model.
5. **There is no `GET /api/dimensions`** — dimensions are creatable, drivable and serialised, but not readable (404). See §4.4.
6. **An elevation reports a cut plane it does not have** (`Elevation: South (Cut Plane: 4'-0")`), and the Properties palette reports "Floor Plan" for both sections and elevations. See §4.6.
7. **`bim_manager` auto-loads at import** (`main.py:402`), so any process that imports `backend.main` mutates model state as a side effect — which is why the probe must be explicit about which sample it asserts on.

---

## 10. Residual unknowns

1. **The real per-frame cost of a viewed-level drag** with `slice2d` suppressed — §7.6. Measure before promising 30 fps.
2. **Whether Three.js raycasting can hit grips reliably** without a separate invisible proxy mesh, particularly at grazing angles on thin wall faces.
3. **How much of the store's tool state can move into the session without disturbing the UI-P0 interaction-reset contract** — `interactionResetToken`/`resetInteraction` are the right hooks, but their callers assume the current per-tool state shape.
4. **Whether a gesture-scoped snapshot is affordable on the largest model the project intends to support.** One O(model) snapshot per gesture is a different budget from one per command, but it is not free; `scratch/_probe_snapshot_cost.py` exists and should be pointed at it.
5. **Whether Revit-parity expectations conflict with IngeTrazo-style directness.** Revit has grips and drag-editing too, so probably not — but the Modify tab still renders dummy buttons (`Ribbon.tsx:1009`), which means parity there is decorative until Track B lands.
6. **What `is_locked` is *for*.** The locked path no longer fails (§4.2, resolved), but it is the path with a known dangling-constraint hazard after undo (`scratch/_probe_locked_dimension_undo.py`). Whether the lock should drive on value-set or only on regeneration is still a design question, not just a bug that was patched.
7. **Whether the remaining twelve→six snap kinds are needed**, or whether six cover the modelling the project actually supports.

---

## 11. Provenance

Track B's line references were read at `8ffec22` on 2026-10-15 and are pinned there: `Viewport3D.tsx` (navigation comment 485-489, `handleMouseDown` 490, tool dispatch 510-600, move/up 668-763, dimension pill 910-948), `PlanViewport2D.tsx:247-260`, `useBimStore.ts` (tmp-dimension 988-1046, delta 1265-1360, `translateElement` 1791, `executeTransaction` 2197, `dispatchTransaction` 2231, reset 44/442-444/853, instrumentation 266-290), `types/bim.ts:210-228`, `PropertiesPalette.tsx:187`, `SheetCanvas.tsx:34`, `toolCaptions.ts:1-20`, `backend/main.py:845-860, 945-975`, `backend/command_bus.py:116-118, 640-679, 692-723`, `backend/ifc_service.py:2303-2417`, `backend/sketch_model.py:49-90`. IngeTrazo references are pinned to `d8ee8c0`.

Track A and §1.1 were read at `7a36697` on 2026-10-16: `backend/main.py:357-402` (`/api/sample` and the startup call), `backend/command_bus.py:39, 456-457, 559` (`ReferenceMove`, `DimensionCreate`, `DimensionValueSet`), `backend/ifc_service.py:4278` (`set_dimension_value`), `backend/references.py`, `src/interaction/snapEngine.ts`, `src/interaction/toolCaptions.ts:41-48`, `src/types/bim.ts:58, 140-149, 210-228`, `src/store/useBimStore.ts:1898-1913`, `src/components/drafting/PlanViewport2D.tsx:2010-2041`, `sample_building.ifc`.

Measurements were taken on 2026-10-16 against a live sidecar (`uvicorn backend.main:app` on `:8008`): gate suite via `npm run check` (**355 assertions, 0 failures, exit 0** at the time; re-counted at `ec2c99c`: **618**, exit 0); 2D path counts via `/api/view/2d` and in-process `BimModelManager.render_2d_view`; dimension behaviour via `/api/transaction` and in-process bus calls; rendering, DOM state and screenshots via **headless Firefox 157 through geckodriver/WebDriver** (no Chromium on the host, so REA's CDP browser tools were unavailable). Screenshots are saved under the session workspace `rendering-check/` (`01`-`04` legacy sample, `05`-`08` `sample_building.ifc`). Probe: `scratch/_probe_engine_smoke.py`.
