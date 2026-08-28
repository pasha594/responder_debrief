/**
 * Location search: Photon (komoot's OSM geocoder — free, keyless, built for
 * autocomplete) plus raw-coordinate parsing, because responders trade
 * "48.016, -120.846" strings constantly. Fair use: the UI debounces and
 * requires 3+ characters before querying.
 */

const PHOTON = 'https://photon.komoot.io/api/';

export interface PlaceHit {
  label: string;
  detail: string;
  coords: [number, number]; // lon, lat
  kind: string;
  /** Full state/region name when Photon has one (e.g. "Nevada"). */
  state?: string;
  /** ISO country code, uppercase (e.g. "US"). */
  countryCode?: string;
}

/** "48.016, -120.846" / "48.016 -120.846" / "-120.846,48.016" → [lon, lat].
 * Lat-first is assumed (the convention people speak); a pair that only makes
 * sense the other way around is flipped. */
export function parseCoordinateInput(q: string): [number, number] | null {
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)[\s,;]+(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(q);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const latLon = Math.abs(a) <= 90 && Math.abs(b) <= 180;
  const lonLat = Math.abs(a) <= 180 && Math.abs(b) <= 90;
  if (latLon && (!lonLat || Math.abs(a) <= 90)) return [b, a];
  if (lonLat) return [a, b];
  return null;
}

export async function searchPlaces(
  q: string,
  near?: [number, number] | null,
): Promise<PlaceHit[]> {
  const coords = parseCoordinateInput(q);
  if (coords) {
    return [{
      label: `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`,
      detail: 'Coordinates',
      coords,
      kind: 'coordinates',
    }];
  }
  const params = new URLSearchParams({ q, limit: '6', lang: 'en' });
  if (near) {
    params.set('lon', String(near[0]));
    params.set('lat', String(near[1]));
  }
  const res = await fetch(`${PHOTON}?${params}`);
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  const data = (await res.json()) as {
    features?: {
      geometry: { coordinates: [number, number] };
      properties: Record<string, string | undefined>;
    }[];
  };
  return (data.features ?? []).map((f) => {
    const p = f.properties;
    const detail = [p.city ?? p.county, p.state, p.country === 'United States' ? null : p.country]
      .filter(Boolean)
      .join(', ');
    return {
      label: p.name ?? p.street ?? 'Unnamed place',
      detail: [p.osm_value, detail].filter(Boolean).join(' · '),
      coords: f.geometry.coordinates,
      kind: p.osm_value ?? 'place',
      state: p.state,
      countryCode: p.countrycode?.toUpperCase(),
    };
  });
}

/** Populated-place kinds, biggest-first. */
const CITY_RANK: Record<string, number> = { city: 0, town: 1, village: 2, hamlet: 3 };

/**
 * "Fires near Reno" wants THE Reno: the biggest US populated place with that
 * name. Photon orders results by importance, so filtering to US city-kinds
 * and stable-sorting by kind rank makes the first survivor the biggest city
 * (Reno NV beats Reno TX villages and Reno County KS). Raw coordinates pass
 * straight through. Null when nothing city-like matches in the US.
 */
export function pickBestCity(hits: PlaceHit[]): PlaceHit | null {
  const coords = hits.find((h) => h.kind === 'coordinates');
  if (coords) return coords;
  const cities = hits.filter((h) => h.countryCode === 'US' && h.kind in CITY_RANK);
  if (cities.length === 0) return null;
  return [...cities].sort((a, b) => CITY_RANK[a.kind] - CITY_RANK[b.kind])[0];
}
