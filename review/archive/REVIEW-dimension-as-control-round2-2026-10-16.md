# REVIEW (Round 2) — Gemini's remediation of the dimension-as-control findings

**Reviewed commit:** `26cfed1` — *"fix(dimensions): remediate REVIEW-dimension-as-control findings"*
**Parent:** `c699e10` (merge); remediation for my round-1 review of `a276c97`
**Round 1 review:** `review/archive/REVIEW-dimension-as-control-2026-10-16.md`
**Checkout:** `/home/song/Documents/DSH/axoworks/BIMWorks`, `main`, tree clean
**Date:** 2026-10-16
**Method:** Re-ran every gate; re-ran all round-1 probes; then built new probes for the parts round 1
did not cover — a 10×3×3 kind-pair × axis × wall-orientation round-trip matrix, a lock-enforcement probe,
and a lock → undo → redo probe. The round-1 commit was checked out in a temporary worktree to separate
**regressions** from **residual** failures.

---

## 0. Verdict

**This is a real and substantial remediation.** The four High defects from round 1 are closed or largely
closed, and eight other items are properly fixed. Nothing was faked, no gate was weakened, and the test
suite grew from 100 to 123 checks.

Three things stop it being a clean close:

1. **The H1 fix is a large improvement but ~40% of the reference-kind space still does not round-trip**, and
   every one of those 31 failing combinations silently reports `status="updated"` — 27 of them while
   corrupting the wall's length. Round 1's `face_pos↔face_neg` case was a *safe* `conflict` refusal; it is
   now a silent 10 ft → 0.3 ft collapse. **That is a regression**, narrow (2 combinations) but destructive.
2. **The H2 fix introduced a new bug in `redo`.** `DimensionLockToggle` → `undo` → `redo` no longer
   re-creates the constraint it deleted, reintroducing the exact split-brain state H2 was meant to remove.
   The round-1 test (`§19e`) is precisely this scenario and passes because it asserts only the boolean.
3. **The lock still does not hold the value it was locked at.** The plumbing is now synchronised, but
   `dimension_lock` constrains element *origins* while a dimension measures arbitrary *references*, so a
   locked dimension drifts — measured 20.0 → 30.0 after a drag while the constraint stayed "satisfied".

---

## 1. Verification performed

| Run | Round 1 (`a276c97`) | **Round 2 (`26cfed1`)** |
|---|---|---|
| `npm run check` | exit 0 | **exit 0** (all 6 gates) |
| `scratch/test_dimensions_crud.py` | 100 passed | **123 passed, 0 failed** |
| `scratch/test_container_fidelity.py` | 66 passed | **68 passed, 0 failed** |
| `scratch/test_solver_capability.py` | 17 passed | **17 passed** |
| `scratch/test_references.py` | 32 passed | **32 passed** |

Round-1 probes re-run against the remediation: `probe_dim_review.py` went **4 failed → 0 failed**;
`probe_path.py` now shows Gate 3 Case 1 calling `move_reference` once (was **zero**).

---

## 2. Round-1 findings — status

