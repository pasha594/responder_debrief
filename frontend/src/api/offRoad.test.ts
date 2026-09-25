import { describe, expect, it } from 'vitest';
import { roadMissesPins } from './offRoad';
import type { RouteResult } from './routing';

// ~111 m per 0.001° of latitude
const route = (coordinates: [number, number][]): RouteResult => ({
  geometry: { type: 'LineString', coordinates },
  distanceM: 0,
  durationS: 0,
  trafficDelayS: null,
  steps: [],
  engine: 'osrm',
});

const A: [number, number] = [-120.7, 48.3];
const B: [number, number] = [-120.7, 48.35];

describe('roadMissesPins', () => {
  it('reaches pins on the road (a snap of a few metres)', () => {
    const r = route([[-120.7, 48.3001], [-120.7, 48.32], [-120.7, 48.3499]]);
    expect(roadMissesPins(r, A, B)).toBe(false);
  });

  it('misses a pin the road ends short of', () => {
    // the road stops ~1.1 km before B
    const r = route([[-120.7, 48.3001], [-120.7, 48.32], [-120.7, 48.34]]);
    expect(roadMissesPins(r, A, B)).toBe(true);
    // and ~1.1 km after A
    expect(roadMissesPins(route([[-120.7, 48.31], [-120.7, 48.35]]), A, B)).toBe(true);
  });

  it('misses both pins snapped to one road point', () => {
    const r = route([[-120.72, 48.325], [-120.72, 48.325]]);
    expect(roadMissesPins(r, A, B)).toBe(true);
  });

  it('allows a gap up to 250 m', () => {
    expect(roadMissesPins(route([[-120.7, 48.302], [-120.7, 48.3478]]), A, B)).toBe(false);
    expect(roadMissesPins(route([[-120.7, 48.3], [-120.7, 48.347]]), A, B)).toBe(true);
  });

  it('misses with no geometry', () => {
    expect(roadMissesPins(route([]), A, B)).toBe(true);
  });
});
