# IMPLEMENTATION PLAN — direct manipulation: making 3D modelling feel like IngeTrazo

**Verified against:** `Axotopia/BIMWorks@8ffec22` (after the Revit-parity UI refactor: `7026842`, `4ed1f90`).
**Read for comparison:** IngeTrazo `d8ee8c0` (`/tmp/ingetrazo-src`) — `tools/base.py`, `core/snap.py`, `core/inference.py`, `core/history.py`, `tools/move.py`, `tools/scale.py`, `tools/pushpull.py`.
**Relationship to existing plans:** this is the *interaction* layer. `review/IMPLEMENTATION-PLAN-dimension-as-control.md` is the *semantics* layer (reference primitive, solver, dimension as a driving object). They meet at the grip (§3.6), and §4 sequences them so the grip layer is not rewritten when that plan reaches Phase 3.

**Line numbers are pinned to `8ffec22`.** They will drift; cite the symbol when the two disagree.

---

## 0. Why this plan exists

The Revit-parity refactor changed the chrome — ribbon tabs, 858 lines of bespoke vector icons, a rebuilt properties palette, the project browser, the status bar — and the store's view-definition tolerance. It did **not** touch `Viewport3D.tsx` or `PlanViewport2D.tsx`: `git diff 597c079..HEAD` shows both essentially unchanged, and `Viewport3D.tsx` not at all.

So the app now *looks* like Revit and still *feels* like a form. The measurement in §1 says why: there is no direct-manipulation layer at all. Nothing in `src/` contains the string `grip`; there is no drag state outside the sheet canvas; the modify commands exist on the bus but no viewport can invoke them as a gesture.

IngeTrazo is the reference for that missing layer, because it is the one open-source modeller in this space whose *feel* is its main asset: a 12-kind snap engine with a documented priority order, per-tool grips, inference with axis and reference locks, preview that applies the real mutation, and numeric entry that can be re-typed after the fact. This plan ports that layer onto BIMWorks' parametric model — not its mesh model (§6).

---

## 1. Diagnosis: what the 3D viewport can do today

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
| The one "dimension" that exists | Measures **bbox-centre → nearest bbox-centre** (not face-to-face), displayed as an HTML pill, committed as a **delta** through `translateElement` → `WallMove` — so element length never changes | `useBimStore.ts:988-1046, 1087`; the same conclusion is in `review/revit-dimension-as-control.md:449` |
| Inference / axis lock | None | — |
| Esc / cancel | A working reset path exists and is wired to tool change and sketch cancel — the hook a session needs is already there | `useBimStore.ts:44, 442-444, 853` |
| Hint text | A single caption table exists, with `implemented: false` already used to suppress unimplemented tools | `src/interaction/toolCaptions.ts:1-20` |
| Mutation seam | **One entry point**: `dispatchTransaction` (24 call sites) → `executeTransaction` → `POST /api/transaction`. The store is contractually forbidden from calling raw mutation routes | `useBimStore.ts:86-96, 2197-2199, 2231-2237` |
| Delta channel | **Live in the store** — `since=<rev>`, Response A unchanged, `upsert_meshes`, `remove_guids`, epoch check | `useBimStore.ts:1265-1360`; `backend/main.py:945-975` |
| Instrumentation | `globalThis.__bimworksRefresh` with separate `client` and `engine` p50/p95 | `useBimStore.ts:266, 288-290` |

Two structural facts make this plan cheap. First, **one mutation seam** (`dispatchTransaction`) means a gesture layer can be added without touching 24 call sites. Second, **the delta protocol already delivers per-GUID meshes**, which is exactly what a drag preview needs.

---

## 2. The IngeTrazo mechanisms to port

