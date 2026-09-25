/**
 * The road/trail network as the router sees it (pure): RDG1 edges densified
 * so consecutive vertices are at most one grid cell apart, and EVERY vertex
 * becomes a node — each node is a "portal" into its grid cell, so a route
 * can join or leave a trail anywhere, not only at junctions.
 *
 * Node elevations are sampled bilinearly from the DEM and smoothed along
 * each edge ([1,2,1]/4, two passes; junctions fixed) so 30 m DEM noise
 * doesn't invent climb. Sub-edge costs are precomputed per direction:
 * horizontal length / Sullivan-moderate rate on the directional grade, times
 * the OSM sac_scale factor.
 */
import { SAC_FACTOR, gradeDeg, sullivanRate } from './costModel';
import type { RoutingGrid } from './gridDecode';
import type { Rdg1 } from './rdg1';

export interface HybridGraph {
  n: number;
  /** Metres from the grid origin: x east, y SOUTH (row direction). */
  x: Float64Array;
  y: Float64Array;
  z: Float32Array;
  /** Grid cell index of each node, -1 when outside the grid. */
  cell: Int32Array;
  adjStart: Int32Array;
  adjTo: Int32Array;
  adjCost: Float64Array;
  /** RDG1 edge index behind each adjacency entry (attributes, names). */
  adjEdge: Int32Array;
  /** grid cell → [start, end) into cellNodes. */
  cellIndex: Map<number, [number, number]>;
  cellNodes: Int32Array;
}

export function demAt(grid: RoutingGrid, x: number, y: number): number {
  const fx = x / grid.cell - 0.5;
  const fy = y / grid.cell - 0.5;
  const c0 = Math.max(0, Math.min(grid.width - 1, Math.floor(fx)));
  const r0 = Math.max(0, Math.min(grid.height - 1, Math.floor(fy)));
  const c1 = Math.min(grid.width - 1, c0 + 1);
  const r1 = Math.min(grid.height - 1, r0 + 1);
  const tx = Math.max(0, Math.min(1, fx - c0));
  const ty = Math.max(0, Math.min(1, fy - r0));
  const W = grid.width;
  const v = [grid.dem[r0 * W + c0], grid.dem[r0 * W + c1], grid.dem[r1 * W + c0], grid.dem[r1 * W + c1]];
  const wts = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
  let s = 0;
  let ws = 0;
  for (let i = 0; i < 4; i++) {
    if (v[i] === -32768) continue;
    s += v[i] * wts[i];
    ws += wts[i];
  }
  return ws > 0 ? s / ws : 0;
}

export function cellOf(grid: RoutingGrid, x: number, y: number): number {
  const c = Math.floor(x / grid.cell);
  const r = Math.floor(y / grid.cell);
  if (c < 0 || r < 0 || c >= grid.width || r >= grid.height) return -1;
  return r * grid.width + c;
}

export function buildHybridGraph(g: Rdg1, grid: RoutingGrid): HybridGraph {
  const N = g.nodes.length / 2;
  const E = g.from.length;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < N; i++) {
    xs.push(g.nodes[2 * i] / 10);
    ys.push(g.nodes[2 * i + 1] / 10);
  }
  // chains[e] = node ids along edge e (from … to), interior nodes new
  const chains: Int32Array[] = new Array(E);
  const maxSeg = grid.cell;
  for (let e = 0; e < E; e++) {
    const a = g.from[e];
    const b = g.to[e];
    let px = g.nodes[2 * a];
    let py = g.nodes[2 * a + 1];
    const verts: [number, number][] = [[px / 10, py / 10]];
    for (let k = g.dstart[e]; k < g.dstart[e + 1]; k++) {
      px += g.deltas[2 * k];
      py += g.deltas[2 * k + 1];
      verts.push([px / 10, py / 10]);
    }
    const ids: number[] = [a];
    for (let i = 1; i < verts.length; i++) {
      const [x0, y0] = verts[i - 1];
      const [x1, y1] = verts[i];
      const d = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.ceil(d / maxSeg));
      for (let k = 1; k <= n; k++) {
        if (i === verts.length - 1 && k === n) break; // the `to` node
        const t = k / n;
        xs.push(x0 + (x1 - x0) * t);
        ys.push(y0 + (y1 - y0) * t);
        ids.push(xs.length - 1);
      }
    }
    ids.push(b);
    chains[e] = Int32Array.from(ids);
  }
  const n = xs.length;
  const x = Float64Array.from(xs);
  const y = Float64Array.from(ys);
  const z = new Float32Array(n);
  const cell = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    z[i] = demAt(grid, x[i], y[i]);
    cell[i] = cellOf(grid, x[i], y[i]);
  }
  // smooth interior vertices along each chain (junction ends fixed)
  for (const ch of chains) {
    if (ch.length < 3) continue;
    for (let pass = 0; pass < 2; pass++) {
      const prev = Array.from(ch, (id) => z[id]);
      for (let k = 1; k < ch.length - 1; k++) z[ch[k]] = (prev[k - 1] + 2 * prev[k] + prev[k + 1]) / 4;
    }
  }
  // CSR adjacency, both directions per sub-edge
  const deg = new Int32Array(n + 1);
  for (const ch of chains) {
    for (let k = 0; k + 1 < ch.length; k++) {
      deg[ch[k]]++;
      deg[ch[k + 1]]++;
    }
  }
  const adjStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + deg[i];
  const m = adjStart[n];
  const adjTo = new Int32Array(m);
  const adjCost = new Float64Array(m);
  const adjEdge = new Int32Array(m);
  const fill = adjStart.slice(0, n);
  const put = (u: number, v: number, e: number, sac: number) => {
    const dh = Math.hypot(x[v] - x[u], y[v] - y[u]);
    const cost = (dh / sullivanRate(gradeDeg(z[v] - z[u], dh), 'mod')) * sac;
    const i = fill[u]++;
    adjTo[i] = v;
    adjCost[i] = cost;
    adjEdge[i] = e;
  };
  for (let e = 0; e < E; e++) {
    const ch = chains[e];
    const sac = SAC_FACTOR[g.sac[e]] ?? 1;
    for (let k = 0; k + 1 < ch.length; k++) {
      put(ch[k], ch[k + 1], e, sac);
      put(ch[k + 1], ch[k], e, sac);
    }
  }
  // cell → nodes
  const order = Array.from({ length: n }, (_, i) => i).filter((i) => cell[i] >= 0);
  order.sort((p, q) => cell[p] - cell[q]);
  const cellNodes = Int32Array.from(order);
  const cellIndex = new Map<number, [number, number]>();
  for (let i = 0; i < cellNodes.length;) {
    const c = cell[cellNodes[i]];
    let j = i;
    while (j < cellNodes.length && cell[cellNodes[j]] === c) j++;
    cellIndex.set(c, [i, j]);
    i = j;
  }
  return { n, x, y, z, cell, adjStart, adjTo, adjCost, adjEdge, cellIndex, cellNodes };
}
