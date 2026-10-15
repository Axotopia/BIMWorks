# Hand-off: verification of `revitUI` against `IMPLEMENTATION-PLAN-revit-feel.md`

**Audience:** the agent/engineer who executed the plan (Phases 1.3c–7).
**Audited revision:** `revitUI` @ `f7e885c` ("Phase 5-7"). Baseline: `main` @ `d872a14`.
**Status of the plan doc:** its status block claims Phases 1.3c, 2, 3, 3.5, 4, 5, 6, 7 are ✅ DONE with
all gates green. **That is not true at `f7e885c`.** Details and fixes below.

The working tree was left clean; nothing in the repo was modified by the audit. System python is
`python3`; the virtualenv is Linux (`.venv/bin/python`, ifcopenshell 0.9.0). The plan's commands use
`./.venv/Scripts/python.exe` (Windows) — see §7.

---

## 0. How to reproduce everything in this report

```bash
cd <repo>                          # revitUI @ f7e885c
git worktree add /tmp/bim-main main  # baseline, if you want the comparison

# Full net, one process per suite (this is the gate the plan designates as the regression net)
for f in scratch/test_*.py; do ./.venv/bin/python "$f" >/tmp/out_$(basename $f).log 2>&1 \
  && echo "PASS $f" || echo "FAIL $f"; done

# The three blocking bugs, minimally
./.venv/bin/python - <<'EOF'
import sys, os; sys.path.insert(0, os.path.abspath('backend'))
from ifc_service import BimModelManager
m = BimModelManager()
m.add_wall([0,0,0],[10,0,0], height=10.0, thickness=0.5, name='South')
print('name/thickness after add_wall:', m.element_meta[list(m.element_meta)[0]]['name'],
      m.element_meta[list(m.element_meta)[0]]['thickness'])   # BUG B
m.save_orlt_project('/tmp/x.bimworks')                          # BUG A -> TypeError
EOF
```

## 1. Result summary

| | main | revitUI |
|---|---|---|
| backend suites run | 22 | 27 |
| passed | **20** | **9** |
| failed | **2** | **18** |

The 2 `main` failures are pre-existing/environmental and are **not** your regression:
`test_update_roof.py` (needs the Windows path `Z:/PROJECTS/...463-ADU_V9_4arch.ifc`) and
`test_scale_gate.py` (latency budget; see §4).

**16 regressions were introduced by `revitUI`.** `tsc --noEmit` and `vite build` both pass.

## 2. Blocking bugs (fix these first)

### BUG A — every project save fails (P0)

**Symptom.** `BimModelManager.save_orlt_project()` raises
`TypeError: Object of type entity_instance is not JSON serializable`
for *any* model, even one with a single wall. The running app's
`GET /api/project/export-bimworks` (`backend/main.py:763`) returns **HTTP 500**.

**Root cause.** `_register_type_entity` (`backend/ifc_service.py:546`) stores the live ifcopenshell
object in the registry record:

```python
rec = { "id": type_id, ..., "entity": entity }
```

`_jsonable` (`backend/ifc_service.py:1758`) only converts numpy, and the overlay serialises the whole
registry at `backend/ifc_service.py:6345` / `:6380`.

**Blast radius.** `save_orlt_project` → `test_dimensions_crud`, `test_v2_core`, `test_sketch_model`,
`test_hosted_openings`, `test_container_fidelity`, `test_http_container_roundtrip` (HTTP 500),
plus the `test_ai_driver` / `test_bus_parity_audit` subprocess-server tests.

**Proof it is this and nothing else.** Removing only the `entity` key (leaving all type behaviour
intact) makes all five in-process suites pass. The plan claims `scratch/test_dimensions_crud.py` is
53/53; it actually **crashes at that call after 26 passing checks**.

**Fix direction.** Never persist live entities. Strip `entity` / `*_entity` in `_jsonable` (or at the
registry boundary), and re-resolve entities on load the way `restore_state` already does at
`backend/ifc_service.py:839-843`.

