/**
 * Offline Walk engine (pure orchestration — the Web Worker shell and node
 * tests both drive it).
 *
 *   load       decode grid + DEM (full resolution) and the RDG1 graph,
 *              densify the graph into portal nodes
 *   perimeter  rasterize the LATEST perimeter + standoff into a cell mask
 *   route      A→B: endpoints → search passes → pieces → smoothed legs
 *   veg        RGBA of the vegetation classes for the map layer
 *
 * Endpoint rules: a pin on an impassable cell (open water, > 45°) snaps to
 * the nearest walkable cell within 150 m (SNAP_MOVED). A pin inside the
 * masked perimeter opens only what it needs (rasterize.releaseEndpoint):
 * inside a fire polygon, that polygon (ENDPOINT_IN_PERIM); within the 60 m
 * standoff only, the bit of standoff around it (ENDPOINT_NEAR_PERIM). The
 * rest of the fire stays blocked. When avoidance leaves no path, the search
 * reruns without it and returns `blocked_by_perimeter` with that route
 * attached — shown only if the user asks. The engine never falls back to an
 * online engine: they don't know where the fire is.
 *
 * Search passes: (1) window around A–B, weight 1, 2.5M settled; if a
 * route that leaves the window could be cheaper than (1)'s (exitBound),
 * (1b) a window wide enough to hold any cheaper route, weight 1, 4M; if
 * the window has no path, (2) the whole grid, weight 1.2, 4M; if (1) ran
 * out of budget, (3) the window at weight 1.6 (WEIGHTED: near-optimal).
 */
import type { RouteNote, RouteResult } from '../api/routing';
import { lonLatToUtm, utmToLonLat } from '../spread/utm';
import { HybridSearch, searchWindow, type Window } from './astar';
import { H_PACE } from './costModel';
import { decodeGrid, type RoutingGrid } from './gridDecode';
import { buildHybridGraph, cellOf, type HybridGraph } from './hybridGraph';
import { buildLegs, fmtMiles, fordsText, stepsFor, totals, type Piece } from './legs';
import { PACE_LUT } from './pacecode';
import { perimeterMask, releaseEndpoint, type GridPolygon } from './rasterize';
import { gunzip, parseRdg1, type Rdg1 } from './rdg1';
import { pointInRings } from './safety';
import { smoothRun } from './smooth';
import type { RoutingBundle } from './types';
import { buildVegLut } from './vegClasses';

export type OffroadErrorCode =
  | 'outside-area' | 'no-path' | 'budget' | 'blocked_by_perimeter' | 'decode-failed' | 'superseded';

export type OffroadResult =
  | { ok: true; route: RouteResult }
  | { ok: false; code: OffroadErrorCode; message: string; alternative?: RouteResult };

export interface RouteOptions {
  avoidPerimeter: boolean;
  perimeterDate?: string | null;
  sliceSettled?: number;
}

export const SNAP_M = 150;
export const PERIMETER_STANDOFF_M = 60;
const PASS1_CAP = 2_500_000;
const PASS2_CAP = 4_000_000;

type Pt = { x: number; y: number; cell: number };

export class OffroadEngine {
  /** perimeterMask: MASK_FIRE / MASK_STANDOFF / 0. */
  mask: Uint8Array | null = null;
  maskKey: string | null = null;
  /** The same perimeter in grid cell units, for exact inside tests. */
  private polys: GridPolygon[] | null = null;
  private standoffCells = 0;

  constructor(
    readonly bundle: RoutingBundle,
    readonly grid: RoutingGrid,
    readonly rdg: Rdg1,
    readonly graph: HybridGraph,
  ) {}

  static async load(bundle: RoutingBundle, gridBuf: ArrayBuffer, demBuf: ArrayBuffer,
    graphGz: ArrayBuffer): Promise<OffroadEngine> {
    const grid = await decodeGrid(gridBuf, demBuf, bundle);
    const rdg = parseRdg1(await gunzip(graphGz));
    if (rdg.epsg !== bundle.crs.epsg) throw new Error('graph EPSG does not match the grid');
    return new OffroadEngine(bundle, grid, rdg, buildHybridGraph(rdg, grid));
  }

