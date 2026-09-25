import { describe, expect, it } from 'vitest';
import type { RoutingGrid } from './gridDecode';
import { IMPASSABLE } from './pacecode';
import { emptyTally, tallySegment } from './sampler';
import { smoothRun } from './smooth';

// 6x6 cells of 30 m, flat and uniform, with open water in cell (col 2, row 2):
// x 60–90, y 60–90. The line y = x + 27 clips that cell's corner for 4 m
// (x 60–63), between the midpoints of its 15 m pieces — the SISI case, where
// a smoothed leg ran 11 m through open water by North Fork Rainbow Creek.
function waterCorner(): RoutingGrid {
  const w = 6;
  const pace = new Uint8Array(w * w).fill(40);
  pace[2 * w + 2] = IMPASSABLE;
  return { width: w, height: w, cell: 30, pace, veg: new Uint8Array(w * w), dem: new Int16Array(w * w).fill(500) };
}

describe('cross-country segment blocked test', () => {
  it('catches a diagonal clipping an impassable corner between sample points', () => {
    const g = waterCorner();
    const t = tallySegment(g, null, 12, 39, 102, 129, emptyTally());
    expect(t.blocked).toBe(true);
    expect(t.cost).toBeGreaterThan(0); // costed on the pieces, as before
    // a parallel line 6 m clear of the corner is open
    expect(tallySegment(g, null, 12, 45, 96, 129, emptyTally()).blocked).toBe(false);
  });

  it('treats a masked corner the same way', () => {
    const g = waterCorner();
    g.pace[2 * 6 + 2] = 40;
    const mask = new Uint8Array(36);
    mask[2 * 6 + 2] = 1;
    expect(tallySegment(g, mask, 12, 39, 102, 129, emptyTally()).blocked).toBe(true);
  });

  it('never smooths a leg through the corner', () => {
    const g = waterCorner();
    // the detour is dearer than the straight line, so only the barrier
    // check keeps the smoother from taking it
    const detour: [number, number][] = [[12, 39], [45, 130], [102, 129]];
    expect(smoothRun(g, null, detour)).toEqual(detour);
    const open = waterCorner();
    open.pace[2 * 6 + 2] = 40;
    expect(smoothRun(open, null, detour)).toEqual([[12, 39], [102, 129]]);
  });
});
