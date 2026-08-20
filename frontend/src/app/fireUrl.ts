/**
 * Human-readable fire URLs. The fire API's `unique_slug` (e.g.
 * "2026-07-23-OR-BIG-GRASS") is unique, human-readable, and present in the
 * slim national index for every fire — so it is the public URL id, shown
 * lowercased: /fire/2026-07-23-or-big-grass. Legacy cornea-GUID links keep
 * resolving and are canonicalized to the slug form once the index loads.
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

/** URL id for a fire: lowercased unique_slug, or the cornea_id itself when
 * the fire isn't in the index (yet, or no longer active). */
export function urlIdForFire(corneaId: string): string {
  const f = fires?.find((x) => x.cornea_id === corneaId);
  return f?.unique_slug ? f.unique_slug.toLowerCase() : corneaId;
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
  return fires.find((x) => x.unique_slug?.toLowerCase() === want)?.cornea_id ?? null;
}

/** Test seam. */
export function resetFiresForTest(): void {
  fires = null;
}
