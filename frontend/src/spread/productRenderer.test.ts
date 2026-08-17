import { describe, expect, it } from 'vitest';
import {
  buildLut,
  indexMembers,
  memberIndexAt,
  paintProduct,
  parseMemberTime,
} from './productRenderer';

const T = (s: string) => Date.parse(s);

describe('parseMemberTime', () => {
  it('parses {product}_{YYYYMMDD}_{HHMMSS}.tif as UTC', () => {
    expect(parseMemberTime('spread-rate_20260817_112500.tif')).toBe(T('2026-08-17T11:25:00Z'));
    expect(parseMemberTime('crown-fire_20260820_090000.tif')).toBe(T('2026-08-20T09:00:00Z'));
    // product names may themselves contain underscores/dashes
    expect(parseMemberTime('hours-since-burned_20260101_000000.tif')).toBe(
      T('2026-01-01T00:00:00Z'),
    );
  });
  it('rejects non-member names', () => {
    expect(parseMemberTime('README.txt')).toBeNull();
    expect(parseMemberTime('spread-rate_2026_112500.tif')).toBeNull();
    expect(parseMemberTime('spread-rate_20260817_1125.tif')).toBeNull();
  });
});

describe('indexMembers', () => {
  it('filters to timestamped tifs and sorts ascending', () => {
    const bytes = new Uint8Array(0);
    const idx = indexMembers([
      { name: 'spread-rate_20260817_130000.tif', bytes },
      { name: 'notes.txt', bytes },
      { name: 'spread-rate_20260817_112500.tif', bytes },
      { name: 'spread-rate_20260817_120000.tif', bytes },
    ]);
    expect(idx.map((m) => m.name)).toEqual([
      'spread-rate_20260817_112500.tif',
      'spread-rate_20260817_120000.tif',
      'spread-rate_20260817_130000.tif',
    ]);
    expect(idx[0].timeMs).toBe(T('2026-08-17T11:25:00Z'));
  });
});

describe('memberIndexAt (nearest member <= t)', () => {
  const times = [
    T('2026-08-17T11:25:00Z'),
    T('2026-08-17T12:00:00Z'),
    T('2026-08-17T13:00:00Z'),
  ];
  it('selects the member at-or-before t', () => {
    expect(memberIndexAt(times, T('2026-08-17T11:25:00Z'))).toBe(0);
    expect(memberIndexAt(times, T('2026-08-17T11:59:59Z'))).toBe(0);
    expect(memberIndexAt(times, T('2026-08-17T12:00:00Z'))).toBe(1);
    expect(memberIndexAt(times, T('2026-08-17T12:30:00Z'))).toBe(1);
    expect(memberIndexAt(times, T('2026-08-18T00:00:00Z'))).toBe(2); // holds last
  });
  it('-1 before the first member', () => {
    expect(memberIndexAt(times, T('2026-08-17T11:00:00Z'))).toBe(-1);
    expect(memberIndexAt([], Date.now())).toBe(-1);
  });
});

describe('buildLut', () => {
  it('keeps nodata 0 transparent', () => {
    const lut = buildLut([
      [1, '#000000'],
      [5, '#ffffff'],
    ]);
    expect(lut[3]).toBe(0);
  });

  it('piecewise-linearly interpolates continuous ramps and clamps the ends', () => {
    const lut = buildLut([
      [1, '#000000'],
      [5, '#c8c8c8'], // 200
    ]);
    // midpoint v=3 → 100
    expect([lut[3 * 4], lut[3 * 4 + 1], lut[3 * 4 + 2], lut[3 * 4 + 3]]).toEqual([
      100, 100, 100, 255,
    ]);
    // below the first stop clamps to it
    expect(lut[1 * 4]).toBe(0);
    expect(lut[1 * 4 + 3]).toBe(255);
    // above the last stop clamps to it
    expect(lut[200 * 4]).toBe(200);
    expect(lut[255 * 4]).toBe(200);
  });

  it('exact-matches discrete ramps (crown-fire) and leaves gaps transparent', () => {
    const lut = buildLut(
      [
        [1, '#ffdc50'],
        [2, '#ff9628'],
        [3, '#e63c32'],
      ],
      true,
    );
    expect([lut[1 * 4], lut[1 * 4 + 1], lut[1 * 4 + 2], lut[1 * 4 + 3]]).toEqual([
      0xff, 0xdc, 0x50, 255,
    ]);
    expect(lut[3 * 4 + 3]).toBe(255);
    expect(lut[4 * 4 + 3]).toBe(0); // value 4 has no class
    expect(lut[200 * 4 + 3]).toBe(0);
  });
});

describe('paintProduct', () => {
  it('maps byte values through the LUT into RGBA', () => {
    const lut = buildLut([
      [1, '#ff0000'],
      [3, '#0000ff'],
    ]);
    const values = Uint8Array.of(0, 1, 2, 3);
    const out = new Uint8ClampedArray(values.length * 4);
    paintProduct(values, lut, out);
    expect(out[0 * 4 + 3]).toBe(0); // nodata
    expect([out[1 * 4], out[1 * 4 + 2]]).toEqual([255, 0]);
    expect([out[2 * 4], out[2 * 4 + 2]]).toEqual([128, 128]); // midpoint lerp (127.5 → 128)
    expect([out[3 * 4], out[3 * 4 + 2]]).toEqual([0, 255]);
  });
});
