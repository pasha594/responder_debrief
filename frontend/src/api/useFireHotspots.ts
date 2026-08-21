/**
 * The ONE place the fire-mode hotspot query is built. Both the map layer sync
 * and the timeline's activity throughline call this; because the derived
 * HotspotQuery is byte-identical in both, TanStack collapses them onto a
 * single cache entry — one network fetch, not two.
 *
 * Server data stays in TanStack Query (never mirrored into zustand).
 */
import { useMemo } from 'react';
import {
  latestRun,
  useFire,
  useHotspotArchive,
  useHotspots,
  useMasterCatalog,
  usePyrecastRuns,
} from './queries';
import type { HotspotQuery } from './fireApi';
import { HOTSPOT_BBOX_SNAP_DEG, HOTSPOT_HISTORY_MAX_DAYS } from '../app/config';
import { boundsToLatFirst, padBounds, snapBoundsOut, type Bounds4326 } from './geo';

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

/**
 * Fixed bbox around the incident, since discovery (capped at
 * HOTSPOT_HISTORY_MAX_DAYS). Grid-snapped so the key is cache-friendly.
 * Returns null until enough of the fire is known to place a box.
 */
export function useFireHotspotQuery(corneaId: string | null): HotspotQuery | null {
  const { data: fire } = useFire(corneaId);
  const { data: catalog } = useMasterCatalog();
  const { data: pyrecastRuns } = usePyrecastRuns();

  const catalogFire = useMemo(
    () => catalog?.fires.find((f) => f.cornea_id === corneaId) ?? null,
    [catalog, corneaId],
  );
  const slug = catalogFire?.fire_slug ?? fire?.unique_slug ?? null;
  const spreadRun = useMemo(() => latestRun(pyrecastRuns, slug), [pyrecastRuns, slug]);

  return useMemo(() => {
    if (!corneaId) return null;
    // run.bbox is back-filled client-side after the first tif decode (v2
    // catalogs omit it). The model domain can be SMALLER than the fire
    // itself, so never let it clip the box: union it with a generous
    // centroid-padded rectangle.
    const center = spreadRun?.centroid ?? catalogFire?.coordinates ?? null;
    const centerBox: Bounds4326 | null = center
      ? [center[0] - 0.5, center[1] - 0.4, center[0] + 0.5, center[1] + 0.4]
      : null;
    const run = spreadRun?.bbox ?? null;
    const base: Bounds4326 | null =
      run && centerBox
        ? [
            Math.min(run[0], centerBox[0]),
            Math.min(run[1], centerBox[1]),
            Math.max(run[2], centerBox[2]),
            Math.max(run[3], centerBox[3]),
          ]
        : (run ?? centerBox);
    if (!base) return null;
    const created = fire ? Date.parse(fire.created_on) : NaN;
    const sinceDays = Number.isFinite(created)
      ? Math.min(HOTSPOT_HISTORY_MAX_DAYS, Math.ceil((Date.now() - created) / 864e5))
      : 7;
    return {
      bbox: boundsToLatFirst(snapBoundsOut(padBounds(base, 0.2), HOTSPOT_BBOX_SNAP_DEG)),
      since: daysAgoIso(sinceDays),
    };
  }, [corneaId, spreadRun, catalogFire, fire]);
}

/**
 * The fire's hotspot FeatureCollection (shared cache entry). Prefers the
 * worker's per-fire archive on B2 — increments only, closed-day chunks
 * cached immutably — and falls back to paging the fire API directly for
 * fires the worker hasn't archived yet.
 */
export function useFireHotspots(corneaId: string | null) {
  const { data: catalog, isError: catalogFailed } = useMasterCatalog();
  const archivePath =
    catalog?.fires.find((f) => f.cornea_id === corneaId)?.hotspot_archive ?? null;
  const q = useFireHotspotQuery(corneaId);
  const archived = useHotspotArchive(archivePath);
  // Direct API path only when the archive can't serve: no archive advertised
  // (wait for the catalog to settle first — the direct pull is tens of MB,
  // don't fire it just because the catalog is still loading), or the archive
  // fetch itself failed.
  const catalogSettled = !!catalog || catalogFailed;
  const useDirect = catalogSettled && (!archivePath || archived.isError);
  const direct = useHotspots(useDirect ? q : null);
  return archivePath && !archived.isError ? archived : direct;
}
