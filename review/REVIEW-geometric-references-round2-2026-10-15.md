# REVIEW — Gemini's Round 2 fixes (`784f42f`)

**Reviewed commit:** `784f42f` — *"fix(references): address Round 2 review findings"*
**Parent:** `20ce6a8` (my Round 2 review, `REVIEW-geometric-references-fixes-2026-10-15.md`)
**Checkout:** `/home/song/Documents/DSH/axoworks/BIMWorks`, `main`, tree clean
**Date:** 2026-10-15

---

## 0. Verdict

**All four reported Round 2 items are addressed correctly, and I could not falsify any of them.**
No regressions. Two residual gaps remain, both minor and neither blocking — one is a documentation
overclaim, the other is the unfixed half of a previously-reported finding.

| Round 2 item | Status |
|---|---|
| 1. P0 `reference_key` non-determinism | ✅ **fixed** — determinism restored, verified cross-process |
| 2. Overall-dimensions fallback + `status: "exact"` hardcode | ✅ **fixed** — wrong-dimension substitution eliminated, status now resolved |
| 3. Discriminating extras probe | ✅ **fixed** — verified by patch-out (now fails when the solver change is removed) |
| 4. Stale citations + unused `ReferenceKind` | ✅ **fixed** — all anchors verified against the tree |
| Regression check | ✅ full 30-suite Python run + `npm run check` exit 0 |

**Residual (non-blocking):**
- `reference_key`'s docstring still claims **"collision-resistant"**, which is false for hint-less
  points under the new sentinel. The behaviour is correct-ish and now explicitly asserted; the
  *prose* is the overclaim.
- A `lost` dimension is still **not surfaced** to the client. The wrong-dimension substitution is
  gone (the important half), but the contract returns `dimensions: []` rather than an entry carrying
  `status: "lost"`.

---

## 1. Item 1 — P0 determinism: ✅ fixed

```python
# backend/references.py
if kind == "point":
    pt = norm.get("hint", {}).get("point")
    if pt and len(pt) >= 2 and pt[0] is not None and pt[1] is not None:
        return f"point:{float(pt[0]):.4f},{float(pt[1]):.4f}"
    uid = norm.get("id") or norm.get("guid")
    if uid:
        return f"point:unresolved:{uid}"
    return "point:unresolved"
```

`str(id(ref))` is gone. My stability probe now passes every property, including the cross-process
check that the address-based key could never satisfy:

```
  OK   same object is stable
  OK   equal VALUES compare equal (dedup/equality) | point:unresolved vs point:unresolved
  OK   stable across copy.deepcopy
  OK   stable across a save/load (JSON) round-trip
  OK   stable across re-normalization (as create_dimension does)
  OK   stable across a separate process | this=point:unresolved other=point:unresolved

reference_key is deterministic and stable for unresolved points
```

This is option (b) from my Round 2 review — *"keep a deterministic sentinel and document that
hint-less points are not identity-bearing"* — and the probe now asserts it deliberately
(`key_unres == "point:unresolved"`, plus `points with distinct guid/id keep distinct identity`).

### Residual: the docstring still overclaims

`backend/references.py:135-141` is unchanged:

```
Returns an order-stable, collision-resistant canonical string key.
```

Two structurally identical, semantically distinct hint-less points now both return
`"point:unresolved"` — they collide by construction. Since `reference_key` still has **zero production
consumers**, nothing is broken today, but this is the sentence the next caller will read before
writing a dedup. My Round 2 review accepted option (b) *on the condition that it is honest and
documented*; the probe documents it, the function does not.

**Suggested:** replace "collision-resistant" with an explicit note that identity requires `guid`/`id`
and that hint-less points share one sentinel by design.

## 2. Item 2 — render path and initial status: ✅ fixed (one half outstanding)

Both changes verified independently.

**`create_dimension` no longer hardcodes `status: "exact"`** — it now derives from resolution:

```
  healthy      -> status: exact
  ghost refs   -> status: lost
  name-fallback-> status: repaired
```

**The wrong-dimension substitution is gone.** Through the real entry point (`render_2d_view`):

```
  with only a LOST dimension:
    contract dims: [] (0)
    auto overall dims substituted? False      <-- was True before this commit
  model with NO authored dimensions:
    contract dims: 2 (ids: [None, None])      <-- default overall dims preserved
  with a healthy dimension:
    dims: [('dim_e1f63d2b', 'exact')]
```

The `_annotate_view` guard (`and not getattr(self, "dimensions", None)`) is the right place, and the
fallback still fires for models that genuinely have no authored dimensions — so the fix does not
regress the default-dimension behaviour.

