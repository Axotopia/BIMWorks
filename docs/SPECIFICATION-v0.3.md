# BIMWorks — Specification v0.3

**Status:** v0.3 — normative. **Supersedes:** `SPECIFICATION-v0.2.md` (retained; its unchanged
requirements remain in force — see §0.1).
**Designation:** this document is the *contract*. It states what BIMWorks **MUST** be.

## Authority and relationship to other documents

| Document | Role | Authority |
|---|---|---|
| `SPECIFICATION-v0.3.md` (this) | **What BIMWorks must be** — and the deltas from v0.2. | **Normative** |
| `SPECIFICATION-v0.2.md` | The base contract. **Incorporated by reference** for everything §0.3 does not change. | Normative (via §0.1) |
| `SPECIFICATION-v0.1.md` | First draft. Withdrawn. Moved to `docs/archive/`. | Withdrawn |
| `docs/REFACTOR-PLAN.md` | **The delta-protocol refactor** — exact commands, gates, traps. Rules of engagement: `GEMINI.md`. | Contract (that refactor) |
| `docs/IMPLEMENTATION-PLAN-2026-10-14.md` | **When and in what order.** P0–P7, status tables, risk register. | Sequencing |
| `review/IMPLEMENTATION-PLAN-*.md` | The forward plans: `dimension-as-control`, `geometric-references`, `direct-manipulation`, `revit-feel`. | Plans |
| `review/AUDIT-*-vs-revit.md` | Measured parity audits, `file:line` cited. | Evidence |
| `docs/SPEC.md` | **Why.** Master specification v2.3 — research rationale, sourced quotations. | Non-normative |
| `README.md` | Orientation and how to run it. | Non-normative |

Where documents disagree: **this document wins on *what***; `REFACTOR-PLAN.md` wins on *how* for the
delta refactor; the plan wins on *when*. Status tables in the plan are the record of what is built;
this document does not restate them.

## How to read a requirement

- **[OBS]** — observed in this repository, by reading or by execution.
- **[REQ]** — normative requirement.
- **[GAP]** — required and currently unmet, with evidence.
- **[OPEN]** — unresolved; needs a measurement or a decision.
- **[REA:…]** — rests on reverse-engineering evidence. Per v0.2 §23 these are inferences from symbol
  names *unless marked measured*; §0.4.1 revises what "measured" now means.

---

## 0. Revision note — v0.2 → v0.3

### 0.1 The inheritance rule — read this first

v0.2 is 1,247 lines and remains substantially correct. **v0.3 does not restate it.**

> **Every v0.2 requirement not listed in §0.3 remains in force and is incorporated by reference.**
> If v0.2 and v0.3 disagree, v0.3 wins. If a requirement is not in §0.3, v0.2 still governs it.

`§0.3` is therefore the **complete** list of deltas. Restating 1,247 lines of requirement text is how
that text silently drifts from what the code does; this document avoids the failure mode rather than
repeating it.

### 0.2 Why v0.3 exists

v0.2 was written before four things happened:

1. The **delta protocol** was scoped as its own refactor (`docs/REFACTOR-PLAN.md`, N10/D1–D9) and
   instrumented (`docs/DELTA-MEASUREMENT.md`).
2. The **Revit-parity refactor** completed and was reconciled at round 4
   (`review/IMPLEMENTATION-PLAN-revit-feel.md` §0).
3. A **persistent dimension object** shipped — commit `d786484` (2026-10-15), *"dimension overlay
   objects, bus commands, in-place text editing, and baseline resizing (Tasks 2.2-2.5)"*.
4. The **forward plans** in `review/` were written: dimension-as-control, geometric-references,
   direct-manipulation.

It also records three defects found since, one of which violates an **existing** v0.2 requirement.

### 0.3 Requirements added or changed — the complete delta

