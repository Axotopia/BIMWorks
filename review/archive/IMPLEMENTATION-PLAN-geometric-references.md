# IMPLEMENTATION PLAN — geometric references (and the drag path they enable)

**Companion to** [`IMPLEMENTATION-PLAN-dimension-as-control.md`](IMPLEMENTATION-PLAN-dimension-as-control.md)
and [`revit-dimension-as-control.md`](revit-dimension-as-control.md) — which this plan **amends**, not supersedes (§7).
**Evidence** `Revit-Parametric-Architecture-Map.md` (research workspace, not tracked in this repository).
**Applies to** the BIMWorks repository root.
**Status** proposed — not started. Authored 2026-10-15, 20:53.

---

## 0. Why this plan exists

Dimension-as-control is the primary way of working in model view. That workflow rests on a primitive it does not
own: a **durable, comparable, repairable name for a piece of geometry** — "this wall's start point", "grid axis
3" — as opposed to a whole element. Revit structures this as shared core-model infrastructure
(`remapGrefsInElementSet` is a free function over `Set<ElementId>`; `getConstraintGeomRef` shows the constraint
layer *depending on* the reference layer; family parameters carry GRef handles too; `RawSnap` carries its `Pick`).
Four consumers, one abstraction.

BIMWorks has the abstraction **half-built, twice, and in neither case deliberately**:

| De-facto reference, v1 | De-facto reference, v2 |
|---|---|
| `_resolve_ref_coords(ref)` — `ifc_service.py:3430-3462` | `SnapCandidate.sourceGuid` — `snapEngine.ts:22` |
| Untyped dict; free-string `ref` ∈ `start`/`end`/`center`/`midpoint` | Typed `SnapKind`, but **provenance discarded** |
| No `kind`, no `ordinal`, no repair | `sourceGuid` has **zero consumers** in `src/` |

Both fail the same way. `_resolve_ref_coords` ends in a **silent `(0.0, 0.0)`** (`:3445`, `:3462`) — which is
exactly the failure the dimension plan named: *"getting it wrong converts today's silent dangling constraint
into silent wrong geometry."* And on the snap side, `PlanViewport2D.tsx:435` returns **`snap.point` only**,
dropping the `kind` and `sourceGuid` the engine just computed — so by the time a move reaches the backend as
`{dx,dy,dz}` (`useBimStore.ts:2067-2069`), nothing knows what was snapped to.

This plan owns that primitive, sized for BIMWorks, and wires the two consumers to it.

---

## 1. Scope

**In scope** — the reference primitive as a single module; normalization of the existing ad-hoc format;
reference **repair** with explicit outcomes; snap provenance preserved end-to-end; an intent-carrying move
command; drag-time constraint application through the existing `extras` seam; reference-aware undo.

**Out of scope, deliberately:**

- **Index indirection / remap pass / regeneration-integrity contracts.** Revit carries
  `replaceElemIdsWithIndicesInGeomShapeHandles`, snapshot-constancy checks and a reference-remap pass in every
  regeneration. Those are Revit-sized answers to a 30-year file-compatibility problem BIMWorks does not have.
  See §5.4.
- **The dimension object itself.** Owned by the companion plan. This plan supplies the primitive it consumes.
- **Axis-vs-plane drag classification.** Revit's `MoveConstraintSettings` (4-value option enum, 1e-9 degenerate
  guard) has no analogue here, and should not: `constraint_solver.py:86-89` states *"Axis independence is not an
  approximation here: every constraint the application supports is axis-aligned."* Recording this as a non-goal
  so nobody "fixes" it.
- **Sketch-mode solver unification** (companion Phase 4).

---

## 2. Target model

```python
# backend/references.py
ReferenceKind = (
    # single-source, local to an element
    "wall_start", "wall_end", "wall_face_pos", "wall_face_neg", "host_offset",
    # datums
    "level_plane", "grid_axis",
    # free
    "point",
    # DERIVED — multi-source. These are what snap kinds already produce.
    "intersection", "extension",
)

Reference {
    kind    : ReferenceKind
    sources : [ {element_guid: str, ordinal: int = 0}, ... ]   # 1 local, 2+ derived
    hint    : { point: [x,y,z], normal: [x,y,z]|None }         # repair-only; NEVER identity
}
```

