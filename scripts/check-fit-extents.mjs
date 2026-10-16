#!/usr/bin/env node
/**
 * check-fit-extents.mjs — Track A5 gate ("fit on view switch").
 *
 * Authority: this gate imports the SHIPPED `src/interaction/fitExtents.ts` via
 * Vite's SSR loader and asserts on the transform that function returns. It does
 * not re-implement the fit maths, and it does not assert on its own arithmetic.
 * The predicate that judges the transform (centred? 60-90%?) is defined here, so
 * a stub in the shipped module cannot make the judgement pass.
 *
 * This replaces the previous section A5b in check-ui-p0.mjs, which declared its
 * own `computeFitTransform`, fed it hardcoded fixtures, and asserted on its own
 * output — it passed with the real viewport's fit function replaced by `return`.
 *
 * Asserts:
 *   1. Plan / section / elevation fixtures fit at 60-90% and are centred.
 *   2. The shipped function does not return the identity transform (negative
 *      control: stubbing it to identity must fail this gate).
 *   3. The predicate discriminates — an identity transform is rejected by the
 *      same centring/fraction predicates used in (1).
 *   4. Degenerate input is handled: no usable coordinates -> bbox null, so the
 *      viewport leaves the pan/zoom it had rather than snapping to origin.
 *   5. `collectFitPaths` still gathers all five path sources.
 *   6. The viewport actually calls the shared function (wiring check).
 *   7. Known limitation, pinned rather than hidden: the 10..150 scale clamp means
 *      a very small fixture cannot reach 60% occupancy.
 *
 * Run:  node scripts/check-fit-extents.mjs
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}${extra ? ` (${extra})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

// --- judgement predicates, defined here (not imported) ----------------------

/** Screen-space centre of the fitted content. */
function screenCentre(fit) {
  return {
    x: fit.pan.x + fit.bbox.cx * fit.scale,
    y: fit.pan.y - fit.bbox.cy * fit.scale,
  };
}

/** Largest axis occupancy of the viewport, 0..1+. */
function occupancy(fit, W, H) {
  return Math.max((fit.bbox.w * fit.scale) / W, (fit.bbox.h * fit.scale) / H);
}

function isCentred(fit, W, H, tol = 0.5) {
  const c = screenCentre(fit);
  return Math.abs(c.x - W / 2) < tol && Math.abs(c.y - H / 2) < tol;
}

function isIdentity(fit) {
  return fit.scale === 1 && fit.pan.x === 0 && fit.pan.y === 0;
}

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { middlewareMode: true },
});

