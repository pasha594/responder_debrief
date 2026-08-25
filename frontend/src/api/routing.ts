/**
 * Directions between two points, normalized across engines:
 *
 *   drive:  TomTom (live-traffic ETA; VITE_TOMTOM_KEY)
 *           → fallback: OSRM public demo (no traffic, keyless)
 *   hike:   openrouteservice foot-hiking (OSM trails; VITE_ORS_KEY)
 *           → fallback: FOSSGIS Valhalla pedestrian (keyless)
 *
 * The keyless fallbacks are community demo servers — fine for light use,
 * upgraded automatically when the keys ship. None of these engines know
 * about fire closures; the UI says so.
 */

export type RouteProfile = 'drive' | 'hike' | 'apparatus';

/**
 * Typical wildland engine / water tender envelope for truck routing —
 * deliberately on the heavy/tall side so a "legal" route is legal for the
 * whole column. (Type 3 engine ≈ 12 t / 3.2 m; tenders run larger.)
 */
export const APPARATUS_DIMS = {
  vehicleWeight: 18000, // kg
  vehicleHeight: 3.7, // m
  vehicleWidth: 2.6, // m
  vehicleLength: 10, // m
} as const;

export const apparatusAvailable = !!(import.meta.env.VITE_TOMTOM_KEY as string | undefined);

export interface RouteStep {
  text: string;
  distanceM: number;
}

export interface RouteResult {
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  distanceM: number;
  durationS: number;
  /** Seconds of the duration attributable to current traffic (TomTom only). */
  trafficDelayS: number | null;
  steps: RouteStep[];
  engine: 'tomtom' | 'osrm' | 'ors' | 'valhalla';
}

const TOMTOM_KEY = import.meta.env.VITE_TOMTOM_KEY as string | undefined;
const ORS_KEY = import.meta.env.VITE_ORS_KEY as string | undefined;

type LonLat = [number, number];

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`routing ${res.status}`);
  return res.json() as Promise<T>;
}

// ---------- TomTom (drive, traffic-aware) ----------

async function routeTomTom(a: LonLat, b: LonLat, apparatus = false): Promise<RouteResult> {
  const locs = `${a[1]},${a[0]}:${b[1]},${b[0]}`;
  const params = new URLSearchParams({
    key: TOMTOM_KEY!,
    traffic: 'true',
    travelMode: apparatus ? 'truck' : 'car',
    instructionsType: 'text',
    language: 'en-US',
  });
  if (apparatus) {
    for (const [k, v] of Object.entries(APPARATUS_DIMS)) params.set(k, String(v));
  }
  const d = await getJson<{
    routes: {
      summary: { lengthInMeters: number; travelTimeInSeconds: number; trafficDelayInSeconds: number };
      legs: { points: { latitude: number; longitude: number }[] }[];
      guidance?: { instructions?: { message?: string; routeOffsetInMeters?: number }[] };
    }[];
  }>(`https://api.tomtom.com/routing/1/calculateRoute/${locs}/json?${params}`);
  const r = d.routes[0];
  const coords: LonLat[] = r.legs.flatMap((l) => l.points.map((p) => [p.longitude, p.latitude] as LonLat));
  const withMsg = (r.guidance?.instructions ?? []).filter((i) => i.message);
  const steps: RouteStep[] = withMsg.map((i, idx) => ({
    text: i.message!,
    distanceM: idx + 1 < withMsg.length
      ? Math.max(0, (withMsg[idx + 1].routeOffsetInMeters ?? 0) - (i.routeOffsetInMeters ?? 0))
      : 0,
  }));
  return {
    geometry: { type: 'LineString', coordinates: coords },
    distanceM: r.summary.lengthInMeters,
    durationS: r.summary.travelTimeInSeconds,
    trafficDelayS: r.summary.trafficDelayInSeconds ?? null,
    steps,
    engine: 'tomtom',
  };
}

