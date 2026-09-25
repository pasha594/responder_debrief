/**
 * Hybrid A* over (cost-grid cells ∪ road/trail nodes), pure and sliced.
 *
 * States: the cells of a search WINDOW (bbox of A and B, padded) and the
 * graph nodes whose cells lie in it. Window-local arrays keep a phone's
 * working memory proportional to the query, not the fire (a 5 km route
 * touches ~0.1M states; the whole grid can be 6M cells).
 *
 * Moves (all costs are seconds of typical time over horizontal distance):
 *   cell → cell   8-neighbour; d_h · ½(P_u + P_v) · α(grade). Diagonals may
 *                 not cut the corner of an impassable/masked cell.
 *   cell ↔ node   "portal": distance to the node · P(cell) — join or leave a
 *                 trail anywhere. Never from an impassable or masked cell.
 *   node → node   the precomputed Sullivan sub-edge cost.
 * The perimeter mask blocks cells AND graph nodes (a trail through the fire
 * is not a way around it). Graph nodes are otherwise allowed on impassable
 * cells: bridges cross rivers, switchbacks climb cliffs.
 *
 * h = straight-line distance · H_PACE · weight (admissible at weight 1).
 * `step(budget)` settles up to `budget` states and returns, so the worker
 * can yield between slices and drop a superseded search.
 */
import { H_PACE, alphaFast, gradeDeg } from './costModel';
import type { RoutingGrid } from './gridDecode';
import { MinHeap } from './heap';
import type { HybridGraph } from './hybridGraph';
import { PACE_LUT } from './pacecode';

export interface Window {
  c0: number;
  r0: number;
  c1: number; // exclusive
  r1: number; // exclusive
}

export interface SearchInput {
  grid: RoutingGrid;
  graph: HybridGraph;
  /** Perimeter mask (1 = blocked) or null when avoidance is off. */
  mask: Uint8Array | null;
  window: Window;
  /** Start / goal in grid metres (x east, y south of the origin). */
  start: { x: number; y: number; cell: number };
  goal: { x: number; y: number; cell: number };
  weight: number;
  maxSettled: number;
}

export type SearchStatus = 'running' | 'found' | 'exhausted' | 'budget';

const SQRT2 = Math.SQRT2;
const DC = [1, -1, 0, 0, 1, 1, -1, -1];
const DR = [0, 0, 1, -1, 1, -1, 1, -1];

export class HybridSearch {
  readonly ww: number;
  readonly wh: number;
  readonly wc: number;
  settled = 0;
  status: SearchStatus = 'running';
  cost = Infinity;
  private readonly g: Float64Array;
  private readonly parent: Int32Array;
  private readonly closed: Uint8Array;
  private readonly heap = new MinHeap(4096);
  private readonly goalState: number;

  constructor(private readonly inp: SearchInput) {
    const w = inp.window;
    this.ww = w.c1 - w.c0;
    this.wh = w.r1 - w.r0;
    this.wc = this.ww * this.wh;
    const total = this.wc + inp.graph.n;
    this.g = new Float64Array(total).fill(Infinity);
    this.parent = new Int32Array(total).fill(-1);
    this.closed = new Uint8Array(total);
    const s = this.cellState(inp.start.cell);
    this.goalState = this.cellState(inp.goal.cell);
    if (s < 0 || this.goalState < 0) {
      this.status = 'exhausted';
      return;
    }
    const [sx, sy] = this.cellCenter(inp.start.cell);
    const p0 = PACE_LUT[inp.grid.pace[inp.start.cell]];
    this.g[s] = Math.hypot(inp.start.x - sx, inp.start.y - sy) * (Number.isFinite(p0) ? p0 : 0);
    this.heap.push(this.g[s] + this.h(sx, sy), s);
  }

  /** Window-local state of a global cell index, or -1 outside the window. */
  cellState(cell: number): number {
    const W = this.inp.grid.width;
    const c = cell % W;
    const r = (cell - c) / W;
    const w = this.inp.window;
    if (c < w.c0 || c >= w.c1 || r < w.r0 || r >= w.r1) return -1;
    return (r - w.r0) * this.ww + (c - w.c0);
  }

  globalCell(state: number): number {
    const lc = state % this.ww;
    const lr = (state - lc) / this.ww;
    return (lr + this.inp.window.r0) * this.inp.grid.width + lc + this.inp.window.c0;
  }

  cellCenter(cell: number): [number, number] {
    const W = this.inp.grid.width;
    const c = cell % W;
    const r = (cell - c) / W;
    const k = this.inp.grid.cell;
    return [(c + 0.5) * k, (r + 0.5) * k];
  }

  private h(x: number, y: number): number {
    return Math.hypot(x - this.inp.goal.x, y - this.inp.goal.y) * H_PACE * this.inp.weight;
  }

  private cellBlocked(cell: number): boolean {
    const m = this.inp.mask;
    return !Number.isFinite(PACE_LUT[this.inp.grid.pace[cell]]) || (!!m && m[cell] === 1);
  }

  private nodeBlocked(node: number): boolean {
    const c = this.inp.graph.cell[node];
    if (c < 0 || this.cellState(c) < 0) return true;
    const m = this.inp.mask;
    return !!m && m[c] === 1;
  }

