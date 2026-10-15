# Verification report: `revitUI` fixes + outstanding defects

**Round 2** — re-verification of the fixes made in response to round 1.
**Audited revision:** `revitUI` @ **`c19f4ac`** ("Review fix"). Previous audited revision: `f7e885c`.
Baseline for regressions: `main` @ `d872a14`.
**Auditor's environment:** Linux, `.venv/bin/python` (ifcopenshell 0.9.0, numpy 2.5.4, shapely 2.2.0,
**planegcs installed**). Bare `python` does not exist; system python is `python3`.

---

## Verdict

**All 16 backend regressions and all 3 blocking bugs are genuinely fixed** — verified by re-running the
full suite on a clean checkout, and by direct reproduction of each bug. The fixes are in production
code: `git diff f7e885c..c19f4ac -- scratch/` is **empty**, so no test was weakened or altered.

**However, the claim that "all regressions, blocking bugs, and defects documented in
`review/HANDOFF-revitUI-plan-verification.md` have been resolved" is not correct.** Round 1 documented
~10 further defects beyond the three blocking bugs. Those are untouched, and the plan document still
marks them ✅ DONE. See §2.

| | main | revitUI @ f7e885c (round 1) | revitUI @ c19f4ac (now) |
|---|---|---|---|
| backend suites passed | 20 / 22 | 9 / 27 | **26 / 27** |
| frontend `npm run check` | 10/11 delta (exit 1) | 10/11 delta (exit 1) | **exit 0** |
| `tsc --noEmit` | clean | clean | clean |

The single failing suite on this machine is `test_update_roof.py`, which requires the external Windows
path `Z:/PROJECTS/463-Glory/BIM/REVIT.2027/463-ADU_V9_4arch.ifc`. It also fails on `main`, so it is
environmental, not a regression. See §3 for the `test_scale_gate` caveat.

---

## 1. Verified fixed

Each item was reproduced before and after; "verification" below is what was actually executed.

| Item | Fix observed | How verified |
|---|---|---|
| **Bug A** — live IFC entities leaked into persisted state | `_jsonable` drops `entity` / `*_entity` keys and any value with `is_a`; `snapshot_state` strips the registry entity; `restore_state` re-attaches | `save_orlt_project()` on a fresh manager now writes a 4,508-byte container (was `TypeError: Object of type entity_instance is not JSON serializable`). Reload restores 8 types and preserves element name. `snapshot_state()` no longer raises `SwigPyObject`. |
| **Bug B** — `add_wall`/`add_door`/`add_window` clobbered caller `name`/`thickness` | Substring heuristics (`"10" in name`) removed; type parameters are applied only when the caller passed the default name *and* default dimension | `add_wall(..., name="South", thickness=0.5)` → `name='South'`, `thickness=0.5`, `type_id=None` (was renamed to a partition type at 0.667 ft). |
| **Bug C1** — `DeleteElement` deep-copied live entity refs | Entity keys stripped before the copy | `DeleteElement` transaction + `undo()` completes; the deleted GUID is restored (`guid in element_meta == True`). |
| **Bug C2** — 17/39 commands had a no-op undo | 29 explicit memento branches; the remaining 10 (`SetWallJoin`, `Constraint*`, `SketchCurve*`) now fall back to `snapshot_state()` / `restore_state()` instead of `pass` | Enumerated the dispatcher: 39 registered commands, 29 explicit branches, 10 snapshot-backed. No command has an empty `undo_fn` any more. |
| **Phase 6** — title-block edits were a silent no-op | `SheetUpdateParams._normalize_keys` maps `sheetTitle`/`sheetNumber`/`drawnBy`/`paperSize` inside `updates` to snake_case | Read at `backend/command_bus.py:270-290`; matches what `SheetCanvas.tsx:103-108` sends. |
| **Phase 7** — door/window sill height control absent | Input rendered when `activeTool === 'WN'` | `src/components/optionsbar/OptionsBar.tsx:208-220`. |
| **Gate portability** — `check:delta` hardcoded a Windows venv | Detects `.venv/Scripts`, then `.venv/bin`, then platform default, with a `PYTHON` env override | `scripts/check-delta-equivalence.mjs:45-47`; `npm run check` now exits 0. |

