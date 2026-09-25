/**
 * User annotations (Draw tab): official NWCG PMS 936 point symbols and line
 * styles (see drawPlan / drawImages), rendered on top of everything. Unlike
 * the data layers this manager is INTERACTIVE and self-driven: it subscribes
 * to the store's draw slice directly (tool changes and feature edits
 * re-render without a LayerContext pass), owns the map pointer handlers for
 * placing / drawing / erasing, and persists per-fire to localStorage.
 */
import type {
  FilterSpecification,
  GeoJSONSource,
  LayerSpecification,
  LineLayerSpecification,
  Map as MlMap,
  MapMouseEvent,
  MapStyleImageMissingEvent,
  MapTouchEvent,
  SymbolLayerSpecification,
} from 'maplibre-gl';
import { useStore, type DrawFeature } from '../../state/store';
import { beforeIdFor, type RdLayerId } from '../zOrder';
import type { LayerManager } from '../layerTypes';
import { drawLineById, drawSymbolById } from './drawSymbols';
import { drawSourceFeatures, type DrawSlot } from './drawPlan';
import { preloadPointIcons, provideDrawImage, symbolCursor } from './drawImages';

const SRC = 'rd-draw';
/** One map layer per slot, bottom → top (drawPlan explains the stack). */
const SLOT_LAYER: Record<DrawSlot, RdLayerId> = {
  stroke: 'rd-draw-line',
  dash: 'rd-draw-line-dash',
  pattern: 'rd-draw-line-pattern',
  marks: 'rd-draw-line-marks',
  'stroke-top': 'rd-draw-line-top',
  'dash-top': 'rd-draw-line-dash-top',
  upright: 'rd-draw-line-letter',
  'pt-map': 'rd-draw-pt-map',
  pt: 'rd-draw-pt',
};
const DRAW_LAYERS = Object.values(SLOT_LAYER);
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

/** How many marks this device has saved for a fire (the share preview's
 * "replaces your N marks"). */
export function savedMarkCount(corneaId: string): number {
  return loadPersisted(corneaId).length;
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
let lastRenderedFeatures: unknown = null;

const ICON_LAYOUT: SymbolLayerSpecification['layout'] = {
  'icon-image': ['get', 'icon'],
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
  'symbol-sort-key': ['get', 'sort'],
};

function layerSpec(slot: DrawSlot): LayerSpecification {
  const base = {
    id: SLOT_LAYER[slot],
    source: SRC,
    filter: ['==', ['get', 'slot'], slot] as FilterSpecification,
  };
  if (slot === 'stroke' || slot === 'stroke-top' || slot === 'dash' || slot === 'dash-top') {
    const spec: LineLayerSpecification = {
      ...base,
      type: 'line',
      layout: {
        'line-cap': ['get', 'cap'],
        'line-join': ['get', 'join'],
        'line-sort-key': ['get', 'sort'],
      },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['get', 'width'],
        'line-offset': ['get', 'offset'],
      },
    };
    if (slot === 'dash' || slot === 'dash-top') {
      spec.paint!['line-dasharray'] = ['array', 'number', ['get', 'dash']];
    }
    return spec;
  }
  if (slot === 'pattern') {
    const spec: LineLayerSpecification = {
      ...base,
      type: 'line',
      layout: { 'line-join': 'round', 'line-sort-key': ['get', 'sort'] },
      paint: { 'line-pattern': ['get', 'pattern'], 'line-width': ['get', 'width'] },
    };
    return spec;
  }
  const layout: SymbolLayerSpecification['layout'] = { ...ICON_LAYOUT };
  if (slot === 'marks') {
    // placed one by one at the NWCG spacing (drawPlan), turned along the line
    layout['icon-rotate'] = ['get', 'rot'];
    layout['icon-rotation-alignment'] = 'map';
  } else if (slot === 'upright') {
    layout['icon-rotation-alignment'] = 'viewport';
  } else if (slot === 'pt-map') {
    // turns with the map's bearing, but still stands up to face a tilted camera
    layout['icon-rotate'] = ['get', 'rot'];
    layout['icon-rotation-alignment'] = 'map';
    layout['icon-pitch-alignment'] = 'viewport';
  }
  const spec: SymbolLayerSpecification = { ...base, type: 'symbol', layout };
  return spec;
}

function ensureLayers(map: MlMap): void {
  if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: EMPTY });
  for (const slot of Object.keys(SLOT_LAYER) as DrawSlot[]) {
    if (!map.getLayer(SLOT_LAYER[slot])) {
      map.addLayer(layerSpec(slot), beforeIdFor(map, SLOT_LAYER[slot]));
    }
  }
}

function render(map: MlMap): void {
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (!src) return;
  const { features } = useStore.getState().draw;
  // The live stroke previews as one more line while the finger is down.
  const styleId = activeLineStyle();
  const live = stroke && styleId ? { coords: stroke, styleId } : null;
  // Marks are laid out in screen distance for this zoom, only where visible.
  const b = map.getBounds();
  const view = {
    zoom: map.getZoom(),
    bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] as [number, number, number, number],
  };
  src.setData({ type: 'FeatureCollection', features: drawSourceFeatures(features, view, live) });
}

/**
 * A scanned share's drawings replace the fire's marks as ONE undoable edit:
 * Undo brings the device's own marks back, Redo puts the shared ones in
 * again. It waits until this fire's saved marks have hydrated, so the undo
 * step holds them and not an empty set.
 */
function applySharedDrawings(): void {
  const { share, actions } = useStore.getState();
  const p = share.pending;
  if (!p?.drawings || p.corneaId !== hydratedFor) return;
  actions.settleShared('drawings'); // first: drawCommit re-enters the subscription
  actions.drawCommit(p.drawings);
}

