# What has to change for BIMWorks to look and perform like Revit

**Subject:** `C:\Users\desig\Documents\GitHub\BIMWorks`, branch `gemini`, HEAD `318ce26`
**Scope of this analysis (as narrowed):** **basic architectural model editing and sheet management** —
a simplified Revit LT. Rendering pipelines, multi-user sharing and coordination are explicitly out of
scope. Plans, sections, sheets and vector PDF are in scope as *sheet management*, not as a rendering
project.

**Status of the branch:** roadmap P0–P7 are recorded COMPLETE in `docs/IMPLEMENTATION-PLAN-2026-10-14.md`.
Everything below is therefore *above* that line.

**Evidence standard.** All figures marked **[MEASURED]** were taken on 2026-10-14 against either the
live engine (`127.0.0.1:8008`, model `463-ADU_V9_4arch`, 176 elements, 5 levels, author tool
"Autodesk Revit 2027") or a controlled in-process sweep. Four independent audits were run in parallel
and are folded in with their own `file:line` citations:

| Audit | File |
|---|---|
| UI shell | `review/AUDIT-ui-shell-vs-revit.md` |
| Viewport interaction | `review/AUDIT-viewport-interaction-vs-revit.md` |
| Engine performance | `review/AUDIT-engine-performance-vs-revit.md` |
| Authoring capability | `review/AUDIT-authoring-capability-vs-revit.md` |

---

## 1. The answer in one page

For the narrowed scope, **the model layer is mostly there and the interaction and type layers are
not.** Walls, doors, windows, hosted openings with real IFC voids, joins, levels, grids, slabs, roofs,
views, viewports, sheets and vector PDF all work and are test-covered. What is missing is what makes it
*feel* like Revit:

| # | Gap | Why it blocks the goal | Effort |
|---|---|---|---|
| **1** | **Four cheap, currently-wrong defects** — units mislabelled in dimension text, Ctrl+Z/Ctrl+Y unbound despite tooltips, View Range silently drops 2 of 4 planes, the Project Browser shows seed data instead of project data | Each is small, each is visible in the first five minutes, and together they make the app read as unfinished. Nothing else can be judged until they are fixed. | **S** |
| **2** | **No direct manipulation** — no grips, no drag, no snapping, no reference-based temporary dimensions. In plan, a left-drag in select mode starts a **pan**; `grip`/`onPointerMove` have **0 hits** across all 22 source files | This is *the* Revit interaction: select → drag a handle → the model re-solves. Without it the app is a form-driven viewer. | **L** |
| **3** | **Editing is two independent O(N²) bottlenecks** — a single wall move recomputes joins against every wall (2,004,002 wall visits at N=1000), then re-renders the entire storey's 2D view. Measured **275 ms p50 per edit at 200 walls** against a 16 ms budget | Direct manipulation is impossible before this: at ~0.9 ms/wall for the slice alone, any drag blows the budget above ~15 walls. This is a **prerequisite** for gap 2, not a parallel workstream. | **L** |
| **4** | **No type layer** — no `IfcTypeObject`, no `IfcRelDefinesByType`, no `IfcPropertySet`, no type command. Type Selector is a read-only `<div>`; Edit Type is a hardcoded mock that reads nothing from the model | In Revit the type *is* the mechanism behind the Type Selector, Edit Type, and type propagation. It is also how a simplified Revit LT still feels parametric. Half of the "looks like a viewer" impression traces here. | **L** |
| **5** | **Sheet management is structurally correct but unpopulated** — no titleblock content editor, no sheet list, no auto-numbering, no export set, no print setup; views/sheets are hardcoded seed literals on fresh load | The user's second explicit requirement, and the one furthest from done relative to how good the underlying model already is. | **M** |

**Sequencing that matters:** gap 3 must land before gap 2, because a drag gesture on top of a 275 ms
edit path produces a feature that cannot be demonstrated. Gap 1 should land this week — it is hours of
work and it is what makes everything else credible.

---

## 2. The performance story, measured

### 2.1 The two bottlenecks, isolated

**[MEASURED]** Controlled sweep, same geometry, only N varies — 10 ft walls on a grid, built through the
same builders the bus uses:

| N walls | `slice2d` (2D view regen) | geometry buffers | ms/element (slice) |
|---|---|---|---|
| 13 (`sample_building.ifc`) | 8.4 ms | 0.1 ms | 0.65 |
| 50 | 44.5 ms | 0.1 ms | 0.89 |
| 200 | 616.1 ms | 0.4 ms | 3.08 |
| **1000** | **17,509.7 ms** | 2.2 ms | **17.51** |