| # | Change | v0.2 section | New section |
|---|---|---|---|
| D1 | Solver availability is a **hard build gate**, not an assumption | §12 | §29.1 |
| D2 | Commands MUST carry **intent**, not only a delta | §6 | §24.2 |
| D3 | **Delta protocol** conformance and honest latency reporting | §6.3, §6.4 | §24.1 |
| D4 | A **single reference primitive** owns geometric references | §12 (new) | §26 |
| D5 | Reference resolution MUST return an **outcome**, never a coordinate | §12 (new) | §26.3 |
| D6 | Snap provenance MUST survive to the command | §10 (new) | §26.4 |
| D7 | **Validation integrity and a refusal channel** | §6, §11 | §27 |
| D8 | Grip intent payload is **reference-shaped from day one** | §10 | §25 |
| D9 | Verification additions: reference round-trip, snap multi-source, refusal | §20 | §29.2 |
| D10 | §23's stated limits of the REA corpus are **superseded** | §23 | §0.4.1 |
| D11 | The **undo unit** is the command-scoped memento; a silent full-state fallback is prohibited, and no command may capture O(model) state for undo | §6 | §24.3 |

### 0.4 New gaps found since v0.2

| Gap | Evidence | Severity |
|---|---|---|
| **The embedded solver is not installed.** `planegcs>=0.9.6` is declared in `requirements.txt` but `import planegcs` raises `ImportError`. `_require_solver()` (`backend/constraint_solver.py:96-102`) raises `SolverUnavailable`, and `_solve_constraints_after_move` (`backend/ifc_service.py:2964-2966`) catches every exception and **returns silently**. The constraint system is therefore **inert and reporting nothing**. **RESOLVED 2026-10-16:** at `ec2c99c` `import planegcs` succeeds, `ConstraintSolver._solver_available()` is `True` (`Sketch is not None`, `backend/constraint_solver.py:119-120`), `/health` reports `"solver_available": true`, and the solver capability gate passes 17/17 alongside `scratch/test_pure_python_solver.py` (13). §29.1 is what keeps this checkable — do not delete the gate. | `[OBS]` execution, 2026-10-16 | **Closed** (was High) — violated v0.2 §12 until this date |
| **An open boundary passes sketch validation.** An open 3-segment chain returns `is_closed() == True` and `validate() == None`, and the missing edge is **invented**. The only gate on the commit path (`backend/ifc_service.py:644-649`) therefore admits a boundary that was never closed. | `[OBS]` in `review/REVIEW-ingetrazo-…md` §4.2, reproduced by `review/probe-sketch-validation.py` | **High** |
| **An invalid polygon degrades silently.** `_triangulate_polygon_2d` swallows a Shapely failure or an invalid polygon and returns a fan (`backend/ifc_service.py:2188-2211`) — wrong area, no diagnostic. | `[OBS]` as above | Medium |
| **`ElementUpdate` silently ignores what it does not understand.** `updates: Dict[str, Any]` (`backend/command_bus.py:189-191`) is untyped, and `update_element` applies recognised keys and **still reports `"updated"`** for the rest (`backend/ifc_service.py:3279-3404`). | `[OBS]` | Medium |
| **Two independent dependency walks.** `ConstraintSolver.affected_guids` (`backend/constraint_solver.py:110-137`) and `DependencyGraph.recompute` (`backend/dependency_graph.py:160-216`). The latter builds `constraint` edges (`:71-87`) but acts only through `recompute_wall_joins`; `affected` is counted, never re-solved. Nothing keeps them consistent. | `[OBS]` | Medium |
| **The drag-time constraint hook is dead.** `solve(..., extras=...)` is documented as *"the delta of an in-progress drag"* (`backend/constraint_solver.py:145,153-155`) and **no caller passes it** — the only occurrence in the repository is the parameter default at `:158`. | `[OBS]` | Low |

### 0.4.1 Superseding §23's stated limits of the REA corpus

v0.2 §23 closes with limits that **no longer hold**. Recording rather than quietly overriding, per that
section's own precedent:

