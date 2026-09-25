/**
 * Dashed outline of the fire's offline routing area, shown while Walk is
 * the directions mode: inside it Walk works without signal; outside it (or
 * offline) the card says why. Self-driven (bundle-dependent).
 *
 * Its source also carries the credit for Walk's route data. The graph is
 * an ODbL Derivative Database of OSM, so while an offroad route can be on
 * the map, the attribution control must say so. MapLibre lists a source's
 * attribution only while one of its layers is visible, so the outline
 * layer is hidden, not just emptied, when there is no routing area. An
 * offroad route needs Walk, a pin and this fire's bundle, which is exactly
 * when the outline shows.
 */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { loadFireBundle } from '../../routing/hooks';
import { utmBoundsTo4326 } from '../../spread/utm';
import { useStore } from '../../state/store';
import type { LayerManager } from '../layerTypes';
import { OSM_CREDIT } from '../pmtilesSource';
import { beforeIdFor } from '../zOrder';

const SRC = 'rd-routing-area';
const LYR = 'rd-routing-area';
const EMPTY = { type: 'FeatureCollection', features: [] } as GeoJSON.GeoJSON;
/** Only the ODbL credit: the agency sources are on the Sources page. */
export const WALK_ATTRIBUTION = OSM_CREDIT;

let unsubscribe: (() => void) | null = null;
let lastKey = '';
let seq = 0;

function dead(map: MlMap): boolean {
  const m = map as unknown as { _removed?: boolean; style?: unknown };
  return !!m._removed || !m.style;
}

function show(map: MlMap, src: GeoJSONSource, data: GeoJSON.GeoJSON | null): void {
  src.setData(data ?? EMPTY);
  if (map.getLayer(LYR)) map.setLayoutProperty(LYR, 'visibility', data ? 'visible' : 'none');
}

function reconcile(map: MlMap): void {
  if (dead(map) || !map.getSource(SRC)) return;
  const s = useStore.getState();
  const d = s.directions;
  const corneaId = s.view.mode === 'fire' ? s.view.corneaId : null;
  const want = !!corneaId && d.profile === 'hike' && (!!d.a || !!d.b || d.armed);
  const key = `${want}|${corneaId}`;
  if (key === lastKey) return;
  lastKey = key;
  const mySeq = ++seq;
  const src = map.getSource(SRC) as GeoJSONSource;
  if (!want || !corneaId) {
    show(map, src, null);
    return;
  }
  void loadFireBundle(corneaId).then((b) => {
    if (mySeq !== seq || dead(map)) return;
    if (!b) {
      show(map, src, null);
      return;
    }
    const g = b.grid;
    const { corners } = utmBoundsTo4326(
      [g.x0, g.y0 - g.height * g.cell_m, g.x0 + g.width * g.cell_m, g.y0], b.crs.zone, b.crs.northern);
    show(map, src, { type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: [...corners, corners[0]] } } as GeoJSON.GeoJSON);
  }).catch(() => undefined);
}

export const routingAreaLayer: LayerManager = {
  mount(map) {
    lastKey = '';
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: EMPTY, attribution: WALK_ATTRIBUTION });
    if (!map.getLayer(LYR)) {
      map.addLayer({
        id: LYR, type: 'line', source: SRC, layout: { visibility: 'none' },
        paint: { 'line-color': '#d8d2d5', 'line-opacity': 0.6, 'line-width': 1.2, 'line-dasharray': [3, 3] },
      }, beforeIdFor(map, 'rd-routing-area'));
    }
    unsubscribe?.();
    unsubscribe = useStore.subscribe((s, prev) => {
      if (s.directions !== prev.directions || s.view !== prev.view) reconcile(map);
    });
    reconcile(map);
  },
  update() {
    /* self-driven */
  },
  unmount(map) {
    unsubscribe?.();
    unsubscribe = null;
    seq++;
    try {
      if (map.getLayer(LYR)) map.removeLayer(LYR);
      if (map.getSource(SRC)) map.removeSource(SRC);
    } catch {
      /* dead style */
    }
  },
};
