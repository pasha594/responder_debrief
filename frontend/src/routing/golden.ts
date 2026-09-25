/**
 * Golden Walk routes on real fire bundles, and the measurements that check
 * them (pure; golden.test.ts runs them when ROUTING_GOLDEN_DIR points at a
 * bundle copied by worker/scripts/golden_bundle.py).
 *
 * Each route pins down one thing the SISI validation (2026-09-25) found or
 * fixed: the leave-trail penalty against switchback cuts, perimeter
 * avoidance with a pin in the standoff or inside the fire, a river crossed
 * only on a graph bridge, glaciers as walls. Pins are tied to the perimeter
 * the bundle was checked against (the copy script stores it), and each
 * route states where its pins sit on it, so a newer perimeter fails as a
 * changed precondition rather than as a routing bug.
 *
 * Bounds are the measured value with room for honest model changes, not
 * exact snapshots: a golden route should fail when routing regresses (a
 * ford instead of the bridge, a cut that saves seconds, a line through the
 * fire), not when a pace table moves a few percent.
 */
import type { RouteLeg, RouteResult } from '../api/routing';
import { LEAVE_TRAIL_PENALTY_S } from './costModel';
import type { OffroadEngine } from './engine';
import { MinHeap } from './heap';
import type { WalkLeg } from './legs';
import { PACE_LUT } from './pacecode';
import { FLAG, str } from './rdg1';
import { supercoverCells } from './rasterize';
import { nearestApproachM, pointInRings, type PolygonRings } from './safety';

type LonLat = [number, number];

/** Where a pin sits against the golden perimeter. */
export type PinZone = 'fire' | 'standoff' | 'clear';

export interface GoldenRoute {
  id: string;
  what: string;
  a: LonLat;
  b: LonLat;
  /** Perimeter avoidance (default on). */
  avoid?: boolean;
  /** Preconditions on the golden perimeter (default 'clear' for both). */
  pins?: { a?: PinZone; b?: PinZone };
  /** Precondition: the straight A–B line crosses this veg class (9 snow
   * and ice, 10 water or river), so the route has something to avoid. */
  straightCrosses?: number;
  expect: {
    /** Share of the distance on roads and trails. */
    minNetworkShare?: number;
    maxNetworkShare?: number;
    /** Cross-country metres allowed. */
    maxXcM?: number;
    /** Typical time bounds, seconds. */
    typicalS?: [number, number];
    /** The line crosses a river on a graph bridge (a name: that bridge). */
    bridge?: true | string;
    /** Trail→cross-country→trail hops allowed (switchback cuts). */
    maxCuts?: number;
    /** Leg names the route must use. */
    via?: string[];
    /** Note codes that must / must not be on the Walk route. */
    notes?: string[];
    noNotes?: string[];
    /** Streams no cross-country leg may ford (grid band 3 names). */
    noFords?: string[];
    /** Metres of line allowed inside the fire. */
    maxFireM?: number;
  };
}

/** Standoff a pin's route may pass through: it leaves a 60 m standoff by
 * the quickest way (engine.MASKED_PACE_X); 150 m covers that at 30 and 60 m
 * cells. */
export const PIN_RELEASE_M = 150;
/** Slack on a cut's saving: the search costs cell centres, the reported
 * leg the smoothed line, sampled every half cell. */
export const CUT_SAVING_SLACK_S = 10;
/** Veg classes no cross-country leg may cross, whatever the pace band
 * says: snow and ice (owner default, COST_GRID_VERSION 3), open water and
 * rivers, too steep. A bundle that makes one passable again fails here. */
export const BARRIER_CLASSES = [9, 10, 11];

const SISI_KEY = 'dc4342d9-b479-44f1-906c-8abd42e1f59c';

/** Golden routes by bundle fire_key. SISI: WA, North Cascades (Stehekin);
 * perimeter 2026-09-25T10:15:48Z from the DEV fire API; measured on bundle
 * 1318f3a35b9d (values in comments). */