**Also fix.** `snapshot_state` (`backend/ifc_service.py:720`) deep-copies `type_registry`, which has the
same problem (`SwigPyObject`).

### BUG B — `add_wall` silently overrides the caller's `name` and `thickness`

**Symptom.** `add_wall(..., name="South", thickness=INCHES_8)` produces a wall named
`Basic Wall : Interior - 4 7/8" Partition` with `thickness = 0.40625` (measured mesh thickness
`0.66667` where the caller asked for `0.5`). All custom names are destroyed.

**Root cause.** `backend/ifc_service.py:2059-2066`:

```python
if not type_id and hasattr(self, "type_registry") and self.type_registry:
    type_id = "wall-type-cmu-10" if "10" in name else ("wall-type-cmu-8" if "8" in name
              else "wall-type-partition-478")          # substring heuristic on a free-form name
type_rec = getattr(self, "type_registry", {}).get(type_id)
if type_rec:
    if "thickness" in type_rec.get("parameters", {}):
        thickness = float(type_rec["parameters"]["thickness"])   # clobbers the argument
    name = type_rec.get("name", name)                            # clobbers the argument
```

The same pattern is repeated for doors (`:2204`) and windows (`:2342`).

**Blast radius.** `test_units_boundary`, `test_wall_joins_matrix`, `test_mesh_hlr`,
`test_join_incremental`, `test_wall_joins`.

**Fix direction.** Only apply type parameters/name when the caller passed an explicit `type_id`.
Never overwrite explicit `name`/`thickness`; if a default type must be assigned, assign it without
mutating the caller's geometry parameters. Drop the `"10" in name` heuristic.

### BUG C — Phase 3.5 mementos: unsafe deepcopy + 17 commands with no-op undo

**C1. `DeleteElement` crashes.** `backend/command_bus.py:883`:

```python
meta_pre = copy.deepcopy(self.manager.element_meta.get(guid))
```

`add_wall` stores `"entity": wall` in the meta, so this raises
`TypeError: cannot pickle 'SwigPyObject' object`. `test_transactions` fails here.
The old path used `_clean_meta`, which exists precisely to strip entity refs.

**C2. Undo silently does nothing for 17 of 39 commands.** The dispatcher
`_execute_with_memento` ends with:

```python
else:
    res = self.execute_single_command(cmd_name, params)
    def undo_fn(mgr):
        pass                      # <-- no-op
    def redo_fn(mgr):
        self.execute_single_command(cmd_name, params)
    return CommandMemento(cmd_name, undo_fn, redo_fn), res
```

Only 22 commands have a real memento. **No-op undo for:** `SetWallJoin`, `ConstraintAlign`,
`ConstraintLockDim`, `ConstraintEqualize`, `SketchCurveAdd`, `SketchCurveMoveVertex`,
`SketchCurveMoveEdge`, `SketchCurveSetSlope`, `ElementCopy`, `ConstraintLockToggle`,
`ConstraintDelete`, `ElementUpdate`, `SheetCreate`, `SheetDelete`, `ViewportAdd`, `ViewportRemove`,
`ViewportMove`.

On `main`, undo used full-state snapshots and worked for every command. This is a functional
regression, not a refactor with equal behaviour.

**Consequences.**
- `test_sketch_mode` — undo does not restore the polygon (`len(meta_undone["polygon"]) == 6` fails).
- `test_sheets_pdf` — `undo ViewportMove`, `undo ViewportAdd`, `undo SheetCreate` all fail; the
  subsequent `redo()` then throws
  `ValueError: Sheet Number is already in use: 'A301'` because undo left the sheet behind and redo is
  not idempotent (`backend/command_bus.py:1061` re-executes `SheetCreate`).
- `test_transactions` — C1.

**Fix direction.** Either implement mementos for the remaining commands, or fall back to
`snapshot_state`/`restore_state` for anything not explicitly handled. Replace the raw `deepcopy` with
the entity-stripping helper. Also check the other Phase 3.5 mementos: `DeleteElement`'s undo
re-creates via `add_wall(name=meta_pre["name"])`, which BUG B then corrupts again.

