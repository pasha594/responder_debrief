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

/**
 * Coverage of a v2 archive run: [run_time, run_time + horizon_hours]. Spread
 * renders CONTINUOUSLY inside this window (client-side decode — no frame
 * snapping); the timeline's fire-mode end derives from it.
 */
export function spreadCoverage(run: PyrecastRun | null): [number, number] | null {
  if (!run) return null;
  const start = Date.parse(run.run_time);
  const horizon = run.horizon_hours;
  if (!Number.isFinite(start) || !Number.isFinite(horizon) || horizon <= 0) return null;
  return [start, start + horizon * 3600_000];
}

/**
 * Hourly playback ticks run_start .. run_start + horizon (run-anchored, so a
 * minute-precision run start like 11:25 steps 11:25, 12:25, …), clipped to
 * [from, to].
 */
export function spreadHourTicks(run: PyrecastRun | null, from: number, to: number): number[] {
  const cov = spreadCoverage(run);
  if (!cov) return [];
  const HOUR = 3600_000;
  const out: number[] = [];
  for (let ts = cov[0]; ts <= cov[1]; ts += HOUR) {
    if (ts >= from && ts <= to) out.push(ts);
  }
  return out;
}

// ---------- Weather ----------

export interface WeatherFrame {
  hourIso: string;
  index: number;
}

/**
 * The hours that actually exist as pre-rendered frames: frames.hours when the
 * block is present (hours actually rendered — may lag `hours` while a run is
 * budget-limited, and may be EMPTY when a GDAL-skipped sync published the run
 * before rendering anything), else the run's full hour list (older catalogs
 * that predate the frames block). Never guess hours the worker didn't render:
 * that 404s every frame.
 */
export function weatherHours(run: WeatherRun | null): string[] {
  if (!run) return [];
  return run.frames ? (run.frames.hours ?? []) : (run.hours ?? []);
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
 * updates are cheap and continuous. Spread contributes hourly ticks over its
 * coverage (rendering itself is continuous; the ticks just pace playback).
 */
export function buildFrameTimes(input: FramePlanInput): number[] {
  const set = new Set<number>();
  if (input.spreadActive) {
    for (const ts of spreadHourTicks(input.spreadRun, input.from, input.to)) set.add(ts);
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
