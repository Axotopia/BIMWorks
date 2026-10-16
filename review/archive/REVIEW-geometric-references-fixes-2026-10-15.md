# REVIEW — Gemini's fixes to the geometric-references findings (`0e75402`)

**Reviewed commit:** `0e75402` — *"fix(references): resolve code review findings and wire automated python gate"*
**Parent:** `fc728a4` (my review, `REVIEW-geometric-references-refactor-2026-10-15.md`)
**Checkout:** `/home/song/Documents/DSH/axoworks/BIMWorks`, `main`, tree clean
**Date:** 2026-10-15

---

## 0. Verdict

**Substantially correct — this is real work, not a paper fix.** I independently reproduced every
claimed fix and could not falsify any of the eight functional ones. The B1 crash is gone, the P5
memento is *complete* (not just for the reported case), and the P4 extras rework is genuinely
right — including the ordering inversion and the swallowed exceptions.

Three things remain, and only one of them is a defect in the code:

| | |
|---|---|
| **8 of 10** review items | ✅ **genuinely fixed and independently verified** |
| **P0 `reference_key`** | ❌ **not fixed — replaced with a worse defect** (non-deterministic key) |
| **Silent overall-dimension substitution** | ⚠️ **half-fixed** — guard added, then defeated by its own caller |
| **Test coverage** | ⚠️ **regressed** — the committed extras probe no longer guards the solver change it claims to |
| Regression check | ✅ full 30-suite Python run: no new failures |

---

## 1. Verified fixes

Each row was checked by running the artefact independently, not by reading the diff.

| Item | Verification | Result |
|---|---|---|
| **B1** legacy-load `NameError` | `scratch/test_container_fidelity.py` → **58 passed, 0 failed**; `_probe_legacy_container_load.py` → **exit 0** | ✅ fixed |
| **B2** `join_policies` dropped | `_probe_legacy_join_policies.py` → **exit 0, "READ? True"**; container-fidelity §5 (join policies survive) passes | ✅ fixed |
| **Rec 2** Python gate | `npm run check` now runs `check:py` → **exit 0**; script fail-closes (`res.status !== 0` → `exit 1`, `break`) and resolves the venv cross-platform | ✅ correct |
| **P5** dangling `constraint_id` | `_probe_locked_dimension_undo.py` → **exit 0, "DANGLING: False"**; `test_transactions.py` 42/42 | ✅ fixed |
| **P4** extras ordering / scope / swallow | see §2 | ✅ fixed |
| **Rec 4** `repair_reference` wiring | now called in `_re_resolve_dimensions_after_move`; verified a moved witness yields `status: "repaired"` **and** the hint is rewritten to the new point | ✅ wired |
| **Rec 8** silent `(0.0, 0.0)` | `_resolve_ref_coords` returns `(None, "lost")`, no fallback; `create_dimension` **raises** instead of inventing `10.0` ft (verified) | ✅ fixed |
| **Rec 9** citations + tolerance | `create_dimension` `:3515` ✅, `DimensionCreate` `:429` ✅, overlay persistence `:6472` ✅, `tolerance=1.0` ✅ | ✅ mostly — §4 |

### P5 is fixed *completely*, not just for the reported case

Worth calling out because it is easy to get half-right. `delete_element` cascades into
`delete_dimension`, which calls `delete_constraint(cid)`. I checked whether `delete_element` deletes
any *other* constraints (align locks etc.) that the memento would then miss — it does not; the
dimension cascade is the only path. So capturing `constraint_id`s from `dims_pre` and restoring
`mgr.constraints` is exactly the right and sufficient fix.

## 2. P4 — independently confirmed correct

`scratch/test_reference_move.py` (11/11) and the probe both pass, but those are Gemini's own
assertions, so I re-derived the behaviour end-to-end:

```
ReferenceMove w1→grid, extras=[("align",(w1,w2))]
  status: moved   dx: 5.0   applied_extras: ['extra:align']
  w1: 0.0 -> 5.0      w2: 0.0 -> 5.0      align held (w1.x == w2.x)? True

memento completeness (the finding I raised):
  elements moved by this op: 2  (w1 dragged + w2 pulled by the extras solve)
  undo == pre   (ALL moved elements restored)? True
  redo == post  (ALL moved elements re-applied)? True

conflict handling (the "except Exception: pass" finding):
  extras=[("dimension_lock",(w1,w2,-500.0))] -> raises
  RuntimeError: Transaction 'tx_…' aborted and rolled back: Constraint conflict during ReferenceMove
```

