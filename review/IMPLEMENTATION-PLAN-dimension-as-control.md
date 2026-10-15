# IMPLEMENTATION PLAN — dimension as a modelling control

**Companion to** [`revit-dimension-as-control.md`](revit-dimension-as-control.md) (the mechanism, evidenced from Revit 2027).
**Applies to** the BIMWorks repository root.
**Status** proposed — not started. Authored 2026-10-15.

---

## 0. Why this plan exists

The companion document establishes that a Revit dimension is a **constraint element** — an ordered array of
durable references plus a binding — and that BIMWorks has the solver, the overlay, the dependency graph and
the command bus, but **no dimension object**. Every visible dimension in the shipped build has
`guid: None` and is measured by regex over rendered SVG (`ifc_service.py:4650-4703`).

This plan closes that gap. It is not "build a constraint engine"; it is "give dimensions identity, give the
solver references to drive, and wire the dependency edge that already exists."

**Three things make this smaller than it looks:**

| Already present | Where | Consequence |
|---|---|---|
| A real Newton solver (`planegcs` / PlaneGCS) | `backend/constraint_solver.py:199-309` | no solver to write |
| A `constraint` edge kind, built, but unused for work | `dependency_graph.py:35,71-87`; `recompute()` at `:160-216` mutates only via the `join` pass | wiring, not building |
| An overlay + typed bus + journal + undo | `ifc_service.py:5136-5182`, `command_bus.py:309-340` | persistence and commands are additive |

**One thing makes it riskier than it looks:** the reference primitive (§3.1) changes the identity model.
Getting it wrong converts today's *silent dangling constraint* into *silent wrong geometry*. §6 addresses this.

---

## 1. Scope

**In scope** — project-level linear dimensions that drive geometry; datums (levels, grids) as dimensionable
references; per-segment values; EQ over segments; lock/label as mutually-exclusive bindings; conflict
surfacing.

**Out of scope** — the sketch-mode solver unification (Phase 4, adjacent and larger); view-specific
dimensions and reference recovery (explicitly refused, §7); angular/radial/spot dimensions beyond leaving the
seam (Phase 8); the constraint heuristics on the drag path.

---

## 2. Target model

The end state, stated once so every phase can be checked against it.

```
ReferenceKind = "wall_start" | "wall_end" | "wall_face_pos" | "wall_face_neg" | "host_offset"
              | "level_plane"  | "grid_axis" | "point"

Reference {
  element_guid : str          # which element owns the geometry
  kind         : ReferenceKind
  ordinal      : int = 0      # which face/axis, when kind is ambiguous
  hint         : {            # repair-only; NEVER the identity
      point    : [x,y,z]      # world position when captured, decimal feet
      normal   : [x,y,z] | null
  }
}

Dimension {
  id          : str                    # "dim_<hex8>"
  refs        : [Reference, ...]       # ORDERED — n refs define n-1 intervals
  segments    : [ {value: float, locked: bool, value_override: str|null} | null, ... ]   # len == n-1
  axis        : "x" | "y" | "z"
  offset      : float                  # presentation only: where the dim line sits
  view_scope  : "model"                # only "model" in this plan
  binding     : "literal" | "parameter" | "equal"   # ONE slot, mutually exclusive
  label       : str | null             # set iff binding == "parameter"
  eq_anchor   : int | null             # set iff binding == "equal"; index into refs
}
```

Four rules this encoding enforces, each lifted from observed Revit behaviour
([companion §2.4](revit-dimension-as-control.md)):

1. **`binding` is an enum, not three booleans.** Lock, label and EQ occupy one slot, which is *why* Revit
   refuses `Dimension.IsLocked` on a labelled or multi-segment dimension. A single enum makes that
   unrepresentable rather than merely discouraged.
2. **`refs` is ordered and `segments` is positional** (`n` refs → `n−1` intervals). This is stated
   normatively by Revit's own docs and is the reason a "chain" is a reference list, not a list of
   dimensions.
3. **`hint` is repair data, never identity.** Revit's `Reference.Refresh` existing publicly is the
   admission that staleness is normal.
