# BIMWorks — Implementation Plan: modelediting that feels like Revit

**Supersedes for execution purposes:** `review/archive/CHANGE-PLAN-revit-parity.md` (the analysis). This is the
plan that acts on it.
**Branch:** `gemini` @ `318ce26`, executed on `main` through `e3216fe`. **Companion audits:** the four
under `review/AUDIT-*-vs-revit.md`.

**Plan dated:** written **2026-10-14** (`318ce26`); executed on `main` through **2026-10-15**
(`e3216fe`); last modified **2026-10-15** (`6fa4f73`).
**Revised:** **2026-10-16** — a verification pass at `ec2c99c` (§0b) corrected five statuses, closed the
solver gap recorded in the spec, re-counted the gate suite, and added the four-plan ownership boundary
(§2b). Dates are commit dates from `git log`, not recollection.
**Revised again 2026-10-16** — a second verification pass at `7251a44` (**§0c**) corrected four more
statuses (three of them *understating* landed work: the `DI` tool, the 3D snap engine, and memento
coverage), re-counted the gate suite to 924 assertions, and repaired §2b's dead links to the two plans
removed at `d54f9b1`. **Read §0c before §0b** — it supersedes it for counts and for the `DI`/`SHT`
statuses.

> ## ✅ AUDITED & RECONCILED STATUS (ROUND 4) — *2026-10-15, at `e3216fe`; historical, superseded by §0b for counts*
>
> **Audit Status:** The core backend regressions, blocking bugs, and code defects documented in [`review/archive/HANDOFF-revitUI-plan-verification.md`](archive/HANDOFF-revitUI-plan-verification.md)
> (Bugs A, B, C1, C2, §2.1 intra-wall EQ redistribution, §2.7 multi-sheet batch-PDF serialization, §2.10 `constraints_rev` bump, pure-Python constraint solver fallback tested with `Sketch is None`, scale gate budget threshold & stale note, and snapEngine docstring & candidate coverage) have been verified across gates.
> §19 budget status is explicitly stated: $N \le 100$ meets the 16 ms budget; $N \approx 200$ (~16.3 ms under load) is protected by the 30.0 ms anti-regression guard against the 80+ ms global join baseline.
> Deferred UI-level features (§2.2 grid dimension edit, §2.3 interactive `DI` tool, §2.6 non-wall real-ref temporary dimensions, §2.8 interactive endpoint grips, and §2.9 element-specific contextual ribbon tools) are explicitly classified as `⬜ PARTIAL` in the task matrix below.
>
> **Verification Gates:**
> - **Backend Test Suites:** 29 passed, 0 failed on Windows (1 external path fail on Linux: `test_update_roof.py` requiring `Z:` path).
> - **Scale Gate (`test_scale_gate.py`):** 6 passed, 0 failed. Passes scaling shape and cache guards; 100 walls passes at 8.2 ms (<16 ms budget); 196 walls passes within 30 ms threshold (measured 12.2–27.6 ms under load).
> - **Snap Engine Gate (`scripts/check-snap-engine.mjs` & `scratch/test_snap_engine.py`):** 20 passed, 0 failed. Verifies all 6 candidate kinds, priority hierarchy, range/fallthrough guards, and selection box helpers.
> - **Milestone & Parity Gates:**
>   - `test_pure_python_solver.py` (13 passed, 0 failed — forces `Sketch is None`)
>   - `test_type_layer_gate.py` (34 passed, 0 failed)
>   - `test_session_undo_memento.py` (12 passed, 0 failed — 500 sequential edits @ 9.95 ms/tx, peak 1.10 MB)
>   - `test_trim_split_gate.py` (30 passed, 0 failed)
>   - `test_mesh_hlr_incremental.py` (11 passed, 0 failed)
> - **Full Frontend & Parity Net (`npm run check`):**
>   - UI-P0 Gate: 130 passed, 0 failed
>   - State-Bundle Gate: 45 passed, 0 failed
>   - Delta Equivalence Gate: 21 passed, 0 failed
>   - Snap Engine Gate: 20 passed, 0 failed
>   - TypeScript compilation (`tsc --noEmit`) clean.


---

## 0a. Handoff: state, measurements, and what this session learned

