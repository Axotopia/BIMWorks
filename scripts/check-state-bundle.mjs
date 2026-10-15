#!/usr/bin/env node
/**
 * Post-commit state-bundle gate.
 *
 * Verifies the ONE-round-trip refresh path (docs/SPECIFICATION-v0.2.md §6.3) and
 * that the two latency numbers stay separate (§6.4).
 *
 * Why a stubbed fetch: `API_BASE` is the relative `/api`, resolved by Vite's dev
 * proxy, so the store cannot be pointed at a test server. Stubbing `fetch` makes
 * this gate deterministic and lets it assert things a live run cannot — the exact
 * request count, the URL each view type builds, and that the fallback is
 * parallel rather than serial. The endpoint's own behaviour against the real app
 * object is verified separately.
 *
 * Run:  node scripts/check-state-bundle.mjs
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// `new URL(...).pathname` yields "/C:/Users/..." on Windows and path.join then
// doubles the drive. fileURLToPath is the portable conversion.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

let checks = 0;
let failures = 0;

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const BUNDLE = {
  project: {
    project_name: 'Bundle Gate Project',
    levels: [{ id: 'L1' }],
    elements_count: 1,
    georeference: { projected_crs: 'EPSG:26918' },
  },
  constraints: [{ id: 'c1' }],
  wall_joins: { 'wall-1': { end_0: { mode: 'miter', allow_join: true } } },
  geometry: {
    meshes: [
      {
        guid: 'wall-1',
        ifc_class: 'IfcWallStandardCase',
        name: 'Basic Wall',
        params: {
          ifc_class: 'IfcWallStandardCase',
          name: 'Basic Wall : Exterior',
          start: [0, 0, 0],
          end: [10, 0, 0],
          length: 10,
          height: 10,
          thickness: 0.5,
          level_id: 'L1',
          // The N7 guarantee: these exist ONLY in the parametric payload, not in
          // the tessellation. If the bundle path stops deriving `elements` from
          // `params`, these vanish and the AI planner sees zero walls.
          host_wall_guid: null,
          offset_along_wall: 3.25,
        },
      },
    ],
    levels: [{ id: 'L1' }],
    grids: [{ id: 'g1' }],
  },
  slice2d: { cut_paths: [[[0, 0], [1, 1]]], renderer: 'mesh_hlr' },
  journal: [{ sequence: 1, description: 'Wall create' }],
  timings: { geometry: 1.2, slice2d: 2.4 },
  errors: {},
  engine_ms: 3.7,
};

const PLAN_VIEW = {
  id: 'v-plan',
  name: 'Level 1',
  type: 'floor_plan',
  levelId: 'L1',
  viewRange: { cut: 4.0, top: 10.0, bottom: 0.0 },
};
const SECTION_VIEW = {
  id: 'v-sect',
  name: 'Section A',
  type: 'section',
  levelId: 'L1',
  viewRange: { cut: 4.0, top: 12.0, bottom: -2.0, viewDepth: 0 },
};

/** Installs a counting fetch stub. Returns the call log. */
function stubFetch({ stateStatus = 200, bundle = BUNDLE, perRouteDelayMs = 0 } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/state')) {
      if (stateStatus === 404) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => bundle };
    }
    if (perRouteDelayMs) await new Promise((r) => setTimeout(r, perRouteDelayMs));
    if (u.includes('/geometry')) return { ok: true, status: 200, json: async () => BUNDLE.geometry };
    if (u.includes('/constraints')) return { ok: true, status: 200, json: async () => BUNDLE.constraints };
    if (u.includes('/wall/joins')) return { ok: true, status: 200, json: async () => BUNDLE.wall_joins };
    if (u.includes('/journal')) return { ok: true, status: 200, json: async () => BUNDLE.journal };
    if (u.includes('/slice/2d') || u.includes('/view/2d')) return { ok: true, status: 200, json: async () => BUNDLE.slice2d };
    if (u.includes('/project')) return { ok: true, status: 200, json: async () => BUNDLE.project };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return calls;
}

// ---------------------------------------------------------------------------
// Load the real store through Vite's SSR pipeline
// ---------------------------------------------------------------------------
const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
});

const originalFetch = globalThis.fetch;
let store;

try {
  const storeModule = await server.ssrLoadModule('/src/store/useBimStore.ts');
  store = storeModule.useBimStore;
} finally {
  await server.close();
}

const reset = (view = PLAN_VIEW) =>
  store.setState({
    views: [view],
    activeViewId: view.id,
    projectName: 'unchanged',
    constraints: [],
    wallJoins: {},
    meshes: [],
    elements: {},
    sliced2D: null,
    transactionJournal: [],
  });

