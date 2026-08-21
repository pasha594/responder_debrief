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
