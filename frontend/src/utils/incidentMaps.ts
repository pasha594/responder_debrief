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
import type { IncidentMapEntry } from '../api/types';

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
}

/**
 * Group sheets by operational date, most recent first, undated last; each
 * group sorted by `compareEntries`. Input is never mutated.
 */
export function groupMapsByDate(maps: readonly IncidentMapEntry[]): MapDateGroup[] {
  const byDate = new Map<string, IncidentMapEntry[]>();
  const undated: IncidentMapEntry[] = [];
  for (const m of maps) {
    if (!m.op_date) {
      undated.push(m);
      continue;
    }
    const list = byDate.get(m.op_date);
    if (list) list.push(m);
    else byDate.set(m.op_date, [m]);
  }
  const groups: MapDateGroup[] = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([date, entries]) => ({ date, entries: [...entries].sort(compareEntries) }));
  if (undated.length) groups.push({ date: null, entries: [...undated].sort(compareEntries) });
  return groups;
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
