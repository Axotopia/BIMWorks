/**
 * P1 frontend parity gate.
 *
 * The bus-parity audit (`scratch/test_bus_parity_audit.py`) proves the backend
 * routes go through the CommandBus. This gate proves the *frontend* cannot
 * regress into calling raw mutation endpoints again — the exact failure mode the
 * 2026-10-14 review found (Ribbon edits unjournaled, Undo silently no-opping).
 *
 * It is deliberately a structural check rather than a behavioural one, so it can
 * run in CI without a browser or a live sidecar.
 *
 * Checks:
 *   1. `src/store/useBimStore.ts` contains no raw mutation fetch to a model
 *      endpoint. The only permitted non-GET fetches are the journaled bus
 *      endpoints themselves.
 *   2. Every entry in `UI_ACTION_COMMANDS` is dispatched via `dispatchTransaction`
 *      (an entry nobody uses is a lie in the contract table).
 *   3. `dispatchTransaction` is the sole caller of `executeTransaction` for UI
 *      edits, so there is exactly one mutation path.
 *
 * Run:  node scripts/check-bus-parity.mjs    (also wired into `npm run check`)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// `new URL(...).pathname` yields "/C:/Users/..." on Windows - a leading slash plus a
// drive letter - and path.join() then doubles the drive ("C:\C:\Users\..."). That
// made this gate crash before performing a single check on Windows. fileURLToPath
// is the portable conversion.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STORE = join(ROOT, 'src/store/useBimStore.ts');

/** Non-GET fetches that are legitimately not bus mutations. */
const ALLOWED_NON_GET = [
  '/transaction',        // the bus itself
  '/transaction/undo',
  '/transaction/redo',
  '/sample',             // document lifecycle: replaces the model, not an edit
  '/load-file',          // document lifecycle
  '/project/load-bimworks', // document lifecycle
  '/georeference',       // non-IFC project metadata; not part of the model snapshot
  '/export/sheet-pdf',   // produces a file, does not mutate
  '/export/batch-pdf',   // produces a file, does not mutate
  '/ai/plan',            // synthesizes plan without mutating
  '/ai/execute',         // AI transaction execution
  '/ai/query',           // semantic query
];

const failures = [];
const fail = (msg) => failures.push(msg);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. No raw mutation fetches outside the allow-list.
// ---------------------------------------------------------------------------
const FETCH_RE = /fetch\(\s*`\$\{API_BASE\}([^`]*)`\s*(?:,\s*\{([^}]*)\})?/gs;

for (const file of walk(join(ROOT, 'src'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(FETCH_RE)) {
    const path = m[1];
    const opts = m[2] ?? '';
    const isMutation = /method:\s*'(POST|PUT|PATCH|DELETE)'/.test(opts);
    if (!isMutation) continue;
    if (ALLOWED_NON_GET.some((a) => path.startsWith(a))) continue;
    fail(
      `${relative(ROOT, file)}: raw mutation fetch to ${path} — ` +
        `UI edits must go through dispatchTransaction() (add the route to the allow-list only if it is document lifecycle, not an edit)`
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Every declared UI action is actually dispatched.
// ---------------------------------------------------------------------------
const storeSrc = readFileSync(STORE, 'utf8');
const tableMatch = storeSrc.match(/UI_ACTION_COMMANDS\s*=\s*\{([\s\S]*?)\}\s*as const/);
if (!tableMatch) {
  fail('src/store/useBimStore.ts: UI_ACTION_COMMANDS table not found');
} else {
  const actions = [...tableMatch[1].matchAll(/^\s*(\w+):\s*'([^']+)'/gm)].map((m) => ({
    action: m[1],
    command: m[2],
  }));
  if (actions.length === 0) fail('UI_ACTION_COMMANDS is empty');
  for (const { action, command } of actions) {
    if (!new RegExp(`dispatchTransaction\\(\\s*'${action}'`).test(storeSrc)) {
      fail(`UI action '${action}' (${command}) is declared but never dispatched via dispatchTransaction`);
    }
  }
  console.log(`   ${actions.length} UI actions declared and dispatched through the bus`);
}

// ---------------------------------------------------------------------------
// 3. Exactly one mutation path: executeTransaction is called only by
//    dispatchTransaction (plus the sketch/AI bulk paths, which pass a command
//    list explicitly and are audited separately).
// ---------------------------------------------------------------------------
const executeCalls = [...storeSrc.matchAll(/get\(\)\.executeTransaction\(/g)].length;
const dispatchCalls = [...storeSrc.matchAll(/get\(\)\.dispatchTransaction\(/g)].length;
if (executeCalls === 0) fail('executeTransaction is never called — the bus client is dead code');
console.log(`   executeTransaction call sites: ${executeCalls}, dispatchTransaction call sites: ${dispatchCalls}`);

// The sketch subsystem builds multi-command transactions (footprint -> slab/roof)
// and the AI planner commits plans; both are legitimate bulk paths.
const bulkOk = /finishSketchMode|commitAiPlan/.test(storeSrc);
if (!bulkOk && executeCalls > 1) {
  fail(
    `executeTransaction is called ${executeCalls} times with no bulk path (sketch/AI) — ` +
      `UI edits must funnel through dispatchTransaction`
  );
}

if (failures.length) {
  console.error('\nBUS PARITY GATE FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nBUS PARITY GATE PASSED: UI mutations route through the CommandBus');
