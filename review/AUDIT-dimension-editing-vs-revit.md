# AUDIT — dimension-driven editing and trim/split vs. the real Revit workflow

**Date:** 2026-10-14
**Repository:** `C:\Users\desig\Documents\GitHub\BIMWorks`, branch `gemini`, HEAD `318ce26`
**Scope:** the workflow the user named as primary — rough walls → trim/split to join and break →
**editable dimension strings in the view as the main editing surface** — for walls, grids and levels.
Dragging grips is explicitly *not* the priority.

**Normative references:** `docs/SPECIFICATION-v0.2.md` (**S-v0.2**, cited by §), `docs/SPECIFICATION` §11
(joins), `docs/IMPLEMENTATION-PLAN-2026-10-14.md` (**PLAN**), `docs/SPec.md` prose.
**Revit ground truth:** the REA corpus in `C:\Users\desig\DSH\BIMWorks\` —
`direct-manipulation-datums-walls-placements.md` (**DM**), `uncoupling-the-2d-editor.md` (**2DE**),
`views-sheets-and-tag-tracking.md` (**VS**), `revit-editing-interaction-architecture.md` (**EIA**).

## Method and evidence standard

* Every verdict carries a `file:line` citation or an explicit **searched, absent** with the search made.
* **Nine behaviours were established by execution**, not by reading. Throwaway probes live in `%TEMP%`
  (`bw_audit_dim*.py`) and were **not** placed in the repository. Observed outputs are quoted.
* The environment is the repo's `.venv` (Python 3.12.10, ifcopenshell 0.9.0).
* Distinctions are preserved throughout between **measured**, **read**, and **inferred**. Inference is
  marked **(unverified)**.
* Nothing was fixed. This audit only adds this file.

---

## 1. Summary table

| # | Area | Verdict | Gap | Evidence (file:line) |
|---|---|---|---|---|
| A1 | Dimension as a document object | **ABSENT** | Renderer output with `guid: None`; no identity, no references, no value to edit | `ifc_service.py:4342-4364`; `[PROBED]` §3 |
| A2 | Edit a dimension in the view | **PARTIAL (wrong quantity)** | The only editable dimension is a detached HTML pill measuring **bbox-centre to bbox-centre**, not a face/edge | `PlanViewport2D.tsx:1299-1348`; `useBimStore.ts:967-1025` |
| A3 | What the edit writes | **PARTIAL** | Translates the **whole element** along one axis; never moves a referenced face, never changes length | `useBimStore.ts:1066-1077`; `[PROBED]` §3 |
| A4 | Permanent, placeable, editable dimension | **ABSENT** | `DI` (Aligned Dimension) is `implemented: false`; no bus command carries a dimension value | `toolCaptions.ts:40`; `command_bus.py:309-341` |
| A5 | Witness / extension lines | **PARTIAL** | Drawn for the auto overall dimensions; `witnessP1/P2` on the temporary dimension are **written and never read** | `PlanViewport2D.tsx:799-817` vs `useBimStore.ts:1016-1017` |
| A6 | Dimension **chain** across elements with EQ | **ABSENT** | One width + one depth for the whole drawing; `EQ` is a per-window hardcoded action, not a chain | `ifc_service.py:4342-4364`; `useBimStore.ts:1204-1208` |
| B1 | `WallTrimExtend` semantics | **PARTIAL** | One-sided trim to the *target's infinite baseline line*; the target wall never moves | `ifc_service.py:1016-1053`; `[PROBED]` §4 |
| B2 | Trim-to-corner where **both** walls adjust | **ABSENT** | Only the named wall's endpoint moves | `[PROBED]` §4 case 3 |
| B3 | `WallSplit` preserves openings | **ABSENT (defect)** | A door at offset 15 on a wall split at 10 stays hosted to the shortened half — **stranded beyond its host** | `ifc_service.py:1055-1099`; `[PROBED]` §4 case 2 |
| B4 | Split-with-gap | **ABSENT** | No such command or parameter | searched `command_bus.py:309-341` |
| B5 | Trim/split reachable from the UI | **ABSENT** | No ribbon button, no hotkey, no `ActiveTool` value; store methods exist with **zero callers** | `[PROBED]` §4; `Ribbon.tsx:465-497`; `useBimStore.ts:875-911` |
| C1 | Grid dimensions in the view | **ABSENT** | Grids draw a bubble + tag only; no dimension string | `PlanViewport2D.tsx:654-689` |
| C2 | Level dimensions / levels drawn at all | **ABSENT** | The plan contract has **no `levels` key**; levels are not drawn and not in the browser | `ifc_service.py:3894`, `:4155-4162`; `ProjectBrowser.tsx` (searched `levels` → 0) |
| C3 | Change a grid/level via a dimension | **ABSENT** | `LevelMove` works at service level but has **zero callers in `src`** | `[PROBED]` §5; `useBimStore.ts:2137` |
| D1 | Where dimensions come from | **ABSENT as references** | Regex-parsed from the **rendered path coordinates** of the drawing's own extents | `ifc_service.py:4327-4341` |
| D2 | Units error in dimension text | **CONFIRMED (live bug)** | `f"{length:.2f} m ({length*3.28084:.1f}')"`; a 30 ft wall renders **"30.00 m (98.4')"** | `ifc_service.py:3767`; `[PROBED]` §6 |
| D3 | Mesh geometry vs parametric units | **CONFIRMED (live bug)** | Mesh vertices/bboxes are **metres**; `params` are **feet**. Ratio measured exactly 0.3048 | `[PROBED]` §6.2 |
| D4 | Temporary dimension is unit-inconsistent | **CONFIRMED (live bug)** | Distance computed from metre bboxes, formatted and applied as feet | `useBimStore.ts:1002`, `:1072-1075`; `[PROBED]` §6.3 |
| D5 | Dimension text rotated for angled walls | **ABSENT** | Text is never rotated; and overall dimensions are axis-aligned even when the plan is rotated | `PlanViewport2D.tsx:831-846`; `ifc_service.py:4010-4045` |
| E1 | Permanent constraint that survives later moves | **PRESENT** | `add_dimension_lock` genuinely holds and propagates — but is not wired to the dimension edit | `ifc_service.py:2460-2480`, `:2110`; `[PROBED]` §7 |

---

## 2. What a "dimension" is in this codebase today

**A dimension is not a model object. It is a number the renderer computes from its own output.**

`_overall_dimensions` (`ifc_service.py:4311-4364`) emits exactly two entries per plan:

```
[PROBED] on a model containing one 30 ft wall:
  guid=None kind=overall_width length=30.0 text='30\'-0"'
  guid=None kind=overall_depth length=0.5 text='6"'