4. **No value on creation.** Revit has no factory that takes a number. The value is derived from current
   geometry, then settable.

### 2.1 Reference kinds are deliberately few

`wall_start` and `wall_end` are the coordinate-space endpoints in `meta["start"]` / `meta["end"]`.
`host_offset` is an opening's `offset_along_wall`. `level_plane` and `grid_axis` are datums.
`wall_face_pos`/`wall_face_neg` are the offset faces (thickness/2 either side) — these are what make a
"face to grid" dimension possible.

Revit makes reference publication **opt-in** (`FamilyInstance.GetReferences` skips a reference plane whose
*"Is Reference"* is *"Not a Reference"*). We adopt that: `referenceable_kinds(guid)` returns the set an
element publishes, and nothing else is addressable. This is a deliberate scope limiter — see the measured
31-participant blow-up at `review/AUDIT-engine-performance-vs-revit.md:114-115`.

---

## 3. Architecture decisions

### 3.1 The reference primitive — `backend/references.py` (new)

The load-bearing change. A single module owns reference construction, comparison, serialisation, resolution
and repair. Nothing else may construct a reference dict.

```python
# backend/references.py
REFERENCE_KINDS = ("wall_start","wall_end","wall_face_pos","wall_face_neg",
                   "host_offset","level_plane","grid_axis","point")

def normalize_reference(manager, raw: dict) -> dict: ...
def referenceable_kinds(manager, guid: str) -> list[str]: ...
def reference_point(manager, ref: dict) -> Optional[tuple[float,float,float]]: ...
def reference_solve_coord(manager, ref: dict, axis: str) -> Optional[float]: ...
def reference_key(ref: dict) -> str: ...            # canonical, order-stable, for dedup + equality
def reference_to_overlay(ref: dict) -> dict: ...
def reference_from_overlay(raw: dict) -> dict: ...
def repair_reference(manager, ref: dict) -> tuple[dict, str]:
    """Re-resolve against current geometry using hint. Returns (ref, outcome)
       where outcome in {"exact","repaired","ambiguous","lost"}."""
```

`repair_reference` is the BIMWorks counterpart of `Reference.Refresh` +
`DimensionReferenceRecoveryManager`, reduced to the minimum that is honest: exact match, nearest-candidate
repair within a tolerance, ambiguity refusal, or declared loss.

### 3.2 Dimensions live beside constraints, not inside them

Rejected: adding `"type": "dimension"` to the existing `self.constraints` dict. That dict is a
heterogeneous bag already (`ifc_service.py:2468-2476`, `:2507-2515`, `:2576-2586`) and the solver dispatches
on `type` (`constraint_solver.py:229-250`). A dimension has a *different shape* (ordered refs + positional
segments + a binding) and needs its own resolution and repair path.

Adopted: a **parallel collection** `self.dimensions: Dict[str, dict]`, with the existing three constraint
types kept as-is. `ConstraintSolver` gains a dimension pass that runs before the legacy pass. Rationale: it
is additive, it cannot corrupt the existing three types, and `dimension_lock` — which is nearly a dimension
already — can be *migrated* onto the new model later rather than being rewritten now.

**Do not add a fourth entry to `EDGE_KINDS`.** Dimensions contribute `"constraint"` edges, exactly as
`dependency_graph.py:71-87` already does for the three types, because the edge kind describes *what kind of
dependency* it is, not which object asserted it.

### 3.3 The solver solves references, not elements

`ConstraintSolver` currently maps one movable node per element-GUID per axis
(`constraint_solver.py:104-107`, `:202-207`). That is the wrong granularity for a dimension: a
`wall_start ↔ grid_axis` constraint must move a *point*, and a `wall_start ↔ wall_end` constraint must change
a *length*.

Adopted: the dimension pass builds its own node table keyed by `reference_key(ref)`, so two references of the
same element are two nodes. `apply_solve` then cannot use `translate_element` (which moves a whole element);
it needs a new primitive:

```python
# ifc_service.py — new
def move_reference(self, ref: dict, axis: str, new_coord: float, *, _propagate: bool = False) -> bool:
    """Moves the geometry a reference designates so its coordinate on `axis` becomes
       new_coord. wall_start/wall_end adjust the baseline endpoint (changing length);
       wall_face_* ride the baseline; host_offset rewrites offset_along_wall;
       level_plane rewrites the storey elevation; grid_axis moves the axis curve."""
```

**This is decision §10.1-D of the companion document** ("move the face, not the element") and it is the
change that makes the value round-trip. Today `applyTemporaryDimensionChange` computes a delta and calls
`translateElement`, so the element's `length` never changes and the typed value never comes back
(`review/AUDIT-dimension-editing-vs-revit.md:143-152`).

### 3.4 Command intent carries the value, not a delta

`DimensionValueSet {dimension_id, segment_index, value}` — never `{delta}`. A delta cannot express "make
this 12'-0" and cannot be replayed from the journal deterministically. This mirrors
`AUDIT-dimension-editing-vs-revit.md:420` (*"the command must express intent"*).

### 3.5 Conflict reporting becomes a first-class result

`last_constraint_conflict` is currently written (`ifc_service.py:2157`) and read by nothing. It becomes a
returned value with, per the companion §10.1-E, **at least one offered resolution**. Required shape:

```python
{"status": "conflict",
 "axis": "x",
 "constraints": [...],           # existing: sorted applied ids
 "dimensions": [...],            # new
 "resolutions": [                # new — Revit ships ResolveByUnlabeling / relaxConstraintsTo
    {"kind": "unlock_dimension",  "dimension_id": "dim_ab12", "segment_index": 0},
    {"kind": "unlabel",           "dimension_id": "dim_ab12"},
    {"kind": "release_eq",        "dimension_id": "dim_cd34"},
 ]}
```

---

## 4. Phases

Effort key: **S** ≤ half a day · **M** ≈ 1–3 days · **L** > 3 days.

---

### Phase 0 — Unblock and verify · S · **prerequisite for everything**

Nothing in this plan is verifiable until these three land, and one of them is a live user-visible bug.

| # | Change | File | Note |
|---|---|---|---|
| 0.1 | Fix the degenerate EQ caller: `equalizeSpan(southWall, southWall, targets, 'x')` passes the **same GUID for both span endpoints** | `src/store/useBimStore.ts:1261` | `pos_start == pos_end` ⇒ `total_span = 0` ⇒ `spacing = 0` ⇒ targets collapse to a point. The solver is fine; the sole UI caller is malformed. Confirmed against `ifc_service.py:2533-2538`. |
| 0.2 | Inventory the **actual** planegcs Python API | new `scratch/test_solver_capability.py` | `constraint_solver.py:204-307` assumes `add_point`, `add_fixed_point`, `set_p2p_distance`, `coincident`, `add_line`, `equal_length`, `get_point`, `solve` exist with these signatures. **Unverified in this workspace.** Print what is present. |
| 0.3 | Install and pin planegcs; make its absence **loud** | `requirements.txt`, `ifc_service.py:2129-2130` | Today `SolverUnavailable` is caught and printed as a "Notice", so **constraint propagation silently no-ops**. See §5. |

**Gate 0.** `python scratch/test_solver_capability.py` reports the available primitives; `EQ` over two
*distinct* endpoints holds across a later move (the probe already recorded at
`review/AUDIT-engine-performance-vs-revit.md:112-113`); a missing planegcs raises a surfaced error rather
than printing and continuing.

> **Blocker risk.** If 0.2 shows `planegcs` lacks a needed primitive, Phase 1's `add_point_on_line`-style
> relation may need a different encoding. Resolve before starting Phase 1.

---

### Phase 1 — The reference primitive · M

Introduce `backend/references.py` and a **dual-write** `wall_start`/`wall_end` reference list on wall
elements. No behaviour change yet.

