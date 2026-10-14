# BIMWorks M0/M1 Prototype Review — File Format, Architecture, Completeness
**Date:** 2026-10-14 · **Scope:** every file listed in the task brief, read in full (README.md 484 lines, SPEC.md, ifc_service.py 2,121 lines, useBimStore.ts 1,319 lines, all 5 scratch tests, sample_building.ifc).
**Verification note:** all line numbers refer to files as read this session. The three backend suites were *executed*: `test_transactions.py` 28/28 pass, `test_wall_joins.py` 18/18 pass, `test_v2_core.py` all pass (13 command schemas exported).

---

## 1. FILE FORMAT — what is actually saved/loaded today

### 1.1 The container exists, but it is named `.orlt`, not `.bimworks`
- README/decisions say **`.bimworks` hybrid zip = `model.ifc` + `parametric.json` + views + meta** (README.md:9, README.md:157–167, SPEC.md:114–122, SPEC.md:329).
- The code implements the same structure under the name **`.orlt`**:
  - Endpoints: `POST /api/project/export-orlt` and `POST /api/project/load-orlt` (backend/main.py:458–482, section header "GLM SPEC v2.1 ENDPOINTS: HYBRID .ORLT CONTAINER" main.py:454–456).
  - `save_orlt_project()` (backend/ifc_service.py:1756–1833) and `load_orlt_project()` (ifc_service.py:1835–1885).
- So: **a hybrid IFC-inside-JSON-sidecar zip container — yes; native IFC round-trip as the project format — no; `.bimworks` naming — not implemented.** The spec's `views/*.json`, `cache/meshes.bin`, and `meta.json` journal-tail are partially present (one hardcoded view, no cache, no journal).

### 1.2 Exact save path (`save_orlt_project`, ifc_service.py:1756–1833)
1. `self.model.write(ifc_temp.name)` → real IFC4 STEP text (1772–1774).
2. `parametric.json` overlay (1777–1791) contains **only**: `schema_version`, `internal_units: "decimal_feet"` (mislabeled — see 1.5), `constraints` dict, `join_policies` dict, and `elements` = `{guid: {ifc_class, name, type_properties, join_policy}}`. **It does NOT contain baseline geometry** (start/end/height/thickness/angle/footprint/elevation/pitch/offset_along_wall are absent).
3. `views/default.json` — a single hardcoded Level-1 floor-plan view (1794–1808).
4. `meta.json` — app/version/license/units/count/timestamp (1811–1820).
5. Zip with `ZIP_DEFLATED`: `model.ifc`, `parametric.json`, `views/default.json`, `meta.json` (1822–1826).

### 1.3 Exact load path (`load_orlt_project` → `load_ifc_content` → `load_ifc_file`, ifc_service.py:1835–1897, 1899–2116)
- Reads `model.ifc` from the zip and calls `load_ifc_content` (1854–1855), i.e. **the same generic external-IFC import path as any foreign file**. Geometry is then **rebuilt from tessellated bounding boxes**, not from IFC parametric entities:
  - `ifcopenshell.open()` (1901), spatial containers reset (1918–1922), storeys → levels (1925–1955).
  - Every `IfcProduct` tessellated with `ifcopenshell.geom.create_shape` (1995–2021).
  - **Wall reconstruction heuristic (2037–2059):** `if dx >= dy` → wall is treated as horizontal (`angle = 0.0`), else vertical (`angle = π/2`). **Diagonal/angled walls are silently re-aligned to an axis**; `thickness = max(dy, 0.15)`, `height = max(dz, 2.5)`, `length = dx or dy` — all inferred from the world-space bbox of the tessellation.
  - Door/window `offset_along_wall` recomputed as the Euclidean distance of the fill's bbox center from the host wall start (2093–2104) — an approximation that is wrong for diagonal hosts.
  - Overlay re-attach (1857–1868): `constraints` and `join_policies` are **restored wholesale with no GUID-staleness check** (contradicting SPEC.md:125 "flagged stale, never silently applied"); only `type_properties` is GUID-gated (1863–1866).
- The frontend then re-pulls everything: `loadOrltFile` → fetchProjectState/fetchGeometry/fetch2DSlice/fetchConstraints/fetchWallJoins (src/store/useBimStore.ts:963–1001).

