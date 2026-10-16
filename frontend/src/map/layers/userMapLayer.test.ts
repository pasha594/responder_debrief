/**
 * The "My maps" layer manager: the map canvas is blocked from session replay
 * exactly while a user's PDF can be on it, and the raster source stops one
 * zoom level sooner when the protocol paints 512-px tiles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserMapMeta } from '../../userMaps/types';
import type { LayerContext } from '../layerTypes';

vi.mock('maplibre-gl', () => ({ default: { addProtocol: vi.fn() } }));
vi.mock('../../userMaps/tileRenderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../userMaps/tileRenderer')>()),
  registerUserMapProtocol: vi.fn(),
  releaseUserMapImages: vi.fn(),
}));

const { userMapLayer } = await import('./userMapLayer');

function fakeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, unknown>();
  const classes = new Set<string>();
  const idle: (() => void)[] = [];
  const canvas = {
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
  };
  return {
    sources,
    blocked: () => classes.has('ph-no-capture'),
    /** MapLibre's 'idle': the map has drawn a settled frame. */
    fireIdle() {
      for (const cb of idle.splice(0)) cb();
    },
    getCanvas: () => canvas,
    once(type: string, cb: () => void) {
      if (type === 'idle') idle.push(cb);
    },
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: Record<string, unknown>) => void sources.set(id, spec),
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => layers.get(id),
    addLayer: (spec: { id: string }) => void layers.set(spec.id, spec),
    removeLayer: (id: string) => layers.delete(id),
    setPaintProperty: () => {},
    getStyle: () => ({ layers: [] }),
  };
}

function meta(over: Partial<UserMapMeta> = {}): UserMapMeta {
  return {
    id: 'abc-p1',
    addedAt: '2026-10-01T00:00:00Z',
    bounds: [-120, 40, -119, 41],
    maxzoom: 14,
    ...over,
  } as UserMapMeta;
}

function ctx(shown: UserMapMeta | null, list: UserMapMeta[] = shown ? [shown] : []): LayerContext {
  return {
    userMaps: list,
    layers: { userMap: { id: shown?.id ?? null }, incidentMap: { opacity: 0.8 } },
  } as unknown as LayerContext;
}

let map: ReturnType<typeof fakeMap>;

beforeEach(() => {
  map = fakeMap();
  userMapLayer.mount(map as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('userMapLayer: session replay', () => {
  it('blocks the canvas while a map is shown and unblocks after a frame without it', () => {
    expect(map.blocked()).toBe(false);
    const m = meta();
    userMapLayer.update(map as never, ctx(m));
    expect(map.blocked()).toBe(true);

    userMapLayer.update(map as never, ctx(null, [m]));
    expect(map.sources.has('rd-user-map')).toBe(false);
    // The last drawn frame may still hold the PDF until the map redraws.
    expect(map.blocked()).toBe(true);
    map.fireIdle();
    expect(map.blocked()).toBe(false);
  });

  it('stays blocked when the map is shown again before the hide settles', () => {
    const m = meta();
    userMapLayer.update(map as never, ctx(m));
    userMapLayer.update(map as never, ctx(null, [m]));
    userMapLayer.update(map as never, ctx(m));
    map.fireIdle();
    expect(map.blocked()).toBe(true);
  });

  it('never blocks a map that shows no user map', () => {
    userMapLayer.update(map as never, ctx(null));
    userMapLayer.update(map as never, ctx(null));
    map.fireIdle();
    expect(map.blocked()).toBe(false);
  });

  it('unblocks at once on unmount', () => {
    userMapLayer.update(map as never, ctx(meta()));
    userMapLayer.unmount(map as never);
    expect(map.blocked()).toBe(false);
  });
});

describe('userMapLayer: source maxzoom', () => {
  const maxzoomAt = (dpr: number, m: UserMapMeta) => {
    vi.stubGlobal('devicePixelRatio', dpr);
    userMapLayer.update(map as never, ctx(m));
    const z = map.sources.get('rd-user-map')!.maxzoom;
    userMapLayer.unmount(map as never);
    return z;
  };

  it('keeps the stored level for 256-px paints', () => {
    expect(maxzoomAt(1, meta({ maxzoom: 14 }))).toBe(14);
  });

  it('stops one level sooner where 512-px paints already cover it', () => {
    expect(maxzoomAt(2, meta({ maxzoom: 14 }))).toBe(13);
    expect(maxzoomAt(3, meta({ maxzoom: 0 }))).toBe(0);
  });
});
