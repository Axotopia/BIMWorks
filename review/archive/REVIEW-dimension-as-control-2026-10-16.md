# REVIEW — Gemini's refactor of `IMPLEMENTATION-PLAN-dimension-as-control`

**Reviewed commit:** `a276c97` — *"feat(dimension-control): implement dimensions as geometric controls and
structured conflict reporting"*
**Parent:** `0b95038` (docs(plan): refresh dimension-as-control with measured state and symbol anchors)
**Checkout:** `/home/song/Documents/DSH/axoworks/BIMWorks`, `main`, tree clean
**Plan under review:** `review/archive/IMPLEMENTATION-PLAN-dimension-as-control.md` (592 lines, state refreshed
against `main` @ `63e7d6e`)
**Date:** 2026-10-16
**Method:** Independently re-ran every gate Gemini cited; read the full diff; then wrote six throwaway probes
(`/tmp/probe_*.py`, reproduced in Appendix A) to exercise the paths the shipped suite does not cover.

---

## 1. Verdict

The refactor is **substantially real and contains genuine engineering** — the core Phase 3 mechanism works,
Phase 0 is properly closed, Phase 1 is well built, and the grid/IFC sync defect is genuinely fixed. Every
verification claim Gemini made **reproduces exactly**.

But it is **not merge-ready as a completion**, and the headline claims overstate coverage in four specific,
demonstrable ways:

| # | The claim | The reality |
|---|---|---|
| 1 | "Phase 3 … implemented and verified" | Gate 3's flagship round-trip (`wall_start↔wall_end` → 12.0 ft) calls `move_reference` **zero times** — it passes through the pre-existing `_resize_wall_length`. The new architecture is only exercised by Case 2. |
| 2 | "Phase 6.1 (`DimensionLockToggle`) … implemented and verified" | The verb is registered but the toggle is **functionally inert**: it flips a flag the enforcing constraint never reads. It is also unreachable from any UI component — only tests call it. |
| 3 | "Phase 4 datums/referenceable kinds … implemented" | `referenceable_kinds` and `move_reference` are implemented, but a `wall_start↔level_plane` dimension **measures 0.0 and cannot round-trip** — the underlying 2-D level defect the plan assigned to Phase 4 is untouched. |
| 4 | "Phase 2" (in the commit message) | `OVERLAY_SCHEMA_VERSION` is still **3** while the record now carries `refs`. Gemini's own discovery plan promised *"Overlay schema bump to v4 with v3 backward compatibility"*. |

Four defects are reproducible with hard evidence (§3, H1–H4). All four are in code this commit introduced.

---

## 2. Verification performed

Every run below was executed by me on the pulled commit, not taken from Gemini's report.

| Run | Result |
|---|---|
| `npm run check` | **exit 0** — all 6 gates (bus parity, UI-P0 130 checks, state bundle, delta equivalence, snap engine, python suites, `tsc --noEmit`) |
| `.venv/bin/python scratch/test_dimensions_crud.py` | **100 passed, 0 failed** |
| `.venv/bin/python scratch/test_solver_capability.py` | **17 passed, 0 failed** |
| `.venv/bin/python scratch/test_container_fidelity.py` | **66 passed, 0 failed** (58 before; +8 from this commit) |
| `.venv/bin/python scratch/test_references.py` | **32 passed, 0 failed** |
| `npm run check:bus` / `check:ui` | passed (38 `dispatchTransaction` sites; UI-P0 130 checks) |

**Gemini's four cited commands and its "100 checks / all 6 gates" claim are all accurate.** No gate was
weakened to accommodate this change (verified: `scripts/check-ui-p0.mjs` is untouched and still asserts
`DI` is unimplemented at `:193-196`).

Environment note: the plan's §5 premise that `planegcs` is unavailable is stale — `.venv` exists and
`planegcs` imports cleanly (verified: `SolveStatus.Success` → `'Success'`, `Failed` → `'Failed'`).

---

## 3. Defects introduced by this commit

### H1 — HIGH — Same-element reference pairs that are *not* length dimensions are misrouted to `_resize_wall_length`, so the dimension does not round-trip

`backend/ifc_service.py:4029`:

```python
if guid_a and (guid_a == guid_b or not guid_b):
    # Single-wall dimension
```

