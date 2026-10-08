/**
 * Walk decision table: inside/outside the routing area × online/offline ×
 * bundle yes/no × the offline router's outcomes. The worker client and the
 * online engines are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteResult } from './routing';

const hoisted = vi.hoisted(() => ({
  routeOffroad: vi.fn(),
  ensureBundle: vi.fn(async () => undefined),
  setPerimeter: vi.fn(async () => undefined),
  routeHikeOnline: vi.fn(),
  locateWays: vi.fn(),
}));
vi.mock('../routing/offroadClient', () => ({
  routeOffroad: hoisted.routeOffroad,
  ensureBundle: hoisted.ensureBundle,
  setPerimeter: hoisted.setPerimeter,
}));
vi.mock('./routing', () => ({
  routeHikeOnline: hoisted.routeHikeOnline,
  locateWays: hoisted.locateWays,
}));

const { routeWalk, WalkError } = await import('./walkRouting');
const { lonLatToUtm, utmToLonLat } = await import('../spread/utm');
const { syntheticTiles } = await import('../routing/__fixtures__/syntheticTerrain');

const [CX, CY] = lonLatToUtm(-115, 44.2, 11);
const bundle = {
  schema: 'rd-routing-bundle/1', recipe: 1, bundle_id: 'b1', cornea_id: 'c', fire_key: 'c',
  built_at: '2026-09-25T00:00:00Z', crs: { epsg: 32611, zone: 11, northern: true },
  grid: { x0: Math.floor(CX / 30) * 30 - 6000, y0: Math.ceil(CY / 30) * 30 + 6000, cell_m: 30, width: 400, height: 400 },
  bounds4326: [-115.1, 44.1, -114.9, 44.3] as [number, number, number, number],
  files: { grid: { path: '/g', bytes: 1 }, dem: { path: '/d', bytes: 1 }, graph: { path: '/r', bytes: 1 } },
};
const at = (dx: number, dy: number) => utmToLonLat(CX + dx, CY + dy, 11) as [number, number];
const offRoute: RouteResult = {
  geometry: { type: 'LineString', coordinates: [at(0, 0), at(100, 0)] }, distanceM: 100,
  durationS: 100, trafficDelayS: null, steps: [], engine: 'offroad', legs: [], notes: [],
  provenance: { bundleId: 'b1', builtAt: '', perimeterDate: null, avoidPerimeter: true, cellM: 30, weighted: false, ms: 5 },
};
const perimeter = {
  feature: { type: 'Feature', properties: {}, geometry: { type: 'Polygon',
    coordinates: [[at(-50, -50), at(50, -50), at(50, 50), at(-50, 50), at(-50, -50)]] } },
  path: '/p', date: '2026-09-24T00:00:00Z',
};

function ctx(over: Record<string, unknown> = {}) {
  return {
    corneaId: 'c', online: true, avoidPerimeter: true, bundle, packed: true,
    getPerimeter: async () => perimeter as never, nowMs: Date.parse('2026-09-25T00:00:00Z'),
    ...over,
  } as Parameters<typeof routeWalk>[2];
}

beforeEach(() => {
  hoisted.routeOffroad.mockReset();
  hoisted.routeHikeOnline.mockReset();
  hoisted.locateWays.mockReset().mockResolvedValue([]);
});

/** No terrain (tiles unreachable). */
const noTiles = async () => { throw new Error('offline'); };

