> **SUPERSEDED - v0.1. Do not implement from this file.**
>
> Retained for the record because v0.2's revision note refers to it. See
> `SPECIFICATION-v0.2.md`.
>
> Two known deficiencies, found after it was written:
>
> 1. It was drafted **without reading `docs/IMPLEMENTATION-PLAN-2026-10-14.md`**, so parts of it
>    re-demand work that plan reports as complete (units, overlay v3, staleness gating, grids,
>    dependency graph, solver, sketch model, HLR, parity gate) and mark as open several questions
>    the plan already answers.
> 2. It folded in roughly ten reverse-engineering findings out of a corpus of hundreds. The bulk of
>    the evidence - the editing-interaction architecture, the 2D-editor uncoupling, direct
>    manipulation, views/sheets/tag tracking, the family and type model, and the API-evolution
>    stability record - was not carried across.
# BIMWorks — Normative Specification

**Status:** v1.0 — normative. **Designation:** this document is the *contract*. It states what
BIMWorks **MUST** be. It is written against the code as it exists, not against an intended
architecture.

**Relationship to the other documents** — read these together, in this order:

| Document | Role | Authority |
|---|---|---|
| `docs/SPECIFICATION.md` (this) | **What BIMWorks must be.** Interfaces, invariants, acceptance. | Normative |
| `docs/SPEC.md` | **Why.** Research rationale, Revit/IFC ground truth, sourced quotes. Retained as the evidence record. | Non-normative |
| `docs/IMPLEMENTATION-PLAN-2026-10-14.md` | **When and in what order.** P0–P7 sequencing and risk. | Non-normative |
| `README.md` | Orientation and how to run it. | Non-normative |

Where this document and `SPEC.md` disagree, **this document wins**, because `SPEC.md` is dated
2026-10-13 and describes an intended stack (C++ engine, Rust shell) that the repository does not
contain. `SPEC.md`'s sourced Revit and IFC quotations remain the reference material for *why* a
requirement exists.

**Evidence convention.** Every requirement is marked:

- **[OBS]** — observed in the current code or measured by execution.
- **[REQ]** — a normative requirement, whether or not it is currently met.
- **[GAP]** — a requirement currently unmet, with the observed evidence.
- **[OPEN]** — unresolved; needs measurement or a decision.

A requirement is never satisfied because it appears here. It is satisfied when a check fails without
it (§9).

---

## 1. Scope and non-goals

### 1.1 In scope

BIMWorks is a desktop architectural BIM authoring application for architects. It produces models and
construction documents for real buildings.

1. Authoring of architectural elements: walls, doors, windows, slabs, roofs, levels, grids, sketches.
2. Parametric editing: joins, constraints, hosted openings, datum-driven geometry.
3. 2D documentation: plans, sections and elevations with hidden-line removal; lineweights; annotation.
4. Sheets: viewports, title blocks, vector PDF.
5. IFC4 as the model of record, with a parametric overlay for semantics IFC cannot express (§4).
6. A typed command bus that the UI and an AI driver share, with no privileged path (§6).

### 1.2 Non-goals

1. **Structural, MEP, rebar, curtain-wall grids, topography, stairs.** Out of scope. Elements in
   these classes may be *preserved* on import but are not authored.
2. **The Family Editor as an authoring UI.** Deferred. The *type and parameter model* is in scope
   now (§13) because other subsystems depend on it.
3. **Cloud collaboration, worksharing, licensing.**
4. **Being a Revit file-format reader.** `.rvt` is not read and MUST NOT be claimed as supported.

### 1.3 Explicit non-claim

BIMWorks output is an uncertified instrument of service. No surface in the application, the README or
the exported documents may imply that generated documents are stamped, sealed, or code-compliant.

---

## 2. Normative vocabulary

