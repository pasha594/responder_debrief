/**
 * The single integration point: assembles LayerContext from store + queries
 * and drives every layer manager's update(). One subscription, cheap diffs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import { useMap } from './MapRoot';
import { useStore } from '../state/store';
import {
  latestRun,
  latestWeatherRun,
  useFire,
  useFires,
  useHotspots,
  useIncidentManifest,
  useInvalidateForecasts,
  useMasterCatalog,
  usePerimeterIndex,
  usePerimeterVersion,
  usePrefetchPerimeterNeighbors,
  usePyrecastRuns,
  useWeatherRuns,
} from '../api/queries';
import { useFireHotspots } from '../api/useFireHotspots';
import { HOTSPOT_BBOX_SNAP_DEG, HOTSPOT_NATIONAL_MIN_ZOOM } from '../app/config';
import {
  boundsToLatFirst,
  parseFireCoordinates,
  snapBoundsOut,
  type Bounds4326,
} from '../api/geo';
import { resolvePerimeterVersion } from '../timeline/framePlan';
import type { LayerContext, LayerManager } from './layerTypes';

import { firePinsLayer } from './layers/firePinsLayer';
import { perimeterLayer } from './layers/perimeterLayer';
import { hotspotLayer } from './layers/hotspotLayer';
import { spreadForecastLayer } from './layers/spreadForecastLayer';
import { weatherLayers } from './layers/weatherLayers';
import { windArrowsLayer } from './layers/windArrowsLayer';
import { incidentMapLayer } from './layers/incidentMapLayer';
import { labelContrastLayer } from './layers/labelContrast';
import { basemapUnderlay } from './layers/basemapUnderlay';
import { drawLayer } from './layers/drawLayer';
import { terrainControl } from './layers/terrainControl';
import { irHeatLayer } from './layers/irHeatLayer';

// The directory pivot retired nationalPerimetersLayer: the map now only ever
// shows one incident, so the CONUS perimeter raster has nowhere to render.
const MANAGERS: LayerManager[] = [
  basemapUnderlay,
  weatherLayers,
  incidentMapLayer,
  spreadForecastLayer,
  windArrowsLayer,
  irHeatLayer,
  perimeterLayer,
  hotspotLayer,
  firePinsLayer,
  drawLayer,
  terrainControl,
  labelContrastLayer, // paints no layers of its own — tunes basemap halos
];

/** Track the viewport as a grid-snapped Bounds4326 (fallback hotspot query). */
function useViewportBounds(map: MlMap | null): { bounds: Bounds4326; zoom: number } | null {
  const [vp, setVp] = useState<{ bounds: Bounds4326; zoom: number } | null>(null);
  useEffect(() => {
    if (!map) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const b = map.getBounds();
      setVp({
        bounds: snapBoundsOut(
          [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
          HOTSPOT_BBOX_SNAP_DEG,
        ),
        zoom: map.getZoom(),
      });
    };
    const onMove = () => {
      clearTimeout(timer);
      timer = setTimeout(read, 400);
    };
    read();
    map.on('moveend', onMove);
    return () => {
      clearTimeout(timer);
      map.off('moveend', onMove);
    };
  }, [map]);
  return vp;
}

/**
 * False once maplibre's `remove()` has run: the map object survives but its
 * style is gone, so every getLayer/removeSource call throws.
 */
function isMapUsable(map: MlMap): boolean {
  const internals = map as unknown as { _removed?: boolean; style?: unknown };
  return !internals._removed && !!internals.style;
}

