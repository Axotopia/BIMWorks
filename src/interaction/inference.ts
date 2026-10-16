/**
 * inference.ts — Direct Manipulation Inference & Guide Engine (Track B Phase 5)
 *
 * Implements IngeTrazo's core/inference.py architecture for BIMWorks:
 * 1. Reference Edge tracking (hovered wall/grid baseline).
 * 2. Axis locks (Shift ortho, explicit X/Y lock).
 * 3. Reference lock (locked parallel or collinear to a picked edge).
 * 4. Dwell timer & encouraged points pool:
 *    - Pausing the cursor on an endpoint/midpoint (>300ms) "encourages" that point,
 *      allowing inference rays (ortho / aligned) to cast from it.
 * 5. Dynamic guide lines generation (parallel, perpendicular, extensions).
 * 6. Named Point Rule:
 *    A snap provider never overrides a named point (endpoint, intersection, midpoint, origin).
 */

import { SnapCandidate, SnapSegment, SnapOptions, findSnapCandidate, distToSegment } from './snapEngine';

export interface InferenceGuideLine {
  id: string;
  p1: [number, number];
  p2: [number, number];
  kind: 'axis_x' | 'axis_y' | 'parallel' | 'perpendicular' | 'extension' | 'reference';
  label?: string;
  color?: string;
}

export interface EncouragedPoint {
  point: [number, number];
  timestamp: number;
  guid?: string;
}

export interface InferenceState {
  referenceEdge: SnapSegment | null;
  referenceLock: SnapSegment | null;
  axisLock: { axis: 'x' | 'y'; origin: [number, number] } | null;
  encouragedPoints: EncouragedPoint[];
  dwellOrigin: [number, number] | null;
  dwellStartTime: number;
}

export const DWELL_THRESHOLD_MS = 300;
export const DWELL_TOLERANCE_MODEL = 0.5; // feet

export function createInitialInferenceState(): InferenceState {
  return {
    referenceEdge: null,
    referenceLock: null,
    axisLock: null,
    encouragedPoints: [],
    dwellOrigin: null,
    dwellStartTime: 0,
  };
}

/**
 * Updates the inference state when cursor moves or dwells.
 */
export function updateInferenceDwell(
  state: InferenceState,
  cursor: [number, number],
  now: number,
  candidatePoint?: [number, number] | null,
  candidateGuid?: string
): InferenceState {
  let { dwellOrigin, dwellStartTime, encouragedPoints } = state;

  if (!dwellOrigin) {
    return {
      ...state,
      dwellOrigin: cursor,
      dwellStartTime: now,
    };
  }

  const dist = Math.hypot(cursor[0] - dwellOrigin[0], cursor[1] - dwellOrigin[1]);
  if (dist > DWELL_TOLERANCE_MODEL) {
    // Moved beyond dwell tolerance -> reset dwell timer
    return {
      ...state,
      dwellOrigin: cursor,
      dwellStartTime: now,
    };
  }

  // If hovered for >= DWELL_THRESHOLD_MS and near a candidate point, encourage it
  if (now - dwellStartTime >= DWELL_THRESHOLD_MS && candidatePoint) {
    const alreadyEncouraged = encouragedPoints.some(
      (ep) => Math.hypot(ep.point[0] - candidatePoint[0], ep.point[1] - candidatePoint[1]) < 0.1
    );
    if (!alreadyEncouraged) {
      encouragedPoints = [
        ...encouragedPoints.slice(-4), // keep up to 5 encouraged points
        { point: candidatePoint, timestamp: now, guid: candidateGuid },
      ];
    }
  }

  return {
    ...state,
    dwellOrigin,
    dwellStartTime,
    encouragedPoints,
  };
}

export interface InferenceResult {
  snap: SnapCandidate | null;
  guideLines: InferenceGuideLine[];
  cursorLabel: string | null;
}

/**
 * Computes inference, guide lines, and resolved snap candidate with documented priority:
 * Named point (endpoint/intersection/midpoint) > Reference Lock > Axis Lock > Parallel/Perp > Grid.
 */
