/**
 * Pure row model for the fire directory: merge the hourly worker catalog with
 * the live fires index, then filter/sort. No React, no fetching — everything
 * here is unit-tested.
 *
 * catalog.json is the richer source (perimeter freshness, forecast + FTP
 * counts) but it only regenerates hourly, so the live /fires index is merged
 * in: it fills the gaps and keeps brand-new fires listed.
 *
 * County is deliberately absent — neither source carries it, and resolving it
 * would cost one detail request per fire.
 */
import { isPrescribed } from '../api/fireFields';
import { parseFireCoordinates } from '../api/geo';
import type { CatalogFire, FireSummary, FiresListResponse, MasterCatalog } from '../api/types';

export interface DirectoryRow {
  corneaId: string;
  /** Worker slug; null for fires only present in the live index. */
  fireSlug: string | null;
  name: string;
  state: string;
  acres: number | null;
  containment: number | null;
  prescribed: boolean;
  active: boolean;
  /** ISO start date. */
  createdOn: string | null;
  /** ISO timestamp of the newest perimeter version. */
  polyLastUpdated: string | null;
  hasForecast: boolean;
  /** ISO timestamp of the newest pyrecast run. */
  spreadLatestRun: string | null;
  hasIncidentMaps: boolean;
  mapCount: number;
  irCount: number;
  /** YYYY-MM-DD of the newest FTP upload. */
  latestUpload: string | null;
  /** Full ISO timestamp of the newest FTP upload (when the catalog has it). */
  latestUploadTs: string | null;
  perimeterCount: number | null;
  spreadRunCount: number | null;
  /** [lon, lat] when either source carries a usable position. */
  coords: [number, number] | null;
  /** Miles from the active "near" place; attached only in near mode. */
  distanceMi?: number;
}