**`sources` is a list, not a scalar.** `[OBSERVED]` This is forced by the existing snap engine: `intersection`
is computed from **two** segments (`snapEngine.ts:121-136`) but the type is singular, so `:134` writes
`sourceGuid: s1.guid || s2.guid` — silently keeping one and **discarding the other**. A singular field cannot
represent the engine's own kinds. `extension` and `perpendicular` have the same shape.

**`hint` is repair data, never identity.** Adopted from the companion plan (§2 rule 3), which took it from
`Reference.Refresh` existing publicly — the admission that staleness is normal.

**Resolution returns an outcome, never a silent zero.**

```python
def resolve_reference(manager, ref) -> tuple[tuple[float,float]|None, str]:
    """outcome in {"exact","repaired","ambiguous","lost"}"""
```

---

## 3. Architecture decisions

### 3.1 One module constructs references; nothing else may

`backend/references.py` owns construction, comparison, serialisation, resolution and repair. Mirrors companion
§3.1. The existing ad-hoc dicts in `self.dimensions[*].ref_a` / `.ref_b` become *normalized on read* (§3.2).

### 3.2 This is a migration, not a green field

`_resolve_ref_coords` (`:3430-3462`) already defines a de-facto format, so Phase 0 is **normalization**:

| Today | Becomes |
|---|---|
| `ref["guid"]` / `ref["level_id"]` | `sources[0].element_guid` |
| `ref["ref"]` ∈ `{"start","end","center","midpoint"}` | `kind` ∈ `{wall_start, wall_end, …}` |
| `ref["point"]` | `hint.point` |
| *(absent)* | `ordinal` — needed for `wall_face_pos`/`wall_face_neg` |

**Read-old / write-new**, exactly as companion §3.2 does for `dimension_lock`: existing `self.dimensions` and
`.orlt` files keep loading, and are converted on load. Do not break `_resolve_ref_coords`'s callers in one step.

### 3.3 Two behaviours in `_resolve_ref_coords` must be decided, not inherited

`[OBSERVED]` Both are in the current code and neither looks intentional:

1. **A level resolves to `(0.0, elevation)`** (`:3437-3441`). A level is a horizontal *plane*; in plan view it
   projects to the whole plane, not to a point at the origin. Any dimension witness on a level is therefore
   anchored to X=0. **Requires a decision** — most likely `level_plane` resolves to a *coordinate on an axis*
   (Z for elevation; X/Y are unconstrained), which is why the primitive needs
   `resolve_reference_axis(ref, axis)` alongside the 2D form.
2. **Levels are matched by name as a fallback** (`:3440`: `lv.get("name","").lower() == str(guid).lower()`).
   Identity by display name is fragile and should be dropped in favour of id-only.

### 3.4 The snap engine is not rebuilt; its output type is fixed

`findSnapCandidate` (`snapEngine.ts:103-106`) already implements the priority hierarchy
(`:95-101`) and six kinds, and is already gated (`scripts/check-snap-engine.mjs`, driven by
`scratch/test_snap_engine.py`). The change is narrow:

- `SnapCandidate.sourceGuid?: string` → a **sources list** (`snapEngine.ts:17-23`), populating both segments at
  the intersection site (`:134`) instead of `s1.guid || s2.guid`.
- `PlanViewport2D.tsx:433-436` keeps the whole candidate rather than reducing to `snap.point`.

### 3.5 Move gains an intent-carrying sibling; the delta form stays

`WallMoveParams` is `{guid, dx, dy, dz}` (`command_bus.py:31-35`) — a delta, which cannot express "put this
reference on that reference" and cannot be replayed from the journal deterministically. Add
`ReferenceMoveParams {source: Reference, target: Reference, axis}` as a **new verb**, keeping `WallMove` for
nudge/keyboard paths. This mirrors companion §3.4's reasoning for `DimensionValueSet` carrying a value rather
than a delta.

### 3.6 Drag-time constraints use the seam that already exists

`ConstraintSolver.solve(..., extras=...)` is documented as *"the delta of an in-progress drag"*
(`constraint_solver.py:145,153-155`). `[OBSERVED]` **No caller passes it** — the only occurrence in the repo is
the parameter default at `:158`. This is built, documented and unwired; wire it rather than inventing a
parallel mechanism.

