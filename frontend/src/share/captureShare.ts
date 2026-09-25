/** The open fire's view as a ShareState — what the share dialog encodes. */
import type { Map as MlMap } from 'maplibre-gl';
import type { WeatherProduct } from '../api/types';
import { drawLineById, drawSymbolById } from '../map/layers/drawSymbols';
import { MY_LOCATION_LABEL } from '../panels/SearchDirectionsControl';
import { useStore, type AppState, type DrawFeature } from '../state/store';
import type { SharePoint, ShareRouting, ShareState } from './shareCodec';

/** Playhead offsets under this read as "now" (the share-link codec's rule). */
const NOW_EPSILON_MS = 2 * 60_000;

/** A "My location" end would make the recipient's phone follow ITS own GPS
 * there — so it travels as the spot it was, under this label. */
const SENDER_LOCATION_LABEL = 'Sender’s location';

/** Directions or a dropped pin on screen — what the share dialog offers. */
export function hasRoutingToShare(s: AppState): boolean {
  return !!(s.droppedPin || s.directions.a || s.directions.b);
}

function point(p: AppState['directions']['a']): SharePoint | null {
  if (!p) return null;
  return { coords: p.coords, label: p.label === MY_LOCATION_LABEL ? SENDER_LOCATION_LABEL : p.label };
}

function captureRouting(s: AppState): ShareRouting {
  const d = s.directions;
  const r = d.a && d.b ? d.route : null;
  return {
    profile: d.profile,
    avoidPerimeter: d.avoidPerimeter,
    a: point(d.a),
    b: point(d.b),
    pin: s.droppedPin,
    route: r && {
      coordinates: r.geometry.coordinates,
      distanceM: r.distanceM,
      durationS: r.durationS,
      trafficDelayS: r.trafficDelayS,
      engine: r.engine,
      // the safety warnings, not the info notes (the card hides some anyway)
      notes: (r.notes ?? []).filter((n) => n.level === 'warn').map(({ code, text }) => ({ code, text })),
    },
  };
}

/** Marks saved under pre-NWCG ids travel under today's (smaller codes). */
function canonical(f: DrawFeature): DrawFeature {
  const p = f.properties;
  if (p.kind === 'marker') {
    const sym = drawSymbolById(p.sym)?.id ?? p.sym;
    return { ...f, properties: { ...p, ...(sym ? { sym } : {}) } };
  }
  const style = drawLineById(p.style)?.id ?? p.style;
  return { ...f, properties: { ...p, ...(style ? { style } : {}) } };
}

export function captureShare(
  map: MlMap,
  fireName: string,
  include: { drawings: boolean; routing: boolean },
): ShareState | null {
  const s = useStore.getState();
  if (s.view.mode !== 'fire') return null;
  const corneaId = s.view.corneaId;
  const pack = Object.values(s.offline.packs).find((p) => p.corneaId === corneaId);
  const savedAt = pack ? Date.parse(pack.downloadedAt) : NaN;
  const center = map.getCenter().wrap();
  const weather: Partial<Record<WeatherProduct, number>> = {};
  for (const [p, st] of Object.entries(s.layers.weather) as [WeatherProduct, { visible: boolean; opacity: number }][]) {
    if (st.visible) weather[p] = st.opacity;
  }
  return {
    fire: { corneaId, name: fireName },
    sharedAt: Date.now(),
    packSavedAt: Number.isFinite(savedAt) ? savedAt : null,
    camera: {
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    },
    basemap: s.ui.basemap,
    time: Math.abs(s.time.currentTime - s.time.now) > NOW_EPSILON_MS ? s.time.currentTime : null,
    layers: {
      spread: { ...s.layers.spread },
      weather,
      hotspots: s.layers.hotspots.visible,
      perimeters: s.layers.perimeters.visible,
      historic: s.layers.historicPerimeters.visible,
      traffic: s.layers.traffic.visible,
      incidents: s.layers.incidents.visible,
      incidentMap: { ...s.layers.incidentMap },
      irFlight: s.layers.irFlight.flightId,
      trails: s.layers.trails.mode,
      vegetation: { ...s.layers.vegetation },
      land: s.layers.land.visible,
    },
    drawings: include.drawings ? s.draw.features.map(canonical) : null,
    routing: include.routing && hasRoutingToShare(s) ? captureRouting(s) : null,
  };
}