- **MUST / MUST NOT** — a hard requirement. Violation is a defect.
- **SHOULD / SHOULD NOT** — a strong preference; deviation requires a recorded reason.
- **MAY** — genuinely optional.
- **Element** — a persistent model object with a GUID and parameters.
- **Overlay** — `parametric.json` inside the container.
- **Model of record** — `model.ifc` inside the container.
- **Bus** — the typed command bus.
- **Key element** — in a wall join, the wall that runs through; the other butts or miters against it.

---

## 3. Product definition

**[REQ]** BIMWorks MUST be usable to model a small commercial building and issue a drawing set
without manual geometry repair.

**[REQ]** Everything the UI can do, an AI driver MUST be able to do over the bus, and vice versa.
There MUST be no operation reachable only from the UI. This is verified by an audit test that
performs a task through the bus with the UI disabled (§6.6).

**[REQ]** The application MUST NOT require network access to open, edit, or save a model. *(Observed
commit: "Remove the web-font dependency: the app no longer needs the network to draw.")*

---

## 4. Data model

### 4.1 The container

**[OBS]** The project file is a zip (`save_orlt_project`, `ifc_service.py:4109`) containing:

```
<project>.bimworks
├── model.ifc           IFC4 STEP — the model of record
├── parametric.json     the overlay
├── views/*.json        view definitions
└── meta.json           schema/app version, journal tail
```

**[REQ]** The container MUST remain a plain zip openable with any zip tool. No proprietary framing,
no obfuscation, no encryption.

**[REQ]** `model.ifc` MUST be a valid standalone IFC4 file that opens in a third-party viewer without
BIMWorks. A consumer given only `model.ifc` MUST see correct walls, openings and storeys.

**[REQ]** Losing the overlay MUST degrade the model to a *static but valid* IFC file, never to a
corrupt or unopenable one. `parametric.json` is additive; the IFC MUST NOT depend on it for
well-formedness.

### 4.2 The overlay

**[OBS]** `parametric.json` carries `version` (currently `"2.1"`), `units`, `constraints`,
`join_policies`, `elements`.

**[REQ]** The overlay MUST contain, for every element whose behaviour is parametric:

| Key | Contents |
|---|---|
| `version` | Overlay schema version. MUST be checked on load; an unknown newer version MUST be refused with a clear message, never partially applied. |
| `units` | Declared unit of every stored length (§4.3). |
| `elements` | Per-GUID parametric definition: baseline, host, offsets, level, thickness, type. |
| `join_policies` | Per-wall, per-end join state (§8). |
| `constraints` | Align / lock / equalize relationships (§11). |

**[REQ]** The overlay MUST NOT be the only place a *geometric* fact lives if IFC can carry it
correctly. Overlay-only data is reserved for semantics IFC defines no behaviour for: constraints,
join policy, sketch intent, view state.

**[OBS]** A legacy `Pset_BIMWorks_Constraints` property set was used to persist constraints.
`save_constraints_to_ifc()` is now a documented no-op and `strip_legacy_constraint_pset()` removes it.

**[REQ]** Round-trip fidelity MUST NOT depend on a custom property set. If any code path still
requires the legacy pset to reconstruct state, that is a defect, not a fallback.

### 4.3 Units — a hard invariant

**[OBS]** `backend/units.py` is the single conversion point: `INTERNAL_UNIT = "decimal_feet"`,
`IFC_LENGTH_UNIT = "METERS"`, `METRES_PER_FOOT = 0.3048`.

**[REQ]** Every stored length — IFC attributes, `element_meta`, the overlay, command parameters — is
in **decimal feet**.

**[REQ]** No module outside `units.py` may contain a bare `0.3048`, nor a metric-looking dimension
literal in a builder or default. A `3.0` wall height in a builder is a defect even if it is currently
corrected downstream. Named constants (`FEET_10`, `INCHES_4_7_8`) MUST be used.

**[REQ]** Conversion to metres MUST occur at the STEP serializer boundary only.

**[REQ]** This invariant MUST be machine-checked. A check SHOULD scan first-party source for
`0.3048` and for metric-shaped literals in builder defaults, and fail on a match. *(Currently
[OPEN]: no such check was found.)*

### 4.4 Identity and re-attachment

