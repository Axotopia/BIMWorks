# BIMWorks — Refactor Plan

**Objective owner:** this document. **Rules of engagement:** [`GEMINI.md`](../GEMINI.md).
**Normative contract:** [`docs/SPECIFICATION-v0.2.md`](SPECIFICATION-v0.2.md).
**Sequencing context:** [`docs/IMPLEMENTATION-PLAN-2026-10-14.md`](IMPLEMENTATION-PLAN-2026-10-14.md).

---

## Read this first

Read, in this order, before touching anything:

1. `GEMINI.md` — the rules. This plan does not replace them; it supplies the repo-specific detail
   they cannot know.
2. `docs/SPECIFICATION-v0.2.md` §6.3 (post-commit protocol) and §6.4 (instrumentation). These are
   the requirements this refactor satisfies.
3. `docs/IMPLEMENTATION-PLAN-2026-10-14.md` §0.1 (how this repo's findings are verified) and the
   N10 row in §0.

**What this plan is:** one scoped architectural refactor, broken into work items that are each
independently verifiable, with exact commands and expected output for every gate.

**What this plan is not:** a feature request, a redesign, or a licence to improve things you notice
along the way. §9 lists what is deliberately out of scope. If you find a real defect outside the
scope, record it in the benchmark log (§8) and leave the code alone.

---

## 1. How this plan slots into GEMINI.md

| GEMINI.md phase | What it means here |
|---|---|
| Phase 1 — Discovery & Dependency Mapping | **§2 Baseline.** Do not skip it, and do not start editing until it is committed. |
| Phase 2 — Plan & Approval | Fill in §3.3's work-item table with the **actual** file paths and symbols you found. Show it before editing. |
| Phase 3 — Incremental Execution | D1…D9, one at a time. Run the affected gate after **each**, not at the end. |
| Guardrail "no speculative dependency changes" | You may add **no** package. If you believe you need one, stop and record why in §8 instead. |

This plan adds three things GEMINI.md leaves open: **exact commands**, the **expected output** of
each, and the **traps** — the failure modes that have already happened in this repository (§4).

---

## 2. Baseline — before any edit

Create `docs/BASELINE-YYYY-MM-DD.md` and commit it **on its own**, before the first code change. It
is what makes every later claim checkable, including your own.

### 2.1 Capture the gate baseline

```bash
npm run check
```

Record the **exact** output. It must read, today:

```
24 UI actions declared and dispatched through the bus
executeTransaction call sites: 2, dispatchTransaction call sites: 24
BUS PARITY GATE PASSED: UI mutations route through the CommandBus
UI-P0 GATE PASSED — 130 checks
STATE-BUNDLE GATE PASSED — 30 checks
```

and `tsc --noEmit` clean. `npm run check` must exit 0. If it does not, **stop and report** — you
have inherited a broken tree, and no later measurement means anything.

> The UI gate makes **real HTTP calls** to the engine. Start the backend first (§4, T8).

### 2.2 Capture the engine-suite baseline

```bash
for f in scratch/test_*.py; do echo "== $f"; python "$f" 2>&1 | tail -3; done
```

Record each suite's result. **Four failures in `test_dependency_graph.py` are pre-existing**:
`planegcs` is declared in `requirements.txt` but not installed, so the constraint solver is
unavailable. This has been verified against a pristine checkout. See T7.

### 2.3 Capture the API and command invariants

```bash
grep -c '^@app\.' backend/main.py          # expect 43
grep -c '^\s\{4\}"[A-Z]' backend/command_bus.py | head -1   # expect 26 registry entries
```

Record these numbers. They are invariants, not trivia: see T1 and T2.

### 2.4 Capture the latency baseline — honestly

`src/store/useBimStore.ts` already records two numbers separately, exposed at runtime as
`globalThis.__bimworksRefresh`:

- `client.p50` / `client.p95` — **interaction latency**, what a user waits for
- `engine.p50` / `engine.p95` — engine-side compute only, transport excluded

**Never report one as the other.** A previous figure of 4.9 ms was published as the wall-drag result
while measuring only in-process recompute — about a tenth of the real wait. Record both, plus the
model you measured on and how many edits.

### 2.5 Confirm the revision source

The delta protocol needs a monotonic revision. Candidates: the transaction journal's own ordinal, or
a dedicated counter on the engine. Inspect `backend/command_bus.py` — the journal is
`self.journal: List[Dict]` appended in `execute_transaction` (around line 497) and returned by
`get_journal` (line 550). Determine the field that is monotonic and state it in your plan.

---

## 3. The refactor

### 3.1 The problem, as measured

Every committed edit triggers a **full-model refetch**. `executeTransaction` used to await seven
requests in series; it is now one `GET /api/state` bundle, but the bundle is still the whole model.
So an edit's cost is proportional to **model size**, not to **what changed** — which is why the
spec's 2,000-element and 16 ms budgets are unreachable on this architecture.

`docs/IMPLEMENTATION-PLAN-2026-10-14.md` records this as **N10 — "Still open, unchanged"**. The
engine code says so itself: *"This does not implement deltas yet."*

`SPEC.md` §3.2 has always required the opposite: *"frontend subscribes to delta events."*

### 3.2 The contract — implement this, do not redesign it

Add `since` to the existing endpoint. **`GET /api/state` without `since` must keep working exactly as
it does now** (a full bundle) — that is the backward-compatible path and the fallback.

```
GET /api/state?since=<rev>&cut_elevation=..&level_id=..[&view_type=..&top=..&bottom=..&view_depth=..]
```

**Response A — nothing changed. This must be cheap; it is the common case.**

```json
{ "rev": 42, "unchanged": true }
```

**Response B — a delta.**

```json
{
  "rev": 43,
  "base_rev": 42,
  "unchanged": false,
  "upsert_meshes": [ { "guid": "...", "ifc_class": "...", "params": { } } ],
  "remove_guids": [ "..." ],
  "project": null,
  "constraints": null,
  "wall_joins": null,
  "slice2d": null,
  "journal_append": [ { } ],
  "errors": {},
  "timings": { },
  "engine_ms": 0.0
}
```

**Response C — resynchronise.** When `since` is unknown, gapped, ahead of the engine, or from before
a restart:

```json
{ "rev": 43, "unchanged": false, "full": true,
  "project": { }, "constraints": [ ], "wall_joins": { },
  "geometry": { }, "slice2d": { }, "journal": [ ],
  "timings": { }, "engine_ms": 0.0 }
```

**Rules. These are the requirements; a violation is a defect, not a design choice.**

| # | Rule |
|---|---|
| R1 | **Equivalence.** Applying a delta sequence from any base to head MUST produce store state deep-equal to applying the full bundle at head. This is the acceptance test (D6). |
| R2 | **`unchanged: true` does no work.** It MUST NOT recompute geometry or linework. It must be cheap on a large model, not merely cheap on a small one. |
| R3 | **Idempotent.** Applying the same delta twice equals applying it once. Upsert by GUID; never append. |
| R4 | **Never guess.** On an unknown, gapped, or regressed `since`, return Response C. A partial delta applied to the wrong base is silent corruption — the worst possible outcome here. |
| R5 | **`slice2d: null` means "the view does not need redrawing"**, and the client MUST keep the existing linework. Never send `null` to mean "blank". |
| R6 | **Backward compatible.** No `since` ⇒ full bundle, byte-identical in shape to today. |
| R7 | **`rev` is monotonic within a server process.** It may reset on restart; R4 covers that. Do not persist it. |

`null` for `project` / `constraints` / `wall_joins` / `journal_append` means **unchanged**. An empty
array or object means **changed to empty**. Do not conflate them — the existing store already skips
`null` sections rather than blanking them, and that behaviour must survive.

### 3.3 Work items

Fill in the **Files** column with the real paths and symbols from your Phase 1 discovery before you
start. Run the **Gate** after each item.

| # | Goal | Files (confirm) | Gate |
|---|---|---|---|
| **D1** | Monotonic `rev` on the engine, incremented once per **committed** transaction, surfaced by `execute_transaction` and `get_journal`. A failed or rolled-back transaction must not move it. | `backend/command_bus.py` | A test asserting `rev` advances by exactly 1 per commit and by 0 on failure |
| **D2** | Per-GUID mesh change tracking so the engine knows **which** meshes changed. Invalidate on element create / delete / geometry rebuild. | `backend/ifc_service.py` | Creating 1 wall in a 100-wall model marks exactly that wall **plus its join partners** dirty |
| **D3** | `since` handling on `/api/state` implementing Responses A, B, C per §3.2. | `backend/main.py`, `backend/ifc_service.py` | `check-state-bundle.mjs` extended (D3b) |
| **D3b** | Extend `scripts/check-state-bundle.mjs` with A/B/C cases: `unchanged`, delta applied, and **forged stale `since` ⇒ full bundle** (R4). | `scripts/check-state-bundle.mjs` | Gate passes, and **fails** if R4 is violated |
| **D4** | Delta application in the store: track `rev`, merge `upsert_meshes` by GUID, drop `remove_guids`, append journal. Keep the full path for `full: true`. | `src/store/useBimStore.ts` | `tsc --noEmit` clean; bus-parity gate still passes |
| **D5** | **Dirty-view slice.** Include `slice2d` only when the change can affect the active view. Otherwise `null` (R5). | `backend/main.py`, `backend/ifc_service.py` | Moving a wall on level 2 while viewing level 1 returns `slice2d: null` **and the rendered linework is unchanged** |
| **D6** | **Differential equivalence test** — `scripts/check-delta-equivalence.mjs`. The centrepiece. | new file | ≥50 randomised command sequences; after each, delta-applied state deep-equals full-bundle state; **0 mismatches**. Must include a negative control (below) |
| **D7** | **Measurement.** Add payload `bytes` to the instrumentation; produce before/after with a stated model and corpus. | `src/store/useBimStore.ts`, `docs/DELTA-MEASUREMENT.md` | Document states model size, corpus, both latency numbers, and the **no-op poll cost** |
| **D8** | Retire the interim: replace the *"This does not implement deltas yet"* header with what it now does; update the circuit-breaker comment. | `backend/main.py`, `src/store/useBimStore.ts` | Grep finds no stale claim |
| **D9** | Move §6.3 of the spec from **[GAP]** to satisfied, and update the N10 row in the implementation plan. | `docs/SPECIFICATION-v0.2.md`, `docs/IMPLEMENTATION-PLAN-2026-10-14.md` | The spec no longer claims a requirement is unmet |

**D6's negative control is not optional.** A differential test that cannot fail is decoration. Prove
it works by deliberately corrupting a delta — drop a mesh from `upsert_meshes`, or apply it to the
wrong base — and assert the test reports a mismatch. Record the result in the benchmark log.

---

## 4. Guardrails — traps specific to this repository

These have all happened here. They cost real time.

**T1 — Never truncate-and-reappend a file.** A previous edit truncated `backend/main.py` at a marker
that turned out to be mid-file, silently deleting **20 routes and 21 function definitions**. Compile
checks passed and the endpoint under test worked. It was caught only by noticing the file was
*shorter than HEAD despite gaining a feature*.

> **Rule:** after any edit, run `git diff --numstat`. Deletions in `backend/main.py` must be **0**
> unless you intended them, and you must be able to name each one. Re-count routes (T2) after every
> backend edit.

**T2 — Invariants, not trivia.** `^@app\.` count in `backend/main.py` must be **≥43**, and
`COMMAND_REGISTRY` must stay at **26** plus anything you add — with a schema and a test for each
addition. A shrunk count is data loss.

**T3 — Encoding.** The Windows console here is `cp1252`. Test output must be **ASCII-only**, or the
runner must force UTF-8. `scratch/test_wall_joins.py` previously printed a Unicode check mark and
died with `UnicodeEncodeError` before completing a single check. When scripting edits, do not embed
non-ASCII in shell here-strings — build it from code points.

**T4 — Beware tests whose expectations encode the bug.** The join suite's miter check *expected* a
0.15 × 0.15 area deficit, because the implementation had that defect; fixing the miter made the test
fail, so the fix looked like a regression. Before changing behaviour, check whether a test asserts
the current behaviour or the correct behaviour, and ask of every check: **what would this have to
observe in order to fail?**

**T5 — `is_si=False` on every `edit_object_placement`.** BIMWorks' values are already in the file's
unit. Getting this wrong produced a 3.28× placement error and once silently disabled opening
subtraction.

**T6 — Decimal feet everywhere except the STEP boundary.** `backend/units.py` is the only conversion
point. No bare `0.3048` outside it, and no metric literals in builders.

**T7 — `planegcs` is missing, and 4 failures are pre-existing.** `python -c "import planegcs"` fails
in a fresh environment, so `test_dependency_graph.py` reports `37 passed, 4 failed`. This is
**verified identical on a pristine checkout**. Either `pip install planegcs` (it is declared in
`requirements.txt`, so this is not a new dependency) or record the four as pre-existing.
**Do not make them pass by editing test expectations.**

**T8 — Restart the backend after backend edits.** Python does not hot-reload. A stale process will
404 a route you just added, and the store's circuit breaker will fall back to per-resource fetches
after one console warning — so your change will appear to do nothing. Verify with `curl http://127.0.0.1:8008/health`, then
`curl http://127.0.0.1:8008/api/state`.

**T9 — `API_BASE` is the relative `/api`,** resolved by Vite's dev proxy, so the store cannot be
pointed at a test server. Tests must **stub `fetch`**. `scripts/check-state-bundle.mjs` is the
worked pattern.

**T10 — Gates run against a live engine.** `check:ui` and the store gates make real HTTP calls.
Start the backend before running `npm run check`.

**T11 — Verify by executing, and by structure.** A scripted edit that reports success may not have
applied, and one that inserted a helper into a class body once silently truncated 89 methods to 6.
Compile-check, count, and run the gate — do not read the diff and assume.

---

## 5. Gates

Run after each work item, and all of them before you claim the refactor is done.

```bash
# 1. Frontend gates — must all pass, npm run check must exit 0
npm run check

# 2. The new equivalence gate
node scripts/check-delta-equivalence.mjs

# 3. Engine suites
python scratch/test_wall_joins.py            # 18 passed, 0 failed
python scratch/test_wall_joins_matrix.py     # 37 passed, 0 failed
python scratch/test_transactions.py
python scratch/test_container_fidelity.py
python scratch/test_hosted_openings.py
python scratch/test_v2_core.py
python scratch/test_hlr.py
python scratch/test_sketch_model.py
python scratch/test_dependency_graph.py      # 37 passed, 4 failed — PRE-EXISTING (T7)

# 4. Invariants
grep -c '^@app\.' backend/main.py            # >= 43
git diff --numstat                           # deletions in backend/main.py explained
```

**A gate that cannot fail is worse than no gate.** For every check you add, state what it would have
to observe in order to fail. If your `unchanged`-is-cheap check would pass on a small model even if
the engine recomputed everything, it is not testing R2 — assert on a large model.

---

## 6. Definition of done

- [ ] `docs/BASELINE-YYYY-MM-DD.md` committed **before** any code change
- [ ] D1–D9 complete, each with its gate run and recorded
- [ ] `npm run check` exits 0 with the gate counts in §2.1 (plus your new checks)
- [ ] `scripts/check-delta-equivalence.mjs` exits 0 with ≥50 sequences and **0 mismatches**
- [ ] Its **negative control** demonstrated a real failure
- [ ] Every engine suite shows its baseline result; no suite is worse than baseline
- [ ] `docs/DELTA-MEASUREMENT.md` states model size, corpus, `clientMs` and `engineMs` before and
      after, and the no-op poll cost
- [ ] Route count ≥43; no unexplained deletions in any backend file
- [ ] §6.3 of the spec no longer reads **[GAP]**; the plan's N10 row updated
- [ ] No new package added; `requirements.txt` unchanged except a `planegcs` install if you chose it

---

## 7. What "done" must NOT include

- Redesigning the §3.2 contract. Implement it; if you believe it is wrong, record **why** in §8 and
  ask before deviating.
- SSE, WebSockets, gRPC, or a message broker. `since`-based polling is the specified transport.
- Touching the join engine. The side-face miter (`_miter_joint_line`, end extension via
  `_wall_rect(ext_start=…, ext_end=…)`) was just fixed and is covered by 37 checks. Leave it.
- Changing the container format, the units, or the shape of the bus registry.
- Making the four `planegcs` failures pass by weakening tests.
- Refactoring `ifc_service.py` "while you are in there". It is 5,000 lines and not the objective.
- Phase 2 (§9) before Phase 1 is green and merged.

---

## 8. Benchmark log — required deliverable

This refactor is also an evaluation of agentic execution in this codebase. Fill this in as you go;
it is as much a deliverable as the code.

Create `docs/REFACTOR-LOG.md`:

| # | Work item | Attempts | What went wrong | How you detected it | Recovered? |
|---|---|---|---|---|---|
| D1 | | | | | |

Also record, honestly:

1. **Where did you guess?** Any point where you changed something without reading the surrounding
   ≥50 lines that GEMINI.md requires.
2. **What did a gate catch** that review would not have?
3. **Which of the §4 traps did you hit**, and how did you get out? (Hitting them is expected. Not
   noticing is the finding.)
4. **What did the baseline tell you that you would otherwise have got wrong?**
5. **Anything in this plan you believe is wrong**, with the evidence.

Do not tidy this up into a success narrative. A logged dead end is more useful than a clean summary.

---

## 9. Optional Phase 2 — only after Phase 1 is green

Not part of this refactor. Do not begin it. Recorded so the next agent has the context.

**N10's other half: incremental undo.** The transaction engine takes a full-state snapshot before
every transaction — complete IFC STEP text plus tracking state, deep-copying meshes. That is
O(model) per edit, and it contradicts the same 16 ms budget Phase 1 is attacking.

Revit's reference shape is **episodes**, not snapshots: `DocumentIncrementTable::begin/end`,
`DocumentIncrement::greatestEpisodeId`, `DocumentHistory::getEpisode`. The work is to replace the
snapshot with an incremental or structurally-shared representation, which is only tractable once the
engine can already identify *what changed* — which is what D2 builds. That dependency is why this is
Phase 2.

A later Phase 3 would be a conformance sweep of the remaining **[GAP]** and **[OPEN]** items in
`SPECIFICATION-v0.2.md` §21.