## 3. Regressed suites and attribution

Attribution was determined experimentally by patching the engine in memory (disabling the type
layer; or nulling only the leaked `entity`) and re-running — no repo edits.

| Suite | Cause |
|---|---|
| `test_dimensions_crud`, `test_v2_core`, `test_sketch_model`, `test_hosted_openings`, `test_container_fidelity`, `test_http_container_roundtrip`, `test_ai_driver`, `test_bus_parity_audit` | BUG A |
| `test_units_boundary`, `test_wall_joins_matrix`, `test_mesh_hlr`, `test_join_incremental`, `test_wall_joins` | BUG B |
| `test_transactions` | BUG C1 |
| `test_sketch_mode`, `test_sheets_pdf` | BUG C2 |

## 4. Phase claims that do not hold

### Phase 1.3c — gate passes, budget does not
`scratch/test_mesh_hlr_incremental.py` passes **11/11** ✅. But `scratch/test_scale_gate.py` **fails**:

```
196 walls   edit 6.5 ms   slice 10.5 ms   TOTAL 17.0 ms   1.06x   -> FAIL (budget 16 ms)
```
`main` measured 16.4 ms, so this is not a new regression — but plan §0a.2 claims 12.2 ms / 0.76×
"inside", and the Phase 1 exit criterion says the budget is met at ~200 elements. It is not met on
this machine. The gate also still prints the stale note *"the remaining view cost is `_prepare`
reprojecting every mesh on a cache miss, which is the next Phase 1.3 step"* even though 1.3c is
marked done — please reconcile the note with the claim.

### Phase 2 — 2.6 is not implemented; 2.4 is unreachable; 2.7 is partial
- **2.2** ✅ persistence/round-trip real. ❌ claim "bumps `constraints_rev`" is false — only
  `dimensions_rev` + `project_rev` are bumped; `set_dimension_value` never touches `constraints_rev`.
- **2.3** ✅ real.
- **2.4** ⚠️ the in-canvas editor (`PlanViewport2D.tsx:2110-2154`) and `tryParseLength` are real, but
  **`createDimension` has zero callers** (`src/` only has an unused destructure at
  `PlanViewport2D.tsx:133`) and `DI` is `implemented: false`
  (`src/interaction/toolCaptions.ts:43`, `Ribbon.tsx:761`). No UI path creates a persisted dimension,
  so `self.dimensions` stays empty and the fallback `_overall_dimensions` dims have no `id` — the
  click guard `if (targetId)` at `PlanViewport2D.tsx:1291` is a silent no-op.
- **2.5** ⚠️ backend `_resize_wall_length` is real; non-wall temporary dimensions still
  `translateElement` (`src/store/useBimStore.ts:1237-1242`).
- **2.6** ❌ **false.** `refs` and `eq_group` are written (`ifc_service.py:3492-3493`) and **never
  read**; they are not in the plan contract (`:6008-6022`). The EQ badge calls
  `equalizeSouthWallWindows()` → `equalizeSpan(southWall, southWall, targets, 'x')`, so
  `total_span = pos_end - pos_start = 0` → `spacing = 0` (`ifc_service.py:3325-3332`) and every
  window collapses to `-width/2`. Locked-segment redistribution does not exist. The gate only asserts
  that `refs`/`eq_group` were *stored* (`test_dimensions_crud.py:245-255`).
- **2.7** ⚠️ `levels` contract + datum lines + bubbles + `LevelMove` are real. ❌ **grid spacing
  editable by dimension: no such code** — the grid contract carries only tag/`d`/`circle_center`
  (`ifc_service.py:5860-5866`) and grid click only selects (`PlanViewport2D.tsx:1007`).
- **2.8** ✅ real.

### Phase 3 — mostly real, two overstatements
- **3.1** ⚠️ moves both walls and recomputes joins ✅, but the claim "clamps within both wall extents"
  is **not in the corner path** (no clamp in `ifc_service.py:1419-1462`).
