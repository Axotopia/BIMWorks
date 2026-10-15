# BIMWorks — Specification v0.2

**Status:** v0.2 — normative. **Supersedes:** `SPECIFICATION-v0.1.md` (retained for the record).
**Designation:** this document is the *contract*. It states what BIMWorks **MUST** be.

## Authority and relationship to other documents

| Document | Role | Authority |
|---|---|---|
| `SPECIFICATION-v0.2.md` (this) | **What BIMWorks must be.** Interfaces, invariants, acceptance. | **Normative** |
| `SPECIFICATION-v0.1.md` | First draft. Superseded; retained only because §0 refers to it. | Withdrawn |
| `IMPLEMENTATION-PLAN-2026-10-14.md` | **When and in what order.** P0–P7, status tables, risk register. | Sequencing |
| `SPEC.md` | **Why.** Research rationale, sourced Revit/IFC quotations. | Non-normative |
| `README.md` | Orientation and how to run it. | Non-normative |

Where this document and any other disagree, **this document wins on *what***, and the plan **wins on
*when***. The plan's status tables are the record of what is built; this document does not restate
them.

## How to read a requirement

- **[OBS]** — observed in this repository, by reading or by execution.
- **[REQ]** — normative requirement.
- **[GAP]** — required and currently unmet, with evidence.
- **[OPEN]** — unresolved; needs a measurement or a decision.
- **[REA:…]** — the reverse-engineering finding the requirement rests on. Full mapping in §22.

A requirement is satisfied when a check fails without it (§20), not because it appears here.

---

## 0. Revision note — v0.1 → v0.2

v0.1 had two defects, both confirmed after it was written:

1. **It was drafted without reading `docs/IMPLEMENTATION-PLAN-2026-10-14.md`.** It therefore
   re-demanded work the plan records as complete (units boundary, overlay v3, staleness gating, grid
   authoring, dependency graph, planegcs solver, sketch model, HLR, bus parity gate) and marked
   **[OPEN]** several questions the plan already answers with evidence (undo shape — plan N10;
   solver — plan P3; HLR kind — plan P5).
2. **It carried roughly ten reverse-engineering findings out of a corpus of several hundred.** The
   editing-interaction architecture, the 2D-editor uncoupling, direct manipulation, views/sheets/tag
   tracking, the family and type model, the API-evolution stability record and the shipped-IFC-asset
   inventory were all absent.

**v0.2 corrects both.** §22 is the proof of the second: every REA finding is listed with a
disposition. If a finding is not in §22, it was not folded in.

**Corrections carried forward.** Two claims in the REA corpus were later found wrong and are
**superseded here**, not repeated:

| Stale claim | Where | Correct position |
|---|---|---|
| `TopographySurface` has 0 documented members and is gone | `how-revit-edits-host-elements.md` | It has **24** documented members in `Autodesk.Revit.DB.Architecture`; the zero count was a namespace error. `Toposolid` (17) is the modern path beside it. |
| Several member counts and a "no HLR" status | early REA passes; README status block | An extraction-parser bug silently dropped members whose `<summary>` tags shared a line. **Treat all member counts in the REA corpus as lower bounds** unless re-run. |

The REA corpus is also subject to a project decision recorded in the plan — *"no REA/binary analysis
of Revit"* — taken before this work. §23 addresses that directly rather than ignoring it.

---

## 1. Scope

### 1.1 In scope — authored by BIMWorks

Walls · doors · windows · slabs · roofs · levels · grids · sketches and profiles · walls' layered
build-up · joins and cuts · constraints · views, sheets and tag tracking · the type and parameter
model · 2D drawings with hidden-line removal · vector PDF · IFC4 export/import · a typed command bus
shared by UI and AI.

### 1.2 Preserve-only — not authored, must survive (§18)

Topography and toposolids · stairs and railings · curtain walls · MEP and connectors · rebar ·
structural framing · imported opaque geometry.

### 1.3 Non-goals

The Family Editor as an authoring UI (the *type model* is in scope, §14) · cloud collaboration ·
worksharing · reading `.rvt` · certification or stamped documents.

**[REQ]** No surface may imply a capability outside these lists. A README claim, a menu item, or an
exported document MUST NOT suggest `.rvt` support, code compliance, or authoring of a preserve-only
subsystem.

---

## 2. Vocabulary

**Element** — a persistent object with a GUID and parameters. **Overlay** — `parametric.json`.
**Model of record** — `model.ifc`. **Bus** — the typed command bus. **Key element** — in a join, the
wall that runs through. **Editor** — a per-view interaction object (§8). **Trf** — the model↔view
transform (§9).

---

## 3. Product definition

**[REQ]** Usable to model a small commercial building and issue a drawing set without manual geometry
repair.

**[REQ]** Every UI operation MUST be reachable over the bus, and every bus operation MUST be
reachable from the UI. No operation may exist on only one side. Verified by a parity audit that
performs a task through the bus with the UI disabled. *(Plan N5/P1 established this; the gate exists.)*

**[REQ]** No network access required to open, edit or save a model.

---

## 4. Evidence base and its limits

This specification's Revit-derived requirements rest on four evidence classes. Their limits are part
of the spec because they bound how much weight a requirement can carry.

| Class | What it yields | What it cannot yield |
|---|---|---|
| Shipped API documentation, 2010–2027 | which operations exist, how many, and how the count moved | behaviour |
| Revit 2010 SDK source, 820 files | real call sequences and transaction discipline | anything not sampled |
| Native export tables (`HostObjDB`, `EssentialsDB`, `StairRampDB`, `SiteDB`, `FamilyDB`, `CurtainGridFamilyDB`, `RevitUI`, `EssentialsUI`, `HostObjUI`) | class and method names, sometimes signatures | **arithmetic** |
| Executed measurement in this repository | the actual numbers in §11.3, §6.3, §20.5 | generalisation beyond the corpus |

**[OPEN] and stated plainly:** the **geometry algorithms are not recoverable this way.** How a join
computes its miter, how a footprint roof derives hips from a footprint, how the slab-shape solver
triangulates — that math lives in unnamed static functions. Ghidra auto-analysis also timed out on
every native module above ~2.8 MB in this environment, so the largest modules (14–44 MB) yielded
export tables only. Every behavioural statement traced to a symbol name is an **inference from
naming**, calibrated by one decompiled body (`PreviewMgrBase::doIsolate`) that matched its name.

Consequence for this spec: **REA-derived requirements are hypotheses with strong provenance, not
measurements of Revit.** Where a requirement is fidelity-critical, §20.6 requires a live probe.

---

## 5. Data model

**[REQ]** The project file is a plain zip (`<name>.bimworks`): `model.ifc`, `parametric.json`,
`views/*.json`, `meta.json`. No proprietary framing, obfuscation or encryption.

**[REQ]** `model.ifc` MUST be a valid standalone IFC4 file that opens in a third-party viewer without
BIMWorks. Losing the overlay MUST degrade the model to *static but valid*, never corrupt.

**[REQ]** The overlay MUST carry, per element GUID: `version`, `units`, `elements` (baseline, polygon,
host, offsets, sketch, thickness, level, grid axis, type properties), `join_policies`, `constraints`,
view definitions. [REA: see `SPEC.md` §3.1 for why IFC cannot carry these]

**[REQ]** An unknown **newer** overlay `version` MUST be refused with a clear message, never
partially applied.

**[REQ]** An overlay entry whose GUID is absent from the IFC MUST be reported **stale** and never
silently applied or discarded. Records that cannot be reconstructed MUST be reported **failed**; IFC
content absent from the overlay MUST be reported **unparametrized**. A load report MUST be returned.
*(Plan N3 → P2 item 4.)*

**[REQ — units]** Every stored length is **decimal feet**. `backend/units.py` is the only conversion
point; converter selection MUST be explicit rather than inferred.
**[REA]** Revit's internal unit has been decimal feet across every release examined, and Revit's own
unit handling is the reason the convention is worth matching.

**[REQ]** `ifcopenshell.api.geometry.edit_object_placement` and every equivalent call site MUST pass
`is_si=False`, because BIMWorks' values are already in the file's unit. *(Plan P5 documents two
3.28× defects from getting this wrong — one in placements, one in hosted opening sizes that silently
disabled opening subtraction.)* This is a **normative rule**, not a past bug.

**[REQ]** Zero and negative MUST NOT be overloaded as "unset" for a geometric filter without an
explicit sentinel. *(Plan P5: `view_depth == 0` meant "no limit" while `0.01` meant "almost nothing".)*

---

## 6. Command bus

**[REQ]** `COMMAND_REGISTRY` is the single source of truth. Adding a command means adding one registry
entry. A command reachable from the UI but absent from the registry is a defect.

**[REQ]** JSON Schema 2020-12 MUST be exported for every command. The schema is the contract an AI
driver plans against.

**[REQ]** Every mutation MUST occur inside a transaction. **Every mutating HTTP route MUST be
bus-backed**; there MUST be no unjournaled mutation path. *(Plan N5 was exactly this defect class, and
the plan records it recurring: the upstream geometry editor added `ElementUpdate` to the bus while the
UI kept calling raw REST, so a shipped feature was unundoable the day it landed.)*

**[REQ]** A transaction is atomic. On failure the model MUST be byte-identical to its pre-state.

**[REQ]** Every transaction records `origin` (at least `ui`, `ai`, `import`) and a human description.

**[REQ]** Document *lifecycle* operations (new, load, import, reset) MUST NOT be journaled as undoable
edits — they replace the document rather than edit it.

### 6.3 Post-commit protocol

