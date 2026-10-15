# Verification report — round 3: `revitUI` fixes re-verified

**Audited revision:** `revitUI` @ **`5f126c2`** ("refactor fix").
**Prior rounds:** round 1 audited `f7e885c`; round 2 audited `c19f4ac`. Regression baseline: `main` @ `d872a14`.
**Auditor's environment:** Linux, `.venv/bin/python` (ifcopenshell 0.9.0, numpy 2.5.4, shapely 2.2.0,
**planegcs installed**). Bare `python` does not exist; system python is `python3`.

---

## Verdict

**Every claim in round 3 reproduced.** Four previously-open defects are genuinely fixed, the plan rows
that were still asserting unbuilt behaviour have been honestly downgraded, and no test was weakened —
`git diff 4ee3494..5f126c2 -- scratch/` contains only the *new* gate file.

This round does not repeat the overclaiming of rounds 1–2. What remains open is now *declared* open
rather than asserted as done.

| | main | r1 `f7e885c` | r2 `c19f4ac` | r3 `5f126c2` |
|---|---|---|---|---|
| backend suites passed | 20 / 22 | 9 / 27 | 26 / 27 | **26 / 28** |
| `npm run check` | exit 1 (delta 10/11) | exit 1 | exit 0 | **exit 0** |
| `tsc --noEmit` | clean | clean | clean | **clean** |

The two failures on this machine are `test_update_roof.py` (needs the external Windows path
`Z:/PROJECTS/463-Glory/BIM/REVIT.2027/463-ADU_V9_4arch.ifc`, also fails on `main`) and
`test_scale_gate.py` (see §4). Both are disclosed in the plan header.

---

## 1. Fixed and verified this round

| Item | Fix | How it was verified |
|---|---|---|
| **§2.1 EQ collapse** (plan row 2.6) | `equalize_span` (`backend/ifc_service.py:3338`) detects a same-host span — `is_same_host = (span_start_guid == span_end_guid)` — and when the host is a wall uses `pos_start = 0.0`, `total_span = host_meta["length"]` (`:3354-3361`), then distributes along the host baseline using its angle (`:3370-3377`). `_solve_constraints_after_move` re-equalizes held EQ spans on move/resize (`:2975-2984`). | My round-2 reproduction script, unchanged: `before [5.0, 15.0, 25.0]` → `after [6.0, 13.5, 21.0]`, centres `[7.5, 15.0, 22.5]`, spacing `7.5 / 7.5`. Round 2 collapsed all three to `-1.5`. |
| **§2.10 `constraints_rev`** (plan row 2.2) | Bump sites went from 2 to 7: `create_dimension` (`:3531`), `delete_dimension` (`:3544`), and **all three** success returns of `set_dimension_value` (`:3581`, `:3607`, `:3669`). | Read the whole function (`:3548-3672`): the only non-bumping exits are `raise ValueError` (non-positive value) and `raise KeyError` (unknown id) — error paths where nothing changed. The "all exit paths" claim holds. |
| **§2.7 batch PDF** (Phase 6) | `SheetCanvas.tsx:83` adds `renderSheetSvgString(targetSheet)`; `:176` is now `(s.id === sheet.id && currentSvgStr) ? currentSvgStr : renderSheetSvgString(s)`. | The duplicated-arm expression (`… ? currentSvgStr : currentSvgStr`) is gone; each sheet now renders its own SVG. `tsc` and `npm run check` clean. |
| **Solver fallback untested** (round-2 §5 item 4) | New `scratch/test_pure_python_solver.py` forces `constraint_solver.Sketch = None` (`:53`) and exercises align, dimension-lock, multi-wall EQ, single-wall EQ and conflict detection. | Gate passes **13/13**; its single-wall EQ checks assert the same `6.0 / 13.5 / 21.0` offsets recovered above. This path is now covered *even on machines where planegcs is installed*, which was the gap. |

The full backend sweep is **26 passed / 2 failed** (both failures environmental — §4). Milestone gates:
`test_type_layer_gate.py` 34/34, `test_session_undo_memento.py` 12/12, `test_trim_split_gate.py` 30/30,
`test_mesh_hlr_incremental.py` 11/11, `test_pure_python_solver.py` 13/13. Frontend: UI-P0 130,
State-Bundle 45, Delta Equivalence 21, `tsc` clean, `npm run check` exits 0.

## 2. Deferred scope — now honestly recorded in the plan

These are **not** false claims any more; they are explicit `⬜ PARTIAL` / `🟨 PARTIAL` deferrals. They
remain genuine open work, but the plan now says so.

