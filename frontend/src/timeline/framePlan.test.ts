import { describe, expect, it } from 'vitest';
import {
  buildFrameTimes,
  lastIndexLE,
  resolvePerimeterVersion,
  resolveWeatherFrame,
  spreadCoverage,
  spreadHourTicks,
} from './framePlan';
import type { PyrecastRun, WeatherRun } from '../api/types';

const T = (s: string) => Date.parse(s);

describe('lastIndexLE', () => {
  it('binary searches correctly', () => {
    const arr = [10, 20, 30];
    expect(lastIndexLE(arr, 5)).toBe(-1);
    expect(lastIndexLE(arr, 10)).toBe(0);
    expect(lastIndexLE(arr, 25)).toBe(1);
    expect(lastIndexLE(arr, 99)).toBe(2);
  });
});

describe('resolvePerimeterVersion', () => {
  const index = [
    { path: '/p/1', date: '2026-08-01T10:00:00Z' },
    { path: '/p/2', date: '2026-08-05T12:00:00Z' },
    { path: '/p/3', date: '2026-08-16T22:56:51Z' },
  ];
  it('steps to the latest version <= t', () => {
    expect(resolvePerimeterVersion(index, T('2026-08-04T00:00:00Z'))?.path).toBe('/p/1');
    expect(resolvePerimeterVersion(index, T('2026-08-05T12:00:00Z'))?.path).toBe('/p/2');
    expect(resolvePerimeterVersion(index, T('2027-01-01T00:00:00Z'))?.path).toBe('/p/3');
  });
  it('null before first version and for empty input', () => {
    expect(resolvePerimeterVersion(index, T('2026-07-31T00:00:00Z'))).toBeNull();
    expect(resolvePerimeterVersion([], Date.now())).toBeNull();
    expect(resolvePerimeterVersion(undefined, Date.now())).toBeNull();
  });
});

// v2 archive run: coverage is run_time .. run_time + horizon_hours; minute-
// precision run starts (11:25) are the critical real-world case.
const run = {
  workspace: 'wa-sinlahekin_20260817_112500',
  slug: 'wa-sinlahekin',
  run_ts: '20260817_112500',
  run_time: '2026-08-17T11:25:00Z',
  horizon_hours: 3,
} as unknown as PyrecastRun;

describe('spreadCoverage (v2: run_time + horizon_hours)', () => {
  it('spans run start to start + horizon', () => {
    expect(spreadCoverage(run)).toEqual([
      T('2026-08-17T11:25:00Z'),
      T('2026-08-17T14:25:00Z'),
    ]);
  });
  it('null on missing run / bad fields', () => {
    expect(spreadCoverage(null)).toBeNull();
    expect(
      spreadCoverage({ ...run, run_time: 'garbage' } as unknown as PyrecastRun),
    ).toBeNull();
    expect(
      spreadCoverage({ ...run, horizon_hours: 0 } as unknown as PyrecastRun),
    ).toBeNull();
  });
});

describe('spreadHourTicks', () => {
  it('steps hourly anchored to the (minute-precision) run start', () => {
    expect(spreadHourTicks(run, T('2026-08-17T00:00:00Z'), T('2026-08-18T00:00:00Z'))).toEqual([
      T('2026-08-17T11:25:00Z'),
      T('2026-08-17T12:25:00Z'),
      T('2026-08-17T13:25:00Z'),
      T('2026-08-17T14:25:00Z'),
    ]);
  });
  it('clips to [from, to]', () => {
    expect(spreadHourTicks(run, T('2026-08-17T12:00:00Z'), T('2026-08-17T13:00:00Z'))).toEqual([
      T('2026-08-17T12:25:00Z'),
    ]);
  });
  it('empty without a run', () => {
    expect(spreadHourTicks(null, 0, Date.now())).toEqual([]);
  });
});

const weatherRun = {
  workspace: 'fire-weather-forecast_hrrr_20260817_12',
  hours: ['2026-08-17T12:00:00Z', '2026-08-17T13:00:00Z', '2026-08-17T14:00:00Z'],
} as unknown as WeatherRun;

