# Revit: the dimension as a modelling control — mechanism and adoptability

**Method.** REA 6.5.0 against the shipped Revit 2027 binaries (`C:\Program Files\Autodesk\Revit 2027`,
`27.0.10.13`, product `20260330_1515(x64)`), cross-read against the normative BIMWorks spec and the
existing audit. Revit 2027's C++ symbols are **present**, so function signatures below are observed from
the artifact, not guessed.

**Evidence anchors (REA).**

| Artifact | SHA-256 | Evidence |
|---|---|---|
| `RevitAPI.dll` (33.99 MB, `mixed-clr-native`, ILONLY clear) | `bb4a5b3dec…521cb89` | `ev_95d63a6ff7287758…` (identity/summary), `ev_ef552547a0352b12…` (members) |
| `RevitDBCore.dll` (559 KB, pure native, no CLI metadata) | `75c4be660f0cffe6…fabfde0f` | `ev_eadc3e9c6867ddb0…` (overview), `ev_20fb759cff2e7eaf…` (search) |

---

## 1. The finding in one paragraph

A Revit dimension is not annotation. It is a **constraint element**: a document object that owns an
ordered array of *witness references* (stable pointers into geometry — a face, an edge, a plane, a grid
line, a level, a reference plane) plus a value, and it participates in a constraint system that is solved
during regeneration. The view only supplies the plane and the projection in which it is drawn. Changing
the number changes the value of a constraint, which the solver propagates into geometry; *locking* a
dimension means promoting it from a resolved consequence into a **driving** one. Equality (`EQ`) is a
relation *across* a dimension's segments, anchored at a user-chosen segment. Labeling a dimension attaches
it to a parameter so the parameter drives geometry. All of this is one mechanism with different switches.

BIMWorks already embeds a comparable solver (`planegcs` — PlaneGCS, the same Newton/gradient least-squares
family Revit uses) but applies it to a **detached 1-D model** with only three constraint types, while
dimensions are *renderer output* with `guid: None`. The gap is not the solver. It is that **BIMWorks has no
dimension object**, and therefore nothing for the solver to drive.

---

## 2. The object model (observed)

### 2.1 Dimension is a constraint element

From the Revit 2027 native symbol tables in `EssentialsDB.dll`:

```
DimWithSegRefs                    ← the linear/aligned dimension AND its constraint state
RadialConstraint                  ← radial/diameter/arc-length dimension as a constraint
DimWithSegRefsRegenHelper
RadialConstraintRegenHelper
DimWithSegRefsRefLength
```

`DimWithSegRefs` carries the constraint bookkeeping directly:

```
?allowEqControls@DimWithSegRefs@@UEBA_NXZ
?isEqConstrDone@DimWithSegRefs@@IEBA_NXZ          ?setEqConstrDone@DimWithSegRefs@@IEAAX_N@Z
?needsEqAnchor@DimWithSegRefs@@QEBA_N..."
?getEqAnchorIdx@DimWithSegRefs@@QEBAHXZ          ?setUserEqAnchorIdx@DimWithSegRefs@@QEAAXH@Z
?isPossibleEqAnchor@DimWithSegRefs@@QEBA_NH@Z
?toggleSegmentsEqual@DimWithSegRefs@@QEAA?AW4Err@@AEAVElementEvaluator@@PEAVADocument@@@Z
?toggleEqualRefConstraints@DimWithSegRefs@@UEAAXPEAVADocument@@@Z
?getLockedConstrDone@DimWithSegRefs@@IEBAAEBV?$Arr@_N@@XZ   ← per-reference lock flags
?getLastFixedIdx@DimWithSegRefs@@QEBAHXZ
?getRefConstrStatus@DimWithSegRefs@@UEBA?AW4Status@RefConstrStatus@@AEAVElementEvaluator@@HH@Z
?setRefConstrStatus@DimWithSegRefs@@QEAAXAEAVElementEvaluator@@HHW4Status@RefConstrStatus@@@Z
?allowLengthControl@DimWithSegRefs@@UEBA_NAEAVElementEvaluator@@PEAVADocument@@HAEAV?$Arr@VAtom@@@@AEBV?$Arr@PEAVPick@@@@@Z
?addElemWitnessRef / ?addGeomWitnessRef / ?addGenericWitnessRef / ?addWitnessRefUtility
?getWitnessRefs / ?getUnsortedWitnessRefs / ?sortReferences
?countWitnessRefs / ?getMinNumWitnessRefs
```

The witness-reference vocabulary (`WitnessRefInfo`, `WitnessRefId`, `WitnessRefInfoModel`,
`WitnessRefInfoLazy`, `DimSegInfo`, `DimSegInfoModel`, `DimSegInfoLazy`, `WitnessRefOp::getWitnessRef<T>`)
is the **typed handle onto model geometry**. Segment-to-reference mapping is positional and is stated
normatively in the shipped API docs: *"The first segment here wrapped by first and second references; the
nth segment is wrapped by nth and n+1st references."* (`Dimension.Segments` remark, Revit 2027 `RevitAPI.xml`).

