# REVIEW — Gemini's geometric-references refactor (BIMWorks)

**Reviewed artifact:** `github.com/Axotopia/BIMWorks`, branch `main`, HEAD `e4b9dd9`
**Reviewer checkout:** `/home/song/Documents/DSH/axoworks/BIMWorks` (pulled to `origin/main`; tree clean; `planegcs` **installed**)
**Normative input:** `review/IMPLEMENTATION-PLAN-geometric-references.md` (288 lines)
**Date:** 2026-10-15

---

## 0. Verdict

**The refactor is not correctly implemented.** All gates Gemini reported do reproduce, but the gates
are insufficient: the work contains **one hard crash on a path that a pre-existing test already
covered**, one silent data-loss defect, and **three phases that are nominal rather than functional**
(wired in the sense the gates check, unreachable or inert in the sense the plan intended).

| | |
|---|---|
| Reported commits present on `main` | ✅ all six (`008befc`, `cc0ddef`, `47c2fb5`, `f9d4d3b`, `376524c`, `e4b9dd9`) |
| Reported gate numbers reproduce | ✅ essentially all (see §7) |
| Plan implemented as specified | ❌ **no** — see §1 blockers and §3–§6 phase gaps |

**Headline:** `scratch/test_container_fidelity.py` — present in Gemini's *own* baseline table as passing —
**crashes** at `e4b9dd9`. Its section 8 is literally *"legacy v2.1 container still loads and upgrades."*
The refactor broke the read-old migration path the plan (§3.2) explicitly required to keep working.
`npm run check` could never have caught this: it is a JavaScript-only gate.

---

## 1. Blocking findings

### B1 — `NameError` crash: legacy containers can no longer be opened *(regression)*

`backend/ifc_service.py:6623`, in `load_orlt_project`'s legacy (`schema_version != 3`) branch:

```python
for g, o_meta in elements_overlay.items():     # NameError: name 'elements_overlay' is not defined
```

Commit `cc0ddef` (Phase 0/1) deleted the line that defined it while reworking the dimension
normalization in the same hunk:

```diff
-            self.join_policies = self._jsonable(overlay.get("join_policies", {}) or {})
-            self.dimensions = self._jsonable(overlay.get("dimensions", {}) or {})
-            elements_overlay = overlay.get("elements", {}) or {}
+            legacy_dims = self._jsonable(overlay.get("dimensions", {}) or {})
+            self.dimensions = {}
```

`elements_overlay` now appears exactly once in the file — at the consuming line.

**Evidence — runtime repro** (`scratch/_probe_legacy_container_load.py`, legacy `.bimworks` with `schema_version: "2.1"`):

```
post-refactor (e4b9dd9):
  NameError: name 'elements_overlay' is not defined   (ifc_service.py:6623)   exit=7
baseline (651f2c3, same repro):
  LOAD OK -> {"elements_count": 13}   exit=0
```

**Evidence — pre-existing suite, same file at both revisions** (refactor touched neither the test nor
its fixtures):

```
baseline (651f2c3):  RESULT: 58 passed, 0 failed   ALL CONTAINER FIDELITY TESTS PASSED
e4b9dd9:             9. Section 8: legacy v2.1 container still loads and upgrades ...
                     NameError: name 'elements_overlay' is not defined   exit=1
```

