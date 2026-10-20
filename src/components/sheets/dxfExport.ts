import { SheetDefinition, SheetViewport, ViewDefinition, Sliced2DData, DraftingLayer, TextStyle, DimensionStyle } from '../../types/bim';
import { getSheetDimensions } from './paperSizes';
import { formatDimensionValue } from './annotationStyles';

/**
 * Maps a hex color to an approximate AutoCAD Color Index (ACI 1-9).
 */
function hexToAci(hex: string): number {
  if (!hex || hex === '#ffffff') return 7; // White / Black
  const clean = hex.replace('#', '').toLowerCase();
  if (clean.length < 6) return 7;
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);

  if (r > 180 && g < 80 && b < 80) return 1; // Red
  if (r > 180 && g > 180 && b < 80) return 2; // Yellow
  if (r < 80 && g > 180 && b < 80) return 3; // Green
  if (r < 80 && g > 180 && b > 180) return 4; // Cyan
  if (r < 80 && g < 80 && b > 180) return 5; // Blue
  if (r > 180 && g < 80 && b > 180) return 6; // Magenta
  if (r < 80 && g < 80 && b < 80) return 7; // Black/White
  if (r >= 80 && r <= 150 && g >= 80 && g <= 150 && b >= 80 && b <= 150) return 8; // Dark Gray
  return 9; // Light Gray
}

/**
 * Extracts line segments from standard SVG path 'd' attribute strings.
 */