### 2.2 The datum is a first-class constraint target

`DatumPlane` (base of `Level`, `Grid`, `ReferencePlane`) implements the same self-dimensioning interface as
`Element`:

```
?createSelfDims@DatumPlane@@UEBA?AW4Err@@PEAVADocument@@PEBVPick@@VElementId@@W4ViewType@@PEBVGView@@PEAV?$OwnerArr@VDimension@@@@PEAV?$Arr@VElementId@@@@@Z
?createSelfDims@Element@@UEBA?AW4Err@@…            (same signature)
?createSelfDimsMultiplePicks@Element@@UEBA?AW4Err@@…
?getRefsToDimensionFrom@DatumPlane@@UEBA?AW4Err@@_NPEBVPick@@PEAV?$Arr@VTempDimData@@@@@Z
?getRefsToDimensionFrom@Element@@UEBA?AW4Err@@…
?getUnderlyingRefPlane@DatumPlane@@UEBA?AW4Err@@AEBVSegInPlaneRef@@…
?getPlaneReference()   ← public API: Level.GetPlaneReference / Grid.GetPlaneReference
```

So *every* element can enumerate the references a dimension may attach to, and a datum is just another
element that does so. This is the single most important structural idea for BIMWorks: **a datum is not a
special constraint kind — it is a legitimate dimension witness.** The same dimension machinery that
constrains two wall faces constrains a wall face to a level or grid line. There is no separate
"lock to level" subsystem.

### 2.3 Equality is a relation over segments, not per-dimension

`DimEqSegInfoArr`, `DimEqualControl`, `DimensionsEqualityFormulaToValueUpgrader`,
`DimensionsLazyEqualityFormulaUpgrader`, `DimSegLockControlStrategy`, `LockControlStrategy`. `EQ` is
therefore a *policy over the ordered reference array* with an anchor segment (`getEqAnchorIdx`), which is
exactly why the API can say a linear dimension with >1 segment may have `AreSegmentsEqual` while a
single-segment one cannot.

### 2.4 Lock, EQ and label are three bindings on **one** slot

The sharpest evidence is a failure message. `BuiltInFailures.ConstraintFailures` (2027 `RevitAPI.xml`):

| Member | Message (verbatim) |
|---|---|
| `UndeletedConstraints` | *"A dimension that has **lock constraints** is being deleted, but **the elements will still be constrained**. Push \"Unconstrain\"…"* |
| `UndeletedConstraintsEQ` | *"A dimension that has **EQ constraints** is being deleted, but the elements will still be constrained."* |
| `UndeletedConstraintsLabel` | *"A dimension **labeled by a parameter** is being deleted, but the elements will still be constrained."* |

**The constraint outlives the dimension element.** The dimension is an anchor/UI object; the constraint is a
separate native entity the managed API does not model — which is exactly why only a boolean is exposed and
why deleting a dimension prompts to *unconstrain* rather than being a simple delete.

Read that way, **lock**, **EQ** and **label** are three mutually-transformable bindings of the same
constraint slot:

- **lock** → the dimension drives geometry to a literal value;
- **label** → the dimension is driven by (or reports into) a parameter instead;
- **EQ** → the relation is over the segment set, not the endpoints.

This *explains* the restriction the docs state rather than merely recording it:

> `Dimension.IsLocked` — *"This property always returns false if the dimension is a radial or spot
> dimension. This property cannot be set if the dimension has been labeled, or if the dimension shape is
> arc-length, radial, diameter or spot, or if the dimension is linear with more than one segment."*

A labeled dimension is *already* driving through its parameter, and a multi-segment dimension carries the
`EQ`/anchor structure instead, so there is **no free boolean** to set. Lock and label are mutually
exclusive because they occupy the same binding.

### 2.5 Disambiguation — three unrelated things called "lock"

| Mechanism | API / native symbol | Meaning |
|---|---|---|
| **Pin an element** | `Element.Pinned`; native `Element.canBeLocked` / `isLocked` / `setLockedForAPI` / `?isLockedBySharedPositioning_@Element` | the element cannot be moved at all — *not* a dimensional constraint |
| **Lock a dimension (make it drive)** | `Dimension.IsLocked` / `DimensionSegment.IsLocked`; native `DimSegLockControlStrategy`, `LockControlStrategy`, `getLockedConstrDone`, `LockOverconstrained` | the dimension's value is imposed on geometry |
| **Mullion / curtain-grid lock** | `Mullion.Lock`, `CurtainGridLine.Lock` | a *provenance* flag (regenerate-if-unlocked) |

There is no `Element.IsLocked` and no `Constraint` class in the managed API. The whole public surface for
the second mechanism is a boolean per dimension/segment.

### 2.6 Alignment is born locked, and it is the same machinery

`ItemFactoryBase.NewAlignment(View, Reference, Reference)` — doc verbatim: *"Add a new **locked alignment**
into the Autodesk Revit document."* Legal combinations: *"2 planar faces, **planar face and reference
plane**, 2 lines, line and point, **line and reference plane**, 2 arcs, 2 cylindrical faces. These
references must be **already geometrically aligned** (this function will not force them to become
aligned)."*