**This is the headline.** Per-element cost rises **27×** from N=13 to N=1000 — the 2D view regeneration
is **super-linear** and is the dominant cost of every edit. The 3D geometry path is flat and effectively
free (2.2 ms at 1000 walls); mesh caching works as designed (`ifc_service.py:3461-3472`).

**[MEASURED]** The second bottleneck is independent and also O(N²). One `WallMove` transaction:

| N walls | tx p50 | snapshot (pre) | command (global joins) | partner calls | **wall visits** |
|---|---|---|---|---|---|
| 50 | 28.4 ms | 4.3 ms | 19.4 ms | 102 | 5,202 |
| 200 | 122.8 ms | 15.9 ms | 86.8 ms | 402 | 80,802 |
| 1000 | **992.4 ms** | 83.4 ms | **802.9 ms** | 2,002 | **2,004,002** |

`translate_element` calls the bare global `recompute_wall_joins()` with no `only=` argument
(`ifc_service.py:2022`), and the partner search scans all walls (`:2767`). **`dependency_graph.py`
exists, is tested, implements exactly the incremental behaviour needed — and is bypassed by every wall
drag.** It is used only in `_recompute_after_sketch` and `move_level`.

### 2.2 End-to-end, over HTTP (the real UI sequence)

**[MEASURED]** `POST /api/transaction` + `GET /api/state?since=`:

| N walls | transaction p50 | state p50 | **edit total p50** | p95 | delta bytes |
|---|---|---|---|---|---|
| 50 | 30.1 ms | 35.4 ms | 65.6 ms | 74.1 ms | 114,638 |
| 200 | 123.2 ms | 150.9 ms | **274.6 ms** | 279.2 ms | 413,728 |
| 176 (live model) | — | **2,192 ms** (delta, slice needed) | — | — | — |

**The budget is 16 ms** (`SPECIFICATION-v0.2.md` §19). At 200 walls the app is **17× over**; at 176
elements on the real Revit-authored model, a delta fetch cost **2,192 ms**, of which the engine
attributed **2,139.75 ms to `slice2d` and 0.13 ms to geometry**.

### 2.3 Payload: the drawing is 1 % of what moves

**[MEASURED]** At N=200, the delta is **99.6 % `slice2d`** — 442,482 bytes of re-rendered storey linework
wrapping a 1,107-byte mesh delta. `slice2d` was present on **12 of 12** edits. The delta protocol
genuinely works (Response A = 104 bytes / 3.1 ms, and delta equivalence showed **0 vertex mismatches**
over 6 sequential edits), but it optimises the envelope while the re-render stays full.

**A documentation claim is contradicted by measurement:** `docs/DELTA-MEASUREMENT.md:60` claims 76.8 %
payload reduction at 250 elements; the measured figure is **35.4 % at 200** (37.1 % at 50). The number
that matters for interactivity was never the reduction ratio — it is that the slice is regenerated
whole.

### 2.4 Undo re-serializes the entire model — twice per edit

`snapshot_state()` (`ifc_service.py:397-445`) deep-copies everything, including
`self.model.to_string()` (the whole IFC document → STEP) and every element's cached tessellation.
`execute_transaction` calls it **twice per transaction** and retains both in the undo stack
(`command_bus.py:642`, `:670-678`).

**[MEASURED]** 1,418,136 characters of STEP written twice per edit at N=1000 ≈ **83 ms**, and undo
consumes **3.79 MB per 10 edits at N=50, 14.58 MB at N=200**. Revit does this incrementally —
*episodes*, not snapshots (`DocumentIncrementTable::begin/end`, `DocumentHistory::getEpisode`).

### 2.5 There is no scale test at all

**No test in the repository measures 2,000 elements or 60 fps.** The largest corpus in any suite is
13–25 elements; no `range(...)` in `scratch/*.py` or `scripts/*.mjs` exceeds 200. The spec's §19 budgets
have never been measured, and the one committed drag figure
(p50 4.69 / p95 4.86 ms) comes from a **12-wall in-process corpus** that bypasses the bus, the
snapshots, HTTP and the slice. §0.2 of the plan flagged this class of defect; it is still the only
number on record.

---

## 3. Interaction: what is missing to *behave* like Revit

From `review/AUDIT-viewport-interaction-vs-revit.md` (12 areas, `file:line` cited).

