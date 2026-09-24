/**
 * The natural-label set rides on the active style's own vector source, sits
 * under the style's place/road labels, and replaces the style's water labels
 * (so rivers and lakes are never labeled twice).
 */
import { describe, expect, it } from 'vitest';
import type { Map as MlMap, SymbolLayerSpecification } from 'maplibre-gl';
import { NATURAL_LABEL_PREFIX, addNaturalLabels } from './naturalLabels';

type Layer = { id: string; type: string; source?: string; 'source-layer'?: string; layout?: Record<string, unknown> };

function fakeMap(opts: { sources: Record<string, { type: string }>; glyphs: string; layers: Layer[] }) {
  let layers = opts.layers.slice();
  const map = {
    getStyle: () => ({ sources: opts.sources, glyphs: opts.glyphs, layers }),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    addLayer: (l: SymbolLayerSpecification, beforeId?: string) => {
      const at = beforeId ? layers.findIndex((x) => x.id === beforeId) : layers.length;
      layers.splice(at, 0, l as unknown as Layer);
    },
    removeLayer: (id: string) => {
      layers = layers.filter((l) => l.id !== id);
    },
    hasImage: () => true, // images need a DOM; marker images are covered elsewhere
    on: () => {},
    ids: () => layers.map((l) => l.id),
    layer: (id: string) => layers.find((l) => l.id === id),
  };
  return map as unknown as MlMap & { ids: () => string[]; layer: (id: string) => Layer | undefined };
}

const darkMatter = () =>
  fakeMap({
    sources: { carto: { type: 'vector' } },
    glyphs: 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
    layers: [
      { id: 'background', type: 'background' },
      { id: 'waterway', type: 'line', source: 'carto', 'source-layer': 'waterway' },
      { id: 'waterway_label', type: 'symbol', source: 'carto', 'source-layer': 'waterway' },
      { id: 'watername_lake', type: 'symbol', source: 'carto', 'source-layer': 'water_name' },
      { id: 'place_town', type: 'symbol', source: 'carto', 'source-layer': 'place' },
      { id: 'roadname_pri', type: 'symbol', source: 'carto', 'source-layer': 'transportation_name' },
      { id: 'rd-perimeter-fill', type: 'fill', source: 'rd-perimeter' },
    ],
  });

describe('addNaturalLabels', () => {
  it('replaces the style water labels and slots in under the place labels', () => {
    const map = darkMatter();
    addNaturalLabels(map, 'dark');
    const ids = map.ids();
    expect(ids).not.toContain('waterway_label');
    expect(ids).not.toContain('watername_lake');
    expect(ids).toContain('waterway'); // the river LINES stay
    const nat = ids.filter((id) => id.startsWith(NATURAL_LABEL_PREFIX));
    expect(nat).toEqual([
      'nat-park', 'nat-water-point', 'nat-water-line',
      'nat-stream', 'nat-river', 'nat-ridge', 'nat-saddle', 'nat-peak',
    ]);
    expect(ids.indexOf('nat-peak') + 1).toBe(ids.indexOf('place_town'));
    for (const id of nat) expect(map.layer(id)?.source).toBe('carto');
  });

  it('is idempotent', () => {
    const map = darkMatter();
    addNaturalLabels(map, 'dark');
    const once = map.ids();
    addNaturalLabels(map, 'dark');
    expect(map.ids()).toEqual(once);
  });

  it('uses the single Noto faces OpenFreeMap serves', () => {
    const map = fakeMap({
      sources: { openmaptiles: { type: 'vector' }, ne2_shaded: { type: 'raster' } },
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      layers: [{ id: 'place_town', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place' }],
    });
    addNaturalLabels(map, 'dark');
    expect(map.layer('nat-river')?.source).toBe('openmaptiles');
    expect(map.layer('nat-river')?.layout?.['text-font']).toEqual(['Noto Sans Italic']);
    expect(map.layer('nat-peak')?.layout?.['text-font']).toEqual(['Noto Sans Regular']);
  });

  it('leaves the offline ground (no vector source) alone', () => {
    const map = fakeMap({
      sources: {},
      glyphs: '',
      layers: [{ id: 'background', type: 'background' }],
    });
    addNaturalLabels(map, 'dark');
    expect(map.ids()).toEqual(['background']);
  });
});