Two things follow. **(i)** There is no separate "constraint object" to create: you assert that two existing
references are aligned and declare that relationship locked. **(ii)** Revit *broadened* the legal reference
combinations after 2010 — the 2010 member omits "planar face and reference plane" and "line and reference
plane". Datum-as-lock-target was a deliberate, later widening.

Equally important: **no creation factory anywhere takes a value.** `NewDimension(View, Line,
ReferenceArray[, DimensionType])` and the radial/angular/arc-length siblings define the constraint from the
argument list; the value is *derived* at creation and only afterwards settable. When BIMWorks adds
`DimensionCreate`, it should create from references — not from a number.

---

## 3. The solver (observed)

`EssentialsDB.dll` contains the solver itself:

```
NewtonSolver
  ??0NewtonSolver@@QEAA@HHHH@Z                       (numVars, numEqs, maxIts, ?)
  ?solve@NewtonSolver@@QEAA?AW4Err@@PEBV?$Arr@N@@PEAV3@1PEAV?$Closure0@W4Err@@@crs@@PEANPEAW4MatrixRankType@@@Z
  ?solveLinearEquationSystem@NewtonSolver@@UEAA?AW4Err@@AEBVMatrix@@AEBV?$Arr@N@@PEAV4@PEAV?$Closure0@W4Err@@@crs@@PEAH@Z
  ?subtractDeltasFromVars@NewtonSolver@@UEAA?AW4Err@@AEBV?$Arr@N@@PEAV3@@Z
  ?setResidualTolerance / ?getNumVars / ?getNumEqs / ?setNumVars / ?setNumEqs / ?setMaxNumIts / ?numIterations

VarSolver                      ← the model that feeds NewtonSolver
VarSketch                      ← the variable sketch (sketch mode AND project-level constraints)
VarSketchGuessCache            ← solution cache
```

The equation system is `VarSketch`, built from typed objects:

**Geometry objects** — `VarSketchPointObj`, `VarSketchLineSegObj`, `VarSketchArcObj`,
`VarSketchEllipseObj`, `VarSketchGenericCurveObj`, `VarSketchCurveObj`.

**Constraint objects** — `VarSketchConstrObj` (base):
`VarSketchDistConstrObj`, `VarSketchAngleConstrObj`, `VarSketchAngDimObj`,
`VarSketchDimDirConstrObj`, `VarSketchPPConstrObj` (point-point), `VarSketchPPDimObj`,
`VarSketchHorVerConstrObj`, `VarSketchSlopeConstrObj`,
`VarSketchLSegParaToLSegConstrObj`, `VarSketchLSegPerpToLSegConstrObj`,
`VarSketchPtOnLSegConstrObj`, `VarSketchPtOnArcConstrObj`, `VarSketchPtOnEllipseConstrObj`,
`VarSketchTangentJoinConstrObj`, `VarSketchArcEndAngleConstrObj`, `VarSketchFixedPointConstrObj`,
`VarSketchRadDimObj`, `VarSketchAngleDiffConstrObj_DEPRECATED`.

**Lifecycle observed in strings** (`EssentialsDB.dll`):

```
Solver contents before substitutions
Solver contents with constraints added
Solver contents after substitutions
Solver result: %d; changedParamValues: %d
Solver result: already solved
Solver result: solution in cache
VarSolverStats: sketch %9I64d, numVars %3d, numEqs %3d, try %3d, solverResult %d, numIterations %d
VarSketchGuessCache for Sketch %I64d: cache size %d x %d
VarSketch %I64d solved to lesser accuracy
Way too many curves and points in VarSketch %I64d; turning autodims off
```

Three properties worth copying:

1. **Idempotence by cache.** "already solved" and "solution in cache" are distinct, reported outcomes. A
   solve whose inputs are unchanged does no work.
