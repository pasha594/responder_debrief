/** The open fire's view as a ShareState — what the share dialog encodes. */
import type { Map as MlMap } from 'maplibre-gl';
import type { WeatherProduct } from '../api/types';
import { drawLineById, drawSymbolById } from '../map/layers/drawSymbols';
import { useStore, type DrawFeature } from '../state/store';
import type { ShareState } from './shareCodec';

/** Playhead offsets under this read as "now" (the share-link codec's rule). */
const NOW_EPSILON_MS = 2 * 60_000;

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
  includeDrawings: boolean,
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
    },
    drawings: includeDrawings ? s.draw.features.map(canonical) : null,
  };
}
