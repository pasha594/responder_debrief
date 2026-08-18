import { describe, expect, it } from 'vitest';
import {
  buildWeatherSlots,
  parseOpenMeteoHourly,
  strideForPxPerHour,
  wmoIcon,
  type HourlyWeather,
} from './weatherStripModel';

const HOUR = 3600_000;
/** Aug 18 2026 00:00Z — a clean hour boundary. */
const T0 = Date.UTC(2026, 7, 18);

function hoursFixture(n: number, make?: (i: number) => Partial<HourlyWeather>): HourlyWeather[] {
  return Array.from({ length: n }, (_, i) => ({
    t: T0 + i * HOUR,
    tempF: 70 + i,
    code: 0,
    windMph: 5,
    windFromDeg: 270, // wind FROM the west → arrow points east (90)
    ...make?.(i),
  }));
}

describe('wmoIcon', () => {
  it('maps the core WMO codes', () => {
    expect(wmoIcon(0).label).toBe('Clear');
    expect(wmoIcon(3).label).toBe('Overcast');
    expect(wmoIcon(63).label).toBe('Rain');
    expect(wmoIcon(75).label).toBe('Snow');
    expect(wmoIcon(95).label).toBe('Thunderstorm');
  });

  it('falls back to cloudy for unknown codes', () => {
    expect(wmoIcon(42).label).toBe('Cloudy');
  });
});

describe('strideForPxPerHour', () => {
  it('goes hourly when an hour is wide enough', () => {
    expect(strideForPxPerHour(60)).toBe(1);
  });
  it('coarsens as hours compress', () => {
    expect(strideForPxPerHour(20)).toBe(3);
    expect(strideForPxPerHour(5)).toBe(12);
  });
  it('grows to multi-day windows for very compressed segments', () => {
    expect(strideForPxPerHour(1)).toBe(48);
    expect(strideForPxPerHour(0.5)).toBe(96);
  });
});

describe('buildWeatherSlots', () => {
  // Linear scale helper over a domain, 1000px wide.
  const linear = (d0: number, d1: number) => (t: number) =>
    ((Math.min(d1, Math.max(d0, t)) - d0) / (d1 - d0)) * 1000;

  it('places hourly slots on exact samples with the wind arrow flipped', () => {
    const hours = hoursFixture(13);
    const d: [number, number] = [T0, T0 + 12 * HOUR];
    // 1000px / 12h ≈ 83 px/h → hourly stride
    const slots = buildWeatherSlots(hours, d, d[1] + HOUR, linear(d[0], d[1]));
    expect(slots.length).toBe(13);
    expect(slots[0].t).toBe(T0);
    expect(slots[1].x - slots[0].x).toBeCloseTo(1000 / 12, 5);
    expect(slots[0].arrowDeg).toBe(90); // from-west → toward-east
    expect(slots[0].tempF).toBe(70);
  });

  it('summarizes daily windows by max temp, worst code, peak wind', () => {
    const hours = hoursFixture(48, (i) => ({
      tempF: i === 30 ? 99 : 70,
      code: i === 40 ? 95 : 0,
      windMph: i === 26 ? 33 : 5,
      windFromDeg: i === 26 ? 0 : 270,
    }));
    // A 20-day domain at 1000px ≈ 2.1 px/h → daily stride; only the first
    // 2 days have samples, so exactly 2 summary columns come back.
    const wide: [number, number] = [T0, T0 + 20 * 24 * HOUR];
    const slots = buildWeatherSlots(hours, wide, wide[1] + HOUR, linear(wide[0], wide[1]));
    expect(slots.length).toBe(2);
    const day2 = slots[1]; // hours 24-47
    expect(day2.tempF).toBe(99); // max temp of the day
    expect(day2.label).toBe('Thunderstorm'); // worst code wins the icon
    expect(day2.windMph).toBe(33); // peak wind
    expect(day2.arrowDeg).toBe(180); // from-north → toward-south
  });

  it('splits strides at the now seam (compressed past, roomy future)', () => {
    const hours = hoursFixture(24 * 8 + 1);
    const now = T0 + 24 * 7 * HOUR; // a week of past
    const d: [number, number] = [T0, now + 24 * HOUR];
    // Piecewise: past 168h → 500px (3 px/h → 24h stride); future 24h → 500px (20.8 px/h → 3h stride)
    const timeToX = (t: number) =>
      t <= now ? ((t - d[0]) / (now - d[0])) * 500 : 500 + ((t - now) / (d[1] - now)) * 500;
    const slots = buildWeatherSlots(hours, d, now, timeToX);
    const past = slots.filter((s) => s.t < now);
    const future = slots.filter((s) => s.t >= now);
    expect(past.length).toBeGreaterThan(0);
    expect(future.length).toBeGreaterThan(past.length / 2); // denser per hour
    // future slots stride 3h
    expect(future[1].t - future[0].t).toBe(3 * HOUR);
  });

  it('returns empty without data', () => {
    expect(buildWeatherSlots([], [T0, T0 + HOUR], T0, () => 0)).toEqual([]);
  });
});

describe('parseOpenMeteoHourly', () => {
  it('parses UTC minute stamps and drops null hours', () => {
    const out = parseOpenMeteoHourly({
      time: ['2026-08-18T00:00', '2026-08-18T01:00', '2026-08-18T02:00'],
      temperature_2m: [70, null, 72],
      weather_code: [0, 1, 2],
      wind_speed_10m: [5, 6, 7],
      wind_direction_10m: [270, 270, 270],
    });
    expect(out.length).toBe(2);
    expect(out[0].t).toBe(T0);
    expect(out[1].t).toBe(T0 + 2 * HOUR);
    expect(out[1].code).toBe(2);
  });
});
