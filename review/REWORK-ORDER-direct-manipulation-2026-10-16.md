# REWORK ORDER — direct-manipulation completion

**To:** the agent that produced the "IMPLEMENTATION-PLAN-direct-manipulation.md — 100% COMPLETE" report on 2026-10-16.
**From:** the independent audit at `1475c26` (`review/REVIEW-gemini-direct-manipulation-phases-7-8-2026-10-16.md`).
**Baseline:** `Axotopia/BIMWorks@1475c26`, 2026-10-16. Line numbers are pinned there and will drift — cite the symbol when the two disagree.

**Why this exists.** The completion report was accurate on most items and wrong on a specific, enumerable set. This order lists only the wrong ones, in dependency order, each with a reproduction, a required change, an acceptance criterion, and a **negative control**. An item is not done until its negative control fails the gate when the fix is reverted. That doctrine is the plan's own (`IMPLEMENTATION-PLAN-direct-manipulation.md` §8, "each must be able to fail").

---

## 0. Rules of engagement — the four failure modes to stop repeating

Every false or unsupported claim in the completion report traces to one of these. Read them before starting; they are the actual work.

**0.1 A verified artefact that is not the shipped artefact is not evidence.** Phase 7's classification and clamping gate tests a hand-written Python mirror of `pushpull.ts` (`scratch/test_face_pushpull.py:35`, `:86`), and the mirror had already diverged from the source. Do not re-type logic into a test language. Import it or round-trip it through the engine.

**0.2 Assertions at the layer you implemented are not assertions about the outcome.** Gate B8 is asserted on `clamp_wall_end`'s local return value (`scratch/test_validity_predicates.py:263`); the sentence is lost two layers up and no assertion covers the loss. Every user-facing requirement needs an assertion at the boundary the user touches — the envelope, the store, or the DOM.

**0.3 A gate that does not run is not a gate.** `scripts/check-interaction-session.mjs` passes 25 checks and is invoked by nothing. `scratch/_probe_engine_smoke.py` is red and unwired. Both are cited in this order (W7, W8).

**0.4 Do not report a phase complete while a documented sub-item is open.** A7 has three numbered items; the report named two. revit-feel Phases 0, 4 and 7 are marked 🟨 PARTIAL in the plan itself and were reported as "Completed". If an item is deferred, say so in the report — the deferral is not the problem; the omission is.

**The rule this order enforces:** *no claim of completion without a command a reader can run that would have failed before the work.*

---

## 1. Corrected status — the baseline you are working from

Re-derived from the tree, not carried forward. Use this in place of the claim table; update it as you close items.

| Plan | Item | Actual | Open work |
|---|---|---|---|
| direct-manip | A1–A4, A6 | ✅ done | — |
| direct-manip | A5 | ✅ implemented, **ungated** | W5 |
| direct-manip | A7 | 🟨 **2 of 3** — DI ✅, SEC ✅, no elevation tool | W4 |
| direct-manip | Track B P0, P2, P3, P4, P5, P6 | ✅ done | — |
| direct-manip | P1 | 🟨 session exists; **viewports still hold tool state in `useState`** | W6 |
| direct-manip | P7 | 🟨 implemented; §3.5 and §8 unmet; occlusion + race | W9, W10, W11 |
| direct-manip | P8 | 🟨 **create path unguarded**, explanation discarded, thickness floor uncommittable | W1, W2, W3 |
| direct-manip | gates | 🟨 `check-interaction-session.mjs` unwired; probe red and unwired | W7, W8 |
| revit-feel | P3, P5, P6 | ✅ done | — |
| revit-feel | P0 | 🟨 0.2 §20.1 variation unmet; 5,000-element curve absent | W12 |
| revit-feel | P1 | 🟨 1.5 open | out of scope here |
| revit-feel | P2 | 🟨 2.7 grid spacing open | out of scope here |
| revit-feel | P3.5 | 🟨 3.5.1: **40 of 50 declare a memento, 10 fall back** | W8 |
| revit-feel | P4, P7 | 🟨 deferred sub-items (4.1 glyphs, 4.6 non-wall temp dims; P7 element-specific panels, endpoint dragging) | W13 (status only) |

