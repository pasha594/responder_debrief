import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOA_RAMP,
  paintToa,
  parseHexColor,
  resolveToaRamp,
} from './toaRenderer';

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