export const GOLDEN: Record<string, GoldenRoute[]> = {
  [SISI_KEY]: [
    // 12.0 km, 2 h 50, 99.8% on trail
    { id: 'a', what: 'Company Creek trailhead to Company Creek Trail km 12',
      a: [-120.728996, 48.351924], b: [-120.790772, 48.275111],
      expect: { minNetworkShare: 0.97, typicalS: [2 * 3600, 4 * 3600], maxCuts: 0, via: ['Company Creek Trail'] } },
    // 11.0 km, 2 h 40, all trail
    { id: 'a2', what: 'Devore Creek trailhead to Devore Creek Trail km 11',
      a: [-120.68193, 48.316276], b: [-120.748978, 48.251041],
      expect: { minNetworkShare: 0.97, typicalS: [2 * 3600, 4 * 3600], maxCuts: 0, via: ['Devore Creek Trail'] } },
    // 10.0 km, 2 h 40, 97.8%; one 221 m cut saving 89 s (7 cuts before)
    { id: 'b', what: 'Stehekin Valley Road end to McGregor Mountain Trail km 9',
      a: [-120.850427, 48.397317], b: [-120.801831, 48.406845],
      expect: { minNetworkShare: 0.95, typicalS: [2 * 3600, 4 * 3600], maxCuts: 1, via: ['McGregor Mountain Trail'] } },
    // 9.9 km, 2 h 20, 97.2%; one 280 m cut saving 160 s
    { id: 'b_rev', what: 'b reversed: down McGregor Mountain Trail to the road end',
      a: [-120.801831, 48.406845], b: [-120.850427, 48.397317],
      expect: { minNetworkShare: 0.95, maxCuts: 1, via: ['McGregor Mountain Trail'] } },
    // 2.6 km, 1 h 20, 57%; one 72 m cut saving 110 s (2 before); fords
    // North Fork Rainbow Creek
    { id: 'c1', what: 'Rainbow Lake Trail km 6 to an off-trail rock bench',
      a: [-120.73105, 48.395648], b: [-120.748828, 48.402939],
      expect: { minNetworkShare: 0.4, maxCuts: 1, notes: ['XC_STREAM'] } },
    // 1.1 km, 1 h 45, 86% cross-country timber; fords South Fork Agnes Creek
    { id: 'c2', what: 'PCT km 7 to off-trail timber',
      a: [-120.917024, 48.329739], b: [-120.929713, 48.329393],
      expect: { maxNetworkShare: 0.4, notes: ['XC_STREAM'] } },
    // 14.6 km, 6 h 45, 76%; passes 79 m from the fire. It forded Agnes
    // Creek at Agnes Gorge before rivers were walls (10.4 km, 2 h 40).
    { id: 'd', what: 'PCT west of the fire to Stehekin Valley Road north-east of it, avoidance on',
      a: [-120.884918, 48.354245], b: [-120.786722, 48.375967],
      expect: { minNetworkShare: 0.6, notes: ['NEAR_PERIM'], noNotes: ['CROSSES_PERIM'],
        noFords: ['Agnes Creek', 'Stehekin River'] } },
    // 10.3 km, 2 h 10, down the PCT through the fire
    { id: 'd_off', what: 'd with avoidance off: through the fire, and it says so',
      a: [-120.884918, 48.354245], b: [-120.786722, 48.375967], avoid: false,
      expect: { notes: ['CROSSES_PERIM'] } },
    // 25.7 km, ~16 h: out of the fire the quickest way (660 m; the
    // nearest edge, 316 m, is over a cliff), then round by Harlequin
    // Bridge. It crossed the fire before (8.7 km, 10 h 05, 4.6 km inside).
    { id: 'e', what: 'Start inside the perimeter to Stehekin Valley Road',
      a: [-120.830681826848, 48.3466728221515], b: [-120.798008, 48.378348], pins: { a: 'fire' },
      expect: { notes: ['ENDPOINT_IN_PERIM', 'CROSSES_PERIM'], maxFireM: 800 } },
    // 6.0 km of road, 1 h 15. It forded 2.9 km from the bridge before; A
    // is on Company Creek Road over river cells (engine.snapToNetwork).
    { id: 'f', what: 'Company Creek Road to Stehekin Valley Road across the Stehekin River',
      a: [-120.744052, 48.363096], b: [-120.742202, 48.364928], straightCrosses: 10,
      expect: { bridge: 'Harlequin Bridge', maxXcM: 5, noFords: ['Stehekin River'] } },
    // 5.1 km of road, 1 h
    { id: 'f2', what: 'The same river, a second pair 274 m apart',
      a: [-120.739704, 48.360331], b: [-120.737304, 48.362202], straightCrosses: 10,
      expect: { bridge: 'Harlequin Bridge', maxXcM: 5, noFords: ['Stehekin River'] } },
    // 2.0 km, 1 h 05, over the Stehekin Valley Road bridge at High Bridge
    { id: 'f3', what: 'Either bank of the Stehekin River 330 m above High Bridge, both off the road',
      a: [-120.84418, 48.3835], b: [-120.83729, 48.3835], straightCrosses: 10,
      expect: { bridge: true, noFords: ['Stehekin River'] } },
    // 17.0 km, 8 h; closest approach 38 m (inside the pin's own standoff)
    { id: 'g', what: 'Pin 45 m outside the fire (in the 60 m standoff) to the far side of the fire',
      a: [-120.861217, 48.360274], b: [-120.786722, 48.375967], pins: { a: 'standoff' },
      expect: { notes: ['ENDPOINT_NEAR_PERIM', 'NEAR_PERIM'], noNotes: ['CROSSES_PERIM', 'ENDPOINT_IN_PERIM'] } },
    // 28.9 km, 14 h 05, round by Harlequin Bridge (the pin is across the
    // river from the road, and the fire is between)
    { id: 'g2', what: 'PCT west of the fire to a pin 45 m outside its north-east edge',
      a: [-120.884918, 48.354245], b: [-120.796982, 48.372742], pins: { b: 'standoff' },
      expect: { notes: ['ENDPOINT_NEAR_PERIM', 'NEAR_PERIM'], noNotes: ['CROSSES_PERIM', 'ENDPOINT_IN_PERIM'] } },
    // 2.1 km round the snowfield on rock, 1 h 10
    { id: 'h', what: 'Across the McGregor Mountain snowfield (435 snow/ice cells)',
      a: [-120.8016, 48.40996], b: [-120.7822, 48.40996], straightCrosses: 9, expect: {} },
    // 2.2 km round the glacier on rock, 1 h 50
    { id: 'h2', what: 'Across the glacier south of Agnes Creek (429 snow/ice cells)',
      a: [-120.895773, 48.258883], b: [-120.880424, 48.258601], straightCrosses: 9, expect: {} },
  ],
};