`guid_a == guid_b` is used as the proxy for "this is a `wall_start↔wall_end` length dimension". It is
actually true for **any** two references on the same element — which is precisely the case
`referenceable_kinds` advertises, since `backend/references.py:497` publishes
`wall_center`, `wall_face_pos` and `wall_face_neg` for walls alongside `wall_start`/`wall_end`, and
`add_dimension` accepts them without complaint.

The branch calls the **pre-existing** `_resize_wall_length` (it is not in this commit's diff), so the wall's
*length* is forced to the typed value regardless of which reference pair the dimension was built on.

Probe evidence (`probe_dim_review.py`, PROBE 1–2):

```
start<->center dimension:  created 5.0000 ft, set to 3.0 -> resolved 1.5000 ft  (wall length forced to 3.0)
start<->face_pos dimension: created 5.0062 ft, set to 12.0 -> resolved 6.0052 ft (face never targeted)
```

The user types 12'-0" into a dimension and the dimension then displays 6'-0½". That is the plan's R1
("silent wrong geometry") realised, and it breaks the §2 Rule 4 / Gate 3 round-trip property.

**Fix direction:** branch on the reference *kinds* (`wall_start`∧`wall_end` on one element), not on GUID
equality. Everything else should go through `solve_dimensions` + `move_reference`.

---

### H2 — HIGH — `DimensionLockToggle` does not release the enforcing constraint: the lock is split-brained

There are now **two independent representations of "locked"**, and they disagree:

| Representation | Written by | Read by |
|---|---|---|
| `dim["is_locked"]` / `segments[].locked` | `DimensionLockToggle` (`command_bus.py:853-867`), `create_dimension` | only the **new** `solve_dimensions` (`constraint_solver.py:611`) |
| `self.constraints[cid]` (`type: "dimension_lock"`, `locked_distance`) | `create_dimension(is_locked=True)` → `add_dimension_lock` (`ifc_service.py:3638`) | the **legacy** solver (`constraint_solver.py:122, 200, 256, 364`) and `dependency_graph.py:73` |

`DimensionLockToggle` touches only the first. Probe evidence (`probe_dim_review.py`, PROBE 3):

```
after DimensionLockToggle(is_locked=False):
    dim['is_locked'] = False        <- what the toggle changed
    constraints[cid]['is_locked'] = True, locked_distance = 20.0   <- still enforced
```

So **unlocking does not unlock**. Symmetrically, toggling lock *on* for a dimension that has no
`constraint_id` creates no constraint at all, so locking does nothing either. Meanwhile the existing padlock
affordance in `src/components/drafting/PlanViewport2D.tsx:1314-1323` drives `toggleConstraintLock` /
`lockDimension`, not this verb — the UI audit (§5) confirms `toggleDimensionLock` has **no component caller
anywhere**.

Plan 6.1 registered the verb; its purpose (§5.2/§5.4: one binding slot, `dimension_lock` migrated) is not met.
The shipped test (`test_dimensions_crud.py` §19e) asserts only the boolean round-trip, so it passes.

**Fix direction:** make the toggle authoritative on `self.constraints[cid]` (create/patch/delete the
`dimension_lock` row), or stop creating the row in `create_dimension` and let `solve_dimensions` be the single
enforcement path. Pick one; two is the bug.

---

### H3 — HIGH — An element ↔ `level_plane` dimension cannot measure or round-trip; the value is reinterpreted as an absolute elevation

Probe evidence (`probe_dim_review2.py`, PROBE 7):

```
wall start=[0,0,0], level elevation=0.0
dimension created: axis=x, ref_b kind=level_plane, value=0.0
resolve_dimension = 0.0
resolve_reference_axis(level, 'x') -> (None, 'ambiguous')
set_dimension_value(25.0) -> updated
level elevation now = 25.0     (wall start x = 0.0)
resolve_dimension now = 0.0    <- still 0.0, immediately after being set to 25.0
```

Three things are wrong at once:
1. `create_dimension` derives `value = 0.0`, because `resolve_reference` maps a level to `(0.0, elevation)`
   and an x-axis dimension then computes `|0.0 − 0.0|`. The dimension can never measure anything.
2. `set_dimension_value` sets the level's **absolute elevation** (`target_elev = val_float`,
   `ifc_service.py:4019`) rather than the distance from the element — and `move_level` propagates to member
   elements, so a plan dimension silently drags geometry vertically.
3. `dim["value"]` is recorded as 25.0 while `resolve_dimension` returns 0.0 — the plan's R4 ("two sources of
   truth for a length") violated, with no invariant check (R4's mitigation says "add an invariant check to
   Gate 3"; none was added).

