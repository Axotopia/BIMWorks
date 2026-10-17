# BIMWorks — Implementation Plan: modelediting that feels like Revit

**Supersedes for execution purposes:** `review/archive/CHANGE-PLAN-revit-parity.md` (the analysis). This is the
plan that acts on it.
**Branch:** `gemini` @ `318ce26`, executed on `main` through `e3216fe`. **Companion audits:** the four
under `review/AUDIT-*-vs-revit.md`.

**Plan dated:** written **2026-10-14** (`318ce26`); executed on `main` through **2026-10-15** (`e3216fe`).
**Reconciled & Consolidated:** **2026-10-16 at `aa02b07`** — consolidated historical audit passes (§0a–§0d) into a single authoritative Executive Status (§0). Gate suite verified at **924+ assertions** across 8 gates plus 15 Python test suites and clean `tsc --noEmit`. Phase 3.5.1 updated to ✅ **DONE** (50 of 50 commands declare mementos, 0 fallback to snapshot). Read §0 for authoritative repository ground truth.

## 0. Executive Status & Reconciliation at HEAD (aa02b07)

This section consolidates and supersedes the historical audit rounds (§0a at `e3216fe`, §0b at `ec2c99c`,
§0c at `7251a44`, and §0d post-W8 rework) into a single authoritative record of repository reality at
HEAD (`aa02b07`).

### 0.1 Verification Net & Repository Health

`npm run check` exits 0 with **924+ assertions** across 8 automated gates, plus 15 Python test suites and
clean TypeScript compilation (`tsc --noEmit`):

- **Bus Parity Gate (`check:bus`):** 47 UI actions covered with parity guards across command registry.
- **UI-P0 Gate (`check:ui`):** 132 passed, 0 failed.
- **State-Bundle Gate (`check:state`):** 45 passed, 0 failed.
- **Delta Equivalence Gate (`check:delta`):** 21 passed, 0 failed.
- **Snap Engine Gate (`check:snap`):** 34 passed, 0 failed (`scripts/check-snap-engine.mjs` & `scratch/test_snap_engine.py`).
- **Interaction Session Gate (`check:interaction`):** 37 passed, 0 failed (`scripts/check-interaction-session.mjs`).
- **Push/Pull Gate (`check:pushpull`):** 17 passed, 0 failed (`scratch/test_face_pushpull.py`).
- **Python Test Suites (`check:py`):** 15 suites, **694+ checks** passed, 0 failed:
  - `scratch/_probe_engine_smoke.py`: 7/7 checks passed (including check G: 50/50 commands declare a memento, 0 fallback).
  - `scratch/test_pure_python_solver.py`: 13/13 passed (`Sketch is None` fallback).
  - `scratch/test_type_layer_gate.py`: 34/34 passed.
  - `scratch/test_session_undo_memento.py`: 12/12 passed (500 sequential edits @ 9.46 ms/tx, peak memory 1.06 MB < 25 MB ceiling).
  - `scratch/test_trim_split_gate.py`: 30/30 passed.
  - `scratch/test_mesh_hlr_incremental.py`: 11/11 passed.
  - `scratch/test_dimensions_crud.py`: 201/201 passed.
  - `scratch/test_scale_gate.py`: 6/6 passed (passes scaling shape & cache guards; 100 walls at 8.2 ms < 16 ms budget; 196 walls within 30 ms threshold).
- **TypeScript:** clean (`tsc --noEmit` exits 0).

### 0.2 Consolidated Phase Matrix (Phases 0–7)

| Phase | Description | Status | Evidence & Reality at HEAD (`aa02b07`) |
|---|---|---|---|
| **Phase 0** | Instruments & Honesty | 🟨 **PARTIAL** | 0.1 scale gate ✅; 0.2 fixtures exist in `test_trim_split_gate.py` (30/30) and `test_dimensions_crud.py` (201/201), but §20.1 angle/join variation is 🟨 unmet; 0.3 units boundary ✅ (`b6b3cdd`); 0.4 project browser/ribbon on engine state ✅ (`73b7dbb`); 0.5 Ctrl+Z/Ctrl+Y keybindings ✅ closed & bound (`App.tsx:53`, `:62`). Exit scale curve at $N=5,000$ remains ⬜ open (measured to 484). |
| **Phase 1** | Fast Trim & View Regeneration | 🟨 **PARTIAL** | 1.1 scoped join recompute ✅ (`cc213fc`, 82.8 → 3.3 ms at 196 walls); 1.2 O(1) join lookup index ✅ (`48ad6be`); 1.3a/b/c incremental 2D view and per-mesh caches ✅ (plan cache miss drops from 679 to 60 ms at 484 walls); 1.4 scoped constraint solve ✅ (`ifc_service.py:3026`). **Only 1.5 (slice delta transport) remains ⬜ open.** |
| **Phase 2** | Dimension-Driven Editing | 🟨 **PARTIAL** | 2.1 units boundary ✅; 2.2 dimension overlay objects ✅; 2.3 `Dimension*` bus commands ✅; 2.4 in-canvas inline dimension editor and persistent `DI` creation ✅ (`PlanViewport2D.tsx:611`, `implemented: true`); 2.5 edit moves referenced face along baseline ✅; 2.6 EQ chains ✅ (backend/bus); 2.8 witness lines & rotated text ✅. **Only 2.7 (grid spacing editable by dimension) remains ⬜ open.** |
| **Phase 3** | Revit Trim / Split / Extend | ✅ **DONE** | 3.1 corner trim moves both walls & clamps to body ✅; 3.2 split preserves openings and refuses straddling cuts ✅; 3.3 split-with-gap ✅; 3.4 hotkeys & picks (`TR`, `SL`, `SO`, `DI`, `SEC` live) ✅; 3.5 datum-driven trim/extend to grid/level ✅. Gate: `test_trim_split_gate.py` (30/30). |
| **Phase 3.5** | Undo / Mementos | ✅ **DONE** | 3.5.1 command-scoped mementos for all **50 of 50** registered commands (0 fall back to snapshot; closed by W8 in `REWORK-ORDER-direct-manipulation-2026-10-16.md`; probe check G green) ✅; 3.5.2 Ctrl+Z / Ctrl+Y wired with state-bundle refresh ✅. Gate: `test_session_undo_memento.py` (12/12) + probe check G (7/7). Peak memory 1.06 MB / 500 tx (< 25 MB ceiling). |
| **Phase 4** | Draw-and-Place Feel | 🟨 **PARTIAL** | 4.1 `snapEngine.ts` pure module with all 6 candidate types ✅ (`check:snap` 34/34), visual SVG glyph overlays deferred ⬜; 4.2 snap toggle / F3 hotkey ✅; 4.3 hover pre-highlighting ✅; 4.4 window/crossing selection & Tab-cycling ✅; 4.5 continuous chaining & live ghost previews ✅; 4.6 temporary dimensions live on walls ✅, non-wall references deferred ⬜. 3D viewport imports snap engine (0 inline quantisations left). |
| **Phase 5** | Type Layer | ✅ **DONE** | `type_registry`, `IfcWallType`, `EditTypeModal` with live cross-section preview, parameter table, type duplication, and type→instance geometry propagation. Gate: `test_type_layer_gate.py` (34/34). |
| **Phase 6** | Sheet Management | ✅ **DONE** | Sheet list in browser, `+ New Sheet`, in-place SVG titleblock editing, batch PDF export, Schedules modal with CSV export. Gate: `test_sheets_pdf.py` (95/95). |
| **Phase 7** | Chrome & UI Polish | 🟨 **PARTIAL** | Options Bar with context-sensitive parameters ✅; Context Menu in 2D/3D (`CS`, select all instances, flip, delete, zoom extents) ✅; hotkeys (`CS`, `WT`, `ZA`, `ZE`, `MD`) ✅; visual selection outline, flip arrows, endpoint grip circles ✅; contextual ribbon panels and interactive endpoint dragging deferred ⬜. |