```

The values are recovered by regex from the SVG `d` strings of `cut_paths` and `projection_paths`
(`:4329-4333`) — i.e. **the dimension is measured from the drawing, not from the building**. The
method's own docstring says so deliberately (`:4315-4318`: *"Dimension strings are a renderer's output,
not model data"*).

Consequences, all verified:

* `guid: None` on every emitted dimension, so no dimension can name what it measures.
* The UI renders a padlock and an EQ badge on these dimensions (`PlanViewport2D.tsx:849-895`) and, when
  clicked, calls `lockDimension(dim.guid, dim.guid, dim.length)` with **`None` for both GUIDs**
  (`:858`). The bus command requires `guid_a: str` (`command_bus.py:94-99`), so the request fails
  validation and the UI reports a lock-dimension failure. **The badges are offered on objects that
  cannot carry a constraint.**
* There are exactly two dimensions, both of which span the *entire drawing*. There is no per-wall
  dimension, no dimension between two chosen references, and no chain.

**Verdict: ABSENT as an editable model control.** What exists is an automatic extent annotation.

---

## 3. The editable dimension, traced end to end

There is exactly one editable dimension in the product: the **temporary** dimension, and it appears as
a detached HTML pill pinned to the top-centre of the viewport (`PlanViewport2D.tsx:1299-1348`), not as
an annotation drawn over the geometry.

### 3.1 Derivation — what it measures

`setSelectedGuid` (`useBimStore.ts:952-1027`):

1. Takes the selected element's **mesh bounding-box centre** (`:969-973`).
2. Scans every other mesh for the smallest 2D centre-to-centre distance `> 0.5` (`:979-990`).
3. Takes the dominant axis of that pair (`:1006-1009`).
4. Stores `distance`, `displayValue`, `witnessP1`, `witnessP2`, `center`, `axis` (`:1011-1025`).

This is a **centre-to-centre distance to whichever element happens to be nearest** — not a distance
between any two faces, and not a stable reference. Measured:

```
[PROBED] two walls, A 0→10 ft, B 30→40 ft, selecting A:
  measured distance = 9.144 ft        (A's actual length is 10.000 ft)
  axis = x

[PROBED] then adding a small wall near A:
  distance before adding = 9.144
  distance after         = 2.157     axis flipped x → y
```

The displayed "dimension" therefore changes when an unrelated element is added, and it is a different
quantity from the wall's length. **This is not the dimension the user wants to edit** — editing it
cannot make a wall 12 ft long, because it does not express the wall's length.

### 3.2 What triggers editing

Clicking the underlined value in the pill (`PlanViewport2D.tsx:1333-1345`) opens an inline input
prefilled with `formatLength(tempDimension.distance, displayUnit)` (`:1338`). Enter parses via
`tryParseLength` (`:1318`), rejects `<= 0` keeping the editor open (`:1319-1322`), and applies.

The parse path is genuinely good: `tryParseLength` (`src/utils/units.ts:145-212`) accepts `12'-6"`,
`12.5'`, `3800 mm`, `12-6`, plain feet, and inches-only, and returns `null` rather than 0 for garbage.
The earlier `parseFloat` defect is fixed and this is an asset worth preserving.

### 3.3 What the edit writes

`applyTemporaryDimensionChange` (`useBimStore.ts:1066-1077`):

```
delta = newValue - tempDimension.distance
dx = axis === 'x' ? delta : 0
dy = axis === 'y' ? delta : 0
await translateElement(elementGuid, dx, dy, 0)
```

`translateElement` maps to the `WallMove` bus command (`useBimStore.ts:106`). So **the edit translates
the whole element along one axis.** It never moves a referenced face, never changes the element's
length, and never records an intent. Measured:

```
[PROBED] A 0→10 ft, B 30→40 ft, temp dim measured 9.144; typing 12.0:
  delta +2.856 → translateElement(dx=+2.856)
  A start [0,0,0] → [2.856, 0, 0]
  A length 10.000 → 10.000   (UNCHANGED)
  re-derived distance = 8.273  (user typed 12.0)
```

So the value **does not round-trip**, and the element's own length is untouched. A user who selects a
wall and types `12'-0"` expecting a 12 ft wall gets a translated 10 ft wall.

**Verdict for A2/A3: PARTIAL, and the part that exists measures the wrong quantity.**

---

## 4. Trim / Split / Extend — observed geometry

### 4.1 `trim_extend_wall` (`ifc_service.py:1016-1053`)

Computes the intersection of the two walls' **infinite baseline lines** (`_line_intersect`, `:2981`),
raises for parallel walls (`:1035-1036`), moves the named endpoint onto it (`:1038-1040`), recomputes
length/angle, rebuilds the representation, and calls the **global** `recompute_wall_joins()` (`:1046`).

```
[PROBED] CASE 1 — two 90° walls that overshoot:
  A 0,0 → 12,0   B 8,-6 → 8,6
  trim_extend_wall(A, end=1, target=B) -> "trimmed"
  A 0,0 → 8,0     (length 12 → 8)      ← correct trim
  B 8,-6 → 8,6    (UNCHANGED)          ← target never moves
  wall_joins: dict, 2 entries, both {'mode': 'butt', 'allow_join': True}

[PROBED] CASE 3 — two walls that do not reach each other:
  A 0,0 → 5,0     B 8,2 → 8,8
  after trim: A 0,0 → 8,0 (extended);  B unchanged
```

**This is trim/extend-to-line for one wall, not Revit's Trim-to-Corner.** In Revit, trimming two walls
that do not meet adjusts **both** so they share the corner, then applies the join. Here a wall can only
be pushed onto the other's infinite line, which is why CASE 3 extends A to a point on B's baseline that
B's wall body does not occupy. The join mode is `butt` by default and is not updated by the trim, so a
mitered corner still requires a separate `SetWallJoin`.

Also note the call at `:1046` is the **global** `recompute_wall_joins()` with no `only=`, so a trim
recomputes joins for the whole model — the same O(N²) path the engine audit measured at 2,004,002 wall
visits for a single wall move at N=1000. A trim is not cheaper than a move.

### 4.2 `split_wall` (`ifc_service.py:1055-1099`)

Splits at an offset along the baseline, keeps the original GUID for the first segment, and creates a new
wall for the second (`:1078-1084`). Observed with a hosted door placed in the **second** half:

```
[PROBED] CASE 2 — 20 ft wall, door at offset 15, split at 10:
  split_wall(at 10.0) -> "split" new_guid=ftgw1n
  original half 0,0 → 10,0  (len 10)
  new half     10,0 → 20,0  (len 10)
  door meta after: host = ORIGINAL wall, offset = 15.0
  door still hosted on the original (now 10 ft) wall? True
  door offset 15 beyond the original half's new length 10.00? True
  openings hosted on the NEW half: 0
```

**The opening is stranded.** The door remains bound to a host that is now 10 ft long at an offset of
15 ft — it lies outside its own host. Nothing re-hosts it, nothing moves it, and the new half receives
no opening. Whether the void still subtracts is untested here and must not be assumed; what is certain
is that the *hosting relationship is now wrong*, which S-v0.2 §17 calls out as the dangerous class of
loss ("a dropped hosting relationship is a wrong building, not a wrong line").

Split also does not preserve the join state of the original's far end: the new wall is created fresh by
`add_wall`, which applies default join policy, and the original's `end` is overwritten — so a joint the
original had at its far end may be dropped or duplicated. **(unverified; requires a join fixture to
settle.)**

There is **no split-with-gap**: `WallSplitParams` has only `guid` and `at_offset` (`command_bus.py:176-178`).

### 4.3 Reachability from the UI — absent

The store implements `trimExtendWall` (`useBimStore.ts:2115`) and `splitWall` (`:2128`), and both are
declared in `UI_ACTION_COMMANDS` (`:123-124`). A repo-wide search for callers:

```
[PROBED] grep across src for trimExtendWall|splitWall|moveLevel|copyElement|rotateElement|offsetElement
  → matches only in useBimStore.ts: the UI_ACTION_COMMANDS map, the interface
    declaration, and the method bodies. ZERO call sites in any component.
```

There is no ribbon button, no `ActiveTool` value, and no hotkey:

* `ActiveTool` has no `TR`/`SL`/`SO` member, and `TOOL_CAPTIONS` has no entry (`toolCaptions.ts:25-46`).
* The hotkey table (`useBimStore.ts:884-911`) binds only `WA DR WN SB RF LI RE PW BX AL EQ HH HR HI ZE`.
  **`TR`, `SL`, `SO` and `MV` are not bound.**
* The Architecture ribbon's Modify panel contains only `AL` and `EQ` (`Ribbon.tsx:485-497`). A `Scissors`
  icon is imported (`Ribbon.tsx:2`) but never used.

So **the entire trim/split workflow the user described is bus-only** — reachable from a test or the AI
planner, not from the application.

---

## 5. Grids and levels as dimension-controlled datums

**Grids** render as a dashed line plus a bubble and tag (`PlanViewport2D.tsx:654-689`), fed by
`sliced2D.grids` (`ifc_service.py:3894`, built at `:4390-4410`). There is **no dimension string between
grids and no EQ grid spacing**, anywhere: searched `grid` across `src` and the plan contract — the only
hits are the drawing of the axis and its bubble.

**Levels are not drawn at all.** The plan contract's keys are `cut_paths, projection_paths, hidden_paths,
partitions, renderer, lineweights, cut_elevation, cut_absolute, level_id, level_name, level_elevation,
plan_rotation, dimensions, slabs, roofs, grids, swing_paths, window_paths` — there is **no `levels` key**
(`[PROBED]`, live `/api/state`). `PlanViewport2D` never references levels, and `ProjectBrowser` has no
`levels` reference either (**searched, absent**). The store does hold a `levels` array
(`useBimStore.ts:451`, seeded at `:662`), sourced from the engine, but nothing renders it in a view or a
browser branch.

**Editing a datum through a dimension is therefore unreachable in principle**: there is no grid or level
dimension to edit. `LevelMove` itself works — `[PROBED] move_level(+3 ft)` moved the storey from 0.0 to
3.0 and brought a hosted wall's z from 0.0 to 3.0 — and it is a registered, journaled bus command
(`command_bus.py:332`, `:552-553`), but its store method has **zero callers** (`useBimStore.ts:2137`),
and `GridCreate`/`LevelCreate` have **no store action at all** (searched `LevelCreate|GridCreate|
createLevel|createGrid` in `src` → 0 hits). The ribbon's Grid and Level buttons are explicitly disabled
(`Ribbon.tsx:467-482`, both passing `notYet(...)`), matching `implemented: false` in
`toolCaptions.ts:38-39`.

---

## 6. The dimensioning engine

### 6.1 Sources of dimension values

| Dimension kind | Source | References? |
|---|---|---|
| `overall_width` / `overall_depth` | regex over the rendered `d` strings, min/max | **No** — drawing extents (`ifc_service.py:4329-4341`) |
| per-wall aligned dimension (analytic path only) | `meta["start"]`/`["end"]`/`["length"]` | element, but **emitted only in the fallback slicer** (`:3760-3769`) |
| temporary dimension (UI) | mesh bbox centres | **No** — nearest-element heuristic (`useBimStore.ts:967-990`) |

`[PROBED]` on a model with two parallel walls 30 ft apart, the only dimensions emitted were
`overall_width` (10.0) and `overall_depth` (30.5) — one per drawing axis, neither related to a wall.

### 6.2 The units bug, and the mesh-units bug underneath it

**D2 — confirmed live bug.** `ifc_service.py:3767`:

```python
"text": f"{length:.2f} m ({length * 3.28084:.1f}')",
```

`length` comes from `meta["length"]`, which is **decimal feet** (S-v0.2 §11.3; `units.py:1-28`). So a
30 ft wall renders **`30.00 m (98.4')`** — the number is feet mislabelled as metres, and the bracketed
figure is that same number multiplied by 3.28.

`3.28084` occurs **exactly once** in `backend/` and **zero** times in `src/` (the single `src` hit is a
comment describing the already-fixed temporary-dimension error, `useBimStore.ts:998`). Every other
length formatter uses `format_feet_inches` (`ifc_service.py:1426, 1545-1546, 1653-1655, 1733, 1821,
4348, 4360`). **The bug is isolated to one line** — the complete list is that one site.

Note the scope: line 3767 sits in the **analytic fallback** slicer, so it is *not* reached on the default
`mesh-hlr` renderer — which is why the probe above saw correctly formatted `format_feet_inches` text and
not the broken string. **It fires whenever the mesh-HLR path fails or `renderer="analytic"` is
requested**, which makes it a latent corruption rather than a constant one. It should still be fixed:
it is the one place a drawing can print a wrong number.

**D3 — a more consequential units bug.** The geometry buffers are in **metres** while the parametric
model is in **feet**. `_build_element_mesh` (`ifc_service.py:3431-3499`) returns `raw_verts` straight
from `shape.geometry.verts` with `USE_WORLD_COORDS` (`:3458`, `:3510`) and **never** converts.
The 2D slice paths *are* converted, via `_scale_path(..., metres_to_feet)` (`:3973`, `:4130`).

Measured on a synthetic isolated wall (0,0)→(10,0) ft:

```
[PROBED] mesh bbox centre = (1.524, 0.0, 1.524)
         parametric length = 10.000 ft
         10.0 / 2 = 5.0 ft expected centre; 5.0 × 0.3048 = 1.524   ← exact
```

And on the **live Revit-authored model** (176 elements, `463-ADU_V9_4arch`):

```
[PROBED] wall params.length = 37.00 ft   mesh bbox long axis = 11.099   ratio 0.3000
         wall params.length =  8.19 ft   mesh bbox long axis =  8.187   ratio 1.0000
         wall params.length = 38.00 ft   mesh bbox long axis = 11.127   ratio 0.2928
```

The ratios are **0.30, 0.298, 0.297** for several walls — consistent with 0.3048 — and **1.0** for
others, because the long axis of a diagonal wall's bounding box does not correspond to its baseline
length. The synthetic case is the clean determinant: **0.3048 exactly.** So mesh geometry is metres and
`params`/`elements` are feet. **(Note:** the live ratios are noisy by construction; the conclusion rests
on the exact synthetic 0.3048, not on the live ratios.)

This matters because **`PlanViewport2D` reads mesh bboxes directly** for the pan/zoom fit of constraint
guides (`:39`, `:54-74`) and `Viewport3D` builds geometry straight from `mData.vertices`
(`Viewport3D.tsx:412`). Within 3D the metre world is self-consistent, so the building looks
proportionally right; the mismatch surfaces wherever metre-space meets the feet-space UI.

**D4 — the temporary dimension is unit-inconsistent as a result.** `[PROBED]` with the faithful mirror
of the store's own algorithm:

```
two walls A 0→10 ft, B 30→40 ft; selecting A:
  measured distance = 9.144        ← this is 30 ft × 0.3048, i.e. METRES
  formatLength(9.144, imperial_fractional) → renders as 9'-2"
  typing 12.0 → delta = 12.0 - 9.144 = +2.856 → WallMove(dx=+2.856 ft)
```

So the pill shows **`9'-2"` where Revit would show `30'-0"`**, and typing a value moves the element by a
delta computed in the wrong unit. This is a live, user-visible consequence of D3 on the one dimension
the user is meant to edit. It also means the dimension is unusable as a precision tool regardless of
the design questions above.

### 6.3 Rotation

Dimension text is drawn with no rotation — the only transform is a Y-flip
(`PlanViewport2D.tsx:830-846`). For an angled wall the text stays horizontal while the dimension line
runs at the wall's angle, which is wrong for steep angles and unreadable past vertical.

More seriously, the plan is rotated into the building's frame by `_orient_plan`
(`ifc_service.py:4010-4045`), which rotates **only** `cut_paths`, `projection_paths` and `hidden_paths`
(`:4040-4043`). Everything appended afterwards by `_finish_plan_contract` — grids (`:4390-4410`), slabs,
roofs, swing paths, window paths — is **never rotated**, and the frontend applies no rotation either
(the drawing group is `translate(...) scale(scale, -scale)` only, `PlanViewport2D.tsx:576`). The
contract does carry `plan_rotation` (`:4044`) but nothing consumes it.

For the surveyed building — `[PROBED]` live `plan_rotation = -0.2993 rad` (**−17.1°**) — the wall
linework is drawn axis-aligned while the grids drawn from element metadata remain at their world angle.
**This is an inference from the code plus the measured rotation value; I did not drive the browser to
observe the render. (unverified as a visual claim, verified as a code claim.)**

---

## 7. Does a locked dimension behave like a Revit constraint?

**Yes — and this is the best news in the audit.** `add_dimension_lock` (`ifc_service.py:2460-2480`) and
`_solve_constraints_after_move` (`:2110`) genuinely hold and propagate. Measured:

```
[PROBED] A 0→10, B 20→30, add_dimension_lock(A,B,locked_distance=10.0,axis='x')
  no lock:  translate(A,+5) → A (5,15)  B (20,30)     B untouched
  locked:   translate(A,+5) → A (5,15)  B (15,25)     B followed, distance held
  re-value: set locked_distance=15.0 then move → B start = 15.0   (new value honoured)
```

So the *mechanism* for a permanent, dimension-driven constraint exists and works — including
re-valuing it. What is missing is that it is not reachable from a dimension edit:

* The temporary-dimension edit calls `WallMove`, not the constraint (D4/§3.3).
* `locked_distance` is a plain dict value (`ifc_service.py:2480`). Mutating it in place does **not**
  bump `constraints_rev`, so no delta would carry the change to the client even if a command existed
  to do it. **(unverified: whether a write path would bump the revision; there is no such path.)**
* `lockDimension` is only ever called with the padlock badge's `dim.guid`, which is `None` for the auto
  dimensions, so the working mechanism is currently unreachable by design.

**This changes the recommendation**: the work is not "build a constraint engine" — it is "expose the one
that exists, give it an identity, and fix the units under it."

---

## 8. The editable-dimension interaction, specified

The exact sequence the user described, naming what exists and what must be written.

### 8.1 What the user does

1. Draw walls roughly (grid-snap or freehand) — **exists** for the drawing part (`WA` tool, 0.25 ft
   blanket snap, `PlanViewport2D.tsx:249-263`).
2. Trim/split to join or break — **engine exists, UI absent** (§4.3).
3. Select a dimension in the view and type over its number — **the surface does not exist** (§2, §3).
4. The wall moves/grows to that dimension — **partially, and on the wrong quantity** (§3.3).
5. Same for grids and levels — **the dimensions do not exist** (§5).

### 8.2 The sequence that must exist, step by step

| Step | Event | Today | Must be written |
|---|---|---|---|
| 1 | User picks the **Dimension** tool (`DI`) and clicks two references (face, wall centreline, grid, level) | `DI` is `implemented: false` (`toolCaptions.ts:40`); no pick model | `ActiveTool` member + `TOOL_CAPTIONS` entry; a **pick model** (element GUID + a named reference on it) — the corpus calls this a *pick* (`DM:17-36`). New `src/interaction/pick.ts`. |
| 2 | A dimension **object** is created with identity, refs, value, and a placement | only renderer extents, `guid: None` (`ifc_service.py:4342`) | Overlay schema: `dimensions[]` with `{id, ref_a:{guid,ref}, ref_b:{guid,ref}, axis, value, offset}`; persisted in `parametric.json` beside constraints/sketches. |
| 3 | A bus command creates it | none | `DimensionCreate{ref_a, ref_b, offset}` in `COMMAND_REGISTRY` (`command_bus.py:309-341`), plus executor. |
| 4 | The dimension renders as annotation with witness lines in the view | witness lines only for the auto extents (`PlanViewport2D.tsx:799-817`) | Render overlay dimensions from the contract; reuse the existing witness/extension drawing. |
| 5 | **User clicks the dimension text** and types a value | pill click only, on the temporary dimension (`PlanViewport2D.tsx:1333-1345`) | `onDoubleClick`/click handler on the rendered dimension `<text>`; parse with the existing `tryParseLength` (keep it). |
| 6 | The edit is committed as a typed command that carries the **value**, not a delta | `WallMove` with a derived delta (`useBimStore.ts:1072-1075`) | `DimensionValueSet{dimension_id, value}`. This is the key change: the command must express intent. |
| 7 | The engine re-solves so the geometry honours it afterwards | `add_dimension_lock` does hold and propagate (`ifc_service.py:2460`, `:2110`) | Extend `_solve_constraints_after_move` to treat a dimension as a first-class constraint and to **move the referenced face** (move the wall's start or end along its own axis) rather than translating the element. |
| 8 | Datums resolve the same way | `LevelMove` works, unreachable; grids have no move-from-dimension path | Expose `LevelMove`/a grid equivalent through the same `DimensionValueSet` path; draw level lines and level dimensions. |
| 9 | The change is journaled, undoable, and arrives as a delta | bus + delta already exist | Bump `constraints_rev`/`project_rev` when a dimension changes so the delta carries it. |

### 8.3 Two design decisions to make explicitly

* **Move the face, not the element.** For a wall dimension the correct behaviour is to move the
  *referenced endpoint* along the baseline (changing length), which is what `trim_extend_wall` already
  does for an intersection point and what `update_element` would need for an arbitrary value. Editing a
  dimension between *two* elements should move the non-anchored one — the solver already does this.
* **Zero and negative.** Today `PlanViewport2D.tsx:1319` rejects `<= 0` and keeps the editor open, which
  matches Revit. There is **no minimum**, so a value that makes elements overlap is accepted
  (`[PROBED]`: typing a value smaller than the current spacing translated a wall to `-2.5` and it
  overlapped its neighbour). Revit warns rather than silently producing an impossible condition; a
  minimum-gap check belongs with the solver, not the input field.

---

## 9. Top 10 changes to make dimension-driven editing work like Revit

Ranked by leverage. Effort: **S** ≤ 1 day, **M** ~ week, **L** weeks.

| # | Change | Why it is ranked here | Effort | Files |
|---|---|---|---|---|
| 1 | **Fix the metre/foot split in the geometry buffers** — convert mesh vertices/bboxes to decimal feet at the API boundary, or convert in the store where bboxes are consumed | Everything dimensional sits on this: the temporary dimension currently displays `9'-2"` for a 30 ft spacing and applies a 3.28×-wrong delta. No dimension feature can be correct above it. | **M** | `ifc_service.py:3431-3499`, `:3503-3561`; `useBimStore.ts:967-990`; `PlanViewport2D.tsx:39`; `Viewport3D.tsx:412` |
| 2 | **Give dimensions identity**: a persisted `dimensions[]` overlay record with `{id, ref_a, ref_b, axis, value}` and an `IfcAnnotation`-free home in `parametric.json` | Without identity there is nothing to select, edit, constrain, or round-trip. This is the load-bearing data-model change. | **M** | `ifc_service.py` overlay; `src/types/bim.ts:128` |
| 3 | **Add `DimensionCreate` + `DimensionValueSet` bus commands**, and make the value edit carry the **value** not a delta | The bus is the only mutation path (S-v0.2 §6); the current path expresses a delta, which cannot round-trip | **S** | `command_bus.py:309-341`, `:386-623`; `useBimStore.ts:98-132` |
| 4 | **Render real dimensions with witness lines and make the text editable in place** — reuse the existing witness/extension drawing | This is the user's primary interaction; the drawing code already exists for the auto extents | **M** | `PlanViewport2D.tsx:774-846`; `Viewport3D.tsx` |
| 5 | **Make the edit move the referenced face, not translate the element** — route `DimensionValueSet` into `_solve_constraints_after_move` and `trim_extend_wall`-style endpoint maths | Turns "the wall moved" into "the wall became 12 ft", which is the stated requirement | **M** | `ifc_service.py:1016-1053`, `:2110-2161`, `:2460-2480` |
| 6 | **Fix `ifc_service.py:3767`** and add a units-formatting test over every length-emitting site | One line, currently prints `30.00 m (98.4')` for a 30 ft wall; a drawing that prints a wrong number destroys trust in all of them | **S** | `ifc_service.py:3767` |
| 7 | **Make trim-to-corner move both walls and apply the join**; add split-with-gap | The user's step 2; today one wall is pushed onto the other's infinite line and the join mode is left at `butt` | **M** | `ifc_service.py:1016-1053`; `command_bus.py:170-178` |
| 8 | **Re-host or move hosted openings on split** (and refuse the split when an opening straddles the cut) | A split currently strands a door outside its own host — the S-v0.2 §17 "wrong building" class | **M** | `ifc_service.py:1055-1099` |
| 9 | **Expose the datum path**: draw levels, add level/grid dimensions, and wire `LevelMove` to a UI surface (the solver path already works and is tested) | Cheap because the engine is done; unlocks "grids and levels are dimension-controlled" | **M** | `ifc_service.py:4366-4487`; `PlanViewport2D.tsx`; `ProjectBrowser.tsx`; `useBimStore.ts:2137` |
| 10 | **Make trim/split/dimension reachable**: `TR`/`SL`/`SO`/`DI` hotkeys, ribbon buttons, and the pick sequence | Today the whole workflow is bus-only, so none of the above is usable from the application | **S–M** | `useBimStore.ts:875-911`, `:98-132`; `Ribbon.tsx:465-497`; `toolCaptions.ts:25-46` |

### Sequencing note

Changes 1 and 2 gate everything else and are independent of each other. Change 3 depends on 2. Changes
4–5 depend on 3. Change 10 is what makes any of it usable and can proceed in parallel once 3 lands.
Changes 6, 7, 8 are independent and safe to do immediately.

**Do not** build a dimension chain with EQ or a witness-line rule set before change 2 exists — a chain
is a list of dimensions with shared references, and there is currently no dimension object to chain.

---

## 10. Coverage gaps this audit could not close

Recorded rather than skipped, per S-v0.2 §20.3:

* **Whether the stranded opening's void still subtracts** after `split_wall`. The probe established the
  hosting record is wrong; whether the boolean cut survives in `model.ifc` was not measured.
* **Join state across a split.** Whether the original's far-end join policy is preserved or lost needs a
  join fixture with a mitered end; I did not build one.
* **The rotated-plan render.** The code claim (grids/slabs/roofs are never rotated and the frontend
  ignores `plan_rotation`) is solid; the *visual* claim was not observed in a browser. **(unverified)**
* **The metre/foot live ratios** are noisy for diagonal walls; the conclusion rests on the exact
  synthetic 0.3048 measurement, not on the live ratios.
* **No running Revit was observed.** The DM corpus is export-table inference, not decompiled bodies
  (`DM:12-13`), so Revit's exact trim-to-corner sequencing and dimension-editing semantics are the
  documented behaviour, not something this audit could verify against the application.
