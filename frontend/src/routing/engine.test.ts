/**
 * End-to-end offline Walk on the worker-built synthetic bundle
 * (__fixtures__/synthetic, from worker/scripts/make_routing_fixture.py:
 * real GDAL GeoTIFFs + RDG1). Scene, in metres from (-115.0, 44.2):
 * forest road FS 100 along y=-4000; a path (Ridge Trail #101) from
 * (-3000,-4000) to (3000,4000) over a N–S ridge at x=0; High Traverse #202
 * from (3000,4000) east and south to the road; timber west of the ridge,
 * dense brush east; a lake at (-2000,-2500) r 500; Ridge Creek near y=1000;
 * Big Creek, an NHD order-5 river (impassable), N–S at x≈7300; the OSM
 * Wild River near (6500,-6400). grid.tif band 3 names the three.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lonLatToUtm, utmToLonLat } from '../spread/utm';
import type { RouteLeg, RouteResult } from '../api/routing';
import { HybridSearch, searchWindow, type Window } from './astar';
import { LEAVE_TRAIL_PENALTY_S, sullivanRate } from './costModel';
import { OffroadEngine, routeSync } from './engine';
import type { RoutingGrid } from './gridDecode';
import { buildHybridGraph } from './hybridGraph';
import { buildLegs, climbOf, fmtDur, stepsFor } from './legs';
import { PACE_LUT } from './pacecode';
import { KIND, type Rdg1 } from './rdg1';
import type { RoutingBundle } from './types';

const dir = new URL('./__fixtures__/synthetic/', import.meta.url);
const buf = (name: string) => {
  const b = readFileSync(new URL(name, dir));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const bundle = JSON.parse(readFileSync(new URL('bundle.json', dir), 'utf8')) as RoutingBundle;
const engineP = OffroadEngine.load(bundle, buf('grid.tif'), buf('dem.tif'), buf('graph.bin.gz'));

const [CX, CY] = lonLatToUtm(-115.0, 44.2, 11);
const at = (dx: number, dy: number) => utmToLonLat(CX + dx, CY + dy, 11) as [number, number];
const square = (cx: number, cy: number, r: number): [number, number][][][] => [[[
  at(cx - r, cy - r), at(cx + r, cy - r), at(cx + r, cy + r), at(cx - r, cy + r), at(cx - r, cy - r),
]]];

function ok(r: ReturnType<typeof routeSync>) {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.route;
}

describe('OffroadEngine on the synthetic bundle', () => {
  it('decodes the worker files at full resolution', async () => {
    const e = await engineP;
    expect(e.grid.width).toBe(bundle.grid.width);
    expect(e.grid.pace.length).toBe(bundle.grid.width * bundle.grid.height);
    expect(e.graph.n).toBeGreaterThan(100); // densified portals
    expect(e.rdg.strings).toContain('FS 100');
  });

  it('stays on the road between two road points', async () => {
    const e = await engineP;
    const r = ok(routeSync(e, at(-6000, -4000), at(6000, -4000), { avoidPerimeter: true }));
    const road = r.legs!.filter((l) => l.kind === 'road').reduce((s, l) => s + l.distanceM, 0);
    expect(road / r.distanceM).toBeGreaterThan(0.95);
    expect(r.distanceM).toBeGreaterThan(11_500);
    expect(r.distanceM).toBeLessThan(12_600);
    expect(r.legs!.some((l) => l.name === 'FS 100')).toBe(true);
    const [fast, slow] = r.durationRangeS!;
    expect(fast).toBeLessThan(r.durationS);
    expect(slow).toBeGreaterThan(r.durationS);
    expect(r.engine).toBe('offroad');
    expect(r.modeled).toBe(true);
    expect(r.steps.at(-1)?.text).toBe('Arrive at B');
  });

  it('takes the trail over the ridge rather than going cross-country', async () => {
    const e = await engineP;
    const r = ok(routeSync(e, at(-3000, -4000), at(3000, 4000), { avoidPerimeter: true }));
    const trail = r.legs!.filter((l) => l.kind === 'trail');
    expect(trail.reduce((s, l) => s + l.distanceM, 0) / r.distanceM).toBeGreaterThan(0.9);
    expect(trail.some((l) => l.name === 'Ridge Trail #101')).toBe(true);
    expect(r.legs!.reduce((s, l) => s + l.climbM, 0)).toBeGreaterThan(300); // over the ridge
  });

  it('goes cross-country where there is no trail, coloured by vegetation', async () => {
    const e = await engineP;
    const r = ok(routeSync(e, at(-5500, 2500), at(-5500, 5500), { avoidPerimeter: true }));
    const xc = r.legs!.filter((l) => l.kind === 'xc');
    expect(xc.length).toBeGreaterThan(0);
    const veg = xc[0].vegM!;
    expect(Object.keys(veg).map(Number)).toContain(4); // timber
    expect(xc[0].vegRuns!.length).toBeGreaterThan(0);
    // GET timber (M=4) on gentle ground: slower than 3 min per 100 m
    expect(r.durationS / (r.distanceM / 100)).toBeGreaterThan(120);
    expect(r.steps[0].text).toMatch(/^Head cross-country N/);
  });

  it('warns about a cross-country crossing of a mapped perennial stream, by name', async () => {
    // SISI: routes forded the Stehekin River and Agnes Creek with only
    // "crossing 1 stream" in a step (Ridge Creek here runs E–W near y=1000,
    // named in grid.tif band 3)
    const e = await engineP;
    expect(e.grid.streamNames).toEqual(['Big Creek', 'Wild River', 'Ridge Creek']);
    const r = ok(routeSync(e, at(-5000, 0), at(-5000, 2000), { avoidPerimeter: true }));
    expect(r.legs!.reduce((s, l) => s + (l.streamCrossings ?? 0), 0)).toBe(1);
    expect(r.steps[0].text).toMatch(/crossing Ridge Creek/);
    expect(r.notes!.find((x) => x.code === 'XC_STREAM')).toEqual({ level: 'warn', code: 'XC_STREAM',
      text: 'Unbridged crossing of Ridge Creek, cross-country. Check depth and current before you commit.' });
  });

  it('never fords a river: Big Creek (NHD order 5) walls off the east edge', async () => {
    const e = await engineP;
    const r = routeSync(e, at(6000, 0), at(7800, 0), { avoidPerimeter: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no-path');
  });

  it('snaps a lakeshore pin, and refuses a pin in mid-lake', async () => {
    const e = await engineP;
    const r = ok(routeSync(e, at(-2000, -2080), at(-2000, -1200), { avoidPerimeter: true }));
    expect(r.notes!.some((n) => n.code === 'SNAP_MOVED')).toBe(true);
    const mid = routeSync(e, at(-2000, -2500), at(-2000, -1200), { avoidPerimeter: true });
    expect(mid.ok).toBe(false);
    if (!mid.ok) expect(mid.message).toMatch(/150 m of A/);
  });

  it('detours around the perimeter (graph included), and never enters it', async () => {
    const e = await engineP;
    e.setPerimeter('p1', square(0, 0, 1200));
    const r = ok(routeSync(e, at(-3000, -4000), at(3000, 4000), { avoidPerimeter: true }));
    for (const [lon, lat] of r.geometry.coordinates) {
      const [x, y] = lonLatToUtm(lon, lat, 11);
      expect(Math.abs(x - CX) < 1200 && Math.abs(y - CY) < 1200).toBe(false);
    }
    const open = ok(routeSync(e, at(-3000, -4000), at(3000, 4000), { avoidPerimeter: false }));
    expect(r.durationS).toBeGreaterThan(open.durationS);
    e.setPerimeter(null, null);
  });

  const entersSquare = (r: { geometry: { coordinates: [number, number][] } }, cx: number, cy: number,
    half: number) => r.geometry.coordinates.some(([lon, lat]) => {
    const [x, y] = lonLatToUtm(lon, lat, 11);
    return Math.abs(x - CX - cx) < half && Math.abs(y - CY - cy) < half;
  });

  /** Metres of the drawn line inside the square (5 m samples). */
  const metresInSquare = (r: RouteResult, cx: number, cy: number, half: number) => {
    const pts = r.geometry.coordinates.map(([lon, lat]) => lonLatToUtm(lon, lat, 11));
    let m = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.ceil(len / 5));
      for (let k = 0; k < n; k++) {
        const x = x0 + ((x1 - x0) * (k + 0.5)) / n - CX - cx;
        const y = y0 + ((y1 - y0) * (k + 0.5)) / n - CY - cy;
        if (Math.abs(x) < half && Math.abs(y) < half) m += len / n;
      }
    }
    return m;
  };

  it('a pin inside the fire leaves it by the quickest way, not across it', async () => {
    // A is 200 m inside the west edge, B beyond the NE corner. The whole
    // polygon used to open, and the line cut across the fire toward B.
    const e = await engineP;
    e.setPerimeter('p2', square(0, 0, 1200));
    const r = ok(routeSync(e, at(-1000, 0), at(3000, 4000), { avoidPerimeter: true }));
    const inFire = metresInSquare(r, 0, 0, 1200);
    expect(inFire).toBeGreaterThan(190);
    expect(inFire).toBeLessThan(250);
    expect(r.notes!.find((n) => n.code === 'ENDPOINT_IN_PERIM')?.text)
      .toBe('A is inside the latest mapped fire perimeter — the route leaves it by the quickest way.');
    expect(r.provenance!.avoidPerimeter).toBe(true);
    e.setPerimeter(null, null);
  });

  it('a pin within the standoff, outside the fire, still routes around the fire', async () => {
    // SISI: a pin 45 m outside the edge turned avoidance off for the whole
    // route, which then ran down the PCT through the fire.
    const e = await engineP;
    e.setPerimeter('p3', square(0, 0, 1200));
    const r = ok(routeSync(e, at(-3000, -4000), at(1245, 0), { avoidPerimeter: true }));
    expect(entersSquare(r, 0, 0, 1200)).toBe(false);
    // and it crosses the 60 m ring only near B, not along the fire's edge
    const hugs = r.geometry.coordinates.filter(([lon, lat]) => {
      const [x, y] = lonLatToUtm(lon, lat, 11);
      const d = Math.max(Math.abs(x - CX), Math.abs(y - CY)) - 1200;
      return d < 30 && Math.hypot(x - CX - 1245, y - CY) > 150;
    });
    expect(hugs).toEqual([]);
    const codes = r.notes!.map((n) => n.code);
    expect(codes).toContain('ENDPOINT_NEAR_PERIM');
    expect(codes).not.toContain('ENDPOINT_IN_PERIM');
    expect(r.notes!.find((n) => n.code === 'ENDPOINT_NEAR_PERIM')!.text)
      .toBe('B is within 50 m of the latest mapped fire perimeter — the route stays out of the fire.');
    expect(r.provenance!.avoidPerimeter).toBe(true);
    e.setPerimeter(null, null);
  });

  it('a pin in a spot fire beside the main fire does not open the main fire', async () => {
    // review blocker: the spot's cells touch the main fire's, and opening
    // the spot's polygon ran on into the main fire
    const e = await engineP;
    e.setPerimeter('p4', [...square(0, 0, 1200), ...square(-1245, 0, 30)]);
    const r = ok(routeSync(e, at(-1245, 0), at(1500, 0), { avoidPerimeter: true }));
    expect(metresInSquare(r, 0, 0, 1200)).toBe(0);
    expect(r.notes!.find((n) => n.code === 'ENDPOINT_IN_PERIM')?.text).toMatch(/^A is inside/);
    e.setPerimeter(null, null);
  });

  it('returns blocked_by_perimeter with the through-route as an explicit alternative', async () => {
    const e = await engineP;
    // a ring of fire around B: B sits in the unburned hole
    const R = 1500;
    const r2 = 700;
    const ring: [number, number][][][] = [[
      [at(-5000 - R, 2500 - R), at(-5000 + R, 2500 - R), at(-5000 + R, 2500 + R), at(-5000 - R, 2500 + R), at(-5000 - R, 2500 - R)],
      [at(-5000 - r2, 2500 - r2), at(-5000 + r2, 2500 - r2), at(-5000 + r2, 2500 + r2), at(-5000 - r2, 2500 + r2), at(-5000 - r2, 2500 - r2)],
    ]];
    e.setPerimeter('ring', ring);
    const res = routeSync(e, at(-6000, -4000), at(-5000, 2500), { avoidPerimeter: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('blocked_by_perimeter');
      expect(res.alternative?.notes?.[0].code).toBe('CROSSES_PERIM');
    }
    e.setPerimeter(null, null);
  });

  it('rejects points outside the routing area', async () => {
    const e = await engineP;
    const r = routeSync(e, at(-6000, -4000), at(40_000, 0), { avoidPerimeter: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('outside-area');
  });

  it('paints the vegetation image', async () => {
    const e = await engineP;
    const img = e.vegImage(256);
    expect(img.width).toBe(256);
    expect(img.rgba.length).toBe(img.width * img.height * 4);
  });
});

describe('A* is exact at weight 1', () => {
  // xorshift for reproducible random grids
  let seed = 7;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000) / 1_000_000;
  };

  const w = 30;
  const h = 24;
  function randomGrid(blocked: number, maxCode = 120, [sc, sr] = [1, 1], [gc, gr] = [25, 21]) {
    const grid: RoutingGrid = {
      width: w, height: h, cell: 30,
      pace: Uint8Array.from({ length: w * h }, () => (rnd() < blocked ? 255 : 1 + Math.floor(rnd() * maxCode))),
      veg: new Uint8Array(w * h),
      dem: Int16Array.from({ length: w * h }, (_, i) => Math.round(1000 + 40 * Math.sin(i / 7) + rnd() * 10)),
    };
    // a straight road across the middle row, 2 nodes, decimetres
    const y = Math.round(12.5 * 300);
    const rdg = {
      epsg: 32611, x0: 0, y0: 0,
      nodes: Int32Array.from([150, y, 8850, y]),
      from: Uint32Array.from([0]), to: Uint32Array.from([1]),
      dstart: Uint32Array.from([0, 1]), deltas: Int16Array.from([8700, 0]),
      name: Uint32Array.from([0xffffffff]), ref: Uint32Array.from([0xffffffff]),
      note: Uint32Array.from([0xffffffff]), kind: Uint8Array.from([3]), src: Uint8Array.from([1]),
      sac: Uint8Array.from([0]), flags: Uint8Array.from([0]), strings: [],
    } as Rdg1;
    const graph = buildHybridGraph(rdg, grid);
    const start = { x: sc * 30 + 15, y: sr * 30 + 15, cell: sr * w + sc };
    const goal = { x: gc * 30 + 15, y: gr * 30 + 15, cell: gr * w + gc };
    grid.pace[start.cell] = 10;
    grid.pace[goal.cell] = 10;
    const run = (weight: number, win: Window, mask: Uint8Array | null = null, maskFactor?: number) => {
      const s = new HybridSearch({ grid, graph, mask, maskFactor, window: win, start, goal, weight, maxSettled: 1e7 });
      while (s.step(1e6) === 'running');
      return s;
    };
    return { run, full: searchWindow(grid, start, goal, true) };
  }

  it('matches Dijkstra (weight 0) on 40 random grids with a road', () => {
    for (let t = 0; t < 40; t++) {
      const { run, full } = randomGrid(0.12);
      const a = run(1, full);
      const d = run(0, full);
      expect(a.status).toBe(d.status);
      if (d.status === 'found') {
        expect(Math.abs(a.cost - d.cost)).toBeLessThan(1e-6 * d.cost);
        expect(a.settled).toBeLessThanOrEqual(d.settled);
      }
    }
  });

  it('exitBound never exceeds the best route that leaves the window (200 random grids and windows)', () => {
    let worse = 0;
    let certified = 0;
    for (let t = 0; t < 200; t++) {
      // start (col 9, row 6), goal (col 19, row 16), windows from tight to
      // loose around them, so the best route is often outside the window
      const { run, full } = randomGrid(0.3, 20, [9, 6], [19, 16]);
      const best = run(1, full);
      if (best.status !== 'found') continue;
      const win: Window = { c0: Math.floor(rnd() * 9), r0: Math.floor(rnd() * 6),
        c1: 20 + Math.floor(rnd() * 11), r1: 17 + Math.floor(rnd() * 8) };
      const s = run(1, win);
      const inWin = s.status === 'found' ? s.cost : Infinity;
      const tol = 1e-5 * best.cost;
      expect(inWin).toBeGreaterThanOrEqual(best.cost - tol);
      // the window's route, or else a lower bound on the one outside it
      expect(Math.min(inWin, s.exitBound)).toBeLessThanOrEqual(best.cost + tol);
      if (inWin > best.cost + tol) worse++;
      if (s.exitBound >= inWin) {
        certified++;
        expect(Math.abs(inWin - best.cost)).toBeLessThan(tol);
      }
    }
    // both cases occur (11 and 28 with this seed)
    expect(worse).toBeGreaterThan(5);
    expect(certified).toBeGreaterThan(5);
  });

  it('stays exact when masked cells and nodes cost maskFactor times more (a pin in the fire)', () => {
    for (let t = 0; t < 40; t++) {
      const { run, full } = randomGrid(0.12);
      // a third of the cells masked, start and goal included at times
      const mask = Uint8Array.from({ length: w * h }, () => (rnd() < 0.33 ? 1 : 0));
      const a = run(1, full, mask, 20);
      const d = run(0, full, mask, 20);
      expect(a.status).toBe(d.status);
      if (d.status === 'found') {
        expect(Math.abs(a.cost - d.cost)).toBeLessThan(1e-6 * d.cost);
        expect(a.cost).toBeGreaterThan(run(1, full).cost);
      }
    }
  });
});

