import { describe, expect, it } from 'vitest';
import { NEAR_FIRE_M, nearPoint, nearPolygon } from './nearFire';
import { bucketHotspotsByDay } from './hotspotActivity';
import type { HotspotFeatureCollection } from '../api/types';

// Bull fire area, Nevada. At 39.5°N one degree of longitude is ~85.9 km.
const LAT = 39.54;
const LON = -119.99;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const east = (m: number) => LON + m / M_PER_DEG_LON;
const north = (m: number) => LAT + m / 111_320;
const MI = 1609.344;

/** Square perimeter, 2 km on a side, centred on the fire. */
const square: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [[
    [east(-1000), north(-1000)],
    [east(1000), north(-1000)],
    [east(1000), north(1000)],
    [east(-1000), north(1000)],
    [east(-1000), north(-1000)],
  ]],
};

describe('nearPolygon', () => {
  const near = nearPolygon(square, NEAR_FIRE_M)!;

  it('counts the inside and the 3 mi band, nothing beyond', () => {
    expect(near(LON, LAT)).toBe(true);
    expect(near(east(1000 + 2.8 * MI), LAT)).toBe(true);
    expect(near(east(1000 + 3.2 * MI), LAT)).toBe(false);
    expect(near(LON, north(-1000 - 2.8 * MI))).toBe(true);
    expect(near(LON, north(-1000 - 3.2 * MI))).toBe(false);
    // the band is round at the corners: 3 mi diagonally out, not 3 mi per axis
    const d = (2.5 * MI) / Math.SQRT2;
    expect(near(east(1000 + d), north(1000 + d))).toBe(true);
    const far = (3.3 * MI) / Math.SQRT2;
    expect(near(east(1000 + far), north(1000 + far))).toBe(false);
  });

  it('drops a detection 100 km away (another fire in the same box)', () => {
    expect(near(LON + 1.2, LAT)).toBe(false);
  });

  it('keeps a hole open beyond 3 mi of its edge', () => {
    const big = 20_000;
    const ring = (h: number) => [
      [east(-h), north(-h)], [east(h), north(-h)], [east(h), north(h)],
      [east(-h), north(h)], [east(-h), north(-h)],
    ];
    const holed = nearPolygon(
      { type: 'Polygon', coordinates: [ring(big), ring(big / 2)] },
      NEAR_FIRE_M,
    )!;
    expect(holed(LON, LAT)).toBe(false); // 10 km from the hole's edge
    expect(holed(east(big * 0.75), LAT)).toBe(true); // in the burned ring
  });

  it('handles MultiPolygon pieces and slivers thinner than a cell', () => {
    const sliver: GeoJSON.Position[] = [
      [east(30_000), north(0)], [east(30_000.5), north(0)],
      [east(30_000.5), north(5000)], [east(30_000), north(5000)],
      [east(30_000), north(0)],
    ];
    const multi = nearPolygon(
      { type: 'MultiPolygon', coordinates: [square.coordinates, [sliver]] },
      NEAR_FIRE_M,
    )!;
    expect(multi(east(30_000 + 2 * MI), north(2500))).toBe(true);
    expect(multi(east(15_000), north(2500))).toBe(false); // between the pieces
  });

  it('returns null for a geometry without a ring', () => {
    expect(nearPolygon({ type: 'MultiPolygon', coordinates: [] }, NEAR_FIRE_M)).toBeNull();
  });

  it('builds a large, ragged perimeter quickly', () => {
    // ~60 km across with 40k vertices, the scale of a mega fire's perimeter
    const n = 40_000;
    const ring: GeoJSON.Position[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (2 * Math.PI * i) / n;
      const r = 30_000 + 3000 * Math.sin(a * 97) + 800 * Math.sin(a * 1301);
      ring.push([east(r * Math.cos(a)), north(r * Math.sin(a))]);
    }
    ring[n] = ring[0];
    const t0 = performance.now();
    const test = nearPolygon({ type: 'Polygon', coordinates: [ring] }, NEAR_FIRE_M)!;
    const built = performance.now() - t0;
    expect(test(LON, LAT)).toBe(true);
    expect(test(east(34_000), LAT)).toBe(true); // 4 km out from the boundary at 30 km
    expect(test(east(45_000), north(45_000))).toBe(false);
    expect(built).toBeLessThan(500);
  });
});

describe('nearPoint', () => {
  it('is a 3 mi circle around the origin', () => {
    const near = nearPoint([LON, LAT], NEAR_FIRE_M);
    expect(near(east(2.9 * MI), LAT)).toBe(true);
    expect(near(east(3.1 * MI), LAT)).toBe(false);
  });
});

describe('bucketHotspotsByDay with a near-fire test', () => {
  it('counts only detections the test accepts', () => {
    const at = (lon: number, ts: number) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [lon, LAT] },
      properties: { acq_ts: ts } as HotspotFeatureCollection['features'][0]['properties'],
    });
    const ts = Date.parse('2026-10-06T20:00:00Z');
    const fc: HotspotFeatureCollection = {
      type: 'FeatureCollection',
      features: [at(LON, ts), at(LON + 0.01, ts), at(LON + 5, ts), at(-94.5, ts)],
    };
    const near = nearPolygon(square, NEAR_FIRE_M)!;
    const counts = bucketHotspotsByDay(fc, 'America/Los_Angeles', near);
    expect([...counts.values()]).toEqual([2]);
    expect([...bucketHotspotsByDay(fc, 'America/Los_Angeles').values()]).toEqual([4]);
  });
});
