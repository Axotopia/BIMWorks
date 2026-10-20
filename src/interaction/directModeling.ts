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
import type { MeshBufferData } from '../types/bim';

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

function generateSafeGuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'geom-' + Math.random().toString(36).substring(2, 11) + '-' + Date.now().toString(36);
}

/**
 * Creates a persistent 3D model line mesh represented as a slender, watertight box
 * with sharp edges, immediately renderable and selectable in Three.js.
 */
export function createLineModelMesh(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  name?: string
): MeshBufferData {
  const diff = p1.clone().sub(p0);
  const len = diff.length();
  const dir = len > 1e-5 ? diff.clone().normalize() : new THREE.Vector3(1, 0, 0);
  const { u, v } = getPlaneBasis(dir);
  const r = 0.03; // Radius / half-width (~0.36 in)

  // 8 box corners around the segment p0 -> p1
  const c0 = p0.clone().addScaledVector(u, -r).addScaledVector(v, -r);
  const c1 = p0.clone().addScaledVector(u, r).addScaledVector(v, -r);
  const c2 = p0.clone().addScaledVector(u, r).addScaledVector(v, r);
  const c3 = p0.clone().addScaledVector(u, -r).addScaledVector(v, r);

  const c4 = p1.clone().addScaledVector(u, -r).addScaledVector(v, -r);
  const c5 = p1.clone().addScaledVector(u, r).addScaledVector(v, -r);
  const c6 = p1.clone().addScaledVector(u, r).addScaledVector(v, r);
  const c7 = p1.clone().addScaledVector(u, -r).addScaledVector(v, r);

  const corners = [c0, c1, c2, c3, c4, c5, c6, c7];
  const positions: number[] = [];
  corners.forEach((c) => positions.push(c.x, c.y, c.z));

  // 12 triangles for 6 box faces
  const indices: number[] = [
    // Bottom cap (p0)
    0, 2, 1, 0, 3, 2,
    // Top cap (p1)
    4, 5, 6, 4, 6, 7,
    // Side 1
    0, 1, 5, 0, 5, 4,
    // Side 2
    1, 2, 6, 1, 6, 5,
    // Side 3
    2, 3, 7, 2, 7, 6,
    // Side 4
    3, 0, 4, 3, 4, 7,
  ];

  const guid = generateSafeGuid();
  const elemName = name || 'Line : 3D Model Line';

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  corners.forEach((c) => {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    minZ = Math.min(minZ, c.z);
    maxX = Math.max(maxX, c.x);
    maxY = Math.max(maxY, c.y);
    maxZ = Math.max(maxZ, c.z);
  });

  return {
    guid,
    name: elemName,
    ifc_class: 'IfcBuildingElementProxy',
    vertices: positions,
    indices,
    color: '#334155',
    cut_color: '#0f172a',
    opacity: 1.0,
    bbox: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    },
    params: {
      name: elemName,
      ifc_class: 'IfcBuildingElementProxy',
      start: [p0.x, p0.y, p0.z],
      end: [p1.x, p1.y, p1.z],
      length: len,
      is3DLine: true,
    },
  };
}

/**
 * Creates a persistent 2D planar face mesh from an ordered boundary polygon.
 * Double-sided so it renders crisp surfaces on any 3D drawing plane and is immediately push/pullable.
 */
