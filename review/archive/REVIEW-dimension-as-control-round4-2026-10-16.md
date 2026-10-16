# REVIEW (Round 4) — Gemini's third remediation of the dimension-as-control findings

**Reviewed commit:** `db10611` — *"fix(dimensions): remediate round 3 review findings (N1-N4, H1 cross-axis)"*
**Parent:** `ec2c99c` is current HEAD; `db10611` is the remediation (no `backend/` change since — verified)
**Rounds 1–3:** `review/REVIEW-dimension-as-control-2026-10-16.md`,
`review/REVIEW-dimension-as-control-round2-2026-10-16.md`,
`review/REVIEW-dimension-as-control-round3-2026-10-16.md`
**Checkout:** `/home/song/Documents/DSH/axoworks/BIMWorks`, `main`, tree clean
**Date:** 2026-10-16
**Method:** Re-ran every gate and the whole accumulated probe set (rounds 2–3 plus the three-commit matrix),
extended with a new probe for the `length_lock` machinery this round introduced.

---

## 0. Verdict

**All round-3 findings are fixed, and H1 is now complete.** The kind-pair matrix reaches **78/78** with zero
corruption, the conflict-axis regression is repaired, changing a locked dimension's target now works, and
`z` is out of the public vocabulary again. `test_dimensions_crud.py` grew from 150 to **176 checks** and the
whole gate suite is green.

One substantive item remains, and it is the *third* incarnation of the same gap: the same-element dimension
lock. Round 2 created no constraint; round 3 created a contradictory one; round 4 creates an honest
`length_lock` — which is then **never enforced by the solver**. The padlock shows on Gate 3's canonical
`wall_start ↔ wall_end` dimension and the length is not held.

| Round-3 item | Verified at `db10611` |
|---|---|
| **N1** conflict on one axis erased by success on the other | ✅ **fixed** — the injected conflict is reported again |
| **N2** same-element lock created an unsatisfiable constraint | ✅ **fixed as stated** — no spurious conflict; new `length_lock` type. ⚠️ but see §3.1 |
| **N3** `origin_distance` stale → target not achieved | ✅ **fixed** — requested target now achieved |
| **N4** `axis="z"` accepted but unimplemented | ✅ **fixed** — refused outside level datums; bus reverted to `x\|y\|aligned` |
| **H1** 8 cross-axis cases refused | ✅ **fixed** — the full matrix now round-trips |

---

## 1. Verification performed

| Run | R1 `a276c97` | R2 `26cfed1` | R3 `41cbe82` | **R4 `db10611`** |
|---|---|---|---|---|
| `npm run check` | exit 0 | exit 0 | exit 0 | **exit 0** |
| `scratch/test_dimensions_crud.py` | 100 | 123 | 150 | **176 passed, 0 failed** |
| `test_container_fidelity.py` | 66 | 68 | 68 | **68 passed** |
| `test_solver_capability.py` | 17 | 17 | 17 | **17 passed** |
| `test_references.py` | 32 | 32 | 32 | **32 passed** |
| `test_dependency_graph.py` | 41 | 41 | 41 | **41 passed** |
| **H1 matrix round-trip** | 5 / 78 | 47 / 78 | 70 / 78 | **78 / 78** |
| H1 matrix length corruption | 29 | 27 | 0 | **0** |
| round-3 verification probe | — | — | 19 / 19 | **19 / 19 (unchanged)** |
| lock holds through a drag | — | ✗ | ✓ | **✓** |

Probe deltas vs round 3: the one probe that reports new failures does so because **behaviour improved** — the
cross-axis H1 case now succeeds (`status="updated"`, thickness adjusted) where the probe still expected the
old refusal. Confirmed by reading the output, not assumed.

---

## 2. Round-3 findings — detail

### N1 — fixed

`_solve_constraints_after_move` now accumulates the per-axis outcome and assigns once after the loop:

```python
            axis_conflict = None
            for axis in ("x", "y"):
                ...
                if result.ok:
                    solver.apply_solve(result)          # no longer clears
                elif result.status == "conflict" and axis_conflict is None:
                    axis_conflict = {...}
            self.last_constraint_conflict = axis_conflict
```

The isolated reproducer (conflict on `x`, success on `y`) — reported at round 1, swallowed at rounds 2–3:

```
now: last_constraint_conflict = {"status":"conflict","axis":"x","constraints":["align_fake"],...}
     REPORTED: YES
```

Clean solves on both axes still clear it (`axis_conflict` stays `None`), so the round-2 M1 behaviour is
preserved where it is correct.

### N2 — fixed as reported, with a residual (§3.1)

`add_dimension_lock` now branches on `guid_a == guid_b` and emits a `length_lock` instead of a
self-referential `dimension_lock`, and the solver skips any `dimension_lock` whose endpoints coincide:

```python
            elif ctype == "dimension_lock":
                a, b = c.get("guid_a"), c.get("guid_b")
                if not a or not b or a == b:
                    continue
```