This is the exact failure mode the plan warned about in §3.2 (*"existing `self.dimensions` and `.orlt`
files keep loading"*) and §5.2 (ship migration as a migration, not a surprise). Impact is total for
that path: **every `schema_version` < 3 container fails to open.**

### B2 — Legacy load silently discards `join_policies` *(latent, same hunk)*

The same deletion removed `self.join_policies = self._jsonable(overlay.get("join_policies", {}) or {})`.
The legacy branch never assigns `join_policies`, so it is left at its prior value.

**Evidence** — sentinel probe (`scratch/_probe_legacy_join_policies.py`), pre-seeding `join_policies` before load:

```
crash (expected): name 'elements_overlay' is not defined
join_policies after legacy load: {'__sentinel__': {'start': {'mode': 'sentinel'}}}
overlay join_policies was READ?  False
```

Baseline restored `{'g1': {'start': {'mode': 'miter'}}}` from the same container. So **B2 survives fixing
B1** — mitered joins are lost on every legacy load.

---

## 2. How to reproduce

All evidence in this review is reproducible from the repository root at `e4b9dd9` with a clean
tree. The probes below are committed alongside this review; each exits non-zero when its finding
is present, and each prints what it observed.

```bash
# Pre-existing suite that regressed (section 8 = "legacy v2.1 container still loads and upgrades")
.venv/bin/python scratch/test_container_fidelity.py          # -> NameError at ifc_service.py:6623, exit 1

# Committed probes (exit != 0 when the finding is present)
.venv/bin/python scratch/_probe_legacy_container_load.py     # B1  crash   -> exit 7
.venv/bin/python scratch/_probe_legacy_join_policies.py      # B2  join_policies never read -> exit 1
.venv/bin/python scratch/_probe_locked_dimension_undo.py     # P5  dangling constraint_id   -> exit 7
.venv/bin/python scratch/_probe_reference_move_extras.py     # P4  extras inert             -> exit 1
.venv/bin/python scratch/_probe_references_adversarial.py    # P0  key/semantic gaps        -> exit 1
```

---

## 3. Phase 0 — `backend/references.py` (primitive)

Well-structured, and the load-bearing properties hold. Independently verified
(`scratch/_probe_references_adversarial.py`, my own adversarial properties, not the shipped tests):

| Property (plan §4 gate) | Result |
|---|---|
| `normalize_reference` idempotent | ✅ (`n1 == n2 == n3`) |
| `reference_key` order-stable for multi-source | ✅ `intersection:w1#0,w2#0` for both operand orders |
| Multi-source key does not collide with either single source | ✅ |
| `ordinal` participates in identity | ✅ |
| Resolution never returns silent `(0, 0)` | ✅ `lost` + `None` for missing guid/level/point |

Gaps:

- **`reference_key` collapses all unresolved points onto one identity.** Every point reference with no
  hint returns `"point:unresolved"`, so two *distinct* dangling points compare equal. §5.1 warns that
  "getting `reference_key` wrong is how `silent dangling` becomes `silent wrong geometry`", and §5.1
  says Phase 0's gate "is therefore about **key semantics**". This is a genuine (if narrow) key defect.
- **`wall_face_pos` / `wall_face_neg` ignore `ordinal` in resolution.** §3.2's migration table lists
  `ordinal` as "needed for `wall_face_pos`/`wall_face_neg`". The key distinguishes ordinals, but
  `resolve_reference` computes the face from the `kind` sign only — ordinal 0 and ordinal 1 resolve to
  the *identical* point. Identity distinguishes what resolution cannot.
- **`resolve_reference_axis` substitutes an unrelated quantity for a diagonal grid.** For a non-vertical
  grid asked for `x`, the `grid_axis` branch falls through to 2D `resolve_reference`, which returns the
  grid **midpoint**, labelled `"exact"`. Measured: diagonal grid `(0,0)→(10,10)` on `x` → `(5.0, 'exact')`.

---

## 4. Phase 1 — delegation, migration, §3.3 decisions

**Done:** `_resolve_ref_coords` delegates to `references.resolve_reference`; `create_dimension`,
`rebuild_from_overlay`, and the legacy load all normalize through `normalize_reference`; callers
migrated to the outcome-returning API.

**Not done / done differently:**

- **§3.3.1 is not resolved.** The plan flagged that a level resolving to `(0.0, elevation)` anchors every
  witness to X=0, and said this "**Requires a decision**". `resolve_reference` still returns
  `((0.0, elev), "exact")` — measured — so the effective 2D behaviour is *unchanged and still labelled
  `exact`*. The axis form that would fix it returns `ambiguous` for X/Y, but **nothing calls it** (§5).
- **§3.3.2 not followed.** The plan said the level **name** fallback "should be dropped in favour of
  id-only". It is retained at `references.py:228-230`, merely relabelled `"repaired"` instead of
  `"exact"`. Relabelling is a defensible mitigation, but it is a deviation, not compliance.
- **`_resolve_ref_coords` is now dead code that still returns the silent `(0.0, 0.0)`.** Zero callers
  remain (verified across `backend/`, `scratch/`, `src/`), yet the method body ends `return (0.0, 0.0)`.
  The anti-pattern the plan exists to remove is still present in the module, untested and unreachable.
- **Dimension creation invents a value when references are unresolvable.** With `pa`/`pb` `None`, `value`
  stays `None` and `float(value if value is not None else 10.0)` silently produces **10.0 ft**. This is
  more reachable now that resolution can fail.
- **The render contract neither surfaces `status` nor keeps lost dimensions.** `ifc_service.py:6108-6109`
  does `if pa is None or pb is None: continue`, and `dims_out` (6117-6130) has no `status` key. So a
  `lost` dimension is **dropped from the drawing** with no signal, and if that empties `dims_out` the
  code falls back to `self._overall_dimensions(contract)` — auto-generated overall dimension lines
  silently replacing the user's set. Pre-refactor `_resolve_ref_coords` always returned a tuple, so this
  `continue`/fallback interaction is new behaviour.
- Normalization is **copied three times** (≈4642, ≈6537, ≈6600) in near-identical blocks.

---

## 5. Phases 2–5 and the deliverable

### Phase 2 — repaired / ambiguous / lost *(internally recorded, not surfaced)*

`_re_resolve_dimensions_after_move` is wired into `translate_element` behind `if translated:` and does
update values (`test_dimensions_crud.py`: "value updated to 15.0"), so the "wrong number" risk is
addressed server-side. But:

- **`repair_reference` is never called.** "repaired" here means *"both references resolved after the
  move"* — `exact` is never re-reported, and the hint-based repair capability the plan depends on
  (`candidate search within tolerance`) is **never exercised in the move path**. Its only callers are
  the test file. The status is therefore optimistic: a reference that resolved exactly is reported as
  `repaired`.
- **`status` does not reach any client** (§4) — so "surfaced" is internal only. Gemini's phrasing
  "Dimensions update values and **surface** 'repaired', 'ambiguous', or 'lost'" overstates this.
- `dimensions_rev` is bumped only in the success branch (3061), not for `lost`/`ambiguous` — though
  nothing consumes `dimensions_rev` for delivery, so this is cosmetic today.

### Phase 3 — snap provenance *(type fixed, provenance still has no consumer)*

The engine half is correct and the gate genuinely asserts it: `SnapCandidate.sources: string[]` is
populated at every construction site, and `intersection` carries **both** GUIDs
(`sources: ["wall-h","wall-v"]`). But:

- **`PlanViewport2D.tsx:435` still reduces to `snap.point`.** The plan §3.4 required it to "keep the whole
  candidate rather than reducing to `snap.point`". The candidate *is* stored in `activeSnapCandidate`
  state, but that state feeds **only the on-screen snap glyphs** — it never reaches the move path.
- **`.sources` has zero consumers in `src/`** (`grep -rn "\.sources" src/` → no hits outside
  `snapEngine.ts`). The plan's §0 complaint was that `sourceGuid` had zero consumers; `sources` now has
  zero consumers. The stated end goal — "by the time a move reaches the backend as `{dx,dy,dz}`, nothing
  knows what was snapped to" — is **still true**. Drags still call
  `translateElement(guid, dx, dy, 0)` (delta form, no reference).

### Phase 4 — `ReferenceMove` + drag-time extras *(verb correct, reachability and seam semantics weak)*

Correct: `ReferenceMoveParams` registered (`COMMAND_REGISTRY` = **40**, verified); handler resolves both
references and **raises** rather than defaulting to `(0, 0)`; `extras` extends *both* the planegcs and
pure-Python solvers with `align` / `dimension_lock` and dedups coincident pairs; a memento is registered.

Weak:

- **`store.moveReference` has zero callers** (`grep -rn moveReference src/` outside its own definition →
  empty). It is declared in `UI_ACTION_COMMANDS` and calls `dispatchTransaction`, which is *all*
  `check:bus` verifies ("declared but never dispatched" is the only failure it detects). So the gate
  passes at 37 while **no UI interaction can reach `ReferenceMove`** — the same "built, documented and
  unwired" pattern §3.6 told the implementer to avoid. Phase 4's own gate, *"Dragging a constrained wall
  end onto a grid axis holds the relation"*, is therefore not achievable end-to-end.
- **The `extras` seam is inert in the scenario that is claimed to exercise it.** `test_reference_move.py`
  passes `extras=[("align", (grid_guid, w1_guid))]`, but the grid is not in the solve scope, so the extra
  is skipped. Probe (`scratch/_probe_reference_move_extras.py`):

  ```
  affected_guids([w1]) = ['12Wr...', '1NUs...']
  grid in scope? False
  extras apply result: ok= True applied= ['align_e6a7d983']
  ```

  `applied` contains only the **pre-existing persisted** align constraint. The test's "Wall 2 followed
  Wall 1" check is satisfied by `_solve_constraints_after_move`, not by the new extras path. Only step 6
  (a direct `solver.solve(..., extras=...)` call) actually exercises it.
- **The extras pass is ordered backwards relative to its own documentation.** In the handler it runs
  *before* `translate_element`, pinning the dragged element at its **pre-move** coordinate
  (`pins = {src_guid: get_element_coord(...)}`), then the raw delta is applied with no re-solve. §3.6
  documents `extras` as "the delta of an in-progress drag"; a solve that pins the dragged element in
  place is not that.
- **`except Exception: pass`** around the solver pass swallows every failure — precisely what §4.0 says
  never to do ("Never read 'no error' as 'no constraint applied'").
- The `ReferenceMove` memento undoes only `translate_element(-dx,-dy,0)`; any neighbour the extras pass
  moved is not restored.
- `if name not in ("Success", "Converged")` (`constraint_solver.py:280`) widens success acceptance. Not
  requested by the plan and a real semantic change to the solver gate.

### Phase 5 — reference-aware memento *(unlocked case only)*

The dead-dimension predicate now also matches `sources`, and deletion-undo restores `dims_pre`
(`command_bus.py`). `test_transactions.py` = 42/42 ✅ — but it exercises an **unlocked** dimension, so
`constraint_id` is `None` and nothing cascades.

`delete_dimension` also calls `self.delete_constraint(cid)`; the memento restores `dimensions` but **not
`constraints`**. Repro (`scratch/_probe_locked_dimension_undo.py`, locked dimension):

```
dimension: dim_5eba7665  constraint_id: dimlock_d7a147fb
constraint present after create: True   | constraints: ['dimlock_d7a147fb']
after delete -> constraints: []
after undo   -> dim back: True          | constraints: []
restored dimension constraint_id: dimlock_d7a147fb
DANGLING constraint_id: True   (is_locked: True, but no such constraint)
```

After undo the dimension reports `is_locked: True` with a `constraint_id` that no longer exists — a
silently inert lock. This is §3.8's failure mode ("an undo will leave references pointing at
restored-away geometry") in the constraint direction, and Phase 5's gate only half covers it.

### Deliverable — amendment to `IMPLEMENTATION-PLAN-dimension-as-control.md`

Substantive and genuinely useful: §0's premise is corrected (dimension object exists; the gap was
reference identity), §3.1 now depends on this plan's Phase 0, and `ReferenceKind` is extended with the
derived kinds. **But §7.1 ("Re-anchor every `file:line` citation against the current tree") is not
met** — several anchors are stale at the final commit:

| Amendment says | Actual at `e4b9dd9` |
|---|---|
| `self.dimensions` at `ifc_service.py:249` | ✅ 249 |
| `create_dimension` at `:3464` | ❌ **3507** (3464 is inside a constraint-dedup block) |
| `DimensionCreate` verb at `command_bus.py:430` | ❌ 429 |
| overlay persistence at `:6391` / `:6532` | ❌ 6391 is a docstring, 6532 a zipfile branch; dimensions serialize at **6459** (read/normalize at 4698, 6600) |

Also, the amendment documents `repair_reference(manager, ref, candidate_guids=None, tolerance=2.0)`
while the implementation is `repair_reference(manager, ref)` with a hard-coded `tol = 1.0`. Given §5.3's
whole thesis was that stale citations are how the previous plan rotted, repeating that failure mode
matters.

---

## 6. Non-goals — respected

Verified absent: index indirection / reference-remap pass (`grep -iE "remap|replaceElemIds" backend/*.py`
→ only pre-existing SVG path remapping in `hlr_renderer.py`), axis-vs-plane drag classification, and
sketch-mode solver unification. §3.7 ("do not add a third dependency walk") is honoured — still exactly
two (`ConstraintSolver.affected_guids:111`, `DependencyGraph.recompute:160`), and `ReferenceMove` reuses
`affected_guids` rather than inventing a third.

