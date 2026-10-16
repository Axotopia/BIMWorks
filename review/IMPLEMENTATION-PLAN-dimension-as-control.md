# IMPLEMENTATION PLAN — dimension as a modelling control

**Companion to** [`revit-dimension-as-control.md`](revit-dimension-as-control.md) (the mechanism, evidenced from Revit 2027).
**Applies to** the BIMWorks repository root.
**Status** **in progress — not complete.** Authored 2026-10-15; state refreshed 2026-10-15 against
`main` @ `63e7d6e`. Phases **0, 3, 4 and 7 are not started**; parts of 1, 2, 5 and 6 have landed.
Per-task state is recorded in §0.1, and the full measurement is in
[`AUDIT-dimension-as-control-status-2026-10-15.md`](AUDIT-dimension-as-control-status-2026-10-15.md).

---

## 0. Why this plan exists

The companion document establishes that a Revit dimension is a **constraint element** — an ordered array of
durable references plus a binding. In previous revisions, BIMWorks had the solver, the overlay, the dependency graph and
the command bus, but lacked persistent dimension objects and reference identity. While dimension objects arrived in
commit `d786484` (`BimModelManager.dimensions` in `ifc_service.py`, `BimModelManager.create_dimension`,
the `DimensionCreate` verb in `command_bus.py`, `BimModelManager.save_orlt_project` /
`load_orlt_project` for overlay persistence, and the `normalize_reference` call sites in
`rebuild_from_overlay` and the legacy branch of `load_orlt_project`), the missing foundation was
**durable, typed geometric reference identity** (`backend/references.py`), explicit resolution
outcomes, repair, and multi-source provenance.

This plan is amended to consume `backend/references.py` per [`IMPLEMENTATION-PLAN-geometric-references.md`](IMPLEMENTATION-PLAN-geometric-references.md).
It gives dimensions durable reference identity, drives the solver via explicit outcomes (`exact`, `repaired`, `ambiguous`, `lost`),
and wires the dependency edge that already exists.

**Three things make this smaller than it looks:**

| Already present | Where | Consequence |
|---|---|---|
| A real Newton solver (`planegcs` / PlaneGCS) | `ConstraintSolver.solve` in `backend/constraint_solver.py` (with `_solve_pure_python` as fallback) | no solver to write |
| A `constraint` edge kind, built, but unused for work | `EDGE_KINDS` and the constraint-link block in `DependencyGraph.recompute` (`backend/dependency_graph.py`); `recompute` still mutates only via `recompute_wall_joins` | wiring, not building — still true, see Phase 3.4 |
| An overlay + typed bus + journal + undo | `snapshot_state` / `restore_state` and `save_orlt_project` / `load_orlt_project` in `ifc_service.py`; `COMMAND_REGISTRY` and `CommandBusEngine.create_memento` in `command_bus.py` | persistence and commands are additive |

**One thing makes it riskier than it looks:** the reference primitive (§3.1) changes the identity model.
Getting it wrong converts today's *silent dangling constraint* into *silent wrong geometry*. §6 addresses this.

---

## 0.1 Implementation status (measured `main` @ `63e7d6e`)

The primitive half of this plan shipped under
[`IMPLEMENTATION-PLAN-geometric-references.md`](IMPLEMENTATION-PLAN-geometric-references.md) (Phases 0–5 of
*that* plan). **The consumer half — everything below — is largely unbuilt.** Measured state:

| Phase | Size | State | Note |
|---|---|---|---|
| **0** — Unblock and verify | S, *prerequisite* | ❌ **0/3** | incl. a live user-visible EQ bug (§0.1.1) |
| **1** — Reference primitive | M | ⚠️ **1.5/5** | 1.1 done via the geometric plan; 1.2–1.5 open |
| **2** — Dimension object | M | ⚠️ **2/5** | 2.1, 2.4 done |
| **3** — The dimension drives geometry | L, *core* | ❌ **~1/6** | `solve_dimensions`/`move_reference` absent |
| **4** — Datums as witnesses | M | ❌ **0/4** | levels still absent from the 2-D plan contract |
| **5** — Faces, EQ, binding | L | ⚠️ **1/4** | 5.1 done (`ordinal` ignored) |
| **6** — Create and edit in the view | L | ⚠️ **3/6** | 6.2, 6.5 done; `DI` still gated off |
| **7** — Chains, reveal, audit trail | M | ❌ **0/3** | |
| **8** — Deferred seams | — | n/a | "do not schedule yet" still applies |