### 1.4 Round-trip data loss — concrete list
| Data | Survives save? | Survives load? | Evidence |
|---|---|---|---|
| Wall baseline (start/end/angle) | In IFC placement + baked footprint profile | **No** — rebuilt from bbox; diagonal walls become axis-aligned | ifc_service.py:2037–2049 |
| Join-trimmed footprint polygons | Baked into `IfcArbitraryClosedProfileDef` in IFC | Only as tessellation; meta footprint lost (slice falls back to plain rect, 1575) | ifc_service.py:1339–1382, 1575 |
| Grids | **Never written to IFC at all** — `add_grid` (718–740) stores only a Python-dict meta with a random uuid, no `ifcopenshell` call; sample_building.ifc contains zero `IFCGRID` entities | **Lost entirely**; external IfcGrid entities found on import get fake geometry `start [-5,0] → end [15,0]` (1968–1969) | ifc_service.py:718–740, 1958–1970 |
| Constraints | Double-written: `parametric.json` **and** pset `Pset_ORLT_Constraints` on IfcProject (`save_constraints_to_ifc` 1384–1409; `load_constraints_from_ifc` 1411–1425) | Yes (from pset at 2109 and overlay at 1860) — two sources of truth; README itself flags this as the rejected hack (README.md:36) | ifc_service.py:1384–1425 |
| Door/window offsets | In IFC placement | Approximate (bbox-center distance, 2093–2104) | ifc_service.py:2093–2104 |
| Levels | Yes (`IfcBuildingStorey`) | Yes | 1925–1955 |
| Views/sheets (frontend) | **No** — store defaults only; save writes one hardcoded view | No | ifc_service.py:1794–1808; useBimStore.ts:181–256 |
| Undo journal | **No** — in-memory only (`command_bus.py:158`) | No | command_bus.py:157–160 |
| Units | meta claims `decimal_feet` (1779, 1817) but the model is created metric (`unit.assign_unit … METERS`, ifc_service.py:53–55) and all defaults are meters | Mislabeled both directions | README.md:35 acknowledges |
| Slab/roof polygon sketches | Only the extruded bbox rectangle is in IFC (`add_slab` builds rep from the polygon's bounding box, 606–624; roof same, 671–696) | Polygon becomes the bbox rectangle | ifc_service.py:606–632, 671–696 |

**Verdict on round trip:** it "works" (test_v2_core.py:82–102 passes) but only because the checks are shallow (`elements_count >= 2`, GUID presence). Substantively it is **lossy and degrading**: every load bakes bbox heuristics over the parametric truth, and grids/footprints/views/journal are lost or fabricated.

### 1.5 Other persistence surfaces
- Plain IFC export: `GET /api/export/ifc` (main.py:389–399) → `export_ifc_step` → `self.model.write()` (ifc_service.py:1748–1754). Import: `POST /api/load-file` and `/api/upload/ifc` (main.py:155–174). No `.json` project format exists outside the zip.
- **Frontend has no local persistence at all** — every mutation is a fetch; downloads via Blob anchors (`exportOrltProject` useBimStore.ts:940–961, `exportIfc` 916–934).
- **Live bug:** the open-file input is `accept=".ifc,.stp,.step"` (src/components/ribbon/Ribbon.tsx:371–377) even though `handleFileChange` routes `.orlt` (Ribbon.tsx:72–82). In most browsers the picker filters out `.orlt`, so **loading a saved project through the Open button is effectively broken**; only Save works from the UI.

---

## 2. ARCHITECTURE ASSESSMENT

### 2.1 Stack and where "truth" lives
- Frontend: React 19 + Zustand + Three.js + dockview, plain Vite SPA — **no Tauri** (package.json:16–25, vite.config.ts). Backend: FastAPI + IfcOpenShell (Python) sidecar on 127.0.0.1:8008 (main.py:14, 546–548). The spec's C++ engine process, WebSocket bus, and length-prefixed binary frames (README §3 diagram, 117–155) are **unbuilt**; transport is per-request HTTP/JSON.
- **Truth is split three ways:** (1) the live ifcopenshell file object `self.model`; (2) a **shadow Python dict `element_meta`** (ifc_service.py:100) holding baseline geometry, cached meshes, hosted-opening lists, fake type properties; (3) the Zustand store mirroring it via full-payload fetches (`fetchGeometry` useBimStore.ts:657–671 returns *all* meshes after *every* action — e.g. 772–774, 826–829, 1054–1058). There are **no delta events**; every edit re-downloads the whole scene JSON and rebuilds every Three.js mesh (Viewport3D.tsx:205–278 clears and recreates all meshes per state change). This is exactly the "store is the model" anti-pattern README.md:40 admits.
- IfcGrid/string class tagging: grids, and door/window `type_properties`, exist only in the shadow dict, deepening the divergence (see 1.4).

### 2.2 Parametric edits — how they actually work
- **Wall move:** `translate_element` (ifc_service.py:805–885) mutates `meta["start"]/["end"]`, then calls the **global** `recompute_wall_joins()` (834). Constraints propagate by **recursive translation with a `visited` set** (862–884): `align` and `dimension_lock` copy the same delta to locked partners; **`equalize` has no propagation branch** — EQ is enforced only at creation time (`equalize_span` 988–1042) and silently stops holding afterward.
- **Door/window move:** `meta["offset_along_wall"] += dx` (838) — **uses raw world dx regardless of wall direction**, so sliding a door along a vertical wall moves it the wrong way. Door/window placement matrices are rebuilt from `offset_along_wall` (842–852).
- **Wall joins:** `recompute_wall_joins()` (1197–1275) is a genuine and well-crafted Phase-A implementation: per-endpoint policies, miter via angle-bisector half-plane clip (`_clip_poly_line` 1125–1146), butt with deterministic creation-order "through wall" rule (1264–1267), square-off via perpendicular cut (`_clip_to_partner_face` 1283–1312), T-junctions, 15° miter fallback (1091–1092). Trimmed footprints are stored on meta and rebuilt as `IfcExtrudedAreaSolid`/`IfcArbitraryClosedProfileDef` (`_rebuild_wall_representation` 1339–1382). But it is **O(N²) global recompute on every create/move/delete/policy change** (`_find_join_partner` scans all walls per endpoint, 1161–1190) — no dirty marking, no incremental scheduling.
- **Profile/roof/floor edits:** none. There is no command or UI to edit a wall's endpoints, a slab's polygon, or a roof's pitch after creation; `RoofCreate`/`SlabCreate` take a polygon once and never revisit it.
- **Dependency graph:** **does not exist.** What exists is ad-hoc recursion (constraints) + global join recompute + bbox heuristics. SPEC.md §3.2's topological dirty-propagation scheduler (SPEC.md:133–138) is aspirational. Note `snapshot_state` deep-copies `cached_verts/cached_faces` arrays too (`_clean_meta` deep-copies every non-entity key, 128–160) — every transaction snapshot carries full tessellations, i.e. memory O(model) per edit.

### 2.3 Command bus
- Solid Tier-0 core: 13 Pydantic-typed commands with JSON-Schema-2020-12 export (`COMMAND_REGISTRY` command_bus.py:116–130, `get_schemas` 162–171), atomic transactions via **full-state snapshot** (`execute_transaction` 297–355: `snapshot_state` before, `restore_state` on failure 320–325), origin tagging, append-only journal, snapshot-based undo/redo (357–387). Verified by the 28-check transaction suite.
- **Critical design gap:** the Ribbon/viewport UI mostly **bypasses the bus**. `createWall/createDoor/createWindow/deleteElement/translateElement` POST to the raw REST endpoints `/api/wall`, `/api/door`, `/api/element/{guid}` … (useBimStore.ts:764–849), which call `bim_manager` directly (main.py:227–352) — **these mutations never enter the journal or undo stack**. Only constraints, joins, and AI plans go through `/api/transaction` (1036–1065). Consequence: click Wall, draw a wall, press Undo → "Nothing to undo." This inverts the spec's acceptance criterion #6 ("UI is a skin on the bus", README.md:339, 363).

---

## 3. M0/M1 COMPLETENESS

### Actually implemented (verified by reading + test execution)
- IFC4 authoring via `ifcopenshell.api`: walls (`IfcWallStandardCase`, ifc_service.py:322–387), doors/windows with real `IfcOpeningElement` + `IfcRelVoidsElement`/`IfcRelFillsElement` (389–491, 493–587), slabs/roofs (589–716), storeys, georeferencing `IfcProjectedCRS`+`IfcMapConversion` (262–283; present in sample_building.ifc #21–22).
- Wall join Phase A geometry, 2D view-range slicing incl. <6 ft not-cut rule (1560–1566; verified in test_v2_core.py:53–61), door swing arcs in plan (1633–1665).
- Constraint trio (align/dimension-lock/EQ) at 1D/axis level with persistence, plus undo/redo engine, command bus, `.orlt` container, georeference dialog, vector sheet PDF via PyMuPDF (1733–1746), `SheetCanvas.tsx`/`ProjectBrowser.tsx`/`PromptBar.tsx`/`EditTypeModal.tsx` exist as components.

### Stubbed / fake
- **PropertiesPalette shows hard-coded values**: "Base Constraint: Level 1", "Area 13.50 m²", "Volume 2.70 m³", "Unconnected Height 10'-0"" regardless of the selected element (PropertiesPalette.tsx:60–108); Area/Volume are constants, not computed. Type Selector is display-only (34–47).
- **AI driver is regex keyword matching, not an LLM**: `generateAiPlan` pattern-matches "room/door/window/slab/equalize" (useBimStore.ts:1111–1293); fallback blindly creates a 6 m wall (1277–1292). No plan→LLM→preview→retry loop.
- **`elements` record is never populated** (declared useBimStore.ts:39, initialized `elements: {}` at 258, no setter anywhere — grep confirms). So the AI planner's host-wall lookup reads an always-empty map (1175–1178, 1208–1211) and door/window plans always throw or misbehave.
- Temporary dimension = distance to the *nearest other mesh center*, with a hardcoded 12′ default (useBimStore.ts:414–460); editing it translates by raw delta on x only (501–508).
- Align-constraint overlay lines are drawn at hardcoded coordinates x −5→18, y 0 (PlanViewport2D.tsx:293–307). `equalizeSouthWallWindows` hardcodes `walls[0]` (625–638).
- Sheets A101/A201 are hardcoded store defaults (useBimStore.ts:224–255).

### Only in README/spec (unbuilt)
C++/OCCT engine process; Tauri shell; WebSocket delta protocol; dependency-graph/recompute scheduler; HLR (`HLRBRep`) sections/elevations — 2D today is an analytic slice of the shadow dict, not linework from solids (ifc_service.py:1537–1727); view templates & lineweight tables; sheet viewport live-references; families/types — **zero** `IfcWallType`/`IfcRelDefinesByType`/`IfcMaterialLayerSet`/`IfcRelConnectsPathElements` in the backend (grep-verified); `.bwfam`/`.bwskill`; planegcs/SolveSpace solver; over-constraint reporting; MCP server; eval harness; IFC4x3 read; official IFC validation; mm export-unit boundary; level-driven elements (moving a level moves nothing; levels are only storey entities + meta).

### Concrete gap list (priority as in README.md:32–40, plus findings)
1. UI edits bypass transactions → undo silently no-ops for most Ribbon actions (useBimStore.ts:764–849 vs command_bus.py:297).
2. `.orlt` not selectable in the Open file dialog (Ribbon.tsx:374).
3. `elements` never populated → AI planner broken for hosted elements (useBimStore.ts:258).
4. Round-trip degradation: bbox wall reconstruction, lost grids/footprints/views (ifc_service.py:2037–2059, 718–740).
5. Constraint overlay + pset double-persistence (README.md:36; ifc_service.py:1384–1425).
6. Door slide ignores wall angle (ifc_service.py:838); EQ not enforced on move (862–884).
7. Units mislabeled feet/meters end-to-end (README.md:35; ifc_service.py:53–55, 1779).
8. No types, no materials/layers, no level constraints, no sketch editing, no sections/HLR, no families, no external-IFC full import (0 elements from minimal file per README.md:37).

---

## 4. EDITING WORKFLOW — walls, roofs, floors, sketch mode

- **Wall creation** works only in the **3D** viewport: two clicks on the Z=0 ground plane, snapped to 0.5 m (Viewport3D.tsx:312–330); the plan viewport (PlanViewport2D.tsx) has **no drawing tools at all** — it is a read-only SVG render of backend slice output with click-to-select (23–33, 154–170).
- **Post-creation wall editing** = whole-element translation only. There is no endpoint drag, no profile/baseline editing, no temporary-dimension-driven endpoint move (the temp-dim pill translates the whole element, useBimStore.ts:501–508). Join trimming happens *around* an uneditable baseline.
- **Floors/roofs/grids/levels/dimensions/tags/text/section/sheet tools**: the Ribbon sets `activeTool` (Ribbon.tsx:233–341) but **neither viewport has a click handler for `SB`, `RF`, `GR`, `LL`, `DI`, `DL`, `TG`, `TX`, `SEC`, `SHT`** (Viewport3D.tsx handles only `WA`, `DR`, `WN`, `AL`, `select` — 312–367). Those elements can only be created via the REST API/CommandBus, not the UI.
- **Sketch-mode / 2D-edit-invokes-3D**: **not implemented and not even scaffolded**. No sketch plane model, no in-place editor, no `IfcProfileDef`-level editing UI (footprints are engine-generated, ifc_service.py:1339–1382). The plan viewport's only "editing" is the temp-dimension pill and constraint padlocks (PlanViewport2D.tsx:233–287), which invoke translate/equalize commands.

---

## 5. RISKS — top 5 for scaling toward Revit-LT class

1. **The shadow-dict dual model + incomplete overlay makes the round trip lossy by construction (the #1 file-format risk).** `element_meta` is the real working model; the overlay deliberately omits baseline geometry; load therefore re-derives it from tessellation bboxes (ifc_service.py:2037–2059) — diagonal walls snap to axes, door offsets degrade, grids vanish, and any float drift accumulates per save/load cycle. As element variety grows (curtain walls, stairs, railings already have color entries at 1442–1459 but no reconstruction logic), the heuristic gap widens. *Mitigation:* make `parametric.json` the authoritative parametric record (per-GUID baseline, constraints, join policies, view/sheet data), derive IFC geometry from it on load, and treat `model.ifc` purely as the interchange/validation artifact.
2. **Two unsynchronized persistence channels for constraints** (overlay + `Pset_ORLT_Constraints`, ifc_service.py:1384–1425) and two container names (`.bimworks` vs `.orlt`) mean three partial sources of truth. Round-trip currently *depends* on the pset hack the spec explicitly rejected (README.md:36). Until this collapses to overlay-only, "stale overlay" semantics cannot be implemented and interop promises (hand `model.ifc` to Revit/Bonsai, SPEC.md:124) are undermined by a custom pset on IfcProject.
3. **O(model) everywhere: full-STEP snapshot undo, full-mesh JSON refetch per edit, O(N²) join recompute, no delta events.** `snapshot_state` copies the entire STEP text *plus* every element's cached vertex arrays (ifc_service.py:128–160 + `cached_verts` at 1478); the store refetches all geometry after every command (useBimStore.ts:1054–1058); joins rescan all walls per wall (1161–1190). This is fine for a 13-element demo and will collapse at 2,000 elements — precisely the spec's own budget target (README.md:182). Interactive drag is impossible on this architecture without the delta/event refactor.
4. **Command-bus bypass by the UI** breaks the transactional invariant the whole design rests on: half of all mutations are unjournaled and unundoable (useBimStore.ts:764–849). Every new feature added on the raw REST path widens the divergence and makes the AI-parity acceptance test (README.md:363) unpassable. This must be converged *before* more tools are added, not after.
5. **Constraints are a demo, not an engine**: recursive delta propagation with axis bugs (door slide along non-X walls, ifc_service.py:838), EQ not maintained under later moves (862–884), no solver, no over-constraint detection, no planar DOF model — while the plan viewport already draws lock/EQ affordances implying Revit behavior (PlanViewport2D.tsx:233–287). Scaling to sketch constraints (floors/roofs editing, family editor) without the planned planegcs-class solver and a real dependency graph will require rewriting the propagation layer anyway; the current code sets expectations it cannot keep.

---

## 6. BOTTOM LINE

The chosen file-format track — a zip container holding a real IFC4 STEP model of record plus a JSON parametric overlay keyed by GUID — is the **correct strategic call** for a Revit-LT-like editor; it matches the FreeCAD/Bonsai precedent the spec itself cites and is the only honest answer to IFC's lack of recompute semantics. But the current implementation is not yet actually that design: the overlay omits exactly the data (baseline geometry, grids, views, footprints) that would make the round trip faithful, load rebuilds the working model from tessellation bounding boxes and thereby silently degrades it, constraints are double-written to a pset the spec rejected, grids never reach IFC at all, and the container ships under a different name (`.orlt`) than the spec locks (`.bimworks`) — with the UI's Open dialog unable to select it. Combined with a UI that bypasses its own CommandBus (breaking undo) and O(model) snapshot/refetch costs, this is a promising, genuinely working M0 spike whose persistence layer needs one decisive refactor — overlay-as-truth, IFC-as-export, bus-only mutations — before any further feature work, rather than a fundamentally wrong direction. Sound track, unsound current fidelity; the fixes are well-scoped and mostly additive.