describe('a route the search window leaves out', () => {
  // 200x60 flat cells. A river along row 30 is impassable from col 20
  // east; its west end (cols 0–19, rows 28–32) is slow brush. Bridge Road
  // runs from A (col 40, row 20) east to a bridge at col 180, and back west
  // to B (col 40, row 40): 9 km. The first window (A–B padded 2 km) holds
  // only cols 0–107, so it sees the brush but not the bridge. SISI: a pin
  // across the Stehekin River got a 23 h climb; the 14 h route used a bridge
  // outside the window.
  const W = 200;
  const H = 60;
  const X0 = 500_010;
  const Y0 = 4_900_020;
  function riverWithBridge() {
    const grid: RoutingGrid = { width: W, height: H, cell: 30, pace: new Uint8Array(W * H).fill(40),
      veg: new Uint8Array(W * H).fill(1), dem: new Int16Array(W * H).fill(600) };
    for (let c = 0; c < W; c++) grid.pace[30 * W + c] = 255;
    for (let r = 28; r <= 32; r++) for (let c = 0; c < 20; c++) grid.pace[r * W + c] = 200;
    const rdg = {
      epsg: 32611, x0: X0, y0: Y0,
      nodes: Int32Array.from([12150, 6150, 12150, 12150]),
      from: Uint32Array.from([0]), to: Uint32Array.from([1]),
      dstart: Uint32Array.from([0, 5]),
      deltas: Int16Array.from([21000, 0, 21000, 0, 0, 6000, -21000, 0, -21000, 0]),
      name: Uint32Array.from([0]), ref: Uint32Array.from([0xffffffff]), note: Uint32Array.from([0xffffffff]),
      kind: Uint8Array.from([KIND.unpaved]), src: Uint8Array.from([1]), sac: Uint8Array.from([0]),
      flags: Uint8Array.from([0]), strings: ['Bridge Road'],
    } as Rdg1;
    const b = { ...bundle, warnings: [], crs: { epsg: 32611, zone: 11, northern: true },
      grid: { x0: X0, y0: Y0, cell_m: 30, width: W, height: H } } as RoutingBundle;
    const graph = buildHybridGraph(rdg, grid);
    return { grid, graph, e: new OffroadEngine(b, grid, rdg, graph) };
  }
  const A = { x: 1215, y: 615, cell: 20 * W + 40 };
  const B = { x: 1215, y: 1215, cell: 40 * W + 40 };

  it('the first window finds only the slow way round, and knows a cheaper one may be outside', () => {
    const { grid, graph } = riverWithBridge();
    const win = searchWindow(grid, A, B);
    expect(win.c1).toBeLessThan(180);
    const s = new HybridSearch({ grid, graph, mask: null, window: win, start: A, goal: B, weight: 1, maxSettled: 1e7 });
    while (s.step(1e6) === 'running');
    expect(s.status).toBe('found');
    expect(s.cost).toBeGreaterThan(20_000); // through the brush
    expect(s.exitBound).toBeLessThan(s.cost);
  });

  it('takes the bridge outside the window, as an exact route', () => {
    const { e } = riverWithBridge();
    const r = ok(routeSync(e, e.toLonLat(A.x, A.y), e.toLonLat(B.x, B.y), { avoidPerimeter: false }));
    const road = r.legs!.filter((l) => l.kind === 'road').reduce((s, l) => s + l.distanceM, 0);
    expect(road).toBeGreaterThan(8_900);
    expect(r.legs!.some((l) => l.name === 'Bridge Road')).toBe(true);
    expect(r.durationS).toBeLessThan(10_000);
    expect(r.notes!.some((n) => n.code === 'WEIGHTED')).toBe(false);
  });
});