| # | Finding | Claimed | Verified |
|---|---|---|---|
| H1 | same-element non-length pairs misrouted to `_resize_wall_length` | fixed | ⚠️ **partial** — 42 combinations fixed, **31 still broken** (§4) |
| H2 | `DimensionLockToggle` split-brain lock | fixed | ⚠️ **partial** — cross-element sync works; same-element lock creates no constraint; **`redo` is broken** (§3.1) |
| H3 | element ↔ `level_plane` cannot measure/round-trip | fixed | ⚠️ **partial** — z-measurement and relative target added, but walls resolve z to `0.0` so the target is still absolute (§4.2) |
| H4 | value recorded when the solve failed | fixed | ✅ **verified** — forced-failure returns `status="failed"`, writes neither `value` nor geometry |
| M1 | conflict report never cleared | fixed | ✅ **verified** — `None` after a successful set |
| M2 | two incompatible conflict shapes | fixed | ⚠️ **partial** — top-level keys unified; `resolutions` element schema still differs (§4.3) |
| M3 | `binding`/`label`/`eq_anchor` unreachable | fixed | ⚠️ **mostly** — reachable through the bus now; vocabulary deviates from the plan and the label rule is missing (§4.4) |
| M4 | Gate 3 flagship didn't exercise the new path | fixed | ✅ **verified** — `move_reference` called once; `solve_dimensions` still called |
| M5 | overlay schema version not bumped | fixed | ✅ **verified** — writes 4; v3-with-refs and v3-without-refs both load authoritatively |
| M6 | measurement refresh overwrote locked targets / mislabelled `repaired` | fixed | ✅ **verified** — locked target held at 20.0 while an unlocked dim tracked 25.0; status now `exact` |
| L1 | `segments[i]` null dereference | fixed | ✅ verified (guards plus `isinstance`) |
| L2 | non-positive distance silently dropped | fixed | ✅ verified — now returns `status="failed"` |
| L3 | no `/health` solver availability | fixed | ⚠️ **partial** — a duplicate `/health` route shadows the new handler (§3.2) |
| F1 | `toggleDimensionLock` had no UI caller | fixed | ✅ verified — `PlanViewport2D.tsx:1318` calls it |
| F3 | padlock could not unlock | fixed | ✅ verified — the padlock now prefers `toggleDimensionLock(dim.id, …)` |
| F4 | `conflict` payload inert in the UI | fixed | ✅ verified — `useBimStore.ts:2732` surfaces it as a `statusMessage` |
| F6 | EQ fallback silently did nothing | fixed | ✅ verified — now sets a `statusMessage` |
| §9 | fixtures blind on axis and sign | fixed | ⚠️ **partial** — axis `y` and shrink are now tested, but see §4.1 |

---

## 3. New defects introduced by this remediation

### 3.1 — HIGH — `DimensionLockToggle`'s `redo_fn` cannot re-create the constraint it deleted

`backend/command_bus.py` (memento branch). `undo_fn` deletes the constraint the forward command created and
clears the id:

```python
                elif post_cid and post_cid in mgr.constraints:
                    del mgr.constraints[post_cid]
                    if did in mgr.dimensions:
                        mgr.dimensions[did]["constraint_id"] = None
```

`redo_fn` then only *flips a flag on an existing constraint* — it never re-creates one:

```python
                    target_cid = mgr.dimensions[did].get("constraint_id")   # == None after undo
                    if p.is_locked:
                        if target_cid and target_cid in mgr.constraints:
                            mgr.constraints[target_cid]["is_locked"] = True
```

Probe (`probe_r2.py`, section B), locking a previously-unlocked dimension:

```
counts before=0  after=1  undo=0  redo=0      <- redo should restore 1
```

So `lock → undo → redo` leaves `dim["is_locked"] == True` with **no enforcing constraint** — the exact
split-brain state H2 was fixed to eliminate, now reachable through a first-class UI path (the padlock plus
undo). The shipped test `§19e` runs precisely this sequence and passes because it asserts only
`dimensions[...].get("is_locked")`.

**Fix:** make `redo_fn` re-run the forward command (or re-create the constraint from the captured
parameters), mirroring how `DimensionCreate`'s redo re-invokes `create_dimension`.

### 3.2 — LOW/MEDIUM — a duplicate `/health` route shadows the new handler

`@app.get("/health")` is now registered **twice** — the pre-existing handler at `backend/main.py:285` and the
new one at `:719`. FastAPI matches routes in registration order, verified from the app's own route table:

```
/health      -> health          <- pre-existing, wins
/api/health  -> get_health
/health      -> get_health      <- shadowed
```

So `GET /health` still returns `{"status": "ok", "engine": ..., "version": ...}` with **no
`solver_available`**; only `/api/health` returns the new payload. The claim "add /health endpoint" is
therefore half-delivered, and the duplicate route is a latent trap for the next reader.

**Fix:** extend the existing `health()` handler at `:285` instead of adding a second route.

---

## 4. Residual defects (partially remediated)

### 4.1 — HIGH — H1: 31 of 78 non-degenerate kind-pair combinations still do not round-trip, silently

I swept the full cross-product the fix is supposed to cover — 10 kind pairs × 3 axes × 3 wall orientations
(x-aligned, y-aligned, diagonal), shrinking each dimension to 60% of its initial value — and ran it at both
commits in separate worktrees:

| | Round 1 `a276c97` | Round 2 `26cfed1` |
|---|---|---|
| combinations that round-trip | **5 / 78** | **47 / 78** |
| newly fixed | — | **+42** |
| still failing | 73 | **31** |
| of those, status reported | 29 `updated`, 2 `conflict` | **31 `updated`** |
| of those, wall length corrupted | 29 | **27** |

Representative failures (all report `status="updated"`):

```
case                                                len0    len1   meas0  target   meas1
x-aligned wall, start<->face_pos, axis=y           10.000   0.300   0.250   0.150   0.250
x-aligned wall, face_pos<->face_neg, axis=aligned  10.000   0.300   0.500   0.300   0.500
diagonal wall,  start<->center,   axis=x           10.000   3.600   3.000   1.800   1.080
diagonal wall,  center<->face_pos, axis=y          10.000  10.000   0.150   0.090   0.054
```

Three distinct residual causes:

1. **`face_pos ↔ face_neg` has no branch at all.** It is a *thickness* dimension, but it falls through to
   `target_len = val_float` and `_resize_wall_length`, so setting it to 0.30 ft **collapses a 10 ft wall to
   0.3 ft** while the dimension still reads 0.5. Fails on every axis and every orientation.
2. **Cross-orientation face projections.** An x-aligned wall with `start↔face_pos` on `axis="y"` (and the
   mirror) computes `target_len = 2·value`, which is only valid when the measurement axis runs *along* the
   wall. The length is corrupted and the value does not move.
3. **Diagonal walls projected onto `x`/`y`.** `2·value` (center) and `2·value` (thickness) ignore the
   projection factor, so both the length and the dimension are wrong.

**Regression, precisely scoped.** Of the 31, **two** changed from a *safe* round-1 refusal to silent
corruption — `face_pos↔face_neg` with `axis="aligned"` on the x- and y-aligned walls:

```
round1 = (conflict, length unchanged)  ->  round2 = (updated, length 10.0 -> 0.3)
```

The other 29 were already failing at round 1 (mostly already corrupting), so they are residual rather than
regressed — but the remediation's stated claim (*"route same-element reference pairs correctly by kind
without corrupting length"*) is broader than what was delivered.

### 4.2 — MEDIUM — H3: a level dimension is still absolute in practice, because walls resolve z to `0.0`

The new code computes a genuinely relative target:

```python
                    elev_other, _ = resolve_reference_axis(self, other_ref, "z")
                    if elev_other is None:
                        elev_other = 0.0
                    ...
                    target_elev = elev_other + sign * val_float
```

but `resolve_reference_axis(<wall>, "z")` returns `(0.0, "exact")` for a wall hosted on an elevated level:
walls carry `level_id` and **no `elevation` meta key**, so the lookup falls back to 0.0. Probe
(`probe_r2b.py`), a wall on a level at 20 ft:

```
level 'Level 2' elevation=20.0, wall meta elevation=None
created value=20.0                 <- should be 0.0: the wall SITS ON that level
set 5.0 -> updated; level elevation now = 5.0    <- absolute, not 20 + 5 = 25
```

So for the common case (an element hosted on a level) the target is still absolute, and the *creation* value
is wrong too (20.0 rather than 0.0). The shipped test `§19h` cannot see this: it creates a **new level at
elevation 0** and puts the wall at the default elevation, so element-z and level-z coincide.

### 4.3 — MEDIUM — M2: the two conflict payloads still use different `resolutions` schemas

The top-level keys are now unified — that half is genuinely fixed. But the element schema is not:

```
legacy    : {"action": "unlock_constraint", "constraint_id": "align_deadbeef"}
dimension : {"kind": "unlock_dimension", "dimension_id": "dim_…", "segment_index": 0}
```

Plan §3.5 specifies `{"kind": "unlock_dimension" | "unlabel" | "release_eq", ...}`. Any Phase 7.3 button
wiring must therefore handle two vocabularies. The legacy payload also carries `triggered_by`, which is not
in the contract (harmless).

### 4.4 — MEDIUM/LOW — M3: reachable now, but the binding vocabulary deviates and the label rule is missing

Verified through the bus:

```
via bus: binding = equal | label = None | eq_anchor = None          <- params now flow
via bus: locked + label        -> REJECTED  (validator reachable)   <- good
via bus: label with binding='literal' -> ACCEPTED                   <- plan §2 rule 1 not enforced
via bus: binding='parameter'   -> REJECTED: Input should be 'literal', 'equal' or 'formula'
```

`DimensionCreateParams.binding` is `Literal["literal","equal","formula"]`; plan §2 specifies
`"literal" | "parameter" | "equal"`. So the plan's `parameter` binding is unrepresentable while an
unplanned `formula` is accepted, and `label` is not tied to `binding == "parameter"` (plan §2 rule 1:
*"`label`: set iff `binding == "parameter"`"*).

---

## 5. Lock semantics: the lock does not hold the value (pre-existing, newly load-bearing)

Not a round-1 finding, but now central because the remediation creates these constraints from the toggle and
its test asserts only flags.

`add_dimension_lock(guid_a, guid_b, locked_distance, axis)` builds a constraint over the two elements'
**origin** coordinates, whereas a dimension is defined over arbitrary **references**. Probe
(`probe_lock_semantics.py`), dimension between `wall_start(x)` and `wall_end(y)`, locked at 20.0:

```
locked at reference distance = 20.0000
constraint locked_distance   = 20.0
at the moment of locking: reference distance = 20.0000, origin distance = 10.0000
after dragging the referenced wall +5 ft:
    reference distance = 30.0000   <- the dimension's own value
    origin distance    = 20.0000   <- what dimension_lock constrains (now "satisfied")
RESULT: locked dimension DID NOT HOLD its locked value (drifted by +10.0000 ft)
```

So a user who locks a dimension at 20'-0" and drags a witness ends up 10 ft away from it, with the
dimension reading 30'-0" and the solver reporting no conflict. This is the substantive half of Phase 6.1 /
5.4 and it remains open. The new test `§19g` asserts `constraints[cid]["is_locked"]` and `locked_distance`
but never that the value holds.

---

## 6. What is genuinely fixed (credit)

Verified by execution, not by reading the diff:

- **H4 — clean refusal.** A forced-failing solve returns `{"status": "failed", ...}`, leaves `dim["value"]`
  untouched, and changes no geometry. The buggy "loop over every coordinate" fallback is gone.
- **M1 — conflict lifecycle.** `last_constraint_conflict` is cleared on every success path (solver,
  single-element, multi-element, level) and after a valid `set_dimension_value`.
- **M4 — the flagship gate now tests the architecture.** Gate 3 Case 1 calls `move_reference` once;
  `solve_dimensions` is still consulted for the conflict oracle.
- **M5 — overlay versioning done properly.** Writes `schema_version: 4`; a v3 container carrying `refs`
  loads authoritatively with refs restored; a v3 container *without* refs also loads authoritatively and
  regenerates wall refs from geometry. Both directions verified.
- **M6 — target preservation and honest status.** A locked dimension keeps its 20.0 target through a drag
  while an unlocked one tracks to 25.0, and `status` is now `exact` rather than the always-`repaired` mislabel.
- **M3 plumbing.** `binding`/`label`/`eq_anchor` are on `DimensionCreateParams`, flow through both the
  execute and redo paths, and the validator is now on the live `create_dimension` path (reached via the bus).
- **H1 for the well-defined cases.** All 8 same-element kind pairs round-trip exactly on an x-aligned wall
  with `axis` along the wall, and on a y-aligned wall with `axis="y"` — 42 combinations newly working. The
  `{start, center} → 2·value` and `{center, face} → thickness` algebra is correct in that domain.
- **L1/L2.** Null-segment guards and a `non_positive_target_distance` failure instead of a silent skip.
- **F1/F3/F4/F6.** The padlock now drives `toggleDimensionLock`; the store surfaces `data.conflict` as a
  status message; the EQ fallback reports instead of returning silently.
- **Test growth.** 123 checks (from 100) including axis-`y` and shrink cases, and 68 container checks.
- **No gate weakened.** `check-ui-p0.mjs` still asserts `DI` is unimplemented; `DI` remains `implemented: false`.

---

## 7. Low-severity observations

