import { describe, expect, it } from 'vitest';
import type { RouteResult } from '../../api/routing';
import { routeFeatures } from './routeLayer';

const base: RouteResult = {
  geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
  distanceM: 10, durationS: 10, trafficDelayS: null, steps: [], engine: 'osrm',
};

describe('routeFeatures', () => {
  it('draws a legacy (drive) route as one solid feature', () => {
    const fc = routeFeatures(base);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ kind: 'road' });
    expect(routeFeatures(null).features).toHaveLength(0);
  });

  it('splits cross-country legs by vegetation run and marks joins', () => {
    const r: RouteResult = {
      ...base,
      engine: 'offroad',
      legs: [
        { kind: 'xc', coordinates: [[0, 0], [0, 1], [0, 2], [0, 3]], distanceM: 300, climbM: 0,
          descentM: 0, durationS: 300, vegRuns: [{ veg: 4, from: 0, to: 2 }, { veg: 1, from: 2, to: 3 }] },
        { kind: 'trail', coordinates: [[0, 3], [1, 3]], distanceM: 100, climbM: 0, descentM: 0, durationS: 80 },
        { kind: 'xc', coordinates: [[1, 3], [1.1, 3]], distanceM: 20, climbM: 0, descentM: 0, durationS: 30, minor: true },
        { kind: 'trail', coordinates: [[1.1, 3], [2, 3]], distanceM: 100, climbM: 0, descentM: 0, durationS: 80 },
        { kind: 'gap', coordinates: [[2, 3], [3, 3]], distanceM: 100, climbM: 0, descentM: 0, durationS: null },
      ],
    };
    const fc = routeFeatures(r);
    const kinds = fc.features.map((f) => (f.properties as { kind: string }).kind);
    expect(kinds.filter((k) => k === 'xc')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'join')).toHaveLength(1); // minor hops and gaps get none
    expect(kinds).toContain('gap');
    const firstXc = fc.features[0];
    expect((firstXc.properties as { veg: number }).veg).toBe(4);
    expect((firstXc.geometry as GeoJSON.LineString).coordinates).toHaveLength(3);
  });
});
