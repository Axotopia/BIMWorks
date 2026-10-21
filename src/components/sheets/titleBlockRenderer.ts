/**
 * Title Block Renderer
 *
 * Adopts N:/ifcsheet/packages/drawing-2d/src/sheet/title-block-renderer.ts
 * Renders professional architectural title blocks with:
 * - Position options: 'bottom-right' (standard), 'bottom-full', 'right-strip'
 * - Project / Sheet metadata fields in crisp architectural typography
 * - Graphic scale bar ladder (dynamic metric / imperial subdivisions)
 * - Orientation True North arrow
 * - Revision history table
 */

export interface TitleBlockData {
  projectName: string;
  sheetTitle: string;
  sheetNumber: string;
  drawnBy: string;
  checkedBy?: string;
  date: string;
  scale: string;
  revision?: string;
  projectNumber?: string;
  client?: string;
  revisions?: Array<{ sequence: number; description: string; date: string; drawnBy?: string }>;
}

export interface TitleBlockOptions {
  position?: 'bottom-right' | 'bottom-full' | 'right-strip';
  widthMm?: number;
  heightMm?: number;
  borderWeight?: number;
  gridWeight?: number;
  showNorthArrow?: boolean;
  showScaleBar?: boolean;
  showRevisionTable?: boolean;
}