/** Veg classes (low nibble) the straight segment p→q passes through. */
export function straightClasses(e: OffroadEngine, p: LonLat, q: LonLat): Set<number> {
  const [x0, y0] = e.toGridM(...p);
  const [x1, y1] = e.toGridM(...q);
  const k = e.grid.cell;
  const out = new Set<number>();
  supercoverCells(x0 / k, y0 / k, x1 / k, y1 / k, (c, r) => {
    if (c >= 0 && r >= 0 && c < e.grid.width && r < e.grid.height) out.add(e.grid.veg[r * e.grid.width + c] & 0x0f);
  });
  return out;
}

export interface Cut {
  /** Leg index of the cross-country hop. */
  leg: number;
  lengthM: number;
  xcS: number;
  /** Typical seconds on the network between the hop's ends (Infinity: none). */
  networkS: number;
  savingS: number;
  from: string | null;
  to: string | null;
}

export interface RouteMeasure {
  distanceM: number;
  climbM: number;
  typicalS: number;
  rangeS: [number, number] | null;
  trailM: number;
  roadM: number;
  xcM: number;
  networkShare: number;
  cuts: Cut[];
  /** Names ('' unnamed) of river-spanning graph bridges the line runs over. */
  bridges: string[];
  /** Perimeter polygons the drawn line enters (indexes into `polys`). */
  firePolys: number[];
  /** Metres of line inside the fire. */
  fireM: number;
  /** Metres of line in masked (fire or standoff) cells farther than
   * PIN_RELEASE_M from both pins. */
  maskedFarM: number;
  crosses: boolean;
  nearestPerimM: number | null;
  /** Cells of cross-country legs (not a leg's end cells) that are
   * impassable or of a BARRIER_CLASSES class, counted by veg class. */
  xcBarriers: Record<number, number>;
  legNames: string[];
  /** Named streams the cross-country legs ford (legs.WalkLeg). */
  fords: string[];
}

const onNetwork = (l: RouteLeg) => l.kind === 'trail' || l.kind === 'road';

/** Densify a lon/lat line into ~stepM grid-metre samples (with the metres
 * each stands for). */