  /** lon/lat → grid metres (x east of x0, y south of y0). */
  toGridM(lon: number, lat: number): [number, number] {
    const b = this.bundle;
    const [e, n] = lonLatToUtm(lon, lat, b.crs.zone, b.crs.northern);
    return [e - b.grid.x0, b.grid.y0 - n];
  }

  toLonLat = (x: number, y: number): [number, number] => {
    const b = this.bundle;
    return utmToLonLat(b.grid.x0 + x, b.grid.y0 - y, b.crs.zone, b.crs.northern);
  };

  /** Rasterize the latest perimeter; null clears it. -> masked cell count. */
  setPerimeter(key: string | null, polygons: [number, number][][][] | null,
    marginM = PERIMETER_STANDOFF_M): number {
    this.maskKey = key;
    if (!polygons || !polygons.length) {
      this.mask = null;
      this.polys = null;
      return 0;
    }
    const k = this.grid.cell;
    const gp: GridPolygon[] = polygons.map((poly) => poly.map((ring) => ring.map(([lon, lat]) => {
      const [x, y] = this.toGridM(lon, lat);
      return [x / k, y / k] as [number, number];
    })));
    this.polys = gp;
    this.standoffCells = marginM / k;
    this.mask = perimeterMask(gp, this.grid.width, this.grid.height, this.standoffCells);
    let n = 0;
    for (let i = 0; i < this.mask.length; i++) if (this.mask[i]) n++;
    return n;
  }

  inside(lon: number, lat: number): boolean {
    const [x, y] = this.toGridM(lon, lat);
    const k = this.grid.cell;
    return x >= k && y >= k && x < (this.grid.width - 1) * k && y < (this.grid.height - 1) * k;
  }

  private walkable(cell: number, mask: Uint8Array | null): boolean {
    return cell >= 0 && Number.isFinite(PACE_LUT[this.grid.pace[cell]]) && !(mask && mask[cell]);
  }

  /** Nearest walkable cell within SNAP_M (ring by ring, true distance). */
  snap(x: number, y: number, mask: Uint8Array | null): { pt: Pt; movedM: number } | null {
    const g = this.grid;
    const cell = cellOf(g, x, y);
    if (this.walkable(cell, mask)) return { pt: { x, y, cell }, movedM: 0 };
    const k = g.cell;
    const c0 = Math.floor(x / k);
    const r0 = Math.floor(y / k);
    const R = Math.ceil(SNAP_M / k);
    let best: { d: number; c: number; r: number } | null = null;
    for (let dr = -R; dr <= R; dr++) {
      for (let dc = -R; dc <= R; dc++) {
        const c = c0 + dc;
        const r = r0 + dr;
        if (c < 0 || r < 0 || c >= g.width || r >= g.height) continue;
        const d = Math.hypot((c + 0.5) * k - x, (r + 0.5) * k - y);
        if (d > SNAP_M || (best && d >= best.d)) continue;
        if (this.walkable(r * g.width + c, mask)) best = { d, c, r };
      }
    }
    if (!best) return null;
    return {
      pt: { x: (best.c + 0.5) * k, y: (best.r + 0.5) * k, cell: best.r * g.width + best.c },
      movedM: best.d,
    };
  }