function setCursor(map: MlMap): void {
  const tool = useStore.getState().draw.tool;
  const style = map.getCanvas().style;
  style.cursor = tool === 'none' ? '' : 'crosshair';
  // A picked symbol rides the pointer on desktop, centred where it will land.
  const sym = tool.startsWith('marker:') ? drawSymbolById(tool.slice('marker:'.length)) : undefined;
  // Each assignment is a fallback for the next: a browser that can't parse
  // the image-set form keeps the plain image cursor (or the crosshair).
  if (sym) for (const css of symbolCursor(sym, () => setCursor(map))) style.cursor = css;
}

// ---------- interactions ----------

function onClick(map: MlMap, e: MapMouseEvent): void {
  const { draw, actions } = useStore.getState();
  const tool = draw.tool;
  if (tool.startsWith('marker:')) {
    const sym = drawSymbolById(tool.slice('marker:'.length));
    if (!sym) return;
    const f: DrawFeature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] },
      properties: {
        fid: nextFid(),
        kind: 'marker',
        sym: sym.id,
        // upright on screen now; keeps this heading as the map turns
        ...(sym.rotatesWithMap ? { rot: map.getBearing() } : {}),
      },
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
      { layers: DRAW_LAYERS.filter((l) => !!map.getLayer(l)) },
    );
    const hitFid = hits.map((h) => h.properties?.fid as string | undefined).find(Boolean);
    if (hitFid) {
      actions.drawCommit(draw.features.filter((f) => f.properties.fid !== hitFid));
    }
  }
}

function activeLineStyle(): string | null {
  const tool = useStore.getState().draw.tool;
  if (tool === 'freehand') return 'sketch';
  if (tool.startsWith('line:')) return tool.slice('line:'.length);
  return null;
}

/**
 * Only a plain left-button drag or a one-finger drag draws. MapLibre rotates
 * and pitches on right-drag or ctrl + left-drag, and a second finger turns the
 * touch into a pinch — those stay map navigation (a stroke already under way
 * is dropped when the second finger lands).
 */
function isDrawGesture(map: MlMap, e: MapMouseEvent | MapTouchEvent): boolean {
  const ev = e.originalEvent;
  if ('touches' in ev) {
    if (ev.touches.length === 1) return true;
    if (stroke) {
      stroke = null;
      render(map);
    }
    return false;
  }
  return ev.button === 0 && !ev.ctrlKey;
}

function strokeStart(map: MlMap, e: MapMouseEvent | MapTouchEvent): void {
  if (!activeLineStyle() || !isDrawGesture(map, e)) return;
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
  const style = drawLineById(activeLineStyle() ?? undefined);
  if (pts.length > 1 && style) {
    const { draw, actions } = useStore.getState();
    const f: DrawFeature = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: pts },
      properties: { fid: nextFid(), kind: 'line', style: style.id },
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
    preloadPointIcons();

    const click = (e: MapMouseEvent) => onClick(map, e);
    const mdown = (e: MapMouseEvent) => strokeStart(map, e);
    const mmove = (e: MapMouseEvent) => strokeMove(map, e);
    const mup = () => strokeEnd(map);
    const tdown = (e: MapTouchEvent) => strokeStart(map, e);
    const tmove = (e: MapTouchEvent) => strokeMove(map, e);
    // Symbol images are drawn on demand (and again after a style swap drops them).
    const missing = (e: MapStyleImageMissingEvent) => provideDrawImage(map, e.id);
    // Line marks sit at on-screen spacing: lay them out again once the view
    // settles (zooming changes the spacing, panning reveals more line).
    const settled = () => {
      if (stroke || useStore.getState().draw.features.some((f) => f.properties.kind === 'line')) {
        render(map);
      }
    };
    map.on('click', click);
    map.on('mousedown', mdown);
    map.on('mousemove', mmove);
    map.on('mouseup', mup);
    map.on('touchstart', tdown);
    map.on('touchmove', tmove);
    map.on('touchend', mup);
    map.on('styleimagemissing', missing);
    map.on('moveend', settled);

    // Self-driven: draw-slice changes re-render without a LayerContext pass.
    unsubscribe = useStore.subscribe((state, prev) => {
      const gone = map as unknown as { style?: unknown; _removed?: boolean };
      if (gone._removed || !gone.style) return; // map died — unmount releases us
      if (state.draw !== prev.draw) {
        lastRenderedFeatures = state.draw.features;
        render(map);
        setCursor(map);
        const cid = state.view.mode === 'fire' ? state.view.corneaId : null;
        if (cid && state.draw.features !== prev.draw.features) {
          persist(cid, state.draw.features);
        }
      }
      if (state.share.pending !== prev.share.pending) applySharedDrawings();
    });

    const handlers = { click, mdown, mmove, mup, tdown, tmove, missing, settled };
    (map as unknown as { __rdDrawHandlers?: typeof handlers }).__rdDrawHandlers = handlers;
  },

  update(map, ctx) {
    ensureLayers(map);
    // Hydrate persisted annotations once per fire.
    const cid = ctx.view.mode === 'fire' ? ctx.view.corneaId : null;
    if (cid && hydratedFor !== cid) {
      hydratedFor = cid;
      useStore.getState().actions.drawHydrate(loadPersisted(cid));
      applySharedDrawings();
    }
    // ctx ticks every playback frame — only re-render when the draw slice
    // actually changed (the store subscription covers live edits).
    const features = useStore.getState().draw.features;
    if (features !== lastRenderedFeatures) {
      lastRenderedFeatures = features;
      render(map);
      setCursor(map);
    }
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
      map.off('styleimagemissing', h.missing);
      map.off('moveend', h.settled);
    }
    for (const l of [...DRAW_LAYERS].reverse()) {
      if (map.getLayer(l)) map.removeLayer(l);
    }
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
