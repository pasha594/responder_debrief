/**
 * End-to-end offline Walk on the worker-built synthetic bundle
 * (__fixtures__/synthetic, from worker/scripts/make_routing_fixture.py:
 * real GDAL GeoTIFFs + RDG1). Scene, in metres from (-115.0, 44.2):
 * forest road FS 100 along y=-4000; a path (Ridge Trail #101) from
 * (-3000,-4000) to (3000,4000) over a N–S ridge at x=0; High Traverse #202
 * from (3000,4000) east and south to the road; timber west of the ridge,
 * dense brush east; a lake at (-2000,-2500) r 500; a creek near y=1000.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lonLatToUtm, utmToLonLat } from '../spread/utm';
import type { RouteLeg, RouteResult } from '../api/routing';
import { HybridSearch, searchWindow } from './astar';
import { LEAVE_TRAIL_PENALTY_S, sullivanRate } from './costModel';
import { OffroadEngine, routeSync } from './engine';
import type { RoutingGrid } from './gridDecode';
import { buildHybridGraph } from './hybridGraph';
import { buildLegs, climbOf, fmtDur, stepsFor } from './legs';
import { PACE_LUT } from './pacecode';
import type { Rdg1 } from './rdg1';
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

  it('warns about a cross-country crossing of a mapped perennial stream', async () => {
    // SISI: routes forded the Stehekin River and Agnes Creek with only
    // "crossing 1 stream" in a step (the creek here runs E–W near y=1000)
    const e = await engineP;
    const r = ok(routeSync(e, at(-5000, 0), at(-5000, 2000), { avoidPerimeter: true }));
    expect(r.legs!.reduce((s, l) => s + (l.streamCrossings ?? 0), 0)).toBe(1);
    const n = r.notes!.find((x) => x.code === 'XC_STREAM');
    expect(n?.level).toBe('warn');
    expect(n?.text).toMatch(/^Cross-country, the route crosses a mapped perennial stream with no bridge\./);
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

  it('routes anyway when an endpoint is inside the perimeter', async () => {
    const e = await engineP;
    e.setPerimeter('p2', square(0, 0, 1200));
    const r = ok(routeSync(e, at(100, 100), at(3000, 4000), { avoidPerimeter: true }));
    expect(r.notes!.find((n) => n.code === 'ENDPOINT_IN_PERIM')?.text).toMatch(/^A is inside/);
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
    expect(r.notes!.find((n) => n.code === 'ENDPOINT_NEAR_PERIM')!.text).toMatch(/^B is within 60 m/);
    expect(r.provenance!.avoidPerimeter).toBe(true);
    e.setPerimeter(null, null);
  });

  it('a pin inside a spot fire opens that spot only, not the main fire', async () => {
    const e = await engineP;
    e.setPerimeter('p4', [...square(0, 0, 1200), ...square(-3000, -3800, 100)]);
    const r = ok(routeSync(e, at(-3000, -3800), at(3000, 4000), { avoidPerimeter: true }));
    expect(entersSquare(r, 0, 0, 1200)).toBe(false);
    expect(r.notes!.find((n) => n.code === 'ENDPOINT_IN_PERIM')?.text).toMatch(/^A is inside .* near A\./);
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

  it('matches Dijkstra (weight 0) on 40 random grids with a road', () => {
    for (let t = 0; t < 40; t++) {
      const w = 30;
      const h = 24;
      const grid: RoutingGrid = {
        width: w, height: h, cell: 30,
        pace: Uint8Array.from({ length: w * h }, () => (rnd() < 0.12 ? 255 : 1 + Math.floor(rnd() * 120))),
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
      const start = { x: 45, y: 45, cell: 1 * w + 1 };
      const goal = { x: 25 * 30 + 15, y: 21 * 30 + 15, cell: 21 * w + 25 };
      grid.pace[start.cell] = 10;
      grid.pace[goal.cell] = 10;
      const win = searchWindow(grid, start, goal, true);
      const run = (weight: number) => {
        const s = new HybridSearch({ grid, graph, mask: null, window: win, start, goal, weight, maxSettled: 1e7 });
        while (s.step(1e6) === 'running');
        return s;
      };
      const a = run(1);
      const d = run(0);
      expect(a.status).toBe(d.status);
      if (d.status === 'found') {
        expect(Math.abs(a.cost - d.cost)).toBeLessThan(1e-6 * d.cost);
        expect(a.settled).toBeLessThanOrEqual(d.settled);
      }
    }
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
    // a descriptor that claims band 3 on a 2-band grid.tif decodes without names
    const { decodeGrid } = await import('./gridDecode');
    const g = await decodeGrid(buf('grid.tif'), buf('dem.tif'), { ...bundle, streams: { band: 3, names: ['X'] } });
    expect(g.stream).toBeUndefined();
    expect(g.streamNames).toBeUndefined();
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
    // 5300 + 41 + 800 + 18 + 480 m = 4.1 mi, timed and climbed as drawn
    expect(steps[0]).toBe('Follow McGregor Mountain Trail 4.1 mi, ↑ 2,180 ft — about 1 h 50 min (89–166 min) · includes 2 short cross-country cuts');
    expect(steps[1]).toMatch(/^Follow Other Trail 0\.2 mi, ↑ 100 ft — about 5 min \(4–8 min\)$/);
    expect(steps[2]).toMatch(/· Restricted: Closed$/);
    expect(steps[3]).toBe('Arrive at B');
  });

  it('formats durations', () => {
    expect(fmtDur(59 * 60)).toBe('59 min');
    expect(fmtDur(125 * 60)).toBe('2 h 05 min');
    expect(fmtDur(120 * 60)).toBe('2 h');
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
