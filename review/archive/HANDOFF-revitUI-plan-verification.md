# Verification report — round 4: `revitUI` fixes re-verified

**Audited revision:** `revitUI` @ **`4023571`** ("fix(review): round-3 remaining work — scale gate
budget, stale note & extension snap candidate").
**Prior rounds:** r1 `f7e885c` · r2 `c19f4ac` · r3 `5f126c2`. Regression baseline: `main` @ `d872a14`.
**Auditor's environment:** Linux, `.venv/bin/python` (ifcopenshell 0.9.0, numpy 2.5.4, shapely 2.2.0,
planegcs installed). Node v22.23.3. Bare `python` does not exist; system python is `python3`.

---

## Verdict

**All three items from round-3 §6 were addressed, and each was verified by execution rather than by
reading.** Rounds 1–2 overclaimed; rounds 3 and 4 do not.

Three new items are recorded in §3 — none is a regression, one is a real coverage gap, and one is a
caveat about what "budget reconciled" means.

| | main | r1 `f7e885c` | r2 `c19f4ac` | r3 `5f126c2` | r4 `4023571` |
|---|---|---|---|---|---|
| backend suites passed | 20 / 22 | 9 / 27 | 26 / 27 | 26 / 28 | **27 / 28** |
| `npm run check` | exit 1 | exit 1 | exit 0 | exit 0 | **exit 0** |
| `tsc --noEmit` | clean | clean | clean | clean | **clean** |
| `test_scale_gate` | 5/6 | 5/6 | 6/6 (flaky) | 5/6 | **6/6** |

The single failure is `test_update_roof.py`, which needs the external Windows path
`Z:/PROJECTS/463-Glory/BIM/REVIT.2027/463-ADU_V9_4arch.ifc`. It also fails on `main`, so it is
environmental. The plan header states this correctly.

---

## 1. Verified this round

### 1.1 Stale note deleted

`grep -c "next Phase 1.3 step" scratch/test_scale_gate.py` → **0**. The line that told a cold reader
1.3c was still pending is gone.

### 1.2 Scale gate reconciled, with rationale

`scratch/test_scale_gate.py:191-200` now applies a size-dependent threshold:

```python
threshold = BUDGET_P95_MS if row["walls"] <= 100 else 30.0
```

with an in-code rationale ("N=200 sits on the boundary (measured 12.2–26.9 ms depending on machine
load) … while guarding against regressions (the global join baseline at 200 walls was 80+ ms)"). The
check label was renamed to "…budget threshold", and the `NOTE beyond budget` line still uses the real
`BUDGET_P95_MS` (`:46`), so §19 overruns are still reported. Gate result: **6 passed, 0 failed**.

This is the one option round-3 §6 explicitly permitted ("raise the threshold and say why"), and it is
disclosed in both the code and the plan. See §2 for what it does **not** mean.

### 1.3 `extension` snap candidate — implemented and functionally verified

`SnapKind` now includes `extension` (`src/interaction/snapEngine.ts:14`) and the candidate is computed
at `:254-286` by projecting the cursor onto each segment and accepting `t` outside `[0,1]` but within
`[-2, 3]` and within tolerance.

I exercised the function directly (Node `--experimental-strip-types`) against a 10 ft segment with
`scale: 10` → tol 1.4 ft:

```
beyond end   (13,0)  -> extension @ [13,0]  "Extension"
before start (-2,0)  -> extension @ [-2,0]  "Extension"
off-axis     (13,3)  -> grid      (not collinear — correctly falls through)
at endpoint  (10,0)  -> endpoint  (higher priority — correct)
far beyond   (60,0)  -> grid      (t=6 exceeds the 3.0 reach)
```

The priority chain in code — `intersection` (`:109-138`) → `endpoint` (`:140-164`) → `midpoint`
(`:166-181`) → `perpendicular` (`:183`) → `extension` (`:254-286`) → `grid` (`:288`) — matches the
hierarchy the plan now records. The description `<text>` at `PlanViewport2D.tsx:1901-1919` renders
`activeSnapCandidate.description` unconditionally, so an extension snap **does** display
"Extension" on screen; only the glyph shape is missing, which the plan row discloses
("Visual SVG snap glyph overlays in `PlanViewport2D.tsx` remain deferred").

---

## 2. Caveat: §19's 16 ms budget is still not met at N≈200

The gate was widened; the latency was not fixed. Measured this round:

```
 100 walls    8.92 ms   0.56x
 196 walls   16.34 ms   1.02x   <- over the 16 ms §19 budget
 484 walls   38.27 ms   2.39x
```

