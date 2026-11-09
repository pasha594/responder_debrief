import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIRECTORY_SORT,
  NEAR_RADIUS_MI,
  DIRECTORY_FILTERS,
  buildDirectoryRows,
  buildInactiveRows,
  compareRows,
  countByFilter,
  inactiveSearchRows,
  matchesFilter,
  matchesQuery,
  nearRows,
  perimeterFreshness,
  selectDirectoryRows,
  mergeInactiveRows,
  selectInactiveRows,
  type DirectoryRow,
} from './rowModel';
import { distanceMiles } from '../api/geo';
import { isPrescribed } from '../api/fireFields';
import type {
  CatalogFire,
  FireSummary,
  FiresListResponse,
  InactiveCatalog,
  MasterCatalog,
} from '../api/types';

const NOW = Date.parse('2026-08-17T12:00:00Z');

function catalogFire(over: Partial<CatalogFire> = {}): CatalogFire {
  return {
    fire_slug: 'moose',
    cornea_id: 'c-1',
    unique_fire_id: '2026-IDXYZ-1',
    name: 'Moose',
    coordinates: [-114, 45],
    state: 'ID',
    acres: 5892,
    containment: 20,
    active: true,
    last_updated: '2026-08-17T10:00:00Z',
    poly_last_updated: '2026-08-17T06:00:00Z',
    timezone: 'America/Boise',
    created_on: '2026-07-26T22:00:00Z',
    has_incident_maps: false,
    incident_manifest: null,
    incident_map_count: null,
    incident_ir_count: null,
    incident_latest_upload: null,
    ftp_match: null,
    has_spread_forecast: true,
    spread_latest_run: '2026-08-13T20:47:00Z',
    ...over,
  };
}

function summary(over: Partial<FireSummary> = {}): FireSummary {
  return {
    cornea_id: 'c-1',
    unique_slug: 'moose',
    post_title: 'Moose',
    fire_coordinates: '45, -114',
    acres: 6000,
    containment: 25,
    state: 'ID',
    firetype: 'Wildfire',
    created_on: '2026-07-26T22:00:00Z',
    last_updated: '2026-08-17T11:00:00Z',
    poly_last_updated: '2026-08-17T06:00:00Z',
    active: true,
    ...over,
  };
}

function catalog(fires: CatalogFire[]): MasterCatalog {
  return {
    schema_version: 2,
    version: 1,
    generated_at: '2026-08-17T11:00:00Z',
    fires,
    counts: {},
  };
}

function firesList(fires: FireSummary[]): FiresListResponse {
  return {
    fires,
    pagination: {
      limit: 500,
      offset: 0,
      returned: fires.length,
      total: fires.length,
      wildfireCount: fires.length,
      prescribedCount: 0,
    },
  };
}

function row(over: Partial<DirectoryRow> = {}): DirectoryRow {
  return {
    corneaId: 'x',
    fireSlug: 'x',
    name: 'X',
    state: 'CA',
    acres: 100,
    containment: 10,
    prescribed: false,
    active: true,
    coords: [-120, 39],
    createdOn: '2026-08-01T00:00:00Z',
    polyLastUpdated: null,
    hasForecast: false,
    spreadLatestRun: null,
    hasIncidentMaps: false,
    mapCount: 0,
    irCount: 0,
    latestUpload: null,
    latestUploadTs: null,
    perimeterCount: null,
    spreadRunCount: null,
    ...over,
  };
}