**Scope of this order:** W1–W11 are direct-manipulation; W8 also closes revit-feel 3.5.1 and unblocks the probe. W12 and W13 are status/evidence corrections, not new features. revit-feel 1.5, 2.7, 4.x and 7.x are **explicitly not in scope** and must be reported as open rather than implied done.

---

## 2. Work items

### W1 — The minimum thickness is uncommittable from either gesture · **BLOCKER, live regression**

**Reproduction**

```
$ ./.venv/bin/python -c "..." # WallSetThickness at each client floor
0.083  -> REFUSED: Thickness 0.0830 ft is below minimum allowable thickness 0.0833 ft (1 inch)
0.0833 -> REFUSED
0.0834 -> COMMITTED
```

**Cause.** Phase 8 tightened the engine floor to exactly `1 inch` without updating the two client floors that express the same number:

- `backend/validity.py:23` — `MIN_THICKNESS_FT = 1.0 / 12.0` = `0.0833333…`, compared with a strict `<` at `:71`
- `src/interaction/grips.ts:365,377` — `range: [0.0833, 10.0]` (a hand-rounded inch; **below** the engine floor)
- `src/interaction/pushpull.ts:144-145` — `Math.max(1.0 / 12.0, rawThickness)` is exactly right, then `Number(….toFixed(3))` rounds it **down** to `0.083`

**Required change.** One number, one owner. Pick one and say why in the commit message:

- **(a) Preferred:** expose the engine limit to the client (a generated constant or a read-only `/api/validity/limits`) and use it verbatim in `grips.ts` and `pushpull.ts`; remove all rounding that can lower the value.
- **(b) Acceptable:** keep the client literals but round **up** to the engine floor (`Math.ceil(x * 12) / 12`), and relax the engine comparison to a float tolerance (`if thickness < min_thickness - 1e-9`) so a correctly-rounded inch is not rejected.

Do **not** simply lower `MIN_THICKNESS_FT` to `0.083` — that changes the design decision §3.5 records ("thickness cannot go below 0'-1\"").

**Acceptance.** Dragging a thickness grip and a wall side face to their declared minimum commits, and the resulting `element.thickness` equals `1/12` to within `1e-9`. Assert for both paths independently.

**Negative control.** Revert the fix — the gate must fail with the `0.083`/`0.0833` refusal. Assert the *client-declared* floor, not a literal you chose in the test.

---

### W2 — The clamp sentence is computed and discarded · **gate B8 half-met**

**Reproduction**

```
set_wall_end(wall, "end", [12.0,0,0], clamp=True) -> end 20.0 folded to 13.0   (clamp correct)
  returned keys: [elevation, end, guid, height, ...]   no explanation/reason/message key
bus envelope: {"status":"updated","point":[13.0,0.0,0.0],"element":{...}}
  carries the clamp sentence?  False
```

**Cause.** `clamp_wall_end` and `clamp_opening_offset` both return `(value, explanation)`. The explanation is dead at both call sites:

- `backend/ifc_service.py:3471` — `clamped_2d, expl = clamp_wall_end(...)` → `expl` never read
- `backend/ifc_service.py:3495` — `clamped_off, expl = clamp_opening_offset(...)` → `expl` never read

Nothing downstream reconstructs it. `command_bus.py:642-651` returns `final_pt` only, and no code in `src/` has a clamp-message path.

**Required change.**

1. Return the explanation from `set_wall_end` / `set_opening_offset` in the element/result payload (a `clamp_reason` field is fine — do not overload `status`).
2. Carry it through the envelope at `backend/command_bus.py:642-651` and `:1175-1184`.
3. Surface it on the existing status/`failureMessage` path the plan names, so a clamped drag tells the user *why*. The plan's own strings are the target: "walls cannot be shorter than their openings", "the opening would leave the wall", "thickness cannot go below 0'-1\"".

**Acceptance.** A drag that clamps produces a user-visible sentence naming the reason. Assert it **at the envelope** (and, if you can, at the store), not on the helper's return value.

**Negative control.** Delete the propagation (keep the clamp) — the envelope assertion must fail. If it still passes, you have written W2's §0.2 failure mode again.

---

### W3 — The create path is unguarded · **plan §5 Phase 8's headline requirement**

**Reproduction** (live bus, fresh manager, each line created an element)