  private *search(a: Pt, b: Pt, mask: Uint8Array | null, slice: number)
    : Generator<number, { s: HybridSearch | null; status: string; weighted: boolean }, void> {
    const run = function* (win: Window, weight: number, cap: number, self: OffroadEngine) {
      const s = new HybridSearch({
        grid: self.grid, graph: self.graph, mask, window: win,
        start: a, goal: b, weight, maxSettled: cap,
      });
      for (;;) {
        const st = s.step(slice);
        if (st !== 'running') return s;
        yield s.settled;
      }
    };
    const same = (p: Window, q: Window) => p.c0 === q.c0 && p.r0 === q.r0 && p.c1 === q.c1 && p.r1 === q.r1;
    const win = searchWindow(this.grid, a, b);
    const s1 = yield* run(win, 1.0, PASS1_CAP, this);
    if (s1.status === 'found') {
      if (s1.exitBound >= s1.cost) return { s: s1, status: 'found', weighted: false };
      // A cheaper route may leave the window (SISI: a river and the fire
      // left a 23 h climb inside it; the best route, 14 h, went round by a
      // bridge outside it). Any route that leaves a window padded by
      // cost / (2 · H_PACE) costs more than s1, so the best route inside
      // that one is the best on the whole grid.
      const wide = searchWindow(this.grid, a, b, false, s1.cost / (2 * H_PACE));
      if (same(wide, win)) return { s: s1, status: 'found', weighted: false };
      const s2 = yield* run(wide, 1.0, PASS2_CAP, this);
      if (s2.status === 'found') return { s: s2, status: 'found', weighted: false };
      return { s: s1, status: 'found', weighted: true };
    }
    const full = searchWindow(this.grid, a, b, true);
    if (s1.status === 'exhausted') {
      if (same(full, win)) return { s: null, status: 'exhausted', weighted: false };
      const s2 = yield* run(full, 1.2, PASS2_CAP, this);
      return { s: s2.status === 'found' ? s2 : null, status: s2.status, weighted: true };
    }
    const s3 = yield* run(win, 1.6, PASS1_CAP, this);
    return { s: s3.status === 'found' ? s3 : null, status: s3.status, weighted: true };
  }

  private pieces(s: HybridSearch, a: [number, number], b: [number, number]): Piece[] {
    const states = s.path();
    const pieces: Piece[] = [];
    const g = this.graph;
    const edgeOf = (u: number, v: number): number => {
      let best = -1;
      let bc = Infinity;
      for (let i = g.adjStart[u]; i < g.adjStart[u + 1]; i++) {
        if (g.adjTo[i] === v && g.adjCost[i] < bc) {
          bc = g.adjCost[i];
          best = g.adjEdge[i];
        }
      }
      return best;
    };
    let cur: Piece | null = { kind: 'xc', pts: [a, s.position(states[0])] };
    pieces.push(cur);
    for (let i = 1; i < states.length; i++) {
      const p = states[i - 1];
      const q = states[i];
      if (s.isNode(p) && s.isNode(q)) {
        const u = p - s.wc;
        const v = q - s.wc;
        if (cur.kind === 'graph') {
          cur.nodes.push(v);
          cur.edges.push(edgeOf(u, v));
        } else {
          cur = { kind: 'graph', nodes: [u, v], edges: [edgeOf(u, v)] };
          pieces.push(cur);
        }
      } else if (cur.kind === 'xc') {
        cur.pts.push(s.position(q));
      } else {
        cur = { kind: 'xc', pts: [s.position(p), s.position(q)] };
        pieces.push(cur);
      }
    }
    if (cur.kind === 'xc') cur.pts.push(b);
    else pieces.push({ kind: 'xc', pts: [s.position(states[states.length - 1]), b] });
    return pieces;
  }