- **3.2**, **3.3**, **3.5** ✅ real (gate 30/30).
- **3.4** ⚠️ TR/SL/SO real; **`DI` is disabled** and absent from the hotkey table
  (`useBimStore.ts:967-1017`). The DONE note quietly drops DI from the claim.

### Phase 3.5 — gate passes, feature broken
`test_session_undo_memento.py` is 12/12 ✅, but it only covers the three commands that *do* have
mementos (`WallCreate`, `MoveElement`, `WallTrimExtend`). See BUG C.

### Phase 4 — mostly real, one missing candidate, zero gate coverage
Real: snap engine (`src/interaction/snapEngine.ts` — genuine intersection/perpendicular/midpoint
maths), F3 toggle, hover pre-highlight `#38bdf8`, window-vs-crossing selection, Ctrl-add, Tab-cycling,
wall chaining, ghost previews, in-canvas temporary dimensions.
- ❌ **4.1 `extension` snap candidate does not exist** — `SnapKind` is
  `'intersection'|'endpoint'|'midpoint'|'perpendicular'|'grid'` (`snapEngine.ts:14`); grep for
  `extension` in `src/` returns nothing. Also "SVG tooltips" are always-visible `<text>` labels.
- ⚠️ **4.6** "witness lines from real references" holds only for walls; for other elements
  `witnessP1/P2` are bbox centres (`useBimStore.ts:1090,1147-1152`), which the code itself admits at
  `:1069-1074`.
- ❌ **The plan's "Verification: `npm run check` (196 checks)" does not verify Phase 4** —
  `scripts/check-ui-p0.mjs` contains **zero** assertions for snaps, F3, hover, selection boxes or Tab.
  `snapEngine` has no test consumer at all.
- Dead/unwired: the grid fallback at `PlanViewport2D.tsx:437-441` is unreachable (engine always
  returns a grid candidate); `SnapOptions.points` is never supplied; Tab can never reach a level
  (the candidate scan omits `sliced2D.levels`); `activeSnapCandidate` is not cleared when snaps are
  toggled off (`PlanViewport2D.tsx:420`).

### Phase 5 — works in isolation, breaks 8 other suites
Real: Type Selector combobox, `EditTypeModal` parameter table + SVG preview + Duplicate,
type→instance propagation, `IfcRelDefinesByType`, gate 34/34 ✅.
But this phase is the source of BUG A and BUG B. Also:
- The compound layers table in `EditTypeModal.tsx:475-507` is **read-only display text** — no
  add/remove/edit (single-layer case only edits through the Thickness field).
- `_register_type_entity` wraps IFC creation in `except Exception: pass`
  (`ifc_service.py:536-537`), so a type can be in the registry but absent from the IFC.
- `TypeUpdate` undo uses `parameters.update(old_params)` (`command_bus.py:1015-1019`), so keys added
  by an edit are never removed on undo.

### Phase 6 — two concrete defects
- ✅ Sheet list, New Sheet, delete, viewport drag, hover delete, schedules (computed from live
  `elements`, CSV export) are real.
  Minor: auto-numbering is max+1 across all sheets using the *first* sheet's prefix, so with the
  default `A101`/`A201` you get `A202`, not `A102`.
- ❌ **In-place title-block editing is a silent no-op.** `SheetCanvas.tsx:103-108` sends camelCase
  `{ sheetTitle }`, `{ sheetNumber }`, `{ drawnBy }`, but `SheetUpdateParams._normalize_keys`
  (`command_bus.py:265-277`) only normalises the top-level `sheetId`, and `update_sheet`
  (`ifc_service.py:6095-6108`) reads only `sheet_title` / `sheet_number` / `drawn_by`. The command
  succeeds and changes nothing.
- ❌ **Batch PDF is not a set.** `SheetCanvas.tsx:84-92`:
  ```js
  svgContent: s.id === sheet.id ? currentSvgStr : currentSvgStr, // serializes set
  ```
  Every sheet maps to the same SVG — a 3-sheet export is 3 copies of the active sheet.