2. **Graceful degradation.** A lower-accuracy result is used and *reported* ("solved to lesser
   accuracy"), with `setUseHighResidualTol` and a bounded iteration count rather than a hard failure.
3. **Bounded effort with a real refusal.** Beyond a curve/point budget it stops auto-dimensioning rather
   than stalling.

Over-constraint is a **first-class, named failure with resolution choices**, not an exception:

```
DimensionOverconstrained / DimensionOverconstrainedError
LockOverconstrained / LockOverconstrainedAlignment
LabelOverconstrained
SketchOverconstrained / SketchOverconstrainedWarn / SketchOverconstrainedError
VarSketchFailure / VarSketchInElementFailure
String_Essentials_DimOverconstraint / _LabelOverconstrain / _LockOverconstrain / _LockOverconstrainA
ResolveByUnlabeling                      ← an offered *resolution*
ResolveErrorsIgnoreWarnings
?relaxConstraintsTo@VarSketch@@UEAA?AW4Err@@VElementId@@@Z
```

---

## 4. How a dimension change becomes geometry

The regeneration pipeline (`RevitDB.dll`) is where constraint and geometry meet:

```
ConstraintInfo                     ← document-level constraint record (runtime class, _DataDict, _DDTable)
  ?getConstraintId / ?getDrivingElements / ?getConstrMoveRestrictions
  ?addConstraintInfo@Element@@QEAAXPEAVConstraintInfo@@@Z
  ?getConstraintInfo@Element@@QEBAAEBVConstraintInfo@@H@Z
  ?deleteConstraintInfo@Element@@QEAAXH@Z
  ?addDeletionParents@ConstraintInfo@@…            ← constraint is a dependency-graph node

RegenStep / RegenStepRepository / RegenStepConstr.cpp / RegenStepSketch.cpp
  ?getConstraintStepsForced@RegenHelper@@UEAA_NAEBVAtom@@PEAVRegenStepRepository@@@Z
  ?getConstraintStepsGuessed@RegenHelper@@UEAA_NAEBVAtom@@PEAVRegenStepRepository@@PEA_NH@Z
  RegenerateOptions / RegenDocContext / CircularDependency / CircularDependencyResolved
```

Supporting steps observed by name:
`AssocPropImposeConstraintStep`, `AssocPropChangeConstraintStep`, `MaintainDimDistStep`,
`MaintainDimEqStep`, `RegenSketchSolvedStep`, `createConstraintKickerStep`, `MaintainFixedLevelOffsetRule`,
`MaintainDatumPlanePositionRule`.

Read that as a pipeline:

```
edit (value / drag / parameter)
  → ConstraintInfo is a dependency parent, so the owning elements are marked dirty
  → regeneration asks for constraint steps: Forced (must run) or Guessed (heuristic)
  → MaintainDimDistStep / MaintainDimEqStep rewrite the VarSketch equations
  → VarSolver: substitution → NewtonSolver::solve → cache
  → on failure: a named Overconstrained failure + a Resolution (ResolveByUnlabeling, relax, …)
  → geometry regenerates from solved parameters
```

**The decisive design point:** constraints are *steps in regeneration*, driven by a dependency graph that
already knows the constraint is a parent. Revit does not run a separate "constraint pass" after moving
things — the constraint is one of the things regeneration computes.

### 4.1 Constraint inference is explicit and acknowledged as heuristic

```
DimHeuristicCaptureCallStacks
DimHeuristicEvenIfAllMovesAreEqual          DimHeuristicEvenIfSomeStayed
DimHeuristicMajorityWin                     DimHeuristicMatchOriginWin
DimHeuristicShortestWin                     DimHeuristicStay
GetAppropriateConstraintsOldWay             MemoizeConstraintsOFF / …AggressiveOFF / …TestCache
getConstraintStepsGuessed  (vs Forced)
```

Revit resolves ambiguity about *which* existing constraint a drag should honour with a named, overridable
heuristic set, and it caches the result. It also ships flags to turn the heuristics and the cache off —
i.e. the behaviour is deliberately observable and testable.

---

## 5. Labeling: the parameter on-ramp

`ParamElemGlobal` is the element↔parameter bridge:

```
?labelDimension@ParamElemGlobal@@QEAAXVElementId@@@Z
?unlabelDimension@ParamElemGlobal@@QEAAXVElementId@@@Z
?canLabelDimension@ParamElemGlobal@@QEBA_NVElementId@@@Z
?getLabeledDimensions@ParamElemGlobal@@QEBA?AV?$Set@VElementId@@…@@XZ
?isDrivenByDimension@ParamElemGlobal@@QEBA_NXZ
?setDrivingDimension@ParamElemGlobal@@QEAAXVElementId@@@Z
LabeledDimsAreAlwaysConstraintsSetter        ← a named internal assertion/flag
```

`LabeledDimsAreAlwaysConstraintsSetter` is the mechanism in one symbol: **labeling makes the dimension a
constraint permanently.** This closes the loop that the BIMWorks spec already asks for
(`SPECIFICATION-v0.2.md:652-656`: "sketch → auto-dimension → label → solve").

---

## 6. Cross-view behaviour — the honest answer

The constraint is **model-scoped**; the view is a **lens that reveals it**; the *annotation* is what becomes
view-specific. Observed:

```
TemporaryViewMode.RevealConstraints
  "The view is in the mode that reveals constraints between elements in the model."
View.SupportsRevealConstraints
  activation limited to 3D Views, Area Plans, Ceiling Plans, Detail Views, Drafting Views,
  Elevations, Floor Plans, Sections, Structural Plans
Dimension.AreReferencesAvailable
  "This property always returns true for model dimensions. It can return false for view-specific
   dimensions that can lose their references in certain situations. For example, the host element
   references may not be available when the view containing the dimension is closed."
Dimension.IsValid / Dimension.View      ("if the dimension is view specific")
Reference.ConvertToStableRepresentation / ParseFromStableRepresentation
ConstraintDimViewSpecificityUpgrader
DatumExtentType { Model, ViewSpecific }
DatumPlane.SetDatumExtentType / GetCurvesInView / SetCurveInView / PropagateToViews / GetPropagationViews
DimensionReferenceRecoveryManager / DimRefRecoveryContext / ?resolveWitnessRefsAll
DimensionReferenceRecoveryManager::resolveWitnessRefsSingle(…, const class Dimension *)
```

So there are **two populations of dimension** with different failure modes:
- **model dimensions** — references always resolve, any view;
- **view-specific dimensions** — resolve only while that view's geometry is available.

And the pattern `DatumExtentType { Model, ViewSpecific }` is the *same* "one model fact, N view
representations, explicit per-view override" shape that datums use for their extents. Revit reuses one
concept for both.

**This is why `RevealConstraints` matters more than it looks.** A constraint between model elements is not
owned by any drawing; the mode is how the user *sees* it. BIMWorks has no such mode, and consequently its
`last_constraint_conflict` has nowhere to surface.

The price of the split is `DimensionReferenceRecoveryManager` — a whole subsystem whose job is re-resolving
references when they become unresolvable in a given view. That is what BIMWorks would be tempted to skip,
and it is the reason view-specific dimensions should be deferred (§10.2).

---

## 6a. The reference is a *handle*, and its durability is designed

`Reference` is the single most transferable idea in this entire analysis. Two members define it:

```
Reference.Refresh()
  "After a change has been made to Revit geometry, the stored geometry object in a Reference handle
   may become invalid. This method attempts to re-obtain the geometry object from the current geometry."

Reference.ConvertToStableRepresentation(Document) -> String
  "can be used to preserve and restore the reference later in the same Revit session or even in a
   different session where the same document is present … based on the internal Revit structure and
   is not intended to be parsed except by ParseFromStableRepresentation."
```

Three design commitments fall out, and all three are directly relevant to BIMWorks:

1. **A reference is not a coordinate.** It is a handle into *regenerated* geometry, and it can go stale.
   `Refresh` existing as public API is an admission that staleness is normal, not exceptional.
2. **Identity must survive a session boundary** — hence a serialized stable representation. This is the
   analogue of BIMWorks persisting into `parametric.json` and reloading.
3. **The grammar is deliberately opaque.** Autodesk explicitly says do not parse it. The lesson is not
   "copy the string format"; it is that a reference needs *an* opaque, self-contained, re-resolvable
   serialised form, and that consumers must go through the API rather than reading it.

The target taxonomy is public and small —
`ElementReferenceType { _NONE (element), _LINEAR (curve/edge), _SURFACE (face/region), _FOREIGN (link),
_INSTANCE, _CUT_EDGE, _MESH, _SUBELEMENT }` — which is exactly the "kind" discriminator a BIMWorks
reference would need.

**And the unification is proven in Autodesk's own SDK sample**, not merely inferred from types:
`revit2010/sdk/.../FamilyCreation/WindowWizard/CS/CreateDimension.cs` appends
`refPlane1.Reference`, `refPlane2.Reference`, `refPlane.Reference` (`:77-87`) and, at `:113`, a
`pFace.Reference` from a solid face — **into one `ReferenceArray`**, then calls
`NewDimension(view, line, refArray)` (`:90`). A reference plane, a face and a datum plane are the same
kind of thing to a dimension.

---

## 7. Exposing constraint state to the user

```
RevealConstraints / RevealConstraintsMode / revealConstraintsModeEnabled
DBView.getRevealConstraintsMode / setRevealConstraintsMode / supportsRevealConstraints
TemporaryViewModes.getRevealConstraints / setRevealConstraints
```

"Reveal Constraints" is a *view mode* that renders the constraint graph. Revit treats constraint state as
**inspectable model data with a dedicated display mode**, not as a hidden solver side-effect. Its absence
in BIMWorks is why `last_constraint_conflict` (`ifc_service.py:2157`) is written and read by nothing.

---

## 8. The managed API vs the native mechanism

Observed split.

**Exposed in the managed API** (2027 `RevitAPI.xml`, 143 `DB.Dimension` members):
`Dimension.References`, `Dimension.Segments` / `NumberOfSegments` / `AreSegmentsEqual` /
`HasOneSegment`, `Dimension.Value` / `ValueString` / `ValueOverride`, `Dimension.IsLocked`,
`Dimension.DimensionShape`, `Dimension.View`, `Dimension.Curve`, `Dimension.Origin`,
`Dimension.MultiReferenceAnnotationId`, `DimensionSegment.{Value,ValueString,IsLocked,Origin}`,
`LinearDimension.Create(Document, View, Line, IList<Reference>)`,
`Dimension.GenerateDimensionGeometry(DimensionGeometryOptions)`,
`Reference.ConvertToStableRepresentation` / `ParseFromStableRepresentation`,
`Reference.{ElementId,LinkedElementId,UVPoint,GlobalPoint,ElementReferenceType}`,
`Level.GetPlaneReference`, `Grid.{Curve,IsCurved,GetExtents}`, `DatumPlane.*`.

**Native-only** (present as symbols, no managed surface): the whole `VarSketch`/`NewtonSolver` equation
system; `ConstraintInfo`; the `RegenStep` constraint steps; the constraint heuristics and their caches;
`getConstraintStepsForced/Guessed`; the over-constraint *resolution* set; the witness-ref recovery manager.

**Consequence for a clean-room design:** the *data model* (dimension owns ordered references + a value;
datums expose a plane reference; a label makes it driving) is fully specified by the public API and is
safe to adopt as a contract. The *solver internals* are not exposed, and are also not needed — they are
reproducible engineering, and BIMWorks already carries a suitable solver.

---

## 9. What BIMWorks has, precisely

From the current tree (`backend/`, `src/`):

| Piece | State |
|---|---|
| Solver | `backend/constraint_solver.py` wraps **planegcs** (PlaneGCS) — same Newton least-squares family; `sketch.coincident`, `set_p2p_distance`, `equal_length`, `add_fixed_point` |
| Constraint types | exactly **three**: `align`, `dimension_lock`, `equalize` (`constraint_solver.py:122-131`) |
| Axis coverage | hard-wired to `x`/`y` in practice; `z` unreachable (bus schema `Literal["x","y"]`, `command_bus.py:97`; solve loop `ifc_service.py:2147`) |
| Persistence | overlay `parametric.json` → `constraints` (`ifc_service.py:5144`); **no `dimensions` key** |
| Constraint identity | none. A constraint references element GUIDs only — no *reference into* geometry |
| Solver trigger | only `translate_element(_propagate=True)` → `_solve_constraints_after_move` (`ifc_service.py:2126-2165`) |
| Conflict reporting | `last_constraint_conflict` written (`:2157`), **read nowhere**; no route, no view mode |
| Dimensions | **renderer output.** `_overall_dimensions` emits exactly two per view with `guid: None`, derived by regex over rendered SVG (``ifc_service.py:4650-4703``) |
| Editable dimension | one detached HTML pill measuring **bbox-centre → nearest bbox-centre**; commits a **delta** → `translateElement` → `WallMove`; element length never changes (`useBimStore.ts:988-1046`, `:1087-1098`) |
| EQ entry point | sole caller passes the *same GUID* for both span endpoints (`useBimStore.ts:1261`) ⇒ `spacing = 0` ⇒ targets collapse |
| Datums | levels = membership only (`level_id` + `move_level`); grids are IFC datums usable only as generic align targets; **no level/grid dimension**; levels are never drawn |
| Sketch mode | `sketch_model.py` has **no constraint concept**; coincidence propagates by tolerance (`:157-207`) |
| Spec position | §12 has **no requirement for a dimension object**; overlay list §5 (`:141-143`) names `constraints` but not `dimensions`; §14.2 already demands the `sketch → auto-dimension → label → solve` chain and flags it `[GAP-adjacent]` (`:658-659`) |

The existing audit reached the same conclusion independently and more strongly: *"the work is not 'build a
constraint engine' — it is 'expose the one that exists, give it an identity, and fix the units under it.'"*
(`review/AUDIT-dimension-editing-vs-revit.md:393-394`)

---

## 10. Adoptability: what to take, what to refuse

### 10.1 Take — the five load-bearing ideas

**A. The dimension is a document object owning an ordered reference array.**
```
Dimension { id, refs:[{guid, kind, ordinal, session_hint}], value, view_scope }
```
`ref` is the part BIMWorks lacks everywhere. A reference must be a **handle into regenerated geometry that
can go stale and be repaired** — not a coordinate. Revit's `Reference.Refresh` existing as public API is
the admission that staleness is normal; adopt that posture rather than pretending references are stable.
Concretely: store `(element_guid, kind, ordinal)` plus whatever world point/plane the reference was taken
at, treat the tuple as the *primary* identity, and make the world data a repair hint. The `kind`
discriminator should mirror Revit's public taxonomy, which is already the right shape:
`element | curve_or_edge | face_or_region | instance | link | subelement`.
*This is the change the audit calls "the load-bearing data-model change" (`AUDIT-…:446`).*

**B. A datum is a witness, not a constraint kind.** Do **not** add `lock_to_level` / `lock_to_grid`
types. Add `level` and `grid` as *reference kinds*, and let one dimension type constrain
`wall.face ↔ level.plane`. This collapses three planned features (level dimensions, grid dimensions,
"Base Constraint" data) into one mechanism, and it is proven rather than inferred: Autodesk's own
`CreateDimension.cs:77-90,113` appends reference planes and a solid face into one `ReferenceArray`, and
`DatumPlane` and `Element` share the `createSelfDims` signature.

**C. Dimensions are regeneration steps, not a post-move pass.** BIMWorks currently solves *after* a move
and only from `translate_element` (`ifc_service.py:2126`). Revit's `ConstraintInfo` is a **dependency-graph
parent** (`addDeletionParents`, `getConstraintStepsForced/Guessed`), so an edit dirties the constraint and
regeneration evaluates it. BIMWorks already has the right container — `DependencyGraph.EDGE_KINDS` includes
`"constraint"` (`dependency_graph.py:35`) and `rebuild()` builds those edges (`:71-87`) — but
`recompute()` uses them only for a counter and never for work (`:160-216`; only the `join` pass mutates).
**Wiring the existing `constraint` edge into `recompute()` is a smaller change than it looks and is the
true fix.**

**D. Solve the *reference pair*, not the element.** The audit's §8.3 decision (*"move the face, not the
element"*) is exactly Revit's semantics: `Dimension.Value` sets `MaintainDimDistStep`, which rewrites an
equation between two witness references. Element translation is a *consequence*. BIMWorks' current
`delta → translateElement` is the wrong primitive and is why the value never round-trips
(`AUDIT-…:151-152`).

**E. Over-constraint must name a resolution, not raise.** Revit ships `ResolveByUnlabeling`,
`?relaxConstraintsTo`, and four distinct over-constraint failures with separate messages. BIMWorks has
`status ∈ {success, conflict, failed}` and a write-only field. Adopt the shape: a conflicting set **plus**
at least one offered resolution (`unlabel`, `release lock`, `relax to <id>`), rendered in a **view mode**
analogous to Reveal Constraints. That is the missing half of spec §12 `:517-518`.

### 10.1a Five things Revit's own design tells you to get right

These are not optional polish; each is a rule the shipped product enforces, and each has a cheap
counterpart in BIMWorks' design.

1. **Create from references, never from a value.** No Revit factory takes a number
   (`NewDimension(View, Line, ReferenceArray)`); the value is *derived* at creation. `DimensionCreate`
   must therefore take `{ref_a, ref_b, offset}` — the audit already specifies exactly this
   (`AUDIT-…:417`).
2. **One slot, three bindings, mutually exclusive.** Lock, EQ and label occupy the same constraint slot,
   which is why `Dimension.IsLocked` *cannot be set* when labeled or multi-segment. Model it as one
   binding enum (`literal | parameter | equal`) on the constraint — not as three independent booleans that
   can contradict each other.
3. **The constraint must outlive the dimension.** Revit prompts to *unconstrain* when a dimension is
   deleted because the constraint is a separate entity. So `DimensionValueSet` should mutate the
   **constraint**, and deleting a dimension must be an explicit choice about whether its constraint
   survives. This also fixes the existing dangling-reference defect: `delete_element`
   (`ifc_service.py:1908-1977`) currently prunes nothing, so a deleted wall leaves constraints pointing at
   a dead GUID.
4. **`n` references → `n−1` intervals, positionally.** Revit states the mapping normatively
   (`Dimension.Segments`). A chain is therefore a *reference list*, not a list of independent dimensions —
   which is exactly why the audit says a chain cannot be built before a dimension object exists
   (`AUDIT-…:463`).
5. **Publishing a reference is opt-in.** `FamilyInstance.GetReferences` returns nothing for a reference
   plane whose *"Is Reference"* property is *"Not a Reference"*. A family decides what is dimensionable.
   BIMWorks should likewise let a wall expose (or withhold) its faces, centreline and ends rather than
   making everything implicitly addressable — this is what keeps the reference set small and the solver
   scope bounded (cf. the measured 31-participant blow-up, `AUDIT-engine-performance-vs-revit.md:114-115`).

### 10.2 Refuse — what not to copy

- **The `NewtonSolver`/`VarSketch` internals.** Not exposed, not needed; `planegcs` is a legitimate
  substitute and is already the licence rationale for GPL-3.0.
- **The constraint heuristics on the interactivity path, initially.** `DimHeuristicMajorityWin` /
  `MatchOriginWin` / `ShortestWin` exist to guess intent during ambiguous drags. They only matter once
  drag-driven inference exists; a *selected dimension's value* is unambiguous and needs none of it.
- **Multi-segment `EQ` before single dimensions work.** Revit's own restriction (you cannot set
  `Dimension.IsLocked` on a >1-segment linear dimension) is a warning that the single-segment case is the
  foundation. The audit says the same: *"Do not build a dimension chain with EQ … before change 2 exists —
  a chain is a list of dimensions with shared references, and there is currently no dimension object to
  chain."* (`AUDIT-…:463`)