| # | Change |
|---|---|
| 1.1 | New `backend/references.py` with the §3.1 surface. Pure functions over `manager`; no state. |
| 1.2 | `_build_overlay_element` (`ifc_service.py:1254-1285`) writes `refs` alongside the existing fields. `ELEMENT_PARAM_FIELDS` (`:3265-3289`) unchanged — refs are a separate key, mirroring how `footprint`/`sketch` are handled. |
| 1.3 | `rebuild_from_overlay` (`:3404-3453`) restores refs; unknown/invalid kinds are dropped with a counted notice, not silently. |
| 1.4 | `delete_element` (`:1908-1977`) prunes constraints and dimensions whose refs point at the deleted GUID — **this is a real existing defect**: the method currently cascades hosted openings and joins only, so a deleted wall leaves dangling constraints. |
| 1.5 | Extend `scratch/test_container_fidelity.py` with a reference round-trip: build walls, capture refs, save, load, assert `reference_key` equality. |

**Gate 1.** Round-trip preserves every reference key exactly; a deleted element's constraints and dimensions
are pruned, proven by a test; `references.py` has no import of `ifc_service` (checked by grep in the gate
script).

**Deliberately not here:** any solver involvement, any UI. This phase is inert so it can be verified alone.

---

### Phase 2 — Dimension object, persisted, not yet driving · M

Dimensions exist as data. Still no geometry change.

| # | Change |
|---|---|
| 2.1 | `self.dimensions: Dict[str, dict]` on the manager, initialised immediately after `self.constraints` (`ifc_service.py:233`); `self.dimensions_rev: int = 0` after `self.constraints_rev` (`:211`). |
| 2.2 | `add_dimension(refs, axis, offset)` → derives segment values from current geometry via `reference_point`; **takes no value** (§2 rule 4). Returns the record. |
| 2.3 | `DIMENSIONS_KEY = "dimensions"` added to `parametric_overlay` (`ifc_service.py:5136-5156`) and to both load branches (`:3431`, `:5280`). Bump `OVERLAY_SCHEMA_VERSION` 3 → 4 (`:52`) with a v3→v4 reader that synthesises refs for pre-existing `dimension_lock` constraints *without* changing their behaviour. |
| 2.4 | Snapshot/undo: add `"dimensions"` beside `"constraints"` (`ifc_service.py:425`) and `"dimensions_rev"` beside `"constraints_rev"` (`:442`); restore at `:524` and `:541`. Note `snapshot_state` already carries `levels`/`levels_rev` (`:423`, `:438`), so datums survive undo today. Then register the delta section alongside the existing `constraints_rev` gating (`backend/main.py:1080-1133` — verify the exact block, it is dense). |
| 2.5 | `resolve_dimension(dim_id, segment_index) -> Optional[float]` — recomputes a segment's value from current reference positions. This is what makes a dimension *read* the model instead of caching a number. |

**Gate 2.** A dimension created between two wall ends reports its measured length; after moving a wall, the
resolved value changes accordingly (it is measured, not stored); snapshot/undo restores dimensions; the v3
container still loads.

> **Verified while planning this phase.** `self.constraints` is initialised at `ifc_service.py:233`,
> `self.constraints_rev` at `:211`; the overlay writes `constraints` at `:5144`; both load branches restore
> it at `:3431` and `:5280` and do so **wholesale, with no GUID-staleness gating** (only `type_properties`
> is gated, `:5286-5290`). Phase 1.4's pruning and Phase 2's reference repair are what make that acceptable
> for dimensions — do not copy the wholesale restore for `dimensions` without the repair path in place.

---

### Phase 3 — The dimension drives geometry · L · **the core phase**

| # | Change |
|---|---|
| 3.1 | New `ConstraintSolver.solve_dimensions(axis, dimension, pins)` (§3.3) — its own node table keyed by `reference_key`. |
| 3.2 | `move_reference(...)` on the manager (§3.3). Start with `wall_start`, `wall_end`, `host_offset`, `grid_axis`, `level_plane`; leave `wall_face_*` for Phase 5. |
| 3.3 | `DimensionValueSet` becomes the driver: it sets the segment value, marks the dimension driving, and resolves — moving the *reference*, then letting existing propagation carry the element. |
| 3.4 | **Wire the existing `constraint` edge into `recompute()`** (`dependency_graph.py:160-216`). Today the walk collects `affected` only to count it. Make it real: for each affected node with inbound `constraint` edges, re-resolve the asserting dimensions after the join pass. This is the companion document's §10.1-C. |
| 3.5 | Conflict path: a failed dimension resolve returns the §3.5 shape with resolutions. **Never half-apply** — reuse the existing discipline (`constraint_solver.py:330-331` returns `[]` unless `ok`). |
| 3.6 | `last_constraint_conflict` gains a reader: `GET /api/constraints/conflict` and a `conflict` field on the mutation response of every dimension/constraint command. |

