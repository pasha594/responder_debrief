import { describe, expect, it } from 'vitest';
import {
  buildFrameTimes,
  lastIndexLE,
  resolvePerimeterVersion,
  resolveSpreadFrame,
  resolveWeatherFrame,
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

// The minute-precision first instant is the critical real-world case:
// runs start at e.g. 11:25:00Z, then step hourly on the hour.
const run = {
  workspace: 'fire-spread-forecast_or-paradise_20260817_112500',
  time_instants: [
    '2026-08-17T11:25:00.000Z',
    '2026-08-17T12:00:00.000Z',
    '2026-08-17T13:00:00.000Z',
  ],
} as unknown as PyrecastRun;

describe('resolveSpreadFrame', () => {
  it('returns the verbatim instant string, never rounded', () => {
    const f = resolveSpreadFrame(run, T('2026-08-17T11:40:00Z'));
    expect(f?.instant).toBe('2026-08-17T11:25:00.000Z');
  });
  it('exact hits and later instants', () => {
    expect(resolveSpreadFrame(run, T('2026-08-17T12:00:00Z'))?.instant).toBe(
      '2026-08-17T12:00:00.000Z',
    );
    expect(resolveSpreadFrame(run, T('2026-08-17T23:00:00Z'))?.instant).toBe(
      '2026-08-17T13:00:00.000Z',
    );
  });
  it('null before coverage', () => {
    expect(resolveSpreadFrame(run, T('2026-08-17T11:00:00Z'))).toBeNull();
    expect(resolveSpreadFrame(null, Date.now())).toBeNull();
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

describe('buildFrameTimes', () => {
  it('unions active layers, clipped and sorted', () => {
    const times = buildFrameTimes({
      spreadRun: run,
      spreadActive: true,
      weatherRun,
      weatherActive: true,
      from: T('2026-08-17T11:00:00Z'),
      to: T('2026-08-17T13:00:00Z'),
    });
    expect(times).toEqual([
      T('2026-08-17T11:25:00.000Z'),
      T('2026-08-17T12:00:00Z'),
      T('2026-08-17T13:00:00Z'),
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