describe('buildDirectoryRows', () => {
  it('merges catalog + live index by cornea_id, live index winning on volatile fields', () => {
    const rows = buildDirectoryRows(catalog([catalogFire()]), firesList([summary()]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      corneaId: 'c-1',
      fireSlug: 'moose',
      acres: 6000, // live index is fresher
      containment: 25,
      hasForecast: true, // catalog-only fact survives
      spreadLatestRun: '2026-08-13T20:47:00Z',
      createdOn: '2026-07-26T22:00:00Z',
    });
  });

  it('keeps fires the hourly catalog has not seen yet', () => {
    const rows = buildDirectoryRows(
      catalog([catalogFire()]),
      firesList([summary(), summary({ cornea_id: 'c-2', post_title: 'Church 2', unique_slug: 'church-2' })]),
    );
    expect(rows.map((r) => r.corneaId).sort()).toEqual(['c-1', 'c-2']);
    const fresh = rows.find((r) => r.corneaId === 'c-2')!;
    expect(fresh.name).toBe('Church 2');
    expect(fresh.hasForecast).toBe(false);
  });

  it('works from either source alone and from neither', () => {
    expect(buildDirectoryRows(undefined, undefined)).toEqual([]);
    expect(buildDirectoryRows(catalog([catalogFire()]), undefined)).toHaveLength(1);
    expect(buildDirectoryRows(undefined, firesList([summary()]))).toHaveLength(1);
  });

  it('tolerates a catalog missing every optional directory field', () => {
    const bare = catalogFire();
    delete (bare as Partial<CatalogFire>).created_on;
    delete (bare as Partial<CatalogFire>).incident_map_count;
    delete (bare as Partial<CatalogFire>).incident_ir_count;
    delete (bare as Partial<CatalogFire>).incident_latest_upload;
    const [r] = buildDirectoryRows(catalog([bare]), undefined);
    expect(r.createdOn).toBeNull();
    expect(r.mapCount).toBe(0);
    expect(r.irCount).toBe(0);
    expect(r.latestUpload).toBeNull();
  });

  it('reads FTP counts and marks incident maps present', () => {
    const [r] = buildDirectoryRows(
      catalog([
        catalogFire({
          has_incident_maps: true,
          incident_map_count: 12,
          incident_ir_count: 2,
          incident_latest_upload: '2026-08-17',
        }),
      ]),
      undefined,
    );
    expect(r).toMatchObject({ mapCount: 12, irCount: 2, hasIncidentMaps: true, latestUpload: '2026-08-17' });
  });

  it('takes the newer perimeter timestamp of the two sources', () => {
    const [r] = buildDirectoryRows(
      catalog([catalogFire({ poly_last_updated: '2026-08-16T00:00:00Z' })]),
      firesList([summary({ poly_last_updated: '2026-08-17T09:00:00Z' })]),
    );
    expect(r.polyLastUpdated).toBe('2026-08-17T09:00:00Z');
  });

  it('flags prescribed fires from the live index firetype', () => {
    const [r] = buildDirectoryRows(
      catalog([catalogFire()]),
      firesList([summary({ firetype: 'Prescribed' })]),
    );
    expect(r.prescribed).toBe(true);
  });
});

describe('isPrescribed', () => {
  it('matches the API\u2019s "Prescribed" as well as "Prescribed Fire"', () => {
    expect(isPrescribed('Prescribed')).toBe(true);
    expect(isPrescribed('Prescribed Fire')).toBe(true);
    expect(isPrescribed('prescribed burn')).toBe(true);
    expect(isPrescribed('Wildfire')).toBe(false);
    expect(isPrescribed('Complex')).toBe(false);
    expect(isPrescribed(null)).toBe(false);
    expect(isPrescribed(undefined)).toBe(false);
  });
});

describe('perimeterFreshness', () => {
  it('buckets by age with 12 h / 48 h thresholds', () => {
    expect(perimeterFreshness('2026-08-17T11:00:00Z', NOW)).toBe('fresh'); // 1 h
    expect(perimeterFreshness('2026-08-17T00:30:00Z', NOW)).toBe('fresh'); // 11.5 h
    expect(perimeterFreshness('2026-08-16T23:00:00Z', NOW)).toBe('recent'); // 13 h
    expect(perimeterFreshness('2026-08-15T13:00:00Z', NOW)).toBe('recent'); // 47 h
    expect(perimeterFreshness('2026-08-15T11:00:00Z', NOW)).toBe('stale'); // 49 h
    expect(perimeterFreshness('2026-01-01T00:00:00Z', NOW)).toBe('stale');
  });

  it('treats missing/unparseable as none and future stamps as fresh', () => {
    expect(perimeterFreshness(null, NOW)).toBe('none');
    expect(perimeterFreshness(undefined, NOW)).toBe('none');
    expect(perimeterFreshness('not a date', NOW)).toBe('none');
    expect(perimeterFreshness('2026-08-18T00:00:00Z', NOW)).toBe('fresh');
  });
});