export function useMapLayerSync(): void {
  const map = useMap();
  const view = useStore((s) => s.view);
  const layers = useStore((s) => s.layers);
  const currentTime = useStore((s) => s.time.currentTime);
  const now = useStore((s) => s.time.now);
  const actions = useStore((s) => s.actions);
  const invalidateForecasts = useInvalidateForecasts();

  const corneaId = view.mode === 'fire' ? view.corneaId : null;

  const { data: fires } = useFires();
  const { data: selectedFire } = useFire(corneaId);
  const { data: perimeterIndex } = usePerimeterIndex(corneaId);
  const { data: catalog } = useMasterCatalog();
  const { data: pyrecastRuns } = usePyrecastRuns();
  const { data: weatherRuns } = useWeatherRuns();

  const catalogFire = useMemo(
    () => catalog?.fires.find((f) => f.cornea_id === corneaId) ?? null,
    [catalog, corneaId],
  );
  const selectedFireSlug = catalogFire?.fire_slug ?? selectedFire?.unique_slug ?? null;

  const spreadRun = useMemo(
    () => latestRun(pyrecastRuns, selectedFireSlug),
    [pyrecastRuns, selectedFireSlug],
  );
  const weatherRun = useMemo(() => latestWeatherRun(weatherRuns), [weatherRuns]);

  const { data: incidentManifest } = useIncidentManifest(
    catalogFire?.incident_manifest ?? null,
  );

  // Perimeter version resolved for the scrub time, fetched via verbatim path.
  const versionItem = useMemo(
    () => resolvePerimeterVersion(perimeterIndex, currentTime),
    [perimeterIndex, currentTime],
  );
  const { data: perimeterFeature } = usePerimeterVersion(versionItem?.path ?? null);
  // Scrubbing crosses version boundaries constantly — keep the neighbors warm.
  usePrefetchPerimeterNeighbors(perimeterIndex, versionItem?.path ?? null);

  // Hotspots: fire mode goes through the archive-aware hook — the SAME
  // cache entry the timeline throughline reads, so the map and the sparkline
  // share one download (archive chunks when advertised, paged API when not).
  // The timeline needs the data even when the layer is hidden, so there is
  // nothing to save by gating the fetch on visibility. The viewport query
  // stays as a guard for the retired national mode.
  const vp = useViewportBounds(map);
  const { data: fireHotspots } = useFireHotspots(view.mode === 'fire' ? corneaId : null);
  const viewportQuery = useMemo(() => {
    if (view.mode === 'fire' || !layers.hotspots.visible) return null;
    if (!vp || vp.zoom < HOTSPOT_NATIONAL_MIN_ZOOM) return null;
    return { bbox: boundsToLatFirst(vp.bounds) };
  }, [layers.hotspots.visible, view.mode, vp]);
  const { data: viewportHotspots } = useHotspots(viewportQuery);
  const hotspots = view.mode === 'fire' ? fireHotspots : viewportHotspots;

  const ctx: LayerContext = useMemo(
    () => ({
      view,
      layers,
      currentTime,
      now,
      fires,
      selectedFire,
      selectedFireSlug,
      perimeterIndex,
      perimeterFeature,
      hotspots,
      catalog,
      spreadRun,
      weatherRun,
      incidentManifest,
      onSelectFire: actions.selectFire,
      onFrameError: () => {
        invalidateForecasts();
        actions.showToast('Forecast updated to a newer run — reloading');
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      view,
      layers,
      currentTime,
      now,
      fires,
      selectedFire,
      selectedFireSlug,
      perimeterIndex,
      perimeterFeature,
      hotspots,
      catalog,
      spreadRun,
      weatherRun,
      incidentManifest,
    ],
  );

  // Mount managers once per map instance.
  const mountedOn = useRef<MlMap | null>(null);
  useEffect(() => {
    if (!map || mountedOn.current === map) return;
    mountedOn.current = map;
    for (const m of MANAGERS) m.mount(map);
    return () => {
      if (mountedOn.current !== map) return;
      mountedOn.current = null;
      // Leaving fire mode deletes this whole subtree, and the style may be
      // gone by the time we get here (MapRoot's map.remove() can precede us).
      // Managers must STILL unmount: several hold store subscriptions and
      // map/DOM listeners, and a leaked subscription later rendering into a
      // removed map crashes the NEXT map ("reading 'getSource'" on first
      // fire entry). Style-touching teardown throws harmlessly into the
      // per-manager catch.
      for (const m of MANAGERS) {
        try {
          m.unmount(map);
        } catch {
          /* style vanished mid-teardown */
        }
      }
    };
  }, [map]);

  // Drive updates. A ctx tick can land after map.remove() mid-transition —
  // updating a dead map throws deep inside maplibre, so gate on usability.
  useEffect(() => {
    if (!map || mountedOn.current !== map || !isMapUsable(map)) return;
    for (const m of MANAGERS) m.update(map, ctx);
  }, [map, ctx]);

  // Fly to the selected fire when it changes.
  const flownTo = useRef<string | null>(null);
  useEffect(() => {
    if (!map) return;
    if (view.mode !== 'fire') {
      flownTo.current = null;
      return;
    }
    if (flownTo.current === view.corneaId) return;
    const target = spreadRun?.bbox ?? null;
    if (target) {
      flownTo.current = view.corneaId;
      map.fitBounds(
        [
          [target[0], target[1]],
          [target[2], target[3]],
        ],
        { padding: { top: 60, bottom: 120, left: 60, right: 420 }, duration: 1200 },
      );
      return;
    }
    const center =
      spreadRun?.centroid ??
      catalogFire?.coordinates ??
      parseFireCoordinates(
        fires?.fires.find((x) => x.cornea_id === view.corneaId)?.fire_coordinates,
      );
    if (center) {
      flownTo.current = view.corneaId;
      map.flyTo({ center, zoom: 10, duration: 1200 });
    }
  }, [map, view, spreadRun, catalogFire, fires]);
}
