import { describe, expect, it } from 'vitest';
import { parseLocation, routePath } from './router';
import { buildSearch, decodeSearch, encodeTime, parseTime } from './urlState';
import type { AppState } from '../state/store';

// The real store touches `document` at module load (theme bootstrap), and
// these tests run in the node environment — so build the slice of state that
// buildSearch reads by hand, at default values.
const NOW = Date.UTC(2026, 7, 20, 12, 0);
function mkState(): AppState {
  return {
    time: { currentTime: NOW, now: NOW },
    layers: {
      spread: { visible: false, product: 'time-of-arrival', percentile: 50 },
      weather: {},
      hotspots: { visible: true },
      perimeters: { visible: true },
      incidentMap: { mapId: null, series: null, opacity: 0.75 },
      irFlight: { flightId: null },
    },
    ui: { basemap: 'map' },
  } as unknown as AppState;
}

describe('router.parseLocation', () => {
  it('parses path routes (dev base "/")', () => {
    expect(parseLocation('/', '')).toEqual({ name: 'directory' });
    expect(parseLocation('/health', '')).toEqual({ name: 'health' });
    expect(parseLocation('/sources', '')).toEqual({ name: 'sources' });
    expect(parseLocation('/fire/abc-123', '')).toEqual({ name: 'fire', id: 'abc-123' });
    expect(parseLocation('/fire/%7Bguid%7D/', '')).toEqual({ name: 'fire', id: '{guid}' });
  });

  it('legacy hash links win over the path', () => {
    expect(parseLocation('/', '#/fire/xyz')).toEqual({ name: 'fire', id: 'xyz' });
    expect(parseLocation('/', '#/health')).toEqual({ name: 'health' });
  });

  it('round-trips through routePath', () => {
    for (const r of [
      { name: 'directory' } as const,
      { name: 'health' } as const,
      { name: 'sources' } as const,
      { name: 'fire', id: '{a-b}' } as const,
    ]) {
      expect(parseLocation(routePath(r), '')).toEqual(r);
    }
  });
});

describe('urlState time codec', () => {
  it('round-trips to minute precision', () => {
    const t = Date.UTC(2026, 7, 20, 19, 30);
    expect(encodeTime(t)).toBe('20260820T1930Z');
    expect(parseTime('20260820T1930Z')).toBe(t);
    expect(parseTime('garbage')).toBeNull();
  });
});

describe('urlState buildSearch/decodeSearch', () => {
  it('default view state encodes to an empty search', () => {
    expect(buildSearch(mkState())).toBe('');
  });

  it('round-trips a fully customized view', () => {
    const s = mkState();
    const t = Date.UTC(2026, 7, 22, 6, 0);
    const custom: AppState = {
      ...s,
      time: { ...s.time, currentTime: t, now: NOW },
      layers: {
        ...s.layers,
        hotspots: { visible: false },
        weather: { tmpf: { visible: true, opacity: 0.7 }, rh: { visible: false, opacity: 0.7 } },
        spread: { ...s.layers.spread, visible: true, product: 'time-of-arrival', percentile: 70 },
        incidentMap: { mapId: null, series: 'ops|Ops Map|landscape', opacity: 0.75 },
        irFlight: { flightId: '20260819_c0800_Aircraft3' },
      },
      ui: { ...s.ui, basemap: 'satellite' },
    };
    const v = decodeSearch(buildSearch(custom));
    expect(v).toEqual({
      t,
      hotspots: false,
      weather: ['tmpf'],
      spread: { product: 'time-of-arrival', percentile: 70 },
      basemap: 'satellite',
      series: 'ops|Ops Map|landscape',
      irFlight: '20260819_c0800_Aircraft3',
    });
  });

  it('drops invalid values instead of importing them', () => {
    expect(decodeSearch('?wx=evil.tmpf&ff=nope.55&bm=hax&t=nonsense')).toEqual({
      weather: ['tmpf'],
    });
  });

  it('series wins over single map id', () => {
    expect(decodeSearch('?map=abc&mv=ops%7CSheet%7Cportrait').series).toBe('ops|Sheet|portrait');
  });
});

describe('fireUrl slug resolution', () => {
  it('resolves slugs case-insensitively and passes GUIDs through', async () => {
    const { corneaIdForUrlId, urlIdForFire, isCorneaId, registerFires, firesLoaded, resetFiresForTest } =
      await import('./fireUrl');
    resetFiresForTest();
    expect(isCorneaId('{6B0C72B3-0E12-4695-9022-E1113C0AA8D1}')).toBe(true);
    expect(isCorneaId('c9cacf3a-a0b7-41ae-9090-6fe2781f45ae')).toBe(true);
    expect(isCorneaId('big-grass-or-2026-07-23')).toBe(false);

    // before the index loads: GUIDs resolve, slugs wait
    expect(corneaIdForUrlId('{ABC12345-0E12-4695-9022-E1113C0AA8D1}'))
      .toBe('{ABC12345-0E12-4695-9022-E1113C0AA8D1}');
    expect(firesLoaded()).toBe(false);
    expect(corneaIdForUrlId('big-grass-or-2026-07-23')).toBeNull();

    registerFires([
      { cornea_id: '{6B0C}', unique_slug: '2026-07-23-OR-BIG-GRASS' },
      { cornea_id: 'bare-uuid', unique_slug: '2026-08-20-CA-Chia' },
    ] as never);
    expect(firesLoaded()).toBe(true);
    expect(corneaIdForUrlId('big-grass-or-2026-07-23')).toBe('{6B0C}');
    expect(corneaIdForUrlId('BIG-GRASS-OR-2026-07-23')).toBe('{6B0C}');
    expect(corneaIdForUrlId('gone-zz-2026-01-01')).toBeNull();

    expect(urlIdForFire('{6B0C}')).toBe('big-grass-or-2026-07-23');
    expect(urlIdForFire('{not-in-index}')).toBe('{not-in-index}');
    resetFiresForTest();
  });
});
