import { describe, expect, it } from 'vitest';
import {
  buildDirectoryRows,
  compareRows,
  matchesFilter,
  matchesQuery,
  perimeterFreshness,
  selectDirectoryRows,
  summarizeRows,
  type DirectoryRow,
} from './rowModel';
import { isPrescribed } from '../api/fireFields';
import type { CatalogFire, FireSummary, FiresListResponse, MasterCatalog } from '../api/types';

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

describe('summarizeRows', () => {
  it('counts totals for the header subtitle', () => {
    expect(
      summarizeRows([
        row({ hasForecast: true }),
        row({ hasIncidentMaps: true }),
        row({ active: false }),
      ]),
    ).toEqual({ total: 3, active: 2, withForecast: 1, withIncidentMaps: 1 });
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