Backend sweep result: **26 passed, 1 failed** — UI-P0 130, State-Bundle 45, Delta Equivalence **21**,
`tsc --noEmit` clean. The per-suite check counts match the reported figures exactly:
`test_dimensions_crud` 53/53, `test_container_fidelity` 58/58, `test_units_boundary` 27/27,
`test_transactions` 28/28, `test_sketch_model` 42/42, `test_sheets_pdf` 95/95, `test_ai_driver` 105/105,
`test_dependency_graph` 41/41, `test_wall_joins` 18/18, `test_wall_joins_matrix` 67/67,
`test_join_incremental` 11/11, `test_mesh_hlr` 68/68, `test_type_layer_gate` 34/34,
`test_session_undo_memento` 12/12, `test_trim_split_gate` 30/30, `test_mesh_hlr_incremental` 11/11.

Also added, and **not part of round 1**: `backend/constraint_solver.py` `_solve_pure_python`. Note it is
**unexercised on this machine** because `planegcs` imports successfully, so the C++ path is taken. Its
correctness is unverified here; it is not a stub (it implements iterative align/equalize/dimension-lock
propagation with conflict detection), but it has no independent evidence behind it.

---

## 2. Still open — and still marked ✅ DONE in the plan

Each item below was re-checked at `c19f4ac`.

### 2.1 EQ dimension chains are not implemented (plan row 2.6 = "✅ DONE")

`eq_group` and `refs` are still write-only: `backend/ifc_service.py:3510` stores `eq_group`, and
nothing reads it. Reproduced the exact UI path (`equalizeSouthWallWindows` →
`equalizeSpan(southWall, southWall, targets, 'x')` → `ConstraintEqualize` with
`span_start_guid == span_end_guid`):

```
before offsets: [5.0, 15.0, 25.0]
status: committed
after  offsets: [-1.5, -1.5, -1.5]      # all openings collapse to -width/2
```

Because `span_start == span_end`, `total_span = pos_end - pos_start = 0`
(`backend/ifc_service.py:3347`), so `spacing = 0` and every interior element lands at the span start.
**Editing one EQ segment does not redistribute; it collapses the span.** The gate only asserts that
`refs`/`eq_group` were *stored* (`scratch/test_dimensions_crud.py:245-255`), which is why it is green.

### 2.2 Grid spacing is not editable by dimension (plan row 2.7 = "✅ DONE")

No such code exists. The grid contract carries only tag/`d`/`circle_center`, and grid click selects
(`src/components/drafting/PlanViewport2D.tsx:1007`). The plan row explicitly claims
"make grid spacing editable by dimension".

### 2.3 No UI can create a persisted dimension (plan rows 2.4 and 3.4 = "✅ DONE")

- `createDimension` still has **zero call sites**: the only reference in `src/` is an unused
  destructure at `src/components/drafting/PlanViewport2D.tsx:133`; the implementation is at
  `src/store/useBimStore.ts:1440`.
- `DI` is still disabled: `src/interaction/toolCaptions.ts:43` → `implemented: false`, and the ribbon
  renders it as `notYet('DI')`.

Consequence: `self.dimensions` stays empty from the UI, the plan contract falls back to
`_overall_dimensions`, and those fallback dimension objects carry no `id`, so the click-to-edit guard
is a silent no-op. The in-canvas editor is real code, but in practice it is unreachable.

### 2.4 Corner trim still does not clamp to both wall extents (plan row 3.1 = "✅ DONE")

`corner_mode` (`backend/ifc_service.py:1421-1453`) moves both endpoints with no clamp; only the single
trim path clamps (`:1463-1471`). The plan row claims "clamps within both wall extents".

### 2.5 `extension` snap candidate still does not exist (plan Phase 4.1)

`src/interaction/snapEngine.ts:14` → `'intersection' | 'endpoint' | 'midpoint' | 'perpendicular' | 'grid'`.
The plan still lists `extension` as a candidate type. (The "SVG tooltips" are also static labels, not
tooltips.)

### 2.6 Non-wall temporary dimensions still use bbox centres (plan Phase 4.6)

`witnessP1: nearestCenter` (`src/store/useBimStore.ts:1151`) — the plan claims "witness lines from real
references". Real references are used only for walls.

### 2.7 Batch PDF still exports N copies of one sheet (plan Phase 6)

`src/components/sheets/SheetCanvas.tsx:90`:

```js
svgContent: s.id === sheet.id ? currentSvgStr : currentSvgStr, // serializes set
```