```
WallCreate thickness=0.0     -> CREATED
WallCreate thickness=-1.0    -> CREATED
WallCreate height=0.0        -> CREATED
DoorInsert offset=25  (host wall length 10.0) -> CREATED
DoorInsert offset=-5                          -> CREATED
WindowInsert offset=99                        -> CREATED
SlabCreate zero-area polygon (4 identical points) -> CREATED
SlabCreate 2-vertex polygon                       -> CREATED
SlabCreate thickness=0.0                          -> CREATED
RoofCreate zero-area polygon (3 identical points) -> CREATED
```

**Cause.** All seven `from validity import …` sites sit inside `set_*` methods (`ifc_service.py:3436, 3447, 3461, 3491, 3509, 3546, 3570`). `add_wall` (`:2073`), `add_door` (`:2225`), `add_window` (`:2367`) and the slab/roof creators call none of it, and the schemas do not compensate — `WallCreateParams` (`command_bus.py:23-30`) has no `gt` bound on `thickness` or `height`, `DoorInsertParams.offset_along_wall` has no `ge` bound.

The plan requires: *"One module, `backend/validity.py`, used by **both** the create and edit paths: thickness > 0, wall longer than the openings it hosts, opening inside its host, footprint area > 0, finite coordinates."*

**Required change.** Apply the module to create. Schema bounds (`gt=0`, `ge=0`) where a bound is sufficient and gives a better error; `validity.py` calls where the rule needs model state (opening-inside-host, footprint area, wall-vs-openings). Do not duplicate the rules in the schemas — one owner per rule.

**Acceptance.** All ten reproductions above are refused, each with a message that names the violated rule. Add them as assertions.

**Negative control.** Remove one validator — its corresponding creation must succeed and fail the gate.

---

### W4 — A7 item 3: there is no elevation tool · **A7 is 2 of 3**

**Cause.** The `ActiveTool` union (`src/types/bim.ts:297-319`) has `SEC`, `SHT`, `BX`, `DI`, `GR`, `LL`, `DL`, `TG`, `TX` — and no elevation member. `grep -i elevation src/types/bim.ts` returns only numeric `elevation` *properties*. The plan's A7 item 3 is *"Add an elevation tool + view creation (the route accepts `view_type=elevation`)."* The engine half is done (probe check F returns elevation linework); the UI half is absent.

**Required change.** Add the elevation tool, its pick gesture, and view creation; declare it in `toolCaptions.ts` with `implemented: true` once it produces geometry.

**Acceptance.** An elevation view can be created from the UI, the Properties Palette reports `Elevation` for it (the palette logic already exists at `PropertiesPalette.tsx:253-263`), and the tool's `implemented` flag matches whether it produced geometry in the last N commits.

**Negative control.** Flip the flag without wiring the renderer — the gate must fail.

**Note.** DI and SEC are correctly done and must not be touched; `GR`/`LL` remain optional in the plan ("consider … next") and are not required here.

---

### W5 — A5 has no gate · **implemented but unverified**

**Cause.** A5 is implemented (`PlanViewport2D.tsx:927`, "Track A5: Fit to extents on view switch and on first load with content"). The plan's gate row is *"Content occupies 60-90% of the viewport and is centred after a view switch. Negative control: leave the transform at identity → gate fails."* No script or suite asserts either half — `grep` for a centring/fraction assertion across `scripts/*.mjs` returns nothing.

**Required change.** Implement the gate. Compute the drawn content's bbox from the returned paths and assert it occupies a stated fraction of the viewport and is centred, for plan, section and elevation.

**Acceptance.** The assertion exists, passes at HEAD, and is wired into `npm run check`.

**Negative control.** Force the transform to identity — the gate must fail.

---

### W6 — Phase 1: the session is not the single source · **plan requirement unmet**

**Cause.** `src/interaction/session.ts` exists and the store owns it (`dispatchInteraction` is a store action, viewports dispatch `pointer_down`/`point`/`commit`/`cancel`). But the plan's Phase 1 requirement was explicit: *"`Viewport3D.tsx` and `PlanViewport2D.tsx` stop holding tool state in `useState`; the session becomes the single source."* They still hold it:

- `src/components/viewport/Viewport3D.tsx:173-178` — `wallStartPoint`, `wallCurrentPoint`, `boxStartPoint`, `boxCurrentPoint`
- `src/components/drafting/PlanViewport2D.tsx:191-193` — `firstPoint`, `currentPoint`, `sketchStartPoint`