describe('filters', () => {
  it('matches each chip predicate', () => {
    expect(matchesFilter(row(), 'all')).toBe(true);
    expect(matchesFilter(row({ hasForecast: true }), 'forecast')).toBe(true);
    expect(matchesFilter(row({ hasForecast: false }), 'forecast')).toBe(false);
    expect(matchesFilter(row({ hasIncidentMaps: true }), 'maps')).toBe(true);
    expect(matchesFilter(row({ hasIncidentMaps: false }), 'maps')).toBe(false);
    expect(matchesFilter(row({ acres: 1001 }), 'large')).toBe(true);
    expect(matchesFilter(row({ acres: 1000 }), 'large')).toBe(false);
    expect(matchesFilter(row({ acres: null }), 'large')).toBe(false);
    expect(matchesFilter(row({ containment: 49 }), 'uncontained')).toBe(true);
    expect(matchesFilter(row({ containment: 50 }), 'uncontained')).toBe(false);
    expect(matchesFilter(row({ containment: null }), 'uncontained')).toBe(true);
  });

  it('searches name and state case-insensitively', () => {
    const r = row({ name: 'Sinlahekin', state: 'WA' });
    expect(matchesQuery(r, '')).toBe(true);
    expect(matchesQuery(r, '   ')).toBe(true);
    expect(matchesQuery(r, 'sinla')).toBe(true);
    expect(matchesQuery(r, 'wa')).toBe(true);
    expect(matchesQuery(r, 'oregon')).toBe(false);
  });
});

describe('compareRows', () => {
  const a = row({ name: 'Alpha', acres: 10, createdOn: '2026-08-01T00:00:00Z' });
  const b = row({ name: 'Beta', acres: 500, createdOn: '2026-07-01T00:00:00Z' });

  it('sorts numbers in both directions', () => {
    expect(compareRows(a, b, { key: 'acres', dir: 'desc' })).toBeGreaterThan(0);
    expect(compareRows(a, b, { key: 'acres', dir: 'asc' })).toBeLessThan(0);
  });

  it('sorts names alphabetically', () => {
    expect(compareRows(a, b, { key: 'name', dir: 'asc' })).toBeLessThan(0);
    expect(compareRows(a, b, { key: 'name', dir: 'desc' })).toBeGreaterThan(0);
  });

  it('sorts dates by instant, not string', () => {
    expect(compareRows(a, b, { key: 'started', dir: 'desc' })).toBeLessThan(0);
  });

  it('sinks missing values to the bottom in both directions', () => {
    const missing = row({ name: 'Zulu', acres: null });
    expect(compareRows(missing, a, { key: 'acres', dir: 'desc' })).toBeGreaterThan(0);
    expect(compareRows(missing, a, { key: 'acres', dir: 'asc' })).toBeGreaterThan(0);
    expect(compareRows(a, missing, { key: 'acres', dir: 'asc' })).toBeLessThan(0);
  });

  it('ranks forecast rows above forecast-less ones, newest run first', () => {
    const withRun = row({ name: 'A', hasForecast: true, spreadLatestRun: '2026-08-17T00:00:00Z' });
    const olderRun = row({ name: 'B', hasForecast: true, spreadLatestRun: '2026-08-10T00:00:00Z' });
    const none = row({ name: 'C', hasForecast: false });
    const sorted = [none, olderRun, withRun].sort((x, y) =>
      compareRows(x, y, { key: 'forecast', dir: 'desc' }),
    );
    expect(sorted.map((r) => r.name)).toEqual(['A', 'B', 'C']);
  });

  it('sorts FTP files by total sheets + IR flights', () => {
    const many = row({ name: 'A', mapCount: 12, irCount: 2 });
    const few = row({ name: 'B', mapCount: 3, irCount: 0 });
    const none = row({ name: 'C' });
    const sorted = [none, few, many].sort((x, y) =>
      compareRows(x, y, { key: 'files', dir: 'desc' }),
    );
    expect(sorted.map((r) => r.name)).toEqual(['A', 'B', 'C']);
  });

  it('breaks ties on name so re-sorting is stable', () => {
    const p = row({ name: 'Pine', acres: 100 });
    const q = row({ name: 'Oak', acres: 100 });
    expect(compareRows(p, q, { key: 'acres', dir: 'desc' })).toBeGreaterThan(0);
    expect(compareRows(p, q, { key: 'acres', dir: 'asc' })).toBeGreaterThan(0);
  });
});

