/**
 * A fire's identity is its cornea_id, compared only through fireKey: the API
 * writes the same id braced or bare, upper or lower case. Some worker files
 * (pyrecast_runs.json, imsr.json) are keyed by fire_slug, which is just the
 * name: unrelated fires share it over time, and two active fires with one
 * name swap it between syncs. Look their entries up by cornea_id.
 * Mirrors worker/responder_worker/fires.py fire_key.
 */
export function fireKey(id: string | null | undefined): string | null {
  const k = (id ?? '').toLowerCase().replace(/[^0-9a-z-]/g, '').slice(0, 64);
  return k || null;
}

export function sameFire(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = fireKey(a);
  return ka !== null && ka === fireKey(b);
}

/**
 * A per-fire entry of a slug-keyed worker file, found by fire ID. A file
 * written before entries carried cornea_id falls back to the slug.
 */
export function entryForFire<T extends { cornea_id?: string | null }>(
  fires: Record<string, T> | null | undefined,
  corneaId: string | null | undefined,
  legacySlug: string | null | undefined,
): T | undefined {
  if (!fires) return undefined;
  const entries = Object.values(fires);
  if (entries.some((e) => e?.cornea_id)) {
    return entries.find((e) => sameFire(e?.cornea_id, corneaId));
  }
  return legacySlug ? fires[legacySlug] : undefined;
}
