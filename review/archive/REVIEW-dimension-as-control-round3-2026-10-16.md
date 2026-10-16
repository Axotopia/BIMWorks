# REVIEW (Round 3) — Gemini's second remediation of the dimension-as-control findings

**Reviewed commit:** `41cbe82` — *"fix(dimensions): address round 2 review findings for dimension control"*
**Parent:** `7a36697`; remediation for my round-2 review of `26cfed1`
**Round 1 review:** `review/REVIEW-dimension-as-control-2026-10-16.md`
**Round 2 review:** `review/REVIEW-dimension-as-control-round2-2026-10-16.md`
**Checkout:** `/home/song/Documents/DSH/axoworks/BIMWorks`, `main`, tree clean
**Date:** 2026-10-16
**Method:** Re-ran every gate; re-ran all four round-2 probes; re-ran the 10×3×3 kind-pair × axis ×
orientation matrix and compared all three commits; then wrote new probes for the code this round touched
(the `origin_distance` bookkeeping, same-element locks in the solver, and the newly-added `z` axis).
Rounds 1 and 2 were checked out in temporary worktrees to separate regressions from residuals.

---

## 0. Verdict

**This is the strongest round yet.** Every round-2 defect is addressed, and the H1 work — which was the
biggest gap — is now both much broader and, crucially, **no longer destructive**: the matrix goes
**5 → 47 → 70 of 78** combinations round-tripping, and all 8 remaining cases now **refuse** with an
explanatory `status="failed"` instead of silently corrupting geometry.

Round 2's three blocking items are closed:

| Round-2 blocker | Status |
|---|---|
| H1 silent corruption (27 of 31 cases corrupted length) | ✅ **resolved** — 0 corruption; 8 residual cases refuse safely |
| `DimensionLockToggle` `redo` could not re-create the constraint | ✅ **fixed** and verified (`redo` restores count and `constraint_id`) |
| The lock did not hold its value | ✅ **fixed** — holds through a drag (20.0 → 20.0) and via the toggle on an offset-reference dimension |

Three things remain, one of which is a **regression I traced to the round-2 M1 fix**:

1. **N1 (regression, MEDIUM/HIGH).** `_solve_constraints_after_move` clears `last_constraint_conflict`
   *inside* its per-axis loop, so a conflict on one axis is erased by success on the other. Verified: the
   same injected conflict is **reported at round 1 and swallowed at rounds 2 and 3**. This hollows out the
   legacy constraint half of the §3.6 conflict surface.
2. **N2 (MEDIUM).** Locking a **same-element** dimension now creates a constraint that is arithmetically
   impossible (`guid_a == guid_b` with a positive distance ⇒ `|pos_a − pos_a| = d`). `solve()` returns
   `conflict` citing it. Reachable when the wall is in a ≥2 scope.
3. **N3 (MEDIUM).** `origin_distance` is computed once and **never refreshed** when `locked_distance`
   changes, so changing a locked dimension's target does not achieve it — requested 25.0, measured 22.5,
   while `dim["value"]` says 25.0. Better than round 2 (32.5) but still wrong.

---

## 1. Verification performed

| Run | Round 1 `a276c97` | Round 2 `26cfed1` | **Round 3 `41cbe82`** |
|---|---|---|---|
| `npm run check` | exit 0 | exit 0 | **exit 0** (all 6 gates) |
| `scratch/test_dimensions_crud.py` | 100 | 123 | **150 passed, 0 failed** |
| `scratch/test_container_fidelity.py` | 66 | 68 | **68 passed** |
| `scratch/test_solver_capability.py` | 17 | 17 | **17 passed** |
| `scratch/test_references.py` | 32 | 32 | **32 passed** |
| H1 matrix round-trip | 5 / 78 | 47 / 78 | **70 / 78** |
| H1 matrix silent corruption | 29 | 27 | **0** |
| round-3 verification probe | — | — | **19 passed, 0 failed** |

---

## 2. Round-2 findings — status