describe('leaving a trail costs LEAVE_TRAIL_PENALTY_S in the search, never in the times', () => {
  // Flat 40x30 grid of uniform pace; one trail with a hairpin:
  // N0 (45,465) → N1 (315,465) → N2 (315,165) → N3 (405,165) → N4 (405,465)
  // → N5 (1065,465). The hairpin N1…N4 is 690 m of trail; the cut N1→N4 is
  // 90 m of cross-country. Every vertex sits on a cell centre.
  const W = 40;
  const H = 30;
  const TRAIL = 1 / sullivanRate(0, 'mod'); // s/m, flat
  const X0 = 500_010;
  const Y0 = 4_900_020;
  const pts: [number, number][] = [[45, 465], [315, 465], [315, 165], [405, 165], [405, 465], [1065, 465]];
  function hairpin(paceCode: number) {
    const grid: RoutingGrid = { width: W, height: H, cell: 30, pace: new Uint8Array(W * H).fill(paceCode),
      veg: new Uint8Array(W * H).fill(1), dem: new Int16Array(W * H).fill(1000) };
    const deltas: number[] = [];
    for (let i = 1; i < pts.length; i++) deltas.push((pts[i][0] - pts[i - 1][0]) * 10, (pts[i][1] - pts[i - 1][1]) * 10);
    const rdg = {
      epsg: 32611, x0: X0, y0: Y0,
      nodes: Int32Array.from([pts[0][0] * 10, pts[0][1] * 10, pts[5][0] * 10, pts[5][1] * 10]),
      from: Uint32Array.from([0]), to: Uint32Array.from([1]),
      dstart: Uint32Array.from([0, 5]), deltas: Int16Array.from(deltas),
      name: Uint32Array.from([0]), ref: Uint32Array.from([0xffffffff]), note: Uint32Array.from([0xffffffff]),
      kind: Uint8Array.from([4]), src: Uint8Array.from([1]), sac: Uint8Array.from([0]),
      flags: Uint8Array.from([0]), strings: ['Hairpin Trail'],
    } as Rdg1;
    const b = { ...bundle, warnings: [], crs: { epsg: 32611, zone: 11, northern: true },
      grid: { x0: X0, y0: Y0, cell_m: 30, width: W, height: H } } as RoutingBundle;
    const e = new OffroadEngine(b, grid, rdg, buildHybridGraph(rdg, grid));
    const ll = ([x, y]: [number, number]) => e.toLonLat(x, y);
    return { e, grid, ll, pace: PACE_LUT[paceCode] };
  }
  const xcM = (r: RouteResult) => r.legs!.filter((l) => l.kind === 'xc').reduce((s, l) => s + l.distanceM, 0);
  // pace code whose cut saves `save` seconds over the hairpin (flat: α = 1)
  const codeSaving = (save: number) => {
    const pace = (690 * TRAIL - save) / 90;
    return 1 + Math.round((253 * Math.log(pace / 0.8)) / Math.log(1024));
  };

  it('no longer cuts a switchback that saves under the penalty (SISI: 7 cuts on McGregor)', () => {
    const { e, ll, pace } = hairpin(codeSaving(45));
    const saving = 690 * TRAIL - 90 * pace;
    expect(saving).toBeGreaterThan(20); // the cut IS faster on foot...
    expect(saving).toBeLessThan(LEAVE_TRAIL_PENALTY_S); // ...but not by enough
    const r = ok(routeSync(e, ll(pts[0]), ll(pts[5]), { avoidPerimeter: false }));
    expect(xcM(r)).toBeLessThan(1);
    expect(r.distanceM).toBeCloseTo(1620, 0);
    expect(r.durationS).toBeCloseTo(1620 * TRAIL, 0);
    expect(r.steps.map((s) => s.text.split(' ')[0])).toEqual(['Follow', 'Arrive']);
    // a pin ON the trail at the hairpin's foot can't cut it for free either
    const r2 = ok(routeSync(e, ll(pts[1]), ll(pts[5]), { avoidPerimeter: false }));
    expect(xcM(r2)).toBeLessThan(1);
  });

  it('still takes a cross-country shortcut that saves more than the penalty, timed without it', () => {
    const { e, ll, pace } = hairpin(codeSaving(230));
    expect(690 * TRAIL - 90 * pace).toBeGreaterThan(LEAVE_TRAIL_PENALTY_S + 100);
    const r = ok(routeSync(e, ll(pts[0]), ll(pts[5]), { avoidPerimeter: false }));
    expect(xcM(r)).toBeCloseTo(90, 0);
    expect(r.distanceM).toBeCloseTo(1020, 0);
    // reported time = trail + cross-country on the drawn line, no penalty
    expect(r.durationS).toBeCloseTo(930 * TRAIL + 90 * pace, 0);
  });

  it('charges nothing to join the trail, to arrive on it, or to start off it', () => {
    const { grid, e, pace } = hairpin(codeSaving(230));
    const g = e.graph;
    const run = (sx: number, sy: number, gx: number, gy: number) => {
      const start = { x: sx, y: sy, cell: Math.floor(sy / 30) * W + Math.floor(sx / 30) };
      const goal = { x: gx, y: gy, cell: Math.floor(gy / 30) * W + Math.floor(gx / 30) };
      const s = new HybridSearch({ grid, graph: g, mask: null, window: searchWindow(grid, start, goal, true),
        start, goal, weight: 1, maxSettled: 1e7 });
      while (s.step(1e6) === 'running');
      return s;
    };
    // on-trail start and goal (N3 → N5 along the trail): join + arrive are free
    expect(run(405, 165, 1065, 465).cost).toBeCloseTo((300 + 660) * TRAIL, 1);
    // off-network start and goal, no trail between: plain cross-country
    expect(run(645, 825, 945, 825).cost).toBeCloseTo(300 * pace, 1);
  });
});

