/**
 * 3D Measurement Engine with Orthogonal Triad Axis Constraints
 * Adopted from N:\lapin\apps\viewer\src\components\viewer\measureHandlers.ts
 *
 * Provides:
 * - Snap-to-geometry distance measuring
 * - Shift-key orthogonal triad axis locking (X, Y, Z)
 * - Live direct distance and component deltas (ΔX, ΔY, ΔZ)
 */

import * as THREE from 'three';

export type TriadAxis = 'x' | 'y' | 'z';

export interface TriadProjectionResult {
  projectedPoint: [number, number, number];
  activeAxis: TriadAxis;
}

export interface Measurement3DState {
  start: [number, number, number];
  current: [number, number, number];
  isOrthogonalLocked: boolean;
  activeAxis: TriadAxis | null;
  directDistance: number;
  deltaX: number;
  deltaY: number;
  deltaZ: number;
}

/**
 * Projects current 3D world coordinate onto the closest orthogonal world axis relative to start point.
 * Matches projectOntoConstraintAxis from Lapin.
 */
export function projectOntoWorldTriadAxis(
  start: [number, number, number],
  current: [number, number, number]
): TriadProjectionResult {
  const dx = current[0] - start[0];
  const dy = current[1] - start[1];
  const dz = current[2] - start[2];

  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const absZ = Math.abs(dz);

  if (absX >= absY && absX >= absZ) {
    return {
      projectedPoint: [start[0] + dx, start[1], start[2]],
      activeAxis: 'x',
    };
  } else if (absY >= absZ) {
    return {
      projectedPoint: [start[0], start[1] + dy, start[2]],
      activeAxis: 'y',
    };
  } else {
    return {
      projectedPoint: [start[0], start[1], start[2] + dz],
      activeAxis: 'z',
    };
  }
}

/**
 * Computes full 3D measurement metrics from start and current pointer world coordinates.
 */
export function compute3DMeasurement(
  start: [number, number, number],
  current: [number, number, number],
  shiftHeld: boolean
): Measurement3DState {
  let targetPoint = current;
  let activeAxis: TriadAxis | null = null;

  if (shiftHeld) {
    const proj = projectOntoWorldTriadAxis(start, current);
    targetPoint = proj.projectedPoint;
    activeAxis = proj.activeAxis;
  }

  const dx = targetPoint[0] - start[0];
  const dy = targetPoint[1] - start[1];
  const dz = targetPoint[2] - start[2];
  const directDistance = Math.hypot(dx, dy, dz);

  return {
    start,
    current: targetPoint,
    isOrthogonalLocked: shiftHeld,
    activeAxis,
    directDistance,
    deltaX: dx,
    deltaY: dy,
    deltaZ: dz,
  };
}
