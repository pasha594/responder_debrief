import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOA_RAMP,
  paintToa,
  paintToaBands,
  parseHexColor,
  resolveToaRamp,
  ToaRenderer,
  TOA_BAND_RGBA,
  type SpreadGrid,
} from './toaRenderer';
import {
  clampWithinHours,
  defaultWithinHours,
  TOA_BANDS,
  toaBandFor,
  toaBandIndex,
  toaLegendBands,
  toaWithinStops,
} from './toaBands';

describe('parseHexColor', () => {
  it('parses #rrggbb and #rgb', () => {
    expect(parseHexColor('#7a1f1f')).toEqual([0x7a, 0x1f, 0x1f]);
    expect(parseHexColor('#FF6A2B')).toEqual([0xff, 0x6a, 0x2b]);
    expect(parseHexColor('#abc')).toEqual([0xaa, 0xbb, 0xcc]);
  });
  it('rejects anything else', () => {
    expect(parseHexColor('red')).toBeNull();
    expect(parseHexColor('#12345')).toBeNull();
    expect(parseHexColor('')).toBeNull();
  });
});

describe('resolveToaRamp', () => {
  it('defaults when the manifest hint is absent', () => {
    expect(resolveToaRamp(null)).toEqual(DEFAULT_TOA_RAMP);
    expect(resolveToaRamp(undefined)).toEqual(DEFAULT_TOA_RAMP);
  });
  it('uses manifest colors + recent_hours', () => {
    const r = resolveToaRamp({
      recent_hours: 6,
      stops: [
        ['burned', '#000000'],
        ['recent', '#ffffff'],
      ],
    });
    expect(r.recentHours).toBe(6);
    expect(r.burned.slice(0, 3)).toEqual([0, 0, 0]);
    expect(r.recent.slice(0, 3)).toEqual([255, 255, 255]);
    // Alphas are fixed by the renderer (0.55 / 0.85).
    expect(r.burned[3]).toBe(Math.round(0.55 * 255));
    expect(r.recent[3]).toBe(Math.round(0.85 * 255));
  });
  it('falls back per-color on unparsable stops', () => {
    const r = resolveToaRamp({ recent_hours: 0, stops: [['burned', 'nope']] });
    expect(r.burned).toEqual(DEFAULT_TOA_RAMP.burned);
    expect(r.recentHours).toBe(DEFAULT_TOA_RAMP.recentHours); // 0 → default
  });
});

describe('paintToa threshold math', () => {
  const ramp = resolveToaRamp({
    recent_hours: 12,
    stops: [
      ['burned', '#7a1f1f'],
      ['recent', '#ff6a2b'],
    ],
  });
  const alphaAt = (out: Uint8ClampedArray, i: number) => out[i * 4 + 3];
  const rgbAt = (out: Uint8ClampedArray, i: number) => [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]];

  it('classifies nodata / burned / leading edge / future', () => {
    // toa hours: nodata(0), NaN, burned long ago, at the edge boundary,
    // inside the leading window, exactly at scrub, in the future.
    const values = Float32Array.of(0, NaN, 5, 8, 12.5, 20, 20.1);
    const out = new Uint8ClampedArray(values.length * 4);
    paintToa(values, 20, ramp, out); // hours=20, edge starts at 8

    expect(alphaAt(out, 0)).toBe(0); // nodata 0
    expect(alphaAt(out, 1)).toBe(0); // NaN
    expect(rgbAt(out, 2)).toEqual([0x7a, 0x1f, 0x1f]); // burned
    expect(alphaAt(out, 2)).toBe(Math.round(0.55 * 255));
    expect(rgbAt(out, 3)).toEqual([0x7a, 0x1f, 0x1f]); // toa == hours-recent → burned
    expect(rgbAt(out, 4)).toEqual([0xff, 0x6a, 0x2b]); // leading edge
    expect(alphaAt(out, 4)).toBe(Math.round(0.85 * 255));
    expect(rgbAt(out, 5)).toEqual([0xff, 0x6a, 0x2b]); // toa == hours → still shown
    expect(alphaAt(out, 6)).toBe(0); // future
  });

  it('is fully transparent before the run start (hours < 0)', () => {
    const values = Float32Array.of(1, 5, 100);
    const out = new Uint8ClampedArray(values.length * 4).fill(99);
    paintToa(values, -2, ramp, out);
    for (let i = 0; i < values.length; i++) expect(alphaAt(out, i)).toBe(0);
  });

  it('clears previously painted pixels when repainting an earlier time', () => {
    const values = Float32Array.of(5);
    const out = new Uint8ClampedArray(4);
    paintToa(values, 20, ramp, out);
    expect(alphaAt(out, 0)).not.toBe(0);
    paintToa(values, 1, ramp, out); // scrubbed back before arrival
    expect(alphaAt(out, 0)).toBe(0);
  });
});

