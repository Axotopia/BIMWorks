# REVIEW — Gemini's direct-manipulation Phases 7 and 8

**Reviewed:** the completion note for **Phase 8 — Validity predicates and clamping** and **Phase 7 — Face-based push/pull as a parameter gesture**, as reported by Gemini on 2026-10-16, against `Axotopia/BIMWorks@d54f9b1`.

**Compared against:** [`IMPLEMENTATION-PLAN-direct-manipulation.md`](IMPLEMENTATION-PLAN-direct-manipulation.md) §3 (the six decisions), §5 (Phases 7 and 8), §6 (explicitly not doing), §7 (risks), §8 (gates) — the plan that owns this work, per [`IMPLEMENTATION-PLAN-revit-feel.md`](IMPLEMENTATION-PLAN-revit-feel.md) §2b. The note's SHAs, its gate counts, and every architectural claim were each re-derived from the tree and from a live command bus. Nothing was carried forward.

**What this review adds to the record:**

1. **Two of the three SHAs in the note do not exist in the repository.** `git cat-file -t` rejects both.
2. **The create path is unguarded.** Plan §5 requires `backend/validity.py` "used by **both** the create and edit paths". Four of the five named predicates are absent from create, and I reproduced the resulting invalid elements through the bus.
3. **The clamp sentence is computed and discarded** at the two integration sites, so gate B8's "clamps **and explains**" and decision §3.5's "clamp **plus a sentence**" are half met — and the gate that certifies B8 only asserts the module's local return value.
4. **Phase 8 introduced a boundary regression that Phase 7 and Phase 6 both inherit**: the client clamp floors (`0.083`, `0.0833`) are below the engine minimum (`1/12`), so dragging either gesture to its stated minimum now issues a command the engine *rejects*.
5. **Phase 7's gate does not test the code it gates.** It reproduces `detectWallFaceHover` and `computePushPullCommand` as a hand-written Python mirror that already diverges from the TypeScript, and a `1e-3` tolerance hides exactly the divergence in (4).
6. **Two Phase 7 interaction hazards** the note presents as strengths: the face hit-test ignores occlusion against non-wall meshes, and the drag session is opened on every wall-selection click with an un-awaited `beginDrag`/`endDrag` pair.

---

## 1. Verdict in one paragraph

**The design decisions are right and the engineering is mostly sound, but the phase is not consistent with the plan, and the two defects that matter are both hidden by the way the work was verified.** Gemini implemented the gesture correctly in the ways that are hard — typed parameter edits rather than mesh pushes (§3.1), the bus drag session with one journal entry per gesture (§3.2/§3.4), numeric entry before and after commit (§3.5/§5 Phase 4), and a genuinely correct closing of the open-boundary hole that plan §5 Phase 8 names as this phase's second job. Ordering is right too: `P6 → P8 → P7` matches the plan's dependency order exactly. Against that, the phase's *first* stated job — one validity module used by both the create and the edit path — is half done, and its *stated user-facing behaviour* — clamp and explain — silently drops the explanation on the floor. Worse, tightening the edit path to a `1 inch` floor without updating the two client-side clamp floors created a minimum thickness that neither grip can commit, so the clamp now terminates in a refusal. None of this was caught because Phase 7's 46 assertions run against a Python copy of the TypeScript rather than the TypeScript, and because the mirror omitted the `.toFixed(3)` that produces the offending value. **The code is closer to the plan than the evidence is.** Fix four things — the boundary, the explanation path, the create path, and the gate's authority — and Phases 7 and 8 can be closed.

---

## 2. What the note gets right — every verification claim reproduced

Credit first, and specifically: the numbers are honest. I re-ran the whole gate suite and both new Python suites. Every count in the note is exact.

| Claim in the note | Reproduced | Command |
|---|---|---|
| `npx tsc --noEmit` → 0 errors | ✅ exit 0 | `npx tsc --noEmit` |
| `npm run check:bus` → 47 UI actions, 0 errors | ✅ 47 declared, 0 errors | `npm run check:bus` |
| `npm run check:ui` → 130 checks, 0 failures | ✅ `UI-P0 GATE PASSED — 130 checks` | `npm run check:ui` |
| `npm run check:py` → 14 suites passed | ✅ 14 suites, gate passed | `npm run check:py` |
| Phase 8 gate → 48 assertions | ✅ `Phase 8 Gate Total: 48 passed, 0 failed` | `./.venv/bin/python scratch/test_validity_predicates.py` |
| Phase 7 gate → 46 assertions | ✅ `Phase 7 Gate Total: 46 passed, 0 failed` | `./.venv/bin/python scratch/test_face_pushpull.py` |