| # | Mechanism | Where IngeTrazo implements it | What it buys | Translation for BIMWorks |
|---|---|---|---|---|
| 1 | **Tool lifecycle as one state machine** — `on_activate`, `on_click`, `on_hover`, `on_release`, `on_cancel`, `on_key`, `on_value`, `status_clause`, `rubber_band_lines`, `guide_preview_lines`, `inference_guide_lines` | `tools/base.py:441-566` | Every tool shares one contract, so cancel, hints and preview cannot be forgotten per tool | A single `InteractionSession` reducer replacing `wallStartPoint`, `boxStartPoint`, `firstPoint`, `alignPickState` |
| 2 | **Snap engine with documented priority** — 12 kinds, high→low: axis lock, reference lock, close, endpoint, intersection, midpoint, origin, on-edge, aligned, axis-inference, none; **screen-space pixel radii**; the caller supplies `world_to_pixel` so the module is UI-free | `core/snap.py:1-28` | Constant snap radius under zoom; one place to add a kind; testable without a viewport | Port the priority list verbatim; `worldToScreen(camera, point)` in 3D, the SVG transform in 2D |
| 3 | **Inference state** — reference edge, encouraged points, axis/reference locks, dwell timer; magnetic axis; work-plane lock | `core/inference.py:1-52`; `AxisMagnet`/`PlaneLock` `tools/base.py:38, 75-334` | The "it knows what I mean" quality; ortho that feels automatic rather than modal | Hold in the session; render as guide lines + a cursor tip |
| 4 | **Per-tool grips** — a 26-grip 3D box / 8-grip 2D box / 2-grip edge for Scale; rotation grips built on the box faces that look at the eye, with `_hot_grip` tracking | `tools/scale.py:3-24, 56-63, 173-196`; `tools/move.py:154-163, 627-660` | Direct manipulation without a dialog | `gripsFor(element, params) → Grip[]`, screen-space hit radius, enlarged invisible hit proxies |
| 5 | **Preview *is* the real mutation** — the same `_mutate_inner` runs each drag frame; Move applies and reverts; commit reverts the preview then re-applies once; `SnapshotMutation` wraps the whole gesture in **one** snapshot, and redo restores the captured after-state rather than re-running | `tools/pushpull.py:2003-2007, 2043-2050`; `tools/move.py:403-410, 864-913, 915-953`; `core/history.py:2893-2935` | Preview cannot diverge from the commit — the class of bug `PlanViewport2D.tsx:270` already documents ("the rubber band had frozen") | The drag session in §4 Phase 2 — one snapshot per gesture, frames reuse it |
| 6 | **Numeric entry during the gesture, and re-typing after it** — `vcb_label` + `on_value`; Scale's `on_value` **undoes the just-committed command and re-executes a rebuilt one at the typed value**; push/pull keeps a retype payload | `tools/base.py:436-439, 508-516`; `tools/scale.py:566-590`; `tools/pushpull.py:1841-1860` | The single cheapest "professional" feel upgrade: type the number you meant, before or after | One value input bound to the session; after commit, `undo` + re-dispatch (the journal already supports both) |
| 7 | **Drag-vs-click threshold** — `_DRAG_PX = 6.0` | `tools/pushpull.py:183-187` | A click that wobbles does not start an edit; a drag that barely moves still does not commit a zero edit | 5 px, measured in the session |
| 8 | **Refusal with a reason, and graceful degradation** — a push that would break the solid is rolled back; the commit **binary-searches for the largest distance the guard accepts** (six halvings) rather than failing; the user is told why | `tools/pushpull.py:1940-1947, 1862-1907, 1829-1833` | A drag into an invalid state degrades instead of erroring | Validity predicates + clamp (§4 Phase 8), surfaced through the existing status/`failureMessage` path |
| 9 | **Keep/repeat** — `last_distance`, keep-mode, double-click repeat | `tools/pushpull.py:1815-1835` | Fast iteration without re-aiming | Extend the existing `chainTools` idea to "repeat last modify" |

---

## 3. The six decisions this plan makes

