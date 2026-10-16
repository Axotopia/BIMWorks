# AUDIT — `IMPLEMENTATION-PLAN-dimension-as-control.md`: is it done?

**Plan:** `review/IMPLEMENTATION-PLAN-dimension-as-control.md` (490 lines, Phases 0–8)
**Repo state:** `github.com/Axotopia/BIMWorks` @ `63e7d6e`, tree clean
**Date:** 2026-10-15

---

## 0. Answer

**No. The companion plan is largely unimplemented** — roughly **7 of ~40 tasks complete**, with about
10 partial and the rest absent.

This is easy to conflate, so to be explicit: **the geometric-references refactor is a different plan,
and *that* one is largely done.** Gemini's "91% conformance" audit graded
`IMPLEMENTATION-PLAN-geometric-references.md` and never assessed this document. The geometric plan
says so itself in §1:

> **Out of scope, deliberately:** … *The dimension object itself.* Owned by the companion plan. This
> plan supplies the primitive it consumes.

So the primitive is in place and the plan that *consumes* it is mostly not built. The Phase 5
amendment (commit `e4b9dd9`) updated this plan's **prose** — citations, §0 premise, §3.1 API — but not
its **tasks**.

Most consequential: **Phase 3 ("the dimension drives geometry", marked *the core phase*, L) is
essentially absent**, and two of the three Phase 0 prerequisites — one a live user-visible bug — are
still present.

---

## 1. Where the plan stands

| Phase | Plan size | State | Evidence |
|---|---|---|---|
| **0 — Unblock and verify** | S, *prerequisite for everything* | ❌ **0/3** | see §2 |
| **1 — Reference primitive** | M | ⚠️ **1.5/5** | 1.1 done; 1.2–1.5 not |
| **2 — Dimension object, persisted** | M | ⚠️ **2/5** | 2.1, 2.4 done |
| **3 — The dimension drives geometry** | L, *the core phase* | ❌ **~1/6** | see §3 |
| **4 — Datums as witnesses** | M | ❌ **0/4** | see §3 |
| **5 — Faces, EQ, binding** | L | ⚠️ **1/4** | 5.1 done (ordinal ignored) |
| **6 — Create and edit in the view** | L | ⚠️ **3/6** | 6.2, 6.5 done; 6.1 partial |
| **7 — Chains, reveal-constraints, audit trail** | M | ❌ **0/3** | see §4 |
| **8 — Deferred seams** | — | n/a | explicitly "do not schedule yet" |

### Worked examples

**Done:** `backend/references.py` (1.1); `self.dimensions` + `dimensions_rev` (2.1); snapshot/undo
carries dimensions (2.4); `wall_face_pos`/`wall_face_neg` at `thickness/2` (5.1); bus-parity mapping
for `createDimension`/`setDimensionValue`/`deleteDimension` (6.2); in-place dimension text edit (6.5).

**Absent — the required symbols simply do not exist:**

```
scratch/test_solver_capability.py          (0.2)  ABSENT
resolve_dimension()                        (2.5)  ABSENT
ConstraintSolver.solve_dimensions()        (3.1)  ABSENT
move_reference() on the manager            (3.2)  ABSENT
GET /api/constraints/conflict              (3.6)  ABSENT
referenceable_kinds()                      (4.1)  ABSENT
DimensionLockToggle verb                   (6.1)  ABSENT
```

---

## 2. Phase 0 — all three prerequisites still open

### 0.1 — the degenerate EQ caller is still in the tree *(live user-visible bug)*

`src/store/useBimStore.ts:1520` still passes the **same GUID for both span endpoints**:

```ts
await get().equalizeSpan(southWall, southWall, targets, 'x');
```

The plan's diagnosis stands: `pos_start == pos_end` ⇒ `total_span = 0` ⇒ `spacing = 0` ⇒ the targets
collapse to a point. The solver is fine; the caller is malformed. **Not fixed.**

### 0.2 — no solver-capability inventory

`scratch/test_solver_capability.py` does not exist. The plan called for printing which of
`add_point`, `add_fixed_point`, `set_p2p_distance`, `coincident`, `add_line`, `equal_length`,
`get_point`, `solve` the installed `planegcs` actually provides — flagged as unverified, with a
blocker risk for Phase 1's encoding. Still unverified. (`planegcs` **is** installed in `.venv`.)

### 0.3 — a missing solver is still silent, and quieter than the plan recorded

`backend/ifc_service.py:2983-2985`:

```python
except Exception as e:
    # Solver unavailable (e.g. planegcs not installed) or conflict: keep model intact
    return
```

The plan recorded this as a printed "Notice" (`ifc_service.py:2129-2130`). It is now a bare `return`
— so on a machine without `planegcs`, constraint propagation no-ops with **no output at all**. Gate 0
requires "a missing planegcs raises a surfaced error rather than printing and continuing". **Not
met**, and the current state is a regression against the plan's own baseline description.

> This interacts with the audits: every "constraint propagation works" claim is being measured in a
> workspace where the failure path is invisible.

---

## 3. The core phase is missing

**Phase 3** — the entire point of the plan, and the phase that makes a dimension *drive* geometry —
has only its partial pieces:

- **3.1 `ConstraintSolver.solve_dimensions(axis, dimension, pins)`** — absent. The plan wanted a node
  table keyed by `reference_key`. The solver still solves *elements* by coordinate, not references.
