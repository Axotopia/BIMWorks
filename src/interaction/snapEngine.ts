/**
 * snapEngine.ts — Revit-feel typed snap candidate resolution & selection geometry.
 *
 * Provides:
 * 1. Typed snap candidate resolution:
 *    - 'intersection' (Cross ✕)
 *    - 'endpoint' (Square □)
 *    - 'midpoint' (Triangle △)
 *    - 'perpendicular' (Right-angle ⦜)
 *    - 'grid' (Diamond ◇)
 * 2. Window vs Crossing selection box containment helpers.
 */

export type SnapKind = 'intersection' | 'endpoint' | 'midpoint' | 'perpendicular' | 'extension' | 'grid';

export interface SnapCandidate {
  point: [number, number];
  kind: SnapKind;
  description: string;
  distance: number;
  sourceGuid?: string;
}

export interface SnapSegment {
  p1: [number, number];
  p2: [number, number];
  guid?: string;
}

export interface SnapOptions {
  scale: number; // pixels per foot
  pixelTolerance?: number; // default 14px
  activePoint?: [number, number] | null; // e.g. first point of wall or sketch
  segments: SnapSegment[];
  points?: Array<{ point: [number, number]; guid?: string }>;
  enableGridSnap?: boolean;
  gridSize?: number; // default 0.25 ft (3 inches)
  forceOrtho?: boolean; // Shift key held
}

/** Intersection of two 2D line segments, or null if parallel / outside segments */
export function segmentIntersection(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
  extend = false
): [number, number] | null {
  const d1x = p2[0] - p1[0];
  const d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0];
  const d2y = p4[1] - p3[1];
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-6) return null;

  const dx = p3[0] - p1[0];
  const dy = p3[1] - p1[1];
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;

  if (!extend) {
    if (t < -0.01 || t > 1.01 || u < -0.01 || u > 1.01) return null;
  }
  return [p1[0] + t * d1x, p1[1] + t * d1y];
}

/** Distance from point to line segment */
export function distToSegment(
  p: [number, number],
  p1: [number, number],
  p2: [number, number]
): { distance: number; projected: [number, number]; t: number } {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) {
    return {
      distance: Math.hypot(p[0] - p1[0], p[1] - p1[1]),
      projected: p1,
      t: 0,
    };
  }
  const t = Math.max(0, Math.min(1, ((p[0] - p1[0]) * dx + (p[1] - p1[1]) * dy) / lenSq));
  const proj: [number, number] = [p1[0] + t * dx, p1[1] + t * dy];
  return {
    distance: Math.hypot(p[0] - proj[0], p[1] - proj[1]),
    projected: proj,
    t,
  };
}

/**
 * Finds the highest-priority typed snap candidate near cursor (mx, my) in model coordinates.
 * Priority hierarchy:
 * 1. Intersection
 * 2. Endpoint
 * 3. Midpoint
 * 4. Perpendicular / Orthogonal
 * 5. Grid
 */
