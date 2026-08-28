/** Owns the single maplibregl.Map instance and exposes it via context. */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import maplibregl, { type Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapStyleDef } from '../app/config';
import { resyncBasemapUnderlay } from './layers/basemapUnderlay';
import { resyncLabelContrast } from './layers/labelContrast';
import { resyncRdLabelFonts } from './glyphFonts';
import { useStore } from '../state/store';
import { ensureOrder } from './zOrder';

const MapCtx = createContext<MlMap | null>(null);

/** Null until the map's style has loaded. */
export function useMap(): MlMap | null {
  return useContext(MapCtx);
}

/**
 * Cornea-flavored paint overrides applied on top of the classic OpenFreeMap
 * dark style — tint it toward the plum-dark aesthetic without forking it.
 * The alternate styles (Fiord, Dark Matter, …) keep their out-of-the-box look.
 */
const DARK_OVERRIDES: [string, string, unknown][] = [
  ['background', 'background-color', '#161313'],
  ['water', 'fill-color', '#292e38'],
];

function applyOverrides(map: MlMap, theme: 'dark' | 'light', styleId: string) {
  if (theme !== 'dark' || styleId !== 'dark') return;
  for (const [layerId, prop, value] of DARK_OVERRIDES) {
    if (map.getLayer(layerId)) {
      try {
        map.setPaintProperty(layerId, prop, value);
      } catch {
        /* style variant without this layer */
      }
    }
  }
}

export function MapRoot({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState<MlMap | null>(null);
  const theme = useStore((s) => s.ui.theme);
  const mapStylePref = useStore((s) => s.ui.mapStyle);
  const styleDef = mapStyleDef(theme, mapStylePref[theme]);

  // Create once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleDef.url,
      center: [-114, 41],
      zoom: 4.3,
      minZoom: 3,
      maxZoom: 17,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    mapRef.current = map;
    if (import.meta.env.DEV) {
      (window as unknown as { __rdMap: MlMap }).__rdMap = map;
    }
    // The map can be constructed before the container has layout (canvas
    // falls back to 400×300), and MapLibre's built-in trackResize does not
    // always recover. Own the resizing: observe the container ourselves and
    // nudge once after first layout.
    const ro = new ResizeObserver(() => {
      if (mapRef.current === map) map.resize();
    });
    ro.observe(containerRef.current);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (mapRef.current === map) map.resize();
    }));
    map.once('load', () => {
      const st = useStore.getState().ui;
      applyOverrides(map, st.theme, mapStyleDef(st.theme, st.mapStyle[st.theme]).id);
      setReady(map);
    });
    // Re-assert our layers after any style-swap settles.
    map.on('styledata', () => {
      if (map.isStyleLoaded()) ensureOrder(map);
    });
    return () => {
      ro.disconnect();
      mapRef.current = null;
      setReady(null);
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme/style swap: setStyle with transformStyle preserving rd- sources,
  // rd- layers, AND the terrain reference (the always-on 3D terrain rides on
  // the carried rd-dem source; without this the swap silently flattens it).
  const styleUrlRef = useRef(styleDef.url);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleUrlRef.current === styleDef.url) return;
    styleUrlRef.current = styleDef.url;
    map.setStyle(styleDef.url, {
      transformStyle: (prev, next) => {
        if (!prev) return next;
        const rdSources = Object.fromEntries(
          Object.entries(prev.sources ?? {}).filter(([id]) => id.startsWith('rd-')),
        );
        const rdLayers = (prev.layers ?? []).filter((l) => l.id.startsWith('rd-'));
        return {
          ...next,
          sources: { ...next.sources, ...rdSources },
          layers: [...next.layers, ...rdLayers],
          terrain: prev.terrain,
        };
      },
    });
    // 'idle' fires only after the new style fully loads, so a superseded
    // swap's handler must never win: the cleanup removes it when another
    // swap starts, and the handler reads the CURRENT store truth rather
    // than this render's closure.
    const onIdle = () => {
      if (mapRef.current !== map) return;
      const ui = useStore.getState().ui;
      const def = mapStyleDef(ui.theme, ui.mapStyle[ui.theme]);
      if (def.url !== styleUrlRef.current) return;
      applyOverrides(map, ui.theme, def.id);
      // satellite/topo hid the OLD style's layers — re-apply on the new one
      resyncBasemapUnderlay(map);
      resyncLabelContrast(map);
      resyncRdLabelFonts(map);
      ensureOrder(map);
    };
    map.once('idle', onIdle);
    return () => {
      map.off('idle', onIdle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleDef.url]);

  // The provider wraps siblings of the map div (sidebar, timeline, tabs need
  // useMap() for fitBounds etc.), so children position against .rd-app.
  return (
    <MapCtx.Provider value={ready}>
      <div className="rd-map-root" ref={containerRef} />
      {children}
    </MapCtx.Provider>
  );
}