### Residual: a `lost` dimension is still invisible to the client

The contract returns `dimensions: []`. There is no entry carrying `status: "lost"`, because lost
dimensions are still `continue`d *before* the `status` field is attached:

```python
pa, out_a = resolve_reference(self, ref_a)
pb, out_b = resolve_reference(self, ref_b)
if pa is None or pb is None:
    continue                      # <-- lost dims never reach the status field
```

Gemini's own summary states *"returns `dimensions: []` with `status: 'lost'`"* — those two cannot
both hold: if the list is empty, no status travels with it. The `status: "lost"` exists only in
`self.dimensions` / the persisted overlay, not in the render contract.

Severity is **lower** than the original finding: the user's dimension no longer silently turns into
*different* dimension lines (which was actively misleading). It now silently disappears. But plan
§5.2's intent — *"that is the point, but it should be communicated as a migration, with a triage
pass, not shipped as a surprise"* — still is not met, and Round 2 recommendation #2 asked for
exactly this half ("surface lost dimensions in the contract; don't `continue` before attaching
`status`").

## 3. Item 3 — discriminating extras probe: ✅ fixed

The probe was rewritten to the scenario I used to isolate the solver change: pin only `w1`, with
`w3` unpinned and reachable **only** through `extras`. I re-ran my patch-out test — removing the
solver's extras-participants block now makes the probe fail, which it did not before:

```
patched out the "extras participants" block in constraint_solver.solve()
  affected_guids([w1]) = ['199I88CO…', '2lXawBD…']
  w3 in initial scope? False
  extras apply result: ok = True applied: ['align_6fb403b3']
  drag-time extra actually applied? False
  exit=1                        <-- correctly detects the removal
```

The assertion is also stricter than before (`c == "extra:align"` rather than a `startswith`). This
closes the coverage gap I raised.

## 4. Item 4 — citations and unused import: ✅ fixed

- `ReferenceKind` removed from `backend/command_bus.py` (verified: no occurrences).
- `self.dimensions` cited at `ifc_service.py:247` → **line 247 verified**.
- Normalization on load cited at `:4718-4733` / `:6621-6636` → the `normalize_reference` call sites
  are **4729/4731/4733** and **6632/6634/6636**, both bracketed by the cited ranges. Accurate.

The three anchors I flagged in Round 2 are all correct now.

## 5. Gates and regressions

`npm run check` → **exit 0**:

```
check:bus    37/37 UI actions declared and dispatched
check:ui     130 checks passed
check:state  45 checks passed
check:delta  21 checks passed
check:snap   21 passed, 0 failed
check:py     58 / 66 / 32 / 42 / 11 / 41  (all "0 failed")
tsc --noEmit clean (0 errors)
```

All six committed probes exit 0.

Full Python suite (30 files): **no new failures**. Only `test_update_roof.py` fails —
`FileNotFoundError: 'Z:/PROJECTS/…'`, environmental, pre-existing, unrelated.

One reporting note: the drag figure is quoted as **p95 2.95 ms**; I measure **p95 3.52/3.71 ms**
across runs. Timing variance on this host, well inside the 16 ms budget — not a concern, just not a
reproducible number.

## 6. Minor / housekeeping

- **My own probe docstring is now stale.** `scratch/_probe_references_adversarial.py` still says the
  stability probe *"is expected to fail until that is fixed"* — it passes now. That bullet is mine
  from Round 2 and should be retired.
- `check:py` remains 6 of ~30 suites (`test_wall_joins*`, `test_hlr`, `test_v2_core`, `test_sketch*`,
  `test_units_boundary`, … still unautomated). Fine as a start; `test_update_roof.py` must stay
  excluded for now.
- §3.3.1 / §3.3.2 of the geometric-references plan remain open (2D `level_plane` still returns
  `(0.0, elevation)` labelled `"exact"`; level **name** fallback retained). Not claimed as fixed in
  either round — carried forward.

## 7. Recommendation

Round 2 is good work and I have nothing blocking. Two small follow-ups, in order:

1. **Surface lost dimensions** — include them in the contract with `status: "lost"` instead of
   `continue`-ing past them, so the client can act on §5.2's migration rather than seeing an empty
   list. (The harder half — no wrong-dimension substitution — is already done.)
2. **Correct the `reference_key` docstring** — drop "collision-resistant" and state that identity
   requires `guid`/`id`, with hint-less points sharing one deterministic sentinel by design.

Both are small, self-contained, and neither needs a design decision.
