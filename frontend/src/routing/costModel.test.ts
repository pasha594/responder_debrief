import { describe, expect, it } from 'vitest';
import { H_PACE, alpha, alphaFast, getRate, sullivanRate, tertileRatios } from './costModel';
import { IMPASSABLE, PACE_LUT, paceOf } from './pacecode';
import { MinHeap } from './heap';
import { STREAM_LABEL, VEG_CLASSES, vegClass } from './vegClasses';

const minPerKm = (r: number) => 1000 / r / 60;

describe('Sullivan 2020 tertiles', () => {
  it('reproduces the flat rates and the high-tertile table (min/km)', () => {
    expect(sullivanRate(0, 'low')).toBeCloseTo(0.961, 2);
    expect(sullivanRate(0, 'mod')).toBeCloseTo(1.381, 2);
    expect(sullivanRate(0, 'high')).toBeCloseTo(1.680, 2);
    const table: [number, number][] = [[-30, 16.1], [-15, 11.9], [0, 9.9], [15, 14.0], [30, 19.7]];
    for (const [th, want] of table) expect(minPerKm(sullivanRate(th, 'high'))).toBeCloseTo(want, 0);
  });

  it('is slower uphill than on the flat, and clamps beyond ±40°', () => {
    expect(sullivanRate(20)).toBeLessThan(sullivanRate(0));
    expect(sullivanRate(55)).toBe(sullivanRate(40));
    const r = tertileRatios(0);
    expect(r.fast).toBeCloseTo(0.822, 2);
    expect(r.slow).toBeCloseTo(1.437, 2);
  });
});

describe('GET v2 + asymmetry', () => {
  it('matches the published isotropic rate', () => {
    expect(getRate(0)).toBeCloseTo(1.149, 3);
    expect(getRate(30)).toBeCloseTo(0.441, 2);
    expect(getRate(45)).toBeCloseTo(0.265, 2);
  });

  it('α preserves round-trip time and is slower uphill', () => {
    for (const th of [5, 15, 30, 45]) {
      expect((alpha(th) + alpha(-th)) / 2).toBeCloseTo(1, 10);
      expect(alpha(th)).toBeGreaterThan(1);
    }
    expect(alpha(15)).toBeCloseTo(1.104, 2);
    expect(alpha(0)).toBe(1);
    expect(alphaFast(14.9)).toBeCloseTo(alpha(15), 2);
  });

  it('H_PACE is admissible: below every trail and cross-country pace', () => {
    for (let th = -40; th <= 40; th += 0.5) {
      expect(1 / sullivanRate(th, 'mod')).toBeGreaterThanOrEqual(H_PACE);
      // cross-country: pace ≥ 1/rGET(σ ≥ |θ|) times α
      expect(alpha(th) / getRate(Math.abs(th))).toBeGreaterThanOrEqual(H_PACE);
    }
  });
});

describe('pace code (logpace-v1, shared with worker cost_grid.py)', () => {
  it('decodes the worker encoding', () => {
    expect(PACE_LUT[1]).toBeCloseTo(0.8, 6);
    expect(PACE_LUT[254]).toBeCloseTo(819.2, 1);
    expect(paceOf(0)).toBe(Infinity);
    expect(PACE_LUT[IMPASSABLE]).toBe(Infinity);
    // worker: pace_encode(1/rGET(0)) for flat grass = code 6
    const flat = 1 / getRate(0);
    const code = 1 + Math.round((253 * Math.log(flat / 0.8)) / Math.log(1024));
    expect(Math.abs(PACE_LUT[code] / flat - 1)).toBeLessThan(0.015);
  });

  it('labels as impassable the classes the worker makes impassable', () => {
    // cost_grid.py: open water (rivers included), > 45°, and since
    // COST_GRID_VERSION 3 glaciers and permanent snow/ice
    expect(VEG_CLASSES.filter((c) => c.impassable).map((c) => c.key)).toEqual(['snow', 'water', 'steep']);
    expect(vegClass(9).label).toBe('Snow / ice (impassable)');
  });

  it('the legend calls a river water and the stream bit a creek (worker 4514759)', () => {
    // NHD order >= 5, a '... River' name or OSM waterway=river is class 10
    // with no stream bit; the bit is left only on creeks a crew may ford
    expect(vegClass(10).label).toBe('Open water or river (impassable)');
    expect(STREAM_LABEL).toBe('Perennial creek (crossable)');
  });
});

describe('MinHeap', () => {
  it('pops in key order and grows', () => {
    const h = new MinHeap(2);
    const keys = [5, 1, 9, 3, 7, 2, 8];
    keys.forEach((k, i) => h.push(k, i));
    const out: number[] = [];
    while (h.size) out.push(keys[h.pop()]);
    expect(out).toEqual([...keys].sort((a, b) => a - b));
    expect(h.pop()).toBe(-1);
  });
});
