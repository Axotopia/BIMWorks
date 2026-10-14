/**
 * Headless render smoke test: loads the built bundle with a LIVE backend and fails if any
 * React tree is left unmounted or the page ends up empty.
 *
 * Why this exists: a blank page was reported from a second workstation. Two causes were
 * found by hand — no WebGL context unmounting the whole app, and then a plan-viewport
 * crash from a missing contract field (`grid.circle_center`) after the renderer changed.
 * The first version of this test passed while the plan viewport was completely broken,
 * because it rendered with no data and therefore never exercised that component.
 *
 * Requirements: the backend must be running on 8008 (jsdom's fetch is not used; requests
 * are proxied straight to the API through an injected fetch).
 *
 *   cd backend && ../.venv/bin/python main.py       # in one terminal
 *   node scratch/smoke-render.mjs                   # in another
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const API = process.env.BIMWORKS_API || 'http://127.0.0.1:8008';
const html = fs.readFileSync('dist/index.html', 'utf8');
const jsRef = html.match(/assets\/(index-[^"']+\.js)/);
if (!jsRef) throw new Error('dist/index.html references no bundle — run `npm run build`');

const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:5173/',
  beforeParse(window) {
    // Point /api at the real backend instead of the Vite dev proxy.
    const realFetch = globalThis.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const absolute = url.startsWith('/') ? `${API}${url}` : url;
      return realFetch(absolute, init);
    };
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    window.cancelAnimationFrame = () => {};
    window.HTMLCanvasElement.prototype.getContext = () => null; // no WebGL in jsdom
    window.addEventListener('error', (e) => errors.push(e.error?.stack || e.message));
    window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.stack || e.reason)));
  },
});

// React logs caught render errors through console.error; capture them, because a caught
// error still means a component is broken even though the page is no longer blank.
const consoleErrors = [];
const origError = dom.window.console.error;
dom.window.console.error = (...args) => {
  consoleErrors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
  origError.apply(dom.window.console, args);
};

try {
  dom.window.eval(fs.readFileSync(`dist/assets/${jsRef[1]}`, 'utf8'));
} catch (e) {
  errors.push(`bundle threw: ${e.stack || e}`);
}

// Let the mount effects fetch from the live API and settle.
await new Promise((r) => setTimeout(r, 3000));

const root = dom.window.document.getElementById('root');
const text = dom.window.document.body.textContent.trim();
console.log(`bundle evaluated : ${errors.length === 0 ? 'clean' : 'threw'}`);
console.log(`#root children   : ${root ? root.children.length : 'missing'}`);
console.log(`rendered text    : ${text.length} chars`);
console.log(`svg elements     : ${dom.window.document.querySelectorAll('svg').length}`);
console.log(`paths in DOM     : ${dom.window.document.querySelectorAll('path').length}`);

const panelFailures = consoleErrors.filter((m) => /Panel error:|Cannot read properties/.test(m));
if (panelFailures.length) {
  console.log('\nPANEL FAILURES (a component threw and was caught by ErrorBoundary):');
  for (const m of panelFailures.slice(0, 3)) console.log('  ' + m.split('\n')[0]);
}
if (errors.length) {
  console.log('\nUNCAUGHT:');
  for (const e of errors.slice(0, 3)) console.log('  ' + e.split('\n')[0]);
}

const blank = !text.length;
const failed = blank || errors.length > 0 || panelFailures.length > 0;
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${
  blank ? 'page rendered nothing'
  : panelFailures.length ? 'a panel threw despite the boundary'
  : errors.length ? 'an uncaught error occurred'
  : 'app rendered with live data'}`);
process.exit(failed ? 1 : 0);