Verified: the constraint is now `{"type":"length_lock","guid":…,"locked_length":10.0,…}` and, with the wall
in a ≥2 scope, `solve(axis="x")` returns **success** with no conflicting set (round 3 returned `conflict`
citing the self-lock). The spurious-conflict defect is gone.

### N3 — fixed

The compensation is now computed **live** in the solver from the current reference offsets rather than read
from a cached `origin_distance` (which is retained only as a fallback), and every update path refreshes it
via a new `_recalculate_origin_distance` helper (7 call sites):

```
created  stored=20.0 measured=20.0
set(25.0) -> status=updated  measured=25.0   achieves the requested target: True
```

Round 2 measured 32.5 for the same request, round 3 measured 22.5. The stored value and the measurement now
agree.

### N4 — fixed

The bus param model is back to `Literal["x","y","aligned"]`, and the manager refuses `z` outside datums:

```
create_dimension(..., axis="z") on a wall pair
  -> ValueError: Measurement axis 'z' is only supported for level datums
```

plus a guard in `set_dimension_value` for an existing `axis == "z"` dimension that is not a level datum.
Level dimensions continue to work (verified in round 3 and re-verified here).

### H1 — complete

The last 8 cases were the cross-axis projection (an axis-aligned wall with a `start`/`end` ↔ `face` dimension
measured on the perpendicular axis). The fix recognises that the measured quantity is **length-invariant** and
adjusts thickness instead of refusing:

```python
                    elif dim_axis == "y":
                        if abs(uy) < 1e-4:
                            # x-aligned wall: distance along y to face is purely face offset (thickness)
                            new_th = 2.0 * val_float / abs(ny)
```

Arithmetic verified independently: for an x-aligned wall, `wall_start ↔ wall_face_pos` measured on `y` is
`thickness/2`, so `new_th = 2·value` is the correct degree of freedom — and the wall's **length is preserved**
(10.0 → 10.0). The whole matrix now round-trips:

```
r1 a276c97:  5/78      r2 26cfed1: 47/78      r3 41cbe82: 70/78      r4: 78/78
round4 failures: 0;  length corrupted: 0
```

---

## 3. Remaining

### 3.1 — MEDIUM — the new `length_lock` is never enforced, so a same-element lock does nothing

`length_lock` is written by `add_dimension_lock` and by `create_dimension`/`DimensionLockToggle`, and it is
registered in `affected_guids` for scope widening — but the solver has **no enforcement branch** for it.
`constraint_solver.py` never mentions `locked_length`, and `"length_lock"` occurs exactly once in the file
(the `affected_guids` case). Empirically, with the wall in a ≥2 scope and the length locked at 10.0:

```
locked at 10.0 ft; current length = 10.0
after an unrelated edit: length = 5.0
after _solve_constraints_after_move: length = 5.0      <- not restored
dim["value"] = 10.0,  resolve_dimension() = 5.0        <- permanent disagreement
```

So the user sees a padlock on `wall_start ↔ wall_end` (Gate 3's own canonical dimension, and the most common
dimension there is) and the length is not held; the dimension's stored target and its measurement disagree
indefinitely, because the round-2 M6 fix correctly preserves a locked dimension's stored value.

This is the substantive half of "lock means the value holds" and it is still unmet for single-element
dimensions. It is implementable with machinery that already exists: `solve_dimensions` builds a
reference-keyed node table, so a `length_lock` can be applied as `set_p2p_distance` between the dimension's
own two references (the same approach the equalize pass uses for within-element relations). The alternative —
drop the constraint and document a same-element lock as advisory — is also defensible, but it should be a
decision rather than a silent no-op.

Worth noting the pattern across rounds: each round fixed the reported symptom (no constraint → contradictory
constraint → inert constraint) while the underlying requirement stayed open. A test that locks a
single-element dimension, changes the length by some other route, and asserts the value returns would have
caught all three.

### 3.2 — LOW — the legacy conflict resolutions kind is still outside the plan's vocabulary

Carried from round 3, unchanged: the constraint path emits
`{"kind": "unlock_constraint", "constraint_id": …}` while the dimension path emits
`{"kind": "unlock_dimension", "dimension_id": …, "segment_index": 0}`. Plan §3.5 lists `unlock_dimension`,
`unlabel`, `release_eq`. Defensible for a constraint-only conflict (there is no dimension to unlock), but a
consumer written to the contract will not recognise it.

### 3.3 — LOW — `origin_distance` is now maintained twice

The solver recomputes the compensated distance live from `locked_distance` + current references, and
`_recalculate_origin_distance` also keeps the stored field fresh on every update path. The stored value is
only a fallback when live resolution fails, so this is defensive rather than wrong — but it is two
mechanisms for one quantity, and the fallback is untested. A one-line comment on why the field still exists
would prevent the next reader from re-deriving the round-3 bug.

---

## 4. What is genuinely fixed (credit)

Verified by execution:

- **H1 — complete.** 78/78 across 10 kind pairs × 3 axes × 3 wall orientations, zero corruption, zero
  failures. The projection algebra is correct per axis, and unsupported pairs refuse with an explanatory
  error rather than corrupting geometry (the round-4 cross-axis extension removed the last 8 refusals).
- **N1** conflict-axis preservation, verified by the same reproducer that exposed it.
- **N2** the self-referential constraint is gone; `length_lock` replaces it and the solver skips degenerate
  `dimension_lock` endpoints.
- **N3** the locked target is achieved and stored/measured agree.
- **N4** `z` is refused outside datums; the bus vocabulary no longer advertises it.
- **No regressions.** The round-3 probe set still reports 19/19; the lock still holds through a drag; the
  dimension-driven `move_reference` path is still used (Gate 3 Case 1); the dimension over-constraint path
  still returns a structured conflict.
- **Test growth:** 176 checks in the dimension suite (100 → 123 → 150 → 176), and all five python suites plus
  all six `npm run check` gates pass.

---

## 5. Required to close

1. **Enforce `length_lock`** (or make the decision explicit): apply it as a p2p distance over the dimension's
   own references, and add the test that would have caught all three incarnations — lock a single-element
   dimension, change the length by another route, assert the value returns.
2. Add the constraint-only `unlock_constraint` kind to the §3.5 contract (or rename it), so the two conflict
   paths present one vocabulary to a consumer.
3. One comment where `origin_distance` is stored, explaining it is a fallback to the live computation.

---

## Appendix — probes

Throwaway, in `/tmp`; repository left clean. Run from the repo root with `.venv/bin/python -u`.

| Probe | Purpose | Result |
|---|---|---|
| `/tmp/probe_r4.py` | is `length_lock` enforced? constraint type; solver source check; value-hold test | **4 passed, 3 failed** — the 3 failures are §3.1 |
| `/tmp/probe_axisorder2.py` | N1: injected conflict-on-x / success-on-y | **REPORTED: YES** (was NO at R2/R3) |
| `/tmp/probe_r3_compare.py` | N3 target achievement; N4 z routing | target **achieved**; z now **raises** |
| `/tmp/probe_matrix_csv.py` | 10 × 3 × 3 round-trip sweep, compared across all four commits | **78/78**, 0 corruption |
| `/tmp/probe_r3.py` | round-3 verification set (H2/H3/M2/M3/L3 + regressions) | **19 passed, 0 failed** |
| `/tmp/probe_r3b.py` | lock bookkeeping, self-lock, z, refusals | 4 passed, 2 failed — both stale expectations (the cross-axis case now succeeds) |
| `/tmp/probe_r2.py`, `/tmp/probe_r2b.py` | round-2 set | failures are the known probe artifacts (invalid legacy-conflict injection; the ill-posed self-referential level scenario) |
| `/tmp/probe_lock_semantics.py`, `/tmp/probe_path.py`, `/tmp/probe_grid.py` | lock holds; Gate 3 uses `move_reference`; grid/IFC sync | all still pass |

---

## 6. Closure — §3.1 (`length_lock`) fixed in the accompanying commit

The one substantive finding above is now closed by the commit that carries this note.

`BimModelManager._enforce_length_locks` re-asserts a single-element lock after any
intra-element edit, called from `update_element` (the single funnel for a baseline or
thickness change) so it fires whether the edit came from `ElementUpdate`, from
`move_reference`, or from another dimension's solve. It re-drives the owning dimension
through the same path a typed value takes, which reuses the reference-kind algebra the
H1 work built, so the lock holds for every kind pair the dimension supports.

Behaviour, verified in `scratch/test_dimensions_crud.py` §19n (190 checks now pass, up
from 176) and by probe:

- a length lock restores the wall after `update_element` or `move_reference` changes it,
  and the restored value is what the edit reports back;
- a thickness lock restores the thickness and leaves the length alone;
- an unlocked dimension still lets edits stand (the pass does not fight ordinary edits);
- an edit clear of the locked quantity is a no-op — no geometry rewrite, no revision churn;
- a length lock and a thickness lock on one element are independent degrees of freedom:
  both hold and **neither is reported as a conflict**;
- two locks disagreeing on the same degree of freedom are reported through
  `last_constraint_conflict` with `unlock_dimension` resolutions, naming exactly the locks
  the model cannot satisfy, and the geometry does not oscillate.

Two design notes, both recorded because they were the traps in earlier rounds:

1. **The solver still does not read `locked_length`, and that is now deliberate.** The
   element-node table holds one node per element GUID, so an intra-element distance cannot
   be expressed there. `BimModelManager._enforce_length_locks` is the enforcement point,
   and `constraint_solver.py` carries a comment at the `length_lock` case saying so. The
   round-4 probe's two remaining "failures" assert the old (wrong) expectation that the
   solver would apply it.
2. **Re-entrancy is guarded** by `_enforcing_length_locks`: re-asserting drives
   `_resize_wall_length` → `update_element` → the pass again, so without the guard it would
   recurse. Verified bounded (`project_rev` moves by 1 on an enforced edit, 0 on an
   unrelated one).