The plan is explicit that this is Phase 4's work — §0.1.3: *"2-D `level_plane` returning `(0.0, elevation)`
labelled `"exact"` is Phase 4's datum work"*. Phase 4.1/4.2 were claimed; this was left untouched, so Gate 4's
"*a dimension from wall_start to level_plane drives the level*" is not met in any coherent sense.

By contrast the **grid** half of 4.2 is genuinely done and works (see §4).

---

### H4 — MEDIUM/HIGH — `set_dimension_value` records a value as applied when the solve *failed*, moving nothing

`backend/ifc_service.py:4124-4139`:

```python
if solve_res.status == "success":
    ... move_reference(...) ...
dim["value"] = val_float                                    # <- runs on failure too
if "segments" in dim and len(dim["segments"]) > segment_index:
    dim["segments"][segment_index]["value"] = val_float
cid = dim.get("constraint_id")
if cid and cid in self.constraints:
    self.constraints[cid]["locked_distance"] = val_float
...
return {"status": "updated", "dimension_id": dimension_id, "value": val_float}
```

`solve_dimensions` returns `status="failed"` (not `"conflict"`) in three reachable ways:
`insufficient_refs` (`constraint_solver.py:567`), `unresolved_coords` (`:580`), and any solver exception
(`:654`). Only `"conflict"` is handled. On `"failed"` the function falls through, **stores the requested value
as though it had been applied, and reports success** while the geometry is untouched — the opposite of the
plan's §3.5 "Never half-apply" discipline and exactly risk R1.

Probe evidence (`probe_dim_review2.py`, PROBE 8) — a 3-reference dimension whose middle reference is a
`level_plane` cannot place that node on the x axis:

```
segments = [0.0, 10.0]
set_dimension_value(7.0) -> status='updated'
wall start before=[0,0,0] after=[0,0,7.0]
dim['value'] recorded as = 7.0
resolve_dimension now = 0.0       <- stored 7.0, measured 0.0
```

Related, same block: at `:4130-4132`, when the solved coordinate for `move_ref` is missing, the code loops
over **every** coordinate and calls `move_reference(move_ref, …)` repeatedly with the same reference, so the
final position depends on dict iteration order.

**Fix direction:** treat anything that is not `"success"` as a refusal — do not write `value`, `segments` or
`locked_distance`, and return a structured status the caller can surface.

---

## 4. What is genuinely correct (credit where due)

These were verified working, not taken on trust:

- **Phase 0.1 — the degenerate EQ caller is fixed.** `src/store/useBimStore.ts:1589` now passes distinct
  `startGuid`/`endGuid`; the `equalizeSpan(southWall, southWall, …)` defect is gone.
- **Phase 0.3 — the missing solver is now loud.** `SolverUnavailable` is re-raised at both sites
  (`ifc_service.py:2994-2999` and `:3039-3041`). This was the plan's "⚠️ regressed / silent" item and it is
  properly closed.
- **Phase 0.2 — `scratch/test_solver_capability.py` is stronger than the plan asked for.** It asserts the
  primitive inventory *and* behaviourally verifies p2p distance solving to 12.0, `equal_length` spacing,
  `SolverUnavailable` being raised, and EQ holding across an endpoint move — 17/17. It is registered in
  `scripts/check-python-suites.mjs`, so Gate 0 now actually runs.
- **Phase 1.2/1.3 — reference dual-write and restore are well built.** `_build_overlay_element` writes `refs`
  with hints (`:1818-1832`); `_rebuild_element_from_overlay` validates kinds against `ReferenceKind` and
  reports a counted notice for drops (`:5021-5033`). I confirmed reference keys survive save/load **exactly**
  (`probe_rt3.py`: `REFERENCE KEYS PRESERVED: True`).
- **Phase 1.4 — constraint pruning on delete works.** `ifc_service.py:2751-2767` prunes constraints by
  `ref_guid`/`target_guid`/`guid_a`/`guid_b`/`span_start_guid`/`span_end_guid`/`interior_guids`. My probe
  confirms constraints are emptied on delete; `test_container_fidelity.py` now proves it (66 checks, +8).
- **Phase 1.5 — the Gate 1 round-trip test is genuinely good**, including the `references.py` has-no-import-of
  `ifc_service` structural check the plan asked for.