describe('routeWalk', () => {
  it('uses the offline router inside the area (online too) and flags an old perimeter', async () => {
    hoisted.routeOffroad.mockResolvedValue({ ok: true, route: structuredClone(offRoute) });
    const r = await routeWalk(at(0, 0), at(500, 500), ctx());
    expect(r.engine).toBe('offroad');
    expect(hoisted.routeHikeOnline).not.toHaveBeenCalled();
    expect(r.notes!.map((n) => n.code)).toContain('PERIM_OLD'); // 24 h old
    expect(hoisted.setPerimeter).toHaveBeenCalledWith('/p', expect.any(Array));
  });

  it('checks an offline route against the perimeter: crossing, passing close, avoidance off', async () => {
    // through the 100 m square: SISI route (e) started inside the fire with
    // no note but its own; the card never said the line crosses it
    const through = { ...structuredClone(offRoute),
      geometry: { type: 'LineString' as const, coordinates: [at(-300, 0), at(300, 0)] } };
    hoisted.routeOffroad.mockResolvedValue({ ok: true, route: through });
    let codes = (await routeWalk(at(0, 0), at(500, 500), ctx())).notes!.map((n) => n.code);
    expect(codes).toContain('CROSSES_PERIM');
    expect(codes).not.toContain('NEAR_PERIM');
    // 80 m north of the square (SISI route (d) passed 79 m from the fire, no note)
    const skirt = { ...structuredClone(offRoute),
      geometry: { type: 'LineString' as const, coordinates: [at(-300, 130), at(300, 130)] } };
    hoisted.routeOffroad.mockResolvedValue({ ok: true, route: skirt });
    const near = (await routeWalk(at(0, 0), at(500, 500), ctx())).notes!;
    expect(near.map((n) => n.code)).not.toContain('CROSSES_PERIM');
    expect(near.find((n) => n.code === 'NEAR_PERIM')?.text).toMatch(/within 80 m/);
    // avoidance off: the perimeter is still fetched and the line still checked
    hoisted.routeOffroad.mockResolvedValue({ ok: true,
      route: { ...structuredClone(through), provenance: { ...offRoute.provenance!, avoidPerimeter: false } } });
    codes = (await routeWalk(at(0, 0), at(500, 500), ctx({ avoidPerimeter: false }))).notes!.map((n) => n.code);
    expect(hoisted.routeOffroad).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), false, perimeter.date);
    expect(codes).toEqual(expect.arrayContaining(['CROSSES_PERIM', 'PERIM_OLD']));
    // far from the fire: nothing but the age
    const far = { ...structuredClone(offRoute),
      geometry: { type: 'LineString' as const, coordinates: [at(-300, 400), at(300, 400)] } };
    hoisted.routeOffroad.mockResolvedValue({ ok: true, route: far });
    codes = (await routeWalk(at(0, 0), at(500, 500), ctx())).notes!.map((n) => n.code);
    expect(codes).toEqual(['PERIM_OLD']);
  });

  it('never falls back online when the fire blocks the route', async () => {
    hoisted.routeOffroad.mockResolvedValue({ ok: false, code: 'blocked_by_perimeter', message: 'x',
      alternative: offRoute });
    await expect(routeWalk(at(0, 0), at(500, 500), ctx())).rejects.toMatchObject({ code: 'blocked' });
    hoisted.routeOffroad.mockResolvedValue({ ok: false, code: 'no-path', message: 'No walkable ground' });
    await expect(routeWalk(at(0, 0), at(500, 500), ctx())).rejects.toBeInstanceOf(WalkError);
    expect(hoisted.routeHikeOnline).not.toHaveBeenCalled();
  });

  it('offline outside the area / without a bundle gives explicit errors', async () => {
    await expect(routeWalk(at(0, 0), at(90_000, 0), ctx({ online: false })))
      .rejects.toMatchObject({ code: 'outside-area-offline' });
    await expect(routeWalk(at(0, 0), at(500, 0), ctx({ online: false, bundle: null })))
      .rejects.toMatchObject({ code: 'offline-no-bundle' });
    await expect(routeWalk(at(0, 0), at(500, 0), ctx({ online: false, bundle: null, packed: false })))
      .rejects.toMatchObject({ code: 'offline-not-packed' });
  });

  it('online outside the area, no terrain: engine route + untimed gaps + perimeter warnings', async () => {
    hoisted.routeHikeOnline.mockResolvedValue({
      geometry: { type: 'LineString', coordinates: [at(-40, 0), at(40, 0)] },
      distanceM: 80, durationS: 60, trafficDelayS: null, steps: [], engine: 'valhalla',
    });
    const r = await routeWalk(at(-40, 400), at(90_000, 0), ctx({ bundle: null, tiles: noTiles }));
    const kinds = r.legs!.map((l) => l.kind);
    expect(kinds).toEqual(['gap', 'net', 'gap']);
    expect(r.legs![0].durationS).toBeNull();
    expect(r.durationS).toBe(60);
    const codes = r.notes!.map((n) => n.code);
    expect(codes).toContain('ONLINE_NO_PERIM');
    expect(codes).toContain('CROSSES_PERIM'); // the engine line runs through the square
    expect(codes).toContain('GAP_UNTIMED');
  });
});

/** Yosemite, 2026-10 (walkAttach.ts): pins on a plateau above a cliff, a
 * valley trail below it (nearer) and a rim trail behind them. Local metres
 * east/north of O; trails run east–west at these norths. */
