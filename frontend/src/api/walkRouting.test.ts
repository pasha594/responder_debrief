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
}));
vi.mock('../routing/offroadClient', () => ({
  routeOffroad: hoisted.routeOffroad,
  ensureBundle: hoisted.ensureBundle,
  setPerimeter: hoisted.setPerimeter,
}));
vi.mock('./routing', () => ({ routeHikeOnline: hoisted.routeHikeOnline }));

const { routeWalk, WalkError } = await import('./walkRouting');
const { lonLatToUtm, utmToLonLat } = await import('../spread/utm');

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
});

describe('routeWalk', () => {
  it('uses the offline router inside the area (online too) and flags an old perimeter', async () => {
    hoisted.routeOffroad.mockResolvedValue({ ok: true, route: structuredClone(offRoute) });
    const r = await routeWalk(at(0, 0), at(500, 500), ctx());
    expect(r.engine).toBe('offroad');
    expect(hoisted.routeHikeOnline).not.toHaveBeenCalled();
    expect(r.notes!.map((n) => n.code)).toContain('PERIM_OLD'); // 24 h old
    expect(hoisted.setPerimeter).toHaveBeenCalledWith('/p', expect.any(Array));
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

  it('online outside the area: engine route + untimed gaps + perimeter warnings', async () => {
    hoisted.routeHikeOnline.mockResolvedValue({
      geometry: { type: 'LineString', coordinates: [at(-40, 0), at(40, 0)] },
      distanceM: 80, durationS: 60, trafficDelayS: null, steps: [], engine: 'valhalla',
    });
    const r = await routeWalk(at(-40, 400), at(90_000, 0), ctx({ bundle: null }));
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