**[REQ]** Every element MUST have a GUID that is stable across save/load, undo/redo, and overlay
re-attachment. The GUID is the only join key between the IFC and the overlay.

**[REQ]** On load, an overlay entry whose GUID is absent from the IFC MUST be flagged **stale** and
MUST NOT be silently applied or silently discarded. Stale entries MUST be surfaced to the user.

**[REQ]** Deleting an element MUST remove, or explicitly orphan, every overlay entry and constraint
that references it. A dangling reference is a defect.

---

## 5. The command bus

### 5.1 Registry

**[OBS]** `COMMAND_REGISTRY` (`command_bus.py:195`) is the single source of truth, with 26 commands:

```
WallCreate          WallMove            WallTrimExtend      WallSplit
DoorInsert          WindowInsert        DeleteElement
SlabCreate          RoofCreate          GridCreate          LevelCreate     LevelMove
SetWallJoin
ConstraintAlign     ConstraintLockDim   ConstraintEqualize  ConstraintLockToggle  ConstraintDelete
SketchCurveAdd      SketchCurveMoveVertex   SketchCurveMoveEdge   SketchCurveSetSlope
ElementCopy         ElementRotate       ElementOffset       ElementUpdate
```

**[REQ]** Adding a command MUST mean adding one entry to the registry. A command reachable from the
UI but absent from the registry is a defect.

**[REQ]** The registry MUST export JSON Schema 2020-12 for every command
(`get_schemas`, served at `/api/commands/schema`). The schema is the contract; the schema is what an
AI driver plans against.

### 5.2 Transaction semantics

**[REQ]** Every mutation MUST occur inside a transaction. There MUST be no path that mutates the
model without a journal entry.

**[OBS]** `/api/command` wraps mutating commands in a one-command transaction for exactly this
reason. **[REQ]** This property MUST be preserved by any new route.

**[REQ]** A transaction is atomic: either every command applies or none does. On failure the model
MUST be byte-identical to its pre-transaction state.

**[REQ]** A transaction MUST be undoable as a unit, and redo MUST restore the post-transaction state
exactly — including derived state (join geometry, hosted openings, 2D slices).

**[REQ]** Every transaction MUST record `origin` (who issued it) and a human `description`. Origin
MUST distinguish at least `ui`, `ai`, and `import`.

**[OPEN]** The undo/redo storage shape. The assessment's claim that it is a full IFC STEP
serialization per transaction came from the stale README block and is **not verified**. If it is a
full serialization, it is O(model) per edit and MUST be replaced by an incremental or
copy-on-write representation, because it contradicts the latency budget in §18. Measure before
changing.

### 5.3 Post-commit state protocol

This is a **[GAP]** with a measured cost.

**[OBS]** `executeTransaction` (`useBimStore.ts:1763-1768`) awaited seven requests in series:

```
fetchProjectState()   -> /api/constraints  AND  /api/project
fetchGeometry()       -> /api/geometry
fetch2DSlice()        -> /api/slice/2d
fetchConstraints()    -> /api/constraints   (the SAME route, fetched twice)
fetchWallJoins()      -> /api/wall/joins
fetchTransactionJournal() -> /api/transaction/journal
```

**[OBS]** `fetchProjectState` calls `fetchConstraints` internally (`useBimStore.ts:1077`), so
`/api/constraints` is requested twice per commit. Latency is the *sum* of seven serial round trips,
not the maximum.

**[OBS]** Measured: a complete edit round is p50 36.7 ms / p95 66.9 ms against a 16 ms budget, with
roughly 30 ms attributable to full-model refetches.

**[REQ]** The post-commit refresh MUST be a **delta push**: the engine emits what changed, and the UI
applies it. `SPEC.md` §3.2 already specifies this ("frontend subscribes to delta events"). It is
therefore a spec violation, not merely a slow choice.

**[REQ] (interim)** Until deltas exist, the refresh MUST be a **single** request returning a bundle
(`GET /api/state`). SHALL NOT be more than one round trip after a commit.