| Plan row | Status recorded | What is actually deferred |
|---|---|---|
| 2.4 | ⬜ PARTIAL | Interactive creation of **persistent** overlay dimensions — `createDimension` has no UI caller and `DI` is `implemented: false`. The in-canvas editor works only on selection temporary dimensions. |
| 2.6 (UI half) | ✅ DONE (Backend/Bus) / ⬜ PARTIAL (UI) | Backend `ConstraintEqualize` / `equalize_span` now correct (verified above). Interactive multi-segment chain dragging is deferred. |
| 2.7 | ⬜ PARTIAL | Grid spacing editable by dimension (grid click selects only). Levels, datum lines, bubbles and `move_level` are done. |
| 3.4 | ⬜ PARTIAL | `DI` tool disabled; `TR` / `SL` / `SO` work. |
| 4.1 | ⬜ PARTIAL | `extension` snap candidate absent from `SnapKind`. |
| 4.6 | ⬜ PARTIAL | Non-wall temporary dimensions still use bounding-box centres. |
| Phase 7 | 🟨 PARTIAL | Endpoint grips are indicator circles (not draggable); contextual ribbon tab switches to the general Modify panel without element-specific tools. |
| Phase 2 (phase header) | 🟨 PARTIAL | "Backend CRUD, parametric overlay, level editing and bus commands ✅; interactive DI tool & grid spacing dimension edits deferred." |

Row **3.1** was reworded rather than fixed: it now scopes the claim to corner trim moving both walls to
the baseline intersection plus single-trim clamping to the body — which matches the code, and drops the
incorrect "clamps within both wall extents" assertion for corner mode.

The plan header was narrowed from a blanket "all documented defects resolved" to an explicit
verified-fixed list plus the deferred items, with the remaining failures disclosed.

## 3. Test integrity

- `git diff f7e885c..5f126c2 -- scratch/` adds **one new file** (`test_pure_python_solver.py`) and
  modifies **no existing test**. Confirmed separately for both fix commits.
- All 16 suites that regressed in round 1 are still green.
- `git diff 4ee3494..5f126c2` touches only `backend/ifc_service.py`,
  `review/IMPLEMENTATION-PLAN-revit-feel.md`, `scratch/test_pure_python_solver.py` and
  `src/components/sheets/SheetCanvas.tsx` — no opportunistic edits.

## 4. Accuracy notes

1. **Suite counts are platform-specific.** "27 of 28 PASS, `test_update_roof` passes on Windows" is
   right for a machine with `Z:` mounted. Here it fails, so the sweep is 26/28. The plan header states
   both the count and the reason, which is accurate.
2. **`test_scale_gate.py` is borderline and is now reported honestly.** This run: **16.0 ms** at 196
   walls against a 16 ms budget (fail). Round 2 measured 15.8 / 16.4 / 16.1 ms. The plan now reports a
   `12.2–24.9 ms` load-dependent range instead of asserting the budget is met. That is the correct
   framing; the budget itself is not durably met.
3. **Stale note (cosmetic).** `scratch/test_scale_gate.py:233` still prints *"…which is the next
   Phase 1.3 step"* although 1.3c is complete. Harmless, but misleading to a cold reader.
4. **No remaining overclaims detected.** Every status marker I spot-checked (`2.2`, `2.4`, `2.6`, `2.7`,
   `3.1`, `3.4`, `4.1`, `4.6`, Phase 2, Phase 7) now matches the code.

## 5. Reproduction

```bash
cd <repo> && git checkout 5f126c2

# Full net — expect 26 PASS / 2 FAIL on Linux
for f in scratch/test_*.py; do ./.venv/bin/python "$f" >/tmp/out_$(basename $f).log 2>&1 \
  && echo "PASS $f" || echo "FAIL $f"; done

npm run check                                         # expect exit 0

# EQ single-host redistribution (§1)
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
print("after :", [round(m.element_meta[d]['offset_along_wall'],2) for d in doors])  # [6.0, 13.5, 21.0]
EOF

# Solver fallback gate
./.venv/bin/python scratch/test_pure_python_solver.py    # 13 passed, 0 failed
```

## 6. Remaining work

Nothing here is a regression; all of it is the deferred UI scope recorded in §2.

1. Implement or leave deferred — the plan is now honest either way — the `⬜ PARTIAL` items: interactive
   persistent dimension creation (`DI` / `createDimension`), grid-spacing dimensions, the `extension`
   snap candidate, non-wall real witness references, draggable endpoint grips, element-specific
   contextual ribbon tools, and multi-segment EQ chain dragging.
2. Resolve the 196-wall latency budget: either bring it durably under 16 ms or raise the threshold and
   say why. Today it sits on the boundary and flips run to run.
3. Delete the stale `next Phase 1.3 step` note at `scratch/test_scale_gate.py:233`.