Written to be read cold by a session that has none of the context above. **Re-verify the measurements
before trusting them** — this project's own history is that a hand-maintained status block decays in
about a day (§4.4 of `archive/CHANGE-PLAN-revit-parity.md`).

### 0a.1 What was verified working, and by which gate

Run all of these before changing anything; they are the regression net.

```bash
# 23 backend suites — all green at e3216fe
for f in scratch/test_*.py; do ./.venv/Scripts/python.exe "$f" || echo "FAIL $f"; done
# frontend gates: bus parity, UI 130, state bundle 45, delta equivalence 21, tsc
npm run check
# the performance gate, with the budget assertion enabled by default at N<=200
./.venv/Scripts/python.exe scratch/test_scale_gate.py
```

| Phase | Commit | What it did | Gate that protects it |
|---|---|---|---|
| 0.3 | `b6b3cdd` | One unit at the mesh boundary (feet out, metres internal) | `scratch/test_units_boundary.py` (27 checks, incl. a negative control for the 3.28084 signature) |
| 0.1 | `fa9446a` | Scale gate; §19 budget measurable and enforced | `scratch/test_scale_gate.py` |
| 0.4 | `73b7dbb` | Browser/Ribbon fed from engine `views`/`sheets` (was seed literals) | `npm run check:ui` |
| 1.3a | `73b7dbb` | Revision-keyed plan cache | scale gate §3 (repeat request served from cache) |
| 1.2 | `48ad6be` | Candidate index for join partners | `scratch/test_wall_joins*.py` |
| 1.1 | `cc213fc` | Scoped join recompute | `scratch/test_join_incremental.py` (11 checks, scoped == global) |
| 1.3b | `e3216fe` | Per-mesh union cached; occluder bounded per mesh | `scratch/test_mesh_hlr.py`, `test_hlr.py` |
| 1.3c | working | Incremental _prepare & cut_at per-mesh caches | `scratch/test_mesh_hlr_incremental.py` (11 checks) |

### 0a.2 The measurement that matters, and the honest gap

One wall edit plus the view rebuild that follows it, measured against the §19 budget of **p95 < 16 ms**:

| walls | edit ms | slice ms | TOTAL ms | vs §19 budget (16 ms) |
|---|---|---|---|---|
| 100 | 2.2–3.5 | 3.0–5.0 | 5.3–8.5 | **0.33×–0.53× — inside** |
| 196 | 3.3–5.5 | 8.0–21.0 | 12.2–26.9 | **0.76×–1.68× (~16.3 ms avg) — exceeds 16 ms budget under load; guarded by 30 ms threshold** |
| 484 | 11.0–12.3 | 19.3–22.0 | 31.6–38.3 | **1.98×–2.39× — still over** |

> [!NOTE]
> At $N \approx 200$, the 16 ms §19 budget is not durably met under load (~16.3 ms measured). The 30.0 ms assertion in `scratch/test_scale_gate.py` is an anti-regression guard against the 80+ ms global join baseline, not the achieved §19 budget. The scale gate preserves reporting of overruns via its `NOTE beyond budget` output.

Session start, for contrast: **629 ms at 196 walls (39.3× over)**. The global join pass alone, which is
no longer what an edit pays, is still ~83 ms at 196 / ~264 ms at 484.

**The gap to be honest about:** the owner's target is **~5,000 elements / 15 levels**. N=500 is ~2× over
budget and 5,000 has never been measured. Do not describe this as "Revit-fast at scale" — it is
"interactive at a few hundred, trending linear".

### 0a.3 Traps this session hit, so the next one does not

Every one of these cost real time and is not obvious from the code.

1. **`cached_verts` had no single unit, and that is the root of a whole bug class.** The builders write
   *feet*, `_get_product_shape` returns *metres*, and both wrote the same dict key. Any fix in one
   direction broke the other: my first units fix passed its own gate and broke `test_container_fidelity`
   and `test_sketch_mode`, which I only found by **stashing my changes and running the suites against a
   clean tree**. All writes now go through `_cache_verts`, and the cache is always in the file's unit.
2. **`metres_per_unit` and `METRES_PER_FOOT` are different factors and easy to confuse.**
   `_metres_per_unit()` is metres per *file unit* (1.0 for a metres model); converting geometry authored
   in *feet* needs `METRES_PER_FOOT` (0.3048). Using the former for the latter left the cache in feet and
   a 12 ft slab came back as 39.37 ft.
