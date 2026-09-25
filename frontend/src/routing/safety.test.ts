import { describe, expect, it } from 'vitest';
import { crossesPerimeter, nearestApproachM, type PolygonRings } from './safety';

const sq: PolygonRings = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]];

describe('crossesPerimeter', () => {
  it('detects crossing, containment and misses', () => {
    expect(crossesPerimeter([[-1, 0.5], [2, 0.5]], [sq])).toBe(true);
    expect(crossesPerimeter([[0.2, 0.2], [0.8, 0.8]], [sq])).toBe(true);
    expect(crossesPerimeter([[-1, -1], [-0.5, 2]], [sq])).toBe(false);
  });

  it('keeps holes open', () => {
    const donut: PolygonRings = [sq[0], [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7], [0.3, 0.3]]];
    expect(crossesPerimeter([[0.4, 0.4], [0.6, 0.6]], [donut])).toBe(false);
  });

  it('is fast on a 100k-vertex perimeter', () => {
    const ring: [number, number][] = [];
    for (let i = 0; i <= 100_000; i++) {
      const t = (2 * Math.PI * i) / 100_000;
      ring.push([Math.cos(t), Math.sin(t)]);
    }
    const line: [number, number][] = Array.from({ length: 2000 }, (_, i) => [-3 + i * 0.001, 3]);
    const t0 = performance.now();
    expect(crossesPerimeter(line, [[ring]])).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('nearestApproachM', () => {
  // a ~740 m x 1.1 km box at 48.4° N (SISI); 0.001° of latitude ≈ 110.5 m
  const box: PolygonRings = [[[-120.81, 48.36], [-120.80, 48.36], [-120.80, 48.37], [-120.81, 48.37], [-120.81, 48.36]]];

  it('measures the closest pass in metres, up to the limit', () => {
    const d = nearestApproachM([[-120.82, 48.3707], [-120.79, 48.3707]], [box], 200)!;
    expect(d).toBeCloseTo(77.4, 0);
    expect(nearestApproachM([[-120.82, 48.3707], [-120.79, 48.3707]], [box], 50)).toBeNull();
    expect(nearestApproachM([[-120.82, 48.365], [-120.79, 48.365]], [box], 200)).toBe(0);
    // east–west metres shrink with cos(lat): 0.001° of longitude ≈ 73.9 m
    expect(nearestApproachM([[-120.799, 48.30], [-120.799, 48.40]], [box], 200)).toBeCloseTo(73.9, 0);
  });

  it('is fast on a 100k-vertex perimeter', () => {
    const ring: [number, number][] = [];
    for (let i = 0; i <= 100_000; i++) {
      const t = (2 * Math.PI * i) / 100_000;
      ring.push([-120.8 + 0.05 * Math.cos(t), 48.4 + 0.05 * Math.sin(t)]);
    }
    const line: [number, number][] = Array.from({ length: 2000 }, (_, i) => [-120.9 + i * 0.0001, 48.4515]);
    const t0 = performance.now();
    expect(nearestApproachM(line, [[ring]], 200)).toBeGreaterThan(100);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