- **Phase 2.5 — `resolve_dimension` measures live geometry**, correctly returning `None` for lost witnesses
  rather than anchoring to `(0,0)`.
- **Phase 3.3 — the multi-element path genuinely replaced the delta translation.** The parent commit computed
  `dx/dy` and called `translate_element`; this commit calls `solve_dimensions` then
  `move_reference(move_ref, solve_axis, target_coord)`. **Verified round-tripping, including the cases the
  suite omits** — GROW 20→30.0, SHRINK 30→15.0, and `axis="y"` → 4.0 all exact (`probe_dim_review.py`,
  PROBE 5–6). This is the real Phase 3 deliverable and it works.
- **Phase 3.6 — the endpoint and response field exist** (`main.py:713-716`, `:79-83`, `:869-873`), and the
  over-constraint path is sound: planegcs returns `SolveStatus.Failed` (not an exception), so
  `solve_dimensions` correctly classifies it as a conflict and **zero geometry changes** (verified in the
  suite and by reading the early return at `:4117-4122`, which precedes the value write).
- **Phase 4.2 (grid half) — the IFC drift defect is genuinely fixed.** A dimension between two grids drove
  grid B from x=10.0 → 25.0, `resolve_dimension` returned 25.0, **and** `model.ifc`'s `AxisCurve` followed to
  7.62 m (`probe_grid.py`). The `UAxes[0].AxisCurve` update was added to both `move_reference` and
  `translate_element`.
- **Phase 6.1 — registration is correct.** `DimensionLockToggleParams` matches the TS payload
  (`{dimension_id, is_locked}`), the memento provides working undo/redo, and the store verb
  `toggleDimensionLock` (`useBimStore.ts:1472-1483`) follows the same dispatch/catch/`statusMessage` shape as
  its three dimension siblings. The defect is its *semantics* (H2) and its *reachability* (§5 F1), not its
  plumbing.
- **Phase 6.3 was correctly left undone, and no gate was weakened.** `toolCaptions.ts:43` still has
  `implemented: false`, `Ribbon.tsx:761` still `notYet('DI')`, and `check-ui-p0.mjs` was not modified.

---

## 5. UI / reachability audit (independent)

- **F1 — HIGH — `toggleDimensionLock` is dead code.** Repo-wide grep finds exactly four sites in `src/`, all
  inside its own definition; no component references it. `UI_ACTION_COMMANDS` has no generic consumer. The
  only real caller is the Python suite. Gate 6's stated protection — "*the change is reachable*" — is unmet.
- **F2 — MEDIUM — the bus-parity gate passes it on a text match only.** `check-bus-parity.mjs:95-99` requires
  only the literal `dispatchTransaction('<action>'` to appear anywhere in the file (comments included); it
  never inspects params, callers, or the backend registry. Proof of the hole: `moveReference` (`:109`) has
  zero callers and the gate is green. (Pre-existing gate weakness, now load-bearing for this feature.)
- **F3 — MEDIUM — the existing padlock cannot unlock.** Because H2 leaves `dimConstraint` undefined, the
  `PlanViewport2D.tsx:1314-1323` click re-enters `lockDimension(...)` and unlock is unreachable by click.
- **F4 — MEDIUM — the structured `conflict` payload is inert in the UI.** `grep -rn conflict src/` → **no
  output**. `executeTransaction` returns `data` but no caller reads `.conflict`. The commit's "structured
  conflict reporting" claim has no user-facing half.
- **F5 — MEDIUM — the plan's own item 6.6 rationale is factually wrong** (not Gemini's error, but it misled
  this work): the plan says `witnessP1`/`witnessP2` are "*written and never read today*". They **are** read —
  `PlanViewport2D.tsx:1380-1383` renders witness lines and text from them. Retirement is a live-path deletion,
  not dead-code removal, so its estimate is unsound.
- **F6 — LOW — the rewritten EQ fallback can silently do nothing** (`useBimStore.ts:1584-1586`): no dispatch,
  no `statusMessage`, no error.

---

## 6. Plan-conformance gaps not covered by the section above

- **M1 — MEDIUM — the conflict report is never cleared, so successful mutations report a stale conflict.**
  `last_constraint_conflict` is set at `constraint_solver.py:675` and `ifc_service.py:3034` and read at
  `main.py:83/716/873`, but **never reset to `None`**. Probe (`probe_dim_review.py`, PROBE 4): after a
  contradictory set, a subsequent *valid* set returns `status="updated"` while `last_constraint_conflict`
  remains populated — so `GET /api/constraints/conflict` and every later `Dimension*`/`Constraint*` mutation
  response keep reporting the old conflict. §3.5 wants the conflict to be a result *of the operation*.