| # | Round-2 finding | Verified at `41cbe82` |
|---|---|---|
| H1 | 31 combinations not round-tripping; 27 silently corrupting length | ⚠️ **largely fixed** — 70/78; 8 residual, **all** `status="failed"`, 0 corruption (§3.5) |
| H2-redo | `redo` could not re-create the constraint | ✅ **fixed** — `before=0 → after=1 → undo=0 → redo=1`, `constraint_id` restored |
| H2-same-element | locking a same-element dimension created no constraint | ✅ **creates one now** — but it is contradictory (§3.2) |
| H3 | element ↔ `level_plane` target was absolute, not relative | ✅ **fixed** — verified both directions: 0+5=5 and 30−5=25; creation value now correct |
| M2 | the two conflict payloads used different `resolutions` schemas | ⚠️ **mostly** — both carry `kind` and the top-level keys match; the legacy kind is `unlock_constraint` (§3.6) |
| M3 | `binding` vocabulary deviated; `label` not tied to `parameter` | ✅ **fixed** — `Literal["literal","parameter","equal"]`; `parameter` requires a label; a label is rejected otherwise; `formula` is gone |
| L3 | duplicate `/health` route shadowed the new handler | ✅ **fixed** — one handler, both `/health` and `/api/health` return `solver_available` |
| lock semantics | a locked dimension did not hold its value | ✅ **fixed** — holds at the original target; see N3 for a target *change* |
| H4 | value recorded when the solve failed | ✅ still fixed — refuses, records nothing |
| M1 | conflict report never cleared | ⚠️ **over-corrected** — see N1 |
| M5 | overlay schema version | ✅ still 4 |
| L1 / L2 | null dereference; silent zero-distance | ✅ still fixed |

---

## 3. Remaining and new defects

### 3.1 — MEDIUM/HIGH (regression from round 2) — a conflict on one axis is erased by success on the other

Round 2's M1 fix added `self.last_constraint_conflict = None` to the success branch, but that branch sits
**inside the per-axis loop** in `_solve_constraints_after_move`:

```python
        for axis in ("x", "y"):
            ...
            result = solver.solve(axis=axis, pins=pins, scope=scope)
            if result.ok:
                self.last_constraint_conflict = None      # <- clears a conflict found on the OTHER axis
                solver.apply_solve(result)
            elif result.status == "conflict":
                self.last_constraint_conflict = {...}
```

The solver runs per axis and conflicts are usually axis-local, so the common case is: conflict on `x`,
clean solve on `y` → the report is wiped before anyone can read it.

Isolated with an injected `conflict` on `x` and `success` on `y`, run at both commits:

```
round 1 (a276c97): last_constraint_conflict = {"axis":"x","constraints":["align_fake"],...}   REPORTED: YES
round 3 (41cbe82): last_constraint_conflict = null                                            REPORTED: NO
```

Also reproduced with a real constraint set (an `align` plus a same-element locked dimension), where the raw
per-axis solve returns `conflict` on `x`:

```
raw solve(axis=x) -> conflict conflicting=['align_27786126','dimlock_1e0979f0']
raw solve(axis=y) -> success
_solve_constraints_after_move => last_constraint_conflict = None
```

Impact: `GET /api/constraints/conflict` and the `conflict` field on every `Constraint*` mutation response are
unreliable for the *constraint* (as opposed to the *dimension*) conflict path — which is the path the M1/M2
work exists to surface. The dimension over-constraint path is unaffected because it returns the report
directly, which is why the suite still passes.

**Fix:** accumulate the per-axis outcomes and assign once after the loop (and only clear when *no* axis
conflicted).

### 3.2 — MEDIUM — a same-element lock creates an unsatisfiable constraint

`create_dimension(is_locked=True)` and `DimensionLockToggle` now both build a constraint for a
same-element dimension, with both endpoints set to the same GUID:

```json
{"type":"dimension_lock","guid_a":"0kQh…","guid_b":"0kQh…","locked_distance":10.0,"axis":"x","is_locked":true}
```

That asserts `|pos_a − pos_a| = 10`, which can never hold:

```
solve(axis=x, scope=[a]) -> status=conflict  conflicting=['dimlock_72eb159c']  applied=[]
```

`affected_guids` returns the singleton `{a}` for a self-lock, so a lock in isolation does not widen the scope
and `_solve_constraints_after_move` returns early. But any wall that is also tied to another element — an
`align` constraint, or a locked cross-element dimension — is solved with a ≥2 scope, and the self-lock then
poisons it:

```
scope size = 2
raw solve(axis=x) -> conflict conflicting=['align_27786126','dimlock_1e0979f0']
```

