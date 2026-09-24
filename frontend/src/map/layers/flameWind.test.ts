import { describe, expect, it } from 'vitest';
import type { HourlyWeather } from '../../timeline/weatherStripModel';
import {
  FULL_LEAN_MPH,
  flameWindOption,
  isAtPresent,
  sameFlameWind,
  windAtTime,
  windFromUv,
} from './flameWind';

const H = 3_600_000;
const T0 = Date.parse('2026-09-18T12:00:00Z');
const hour = (t: number, windMph: number, windFromDeg: number): HourlyWeather => ({
  t,
  tempF: 70,
  code: 0,
  windMph,
  windFromDeg,
});

describe('windFromUv', () => {
  it('reads HRRR components as the meteorological FROM direction', () => {
    expect(windFromUv(10, 0).fromDeg).toBeCloseTo(270); // air moving east comes from the west
    expect(windFromUv(0, -10).fromDeg).toBeCloseTo(0); // air moving south comes from the north
    expect(windFromUv(0, -10).mph).toBeCloseTo(22.37, 1);
  });
});

describe('windAtTime', () => {
  const hours = [hour(T0, 10, 270), hour(T0 + H, 20, 270)];

  it('uses the hour itself on the hour', () => {
    expect(windAtTime(hours, T0)).toEqual({ mph: 10, fromDeg: 270 });
  });

  it('interpolates between hours', () => {
    const w = windAtTime(hours, T0 + H / 2)!;
    expect(w.mph).toBeCloseTo(15);
    expect(w.fromDeg).toBeCloseTo(270);
  });

  it('turns through north between 350° and 10°, not through south', () => {
    const w = windAtTime([hour(T0, 10, 350), hour(T0 + H, 10, 10)], T0 + H / 2)!;
    expect(Math.min(w.fromDeg, 360 - w.fromDeg)).toBeLessThan(0.5);
  });

  it('holds the edge hour briefly, then gives up', () => {
    expect(windAtTime(hours, T0 + H + 30 * 60_000)).toEqual({ mph: 20, fromDeg: 270 });
    expect(windAtTime(hours, T0 + 4 * H)).toBeNull();
    expect(windAtTime(undefined, T0)).toBeNull();
  });
});

describe('flameWindOption', () => {
  it('scales the lean with speed, full at FULL_LEAN_MPH', () => {
    expect(flameWindOption({ mph: FULL_LEAN_MPH / 2, fromDeg: 90 })).toEqual({ from: 90, strength: 0.5 });
    expect(flameWindOption({ mph: 80, fromDeg: 90 })!.strength).toBe(1);
  });

  it('leaves the flames upright in calm or unknown air', () => {
    expect(flameWindOption({ mph: 0, fromDeg: 90 })).toBeNull();
    expect(flameWindOption(null)).toBeNull();
  });
});

describe('sameFlameWind', () => {
  it('ignores sub-degree and sub-percent changes, including across north', () => {
    expect(sameFlameWind({ from: 359.6, strength: 0.5 }, { from: 0.2, strength: 0.505 })).toBe(true);
    expect(sameFlameWind({ from: 10, strength: 0.5 }, { from: 12, strength: 0.5 })).toBe(false);
    expect(sameFlameWind(null, null)).toBe(true);
    expect(sameFlameWind(null, { from: 0, strength: 0.1 })).toBe(false);
  });
});

describe('isAtPresent', () => {
  it('counts only the live-pin window as the present', () => {
    expect(isAtPresent(T0 - 60_000, T0)).toBe(true);
    expect(isAtPresent(T0 - 10 * 60_000, T0)).toBe(false);
    expect(isAtPresent(T0 + H, T0)).toBe(false);
  });
});