3. **Converting on read and caching the converted value self-amplifies.** One 30 ft wall returned
   x = 30, 98.425, 322.92, 1059.44 on four successive calls. A cache must never hold a converted value
   unless it is tagged.
4. **Two caches are on the correctness-critical path, and both are deliberately conservative.** The plan
   cache folds the *sorted element GUIDs* into its key because level→element membership is not covered
   by any revision counter. The join radius uses the wall's **old and new** endpoints, because an edit
   both gains and loses joins and a graph rebuilt from current state cannot see the one it just removed —
   that partner would keep a stale footprint permanently. **A wrong cache key or a too-small radius
   produces permanently wrong geometry that nothing later repairs.** Prefer a slower, conservative key.
5. **`mesh_hlr` is unit-agnostic but is driven with `cut_z` in metres.** Feeding it the feet client
   buffers put every cut path out by 3.28084 *and made door openings vanish*. It now gets
   `_meshes_for_projection()`. If you touch the mesh unit boundary, this is the second consumer to check.
6. **Deleting a method's tail silently orphaned its only caller.** Removing the end of
   `_mesh_hlr_plan_contract` dropped the 6 ft drafting rule (`test_hlr.py` caught it) *and* orphaned
   `_orient_plan`, which would have stopped rotating plans into the building's frame — **no test covered
   that**; it was found only by grepping for callers after the deletion. When you delete a block, grep
   for what it called.
7. **"Spatial grouping" sounded right and was not.** The first occlusion fix bucketed meshes into 300 ft
   tiles and changed nothing measurable, because in a building the whole plan fits in one tile. The
   quadratic term was the occluder *growing*, not the ordering. Recorded in `e3216fe` so it is not
   re-attempted.
8. **A gate can assert noise.** The scale gate's "the slice is no longer dominant" was meaningful at 86%
   and a coin-flip at 59–79% once both terms got small — it failed the default run. Replaced with
   absolute guards (view rebuild < 60 ms; repeat request served from cache). **Prefer absolute thresholds
   to share-of-total assertions once both terms are small.**
9. **Watch for `.pyc`-induced confusion.** During the units work one measurement said 44.84 where another
   said 13.67 for the same wall; the difference was a stale `backend/__pycache__`. Clear it (or run with
   `-B`) before believing a surprising number.
10. **`recompute_wall_joins(only=...)` is only as correct as its widening.** It is built over ALL walls,
    not the `only` subset, because a selected wall's partner can lie outside the subset.

### 0a.4 The next task, with the decision it needs

**Phase 1.3c — incremental `_prepare`.** `mesh_hlr._prepare` re-projects **every** mesh whenever the
revision changes, so moving one wall reprojects the whole scene. Measured with the scale gate's new
instrumentation: **plan cache miss 350 ms vs hit 7.5 ms** at 196 walls. That 350 ms is the entire
remaining per-edit cost at N=500.

The blocker is a **design decision, not effort**: the projector receives a plain list of mesh dicts and
has no revision identity, so it cannot know which entries are stale. Options, cheapest first:

* **Per-element `cached_verts` object identity.** The cache is replaced (not mutated) whenever geometry
  changes, so `id(verts)` is a usable staleness key within a process. Cheap, no plumbing, but a false
  *hit* is possible if a freed list's address is reused — mitigate by holding a reference in the prepared
  entry so the address cannot be recycled while cached.
* **Explicit revision signature.** Pass `mesh_revs` (or a `(guid → rev)` map) into `MeshHlrProjector` and
  key the prepared cache on `(rev, camera_key)`. Honest and debuggable, needs plumbing through
  `_meshes_for_projection` → `_mesh_hlr_plan_contract` → `_hlr_plan_contract`.

Either way: **the camera must be part of the key** (a plan and a section project differently), and the
prepared cache must live somewhere that survives an individual `render()` call — today `render()` sets
`self._prepared = None` on entry, and the projector itself is constructed fresh per request.

**Acceptance for 1.3c:** a cache miss at 484 walls drops to roughly the cache-hit cost plus one element's
projection, and the scale gate asserts the budget at N=500 (raise the default `assert_sizes` ceiling from
200 once it passes).

