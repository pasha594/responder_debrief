import { describe, expect, it } from 'vitest';
import type { DrawFeature } from '../../state/store';
import {
  HALO_COLOR,
  HALO_PT,
  LINE_SLOTS,
  PX_PER_PT,
  drawSourceFeatures,
  lineImageId,
  patternTileMetrics,
  planStyle,
  plannedPartForImage,
} from './drawPlan';
import {
  DRAW_LINES,
  DRAW_LINE_GROUPS,
  DRAW_SYMBOLS,
  DRAW_SYMBOL_GROUPS,
  drawLineById,
  drawSymbolById,
} from './drawSymbols';

const slotIndex = (slot: string) => LINE_SLOTS.findIndex((s) => s.slot === slot);

const ZOOM = 14;
/** Degrees of longitude per screen px at ZOOM (512 px tiles). */
const DEG_PER_PX = 360 / (512 * 2 ** ZOOM);
const VIEW = { zoom: ZOOM };

function line(style: string, coords: [number, number][]): DrawFeature {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { fid: 'l1', kind: 'line', style },
  };
}

/** A 300 px line along the equator (Mercator is 1:1 there). */
const EAST: [number, number][] = [[0, 0], [300 * DEG_PER_PX, 0]];
const NORTH: [number, number][] = [[0, 0], [0, 300 * DEG_PER_PX]];

const props = (fs: GeoJSON.Feature[], slot: string) =>
  fs.filter((f) => f.properties!.slot === slot);
const xPx = (f: GeoJSON.Feature) => (f.geometry as GeoJSON.Point).coordinates[0] / DEG_PER_PX;

describe('NWCG palette data', () => {
  it('offers all 50 Event Point symbols, each with its official icon', () => {
    expect(DRAW_SYMBOLS).toHaveLength(50);
    expect(DRAW_SYMBOLS.every((s) => s.url && s.pixelRatio > 0)).toBe(true);
    expect(DRAW_SYMBOL_GROUPS.flatMap((g) => g.items)).toHaveLength(50);
  });

  it('offers all 32 NWCG line styles plus Sketch and Wildfire Perimeter', () => {
    expect(DRAW_LINE_GROUPS.flatMap((g) => g.items)).toHaveLength(32);
    expect(DRAW_LINES).toHaveLength(34);
    expect(new Set(DRAW_LINES.map((l) => l.id)).size).toBe(34);
  });

  it('resolves ids saved by the old palette', () => {
    expect(drawSymbolById('dip')?.label).toBe('Dip Site');
    expect(drawSymbolById('camp')?.label).toBe('Camp');
    expect(drawLineById('handline')?.label).toBe('Completed Hand Line');
    expect(drawLineById('uncontained')?.label).toBe('Uncontained');
    expect(drawLineById('nope')).toBeUndefined();
  });
});

