/** Typed client for fire-api-prod.web.app (direct from browser; CORS `*`). */
import { FIRE_API, HOTSPOT_LIMIT } from '../app/config';
import type {
  FireDetail,
  FiresListResponse,
  HotspotFeatureCollection,
  PerimeterFeature,
  PerimeterIndexItem,
} from './types';
import { bboxParam, type LatFirstBbox } from './geo';
import { normalizeConfidence } from './confidence';
import { hotspotAcqTs } from './geo';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fire-api ${res.status} for ${url.slice(0, 120)}`);
  }
  return res.json() as Promise<T>;
}

/** Slim fields for the national index — one ~125 KB page covers all actives. */
const INDEX_FIELDS = [
  'cornea_id',
  'unique_slug',
  'post_title',
  'fire_coordinates',
  'acres',
  'containment',
  'state',
  'firetype',
  'created_on',
  'last_updated',
  'poly_last_updated',
  'active',
].join(',');

export function fetchFires(): Promise<FiresListResponse> {
  const url = `${FIRE_API}/fires?active=true&limit=500&fields=${INDEX_FIELDS}`;
  return getJson<FiresListResponse>(url);
}

export function fetchFire(corneaId: string): Promise<FireDetail> {
  return getJson<FireDetail>(`${FIRE_API}/fires/${encodeURIComponent(corneaId)}`);
}

export function fetchPerimeterIndex(corneaId: string): Promise<PerimeterIndexItem[]> {
  return getJson<PerimeterIndexItem[]>(
    `${FIRE_API}/fires/${encodeURIComponent(corneaId)}/perimeters`,
  );
}

/**
 * Fetch one perimeter version by the index item's `path`, VERBATIM.
 * CalFire fires' indexes mix IRWIN-keyed and UniqueId-keyed paths, so there is
 * deliberately no build-URL-from-fire-id helper — reconstruction 404s.
 */
export function fetchPerimeterByPath(path: string): Promise<PerimeterFeature> {
  return getJson<PerimeterFeature>(`${FIRE_API}${path}`);
}

export interface HotspotQuery {
  bbox: LatFirstBbox;
  since?: string; // YYYY-MM-DD
  limit?: number;
}

/** Fetch hotspots and stamp acq_ts + conf_norm onto each feature at ingest. */
export async function fetchHotspots(q: HotspotQuery): Promise<HotspotFeatureCollection> {
  const params = new URLSearchParams({ bbox: bboxParam(q.bbox) });
  if (q.since) params.set('since', q.since);
  params.set('limit', String(q.limit ?? HOTSPOT_LIMIT));
  const fc = await getJson<HotspotFeatureCollection>(`${FIRE_API}/hotspots?${params}`);
  for (const f of fc.features) {
    f.properties.acq_ts = hotspotAcqTs(f.properties.acq_date, f.properties.acq_time);
    f.properties.conf_norm = normalizeConfidence(f.properties.confidence);
  }
  return fc;
}
