import { describe, expect, it } from 'vitest';
import {
  MASK_FIRE, MASK_STANDOFF, dilate, perimeterMask, rasterizePolygons, releaseEndpoint, supercoverCells,
} from './rasterize';

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

describe('perimeterMask + releaseEndpoint', () => {
  // a 6x6-cell fire at cols/rows 7–12 of a 20x20 grid, a small spot fire in
  // cell (2, 2), a 2-cell standoff
  const fire: [number, number][] = [[7, 7], [13, 7], [13, 13], [7, 13], [7, 7]];
  const spot: [number, number][] = [[2.2, 2.2], [2.8, 2.2], [2.8, 2.8], [2.2, 2.8], [2.2, 2.2]];
  const W = 20;
  const mk = () => perimeterMask([[fire], [spot]], W, W, 2);
  const at = (m: Uint8Array, c: number, r: number) => m[r * W + c];

  it('keeps the fire and its standoff apart', () => {
    const m = mk();
    expect(at(m, 10, 10)).toBe(MASK_FIRE);
    expect(at(m, 5, 10)).toBe(MASK_STANDOFF);
    expect(at(m, 4, 10)).toBe(0);
    expect(count(m.map((v) => (v ? 1 : 0)))).toBe(count(rasterizePolygons([[fire], [spot]], W, W, 2)));
  });

  it('a pin in the standoff opens a patch around it, not the ring or the fire', () => {
    const m = mk();
    releaseEndpoint(m, W, W, 10 * W + 5, false, 2);
    expect(at(m, 5, 10)).toBe(0);
    expect(at(m, 6, 10)).toBe(0);
    expect(at(m, 7, 10)).toBe(MASK_FIRE);
    expect(at(m, 6, 14)).toBe(MASK_STANDOFF); // the ring, 4 cells along
    expect(at(m, 14, 10)).toBe(MASK_STANDOFF); // the far side
  });

  it('a pin inside a polygon opens that polygon and its standoff only', () => {
    const m = mk();
    releaseEndpoint(m, W, W, 2 * W + 2, true, 2); // the spot
    expect(at(m, 2, 2)).toBe(0);
    expect(at(m, 4, 2)).toBe(0);
    expect(at(m, 10, 10)).toBe(MASK_FIRE);
    const m2 = mk();
    releaseEndpoint(m2, W, W, 10 * W + 10, true, 2); // the main fire
    expect(at(m2, 10, 10)).toBe(0);
    expect(at(m2, 5, 10)).toBe(0);
    expect(at(m2, 2, 2)).toBe(MASK_FIRE);
  });
});
