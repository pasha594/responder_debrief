/**
 * Cost-aware line-of-sight smoothing of cross-country runs (pure). The grid
 * search moves in 8 directions, so its lines zig-zag; greedily replace
 * vertex runs with one straight segment when that segment touches no
 * impassable or masked cell AND costs no more than the original (+0.5 %).
 * The smoothed line is what gets drawn and timed, so smoothing can never
 * make a reported route slower or cut through a barrier.
 */
import type { RoutingGrid } from './gridDecode';
import { emptyTally, tallyPolyline, tallySegment } from './sampler';

const MAX_SPAN = 64;
const SLACK = 1.005;

export function smoothRun(grid: RoutingGrid, mask: Uint8Array | null,
  pts: [number, number][]): [number, number][] {
  if (pts.length <= 2) return pts.slice();
  // cumulative original cost per vertex
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    const t = tallySegment(grid, mask, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], emptyTally());
    cum[i] = cum[i - 1] + t.cost;
  }
  const out: [number, number][] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let next = i + 1;
    for (let j = Math.min(i + MAX_SPAN, pts.length - 1); j >= i + 2; j--) {
      const t = tallyPolyline(grid, mask, [pts[i], pts[j]]);
      if (!t.blocked && t.cost <= (cum[j] - cum[i]) * SLACK) {
        next = j;
        break;
      }
    }
    out.push(pts[next]);
    i = next;
  }
  return out;
}