**Gate 3.** The round-trip test the audit says does not currently exist: create a wall, dimension
`wall_start ↔ wall_end`, issue `DimensionValueSet` to **12.0 ft**, assert the wall's `length == 12.0` and
that `resolve_dimension` returns `12.0` — *not* a delta-measured approximation. Second case: dimension
`wall_start ↔ grid_axis`, set to a value, assert the wall start coordinate lands on it. Third case:
deliberately over-constrain and assert a structured conflict with ≥1 resolution and **zero** geometry change.

**Sequencing note.** 3.4 is where the performance risk concentrates. Land 3.1–3.3 first and measure before
touching the graph walk.

---

### Phase 4 — Datums as witnesses · M

This is the phase that collapses three planned features into one, and it depends only on Phases 0–3.

| # | Change |
|---|---|
| 4.1 | `referenceable_kinds` publishes `level_plane` for `IfcBuildingStorey` and `grid_axis` for `IfcGrid`. Both already exist as elements (`add_level` `:581-598`, `add_grid` `:1836-1904`). |
| 4.2 | `move_reference` handles `level_plane` (rewrite `storey.Elevation`; the existing `move_level` at `:1108-1163` already propagates to members with `_propagate=False` — reuse it) and `grid_axis` (move the axis curve; **fix the known defect** that `translate_element` on an `IfcGrid` mutates meta only and lets the datum diverge from `model.ifc`). |
| 4.3 | Add `levels` to the 2-D plan contract. **It does not exist today** — the contract keys are assembled at `ifc_service.py:4817-4825` / `hlr_renderer.py:1370-1405` and contain `grids` but no `levels`. Levels are currently not drawn at all. |
| 4.4 | Render level lines and grid dimensions in `PlanViewport2D.tsx`, with the same padlock affordance as other dimensions. |

**Gate 4.** A dimension from `wall_face` (Phase 5) or `wall_start` to `level_plane` drives the level; a
dimension between two `grid_axis` references drives grid spacing; levels appear in a plan view and their
dimension strings are editable.

> **Ordering constraint.** 4.2's grid fix should land **before** 4.4 renders grid dimensions, otherwise the
> UI will display a datum that can drift from the IFC model of record.

---

### Phase 5 — Faces, EQ, and the binding slot · L

| # | Change |
|---|---|
| 5.1 | `wall_face_pos` / `wall_face_neg` reference kinds (offset by `thickness/2` from the baseline). |
| 5.2 | The `binding` enum enforced in one place: a validator that rejects `locked` + `label` together, and rejects `locked` on `len(refs) > 2` unless `binding == "equal"`. Mirrors `Dimension.IsLocked`'s documented restriction. |
| 5.3 | EQ over segments: `eq_anchor` (index into refs) + `toggle_segments_equal`. Reuse `ConstraintSolver._apply_equalize`'s `equal_length` chain (`constraint_solver.py:284-309`) — it already implements "equal gaps between consecutive items" and already documents why an absolute-distance chain was wrong. |
| 5.4 | Migrate `dimension_lock` onto the dimension model. **Read-old / write-new**: the existing type keeps working and is converted on load. Do not break `ConstraintLockDim`. |

**Gate 5.** A 3-reference dimension with `binding: "equal"` redistributes its interiors and holds through a
later move of a span endpoint (the case the audit's B4 probe verified at
`AUDIT-engine-performance-vs-revit.md:112`); setting `locked` on a labelled dimension is **rejected by the
validator**, not silently ignored.

---

### Phase 6 — Create and edit dimensions in the view · L

The interaction surface. This is where "dimensions are the primary editing device"
(`review/IMPLEMENTATION-PLAN-revit-feel.md:195-197`) becomes true.

