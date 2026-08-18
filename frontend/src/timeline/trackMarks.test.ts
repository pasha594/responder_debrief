import { describe, expect, it } from 'vitest';
import { dayLabelStride, markPlacement } from './trackMarks';
import { makeScale } from './timeScale';

describe('dayLabelStride', () => {
  const evenly = (n: number, gap: number) => Array.from({ length: n }, (_, i) => i * gap);

  it('labels every day when they already clear the minimum gap', () => {
    expect(dayLabelStride(evenly(25, 40), 34)).toBe(1);
    expect(dayLabelStride(evenly(25, 34), 34)).toBe(1);
  });

  it('thins to every 2nd, then every 3rd, as days compress', () => {
    // 1440px-wide window → ~32px/day across a 25-day fire view
    expect(dayLabelStride(evenly(25, 32), 34)).toBe(2);
    // 900px-wide window → ~14.5px/day
    expect(dayLabelStride(evenly(25, 14.5), 34)).toBe(3);
    expect(dayLabelStride(evenly(30, 5), 34)).toBe(7);
  });

  it('obeys the TIGHTEST gap, not the average (the scale is piecewise)', () => {
    // 25 compressed past days then two wide future days
    const xs = [...evenly(25, 15), 25 * 15 + 300, 25 * 15 + 600];
    expect(dayLabelStride(xs, 34)).toBe(3);
  });

  it('degrades safely', () => {
    expect(dayLabelStride([], 34)).toBe(1);
    expect(dayLabelStride([12], 34)).toBe(1);
    expect(dayLabelStride([10, 10, 10], 34)).toBe(3); // zero gap → one label
    expect(dayLabelStride(evenly(5, 10), 0)).toBe(1);
  });
});

describe('markPlacement', () => {
  const D0 = Date.parse('2026-07-23T00:00:00Z');
  const NOW = Date.parse('2026-08-17T06:30:00Z');
  const D1 = Date.parse('2026-08-19T12:00:00Z');
  const domain: [number, number] = [D0, D1];
  const scale = makeScale(domain, NOW, 1000);

  it('places an in-domain run at its own time', () => {
    const p = markPlacement(NOW, domain, scale.timeToX)!;
    expect(p.clamped).toBe(false);
    expect(p.x).toBeCloseTo(scale.timeToX(NOW), 9);
    expect(scale.xToTime(p.x)).toBeCloseTo(NOW, 5);
  });

  it('clamps to the left edge and says so', () => {
    const p = markPlacement(D0 - 5 * 86400_000, domain, scale.timeToX)!;
    expect(p).toEqual({ x: 0, clamped: true });
  });

  it('clamps to the right edge and says so', () => {
    const p = markPlacement(D1 + 3600_000, domain, scale.timeToX)!;
    expect(p.clamped).toBe(true);
    expect(p.x).toBeCloseTo(1000, 9);
  });

  it('treats the exact endpoints as in-domain', () => {
    expect(markPlacement(D0, domain, scale.timeToX)!.clamped).toBe(false);
    expect(markPlacement(D1, domain, scale.timeToX)!.clamped).toBe(false);
  });

  it('returns null for an unparseable time or a degenerate domain', () => {
    expect(markPlacement(NaN, domain, scale.timeToX)).toBeNull();
    expect(markPlacement(NOW, [D1, D0], scale.timeToX)).toBeNull();
  });
});
