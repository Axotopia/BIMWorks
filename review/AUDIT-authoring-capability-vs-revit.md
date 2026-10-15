# AUDIT — BIMWorks model-authoring capability vs. "looks and performs like Revit"

**Date:** 2026-10-14
**Repository:** `C:\Users\desig\Documents\GitHub\BIMWorks`, branch `gemini`, HEAD `318ce26`
**Scope:** the authoring surface and the bus that exposes it — `backend/command_bus.py`,
`backend/ifc_service.py`, `backend/sketch_model.py`, `backend/ai_driver.py`, `src/types/bim.ts`,
`src/store/useBimStore.ts`.
**Normative references:** `docs/SPECIFICATION-v0.2.md` (cited as **S-v0.2**), `docs/SPEC.md` §11 and
the master spec v2.3 (cited as **SPEC**).
**Revit ground truth:** the REA corpus in `C:\Users\desig\DSH\BIMWorks\` —
`family-editor-and-components.md` (**FE**), `how-revit-edits-host-elements.md` (**HE**),
`curtain-walls-grid-model.md` (**CW**), `stairs-model-and-layout.md` (**ST**),
`topography-create-and-edit.md` (**TO**), `views-sheets-and-tag-tracking.md` (**VS**),
`BIMWorks-rea-findings.md` (**REA-F**).

## Method and evidence standard

* Every verdict below carries a `file:line` citation or an explicit **searched, absent** with the
  search performed.
* Ten claims were confirmed by executing the engine, not by reading it. Those are marked
  **[PROBED]** with the observed output. The probe was a throwaway script under `scratch/` that this
  audit **deleted after the run**; the only file this audit left behind is this document (`git status`
  reports it as `?? review/AUDIT-authoring-capability-vs-revit.md`). Note that other untracked
  `scratch/_probe_*.py` files appear in the tree concurrently and were **not** created by this audit —
  do not attribute them to it.
* Gate/test state was measured: `scratch/test_v2_core.py` → all pass, "Exported **31** typed command
  schemas"; `node scripts/check-bus-parity.mjs` → PASS, "**29** UI actions declared and dispatched";
  `scratch/test_bus_parity_audit.py` → PASS; `scratch/test_ai_driver.py` → **105 passed, 0 failed**;
  `scratch/test_hosted_openings.py` → all pass; `scratch/test_sketch_model.py` → **42 passed, 0 failed**.
* Claims I could not settle from code or execution are marked **(unverified)**.

### The headline, stated precisely

Revit is a **parametric family/type system over a datum-driven host model**: an element is
`(sketch/profile) + (type object) + (level or host) + flags`, edited by `open transaction → mutate →
regenerate` (HE:161-164). BIMWorks is an **IFC authoring layer with a parametric overlay** — the
overlay is real and load-bearing, but it carries *instance* parameters only. There is **no type layer
at all**: no `IfcTypeObject`, no `IfcRelDefinesByType`, no `IfcPropertySet` **[PROBED]**, and no
command that can edit a type. That single absence is the root of roughly half the gaps below, because
in Revit the type *is* the thing that makes the UI feel like Revit (Type Selector, Edit Type, type
propagation, family swap).

Two other structural absences matter as much:

1. **No compound structure / layer model.** SPEC §3.3(2) commits to layer-aware joins post-MVP and
   S-v0.2 §20.3 records per-layer joins as unrepresentable. Confirmed: zero material or layer
   entities in an authored model **[PROBED]**.
2. **The sketch is a roof-only mechanism in practice.** `Sketch` supports `floor`/`roof`/`profile`
   (`backend/sketch_model.py:96-101`) and the overlay now persists it
   (`backend/ifc_service.py:1272-1276`), which **closes plan finding N13** — but only roofs receive a
   sketch on creation (`backend/ifc_service.py:1806-1811`) **[PROBED]**, and floors are bare polygons
   `IfcSlab` with no sketch. There is no ceiling, stair, railing, curtain-wall, topography or family
   authoring of any kind.

---

## 1. Summary table

| # | Capability | Verdict | Gap | Evidence (file:line) |
|---|---|---|---|---|
| 1 | Typed command bus inventory | **PRESENT** | 31 commands; no mirror/array/pin/group/create-similar | `backend/command_bus.py:309-341`, `:386-623` |
| 1a | Modify tools (move/copy/rotate/offset/trim/split) | **PARTIAL** | rotate+offset are wall-only; copy is per-class; no mirror, no array | `command_bus.py:531-550`; `ifc_service.py:968-969`, `:1005-1006`, `:953-954` |
| 1b | Mirror / Array / Pin / Group / Create Similar / Pick Lines | **ABSENT** | no command, no `element_meta` flag | searched: `command_bus.py:309-341`; `(?i)(mirror|array|pin |unpin|group)` over `backend/*.py` → only comments/`np.array` |
| 2 | Levels: create + move + element attachment | **PARTIAL** | move works by translation, not by constraint; no pin | `ifc_service.py:581-598`, `:1105-1160` |
| 2a | Grids written to IFC | **PRESENT** | real `IfcGrid`+`IfcGridAxis`; grid *edit* does not rewrite the axis curve | `ifc_service.py:1829-1899`; gap at `:2060-2065` |
| 2b | Datum pinning | **ABSENT** | no pinned state anywhere | searched: `(?i)pin` over `backend/` → `constraint_solver.py` pins only |
| 3 | Type system (wall/door/floor types) | **ABSENT** | `type_properties` are hardcoded dicts; not in IFC; not editable | `ifc_service.py:1424-1430`, `:1543-1549`, `:3288-3289`; **[PROBED]** no Type entities, no `IfcRelDefinesByType` |
| 3a | Type Selector / Edit Type UI | **ABSENT (faked)** | read-only `<div>`; Edit Type modal is a hardcoded mock | `src/components/properties/PropertiesPalette.tsx:183-197`; `src/components/modals/EditTypeModal.tsx:38-56` |
| 3b | Family / `.bwfam` / family editor | **ABSENT** | no family doc, no `.bwfam`, no loader | searched: `(?i)family` over `backend/` → 0 hits |
| 4 | Hosted openings (door/window in wall) | **PRESENT** | voids/fills real; host deletion cascades; no "cut with voids" flag | `ifc_service.py:1450-1560`, `:1562-1663`, `:1915-1959` |
| 4a | Host move → insert follows | **PRESENT** | openings follow host MOVE via shared placement | `ifc_service.py:2033-2057` |
| 4b | Host resize (thickness/height) → opening re-cut | **PARTIAL** | opening width/height are fixed at insert; no re-cut on host change | `ifc_service.py:2299-2300`, `:2339-2340`, `:2365-2368` |
| 5 | Compound wall structure / layers | **ABSENT** | no layer model, no material | **[PROBED]** all `IfcMaterial*` counts 0; S-v0.2 §20.3 records it |
| 6 | Sketch-based elements (floor/roof/ceiling) | **PARTIAL** | roof sketch real+persisted; floor polygon-only; no ceiling | `sketch_model.py:96-101`; `ifc_service.py:1272-1276`, `:1806-1811`; **[PROBED]** slab sketch absent |
| 6a | N13 (sketch client-only, lost on reload) | **CLOSED** | sketch is now first-class overlay data | `ifc_service.py:1272-1276`, `:3253-3267` |
| 6b | Wall profile sketch (non-rectangular walls) | **PARTIAL** | model exists, no bus command creates a profile | `ifc_service.py:727-773`; no `SetWallProfile` in `command_bus.py:309-341` |
| 7 | Stairs / railings | **ABSENT** | colour placeholders only | `ifc_service.py:3446-3447` |
| 7a | Curtain walls / panels / mullions | **ABSENT** | same | `ifc_service.py:3449-3451` |
| 7b | Topography / toposolid | **ABSENT** | no create, no edit, no site surface | searched: `(?i)topo` over `backend/` → 0 authoring hits |
| 7c | Rooms / spaces | **ABSENT** | `IfcSpace` never authored | searched: `IfcSpace` over `backend/` → 0 hits |
| 8 | Views as documents | **PRESENT** | view is a document object, level-relative cuts | `src/types/bim.ts:140-159`; `useBimStore.ts:195-210` |
| 8a | Viewports as placement objects | **PRESENT** | add/remove/move; sheet↔view both ends | `ifc_service.py:4556-4647`; `bim.ts:161-180` |
| 8b | Tag tracking (marker↔view, bidirectional) | **PARTIAL** | grid bubbles + swing/glazing symbols; no tag objects | `ifc_service.py:4380-4430`, `:4192-4296` |
| 8c | Schedules / quantities | **ABSENT** | browser has a `schedules: false` stub | `src/components/browser/ProjectBrowser.tsx:54` |
| 9 | Groups | **ABSENT** | no group entity, no group command | searched: `IfcGroup` over `backend/` → 0 hits |
| 9a | Revit Links (linked models) | **ABSENT** | import replaces the document | `ifc_service.py:4936-4946`, `:5118` |
| 10 | Bus completeness (AI parity gate) | **PRESENT** | gate passes; only 16 of 31 commands have HTTP routes | `scripts/check-bus-parity.mjs:128`; `test_bus_parity_audit.py` output |
| 10a | `ai_driver.py` planner correctness | **PRESENT** | `walls[0]` fallback is now guarded by `len(walls)==1` | `ai_driver.py:314-319`; 105/105 tests pass |
| 10b | Type-driven `onSymbolIdChanged` (type changed) | **ABSENT** | nothing to notify — no type | S-v0.2 §8.2 requires it; searched `onSymbolIdChanged` → 0 hits |

---

## 2. The complete command inventory (exact)

`COMMAND_REGISTRY` (`backend/command_bus.py:309-341`) holds **31** entries and is the single source of
truth (S-v0.2 §6). Each is dispatched in `execute_single_command` (`:386-623`). Signatures are the
Pydantic fields verbatim, with defaults.

### 2.1 Create — architectural elements (6)

| Command | Parameter schema | File:line |
|---|---|---|
| `WallCreate` | `start: List[float]`, `end: List[float]`, `height: float = 3.0`, `thickness: float = 0.2`, `level_id: Optional[str] = None`, `name: str = 'Basic Wall : Exterior - 8" CMU'` | `:21-27` |
| `DoorInsert` | `host_wall_guid: str`, `offset_along_wall: float`, `width: float = 0.95`, `height: float = 2.1`, `name: str = 'Single Flush : 36" x 84"'`, `swing_flipped: bool = False` | `:37-43` |
| `WindowInsert` | `host_wall_guid: str`, `offset_along_wall: float`, `width: float = 1.2`, `height: float = 1.2`, `sill_height: float = 0.9`, `name: str = 'Fixed Window : 48" x 48"'` | `:46-52` |
| `SlabCreate` | `polygon: List[List[float]]`, `thickness: float = 0.25`, `elevation: float = 0.0`, `level_id: Optional[str] = None`, `name: str = 'Floor : 10" Concrete Slab'` | `:55-60` |
| `RoofCreate` | `polygon: List[List[float]]`, `thickness: float = 0.3`, `elevation: float = 3.0`, `pitch_degrees: float = 15.0`, `level_id: Optional[str] = None`, `name: str = "Roof : Pitched Metal Deck"` | `:63-69` |
| `GridCreate` | `axis_name: str`, `start: List[float]`, `end: List[float]` | `:72-75` |

### 2.2 Datum (2)

| Command | Parameter schema | File:line |
|---|---|---|
| `LevelCreate` | `name: str`, `elevation: float` | `:78-80` |
| `LevelMove` | `level_id: str`, `elevation: float` | `:181-183` |

### 2.3 Generic edit (3)

| Command | Parameter schema | File:line |
|---|---|---|
| `ElementUpdate` | `guid: str`, `updates: Dict[str, Any]` | `:116-118` |
| `DeleteElement` | `guid: str` | `:83-84` |
| `WallMove` | `guid: str`, `dx: float`, `dy: float`, `dz: float = 0.0` | `:30-34` |

### 2.4 Modify tools — P3 (5)

| Command | Parameter schema | File:line |
|---|---|---|
| `ElementCopy` | `guid: str`, `dx: float = 0.0`, `dy: float = 0.0`, `dz: float = 0.0` | `:151-155` |
| `ElementRotate` | `guid: str`, `angle_degrees: float`, `center: Optional[List[float]] = None` | `:158-161` |
| `ElementOffset` | `guid: str`, `distance: float`, `side: int = 1` | `:164-167` |
| `WallTrimExtend` | `guid: str`, `end_index: int`, `target_guid: str` | `:170-173` |
| `WallSplit` | `guid: str`, `at_offset: float` | `:176-178` |

### 2.5 Wall joins (1)

| Command | Parameter schema | File:line |
|---|---|---|
| `SetWallJoin` | `wall_guid: str`, `end_index: int`, `allow_join: bool = True`, `mode: Literal["butt","miter","square_off"] = "butt"` | `:87-91` |

### 2.6 Constraints (5)

| Command | Parameter schema | File:line |
|---|---|---|
| `ConstraintAlign` | `ref_guid: str`, `target_guid: str`, `axis: Literal["x","y"] = "x"`, `lock: bool = True` | `:94-98` |
| `ConstraintLockDim` | `guid_a: str`, `guid_b: str`, `locked_distance: Optional[float] = None`, `lock: bool = True`, `axis: Literal["x","y"] = "x"` | `:101-106` |
| `ConstraintEqualize` | `span_start_guid: str`, `span_end_guid: str`, `interior_guids: List[str]`, `axis: Literal["x","y"] = "x"` | `:109-113` |
| `ConstraintLockToggle` | `constraint_id: str`, `is_locked: bool` | `:186-188` |
| `ConstraintDelete` | `constraint_id: str` | `:191-192` |

### 2.7 Sketch (4)

| Command | Parameter schema | File:line |
|---|---|---|
| `SketchCurveAdd` | `guid: str`, `curve_id: str`, `start: List[float]`, `end: List[float]`, `defines_slope: bool = False`, `slope_angle: Optional[float] = None` | `:121-127` |
| `SketchCurveMoveVertex` | `guid: str`, `curve_id: str`, `end_index: int`, `to: List[float]` | `:130-134` |
| `SketchCurveMoveEdge` | `guid: str`, `curve_id: str`, `dx: float`, `dy: float` | `:137-141` |
| `SketchCurveSetSlope` | `guid: str`, `curve_id: str`, `defines_slope: bool`, `slope_angle: Optional[float] = None` | `:144-148` |

### 2.8 Sheets and viewports — P6 (5)

| Command | Parameter schema | File:line |
|---|---|---|
| `SheetCreate` | `sheet_number: str`, `sheet_title: str = "Unnamed Sheet"`, `paper_size: str = "ARCH_D"`, `is_placeholder: bool = False`, `sheet_id: Optional[str] = None`, `drawn_by: str = "BIMWorks Architect"`, `date: Optional[str] = None` | `:195-202` |
| `SheetDelete` | `sheet_id: str` | `:224-225` |
| `ViewportAdd` | `sheet_id: str`, `view_id: str`, `x: float`, `y: float`, `width: float = 480.0`, `height: float = 360.0`, `scale_factor: float = 1.0`, `viewport_id: Optional[str] = None` | `:238-246` |
| `ViewportRemove` | `viewport_id: str`, `sheet_id: Optional[str] = None` | `:266-268` |
| `ViewportMove` | `viewport_id: str`, `x: float`, `y: float`, `sheet_id: Optional[str] = None` | `:286-290` |

**Total: 6 + 2 + 3 + 5 + 1 + 5 + 4 + 5 = 31.** Confirmed at runtime: *"Exported 31 typed command
schemas (JSON Schema 2020-12)"* (`scratch/test_v2_core.py`).

### 2.9 UI wiring — 29 of the 31

`UI_ACTION_COMMANDS` (`src/store/useBimStore.ts:98-132`) declares **29** actions mapped onto **29
distinct** commands. The two registry entries with **no UI action** are `GridCreate` and
`LevelCreate`: they are reachable from the UI only through direct store calls
(`useBimStore.ts:1662-1731` define `createWall`/`createDoor`/`createWindow`/`createRoof`/`createSlab`
with hardcoded default type names), and the parity gate passes because it checks the *declared* table,
not the absence of undeclared creators.

### 2.10 Revit operations with **no** BIMWorks equivalent

Searched exhaustively against `command_bus.py:309-341` and `ifc_service.py`'s 114 methods:

**Modify tools absent:** Mirror (no `ElementMirror`; the word appears only in a stale comment at
`ifc_service.py:894` and in HLR's `_mirror_path_x`), Array (linear/radial), Pin / Unpin, Group /
Ungroup / Group-edit, Create Similar, Pick Lines / Pick Faces, Offset *of a face or sub-element*
(only whole-wall perpendicular offset exists), Align *to a face/grid with the Options-Bar preference
matrix*, Split with Gap, Trim/Extend *to a reference plane*, Scale, Rotate to a **project-specific**
angle with a snap list, Copy with **Multiple** (Revit's copy-with-constraint repetition), Move with
**Disjoin**, Delete with a **deletion-closure preview**.

**Element classes absent:** Space/Room (`IfcSpace` — searched, 0 hits), Ceiling (`IfcCovering` is a
colour entry only, `ifc_service.py:3448`), Stair, Ramp, Railing, Curtain Wall/System, Panel, Mullion,
Toposolid/Toposurface, Building Pad, Shaft Opening, Structural framing/columns/foundations, Mass,
Generic Model, Furniture, MEP of every kind.

**Document features absent:** Schedules and quantity take-off
(`ProjectBrowser.tsx:54` is a hardcoded `schedules: false`), Revisions and revision clouds, Legend,
Dependent views (`View.GetDependentViewIds` — VS:212-226 calls these "not optional" for production),
View templates as objects (S-v0.2 §13.5 requires a default-template-on-view-type and an explicit
non-controlled parameter list), Sheet collections / scoped sheet numbering (VS:56-73 requires
per-collection scope), Elevation/section/callout markers (`ElevationMarker` — VS:140-152), Detail
groups, In-place families, Phasing, Design Options, Worksharing.

**Verification of the two headline absences** **[PROBED]** — after authoring one wall pair, a door, a
window, a slab, a roof, a grid and a level, the complete IFC entity census contained **no**
`IfcWallType`, `IfcDoorType`, `IfcWindowType`, `IfcSlabType`, `IfcRoofType`, `IfcRelDefinesByType`,
`IfcPropertySet`, `IfcMaterial`, `IfcMaterialLayerSet`, `IfcMaterialLayer`, `IfcMaterialProfileSet` —
and `entities whose class contains 'Type': NONE`.

---

## 3. Revit capability matrix

Effort: **S** ≤ 1 day, **M** ≈ 2–5 days, **L** > 1 week of focused work.

| Capability | BIMWorks state | Minimum honest implementation | Effort | Files touched |
|---|---|---|---|---|
| **Type/instance split** (FE:42-78, SPEC §3.5) | ABSENT. `type_properties` is a literal dict built inside each `add_*` (`ifc_service.py:1424-1430`), ignored by `update_element` **[PROBED]**, never serialized to IFC **[PROBED]** | Introduce `type_registry: dict[type_id, {name, ifc_class, params: dict[str, typed_value], active: bool}]` on the manager, plus `type_id` in `element_meta`; on `add_*` resolve `name` → existing type or create one. Write `IfcWallType`/`IfcDoorType`/… + `IfcRelDefinesByType` + `IfcPropertySet` at create. Add `TypeCreate`/`TypeUpdate`/`TypeDelete`/`TypeAssignActive`/`SetElementType` commands (5). Propagate on `TypeUpdate` through the existing `DependencyGraph` by walking `element_meta` for `type_id` members | **L** | `ifc_service.py`, `command_bus.py`, `dependency_graph.py`, `useBimStore.ts`, `bim.ts`, `PropertiesPalette.tsx` |
| **Typed parameter values** (FE:62-64, S-v0.2 §14.1) | ABSENT — everything is a `str` (`bim.ts:31`, `:75`) | Replace `type_properties: Record<string,string>` with `{name, data_type: Literal['length','number','integer','text','yesno','material','elementid'], value, is_instance: bool, formula: str\|null}`. Length values stay decimal feet internally | **M** | `bim.ts`, `ifc_service.py`, `command_bus.py`, `PropertiesPalette.tsx` |
| **Type Selector + Edit Type** (FE:56-60) | FAKED. Read-only `<div>` (`PropertiesPalette.tsx:183-197`); modal is hardcoded literals (`EditTypeModal.tsx:38-56`) | Bind the palette control to `type_registry[class]`, dispatch `SetElementType`, repaint. Make `EditTypeModal` render `type_registry[type_id].params` with typed editors and dispatch `TypeUpdate` | **M** | `PropertiesPalette.tsx`, `EditTypeModal.tsx`, `useBimStore.ts` |
| **Compound structure / layers** (HE:63-73, SPEC §3.3(2)) | ABSENT **[PROBED]** | `layers: [{function: 'structure'\|'substrate'\|'finish'\|…, material, width_ft, priority}]` on the *type*; write `IfcMaterialLayerSet` + `IfcMaterialLayerSetUsage`. Join engine consumes `priority` and the layer-wrapping rule at inserts. Start with the material/UI and IFC authoring; defer wrapping | **L** | `ifc_service.py`, new `layer_model.py`, `command_bus.py`, `PropertiesPalette.tsx` |
| **Wall profile sketch reachable from the bus** (HE:87-95) | PARTIAL — engine method exists, no command; angled walls rejected (`test_sketch_model.py` case 7) | Add `WallSetProfile` / `WallRemoveProfile` commands over the existing `set_wall_profile` (`ifc_service.py:727`) and its `Sketch(kind="profile")` support (`sketch_model.py:96-101`). Persist `profile` in `ELEMENT_PARAM_FIELDS` (`ifc_service.py:3153-3177` currently omits it) | **M** | `command_bus.py`, `ifc_service.py`, `useBimStore.ts` |
| **Floor sketch parity with roof** | PARTIAL — floors are bare polygons **[PROBED]** | Seed a `Sketch(kind="floor")` in `add_slab` exactly as `add_roof` does (`ifc_service.py:1806-1811`), and route `SketchCurve*` through `_edit_sketch` for `IfcSlab` (currently `_edit_sketch` hard-routes to `set_roof_sketch` at `:722`, which raises `"set_roof_sketch expects a roof"` at `:641-642`) | **S** | `ifc_service.py`, `command_bus.py` |
| **Mirror** | ABSENT | `ElementMirror{guid, plane_origin[2], plane_normal[2]}`. For walls: negate the baseline about the plane, then `_rebuild_wall_representation` + `recompute_wall_joins` (the rotate path at `ifc_service.py:971-996` is the template). For hosted inserts: mirror `offset_along_wall` and flip `swing_flipped`. Refuse for types with no mirror rule rather than guessing | **S–M** | `ifc_service.py`, `command_bus.py`, `useBimStore.ts` |
| **Array (linear/radial)** | ABSENT | `ElementArray{guid, kind: 'linear'\|'radial', count, spacing_ft \| angle_deg}` implemented as *N copies plus a group*, because Revit's array is a single element with array parameters. Honest minimal: N copies + `group_id`, with the array parameters recorded on the group so re-editing is possible | **M** | `ifc_service.py`, `command_bus.py`, `useBimStore.ts`, `bim.ts` |
| **Pin / Unpin** | ABSENT | `pinned: bool` on `element_meta`; `ElementPin{guid, pinned}`; guard every mutating method (`translate_element`, `delete_element`, `rotate_element`, `offset_element`, `trim_extend_wall`, `split_wall`, `update_element`) with a typed `PinnedElement` failure carrying the remedy "unpin first" (S-v0.2 §14.9 wants remedy-bearing failures) | **S** | `ifc_service.py`, `command_bus.py` |
| **Groups** | ABSENT | `groups: {group_id: {name, member_guids[]}}` in the overlay; `GroupCreate{guids, name}`, `GroupUngroup`, `GroupAdd/Remove`. `delete_element` must compute the closure over group membership (S-v0.2 §7 wants a real deletion closure anyway) | **M** | `ifc_service.py`, `command_bus.py`, `useBimStore.ts`, `ProjectBrowser.tsx` |
| **Tags + marker↔view tracking** (VS:134-208) | PARTIAL — grid bubbles and door/window symbols are drawn, but there is no tag object and no marker graph | `TagCreate{target_guid, tag_type, position}`, stored as an overlay record keyed to the target GUID, re-evaluated on regeneration. Auto-tag-all per view (`TagAll`) as a follow-on. Marker graph only matters once markers exist (see next row) | **M** | `ifc_service.py`, `command_bus.py`, `useBimStore.ts`, new `Tags` palette |
| **Sections/elevations as placed objects** (VS:140-152) | PARTIAL — `render_2d_view` renders section/elevation geometry, but they are view types, not placed markers | Promote the existing view record to a placement-bearing object: `marker_id` on the view, `marker → view_ids[]` by index, `view → marker` back-reference. Enforce the "all of a marker's views share a sheet" rule (VS:191-194) as a posted warning | **M** | `bim.ts`, `ifc_service.py`, `useBimStore.ts`, `Viewport3D.tsx`/`PlanViewport2D.tsx` |
| **Schedules / quantities** | ABSENT (`ProjectBrowser.tsx:54`) | A schedule is a *query over `element_meta` + type registry* rendered as a `ScheduleSheetInstance`-style placement (VS:256-264). Minimum: `ScheduleCreate{name, ifc_class, fields[]}`, computed from the same `query_elements` the AI driver already uses (`ai_driver.py:109`), placed on a sheet like a viewport | **M** | `ai_driver.py` (query reuse), `ifc_service.py`, `command_bus.py`, `SheetCanvas.tsx`, `ProjectBrowser.tsx` |
| **Stairs + railings** (ST) | ABSENT | Large. Honest first step: a *component* stair (`IfcStair` + `IfcStairFlight` + `IfcRailing`) driven by `{base_level, top_level, width, riser_count}` — a parametric run, not a sketch editor. Railing as a hosted sweep along a path | **L** | new `stairs.py`, `ifc_service.py`, `command_bus.py`, viewport |
| **Curtain walls** (CW:23-49) | ABSENT | Model as a UV grid: `{u_lines[], v_lines[], panel_type, mullion_type}` with cells addressed by their two bounding gridlines, panels `IfcPlate`, mullions `IfcMember`. Provenance + lock flags are overlay-only (CW:373-376). Start with a rectangular system grid and manual lines only | **L** | new `curtain_wall.py`, `ifc_service.py`, `command_bus.py` |
| **Topography** (TO) | ABSENT | `TopoCreate{points[], boundary[]}` → `IfcGeographicElement`/site surface in `model.ifc`, triangulation + point/contour editing in the overlay. The terrain editor is its own 2D/3D surface interaction; do not attempt inside the plan editor | **L** | new `topography.py`, `ifc_service.py`, `command_bus.py`, viewport |
| **Rooms / spaces** | ABSENT | `IfcSpace` per level with a boundary computed from bounding walls, plus `SpaceCreate/SpaceUpdate` and room tags. Revit computes containment from explicit calculation points (FE:328-330) — reuse that rule | **L** | new `spaces.py`, `ifc_service.py`, `command_bus.py` |
| **Revit Links** | ABSENT | A link is a *reference to another `.bimworks`* resolved at render/query time, never merged into `model.ifc`. Minimum: `LinkLoad{path, transform}` + linked-model browser node + read-only geometry | **L** | `ifc_service.py`, `command_bus.py`, `ProjectBrowser.tsx`, viewport |

### Can the IFC-of-record + overlay strategy express all of this?

**Yes for most of it**, and the corpus says so explicitly where it matters:

* Types and families map to `IfcTypeObject`/`IfcTypeProduct` + `IfcRelDefinesByType`, with parameters in
  `IfcPropertySet` (FE:525-528) — exactly what SPEC §3.5 already specifies and what is **not yet
  written**.
* Layers map to `IfcMaterialLayerSet` + `IfcMaterialLayerSetUsage` (SPEC §3.3(2)).
* Curtain walls/panels/mullions map to `IfcCurtainWall`/`IfcPlate`/`IfcMember`; **provenance, lock
  state and skipped segments have no IFC representation and belong in the overlay** (CW:373-376).
* Views, sheets, viewports, markers, templates and schedules have **no IFC model at all** — IFC
  drawings are snapshots — so all of it must live in `views/*.json` (VS:279-292), which is where the
  current view/sheet records already live (`ifc_service.py:4763-4764`, `:4776-4778`).

**Genuinely cannot be expressed in this strategy, and must be flagged as such:**

1. **Loadable-family behaviour with geometry generators.** Nested families, yes/no-driven geometry
   variants, swept/blend/revolve recipes and formula-driven dimensions have **no IFC representation**
   (FE:525-528). The overlay can hold a `.bwfam` recipe, but a *third-party* tool opening `model.ifc`
   alone will see only the last-evaluated instance geometry — never the recipe. This is the honest
   ceiling: BIMWorks can be parametric to itself, but the IFC-of-record is always a snapshot.
2. **Family-published named references** (FE:252-263). A family publishes typed references the project
   dimensions to. IFC has no reference-object model, so dimensioning to a family's reference plane is
   overlay-only and invisible to any IFC consumer.
3. **Curtain-grid provenance and the lock mechanism** (CW:117-133) — overlay-only, per CW:373-376.
4. **Hosting as a migratable state** (FE:275-302). The host↔work-plane↔level conversion and the
   "frozen because face gone" state have no IFC counterpart; the overlay can carry the state, but a
   foreign IFC consumer cannot follow it.
5. **Regeneration dependency tracking.** HE:209-211 records that Revit's own
   `RegenStepRepository`-to-element invalidation mapping is **not recoverable** from the binaries. So
   BIMWorks' `dependency_graph.py` cannot be validated against Revit ground truth by this evidence
   base — it is a design choice, not a clone. **(unverified against Revit)**

---

## 4. Notes on the four capabilities that are actually solid

These deserve stating plainly, because the audit's job is precision, not criticism.

**Hosted openings are real and correct in the IFC** (issue 4). `add_door` creates an
`IfcOpeningElement`, assigns it a body representation `INCHES_4` thicker than the wall for a clean
boolean (`ifc_service.py:1477-1488`), places it on the host's own baseline via
`_hosted_placement_matrix` (`:1293-1321`), cuts with `feature.add_feature` (→ `IfcRelVoidsElement`,
`:1498`) and fills with `feature.add_filling` (→ `IfcRelFillsElement`, `:1529`). The census confirms
`IfcOpeningElement: 2`, `IfcRelVoidsElement: 2`, `IfcRelFillsElement: 2` **[PROBED]**. Deleting the
host deletes both openings, heals nothing stale, and leaves `IfcOpeningElement` count at **0**
**[PROBED]** (`ifc_service.py:1945-1959`). Round-trip through the container preserves the host binding
and the offset to 3 decimals (`scratch/test_hosted_openings.py` case 6).

**Grids really are in the IFC now.** The docstring at `ifc_service.py:1836-1846` records that grids
were once a Python dict that never reached `model.ifc`; the current code creates a real `IfcGrid` with
an `IfcGridAxis` and an axis curve in world coordinates (`:1849-1881`), and the census shows
`IfcGrid: 1`, `IfcGridAxis: 1` **[PROBED]**. The gap is *edit*, not creation: `translate_element` on an
`IfcGrid` mutates `meta["start"]/["end"]` only (`:2060-2065`) and never rewrites the axis curve, so a
moved grid diverges between the overlay and `model.ifc`. That is a one-method fix and should be
scheduled.

**The bus is genuinely complete at the gate's definition.** S-v0.2 §6 requires `COMMAND_REGISTRY` to be
the single source of truth and every UI mutation to be journaled. `check-bus-parity.mjs` passes with
"29 UI actions declared and dispatched" and 2 `executeTransaction` call sites (the sketch and AI bulk
paths, allow-listed at `:113-121`), and `test_bus_parity_audit.py` demonstrates 16 mutating HTTP routes
each producing a journaled transaction, a negative control, and one-step undo/redo for all seven
creation commands. **The gate's weakness is coverage, not integrity:** it verifies the 29 declared
actions, so the five P3 modify commands (`ElementCopy`, `ElementRotate`, `ElementOffset`,
`WallTrimExtend`, `WallSplit`) and the five sheet/viewport commands are declared but **not** exercised
by that audit — only `test_v2_core.py` and `test_sketch_model.py` touch some of them.

**The AI driver works, and the `walls[0]` defect is fixed.** The 2026-10-14 review found the planner
returning `walls[0]` for unmatched phrases. Current `resolve_target_wall` returns the single wall only
when `len(walls) == 1` and otherwise `None` (`ai_driver.py:314-319`), and `test_ai_driver.py` reports
105/105 passed including the category-disambiguation cases. `_validate_and_finalize_plan` rejects
unknown commands and schema-invalid params before execution (`:809-827`), and
`get_tool_catalog` enumerates every registry entry (`:1097-1194`).

---

## 5. Top 10 changes to make BIMWorks author like Revit

Ranked by leverage — the amount of "feels like Revit" unlocked per unit of work.

1. **Build the type layer, and write it to IFC.** A `type_registry` with typed parameters, a `type_id`
   on every element, five `Type*` commands, and `IfcWallType`/`IfcDoorType`/… + `IfcRelDefinesByType` +
   `IfcPropertySet` on create. This is already normative (SPEC §3.5) and entirely absent **[PROBED]**.
   It unblocks items 2, 3 and 6 below and is the difference between "an IFC authoring tool" and "a
   parametric BIM author". *Effort L.*

2. **Make the Type Selector and Edit Type real.** Today they are a read-only `<div>`
   (`PropertiesPalette.tsx:183-197`) and a hardcoded mock (`EditTypeModal.tsx:38-56`). After change 1
   this is mostly wiring: bind the selector to the registry, make the modal render and dispatch typed
   parameters. Highest visible payoff per hour in the whole list. *Effort M.*

3. **Type-driven propagation through the dependency graph.** Editing a type must re-drive its
   instances. `update_element` currently ignores `type_properties` entirely **[PROBED]**, so even the
   stored fake types cannot change. *Effort M (given 1).*

4. **Close the modify-tool gap: Mirror, Array, Pin.** Mirror and Pin are S-scale and both are pure
   user-expectation items (an architect reaches for Mirror constantly); Array needs a group
   underneath, so sequence it after change 5. Mirror is the highest-leverage single command missing
   from the bus. *Effort S–M.*

5. **Add Groups, and give `delete_element` a real deletion closure.** Revit's groups also make Array
   honest (`MullionsWillBeDeleted` and friends aside, the group is the array's data model), and
   S-v0.2 §7 already requires deletion closure with a `[REQ]` citing
   `ADocument::computeDeletionClosure`. One data structure buys three gaps. *Effort M.*

6. **Add compound structure / layers to the type.** SPEC §3.3(2) commits to it and S-v0.2 §20.3
   records it as untestable today. Do the data model, the IFC authoring
   (`IfcMaterialLayerSet` + `IfcMaterialLayerSetUsage`) and the priority ordering first; defer the
   wrapping-at-inserts geometry, which is the genuinely hard part. *Effort L.*

7. **Make floors sketch-based like roofs.** An S-scale change — seed the sketch in `add_slab` the way
   `add_roof` does (`ifc_service.py:1806-1811`) and let `_edit_sketch` accept `IfcSlab` (it hard-routes
   to `set_roof_sketch` at `:722` and raises at `:641-642`). It removes an inconsistency an author
   would hit within minutes.
   *Effort S.*

8. **Revive the unimplemented ribbon tools that are pure datum/annotation.** Grid and Level are marked
   `implemented: false` (`toolCaptions.ts:38-39`) even though `GridCreate` and `LevelCreate` are
   implemented, tested and undoable — the tools are dead only for want of a viewport branch. Same for
   Aligned Dimension and Tag. Fixing grid/level placement is cheap and makes the datum story whole;
   and fix `translate_element` on `IfcGrid` (`ifc_service.py:2060-2065`) at the same time so a moved
   datum cannot diverge from `model.ifc`. *Effort S.*

9. **Add Tags and Schedules.** Tags complete the annotation story and are the precondition for the
   marker↔view graph (VS:134-208). Schedules are the cheapest large perceived capability, because the
   query engine they need already exists (`ai_driver.py:109` `query_elements`): a schedule is a
   *rendered query*, and `ScheduleSheetInstance` placement follows the viewport pattern the codebase
   already has (`ifc_service.py:4556-4647`). *Effort M.*

10. **Then take one of the three big verticals — Curtain Walls, Stairs, or Topography — and finish it
    end to end rather than starting all three.** Each is a genuine L and each has an overlay-only
    residue that must be declared (CW:373-376). Curtain walls are the most self-contained (a UV grid
    plus two derived element kinds) and the most visually convincing in an architectural model;
    stairs have the clearest parametric short form (a component run, not a sketch editor). Pick one,
    ship author → IFC → plan/section → schedule. *Effort L each.*

### What not to do

Do not build a Family Editor UI (S-v0.2 §14 opens by deferring exactly this, and FE:495-528 shows it
is the largest hidden cost in any Revit clone — four subsystems, a formula solver with four levels of
cycle detection, a reference system and a visibility model). Do not attempt MEP connectors, which
FE:383-401 shows are *the bulk* of Revit's family machinery and are explicitly out of architectural
scope. Do not attempt `.rvt` interoperability.

---

## 6. Coverage gaps this audit could not close

Recorded rather than skipped, per S-v0.2 §20.3:

* **`dependency_graph.py` was not audited** beyond noting that `move_level` and sketch edits call it
  (`ifc_service.py:1144-1151`, `:883-891`). Its recompute-correctness is a separate question with its
  own test file (`scratch/test_dependency_graph.py`).
* **`main.py`'s 56 routes** were enumerated but only the 16 mutating ones were verified as bus-backed
  (by `test_bus_parity_audit.py`). The 10 UI commands with no HTTP route were not individually
  executed.
* **Wall-join geometry quality** is out of scope here; S-v0.2 §11.3 and §20.1 record the open J1–J4
  defects and the constant-thickness corpus blindness (18 passing checks, every fixture
  `thickness: 0.3`).
* **`hlr_renderer.py` / `mesh_hlr.py`** (2D output fidelity) were not audited — this audit is about
  authoring, not drawing.
* **`onSymbolIdChanged` / `onPropertiesChanged`** (S-v0.2 §8.2's editor contract) could not be checked
  against an implementation because no editor-class layer exists to host the hooks; the active tool is
  a string union plus viewport branches (`bim.ts:210-228`).
* **Revit ground truth is documentation-and-export-table derived** for most of the corpus. FE:556-565,
  CW:380-391, VS:315-327 and HE:203-211 all record that native evidence is export names only and that
  **no running Revit was observed**. Ground-truth claims here inherit that limit, and S-v0.2 §20.6
  correctly requires a live probe in Revit before any of it is treated as settled.