function lonLat(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [lon, lat] = v as [unknown, unknown];
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return [lon, lat];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function count(v: unknown): number {
  const n = num(v);
  return n != null && n > 0 ? Math.round(n) : 0;
}

/** Row from a catalog entry alone (every optional field guarded). */
function fromCatalog(f: CatalogFire): DirectoryRow {
  const maps = count(f.incident_map_count);
  const ir = count(f.incident_ir_count);
  return {
    corneaId: f.cornea_id,
    fireSlug: str(f.fire_slug),
    name: str(f.name) ?? 'Unnamed fire',
    state: str(f.state) ?? '',
    acres: num(f.acres),
    containment: num(f.containment),
    prescribed: false, // firetype only exists on the live index
    active: f.active !== false,
    createdOn: str(f.created_on),
    polyLastUpdated: str(f.poly_last_updated),
    hasForecast: f.has_spread_forecast === true,
    spreadLatestRun: str(f.spread_latest_run),
    hasIncidentMaps: f.has_incident_maps === true || maps > 0 || ir > 0,
    mapCount: maps,
    irCount: ir,
    latestUpload: str(f.incident_latest_upload),
    latestUploadTs: str(f.incident_latest_upload_ts),
    perimeterCount: num(f.perimeter_count),
    spreadRunCount: num(f.spread_run_count),
    coords: lonLat(f.coordinates),
  };
}

/** Row from a live-index entry alone (fires the catalog has not caught up to). */
function fromSummary(f: FireSummary): DirectoryRow {
  return {
    corneaId: f.cornea_id,
    fireSlug: str(f.unique_slug),
    name: str(f.post_title) ?? 'Unnamed fire',
    state: str(f.state) ?? '',
    acres: num(f.acres),
    containment: num(f.containment),
    prescribed: isPrescribed(f.firetype),
    active: f.active !== false,
    createdOn: str(f.created_on),
    polyLastUpdated: str(f.poly_last_updated),
    hasForecast: false,
    spreadLatestRun: null,
    hasIncidentMaps: false,
    mapCount: 0,
    irCount: 0,
    latestUpload: null,
    latestUploadTs: null,
    perimeterCount: null,
    spreadRunCount: null,
    coords: parseFireCoordinates(f.fire_coordinates),
  };
}

/** Newer of two ISO timestamps (either may be null/garbage). */
function newerIso(a: string | null, b: string | null): string | null {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : (a ?? b);
  if (!Number.isFinite(tb)) return a;
  return ta >= tb ? a : b;
}

/**
 * Merge catalog + live index by cornea_id. Catalog owns the worker-only facts
 * (forecast, FTP, slug); the live index wins on the volatile fire facts (acres,
 * containment) and can contribute fires the catalog has not seen yet.
 */
export function buildDirectoryRows(
  catalog: MasterCatalog | undefined,
  fires: FiresListResponse | undefined,
): DirectoryRow[] {
  const byId = new Map<string, DirectoryRow>();

  for (const f of catalog?.fires ?? []) {
    if (!f?.cornea_id) continue;
    byId.set(f.cornea_id, fromCatalog(f));
  }

  for (const f of fires?.fires ?? []) {
    if (!f?.cornea_id) continue;
    const base = byId.get(f.cornea_id);
    if (!base) {
      byId.set(f.cornea_id, fromSummary(f));
      continue;
    }
    const live = fromSummary(f);
    byId.set(f.cornea_id, {
      ...base,
      name: live.name || base.name,
      state: live.state || base.state,
      acres: live.acres ?? base.acres,
      containment: live.containment ?? base.containment,
      prescribed: live.prescribed,
      active: live.active,
      createdOn: base.createdOn ?? live.createdOn,
      polyLastUpdated: newerIso(base.polyLastUpdated, live.polyLastUpdated),
      fireSlug: base.fireSlug ?? live.fireSlug,
      coords: base.coords ?? live.coords,
    });
  }

  return [...byId.values()];
}

// ---------- perimeter freshness ----------

export type FreshnessBucket = 'fresh' | 'recent' | 'stale' | 'none';

const HOUR_MS = 3_600_000;

/**
 * Perimeter age buckets: under 12 h is fresh, under 48 h is recent, older is
 * stale, and missing/unparseable is none. Future stamps count as fresh.
 */
export function perimeterFreshness(
  iso: string | null | undefined,
  nowMs: number = Date.now(),
): FreshnessBucket {
  if (!iso) return 'none';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'none';
  const age = nowMs - t;
  if (age < 12 * HOUR_MS) return 'fresh';
  if (age < 48 * HOUR_MS) return 'recent';
  return 'stale';
}

// ---------- filtering ----------

export type DirectoryFilter = 'all' | 'forecast' | 'maps' | 'large' | 'uncontained';

export const DIRECTORY_FILTERS: { id: DirectoryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'forecast', label: 'Has forecast' },
  { id: 'maps', label: 'Has incident maps' },
  { id: 'large', label: '>1000 acres' },
  { id: 'uncontained', label: '<50% contained' },
];

export function matchesFilter(row: DirectoryRow, filter: DirectoryFilter): boolean {
  switch (filter) {
    case 'forecast':
      return row.hasForecast;
    case 'maps':
      return row.hasIncidentMaps;
    case 'large':
      return (row.acres ?? 0) > 1000;
    case 'uncontained':
      return (row.containment ?? 0) < 50;
    default:
      return true;
  }
}

/** Full state names, so "oregon" finds OR fires (abbrs already match). */
const STATE_NAMES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california',
  CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi',
  MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada',
  NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma',
  OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina',
  SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont',
  VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin',
  WY: 'wyoming', DC: 'district of columbia', PR: 'puerto rico',
};

/** Name/state substring match, case-insensitive; blank query matches all.
 * States match by abbreviation ("OR") or full name ("oregon"). */
export function matchesQuery(row: DirectoryRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.name.toLowerCase().includes(q)) return true;
  const abbr = row.state.toLowerCase();
  if (abbr === q) return true;
  // Full-name substring only for 3+ chars: "or" must match OR fires alone,
  // not colORado/califORnia.
  if (q.length < 3) return false;
  const full = STATE_NAMES[row.state.toUpperCase()];
  return full ? full.includes(q) : abbr.includes(q);
}

// ---------- proximity ("fires near Reno") ----------

export interface DirectoryNear {
  /** The (trimmed, lowercased) search text this place was resolved from —
   * the city fallback only shows while the box still says this. */
  query: string;
  label: string;
  coords: [number, number];
}

/** Radius for the "near <place>" directory mode. */
export const NEAR_RADIUS_MI = 200;

const EARTH_RADIUS_MI = 3958.8;

