# BIMWorks — Updated Implementation Plan (2026-10-14)

**Supersedes:** the M0–M5 sequencing in `README.md` §8 (roadmap content remains valid; the *order and entry criteria* change).
**Inputs:** Master spec v2.3 (`README.md`), the 2026-10-13 working session (BIMWorks.20261013), and the full code review of 2026-10-14 (`review/REVIEW_file-format-architecture_2026-10-14.md`).

---

## 0. Where we actually are (evidence-graded)

**Decisions that stand (signed off 2026-10-13, re-affirmed 2026-10-14):**

| Decision | Status |
|---|---|
| Hybrid project container: IFC model of record + `parametric.json` overlay | **LOCKED** — strategy re-confirmed as correct (IFC disclaims recompute semantics; FreeCAD/Bonsai precedents) |
| GPL-3.0 | LOCKED |
| Internal units: decimal feet | LOCKED (but internals are currently metric — see P0-2) |
| Schema of record: IFC4 ADD2 TC1, IFC4.3-ready by design | LOCKED |
| AI-first via typed CommandBus; UI is a skin on the bus | LOCKED (but currently violated — see P1) |

**Verified working (tests executed 2026-10-13 and re-executed 2026-10-14):**
- Transaction engine with full-state snapshot undo/redo — `test_transactions.py` 28/28.
- Wall-join Phase A geometry (miter/butt/square-off/T-junction/disallow) in 3D solids + 2D plan cleanup — `test_wall_joins.py` 18/18.
- CommandBus: 13 typed commands, JSON Schema 2020-12 export, batched transactions — `test_v2_core.py`.
- View-range 2D slicing with the Revit <6 ft not-cut rule; georeferencing (IfcProjectedCRS + IfcMapConversion); PyMuPDF vector sheet PDF.

**New findings from the 2026-10-14 review that the 10-13 session did not know** (each one changes the plan):

| # | Finding | Severity |
|---|---|---|
| N1 | `.orlt` round-trip is **lossy by construction**: the overlay stores no baseline geometry, so reload rebuilds walls from tessellated **bounding boxes** — diagonal walls silently snap to 0°/90°, slab/roof polygons degrade to rectangles, door offsets approximate (`ifc_service.py:2037–2059`) | **Critical** — invalidates the current load path as a foundation |
| N2 | **Grids are never written to IFC** — `add_grid` is a meta-dict only; imported IfcGrids are fabricated `[-5,0]→[15,0]` (`ifc_service.py:718–740, 1968–1969`) | High |
| N3 | Overlay constraints/join-policies re-attach with **no GUID-staleness gating** (spec §3.1 requires flagging) (`ifc_service.py:1860–1861`) | High |
| N4 | Constraints double-persist in the **rejected `Pset_ORLT_Constraints` pset**; round-trip depends on it | High |
| N5 | **UI bypasses the CommandBus** via raw REST (`useBimStore.ts:764–849`) — Ribbon-created walls are unjournaled; Undo silently no-ops | **Critical** — breaks acceptance criterion #6 (AI parity) and the transactional invariant |
| N6 | **EQ constraints have no propagation branch** — they silently stop holding after later moves; door-slide math ignores wall angle (`ifc_service.py:838, 862–884`) | High |
| N7 | Store field `elements` is declared but **never populated** → AI planner host-wall lookup always sees zero walls (`useBimStore.ts:39, 258`) | Medium (blocks prompt bar) |
| N8 | Open dialog `accept=".ifc,.stp,.step"` **excludes `.orlt`** (`Ribbon.tsx:374`) — opening your own saved project via the Open button is broken | Medium (one-line fix) |
| N9 | `python-multipart` undeclared/uninstalled → HTTP `/api/project/load-orlt` 500s (tests pass only by bypassing HTTP) | Medium |
| N10 | O(model) costs everywhere: full-STEP+mesh snapshot per edit, full-mesh JSON refetch per action, O(N²) global join recompute — the spec's own 2,000-element / 60fps budgets are unreachable on this architecture | High (gates M0 exit criteria) |
| N11 | UI fakes presented as real data: hardcoded Area/Volume/constraints in Properties palette, hardcoded sheets A101/A201, hardcoded temp-dimension default, align overlay at hardcoded coords | Medium (trust hazard) |
| N12 | Naming split: spec says `.bimworks`, code says `.orlt` (leftover from the pre-rename "Open-Revit-LT" name in the 10-13 session) | Low |

