/**
 * Incident-map sheet ordering and per-row affordances.
 *
 * Responders read a map wall by OPERATIONAL PERIOD first ("what is today?"),
 * so the tab groups by `op_date` newest-first and only sorts by product type
 * inside a date. The old grouping (one section per product type) scattered a
 * single day's packet across the whole tab.
 *
 * Pure module — no React, no DOM. The tab component and the tests both use it.
 */
import type { IncidentMapEntry, IrFlight } from '../api/types';
import { formatDateTime } from './format';

/**
 * Operational priority for the product bases the worker emits
 * (worker config.PRODUCT_LABELS). Lower sorts first. Suppression-repair's
 * three spellings share a rank; `qr` and `mobile` are kinds, not products,
 * and always trail the real map products.
 */
const PRODUCT_RANK: Record<string, number> = {
  ops: 0,
  iap: 1,
  brief: 2,
  airops: 3,
  evac: 4,
  trans: 5,
  pio: 6,
  suprep: 7,
  suppression_repair: 7,
  repair: 7,
  owner: 8,
  other: 9,
};

export const QR_RANK = 10;
export const MOBILE_RANK = 11;

/** Known bases, longest first so "suppression_repair" wins over "repair". */
const PRODUCT_BASES = Object.keys(PRODUCT_RANK).sort((a, b) => b.length - a.length);

/**
 * The manifest's `product` carries the worker's variant suffix
 * ("ops_arche", "repair_arche"); the operational meaning is the base prefix.
 * Unknown products fall back to "other".
 */
export function productBase(product: string | null | undefined): string {
  const p = (product ?? '').toLowerCase();
  for (const base of PRODUCT_BASES) {
    if (p === base || p.startsWith(base + '_')) return base;
  }
  return 'other';
}

/** Sort rank inside a date group: product priority, then qr, then mobile. */
export function entryRank(entry: IncidentMapEntry): number {
  if (entry.kind === 'mobile') return MOBILE_RANK;
  if (entry.kind === 'qr') return QR_RANK;
  return PRODUCT_RANK[productBase(entry.product)] ?? PRODUCT_RANK.other;
}

/** Day before night; an unlabelled period trails both (order still stable). */
function periodRank(period: IncidentMapEntry['period']): number {
  if (period === 'day') return 0;
  if (period === 'night') return 1;
  return 2;
}

/** Within a date group: product priority → day before night → filename. */
export function compareEntries(a: IncidentMapEntry, b: IncidentMapEntry): number {
  const r = entryRank(a) - entryRank(b);
  if (r !== 0) return r;
  const p = periodRank(a.period) - periodRank(b.period);
  if (p !== 0) return p;
  return a.filename.localeCompare(b.filename);
}

export interface MapDateGroup {
  /** YYYY-MM-DD, or null for the trailing "Undated" group. */
  date: string | null;
  entries: IncidentMapEntry[];
  /**
   * IR flights filed under this day by their FTP folder's date: the
   * operational period the imagery serves (it is usually flown the evening
   * before). Newest flight first.
   */
  irFlights: IrFlight[];
}

/**
 * Group sheets by operational date, most recent first, undated last; each
 * group sorted by `compareEntries`. IR flights join the day their folder
 * names. Input is never mutated.
 */
export function groupMapsByDate(
  maps: readonly IncidentMapEntry[],
  irFlights: readonly IrFlight[] = [],
): MapDateGroup[] {
  const byDate = new Map<string | null, MapDateGroup>();
  const groupFor = (date: string | null) => {
    let g = byDate.get(date);
    if (!g) byDate.set(date, (g = { date, entries: [], irFlights: [] }));
    return g;
  };
  for (const m of maps) groupFor(m.op_date || null).entries.push(m);
  for (const f of irFlights) groupFor(f.flight_date || null).irFlights.push(f);
  const groups = [...byDate.values()];
  for (const g of groups) {
    g.entries.sort(compareEntries);
    g.irFlights.sort((a, b) => (b.flown_at ?? '').localeCompare(a.flown_at ?? ''));
  }
  // newest first; undated last
  return groups.sort((a, b) =>
    a.date === b.date ? 0 : a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? 1 : -1,
  );
}

// ---------------------------------------------------------------------------
// Friendly date headings
// ---------------------------------------------------------------------------

