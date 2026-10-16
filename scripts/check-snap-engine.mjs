/**
 * check-snap-engine.mjs — Gate for src/interaction/snapEngine.ts.
 *
 * Verifies:
 * 1. All six typed snap candidate kinds:
 *    - intersection
 *    - endpoint
 *    - midpoint
 *    - perpendicular
 *    - extension (forward and backward collinear)
 *    - grid
 * 2. Snap priority hierarchy:
 *    intersection > endpoint > midpoint > perpendicular > extension > grid
 * 3. Range and fallthrough guards:
 *    - off-axis cursor does not trigger extension (falls through to grid)
 *    - far-beyond-reach cursor does not trigger extension (falls through to grid)
 * 4. Window vs Crossing selection box containment helpers:
 *    - isBoxInside
 *    - isBoxCrossing
 *
 * Run:  node scripts/check-snap-engine.mjs
 */

import { fileURLToPath } from 'node:url';

let snapEngine;
try {
  snapEngine = await import('../src/interaction/snapEngine.ts');
} catch (err) {
  // Fall back to spawning with --experimental-strip-types if required by Node 22
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url)], {
      stdio: 'inherit',
    });
    process.exit(0);
  } catch (spawnErr) {
    console.error('Failed to run check-snap-engine with --experimental-strip-types:', spawnErr);
    process.exit(1);
  }
}

const { findSnapCandidate, segmentIntersection, distToSegment, isBoxInside, isBoxCrossing } = snapEngine;

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

console.log('\n--- SnapEngine Gate: Candidate Kinds & Priority ---');

const segH = { p1: [0, 0], p2: [10, 0], guid: 'wall-h' };
const segV = { p1: [5, -5], p2: [5, 5], guid: 'wall-v' };
const segPerpTarget = { p1: [0, 10], p2: [10, 10], guid: 'wall-top' };

// 1. Intersection candidate
const hitIntersection = findSnapCandidate([5.02, 0.02], {
  scale: 20, // tol = 14 / 20 = 0.7 ft
  segments: [segH, segV],
});
check('intersection candidate resolves at crossing segments',
  hitIntersection?.kind === 'intersection' &&
  Math.abs(hitIntersection.point[0] - 5.0) < 1e-4 &&
  Math.abs(hitIntersection.point[1] - 0.0) < 1e-4,
  `kind: ${hitIntersection?.kind}, pt: [${hitIntersection?.point}]`
);
check('intersection candidate carries BOTH source guids (Phase 3 provenance)',
  Array.isArray(hitIntersection?.sources) &&
  hitIntersection.sources.length === 2 &&
  hitIntersection.sources.includes('wall-h') &&
  hitIntersection.sources.includes('wall-v'),
  `sources: ${JSON.stringify(hitIntersection?.sources)}`
);

// 2. Endpoint candidate
const hitEndpoint = findSnapCandidate([10.05, 0.02], {
  scale: 20,
  segments: [segH],
});
check('endpoint candidate resolves near segment end',
  hitEndpoint?.kind === 'endpoint' &&
  hitEndpoint.point[0] === 10 && hitEndpoint.point[1] === 0,
  `kind: ${hitEndpoint?.kind}, pt: [${hitEndpoint?.point}]`
);

// 3. Midpoint candidate
const hitMidpoint = findSnapCandidate([5.05, 0.04], {
  scale: 20,
  segments: [segH],
});
check('midpoint candidate resolves near segment center',
  hitMidpoint?.kind === 'midpoint' &&
  hitMidpoint.point[0] === 5 && hitMidpoint.point[1] === 0,
  `kind: ${hitMidpoint?.kind}, pt: [${hitMidpoint?.point}]`
);

// 4. Perpendicular / Orthogonal candidates
const hitOrthoVert = findSnapCandidate([2.04, 9.96], {
  scale: 20,
  activePoint: [2.0, 0.0],
  segments: [segPerpTarget],
});
check('perpendicular candidate resolves vertical tracking from activePoint',
  hitOrthoVert?.kind === 'perpendicular' &&
  Math.abs(hitOrthoVert.point[0] - 2.0) < 1e-4 &&
  hitOrthoVert.description === 'Vertical',
  `kind: ${hitOrthoVert?.kind}, pt: [${hitOrthoVert?.point}], desc: ${hitOrthoVert?.description}`
);

// Diagonal segment perpendicular
const segDiag = { p1: [0, 0], p2: [10, 10], guid: 'wall-diag' };
const hitPerpSeg = findSnapCandidate([2.52, 7.48], {
  scale: 20,
  activePoint: [0.0, 10.0],
  segments: [segDiag],
});
check('perpendicular candidate resolves normal to angled segment from activePoint',
  hitPerpSeg?.kind === 'perpendicular' &&
  hitPerpSeg.description === 'Perpendicular',
  `kind: ${hitPerpSeg?.kind}, pt: [${hitPerpSeg?.point}], desc: ${hitPerpSeg?.description}`
);

