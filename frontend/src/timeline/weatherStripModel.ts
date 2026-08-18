/**
 * Pure logic for the Windy-style timeline weather strip: WMO code → icon,
 * slot stride selection, and building the per-slot samples (icon, temp,
 * wind arrow) from Open-Meteo's hourly arrays.
 *
 * The timeline scale is piecewise (past compressed vs future), so slots are
 * chosen per SEGMENT: each side gets the stride that keeps columns at least
 * MIN_SLOT_PX apart at that side's px/hour. Slots snap to whole hours so
 * columns sit on real samples — no interpolation.
 */

export interface HourlyWeather {
  /** epoch ms, ascending, whole hours. */
  t: number;
  tempF: number;
  /** WMO weather interpretation code. */
  code: number;
  windMph: number;
  /** Direction the wind blows FROM, degrees clockwise from north. */
  windFromDeg: number;
}

export interface WeatherSlot {
  t: number;
  x: number;
  /** True for 24h summary columns (tooltip shows the date, not an hour). */
  daily: boolean;
  icon: string;
  label: string;
  tempF: number;
  windMph: number;
  /** Rotation for an up-pointing arrow glyph: bearing the air moves TOWARD. */
  arrowDeg: number;
}

const HOUR = 3600_000;

/** Minimum px between strip columns before we thin to a coarser stride. */
export const MIN_SLOT_PX = 44;

/** Candidate strides, hours. >= 24 = multi-day summary columns. */
const STRIDES = [1, 2, 3, 6, 12, 24, 48, 96] as const;

// ---------- WMO weather codes → glyph + label -------------------------------
// https://open-meteo.com/en/docs (WMO 4677 interpretation codes)

const WMO_ICONS: [Set<number>, string, string][] = [
  [new Set([0]), '☀️', 'Clear'],
  [new Set([1]), '🌤️', 'Mostly clear'],
  [new Set([2]), '⛅', 'Partly cloudy'],
  [new Set([3]), '☁️', 'Overcast'],
  [new Set([45, 48]), '🌫️', 'Fog'],
  [new Set([51, 53, 55, 56, 57]), '🌦️', 'Drizzle'],
  [new Set([61, 63, 66, 80, 81]), '🌧️', 'Rain'],
  [new Set([65, 67, 82]), '🌧️', 'Heavy rain'],
  [new Set([71, 73, 75, 77, 85, 86]), '🌨️', 'Snow'],
  [new Set([95, 96, 99]), '⛈️', 'Thunderstorm'],
];

export function wmoIcon(code: number): { icon: string; label: string } {
  for (const [codes, icon, label] of WMO_ICONS) {
    if (codes.has(code)) return { icon, label };
  }
  return { icon: '☁️', label: 'Cloudy' };
}

/** Severity rank for daily summaries: the day shows its "worst" weather. */
const SEVERITY: number[] = [95, 96, 99, 65, 67, 82, 71, 73, 75, 77, 85, 86, 61, 63, 66, 80, 81, 51, 53, 55, 56, 57, 45, 48, 3, 2, 1, 0];

function severity(code: number): number {
  const i = SEVERITY.indexOf(code);
  return i === -1 ? SEVERITY.length : i;
}

/** Smallest stride keeping columns >= MIN_SLOT_PX apart at pxPerHour. */
export function strideForPxPerHour(pxPerHour: number): number {
  for (const s of STRIDES) {
    if (s * pxPerHour >= MIN_SLOT_PX) return s;
  }
  return STRIDES[STRIDES.length - 1];
}