// ---------- Whole-prediction bands ----------

describe('toaBandIndex boundaries', () => {
  it('is inclusive-upper: a value exactly on a bound stays in that band', () => {
    expect(toaBandFor(12).hours).toBe(12);
    expect(toaBandFor(24).hours).toBe(24); // exactly 24 h → the ≤24 band
    expect(toaBandFor(24.0001).hours).toBe(48);
    expect(toaBandFor(48).hours).toBe(48);
    expect(toaBandFor(168).hours).toBe(168);
    expect(toaBandFor(240).hours).toBe(240);
    expect(toaBandFor(336).hours).toBe(336);
  });
  it('puts anything under the first bound in the first band', () => {
    expect(toaBandIndex(0.1)).toBe(0);
    expect(toaBandIndex(11.9)).toBe(0);
  });
  it('clamps past the last bound into the last band', () => {
    expect(toaBandIndex(1e6)).toBe(TOA_BANDS.length - 1);
  });
});

describe('toaWithinStops / clampWithinHours / defaultWithinHours', () => {
  it('caps the stops at the run horizon and always offers the full run', () => {
    const stops = toaWithinStops(169);
    expect(stops[stops.length - 1]).toBe(169);
    expect(Math.max(...stops)).toBe(169);
    // 168 sits within 12 h of the horizon, so it is dropped rather than
    // shipping two stops an hour apart.
    expect(stops).not.toContain(168);
    expect(stops).toContain(120);
  });
  it('keeps the whole ladder for a 336 h run', () => {
    expect(toaWithinStops(336)).toEqual(TOA_BANDS.map((b) => b.hours));
  });
  it('never returns an empty ladder for a tiny horizon', () => {
    expect(toaWithinStops(6)).toEqual([6]);
  });
  it('snaps arbitrary values onto a real stop', () => {
    expect(clampWithinHours(1000, 169)).toBe(169);
    expect(clampWithinHours(0, 169)).toBe(12);
    expect(clampWithinHours(26, 336)).toBe(24);
    expect(clampWithinHours(Number.NaN, 336)).toBe(336);
  });
  it('defaults to min(240, horizon) on a real stop', () => {
    expect(defaultWithinHours(336)).toBe(240);
    expect(defaultWithinHours(169)).toBe(169);
    expect(defaultWithinHours(72)).toBe(72);
  });
});

describe('toaLegendBands', () => {
  it('drops bands the run cannot reach and relabels the top one', () => {
    const bands = toaLegendBands(169);
    expect(bands.map((b) => b.hours)).toEqual([12, 24, 48, 72, 96, 120, 168, 169]);
    // The top row keeps the color the renderer paints for 168–169 h.
    expect(bands[bands.length - 1].color).toBe('#e6550d');
  });
  it('shows every band for a full-length run', () => {
    expect(toaLegendBands(336)).toEqual([...TOA_BANDS]);
  });
});

describe('paintToaBands', () => {
  const rgbAt = (out: Uint8ClampedArray, i: number) => [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]];
  const alphaAt = (out: Uint8ClampedArray, i: number) => out[i * 4 + 3];
  const bandRgb = (hours: number) => TOA_BAND_RGBA[toaBandIndex(hours)].slice(0, 3);

  it('fills each pixel with its band color, boundaries inclusive-upper', () => {
    const values = Float32Array.of(1, 12, 12.5, 24, 24.5, 168, 240, 336);
    const out = new Uint8ClampedArray(values.length * 4);
    paintToaBands(values, 336, out);
    for (let i = 0; i < values.length; i++) {
      expect(rgbAt(out, i)).toEqual(bandRgb(values[i]));
      expect(alphaAt(out, i)).toBe(Math.round(0.75 * 255));
    }
    // Exactly 24 h must read as the ≤24 band, not the ≤48 one.
    expect(rgbAt(out, 3)).toEqual([0x21, 0x71, 0xb5]);
    expect(rgbAt(out, 4)).toEqual([0x6b, 0xae, 0xd6]);
  });

  it('leaves nodata transparent (0, NaN, negatives)', () => {
    const values = Float32Array.of(0, NaN, -5, 10);
    const out = new Uint8ClampedArray(values.length * 4).fill(99);
    paintToaBands(values, 336, out);
    expect(alphaAt(out, 0)).toBe(0);
    expect(alphaAt(out, 1)).toBe(0);
    expect(alphaAt(out, 2)).toBe(0);
    expect(alphaAt(out, 3)).not.toBe(0);
  });

  it('clips arrivals later than withinHours, inclusive of the bound', () => {
    const values = Float32Array.of(6, 24, 24.5, 100);
    const out = new Uint8ClampedArray(values.length * 4);
    paintToaBands(values, 24, out);
    expect(alphaAt(out, 0)).not.toBe(0);
    expect(alphaAt(out, 1)).not.toBe(0); // exactly at the reach → shown
    expect(alphaAt(out, 2)).toBe(0);
    expect(alphaAt(out, 3)).toBe(0);
  });

  it('clears previously painted pixels when the reach shrinks', () => {
    const values = Float32Array.of(100);
    const out = new Uint8ClampedArray(4);
    paintToaBands(values, 336, out);
    expect(alphaAt(out, 0)).not.toBe(0);
    paintToaBands(values, 24, out);
    expect(alphaAt(out, 0)).toBe(0);
  });
});

