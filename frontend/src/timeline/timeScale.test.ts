import { describe, expect, it } from 'vitest';
import { TIMELINE_PAST_FRACTION } from '../app/config';
import { makeScale } from './timeScale';

const D0 = Date.parse('2026-08-10T00:00:00Z');
const NOW = Date.parse('2026-08-17T06:30:00Z');
const D1 = Date.parse('2026-08-19T12:00:00Z');
const W = 1000;

describe('makeScale (piecewise)', () => {
  const scale = makeScale([D0, D1], NOW, W);

  it('puts the seam at TIMELINE_PAST_FRACTION of the width, exactly at now', () => {
    expect(scale.seamX).toBeCloseTo(W * TIMELINE_PAST_FRACTION, 9);
    expect(scale.timeToX(NOW)).toBeCloseTo(W * TIMELINE_PAST_FRACTION, 9);
    expect(scale.xToTime(W * TIMELINE_PAST_FRACTION)).toBeCloseTo(NOW, 6);
  });

  it('maps the domain endpoints to the track edges', () => {
    expect(scale.timeToX(D0)).toBe(0);
    expect(scale.timeToX(D1)).toBeCloseTo(W, 9);
    expect(scale.xToTime(0)).toBe(D0);
    expect(scale.xToTime(W)).toBeCloseTo(D1, 6);
  });

  it('round-trips x → t → x across both segments', () => {
    for (const x of [0, 1, 137, 549.999, 550, 550.001, 800, 999, W]) {
      expect(scale.timeToX(scale.xToTime(x))).toBeCloseTo(x, 6);
    }
  });

  it('round-trips t → x → t across both segments', () => {
    const HOUR = 3600_000;
    for (const t of [D0, D0 + HOUR, NOW - 1, NOW, NOW + 1, NOW + 7 * HOUR, D1 - 1, D1]) {
      expect(scale.xToTime(scale.timeToX(t))).toBeCloseTo(t, 5);
    }
  });

  it('is monotonically increasing', () => {
    let prev = -Infinity;
    for (let x = 0; x <= W; x += 25) {
      const t = scale.xToTime(x);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });

  it('clamps both directions at the edges', () => {
    expect(scale.timeToX(D0 - 1e9)).toBe(0);
    expect(scale.timeToX(D1 + 1e9)).toBeCloseTo(W, 9);
    expect(scale.xToTime(-50)).toBe(D0);
    expect(scale.xToTime(W + 50)).toBeCloseTo(D1, 6);
  });

  it('uses different px/ms rates on either side of the seam', () => {
    // Past holds 55% of the pixels but most of the time span here, so the
    // pixel density must differ across the seam (that is the whole point).
    const pastRate = (scale.timeToX(NOW) - scale.timeToX(D0)) / (NOW - D0);
    const futureRate = (scale.timeToX(D1) - scale.timeToX(NOW)) / (D1 - NOW);
    expect(pastRate).not.toBeCloseTo(futureRate, 12);
  });
});

describe('makeScale (degenerate domains)', () => {
  it('falls back to linear when now is before the domain', () => {
    const s = makeScale([D0, D1], D0 - 1000, W);
    expect(s.seamX).toBeNull();
    expect(s.timeToX((D0 + D1) / 2)).toBeCloseTo(W / 2, 6);
    expect(s.xToTime(W / 2)).toBeCloseTo((D0 + D1) / 2, 5);
  });

  it('falls back to linear when now is at/after the domain end', () => {
    for (const now of [D1, D1 + 5000]) {
      const s = makeScale([D0, D1], now, W);
      expect(s.seamX).toBeNull();
      expect(s.timeToX((D0 + D1) / 2)).toBeCloseTo(W / 2, 6);
    }
  });

  it('falls back to linear when now equals domain start', () => {
    const s = makeScale([D0, D1], D0, W);
    expect(s.seamX).toBeNull();
    expect(s.timeToX(D0)).toBe(0);
    expect(s.timeToX(D1)).toBeCloseTo(W, 9);
  });

  it('handles a zero-span domain without NaN', () => {
    const s = makeScale([D0, D0], NOW, W);
    expect(s.timeToX(D0)).toBe(0);
    expect(s.timeToX(D0 + 1)).toBe(0);
    expect(s.xToTime(500)).toBe(D0);
  });

  it('handles zero width without NaN', () => {
    const s = makeScale([D0, D1], NOW, 0);
    expect(s.timeToX(NOW)).toBe(0);
    expect(s.xToTime(0)).toBe(D0);
  });

  it('round-trips in linear mode too', () => {
    const s = makeScale([D0, D1], D1 + 1, W);
    for (const x of [0, 250, 500, 750, W]) {
      expect(s.timeToX(s.xToTime(x))).toBeCloseTo(x, 6);
    }
  });
});