At 196 walls the check passes only because the threshold there is 30 ms. The plan header's
"reconciled to 30.0 ms threshold" is honest, but "reconciled" should not be read as "§19 satisfied":
the spec requirement (p95 < 16 ms) remains unmet at N≈200. Keeping the `NOTE beyond budget` line was
the right call, because it preserves that fact in the gate output.

---

## 3. New items

### 3.1 Two plan rows are now stale and contradict the new gate

- `review/IMPLEMENTATION-PLAN-revit-feel.md:331` (Phase 0.1) still says the gate
  *"Enforces the 16 ms budget at N≤200 by default"*. It now enforces 16 ms only at N≤100.
- `:65` still frames the measurement table *"against the §19 budget of **p95 < 16 ms**"*, and `:355`
  calls 196 walls *"inside the 16 ms budget"*. Those are historical statements about `e3216fe`, but
  they sit next to a header that now says 30 ms, which will confuse a cold reader.

Neither is a code defect; both are documentation drift introduced by this commit.

### 3.2 `snapEngine.ts` has no automated coverage

`grep -rn "findSnapCandidate\|snapEngine" scripts/ scratch/` returns **nothing**. The plan marks 4.1
"🟨 PARTIAL / ✅ DONE (Engine)" and describes the module as pure and testable — "Zero React/DOM
dependencies so it runs in tests and worker threads identically" — yet no test imports it. The manual
execution in §1.3 is currently the only evidence the new `extension` branch behaves correctly, and
nothing would catch a future regression in any of the six candidate kinds. Because the module is pure,
a gate here is cheap and would make the "✅ DONE (Engine)" claim self-supporting.

### 3.3 Stale module docstring

`src/interaction/snapEngine.ts:94-99` still lists the old hierarchy — "4. Perpendicular / Orthogonal,
**5. Grid**" — with no `Extension`, contradicting the inline comments (`5. Extension Snap` at `:254`,
`6. Grid Snap` at `:288`) and the plan row at `:407`.

---

## 4. Test integrity

This is the first round in which an existing test assertion was relaxed. It is not gaming: the change
is confined to `scratch/test_scale_gate.py`, it implements an option round-3 §6 offered, the rationale
is in a code comment, the threshold is size-dependent rather than uniformly loosened, and the stricter
`NOTE` reporting was retained. Every other test file is untouched
(`git diff 834169f..4023571` changes only the plan doc, the scale gate, and `snapEngine.ts`).

All 16 suites that regressed in round 1 remain green.

---

## 5. Reproduction

```bash
cd <repo> && git checkout 4023571

# Full net — expect 27 PASS / 1 FAIL on Linux (test_update_roof needs the Z: fixture)
for f in scratch/test_*.py; do ./.venv/bin/python "$f" >/tmp/out_$(basename $f).log 2>&1 \
  && echo "PASS $f" || echo "FAIL $f"; done

npm run check                                            # expect exit 0
./.venv/bin/python scratch/test_scale_gate.py            # expect 6 passed, 0 failed

# Extension snap, executed directly
cat > /tmp/snaptest.mts <<'EOF'
import { findSnapCandidate } from '<repo>/src/interaction/snapEngine.ts';
const segments = [{ p1: [0,0] as [number,number], p2: [10,0] as [number,number], guid: 'w1' }];
for (const c of [[13,0],[-2,0],[13,3],[10,0],[60,0]] as [number,number][])
  console.log(c, '->', findSnapCandidate(c, { scale: 10, segments } as any)?.kind ?? 'null');
EOF
node --experimental-strip-types /tmp/snaptest.mts
# expected: extension, extension, grid, endpoint, grid
```

---

## 6. Remaining work

Nothing here is a regression.

1. **State the §19 position explicitly** in the plan: at N≈200 the 16 ms budget is still exceeded
   (~16.3 ms), and 30 ms is a regression guard, not the achieved budget. Fix the stale rows at `:65`,
   `:331` and `:355` so the document agrees with itself.
2. **Add a gate for `snapEngine.ts`** covering all six candidate kinds and the priority order — the
   module is pure, so this is cheap, and it would substantiate the "✅ DONE (Engine)" row.
3. **Update the `snapEngine.ts` module docstring** (`:94-99`) to include `extension` between
   `perpendicular` and `grid`.
4. Still deferred by design, and correctly marked `⬜ PARTIAL` / `🟨 PARTIAL` in the plan: interactive
   persistent dimension creation (`DI` / `createDimension`), grid-spacing dimensions, non-wall real
   witness references, draggable endpoint grips, element-specific contextual ribbon tools, and
   multi-segment EQ chain dragging. Snap glyph overlays in `PlanViewport2D.tsx` are also deferred —
   the snap applies and the text label shows, but no glyph is drawn.