**Absent entirely**

| Item | Evidence |
|---|---|
| **Direct manipulation** — grips, drag, witness lines | **0 hits** for `grip`/`onPointerMove` across all 22 files in `src`; in select mode a left-drag starts a **pan** (`PlanViewport2D.tsx:298-302`, `:288-410`) |
| **Snapping / inference** — endpoint, midpoint, intersection, face; toggle, override | only a blanket 0.25 ft grid snap and sketch-vertex snap (`PlanViewport2D.tsx:249-263`); `SnapEngine` appears in comments only |
| **Annotation as document objects** — text, dimensions, tags | disabled stubs (`toolCaptions.ts:38-45`); dimensions are renderer output; **tags are string properties on the tagged element**, not independent tracked objects, so the marker↔view graph has no substrate |
| **Levels drawn in views** | grids render with bubbles; levels are **never drawn**, and `moveLevel` — implemented, solver-propagated and tested — has **zero callers** in `src` |

**Present but not Revit's behaviour**

| Item | State |
|---|---|
| **Temporary dimensions** | measured distance is real, but it is **bounding-box centre-to-centre**, shown in a detached HTML pill at the viewport's top-centre; `witnessP1/P2` are computed and **never read**; editing translates the whole element rather than moving the referenced face |
| **Selection model** | single-click only — no window vs crossing, no Ctrl-add, no selection filter, no Tab-cycling; **hover pre-highlight is dead** (`setHoveredGuid` is never called) |
| **Ctrl+Z / Ctrl+Y** | **unbound**, while the ribbon tooltips advertise them (`App.tsx:40-64`, `Ribbon.tsx:181,188`) |
| **View Range** | per-view and persisted, but `top`/`bottom` test the mesh **base** only (geometry is never clipped), `view_depth` is a nearest-element flood fill, and the <6 ft rule is keyed on wall **height** rather than the cut plane's relation to the element |
| **Section box** | a **hardcoded volume** matching the sample building; `setSectionBoxBounds` is never called |
| **Lineweights** | the engine sends a full `{weight_mm, pattern, colour}` table per path; the frontend **ignores it** (`weight_mm` → 0 hits in `src`) |

**A live units bug worth fixing immediately** (verified directly at `ifc_service.py:3767`):
`"text": f"{length:.2f} m ({length * 3.28084:.1f}')"` — `length` is already **decimal feet**, so every
aligned dimension is labelled metres *and* multiplied by 3.28. A 30 ft wall draws as
**"30.00 m (98.4')"**. This is a P2 units-migration residue and it is the kind of error that destroys
trust in every other number on the drawing.

---

## 4. The shell: what "looks like Revit" concretely requires

From `review/AUDIT-ui-shell-vs-revit.md` (11 areas). Structure exists — ribbon, browser, properties,
dockview, status bar. The *furniture* does not.

