import { describe, expect, it } from 'vitest';
import {
  aliasHit,
  buildPackPlan,
  choosePacks,
  downloadFolder,
  formatBytes,
  packForFire,
  servingIndex,
  sheetTileUrls,
  type PackInputs,
  type PackMeta,
} from './packModel';
import type { IncidentManifest, PyrecastRun } from '../api/types';

const NOW = Date.parse('2026-08-31T12:00:00Z');

function inputs(over: Partial<PackInputs> = {}): PackInputs {
  return {
    corneaId: 'c-1',
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

// ---------- stored packs ----------

const DATA = 'https://data.test';
// Two active Chipmunk fires: FL's pack predates ID folders and sits in the
// fire_slug folder the slug later moved off of.
const FL = '{8E2C1A4B-0F3D-4C6E-9A7B-1D2E3F4A5B6C}';
const FL_FK = '8e2c1a4b-0f3d-4c6e-9a7b-1d2e3f4a5b6c';
const WI = '{1B2C3D4E-5F60-4718-8A9B-0C1D2E3F4A5B}';
const WI_FK = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';

function meta(over: Partial<PackMeta> = {}): PackMeta {
  return {
    version: 1,
    slug: 'x',
    corneaId: FL,
    name: 'Chipmunk',
    state: 'FL',
    downloadedAt: '2026-10-06T12:00:00Z',
    bytes: 1,
    fileCount: 1,
    files: {},
    prefixes: [],
    ...over,
  };
}

describe('choosePacks', () => {
  it('merges braced and bare ids of one fire', () => {
    const { packs, claimants } = choosePacks([
      ['chipmunk', meta({ corneaId: FL })],
      [FL_FK, meta({ corneaId: FL_FK.toUpperCase(), downloadedAt: '2026-10-07T12:00:00Z' })],
    ]);
    expect(Object.keys(packs)).toEqual([FL_FK]);
    expect(packs[FL_FK].slug).toBe(FL_FK);
    expect(claimants[FL_FK]).toEqual([FL_FK, 'chipmunk']);
  });

  it('the newest downloadedAt wins; a tie goes to the fire-key folder', () => {
    const newer = choosePacks([
      ['chipmunk', meta({ downloadedAt: '2026-10-08T00:00:00Z' })],
      [FL_FK, meta({ downloadedAt: '2026-10-07T00:00:00Z' })],
    ]);
    expect(newer.packs[FL_FK].slug).toBe('chipmunk');
    const tie = choosePacks([
      ['a-copy', meta()],
      ['chipmunk', meta()],
      [FL_FK, meta()],
    ]);
    expect(tie.packs[FL_FK].slug).toBe(FL_FK);
    expect(tie.claimants[FL_FK]).toEqual([FL_FK, 'a-copy', 'chipmunk']);
  });

  it('an unparseable downloadedAt counts as oldest', () => {
    const { packs } = choosePacks([
      ['chipmunk', meta({ downloadedAt: 'garbage' })],
      ['zz-copy', meta({ downloadedAt: '2020-01-01T00:00:00Z' })],
    ]);
    expect(packs[FL_FK].slug).toBe('zz-copy');
  });

  it('sets slug to the real folder and skips packs without a corneaId', () => {
    const { packs, claimants } = choosePacks([
      ['chipmunk', meta({ slug: 'chipmunk-fl' })],
      ['orphan', meta({ corneaId: '' })],
      ['braces-only', meta({ corneaId: '{}' })],
    ]);
    expect(packs[FL_FK].slug).toBe('chipmunk');
    expect(Object.keys(packs)).toEqual([FL_FK]);
    expect(Object.values(claimants).flat()).not.toContain('orphan');
  });

  it('lists every claimant, per fire', () => {
    const { packs, claimants } = choosePacks([
      ['chipmunk', meta({ corneaId: WI, downloadedAt: '2026-10-08T00:00:00Z' })],
      ['chipmunk-old', meta({ corneaId: FL })],
      [FL_FK, meta({ corneaId: FL, downloadedAt: '2026-10-05T00:00:00Z' })],
    ]);
    expect(claimants).toEqual({ [WI_FK]: ['chipmunk'], [FL_FK]: ['chipmunk-old', FL_FK] });
    expect(packs[WI_FK].corneaId).toBe(WI);
    expect(packs[FL_FK].slug).toBe('chipmunk-old');
  });
});

describe('downloadFolder', () => {
  it("reuses the legacy winner's folder", () => {
    const { packs } = choosePacks([['chipmunk', meta()]]);
    expect(downloadFolder(packs, FL)).toBe('chipmunk');
  });

  it('gives a new fire its fire key', () => {
    expect(downloadFolder({}, FL)).toBe(FL_FK);
  });

  it("Chipmunk: packs/chipmunk holds FL, so a WI download goes to WI's own folder", () => {
    const { packs } = choosePacks([['chipmunk', meta({ corneaId: FL })]]);
    expect(downloadFolder(packs, WI)).toBe(WI_FK);
    expect(downloadFolder(packs, FL)).toBe('chipmunk');
  });

  it('a null id returns null', () => {
    expect(downloadFolder({}, null)).toBeNull();
    expect(downloadFolder({}, '{}')).toBeNull();
  });
});

describe('packForFire', () => {
  it('finds the pack by any id spelling', () => {
    const { packs } = choosePacks([['chipmunk', meta({ corneaId: FL })]]);
    expect(packForFire(packs, FL)?.slug).toBe('chipmunk');
    expect(packForFire(packs, FL_FK)?.slug).toBe('chipmunk');
    expect(packForFire(packs, FL_FK.toUpperCase())?.slug).toBe('chipmunk');
    expect(packForFire(packs, WI)).toBeNull();
    expect(packForFire(packs, null)).toBeNull();
  });

  it('never returns an inherited property', () => {
    expect(packForFire({}, 'constructor')).toBeNull();
  });
});

describe('servingIndex', () => {
  const catalog = `${DATA}/catalogs/catalog.json`;

  it('a URL two packs hold (the shared catalog.json) serves the newest pack', () => {
    const idx = servingIndex([
      meta({ slug: WI_FK, corneaId: WI, downloadedAt: '2026-10-08T00:00:00Z',
        files: { [catalog]: 'wi-cat.json' } }),
      meta({ slug: 'chipmunk', files: { [catalog]: 'fl-cat.json' } }),
    ]);
    expect(idx.urls.get(catalog)).toEqual({ folder: WI_FK, file: 'wi-cat.json' });
  });

  it('removing one pack keeps URLs another pack still holds', () => {
    const fl = meta({ slug: 'chipmunk', files: { [catalog]: 'fl-cat.json' }, immutable: [catalog] });
    const wi = meta({ slug: WI_FK, corneaId: WI, downloadedAt: '2026-10-08T00:00:00Z',
      files: { [catalog]: 'wi-cat.json' } });
    expect(servingIndex([fl, wi]).immutable.has(catalog)).toBe(false); // WI's copy serves
    const idx = servingIndex([fl]);
    expect(idx.urls.get(catalog)).toEqual({ folder: 'chipmunk', file: 'fl-cat.json' });
    expect(idx.immutable.has(catalog)).toBe(true);
  });

  it('serves shadowed copies too, with prefixes newest first', () => {
    const oldCopy = meta({ slug: 'chipmunk', files: { [`${DATA}/only-old.png`]: 'o.png' },
      prefixes: [{ prefix: 'https://api.open-meteo.com/v1/forecast?latitude=1', file: 'old.json' }] });
    const newCopy = meta({ slug: FL_FK, downloadedAt: '2026-10-07T00:00:00Z',
      prefixes: [{ prefix: 'https://api.open-meteo.com/v1/forecast?latitude=1', file: 'new.json' }] });
    const idx = servingIndex([oldCopy, newCopy]);
    expect(idx.urls.get(`${DATA}/only-old.png`)).toEqual({ folder: 'chipmunk', file: 'o.png' });
    expect(idx.prefixes.map((p) => p.file)).toEqual(['new.json', 'old.json']);
  });
});

describe('aliasHit', () => {
  const legacy = `${DATA}/catalogs/incidents/chipmunk.json`;
  const idUrl = (fk: string) => `${DATA}/catalogs/incidents/id/${fk}.json`;

  it("maps the ID manifest to the fire's own legacy manifest file", () => {
    const { packs } = choosePacks([
      ['chipmunk', meta({ files: { [legacy]: 'fl-man.json', [`${DATA}/catalogs/catalog.json`]: 'c.json' } })],
    ]);
    expect(aliasHit(idUrl(FL_FK), packs, DATA)).toEqual({ folder: 'chipmunk', file: 'fl-man.json' });
  });

  it("serves FL's file even when WI's newer pack holds the same legacy URL", () => {
    const { packs } = choosePacks([
      ['chipmunk', meta({ corneaId: FL, files: { [legacy]: 'fl-man.json' } })],
      [WI_FK, meta({ corneaId: WI, downloadedAt: '2026-10-08T00:00:00Z',
        files: { [legacy]: 'wi-man.json' } })],
    ]);
    // The shared index hands the legacy URL to WI's newer pack...
    expect(servingIndex(Object.values(packs)).urls.get(legacy)?.file).toBe('wi-man.json');
    // ...but FL's ID manifest reads FL's own copy.
    expect(aliasHit(idUrl(FL_FK), packs, DATA)).toEqual({ folder: 'chipmunk', file: 'fl-man.json' });
    expect(aliasHit(idUrl(WI_FK), packs, DATA)).toEqual({ folder: WI_FK, file: 'wi-man.json' });
  });

  it('returns null when there is no pack or no single manifest', () => {
    const { packs } = choosePacks([
      ['chipmunk', meta({ files: { [`${DATA}/catalogs/catalog.json`]: 'c.json' } })],
      [WI_FK, meta({ corneaId: WI, files: {
        [legacy]: 'a.json', [`${DATA}/catalogs/incidents/chipmunk-wi.json`]: 'b.json' } })],
    ]);
    expect(aliasHit(idUrl(FL_FK), packs, DATA)).toBeNull(); // pack holds no manifest
    expect(aliasHit(idUrl(WI_FK), packs, DATA)).toBeNull(); // two candidates: ambiguous
    expect(aliasHit(idUrl('0000'), packs, DATA)).toBeNull(); // no pack
    expect(aliasHit(idUrl('constructor'), packs, DATA)).toBeNull();
    expect(aliasHit(legacy, packs, DATA)).toBeNull(); // not an ID path
    expect(aliasHit(`${idUrl(FL_FK)}?x=1`, packs, DATA)).toBeNull();
  });

  it('never crosses fire keys', () => {
    const { packs } = choosePacks([
      ['chipmunk', meta({ corneaId: FL, files: { [legacy]: 'fl-man.json' } })],
    ]);
    expect(aliasHit(idUrl(WI_FK), packs, DATA)).toBeNull();
    expect(aliasHit(idUrl(FL_FK.toUpperCase()), packs, DATA)).toBeNull();
  });
});
