import { describe, expect, it } from 'vitest';
import { crossesPerimeter, type PolygonRings } from './safety';

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