// ---------------------------------------------------------------------------
section('S1. A plan refresh is ONE round trip');
{
  reset(PLAN_VIEW);
  const calls = stubFetch();
  await store.getState().fetchStateBundle();
  const stateCalls = calls.filter((c) => c.includes('/state'));
  check('exactly one /api/state request', stateCalls.length === 1, `got ${calls.length} total calls: ${calls.join(', ')}`);
  check('no per-resource request alongside it', calls.length === 1, `${calls.length} calls`);
  check(
    'plan URL carries cut_elevation and level_id, and no view_type',
    /cut_elevation=4/.test(stateCalls[0]) && /level_id=L1/.test(stateCalls[0]) && !/view_type/.test(stateCalls[0]),
    stateCalls[0]
  );
}

// ---------------------------------------------------------------------------
section('S2. A section still routes as a section, not as a plan');
{
  reset(SECTION_VIEW);
  const calls = stubFetch();
  await store.getState().fetchStateBundle();
  const u = calls.find((c) => c.includes('/state')) ?? '';
  check('view_type=section is sent', /view_type=section/.test(u), u);
  check('top and bottom are forwarded', /top=12/.test(u) && /bottom=-2/.test(u), u);
  check(
    'view_depth=0 is omitted (0 means "not set", not "almost nothing")',
    !/view_depth/.test(u),
    u
  );
}

// ---------------------------------------------------------------------------
section('S3. Every section is applied to the store');
{
  reset(PLAN_VIEW);
  stubFetch();
  await store.getState().fetchStateBundle();
  const s = store.getState();
  check('project name applied', s.projectName === 'Bundle Gate Project', s.projectName);
  check('georeference applied', s.georeference?.projected_crs === 'EPSG:26918');
  check('constraints applied', s.constraints.length === 1);
  check('wall joins applied', Object.keys(s.wallJoins).length === 1);
  check('meshes applied', s.meshes.length === 1);
  check('levels applied', s.levels?.length === 1);
  check('grids applied', s.grids?.length === 1);
  check('2D slice applied', s.sliced2D?.renderer === 'mesh_hlr');
  check('journal applied', s.transactionJournal.length === 1);

  // The N7 derivation must survive the consolidation.
  const el = s.elements['wall-1'];
  check('elements record built from mesh.params', !!el, JSON.stringify(Object.keys(s.elements)));
  check('  ... carrying thickness', el?.thickness === 0.5, String(el?.thickness));
  check(
    '  ... and offset_along_wall, which exists ONLY in params',
    el?.offset_along_wall === 3.25,
    String(el?.offset_along_wall)
  );
}

// ---------------------------------------------------------------------------
section('S4. A null slice must not blank the viewport');
{
  reset(PLAN_VIEW);
  store.setState({ sliced2D: { renderer: 'previous' } });
  const bundle = { ...BUNDLE, slice2d: null, errors: { slice2d: 'ValueError: boom' } };
  stubFetch({ bundle });
  await store.getState().fetchStateBundle();
  check(
    'last good linework is retained when the slice fails',
    store.getState().sliced2D?.renderer === 'previous',
    JSON.stringify(store.getState().sliced2D)
  );
  check('the other sections still applied', store.getState().meshes.length === 1);
}

// ---------------------------------------------------------------------------
section('S5. Two latency numbers, recorded separately');
{
  reset(PLAN_VIEW);
  const samplesBefore = globalThis.__bimworksRefresh?.samples ?? 0;
  stubFetch();
  await store.getState().fetchStateBundle();
  const stats = globalThis.__bimworksRefresh;
  check('stats are exposed for measurement', !!stats, JSON.stringify(stats));
  check(
    'exactly one sample recorded per refresh',
    stats?.samples === samplesBefore + 1,
    `before=${samplesBefore} after=${stats?.samples}`
  );
  check(
    'engine latency is the engine figure, not the wall clock',
    stats?.engine?.p50 === 3.7,
    `engine=${JSON.stringify(stats?.engine)} — must equal payload engine_ms (3.7)`
  );
  check(
    'client latency is recorded under its own key',
    typeof stats?.client?.p50 === 'number' && stats.client.p50 !== stats.engine.p50,
    `client=${JSON.stringify(stats?.client)} engine=${JSON.stringify(stats?.engine)}`
  );
  check('bundle is reported as supported', stats?.bundleSupported === true);
}