describe('resolveWeatherFrame', () => {
  it('snaps to nearest hour within tolerance', () => {
    expect(resolveWeatherFrame(weatherRun, T('2026-08-17T12:20:00Z'))?.hourIso).toBe(
      '2026-08-17T12:00:00Z',
    );
    expect(resolveWeatherFrame(weatherRun, T('2026-08-17T12:40:00Z'))?.hourIso).toBe(
      '2026-08-17T13:00:00Z',
    );
  });
  it('null outside tolerance (90 min)', () => {
    expect(resolveWeatherFrame(weatherRun, T('2026-08-17T09:00:00Z'))).toBeNull();
    expect(resolveWeatherFrame(weatherRun, T('2026-08-17T16:00:00Z'))).toBeNull();
  });
});

describe('resolveWeatherFrame with frames.hours', () => {
  // frames.hours lags run.hours while the worker is budget-limited: only the
  // rendered hours are snappable.
  const framedWeatherRun = {
    workspace: 'fire-weather-forecast_hrrr_20260817_12',
    hours: ['2026-08-17T12:00:00Z', '2026-08-17T13:00:00Z', '2026-08-17T14:00:00Z'],
    frames: {
      bounds: [-125.0, 24.5, -66.5, 49.5],
      image_template: '/frames/weather/{ws}/{product}/{epoch_ms}.png',
      hours: ['2026-08-17T12:00:00Z', '2026-08-17T13:00:00Z'],
      complete: false,
    },
  } as unknown as WeatherRun;

  it('snaps only among rendered hours', () => {
    expect(resolveWeatherFrame(framedWeatherRun, T('2026-08-17T12:40:00Z'))?.hourIso).toBe(
      '2026-08-17T13:00:00Z',
    );
    // 14:00 exists in run.hours but was not rendered → nearest rendered is 13:00.
    expect(resolveWeatherFrame(framedWeatherRun, T('2026-08-17T14:00:00Z'))?.hourIso).toBe(
      '2026-08-17T13:00:00Z',
    );
  });
  it('null beyond tolerance of the rendered list', () => {
    expect(resolveWeatherFrame(framedWeatherRun, T('2026-08-17T15:00:00Z'))).toBeNull();
  });
});

describe('buildFrameTimes', () => {
  it('unions spread hourly ticks with weather hours, clipped and sorted', () => {
    const times = buildFrameTimes({
      spreadRun: run,
      spreadActive: true,
      weatherRun,
      weatherActive: true,
      from: T('2026-08-17T11:00:00Z'),
      to: T('2026-08-17T13:00:00Z'),
    });
    expect(times).toEqual([
      T('2026-08-17T11:25:00Z'),
      T('2026-08-17T12:00:00Z'),
      T('2026-08-17T12:25:00Z'),
      T('2026-08-17T13:00:00Z'),
    ]);
  });
  it('spread alone contributes run-anchored hourly ticks', () => {
    const times = buildFrameTimes({
      spreadRun: run,
      spreadActive: true,
      weatherRun: null,
      weatherActive: false,
      from: T('2026-08-17T11:00:00Z'),
      to: T('2026-08-17T14:00:00Z'),
    });
    expect(times).toEqual([
      T('2026-08-17T11:25:00Z'),
      T('2026-08-17T12:25:00Z'),
      T('2026-08-17T13:25:00Z'),
    ]);
  });
  it('hourly fallback when nothing is active', () => {
    const times = buildFrameTimes({
      spreadRun: null,
      spreadActive: false,
      weatherRun: null,
      weatherActive: false,
      from: T('2026-08-17T00:30:00Z'),
      to: T('2026-08-17T03:30:00Z'),
    });
    expect(times).toEqual([
      T('2026-08-17T01:00:00Z'),
      T('2026-08-17T02:00:00Z'),
      T('2026-08-17T03:00:00Z'),
    ]);
  });
});