**[RESOLVED (v0.2 N10)]** Delta Protocol implemented (`GET /api/state?since=<rev>`).
Response A (`unchanged: true`), Response B (delta with `upsert_meshes`, `remove_guids`, dirty view slice filter, `journal_append`), and Response C (full bundle resync). Wired into the store and verified by `scripts/check-state-bundle.mjs` (45 checks) and `scripts/check-delta-equivalence.mjs` (14 checks). Empirical benchmark: 71.7% payload reduction, p50 delta latency 1.10 ms (see `docs/DELTA-MEASUREMENT.md`).

### 6.4 Instrumentation — two numbers that must not be conflated

**[GAP]** A reported "drag result" of p95 ≈ 4.9 ms measured in-process recompute only — roughly a
tenth of what a user waits for. Measured end-to-end: p50 36.7 ms / p95 66.9 ms against a 16 ms budget,
with ~30 ms in refetches.

**[REQ]** **`engine_ms`** (engine process only, IPC excluded) and **interaction latency** (UI input to
the frame that reflects it) MUST be logged as separate, distinctly named metrics. Any performance
claim MUST state which one it is, with the model size and corpus.

---

## 7. Recompute engine

**[REQ]** The dependency graph MUST live in the engine. Nodes are element parameters and geometry
outputs; edges are hosting, constraint, level, sketch membership and join. Dirty-flag topological
recompute. [REA: `ADocument::regenerate`, `getRegenStepRepository`, `clearRegenSteps`,
`updateAllViews`]

**[REQ]** Join recompute MUST be **one hop**, not transitive: a wall's own baseline determines its
joins. Moving one wall in a chain MUST NOT recompute the chain. *(Plan P3 measured 3 of 12 walls.)*

**[REQ]** Batched edits MUST suspend view updates rather than trigger a rebuild per mutation.
[REA: `SuppressViewUpdate`, an RAII guard]

**[REQ]** Deletion MUST compute a **deletion closure** — the full dependent set — before removing
anything. [REA: `ADocument::computeDeletionClosure`, `deleteElementsAndChildren`]
*This also confirms a documented Revit idiom: calling Delete inside a transaction, reading the
dependent ids from the failure, and aborting. The requirement is the closure, not the trick.*

**[REQ — undo shape]** Undo/redo MUST be incremental or structurally shared, **not** a full
serialization per transaction.

**[GAP]** Current state is a full snapshot that deep-copies meshes per edit (plan N10, "still open —
unchanged"). This is **known and tracked**, not an open question, and it contradicts §19.
**[REA]** Revit tracks undo as discrete **episodes** — `DocumentIncrementTable::begin/end`,
`DocumentIncrement::greatestEpisodeId`, `DocumentHistory::getEpisode` — not as element or model
snapshots. The reference shape is incremental.

---

## 8. Editing interaction architecture

The layer that makes an application feel like a drafting tool rather than a form. All [REA] from
`revit-editing-interaction-architecture.md`.

### 8.1 The core pattern

**[REQ]** A command handler MUST be able to **supply the interaction object** that performs it, rather
than the framework choosing one. [REA: `ACommandHandler::getEditor`]

**[REQ]** Ribbon state — enabled, visible, checked, caption — MUST be derived **per command per view**
from the handler, not stored on the ribbon item. [REA: `ACommandHandler::isEnabled/isVisible/
isChecked/getCaption/getRejectedViewRules`; `UIFramework.CommandAccess` + `CommandAccessDictionary`]

**[REQ]** There MUST be a command registry/router so a command can be looked up, redirected and
rejected consistently. [REA: `ACommandRegistry`, `ACommandRouter`, `ACommandRegistrar`,
`ACommandContext{ADocument, DBView, GView}`]

### 8.2 The Editor contract

**[REQ]** An active tool MUST be a per-view object with an explicit lifecycle, **rebuilt on view
switch**, owning its own transient graphics. The contract MUST include:

| Group | Members [REA: `REVITDB.DLL::Editor`] |
|---|---|
| Lifecycle | load, abort, `cancelDirtyEditor`, `restartOnViewSwitch`, `onViewSwitch` |
| Input | mouse down/up/double-click (L/M/R), move, wheel, char, meta-key, leave, kill-focus — each with an override hook **and** a framework dispatcher |
| Commands | dispatch, update-command, post-command, context menu build/handle |
| Model reaction | `onViewChanged`, `onSymbolIdChanged` (type changed), `onPropertiesChanged` (parameter changed) |
| Prompts | `statusPrompt` **separate from** `getTooltipIndependentOfStatusPrompt`; cursor |
| Highlight | `getSelectionToHilite` and `getSelectionToPreHilite` as **separate** hooks |
| Graphics | per-editor transient draw list with explicit lend/clean |
| Scope | `onUserClearModScope`; transaction interrupt/restart |
| Sub-editors | link, kill, carry child completion, abort sub-editors on handled command |

**[REQ]** The **doubling** (override hook + framework dispatcher) MUST be preserved so a subclass
cannot bypass dispatch.

**[REQ]** Sub-editor composition MUST be supported so a complex tool can host a sketch editor which
hosts a text editor.

### 8.3 Editor catalogue

**[REQ]** At minimum: single pick, multi pick, edge pick, face pick, rectangular select, zoom rect,
drag, and motion. [REA: `SingleElementPickEditor`, `MultiElementPickEditor`, `EdgePickEditor`,
`FacePickEditor`, `SelectRectEditor`, `ZoomRectEditor`, `SimpleDragEditor`, `ShowMotionEditor`]

**[REQ]** Multi-pick MUST be able to present a contextual finish/cancel bar. [REA:
`MultiPickEditor::createDialogBar` — this is the origin of `Modify | <tool>` Finish/Cancel]

### 8.4 In-canvas typed value entry

**[REQ]** There MUST be a **reusable** inline editor family — one widget with typed variants for
length, angle, number and parameter — not per-tool code. [REA: `TextControlEditorTemplBase`,
`TextLengthEditor`, `TextAngleEditor`, `TextDoubleEditor`, `TextParamEditor`]

**[REQ]** In-canvas entry MUST support **commit/cancel buttons beside the box** and typed validation
with distinct cancel/abort outcomes. [REA: `createButtons`, `computeButtonPos`, `onUserCommit`,
`onUserCancel`, `validate`, `textCanceled`, `textAborted`]

**[REQ]** Temporary dimensions MUST be owned by a preview manager, **keyed by element id**, with the
active editor registering a **dimension listener** and snapping its preview to it. [REA:
`PreviewMgr::showPreviewDims/getTempWallDimIds/cleanTempWallDims`; `StartPointEditor::getListenDimId/
onListenDimDone/snapPreviewDim/removeDimensionAndCursor`]

### 8.5 Options Bar

**[REQ]** The Options Bar MUST render from a **registry keyed by the active command**, and the options
MUST be the same descriptor the bus validates against. [REA:
`SketchGalleryOptionsRegistry::getSGOForActiveCommand`, `findOptionsForCommand`, `isSameDrawPickTool`]

**[REQ]** Options MUST be a **typed per-command object**, not ad-hoc flags. [REA: `ModifyUIOptions`
exposes `getAlign_Lock`, `getAlign_Multiple`, `getAlign_PatternPreference`,
`getAlign_WallsPreference` — the actual Align options bar]

### 8.6 Contextual tabs and ribbon

**[REQ]** Contextual tabs MUST be a collection of tab definitions with a helper that decides which is
live, plus a modeless floating panel. [REA: `ContextualTab`, `ContextualTabs`, `ContextualTabHelper`,
`FloatingContextualPanel`]

**[REQ]** A contextual bar MUST be a **generic** bar component bound to a resource id, with controls
addressed by stable ids — not N bespoke classes. [REA: `ADialogBar` + `ResourceId`; the three
slab-shape bars are the same generic bar]

**[REQ]** The view title label MUST be a **viewport-owned object** whose text derives from the view —
never stored independently. [REA: Revit's §13 model; and see §13 here]

**[REQ]** Placement-mode buttons MUST reflect the active placement method from the placement helper.
[REA: `CDFamilyEdHelper::setCheckCommand` + `s_curButtonState`]

### 8.7 Picking

**[REQ]** Selection MUST be a **hit test against graphics representations**, producing a typed pick of
**element id + sub-element tag**, filtered by a per-tool predicate whose default depends on document
state, not only on the tool. [REA: `GRAPHICS.DLL::Pick{getElemId, getTag, isElement}`,
`PickFilter`, `findPickInGRep`, `PickEditor::getDefaultPickFilterForCurrentADocState`]

**[REQ]** Tab-to-cycle-candidates MUST be supported. [REA: `PickEditor::onTab`,
`addGenericCandidates`, `addGenericCandidatesAfterCurrent`]

### 8.8 Journaling

**[REQ]** The bus record MUST support **scopes** — some operations are explicitly *not* recordable —
and MUST record **parameter reads** as well as writes. [REA: `NoJournalingScope`,
`JournalItemStatus`, `WPFParameterAccessJournalEventHandler`, `TypeSelectorSearchJournaling`,
`EventPlayBackHandler`]

---

## 9. The 2D editing engine

**[REQ]** There MUST be **one** shared curve/sketch editing engine parameterised by element family —
not one editor per family. [REA: `CurveEdHpr`, constructed by `newCurveEdHpr`,
`newCurveEdHprForAutoCreate`, `newCurveEdHprForDrag`]

**[REQ]** The engine MUST be parameterised on exactly these axes: the sketch data; the sketch plane;
a **family-flavour enum**; the contextual bar plus sketch properties; and snapping plus the
model↔view transform. **No element type may appear in the engine's signature.** [REA:
`SketchBase`, `SketchPlane`, `CurveHelperTypes`, `CurveDialogBar`, `SketchingProperties`,
`SketchHelperCustomSnaps`, `TrfComputer`]

**[REQ]** The model↔view transform MUST be a separate, first-class component. **Until it exists, a
shared editor is impossible**, because the editor cannot be view-agnostic. [REA:
`CurveEdHpr::TrfComputer::compute(const DBView*, Trf*)`]

**[REQ]** Family behaviour MUST live in thin **helpers** implementing a small interface, not in
branches inside the engine. Granularity MUST follow data, not the ribbon: floors and ceilings share
one helper. [REA: `CeilingAndFloorSketchHelperUI` (floors *and* ceilings),
`RoofBaseDMHelper`, `MultiPickPointHelper`; interface members `getElement`, `createControls`,
`createControlsForPicks`, `enablePickWallsInRibbonGallery`]

**[REQ]** The engine MUST support three construction modes: edit, **auto-create** (pick host walls →
generate the boundary → attach), and **drag**. [REA: the three factories; and
`joinWallsToFloorLikeElemAndSketchedElem`, `createACopyAndAttach`]

**[REQ]** Dimension and angle capability MUST be **flags on the one engine**, set per family. [REA:
`allowLengthDim`, `allowAngRound`, `allowOverlapWithElem`, `noDimsAndRemoteSnapping`,
`getGeomRefForRadialDim`]

**[REQ]** A **chain** concept MUST exist — a connected run of curves with a predicate deciding where
the chain stops — and offset MUST be a strategy over it. [REA: `ChainInfo`,
`CurveChainExtractor`, `StopChainPredicate`, `MatrixCurveChainOffset` / `SingleCurveChainOffset`]

---

## 10. Direct manipulation

**[REQ — the central rule]** Shape handles MUST be modelled as **picks recognised by a move helper**.
There MUST NOT be a separate grip subsystem. [REA: no `Grip` symbol exists in any module examined;
`MoveHelperUI::getPicks4KnownShapeHandleCtrls` resolves handles *from picks*; `ArrowEditor` drives
them]

**[REQ]** Snapping MUST be a **composable, cached filter pipeline that emits snap objects**, given a
constraining plane. [REA: `DatumSnapFilterTmpl<CachingPickFilter<SnapMoveFilter>>::addCustomSnaps(
…, const Plane&, OwnerArr<RawSnap>*)`]

**[REQ]** Transient alignment lines MUST be an **acquired and relinquished scoped resource**, not a
persistent overlay. [REA: `SnappingHelper::acquireTransientAlignmentId` /
`relinquishTransientAlignments`]

**[REQ]** End dragging MUST exist in single and multi form. [REA: `DragEndEditor`,
`MultiEndDragEditor`]

**[REQ]** Joins MUST be established and removed **during** a drag, including removal of joins to
elements outside the drag set. [REA: `EstablishJoinsForDragHelper::establishJoinsBetweenElements` /
`removeJoinsToExternalElements`]

**[REQ]** Drag controls MUST be created per category by named factories rather than one generic set.
[REA: `JoinDragControlUtil::create{Wall,BeamAndBrace,CDFamInst}MultiElementControls`]

**[REA→REQ]** **Ctrl+drag creates a copy and shows dimensions.** This is a named behaviour in the
move manager, not an emergent accident. [REA: `MoveMgr::makeDimsForCtrlDrag`]

**[REQ]** Datum tools MUST validate the current view and **offer a command that opens a valid one**,
rather than failing. [REA: `CheckViewForLevelRelatedToolOptions` with `getCommandForBadView`,
`getMustHaveCurSketchPlane`, `getStoryLevelOnly`]

**[REQ — placement]** Placing a hosted component MUST be a **mode** owning a place helper that
**creates a place editor**, with a **dummy instance** as the cursor preview, **pluggable placement
methods**, per-step status prompts, multiple placement, and cleanup of everything created on abort.
[REA: `EssCuttingEnvironmentUI` / `CuttingEnvironmentUI`; `CreationPlaceHelper::
createPlaceEditorForCreation`, `canPlaceMultiple_`, `deletePlaceElements`; `CDFamilyEdHelper::
getDummyFamInst`, `getMethodProvider`, `enablePlaceMethod`, `firstPointStatusPrompt`,
`secondPointStatusPrompt`, `arcStatusPrompt`]

**[REQ]** Boolean cutters MUST be a first-class geometry category, and an **unused cutter MUST be
reported and removed** rather than silently retained. [REA: `VoidFormsNotUsed`]

---

## 11. Geometry: walls and joins

### 11.1 Join model

**[REQ]** Join state MUST be stored **per wall end**. [REA: `getJoinTypeFromEndInfoArr`]

**[REQ]** A **key element** MUST be designated per join, with a documented, stable rule that does not
depend on evaluation order. [REA: `EditWallJoinsUIInterface::getKeyElementInJoin`]

**[REQ]** An unjoined end ("lonely end") MUST be a queryable **state**, not an error. [REA:
`canGetLonelyEndAtPoint`, `canGetLonelyEndFromPick`]

**[REQ]** `square_off` MUST be a **separate attribute** from join type, not a third enum value. [REA:
`canChangeWJType` and `canChangeSquareOff` are distinct capabilities]

**[REA→[OPEN]]** Mitering can be **forced** in some configurations (`mustMiter`) and the join order
among 3+ walls is **reorderable** (`canReorderJoin`, `getAdjacentConfiguration`). Neither rule is
recoverable from names; both need a probe (§20.6).

### 11.2 Join persistence and exclusions

**[REQ]** Auto-join exclusions MUST be **persisted model data** with deletion-parent tracking, not
runtime flags. [REA: `AutoJoinExclusionsCell::addToExcludedIds/isExcluded/addDeletionParents/
updateForDeletion/getDetermRegenSteps`]

**[REQ]** Join resolution MUST be a **regeneration step**, not an immediate geometry operation. [REA:
`JoinEndGStep`, `JoinToRoofGStep`, `WallJoinTweakGStep`, `ResolveJoinHelper`]

**[REQ]** Joins MUST be tracked as **pairs**, with distinct handling for multi-plane junctions and for
tangency at curved walls. [REA: `IndexJoinPair`, `MultiPlaneJoinData`, `JoinTangencyControl`,
`SideJoinInfo`]

**[REQ]** A skipped join MUST raise a user-visible warning. Silence here is a correctness bug the user
cannot see. [REA: `SkippedJoinsWarning`]

**[REQ]** Corners MAY carry a finish identified by category, family and profile. The data model MUST
accommodate it even if the feature is deferred. [REA: `CornerFinishAttr::getCategoryId/
getFamilyNameAndPartitionType/getProfileParam`]

### 11.3 Miter geometry — **the miter MUST derive from side faces**

**[REQ]** A miter MUST be computed from the walls' **side faces**, not from an angle bisector. [REA:
`MiterBySideFacesTargetData`]

