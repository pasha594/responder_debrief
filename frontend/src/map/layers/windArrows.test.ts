import { describe, expect, it } from 'vitest';
import {
  arrowFeaturesForView,
  sampleWind,
  windGridToFeatures,
  type WindUvGrid,
} from './windArrowsLayer';
import { windUvUrl } from '../../api/wmsUrls';
import type { WeatherRun } from '../../api/types';

/**
 * 3x2 fixture over a 30°x10° box: nx=3, ny=2, bounds [-120, 30, -90, 40].
 * Cell size 10° lon; rows are equally spaced in MERCATOR y (the worker
 * downsamples the EPSG:3857 warp), row 0 = NORTH edge.
 */
const BOUNDS: [number, number, number, number] = [-120, 30, -90, 40];

// Independent mercator math so the tests don't just mirror the module.
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercY = (y: number) => ((Math.atan(Math.exp(y)) * 2 - Math.PI / 2) * 180) / Math.PI;
const DY_M = (mercY(40) - mercY(30)) / 2;
/** Latitude of the row-r cell center (r = 0 north, 1 south). */
const rowLat = (r: number) => invMercY(mercY(40) - (r + 0.5) * DY_M);

function grid(u: (number | null)[], v: (number | null)[]): WindUvGrid {
  return { nx: 3, ny: 2, bounds: BOUNDS, u, v };
}

describe('windGridToFeatures', () => {
  it('places cell centers at mercator-equal row spacing, row 0 north', () => {
    const fc = windGridToFeatures(grid([5, 5, 5, 5, 5, 5], [0, 0, 0, 0, 0, 0]));
    expect(fc.features).toHaveLength(6);
    // row 0, col 0 → first feature: north-west cell center
    expect(fc.features[0].geometry.coordinates[0]).toBe(-115);
    expect(fc.features[0].geometry.coordinates[1]).toBeCloseTo(rowLat(0), 10);
    // mercator-equal rows sit NORTH of the linear-lat midpoints (37.5/32.5)
    expect(fc.features[0].geometry.coordinates[1]).toBeGreaterThan(37.5);
    // row 0, col 2 → east end of the north row
    expect(fc.features[2].geometry.coordinates[0]).toBe(-95);
    // row 1, col 0 → SOUTH row (lat decreases with row index)
    expect(fc.features[3].geometry.coordinates[0]).toBe(-115);
    expect(fc.features[3].geometry.coordinates[1]).toBeCloseTo(rowLat(1), 10);
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
    expect(fc.features[0].geometry.coordinates[0]).toBe(-115); // row 1, col 0
    expect(fc.features[1].geometry.coordinates[0]).toBe(-95); // row 1, col 2
    expect(fc.features[0].geometry.coordinates[1]).toBeCloseTo(rowLat(1), 10);
  });

  it('returns empty for a grid whose arrays do not match nx*ny', () => {
    const bad: WindUvGrid = { nx: 3, ny: 2, bounds: BOUNDS, u: [1, 2], v: [1, 2] };
    expect(windGridToFeatures(bad).features).toHaveLength(0);
  });
});

describe('sampleWind', () => {
  it('returns the cell value exactly at a cell center', () => {
    const g = grid([1, 2, 3, 4, 5, 6], [0, 0, 0, 0, 0, 0]);
    // row 0 col 1 center: lon -105, y = yN - 0.5*dyM
    const uv = sampleWind(g, -105, mercY(40) - 0.5 * DY_M);
    expect(uv).not.toBeNull();
    expect(uv!.u).toBeCloseTo(2, 10);
  });

  it('averages linearly between neighboring centers', () => {
    const g = grid([1, 3, 5, 1, 3, 5], [0, 0, 0, 0, 0, 0]);
    // midway between col 0 (-115) and col 1 (-105), on the row-0 center line
    const uv = sampleWind(g, -110, mercY(40) - 0.5 * DY_M);
    expect(uv!.u).toBeCloseTo(2, 10);
  });

  it('clamps outside the grid to the edge cell', () => {
    const g = grid([7, 1, 1, 7, 1, 1], [0, 0, 0, 0, 0, 0]);
    const uv = sampleWind(g, -140, mercY(40) - 0.5 * DY_M); // far west of bounds
    expect(uv!.u).toBeCloseTo(7, 10);
  });

  it('returns null when any contributing cell is nodata', () => {
    const g = grid([1, null, 3, 4, 5, 6], [0, 0, 0, 0, 0, 0]);
    // between col 0 and the nodata col 1
    expect(sampleWind(g, -110, mercY(40) - 0.5 * DY_M)).toBeNull();
  });
});

describe('arrowFeaturesForView', () => {
  const full = () => grid([5, 5, 5, 5, 5, 5], [0, 0, 0, 0, 0, 0]);
  const VIEW_ALL: [number, number, number, number] = [-121, 29, -89, 41];

  it('matches raw density where cells land near the target spacing', () => {
    // zoom 2.6: a 10° cell is ~86px wide / ~53px tall — k=0 on both axes,
    // one arrow per raw cell.
    const fc = arrowFeaturesForView(full(), { bounds: VIEW_ALL, zoom: 2.6 });
    expect(fc.features).toHaveLength(6);
  });

  it('coarsens below raw density when zoomed far out', () => {
    // zoom 0: cells are ~14px — sampling merges cells instead of relying on
    // symbol collision to hide the crowd.
    const fc = arrowFeaturesForView(full(), { bounds: VIEW_ALL, zoom: 0 });
    expect(fc.features.length).toBeGreaterThan(0);
    expect(fc.features.length).toBeLessThan(6);
  });

  it('densifies when zoomed in', () => {
    // zoom 6: a 10° cell is ~910px → subdivided toward ~68px spacing
    const fc = arrowFeaturesForView(full(), { bounds: [-116, 32, -104, 39], zoom: 6 });
    const coarse = arrowFeaturesForView(full(), { bounds: [-116, 32, -104, 39], zoom: 2.6 });
    expect(fc.features.length).toBeGreaterThan(coarse.features.length * 4);
  });

  it('keeps lattice points anchored to the grid across pans', () => {
    const a = arrowFeaturesForView(full(), { bounds: [-116, 32, -108, 38], zoom: 6 });
    const b = arrowFeaturesForView(full(), { bounds: [-115, 33, -107, 39], zoom: 6 });
    const key = (f: { geometry: { coordinates: number[] } }) =>
      f.geometry.coordinates.map((c) => c.toFixed(8)).join(',');
    const setA = new Set(a.features.map(key));
    const shared = b.features.filter((f) => setA.has(key(f)));
    expect(shared.length).toBeGreaterThan(0); // overlap region reuses positions
  });

  it('never exceeds the feature cap', () => {
    // Absurdly deep zoom over the whole grid — cap must hold.
    const fc = arrowFeaturesForView(full(), { bounds: VIEW_ALL, zoom: 14 });
    expect(fc.features.length).toBeLessThanOrEqual(1600);
  });

  it('returns empty when the view misses the grid', () => {
    const fc = arrowFeaturesForView(full(), { bounds: [-60, 30, -50, 40], zoom: 6 });
    expect(fc.features).toHaveLength(0);
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