| v0.2 §23 said | Now |
|---|---|
| *"Ghidra auto-analysis timed out on every native module above ~2.8 MB in this environment, so the largest modules yielded export tables only"* | **Superseded.** The startup budget is configurable (`REA_GHIDRA_STARTUP_TIMEOUT_MS`); at 5,400,000 ms the 45.7 MB `RevitDB.dll` analyzes to completion. |
| *"no geometry arithmetic was recovered"* | **Superseded.** Solver arithmetic was recovered by decompilation — the `1e-9` degenerate-direction tolerance, the `0x7FFFFFFFFFFFFFFF` sign-mask absolute value, a rank-revealing pivoted orthogonalisation with back-substitution, and the damped Newton iteration that drives it. |
| *"One decompiled body out of the whole corpus matched its name; that is the entire calibration."* | **Superseded.** Six bodies were decompiled and cross-checked against raw bytes; two were publicly exported and thinned to shims, and the real bodies were reached by following tail jumps. |
| *"All REA was static — Revit was never executed."* | **Still true.** No Revit process was driven by this work. |

**Consequence for the policy, stated as a decision for the owner rather than taken here.** §23 recommends
keeping *"no REA/binary analysis of Revit"* and permitting REA only as a narrow exception for the API
stability record and the IFC asset inventory. That recommendation rests on a cost/benefit premise —
that native analysis yields export tables and little else. **That premise has changed.** Whether the
exception should widen is `[OPEN]` (§30, Q4) and is a project decision, not a specification edit.

Per v0.2 §23's method rule, which v0.3 keeps: *probing MUST vary each dimension the behaviour depends
on.* My own work is subject to the same criticism §23 makes of its own — it read a corpus without
running the product.

### 0.5 Corrections carried forward

v0.2 §0's two corrections (`TopographySurface` member counts; the extraction-parser bug making all REA
member counts lower bounds) remain in force and are not repeated here.

---

## 24. Amendments to §6 — command bus

### 24.1 The delta protocol

**[REQ]** A committed edit MUST return a **delta**, and MUST NOT require a full-model refetch. Cost MUST
be proportional to what changed, not to model size. The protocol is specified by
`docs/REFACTOR-PLAN.md` and instrumented in `docs/DELTA-MEASUREMENT.md`; conformance is proven by
`npm run check:delta`.

**[GAP]** As of v0.3 every committed edit still triggers a whole-model bundle — *"an edit's cost is
proportional to **model size**, not to **what changed**"* (`docs/REFACTOR-PLAN.md` §3.1, recorded as N10).

**[REQ]** Latency MUST be reported as **two separate numbers** and never conflated: `client.p50`/`p95`
(interaction latency — what a user waits for) and `engine.p50`/`p95` (engine compute, transport
excluded), both exposed at `globalThis.__bimworksRefresh`.

> Rationale, from `REFACTOR-PLAN.md` §2.4: *"A previous figure of 4.9 ms was published as the wall-drag
> result while measuring only in-process recompute — about a tenth of the real wait."* This is a
> correctness requirement on **reporting**, and it is normative because the error was made once already.

### 24.2 Intent, not delta

**[REQ]** A command that expresses a modelling intention MUST carry that intention, and MUST NOT carry
only a displacement. *(Evidence: `review/AUDIT-dimension-editing-vs-revit.md:420` — "the command must
express intent". A delta cannot express "make this 12'-0" and cannot be replayed from the journal
deterministically.)*

**[REQ]** `WallMove` and its siblings may keep a delta form for nudge and keyboard paths, but the
gesture-driven path MUST have an intent-carrying equivalent.

**[GAP]** `WallMoveParams` is `{guid, dx, dy, dz}` (`backend/command_bus.py:31-35`) and the drag path
dispatches through it (`src/store/useBimStore.ts:2067-2069`). There is no intent-carrying move verb.

**[REQ]** Every command in the registry MUST have a typed parameter model. `Dict[str, Any]` is
permitted only where the schema genuinely cannot be expressed.

**[GAP]** `ElementUpdateParams.updates: Dict[str, Any]` (`backend/command_bus.py:189-191`) is untyped,
and unrecognised keys are silently discarded while `"updated"` is returned
(`backend/ifc_service.py:3279-3404`).