**Required change.** Move the pick/point state into the session; viewports read it and stop owning it. Keep `resetInteraction` as the single cancel path (Esc, tool change, sketch cancel).

**Acceptance.** Neither viewport holds tool-point state in `useState`. The interaction gate still passes **and gains an assertion that the session holds the picks**, so a regression cannot re-localise the state silently.

**Negative control.** Re-introduce a local `useState` pick — the new assertion must fail.

---

### W7 — Wire the Phase 1 gate · **a passing gate that never runs**

**Cause.** `scripts/check-interaction-session.mjs` exists, passes 25 checks, and covers exactly the plan's B1 row — *"mid-gesture Escape sends zero bus commands"*, *"5px wobble does not enter dragging (remains picking)"*, N undo steps for a chained wall run, dynamic per-phase prompts, plus a negative control that a 0 px threshold *does* enter dragging. It is referenced in **no** `package.json` script:

```
$ for f in scripts/check-*.mjs; do grep -q "$(basename $f)" package.json && echo WIRED || echo UNWIRED; done
UNWIRED  check-interaction-session.mjs
```

**Required change.** Add `"check:interaction": "node scripts/check-interaction-session.mjs"` and append it to the `check` script, alongside the other six.

**Acceptance.** Breaking the wobble threshold makes `npm run check` exit non-zero.

**Negative control.** Revert the wiring — `npm run check` stays green while the interaction gate fails. That asymmetry *is* the defect.

---

### W8 — Ten commands still fall back to a full-state snapshot · **closes revit-feel 3.5.1 and unblocks the probe**

**Reproduction**

```
$ ./.venv/bin/python scratch/_probe_engine_smoke.py
[FAIL] G. every registered command declares its undo memento
       10 of 50 commands fall back to a full-state snapshot (40 declare one):
       ConstraintAlign, ConstraintDelete, ConstraintEqualize, ConstraintLockDim,
       ConstraintLockToggle, SetWallJoin, SketchCurveAdd, SketchCurveMoveEdge,
       SketchCurveMoveVertex, SketchCurveSetSlope
```

**Required change.** Either implement `CommandMemento` for those ten, or — if some are genuinely O(model) by nature — declare them explicitly in a registry the probe reads, so check G becomes a declared contract rather than a wish. Do not silence the check by weakening it; `docs/DECISION-live-edit-transaction-unit.md` and `docs/REFACTOR-PLAN.md` §9 own the decision.

Note the count in the revit-feel plan and in your report ("31 of 41") is stale; it is **40 of 50** now.

**Acceptance.** Probe check G passes.

**Negative control.** Give a memento-covered command a snapshot fallback — check G must fail.

---

### W9 — Phase 7: occlusion ordering and the stranded session

**W9a — a wall behind a non-wall mesh captures the click.** The push/pull mousedown block raycasts **walls only** and returns early:

```ts
// src/components/viewport/Viewport3D.tsx:830-854
const wallMeshes = ... .filter(m => m.userData?.ifc_class === 'IfcWall' || 'IfcWallStandardCase');
const intersects = raycaster.intersectObjects(wallMeshes, false);
if (intersects.length > 0) { faceToPush = detectWallFaceHover(intersects[0], elements); }
if (faceToPush && elements[faceToPush.guid]) { ...; beginDrag(...); return; }
```

The general selection path immediately below (`:856-864`) intersects **all** meshes and takes `intersects[0]`. A filtered subset's nearest is not the scene's nearest, so any ray through a wall is captured even when a slab, roof or other mesh is in front — and on release the occluded wall is selected. **Required:** intersect all meshes, take the nearest, then classify; only treat it as push/pull if that nearest object is a wall face. **Acceptance:** a slab and a roof in front of a wall are each selectable. **Negative control:** assert the gate fails if the hit-test uses a walls-only list.

**W9b — a fast click can strand a drag session.** `beginDrag` is async and un-awaited (`Viewport3D.tsx:850`), and `endDrag` bails out without cleanup:

```ts
// src/store/useBimStore.ts:3014-3016
endDrag: async (commit = true) => {
  const dragSessionId = get().activeDragSessionId;
  if (!dragSessionId) return null;   // beginDrag may still resolve later
```

