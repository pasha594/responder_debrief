import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareState } from '../share/shareCodec';
import type { UserMapMeta } from '../userMaps/types';

// The store reads document.documentElement.dataset.theme at module load;
// these tests run in node, so give it the minimum it touches.
(globalThis as { document?: unknown }).document ??= {
  documentElement: { dataset: {} },
};
(globalThis as { window?: unknown }).window ??= globalThis;
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};
// Only `track` is watched (what reaches analytics about a user map); the
// rest of the module stays real.
const hoisted = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../app/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app/analytics')>()),
  track: hoisted.track,
}));
const { useStore } = await import('./store');

const layers = () => useStore.getState().layers;
const actions = () => useStore.getState().actions;

describe('map overlays are mutually exclusive', () => {
  beforeEach(() => {
    actions().setIncidentMap(null);
    actions().setIrFlight(null);
    actions().setUserMap(null);
  });

  it('showing an IR flight takes down the incident map, and back', () => {
    actions().setIncidentMap('sheet-1');
    actions().setIrFlight('20260925_IR');
    expect(layers().incidentMap.mapId).toBeNull();
    expect(layers().irFlight.flightId).toBe('20260925_IR');

    actions().setIncidentMap('sheet-2');
    expect(layers().irFlight.flightId).toBeNull();
    expect(layers().incidentMap.mapId).toBe('sheet-2');
  });

  it('a map series replaces the IR flight too', () => {
    actions().setIrFlight('20260925_IR');
    actions().setIncidentMapSeries('ops|arch_e');
    expect(layers().irFlight.flightId).toBeNull();
    expect(layers().incidentMap.series).toBe('ops|arch_e');

    actions().setIrFlight('20260924_IR');
    expect(layers().incidentMap.series).toBeNull();
  });

  it('turning one off leaves the other alone, and keeps the sheet opacity', () => {
    actions().setIncidentMapOpacity(0.5);
    actions().setIrFlight('20260925_IR');
    actions().setIncidentMap(null);
    expect(layers().irFlight.flightId).toBe('20260925_IR');
    actions().setIncidentMap('sheet-1');
    actions().setIrFlight(null);
    expect(layers().incidentMap.mapId).toBe('sheet-1');
    expect(layers().incidentMap.opacity).toBe(0.5);
  });
});

describe('My maps take the same one-overlay slot', () => {
  beforeEach(() => {
    actions().setIncidentMap(null);
    actions().setIrFlight(null);
    actions().setUserMap(null);
    actions().setIncidentMapOpacity(0.75);
    hoisted.track.mockClear();
  });

  it('a user map and an incident sheet replace each other', () => {
    actions().setIncidentMap('sheet-1');
    actions().setUserMap('0123456789abcdef-p1');
    expect(layers().incidentMap.mapId).toBeNull();
    expect(layers().userMap.id).toBe('0123456789abcdef-p1');

    actions().setIncidentMap('sheet-2');
    expect(layers().userMap.id).toBeNull();
    expect(layers().incidentMap.mapId).toBe('sheet-2');
  });

  it('a user map and a sheet series replace each other', () => {
    actions().setIncidentMapSeries('ops|arch_e');
    actions().setUserMap('0123456789abcdef-p1');
    expect(layers().incidentMap.series).toBeNull();
    expect(layers().userMap.id).toBe('0123456789abcdef-p1');

    actions().setIncidentMapSeries('ops|arch_e');
    expect(layers().userMap.id).toBeNull();
    expect(layers().incidentMap.series).toBe('ops|arch_e');
  });

  it('a user map and an IR flight replace each other', () => {
    actions().setIrFlight('20260925_IR');
    actions().setUserMap('0123456789abcdef-p2');
    expect(layers().irFlight.flightId).toBeNull();
    expect(layers().userMap.id).toBe('0123456789abcdef-p2');

    actions().setIrFlight('20260926_IR');
    expect(layers().userMap.id).toBeNull();
    expect(layers().irFlight.flightId).toBe('20260926_IR');
  });

  it('turning any one off leaves the others alone', () => {
    actions().setUserMap('0123456789abcdef-p1');
    actions().setIncidentMap(null);
    actions().setIncidentMapSeries(null);
    actions().setIrFlight(null);
    expect(layers().userMap.id).toBe('0123456789abcdef-p1');

    actions().setIrFlight('20260925_IR');
    actions().setUserMap(null);
    expect(layers().irFlight.flightId).toBe('20260925_IR');
  });

  it('shares the incident sheet opacity, untouched by switching', () => {
    actions().setIncidentMapOpacity(0.4);
    actions().setIncidentMap('sheet-1');
    actions().setUserMap('0123456789abcdef-p1');
    expect(layers().incidentMap.opacity).toBe(0.4);
    actions().setIncidentMapOpacity(0.3);
    actions().setIrFlight('20260925_IR');
    actions().setUserMap('0123456789abcdef-p1');
    expect(layers().incidentMap.opacity).toBe(0.3);
  });

  it('reports a shown user map to analytics by kind only (no id)', () => {
    actions().setUserMap('0123456789abcdef-p1');
    expect(hoisted.track).toHaveBeenCalledTimes(1);
    expect(hoisted.track).toHaveBeenCalledWith('map_overlay_shown', { kind: 'user' });
    actions().setUserMap(null);
    expect(hoisted.track).toHaveBeenCalledTimes(1);
  });
});

