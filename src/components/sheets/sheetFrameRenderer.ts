/**
 * Frame Renderer for Sheets
 *
 * Implements standard architectural sheet frames matching N:/ifcsheet:
 * - Outer and inner border rectangles
 * - Zone reference labels (A-H, 1-8) with tick marks
 * - Fold marks for large format folding
 * - Trim marks for print cutting
 */

export interface FrameMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
  bindingMargin?: number;
}

export interface FrameBorderConfig {
  outerLineWeight: number; // mm
  innerLineWeight: number; // mm
  borderGap: number;       // mm
  showFoldMarks?: boolean;
  showTrimMarks?: boolean;
}

export interface FrameOptions {
  margins?: Partial<FrameMargins>;
  border?: Partial<FrameBorderConfig>;
  showZoneReferences?: boolean;
  horizontalZones?: number;
  verticalZones?: number;
  zoneFontSize?: number;
}

export interface FrameRenderResult {
  svgElements: string;
  innerBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export function renderSheetFrame(
  paperWidthMm: number,
  paperHeightMm: number,
  options: FrameOptions = {}
): FrameRenderResult {
  const margins: FrameMargins = {
    top: options.margins?.top ?? 10,
    right: options.margins?.right ?? 10,
    bottom: options.margins?.bottom ?? 10,
    left: options.margins?.left ?? 15,
    bindingMargin: options.margins?.bindingMargin ?? 5,
  };

  const border: FrameBorderConfig = {
    outerLineWeight: options.border?.outerLineWeight ?? 0.7,
    innerLineWeight: options.border?.innerLineWeight ?? 0.35,
    borderGap: options.border?.borderGap ?? 5,
    showFoldMarks: options.border?.showFoldMarks ?? true,
    showTrimMarks: options.border?.showTrimMarks ?? true,
  };

  const showZone = options.showZoneReferences ?? true;
  const hZones = options.horizontalZones ?? 8;
  const vZones = options.verticalZones ?? 6;
  const zoneFontSize = options.zoneFontSize ?? 3.5;

  const outerX = margins.left + (margins.bindingMargin ?? 0);
  const outerY = margins.top;
  const outerW = paperWidthMm - outerX - margins.right;
  const outerH = paperHeightMm - margins.top - margins.bottom;

  let innerX = outerX;
  let innerY = outerY;
  let innerW = outerW;
  let innerH = outerH;

  let svg = '<g id="sheet-frame" class="sheet-frame">\n';

  // Outer border
  svg += `  <rect x="${outerX.toFixed(2)}" y="${outerY.toFixed(2)}" width="${outerW.toFixed(2)}" height="${outerH.toFixed(2)}" fill="none" stroke="#0f172a" stroke-width="${border.outerLineWeight}" />\n`;

  // Inner border if gap specified
  if (border.borderGap > 0 && border.innerLineWeight > 0) {
    innerX = outerX + border.borderGap;
    innerY = outerY + border.borderGap;
    innerW = Math.max(0, outerW - 2 * border.borderGap);
    innerH = Math.max(0, outerH - 2 * border.borderGap);

    svg += `  <rect x="${innerX.toFixed(2)}" y="${innerY.toFixed(2)}" width="${innerW.toFixed(2)}" height="${innerH.toFixed(2)}" fill="none" stroke="#334155" stroke-width="${border.innerLineWeight}" />\n`;
  }

  // Zone references along outer border margin
  if (showZone && hZones > 0 && vZones > 0 && border.borderGap > 0) {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const zoneW = outerW / hZones;
    const zoneH = outerH / vZones;

    // Horizontal zone labels (1 to 8)
    for (let i = 0; i < hZones; i++) {
      const zx = outerX + zoneW * (i + 0.5);
      const label = `${i + 1}`;
      const gapYTop = outerY + border.borderGap / 2;
      const gapYBottom = outerY + outerH - border.borderGap / 2;

      svg += `  <text x="${zx.toFixed(2)}" y="${gapYTop.toFixed(2)}" font-family="Arial, sans-serif" font-size="${zoneFontSize}" font-weight="bold" fill="#64748b" text-anchor="middle" dominant-baseline="middle">${label}</text>\n`;
      svg += `  <text x="${zx.toFixed(2)}" y="${gapYBottom.toFixed(2)}" font-family="Arial, sans-serif" font-size="${zoneFontSize}" font-weight="bold" fill="#64748b" text-anchor="middle" dominant-baseline="middle">${label}</text>\n`;

      if (i > 0) {
        const tickX = outerX + zoneW * i;
        svg += `  <line x1="${tickX.toFixed(2)}" y1="${outerY.toFixed(2)}" x2="${tickX.toFixed(2)}" y2="${innerY.toFixed(2)}" stroke="#64748b" stroke-width="${border.innerLineWeight}" />\n`;
        svg += `  <line x1="${tickX.toFixed(2)}" y1="${(innerY + innerH).toFixed(2)}" x2="${tickX.toFixed(2)}" y2="${(outerY + outerH).toFixed(2)}" stroke="#64748b" stroke-width="${border.innerLineWeight}" />\n`;
      }
    }

    // Vertical zone labels (A to F)
    for (let j = 0; j < vZones; j++) {
      const zy = outerY + zoneH * (j + 0.5);
      const letter = letters[j % letters.length];
      const gapXLeft = outerX + border.borderGap / 2;
      const gapXRight = outerX + outerW - border.borderGap / 2;

      svg += `  <text x="${gapXLeft.toFixed(2)}" y="${zy.toFixed(2)}" font-family="Arial, sans-serif" font-size="${zoneFontSize}" font-weight="bold" fill="#64748b" text-anchor="middle" dominant-baseline="middle">${letter}</text>\n`;
      svg += `  <text x="${gapXRight.toFixed(2)}" y="${zy.toFixed(2)}" font-family="Arial, sans-serif" font-size="${zoneFontSize}" font-weight="bold" fill="#64748b" text-anchor="middle" dominant-baseline="middle">${letter}</text>\n`;

      if (j > 0) {
        const tickY = outerY + zoneH * j;
        svg += `  <line x1="${outerX.toFixed(2)}" y1="${tickY.toFixed(2)}" x2="${innerX.toFixed(2)}" y2="${tickY.toFixed(2)}" stroke="#64748b" stroke-width="${border.innerLineWeight}" />\n`;
        svg += `  <line x1="${(innerX + innerW).toFixed(2)}" y1="${tickY.toFixed(2)}" x2="${(outerX + outerW).toFixed(2)}" y2="${tickY.toFixed(2)}" stroke="#64748b" stroke-width="${border.innerLineWeight}" />\n`;
      }
    }
  }

  // Trim marks
  if (border.showTrimMarks) {
    const len = 6;
    svg += `  <g id="trim-marks" stroke="#000000" stroke-width="0.3">\n`;
    svg += `    <line x1="0" y1="0" x2="${len}" y2="0" />\n`;
    svg += `    <line x1="0" y1="0" x2="0" y2="${len}" />\n`;
    svg += `    <line x1="${paperWidthMm - len}" y1="0" x2="${paperWidthMm}" y2="0" />\n`;
    svg += `    <line x1="${paperWidthMm}" y1="0" x2="${paperWidthMm}" y2="${len}" />\n`;
    svg += `    <line x1="0" y1="${paperHeightMm - len}" x2="0" y2="${paperHeightMm}" />\n`;
    svg += `    <line x1="0" y1="${paperHeightMm}" x2="${len}" y2="${paperHeightMm}" />\n`;
    svg += `    <line x1="${paperWidthMm - len}" y1="${paperHeightMm}" x2="${paperWidthMm}" y2="${paperHeightMm}" />\n`;
    svg += `    <line x1="${paperWidthMm}" y1="${paperHeightMm - len}" x2="${paperWidthMm}" y2="${paperHeightMm}" />\n`;
    svg += `  </g>\n`;
  }

  svg += '</g>\n';

  return {
    svgElements: svg,
    innerBounds: {
      x: innerX,
      y: innerY,
      width: innerW,
      height: innerH,
    },
  };
}