For wall A along +X (thickness `tA`, baseline centred on `y=0`) and wall B along +Y (thickness `tB`,
baseline centred on `x=0`), joined at the origin:

```
outer joint corner   ( tB/2,  tA/2 )     depends on BOTH thicknesses
inner joint corner   (-tB/2, -tA/2 )
joint plane          y = (tA/tB) * x
```

| # | Invariant |
|---|---|
| J1 | A's outer joint corner is at `(tB/2, tA/2)`. |
| J2 | A's and B's outer joint corners **coincide**. |
| J3 | A miter is **area-preserving** — the footprints sum to the untrimmed total. |
| J4 | No **degenerate vertex** at the junction. |

**[RESOLVED (2026-10-15)] J1, J2, J3, J4 all satisfied.** Historical note: the angle-bisector miter failed all four:

```
equal   0.3/0.3  A (0.1500,0.1500)  B (0.1500,0.1500)  required (0.1500,0.1500)  PASS
unequal 0.2/0.6  A (0.1000,0.1000)  B (0.3000,0.3000)  required (0.3000,0.1000)  FAIL (prior to fix)
unequal 0.6/0.2  A (0.3000,0.3000)  B (0.1000,0.1000)  required (0.1000,0.3000)  FAIL (prior to fix)
unequal 0.1/0.9  A (0.0500,0.0500)  B (0.4500,0.4500)  required (0.4500,0.0500)  FAIL (prior to fix)
```

Fixed in `backend/ifc_service.py` (`MiterBySideFacesTargetData`) by deriving the joint line from the
walls' side faces and extending a mitered end's footprint past its own endpoint by half the partner's
thickness. Verified by `scratch/test_wall_joins_matrix.py` (37/37 checks pass). J3 is area-preserving,
and J4 eliminates degenerate vertices at the junction.

**[REQ]** Butt joins MUST use a **two-sided** area check. A one-sided `total <= untrimmed` check cannot
detect a gap.

**[REA — negative result]** Wall-join resolution is **not documented by Autodesk.** The only join
sample in the 820-file 2010 SDK (`FamilyCreation/AutoJoin`) joins generic geometry *inside a family*.
`JoinGeometryUtils` exposes join/unjoin/get-joined, not corner resolution. §11.3 is therefore
evidence that only probing or binary inspection can supply.

---

## 12. Constraints

**[REQ]** Constraints MUST persist in the overlay keyed by GUID and survive save/load/undo/import.

**[REQ]** Align-lock, locked dimensions and equalize MUST each be independently removable, and a
constraint MUST be **updated in place** rather than appended. *(Plan P3: `equalize_span` appended a
duplicate constraint per call, so two identical calls left two constraints.)*

**[REQ]** Over-constraint MUST produce a **conflicting-set report**, never a half-applied state. *(Plan
P3: `last_constraint_conflict`.)*

**[REQ]** EQ MUST be a persistent solver relation that survives arbitrary later edits, with span
endpoints pinned and interiors redistributed. *(Plan P3 fixed this; the drift case landed 40.018
instead of 40 when the far endpoint was free.)*

