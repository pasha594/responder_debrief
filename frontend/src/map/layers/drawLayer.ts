/**
 * User annotations (Draw tab): placed ICS-style symbol markers and freehand
 * lines, rendered on top of everything. Unlike the data layers this manager
 * is INTERACTIVE and self-driven: it subscribes to the store's draw slice
 * directly (tool changes and feature edits re-render without a LayerContext
 * pass), owns the map pointer handlers for placing / drawing / erasing, and
 * persists per-fire to localStorage.
 */
import type { GeoJSONSource, Map as MlMap, MapMouseEvent, MapTouchEvent } from 'maplibre-gl';
import { useStore, type DrawFeature } from '../../state/store';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';
import { DRAW_LINE_COLOR, DRAW_SYMBOL_BY_ID } from './drawSymbols';

const SRC = 'rd-draw';
const LINE_LYR = 'rd-draw-line';
const PT_LYR = 'rd-draw-pt';
const LABEL_LYR = 'rd-draw-label';
/** Erase click tolerance, px. */
const ERASE_PAD = 8;

const EMPTY = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;

let fid = 0;
function nextFid(): string {
  fid += 1;
  return `d${Date.now().toString(36)}-${fid}`;
}

export function storageKey(corneaId: string): string {
  return `rd-draw:${corneaId}`;
}

function loadPersisted(corneaId: string): DrawFeature[] {
  try {
    const raw = localStorage.getItem(storageKey(corneaId));
    const parsed = raw ? (JSON.parse(raw) as DrawFeature[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(corneaId: string, features: DrawFeature[]): void {
  try {
    if (features.length) localStorage.setItem(storageKey(corneaId), JSON.stringify(features));
    else localStorage.removeItem(storageKey(corneaId));
  } catch {
    /* storage full/blocked — annotations stay session-only */
  }
}

// ---------- module state ----------

let unsubscribe: (() => void) | null = null;
let hydratedFor: string | null = null;
/** In-flight freehand stroke (not yet committed). */
let stroke: [number, number][] | null = null;

function ensureLayers(map: MlMap): void {
  if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: EMPTY });
  if (!map.getLayer(LINE_LYR)) {
    map.addLayer(
      {
        id: LINE_LYR,
        type: 'line',
        source: SRC,
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], DRAW_LINE_COLOR],
          'line-width': 3,
          'line-opacity': 0.95,
        },
      },
      beforeIdFor(map, LINE_LYR),
    );
  }
  if (!map.getLayer(PT_LYR)) {
    map.addLayer(
      {
        id: PT_LYR,
        type: 'circle',
        source: SRC,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 11,
          'circle-color': 'rgba(20, 16, 20, 0.85)',
          'circle-stroke-width': 2,
          'circle-stroke-color': ['coalesce', ['get', 'color'], DRAW_LINE_COLOR],
        },
      },
      beforeIdFor(map, PT_LYR),
    );
  }
  if (!map.getLayer(LABEL_LYR)) {
    map.addLayer(
      {
        id: LABEL_LYR,
        type: 'symbol',
        source: SRC,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'text-field': ['get', 'glyph'],
          'text-size': 11,
          'text-font': ['Noto Sans Bold'],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': ['coalesce', ['get', 'color'], DRAW_LINE_COLOR],
        },
      },
      beforeIdFor(map, LABEL_LYR),
    );
  }
}

function render(map: MlMap): void {
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (!src) return;
  const { features } = useStore.getState().draw;
  const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: features as never };
  // The live stroke previews as one more line while the finger is down.
  if (stroke && stroke.length > 1) {
    fc.features = [
      ...fc.features,
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: stroke },
        properties: { color: DRAW_LINE_COLOR },
      },
    ];
  }
  src.setData(fc);
}

function setCursor(map: MlMap): void {
  const tool = useStore.getState().draw.tool;
  map.getCanvas().style.cursor = tool === 'none' ? '' : 'crosshair';
}

// ---------- interactions ----------