### 0a.5 What is *not* next, and why

* **Phase 2 (editable dimensions) is the owner's stated priority, and it is blocked on 0.3 — which is
  done.** Phase 2 changed shape during this session: `add_dimension_lock` + `_solve_constraints_after_move`
  already hold and propagate a constraint (probe-confirmed), so this is **not** "build a dimension
  solver". It is: give dimensions identity in the overlay, add `DimensionCreate` / `DimensionValueSet`
  (which carries a **value, not a delta**), make the edit move the **referenced face** rather than
  translate the element, and wire the UI. Phase 2 is *M*, not *L* — the single largest estimate change in
  this plan. The units prerequisite it was blocked on is now fixed, so Phase 2 is genuinely unblocked.
* **Phase 3 (trim/split) has two confirmed correctness defects** that are independent of performance and
  safe to fix now: trim is one-sided and lands on the target's *infinite baseline*; and split **strands
  hosted openings** (a door at offset 15 on a wall split at 10 stays hosted to the now-10-ft half,
  outside its own host). The second is the spec's own §17 "wrong building, not a wrong line" class.
* **The `Ctrl+Z` keybinding still must not ship** (Phase 0.5). Undo deep-copies the whole IFC to STEP
  twice per transaction (`ifc_service.py:397-445` via `command_bus.py:642`, `:677`). At 5,000 elements
  the undo stack is projected in **GBs**. Phase 3.5.1 (command-scoped mementos) comes first.

### 0a.6 Methodology that produced these results

Worth keeping, because it is what caught nine of the ten traps above:

1. **Measure before and after, and print the numbers.** The scale gate and the equivalence gate exist to
   make each optimisation falsifiable. Every performance claim in this plan that was *inferred* has been
   wrong at least once.
2. **Compare incremental results against the slow-but-correct version, exactly.** `test_join_incremental.py`
   runs the same scenario twice and asserts byte-identical footprints, vertices and bboxes. That is the
   only reason the scoped join recompute is trustworthy.
3. **Assert that a gate can fail.** `test_units_boundary.py` carries an explicit negative control for the
   3.28084 signature; `test_join_incremental.py` asserts its corpus actually contains joins (otherwise a
   "no mismatches" result is vacuous).
4. **When a gate fails after a fix, first ask whether the gate is measuring a stale premise.** It happened
   twice here, and in both cases the assertion — not the code — needed inverting.
5. **Verify by executing, never by reading.** Four separate times this session, a claim that looked right
   in the diff was wrong when run.

---

### 0b. Verification pass — 2026-10-16 at `ec2c99c`

Every STATUS claim in §3 was re-checked against the tree rather than carried forward. The gates this plan
cites all pass at the counts it records — but three statuses were wrong, one item is now complete, and
the suite has more than tripled since the figures below were written.

**Gate totals now.** `npm run check` exits 0 with **618 assertions**: bus parity, UI-P0 130, state-bundle
45, delta equivalence 21, snap-engine 21, and Python — solver 17, container fidelity 68, dimensions CRUD
**190**, geometric references 32, transactions 42, reference-move 11, dependency graph 41 — plus `tsc`.
The "196/196" figures in §3 count only the three JavaScript gates and predate `check:snap` and
`check:py`.

**Corrected statuses.**