Symbols this plan requires that **do not exist**: `ConstraintSolver.solve_dimensions` (3.1),
`BimModelManager.move_reference` (3.2), `resolve_dimension` (2.5), `referenceable_kinds` (4.1),
`DimensionLockToggle` (6.1), `GET /api/constraints/conflict` (3.6),
`scratch/test_solver_capability.py` (0.2).

### 0.1.1 Defects that are still live

1. **Phase 0.1 — the degenerate EQ caller is still in the tree.** `src/store/useBimStore.ts:1520` passes
   the **same GUID for both span endpoints** (`equalizeSpan(southWall, southWall, targets, 'x')`), so
   `total_span = 0` ⇒ `spacing = 0` ⇒ targets collapse to a point. Unfixed. (Note the plan previously
   cited this as `useBimStore.ts:1261`; it is now at `:1520`.)
2. **Phase 1.4 — deleting an element leaves dangling constraints.** Dimensions are pruned; constraints
   are not. Reproduced: after `delete_element(w1)`, an `align_*` constraint still references `w1`.
   This will corrupt solver scope as soon as Phase 3 lands, so fix it before 3.1.
3. **Phase 0.3 — a missing solver is now *silent*, which is worse than when this plan was written.**
   `ifc_service.py` (in `_solve_constraints_after_move`) ends `except Exception as e: return` with a
   comment naming the missing-`planegcs` case. The plan below records a printed "Notice"; there is no
   longer even that. Every later gate is meaningless while this holds.

### 0.1.2 Two corrections to the plan's own prose

- **The environment has changed.** §5 says `planegcs` "is not importable from either available Python
  and there is no `.venv`". There **is** a `.venv`, and `planegcs` **is** installed in it and importable.
  Phase 0.2's inventory is still worth doing (the *API surface* remains unverified), but its premise has
  moved.
- **Citations.** Every `file:line` reference below has drifted (the geometric refactor, the `revitUI`
  work and the UI-P0 work all landed after this plan was written) — several by hundreds of lines. §10
  now states the policy: anchors are **symbol-based**, and line numbers are marked verified or removed.

### 0.1.3 Three items previously filed as geometric-refactor bugs are tasks *here*

If they are being tracked as defects, retarget them: 2-D `level_plane` returning `(0.0, elevation)`
labelled `"exact"` is Phase 4's datum work (§3.3.1 of the geometric plan); `wall_face_*` ignoring
`ordinal` is Phase 5.1; the diagonal `grid_axis` axis-form substitution is Phase 4.2.

---

## 1. Scope

**In scope** — project-level linear dimensions that drive geometry; datums (levels, grids) as dimensionable
references; per-segment values; EQ over segments; lock/label as mutually-exclusive bindings; conflict
surfacing.

**Out of scope** — the sketch-mode solver unification (**Phase 8**, deferred; adjacent and larger);
view-specific dimensions and reference recovery (explicitly refused, §7); angular/radial/spot dimensions
beyond leaving the seam (Phase 8); the constraint heuristics on the drag path.

---

## 2. Target model

The end state, stated once so every phase can be checked against it.

```
ReferenceKind = "wall_start" | "wall_end" | "wall_center" | "wall_face_pos" | "wall_face_neg" | "host_offset"
              | "level_plane"  | "grid_axis" | "intersection" | "extension" | "point"

Reference {
  sources      : [{element_guid: str, ordinal: int}, ...]  # multi-source provenance
  kind         : ReferenceKind
  hint         : {                                          # repair-only; NEVER the identity
      point    : [x,y,z]                                    # world position when captured, decimal feet
      normal   : [x,y,z] | null
  }
  guid         : str | null                                 # backward-compatible primary guid
  ref          : str | null                                 # backward-compatible semantic string
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

### 3.1 The reference primitive — `backend/references.py` (implemented per geometric-references plan)

The load-bearing change. A single module owns reference construction, comparison, serialisation, resolution
and repair. Nothing else may construct an un-normalized reference dict.

```python
# backend/references.py
ReferenceKind = Literal[
    "wall_start", "wall_end", "wall_center", "wall_face_pos", "wall_face_neg",
    "host_offset", "level_plane", "grid_axis", "intersection", "extension", "point"
]