**Session handoff question, answered:** the 10-13 session ended asking "next: #5 external IFC import, or #3 units?" — **neither, as originally framed.** Improving the bbox-import heuristics (the obvious #5 fix) would be throwaway work, because the overlay-as-truth refactor (P2 below) replaces that load path entirely; and the units fix is a 30-minute item best done inside the same refactor. Both are folded into P2.

---

## 1. Architecture principles for everything below

These three principles resolve the review's top risks and unlock the workflow goals from the 2026-10-14 discussion:

1. **Overlay is the parametric truth; IFC is the geometric model of record.**
   `parametric.json` (keyed by GUID) owns: element baselines/sketches/footprints/profiles, parameters, constraints, join policies, grids, levels, view definitions, type parameter schemas. IFC owns: spatial hierarchy, solids, openings/voids, materials — the thing other tools open. Load = rebuild elements *from the overlay*, regenerate geometry; never infer from tessellation. Save = write both.
2. **The CommandBus is the only mutation path.** UI, tests, and the AI planner all emit the same typed commands. Anything that bypasses the bus is a bug (this retroactively makes N5 a P0-class defect, not a refactor item).
3. **Sketch mode is a skin, not a gate.** Revit LT's modal "edit footprint → 2D sketch → Finish" loop is a UX choice, not a data-model requirement. Because profiles/footprints live as first-class overlay data, BIMWorks implements *direct manipulation* (drag a roof edge / wall-profile vertex in plan or 3D → typed `SketchCurve*` commands → recompute) **and** a precision 2D sketch editor — two skins over the same commands. This is only possible after P2 and P3; it is the headline workflow differentiator vs Revit LT (which has no API at all).

**Reverse-engineering policy (decided 2026-10-14):** no REA/binary analysis of Revit. Revit's behavior is documented at primary-source level (already mined in README §1/§12). Ground truth for ambiguous behavior = live probes in the user's Revit LT (recorded evidence-graded in `docs/probes/`) + the open-source `revit-ifc` exporter for import compatibility. REA stays available only for the narrow case of a `RevitAPI.dll` managed-assembly question that survives docs + probing.

---

## 2. The plan

### P0 — Stop the bleeding (target: 1–2 days)
Small, independent, each with a regression test where applicable.

| # | Task | Notes |
|---|---|---|
| P0-1 | Fix Open-dialog `accept` to include `.orlt`/`.bimworks` | N8; one line in `Ribbon.tsx:374` |
| P0-2 | Add `python-multipart` to `requirements.txt`; add an HTTP-level round-trip test that exercises `/api/project/load-orlt` for real | N9; prevents "tests pass, app broken" recurrence |
| P0-3 | Unify container name to `.bimworks` everywhere (keep `.orlt` as a load-recognized alias for the few files already saved) | N12 |
| P0-4 | Populate the dead `elements` store record (or remove the AI planner's dependence on it) so prompt-driven door/window placement stops throwing | N7 |
| P0-5 | Label or remove the hardcoded UI fakes (Properties Area/Volume, sheets list, temp-dim default, align overlay) — show real values or an explicit "—" placeholder; never invented numbers | N11 |
| P0-6 | Fix door-slide propagation to rotate the world delta into the wall's local axis | N6 (angle bug only; EQ fix lands in P3) |

**Exit criteria:** all suites green + one new HTTP round-trip test green; opening a saved project through the UI works; no hardcoded numbers rendered as data.

**Status: COMPLETE (2026-10-14).** Verified by execution, not by reading:

| # | What landed | Evidence |
|---|---|---|
| P0-1 | Open dialog accepts `.bimworks`/`.orlt`/`.ifc`/`.stp`/`.step`; the handler routes both container extensions | `Ribbon.tsx`; `tsc --noEmit` clean, `vite build` clean |
| P0-2 | `python-multipart>=0.0.9` declared **and installed**; new suite boots uvicorn and drives real multipart upload/download over HTTP | `scratch/test_http_container_roundtrip.py` — 8 checks incl. a clean 400 on garbage input |
| P0-3 | Canonical extension `.bimworks` end to end (backend default path, `Content-Disposition`, frontend download/upload, docs); `/api/project/export-bimworks` + `/load-bimworks` canonical, old routes kept as deprecated aliases; `.orlt` still loads | `test_v2_core.py` (canonical + legacy-name load), HTTP test steps 4–6 |
| P0-4 | `/api/geometry` meshes now carry a `params` record (baseline, host, offsets); store populates the `elements` record from it; planner derives host + clamped offset from real wall length | HTTP test step 8; offset-parser cases checked (size strings are not offsets) |
| P0-5 | Area/Volume measured from the tessellated surface (`utils/geometry.ts`); Length/Height from engine params; untracked constraints read "Not tracked"; view rows read the active view; temp dimension no longer invents a 12′-0″ default and moves on its measured axis; align overlay drawn at the constrained elements' real coordinates; Families list and sheet title block are live data | `tsc --noEmit` clean; `src/utils/geometry.ts`, `useBimStore.ts`, `PlanViewport2D.tsx`, `PropertiesPalette.tsx`, `ProjectBrowser.tsx`, `SheetCanvas.tsx` |
| P0-6 | Hosted elements are placed in the host's rotated frame, and `translate_element` projects the world delta onto the wall axis | `scratch/test_hosted_openings.py` — 0°/90°/45°/30°/−60° + container round-trip |

**Deliberately *not* fixed here (pre-existing, belongs to P2):** imported containers are still reconstructed from tessellation bboxes, so a diagonal wall still comes back axis-aligned and the loaded door's world placement is not re-projected onto the re-imported baseline. Test 6 of `test_hosted_openings.py` asserts what P0-6 owns (the slide offset and host binding survive) and documents the rest as N1/P2.

### P1 — Bus-only mutations (target: ~1 week)
Converge every UI action onto the CommandBus before any new feature lands.

- Route `createWall/Door/Window/Slab/Roof/delete/translate` and selection-driven edits through `POST /api/bus` (typed commands, transactions, journal).
- Retire or wrap the raw REST endpoints (`/api/wall` etc.) as thin bus aliases; keep response shapes the frontend already consumes.
- Every Ribbon tool then becomes: emit command(s) → receive delta → update view state. The Zustand store stops being a second model.
- Add an automated **parity audit** (acceptance criterion #6, enforced early): script that performs the M2 test model through the bus with the UI disabled, and a test asserting every UI action maps to a bus command.

**Exit criteria:** Undo/redo works for every Ribbon action; journal contains every mutation; parity-audit test in CI (even a local `pytest` gate for now).

### P2 — Overlay-as-truth refactor (target: 2–3 weeks) ← *the decisive milestone*
This merges the session's open items #3 (units) and #4 (pset) and reframes #5 (import). Nothing else ships features until this lands.

1. **Overlay schema v3** (`schema_version: 3`): per-element records with full parametric definition — wall baseline (start/end), height, thickness, location-line; slab/roof sketch polygons + slopes; door/window host GUID + offset along wall + width/height/sill; grids (axes, label, extent); levels; constraints; join policies; view definitions; type-parameter schemas. All lengths decimal feet.
2. **Units boundary:** convert metric internals → decimal feet at the serializer/store boundary exactly as spec §11.3 describes; single conversion function, nothing else knows mm/meters exist.
3. **Load path rewrite:** `load_bimworks_project` = rebuild `element_meta` + IFC model *from the overlay*, then regenerate geometry through the existing builders (join engine included). The tessellation-bbox importer survives **only** for foreign IFC files.
4. **Staleness gating:** overlay entries whose GUIDs are absent from the IFC are flagged `stale` in a load report and never silently applied; IFC entities absent from the overlay are imported via the foreign path and reported as `unparametrized` (spec §3.1 finally implemented).
5. **Delete `Pset_ORLT_Constraints`**; constraints live in the overlay only.
6. **Write grids to IFC** as real `IfcGrid`/`IfcGridAxis` on save.
7. **Foreign IFC import (old #5), scoped honestly:** reconstruct walls (from `IfcWallStandardCase` parameters/profiles, not bboxes), levels, grids, openings; anything not reconstructable loads as geometry-only with a per-element report. Perfect fidelity for arbitrary files is explicitly out of scope until P3's type system exists.
8. **Multi-version container test matrix:** save → load → save byte-comparison of overlay (normalizing timestamps), plus save → foreign round-trip through Bonsai/IfcTester validation.

**Exit criteria (all test-verified):** diagonal wall survives 10 save/load cycles angle-exact; slab polygon survives; grids survive; constraints/joins re-attach with stale-flagging; no pset in the file; units labels match internals; external sample_building.ifc imports with walls + levels + grids reconstructed.

### P3 — Dependency graph + constraint solver (target: 2–4 weeks)
The README's M2 core, now unblocked and correctly scoped.

- **Dependency graph in the backend** (spec §3.2): nodes = element parameters/geometry outputs; edges = hosting, constraint, level, sketch membership, join; dirty-flag topological recompute; `ElementsChanged` deltas (retire full-model refetch).
- **Embed planegcs** (GPL, license-compatible) as the planar constraint solver behind Align/Lock/EQ/locked dimensions. EQ becomes a persistent solver constraint — fixing N6 properly. Over-constraint → conflicting-set report → UI witnesses.
- **Incremental join recompute:** joins recompute for affected walls + neighbors only (replace the O(N²) global pass), now feasible on top of the graph.
- **Modify tools over the bus:** Move/Copy/Rotate/Offset/Mirror/Trim-Extend/Split with Options-Bar-style argument binding.
- **Endpoint/baseline drag** for walls (direct manipulation of overlay data) with live join recompute — this is the first real 60fps-drag test against the M0 exit budget (p95 < 16 ms).
- **Level-driven elements:** moving a level moves constrained elements.

**Exit criteria:** README M2 gate verbatim — corner chain of 8 walls edits live; deleting a door heals the wall; move Level 2 → constrained walls follow; EQ holds through arbitrary later moves (new regression test); wall-drag p95 measured and logged.

### P4 — Sketch-based elements & direct profile editing (target: 2–3 weeks)
The workflow answer from principle 3.

- Sketch data model in the overlay: floor/roof footprints, slope-defining lines (Revit `Defines Slope` semantics), wall-profile edits (vertical outline reshape).
- **2D sketch editor** (precision: numeric entry, snapping, lock/EQ icons) — the familiar Revit-style flow.
- **Direct manipulation** of the same footprints/profiles in plan and 3D viewports — drag an edge, drag a vertex; both skins emit identical `SketchCurve*` commands. No modal gate for either.
- Sketch-driven recompute: footprint edit → slab/roof solid regenerates → hosted/wall-connected dependents update through the P3 graph (Revit's "move the wall, the floor follows" behavior, README §1.4).
- Openings already handled (`IfcOpeningElement`/voids) get host-aware updates when profiles change.

**Exit criteria:** a gable roof (footprint + slope lines) built by direct drag and by sketch mode produce identical geometry; editing a wall profile to create an awning regenerates the wall solid and keeps its door hosted and swinging correctly.

### P5 — 2D views & HLR (README M3) — after P3/P4
Unchanged from spec §4.1 (in-process OCCT `HLRBRep` pipeline replacing the analytic-slice renderer), with one reordering consequence: the analytic slicer built in the 10-13 session is the *fallback* renderer until P5, and should not receive further investment beyond bug fixes.

### P6 — Sheets, PDF, validation (README M4); P7 — AI driver layer (README M5)
Unchanged in content from the spec; entry criterion for P7 is now strictly gated on the P1 parity audit having been green since P1 (the AI plans against the same bus the UI uses — any residual raw-REST path would poison it). The regex prompt-planner is explicitly a placeholder until then.

---

## 3. What does *not* change

- Milestone *content* of README M1–M5 (Tauri shell, dockview, HLR, sheets, MCP server, eval harness) — all still valid; only the ordering and entry gates above are new.
- The C++ engine decision (§0 row 2) — the Python sidecar is acknowledged as prototype scaffolding; the P2/P3 refactors are deliberately structured so the graph, solver, and overlay logic move into the engine process without rewrites of their contracts.
- Licensing map (§10) and all legal notices.

## 4. Risk register (updated)

| Risk | Mitigation |
|---|---|
| P2 rewrite balloons | Overlay schema v3 is additive to the existing container; the bbox importer stays as fallback; byte-level round-trip test matrix catches regressions |
| Frontend drifts while backend refactors | P1 lands *before* P2 so the store consumes deltas, not raw REST |
| O(model) costs discovered late in P3 | Performance budgets (p95 drag, 2k-element recompute) are measured in P3's exit criteria, not deferred |
| Scope pull toward families/Family Editor | Remains deferred (spec §3.6, M6) — the type-parameter schema in overlay v3 is the planned extension seam |
| Revit-behavior disputes ("what does Revit actually do?") | `docs/probes/` evidence-graded protocol; `revit-ifc` source for import questions; no binary reversing (decided above) |

---

*Plan authored 2026-10-14 from: full code review (`review/REVIEW_file-format-architecture_2026-10-14.md`), master spec v2.3 (`README.md`), and session BIMWorks.20261013 (decision record + handoff state). Every "current behavior" claim above is line-cited in the review document.*