**3.1 Grips emit *parameters*, not geometry.** IngeTrazo pushes a mesh face because its model *is* the mesh. BIMWorks' model is a parametric record plus an IFC entity, and mesh-level edits would break wall joins, hosted openings, HLR slices and IFC export. So each grip gesture maps to a typed parameter edit: end grip → baseline endpoint, height grip → `height`, thickness grip → `thickness`, opening grip → `offset_along_wall`/`width`/`sill_height`, level grip → `elevation`. The *feel* is IngeTrazo's; the *mutation* stays BIM-correct.

**3.2 One snapshot per gesture: a drag session on the bus.** A 60-frame drag must not create 60 transactions — that would fill the undo stack with junk and pay the O(model) snapshot 60 times (`command_bus.py:640-679` captures full IFC STEP text plus a deep copy; `DELTA-MEASUREMENT.md` measures the protocol, not this cost). The session is `begin` (one snapshot) → `update` (execute against the dirty model, no new snapshot) → `end{commit|cancel}`. It is a generalisation of `abort_transaction` (`command_bus.py:692-723`), which already snapshots, restores and prunes the journal.

**3.3 Preview rides the existing delta channel, with `slice2d` suppressed.** `update` returns only the changed elements' meshes through the same machinery as `upsert_meshes`; the 2D slice is skipped while dragging and recomputed once on commit. This is affordable because the engine's mesh-delta path is already O(changed): **1.85 ms** for a mesh-only edit on the 250-wall model, and Phase 1.3b has since bounded the slice that used to dominate (`docs/DELTA-MEASUREMENT.md:47`; `e3216fe`).

**3.4 Client-side transform for pure translation; engine truth for anything that regenerates.** Moving an element is a matrix change and can be previewed in Three.js at zero cost. Changing a wall's length, height or thickness regenerates geometry and can involve joins and hosted openings, so it goes through the session. Honest limitation to state in the UI: during a wall-end drag, the far end's miter is stale until commit. Never commit from the client preview.

**3.5 A refusal is a clamp plus a sentence, not a failed transaction.** IngeTrazo's binary search for the largest acceptable value is the model. Every grip declares its validity range, and the drag clamps to it, showing *why*: "thickness cannot go below 0'-1\"", "the opening would leave the wall", "walls cannot be shorter than their openings".

**3.6 The grip's intent payload is reference-shaped from day one.** `{ ref?: ReferenceHandle, param, value }`. While grips run on deltas, `ref` is absent; when `references.py` lands (`IMPLEMENTATION-PLAN-dimension-as-control.md` §3.1, Phase 1), the same gesture starts emitting a reference-qualified edit and nothing in the gesture layer changes. **Without this, dimension-as-control Phase 3 rewrites the grip layer.**

---

## 4. Phases

Each phase is independently verifiable and ends with a gate that can fail (§8).

### Phase 0 — The SnapEngine · **S** · unblocks everything
**New:** `src/interaction/SnapEngine.ts` (+ `snapProviders.ts`).
Port `core/snap.py`'s kind list and priority order verbatim, with per-kind screen-space radii from a single tuning table. Providers: element endpoints and midpoints (from `params`), wall baselines (on-edge), slab/roof polygon vertices, level elevations, grid line intersections, the active chain's start point ("close"), and intersections between guides. Return `{kind, point, label}`; `label` feeds the cursor tip and the status bar.
**Replace:** all 12 inline quantisations in `Viewport3D.tsx`, the 0.25 ft grid and `findSnapVertex` in `PlanViewport2D.tsx`, and the sketch-loop tolerance use in the store. The grid stays as the *lowest-priority* provider so the app still feels gridded.
**Gate:** a scripted parity check (in the style of `scripts/check-*.mjs`) asserting that for a fixture cursor path, 2D and 3D return the same snap kind and point. Negative control: the check must fail if the snap radius is expressed in world units — prove it by asserting identical snap *behaviour* at two zoom levels.