- **3.2 `move_reference(...)` on the manager** — absent. Note the naming trap: the frontend
  `store.moveReference` and the `ReferenceMove` **bus verb** exist, but the manager-level
  `move_reference` the plan specifies does not — and `store.moveReference` still has **zero callers**,
  so `ReferenceMove` is unreachable from the UI.
- **3.3 `DimensionValueSet` as the driver** — partial. `set_dimension_value` resizes a wall / translates
  an element, but through the delta path, not by moving the *reference*.
- **3.4 wire the `constraint` edge into `recompute()`** — **not done.** `dependency_graph.recompute`
  still walks the graph, counts `affected`, and then only ever calls `recompute_wall_joins`. This is
  the plan's own §3.7/§10.1-C observation, unchanged.
- **3.5 conflict path with `resolutions`** — partial. `last_constraint_conflict` is populated; there is
  no `resolutions` list, so nothing can offer "unlabel / unlock / release_eq".
- **3.6 `GET /api/constraints/conflict`** — absent.

**Phase 4 (datums as witnesses)** is 0/4: no `referenceable_kinds`, no `move_reference` for
`level_plane`/`grid_axis`, the grid datum-divergence defect unfixed, and `levels` reaches the contract
only for **vertical** views (`is_vert_view`, `ifc_service.py:6074` → `contract["levels"]` at `:6099`),
not the 2-D plan contract the plan asked for. So levels still are not drawn in plan views.

---

## 4. Also outstanding

- **1.2/1.3 — no per-element `refs` in the overlay.** `_build_overlay_element` writes no `refs` key, so
  there is nothing for `rebuild_from_overlay` to restore. The dual-write the plan wanted was never
  added.
- **1.4 — dangling constraints on delete (a defect the plan names).** Dimensions *are* pruned;
  **constraints are not.** Verified:

  ```
  align constraint: align_57716ebb | constraints: ['align_57716ebb']
  after deleting w1: constraints remaining: ['align_57716ebb']
  DANGLING constraints referencing deleted w1: ['align_57716ebb']   -> defect present
  ```

- **1.5** — `reference_key` appears **0 times** in `test_container_fidelity.py`; the required
  reference round-trip test was never added.
- **2.2** — the planned `add_dimension(refs, axis, offset)` that **takes no value** (§2 rule 4) does
  not exist; `create_dimension(ref_a, ref_b, …, value=None)` takes one.
- **2.3** — `OVERLAY_SCHEMA_VERSION` is still **3** (`ifc_service.py:52`); no v3→v4 reader.
- **5.2** — `binding` appears nowhere in the backend; no validator rejects `locked` + `label`.
- **6.1** — `DimensionLockToggle` absent (only `ConstraintLockToggle` exists).
- **6.3** — `DI` is still `implemented: false` (`src/interaction/toolCaptions.ts:43`); Ribbon un-gate,
  hotkey binding, and the deliberate `check-ui-p0` assertion update were not done.
- **6.4** — model-backed dimensions do now reach and render; the promised correction to the
  `_overall_dimensions` docstring (*"Dimension strings are a renderer's output, not model data"*) was
  **not** made — the phrase is still at `ifc_service.py` in that docstring.
- **6.6** — the temporary-dimension path was not retired: `witnessP1`/`witnessP2` still have 9
  references and `applyTemporaryDimensionChange` still exists.
- **7.1/7.2/7.3** — no dimension-chain gesture, no reveal-constraints mode, no resolution affordances.
  (`refs` chaining exists in the data model, so 7.1 is arguably partial.)

---

## 5. Where this intersects the reviews already filed

Three of the divergences I raised in the geometric-references reviews are, from this plan's
perspective, **unstarted tasks** rather than bugs:

| My finding | This plan's task |
|---|---|
| 2D `level_plane` returns `(0.0, elevation)` labelled `exact` | §3.3.1 / 4.2/4.3 — Phase 4 was to make datums axis-resolved witnesses |
| `wall_face_*` ignores `ordinal` | 5.1 — implemented, but ordinal was intended here |
| Diagonal `grid_axis` axis form substitutes the midpoint | 4.2 — the grid datum work was never done |

So they should be tracked as **outstanding companion-plan work**, not as lingering defects in the
geometric refactor. That distinction is what Gemini's audit obscured.

---

## 6. Recommendation

If the goal is to *finish dimension-as-control*, the order the plan itself specifies is still right,
and the first three items are small and unblock everything else:

1. **Phase 0.1** — fix the `equalizeSpan(southWall, southWall, …)` caller (one line, live bug).
2. **Phase 0.3** — make a missing solver raise instead of silently returning; the current bare
   `return` is worse than the "Notice" the plan documented.
3. **Phase 0.2** — land `test_solver_capability.py` and pin `planegcs`, so later phases measure
   something real.
4. **Phase 1.4** — prune constraints (not just dimensions) when an element is deleted; the dangling
   `align_*` is reproducible today and will corrupt solver scope once Phase 3 lands.
5. Then **Phase 3.1/3.2** — the reference-keyed `solve_dimensions` and manager `move_reference` — since
   every later phase (4, 5, 6.3) depends on them.

Also worth correcting in the plan itself: it still describes `ifc_service.py:2129-2130` printing a
"Notice" for a missing solver, and its Phase 2/6 line citations predate the geometric refactor. The
§7.1 re-anchoring obligation from the geometric plan has not been re-run against the current tree.
