import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { syntheticTiles } from './__fixtures__/syntheticTerrain';
import { M_UNKNOWN, getRate } from './costModel';
import { Dem, decodeTerrarium, priceConnector, walkable } from './terrainTiles';

type LonLat = [number, number];
const O: LonLat = [-119.66, 37.73];
const ky = 111_320;
const kx = ky * Math.cos((O[1] * Math.PI) / 180);
const at = (e: number, n: number): LonLat => [O[0] + e / kx, O[1] + n / ky];
const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
/** A 1° tilt, like real ground. */
const tilt = (e: number) => e * tan(1);

describe('terrain tiles', () => {
  it('reads heights and Horn slope off the tiles', async () => {
    const tiles = syntheticTiles(O, (e, n) => 1000 + n * tan(20));
    const dem = await Dem.load([[at(0, 0), at(0, 500)], [at(0, 0), at(500, 500)]], tiles);
    expect(dem.elev(at(0, 300))).toBeCloseTo(1000 + 300 * tan(20), -1);
    expect(dem.slope(at(100, 100))).toBeCloseTo(20, 0);
  });

  it('prices flat ground as unknown cover and a ramp by its climb', async () => {
    const flat = await Dem.load([[at(0, 0), at(0, 600)]], syntheticTiles(O, (e) => 500 + tilt(e)));
    const c = priceConnector(flat, at(0, 0), at(0, 600));
    expect(c.durationS / ((600 * M_UNKNOWN) / getRate(1))).toBeCloseTo(1, 1);
    expect([c.climbM, c.descentM, c.blockedM]).toEqual([0, 0, 0]);
    const ramp = await Dem.load([[at(0, 0), at(0, 600)]], syntheticTiles(O, (e, n) => n * tan(15)));
    const up = priceConnector(ramp, at(0, 0), at(0, 600));
    const down = priceConnector(ramp, at(0, 600), at(0, 0));
    expect(up.climbM).toBeCloseTo(600 * tan(15), -1);
    expect(up.durationS).toBeGreaterThan(down.durationS); // α: uphill is slower
    expect(walkable(up)).toBe(true);
  });

  it('a cliff blocks a line that crosses it, square or at a slant, not one beside it', async () => {
    // 800 m down a 60 m wide band at y = −300
    const h = (e: number, n: number) => 2000 + tilt(e) - 800 * Math.min(1, Math.max(0, (-300 - n) / 60));
    const lines: [LonLat, LonLat][] = [[at(0, 0), at(0, -700)], [at(0, 0), at(500, -700)], [at(-500, 0), at(500, 0)]];
    const dem = await Dem.load(lines, syntheticTiles(O, h));
    const square = priceConnector(dem, at(0, 0), at(0, -700));
    expect(walkable(square)).toBe(false);
    expect(square.descentM).toBeCloseTo(800, -1);
    expect(walkable(priceConnector(dem, at(0, 0), at(500, -700)))).toBe(false);
    expect(walkable(priceConnector(dem, at(-500, 0), at(500, 0)))).toBe(true);
  });

  it('one pixel of steep ground passes at any angle and offset; two do not', async () => {
    const band = (w: number) => syntheticTiles(O, (e, n) => 1000 + tilt(e) + Math.min(w, Math.max(0, n)) * tan(60));
    for (const [w, ok] of [[30, true], [90, false]] as const) {
      const tiles = band(w);
      for (const deg of [0, 30, 45]) {
        for (let k = 0; k < 6; k++) {
          const e0 = k * 5;
          const e1 = e0 + 600 * tan(deg);
          const dem = await Dem.load([[at(e0, -300), at(e1, 300)]], tiles);
          expect(walkable(priceConnector(dem, at(e0, -300), at(e1, 300)))).toBe(ok);
        }
      }
    }
  });

  it('a tile that fails reads as blocked ground in a partial load, and fails a strict one', async () => {
    const good = syntheticTiles(O, (e) => 500 + tilt(e));
    let bad = '';
    const flaky = async (z: number, x: number, y: number) => {
      if (!bad) bad = `${x}/${y}`; // the first tile asked for
      if (`${x}/${y}` === bad) throw new Error('offline');
      return good(z, x, y);
    };
    const line: [LonLat, LonLat] = [at(0, 0), at(0, 300)];
    await expect(Dem.load([line], flaky)).rejects.toThrow('offline');
    const dem = await Dem.load([line], flaky, true);
    expect(walkable(priceConnector(dem, ...line))).toBe(false);
  });

  it('decodes a terrarium PNG through all five row filters, no canvas', async () => {
    const hm = (i: number) => -50 + ((i * 37) % 9000) + (i % 256) / 256; // −50 m … 8950 m
    const rgb = new Uint8Array(256 * 256 * 3);
    for (let i = 0; i < 256 * 256; i++) {
      const v = hm(i) + 32768;
      rgb.set([Math.floor(v / 256), Math.floor(v) % 256, Math.round((v % 1) * 256)], i * 3);
    }
    const S = 256 * 3;
    const rows = new Uint8Array(256 * (S + 1));
    for (let y = 0; y < 256; y++) {
      const f = y % 5;
      rows[y * (S + 1)] = f;
      for (let i = 0; i < S; i++) {
        const at = (yy: number, ii: number) => (yy < 0 || ii < 0 ? 0 : rgb[yy * S + ii]);
        const [a, up, c] = [at(y, i - 3), at(y - 1, i), at(y - 1, i - 3)];
        const p = a + up - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        const pred = [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][f];
        rows[y * (S + 1) + 1 + i] = (rgb[y * S + i] - pred) & 255;
      }
    }
    const chunk = (type: string, data: Uint8Array) => {
      const out = new Uint8Array(12 + data.length);
      new DataView(out.buffer).setUint32(0, data.length);
      out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
      out.set(data, 8);
      return out; // CRC left zero: unchecked
    };
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, 256);
    new DataView(ihdr.buffer).setUint32(4, 256);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const z = deflateSync(rows);
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
      chunk('IDAT', z.subarray(0, 1000)), chunk('IDAT', z.subarray(1000)), chunk('IEND', new Uint8Array())];
    const png = new Uint8Array(parts.reduce((n, q) => n + q.length, 0));
    parts.reduce((o, q) => (png.set(q, o), o + q.length), 0);
    const h = await decodeTerrarium(png.buffer);
    for (const i of [0, 1, 255, 256, 257, 300 * 3, 65535]) expect(h[i]).toBeCloseTo(hm(i), 2);
  });
});
