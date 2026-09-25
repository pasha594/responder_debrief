/**
 * IR flight heat, fetched lazily per flight (module-cached by URL), drawn in
 * the NIROPS IR PDF's own symbology (irHeatImages.ts) so the overlay and the
 * PDF read the same: red heat perimeter, red-hatched intense heat, red-dotted
 * scattered heat, grey crosshatched cloud cover / no data (under the heat),
 * ringed red isolated heat sources and red possible-heat diamonds.
 */
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { dataUrl } from '../../api/catalogs';
import { beforeIdFor } from '../zOrder';
import type { LayerManager } from '../layerTypes';
import { IR_GREY, IR_IMAGES, IR_RED, installIrHeatImages } from './irHeatImages';

const SRC = 'rd-ir-heat';
const FILL = 'rd-ir-heat-fill';
const LINE = 'rd-ir-heat-line';
const PT = 'rd-ir-heat-pt';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const HEAT = ['get', 'heat_type'] as ExpressionSpecification;
const IS_POLYGON = ['==', ['geometry-type'], 'Polygon'] as ExpressionSpecification;

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
    installIrHeatImages(map);
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: EMPTY_FC });
    }
    if (!map.getLayer(FILL)) {
      map.addLayer(
        {
          id: FILL,
          type: 'fill',
          source: SRC,
          // polygons only: MapLibre fills a point feature as one ring through
          // all its points, and NIROPS isolated heat is a single 400+ point
          // MultiPoint — unfiltered, it paints wedges between the dots
          filter: [
            'all',
            IS_POLYGON,
            ['match', HEAT, ['Intense', 'Scattered', 'Obscured'], true, false],
          ],
          // cloud cover / no data sits under the heat it may overlap
          layout: { 'fill-sort-key': ['match', HEAT, 'Obscured', 0, 1] },
          paint: {
            'fill-pattern': [
              'match',
              HEAT,
              'Intense', IR_IMAGES.intense,
              'Scattered', IR_IMAGES.scattered,
              IR_IMAGES.obscured,
            ],
          },
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
          filter: [
            'all',
            IS_POLYGON,
            ['match', HEAT, ['Perimeter', 'Intense', 'Scattered', 'Obscured'], true, false],
          ],
          paint: {
            'line-color': ['match', HEAT, 'Obscured', IR_GREY, IR_RED],
            // the PDF's weights: heavy perimeter + no-data box, thin heat edges
            'line-width': ['match', HEAT, 'Perimeter', 2.5, 'Obscured', 2, 1],
          },
        },
        beforeIdFor(map, 'rd-ir-heat-line'),
      );
    }
    if (!map.getLayer(PT)) {
      // KMZ products publish isolated (and possible) heat as point
      // placemarks; every point draws, overlapping or not
      map.addLayer(
        {
          id: PT,
          type: 'symbol',
          source: SRC,
          filter: ['==', ['geometry-type'], 'Point'],
          layout: {
            'icon-image': ['match', HEAT, 'Possible', IR_IMAGES.possible, IR_IMAGES.isolated],
            // full PDF size close in; smaller at fire-wide zooms, where 400+
            // full-size sources would bury the heat areas under them
            'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 13, 0.75, 14.5, 1],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
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
