# REVIEW — Gemini's refactor of `IMPLEMENTATION-PLAN-revit-feel.md`

**Reviewed:** `review/IMPLEMENTATION-PLAN-revit-feel.md` as delivered in commit **`d3d2e9e`** ("docs(plan): refactor revit-feel plan to reconcile status at aa02b07"), 688 → 493 lines, +104/−299.

**Compared against:** the tree at HEAD (`d3d2e9e`, code identical to the `aa02b07` the doc pins to), its own predecessor `438bf28`, and its **sibling refactor** `aa02b07` — `review/IMPLEMENTATION-PLAN-direct-manipulation.md`, same author, same day, committed **one commit earlier**.

**Method:** every load-bearing status claim was re-executed rather than read. `npm run check` run end-to-end; each gate run individually for its count; the eight Python suites the plan names run individually; `COMMAND_REGISTRY` parsed; cited symbols located in source.

---

## 1. Verdict in one paragraph

**The consolidation is editorially the right move and mostly well executed — one §0 with a phase matrix, an open-scope catalog and the ten traps is far better than four stacked dated audit rounds. But it fails the one test it sets itself ("authoritative repository ground truth"), because the numbers it publishes are not the tree's numbers and one gate it marks ✅ is red.** `test_scale_gate.py` — a named gate, cited in §0.1 as "6/6 passed" and in Phase 0.1 as ✅ — **fails at HEAD** (2 of 2 isolated runs; the 196-wall 30 ms guard is exceeded in both). §0.1 also claims "8 automated gates" and "15 Python test suites"; the tree has **9 gates** and **17 suites**, and of the eight Python suites it credits to `check:py`, **six are not run by `check:py` at all** — which is precisely why the red scale gate never broke the green suite. Most damaging, these are not new mistakes: the sibling plan, one commit earlier, names this exact failure pattern in writing ("the gate inventory was missing `check:fit` and miscounted the suites") and records that it was fixed there. `d3d2e9e` re-introduces all of it. Separately, 15 body lines still cite the §0a/§0b/§0c sections this refactor deleted as though they were live, and the two most reusable things in the deleted text — the run-all command and the five methodology rules — were dropped without replacement.

**Recommendation: keep the structure, re-verify the numbers, restore the two deleted operational sections.** Details in §7.

---

## 2. What it gets right — credit before criticism

**2.1 The structural consolidation is a real improvement.** 688 → 493 lines with no loss of the *analysis*. The old file stacked five overlapping status artifacts (a round-4 banner, §0a handoff, §0b/§0c/§0d verification passes) each of which partially superseded the last, and required a reader to know that §0c outranked §0b for counts. One §0 with §0.1–§0.5 is unambiguous. This is the correct shape and the sibling plan uses the same one.

**2.2 §0.3 "Catalog of Remaining Open Scope" is new and genuinely useful.** Seven open items, one place, each with the file that holds it. The predecessor scattered these across §0a.4, §0a.5 and four audit corrections. This is the single best addition in the commit.

**2.3 All ten engineering traps survive, faithfully.** §0a.3 → §0.4 loses formatting but no substance: `cached_verts` unit, `metres_per_unit` vs `METRES_PER_FOOT`, no-convert-on-read, conservative caches, `mesh_hlr` `cut_z`, grep-before-delete, per-mesh occluder bounding, absolute-not-share guards, stale `.pyc`, `recompute_wall_joins` widening. Verified item-by-item against the deleted text.

**2.4 The headline status promotion is correct.** §0/§0.2/§3 promote Phase 3.5.1 from "40 of 50" to "50 of 50, 0 fallback". **I verified this three ways**: `COMMAND_REGISTRY` has exactly **50** entries; `_probe_engine_smoke.py` check G reports "0 of 50 commands fall back" (probe 7/7); and `scripts/check-python-suites.mjs` — a *wired* gate — passes `test_memento_reversibility.py` (35 checks), which explicitly covers `ConstraintEqualize` and the `SketchCurveSetSlope`/`pitch` case. The promotion is justified. (The *citation* is not — see §3.4.)

