import { describe, expect, it } from 'vitest';
import { latestWeatherRun } from './queries';
import type { WeatherRun } from './types';

const FRAMES = {
  bounds: [-125, 24.5, -66.5, 49.5] as [number, number, number, number],
  image_template: '/frames/weather/{ws}/{product}/{epoch_ms}.png',
};

function run(ws: string, renderedHours: string[] | null): WeatherRun {
  return {
    workspace: ws,
    run_time: '2026-08-18T17:00:00Z',
    hours: ['2026-08-18T17:00:00Z'],
    frames: renderedHours === null ? undefined : { ...FRAMES, hours: renderedHours, complete: false },
  };
}

describe('latestWeatherRun', () => {
  it('skips a newer run with zero rendered frames (GDAL-skipped sync)', () => {
    const weather = {
      models: { hrrr: { runs: [run('hrrr_17', []), run('hrrr_16', ['2026-08-18T16:00:00Z'])] } },
    };
    expect(latestWeatherRun(weather)?.workspace).toBe('hrrr_16');
  });

  it('treats legacy runs without a frames block as drawable', () => {
    const weather = { models: { hrrr: { runs: [run('hrrr_17', null)] } } };
    expect(latestWeatherRun(weather)?.workspace).toBe('hrrr_17');
  });

  it('falls back to the newest run when nothing is drawable', () => {
    const weather = { models: { hrrr: { runs: [run('hrrr_17', []), run('hrrr_16', [])] } } };
    expect(latestWeatherRun(weather)?.workspace).toBe('hrrr_17');
  });
});

describe('fetchHotspots pagination', () => {
  it('stitches capped pages and dedupes the boundary day', async () => {
    const { fetchHotspots } = await import('./fireApi');
    const mk = (i: number, date: string) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-120 - i * 0.001, 48] },
      properties: { source: 'MODIS', acq_date: date, acq_time: '0400', frp: 1, confidence: 'n' },
    });
    // page 1 hits the cap (5) ending on 08-05; page 2 re-fetches since=08-05
    // (one duplicate) and finishes under the cap
    const page1 = [mk(1, '2026-08-01'), mk(2, '2026-08-02'), mk(3, '2026-08-03'), mk(4, '2026-08-05'), mk(5, '2026-08-05')];
    const page2 = [mk(4, '2026-08-05'), mk(5, '2026-08-05'), mk(6, '2026-08-06'), mk(7, '2026-08-07')];
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      const body = calls.length === 1 ? page1 : page2;
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: body }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const fc = await fetchHotspots({
        bbox: { minLat: 47, minLon: -121, maxLat: 49, maxLon: -119 },
        since: '2026-08-01',
        limit: 5,
      });
      expect(calls.length).toBe(2);
      expect(calls[1]).toContain('since=2026-08-05');
      expect(fc.features.length).toBe(7);
      const dates = fc.features.map((f) => f.properties.acq_date).sort();
      expect(dates[dates.length - 1]).toBe('2026-08-07');
      expect(fc.features.every((f) => typeof f.properties.acq_ts === 'number')).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('fetchFires pagination', () => {
  const fire = (id: string) => ({ cornea_id: id, post_title: id, active: true });
  const page = (ids: string[], total: number) => ({
    fires: ids.map(fire),
    pagination: { limit: 3, offset: 0, returned: ids.length, total },
  });

  async function withFetch(
    respond: (url: string, n: number) => Response,
    run: (calls: string[]) => Promise<void>,
  ) {
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return respond(String(url), calls.length);
    }) as typeof fetch;
    try {
      await run(calls);
    } finally {
      globalThis.fetch = orig;
    }
  }
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('asks for a 1000-row page and stops when it holds every fire', async () => {
    const { fetchFires, FIRES_PAGE_SIZE } = await import('./fireApi');
    expect(FIRES_PAGE_SIZE).toBe(1000);
    await withFetch(() => json(page(['a', 'b'], 2)), async (calls) => {
      const r = await fetchFires();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('active=true&limit=1000&fields=');
      expect(r.fires.map((f) => f.cornea_id)).toEqual(['a', 'b']);
    });
  });

  it('follows the reported total past a full page, keeping a fire seen twice once', async () => {
    const { fetchFires } = await import('./fireApi');
    // page 1 is full (3 of 7); "{C}" moves onto page 2 between requests
    await withFetch(
      (url) =>
        url.includes('offset=3')
          ? json(page(['c', 'd', 'e'], 7))
          : url.includes('offset=6')
            ? json(page(['f'], 7))
            : json(page(['a', 'b', '{C}'], 7)),
      async (calls) => {
        const r = await fetchFires();
        expect(calls).toHaveLength(3);
        expect(r.fires.map((f) => f.cornea_id)).toEqual(['a', 'b', '{C}', 'd', 'e', 'f']);
        expect(r.pagination.returned).toBe(6);
      },
    );
  });

  it('keeps the fires in hand when a later page fails', async () => {
    const { fetchFires } = await import('./fireApi');
    await withFetch(
      (url) => (url.includes('offset=') ? new Response('', { status: 503 }) : json(page(['a', 'b', 'c'], 5))),
      async () => {
        const r = await fetchFires();
        expect(r.fires.map((f) => f.cornea_id)).toEqual(['a', 'b', 'c']);
      },
    );
  });
});

describe('fireFilePaths', () => {
  const LISTED = '{44ACF72D-362D-4818-8504-FDB896A95A16}';
  const catalog = {
    schema_version: 1,
    version: 1,
    generated_at: '2026-11-04T00:00:00Z',
    counts: {},
    fires: [
      {
        cornea_id: LISTED,
        incident_manifest: '/catalogs/incidents/id/44acf72d-362d-4818-8504-fdb896a95a16.json',
        hotspot_archive: null,
      },
    ],
  } as unknown as import('./types').MasterCatalog;

  it("uses a listed fire's own entry, never guessing past a null", async () => {
    const { fireFilePaths } = await import('./queries');
    expect(fireFilePaths(catalog, LISTED.toLowerCase())).toEqual({
      manifest: '/catalogs/incidents/id/44acf72d-362d-4818-8504-fdb896a95a16.json',
      hotspotArchive: null,
      probe: false,
    });
  });

  it("probes an unlisted (inactive) fire's fire-ID paths", async () => {
    const { fireFilePaths } = await import('./queries');
    expect(fireFilePaths(catalog, '4883092e-485f-429d-878d-819f01172840')).toEqual({
      manifest: '/catalogs/incidents/id/4883092e-485f-429d-878d-819f01172840.json',
      hotspotArchive: '/hotspots/4883092e-485f-429d-878d-819f01172840/index.json',
      probe: true,
    });
    expect(fireFilePaths(catalog, '{AACFD673-4C1B-4CDF-B9DD-128E34BD7272}').manifest).toBe(
      '/catalogs/incidents/id/aacfd673-4c1b-4cdf-b9dd-128e34bd7272.json',
    );
  });

  it('waits for the catalog before naming any path', async () => {
    const { fireFilePaths } = await import('./queries');
    expect(fireFilePaths(undefined, LISTED)).toEqual({
      manifest: null,
      hotspotArchive: null,
      probe: false,
    });
  });
});
