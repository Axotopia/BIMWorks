#!/usr/bin/env node
/**
 * Test Gate: Lapin 3D Architectural Parity
 * Validates:
 * 1. Fine zoom modifier scaling & direction
 * 2. Dynamic surface orbit pivot math (camera world position preservation)
 * 3. 3D window vs crossing containment evaluation
 * 4. 3D triad measurement orthogonal locking & component deltas (ΔX, ΔY, ΔZ)
 */

import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as THREE from 'three';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
function check(desc, cond) {
  if (cond) {
    passed++;
    console.log(`  ok   ${desc}`);
  } else {
    console.error(`  FAIL ${desc}`);
    process.exit(1);
  }
}

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { middlewareMode: true },
});

try {
  const { computeZoomFactor, FINE_ZOOM_STEP_FACTOR } = await server.ssrLoadModule('/src/components/viewport/wheelZoom.ts');
  const { computeOrbitPivot, computeSphericalFromTarget } = await server.ssrLoadModule('/src/components/viewport/orbitPivot.ts');
  const { projectOntoWorldTriadAxis, compute3DMeasurement } = await server.ssrLoadModule('/src/components/viewport/measure3D.ts');
  const { evaluate3DMarqueeSelection } = await server.ssrLoadModule('/src/components/viewport/RectSelection3D.tsx');

  console.log('\n--- 1. Lapin Fine Wheel Zoom Scaling ---');
  const stdIn = computeZoomFactor(-100, false);
  const stdOut = computeZoomFactor(100, false);
  check('Standard zoom-in factor is 0.85', Math.abs(stdIn - 0.85) < 1e-6);
  check('Standard zoom-out factor is 1.15', Math.abs(stdOut - 1.15) < 1e-6);

  const fineIn = computeZoomFactor(-100, true);
  const fineOut = computeZoomFactor(100, true);
  const expectedFineIn = 1.0 - 0.15 * FINE_ZOOM_STEP_FACTOR;
  const expectedFineOut = 1.0 + 0.15 * FINE_ZOOM_STEP_FACTOR;
  check('Fine zoom-in factor is scaled by FINE_ZOOM_STEP_FACTOR (0.97)', Math.abs(fineIn - expectedFineIn) < 1e-6);
  check('Fine zoom-out factor is scaled by FINE_ZOOM_STEP_FACTOR (1.03)', Math.abs(fineOut - expectedFineOut) < 1e-6);

  console.log('\n--- 2. Dynamic Orbit Pivot Math Invariants ---');
  const camPos = new THREE.Vector3(20, 30, 15);
  const oldTarget = new THREE.Vector3(0, 0, 0);
  const newTarget = new THREE.Vector3(10, 5, 2);

  const spherical = computeSphericalFromTarget(camPos, newTarget);
  // Verify camera position reconstructed from spherical relative to newTarget matches camPos exactly
  const relX = spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta);
  const relY = spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta);
  const relZ = spherical.radius * Math.cos(spherical.phi);

  const reconstructedPos = new THREE.Vector3(
    newTarget.x + relX,
    newTarget.y + relY,
    newTarget.z + relZ
  );
  check('Reconstructed X matches camera world position', Math.abs(reconstructedPos.x - camPos.x) < 1e-4);
  check('Reconstructed Y matches camera world position', Math.abs(reconstructedPos.y - camPos.y) < 1e-4);
  check('Reconstructed Z matches camera world position', Math.abs(reconstructedPos.z - camPos.z) < 1e-4);
  check('Camera distance to new target equals computed radius', Math.abs(camPos.distanceTo(newTarget) - spherical.radius) < 1e-4);

  console.log('\n--- 3. 3D Triad Axis Orthogonal Locks ---');
  const startPt = [0, 0, 0];

  // Direction predominantly along X
  const ptX = [10, 2, 1];
  const projX = projectOntoWorldTriadAxis(startPt, ptX);
  check('Predominant X displacement locks onto X axis', projX.activeAxis === 'x');
  check('Projected X coordinate matches input X', projX.projectedPoint[0] === 10);
  check('Projected Y coordinate is clamped to start Y', projX.projectedPoint[1] === 0);
  check('Projected Z coordinate is clamped to start Z', projX.projectedPoint[2] === 0);

  // Direction predominantly along Y
  const ptY = [3, 12, 1];
  const projY = projectOntoWorldTriadAxis(startPt, ptY);
  check('Predominant Y displacement locks onto Y axis', projY.activeAxis === 'y');
  check('Projected Y coordinate matches input Y', projY.projectedPoint[1] === 12);

  // Direction predominantly along Z
  const ptZ = [1, 2, 9];
  const projZ = projectOntoWorldTriadAxis(startPt, ptZ);
  check('Predominant Z displacement locks onto Z axis', projZ.activeAxis === 'z');
  check('Projected Z coordinate matches input Z', projZ.projectedPoint[2] === 9);

  // 3D Measurement component deltas with Shift lock
  const measLocked = compute3DMeasurement([0, 0, 0], [10, 2, 1], true);
  check('Measurement reports isOrthogonalLocked: true when shiftHeld', measLocked.isOrthogonalLocked);
  check('Measurement activeAxis is x', measLocked.activeAxis === 'x');
  check('Locked direct distance equals along-axis delta (10.0)', Math.abs(measLocked.directDistance - 10) < 1e-6);
  check('Locked deltaY is 0.0', measLocked.deltaY === 0);
  check('Locked deltaZ is 0.0', measLocked.deltaZ === 0);

  const measFree = compute3DMeasurement([0, 0, 0], [3, 4, 12], false);
  check('Free measurement reports direct Euclidean distance (13.0)', Math.abs(measFree.directDistance - 13) < 1e-6);
  check('Free measurement activeAxis is null', measFree.activeAxis === null);
  check('Free measurement deltaX is 3.0', measFree.deltaX === 3);
  check('Free measurement deltaY is 4.0', measFree.deltaY === 4);
  check('Free measurement deltaZ is 12.0', measFree.deltaZ === 12);

  console.log('\n--- 4. 3D Marquee Window vs. Crossing Selection ---');
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 1000);
  camera.position.set(0, 0, 50);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const geom1 = new THREE.BoxGeometry(4, 4, 1);
  const mesh1 = new THREE.Mesh(geom1, new THREE.MeshBasicMaterial());
  mesh1.position.set(0, 0, 0);
  mesh1.updateMatrixWorld();
  mesh1.userData = { guid: 'mesh-center' };

  const geom2 = new THREE.BoxGeometry(4, 4, 1);
  const mesh2 = new THREE.Mesh(geom2, new THREE.MeshBasicMaterial());
  mesh2.position.set(15, 0, 0);
  mesh2.updateMatrixWorld();
  mesh2.userData = { guid: 'mesh-right' };

  const meshMap = new Map();
  meshMap.set('mesh-center', mesh1);
  meshMap.set('mesh-right', mesh2);

  // 1. Large Window selection (left-to-right, x0 < x1) enclosing center mesh:
  const windowRect = { x0: 350, y0: 250, x1: 450, y1: 350 };
  const windowHits = evaluate3DMarqueeSelection(windowRect, camera, meshMap, 800, 600);
  check('Window selection strictly selects enclosed center mesh', windowHits.includes('mesh-center'));
  check('Window selection excludes outside mesh', !windowHits.includes('mesh-right'));

  // 2. Small Window selection cutting across center mesh edge:
  const cuttingRectLTR = { x0: 390, y0: 290, x1: 450, y1: 350 }; // Left-to-right (Window)
  const windowCutHits = evaluate3DMarqueeSelection(cuttingRectLTR, camera, meshMap, 800, 600);
  check('Window selection rejects cutting mesh that is not fully enclosed', !windowCutHits.includes('mesh-center'));

  // 3. Crossing selection (right-to-left, x1 < x0) on the exact same cutting rectangle:
  const cuttingRectRTL = { x0: 450, y0: 290, x1: 390, y1: 350 }; // Right-to-left (Crossing)
  const crossingCutHits = evaluate3DMarqueeSelection(cuttingRectRTL, camera, meshMap, 800, 600);
  check('Crossing selection successfully selects intersecting mesh', crossingCutHits.includes('mesh-center'));

  console.log(`\n------------------------------------------------------------------------`);
  console.log(`LAPIN 3D ARCHITECTURAL GATE: ${passed} passed, 0 failed\n`);
} finally {
  await server.close();
}