**[REQ]** The UI MUST NOT fetch a resource twice within one refresh.

**[REQ]** The UI store MUST hold no independent model state. It holds view, selection and UI state,
and caches engine state for rendering. This is enforced by the parity gate (§9.4).

### 5.4 Instrumentation — two numbers that must never be conflated

**[GAP]** A reported "drag result" of p95 4.98 ms measured only the in-process recompute — roughly a
tenth of what the user waits for.

**[REQ]** Engine-side compute and end-to-end interaction latency MUST be logged as **separate,
distinctly named** metrics. Forbidden: reporting either under a name the other could be mistaken for.

- `engine_ms` — time inside the engine process, excluding IPC and transfer. Returned by
  `/api/state` as `engine_ms`, with a per-section `timings` breakdown.
- **interaction latency** — measured in the UI, from input to the frame that reflects it. This is the
  only number that may be presented as responsiveness.

**[REQ]** Any performance claim in the README or a commit message MUST state which of the two it is,
and under what model size and corpus.

---

## 6. Recompute

**[REQ]** The geometric dependency graph MUST live in the engine, not the UI.

**[REQ]** After a committed transaction the engine MUST recompute exactly the affected elements and
their dependents. Full-model recompute per edit is a defect.

**[REQ]** Recompute MUST be deterministic: the same model and the same command sequence MUST produce
byte-identical IFC output.

**[REQ]** Undo and redo MUST restore derived geometry, not just primitives. A wall whose join is
undone MUST return to its previous join-trimmed footprint.

**[OPEN]** Correspondence with Revit's incremental episode model
(`DocumentIncrementTable::begin/end`, `DocumentIncrement::greatestEpisodeId`) has not been
established. It is the reference shape for §5.2's open question.

---

## 7. Geometry: walls and joins

### 7.1 Join model

**[OBS]** Joins are stored per **wall end** (`end_index` 0 or 1) with `allow_join` and `mode`.
Modes are `butt`, `miter`, `square_off`. Persisted in `join_policies`.

**[REQ]** Join state MUST be per end, not per wall. A wall has two independently joinable ends.

**[REQ]** `square_off` MUST be modelled as a **separate attribute**, not as a third value of the
join-type enum. Revit exposes `canChangeWJType` and `canChangeSquareOff` as distinct capabilities.

**[OBS]** The key element is the **first-created** wall, which runs through; later walls are trimmed
against it. **[REQ]** This rule MUST be documented and MUST be stable across save/load, undo/redo and
recompute. It MUST NOT depend on evaluation order.

**[REQ]** An unjoined ("lonely") end MUST keep its full untrimmed footprint. A lonely end is a state,
not an error.

### 7.2 Miter geometry — **the miter MUST derive from side faces**

**[REQ]** A miter joint MUST be computed from the walls' **side faces**, not from an angle bisector.

Rationale: Revit 2025 `HostObjDB.dll` exports `MiterBySideFacesTargetData`. An angle bisector is
equivalent only for two equal-thickness straight walls — the one case that cannot distinguish the two
implementations, and therefore the one case a single-thickness test corpus exercises.

For wall A along +X (thickness `tA`, baseline centred on `y = 0`) and wall B along +Y (thickness
`tB`, baseline centred on `x = 0`), joined at the origin:

```
A's outer face            y = +tA/2
B's outer face            x = +tB/2
outer joint corner        ( tB/2,  tA/2 )     depends on BOTH thicknesses
inner joint corner        (-tB/2, -tA/2 )
joint plane               passes through both  ->  y = (tA/tB) * x
```

**Invariants (all MUST hold):**

| # | Invariant |
|---|---|
| J1 | A's outer joint corner is at `(tB/2, tA/2)`. |
| J2 | A's and B's outer joint corners **coincide**. |
| J3 | A miter is **area-preserving**: the two footprints sum to the untrimmed total. |
| J4 | The footprint contains **no degenerate vertex** at the junction. |

**[GAP] J1 and J2 fail.** Measured for `tA=0.2, tB=0.6`:

```
A footprint   (0.1,0.1) (10,0.1) (10,-0.1) (0,-0.1) (0,0)
A corner      (0.1, 0.1)  = (tA/2, tA/2)   <- the bisector: depends on tA alone
B corner      (0.3, 0.3)  = (tB/2, tB/2)   <- a different point
required      (0.3, 0.1)  for both
```

A and B do not meet at a common corner, and A's taper depends only on its own thickness.

**[GAP] J3 fails.** For the `0.3/0.3` 90° case the mitered total is `5.37750` against an untrimmed
`5.40000` — a shortfall of `0.0225` (a `0.15 x 0.15` square). A true miter gains at the inner corner
what it loses at the outer; this implementation clips to the positive quadrant instead of to the
joint plane, leaving a gap at every inner corner. The error is present at equal thickness, so it is
not a consequence of J1.

**[GAP] J4 fails.** At equal thickness A's footprint is
`(0.15,0.15) (10,0.15) (10,-0.15) (0,-0.15) (0,0)` — the `(0,0)` vertex is spurious. It is the
reason the existing `test_wall_joins.py` "shared bisector edge" check passes: it counts vertices
where `x == y`, and the degenerate origin satisfies that condition for free.

### 7.3 Butt joins

**[OBS]** For butt, the key wall keeps its full footprint and the other is trimmed to the key wall's
abutting face. This is correct behaviour and MUST be preserved.

**[REQ]** For butt the union MUST NOT contain overlaps. A two-sided area check MUST be used: a
one-sided `total <= untrimmed` check cannot detect a gap.

---

## 8. Constraints

**[REQ]** Constraints MUST be persisted in the overlay, keyed by element GUID, and MUST survive
save/load, undo/redo and import.

**[REQ]** Align-lock, locked dimensions, and equalize MUST each be independently removable.

**[OPEN]** Solver algorithm and conflict reporting are unverified. `backend/constraint_solver.py`
exists (322 lines); its guarantees are not established here.

---

## 9. Verification requirements

These are normative because the failures they prevent are silent.

### 9.1 Fixtures MUST vary each claimed dimension

**[REQ]** For every geometric algorithm, the test corpus MUST vary each input dimension the algorithm
depends on. If a key parameter is constant across a corpus, the suite is **blind** on that dimension
regardless of check count.

**[GAP]** `scratch/test_wall_joins.py` has 18 passing checks and every fixture wall is
`thickness: 0.3`. It therefore cannot detect the J1/J3/J4 failures above.

**[REQ]** Every geometric test file MUST carry a **meta-test** asserting that its corpus varies each
dimension it relies on. The meta-test MUST fail when a dimension collapses to a single value.

**[OBS]** `scratch/test_wall_joins_matrix.py` implements this: it varies thickness, join angle,
walls-at-junction, join mode and end state, and asserts the variation. Its side-face assertions fail
against the current join code, by design, and will pass when §7.2 is implemented.

**[REQ]** The dimensions that MUST be varied for joins, once representable: thickness, join angle,
walls at the junction, join mode, end state, layer count, curvature, vertical offsets.

### 9.2 A check that cannot fail is a defect

**[REQ]** For every check, it MUST be possible to state what the check would have to observe in order
to fail. A check whose inputs cannot produce a failure MUST be removed or repaired.

**[GAP]** Instances found: fixtures with constant thickness (§9.1); a "drag result" measuring a tenth
of the wait (§5.4); the `x == y` bisector check satisfied by a degenerate origin vertex (§7.2).

### 9.3 Coverage gaps MUST be recorded, not skipped

**[REQ]** A test that cannot exercise a dimension MUST report it as an explicit gap. Silent skips are
prohibited.

**[OBS]** Currently unrepresentable and therefore untested: **per-layer / compound-structure joins**
(no layer model in `element_meta`), **curved-wall joins** (no arc wall), **vertical join
interaction** (no base/top offsets). These are recorded by the matrix test's coverage-gap section.

### 9.4 Gates that MUST remain green