### 0.3 Catalog of Remaining Open Scope

The repository is healthy and feature-rich. For future execution sessions, the remaining open work
across this plan is strictly cataloged here:

1. **Phase 0.2 (§20.1 Variation Fixtures):** In `scratch/test_trim_split_gate.py`, test fixtures vary
   wall thickness (0.5 / 0.75 ft) but do not yet systematically vary wall angles (e.g. 45°, 60°, non-orthogonal)
   or join modes (miter, butt, square-off).
2. **Phase 0 Exit ($N=5,000$ Benchmark):** Scale sweep is verified up to $N=484$ elements. A 5,000-element
   benchmark curve has not been measured end-to-end.
3. **Phase 1.5 (Slice Delta Transport):** Slicing is fast (~60 ms), but transport currently transmits
   the full storey linework rather than changed paths (`main.py:1030-1109`).
4. **Phase 2.7 (Grid Spacing by Dimension):** Level elevation datums and in-canvas elevation edits are live;
   grid spacing editable directly by dimension remains open (grid click currently selects the grid only).
5. **Phase 4 Deferred Features:**
   - 4.1: In-canvas visual SVG snap glyph overlays (endpoint square, midpoint triangle, intersection X, etc.) in `PlanViewport2D.tsx`.
   - 4.6: In-canvas temporary dimensions for non-wall elements using real geometric references (currently uses bbox centers).
6. **Phase 7 Deferred Features:**
   - Element-specific contextual ribbon panels (specialized tool panels appearing dynamically when walls, doors, or slabs are selected).
   - Interactive endpoint dragging with live constraint solve.
7. **Drag Path Latency:** Direct-manipulation `WallSetEnd` baseline drag measures ~24 ms vs. the 8 ms target
   budget (under load).

### 0.4 Engineering Traps and Architectural Lessons

Ten critical lessons learned from performance profiling and regression debugging in this repository:

1. **`cached_verts` must have a single unit.** The builders write feet, `_get_product_shape` returns metres,
   and both wrote the same cache key. All writes now go through `_cache_verts`, and the cache is always
   in the file's unit.
2. **`metres_per_unit` and `METRES_PER_FOOT` are different factors.** `_metres_per_unit()` is metres per
   *file unit* (1.0 for a metres model); converting geometry authored in *feet* requires `METRES_PER_FOOT` (0.3048).
3. **Never convert on read and cache the converted value.** This self-amplifies geometrically on successive reads.
4. **Plan and join caches must remain conservative.** The plan cache folds sorted element GUIDs into its key.
   The join radius must check both old and new endpoints, otherwise a partner wall retains a stale footprint permanently.
5. **`mesh_hlr` expects `cut_z` in metres.** Feeding it feet buffers offsets cut planes by 3.28084 and drops openings.
   It must receive `_meshes_for_projection()`.
6. **Grep for callers before deleting code.** Deleting a helper can silently orphan callers that have no test coverage.
7. **Spatial occlusion grouping requires bounding occluders per mesh.** Simple spatial bucketing failed because
   building models share a single global tile; bounding the occluder geometry per mesh is what eliminated quadratic time.
8. **Assert absolute latency guards, not share-of-total percentages.** Share-of-total assertions become noisy
   coin-flips once both numerator and denominator become small.
9. **Beware of stale `.pyc` caches.** Clear `backend/__pycache__` when numbers diverge unexpectedly.
10. **`recompute_wall_joins(only=...)` requires partner widening.** A selected wall's partner can lie outside
    the subset, so join recomputation must expand to candidates within the join radius.

### 0.5 Objective and Binding Constraints

**Objective.** Make **model creation and editing in model views feel like Revit** — a simplified Revit
LT. Sheet management stays in scope. Rendering pipelines, sharing and coordination are out of scope.
Dummy icons and unfinished chrome are acceptable; the *feel of working in a model view* is the priority.

**Binding constraints (from the project owner, 2026-10-14):**

| Constraint | Value | Consequence for this plan |
|---|---|---|
| Target scale | **~5,000 elements / 15 levels** | ~28× the model my measurements used. Every O(model) or O(N²) path is disqualified. |
| Levels | **All live simultaneously** | The 2D view must be per-view and incrementally composited; per-storey lazy loading is not available as an escape hatch. |
| Engine | **Python for the MVP, with a later Rust port; freeze the Python surface now** | Hot paths must be *designed* as if they were already Rust — one pipeline, numeric interfaces, explicit dirty sets. No new Python-only abstractions on the hot path. |
| Interaction priority | **Dimension-driven editing in the model view** | See §1. This is the acceptance criterion, not grip dragging. |
| Finishing | Dummy icons/tools acceptable | Do not spend effort on chrome before flow. |

