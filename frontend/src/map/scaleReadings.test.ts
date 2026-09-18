import { describe, expect, it } from 'vitest';
import {
  metersPerPixel,
  panStableMetersPerPixel,
  roundDistance,
  scaleReadings,
  type CameraState,
  type ScaleLock,
} from './scaleReadings';

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

describe('metersPerPixel', () => {
  it('is the web-mercator resolution of a 512 px world', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(78271.517, 2);
    expect(metersPerPixel(60, 0)).toBeCloseTo(78271.517 / 2, 2);
    expect(metersPerPixel(0, 10)).toBeCloseTo(78271.517 / 1024, 4);
  });
});

describe('panStableMetersPerPixel', () => {
  const cam = (over: Partial<CameraState>): CameraState => {
    const c = {
      lat: 47.98,
      zoom: 12.8417,
      pitchDeg: 0,
      verticalFovDeg: 36.87,
      viewportHeightPx: 790,
      centerElevationM: 0,
      groundElevationM: 0,
      ...over,
    };
    // MapLibre keeps the pinned center elevation on the ground once synced
    return { ...c, groundElevationM: over.groundElevationM ?? c.centerElevationM };
  };

  it('is plain zoom + latitude resolution on a flat map', () => {
    const c = cam({ zoom: 10, centerElevationM: 0 });
    expect(panStableMetersPerPixel(c, null).metersPerPixel).toBeCloseTo(
      metersPerPixel(c.lat, c.zoom),
      9,
    );
  });

  // Logged from the live map (Little Giant, 3D terrain, exaggeration 1.2):
  // the [zoom, center elevation] MapLibre reported after each of four drags.
  // No zoom gesture in between — the drift is MapLibre re-basing zoom onto
  // the ground under the new center while the camera stays where it is.
  const DRAGS: [number, number][] = [
    [12.8417, 804],
    [12.7788, 427],
    [12.9475, 1401],
    [12.8317, 746],
    [12.7563, 286],
  ];

  it('holds still across drags over relief, where getZoom() alone swings 14%', () => {
    let lock: ScaleLock | null = null;
    const stable: number[] = [];
    const plain: number[] = [];
    for (const [zoom, centerElevationM] of DRAGS) {
      const c = cam({ zoom, centerElevationM });
      const r = panStableMetersPerPixel(c, lock);
      lock = r.lock;
      stable.push(r.metersPerPixel);
      plain.push(metersPerPixel(c.lat, c.zoom));
    }
    const swing = (a: number[]) => (Math.max(...a) - Math.min(...a)) / Math.min(...a);
    expect(swing(plain)).toBeGreaterThan(0.13);
    expect(swing(stable)).toBeLessThan(0.005);
    expect(stable[0]).toBeCloseTo(7.137, 2); // 713.7 m per 100 px, as logged
  });

  it('shrugs off the meter-scale elevation re-reads MapLibre does as drags start', () => {
    const first = panStableMetersPerPixel(cam({ zoom: 13.178, centerElevationM: 2039.1 }), null);
    // same zoom, elevation re-read 12 m lower from a finer terrain tile, and
    // the ground under the new center is somewhere else entirely
    const r = panStableMetersPerPixel(
      cam({ zoom: 13.178, centerElevationM: 2027, groundElevationM: 900 }),
      first.lock,
    );
    expect(r.lock.groundM).toBe(2039.1);
    expect(r.metersPerPixel / first.metersPerPixel).toBeCloseTo(1, 2);
  });

  it('re-measures when the camera height really changes (a zoom)', () => {
    const first = panStableMetersPerPixel(cam({ zoom: 12.8417, centerElevationM: 804 }), null);
    const zoomed = cam({ zoom: 13.8417, centerElevationM: 804 });
    const r = panStableMetersPerPixel(zoomed, first.lock);
    expect(r.metersPerPixel).toBeCloseTo(metersPerPixel(zoomed.lat, zoomed.zoom), 9);
    expect(r.metersPerPixel).toBeCloseTo(first.metersPerPixel / 2, 6);
  });

  it('ignores the latitude of an ordinary pan but follows a long trip north', () => {
    const start = cam({ lat: 47.98, zoom: 10 });
    const a = panStableMetersPerPixel(start, null);
    // a screen or two north at fire scale: mercator stretch moves well under 1%
    const nearby = panStableMetersPerPixel({ ...start, lat: 48.2 }, a.lock);
    expect(nearby.metersPerPixel).toBeCloseTo(a.metersPerPixel, 9);
    expect(metersPerPixel(48.2, 10)).not.toBeCloseTo(a.metersPerPixel, 2); // plain would have moved
    // Arizona, same zoom: the ground really is ~25% bigger per pixel
    const far = cam({ lat: 33.5, zoom: 10 });
    const b = panStableMetersPerPixel(far, nearby.lock);
    expect(b.metersPerPixel).toBeCloseTo(metersPerPixel(33.5, 10), 9);
    expect(b.metersPerPixel / a.metersPerPixel).toBeGreaterThan(1.2);
  });

  it('adopts the real ground once when terrain tiles land after the camera settled', () => {
    // load: MapLibre has not pinned the center to the terrain yet
    const atLoad = cam({ zoom: 12, centerElevationM: 0, groundElevationM: 0 });
    const a = panStableMetersPerPixel(atLoad, null);
    expect(a.metersPerPixel).toBeCloseTo(metersPerPixel(atLoad.lat, 12), 9);

    // same camera, terrain now loaded: the ground is 1100 m nearer the camera
    const b = panStableMetersPerPixel({ ...atLoad, groundElevationM: 1100 }, a.lock);
    expect(b.lock.groundM).toBe(1100);
    expect(b.metersPerPixel).toBeLessThan(a.metersPerPixel);

    // …and it stays there when later tiles disagree slightly
    const c = panStableMetersPerPixel({ ...atLoad, groundElevationM: 1146 }, b.lock);
    expect(c.metersPerPixel).toBe(b.metersPerPixel);
  });
});
