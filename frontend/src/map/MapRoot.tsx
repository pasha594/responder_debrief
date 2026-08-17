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
import { BASEMAP_STYLE_DARK, BASEMAP_STYLE_LIGHT } from '../app/config';
import { useStore } from '../state/store';
import { ensureOrder } from './zOrder';

const MapCtx = createContext<MlMap | null>(null);

/** Null until the map's style has loaded. */
export function useMap(): MlMap | null {
  return useContext(MapCtx);
}

/**
 * Cornea-flavored paint overrides applied on top of the OpenFreeMap styles —
 * tint the basemap toward the plum-dark aesthetic without forking the style.
 */
const DARK_OVERRIDES: [string, string, unknown][] = [
  ['background', 'background-color', '#161313'],
  ['water', 'fill-color', '#292e38'],
];

function applyOverrides(map: MlMap, theme: 'dark' | 'light') {
  if (theme !== 'dark') return;
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

  // Create once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: theme === 'dark' ? BASEMAP_STYLE_DARK : BASEMAP_STYLE_LIGHT,
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
      applyOverrides(map, useStore.getState().ui.theme);
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

  // Theme swap: setStyle with transformStyle preserving rd- sources/layers.
  const themeRef = useRef(theme);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || themeRef.current === theme) return;
    themeRef.current = theme;
    map.setStyle(theme === 'dark' ? BASEMAP_STYLE_DARK : BASEMAP_STYLE_LIGHT, {
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
        };
      },
    });
    map.once('idle', () => {
      applyOverrides(map, theme);
      ensureOrder(map);
    });
  }, [theme]);

  // The provider wraps siblings of the map div (sidebar, timeline, tabs need
  // useMap() for fitBounds etc.), so children position against .rd-app.
  return (
    <MapCtx.Provider value={ready}>
      <div className="rd-map-root" ref={containerRef} />
      {children}
    </MapCtx.Provider>
  );
}
