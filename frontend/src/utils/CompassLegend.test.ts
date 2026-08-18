import { describe, expect, it } from 'vitest';
import { compassTicks } from './CompassLegend';

/** The worker's circular wd ramp: 0 and 360 are the same bearing. */
const WD_STOPS: [number, string][] = [
  [0, '#e6484f'],
  [45, '#e8a13c'],
  [90, '#d8d43f'],
  [135, '#63c04c'],
  [180, '#3fb9b0'],
  [225, '#4a8fe0'],
  [270, '#8a63d2'],
  [315, '#d059a8'],
  [360, '#e6484f'],
];

describe('compassTicks', () => {
  it('places N/E/S/W/N at the quarter points of the full 0–360 ramp', () => {
    const ticks = compassTicks(WD_STOPS[0][0], WD_STOPS[WD_STOPS.length - 1][0]);
    expect(ticks.map((t) => t.label)).toEqual(['N', 'E', 'S', 'W', 'N']);
    expect(ticks.map((t) => t.pct)).toEqual([0, 25, 50, 75, 100]);
  });

  it('the wrap-around north lands at 100%, not off the end of the bar', () => {
    const ticks = compassTicks(0, 360);
    expect(ticks[ticks.length - 1]).toEqual({ value: 360, label: 'N', pct: 100 });
  });

  it('drops cardinals outside a partial span', () => {
    const ticks = compassTicks(90, 270);
    expect(ticks.map((t) => t.label)).toEqual(['E', 'S', 'W']);
    expect(ticks.map((t) => t.pct)).toEqual([0, 50, 100]);
  });

  it('keeps a cardinal exactly on a span boundary', () => {
    expect(compassTicks(180, 360).map((t) => t.label)).toEqual(['S', 'W', 'N']);
  });

  it('returns nothing for a degenerate or inverted span', () => {
    expect(compassTicks(0, 0)).toEqual([]);
    expect(compassTicks(360, 0)).toEqual([]);
    expect(compassTicks(0, NaN)).toEqual([]);
  });

  it('yields no ticks when the span contains no cardinal', () => {
    expect(compassTicks(100, 170)).toEqual([]);
  });
});