### 3.7 Do not add a third dependency walk

`[OBSERVED]` Two independent transitive-scope walks already exist:

- `ConstraintSolver.affected_guids` (`:110-137`)
- `DependencyGraph.recompute` (`dependency_graph.py:160-216`), which builds `constraint` edges
  (`:71-87`) but **only ever acts through `recompute_wall_joins`** — `affected` is counted, never re-solved.

Pick one as authoritative for reference-driven re-solve and have it call the other, or make the redundancy
explicit. A third walk is how the two current ones silently diverged.

### 3.8 Undo must carry references

`snapshot_state` (`:685`) / `restore_state` (`:742`) already round-trip `self.dimensions` (`:739`, `:823`,
`:840`) and `dimensions_rev`. Any new reference state must join that memento, or an undo will leave references
pointing at restored-away geometry.

---

## 4. Phases

### 4.0 Prerequisite and gate commands

**`planegcs` must be installed before any solver-dependent gate can run.** It is declared in `requirements.txt`
(`planegcs>=0.9.6`) but **is not installed** in the current environment (`import planegcs` raises
`ImportError`). `docs/REFACTOR-PLAN.md:75-77` records the same fact, together with four pre-existing failures in
`scratch/test_dependency_graph.py`.

This is more than a missing test dependency. `ConstraintSolver._require_solver()`
(`constraint_solver.py:96-102`) raises `SolverUnavailable`, and `_solve_constraints_after_move`
(`ifc_service.py:2964-2966`) catches every exception and **returns silently**. So with `planegcs` absent the
constraint system is **inert**: a move that should trigger a solve does nothing, and reports nothing. Two
consequences for anyone executing this plan:

- Do not measure, tune or "fix" solver behaviour before installing it — you would be measuring the absence.
- Never read "no error" as "no constraint applied." Check `SolverUnavailable` reachability explicitly in
  Phase 1's gate.

`_solve_pure_python` (`constraint_solver.py:287`) exists as a fallback and should be exercised deliberately,
not assumed.

**Gate commands.** Run the affected gate after **each** work item, not at the end (per `GEMINI.md` Phase 3).

| Command | Expected |
|---|---|
| `npm run check` | `check:bus`, `check:ui`, `check:state`, `check:delta`, `check:snap` all pass, then `tsc --noEmit` clean |
| `npm run check:snap` | passes now; **extended in Phase 3** to assert an `intersection` candidate carries *both* source guids |
| `python scratch/test_dimensions_crud.py` | passes now; **extended in Phase 1** with a `lost`-reference assertion |

> **Trap.** `npm run check` includes the UI gate, which makes **real HTTP calls** to the engine — start the
> backend first. `docs/REFACTOR-PLAN.md:67` records this; it is the most common way a gate run is misread here.

| # | Change | Gate |
|---|---|---|
| **0** | `backend/references.py` — kinds, `reference_key`, `normalize_reference`, `resolve_reference` (+ axis form), `repair_reference`. No caller changes. | Unit gate: every kind resolves; `reference_key` is order-stable and distinguishes multi-source refs; a two-source `intersection` does **not** collide with either single source. |
| **1** | `_resolve_ref_coords` delegates to `references.resolve_reference`. Adopt read-old/write-new normalization for `self.dimensions`. Resolve §3.3's level case. | Existing dimension tests still pass (`scratch/test_dimensions_crud.py`). Every previous silent `(0.0,0.0)` now returns `lost` — assert the count and triage each. |
| **2** | Repair wired into the move path: after `translate_element`, re-resolve affected references; `repaired`/`ambiguous`/`lost` surfaced rather than absorbed. | A dimension whose witness moved reports `repaired`, not a wrong number. Deleting a referenced element yields `lost`, not `(0.0,0.0)`. |
| **3** | Snap provenance preserved: multi-source `SnapCandidate`, `PlanViewport2D` keeps kind+sources. | `check-snap-engine.mjs` extended: an intersection candidate carries **both** source guids. |
| **4** | `ReferenceMove` verb + drag-time `extras` wiring. | Dragging a constrained wall end onto a grid axis holds the relation; release re-solves once via the §3.7 authority. |
| **5** | Reference-aware memento (`:685`/`:742`). | Undo/redo of a reference-touching edit restores resolvable references. |

