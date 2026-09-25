import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter, ShareFormatError, crc32, truncateUtf8 } from './bytes';
import { bytesToDigits, digitsToBytes } from './digits';

describe('ByteWriter / ByteReader', () => {
  it('round-trips varints, zigzags, u32 and strings', () => {
    const nums = [0, 1, 127, 128, 300, 16383, 16384, 2 ** 31, 2 ** 40 + 7, Number.MAX_SAFE_INTEGER];
    const signed = [0, -1, 1, -64, 64, -123456, 987654, -(2 ** 45)];
    const w = new ByteWriter();
    nums.forEach((n) => w.varint(n));
    signed.forEach((n) => w.zigzag(n));
    w.u32(0xdeadbeef);
    w.str('Big Grass — Ω');
    const r = new ByteReader(w.finish());
    expect(nums.map(() => r.varint())).toEqual(nums);
    expect(signed.map(() => r.zigzag())).toEqual(signed);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.str()).toBe('Big Grass — Ω');
    expect(r.remaining).toBe(0);
  });

  it('small signed deltas cost one byte', () => {
    const w = new ByteWriter();
    w.zigzag(-64);
    w.zigzag(63);
    expect(w.finish().length).toBe(2);
  });

  it('reading past the end is a ShareFormatError', () => {
    const r = new ByteReader(new Uint8Array([0x80]));
    expect(() => r.varint()).toThrow(ShareFormatError);
    expect(() => new ByteReader(new Uint8Array([5, 1])).str()).toThrow(ShareFormatError);
  });

  it('rejects over-long varints', () => {
    const r = new ByteReader(new Uint8Array(9).fill(0xff));
    expect(() => r.varint()).toThrow(ShareFormatError);
  });
});

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('truncateUtf8', () => {
  it('never splits a character', () => {
    expect(truncateUtf8('abc', 10)).toBe('abc');
    expect(truncateUtf8('ééé', 5)).toBe('éé');
    expect(truncateUtf8('a🔥b', 4)).toBe('a');
  });
});

describe('digits', () => {
  it('round-trips every length and byte value', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 0xff;
    for (let n = 0; n <= 40; n++) {
      for (const fill of [0, 255, -1]) {
        const b = Uint8Array.from({ length: n }, () => (fill < 0 ? rand() : fill));
        const d = bytesToDigits(b);
        expect(d).toMatch(/^\d*$/);
        expect(digitsToBytes(d)).toEqual(b);
      }
    }
  });

  it('costs 17 digits per 7 bytes', () => {
    expect(bytesToDigits(new Uint8Array(70)).length).toBe(170);
  });

  it('rejects impossible digit strings', () => {
    expect(() => digitsToBytes('12')).toThrow(ShareFormatError); // no 2-digit chunk width
    expect(() => digitsToBytes('999')).toThrow(ShareFormatError); // > 255 in one byte
    expect(() => digitsToBytes('12a')).toThrow(ShareFormatError);
  });
});
