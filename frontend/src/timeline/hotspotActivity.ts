/**
 * Hotspot activity throughline — pure. Buckets detections into FIRE-LOCAL
 * calendar days, normalizes to the busiest day, and emits the polyline/area
 * geometry the track draws behind its ticks and markers.
 *
 * "Fire-local day" is the only correct bucket: a 22:00 local detection belongs
 * to that evening even though it is already tomorrow in UTC.
 */
import type { HotspotFeatureCollection } from '../api/types';

const HOUR_MS = 3600_000;

// ---------- fire-local calendar arithmetic ----------

const partsCache = new Map<string, Intl.DateTimeFormat>();

function partsFormat(tz: string | null | undefined): Intl.DateTimeFormat {
  const key = tz ?? 'local';
  let fmt = partsCache.get(key);
  if (!fmt) {
    const opts: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    };
    try {
      fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz ?? undefined });
    } catch {
      // invalid IANA name from the API → viewer-local, same as the readout
      fmt = new Intl.DateTimeFormat('en-US', opts);
    }
    partsCache.set(key, fmt);
  }
  return fmt;
}

interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
  second: number;
}

function localParts(t: number, tz: string | null | undefined): LocalParts {
  const parts = partsFormat(tz).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // some ICU builds render midnight as "24" under h23 — fold it back
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

/** "2026-08-17" — the fire-local calendar day containing t. */
export function fireLocalDayKey(t: number, tz: string | null | undefined): string {
  const p = localParts(t, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Epoch ms of fire-local midnight opening the day that contains t. */
export function fireLocalDayStart(t: number, tz: string | null | undefined): number {
  const p = localParts(t, tz);
  const intoDay = (p.hour * 3600 + p.minute * 60 + p.second) * 1000 + (((t % 1000) + 1000) % 1000);
  return t - intoDay;
}

export interface DayCell {
  key: string;
  start: number;
  end: number;
}

/**
 * Every fire-local calendar day touching [from, to], in order. DST-safe: the
 * next boundary is re-derived from the clock, so 23h and 25h days both land.
 */
export function enumerateFireLocalDays(
  from: number,
  to: number,
  tz: string | null | undefined,
  maxDays = 400,
): DayCell[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to >= from)) return [];
  const cells: DayCell[] = [];
  let start = fireLocalDayStart(from, tz);
  for (let i = 0; i < maxDays && start <= to; i++) {
    // +24h lands in the next day for 23h/24h days; a 25h (fall-back) day needs
    // the extra nudge. The final fallback keeps the loop strictly monotonic.
    let end = fireLocalDayStart(start + 24 * HOUR_MS, tz);
    if (end <= start) end = fireLocalDayStart(start + 26 * HOUR_MS, tz);
    if (end <= start) end = start + 24 * HOUR_MS;
    cells.push({ key: fireLocalDayKey(start, tz), start, end });
    start = end;
  }
  return cells;
}

// ---------- bucketing + normalization ----------

/** Detections per fire-local day, keyed by fireLocalDayKey. Uses acq_ts. */
export function bucketHotspotsByDay(
  fc: HotspotFeatureCollection | undefined,
  tz: string | null | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!fc?.features?.length) return counts;
  for (const f of fc.features) {
    const ts = f.properties?.acq_ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    const key = fireLocalDayKey(ts, tz);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** counts → 0..1 against the busiest day. All-zero (or empty) → []. */
export function normalizeCounts(counts: number[]): number[] {
  let max = 0;
  for (const c of counts) if (c > max) max = c;
  if (!(max > 0)) return [];
  return counts.map((c) => c / max);
}

export interface ActivityDay extends DayCell {
  /** Center of the day, clamped into the window by the caller's `to`. */
  center: number;
  count: number;
  /** count / busiest-day count, in [0, 1]. */
  value: number;
}

/**
 * The full throughline series for [from, to] (callers pass to = min(now,
 * domainEnd) — hotspots do not exist in the future). Empty when there is
 * nothing to draw, so the caller can render nothing at all.
 */
export function hotspotActivity(
  fc: HotspotFeatureCollection | undefined,
  from: number,
  to: number,
  tz: string | null | undefined,
): ActivityDay[] {
  const cells = enumerateFireLocalDays(from, to, tz);
  if (!cells.length) return [];
  const counts = bucketHotspotsByDay(fc, tz);
  const raw = cells.map((c) => counts.get(c.key) ?? 0);
  const norm = normalizeCounts(raw);
  if (!norm.length) return [];
  return cells.map((c, i) => ({
    ...c,
    // the trailing cell is usually partial; keep its marker inside the window
    center: Math.min(Math.max((c.start + c.end) / 2, from), to),
    count: raw[i],
    value: norm[i],
  }));
}

// ---------- geometry ----------

export interface SparklineGeometry {
  /** Filled area under the line, closed onto the baseline. */
  area: string;
  /** The line itself. */
  line: string;
}

/**
 * Area+line path data from (x, value) samples. `height` is the drawable
 * amplitude above the baseline at y = `baseline`. Straight segments only —
 * no curve fitting, so a zero day reads as a real zero.
 */
export function sparklinePath(
  points: { x: number; value: number }[],
  baseline: number,
  height: number,
): SparklineGeometry | null {
  if (points.length < 1 || !(height > 0)) return null;
  const y = (v: number) => baseline - Math.max(0, Math.min(1, v)) * height;
  const round = (n: number) => Math.round(n * 100) / 100;
  const seg = points.map((p) => `${round(p.x)},${round(y(p.value))}`);
  const first = points[0];
  const last = points[points.length - 1];
  return {
    line: `M${seg.join(' L')}`,
    area: `M${round(first.x)},${round(baseline)} L${seg.join(' L')} L${round(last.x)},${round(baseline)} Z`,
  };
}