- **View-specific dimensions initially.** Keep dimension objects model-level with a *display* view. The
  recovery manager `DimensionReferenceRecoveryManager` is the expensive consequence of the split, and it
  is only needed once references can go unresolvable per view.

### 10.3 Do-this-in-order

| # | Change | Why it is gated here |
|---|---|---|
| 0 | Fix the sole EQ caller (`useBimStore.ts:1261` passes the same GUID twice) | one-line correctness bug; `spacing=0` makes EQ look broken when it works |
| 1 | Add `dimensions[]` to the overlay with `{id, ref_a, ref_b, axis, value, offset, view_scope}`; define the **reference** primitive | everything else needs an addressable reference |
| 2 | Extend `Element.get_element_coord` → a real `get_reference(guid, kind, ordinal)` returning a solver-usable point/plane; add `level` and `grid` reference kinds | turns idea **B** on; reuses the existing planegcs wrapper |
| 3 | Add `DimensionCreate{ref_a, ref_b, offset}` and `DimensionValueSet{dimension_id, value}` — the command carries the **value, not a delta** | spec-correct intent; audit §8.2 step 6 |
| 4 | Solve the reference pair: `DimensionValueSet` → `sketch.set_p2p_distance(ref_a, ref_b, value)` and move the *reference*, not the element | idea **D**; makes the value round-trip |
| 5 | Wire the existing `constraint` edge into `DependencyGraph.recompute()` so a constraint is a regeneration step | idea **C**; the container already exists |
| 6 | Surface conflicts: a route for `last_constraint_conflict` + a "reveal constraints" view mode | idea **E**; closes spec §12 `:517-518` |
| 7 | Only then: `EQ` over a multi-segment dimension with an anchor index; then perpendicular/parallel/point-on-line to reach the observed `VarSketchConstrObj` vocabulary | order forced by Revit's own `IsLocked` restriction |