describe('selectDirectoryRows', () => {
  const rows = [
    row({ corneaId: '1', name: 'Moose', state: 'ID', acres: 5892, hasForecast: true }),
    row({ corneaId: '2', name: 'Coleman Creek', state: 'OR', acres: 308721, hasIncidentMaps: true, mapCount: 3 }),
    row({ corneaId: '3', name: 'Church 2', state: 'CA', acres: 132 }),
  ];

  it('filters, searches and sorts without mutating the input', () => {
    const input = [...rows];
    const out = selectDirectoryRows(input, {
      query: '',
      filter: 'all',
      sort: { key: 'acres', dir: 'desc' },
    });
    expect(out.map((r) => r.corneaId)).toEqual(['2', '1', '3']);
    expect(input.map((r) => r.corneaId)).toEqual(['1', '2', '3']);
  });

  it('composes a chip with a query', () => {
    expect(
      selectDirectoryRows(rows, {
        query: 'or',
        filter: 'maps',
        sort: { key: 'acres', dir: 'desc' },
      }).map((r) => r.name),
    ).toEqual(['Coleman Creek']);
  });
});

describe('countByFilter', () => {
  it('counts each active chip over the rows given, and Inactive over its own list', () => {
    const counts = countByFilter(
      [
        row({ hasForecast: true, acres: 5000, containment: 80 }),
        row({ hasIncidentMaps: true, containment: null }),
        row({ acres: 2000, containment: 10 }),
      ],
      [row({ active: false }), row({ active: false })],
    );
    expect(counts).toEqual({ all: 3, forecast: 1, maps: 1, large: 2, uncontained: 2, inactive: 2 });
    expect(Object.keys(counts)).toEqual(DIRECTORY_FILTERS.map((f) => f.id));
  });

  it('labels the every-active-fire chip Active, with Inactive last', () => {
    expect(DIRECTORY_FILTERS[0]).toEqual({ id: 'all', label: 'Active' });
    expect(DIRECTORY_FILTERS.at(-1)).toEqual({ id: 'inactive', label: 'Inactive' });
  });
});

describe('FTP files when counts are not yet known', () => {
  it('treats a mirrored fire with no counts as having maps', () => {
    const rows = buildDirectoryRows(
      {
        fires: [
          {
            cornea_id: '{A}',
            fire_slug: 'a',
            name: 'A',
            state: 'OR',
            has_incident_maps: true,
            incident_map_count: null,
            incident_ir_count: null,
          },
        ],
      } as never,
      undefined,
    );
    expect(rows[0].hasIncidentMaps).toBe(true);
    expect(rows[0].mapCount).toBe(0);
  });
});

describe('matchesQuery state names', () => {
  it('matches full state names and exact abbreviations', () => {
    const or = row({ name: 'BIG GRASS', state: 'OR' });
    expect(matchesQuery(or, 'oregon')).toBe(true);
    expect(matchesQuery(or, 'Oreg')).toBe(true);
    expect(matchesQuery(or, 'or')).toBe(true);
    expect(matchesQuery(or, 'wash')).toBe(false);
    const wa = row({ name: 'LITTLE GIANT', state: 'WA' });
    expect(matchesQuery(wa, 'washington')).toBe(true);
    expect(matchesQuery(wa, 'giant')).toBe(true);
    // "or" as a query still matches OR fires but not a WA fire whose name
    // lacks it
    expect(matchesQuery(wa, 'or')).toBe(false);
  });
});

describe('matchesQuery two-letter queries', () => {
  it('never substring-matches other state names', () => {
    expect(matchesQuery(row({ name: 'X', state: 'CO' }), 'or')).toBe(false); // colORado
    expect(matchesQuery(row({ name: 'X', state: 'CA' }), 'or')).toBe(false); // califORnia
    expect(matchesQuery(row({ name: 'X', state: 'OR' }), 'or')).toBe(true);
    expect(matchesQuery(row({ name: 'X', state: 'IN' }), 'in')).toBe(true);
  });
});