| # | Change |
|---|---|
| 6.1 | `DimensionCreate` + `DimensionValueSet` + `DimensionLockToggle` + `DimensionDelete` in `COMMAND_REGISTRY` (`command_bus.py:309-340`) with param models beside `ConstraintAlignParams` (`:94-113`). |
| 6.2 | Bus-parity mapping in `UI_ACTION_COMMANDS` (`useBimStore.ts:98-132`) — the gate `scripts/check-bus-parity.mjs` requires this. |
| 6.3 | Enable `DI` (Aligned Dimension): `toolCaptions.ts:40` `implemented: false` → `true`; `Ribbon.tsx:578` un-gate; bind the hotkey. **Note** `scripts/check-ui-p0.mjs:194-196,444-449` currently *asserts* `DI` is unimplemented — those assertions must be updated in the same commit, deliberately, not by weakening the gate. |
| 6.4 | Render real dimensions with witness lines in `PlanViewport2D.tsx`, replacing `_overall_dimensions`' regex-derived pair with model-backed `dimensions[]` from the contract. `_overall_dimensions` (`ifc_service.py:4650-4703`) becomes a *fallback for views with no model dimensions*, and its docstring — *"Dimension strings are a renderer's output, not model data"* (`:4654-4657`) — is now false and must be corrected. |
| 6.5 | In-place text edit on the dimension string, reusing `tryParseLength` (`src/utils/units.ts:140-211`). The audit calls this parser "genuinely good" and an asset to preserve (`AUDIT-…:124-126`). |
| 6.6 | Retire the temporary-dimension path: `applyTemporaryDimensionChange` (`useBimStore.ts:1087-1098`) becomes `DimensionValueSet` on a real dimension. Delete `witnessP1`/`witnessP2` — **written and never read today**. |

**Gate 6.** `npm run check` passes (bus parity, UI invariants, `tsc --noEmit`); a dimension can be placed
between two picked references, its text typed over, and the model responds; the value round-trips.

---

### Phase 7 — Chains, reveal-constraints, and the audit trail · M

| # | Change |
|---|---|
| 7.1 | Dimension chains: a UI gesture producing one dimension with `n` refs rather than `n−1` dimensions. Only now is this well-defined (§2 rule 2). |
| 7.2 | A **reveal-constraints view mode** (Revit `TemporaryViewMode.RevealConstraints`) that draws the constraint graph. This is the missing half of spec §12 `:517-518` (*"Over-constraint MUST produce a conflicting-set report"*) — a report needs somewhere to appear. |
| 7.3 | Resolution affordances: wire the §3.5 `resolutions` list to buttons. |

**Gate 7.** A deliberately over-constrained model offers `unlabel` / `unlock_dimension` / `release_eq` and
each one visibly resolves it; the reveal mode shows every constraint and dimension edge.

---

### Phase 8 — Deferred seams (do not schedule yet)

`AngularDimension` / `RadialDimension` / `SpotDimension` behind the same `Ref`+`binding` model;
sketch-mode `VarSketch` unification (make `backend/sketch_model.py` produce constraints the project solver
consumes — the spec already flags this as `[GAP-adjacent]` at `SPECIFICATION-v0.2.md:658-659`);
`parameter` binding for real, completing `sketch → auto-dimension → label → solve`
(`SPECIFICATION-v0.2.md:652-656`).

---

## 5. Cross-cutting: the environment trap

**`constraint_solver.py:43-47` swallows the missing-solver case, and `ifc_service.py:2129-2130` turns it
into a printed "Notice".** On a machine without `planegcs` — including this workspace, where it is not
importable from either available Python and there is no `.venv` — **every constraint silently does nothing**
and the app looks like it works.

This must be fixed in Phase 0 or every later gate is meaningless. Recommended: pin `planegcs` in
`requirements.txt` (it is already declared at `:9`), add a `/health` field reporting solver availability,
and surface unavailability in the UI rather than the console.

---

