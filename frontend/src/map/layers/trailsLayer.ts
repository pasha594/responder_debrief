/**
 * Trails overlay: USFS / BLM / NPS trails from PMTiles, drawn in our own
 * teal over any ground, with tap popups (name, number, agency, class,
 * allowed uses, official restrictions, source date, "Walk here").
 *
 * Self-driven (like basemapUnderlay): the archive and paint depend on
 * online/offline, the fire's pack and the ground, none of which the layer
 * context carries — so it subscribes to the store and resolves its source
 * asynchronously:
 *   online  → the national archive (catalogs/trails.json pointer);
 *   offline → the fire's packed extract (trails + OSM `ways`, the only
 *             ground reference on the blank offline style), sliced from OPFS;
 *   online but no national build yet → the fire bundle's extract over HTTP.
 * The source is recreated when the archive key changes (a pack update
 * yields a new File snapshot and a new key).
 *
 * Click arbitration: 'rd-trails-hit' is in pinDrop FEATURE_LAYERS and
 * useMapLayerSync INTERACTIVE; the popup yields to route-endpoint claims,
 * an armed draw tool, and higher-priority features under the tap.
 */
import { Popup, type Map as MlMap, type MapLayerMouseEvent } from 'maplibre-gl';
import { dataUrl } from '../../api/catalogs';
import { trackOncePer } from '../../app/analytics';
import { packedFile, packsReady } from '../../offline/packs';
import { getTrailsPointer } from '../../routing/bundleIndex';
import { loadFireBundle } from '../../routing/hooks';
import { routeClickClaims, useStore } from '../../state/store';
import { rdLabelFont } from '../glyphFonts';
import type { LayerManager } from '../layerTypes';
import {
  ensurePmtilesProtocol,
  fireTrailsArchive,
  nationalTrailsArchive,
  type TrailsArchive,
} from '../pmtilesSource';
import { beforeIdFor, type RdLayerId } from '../zOrder';
import {
  CASING_WIDTH,
  CORE_WIDTH,
  NOT_ASSESSED,
  TRAIL_PAINT,
  groundKey,
  trailPopupHtml,
  trailsVisible,
  type Ground,
} from './trailsStyle';

const SRC = 'rd-trails';
const WAYS = 'rd-trails-ways';
const CASING = 'rd-trails-casing';
const LINE = 'rd-trails-line';
const LABEL = 'rd-trails-label';
const HIT = 'rd-trails-hit';
const LAYERS = [WAYS, CASING, LINE, LABEL, HIT] as const;
/** Clicks on these win over a trail popup under the same tap. */
const PRIORITY_LAYERS = ['rd-hotspots', 'rd-fire-pins', 'rd-incidents-pt', 'rd-incidents-line'];

let archive: TrailsArchive | null = null;
let inputsKey = '';
let resolveSeq = 0;
let lastApplied = '';
let nationalFailed = false;
let natErrors: number[] = [];
let unsubscribe: (() => void) | null = null;
/** getStyle() serializes the whole style — far too heavy for update(),
 * which runs every playback tick. Cached; cleared on style swaps. */
let offlineStyleCache: boolean | null = null;
let popup: Popup | null = null;
const handlersInstalled = new WeakSet<MlMap>();

function dead(map: MlMap): boolean {
  const m = map as unknown as { _removed?: boolean; style?: unknown };
  return !!m._removed || !m.style;
}

function isOfflineStyle(map: MlMap): boolean {
  if (offlineStyleCache === null) {
    const sources = map.getStyle()?.sources ?? {};
    offlineStyleCache = !Object.keys(sources).some((id) => !id.startsWith('rd-'));
  }
  return offlineStyleCache;
}

function currentGround(map: MlMap): Ground {
  const ui = useStore.getState().ui;
  return groundKey(ui.basemap, ui.theme, isOfflineStyle(map));
}

async function resolveArchive(online: boolean, corneaId: string | null): Promise<TrailsArchive | null> {
  await packsReady;
  if (online && !nationalFailed) {
    const p = await getTrailsPointer();
    if (p) return nationalTrailsArchive(p);
  }
  if (!corneaId) return null;
  const b = await loadFireBundle(corneaId);
  const t = b?.files.trails;
  if (!b || !t) return null;
  const file = await packedFile(dataUrl(t.path));
  if (file) return fireTrailsArchive(b, file);
  if (!online) return null;
  ensurePmtilesProtocol();
  return {
    key: `fire-http:${b.bundle_id}`,
    kind: 'fire',
    url: `pmtiles://${dataUrl(t.path)}`,
    attribution: 'Trails: USFS · BLM · NPS · © OpenStreetMap contributors',
  };
}