describe('files column sorts by upload time', () => {
  it('orders by latest upload, files-without-time above no-files', () => {
    const a = row({ name: 'A', mapCount: 5, latestUploadTs: '2026-08-21T10:00:00Z' });
    const b = row({ name: 'B', mapCount: 90, latestUploadTs: '2026-08-19T10:00:00Z' });
    const c = row({ name: 'C', mapCount: 3, latestUploadTs: null, latestUpload: null });
    const d = row({ name: 'D', mapCount: 0, irCount: 0 });
    const sort = { key: 'files' as const, dir: 'desc' as const };
    const out = [d, c, b, a].sort((x, y) => compareRows(x, y, sort)).map((r) => r.name);
    expect(out).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('files column and fires mirrored before their counts are known', () => {
  it('ranks the "✓" rows with the fires that have files, not with the ones that have none', () => {
    const timed = row({ name: 'Timed', mapCount: 4, latestUploadTs: '2026-08-21T10:00:00Z' });
    const check = row({ name: 'Zulu check', hasIncidentMaps: true, mapCount: 0, irCount: 0 });
    const none = row({ name: 'Alpha none', hasIncidentMaps: false, mapCount: 0, irCount: 0 });
    const out = [none, check, timed]
      .sort((x, y) => compareRows(x, y, DEFAULT_DIRECTORY_SORT))
      .map((r) => r.name);
    expect(out).toEqual(['Timed', 'Zulu check', 'Alpha none']);
  });
});

describe('default roster order', () => {
  it('opens on newest FTP upload first; fires without files sink in name order', () => {
    const fresh = row({ name: 'Fresh', acres: 40, mapCount: 2, latestUploadTs: '2026-08-21T10:00:00Z' });
    const older = row({ name: 'Older', acres: 90_000, mapCount: 30, latestUploadTs: '2026-08-02T10:00:00Z' });
    const hugeNoFiles = row({ name: 'Zeta', acres: 400_000, mapCount: 0, irCount: 0 });
    const smallNoFiles = row({ name: 'Alpha', acres: 5, mapCount: 0, irCount: 0 });
    expect(DEFAULT_DIRECTORY_SORT).toEqual({ key: 'files', dir: 'desc' });
    const out = selectDirectoryRows([hugeNoFiles, older, smallNoFiles, fresh], {
      query: '',
      filter: 'all',
      sort: DEFAULT_DIRECTORY_SORT,
    }).map((r) => r.name);
    // size no longer leads: a 40-acre fire with this morning's maps beats a 400k-acre one with none
    expect(out).toEqual(['Fresh', 'Older', 'Alpha', 'Zeta']);
  });
});

describe('distanceMiles', () => {
  it('zero for identical points', () => {
    expect(distanceMiles([-120, 39], [-120, 39])).toBe(0);
  });

  it('Reno to Truckee is roughly 26 miles', () => {
    const reno: [number, number] = [-119.8138, 39.5296];
    const truckee: [number, number] = [-120.1833, 39.328];
    const d = distanceMiles(reno, truckee);
    expect(d).toBeGreaterThan(20);
    expect(d).toBeLessThan(32);
  });

  it('one degree of latitude is about 69 miles', () => {
    expect(distanceMiles([-100, 40], [-100, 41])).toBeCloseTo(69.09, 0);
  });
});

describe('coords on rows', () => {
  it('catalog coordinates flow through', () => {
    const rows = buildDirectoryRows(catalog([catalogFire({ coordinates: [-114, 45] })]), undefined);
    expect(rows[0].coords).toEqual([-114, 45]);
  });

  it('live-index "lat, lon" strings are parsed', () => {
    const rows = buildDirectoryRows(undefined, firesList([summary({ fire_coordinates: '39.5, -119.8' })]));
    expect(rows[0].coords).toEqual([-119.8, 39.5]);
  });

  it('merge keeps the catalog position, falls back to the live one', () => {
    const rows = buildDirectoryRows(
      catalog([catalogFire({ cornea_id: 'c-1', coordinates: [-114, 45] })]),
      firesList([summary({ cornea_id: 'c-1', fire_coordinates: '40, -110' })]),
    );
    expect(rows[0].coords).toEqual([-114, 45]);
  });

  it('garbage coordinates become null, never NaN', () => {
    const rows = buildDirectoryRows(
      catalog([catalogFire({ coordinates: [NaN, 45] as [number, number] })]),
      undefined,
    );
    expect(rows[0].coords).toBeNull();
  });
});

describe('near mode', () => {
  const reno: [number, number] = [-119.8138, 39.5296];
  const sort = { key: 'distance', dir: 'asc' } as const;

  it('keeps only fires within the radius, closest first, with distances', () => {
    const rows = [
      row({ corneaId: 'far', name: 'Far', coords: [-105, 40] }), // ~790 mi
      row({ corneaId: 'near2', name: 'Tahoe', coords: [-120.03, 39.09] }), // ~33 mi
      row({ corneaId: 'near1', name: 'Truckee', coords: [-120.1833, 39.328] }), // ~26 mi
      row({ corneaId: 'nocoords', name: 'Unknown', coords: null }),
    ];
    const shown = selectDirectoryRows(
      nearRows(rows, { query: 'reno', label: 'Reno', coords: reno }),
      { query: '', filter: 'all', sort },
    );
    expect(shown.map((r) => r.corneaId)).toEqual(['near1', 'near2']);
    expect(shown[0].distanceMi).toBeGreaterThan(20);
    expect(shown[0].distanceMi).toBeLessThan(32);
  });

  it('radius boundary: just inside stays, just outside goes', () => {
    // ~1 degree lon at lat 39.5 is ~53.5 mi; place two fires straddling 200 mi
    const inside = row({ corneaId: 'in', coords: [-119.8138, 39.5296 + 199 / 69.09] });
    const outside = row({ corneaId: 'out', coords: [-119.8138, 39.5296 + 201 / 69.09] });
    const shown = selectDirectoryRows(
      nearRows([inside, outside], { query: 'reno', label: 'Reno', coords: reno }),
      { query: '', filter: 'all', sort },
    );
    expect(shown.map((r) => r.corneaId)).toEqual(['in']);
    expect(NEAR_RADIUS_MI).toBe(200);
  });

  it('query and filter still apply within the near set', () => {
    const rows = [
      row({ corneaId: 'a', name: 'Alpha', acres: 5000, coords: [-120.1, 39.4] }),
      row({ corneaId: 'b', name: 'Beta', acres: 10, coords: [-120.2, 39.3] }),
    ];
    const shown = selectDirectoryRows(
      nearRows(rows, { query: 'reno', label: 'Reno', coords: reno }),
      { query: 'alpha', filter: 'large', sort },
    );
    expect(shown.map((r) => r.corneaId)).toEqual(['a']);
  });

  it('without near, rows carry no distance and column sort is untouched', () => {
    const pool = nearRows([row({ corneaId: 'a' })], null);
    const shown = selectDirectoryRows(pool, {
      query: '',
      filter: 'all',
      sort: { key: 'acres', dir: 'desc' },
    });
    expect(shown[0].distanceMi).toBeUndefined();
    // no near: identity passes straight through (DirectoryRow memo depends on it)
    expect(pool[0]).toBe(shown[0]);
  });
});

describe('inactive search results', () => {
  const dome = (over: Partial<FireSummary> = {}) =>
    summary({ post_title: 'Dome', state: 'CA', active: false, ...over });
  const found = firesList([
    dome({ cornea_id: '4883092e-485f-429d-878d-819f01172840', created_on: '2026-09-15T15:28:00Z', containment: 100 }),
    dome({ cornea_id: '{63E1A489}', state: 'AZ', created_on: '2025-08-24T23:08:24Z', acres: 0 }),
    // the API's full-text search also matches descriptions ("Kettle Dome near…")
    dome({ cornea_id: '{KETTLE}', post_title: 'Kettle', created_on: '2025-08-31T07:50:48Z' }),
    dome({ cornea_id: '{MOVIE}', post_title: 'Movie Dome', state: 'FL', created_on: '2026-08-19T23:42:19Z', acres: 6222 }),
  ]);

  it('keeps name matches only, marked inactive', () => {
    const rows = inactiveSearchRows(found, ' Dome ', []);
    expect(rows.map((r) => r.corneaId)).toEqual([
      '4883092e-485f-429d-878d-819f01172840',
      '{63E1A489}',
      '{MOVIE}',
    ]);
    expect(rows.every((r) => r.active === false)).toBe(true);
  });

  it('needs three characters', () => {
    expect(inactiveSearchRows(found, 'do', [])).toEqual([]);
    expect(inactiveSearchRows(found, 'dom', [])).toHaveLength(3);
    expect(inactiveSearchRows(undefined, 'dome', [])).toEqual([]);
  });

  it('leaves out a fire the roster already lists, however its id is spelled', () => {
    const roster = [row({ corneaId: '{4883092E-485F-429D-878D-819F01172840}', name: 'Dome' })];
    expect(inactiveSearchRows(found, 'dome', roster).map((r) => r.corneaId)).toEqual([
      '{63E1A489}',
      '{MOVIE}',
    ]);
  });

  it('lists the newest fire first when the column has nothing to compare', () => {
    const rows = inactiveSearchRows(found, 'dome', []);
    const sorted = selectInactiveRows(rows, { filter: 'all', sort: DEFAULT_DIRECTORY_SORT });
    expect(sorted.map((r) => `${r.name} ${r.state}`)).toEqual(['Dome CA', 'Movie Dome FL', 'Dome AZ']);
  });

  it('follows a column sort that has values, and the chip filters', () => {
    const rows = inactiveSearchRows(found, 'dome', []);
    const bySize = selectInactiveRows(rows, { filter: 'all', sort: { key: 'acres', dir: 'desc' } });
    expect(bySize.map((r) => r.acres)).toEqual([6222, 6000, 0]);
    const large = selectInactiveRows(rows, { filter: 'large', sort: DEFAULT_DIRECTORY_SORT });
    expect(large.map((r) => r.name)).toEqual(['Dome', 'Movie Dome']);
    expect(selectInactiveRows(rows, { filter: 'maps', sort: DEFAULT_DIRECTORY_SORT })).toEqual([]);
  });
});

describe('inactive fires with incident maps (catalogs/inactive.json)', () => {
  const doc = (fires: CatalogFire[]): InactiveCatalog => ({
    schema_version: 1,
    generated_at: '2026-11-09T00:00:00Z',
    fires,
  });
  const domeFk = '4883092e-485f-429d-878d-819f01172840';
  const inactive = doc([
    catalogFire({
      cornea_id: domeFk,
      name: 'Dome',
      state: 'CA',
      active: false,
      acres: 6788,
      has_incident_maps: true,
      incident_manifest: `/catalogs/incidents/id/${domeFk}.json`,
      incident_map_count: 195,
      incident_latest_upload: '2026-10-17',
      has_spread_forecast: false,
      spread_latest_run: null,
    }),
    catalogFire({ cornea_id: '{TIMBER}', name: 'Timber', active: false, has_incident_maps: true }),
  ]);

  it('reads rows as inactive, leaving out fires the roster lists', () => {
    const rows = buildInactiveRows(inactive, [row({ corneaId: '{timber}' })]);
    expect(rows.map((r) => r.name)).toEqual(['Dome']);
    expect(rows[0]).toMatchObject({ active: false, hasIncidentMaps: true, mapCount: 195, hasForecast: false });
    expect(buildInactiveRows(undefined, [])).toEqual([]);
  });

  it('the Inactive chip passes every inactive row and no active one', () => {
    expect(matchesFilter(row({ active: false }), 'inactive')).toBe(true);
    expect(matchesFilter(row({ active: true }), 'inactive')).toBe(false);
  });

  it('a search hit on the inactive list keeps its map facts, with the live acres', () => {
    const known = buildInactiveRows(inactive, []);
    const found = firesList([
      summary({ cornea_id: '{4883092E-485F-429D-878D-819F01172840}', post_title: 'Dome', active: false, acres: 6800 }),
      summary({ cornea_id: '{OTHER}', post_title: 'Dome', state: 'AZ', active: false }),
    ]);
    const rows = inactiveSearchRows(found, 'dome', [], known);
    expect(rows[0]).toMatchObject({ corneaId: domeFk, hasIncidentMaps: true, mapCount: 195, acres: 6800 });
    expect(rows[1]).toMatchObject({ corneaId: '{OTHER}', hasIncidentMaps: false, active: false });
    // so the maps chip keeps it
    expect(selectInactiveRows(rows, { filter: 'maps', sort: DEFAULT_DIRECTORY_SORT }).map((r) => r.state)).toEqual(['CA']);
  });

  it('merges two lists, each fire once and the first row winning', () => {
    const a = [row({ corneaId: '{AAA}', name: 'From the list' })];
    const b = [row({ corneaId: 'aaa', name: 'From search' }), row({ corneaId: 'bbb' })];
    expect(mergeInactiveRows(a, b).map((r) => r.name)).toEqual(['From the list', 'X']);
    expect(mergeInactiveRows(a, [])).toBe(a);
    expect(mergeInactiveRows([], b)).toBe(b);
  });
});
