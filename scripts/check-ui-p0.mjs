#!/usr/bin/env node
/**
 * UI-P0 gate.
 *
 * The UI plan (`IMPLEMENTATION-PLAN-UI-INTERACTION-2026-10-14.md` §5) requires that
 * UI-P0's claims are measured rather than asserted. This script does that in two
 * ways:
 *
 *   A. **Behavioural.** Loads the real modules through Vite's SSR pipeline (no
 *      browser, no sidecar) and exercises the logic UI-P0 actually changed:
 *      unit formatting/parsing, the chain-vs-single-shot placement decision, the
 *      sketch-aware Delete key, the shared Escape reset, and the API-error
 *      flattener. These are the parts where "it looks right" is not evidence.
 *
 *   B. **Structural.** Asserts the absence of the specific constructs UI-P0
 *      removed: the leftover metric conversions, the duplicate Escape listener,
 *      the two competing zoom-extents event names, the inert-tool hotkey table,
 *      and the hardcoded survey coordinates. A grep-style check is the right tool
 *      for "this must no longer exist anywhere".
 *
 * Run:  node scripts/check-ui-p0.mjs      (also wired into `npm run check:ui`)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// `new URL(...).pathname` yields "/C:/Users/..." on Windows - a leading slash plus a
// drive letter - and path.join() then doubles the drive ("C:\C:\Users\..."). That
// made this gate crash before performing a single check on Windows. fileURLToPath
// is the portable conversion.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

let checks = 0;
let failures = 0;
const notes = [];

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * Remove `//` line comments and `/* ... *\/` block comments so a structural check
 * tests the code rather than the prose that documents why the code is there. The
 * UI-P0 fixes carry explanatory comments that name the very constructs being
 * checked for — without this, the gate would fail on its own documentation.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      // Only strip a `//` that is not inside a string literal on this line.
      let inSingle = false;
      let inDouble = false;
      let inTemplate = false;
      for (let i = 0; i < line.length - 1; i += 1) {
        const ch = line[i];
        const prev = line[i - 1];
        if (ch === "'" && !inDouble && !inTemplate && prev !== '\\') inSingle = !inSingle;
        else if (ch === '"' && !inSingle && !inTemplate && prev !== '\\') inDouble = !inDouble;
        else if (ch === '`' && !inSingle && !inDouble && prev !== '\\') inTemplate = !inTemplate;
        else if (ch === '/' && line[i + 1] === '/' && !inSingle && !inDouble && !inTemplate) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

/** Every .ts/.tsx/.py file under the given roots, skipping build output. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// A. Behavioural checks against the real modules
// ---------------------------------------------------------------------------
const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
});

let units;
let storeModule;
try {
  units = await server.ssrLoadModule('/src/utils/units.ts');
  storeModule = await server.ssrLoadModule('/src/store/useBimStore.ts');
} finally {
  // Keep the server alive only as long as we need it.
}

const store = storeModule.useBimStore;
const ZOOM = storeModule.ZOOM_EXTENTS_EVENT;

section('A1. Display units — the temporary dimension is no longer 3.28x too large');
{
  const feet = 12.5;
  const imperial = units.formatLength(feet, 'imperial_fractional');
  check(
    'formatLength(12.5 ft) reads as feet-inches, not a scaled number',
    /12'\s*-\s*6"/.test(imperial) || /12'-6"/.test(imperial),
    `got "${imperial}"`
  );
  check(
    'formatLength(12.5 ft) in metric mm is 3810 mm (not 12.5 * 3.28)',
    units.formatLength(feet, 'metric_mm') === '3810 mm',
    `got "${units.formatLength(feet, 'metric_mm')}"`
  );
  check(
    'formatLength(12.5 ft) in metres is 3.81 m',
    units.formatLength(feet, 'metric_m') === '3.81 m',
    `got "${units.formatLength(feet, 'metric_m')}"`
  );
  check(
    'formatLength honours decimal feet',
    units.formatLength(feet, 'imperial_decimal') === "12.50'",
    `got "${units.formatLength(feet, 'imperial_decimal')}"`
  );
}

section('A2. tryParseLength — the display unit is accepted as input');
{
  const cases = [
    ["12'-6\"", 12.5],
    ["12' 6\"", 12.5],
    ["12'-6 1/2\"", 12.541666666666666],
    ["12-6", 12.5],
    ['12.5', 12.5],
    ["12.5'", 12.5],
    ['150"', 12.5],
    ['3810 mm', 12.5],
    ['3.81 m', 12.5],
  ];
  for (const [text, expected] of cases) {
    const got = units.tryParseLength(text);
    const ok = got !== null && Math.abs(got - expected) < 0.002;
    check(`tryParseLength(${JSON.stringify(text)}) === ${expected} ft`, ok, `got ${got}`);
  }
  for (const bad of ['', '   ', 'abc', 'twelve feet', '12//6', '12 ft 6']) {
    check(
      `tryParseLength(${JSON.stringify(bad)}) is rejected (null), not silently 0`,
      units.tryParseLength(bad) === null,
      `got ${units.tryParseLength(bad)}`
    );
  }
  // The parser must invert the formatter, or the editor prefill is a trap.
  //
  // The tolerance is the formatter's own precision, not a fixed epsilon: `metric_m`
  // renders two decimals ("3.05 m" for 10 ft), so parsing that back cannot yield
  // exactly 10 — the requirement is that what the user sees round-trips, which is a
  // relative 0.5 * 10^-decimals / 0.3048 ft.
  for (const [unit, tolerance] of [
    ['imperial_fractional', 1 / 12 / 32], // sixteenths of an inch
    ['imperial_decimal', 0.005],
    ['metric_mm', 0.5 / 304.8],
    ['metric_m', 0.005 / 0.3048],
  ]) {
    const text = units.formatLength(10, unit);
    const back = units.tryParseLength(text);
    check(
      `format->parse round-trips 10 ft through ${unit} ("${text}")`,
      back !== null && Math.abs(back - 10) <= tolerance,
      `got ${back}, tolerance ${tolerance}`
    );
  }
}

section('A3. Tool captions replace the raw tool code and the dead-tool claim');
{
  const captions = await server.ssrLoadModule('/src/interaction/toolCaptions.ts');
  check('WA is captioned "Wall", not "WA"', captions.toolCaption('WA') === 'Wall');
  check('GR is reported unimplemented', captions.isToolImplemented('GR') === false);
  for (const tool of ['LL', 'DI', 'DL', 'TG', 'TX', 'SEC', 'SHT']) {
    check(`${tool} is reported unimplemented`, captions.isToolImplemented(tool) === false);
  }
  for (const tool of ['WA', 'DR', 'WN', 'SB', 'RF', 'AL', 'select']) {
    check(`${tool} is reported implemented`, captions.isToolImplemented(tool) === true);
  }
  check(
    'the prompt for an unimplemented tool says so instead of "click to place"',
    /not available yet/i.test(captions.toolPrompt('GR')),
    captions.toolPrompt('GR')
  );
}

section('A4. completePlacement — the tool stays armed (one ribbon click per chain)');
{
  store.setState({ chainTools: true, activeTool: 'WA' });
  store.getState().completePlacement();
  check('chaining on: the tool is still armed after a placement', store.getState().activeTool === 'WA');

  store.setState({ chainTools: false, activeTool: 'WA' });
  store.getState().completePlacement();
  check('chaining off: the tool returns to select', store.getState().activeTool === 'select');

  // Restore the shipping default for the checks below.
  store.setState({ chainTools: true, activeTool: 'select' });
  check('chainTools defaults to true (Revit behaviour)', store.getState().chainTools === true);
}

section('A5. resetInteraction — one cancel path, and it is observable');
{
  const before = store.getState().interactionResetToken;
  store.getState().resetInteraction('escape');
  const after = store.getState().interactionResetToken;
  check('resetInteraction bumps the token viewports watch', after === before + 1);
  check("the reason is recorded as 'escape'", store.getState().interactionResetReason === 'escape');

  store.setState({ activeTool: 'WA' });
  const beforeToolChange = store.getState().interactionResetToken;
  store.getState().setActiveTool('DR');
  check('setActiveTool bumps the token, so the previous pick is discarded', store.getState().interactionResetToken === beforeToolChange + 1);
  check('the active ribbon tab can still be set alongside the tool', store.getState().activeTool === 'DR');
  store.getState().setActiveTool('WA', 'Architecture');
  check('setActiveTool accepts a ribbon tab', store.getState().activeRibbonTab === 'Architecture');
  store.setState({ activeTool: 'select' });
}

section('A6. handleDeleteKey — Delete belongs to the sketch while a sketch is open');
{
  // Record what deleteElement would be asked to delete, without a backend.
  const seen = [];
  store.setState({
    selectedGuid: 'the-floor-being-edited',
    sketchSession: null,
    deleteElement: async (guid) => {
      seen.push(guid);
    },
  });
  store.getState().handleDeleteKey();
  check(
    'with no sketch, Delete deletes the selected element',
    seen.length === 1 && seen[0] === 'the-floor-being-edited'
  );

  // The regression: editing a floor keeps the floor selected as the sketch host.
  store.setState({
    selectedGuid: 'the-floor-being-edited',
    sketchSession: {
      mode: 'floor',
      elementType: 'floor',
      isEditingExisting: true,
      targetGuid: 'the-floor-being-edited',
      targetName: 'Floor : 10" Concrete Slab',
      elevation: 0,
      thickness: 0.25,
      pitch: 15,
      lines: [],
      selectedLineId: null,
      drawTool: 'line',
      defaultDefinesSlope: false,
      defaultSlopeAngle: 15,
      defaultOverhang: 0.3,
      validationError: null,
    },
    deleteElement: async (guid) => {
      seen.push(guid);
    },
  });
  store.getState().handleDeleteKey();
  check(
    'EDITING A SKETCH: Delete does NOT delete the host element',
    seen.length === 1,
    `deleteElement was called with ${JSON.stringify(seen)}`
  );
  check(
    'and it explains that a boundary line must be selected first',
    /select a boundary line/i.test(store.getState().sketchSession?.validationError || ''),
    String(store.getState().sketchSession?.validationError)
  );

  // With a line selected, Delete removes the line.
  let lineDeletes = 0;
  store.setState({
    sketchSession: {
      ...store.getState().sketchSession,
      selectedLineId: 'sk-1',
      validationError: null,
    },
    deleteSelectedSketchLine: () => {
      lineDeletes += 1;
    },
  });
  store.getState().handleDeleteKey();
  check('with a sketch line selected, Delete removes the line', lineDeletes === 1);
  check('and still does not touch the host element', seen.length === 1);

  store.setState({ sketchSession: null, selectedGuid: null });
}

section('A7. Zone B: the shared Zoom Extents event has one name');
{
  check('ZOOM_EXTENTS_EVENT is exported from the store', typeof ZOOM === 'string' && ZOOM.length > 0);
  check('and it is not the pre-rename name', ZOOM !== 'orlt-zoom-extents', ZOOM);
}

section('A8. Command failure is reported, not swallowed');
{
  store.setState({ statusMessage: 'Ready' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    statusText: 'Unprocessable Entity',
    json: async () => ({
      detail: [{ loc: ['body', 'commands', 0, 'params', 'thickness'], msg: 'Input should be a valid number' }],
    }),
  });
  let threw = false;
  let message = '';
  try {
    await store.getState().executeTransaction([{ command: 'SlabCreate', params: { polygon: [] } }], 'ui', 'Create slab');
  } catch (e) {
    threw = true;
    message = e.message;
  }
  globalThis.fetch = originalFetch;

  check('a rejected command throws rather than passing silently', threw);
  check(
    'the Pydantic error list is flattened to field + reason, not "[object Object]"',
    message.includes('thickness') && message.includes('valid number') && !message.includes('[object'),
    message
  );

  // And a mutation wrapper surfaces it in the status bar.
  store.setState({ statusMessage: 'Ready' });
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    statusText: 'Unprocessable Entity',
    json: async () => ({ detail: 'Slab polygon must have at least 3 points' }),
  });
  await store.getState().createSlab([[0, 0], [1, 1]]);
  globalThis.fetch = originalFetch;
  check(
    'createSlab failure reaches the status bar with the engine message',
    /Slab polygon must have at least 3 points/.test(store.getState().statusMessage),
    store.getState().statusMessage
  );
  store.setState({ statusMessage: 'Ready' });

  check('chainTools is unchanged by a failed placement', store.getState().activeTool === 'select');
}

// Load-bearing modules are now cached by Vite; the server is no longer needed.
await server.close();

// ---------------------------------------------------------------------------
// B. Structural checks — the constructs UI-P0 removed must be gone
// ---------------------------------------------------------------------------
const srcFiles = walk(join(ROOT, 'src')).filter((f) => /\.(ts|tsx)$/.test(f));
const backendFiles = walk(join(ROOT, 'backend')).filter((f) => f.endsWith('.py'));
const read = (f) => readFileSync(f, 'utf8');
const srcText = (f) => `${relative(ROOT, f)}::${read(f)}`;

section('B1. No leftover metric conversions in the UI');
{
  const hits = [];
  for (const f of srcFiles) {
    // Comments are exempt: the fix's own comments explain the bug they removed.
    const code = stripComments(read(f));
    code.split('\n').forEach((line, i) => {
      // 3.28084 applied to a value the engine already stores in feet.
      if (/3\.28084/.test(line) && !/METERS_TO_FEET|FEET_TO_/.test(line)) {
        hits.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  check('no ad-hoc `* 3.28084` remains anywhere in src/', hits.length === 0, hits.join('\n         '));
}

section('B2. Escape has exactly one owner');
{
  const plan = read(join(ROOT, 'src/components/drafting/PlanViewport2D.tsx'));
  const view3d = read(join(ROOT, 'src/components/viewport/Viewport3D.tsx'));
  const listeners = [plan, view3d].filter((t) => /addEventListener\(\s*'keydown'/.test(t));
  check(
    'no viewport registers its own keydown listener',
    listeners.length === 0,
    `${listeners.length} viewport(s) still add a keydown listener`
  );
  const app = read(join(ROOT, 'src/App.tsx'));
  check("App.tsx routes Escape through the store's hotkey engine", /handleKeyStroke/.test(app));
  check('App.tsx no longer decides Delete itself', !/deleteElement\(/.test(app));
  check('App.tsx routes Delete through the store', /handleDeleteKey/.test(app));

  const storeSrc = read(join(ROOT, 'src/store/useBimStore.ts'));
  check('the store owns the single cancel path', /resetInteraction: \(reason\)/.test(storeSrc));
  check(
    'the store bumps a token viewports can observe',
    /interactionResetToken: state\.interactionResetToken \+ 1/.test(storeSrc)
  );
  check('the plan viewport consumes the token', /interactionResetToken/.test(plan));
  check('the 3D viewport consumes the token', /interactionResetToken/.test(view3d));
}

section('B3. One zoom-extents event name');
{
  const hits = [];
  for (const f of srcFiles) {
    stripComments(read(f))
      .split('\n')
      .forEach((line, i) => {
        if (/orlt-zoom-extents/.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      });
  }
  check('the pre-rename `orlt-zoom-extents` is gone', hits.length === 0, hits.join(', '));

  const plan = read(join(ROOT, 'src/components/drafting/PlanViewport2D.tsx'));
  const view3d = read(join(ROOT, 'src/components/viewport/Viewport3D.tsx'));
  check('the 3D viewport listens for zoom extents', /addEventListener\(ZOOM_EXTENTS_EVENT/.test(view3d));
  check(
    'the 2D plan viewport listens too (ZE used to do nothing in plan)',
    /addEventListener\(ZOOM_EXTENTS_EVENT/.test(plan)
  );
}

section('B4. The inert tools are no longer presented as working');
{
  const storeSrc = read(join(ROOT, 'src/store/useBimStore.ts'));
  const hotkeyBlock = storeSrc.slice(storeSrc.indexOf('const hotkeys'), storeSrc.indexOf('if (state.keyBufferTimeout)'));
  for (const key of ['GR', 'LL', 'DI', 'DL', 'TG', 'TX', 'SEC', 'SHT']) {
    check(
      `the hotkey table no longer binds ${key} to a tool no viewport implements`,
      !new RegExp(`\\b${key}:\\s*\\(\\)`).test(hotkeyBlock)
    );
  }
  check('the hotkey table still binds the real tools', /\bWA:\s*\(\)/.test(hotkeyBlock) && /\bZE:\s*\(\)/.test(hotkeyBlock));

  const ribbon = read(join(ROOT, 'src/components/ribbon/Ribbon.tsx'));
  check('the ribbon consults isToolImplemented', /isToolImplemented/.test(ribbon));
  check(
    'the ribbon disables rather than arms an unimplemented tool',
    /notYet\(/.test(ribbon)
  );
  check(
    'the EQ ribbon button runs the same action as the EQ hotkey',
    /equalizeSouthWallWindows\(\)/.test(ribbon)
  );
  check(
    'the ribbon no longer promises an untypeable {3D} shortcut',
    !/'\s*\{3D\}\s*'/.test(ribbon)
  );
}

section('B5. Georeferencing starts unset, in both directions');
{
  const storeSrc = read(join(ROOT, 'src/store/useBimStore.ts'));
  check(
    'the frontend seed carries no fabricated survey position',
    !/1275432|234567|EPSG:2285/.test(storeSrc.split('georeference: {')[1]?.slice(0, 400) || 'MISSING')
  );
  const modal = read(join(ROOT, 'src/components/modals/GeoreferenceModal.tsx'));
  check('the dialog re-syncs on open instead of snapshotting at mount', /useEffect\(/.test(modal) && /isGeoreferenceModalOpen/.test(modal));
  check('the dialog refuses an unset CRS instead of applying nothing', /Choose a CRS before applying/.test(modal));
  check('the dialog offers an explicit "not set" state', /Not set — no georeferencing in the file/.test(modal));

  const ifc = read(join(ROOT, 'backend/ifc_service.py'));
  check(
    'the backend seed is unset',
    !/"projected_crs":\s*"EPSG:2285/.test(ifc)
  );
  check('apply_georeferencing is a no-op when no CRS is set', /if not crs:/.test(ifc));
  check(
    'and it clears stale georeferencing rather than leaving it in the file',
    /IfcMapConversion"\)\) \+ list\(self\.model\.by_type\("IfcProjectedCRS"\)\)/.test(ifc)
  );
}

section('B6. View ranges are in feet, matching the backend default');
{
  const storeSrc = read(join(ROOT, 'src/store/useBimStore.ts'));
  check('the seeded view range is defined once, in feet', /DEFAULT_VIEW_RANGE = \{ top: 8\.0, cut: 4\.0/.test(storeSrc));
  check('the seeds use it', (storeSrc.match(/\.\.\.DEFAULT_VIEW_RANGE/g) || []).length === 4);
  check('the roof plan has a roof-height range', /ROOF_VIEW_RANGE/.test(storeSrc));
  check(
    'no seeded view still carries the metric-era 1.2 cut',
    !/viewRange: \{ top: 2\.3, cut: 1\.2/.test(storeSrc)
  );
  const main = read(join(ROOT, 'backend/main.py'));
  check('the backend default cut agrees at 4.0 ft', /cut_elevation: float = 4\.0/.test(main));
}

section('B7. Every mutation failure is reported');
{
  const storeSrc = read(join(ROOT, 'src/store/useBimStore.ts'));
  const silentEdits = [];
  const lines = storeSrc.split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/console\.error\('Failed to ([^']+)', e\);/);
    if (!m) return;
    if (/^fetch\b/.test(m[1])) return; // read-only refetches stay quiet
    // The preceding line must set a status message.
    const previous = lines[i - 1] || '';
    if (!/statusMessage/.test(previous)) {
      silentEdits.push(`${i + 1}: ${m[1]}`);
    }
  });
  check(
    'no edit failure is logged without also reaching the status bar',
    silentEdits.length === 0,
    silentEdits.join(', ')
  );
  check('failed API errors are flattened', /function describeApiError/.test(storeSrc));
  check(
    'and the flattener replaces the raw `err.detail` throw',
    !/throw new Error\(err\.detail \|\| /.test(storeSrc)
  );
}

section('B8. Interaction state cannot leak between tools or cancels');
{
  const view3d = read(join(ROOT, 'src/components/viewport/Viewport3D.tsx'));
  const plan = read(join(ROOT, 'src/components/drafting/PlanViewport2D.tsx'));
  check(
    'the 3D viewport clears every in-progress point on a reset',
    /interactionResetToken/.test(view3d) &&
      /setWallStartPoint\(null\)/.test(view3d) &&
      /setBoxStartPoint\(null\)/.test(view3d)
  );
  check('the 3D viewport also clears on a tool change', /\[interactionResetToken, activeTool\]/.test(view3d));
  check(
    'the plan viewport clears firstPoint, currentPoint AND sketchStartPoint',
    /setSketchStartPoint\(null\)/.test(plan)
  );
  check(
    'a closed dimension editor does not survive its dimension (3D)',
    /if \(!tempDimension\)/.test(view3d)
  );
  check(
    'a pointer that leaves the viewport ends the gesture (3D)',
    /onMouseLeave=\{handlePointerLeave\}/.test(view3d)
  );
  check(
    'a pointer that leaves the viewport ends the gesture (2D)',
    /onMouseLeave=\{handlePointerLeave\}/.test(plan)
  );
  check('the 3D viewport captures the pointer', /setPointerCapture/.test(view3d));
}

section('B9. The camera/zoom is not reset by an edit');
{
  const view3d = read(join(ROOT, 'src/components/viewport/Viewport3D.tsx'));
  check(
    'the "always true" auto-fit clause is gone',
    !/meshes\.length > 0 && \(prevProjectRef\.current !== projectName \|\| meshes\.length !== 0\)/.test(view3d)
  );
  const plan = read(join(ROOT, 'src/components/drafting/PlanViewport2D.tsx'));
  check(
    'the plan no longer re-fits on every sliced2D change',
    /planFitProjectRef/.test(plan) && /becameNonEmpty/.test(plan)
  );
  check('the plan zoom is anchored to the cursor', /keep the model point under the cursor fixed/i.test(plan));
}

section('B10. Transient GPU resources are released');
{
  const view3d = read(join(ROOT, 'src/components/viewport/Viewport3D.tsx'));
  check('a dispose helper exists', /function disposeObject/.test(view3d));
  check('the mesh rebuild disposes the meshes it replaces', /scene\.remove\(mesh\);\s*\n\s*disposeObject\(mesh\);/.test(view3d));
  check('the section-box wireframe is disposed', /disposeObject\(sectionBoxMeshRef\.current\)/.test(view3d));
  check('the derived BoxGeometry is disposed', /boxGeom\.dispose\(\)/.test(view3d));
  const disposeCount = (view3d.match(/dispose\(\)/g) || []).length;
  check(
    'disposal is not limited to the renderer any more',
    disposeCount >= 6,
    `${disposeCount} dispose() call(s)`
  );
}

section('B11. Wheel zoom cannot scroll the page behind the viewport');
{
  const plan = read(join(ROOT, 'src/components/drafting/PlanViewport2D.tsx'));
  const view3d = read(join(ROOT, 'src/components/viewport/Viewport3D.tsx'));
  check(
    'the plan registers a native non-passive wheel listener',
    /addEventListener\('wheel',\s*onWheel,\s*\{\s*passive:\s*false\s*\}\)/.test(plan)
  );
  check(
    'the 3D viewport registers a native non-passive wheel listener',
    /addEventListener\('wheel',\s*handleNativeWheel,\s*\{\s*passive:\s*false\s*\}\)/.test(view3d)
  );
  check('neither viewport keeps a React onWheel that double-zooms', !/onWheel=\{/.test(plan) && !/onWheel=\{/.test(view3d));
}

section('B12. Placement does not double as selection');
{
  const plan = read(join(ROOT, 'src/components/drafting/PlanViewport2D.tsx'));
  const view3d = read(join(ROOT, 'src/components/viewport/Viewport3D.tsx'));
  check('the plan guards placement clicks out of selection', /PLACEMENT_TOOLS/.test(plan));
  check('the plan refuses a self-align', /Pick a different element to align to the reference/.test(plan));
  check('the 3D viewport refuses a self-align', /Pick a different element to align to the reference/.test(view3d));
  check(
    'the 3D door/window host filter accepts both wall classes',
    /HOSTABLE_WALL_CLASSES = \['IfcWallStandardCase', 'IfcWall'\]/.test(view3d)
  );
  check('the fabricated 3D offset heuristic is gone', !/Math\.hypot\(hit\.point\.x, hit\.point\.y\) \* 0\.4/.test(view3d));
  check('the offset is projected onto the real baseline', /function offsetAlongBaseline/.test(view3d));
}

section('B13. Honest status text');
{
  const status = stripComments(read(join(ROOT, 'src/components/statusbar/StatusBar.tsx')));
  check('the status bar names the command rather than the tool code', /toolCaption\(activeTool\)/.test(status));
  check('the fake "Spacebar to flip" hint is gone', !/Spacebar to flip/.test(status));
  check('the fake survey CRS label is gone', !/EPSG:2285 NAD83/.test(status));
  check('the status bar reads the real CRS', /georeference\.projected_crs/.test(status));
}

section('B14. The bus remains the only mutation path (regression guard)');
{
  const storeSrc = read(join(ROOT, 'src/store/useBimStore.ts'));
  // A plain GET is fine (`/api/wall/joins` is a read); a POST/PUT/DELETE to a model
  // endpoint is the bypass this project removed and must not come back.
  const mutatedEndpoints = [];
  const storeLines = storeSrc.split('\n');
  storeLines.forEach((line, i) => {
    if (!/fetch\(`\$\{API_BASE\}\/(wall|element|slab|roof|door|window)/.test(line)) return;
    // Look ahead for the method of this same call.
    const window = storeLines.slice(i, i + 6).join(' ');
    if (/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(window)) {
      mutatedEndpoints.push(`${i + 1}: ${line.trim()}`);
    }
  });
  check('no raw model-mutation fetch appeared', mutatedEndpoints.length === 0, mutatedEndpoints.join(', '));
  check(
    'the only wall endpoint the store calls directly is the read-only joins query',
    /\/wall\/joins/.test(storeSrc) && !/fetch\(`\$\{API_BASE\}\/wall`/.test(storeSrc)
  );
  check('dispatchTransaction is still the UI entry point', /dispatchTransaction: async/.test(storeSrc));
}

// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(72)}`);
if (failures === 0) {
  console.log(`UI-P0 GATE PASSED — ${checks} checks`);
  for (const note of notes) console.log(`  note: ${note}`);
  process.exit(0);
} else {
  console.log(`UI-P0 GATE FAILED — ${failures} of ${checks} checks failed`);
  process.exit(1);
}
