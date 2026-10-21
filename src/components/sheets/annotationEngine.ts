/**
 * Annotation & Drafting Geometry Engine
 *
 * Adopts N:/ifcsheet/apps/viewer/src/drafting/annotation.ts & drafting-view.ts:
 * - Dimension layout solver (linear/aligned with extension lines, ticks, and rotated text)
 * - Radial and angular dimension layout
 * - Spot elevation / Level mark layout
 * - Grid axis layout with bubbles
 * - Drafts extent & viewport framing calculation
 * - Built-in architectural symbols (North arrow, scale bar, batting, center line)
 * - Universal SVG renderer for any EntityShape
 */

import {
  Pt,
  DraftShape,
  AnnotationShape,
  EntityShape,
  DraftEntity,
  AxisShape,
} from '../../types/bim';

export interface DimensionLayout {
  lines: { a: Pt; b: Pt }[];
  ticks: { at: Pt; dir: Pt }[];
  textAt: Pt;
  textAngle: number;
  label: string;
}

export interface LayoutOptions {
  extGap?: number;
  extOver?: number;
  tickSize?: number;
  format?: (val: number) => string;
}

const EXT_GAP = 0.15;   // Gap between element and extension line start
const EXT_OVER = 0.25;  // Overshoot past dimension line
const TICK_SIZE = 0.2;  // Architectural tick length

function unit(v: Pt): Pt {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-12 ? { x: v.x / l, y: v.y / l } : { x: 1, y: 0 };
}

function sub(p1: Pt, p2: Pt): Pt {
  return { x: p1.x - p2.x, y: p1.y - p2.y };
}

function add(p1: Pt, p2: Pt): Pt {
  return { x: p1.x + p2.x, y: p1.y + p2.y };
}

function scalePt(p: Pt, s: number): Pt {
  return { x: p.x * s, y: p.y * s };
}

