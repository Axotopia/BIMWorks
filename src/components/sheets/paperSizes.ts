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
  defaultMarginMm?: number;
  description: string;
}

/**
 * Standard paper sizes supported by BIMWorks (aligned with IfcSheet standards).
 * Base dimensions are given in landscape.
 */
export const PAPER_SIZES: Record<SheetPaperSize, PaperSizeSpec> = {
  // ISO A-Series
  ISO_A0: {
    id: 'ISO_A0',
    name: 'ISO A0',
    category: 'ISO',
    width: 1400,
    height: 990,
    widthMm: 1189.0,
    heightMm: 841.0,
    defaultMarginMm: 20,
    description: '841 × 1189 mm (33.1" × 46.8")',
  },
  ISO_A1: {
    id: 'ISO_A1',
    name: 'ISO A1',
    category: 'ISO',
    width: 1056,
    height: 746,
    widthMm: 841.0,
    heightMm: 594.0,
    defaultMarginMm: 20,
    description: '594 × 841 mm (23.4" × 33.1")',
  },
  ISO_A2: {
    id: 'ISO_A2',
    name: 'ISO A2',
    category: 'ISO',
    width: 841,
    height: 594,
    widthMm: 594.0,
    heightMm: 420.0,
    defaultMarginMm: 15,
    description: '420 × 594 mm (16.5" × 23.4")',
  },
  ISO_A3: {
    id: 'ISO_A3',
    name: 'ISO A3',
    category: 'ISO',
    width: 594,
    height: 420,
    widthMm: 420.0,
    heightMm: 297.0,
    defaultMarginMm: 10,
    description: '297 × 420 mm (11.7" × 16.5")',
  },
  ISO_A4: {
    id: 'ISO_A4',
    name: 'ISO A4',
    category: 'ISO',
    width: 420,
    height: 297,
    widthMm: 297.0,
    heightMm: 210.0,
    defaultMarginMm: 10,
    description: '210 × 297 mm (8.3" × 11.7")',
  },

  // US ANSI Series
  ANSI_A: {
    id: 'ANSI_A',
    name: 'ANSI A / Letter',
    category: 'ANSI',
    width: 792,
    height: 612,
    widthMm: 279.4,
    heightMm: 215.9,
    defaultMarginMm: 10,
    description: '8.5" × 11" (216 × 279 mm)',
  },
  LETTER: {
    id: 'LETTER',
    name: 'Letter (ANSI A)',
    category: 'ANSI',
    width: 792,
    height: 612,
    widthMm: 279.4,
    heightMm: 215.9,
    defaultMarginMm: 10,
    description: '8.5" × 11" (216 × 279 mm)',
  },
  LEGAL: {
    id: 'LEGAL',
    name: 'Legal',
    category: 'ANSI',
    width: 850,
    height: 550,
    widthMm: 355.6,
    heightMm: 215.9,
    defaultMarginMm: 10,
    description: '8.5" × 14" (216 × 356 mm)',
  },
  ANSI_B: {
    id: 'ANSI_B',
    name: 'ANSI B / Tabloid',
    category: 'ANSI',
    width: 792,
    height: 612,
    widthMm: 431.8,
    heightMm: 279.4,
    defaultMarginMm: 15,
    description: '11" × 17" (279 × 432 mm)',
  },
  TABLOID: {
    id: 'TABLOID',
    name: 'Tabloid (ANSI B)',
    category: 'ANSI',
    width: 792,
    height: 612,
    widthMm: 431.8,
    heightMm: 279.4,
    defaultMarginMm: 15,
    description: '11" × 17" (279 × 432 mm)',
  },
  ANSI_C: {
    id: 'ANSI_C',
    name: 'ANSI C',
    category: 'ANSI',
    width: 880,
    height: 680,
    widthMm: 558.8,
    heightMm: 431.8,
    defaultMarginMm: 15,
    description: '17" × 22" (432 × 559 mm)',
  },
  ANSI_D: {
    id: 'ANSI_D',
    name: 'ANSI D',
    category: 'ANSI',
    width: 1056,
    height: 704,
    widthMm: 863.6,
    heightMm: 558.8,
    defaultMarginMm: 20,
    description: '22" × 34" (559 × 864 mm)',
  },
  ANSI_E: {
    id: 'ANSI_E',
    name: 'ANSI E',
    category: 'ANSI',
    width: 1408,
    height: 1088,
    widthMm: 1117.6,
    heightMm: 863.6,
    defaultMarginMm: 20,
    description: '34" × 44" (864 × 1118 mm)',
  },

  // ARCH Series (Architectural)
  ARCH_A: {
    id: 'ARCH_A',
    name: 'ARCH A',
    category: 'ARCH',
    width: 576,
    height: 432,
    widthMm: 304.8,
    heightMm: 228.6,
    defaultMarginMm: 10,
    description: '9" × 12" (229 × 305 mm)',
  },
  ARCH_B: {
    id: 'ARCH_B',
    name: 'ARCH B',
    category: 'ARCH',
    width: 720,
    height: 480,
    widthMm: 457.2,
    heightMm: 304.8,
    defaultMarginMm: 15,
    description: '12" × 18" (305 × 457 mm)',
  },
  ARCH_C: {
    id: 'ARCH_C',
    name: 'ARCH C',
    category: 'ARCH',
    width: 864,
    height: 576,
    widthMm: 609.6,
    heightMm: 457.2,
    defaultMarginMm: 15,
    description: '18" × 24" (457 × 610 mm)',
  },
  ARCH_D: {
    id: 'ARCH_D',
    name: 'ARCH D',
    category: 'ARCH',
    width: 1056,
    height: 704,
    widthMm: 914.4,
    heightMm: 609.6,
    defaultMarginMm: 20,
    description: '24" × 36" (610 × 914 mm)',
  },
  ARCH_E: {
    id: 'ARCH_E',
    name: 'ARCH E',
    category: 'ARCH',
    width: 1440,
    height: 1080,
    widthMm: 1219.2,
    heightMm: 914.4,
    defaultMarginMm: 20,
    description: '36" × 48" (914 × 1219 mm)',
  },
  ARCH_E1: {
    id: 'ARCH_E1',
    name: 'ARCH E1',
    category: 'ARCH',
    width: 1260,
    height: 900,
    widthMm: 1066.8,
    heightMm: 762.0,
    defaultMarginMm: 20,
    description: '30" × 42" (762 × 1067 mm)',
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
