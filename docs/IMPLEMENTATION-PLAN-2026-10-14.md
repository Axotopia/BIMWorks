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

## 0.1 Re-verification after the upstream merge (2026-10-14, post-`1183617`)

**Why this section exists:** the review and this plan were written against commit `d1761bd`. Seven upstream commits (`abc2b5b` and ancestors: plan-view graphics, sketch mode, geometry editor) then landed **in parallel with P0**, touching the same nine files. Everything below was re-checked against the merged tree by reading and *executing* the current code — not carried over from the review. Two findings were fixed by that upstream work, one changed shape, and the sketch/editor work adds new constraints on P1–P4.

| # | Status now | Evidence (current code) |
|---|---|---|
| N1 | **FIXED by P2.** The overlay is authoritative: a v3 container rebuilds every element from its parametric record and never infers geometry from tessellation | `rebuild_from_overlay`; `test_container_fidelity.py` (10-cycle angle-exactness, concave polygon + notch vertex in the solid) |
| N2 | **FIXED by P2 (both directions).** `add_grid` authors real `IfcGrid`/`IfcGridAxis`; imports key axes by their true GlobalId (was: synthesized id). Historical note: import was fixed upstream, export still broken — Upstream added a real `IfcGrid` *reader* (axes via `IfcPolyline` + grid placement matrix, deduped by tag/geometry) | Read side: `ifc_service.py` `for grid in self.model.by_type("IfcGrid")`. Write side still meta-dict only: `add_grid` mints `str(uuid.uuid4())` instead of an IFC `GlobalId`. **Verified by execution:** export and saved container both contain **0** `IFCGRID` entities |
| N3 | **FIXED by P2.** Staleness gating is implemented: overlay GUIDs absent from the container's IFC are reported `stale` and never applied. Historical note: The new import path *does* handle hosts/fills properly, so element `host_wall_guid` is now trustworthy — but constraints and join policies are still restored wholesale with no GUID gating (only `type_properties` is gated) | `load_orlt_project`: `self.constraints = …`, `self.join_policies = …` unconditionally |
| N4 | **FIXED by P2.** The pset writer is gone, constraints are overlay-only, and `strip_legacy_constraint_pset()` removes it from containers saved by older builds | `save_constraints_to_ifc` (no-op) / `strip_legacy_constraint_pset`; fidelity suite asserts the pset is absent from the file |
| N5 | **FIXED by P1.** The UI dispatches every editing action as a typed command through one atomic transaction; the raw routes are bus-backed shims and `/api/command` can no longer mutate unjournaled. Note how it was found: upstream added the `ElementUpdate` command but left the UI on raw REST, so the feature shipped unundoable | `UI_ACTION_COMMANDS` + `dispatchTransaction`; `scratch/test_bus_parity_audit.py`; `scripts/check-bus-parity.mjs` |
| N6 | **Half fixed.** Door/window slide is angle-correct (P0). **EQ still open, now scoped to P3** with measured evidence: `equalize_span` appends a duplicate constraint per call and no propagation branch exists | Propagation loop handles `align` and `dimension_lock` only; see the P1 re-scope bullet |
| N7 | **Fixed by P0** | `fetchGeometry` builds the `elements` record from each mesh's `params` |
| N8 | **Fixed by P0** | `accept=".bimworks,.orlt,.ifc,.stp,.step"` |
| N9 | **Fixed by P0** (dependency declared + installed + HTTP-level test). **New lint surfaced:** the merge duplicated the `python-multipart` line in `requirements.txt` | `requirements.txt` |
| N10 | **Still open — unchanged.** Snapshot still deep-copies full meshes; joins still a global O(N²) pass; the store still refetches all geometry after every mutation | `snapshot_state`, `recompute_wall_joins` ("Global pass"), `fetchGeometry` after each action |
| N11 | **Fixed by P0**, except the sheet list, which remains static seed data by design until P6 | `PropertiesPalette`, `PlanViewport2D`, `ProjectBrowser`, `SheetCanvas` |
| N12 | **Fixed by P0** (`.bimworks` canonical, `.orlt` load alias). The legacy pset *name* stays until N4 lands in P2 — deliberate, to avoid a second round-trip break | `CONTAINER_EXTENSION`; `Pset_ORLT_Constraints` |