### Phase 1 — The interaction session · **M**
**New:** `src/interaction/session.ts` — `{tool, phase: 'idle'|'armed'|'picking'|'dragging', picks, hover, snap, preview, value}` plus a reducer with `begin/point/hover/commit/cancel`.
**Change:** `Viewport3D.tsx` and `PlanViewport2D.tsx` stop holding tool state in `useState`; the session becomes the single source. `resetInteraction` (`useBimStore.ts:853`) drives `cancel`, so Esc, tool change and sketch cancel all take one path. Extend `toolCaptions.ts` with per-phase prompts ("Specify first point", "Specify opposite corner", "Drag to set height, or type a value") instead of the current per-tool string literals in the JSX.
**Gate:** the UI-P0 interaction gate still passes; new assertions — a mid-gesture Esc sends **zero** commands and returns to armed; a 5 px wobble on a click does not enter `dragging`; a chained wall run produces one transaction per wall and therefore N undo steps.

### Phase 2 — The drag session on the bus · **M** · the enabler
**Backend:** `CommandBusEngine.begin_drag() / update_drag() / end_drag()` in `backend/command_bus.py`; routes `/api/drag/begin`, `/api/drag/update`, `/api/drag/end` in `backend/main.py`. `begin` takes one snapshot and returns a session id; `update` executes commands against the live model **without snapshotting**, marks dirty guids, returns the changed meshes (reuse the delta builder; `slice2d: null`); `end{commit:true}` advances `rev` once, writes one journal entry and one undo entry; `end{commit:false}` restores the begin snapshot and removes the session's journal entries — the `abort_transaction` shape.
**Frontend:** the *only* place this touches is `dispatchTransaction` (`useBimStore.ts:2231`), which gains a "gesture in progress" mode. The 24 call sites are untouched.
**Gate:** a 60-frame drag advances `rev` by exactly 1, adds exactly 1 journal entry, and one `undo` restores the pre-drag state exactly (deep compare, the `check-delta-equivalence.mjs` style). Negative controls: `rev` must **not** move during `update` frames; cancel must leave geometry byte-identical and `rev` unchanged.

### Phase 3 — Grips for walls · **M** · the first real "feel"
**New:** `src/interaction/grips.ts` — `gripsFor(element, params) → Grip[]` with `{id, kind, worldPoint, axis, value, unit, range, ref?}`. Wall kinds: two end grips (baseline), a height grip (top face centre), a thickness grip (each side face centre). Render as an HTML overlay positioned by projecting the grip's world point (the pattern already exists for the dimension pill, `Viewport3D.tsx:910-948`), with enlarged invisible hit proxies; hot-grip highlight on hover.
**Prerequisite — typed edit commands.** `ElementUpdate` takes an untyped `Dict[str, Any]` and `update_element` silently ignores keys it does not recognise while still returning `"updated"` (`backend/command_bus.py:116-118`; `backend/ifc_service.py:2303-2417`). A grip that silently no-ops is the worst possible outcome for a drag. Add `WallSetHeight`, `WallSetThickness`, `WallSetEnd` (and their slab/opening counterparts as Phase 6 needs them) with schemas and tests — this is also `REVIEW-ingetrazo-object-creation-and-editing-2026-10-15.md` §4.1, so it is paid for once.
**Gate:** a drag emits exactly **one** command of a typed kind (assert no `ElementUpdate` in the journal); the journal's result reports the new value; the mesh actually changed. Negative control: assert the gate fails if a grip dispatches `ElementUpdate` with a misspelled key.