function parseSvgPathSegments(d: string): [number, number, number, number][] {
  const segments: [number, number, number, number][] = [];
  if (!d) return segments;

  const commands = d.match(/([a-df-z][^a-df-z]*)/gi);
  if (!commands) return segments;

  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;

  for (const cmd of commands) {
    const type = cmd[0];
    const nums = (cmd.slice(1).trim().match(/[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) || []).map(Number);

    if (type === 'M' || type === 'm') {
      if (nums.length >= 2) {
        curX = type === 'M' ? nums[0] : curX + nums[0];
        curY = type === 'M' ? nums[1] : curY + nums[1];
        startX = curX;
        startY = curY;
      }
    } else if (type === 'L' || type === 'l') {
      for (let i = 0; i < nums.length; i += 2) {
        const nextX = type === 'L' ? nums[i] : curX + nums[i];
        const nextY = type === 'L' ? nums[i + 1] : curY + nums[i + 1];
        segments.push([curX, curY, nextX, nextY]);
        curX = nextX;
        curY = nextY;
      }
    } else if (type === 'Z' || type === 'z') {
      segments.push([curX, curY, startX, startY]);
      curX = startX;
      curY = startY;
    }
  }

  return segments;
}

/**
 * Generates an AutoCAD R2000 (AC1015) ASCII DXF file for a BIMWorks Sheet.
 * Coordinates are mapped to paper millimeters with origin (0,0) at lower-left.
 */
export function generateSheetDxf(
  sheet: SheetDefinition,
  views: ViewDefinition[],
  sliced2D: Sliced2DData | null,
  draftingLayers: DraftingLayer[],
  textStyles: TextStyle[],
  dimensionStyles: DimensionStyle[]
): string {
  const { width: sheetWidth, height: sheetHeight } = getSheetDimensions(sheet.paperSize, sheet.orientation);

  // DXF Y-axis is up, SVG Y-axis is down: y_dxf = sheetHeight - y_svg
  const toDxfY = (y: number) => Math.round((sheetHeight - y) * 100) / 100;
  const toDxfX = (x: number) => Math.round(x * 100) / 100;

  const lines: string[] = [];
  const emit = (...args: (string | number)[]) => {
    for (const a of args) lines.push(String(a));
  };

  // 1. HEADER SECTION
  emit(0, 'SECTION');
  emit(2, 'HEADER');
  emit(9, '$ACADVER');
  emit(1, 'AC1015'); // AutoCAD 2000
  emit(9, '$INSUNITS');
  emit(70, 4); // Millimeters
  emit(9, '$MEASUREMENT');
  emit(70, 1); // Metric
  emit(0, 'ENDSEC');

  // 2. TABLES SECTION
  emit(0, 'SECTION');
  emit(2, 'TABLES');

  // Linetypes
  emit(0, 'TABLE');
  emit(2, 'LTYPE');
  emit(70, 3);
  // CONTINUOUS
  emit(0, 'LTYPE');
  emit(2, 'CONTINUOUS');
  emit(70, 0);
  emit(3, 'Solid line');
  emit(72, 65);
  emit(73, 0);
  emit(40, 0.0);
  // DASHED
  emit(0, 'LTYPE');
  emit(2, 'DASHED');
  emit(70, 0);
  emit(3, '__ __ __ __ __');
  emit(72, 65);
  emit(73, 2);
  emit(40, 6.0);
  emit(49, 4.0);
  emit(49, -2.0);
  // HIDDEN
  emit(0, 'LTYPE');
  emit(2, 'HIDDEN');
  emit(70, 0);
  emit(3, '_ _ _ _ _');
  emit(72, 65);
  emit(73, 2);
  emit(40, 4.0);
  emit(49, 2.5);
  emit(49, -1.5);
  emit(0, 'ENDTAB');

  // Layers Table
  emit(0, 'TABLE');
  emit(2, 'LAYER');
  emit(70, draftingLayers.length + 5);

  const baseLayers = [
    { name: '0', color: 7, ltype: 'CONTINUOUS' },
    { name: 'A-BORDER', color: 7, ltype: 'CONTINUOUS' },
    { name: 'A-TITLE-BLOCK', color: 4, ltype: 'CONTINUOUS' },
    { name: 'A-VIEWPORT', color: 8, ltype: 'DASHED' },
    { name: 'A-WALL-CUT', color: 7, ltype: 'CONTINUOUS' },
    { name: 'A-PROJ', color: 8, ltype: 'CONTINUOUS' },
    { name: 'A-DOOR-SWING', color: 5, ltype: 'CONTINUOUS' },
  ];

  for (const bl of baseLayers) {
    emit(0, 'LAYER');
    emit(2, bl.name);
    emit(70, 0);
    emit(62, bl.color);
    emit(6, bl.ltype);
  }

  for (const dl of draftingLayers) {
    emit(0, 'LAYER');
    emit(2, dl.name.toUpperCase().replace(/\s+/g, '_'));
    emit(70, 0);
    emit(62, hexToAci(dl.colour));
    emit(6, dl.lineType === 'dashed' ? 'DASHED' : 'CONTINUOUS');
  }

  emit(0, 'ENDTAB');
  emit(0, 'ENDSEC');

  // 3. BLOCKS SECTION
  emit(0, 'SECTION');
  emit(2, 'BLOCKS');
  emit(0, 'ENDSEC');

  // 4. ENTITIES SECTION
  emit(0, 'SECTION');
  emit(2, 'ENTITIES');

  // Helper: Emit Line
  const emitLine = (x1: number, y1: number, x2: number, y2: number, layer: string) => {
    emit(0, 'LINE');
    emit(8, layer);
    emit(10, toDxfX(x1));
    emit(20, toDxfY(y1));
    emit(30, 0.0);
    emit(11, toDxfX(x2));
    emit(21, toDxfY(y2));
    emit(31, 0.0);
  };

  // Helper: Emit Text
  const emitText = (x: number, y: number, text: string, height: number, layer: string, align: 'left' | 'center' | 'right' = 'left') => {
    emit(0, 'TEXT');
    emit(8, layer);
    emit(10, toDxfX(x));
    emit(20, toDxfY(y));
    emit(30, 0.0);
    emit(40, height);
    emit(1, text);
    if (align === 'center') {
      emit(72, 1);
      emit(11, toDxfX(x));
      emit(21, toDxfY(y));
      emit(31, 0.0);
    } else if (align === 'right') {
      emit(72, 2);
      emit(11, toDxfX(x));
      emit(21, toDxfY(y));
      emit(31, 0.0);
    }
  };

  // Sheet Outer & Inner Margins
  emitLine(20, 20, sheetWidth - 20, 20, 'A-BORDER');
  emitLine(sheetWidth - 20, 20, sheetWidth - 20, sheetHeight - 20, 'A-BORDER');
  emitLine(sheetWidth - 20, sheetHeight - 20, 20, sheetHeight - 20, 'A-BORDER');
  emitLine(20, sheetHeight - 20, 20, 20, 'A-BORDER');

  emitLine(24, 24, sheetWidth - 24, 24, 'A-BORDER');
  emitLine(sheetWidth - 24, 24, sheetWidth - 24, sheetHeight - 24, 'A-BORDER');
  emitLine(sheetWidth - 24, sheetHeight - 24, 24, sheetHeight - 24, 'A-BORDER');
  emitLine(24, sheetHeight - 24, 24, 24, 'A-BORDER');

  // Title Block Box
  const tbX = sheetWidth - 280;
  const tbY = 24;
  const tbW = 256;
  const tbH = sheetHeight - 48;
  emitLine(tbX, tbY, tbX + tbW, tbY, 'A-TITLE-BLOCK');
  emitLine(tbX + tbW, tbY, tbX + tbW, tbY + tbH, 'A-TITLE-BLOCK');
  emitLine(tbX + tbW, tbY + tbH, tbX, tbY + tbH, 'A-TITLE-BLOCK');
  emitLine(tbX, tbY + tbH, tbX, tbY, 'A-TITLE-BLOCK');

  // Title Block Texts
  emitText(tbX + tbW / 2, tbY + 45, 'BIMWORKS', 16, 'A-TITLE-BLOCK', 'center');
  emitText(tbX + tbW / 2, tbY + 65, 'NATIVE IFC4 BIM STUDIO', 8, 'A-TITLE-BLOCK', 'center');
  emitText(tbX + 15, tbY + 115, 'PROJECT: ' + (sheet.projectName || 'BIMWorks Project'), 10, 'A-TITLE-BLOCK');
  emitText(tbX + 15, tbY + 145, 'TITLE: ' + (sheet.sheetTitle || 'UNNAMED SHEET'), 11, 'A-TITLE-BLOCK');
  emitText(tbX + 15, tbY + 175, 'DATE: ' + (sheet.date || new Date().toISOString().slice(0, 10)), 9, 'A-TITLE-BLOCK');
  emitText(tbX + 15, tbY + 195, 'DRAWN BY: ' + (sheet.drawnBy || 'BIMWorks Architect'), 9, 'A-TITLE-BLOCK');
  emitText(tbX + tbW / 2, tbY + tbH - 30, sheet.sheetNumber || 'A101', 28, 'A-TITLE-BLOCK', 'center');

  // Revisions in Title Block
  const revs = sheet.revisions && sheet.revisions.length > 0
    ? sheet.revisions
    : [{ id: '1', sequence: 1, description: 'INITIAL BIM ISSUE', date: sheet.date || '2026-10-15' }];

  let revOffset = 0;
  emitText(tbX + 15, tbY + 310, 'REVISIONS', 9, 'A-TITLE-BLOCK');
  for (const r of revs.slice(0, 5)) {
    emitText(tbX + 15, tbY + 330 + revOffset, `${r.sequence}  ${r.description}  ${r.date}`, 7, 'A-TITLE-BLOCK');
    revOffset += 16;
  }

  // Viewports & linework
  (sheet.viewports || []).forEach((vp: SheetViewport, idx: number) => {
    // Viewport Boundary
    emitLine(vp.x, vp.y, vp.x + vp.width, vp.y, 'A-VIEWPORT');
    emitLine(vp.x + vp.width, vp.y, vp.x + vp.width, vp.y + vp.height, 'A-VIEWPORT');
    emitLine(vp.x + vp.width, vp.y + vp.height, vp.x, vp.y + vp.height, 'A-VIEWPORT');
    emitLine(vp.x, vp.y + vp.height, vp.x, vp.y, 'A-VIEWPORT');

    const viewDef = views.find((v) => v.id === vp.viewId);
    const viewTitle = viewDef?.name || `View ${idx + 1}`;
    emitText(vp.x + 15, vp.y + vp.height + 25, `${idx + 1}  ${viewTitle} (Scale 1:${vp.scaleFactor || 20})`, 9, 'A-VIEWPORT');

    // Viewport Model Linework
    const vpScale = vp.scaleFactor ?? 20;
    const originX = vp.x + 180;
    const originY = vp.y + 220;

    if (sliced2D) {
      // Cuts
      (sliced2D.cut_paths || []).forEach((p) => {
        const segs = parseSvgPathSegments(p.d);
        for (const [x1, y1, x2, y2] of segs) {
          emitLine(
            originX + x1 * vpScale,
            originY - y1 * vpScale,
            originX + x2 * vpScale,
            originY - y2 * vpScale,
            'A-WALL-CUT'
          );
        }
      });

      // Projections
      (sliced2D.projection_paths || []).forEach((p) => {
        const segs = parseSvgPathSegments(p.d);
        for (const [x1, y1, x2, y2] of segs) {
          emitLine(
            originX + x1 * vpScale,
            originY - y1 * vpScale,
            originX + x2 * vpScale,
            originY - y2 * vpScale,
            'A-PROJ'
          );
        }
      });

      // Door Swings
      (sliced2D.swing_paths || []).forEach((p) => {
        const segs = parseSvgPathSegments(p.d);
        for (const [x1, y1, x2, y2] of segs) {
          emitLine(
            originX + x1 * vpScale,
            originY - y1 * vpScale,
            originX + x2 * vpScale,
            originY - y2 * vpScale,
            'A-DOOR-SWING'
          );
        }
      });
    }
  });

  // Sheet Vector Annotations
  (sheet.annotations || []).forEach((anno) => {
    const layer = draftingLayers.find((l) => l.id === anno.layerId) || draftingLayers[0];
    const layerName = layer ? layer.name.toUpperCase().replace(/\s+/g, '_') : '0';

    if (anno.kind === 'line') {
      const p1 = anno.points[0] || [0, 0];
      const p2 = anno.points[1] || [100, 100];
      emitLine(p1[0], p1[1], p2[0], p2[1], layerName);
    } else if (anno.kind === 'text') {
      const p = anno.points[0] || [100, 100];
      const style = textStyles.find((s) => s.id === anno.styleId) || textStyles[0];
      const height = (style?.heightMm || 2.5) * 3.5;
      emitText(p[0], p[1], anno.text || 'NOTE', height, layerName);
    } else if (anno.kind === 'leader') {
      const p1 = anno.points[0] || [0, 0];
      const p2 = anno.points[1] || [50, 50];
      const p3 = anno.points[2] || [p2[0] + 30, p2[1]];
      emitLine(p1[0], p1[1], p2[0], p2[1], layerName);
      emitLine(p2[0], p2[1], p3[0], p3[1], layerName);
      emitText(p3[0] + 4, p3[1], anno.text || 'CALLOUT', 9, layerName);
    } else if (anno.kind === 'dimension') {
      const p1 = anno.points[0] || [0, 0];
      const p2 = anno.points[1] || [100, 0];
      const dimStyle = dimensionStyles.find((s) => s.id === anno.styleId) || dimensionStyles[0];
      const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const dimText = formatDimensionValue(dist, dimStyle);
      const midX = (p1[0] + p2[0]) / 2;
      const midY = (p1[1] + p2[1]) / 2;

      emitLine(p1[0], p1[1], p2[0], p2[1], layerName);
      emitText(midX, midY - 4, dimText, 8, layerName, 'center');
    }
  });

  emit(0, 'ENDSEC');
  emit(0, 'EOF');

  return lines.join('\n');
}

/**
 * Initiates browser download of the generated DXF file.
 */
export function downloadSheetDxf(
  sheet: SheetDefinition,
  views: ViewDefinition[],
  sliced2D: Sliced2DData | null,
  draftingLayers: DraftingLayer[],
  textStyles: TextStyle[],
  dimensionStyles: DimensionStyle[]
): void {
  const dxfContent = generateSheetDxf(sheet, views, sliced2D, draftingLayers, textStyles, dimensionStyles);
  const blob = new Blob([dxfContent], { type: 'application/dxf;charset=utf-8' });
  const filename = `${sheet.sheetNumber || 'A101'}_${(sheet.sheetTitle || 'Sheet').replace(/\s+/g, '_')}.dxf`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
