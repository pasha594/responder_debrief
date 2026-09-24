/**
 * Natural-feature labels for the vector basemap: rivers and creeks, lakes,
 * peaks with their elevation, passes, ridges, and national forest /
 * wilderness names — the geography a crew navigates by.
 *
 * Every style variant's tiles (CARTO and OpenFreeMap both serve the
 * OpenMapTiles schema) already carry these features, but the stock styles
 * draw few of them: Dark Matter labels big rivers and lakes only, and no
 * variant labels peaks or ridges. So after each style load, MapRoot adds one
 * shared label set on the style's own vector source (no second download),
 * and the style's own water labels step aside so nothing is labeled twice
 * and every variant reads the same.
 *
 * These are basemap layers — no rd- prefix — on purpose: a style swap drops
 * them with the old style (they point at its source) and MapRoot re-adds
 * them; Topo hides them with the rest of the vector basemap (USGS topo has
 * its own); the satellite hybrid keeps them, like its road labels.
 */
import type {
  ExpressionSpecification,
  FilterSpecification,
  Map as MlMap,
  SymbolLayerSpecification,
} from 'maplibre-gl';
import { PEAK_IMAGE, installMarkerImages } from './markerImages';

export const NATURAL_LABEL_PREFIX = 'nat-';

type Theme = 'dark' | 'light';

const PALETTE: Record<Theme, { water: string; terrain: string; park: string; halo: string }> = {
  dark: {
    water: '#8fb1d1',
    terrain: '#d4c7ab',
    park: '#93b08c',
    halo: 'rgba(10, 10, 10, 0.85)',
  },
  light: {
    water: '#34679b',
    terrain: '#6b5236',
    park: '#46703f',
    halo: 'rgba(255, 255, 255, 0.92)',
  },
};

/**
 * Font stacks per glyph host. CARTO serves Montserrat/Open Sans composite
 * stacks (these are Dark Matter's own, so the glyph requests are shared);
 * OpenFreeMap serves single Noto faces and 404s on composites.
 */
function fonts(map: MlMap): { regular: string[]; italic: string[] } {
  const glyphs = map.getStyle()?.glyphs ?? '';
  if (glyphs.includes('openfreemap')) {
    return { regular: ['Noto Sans Regular'], italic: ['Noto Sans Italic'] };
  }
  const cjk = ['Noto Sans Regular', 'HanWangHeiLight Regular', 'NanumBarunGothic Regular'];
  return {
    regular: ['Montserrat Regular', 'Open Sans Regular', ...cjk],
    italic: ['Montserrat Regular Italic', 'Open Sans Italic', ...cjk],
  };
}

/** The style's OpenMapTiles vector source (`carto` / `openmaptiles`). */
export function basemapVectorSource(map: MlMap): string | undefined {
  const sources = map.getStyle()?.sources ?? {};
  return Object.keys(sources).find((id) => !id.startsWith('rd-') && sources[id].type === 'vector');
}

const isPoint: ExpressionSpecification = ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false];
const isLine: ExpressionSpecification = [
  'match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false,
];
const classIn = (...classes: string[]): ExpressionSpecification => [
  'match', ['get', 'class'], classes, true, false,
];
const named: ExpressionSpecification = ['has', 'name'];

/** Linear zoom ramp for a size: [zoom, value, zoom, value, …]. */
const ramp = (...stops: (number | ExpressionSpecification)[]): ExpressionSpecification =>
  ['interpolate', ['linear'], ['zoom'], ...stops] as ExpressionSpecification;

/** "Mount Hood" over a smaller "11,250 ft" when the peak has an elevation. */
const PEAK_TEXT: ExpressionSpecification = [
  'case',
  ['has', 'ele_ft'],
  [
    'format',
    ['get', 'name'], {},
    '\n', {},
    ['concat', ['number-format', ['get', 'ele_ft'], { locale: 'en-US', 'max-fraction-digits': 0 }], ' ft'],
    { 'font-scale': 0.85 },
  ],
  ['get', 'name'],
];