**[OBS]** `scripts/check-bus-parity.mjs` and `scratch/test_bus_parity_audit.py` enforce that the UI
store holds no independent model state. `scripts/check-ui-p0.mjs` enforces UI interaction invariants.

**[REQ]** These gates MUST remain in CI. The parity gate is the correct instrument for the
store-mirrors-model class of violation, and MUST NOT be weakened.

**[REQ]** A gate MUST fail loudly when it loses coverage. A gate that cannot fail is worse than no
gate.

### 9.5 Test execution MUST be portable

**[GAP]** `scratch/test_wall_joins.py` prints `\u2713` and crashes with `UnicodeEncodeError` on a
stock Windows console (`cp1252`), before completing a single check. The suite the project cites as
"18 checks passing" does not run in the default environment of its primary platform.

**[REQ]** Test output MUST be ASCII-only, or the runner MUST force UTF-8 stdout. A suite that cannot
run is not a suite.

---

## 10. 2D views, sheets and annotation

**[REQ]** Plans, sections and elevations MUST be generated by an in-process hidden-line pipeline.
Shelling out to an external converter per view is prohibited.

**[OBS]** `backend/hlr_renderer.py` (1,227 lines) and `backend/mesh_hlr.py` (481 lines) exist.
`SPEC.md` / the stale README describes HLR as absent; **[OPEN]** whether the implementation is
BRep-based or mesh-based is unverified, and the distinction is material to section/elevation quality.

**[REQ]** A view MUST be a first-class document object that can exist **unplaced**. Placement on a
sheet MUST be a separate object referencing both the sheet and the view, so that removing a viewport
never deletes the view. *(Independently corroborated: Revit separates `View` from `Viewport`.)*

**[REQ]** Sheet numbers MUST be unique within a scope, and that scope MUST be stated.

**[REQ]** Markers (section, elevation, callout) MUST derive their labels from the referenced view's
name and number. Label text MUST NOT be stored independently, or renumbering will not propagate.

**[REQ]** Vector PDF MUST contain no raster content at any zoom.

---

## 11. Types and parameters

The Family Editor UI is deferred; the **type model is not**.

**[REQ]** There MUST be a three-level model: **type** (shared definition) → **instance**
(placement) → **element**. Changing a type MUST affect all instances; changing an instance MUST
affect only that instance.

**[REQ]** Parameters MUST carry a **storage type** (length, number, integer, string, element-id).
Storing every value as a string is a defect that will break formulas and units.

**[REQ]** Instance parameters MUST NOT be usable in type-parameter formulas. This mirrors Revit's
`NoInstparamFormulas` and is a scope rule that constrains the evaluation model.

**[REQ]** Formulas MUST support cycle detection that reports the cycle, not a stack overflow.

**[REQ]** Parameters MUST support a **reporting** mode (reporting a measured value) distinct from
driving geometry.

**[REQ]** Failure objects SHOULD carry named remedy actions, not only messages.

**[REQ]** Shared parameters MUST be GUID-keyed.

**[OPEN]** Whether the type model is currently representable in the overlay. §4.2 lists `elements`
but not types.

---

## 12. UI

**[REQ]** The UI MUST be a skin over the bus (§3). A UI action that bypasses the bus is a defect.

**[REQ]** Ribbon state (`enabled`, `visible`, `checked`, `caption`) MUST be **derived per command per
view**, not stored on the button. A tool's availability is a property of the command in context.

**[REQ]** There MUST be an **Options Bar** rendered from a registry keyed by the **active command**.
The options MUST be the same descriptor the bus validates against — the Options Bar is the UI view of
the active command's parameter schema. *(Reference: Revit's
`SketchGalleryOptionsRegistry::getSGOForActiveCommand`; the Align tool's options are a typed object,
`ModifyUIOptions`.)*

**[REQ]** There MUST be **contextual tabs** driven by selection and active tool, from the same
command registry.

