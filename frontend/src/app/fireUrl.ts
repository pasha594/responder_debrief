/**
 * Human-readable fire URLs. The fire API's `unique_slug` (e.g.
 * "2026-07-23-OR-BIG-GRASS") is unique, human-readable, and present in the
 * slim national index for every fire. The public URL id reorders it
 * name-first per user preference: /fire/big-grass-or-2026-07-23. GUID
 * links still resolve (canonicalized to the readable form on load).
 * (The NIFC unique_fire_id would be nicer still, but the API returns null
 * for many fires and omits it from the index — the slug is the reliable
 * readable id.)
 *
 * The store keys everything by cornea_id; only URLs speak slug. Resolution
 * needs the fires index, which arrives async — PathSync feeds it in via
 * registerFires() and the helpers answer synchronously from the registry.
 */
import type { FireSummary } from '../api/types';

const GUID_RE =
  /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

/** cornea_id shapes: braced IRWIN GUID (NIFC) or bare UUID (CalFire). */
export function isCorneaId(id: string): boolean {
  return GUID_RE.test(id);
}

let fires: FireSummary[] | null = null;

export function registerFires(list: FireSummary[] | undefined | null): void {
  if (list) fires = list;
}

export function firesLoaded(): boolean {
  return fires !== null;
}

/** unique_slug "2026-07-23-OR-BIG-GRASS" -> url id "big-grass-or-2026-07-23"
 * (name first — nicer to read and share). Unparseable slugs pass through
 * lowercased. */
export function slugToUrlId(uniqueSlug: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})-([A-Za-z]{2})-(.+)$/.exec(uniqueSlug);
  const out = m ? `${m[3]}-${m[2]}-${m[1]}` : uniqueSlug;
  return out.toLowerCase();
}

/** URL id for a fire, or the cornea_id itself when the fire isn't in the
 * index (yet, or no longer active). */
export function urlIdForFire(corneaId: string): string {
  const f = fires?.find((x) => x.cornea_id === corneaId);
  return f?.unique_slug ? slugToUrlId(f.unique_slug) : corneaId;
}

/**
 * cornea_id for a URL id. GUIDs pass through untouched; slugs resolve
 * case-insensitively against the index. Returns null while the index hasn't
 * loaded (caller should wait) AND for a slug the loaded index doesn't
 * contain (caller distinguishes via firesLoaded()).
 */
export function corneaIdForUrlId(urlId: string): string | null {
  if (isCorneaId(urlId)) return urlId;
  if (!fires) return null;
  const want = urlId.toLowerCase();
  return (
    fires.find((x) => x.unique_slug && slugToUrlId(x.unique_slug) === want)?.cornea_id ?? null
  );
}

/** Test seam. */
export function resetFiresForTest(): void {
  fires = null;
}
