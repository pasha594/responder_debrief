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
 * Endpoint rules: a pin on an impassable cell (open water, > 45°) within
 * 30 m of a road or trail vertex starts on that vertex (snapToNetwork);
 * otherwise it snaps to the nearest walkable cell within 150 m. Either
 * move gets SNAP_MOVED (onto the network, from 5 m). A pin on the masked
 * perimeter — inside a fire polygon (ENDPOINT_IN_PERIM) or within the 60 m
 * standoff (ENDPOINT_NEAR_PERIM) — stays put, and the search prices the
 * mask at MASKED_PACE_X instead of blocking it: the route leaves by the
 * quickest way and otherwise stays out. When avoidance leaves no path, the
 * search reruns without it and returns `blocked_by_perimeter` with that
 * route attached — shown only if the user asks. The engine never falls
 * back to an online engine: they don't know where the fire is.
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
import { rasterizePolygons, type GridPolygon } from './rasterize';
import { gunzip, parseRdg1, str, type Rdg1 } from './rdg1';
import { nearestApproachM, pointInRings, type PolygonRings } from './safety';
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
/** A pin on impassable ground this close to a road/trail vertex is on it. */
export const NET_SNAP_M = 30;
export const PERIMETER_STANDOFF_M = 60;
/** Cost multiplier on fire and standoff cells when a pin is on them. */
export const MASKED_PACE_X = 20;
const PASS1_CAP = 2_500_000;
const PASS2_CAP = 4_000_000;

/** A route endpoint: a cell, or with `node` that graph node. */
type Pt = { x: number; y: number; cell: number; node?: number };
type Snapped = { pt: Pt; movedM: number; onto?: string | null };

