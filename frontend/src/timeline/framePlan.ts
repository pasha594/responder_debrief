/**
 * Snapping resolvers — the correctness heart of the timeline. Pure functions
 * from (data, currentTime) → the frame each layer should show. All math is in
 * epoch-ms time-space; the track's nonlinear scale is presentation-only.
 */
import { WEATHER_SNAP_TOLERANCE_MS } from '../app/config';
import type { PerimeterIndexItem, PyrecastRun, WeatherRun } from '../api/types';

/** Largest index i such that arr[i] <= target, or -1. Binary search. */
export function lastIndexLE(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

// ---------- Perimeter ----------

/**
 * Latest version with date <= t (step function; holds latest for t > now).
 * Returns the index item (fetch via its verbatim `path`), or null if t is
 * before the first version.
 */
export function resolvePerimeterVersion(
  index: PerimeterIndexItem[] | undefined,
  t: number,
): PerimeterIndexItem | null {
  if (!index?.length) return null;
  // Index is sorted ascending by date (API contract).
  const times = index.map((it) => Date.parse(it.date));
  const i = lastIndexLE(times, t);
  return i >= 0 ? index[i] : null;
}

// ---------- Spread forecast ----------

export interface SpreadFrame {
  /** VERBATIM instant string for the WMS time= param. */
  instant: string;
  index: number;
}

/**
 * Nearest instant <= t from the run's verbatim time_instants (first instant
 * has minute precision — never do hour arithmetic). Null when t is outside
 * the run's coverage (before first instant) or the product is static.
 */
export function resolveSpreadFrame(run: PyrecastRun | null, t: number): SpreadFrame | null {
  if (!run?.time_instants?.length) return null;
  const times = run.time_instants.map((s) => Date.parse(s));
  const i = lastIndexLE(times, t);
  if (i < 0) return null;
  return { instant: run.time_instants[i], index: i };
}

/** Is t within [first instant, last instant] of the run? */
export function spreadCoverage(run: PyrecastRun | null): [number, number] | null {
  if (!run?.time_instants?.length) return null;
  return [
    Date.parse(run.time_instants[0]),
    Date.parse(run.time_instants[run.time_instants.length - 1]),
  ];
}

// ---------- Weather ----------

export interface WeatherFrame {
  hourIso: string;
  index: number;
}

/**
 * Nearest hour within tolerance (90 min), else null (layer hides + chip).
 * Weather frames are layer-name swaps, not TIME params.
 */
export function resolveWeatherFrame(run: WeatherRun | null, t: number): WeatherFrame | null {
  if (!run?.hours?.length) return null;
  const times = run.hours.map((s) => Date.parse(s));
  // nearest, not just <=
  const i = lastIndexLE(times, t);
  const candidates: number[] = [];
  if (i >= 0) candidates.push(i);
  if (i + 1 < times.length) candidates.push(i + 1);
  let best = -1;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(times[c] - t);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  if (best < 0 || bestDist > WEATHER_SNAP_TOLERANCE_MS) return null;
  return { hourIso: run.hours[best], index: best };
}

// ---------- Frame plan for playback ----------

export interface FramePlanInput {
  spreadRun: PyrecastRun | null;
  spreadActive: boolean;
  weatherRun: WeatherRun | null;
  weatherActive: boolean;
  from: number;
  to: number;
}

/**
 * Sorted union of active layers' frame times clipped to [from, to]; hourly
 * fallback when only past layers (perimeter/hotspots) are active — their
 * updates are cheap and continuous.
 */
export function buildFrameTimes(input: FramePlanInput): number[] {
  const set = new Set<number>();
  if (input.spreadActive && input.spreadRun?.time_instants) {
    for (const s of input.spreadRun.time_instants) {
      const ts = Date.parse(s);
      if (ts >= input.from && ts <= input.to) set.add(ts);
    }
  }
  if (input.weatherActive && input.weatherRun?.hours) {
    for (const s of input.weatherRun.hours) {
      const ts = Date.parse(s);
      if (ts >= input.from && ts <= input.to) set.add(ts);
    }
  }
  if (set.size === 0) {
    const HOUR = 3600_000;
    for (let ts = Math.ceil(input.from / HOUR) * HOUR; ts <= input.to; ts += HOUR) set.add(ts);
  }
  return [...set].sort((a, b) => a - b);
}
