/**
 * directModeling.ts — Direct 3D Modeling, Plane Locking & Push/Pull Engine
 *
 * Implements IngeTrazo's SketchUp-format modeling core for BIMWorks:
 * 1. PlaneLock: Arrow-key lockable 3D drawing planes (X/YZ, Y/XZ, Z/XY, Ref/Face).
 * 2. AxisMagnet: 3-degree magnetic snap to coordinate axes.
 * 3. 3D Planar primitives: Line, Rectangle, Circle, Arc on any 3D face or plane.
 * 4. Extrusion & Hermetic Watertight Solids (Push/Pull).
 * 5. Honest Takeoff Quantities (Signed tetrahedron volume & surface area).
 */

import * as THREE from 'three';

export type PlaneLockType = 'x' | 'y' | 'z' | 'ref' | null;

export interface PlaneLockState {
  lock: PlaneLockType;
  label: string;
  color: string;
}

export const PLANE_LOCK_CONFIG: Record<string, { label: string; color: string; normal: [number, number, number] }> = {
  x: { label: 'YZ Plane (X-Lock)', color: '#dc2626', normal: [1, 0, 0] },
  y: { label: 'XZ Plane (Y-Lock)', color: '#16a34a', normal: [0, 1, 0] },
  z: { label: 'XY Plane (Z-Lock)', color: '#2563eb', normal: [0, 0, 1] },
  ref: { label: 'Face / Reference Lock', color: '#c026d3', normal: [0, 0, 1] },
};

/**
 * Two orthonormal in-plane axes derived from a plane normal (IngeTrazo _plane_axes / plane_basis).
 */
export function getPlaneBasis(normal: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const n = normal.clone().normalize();
  let ref = new THREE.Vector3(1, 0, 0);
  if (Math.abs(n.dot(ref)) > 0.9) {
    ref = new THREE.Vector3(0, 1, 0);
  }
  const u = ref.clone().sub(n.clone().multiplyScalar(n.dot(ref))).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v };
}

/**
 * Determines the 3D drawing plane based on active lock, hovered face, or default ground plane.
 */
export function getWorkingPlane(
  lock: PlaneLockType,
  anchorPoint: THREE.Vector3 | null,
  hoveredNormal: THREE.Vector3 | null = null,
  hoveredPoint: THREE.Vector3 | null = null
): THREE.Plane {
  const origin = anchorPoint || hoveredPoint || new THREE.Vector3(0, 0, 0);

  if (lock === 'x') {
    return new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(1, 0, 0), origin);
  }
  if (lock === 'y') {
    return new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), origin);
  }
  if (lock === 'z') {
    return new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), origin);
  }
  if (lock === 'ref' && hoveredNormal && hoveredPoint) {
    return new THREE.Plane().setFromNormalAndCoplanarPoint(hoveredNormal.clone().normalize(), hoveredPoint);
  }
  if (hoveredNormal && hoveredPoint) {
    return new THREE.Plane().setFromNormalAndCoplanarPoint(hoveredNormal.clone().normalize(), hoveredPoint);
  }

  // Default: Horizontal ground plane at anchor's elevation or Z=0
  const zElevation = anchorPoint ? anchorPoint.z : 0;
  return new THREE.Plane(new THREE.Vector3(0, 0, 1), -zElevation);
}

/**
 * IngeTrazo AxisMagnet: within 3 degrees of a coordinate axis, snaps the direction vector to that axis.
 */
export function apply3DAxisMagnet(
  start: THREE.Vector3,
  current: THREE.Vector3,
  magnetDeg: number = 3.0
): { point: THREE.Vector3; axis: 'x' | 'y' | 'z' | null; color?: string } {
  const delta = current.clone().sub(start);
  const len = delta.length();
  if (len < 1e-4) return { point: current, axis: null };

  const dir = delta.clone().normalize();
  const radTol = (magnetDeg * Math.PI) / 180;

  // Test X axis (+/-)
  const dotX = dir.dot(new THREE.Vector3(1, 0, 0));
  if (Math.abs(Math.abs(dotX) - 1.0) < radTol * radTol * 0.5 || Math.acos(Math.min(1, Math.abs(dotX))) < radTol) {
    const sign = dotX >= 0 ? 1 : -1;
    return {
      point: new THREE.Vector3(start.x + sign * len, start.y, start.z),
      axis: 'x',
      color: '#dc2626',
    };
  }

  // Test Y axis (+/-)
  const dotY = dir.dot(new THREE.Vector3(0, 1, 0));
  if (Math.abs(Math.abs(dotY) - 1.0) < radTol * radTol * 0.5 || Math.acos(Math.min(1, Math.abs(dotY))) < radTol) {
    const sign = dotY >= 0 ? 1 : -1;
    return {
      point: new THREE.Vector3(start.x, start.y + sign * len, start.z),
      axis: 'y',
      color: '#16a34a',
    };
  }

  // Test Z axis (+/-)
  const dotZ = dir.dot(new THREE.Vector3(0, 0, 1));
  if (Math.abs(Math.abs(dotZ) - 1.0) < radTol * radTol * 0.5 || Math.acos(Math.min(1, Math.abs(dotZ))) < radTol) {
    const sign = dotZ >= 0 ? 1 : -1;
    return {
      point: new THREE.Vector3(start.x, start.y, start.z + sign * len),
      axis: 'z',
      color: '#2563eb',
    };
  }

  return { point: current, axis: null };
}

/**
 * Computes 4 vertices of a 3D rectangle on any plane defined by normal and opposite corners.
 */