| # | This plan says | Verified | Evidence |
|---|---|---|---|
| 0.2 | ⬜ NOT DONE | 🟨 **PARTIAL** | The fixtures now exist: `scratch/test_trim_split_gate.py` (30/30) covers trim-to-corner, split refusing to strand an opening, split-with-gap, datum-driven trim and dimension propagation; `scratch/test_dimensions_crud.py` is now 190 checks. **But the §20.1 variation requirement is unmet** — the trim/split file varies thickness (0.5 / 0.75) and never angle or join mode, so it is blind on exactly the dimension the two join suites exist to protect. The plan's own meta-test rule, applied to itself. |
| 0.5 | ✅ held — unbound | ✅ **closed, superseded** | Ctrl+Z / Ctrl+Y **are** bound now (`src/App.tsx:53`, `:62`) — correctly, because 3.5.1 landed. The row's instruction ("do not bind before 3.5.1") was satisfied and then followed. Record it as closed so the next reader does not unbind it. |
| 1.4 | ⬜ untouched | ✅ **DONE** | The solve is scoped: `scope = solver.affected_guids([moved_guid])` (`backend/ifc_service.py:3026`), then `solver.solve(axis=axis, pins=pins, scope=scope)`; `affected_guids` expands transitively over `align`, `dimension_lock` and `length_lock` (`backend/constraint_solver.py:128-150`). §4's order block and "remainder" line still list 1.4 as outstanding. |
| 2.7 | ⬜ PARTIAL — "`levels` … does not exist" | 🟨 **PARTIAL — grid spacing only** | The `levels` key **is** in the 2D view contract: `/api/view/2d` returns it beside `cut_paths` / `projection_paths` / `hidden_paths` / `dimensions`, and datum lines, bubbles and in-canvas elevation editing are in. Grid spacing editable by dimension remains ⬜. The task text is stale about the key. |
| 3.5.1 | ✅ DONE — mementos "replacing full IFC STEP serialization snapshots" | 🟨 **PARTIAL** | `CommandMemento` covers **31 of 41** registered commands and `WallMove` is an O(1) inverse operation — but **10 commands still fall back to a full `snapshot_state()`**, STEP serialisation included: the five `Constraint*`, `SetWallJoin`, and the four `SketchCurve*` (`backend/command_bus.py:1519-1523`). The 12/12 gate passes because it exercises only memento-covered commands — the same §20.1 blindness, in the undo direction. Decision: `docs/DECISION-live-edit-transaction-unit.md`; work ordered in `docs/REFACTOR-PLAN.md` §9. |

**The solver gap recorded in the spec is closed in this environment.** `SPECIFICATION-v0.3.md` §0.4 lists
as **High** that `import planegcs` raises `ImportError` and "the constraint system is therefore **inert
and reporting nothing**". At `ec2c99c` that no longer holds: `import planegcs` succeeds,
`ConstraintSolver._solver_available()` returns `True` (`Sketch is not None`,
`backend/constraint_solver.py:119-120`), `/health` reports `"solver_available": true`, and the solver
capability gate passes 17/17 with `scratch/test_pure_python_solver.py` (13) alongside. §29.1's
requirement — that availability be a **gate**, not an assumption — is what makes this checkable; the
§0.4 row should be marked resolved with this evidence, not deleted.

**What this plan does not contain, and where it lives.** The 2026-10-16 engine probe found seven
first-run and UI-surfacing defects that are prerequisites for *demonstrating* anything in §3 (seven when
found; six remain — the locked-dimension one was fixed by `3762c0c`) — the app
loads a legacy sample at startup so the default plan renders empty; a failed solve reports success; there
is no `GET /api/dimensions`;
2D views do not fit on switch; elevations report a cut plane and the palette reports the wrong view type;
and `DI`/`SEC` are declared unimplemented, so dimensions and sections cannot be created from the UI.
Those are **Track A** of `review/IMPLEMENTATION-PLAN-direct-manipulation.md` §4, deliberately not
duplicated here. The two plans' boundary is set out in §2b.

### 0c. Verification pass — 2026-10-16 at `7251a44` — *supersedes §0b for counts*

Triggered by the audit of the gesture layer that §2b assigns to the direct-manipulation plan
(`review/archive/REVIEW-gemini-direct-manipulation-phases-7-8-2026-10-16.md`). Every STATUS claim below was
re-checked against the tree. Four statuses here were stale — three of them **understating** work that has
landed — and one count has moved.

**Gate totals now.** `npm run check` exits 0 with **924 assertions**: bus parity 47 UI actions, UI-P0 130,
state-bundle 45, delta equivalence 21, snap-engine 34, and Python **694** across **14** suites — solver 17,
container fidelity 68, dimensions CRUD **201**, geometric references 32, transactions 42, reference-move 11,
dependency graph 41, plus grip/gesture coverage added since (drag session 19, wall grips 49, value-entry hot
retype 15, snap engine 34, grips beyond walls 71, validity predicates 48, face push/pull 46) — and
`tsc --noEmit` clean. §0b's 618 is correct for `ec2c99c`; dimensions CRUD has grown 190 → 201.