export function computeInference(
  cursor: [number, number],
  activePoint: [number, number] | null,
  options: SnapOptions,
  state: InferenceState
): InferenceResult {
  const guideLines: InferenceGuideLine[] = [];

  // Pass active locks from inference state into snap options if not already explicitly set
  const mergedOptions: SnapOptions = {
    ...options,
    activePoint,
    axisLock: options.axisLock || state.axisLock || undefined,
    referenceLock: options.referenceLock || state.referenceLock || undefined,
  };

  // 1. Resolve snap through SnapEngine
  const snap = findSnapCandidate(cursor, mergedOptions);

  // 2. Generate Guide Lines based on active snap / inference state
  if (snap) {
    if (snap.kind === 'endpoint' || snap.kind === 'midpoint' || snap.kind === 'intersection') {
      // Named point reached
    } else if (snap.kind === 'axis_lock') {
      if (mergedOptions.axisLock) {
        const { axis, origin } = mergedOptions.axisLock;
        if (axis === 'x') {
          guideLines.push({
            id: 'guide-axis-x',
            p1: [origin[0] - 100, origin[1]],
            p2: [origin[0] + 100, origin[1]],
            kind: 'axis_x',
            label: 'Axis Lock X',
          });
        } else {
          guideLines.push({
            id: 'guide-axis-y',
            p1: [origin[0], origin[1] - 100],
            p2: [origin[0], origin[1] + 100],
            kind: 'axis_y',
            label: 'Axis Lock Y',
          });
        }
      }
    } else if (snap.kind === 'reference_lock' && mergedOptions.referenceLock) {
      const ref = mergedOptions.referenceLock;
      const dx = ref.p2[0] - ref.p1[0];
      const dy = ref.p2[1] - ref.p1[1];
      guideLines.push({
        id: 'guide-ref-lock',
        p1: [ref.p1[0] - dx * 2, ref.p1[1] - dy * 2],
        p2: [ref.p2[0] + dx * 2, ref.p2[1] + dy * 2],
        kind: 'reference',
        label: 'Reference Lock',
      });
    } else if (snap.kind === 'perpendicular' && activePoint) {
      guideLines.push({
        id: 'guide-perp',
        p1: activePoint,
        p2: snap.point,
        kind: 'perpendicular',
        label: snap.description,
      });
    } else if (snap.kind === 'extension' && snap.sources[0]) {
      const seg = options.segments.find((s) => s.guid === snap.sources[0]);
      if (seg) {
        guideLines.push({
          id: `guide-ext-${seg.guid}`,
          p1: seg.p1,
          p2: snap.point,
          kind: 'extension',
          label: 'Extension',
        });
      }
    }
  }

  // 3. Parallel inference to hovered reference edge if activePoint is set
  if (activePoint && state.referenceEdge) {
    const rx = state.referenceEdge.p2[0] - state.referenceEdge.p1[0];
    const ry = state.referenceEdge.p2[1] - state.referenceEdge.p1[1];
    const rLen = Math.hypot(rx, ry);
    if (rLen > 0.001) {
      const ux = rx / rLen;
      const uy = ry / rLen;
      // Current vector from active point
      const vx = cursor[0] - activePoint[0];
      const vy = cursor[1] - activePoint[1];
      const projLen = vx * ux + vy * uy;
      const perpDist = Math.abs(vx * -uy + vy * ux);

      const tol = (options.pixelTolerance ?? 14) / Math.max(1, options.scale);
      if (perpDist <= tol && Math.hypot(vx, vy) > tol) {
        // Parallel snap candidate
        const parallelPoint: [number, number] = [
          Number((activePoint[0] + projLen * ux).toFixed(4)),
          Number((activePoint[1] + projLen * uy).toFixed(4)),
        ];

        // Only override if current snap is not a named point
        const isNamed = snap && (snap.kind === 'endpoint' || snap.kind === 'intersection' || snap.kind === 'midpoint');
        if (!isNamed) {
          guideLines.push({
            id: 'guide-parallel',
            p1: activePoint,
            p2: parallelPoint,
            kind: 'parallel',
            label: 'Parallel to Reference',
          });
          return {
            snap: {
              point: parallelPoint,
              kind: 'aligned',
              description: 'Parallel to Reference',
              distance: perpDist,
              sources: state.referenceEdge.guid ? [state.referenceEdge.guid] : [],
              sourceGuid: state.referenceEdge.guid,
            },
            guideLines,
            cursorLabel: 'Parallel (Reference)',
          };
        }
      }
    }
  }

  // 4. Cursor tooltip label
  const cursorLabel = snap ? snap.description : null;

  return {
    snap,
    guideLines,
    cursorLabel,
  };
}