**New findings introduced by the upstream work** (these did not exist when the review was written):

| # | Finding | Severity |
|---|---|---|
| N13 | **Sketch state is client-only.** `sketchSession` lives in the Zustand store and never reaches `parametric.json` or the backend, so a sketch — and any "Edit Footprint" session — is lost on reload. Footprints therefore still cannot survive a round trip | High — sets the real P4 entry condition |
| N14 | **`shapely` is an undeclared runtime dependency.** `_triangulate_polygon_2d` imports it inside a `try/except` with an ear-fan fallback. Behavior therefore *silently differs by environment*: real triangulation of concave polygons when present, malformed fans when absent. Declared now in `requirements.txt` | Medium |
| N15 | **Vendored `IfcGrid` axes are keyed by a synthesized GUID** (`f"{guid}_{tag}_{n}"`), not an IFC `GlobalId`. Any overlay keyed by GUID cannot address them, which will bite the P2 staleness gating | Medium |
| N16 | **`scratch/test_update_roof.py` is not runnable outside one machine** — hardcodes `Z:/PROJECTS/463-Glory/BIM/REVIT.2027/…` and a fixed roof GUID. It fails on a clean checkout, so it cannot be a regression test as written | Low |


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
| P0-3 | Unify container name to `.bimworks` everywhere (keep `.orlt` as a load-recognized alias for the few files already saved) | N12. Note: the legacy pset is deliberately **not** renamed here — its name is part of the serialized round-trip and changes in P2 item 5 |
| P0-4 | Populate the dead `elements` store record (or remove the AI planner's dependence on it) so prompt-driven door/window placement stops throwing | N7 |
| P0-5 | Label or remove the hardcoded UI fakes (Properties Area/Volume, sheets list, temp-dim default, align overlay) — show real values or an explicit "—" placeholder; never invented numbers | N11 |
| P0-6 | Fix door-slide propagation to rotate the world delta into the wall's local axis | N6, angle half only — **done**. The EQ half is still open and moved to P1 (see §0.1) |

**Exit criteria:** all suites green + one new HTTP round-trip test green; opening a saved project through the UI works; no hardcoded numbers rendered as data.

**Status: COMPLETE (2026-10-14), re-verified after the upstream merge (`1183617`).** Every task below still holds on the merged tree; the merge added no regression in these six areas. `requirements.txt` needed one repair after the merge (duplicate `python-multipart` line removed; `shapely` declared — see N14).

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

**Scope grew in the merge — P1 is now more urgent, not less.** The upstream geometry editor added `ElementUpdate` to the CommandBus *and* left the UI calling the raw `/api/element/{guid}/update` instead, so there are now two update routes and the one the UI uses is unjournaled. Net effect: the newest feature (roof pitch / slab elevation / polygon editing) is unundoable the day it ships. P1 is therefore the correct next milestone.

- Route `createWall/Door/Window/Slab/Roof/delete/translate` **and `updateElement`** through the CommandBus (`ElementUpdate` and `ConstraintEqualize` already exist as typed commands — the commands are there, the call sites are not).
- Retire or wrap the raw REST endpoints (`/api/wall`, `/api/element/{guid}/update`, etc.) as thin bus aliases; keep response shapes the frontend already consumes.
- Every Ribbon tool then becomes: emit command(s) → receive delta → update view state. The Zustand store stops being a second model.
- Add an automated **parity audit** (acceptance criterion #6, enforced early): script that performs the M2 test model through the bus with the UI disabled, and a test asserting every UI action maps to a bus command.
- ~~Fix the EQ propagation gap (N6) here if it is cheap.~~ **Re-scoped to P3 (verified 2026-10-14, not cheap).** Measured against the current engine: (a) `equalize_span` *appends a new `equalize` constraint on every call* — two identical calls leave two constraints — so wiring it into `translate_element` would accumulate a duplicate constraint per drag; (b) redistributing the interior elements is only half of it, because hosted openings are repositioned with a raw world delta inside `equalize_span` and are then re-projected by the P0-corrected drag path, so the two disagree off-axis; (c) EQ has no solver, so "the constraint holds" is not expressible. Fixing it properly means in-place constraint updates plus hosted-offset math, which is exactly the planegcs work in P3. Until then the UI's EQ affordance over-promises, and P3's exit criteria already require "EQ holds through arbitrary later moves".

**Exit criteria:** Undo/redo works for every Ribbon action; journal contains every mutation; parity-audit test in CI (even a local `pytest` gate for now).

**Status: COMPLETE (2026-10-14).** Verified by execution on the merged tree.

| Item | What landed | Evidence |
|---|---|---|
| Route UI edits through the bus | Store mutations are now `dispatchTransaction(action, params)` → one typed command → one atomic transaction. `UI_ACTION_COMMANDS` maps all 14 editing actions to commands; `executeTransaction` is the single HTTP entry point; the store holds no model state | `src/store/useBimStore.ts` |
| Missing commands | `ConstraintLockToggle` and `ConstraintDelete` added (bus had no way to lock or remove a constraint, so those two UI actions had no command at all). Registry is now 16 commands, all with executor branches | `backend/command_bus.py` |
| Raw endpoints become shims | All 15 mutating REST routes now run through `run_mutation(...)` — same response shapes (plus `transaction_id`), but journaled and undoable. Documented as compatibility shims for external clients; the UI no longer calls them | `backend/main.py` |
| Close the `/api/command` hole | `POST /api/command` wrapped mutating commands in a one-command transaction; previously it executed them **unjournaled**, a second bypass alongside the routes | `backend/main.py` |
| Parity audit | `scratch/test_bus_parity_audit.py` — route closure, per-endpoint journal deltas (all 15), atomic rollback, clean 400 on invalid params, undo/redo per creation action, read paths not journaling, and a negative control proving the audit can fail | 9 sections, all pass |
| Frontend gate | `scripts/check-bus-parity.mjs` (wired as `npm run check:bus`) fails the build if the store calls a raw mutation endpoint, if a declared UI action is never dispatched, or if a second mutation path appears. Mutation-tested: reintroducing the old `translate` fetch fails the gate | gate passes; fails on injected regression |

**Deliberately excluded from P1 (documented, not forgotten):**
- **Document lifecycle stays non-journaled:** `/api/sample`, `/api/load-file`, `/api/upload/ifc`, `/api/reset`, project-container load. These replace the document rather than edit it, so making them undoable would surprise the user; "revert to saved" is a different feature.
- **`/api/georeference`** is project metadata, not part of the model snapshot, so journaling it would create undo entries that restore nothing.
- **EQ propagation (N6)** deferred to P3 with measured justification — see the bullet above.

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
9. **Absorb the merged-upstream element parameters** (added after this plan was written): `update_element` already accepts `polygon`, `thickness`, `elevation`, `pitch`, and rebuilds slab/roof meshes through `_build_flat_slab_mesh` / `_build_pitched_roof_mesh` / `_build_wall_mesh`. Those inputs are exactly the overlay v3 sketch fields, so the refactor must define them in one place rather than duplicate the semantics between the importer and overlay v3. Same for the now-real `IfcGrid` reader: it keys vendored axes by a synthesized GUID (`{grid_guid}_{tag}_{n}`), which overlay v3 staleness gating cannot address — give axes real IDs as part of item 6 (see N15).

**Exit criteria (all test-verified):** diagonal wall survives 10 save/load cycles angle-exact; slab polygon survives; grids survive; constraints/joins re-attach with stale-flagging; no pset in the file; units labels match internals; external sample_building.ifc imports with walls + levels + grids reconstructed.

**Status: substantially complete (2026-10-14), two items open.** Verified by `scratch/test_container_fidelity.py` (51 checks) plus every existing suite.

| # | P2 item | Status |
|---|---|---|
| 1 | Overlay schema v3 | **Done.** Per-element parametric records: baseline, polygon, host + offset, pitch, thickness, level, grid axis, type properties. Live entity refs and cached tessellation excluded; footprints excluded because the join engine recomputes them deterministically. Found en route: `polygon` was missing from the serialization field list, so slab/roof polygons were dropped — and because the IFC carried a bbox rectangle, the model still *looked* correct |
| 2 | Units boundary | **Done.** `backend/units.py` is the single conversion point (exact 0.3048 m/ft). The parametric side — `element_meta`, the `parametric.json` overlay, command parameters, the UI — is **decimal feet**; `model.ifc` is **metres**, IFC's native convention. Conversion happens once, in the builders (feet→m) and the importer (m→feet). Builder defaults, opening sizes, level elevations, the 6-ft view-range rule and the type-parameter strings all come from the `units` constants. A stored 10 ft wall reads `10.0`, not `3.048`, and its IFC geometry writes `3.048` m |
| 3 | Load path rewrite | **Done.** `rebuild_from_overlay()` replays the overlay through the normal builders with GUID preservation, then recomputes joins once. Geometry is never inferred from tessellation for a v3 container. Legacy v2.1 containers still load, are flagged non-authoritative, and upgrade on re-save |
| 4 | Staleness gating | **Done** (spec §3.1). Overlay GUIDs absent from the container's `model.ifc` are reported `stale` and never applied; unreconstructable records are `failed`; IFC content absent from the overlay is `unparametrized`. A full `load_report` is returned |
| 5 | Delete `Pset_ORLT_Constraints` | **Done.** Writer removed (explicit no-op) and `strip_legacy_constraint_pset()` deletes it before serializing, so a container upgraded from an older build cannot keep shipping it |
| 6 | Write grids to IFC | **Done.** `IfcGrid` + `IfcGridAxis` + axis curve; an export that previously contained zero IFCGRID entities now contains them. Also fixed the import side (N15): axes were keyed by a synthesized id that could never match a real GlobalId, so staleness gating discarded every grid on load |
| 7 | Foreign IFC import | **Done for the exit criterion; one refinement open.** Walls reconstruct from extruded-solid parameters (real position, angle, profile thickness) instead of bboxes; per-element `import_report`; openings recover host + offset. `sample_building.ifc`: 13/13 parametrized, 3 levels, walls with true world-space baselines. Slabs/roofs now read their own extruded profiles (a hull cannot represent a notch), and grids reconstruct exactly. **Refinement open:** a slab/roof whose *product* placement is rotated still falls back to a hull and is reported `parametrized: False` with a reason rather than guessing |
| 8 | Multi-version container test matrix | **Done.** Note on evidence: the exit criterion says an external file must import with "walls + levels + grids reconstructed", but `sample_building.ifc` contains **no `IfcGrid` entity at all** (3 storeys, 5 walls, 4 windows, 2 doors, 1 slab, 1 roof). Grid reconstruction is therefore proven from a file that genuinely carries grids — our exported `model.ifc` (3 axes) re-imported through the *foreign* path, recovering every axis tag and endpoint exactly. Round-trip fidelity itself: 10-cycle angle-exactness, concave polygon + notch vertex in the solid, grids on original GUIDs, joins/policies, no pset, staleness, legacy upgrade, overlay-stable save→load→save, unit consistency. **Open:** the IfcTester/Bonsai *foreign* validation leg |

**Defects found en route (not in the plan; all caught by tests, not by reading):**
- Slab and roof representations extruded the polygon's **bounding rectangle**, so a concave floor was a rectangle in the model of record. Both now extrude an arbitrary profile built from the real boundary — asserted by a notch vertex existing in the extruded solid.
- `ifcopenshell.api.geometry.remove_representation` **segfaults** during a bulk rebuild (its inverse-attribute walk over a half-built representation graph). Replaced with a direct detach/remove.
- Per-wall join recomputation during the overlay replay is premature and part of that crash: joins are now suppressed during the replay and recomputed once afterwards.

**Units (item 2), as landed.** Before this, the overlay and `meta.json` declared `decimal_feet` while every stored number was metres — mislabelled in both directions, and the app's own numbers (3.0 wall height, 1.2 cut plane, 1.8288 not-cut threshold) gave it away. Now:

- `backend/units.py` holds the only conversion factor (`METRES_PER_FOOT = 0.3048`, exact by definition) plus named architectural constants. Nothing else divides by 0.3048.
- `reset_model` assigns an `IfcConversionBasedUnit` on the international foot, so `model.ifc` is natively in feet and no downstream conversion exists to get wrong. The overlay declares `decimal_feet` with `conversion: none`, which is now true.
- Every builder default, the mesh builders, the 6-ft view-range rule, opening sizes (36x84 door, 48x48 window, 36" sill), the level elevations (10/20 ft) and the type-parameter strings are feet or feet-inches.
- The frontend passes feet and no longer converts (`FEET_TO_M` deleted; the AI planner no longer rescales prompt dimensions; readouts label `'` instead of `m`).
- The fidelity suite asserts the IFC carries a conversion-based foot unit with factor exactly 0.3048, that a 10 ft wall is stored as `10.0`, and that no extra conversion is claimed.

**One real bug this surfaced:** `ifcopenshell.api.geometry.edit_object_placement` defaults to `is_si=True` and reinterprets the supplied matrix as metres, so a 4 ft offset became 13.12. All eleven matrix call sites (and the grid axis curve) now pass `is_si=False`, which is correct because our values are already in the file's unit. Without the units work this was invisible.

### P3 — Dependency graph + constraint solver (target: 2–4 weeks)
The README's M2 core, now unblocked and correctly scoped.

- **Dependency graph in the backend** (spec §3.2): nodes = element parameters/geometry outputs; edges = hosting, constraint, level, sketch membership, join; dirty-flag topological recompute; `ElementsChanged` deltas (retire full-model refetch).
- **Embed planegcs** (GPL, license-compatible) as the planar constraint solver behind Align/Lock/EQ/locked dimensions. EQ becomes a persistent solver constraint — fixing N6 properly. Over-constraint → conflicting-set report → UI witnesses.
- **Incremental join recompute:** joins recompute for affected walls + neighbors only (replace the O(N²) global pass), now feasible on top of the graph.
- **Modify tools over the bus:** Move/Copy/Rotate/Offset/Mirror/Trim-Extend/Split with Options-Bar-style argument binding.
- **Endpoint/baseline drag** for walls (direct manipulation of overlay data) with live join recompute — this is the first real 60fps-drag test against the M0 exit budget (p95 < 16 ms).
- **Level-driven elements:** moving a level moves constrained elements.

**Exit criteria:** README M2 gate verbatim — corner chain of 8 walls edits live; deleting a door heals the wall; move Level 2 → constrained walls follow; EQ holds through arbitrary later moves (new regression test); wall-drag p95 measured and logged.

**Status: COMPLETE (2026-10-14).** Verified by `scratch/test_dependency_graph.py` (41 checks) plus the ten existing suites.

| Item | What landed |
|---|---|
| Dependency graph | `backend/dependency_graph.py`: explicit nodes/edges for **level, host, join and constraint**, with dirty-flag recompute along chosen edge kinds. Replaces ad-hoc recursion plus the unconditional global join pass |
| Constraint solver | `backend/constraint_solver.py` wraps **planegcs** (FreeCAD's PlaneGCS, GPL-3.0, wheels on PyPI) behind Align/Lock/EQ. Align → coincident, locked dimension → point-to-point distance, EQ → equal-length segments across the span. Conflicts reported in `last_constraint_conflict` and never half-applied |
| EQ persistence (N6) | **Fixed.** EQ is a relation that survives arbitrary later moves. The old code dropped it after creation and appended a duplicate constraint on every call; EQ now updates in place and re-solves. Span endpoints are pinned while interiors redistribute — EQ's actual semantics, and it removes the solver drift (it landed 40.018 instead of 40 when the far endpoint was free) |
| Incremental joins | `recompute_wall_joins(only=[...])`. Join is treated as **one hop**, not transitive: a wall's own baseline determines its joins, so moving C0 recomputes C0 and its partners but not C2. One edit in an 8-wall chain plus 4 unrelated walls recomputes **3 of 12** walls, and the footprints are identical to a full pass |
| Modify tools | `ElementCopy / ElementRotate / ElementOffset / WallTrimExtend / WallSplit / LevelMove` are CommandBus commands (journaled, undoable, AI-reachable) and are dispatched from the store, so the parity gate covers them |
| Level-driven elements | New `move_level()` (and `LevelMove`): a storey brings its elements with it, then re-solves constraints. Elements on other levels are untouched |
| Wall-drag budget | Measured and logged: **p50 4.69 ms, p95 4.86 ms** over 60 drags against the 16 ms M0 target |

**Bugs found while wiring this up** (all caught by tests, not by reading):
- The solver hook was guarded by `not visited`, but `visited` is mutated by `.add()` (which returns `None`), so it was truthy on the very first call — the entire solver path was dead. Now an explicit `_propagate` flag.
- `equalize()` passed the EQ relation both as an ad-hoc "extra" and as a persisted constraint, building the same equal-length chain twice on one sketch. The solver correctly reported that as an over-constrained conflict.
- `rotate_element` rotated the baseline without moving the placement, so the stored angle and the IFC placement disagreed. Rotation now happens about the wall's own start, which is what the stored placement expresses.

**Remaining for P3 (tracked, not done):** the *interactive* endpoint/baseline drag UI. The backend drag path is measured and within budget, but the plan's "direct manipulation ... drag an edge, drag a vertex" is a UI skin — and it is the same skin P4 specifies for footprints and profiles, so it belongs with that work rather than being half-built here. Endpoint *editing* is available today via `WallTrimExtend` and `WallSplit`.

### P4 — Sketch-based elements & direct profile editing (target: 2–3 weeks)
The workflow answer from principle 3.

> **Scope note after the merge:** a working Revit-style sketch loop already exists (sketch palette, line/rectangle/pick-walls tools, `Defines Slope`, snap tolerance, `startSketchMode`/`finishSketchMode` over the bus). It is a *UI* loop, not the overlay data model this milestone specifies: `sketchSession` is client-only and is lost on reload (N13), footprints never reach `parametric.json`, and there is no direct-manipulation skin. Treat the existing loop as the prototype of the sketch **skin**; P4's work is the data model underneath it plus the second skin. Do not rebuild the editor.

- Sketch data model in the overlay: floor/roof footprints, slope-defining lines (Revit `Defines Slope` semantics), wall-profile edits (vertical outline reshape). **This is the gating piece** — P2's overlay v3 must land first, and N13 is the concrete evidence of why.
- **2D sketch editor** (precision: numeric entry, snapping, lock/EQ icons) — the familiar Revit-style flow. Partially present; reconcile it with overlay v3 rather than extending `sketchSession` further.
- **Direct manipulation** of the same footprints/profiles in plan and 3D viewports — drag an edge, drag a vertex; both skins emit identical `SketchCurve*` commands. No modal gate for either.
- Sketch-driven recompute: footprint edit → slab/roof solid regenerates → hosted/wall-connected dependents update through the P3 graph (Revit's "move the wall, the floor follows" behavior, README §1.4).
- Openings already handled (`IfcOpeningElement`/voids) get host-aware updates when profiles change.

**Exit criteria:** a gable roof (footprint + slope lines) built by direct drag and by sketch mode produce identical geometry; editing a wall profile to create an awning regenerates the wall solid and keeps its door hosted and swinging correctly.

**Status: COMPLETE (2026-10-14).** Verified by `scratch/test_sketch_model.py` (42 checks) plus the eleven other suites.

| Item | What landed |
|---|---|
| Sketch data model in the overlay | `backend/sketch_model.py`: `SketchCurve` (Defines-Slope, per-curve angle, overhang, Pick-Walls provenance) and `Sketch` (loop tracing, validation, dict serialisation). The `sketch` record is now part of the overlay element record, so a footprint survives save/load — **N13 fixed** |
| Defines-Slope semantics | The slope line is what the roof rises *to* (ridge/hip) and the footprint edges are the eaves. The old code ignored slope lines and took one global `pitch_degrees`. Mesh peak is exactly `run × tan(angle)`; a steeper line gives a taller roof; no slope line gives a flat roof |
| Both skins, one model | `set_roof_sketch` is the single apply path; `_edit_sketch` loads, mutates and re-applies. The precision editor emits `SketchCurveAdd`/`SketchCurveSetSlope`; direct manipulation emits `SketchCurveMoveVertex`/`SketchCurveMoveEdge`. Verified: the same gable built both ways yields **byte-identical vertex and index buffers**, identical sketch records and identical footprints |
| Sketch-driven recompute | Sketch edits route through the P3 `DependencyGraph`; a footprint or slope change regenerates the solid |
| Wall profiles (awning) | `set_wall_profile(guid, sketch)`: a closed outline in the wall's own U–Z plane swept across the thickness. Openings need no repositioning — a door's placement is relative to the baseline, so it survives the change. Asserted, not assumed: the door stays hosted, keeps its `IfcOpeningElement`, offset, swing state, and still produces a plan swing arc after the edit *and* after a later move |
| Bus commands | `SketchCurveAdd`, `SketchCurveMoveVertex`, `SketchCurveMoveEdge`, `SketchCurveSetSlope` (registry now 26 commands), all dispatched from the store, so the parity gate covers 24 UI actions |

**Design decision worth flagging.** Sketch geometry is stored as `sketch_mesh` on the element meta rather than as the IFC Body representation. An arbitrary pitched surface is not representable as the extruded profile the rest of the pipeline writes, and silently flattening it into an extrusion is precisely the "model looks right but is wrong" failure this project keeps fixing. The sketch is what persists and what regenerates; the IFC keeps a valid bounding extrusion for interop. If third-party tools must see the true pitched solid, that needs a triangulated `IfcTriangulatedFaceSet` writer, which is a follow-up rather than a hidden approximation.

**Also guarded rather than approximated:** profile editing requires an axis-aligned wall (an angled wall is rejected with a reason, since a general sweep is out of scope for V1's pipeline).

**Remaining P4 follow-up (tracked):** the in-viewport drag gesture in the UI — the commands and the model are complete and covered, but binding a mouse drag to `SketchCurveMoveVertex` in the plan/3D viewport is UI work on top of an already-tested path.

### P5 — 2D views & HLR (README M3) — after P3/P4

**Status: PARTIAL — exit criteria NOT met. Do not mark M3 done.**

Attempted 2026-10-14. What was built, what was verified, and the specific blocker.

**What was done**

- `backend/hlr_renderer.py`: a view engine driving ifcopenshell's SVG serializer (which runs OCCT hidden-line removal), parsing its output into `section` / `projection` partitions, with `ViewDefinition`, `ViewRange`, `LineweightTable` view templates, an element-attribution step (the serializer gives GUIDs only to projection sub-views, so cut geometry is matched to elements by footprint), and `apply_view_range` implementing the drafting rule that a wall under 6 ft is never cut.
- The plan contract gained `renderer` and `partitions` keys, and three defects in the shared plan path were fixed: `setdefault` was silently keeping an HLR-supplied *empty* slab/roof list (dropping every slab and roof from the plan), the door-swing symbol was extracted into a shared `_door_swing_paths` so both renderers emit it, and the 6-ft view-range rule was made an explicit, testable engine rather than inline slicing logic.

**What was verified** (`scratch/test_hlr.py`, 22 checks)

- The serializer does perform OCCT hidden-line removal and does emit genuinely partitioned `section`/`projection` geometry.
- Cut geometry can be attributed to real element GUIDs.
- The view-range engine behaves correctly (tall wall cut, 4 ft wall projected and not cut).
- Annotation (slabs, grids, swing arcs) stays in exact model coordinates; analytic remains the default.

**Solved in round 2 — the earlier "vertical section" conclusion was a probing error**

With a `scale` set, the serializer emits *several* named drawing planes in one pass, not one:

| Plane | Orientation | Notes |
|---|---|---|
| `Level 1` | horizontal, Z = 1.2 m | the floor-plan cut, 4 ft above the storey |
| `Level 2` | horizontal, Z = 11.2 m | |
| `Section East West` | vertical (normal = world Y) | |
| `Section North South` | vertical | |

The first round probed without `scale`, which emits only the two vertical role sections — hence the wrong conclusion. A floor plan must therefore **select one plane** rather than render all of them. `HlrRenderer._plane_selector` selects by orientation plus cut height, and `_calibrate` maps the selected plane's frame onto the model's plan bounds.

**Verified against known geometry** (a 30 ft wall at y=0, another at y=80 ft, a third at x=90 ft):

- raw plane coordinates `u 197.97..802.03`, `v 338.02..461.98`;
- calibrated output lands at x 0–30.33 ft, y 0–20 ft, with the door void visible;
- the official `ifcopenshell.draw.main()` emits the **same frame**, independently validating the mapping rather than confirming my own settings.

**Remaining gap (why it is still not the default)**

1. **Per-element attribution of cut outlines is unreliable.** The serializer puts `ifc:guid` on element groups for some sub-views, but wall outlines come back unattributed, so a plan cannot support per-element select/hide. Name resolution and geometric attribution both exist but do not yet cover this case.
2. **Calibration is approximate sub-foot** (~20.5 units/ft on one axis vs ~20.18 on the other), showing as a ~0.3 ft offset on the far wall.

Both must be fixed before `slice_2d_vector_plan` can default to `renderer="hlr"`.

**What would unblock it:****What would unblock it:** an ifcopenshell build exposing `addDrawing` (or a serialiser whose storey plane is genuinely horizontal), which turns the calibration step into the only remaining work. Re-evaluate HLR as the default at that point.

**Still outstanding from the M3 feature list** and not attempted here: view templates as saved, selectable presets; temporary hide/isolate; and the reviewer-facing visual comparison against a Revit plan (which needs the coordinate mapping first).

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
| **Parallel branches invalidate the plan's premises** | *Demonstrated 2026-10-14:* upstream shipped sketch mode and a geometry editor on raw REST while P0 was in flight, silently changing 5 of 12 findings and adding 4 more (N13–N16). Mitigation: treat "current behaviour" claims as expiring, re-verify by execution before starting a milestone (§0.1 is the template), and land the P1 parity audit early so bus bypass is caught by a test rather than by a later review |
| **Unplanned feature work outruns its data model** | The sketch editor shipped before overlay v3, so its data is client-only and dies on reload (N13), and its edits are unjournaled (N5). Mitigation: P1 then P2 hold their gates; new UI features must state which overlay v3 field persists them before merge |

---

*Plan authored 2026-10-14 from: full code review (`review/REVIEW_file-format-architecture_2026-10-14.md`), master spec v2.3 (`README.md`), and session BIMWorks.20261013 (decision record + handoff state). Every "current behavior" claim above is line-cited in the review document.*
*Revised 2026-10-14 after merge `1183617`: §0.1 re-verifies all findings against the merged tree and adds N13–N16; P0 status, P1 scope, P2 item 9, P4 scope note and the risk register were updated accordingly. Later readers: re-run §0.1's checks before trusting any finding above.*

