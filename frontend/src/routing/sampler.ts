/**
 * Cross-country costing along a straight segment (pure): the same model
 * the grid search uses — horizontal length × cell pace × α(grade) — but
 * sampled every ≤ half a cell, so smoothed lines and reported times are
 * costed on the line actually drawn.
 */
import { alphaFast, gradeDeg, tertileRatios } from './costModel';
import type { RoutingGrid } from './gridDecode';
import { cellOf, demAt } from './hybridGraph';
import { PACE_LUT } from './pacecode';

export interface XcTally {
  cost: number; // typical seconds
  fast: number;
  slow: number;
  blocked: boolean;
}

export function emptyTally(): XcTally {
  return { cost: 0, fast: 0, slow: 0, blocked: false };
}

/**
 * Walk one segment in ≤ `step` metre pieces. `each` (optional) sees every
 * piece: (midpoint cell, horizontal metres, grade°). A piece over an
 * impassable or masked cell marks the tally blocked (its cost is skipped:
 * the engine only lets that happen on a snapped endpoint's own cell).
 */
export function tallySegment(grid: RoutingGrid, mask: Uint8Array | null, x0: number, y0: number,
  x1: number, y1: number, t: XcTally, step = grid.cell / 2,
  each?: (cell: number, dh: number, grade: number) => void): XcTally {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(len / step));
  let px = x0;
  let py = y0;
  let pz = demAt(grid, x0, y0);
  for (let i = 1; i <= n; i++) {
    const qx = x0 + ((x1 - x0) * i) / n;
    const qy = y0 + ((y1 - y0) * i) / n;
    const qz = demAt(grid, qx, qy);
    const dh = len / n;
    const cell = cellOf(grid, (px + qx) / 2, (py + qy) / 2);
    const pace = cell >= 0 ? PACE_LUT[grid.pace[cell]] : Infinity;
    const theta = gradeDeg(qz - pz, dh);
    if (!Number.isFinite(pace) || (mask && cell >= 0 && mask[cell])) {
      t.blocked = true;
    } else {
      const c = dh * pace * alphaFast(theta);
      const r = tertileRatios(theta);
      t.cost += c;
      t.fast += c * r.fast;
      t.slow += c * r.slow;
    }
    if (each && cell >= 0) each(cell, dh, theta);
    px = qx;
    py = qy;
    pz = qz;
  }
  return t;
}

export function tallyPolyline(grid: RoutingGrid, mask: Uint8Array | null,
  pts: [number, number][], t: XcTally = emptyTally()): XcTally {
  for (let i = 0; i + 1 < pts.length; i++) {
    tallySegment(grid, mask, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], t);
  }
  return t;
}