// ---------------------------------------------------------------------------
section('S6. Delta Protocol (Responses A, B, C)');
{
  // 1. Initial fetch sets rev
  reset(PLAN_VIEW);
  store.setState({ rev: undefined });
  const initialBundle = { ...BUNDLE, rev: 1, full: true };
  const callsInit = stubFetch({ bundle: initialBundle });
  await store.getState().fetchStateBundle();
  check('initial bundle fetch populates rev', store.getState().rev === 1, `rev=${store.getState().rev}`);
  check('initial bundle fetch does not send since param', !/since=/.test(callsInit[0]), callsInit[0]);

  // 2. Response A (unchanged)
  const callsA = stubFetch({
    bundle: { rev: 1, unchanged: true, engine_ms: 0.5 },
  });
  await store.getState().fetchStateBundle();
  check('subsequent refresh sends since=1', /since=1/.test(callsA[0]), callsA[0]);
  check('Response A does not modify meshes or elements', store.getState().meshes.length === 1 && !!store.getState().elements['wall-1']);

  // 3. Response B (delta with upsert, remove, and journal append)
  const newWallMesh = {
    guid: 'wall-2',
    ifc_class: 'IfcWallStandardCase',
    name: 'New Partition Wall',
    params: {
      ifc_class: 'IfcWallStandardCase',
      name: 'Partition',
      start: [0, 5, 0],
      end: [10, 5, 0],
      thickness: 0.2,
      height: 9,
    },
  };
  const deltaPayload = {
    rev: 2,
    base_rev: 1,
    unchanged: false,
    upsert_meshes: [newWallMesh],
    remove_guids: ['wall-1'],
    slice2d: { cut_paths: [[[0, 5], [10, 5]]], renderer: 'delta_hlr' },
    journal_append: [{ transaction_id: 'tx-2', description: 'Wall 2 created' }],
    engine_ms: 2.1,
  };
  stubFetch({ bundle: deltaPayload });
  await store.getState().fetchStateBundle();
  const stateAfterDelta = store.getState();
  check('Response B updates store rev to 2', stateAfterDelta.rev === 2, `rev=${stateAfterDelta.rev}`);
  check('removed guid wall-1 is purged from meshes', !stateAfterDelta.meshes.some((m) => m.guid === 'wall-1'));
  check('removed guid wall-1 is purged from elements', !stateAfterDelta.elements['wall-1']);
  check('upserted mesh wall-2 is added to meshes', stateAfterDelta.meshes.some((m) => m.guid === 'wall-2'));
  check('upserted mesh wall-2 is added to elements', !!stateAfterDelta.elements['wall-2'] && stateAfterDelta.elements['wall-2'].thickness === 0.2);
  check('journal_append is added to transactionJournal', stateAfterDelta.transactionJournal.some((j) => j.transaction_id === 'tx-2'));
  check('slice2d in delta updates sliced2D', stateAfterDelta.sliced2D?.renderer === 'delta_hlr');

  // 4. Dirty-view slicing: null slice2d in delta retains existing sliced2D
  const deltaNullSlice = {
    rev: 3,
    base_rev: 2,
    unchanged: false,
    upsert_meshes: [],
    remove_guids: [],
    slice2d: null,
    journal_append: [],
    engine_ms: 1.0,
  };
  stubFetch({ bundle: deltaNullSlice });
  await store.getState().fetchStateBundle();
  check('null slice2d in delta does not blank sliced2D', store.getState().sliced2D?.renderer === 'delta_hlr');
  check('rev advanced to 3', store.getState().rev === 3);

  // 5. Response C (full resync on reset or forced full)
  const fullResyncBundle = {
    ...BUNDLE,
    rev: 10,
    full: true,
    geometry: {
      meshes: [
        {
          guid: 'wall-10',
          ifc_class: 'IfcWallStandardCase',
          name: 'Resynced Wall',
          params: { ifc_class: 'IfcWallStandardCase', thickness: 0.8 },
        },
      ],
      levels: [{ id: 'L1' }],
      grids: [],
    },
  };
  stubFetch({ bundle: fullResyncBundle });
  await store.getState().fetchStateBundle();
  check('Response C replaces meshes completely', store.getState().meshes.length === 1 && store.getState().meshes[0].guid === 'wall-10');
  check('Response C updates rev to 10', store.getState().rev === 10);
}

// ---------------------------------------------------------------------------
section('S7. A 404 trips the breaker once, and the fallback is PARALLEL');
{
  reset(PLAN_VIEW);
  const calls404 = stubFetch({ stateStatus: 404, perRouteDelayMs: 40 });
  const t0 = performance.now();
  await store.getState().fetchStateBundle();
  const elapsed = performance.now() - t0;

  check('the 404 was attempted once', calls404.filter((c) => c.includes('/state')).length === 1);
  check('the fallback still populated state', store.getState().meshes.length === 1);
  check(
    'breaker reports the bundle as unsupported',
    globalThis.__bimworksRefresh?.bundleSupported === false,
    JSON.stringify(globalThis.__bimworksRefresh?.bundleSupported)
  );

  // Six routes at 40 ms each: serial would be ~240 ms, parallel is ~40-60 ms.
  check(
    'fallback issues its requests in parallel, not serially',
    elapsed < 140,
    `${elapsed.toFixed(0)} ms for 6 routes at 40 ms each — serial would be ~240 ms`
  );

  const before = calls404.length;
  await store.getState().fetchStateBundle();
  const after = calls404.length;
  check(
    'a second refresh makes ZERO further /api/state requests (no failed request per commit)',
    after > before && !calls404.slice(before).some((c) => c.includes('/state')),
    `new calls: ${calls404.slice(before).join(', ')}`
  );
}

globalThis.fetch = originalFetch;

console.log(`\n${'-'.repeat(72)}`);
if (failures) {
  console.log(`STATE-BUNDLE GATE FAILED — ${checks - failures}/${checks} checks passed`);
  process.exit(1);
}
console.log(`STATE-BUNDLE GATE PASSED — ${checks} checks`);
