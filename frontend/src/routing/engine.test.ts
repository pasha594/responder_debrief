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
import { HybridSearch, searchWindow } from './astar';
import { OffroadEngine, routeSync } from './engine';
import type { RoutingGrid } from './gridDecode';
import { buildHybridGraph } from './hybridGraph';
import { climbOf, fmtDur } from './legs';
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

  it('routes anyway when an endpoint is inside the perimeter', async () => {
    const e = await engineP;
    e.setPerimeter('p2', square(0, 0, 1200));
    const r = ok(routeSync(e, at(100, 100), at(3000, 4000), { avoidPerimeter: true }));
    expect(r.notes!.find((n) => n.code === 'ENDPOINT_IN_PERIM')?.text).toMatch(/^A is inside/);
    expect(r.provenance!.avoidPerimeter).toBe(false);
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

describe('legs helpers', () => {
  it('climb hysteresis ignores sub-3 m noise', () => {
    expect(climbOf([100, 101, 100, 102, 101, 100])).toEqual({ climb: 0, descent: 0 });
    expect(climbOf([100, 104, 103, 110, 100])).toEqual({ climb: 10, descent: 10 });
  });

  it('formats durations', () => {
    expect(fmtDur(59 * 60)).toBe('59 min');
    expect(fmtDur(125 * 60)).toBe('2 h 05 min');
    expect(fmtDur(120 * 60)).toBe('2 h');
  });
});
