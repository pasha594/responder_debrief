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
  /** VERBATIM instant string — Date.parse of it is the frame's {epoch_ms}. */
  instant: string;
  index: number;
}

/**
 * The instants that actually exist as pre-rendered frames: the run's thinned
 * frames.instants when present, else the verbatim time_instants (older
 * catalogs). Both are VERBATIM ISO strings — first instant has minute
 * precision, never do hour arithmetic.
 */
export function spreadInstants(run: PyrecastRun | null): string[] {
  if (!run) return [];
  return run.frames?.instants?.length ? run.frames.instants : (run.time_instants ?? []);
}

/**
 * Nearest instant <= t among the run's renderable instants (binary search).
 * Null when t is outside the run's coverage (before first instant) or the
 * product is static.
 */
export function resolveSpreadFrame(run: PyrecastRun | null, t: number): SpreadFrame | null {
  const instants = spreadInstants(run);
  if (!instants.length) return null;
  const times = instants.map((s) => Date.parse(s));
  const i = lastIndexLE(times, t);
  if (i < 0) return null;
  return { instant: instants[i], index: i };
}

/** Is t within [first instant, last instant] of the run? */
export function spreadCoverage(run: PyrecastRun | null): [number, number] | null {
  const instants = spreadInstants(run);
  if (!instants.length) return null;
  return [Date.parse(instants[0]), Date.parse(instants[instants.length - 1])];
}

// ---------- Weather ----------

export interface WeatherFrame {
  hourIso: string;
  index: number;
}

/**
 * The hours that actually exist as pre-rendered frames: frames.hours when
 * present (hours actually rendered — may lag `hours` while a run is
 * budget-limited), else the run's full hour list (older catalogs).
 */
export function weatherHours(run: WeatherRun | null): string[] {
  if (!run) return [];
  return run.frames?.hours?.length ? run.frames.hours : (run.hours ?? []);
}

/**
 * Nearest rendered hour within tolerance (90 min), else null (layer hides +
 * chip). Weather frames are per-hour image swaps.
 */
export function resolveWeatherFrame(run: WeatherRun | null, t: number): WeatherFrame | null {
  const hours = weatherHours(run);
  if (!hours.length) return null;
  const times = hours.map((s) => Date.parse(s));
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
  return { hourIso: hours[best], index: best };
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
  if (input.spreadActive) {
    for (const s of spreadInstants(input.spreadRun)) {
      const ts = Date.parse(s);
      if (ts >= input.from && ts <= input.to) set.add(ts);
    }
  }
  if (input.weatherActive) {
    for (const s of weatherHours(input.weatherRun)) {
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
