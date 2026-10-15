# BIMWorks UI Shell vs. Autodesk Revit — Parity Audit

**Date:** 2026-10-14
**Branch:** `gemini`
**Scope:** UI shell only — `src/App.tsx`, `src/components/**`, `src/store/useBimStore.ts`, `src/index.css`, `src/interaction/toolCaptions.ts`, `index.html`, plus `package.json`/`vite.config.ts` where they bear on shell capability.
**Method:** every verdict below was established by reading the cited code. Negative claims carry an explicit "searched for X — 0 hits" note. The two gates were executed.

**Gate status (this session):**

| Gate | Command | Result |
|---|---|---|
| UI-P0 gate | `npm run check:ui` | **PASS — 130 checks, exit 0** |
| Types | `npx tsc --noEmit` | **PASS — no output, exit 0** |

**No gate failure was found, so there are no gate-failure findings.** This is itself a finding worth stating plainly: **the existing gate suite asserts almost nothing about Revit visual/interaction parity.** `scripts/check-ui-p0.mjs` is a correctness/truthfulness gate (units, error surfacing, the bus invariant, no-fake-claims). It contains no assertion about the Options Bar, tabs, split buttons, context menus, floating panels, selection count, or dialog fidelity. A shell could pass all 130 checks while looking nothing like Revit — and in the areas below, several do.

**Read-only compliance:** no source file was modified. This file is the only artifact created.

**Note on the working tree:** `git status` at the time of writing also shows `review/AUDIT-authoring-capability-vs-revit.md` and five `scratch/_probe_*.py` files as untracked. Those were **not** created by this audit and were present/parallel work; this audit touched no existing file.

---

## Summary table

| # | Area | Verdict | Highest-impact gap | Evidence |
|---|---|---|---|---|
| 1 | Ribbon | **PARTIAL** | 4 of Revit's 7 tabs; no split buttons; no "Modify \| Walls" contextual tab on element selection; no visible panel titles | `Ribbon.tsx:86`, `:95–132`, `:138–265`, `:434–656` |
| 2 | Hotkeys (two-letter) | **PARTIAL** | A real 3-char sliding buffer exists, but 11 of 22 listed Revit sequences are unbound — incl. the single most-used, `MV` | `useBimStore.ts:884–931`, `toolCaptions.ts:25–46` |
| 3 | Options Bar | **ABSENT** | No Options Bar exists; the "current tool options" surface Revit puts above the viewport does not exist | searched `OptionsBar`/`options bar` — 0 code hits; `Ribbon.tsx:448–462` |
| 4 | Type Selector | **PARTIAL (fake)** | The only "Type Selector" is a read-only `<div>`, not a dropdown; falls back to a hardcoded string | `PropertiesPalette.tsx:183–197` |
| 5 | Status Bar | **PARTIAL** | Contextual hints are real and honest, but there is no selection count anywhere | `StatusBar.tsx:144–164`; searched `selectedCount`/`elements selected` — 0 hits |
| 6 | Project Browser | **PARTIAL** | No right-click menus at all; no Elevations/Ceilings/Schedules/Legends/Groups/Links; drag-to-reorder is dead-ended | `ProjectBrowser.tsx:46–55, 61–63, 86–247`; searched `onContextMenu` — 2 hits, both `preventDefault` |
| 7 | Properties palette | **PARTIAL** | **N11 Area/Volume is genuinely fixed**; but Edit Type is 100% hardcoded and there is no Type/Instance split | `PropertiesPalette.tsx:407–417`, `geometry.ts:30–65` vs `EditTypeModal.tsx:35–58` |
| 8 | Contextual selection UI | **PARTIAL** | Selection is a flat colour swap with no blue outline and no grips; no drag-to-move in either viewport | `Viewport3D.tsx:428–429`, `PlanViewport2D.tsx:588`; searched `translateElement` in viewports — 0 hits |
| 9 | Dockable panels | **PARTIAL** | `dockview` genuinely used for docking; floating/popout/auto-hide exist in the library but are never enabled | `Workspace.tsx:1–153`; `node_modules/dockview/dist/dockview.js` contains `addFloatingGroup` (15), `addPopoutGroup` (19), `autoHide` (41) |
| 10 | Modal dialogs | **PARTIAL** | View Range is real but only writes 2 of its 4 fields; Edit Type is pure fiction; Georeference is fully real | `ViewRangeModal.tsx:46–78`, `EditTypeModal.tsx:35–58`, `GeoreferenceModal.tsx:53–70` |
| 11 | Visual language | **PARTIAL** | No context menu system at all; dark VS-Code palette, not Revit's light chrome; 2 dead CSS classes | `index.css:108–130`; searched `temp-dimension-line`/`-pill` in components — 0 hits |

**Headline:** the shell's *truthfulness* engineering is strong (the P0 gate is real, and N11 is genuinely fixed). Its *Revit resemblance* is the weak axis. The three largest structural absences are the **Options Bar**, **context menus**, and **contextual tabs** — all three exist in Revit as primary interaction surfaces and none exist here.

---

## 0. What the gates actually assert (and fail to)

`npm run check:ui` runs `scripts/check-ui-p0.mjs` — 130 assertions. Sections A1–A8 and B1–B14 cover units/parsing, tool captions, `completePlacement` arming, Escape/Delete ownership, zoom-extents event unification, georeference seeding, view-range units, error surfacing, interaction-state leakage, GPU disposal, wheel-zoom capture, placement-vs-selection, and the bus invariant (`B14`).

Relevant to this audit, the gate *does* assert:
- `isToolImplemented` is consulted and dead tools are disabled rather than armed (`B4`).
- The status bar names the command, not the tool code (`B13`).
- `chainTools` defaults true and the tool stays armed after placement (`A4`).