### 24.3 The edit path's undo unit — finish the migration

**This sharpens §6's `[REQ — undo shape]`; it does not replace it, and it does not change §11's locked
container decision.** The decision record is
[`docs/DECISION-live-edit-transaction-unit.md`](DECISION-live-edit-transaction-unit.md).

**[ADOPTED]** The command-scoped memento IS the undo mechanism: one journal step and one undo entry per
transaction, each command returning an inverse operation or a prior-value capture
(`backend/command_bus.py:991`, `:1536`). 31 of 41 registered commands implement it, and the drag path is
O(1) — `WallMove`'s memento is `translate_element(guid, -dx, -dy, -dz)`, with no snapshot at all.

**[REQ]** The two jobs a snapshot can do MUST NOT share a mechanism:

| Job | Guarantee | Cost obligation |
|---|---|---|
| Durability / diffability | A complete, persistable, diffable state — what the replay journal and the delta protocol trust | Serialisation is permitted, and MUST occur **at most once per committed gesture** |
| Rollback of a live edit | The pre-edit state returns exactly, in-process | MUST be proportional to **what changed**, never to model size |

**[REQ — no fallback]** Every registered command MUST declare a memento. A full-state snapshot MUST NOT
be a **silent fallback** for commands that do not. The fallback at `backend/command_bus.py:1519-1523` —
`pre_snap = self.manager.snapshot_state()`, with `undo_fn` calling `restore_state` — MUST be removed, and
its absence MUST be asserted. It is removed for a specific reason: it is invisible. It does not fail; it
degrades in proportion to model size, which is how it survived an audit, a plan and a green gate suite.

**[REQ — no O(model) capture]** No command may capture state proportional to model size for undo, even
when memento-shaped. `ReferenceMove` currently walks **every** element to record its coordinates — and it
is the drag verb that §25's gesture path depends on
(`pre_coords = {g: (…get_element_coord(g, "x"), …) for g in self.manager.element_meta}`).

**[REQ]** Undo of a live edit MUST preserve **object identity**. `restore_state` re-parses the whole
document of record — `self.model = ifcopenshell.file.from_string(snap["ifc_text"])`
(`backend/ifc_service.py:754`) — invalidating every IFC entity handle in the process. It is reachable
from exactly one place (`command_bus.py:1523`), so `[REQ — no fallback]` above is also how this is
satisfied. A reference held across an undo MUST still be valid afterwards.

**[REQ]** The undo stack MUST be capped by **bytes**, not by entry count. It is capped at 200 entries
today (`command_bus.py:526`, `:1583`), and an entry's size varies by orders of magnitude between a
memento and a fallback snapshot.

**[REQ — invariant]** The `parametrized` / `unparametrized` / `rebuilt` / `stale` reconciliation report
MUST be asserted by a gate, not merely produced (`backend/ifc_service.py:5380`, `:5502`). Cheaper
live-edit state MUST NOT be permitted to let the document of record and the overlay diverge silently.

**[GAP — measured]** Where the fallback is still taken, `snapshot_state()` is O(model) and **66% of it is
`model.to_string()`** — serialising the document of record for a job that does not need it: 15.5 ms at 86
walls, of which 10.2 ms is STEP, linear at ≈0.12 ms per wall for the serialisation alone; independently
≈83 ms per snapshot at N = 1000 (`review/AUDIT-engine-performance-vs-revit.md` §2).

> **Note — a stale figure in circulation.** "Snapshot twice per transaction, ≈66 ms per edit at 86 walls"
> describes the **pre-memento** bus and is no longer true. `WallMove` does not call `snapshot_state()` at
> all; the measured cost applies to the ten fallback commands below and to `ReferenceMove`'s coordinate
> capture. `scratch/_probe_snapshot_cost.py` still models the old two-snapshot transaction and cites
> dead line numbers.