- **M2 — MEDIUM — two incompatible conflict shapes reach the same field.** `solve_dimensions` writes the
  plan's required `{status, axis, constraints, dimensions, resolutions}` (`constraint_solver.py:667-673`), but
  the legacy `_solve_constraints_after_move` writes `{axis, constraints, triggered_by}`
  (`ifc_service.py:3034-3038`) — **no `status`, no `dimensions`, no `resolutions`**. Whichever ran last wins,
  so the endpoint can return a payload that violates the §3.5 contract. Additionally the resolutions are
  emitted unconditionally: `unlabel` and `release_eq` are offered for the driving dimension even when it has
  no label and no `binding == "equal"` (`constraint_solver.py:668-670`), so Phase 7.3 would wire buttons that
  cannot apply.
- **M3 — MEDIUM — `add_dimension` (and with it `binding`/`label`/`eq_anchor`) is unreachable in production.**
  `add_dimension` has **zero non-test callers**. `DimensionCreateParams` has no `binding`/`label`/`eq_anchor`
  fields and the bus calls `create_dimension`, which performs no validation. `eq_anchor` is written
  (`ifc_service.py:3725`) and **never read anywhere**; `binding` is read only by `solve_dimensions`
  (`constraint_solver.py:643`). So plan 2.2 ("takes no value"), 5.2 (validator "in one place") and 5.3
  (`eq_anchor`) are satisfied only inside a dead API, while the live path still accepts `value=` on creation
  and would accept lock+label silently. This is the *same* anti-pattern the plan already flagged for
  `store.moveReference` ("zero callers") — a second instance.
- **M4 — MEDIUM — Gate 3's flagship assertion does not exercise the new architecture.** Proven by
  instrumentation (`probe_path.py`):

  ```
  Case 1 (wall_start<->wall_end -> 12.0):  solve_dimensions called: 1   move_reference called: 0
  Case 2 (two different walls -> 25.0):    solve_dimensions called: 1   move_reference called: 1
  ```

  Case 1's geometry change comes from the pre-existing `_resize_wall_length` (called at `:4071`, right after
  the conflict check); `solve_res.coordinates` is computed and then **discarded**. So the test the plan
  designates as "the core claim — *not* a delta-measured approximation" passes on a code path that predates
  the commit.
- **M5 — MEDIUM — the overlay schema version was not bumped, so the version no longer describes the payload.**
  `OVERLAY_SCHEMA_VERSION = 3` (`ifc_service.py:52`) is unchanged while `_build_overlay_element` now writes
  `refs`. Verified: the saved `parametric.json` reports `schema_version: 3` and contains
  `refs: ['wall_start', 'wall_end']`. Gemini's own discovery plan promised *"Overlay schema bump to v4 with v3
  backward compatibility"* and *"schema v4 writes refs and dimensions"*; plan R3 requires a v3→v4 reader, and
  none exists. Any consumer that trusts the version to decide whether `refs` are present is now wrong.
- **M6 — MEDIUM — the Phase 3.4 graph hook is a *measurement refresh*, not a re-solve, and adds walk cost with
  no counter.** `dependency_graph.py:213-217` calls `manager._re_resolve_dimensions_after_move(node)` for
  **every** affected node whenever `"constraint" in kinds or not kinds` — i.e. on every full recompute. That
  method (`ifc_service.py:3076`) only recomputes dimension *values*; it does not re-assert a driving dimension,
  so the plan's 3.4 ("re-resolve the *asserting* dimensions", §10.1-C) is not implemented despite the
  `Phase 3.4` comment. It also overwrites `d["value"]` with the measured value (`:3118-3132`) — so a driving
  dimension's stored target is silently replaced by whatever the geometry now measures — and stamps
  `status="repaired"` even when both references resolved `exact`. The plan's R2 mitigation ("Measure in Gate 3
  before landing 3.4 … prove it with a counter") was not done.
- **L1 — LOW — `segments[i]` is dereferenced without a null check** (`constraint_solver.py:589-591`, `:634-636`;
  `ifc_service.py:4022-4023`) although the plan's §2 model permits `null` entries. Only reachable via a
  hand-written overlay, but it is a crash rather than a refusal.