So locking the canonical `wall_start ↔ wall_end` dimension (Gate 3's own case) on a wall that carries any
other constraint makes that wall's solves report a conflict. A self-referential length lock should either be
represented differently (e.g. as a length constraint on the single element) or not materialised as a
`dimension_lock` at all.

### 3.3 — MEDIUM — `origin_distance` goes stale, so changing a locked dimension's target does not achieve it

`add_dimension_lock` now stores both the reference distance (`locked_distance`) and the element-origin
distance the constraint actually enforces (`origin_distance`) — a genuinely clever compensation that makes
the lock hold (verified). But only the creation path computes `origin_distance`; `set_dimension_value` and
the toggle's re-lock update `locked_distance` alone, and the solver prefers the stale `origin_distance`
(`dist = c.get("origin_distance") or c.get("locked_distance")`):

```
round 3: created  stored=20.0 measured=20.0  locked_distance=20.0 origin_distance=10.0
         set(25.0) -> status=updated  stored=25.0  measured=22.5
         locked_distance=25.0  origin_distance=10.0   <- not refreshed
         achieves the requested target: False
round 2: set(25.0) -> measured=32.5                (worse, but also False)
```

Two consequences: the requested value is not achieved, and `dim["value"]` (25.0) disagrees with
`resolve_dimension()` (22.5) — the R4 "two sources of truth" property, now returning for locked dimensions.

### 3.4 — LOW/MEDIUM — the bus now accepts `axis="z"`, but z is only implemented for datums

This round widened `DimensionCreateParams.axis` to `Literal["x","y","z","aligned"]` (round 2 accepted only
`x`/`y`/`aligned`). The mechanism behind the resulting misrouting is unchanged from round 2 — what is new is
that it is now **reachable through the bus**:

```
created z dimension between two walls: value=8.0
set(8.0) -> status=updated, measured=0.0
b.start [0.0, 5.0, 0.0] -> [0.0, 8.0, 0.0]     <- moved on Y, not Z
```

The z case works for `level_plane` references (via `move_level`), but for any other pair `set_dimension_value`
falls back to `solve_axis = "x" if … else "y"` and drives the wrong axis while reporting `"updated"`. The plan
is explicit that this is out of scope — §7.5: *"`z`-axis dimensions … out of scope; noted so the `"z"` in the
TS union is not mistaken for support"*, and *"`_solve_constraints_after_move` iterates `("x","y")`"*.

Mitigating: the UI never sends `axis: 'z'` today (the only `z` occurrences in `src/` are a type union in
`types/bim.ts:282` and an unrelated field in `PlanViewport2D.tsx:78`). So the exposure is via the HTTP/bus
API rather than the current UI. Either implement z properly or keep it out of the accepted vocabulary.

### 3.5 — LOW — the 8 remaining H1 refusals are cases the fix could handle

All 8 are the same shape: an axis-aligned wall with a `start`/`end` ↔ `face` dimension measured on the
**cross** axis (x-aligned wall + `axis=y`; y-aligned wall + `axis=x`), e.g.

```
status=failed  reason=Cannot change wall length along y for x-aligned wall
dim value 0.25 -> 0.25;  length 10.0 -> 10.0        <- correctly untouched
```

The refusal is the right *safety* behaviour, but for these cases the measured quantity is the face offset
projected on the axis, which is **length-invariant** — the correct degree of freedom is *thickness*
(`new_th = 2 · value`), not length. So this is a coverage gap rather than a defect: safe, but the fix is
available.

### 3.6 — LOW — the legacy conflict kind is outside the plan's vocabulary

Both paths now carry `kind` and the top-level keys match, which closes most of M2. The difference is the
identifier payload and the kind value:

```
legacy    : {"kind": "unlock_constraint", "constraint_id": "align_deadbeef"}
dimension : {"kind": "unlock_dimension",  "dimension_id": "dim_…", "segment_index": 0}
```

Plan §3.5 lists `unlock_dimension`, `unlabel`, `release_eq`. `unlock_constraint` is defensible for a pure
constraint conflict (there is no dimension to unlock), but a consumer written to the contract will not know
it. Worth documenting either way.

---

## 4. What is genuinely fixed (credit)

Verified by execution, not by reading the diff:

- **H1 — the big one.** The fix now derives the projection properly: it computes the wall's unit vector and
  normal and divides by the actual projection factor for the requested axis, with explicit cases for
  face↔face (thickness), centre↔face (half-thickness), start↔end (length), start/end↔centre (half-length) and
  start/end↔face (Pythagorean / projection), and it **refuses** everything else plus any non-positive target.
  Result: **70/78** round-trip and **zero** silent corruption, down from 27 corrupted cases. Verified across
  all three commits with a temporary-worktree comparison.
- **H2 `redo`.** The memento now captures the constraint created by the forward command and restores it,
  including `constraint_id`: `before=0 → after=1 → undo=0 → redo=1`.
- **H2 same-element lock representation.** Locking now materialises a constraint for same-element pairs
  (the arithmetic is wrong — §3.2 — but the "flag with nothing behind it" gap is closed).
- **H3 level datum.** `resolve_reference_axis` now falls back from a missing `elevation` to the element's
  `level_id`, so a wall on Level 2 resolves z = 20 rather than 0. The level target is genuinely relative,
  verified in both directions: a wall at 0 with the level set to 5 → 5; a wall at 30 with the level set to
  5 → 25. The creation value is correct too (20.0 for a wall at 0 and a level at 20).
- **Lock holds.** Verified three ways: a locked dimension at 20.0 survives a drag at 20.0; a lock created by
  the toggle on a dimension whose references sit off the element origins (reference 15.0, origin 10.0) still
  holds 15.0; the `origin_distance` compensation is the right idea.
- **M3 binding rules.** The vocabulary now matches the plan (`literal|parameter|equal`), `binding="parameter"`
  requires a label, a label is rejected for every other binding, and `formula` is gone. Enforced in both the
  bus param model and `create_dimension`/`add_dimension`, so it is reachable from the API.
- **L3 health.** The duplicate route is gone; the single handler serves both `/health` and `/api/health` and
  reports `solver_available`.
- **M2.** Both conflict payloads now carry `kind`, and the dimension path maps conflicting constraints back
  to their owning dimensions (`dimensions` is populated, not always empty).
- **No regressions in earlier fixes.** H4 (refusal records nothing), M1 (clears after a successful *dimension*
  set), M5 (schema 4) all re-verified. `npm run check` is green and no gate was weakened.
- **Test growth:** 150 checks in the dimension suite (from 123), including coverage for the new behaviours.

---

## 5. Required for a clean close

1. **Fix the per-axis clearing (N1).** Collect per-axis results and assign `last_constraint_conflict` once
   after the loop. Add a test with a conflict on one axis only — the current tests all conflict on every axis,
   which is why this slipped through two rounds.
2. **Stop creating a contradictory constraint for same-element locks (N2).** Represent a single-element length
   lock as a length lock on that element, or skip constraint creation and document that a same-element lock is
   advisory.
3. **Refresh `origin_distance` whenever `locked_distance` changes (N3)** — in `set_dimension_value` and in the
   toggle's re-lock — and assert that after changing a locked dimension's target, `resolve_dimension()` equals
   the stored value.
4. **Decide on `z` (N4):** implement it, or revert the param model to `x|y|aligned` and express the level case
   through the datum kind (which already works on `axis="x"`).
5. **Extend the H1 fixture to the full matrix (§3.5)** — the shipped tests cover a small subset of the
   10 × 3 × 3 space; my sweep is the cheap way to keep it honest, and it caught what the suite missed twice.

---

## Appendix — probes

All probes are throwaway and live in `/tmp`; the repository was left clean and both comparison worktrees were
removed. Run from the repo root with `.venv/bin/python -u`.

| Probe | Purpose | Result |
|---|---|---|
| `/tmp/probe_r3.py` | H2 redo + same-element lock; H3 both directions; M2 shapes; M3 rules through the bus; L3 health; H4/M1/M5 regressions; lock-holds | **19 passed, 0 failed** |
| `/tmp/probe_r3b.py` | self-lock in the solver; `origin_distance` sync; toggle lock on offset refs; z-axis routing; refusal leaves value/geometry untouched | 6 passed, 0 failed — but §3.2/§3.3 surfaced in the details |
| `/tmp/probe_selflock.py` … `/tmp/probe_selflock5.py` | isolate the same-element lock contradiction and why the scope does not widen | `solve(scope=[a]) -> conflict` |
| `/tmp/probe_axisorder.py` | real align + self-lock: raw per-axis conflict vs. reported conflict | conflict swallowed (N1) |
| `/tmp/probe_axisorder2.py` | injected conflict-on-x / success-on-y, run at `a276c97` and `41cbe82` | round 1 **REPORTED**, round 3 **NO** — regression |
| `/tmp/probe_r3_compare.py` | locked-target change and z routing, run at `26cfed1` and `41cbe82` | 32.5 → 22.5 (still wrong); z identical (now bus-reachable) |
| `/tmp/probe_matrix_csv.py` | 10 kind pairs × 3 axes × 3 orientations, run at all three commits | 5 → 47 → 70 of 78; 0 corruption |
| round-2 probes | regression check | `probe_r2` 17→20 passing; `probe_r2b` 11→12; lock-semantics probe flipped to PASS |

*Note:* the working tree also contains two untracked files from a different work stream
(`review/REVIEW-gemini-bpmx-pivot-proposal-2026-10-16.md`, `scratch/_probe_engine_smoke.py`). They are not
part of this review and were deliberately left alone.