| Absent | Evidence |
|---|---|
| **Options Bar** (context bar carrying the active tool's options and the Type Selector) | searched `OptionsBar`/`options bar` → **0 code hits** |
| **Right-click context menus, anywhere** | both `onContextMenu` handlers only `preventDefault` (`PlanViewport2D.tsx:553`, `Viewport3D.tsx:870`) |
| **Selection outline, grips, drag** | flat colour swap only (`Viewport3D.tsx:428-429`) |
| **Selection count** in the status bar | searched `selectedCount` → 0 |
| **Contextual tab** ("Modify \| Walls") | only the sketch-mode contextual tab exists (`Ribbon.tsx:249-264`) |

| Present but fake or partial | State |
|---|---|
| **Type Selector** | read-only `<div>` with a hardcoded fallback, not a combobox (`PropertiesPalette.tsx:183-197`) |
| **Edit Type dialog** | five hardcoded literals (10"/250mm, 2 HR, R-19.0, CMU, Exterior), reads nothing from the model, OK button only (`EditTypeModal.tsx:39-55`) |
| **Ribbon** | 4 of 7 tabs; no split buttons; no visible panel titles |
| **Hotkeys** | a real 3-character state machine, but only **6 of 22** advertised sequences bound |
| **Project Browser** | no right-click menus; missing Elevations/Ceilings/Schedules/Legends/Groups/Links; shows **seed data, not project data**, on fresh load (`useBimStore.ts:667`, `:720`; `App.tsx:23-27` never fetches views/sheets although `/api/state` returns them) |
| **View Range dialog** | collects four planes, writes **two** — `view_depth` silently discarded (`ViewRangeModal.tsx:46-78`) |
| **Dockable panels** | dockview is real and synced, but floating / pop-out / auto-hide were never enabled |
| **Keyboard focus** | no focus model at all — `tabIndex`, `document.activeElement`, `focus(` → 0 hits; modals have no focus trap |

**The two findings that should change priorities.** The plan records finding N11 as "Fixed by P0"; the
audit confirms Area/Volume genuinely are fixed, but **Edit Type remains a live trust hazard the plan
believes is closed**. And the gate suite (`check:ui`, 130 checks, passing) asserts *truthfulness*, not
*Revit parity* — a shell can pass all 130 and look nothing like Revit. That gap is why the rest drifted,
and it is the first thing to close.

---

## 5. The model: what "authors like Revit" requires at LT scope

From `review/AUDIT-authoring-capability-vs-revit.md`. The bus holds **31 typed commands** — 6 create, 2
datum, 3 generic edit, 5 modify, 1 join, 5 constraint, 4 sketch, 5 sheet/viewport — the parity gate
passes and covers 29 UI actions.

**Working and test-covered (do not rebuild):** hosted openings with real `IfcOpeningElement` voids and
host-deletion cascade; openings follow a host move; grids written to IFC as real `IfcGrid`/`IfcGridAxis`;
views and viewports as separate document objects; roof sketches persisted in the overlay; sheets with
placement constraints and vector PDF export; atomic transactions with undo/redo; a working AI planner
(105/105 tests).

**The type layer is absent and is the root of the "not parametric" impression.** [PROBED] zero type
entities, no `IfcRelDefinesByType`, no `IfcPropertySet` in an authored model. `type_properties` are
hardcoded dicts (`ifc_service.py:1424-1430`) that `update_element` **ignores entirely** — so even the
fake types cannot be changed. There is no `type_id` on `element_meta` and no `Type*` command.

**Missing for LT-scale architectural editing specifically:**

| Missing | Note |
|---|---|
| **Mirror** | the highest-leverage single missing command; Pin and Create Similar follow |
| **Groups** | the data model that also makes Array honest and gives `delete_element` the deletion closure the spec already requires |
| **Compound structure / layers** | [PROBED] all `IfcMaterial*` counts 0; committed in SPEC §3.3(2), and layer joins are the largest untested geometric dimension |
| **Schedules** | browser stub `schedules: false`. Cheapest large perceived capability: the query engine already exists (`ai_driver.py:109`) and a schedule is a *rendered query* placed like a viewport |
| **Tags** as tracked objects | precondition for the marker↔view graph |

**Two inconsistencies an author hits within minutes:** only **roofs** get a sketch on creation while
floors are bare polygons — and `_edit_sketch` hard-routes to `set_roof_sketch` and raises for non-roofs
(`ifc_service.py:641-642`, `:1806-1811`); and `GridCreate`/`LevelCreate` are implemented, tested and
undoable **but marked `implemented: false`** in the ribbon (`toolCaptions.ts:38-39`), so the datum tools
are dead for want of a viewport branch.

**Explicitly out of scope for a simplified Revit LT** (confirmed against the audits rather than assumed):
curtain walls, stairs, railings, topography, MEP, `.rvt` interop, and a Family Editor UI — the corpus
shows the Family Editor alone is four subsystems, a formula solver with four levels of cycle detection,
a reference system and a visibility model. The type layer is the honest 80 %.

---

## 6. One policy worth revisiting

The plan's §1 sets *"no REA/binary analysis of Revit"*, on the grounds that "no running Revit was
observed" and that public documentation plus live probes suffice.

Two facts argue for reopening it. **REA is installed and working on this workstation** — v6.5.0 with
Ghidra 12.1.4, verified end-to-end against this workspace's own Revit 2010 artifacts: `inspect` on
`Revit_NT_RevitUI.dll` reproduced the documented figure exactly (image base `0x10000000`, 7 segments,
`.text` 574,464 bytes, **11,071 procedures, 9,263 strings**). And **the corpus the spec already cites as
`[REA]` evidence** — wall corner resolution, host-element editing, the 2D editor, editing interaction,
views/sheets/tag tracking — is binary-derived, so the policy and the evidence base contradict each other.

For LT-scope questions the binaries are the only remaining primary source: *does Revit re-cut an opening
when host wall thickness changes?*, *is a type parameter set an `IfcPropertySet` or a custom pset?*,
*what does View Range's View Depth actually do?* None are answered at the required detail by the public
API documentation, and a live probe cannot see the semantics either.

**Recommendation:** restore REA as a first-class ground-truth source for behaviour questions, keep live
probes for UI-level questions, and keep the rule that every finding names its tool and is evidence-graded.
This is already paid for and it reduces the largest remaining risk — guessing at Revit semantics.

---

## 7. The plan, in order

Sequenced by dependency. Effort: **S** ≤ 1 day, **M** ~ week, **L** weeks.

### Phase 0 — Stop the visible bleeding (S, this week)

Nothing here is large; everything here is currently wrong and user-visible.

| # | Change | Files |
|---|---|---|
| 0.1 | **Fix the dimension units bug** — remove the `3.28084` re-scale and the `m` label; format feet-inches | `ifc_service.py:3767` |
| 0.2 | **Bind Ctrl+Z / Ctrl+Y**; finish the Esc contract | `App.tsx:40-64` |
| 0.3 | **Persist all four View Range planes** — `view_depth` is currently collected then discarded | `ViewRangeModal.tsx:46-78` |
| 0.4 | **Feed the Project Browser and Ribbon from the engine** on mount instead of seed literals — the data is already returned by `/api/state` | `App.tsx:23-27`, `useBimStore.ts:667`, `:720`, `:1427-1443` |
| 0.5 | **Fix the alignment guide** (drawn at the midpoint of two elements' union bounds, not the constrained coordinate) and the **section box** (hardcoded volume) | `PlanViewport2D.tsx:83,95`, `useBimStore.ts:676` |
| 0.6 | **Add a Revit-parity gate** to `check:ui` so the shell cannot regress on furniture that exists | `scripts/check-ui-p0.mjs` |

### Phase 1 — Make editing fast enough to be interactive (L) — *gates everything else*

Do this **before** building drag, because a drag on a 275 ms edit path cannot be demonstrated.

| # | Change | Expected effect | Files |
|---|---|---|---|
| 1.1 | **Route `translate_element`/`update_element` through `DependencyGraph.recompute([guid])`**; delete the global `recompute_wall_joins()` calls | ~992 ms → ~190 ms per tx at N=1000 | `ifc_service.py:2022`, `:2359` |
| 1.2 | **O(1) join-partner lookup** via a coordinate-keyed endpoint index | removes the N² term (2,004,002 wall visits) | `ifc_service.py:2767`, `dependency_graph.py:93-98` |
| 1.3 | **Revision-keyed slice cache + incremental HLR.** Cache the composite per (view, revision); re-project only dirty GUIDs; spatial index for the O(N²) view-depth closure; bound the growing occluder union | slice 17,509 ms → seconds at N=1000; delta 444 KB → ~2 KB | `mesh_hlr.py:116-164`, `:231-266`, `:390-476`; `main.py:1062` |
| 1.4 | **Command-scoped memento instead of two full `snapshot_state` copies** | −166 ms/tx at N=1000; −2.4 MB undo RAM per 10 edits | `command_bus.py:642`, `:677`, `ifc_service.py:397-445` |
| 1.5 | **Scope the constraint solve** to the affected component | 31 participants → 3 | `constraint_solver.py:110-137`, `:224-250` |
| 1.6 | **Commit the scale gate** — assert p95 latency and delta bytes at N ∈ {50, 200, 1000} | converts the missing measurement into enforcement | `scripts/`, `package.json` |

**Exit criterion:** an edit at 200 walls completes in < 16 ms engine-side and the delta is bounded by
what changed, measured by an asserting test.

### Phase 2 — Direct manipulation (L) — *the headline fidelity gap*

Follow the corpus's design, which is not the obvious one: **do not build a grip system.** Revit has no
`Grip` class; a shape handle is a *pick tagged as a handle control*, recognised by a move helper, and
snapping is a composable filter that *emits* snap objects
(`direct-manipulation-datums-walls-placements.md:17-36`, `:47-70`).

| # | Change | Files |
|---|---|---|
| 2.1 | **Typed pick model** + shape handles + wall-endpoint drag, joins recomputed inside the drag path | new `src/interaction/pick.ts`, `moveHelper.ts`; both viewports |
| 2.2 | **SnapEngine** — typed candidates (endpoint, midpoint, intersection, face), alignment guides, toggle/override | new `src/interaction/snapEngine.ts` |
| 2.3 | **Real temporary dimensions** — reference-based, in-canvas, witness lines, moves the referenced face | `useBimStore.ts:952-1077`, both viewports |
| 2.4 | **Levels and grids as draggable datums** — draw levels, expose the finished `moveLevel` path (currently zero callers) | `ifc_service.py:4366-4487`, `PlanViewport2D.tsx:654-689` |
| 2.5 | **Selection model** — window vs crossing, Ctrl-add, Tab-cycling, live hover pre-highlight | `useBimStore.ts:514`, `:1029`, both viewports |
| 2.6 | **Optimistic client apply** so repaint is not gated on the round trip | `useBimStore.ts:2168-2193`, `Viewport3D.tsx:389-483` |

### Phase 3 — The type layer (L) — *what makes it parametric*

| # | Change | Files |
|---|---|---|
| 3.1 | **`type_registry` + `type_id` on every element + `Type*` commands**, written to IFC as `IfcWallType`/`IfcDoorType`/… + `IfcRelDefinesByType` + `IfcPropertySet` | `command_bus.py`, `ifc_service.py` |
| 3.2 | **Real Type Selector** (combobox) and **real Edit Type dialog** bound to the registry | `PropertiesPalette.tsx:183-197`, `EditTypeModal.tsx:39-55` |
| 3.3 | **Type-driven propagation** through the dependency graph — editing a type re-drives its instances | `update_element`, `dependency_graph.py` |
| 3.4 | **Compound structure / layers** on the type — `IfcMaterialLayerSet` + `IfcMaterialLayerSetUsage` and priority ordering first; defer wrapping-at-inserts geometry | `ifc_service.py` |

### Phase 4 — Sheet management (M) — *the second explicit requirement*

The model is already right — view and viewport are separate objects with placement constraints and
vector PDF export, tested 88/88. What is missing is everything an architect touches around it.

| # | Change |
|---|---|
| 4.1 | **Real sheet list in the browser** (numbers, names, revision, size) with right-click Rename / Duplicate / Delete, replacing seed literals |
| 4.2 | **Titleblock as content** — editable sheet number, name, drawn-by, date, scale, and project parameters, persisted in the overlay |
| 4.3 | **Auto-numbering and scoped numbering** for sheets and views (the model already rejects duplicates: "Sheet Number is already in use") |
| 4.4 | **Export set** — select sheets, batch vector PDF, per-sheet and combined, remembering the last selection |
| 4.5 | **View creation from the browser** and view naming/duplication; today only a fallback fabricates "Floor Plan: Level 1" over a Roof Plan |
| 4.6 | **Schedules and Tags** — a schedule is a rendered query and the query engine already exists (`ai_driver.py:109`); placement follows the viewport pattern. Tags unlock the marker↔view graph |

### Phase 5 — Close the shell furniture (M–L, parallelisable)

Options Bar (including a Type Selector slot, which needs Phase 3) · right-click context menus in the
browser and both viewports · contextual tab on selection · selection outline + grips + count ·
the remaining 16 hotkeys · keyboard focus model and modal focus trap · enable dockview floating /
pop-out / auto-hide · full Project Browser branches.

### Phase 6 — Modify tools and small consistency fixes (S–M)

Mirror (highest-leverage single missing command), Pin, then Groups (which also gives Array a data model
and `delete_element` its deletion closure); make **floors sketch-based like roofs**; revive the
Grid/Level ribbon tools and fix `translate_element` on `IfcGrid`, which today mutates meta only and lets
a moved datum diverge from `model.ifc`.

---

## 8. Honest summary

BIMWorks is a working, well-tested IFC authoring application with a genuinely good engineering culture —
atomic bus, parity gates, fidelity suites, and a documentation habit of recording gaps rather than hiding
them. For **basic architectural model editing and sheet management**, most of the model layer is already
done, and the sheets subsystem is better than its UI suggests.

It is not Revit, and it cannot become Revit by adding features. For this scope it needs four things:

1. **Four one-day fixes**, because several visible things are currently wrong.
2. **Two O(N²) paths removed** — global join recompute and full-storey view re-render — because
   everything interactive depends on it.
3. **A handle/drag interaction model**, which the project has never had in any form.
4. **A type layer**, which is what separates a parametric BIM author from an IFC editor.

The order matters more than the list. Phase 0 and Phase 1 come first because without them the rest
cannot be verified or even felt — and that is precisely how the current gap grew unnoticed behind 130
passing checks, a 35 %-instead-of-77 % claimed improvement, and a roadmap marked complete.