try {
  const mod = await server.ssrLoadModule('/src/interaction/fitExtents.ts');
  const {
    computeFitTransform,
    collectFitPaths,
    extractFitBounds,
    FIT_FRACTION,
    MIN_FIT_SCALE,
    MAX_FIT_SCALE,
    EMPTY_FIT,
  } = mod;

  const W = 800;
  const H = 600;

  // Fixtures shaped like the real 2D contract: M/L path strings in model feet.
  const fixtures = {
    plan: [
      { d: 'M 0 0 L 30 0 L 30 20 L 0 20 Z' },
      { d: 'M 5 5 L 15 5 L 15 15 L 5 15 Z' },
      { d: 'M 18 4 L 26 4 L 26 9 L 18 9 Z' },
    ],
    section: [{ d: 'M 0 0 L 30 0 L 30 10 L 0 10 Z' }, { d: 'M 4 0 L 4 8 L 9 8 L 9 0 Z' }],
    elevation: [{ d: 'M -5 0 L 25 0 L 25 12 L -5 12 Z' }],
  };

  console.log('\n--- 1. Fit transform from the shipped function (60-90%, centred) ---');
  const transforms = {};
  for (const [name, paths] of Object.entries(fixtures)) {
    const fit = computeFitTransform(paths, W, H);
    transforms[name] = fit;
    check(`${name}: bbox derived`, fit.bbox !== null);
    if (!fit.bbox) continue;
    const frac = occupancy(fit, W, H);
    check(
      `${name}: content occupies 60-90% of viewport`,
      frac >= 0.6 && frac <= 0.9,
      `${(frac * 100).toFixed(1)}%`
    );
    check(`${name}: content is centred`, isCentred(fit, W, H), JSON.stringify(screenCentre(fit)));
    check(
      `${name}: scale within the 10..150 clamp`,
      fit.scale >= MIN_FIT_SCALE && fit.scale <= MAX_FIT_SCALE,
      `scale=${fit.scale.toFixed(3)}`
    );
  }

  console.log('\n--- 2. Negative control: the shipped function must not be identity ---');
  for (const [name, fit] of Object.entries(transforms)) {
    check(
      `${name}: shipped transform is NOT identity (a stubbed fit fails here)`,
      !isIdentity(fit),
      `scale=${fit.scale.toFixed(3)}, pan=(${fit.pan.x.toFixed(1)}, ${fit.pan.y.toFixed(1)})`
    );
  }

  console.log('\n--- 3. Negative control: the predicate rejects identity ---');
  {
    const real = transforms.plan;
    const identity = { scale: 1, pan: { x: 0, y: 0 }, bbox: real.bbox };
    check('identity transform is not centred', !isCentred(identity, W, H));
    const idFrac = occupancy(identity, W, H);
    check('identity transform is outside 60-90%', !(idFrac >= 0.6 && idFrac <= 0.9), `${(idFrac * 100).toFixed(1)}%`);
  }

  console.log('\n--- 4. Degenerate input leaves the transform alone ---');
  check('no paths -> bbox null', computeFitTransform([], W, H).bbox === null);
  check('unparseable paths -> bbox null', computeFitTransform([{ d: 'Z' }], W, H).bbox === null);
  check('single point -> bbox null', extractFitBounds([{ d: 'M 4 4' }]) === null);
  check(
    'empty viewport fallback is still 40 @ (350, 320)',
    EMPTY_FIT.scale === 40 && EMPTY_FIT.pan.x === 350 && EMPTY_FIT.pan.y === 320
  );

  console.log('\n--- 5. collectFitPaths gathers every source ---');
  {
    const payload = {
      cut_paths: [{ d: 'M 0 0 L 1 0 L 1 1' }],
      projection_paths: [{ d: 'M 0 0 L 1 0 L 1 1' }],
      roofs: [{ d: 'M 0 0 L 1 0 L 1 1' }],
      slabs: [{ d: 'M 0 0 L 1 0 L 1 1' }],
      levels: [{ d: 'M 0 0 L 1 0 L 1 1' }],
    };
    check('all five sources are collected', collectFitPaths(payload).length === 5);
    check('null payload is safe', collectFitPaths(null).length === 0);
  }

  console.log('\n--- 6. The viewport calls the shared function ---');
  {
    const src = readFileSync(join(ROOT, 'src/components/drafting/PlanViewport2D.tsx'), 'utf-8');
    check('PlanViewport2D imports computeFitTransform from fitExtents', /computeFitTransform/.test(src) && /fitExtents/.test(src));
    check('PlanViewport2D no longer inlines the bounds loop', !/matchAll\(\/\(\[ML\]\)/.test(src));
    check('fit2DToExtents calls computeFitTransform', /const fit = computeFitTransform\(/.test(src));
  }

  console.log('\n--- 7. Pinned limitation: the scale clamp bounds small fixtures ---');
  {
    const tiny = computeFitTransform([{ d: 'M 0 0 L 2 0 L 2 2 L 0 2 Z' }], W, H);
    const frac = occupancy(tiny, W, H);
    check(
      'a 2x2 ft fixture hits MAX_FIT_SCALE and cannot reach 60%',
      tiny.scale === MAX_FIT_SCALE && frac < 0.6,
      `scale=${tiny.scale}, ${(frac * 100).toFixed(1)}% — known A5 limitation, not a regression`
    );
  }

  check('FIT_FRACTION is 0.78 (the box occupancy the plan asked for)', FIT_FRACTION === 0.78);
} finally {
  await server.close();
}

console.log('\n------------------------------------------------------------------------');
console.log(`FIT-EXTENTS GATE: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
