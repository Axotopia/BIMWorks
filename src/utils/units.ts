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
 * Parses user input into decimal feet, or `null` when the text is not a length.
 *
 * UI-P0-2/UI-P1-5: the in-canvas editors used `parseFloat`, so in an
 * imperial-fractional project (the default) typing what the app itself displays —
 * `12'-6"` — produced NaN and the edit was silently discarded. Returning `null`
 * rather than 0 for garbage also lets the caller keep the editor open and say so,
 * which the old "0 means empty means fine" contract could not express.
 *
 * Accepted (all unambiguous, so a unit suffix is never guessed):
 * - `12.5'` or `12.5 ft`  -> decimal feet
 * - `12'-6"`, `12' 6"`, `12' 6 1/2"`, `12-6`  -> feet and inches
 * - `30"`                 -> inches only
 * - `3800 mm`, `3.8 m`    -> metric, converted
 * - `12.5`                -> bare number is decimal feet (the internal unit)
 */
export function tryParseLength(input: string): number | null {
  if (input == null) return null;
  const str = String(input).trim().toLowerCase();
  if (!str) return null;

  // Metric, longest suffix first so "mm" is not read as "m".
  const metric = str.match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*(mm|cm|m)\b/);
  if (metric) {
    const value = parseFloat(metric[1]);
    if (!isFinite(value)) return null;
    if (metric[2] === 'mm') return mmToFeet(value);
    if (metric[2] === 'cm') return mmToFeet(value * 10);
    return metersToFeet(value);
  }

  // Imperial with an explicit foot mark: HH'-II[ F/D]"
  const feetInches = str.match(
    /^([+-]?\d+(?:\.\d+)?)\s*'\s*(?:-\s*)?(?:(\d+(?:\.\d+)?)(?:\s+(\d+)\s*\/\s*(\d+))?\s*"?)?$/
  );
  if (feetInches) {
    const feet = parseFloat(feetInches[1]);
    const inches = feetInches[2] ? parseFloat(feetInches[2]) : 0;
    const num = feetInches[3] ? parseFloat(feetInches[3]) : 0;
    const den = feetInches[4] ? parseFloat(feetInches[4]) : 1;
    if (!isFinite(feet) || !isFinite(inches) || den === 0) return null;
    const sign = feet < 0 || str.startsWith('-') ? -1 : 1;
    return sign * (Math.abs(feet) + (inches + (den ? num / den : 0)) / 12);
  }

  // A run of numbers separated by a dash or spaces, as Revit accepts: 12-6, 12 6, 12 6 1/2
  const fraction = str.match(/^([+-]?\d+(?:\.\d+)?)(?:[\s-]+(\d+(?:\.\d+)?))?(?:[\s-]+(\d+)\s*\/\s*(\d+))?$/);
  if (fraction && !str.includes("'") && !str.includes('"')) {
    const whole = parseFloat(fraction[1]);
    const inches = fraction[2] ? parseFloat(fraction[2]) : 0;
    const num = fraction[3] ? parseFloat(fraction[3]) : 0;
    const den = fraction[4] ? parseFloat(fraction[4]) : 1;
    if (!isFinite(whole)) return null;
    if (den === 0) return null;
    // Two-part input with nothing after it is feet-inches ("12 6" = 12'-6").
    if (fraction[2] !== undefined) {
      const sign = whole < 0 ? -1 : 1;
      return sign * (Math.abs(whole) + (inches + (num || 0) / den) / 12);
    }
    return whole;
  }

  // Inches only: 30"
  const inchesOnly = str.match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*"$/);
  if (inchesOnly) {
    const value = parseFloat(inchesOnly[1]);
    return isFinite(value) ? value / 12 : null;
  }

  // Explicit decimal feet: 12.5 ft
  const feetOnly = str.match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*(?:ft|feet|')$/);
  if (feetOnly) {
    const value = parseFloat(feetOnly[1]);
    return isFinite(value) ? value : null;
  }

  // Bare number: decimal feet, the internal unit.
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(str)) {
    const value = parseFloat(str);
    return isFinite(value) ? value : null;
  }

  return null;
}

/**
 * Convenience wrapper that keeps the legacy "always a number" contract.
 *
 * The engine's internal unit is decimal feet, so a bare number means decimal feet.
 * Prefer `tryParseLength` in any new UI so invalid input can be reported rather
 * than silently becoming zero.
 */
export function parseLength(input: string): number {
  const parsed = tryParseLength(input);
  return parsed === null ? 0 : parsed;
}