function onClick(map: MlMap, e: MapMouseEvent): void {
  const { draw, actions } = useStore.getState();
  const tool = draw.tool;
  if (tool.startsWith('marker:')) {
    const sym = DRAW_SYMBOL_BY_ID[tool.slice('marker:'.length)];
    if (!sym) return;
    const f: DrawFeature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] },
      properties: { fid: nextFid(), kind: 'marker', sym: sym.id, glyph: sym.glyph, color: sym.color },
    };
    actions.drawCommit([...draw.features, f]);
    return;
  }
  if (tool === 'erase') {
    const pad = ERASE_PAD;
    const hits = map.queryRenderedFeatures(
      [
        [e.point.x - pad, e.point.y - pad],
        [e.point.x + pad, e.point.y + pad],
      ],
      { layers: [PT_LYR, LINE_LYR, LABEL_LYR].filter((l) => !!map.getLayer(l)) },
    );
    const hitFid = hits[0]?.properties?.fid as string | undefined;
    if (hitFid) {
      actions.drawCommit(draw.features.filter((f) => f.properties.fid !== hitFid));
    }
  }
}

function strokeStart(map: MlMap, e: MapMouseEvent | MapTouchEvent): void {
  if (useStore.getState().draw.tool !== 'freehand') return;
  e.preventDefault(); // keep dragPan out of the gesture
  stroke = [[e.lngLat.lng, e.lngLat.lat]];
  render(map);
}

function strokeMove(map: MlMap, e: MapMouseEvent | MapTouchEvent): void {
  if (!stroke) return;
  stroke.push([e.lngLat.lng, e.lngLat.lat]);
  render(map);
}

function strokeEnd(map: MlMap): void {
  if (!stroke) return;
  const pts = stroke;
  stroke = null;
  if (pts.length > 1) {
    const { draw, actions } = useStore.getState();
    const f: DrawFeature = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: pts },
      properties: { fid: nextFid(), kind: 'line', color: DRAW_LINE_COLOR },
    };
    actions.drawCommit([...draw.features, f]);
  } else {
    render(map);
  }
}

export const drawLayer: LayerManager = {
  mount(map) {
    ensureLayers(map);
    stroke = null;

    const click = (e: MapMouseEvent) => onClick(map, e);
    const mdown = (e: MapMouseEvent) => strokeStart(map, e);
    const mmove = (e: MapMouseEvent) => strokeMove(map, e);
    const mup = () => strokeEnd(map);
    const tdown = (e: MapTouchEvent) => strokeStart(map, e);
    const tmove = (e: MapTouchEvent) => strokeMove(map, e);
    map.on('click', click);
    map.on('mousedown', mdown);
    map.on('mousemove', mmove);
    map.on('mouseup', mup);
    map.on('touchstart', tdown);
    map.on('touchmove', tmove);
    map.on('touchend', mup);

    // Self-driven: draw-slice changes re-render without a LayerContext pass.
    unsubscribe = useStore.subscribe((state, prev) => {
      if (state.draw !== prev.draw) {
        render(map);
        setCursor(map);
        const cid = state.view.mode === 'fire' ? state.view.corneaId : null;
        if (cid && state.draw.features !== prev.draw.features) {
          persist(cid, state.draw.features);
        }
      }
    });

    const handlers = { click, mdown, mmove, mup, tdown, tmove };
    (map as unknown as { __rdDrawHandlers?: typeof handlers }).__rdDrawHandlers = handlers;
  },

  update(map, ctx) {
    ensureLayers(map);
    // Hydrate persisted annotations once per fire.
    const cid = ctx.view.mode === 'fire' ? ctx.view.corneaId : null;
    if (cid && hydratedFor !== cid) {
      hydratedFor = cid;
      useStore.getState().actions.drawHydrate(loadPersisted(cid));
    }
    render(map);
    setCursor(map);
  },

  unmount(map) {
    unsubscribe?.();
    unsubscribe = null;
    hydratedFor = null;
    stroke = null;
    const h = (map as unknown as { __rdDrawHandlers?: Record<string, never> }).__rdDrawHandlers;
    if (h) {
      map.off('click', h.click);
      map.off('mousedown', h.mdown);
      map.off('mousemove', h.mmove);
      map.off('mouseup', h.mup);
      map.off('touchstart', h.tdown);
      map.off('touchmove', h.tmove);
      map.off('touchend', h.mup);
    }
    for (const l of [LABEL_LYR, PT_LYR, LINE_LYR]) if (map.getLayer(l)) map.removeLayer(l);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
