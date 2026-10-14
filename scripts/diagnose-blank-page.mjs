#!/usr/bin/env node
/**
 * Diagnoses a blank BIMWorks page.
 *
 * Written after a blank screen was reported from a second workstation. Two distinct
 * causes had already been found, both of which present identically to the user (a white
 * page), and neither of which is visible from the server side:
 *
 *   1. no WebGL context (headless / remote / VM) — the 3D viewport threw and, before the
 *      ErrorBoundary existed, unmounted the whole React tree;
 *   2. `node_modules` copied across platforms — rolldown and lightningcss ship native
 *      binaries, so Vite fails to start and never serves the app.
 *
 * Run this on the machine that shows the blank page. It only reports facts; it does not
 * change anything.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const results = [];
const record = (ok, label, detail) => results.push({ ok, label, detail });

function nativeBinaryForThisPlatform() {
  const platform = `${process.platform}-${process.arch}`;
  const candidates = {
    'linux-x64': 'binding-linux-x64-gnu',
    'linux-arm64': 'binding-linux-arm64-gnu',
    'darwin-x64': 'binding-darwin-x64',
    'darwin-arm64': 'binding-darwin-arm64',
    'win32-x64': 'binding-win32-x64-msvc',
  };
  return { expected: candidates[platform] || '(unknown platform)', platform };
}

console.log(`\nBIMWorks blank-page diagnostic`);
console.log(`  host      : ${os.platform()} ${os.release()} (${process.arch})`);
console.log(`  node      : ${process.version}`);
console.log(`  directory : ${ROOT}\n`);

// --- 1. dependencies installed, and native ones matching THIS platform -------------
const nm = path.join(ROOT, 'node_modules');
if (!existsSync(nm)) {
  record(false, 'node_modules is missing', 'run `npm install` on this machine');
} else {
  record(true, 'node_modules is present', '');
  const { expected } = nativeBinaryForThisPlatform();
  const rolldownDir = path.join(nm, '@rolldown');
  let found = [];
  if (existsSync(rolldownDir)) {
    found = readdirSync(rolldownDir).filter((d) => d.startsWith('binding-'));
  }
  if (found.length === 0) {
    record(false, 'no rolldown native binding installed',
      'Vite cannot start. Run `npm install` on THIS machine — do not copy node_modules');
  } else if (expected !== '(unknown platform)' && !found.includes(expected)) {
    record(false,
      `rolldown native binding does not match this platform`,
      `have ${found.join(', ')}, need ${expected}. ` +
      `node_modules was almost certainly copied from another OS/CPU — run \`npm install\``);
  } else {
    record(true, `rolldown native binding matches this platform`, found.join(', '));
  }
  const lc = readdirSync(nm).filter((d) => d.startsWith('lightningcss-'));
  record(lc.length > 0, 'lightningcss native binding present',
    lc.join(', ') || 'missing — run `npm install`');
}

// --- 2. frontend build/serve configuration ------------------------------------------
const distIndex = path.join(ROOT, 'dist', 'index.html');
if (existsSync(distIndex)) {
  const html = readFileSync(distIndex, 'utf8');
  const refs = [...html.matchAll(/assets\/[^"']+/g)].map((m) => m[0]);
  const missing = refs.filter((r) => !existsSync(path.join(ROOT, 'dist', r)));
  record(missing.length === 0,
    missing.length ? 'built HTML references assets that do not exist' : 'built assets match dist/index.html',
    missing.length ? `missing: ${missing.join(', ')} — run \`npm run build\`` : `${refs.length} asset(s)`);
} else {
  record(true, 'no production build in dist/', 'fine if you are using `npm run dev`');
}

// --- 3. is anything actually listening? ---------------------------------------------
function listening(port) {
  try {
    const out = execSync(`ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null`, { encoding: 'utf8' });
    return out.split('\n').some((l) => new RegExp(`[:.]${port}\\b`).test(l));
  } catch {
    return false;
  }
}
const viteUp = listening(5173);
const backendUp = listening(8008);
record(viteUp, viteUp ? 'frontend is listening on 5173' : 'nothing is listening on 5173',
  viteUp ? '' : 'start it with `npm run dev`');
record(backendUp, backendUp ? 'backend is listening on 8008' : 'nothing is listening on 8008',
  backendUp ? '' : 'start it with `cd backend && ../.venv/bin/python main.py` — the API is '
    + 'proxied, so without it the app loads but shows no data');

// --- 4. can the API actually answer? ------------------------------------------------
if (backendUp) {
  try {
    const res = await fetch('http://127.0.0.1:8008/api/project');
    record(res.ok, `backend answered /api/project (${res.status})`,
      res.ok ? '' : 'the sidecar started but the route failed');
  } catch (e) {
    record(false, 'could not reach the backend API', String(e));
  }
}

// --- 5. WebGL is a browser property; report what we can from here -------------------
record(true, 'WebGL cannot be probed from Node',
  'if the page renders but the 3D view shows "3D view unavailable", this machine has no '
  + 'WebGL context (headless/remote/VM). The 2D plan view still works.');

// --- report -------------------------------------------------------------------------
console.log('Findings:');
for (const r of results) {
  console.log(`  ${r.ok ? '[ok]  ' : '[FAIL]'} ${r.label}`);
  if (r.detail) console.log(`         ${r.detail}`);
}
const failures = results.filter((r) => !r.ok);
console.log('');
if (failures.length === 0) {
  console.log('No blocking problem found from here.');
  console.log('If the page is still blank, open the browser devtools console and look for a');
  console.log('JavaScript error — that is the remaining possibility this script cannot see.');
} else {
  console.log(`${failures.length} problem(s) found. Fix those first; they alone explain a blank page.`);
}
process.exit(failures.length ? 1 : 0);