### 10.4 The one structural prerequisite nobody can skip

`ref` must be a *durable* address. Revit needs `DimensionReferenceRecoveryManager` precisely because
geometry can move out from under a witness. BIMWorks' `Reference.Refresh` equivalent does not exist, and
`load_orlt_project` restores constraints **wholesale with no GUID-staleness gating**
(`ifc_service.py:3431`; also recorded at `docs/IMPLEMENTATION-PLAN-2026-10-14.md:55`). Introducing
references into geometry *before* a staleness/repair path exists will convert today's silent
dangling-constraint bug (`delete_element` never prunes constraints, `:1908-1977`) into silent wrong
geometry. Design the reference to be **self-describing and repairable** — store enough to re-resolve
(element + kind + ordinal + the world point/plane it was taken at) — and add the repair step with it.

---

## 11. Residual unknowns

1. **`DBCONSTRAINTTYPEENUM` values.** The symbol is present in `RevitDBAPI.dll`; the enumerator list was
   not recovered. The constraint *taxonomy* above is reconstructed from the solver's own class vocabulary
   (`VarSketchConstrObj` subclasses) and is reliable for the geometric relation set; the persisted
   document enum may differ.
2. **`NewtonSolver` construction arity.** `??0NewtonSolver@@QEAA@HHHH@Z` shows four `int` parameters; the
   semantic names are unconfirmed (candidates: numVars, numEqs, maxIterations, a rank/ordering mode).
