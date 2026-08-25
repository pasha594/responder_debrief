import { describe, expect, it } from 'vitest';
import { decodePolyline6 } from './routing';

describe('decodePolyline6', () => {
  it('decodes a known valhalla shape', () => {
    // encode [(38.5, -120.2), (40.7, -120.95)] at 1e-6 by hand-verified fixture:
    // round-trip: decode(encode) — use a tiny reference produced by the
    // standard algorithm at precision 6
    const encoded = '_izlhA~rlgdF_{geC~ywl@';
    const pts = decodePolyline6(encoded);
    expect(pts.length).toBe(2);
    expect(pts[0][1]).toBeCloseTo(38.5, 5);
    expect(pts[0][0]).toBeCloseTo(-120.2, 5);
    expect(pts[1][1]).toBeCloseTo(40.7, 5);
    expect(pts[1][0]).toBeCloseTo(-120.95, 5);
  });
});

describe('apparatus + range', () => {
  it('exposes conservative apparatus dimensions', async () => {
    const { APPARATUS_DIMS } = await import('./routing');
    expect(APPARATUS_DIMS.vehicleWeight).toBeGreaterThanOrEqual(12000);
    expect(APPARATUS_DIMS.vehicleHeight).toBeGreaterThan(3);
  });
});
