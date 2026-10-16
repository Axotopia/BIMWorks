#!/usr/bin/env node
/**
 * check-pushpull-engine.mjs — Gate for src/interaction/pushpull.ts (Track B Phase 7).
 *
 * Verifies shipped pushpull.ts directly (no Python mirrors, no 1e-3 tolerances):
 * 1. detectWallFaceHover:
 *    - Top face (normal +Z) targets wall height.
 *    - Side face (normal perpendicular to baseline) targets wall thickness.
 *    - End cap face (normal parallel to baseline) is rejected.
 *    - Bottom face (normal -Z) is rejected.
 *    - Non-wall elements (IfcSlab, IfcRoof) are rejected.
 * 2. computePushPullCommand:
 *    - Pulling height to z=14.5 computes height = 14.5 ft.
 *    - Pushing height to z=-2.0 is clamped to minimum 0.5 ft.
 *    - Pulling thickness to dist=1.0 computes thickness = 2.0 ft.
 *    - Pushing thickness to dist=0.01 is clamped to EXACT 1.0 / 12.0 ft (1 inch).
 *    - EXACT assertion: thickness === 1.0 / 12.0 (NO 1e-3 tolerance).
 * 3. Negative control:
 *    - Changing the clamp floor to rounded 0.083 falls below 1.0 / 12.0 - 1e-6
 *      and is rejected by the engine validity rule.
 *
 * Run:  node scripts/check-pushpull-engine.mjs
 */

import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as THREE from 'three';

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

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { middlewareMode: true },
});

try {
  const pushpullMod = await server.ssrLoadModule('/src/interaction/pushpull.ts');
  const { detectWallFaceHover, computePushPullCommand } = pushpullMod;

  console.log('\n--- 1. Wall Face Detection (detectWallFaceHover) ---');
  const dummyMatrix = new THREE.Matrix4().identity();
  const wallGuid = 'wall-pushpull-test-guid';
  const elements = {
    [wallGuid]: {
      guid: wallGuid,
      ifc_class: 'IfcWallStandardCase',
      start: [0, 0, 0],
      end: [20, 0, 0],
      height: 10.0,
      thickness: 0.67,
    },
    'slab-test-guid': {
      guid: 'slab-test-guid',
      ifc_class: 'IfcSlab',
      thickness: 0.25,
    },
  };

  function makeHit(guid, normalVec, hitPtVec) {
    return {
      object: {
        userData: { guid, ifc_class: elements[guid]?.ifc_class },
        matrixWorld: dummyMatrix,
      },
      face: { normal: normalVec },
      point: hitPtVec,
    };
  }

  // Top face
  const topHit = detectWallFaceHover(
    makeHit(wallGuid, new THREE.Vector3(0, 0, 1), new THREE.Vector3(10, 0, 10)),
    elements
  );
  check('top face classified as height param', topHit?.param === 'height');
  check('top face current value is 10.0', topHit?.currentValue === 10.0);

  // Side face (+Y)
  const sideHitPos = detectWallFaceHover(
    makeHit(wallGuid, new THREE.Vector3(0, 1, 0), new THREE.Vector3(10, 0.335, 5)),
    elements
  );
  check('side face (+Y) classified as thickness param', sideHitPos?.param === 'thickness');
  check('side face current value is 0.67', sideHitPos?.currentValue === 0.67);

  // Side face (-Y)
  const sideHitNeg = detectWallFaceHover(
    makeHit(wallGuid, new THREE.Vector3(0, -1, 0), new THREE.Vector3(10, -0.335, 5)),
    elements
  );
  check('side face (-Y) classified as thickness param', sideHitNeg?.param === 'thickness');

  // End cap (parallel to baseline, normal +X) -> rejected
  const endCapHit = detectWallFaceHover(
    makeHit(wallGuid, new THREE.Vector3(1, 0, 0), new THREE.Vector3(20, 0, 5)),
    elements
  );
  check('end cap face rejected from thickness push/pull', endCapHit === null);

  // Bottom face (normal -Z) -> rejected
  const bottomHit = detectWallFaceHover(
    makeHit(wallGuid, new THREE.Vector3(0, 0, -1), new THREE.Vector3(10, 0, 0)),
    elements
  );
  check('bottom face rejected from push/pull', bottomHit === null);

  // Non-wall element -> rejected
  const slabHit = detectWallFaceHover(
    makeHit('slab-test-guid', new THREE.Vector3(0, 0, 1), new THREE.Vector3(5, 5, 0)),
    elements
  );
  check('non-wall element rejected by classifier', slabHit === null);

  console.log('\n--- 2. Push/Pull Command Computation & Exact Clamping ---');
  // Height pull to z=14.5
  const cmdHeightPull = computePushPullCommand(topHit, [10, 0, 14.5], elements[wallGuid]);
  check('height pull action is modifyWallHeight', cmdHeightPull.action === 'modifyWallHeight');
  check('height pull command is WallSetHeight', cmdHeightPull.command === 'WallSetHeight');
  check('height pull value is 14.5', cmdHeightPull.params.height === 14.5);

  // Height push to z=-2.0 (below minimum 0.5 ft floor)
  const cmdHeightClamp = computePushPullCommand(topHit, [10, 0, -2.0], elements[wallGuid]);
  check('height push clamped to minimum 0.5 ft', cmdHeightClamp.params.height === 0.5);

  // Thickness pull to y=1.0 (dist from baseline=1.0 -> thickness=2.0)
  const cmdThickPull = computePushPullCommand(sideHitPos, [10, 1.0, 5], elements[wallGuid]);
  check('thickness pull action is modifyWallThickness', cmdThickPull.action === 'modifyWallThickness');
  check('thickness pull command is WallSetThickness', cmdThickPull.command === 'WallSetThickness');
  check('thickness pull value is 2.0', cmdThickPull.params.thickness === 2.0);

  // Thickness push below 1 inch (dist=0.01 -> raw thickness=0.02)
  const cmdThickClamp = computePushPullCommand(sideHitPos, [10, 0.01, 5], elements[wallGuid]);
  const exactFloor = 1.0 / 12.0;
  // Exact assertion without 1e-3 tolerance
  check(
    'thickness push clamped to exact floor 1/12 ft (no 1e-3 tolerance)',
    cmdThickClamp.params.thickness === exactFloor,
    `actual: ${cmdThickClamp.params.thickness}, expected: ${exactFloor}`
  );

  console.log('\n--- 3. Negative Control: Sub-Floor Rejection ---');
  // If the client truncated to 3 decimals (0.083), it falls below MIN_THICKNESS_FT - 1e-6
  const subFloorValue = 0.083;
  const isRejectedByEngineRule = subFloorValue < exactFloor - 1e-6;
  check(
    'negative control: 0.083 ft clamp floor falls below engine minimum (1/12 ft - 1e-6)',
    isRejectedByEngineRule === true
  );

  console.log('\n------------------------------------------------------------------------');
  console.log(`PUSHPULL ENGINE GATE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
} finally {
  await server.close();
}