3. **Decompiled bodies were not obtained.** `RevitDBCore.dll` is symbol-stripped (its empty procedure
   search is a *coverage limit*, not absence) and the constraint engine's real binaries
   (`EssentialsDB.dll` 23.8 MB, `RevitDB.dll` 46.1 MB) were analysed through their symbol tables and
   strings, not through pseudocode. Every claim above rests on **observed symbol signatures, observed
   string literals, and the shipped API documentation** — not on reconstructed control flow.
   The prior corpus's claim that *"the sketch constraint solver — no symbols or docs expose it"* is
   **half wrong**: no docs expose it, but Revit 2027 ships the symbol names, which is what made this
   analysis possible. What was actually missing was a Ghidra run that completes: the one documented
   success in the corpus was a **1.22 MB** module (`Revit_NT_RevitUI.dll`); attempts at 22.5 MB and the
   2027 23–46 MB modules time out. This is a **tooling-budget gap, not an evidence gap**, and the cheap
   next step is a longer-budget (or non-REA) Ghidra/IDA pass on `EssentialsDB.dll` to reach
   `NewtonSolver::solve`, `VarSketch::regen` and `DimWithSegRefs::changeDim` bodies. Note the REA
   provider itself cannot be widened: it is installed at `N:\rea` (package `rea-agents@6.5.0`) and its
   64 MiB metadata representation budget is fixed per selection, not per call.
