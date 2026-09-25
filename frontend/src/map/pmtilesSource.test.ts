/**
 * The offline trails source: a pmtiles archive read by slicing a Blob (an
 * OPFS File in the app), over the per-fire extract the worker built for the
 * synthetic scene (routing/__fixtures__/synthetic/trails.pmtiles, GDAL 3.8.4).
 */
import { readFileSync } from 'node:fs';
import { PMTiles } from 'pmtiles';
import { describe, expect, it } from 'vitest';
import { OpfsFileSource } from './pmtilesSource';

const bytes = readFileSync(new URL('../routing/__fixtures__/synthetic/trails.pmtiles', import.meta.url));

/** MVT layer names (Tile.layers = field 3, Layer.name = field 1). */
function layerNames(tile: Uint8Array): string[] {
  const out: string[] = [];
  let p = 0;
  const varint = () => {
    let r = 0;
    let s = 0;
    for (;;) {
      const b = tile[p++];
      r |= (b & 0x7f) << s;
      if (!(b & 0x80)) return r;
      s += 7;
    }
  };
  while (p < tile.length) {
    const key = varint();
    const len = varint();
    if ((key >> 3) === 3 && (key & 7) === 2) {
      const end = p + len;
      const k2 = varint();
      if ((k2 >> 3) === 1) {
        const l2 = varint();
        out.push(new TextDecoder().decode(tile.subarray(p, p + l2)));
      }
      p = end;
    } else {
      p += len;
    }
  }
  return out;
}

describe('OpfsFileSource', () => {
  it('serves exact byte ranges from a Blob', async () => {
    const src = new OpfsFileSource('k', new Blob([bytes]));
    const r = await src.getBytes(0, 7);
    expect(new TextDecoder().decode(r.data)).toBe('PMTiles');
    expect(src.getKey()).toBe('k');
  });

  it('lets pmtiles read the worker-built per-fire extract', async () => {
    const pm = new PMTiles(new OpfsFileSource('fire', new Blob([bytes])));
    const h = await pm.getHeader();
    expect([h.minZoom, h.maxZoom]).toEqual([10, 14]);
    // the tile holding the scene centre (-115.0, 44.2) at z12
    const z = 12;
    const n = 2 ** z;
    const x = Math.floor(((-115.0 + 180) / 360) * n);
    const lat = (44.2 * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n);
    const t = await pm.getZxy(z, x, y);
    expect(t).toBeDefined();
    const names = layerNames(new Uint8Array(t!.data));
    expect(names).toEqual(expect.arrayContaining(['ways']));
  });
});
