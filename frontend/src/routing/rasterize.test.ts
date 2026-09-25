import { describe, expect, it } from 'vitest';
import { dilate, rasterizePolygons, supercoverCells } from './rasterize';

const count = (m: Uint8Array) => m.reduce((s, v) => s + v, 0);

describe('rasterizePolygons', () => {
  it('fills cell centres inside a square', () => {
    const m = rasterizePolygons([[[[2.2, 2.2], [7.8, 2.2], [7.8, 7.8], [2.2, 7.8], [2.2, 2.2]]]], 10, 10, 0);
    expect(count(m)).toBe(36);
    expect(m[5 * 10 + 5]).toBe(1);
    expect(m[1 * 10 + 1]).toBe(0);
  });

  it('keeps holes open (even-odd) and marks thin slivers (supercover)', () => {
    const outer: [number, number][] = [[1, 1], [9, 1], [9, 9], [1, 9], [1, 1]];
    const hole: [number, number][] = [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]];
    const m = rasterizePolygons([[outer, hole]], 10, 10, 0);
    expect(m[5 * 10 + 5]).toBe(0);
    expect(m[2 * 10 + 2]).toBe(1);
    const sliver = rasterizePolygons([[[[0.2, 5.1], [9.8, 5.1], [9.8, 5.2], [0.2, 5.2], [0.2, 5.1]]]], 10, 10, 0);
    expect(count(sliver)).toBeGreaterThanOrEqual(10);
  });

  it('unions overlapping polygons (no XOR) and dilates by the standoff', () => {
    const a: [number, number][] = [[2, 2], [6, 2], [6, 6], [2, 6], [2, 2]];
    const b: [number, number][] = [[4, 4], [8, 4], [8, 8], [4, 8], [4, 4]];
    const m = rasterizePolygons([[a], [b]], 10, 10, 0);
    expect(m[5 * 10 + 5]).toBe(1);
    const d = dilate(m, 10, 10, 1);
    expect(count(d)).toBeGreaterThan(count(m));
    expect(d[1 * 10 + 3]).toBe(1);
  });
});

describe('supercoverCells', () => {
  it('visits both cells beside a corner the segment passes through', () => {
    const seen: string[] = [];
    supercoverCells(0.5, 0.5, 1.5, 1.5, (c, r) => {
      seen.push(`${c},${r}`);
    });
    expect(seen.sort()).toEqual(['0,0', '0,1', '1,0', '1,1']);
  });
});