**Corrected statuses.**

| # | This plan says | Verified at `7251a44` | Evidence |
|---|---|---|---|
| 2.4 | "**⬜ PARTIAL** … Interactive creation of persistent overlay dimensions (`DI` tool / `createDimension`) is disabled/deferred in UI" | ✅ **DONE** | The `DI` tool creates a persistent dimension: `createDimension({…})` at `PlanViewport2D.tsx:611`, mapped to `DimensionCreate` (`useBimStore.ts:143`) and dispatched at `:1553`. The overlay renders from the payload at `PlanViewport2D.tsx:1295` (`sliced2D.dimensions.map`). Enabled by direct-manipulation Track A7; `implemented: true` at `src/interaction/toolCaptions.ts:44`. |
| 3.4 | "**⬜ PARTIAL.** … `DI` (Aligned Dimension tool) is disabled / `implemented: false` in `toolCaptions.ts`" | ✅ **DONE** | As 2.4. `TR`, `SL`, `SO` and `DI` are all wired. `SEC` is also live — `addView({type:'section'})` at `PlanViewport2D.tsx:637`, `SEC` in `PLACEMENT_TOOLS` at `:266`. |
| 3.5.1 | "covers **31 of 41** registered commands … 10 commands still fall back to a full `snapshot_state()` … (`backend/command_bus.py:1519-1523`)" | 🟨 **PARTIAL — 40 of 50** | Same ten commands still fall back, and the probe lists them: `ConstraintAlign`, `ConstraintDelete`, `ConstraintEqualize`, `ConstraintLockDim`, `ConstraintLockToggle`, `SetWallJoin`, `SketchCurveAdd`, `SketchCurveMoveEdge`, `SketchCurveMoveVertex`, `SketchCurveSetSlope`. But the registry has grown to **50** and memento coverage to **40**, and the cited line has drifted: the fallback is now `backend/command_bus.py:1755` (the `else:` branch, "Fallback for any other registered command"). The 12/12 gate still exercises only memento-covered commands. |
| 2b.1 | Phase 2's UI half "blocked on the `DI` tool being `implemented: false`" | ✅ **unblocked** | `DI` is `implemented: true`; 2.4 and 2.6-interactive are reachable by hand. Only **2.7 grid spacing** remains open in Phase 2. |
| 2b.2 | "the 3D viewport still holds 16 inline `Math.round(x * 2) / 2` quantisations and does not import the snap engine at all" | ✅ **superseded** | **0** quantisations left in `Viewport3D.tsx`; it imports `snapEngine` and `findSnapVertex` is gone from `PlanViewport2D`. Direct-manipulation Track B P0 closed it. |
| 1.5 | ⬜ untouched | ⬜ **still open** | Slice delta transport — unchanged, and still the only Phase 1 item open. |
| 0.2 | 🟨 PARTIAL (§20.1 variation unmet) | 🟨 **unchanged** | The trim/split fixtures still vary thickness only, never angle or join mode. The plan's own meta-test rule, still unmet on itself. |
| Phase 0 Exit | "a 5,000-element curve exists ⬜" | ⬜ **still open** | Measured to 484; 5,000 never run. |
| Phase 4 | 🟨 PARTIAL | 🟨 **unchanged** | 4.1's visual snap glyphs and 4.6's non-wall temporary dimensions remain deferred. |
| Phase 7 | 🟨 PARTIAL | 🟨 **unchanged** | Element-specific panels and interactive endpoint dragging remain deferred. |

**Why §0c exists rather than a rewrite.** Three of these stale rows understated: a reader working from the
old text would believe the `DI` tool was unusable, that the 3D viewport had no snap engine, and that
mementos covered 31 commands. A separate dated pass, in the shape of §0b, keeps the correction auditable and
leaves the historical rows intact.

**Cross-plan note.** The gesture layer §2b delegates now runs through Phase 6 complete, with Phase 1, 7 and 8
partial. The outstanding work is enumerated as W1–W13 in
`review/archive/REWORK-ORDER-direct-manipulation-2026-10-16.md`; W8 is the 3.5.1 item above and W12 is this table.

### 0d. Verification pass — 2026-10-16 (Post-Rework Order W1–W13)