I also ran the three frontend gates the note does not mention, in case Phase 8 had disturbed them: `check:state` 45 checks, `check:delta` 21 checks, `check:snap` 34 passed — all green. **Both new suites are correctly wired** into the Python gate ([`scripts/check-python-suites.mjs:38-39`](../scripts/check-python-suites.mjs#L38-L39)), so they run under `npm run check`, not just by hand. That is the right instinct and it is not universal in this repository.

**The commit order is also right.** The plan's Phase 8 header says "required by Phase 7" and its dependency order is `P0 → P1 → P2 → P3 → {P4, P5} → P6 → P8 → P7` ([plan:232](IMPLEMENTATION-PLAN-direct-manipulation.md#L232)). The actual sequence is `0d3f31a` P0 → `c7350d3` P1 → `cadcb15` P2 → `7de81a1` P3 → `e9b5bc0` P4 → `148ca98` P5 → `cdc6043` P6 → `60ea794` P8 → `abc201c` P7. Exactly the plan's order, and Phase 8 landed before the gesture that depends on it.

### 2.1 The SHAs are wrong

| Note | Tree |
|---|---|
| Phase 8 — `6ff8570` | **`60ea794`** — *feat(direct-manipulation): Phase 8 — Validity predicates and clamping* |
| Phase 7 — `f777ed3` | **`abc201c`** — *feat(direct-manipulation): Phase 7 — Face-based push/pull as a parameter gesture* |

```
$ git cat-file -t 6ff8570   → fatal: Not a valid object name 6ff8570
$ git cat-file -t f777ed3   → fatal: Not a valid object name f777ed3
$ git log --oneline -- backend/validity.py src/interaction/pushpull.ts
abc201c feat(direct-manipulation): Phase 7 — Face-based push/pull as a parameter gesture
60ea794 feat(direct-manipulation): Phase 8 — Validity predicates and clamping
```

Neither object exists, on any ref. These are the only two provenance anchors in the note, and both are unusable — a reader cannot use them to check anything. Whatever produced them (a local branch, a rebase, or invention) did not survive the push. Corrected here so the record has working anchors.

### 2.2 The filename in the hand-off is wrong, and this matters for the review

The work was described as a refactor of `IMPLEMENTATION-PLAN-revit-feel.md`. It is not. That plan's Phase 6 is *Sheet management* and its Phase 7 is *Chrome*; Phases 6–8 of the gesture layer live in `IMPLEMENTATION-PLAN-direct-manipulation.md` §5 Track B. The revit-feel plan says so itself, in the ownership table at §2b:

> **`IMPLEMENTATION-PLAN-direct-manipulation.md`** — **Track B** — the IngeTrazo-style gesture layer: interaction session, drag session on the bus, grips, value entry and hot retype, inference, **validity predicates** (§5)

and lists "the gesture layer (no drag, grips or inference)" under what revit-feel explicitly **does not own**. So the division of labour was respected — the work went to its owner. The problem is the hand-off text, and it is not cosmetic: reviewing Phases 7 and 8 against revit-feel's Phase 6/7 (sheets, chrome) would find nothing wrong at all, and the two defects below would pass. **I reviewed against the direct-manipulation plan.** Nothing in this work touches revit-feel's owned surface, and beyond the shared §19 latency budget (see §4.5) this phase owes it nothing.

---

## 3. Phase 8 — consistency audit

Plan §5 Phase 8, in full:

> One module, `backend/validity.py`, used by **both** the create and edit paths: thickness > 0, wall longer than the openings it hosts, opening inside its host, footprint area > 0, finite coordinates. This also closes the open-boundary hole documented in `REVIEW-…§4.2` — `Sketch.validate()` currently accepts an open chain and has its closing edge inferred — which a grip drag will hit on its first day.

That is three requirements: **(a)** one module, **(b)** both paths, **(c)** the Sketch hole. Plus the user-facing behaviour from §3.5 and gate B8.

### 3.1 One module, and the predicates it declares — met

[`backend/validity.py`](../backend/validity.py) is a real module (238 lines, no dependencies beyond `math`), and its predicates are individually correct. The constants and the two clamp helpers are honest about their rules:

| Rule | Where | Verdict |
|---|---|---|
| Finite coordinates | [`validity.py:28-40`](../backend/validity.py#L28-L40) | correct |
| Thickness > 0, min 1 inch | [`validity.py:67-74`](../backend/validity.py#L67-L74), `MIN_THICKNESS_FT = 1.0 / 12.0` at [`:23`](../backend/validity.py#L23) | correct |
| Wall height > 0 | [`validity.py:77-80`](../backend/validity.py#L77-L80) | correct |
| Wall longer than hosted openings | [`validity.py:83-129`](../backend/validity.py#L83-L129) | correct |
| Opening strictly inside host | [`validity.py:189-212`](../backend/validity.py#L189-L212) | correct |
| Footprint ≥ 3 vertices, non-zero area | [`validity.py:56-64`](../backend/validity.py#L56-L64) | correct |

I checked the clamp arithmetic rather than trusting it. `clamp_wall_end` handles the `start` end as well as the `end` end, and its sign convention is right: for `end == "start"` it computes `dx = ep.x − tx` and returns `ep − dx·(min_len/dist)`, which places the start point at exactly `min_len` from the fixed end. It also degenerates safely when the drag collapses onto the fixed point (a unit vector from the current baseline). Measured: a 20 ft wall with a door at `offset 10.0`, dragging the end to `x = 12` clamps to `13.0`, which is `offset + width = 10.0 + 3.0` — the door's stored width, not the `get("width", 3.0)` fallback. The min-length is driven by real opening data.

Also correct: building the minimum from the **furthest** opening extent, not the nearest, and applying the same threshold in both directions so `clamp=True` and `clamp=False` cannot disagree about what is legal.

### 3.2 "used by both the create and edit paths" — edit only

This is the phase's headline requirement and it is half done. Every `validity.py` import in the tree sits inside a `set_*` method:

```
backend/ifc_service.py:3436  from validity import validate_wall_height          (set_wall_height)
backend/ifc_service.py:3447  from validity import validate_thickness            (set_wall_thickness)
backend/ifc_service.py:3461  from validity import ... clamp_wall_end ...        (set_wall_end)
backend/ifc_service.py:3491  from validity import ... clamp_opening_offset ...  (set_opening_offset)
backend/ifc_service.py:3509  from validity import validate_opening_placement    (set_opening_width)
backend/ifc_service.py:3546  from validity import validate_finite_point         (set_grid_end)
backend/ifc_service.py:3570  from validity import ... validate_polygon_footprint (set_polygon_vertex)
```

Seven imports, seven edit paths, zero create paths. The create functions — [`add_wall`](../backend/ifc_service.py#L2073), [`add_door`](../backend/ifc_service.py#L2225), [`add_window`](../backend/ifc_service.py#L2367) — never call it, and no create command schema compensates. [`WallCreateParams`](../backend/command_bus.py#L23-L30) is `thickness: float = Field(default=0.2)` with no `gt` bound; `DoorInsertParams.offset_along_wall` has no `ge` bound. Reproduction, through the real bus on a fresh manager:

```
WallCreate thickness=0.0     -> CREATED (1 new element)     [validity.py NOT applied]
WallCreate thickness=-1.0    -> CREATED (1 new element)     [validity.py NOT applied]
WallCreate height=0.0        -> CREATED (1 new element)     [validity.py NOT applied]
DoorInsert offset=25  (host wall length 10.0) -> CREATED
DoorInsert offset=-5                          -> CREATED
WindowInsert offset=99                        -> CREATED
SlabCreate zero-area polygon (4 identical points) -> CREATED
SlabCreate 2-vertex polygon                       -> CREATED
SlabCreate thickness=0.0                          -> CREATED
RoofCreate zero-area polygon (3 identical points) -> CREATED
```

Four of the five predicates the plan names — thickness > 0, height > 0, opening inside its host, footprint area > 0 — are simply not on the create path. Only *finite coordinates* is refused, and that incidentally, by ifcopenshell's own `RuntimeError: Only finite values are allowed`, not by `validity.py`.

**Why this is not a technicality.** The plan's rationale for Phase 8's create-path half is stated in §7.8: "Green gates are not coverage." A validity module that guards only the edit path means the *first* wall a user draws can be 0 inches thick, and the engine will then refuse every subsequent attempt to fix it through a grip, because `set_wall_thickness` rejects anything below 1 inch. Create-and-then-cannot-edit is a worse state than either half alone. The phase's own test suite does not notice: [`test_validity_predicates.py`](../scratch/test_validity_predicates.py) exercises the predicates as *functions* and the edit path as *integration*, and never calls a create command.

### 3.3 "clamps and explains" — clamps, then discards the sentence

Gate B8 ([plan:279](IMPLEMENTATION-PLAN-direct-manipulation.md#L279)) reads "Dragging a wall end past an opening clamps **and explains**", and decision §3.5 ([plan:85](IMPLEMENTATION-PLAN-direct-manipulation.md#L85)) is unambiguous about the mechanism:

> **3.5 A refusal is a clamp plus a sentence, not a failed transaction.** … Every grip declares its validity range, and the drag clamps to it, showing *why*: "thickness cannot go below 0'-1\"", "the opening would leave the wall", "walls cannot be shorter than their openings".

The clamping is implemented correctly. The sentence is computed — and then dropped at both call sites:

```python
# backend/ifc_service.py:3471  — set_wall_end
clamped_2d, expl = clamp_wall_end(self, guid, end, raw_pt)   # expl is never read again
pt = [clamped_2d[0], clamped_2d[1], raw_pt[2]]

# backend/ifc_service.py:3495  — set_opening_offset
clamped_off, expl = clamp_opening_offset(self, host_guid, offset, width)  # expl is never read again
offset = clamped_off
```

`expl` is dead in both. The value does not reach the method's return dict, the command envelope, the store, or any viewport. Runtime evidence, dragging a wall end past its door:

```
set_wall_end(wall, "end", [12.0,0,0], clamp=True)
  -> end 20.0 folded to 13.0        (clamp correct)
  -> returned keys: [elevation, end, guid, height, ifc_class, length, ...]
     explanation / reason / clamp / message key present?   []      NO

bus.execute_single_command("WallSetEnd", {..., "clamp": True})
  -> {"status":"updated","guid":...,"end":"end","point":[13.0,0.0,0.0],"element":{...}}
     does the envelope carry the clamp sentence?           False
```

The envelope branch at [`command_bus.py:642-646`](../backend/command_bus.py#L642-L646) returns `final_pt` — the correct clamped *value*, which is real progress over returning the requested point — but nothing else. A grep for any clamp-message plumbing in `src/` finds only unrelated viewport-bounds clamping in `ContextMenu.tsx`. So there is no path by which the user is told why the wall stopped. The plan's §3.5 sentence "thickness cannot go below 0'-1\"" exists nowhere in the product.

**And the gate cannot see this.** [`test_validity_predicates.py:261-263`](../scratch/test_validity_predicates.py#L261-L263) asserts on the helper's local return value:

```python
clamped_pt, w_expl = clamp_wall_end(mgr, wall_guid, "end", [10.0, 0.0])
check("Gate B8: clamp_wall_end provides explanation", w_expl is not None and "15.00" in w_expl)
```

That passes, and it is a fair unit test of the helper. But B8 is written as an end-to-end assertion about a *drag*, and no assertion in the suite carries `expl` through `set_wall_end` → envelope → store. This is the §7.8 pattern with a precise mechanism: the requirement was verified at the layer where it was implemented, and the layer where it is lost was not in the assertion. Phase 7 has the same shape (§4.2).

### 3.4 The boundary regression Phase 8 introduced

Phase 8 tightened the engine's minimum thickness to exactly `1 inch`:

```python
MIN_THICKNESS_FT = 1.0 / 12.0        # validity.py:23  = 0.0833333...
if float(thickness) < min_thickness:  # validity.py:71  strict <
```

Before this commit, [`set_wall_thickness`](../backend/ifc_service.py#L3447) only required `thickness > 0`. Both client-side clamp floors were written against the looser contract and were not updated:

| Source | Floor sent to the engine | Engine verdict |
|---|---|---|
| [`grips.ts:365,377`](../src/interaction/grips.ts#L365) — thickness grip range, Phase 6 | `0.0833` | **REFUSED** |
| [`pushpull.ts:144-145`](../src/interaction/pushpull.ts#L144-L145) — `Math.max(1.0 / 12.0, x).toFixed(3)`, Phase 7 | `0.083` | **REFUSED** |

```
0.083  -> REFUSED: Thickness 0.0830 ft is below minimum allowable thickness 0.0833 ft (1 inch)
0.0833 -> REFUSED: Thickness 0.0833 ft is below minimum allowable thickness 0.0833 ft (1 inch)
0.0834 -> COMMITTED
```

Two independent causes, both worth naming because they fail differently:

- **`grips.ts` is a literal, not a derived constant** — `0.0833` is a hand-rounded `1 inch`, and `0.0833 < 0.083333…`. Anyone reading "1 inch" on both sides would call this consistent.
- **`pushpull.ts` derives the value correctly and then rounds it down** — `Math.max(1.0 / 12.0, x)` is exactly the engine floor, but the following `Number(clampedThickness.toFixed(3))` turns `0.0833333` into `0.083`. The code is right up to the last step.

The consequence is exactly the behaviour decision §3.5 exists to forbid: drag a thickness grip or a wall's side face to its declared minimum and the gesture issues a command the engine rejects, instead of clamping and explaining. Because the floors are *below* the legal value, the clamp also never engages in the useful direction — the user cannot reach 1 inch at all. This is a **Phase 8 regression against Phase 6**, which is why it belongs in this review even though Phase 6 is not under review.

### 3.5 The Sketch open-boundary hole — genuinely closed

This half of Phase 8 is done properly and I want it on the record, because it is the phase's subtlest requirement. The plan asks that `Sketch.validate()` stop accepting an open chain whose closing edge is inferred. The fix is not a surface patch:

```python
# backend/sketch_model.py
is_closed_loop = False                       # :251
...
if _dist(next_point, first_point) <= self.tolerance and len(ring) >= 3:
    is_closed_loop = True                    # :263
    break
...
if is_closed_loop and len(ring) >= 3:        # :270   was: if len(ring) >= 3
    loops.append(ring)
```

`closed_loops()` now records a loop only when the walk actually returned to its origin, so `is_closed()` ([`:294`](../backend/sketch_model.py#L294)) reports false for an open chain, and `validate()` ([`:301`](../backend/sketch_model.py#L301)) returns *"Boundary must form a closed loop (check for gaps at the corners)."* The consumers are real, not decorative: `validate()` is called at [`ifc_service.py:968`](../backend/ifc_service.py#L968) and [`ifc_service.py:1073`](../backend/ifc_service.py#L1073) on the create paths for slabs and roof profiles. Note that `footprint()` still falls back to the open chain, which is correct and deliberate — it is the preview path and its docstring says so. **The plan's "grip drag will hit this on its first day" concern is addressed.**

---

## 4. Phase 7 — consistency audit

Plan §5 Phase 7 ([plan:226-227](IMPLEMENTATION-PLAN-direct-manipulation.md#L226-L227)) is short: "Hover a wall face → push/pull changes thickness; hover the top face → height. Numeric entry as in Phase 4. This is the gesture that will most make the 3D viewport feel like IngeTrazo, and it is only safe *after* Phase 8's validity predicates." Its obligations therefore come mostly from §3's decisions rather than from the phase text.

### 4.1 What is consistent with the plan's decisions

Credit where the hard parts were done right.

| Plan decision | Evidence | Verdict |
|---|---|---|
| §3.1 Grips emit *parameters*, not geometry; never mesh-level edits | [`pushpull.ts:146-154`](../src/interaction/pushpull.ts#L146-L154) emits `WallSetHeight`/`WallSetThickness`; [`useBimStore.ts:152-153`](../src/store/useBimStore.ts#L152-L153) maps them to bus commands | **met** |
| §3.2 One snapshot per gesture, not per frame | Frames route to `/drag/update` while `activeDragSessionId` is set ([`useBimStore.ts:2945-2977`](../src/store/useBimStore.ts#L2945-L2977)); engine test confirms `rev` constant across 10 frames and +1 on commit | **met** |
| §3.4 Anything that regenerates goes through the session, not the client transform | Height and thickness both go through the drag session; decisions §3.4's "never commit from the client preview" is respected | **met** |
| §5 Phase 4 numeric entry mid-gesture and hot retype | [`Viewport3D.tsx:247-258`](../src/components/viewport/Viewport3D.tsx#L247-L258) handles typed entry during the drag; [`useBimStore.ts:3056-3059`](../src/store/useBimStore.ts#L3056-L3059) re-issues `modifyWallHeight`/`modifyWallThickness` after an undo | **met** |
| §6 No whole-model validity on the interactivity path | `computePushPullCommand` is O(1); the clamp helpers are O(openings on one wall) | **met** |
| §3.5 Clamp and explain | Client clamps to 0.5 ft / 1 inch but surfaces no reason, and the floor is uncommittable (§3.4) | **not met** |
| §8 Drag performance gate (Phase 2 onward) | No measurement anywhere | **not met** (§4.5) |

The face classifier is also reasonable engineering: `detectWallFaceHover` classifies `normal.z > 0.7` as top face → height, `|normal.z| <= 0.3` with `|N·T| <= 0.5` as a side face perpendicular to the baseline → thickness, and returns `null` for end caps and undersides so the click falls through to ordinary selection. Deriving the normal through `hit.object.matrixWorld` and normalising is correct for rotated walls. The wobble threshold is 5 px, matching the plan's §2.7 port of IngeTrazo's `_DRAG_PX = 6.0`.

### 4.2 The gate tests a mirror, not the code it gates

[`test_face_pushpull.py`](../scratch/test_face_pushpull.py) is a Python test of TypeScript logic, which is a legitimate way to gate a pure function — *if* the mirror is derived from the source rather than re-typed from it. It is not. Both functions are hand-copied:

```python
# test_face_pushpull.py:35
"""Python mirror of TypeScript detectWallFaceHover."""
# test_face_pushpull.py:86
"""Python mirror of TypeScript computePushPullCommand."""
```

And the copy already disagrees with the original. The real clamp ends with a rounding step:

```ts
// src/interaction/pushpull.ts:144-145
const clampedThickness = Math.max(1.0 / 12.0, rawThickness);   // 0.0833333
const roundedThickness = Number(clampedThickness.toFixed(3));  // 0.083   <-- shipped value
```

The mirror drops the rounding and substitutes the engine constant:

```python
# scratch/test_face_pushpull.py:108
clamped_thickness = max(MIN_THICKNESS_FT, raw_thickness)       # 0.0833333
```

The assertion then compares the mirror's value to a *rounded* expectation with a tolerance wide enough to absorb the difference:

```python
# scratch/test_face_pushpull.py:191
check("Thickness push clamped to minimum 1 inch (0.0833 ft)",
      abs(th_clamp - round(MIN_THICKNESS_FT, 3)) < 1e-3)        # |0.08333 - 0.083| = 3.3e-4 < 1e-3
```

So the gate passes while the shipped value is the one the engine refuses. The `1e-3` tolerance is not incidental — it is precisely wide enough to hide the only discrepancy that matters, and it is the reason §3.4 survived a 46-assertion gate.

This is worse than a missing test. Plan §8 requires that each gate "must be able to fail" and gives every listed gate a negative control; a test of a mirror cannot fail when the verified artefact drifts, which is the only failure mode that counts. The mirror also has no mechanism to stay in sync — nothing regenerates it from the TypeScript, and nothing fails when the two diverge.

The *engine-level* half of the suite is genuine: `begin_drag`/`update_drag`/`end_drag` are exercised against the real `CommandBusEngine`, with real `rev` tracking, real journal entries, and real undo/redo. Those assertions (rev constant across 10 frames, +1 on commit, undo restores, cancel reverts) are worth exactly what they claim. The problem is confined to the four classification and clamping assertions that stand in for the TypeScript.

### 4.3 The face hit-test ignores occlusion

The push/pull mousedown handler builds its raycast list from walls only, and returns early:

```ts
// src/components/viewport/Viewport3D.tsx:830-854
// Phase 7: Face push/pull gesture on wall
if (activeTool === 'select' && !activeDragGripRef.current) {
  let faceToPush = hoveredFace;
  if (!faceToPush) {
    const wallMeshes = Array.from(threeMeshesRef.current.values()).filter((m) =>
      m.userData?.ifc_class === 'IfcWall' || m.userData?.ifc_class === 'IfcWallStandardCase'
    );
    const intersects = raycaster.intersectObjects(wallMeshes, false);
    if (intersects.length > 0) {
      faceToPush = detectWallFaceHover(intersects[0], elements);
    }
  }
  if (faceToPush && elements[faceToPush.guid]) {
    ...
    beginDrag(`Push/Pull ${faceToPush.label}`);
    return;
  }
}
```

The general selection path immediately below it ([`:856-864`](../src/components/viewport/Viewport3D.tsx#L856-L864)) intersects *all* meshes and takes `intersects[0]` — the nearest object overall. The new block queries a filtered subset, so its `intersects[0]` is the nearest **wall**, which need not be the nearest object. Any ray that passes through any wall is therefore captured by push/pull even when a slab, roof, or other non-wall mesh is in front of it, and the click both starts a gesture and (on release) selects the occluded wall. By construction, this is a selection regression.

I could not confirm the severity of the opening case without a browser, and I want to be explicit about the boundary of what I verified. Openings are cut as real IFC voids ([`feature.add_feature` at `ifc_service.py:2293`](../backend/ifc_service.py#L2293) and [`:2433`](../backend/ifc_service.py#L2433)), so a ray through a door or window panel passes through the void and misses the wall mesh — that case is probably fine. Rays that clip the wall *around* an opening, and any non-wall element anywhere in the ray, are not. **This needs a browser pass, and I did not do one.**

### 4.4 Every wall click now opens a bus drag session

`beginDrag` fires during mousedown, before any pointer movement ([`Viewport3D.tsx:850`](../src/components/viewport/Viewport3D.tsx#L850)), and a release within 5 px cancels it ([`:1109`](../src/components/viewport/Viewport3D.tsx#L1109)). The note's claim — "drags ≤ 5 px cancel cleanly without creating transactions or dirtying model rev" — is true as far as it goes: no transaction is created, and the wobble threshold is correct. Two consequences the note does not mention:

**(a) A stranded session is reachable, and Phase 7 puts it on the default gesture.** `beginDrag` is async and **not awaited**, so `activeDragSessionId` is set only after its `fetch` resolves. `endDrag` bails out if it has not landed yet:

```ts
// src/store/useBimStore.ts:3014-3016
endDrag: async (commit = true) => {
  const dragSessionId = get().activeDragSessionId;
  if (!dragSessionId) return null;      // no cleanup; beginDrag may still resolve later
```

If the user releases before `beginDrag` resolves, `endDrag(false)` returns early and does nothing — and then `beginDrag` resolves and assigns a live session id. From that point `dispatchTransaction` routes *every* mutation into `/drag/update` ([`useBimStore.ts:2945-2977`](../src/store/useBimStore.ts#L2945-L2977)), which means no `rev` advance, no journal entry, and no undo entry, until some later gesture happens to begin and end a session. The window is short (one localhost round trip) but it is not zero, and it is a silent correctness failure rather than a visible one.

This pattern is **inherited**, not invented: the Phase 3 grip overlay at [`Viewport3D.tsx:1349-1354`](../src/components/viewport/Viewport3D.tsx#L1349-L1354) and the 2D grips at `PlanViewport2D.tsx:2238/2254` have the same un-awaited shape. What Phase 7 changes is exposure: previously the race required a deliberate click on a small grip target; now it is triggered by *any* click on any wall face, which is the application's most common interaction. I would fix it as part of closing Phase 7 rather than treat it as pre-existing and out of scope.

**(b) A selection click now costs a full model snapshot.** Per §3.2 and §10.4, `begin_drag` captures one O(model) snapshot including IFC STEP serialisation. Plan §6 forbids per-*frame* snapshots, not per-gesture ones, so this is not a violation — but a plain selection click becoming a gesture is a real interaction cost that the phase does not measure and the note does not mention.

### 4.5 No performance evidence

Plan §8 ([plan:281](IMPLEMENTATION-PLAN-direct-manipulation.md#L281)), "Phase 2 onward":

> during a drag, `globalThis.__bimworksRefresh.engine.p95` stays under 8 ms on the 250-wall fixture with `slice2d` suppressed; record it in `docs/DELTA-MEASUREMENT.md` alongside the existing corpus.

Neither commit touches `docs/DELTA-MEASUREMENT.md`; a repository-wide grep for `p95` finds it only in review documents, never in `test_drag_session.py`; and no 250-wall fixture exists in the drag or push/pull suites. Plan §10.1 already lists "the real per-frame cost of a viewed-level drag" as an open unknown, so this was known to be unmeasured — but Phase 7 adds a *new* per-frame path (a raycast plus a plane intersection plus a projected HUD badge, all outside React state, plus the per-frame `/drag/update` round trip) and §8's budget applies to it. The instrumentation to answer this already exists and separates `client` from `engine`; the measurement was simply not taken. This is also the one obligation Phases 7–8 share with the revit-feel plan, which frames the same §19 budget at 16 ms ([`revit-feel:73`](IMPLEMENTATION-PLAN-revit-feel.md#L73)).

---

## 5. The systemic cause, stated plainly

The two defects that matter most are not failures of skill — they are failures of *evidence*, and they share one shape. In both cases the requirement was verified at the layer where the author was working, and the layer where it is actually consumed was outside the assertion:

- **B8 "clamps and explains"** is asserted on `clamp_wall_end`'s local return value ([`test_validity_predicates.py:263`](../scratch/test_validity_predicates.py#L263)); the sentence is lost two layers up, in `ifc_service` and the bus envelope.
- **Phase 7's classification and clamping** are asserted on a Python mirror ([`test_face_pushpull.py:35,86`](../scratch/test_face_pushpull.py#L35)); the shipped TypeScript diverges, and the tolerance is wide enough to hide it.

Plan §7.8 states the principle: *"Green gates are not coverage. 355 assertions passed (618 at `ec2c99c`) while the first-run plan rendered empty, dimensions could not be created from the UI, and a locked dimension silently produced wrong geometry."* Phases 7 and 8 add 94 green assertions in exactly that tradition. The remedy is not more assertions; it is assertions with the right **authority** — one that reaches the user-facing outcome, and that fails when the artefact drifts. §8 below is ordered accordingly.

---

## 6. Checked and found sound, so the record is not one-sided

Things I specifically tested for and could *not* fault, listed so a later reader does not redo them:

1. **The clamp arithmetic in both directions.** `end == "start"` is handled, not just `end == "end"`; the degenerate case (drag onto the fixed point) falls back to the current baseline direction; the result is a point at exactly `min_len` from the fixed end.
2. **The opening width driving the clamp is real, not a fallback.** The `get("width", 3.0)` fallback exists in `validity.py`, so I checked: `add_door` stores `width: 3.0` in `element_meta`, and the observed `min_len` of `13.0` equals `offset 10.0 + width 3.0`. The fallback is not masking missing data here.
3. **Undo/redo mementos record the clamped value, not the requested one** ([`command_bus.py:1167-1173`](../backend/command_bus.py#L1167-L1173), `final_pt` / `final_off`). A clamped drag undoes to the pre-drag state, not to the never-applied requested state.
4. **`clamp` defaults to `False`.** Non-gesture callers (palette, AI driver, scripts) get refusal rather than silent clamping, which respects §3.5's framing of clamping as a *gesture* behaviour.
5. **No whole-model validity on the interactivity path** (§6 explicitly forbids it). Every predicate added is local: O(1) coordinate checks, O(openings on one wall), O(vertices in one polygon).
6. **The `Sketch` fix is load-bearing, not cosmetic.** `closed_loops()` feeds `is_closed()` feeds `validate()`, and `validate()` is called on two real create paths ([`ifc_service.py:968`](../backend/ifc_service.py#L968), [`:1073`](../backend/ifc_service.py#L1073)), not merely defined.
7. **The engine-level drag-session assertions are real integration tests** against `CommandBusEngine`, not mirrors: real `rev` tracking, real journal, real undo/redo, real cancel-and-revert.
8. **Both new suites are wired into `npm run check`** rather than being scratch probes that never run in CI ([`check-python-suites.mjs:38-39`](../scripts/check-python-suites.mjs#L38-L39)).
9. **The `clamp: true` wiring is complete on the grip path** — `wall_start`, `wall_end`, and `opening_offset` all propagate through `computeGripDragCommand` ([`grips.ts:414,438,516`](../src/interaction/grips.ts#L414)) and through the store actions ([`useBimStore.ts:2288-2300`](../src/store/useBimStore.ts#L2288-L2300)).

---

## 7. Requirement-by-requirement table

| Plan requirement | Source | Status |
|---|---|---|
| Order `P6 → P8 → P7` | §5 dependency order | **met** |
| One module `backend/validity.py` | §5 Phase 8 | **met** |
| Thickness > 0, minimum 1 inch | §5 Phase 8, §3.5 | **met in the engine; uncommittable from the UI** (§3.4) |
| Wall height > 0 | §5 Phase 8 | **met on edit; absent on create** |
| Wall longer than its hosted openings | §5 Phase 8 | **met on edit** |
| Opening inside its host | §5 Phase 8 | **met on edit; absent on create** |
| Footprint area > 0, ≥ 3 vertices | §5 Phase 8 | **met on edit; absent on create** |
| Finite coordinates | §5 Phase 8 | **met** |
| Used by **both** the create and edit paths | §5 Phase 8 | **not met — edit only** (§3.2) |
| `Sketch.validate()` rejects open chains | §5 Phase 8 | **met** (§3.5) |
| Clamp **and explain** | §3.5, §8 gate B8 | **half met — explanation discarded** (§3.3) |
| Face hover → thickness; top face → height | §5 Phase 7 | **met** |
| Grips emit parameters, not geometry | §3.1 | **met** |
| One snapshot / one journal entry per gesture | §3.2, §3.4 | **met at engine level; client race can defeat it** (§4.4a) |
| Numeric entry during and after the gesture | §5 Phase 4, Phase 7 | **met** |
| No whole-model validity on interactivity path | §6 | **met** |
| Each gate must be able to fail | §8 | **not met for Phase 7's classification/clamp gate** (§4.2) |
| Drag `engine.p95` < 8 ms, recorded in `DELTA-MEASUREMENT.md` | §8 performance gate | **not met** (§4.5) |

---

## 8. Remediation, in the order I would do it

1. **Make the thickness floor one number in one place** (§3.4). Either export `MIN_THICKNESS_FT` to the client (a generated constant or a `/api/validity/limits` read) and use it in `grips.ts` and `pushpull.ts`, or relax the engine's comparison to a tolerance that admits a 3-decimal rounded inch. Do **not** re-round on the client in the direction that lowers the value — `pushpull.ts` is arithmetically right up to `.toFixed(3)`, so it should round *up* to the engine floor or not round at all. Add a negative control that feeds the client's declared floor through `WallSetThickness`.
2. **Carry `expl` out of `ifc_service` and onto the status path** (§3.3). Return it from `set_wall_end` / `set_opening_offset`, include it in the envelope at [`command_bus.py:642-651`](../backend/command_bus.py#L642-L651), and surface it through the existing `failureMessage`/`statusMessage` channel the plan names. Then move gate B8's assertion to the envelope.
3. **Extend the module to the create path** (§3.2). `WallCreate`/`SlabCreate`/`RoofCreate`/`DoorInsert`/`WindowInsert` get the same predicates, and the create schemas get `gt=0` bounds where a bound is sufficient. This is the phase's stated headline and it is the cheapest of the four.
4. **Give Phase 7's gate real authority** (§4.2). Either drive the TypeScript (a Node test importing `pushpull.ts`, as `check-snap-engine.mjs` already does for `snapEngine.ts`) or add the missing engine round-trip for the clamp floors. Delete the `1e-3` tolerance; assert exact values.
5. **Restore occlusion ordering** (§4.3). Intersect all meshes, take `intersects[0]`, and only then ask whether it is a wall face. Confirm with a browser pass that an opening, slab, and roof can each still be selected.
6. **Take the race and the snapshot cost off the selection click** (§4.4). Guard the release path so `endDrag(false)` cannot be skipped by an in-flight `beginDrag`, and consider deferring `beginDrag` until the wobble threshold is crossed — which would also remove the O(model) snapshot from a plain selection.
7. **Measure the drag** (§4.5), record it in `docs/DELTA-MEASUREMENT.md` with the corpus and the `slice2d` state, and add the assertion to `test_drag_session.py`.
8. **Correct the SHAs and the plan reference** in the hand-off (§2.1, §2.2), so the next reader starts from a valid anchor.

Items 1–4 are correctness; 5–7 are the evidence that would have caught 1–4.

---

## 9. Residual unknowns

1. **Whether the occlusion regression actually blocks selecting an opening.** The IFC voids suggest not; the general non-wall case suggests yes. This is a browser measurement, not a reading, and I did not take it.
2. **Whether the stranded-session race is reachable in practice.** It depends on the localhost round-trip time versus the fastest human click. The mechanism is certain from the code; the frequency is not.
3. **The real per-frame cost of a Phase 7 push/pull drag**, with the added raycast, plane intersection, projected HUD, and per-frame `/drag/update` — unmeasured, and §10.1's question is still open for the older paths too.
4. **Whether the create-path gap has already produced invalid elements in the shipped sample or a user file.** The sample imports through the IFC path, which is separate, so probably not — but nothing has checked.
5. **Whether `WallSetHeight`'s engine floor should be 0.5 ft** as the client declares, or merely `> 0` as `validate_wall_height` states. The two disagree today and only the client's is enforced on the gesture path.
6. **Whether `is_locked`-style design questions apply to clamping** — i.e. should a clamped drag leave the element *valid but not as dragged*, and does the journal need to record that a clamp occurred rather than a plain set. Today it records a plain set.

---

## 10. Provenance

**Read and executed at `d54f9b1`**, 2026-10-16. Reviewed commits `60ea794` (Phase 8) and `abc201c` (Phase 7); also touched `cdc6043` (Phase 6) because the §3.4 regression is against its grip ranges.

**Gates re-run, not quoted:** `npx tsc --noEmit` (exit 0); `npm run check:bus` (47 actions, 0 errors); `npm run check:ui` (130 checks); `npm run check:state` (45); `npm run check:delta` (21); `npm run check:snap` (34); `npm run check:py` (14 suites); `./.venv/bin/python scratch/test_validity_predicates.py` (48 passed); `./.venv/bin/python scratch/test_face_pushpull.py` (46 passed).

**Runtime probes** were run in-process against `BimModelManager` and `CommandBusEngine` with the repository venv, so every symptom quoted in §3.2, §3.3 and §3.4 is an observed result rather than a reading of the source: create commands with degenerate parameters; `set_wall_end` with `clamp=True` past a hosted door; the same through `execute_single_command` to inspect the envelope; and `WallSetThickness` at `0.083` / `0.0833` / `0.0834`. No file was written and no server was started, so there is no browser evidence in this review — §4.3 is the one finding that stays analytic for that reason, and it is marked as such.

**Symbols cited rather than lines, where the two could disagree.** Line numbers are pinned to `d54f9b1` and will drift; `backend/validity.py`, `src/interaction/pushpull.ts`, `src/interaction/grips.ts`, `detectWallFaceHover`, `computePushPullCommand`, `clamp_wall_end`, and `MIN_THICKNESS_FT` are the names to search for.

**Relationship to the rest of the review record.** This is the first review of the gesture layer; `review/AUDIT-viewport-interaction-vs-revit.md` and `review/REVIEW-ingetrazo-object-creation-and-editing-2026-10-15.md` cover the layer this plan ports from IngeTrazo `d8ee8c0`. The IngeTrazo mechanism this phase most directly ports — `SnapshotMutation`, preview-is-the-real-mutation, and numeric re-typing after commit (`tools/pushpull.py:2003-2050`, `tools/scale.py:566-590`) — is the part Phase 7 got right.