## 6. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Silent wrong geometry.** A reference that mis-resolves moves the wrong thing, and unlike a dangling GUID it still *looks* planned. | High | Hint-based `repair_reference` returning an explicit outcome; `ambiguous`/`lost` are **refusals**, never guesses. Gate 1 asserts every outcome is exercised. |
| R2 | **Scope explosion in the solve.** `affected_guids` already widens to the connected component (measured 31 participants for 29 constraints, `AUDIT-engine-performance-vs-revit.md:114-115`); reference-keyed nodes are finer-grained, which could widen further. | High | Measure in Gate 3 before landing 3.4 (the graph walk). Scope dimensions to the touched reference pair plus one hop, and prove it with a counter. |
| R3 | **Overlay migration breaks existing `.bimworks` files.** | Medium | v3→v4 reader synthesises refs; never mutate a loaded v3 constraint's behaviour; `test_container_fidelity.py` gains a v3 fixture. |
| R4 | **Two sources of truth for a length.** `meta["length"]` vs a dimension's segment value. | Medium | `resolve_dimension` is the only reader; `length` stays derived from `start`/`end`. Add an invariant check to Gate 3. |
| R5 | **UI gate discourages the change.** `check-ui-p0.mjs` asserts `DI` is unimplemented. | Low | Update the assertion deliberately in Phase 6.3 with the reason recorded; do not weaken it. |
| R6 | **planegcs API mismatch.** The solver wrapper's assumed primitives are unverified. | Medium | Phase 0.2 inventory before Phase 1. |
| R7 | **Sketch mode diverges further.** Unifying later may be harder if project dimensions and sketch constraints grow apart. | Low–Medium | Keep the `Reference` vocabulary the single one; do not invent a second constraint vocabulary in `sketch_model.py`. |

---

## 7. Explicitly not doing

Recorded so the refusals are reviewable, with the reason from the companion document.

1. **View-specific dimensions and reference recovery.** Requires a `DimensionReferenceRecoveryManager`
   equivalent; the entire cost of the model/view split lands here. Defer until model dimensions are solid.
2. **Constraint-inference heuristics on the drag path** (`DimHeuristicMajorityWin`, `MatchOriginWin`,
   `ShortestWin`). These guess intent during ambiguous drags. A typed value on a selected dimension is
   unambiguous and needs none of them.
3. **A new solver.** `planegcs` is adequate, already wrapped, and already the GPL-3.0 licence rationale
   (`SPECIFICATION-v0.2.md:524-526`).
4. **Parsing or imitating Revit's stable-representation grammar.** Autodesk states it is *"not intended to
   be parsed"*. Adopt the *property* — opaque, durable, re-resolvable — not the format.
5. **`z`-axis dimensions.** The solver is axis-decoupled and `z` is currently unreachable through the bus
   (`command_bus.py:97` restricts to `Literal["x","y"]`) and unsolved (`ifc_service.py:2147` iterates
   `("x","y")`). Out of scope; noted so the `"z"` in the TS union (`types/bim.ts:197`) is not mistaken for
   support.
6. **Multi-segment EQ before single-segment dimensions work.** Forced by Revit's own restriction and by
   `AUDIT-dimension-editing-vs-revit.md:463`.

---

## 8. Spec impact

The normative spec is currently **silent** on a dimension object: §12 covers constraints, and the §5 overlay
list (`SPECIFICATION-v0.2.md:141-143`) names `constraints` but not `dimensions`. This plan makes
`SPECIFICATION-v0.2.md` wrong by omission. Required edits, to be made in the phase that lands each:

| Spec location | Change | Phase |
|---|---|---|
| §5 overlay list, `:141-143` | add `dimensions` to the overlay contents | 2 |
| §7 recompute, `:207-210` | state that a dimension is a dependency-graph parent, not a post-move pass | 3 |
| §12 Constraints, `:511-526` | add the dimension-as-constraint requirements: ordered refs, positional segments, one binding slot, value-not-delta commands, conflict-with-resolution | 3, 5 |
| §9 2-D engine, `:370-376` | the chain concept (`:374-376`) is realised by `n`-reference dimensions — update from `[REQ]` aspirational to implemented | 7 |
| §14.2 labeling chain, `:652-659` | note that project-level dimensions now share the reference vocabulary; the sketch-mode half remains open | 8 |

