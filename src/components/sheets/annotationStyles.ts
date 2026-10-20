import { DraftingLayer, LayerGroup, TextStyle, DimensionStyle } from '../../types/bim';

export const DEFAULT_DRAFTING_LAYERS: DraftingLayer[] = [
  {
    id: 'layer-anno-note',
    name: 'A-ANNO-NOTE',
    groupId: 'group-annotations',
    colour: '#0f172a',
    penWeight: 0.25,
    lineType: 'solid',
    visible: true,
    locked: false,
  },
  {
    id: 'layer-anno-dims',
    name: 'A-ANNO-DIMS',
    groupId: 'group-annotations',
    colour: '#2563eb',
    penWeight: 0.18,
    lineType: 'solid',
    visible: true,
    locked: false,
  },
  {
    id: 'layer-anno-lead',
    name: 'A-ANNO-LEAD',
    groupId: 'group-annotations',
    colour: '#0f172a',
    penWeight: 0.25,
    lineType: 'solid',
    visible: true,
    locked: false,
  },
  {
    id: 'layer-anno-line',
    name: 'A-ANNO-LINE',
    groupId: 'group-annotations',
    colour: '#334155',
    penWeight: 0.35,
    lineType: 'solid',
    visible: true,
    locked: false,
  },
  {
    id: 'layer-anno-redl',
    name: 'A-ANNO-REDL',
    groupId: 'group-revisions',
    colour: '#dc2626',
    penWeight: 0.5,
    lineType: 'dashed',
    visible: true,
    locked: false,
  },
];

export const DEFAULT_LAYER_GROUPS: LayerGroup[] = [
  {
    id: 'group-annotations',
    name: 'Annotations & Dimensions',
    layerIds: ['layer-anno-note', 'layer-anno-dims', 'layer-anno-lead', 'layer-anno-line'],
  },
  {
    id: 'group-revisions',
    name: 'Revisions & Redlines',
    layerIds: ['layer-anno-redl'],
  },
];

export const DEFAULT_TEXT_STYLES: TextStyle[] = [
  {
    id: 'style-text-standard',
    name: 'Standard Note (2.5mm)',
    font: 'Inter, system-ui, sans-serif',
    heightMm: 2.5,
    bold: false,
    italic: false,
    colour: '#0f172a',
  },
  {
    id: 'style-text-header',
    name: 'Header (4.0mm Bold)',
    font: 'Inter, system-ui, sans-serif',
    heightMm: 4.0,
    bold: true,
    italic: false,
    colour: '#0f172a',
  },
  {
    id: 'style-text-mono',
    name: 'Technical Monospace (2.2mm)',
    font: 'JetBrains Mono, monospace',
    heightMm: 2.2,
    bold: false,
    italic: false,
    colour: '#334155',
  },
];

export const DEFAULT_DIMENSION_STYLES: DimensionStyle[] = [
  {
    id: 'style-dim-arch-tick',
    name: 'Architectural Tick (ft-in)',
    arrowType: 'tick',
    textPlacement: 'above',
    precision: 2,
    gap: 2.0,
    unit: 'ft-in',
  },
  {
    id: 'style-dim-eng-arrow',
    name: 'Engineering Arrow (m)',
    arrowType: 'arrow',
    textPlacement: 'above',
    precision: 3,
    gap: 2.0,
    unit: 'm',
  },
  {
    id: 'style-dim-metric-mm',
    name: 'Metric Millimeter (mm)',
    arrowType: 'tick',
    textPlacement: 'above',
    precision: 0,
    gap: 2.0,
    unit: 'mm',
  },
];

/**
 * Format paper-space pixel distance into a dimension string according to style.
 * 1 point/pixel at 72dpi ≈ 0.352778 mm.
 */
export function formatDimensionValue(pxDistance: number, style: DimensionStyle): string {
  // Assume 1 px on sheet ≈ 0.3528 mm paper distance
  const distMm = pxDistance * 0.352778;

  if (style.unit === 'mm') {
    return `${Math.round(distMm)} mm`;
  }

  if (style.unit === 'm') {
    return `${(distMm / 1000).toFixed(style.precision)} m`;
  }

  // ft-in
  const totalInches = distMm / 25.4;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches % 12);
  if (feet === 0) return `${inches}"`;
  return `${feet}'-${inches}"`;
}

/**
 * Maps mm line width to SVG stroke-width in px (assuming 72dpi: 1mm = ~2.835px)
 */
export function mmToSvgPx(mm: number): number {
  return Math.max(0.5, mm * 2.83465);
}

/**
 * Gets SVG stroke-dasharray for line types
 */
export function getLineTypeDashArray(lineType: DraftingLayer['lineType'], penWeight: number): string | undefined {
  const w = mmToSvgPx(penWeight);
  switch (lineType) {
    case 'dashed':
      return `${w * 4}, ${w * 2}`;
    case 'dotted':
      return `${w}, ${w * 1.5}`;
    case 'dashdot':
      return `${w * 4}, ${w * 2}, ${w}, ${w * 2}`;
    default:
      return undefined;
  }
}