- **L2 — LOW — non-positive segment targets are silently dropped** (`if target_dist > 0`,
  `constraint_solver.py:592`, `:638`) instead of being reported.
- **L3 — LOW — no `/health` solver-availability field** (plan §5 "Recommended"). The loud-raise half of 0.3 is
  done; the observability half is not.

---

## 7. Test-suite blindness (the plan's own §9 rule)

The plan ends with a load-bearing rule quoted from the README: *"if a key parameter is constant across a
corpus, the suite is blind on that dimension regardless of how many checks it has."* It names four parameters
that must vary in every Gate fixture. Applied to `scratch/test_dimensions_crud.py` §19:

| Must vary | Covered by §19? | Evidence |
|---|---|---|
| Reference **kind pair** (end↔end, end↔datum, face↔datum) | **PARTIAL** | end↔end (§19b), start↔grid_axis (§19c), start↔end across two walls (§19d). **No face↔datum case.** |
| **Axis** | **NO** | every fixture is `axis="x"`. |
| **Sign** of the value change (grow *and* shrink) | **NO** | only growth (10→12, and the contradictory 30). |
| **Number of references** (2 and ≥3) | **PARTIAL** | §19 is 2-ref throughout; ≥3 appears only earlier (§15–16 validator tests, not the Gate 3 fixtures). |

I filled the two gaps myself and the *code* passed both (shrink 30→15.0; `axis="y"` → 4.0). So this is a
**test-quality gap, not a code defect** — but it means Gate 3 as shipped cannot detect a regression on the y
axis or on shrink, and the plan's blindness rule is violated within the very fixtures added to satisfy it.

Also worth noting: the over-constraint test (§19d) **is genuine** — it imposes two contradictory
`set_p2p_distance` constraints (30.0 from the driving dimension, 20.0 from the overlapping locked dimension)
on the same node pair, planegcs returns `Failed`, and the test asserts zero geometry change for both
endpoints. It is not self-fulfilling. Its one weakness is that it exercises only the *new* conflict shape
(§6 M2) and it never touches `GET /api/constraints/conflict` or the mutation-response `conflict` field, so
Phase 3.6's wiring is untested.

---

## 8. Pre-existing issues discovered (NOT attributable to this commit)

Reported because the plan's Phase 1.4 work sits on the same code path, and a reviewer should know the gate
cannot cover it.

- **`delete_element` segfaults on a container-loaded model that has a constraint.** Reproduced deterministically:
  load a saved project → `delete_element(guid)` → `Fatal Python error: Segmentation fault`, exit 139, process
  dies. `faulthandler` localises it to
  `ifcopenshell/api/geometry/remove_representation.py:49` ← `root/remove_product.py:89` ←
  `backend/ifc_service.py:2814`. **Reproduced identically at the parent commit `0b95038`**, so it is not
  introduced here. Because it kills the process rather than raising, no Python-level test can catch it; the
  new Gate 1 delete-prunes test correctly runs on a *fresh* manager and therefore sidesteps it.
- The pre-existing `_re_resolve_dimensions_after_move` value/status overwrite behaviour described in M6.
- The shallow `check-bus-parity.mjs` literal check described in F2.
- Plan item 6.6's incorrect `witnessP1`/`witnessP2` rationale described in F5.

---

## 9. Required before this can be called "Phase 3/4/6.1 complete"

1. **H1** — branch the single-wall path on reference *kinds*, not `guid_a == guid_b`; add a
   `wall_start↔wall_center` and a `wall_start↔wall_face_pos` round-trip test (they currently fail).
2. **H2** — make the lock authoritative on one representation. Add a test that unlocks a
   `create_dimension(is_locked=True)` dimension and asserts the constraint no longer moves geometry.
3. **H4** — treat any non-`"success"` solve result as a refusal: do not persist `value`/`segments`/
   `locked_distance`, and return a status the caller surfaces.
4. **H3 / M5** — decide explicitly: either implement the Phase 4 2-D `level_plane` resolution (so a datum
   dimension can measure) and bump `OVERLAY_SCHEMA_VERSION` with a v3→v4 reader, or record both as
   deliberately deferred. Silence here is what produced both defects.
5. **M1/M2** — clear `last_constraint_conflict` on success, unify the two conflict shapes on the §3.5
   contract, and only emit `unlabel`/`release_eq` resolutions that can actually apply. Test both via the HTTP
   endpoint, not just the manager.
