/**
 * Travel-time model for offline Walk (pure math; docs/trails-routing/
 * FINAL_PLAN.md, research/offtrail_travel_science.md).
 *
 * On roads and trails: Sullivan et al. 2020 — Lorentz fits to GPS tracks of
 * hotshot crews carrying ~50 lb — on the DIRECTIONAL grade, with low /
 * moderate / high tertiles: moderate is the typical time, high the fast end,
 * low the slow end. OSM sac_scale adds Valhalla's multipliers.
 *
 * Cross-country: the worker bakes GET v2 (USFS Ground Evacuation Time v2)
 * into each cell's pace — its isotropic rate on TERRAIN slope times the
 * vegetation multipliers — so contouring a steep sidehill is slow, as GET
 * intends. The only directional term added here is α(θ), a round-trip-
 * preserving uphill/downhill factor from the Sullivan moderate curve:
 * (α(θ) + α(−θ)) / 2 = 1, so an out-and-back keeps GET's time.
 *
 * Every rate is over HORIZONTAL distance (how the studies define them).
 * All costs are seconds of typical time.
 */

interface Lorentz { a: number; b: number; c: number; d: number; e: number }

export const SULLIVAN: Record<'low' | 'mod' | 'high', Lorentz> = {
  low: { a: -3.3717, b: 25.8255, c: 92.6594, d: -0.1624, e: 0.0019 },
  mod: { a: -2.8292, b: 20.9482, c: 77.6346, d: 0.2228, e: -0.0004 },
  high: { a: -2.2893, b: 19.4024, c: 65.3577, d: 0.6226, e: -0.002 },
};

const MAX_GRADE = 40;
const MIN_RATE = 0.1;

/** Sullivan rate (m/s, horizontal) at directional grade θ° (+ uphill). */
export function sullivanRate(theta: number, k: 'low' | 'mod' | 'high' = 'mod'): number {
  const p = SULLIVAN[k];
  const t = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, theta));
  const r = p.c / (Math.PI * p.b * (1 + ((t - p.a) / p.b) ** 2)) + p.d + p.e * t;
  return Math.max(MIN_RATE, r);
}

/** GET v2 isotropic off-trail rate (m/s) on terrain slope σ°. */
export function getRate(slopeDeg: number): number {
  const s2 = slopeDeg * slopeDeg;
  return (0.0065 * s2 + 80.8887) / (0.1402 * s2 + 70.3892);
}

/** Round-trip-preserving directional factor for cross-country steps. */
export function alpha(theta: number): number {
  const up = 1 / sullivanRate(theta, 'mod');
  const down = 1 / sullivanRate(-theta, 'mod');
  return (2 * up) / (up + down);
}

const ALPHA_STEP = 0.5;
const ALPHA_MAX = 60;
const ALPHA_LUT = (() => {
  const n = Math.round((2 * ALPHA_MAX) / ALPHA_STEP) + 1;
  const lut = new Float64Array(n);
  for (let i = 0; i < n; i++) lut[i] = alpha(-ALPHA_MAX + i * ALPHA_STEP);
  return lut;
})();

/** α(θ) from a 0.5° LUT (the hot loop's version). */
export function alphaFast(theta: number): number {
  const t = Math.max(-ALPHA_MAX, Math.min(ALPHA_MAX, theta));
  return ALPHA_LUT[Math.round((t + ALPHA_MAX) / ALPHA_STEP)];
}

/** Fast / slow time as a multiple of the typical, for one grade. */
export function tertileRatios(theta: number): { fast: number; slow: number } {
  const m = sullivanRate(theta, 'mod');
  return { fast: m / sullivanRate(theta, 'high'), slow: m / sullivanRate(theta, 'low') };
}

/** OSM sac_scale 0..6 → time multiplier (Valhalla's). T5/T6 never reach the
 * graph (the worker drops them); kept for completeness. */
export const SAC_FACTOR = [1, 1, 1, 1.54, 2.5, 4.0, 6.67];

/** Admissible heuristic pace, s/m: below the fastest trail pace
 * (1/max r_mod ≈ 0.712) and the fastest cross-country pace (flat grass
 * 1/rGET(0) ≈ 0.870; steeper grades are slower even with α < 1). */
export const H_PACE = 0.7;

/** Directional grade in degrees from a rise over a horizontal run. */
export function gradeDeg(dz: number, dh: number): number {
  return dh > 0 ? (Math.atan2(dz, dh) * 180) / Math.PI : 0;
}