// ---------- OSRM demo (drive fallback) ----------

async function routeOsrm(a: LonLat, b: LonLat): Promise<RouteResult> {
  const d = await getJson<{
    routes: {
      distance: number;
      duration: number;
      geometry: { coordinates: [number, number][] };
      legs: { steps: { distance: number; name: string; maneuver: { type: string; modifier?: string } }[] }[];
    }[];
  }>(
    `https://router.project-osrm.org/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}` +
      `?overview=full&geometries=geojson&steps=true`,
  );
  const r = d.routes[0];
  const steps: RouteStep[] = r.legs.flatMap((l) =>
    l.steps.map((s) => ({ text: osrmStepText(s), distanceM: s.distance })),
  );
  return {
    geometry: { type: 'LineString', coordinates: r.geometry.coordinates },
    distanceM: r.distance,
    durationS: r.duration,
    trafficDelayS: null,
    steps,
    engine: 'osrm',
  };
}

/** OSRM emits machine tokens ("new name", "end of road") — humanize them. */
const OSRM_VERBS: Record<string, string> = {
  depart: 'Start',
  arrive: 'Arrive',
  turn: 'Turn',
  'new name': 'Continue',
  continue: 'Continue',
  merge: 'Merge',
  ramp: 'Take the ramp',
  'on ramp': 'Take the on-ramp',
  'off ramp': 'Take the off-ramp',
  fork: 'Keep',
  'end of road': 'At the end of the road, turn',
  roundabout: 'Enter the roundabout',
  rotary: 'Enter the rotary',
  'exit roundabout': 'Exit the roundabout',
  'exit rotary': 'Exit the rotary',
};

function osrmStepText(s: {
  name: string;
  maneuver: { type: string; modifier?: string };
}): string {
  const verb = OSRM_VERBS[s.maneuver.type] ?? 'Continue';
  const mod = s.maneuver.type === 'turn' || s.maneuver.type === 'fork' || s.maneuver.type === 'end of road'
    ? s.maneuver.modifier
    : undefined;
  const onto = s.name && s.maneuver.type !== 'arrive' ? `onto ${s.name}` : '';
  return [verb, mod, onto].filter(Boolean).join(' ');
}

// ---------- openrouteservice (hike) ----------

async function routeOrs(a: LonLat, b: LonLat): Promise<RouteResult> {
  const d = await getJson<{
    features: {
      geometry: { coordinates: [number, number][] };
      properties: {
        summary: { distance: number; duration: number };
        segments: { steps: { instruction: string; distance: number }[] }[];
      };
    }[];
  }>('https://api.openrouteservice.org/v2/directions/foot-hiking/geojson', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: ORS_KEY! },
    body: JSON.stringify({ coordinates: [a, b] }),
  });
  const f = d.features[0];
  return {
    geometry: { type: 'LineString', coordinates: f.geometry.coordinates },
    distanceM: f.properties.summary.distance,
    durationS: f.properties.summary.duration,
    trafficDelayS: null,
    steps: f.properties.segments.flatMap((s) =>
      s.steps.map((st) => ({ text: st.instruction, distanceM: st.distance })),
    ),
    engine: 'ors',
  };
}

// ---------- FOSSGIS Valhalla (hike fallback) ----------

