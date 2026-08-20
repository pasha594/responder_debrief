/**
 * IR flight heat polygons, fetched lazily per flight (module-cached by URL).
 * Heat classes tint the fill; the flight's mapped perimeter renders as an
 * outline only.
 */
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { dataUrl } from '../../api/catalogs';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';

const SRC = 'rd-ir-heat';
const FILL = 'rd-ir-heat-fill';
const LINE = 'rd-ir-heat-line';
const PT = 'rd-ir-heat-pt';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const FILL_COLOR: ExpressionSpecification = [
  'match',
  ['get', 'heat_type'],
  'Intense', '#ff3b1f',
  'Scattered', '#ff8c00',
  'Isolated', '#ffd166',
  'Perimeter', 'rgba(0,0,0,0)',
  'rgba(0,0,0,0)',
];

const FILL_OPACITY: ExpressionSpecification = [
  'match',
  ['get', 'heat_type'],
  'Intense', 0.5,
  'Scattered', 0.4,
  'Isolated', 0.4,
  0,
];

// In-module cache: IR flight geojsons are immutable snapshots.
const geojsonCache = new Map<string, GeoJSON.FeatureCollection | GeoJSON.Feature>();
const inFlight = new Set<string>();

let appliedUrl: string | null = null; // url whose data is currently in the source
let wantedUrl: string | null = null; // url we should be showing

function setSourceData(map: MlMap, data: GeoJSON.FeatureCollection | GeoJSON.Feature): void {
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  src?.setData(data);
}

function fetchAndApply(map: MlMap, url: string): void {
  if (inFlight.has(url)) return;
  inFlight.add(url);
  fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`ir geojson ${res.status}`);
      return res.json() as Promise<GeoJSON.FeatureCollection>;
    })
    .then((fc) => {
      geojsonCache.set(url, fc);
      if (wantedUrl === url && map.getSource(SRC)) {
        appliedUrl = url;
        setSourceData(map, fc);
      }
    })
    .catch(() => {
      // Leave the source empty; a retoggle retries the fetch.
    })
    .finally(() => {
      inFlight.delete(url);
    });
}

export const irHeatLayer: LayerManager = {
  mount(map) {
    appliedUrl = null;
    wantedUrl = null;
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: EMPTY_FC });
    }
    if (!map.getLayer(FILL)) {
      map.addLayer(
        {
          id: FILL,
          type: 'fill',
          source: SRC,
          paint: { 'fill-color': FILL_COLOR, 'fill-opacity': FILL_OPACITY },
        },
        beforeIdFor(map, 'rd-ir-heat-fill'),
      );
    }
    if (!map.getLayer(LINE)) {
      map.addLayer(
        {
          id: LINE,
          type: 'line',
          source: SRC,
          filter: ['==', ['get', 'heat_type'], 'Perimeter'],
          paint: { 'line-color': '#ff6467', 'line-width': 2 },
        },
        beforeIdFor(map, 'rd-ir-heat-line'),
      );
    }
    if (!map.getLayer(PT)) {
      // some IR products publish Isolated/Scattered heat as point
      // placemarks (KMZ) rather than polygons — draw those as dots
      map.addLayer(
        {
          id: PT,
          type: 'circle',
          source: SRC,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 3.5,
            'circle-color': FILL_COLOR,
            'circle-opacity': 0.9,
            'circle-stroke-width': 0.5,
            'circle-stroke-color': 'rgba(0,0,0,0.4)',
          },
        },
        beforeIdFor(map, 'rd-ir-heat-pt' as never),
      );
    }
  },

  update(map, ctx) {
    if (!map.getSource(SRC)) return;

    const flightId = ctx.layers.irFlight.flightId;
    const flight = flightId
      ? ctx.incidentManifest?.ir_flights.find((f) => f.flight_id === flightId)
      : null;
    const url = flight?.geojson_url ? dataUrl(flight.geojson_url) : null;

    if (url === wantedUrl) return;
    wantedUrl = url;

    if (!url) {
      if (appliedUrl !== null) {
        appliedUrl = null;
        setSourceData(map, EMPTY_FC);
      }
      return;
    }

    const cached = geojsonCache.get(url);
    if (cached) {
      appliedUrl = url;
      setSourceData(map, cached);
      return;
    }
    // Clear stale polygons while the new flight loads.
    if (appliedUrl !== null) {
      appliedUrl = null;
      setSourceData(map, EMPTY_FC);
    }
    fetchAndApply(map, url);
  },

  unmount(map) {
    appliedUrl = null;
    wantedUrl = null;
    if (map.getLayer(PT)) map.removeLayer(PT);
    if (map.getLayer(LINE)) map.removeLayer(LINE);
    if (map.getLayer(FILL)) map.removeLayer(FILL);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },
};
