import { describe, expect, it } from 'vitest';
import { buildPackPlan, formatBytes, sheetTileUrls, type PackInputs } from './packModel';
import type { IncidentManifest, PyrecastRun } from '../api/types';

const NOW = Date.parse('2026-08-31T12:00:00Z');

function inputs(over: Partial<PackInputs> = {}): PackInputs {
  return {
    corneaId: 'c-1',
    slug: 'test-fire',
    manifestPath: '/catalogs/incidents/test-fire.json',
    hotspotIndexPath: '/hotspots/test-fire/index.json',
    manifest: null,
    hotspotIndex: null,
    perimeterIndex: null,
    spreadRun: null,
    weatherRun: null,
    weatherProducts: [],
    nowMs: NOW,
    ...over,
  };
}

describe('sheetTileUrls', () => {
  it('enumerates the exact slippy grid over the bounds', () => {
    const urls = sheetTileUrls({
      url_template: '/tiles/incidents/x/{z}/{x}/{y}.png',
      minzoom: 3,
      maxzoom: 4,
      bounds: [-120, 40, -110, 45],
    });
    // z3: x 1..1, y 2..3 = 2 tiles; z4: x 2..3, y 5..6 = 4 tiles
    expect(urls).toHaveLength(6);
    expect(urls[0]).toContain('/tiles/incidents/x/3/1/2.png');
    expect(urls.some((u) => u.includes('/3/1/3.png'))).toBe(true);
    expect(urls.some((u) => u.includes('/4/2/5.png'))).toBe(true);
    expect(urls.some((u) => u.includes('/4/3/6.png'))).toBe(true);
  });

  it('grid never escapes the tile space at low zoom', () => {
    const urls = sheetTileUrls({
      url_template: '/t/{z}/{x}/{y}.png',
      minzoom: 0,
      maxzoom: 0,
      bounds: [-179, -85, 179, 85],
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/t/0/0/0.png');
  });
});

describe('buildPackPlan', () => {
  it('always carries the snapshot JSONs (mutable — re-downloaded on update)', () => {
    const plan = buildPackPlan(inputs());
    const urls = plan.files.map((f) => f.url);
    expect(urls.some((u) => u.includes('/catalogs/catalog.json'))).toBe(true);
    expect(urls.some((u) => u.includes('/fires/c-1/perimeters'))).toBe(true);
    expect(urls.some((u) => u.includes('/catalogs/incidents/test-fire.json'))).toBe(true);
    expect(plan.files.every((f) => urls.includes(f.url))).toBe(true);
    expect(plan.files.filter((f) => !f.immutable).length).toBe(plan.files.length);
  });

  it('keeps perimeter versions from the last 7 days plus the latest, verbatim paths', () => {
    const plan = buildPackPlan(
      inputs({
        perimeterIndex: [
          { path: '/perimeters/old.json', date: '2026-07-01T00:00:00Z' },
          { path: '/perimeters/wk.json', date: '2026-08-27T00:00:00Z' },
          { path: '/perimeters/new.json', date: '2026-08-31T00:00:00Z' },
        ],
      }),
    );
    const perims = plan.files.filter((f) => f.url.includes('/perimeters/') && f.immutable);
    expect(perims.map((p) => p.url.split('/perimeters/')[1])).toEqual(['wk.json', 'new.json']);
  });

  it('latest perimeter is included even when older than 7 days', () => {
    const plan = buildPackPlan(
      inputs({
        perimeterIndex: [{ path: '/perimeters/only.json', date: '2026-07-01T00:00:00Z' }],
      }),
    );
    expect(plan.files.some((f) => f.url.endsWith('/perimeters/only.json'))).toBe(true);
  });

  it('hotspot chunks: only days closed 2+ days count immutable (worker can rewrite yesterday)', () => {
    const plan = buildPackPlan(
      inputs({
        hotspotIndex: {
          schema: 1,
          updated_at: '2026-08-31T11:00:00Z',
          gen: 3,
          bbox: [0, 0, 1, 1],
          days: ['2026-08-28', '2026-08-30', '2026-08-31'],
        },
      }),
    );
    const chunks = plan.files.filter((f) => f.url.includes('/g3/'));
    expect(chunks).toHaveLength(3);
    expect(chunks.find((c) => c.url.endsWith('2026-08-28.json'))?.immutable).toBe(true);
    expect(chunks.find((c) => c.url.endsWith('2026-08-30.json'))?.immutable).toBe(false);
    expect(chunks.find((c) => c.url.endsWith('2026-08-31.json'))?.immutable).toBe(false);
  });

  it('spread run contributes one ToA tif per percentile', () => {
    const run = {
      workspace: 'test-fire_20260830_120000',
      slug: 'test-fire',
      run_ts: '20260830_120000',
      run_time: '2026-08-30T12:00:00Z',
      horizon_hours: 168,
      centroid: null,
      toa: { percentiles: [10, 50, 90] },
      products: {},
    } as unknown as PyrecastRun;
    const plan = buildPackPlan(inputs({ spreadRun: run }));
    const tifs = plan.files.filter((f) => f.url.endsWith('.tif'));
    expect(tifs).toHaveLength(3);
    expect(tifs[1].url).toContain('/test-fire/20260830_120000/50.tif');
  });

  it('maps: only sheets dated within the last 2 days, tiles + preview', () => {
    const manifest = {
      maps: [
        {
          op_date: '2026-08-30',
          preview_url: '/previews/incidents/test-fire/aaaa.png',
          tiles: {
            url_template: '/tiles/incidents/test-fire/aaaa/{z}/{x}/{y}.png',
            minzoom: 3,
            maxzoom: 3,
            bounds: [-120, 40, -119, 41] as [number, number, number, number],
          },
        },
        { op_date: '2026-08-20', preview_url: '/previews/incidents/test-fire/old.png', tiles: null },
        { op_date: null, preview_url: null, tiles: null },
      ],
      ir_flights: [
        {
          geojson_url: '/vectors/ir/test-fire/f1.geojson',
          preview_url: '/previews/incidents/test-fire/irpdf.png',
        },
      ],
    } as unknown as IncidentManifest;
    const plan = buildPackPlan(inputs({ manifest }));
    expect(plan.mapSheetCount).toBe(1);
    expect(plan.tileCount).toBeGreaterThan(0);
    expect(plan.files.some((f) => f.url.includes('/previews/incidents/test-fire/aaaa.png'))).toBe(true);
    // previews pack for EVERY sheet (thumbnails); only tiles are windowed
    expect(plan.files.some((f) => f.url.includes('old.png'))).toBe(true);
    expect(plan.files.some((f) => f.url.includes('f1.geojson'))).toBe(true);
    expect(plan.files.some((f) => f.url.includes('irpdf.png'))).toBe(true);
  });

  it('falls back to the newest dated sheet day when nothing is in the 2-day window', () => {
    const manifest = {
      maps: [
        {
          op_date: '2026-08-25',
          preview_url: '/previews/incidents/test-fire/new.png',
          tiles: null,
        },
        { op_date: '2026-08-20', preview_url: '/previews/incidents/test-fire/old.png', tiles: null },
      ],
      ir_flights: [],
    } as unknown as IncidentManifest;
    const plan = buildPackPlan(inputs({ manifest }));
    // the newest dated day (08-25) is the effective window: 1 sheet's tiles
    expect(plan.mapSheetCount).toBe(1);
    expect(plan.files.some((f) => f.url.includes('new.png'))).toBe(true);
  });

  it('weather frames: rendered products x capped hours + wind grids, via the app resolvers', () => {
    const hours = Array.from({ length: 20 }, (_, i) =>
      new Date(Date.parse('2026-08-31T00:00:00Z') + i * 3_600_000).toISOString().replace('.000Z', 'Z'),
    );
    const run = {
      workspace: 'hrrr_20260831_00',
      run_time: '2026-08-31T00:00:00Z',
      hours,
      frames: {
        hours,
        image_template: '/frames/weather/{ws}/{product}/{epoch_ms}.png',
        wind_uv_template: '/frames/weather/{ws}/wind-uv/{epoch_ms}.json',
      },
    } as unknown as import('../api/types').WeatherRun;
    const plan = buildPackPlan(inputs({ weatherRun: run, weatherProducts: ['ws', 'smoke'] }));
    const frames = plan.files.filter((f) => f.url.includes('/frames/weather/') && f.url.includes('.png'));
    const uv = plan.files.filter((f) => f.url.includes('wind-uv'));
    expect(frames).toHaveLength(2 * 12); // capped at WEATHER_HOURS_CAP
    expect(uv).toHaveLength(12);
    expect(frames[0].url).toContain('?cv=3'); // exact match with weatherImageUrl
  });

  it('previews pack for every sheet even outside the tile window', () => {
    const manifest = {
      maps: [
        { op_date: '2026-08-30', preview_url: '/previews/incidents/test-fire/a.png', tiles: null },
        { op_date: '2026-07-01', preview_url: '/previews/incidents/test-fire/b.png', tiles: null },
      ],
      ir_flights: [],
    } as unknown as IncidentManifest;
    const plan = buildPackPlan(inputs({ manifest }));
    expect(plan.files.some((f) => f.url.includes('/a.png'))).toBe(true);
    expect(plan.files.some((f) => f.url.includes('/b.png'))).toBe(true);
    expect(plan.mapSheetCount).toBe(1); // tiles still windowed
  });

  it('estimate sums per-file estimates', () => {
    const plan = buildPackPlan(inputs());
    expect(plan.estBytes).toBe(plan.files.reduce((s, f) => s + f.estBytes, 0));
  });
});

describe('formatBytes', () => {
  it('labels sensibly across magnitudes', () => {
    expect(formatBytes(180_000_000)).toBe('180 MB');
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB');
    expect(formatBytes(4_000)).toBe('4 KB');
  });
});

describe('buildPackPlan — offline Walk bundle', () => {
  const entry = {
    descriptor: '/routing/k/babc/bundle.json', bundle_id: 'abc', built_at: 't',
    bbox: [-115.1, 44.1, -114.9, 44.3] as [number, number, number, number], cell_m: 30, bytes: 9,
  };
  const bundle = {
    schema: 'rd-routing-bundle/1', recipe: 1, bundle_id: 'abc', cornea_id: 'c-1', fire_key: 'k',
    built_at: 't', crs: { epsg: 32611, zone: 11, northern: true },
    grid: { x0: 0, y0: 0, cell_m: 30, width: 10, height: 10 },
    bounds4326: [0, 0, 1, 1] as [number, number, number, number],
    files: {
      grid: { path: '/routing/k/babc/grid.tif', bytes: 2_000_000 },
      dem: { path: '/routing/k/babc/dem.tif', bytes: 3_000_000 },
      graph: { path: '/routing/k/babc/graph.bin.gz', bytes: 500_000 },
      trails: { path: '/routing/k/babc/trails.pmtiles', bytes: 1_000_000, minzoom: 10, maxzoom: 14 },
    },
  };

  it('adds the index snapshot (mutable) plus descriptor + 4 files (immutable)', () => {
    const plan = buildPackPlan(inputs({ routingEntry: entry, routingBundle: bundle }));
    const idx = plan.files.find((f) => f.url.endsWith('/catalogs/routing.json'));
    expect(idx?.immutable).toBe(false);
    const routing = plan.files.filter((f) => f.url.includes('/routing/k/babc/'));
    expect(routing.map((f) => f.url.split('/').pop())).toEqual([
      'bundle.json', 'grid.tif', 'dem.tif', 'graph.bin.gz', 'trails.pmtiles']);
    expect(routing.every((f) => f.immutable && !f.optional)).toBe(true);
    expect(plan.routingBytes).toBe(6_500_000);
  });

  it('adds nothing when the fire has no bundle', () => {
    const plan = buildPackPlan(inputs({ routingEntry: entry, routingBundle: null }));
    expect(plan.files.some((f) => f.url.includes('routing'))).toBe(false);
    expect(plan.routingBytes).toBe(0);
  });
});
