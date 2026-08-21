/** TanStack Query hooks — the only gateway to server data. */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchFire,
  fetchFires,
  fetchHotspots,
  normalizeHotspots,
  fetchPerimeterByPath,
  fetchPerimeterIndex,
  type HotspotQuery,
} from './fireApi';
import {
  fetchHealth,
  fetchHotspotArchive,
  fetchImsr,
  fetchIncidentManifest,
  fetchMasterCatalog,
  fetchPyrecastRuns,
  fetchWeatherRuns,
} from './catalogs';
import type { PerimeterIndexItem, PyrecastRun, WeatherRun } from './types';
import { fetchHistoricPerimeters } from './nifcHistory';

export const useFires = () =>
  useQuery({
    queryKey: ['fires'],
    queryFn: fetchFires,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

export const useFire = (corneaId: string | null) =>
  useQuery({
    queryKey: ['fire', corneaId],
    queryFn: () => fetchFire(corneaId!),
    enabled: !!corneaId,
    staleTime: 300_000,
  });

export const usePerimeterIndex = (corneaId: string | null) =>
  useQuery({
    queryKey: ['perimeter-index', corneaId],
    queryFn: () => fetchPerimeterIndex(corneaId!),
    enabled: !!corneaId,
    staleTime: 300_000,
  });

/** Versions are server-marked immutable — cache forever. */
export const usePerimeterVersion = (path: string | null) =>
  useQuery({
    queryKey: ['perimeter-version', path],
    queryFn: () => fetchPerimeterByPath(path!),
    enabled: !!path,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });

/**
 * Warm the cache for the perimeter versions NEIGHBORING the one on screen,
 * so scrubbing across a version boundary swaps instantly instead of
 * stalling on a 1-2 MB fetch. Versions are server-marked immutable
 * (staleTime Infinity), so prefetching is free after the first pass.
 */
export function usePrefetchPerimeterNeighbors(
  index: PerimeterIndexItem[] | undefined,
  currentPath: string | null,
  reach = 2,
) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!index || !currentPath) return;
    const i = index.findIndex((v) => v.path === currentPath);
    if (i < 0) return;
    for (let d = 1; d <= reach; d++) {
      for (const j of [i - d, i + d]) {
        const item = index[j];
        if (!item) continue;
        void qc.prefetchQuery({
          queryKey: ['perimeter-version', item.path],
          queryFn: () => fetchPerimeterByPath(item.path),
          staleTime: Infinity,
        });
      }
    }
  }, [qc, index, currentPath, reach]);
}

/** Callers must pass a grid-snapped bbox (see snapBoundsOut) for cache reuse. */
export const useHotspots = (q: HotspotQuery | null) =>
  useQuery({
    queryKey: ['hotspots', q?.bbox, q?.since, q?.limit],
    queryFn: () => fetchHotspots(q!),
    enabled: !!q,
    staleTime: 300_000,
    placeholderData: (prev) => prev,
  });

/** NIFC historic perimeters near a fire — lazy (enabled only when the
 * layer is on) and cached forever (history is immutable). */
export const useHistoricPerimeters = (
  bbox: [number, number, number, number] | null,
  excludeCorneaId: string | null,
  enabled: boolean,
) =>
  useQuery({
    queryKey: ['nifc-history', bbox, excludeCorneaId],
    queryFn: () => fetchHistoricPerimeters(bbox!, excludeCorneaId),
    enabled: enabled && !!bbox,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });

/** Worker-archived hotspot history (daily chunks; index revalidates). */
export const useHotspotArchive = (indexPath: string | null) =>
  useQuery({
    queryKey: ['hotspot-archive', indexPath],
    queryFn: async () => {
      const fc = await fetchHotspotArchive(indexPath!);
      normalizeHotspots(fc.features);
      return fc;
    },
    enabled: !!indexPath,
    staleTime: 300_000,
    placeholderData: (prev) => prev,
  });

export const useMasterCatalog = () =>
  useQuery({
    queryKey: ['catalog'],
    queryFn: fetchMasterCatalog,
    staleTime: 300_000,
    retry: 1,
  });

/** Ingestion heartbeat (may 404 until the first post-deploy worker run). */
export const useHealth = () =>
  useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    staleTime: 60_000,
    retry: 1,
  });

/** Daily NIFC sit-report resources (may 404 until first published). */
export const useImsr = () =>
  useQuery({
    queryKey: ['imsr'],
    queryFn: fetchImsr,
    staleTime: 30 * 60_000,
    retry: 1,
  });

export const usePyrecastRuns = () =>
  useQuery({
    queryKey: ['pyrecast-runs'],
    queryFn: fetchPyrecastRuns,
    staleTime: 300_000,
    retry: 1,
  });

export const useWeatherRuns = () =>
  useQuery({
    queryKey: ['weather-runs'],
    queryFn: fetchWeatherRuns,
    staleTime: 300_000,
    retry: 1,
  });

export const useIncidentManifest = (manifestPath: string | null) =>
  useQuery({
    queryKey: ['incident-manifest', manifestPath],
    queryFn: () => fetchIncidentManifest(manifestPath!),
    enabled: !!manifestPath,
    staleTime: 300_000,
    retry: 1,
  });

/**
 * Run-rotation detector: call on any WMS frame 404/502 — pyrecast workspaces
 * are ephemeral snapshots and vanish within days.
 */
export function useInvalidateForecasts() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['pyrecast-runs'] });
    void qc.invalidateQueries({ queryKey: ['weather-runs'] });
    void qc.invalidateQueries({ queryKey: ['catalog'] });
  };
}

// ---------- Derived helpers (pure) ----------

/** Latest spread run for a fire slug, or null. */
export function latestRun(
  runsCatalog: { fires: Record<string, { runs: PyrecastRun[] }> } | undefined,
  fireSlug: string | null | undefined,
): PyrecastRun | null {
  if (!runsCatalog || !fireSlug) return null;
  const entry = runsCatalog.fires[fireSlug];
  if (!entry?.runs?.length) return null;
  // Only schema-v2 (archive) runs are renderable: they carry `toa`. A stale
  // v1 catalog (CDN-cached during a deploy overlap) must degrade to the
  // "no spread forecast" empty state, never crash the tab.
  const run = entry.runs[0];
  return run && run.toa && Array.isArray(run.toa.percentiles) ? run : null;
}

/** Newest weather run for a model, or null. */
/** A run the map can actually draw: rendered frames, or a legacy manifest. */
export function isRenderableWeatherRun(run: WeatherRun): boolean {
  return !run.frames || (run.frames.hours?.length ?? 0) > 0;
}

export function latestWeatherRun(
  weather: { models: Record<string, { runs: WeatherRun[] }> } | undefined,
  model = 'hrrr',
): WeatherRun | null {
  const runs = weather?.models?.[model]?.runs ?? [];
  // A GDAL-skipped sync can publish a NEWER run with zero rendered frames —
  // selecting it would blank every weather layer. Prefer the newest drawable.
  return runs.find(isRenderableWeatherRun) ?? runs[0] ?? null;
}
