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
  usePyrecastRuns,
  useWeatherRuns,
} from '../api/queries';
import {
  HOTSPOT_BBOX_SNAP_DEG,
  HOTSPOT_HISTORY_MAX_DAYS,
  HOTSPOT_NATIONAL_MIN_ZOOM,
} from '../app/config';
import {
  boundsToLatFirst,
  padBounds,
  parseFireCoordinates,
  snapBoundsOut,
  type Bounds4326,
} from '../api/geo';
import { resolvePerimeterVersion } from '../timeline/framePlan';
import type { LayerContext, LayerManager } from './layerTypes';

import { firePinsLayer } from './layers/firePinsLayer';
import { perimeterLayer } from './layers/perimeterLayer';
import { nationalPerimetersLayer } from './layers/nationalPerimetersLayer';
import { hotspotLayer } from './layers/hotspotLayer';
import { spreadForecastLayer } from './layers/spreadForecastLayer';
import { weatherLayers } from './layers/weatherLayers';
import { incidentMapLayer } from './layers/incidentMapLayer';
import { irHeatLayer } from './layers/irHeatLayer';

const MANAGERS: LayerManager[] = [
  weatherLayers,
  incidentMapLayer,
  spreadForecastLayer,
  nationalPerimetersLayer,
  irHeatLayer,
  perimeterLayer,
  hotspotLayer,
  firePinsLayer,
];

/** Track the viewport as a grid-snapped Bounds4326 (national hotspot query). */
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

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
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

  // Hotspot query: fire mode = fixed bbox since discovery (capped);
  // national mode = viewport bbox, 7-day window, only at z >= 6.
  const vp = useViewportBounds(map);
  const hotspotQuery = useMemo(() => {
    if (!layers.hotspots.visible) return null;
    if (view.mode === 'fire') {
      const base: Bounds4326 | null = spreadRun
        ? spreadRun.bbox
        : catalogFire
          ? [
              catalogFire.coordinates[0] - 0.5,
              catalogFire.coordinates[1] - 0.4,
              catalogFire.coordinates[0] + 0.5,
              catalogFire.coordinates[1] + 0.4,
            ]
          : null;
      if (!base) return null;
      const created = selectedFire ? Date.parse(selectedFire.created_on) : NaN;
      const sinceDays = Number.isFinite(created)
        ? Math.min(HOTSPOT_HISTORY_MAX_DAYS, Math.ceil((Date.now() - created) / 864e5))
        : 7;
      return {
        bbox: boundsToLatFirst(snapBoundsOut(padBounds(base, 0.2), HOTSPOT_BBOX_SNAP_DEG)),
        since: daysAgoIso(sinceDays),
      };
    }
    if (!vp || vp.zoom < HOTSPOT_NATIONAL_MIN_ZOOM) return null;
    return { bbox: boundsToLatFirst(vp.bounds) };
  }, [layers.hotspots.visible, view.mode, spreadRun, catalogFire, selectedFire, vp]);

  const { data: hotspots } = useHotspots(hotspotQuery);

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
      for (const m of MANAGERS) m.unmount(map);
      mountedOn.current = null;
    };
  }, [map]);

  // Drive updates.
  useEffect(() => {
    if (!map || mountedOn.current !== map) return;
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
