# Options review: should BIMWorks piggyback on IngeTrazo's GUI as an extension?

**Reviewed:** IngeTrazo `d8ee8c0` (`main`, GPL-3.0-or-later) — its extension API, plugin docs and IFC layer; **OpenTrace BIM `bf57de5`** (`2026-10-09`, GPL-3.0-or-later, `__version__` 0.12.9) — the working precedent of exactly this strategy; against `Axotopia/BIMWorks@22705ce`.

**Method:** read IngeTrazo's `views/extension_api.py`, `docs/plugins.md`, `core/extensions.py`, `core/extension_manager.py`, `formats/ifc.py`, `core/bim.py`, `tests/test_ifc_export.py`, and searched the whole tree for IFC import; read OpenTrace BIM's `__init__.py`, `host.py`, `ifc_export.py`, `AUDIT_0.12.9.md`, `FEATURES.md`, `ROADMAP.md`, and inventoried its modules and tests; inventoried BIMWorks' 56 API routes and IFC surface. Nothing was modified; no code was executed for this review. Every claim cites a file.

**Short answer up front:** the strategy is *technically proven* and the extension API is far more capable than it looks — but you already suspect the right problem, and it is worse and more specific than "IngeTrazo may be a problem for IFC integrity". **Piggybacking does not remove the IFC work; it relocates it into your plugin, where you must rebuild — from scratch and less well — what BIMWorks already has via ifcopenshell.** OpenTrace is the evidence: it had to write its own 1,417-line IFC *exporter* and its own IFC *reader* on top of a host whose entire IFC layer is a 217-line, export-only, deliberately ifcopenshell-free writer. That is a sound trade for a modeller that emits BIM. It is a backwards trade for a project whose thesis is IFC as the model of record.

---

## 1. The precedent is real, and it is not elementary

OpenTrace BIM is a serious piece of work, not a toy — worth stating plainly, because it changes the argument from "is this possible?" to "is this the right shape for us?".

| Property | OpenTrace BIM |
|---|---|
| Host | IngeTrazo, **0.5.7+** required (`OpenTrace_BIM/host.py:9`); tested build 0.11.1, current source 0.12.9 (`OpenTrace_BIM/__init__.py:7`) |
| Size | **44,415 lines** of Python across 111 files, plus a parallel older copy of the same tree (`OpenTrace_BIM/` 61 files vs `arquitetura_parametrica/` 48 files — a migration in progress, both `setup()`s still present) |
| **Release state** | Last **user-tested** build is 0.11.1 (`README.md:47`, `CHANGELOG.md:3`); 0.12.9 is an unreleased **release candidate** (`CHANGELOG.md:38`) and ROADMAP's baseline is 0.10.2-dev. The IFC layer lives only in the newer, untested tree — `arquitetura_parametrica/` is the pre-IFC snapshot. Release is explicitly blocked: *"no stable tag, public release or official catalog update until these tests pass"*, and **IFC import regressions are "not yet confirmed resolved"** (`CHANGELOG.md:35,38`) |
| Automated tests | **None in the repository**: no test file, no `pytest`/`unittest` import, no `assert`, no CI config, no `requirements.txt`, no `pyproject.toml`. Note that `AUDIT_SUMMARY.md:28-29` nonetheless refers to "wall UVW affine transfer unit tests passed" and "BIM metadata/identity Undo/Redo tests passed" — those tests are not present here and cannot be verified from the repository. Validation is otherwise a manual "user-tested baseline" plus markdown checklists |
| Capability | Parametric walls (straight, curved, sloped top, lean/twist, independent endpoint heights, composite multilayer with per-layer materials and functions, hosted openings incl. on curved walls), slabs (free polygon, curved edges, chamfer/fillet, hosted polygonal openings), columns (complex profiles, segmented, per-segment materials, inclination), beams (inclined, curved), reusable complex profiles with holes, layer combinations with visibility/lock/intersection groups (`FEATURES.md`) |
| Own IFC | A **1,417-line** exporter (`OpenTrace_BIM/ifc_export.py`) *in addition to* the host's, plus its own 747-line IFC **reader** — with the integrity qualifications in §3 |
| Uses none of | `add_outliner_kind`, `add_pickable`, `add_file_opener`, `import_igz` — so extension objects are invisible to the Browser, cannot be selected or deleted with the native Select/Supr tools, cannot own a file suffix, and cannot insert a component |
| Self-description | `OpenTrace_BIM/__init__.py:5` — "**Development draft: implementation only; runtime validation is pending**" |
| Stated ambition | "designed to grow beyond a single host… adapted to **Blender/Bonsai** and **FreeCAD**" (README), with a planned-adapter table in `FEATURES.md` — **aspiration only in code**: 35 of 62 files import host packages, only 6 small modules are host-free, and there is no adapter layer (§7) |