  private relax(u: number, v: number, cost: number, vx: number, vy: number): void {
    if (this.closed[v]) return;
    const ng = this.g[u] + cost;
    if (ng < this.g[v]) {
      this.g[v] = ng;
      this.parent[v] = u;
      this.heap.push(ng + this.h(vx, vy), v);
    }
  }

  step(budget: number): SearchStatus {
    if (this.status !== 'running') return this.status;
    const { grid, graph } = this.inp;
    const W = grid.width;
    const k = grid.cell;
    const wc = this.wc;
    let n = 0;
    while (n < budget) {
      const u = this.heap.pop();
      if (u < 0) {
        this.status = 'exhausted';
        return this.status;
      }
      if (this.closed[u]) continue;
      this.closed[u] = 1;
      this.settled++;
      n++;
      if (u === this.goalState) {
        const [gx, gy] = this.cellCenter(this.inp.goal.cell);
        const pg = PACE_LUT[grid.pace[this.inp.goal.cell]];
        this.cost = this.g[u] + Math.hypot(this.inp.goal.x - gx, this.inp.goal.y - gy)
          * (Number.isFinite(pg) ? pg : 0);
        this.status = 'found';
        return this.status;
      }
      if (this.settled >= this.inp.maxSettled) {
        this.status = 'budget';
        return this.status;
      }
      if (u < wc) {
        const cu = this.globalCell(u);
        const lc = u % this.ww;
        const lr = (u - lc) / this.ww;
        const pu = PACE_LUT[grid.pace[cu]];
        const zu = grid.dem[cu];
        const [ux, uy] = this.cellCenter(cu);
        // A start cell may itself be impassable only if the engine let it be
        // (it snaps first); never expand out of a blocked cell otherwise.
        if (Number.isFinite(pu)) {
          for (let d = 0; d < 8; d++) {
            const nc = lc + DC[d];
            const nr = lr + DR[d];
            if (nc < 0 || nr < 0 || nc >= this.ww || nr >= this.wh) continue;
            const cv = cu + DR[d] * W + DC[d];
            if (this.cellBlocked(cv)) continue;
            const diag = d >= 4;
            if (diag && (this.cellBlocked(cu + DC[d]) || this.cellBlocked(cu + DR[d] * W))) continue;
            const dh = diag ? k * SQRT2 : k;
            const zv = grid.dem[cv];
            const dz = zu === -32768 || zv === -32768 ? 0 : zv - zu;
            const cost = dh * 0.5 * (pu + PACE_LUT[grid.pace[cv]]) * alphaFast(gradeDeg(dz, dh));
            this.relax(u, nr * this.ww + nc, cost, ux + DC[d] * k, uy + DR[d] * k);
          }
          const span = graph.cellIndex.get(cu);
          if (span && !(this.inp.mask && this.inp.mask[cu])) {
            for (let i = span[0]; i < span[1]; i++) {
              const node = graph.cellNodes[i];
              if (this.nodeBlocked(node)) continue;
              const dist = Math.hypot(graph.x[node] - ux, graph.y[node] - uy);
              this.relax(u, wc + node, dist * pu, graph.x[node], graph.y[node]);
            }
          }
        }
      } else {
        const node = u - wc;
        for (let i = graph.adjStart[node]; i < graph.adjStart[node + 1]; i++) {
          const v = graph.adjTo[i];
          if (this.nodeBlocked(v)) continue;
          this.relax(u, wc + v, graph.adjCost[i], graph.x[v], graph.y[v]);
        }
        const cn = graph.cell[node];
        if (cn >= 0 && !this.cellBlocked(cn)) {
          const s = this.cellState(cn);
          if (s >= 0) {
            const [cx, cy] = this.cellCenter(cn);
            const dist = Math.hypot(graph.x[node] - cx, graph.y[node] - cy);
            this.relax(u, s, dist * PACE_LUT[grid.pace[cn]], cx, cy);
          }
        }
      }
    }
    return this.status;
  }

  /** States from start to goal (after 'found'). */
  path(): number[] {
    if (this.status !== 'found') return [];
    const out: number[] = [];
    for (let s = this.goalState; s >= 0; s = this.parent[s]) out.push(s);
    return out.reverse();
  }

  /** Grid-metre position of a state. */
  position(state: number): [number, number] {
    if (state < this.wc) return this.cellCenter(this.globalCell(state));
    const node = state - this.wc;
    return [this.inp.graph.x[node], this.inp.graph.y[node]];
  }

  isNode(state: number): boolean {
    return state >= this.wc;
  }
}

/** bbox(A, B) padded by clamp(½|AB|, 2 km, 15 km), clamped to the grid. */
export function searchWindow(grid: RoutingGrid, a: { x: number; y: number },
  b: { x: number; y: number }, full = false): Window {
  if (full) return { c0: 0, r0: 0, c1: grid.width, r1: grid.height };
  const pad = Math.max(2000, Math.min(15000, 0.5 * Math.hypot(a.x - b.x, a.y - b.y)));
  const k = grid.cell;
  return {
    c0: Math.max(0, Math.floor((Math.min(a.x, b.x) - pad) / k)),
    r0: Math.max(0, Math.floor((Math.min(a.y, b.y) - pad) / k)),
    c1: Math.min(grid.width, Math.ceil((Math.max(a.x, b.x) + pad) / k)),
    r1: Math.min(grid.height, Math.ceil((Math.max(a.y, b.y) + pad) / k)),
  };
}
