/**
 * The z-order contract, checked against a fake map: rasters stack
 * incident map < spread forecast < weather < basemap labels; vectors sit
 * above the labels. ensureOrder must reach that order from any starting
 * arrangement, since style swaps re-add layers in arbitrary sequence.
 */
import { describe, expect, it } from 'vitest';
import type { Map as MlMap } from 'maplibre-gl';
import { RD_LAYER_ORDER, beforeIdFor, ensureOrder } from './zOrder';

function fakeMap(initial: { id: string; type: string }[]) {
  let layers = initial.slice();
  let moves = 0;
  const map = {
    // like MapLibre, the serialized style leaves custom layers out…
    getStyle: () => ({ layers: layers.filter((l) => l.type !== 'custom') }),
    // …and getLayersOrder does not
    getLayersOrder: () => layers.map((l) => l.id),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    moveLayer: (id: string, beforeId?: string) => {
      moves += 1;
      const layer = layers.find((l) => l.id === id)!;
      layers = layers.filter((l) => l.id !== id);
      const at = beforeId ? layers.findIndex((l) => l.id === beforeId) : layers.length;
      layers.splice(at, 0, layer);
    },
    ids: () => layers.map((l) => l.id),
    moves: () => moves,
  };
  return map as unknown as MlMap & { ids: () => string[]; moves: () => number };
}

const basemap = [
  { id: 'water', type: 'fill' },
  { id: 'roads', type: 'line' },
  { id: 'place-labels', type: 'symbol' },
];

describe('RD_LAYER_ORDER', () => {
  it('stacks incident map below the forecast, and both below weather', () => {
    const idx = (id: string) => RD_LAYER_ORDER.indexOf(id as (typeof RD_LAYER_ORDER)[number]);
    expect(idx('rd-incident-map')).toBeLessThan(idx('rd-spread-forecast'));
    expect(idx('rd-spread-forecast')).toBeLessThan(idx('rd-weather-smoke-a'));
    expect(idx('rd-weather-smoke-a')).toBeLessThan(idx('rd-national-perimeters'));
    expect(idx('rd-national-perimeters')).toBeLessThan(idx('rd-perimeter-fill'));
  });

  it('puts vegetation at the bottom, trail lines under labels, route legs on top', () => {
    const idx = (id: string) => RD_LAYER_ORDER.indexOf(id as (typeof RD_LAYER_ORDER)[number]);
    const sentinel = idx('rd-national-perimeters');
    expect(idx('rd-vegetation')).toBe(0);
    for (const id of ['rd-trails-ways', 'rd-trails-casing', 'rd-trails-line']) {
      expect(idx(id)).toBeGreaterThan(idx('rd-weather-smoke-a'));
      expect(idx(id)).toBeLessThan(sentinel);
    }
    expect(idx('rd-trails-casing')).toBeLessThan(idx('rd-trails-line'));
    expect(idx('rd-trails-hit')).toBeGreaterThan(sentinel);
    expect(idx('rd-trails-hit')).toBeLessThan(idx('rd-perimeter-fill'));
    expect(idx('rd-route-line')).toBeLessThan(idx('rd-route-xc'));
    expect(RD_LAYER_ORDER[RD_LAYER_ORDER.length - 1]).toBe('rd-route-joins');
  });
});

describe('ensureOrder', () => {
  it('restores the canonical order from a scrambled style', () => {
    const map = fakeMap([
      ...basemap.slice(0, 2),
      { id: 'rd-weather-smoke-a', type: 'raster' },
      { id: 'rd-perimeter-fill', type: 'fill' },
      { id: 'rd-incident-map', type: 'raster' },
      basemap[2],
      { id: 'rd-spread-forecast', type: 'raster' },
      { id: 'rd-hotspots', type: 'symbol' },
    ]);
    ensureOrder(map);
    expect(map.ids()).toEqual([
      'water',
      'roads',
      'rd-incident-map',
      'rd-spread-forecast',
      'rd-weather-smoke-a',
      'place-labels',
      'rd-perimeter-fill',
      'rd-hotspots',
    ]);
  });

  it('touches nothing when the order is already canonical', () => {
    // moveLayer marks the style changed even for a no-op move, which re-fires
    // 'styledata', which runs ensureOrder again: moving unconditionally was an
    // endless redraw loop.
    const map = fakeMap([
      ...basemap.slice(0, 2),
      { id: 'rd-incident-map', type: 'raster' },
      { id: 'rd-weather-smoke-a', type: 'raster' },
      basemap[2],
      { id: 'rd-perimeter-fill', type: 'fill' },
      { id: 'rd-hotspots', type: 'circle' },
      { id: 'rd-hotspot-flames', type: 'custom' },
      { id: 'rd-fire-pins', type: 'symbol' },
    ]);
    const before = map.ids();
    ensureOrder(map);
    expect(map.moves()).toBe(0);
    expect(map.ids()).toEqual(before);
  });

  it('settles: a second pass after a fix-up moves nothing', () => {
    const map = fakeMap([
      { id: 'rd-fire-pins', type: 'symbol' },
      ...basemap,
      { id: 'rd-hotspot-flames', type: 'custom' },
      { id: 'rd-hotspots', type: 'circle' },
    ]);
    ensureOrder(map);
    expect(map.ids()).toEqual([
      'water',
      'roads',
      'place-labels',
      'rd-hotspots',
      'rd-hotspot-flames',
      'rd-fire-pins',
    ]);
    const after = map.moves();
    ensureOrder(map);
    expect(map.moves()).toBe(after);
  });
});

describe('beforeIdFor', () => {
  it('slots a new incident map under an existing forecast and weather layer', () => {
    const map = fakeMap([
      ...basemap,
      { id: 'rd-spread-forecast', type: 'raster' },
      { id: 'rd-weather-smoke-a', type: 'raster' },
    ]);
    expect(beforeIdFor(map, 'rd-incident-map')).toBe('rd-spread-forecast');
    expect(beforeIdFor(map, 'rd-weather-tmpf-a')).toBe('rd-weather-smoke-a');
    // Nothing of ours above it: cap at the first basemap label layer.
    expect(beforeIdFor(map, 'rd-weather-apcptot-b')).toBe('place-labels');
  });
});