function samples(e: OffroadEngine, line: LonLat[], stepM: number): { x: number; y: number; m: number }[] {
  const out: { x: number; y: number; m: number }[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [x0, y0] = e.toGridM(...line[i]);
    const [x1, y1] = e.toGridM(...line[i + 1]);
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / stepM));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      out.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, m: len / n });
    }
  }
  return out;
}

function pointSegM(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Graph node at a grid-metre position (a hop's end is a portal node). */
function nodeAt(e: OffroadEngine, x: number, y: number): number {
  const g = e.graph;
  const k = e.grid.cell;
  const c0 = Math.floor(x / k);
  const r0 = Math.floor(y / k);
  let best = -1;
  let bd = 1; // metres
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const span = g.cellIndex.get((r0 + dr) * e.grid.width + c0 + dc);
      if (!span) continue;
      for (let i = span[0]; i < span[1]; i++) {
        const n = g.cellNodes[i];
        const d = Math.hypot(g.x[n] - x, g.y[n] - y);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
    }
  }
  return best;
}

/** Typical seconds on the network alone from node s to node t (Dijkstra;
 * nodes on masked cells blocked, as the search blocks them). */
function networkS(e: OffroadEngine, s: number, t: number, mask: Uint8Array | null): number {
  const g = e.graph;
  const dist = new Float64Array(g.n).fill(Infinity);
  const heap = new MinHeap(256);
  dist[s] = 0;
  heap.push(0, s);
  while (heap.size) {
    const d = heap.peekKey();
    const u = heap.pop();
    if (d > dist[u]) continue;
    if (u === t) return d;
    for (let i = g.adjStart[u]; i < g.adjStart[u + 1]; i++) {
      const v = g.adjTo[i];
      if (mask && g.cell[v] >= 0 && mask[g.cell[v]]) continue;
      const nd = d + g.adjCost[i];
      if (nd < dist[v]) {
        dist[v] = nd;
        heap.push(nd, v);
      }
    }
  }
  return Infinity;
}

/** Midpoints (grid metres) of every graph bridge edge where it spans a
 * river or water cell, with the bridge's name. */
export function riverBridges(e: OffroadEngine): { x: number; y: number; name: string }[] {
  const { rdg, grid } = e;
  const out: { x: number; y: number; name: string }[] = [];
  for (let ed = 0; ed < rdg.from.length; ed++) {
    if (!(rdg.flags[ed] & FLAG.bridge)) continue;
    let px = rdg.nodes[2 * rdg.from[ed]] / 10;
    let py = rdg.nodes[2 * rdg.from[ed] + 1] / 10;
    const pts: [number, number][] = [[px, py]];
    for (let k = rdg.dstart[ed]; k < rdg.dstart[ed + 1]; k++) {
      px += rdg.deltas[2 * k] / 10;
      py += rdg.deltas[2 * k + 1] / 10;
      pts.push([px, py]);
    }
    const wet: [number, number][] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 5));
      for (let s = 0; s < n; s++) {
        const x = x0 + ((x1 - x0) * (s + 0.5)) / n;
        const y = y0 + ((y1 - y0) * (s + 0.5)) / n;
        const c = Math.floor(y / grid.cell) * grid.width + Math.floor(x / grid.cell);
        if ((grid.veg[c] & 0x0f) === 10) wet.push([x, y]);
      }
    }
    if (wet.length) {
      const [x, y] = wet[Math.floor(wet.length / 2)];
      out.push({ x, y, name: str(rdg, rdg.name[ed]) ?? '' });
    }
  }
  return out;
}

/** Everything the golden checks read off one route. `polys` is the golden
 * perimeter (lon/lat); `mask` the engine's perimeter mask when the route
 * avoided it. */