**2.5 Deletion judgment is sound where the material is genuinely obsolete.** §0a.4 was a design-decision memo for Phase 1.3c choosing a staleness key for the prepared-geometry cache ("object identity vs explicit revision signature"). 1.3c has landed, so the memo is dead weight. Same for §0a.5 ("what is *not* next"). Removing both is correct, not lossy.

**2.6 Individual verified counts are accurate.** Measured at HEAD: `check:ui` **132** ✓, `check:state` **45** ✓, `check:delta` **21** ✓, `check:snap` **34** ✓, `check:interaction` **37** ✓, `check:pushpull` **17** ✓, bus parity **47 actions** ✓. `tsc --noEmit` clean ✓. The per-suite numbers in §0.2 that I could check independently (`dimensions_crud` 201, `trim_split_gate` 30, `type_layer_gate` 34, `units_boundary` 27, `mesh_hlr_incremental` 11, `pure_python_solver` 13, `sheets_pdf` 95) are all correct.

**2.7 Commit citations are all valid.** All 13 hashes resolve (see §5.5).

---

## 3. Corrections that change the conclusion

### 3.1 A gate the plan marks ✅ is red at HEAD — `test_scale_gate.py`

§0.1 states:

> `scratch/test_scale_gate.py`: 6/6 passed (passes scaling shape & cache guards; 100 walls at 8.2 ms < 16 ms budget; 196 walls within 30 ms threshold).

Phase 0.1's row marks the gate **✅ `fa9446a`**, and the phase summary line asserts "0.1 scale gate ✅". Measured at HEAD, twice, in isolation:

| Run | Result | 100 walls | 196 walls | 484 walls |
|---|---|---|---|---|
| 1 | **4 passed, 2 failed** | 16.5 ms (1.03×) ❌ | 58.4 ms (3.65×) ❌ | 41.1 ms (2.57×) |
| 2 | **5 passed, 1 failed** | 9.4 ms (0.59×) ✅ | 34.1 ms (2.13×) ❌ | 85.2 ms (5.33×) |

Both runs exit 1. The 196-wall guard fails in both (58.4 ms and 34.1 ms against a 30 ms threshold), and the 100-wall 16 ms budget fails in one. The plan's quoted figures ("100 walls at 8.2 ms"; "196 walls within 30 ms threshold") are not reproducible.

**Why this hid.** `test_scale_gate.py` is **not wired into any runner.** `scripts/check-python-suites.mjs` does not list it, and nothing else invokes it. `npm run check` therefore exits 0 while a gate the plan calls verified is failing. That is the mechanism, and it is the same mechanism §3.2/§3.3 describe.

**Scope note.** Timing gates are load-sensitive and the 100-wall case is at the edge (16.5 ms vs 16 ms) — that individual assertion is arguably flaky rather than regressed. But the 196-wall case failed in a quiet isolated run at 34.1 ms, and the *slice* column at 484 walls now reads 26–55 ms against the plan's recorded 19.3–22.0 ms. This is at minimum an unverified claim and at most a real regression; either way the ✅ is unsupported and the "repository is healthy" framing in §0.3 is contradicted by the plan's own instrument.

### 3.2 The gate inventory is wrong in exactly the way the sibling plan had just corrected

§0.1: "`npm run check` exits 0 with **924+ assertions across 8 automated gates**". `package.json` chains **nine** gates:

```
check:bus → check:ui → check:state → check:delta → check:snap
          → check:interaction → check:pushpull → check:fit → check:py → tsc --noEmit
```

**`check:fit` (`scripts/check-fit-extents.mjs`, 28 checks, passing) is missing from the enumeration entirely.** §0.1 lists seven JS gates and then `check:py`, which is how it arrives at "8".

This matters beyond arithmetic, because the sibling plan — committed at `aa02b07`, one commit before `d3d2e9e` — opens with this:

> **Corrections in the pass following the `3dd3e80` reconciliation** (this is the third time an over-claim has been found at a gate boundary, so the pattern is worth naming): the gate inventory was missing `check:fit` and miscounted the suites; … The lesson is narrow and repeatable: **a gate that reads source text or declares intent cannot find a command that runs and then does the wrong thing.**

and its §0.1 is titled "Full Gate Suite Status — `npm run check` exits 0 with **all 9 gate suites**", with a complete table including **Fit Extents 28 checks**.

So the same author, in the same session, wrote down the defect, fixed it in one plan, and reproduced it in the next. `d3d2e9e` is now the outlier of the pair.

### 3.3 "15 Python test suites, 694+ checks" is wrong, and six of the eight listed suites are not gated

§0.1 claims "plus **15 Python test suites**" and then "**Python Test Suites (`check:py`):** 15 suites, **694+ checks** passed". The runner has **17 suites** and they total **774 checks**:

```
solver_capability 17 · container_fidelity 68 · dimensions_crud 201 · references 32
transactions 42 · reference_move 11 · dependency_graph 41 · drag_session 27
drag_join_deferral 11 · memento_reversibility 35 · wall_grips 49 · value_entry 15
snap_engine 34 · grips_beyond_walls 71 · validity_predicates 63 · face_pushpull 50
_probe_engine_smoke 7                              = 17 suites / 774 checks
```

Worse, the eight suites §0.1 presents as `check:py`'s content are not that set. Cross-referencing the plan's list against `check-python-suites.mjs`'s `SUITES` array:

| Suite named in §0.1 | Wired into `check:py`? |
|---|---|
| `_probe_engine_smoke.py` | ✅ yes |
| `test_dimensions_crud.py` | ✅ yes |
| `test_pure_python_solver.py` | ❌ **no** |
| `test_type_layer_gate.py` | ❌ **no** |
| `test_session_undo_memento.py` | ❌ **no** |
| `test_trim_split_gate.py` | ❌ **no** |
| `test_mesh_hlr_incremental.py` | ❌ **no** |
| `test_scale_gate.py` | ❌ **no** — and it is the red one |

Six of eight. Meanwhile the wired set contains eleven suites the plan never names (drag session, drag join deferral, memento reversibility, wall grips, value entry, snap engine, grips beyond walls, validity predicates, face pushpull, references, transactions, dependency graph …). There are **40** `scratch/test_*.py` files on disk; **17** are gated; the plan's "verified net" is a hand-assembled list that is neither the gated set nor the on-disk set, but is presented as the thing `npm run check` runs. This is the §20.2 failure mode ("a check that cannot fail is a defect") applied to the plan's own inventory.

### 3.4 The `924+` total contradicts the breakdown printed directly beneath it

Summing §0.1's *own* enumerated gates: 47 + 132 + 45 + 21 + 34 + 37 + 17 = **333**, plus Python **774** = **1107** (or 1027 if one uses the plan's stated 694). Add the omitted `check:fit` 28 and it is **1135**. The real net at HEAD is:

> **nine gates + `tsc`: bus 47 · UI-P0 132 · state 45 · delta 21 · snap 34 · interaction 37 · pushpull 17 · fit 28 · Python 774 across 17 suites.**

"924+" is a carry-over from the deleted §0c, where it was already internally inconsistent (its own numbers summed to 971), and it was then published beside a *different* breakdown.

### 3.5 Probe check G is declaration-only and cannot support the claim it is cited for

§0.1 and §3.5.1 cite "probe check G (7/7)" as the evidence that 50/50 commands have command-scoped mementos. The probe's check G is a **static regex over source text**:

```python
body = src[src.index("def _execute_with_memento"):src.index("def execute_transaction")]
covered = set(_re.findall(r'cmd_name == "([A-Za-z]+)"', body))
```

