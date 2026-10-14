/**
 * BIMWorks - Units & Measurement Engine
 * Complies with GLM Master Specification v2 §11:
 * Internal unit is DECIMAL FEET (matches Revit's internal double representation).
 * Converts to/from Fractional Imperial, Decimal Imperial, and Metric (mm / m).
 */

export type UnitSystem =
  | 'imperial_fractional' // e.g. 12' - 6 1/2"
  | 'imperial_decimal'    // e.g. 12.54'
  | 'metric_mm'           // e.g. 3820 mm
  | 'metric_m';           // e.g. 3.82 m

export const FEET_TO_METERS = 0.3048;
export const METERS_TO_FEET = 1 / FEET_TO_METERS; // 3.280839895
export const FEET_TO_MM = 304.8;
export const MM_TO_FEET = 1 / FEET_TO_MM;

/** Converts decimal feet to meters */
export function feetToMeters(feet: number): number {
  return feet * FEET_TO_METERS;
}

/** Converts meters to decimal feet */
export function metersToFeet(meters: number): number {
  return meters * METERS_TO_FEET;
}

/** Converts decimal feet to millimeters */
export function feetToMm(feet: number): number {
  return feet * FEET_TO_MM;
}

/** Converts millimeters to decimal feet */
export function mmToFeet(mm: number): number {
  return mm * MM_TO_FEET;
}

/**
 * Formats a decimal feet measurement according to the specified display style.
 */
export function formatLength(feet: number, system: UnitSystem = 'imperial_fractional'): string {
  if (isNaN(feet)) return '0"';

  const isNegative = feet < 0;
  const absFeet = Math.abs(feet);

  if (system === 'metric_mm') {
    const mm = Math.round(absFeet * FEET_TO_MM);
    return `${isNegative ? '-' : ''}${mm} mm`;
  }

  if (system === 'metric_m') {
    const m = (absFeet * FEET_TO_METERS).toFixed(2);
    return `${isNegative ? '-' : ''}${m} m`;
  }

  if (system === 'imperial_decimal') {
    return `${isNegative ? '-' : ''}${absFeet.toFixed(2)}'`;
  }

  // Default: imperial_fractional (Revit architectural standard)
  const totalInches = absFeet * 12;
  const wholeFeet = Math.floor(totalInches / 12);
  const remainingInches = totalInches - wholeFeet * 12;
  const wholeInches = Math.floor(remainingInches);
  const frac = remainingInches - wholeInches;

  // Round fraction to nearest 1/16th
  const sixteenths = Math.round(frac * 16);
  let fracStr = '';

  if (sixteenths === 16) {
    return formatLength(isNegative ? -(absFeet + 1 / 12) : absFeet + 1 / 12, 'imperial_fractional');
  } else if (sixteenths > 0) {
    if (sixteenths % 8 === 0) {
      fracStr = `${sixteenths / 8}/2"`;
    } else if (sixteenths % 4 === 0) {
      fracStr = `${sixteenths / 4}/4"`;
    } else if (sixteenths % 2 === 0) {
      fracStr = `${sixteenths / 2}/8"`;
    } else {
      fracStr = `${sixteenths}/16"`;
    }
  }

  const sign = isNegative ? '-' : '';

  if (wholeFeet === 0) {
    if (fracStr) {
      return wholeInches > 0 ? `${sign}${wholeInches} ${fracStr}` : `${sign}${fracStr}`;
    }
    return `${sign}${wholeInches}"`;
  }

  if (wholeInches === 0 && !fracStr) {
    return `${sign}${wholeFeet}'-0"`;
  }

  if (fracStr) {
    return `${sign}${wholeFeet}' - ${wholeInches} ${fracStr}`;
  }

  return `${sign}${wholeFeet}' - ${wholeInches}"`;
}

/**
 * Formats a decimal-feet² area according to the specified display style.
 */
export function formatArea(squareFeet: number, system: UnitSystem = 'imperial_fractional'): string {
  if (!isFinite(squareFeet)) return '—';
  if (system === 'metric_mm' || system === 'metric_m') {
    return `${(squareFeet * FEET_TO_METERS * FEET_TO_METERS).toFixed(2)} m²`;
  }
  return `${squareFeet.toFixed(2)} ft²`;
}

/**
 * Formats a decimal-feet³ volume according to the specified display style.
 */
export function formatVolume(cubicFeet: number, system: UnitSystem = 'imperial_fractional'): string {
  if (!isFinite(cubicFeet)) return '—';
  if (system === 'metric_mm' || system === 'metric_m') {
    return `${(cubicFeet * FEET_TO_METERS ** 3).toFixed(3)} m³`;
  }
  return `${cubicFeet.toFixed(2)} ft³`;
}

/**
 * Parses user input strings into decimal feet.
 * Examples accepted:
 * - "12' 6"" -> 12.5
 * - "12-6" -> 12.5
 * - "12.5" / "12.5'" -> 12.5
 * - "3800mm" -> ~12.467
 * - "3.8m" -> ~12.467
 */
export function parseLength(input: string): number {
  if (!input) return 0;
  const str = input.trim().toLowerCase();

  // Metric mm
  if (str.endsWith('mm')) {
    const val = parseFloat(str.replace('mm', '').trim());
    return isNaN(val) ? 0 : mmToFeet(val);
  }

  // Metric meters
  if (str.endsWith('m') && !str.endsWith('mm')) {
    const val = parseFloat(str.replace('m', '').trim());
    return isNaN(val) ? 0 : metersToFeet(val);
  }

  // Decimal feet with apostrophe: "12.5'"
  if (str.endsWith("'") && !str.includes('"') && !str.includes(' ')) {
    const val = parseFloat(str.replace("'", ''));
    return isNaN(val) ? 0 : val;
  }

  // Standard architectural: e.g. 12' 6 1/2" or 12'-6" or 12-6
  const archMatch = str.match(/^([+-]?\d+)?(?:'|-)?\s*(?:([0-9.]+)(?:\s+([0-9]+)\/([0-9]+))?)?"?$/);
  if (archMatch) {
    const feet = archMatch[1] ? parseFloat(archMatch[1]) : 0;
    const inches = archMatch[2] ? parseFloat(archMatch[2]) : 0;
    const num = archMatch[3] ? parseFloat(archMatch[3]) : 0;
    const den = archMatch[4] ? parseFloat(archMatch[4]) : 1;
    const fracInches = den > 0 ? num / den : 0;
    return feet + (inches + fracInches) / 12;
  }

  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}