export function compute3DRectangleVertices(
  start: THREE.Vector3,
  current: THREE.Vector3,
  normal: THREE.Vector3
): THREE.Vector3[] {
  const { u, v } = getPlaneBasis(normal);
  const diff = current.clone().sub(start);
  const du = diff.dot(u);
  const dv = diff.dot(v);

  const p0 = start.clone();
  const p1 = start.clone().addScaledVector(u, du);
  const p2 = start.clone().addScaledVector(u, du).addScaledVector(v, dv);
  const p3 = start.clone().addScaledVector(v, dv);

  return [p0, p1, p2, p3];
}

/**
 * Computes vertices of a 3D circle on any plane defined by center, normal, and radius.
 */
export function compute3DCircleVertices(
  center: THREE.Vector3,
  radius: number,
  normal: THREE.Vector3,
  segments: number = 32
): THREE.Vector3[] {
  const { u, v } = getPlaneBasis(normal);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const pt = center
      .clone()
      .addScaledVector(u, radius * Math.cos(theta))
      .addScaledVector(v, radius * Math.sin(theta));
    pts.push(pt);
  }
  return pts;
}

/**
 * Extrudes a closed 3D planar polygon along its normal to create a manifold watertight solid.
 */
export function extrudePlanarPolygon(
  vertices: THREE.Vector3[],
  normal: THREE.Vector3,
  depth: number
): {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
} {
  const n = normal.clone().normalize();
  const count = vertices.length;
  if (count < 3) {
    return {
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      normals: new Float32Array(0),
    };
  }

  // Bottom cap: vertices as is
  // Top cap: vertices translated along normal by depth
  const offset = n.clone().multiplyScalar(depth);
  const topVertices = vertices.map((v) => v.clone().add(offset));

  const allVertices: THREE.Vector3[] = [];
  const allNormals: THREE.Vector3[] = [];
  const allIndices: number[] = [];

  // 1. Bottom Cap (Facing -normal)
  const bottomNorm = n.clone().negate();
  const bottomStartIndex = allVertices.length;
  vertices.forEach((v) => {
    allVertices.push(v);
    allNormals.push(bottomNorm);
  });
  // Simple fan triangulation for bottom cap (wound clockwise so outward normal is -n)
  for (let i = 1; i < count - 1; i++) {
    allIndices.push(bottomStartIndex, bottomStartIndex + i + 1, bottomStartIndex + i);
  }

  // 2. Top Cap (Facing +normal)
  const topStartIndex = allVertices.length;
  topVertices.forEach((v) => {
    allVertices.push(v);
    allNormals.push(n);
  });
  // Fan triangulation for top cap (CCW)
  for (let i = 1; i < count - 1; i++) {
    allIndices.push(topStartIndex, topStartIndex + i, topStartIndex + i + 1);
  }

  // 3. Side Quads
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    const b0 = vertices[i];
    const b1 = vertices[next];
    const t0 = topVertices[i];
    const t1 = topVertices[next];

    // Compute side quad normal
    const edge = b1.clone().sub(b0);
    const sideNorm = new THREE.Vector3().crossVectors(edge, n).normalize();
    if (depth < 0) sideNorm.negate();

    const quadStart = allVertices.length;
    allVertices.push(b0, b1, t1, t0);
    allNormals.push(sideNorm, sideNorm, sideNorm, sideNorm);

    allIndices.push(quadStart, quadStart + 1, quadStart + 2);
    allIndices.push(quadStart, quadStart + 2, quadStart + 3);
  }

  const positions = new Float32Array(allVertices.length * 3);
  const normals = new Float32Array(allNormals.length * 3);
  for (let i = 0; i < allVertices.length; i++) {
    positions[i * 3] = allVertices[i].x;
    positions[i * 3 + 1] = allVertices[i].y;
    positions[i * 3 + 2] = allVertices[i].z;

    normals[i * 3] = allNormals[i].x;
    normals[i * 3 + 1] = allNormals[i].y;
    normals[i * 3 + 2] = allNormals[i].z;
  }

  const indices = new Uint32Array(allIndices);
  return { positions, indices, normals };
}

/**
 * Computes the signed tetrahedron volume of a closed triangulated mesh (IngeTrazo face_set_volume).
 * Honest volume = 1/6 * sum(v0 . (v1 x v2)).
 */
export function calculateMeshVolume(
  positions: Float32Array | number[],
  indices: Uint32Array | number[]
): number {
  let totalVolume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;

    const v0 = new THREE.Vector3(positions[i0], positions[i0 + 1], positions[i0 + 2]);
    const v1 = new THREE.Vector3(positions[i1], positions[i1 + 1], positions[i1 + 2]);
    const v2 = new THREE.Vector3(positions[i2], positions[i2 + 1], positions[i2 + 2]);

    const cross = new THREE.Vector3().crossVectors(v1, v2);
    totalVolume += v0.dot(cross) / 6.0;
  }
  return Math.abs(totalVolume);
}

/**
 * Computes the total surface area of a triangulated mesh.
 */
export function calculateMeshArea(
  positions: Float32Array | number[],
  indices: Uint32Array | number[]
): number {
  let totalArea = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;

    const v0 = new THREE.Vector3(positions[i0], positions[i0 + 1], positions[i0 + 2]);
    const v1 = new THREE.Vector3(positions[i1], positions[i1 + 1], positions[i1 + 2]);
    const v2 = new THREE.Vector3(positions[i2], positions[i2 + 1], positions[i2 + 2]);

    const e1 = v1.clone().sub(v0);
    const e2 = v2.clone().sub(v0);
    totalArea += 0.5 * new THREE.Vector3().crossVectors(e1, e2).length();
  }
  return totalArea;
}

