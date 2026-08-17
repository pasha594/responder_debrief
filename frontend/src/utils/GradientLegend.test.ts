import { describe, expect, it } from 'vitest';
import { stopPercents } from './GradientLegend';

describe('stopPercents', () => {
  it('maps stop values linearly onto [0, 100]', () => {
    const stops: [number, string][] = [
      [0, '#78b4dc'],
      [10, '#50aa96'],
      [20, '#ffdc50'],
      [30, '#ff9628'],
      [45, '#e63c32'],
      [58, '#aa2882'],
      [70, '#6e1450'],
    ];
    const pct = stopPercents(stops);
    expect(pct[0]).toBe(0);
    expect(pct[pct.length - 1]).toBe(100);
    expect(pct[1]).toBeCloseTo((10 / 70) * 100, 6);
    expect(pct[4]).toBeCloseTo((45 / 70) * 100, 6);
  });

  it('handles a non-zero minimum (rh 5–100%)', () => {
    const pct = stopPercents([
      [5, '#d4572e'],
      [40, '#e0d063'],
      [100, '#78b4dc'],
    ]);
    expect(pct).toEqual([0, ((40 - 5) / 95) * 100, 100]);
  });

  it('handles fractional stops (apcp01 inches)', () => {
    const pct = stopPercents([
      [0, '#a4aab8'],
      [0.05, '#627cae'],
      [1.5, '#9f40dd'],
    ]);
    expect(pct[1]).toBeCloseTo((0.05 / 1.5) * 100, 6);
  });

  it('degenerate inputs: empty and zero-span', () => {
    expect(stopPercents([])).toEqual([]);
    expect(
      stopPercents([
        [3, '#000'],
        [3, '#fff'],
      ]),
    ).toEqual([0, 0]);
  });
});