describe('online Walk joins by total time over the terrain', () => {
  const O = at(0, 0);
  const ky = 111_320;
  const kx = ky * Math.cos((O[1] * Math.PI) / 180);
  const ll = (e: number, n: number): [number, number] => [O[0] + e / kx, O[1] + n / ky];
  const en = (p: [number, number]) => [(p[0] - O[0]) * kx, (p[1] - O[1]) * ky];
  const VALLEY = -600;
  const RIM = 900;
  const trail = (p: [number, number]) => {
    const [e, n] = en(p);
    return ll(e, Math.abs(n - VALLEY) < Math.abs(n - RIM) ? VALLEY : RIM);
  };
  const B = ll(4000, VALLEY);
  /** A 1° tilt east, like real ground. */
  const tilt = (e: number) => e * 0.0175;
  /** 800 m down a 60 m band at north −300; open ground above and below. */
  const cliff = syntheticTiles(O, (e, n) => 2000 + tilt(e) - 800 * Math.min(1, Math.max(0, (-300 - n) / 60)));
  const flat = syntheticTiles(O, (e) => 2000 + tilt(e));
  /** The engine: joins the nearest trail; network seconds by trail. */
  function engine(net: Record<number, number>) {
    const secs = (p: [number, number]) => net[Math.round(en(p)[1])];
    hoisted.routeHikeOnline.mockImplementation(async (a: [number, number], b: [number, number]) => ({
      geometry: { type: 'LineString', coordinates: [trail(a), b] }, distanceM: 5000,
      durationS: secs(trail(a)), trafficDelayS: null, steps: [{ text: 'Walk east', distanceM: 5000 }],
      engine: 'valhalla',
    }));
    hoisted.locateWays.mockImplementation(async (pts: [number, number][]) =>
      pts.map((p) => ({ at: trail(p), way: Math.round(en(trail(p))[1]) })));
  }
  const walk = (a: [number, number], tiles = cliff, over: Record<string, unknown> = {}) =>
    routeWalk(a, B, ctx({ bundle: null, tiles, getPerimeter: async () => null, ...over }));

  it('leaves the plateau for the rim trail, not down the cliff to the nearer one', async () => {
    engine({ [VALLEY]: 3600, [RIM]: 7200 });
    const r = await walk(ll(0, 0));
    const [g] = r.legs!;
    expect(g.kind).toBe('gap');
    expect(en(g.coordinates[1])[1]).toBeCloseTo(RIM, 0);
    expect(g.durationS).toBeGreaterThan(2500); // 900 m of unknown ground
    expect(r.durationS).toBeCloseTo(g.durationS! + 7200, 0);
    // re-routed from the rim only: the valley's line is blocked
    const starts = hoisted.routeHikeOnline.mock.calls.slice(1).map(([p]) => Math.round(en(p)[1]));
    expect(starts.length).toBeGreaterThan(0);
    expect(new Set(starts)).toEqual(new Set([RIM]));
    expect(r.notes!.map((n) => n.code)).toContain('GAP_TERRAIN');
    expect(r.steps[0].text).toMatch(/^Head cross-country N 0\.6 mi to the route — about/);
  });

  it('a nudge across the line where both trails are equally far changes nothing', async () => {
    engine({ [VALLEY]: 3600, [RIM]: 7200 });
    const totals: number[] = [];
    for (let n = -240; n <= 240; n += 40) {
      const r = await walk(ll(0, n));
      expect(en(r.legs![0].coordinates[1])[1]).toBeCloseTo(RIM, 0);
      totals.push(r.durationS);
    }
    for (let i = 1; i < totals.length; i++) expect(Math.abs(totals[i] - totals[i - 1])).toBeLessThan(300);
  });

  it('on open ground, ranks by the whole trip, not by the nearest trail', async () => {
    engine({ [VALLEY]: 20_000, [RIM]: 3600 });
    const r = await walk(ll(0, 0), flat);
    expect(en(r.legs![0].coordinates[1])[1]).toBeCloseTo(RIM, 0);
    engine({ [VALLEY]: 3600, [RIM]: 7200 });
    const v = await walk(ll(0, 0), flat);
    expect(en(v.legs![0].coordinates[1])).toEqual([expect.closeTo(0, 0), expect.closeTo(VALLEY, 0)]);
  });

  it('cliffs all round: no straight line is walkable, so it is flagged and not timed', async () => {
    engine({ [VALLEY]: 3600, [RIM]: 7200 });
    const pillar = syntheticTiles(O, (e, n) => 1000 + tilt(e) + 800 * Math.min(1, Math.max(0, (160 - Math.hypot(e, n)) / 60)));
    const r = await walk(ll(0, 0), pillar);
    expect(r.legs![0].durationS).toBeNull();
    expect(r.legs![0].descentM).toBeGreaterThan(700);
    expect(r.durationS).toBe(3600);
    expect(r.notes!.map((n) => n.code)).toContain('GAP_STEEP');
    expect(r.steps[0].text).toMatch(/crosses ground steeper than 45°, not timed$/);
  });

  it('no terrain: the line is untimed and the step says why, not "steep"', async () => {
    engine({ [VALLEY]: 3600, [RIM]: 7200 });
    const r = await walk(ll(0, 0), noTiles);
    expect(r.legs![0].durationS).toBeNull();
    expect(r.notes!.map((n) => n.code)).toContain('GAP_UNTIMED');
    expect(r.steps[0].text).toMatch(/not timed \(no terrain data\)$/);
  });

  it('stops chaining requests once a newer one replaces it', async () => {
    engine({ [VALLEY]: 3600, [RIM]: 7200 });
    await expect(walk(ll(0, 0), cliff, { isStale: () => true })).rejects.toMatchObject({ code: 'superseded' });
    expect(hoisted.routeHikeOnline).toHaveBeenCalledTimes(1);
    expect(hoisted.locateWays).not.toHaveBeenCalled();
  });

  /** Ways as lines: north = c (east–west) or east = c (north–south); the
   * engine joins the nearest and times a route by the way it starts on. */
  function ways(list: { id: number; dir: 'n' | 'e'; c: number; secs: number }[]) {
    const snap = (p: [number, number]) => {
      const [e, n] = en(p);
      const w = list.reduce((x, y) => (Math.abs((y.dir === 'n' ? n : e) - y.c) < Math.abs((x.dir === 'n' ? n : e) - x.c) ? y : x));
      return { w, at: w.dir === 'n' ? ll(e, w.c) : ll(w.c, n) };
    };
    hoisted.routeHikeOnline.mockImplementation(async (a: [number, number], b: [number, number]) => ({
      geometry: { type: 'LineString', coordinates: [snap(a).at, b] }, distanceM: 5000,
      durationS: snap(a).w.secs, trafficDelayS: null, steps: [{ text: 'Walk', distanceM: 5000 }], engine: 'valhalla',
    }));
    hoisted.locateWays.mockImplementation(async (pts: [number, number][]) =>
      pts.map((p) => ({ at: snap(p).at, way: snap(p).w.id })));
  }

  it('keeps the engine\'s own join in the running when three cheaper-to-reach ways lead away', async () => {
    // the main trail 140 m south down a walkable 38° slope; paths 250 m N, E and W on the bench
    ways([{ id: 1, dir: 'n', c: -140, secs: 3600 }, { id: 2, dir: 'n', c: 250, secs: 20_000 },
      { id: 3, dir: 'e', c: 250, secs: 20_000 }, { id: 4, dir: 'e', c: -250, secs: 20_000 }]);
    const bench = syntheticTiles(O, (e, n) => 2000 + tilt(e) + Math.min(0, n) * Math.tan((38 * Math.PI) / 180));
    const r = await walk(ll(0, 0), bench);
    expect(en(r.legs![0].coordinates[1])[1]).toBeCloseTo(-140, 0);
    expect(r.durationS).toBeLessThan(3600 + 2000);
  });

  it('a pin at a cliff edge looks farther out for the rim trail behind it', async () => {
    // wall from north −60 to −120; valley trail at −150 (nearest), rim trail 800 m back
    ways([{ id: 1, dir: 'n', c: -150, secs: 3600 }, { id: 2, dir: 'n', c: 800, secs: 7200 }]);
    const edge = syntheticTiles(O, (e, n) => 2000 + tilt(e) - 800 * Math.min(1, Math.max(0, (-60 - n) / 60)));
    const r = await walk(ll(0, 0), edge);
    expect(en(r.legs![0].coordinates[1])[1]).toBeCloseTo(800, 0);
    expect(r.legs![0].durationS).not.toBeNull();
    expect(hoisted.locateWays).toHaveBeenCalledTimes(2);
  });
});
