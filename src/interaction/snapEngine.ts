/**
 * snapEngine.ts — Revit-feel typed snap candidate resolution & selection geometry.
 *
 * Provides:
 * 1. Typed snap candidate resolution:
 *    - 'intersection' (Cross ✕)
 *    - 'endpoint' (Square □)
 *    - 'midpoint' (Triangle △)
 *    - 'perpendicular' (Right-angle ⦜)
 *    - 'extension' (Collinear Extension ⤏)
 *    - 'grid' (Diamond ◇)
 * 2. Window vs Crossing selection box containment helpers.
 */

export type SnapKind =
  | 'axis_lock'
  | 'reference_lock'
  | 'close'
  | 'endpoint'
  | 'intersection'
  | 'midpoint'
  | 'origin'
  | 'on_edge'
  | 'aligned'
  | 'perpendicular'
  | 'extension'
  | 'grid';

export interface SnapCandidate {
  point: [number, number];
  kind: SnapKind;
  description: string;
  distance: number;
  sources: string[];
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
  axisLock?: { axis: 'x' | 'y'; origin: [number, number] };
  referenceLock?: { p1: [number, number]; p2: [number, number]; guid?: string };
  closePoint?: [number, number] | null;
  enableOriginSnap?: boolean;
  enableOnEdgeSnap?: boolean;
  enableAlignedSnap?: boolean;
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
 * 5. Extension
 * 6. Grid
 */
export function findSnapCandidate(
  cursor: [number, number],
  options: SnapOptions
): SnapCandidate | null {
  const pixelTol = options.pixelTolerance ?? 14;
  const tol = pixelTol / Math.max(1, options.scale);
  const [mx, my] = cursor;

  // 0. Close loop (snapping back to starting point of chain)
  if (options.closePoint) {
    const dClose = Math.hypot(options.closePoint[0] - mx, options.closePoint[1] - my);
    if (dClose <= tol) {
      return {
        point: [options.closePoint[0], options.closePoint[1]],
        kind: 'close',
        description: 'Close Loop',
        distance: dClose,
        sources: [],
      };
    }
  }

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
          const srcs = [s1.guid, s2.guid].filter((g): g is string => typeof g === 'string' && g.length > 0);
          bestIntersection = {
            point: hit,
            kind: 'intersection',
            description: 'Intersection',
            distance: d,
            sources: srcs,
            sourceGuid: srcs[0],
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
        sources: guid ? [guid] : [],
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
        sources: s.guid ? [s.guid] : [],
        sourceGuid: s.guid,
      };
    }
  }
  if (bestMidpoint) return bestMidpoint;

  // 4a. Axis Lock (e.g. Shift constraint or explicit axis lock)
  if (options.axisLock) {
    const { axis, origin } = options.axisLock;
    const pt: [number, number] = axis === 'x' ? [mx, origin[1]] : [origin[0], my];
    const d = axis === 'x' ? Math.abs(my - origin[1]) : Math.abs(mx - origin[0]);
    return {
      point: pt,
      kind: 'axis_lock',
      description: `Axis Lock (${axis.toUpperCase()})`,
      distance: d,
      sources: [],
    };
  }

  // 4b. Reference Lock (locked to a specific reference edge)
  if (options.referenceLock) {
    const res = distToSegment([mx, my], options.referenceLock.p1, options.referenceLock.p2);
    return {
      point: [Number(res.projected[0].toFixed(4)), Number(res.projected[1].toFixed(4))],
      kind: 'reference_lock',
      description: 'Reference Lock',
      distance: res.distance,
      sources: options.referenceLock.guid ? [options.referenceLock.guid] : [],
      sourceGuid: options.referenceLock.guid,
    };
  }

  // 4c. Origin Snap: [0, 0]
  if (options.enableOriginSnap) {
    const dOrigin = Math.hypot(mx, my);
    if (dOrigin <= tol) {
      return {
        point: [0, 0],
        kind: 'origin',
        description: 'Origin (0, 0)',
        distance: dOrigin,
        sources: [],
      };
    }
  }

  // 4d. On-Edge Snap: along segment interior
  if (options.enableOnEdgeSnap) {
    let bestOnEdge: SnapCandidate | null = null;
    for (const s of nearbySegments) {
      const res = distToSegment([mx, my], s.p1, s.p2);
      if (res.t > 0.05 && res.t < 0.95 && res.distance <= tol) {
        if (!bestOnEdge || res.distance < bestOnEdge.distance) {
          bestOnEdge = {
            point: [Number(res.projected[0].toFixed(4)), Number(res.projected[1].toFixed(4))],
            kind: 'on_edge',
            description: 'Nearest (On Edge)',
            distance: res.distance,
            sources: s.guid ? [s.guid] : [],
            sourceGuid: s.guid,
          };
        }
      }
    }
    if (bestOnEdge) return bestOnEdge;
  }

  // 4e. Aligned Snap: tracking shared X or Y coordinate with any segment endpoint
  if (options.enableAlignedSnap && options.activePoint) {
    let bestAligned: SnapCandidate | null = null;
    for (const s of options.segments) {
      for (const pt of [s.p1, s.p2]) {
        if (Math.hypot(pt[0] - options.activePoint[0], pt[1] - options.activePoint[1]) < 1e-4) continue;
        const dX = Math.abs(mx - pt[0]);
        const dY = Math.abs(my - pt[1]);
        if (dX <= tol && (!bestAligned || dX < bestAligned.distance)) {
          bestAligned = {
            point: [pt[0], my],
            kind: 'aligned',
            description: `Aligned X (${pt[0].toFixed(2)}')`,
            distance: dX,
            sources: s.guid ? [s.guid] : [],
            sourceGuid: s.guid,
          };
        }
        if (dY <= tol && (!bestAligned || dY < bestAligned.distance)) {
          bestAligned = {
            point: [mx, pt[1]],
            kind: 'aligned',
            description: `Aligned Y (${pt[1].toFixed(2)}')`,
            distance: dY,
            sources: s.guid ? [s.guid] : [],
            sourceGuid: s.guid,
          };
        }
      }
    }
    if (bestAligned) return bestAligned;
  }

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
          sources: [],
        };
      } else {
        return {
          point: [ap[0], my],
          kind: 'perpendicular',
          description: 'Vertical (Ortho)',
          distance: dx,
          sources: [],
        };
      }
    }

    if (dy <= tol && dx >= tol) {
      return {
        point: [mx, ap[1]],
        kind: 'perpendicular',
        description: 'Horizontal',
        distance: dy,
        sources: [],
      };
    }
    if (dx <= tol && dy >= tol) {
      return {
        point: [ap[0], my],
        kind: 'perpendicular',
        description: 'Vertical',
        distance: dx,
        sources: [],
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
            sources: s.guid ? [s.guid] : [],
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
            sources: s.guid ? [s.guid] : [],
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
      sources: [],
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

/**
 * Projects a 3D point to 2D screen coordinates using a camera projection matrix and viewport dimensions.
 */
export function project3DToScreen(
  point: [number, number, number],
  viewProjectionMatrix: number[], // 16-element column-major matrix
  viewportWidth: number,
  viewportHeight: number
): [number, number] {
  const [x, y, z] = point;
  const m = viewProjectionMatrix;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const invW = Math.abs(w) > 1e-6 ? 1.0 / w : 1.0;
  const ndcX = (m[0] * x + m[4] * y + m[8] * z + m[12]) * invW;
  const ndcY = (m[1] * x + m[5] * y + m[9] * z + m[13]) * invW;
  const screenX = ((ndcX + 1.0) / 2.0) * viewportWidth;
  const screenY = ((-ndcY + 1.0) / 2.0) * viewportHeight;
  return [screenX, screenY];
}