### Phase 7 — mostly real, several decorative controls
Real: OptionsBar mounted (`Ribbon.tsx:1263`) with genuine store bindings, ContextMenu in both
viewports with real store methods, hotkeys CS/WT/ZA/ZE/MD, Create Similar, Select All Instances,
selection outline, interactive flip arrow.
- ❌ **Door/window sill-height control does not exist** — `sillInput` is declared and never rendered
  (`OptionsBar.tsx:44`).
- ❌ "Contextual ribbon tabs with element-specific tools": only the **tab label** is contextual; it
  switches to the single generic `Modify` tab and the panel does not vary by element class
  (`Ribbon.tsx:181-196,503-515,1031+`). Many buttons are `renderDummyTool` (`Ribbon.tsx:335-347`).
- ❌ **Endpoint grips are visual only** — plain `<circle>` with no pointer handlers
  (`PlanViewport2D.tsx:2022-2040`).
- ⚠️ Decorative/uncontrolled: Align Multi/Lock checkboxes, "Tag on Placement", static Trim mode
  spans, static "Join Status: Allow" (`OptionsBar.tsx:174-179,202-205,216-224,234-242`).
- ⚠️ `ZA` and `ZE` dispatch the same `ZOOM_EXTENTS_EVENT`, so "Zoom All" is not distinct.

## 5. Frontend gates

`npx tsc --noEmit` ✅ and `npm run build` ✅. `npm run check` **exits 1** on Linux because
`scripts/check-delta-equivalence.mjs:44-69` hardcodes `.venv/Scripts/python.exe` and falls back to
bare `python`, which does not exist on Linux (system python is `python3`). That failure is not yours,
but it means "196/196 green" is Windows-only and is not evidence for Phases 4/5/6/7 — those check
scripts contain no assertions for any of those features.

Suggested: resolve the interpreter portably (`process.env.PYTHON ?? python3`) so the gate is honest
on both platforms.

## 6. Genuinely good work (keep it)

`snapEngine.ts` geometry; window/crossing selection; hover pre-highlight; split refusal/re-host/gap
semantics; level datum lines and bubbles; Type Selector + `EditTypeModal` structure; `ScheduleModal`
computed from the live store; ContextMenu; and the four new gates that pass:
`test_mesh_hlr_incremental.py` (11/11), `test_trim_split_gate.py` (30/30),
`test_session_undo_memento.py` (12/12), `test_type_layer_gate.py` (34/34).

## 7. Definition of done for the fix round

1. BUG A fixed — `save_orlt_project` succeeds on a fresh manager; `/api/project/export-bimworks`
   returns 200; `scratch/test_dimensions_crud.py` completes and reports its real count.
2. BUG B fixed — `add_wall(name="South", thickness=0.5)` preserves both.
3. BUG C fixed — `test_transactions`, `test_sheets_pdf`, `test_sketch_mode` green; no registered
   command has a no-op undo.
4. **Run the whole net, not just the new gates**, on your platform:
   ```bash
   for f in scratch/test_*.py; do ./.venv/bin/python "$f" || echo "FAIL $f"; done
   npm run check
   ```
   Target: no regressions versus `main` (i.e. only the two pre-existing failures —
   `test_update_roof` on a machine without the `Z:` drive, and the `test_scale_gate` budget).
5. Then correct the plan document: re-stamp only what the net proves, and either implement or
   explicitly re-open 2.6 (EQ chains), 2.7 (grid-dimension), 3.4 (DI), 4.1 (`extension`),
   4.6 (non-wall witness refs), 6 (title-block keys, batch PDF), 7 (sill height, contextual tab,
   grips).

**Note on the verification culture.** Each phase was verified with a narrow new gate that passes,
while the existing 22-suite net that the plan's own §0a.1 designates as the regression net was not
run. That is why Phase 5 could be "34/34 green" while breaking eight other suites. Run the net.