It proves every registered name *appears in a comparison*; it cannot prove the command executes correctly or that undo restores state. The sibling plan says exactly this — "§0.3.3's probe-G bullet claimed behavioural verification that no test performed" — and that closing the gap "surfaced two real defects that the declaration-only check had been hiding: `ConstraintEqualize` could not execute at all, and `SketchCurveSetSlope`'s undo left `pitch` stale."

The good news: the underlying **status is true** (§2.4). The defect is that the revit-feel plan (a) cites the weak gate as the evidence and (b) **omits the strong one** — `test_memento_reversibility.py` (35 checks), which is wired, passing, and is what actually covers `ConstraintEqualize` and the `pitch` case. Cite the gate that can fail.

---

## 4. Hygiene defects introduced by the refactor

### 4.1 Fifteen body lines cite deleted sections as live provenance

The refactor deletes §0a, §0b, §0c and §0d and folds them into §0. §0's preamble correctly names them as historical. But the body still uses them as current citations:

| Line | Citation | Resolves to |
|---|---|---|
| 162 | "superseded — §0c: `DI` is `implemented: true`" | nothing |
| 251, 255, 303, 311, 330, 346, 366, 372 | "(corrected by §0c)" ×8 | nothing |
| 270, 275, 285, 292, 427 | "(verified §0b)" / "§0b" ×5 | nothing |
| 281 | "see §0a.2" | nothing |

Fifteen lines, no exceptions. Two of them (346, 366, 372) cite "924 at `7251a44` — §0c" in the Phase 4/6/7 verification lines, so the stale total and the dead reference travel together. A reader who follows any of these lands on nothing, and the whole point of the refactor was to make provenance navigable.

### 4.2 Three present-tense line citations have drifted

The plan states current status with line numbers. Three no longer point where claimed:

| Cited | Claim | Actual |
|---|---|---|
| `ifc_service.py:3026` | `scope = solver.affected_guids([moved_guid])` (cited twice, §1.4 and §0.2 Phase 1) | **`3060`** |
| `PlanViewport2D.tsx:611` | `createDimension` | **`626`** |
| `PlanViewport2D.tsx:1295` | dimension overlay render | **`1298`** |

Verified correct, for contrast: `toolCaptions.ts:44` (`DI implemented: true`), `App.tsx:53`/`:62` (Ctrl+Z/Y), `constraint_solver.py:128-150`.

The file is also now at `src/components/drafting/PlanViewport2D.tsx`; the plan cites it bare. Note the sibling plan carries an explicit policy for this — "**Line numbers are pinned to `7a36697`** unless a citation says otherwise. They will drift; cite the symbol when the two disagree." The revit-feel plan adopts no such policy while using more line citations than the sibling does.

### 4.3 Content deleted with no replacement

| Deleted | Why it mattered |
|---|---|
| **§0a.1's run-all commands** (`for f in scratch/test_*.py; do … done`, then `npm run check`, then the scale gate) | This was the only instruction that ran the **un-wired** suites. Combined with §3.1/§3.3, deleting it removed the exact procedure that would have caught the red scale gate. The surviving §0.1 describes the net but never says how to run it. |
| **§0a.6's five methodology rules** | "Assert that a gate can fail"; "compare incremental results against the slow-but-correct version, exactly"; "ask whether the gate is measuring a stale premise"; "verify by executing, never by reading". §0.4 keeps the ten *traps* but drops the *method*. Given §3.1–3.5 these are the most relevant paragraphs in the document. |
| **Round-4 banner's platform caveat** | "29 passed, 0 failed on Windows (1 external path fail on Linux: `test_update_roof.py` requiring `Z:`)". §0 now claims a clean net with no OS qualification. On this Linux workstation that expected failure has no explanation, and the reader cannot tell it from a real one. |
| **§0a.2's per-N table** | Partly redundant — the budget ratios survive in Phase 1's "Actual at `e3216fe`" paragraph. But the sibling-by-sibling comparison ("629 ms at 196 walls (39.3× over)" at session start, and the note that the global join pass is still 83/264 ms) is gone, and with §3.1 showing the numbers have moved, having the historical table in-document would have made the divergence visible. |

