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

/** The exact national-index URL (also snapshot into offline packs). */
export function firesIndexUrl(): string {
  return `${FIRE_API}/fires?active=true&limit=500&fields=${INDEX_FIELDS}`;
}

export function fetchFires(): Promise<FiresListResponse> {
  return getJson<FiresListResponse>(firesIndexUrl());
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
function hotspotKey(f: HotspotFeatureCollection['features'][number]): string {
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties;
  return `${lon}|${lat}|${p.acq_date}|${p.acq_time}|${p.source}`;
}

/** One page of /hotspots. */
async function fetchHotspotPage(
  q: HotspotQuery,
  since: string | undefined,
  limit: number,
): Promise<HotspotFeatureCollection> {
  const params = new URLSearchParams({ bbox: bboxParam(q.bbox) });
  if (since) params.set('since', since);
  params.set('limit', String(limit));
  return getJson<HotspotFeatureCollection>(`${FIRE_API}/hotspots?${params}`);
}

/**
 * Full hotspot history for the box. The API caps a response at 50k features
 * and serves OLDEST first with no order/offset params — a long-lived fire
 * blows the cap and silently loses its NEWEST detections (observed: a
 * 35-day fire whose "current" hotspots ended two weeks early). When a page
 * comes back full, re-request from the newest day it reached and stitch,
 * deduping the boundary day.
 */
export async function fetchHotspots(q: HotspotQuery): Promise<HotspotFeatureCollection> {
  const limit = q.limit ?? HOTSPOT_LIMIT;
  const MAX_PAGES = 8; // 400k features — far beyond any real single-fire box
  const seen = new Set<string>();
  const features: HotspotFeatureCollection['features'] = [];
  let since = q.since;
  for (let page = 0; page < MAX_PAGES; page++) {
    const fc = await fetchHotspotPage(q, since, limit);
    let newest: string | null = null;
    for (const f of fc.features) {
      const key = hotspotKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      features.push(f);
      const d = f.properties.acq_date;
      if (d && (!newest || d > newest)) newest = d;
    }
    if (fc.features.length < limit) break; // no cap hit — history complete
    if (!newest || newest === since) break; // cannot advance (degenerate)
    since = newest;
  }
  normalizeHotspots(features);
  return { type: 'FeatureCollection', features };
}

/** Derived fields every hotspot consumer relies on (in-place). */
export function normalizeHotspots(
  features: HotspotFeatureCollection['features'],
): void {
  for (const f of features) {
    f.properties.acq_ts = hotspotAcqTs(f.properties.acq_date, f.properties.acq_time);
    f.properties.conf_norm = normalizeConfidence(f.properties.confidence);
  }
}