**[REQ]** Interaction MUST follow the per-view editor model: an active tool is an object with a
lifecycle attached to a view, torn down and rebuilt on view switch, owning its own transient
graphics. *(Reference: Revit's `Editor` contract — `onLoadEditor`, `onAbortEditor`,
`cancelDirtyEditor`, `onViewSwitch`, `requestTransactionInterrupt`.)*

**[REQ]** There MUST be no GPU-only path to viewing a plan. If no WebGL context is available, the 2D
view MUST still render.

---

## 13. Interoperability

**[REQ]** Exported `model.ifc` MUST validate against official IFC4 validation and open in at least
two independent viewers.

**[REQ]** Import of external IFC MUST reconstruct elements and geometry, not only the storey
hierarchy. *(An earlier status claimed 0 elements imported; the maintainer reports 13 elements and 3
levels, all parametrized. **[OPEN]** — re-verify against a model that exercises every supported
class.)*

**[REQ]** A round-trip MUST NOT silently lose data. `docs/ifc-parity.md` MUST document, per element
class and per property, what survives a save/load cycle and what is dropped. Silent loss is
prohibited; documented loss is acceptable.

**[REQ]** Imported elements that BIMWorks cannot author MUST be preserved as opaque geometry rather
than dropped.

**[REQ]** Georeferencing MUST use `IfcProjectedCRS` and `IfcMapConversion`.

---

## 14. Non-functional requirements

**[REQ]** Budgets, all measured per §5.4 with the model size and corpus stated:

| Metric | Budget |
|---|---|
| Interaction latency, wall drag, p95 | < 16 ms |
| Orbit, 3D viewport | 60 fps at 2M triangles |
| Cold start | < 3 s |
| Save | MUST NOT block the UI for more than 200 ms |

**[REQ]** A budget without a stated model and corpus is not a measurement.

**[REQ]** The application MUST NOT require the network (§3).

**[REQ]** No `node_modules`, build output, `__pycache__`, or virtual environment may be committed.

**[REQ]** Backend dependencies MUST be declared in `requirements.txt`. An undeclared hard dependency
is a defect.

---

## 15. Open questions

Recorded so they are not mistaken for settled:

1. **Undo storage shape** (§5.2). Unverified; if a full serialization, it contradicts §14.
2. **HLR implementation kind** (§10). BRep vs mesh is unverified.
3. **IFC import completeness** (§13). Reported fixed; unverified across classes.
4. **Type model representability** (§11). Whether types are in the overlay.
5. **Constraint solver guarantees** (§8).
6. **Latency attribution** (§5.4). Until the refetch pattern is fixed and re-measured, the language
   question cannot be answered with a number. The residual measurement that would inform it: engine
   process CPU with IPC wait excluded — i.e. whether any engine-side work is language-bound or merely
   orchestration.
7. **Wall join layer/curvature/vertical behaviour** (§9.3). Unrepresentable today, therefore untested.

---

## 16. Traceability

Requirements in this document derive from four sources, in descending authority:

1. **Measured behaviour of this repository** — the join footprints in §7.2, the seven-refetch
   sequence and its cost in §5.3, the `cp1252` crash in §9.5, the 26-command registry in §5.1.
2. **Primary artefacts of Revit 2025**, observed as PE export names in shipped binaries:
   `MiterBySideFacesTargetData` (§7.2), `JoinEndGStep` and `AutoJoinExclusionsCell` (§6, §7.1),
   `DocumentIncrementTable::begin/end` (§5.2), `SketchGalleryOptionsRegistry` and `ModifyUIOptions`
   (§12), `CompoundStructure` and `JoinTangencyControl` (§9.3). These are primary sources and, in the
   case of the miter, they predicted a reproducible defect that the existing suite could not see.
3. **The IFC4 schema** — the absence of recompute semantics that motivates the overlay (§4.2).
4. **`docs/SPEC.md`** — rationale and sourced quotations, retained as the evidence record.

Requirements sourced from a project's own self-description are deliberately **not** traceable here.
That class of source produced three already-fixed claims and one false gap in an earlier external
review; it is why §9.2 exists.