def normalize_reference(raw: Dict[str, Any]) -> Dict[str, Any]: ...
def reference_key(ref: Dict[str, Any]) -> str: ...
def resolve_reference(manager: Any, ref: Dict[str, Any]) -> Tuple[Optional[Tuple[float, float]], str]: ...
def resolve_reference_axis(manager: Any, ref: Dict[str, Any], axis: str) -> Tuple[Optional[float], str]: ...
def repair_reference(manager: Any, ref: Dict[str, Any], candidate_guids: Optional[List[str]] = None, tolerance: float = 1.0) -> Tuple[Dict[str, Any], str]: ...
```

`repair_reference` is the BIMWorks counterpart of `Reference.Refresh` +
`DimensionReferenceRecoveryManager`, returning explicit outcomes in `{"exact", "repaired", "ambiguous", "lost"}`.

### 3.2 Dimensions live beside constraints, not inside them

Rejected: adding `"type": "dimension"` to the existing `self.constraints` dict. That dict is a
heterogeneous bag already (`align`, `dimension_lock`, `equalize` — see the constraint-creation helpers
`BimModelManager.add_align_constraint` / `add_dimension_lock` and `_apply_equalize`) and the solver
dispatches on `type` (`ConstraintSolver._solve_with_planegcs`). A dimension has a *different shape*
(ordered refs + positional segments + a binding) and needs its own resolution and repair path.

Adopted: a **parallel collection** `self.dimensions: Dict[str, dict]`, with the existing three constraint
types kept as-is. `ConstraintSolver` gains a dimension pass that runs before the legacy pass. Rationale: it
is additive, it cannot corrupt the existing three types, and `dimension_lock` — which is nearly a dimension
already — can be *migrated* onto the new model later rather than being rewritten now.

**Do not add a fourth entry to `EDGE_KINDS`.** Dimensions contribute `"constraint"` edges, exactly as
the constraint-link block in `DependencyGraph.recompute` already does for the three types, because the
edge kind describes *what kind of dependency* it is, not which object asserted it.

### 3.3 The solver solves references, not elements

`ConstraintSolver` currently maps one movable node per element-GUID per axis (see its coordinate
collection and `_solve_with_planegcs` / `_solve_pure_python`). That is the wrong granularity for a
dimension: a `wall_start ↔ grid_axis` constraint must move a *point*, and a
`wall_start ↔ wall_end` constraint must change a *length*.

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

`last_constraint_conflict` is currently written (by `_solve_constraints_after_move` in `ifc_service.py`)
and read by nothing. It becomes a returned value with, per the companion §10.1-E, **at least one offered
resolution**. Required shape:

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

| # | Change | File | Status | Note |
|---|---|---|---|---|
| 0.1 | Fix the degenerate EQ caller: `equalizeSpan(southWall, southWall, targets, 'x')` passes the **same GUID for both span endpoints** | the `equalizeSpan` caller in `src/store/useBimStore.ts` | ❌ **open** | `pos_start == pos_end` ⇒ `total_span = 0` ⇒ `spacing = 0` ⇒ targets collapse to a point. The solver is fine; the sole UI caller is malformed. Confirmed against `_apply_equalize` / the `equalize` branch of `ConstraintSolver.solve`. |
| 0.2 | Inventory the **actual** planegcs Python API | new `scratch/test_solver_capability.py` | ❌ **open** | `ConstraintSolver._solve_with_planegcs` assumes `add_point`, `add_fixed_point`, `set_p2p_distance`, `coincident`, `add_line`, `equal_length`, `get_point`, `solve` exist with these signatures. **Still unverified.** Print what is present. |
| 0.3 | Install and pin planegcs; make its absence **loud** | `requirements.txt`; `_solve_constraints_after_move` in `ifc_service.py` | ⚠️ **regressed** | `planegcs` *is* now installed in `.venv`, but a missing solver is a bare `except Exception: return` — **silent**. The plan recorded a printed "Notice"; there is no longer even that. Gate 0's "raises a surfaced error" is **not met**. |

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

| # | Change | Status |
|---|---|---|
| 1.1 | New `backend/references.py` with the §3.1 surface. Pure functions over `manager`; no state. | ✅ **done** — shipped under the geometric-references plan |
| 1.2 | `_build_overlay_element` writes `refs` alongside the existing fields. `ELEMENT_PARAM_FIELDS` unchanged — refs are a separate key, mirroring how `footprint`/`sketch` are handled. | ❌ **open** — no per-element `refs` key is written |
| 1.3 | `rebuild_from_overlay` restores refs; unknown/invalid kinds are dropped with a counted notice, not silently. | ❌ **open** — nothing to restore until 1.2 lands |
| 1.4 | `delete_element` prunes constraints **and** dimensions whose refs point at the deleted GUID — **this is a real existing defect**: the method currently cascades hosted openings and joins only, so a deleted wall leaves dangling constraints. | ⚠️ **half done** — dimensions *are* pruned; **constraints are not**. Reproduced: after `delete_element(w1)` an `align_*` constraint still references `w1`. Fix before 3.1. |
| 1.5 | Extend `scratch/test_container_fidelity.py` with a reference round-trip: build walls, capture refs, save, load, assert `reference_key` equality. | ❌ **open** — `reference_key` appears 0× in that suite |

**Gate 1.** Round-trip preserves every reference key exactly; a deleted element's constraints and dimensions
are pruned, proven by a test; `references.py` has no import of `ifc_service` (checked by grep in the gate
script).

**Deliberately not here:** any solver involvement, any UI. This phase is inert so it can be verified alone.

---

### Phase 2 — Dimension object, persisted, not yet driving · M

Dimensions exist as data. Still no geometry change.

| # | Change | Status |
|---|---|---|
| 2.1 | `self.dimensions: Dict[str, dict]` on the manager, initialised immediately after `self.constraints`; `self.dimensions_rev: int = 0` after `self.constraints_rev`. | ✅ **done** |
| 2.2 | `add_dimension(refs, axis, offset)` → derives segment values from current geometry; **takes no value** (§2 rule 4). Returns the record. | ⚠️ **deviates** — the shipped `create_dimension(ref_a, ref_b, …, value=None)` takes a value and no `refs`-first form |
| 2.3 | `DIMENSIONS_KEY = "dimensions"` added to `parametric_overlay` and to both load branches. Bump `OVERLAY_SCHEMA_VERSION` 3 → 4 with a v3→v4 reader that synthesises refs for pre-existing `dimension_lock` constraints *without* changing their behaviour. | ⚠️ **partial** — dimensions do persist and are normalized on load, but `OVERLAY_SCHEMA_VERSION` is still **3** and there is no v3→v4 reader |
| 2.4 | Snapshot/undo: add `"dimensions"` beside `"constraints"` and `"dimensions_rev"` beside `"constraints_rev"`; restore both. Note `snapshot_state` already carries `levels`/`levels_rev`, so datums survive undo today. Then register the delta section alongside the existing `constraints_rev` gating (the block in `backend/main.py` — verify it, it is dense). | ✅ **done** for capture/restore |
| 2.5 | `resolve_dimension(dim_id, segment_index) -> Optional[float]` — recomputes a segment's value from current reference positions. This is what makes a dimension *read* the model instead of caching a number. | ❌ **open** — absent |

**Gate 2.** A dimension created between two wall ends reports its measured length; after moving a wall, the
resolved value changes accordingly (it is measured, not stored); snapshot/undo restores dimensions; the v3
container still loads.

> **Verified while planning this phase, anchors refreshed.** `self.constraints` and
> `self.constraints_rev` are initialised beside `self.dimensions` / `self.dimensions_rev` in
> `BimModelManager.__init__`; the overlay writes `constraints` in `save_orlt_project`; both load
> branches restore it — in `rebuild_from_overlay` for schema v3, and in the legacy branch of
> `load_orlt_project` — and they do so **wholesale, with no GUID-staleness gating** (only
> `type_properties` is gated). Phase 1.4's pruning and Phase 2's reference repair are what make that
> acceptable for dimensions — do not copy the wholesale restore for `dimensions` without the repair
> path in place.

---

### Phase 3 — The dimension drives geometry · L · **the core phase**

| # | Change | Status |
|---|---|---|
| 3.1 | New `ConstraintSolver.solve_dimensions(axis, dimension, pins)` (§3.3) — its own node table keyed by `reference_key`. | ❌ **open** — absent; the solver still solves *elements* by coordinate, not references |
| 3.2 | `move_reference(...)` on the manager (§3.3). Start with `wall_start`, `wall_end`, `host_offset`, `grid_axis`, `level_plane`; leave `wall_face_*` for Phase 5. | ❌ **open** — absent. **Naming trap:** the *frontend* `store.moveReference` and the `ReferenceMove` bus verb exist, but the manager-level method does not, and `store.moveReference` has **zero callers**, so `ReferenceMove` is unreachable from the UI. |
| 3.3 | `DimensionValueSet` becomes the driver: it sets the segment value, marks the dimension driving, and resolves — moving the *reference*, then letting existing propagation carry the element. | ⚠️ **partial** — `set_dimension_value` resizes/translates through the delta path, not by moving a reference |
| 3.4 | **Wire the existing `constraint` edge into `DependencyGraph.recompute`.** Today the walk collects `affected` only to count it. Make it real: for each affected node with inbound `constraint` edges, re-resolve the asserting dimensions after the join pass. This is the companion document's §10.1-C. | ❌ **open** — `recompute` still counts `affected` and acts only via `recompute_wall_joins` |
| 3.5 | Conflict path: a failed dimension resolve returns the §3.5 shape with resolutions. **Never half-apply** — reuse the existing discipline (the solver returns `[]` unless `ok`). | ⚠️ **partial** — `last_constraint_conflict` is populated; there is no `resolutions` list |
| 3.6 | `last_constraint_conflict` gains a reader: `GET /api/constraints/conflict` and a `conflict` field on the mutation response of every dimension/constraint command. | ❌ **open** — route absent |

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

| # | Change | Status |
|---|---|---|
| 4.1 | `referenceable_kinds` publishes `level_plane` for `IfcBuildingStorey` and `grid_axis` for `IfcGrid`. Both already exist as elements (`BimModelManager.add_level`, `BimModelManager.add_grid`). | ❌ **open** — absent |
| 4.2 | `move_reference` handles `level_plane` (rewrite `storey.Elevation`; the existing `move_level` already propagates to members with `_propagate=False` — reuse it) and `grid_axis` (move the axis curve; **fix the known defect** that `translate_element` on an `IfcGrid` mutates meta only and lets the datum diverge from `model.ifc`). | ❌ **open** — depends on 3.2 |
| 4.3 | Add `levels` to the **2-D plan** contract. It does not exist today — the contract keys carry `grids` but no `levels`. Levels are currently not drawn in plan views. | ❌ **open** — `levels` reaches only *vertical* views (the `is_vert_view` branch of `_finish_plan_contract`); the plan contract still has none |
| 4.4 | Render level lines and grid dimensions in `PlanViewport2D.tsx`, with the same padlock affordance as other dimensions. | ❌ **open** |

**Gate 4.** A dimension from `wall_face` (Phase 5) or `wall_start` to `level_plane` drives the level; a
dimension between two `grid_axis` references drives grid spacing; levels appear in a plan view and their
dimension strings are editable.

> **Ordering constraint.** 4.2's grid fix should land **before** 4.4 renders grid dimensions, otherwise the
> UI will display a datum that can drift from the IFC model of record.

---

### Phase 5 — Faces, EQ, and the binding slot · L

| # | Change | Status |
|---|---|---|
| 5.1 | `wall_face_pos` / `wall_face_neg` reference kinds (offset by `thickness/2` from the baseline). | ✅ **done** — resolves via `resolve_reference`; note `ordinal` is still **ignored** by resolution (the key distinguishes it, the resolver does not) |
| 5.2 | The `binding` enum enforced in one place: a validator that rejects `locked` + `label` together, and rejects `locked` on `len(refs) > 2` unless `binding == "equal"`. Mirrors `Dimension.IsLocked`'s documented restriction. | ❌ **open** — `binding` appears nowhere in the backend |
| 5.3 | EQ over segments: `eq_anchor` (index into refs) + `toggle_segments_equal`. Reuse `ConstraintSolver._apply_equalize`'s `equal_length` chain — it already implements "equal gaps between consecutive items" and already documents why an absolute-distance chain was wrong. | ⚠️ **partial** — `eq_group` exists and `_apply_equalize` is implemented; no `eq_anchor` |
| 5.4 | Migrate `dimension_lock` onto the dimension model. **Read-old / write-new**: the existing type keeps working and is converted on load. Do not break `ConstraintLockDim`. | ⚠️ **partial** — `dimension_lock` is still a separate constraint type, created by `create_dimension(is_locked=True)` |

**Gate 5.** A 3-reference dimension with `binding: "equal"` redistributes its interiors and holds through a
later move of a span endpoint (the case the audit's B4 probe verified at
`AUDIT-engine-performance-vs-revit.md:112`); setting `locked` on a labelled dimension is **rejected by the
validator**, not silently ignored.

---

### Phase 6 — Create and edit dimensions in the view · L

The interaction surface. This is where "dimensions are the primary editing device"
(`review/IMPLEMENTATION-PLAN-revit-feel.md:195-197`) becomes true.

| # | Change | Status |
|---|---|---|
| 6.1 | `DimensionCreate` + `DimensionValueSet` + `DimensionLockToggle` + `DimensionDelete` in `COMMAND_REGISTRY` with param models beside `ConstraintAlignParams`. | ⚠️ **partial** — all present **except `DimensionLockToggle`** (absent; only `ConstraintLockToggle` exists) |
| 6.2 | Bus-parity mapping in `UI_ACTION_COMMANDS` — the gate `scripts/check-bus-parity.mjs` requires this. | ✅ **done** — `createDimension`, `setDimensionValue`, `deleteDimension` |
| 6.3 | Enable `DI` (Aligned Dimension): flip `implemented: false` → `true` in `toolCaptions.ts`; un-gate `Ribbon.tsx`; bind the hotkey. **Note** `scripts/check-ui-p0.mjs` currently *asserts* `DI` is unimplemented — those assertions must be updated in the same commit, deliberately, not by weakening the gate. | ❌ **open** — `DI` is still `implemented: false` |
| 6.4 | Render real dimensions with witness lines in `PlanViewport2D.tsx`, replacing `_overall_dimensions`' regex-derived pair with model-backed `dimensions[]` from the contract. `_overall_dimensions` becomes a *fallback for views with no model dimensions*, and its docstring — *"Dimension strings are a renderer's output, not model data"* — is now false and must be corrected. | ⚠️ **partial** — model-backed dimensions now reach the contract and render; the docstring was **not** corrected |
| 6.5 | In-place text edit on the dimension string, reusing `tryParseLength` (`src/utils/units.ts`). The audit calls this parser "genuinely good" and an asset to preserve. | ✅ **done** |
| 6.6 | Retire the temporary-dimension path: `applyTemporaryDimensionChange` becomes `DimensionValueSet` on a real dimension. Delete `witnessP1`/`witnessP2` — **written and never read today**. | ❌ **open** — `witnessP1`/`witnessP2` still have 9 references, and `applyTemporaryDimensionChange` still exists |

**Gate 6.** `npm run check` passes (bus parity, UI invariants, `tsc --noEmit`); a dimension can be placed
between two picked references, its text typed over, and the model responds; the value round-trips.

---

### Phase 7 — Chains, reveal-constraints, and the audit trail · M

| # | Change | Status |
|---|---|---|
| 7.1 | Dimension chains: a UI gesture producing one dimension with `n` refs rather than `n−1` dimensions. Only now is this well-defined (§2 rule 2). | ⚠️ **partial** — `refs` chaining exists in the data model and `create_dimension` accepts `refs`; no UI gesture |
| 7.2 | A **reveal-constraints view mode** (Revit `TemporaryViewMode.RevealConstraints`) that draws the constraint graph. This is the missing half of spec §12 (*"Over-constraint MUST produce a conflicting-set report"*) — a report needs somewhere to appear. | ❌ **open** |
| 7.3 | Resolution affordances: wire the §3.5 `resolutions` list to buttons. | ❌ **open** — depends on 3.5 |

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

**A missing solver is swallowed, and is now swallowed *more* quietly than when this plan was written.**
`constraint_solver.py` defines `SolverUnavailable` for the missing-`planegcs` case, and
`_solve_constraints_after_move` in `ifc_service.py` catches it. That block now ends:

```python
except Exception as e:
    # Solver unavailable (e.g. planegcs not installed) or conflict: keep model intact
    return