**[REQ]** A solver MUST be embedded rather than hand-rolled. *(Plan P3 embeds **planegcs** — FreeCAD's
PlaneGCS, GPL-3.0, PyPI wheels — which is license-compatible with BIMWorks' GPL-3.0 and is the single
strongest argument for that licence choice.)*

---

## 13. Views, sheets and tag tracking

All [REA] from `views-sheets-and-tag-tracking.md`; the failure messages are Autodesk's own text.

### 13.1 Views and placement are separate objects

**[REQ]** A view MUST be a document object that can exist **unplaced**. Placement on a sheet MUST be a
separate object referencing both sheet and view, so that deleting a viewport never deletes the view.
[REA: `View` vs `Viewport{SheetId, ViewId}`]

**[REQ]** Placement MUST be expressed as a transform, not an offset. [REA:
`Viewport::GetProjectionToSheetTransform()`]

### 13.2 The constraints that make sheets fail

**[REQ]** These MUST be enforced as pre-checks, each with a severity, not as exceptions:

| Rule | Autodesk's message |
|---|---|
| A view appears at most once per sheet | `Sheet views cannot contain more than one instance of "%1!s!"` |
| A view appears at most once in the model | `Sheet views in this model cannot contain more than one instance of "%1!s!"` |
| Perspective views must be cropped | `Sheets do not support uncropped perspective views.` |
| Empty views cannot be placed | `Sheet views cannot contain empty view "%1!s!".` |
| Sheet numbers unique **per scope** | `Sheet Number is already in use. Enter a unique number.` / `…The same Sheet Number value can be used once for all sheets directly in the model, and once for all sheets per Sheet Collection` |
| Sheet number required | `Sheet Number is empty` |
| Collection names unique | `Sheet Collection name is already in use. Provide a unique name.` |

**[REQ]** Placement MUST consult **two separate predicates** — "can this view *type* go on a sheet at
all" and "can this view go here now". [REA: `Viewport::CanAddViewToSheet`,
`IsViewIdValidForViewport`, `DBViewTypeOnSheetUIHelper::canPlaceTypeOnSheet`]

**[REQ]** **Every constraint MUST carry both an error and a warning severity.** Revit ships a `Warn`
variant of each uniqueness rule; that is what allows warn-and-continue instead of failing the edit.

### 13.3 Numbering and browser order

**[REQ]** Sheet-number uniqueness MUST be scoped — model-level **and** per sheet collection.

**[REQ]** Browser ordering MUST be by stable organization identities, with an explicit auto-sort
toggle distinct from manual order. [REA: `ViewSheetSet.SheetOrganizationId` /
`ViewOrganizationId`; `ViewSheetSetUIData::getInSessionIsAutoSortMode` / `setInSessionAutoSortSchemas`]

**[REQ]** Placeholder sheets MUST be supported, and convertible to real sheets. [REA:
`ViewSheet::CreatePlaceholder`, `IsPlaceholder`, `ConvertToRealSheet`]

### 13.4 Tag tracking

**[REQ]** A marker (elevation, section, callout) MUST derive its label from the **referenced view's**
name and number. Label text MUST NOT be stored independently, or renumbering will not propagate. [REA:
`ReferenceableViewUtils::GetReferencedViewId` / `ChangeReferencedView`]

**[REQ]** The marker↔view relation MUST be navigable **in both directions**. [REA:
`ElevationMarker::GetViewId(index)` forward; `View::GetReferenceElevations` /
`GetReferenceSections` / `GetReferenceCallouts` backward]

**[REQ]** An elevation marker MUST be modelled as a **multi-slot container** with an index, a capacity
and an availability test. [REA: `ElevationMarker::CreateElevationMarker` / `CreateElevation(marker,
index)` / `CurrentViewCount` / `MaximumViewCount` / `IsAvailableIndex` / `IsReference`]