describe('named stream crossings (bundle `streams` + grid band 3)', () => {
  // 20x20 flat cells, no roads or trails; a creek along row 10 whose west
  // half (cols 0–9) is named Company Creek in band 3 and east half unnamed
  const W = 20;
  function creek(named: boolean) {
    const grid: RoutingGrid = { width: W, height: W, cell: 30, pace: new Uint8Array(W * W).fill(20),
      veg: new Uint8Array(W * W).fill(1), dem: new Int16Array(W * W).fill(800) };
    const stream = new Uint8Array(W * W);
    for (let c = 0; c < W; c++) {
      grid.veg[10 * W + c] = 1 | 0x10;
      grid.pace[10 * W + c] = 60;
      if (c < 10) stream[10 * W + c] = 1;
    }
    if (named) {
      grid.stream = stream;
      grid.streamNames = ['Company Creek'];
    }
    const rdg = {
      epsg: 32611, x0: 500_010, y0: 4_900_020, nodes: new Int32Array(0), from: new Uint32Array(0),
      to: new Uint32Array(0), dstart: Uint32Array.from([0]), deltas: new Int16Array(0), name: new Uint32Array(0),
      ref: new Uint32Array(0), note: new Uint32Array(0), kind: new Uint8Array(0), src: new Uint8Array(0),
      sac: new Uint8Array(0), flags: new Uint8Array(0), strings: [],
    } as Rdg1;
    const b = { ...bundle, warnings: [], crs: { epsg: 32611, zone: 11, northern: true },
      grid: { x0: 500_010, y0: 4_900_020, cell_m: 30, width: W, height: W },
      streams: named ? { band: 3, names: ['Company Creek'] } : undefined } as RoutingBundle;
    const e = new OffroadEngine(b, grid, rdg, buildHybridGraph(rdg, grid));
    const route = (col: number) => ok(routeSync(e, e.toLonLat(col * 30 + 15, 135), e.toLonLat(col * 30 + 15, 465),
      { avoidPerimeter: false }));
    return route;
  }

  it('names the creek a cross-country leg fords, in the step and the warning', () => {
    const r = creek(true)(5);
    expect(r.steps[0].text).toMatch(/^Head cross-country S 0\.2 mi through grass, crossing Company Creek — about/);
    expect(r.notes!.find((n) => n.code === 'XC_STREAM')).toEqual({ level: 'warn', code: 'XC_STREAM',
      text: 'Unbridged crossing of Company Creek, cross-country. Check depth and current before you commit.' });
  });

  it('an unnamed creek in a bundle that models rivers gets the generic warning', () => {
    const r = creek(true)(15);
    expect(r.steps[0].text).toMatch(/crossing 1 stream —/);
    expect(r.notes!.find((n) => n.code === 'XC_STREAM')!.text)
      .toBe('Cross-country, the route crosses a mapped perennial stream with no bridge. Check it before you commit.');
  });

  it('a bundle without stream names keeps the old wording (rivers not modeled)', async () => {
    const r = creek(false)(5);
    expect(r.notes!.find((n) => n.code === 'XC_STREAM')!.text).toMatch(/Stream size isn't modeled/);
    // an older descriptor (no `streams`) decodes the same grid.tif without names
    const { decodeGrid } = await import('./gridDecode');
    const g = await decodeGrid(buf('grid.tif'), buf('dem.tif'), { ...bundle, streams: undefined });
    expect(g.stream).toBeUndefined();
    expect(g.streamNames).toBeUndefined();
    expect((await decodeGrid(buf('grid.tif'), buf('dem.tif'), bundle)).stream?.length).toBe(g.pace.length);
  });
});

describe('legs helpers', () => {
  it('climb hysteresis ignores sub-3 m noise', () => {
    expect(climbOf([100, 101, 100, 102, 101, 100])).toEqual({ climb: 0, descent: 0 });
    expect(climbOf([100, 104, 103, 110, 100])).toEqual({ climb: 10, descent: 10 });
  });

  it('keeps one leg along a named way whose ref comes and goes, splits on a note', () => {
    // SISI: conflation donated "1281" to only some Agnes Gorge Trail edges,
    // which read as two identical "Follow Agnes Gorge Trail" steps.
    const w = 10;
    const grid: RoutingGrid = { width: w, height: 3, cell: 30, pace: new Uint8Array(w * 3).fill(40),
      veg: new Uint8Array(w * 3), dem: new Int16Array(w * 3).fill(500) };
    const y = 450;
    const mk = (notes: number[]) => ({
      epsg: 32610, x0: 0, y0: 0,
      nodes: Int32Array.from([150, y, 450, y, 750, y, 1050, y]),
      from: Uint32Array.from([0, 1, 2]), to: Uint32Array.from([1, 2, 3]),
      dstart: Uint32Array.from([0, 1, 2, 3]), deltas: Int16Array.from([300, 0, 300, 0, 300, 0]),
      name: Uint32Array.from([0, 0, 0]), ref: Uint32Array.from([0xffffffff, 1, 0xffffffff]),
      note: Uint32Array.from(notes), kind: Uint8Array.from([4, 4, 4]), src: Uint8Array.from([1, 1, 1]),
      sac: Uint8Array.from([0, 0, 0]), flags: Uint8Array.from([64, 64, 0]),
      strings: ['Agnes Gorge Trail', '1281', 'Closed for repairs'],
    }) as Rdg1;
    const legsOf = (rdg: Rdg1) => buildLegs({ grid, mask: null, graph: buildHybridGraph(rdg, grid), rdg,
      toLonLat: (x, yy) => [x, yy] }, [{ kind: 'graph', nodes: [0, 1, 2, 3], edges: [0, 1, 2] }]);
    const one = legsOf(mk([0xffffffff, 0xffffffff, 0xffffffff]));
    expect(one.map((l) => l.name)).toEqual(['Agnes Gorge Trail']);
    expect(one[0].distanceM).toBeCloseTo(90, 5);
    const split = legsOf(mk([0xffffffff, 2, 0xffffffff]));
    expect(split.map((l) => l.restricted ?? null)).toEqual([null, 'Closed for repairs', null]);
    // OSM access=no on the middle edge only (no note): its own leg, so the
    // restriction isn't lost behind the first edge's flags
    const osm = mk([0xffffffff, 0xffffffff, 0xffffffff]);
    osm.flags = Uint8Array.from([0, 1, 0]);
    expect(legsOf(osm).map((l) => l.restricted ?? null)).toEqual([null, 'Access restricted (OSM)', null]);
  });

  it('reads one way around short cross-country cuts as one step', () => {
    const leg = (kind: RouteLeg['kind'], m: number, extra: Partial<RouteLeg> = {}): RouteLeg => ({
      kind, coordinates: [[-120.8, 48.4], [-120.79, 48.41]], distanceM: m, climbM: m / 10, descentM: 0,
      durationS: m, durationRangeS: [0.8 * m, 1.5 * m], ...extra });
    const mcg = { name: 'McGregor Mountain Trail' };
    const steps = stepsFor([
      leg('trail', 5300, mcg), leg('xc', 41, { minor: true }), leg('trail', 800, mcg),
      leg('xc', 18, { minor: true }), leg('trail', 480, mcg), leg('trail', 300, { name: 'Other Trail' }),
      leg('xc', 12, { minor: true }), leg('trail', 200, { name: 'Other Trail', restricted: 'Closed' }),
    ]).map((s) => s.text);
    expect(steps).toHaveLength(4);
    // 5300 + 41 + 800 + 18 + 480 m = 4.1 mi, timed and climbed as drawn;
    // the typical time only (no fast/slow minutes: owner call)
    expect(steps[0]).toBe('Follow McGregor Mountain Trail 4.1 mi, ↑ 2,180 ft — about 1 h 50 min · includes 2 short cross-country cuts');
    expect(steps[1]).toBe('Follow Other Trail 0.2 mi, ↑ 100 ft — about 5 min');
    expect(steps[2]).toMatch(/· Restricted: Closed$/);
    expect(steps[3]).toBe('Arrive at B');
  });

  it('formats durations', () => {
    expect(fmtDur(59 * 60)).toBe('59 min');
    expect(fmtDur(125 * 60)).toBe('2 h 05 min');
    expect(fmtDur(120 * 60)).toBe('2 h');
  });
});

describe('a pin on a road the grid calls river', () => {
  // 60x40 flat cells. A river on rows 20–21 (y 600–660) is impassable
  // across the whole grid. River Road leaves the north bank at x=105, runs
  // ON the river's north row (y=612) to x=1695, and returns to the north
  // bank: the worker burns rivers under the roads that follow them (SISI:
  // 178 vertices of Company Creek Road, Stehekin Valley Road, ...), and a
  // pin there snapped to the nearest walkable cell — sometimes the far bank.
  const W = 60;
  const H = 40;
  const X0 = 500_010;
  const Y0 = 4_900_020;
  function riverRoad() {
    const grid: RoutingGrid = { width: W, height: H, cell: 30, pace: new Uint8Array(W * H).fill(40),
      veg: new Uint8Array(W * H).fill(1), dem: new Int16Array(W * H).fill(500) };
    for (let r = 20; r <= 21; r++) {
      for (let c = 0; c < W; c++) {
        grid.pace[r * W + c] = 255;
        grid.veg[r * W + c] = 10;
      }
    }
    const rdg = {
      epsg: 32611, x0: X0, y0: Y0,
      nodes: Int32Array.from([1050, 4350, 16950, 4350]),
      from: Uint32Array.from([0]), to: Uint32Array.from([1]),
      dstart: Uint32Array.from([0, 3]),
      deltas: Int16Array.from([0, 1770, 15900, 0, 0, -1770]),
      name: Uint32Array.from([0]), ref: Uint32Array.from([0xffffffff]), note: Uint32Array.from([0xffffffff]),
      kind: Uint8Array.from([KIND.unpaved]), src: Uint8Array.from([1]), sac: Uint8Array.from([0]),
      flags: Uint8Array.from([0]), strings: ['River Road'],
    } as Rdg1;
    const b = { ...bundle, warnings: [], crs: { epsg: 32611, zone: 11, northern: true },
      grid: { x0: X0, y0: Y0, cell_m: 30, width: W, height: H } } as RoutingBundle;
    const e = new OffroadEngine(b, grid, rdg, buildHybridGraph(rdg, grid));
    return { e, ll: (x: number, y: number) => e.toLonLat(x, y) };
  }
  const water = (r: RouteResult) => r.legs!.reduce((s, l) => s + (l.vegM?.[10] ?? 0), 0);

  it('a pin on the road starts on the road, not wading from it', () => {
    // both pins on road vertices (densified every 30 m from x=105)
    const { e, ll } = riverRoad();
    const r = ok(routeSync(e, ll(915, 612), ll(1515, 612), { avoidPerimeter: false }));
    expect(r.legs!.map((l) => l.kind)).toEqual(['road']);
    expect(r.distanceM).toBeCloseTo(600, 0);
    expect(water(r)).toBe(0);
    expect(r.steps[0].text).toMatch(/^Continue on River Road 0\.4 mi/);
    expect(r.notes!.map((n) => n.code)).not.toContain('SNAP_MOVED');
  });

  it('a pin nearer the far bank than the near one still starts on the road', () => {
    // 28 m south of the road: the nearest walkable cell centre is on the
    // SOUTH bank (35 m), which the river cuts off from B on the north bank
    const { e, ll } = riverRoad();
    const r = ok(routeSync(e, ll(915, 640), ll(915, 435), { avoidPerimeter: false }));
    expect(r.legs![0].kind).toBe('road');
    expect(r.legs![0].name).toBe('River Road');
    expect(water(r)).toBe(0);
    expect(r.notes!.find((n) => n.code === 'SNAP_MOVED')?.text)
      .toBe('A moved 28 m onto River Road (the ground at the pin is water, ice or a cliff).');
    // it reaches the north bank the only way there is: off the road's end
    expect(r.legs!.at(-1)!.kind).toBe('xc');
  });

  it('a pin in the river away from any road still snaps to the nearest bank', () => {
    const { e, ll } = riverRoad();
    const r = ok(routeSync(e, ll(45, 640), ll(45, 735), { avoidPerimeter: false }));
    expect(r.notes!.find((n) => n.code === 'SNAP_MOVED')?.text).toMatch(/^A moved 35 m to the nearest walkable ground/);
  });
});

describe('gunzip', () => {
  it('passes through bytes a server already inflated (Content-Encoding: gzip)', async () => {
    const { gunzip, parseRdg1 } = await import('./rdg1');
    const gz = buf('graph.bin.gz');
    const raw = await gunzip(gz);
    expect(new Uint8Array(raw, 0, 4)).toEqual(new Uint8Array([0x52, 0x44, 0x47, 0x31]));
    const again = await gunzip(raw);
    expect(again).toBe(raw);
    expect(parseRdg1(again).strings).toContain('FS 100');
  });
});
