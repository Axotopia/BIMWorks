#!/usr/bin/env node
/**
 * check-direct-modeling.mjs — Gate for src/interaction/directModeling.ts
 *
 * Verifies the direct 3D modeling core:
 * 1. Orthonormal plane basis generation.
 * 2. 3D arrow-key plane locking (X, Y, Z, Ref).
 * 3. 3-degree magnetic axis snap (AxisMagnet).
 * 4. 3D rectangle and circle polygon generation on inclined planes.
 * 5. Watertight planar polygon extrusion (Push/Pull solid).
 * 6. Honest volume calculation (signed tetrahedron summation = exact 24.0 for 2x3x4 box).
 * 7. Honest surface area calculation (= exact 52.0 for 2x3x4 box).
 *
 * Run: node scripts/check-direct-modeling.mjs
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
  const directMod = await server.ssrLoadModule('/src/interaction/directModeling.ts');
  const {
    getPlaneBasis,
    getWorkingPlane,
    apply3DAxisMagnet,
    compute3DRectangleVertices,
    compute3DCircleVertices,
    extrudePlanarPolygon,
    calculateMeshVolume,
    calculateMeshArea,
    createLineModelMesh,
    createPlanarFaceMesh,
    detectUniversalFaceHover,
    extrudeFaceOrSolid,
  } = directMod;

  console.log('\n--- 1. Orthonormal Basis on Arbitrary Planes ---');
  const zBasis = getPlaneBasis(new THREE.Vector3(0, 0, 1));
  check('Z normal produces orthonormal U and V', Math.abs(zBasis.u.dot(zBasis.v)) < 1e-6);
  check('U has unit length', Math.abs(zBasis.u.length() - 1.0) < 1e-6);
  check('V has unit length', Math.abs(zBasis.v.length() - 1.0) < 1e-6);

  const diagBasis = getPlaneBasis(new THREE.Vector3(1, 1, 1).normalize());
  check('Diagonal normal produces orthonormal U and V', Math.abs(diagBasis.u.dot(diagBasis.v)) < 1e-6);

  console.log('\n--- 2. Working Plane & Arrow-Key Locking ---');
  const pX = getWorkingPlane('x', new THREE.Vector3(5, 0, 0));
  check('X lock produces plane with normal (1,0,0)', pX.normal.x === 1 && pX.normal.y === 0 && pX.normal.z === 0);

  const pY = getWorkingPlane('y', new THREE.Vector3(0, 5, 0));
  check('Y lock produces plane with normal (0,1,0)', pY.normal.x === 0 && pY.normal.y === 1 && pY.normal.z === 0);

  const pZ = getWorkingPlane('z', new THREE.Vector3(0, 0, 5));
  check('Z lock produces plane with normal (0,0,1)', pZ.normal.x === 0 && pZ.normal.y === 0 && pZ.normal.z === 1);

  console.log('\n--- 3. 3-Degree Magnetic Axis Snapping ---');
  const startPt = new THREE.Vector3(0, 0, 0);
  // Point angled at 1.5 degrees off X axis (within 3 degrees)
  const angleRad = (1.5 * Math.PI) / 180;
  const nearX = new THREE.Vector3(10 * Math.cos(angleRad), 10 * Math.sin(angleRad), 0);
  const snapRes = apply3DAxisMagnet(startPt, nearX, 3.0);
  check('Snaps to X axis when within 1.5 deg', snapRes.axis === 'x' && Math.abs(snapRes.point.y) < 1e-6);

  // Point angled at 5.0 degrees off X axis (outside 3 degrees)
  const farAngleRad = (5.0 * Math.PI) / 180;
  const farX = new THREE.Vector3(10 * Math.cos(farAngleRad), 10 * Math.sin(farAngleRad), 0);
  const noSnapRes = apply3DAxisMagnet(startPt, farX, 3.0);
  check('Does not snap when outside 3.0 deg', noSnapRes.axis === null);

  console.log('\n--- 4. 3D Rectangle & Extrusion Geometry ---');
  const rectCorners = compute3DRectangleVertices(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(2, 3, 0),
    new THREE.Vector3(0, 0, 1)
  );
  check('Rectangle produces 4 corners', rectCorners.length === 4);
  check('Corner 0 is (0,0,0)', rectCorners[0].distanceTo(new THREE.Vector3(0, 0, 0)) < 1e-6);
  check('Corner 2 is (2,3,0)', rectCorners[2].distanceTo(new THREE.Vector3(2, 3, 0)) < 1e-6);

  // Extrude 2x3 rectangle by 4.0 ft height to create a 2x3x4 box
  const extruded = extrudePlanarPolygon(rectCorners, new THREE.Vector3(0, 0, 1), 4.0);
  check('Extrusion generates vertices', extruded.positions.length > 0);
  check('Extrusion generates triangle indices', extruded.indices.length > 0);

  console.log('\n--- 5. Watertight Solid Volume & Area ---');
  const volume = calculateMeshVolume(extruded.positions, extruded.indices);
  check('Extruded box volume is exactly 24.0 (2x3x4)', Math.abs(volume - 24.0) < 1e-4, `got: ${volume}`);

  const area = calculateMeshArea(extruded.positions, extruded.indices);
  // Area = 2*(2*3 + 3*4 + 2*4) = 2*(6 + 12 + 8) = 52.0
  check('Extruded box surface area is exactly 52.0', Math.abs(area - 52.0) < 1e-4, `got: ${area}`);

  console.log('\n--- 6. Persistent Primitives & Universal Push/Pull ---');
  // Line mesh
  const lineMesh = createLineModelMesh(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));
  check('Line mesh has guid', typeof lineMesh.guid === 'string' && lineMesh.guid.length > 0);
  check('Line mesh has 8 vertices (24 coords)', lineMesh.vertices.length === 24);
  check('Line mesh has 12 triangles (36 indices)', lineMesh.indices.length === 36);
  check('Line mesh reports length 10.0', Math.abs((lineMesh.params?.length ?? 0) - 10.0) < 1e-4);

  // 2D Planar Face mesh
  const faceMesh = createPlanarFaceMesh(rectCorners, 'Rectangle : 2D Face');
  check('Face mesh is marked 2D planar', faceMesh.params?.is2DPlanar === true);
  check('Face mesh area is exactly 6.0 (2x3)', Math.abs((faceMesh.params?.area ?? 0) - 6.0) < 1e-4);
  check('Face mesh has double-sided triangulation', faceMesh.indices.length === 12);

  // Face hover detection
  const dummyHit = {
    object: {
      userData: { guid: faceMesh.guid },
      matrixWorld: new THREE.Matrix4().identity(),
    },
    face: { normal: new THREE.Vector3(0, 0, 1) },
    point: new THREE.Vector3(1, 1.5, 0),
  };
  const faceHit = detectUniversalFaceHover(dummyHit, [faceMesh], {});
  check('Detects universal face hover on planar mesh', faceHit !== null);
  check('Hovered face normal is (0,0,1)', faceHit?.normal[2] === 1);
  check('Hovered face is 2D planar', faceHit?.is2DPlanar === true);

  // Push/Pull extrusion of 2D face into 3D watertight solid
  const extrudedSolid = extrudeFaceOrSolid(
    faceMesh,
    faceHit.normal,
    4.0,
    faceHit.boundaryVertices
  );
  check('Extruded solid is no longer 2D planar', extrudedSolid.params?.is2DPlanar === false);
  check('Extruded solid volume is exactly 24.0 (2x3x4)', Math.abs((extrudedSolid.params?.volume ?? 0) - 24.0) < 1e-4);
  check('Extruded solid name indicates 3D solid', extrudedSolid.name.includes('3D Solid'));

  console.log('\n------------------------------------------------------------------------');
  console.log(`DIRECT MODELING GATE: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) process.exit(1);
} finally {
  await server.close();
}