So: **yes, you can build an architectural BIM authoring layer as an IngeTrazo extension, and someone has, at scale.** The mechanism is not in question. What that costs and what it caps is §3–§5.

---

## 2. What the extension API actually gives you

IngeTrazo's `ExtensionApp` (`views/extension_api.py`, `API_VERSION` 2, 351 lines) is deliberately permissive — much richer than "add a tool to a menu":

| Facility | What a BIM layer can do with it | Source |
|---|---|---|
| `document_data` / `set_document_data` | Persist **one JSON-safe value per plugin, saved in the .igz**, reset by New/Open; each set is one undo step | `docs/plugins.md` |
| `add_panel` / `show_panel` | A real tab in the side tray beside Properties / BIM / Terrain; remembered position; several panels can share one tab | `extension_api.py:113-179` |
| `add_menu` + `addAction`, `add_menu_action`, `add_context_menu` | Own submenu, own shortcut (dropped if taken), viewport right-click entries | `:180-254` |
| `add_outliner_kind` | Describe **your** container groups in the Browser: type column and tooltip properties | `:227` |
| `group.ext[app.key]` | Per-group parameters of yours — "kept with copies, saved in the .igz" | `docs/plugins.md` |
| `add_overlay` + `world_to_pixels` | QPainter overlays every frame, world metres → pixels, thousands of points | `:255-268` |
| `add_snap_provider` | Feed the snap engine your own snap candidates (never overrides a named point) | `:269` |
| `add_pickable` | Your own selectable/deletable items | `:274-302` |
| `add_file_opener` | Register a file suffix and open it yourself | `:303` |
| `import_igz` | Bring another `.igz` in as one component, at a point, one undo step | `:99` |
| `enter_workspace` / `leave_workspace` | Take over the viewport in a modelling mode of your own | `:330-349` |
| `core.ai.run_transactional` | Scripted/AI mutation with one undo step, whole rollback, no entry if nothing changed | `docs/plugins.md` |

That is enough surface to build a parametric element editor, a levels panel and an IFC exporter inside a plugin — which is exactly what OpenTrace did.

### The hard limits, with evidence

1. **The public API cannot register persistent modelling tools.** OpenTrace's audit is explicit: *"IngeTrazo 0.5.7 does not expose public registration/activation methods for persistent modelling tools. OpenTrace therefore still needs a compatibility boundary for `_tools` / `_activate_tool`"* (`AUDIT_0.12.9.md`). Its `host.py:55-57` **requires host privates to exist** — `_tools`, `_tool_actions`, `_tool_group`, `_activate_tool` — and raises *"The tool integration in this IngeTrazo installation is not compatible"* otherwise; registration writes `win._tools[key] = tool` (`host.py:75`) and activation calls `app.window._activate_tool(...)` (`host.py:89`). Editing code also calls the private `viewport._world_to_pixel(...)` throughout (`beam_ui.py:281`, `column_ui.py:394`, `membrane_tool.py:73`) because the public API exposes only the vectorised path. **A model-editing-heavy BIM layer is therefore built on host internals, guarded by `hasattr` checks and a version pin.**
2. **The API is explicitly unstable.** `docs/plugins.md:1-3`: *"The plugin API is **not stable yet** — expect breaking changes during the 0.x series."* OpenTrace's own history shows the tax of tracking it (0.5.7 → 0.11.1 → 0.12.9).
3. **Plugin state must be JSON-safe**, and it lives in a namespace separate from the host's BIM tag: `group.ext[app.key]` is yours, *"apart from `group.ifc`, which the BIM panel replaces when it retags"* (`docs/plugins.md`). Two disjoint BIM namespaces in one document is a data-integrity question in itself.
4. **Host items can't be dragged.** `add_pickable` gives select/delete and notes *"moving them comes later"* (`extension_api.py:274-292`) — direct manipulation is on you, via overlays and workspace mode. Notably OpenTrace uses **none** of `add_outliner_kind`, `add_pickable`, `add_file_opener` or `import_igz`, so its objects are invisible to the Browser's type column and cannot be selected or deleted with the native tools — a capability gap the host offers and the precedent does not close.
5. **API roughness you inherit.** `add_menu` has no de-duplication — the host always constructs a new `QMenu` (`extension_api.py:212-225`) — and OpenTrace calls it four times with the same title, so users get four identical submenus. Small, but it is the texture of building a product on someone else's 0.x surface.
5. **Fragility of living inside someone else's Qt process** is not hypothetical — see §4.