/** Shift a YYYY-MM-DD by whole days, staying on the calendar (UTC math). */
export function shiftIsoDate(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return date;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Today's calendar date in the FIRE's timezone (not the viewer's) — an
 * incident on the far side of the country flips to "Today" on its own clock.
 * Falls back to the viewer's zone when the IANA name is missing/invalid.
 */
export function localToday(timezone: string | null | undefined, nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone ?? undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  }
}

export interface DateHeading {
  /** "Today" / "Yesterday" / "Aug 15" / "Undated". */
  primary: string;
  /** "Mon, Aug 17" (weekday + date), or null when there is no date. */
  secondary: string | null;
}

/**
 * A date-only string has no zone, so it is formatted as the calendar day it
 * literally names (parsed and rendered in UTC) — never shifted into the
 * viewer's zone, which would slide "Aug 17" back to "Aug 16" west of GMT.
 */
export function friendlyOpDate(opDate: string | null, todayLocal: string): DateHeading {
  if (!opDate) return { primary: 'Undated', secondary: null };
  const t = Date.parse(`${opDate}T00:00:00Z`);
  if (!Number.isFinite(t)) return { primary: opDate, secondary: null };
  const d = new Date(t);
  const sameYear = opDate.slice(0, 4) === todayLocal.slice(0, 4);
  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(d);
  const monthDay = fmt({ month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
  const secondary = fmt({
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
  let primary = monthDay;
  if (opDate === todayLocal) primary = 'Today';
  else if (opDate === shiftIsoDate(todayLocal, -1)) primary = 'Yesterday';
  return { primary, secondary };
}

/**
 * When an IR flight flew, for its row: the KMZ's flight time in the fire's
 * zone ("Sep 23, 7:25 PM PDT"), else the KMZ's bare date, else the FTP
 * folder's date. Folders are named for the day the imagery serves, so they
 * often read a day later than an evening flight.
 */
export function irFlightWhen(
  flight: Pick<IrFlight, 'flown_at' | 'flown_date' | 'flight_date'>,
  timezone: string | null | undefined,
): { label: string; source: 'kmz' | 'kmz-date' | 'folder' | null } {
  if (flight.flown_at && Number.isFinite(Date.parse(flight.flown_at))) {
    return { label: formatDateTime(flight.flown_at, timezone), source: 'kmz' };
  }
  const calendarDay = (date: string) => {
    const t = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(t)
      ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(t)
      : null;
  };
  const kmzDay = flight.flown_date ? calendarDay(flight.flown_date) : null;
  if (kmzDay) return { label: kmzDay, source: 'kmz-date' };
  const folderDay = flight.flight_date ? calendarDay(flight.flight_date) : null;
  if (folderDay) return { label: folderDay, source: 'folder' };
  return { label: 'Undated', source: null };
}

// ---------------------------------------------------------------------------
// Row affordance
// ---------------------------------------------------------------------------

/**
 * What a row offers, decided by GEOREFERENCING — not by tiling state.
 * The worker now stamps `georeferenced` on every sheet even while tiling is
 * deferred, so a flat sheet can say so immediately instead of sitting on an
 * indefinite "processing…".
 *
 * - `download`      Avenza mobile package: a file to take into the field.
 * - `overlay`       georeferenced with tiles: drape it on the map.
 * - `overlay-soon`  georeferenced, tiles still rendering: disabled toggle.
 * - `view`          not georeferenced: lightbox preview + PDF, no overlay.
 */
export type RowAction = 'download' | 'overlay' | 'overlay-soon' | 'view';

export function rowAction(entry: IncidentMapEntry): RowAction {
  if (entry.kind === 'mobile') return 'download';
  if (entry.georeferenced && entry.tiles) return 'overlay';
  if (entry.georeferenced) return 'overlay-soon';
  return 'view';
}


// ---------- map version series (the "Timeline" button) ----------

/**
 * Series identity: every sheet with the same product/sheet/orientation is a
 * version of "the same map" published on different operational periods.
 */
export function seriesKey(entry: IncidentMapEntry): string {
  return `${entry.product}|${entry.sheet ?? ''}|${entry.orientation ?? ''}`;
}

/**
 * The instant a version belongs to on the timeline: upload time when known,
 * else the filename's generation stamp (fire-local wall time parsed as UTC —
 * hours off at worst, fine for ordering versions a day apart), else the
 * op date at UTC noon.
 */
export function mapVersionTime(entry: IncidentMapEntry): number | null {
  if (entry.uploaded_at) {
    const t = Date.parse(entry.uploaded_at);
    if (Number.isFinite(t)) return t;
  }
  if (entry.generated_at_local) {
    const t = Date.parse(entry.generated_at_local + ':00Z');
    if (Number.isFinite(t)) return t;
  }
  if (entry.op_date) {
    const t = Date.parse(entry.op_date + 'T12:00:00Z');
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** Overlayable versions of a series, oldest first. */
export function seriesVersions(
  maps: IncidentMapEntry[],
  key: string,
): { entry: IncidentMapEntry; ts: number }[] {
  return maps
    .filter((m) => m.tiles && seriesKey(m) === key)
    .map((entry) => ({ entry, ts: mapVersionTime(entry) ?? 0 }))
    .filter((v) => v.ts > 0)
    .sort((a, b) => a.ts - b.ts);
}

/**
 * The version the scrub time selects: newest published at-or-before t,
 * else the earliest (scrubbing before the first version still shows one).
 */
export function resolveSeriesVersion(
  versions: { entry: IncidentMapEntry; ts: number }[],
  t: number,
): IncidentMapEntry | null {
  if (!versions.length) return null;
  let pick = versions[0];
  for (const v of versions) {
    if (v.ts <= t) pick = v;
    else break;
  }
  return pick.entry;
}