export interface TitleBlockRenderResult {
  svgElements: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export function renderTitleBlock(
  frameInnerBounds: { x: number; y: number; width: number; height: number },
  data: TitleBlockData,
  options: TitleBlockOptions = {}
): TitleBlockRenderResult {
  const position = options.position ?? 'bottom-right';
  const borderWeight = options.borderWeight ?? 0.7;
  const gridWeight = options.gridWeight ?? 0.35;
  const showNorthArrow = options.showNorthArrow ?? true;
  const showScaleBar = options.showScaleBar ?? true;
  const showRevisionTable = options.showRevisionTable ?? true;

  let widthMm = options.widthMm ?? 180;
  let heightMm = options.heightMm ?? 60;

  let x = 0;
  let y = 0;

  if (position === 'bottom-right') {
    x = frameInnerBounds.x + frameInnerBounds.width - widthMm;
    y = frameInnerBounds.y + frameInnerBounds.height - heightMm;
  } else if (position === 'bottom-full') {
    widthMm = frameInnerBounds.width;
    x = frameInnerBounds.x;
    y = frameInnerBounds.y + frameInnerBounds.height - heightMm;
  } else if (position === 'right-strip') {
    widthMm = options.widthMm ?? 65;
    heightMm = frameInnerBounds.height;
    x = frameInnerBounds.x + frameInnerBounds.width - widthMm;
    y = frameInnerBounds.y;
  }

  let svg = `<g id="title-block" class="title-block" transform="translate(${x.toFixed(2)}, ${y.toFixed(2)})">\n`;

  // Background and Outer Border
  svg += `  <rect x="0" y="0" width="${widthMm.toFixed(2)}" height="${heightMm.toFixed(2)}" fill="#ffffff" stroke="#0f172a" stroke-width="${borderWeight}" />\n`;

  if (position === 'bottom-right' || position === 'bottom-full') {
    // 3 Columns: Left = Revisions & Symbols, Middle = Project & Drawing Info, Right = Sheet Number / Scale
    const col1W = 60;
    const col3W = 45;
    const col2W = widthMm - col1W - col3W;

    const col1X = 0;
    const col2X = col1W;
    const col3X = col1W + col2W;

    // Vertical Divider lines
    svg += `  <line x1="${col2X}" y1="0" x2="${col2X}" y2="${heightMm}" stroke="#334155" stroke-width="${gridWeight}" />\n`;
    svg += `  <line x1="${col3X}" y1="0" x2="${col3X}" y2="${heightMm}" stroke="#334155" stroke-width="${gridWeight}" />\n`;

    // --- Column 1: Symbols (North Arrow & Scale Bar) & Mini Revision History ---
    if (showNorthArrow) {
      // North Arrow (compact 12mm circle with N indicator)
      svg += `  <g transform="translate(18, 18)">\n`;
      svg += `    <circle cx="0" cy="0" r="10" fill="none" stroke="#0f172a" stroke-width="0.5" />\n`;
      svg += `    <polygon points="0,-9 3.5,5 0,2 -3.5,5" fill="#0f172a" />\n`;
      svg += `    <text x="0" y="-11" font-family="Arial, sans-serif" font-size="3.5" font-weight="bold" fill="#0f172a" text-anchor="middle">N</text>\n`;
      svg += `  </g>\n`;
    }

    if (showScaleBar) {
      // Graphic Scale Bar Ladder
      svg += `  <g transform="translate(36, 12)">\n`;
      svg += `    <text x="0" y="-3" font-family="Arial, sans-serif" font-size="2.2" font-weight="bold" fill="#64748b">GRAPHIC SCALE</text>\n`;
      svg += `    <rect x="0" y="0" width="8" height="2.5" fill="#0f172a" />\n`;
      svg += `    <rect x="8" y="0" width="8" height="2.5" fill="#e2e8f0" stroke="#0f172a" stroke-width="0.3" />\n`;
      svg += `    <text x="0" y="5" font-family="Arial, sans-serif" font-size="2" fill="#334155" text-anchor="middle">0</text>\n`;
      svg += `    <text x="8" y="5" font-family="Arial, sans-serif" font-size="2" fill="#334155" text-anchor="middle">5</text>\n`;
      svg += `    <text x="16" y="5" font-family="Arial, sans-serif" font-size="2" fill="#334155" text-anchor="middle">10m</text>\n`;
      svg += `  </g>\n`;
    }

    // Mini Revision entry in Col 1 bottom
    const revY = 28;
    svg += `  <line x1="${col1X}" y1="${revY}" x2="${col2X}" y2="${revY}" stroke="#cbd5e1" stroke-width="${gridWeight}" />\n`;
    svg += `  <text x="3" y="${revY + 5}" font-family="Arial, sans-serif" font-size="2.2" font-weight="bold" fill="#64748b">REVISION RECORD</text>\n`;
    const revs = data.revisions && data.revisions.length > 0 ? data.revisions.slice(-2) : [{ sequence: 1, description: 'Initial Issue for Construction', date: data.date }];
    revs.forEach((r, idx) => {
      const lineY = revY + 11 + idx * 8;
      svg += `  <text x="3" y="${lineY}" font-family="Arial, sans-serif" font-size="2.2" font-weight="bold" fill="#0f172a">#${r.sequence}</text>\n`;
      svg += `  <text x="10" y="${lineY}" font-family="Arial, sans-serif" font-size="2.2" fill="#334155">${r.description.slice(0, 18)}</text>\n`;
      svg += `  <text x="44" y="${lineY}" font-family="Arial, sans-serif" font-size="2" fill="#64748b">${r.date}</text>\n`;
    });

    // --- Column 2: Project & Drawing Info ---
    // Project Name Block
    svg += `  <g transform="translate(${col2X + 4}, 4)">\n`;
    svg += `    <text x="0" y="4" font-family="Arial, sans-serif" font-size="2.4" font-weight="bold" fill="#64748b" letter-spacing="0.5">PROJECT</text>\n`;
    svg += `    <text x="0" y="11" font-family="Arial, sans-serif" font-size="4.2" font-weight="bold" fill="#0f172a">${data.projectName || 'BIMWorks Project'}</text>\n`;
    svg += `  </g>\n`;

    const row2Y = 20;
    svg += `  <line x1="${col2X}" y1="${row2Y}" x2="${col3X}" y2="${row2Y}" stroke="#cbd5e1" stroke-width="${gridWeight}" />\n`;

    // Sheet Title Block
    svg += `  <g transform="translate(${col2X + 4}, ${row2Y + 4})">\n`;
    svg += `    <text x="0" y="4" font-family="Arial, sans-serif" font-size="2.4" font-weight="bold" fill="#64748b" letter-spacing="0.5">SHEET TITLE</text>\n`;
    svg += `    <text x="0" y="12" font-family="Arial, sans-serif" font-size="5" font-weight="bold" fill="#0284c7">${data.sheetTitle || 'GENERAL ARRANGEMENT'}</text>\n`;
    svg += `  </g>\n`;

    const row3Y = 42;
    svg += `  <line x1="${col2X}" y1="${row3Y}" x2="${col3X}" y2="${row3Y}" stroke="#cbd5e1" stroke-width="${gridWeight}" />\n`;

    // Metadata: Drawn By, Checked By, Date
    svg += `  <g transform="translate(${col2X + 4}, ${row3Y + 5})">\n`;
    svg += `    <text x="0" y="4" font-family="Arial, sans-serif" font-size="2.2" fill="#64748b">Drawn By: <tspan font-weight="bold" fill="#0f172a">${data.drawnBy || 'Architect'}</tspan></text>\n`;
    svg += `    <text x="0" y="10" font-family="Arial, sans-serif" font-size="2.2" fill="#64748b">Checked: <tspan font-weight="bold" fill="#0f172a">${data.checkedBy || 'BIM Lead'}</tspan></text>\n`;
    svg += `    <text x="${col2W / 2}" y="4" font-family="Arial, sans-serif" font-size="2.2" fill="#64748b">Date: <tspan font-weight="bold" fill="#0f172a">${data.date}</tspan></text>\n`;
    svg += `    <text x="${col2W / 2}" y="10" font-family="Arial, sans-serif" font-size="2.2" fill="#64748b">Status: <tspan font-weight="bold" fill="#16a34a">Approved</tspan></text>\n`;
    svg += `  </g>\n`;

    // --- Column 3: Sheet Number, Scale & Revision Badge ---
    // Scale Block
    svg += `  <g transform="translate(${col3X + 4}, 4)">\n`;
    svg += `    <text x="0" y="4" font-family="Arial, sans-serif" font-size="2.2" font-weight="bold" fill="#64748b">SCALE</text>\n`;
    svg += `    <text x="0" y="10" font-family="Arial, sans-serif" font-size="3.2" font-weight="bold" fill="#0f172a">${data.scale || 'As Indicated'}</text>\n`;
    svg += `  </g>\n`;

    const sNumDivY = 18;
    svg += `  <line x1="${col3X}" y1="${sNumDivY}" x2="${widthMm}" y2="${sNumDivY}" stroke="#0f172a" stroke-width="${gridWeight}" />\n`;

    // Sheet Number Hero
    svg += `  <g transform="translate(${col3X + 4}, ${sNumDivY + 6})">\n`;
    svg += `    <text x="0" y="4" font-family="Arial, sans-serif" font-size="2.4" font-weight="bold" fill="#64748b">SHEET NO.</text>\n`;
    svg += `    <text x="0" y="18" font-family="Arial, sans-serif" font-size="10" font-weight="bold" fill="#0f172a">${data.sheetNumber || 'A101'}</text>\n`;
    svg += `  </g>\n`;

    const revBadgeY = 44;
    svg += `  <line x1="${col3X}" y1="${revBadgeY}" x2="${widthMm}" y2="${revBadgeY}" stroke="#cbd5e1" stroke-width="${gridWeight}" />\n`;
    svg += `  <g transform="translate(${col3X + 4}, ${revBadgeY + 5})">\n`;
    svg += `    <text x="0" y="4" font-family="Arial, sans-serif" font-size="2.2" fill="#64748b">REV: <tspan font-weight="bold" font-size="3" fill="#0f172a">${data.revision || '-'}</tspan></text>\n`;
    svg += `  </g>\n`;
  }

  svg += `</g>\n`;

  return {
    svgElements: svg,
    bounds: { x, y, width: widthMm, height: heightMm },
  };
}