- **`CONTAINER_FORMAT_ID = "bimworks_hybrid_v3"`** is unchanged while the overlay schema is now 4, so the
  container format id and the schema version disagree.
- **The new planegcs compatibility shim is unexercised dead code.** `constraint_solver.py` monkeypatches
  `Sketch.add_fixed_point` / `set_p2p_distance` when absent. The installed planegcs has both, so neither
  branch runs and no test covers them. I confirmed pybind11 permits the attribute assignment, so it is not a
  crash risk here — but its correctness (`add_param` / `p2p_distance` / `fix_point`) is unverified against any
  real older planegcs.
- **`§19i` does not test what it appears to test.** It points `ref_b` at a non-existent wall, so
  `set_dimension_value` returns the pre-existing `{"status": "error", "error": "…references lost"}` from the
  lost-witness guard — not the new `status != "success"` refusal. The new guard is covered only by my
  monkeypatched probe.
- **`axis="z"` is unreachable through the bus** (`Literal["x","y","aligned"]`), so `§19h`'s level case, which
  passes `axis="z"`, can only be created via the manager. The level-kind branch does also trigger on the
  reference kind, so an `axis="x"` level dimension works — but the tested path is not the one a user can take.

---

## 8. Required for a clean close

1. **Finish H1.** Handle `face_pos↔face_neg` (thickness) explicitly, derive the projection factor for
   cross-orientation and diagonal cases rather than assuming the axis runs along the wall, and — most
   importantly — make every unhandled pair **refuse** (`status="failed"`) instead of falling through to
   `_resize_wall_length`. Then extend the fixture to the full kind-pair × axis × orientation matrix; the
   current `§19f` covers one cell of 90.
2. **Fix `redo_fn`** in the `DimensionLockToggle` memento, and add the assertion that made round 1 miss it:
   after `lock → undo → redo`, the constraint must exist again.
3. **Make the lock hold.** Decide whether `dimension_lock` constrains references or elements; today it
   constrains origins, so a locked dimension drifts. Add a test that locks a dimension, drags a witness, and
   asserts the value holds.
4. **Make the level target truly relative** for elements whose z comes from their level (`level_id`) rather
   than an `elevation` key, and fix the creation value for that case. `§19h` should use a level that is not
   at elevation 0.
5. **Collapse the duplicate `/health` route** into the existing handler.
6. **Unify `resolutions`** on the §3.5 vocabulary, and align `binding` with the plan
   (`parameter`, not `formula`) with `label ⇒ binding == "parameter"` enforced.

---

## Appendix — probes

All probes are throwaway and live in `/tmp`; the repository was left clean and the comparison worktree was
removed. Run from the repo root with `.venv/bin/python -u`.

| Probe | Purpose | Result |
|---|---|---|
| `/tmp/probe_r2.py` | H1 all 8 pairs; H2 sync; H3 level; H4 refusal; M2 shapes; M3 vocabulary; /health | 17 passed, 6 failed, 4 notes |
| `/tmp/probe_r2b.py` | M2 shapes (proper trigger); M1 clearing; M5 v3/v4 compat; M6 targets; level blast radius | 11 passed, 2 failed |
| `/tmp/probe_h1_matrix.py` | 10 kind pairs × 3 axes × 3 orientations round-trip sweep | 47 pass / 31 fail / 12 degenerate |
| `/tmp/probe_matrix_csv.py` | same sweep as CSV, run at `a276c97` and `26cfed1` for before/after | 5→47 fixed; 31 residual; 2 regressed |
| `/tmp/probe_h1_damage.py` | wall-length corruption evidence for the failing cases | 10 ft → 0.3 ft for `face_pos↔face_neg` |
| `/tmp/probe_lock_semantics.py` | does a locked dimension hold its value? | no — drifted +10 ft |
| `/tmp/probe_lock_enforce.py` | explicit `solve()` on a locked dimension | success, applied, value unchanged |
| `/tmp/probe_m3_bus.py` | binding/label/eq_anchor through the bus | reachable; `parameter` rejected, `literal`+label accepted |
| round-1 probes | regression check on the original findings | `probe_dim_review` 4 failed → 0; `probe_path` `move_reference` 0 → 1 |
