/**
 * TomTom Traffic Incidents — closures, roadworks, jams around the fire.
 * One bbox query (clamped to the API's area limit), refreshed on a short
 * stale time. Requires the TomTom key; the toggle hides itself without it.
 */

const KEY = import.meta.env.VITE_TOMTOM_KEY as string | undefined;

export const incidentsAvailable = !!KEY;

/** iconCategory → what a responder needs to know at a glance. */
export const INCIDENT_KINDS: Record<number, { label: string; color: string; closure: boolean }> = {
  1: { label: 'Accident', color: '#ff9f43', closure: false },
  2: { label: 'Fog', color: '#9aa7b3', closure: false },
  3: { label: 'Dangerous conditions', color: '#ff9f43', closure: false },
  4: { label: 'Rain', color: '#9aa7b3', closure: false },
  5: { label: 'Ice', color: '#9ec8f0', closure: false },
  6: { label: 'Jam', color: '#ffb03a', closure: false },
  7: { label: 'Lane closed', color: '#ff7f50', closure: false },
  8: { label: 'Road closed', color: '#ff4d4f', closure: true },
  9: { label: 'Road works', color: '#e8b339', closure: false },
  10: { label: 'Wind', color: '#9aa7b3', closure: false },
  11: { label: 'Flooding', color: '#6fb7ff', closure: false },
  14: { label: 'Broken-down vehicle', color: '#ff9f43', closure: false },
};

export interface IncidentFeature {
  type: 'Feature';
  geometry: { type: 'LineString' | 'Point'; coordinates: unknown };
  properties: {
    kind: string;
    color: string;
    closure: boolean;
    description: string;
    road: string;
    delayS: number | null;
  };
}

export interface IncidentFC {
  type: 'FeatureCollection';
  features: IncidentFeature[];
}

/** The incidents API rejects large boxes — clamp to ~±0.55°/±0.45° around
 * the center (≈ 8,000 km², safely inside the 10,000 km² limit). */
export function clampIncidentBox(
  box: [number, number, number, number],
): [number, number, number, number] {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const hw = Math.min((box[2] - box[0]) / 2, 0.55);
  const hh = Math.min((box[3] - box[1]) / 2, 0.45);
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

export async function fetchIncidents(
  box: [number, number, number, number],
): Promise<IncidentFC> {
  const [w, s, e, n] = clampIncidentBox(box);
  const fields =
    '{incidents{type,geometry{type,coordinates},properties{iconCategory,' +
    'events{description},from,to,roadNumbers,delay}}}';
  const params = new URLSearchParams({
    key: KEY!,
    bbox: `${w},${s},${e},${n}`,
    fields,
    language: 'en-US',
    timeValidityFilter: 'present',
  });
  const res = await fetch(`https://api.tomtom.com/traffic/services/5/incidentDetails?${params}`);
  if (!res.ok) throw new Error(`incidents ${res.status}`);
  const d = (await res.json()) as {
    incidents?: {
      geometry: { type: 'LineString' | 'Point'; coordinates: unknown };
      properties: {
        iconCategory: number;
        events?: { description?: string }[];
        from?: string;
        to?: string;
        roadNumbers?: string[];
        delay?: number | null;
      };
    }[];
  };
  return {
    type: 'FeatureCollection',
    features: (d.incidents ?? []).map((i) => {
      const kind = INCIDENT_KINDS[i.properties.iconCategory] ?? {
        label: 'Incident',
        color: '#ff9f43',
        closure: false,
      };
      return {
        type: 'Feature',
        geometry: i.geometry,
        properties: {
          kind: kind.label,
          color: kind.color,
          closure: kind.closure,
          description: i.properties.events?.map((e) => e.description).filter(Boolean).join('; ')
            ?? kind.label,
          road: [i.properties.roadNumbers?.join('/'),
                 i.properties.from && i.properties.to
                   ? `${i.properties.from} → ${i.properties.to}`
                   : (i.properties.from ?? i.properties.to)]
            .filter(Boolean)
            .join(' · '),
          delayS: i.properties.delay ?? null,
        },
      };
    }),
  };
}