describe('the shown user map is per fire view', () => {
  const share = (corneaId: string): ShareState =>
    ({
      fire: { corneaId, name: 'Test Fire' },
      sharedAt: Date.UTC(2026, 9, 16, 12, 0),
      packSavedAt: null,
      camera: { center: [-121.5, 44.2], zoom: 11, bearing: 0, pitch: 0 },
      basemap: 'topo',
      time: null,
      layers: {
        spread: { ...useStore.getState().layers.spread },
        weather: {},
        hotspots: true,
        perimeters: true,
        historic: false,
        traffic: false,
        incidents: false,
        incidentMap: { mapId: 'sheet-9', series: null, opacity: 0.6 },
        irFlight: null,
        trails: 'auto',
        vegetation: { visible: false, opacity: null },
        land: false,
      },
      drawings: null,
      routing: null,
    }) as unknown as ShareState;

  beforeEach(() => {
    actions().setUserMap(null);
    actions().setIncidentMapOpacity(0.75);
  });

  it('switching fire takes the user map down but keeps the opacity', () => {
    actions().selectFire('fire-a');
    actions().setIncidentMapOpacity(0.45);
    actions().setUserMap('0123456789abcdef-p1');
    actions().selectFire('fire-b');
    expect(layers().userMap.id).toBeNull();
    expect(layers().incidentMap.opacity).toBe(0.45);
  });

  it('going back to the directory takes it down too', () => {
    actions().selectFire('fire-a');
    actions().setUserMap('0123456789abcdef-p1');
    actions().backToDirectory();
    expect(layers().userMap.id).toBeNull();
  });

  it("applying a share drops the recipient's own map under the sender's sheet", () => {
    actions().selectFire('fire-a');
    actions().setUserMap('0123456789abcdef-p1');
    actions().applySharedView(share('fire-a'));
    expect(layers().userMap.id).toBeNull();
    expect(layers().incidentMap.mapId).toBe('sheet-9');
  });

  it('a share for another fire changes nothing', () => {
    actions().selectFire('fire-a');
    actions().setUserMap('0123456789abcdef-p1');
    actions().applySharedView(share('fire-z'));
    expect(layers().userMap.id).toBe('0123456789abcdef-p1');
  });
});

describe('the My maps slice', () => {
  const meta = (id: string): UserMapMeta => ({ id }) as UserMapMeta;

  beforeEach(() => {
    actions().setUserMap(null);
  });

  it('starts empty and not yet loaded', () => {
    const initial = useStore.getInitialState();
    expect(initial.userMaps).toEqual({
      list: [], loaded: false, sessionOnly: false, import: null, notice: null,
    });
    expect(initial.layers.userMap).toEqual({ id: null });
  });

  it('setUserMaps marks the list loaded and keeps sessionOnly unless told', () => {
    actions().setUserMaps([meta('a-p1')], true);
    expect(useStore.getState().userMaps).toMatchObject({
      list: [{ id: 'a-p1' }], loaded: true, sessionOnly: true,
    });
    actions().setUserMaps([meta('a-p1'), meta('b-p1')]);
    expect(useStore.getState().userMaps.sessionOnly).toBe(true);
    expect(useStore.getState().userMaps.list).toHaveLength(2);
    actions().setUserMaps([], false);
    expect(useStore.getState().userMaps.sessionOnly).toBe(false);
  });

  it('a map that leaves the list stops being shown; others stay', () => {
    actions().setUserMaps([meta('a-p1'), meta('b-p1')]);
    actions().setUserMap('a-p1');
    actions().setUserMaps([meta('a-p1')]);
    expect(layers().userMap.id).toBe('a-p1');
    actions().setUserMaps([meta('b-p1')]);
    expect(layers().userMap.id).toBeNull();
  });

  it('progress and notices are set and cleared', () => {
    actions().setUserMapImport({ fileName: 'ops.pdf', stage: 'drawing', page: 1, pages: 2 });
    expect(useStore.getState().userMaps.import?.stage).toBe('drawing');
    actions().setUserMapImport(null);
    expect(useStore.getState().userMaps.import).toBeNull();

    actions().setUserMapNotice({ kind: 'crashed', text: 'x', docId: '0123456789abcdef' });
    expect(useStore.getState().userMaps.notice?.kind).toBe('crashed');
    actions().setUserMapNotice(null);
    expect(useStore.getState().userMaps.notice).toBeNull();
  });
});