export class OffroadEngine {
  /** The perimeter + standoff, rasterized (non-zero = masked). */
  mask: Uint8Array | null = null;
  maskKey: string | null = null;
  /** The same perimeter (lon/lat), for exact tests on the pins. */
  private perimeter: PolygonRings[] = [];

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
      this.perimeter = [];
      return 0;
    }
    const k = this.grid.cell;
    const gp: GridPolygon[] = polygons.map((poly) => poly.map((ring) => ring.map(([lon, lat]) => {
      const [x, y] = this.toGridM(lon, lat);
      return [x / k, y / k] as [number, number];
    })));
    this.perimeter = polygons;
    this.mask = rasterizePolygons(gp, this.grid.width, this.grid.height, marginM / k);
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

  /** The nearest road/trail vertex within NET_SNAP_M that is not masked,
   * for a pin on a cell the grid calls impassable. The worker burns rivers
   * under the roads and trails that follow them (SISI: 178 vertices on
   * river cells, where no portal reaches the network), and the nearest
   * walkable cell can lie across more river: a pin on Company Creek Road
   * was drawn wading 25 m of the Stehekin River before joining the road it
   * was dropped on, and one nearer the far bank of a river that cuts it off
   * got no route at all (engine.test.ts). */
  snapToNetwork(x: number, y: number, mask: Uint8Array | null): Snapped | null {
    const g = this.graph;
    const W = this.grid.width;
    const k = this.grid.cell;
    const c0 = Math.floor(x / k);
    const r0 = Math.floor(y / k);
    const R = Math.ceil(NET_SNAP_M / k);
    let best = -1;
    let bd = NET_SNAP_M;
    for (let r = r0 - R; r <= r0 + R; r++) {
      for (let c = c0 - R; c <= c0 + R; c++) {
        if (c < 0 || r < 0 || c >= W || r >= this.grid.height || (mask && mask[r * W + c])) continue;
        const span = g.cellIndex.get(r * W + c);
        if (!span) continue;
        for (let i = span[0]; i < span[1]; i++) {
          const n = g.cellNodes[i];
          const d = Math.hypot(g.x[n] - x, g.y[n] - y);
          if (d <= bd && g.adjStart[n] < g.adjStart[n + 1]) {
            bd = d;
            best = n;
          }
        }
      }
    }
    if (best < 0) return null;
    return {
      pt: { x: g.x[best], y: g.y[best], cell: g.cell[best], node: best },
      movedM: bd,
      onto: str(this.rdg, this.rdg.name[g.adjEdge[g.adjStart[best]]]),
    };
  }

  /** Nearest walkable cell within SNAP_M (ring by ring, true distance). */
  snap(x: number, y: number, mask: Uint8Array | null): Snapped | null {
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

  private *search(a: Pt, b: Pt, mask: Uint8Array | null, maskFactor: number | undefined, slice: number)
    : Generator<number, { s: HybridSearch | null; status: string; weighted: boolean }, void> {
    const run = function* (win: Window, weight: number, cap: number, self: OffroadEngine) {
      const s = new HybridSearch({
        grid: self.grid, graph: self.graph, mask, maskFactor, window: win,
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
    // an endpoint on a graph node (snapToNetwork) IS its state's position:
    // no cross-country stub to or from it
    const same = (p: [number, number], q: [number, number]) => p[0] === q[0] && p[1] === q[1];
    const p0 = s.position(states[0]);
    let cur: Piece | null = { kind: 'xc', pts: same(a, p0) ? [a] : [a, p0] };
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
    const pn = s.position(states[states.length - 1]);
    if (cur.kind === 'xc') {
      if (!same(cur.pts[cur.pts.length - 1], b)) cur.pts.push(b);
    } else if (!same(pn, b)) {
      pieces.push({ kind: 'xc', pts: [pn, b] });
    }
    return pieces;
  }

  private assemble(s: HybridSearch, a: [number, number], b: [number, number],
    mask: Uint8Array | null, notes: RouteNote[], weighted: boolean, t0: number,
    opts: RouteOptions, avoided: boolean): RouteResult {
    const raw = this.pieces(s, a, b);
    const pieces: Piece[] = raw.map((p) => (p.kind === 'xc'
      ? { kind: 'xc', pts: smoothRun(this.grid, mask, p.pts) } : p));
    // times are the ground's alone: a priced mask is crossed near a pin
    const legs = buildLegs({ grid: this.grid, mask: null, graph: this.graph, rdg: this.rdg,
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

  /** Notes for pins on masked cells; true when there is one. */
  private maskedPins(mask: Uint8Array, pins: [string, [number, number], [number, number]][],
    notes: RouteNote[]): boolean {
    const inside: string[] = [];
    const near: string[] = [];
    let nearM = 0;
    for (const [who, ll, [x, y]] of pins) {
      const cell = cellOf(this.grid, x, y);
      if (cell < 0 || !mask[cell]) continue;
      if (this.perimeter.some((poly) => pointInRings(ll, poly))) {
        inside.push(who);
      } else {
        near.push(who);
        nearM = Math.max(nearM, nearestApproachM([ll, ll], this.perimeter, 1000) ?? PERIMETER_STANDOFF_M);
      }
    }
    const who = (w: string[]) => (w.length > 1 ? 'A and B are' : `${w[0]} is`);
    if (inside.length) {
      const how = inside.length > 1 ? 'spends as little time in it as it can'
        : `${inside[0] === 'A' ? 'leaves' : 'enters'} it by the quickest way`;
      notes.push({ level: 'warn', code: 'ENDPOINT_IN_PERIM',
        text: `${who(inside)} inside the latest mapped fire perimeter — the route ${how}.` });
    }
    if (near.length) {
      notes.push({ level: 'warn', code: 'ENDPOINT_NEAR_PERIM',
        text: `${who(near)} within ${Math.max(10, Math.ceil(nearM / 10) * 10)} m of the latest mapped fire perimeter — the route stays out of the fire.` });
    }
    return inside.length + near.length > 0;
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
    const mask = opts.avoidPerimeter ? this.mask : null;
    // a pin on the mask: price it instead of blocking it
    const factor = mask && this.maskedPins(mask, [['A', aLL, a], ['B', bLL, b]], notes) ? MASKED_PACE_X : undefined;
    type Found = { s: HybridSearch; weighted: boolean; notes: RouteNote[];
      a: [number, number]; b: [number, number] };
    const tryRoute = function* (self: OffroadEngine, m: Uint8Array | null)
      : Generator<number, OffroadResult | Found, void> {
      const n2: RouteNote[] = [];
      const sm = factor ? null : m; // a priced mask moves no pin
      const place = (p: [number, number]) => (self.walkable(cellOf(self.grid, p[0], p[1]), sm) ? null
        : self.snapToNetwork(p[0], p[1], sm)) ?? self.snap(p[0], p[1], sm);
      const sa = place(a);
      const sb = place(b);
      if (!sa || !sb) {
        return { ok: false, code: 'no-path', message: `No walkable ground within ${SNAP_M} m of ${!sa ? 'A' : 'B'}.` };
      }
      for (const [s, w] of [[sa, 'A'], [sb, 'B']] as const) {
        if (s.pt.node != null) {
          // a finger's width off the road: only say so when it shows
          if (s.movedM >= 5) {
            n2.push({ level: 'info', code: 'SNAP_MOVED',
              text: `${w} moved ${Math.round(s.movedM)} m onto ${s.onto ?? 'the nearest road or trail'} (the ground at the pin is water, ice or a cliff).` });
          }
        } else if (s.movedM > 0) {
          n2.push({ level: 'info', code: 'SNAP_MOVED',
            text: `${w} moved ${Math.round(s.movedM)} m to the nearest walkable ground (open water, ice or a cliff at the pin).` });
        }
      }
      // a pin moved onto the network starts the drawn line there, not in the river
      const end = (s: Snapped, p: [number, number]): [number, number] => (s.pt.node != null ? [s.pt.x, s.pt.y] : p);
      const r = yield* self.search(sa.pt, sb.pt, m, factor, slice);
      if (r.s) return { s: r.s, weighted: r.weighted, notes: n2, a: end(sa, a), b: end(sb, b) };
      return r.status === 'budget'
        ? { ok: false, code: 'budget', message: 'Route search took too long on this device. Try closer points.' }
        : { ok: false, code: 'no-path', message: 'No walkable route inside the routing area — cliffs, open water, or the fire perimeter block every path.' };
    };
    const first = yield* tryRoute(this, mask);
    if ('s' in first) {
      return { ok: true, route: this.assemble(first.s, first.a, first.b, mask, [...notes, ...first.notes],
        first.weighted, t0, opts, !!mask) };
    }
    if (!first.ok && first.code === 'no-path' && mask && !factor) {
      const alt = yield* tryRoute(this, null);
      if ('s' in alt) {
        const altNotes: RouteNote[] = [{ level: 'warn', code: 'CROSSES_PERIM',
          text: 'This route goes THROUGH the latest mapped fire perimeter.' }, ...alt.notes];
        return { ok: false, code: 'blocked_by_perimeter',
          message: 'The fire perimeter blocks every walkable route between these points.',
          alternative: this.assemble(alt.s, alt.a, alt.b, null, altNotes, alt.weighted, t0, opts, false) };
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