The gate asserts **nothing** about: Options Bar, Type Selector behaviour, contextual tabs, split buttons, ribbon tab set, panel titles, keyboard focus, context menus, selection count, floating panels, iconography, font/density, or dialog fidelity. **Recommendation:** treat the absence of a Revit-parity gate as a gap in its own right (see Ranked change #10).

---

## 1. Ribbon — **PARTIAL**

**What is genuinely present**

- A two-row ribbon: application bar + quick-access toolbar (`Ribbon.tsx:140–228`), tab bar (`:230–265`), panel content strip (`:267–657`).
- Tabs are `['Architecture', 'Annotate', 'View', 'Manage']` (`Ribbon.tsx:86`).
- Panels are real groupings separated by borders: Build, Datum, Constraints & Modify, Project Loading, AI Driver (`Ribbon.tsx:436–569`).
- Large buttons with icon-above-label (`renderToolButton`, `Ribbon.tsx:95–132`; 24px icon, 11px label at `:123–126`), and the two-letter shortcut printed in the button corner (`:127–129`).
- Quick-access toolbar with Open/Save/Export/Undo/Redo/Home/Section Box (`Ribbon.tsx:156–211`), all wired to store actions.
- A contextual tab exists — but only for **sketch mode**: a green "Modify | Edit Floor Boundary / Create Roof Footprint" tab (`Ribbon.tsx:249–264`).
- The tool stays armed after placement by default (`useBimStore.ts:1632–1634`, `chainTools: true` at `:658`), asserted by gate `A4`.
- Disabled-unimplemented tools are honest: `Ribbon.tsx:134–136` + `:578–581`.

**Gaps**

1. **Tab set is 4, not 7.** Revit Architecture's default set is Architecture / Structure / Insert / Annotate / Analyze / Massing / Modify. Here `Structure`, `Insert`, `Analyze`, `Massing` do not exist, and there is no `Modify` tab (`Ribbon.tsx:86`). Searched `'Structure'`, `'Insert'`, `'Analyze'`, `'Massing'` as ribbon tab literals — the only tab array is `:86`.
2. **No split buttons with drop-downs.** Revit's Wall button splits into Wall/Architectural Wall/Structural Wall/etc. Searched `splitButton`, `split button`, `DropDown`, `onClick` + `ChevronDown` pairing — 0 split-button constructs; `ChevronDown` appears 9× and is used *only* in `ProjectBrowser.tsx` tree expanders.
3. **No "Modify | Walls" contextual tab on element selection.** The contextual tab is gated solely on `sketchSession` (`Ribbon.tsx:250`). Selecting a wall produces no tab change; the only selection-reactive ribbon content is two Edit Boundary/Footprint buttons inside the Architecture tab (`Ribbon.tsx:500–519`).
4. **No visible panel titles.** Revit labels each panel ("Build", "Datum"). Here the labels exist only in `{/* ... */}` JSX comments (`Ribbon.tsx:436, 465, 485, 522, 551`); the rendered output is a bare `border-r` divider (`:437, 466, 486, 523`). Searched panel-title markup — none.
5. **No large-vs-small mixed layout within a panel.** Every tool uses the identical large `renderToolButton` treatment (icon 20, label 11px). Revit panels mix one large button with a 2×3 grid of small ones. The only small controls are the Chain checkbox (`:451–462`) and the sketch text inputs (`:338–417`).
6. **Quick-access toolbar placement.** Revit's QAT defaults above the ribbon; this is inline in the application bar (`Ribbon.tsx:141–211`) — acceptable, but it is not customisable and there is no "Customize Quick Access Toolbar" affordance.

**Actionable change items**

- Add `Modify` and `Insert` tabs, and a `Structure`/`Analyze`/`Massing` tab set (`Ribbon.tsx:86`).
- Introduce a `SplitButton` component (large icon + label + caret) and use it for Wall/Door/Window/Floor/Roof. Emit the drop-down from the command registry, not per-button JSX.
- Render panel titles from a `panel: {id, title}` descriptor instead of comments.
- Make the contextual tab a function of `selectedMesh.ifc_class`, not only `sketchSession`: `Modify | Walls`, `Modify | Doors`, etc., with Edit Type / Delete / Move on it.
- Support mixed large/small button sizing per panel.

## 2. Hotkeys (two-letter muscle memory) — **PARTIAL**

**What is genuinely present**

- A real **state machine**: a 3-character sliding buffer with a 1000 ms auto-clear (`useBimStore.ts:913–931`), driven from a single global listener that ignores typing contexts (`App.tsx:30–64`, guard at `:33–39`).
- The buffer is *observable to the user*: rendered as a `HOTKEY: [W_]` chip in both the app bar (`Ribbon.tsx:221–225`) and the status bar (`StatusBar.tsx:168–172`).
- Bound and functional: `WA, DR, WN, SB, RF, LI, RE, PW, BX, AL, EQ, HH, HR, HI, ZE` (`useBimStore.ts:884–911`).
- Escape is the single cancel path and clears selection + in-flight viewport state (`useBimStore.ts:845–867`); Enter commits a sketch (`:870–873`). Gate `B2` enforces this ownership.
- Shortcut labels come from one table (`toolCaptions.ts:25–46`) and the ribbon reads it (`Ribbon.tsx:127–129`).

**Gaps — against the 22 sequences named in the brief**

Of the 22 sequences named in the brief, **6 are bound and working** and **16 are not**:

| Bound & working (6) | Unbound (16) |
|---|---|
| `WA` (`useBimStore.ts:885`), `DR` (`:886`), `WN` (`:887`), `AL` (`:900–903`), `LI` (`:890–892`), `ZE` (`:908–910`) | `CM`, `GR`, `MV`, `CO`, `TR`, `DI`, `RO`, `SF`, `MM`, `VV`, `ZF`, `ZA`, `ZZ`, `TL`, `WT`, `CS` |

Two of the 16 are *deliberately* unbound as an honesty measure rather than an oversight — `GR` and `DI` are marked `implemented: false` (`toolCaptions.ts:38, 40`) and the store carries a comment explaining that they used to arm a tool no viewport consumed (`useBimStore.ts:875–883`); gate `B4` enforces that they stay unbound. The other 14 are simply absent.

Concretely absent:
- **`MV` (Move) — the single most-used Revit hotkey.** Searching `'MV'` in `src/` returns no hotkey binding. `translateElement` exists (`useBimStore.ts:1762`) and is reachable only from Properties nudge buttons (`PropertiesPalette.tsx:165–168`), never from a keyboard or viewport gesture.
- **`CM`** (Place a Component), **`CO`** (Copy), **`TR`** (Trim), **`MM`** (Mirror), **`SF`** (Split Face), **`RO`** (Rotate), **`CS`** (Create Similar), **`WT`** (Window Tile), **`TL`** (Thin Lines), **`VV`** (Visibility/Graphics), **`ZF`/`ZA`/`ZZ`** (zoom fits).
- `ZE` is bound to zoom-extents (`useBimStore.ts:908–910`) but `ZF`/`ZA`/`ZZ` are not.
- **No prefix/alternates model.** The buffer matches only whole strings, so a single-letter accelerator cannot coexist with a two-letter sequence. There is no "type `W` then wait" resolve-to-a-default behaviour, which is how Revit disambiguates.
- **No keyboard focus model.** Searched `tabIndex`, `document.activeElement`, `focus(` across `src/` — **0 hits**. Nothing in the shell is reachable by keyboard; modal dialogs (`ViewRangeModal`, `EditTypeModal`, `GeoreferenceModal`) implement no focus trap and no initial focus, and Tab does not traverse ribbon/viewport controls.
- Shortcut inconsistency: `toolCaptions.ts` gives `EQ` the two-letter shortcut `'EQ'` (`:33`) while the caption table also assigns the *tool code* `SEC`/`SHT` to what are really three-letter sequences and marks them unimplemented (`:44–45`).

**Actionable change items**

- Add a `COMMANDS` registry with `{id, caption, sequence, isEnabled, rejectedViewRules, execute}`; generate both the ribbon buttons and the hotkey table from it (the `toolCaptions.ts:8–10` comment already anticipates this as "UI-P2").
- Bind `MV` to a real move tool that drives `translateElement` from viewport pointer input.
- Add longest-prefix matching so `W` can resolve to Wall on timeout while `WA`/`WN` win when typed.
- Add `VV` → a Visibility/Graphics dialog, `ZF`/`ZA`/`ZZ` → zoom fits, `TL` → thin lines, `CS` → create similar.
- Introduce a keyboard focus model (roving `tabindex` over ribbon controls; focus trap + autofocus in every modal).

## 3. Options Bar — **ABSENT**

**Verdict justification.** Searched the entire `src/` tree for `OptionsBar` and `options bar` (case-insensitive). Results: **3 comment references and 1 unused JSX comment label**, and **zero rendered components**:
- `toolCaptions.ts:37` — "…and the Options Bar (UI-P3)…" (aspirational comment)
- `useBimStore.ts:429`, `:882` — comments deferring to "the Options Bar (UI-P3)"
- `Ribbon.tsx:337` — `{/* Sketch Options Bar */}`, a comment above the sketch inputs

There is no compact context bar above the viewport. Revit's Options Bar sits immediately under the ribbon and above the canvas, and it is the primary place a user reads/changes the active tool's parameters. Here the only tool-option control is the *Chain* checkbox, and it is rendered **inside the Architecture ribbon panel**, not in an Options Bar (`Ribbon.tsx:448–462`).

The sketch-mode inputs (`Ribbon.tsx:337–417`) are the closest analogue, but they are: (a) only present in sketch mode, (b) physically inside the ribbon panel strip, and (c) apply to sketch geometry only.

**Actionable change items**

- Create `src/components/optionsbar/OptionsBar.tsx` mounted in `App.tsx` between `<Ribbon/>` and `<Workspace/>` (`App.tsx:69–74`).
- Drive it from the command registry: each command declares an `options` schema; the bar renders it. Move the Chain checkbox out of the ribbon panel into it (`Ribbon.tsx:451–462`).
- Always render the leading `Modify | <element type>` label plus the Type Selector slot (see §4) even when the active tool is `select` — in Revit the Options Bar never disappears.

## 4. Type Selector — **PARTIAL (fake)**

**The distinction this audit is for: the Type Selector is not a dropdown and is not fed by types.**

`PropertiesPalette.tsx:183–197` renders a block labelled "Type Selector". It is a `<div>`, not a `<select>` or listbox:

```
PropertiesPalette.tsx:186   <div className="flex items-center space-x-2 bg-[#2a2d2e] ...">
PropertiesPalette.tsx:190     {isElementSelected ? selectedMesh?.name : 'Floor Plan : Architectural'}
PropertiesPalette.tsx:193     {isElementSelected ? selectedMesh?.ifc_class : 'View Properties'}
```

Findings:
1. **Not interactive.** No `<select>`, no `onClick`, no `onChange`, no caret. Searched `TypeSelector` — 0 hits; searched `dropdown` — the only hit is the *comment* at `:183`.
2. **Not fed real loaded types.** When nothing is selected it prints the hardcoded literal `'Floor Plan : Architectural'` (`:190`). When something is selected it prints `selectedMesh.name` — the *instance's* name, which in Revit's palette is the instance's Type, not a browsable list of loaded types. There is **no enumerable type list anywhere**; searched `types:`, `typeList`, `loadedTypes`, `getTypes` — no type collection exists on the store.
3. **Position is wrong relative to Revit.** Revit puts the Type Selector in the **Options Bar**, left of the tool options. Here it is the first block of the Properties palette (`:184`), which duplicates the palette's own header.
4. It is not listed in `Workspace.tsx` panel components and is not independently dockable.

**Actionable change items**

- Build a real `<select>`/combobox fed from the engine's type inventory (the backend already exposes `type_properties` per element, `useBimStore.ts:176`). Selecting a type must dispatch a type-change transaction through the bus.
- Move the control into the Options Bar and leave the Properties palette to show the *selected instance's* type as a read-only labelled field.
- Delete the `'Floor Plan : Architectural'` fallback and render the active view's real name from the store (`views.find(v => v.id === activeViewId)`).

## 5. Status Bar — **PARTIAL**

**What is genuinely present and good**

- A real view-control strip: display-unit selector (`StatusBar.tsx:46–56`), scale selector (`:59–69`), detail level Coarse/Medium/Fine (`:72–84`), visual style HL/CC/WF (`:87–115`), View Range button (`:118–125`), temporary hide/isolate (`:128–141`).
- **Contextual hints are genuinely honest and command-specific**, driven by `toolPrompt(activeTool)` (`StatusBar.tsx:151–156` → `toolCaptions.ts:57–73`). `WA` says "Click the wall start point, then the end point. The tool stays armed — Esc to finish." Unimplemented tools say "…is not available yet." rather than lying. Gate `B13` enforces this, and the `UI-P0-18` comment at `:158–160` records that a fabricated "Spacebar to flip" hint was removed.
- A real CRS readout that can show "No CRS" rather than a fabricated `EPSG:2285` (`StatusBar.tsx:173–179`), gate `B5`.

**Gaps**

1. **No selection count.** Revit's status bar reports "2 elements selected". Searched `selectedCount`, `elements selected`, `selection count` across `src/` — **0 hits**. The store holds a single scalar `selectedGuid: string | null` (`useBimStore.ts:462`, setter `:514`), so multi-selection does not exist, and when one element is selected the bar prints its raw GUID (`StatusBar.tsx:160`) — a developer string, not a Revit-style message.
2. **No "Click to place" generic hint** for tools lacking a bespoke prompt: `toolCaptions.ts:71` supplies "Click in the viewport to use this tool. Press Esc to exit." for the `default` branch, which is close but is a fallback, not a per-state machine (Revit's hint changes per click count: "Click to place"/"Click to finish"/"Press Esc to cancel").
3. The middle hint block is hidden below `lg` (`StatusBar.tsx:145`, `hidden lg:flex`), so on a narrow window the primary guidance disappears entirely.

**Actionable change items**

- Add `selectedGuids: string[]` to the store; render "N elements selected" (pluralised) in the middle block.
- Replace the raw-GUID line (`:160`) with a Revit-style message that names the element type.
- Make hints state-machine driven per command (state 0 → "Click to place", state 1 → "Click to finish", always → "Press Esc to cancel").
- Do not hide the hint block on narrow viewports; truncate instead.

## 6. Project Browser — **PARTIAL**

**What is genuinely present**

- A collapsible tree with expand/collapse chevrons (`ProjectBrowser.tsx:46–59`, `:76–82`).
- Real derived content: the "Families & IFC Types" branch is computed from the loaded model with instance counts (`:31–35`), and the `UI-P0` comment at `:28–30` records that it previously listed five fixed names — **that defect is genuinely fixed**.
- **Double-click to open works** for views (`:104`) and sheets (`:204`), as does single-click (`:105`, `:205`).
- Active-view highlighting (`:106–110`).
- A drag *start* is wired on floor-plan and section nodes (`:61–63`, `:102–103`, `:168`).

**Gaps**

1. **No right-click context menus anywhere in the shell.** Searched `onContextMenu` across `src/` — exactly **2 hits**, both of which *suppress* the menu: `PlanViewport2D.tsx:553` and `Viewport3D.tsx:870` (`(e) => e.preventDefault()`). Searched `Rename`, `duplicateView`, `deleteView` — **0 implementing hits** (the only `rename` matches are comments about the `.orlt`→`.bimworks` rename and a variable named `removeSet`). So Rename / Duplicate / Delete / Properties on a browser node **do not exist**. This is the single largest interaction gap in the shell.
2. **Missing Revit branches.** Present: Floor Plans, 3D Views, Sections, Sheets, Families & IFC Types. **Absent: Elevations, Ceilings, Schedules, Legends, Groups, Revit Links.** Evidence: `views.filter` is called for exactly three types — `'floor_plan'` (`:98`), `'3d'` (`:132`), `'section'` (`:164`). The `expandedSections` state initialises `elevations: true` and `schedules: false` (`:50, 54`) but **neither key is ever read**; no JSX renders an Elevations or Schedules node. Revit Links has no counterpart at all.
3. **Drag-to-reorder is dead-ended.** `handleDragStart` sets `text/plain` JSON (`:61–63`), but the only drop target in the whole app is the **sheet canvas** — searched `onDrop`/`onDragOver`/`dataTransfer.getData` and found exactly `SheetCanvas.tsx:45, 108, 109`. There is no drop handler on the browser, so dragging a node within the tree does nothing. It is a partial feature, not a working one.
4. **Content is seed data, not project data.** `views` and `sheets` are React state seeded from hardcoded literals (`useBimStore.ts:667` and `:720`). `App.tsx:23–27` calls only `fetchProjectState()` (which sets just project name + georeference, `useBimStore.ts:1427–1443`), `fetchGeometry()` and `fetch2DSlice()`. Nothing fetches views/sheets on mount. They are replaced **only** by a container load or sample load (`useBimStore.ts:1378–1379`, `:1409–1410`, reached from `:1542`, `:1575`, `:1987`). So on a fresh page load the browser lists the static seed — `Floor Plan: Level 1`, `Level 2`, `Roof Plan`, `Building Section 1`, sheets `A101`/`A201`. The `Ribbon.tsx:50–54` comment claiming "the View tab's Section/Sheet buttons target real project content rather than fixed prototype panel ids" is therefore **true only relative to this same seed list** — it is not evidence the browser reflects the engine's project. The implementation plan itself concedes this: "the sheet list … remains static seed data by design until P6" (`docs/IMPLEMENTATION-PLAN-2026-10-14.md:62`).

**Actionable change items**

- Implement a shared `ContextMenu` component and attach it to browser nodes with Rename / Duplicate / Delete / Properties; wire each to a bus transaction.
- Add the missing branches (Elevations, Ceilings, Schedules, Legends, Groups, Revit Links), or remove the unused `expandedSections` keys so the state does not imply them.
- Either complete drag-to-reorder with a real drop handler, or remove `draggable` from `:102`/`:168` so the affordance stops promising something it cannot do.
- Fetch views/sheets from the engine on mount (`/api/state` already returns `views`/`sheets` — `backend/main.py:1099–1100`) instead of relying on seed + container-load.

## 7. Properties palette — **PARTIAL**

### The N11 question, answered directly

**N11's hardcoded Area/Volume defect is genuinely fixed.** This is the most important positive finding in the audit, so it is evidenced in full:

- The values are computed from the tessellated mesh, not constants: `PropertiesPalette.tsx:53–54` — `const measure = selectedMesh ? measureMesh(selectedMesh) : null;`
- `measureMesh` performs real analytic geometry — triangle cross-products for area and the divergence theorem for volume (`geometry.ts:30–65`), returning `null` for an unusable buffer (`:32`) so the UI can show a placeholder instead of a wrong number.
- The render sites use a real `'—'` fallback: `PropertiesPalette.tsx:407–417` — `{measure ? formatArea(measure.areaFt2, displayUnit) : '—'}` and the same for volume.
- `geometry.ts:1–14` documents the method and its limitation (exact for watertight extrusions, approximate for open shells) and instructs callers to surface that caveat.

The declared N11 defect is resolved for Area/Volume. **Residual caveat:** the caveat the comment asks callers to surface is *not* surfaced in the UI — `:407–417` prints a single precise-looking number with no indication that an open shell would make it approximate. That is a transparency gap, not a fabrication.

### Other findings

1. **Edit Type is 100% hardcoded — a live N11-shaped defect the plan marked fixed.** The button is real (`PropertiesPalette.tsx:175–180` → `setEditTypeModalOpen`), the dialog renders (`EditTypeModal.tsx`), but **every value in it is a literal** and it reads nothing from the model:
   - `EditTypeModal.tsx:39` — `10" (250 mm)` (Structure Thickness)
   - `EditTypeModal.tsx:43` — `2 HR` (Fire Rating)
   - `EditTypeModal.tsx:47` — `R-19.0` (Thermal Resistance)
   - `EditTypeModal.tsx:51` — `Concrete Masonry Units` (Structural Material)
   - `EditTypeModal.tsx:55` — `Exterior` (Function)
   - `EditTypeModal.tsx:11` — fallback type name `'Basic Wall : Exterior - 10" CMU'` when no mesh matches.
   The only store reads are `isEditTypeModalOpen`, `setEditTypeModalOpen`, `selectedGuid`, `meshes` (`:6`). Searched the file for `updateElement`/`executeTransaction`/`dispatch`/`fetch` — **0 hits**. The single action button is "OK", which merely closes (`:62–67`); there is no Apply, no Cancel, no Duplicate. **This is `docs/IMPLEMENTATION-PLAN-2026-10-14.md:62`'s claim that N11 is "Fixed by P0" being incomplete** — the sheet list is acknowledged as remaining static, but the Edit Type dialog is not.
2. **No Type vs Instance parameter split.** Revit's palette has a "Type Parameters" button opening a *separate* dialog from instance parameters. Here the groups are `Constraints` (`:353–381`), `Dimensions` (`:383–420`), `Identity & IFC Data` (`:422–445`), `Graphics & Extents` (`:826–857`), plus a free-form "Geometry & Shape Editor" (`:469–482`). There is no type/instance demarcation and no visual distinction between the two.
3. **No greyed read-only treatment.** Revit renders computed values greyed and non-editable. Here read-only rows use the *same* text colour as editable ones (`text-white font-mono`, e.g. `:374–377`, `:392–404`) — only the label is grey (`text-[#858585]`). Untracked rows do say `Not tracked` (`:365, 369, 441`), which is honest, but there is no distinct visual state.
4. **Parameter grouping is partial.** Revit's standard groups are Constraints, Dimensions, Identity Data, Other, Phasing, Graphics, Materials and Finishes, Structural, Analytical. Present: Constraints, Dimensions, Identity & IFC Data, Graphics & Extents. Absent: Phasing, Materials and Finishes, Structural, Analytical, Other.
5. **Good news on wiring:** editable fields genuinely write to the model through the bus — `updateElement` (`:148`) → `useBimStore.ts:1739` → `dispatchTransaction` (`:2202`). Gate `B14` enforces that the bus remains the only mutation path. So the palette's *editing* is real even though its *Type* dialog is not.

**Actionable change items**

- Rewrite `EditTypeModal` to read real type data: source from `params.type_properties` (already carried on the mesh, `useBimStore.ts:176`) and write via a `ChangeType`/`TypeUpdate` bus command. Until that exists, replace the invented constants with `'—'` so the dialog stops asserting R-19.0 for a CMU wall that may not be one.
- Add Type/Instance tabs or two dialogs, matching Revit.
- Add a distinct read-only style (muted text + no hover) and apply it to computed rows.
- Add the missing parameter groups, or omit them consistently rather than inventing values.

## 8. Contextual selection UI — **PARTIAL**

**What is genuinely present**

- Selection state is real and shared: `selectedGuid` in the store, consumed by both viewports.
- Selection is *visible* in both:
  - 3D: `Viewport3D.tsx:416–432` — `isSelected` → `color = '#0284c7'` (commented "Revit selection blue"), with a distinct hover colour `#38bdf8` at `:430–431`.
  - 2D: `PlanViewport2D.tsx:582–588`, `:604–616`, `:693–698`, `:775`, `:825`, `:1023` — `stroke={isSelected ? '#0284c7' : <default>}` across slabs, roofs, openings and dimensions.
- Placeholder/halftone treatment in sketch mode: other elements are dimmed to `opacity 0.22` (`Viewport3D.tsx:422–426`), which matches Revit's halftone of non-edited context.
- **Temporary dimensions are real and editable.** `PlanViewport2D.tsx:1300–1348`: an overlay pill with the live distance, click-to-edit, prefilled in the *display* unit and parsed by the shared units engine (`:1338`, `:1318` via `tryParseLength`), with invalid input keeping the editor open and reporting the reason (`:1319–1322`). Comment at `:1312–1317` records that this previously used `parseFloat` and silently discarded `12'-6"`. **This is a genuinely well-built interaction.**
- Alignment guides with clickable padlock constraints exist and write through the store: `PlanViewport2D.tsx:934–964`, `toggleConstraintLock` (`:953`).

**Gaps**

1. **No blue selection outline.** Revit draws a blue outline *in addition to* the element's own linework, so selection is legible over any material. Here selection **replaces** the element colour (`Viewport3D.tsx:429`, a solid `MeshStandard` colour) or **replaces** the stroke colour (`PlanViewport2D.tsx:588`). A selected blue element on a blue-ish background, or a selected element under `consistent_colors`, loses its identity. There is no outline pass, no edge overlay, no emissive rim. Searched `outline`, `OutlinePass`, `EdgesGeometry`, `emissive` — no selection-outline implementation.
2. **No drag handles / grips.** Revit shows shape handles (arrows) and drag grips on a selected element. Searched `grip`, `handle`, `dragHandle` as rendered elements — 0. The only `handle*` identifiers are React event handlers (e.g. `handleNudge`, `handleMouseDown`).
3. **No drag-to-move in either viewport.** Searched `translateElement`, `dragState`, `isDragging` in `PlanViewport2D.tsx` and `Viewport3D.tsx` — **0 hits**. `translateElement` (`useBimStore.ts:1762`) is invoked only from the Properties nudge buttons (`PropertiesPalette.tsx:165–168`). A user cannot drag a wall in the viewport, which is the most fundamental Revit direct-manipulation gesture. (This aligns with the sibling finding that `MV` is unbound — §2.)
4. **Temporary dimensions are an overlay, not witness lines.** The interactive pill is absolutely positioned at `top-14 left-1/2` (`PlanViewport2D.tsx:1301`) — a fixed screen location, **not anchored to the measured element**. Revit's temp dimensions sit at the element with witness lines. Worse, `index.css:108–130` defines exactly the witness-line and pill classes Revit needs (`.temp-dimension-line`, `.temp-dimension-pill`) and **neither is referenced anywhere in `src/`** — searched both class names in all `.tsx`/`.ts` files: **0 hits**. They are dead CSS.
5. Single-selection only: `selectedGuid` is a scalar, so Ctrl-click multi-select and window/crossing selection do not exist (this also blocks the §5 selection count).

**Actionable change items**

- Add a selection outline pass in 3D (inverted-hull or `EdgesGeometry` overlay at `#007acc`) and a separate outline stroke in 2D, instead of recolouring the element.
- Implement viewport drag-to-move on a selected element, dispatching `translateElement` on pointer-up (one transaction, not per-frame).
- Add shape handles/grips at the draggable points of a selected element.
- Anchor temp dimensions to the measured geometry and use the existing `.temp-dimension-line`/`.temp-dimension-pill` classes (`index.css:108–130`) — or delete them if the overlay approach is deliberate.
- Move selection to `selectedGuids: string[]` to unlock multi-select and the status-bar count.

## 9. Dockable panels — **PARTIAL**

**What is genuinely present**

- `dockview` **is** genuinely used, as the README claims (`README.md:18`): `Workspace.tsx:3–6` imports `DockviewReact` from `dockview-react`, and `:146–150` renders it with `className="dockview-theme-dark"`.
- Five panel components are registered (`:40–46`) and five panels are created in `onReady`: Project Browser docked left (`:52–58`), then `{3D}` (`:61–66`), `Floor Plan: Level 1` (`:68–73`), `Roof Plan` (`:75–80`), `A101 - FLOOR PLAN & SECTIONS` (`:82–87`) as centre tabs, and Properties docked right (`:93–99`).
- Docking/tabbing/undocking **works** out of the box — dockview provides drag-to-dock and tab reordering natively, and the theme is customised to a dark palette (`index.css:27–40`).
- Two-way sync between dockview's active panel and the store is implemented (`Workspace.tsx:102–110` and `:114–142`), and new views are added as panels on demand (`:120–130`).

**Gaps**

1. **Floating, popout and auto-hide are never enabled.** The library supports all three — `node_modules/dockview/dist/dockview.js` (v8.5.1, confirmed at `node_modules/dockview/package.json`) contains `addFloatingGroup` (15 occurrences), `addPopoutGroup` (19), `FloatingGroup` (111), `autoHide` (41). The shell calls **none** of them: searched `Workspace.tsx` for `floating|autoHide|disableFloating|popoutGroups` — **0 hits**. Every `addPanel` call passes only `id`/`component`/`title`/`position`/`initialWidth` (`:52–99`). So palettes can be dragged between dock positions and tabbed, but they cannot be **floated** as a free-floating window, **popped out** to a browser window, or **auto-hidden** to a rail — three of the four things the task asks about.
2. **No panel size constraints.** Searched `minimumWidth`, `maximumWidth` across `src/` — **0 hits**. Revit's Project Browser and Properties palette have minimum widths; here a palette can be dragged to zero width (`initialWidth: 260`/`290` only, `:57`, `:98`).
3. **Panel set is hardcoded to seed IDs.** `onReady` unconditionally creates `view-level-1`, `view-roof-plan` and `sheet-a101` (`:68–87`) regardless of what the engine reports, because `onReady` runs before any project data arrives. Combined with §6.4 (views/sheets are seed data), the initial workspace is a fixed layout unrelated to the loaded model.
4. **`view-level-2` is unreachable.** The seed defines it (`useBimStore.ts:688–697`) but `onReady` never adds a panel for it; it can only appear if something calls `setActiveViewId('view-level-2')`, which no UI affordance does (the browser lists it, and clicking it *does* route through `Workspace.tsx:120–130`, so this is reachable — but only via the browser, not from the default layout). *(unverified)* whether the browser's `Roof Plan`/`Level 2` entries correctly match the seed IDs after a container load — the seed IDs and the engine's IDs are different namespaces, and `:120–130` adds a new panel for the engine ID while the seed panels remain, which would produce **duplicate tabs** for the same view. This is a probable but unconfirmed defect: proving it requires running the app with a real container.

**Actionable change items**

- Enable floating and popout for the Browser and Properties panels (`addFloatingGroup` / `addPopoutGroup`), and add an auto-hide affordance, so the claim "dockable" is fully true.
- Set `minimumWidth` on both docked palettes.
- Build the default layout from the *loaded* view list rather than hardcoded seed IDs; remove the seed panels when a project loads.
- Confirm and fix the duplicate-tab risk in `Workspace.tsx:114–133` by reconciling seed IDs with engine IDs.

## 10. Modal dialogs vs Revit — **PARTIAL**

Three Revit-relevant dialogs exist. They are of very different quality.

**View Range — PARTIAL (real, but only 2 of 4 fields persist).**
- Genuinely wired: reads the active view's real `viewRange` and `levelId` (`ViewRangeModal.tsx:32, 55–60`), re-syncs on open rather than on mount (`:53–60`, documented at `:52`), and reports the resulting absolute elevation so the level-relative convention is never a mystery (`:159–175`). Comment `:8–15` records that Apply previously sent a fixed `1.2` regardless of input — **that defect is genuinely fixed** for the fields it handles.
- **But** `handleApply` (`:72–78`) calls only `setViewLevel(view.id, levelId)` and `setViewCut(view.id, cutNumber)`. `top`, `bottom` and `depth` are React state (`:48–50`) that is **never written back** — the View Depth field is collected and silently discarded. The dialog therefore looks like it edits four planes and actually edits two.
- Structure vs Revit: Revit's View Range dialog has a **graphic preview** of the cut/top/bottom/depth planes with the level line drawn. Here there is a `Plane | Level | Offset` table (`:143–157`) and a text readout — functional, but not Revit's visual. No Preview, no "Show" checkboxes.
- Buttons: Cancel + "Apply View Range" (`:179–193`); Revit uses OK/Cancel/Apply. No Apply-without-close.

**Edit Type — ABSENT (fiction).** See §7.1 in full: five hardcoded literal values (`EditTypeModal.tsx:39–55`), no store write, single OK button (`:61–68`), no Cancel/Apply/Duplicate. It structurally resembles Revit's Type Properties dialog (header, Family & Type band at `:30–33`, parameter table) but contains no real data. **Do not treat this dialog as implemented.**

**Georeference — PARTIAL (genuinely well-built).** Real store round-trip on open (`GeoreferenceModal.tsx:53–71`), a real "not set" state (`:54`, `UNSET`), Apply refused while unset with a stated reason (`:79–80`), and errors surfaced (`:48`, `:133`). Comment `:19–32` records two prior defects (fabricated mount-time position; stale seed couldn't be cleared) — both **genuinely fixed**, and gate `B5` enforces it. This is the best-quality dialog in the shell.
- Revit comparison: this is really a "Manage Project Location"/Site dialog analogue. It lacks Revit's map/graphic, but the data model is honest, which matters more.
- *(unverified)* whether the dialog writes through `dispatchTransaction` or a bespoke endpoint; `GeoreferenceModal.tsx:37–39` reads `georeference` from the store and I did not trace the write path to the bus. If it bypasses the bus, it would violate the `B14` invariant in spirit — **worth checking**, since `B14` only greps for raw mutation fetches.

**Density — PARTIAL.** All three dialogs use `p-4 space-y-4` bodies (`ViewRangeModal.tsx:118`, `EditTypeModal.tsx:29`, `GeoreferenceModal.tsx:117`). Revit dialogs are notably tighter (roughly `p-3`/`space-y-2`, 11px body text, 12–13px row height). The 16px gaps here read as a web app, not a desktop CAD dialog.

**Actionable change items**

- `ViewRangeModal`: persist `top`/`bottom`/`depth` — add `setViewRange(field, value)` to the store and call it in `handleApply`; until then, render them disabled with a "not yet stored" note rather than accepting input.
- `EditTypeModal`: replace constants with real type properties (see §7).
- Add the graphic plane preview to View Range.
- Tighten dialog density (`p-3`, `space-y-2`) across all three.
- Verify the Georeference write path goes through the bus.

## 11. Visual language — **PARTIAL**

**Iconography — real, not text labels.** 110 Lucide icons are imported across 12 components, with genuine icon+label composition, not text substitutes:

| Component | Icons |
|---|---|
| `Ribbon.tsx` | 31 |
| `PropertiesPalette.tsx` | 13 |
| `PromptBar.tsx` | 11 |
| `ProjectBrowser.tsx` | 11 |
| `StatusBar.tsx` | 8 |
| `PlanViewport2D.tsx` | 7 |
| `LegalModal.tsx` | 7 |
| `SheetCanvas.tsx` | 6 |
| `GeoreferenceModal.tsx` | 5 |
| `Viewport3D.tsx` | 5 |
| `EditTypeModal.tsx` | 3 |
| `ViewRangeModal.tsx` | 3 |

`lucide-react` is a declared dependency (`package.json:26`). Icons render as inline SVG with semantic colour coding (e.g. walls `#60a5fa`, doors `#f97316`).

**No vendored image assets.** Searched `public/` and `src/` for `*.svg`, `*.png`, `*.ico`, `*.woff*`, `*.ttf` — **zero files**. The only icon-ish asset is an inline data-URI SVG favicon (`index.html:5`). This is consistent and intentional (no network dependency), but it means **all Revit-specific iconography is absent** — there are no Revit-style Wall/Door/Window glyphs, only generic Lucide metaphors (`Box` for Wall, `DoorClosed`, `AppWindow`, `Square` for Roof).

**Fonts — documented decision, with a real caveat.**
- `index.html:8–14` documents that the Google-Fonts stylesheet was deliberately removed because a render-blocking network fetch made an offline workstation show a blank page. The stated fallback intent is "Inter and JetBrains Mono are used when installed, otherwise the OS UI font".
- `index.css:18` sets `font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`.
- **Caveat:** because no `@font-face` exists and no webfont is vendored, on a machine without Inter installed the shell renders in the OS UI font (Segoe UI on Windows). That is a reasonable outcome, but the `index.css:18` declaration makes the intent unverifiable in code — the shell's actual typography is environment-dependent. `'JetBrains Mono'` is referenced at `index.css:118` for the temp-dimension pill with a `monospace` fallback, and `font-mono` is used extensively for numeric readouts.
- Revit uses Segoe UI on Windows. So the *fallback* is in fact closer to Revit than Inter would be.

**Colour — a deliberate dark theme that is not Revit's light chrome.**
- Revit's palette is a light grey application frame (`#f0f0f0`-ish chrome, white canvas, light-grey palettes) with a blue accent.
- This shell is dark: `--revit-bg: #1e1e1e`, `--revit-panel-bg: #252526`, `--revit-border: #3c3c3c`, `--revit-accent: #007acc` (`index.css:5–15`). These are **VS Code Dark+ values**, not Revit values, despite the `--revit-*` variable naming.
- The accent `#007acc` is correct-ish for Revit's blue, but selection uses `#0284c7` (`Viewport3D.tsx:429`, `PlanViewport2D.tsx:588`) — a teal-shifted blue that does not match the declared accent. So even the accent is inconsistent within the shell.
- **No light theme and no theme switch.** Searched `theme`, `light`, `prefers-color-scheme` — `index.html:15` declares `<meta name="color-scheme" content="dark">` only.

**RMB context menu — ABSENT.** As established in §6.1, `onContextMenu` appears twice and both calls *suppress* the browser menu (`PlanViewport2D.tsx:553`, `Viewport3D.tsx:870`). Revit's RMB menu is a primary interaction surface (in-canvas "Cancel", "Zoom In Region", "Find Referring Views", "Override Graphics in View", "Hide in View"; and on browser nodes Rename/Duplicate/Delete/Properties). **Nothing is substituted** — right-clicking in a viewport currently does nothing at all, which is arguably worse than leaving the browser menu.

**Density.** Typography is web-dense rather than CAD-dense: labels at `text-[10px]`/`text-[11px]`, body at `text-xs` (12px), monospace numerics at `text-[11px]`, plus `text-[9px]` shortcut chips (`Ribbon.tsx:127`). Revit ribbon labels are 11px and dialog rows ~13px high; this is in the right range for the ribbon, but the `space-y-4` dialog gaps (§10) break the analogy, and the `select-none` on `body` (`index.css:19`) plus `overflow: hidden` reinforces an app feel.

**Actionable change items**

- Add an RMB context menu system (shared with §6) with in-canvas and browser-node variants.
- Either commit to a Revit-like light theme or stop naming variables `--revit-*`; if a theme switch is intended, `--revit-*` should be the light palette and the dark values moved to a `--dark-*` set.
- Unify the accent: pick `#007acc` and replace the `#0284c7` selection colour, or vice versa, and apply consistently.
- Consider Revit-like custom SVG glyphs for the core architectural tools (Wall/Door/Window/Roof/Floor) rather than generic Lucide shapes.
- Reduce dialog padding/gaps to Revit density.

---

## Assets worth preserving (do not regress these)

The audit is gap-heavy, so these genuinely good things should be explicitly protected — several are better than a naive Revit clone would be:

1. **The P0 gate itself** (`scripts/check-ui-p0.mjs`, 130 checks) and the honesty culture it encodes — dead tools are disabled rather than faked (`Ribbon.tsx:134–136`), the status bar names commands not codes (`StatusBar.tsx:151–156`), and fabricated strings were removed with comments recording why (`StatusBar.tsx:158–160`, `:173–174`).
2. **Analytic Area/Volume** (`geometry.ts:30–65`) with a real null-and-placeholder path — N11 genuinely fixed.
3. **The editable temporary dimension** (`PlanViewport2D.tsx:1300–1348`), including unit-correct prefill and invalid-input handling.
4. **Alignment guides with clickable padlock constraints** (`PlanViewport2D.tsx:934–964`).
5. **The genuine `dockview` integration** with two-way store sync (`Workspace.tsx:102–142`).
6. **The honest Georeference dialog** (`GeoreferenceModal.tsx:53–80`).
7. **`chainTools` defaulting true** so a placement tool stays armed (`useBimStore.ts:1632–1634`) — asserted by gate `A4`.

---

## Top 10 changes to make the shell look and feel like Revit

Ranked by (Revit-likeness gained) ÷ (effort and risk). Effort: **S** ≈ under a day, **M** ≈ 1–3 days, **L** ≈ a week or more.

| # | Change | Effort | Files touched |
|---|---|---|---|
| 1 | **Replace the fake Edit Type dialog with real type data.** Five hardcoded literals (`EditTypeModal.tsx:39–55`) are a trust hazard worse than a missing feature. Source from `params.type_properties`, write via a `TypeUpdate` bus command; add Cancel/Apply/Duplicate. If the command does not exist yet, render `'—'` first (an S-sized honesty fix) and wire it after. | **S→M** | `modals/EditTypeModal.tsx`, `store/useBimStore.ts`, `types/bim.ts` |
| 2 | **Build the Options Bar.** The single largest structural absence. A context bar between ribbon and canvas, always showing `Modify \| <type>` + Type Selector + active-tool options. Move the Chain checkbox out of the ribbon. | **L** | `App.tsx`, new `components/optionsbar/OptionsBar.tsx`, `ribbon/Ribbon.tsx:448–462`, `store/useBimStore.ts` |
| 3 | **Add a right-click context menu system.** Nothing happens on RMB today (both handlers merely `preventDefault`). In-canvas menu + browser-node menu (Rename/Duplicate/Delete/Properties) covers two of the brief's areas at once. | **M** | new `components/common/ContextMenu.tsx`, `ProjectBrowser.tsx`, `PlanViewport2D.tsx:553`, `Viewport3D.tsx:870` |
| 4 | **Fix the View Range dialog to persist all four planes.** View Depth input is currently collected and discarded (`ViewRangeModal.tsx:46–78`). Add `setViewRange` and call it from `handleApply`. | **S** | `modals/ViewRangeModal.tsx`, `store/useBimStore.ts` |
| 5 | **Bind the missing Revit hotkeys, starting with `MV`.** Add `MV` + viewport drag-to-move, plus `CO`, `TR`, `MM`, `RO`, `CS`, `VV`, `ZF`/`ZA`/`ZZ`, `TL`. Introduce longest-prefix matching so single letters and two-letter sequences coexist. | **M** | `store/useBimStore.ts:884–931`, `App.tsx:30–64`, `toolCaptions.ts`, both viewports |
| 6 | **Make the Type Selector real.** Turn the read-only `<div>` (`PropertiesPalette.tsx:183–197`) into a combobox fed by a real engine type inventory, placed in the Options Bar, dispatching a type-change transaction. | **M** | `properties/PropertiesPalette.tsx`, `store/useBimStore.ts`, backend type endpoint |
| 7 | **Real selection styling: outline + grips + multi-select.** Stop recolouring the element (`Viewport3D.tsx:429`, `PlanViewport2D.tsx:588`); add a blue outline pass, shape handles, and `selectedGuids: string[]` to unlock Ctrl-click and the status-bar count. | **L** | `viewport/Viewport3D.tsx`, `drafting/PlanViewport2D.tsx`, `statusbar/StatusBar.tsx`, `store/useBimStore.ts` |
| 8 | **Add contextual tabs on element selection.** Generalise the `sketchSession`-gated tab (`Ribbon.tsx:249–264`) to `Modify \| Walls` / `Modify \| Doors` when a mesh is selected, carrying Edit Type / Delete / Move. | **M** | `ribbon/Ribbon.tsx`, `store/useBimStore.ts` |
| 9 | **Complete the Project Browser: missing branches, real data, working reorder.** Add Elevations/Ceilings/Schedules/Legends/Groups; fetch views+sheets from `/api/state` on mount instead of seed; either implement the tree drop handler or remove `draggable` (`ProjectBrowser.tsx:102, 168`). | **M** | `browser/ProjectBrowser.tsx`, `store/useBimStore.ts:1427–1443`, `main.tsx`/`App.tsx` |
| 10 | **Ribbon completeness + a Revit-parity gate.** Add the missing tabs (Insert/Structure/Analyze/Massing/Modify) and visible panel titles; add split buttons. Then extend `check-ui-p0.mjs` with parity assertions (Options Bar present, 7 tabs, context menu on node RMB, selection count renders, Edit Type has no literal numbers) so these cannot silently regress. | **M** | `ribbon/Ribbon.tsx`, `scripts/check-ui-p0.mjs` |

**Suggested sequencing:** #1 and #4 are same-day honesty fixes and should ship immediately and independently. #2 and #3 are the two big structural wins and should be planned together, since the Options Bar is the natural home for the Type Selector (#6) and for per-command options. #7 is the largest single piece of work and unblocks #5's `MV` drag and #8's contextual Modify tab. #10's gate extension should land last, once there is behaviour worth asserting.

---

## Appendix — claims marked *(unverified)*

1. **§9.4** — Whether the seed view IDs (`view-level-1`, `view-roof-plan`, `sheet-a101`) collide with engine-issued IDs after a container load, producing duplicate dockview tabs via `Workspace.tsx:114–133`. A static read suggests it is possible; confirming requires running the app with a real `.bimworks` container.
2. **§10** — Whether `GeoreferenceModal` writes through `dispatchTransaction` or a bespoke endpoint. The read path is store-backed (`GeoreferenceModal.tsx:35–39`); the write path was not traced to the bus. Gate `B14` only greps for raw mutation fetches, so it may not catch this.
3. **§11** — The actual rendered font on this workstation. `index.css:18` requests Inter with no `@font-face`; whether Inter is installed here was not checked, so the shell may render in Segoe UI rather than Inter.
4. **§1.6 / §11** — I did not run the app to observe the ribbon's visual density at runtime; all density judgements are from Tailwind class values (e.g. `text-[11px]`, `py-1.5`).
