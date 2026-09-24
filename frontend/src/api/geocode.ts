/**
 * Location search: Photon (komoot's OSM geocoder — free, keyless, built for
 * autocomplete) plus raw-coordinate parsing, because responders trade
 * "48.016, -120.846" strings constantly. Fair use: the UI debounces and
 * requires 3+ characters before querying.
 *
 * The reverse direction (the street address under a dropped pin) goes to
 * Nominatim instead: Photon only knows house numbers mapped in OSM itself,
 * while Nominatim also carries the US Census TIGER address ranges — which is
 * most rural addresses (Photon finds nothing at 1091 Central Park Dr,
 * Paradise; Nominatim does).
 */
import { distanceMiles } from './geo';

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
/** Nominatim's usage policy: at most one request per second per client. */
const NOMINATIM_GAP_MS = 1000;
/** A house number farther than this from the pin belongs to another spot. */
const ADDRESS_MAX_M = 150;
const METERS_PER_MILE = 1609.344;

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

/** A street address, split the way an envelope (or Google's card) reads. */
export interface StreetAddress {
  /** "1091 Central Park Drive" */
  line1: string;
  /** "Paradise, CA 95969" — whichever of the parts exist */
  line2: string;
}

interface NominatimReverse {
  lat?: string;
  lon?: string;
  address?: Record<string, string | undefined>;
}

/**
 * The street address (house number + road) AT `at`, or null. Null is the
 * usual answer on a fire: out in wildland Nominatim's nearest object is a
 * road, a creek, or just the county.
 */
export function streetAddressFrom(
  res: NominatimReverse,
  at: [number, number],
): StreetAddress | null {
  const a = res.address;
  if (!a?.house_number || !a.road) return null;
  const hit: [number, number] = [Number(res.lon), Number(res.lat)];
  if (!hit.every(Number.isFinite)) return null;
  if (distanceMiles(at, hit) * METERS_PER_MILE > ADDRESS_MAX_M) return null;
  const locality = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.county;
  // US addresses read with the postal abbreviation: "US-CA" → "CA".
  const iso = a['ISO3166-2-lvl4'];
  const region = a.country_code === 'us' && iso?.startsWith('US-') ? iso.slice(3) : a.state;
  const regionZip = [region, a.postcode].filter(Boolean).join(' ');
  return {
    line1: `${a.house_number} ${a.road}`,
    line2: [locality, regionZip].filter(Boolean).join(', '),
  };
}

let nominatimNextSlot = 0;

/** Wait for this client's next Nominatim slot (NOMINATIM_GAP_MS apart). */
function nominatimSlot(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nominatimNextSlot);
  nominatimNextSlot = at + NOMINATIM_GAP_MS;
  if (at === now) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, at - now);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Street address at a [lon, lat] point, or null when there isn't one. */
export async function reverseStreetAddress(
  at: [number, number],
  signal?: AbortSignal,
): Promise<StreetAddress | null> {
  await nominatimSlot(signal);
  const params = new URLSearchParams({
    lat: at[1].toFixed(5),
    lon: at[0].toFixed(5),
    format: 'jsonv2',
    zoom: '18', // building level
    addressdetails: '1',
    'accept-language': 'en',
  });
  const res = await fetch(`${NOMINATIM_REVERSE}?${params}`, { signal });
  if (!res.ok) throw new Error(`reverse geocode ${res.status}`);
  return streetAddressFrom((await res.json()) as NominatimReverse, at);
}
