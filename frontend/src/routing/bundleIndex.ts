/**
 * Where a fire's routing bundle lives, fetched through the main-thread
 * window.fetch so the offline pack wrapper serves it without signal (a Web
 * Worker's own fetch would bypass the pack). Plan URLs (offline/packModel)
 * and runtime URLs come from these same resolvers, so the wrapper's exact-URL
 * match holds.
 */
import { dataUrl } from '../api/catalogs';
import { lonLatToUtm } from '../spread/utm';
import {
  SUPPORTED_RECIPE,
  type RoutingBundle,
  type RoutingIndex,
  type RoutingIndexEntry,
  type TrailsPointer,
} from './types';

export const routingIndexUrl = (): string => dataUrl('/catalogs/routing.json');
export const trailsPointerUrl = (): string => dataUrl('/catalogs/trails.json');

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Small TTL memo so a burst of callers (layers, Walk, the pack card)
 * shares one request; failures are not cached. */
function memo<T>(ttlMs: number, load: () => Promise<T | null>): () => Promise<T | null> {
  let at = 0;
  let p: Promise<T | null> | null = null;
  return () => {
    if (!p || Date.now() - at > ttlMs) {
      at = Date.now();
      p = load().then((v) => {
        if (v == null) p = null;
        return v;
      });
    }
    return p;
  };
}

export const getRoutingIndex = memo(60_000, () => getJson<RoutingIndex>(routingIndexUrl()));
export const getTrailsPointer = memo(30 * 60_000, () => getJson<TrailsPointer>(trailsPointerUrl()));

const bundles = new Map<string, Promise<RoutingBundle | null>>();

/** Descriptor for one index entry (immutable URL, cached for the session). */
export function getBundle(entry: RoutingIndexEntry): Promise<RoutingBundle | null> {
  const url = dataUrl(entry.descriptor);
  let p = bundles.get(url);
  if (!p) {
    p = getJson<RoutingBundle>(url).then((b) => {
      if (!b) bundles.delete(url);
      return b;
    });
    bundles.set(url, p);
  }
  return p;
}

export type EntryState =
  | { kind: 'ok'; entry: RoutingIndexEntry }
  | { kind: 'none' }
  | { kind: 'app_update' }
  | { kind: 'unknown' };

/** This fire's index entry, or why there is none. */
export async function getRoutingEntry(corneaId: string): Promise<EntryState> {
  const idx = await getRoutingIndex();
  if (!idx) return { kind: 'unknown' };
  if ((idx.recipe ?? 1) > SUPPORTED_RECIPE) return { kind: 'app_update' };
  const entry = idx.fires?.[corneaId];
  return entry ? { kind: 'ok', entry } : { kind: 'none' };
}

/** Grid cell coordinates (fractional col, row) of a lon/lat point. */
export function toGrid(b: RoutingBundle, lon: number, lat: number): [number, number] {
  const [e, n] = lonLatToUtm(lon, lat, b.crs.zone, b.crs.northern);
  return [(e - b.grid.x0) / b.grid.cell_m, (b.grid.y0 - n) / b.grid.cell_m];
}

/** True when the point is inside the bundle's grid (1-cell margin). */
export function insideRoutingArea(b: RoutingBundle, lonLat: [number, number]): boolean {
  const [c, r] = toGrid(b, lonLat[0], lonLat[1]);
  return c >= 1 && r >= 1 && c < b.grid.width - 1 && r < b.grid.height - 1;
}

/** Drop the session caches (tests; a pack update). */
export function resetBundleCaches(): void {
  bundles.clear();
}