4. **Managed metadata for `RevitAPI.dll` exceeded REA's 64 MiB representation budget**, so member
   *signatures* for the dimension types were taken from the shipped 2027 `RevitAPI.xml`, not from the
   assembly's metadata tables. This is a shipped-artifact source of equal authority for the public
   contract, but it is not the metadata stream.
5. **The 2010 corpus is not comparable.** `revit-recon/revit2010/RevitAPI.xml` is 2.3 MB with **0**
   `DB.Dimension` doc entries against 13.1 MB / 143 in 2027, and `revit-recon/out/db.tsv` is a modern
   (2027-era) API table, not 2010. Earlier conclusions drawn from the 2010 tree should not be mixed with
   these.

---

## 12. Bottom line

Revit's dimension-as-control is not one feature; it is **one mechanism with five switches** —
*ordered geometry references*, *a value*, *a driving flag*, *an equality policy over segments*, and
*a parameter label* — solved inside regeneration and inspectable in a view mode. BIMWorks has the solver,
the dependency graph, the overlay and the command bus, but the smallest element of that mechanism,
**a durable reference into geometry**, is absent, so dimensions are renderer output with `guid: None` and
the solver has nothing meaningful to drive. Adoption is therefore a **data-model change plus a wiring
change**, not a solver project: promote the reference to a first-class addressable primitive, let datums be
witnesses like any other geometry, move the *reference* rather than the element, and let the constraint
edge that already exists in `DependencyGraph` actually do work.