```

The plan previously recorded this as a printed "Notice"; there is no longer any output at all. On a
machine without `planegcs`, **every constraint silently does nothing** and the app looks like it works.

*Environment update:* the earlier text here said `planegcs` "is not importable from either available
Python and there is no `.venv`". That is no longer true — there **is** a `.venv` and `planegcs` **is**
installed and importable there. Phase 0.2's *API-surface* inventory is still outstanding and still
blocking Phase 1's encoding decision; the install question is closed.

This must be fixed in Phase 0 or every later gate is meaningless. Recommended: keep `planegcs` pinned in
`requirements.txt` (already declared), **make the absence raise** rather than return, add a `/health`
field reporting solver availability, and surface unavailability in the UI rather than the console.

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
   (the axis param models restrict to `Literal["x","y"]`) and unsolved (`_solve_constraints_after_move`
   iterates `("x","y")`). Out of scope; noted so the `"z"` in the TS union (`src/types/bim.ts`) is not
   mistaken for support.
6. **Multi-segment EQ before single-segment dimensions work.** Forced by Revit's own restriction and by
   `AUDIT-dimension-editing-vs-revit.md:463`.

---

## 8. Spec impact

**The normative spec has moved since this section was written.** `docs/SPECIFICATION-v0.3.md` is now
normative and **supersedes** `docs/SPECIFICATION-v0.2.md`, which is retained and incorporated by
reference for everything v0.3 does not change. The earlier premise here — *"the normative spec is
currently silent on a dimension object"* — is **no longer accurate**: v0.3 records that the persistent
dimension object shipped (in its list of shipped changes), names dimensions in normative requirements
alongside constraints, and records the ownership decision for the reference primitive as **Q2** (shared,
owned by `review/IMPLEMENTATION-PLAN-geometric-references.md`, with this plan amended to consume it) —
"so the decision is not re-litigated".

What remains is still worth tracking, but as **edits against v0.3**, and the section numbers below are
v0.2 numbering via incorporation. Line numbers are deliberately omitted (see §10); verify the target
section in v0.3 before editing.

| Spec location | Change | Phase | State |
|---|---|---|---|
| §5 overlay contents | add `dimensions` to the overlay list | 2 | appears **still open** in v0.3 |
| §7 recompute | state that a dimension is a dependency-graph parent, not a post-move pass | 3 | open (Phase 3.4 unimplemented) |
| §12 Constraints | add the dimension-as-constraint requirements: ordered refs, positional segments, one binding slot, value-not-delta commands, conflict-with-resolution | 3, 5 | partially addressed in v0.3 |
| §9 2-D engine | the chain concept is realised by `n`-reference dimensions — update from `[REQ]` aspirational to implemented | 7 | open |
| §14.2 labeling chain | note that project-level dimensions now share the reference vocabulary; the sketch-mode half remains open | 8 | open |

The audit's Top-10 list (`review/AUDIT-dimension-editing-vs-revit.md`) maps onto this plan as:
items 1–3 → Phase 0/2/3; 4–5 → Phase 6; 6 → Phase 0 (already fixed in the current tree); 7–8 → out of scope
(wall trim/split); 9 → Phase 4; 10 → Phase 6.3.

---

## 9. Gate summary

| Gate | Runnable check | Protects | State @ `63e7d6e` |
|---|---|---|---|
| 0 | `python scratch/test_solver_capability.py`; EQ over distinct endpoints | The solver exists and actually runs | ❌ script absent; EQ caller still degenerate |
| 1 | `python scratch/test_container_fidelity.py` + reference round-trip; delete-prunes test | Reference identity survives save/load; no dangling refs | ⚠️ suite passes (58) but the reference round-trip is absent and the delete-prunes half fails |
| 2 | extend `scratch/test_dimensions_crud.py` | Dimensions persist, measure, survive undo | ⚠️ passes (73) for persistence/undo; `resolve_dimension` absent |
| 3 | dimension-value round-trip; datum dimension; structured conflict | **The core claim**: a typed value drives geometry and comes back | ❌ unstarted |
| 4 | level/grid dimension drives the datum | Datums are witnesses, not a special case | ❌ unstarted |
| 5 | EQ span holds through an endpoint move; binding validator rejects lock+label | Segments and the binding slot | ❌ validator absent |
| 6 | `npm run check` (bus parity + UI invariants + `tsc --noEmit`) | The change is reachable and typed | ⚠️ green, but `DI` is still gated off so the feature is not reachable |
| 7 | over-constraint offers working resolutions | Spec §12 is actually satisfied | ❌ unstarted |

> Note the gate numbering is load-bearing but the *files* are not: Gate 2 originally named a new
> `scratch/test_dimensions.py`, which was never created — the dimension suite is
> `scratch/test_dimensions_crud.py`, and it is one of the six suites `check:py` actually runs.

Every gate is a **script**, following the repo's existing convention (`scratch/test_*.py`,
`scripts/check-*.mjs`), so it can be re-run and can fail.

**One rule to carry through all of it**, from the repo's own README:

> *"if a key parameter is constant across a corpus, the suite is blind on that dimension regardless of how
> many checks it has. It applies to probes as well as tests."* (`README.md:184-185`)

For this work the parameters that must **vary** in every gate fixture are: the reference *kind* pair
(end↔end, end↔datum, face↔datum), the *axis*, the *sign* of the value change (grow and shrink), and the
number of references (2 and ≥3). A suite that fixes any one of those is blind on it.

---

## 10. Provenance of the references in this plan — and a change of policy

Every `file:line` citation this plan originally carried has **drifted**. The geometric-references
refactor, the `revitUI` work and the UI-P0 work all landed after it was written, and each one moved
code that the plan points at — the solver wrapper, `delete_element`, `rebuild_from_overlay`,
`_overall_dimensions`, `_finish_plan_contract`, the snapshot/restore pair and the registry have all
shifted by tens to hundreds of lines. Even a one-line import change moves them (adding a single import
to `ifc_service.py` shifted `self.dimensions` from `:247` to `:248`).

**Policy from this revision on: anchors are symbols, not line numbers.** A citation names the file and
the *symbol* (`BimModelManager._finish_plan_contract`, `ConstraintSolver._apply_equalize`,
`DependencyGraph.recompute`), which survives unrelated edits. Where a line number was genuinely load
bearing it has been removed rather than refreshed, because refreshing it just resets the same trap.

This is the same failure the geometric-references plan named in its own §5.3 — *"its premise and line
references do not [hold]"* — recurring in the document that was amended to fix it. Hence the policy
change rather than another re-anchoring pass.

**What is verified as of `main` @ `63e7d6e`** (i.e. safe to act on):

- Symbols named in §0.1 and the phase tables: existence/absence checked directly.
- `OVERLAY_SCHEMA_VERSION = 3`; `planegcs` installed and importable in `.venv`.
- The Phase 0.1 caller, the Phase 1.4 dangling-constraint defect, and the silent missing-solver return:
  all three reproduced, with the method run recorded in
  [`AUDIT-dimension-as-control-status-2026-10-15.md`](AUDIT-dimension-as-control-status-2026-10-15.md).

**Still unverified, and treated as leads rather than facts:** exact `ELEMENT_PARAM_FIELDS` membership
semantics; the full `_finish_plan_contract` key list; the `Ribbon.tsx` gating line for `DI`; and the
`AUDIT-dimension-editing-vs-revit.md` / `AUDIT-engine-performance-vs-revit.md` citations this plan
quotes but did not re-derive.

**One correction to the audit already applied and re-confirmed here:** levels are absent from the *plan*
contract — `levels` reaches only the vertical-view branch of `_finish_plan_contract`. Phase 4.3 is
therefore new work, not a repair.

**One thing this plan could not verify and does not depend on:** the `planegcs` Python API surface
(Phase 0.2). If it lacks a primitive Phase 3 needs, the encoding changes — the phases and gates do not.
