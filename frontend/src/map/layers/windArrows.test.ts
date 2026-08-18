import { describe, expect, it } from 'vitest';
import { windGridToFeatures, type WindUvGrid } from './windArrowsLayer';
import { windUvUrl } from '../../api/wmsUrls';
import type { WeatherRun } from '../../api/types';

/**
 * 3x2 fixture over a 30°x10° box: nx=3, ny=2, bounds [-120, 30, -90, 40].
 * Cell size 10° x 5°; row 0 = NORTH edge (lat 37.5), row 1 south (32.5).
 */
const BOUNDS: [number, number, number, number] = [-120, 30, -90, 40];

function grid(u: (number | null)[], v: (number | null)[]): WindUvGrid {
  return { nx: 3, ny: 2, bounds: BOUNDS, u, v };
}

describe('windGridToFeatures', () => {
  it('places cell centers from bounds with row 0 at the north edge', () => {
    const fc = windGridToFeatures(grid([5, 5, 5, 5, 5, 5], [0, 0, 0, 0, 0, 0]));
    expect(fc.features).toHaveLength(6);
    // row 0, col 0 → first feature: north-west cell center
    expect(fc.features[0].geometry.coordinates).toEqual([-115, 37.5]);
    // row 0, col 2 → east end of the north row
    expect(fc.features[2].geometry.coordinates).toEqual([-95, 37.5]);
    // row 1, col 0 → SOUTH row (lat decreases with row index)
    expect(fc.features[3].geometry.coordinates).toEqual([-115, 32.5]);
  });

  it('computes dir as the bearing the air moves toward', () => {
    // u=0, v=-5: wind FROM the north blowing toward the south → 180.
    const south = windGridToFeatures(grid([0, null, null, null, null, null], [-5, null, null, null, null, null]));
    expect(south.features[0].properties.dir).toBe(180);
    // u=5, v=0: blowing toward the east → 90.
    const east = windGridToFeatures(grid([5, null, null, null, null, null], [0, null, null, null, null, null]));
    expect(east.features[0].properties.dir).toBe(90);
    // u=-3, v=3: toward the north-west → 315.
    const nw = windGridToFeatures(grid([-3, null, null, null, null, null], [3, null, null, null, null, null]));
    expect(nw.features[0].properties.dir).toBe(315);
  });

  it('converts m/s to mph', () => {
    const fc = windGridToFeatures(grid([3, null, null, null, null, null], [-4, null, null, null, null, null]));
    // hypot(3, -4) = 5 m/s → 11.1847 mph
    expect(fc.features[0].properties.speed).toBeCloseTo(5 * 2.23694, 5);
  });

  it('skips nodata cells and calm cells below 1 mph', () => {
    const fc = windGridToFeatures(
      grid(
        [null, 5, 0.1, 5, null, 5],
        [3, null, 0.1, 5, null, 5],
      ),
    );
    // kept: (row0,col3? no —) indexes 3 and 5 only: u null (0), v null (1),
    // calm 0.19 m/s (2), and both-null (4) all drop.
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry.coordinates).toEqual([-115, 32.5]); // row 1, col 0
    expect(fc.features[1].geometry.coordinates).toEqual([-95, 32.5]); // row 1, col 2
  });

  it('returns empty for a grid whose arrays do not match nx*ny', () => {
    const bad: WindUvGrid = { nx: 3, ny: 2, bounds: BOUNDS, u: [1, 2], v: [1, 2] };
    expect(windGridToFeatures(bad).features).toHaveLength(0);
  });
});

describe('windUvUrl', () => {
  const run = (frames?: WeatherRun['frames']): WeatherRun => ({
    workspace: 'hrrr_20260817_20',
    run_time: '2026-08-17T20:00:00Z',
    hours: ['2026-08-17T20:00:00Z'],
    frames,
  });

  it('fills workspace and epoch_ms into the manifest template', () => {
    const r = run({
      bounds: [-125, 24.5, -66.5, 49.5],
      image_template: '/frames/weather/{ws}/{product}/{epoch_ms}.png',
      wind_uv_template: '/frames/weather/{ws}/wind_uv/{epoch_ms}.json',
      hours: ['2026-08-17T20:00:00Z'],
      complete: true,
    });
    const url = windUvUrl(r, '2026-08-17T20:00:00Z');
    expect(url).toContain('/frames/weather/hrrr_20260817_20/wind_uv/');
    expect(url).toContain(`${Date.parse('2026-08-17T20:00:00Z')}.json`);
  });

  it('returns null when the manifest predates the arrows worker', () => {
    expect(windUvUrl(run(undefined), '2026-08-17T20:00:00Z')).toBeNull();
    expect(
      windUvUrl(
        run({
          bounds: [-125, 24.5, -66.5, 49.5],
          image_template: '/frames/weather/{ws}/{product}/{epoch_ms}.png',
          hours: ['2026-08-17T20:00:00Z'],
          complete: true,
        }),
        '2026-08-17T20:00:00Z',
      ),
    ).toBeNull();
  });
});