/** Bottom → top; higher layers win label collisions. */
export function naturalLabelLayers(
  source: string,
  theme: Theme,
  font: { regular: string[]; italic: string[] },
): SymbolLayerSpecification[] {
  const c = PALETTE[theme];
  const halo = { 'text-halo-color': c.halo, 'text-halo-width': 1.2, 'text-halo-blur': 0.3 };
  const layer = (
    id: string,
    sourceLayer: string,
    filter: FilterSpecification,
    minzoom: number,
    layout: SymbolLayerSpecification['layout'],
    paint: SymbolLayerSpecification['paint'],
  ): SymbolLayerSpecification => ({
    id: NATURAL_LABEL_PREFIX + id,
    type: 'symbol',
    source,
    'source-layer': sourceLayer,
    minzoom,
    filter,
    layout,
    paint: { ...halo, ...paint },
  });
  // The always-on 3D terrain bends a line's projected path wherever it
  // climbs, so creeks and ridges in steep country read as too kinked for the
  // usual 30° and never get a label. 80° places them (Mount Hood's creeks go
  // from none to all at z13) and they still read cleanly.
  const alongLine = {
    'symbol-placement': 'line',
    'text-max-angle': 80,
    'text-keep-upright': true,
  } as const;

  return [
    // National forests, wilderness, parks: the region names.
    layer('park', 'park', ['all', isPoint, named], 7, {
      'text-field': ['get', 'name'],
      'text-font': font.regular,
      'text-size': ramp(7, 10, 12, 12),
      'text-max-width': 8,
      'text-letter-spacing': 0.04,
    }, { 'text-color': c.park }),

    // Lakes, reservoirs, bays — big lakes also come as a centerline.
    layer('water-point', 'water_name', ['all', isPoint, named], 0, {
      'text-field': ['get', 'name'],
      'text-font': font.italic,
      // zoom must be the outermost expression, so the class match nests inside
      'text-size': ramp(
        6, ['match', ['get', 'class'], 'ocean', 15, 'sea', 13, 10],
        14, ['match', ['get', 'class'], 'ocean', 15, 'sea', 13, 13],
      ),
      'text-max-width': 6,
      'text-letter-spacing': 0.06,
    }, { 'text-color': c.water }),
    layer('water-line', 'water_name', ['all', isLine, named], 0, {
      ...alongLine,
      'text-field': ['get', 'name'],
      'text-font': font.italic,
      'text-size': ramp(6, 10, 14, 13),
      'text-letter-spacing': 0.1,
    }, { 'text-color': c.water }),

    // Creeks from z12, rivers from z8.
    layer('stream', 'waterway', ['all', isLine, named, classIn('stream', 'canal')], 12, {
      ...alongLine,
      'text-field': ['get', 'name'],
      'text-font': font.italic,
      'text-size': ramp(12, 10.5, 16, 12.5),
      'text-letter-spacing': 0.06,
      'symbol-spacing': 300,
    }, { 'text-color': c.water }),
    layer('river', 'waterway', ['all', isLine, named, classIn('river')], 8, {
      ...alongLine,
      'text-field': ['get', 'name'],
      'text-font': font.italic,
      'text-size': ramp(8, 10.5, 14, 13),
      'text-letter-spacing': 0.08,
      'symbol-spacing': 350,
    }, { 'text-color': c.water }),

    // Named ridges and aretes, set along the crest.
    layer('ridge', 'mountain_peak', ['all', isLine, named, classIn('ridge', 'arete')], 12, {
      ...alongLine,
      'text-field': ['get', 'name'],
      'text-font': font.regular,
      'text-size': ramp(12, 10, 16, 11.5),
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.18,
      'symbol-spacing': 300,
    }, { 'text-color': c.terrain, 'text-opacity': 0.9 }),

    // Passes and saddles.
    layer('saddle', 'mountain_peak', ['all', isPoint, named, classIn('saddle')], 12, {
      'text-field': ['get', 'name'],
      'text-font': font.italic,
      'text-size': 10.5,
      'text-max-width': 7,
    }, { 'text-color': c.terrain }),

    // Summits: triangle + name + elevation; the highest win collisions.
    layer('peak', 'mountain_peak', ['all', isPoint, named, classIn('peak', 'volcano')], 9, {
      'symbol-sort-key': ['-', 0, ['to-number', ['get', 'ele'], 0]],
      'icon-image': PEAK_IMAGE,
      'icon-size': ramp(9, 0.8, 14, 1),
      'text-field': PEAK_TEXT,
      'text-font': font.regular,
      'text-size': ramp(9, 10, 14, 12),
      'text-variable-anchor': ['top', 'bottom', 'right', 'left'],
      'text-radial-offset': 0.7,
      'text-justify': 'auto',
      'text-max-width': 8,
      'text-line-height': 1.15,
    }, {
      'text-color': c.terrain,
      'icon-color': c.terrain,
      'icon-halo-color': c.halo,
      'icon-halo-width': 1,
    }),
  ];
}

/**
 * Put the natural labels on the freshly loaded style. Idempotent; a no-op
 * on a style without a vector source (the offline ground).
 */
export function addNaturalLabels(map: MlMap, theme: Theme): void {
  const source = basemapVectorSource(map);
  if (!source) return;
  const style = map.getStyle();
  // The style's own water labels would double ours (and differ per variant).
  for (const l of style.layers) {
    if (l.type !== 'symbol' || l.id.startsWith('rd-') || l.id.startsWith(NATURAL_LABEL_PREFIX)) continue;
    const sourceLayer = l['source-layer'];
    if (sourceLayer === 'waterway' || sourceLayer === 'water_name') map.removeLayer(l.id);
  }
  installMarkerImages(map);
  // Below the style's place and road labels, which keep their priority.
  const anchor = map.getStyle().layers.find(
    (l) => l.type === 'symbol' && !l.id.startsWith('rd-') && !l.id.startsWith(NATURAL_LABEL_PREFIX),
  )?.id;
  for (const l of naturalLabelLayers(source, theme, fonts(map))) {
    if (!map.getLayer(l.id)) map.addLayer(l, anchor);
  }
}
