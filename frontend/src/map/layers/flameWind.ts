/**
 * Wind for the hotspot flames: which way, and how hard, the air pushes the
 * flame tips at the playhead. One wind for the whole fire, sampled at its
 * origin — the same point the timeline's weather strip reads — so the lean
 * always agrees with the strip. At the present, HRRR (the wind arrows' grid)
 * takes over when its run covers the current hour.
 */
import type { HourlyWeather } from '../../timeline/weatherStripModel';

export interface PointWind {
  mph: number;
  /** Meteorological: the direction the wind blows FROM, degrees clockwise from north. */
  fromDeg: number;
}

/** The fire layer's wind option; `strength` 0..1 scales how far the tips lean. */
export interface FlameWindOption {
  from: number;
  strength: number;
}

const MS_TO_MPH = 2.23694;
const DEG = Math.PI / 180;

/** Wind speed at which the flames lean their furthest (strength 1). */
export const FULL_LEAN_MPH = 30;

/** How close to `now` counts as the present: the store's live-pin window. */
export const PRESENT_WINDOW_MS = 2 * 60_000;

/** The strip's hours are 1 h apart; past either end, hold the edge hour this long. */
const EDGE_TOLERANCE_MS = 90 * 60_000;

export function isAtPresent(currentTime: number, now: number): boolean {
  return Math.abs(currentTime - now) < PRESENT_WINDOW_MS;
}

/** HRRR U/V (m/s; u east+, v north+) → speed and meteorological FROM direction. */
export function windFromUv(u: number, v: number): PointWind {
  // The air moves toward atan2(u, v); it comes FROM the opposite bearing.
  const toward = Math.atan2(u, v) / DEG;
  return { mph: Math.hypot(u, v) * MS_TO_MPH, fromDeg: (toward + 180 + 360) % 360 };
}

/**
 * The strip's hourly wind at time t, interpolated between the bracketing hours
 * as a vector, so a shift from 350° to 10° turns through north, not south.
 * Null when t is off the data (beyond EDGE_TOLERANCE_MS of either end).
 */
export function windAtTime(
  hours: readonly HourlyWeather[] | undefined,
  t: number,
): PointWind | null {
  if (!hours?.length) return null;
  const first = hours[0];
  const last = hours[hours.length - 1];
  if (t < first.t - EDGE_TOLERANCE_MS || t > last.t + EDGE_TOLERANCE_MS) return null;
  if (t <= first.t) return { mph: first.windMph, fromDeg: first.windFromDeg };
  if (t >= last.t) return { mph: last.windMph, fromDeg: last.windFromDeg };

  let lo = 0;
  let hi = hours.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (hours[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = hours[lo];
  const b = hours[hi];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const x = a.windMph * Math.sin(a.windFromDeg * DEG) * (1 - f) + b.windMph * Math.sin(b.windFromDeg * DEG) * f;
  const y = a.windMph * Math.cos(a.windFromDeg * DEG) * (1 - f) + b.windMph * Math.cos(b.windFromDeg * DEG) * f;
  return { mph: Math.hypot(x, y), fromDeg: (Math.atan2(x, y) / DEG + 360) % 360 };
}

/** Wind → the fire layer's option. Calm (or unknown) air leaves the flames upright. */
export function flameWindOption(w: PointWind | null): FlameWindOption | null {
  if (!w || !(w.mph > 0)) return null;
  return { from: w.fromDeg, strength: Math.min(1, w.mph / FULL_LEAN_MPH) };
}

/** Whether two options would look the same (within 1° and 1% of full lean). */
export function sameFlameWind(a: FlameWindOption | null, b: FlameWindOption | null): boolean {
  if (!a || !b) return a === b;
  const turn = Math.abs(((a.from - b.from + 540) % 360) - 180);
  return turn < 1 && Math.abs(a.strength - b.strength) < 0.01;
}