function removeAll(map: MlMap): void {
  for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SRC)) map.removeSource(SRC);
}

function addLayers(map: MlMap, a: TrailsArchive): void {
  map.addSource(SRC, { type: 'vector', url: a.url, attribution: a.attribution });
  const hidden = { visibility: 'none' as const };
  const add = (spec: Parameters<MlMap['addLayer']>[0], id: RdLayerId) =>
    map.addLayer(spec, beforeIdFor(map, id));
  if (a.kind === 'fire') {
    add({
      id: WAYS, type: 'line', source: SRC, 'source-layer': 'ways',
      layout: { ...hidden, 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#8a8586',
        'line-width': ['match', ['get', 'cls'], [1, 2], 1.4, 3, 1.1, 0.9],
        'line-opacity': 0.9,
      },
    }, WAYS);
  }
  add({
    id: CASING, type: 'line', source: SRC, 'source-layer': 'trails',
    layout: { ...hidden, 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': CASING_WIDTH, 'line-opacity': 0.85 },
  }, CASING);
  add({
    id: LINE, type: 'line', source: SRC, 'source-layer': 'trails',
    layout: { ...hidden, 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#0e8f8a',
      'line-width': CORE_WIDTH,
      'line-opacity': ['case', NOT_ASSESSED, 0.55, 1],
    },
  }, LINE);
  add({
    id: LABEL, type: 'symbol', source: SRC, 'source-layer': 'trails', minzoom: 12,
    layout: {
      ...hidden,
      'symbol-placement': 'line',
      'symbol-spacing': 400,
      'text-field': ['coalesce', ['get', 'name'], ['get', 'num'], ''],
      'text-size': 11,
      'text-font': rdLabelFont(map),
    },
    paint: { 'text-color': '#0e8f8a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
  }, LABEL);
  add({
    id: HIT, type: 'line', source: SRC, 'source-layer': 'trails', minzoom: 11,
    layout: hidden,
    // opacity 0 stays hit-testable (a zero WIDTH would not)
    paint: { 'line-color': '#000000', 'line-width': 14, 'line-opacity': 0 },
  }, HIT);
}

/** Visibility + per-ground paint (cheap; diffed). */
function applyLook(map: MlMap): void {
  if (!archive || !map.getLayer(LINE)) return;
  const ground = currentGround(map);
  const mode = useStore.getState().layers.trails.mode;
  const visible = trailsVisible(mode, ground);
  const key = `${archive.key}|${ground}|${visible}`;
  if (key === lastApplied) return;
  lastApplied = key;
  const p = TRAIL_PAINT[ground];
  const v = visible ? 'visible' : 'none';
  for (const id of [CASING, LINE, LABEL, HIT]) map.setLayoutProperty(id, 'visibility', v);
  if (map.getLayer(WAYS)) {
    map.setLayoutProperty(WAYS, 'visibility', visible && ground === 'offline' ? 'visible' : 'none');
    map.setPaintProperty(WAYS, 'line-color', p.ways);
  }
  map.setPaintProperty(CASING, 'line-color', p.casing);
  map.setPaintProperty(CASING, 'line-opacity', p.casingOpacity);
  map.setPaintProperty(LINE, 'line-color', p.core);
  map.setPaintProperty(LABEL, 'text-color', p.core);
  map.setPaintProperty(LABEL, 'text-halo-color', p.halo);
  if (!visible) popup?.remove();
}

function reconcile(map: MlMap): void {
  if (dead(map)) return;
  const s = useStore.getState();
  const corneaId = s.view.mode === 'fire' ? s.view.corneaId : null;
  const pack = Object.values(s.offline.packs).find((m) => m.corneaId === corneaId);
  const key = `${s.offline.online}|${corneaId}|${pack?.downloadedAt ?? ''}|${nationalFailed}`;
  if (key !== inputsKey) {
    inputsKey = key;
    const seq = ++resolveSeq;
    void resolveArchive(s.offline.online, corneaId).then((a) => {
      if (seq !== resolveSeq || dead(map)) return;
      if ((a?.key ?? null) === (archive?.key ?? null)) return;
      try {
        removeAll(map);
        archive = a;
        lastApplied = '';
        if (a) addLayers(map, a);
        applyLook(map);
      } catch {
        /* style mid-swap — the next reconcile retries */
        inputsKey = '';
      }
    }).catch(() => {
      if (seq === resolveSeq) inputsKey = '';
    });
  }
  try {
    applyLook(map);
  } catch {
    /* style mid-swap */
  }
}

/** Re-apply ground-dependent paint after a style swap goes idle (MapRoot). */
export function resyncTrailsGround(map: MlMap): void {
  lastApplied = '';
  offlineStyleCache = null;
  try {
    applyLook(map);
  } catch {
    /* style not ready */
  }
}

function onClick(this: MlMap, e: MapLayerMouseEvent): void {
  const st = useStore.getState();
  if (routeClickClaims(st.directions) || st.draw.tool !== 'none') return;
  const present = PRIORITY_LAYERS.filter((l) => this.getLayer(l));
  if (present.length && this.queryRenderedFeatures(e.point, { layers: present }).length) return;
  const f = e.features?.[0];
  if (!f) return;
  const props = (f.properties ?? {}) as Record<string, unknown>;
  const at: [number, number] = [e.lngLat.lng, e.lngLat.lat];
  popup ??= new Popup({ closeButton: false, offset: 8 });
  popup.setLngLat(e.lngLat).setHTML(trailPopupHtml(props)).addTo(this);
  const el = popup.getElement();
  el?.querySelector('[data-walk-here]')?.addEventListener('click', () => {
    const a = useStore.getState().actions;
    a.setDirectionsProfile('hike');
    a.setDirectionsPoint('b', { coords: at, label: `${at[1].toFixed(5)}, ${at[0].toFixed(5)}` });
    trackOncePer('fire-view', 'walk_here_used');
    popup?.remove();
  }, { once: true });
  trackOncePer('fire-view', 'trail_popup_opened', { agency: String(props.agency ?? '') });
}

function onEnter(this: MlMap): void {
  this.getCanvas().style.cursor = 'pointer';
}
function onLeave(this: MlMap): void {
  this.getCanvas().style.cursor = '';
}

function onError(this: MlMap, e: { sourceId?: string }): void {
  if (e.sourceId !== SRC || archive?.kind !== 'national') return;
  const now = Date.now();
  natErrors = [...natErrors.filter((t) => now - t < 10_000), now];
  if (natErrors.length >= 3) {
    // national archive unreachable this session: use the fire's extract
    nationalFailed = true;
    reconcile(this);
  }
}

export const trailsLayer: LayerManager = {
  mount(map) {
    archive = null;
    inputsKey = '';
    lastApplied = '';
    offlineStyleCache = null;
    nationalFailed = false;
    natErrors = [];
    if (!handlersInstalled.has(map)) {
      handlersInstalled.add(map);
      map.on('click', HIT, onClick);
      map.on('mouseenter', HIT, onEnter);
      map.on('mouseleave', HIT, onLeave);
      map.on('error', onError);
    }
    unsubscribe?.();
    unsubscribe = useStore.subscribe((s, prev) => {
      if (dead(map)) return;
      if (s.layers.trails !== prev.layers.trails || s.ui.basemap !== prev.ui.basemap
          || s.ui.theme !== prev.ui.theme || s.ui.mapStyle !== prev.ui.mapStyle
          || s.offline !== prev.offline || s.view !== prev.view) {
        if (s.offline.online !== prev.offline.online) offlineStyleCache = null;
        reconcile(map);
      }
    });
    reconcile(map);
  },

  update(map) {
    reconcile(map);
  },

  unmount(map) {
    unsubscribe?.();
    unsubscribe = null;
    map.off('click', HIT, onClick);
    map.off('mouseenter', HIT, onEnter);
    map.off('mouseleave', HIT, onLeave);
    map.off('error', onError);
    handlersInstalled.delete(map);
    popup?.remove();
    popup = null;
    resolveSeq++;
    try {
      removeAll(map);
    } catch {
      /* dead style */
    }
    archive = null;
  },
};