describe('planStyle', () => {
  it('fits every style into the layer stack in its own bottom-to-top order', () => {
    for (const style of DRAW_LINES) {
      const order = planStyle(style).map((p) => slotIndex(p.slot));
      expect(order, style.id).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it('keeps only the overlapping textures as repeating pattern tiles', () => {
    const patterned = DRAW_LINES.filter((s) => planStyle(s).some((p) => p.slot === 'pattern'));
    expect(patterned.map((s) => s.id).sort()).toEqual(['completed-dozer-line', 'completed-fuel-break']);
  });

  it('sizes a pattern tile to the exact NWCG spacing and the line to the tile', () => {
    const dozer = drawLineById('completed-dozer-line')!.parts[0];
    if (dozer.kind !== 'marks') throw new Error('expected marks');
    const m = patternTileMetrics(dozer, 2);
    expect(m.widthDev / m.pixelRatio).toBeCloseTo(10.35 * PX_PER_PT, 9);
    expect(m.heightPx / 2).toBeGreaterThanOrEqual(dozer.box[3] * PX_PER_PT);
    const [f] = drawSourceFeatures([line('completed-dozer-line', EAST)], VIEW);
    expect(f.properties).toMatchObject({ slot: 'pattern', width: patternTileMetrics(dozer).heightPx });
  });

  it('round-trips image ids through style ids that contain dashes', () => {
    const style = drawLineById('fire-edge-field-collection')!;
    const planned = planStyle(style).find((p) => p.image)!;
    expect(plannedPartForImage(lineImageId(style.id, planned.order))?.planned).toBe(planned);
    expect(plannedPartForImage('rd-dl-nope~0')).toBeNull();
  });
});

describe('drawSourceFeatures', () => {
  it('draws a placed symbol with its NWCG icon', () => {
    const marker: DrawFeature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-120, 40] },
      properties: { fid: 'm1', kind: 'marker', sym: 'drop' },
    };
    const [f] = drawSourceFeatures([marker], VIEW);
    expect(f.properties).toMatchObject({ fid: 'm1', slot: 'pt', icon: 'rd-dp-drop-point' });
  });

  it('puts the halo casing under a black stroke', () => {
    const [casing, stroke] = props(drawSourceFeatures([line('handline', EAST)], VIEW), 'stroke')
      .map((f) => f.properties!);
    expect(casing).toMatchObject({ color: HALO_COLOR, width: (1 + 2 * HALO_PT) * PX_PER_PT });
    expect(stroke).toMatchObject({ color: '#000000', width: PX_PER_PT });
    expect(casing.sort).toBeLessThan(stroke.sort);
  });

  it('spaces hand-line letters 26 pt apart from the start of the line', () => {
    const letters = props(drawSourceFeatures([line('handline', EAST)], VIEW), 'upright');
    const step = 26 * PX_PER_PT;
    expect(letters).toHaveLength(Math.floor(300 / step) + 1);
    letters.forEach((f, i) => expect(xPx(f)).toBeCloseTo(i * step, 6));
    expect(letters[0].properties).not.toHaveProperty('rot'); // upright
  });

  it('puts the planned-line squares halfway between the letters', () => {
    const fs = drawSourceFeatures([line('planned-hand-line', EAST)], VIEW);
    const squares = props(fs, 'marks');
    expect(xPx(squares[0])).toBeCloseTo(13 * PX_PER_PT, 6);
    expect(xPx(squares[1]) - xPx(squares[0])).toBeCloseTo(26 * PX_PER_PT, 6);
  });

  it('turns marks with the line', () => {
    const east = props(drawSourceFeatures([line('escape-route', EAST)], VIEW), 'marks');
    const north = props(drawSourceFeatures([line('escape-route', NORTH)], VIEW), 'marks');
    expect(east[0].properties!.rot).toBeCloseTo(0);
    expect(north[0].properties!.rot).toBeCloseTo(-90); // clockwise from east
  });

  it('insets end markers and flips the first one where NWCG does', () => {
    const ends = props(drawSourceFeatures([line('break-line', EAST)], VIEW), 'marks');
    expect(ends.map(xPx)).toEqual([
      expect.closeTo(8 * PX_PER_PT, 6),
      expect.closeTo(300 - 8 * PX_PER_PT, 6),
    ]);
    expect(ends.map((f) => f.properties!.rot)).toEqual([180, 0]);
  });

  it('offsets the burnout line to the right of travel, as NWCG draws it', () => {
    const [, stroke] = props(drawSourceFeatures([line('completed-burnout', EAST)], VIEW), 'stroke');
    expect(stroke.properties!.offset).toBeCloseTo(15 * PX_PER_PT);
  });

  it('gives dashed strokes their dash lengths in line widths', () => {
    const [tfr] = props(drawSourceFeatures([line('temporary-flight-restriction', EAST)], VIEW), 'dash');
    expect(tfr.properties).toMatchObject({ dash: [20 / 7, 14 / 7], width: 7 * PX_PER_PT });
    // a dashed halo keeps the ink's dash lengths, squared off
    const [casing] = props(drawSourceFeatures([line('highlighted-feature', EAST)], VIEW), 'dash');
    const w = 2 + 2 * HALO_PT;
    expect(casing.properties).toMatchObject({ color: HALO_COLOR, cap: 'butt' });
    expect(casing.properties!.dash[1]).toBeCloseTo(6 / w);
  });

  it('skips marks outside the visible area', () => {
    const half = 150 * DEG_PER_PX;
    const bounds: [number, number, number, number] = [-1, -1, half, 1];
    const all = props(drawSourceFeatures([line('escape-route', EAST)], VIEW), 'marks');
    const seen = props(drawSourceFeatures([line('escape-route', EAST)], { zoom: ZOOM, bounds }), 'marks');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(all.length);
  });

  it('previews the stroke being drawn without a feature id', () => {
    const feats = drawSourceFeatures([], VIEW, { coords: EAST, styleId: 'sketch' });
    expect(feats).toHaveLength(1);
    expect(feats[0].properties).toMatchObject({ fid: '', slot: 'stroke', color: '#ffbd5a' });
  });
});