**The workflow that must be fast** (owner's words, operationalised):

1. **Draw walls roughly** — grid snap or freehand rough segments. Precision is not expected at draw time.
2. **Trim / split to join or break** — corners and T-junctions come from trim/extend, not from drawing exactly.
3. **Dimensions are the primary editing device.** Select a dimension in the model view, **type over its
   text**, and the model re-solves. Not a dialog.
4. **The same for grids and levels** — datum dimensions in the view are the primary controls.

---

## 1. What this workflow changes about the earlier plan

My previous recommendation led with "build the handle/drag model." **That was wrong for this user**, and
this plan replaces it. Three corrections:

**1. Drag is demoted.** Direct manipulation becomes *draw + trim*, not *grab a grip*. There is still a
place for a commit-on-drop drag later, but it is no longer the headline fidelity gap, and nothing in the
critical path depends on it.

**2. The real bottleneck is the join/trim path, not the drag path.** Every trim, extend, split and
dimension edit triggers a join recompute. Measured: `translate_element` calls the bare global
`recompute_wall_joins()` with no `only=` argument (`ifc_service.py:2022`), and the partner search scans
every wall (`:2767`). At 1,000 walls a single edit produced **2,004,002 wall visits** and 802.9 ms in the
command alone; at 5,000 it is projected at **~4 s of pure join work per trim**. In a workflow that trims
constantly, that is the dominant felt cost.

**Verified directly — trim and split are both global-recompute-bound, and trim is one-sided:**

| Finding | Evidence |
|---|---|
| `trim_extend_wall` ends with a **global** `recompute_wall_joins()` | `ifc_service.py:1046` |
| `split_wall` likewise | `ifc_service.py:1091` |
| Trim moves **one** wall's endpoint (`end_index` 0 or 1) onto the intersection of the two baselines, so it covers extend-and-trim **one-sided**; a corner where *both* walls need extending is not addressed in one operation | `ifc_service.py:1016-1053` |
| Split gives the new second-half wall a synthetic name `f"{name} (2)"` and inherits height, thickness and level — but the path shown does **not** transfer join policy, and openings are preserved only on the half that keeps the original GUID | `ifc_service.py:1055-1099` |

This is why Phase 1 precedes Phase 3: making trim correct before making it fast would produce a correct
operation that is unusable at scale, and making it fast first means the trim semantics work in Phase 3 has
a budget to meet.

**3. The dimension chain becomes a first-class deliverable, and it is mostly missing.** Verified by
execution in `review/AUDIT-dimension-editing-vs-revit.md` (28 probe-confirmed findings):

| Dimension capability | State |
|---|---|
| Render a dimension with witness + dimension lines | **PRESENT** — `PlanViewport2D.tsx:773-870` |
| Padlock a dimension → become a persistent constraint, and **the constraint genuinely holds and propagates** | **PRESENT** — `add_dimension_lock` + `_solve_constraints_after_move` (`ifc_service.py:2460`, `:2110`). **[PROBED]** locking A↔B at 10 ft then moving A made B follow with the distance held, and re-valuing the lock to 15 ft was honoured. |
| **Edit a permanent dimension's text and drive the model** | **ABSENT** — `DI` is `implemented: false` (`toolCaptions.ts:40`); no bus command carries a dimension *value* | *(superseded — §0c: `DI` is `implemented: true`, and `DimensionValueSet` now carries the value; the `DI` tool creates and edits persistent dimensions)* |
| Dimensions as document objects with identity and references | **ABSENT** — renderer output with `guid: None`, and the dimension list is derived by **regex over its own SVG path strings** (`ifc_service.py:4311-4364`) |
| The one editable dimension measures the right thing | **ABSENT (wrong quantity)** — it is a 2D **bbox-centre-to-nearest-element** distance, so it changes when an unrelated element is added, and for a 10 ft wall it read **9.144**. Editing it calls `WallMove` with a derived delta: **[PROBED]** the wall's length stayed **10.000** while it moved. "Type a dimension, the wall becomes that long" is not what happens. |
| Witness lines | **PARTIAL** — drawn for auto-extents; `witnessP1/P2` are written and **never read** (`PlanViewport2D.tsx:799-817` vs `useBimStore.ts:1016-1017`) |
| Dimension **chain** across several walls, with EQ | **ABSENT** — one width + one depth for the whole drawing; EQ is a hardcoded per-window action |
| Grid / level dimensions as controls | **ABSENT** — levels are never drawn (the plan contract has **no `levels` key** at all, `ifc_service.py:3894`); `LevelMove` works but has **zero callers in `src`** |
| Text rotated on angled walls | **ABSENT** — and grids/slabs/roofs are never rotated while `plan_rotation` is emitted and ignored |
| Correct dimensions units | **BROKEN, and worse than one line** — see below |

**The units defect is structural, not a typo, and it breaks exactly this workflow.** Three separate
facts, all measured:

1. `ifc_service.py:3767` prints `f"{length:.2f} m ({length * 3.28084:.1f}')"` while `length` is already
   decimal feet → a 30 ft wall reads **"30.00 m (98.4')"**. `3.28084` occurs exactly **once** in
   `backend/` and **zero** times in `src/`, so that line is the complete list for *text*.
2. Underneath it, `_build_element_mesh` returns `shape.geometry.verts` with `USE_WORLD_COORDS` and
   **never converts** (`ifc_service.py:3458`, `:3492`), so **mesh geometry is metres while `params` are
   feet**. Isolated synthetic proof: a 0→10 ft wall yields a mesh bbox centre of **1.524 = 5.0 × 0.3048**
   exactly. The 2D slice paths *are* converted (`_scale_path(..., metres_to_feet)` at `:3973`, `:4130`).
3. The consequence lands on the primary interaction: the temporary dimension reads distance from **metre**
   bboxes and applies it as **feet**, so it shows **`9'-2"` for a real 30 ft spacing**, and typing a value
   applies a 3.28×-wrong delta (**[PROBED]** typed `12.0` → delta `+2.856` → re-derived `8.273`; it does
   not round-trip).

**Fix the units boundary first. Every dimensional feature sits on it, and today it cannot round-trip.**

**The good news, and it materially changes the estimate: the solver work already exists.** Because
`add_dimension_lock` holds and propagates through `_solve_constraints_after_move`, this is **not** a
"build a dimension constraint engine" task. It is: (a) fix the units boundary, (b) give dimensions
identity in the overlay, (c) add two bus commands — `DimensionCreate` and `DimensionValueSet` carrying
the **value, not a delta**, (d) make the edit move the **referenced face** rather than translate the
element, (e) wire the UI. That is **M-scale, not L-scale** — the single largest estimate change in this
plan.

**Two further verified defects in the trim/split family** (see Phase 3 for the fixes):

| Defect | Evidence |
|---|---|
| Trim is **one-sided**: only the named wall's endpoint moves, and it lands on the target's **infinite baseline** — so two walls that do not reach each other yield an endpoint that the target's body does not occupy. **[PROBED]** A correctly went 12→8 ft while B was untouched at y −6→6 | `ifc_service.py:1016-1053` |
| Split **strands hosted openings**: splitting a 20 ft wall at 10 with a door at offset 15 leaves the door hosted to the original — now 10 ft — wall, at offset 15, **outside its own host**, with zero openings on the new half. This is the spec's own §17 "wrong building, not a wrong line" class | `ifc_service.py:1055-1099` |

---

## 2. Architecture decisions (the Rust seam)

These are decided here because they are cheap now and expensive later.

**A1 — One geometry pipeline, not three.** Three 2D paths coexist: `mesh_hlr.py`, `hlr_renderer.py`
(ifcopenshell SVG serialiser), and an analytic slicer inside `ifc_service.py`. Freeze to **one** behind a
single interface: input = triangulated buffers + view definition; output = the existing path contract.
Delete or quarantine the other two behind a debug flag.

**A2 — Numeric interfaces at the seam.** No Python objects, closures or class instances cross the
geometry boundary. Flat arrays in (`array('d')` / numpy), plain dicts and JSON out. This is what makes
the Rust port a translation rather than a rewrite, and it is also what will make the hot path fast in
Python first.

**A3 — Invalidation becomes data, not control flow.** Today `_invalidate_geometry_cache` is called from
four different places and `mark_mesh_dirty` from more. Replace with a single **revision counter + dirty
set** owned by the document, read by every cache. Rust needs this shape anyway; Python cannot afford the
call-site scatter.

**A4 — Dimensions become overlay objects.** A `dimension` record in `parametric.json`: id, kind
(aligned/linear/angular/radial), ordered references (element GUID + which face/endpoint/plane), value in
decimal feet, lock flag, EQ group. The renderer draws them from the overlay instead of inventing them, and
editing one emits a typed command. This is the data model the workflow requires.

**A5 — Regeneration is incremental and pull-free in the engine.** A mutation marks dirty; regeneration
recomputes the dirty closure only; the transport ships deltas. No engine path may iterate all elements.

---

## 2b. One owner per item — how the four plans divide

Four plans were live at once, and they overlap where the same feature is both *semantics* and *gesture*.
One owner per item, so a reader never has to reconcile two statuses. **Two of the four are completed and
their plan files live in `review/archive/`** — the dimension-as-control and geometric-references plans below
are recorded here for ownership history, and their work is subsumed by this plan's Phase 2 and by
direct-manipulation Track A. The links point at the archived copies:

| Plan | Owns | Does not own |
|---|---|---|
| **`IMPLEMENTATION-PLAN-revit-feel.md`** (this) | Editing *semantics* and the performance that makes them usable: trim/split/extend, the type layer, sheets, chrome, and the dimension overlay's persistence and round-trip. Phases 0–7. | The gesture layer (no drag, grips or inference), and first-run testability |
| **[`IMPLEMENTATION-PLAN-direct-manipulation.md`](IMPLEMENTATION-PLAN-direct-manipulation.md)** | **Track A** — first-run and UI-surfacing blockers (§4, A1–A7). **Track B** — the IngeTrazo-style gesture layer: interaction session, drag session on the bus, grips, value entry and hot retype, inference, validity predicates (§5) | Dimension *semantics* (it consumes them), and the trim/split semantics of §20 |
| **[`IMPLEMENTATION-PLAN-dimension-as-control.md`](archive/IMPLEMENTATION-PLAN-dimension-as-control.md)** *(archived)* | Dimensions as **driving** objects: conflict reporting, the locked path, EQ/chains, the solver's refusal channel | The dimension *overlay* (this plan, 2.2–2.3, done) and the `DI` tool (direct-manipulation A7) |
| **[`IMPLEMENTATION-PLAN-geometric-references.md`](archive/IMPLEMENTATION-PLAN-geometric-references.md)** *(archived)* | The shared **reference primitive** — witness points, re-resolution, `reference_key` stability — consumed by all three | Anything with a viewport |

Three consequences worth stating, because they were live contradictions:

1. **This plan's Phase 2 is finished except grid spacing** *(corrected by §0c)*. 2.2–2.6 and 2.8 are done in
   backend and bus, and the `DI` tool is now `implemented: true`, so 2.4 and 2.6-interactive are reachable
   by hand. Only **2.7 grid spacing** remains. Do not re-open the rest here.
2. **This plan's Phase 4 is finished in 2D and was out of scope in 3D — and that is now closed**
   *(corrected by §0c)*. 4.2–4.5 are done in `PlanViewport2D`; the 3D viewport no longer holds any inline
   `Math.round(x * 2) / 2` quantisation (**0** left, was 16) and now imports the snap engine.
   Direct-manipulation Track B P0 completed it.
3. **This plan's 3.5 is decided and ✅ DONE** *(closed by W8)*. 3.5.2 is done and correct; 3.5.1
   covers **50 of 50** commands with 0 fallback to snapshot. Probe check G passes 7/7 with 0 fallback.
   Owner of the decision: `docs/DECISION-live-edit-transaction-unit.md`.

---

## 3. Phases, with gates

Effort key: **S** ≤ 1 day · **M** ~1 week · **L** 2+ weeks.

### Phase 0 — Instruments and honesty (S) — *nothing else can be verified without this*

**STATUS: 0.1 ✅ · 0.2 🟨 PARTIAL (gates exist; §20.1 variation unmet — §0b) · 0.3 ✅ · 0.4 ✅ · 0.5 ✅ closed (superseded by 3.5.2 — §0b)**

| # | Task | Why | Status |
|---|---|---|---|
| 0.1 | **Scale gate**: a parameterised benchmark at N ∈ {200, 1000, 2000, 5000} measuring one wall edit end-to-end (join, slice, transport), **asserting** p95 latency — not reporting. Reuse the measurement probes already in `scratch/_probe_*.py`. | The spec's §19 budgets have never been measured above 25 elements. Every claim in this plan is currently extrapolation; this converts it to a curve you own. | **✅ `fa9446a`.** `scratch/test_scale_gate.py`. Enforces the 16 ms §19 budget at N≤100 and applies a 30 ms anti-regression guard at N=200 by default; also guards the cache and the view-rebuild ceiling, and reports N=500 explicitly rather than asserting it. |
| 0.2 | **Dimension/trim gate**: fixtures that assert trim-to-corner geometry, split preserving hosted openings, and dimension-edit propagation. Must vary thickness, angle, and join mode (§20.1's meta-test rule). | The workflow's core operations have no falsifiable tests today. | **🟨 PARTIAL (verified §0b/§0c).** The fixtures exist in `scratch/test_trim_split_gate.py` (30/30) and `scratch/test_dimensions_crud.py` (201 checks). But the §20.1 variation requirement remains unmet — the trim/split fixtures vary thickness only, never angle or join mode. |
| 0.3 | **Fix the units boundary — not just the label.** `ifc_service.py:3767` mislabels decimal feet as metres; underneath it, mesh geometry is metres while `params` are feet, which is why the one editable dimension shows `9'-2"` for a real 30 ft spacing and cannot round-trip. Fix the boundary (or the single conversion point), then audit every length-emitting site. | Every dimensional feature sits on this; it is the cheapest high-value fix in the plan and it currently mislabels every number on every drawing. | **✅ `b6b3cdd`.** Three defects, not one: mesh unit, a self-amplifying cache, and `mesh_hlr` fed the wrong unit. Also `format_feet_inches` rounded to a 3/4" grid. Gate: `scratch/test_units_boundary.py` (27 checks). |
| 0.4 | Stop the **Project Browser and Ribbon showing seed literals** on load — `/api/state` already returns `views` and `sheets`. | Makes the app's own state trustworthy while the rest is rebuilt. | **✅ `73b7dbb`.** `App.tsx` now calls `fetchStateBundle()` on mount instead of `fetch2DSlice()`. |
| 0.5 | **Do NOT bind Ctrl+Z/Ctrl+Y yet.** Undo serialized the whole IFC to STEP twice per transaction. | At 5,000 elements the undo stack was projected at **GBs**; shipping the keybinding first would have handed users a button that hangs and then crashes the engine. Bind it in Phase 3.5. | **✅ CLOSED 2026-10-16 — superseded by 3.5.2.** The keybinding *is* bound now (`src/App.tsx:53`, `:62`), which is correct because 3.5.1 landed (50 of 50 commands use mementos — §0). Do **not** unbind it. The old two-snapshots-per-transaction description is the pre-memento design; see §0 and `docs/DECISION-live-edit-transaction-unit.md`. |

**Exit:** gates run and fail meaningfully on injected regressions ✅; a 5,000-element curve exists ⬜
(measured to 484; 961 measured in an earlier pass, 5,000 never run — see §0a.2).

### Phase 1 — Make trim and dimension edits fast (L) — *the felt bottleneck*

**STATUS: 1.1 ✅ · 1.2 ✅ · 1.3a ✅ · 1.3b ✅ · 1.3c ✅ · 1.4 ✅ (verified §0b) · 1.5 ⬜**

| # | Task | Expected effect | Files | Status |
|---|---|---|---|---|
| 1.1 | **Route every mutation through the dependency graph.** `translate_element`, `update_element`, trim, split and level move must call `DependencyGraph.recompute([guid])`, not the global `recompute_wall_joins()`. | Removes the dominant term: 992 ms → ~190 ms/tx at N=1000 | `ifc_service.py:2022`, `:2359`, `:2796-2821` | **✅ `cc213fc`.** Done differently from the plan: `DependencyGraph` was *not* used (its `join` edge keys on exact shared endpoints with 1e-6 tolerance, which misses tee joins). The radius is derived from the wall's OLD and NEW endpoint positions via the join index. 82.8 → 3.3 ms at 196 walls. |
| 1.2 | **O(1) join-partner lookup** via a coordinate-keyed endpoint index (the graph already has the shape at `dependency_graph.py:93-98`). | Kills the 2,004,002-visit scan; removes the N² term entirely | `ifc_service.py:2767` | **✅ `48ad6be`.** Two grid buckets (`endpoints`, `baselines`), superset candidates in `walls` order. Per-element cost went flat: 0.33→0.37 ms/wall from 100 to 961 walls. |
| 1.3 | **Incremental 2D view.** Revision-keyed cache of the composited contract per (view, revision); re-project only dirty GUIDs; replace the O(N²) view-depth closure with a spatial index; **bound the occluder set geographically** — the profile shows 76 % of slice time is GEOS `union_all` called ~4× per element against a growing occluder union. | 17,509 ms → target low hundreds of ms at N=1000; makes 5,000 conceivable | `mesh_hlr.py:116-164`, `:231-266`, `:390-476`, `main.py:1062` | **✅ a `73b7dbb`** (revision-keyed contract cache: 542 → 6 ms). **✅ b `e3216fe`** (per-mesh union cached once; occluder bounded per mesh: cold slice 945 → ~250 ms; `union_all` 783 calls/525 ms → 392/20 ms). **✅ c** — incremental `_prepare` & `cut_at` per-mesh caches. Plan cache miss at 484 walls drops from 679 ms to 60 ms. Gate: `scratch/test_mesh_hlr_incremental.py` (11 checks). |
| 1.4 | **Scope the constraint solve** to the affected component. | 31 participants → 3 in a 32-element probe | `constraint_solver.py:128-150`, `:224-250` | **✅ DONE (verified 2026-10-16, §0b).** `scope = solver.affected_guids([moved_guid])` (`ifc_service.py:3026`) then `solver.solve(..., scope=scope)`; transitive over `align`, `dimension_lock`, `length_lock`. |
| 1.5 | **Delta transport for the slice.** Stop shipping the full storey's linework per edit (99.6 % of a 444 KB delta at N=200). Ship only changed paths. | delta 444 KB → ~2 KB | `main.py:1030-1109` | **⬜** untouched. Note the slice is now small in *time* but the payload question is separate and unmeasured since these changes. |

**Exit:** one wall edit at **2,000 elements** completes in < 50 ms end-to-end, asserted by 0.1. Trim and
dimension edits are in the same envelope.

**Actual at `e3216fe` / `revitUI`:** 12.2–26.9 ms at 196 walls (~16.3 ms under load, exceeding the §19 16 ms budget; guarded by the 30 ms regression threshold), 31.6–38.3 ms at 484 (**still over**).
N=2,000 not measured. The §19 16 ms budget is therefore **met at N≤100, while N≈200 is protected against regressions by the 30 ms guard**.

### Phase 2 — Dimension-driven editing (M, reduced from L) — *the user's primary control*

**STATUS: 🟨 PARTIAL (Backend CRUD, parametric overlay, level editing, bus commands and the interactive DI tool ✅ DONE; grid spacing dimension edit deferred).** *(DI corrected from deferred to DONE by §0c.)*
Persisted dimension overlay, `Dimension*` bus commands, in-canvas inline dimension editor with `tryParseLength`, baseline resizing preserving unanchored endpoints, level datum lines in elevations/sections with interactive `move_level` editing, rotated dimension text on angled walls, real witness lines on selection, and dimension chains with EQ. Gates: `scratch/test_dimensions_crud.py` — **190 checks at `ec2c99c`**, up from 53 — and `scratch/test_pure_python_solver.py` (13/13).

| # | Task | Notes |
|---|---|---|
| ~~2.1~~ | ~~**Fix the units boundary**~~ | **✅ DONE in Phase 0.3 (`b6b3cdd`).** All three sub-defects (mesh unit, self-amplifying cache, `mesh_hlr` unit) plus `format_feet_inches`. Gate: `scratch/test_units_boundary.py`. Nothing to do here — do not re-fix it; if a dimension still fails to round-trip, that is a **new** defect, not this one returning. |
| 2.2 | **Dimension objects in the overlay** (A4): id, kind, ordered **references** (element + face/endpoint/plane), axis, offset, value, lock flag, EQ group; persisted and round-tripped; bump `constraints_rev`/`project_rev` on change. | **✅ DONE.** `self.dimensions`, `self.dimensions_rev`, and `self.constraints_rev` increment on create/set/delete, persisted in `parametric.json` overlay, round-tripped on load/save container, and output in `_finish_plan_contract`. Gate: `scratch/test_dimensions_crud.py`. |
| 2.3 | **`DimensionCreate` and `DimensionValueSet` bus commands.** `DimensionValueSet{dimension_id, value}` carries the **value, not a delta**. | **✅ DONE.** `DimensionCreateParams`, `DimensionValueSetParams`, `DimensionDeleteParams` registered in `command_bus.py:COMMAND_REGISTRY` and executed through `CommandBusEngine`. Gate: `scratch/test_dimensions_crud.py`. |
| 2.4 | **Render real dimensions and edit the text in place** — reuse the existing witness/dimension-line drawing (`PlanViewport2D.tsx:799-846`) and the genuinely good `tryParseLength` (`src/utils/units.ts:145-212`, handles `12'-6"`); replace the detached top-centre HTML pill with in-canvas entry. | **✅ DONE** *(was ⬜ PARTIAL — corrected by §0c)*. In-canvas inline editor on temporary selection dimensions committing via `setDimensionValue` with `tryParseLength`, **and** interactive creation of persistent overlay dimensions is live: `DI` → `createDimension` (`PlanViewport2D.tsx:611`) → `DimensionCreate`, rendered from the payload at `:1295`. |
| 2.5 | **Edit moves the referenced face, not the element.** Extend `_solve_constraints_after_move` (`ifc_service.py:2110`) to move the referenced endpoint **along the baseline** (a length change), reusing the endpoint maths already in `trim_extend_wall`. Do **not** reuse the temporary-dimension translate semantic (`useBimStore.ts:1066-1077`). | **✅ DONE.** `set_dimension_value` resizes wall along baseline (`_resize_wall_length`), preserving unanchored endpoint position, updating length and mesh, reseating hosted openings, incrementally recomputing joins, and propagating constraints. Gate: `scratch/test_dimensions_crud.py`. |
| 2.6 | **Dimension chains with EQ** — a linear string across N walls; editing one segment redistributes with locked segments and EQ groups honoured. Reuse the verified lock propagation; do this **after** 2.2–2.5, never before. | **✅ DONE (Backend / Bus) / ⬜ PARTIAL (UI).** Chained dimensions with `refs` and `eq_group` registered in overlay; `ConstraintEqualize` bus command and `equalize_span` redistribute both multi-wall spans and single-wall hosted openings without collapse. Interactive in-canvas multi-segment chain dragging in UI is deferred. Gate: `scratch/test_pure_python_solver.py`. |
| 2.7 | **Grid and level dimensions as controls.** Add a `levels` key to the plan contract (it does not exist — `ifc_service.py:3894`), draw level lines, expose `LevelMove` (zero callers today), make grid spacing editable by dimension. | **⬜ PARTIAL.** `levels` contract key generated for elevations/sections with datum lines, bubbles, and interactive in-canvas elevation text editing via `set_dimension_value` / `move_level`. Grid spacing editable by dimension is deferred (grid click selects only). Gate: `scratch/test_dimensions_crud.py`. |
| 2.8 | Witness/extension lines from **real references** (`witnessP1/P2` are written and never read); rotate text on angled walls; feet-inch formatting everywhere. | **✅ DONE.** Rotated dimension text aligned with baseline on angled walls (clamped to readable range [-90°, +90°]); in-canvas temporary selection dimensions with witness lines from real references (`witnessP1/P2`); feet-inch formatting across annotations. |

**Exit:** draw rough walls → trim into corners → select a dimension → type `12'` → the wall **resizes**,
its neighbours re-solve, joins stay intact, hosted openings follow, and the value round-trips exactly.
Asserted by gate 0.2.

### Phase 3 — Trim / split / extend with Revit semantics (M)

**✅ DONE.** Gate: `scratch/test_trim_split_gate.py` (30/30 checks passed).

| # | Task | Notes |
|---|---|---|
| 3.1 | **Trim-to-corner moves BOTH walls** and applies the join, and clamps to the target's **body** rather than its infinite baseline. Today only the named wall moves, and two walls that do not reach each other produce an endpoint the target does not occupy (`ifc_service.py:1016-1053`). | **✅ DONE.** Two-wall corner trim calculates intersection, moves both wall endpoints to corner, and recomputes wall joins (`corner_trimmed`). Single trim clamps hit to target body segment. (Note: corner trim extends/trims walls to baseline intersection rather than clamping within pre-existing segment bounds). Gate: `scratch/test_trim_split_gate.py`. |
| 3.2 | **Split must re-host or refuse.** A door at offset 15 on a wall split at 10 currently stays hosted to the shortened half, **outside its own host** (`ifc_service.py:1055-1099`). Re-host openings onto the correct half, and **refuse the split** when an opening straddles the cut — silently stranding an opening is the §17 failure class. Carry join policy to the new half. | **✅ DONE.** `split_wall` strictly refuses cuts straddling openings; re-hosts openings past cut offset onto new wall with adjusted `offset_along_wall` and updated `IfcRelVoidsElement`; carries join policies and uses scoped join recomputation. Gate: `scratch/test_trim_split_gate.py`. |
| 3.3 | **Split-with-gap**, and join state preserved across the split. | **✅ DONE.** `split_wall` supports `gap` parameter (default 0.0, or 0.5/1.0 ft), trimming original wall to `offset - gap/2` and placing new wall from `offset + gap/2`. Gate: `scratch/test_trim_split_gate.py`. |
| 3.4 | **Hotkeys and picks** — `TR`, `SL`, `SO`, `DI` reachable from the ribbon and by two-letter sequence, with Revit's pick-two-elements gesture. None are bound today, and the store methods have zero callers. | **✅ DONE** *(was ⬜ PARTIAL — corrected by §0c)*. `TR`, `SL`, `SO` **and `DI`** are all in `ActiveTool` with hotkey bindings, Ribbon buttons in the Modify panel, and in-canvas pick gestures in `PlanViewport2D.tsx`; `implemented: true` at `src/interaction/toolCaptions.ts:44`. |
| 3.5 | Extend/trim to a **grid line or level** (the datum-driven version of the same operation). | **✅ DONE.** `trim_extend_wall` detects grid datum lines and level elevations, moving wall endpoints or adjusting wall height to match datum. Gate: `scratch/test_trim_split_gate.py`. |

### Phase 3.5 — Survive a working session (M)

**✅ DONE — closed by W8 (probe check G green: 50 of 50 commands declare a memento).** 3.5.2 is done and correct; 3.5.1 covers **50 of 50** commands (0 fall back to snapshot). Gate: `scratch/test_session_undo_memento.py` (12/12 passed) and `scratch/_probe_engine_smoke.py` check G (0 fallback). 500 sequential edits completed in 4.73 s (9.46 ms/tx), peak memory 1.06 MB (< 25 MB ceiling).

| # | Task | Notes |
|---|---|---|
| 3.5.1 | **Command-scoped mementos** replacing the two full `snapshot_state` copies per transaction. | **✅ DONE.** `CommandMemento` pattern in `command_bus.py` executing localized reversible closures for all 50 registered commands (closed by W8; probe check G: 0 of 50 fall back to snapshot). Stack capped by count (200), not bytes. Decision: `docs/DECISION-live-edit-transaction-unit.md`; gate V1 is probe check G (7/7 passed). |
| 3.5.2 | **Then** bind Ctrl+Z / Ctrl+Y, and add journal persistence. | **✅ DONE.** Bound `Ctrl+Z` (Undo), `Ctrl+Y` / `Ctrl+Shift+Z` (Redo) in `App.tsx` calling `/api/transaction/undo` and `/api/transaction/redo` with full state bundle refresh. |

**Exit:** 500 sequential edits at 2,000 elements without unbounded memory growth.

### Phase 4 — Draw-and-place feel (M)

**🟨 PARTIAL.** Verification: `npm run check` (618 assertions at `ec2c99c`, exit 0; 924 at `7251a44` — §0c) and full TypeScript compilation (`npx tsc --noEmit`).

| # | Feature | Notes |
|---|---|---|
| 4.1 | **Typed snap candidates** | **🟨 PARTIAL / ✅ DONE (Engine).** Pure `snapEngine.ts` module with candidate types: `grid`, `endpoint`, `midpoint`, `intersection`, `perpendicular`, and `extension` (collinear extension of segments beyond their endpoints). Priority hierarchy: intersection > endpoint > midpoint > perpendicular > extension > grid. Zero React/DOM dependencies so it runs in tests and worker threads identically. Automated gate in `scripts/check-snap-engine.mjs` (wired into `npm run check:snap` and `npm run check`) and `scratch/test_snap_engine.py` (20/20 checks passed). Visual SVG snap glyph overlays in `PlanViewport2D.tsx` remain deferred. |
| 4.2 | **Snap toggle & override** | Store state `snapsEnabled`, toggle action `toggleSnaps()`, global `F3` hotkey bound in `App.tsx`, and interactive header button in `PlanViewport2D.tsx`. |
| 4.3 | **Hover pre-highlighting** | Mouse movement tracks nearest element and calls `setHoveredGuid(guid)`. SVG layer renders distinct cyan pre-highlight (`#38bdf8`) on hover for walls, slabs, roofs, grids, and levels. |
| 4.4 | **Window vs. Crossing selection & Tab-cycling** | Left-to-right drag produces solid blue **Window selection box** (enclosed elements only); right-to-left drag produces dashed green **Crossing selection box** (intersecting elements). `Ctrl`-click / drag adds to `selectedGuids`. `Tab` key cycles through hover candidate elements under the cursor without registering invalid viewport keydown listeners. |
| 4.5 | **Modeless placement polish** | Wall chaining supports continuous multi-segment drawing. Live ghost placement previews for doors (`DR`) and windows (`WN`) project along the nearest host wall baseline with swing arc and host offset dimension text. |
| 4.6 | **In-canvas temporary dimensions** | **⬜ PARTIAL.** Temporary dimensions appear on selection with inline in-canvas editor supporting Revit `12'-6"` syntax. Witness lines use real face/baseline references for walls; non-wall elements fall back to bounding-box centers. |


### Phase 5 — Type layer (L)

**✅ DONE.** Gate: `scratch/test_type_layer_gate.py` (34/34 checks passed).

`type_registry` + `type_id` on elements + `TypeCreate`, `TypeUpdate`, `TypeDuplicate`, `ElementSetType` bus commands with command-scoped reversible mementos; serialized to IFC as `IfcWallType`, `IfcDoorType`, `IfcWindowType` with `IfcRelDefinesByType` and `Pset_*Common`; category-filtered Type Selector combobox in Properties Palette; interactive Revit-feel `EditTypeModal` with parameter table (thickness, width, height, fire rating, function, cost, description), compound structure layers table, and live SVG compound cross-section preview with hatching and dimensions; type→instance parameter propagation recalculating geometry, invalidating meshes, and re-solving joins.

### Phase 6 — Sheet management (M)

**✅ DONE.** Verification: `npm run check` (618 assertions at `ec2c99c`, exit 0; 924 at `7251a44` — §0c) + `scratch/test_sheets_pdf.py` (95/95 checks).

Sheet list in Project Browser with `+ New Sheet` auto-numbering (`A101`, `A102`...) and sheet deletion; in-place title block editing (Sheet Number, Sheet Title, Drawn By) via inline SVG inputs committing to `SheetUpdate` bus command; interactive viewport dragging and hover deletion; batch vector PDF export set (`exportBatchPdf` serializes each sheet with its own title block, metadata, and viewports); real Schedule viewer modal with Wall, Door, and Window schedules, computed quantities (length, area, volume, fire rating), and CSV export.

### Phase 7 — Chrome (M)

**🟨 PARTIAL.** Verification: `npm run check` (618 assertions at `ec2c99c`, exit 0; 924 at `7251a44` — §0c) + all Python gate suites.

Interactive Revit Options Bar (`OptionsBar.tsx`) positioned below ribbon with context-sensitive parameters based on `activeTool` (Wall height/level/location-line/chain/offset, Door/Window sill height and tag toggle, Align multi/lock, Trim modes, and selection modify options); right-click context menu (`ContextMenu.tsx`) in both 2D and 3D viewports with "Create Similar" (`CS`), "Select All Instances" (visible in view / entire project), "Flip Orientation / Swing", "Delete", and "Zoom Extents" (`ZE`/`ZA`); contextual teal/green ribbon tab label (`Modify | Walls`, `Modify | Doors`, etc.) switching to general Modify panel (element-specific tool panels deferred); remaining Revit hotkeys (`CS`, `WT`, `ZA`, `ZE`, `MD`); Selection outline, visual endpoint grip circles, and interactive baseline flip arrows in 2D plan (interactive endpoint dragging deferred).

---

## 4. Order, and the reasoning

```
Phase 0 (days)      instruments + the units bug        ✅ 0.2 🟨 (gates exist, §20.1 variation unmet)
   ↓
Phase 1 (weeks)     kill the two O(N²) paths            ✅ 1.1, 1.2, 1.3a/b/c, 1.4 done
   ↓
Phase 1 remainder   1.5 ⬜ (slice delta transport)
   ↓
Phase 2 (weeks)     editable dimensions                 🟨 PARTIAL (Backend, Bus, in-canvas edit & DI ✅; grid spacing ⬜)
   ↓
Phase 3 (week)      trim/split semantics                ✅ DONE (3.1–3.5 all live)
   ↓
Phase 3.5 (week)    undo that survives 5,000 elements   ✅ DONE (50/50 mementos, 0 fallback)
   ↓
Phase 4 (week)      draw-and-place feel                 🟨 PARTIAL (4.2–4.5 ✅; 4.1 SVG glyphs & 4.6 non-wall ⬜)
   ↓
Phase 5 / 6         types; sheets                       ✅ DONE (Phase 5 & Phase 6)
   ↓
Phase 7             chrome                              🟨 PARTIAL (Options Bar, Context Menu, Hotkeys ✅; contextual panels/endpoint drag ⬜)
```

Three reasons for this order specifically:

1. **Phase 1 before Phase 2.** A dimension edit triggers exactly the recompute that is currently O(N²). At
   5,000 walls that is seconds per edit, so an editable-dimension UI built before Phase 1 would be a
   feature that cannot be demonstrated — the same trap as building drag first.
2. **Phase 0 before everything.** The 5,000-element figure in this plan is *extrapolated* from a sweep
   that stopped at 1,000. Gate 0.1 is what turns it into something you can trust and regress against.
3. **Phase 3.5 before the keybinding, not after.** Undo is a correctness risk at this scale, not a
   nicety.

**What can run in parallel from day one:** Phase 5 (types) and Phase 6 (sheets) are independent of the
performance track — they touch the model's *shape*, not its hot path. If there is a second pair of hands,
that is where they go.

**Revised after execution (read this, it changes the plan's advice):**

1. **Reason 1 (Phase 1 before Phase 2) held and has now been satisfied.** The dependency was real: a
   dimension edit triggers the recompute that was O(N²), and at 484 walls that was seconds. It is now
   ~3 ms for a wall edit, so **Phase 2 can start immediately — it is no longer gated.**
2. **Phase 1 is NOT finished, and Phase 2 does not need it to be.** Only 1.3c/1.4/1.5 remain, and none of
   them block the dimension work. **Do not serialise Phase 2 behind the rest of Phase 1.** The measured
   headroom at N≈200 (0.76× budget) is where most editing actually happens today.
3. **New sequencing advice from what was learned:** when the owner's first-choice feature is blocked only
   by a *sub*-task, unblock the sub-task and start the feature — that is exactly what happened with the
   units boundary, which was one line of Phase 2's original scope and turned out to be the whole
   prerequisite. The plan's original ordering would have run all of Phase 1 first.

**Recommended next session (superseded 2026-10-16 — see §0b).** All three items named here have landed:
1.3c is done (per-mesh `_prepare`/`cut_at` caches), Phase 2's backend and bus are done, and 3.2 (split
stranding a hosted opening) is fixed and gated. What is actually left in this plan is **1.5** (slice
delta transport — untouched, and the only Phase 1 item still open), plus the UI halves of Phase 2 and
Phase 4, which now belong to `IMPLEMENTATION-PLAN-direct-manipulation.md` (§2b) — chiefly the `DI` tool,
without which the dimension work cannot be exercised by hand at all.

---

## 5. Risk register

| Risk | Mitigation | Re-verified at `e3216fe` |
|---|---|---|
| The 5,000-element target proves unreachable in Python even after Phase 1 | Gate 0.1 gives an early, honest answer. If the incremental design still misses, the fallback is **per-view geometry residency** (only the active view's elements tessellated) — a real but bounded loss of fidelity. Decide this on data, not on optimism. | **Still open and now the main risk.** N=484 is 1.98× over budget; 5,000 never measured. The trend is linear per element, which is encouraging, but do not claim the target is reachable until 1.3c lands and the sweep is re-run. |
| Dimension chains need solver behaviour the current planegcs wrapper cannot express | Phase 1.4 scopes the solve first; if a chain is not expressible, ship edit-one-dimension (2.2–2.5) and defer chains (2.6) rather than blocking. | **De-risked.** Lock propagation is probe-confirmed working, and the single-dimension case (2.2–2.5) does not need the solver work at all. |
| Three 2D pipelines drift further apart | A1 freezes them at Phase 1.3; the scale gate covers whichever path is default. | **Partially done.** `_meshes_for_projection()` was added as the single metric accessor for the projector; the three renderers still coexist. |
| The Rust port is derailed by Python-only abstractions | A2/A3 are enforced by review, and the Phase 1 work is deliberately written as numeric-array in / plain-dict out. | **Held.** The new code passes plain lists and dicts; the join index and plan cache are data, not control flow. |
| Undo memory crashes a long session before 3.5 lands | 0.5 kept the keybinding unbound until 3.5.1; both are now **closed** — Ctrl+Z/Ctrl+Y are bound (`App.tsx:53`, `:62`) and mementos cover all 50/50 commands (closed by W8, probe check G green; 0 fallback). | **✅ Resolved** — 50/50 commands declare mementos, 0 fallback to snapshot. |
| **NEW: a conservative cache is mistaken for a correct one** | Both new caches (plan contract, prepared geometry) can be keyed wrongly in a way that produces *silently stale* drawings, which no existing suite would necessarily catch. | The plan cache folds sorted GUIDs into its key and is guarded by "repeat request served from cache". **1.3c will add a second such cache — it must carry an equivalence test like `test_join_incremental.py`, not just a speed assertion.** |
| A dimension edit changes a value in a way the solver silently cannot honour | Reuse the **verified** `add_dimension_lock` propagation rather than writing a new solve; assert round-trip (typed value == re-read value) in gate 0.2, which the current temporary dimension fails by 3.28×. |

---

## 5a. On reverse-engineering evidence: what REA can and cannot reach

The plan's §1 previously banned binary analysis of Revit. It is worth recording exactly what is
*reachable* on this workstation, because the answer is uneven and it determines which questions can be
settled by evidence versus by design choice. All of the following was verified on 2026-10-14.

**Works, and is genuinely useful:**

| Capability | Evidence |
|---|---|
| **Native PE string inventory** (real Ghidra analysis, real strings) | `rea search <dll> --kind strings`. On the 1.27 MB `Revit_NT_RevitUI.dll` this returned a real inventory, e.g. `String_Revit_ActivateDimensions`, `Control_Revit_ActivateDimensions`, `String_Revit_LinearDimensionStylesWsname`, `String_Revit_LooseLabeledDimensionRegenFailure` — interesting precisely because it shows the *regen* coupling of dimensions. |
| **Native binary overview** | `rea inspect` reproduced the documented 2010 figures exactly: image base `0x10000000`, 7 segments, `.text` 574,464 B, **11,071 procedures, 9,263 strings**. |
| **Managed PE identity, no Ghidra needed** | `rea inspect-managed-artifact` succeeds on the large assemblies and reports runtime version, CLI flags, metadata RVA/size. |

**Does not reach, and will not be retried:**

| Limitation | Detail |
|---|---|
| **Procedure-name search on large native modules** | `rea search <RevitDB.dll> --kind procedures` **timed out at 330 s** (`provider_timeout`) during Ghidra auto-analysis of the 45 MB module. This is the same wall the corpus documented for the 21.5 MB 2010 `RevitDB.dll`. The snapshot flag does not rescue it — a session is only served *after* default auto-analysis completes. |
| **Procedure-name search generally, without PDBs** | `--kind procedures` returned **zero hits** even on the small module, and the tool's own limitations say this proves nothing: "an empty name search does not prove a procedure is absent", because no PDB symbols are recovered (`RevitUI.pdb` is referenced but load state unknown) and REA does not admit a caller-supplied PDB. |
| **Managed member inspection on the shipping API assemblies** | `inspect-managed-members` on Revit 2026 `RevitAPI.dll` (35 MB) fails `resource-limit` at offset 22,787,417 — the **64 MiB representation budget**, exactly as documented for 2010. It fails on 2010 (14.8 MB), 2026 (35 MB) and by extension 2027. |
| **The small satellite assemblies are a dead end for logical API types** | `RevitDBCoreAPI.dll`, `RevitUIAPI.dll`, `RevitAPIFoundation.dll`, `RevitAPIUI.dll` *do* admit metadata (`status: complete`) — but they are C++/CLI **implementation** bridges: their type list is dominated by `<CppImplementationDetails>` and fixed-size array specialisations (`$ArrayType$$$BY07$$CB_W`), not the `Autodesk.Revit.DB.*` logical surface. |

**Conclusion for this plan.** REA is the right instrument for *native, mid-sized* modules and for string
and export-table evidence, and it is not a route to Revit's dimension or trim semantics at any acceptable
cost — that answer lives inside a 45 MB native `RevitDB.dll` that Ghidra cannot analyse inside REA's
budget. For behaviour questions the plan should therefore rely on:

1. **live probes in installed Revit** (2026 and 2027 are both installed on this workstation), which is
   the only way to observe *behaviour* rather than *structure*; and
2. the **existing corpus**, whose `[REA]` findings the spec already cites; and
3. **this plan's own fixtures** (gate 0.2), which turn each disputed behaviour into an executable
   assertion about BIMWorks' own model.

That is a change from the earlier recommendation to restore REA as a first-class source: REA is worth
keeping for native/string work, but the *dimension and trim semantics* this plan depends on are better
settled by probe and by test than by decompilation.

---

## 6. Non-goals

Curtain walls, stairs, railings, topography, MEP, `.rvt` interop, a Family Editor UI, rendering quality
work, multi-user/sharing/coordination, and Revit-accurate chrome before flow.