  private assemble(s: HybridSearch, a: [number, number], b: [number, number],
    mask: Uint8Array | null, notes: RouteNote[], weighted: boolean, t0: number,
    opts: RouteOptions, avoided: boolean): RouteResult {
    const raw = this.pieces(s, a, b);
    const pieces: Piece[] = raw.map((p) => (p.kind === 'xc'
      ? { kind: 'xc', pts: smoothRun(this.grid, mask, p.pts) } : p));
    const legs = buildLegs({ grid: this.grid, mask, graph: this.graph, rdg: this.rdg,
      toLonLat: this.toLonLat }, pieces);
    const t = totals(legs);
    const coords: [number, number][] = [];
    for (const l of legs) {
      for (const c of l.coordinates) {
        const last = coords[coords.length - 1];
        if (!last || last[0] !== c[0] || last[1] !== c[1]) coords.push(c);
      }
    }
    const fords = fordsText(legs);
    if (fords.named) {
      // bundles with stream names also route around rivers (impassable
      // water), so what's left to ford is a named creek
      notes.push({ level: 'warn', code: 'XC_STREAM',
        text: `Unbridged crossing of ${fords.text}, cross-country. Check depth and current before you commit.` });
    } else if (fords.total) {
      const what = fords.total === 1 ? 'a mapped perennial stream' : `${fords.total} mapped perennial streams`;
      const size = this.bundle.streams ? '' : " Stream size isn't modeled — a crossing may be a river.";
      notes.push({ level: 'warn', code: 'XC_STREAM',
        text: `Cross-country, the route crosses ${what} with no bridge.${size} Check it before you commit.` });
    }
    if (weighted) notes.push({ level: 'info', code: 'WEIGHTED', text: 'Long search — route is near-optimal, not guaranteed shortest.' });
    if (this.grid.cell > 30) {
      notes.push({ level: 'info', code: 'COARSE_GRID', text: `This fire's terrain model uses ${this.grid.cell} m cells — small cliffs and gullies may be missed.` });
    }
    for (const w of this.bundle.warnings ?? []) {
      const text = WARNING_TEXT[w];
      if (text) notes.push({ level: 'info', code: `BUNDLE_${w.toUpperCase()}`, text });
    }
    return {
      geometry: { type: 'LineString', coordinates: coords },
      distanceM: t.distanceM,
      durationS: t.durationS,
      trafficDelayS: null,
      steps: stepsFor(legs),
      engine: 'offroad',
      legs,
      durationRangeS: t.rangeS,
      modeled: true,
      notes,
      provenance: {
        bundleId: this.bundle.bundle_id,
        builtAt: this.bundle.built_at,
        perimeterDate: avoided ? opts.perimeterDate ?? null : null,
        avoidPerimeter: avoided,
        cellM: this.grid.cell,
        weighted,
        ms: Math.round(now() - t0),
        landfire: this.bundle.sources?.landfire?.veg ?? null,
        osmDate: this.bundle.sources?.osm?.date ?? null,
      },
    };
  }

  /** The mask to route on: `mask` itself, or a copy with the part each
   * masked pin needs opened (rasterize.releaseEndpoint). Adds the notes. */
  private releaseEndpoints(mask: Uint8Array, a: [number, number], b: [number, number],
    notes: RouteNote[]): Uint8Array {
    const k = this.grid.cell;
    const inside: string[] = [];
    const near: string[] = [];
    let out = mask;
    for (const [p, who] of [[a, 'A'], [b, 'B']] as const) {
      const cell = cellOf(this.grid, p[0], p[1]);
      if (cell < 0 || !mask[cell]) continue;
      const isIn = (this.polys ?? []).some((poly) => pointInRings([p[0] / k, p[1] / k], poly));
      if (out === mask) out = mask.slice();
      releaseEndpoint(out, this.grid.width, this.grid.height, cell, isIn, this.standoffCells);
      (isIn ? inside : near).push(who);
    }
    const who = (w: string[]) => (w.length > 1 ? 'A and B are' : `${w[0]} is`);
    const them = (w: string[]) => (w.length > 1 ? 'them' : w[0]);
    if (inside.length) {
      notes.push({ level: 'warn', code: 'ENDPOINT_IN_PERIM',
        text: `${who(inside)} inside the latest mapped fire perimeter, so the route may cross the fire near ${them(inside)}. The rest of the perimeter is still avoided.` });
    }
    if (near.length) {
      notes.push({ level: 'warn', code: 'ENDPOINT_NEAR_PERIM',
        text: `${who(near)} within ${PERIMETER_STANDOFF_M} m of the latest mapped fire perimeter. The route passes through the standoff near ${them(near)} but still avoids the fire.` });
    }
    return out;
  }