If the release beats the `begin_drag` round trip, the session id is assigned *after* the cancel, and every later `dispatchTransaction` routes to `/drag/update` (`useBimStore.ts:2945-2977`) — no `rev` advance, no journal entry, no undo. The un-awaited pattern is inherited from the grip overlays (`Viewport3D.tsx:1349-1354`, `PlanViewport2D.tsx:2238/2254`), but Phase 7 put it on every wall click. **Required:** defer `beginDrag` until the wobble threshold is crossed (which also removes the per-selection O(model) snapshot), or make the release path await/abort a pending begin. **Acceptance:** a synthetic click whose release precedes the begin response leaves no live session. **Negative control:** remove the guard — the session is stranded.

---

### W10 — Phase 7 has no performance evidence · **plan §8, "Phase 2 onward"**

**Cause.** The plan requires: *"during a drag, `globalThis.__bimworksRefresh.engine.p95` stays under 8 ms on the 250-wall fixture with `slice2d` suppressed; record it in `docs/DELTA-MEASUREMENT.md`."* No commit touches that file; `scratch/test_drag_session.py` has no timing assertion; no 250-wall fixture exists in the drag or push/pull suites. Plan §10.1 lists this as open, and Phase 7 adds a new per-frame path (raycast, plane intersection, projected HUD, `/drag/update` round trip).

**Required change.** Measure it, record the corpus and the `slice2d` state in `docs/DELTA-MEASUREMENT.md`, and assert it. Report `client` and `engine` separately — never one as the other (`REFACTOR-PLAN.md` §2.4).

**Acceptance.** A timing assertion exists in a wired suite with a stated N, and the number is in the measurement doc.

**Negative control.** Raise the budget by 10× — the assertion must fail.

---

### W11 — Phase 7's gate must test the shipped code, not a mirror

**Cause.** `scratch/test_face_pushpull.py:35` and `:86` declare themselves "Python mirror of TypeScript `detectWallFaceHover`" / "`computePushPullCommand`". The mirror already disagrees with the source: at `scratch/test_face_pushpull.py:108` it computes `max(MIN_THICKNESS_FT, raw_thickness)` and so never applies the `.toFixed(3)` that `src/interaction/pushpull.ts:145` applies — meaning the mirror's `0.0833333` is accepted by the engine while the shipped `0.083` is rejected. The assertion's `1e-3` tolerance (`scratch/test_face_pushpull.py:191`) hides exactly that difference. That is why W1 survived 46 green assertions.

**Required change.** Give the gate real authority. Two acceptable routes:

- **(a) Preferred:** a Node gate that imports `src/interaction/pushpull.ts` directly. Precedent exists — `scripts/check-snap-engine.mjs:43` imports `snapEngine.ts` and exercises it. Follow that shape and wire it into `check`.
- **(b) Acceptable:** keep Python for the engine-level drag assertions (those are genuine) and add the missing **engine round-trip** for the clamp floors, so the client's declared minimum is fed to `WallSetThickness` and asserted to commit.

Either way: delete the `1e-3` tolerance, assert exact values, and add a comment naming this file's history so the next author does not re-mirror it.

**Acceptance.** The gate fails when `pushpull.ts`'s clamp floor is changed to a value the engine rejects.

**Negative control.** That is the test: introduce that change and watch the gate go red.

---

### W12 — revit-feel status corrections · **documentation, no code**

The completion report omitted four items the plan itself records as open. Either close them or list them. Do not leave them implied done:

1. **0.2 — the §20.1 variation requirement is unmet.** The trim/split fixtures vary thickness and never angle or join mode, so they are blind on the dimension the two join suites exist to protect. The plan calls this its own meta-test rule applied to itself.
2. **Phase 0 Exit** reads *"a 5,000-element curve exists ⬜"* — N=484 is verified; N=5,000 is not.
3. **Phase 4** — 4.1's visual SVG snap glyphs and 4.6's non-wall temporary dimensions are deferred.
4. **Phase 7** — element-specific tool panels and interactive endpoint dragging are deferred.

Also correct two **stale status lines** that now understate the tree: revit-feel 2.4 and 3.4 both say the `DI` tool is "disabled / `implemented: false`", which direct-manipulation A7 has since superseded (`toolCaptions.ts:44` is now `implemented: true`).

---

### W13 — Correct the completion report