---

## 3. The IFC question, answered with evidence

Your instinct is correct, and here is the precise shape of it.

**IngeTrazo's IFC layer is export-only, hand-written, and deliberately library-free.** `formats/ifc.py` is **217 lines** and opens: *"IFC4 export — tagged BIM objects to a STEP Physical File, **by hand**. Only what the thesis needs, written without dependencies"*. Its declared scope is *"the spatial skeleton (project → site → building → storey), one element per tagged BIM object with its REAL IFC class, **faceted-BRep geometry** in world metres, and BaseQuantities (area, and volume when the object is watertight)"*. Two further admissions matter:

- *"Untagged geometry is not exported — the tag IS the opt-in"* — BIM is a tagging layer over freeform geometry, by design.
- *"ifcopenshell stays out deliberately… and **import can be added later**"* — there is no IFC import, and I confirmed it: a tree-wide search for any IFC-reading function returns nothing.

Its own test asserts exactly that ceiling (`tests/test_ifc_export.py:60-78`): a tagged wall exports `IFCWALL` + `IFCFACETEDBREP` + `IFCCLOSEDSHELL` + `IFCQUANTITYVOLUME` + `IFCRELCONTAINEDINSPATIALSTRUCTURE`. Geometry, class name, quantities, storey containment. No material layers, no openings as relationships, no type objects, no property sets beyond quantities — because those concepts do not exist in the host's mesh-and-tags model.

**OpenTrace's response to that is the strongest evidence in this review.** Faced with a host exporter that could not express a parametric wall, they wrote their own — `OpenTrace_BIM/ifc_export.py`, **1,417 lines, 6.5× the host's** — and it emits a genuinely serious IFC4 surface: `IfcPolygonalFaceSet` (tessellation), `IfcFacetedBrep`/`IfcClosedShell`, `IfcExtrudedAreaSolid` (native swept solids), `IfcMaterialLayerSet` + `IfcMaterialLayerSetUsage` with a core-tied offset, `IfcPropertySet` + `IfcRelDefinesByProperties`, `IfcRelDefinesByType`, `IfcElementQuantity`, `IfcRelVoidsElement`, `IfcRelAggregates`, `IfcRelContainedInSpatialStructure`, `IfcClassificationReference`, and `IfcProjectedCRS`/`IfcMapConversion` for georeferencing. Its header says it *"mirrors openBIM patterns used there [Bonsai]… while keeping OpenTrace as the authority for geometry"*. They also wrote their **own IFC reader** — `ifc_import.py`, 747 lines, with an *optional* IfcOpenShell fast path and a dependency-free STEP fallback; the audit records the hazards they had to handle by hand: *"SI/conversion-based length units, recursive `IfcLocalPlacement`, mapped-item transforms, polygonal/tessellated/BRep/extruded representations"*.

**But the IFC integrity story only holds up to a point, and the qualifications are exactly the ones that matter to BIMWorks.** Four, all from their own code:

1. **Quantities are nominal, not net.** `Qto_*BaseQuantities` are computed **from the parametric record, not the mesh**, and self-labelled *"OpenTrace parametric nominal"* (`ifc_export.py:987,1017-1037`). A wall's `GrossVolume` is `length × height × thickness` — **openings and junctions are ignored**. A takeoff read from that file will over-order materials, and nothing in the file warns the consumer.
2. **Openings have no geometry.** `IfcOpeningElement` + `IfcRelVoidsElement` are emitted, but the opening's `Representation` is `$` — the plugin itself calls it a *"representation-less IfcOpeningElement"* (`ifc_export.py:1115-1116,1216`). Doors and windows are worse: class plus `IfcRelFillsElement`, **no product shape at all** (`:1133-1134`). So "openings as real voids" is a relationship, not a void.
3. **Only one export profile gets even that.** `opening_relations` is enabled for the `opentrace` profile alone; `bonsai`, `archicad` and `revit` bake openings into the body mesh instead (`ifc_export.py:29-34,1213-1219`). Add the profile-dependent geometry strategy — tessellation vs faceted BRep vs swept solids — and the same model produces materially different IFC depending on the consumer selected.
4. **Round-trip fidelity is proprietary.** The lossless channel is the entire parametric record as JSON in a custom property set, `EPset_OpenTraceRoundTrip/PayloadJSON` (`ifc_export.py:1370-1374`). Standard consumers get the generic properties; only OpenTrace can read its own model back. And **imported IFC is never promoted to parametric** — it becomes inert tagged groups (`BIM_IMPLEMENTATION.md:22`, `ifc_import.py:620-634`), so the round trip is not a round trip for editing.

That is the real lesson for BIMWorks: a hand-built IFC layer *inside a plugin* reaches the shape of IFC without the guarantees of it. You get entities, relationships and quantities that look right and are wrong in ways no consumer can detect — which is precisely the failure mode an IFC-as-model-of-record architecture exists to prevent, and precisely what ifcopenshell-plus-a-validated-model gives you for free.

| IFC capability | BIMWorks today | IngeTrazo host | OpenTrace plugin |
|---|---|---|---|
| IFC **import** | Yes — `POST /api/upload/ifc`, ifcopenshell engine | **None** (explicitly deferred) | Hand-rolled fallback reader + optional IfcOpenShell; imported elements stay inert, never parametric |
| IFC export | Yes — `GET /api/export/ifc`, ifcopenshell | Export-only, 217 lines, faceted Brep + quantities | Own 1,417-line writer, per-target profiles |
| Parametric geometry | ifcopenshell `add_wall_representation` etc. | Faceted Brep of mesh triangles | Tessellation *or* BRep *or* swept solids, per profile |
| Material layers | Via IFC model | **No** | `IfcMaterialLayerSet` — reimplemented |
| Hosted openings | ifcopenshell opening subtraction (real voids) | Baked into the mesh | `IfcRelVoidsElement` with a **null representation**; not a void |
| Doors / windows | ifcopenshell products with openings | Tags only | Class + `IfcRelFillsElement`, **no geometry** |
| Property sets / types | Via IFC model | Quantities only | `IfcPropertySet`, `IfcRelDefinesByType` — reimplemented |
| Quantities | From the IFC model and geometry | Quantities only | **Nominal gross from parameters; openings and junctions ignored** |
| Model of record | **IFC** (`backend/ifc_service.py`, 6,019 lines on ifcopenshell) | Mesh + face tags; IFC is an export | Mesh + plugin JSON; IFC is an export |

Read the last row twice, because it is the whole decision. BIMWorks' engine *is* an IFC model with ifcopenshell doing the work; IngeTrazo's engine is a non-manifold mesh with tags, and IFC is a lossy exit. Piggybacking means rebuilding the semantics you already have — the OpenTrace path — and then owning that code forever inside a plugin.

---

## 4. The integration tax, from the maintainers' own audit

This is the part a "just write an extension" plan usually omits, and OpenTrace's `AUDIT_0.12.9.md` documents it frankly:

- **A host-wide Qt event filter caused a native crash.** 0.12.8 installed a `QApplication` event filter rewriting widget text on `Show`/`Polish`/`ChildAdded`/`LayoutRequest`, and *"matched the reported native crash when opening an OpenTrace modelling page"*. 0.12.9 removed it.
- **Monkey-patching a host method was also removed** — 0.12.8 *"replaced a host status method at runtime"*; that mechanism is gone in 0.12.9.
- **The host scanned their installer backups as plugins**, producing duplicate/load-error extensions, because older installers wrote `OpenTrace_BIM_backup_*` directories inside IngeTrazo's `plugins/`.
- **A parametric rebuild silently corrupted positioned textures**, by reusing *"the first semantic `side` appearance for multiple regenerated wall faces"* — fixed with a per-face affine UV transfer, with an explicit *"deliberately falls back to the host planar texture mapping rather than guessing"*.
- **Update rollback could produce a mixed-version install** until made atomic at file level.
- **Host-private access** (§2.1) and **single-point `_world_to_pixel`**, which the audit itself labels *"a host-0.x compatibility dependency"*.