The three things I flagged are each addressed: the extras pass now runs **after** the translate
(pinning the source at its *destination*), grids are pinned as fixed datums, failures **raise and roll
back**, and the memento records the net delta of *every* element the solve moved — not just
`src_guid`.

## 3. ❌ The P0 fix introduces a worse defect: `reference_key` is non-deterministic

```python
# backend/references.py:150
uid = norm.get("id") or norm.get("guid") or str(id(ref))
return f"point:unresolved:{uid}"
```

`id(ref)` is the CPython **memory address** of the dict. It is not an identity — it is an allocation
detail. Measured (`scratch/_probe_reference_key_stability.py`):

```
key(a) == key(a)                 (same object)         : True
key(a) == key(b)                 (equal VALUE)         : False   <-- breaks dedup/equality
key(a) == key(deepcopy(a))                             : False
key(a) == key(json round-trip)   (save/load .orlt)     : False
key(a) == key(normalize_reference(a))                  : False
cross-process                                          : point:unresolved:123995093442176
                                                         point:unresolved:138653591871104
```

The plan is explicit that this function is the identity model — §3.1: *"`reference_key(ref) -> str`
… **canonical, order-stable, for dedup + equality**"*; §5.1 heads the risk section with *"The identity
model is the risk."* A key derived from a heap address silently makes two **equal** references
unequal, and makes the same reference unequal to itself across a save/load or a snapshot. That is a
worse failure mode than the original deterministic collision: the original at least compared *equal
things equal*.

`norm.get("id")` never fires (`normalize_reference` emits no `id` key), and `norm.get("guid")` is
`None` for a hint-less point with no sources — so `id(ref)` is the effective path in every real case.

**Latent today** — `reference_key` still has **zero production consumers** (only tests call it), so
nothing is broken at runtime *yet*. But it is the primitive the companion plan's dimension-binding
work is supposed to build on, and it is now a landmine.

**Suggested direction:** an unresolved point genuinely has no positional identity, so either
(a) give references a stable identifier assigned at construction and persisted in the overlay, or
(b) keep a deterministic sentinel and document that hint-less points are *not* identity-bearing —
which is honest, rather than fabricating identity from a pointer.

> **I have to own part of this.** My `_probe_references_adversarial.py` asserted only that two
> *inline dict literals* produce different keys — which `id()` satisfies trivially. It passed for the
> wrong reason and gave false assurance. It should have tested **stability** (copy / round-trip /
> re-normalize / cross-process), not merely distinctness. My probe was too weak to falsify the
> hypothesis it existed to test.

## 4. ⚠️ The silent overall-dimension substitution is half-fixed

The guard was added in `_finish_plan_contract`:

```python
if not dims_out and not getattr(self, "dimensions", None):
    dims_out = self._overall_dimensions(contract)
```

…but the real render path is `render_2d_view` → `_annotate_view`, which re-applies the substitution
**unconditionally**:

```python
contract = self._finish_plan_contract(contract, cut_elevation, view_type)
if not contract.get("dimensions"):
    contract["dimensions"] = self._overall_dimensions(contract)   # <-- guard bypassed
```

Verified through the real entry point (`mgr.render_2d_view()`):

```
healthy dimension present:      ('dim_870b0c6d', 'exact', '3nXov…')   -> present: True   ✅
with only a LOST dimension:
  contract dims: [(None, None), (None, None)]   (2 auto-generated overall dims)
  lost dim surfaced? False
  SILENTLY replaced by auto overall dims? True   <-- still happens
```

So a user whose only dimension has gone `lost` does not see their dimension *or* an error — they see
two overall width/depth dimension lines that are not theirs. My finding #4 ("status omitted, lost dims
dropped, fallback substitutes") is only partly closed:

- ✅ `status` is now in the contract — **but only for dimensions that resolve** (verified `"exact"`).
- ❌ A `lost` dimension is still `continue`d *before* the status field is attached, so `status` can
  never describe it.