/** Binary search: index of the hourly sample exactly at t (or -1). */
function sampleAt(hours: HourlyWeather[], t: number): HourlyWeather | null {
  let lo = 0;
  let hi = hours.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hours[mid].t === t) return hours[mid];
    if (hours[mid].t < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function toSlot(s: HourlyWeather, x: number): WeatherSlot {
  const { icon, label } = wmoIcon(s.code);
  return {
    t: s.t,
    x,
    daily: false,
    icon,
    label,
    tempF: Math.round(s.tempF),
    windMph: Math.round(s.windMph),
    arrowDeg: (s.windFromDeg + 180) % 360,
  };
}

/**
 * A daily summary slot from the day's samples: max temp (the burn-period
 * number), the severest weather code, and the wind at the windiest hour.
 */
function daySummary(samples: HourlyWeather[], t: number, x: number): WeatherSlot {
  let worst = samples[0];
  let hottest = samples[0];
  let windiest = samples[0];
  for (const s of samples) {
    if (severity(s.code) < severity(worst.code)) worst = s;
    if (s.tempF > hottest.tempF) hottest = s;
    if (s.windMph > windiest.windMph) windiest = s;
  }
  const { icon, label } = wmoIcon(worst.code);
  return {
    t,
    x,
    daily: true,
    icon,
    label,
    tempF: Math.round(hottest.tempF),
    windMph: Math.round(windiest.windMph),
    arrowDeg: (windiest.windFromDeg + 180) % 360,
  };
}

/**
 * Build strip slots for one timeline segment [from, to] at a px scale.
 * Hourly strides place columns on exact samples; the 24h stride summarizes
 * each window (max temp / severest code / peak wind).
 */
function segmentSlots(
  hours: HourlyWeather[],
  from: number,
  to: number,
  timeToX: (t: number) => number,
): WeatherSlot[] {
  if (to <= from) return [];
  const pxPerHour = (timeToX(to) - timeToX(from)) / ((to - from) / HOUR);
  if (!(pxPerHour > 0)) return [];
  const stride = strideForPxPerHour(pxPerHour);
  const step = stride * HOUR;
  // Anchor slots to absolute epoch multiples so they hold still as NOW moves.
  const first = Math.ceil(from / step) * step;
  const out: WeatherSlot[] = [];
  for (let t = first; t <= to; t += step) {
    if (stride >= 24) {
      // Daily column: summarize the window, centered on its midpoint.
      const windowSamples = hours.filter((s) => s.t >= t && s.t < t + step);
      if (windowSamples.length) {
        out.push(daySummary(windowSamples, t, timeToX(Math.min(t + step / 2, to))));
      }
    } else {
      const s = sampleAt(hours, t);
      if (s) out.push(toSlot(s, timeToX(t)));
    }
  }
  return out;
}

/**
 * All strip slots for the piecewise timeline: past and future segments get
 * independent strides (the past is compressed), seamed at `now`.
 */
export function buildWeatherSlots(
  hours: HourlyWeather[],
  domain: [number, number],
  now: number,
  timeToX: (t: number) => number,
): WeatherSlot[] {
  if (!hours.length) return [];
  const [d0, d1] = domain;
  if (now > d0 && now < d1) {
    // Both segments can land a slot exactly at the seam — keep the future one
    // (finer stride there, and NOW-forward is what the reader scans for).
    const future = segmentSlots(hours, now, d1, timeToX);
    const futureTs = new Set(future.map((s) => s.t));
    const past = segmentSlots(hours, d0, now, timeToX).filter((s) => !futureTs.has(s.t));
    return [...past, ...future];
  }
  return segmentSlots(hours, d0, d1, timeToX);
}

/**
 * Parse Open-Meteo's hourly block (timezone=UTC, ISO minute strings) into
 * typed samples, dropping any hour with a null in it.
 */
export function parseOpenMeteoHourly(hourly: {
  time: string[];
  temperature_2m: (number | null)[];
  weather_code: (number | null)[];
  wind_speed_10m: (number | null)[];
  wind_direction_10m: (number | null)[];
}): HourlyWeather[] {
  const out: HourlyWeather[] = [];
  for (let i = 0; i < hourly.time.length; i++) {
    const tempF = hourly.temperature_2m[i];
    const code = hourly.weather_code[i];
    const windMph = hourly.wind_speed_10m[i];
    const windFromDeg = hourly.wind_direction_10m[i];
    if (tempF == null || code == null || windMph == null || windFromDeg == null) continue;
    const t = Date.parse(hourly.time[i] + ':00Z');
    if (!Number.isFinite(t)) continue;
    out.push({ t, tempF, code, windMph, windFromDeg });
  }
  return out;
}
