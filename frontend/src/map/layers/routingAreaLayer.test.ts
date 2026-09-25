/**
 * The Walk route-data credit (OSM ODbL + agencies) rides on the routing-area
 * source, and MapLibre lists a source's attribution only while one of its
 * layers is visible — so the outline layer must be hidden, not just
 * emptied, when Walk has no routing area to show.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ loadFireBundle: vi.fn() }));
vi.mock('../../routing/hooks', () => ({ loadFireBundle: hoisted.loadFireBundle }));

const { routingAreaLayer, WALK_ATTRIBUTION } = await import('./routingAreaLayer');
const { useStore } = await import('../../state/store');

function fakeMap() {
  const sources = new Map<string, { spec: Record<string, unknown>; data: unknown; setData(d: unknown): void }>();
  const layers = new Map<string, { layout: Record<string, unknown> }>();
  return {
    style: {},
    sources,
    layers,
    getSource: (id: string) => sources.get(id),
    addSource(id: string, spec: Record<string, unknown>) {
      const s = { spec, data: spec.data, setData(d: unknown) { s.data = d; } };
      sources.set(id, s);
    },
    getLayer: (id: string) => layers.get(id),
    addLayer(spec: { id: string; layout?: Record<string, unknown> }) {
      layers.set(spec.id, { layout: { ...(spec.layout ?? {}) } });
    },
    setLayoutProperty(id: string, k: string, v: unknown) {
      layers.get(id)!.layout[k] = v;
    },
    getStyle: () => ({ layers: [] }),
    getLayersOrder: () => [...layers.keys()],
    removeLayer: (id: string) => layers.delete(id),
    removeSource: (id: string) => sources.delete(id),
  };
}

const bundle = {
  grid: { x0: 600_000, y0: 5_360_000, cell_m: 30, width: 100, height: 100 },
  crs: { epsg: 32610, zone: 10, northern: true },
};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  hoisted.loadFireBundle.mockReset();
  useStore.setState((s) => ({
    view: { mode: 'fire', corneaId: 'c' },
    directions: { ...s.directions, profile: 'drive', a: null, b: null, armed: false },
  }));
});

describe('routingAreaLayer', () => {
  it('credits OSM/agencies on its source, and shows it only with the Walk routing area', async () => {
    hoisted.loadFireBundle.mockResolvedValue(bundle);
    const map = fakeMap();
    routingAreaLayer.mount(map as never);
    const src = map.sources.get('rd-routing-area')!;
    expect(src.spec.attribution).toBe(WALK_ATTRIBUTION);
    expect(WALK_ATTRIBUTION).toContain('© OpenStreetMap contributors');
    expect(WALK_ATTRIBUTION).not.toMatch(/USFS|BLM|NPS|LANDFIRE|NHD/); // Sources page
    const vis = () => map.layers.get('rd-routing-area')!.layout.visibility;
    expect(vis()).toBe('none'); // Drive: no credit in the attribution control

    useStore.setState((s) => ({ directions: { ...s.directions, profile: 'hike', armed: true } }));
    await flush();
    expect(vis()).toBe('visible');
    expect((src.data as GeoJSON.Feature).geometry.type).toBe('LineString');

    useStore.setState((s) => ({ directions: { ...s.directions, profile: 'drive' } }));
    expect(vis()).toBe('none');
    routingAreaLayer.unmount(map as never);
  });

  it('stays hidden for a fire without a bundle', async () => {
    hoisted.loadFireBundle.mockResolvedValue(null);
    const map = fakeMap();
    routingAreaLayer.mount(map as never);
    useStore.setState((s) => ({ directions: { ...s.directions, profile: 'hike', armed: true } }));
    await flush();
    expect(map.layers.get('rd-routing-area')!.layout.visibility).toBe('none');
    routingAreaLayer.unmount(map as never);
  });
});
