import { SheetPaperSize } from '../../types/bim';

export type PaperOrientation = 'portrait' | 'landscape';

export interface PaperSizeSpec {
  id: SheetPaperSize;
  name: string;
  category: 'ANSI' | 'ARCH' | 'ISO';
  width: number;       // base width in px (landscape)
  height: number;      // base height in px (landscape)
  widthMm: number;     // base width in mm
  heightMm: number;    // base height in mm
  description: string;
}

/**
 * Standard paper sizes supported by BIMWorks (aligned with IfcSheet standards).
 * Base dimensions are given in landscape.
 */
export const PAPER_SIZES: Record<SheetPaperSize, PaperSizeSpec> = {
  ANSI_D: {
    id: 'ANSI_D',
    name: 'ANSI D',
    category: 'ANSI',
    width: 1056,
    height: 704,
    widthMm: 863.6,
    heightMm: 558.8,
    description: '22" × 34" (559 × 864 mm)',
  },
  TABLOID: {
    id: 'TABLOID',
    name: 'Tabloid / ANSI B',
    category: 'ANSI',
    width: 792,
    height: 612,
    widthMm: 431.8,
    heightMm: 279.4,
    description: '11" × 17" (279 × 432 mm)',
  },
  LETTER: {
    id: 'LETTER',
    name: 'Letter / ANSI A',
    category: 'ANSI',
    width: 792,
    height: 612,
    widthMm: 279.4,
    heightMm: 215.9,
    description: '8.5" × 11" (216 × 279 mm)',
  },
  ARCH_D: {
    id: 'ARCH_D',
    name: 'ARCH D',
    category: 'ARCH',
    width: 1056,
    height: 704,
    widthMm: 914.4,
    heightMm: 609.6,
    description: '24" × 36" (610 × 914 mm)',
  },
  ARCH_C: {
    id: 'ARCH_C',
    name: 'ARCH C',
    category: 'ARCH',
    width: 864,
    height: 576,
    widthMm: 609.6,
    heightMm: 457.2,
    description: '18" × 24" (457 × 610 mm)',
  },
  ISO_A1: {
    id: 'ISO_A1',
    name: 'ISO A1',
    category: 'ISO',
    width: 1056,
    height: 746,
    widthMm: 841.0,
    heightMm: 594.0,
    description: '594 × 841 mm',
  },
};

/**
 * Calculates effective sheet width & height in px based on paper size and orientation.
 */
export function getSheetDimensions(
  paperSize: string = 'ANSI_D',
  orientation: PaperOrientation = 'landscape'
): { width: number; height: number; spec: PaperSizeSpec } {
  const normalizedKey = (paperSize as SheetPaperSize) in PAPER_SIZES
    ? (paperSize as SheetPaperSize)
    : 'ANSI_D';
  const spec = PAPER_SIZES[normalizedKey];
  const isPortrait = orientation === 'portrait';

  const baseW = Math.max(spec.width, spec.height);
  const baseH = Math.min(spec.width, spec.height);

  return {
    width: isPortrait ? baseH : baseW,
    height: isPortrait ? baseW : baseH,
    spec,
  };
}

/**
 * Standard architectural scales from 1:1 to 1:1000 (IfcSheet scale ladder).
 * Numerical scaleFactor represents screen points per model unit.
 * For example: at 1:50, 1000mm in model -> 20mm on paper -> scaleFactor 20.
 */
export interface ViewportScaleOption {
  label: string;
  ratio: string;
  scaleFactor: number;
}

export const STANDARD_SCALES: ViewportScaleOption[] = [
  { label: '1:1', ratio: '1:1', scaleFactor: 1000 },
  { label: '1:2', ratio: '1:2', scaleFactor: 500 },
  { label: '1:5', ratio: '1:5', scaleFactor: 200 },
  { label: '1:10', ratio: '1:10', scaleFactor: 100 },
  { label: '1:20', ratio: '1:20', scaleFactor: 50 },
  { label: '1:50', ratio: '1:50', scaleFactor: 20 },
  { label: '1:100', ratio: '1:100', scaleFactor: 10 },
  { label: '1:200', ratio: '1:200', scaleFactor: 5 },
  { label: '1:500', ratio: '1:500', scaleFactor: 2 },
  { label: '1:1000', ratio: '1:1000', scaleFactor: 1 },
];

export function getScaleLabel(scaleFactor: number = 20): string {
  const match = STANDARD_SCALES.find((s) => Math.abs(s.scaleFactor - scaleFactor) < 0.01);
  if (match) return match.label;
  if (scaleFactor === 1.0) return '1:1000';
  if (scaleFactor > 0) {
    const denom = Math.round(1000 / scaleFactor);
    return `1:${denom}`;
  }
  return '1:50';
}