/** Valhalla encodes shapes as polyline with 1e-6 precision. */
export function decodePolyline6(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let lat = 0;
  let lon = 0;
  let i = 0;
  while (i < encoded.length) {
    for (const which of [0, 1] as const) {
      let shift = 0;
      let result = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lon += delta;
    }
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

async function routeValhalla(a: LonLat, b: LonLat): Promise<RouteResult> {
  const req = {
    locations: [
      { lat: a[1], lon: a[0] },
      { lat: b[1], lon: b[0] },
    ],
    costing: 'pedestrian',
    units: 'kilometers',
  };
  const d = await getJson<{
    trip: {
      summary: { length: number; time: number };
      legs: { shape: string; maneuvers: { instruction: string; length: number }[] }[];
    };
  }>(`https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(req))}`);
  const t = d.trip;
  return {
    geometry: {
      type: 'LineString',
      coordinates: t.legs.flatMap((l) => decodePolyline6(l.shape)),
    },
    distanceM: t.summary.length * 1000,
    durationS: t.summary.time,
    trafficDelayS: null,
    steps: t.legs.flatMap((l) =>
      l.maneuvers.map((m) => ({ text: m.instruction, distanceM: m.length * 1000 })),
    ),
    engine: 'valhalla',
  };
}

// ---------- public entry ----------

export async function fetchRoute(
  a: LonLat,
  b: LonLat,
  profile: RouteProfile,
): Promise<RouteResult> {
  if (profile === 'apparatus') {
    // No silent car fallback here: a failure must read as "no apparatus-
    // legal route", not quietly hand back a route a tender can't take.
    return routeTomTom(a, b, true);
  }
  if (profile === 'drive') {
    if (TOMTOM_KEY) {
      try {
        return await routeTomTom(a, b);
      } catch {
        /* fall through to the community engine */
      }
    }
    return routeOsrm(a, b);
  }
  if (ORS_KEY) {
    try {
      return await routeOrs(a, b);
    } catch {
      /* fall through */
    }
  }
  return routeValhalla(a, b);
}


// ---------- reachable range (drive-time isochrones) ----------

export interface RangeRing {
  minutes: number;
  polygon: { type: 'Polygon'; coordinates: [number, number][][] };
}

async function rangeTomTom(origin: LonLat, minutes: number): Promise<RangeRing> {
  const params = new URLSearchParams({
    key: TOMTOM_KEY!,
    timeBudgetInSec: String(minutes * 60),
    traffic: 'true',
    travelMode: 'car',
  });
  const d = await getJson<{
    reachableRange: { boundary: { latitude: number; longitude: number }[] };
  }>(
    `https://api.tomtom.com/routing/1/calculateReachableRange/${origin[1]},${origin[0]}/json?${params}`,
  );
  const ring = d.reachableRange.boundary.map(
    (p) => [p.longitude, p.latitude] as [number, number],
  );
  if (ring.length) ring.push(ring[0]);
  return { minutes, polygon: { type: 'Polygon', coordinates: [ring] } };
}

async function rangeValhalla(origin: LonLat, budgets: number[]): Promise<RangeRing[]> {
  const req = {
    locations: [{ lat: origin[1], lon: origin[0] }],
    costing: 'auto',
    contours: budgets.map((m) => ({ time: m })),
    polygons: true,
  };
  const d = await getJson<{
    features: {
      geometry: { type: string; coordinates: [number, number][][] };
      properties: { contour: number };
    }[];
  }>(`https://valhalla1.openstreetmap.de/isochrone?json=${encodeURIComponent(JSON.stringify(req))}`);
  return d.features.map((f) => ({
    minutes: f.properties.contour,
    polygon: { type: 'Polygon' as const, coordinates: f.geometry.coordinates },
  }));
}

/** Drive-time rings around a point (traffic-aware with the TomTom key,
 * community Valhalla otherwise). Sorted small→large. */
export async function fetchReachableRange(
  origin: LonLat,
  budgets: number[] = [15, 30, 60],
): Promise<{ rings: RangeRing[]; engine: 'tomtom' | 'valhalla' }> {
  if (TOMTOM_KEY) {
    try {
      const rings = await Promise.all(budgets.map((m) => rangeTomTom(origin, m)));
      return { rings: rings.sort((x, y) => x.minutes - y.minutes), engine: 'tomtom' };
    } catch {
      /* fall through */
    }
  }
  const rings = await rangeValhalla(origin, budgets);
  return { rings: rings.sort((x, y) => x.minutes - y.minutes), engine: 'valhalla' };
}