### 4.4 Minor: the dimension-CRUD count is stated twice, differently

§0.1 says 201/201 (correct — I measured 201). The Phase 2 preamble still says "**190 checks at `ec2c99c`**" with no pointer to the current figure. Defensible as historical framing, but it reads as a live count in a section whose status line is present-tense.

### 4.5 Minor: the probe's check-F message is stale, and the plan is right

The plan's Phase 3 row asserts "`TR`, `SL`, `SO`, `DI`, `SEC` live". I checked this expecting an over-claim, and it holds: `Ribbon.tsx:886`/`:894` pass `notYet('SEC')`/`notYet('EL')`, but `notYet` is *conditional* (`isToolImplemented(tool) ? undefined : 'Not available yet…'`), and `toolCaptions.ts` marks both `implemented: true` — so both buttons are enabled and fall through to `setActiveTool(tool)` (`Ribbon.tsx:270`), with the two-click gesture handled at `PlanViewport2D.tsx:642`. `useBimStore.ts:1977` routes section/elevation views to `/api/view/2d`. **The stale text is the probe's own check-F message** ("the UI has no SEC renderer and no elevation tool, so this is not reachable from the app"), which contradicts the plan and the code. Worth fixing in `_probe_engine_smoke.py`, since the plan cites that file.

### 4.6 Not defects — checked and cleared

- **All 13 cited commit hashes exist** and match their described work: `318ce26`, `e3216fe`, `6fa4f73`, `ec2c99c`, `7251a44`, `aa02b07`, `b6b3cdd`, `73b7dbb`, `cc213fc`, `48ad6be`, `fa9446a`, `d54f9b1`, `3762c0c`.
- **§2b's archive links resolve**: `archive/IMPLEMENTATION-PLAN-dimension-as-control.md` ✓, `archive/IMPLEMENTATION-PLAN-geometric-references.md` ✓. §0c's dead-link bug (fixed at `d54f9b1`) did not return.
- **`§17` / `§19` / `§20.1` references are legitimate**: they are v0.2 numbering, and `docs/SPECIFICATION-v0.3.md` §29 is literally "Amendments to §19 and §20", with v0.3 incorporating v0.2 by reference (`docs/REFACTOR-PLAN.md:4`).
- **`test_session_undo_memento.py` is green** at 12/12 with 7.62 ms/tx and 1.07 MB peak — better than the plan's quoted 9.46 ms/tx and 1.06 MB.
- **The doc's `aa02b07` pin while shipping in `d3d2e9e`** is the repo's normal convention (pin to the verified tree) and is harmless here: the commit is docs-only, so no behavioural claim is affected.

---

## 5. Process against `GEMINI.md`

`GEMINI.md` sets the contract: no blind edits, targeted precision ("do not rewrite whole files when small refactors suffice"), and **"Validate Every Change … run affected unit tests or verification scripts"**; it also requires reading `docs/REFACTOR-PLAN.md` and completing its §2 Baseline first.

- **Targeted precision:** 403 of 688 lines changed (59%). For a consolidation that is arguably justified — a merge of five overlapping sections is not a "small refactor" — but it is a rewrite-in-place, not the surgical edit the guideline prefers.
- **Validation:** this is the substantive miss. The change is *entirely* assertions about gate state, and the step that would have validated it — running the suites the plan names — is the step that was skipped. That is §3.1–3.3 in one sentence.
- **Baseline-first:** `d3d2e9e` is a single docs-only commit; there is no preceding baseline commit for it. Fair to note, but this guideline is aimed at code refactors and I would not press it.
- **The repo already knows better.** The sibling plan's §0 preamble names the pattern and the lesson. The revit-feel refactor did not carry that lesson across the (one-commit) gap between the two documents.

---

## 6. What would change my mind

