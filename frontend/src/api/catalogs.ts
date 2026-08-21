/** Fetchers for worker-produced catalogs on B2 (or /data in dev). */
import { DATA_BASE_URL } from '../app/config';
import type {
  HealthDoc,
  HotspotArchiveIndex,
  HotspotFeatureCollection,
  IncidentManifest,
  ImsrCatalog,
  MasterCatalog,
  PyrecastRunsCatalog,
  WeatherRunsCatalog,
} from './types';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${DATA_BASE_URL}${path}`);
  if (!res.ok) throw new Error(`catalog ${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

export const fetchMasterCatalog = () => getJson<MasterCatalog>('/catalogs/catalog.json');
export const fetchImsr = () => getJson<ImsrCatalog>('/catalogs/imsr.json');
export const fetchHealth = () => getJson<HealthDoc>('/catalogs/health.json');
export const fetchPyrecastRuns = () => getJson<PyrecastRunsCatalog>('/catalogs/pyrecast_runs.json');
export const fetchWeatherRuns = () => getJson<WeatherRunsCatalog>('/catalogs/weather_runs.json');

/** `manifestPath` comes from catalog.json (`incident_manifest`), root-relative. */
export const fetchIncidentManifest = (manifestPath: string) =>
  getJson<IncidentManifest>(manifestPath);

/**
 * Assemble a fire's full hotspot history from its worker archive: the index
 * lists the day chunks; closed days carry immutable cache headers so the
 * browser refetches only the current day's small chunk.
 */
export async function fetchHotspotArchive(
  indexPath: string,
): Promise<HotspotFeatureCollection> {
  const index = await getJson<HotspotArchiveIndex>(indexPath);
  const dir = indexPath.replace(/\/index\.json$/, '');
  const gen = index.gen ?? 1;
  // One missing chunk must not sink the whole history (an index can briefly
  // lead its chunks mid-upload) — skip it; the next revalidation heals.
  const days = await Promise.all(
    index.days.map((d) =>
      getJson<HotspotFeatureCollection>(`${dir}/g${gen}/${d}.json`).catch(() => {
        console.warn(`hotspot archive: missing day chunk ${d}`);
        return { type: 'FeatureCollection', features: [] } as HotspotFeatureCollection;
      }),
    ),
  );
  return {
    type: 'FeatureCollection',
    features: days.flatMap((fc) => fc.features ?? []),
  };
}

/** Resolve a root-relative data URL (tiles, PDFs, previews, vectors). */
export function dataUrl(rootRelative: string): string {
  return `${DATA_BASE_URL}${rootRelative}`;
}
