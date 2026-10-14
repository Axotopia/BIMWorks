# PROJECT BIMWORKS — Improved Master Specification v2
## A native-IFC architectural BIM authoring application, AI-first by design
### Master specification v2.3 — research-grounded, evidence-graded

> Status: **v2.3 — decisions signed off** (hybrid container, GPL-3.0, decimal-feet internals, IFC4 schema-of-record — see §11). Family system §3.6, AI driver architecture §5, Revit LT UI coverage audit §6.1. Every material claim carries a source and confidence grade.
> Grades: [Confirmed] = primary source fetched this session, quote matches; [Confirmed-as-printed] = record prints it, currency not established; ⚠ UNVERIFIED(reason) = not fetchable or secondary source only.

---

## 0. Executive summary — what changes from the Gemini draft

The Gemini draft is a good *feature checklist* (Ribbon, hotkeys, view range, section box, sheets) but it is **architecturally incoherent in five load-bearing places**, and if built as written it would fail at exactly the things you care about most: parametric editing, wall joins, constraints, and eventual AI control.

| # | Gemini says | Problem | v2 decision |
|---|---|---|---|
| 1 | "Native IFC4" as the *working* project format; constraints stored in a custom `Pset_BIMWorks_Constraints` | IFC has no parametric recompute semantics. Property sets are static data, not a constraint system. Locks "persisting" in a pset still need a solver that re-executes them — which IFC nowhere defines. | **Hybrid project file**: one `.bimworks` container (zip) holding a real, valid `model.ifc` **plus** a `parametric.json` overlay (constraints, join policies, sketches, family logic). IFC stays the model of record and the interchange; the overlay is what makes it *editable like Revit*. |
| 2 | Python sidecar (ifcopenshell + pythonocc) *and* "native Rust binding via openusd/cxx" — both listed | Mutually exclusive, and "openusd" (OpenUSD) has nothing to do with IFC geometry. Python round-trips per drag gesture will be too slow. | **Core engine = C++ (IfcOpenShell core + OCCT) compiled as a library inside a local engine process**, commanded over a length-prefixed JSON/msgpack IPC with batched transaction commits. Python only as scripting/AI adapter. |
| 3 | Zustand + Immer described as the "Reactive Dependency Graph" | A UI state manager is not a geometric dependency graph. Recompute must live in the core, transactionally. | Frontend state = view/selection/UI only. **Geometric dependency graph lives in the core**; frontend subscribes to delta events. |
| 4 | `IfcConvert --plan` / `--model-cut` flags produce SVG with HLR | Those flags **do not exist** [Confirmed — IfcConvert.cpp v0.8.0]. The real SVG path uses `--section-height`, `--storey-heights`, etc. | Own the slicing/HLR pipeline in-process via OCCT `HLRBRep_Algo` / `HLRBRep_PolyHLRToShape` (the same primitives IfcOpenShell's SvgSerializer uses) instead of shelling out to IfcConvert per view. |
| 5 | "<30MB binary" with an embedded Python+OCC sidecar | An OCC+ifcopenshell Python runtime is hundreds of MB. The two claims cannot both be true. | Drop the size promise. Target realistic budget: **~40MB shell + ~250–400MB engine** (or smaller later with static C++ core). |

Plus one positive change Gemini completely missed: **the AI-first contract**. Every command in v2 is exposed on a versioned JSON command bus from day 1 (the same bus the UI uses), so an LLM agent (or DSH) can drive the app through exactly the same interface as the Ribbon — no separate "AI mode" bolted on later.

---

## 1. Ground truth: how Revit actually works (the model we are cloning)

*(All quotes below were fetched this session; URLs in §12.)*

Key mechanics we must replicate, in priority order for an architectural MVP:

1. **Everything is an Element with Parameters, related to other elements.** Autodesk's own definition: *"Parametric modeling refers to the relationships among all elements in a project that enable the coordination and change management that Revit provides"* — with the canonical propagations: *"A door is a fixed dimension from an adjacent partition wall. If you move the wall, the door retains this relationship"*; *"The edge of a floor or roof is related to the exterior wall such that when the exterior wall is moved, the floor or roof remains connected"* [Confirmed]. Elements classify into Model / Sketch / View / Group / Annotation / Information groups, with Host elements (wall, roof, ceiling, floor) containing others, and Datum elements establishing project context [Confirmed]. Parameters are managed on the Element class: built-in, shared (GUID-keyed), and project parameters coexist [Confirmed]. Types vs instances: *"Changes made to instance properties affect only that instance… Changes made to type properties affect all instances of the family created from that type"* [Confirmed].
2. **A change engine, not a redraw loop.** Edits run inside transactions; the document *"Updates the elements in the Revit document to reflect all changes"*, and *"when a transaction is committed there is an automatic call to regenerate the document"* (Autodesk Revit API — `Document.Regenerate` Method, RevitAPI 26.4.0.0 [Confirmed]). Reads before regeneration return stale geometry; a regeneration failure posts a `DocumentCorruption` error and aborts the transaction [Confirmed]. Revit internally tracks element→dependent associations — the classic discovery trick is *"calling the Delete method to obtain the dependent element ids, and aborting the transaction"* [Confirmed — Building Coder mirror]. That dependency index is precisely what our recompute scheduler must be.
3. **Datum-driven architecture.** Levels and Grids are first-class datum elements [Confirmed]; *"Level Constraint … When the position of the level is changed, the positions of the elements assigned to the level are also changed. For example, walls in the model have a top and bottom constraint which can be associated with a level"* [Confirmed].
4. **Sketch-based vs host-based elements.** *"Floors are sketch based elements… The Pick Walls tool also creates a constraint between the floor edge and the wall. If a wall is moved…, the floor will also automatically move with it"* [Confirmed]; roof by footprint with slope-defining sketch lines [Confirmed]. Doors/windows are hosted family instances (*"doors and windows are hosted by a wall"* [Confirmed]); openings are real elements with a host back-reference (`Opening.Host` = *"the element cut by the Opening object"*, rect or curve boundary [Confirmed]), matching IFC's `IfcOpeningElement`/`IfcRelVoidsElement` pattern (§2).
5. **Wall joins are a first-class subsystem, not a boolean side-effect.** *"When walls intersect, Revit creates a butt join by default and cleans up the display in plan view by removing visible edges between the walls and their corresponding component layers"*; options per join are **Miter / Square-off / Butt**, including which wall butts against which; a view property (**Wall Join Display**) controls cleanup scope (all types vs same type) [Confirmed]. **Disallow Join is a per-wall-endpoint flag** — `WallUtils.IsWallJoinAllowedAtEnd(wall, end)` with end = 0 or 1 [Confirmed].
6. **View = query + representation.** *"The horizontal planes that define the view range are Top, Cut Plane, and Bottom… View depth is an additional plane beyond the primary range"*; elements show *"using the cut line weight, the projection line weight, or the <Beyond> line style"*; special cases: *"Walls shorter than 6 feet (or 2 meters) are not cut, even if they intersect the cut plane"* and floors/stairs get an adjusted range extending 4 ft below the primary range [Confirmed]. Detail Level is a view instance parameter, scale-dependent [Confirmed]. Hidden-line display with per-pair overrides [Confirmed].
7. **Constraints are persistent first-class model data.** *"After you establish constraints, they will remain unchanged when the model is modified"*; locking a dimension: *"Click the lock icon to create a constraint. Now when you drag the wall, the size… does not change"*; EQ: *"click the Equality icon… the equality constraint is maintained"* when resized; Align: *"includes the ability to lock the alignment between the two objects"*; deleting the dimension offers to keep or delete the constraint [Confirmed].

---

## 2. Ground truth: what IFC4 can and cannot do for us

*(Integrates the IFC research report; core facts verified directly this session.)*

**CAN (verified in the IFC4 ADD2 schema / buildingSMART HTML spec, fetched via browser; steptools mirror cross-check):**
- Spatial hierarchy `IfcProject > IfcSite > IfcBuilding > IfcBuildingStorey` via `IfcRelAggregates` (*"required to be hierarchical"*); element containment via `IfcRelContainedInSpatialStructure`.
- Walls: `IfcWall` (changing thickness/non-rectangular sections), `IfcWallStandardCase` (*"non-changing thickness along the wall path… fully described by a material layer set… have to have a corresponding IfcMaterialProfileSetUsage assigned"*), `IfcWallElementedCase` [Confirmed]. ⚠ Note for implementers: **IFC4 moved wall standard-case materials to `IfcMaterialProfileSetUsage`** (IFC2x3 used `IfcMaterialLayerSetUsage`) — Gemini's spec and many older tutorials get this wrong.
- Openings and fills: `IfcRelVoidsElement` — *"This relationship implies a Boolean operation of subtraction between the geometric bodies of the element and the opening"*, one-to-one [Confirmed]; door/window-in-opening pattern per IFC4 Annex E ("wall with opening and window") with opening-relative placement for the fill [Confirmed].
- Wall-to-wall connections: `IfcRelConnectsPathElements` [Confirmed — steptools mirror].
- Compound wall materials: `IfcMaterialLayerSet` (inside the profile set usage for standard-case walls) [Confirmed].
- Types: `IfcWallType`, `IfcDoorType`, … related to instances via `IfcRelDefinesByType` [Confirmed].
- Constraints as *data*: `IfcConstraint` (abstract; `IfcMetric`, `IfcObjective`), graded hard/soft/advisory [Confirmed — steptools mirror + buildingSMART].
- Grids & annotation: `IfcGrid` (*"planar design grid… grid axes, which are 2D curves"*), `IfcAnnotation` (*"additional points, curves, text, dimensioning, hatching"*) [Confirmed].
- Georeferencing: `IfcProjectedCRS` + `IfcMapConversion` (IFC4).

**CANNOT (the reason the Gemini plan breaks):**
- IFC defines **no recompute semantics** — and says so explicitly: *"The behaviour that is implied from the dependency relationship has to be established inside the applications."* (IfcRelAggregates definition, IFC4 HTML spec [Confirmed]). A consumer reading `Pset_BIMWorks_Constraints` has no rule telling it to re-solve, in what order, or what is dirty. Constraints stored this way are documentation, not behavior.
- `IfcConstraint`/`IfcMetric`/`IfcObjective` are graded compliance assertions (hard/soft/advisory) attached to properties via `IfcPropertyConstraintRelationship` — nothing in the schema recomputes geometry from them [Confirmed].
- `IfcWallType` gives type→occurrence sharing of properties/materials/shape maps — but no formulas between type parameters and instance geometry; and it is *"illegal to share shape representations as representation maps for occurrences of IfcWallStandardCase"* [Confirmed].
- No Revit-style family editor semantics (constraint sketches driving sweeps/extrusions).
- Join geometry (miter at corners) is conventionally *baked* into the wall body geometry; IFC records connectivity (`IfcRelConnectsPathElements`) but not the join *policy* ("miter vs butt", "disallow join") in a way downstream tools re-execute.
- 2D drafting (view range, poché, lineweights, dimension re-association) is essentially out of scope for the IFC geometry model; IFC drawings are snapshots.

**Conclusion (the central architectural claim of v2):**
> *Be "IFC-native" the way Bonsai is IFC-native — IFC is the storage model — but accept that the *editing semantics* (constraints, joins, sketches, parameters) must live in an application layer that IFC does not and cannot standardize.* Two proven precedents: Bonsai (native IFC, weak parametrics) and FreeCAD (strong parametrics, own file format, IFC export). v2 takes the hybrid: **IFC inside, parametric overlay alongside, both in one container file.**

---

## 3. System architecture v2

```
┌────────────────────────────────────────────────────────────────────┐
│  DESKTOP SHELL — Tauri v2 (Rust)                                    │
│  window/menu/file-dialog/webview lifecycle; sidecar supervision     │
└──────────────┬─────────────────────────────────────────────────────┘
               │ webview (React 19 + TS + Tailwind + dockview + Three.js)
┌──────────────▼─────────────────────────────────────────────────────┐
│  FRONTEND                                                           │
│  • UI layer: Ribbon, Project Browser, Properties, Status Bar        │
│  • Viewports: Three.js WebGL2 (3D + GPU section box), Canvas2D/SVG  │
│    (plan/section/raster-free 2D views), dockview MDI tabs           │
│  • Local view-state store (Zustand): selection, active tool, view   │
│    settings — NOT the model                                         │
│  • CommandBus client → typed JSON commands over IPC                 │
└──────────────┬─────────────────────────────────────────────────────┘
               │ JSON-RPC over WebSocket (localhost), length-            │
               │ prefixed binary frames for mesh/linework payloads       │
┌──────────────▼─────────────────────────────────────────────────────┐
│  CORE BIM ENGINE (separate process)                                 │
│  C++: IfcOpenShell core (IFC parse/author) + OpenCASCADE (BRep,     │
│  booleans, HLR)                                                     │
│  1. Model store: IFC file (in-memory) + Parametric overlay (in-mem) │
│  2. Dependency graph + recompute scheduler (dirty propagation)      │
│  3. Geometry builders: wall join manager, opening cutter, sketch    │
│     extruder, roof builder → OCCT solids → cached meshes            │
│  4. View generator: view-range slicing → HLRBRep → cut/projection/  │
│     hidden edge sets with category tags                             │
│  5. Transaction manager (command pattern, undo/redo, journal)       │
│  6. CommandBus server: the ONLY way to touch the model              │
└──────────────┬─────────────────────────────────────────────────────┘
               │ same CommandBus, same protocol
┌──────────────▼─────────────────────────────────────────────────────┐
│  AI / AUTOMATION LAYER (phase 2, free by design)                    │
│  • CLI (`bimworks run commands.json`), scripting host (Python),         │
│  • MCP server exposing CommandBus tools (drive-the-UI agent)        │
└────────────────────────────────────────────────────────────────────┘
```

Why an engine *process* and not an in-process library: crash isolation (OCCT segfaults on bad booleans must not kill the UI), long recompute without blocking the viewport, and — critically — the process boundary **is** the AI contract: any agent can connect to `ws://127.0.0.1:<port>/bus` with the same protocol the UI uses.

### 3.1 The project file (v2's most important decision)

```
myproject.bimworks  (zip container)
├── model.ifc          # IFC4 ADD2 STEP file — the model of record
├── parametric.json    # overlay: parameters, constraints, join policies,
│                      #   sketches, type logic — ALL lengths in decimal feet
├── views/*.json       # view range, detail level, filters, templates
├── cache/meshes.bin   # optional tessellation cache for fast open
└── meta.json          # schema version, app version, journal tail
```

- **Open in Revit/Bonsai/Solibri:** hand them `model.ifc` — fully valid, no custom pset hacks required.
- **Reopen in BIMWorks:** overlay re-attaches to IFC entities by GUID. Missing GUIDs (file edited elsewhere) → overlay entries flagged stale, never silently applied.
- **Undo journal** appended per transaction (crash recovery = replay).

This preserves your "native IFC" goal *and* makes Revit-grade parametrics possible. The trade is empirically validated by the two existing attempts:
- **Bonsai (native-IFC all the way):** proves IFC-native authoring is viable, but has **no dependency graph** — geometry and join/void results regenerate only via explicit tool actions; users report *"I have to press the Update Button to see the final result… would it be possible that Bonsai presses the corresponding Update Button for me instead, each time when I moved things?"* (OSArch forum, [Confirmed]). The missing piece vs Revit is exactly the live constraint/dependency graph.
- **FreeCAD (parametrics first, IFC export):** *"FCStd is a standard zip file containing one or more files… The Document.xml and GuiDocument.xml are at the root of the archive, together with any number of .brp (BREP) files"* [Confirmed — FreeCAD wiki]. Same zip-container pattern v2 adopts.
- IFC itself disclaims the behavior we need: *"The behaviour that is implied from the dependency relationship has to be established inside the applications."*

### 3.2 The dependency graph & recompute (replacing "Zustand is the graph")

- Node = parameter or geometry-output of an element; edge = dependency (hosting, constraint, level, sketch membership, join).
- **Recompute scheduler:** topological, incremental, dirty-flag driven. A drag emits `MoveElement(guid, delta)` → core marks dependents dirty → batches recompute → emits `ElementsChanged` deltas (not full reload) → GPU mesh swap for changed elements only.
- Target budgets (measured, not aspirational): wall move with 20 dependents < 16ms single-frame; full-model recompute of a 2,000-element model < 250ms.
- Transactions mirror Revit: `BeginTransaction` / commit → one undo step, one journal entry, one delta event.

### 3.3 Wall join manager (your "walls meeting at corners" requirement)

This is the hardest 80/20 in the whole project. v2 scoping (semantics matched to confirmed Revit behavior, §1.5):

1. **Phase A (MVP):** 2D polygon joins at the plan level. **Butt join is the default** (with plan-view edge cleanup between joined walls), with **Miter** and **Square-off** as selectable per-join options, including which wall butts against which [Confirmed]. Per-wall-endpoint `allowJoin` flag (Revit: `IsWallJoinAllowedAtEnd(wall, end 0|1)` [Confirmed]). Join state: the *overlay* stores `JoinPolicy{end1, end2}` per wall; geometry is regenerated, never edited. A **Wall Join Display** view property controls whether plan cleanup applies across wall types or same-type-only [Confirmed].
2. **Layer-aware joins (post-MVP):** `IfcMaterialLayerSet` walls wrap outer layers at openings (Revit's "wrapping at inserts" — a notoriously missed feature; commit to it explicitly).
3. **IFC export:** bake joined solids + write `IfcRelConnectsPathElements` so other tools understand the relationship.

### 3.4 Constraint engine (Align/Lock, locked dimensions, EQ)

- Embed a **planar geometric constraint solver** rather than inventing one: proven open options are FreeCAD's `planegcs` (the solver inside FreeCAD's Sketcher; Python/C++, LGPL) or SolveSpace (GPL, constraint solver used in a real parametric CAD). Both verified [Confirmed — GitHub READMEs].
- Constraints = solver variables bound to element parameters (wall endpoint, offset, level height). Locking a dimension creates an equality constraint; `EQ` creates `Distance(a,b) == Distance(b,c)`.
- Constraints live in `parametric.json` (decimal feet); **solved results** (e.g., "wall face at 12.5 ft from grid A") are written into the IFC parameters, so the IFC file always reflects the last solved state.
- Failure mode contract: over-constraint → solver reports the conflicting set → UI highlights conflicting witnesses (do what Revit actually does: warn, don't crash).

### 3.5 Types & "families" (the part Gemini's spec omits entirely)

Revit's power comes from type→instance geometry. v2 maps this to IFC honestly:
- **MVP:** types are IFC entities — `IfcWallType`, `IfcSlabType`, `IfcDoorType`, … with parameter sets; instances relate via `IfcRelDefinesByType` [Confirmed §2]. The *parameter schema* (which parameters a type exposes, defaults, units, and simple formulas like `UnconnectedHeight = LevelTop − LevelBase − BaseOffset`) lives in the overlay, keyed to the type GUID. Editing a type parameter re-drives all instances through the recompute graph — this is the 80% of "families" that architectural production actually uses.
- **Phase 2+:** a family editor (constraint sketch + labeled dimensions driving one profile/sweep — the Revit Family Editor pattern) compiled by the overlay into per-instance OCC builders. Do not attempt in MVP; IFC cannot store it natively and it is the single largest hidden cost in any Revit clone.
- **Honest limitation:** loadable-family behaviors beyond parameter formulas (nested families, yes/no driven geometry variants) are out of scope indefinitely unless the overlay grows a small expression language — plan for that language from day 1 in the overlay schema so it's a clean extension, not a rewrite.

### 3.6 Family system — full architecture (v2.2)

**What a Revit family actually is, decomposed** (all behaviors below confirmed from Autodesk family docs, §12):

| Part | Revit mechanism | BIMWorks representation |
|---|---|---|
| 1. Behavior contract | Family template: host-based (**wall/ceiling/floor/roof-based — may cut openings**), face-based, line-based, standalone, annotation; plus flags (`Cut with Voids When Loaded`, `Always Vertical`, `Shared`) | `FamilyDefinition.behavior` block: `{host: wall|ceiling|floor|roof|face|none, cutsHost: bool, placement: …}` |
| 2. Parameter schema | Named typed parameters, grouped, each **type-scoped or instance-scoped** | `parameters[]`: name, dataType (Length/Angle/Text/YesNo/Material/Number), scope (type\|instance), group, default |
| 3. Geometry recipe | Sketches on reference planes, constrained; labeled dimensions bind sketch dimensions to parameters; solids/voids via extrude/blend/revolve/sweep/swept blend | `geometry` DAG: nodes = sketch(plane + constraint set) + op(extrude/sweep/revolve) + boolean(union/cut); **constraint sets solved with embedded planegcs**; labeled dimension = edge from sketch dimension node → parameter |
| 4. Type table | Named types = rows of parameter values | `types[]`: `{name, values{param: expr}}` (exactly the IfcTypeObject row) |
| 5. Instance overrides | Instance parameters per placed occurrence | instance record stores overrides only; geometry always regenerated |
| 6. Material & visibility bindings | Material parameters; YesNo parameters gate geometry visibility | `bindings[]`: parameter → material slot; geometry nodes carry `visibleIf: expr` |
| 7. Nesting | Families inside families with parameter mapping ("nested/shared") | `nested[]`: `{familyGuid, paramMap{local→parent expr}}` — instantiated recursively by the compiler (phase 2) |

**Key decisions:**
1. **Family definitions are text: `.bwfam` JSON** — standalone library files or embedded in the overlay. We define this open format (GPL project; nothing to borrow byte-wise since `.rfa` is closed and unparsable). Recipes are diffable, version-controllable, and community-shareable.
2. **Deterministic compiler, no arbitrary code.** The only "programmability" is a small, versioned, safe **expression language** (arithmetic, comparison, conditional, lookup tables) evaluated by the engine — never scripting injected into the model. Same language drives type formulas, visibility gates, and nested parameter maps. This is the single extension point; everything else stays a typed DAG.
3. **Compilation & caching.** `compile(familyGuid, typeGuid, paramHash) → OCC builder plan`; instances evaluate the plan with merged (type + instance) values. Cache key = hash of (family JSON, type row, instance overrides) — editing a type invalidates all instances of that type through the recompute graph.
4. **Hosting semantics match the template system:** host-based families with `cutsHost` create `IfcOpeningElement` + void + fill on export (Annex E pattern); host-based without cut (sconce, sky light *on* roof plane) export as positioned proxies/accessories relative to the host; annotation families export as `IfcAnnotation` geometry.
5. **Do not conflate with system families.** Walls/floors/roofs keep their §3.5 treatment (type = parameter schema + layer/profile structure). The §3.6 machinery above is only for component families (doors, windows, furniture, tags).
6. **Phasing:** M2 ships with a **starter JSON library** (~50 families covering standard doors/windows/CMU & stud wall types/furniture basics) and type editing through the Properties palette — no family editor UI yet. Family Editor (sketch canvas + labeled dimensions + type table) is Phase 2/M6. AI authoring of `.bwfam` (an LLM writes/edits family JSON, the compiler validates and reports errors precisely) is a Phase-2 differentiator — families are the hardest thing to author in Revit and the easiest to author in BIMWorks's representation.

---

## 4. View, drafting & sheets engine (corrected pipeline)

### 4.1 In-process cut + HLR (replacing the IfcConvert CLI detour)

Per 2D view, the engine:
1. Selects elements in the view's spatial/level range and applies **view range** (Top / Cut plane / Bottom / View Depth, per level, defaults 4′-0″ cut).
2. Partitions elements into **cut** (intersected by the cut plane → poché fill + heavy outline) vs **projected** (visible beyond cut) vs **below** (beyond view depth, dashed/gray).
3. For sections/elevations: assembles OCCT compound → `HLRBRep_Algo`/`HLRBRep_PolyHLRToShape` → visible edges + hidden edges with occlusion classification [Confirmed — OCCT refman: "Hidden Lines Removal algorithms on the BRep DataStructure"; and IfcOpenShell SvgSerializer.cpp uses `HLRBRep_PolyHLRToShape` with cut planes, `BRepAlgoAPI_Cut` halfspace subtraction before HLR].
4. Emits a **structured 2D scene** (not raw SVG strings): edges carry `{elementGuid, category, styleClass: cut|projection|hidden|beyond, stroke: mm}`. The frontend renders to Canvas2D/SVG with CSS classes; PDF export renders the same scene to vector PDF. One geometry, three surfaces (screen/SVG/PDF) — no rasterization anywhere.
5. **Port Revit's confirmed cut rules, including the special cases** that generic slicers get wrong [Confirmed]: walls shorter than 6 ft (2 m) are *not* cut even when intersecting the cut plane; floors/stairs/ramps use an adjusted range extending 4 ft below the primary range; `<Beyond>` style applies within view depth. Hidden lines are re-exposable per element pair (Revit's Show Hidden Lines override) — keep occlusion classification per edge-pair in the scene so this stays possible.

### 4.2 Lineweights & materials-as-poché
- CSS-class lineweight system as Gemini proposed is kept — it's good — but weights resolve through a **View Template** (object-style table: category × cut/projection × detail level), matching Revit's actual mechanism, not global CSS.
- Cut fills: hatches as SVG `<pattern>` vector fills (concrete/CMU/insulation), never raster.

### 4.3 Annotation & sheets (kept from Gemini, hardened)
- Dimensions/tags = elements referencing target GUIDs + face keys; re-evaluated on regeneration events only.
- Sheets: title block = parameterized SVG with `{{token}}` interpolation from project properties; viewport = live reference to a 2D view at a scale; PDF export via the same vector scene (CairoSVG acceptable; or direct `reportlab`/`podofo` from scene primitives to skip an XML hop).

---

## 5. AI-first architecture v2.3 (core differentiator, not a bolt-on)

### 5.0 The verdict: a typesafe AI driver, not a GUI-driving agent

Research conclusion (evidence in §12): **the LLM should never click the UI — it should synthesize typed command programs against the CommandBus.** This is now empirically settled, not opinion:

- GUI-driving agents on industrial CAD: *"GUI-based agents suffer from fragile visual grounding and long-horizon error accumulation"*; frontier models achieve *"near-zero success under GUI-based interaction, whereas [programmatic API] execution yields substantial immediate gains"* — ComAct/ComCADBench [Confirmed — arXiv 2606.13239].
- Unconstrained JSON tool-calling fails predictably: agents *"hallucinate keys, omit mandatory state-dependent fields, or conflate argument schemas across disparate operations"* [Confirmed — AAIF, JSON Schema 2020-12 tool-call reliability].
- The fix pattern is validated: Microsoft TypeChat — *"translates user intent into strongly typed actions"*, *"strong typing may help make software that uses language models more deterministic and reliable"* [Confirmed — TypeChat.NET README].
- LLM-CAD research converges on the same shape: models author **parametric sequences/code** (Text2CAD NeurIPS 2024, CAD-Recode ICCV 2025, CAD-GPT), not GUI trajectories.

So: **typed commands (JSON Schema 2020-12) + schema-constrained generation + validation-with-precise-errors retry + query-based verification.** "Typesafe AI" is the driver; the prompt box and DSH are just two front-ends to the same loop.

### 5.1 The three-tier driver stack

```
Tier 0  COMMAND BUS (already v2 §3) — the ground truth
        typed commands, JSON Schema 2020-12, generated from the command
        registry (single source of truth: the same registry compiles the
        Ribbon, the CLI, the schema export, and the AI tools)
Tier 1  IN-APP PROMPT BAR (the "Ask/Do" bar, above the status bar)
        prompt → typed Plan {commands[], intent summary} → preview in
        viewport → confirm → ONE transaction (undo group tagged origin:"ai")
Tier 2  EXTERNAL AGENT (DSH / MCP server / CI)
        same bus, headless; tools = commands + queries + verification;
        agent sessions are replayable journals
```

### 5.2 Tier 1 — the prompt bar UX (how it differs from Revit)

- Always-available input above the status bar; hotkeys `Ctrl+Enter` (or `/`) focus it; mouse/keyboard workflows untouched — AI is a *parallel* driver, not a replacement.
- **Context auto-grounding:** active view, current selection, last command, visible levels are injected as typed context — the model states intent in element-relative terms ("the north wall on Level 2"), and the resolver maps references → GUIDs via structured queries, never via pixels.
- **Preview-before-commit:** the returned Plan renders as *viewport highlights* (affected elements glow) plus a natural-language summary chip ("Moves 2 walls, adds 3 windows — one undo step"). Enter commits; Esc discards. Destructive ops always preview.
- **Validation-retry loop, in-app:** malformed plan → schema validator returns typed errors → one silent repair round-trip → if still invalid, the error chain is shown to the user (nothing half-executes).
- Constraints are the safety net: plans execute through the same solver/guarded transactions as manual edits — the AI cannot create geometry the engine would reject from the Ribbon.
- Dockable **AI transcript panel**: every prompt/plan/result with command ids — a user-visible, replayable history.

### 5.3 Giving the agent eyes: semantic-first verification

1. **Queries are the primary sense:** `get(guid)`, `query({category,type,pset,level,view,bbox})`, `listViews`, `describe(view)` — all structured, all cheap.
2. **2D scene snapshots as the visual sense:** the §4.1 vector scene exports as tiny SVG for VLM checks ("does the plan look right?") — semantic-first, pixels-fallback, never the primary channel.
3. **Post-condition assertions:** plans may embed assertions (`assert: wall W1 length == 12.5ft`) checked by the engine after execution; failure auto-offers rollback of the whole AI transaction. ("One-key undo AI changes" remains available.)

### 5.4 Skills: making the AI teachable

`.bwskill` = named, parameterized command sequences (a recorded macro). Users record; the AI can propose skills from successful sessions and reuse them verbatim. Over time the skill library becomes the cheap, deterministic path — the LLM plans, skills execute.

### 5.5 Evaluation harness (agent regression, from day 1 of M5)

Golden-prompt suite with **query-based geometric assertions** (not screenshots): "draw an 8-wall rectangle 40'×30' with a 3'-0" door in the south wall" → assert counts, lengths, openings. Any prompt-engineering, model, or schema change re-runs the suite. This is the CadBench discipline ComAct proved necessary, applied continuously.

### 5.6 Model-agnostic plumbing

OpenAI/Anthropic/local-vLLM behind one adapter interface; schema-constrained decoding used when available; plan format is provider-neutral JSON. DSH integration via MCP server (tools = Tier-0 catalog) — no special "AI mode" in the app.

---

## 6. UI/UX parity checklist (kept from Gemini, corrected)

- Ribbon tabs Architecture/Annotate/View/Manage; two-letter hotkey buffer (`WA`, `DR`, `WN`, `SB`, `RF`, `GR`, `LL`, `DI`, `TG`, `TX`, `BX`, `HH/HR/HI`), `Esc` cancel, `Space` flip orientation/swing — kept as specced.
- dockview MDI + Project Browser + Properties + Type Selector — kept; dockview/zustand/three versions verified current [Confirmed — npm registry].
- **Correction to hotkey spec:** Revit's two-letter shortcuts are not debounced — the buffer resolves the instant a matching sequence completes and resets on timeout (~1s) or on a non-matching key. Implement exactly that.
- Navigation: MMB pan, Shift+MMB orbit, wheel zoom, `ZE`/double-MMB zoom extents — kept.
- Temporary dimensions: editable pills; on Enter → `CommandBus.execute("SetDimension", …)` → constraint-aware move (uses the solver, not blind translation, so locked neighbors respond).
- Status bar: scale, detail level, visual style, crop toggles — kept.

### 6.1 Revit LT UI coverage audit (against the 16-region LT UI anatomy, Autodesk Revit LT help [Confirmed — §12])

| Revit LT UI region | Spec status | Disposition |
|---|---|---|
| Ribbon (tabs/panels/tools) | ✅ Partial | Architecture/Annotate/View/Manage match LT's architectural tab set (LT itself omits Structure/Systems); **Massing & Site deferred** (massing out of MVP; site via floors/toposurface-lite in M2 backlog) |
| **Contextual ribbon tabs** (`Modify \| Walls` etc.) | ❌ Missing | **Add to M1:** context-sensitive ribbon state driven by selection/active tool from the command registry |
| **Options Bar** (tool options: location line, chain, offset, height during placement) | ❌ Missing | **Add to M1** — this is core placement UX; bind to command args (the same args the CommandBus/AI plans set) |
| **Quick Access Toolbar** (customizable) | ❌ Missing | Add to M1 as a customizable pinned-command strip |
| Type Selector | ✅ Covered | Properties palette top |
| Properties palette | ✅ Covered | Instance/type split, Edit Type modal |
| Project Browser | ✅ Covered | §3 tree incl. Views/Legends/Schedules/Sheets/Families |
| Status bar + View Control Bar | ✅ Covered | scale/detail/visual style/crop + temp hide/isolate |
| Drawing area (tabbed MDI) | ✅ Covered | dockview |
| Revit Home / File menu | ❌ Missing | Add to M1 (standard app menu; no cloud "Home" — local recent-files list) |
| InfoCenter | ⛔ Intentional skip | Replaced by the §5 prompt bar (AI-first search/ask) |
| **ViewCube + Navigation Bar** | ❌ Missing | Add to M1: ViewCube-equivalent orientation gizmo, ortho/persp toggle, steering-wheel-lite (zoom/pan/orbit cluster) |
| **Modify tool set** (Move/Copy/Rotate/Offset/Mirror/Trim-Extend/Split/Pin/Lock, multi-select Filter) | ⚠ Partial (Align only) | **Add to M2** — full modify set over the CommandBus; Filter dialog for multi-category selections |
| **Right-click context menus** | ❌ Missing | Add to M2; menu items = filtered command registry entries per selection type |
| Options dialog (graphics, snaps, **shortcut customization**) | ❌ Missing | Add to M2 — includes Revit's KS-style shortcut editor writing to the same registry the hotkey engine reads |
| Family Editor UI | ⛔ Deliberately deferred | §3.6: M6 |

**Net assessment:** the spec covers the *static furniture* (palettes, browser, view controls, hotkeys) but originally missed most of Revit's *flow furniture* — Options Bar, contextual tabs, QAT, modify tools, context menus — which is what makes Revit feel like Revit mid-action. This audit closes that gap: **all ❌/⚠ rows are now scheduled (M1/M2)**. Two regions are deliberate deviations, both AI-motivated: InfoCenter → prompt bar; and where Revit LT has *no API at all*, BIMWorks exposes every one of these UI regions over the CommandBus (the UI is a skin on the bus — the AI can do anything the Options Bar can, which Revit LT fundamentally cannot offer).

## 7. Georeferencing (kept nearly as-is from Gemini — it was the draft's strongest section)
- `IfcProjectedCRS` + `IfcMapConversion` (eastings/northings/orthogonal height/x-axis abscissa & ordinate/scale), local engineering coordinates for all modeling; IFC4 native. One addition: a **shared-coordinates report** (project north vs true north angle, EPSG) printed into every sheet's title block optionally.

---

## 8. Roadmap v2 (risk-first)

| Milestone | Content | Exit criteria (measurable) |
|---|---|---|
| **M0 — Risk spikes (4–6 wks)** | (a) engine-process skeleton with CommandBus + delta events; (b) wall join prototype: 3 walls meeting, miter+butt, live drag; (c) HLR spike: slice a 2-storey model, render cut vs projection in Canvas2D; (d) overlay round-trip: model.ifc + parametric.json reopen | 60fps drag with joins recomputing; HLR edges render correctly; save/reopen preserves parameters; IPC latency budget met (p95 < 8ms per delta) |
| **M1 — Shell & 3D** | Tauri+dockview+Ribbon+hotkeys+Properties/Browser; Three.js viewport, nav, GPU section box with stencil capping | Revit user navigates & sections without docs; 2M-triangle model ≥ 60fps orbit (raised from Gemini's 50k-polygon target, which is a toy number) |
| **M2 — Modeling core** | Levels/Grids datums; Wall tool with join manager; Door/Window via IfcOpeningElement + voids/heal; floor slabs via sketch; transactional undo/redo; temp dimensions | Corner chain of 8 walls edits live; deleting a door heals the wall; move Level 2 → constrained walls follow |
| **M3 — 2D views** | View range engine, cut/projection/hidden partitioning, view templates & lineweight tables, plans+sections+elevations, temp hide/isolate | A plan view visually matches a Revit plan of the same model to a reviewer's satisfaction; section HLR correct on multi-level model |
| **M4 — Sheets & PDF** | Sheet canvas, viewports, title blocks, vector PDF batch export, georeferencing dialog | 1200% PDF zoom pure vector; IFC4 file passes official schema validation; round-trip through Bonsai/Solibri opens |
| **M5 — AI driver layer** | Schema catalog export (JSON Schema 2020-12 from command registry); prompt bar with plan/preview/commit loop; query+verify tools; `.bwskill` macros; MCP server; golden-prompt eval harness | An LLM with no UI builds the M2 test model from prompts only — through typed plans, with ≥95% plan-validity first-pass and 100% transactional integrity; eval suite green |

## 9. Acceptance criteria (v2 replaces Gemini's)
1. **Schema compliance:** every save validates against official IFC4 validation (bimTester/IfcTester or buildingSMART validator).
2. **Interoperability:** `model.ifc` opens in ≥2 independent IFC viewers (Bonsai + Solibri/other) with correct walls, openings, storeys.
3. **Revit muscle memory:** as Gemini specified, retained verbatim.
4. **Performance (measured):** orbit 60fps at 2M triangles; wall-drag delta round trip p95 < 16ms; app cold start < 3s (relaxed from Gemini's impossible 2s-with-400MB-engine claim).
5. **Vector purity:** PDF text searchable, edges scalable, no raster at any zoom.
6. **AI parity:** any UI action is achievable via CommandBus alone (audit test: complete M2 test model through the bus with UI disabled); prompt-bar plans are schema-valid or repairable with typed errors — no silent partial execution, ever.

## 10. Licensing & borrowing map (verified — BIMWorks itself is **GPL-3.0**, per §11)
- **IfcOpenShell** (IFC parse/author + OCCT geometry): repo carries GPL-3 `COPYING` and LGPL-3 `COPYING.LESSER` (library portion LGPL) [Confirmed — repo root v0.8.0]. Under BIMWorks's GPL-3, both the library link and (for GPL-covered components) direct code reuse are available.
- **OpenCASCADE (OCCT):** LGPL-2.1-with-exception — usable directly; the industry-standard for exactly this (HLR, booleans, BRep).
- **planegcs** (FreeCAD Sketcher solver): GPL; under BIMWorks's GPL-3 it can be ported/embedded wholesale rather than just pattern-copied.
- **SolveSpace:** GPL constraint solver, reference implementation — same.
- **Bonsai:** GPL — architecture study *and* reusable code (drawing generation, IFC api patterns) with attribution.
- **Revit itself:** closed, no file-format borrowing possible — clone *behavior*, not bytes.

## 11. Resolved decisions (signed off 2026-10-13)
1. **Project format: HYBRID CONTAINER — LOCKED.** `.bimworks` zip = `model.ifc` (model of record) + `parametric.json` overlay + views/journal/cache. All downstream design (recompute, joins, constraints, stale-overlay detection) proceeds on this basis.
2. **License: GPL-3.0 — LOCKED.** BIMWorks is GPL-3.0. Consequences: we may take code directly from Bonsai, SolveSpace, and the GPL portions of IfcOpenShell; the LGPL IfcOpenShell library may be linked and, if helpful, upgraded to GPL linking for simplicity. Every borrowed file keeps its origin header. OCCT's LGPL-with-exception remains compatible.
3. **Internal units: DECIMAL FEET — LOCKED.** Matches Revit's internal representation exactly (muscle memory + clean imperial math: `12' 6"` = 12.5 ft, no fractional rounding). Consequences:
   - The overlay, journals, and IPC carry feet (doubles); the UI formats per project units (feet-inches fractional, mm, etc.).
   - **IFC export:** write the project's declared length unit. Default export unit is **millimeters** (maximum interop with Bonsai/Solibri/Revit import, which expect SI) with a per-project override to `IfcConversionBasedUnit` (foot) for fully-imperial deliverables. Conversion is a single boundary function at the STEP serializer — nothing else in the engine knows mm exists.
4. **Schema version: IFC4 (ADD2 TC1) as schema-of-record for MVP; IFC4.3-ready by design — LOCKED.** Rationale (evidence §12):
   - Our engine substrate states it directly: *"Extensive geometric support is implemented for the IFC releases IFC2x3 TC1 and IFC4 Add2 TC1. Support for parsing is provided for IFC4x1, IFC4x2, and the IFC4x3 release candidates"* [Confirmed — IfcOpenShell official docs]. Full authoring + geometry exists for IFC4; IFC4x3 is parse-only (RCs).
   - Nothing in BIMWorks' strictly-architectural scope needs IFC4.3's additions (infrastructure: alignments, roads, rail, ports, waterways).
   - The ecosystem is converging on 4.3 from the consumption side: Autodesk's Revit IFC exporter actively ships IFC4x3 support in 2026 (v27.3.0.12 fixes "exporting to IFC4x3"; v25.4.40 "Added IFC4.3 Reference View exchange requirements") [Confirmed — revit-ifc releases]. So *reading* 4.3 files matters sooner than *writing* them.
   - **Implementation commitments:** (a) the STEP serializer already owns units at a single boundary — add a **schema-version boundary** beside it from day 1 (the internal model is schema-neutral; nothing above the serializer knows the schema version); (b) MVD discipline: IFC4 **Reference View** semantics for coordination exports, **Design Transfer View** semantics for full-fidelity saves; (c) *reading* IFC4x3 into BIMWorks is acceptable from M2 (parse via IfcOpenShell; the architectural entity set is essentially common to both schemas); (d) revisit IFC4x3 *export* when IfcOpenShell promotes 4x3 from RC-parsing to full authoring/geometry — by design that's a serializer flag flip, not a rework.
   - Context note: .rvt's lack of backward compatibility is exactly why the open `.bimworks` + standard-IFC container matters — BIMWorks files must never strand a user on a version treadmill.

## 12. Sources (accessed 2026-10-13)

**Autodesk / Revit behavior:**
- `Document.Regenerate` Method — *"Updates the elements in the Revit document to reflect all changes… when a transaction is committed there is an automatic call to regenerate the document"*; `DocumentCorruption` on failure [Confirmed]: https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/22468e2c-9772-8478-0816-c9759aa43428.htm
- About the View Range — Top/Cut Plane/Bottom + View Depth; cut vs projection vs `<Beyond>`; walls < 6 ft not cut; floors' adjusted range [Confirmed]: https://help.autodesk.com/cloudhelp/2023/ENU/Revit-DocumentPresent/files/GUID-58711292-AB78-4C8F-BAA1-0855DDB518BF.htm
- About the View Range (Detail Level as view instance parameter, scale-dependent) [Confirmed]: https://help.autodesk.com/cloudhelp/2020/ENU/Revit-DocumentPresent/files/GUID-3FEAFCD6-1DBD-44B3-91A7-B3CC0E396689.htm
- Parametric relationships definition + wall-move propagation examples [Confirmed]: https://help.autodesk.com/cloudhelp/2022/ENU/Revit-GetStarted/files/GUID-71F2C8EE-2A90-4076-A6C7-702082566DDF.htm
- Element Classification (six groups; host/datum elements) [Confirmed]: https://help.autodesk.com/cloudhelp/2025/ENU/Revit-API/files/Revit_API_Developers_Guide/Introduction/Elements_Essentials/Revit_API_Revit_API_Developers_Guide_Introduction_Elements_Essentials_Element_Classification_html.html
- Element Parameters (built-in/shared/project) [Confirmed]: https://help.autodesk.com/cloudhelp/2024/ENU/Revit-API/files/Revit_API_Developers_Guide/Basic_Interaction_with_Revit_Elements/Revit_API_Revit_API_Developers_Guide_Basic_Interaction_with_Revit_Elements_Parameters_html.html
- About Wall Joins — butt default + plan cleanup; Miter/Square-off options; Wall Join Display view property [Confirmed]: https://help.autodesk.com/cloudhelp/2026/ENU/Revit-ArchDesign/files/GUID-6B18982C-1FBA-4E5C-AE30-6FAE4022CE35.htm
- `WallUtils.IsWallJoinAllowedAtEnd` — per-endpoint join control [Confirmed]: https://www.revitapidocs.com/2022/d5028e5c-92d2-0b84-b258-26d1b758b378.htm
- Opening.Host — *"the element cut by the Opening object"*; rect/curve boundary [Confirmed]: https://help.autodesk.com/cloudhelp/2015/ENU/Revit-API/files/GUID-CA1FB5D9-49BE-40D6-B9AA-BFDE21B10C8D.htm
- Families taxonomy + type vs instance parameter scoping [Confirmed]: https://help.autodesk.com/cloudhelp/2024/ENU/RevitLT-GetStarted/files/GUID-4CF8FCA2-6D08-4527-AFB0-71F2B8BECAD7.htm
- Host/Cut-with-Voids family behavior [Confirmed]: https://help.autodesk.com/cloudhelp/2023/ENU/Revit-Customize/files/GUID-68EFCA67-4913-4E00-AB9E-F2E6A7BEF8C6.htm
- Floors sketch-based; Pick Walls constraint [Confirmed]: https://help.autodesk.com/cloudhelp/2023/ENU/Revit-GetStarted/files/GUID-C7E5CEA9-D741-4829-B39E-73BE40FC4B7E.htm
- Roof by footprint, slope-defining lines [Confirmed]: https://help.autodesk.com/cloudhelp/2023/ENU/RevitLT-ArchDes/files/GUID-4EE804D4-CF0B-46C9-AE61-339B78E4EA8D.htm
- Level Constraint (moving a level moves assigned elements) [Confirmed]: https://help.autodesk.com/cloudhelp/2024/ENU/Revit-GetStarted/files/GUID-F91EB292-28CE-4849-82FE-AA45992A3148.htm
- Datum elements (levels, grids, ModelCurves) [Confirmed]: https://help.autodesk.com/cloudhelp/2025/ENU/Revit-API/files/Revit_API_Developers_Guide/Revit_Geometric_Elements/Revit_API_Revit_API_Developers_Guide_Revit_Geometric_Elements_Datum_and_Information_Elements_html.html
- Constraints (lock, EQ, Align) persistent model data [Confirmed]: https://help.autodesk.com/cloudhelp/2020/ENU/Revit-Model/files/GUID-0D185F17-E53C-4ADD-B5C1-D7BAD2FE4507.htm
- About Family Templates — host-based (wall/ceiling/floor/roof, may cut openings), face-based, line-based [Confirmed]: https://help.autodesk.com/cloudhelp/2015/ENU/Revit-Customize/files/GUID-E36987A9-A68F-4121-A391-907306BAA60A.htm
- Revit LT "Parts of the User Interface" — 16-region UI anatomy (QAT, Options Bar, Type Selector, Properties, Project Browser, Status bar, View Control Bar, contextual tabs…) [Confirmed]: https://help.autodesk.com/cloudhelp/2022/ENU/RevitLT-GetStarted/files/GUID-7793667D-5657-4382-9BEC-F7CB6AC8F53E.htm
- Nested and Shared Families (nesting + parameter mapping) [Confirmed-as-printed — page located, used for §3.6 part 7]: https://help.autodesk.com/cloudhelp/2022/ENU/RevitLT-Customize/files/GUID-32FD07FC-7CB2-45FD-8279-702D5013E4C0.htm
- Dependent-element discovery via Delete-and-abort [Confirmed — Building Coder mirror]: https://raw.githubusercontent.com/jmcouffin/tbc/refs/heads/gh-pages/a/0314_object_relationship.htm
- ⚠ UNVERIFIED(waf-challenge): thebuildingcoder.typepad.com and the Revit 2013 API Developer Guide PDF (Cloudflare challenge, terminal this session); literal phrase "parametric change engine" not quotable from a fetchable primary source.

**IFC4 schema (primary HTML spec via research browser; steptools mirror cross-check):**
- IfcWall (standard-case = `IfcMaterialProfileSetUsage` requirement) [Confirmed]: https://standards.buildingsmart.org/IFC/RELEASE/IFC4/FINAL/HTML/schema/ifcsharedbldgelements/lexical/ifcwall.htm
- IfcRelVoidsElement (*"implies a Boolean operation of subtraction"*) [Confirmed]: https://standards.buildingsmart.org/IFC/RELEASE/IFC4/FINAL/HTML/schema/ifcproductextension/lexical/ifcrelvoidselement.htm
- Annex E — wall with opening and window (door/window placement relative to opening) [Confirmed]: https://standards.buildingsmart.org/IFC/RELEASE/IFC4/FINAL/HTML/annex/annex-e/wall-with-opening-and-window.htm
- IfcWallType (type→occurrence; *"illegal to share shape representations as representation maps for occurrences of IfcWallStandardCase"*) [Confirmed]: https://standards.buildingsmart.org/IFC/RELEASE/IFC4/FINAL/HTML/schema/ifcsharedbldgelements/lexical/ifcwalltype.htm
- IfcRelAggregates (*"The behaviour that is implied from the dependency relationship has to be established inside the applications"*) [Confirmed]: https://standards.buildingsmart.org/IFC/RELEASE/IFC4/FINAL/HTML/schema/ifckernel/lexical/ifcrelaggregates.htm
- IfcConstraint (abstract; `IfcMetric`, `IfcObjective`; hard/soft/advisory) [Confirmed — steptools mirror; primary blocked by WAF ⚠ waf-challenge]: http://www.steptools.com/docs/ifcbim/html/t_ifcconstraint.html
- IfcRelConnectsPathElements [Confirmed — steptools mirror]: http://www.steptools.com/docs/ifcbim/html/t_ifcrelconnectspathelements.html
- IfcGrid, IfcAnnotation definitions [Confirmed]: buildingSMART IFC4 FINAL HTML schema, ifcproductextension
- ⚠ UNVERIFIED(page-path): direct IFC4 pages for `IfcRelFillsElement` and `IfcDimensionCurve` (404 in FINAL HTML tree); pattern confirmed via Annex E instead.
- ⚠ waf-challenge: https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/IFC4_ADD2_TC1.exp (Cloudflare interstitial, one attempt, terminal this session)

**IfcOpenShell / geometry pipeline:**
- IfcConvert.cpp v0.8.0 — SVG options `--section-height`, `--storey-heights`, `--scale`; **no `--plan`/`--model-cut`** [Confirmed]: https://github.com/IfcOpenShell/IfcOpenShell/blob/v0.8.0/src/ifcconvert/IfcConvert.cpp
- SvgSerializer.cpp — OCCT `HLRBRep_PolyHLRToShape`, `BRepAlgoAPI_Cut` halfspaces before HLR [Confirmed]: https://github.com/IfcOpenShell/IfcOpenShell/blob/v0.8.0/src/serializers/SvgSerializer.cpp
- IfcOpenShell Python docs — headless `ifcopenshell.geom.iterator` with `geometry_library` incl. CGAL option, multicore [Confirmed]: https://docs.ifcopenshell.org/ifcopenshell-python/geometry_processing.html
- IfcOpenShell geometry settings — `dimensionality`, SVG serializer settings (SvgAutoSection, SvgAutoElevation, SvgDrawStoreyHeights, SvgDoorArcs…) [Confirmed]: https://docs.ifcopenshell.org/ifcopenshell/geometry_settings.html
- ifcopenshell.api module index (~30 authoring modules incl. grid, drawing, spatial, type, georeference) [Confirmed]: https://docs.ifcopenshell.org/autoapi/ifcopenshell/api/index.html
- IfcOpenShell licensing — repo root carries COPYING (GPL-3) and COPYING.LESSER [Confirmed]: https://github.com/IfcOpenShell/IfcOpenShell/tree/v0.8.0
- ⚠ UNVERIFIED(no-benchmark): no authoritative IfcOpenShell performance benchmarks located.

**OCCT:**
- HLRBRep reference — *"Hidden Lines Removal algorithms on the BRep DataStructure"*; `PolyAlgo` for triangulations [Confirmed]: https://dev.opencascade.org/doc/occt-7.0.0/refman/html/class_h_l_r_b_rep.html

**Prior art:**
- Bonsai architecture — IfcOpenShell Python bindings as the data layer, OpenCASCADE (+ optional CGAL) geometry, heavy lifting in IfcOpenShell C++ core [Confirmed]: https://docs.bonsaibim.org/studio/guides/development/hello_world.html
- Bonsai missing live recompute — user request for automatic "Update Button" after moves [Confirmed]: https://community.osarch.org/discussion/comment/29242#Comment_29242
- FreeCAD FCStd format (zip container: Document.xml + .brp BREP files) [Confirmed]: https://wiki.freecad.org/File_Format_FCStd
- FreeCAD Sketcher (constraint solver, DOF tracking) [Confirmed]: https://wiki.freecad.org/Sketcher_Workbench
- planegcs (FreeCAD solver; standalone WASM + Python builds) [Confirmed]: https://github.com/spookylukey/planegcs ; https://github.com/Salusoft89/planegcs
- SolveSpace (GPLv3 parametric 2D/3D CAD, constraint solver, DXF/PDF/SVG output) [Confirmed]: https://solvespace.com/index

**Stack components:**
- Tauri sidecar docs [Confirmed]: https://v2.tauri.app/develop/sidecar/
- npm registry: dockview 8.5.1, zustand 5.0.15, immer 11.1.21, three 0.186.1 [Confirmed]

**IFC4 vs IFC4.3 decision (§11.4):**
- IfcOpenShell schema support statement — *"Extensive geometric support is implemented for… IFC2x3 TC1 and IFC4 Add2 TC1. Support for parsing is provided for IFC4x1, IFC4x2, and the IFC4x3 release candidates"* [Confirmed]: https://docs.ifcopenshell.org/ifcopenshell.html
- Autodesk revit-ifc releases, 2026 — v27.3.0.12 (2026-08-13) fixes elements *"when exporting to IFC4x3"*; v25.4.40 / v24.3.40 *"Added IFC4.3 Reference View exchange requirements"* [Confirmed]: https://github.com/Autodesk/revit-ifc/releases
- ⚠ UNVERIFIED(auth-required): Autodesk support article "Is it possible to export IFC4x3 from Revit" — page title confirms the topic, body behind login (fetched via research browser, auth wall).
- ⚠ waf-challenge: Solibri "IFC Standards Supported by Solibri" help page (Cloudflare interstitial, one attempt, terminal this session) — Solibri's 2026 IFC4.3 certification status unverified.

**AI driver research (§5):**
- TypeChat.NET — *"translates user intent into strongly typed actions"*; *"Strong typing may help make software that uses language models more deterministic and reliable"* [Confirmed]: https://github.com/microsoft/typechat.net (README)
- AAIF — *"Improving tool-call reliability with JSON Schema 2020-12"*: agents *"hallucinate keys, omit mandatory state-dependent fields, or conflate argument schemas"* [Confirmed]: https://aaif.io/blog/improving-tool-call-reliability-with-json-schema-2020-12
- ComAct / ComCADBench (arXiv 2606.13239) — *"GUI-based agents suffer from fragile visual grounding and long-horizon error accumulation"*; frontier models *"near-zero success under GUI-based interaction"* on industrial CAD vs programmatic execution [Confirmed]: https://arxiv.org/abs/2606.13239
- Text2CAD (NeurIPS 2024) — LLMs generate sequential parametric CAD designs from text [Confirmed-as-printed]: https://proceedings.neurips.cc/paper_files/paper/2024/file/0e5b96f97c1813bb75f6c28532c2ecc7-Paper-Conference.pdf
- CAD-Recode (ICCV 2025) — CAD code generation [Confirmed-as-printed]: https://openaccess.thecvf.com/content/ICCV2025/papers/Rukhovich_CAD-Recode_Reverse_Engineering_CAD_Code_from_Point_Clouds_ICCV_2025_paper.pdf
- ⚠ waf-challenge: ACM DL page for the SIGGRAPH multi-agent CAD paper (Cloudflare interstitial; title noted from search index, content not fetched).