**Sequencing note.** Phase 5 is last, but §3.8 should be *checked* at Phase 0 — if references are not
serialisable into the existing memento shape, that constrains the primitive's design and is better known early.

---

## 5. Risks

### 5.1 The identity model is the risk, and it is already flagged

Companion §0: the reference primitive *"changes the identity model."* Getting `reference_key` wrong is how
`silent dangling` becomes `silent wrong geometry`. Phase 0's gate is therefore about **key semantics**, not
resolution — resolution is easy to test and easy to get right for the wrong reason.

### 5.2 Phase 1 will look like a regression

`[OBSERVED]` Today every unresolved reference silently becomes `(0.0, 0.0)`. Replacing that with `lost` will
**surface breakage that is currently invisible** — dimensions that have quietly been measuring from the origin.
Expect a burst of newly-visible `lost` references on existing `.orlt` projects. That is the point, but it should
be communicated as a migration, with a triage pass, not shipped as a surprise.

### 5.3 The companion plan is stale and must be re-anchored

`[OBSERVED]` `IMPLEMENTATION-PLAN-dimension-as-control.md` states BIMWorks has *"no dimension object"* and cites
`ifc_service.py:4650-4703` for regex-over-SVG measurement. That range is now the overlay-load path; the
measurement is at `_overall_dimensions` (`:5805-5859`, `guid: None` at `:5838`/`:5850`), and a persistent
dimension object demonstrably exists (`self.dimensions` `:242`, `create_dimension` `:3464`, `DimensionCreate`
verb `command_bus.py:421`, overlay persistence `:6391`/`:6532`). Other citations are shifted similarly
(`_apply_equalize` cited at `:284-309`, now at `~455`). `[OBSERVED]` **Its diagnosis of the render path remains correct; its premise and line references do not.**

The repository **is** under git (`main` → `github.com/Axotopia/BIMWorks.git`), so the drift is diffable rather
than something to re-check by hand. The dimension object arrived in:

```
d786484  2026-10-15  feat(dimensions): implement dimension overlay objects, bus commands,
                    in-place text editing, and baseline resizing (Tasks 2.2-2.5)
```

That commit message cites **Tasks 2.2-2.5** — the companion plan's own numbering — which is evidence that its
Phase 1–2 work has shipped and that its prose and line citations predate `d786484`. See §7.

### 5.4 Scope discipline

Revit's reference layer is persistent document state with index indirection and a per-regeneration remap pass.
The temptation will be to grow toward that. The honest boundary is already demonstrated in this codebase:
`_recompute_after_joined_edit` (`:4693-4725`) solves the snapshot-constancy problem *locally*, by taking
`old_points`/`new_points`, because *"a graph rebuilt from current state cannot see the join the edit just
removed."* Two arguments instead of a remap pass. Follow that precedent.

---

## 6. What this plan does not claim

- The Revit evidence behind §0 is `[OBSERVED]` for symbol/API existence and `[INFERRED]` for the architectural
  reading that the reference layer is core-model rather than dimension-owned. Revit's `Reference` class layout
  and `Dimension` member offsets were **not** recovered; the claim rests on call direction and module placement.
- Not reviewed while writing this: `command_bus.py`'s `WallMove` handler body, the pointer-drag → `translateElement`
  path in `PlanViewport2D.tsx`, `sketch_model.py`, the full test suite, the renderer. Each could constrain the design.

---

## 7. Deliverable that accompanies this plan

An **amendment to `IMPLEMENTATION-PLAN-dimension-as-control.md`**, because Option B makes that plan a *consumer*
of `backend/references.py` rather than its author:

1. Re-anchor every `file:line` citation against the current tree.
2. Correct §0's premise — a dimension object exists; what is missing is reference identity, not the object.
3. Replace its §3.1/§3.3 definitions of the primitive with a dependency on this plan's Phase 0.
4. Preserve its `ReferenceKind` set as a **subset** of this plan's, extended with derived kinds.

Its §2 target model, its binding-enum rule, and its `move_reference` decision remain sound and are the reason
this plan does not restate them.