6. **M3** — route the bus `DimensionCreate` through `add_dimension` (or add the validator to
   `create_dimension`), otherwise 5.2/5.3/2.2 remain test-only.
7. **M4** — point Gate 3 Case 1 at the reference-driven path (or assert `move_reference` is invoked), so the
   flagship test actually guards the architecture it claims to.
8. **M6** — either implement 3.4 as a re-solve and add the R2 counter, or remove the `Phase 3.4` comment so
   the hook is not mistaken for it.
9. **F1/F3** — wire `toggleDimensionLock` to the padlock in `PlanViewport2D.tsx` and give
   `check-bus-parity.mjs` enough teeth to notice a verb with no caller; otherwise Phase 6.1 ships a verb no
   user can reach.
10. Add the missing §9 variations — **axis `y`** and a **shrink** — to the Gate 3 fixtures.

---

## Appendix A — Probe scripts

All probes are throwaway and live in `/tmp`; the repository was left clean (`git status --porcelain` empty,
review worktree removed). Each bootstraps like the repo's own suites (`sys.path.insert(0, "backend")`) and
must be run from the repo root with `.venv/bin/python -u`.

| Probe | Purpose | Result |
|---|---|---|
| `/tmp/probe_dim_review.py` | PROBE 1–2 same-element non-length pairs; PROBE 3 lock toggle; PROBE 4 stale conflict; PROBE 5 grow+shrink; PROBE 6 `axis="y"` | **4 passed, 4 failed** — failures are H1, H2, M1 |
| `/tmp/probe_dim_review2.py` | PROBE 7 element↔level datum; PROBE 8 silent `failed` solve | H3, H4 |
| `/tmp/probe_path.py` | instruments `solve_dimensions` / `move_reference` / `solve` to attribute Gate 3 Cases 1 and 2 | M4 |
| `/tmp/probe_grid.py` | Gate 4 grid-spacing shape + `model.ifc` `AxisCurve` sync | passed — grid half of 4.2 works |
| `/tmp/probe_rt3.py` | Gate 1 reference round-trip + schema version + delete pruning | round-trip and pruning pass; `schema_version: 3`; segfault (pre-existing) |
| `/tmp/probe_delete.py`, `/tmp/probe_delete_loaded.py` | isolate the `delete_element` segfault, at HEAD and at `HEAD~1` | pre-existing at both |

## Appendix B — Claim-by-claim

| Gemini's claim | Verdict |
|---|---|
| `ConstraintSolver.solve_dimensions` solving 1-D positions on `planegcs.Sketch` with `reference_key`-keyed nodes | **TRUE** — `constraint_solver.py:549`, node table keyed by `reference_key` |
| Overlapping locked dimensions incorporated into the solve graph | **TRUE** — `:601-639`, verified by the over-constraint test |
| Over-constrained returns structured conflict with resolutions and **zero** geometry changes | **TRUE for the new path** — but the shape is inconsistent with the legacy path and never cleared (M1, M2) |
| `referenceable_kinds` + `move_reference` publishing/moving the listed kinds | **TRUE** (`references.py:497`, `ifc_service.py:3777`) — but a level dimension cannot measure (H3) |
| `IfcGrid` translation defect fixed so `model.ifc` stays in sync | **TRUE and verified** — `AxisCurve` followed 10→25 ft (7.62 m) |
| `set_dimension_value` drives references via `solve_dimensions` + `move_reference`, replacing deltas | **TRUE for the multi-element path**; the single-wall path still uses `_resize_wall_length` and discards the solve (M4), and failure is misreported as success (H4) |
| `GET /api/constraints/conflict` + `conflict` on mutation responses | **TRUE** (`main.py:713`, `:79`, `:869`) — untested, stale, two shapes |
| `DimensionLockToggle` registered with undo/redo and full bus parity | **REGISTERED, but the toggle is inert and unreachable** (H2, F1) |
| Section 19 covers the three Gate 3 cases and `DimensionLockToggle` undo/redo | **TRUE** — all 100 checks pass; over-constraint case is genuine |
| All 100 checks and all 6 `npm run check` gates pass | **TRUE — reproduced exactly** |
| Commit message: "Implement Phase 0 / 1 / 2" | **0.1, 0.2, 0.3, 1.2, 1.3, 1.4, 1.5, 2.5 true; 2.2 deviant and unreachable; 2.3 (schema v4) NOT done** |
