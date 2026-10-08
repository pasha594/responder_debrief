/**
 * Terrain outside a fire's routing area, for online Walk's cross-country
 * ends (pin → the way the route joins). The 3D map's own AWS terrarium
 * tiles at z12 — about 30 m, like the bundles' grid (decodeTerrarium).
 * map.queryTerrainElevation can't do
 * this: it returns heights × the 1.2 terrain exaggeration, at whatever zoom
 * the view last loaded, and 0 for a tile the view never loaded.
 *
 * A line is priced the way the bundles price a cell (worker cost_grid.py):
 * GET v2 pace on TERRAIN slope (Horn's 3×3, the method behind LANDFIRE's
 * SlpD, so a cliff crossed at a slant still counts) × the unknown-cover
 * multiplier, times α(grade) along the line (sampler.ts). Ground over 45°
 * is impassable there; a straight line can't step round it, so one that
 * crosses more than a pixel's worth is reported as not walkable. Water is
 * not seen: a DEM can't tell a river, a bay or a dry lakebed from ground
 * (3DEP rivers fall downstream; playas and meadows are as flat as lakes).
 */
import { DEM_TILES } from '../app/config';
import { M_UNKNOWN, MAX_SLOPE_DEG, alphaFast, getRate, gradeDeg, tertileRatios } from './costModel';
import { climbOf } from './legs';
import { metresBetween } from './safety';

type LonLat = [number, number];
export type TileSource = (z: number, x: number, y: number) => Promise<Float32Array>;

const Z = 12;
const TILE = 256;
const SAMPLE_M = 15;
const CACHE_TILES = 32;
/** Up to about one pixel of steep ground, crossed at any angle (a z12
 * pixel's diagonal is ~43 m at 38°N), is a step a walker goes round. */
const BLOCKED_OK_M = 45;

/** Decode a terrarium PNG to heights: h = R·256 + G + B/256 − 32768. No
 * canvas — anti-fingerprinting (Safari Private Browsing, Brave, Firefox)
 * noises getImageData, and ±1 on red is ±256 m: every line a cliff. The
 * tiles are 8-bit RGB(A), not interlaced, so it's the IDAT stream through
 * the browser's DecompressionStream and the five PNG row filters undone. */
export async function decodeTerrarium(buf: ArrayBuffer): Promise<Float32Array> {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  let bpp = 0;
  const idat: Uint8Array<ArrayBuffer>[] = [];
  for (let o = 8; o + 8 <= b.length; o += 12 + dv.getUint32(o)) {
    const type = String.fromCharCode(...b.subarray(o + 4, o + 8));
    if (type === 'IHDR') {
      const ok = dv.getUint32(o + 8) === TILE && dv.getUint32(o + 12) === TILE && b[o + 16] === 8 && !b[o + 20];
      bpp = !ok ? 0 : b[o + 17] === 2 ? 3 : b[o + 17] === 6 ? 4 : 0;
    } else if (type === 'IDAT') idat.push(b.slice(o + 8, o + 8 + dv.getUint32(o)));
  }
  if (!bpp) throw new Error('terrain tile: not an 8-bit RGB 256 px PNG');
  const raw = new Uint8Array(await new Response(
    new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = TILE * bpp;
  const px = new Uint8Array(TILE * stride);
  for (let y = 0; y < TILE; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[row + i - bpp] : 0;
      const up = y ? px[row - stride + i] : 0;
      const c = y && i >= bpp ? px[row - stride + i - bpp] : 0;
      const p = a + up - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - up), Math.abs(p - c)];
      const pred = f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1
        : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? up : c) : 0;
      px[row + i] = (raw[src + i] + pred) & 255;
    }
  }
  const h = new Float32Array(TILE * TILE);
  for (let i = 0; i < h.length; i++) h[i] = px[i * bpp] * 256 + px[i * bpp + 1] + px[i * bpp + 2] / 256 - 32768;
  return h;
}

/** Fetch and decode one terrarium tile. */
export const terrariumTile: TileSource = async (z, x, y) => {
  const res = await fetch(DEM_TILES.replace('{z}', `${z}`).replace('{x}', `${x}`).replace('{y}', `${y}`));
  if (!res.ok) throw new Error(`terrain ${res.status}`);
  return decodeTerrarium(await res.arrayBuffer());
};

/** Recent tiles per source (insertion order = age); failures aren't kept. */
const caches = new WeakMap<TileSource, Map<string, Promise<Float32Array>>>();
function cachedTile(src: TileSource, z: number, x: number, y: number): Promise<Float32Array> {
  let c = caches.get(src);
  if (!c) caches.set(src, (c = new Map()));
  const key = `${z}/${x}/${y}`;
  let p = c.get(key);
  if (p) c.delete(key);
  else p = src(z, x, y).catch((err) => { c.delete(key); throw err; });
  c.set(key, p);
  while (c.size > CACHE_TILES) c.delete(c.keys().next().value!);
  return p;
}

export class Dem {
  private tiles = new Map<string, Float32Array>();
  private constructor(private readonly z: number) {}

