/**
 * BIMWorks - Mesh measurement helpers
 *
 * Properties such as Area and Volume must be measured, never invented. The
 * engine sends a triangulated surface (flat vertex/index buffers, Z-up, metres),
 * so both are computed analytically from that surface rather than read from a
 * constant. Values are returned in decimal feet (ft², ft³) to match the
 * application's internal unit convention.
 *
 * Known limitation: the volume is a closed-surface (divergence theorem)
 * measure, so it is exact for the watertight extrusions the engine emits
 * (walls, slabs, roofs, door/window panels) but approximate for open shells.
 * Callers should surface that caveat rather than present it as authoritative.
 */

import { MeshBufferData } from '../types/bim';
import { METERS_TO_FEET } from './units';

export interface MeshMeasure {
  /** Surface area in square feet. */
  areaFt2: number;
  /** Enclosed volume in cubic feet (divergence theorem). */
  volumeFt3: number;
}

/**
 * Measures a triangulated mesh. Returns null when the buffer is unusable so the
 * caller can display an explicit placeholder instead of a wrong number.
 */
export function measureMesh(mesh: Pick<MeshBufferData, 'vertices' | 'indices'>): MeshMeasure | null {
  const { vertices, indices } = mesh;
  if (!vertices || !indices || vertices.length < 9 || indices.length < 3) return null;

  let area = 0;
  let signedVolume = 0;

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    if (b + 2 >= vertices.length || c + 2 >= vertices.length) continue;

    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
    const cx = vertices[c], cy = vertices[c + 1], cz = vertices[c + 2];

    // Cross product of edge vectors -> twice the triangle area.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    area += 0.5 * Math.hypot(nx, ny, nz);

    // Signed volume of the tetrahedron (origin, a, b, c).
    signedVolume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }

  if (!isFinite(area) || !isFinite(signedVolume)) return null;

  const scale2 = METERS_TO_FEET * METERS_TO_FEET;
  return {
    areaFt2: area * scale2,
    volumeFt3: Math.abs(signedVolume) * scale2 * METERS_TO_FEET,
  };
}