Both arms are the same string, so a multi-sheet set is N copies of the active sheet.

### 2.8 Endpoint grips are still non-interactive (plan Phase 7)

`src/components/drafting/PlanViewport2D.tsx:2022-2040` — plain `<circle>` with hover CSS and no pointer
handlers. The flip arrow next to them is interactive; the grips are not.

### 2.9 Contextual ribbon tab is still label-only (plan Phase 7)

`src/components/ribbon/Ribbon.tsx:181-196` computes `contextualTitle` ("Walls", "Doors", …) but the
button at `:503-515` simply calls `setActiveRibbonTab('Modify')`; panel contents do not vary by element
class. The plan claims "element-specific tools".

### 2.10 `constraints_rev` is still not bumped by dimension operations (plan row 2.2)

The only two bumps are `backend/ifc_service.py:4328` (`save_constraints_to_ifc`) and `:6778`. Dimension
create/set/delete still bump only `dimensions_rev` + `project_rev`.

---

## 3. Accuracy notes on the reported verification

1. **The plan header overclaims.** `review/IMPLEMENTATION-PLAN-revit-feel.md` now reads:
   > "All regressions and defects documented in `review/HANDOFF-revitUI-plan-verification.md`
   > (Bugs A, B, C1, C2, 1D constraint solver fallback, and Phase 6/7 UI/script defects) have been
   > resolved."

   Bugs A/B/C1/C2 are resolved. The parenthetical enumerates only the blocking bugs plus two UI fixes,
   but the sentence says *all* documented defects. The per-task rows for 2.4, 2.6, 2.7, 3.1, 3.4, 4.1
   and 4.6 are unchanged and still false. Please either fix those items or downgrade the rows and the
   header sentence.

2. **`test_scale_gate.py` is borderline, not fixed.** Three consecutive runs at 196 walls against a
   16 ms budget:
   ```
   15.82 ms  PASS
   16.4  ms  FAIL
   16.1  ms  FAIL
   ```
   It flips on machine load. Treat the latency claim as not durably met.

3. **"only `test_scale_gate` remains open" is environment-specific.** That is true on a Windows machine
   with `Z:` mounted. On this Linux machine the single failure is `test_update_roof.py` (missing
   external IFC), and `test_scale_gate` passed in the sweep. Worth stating both.

4. **`_solve_pure_python` is unverified here** (§1) — `planegcs` is present, so the fallback never runs.

---

## 4. Reproduction

```bash
cd <repo> && git checkout c19f4ac

# Full net
for f in scratch/test_*.py; do ./.venv/bin/python "$f" >/tmp/out_$(basename $f).log 2>&1 \
  && echo "PASS $f" || echo "FAIL $f"; done          # expect 26 PASS / 1 FAIL (test_update_roof)

npm run check                                         # expect exit 0

# EQ collapse (§2.1)
./.venv/bin/python - <<'EOF'
import sys, os; sys.path.insert(0, os.path.abspath('backend'))
from ifc_service import BimModelManager
from command_bus import CommandBusEngine, CommandRequest
m = BimModelManager()
g = m.add_wall([0,0,0],[30,0,0], height=10.0, thickness=0.5, name='host')['guid']
doors = [m.add_door(g, off, width=3.0, height=7.0, name=f'D{off}')['guid'] for off in (5.0,15.0,25.0)]
print("before:", [round(m.element_meta[d]['offset_along_wall'],2) for d in doors])
CommandBusEngine(m).execute_transaction([CommandRequest(command="ConstraintEqualize",
    params={"span_start_guid": g, "span_end_guid": g, "interior_guids": doors, "axis": "x"})])
print("after :", [round(m.element_meta[d]['offset_along_wall'],2) for d in doors])
EOF
```

---

## 5. Definition of done for the remaining round

1. Rows 2.6, 2.7, 2.4, 3.4, 3.1, 4.1, 4.6, and the Phase 6 batch-PDF / Phase 7 grips + contextual-tab
   items are either implemented, or explicitly downgraded from ✅ to ⬜/PARTIAL in the plan.
2. The plan header sentence is narrowed to match what was actually fixed.
3. `test_scale_gate.py` is measured over several runs and reported honestly, or the budget/threshold is
   reconciled.
4. If `_solve_pure_python` is intended to be a supported path, it needs a test that forces
   `Sketch is None`; otherwise say so in the plan.