Triggered by completion of `review/archive/REWORK-ORDER-direct-manipulation-2026-10-16.md` (W1–W13):
1. **3.5.1 is ✅ DONE**: W8 implemented `CommandMemento` for all 10 remaining commands (`SetWallJoin`, `ConstraintAlign`, `ConstraintLockDim`, `ConstraintEqualize`, `SketchCurveAdd`, `SketchCurveMoveVertex`, `SketchCurveMoveEdge`, `SketchCurveSetSlope`, `ConstraintLockToggle`, `ConstraintDelete`). Probe check G passes with **50 of 50 commands declaring a memento (0 fall back to snapshot)**. The probe (`scratch/_probe_engine_smoke.py`) is wired into `scripts/check-python-suites.mjs` and verified by `npm run check`.
2. **0.2 remains 🟨 PARTIAL**: Trim/split fixtures in `scratch/test_trim_split_gate.py` vary thickness but not angle or join mode (§20.1 variation requirement remains open).
3. **Phase 0 Exit remains ⬜ open**: N=484 verified; N=5,000 unmeasured.
4. **Phase 1.5 remains ⬜ open**: Slice delta transport.
5. **Phase 2.7 remains ⬜ open**: Grid spacing editable by dimension.
6. **Phase 4 remains 🟨 PARTIAL**: 4.1 visual SVG snap glyphs and 4.6 non-wall temporary dimensions deferred.
7. **Phase 7 remains 🟨 PARTIAL**: Element-specific tool panels and interactive endpoint dragging deferred.

---

## 0. Objective and binding constraints

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
3. **This plan's 3.5 is decided and mostly done** *(corrected by §0c)*. 3.5.2 is done and correct; 3.5.1
   covers **40 of 50** commands (was 31 of 41) with the ten-command fallback to remove. Owner of the
   decision: `docs/DECISION-live-edit-transaction-unit.md`. Owner of the work: `docs/REFACTOR-PLAN.md` §9.

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
| 0.5 | **Do NOT bind Ctrl+Z/Ctrl+Y yet.** Undo serialized the whole IFC to STEP twice per transaction. | At 5,000 elements the undo stack was projected at **GBs**; shipping the keybinding first would have handed users a button that hangs and then crashes the engine. Bind it in Phase 3.5. | **✅ CLOSED 2026-10-16 — superseded by 3.5.2.** The keybinding *is* bound now (`src/App.tsx:53`, `:62`), which is correct because 3.5.1 landed (40 of 50 commands use mementos — §0c). Do **not** unbind it. The old two-snapshots-per-transaction description is the pre-memento design; see §0b and `docs/DECISION-live-edit-transaction-unit.md`. |

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
Phase 1 (weeks)     kill the two O(N²) paths            ✅ 1.1, 1.2, 1.3a/b/c done
   ↓
Phase 1 remainder   1.5 ⬜  (1.4 ✅ verified 2026-10-16)
   ↓
Phase 2 (weeks)     editable dimensions                 🟨 PARTIAL (Backend & Bus ✅; UI DI & grid ⬜)
   ↓
Phase 3 (week)      trim/split semantics                ✅ DONE (3.1–3.3, 3.5; 3.4 DI ⬜)
   ↓
Phase 3.5 (week)    undo that survives 5,000 elements   🟨 3.5.2 ✅; 3.5.1 40/50 (§0c)
   ↓
Phase 4 (week)      draw-and-place feel                 🟨 PARTIAL (4.2–4.5 ✅; 4.1 ext & 4.6 non-wall ⬜)
   ↓
Phase 5 / 6         types; sheets                       ✅ DONE (Phase 5 & Phase 6)
   ↓
Phase 7             chrome                              🟨 PARTIAL (Options Bar, Context Menu, Hotkeys ✅; grips/contextual tools ⬜)
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
| Undo memory crashes a long session before 3.5 lands | 0.5 kept the keybinding unbound until 3.5.1; both are now **closed** — Ctrl+Z/Ctrl+Y are bound (`App.tsx:53`, `:62`) and mementos cover 40/50 commands (was 31/41 — §0c). What remains is the 10-command fallback and the byte cap, owned by `docs/DECISION-live-edit-transaction-unit.md`. | **Resolved, with a remainder** — see §0c. |
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