**§4.0 prerequisite is satisfied:** `planegcs` **is** installed in `.venv` (`import planegcs` succeeds),
contrary to the plan's recorded state. Solver-dependent gates are therefore not "measuring the absence".

---

## 7. Gate reproduction (independent)

Every number Gemini reported reproduces, with two methodology notes.

| Gate | Reported | Measured | |
|---|---|---|---|
| `npm run check` | pass | **exit 0** | ✅ |
| `check:bus` | 37/37 | 37 UI actions declared+dispatched | ✅ |
| `check:ui` | pass | 130 checks | ✅ |
| `check:state` | pass | 45 checks | ✅ |
| `check:delta` | pass | 21 checks | ✅ |
| `check:snap` | 21/21 | 21/21 (incl. both-GUID assertion) | ✅ |
| `tsc --noEmit` | clean | silent, 0 `error TS` | ✅ |
| `test_references.py` | 32/32 | 32/32 | ✅ |
| `test_dimensions_crud.py` | 66/66 | 66/66 | ✅ |
| `test_reference_move.py` | 11/11 | 11/11 | ✅ |
| `test_transactions.py` | 42/42 | 42/42 | ✅ |
| `test_dependency_graph.py` | 41/41, p95 3.00 ms | 41/41, p95 **3.50–3.75 ms** (budget 16 ms) | ✅ |
| routes in `backend/main.py` | 61 (≥43) | **57** decorators / **61** `len(app.routes)` | ⚠️ see below |
| `command_bus.py` registry | 40 (≥26) | 40, `ReferenceMove` present | ✅ |