Every one of those is the cost of owning a large parametric layer inside a GUI you do not control. None of it is a reason the strategy fails; all of it is recurring maintenance you would inherit, on a host whose API promises breaking changes.

### The engineering ceilings the same code reveals

This is the part that should decide the question, because these are not integration bugs — they are what happens when you build BIM semantics on a mesh-and-tags engine instead of on IFC. Every one of them is something BIMWorks already does properly, and each would have to be re-solved badly:

| What | OpenTrace's approach | BIMWorks today |
|---|---|---|
| **Hosted openings** | Analytic **strip decomposition** of the swept skin, not a boolean: the strip containing the opening has its side face replaced by below/above/jamb/sill quads (`model.py:846-884`). Hard limits: **at most one opening per longitudinal strip** (`:846-848`), and openings must clear base and top by `MIN_DIM` (`:83-84,851-852`) — so **a floor-to-head door is rejected while the UI's sill control permits 0.0** (`ui.py:261`). The host mesh *does* support holes (`core/mesh.py:959 add_hole`, `Face.holes`) and the plugin **never calls it** | ifcopenshell opening subtraction; real voids in the IFC model |
| **3-way wall junctions** | **Not joined** — "overlap-safe square-cap strategy: separate wall solids may overlap locally" (`junctions.py:6-9`). Only two-wall corners get a true 2-D miter | A join engine with 37 matrix checks and, after Phase 1.1/1.2, incremental scoped recomputation |
| **Curves** | No B-Rep, no NURBS, no analytic solids anywhere: everything tessellated polygons, arcs sampled at ≤5°, ≤0.20 m, max 256 samples (`model.py:48-50`) | ifcopenshell geometry with IFC curve/solid representations |
| **Derived state** | Junction data is rewritten by `sync_wall_junctions`, called **only** from the UI refresh, which bumps `scene.version` manually and comments *"this is not an extra undoable command"* (`ui.py:1057-1068`); level-bound wall heights are regenerated by calling `EditWall(...).do(scene)` **outside** history (*"Deliberately derived, not another history entry"*, `levels.py:104-107`). If a derived-geometry signature misses an input, undo/redo leaves stale geometry | Wall joins and level-driven geometry recomputed inside the engine, under the transaction and revision system |
| **Parametric vs native edits** | A *native* edit beneath a parametric element is not reconciled: `read_wall` raises if the group was scaled/mirrored/rotated or the parent mesh is non-empty (`model.py:1099-1110`), and the plugin blocks the host's own group-edit path by consuming double-click (`context_guard.py:51-62`). The user must undo a legitimate native edit to regain parametric editing | One model, one edit path — every mutation is a typed command through the bus |
| **Load** | Nothing rebuilds on load: the stored mesh is authoritative for display, the record for editing, and **nothing detects a file whose mesh and record disagree** (`model.py:1099-1116`) | IFC is parsed on load and is the authority; the delta protocol re-derives state and a differential gate proves client/engine equivalence |

Read that table as a specification of what "piggybacking" actually costs. Hosted openings, multi-way joins, curve fidelity and derived-state consistency are exactly the problems BIMWorks has already solved *because* it put an IFC kernel underneath; a plugin on a mesh engine has to rediscover each one with less machinery, and the receipts above show where that lands.

---

## 5. What BIMWorks would give up and gain

BIMWorks' 56 routes are the inventory of what a piggyback would have to re-home: IFC upload/import and export, sheet and batch-PDF export, 2D view/slice HLR, constraints (align / lock-dimension / equalize), wall joins, georeferencing, the command bus with schema + transaction + journal + undo/redo, AI plan/execute, and the delta `state` protocol.

