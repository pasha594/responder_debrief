/** Fetchers for worker-produced catalogs on B2 (or /data in dev). */
import { DATA_BASE_URL } from '../app/config';
import type {
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
export const fetchPyrecastRuns = () => getJson<PyrecastRunsCatalog>('/catalogs/pyrecast_runs.json');
export const fetchWeatherRuns = () => getJson<WeatherRunsCatalog>('/catalogs/weather_runs.json');

/** `manifestPath` comes from catalog.json (`incident_manifest`), root-relative. */
export const fetchIncidentManifest = (manifestPath: string) =>
  getJson<IncidentManifest>(manifestPath);

/** Resolve a root-relative data URL (tiles, PDFs, previews, vectors). */
export function dataUrl(rootRelative: string): string {
  return `${DATA_BASE_URL}${rootRelative}`;
}