/** Great-circle distance in miles between two [lon, lat] points. */
export function distanceMiles(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------- sorting ----------

export type DirectorySortKey =
  | 'name'
  | 'state'
  | 'acres'
  | 'started'
  | 'perimeter'
  | 'forecast'
  | 'files'
  /** Only meaningful in near mode; applied automatically when a place is picked. */
  | 'distance';

export interface DirectorySort {
  key: DirectorySortKey;
  dir: 'asc' | 'desc';
}

/** Sort value: string for text columns, number for the rest; null sorts last. */
function sortValue(row: DirectoryRow, key: DirectorySortKey): string | number | null {
  switch (key) {
    case 'name':
      return row.name.toLowerCase();
    case 'state':
      return row.state.toLowerCase() || null;
    case 'acres':
      return row.acres;
    case 'started':
      return row.createdOn ? orNull(Date.parse(row.createdOn)) : null;
    case 'perimeter':
      return row.polyLastUpdated ? orNull(Date.parse(row.polyLastUpdated)) : null;
    case 'forecast':
      if (!row.hasForecast) return null;
      return row.spreadLatestRun ? (orNull(Date.parse(row.spreadLatestRun)) ?? 0) : 0;
    case 'distance':
      return row.distanceMi ?? null;
    case 'files': {
      // Sort by freshness like the other data columns. A fire with files
      // but an unknown upload time still ranks above one with none at all.
      if (!(row.mapCount + row.irCount)) return null;
      const ts = row.latestUploadTs ?? row.latestUpload;
      return ts ? (orNull(Date.parse(ts)) ?? 0) : 0;
    }
  }
}

function orNull(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

/**
 * Comparator for one column. Missing values always sink to the bottom (in both
 * directions); ties break on name so the order is stable across re-sorts.
 */
export function compareRows(a: DirectoryRow, b: DirectoryRow, sort: DirectorySort): number {
  const va = sortValue(a, sort.key);
  const vb = sortValue(b, sort.key);
  if (va == null && vb == null) return a.name.localeCompare(b.name);
  if (va == null) return 1;
  if (vb == null) return -1;
  let cmp: number;
  if (typeof va === 'string' || typeof vb === 'string') {
    cmp = String(va).localeCompare(String(vb));
  } else {
    cmp = va - vb;
  }
  if (cmp === 0) return a.name.localeCompare(b.name);
  return sort.dir === 'asc' ? cmp : -cmp;
}

/**
 * Near-mode pool: fires within NEAR_RADIUS_MI of the place, each cloned once
 * with its distance attached. Memoize the result on [rows, near] — the clones
 * mint new object identities, and DirectoryRow's memo lives on row identity,
 * so this must NOT re-run per keystroke. With no place, rows pass through
 * untouched (same objects).
 */
export function nearRows(rows: DirectoryRow[], near: DirectoryNear | null | undefined): DirectoryRow[] {
  if (!near) return rows;
  const pool: DirectoryRow[] = [];
  for (const r of rows) {
    if (!r.coords) continue;
    const d = distanceMiles(near.coords, r.coords);
    if (d <= NEAR_RADIUS_MI) pool.push({ ...r, distanceMi: d });
  }
  return pool;
}

/** Filter + search + sort in one pass (new array; input untouched). Near
 * mode: pass the rows through nearRows() first. */
export function selectDirectoryRows(
  rows: DirectoryRow[],
  opts: { query: string; filter: DirectoryFilter; sort: DirectorySort },
): DirectoryRow[] {
  return rows
    .filter((r) => matchesFilter(r, opts.filter) && matchesQuery(r, opts.query))
    .sort((a, b) => compareRows(a, b, opts.sort));
}

export interface DirectorySummary {
  total: number;
  active: number;
  withForecast: number;
  withIncidentMaps: number;
}

export function summarizeRows(rows: DirectoryRow[]): DirectorySummary {
  let active = 0;
  let withForecast = 0;
  let withIncidentMaps = 0;
  for (const r of rows) {
    if (r.active) active += 1;
    if (r.hasForecast) withForecast += 1;
    if (r.hasIncidentMaps) withIncidentMaps += 1;
  }
  return { total: rows.length, active, withForecast, withIncidentMaps };
}
