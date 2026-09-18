import { describe, expect, it } from 'vitest';
import { roundDistance, scaleReadings } from './scaleReadings';

describe('roundDistance', () => {
  it('snaps down to the 1 / 2 / 3 / 5 ladder at any magnitude', () => {
    expect(roundDistance(1)).toBe(1);
    expect(roundDistance(1.99)).toBe(1);
    expect(roundDistance(2.5)).toBe(2);
    expect(roundDistance(4.9)).toBe(3);
    expect(roundDistance(9.99)).toBe(5);
    expect(roundDistance(10)).toBe(10);
    expect(roundDistance(784)).toBe(500);
    expect(roundDistance(1957)).toBe(1000);
    expect(roundDistance(0.37)).toBe(0.3);
  });
});

describe('scaleReadings', () => {
  it('reads miles over kilometers at fire scale', () => {
    // ~z10 at 47.9°N: 100 px spans about 10.2 km
    const r = scaleReadings(10_200, 100)!;
    expect(r.imperial.label).toBe('5 mi');
    expect(r.metric.label).toBe('10 km');
    // widths are each unit's share of the 100 px span
    expect(r.imperial.widthPx).toBe(Math.round((100 * 5 * 1609.344) / 10_200));
    expect(r.metric.widthPx).toBe(98);
  });

  it('drops to feet and meters when zoomed in close', () => {
    const r = scaleReadings(84, 100)!; // ~z17
    expect(r.imperial.label).toBe('200 ft');
    expect(r.metric.label).toBe('50 m');
  });

  it('switches units at exactly a mile / a kilometer', () => {
    expect(scaleReadings(1000, 100)!.metric.label).toBe('1 km');
    expect(scaleReadings(999, 100)!.metric.label).toBe('500 m');
    expect(scaleReadings(1700, 100)!.imperial.label).toBe('1 mi');
    expect(scaleReadings(1600, 100)!.imperial.label).toBe('5,000 ft');
  });

  it('never draws a bar shorter than half, or longer than, the max width', () => {
    for (let meters = 60; meters < 3_000_000; meters *= 1.07) {
      const r = scaleReadings(meters, 100)!;
      for (const bar of [r.imperial, r.metric]) {
        expect(bar.widthPx).toBeGreaterThanOrEqual(50);
        expect(bar.widthPx).toBeLessThanOrEqual(100);
      }
    }
  });

  it('has no reading for a map that has no size yet', () => {
    expect(scaleReadings(0, 100)).toBeNull();
    expect(scaleReadings(Number.NaN, 100)).toBeNull();
  });
});