export function measureRoute(e: OffroadEngine, r: RouteResult, a: LonLat, b: LonLat,
  polys: PolygonRings[], mask: Uint8Array | null): RouteMeasure {
  const legs = r.legs ?? [];
  const sum = (f: (l: RouteLeg) => number) => legs.reduce((s, l) => s + f(l), 0);
  const trailM = sum((l) => (l.kind === 'trail' ? l.distanceM : 0));
  const roadM = sum((l) => (l.kind === 'road' ? l.distanceM : 0));
  const xcM = sum((l) => (l.kind === 'xc' || l.kind === 'gap' ? l.distanceM : 0));

  const cuts: Cut[] = [];
  for (let i = 1; i + 1 < legs.length; i++) {
    const l = legs[i];
    if (l.kind !== 'xc' || !onNetwork(legs[i - 1]) || !onNetwork(legs[i + 1])) continue;
    const p = l.coordinates[0];
    const q = l.coordinates[l.coordinates.length - 1];
    const s = nodeAt(e, ...e.toGridM(...p));
    const t = nodeAt(e, ...e.toGridM(...q));
    const net = s >= 0 && t >= 0 ? networkS(e, s, t, mask) : Infinity;
    cuts.push({ leg: i, lengthM: l.distanceM, xcS: l.durationS ?? 0, networkS: net,
      savingS: net - (l.durationS ?? 0), from: legs[i - 1].name ?? null, to: legs[i + 1].name ?? null });
  }

  const line = r.geometry.coordinates as LonLat[];
  const pts = samples(e, line, 5);
  const bridges: string[] = [];
  for (const br of riverBridges(e)) {
    let near = false;
    for (let i = 0; i + 1 < line.length && !near; i++) {
      const [x0, y0] = e.toGridM(...line[i]);
      const [x1, y1] = e.toGridM(...line[i + 1]);
      near = pointSegM(br.x, br.y, x0, y0, x1, y1) < 3;
    }
    if (near && !bridges.includes(br.name)) bridges.push(br.name);
  }

  const firePolys = new Set<number>();
  let fireM = 0;
  let maskedFarM = 0;
  const [ax, ay] = e.toGridM(...a);
  const [bx, by] = e.toGridM(...b);
  const k = e.grid.cell;
  for (const s of pts) {
    const ll = e.toLonLat(s.x, s.y);
    let inFire = false;
    polys.forEach((poly, i) => {
      if (pointInRings(ll, poly)) {
        firePolys.add(i);
        inFire = true;
      }
    });
    if (inFire) fireM += s.m;
    if (mask) {
      const c = Math.floor(s.y / k) * e.grid.width + Math.floor(s.x / k);
      if (mask[c] && Math.hypot(s.x - ax, s.y - ay) > PIN_RELEASE_M
          && Math.hypot(s.x - bx, s.y - by) > PIN_RELEASE_M) maskedFarM += s.m;
    }
  }

  // a leg's end cells are a pin's or a graph vertex's (bridges and
  // switchbacks sit on impassable cells)
  const xcBarriers: Record<number, number> = {};
  for (const l of legs) {
    if (l.kind !== 'xc') continue;
    const p = l.coordinates.map((c) => e.toGridM(...c));
    const ends = new Set([p[0], p[p.length - 1]].map(([x, y]) => Math.floor(y / k) * e.grid.width + Math.floor(x / k)));
    for (let i = 0; i + 1 < p.length; i++) {
      supercoverCells(p[i][0] / k, p[i][1] / k, p[i + 1][0] / k, p[i + 1][1] / k, (c, rr) => {
        const cell = rr * e.grid.width + c;
        const cls = e.grid.veg[cell] & 0x0f;
        if (!ends.has(cell) && (!Number.isFinite(PACE_LUT[e.grid.pace[cell]]) || BARRIER_CLASSES.includes(cls))) {
          xcBarriers[cls] = (xcBarriers[cls] ?? 0) + 1;
        }
      });
    }
  }

  return {
    distanceM: r.distanceM,
    climbM: sum((l) => l.climbM),
    typicalS: r.durationS,
    rangeS: r.durationRangeS ?? null,
    trailM,
    roadM,
    xcM,
    networkShare: r.distanceM > 0 ? (trailM + roadM) / r.distanceM : 0,
    cuts,
    bridges,
    firePolys: [...firePolys].sort((x, y) => x - y),
    fireM,
    maskedFarM,
    crosses: firePolys.size > 0,
    nearestPerimM: nearestApproachM(line, polys, 1000),
    xcBarriers,
    legNames: [...new Set(legs.map((l) => l.name).filter((n): n is string => !!n))],
    fords: [...new Set(legs.flatMap((l) => (l as WalkLeg).streamNames ?? []).filter((n): n is string => !!n))],
  };
}

/** Where a lon/lat pin sits on the golden perimeter. */
export function pinZone(p: LonLat, polys: PolygonRings[], standoffM: number): PinZone {
  if (polys.some((poly) => pointInRings(p, poly))) return 'fire';
  const d = nearestApproachM([p, p], polys, standoffM);
  return d != null ? 'standoff' : 'clear';
}

export { LEAVE_TRAIL_PENALTY_S };