- **`test_scale_gate.py` green on a quiet machine** at the plan's stated figures (≤16 ms at 100, ≤30 ms at 196). My two runs failed, but this is a latency gate and I ran it on a workstation that had just executed the full 17-suite check. If it passes reproducibly on an idle host, §3.1 collapses to "unverified at write time" rather than "wrong". It would still need wiring into `check:py`.
- **Evidence that the six un-wired suites were run and passed at `aa02b07`** (a captured log, not a claim). That would not fix §3.2/§3.3, but it would mean the *statuses* are right and only the *inventory* is wrong.
- **A reason the sibling plan's corrected "9 gates / 17 suites" figure does not apply here** — e.g. if the two documents deliberately count different things. I found no such statement in either file.

---

## 7. What to change, in order

1. **Re-run `test_scale_gate.py` on an idle host. Then either fix the 196-wall regression or correct §0.1 and Phase 0.1 to say the gate is currently red.** Do not leave a red gate marked ✅ in the document that calls itself ground truth.
2. **Wire the six orphaned suites into `scripts/check-python-suites.mjs`** (`test_scale_gate`, `test_trim_split_gate`, `test_type_layer_gate`, `test_session_undo_memento`, `test_mesh_hlr_incremental`, `test_pure_python_solver`, plus `test_units_boundary` and `test_sheets_pdf`, which the plan also cites). This is the root cause of §3.1: the plan leans on gates nothing runs.
3. **Replace §0.1 with the sibling plan's §0.1 table.** 9 gates, 17 Python suites, `check:fit` included, a real total (1135), one row per gate. Keeping the two plans' inventories identical stops them drifting apart again.
4. **Fix the 15 dangling `§0a/§0b/§0c` references** — mechanical; either inline the fact or point at §0.2/§0.3.
5. **Add a line-number drift disclaimer** and re-pin the three stale citations (`ifc_service.py:3026`→`3060`, `PlanViewport2D.tsx:611`→`626`, `:1295`→`1298`). Cite symbols where the two disagree.
6. **Restore §0a.1's run-all command block** (updated to include `test_scale_gate.py` and the other un-wired suites) and **§0a.6's five methodology rules** as §0.6/§0.7. Also restore the Linux `test_update_roof.py` caveat.
7. **Re-cite the 3.5.1 evidence**: keep probe check G but label it declaration-only, and add `test_memento_reversibility.py` (35 checks) as the behavioural gate — it is already green and wired, and it is what actually proves the claim.
8. **Fix the probe's stale check-F message** in `scratch/_probe_engine_smoke.py` (sections and elevations *are* reachable: `useBimStore.ts:1977`, `Ribbon.tsx:270`, `PlanViewport2D.tsx:642`).

---

## 8. Residual unknowns

- **Whether the 196-wall figure is a regression or an environment artefact.** I measured 34.1–58.4 ms against a 30 ms guard twice, and the 484-wall *slice* at 26–55 ms against the plan's recorded 19.3–22.0 ms. I did not bisect. `git log` between `e3216fe` and HEAD would settle it; so would a quiet-host run.
- **What the un-wired suites actually reported at `aa02b07`.** I measured them at HEAD, where all but the scale gate pass. I cannot say whether the plan's `aa02b07` figures were accurate *when written*; I can only say six of them were never gated and one is red now.
- **Whether "924" ever had a reproducible derivation.** It does not match §0c's own breakdown (971) or §0.1's (1027/1107). I treated it as an unsourced carry-over.
- **Whether the sibling plan's §0.1 `test_validity_predicates.py` (63)** is the same file as the wired `test_validity_predicates.py`; it passed 63 in my run, so the two agree.
- **Timing-gate variance in general.** `test_scale_gate.py` asserts absolute latency on a shared workstation under a concurrent full-suite run. My two isolated runs disagreed on the 100-wall assertion (16.5 ms fail, 9.4 ms pass), which is itself a §20.2-adjacent problem: an assertion that flips at the boundary is not a reliable gate even when the code is unchanged.