export function findSnapCandidate(
  cursor: [number, number],
  options: SnapOptions
): SnapCandidate | null {
  const pixelTol = options.pixelTolerance ?? 14;
  const tol = pixelTol / Math.max(1, options.scale);
  const [mx, my] = cursor;

  // 1. Intersections between segments within search radius
  const nearbySegments = options.segments.filter(
    (s) =>
      Math.min(s.p1[0], s.p2[0]) - tol <= mx &&
      Math.max(s.p1[0], s.p2[0]) + tol >= mx &&
      Math.min(s.p1[1], s.p2[1]) - tol <= my &&
      Math.max(s.p1[1], s.p2[1]) + tol >= my
  );

  let bestIntersection: SnapCandidate | null = null;
  for (let i = 0; i < nearbySegments.length; i++) {
    for (let j = i + 1; j < nearbySegments.length; j++) {
      const s1 = nearbySegments[i];
      const s2 = nearbySegments[j];
      const hit = segmentIntersection(s1.p1, s1.p2, s2.p1, s2.p2, false);
      if (hit) {
        const d = Math.hypot(hit[0] - mx, hit[1] - my);
        if (d <= tol && (!bestIntersection || d < bestIntersection.distance)) {
          bestIntersection = {
            point: hit,
            kind: 'intersection',
            description: 'Intersection',
            distance: d,
            sourceGuid: s1.guid || s2.guid,
          };
        }
      }
    }
  }
  if (bestIntersection) return bestIntersection;

  // 2. Endpoints
  let bestEndpoint: SnapCandidate | null = null;
  const checkEndpoint = (pt: [number, number], guid?: string) => {
    const d = Math.hypot(pt[0] - mx, pt[1] - my);
    if (d <= tol && (!bestEndpoint || d < bestEndpoint.distance)) {
      bestEndpoint = {
        point: [pt[0], pt[1]],
        kind: 'endpoint',
        description: 'Endpoint',
        distance: d,
        sourceGuid: guid,
      };
    }
  };

  for (const s of nearbySegments) {
    checkEndpoint(s.p1, s.guid);
    checkEndpoint(s.p2, s.guid);
  }
  if (options.points) {
    for (const p of options.points) {
      checkEndpoint(p.point, p.guid);
    }
  }
  if (bestEndpoint) return bestEndpoint;

  // 3. Midpoints
  let bestMidpoint: SnapCandidate | null = null;
  for (const s of nearbySegments) {
    const mid: [number, number] = [(s.p1[0] + s.p2[0]) / 2, (s.p1[1] + s.p2[1]) / 2];
    const d = Math.hypot(mid[0] - mx, mid[1] - my);
    if (d <= tol && (!bestMidpoint || d < bestMidpoint.distance)) {
      bestMidpoint = {
        point: mid,
        kind: 'midpoint',
        description: 'Midpoint',
        distance: d,
        sourceGuid: s.guid,
      };
    }
  }
  if (bestMidpoint) return bestMidpoint;

  // 4. Perpendicular / Orthogonal
  if (options.activePoint) {
    const ap = options.activePoint;
    const dx = Math.abs(mx - ap[0]);
    const dy = Math.abs(my - ap[1]);

    // Force ortho if Shift is held, or if within snap tolerance
    if (options.forceOrtho) {
      if (dx > dy) {
        return {
          point: [mx, ap[1]],
          kind: 'perpendicular',
          description: 'Horizontal (Ortho)',
          distance: dy,
        };
      } else {
        return {
          point: [ap[0], my],
          kind: 'perpendicular',
          description: 'Vertical (Ortho)',
          distance: dx,
        };
      }
    }

    if (dy <= tol && dx >= tol) {
      return {
        point: [mx, ap[1]],
        kind: 'perpendicular',
        description: 'Horizontal',
        distance: dy,
      };
    }
    if (dx <= tol && dy >= tol) {
      return {
        point: [ap[0], my],
        kind: 'perpendicular',
        description: 'Vertical',
        distance: dx,
      };
    }

    // Perpendicular to a nearby segment from activePoint
    for (const s of nearbySegments) {
      const sx = s.p2[0] - s.p1[0];
      const sy = s.p2[1] - s.p1[1];
      const sLenSq = sx * sx + sy * sy;
      if (sLenSq > 1e-4) {
        // Normal vector to segment
        const sLen = Math.sqrt(sLenSq);
        const nx = -sy / sLen;
        const ny = sx / sLen;
        // Project vector (mx - ap[0], my - ap[1]) onto normal
        const vx = mx - ap[0];
        const vy = my - ap[1];
        const projLen = vx * nx + vy * ny;
        const perpPoint: [number, number] = [ap[0] + projLen * nx, ap[1] + projLen * ny];
        const d = Math.hypot(mx - perpPoint[0], my - perpPoint[1]);
        if (d <= tol) {
          return {
            point: perpPoint,
            kind: 'perpendicular',
            description: 'Perpendicular',
            distance: d,
            sourceGuid: s.guid,
          };
        }
      }
    }
  }

  // 5. Extension Snap (collinear extension of segments beyond their endpoints)
  const extReach = Math.max(tol * 10, 20.0);
  const extSegments = options.segments.filter(
    (s) =>
      Math.min(s.p1[0], s.p2[0]) - extReach <= mx &&
      Math.max(s.p1[0], s.p2[0]) + extReach >= mx &&
      Math.min(s.p1[1], s.p2[1]) - extReach <= my &&
      Math.max(s.p1[1], s.p2[1]) + extReach >= my
  );
  let bestExtension: SnapCandidate | null = null;
  for (const s of extSegments) {
    const sx = s.p2[0] - s.p1[0];
    const sy = s.p2[1] - s.p1[1];
    const lenSq = sx * sx + sy * sy;
    if (lenSq > 1e-4) {
      const t = ((mx - s.p1[0]) * sx + (my - s.p1[1]) * sy) / lenSq;
      // Collinear extension: outside [0, 1] segment bounds but within reach
      if ((t < 0 && t >= -2.0) || (t > 1 && t <= 3.0)) {
        const proj: [number, number] = [s.p1[0] + t * sx, s.p1[1] + t * sy];
        const d = Math.hypot(mx - proj[0], my - proj[1]);
        if (d <= tol && (!bestExtension || d < bestExtension.distance)) {
          bestExtension = {
            point: [Number(proj[0].toFixed(4)), Number(proj[1].toFixed(4))],
            kind: 'extension',
            description: 'Extension',
            distance: d,
            sourceGuid: s.guid,
          };
        }
      }
    }
  }
  if (bestExtension) return bestExtension;

  // 6. Grid Snap
  if (options.enableGridSnap !== false) {
    const grid = options.gridSize ?? 0.25;
    const gx = Math.round(mx / grid) * grid;
    const gy = Math.round(my / grid) * grid;
    const gd = Math.hypot(mx - gx, my - gy);
    return {
      point: [Number(gx.toFixed(4)), Number(gy.toFixed(4))],
      kind: 'grid',
      description: grid >= 1.0 ? `Grid (${grid.toFixed(0)}')` : `Grid (${(grid * 12).toFixed(0)}")`,
      distance: gd,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Window vs. Crossing Selection Geometry
// ---------------------------------------------------------------------------

export interface BoundingBox2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Check if target bbox is strictly inside the selection box (Window selection) */
export function isBoxInside(target: BoundingBox2D, sel: BoundingBox2D): boolean {
  return (
    target.minX >= sel.minX &&
    target.maxX <= sel.maxX &&
    target.minY >= sel.minY &&
    target.maxY <= sel.maxY
  );
}

/** Check if target bbox intersects the selection box (Crossing selection) */
export function isBoxCrossing(target: BoundingBox2D, sel: BoundingBox2D): boolean {
  return !(
    target.maxX < sel.minX ||
    target.minX > sel.maxX ||
    target.maxY < sel.minY ||
    target.minY > sel.maxY
  );
}