### Phase 4 — Value entry and hot retype · **S** · cheapest professional-feel win
One input surface bound to the session: during a drag it displays the live value and typing overrides the pointer; after commit it remains editable and re-issues the command with the corrected value by `undo` + re-dispatch (exactly IngeTrazo's mechanism, `tools/scale.py:566-590`).
**Change:** retire the bbox-centre pill (`useBimStore.ts:988-1046`) in favour of the session's readout, so the number the user reads is the number they type. Route every magnitude through `formatLength` (which now does integer 1/16" arithmetic) rather than hand-rolled `.toFixed()` strings — see §9.
**Gate:** typing `12'-6"` mid-drag and committing produces a wall of exactly that length; typing a correction after commit leaves **one** net undo step for the gesture, not two.

### Phase 5 — Inference · **M**
Axis lock (Shift), ortho, parallel/perpendicular to the hovered reference edge, guide lines drawn from the reference, and the snap label shown at the cursor. Port `core/inference.py`'s state (reference edge, encouraged points, axis and reference locks, dwell timer) and IngeTrazo's rule that **a snap provider never overrides a named point** (`docs/plugins.md`).
**Gate:** with the pointer within one pixel of a wall endpoint, the endpoint snap wins over the reference lock and over the grid; the check must fail if priority order is inverted.

### Phase 6 — Grips beyond walls · **L**
Openings (`offset_along_wall`, `width`, `sill_height`, `swing_flipped`), levels (`elevation` — `LevelMove` already exists), slab/roof polygon vertices (the sketch model already carries stable `curve_id`s, `backend/sketch_model.py:49-90`), grid endpoints.

### Phase 7 — Face-based push/pull as a parameter gesture · **L**
Hover a wall face → push/pull changes thickness; hover the top face → height. Numeric entry as in Phase 4. This is the gesture that will most make the 3D viewport feel like IngeTrazo, and it is only safe *after* Phase 8's validity predicates.

### Phase 8 — Validity predicates and clamping · **M** · required by Phase 7
One module, `backend/validity.py`, used by **both** the create and edit paths: thickness > 0, wall longer than the openings it hosts, opening inside its host, footprint area > 0, finite coordinates. This also closes the open-boundary hole documented in `REVIEW-…§4.2` — `Sketch.validate()` currently accepts an open chain and has its closing edge inferred — which a grip drag will hit on its first day.

**Dependency order:** P0 → P1 → P2 → P3 → {P4, P5} → P6 → P8 → P7.

---

## 5. Explicitly not doing

- **Not adopting IngeTrazo's mesh-as-truth object model.** It would break joins, hosted openings, HLR and IFC export, and its own roadmap calls per-face Python objects a liability.
- **Not porting push/pull's mesh booleans.** BIMWorks' openings are IFC relationships; Phase 7 changes parameters.
- **Not running whole-model validity on the interactivity path.** IngeTrazo's `is_closed`/`signed_volume` are O(mesh) and its roadmap wants local orientation instead; a per-frame whole-model check would undo Phase 1.1's scoping work.
- **Not previewing through per-frame transactions.** The snapshot is O(model); one per gesture, never per frame.
- **Not adding a Move/Rotate *tool* that takes two viewport picks before anything moves.** Grips replace that interaction, not duplicate it.
- **Not touching the ribbon/palette refactor.** The icons, tabs and palette are orthogonal; only `toolCaptions.ts` and the session's readout are shared surface.

---

## 6. Risks

1. **React re-render per frame.** Grips and preview must live outside React state (refs + an imperative overlay), or the drag will stutter. The existing dimension pill re-renders through state; replacing it is part of Phase 4.
2. **Preview divergence at joins and openings** (decision 3.4). Mitigate by labelling the dragged element as preview and refreshing on commit; never let the client's transform be the committed truth.
3. **`activeTool` is a closed union** (`types/bim.ts:210-228`) consumed by the ribbon, the status bar and both viewports. Extending it ripples; the session should wrap it rather than replace it in one step.
4. **Typed commands before grips.** Phase 3's prerequisite is real: without it, a grip can silently do nothing (§9 shows this is not hypothetical — `ElementUpdate` already reports success for ignored keys).
5. **Undo semantics.** A gesture must be exactly one entry, and its journal `origin` should stay `ui` with a description like "Drag wall end" so the audit trail reads correctly.
6. **The 1.85 ms figure was measured on an *unviewed* level.** With `slice2d` suppressed the viewed-level case should be comparable, but this must be measured, not assumed (§10).

---

## 7. Gates — each must be able to fail

| Phase | Assertion | Negative control that must fail the gate |
|---|---|---|
| 0 | 2D and 3D agree on snap kind+point for a fixture cursor path | Express the radius in world units → behaviour must change with zoom |
| 1 | Esc mid-gesture sends zero commands; 5 px wobble does not drag | Remove the threshold → a wobbling click starts a drag |
| 2 | 60 frames ⇒ `rev` +1, one journal entry, one undo restores exactly | Let `update` advance `rev` → gate fails |
| 3 | One typed command per drag; mesh changed; result reports the value | Dispatch `ElementUpdate` with a bad key → gate fails |
| 4 | Typed length is exact; correction leaves one net undo step | Dispatch without undo → two entries |
| 5 | Named point beats reference lock beats grid | Invert the priority list → gate fails |
| 8 | Dragging a wall end past an opening clamps and explains | Commit the invalid value → gate fails |

Performance gate (Phase 2 onward): during a drag, `globalThis.__bimworksRefresh.engine.p95` stays under 8 ms on the 250-wall fixture with `slice2d` suppressed; record it in `docs/DELTA-MEASUREMENT.md` alongside the existing corpus. The instrumentation already separates `client` from `engine` p50/p95 — never report one as the other (`REFACTOR-PLAN.md` §2.4).

---

## 8. Collateral findings from this examination

1. **The units fix went into the formatter but two hand-rolled message strings still mislabel feet.** `src/utils/units.ts` was corrected to integer 1/16" arithmetic, but `extractPolygonFromLines` still formats model coordinates as metres and a feet gap as centimetres: `${currentEnd[0].toFixed(1)}m` and `(dist(...) * 100).toFixed(0)}cm` (`useBimStore.ts:406, 424`). A 6-inch gap is still reported as "50cm". Both should call `formatLength`.
2. **The line references in the committed review have drifted.** `REVIEW-ingetrazo-object-creation-and-editing-2026-10-15.md` cites `useBimStore.ts:353/386/404`; after the refactor inserted `normalizeView` those are now `373/406/424`. The findings stand; the citations should be re-pinned, and this is the argument for citing symbols with line numbers as a footnote rather than the reverse.

---

## 9. Residual unknowns

1. **The real per-frame cost of a viewed-level drag** with `slice2d` suppressed — §6.6. Measure before promising 30 fps.
2. **Whether Three.js raycasting can hit grips reliably** without a separate invisible proxy mesh, particularly at grazing angles on thin wall faces.
3. **How much of the store's tool state can move into the session without disturbing the UI-P0 interaction-reset contract** — `interactionResetToken`/`resetInteraction` are the right hooks, but their callers assume the current per-tool state shape.
4. **Whether a gesture-scoped snapshot is affordable on the largest model the project intends to support.** One O(model) snapshot per gesture is a different budget from one per command, but it is not free; `scratch/_probe_snapshot_cost.py` exists and should be pointed at it.
5. **Whether Revit-parity expectations conflict with IngeTrazo-style directness.** Revit has grips and drag-editing too, so probably not — but the Modify tab currently renders dummy buttons (`Ribbon.tsx:1009`), which means parity there is decorative until this plan lands.

---

## 10. Provenance

Line references were read at `8ffec22` on 2026-10-15 and are pinned there: `Viewport3D.tsx` (navigation comment 485-489, `handleMouseDown` 490, tool dispatch 510-600, move/up 668-763, dimension pill 910-948), `PlanViewport2D.tsx:247-260`, `useBimStore.ts` (tmp-dimension 988-1046, delta 1265-1360, `translateElement` 1791, `executeTransaction` 2197, `dispatchTransaction` 2231, reset 44/442-444/853, instrumentation 266-290), `types/bim.ts:210-228`, `PropertiesPalette.tsx:187`, `SheetCanvas.tsx:34`, `toolCaptions.ts:1-20`, `backend/main.py:845-860, 945-975`, `backend/command_bus.py:116-118, 640-679, 692-723`, `backend/ifc_service.py:2303-2417`, `backend/sketch_model.py:49-90`. IngeTrazo references are pinned to `d8ee8c0`.