// 5. Extension candidate (forward and backward collinear)
const hitExtForward = findSnapCandidate([13.0, 0.05], {
  scale: 10, // tol = 1.4 ft
  segments: [segH],
});
check('extension candidate resolves beyond segment end',
  hitExtForward?.kind === 'extension' &&
  hitExtForward.point[0] === 13.0 && hitExtForward.point[1] === 0.0 &&
  hitExtForward.description === 'Extension',
  `kind: ${hitExtForward?.kind}, pt: [${hitExtForward?.point}]`
);

const hitExtBackward = findSnapCandidate([-2.0, -0.04], {
  scale: 10,
  segments: [segH],
});
check('extension candidate resolves before segment start',
  hitExtBackward?.kind === 'extension' &&
  hitExtBackward.point[0] === -2.0 && hitExtBackward.point[1] === 0.0 &&
  hitExtBackward.description === 'Extension',
  `kind: ${hitExtBackward?.kind}, pt: [${hitExtBackward?.point}]`
);

// 6. Grid snap (fallthrough when no geometry candidate is near)
const hitGrid = findSnapCandidate([7.35, 2.65], {
  scale: 20,
  segments: [segH],
  enableGridSnap: true,
  gridSize: 0.25,
});
check('grid candidate resolves when away from geometry',
  hitGrid?.kind === 'grid' &&
  hitGrid.point[0] === 7.25 && hitGrid.point[1] === 2.75,
  `kind: ${hitGrid?.kind}, pt: [${hitGrid?.point}]`
);

// Priority checks:
console.log('\n--- SnapEngine Gate: Priority Hierarchy ---');

// Intersection vs Endpoint: intersecting lines at endpoint [10, 0]
const segH2 = { p1: [10, 0], p2: [10, 5], guid: 'wall-corner' };
const prioInterVsEnd = findSnapCandidate([10.02, 0.02], {
  scale: 20,
  segments: [segH, segH2],
});
check('intersection beats endpoint when segments intersect',
  prioInterVsEnd?.kind === 'intersection',
  `got: ${prioInterVsEnd?.kind}`
);

// Endpoint vs Midpoint: close to endpoint on short segment
const prioEndVsMid = findSnapCandidate([10.02, 0.02], {
  scale: 20,
  segments: [segH],
});
check('endpoint beats midpoint near endpoint',
  prioEndVsMid?.kind === 'endpoint',
  `got: ${prioEndVsMid?.kind}`
);

// Perpendicular vs Extension:
// At [2, 10], with segPerpTarget [0, 10]-[10, 10] and activePoint [2, 0], perp matches
const prioPerpVsExt = findSnapCandidate([2.0, 10.02], {
  scale: 20,
  activePoint: [2.0, 0.0],
  segments: [segPerpTarget],
});
check('perpendicular candidate takes precedence over grid/extension when activePoint orthogonal',
  prioPerpVsExt?.kind === 'perpendicular',
  `got: ${prioPerpVsExt?.kind}`
);

// Extension vs Grid: collinear extension beats grid
const prioExtVsGrid = findSnapCandidate([12.02, 0.03], {
  scale: 20,
  segments: [segH],
  enableGridSnap: true,
});
check('extension candidate beats grid snap along collinear projection',
  prioExtVsGrid?.kind === 'extension',
  `got: ${prioExtVsGrid?.kind}`
);

// Off-axis fallthrough to Grid:
const hitOffAxis = findSnapCandidate([13.0, 3.0], {
  scale: 10,
  segments: [segH],
  enableGridSnap: true,
});
check('off-axis point falls through to grid snap',
  hitOffAxis?.kind === 'grid',
  `got: ${hitOffAxis?.kind}`
);

// Beyond-reach fallthrough to Grid:
const hitBeyondReach = findSnapCandidate([60.0, 0.0], {
  scale: 10,
  segments: [segH],
  enableGridSnap: true,
});
check('beyond-reach point (t > 3.0) falls through to grid snap',
  hitBeyondReach?.kind === 'grid',
  `got: ${hitBeyondReach?.kind}`
);

console.log('\n--- SnapEngine Gate: Selection Containment Helpers ---');

const selBox = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
const insideBox = { minX: 2, minY: 2, maxX: 8, maxY: 8 };
const crossingBox = { minX: 5, minY: 5, maxX: 15, maxY: 15 };
const outsideBox = { minX: 20, minY: 20, maxX: 30, maxY: 30 };

check('isBoxInside returns true for enclosed box', isBoxInside(insideBox, selBox) === true);
check('isBoxInside returns false for crossing box', isBoxInside(crossingBox, selBox) === false);
check('isBoxInside returns false for outside box', isBoxInside(outsideBox, selBox) === false);

check('isBoxCrossing returns true for enclosed box', isBoxCrossing(insideBox, selBox) === true);
check('isBoxCrossing returns true for crossing box', isBoxCrossing(crossingBox, selBox) === true);
check('isBoxCrossing returns false for outside box', isBoxCrossing(outsideBox, selBox) === false);

console.log('\n------------------------------------------------------------------------');
console.log(`SNAP-ENGINE GATE: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