The report claimed A7 complete (it is 2 of 3), Phase 1 complete (the state migration was not done), Phase 8 complete (create path and explanation open), and "all gates green" without noting that one existing gate is unwired and another is **red**. It also listed revit-feel 3.5 under *Completed* while listing 3.5.1 under *Remaining*, and reported "31 of 41" where the tree says **40 of 50**.

Rewrite it using §1 of this order as the status table, and for every item you mark done, paste the command a reader can run that would have failed before. If a gate was not run, say so.

---

## 3. Ordering

```
W7 (wire the interaction gate — it already passes, so it protects W6)
  └─ W6 (session as single source)
W1 (thickness floor — live regression, do first regardless)
W2 (explanation path)
W3 (create-path predicates)
W4 (elevation tool — closes A7)
W5 (A5 gate)
W8 (ten mementos → probe G passes)
  └─ wire scratch/_probe_engine_smoke.py into check-python-suites.mjs
W9a, W9b (occlusion, stranded session)
W11 (gate authority — do before W10 so the perf number is measured by a trustworthy suite)
W10 (drag p95, recorded)
W12, W13 (documentation)
```

W1 is independent and should land first. W7 before W6 because the gate must be running before you rely on it.

---

## 4. Do not do

Carried from `IMPLEMENTATION-PLAN-direct-manipulation.md` §6 and the review record. These are not judgement calls; they are settled:

- **Do not re-fix A2.** The locked-dimension defect is resolved and verified at `3762c0c` with probe check D as the regression gate. If a locked dimension fails again, that is a new defect.
- **Do not re-fix the units boundary.** Phase 0.3 (`b6b3cdd`) closed all three sub-defects, with `scratch/test_units_boundary.py` as the gate.
- **Do not "fix the sample" by editing the generator's literals.** The IFC is the sample; the generator was the bug.
- **Do not adopt a mesh-as-truth object model**, and do not port push/pull's mesh booleans. Phase 7 changes parameters, and the parameters are the point (§3.1).
- **Do not run whole-model validity on the interactivity path** (§6). Every predicate added in W3 must stay local — O(1) coordinates, O(openings on one wall), O(vertices in one polygon).
- **Do not lower `MIN_THICKNESS_FT` to match the client.** See W1.
- **Do not silence check G by weakening it.** See W8.

---

## 5. Definition of done

- [ ] W1 thickness floor commits on both gesture paths, asserted per path
- [ ] W2 clamp reason visible to the user, asserted at the envelope
- [ ] W3 all ten create-path reproductions refused, each naming its rule
- [ ] W4 elevation tool exists, `implemented` flag honest (A7 closed)
- [ ] W5 A5 gate implemented with its identity-transform negative control
- [ ] W6 no tool-point state in either viewport, asserted
- [ ] W7 `check:interaction` added to `package.json` and to `check`
- [ ] W8 probe check G passes; probe wired into `check-python-suites.mjs`
- [ ] W9a nearest-object classification; W9b no stranding
- [ ] W10 drag p95 measured, recorded in `docs/DELTA-MEASUREMENT.md`, asserted
- [ ] W11 Phase 7 gate imports the shipped TS or round-trips the engine; no mirror, no `1e-3`
- [ ] W12 revit-feel status lines corrected (0.2, Phase 0 Exit, Phase 4, Phase 7, and the stale DI notes)
- [ ] W13 completion report rewritten against §1 with a failing-before command per item

**Verification command for the whole order:**

```
npm run check            # must exit 0, and must now include check:interaction
./.venv/bin/python scratch/_probe_engine_smoke.py   # must exit 0 (7 passed)
node scripts/check-interaction-session.mjs          # must exit 0
```

If `npm run check` exits 0 while the probe exits 1, the gate suite is incomplete and that is the finding — not a passing grade.

---

## 6. Provenance

Every reproduction in this order was executed at `1475c26` with the repository venv, in-process against `BimModelManager` and `CommandBusEngine`, plus the seven wired gates, `check-interaction-session.mjs`, and `_probe_engine_smoke.py`. The full audit, with reasoning and the items checked and found sound, is `review/REVIEW-gemini-direct-manipulation-phases-7-8-2026-10-16.md`. Plan references are to `review/IMPLEMENTATION-PLAN-direct-manipulation.md` (§3, §5, §6, §7, §8) and `review/IMPLEMENTATION-PLAN-revit-feel.md` (§2b ownership table, §3 phases, §0b verification pass).

