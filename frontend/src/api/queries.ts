/** TanStack Query hooks — the only gateway to server data. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchFire,
  fetchFires,
  fetchHotspots,
  fetchPerimeterByPath,
  fetchPerimeterIndex,
  type HotspotQuery,
} from './fireApi';
import {
  fetchIncidentManifest,
  fetchMasterCatalog,
  fetchPyrecastRuns,
  fetchWeatherRuns,
} from './catalogs';
import type { PyrecastRun, WeatherRun } from './types';

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

/** Callers must pass a grid-snapped bbox (see snapBoundsOut) for cache reuse. */
export const useHotspots = (q: HotspotQuery | null) =>
  useQuery({
    queryKey: ['hotspots', q?.bbox, q?.since, q?.limit],
    queryFn: () => fetchHotspots(q!),
    enabled: !!q,
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
  return entry.runs[0];
}

/** Newest weather run for a model, or null. */
export function latestWeatherRun(
  weather: { models: Record<string, { runs: WeatherRun[] }> } | undefined,
  model = 'hrrr',
): WeatherRun | null {
  const runs = weather?.models?.[model]?.runs;
  return runs?.length ? runs[0] : null;
}