**[REQ]** The system MUST validate that a marker's views share one sheet, and offer "use a separate
marker" as the remedy. [REA — Autodesk's own message:] `An elevation symbol references views on more
than one sheet. It will show a blank sheet reference. To show the correct references, use a separate
elevation [marker].`

**[REQ]** Elevation tag types MUST carry view-direction semantics so a family swap can be validated. [REA:
`IncompatibleElevationTagFamily` — "Attempt to change elevation tag families to one with incompatible
view directions."] Also `ElevationDetach` — crop extents can detach from the arrow.

**[REQ]** **Dependent views** MUST be supported: one primary view with dependent views on several
sheets, plus deliberate severing. **This is the production answer for splitting a large plan across
sheets without duplicated content.** [REA: `View::GetPrimaryViewId`, `GetDependentViewIds`,
`ConvertToIndependent`, `CanViewBeDuplicated`]

### 13.5 Templates

**[REQ]** The default template MUST live on the view **type**, so a new view of that type is born
configured. [REA: `ViewFamilyType::DefaultTemplateId`, `IsValidDefaultTemplate`]

**[REQ]** A template MUST carry an **explicit list of parameters it does not control**. Most
reimplementations omit this, and it is what makes templates usable rather than all-or-nothing. [REA:
`View::GetNonControlledTemplateParameterIds` / `SetNonControlledTemplateParameterIds`]

### 13.6 Other sheet content

**[REQ]** Schedules MUST be placed on sheets by the same sheet-space placement pattern as viewports
(point + rotation), and a title-block revision schedule MUST be representable as a schedule instance
inside the title block. [REA: `ScheduleSheetInstance::Point/Rotation/SegmentIndex/ScheduleId`,
`IsTitleblockRevisionSchedule`; `SchedulesCanBePlacedOnSheetsOnly`]

**[REQ]** Revisions on sheets MUST be tracked per sheet. [REA: `ViewSheet::GetAllRevisionIds`,
`GetAdditionalRevisionIds`, `GetCurrentRevision`, `GetRevisionNumberOnSheet`,
`GetRevisionCloudNumberOnSheet`]

**[REQ]** Saved view/sheet sets MUST support save, save-as, rename, revert and delete. [REA:
`ViewSheetSetting::Save/SaveAs/Rename/Revert/Delete/AvailableViews`]

**[REA] — normative for §5:** IFC has **no view, sheet, viewport, marker or template model**. IFC
drawings are snapshots. Every mechanism in §13 belongs in the overlay, never in `model.ifc`.

---

## 14. Types, families and parameters

The Family Editor UI is deferred; the **type model is not**.

### 14.1 Structure

**[REQ]** Three levels: **type** (shared) → **instance** (placement) → **element**. Changing a type
affects all instances; changing an instance affects only it.

**[REQ]** A family's **placement type** MUST be an explicit enum that drives placement, hosting and
host migration. [REA: `FamilyPlacementType` — OneLevelBased, OneLevelBasedHosted, TwoLevelsBased,
WorkPlaneBased, CurveBased, CurveBasedDetail, CurveDrivenStructural, ViewBased, Adaptive, Invalid]

**[REQ]** Only one type per family may be **active**; placement MUST require activation. [REA:
`FamilySymbol::Activate` / `IsActive`; the `NoDefaultType` failure]

**[REQ]** Type parameter values MUST be **typed** (length, number, integer, string, element-id), not
strings. [REA: `FamilyType::AsDouble/AsInteger/AsString/AsElementId/AsValueString/HasValue`]

### 14.2 The labeling chain

**[REQ]** A dimension in a sketch MUST be associable to a parameter, and that association is the
mechanism by which parameters drive geometry. The chain MUST be: **sketch → auto-dimension → label →
solve.** [REA: `FamilyManager::AssociateElementParameterToFamilyParameter`; and its prerequisites
`SketchCannotBeAutomaticallyDimensioned`, `FamilyOverconstraint`, `FailedWhenLoadingFamily`,
`CannotUnlockFamilyTemplate`]

**[REQ]** Drawing MUST be prevented when a sketch cannot be auto-dimensioned, since labeling cannot
work. **[GAP-adjacent]:** this is a hard dependency the current sketch model does not express.

### 14.3 Parameter axes

**[REQ]** Parameters MUST support, as independent axes: instance vs type; formula; **reporting**;
shared (GUID-keyed); locked; and user-modifiable. [REA: `FamilyParameter::IsInstance`, `Formula` /
`IsDeterminedByFormula` / `CanAssignFormula`, `IsReporting`, `IsShared` / `GUID`, `IsReadOnly` /
`UserModifiable`; `MakeReporting` / `MakeNonReporting`; `IsParameterLockable`]

**[REQ]** **Instance parameters MUST NOT be usable in type-parameter formulas.** [REA:
`NoInstparamFormulas` — "Instance Parameters can't be used in Type Parameter formulas."] This is a
scope rule that constrains the evaluation model and must be decided now.

**[REQ]** Formula evaluation MUST detect cycles at **four distinct levels** and report the cycle
rather than failing opaquely. [REA: `CircularRefsForInstParams` (instance parameters),
`ElementPropLinkCircularChain` (element property links), `GlobalParamFormulaCircularChain` (global
parameters), `TypeRecursiveElementIdParameter` (a type parameter pointing at its own type)]

**[REQ]** An unsatisfiable formula set MUST be reported per type, not as a global failure. [REA:
`CantSolve`, `FormulasFailedForType`]

**[REQ]** A formula-driven parameter MUST be read-only in the UI. [REA:
`FormulaBasedParameterCannotBeChanged`]

### 14.4 References — why a family is dimensionable

**[REQ]** A family MUST publish **named, typed references** that the project can dimension and align
to. Without this, instances are dimensionable only to their origin. [REA:
`FamilyInstance::GetReferences` / `GetReferenceByName` / `GetReferenceType`;
`FamilyInstanceReferenceType` (12 values); `ReferencePlane::GetReference` with `BubbleEnd`/`FreeEnd`]

**[REQ]** Invalidated references MUST be reported, not silently dropped. [REA:
`CouldNotGenerateReferencesForFamilyInstance`, `HighlightedElementFamRefsInvalidError`]

### 14.5 Hosting is a migratable, losable state

**[REQ]** Host, work plane and level MUST be inter-convertible where legal, and every illegal
conversion MUST give the specific remedy, not a generic error. [REA: `CannotChangeInstFam` ("try
changing Instance's Host to a Level first"), `CannotConvertInstHostToWorkPlane`,
`CannotFindHost`, `FamilyNotFitHostShape`]

**[REQ]** Loss of host MUST be a detectable, reportable state. [REA: `InstOutsideFaceBoundary` ("Instance
will lose association to host"), `FrozenBecauseFaceGone`, `CantMoveFrozenInstance`]

**[REQ]** Placement validity MUST be view-dependent where it is view-dependent in Revit. [REA:
`CantPlaceATOnDuctError` — "cannot be placed in an elevation or section view unless it is attached to
a duct"]

### 14.6 Instance subtleties

**[REQ]** Uncut geometry MUST be retrievable separately from the instance's actual (cut/joined)
geometry. [REA: `FamilyInstance::GetOriginalGeometry` vs `HasModifiedGeometry` / `UseInstanceGeometry`]

**[REQ]** Instance flip MUST be **three independent booleans**, not one. [REA: `flipFacing`,
`flipHand`, `CanFlipWorkPlane`; `FacingFlipped`, `FacingOrientation`]

**[REQ]** Spatial containment for hosted instances MUST be computed from **explicit calculation
points**, and from/to room MUST be supported. [REA:
`GetSpatialElementFromToCalculationPoints`, `FlipFromToRoom`, `GetSpatialElementCalculationPoint`]

**[REQ]** Coping MUST be a relationship, not a boolean. [REA: `AddCoping` / `RemoveCoping` /
`GetCopingIds` / `SetCopingIds`]

### 14.7 Family-internal visibility

**[REQ]** Family geometry MUST carry **per-detail-level** and **per-view-orientation** visibility, plus
a "shown only when cut" flag. One visibility rule per element will not port families. [REA:
`FamilyElementVisibility::IsShownInCoarse/Medium/Fine`, `IsShownInPlanRCPCut`, `IsShownOnlyWhenCut`,
`IsShownInFrontBack/LeftRight/TopBottom`]

### 14.8 Type generation is per-type and non-fatal

**[REQ]** Generating types MUST be per-type on failure; the system MUST report which type failed, MUST
NOT abort the document, and SHOULD be able to dump the failing definition. [REA: `CannotMakeTypeCB`,
`CannotMakeTypeFamilySaved`, `DeletingBadFamType`, `CannotRegenerateCorruptFamily`, `FamilyIsCorruptError`]

**[REQ]** Duplicate type names MUST be reported and ignored, not silently merged. [REA:
`DuplicateTypeName`]

**[REA→[REQ]]** A family is a **sandbox**: it MUST NOT reference elements outside itself. [REA:
`FamilyMembersReferToOutsideFamily`]

**[REQ]** Loading a family MUST produce a **three-level** diagnostic — family, nested family, and type
parameter scan. Unit mismatch MUST be a hard error, never a silent conversion. [REA:
`WhileLoadingFamily`, `WhileLoadingFamilyShared`, `WhileScanningParametersForType`;
`CannotLoadImperialFamilyToMetricProject`, `CannotLoadMetricFamilyToImperialProject`]

### 14.9 Failure objects carry remedy actions

**[REQ]** A failure object SHOULD carry **named remedy actions**, not only a message. [REA:
`FormElemRegenSelfIntersection` ships two distinct correctives — *Reorder Profiles* and *Reset
Connections*]

### 14.10 Performance warnings

**[REQ]** There MUST be a performance-warning category from the start. [REA: `PerformanceFailures` —
17 members including `LargeFamilyFile`, `ManyUnusedNestedFamilies`, `TooLargeSketch`,
`DuplicateInstances`, `HostHasTooManyInserts`, `ViewDetailLevelIsHighInLargeView`]

---

## 15. 2D views and HLR

**[REQ]** Linework MUST come from an in-process hidden-line pipeline. Shelling out to an external
converter per view is prohibited. *(Plan P5 implements `mesh_hlr` and documents why OCCT
`HLRBRep` is unreachable: `pythonocc-core` is conda-only and ifcopenshell exposes no HLR symbols.)*

**[REQ]** The three partitions — cut, projection, hidden — MUST be separated and MUST be
distinguishable in weight and style.

**[REQ]** Openings MUST void the cut runs at their own positions. *(Plan P5 asserts specific run
gaps.)*

**[REQ]** A plan MUST render without a GPU context. If WebGL is unavailable, the 2D path MUST still
work.

**[REQ]** View depth MUST clip geometry, not drop whole elements. **[OPEN]:** current behaviour drops
elements, "coarser than Revit's view range" (plan P5).

**[REQ]** Lineweight tables and view templates MUST be data on the output contract, so styling can
change without touching the renderer.

---

## 16. UI surface

**[REQ]** The UI MUST be a skin over the bus (§3).

**[REQ]** No invented values. A property that is not tracked MUST read as untracked. *(Plan P0-5,
N11.)*

**[REQ]** The Project Browser SHOULD be a dockable pane with lifecycle events. [REA: Revit's
`InitializeDockingSupport` / `CleanupDockingSupport` and `DockableFrame*` events; and
`BuiltInDockablePanes.ProjectBrowser` is named in 2014 metadata]

**[REQ]** View activation SHOULD be an asynchronous request pipeline rather than a synchronous setter.
[REA: `RequestViewChange` / `ViewChangeImpl` / `get_ActiveGraphicalView`, and the diagnostic change
from "Accessing the active view…" to "Changing the active view is not applicable to inactive
documents."]

**[REQ]** UI events SHOULD be **strongly typed pairs** rather than generic register/unregister. [REA:
17 typed event pairs added after 2014]

**[REQ]** Internal window handles MUST NOT be part of any public or persisted surface. [REA: Revit
replaced `m_wpMFCDoc`/`m_wpMFCApp` and removed `getMFCDoc`/`getADocument` in favour of an opaque
proxy]

---

## 17. Interoperability and IFC

**[REQ]** Exported `model.ifc` MUST validate against official IFC4 validation and open in at least two
independent viewers.

**[REQ]** Import MUST reconstruct elements and geometry, not only the storey hierarchy, and MUST
report per element what was parametrized, what was geometry-only, and why. *(Plan P2 item 7.)*

**[REQ]** A round-trip MUST NOT **silently** lose data. `docs/ifc-parity.md` MUST document, per class
and per property, what survives and what is dropped. Silent loss is prohibited; documented loss is
acceptable. **In a BIM application silent loss is more dangerous than in 2D drafting — a dropped
hosting relationship is a wrong building, not a wrong line.**

**[REQ]** Elements BIMWorks cannot author MUST be **preserved as opaque geometry**, never dropped.

**[REQ]** Georeferencing MUST use `IfcProjectedCRS` and `IfcMapConversion`.

### 17.1 Shipped-asset evidence

**[REA]** Revit ships its IFC mapping as **data and code**, which is directly usable as reference
material for §17's serializer and for `docs/ifc-parity.md`:

| Artifact | Content |
|---|---|
| `IFC Shared Parameters-…-ALL.txt` | **5,211** Revit↔IFC instance parameter mappings; 874 property sets; 1,001 entities; 472 measure types |
| `…-Type_ALL.txt` | 5,130 type parameter mappings |
| `IFCCertifiedEntitiesAndPSets.json` | certified entity list **per IFC version** — the authority for entity selection |
| 9 × `IFC*schema*.txexp` | **PE modules, one per IFC schema release** — evidence that "schema version is a boundary" is an established architecture, not a guess |
| `IfcGeom_*.dll`, `IfcCore_*.dll` | Revit bundles **IfcOpenShell** |

**[REQ — serializer]** The property serializer MUST be a **tagged union**, not scalar-only. **[REA]:**
~7% of Revit's mappings are not single values — `IfcTimeSeries` (286), `PropertyBoundedValue` (200),
`PropertyTableValue` (155). The latter two are `IfcProperty` **subtypes**, not measures. A
scalar-assuming writer will silently mis-serialize them.

**[REQ — licensing]** Because these artifacts are Autodesk-copyrighted and BIMWorks claims a
clean-room GPL-3.0 implementation, the mapping MUST be derived from **`Autodesk/revit-ifc`
(LGPL-2.1, public source)** or from the IFC schema, and the shipped tables used at most to
**cross-check**. They MUST NOT be redistributed. **This is a decision to record, not to leave
implicit**, because "clean-room" and "read Autodesk's compiled mapping modules" are in tension.

---

## 18. Preserve-only subsystems

These are **not authored**. The requirements exist so that import, storage and export handle them
correctly, and so that no claim overreaches.

**[REQ]** A preserve-only element MUST round-trip without loss of identity, and MUST NOT be silently
converted into a type BIMWorks can author.

| Subsystem | What preservation must respect |
|---|---|
| **Topography** | `TopographySurface` (24 documented members, `Architecture`) beside `Toposolid` (17); a surface imported from external data is **not point-editable** (`ArePointsEditable`), so editable-vs-opaque MUST be recorded per element. Triangulation state is itself undoable (`TriangulationDriverMemento`, 79 exports). |
| **Stairs** | A stair is a **container** of runs, landings, supports and railings, with **`Actual*` and `Desired*` counts both stored** — collapsing them loses the "actual differs from desired" behaviour. `Stairs_Legacy` still ships. Winders have no IFC representation and survive as geometry only. |
| **Curtain walls** | Cells are addressed by their two bounding gridlines; gridlines carry **provenance** (type-driven vs manual) and a **load-bearing order**; locked panels/mullions survive type changes while unlocked ones are regenerated. |
| **MEP / connectors** | ~500 exports across 12 classes in `FamilyDB.dll` — **the bulk of Revit's family machinery**. A family carrying connectors MUST import without its connector state corrupting the model. Decide explicitly: strip, preserve, or ignore. |
| **Opaque imports** | Geometry-only elements MUST remain selectable, visible, and exportable. |

**[REQ]** A preserve-only element MUST NOT be editable in a way that would require authoring
semantics BIMWorks does not have; the UI MUST say why.

---

## 19. Non-functional requirements

| Metric | Budget |
|---|---|
| Interaction latency, wall drag, p95 | < 16 ms, **measured end-to-end** (§6.4) |
| Orbit, 3D viewport | 60 fps at 2M triangles |
| Cold start | < 3 s |
| Save | MUST NOT block the UI > 200 ms |

**[REQ]** A budget without a stated model and corpus is not a measurement.

**[REQ]** `engine_ms` MUST NOT be reported as interaction latency.

**[REQ]** No network required. No `node_modules`, build output, `__pycache__` or virtualenv
committed. Every hard backend dependency declared in `requirements.txt`.

---

## 20. Verification requirements

### 20.1 Fixtures MUST vary each claimed dimension

**[REQ]** For every geometric algorithm, the corpus MUST vary each input dimension the algorithm
depends on. **If a key parameter is constant across a corpus, the suite is blind on that dimension
regardless of check count.**

**[GAP]** `scratch/test_wall_joins.py` has 18 passing checks and **every fixture wall is
`thickness: 0.3`.** It cannot detect any of J1–J4. The plan cites it as verified evidence for join
geometry.

**[REQ]** Every geometric test file MUST carry a **meta-test** asserting its corpus varies each
dimension it relies on, and the meta-test MUST fail when a dimension collapses.
**[OBS]** `scratch/test_wall_joins_matrix.py` implements this (28 pass / 9 fail; all 9 are J1–J4).

### 20.2 A check that cannot fail is a defect

**[REQ]** For every check it MUST be possible to state what it would have to observe in order to fail.
A check whose inputs cannot produce a failure MUST be removed or repaired.

**[GAP]** Three instances found: constant-thickness fixtures (§20.1); a "drag result" measuring a
tenth of the wait (§6.4); and the existing bisector check, satisfied for free by the degenerate
`(0,0)` vertex (§11.3 J4). All three produce a **green** signal that is green because it is blind.

### 20.3 Coverage gaps MUST be recorded, never silently skipped

**[REQ]** A test that cannot exercise a dimension MUST report it as an explicit gap.

**[OBS]** Unrepresentable today, therefore untested: **per-layer / compound-structure joins** (no layer
model in `element_meta`, though Revit's `CompoundStructure` is its largest editing surface at 79
members); **curved-wall joins** (`JoinTangencyControl`); **vertical join interaction**
(`JoinToRoofGStep`). The matrix test records all three.

### 20.4 Gates

**[REQ]** The bus-parity audit and the UI gate MUST remain in CI, and MUST fail loudly when they lose
coverage. A gate that cannot fail is worse than no gate.

### 20.5 Test execution MUST be portable

**[RESOLVED]** Test suites under `scratch/` emit ASCII-only output (`test_wall_joins.py` ASCII output,
Windows `cp1252` supported natively).

**[REQ]** Test output MUST be ASCII-only, or the runner MUST force UTF-8 stdout.

**[REQ]** Scripted edits MUST be verified by **executing** and by structural inspection, not by reading
a diff. *(Plan P5 records an edit that reported success without applying, and one that inserted a
helper inside a class body and silently truncated 89 methods to 6.)*

### 20.6 Fidelity-critical behaviour MUST be probed

**[REQ]** Where §4 cannot settle a behaviour — the join rules in §11.1, `mustMiter`, join order,
view-range clipping — the ground truth MUST be a **live probe** in Revit, recorded under
`docs/probes/` with the measurement and the version. REA-derived requirements are hypotheses until
probed.

---

## 21. Open questions

1. **Undo shape** — full snapshot per edit is current (plan N10). Incremental/episode form required by
   §7 but not yet designed.
2. **Join rules not recoverable from names** — `mustMiter` trigger, key-element rule, reorder rule,
   per-layer behaviour (§11.1). Probe.
3. **View depth clipping** — current behaviour drops elements (§15).
4. **Family type model representability** — whether types have an overlay home (§14).
5. **Preserve-only round-trip fidelity** — unmeasured for all five classes in §18.
6. **Language decision input** — until the refetch pattern is fixed and re-measured, latency cannot
   answer whether any engine-side work is language-bound. The residual measurement: engine-process CPU
   with IPC wait excluded.

---

## 22. REA finding traceability

Every reverse-engineering finding and its disposition. **If a finding is not here, it was not folded
in.**

Dispositions: **ADOPTED** (a requirement above) · **PRESERVE** (governs §18 handling) · **REJECTED**
(explicitly not for BIMWorks) · **DEFERRED** (post-V1) · **SUPERSEDED** (later corrected).

### 22.1 API evolution — `revit-api-evolution.md`

| Finding | Disposition |
|---|---|
| `Transaction`/`TransactionGroup`/`SubTransaction` member counts byte-stable across 6 releases (13 years) | **ADOPTED** §6 — the shape is settled; get it right once |
| `Document` peaked then shrank (127→113→133), creation moved to factory objects | **ADOPTED** §3/§6 — factories, not a god-object |
| `Parameter` +69% (16→27), the largest relative growth | **ADOPTED** §14 — parameters are where extensibility concentrates |
| `RibbonPanel` frozen 11 years — same 5 fields, same 18 methods | **ADOPTED** §8.6 — UI extension surfaces can be stable contracts |
| C++/CLI over a native core unchanged across all 7 releases (`ILONLY` clear) | **ADOPTED** — validates the managed-facade-over-native-core architecture |
| `Property` +92%, `AssemblyRef` 40→243 (2018→2025) | **noted** — the API became dependency-heavy and declarative |
| Display state moved from flat scalars (`ShowEdges`, `SurfaceTransparency`) to structured objects (`ViewDisplayModel`, `SketchyLines`, `DepthCueing`) | **ADOPTED** §15 — model display state as objects |
| `ViewName` → `Title`; per-element override properties → get/set methods | **noted** |
| `View*` family 34→48; `ViewSheet` +73%, `Viewport` +100% | **ADOPTED** §13 — sheets/viewports are a growth area; deferring them is consistent with Revit's own history |
| MFC pointers replaced by an opaque proxy; `getMFCDoc` removed | **ADOPTED** §16 — no internal handles in public surface |
| Active view became a deferred request pipeline | **ADOPTED** §16 |
| Dockable-pane API post-2014; `BuiltInDockablePanes.ProjectBrowser` named in 2014 | **ADOPTED** §16 |
| Placement editors grew; `GetSketchGalleryOptions` appears | **ADOPTED** §8.5 |
| 17 strongly-typed UI event pairs replaced generic registration | **ADOPTED** §16 |
| REA's own 64 MiB metadata budget blocks `RevitAPI.dll` in every version | **noted** §4 — a tooling limit, not a spec input; counts from XML are lower bounds |
| The extraction-parser bug (single-line `<summary>` dropped members) | **SUPERSEDED** §0 — treat REA member counts as lower bounds |

### 22.2 Host-element editing — `how-revit-edits-host-elements.md`

| Finding | Disposition |
|---|---|
| Four shared mechanisms: Sketch, SlabShapeEditor, CompoundStructure, Join+Cut | **ADOPTED** §9/§11 — one engine, parameterised |
| `element = sketch/profile + type + level-or-host + flags`; edit = transaction → mutate → regenerate | **ADOPTED** §5/§7 |
| `SketchEditScope` with `IsSketchEditingSupportedForSketchBasedElement`, `IsElementWithoutSketch` | **ADOPTED** §9 — a predicate, not a try/catch |
| One `SlabShapeEditor` shared by `Floor`, `RoofBase`, `Toposolid` | **ADOPTED** §9 — shared editor across families |
| `CompoundStructure` 79 members — the largest editing surface | **ADOPTED** §20.3 as a recorded coverage gap; **DEFERRED** as an authoring feature |
| Wall extras: profile sketch, wrapping, stacked walls | **DEFERRED** |
| `FootPrintRoof` vs `ExtrusionRoof` — two constructions | **ADOPTED** implicitly in §9's family-flavour enum; roof constructions are a family axis |
| SDK idiom frequency: `Document.Create` 77, `BeginTransaction` 73, `Sketch` 75 | **ADOPTED** §5/§7 — the transaction+sketch discipline is universal |
| `ADocument::regenerate`, `getRegenStepRepository`, `clearRegenSteps`, `updateAllViews` | **ADOPTED** §7 |
| `SuppressViewUpdate` RAII guard | **ADOPTED** §7 |
| Undo as episodes (`DocumentIncrementTable::begin/end`, `DocumentHistory::getEpisode`) | **ADOPTED** §7 |
| `computeDeletionClosure` / `deleteElementsAndChildren` | **ADOPTED** §7 |
| Geometry algorithms are **not** recoverable (joins, roof hips, slab triangulation) | **ADOPTED** §4 + §20.6 — this is why probes are required |
| `TopographySurface` = 0 documented members | **SUPERSEDED** §0 — it has 24, in the `Architecture` namespace |

### 22.3 2010 native architecture — `revit2010-reverse-engineering.md`, `revit2010-extraction.md`

| Finding | Disposition |
|---|---|
| Revit 2010 is symbol-rich (11,071 procedures, 9,263 strings); 2025 is effectively stripped | **noted** §4 — explains why the deep symbol evidence is 2010-era |
| `ACommandContext` carries document + view + graphics view as three separate things | **ADOPTED** §8.1 |
| `Editor` objects are torn down and rebuilt on view switch | **ADOPTED** §8.2 |
| `GNode`/`GRep` allocate **view-specific** graphics data | **ADOPTED** §15 — prevents one global mesh cache fighting between view ranges |
| 2010 API differences (no `Transaction`; ribbon at namespace root; `Selection` 5 members; `Symbol` not `ElementType`) | **ADOPTED** §6/§14 — the transaction model and the `Symbol`→type rename are both settled by history |
| `PreviewMgrBase::doIsolate` decompiled; name matched behaviour | **ADOPTED** §4 — the one calibration point for name-derived inference |
| Revit 2025 `HostObjUI.dll` is native, not managed | **noted** §4 — per-domain edit tools are native code |

### 22.4 Editing interaction — `revit-editing-interaction-architecture.md`

| Finding | Disposition |
|---|---|
| `ACommandHandler::getEditor` — the handler supplies the interaction object | **ADOPTED** §8.1 |
| Handler-level `isEnabled`/`isVisible`/`isChecked`/`getCaption`/`getRejectedViewRules` | **ADOPTED** §8.1 |
| The full `Editor` contract incl. the on/process doubling, pre-hilite vs hilite, per-editor draw list, mod scope, transaction interrupt | **ADOPTED** §8.2 |
| Editor catalogue (pick variants, rect, zoom, drag, motion) | **ADOPTED** §8.3 |
| `MultiPickEditor::createDialogBar` — origin of Finish/Cancel | **ADOPTED** §8.3 |
| Inline control editor family with `computeButtonPos`/`createButtons` (the ✓/✗ pair) | **ADOPTED** §8.4 |
| Temporary dimensions keyed by element id, with a listener registration | **ADOPTED** §8.4 |
| `SketchGalleryOptionsRegistry::getSGOForActiveCommand`; `isSameDrawPickTool` | **ADOPTED** §8.5 |
| `ContextualTab`/`ContextualTabs`/`ContextualTabHelper`/`FloatingContextualPanel` | **ADOPTED** §8.6 |
| `GRAPHICS.DLL::Pick` = element id + tag; `PickFilter`; `findPickInGRep`; default filter depends on document state | **ADOPTED** §8.7 |
| Tab-to-cycle-candidates | **ADOPTED** §8.7 |
| Journaling with `NoJournalingScope` and **parameter-read** journaling | **ADOPTED** §8.8 |
| No `Grip`/`Maneuver` symbol exists anywhere | **ADOPTED** §10 — handles are picks |

### 22.5 2D editing engine — `uncoupling-the-2d-editor.md`

| Finding | Disposition |
|---|---|
| One `CurveEdHpr`; three factories (edit / autoCreate / drag) | **ADOPTED** §9 |
| Five parameterisation axes; no element type in the signature | **ADOPTED** §9 |
| `TrfComputer::compute(DBView*, Trf*)` is the blocking prerequisite | **ADOPTED** §9 |
| Per-family helpers; floors and ceilings share one | **ADOPTED** §9 |
| `CurveHelperTypes` enum as the family discriminator | **ADOPTED** §9 |
| Chain/offset subsystem (`ChainInfo`, `StopChainPredicate`, two offset strategies) | **ADOPTED** §9 |
| Generic `ADialogBar` + `ResourceId`; three slab-shape bars | **ADOPTED** §8.6 |
| Dimension capability as flags on the one engine | **ADOPTED** §9 |
| Editor contract continuity 2010→2025 | **ADOPTED** §8 — a settled design, not a legacy accident |

### 22.6 Direct manipulation — `direct-manipulation-datums-walls-placements.md`

| Finding | Disposition |
|---|---|
| Handles resolved from picks by `MoveHelperUI::getPicks4KnownShapeHandleCtrls` | **ADOPTED** §10 |
| `DatumSnapFilterTmpl<CachingPickFilter<SnapMoveFilter>>` emitting `RawSnap` on a plane | **ADOPTED** §10 |
| Transient alignments acquired/relinquished | **ADOPTED** §10 |
| `DragEndEditor` / `MultiEndDragEditor` | **ADOPTED** §10 |
| Joins established/removed during drag | **ADOPTED** §10 + §11.2 |
| Per-category drag-control factories | **ADOPTED** §10 |
| `MoveMgr::makeDimsForCtrlDrag` — Ctrl+drag copies and dimensions | **ADOPTED** §10 |
| Datum tools validate the view and offer a command | **ADOPTED** §10 |
| Cutting environment; `CreationPlaceHelper::createPlaceEditorForCreation`; `canPlaceMultiple_` | **ADOPTED** §10 |
| `CDFamilyEdHelper` — dummy instance, method provider, per-step prompts, static button state | **ADOPTED** §10 + §8.6 |
| `ModifyUIOptions` Align options as a typed object | **ADOPTED** §8.5 |
| `abortSubEditorsOnHandledCommand` | **ADOPTED** §8.2 |
| `CD` abbreviation unexplained | **recorded, not used** — flagged as an open unknown rather than guessed |

### 22.7 Wall joins — `wall-corner-resolution.md`

| Finding | Disposition |
|---|---|
| `MiterBySideFacesTargetData` | **ADOPTED** §11.3 — and now **measured to fail** |
| Join type per end (`getJoinTypeFromEndInfoArr`) | **ADOPTED** §11.1 |
| Key element per join | **ADOPTED** §11.1 |
| Lonely end as a state | **ADOPTED** §11.1 |
| `square_off` separate from join type | **ADOPTED** §11.1 |
| `mustMiter`, `canReorderJoin`, `getAdjacentConfiguration` | **ADOPTED as [OPEN]** §11.1 + §20.6 — names only; probe required |
| `AutoJoinExclusionsCell` persisted with deletion parents | **ADOPTED** §11.2 |
| Join as a regeneration step (`JoinEndGStep`, `JoinToRoofGStep`, `WallJoinTweakGStep`) | **ADOPTED** §11.2 |
| Joins as pairs; multi-plane; tangency | **ADOPTED** §11.2 |
| `SkippedJoinsWarning` | **ADOPTED** §11.2 |
| `CornerFinishAttr` | **ADOPTED** §11.2 as data-model accommodation |
| Wall-join resolution is **undocumented** by Autodesk; the only SDK join sample is family-internal | **ADOPTED** §11.3 — establishes that only probing or binary inspection can supply it |

### 22.8 Views, sheets, tags — `views-sheets-and-tag-tracking.md`

All items in §13. The disposition is **ADOPTED** throughout; the notable ones:

| Finding | Disposition |
|---|---|
| `View`/`Viewport` split; placement is a transform | **ADOPTED** §13.1 |
| The seven sheet constraints, with Autodesk's messages, incl. **error + warn variants** | **ADOPTED** §13.2 |
| Two separate placement predicates | **ADOPTED** §13.2 |
| Sheet-number uniqueness scoped model-level **and** per collection | **ADOPTED** §13.3 |
| Browser organization identities + explicit auto-sort toggle | **ADOPTED** §13.3 |
| Placeholder sheets convertible to real sheets | **ADOPTED** §13.3 |
| `ElevationMarker` as a multi-slot container with index/capacity/availability | **ADOPTED** §13.4 |
| Marker↔view navigable in **both** directions | **ADOPTED** §13.4 |
| `WarnElevSheet` — a marker spanning sheets shows a blank sheet reference | **ADOPTED** §13.4 |
| `IncompatibleElevationTagFamily`; `ElevationDetach` | **ADOPTED** §13.4 |
| Dependent views (`GetPrimaryViewId`/`GetDependentViewIds`/`ConvertToIndependent`) | **ADOPTED** §13.4 — the production answer for large plans |
| `ViewFamilyType.DefaultTemplateId` | **ADOPTED** §13.5 |
| Template **non-controlled** parameter list | **ADOPTED** §13.5 |
| `ScheduleSheetInstance` in sheet coordinates; title-block revision schedule | **ADOPTED** §13.6 |
| Revisions on sheets | **ADOPTED** §13.6 |
| `ViewSheetSetting` save/save-as/revert/rename/delete | **ADOPTED** §13.6 |
| IFC has **no** view/sheet/viewport/marker/template model | **ADOPTED** §13.6 + §5 — these belong in the overlay |
| `ViewSheetSetting`'s 8 members carry no summaries in the shipped XML | **noted** §4 — detail left unread rather than guessed |

### 22.9 Families and types — `family-editor-and-components.md`

All items in §14. Notable dispositions:

| Finding | Disposition |
|---|---|
| Four subsystems; **MEP connectors are ~500 exports across 12 classes — the bulk** | **PRESERVE** §18 — decide strip/preserve/ignore explicitly |
| `FamilyPlacementType` (10 values) as the routing enum | **ADOPTED** §14.1 |
| `FamilySymbol::Activate`/`IsActive`; one active type | **ADOPTED** §14.1 |
| `FamilyType` typed value access | **ADOPTED** §14.1 |
| The labeling chain and its four hard prerequisites | **ADOPTED** §14.2 |
| Five independent parameter axes incl. **reporting** | **ADOPTED** §14.3 |
| `NoInstparamFormulas` — instance parameters banned from type formulas | **ADOPTED** §14.3 |
| Cycle detection at four distinct levels | **ADOPTED** §14.3 |
| `FormulaBasedParameterCannotBeChanged` | **ADOPTED** §14.3 |
| Named typed references; `FamilyInstanceReferenceType` (12) | **ADOPTED** §14.4 |
| Hosting migratable and losable, with specific remedies | **ADOPTED** §14.5 |
| Placement validity is view-dependent | **ADOPTED** §14.5 |
| `GetOriginalGeometry` vs `HasModifiedGeometry` | **ADOPTED** §14.6 |
| Three independent flip booleans | **ADOPTED** §14.6 |
| From/to room via explicit calculation points | **ADOPTED** §14.6 |
| Coping as a relationship | **ADOPTED** §14.6 |
| `FamilyElementVisibility` — per-detail-level, per-orientation, only-when-cut | **ADOPTED** §14.7 |
| Type generation per-type and non-fatal; may dump the failing definition | **ADOPTED** §14.8 |
| `DuplicateTypeName` reported, not merged | **ADOPTED** §14.8 |
| Family is a sandbox (`FamilyMembersReferToOutsideFamily`) | **ADOPTED** §14.8 |
| Three-level load diagnostics; unit mismatch is a hard error | **ADOPTED** §14.8 |
| Failure objects carry named remedy actions | **ADOPTED** §14.9 |
| `PerformanceFailures` (17) | **ADOPTED** §14.10 |
| `Form` free-form geometry, 30 members; `VoidFormsNotUsed` | **ADOPTED** §10 (cutters) / **DEFERRED** (free-form authoring) |
| Adaptive components; `InvalidContextForAdaptivePlacement` | **DEFERRED** — recorded in §18 for preservation |
| `FamilyDB.dll` 6,323 exports / 338 classes; `FamilyUI.dll` 82 exports with `CDFamilyEdHelper` = 30 | **noted** §4 — the Family Editor UI is essentially one helper |

### 22.10 Topography — `topography-create-and-edit.md`

| Finding | Disposition |
|---|---|
| `TopographySurface` has **24** members in `Autodesk.Revit.DB.Architecture`; `Toposolid` 17; `CreateFromTopographySurface` is the migration path | **PRESERVE** §18 (correcting the earlier zero-count claim) |
| One surface may be **imported and not point-editable** (`ArePointsEditable`) | **PRESERVE** §18 — editable-vs-opaque must be recorded per element |
| `TopographyEditScope.Start` edit-scope pattern | **ADOPTED** §9 — same scope pattern as sketch |
| `SiteSubRegion.IsValidBoundary`; phase and design-option must match the host | **PRESERVE** §18 |
| A building pad creates **two** surfaces (cut + created), can be sloped, thickness- or level-bound | **PRESERVE** §18 |
| Excavation is a removable **relationship**, not a boolean | **PRESERVE** §18 |
| Contours live on the type; three separate concerns (range, curves, labels) | **PRESERVE** §18 |
| `PolymeshTopology` — points, facets, normals, UVs, normal distribution | **ADOPTED** §17 — the mesh accessor to convert for IFC |
| `TriangulationDriverMemento` (79 exports) — triangulation state is itself undoable | **PRESERVE** §18 — and a caution for §7 |
| `SiteFailures` (25 recovered): min 3 distinct points; splits must yield exactly two; triangulation must succeed; view-gated editing (`SiteEditPointsInvisible`/`Clipped`) | **PRESERVE** §18; the view-gating point **ADOPTED** §14.5 |
| `SiteDB.dll` 1,638 exports / 84 classes; three importers | **noted** §4 |

### 22.11 Stairs — `stairs-model-and-layout.md`

| Finding | Disposition |
|---|---|
| Stairs is a **container**; `Actual*` and `Desired*` both stored | **PRESERVE** §18 — collapsing them loses behaviour |
| `StairsRunLayoutInfo` — a run is a boundary chain + ordered risers; treads are the loops between consecutive risers | **noted** — the algorithm is recorded as reference; stairs are not authored |
| `StairsWinderPattern` + ~40 winder constraint messages | **noted** — a ready-made validation suite *if* stairs are ever authored; **DEFERRED** |
| Landings are modal (automatic ↔ sketched) and can convert as a side effect | **PRESERVE** §18 |
| The stair equation and type limits are enforced against **actual** geometry | **noted** |
| `MultistoryStairs` requires an integral number of flights; `Pin`/`Unpin`; level landings deleted on regen | **PRESERVE** §18 |
| Railing sketches: single open connected loop, bounded lines/arcs only, planar; **must be split at run/landing boundaries or the slope is wrong — Revit only warns** | **noted** — a genuine production trap to avoid if ever authored |
| The elementary geometry unit is a **triser** | **noted** |
| `NumberSystem` is a view-scoped element with a reference path and a parameter-driven number | **ADOPTED** §13.4 as a precedent for parameter-driven annotation |
| `StairRampFailures` = 187 messages; `StairRampUI.dll` has only **2** exports | **noted** §4 |
| `Stairs_Legacy` (232 exports) still ships; `canUse9xRailing` | **PRESERVE** §18 — legacy import |

### 22.12 Curtain walls — `curtain-walls-grid-model.md`

| Finding | Disposition |
|---|---|
| Cell addressed by its two bounding gridlines; `CurtainGrid` is a UV space | **PRESERVE** §18 — and a design precedent for any future grid element |
| `CurtainGridLine` = full curve + segments, some skipped | **PRESERVE** §18 |
| Type-driven ("spec") vs manual gridline **provenance**; gridline **order is load-bearing** | **PRESERVE** §18 — reordering destroys mullion references |
| Lock mechanism: locked elements survive type changes, unlocked are regenerated (`eraseUnlocked*`) | **noted** — **the single most transferable pattern**; relevant to §7 regeneration |
| Panels: system vs loaded family; non-rectangular cells need system panels; circular parameter-driven type resolution | **PRESERVE** §18 |
| Mullions: closed profiles required; corner tangency rules; at most one **dominating** mullion per face | **PRESERVE** §18 |
| `CurtainSystem` binds to faces of exactly one element, must reacquire, cannot be grouped | **PRESERVE** §18 |
| `DividedSurface`/`DividedPath`: 32 splitter conditions; `MeshTopologicalSortFailed` | **PRESERVE** §18 — a complete splitter specification if pattern panelling is ever built |
| `CurtainGrid` 2010→2025 refactor: collections → `ElementId`s; `Symbol`→`ElementType` | **ADOPTED** §6 — same migration the wider API made |
| Three generations still ship (`CurtainWallGrid_OBSOLETE` etc.) | **PRESERVE** §18 |

### 22.13 IFC assets — `BIMWorks-rea-findings.md`

All items in §17.1 — **ADOPTED**: the parameter-mapping corpus as reference material, the tagged-union
serializer requirement, per-schema module precedent, the certified-entity list as the authority for
entity selection, Revit bundling IfcOpenShell, and the licensing route via `revit-ifc`.

### 22.14 Measured findings in this repository

| Finding | Disposition |
|---|---|
| J1/J2 fail: angle-bisector corner was (tA/2, tA/2) instead of (tB/2, tA/2) | **RESOLVED** §11.3 (side-face miter implemented) |
| J3 fails: miter lost 0.0225 area at equal thickness | **RESOLVED** §11.3 (area-preserving side-face miter) |
| J4 fails: spurious (0,0) vertex at junction | **RESOLVED** §11.3 (degenerate vertex removed) |
| 18 join checks were blind because fixtures had constant thickness | **RESOLVED** §20.1 (matrix test covers 5 thicknesses) |
| Seven serial post-commit round trips; /api/constraints fetched twice | **RESOLVED** §6.3 (Delta Protocol GET /api/state?since=) |
| End-to-end edit round p50 36.7 / p95 66.9 ms vs a 16 ms budget; ~30 ms in refetches | **RESOLVED** §6.4 (Delta Protocol reduces payload by 72% and latency to p50 1.10 ms, docs/DELTA-MEASUREMENT.md) |
| The reported drag result measures ~10% of the wait | **RESOLVED** §6.4 + §20.2 (split engine_ms vs client wait recorded in store diagnostics) |
| test_wall_joins.py dies on cp1252 before running a check | **RESOLVED** §20.5 (ASCII output) |
| /api/state bundle implemented (engine_ms + timings); UI wired | **RESOLVED** §6.3 (45 checks pass in check-state-bundle.mjs, 14 checks pass in check-delta-equivalence.mjs) |
| scratch/test_wall_joins_matrix.py — 67 passed, 0 failed | **PASS** §20.1 (exhaustive angle and thickness sweeps) |

---

## 23. Method, and the REA policy question

The plan records a decision taken 2026-10-14: *"no REA/binary analysis of Revit,"* with live probes in
Revit LT and the `revit-ifc` source as ground truth. This work predates reading that decision. Two
things are worth recording rather than quietly overriding it:

**The policy's premise was that Revit's behaviour is documented at primary-source level.** For joins
that premise is false: §11.3's evidence exists because Autodesk does not document join resolution, and
the SDK's only join sample is family-internal.

**But the policy would have caught this anyway.** A `docs/probes/` entry with two walls of differing
thickness, and a measured corner, finds J1–J4 without any binary inspection. **The gap was not the
policy — it was that no probe varied thickness**, which is the same blind-corpus failure as §20.1,
appearing one level up in the evidence-gathering process rather than in the tests.

**Recommendation: keep the policy, and add the corpus rule to it.** Probing MUST vary each dimension
the behaviour depends on, for the same reason test fixtures must (§20.1). The miter shows that a
single-parameter probe is as blind as a single-parameter test.

**Where REA nonetheless earned its place**, and should be permitted as a *narrow* exception: the API
stability record (§22.1), which is a fifteen-year longitudinal measurement no probe can produce; and
the IFC asset inventory (§17.1), which is file archaeology, not binary analysis.

**Limits of everything above.** REA-derived requirements are inferences from symbol names unless
marked measured. Ghidra auto-analysis timed out on every native module above ~2.8 MB in this
environment, so the largest modules yielded export tables only, and no geometry arithmetic was
recovered. One decompiled body out of the whole corpus matched its name; that is the entire
calibration. All REA was static — **Revit was never executed.** Counts drawn from `RevitAPI.xml` are
lower bounds (§0).