**[GAP]** Ten registered commands have no memento and take the fallback: `ConstraintAlign`,
`ConstraintDelete`, `ConstraintEqualize`, `ConstraintLockDim`, `ConstraintLockToggle`, `SetWallJoin`,
`SketchCurveAdd`, `SketchCurveMoveEdge`, `SketchCurveMoveVertex`, `SketchCurveSetSlope`.

**[REQ]** Verification MUST include the assertions V1–V6 of the decision record §8 — in particular that
**zero** commands fall back to `snapshot_state()`, that no command captures O(model) state for undo, that
an entity reference survives an undo, and that the reconciliation report stays clean across an
edit/undo/redo cycle. V1 is executable today in `scratch/_probe_engine_smoke.py` and currently reports
**10 of 41**.


## 25. Amendments to §10 — direct manipulation

**[REQ]** The grip layer's intent payload MUST be **reference-shaped from its first commit**:
`{ref?: ReferenceHandle, param, value}`. While grips run on deltas, `ref` is absent and the gesture is
unchanged; when the reference primitive lands, the same gesture emits a reference-qualified edit and
nothing in the gesture layer changes.

> Rationale (`review/IMPLEMENTATION-PLAN-direct-manipulation.md` §3.6): **"Without this,
> dimension-as-control Phase 3 rewrites the grip layer."** Stating it normatively is what prevents that.

**[REQ]** A grip MUST NOT silently no-op. If a grip's mutation is not understood by the engine, the
command MUST fail loudly (§27).

**[GAP]** No grip layer exists: nothing in `src/` contains the string `grip`, and no viewport can invoke
the modify commands as a gesture (`review/IMPLEMENTATION-PLAN-direct-manipulation.md` §0).

---

## 26. Amendments to §12 — the reference model

v0.2 §12 governs constraints. This section adds the primitive they rest on. Constraint types remain as
v0.2 states; what changes is **what a constraint may name**.

### 26.1 One owner

**[REQ]** A single module (`backend/references.py`) MUST own reference construction, comparison,
serialisation, resolution and repair. **Nothing else may construct a reference.** The same module is
consumed by constraints, dimensions, the grip layer and family parameters.

> Revit's structure, as evidence that ownership is not a stylistic choice: reference remapping is a
> **free function** over an element set, not a dimension method; constraints resolve *to* references
> (`getConstraintGeomRef`); and family parameters carry reference handles independently of both.
> Four consumers, one abstraction. `[REA: measured by decompilation and export tables]`

### 26.2 Shape

**[REQ]** A reference MUST carry `kind`, a **list** of `sources`, and a `hint`.

**[REQ]** `sources` MUST be a list, even where a kind currently has one source.

> Forced by evidence, not taste: snap kinds `intersection`, `extension` and `perpendicular` are
> **multi-source** — an intersection is defined by two elements — and the existing type cannot express
> that. `SnapCandidate.sourceGuid?: string` (`src/interaction/snapEngine.ts:22`) is singular, so the
> intersection site writes `sourceGuid: s1.guid || s2.guid` (`:134`), **silently discarding one source.**
> A scalar field cannot represent the engine's own kinds.

**[REQ]** `hint` MUST be repair data and MUST NEVER be identity.

**[REQ]** The kind set MUST include derived, multi-source kinds from the outset. Retrofitting them later
changes reference identity — which is the failure the dimension plan names: *"getting it wrong converts
today's silent dangling constraint into silent wrong geometry."*

### 26.3 Resolution returns an outcome

**[REQ]** Resolution MUST return an outcome in `{exact, repaired, ambiguous, lost}`. **An unresolvable
reference MUST NEVER yield a coordinate.**

**[GAP]** The de-facto format ends in a silent `(0.0, 0.0)`
(`backend/ifc_service.py:3445`, `:3462`), so an unresolved reference silently measures from the origin.
The de-facto format is also ad-hoc: an untyped dict with free-string `ref ∈ {start, end, center,
midpoint}`, no `kind`, no `ordinal`, and no repair.