  /** The tiles under these lines, with the pixels round them that Horn's
   * 3×3 reads: corners of a 12 px box every 8 px along each line. `partial`
   * leaves out a tile that fails (its ground reads as blocked) instead of
   * failing the load. */
  static async load(lines: [LonLat, LonLat][], src: TileSource = terrariumTile, partial = false,
    z = Z): Promise<Dem> {
    const d = new Dem(z);
    const need = new Set<string>();
    for (const [p, q] of lines) {
      const [x0, y0] = d.pixel(p);
      const [x1, y1] = d.pixel(q);
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 8));
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const y = y0 + ((y1 - y0) * k) / n;
        for (const [dx, dy] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) {
          need.add(`${Math.floor((x + dx) / TILE)}/${Math.floor((y + dy) / TILE)}`);
        }
      }
    }
    const jobs = [...need].map(async (key) => {
      const [tx, ty] = key.split('/').map(Number);
      d.tiles.set(key, await cachedTile(src, z, tx, ty));
    });
    if (partial) await Promise.allSettled(jobs);
    else await Promise.all(jobs);
    return d;
  }

  /** Global web-mercator pixel coordinates at this zoom. */
  private pixel([lon, lat]: LonLat): [number, number] {
    const n = TILE * 2 ** this.z;
    const s = Math.sin((lat * Math.PI) / 180);
    return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  }

  /** Height of pixel (i, j); NaN off the loaded tiles. */
  private h(i: number, j: number): number {
    const t = this.tiles.get(`${Math.floor(i / TILE)}/${Math.floor(j / TILE)}`);
    return t ? t[(((j % TILE) + TILE) % TILE) * TILE + (((i % TILE) + TILE) % TILE)] : NaN;
  }

  /** Bilinear height (m) between pixel centres. */
  elev(p: LonLat): number {
    const [x, y] = this.pixel(p);
    const i = Math.floor(x - 0.5);
    const j = Math.floor(y - 0.5);
    const fx = x - 0.5 - i;
    const fy = y - 0.5 - j;
    const top = this.h(i, j) * (1 - fx) + this.h(i + 1, j) * fx;
    const bot = this.h(i, j + 1) * (1 - fx) + this.h(i + 1, j + 1) * fx;
    return top * (1 - fy) + bot * fy;
  }

  /** Terrain slope (°) of the pixel under p, by Horn's 3×3 method. */
  slope(p: LonLat): number {
    const [x, y] = this.pixel(p);
    const i = Math.floor(x);
    const j = Math.floor(y);
    const m = (40_075_016.686 * Math.cos((p[1] * Math.PI) / 180)) / (TILE * 2 ** this.z);
    const z = (di: number, dj: number) => this.h(i + di, j + dj);
    const dx = (z(1, -1) + 2 * z(1, 0) + z(1, 1) - z(-1, -1) - 2 * z(-1, 0) - z(-1, 1)) / (8 * m);
    const dy = (z(-1, 1) + 2 * z(0, 1) + z(1, 1) - z(-1, -1) - 2 * z(0, -1) - z(1, -1)) / (8 * m);
    return (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
  }
}

export interface Connector {
  distanceM: number;
  climbM: number;
  descentM: number;
  /** Typical seconds, and the [fast, slow] ends. */
  durationS: number;
  rangeS: [number, number];
  /** Metres of the line over ground it can't cross: steeper than
   * MAX_SLOPE_DEG, or no terrain. */
  blockedM: number;
}

/** A straight cross-country line priced on the terrain (horizontal metres
 * × GET pace × α, every ≤ 15 m). Blocked ground is measured every ≤ 4 m, so
 * it grows smoothly with the line, and priced as 45° so lines that can't be
 * walked still rank by how bad they are. */
export function priceConnector(dem: Dem, a: LonLat, b: LonLat): Connector {
  const len = metresBetween(a, b);
  const n = Math.max(1, Math.ceil(len / SAMPLE_M));
  const at = (k: number): LonLat => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
  const zs = Array.from({ length: n + 1 }, (_, k) => dem.elev(at(k)));
  const dh = len / n;
  const c: Connector = { distanceM: len, climbM: 0, descentM: 0, durationS: 0, rangeS: [0, 0], blockedM: 0 };
  for (let k = 0; k < n; k++) {
    for (let q = 0; q < 4; q++) if (!(dem.slope(at(k + (q + 0.5) / 4)) <= MAX_SLOPE_DEG)) c.blockedM += dh / 4;
    const sigma = dem.slope(at(k + 0.5));
    const theta = gradeDeg(zs[k + 1] - zs[k], dh);
    const t = (dh * M_UNKNOWN * alphaFast(Number.isFinite(theta) ? theta : 0))
      / getRate(sigma <= MAX_SLOPE_DEG ? sigma : MAX_SLOPE_DEG);
    const r = tertileRatios(Number.isFinite(theta) ? theta : 0);
    c.durationS += t;
    c.rangeS[0] += t * r.fast;
    c.rangeS[1] += t * r.slow;
  }
  const { climb, descent } = climbOf(zs.filter(Number.isFinite));
  c.climbM = climb;
  c.descentM = descent;
  return c;
}

export const walkable = (c: Connector): boolean => c.blockedM <= BLOCKED_OK_M;