Two corrections to the report:

1. **"Route count: 61" is a different metric from the baseline's 57.** 61 is `len(app.routes)`, which
   includes FastAPI's 4 built-ins (`/openapi.json`, `/docs`, `/docs/oauth2-redirect`, `/redoc`);
   decorator count is 57 — **unchanged** from baseline. Either way ≥ 43, so no gate failure, but the
   baseline→final comparison is apples-to-oranges.
2. **`docs/BASELINE-2026-10-15.md` lists `test_container_fidelity.py` as "15 passed"**; the suite actually
   reports **58** checks, and now crashes. The baseline table did not catch the regression it was
   designed to catch.

**Coverage note.** `npm run check` is JavaScript-only and the plan's gate table lists only two Python
commands (`test_dimensions_crud.py`, plus the extended `check:snap`). The Python suites that *would* have
caught B1 (`test_container_fidelity.py`) are outside every automated gate — which is why "all gates
passed" and "broke the legacy load path" are simultaneously true.

---

## 8. Recommendations, in priority order

1. **Fix B1 and B2** — restore `elements_overlay = overlay.get("elements", {}) or {}` and
   `self.join_policies = self._jsonable(overlay.get("join_policies", {}) or {})` in the legacy branch,
   then confirm `test_container_fidelity.py` returns to 58/58.
2. **Put the Python suites behind a gate** (a `check:py` script) so a JS-only `npm run check` can never
   again certify a refactor that crashes a Python load path.
3. **Either wire `.sources` to the move path or descope it explicitly.** Today Phase 3 changes a type and
   nothing else; `PlanViewport2D` should carry the candidate into the drag/`ReferenceMove` request, or the
   plan should record the consumer as outstanding.
4. **Wire `repair_reference` into the move path, or delete the dead imports and correct the plan.**
   Currently `repair_reference`, `reference_key`, `resolve_reference_axis` (in `ifc_service.py`) and
   `ReferenceKind` (in `command_bus.py`) are import-only.
5. **Decide and document the `level_plane` 2D semantics.** Leaving `(0.0, elev)` labelled `exact` keeps
   the §3.3.1 defect; routing dimension resolution through `resolve_reference_axis` is the plan's own
   suggestion.
6. **Fix the extras pass**: solve against the destination (unpinned dragged element, or post-move
   re-solve), surface failures instead of `except Exception: pass`, and extend the memento to restore
   re-solved neighbours.
7. **Extend the Phase 5 memento to restore cascaded constraints** (or block undo across a locked-dimension
   cascade) so a restored dimension cannot claim `is_locked: True` with no constraint.
8. **Delete `_resolve_ref_coords`** or make it outcome-returning; do not leave the silent `(0.0, 0.0)`
   reachable-but-untested in the module.
9. **Re-anchor the amendment's citations** (§7.1) and reconcile the documented `repair_reference`
   signature/tolerance with the implementation.
10. **Give `reference_key` a distinct identity for unresolved points** (e.g. include `sources` or a
    discriminator) rather than collapsing them to `point:unresolved`.

---

## 9. What is genuinely good

Worth stating plainly, because most of this document is adverse: `backend/references.py` is a clean,
cohesive module with idempotent normalization and a genuinely order-stable, collision-resistant key for
the multi-source case; `resolve_reference` returns outcomes and removes the silent-zero from the
dimension paths that were migrated; the snap engine change is minimal and correctly preserves both
intersection GUIDs; the `extras` seam was extended rather than duplicated (§3.6); §3.7 and the non-goals
were respected; and the amendment to the companion plan is a real re-anchoring effort rather than a
formality. The failure is not design — it is that **the read-old path was edited and never re-run**, and
that three phases were closed on gates that cannot distinguish "wired" from "reachable".