function dist(p1: Pt, p2: Pt): number {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

export function formatLengthDefault(val: number): string {
  return `${val.toFixed(2)}`;
}

export function formatElevationDefault(m: number): string {
  if (Math.abs(m) < 0.005) return '±0.00';
  return `${m > 0 ? '+' : ''}${m.toFixed(2)}`;
}

/**
 * Solves linear or aligned dimension extension lines, dimension line, and tick points.
 * Matches N:/ifcsheet linearLayout().
 */
export function dimensionLayout(
  shape: Extract<AnnotationShape, { type: 'dimension' | 'radial' | 'angular' }>,
  options: LayoutOptions = {}
): DimensionLayout {
  const gap = options.extGap ?? EXT_GAP;
  const over = options.extOver ?? EXT_OVER;
  const format = options.format ?? formatLengthDefault;

  if (shape.type === 'dimension') {
    const { a, b, at, variant, text, textAt } = shape;
    let dir: Pt;

    if (variant === 'aligned') {
      dir = unit(sub(b, a));
    } else {
      // Linear: determine horizontal vs vertical orientation from offset
      const mid = scalePt(add(a, b), 0.5);
      dir = Math.abs(at.y - mid.y) >= Math.abs(at.x - mid.x) ? { x: 1, y: 0 } : { x: 0, y: 1 };
    }

    const n: Pt = { x: -dir.y, y: dir.x };
    const offA = (at.x - a.x) * n.x + (at.y - a.y) * n.y;
    const offB = (at.x - b.x) * n.x + (at.y - b.y) * n.y;

    const pa = add(a, scalePt(n, offA));
    const pb = add(b, scalePt(n, offB));

    const extA = {
      a: add(a, scalePt(n, Math.sign(offA || 1) * Math.min(gap, Math.abs(offA)))),
      b: add(pa, scalePt(n, Math.sign(offA || 1) * over)),
    };
    const extB = {
      a: add(b, scalePt(n, Math.sign(offB || 1) * Math.min(gap, Math.abs(offB)))),
      b: add(pb, scalePt(n, Math.sign(offB || 1) * over)),
    };

    const value = Math.abs((b.x - a.x) * dir.x + (b.y - a.y) * dir.y);
    const along = unit(sub(pb, pa));

    return {
      lines: [extA, extB, { a: pa, b: pb }],
      ticks: [
        { at: pa, dir: scalePt(along, -1) },
        { at: pb, dir: along },
      ],
      textAt: textAt ?? scalePt(add(pa, pb), 0.5),
      textAngle: Math.atan2(along.y, along.x),
      label: text ?? format(value),
    };
  }

  if (shape.type === 'radial') {
    const dir = unit(sub(shape.at, shape.c));
    const rim = add(shape.c, scalePt(dir, shape.r));
    const from = shape.diameter ? add(shape.c, scalePt(dir, -shape.r)) : shape.c;
    const isOutside = dist(shape.at, shape.c) > shape.r;

    return {
      lines: [{ a: from, b: isOutside ? shape.at : rim }],
      ticks: shape.diameter
        ? [
            { at: rim, dir },
            { at: from, dir: scalePt(dir, -1) },
          ]
        : [{ at: rim, dir }],
      textAt: shape.at,
      textAngle: Math.atan2(dir.y, dir.x),
      label: `${shape.diameter ? 'Ø' : 'R'} ${format(shape.diameter ? shape.r * 2 : shape.r)}`,
    };
  }

  // Angular dimension
  const radius = Math.max(dist(shape.at, shape.c), 1e-4);
  const angA = Math.atan2(shape.a.y - shape.c.y, shape.a.x - shape.c.x);
  const angB = Math.atan2(shape.b.y - shape.c.y, shape.b.x - shape.c.x);
  const midAng = (angA + angB) / 2;
  const pMid = add(shape.c, scalePt({ x: Math.cos(midAng), y: Math.sin(midAng) }, radius));
  const deg = (Math.abs(angB - angA) * 180) / Math.PI;

  return {
    lines: [
      { a: shape.c, b: shape.a },
      { a: shape.c, b: shape.b },
      { a: shape.a, b: pMid },
      { a: pMid, b: shape.b },
    ],
    ticks: [{ at: shape.a, dir: unit(sub(shape.a, shape.c)) }, { at: shape.b, dir: unit(sub(shape.b, shape.c)) }],
    textAt: shape.at,
    textAngle: midAng,
    label: `${deg.toFixed(1)}°`,
  };
}

/**
 * Calculates bounding box of draft entities in drawing units.
 * Matches N:/ifcsheet draftsExtent().
 */
export function draftsExtent(drafts: readonly { shape: EntityShape }[]): {
  min: Pt;
  max: Pt;
} | null {
  if (drafts.length === 0) return null;
  const xs: number[] = [];
  const ys: number[] = [];

  for (const d of drafts) {
    const s = d.shape;
    if (s.type === 'line') {
      xs.push(s.a.x, s.b.x);
      ys.push(s.a.y, s.b.y);
    } else if (s.type === 'polyline') {
      s.pts.forEach((p) => {
        xs.push(p.x);
        ys.push(p.y);
      });
    } else if (s.type === 'circle') {
      xs.push(s.c.x - s.r, s.c.x + s.r);
      ys.push(s.c.y - s.r, s.c.y + s.r);
    } else if (s.type === 'arc') {
      xs.push(s.c.x - s.r, s.c.x + s.r);
      ys.push(s.c.y - s.r, s.c.y + s.r);
    } else if (s.type === 'dimension') {
      xs.push(s.a.x, s.b.x, s.at.x);
      ys.push(s.a.y, s.b.y, s.at.y);
    } else if (s.type === 'text') {
      xs.push(s.p.x);
      ys.push(s.p.y);
    } else if (s.type === 'leader') {
      s.pts.forEach((p) => {
        xs.push(p.x);
        ys.push(p.y);
      });
    } else if (s.type === 'level') {
      xs.push(s.p.x);
      ys.push(s.p.y);
    } else if (s.type === 'axis') {
      xs.push(s.a.x, s.b.x);
      ys.push(s.a.y, s.b.y);
    } else if (s.type === 'hatch') {
      s.loops.forEach((loop) =>
        loop.forEach((p) => {
          xs.push(p.x);
          ys.push(p.y);
        })
      );
    }
  }

  if (xs.length === 0) return null;
  return {
    min: { x: Math.min(...xs), y: Math.min(...ys) },
    max: { x: Math.max(...xs), y: Math.max(...ys) },
  };
}

/** Margin around drafts in a fitted viewport (paper mm) */
const FIT_MARGIN_MM = 15;

/**
 * Calculates viewport framing for a drafting view placed on a sheet at `scale`.
 * Matches N:/ifcsheet draftingFrame().
 */
export function draftingFrame(
  drafts: readonly { shape: EntityShape }[],
  scaleDenominator: number = 20
): { center: Pt | null; width: number; height: number } {
  const extent = draftsExtent(drafts);
  if (!extent) {
    return { center: null, width: 200, height: 150 };
  }
  const k = 1000 / scaleDenominator; // mm per model unit
  const spanX = Math.max(0.5, extent.max.x - extent.min.x);
  const spanY = Math.max(0.5, extent.max.y - extent.min.y);

  return {
    center: {
      x: (extent.min.x + extent.max.x) / 2,
      y: (extent.min.y + extent.max.y) / 2,
    },
    width: Math.max(80, Math.round(spanX * k + FIT_MARGIN_MM * 2)),
    height: Math.max(60, Math.round(spanY * k + FIT_MARGIN_MM * 2)),
  };
}

/**
 * Renders any EntityShape into clean SVG markup.
 */
export function renderEntityShapeToSvg(
  shape: EntityShape,
  options: {
    color?: string;
    strokeWidth?: number;
    fontSize?: number;
    scale?: number;
  } = {}
): string {
  const color = options.color ?? '#0f172a';
  const sw = options.strokeWidth ?? 0.05;
  const fSize = options.fontSize ?? 0.25;

  if (shape.type === 'line') {
    return `<line x1="${shape.a.x}" y1="${shape.a.y}" x2="${shape.b.x}" y2="${shape.b.y}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" />`;
  }

  if (shape.type === 'polyline') {
    const ptsStr = shape.pts.map((p) => `${p.x},${p.y}`).join(' ');
    if (shape.closed) {
      return `<polygon points="${ptsStr}" stroke="${color}" stroke-width="${sw}" fill="none" stroke-linejoin="round" />`;
    }
    return `<polyline points="${ptsStr}" stroke="${color}" stroke-width="${sw}" fill="none" stroke-linecap="round" stroke-linejoin="round" />`;
  }

  if (shape.type === 'circle') {
    return `<circle cx="${shape.c.x}" cy="${shape.c.y}" r="${shape.r}" stroke="${color}" stroke-width="${sw}" fill="none" />`;
  }

  if (shape.type === 'arc') {
    const x1 = shape.c.x + shape.r * Math.cos(shape.start);
    const y1 = shape.c.y + shape.r * Math.sin(shape.start);
    const x2 = shape.c.x + shape.r * Math.cos(shape.end);
    const y2 = shape.c.y + shape.r * Math.sin(shape.end);
    let sweep = shape.end - shape.start;
    while (sweep < 0) sweep += Math.PI * 2;
    const largeArc = sweep > Math.PI ? 1 : 0;
    const d = `M ${x1} ${y1} A ${shape.r} ${shape.r} 0 ${largeArc} 1 ${x2} ${y2}`;
    return `<path d="${d}" stroke="${color}" stroke-width="${sw}" fill="none" stroke-linecap="round" />`;
  }

  if (shape.type === 'dimension') {
    const layout = dimensionLayout(shape, {
      format: (val) => `${val.toFixed(2)}'`,
    });
    let svg = '<g class="draft-dimension">\n';
    layout.lines.forEach((l) => {
      svg += `  <line x1="${l.a.x}" y1="${l.a.y}" x2="${l.b.x}" y2="${l.b.y}" stroke="${color}" stroke-width="${sw * 0.8}" />\n`;
    });
    // Render 45-degree architectural tick marks
    layout.ticks.forEach((t) => {
      const tickL = TICK_SIZE;
      svg += `  <line x1="${t.at.x - tickL * 0.7}" y1="${t.at.y - tickL * 0.7}" x2="${t.at.x + tickL * 0.7}" y2="${t.at.y + tickL * 0.7}" stroke="${color}" stroke-width="${sw * 1.5}" stroke-linecap="round" />\n`;
    });
    // Text label
    const angleDeg = (layout.textAngle * 180) / Math.PI;
    const normalizedAngle = Math.abs(angleDeg) > 90 ? angleDeg + 180 : angleDeg;
    svg += `  <text x="${layout.textAt.x}" y="${layout.textAt.y}" font-family="Arial, sans-serif" font-size="${shape.height || fSize}" font-weight="bold" fill="${color}" text-anchor="middle" dominant-baseline="central" transform="rotate(${normalizedAngle.toFixed(1)} ${layout.textAt.x} ${layout.textAt.y})">${layout.label}</text>\n`;
    svg += '</g>';
    return svg;
  }

  if (shape.type === 'text') {
    const rot = ((shape.rotation || 0) * 180) / Math.PI;
    return `<text x="${shape.p.x}" y="${shape.p.y}" font-family="Arial, sans-serif" font-size="${shape.height || fSize}" fill="${color}" transform="rotate(${rot.toFixed(1)} ${shape.p.x} ${shape.p.y})">${shape.text}</text>`;
  }

  if (shape.type === 'leader') {
    if (shape.pts.length < 2) return '';
    const ptsStr = shape.pts.map((p) => `${p.x},${p.y}`).join(' ');
    const endPt = shape.pts[shape.pts.length - 1];
    return `
      <g class="draft-leader">
        <polyline points="${ptsStr}" stroke="${color}" stroke-width="${sw}" fill="none" stroke-linecap="round" />
        <circle cx="${shape.pts[0].x}" cy="${shape.pts[0].y}" r="${sw * 1.5}" fill="${color}" />
        <text x="${endPt.x + 0.1}" y="${endPt.y - 0.05}" font-family="Arial, sans-serif" font-size="${shape.height || fSize}" fill="${color}">${shape.text}</text>
      </g>
    `;
  }

  if (shape.type === 'level') {
    const valStr = formatElevationDefault(shape.value);
    return `
      <g class="draft-level-mark" transform="translate(${shape.p.x}, ${shape.p.y})">
        <polygon points="0,0 -0.25,-0.3 0.25,-0.3" fill="${color}" />
        <line x1="0" y1="0" x2="0" y2="0.3" stroke="${color}" stroke-width="${sw}" />
        <line x1="-0.8" y1="0.3" x2="0.8" y2="0.3" stroke="${color}" stroke-width="${sw}" />
        <text x="0" y="0.55" font-family="Arial, sans-serif" font-size="${shape.height || fSize}" font-weight="bold" fill="${color}" text-anchor="middle">${valStr}</text>
      </g>
    `;
  }

  if (shape.type === 'axis') {
    const r = shape.size / 2;
    let bubblesSvg = '';
    if (shape.ends === 'both' || shape.ends === 'start') {
      bubblesSvg += `
        <circle cx="${shape.a.x}" cy="${shape.a.y}" r="${r}" fill="#ffffff" stroke="${color}" stroke-width="${sw * 1.2}" />
        <text x="${shape.a.x}" y="${shape.a.y}" font-family="Arial, sans-serif" font-size="${shape.height || fSize}" font-weight="bold" fill="${color}" text-anchor="middle" dominant-baseline="central">${shape.label}</text>
      `;
    }
    if (shape.ends === 'both' || shape.ends === 'end') {
      bubblesSvg += `
        <circle cx="${shape.b.x}" cy="${shape.b.y}" r="${r}" fill="#ffffff" stroke="${color}" stroke-width="${sw * 1.2}" />
        <text x="${shape.b.x}" y="${shape.b.y}" font-family="Arial, sans-serif" font-size="${shape.height || fSize}" font-weight="bold" fill="${color}" text-anchor="middle" dominant-baseline="central">${shape.label}</text>
      `;
    }
    return `
      <g class="draft-axis">
        <line x1="${shape.a.x}" y1="${shape.a.y}" x2="${shape.b.x}" y2="${shape.b.y}" stroke="${color}" stroke-width="${sw * 0.8}" stroke-dasharray="0.6, 0.2, 0.2, 0.2" />
        ${bubblesSvg}
      </g>
    `;
  }

  if (shape.type === 'hatch') {
    const paths = shape.loops
      .map(
        (loop) =>
          `M ${loop.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`
      )
      .join(' ');
    return `<path d="${paths}" fill="${shape.color || 'url(#hatch-ansi31)'}" stroke="${color}" stroke-width="${sw}" />`;
  }

  return '';
}