- ❌ The overall-dims substitution still fires on the real path.

Also minor: `create_dimension` hardcodes `"status": "exact"` at creation, so a dimension created with
unresolvable references (permitted when an explicit `value` is supplied) stores `status: "exact"`
despite being `lost`.

## 5. ⚠️ Test coverage: the extras probe was weakened

Gemini edited my `_probe_reference_move_extras.py`, changing the pin from the dragged element to the
grid. The edit is *reasonable* on its face (it matches the corrected semantics — grids are datums).
But it removed the probe's discriminating power. Proof, by removing the solver change and re-running
the committed probe:

```
patched out the "extras participants" block in constraint_solver.solve()
run committed scratch/_probe_reference_move_extras.py:
   applied = ['align_44878fb3', 'extra:align']
   drag-time extra actually applied? True
   exit=0        <-- PASSES with the solver change REMOVED
```

It passes because the grid is now in `pins`, and `participants |= set(pins)` already includes it
*before* the extras block runs — so the probe can no longer detect the very change it was written to
guard.

The solver change **is** load-bearing (I isolated it with an unrelated element reachable only via
`extras`):

```
                                  WITH block     WITHOUT block
extras=[("align",(w1,w3))]     applied: ['extra:align']   applied: []
(w3 not reachable from w1)     extra applied? True        extra applied? False
```

So the change works, but **nothing committed covers it**. The probe now reports "verified" for a
change it cannot see — the same class of false assurance as §3.

## 6. Minor

- **`ReferenceKind` is still an unused import** in `command_bus.py:16` (import-only; the commit
  message claims "cleaned unused imports"). `resolve_reference_axis` and `reference_key` were
  correctly removed from `ifc_service.py`.
- **Three citations remain stale** despite §7.1. The commit's own import removal shifted
  `self.dimensions` from 249 → **247**, but the citation was left at `:249` while every other anchor
  was updated. Normalization-on-load is cited at `:4700`/`:6605`; the actual `normalize_reference`
  call sites are **`:4718-4730`** / **`:6621-6633`**.
- **`check:py` covers 6 of ~30 Python suites.** The rest (`test_wall_joins*`, `test_hlr`,
  `test_v2_core`, `test_sketch*`, `test_units_boundary`, …) remain unautomated. That is a fine
  start, but note `test_update_roof.py` fails for environmental reasons (needs a Windows `Z:` path),
  so it should stay out.
- **§3.3.1 / §3.3.2 remain open** (not claimed as fixed): 2D `level_plane` still returns
  `(0.0, elevation)` labelled `"exact"`, and the level **name** fallback is retained (relabelled
  `"repaired"`). `resolve_reference_axis` is still unused in production — its import was dropped
  rather than wired.

## 7. Regression check

Full Python suite (`scratch/test_*.py`, 30 files) at `0e75402`:

- **All pass**, including the previously-crashing `test_container_fidelity.py` (58/58).
- Only `test_update_roof.py` fails — `FileNotFoundError: 'Z:/PROJECTS/...'`, an environment-dependent
  test, unrelated to this work and failing before it too.

`npm run check` → **exit 0**: `check:bus` 37, `check:ui` 130, `check:state` 45, `check:delta` 21,
`check:snap` 21, `check:py` 58/66/32/42/11/41, `tsc --noEmit` clean.

## 8. Recommended follow-ups, in priority order

1. **Fix `reference_key` for unresolved points** — remove `id(ref)`; give references a persisted
   stable id, or keep a deterministic sentinel and stop claiming identity for hint-less points.
2. **Close the lost-dimension path**: surface `lost` dimensions in the contract (don't `continue`
   before attaching `status`), and remove the unconditional `_overall_dimensions` fallback in
   `_annotate_view` (or gate it on `self.dimensions` as `_finish_plan_contract` now does).
3. **Restore a discriminating probe** for the solver's extras-participants behaviour — pin only the
   dragged element and let the extra reach an otherwise-unreachable element (see §5), and add a
   `reference_key` **stability** assertion (copy / round-trip / re-normalize / cross-process) to
   `_probe_references_adversarial.py`.
4. **Fix the three stale citations** and drop the `ReferenceKind` import.
5. Extend `check:py` to the remaining suites that are environment-independent.
