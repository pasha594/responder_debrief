/**
 * Dual-unit map scale math (pure — panels/ScaleBar.tsx owns the DOM). Given
 * the ground distance spanned by the widest bar we allow, pick a round
 * distance per unit system and the bar width that represents it. Same
 * rounding ladder as MapLibre's own ScaleControl (1 / 2 / 3 / 5 × 10ⁿ), so a
 * bar is never shorter than half the max width.
 */

export type ScaleUnit = 'ft' | 'mi' | 'm' | 'km';

export interface ScaleReading {
  value: number;
  unit: ScaleUnit;
  /** "5 mi", "2,000 ft" */
  label: string;
  widthPx: number;
}

export interface ScaleReadings {
  imperial: ScaleReading;
  metric: ScaleReading;
}

const FT_PER_M = 3.28084;
const FT_PER_MI = 5280;
const M_PER_KM = 1000;

/** Largest 1 / 2 / 3 / 5 × 10ⁿ that does not exceed `n` (n > 0). */
export function roundDistance(n: number): number {
  const pow10 = 10 ** Math.floor(Math.log10(n));
  const d = n / pow10;
  const step = d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1;
  // pow10 < 1 only below one unit (never at this map's zoom range); the
  // round-trip through toPrecision keeps 0.3 from printing as 0.30000000000000004
  return Number((step * pow10).toPrecision(1));
}

function reading(max: number, unit: ScaleUnit, maxWidthPx: number): ScaleReading {
  const value = roundDistance(max);
  return {
    value,
    unit,
    label: `${value.toLocaleString('en-US')} ${unit}`,
    widthPx: Math.round(maxWidthPx * (value / max)),
  };
}

/**
 * `maxMeters` is the ground distance across `maxWidthPx` screen pixels.
 * Imperial reads in feet up to a mile, then miles; metric in meters up to a
 * kilometer, then kilometers.
 */
export function scaleReadings(maxMeters: number, maxWidthPx: number): ScaleReadings | null {
  if (!Number.isFinite(maxMeters) || maxMeters <= 0 || maxWidthPx <= 0) return null;
  const maxFeet = maxMeters * FT_PER_M;
  return {
    imperial:
      maxFeet > FT_PER_MI
        ? reading(maxFeet / FT_PER_MI, 'mi', maxWidthPx)
        : reading(maxFeet, 'ft', maxWidthPx),
    metric:
      maxMeters >= M_PER_KM
        ? reading(maxMeters / M_PER_KM, 'km', maxWidthPx)
        : reading(maxMeters, 'm', maxWidthPx),
  };
}