export function createPlanarFaceMesh(
  vertices: THREE.Vector3[],
  name?: string,
  ifcClass?: string
): MeshBufferData {
  const count = vertices.length;
  if (count < 3) {
    throw new Error('createPlanarFaceMesh requires at least 3 vertices');
  }

  // Compute plane normal using Newell / cross product
  const e1 = vertices[1].clone().sub(vertices[0]);
  const e2 = vertices[2].clone().sub(vertices[0]);
  const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
  if (n.lengthSq() < 1e-6) n.set(0, 0, 1);

  const positions: number[] = [];
  vertices.forEach((v) => positions.push(v.x, v.y, v.z));

  // Double-sided fan triangulation
  const indices: number[] = [];
  // Front CCW
  for (let i = 1; i < count - 1; i++) {
    indices.push(0, i, i + 1);
  }
  // Back CW (visible and raycastable from underneath/reverse)
  for (let i = 1; i < count - 1; i++) {
    indices.push(0, i + 1, i);
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  vertices.forEach((v) => {
    minX = Math.min(minX, v.x);
    minY = Math.min(minY, v.y);
    minZ = Math.min(minZ, v.z);
    maxX = Math.max(maxX, v.x);
    maxY = Math.max(maxY, v.y);
    maxZ = Math.max(maxZ, v.z);
  });

  const guid = generateSafeGuid();
  const elemName = name || 'Face : 2D Planar Surface';
  const targetClass = ifcClass || 'IfcSlab';
  const area = calculateMeshArea(positions, indices) / 2.0;

  return {
    guid,
    name: elemName,
    ifc_class: targetClass,
    vertices: positions,
    indices,
    color: '#94a3b8',
    cut_color: '#475569',
    opacity: 0.9,
    bbox: {
      min: [minX, minY, minZ - 0.05],
      max: [maxX, maxY, maxZ + 0.05],
    },
    params: {
      name: elemName,
      ifc_class: targetClass,
      is2DPlanar: true,
      polygon3D: vertices.map((v) => [v.x, v.y, v.z]),
      planeNormal: [n.x, n.y, n.z],
      area,
    },
  };
}

export interface UniversalFaceHit {
  guid: string;
  kind: 'top' | 'side' | 'universal';
  param?: 'height' | 'thickness' | 'extrude';
  label: string;
  normal: [number, number, number];
  hitPoint: [number, number, number];
  currentValue: number;
  is2DPlanar?: boolean;
  boundaryVertices?: [number, number, number][];
  coplanarVertexIndices?: number[];
}

/**
 * Detects whether an intersection with ANY 3D mesh (drawn face, slab, roof, custom solid, box, column)
 * corresponds to an extrudable planar face.
 */
export function detectUniversalFaceHover(
  hit: { object: any; point: THREE.Vector3; face?: any | null },
  meshes: MeshBufferData[],
  elements: Record<string, any>
): UniversalFaceHit | null {
  if (!hit || !hit.face || !hit.object) return null;
  const guid = hit.object.userData?.guid;
  if (!guid) return null;

  const meshData = meshes.find((m) => m.guid === guid);
  const element = elements[guid];
  const name = meshData?.name || element?.name || 'Solid';

  // Compute world normal
  const normal = hit.face.normal.clone();
  if (hit.object.matrixWorld) {
    normal.transformDirection(hit.object.matrixWorld);
  }
  normal.normalize();

  const hitPoint: [number, number, number] = [hit.point.x, hit.point.y, hit.point.z];
  const normalArr: [number, number, number] = [normal.x, normal.y, normal.z];

  // 1. Check if it's a 2D planar face
  const is2DPlanar = Boolean(
    meshData?.params?.is2DPlanar ||
      (meshData?.vertices && meshData.vertices.length <= 120 && meshData?.params?.polygon3D)
  );

  if (is2DPlanar && meshData?.params?.polygon3D) {
    const boundaryVertices: [number, number, number][] = meshData.params.polygon3D;
    return {
      guid,
      kind: 'universal',
      param: 'extrude',
      label: `${name} (Extrude Face)`,
      normal: normalArr,
      hitPoint,
      currentValue: 0.0,
      is2DPlanar: true,
      boundaryVertices,
    };
  }

  // 2. Existing 3D solid or element: find all coplanar vertex indices
  const coplanarIndices: number[] = [];
  if (meshData && meshData.vertices) {
    const verts = meshData.vertices;
    const planeD = -normal.dot(hit.point);
    for (let i = 0; i < verts.length; i += 3) {
      const v = new THREE.Vector3(verts[i], verts[i + 1], verts[i + 2]);
      if (hit.object.matrixWorld) {
        v.applyMatrix4(hit.object.matrixWorld);
      }
      const dist = Math.abs(normal.dot(v) + planeD);
      if (dist < 0.05) {
        coplanarIndices.push(i / 3);
      }
    }
  }

  let faceDesc = 'Face';
  if (normal.z > 0.7) faceDesc = 'Top Face';
  else if (normal.z < -0.7) faceDesc = 'Bottom Face';
  else faceDesc = 'Side Face';

  return {
    guid,
    kind: 'universal',
    param: 'extrude',
    label: `${name} : ${faceDesc}`,
    normal: normalArr,
    hitPoint,
    currentValue: 0.0,
    is2DPlanar: false,
    coplanarVertexIndices: coplanarIndices,
  };
}

/**
 * Extrudes either a 2D planar face into a watertight 3D solid, or translates
 * coplanar vertices of an existing 3D solid along the face normal.
 */
export function extrudeFaceOrSolid(
  meshData: MeshBufferData,
  normal: [number, number, number],
  distance: number,
  boundaryOrCoplanar?: [number, number, number][] | number[]
): MeshBufferData {
  const normVec = new THREE.Vector3(...normal).normalize();
  const is2D = Boolean(meshData.params?.is2DPlanar);

  if (is2D) {
    // 2D planar face -> Extrude into 3D watertight solid
    let boundaryPts: THREE.Vector3[] = [];
    if (Array.isArray(boundaryOrCoplanar) && boundaryOrCoplanar.length > 0 && Array.isArray(boundaryOrCoplanar[0])) {
      boundaryPts = (boundaryOrCoplanar as [number, number, number][]).map((p) => new THREE.Vector3(...p));
    } else if (meshData.params?.polygon3D) {
      boundaryPts = (meshData.params.polygon3D as [number, number, number][]).map((p) => new THREE.Vector3(...p));
    } else {
      for (let i = 0; i < meshData.vertices.length; i += 3) {
        boundaryPts.push(new THREE.Vector3(meshData.vertices[i], meshData.vertices[i + 1], meshData.vertices[i + 2]));
      }
    }

    const extruded = extrudePlanarPolygon(boundaryPts, normVec, distance);
    const volume = calculateMeshVolume(extruded.positions, extruded.indices);
    const area = calculateMeshArea(extruded.positions, extruded.indices);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < extruded.positions.length; i += 3) {
      minX = Math.min(minX, extruded.positions[i]);
      minY = Math.min(minY, extruded.positions[i + 1]);
      minZ = Math.min(minZ, extruded.positions[i + 2]);
      maxX = Math.max(maxX, extruded.positions[i]);
      maxY = Math.max(maxY, extruded.positions[i + 1]);
      maxZ = Math.max(maxZ, extruded.positions[i + 2]);
    }

    return {
      ...meshData,
      name: meshData.name.replace('2D Face', '3D Solid').replace('2D Planar Surface', '3D Solid'),
      vertices: Array.from(extruded.positions),
      indices: Array.from(extruded.indices),
      color: '#0284c7', // Slate/sky solid
      opacity: 1.0,
      bbox: {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
      },
      params: {
        ...meshData.params,
        is2DPlanar: false,
        height: Math.abs(distance),
        volume,
        area,
      },
    };
  }

  // Existing 3D solid: translate coplanar vertices along normal
  const newVerts = [...meshData.vertices];
  const offset = normVec.clone().multiplyScalar(distance);
  const coplanarIndices =
    Array.isArray(boundaryOrCoplanar) && typeof boundaryOrCoplanar[0] === 'number'
      ? (boundaryOrCoplanar as number[])
      : [];

  if (coplanarIndices.length > 0) {
    const movedSet = new Set(coplanarIndices);
    for (const vIdx of movedSet) {
      newVerts[vIdx * 3] += offset.x;
      newVerts[vIdx * 3 + 1] += offset.y;
      newVerts[vIdx * 3 + 2] += offset.z;
    }
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < newVerts.length; i += 3) {
    minX = Math.min(minX, newVerts[i]);
    minY = Math.min(minY, newVerts[i + 1]);
    minZ = Math.min(minZ, newVerts[i + 2]);
    maxX = Math.max(maxX, newVerts[i]);
    maxY = Math.max(maxY, newVerts[i + 1]);
    maxZ = Math.max(maxZ, newVerts[i + 2]);
  }

  const volume = calculateMeshVolume(newVerts, meshData.indices);
  const area = calculateMeshArea(newVerts, meshData.indices);

  return {
    ...meshData,
    vertices: newVerts,
    bbox: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    },
    params: {
      ...meshData.params,
      volume,
      area,
    },
  };
}


