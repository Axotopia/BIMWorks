/**
 * fitExtents.ts — the pure "zoom to fit" computation behind Track A5.
 *
 * Extracted from `PlanViewport2D.fit2DToExtents` so the transform is a plain
 * function of (paths, container size) and can be exercised by a gate against the
 * shipped code rather than against a re-implementation. The viewport keeps only
 * the React wiring: read the container size, call this, set scale/pan.
 *
 * Behaviour is intentionally identical to the previous inline version:
 *   - no paths            -> the caller applies EMPTY_FIT (350/320 at scale 40)
 *   - bounds not derivable -> bbox is null and the caller leaves the transform alone
 *   - otherwise            -> content occupies 78% of the tighter axis, centred
 */

export interface FitBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface FitTransform {
  scale: number;
  pan: { x: number; y: number };
  /** null when the paths carry no usable M/L coordinates. */
  bbox: FitBBox | null;
}

/** Fraction of the container the fitted content is asked to occupy. */
export const FIT_FRACTION = 0.78;
export const MIN_FIT_SCALE = 10;
export const MAX_FIT_SCALE = 150;

/** What the viewport applies when there is nothing to fit. */
export const EMPTY_FIT = { scale: 40, pan: { x: 350, y: 320 } } as const;

/** SVG coordinates out of an `M x y` / `L x y` path string. */
const COORD_RE = /([ML])\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;

/** Every path the plan view is willing to fit, in the original order. */
export function collectFitPaths(sliced2D: any): Array<{ d?: string }> {
  if (!sliced2D) return [];
  return [
    ...(sliced2D.cut_paths || []),
    ...(sliced2D.projection_paths || []),
    ...(sliced2D.roofs || []),
    ...(sliced2D.slabs || []),
    ...(sliced2D.levels || []),
  ];
}

/** Bounding box of every M/L coordinate in the path set, or null if there is none. */
export function extractFitBounds(paths: Array<{ d?: string }>): FitBBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  paths.forEach((p) => {
    if (!p || !p.d) return;
    const matches = p.d.matchAll(COORD_RE);
    for (const m of matches) {
      const x = parseFloat(m[2]);
      const y = parseFloat(m[3]);
      if (!isNaN(x) && !isNaN(y)) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  });

  // Same guard as before: a degenerate or single-point extent is not fitted.
  if (minX === Infinity || !(maxX > minX) || !(maxY > minY)) return null;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    minX,
    minY,
    maxX,
    maxY,
    cx,
    cy,
    w: Math.max(maxX - minX, 1),
    h: Math.max(maxY - minY, 1),
  };
}

/**
 * The scale/pan that fits `paths` into a `containerW x containerH` viewport.
 *
 * Note the `+ cy * scale` on the y pan: SVG y grows downward while model y grows
 * upward, so the sign differs from the x term. The label/pan convention is pinned
 * by check-fit-extents.mjs.
 */
export function computeFitTransform(
  paths: Array<{ d?: string }>,
  containerW = 800,
  containerH = 600
): FitTransform {
  const bbox = extractFitBounds(paths);
  if (!bbox) return { scale: 1, pan: { x: 0, y: 0 }, bbox: null };

  const fitScale = Math.min(
    (containerW * FIT_FRACTION) / bbox.w,
    (containerH * FIT_FRACTION) / bbox.h
  );
  const scale = Math.max(MIN_FIT_SCALE, Math.min(MAX_FIT_SCALE, fitScale));
  return {
    scale,
    pan: {
      x: containerW / 2 - bbox.cx * scale,
      y: containerH / 2 + bbox.cy * scale,
    },
    bbox,
  };
}