**[REQ]** Normalisation of the existing format MUST be read-old / write-new, so existing projects and
`.orlt` containers keep loading.

**[OPEN]** A level currently resolves to `(0.0, elevation)` (`backend/ifc_service.py:3437-3441`). A level
is a *plane*; projecting it to a point at the origin is not obviously intended. Resolution likely needs
an axis-aware form (`resolve_reference_axis(ref, axis)`), leaving the unconstrained axes unaddressed.
Decision required before the primitive is frozen (see §30, Q1).

**[OPEN]** Levels are currently matched by display name as a fallback (`:3440`). Identity by display name
is fragile; v0.3 recommends id-only resolution and flags the change as behaviour-affecting.

### 26.4 Snap provenance must survive

**[REQ]** A snap result's **kind and all sources** MUST reach the command that commits the edit. Cursor
feedback and reference capture MUST be the same computation.

**[GAP]** `snapEngine` computes a typed candidate with provenance, and the consumer discards it:
`getModelCoords` returns `snap.point` only (`src/components/drafting/PlanViewport2D.tsx:435`), and
`sourceGuid` has **zero consumers** anywhere in `src/`. By the time the edit reaches the engine as
`{dx, dy, dz}`, nothing knows what was snapped to — so a snap cannot become a constraint.

**[REQ]** Grid snapping MUST have exactly one mechanism. *(Currently the engine's `grid` kind and an
independent 0.25 ft rounding fallback both exist — `snapEngine.ts`, `PlanViewport2D.tsx:438-441`.)*

---

## 27. Validation integrity and the refusal channel

**[REQ]** An edit that cannot be **proven valid** MUST be refused, with a plain-language reason surfaced
to the user, and MUST NOT be silently coerced into something plausible.

> Precedent (`review/REVIEW-ingetrazo-…md` §1): IngeTrazo *"never commits a solid it cannot prove is
> closed, and when it refuses it says so in plain words to the user."* BIMWorks already has the plumbing
> — `failureMessage()`/`describeApiError()` put engine reasons in the status bar
> (`src/store/useBimStore.ts:49-53`) — and has nothing to refuse with.

**[REQ]** A rejected command MUST NOT mutate the model, MUST NOT enter the journal as a success, and MUST
be distinguishable from a successful no-op.

**[GAP]** An open boundary is accepted. See §0.4.

**[GAP]** `update_element` reports `"updated"` for keys it did not apply. See §0.4.

**[REQ]** Degradation of invalid geometry MUST be a refusal, not a fallback. A triangulation that cannot
be computed correctly MUST NOT return a fan.

---

## 28. Amendments to §14 — family parameters and references

**[REQ]** Family parameters MUST be able to hold geometric references, on the same primitive as
constraints and dimensions, so a parameter can drive geometry rather than only a value.

`[REA: measured by decompilation and export tables]` In Revit, family parameters carry reference handles
independently of the constraint system: `FamilyParams::getGeomRefHandle`, `assignGeomRefHandles`,
`hasGeomRefHandles`, `clearGeomRefHandles`, `cleanUpStaleGeomRefs`, `areGeomRefHandlesEqual`,
`replaceElemIdsWithIndicesInGeomShapeHandles`. This is why §26.1 puts the primitive above the constraint
layer rather than inside it.

`[OPEN]` Whether to act on this is subject to the REA policy question (§0.4.1, §30 Q4).

---

## 29. Amendments to §19 and §20 — non-functional and verification

### 29.1 Solver availability is a gate, not an assumption

**[REQ]** The embedded solver MUST be present and its availability MUST be verified **before** any
constraint behaviour is measured, asserted, or tuned.

> This is a direct consequence of the §0.4 gap. Because `_solve_constraints_after_move` swallows
> `SolverUnavailable` and returns, **an absent solver is indistinguishable from an unconstrained model.**
> A gate that does not check for it measures nothing and reports success.
>
> **Status 2026-10-16:** the §0.4 gap is closed in this environment (planegcs imports; the solver gate
> passes 17/17), so the requirement is now *satisfied rather than aspirational*. It stays a requirement:
> an environment without planegcs must still be detected by the gate, not inferred from behaviour.