// ---------- Renderer mode plumbing ----------

/** Minimal 2D-context stand-in: the renderer only needs createImageData +
 * putImageData, and the test only needs to read back what was written. */
function stubCanvas(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  const painted = new Uint8ClampedArray(width * height * 4);
  const ctx = {
    createImageData: (w: number, h: number) => ({ data, width: w, height: h }),
    putImageData: (img: { data: Uint8ClampedArray }) => painted.set(img.data),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  return { canvas, painted };
}

const GRID: SpreadGrid = {
  width: 2,
  height: 2,
  epsg: 32611,
  bboxUtm: [0, 0, 1, 1],
  corners: [
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
  ],
  bounds: [0, 0, 1, 1],
};

describe('ToaRenderer whole vs timeline modes', () => {
  const RUN_START = Date.UTC(2026, 7, 17, 10, 0, 0);
  const values = Float32Array.of(6, 30, 100, 0);
  const newRenderer = () => new ToaRenderer(GRID, values, { runStartMs: RUN_START, ramp: null });

  it('renderWhole paints bands and ignores the scrub time entirely', () => {
    const a = stubCanvas(2, 2);
    const ra = newRenderer();
    ra.attach(a.canvas);
    // Scrub somewhere mid-run first, then ask for the whole prediction.
    expect(ra.renderAt(RUN_START + 20 * 3.6e6)).toBe(true);
    expect(ra.renderWhole(336)).toBe(true);
    const afterScrub = Uint8ClampedArray.from(a.painted);

    // Same renderer, a wildly different playhead: identical whole-mode paint.
    const b = stubCanvas(2, 2);
    const rb = newRenderer();
    rb.attach(b.canvas);
    expect(rb.renderAt(RUN_START - 500 * 3.6e6)).toBe(true);
    expect(rb.renderWhole(336)).toBe(true);
    expect(Array.from(b.painted)).toEqual(Array.from(afterScrub));

    // …and it matches the pure band paint.
    const expected = new Uint8ClampedArray(values.length * 4);
    paintToaBands(values, 336, expected);
    expect(Array.from(afterScrub)).toEqual(Array.from(expected));
  });

  it('skips repeat whole paints but repaints when the reach changes', () => {
    const { canvas } = stubCanvas(2, 2);
    const r = newRenderer();
    r.attach(canvas);
    expect(r.renderWhole(336)).toBe(true);
    expect(r.renderWhole(336)).toBe(false);
    expect(r.renderWhole(24)).toBe(true);
  });

  it('a scrub tick after renderWhole cannot change the whole-mode canvas', () => {
    const { canvas, painted } = stubCanvas(2, 2);
    const r = newRenderer();
    r.attach(canvas);
    r.renderWhole(336);
    const before = Uint8ClampedArray.from(painted);
    // The layer stops feeding renderAt in whole mode; re-asserting the same
    // reach on every store tick is a no-op, so the pixels never move.
    expect(r.renderWhole(336)).toBe(false);
    expect(Array.from(painted)).toEqual(Array.from(before));
  });

  it('switching modes always repaints, even at an unchanged scrub time', () => {
    const { canvas } = stubCanvas(2, 2);
    const r = newRenderer();
    r.attach(canvas);
    const t = RUN_START + 20 * 3.6e6;
    expect(r.renderAt(t)).toBe(true);
    expect(r.renderAt(t)).toBe(false); // unchanged scrub → skipped
    expect(r.renderWhole(336)).toBe(true); // mode switch → forced
    expect(r.renderAt(t)).toBe(true); // back to timeline → forced
  });
});