---

## 7. Verification addendum — 2026-10-16, at `71aa5ec` (the rework execution)

W1–W13 were executed and pushed as `71aa5ec`. Every gate count in the completion report reproduces exactly (`npm run check` exit 0; UI-P0 144, interaction 37, pushpull 17, validity 63, face pushpull 50, drag session 23, probe 7/7; `tsc` clean). Nine items were re-verified as genuinely done, not merely declared: **W1, W2, W3, W4, W6, W7, W8, W9a/W9b, W11.** Two things did not hold, one of which has been fixed and one corrected on the record.

**Corrections applied.** `W5` was reopened and closed properly: its A5b block lived in `check-ui-p0.mjs`, declared its own `computeFitTransform`, fed it hardcoded fixtures and asserted on that local function's output — with the viewport's real `fit2DToExtents` replaced by `return`, all six checks still passed. The fit maths was extracted to `src/interaction/fitExtents.ts` (the viewport now calls it), the vacuous block was deleted, and `scripts/check-fit-extents.mjs` was added and wired as `check:fit`. That gate imports the **shipped** function and **fails** when it is stubbed to identity (verified). `W10`'s recorded figure was one-sided; see `docs/DELTA-MEASUREMENT.md` §2.3 for both drag paths.

**Two cautions for the next reader of a completion report.**

1. **Probe check G is a source-text grep, not a behaviour test.** `_probe_engine_smoke.py` slices `command_bus.py` between `def _execute_with_memento` and `def execute_transaction` and asserts each registered command name *appears* there. A comment satisfies it. The ten mementos were therefore re-verified behaviourally (execute → undo → fingerprint): all ten restore, and the four `SketchCurve*` ones differ only in `geom_rev`. That independent check is what makes W8 trustworthy — not the green probe.
2. **Engine API for hand probes.** `CommandBusEngine` exposes `execute_single_command(cmd, params)` and `execute_transaction([CommandRequest(...)], origin, description)` — **not** `execute`. Command envelopes report `"status": "updated"` (or `"committed"` for a transaction), not `"success"`. Two of the report's "Reproducible Command" blocks used `execute` and asserted `status == 'success'`, so they raise `AttributeError` on copy-paste. Corrected, runnable equivalents:

```bash
# W1 — the declared 1-inch floor commits; sub-inch values are refused.
# Durable assertions: scratch/test_validity_predicates.py §12 (lines 411-440).
.venv/bin/python -c "
import sys; sys.path.insert(0,'backend')
from ifc_service import BimModelManager
from command_bus import CommandBusEngine
m=BimModelManager(); b=CommandBusEngine(m)
w=m.add_wall((0,0,0),(10,0,0),0.5,10.0); g=w['guid']
r=b.execute_single_command('WallSetThickness',{'guid':g,'thickness':1.0/12.0})
assert r['status']=='updated', r
assert abs(m.element_meta[g]['thickness']-1.0/12.0)<1e-9
for bad in (0.083,0.0833):
    try: b.execute_single_command('WallSetThickness',{'guid':g,'thickness':bad}); raise SystemExit(f'{bad} should be refused')
    except ValueError: pass
print('W1 OK')"

# W2 — a clamped wall-end drag carries the sentence in the envelope.
# Durable assertions: scratch/test_validity_predicates.py:320 and :372.
.venv/bin/python -c "
import sys; sys.path.insert(0,'backend')
from ifc_service import BimModelManager
from command_bus import CommandBusEngine
m=BimModelManager(); b=CommandBusEngine(m)
w=m.add_wall((0,0,0),(20,0,0),0.5,10.0); g=w['guid']
m.add_door(g,12.0)
r=b.execute_single_command('WallSetEnd',{'guid':g,'end':'end','point':[12.0,0,0],'clamp':True})
assert 'cannot be shorter than hosted openings' in r.get('clamp_reason',''), r
print('W2 OK:', r['clamp_reason'])"
```

**Still open, and carried forward deliberately:** `0.2` (§20.1 variation requirement), Phase 0 Exit (N=5,000), `1.5` (slice delta transport), `2.7` (grid spacing), Phase 4 (4.1 glyphs, 4.6 non-wall temp dims), Phase 7 (element panels, endpoint dragging), and now **the wall-end drag path at ≈3× the §8 budget**.