  /** Sliced route: yields settled counts; returns the result. */
  *route(aLL: [number, number], bLL: [number, number], opts: RouteOptions)
    : Generator<number, OffroadResult, void> {
    const t0 = now();
    const slice = opts.sliceSettled ?? 40_000;
    if (!this.inside(...aLL) || !this.inside(...bLL)) {
      return { ok: false, code: 'outside-area', message: 'Both points must be inside this fire\'s routing area.' };
    }
    const a = this.toGridM(...aLL);
    const b = this.toGridM(...bLL);
    const notes: RouteNote[] = [];
    const mask = opts.avoidPerimeter && this.mask ? this.releaseEndpoints(this.mask, a, b, notes) : null;
    const tryRoute = function* (self: OffroadEngine, m: Uint8Array | null)
      : Generator<number, OffroadResult | { s: HybridSearch; weighted: boolean; notes: RouteNote[] }, void> {
      const n2: RouteNote[] = [];
      const sa = self.snap(a[0], a[1], m);
      const sb = self.snap(b[0], b[1], m);
      if (!sa || !sb) {
        return { ok: false, code: 'no-path', message: `No walkable ground within ${SNAP_M} m of ${!sa ? 'A' : 'B'}.` };
      }
      for (const [s, w] of [[sa, 'A'], [sb, 'B']] as const) {
        if (s.movedM > 0) {
          n2.push({ level: 'info', code: 'SNAP_MOVED',
            text: `${w} moved ${Math.round(s.movedM)} m to the nearest walkable ground (open water, cliff or the perimeter at the pin).` });
        }
      }
      const r = yield* self.search(sa.pt, sb.pt, m, slice);
      if (r.s) return { s: r.s, weighted: r.weighted, notes: n2 };
      return r.status === 'budget'
        ? { ok: false, code: 'budget', message: 'Route search took too long on this device. Try closer points.' }
        : { ok: false, code: 'no-path', message: 'No walkable route inside the routing area — cliffs, open water, or the fire perimeter block every path.' };
    };
    const first = yield* tryRoute(this, mask);
    if ('s' in first) {
      return { ok: true, route: this.assemble(first.s, a, b, mask, [...notes, ...first.notes],
        first.weighted, t0, opts, !!mask) };
    }
    if (!first.ok && first.code === 'no-path' && mask) {
      const alt = yield* tryRoute(this, null);
      if ('s' in alt) {
        const altNotes: RouteNote[] = [{ level: 'warn', code: 'CROSSES_PERIM',
          text: 'This route goes THROUGH the latest mapped fire perimeter.' }, ...alt.notes];
        return { ok: false, code: 'blocked_by_perimeter',
          message: 'The fire perimeter blocks every walkable route between these points.',
          alternative: this.assemble(alt.s, a, b, null, altNotes, alt.weighted, t0, opts, false) };
      }
    }
    return first;
  }

  /** Vegetation classes as RGBA, nearest-downsampled to ≤ maxWidth. */
  vegImage(maxWidth: number, alpha = 255): { width: number; height: number; rgba: Uint8ClampedArray } {
    const g = this.grid;
    const scale = Math.max(1, g.width / maxWidth);
    const w = Math.max(1, Math.round(g.width / scale));
    const h = Math.max(1, Math.round(g.height / scale));
    const lut = buildVegLut(alpha);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < h; j++) {
      const r = Math.min(g.height - 1, Math.floor(((j + 0.5) * g.height) / h));
      for (let i = 0; i < w; i++) {
        const c = Math.min(g.width - 1, Math.floor(((i + 0.5) * g.width) / w));
        const v = g.veg[r * g.width + c];
        out.set(lut.subarray(v * 4, v * 4 + 4), (j * w + i) * 4);
      }
    }
    return { width: w, height: h, rgba: out };
  }
}

const WARNING_TEXT: Record<string, string> = {
  nhd_unavailable: 'Streams and lakes were unavailable for this terrain build — water crossings are not modeled.',
  trails_unavailable: 'Agency trails were unavailable for this build — OSM trails only.',
  aoi_clipped: "This fire's routing area was clipped to 150 km.",
  landfire_wcs_fallback: 'Vegetation came from the LANDFIRE backup service.',
  nodata_border: 'Part of the routing area has no terrain data (border or coast) and is treated as impassable.',
};

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Drain a sliced route synchronously (node tests). */
export function routeSync(e: OffroadEngine, a: [number, number], b: [number, number],
  opts: RouteOptions): OffroadResult {
  const it = e.route(a, b, opts);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

export { fmtMiles };