- **Given up (or rebuilt in a plugin):** IFC import, IFC-as-model-of-record, constraints, sheet/PDF documentation pipeline, the typed command bus with its journal and origin tagging (the AI/agent surface), and the delta protocol — plus the gates that verify them.
- **Gained:** a native Qt GUI you don't build, a mature direct-manipulation interaction model (grips, snap engine with 12 snap kinds, work-plane lock, inference guides, hot retype), a solid push/pull engine with the hermeticity guard, georeferencing/DEM/GeoTIFF survey import, DXF/SKP/OBJ/STL import, and a plugin distribution channel (catalog + reviewed list, `core/extension_manager.py`).
- **Not gained:** IFC integrity. That is precisely the thing that does not come along.

IngeTrazo's documentation side is stronger than I expected — it has `core/hlr.py`, `core/section.py`, `core/composition.py` (a paper-sheet composer), dimensions and text labels — so a piggyback is not losing 2D documentation wholesale. The loss is concentrated and severe in one place: **IFC**.

---

## 6. The options, ranked

| # | Option | Buys | Costs | Verdict |
|---|---|---|---|---|
| **A** | Keep building BIMWorks' own GUI | Full control of IFC semantics, the command bus, documentation, gates | The GUI cost you are trying to avoid | Status quo; correct if IFC-as-model-of-record is the thesis |
| **B** | **IngeTrazo extension** (the piggyback) | Free GUI + solid engine + parametric interaction model + plugin distribution | You own an IFC writer *and* reader in-plugin (~1.4k lines minimum, per-target profiles), host-privates dependency, unstable 0.x API, no IFC as model of record | Only if the thesis changes from "IFC authoring application" to "architectural modeller that also emits BIM" |
| **C** | **Workbench for Blender/Bonsai or FreeCAD** | A GUI you don't build **and** an IfcOpenShell-based host — IFC integrity preserved by the platform | Much heavier host, less architect-friendly modelling UX, different plugin model | **The version of "don't build a GUI" that respects your thesis.** Note OpenTrace's exporter already carries a `bonsai` profile and mirrors Bonsai's openBIM patterns, and their roadmap plans Bonsai/FreeCAD adapters — the ecosystem is converging on this split |
| **D** | Hybrid bridge: author in IngeTrazo/OpenTrace, convert to IFC through BIMWorks' engine | Best-in-class modelling UX + your own IFC authority | Makes your core differentiator depend on **two** 0.x schemas you don't own (IngeTrazo `.igz` + OpenTrace's private plugin-data namespace, whose own README warns of changes between minor versions) | Attractive on paper, fragile in the exact place you cannot afford fragility |
| **E** | **Borrow the concepts, not the host** | Nearly all the product value, zero IFC risk, no new host dependency | Implementation work in your own engine | **What I would do** — see §7 |

Two framing points that decide between these. First, **"don't build a GUI" and "keep IFC integrity" point at different hosts**: IngeTrazo is the best host for freeform architectural direct modelling; the IfcOpenShell hosts (Bonsai, FreeCAD) are the best hosts for IFC. You can have the first or the second cheaply, but not both — and BIMWorks' whole architecture says you chose the second. Second, **the piggyback does not delete work, it moves it**: OpenTrace's 44k lines are the receipt, and the IFC portion of it is work BIMWorks has already done better.

---

## 7. What I would actually do: option E, concretely

OpenTrace's most valuable export to BIMWorks is not its architecture — it is its **requirements matrix**. `FEATURES.md` is a de-facto specification of what architectural element editing should support, and nearly all of it lands in BIMWorks' existing IFC-based engine *without* the flattening that OpenTrace has to engineer around:

1. **Composite multilayer assemblies with per-layer materials and semantic functions** — the single biggest capability gap. In BIMWorks this should be `IfcMaterialLayerSetUsage`, which it already stores in IFC; OpenTrace has to rebuild layer sets at export time because the host has no concept of them.
2. **Wall editing depth**: curved walls, sloped tops, lean/twist, independent endpoint heights, insert/move vertices, continue/extend endpoint, curve an existing segment. BIMWorks' wall is `start`/`end`/`height`/`thickness` (`backend/command_bus.py:21-27`) — the parametric baseline needs to become a polyline/curve with per-vertex heights.
3. **Hosted openings as first-class relationships** — OpenTrace emits `IfcRelVoidsElement`; BIMWorks already does opening subtraction via ifcopenshell, and the `host_wall_guid` + `offset_along_wall` model (`src/types/bim.ts:22-23`) is the right shape to generalise to arbitrary openings (polygonal, curved walls) while keeping the IFC relationship.
4. **Reusable complex profiles with outer loops and holes**, shared between column/beam — a direct fit for BIMWorks' sketch model (`backend/sketch_model.py` already has holes-capable curve loops and a `profile` kind).
5. **Layer combinations** (named visibility/lock/intersection groups, templates, import/export) — a genuinely good idea BIMWorks lacks; it is plain document data, so it is cheap and independent of the IFC question.
6. **Per-segment and per-layer material assignment**, and column segmentation with fixed or percentage heights.
7. **Interaction-model items worth stealing** (already noted in the companion review): contextual radial palettes for element parameters, architectural snap/reference overlays, direct numeric controls during a drag, hot retype.

Each of these is implementable in BIMWorks' engine where the semantics survive as IFC, rather than being reconstructed at export. That is the same capability set, with none of §4's tax and none of §3's integrity loss.

**One finding sharpens this option and is worth acting on directly.** OpenTrace's "beyond a single host" ambition is aspiration rather than architecture — 35 of its 62 files import host packages, there is no adapter layer or ABC, and its single seam (`host.py`) abstracts only tool registration. But the *BIM/IFC semantics* are genuinely portable: `bim.py` is fully host-free, and `ifc_export.py` — the largest BIM module — touches the host only through a lazily-imported `QVector3D` inside four functions. So the honest split is: **the host-coupled part is the modelling UX (which you would be adopting anyway), and the portable part is exactly the IFC layer you already have.** That is a third reason not to move the project: the only part of OpenTrace worth transplanting is the part where BIMWorks is stronger, and the only part worth adopting (the interaction model and element capability set) is the part that has to be rewritten for your stack regardless.

**And keep the two doors open that cost nothing:** IngeTrazo/OpenTrace is a legitimate *interop target* (if `.igz`-side import/export ever looks worthwhile, OpenTrace's reader/writer is the worked reference), and OpenTrace's `AUDIT` + `FEATURES` documents are the best available statement of what the IngeTrazo ecosystem can and cannot do.

---

## 8. What this review could not settle

1. **How good OpenTrace actually is in practice.** I read code and its self-audit, but ran nothing and read no user reports. Its own header says "runtime validation is pending"; the IFC layer exists only in an unreleased release candidate; the repository contains no tests at all, while its audit summary refers to unit tests that are not present there (they may live in the author's CI or private tree — I cannot tell from the repository, and I would not treat that as evidence either way without asking).
2. **Whether its IFC output would pass a real checker.** Its quantities are nominal-by-construction and its opening representations are deliberately empty, so schema validation is not the interesting test — a quantity cross-check against geometry is. I did not run one, and the audit does not report one.
3. **Whether the 0.12.9 IFC layer has been exercised on real external models.** The audit says the Archicad/FreeCAD files that originally exposed scale/stacking bugs "are still required for a real-world regression test; the audit does not claim those external files were executed in this build environment" — so the IFC import path's real-world validation is outstanding by the authors' own account.
4. **The real cost of a Bonsai/FreeCAD workbench (option C).** I have not measured those hosts' extension models, their IFC import/export fidelity, or how much of BIMWorks' command bus and documentation pipeline would transplant. That is the option I would investigate next, and it deserves its own review rather than an estimate here.
5. **Whether OpenTrace's plugin-data schema is stable enough for option D.** Its records are plain dicts at `group.ext["arquitetura_parametrica"]` with per-kind schema versions (wall 1, slab 3, column/beam 1) and a project-level store in `document_data` — self-versioned, which is better than nothing, but I did not verify a migration discipline, and it is precisely what option D would depend on.
6. **BIMWorks' own GUI cost.** This review weighs what the piggyback buys, not what staying costs. If the honest answer is that BIMWorks' GUI will take another year to feel usable, options B and C change from "wrong shape" to "the right shape with a real, stated price".
