/**
 * Discrete hours-to-arrival bands for WHOLE-PREDICTION time-of-arrival mode.
 *
 * Timeline mode (paintToa) answers "what has burned as of the playhead".
 * Whole mode answers "how long until the fire reaches here", for the entire
 * run at once, independent of the playhead: every pixel is filled with the
 * color of the band its arrival hour falls in — a banded contour map, not a
 * smooth gradient, so the contours stay legible over the basemap.
 *
 * Pure data + math only (no DOM, no geotiff): the renderer imports it for the
 * RGBA table, the panels import it for the legend swatches and slider stops,
 * and both stay in lockstep because there is exactly one band table.
 */

export interface ToaBand {
  /** Inclusive upper bound of the band, in hours since run start. */
  hours: number;
  /** CSS hex (#rrggbb) painted for the band and shown in its legend swatch. */
  color: string;
}

/**
 * Cool → warm ramp: the ignition core (soonest) is dark blue, mid hours pass
 * through pale blue into cream, and the far edge of the forecast runs orange
 * → deep red. Ordered by ascending upper bound; `toaBandIndex` depends on it.
 */
export const TOA_BANDS: readonly ToaBand[] = [
  { hours: 12, color: '#08306b' },
  { hours: 24, color: '#2171b5' },
  { hours: 48, color: '#6baed6' },
  { hours: 72, color: '#c6dbef' },
  { hours: 96, color: '#fdf4e3' },
  { hours: 120, color: '#fdd0a2' },
  { hours: 168, color: '#fdae6b' },
  { hours: 240, color: '#e6550d' },
  { hours: 336, color: '#a63603' },
];

/** Fill alpha for every band (the layer's opacity slider multiplies this). */
export const TOA_BAND_ALPHA = 0.75;

/** Whole-mode default reach, before clamping to the run's horizon. */
export const TOA_DEFAULT_WITHIN_HOURS = 240;

/**
 * Index of the band an arrival hour falls in: the FIRST band whose upper
 * bound is >= hours. Boundaries are inclusive-upper, so exactly 24 h is the
 * ≤24 band, not ≤48. Values past the last bound clamp into the last band.
 */
export function toaBandIndex(hours: number): number {
  for (let i = 0; i < TOA_BANDS.length; i++) {
    if (hours <= TOA_BANDS[i].hours) return i;
  }
  return TOA_BANDS.length - 1;
}

/** The band an arrival hour falls in. */
export function toaBandFor(hours: number): ToaBand {
  return TOA_BANDS[toaBandIndex(hours)];
}

/**
 * Bands that can actually contain a value inside a run of `horizonHours`:
 * every band whose lower edge is short of the horizon. The last one is
 * relabeled down to the horizon (a 169 h run's top band reads "≤169h", not
 * "≤240h") so the legend never promises reach the run does not have.
 */
export function toaLegendBands(horizonHours: number): ToaBand[] {
  const h = horizonFor(horizonHours);
  const out: ToaBand[] = [];
  for (let i = 0; i < TOA_BANDS.length; i++) {
    const lower = i === 0 ? 0 : TOA_BANDS[i - 1].hours;
    if (lower >= h) break;
    out.push({ hours: Math.min(TOA_BANDS[i].hours, h), color: TOA_BANDS[i].color });
  }
  return out.length ? out : [{ hours: h, color: TOA_BANDS[0].color }];
}

/**
 * Slider stops for "show arrival within": the band bounds, clamped to the
 * run's horizon. The horizon itself is always the top stop (so the slider can
 * show the whole prediction), and any band bound within 12 h of it is dropped
 * rather than sitting a hair below the top.
 */
export function toaWithinStops(horizonHours: number): number[] {
  const h = horizonFor(horizonHours);
  const stops = TOA_BANDS.map((b) => b.hours).filter((v) => v < h - 12);
  stops.push(h);
  return stops;
}

/** Snap an arbitrary hour value to the nearest stop offered for this run. */
export function clampWithinHours(within: number, horizonHours: number): number {
  const stops = toaWithinStops(horizonHours);
  if (!Number.isFinite(within)) return stops[stops.length - 1];
  let best = stops[0];
  let bestDist = Infinity;
  for (const s of stops) {
    const d = Math.abs(s - within);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/** Default reach for a run: min(240 h, horizon), snapped to a real stop. */
export function defaultWithinHours(horizonHours: number): number {
  return clampWithinHours(
    Math.min(TOA_DEFAULT_WITHIN_HOURS, horizonFor(horizonHours)),
    horizonHours,
  );
}

/** "≤24h" — band + slider labels share one formatter. */
export function formatBandLabel(hours: number): string {
  return `≤${Math.round(hours)}h`;
}

/** Non-finite / non-positive horizons fall back to the full band range. */
function horizonFor(horizonHours: number): number {
  if (!Number.isFinite(horizonHours) || horizonHours <= 0) {
    return TOA_BANDS[TOA_BANDS.length - 1].hours;
  }
  return Math.round(horizonHours);
}