The audit's Top-10 list (`review/AUDIT-dimension-editing-vs-revit.md:439-463`) maps onto this plan as:
items 1–3 → Phase 0/2/3; 4–5 → Phase 6; 6 → Phase 0 (already fixed in the current tree); 7–8 → out of scope
(wall trim/split); 9 → Phase 4; 10 → Phase 6.3.

---

## 9. Gate summary

| Gate | Runnable check | Protects |
|---|---|---|
| 0 | `python scratch/test_solver_capability.py`; EQ over distinct endpoints | The solver exists and actually runs |
| 1 | `python scratch/test_container_fidelity.py` + reference round-trip; delete-prunes test | Reference identity survives save/load; no dangling refs |
| 2 | `python scratch/test_dimensions.py` (new) | Dimensions persist, measure, survive undo |
| 3 | dimension-value round-trip; datum dimension; structured conflict | **The core claim**: a typed value drives geometry and comes back |
| 4 | level/grid dimension drives the datum | Datums are witnesses, not a special case |
| 5 | EQ span holds through an endpoint move; binding validator rejects lock+label | Segments and the binding slot |
| 6 | `npm run check` (bus parity + UI invariants + `tsc --noEmit`) | The change is reachable and typed |
| 7 | over-constraint offers working resolutions | Spec §12 `:517-518` is actually satisfied |

Every gate is a **script**, following the repo's existing convention (`scratch/test_*.py`,
`scripts/check-*.mjs`), so it can be re-run and can fail.

**One rule to carry through all of it**, from the repo's own README:

> *"if a key parameter is constant across a corpus, the suite is blind on that dimension regardless of how
> many checks it has. It applies to probes as well as tests."* (`README.md:184-185`)

For this work the parameters that must **vary** in every gate fixture are: the reference *kind* pair
(end↔end, end↔datum, face↔datum), the *axis*, the *sign* of the value change (grow and shrink), and the
number of references (2 and ≥3). A suite that fixes any one of those is blind on it.

---

## 10. Provenance of the line references in this plan

Two classes, so an implementer knows what to trust as-is.

**(a) Read directly from the tree while writing this plan** — safe to act on:

`constraint_solver.py:43-47, 104-107, 199-309, 330-331` · `dependency_graph.py:35, 71-87, 160-216` ·
`ifc_service.py:211, 233, 397-445, 425, 442, 524, 541, 581-598, 1108-1163, 1254-1285, 1836-1904,
1908-1977, 2126-2132, 2134-2185, 2157, 2423-2444, 2446-2479, 2489-2518, 2520-2589, 3265-3289, 3404-3453,
3431, 4650-4703, 4817-4825, 5101-5182, 5136-5156, 5280` · `command_bus.py:94-113, 309-340` ·
`units.py:100-139` · `hlr_renderer.py:1370-1405` · `main.py:1066, 1080` · `src/types/bim.ts:182-208` ·
`src/store/useBimStore.ts:98, 545, 1019, 1037-1038, 1087, 1261` · `scripts/check-ui-p0.mjs:194, 444` ·
`OVERLAY_SCHEMA_VERSION = 3` (`ifc_service.py:52`), `CONTAINER_FORMAT_ID`
(`:47`).

**(b) Inherited from the audit and re-stated, not re-measured** — treat as a lead, verify before editing:
exact `ELEMENT_PARAM_FIELDS` membership semantics · the `_finish_plan_contract` key list beyond
`:4817-4825` · `Ribbon.tsx:487, 578` and `toolCaptions.ts:32-45` line numbers · the audit's own
`AUDIT-dimension-editing-vs-revit.md` citations, which this plan quotes but did not re-derive.

**One correction to the audit already applied here:** the audit's §5 states levels are absent from the plan
contract, and that is **confirmed** — `hlr_renderer.py:1370-1405` has `grids` and `dimensions` but no
`levels` key, and `_finish_plan_contract` (`:4817-4825`) never adds one. Phase 4.3 is therefore new work,
not a repair.

**One thing this plan could not verify and does not depend on:** the `planegcs` Python API surface
(Phase 0.2). If it lacks a primitive Phase 3 needs, the encoding changes — the phases and gates do not.