**[REQ]** A missing solver MUST NOT be indistinguishable from success at the model level. Either it
fails loudly on the paths that require it, or a gate asserts its presence.

**[REQ]** Every gate that depends on constraint behaviour MUST declare which solver path it exercises,
including the pure-Python fallback (`backend/constraint_solver.py:287`).

### 29.2 Verification additions

**[REQ]** Verification MUST include, in addition to v0.2 §20:

| # | Check | Proven by |
|---|---|---|
| V1 | A two-source reference does not collide with either of its single sources | `reference_key` unit gate |
| V2 | An unresolvable reference reports `lost` and never a coordinate | dimension/route suite |
| V3 | An `intersection` snap candidate carries **both** source guids | `npm run check:snap` |
| V4 | An open boundary is **refused**, not closed by inference | `review/probe-sketch-validation.py` |
| V5 | A rejected command leaves the model and the journal untouched | bus suite |
| V6 | A committed edit returns a delta, and the delta applies identically | `npm run check:delta` |

**[REQ]** The gate set is `npm run check` — `check:bus`, `check:ui`, `check:state`, `check:delta`,
`check:snap`, `check:py`, then `tsc --noEmit`. **The UI gate makes real HTTP calls to the engine; the
backend MUST be running first** (`docs/REFACTOR-PLAN.md:67`).

---

## 30. Open questions

Carried from v0.2 §21 unless closed. New or restated:

| # | Question | Why it blocks |
|---|---|---|
| **Q1** | Does a `level_plane` reference resolve to a coordinate on an axis, or to a plane predicate? | Freezes the reference identity model (§26.3). |
| **Q2** | Is the reference primitive owned by the geometric-references plan as a shared Phase 0, or defined in the dimension plan and consumed? | Decided: **shared, owned by `review/IMPLEMENTATION-PLAN-geometric-references.md`**; the dimension plan is amended to consume it. Recorded here so the decision is not re-litigated. |
| **Q3** | Which dependency walk is authoritative for reference-driven re-solve? | Two exist today (§0.4). A third is how the first two diverged. |
| **Q4** | Does the REA policy's narrow exception widen, given §0.4.1? | A project decision, deliberately **not** taken by this document. |
| **Q5** | Do the five `review/AUDIT-*.md` get re-anchored, or left pinned to `318ce26`? | Their line citations are drifting and live plans quote them. |
| **Q6** | `SPECIFICATION-v0.2.md`'s own citations are stale — re-anchor or leave as the historical base? | v0.3 incorporates v0.2 by reference, so stale citations in v0.2 are now load-bearing. |

---

## 31. Document map and the archive policy

**Archive policy.** A document moves to `archive/` when its *purpose is served*: it is explicitly
superseded, or it describes a state that no longer holds, or nothing references it. Archiving preserves
it — it does not delete it — and inbound references are updated so no live document points at a moved
file.

| Location | Contents |
|---|---|
| `docs/` | the specification, the sequencing plan, the delta refactor contract and its measurement log, and `SPEC.md` |
| `docs/archive/` | `SPECIFICATION-v0.1.md` — withdrawn, retained because §0 refers to it |
| `review/` | the forward implementation plans, the parity audits, and the IngeTrazo reviews |
| `review/archive/` | `CHANGE-PLAN-revit-parity.md` (superseded for execution), `HANDOFF-revitUI-plan-verification.md` (round complete, branch merged), `REVIEW_file-format-architecture_2026-10-14.md` (written against `ifc_service.py` at 2,121 lines; now 7,287), `OPTIONS-piggyback-…md` (point-in-time options paper), and two orphaned `section-multilevel.*` assets |

**[REQ]** A document that supersedes another MUST name it, and the superseded document MUST be moved to
the relevant `archive/`. `README.md` MUST NOT carry status or specification content — see its own rule.
