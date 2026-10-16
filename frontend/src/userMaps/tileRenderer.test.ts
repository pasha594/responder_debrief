import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lonLatToUtm } from '../spread/utm';
import type { Affine, GeoModel, UserMapMeta } from './types';

vi.mock('./storage', () => ({ readPageImage: vi.fn() }));
vi.mock('./georef', () => ({ buildGeoModel: vi.fn() }));

import { buildGeoModel } from './georef';
import { readPageImage } from './storage';
import {
  USER_MAP_PROTOCOL,
  parseUserMapTileUrl,
  pickPyramidLevel,
  planTile,
  pyramidSizes,
  registerUserMapProtocol,
  releaseUserMapImages,
  tileIntersectsBounds,
  tilePixelSize,
  userMapTileUrl,
  type LonLatToImage,
  type TileCell,
} from './tileRenderer';

// ── Independent Web Mercator maths (y down) ─────────────────────────────

const RAD = Math.PI / 180;
const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / Math.PI) / 2;

function tileOf(z: number, lon: number, lat: number): { x: number; y: number } {
  const n = 2 ** z;
  return { x: Math.floor(mercX(lon) * n), y: Math.floor(mercY(lat) * n) };
}

function tilePxToLonLat(z: number, x: number, y: number, tilePx: number, u: number, v: number): [number, number] {
  const n = 2 ** z;
  const mx = (x + u / tilePx) / n;
  const my = (y + v / tilePx) / n;
  return [mx * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) / RAD];
}

const apply = (m: Affine, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cellAt = (cells: TileCell[], u: number, v: number) =>
  cells.find(({ rect: [x0, y0, x1, y1] }) => u >= x0 && u < x1 && v >= y0 && v < y1);

/** Worst tile-px error of a plan at `count` random tile points (truth = f itself). */
function worstError(
  f: LonLatToImage,
  cells: TileCell[],
  z: number,
  x: number,
  y: number,
  tilePx: number,
  count = 200,
  seed = 7,
): number {
  const rnd = mulberry32(seed);
  let worst = 0;
  for (let i = 0; i < count; i++) {
    const u = rnd() * tilePx;
    const v = rnd() * tilePx;
    const cell = cellAt(cells, u, v);
    expect(cell, `no cell covers ${u},${v}`).toBeDefined();
    const [lon, lat] = tilePxToLonLat(z, x, y, tilePx, u, v);
    const [ix, iy] = f(lon, lat);
    const [pu, pv] = apply(cell!.imageToTile, ix, iy);
    worst = Math.max(worst, Math.hypot(pu - u, pv - v));
  }
  return worst;
}

/**
 * A UTM-gridded sheet like the real incident maps: image px = UTM metres
 * scaled to `longSidePx` across the frame, turned by `rotDeg`, origin at
 * the frame's top-left.
 */
function utmSheet(
  centerLon: number,
  centerLat: number,
  zone: number,
  widthM: number,
  heightM: number,
  longSidePx = 4096,
  rotDeg = 0.4,
): { f: LonLatToImage; width: number; height: number } {
  const [ec, nc] = lonLatToUtm(centerLon, centerLat, zone);
  const res = Math.max(widthM, heightM) / longSidePx;
  const width = Math.round(widthM / res);
  const height = Math.round(heightM / res);
  const cos = Math.cos(rotDeg * RAD);
  const sin = Math.sin(rotDeg * RAD);
  const f: LonLatToImage = (lon, lat) => {
    const [e, n] = lonLatToUtm(lon, lat, zone);
    const dx = (e - ec) / res;
    const dy = (nc - n) / res;
    return [width / 2 + cos * dx - sin * dy, height / 2 + sin * dx + cos * dy];
  };
  return { f, width, height };
}

// ── planTile ────────────────────────────────────────────────────────────

describe('planTile', () => {
  it('maps an affine-in-Mercator image with one exact cell', () => {
    const z = 10;
    const tilePx = 512;
    const worldPx = tilePx * 2 ** z;
    const M: Affine = [0.8, 0.3, -0.25, 0.9, -1000, 2000]; // world px → image px
    const f: LonLatToImage = (lon, lat) => apply(M, mercX(lon) * worldPx, mercY(lat) * worldPx);
    const { x, y } = tileOf(z, -120.5, 38.1);

    const cells = planTile(f, z, x, y, tilePx);
    expect(cells).toHaveLength(1);
    expect(cells[0].rect).toEqual([0, 0, tilePx, tilePx]);

    // imageToTile is M⁻¹ followed by the shift from world px to this tile's px.
    const [a, b, c, d, e, g] = M;
    const det = a * d - b * c;
    const inv: Affine = [d / det, -b / det, -c / det, a / det, (c * g - d * e) / det, (b * e - a * g) / det];
    const expected: Affine = [inv[0], inv[1], inv[2], inv[3], inv[4] - x * tilePx, inv[5] - y * tilePx];
    cells[0].imageToTile.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6));
    expect(worstError(f, cells, z, x, y, tilePx)).toBeLessThan(1e-6);
  });

  it('subdivides a 157 km UTM sheet at low zoom and stays under tolPx', () => {
    // BAM-like 72 × 72 in sheet: 157 km square at 42.5°N, UTM zone 11.
    const { f } = utmSheet(-116.4, 42.5, 11, 157_000, 156_000);
    let subdivided = false;
    for (const z of [5, 6, 7, 8]) {
      for (const tilePx of [256, 512]) {
        // The tile holding the centre and the one holding the frame's NW corner.
        for (const [lon, lat] of [[-116.4, 42.5], [-117.35, 43.2]]) {
          const { x, y } = tileOf(z, lon, lat);
          const cells = planTile(f, z, x, y, tilePx);
          if (cells.length > 1) subdivided = true;
          expect(worstError(f, cells, z, x, y, tilePx, 200, z * 1000 + tilePx)).toBeLessThan(0.35);
        }
      }
    }
    expect(subdivided).toBe(true);
    // z6 at 512 px: one affine is several px off, so the tile must split.
    const { x, y } = tileOf(6, -116.4, 42.5);
    expect(planTile(f, 6, x, y, 512).length).toBeGreaterThan(1);
  });

  it('stays under tolPx near a UTM zone edge', () => {
    // 3.4° east of the central meridian: the grid is turned ~2.3° from north.
    const { f } = utmSheet(-113.6, 44, 11, 60_000, 45_000, 4096, 0);
    for (const z of [7, 9, 11]) {
      const { x, y } = tileOf(z, -113.6, 44);
      const cells = planTile(f, z, x, y, 512);
      expect(worstError(f, cells, z, x, y, 512, 200, z)).toBeLessThan(0.35);
    }
  });

  it('needs no subdivision at z14 for a 30 km sheet', () => {
    // Elk-like 8.5 × 11 sheet: 28 × 30 km at 38.1°N, UTM zone 10.
    const { f } = utmSheet(-120.5, 38.1, 10, 28_000, 30_300);
    for (const tilePx of [256, 512]) {
      for (const [lon, lat] of [[-120.5, 38.1], [-120.66, 38.236], [-120.34, 37.97]]) {
        const { x, y } = tileOf(14, lon, lat);
        const cells = planTile(f, 14, x, y, tilePx);
        expect(cells).toHaveLength(1);
        expect(worstError(f, cells, 14, x, y, tilePx)).toBeLessThan(0.05);
      }
    }
  });

  it('skips cells where the projection gives NaN or Infinity, without throwing', () => {
    const z = 12;
    const tilePx = 512;
    const { x, y } = tileOf(z, -120.5, 38.1);
    const worldPx = tilePx * 2 ** z;
    const good: LonLatToImage = (lon, lat) => [mercX(lon) * worldPx, mercY(lat) * worldPx];
    // Bad east of tile px u = 300 (not on a cell boundary).
    const [cutLon] = tilePxToLonLat(z, x, y, tilePx, 300, 0);
    const halfBad: LonLatToImage = (lon, lat) => (lon > cutLon ? [NaN, 0] : good(lon, lat));

    const cells = planTile(halfBad, z, x, y, tilePx);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.imageToTile.every(Number.isFinite)).toBe(true);
      expect(cell.rect[2]).toBeLessThanOrEqual(300);
    }
    // Everything west of the cut that a whole max-depth cell can cover is covered.
    for (let u = 0; u < 256; u += 16) {
      for (let v = 0; v < tilePx; v += 16) expect(cellAt(cells, u + 1, v + 1)).toBeDefined();
    }

    expect(planTile(() => [NaN, NaN], z, x, y, tilePx)).toEqual([]);
    expect(planTile(() => [Infinity, 0], z, x, y, tilePx)).toEqual([]);
    expect(
      planTile(() => {
        throw new Error('outside the projection');
      }, z, x, y, tilePx),
    ).toEqual([]);
  });

  it('drops a cell whose affine is degenerate', () => {
    expect(planTile(() => [5, 5], 10, 100, 200, 256)).toEqual([]);
  });
});

// ── Small pure helpers ──────────────────────────────────────────────────

describe('tile URL + bounds', () => {
  it('builds and strictly parses rdusermap URLs', () => {
    expect(USER_MAP_PROTOCOL).toBe('rdusermap');
    expect(userMapTileUrl('0123456789abcdef-p2')).toBe('rdusermap://0123456789abcdef-p2/{z}/{x}/{y}');
    expect(parseUserMapTileUrl('rdusermap://0123456789abcdef-p2/12/654/1583')).toEqual({
      id: '0123456789abcdef-p2',
      z: 12,
      x: 654,
      y: 1583,
    });
    for (const bad of [
      'rdusermap://abc/12/654',
      'rdusermap://abc/12/654/1583/9',
      'rdusermap://abc/12/4096/0', // x out of range
      'rdusermap://abc/2/0/-1',
      'rdusermap://abc/012/1/1',
      'rdusermap://a/b/1/1/1',
      'rdusermap://ab%2F/1/1/1',
      'pmtiles://abc/1/1/1',
      'rdusermap://abc/31/0/0',
      ' rdusermap://abc/1/1/1',
    ]) {
      expect(parseUserMapTileUrl(bad), bad).toBeNull();
    }
  });

  it('rejects tiles far outside the map bounds', () => {
    const bounds: [number, number, number, number] = [-120.66, 37.97, -120.34, 38.24];
    const inside = tileOf(12, -120.5, 38.1);
    expect(tileIntersectsBounds(bounds, 12, inside.x, inside.y)).toBe(true);
    const far = tileOf(12, -100, 45);
    expect(tileIntersectsBounds(bounds, 12, far.x, far.y)).toBe(false);
    const neighbour = tileOf(12, -120.7, 38.1); // just west of the frame
    expect(tileIntersectsBounds(bounds, 12, neighbour.x - 1, neighbour.y)).toBe(false);
    expect(tileIntersectsBounds(bounds, 0, 0, 0)).toBe(true);
    expect(tileIntersectsBounds([NaN, NaN, NaN, NaN], 0, 0, 0)).toBe(false);
  });

  it('picks 512 px tiles on dense screens', () => {
    expect(tilePixelSize(1)).toBe(256);
    expect(tilePixelSize(1.49)).toBe(256);
    expect(tilePixelSize(1.5)).toBe(512);
    expect(tilePixelSize(3)).toBe(512);
    expect(tilePixelSize()).toBe(256); // node: no devicePixelRatio
  });

  it('halves the pyramid rounding up and never picks an upsampled level', () => {
    expect(pyramidSizes(5, 3)).toEqual([[5, 3], [3, 2], [2, 1], [1, 1]]);
    expect(pickPyramidLevel(4000, 3000, 0.5)).toBe(0);
    expect(pickPyramidLevel(4000, 3000, 1.99)).toBe(0);
    expect(pickPyramidLevel(4000, 3000, 2)).toBe(1);
    expect(pickPyramidLevel(4000, 3000, 7.9)).toBe(2);
    expect(pickPyramidLevel(4000, 3000, 8)).toBe(3);
    expect(pickPyramidLevel(4000, 3000, 1e9)).toBe(pyramidSizes(4000, 3000).length - 1);
  });
});

// ── Protocol handler, with fake canvases + bitmaps ──────────────────────

class FakeBitmap {
  closed = false;
  constructor(
    public width: number,
    public height: number,
    public draws: Draw[] = [],
  ) {}
  close() {
    this.closed = true;
  }
}

interface Draw {
  clip: number[];
  transform: number[];
  image: FakeBitmap;
  src: number[];
}

const canvases: { width: number; height: number }[] = [];

class FakeCtx {
  imageSmoothingEnabled = false;
  imageSmoothingQuality = 'low';
  draws: Draw[] = [];
  private transform = [1, 0, 0, 1, 0, 0];
  private clipRect: number[] = [];
  private stack: { transform: number[]; clipRect: number[] }[] = [];
  save() {
    this.stack.push({ transform: this.transform, clipRect: this.clipRect });
  }
  restore() {
    const s = this.stack.pop()!;
    this.transform = s.transform;
    this.clipRect = s.clipRect;
  }
  beginPath() {}
  rect(x: number, y: number, w: number, h: number) {
    this.clipRect = [x, y, x + w, y + h];
  }
  clip() {}
  setTransform(...m: number[]) {
    this.transform = m;
  }
  drawImage(image: FakeBitmap, ...args: number[]) {
    expect(image.closed).toBe(false);
    expect(this.imageSmoothingEnabled).toBe(true);
    expect(this.imageSmoothingQuality).toBe('high');
    this.draws.push({ clip: this.clipRect, transform: this.transform, image, src: args });
  }
}

class FakeOffscreenCanvas {
  ctx = new FakeCtx();
  constructor(
    public width: number,
    public height: number,
  ) {
    canvases.push({ width, height });
  }
  getContext() {
    return this.ctx;
  }
  transferToImageBitmap() {
    return new FakeBitmap(this.width, this.height, this.ctx.draws);
  }
}

describe('rdusermap protocol handler', () => {
  // The frame is linear in Web Mercator, so tile maths is easy to check.
  const IMG_W = 4000;
  const IMG_H = 3000;
  const W = -120.6;
  const E = -120.4;
  const N = 38.2;
  const S = 38.08;
  const imageOf: LonLatToImage = (lon, lat) => [
    ((mercX(lon) - mercX(W)) / (mercX(E) - mercX(W))) * IMG_W,
    ((mercY(lat) - mercY(N)) / (mercY(S) - mercY(N))) * IMG_H,
  ];
  const meta = (id = '0123456789abcdef-p1'): UserMapMeta =>
    ({
      v: 1,
      id,
      docId: id.split('-')[0],
      page: 1,
      image: { width: IMG_W, height: IMG_H, bytes: 1, pageToImage: [2, 0, 0, 2, 0, 0], budgetPx: 12e6 },
      georef: { v: 1, wkt: null, frame: [0, 0, 2000, 1500], points: [], warnings: [] },
      bounds: [W, S, E, N],
      center: [(W + E) / 2, (S + N) / 2],
      addedAt: '2026-10-16T00:00:00Z',
    }) as unknown as UserMapMeta;

  let handler: (params: { url: string }, ac: AbortController) => Promise<{ data: FakeBitmap }>;
  let metas: Map<string, UserMapMeta>;
  const decoded: FakeBitmap[] = [];

  const tile = (id: string, z: number, lon: number, lat: number, ac = new AbortController()) => {
    const { x, y } = tileOf(z, lon, lat);
    return { x, y, result: handler({ url: `rdusermap://${id}/${z}/${x}/${y}` }, ac) };
  };

  beforeEach(() => {
    releaseUserMapImages();
    canvases.length = 0;
    decoded.length = 0;
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (blob: { w: number; h: number }) => {
        const b = new FakeBitmap(blob.w, blob.h);
        decoded.push(b);
        return b;
      }),
    );
    vi.mocked(readPageImage).mockReset();
    vi.mocked(readPageImage).mockImplementation(async () => ({ w: IMG_W, h: IMG_H }) as unknown as Blob);
    vi.mocked(buildGeoModel).mockReset();
    vi.mocked(buildGeoModel).mockImplementation(
      () =>
        ({
          lonLatToPage: (lon: number, lat: number) => {
            const [ix, iy] = imageOf(lon, lat);
            return [ix / 2, iy / 2]; // pageToImage is ×2
          },
        }) as unknown as GeoModel,
    );
    metas = new Map([meta(), meta('fedcba9876543210-p3')].map((m) => [m.id, m]));
    const addProtocol = vi.fn();
    registerUserMapProtocol(addProtocol, (id) => metas.get(id));
    expect(addProtocol).toHaveBeenCalledTimes(1);
    expect(addProtocol.mock.calls[0][0]).toBe('rdusermap');
    handler = addProtocol.mock.calls[0][1];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers once per addProtocol and follows the latest getMeta', async () => {
    const addProtocol = vi.fn();
    registerUserMapProtocol(addProtocol, () => undefined);
    registerUserMapProtocol(addProtocol, (id) => metas.get(id));
    expect(addProtocol).toHaveBeenCalledTimes(1);
    const { result } = tile('0123456789abcdef-p1', 14, -120.5, 38.15);
    await expect(result).resolves.toBeTruthy();
  });

  it('rejects bad URLs and maps that are gone', async () => {
    await expect(handler({ url: 'rdusermap://x/1/2' }, new AbortController())).rejects.toThrow();
    await expect(tile('0000000000000000-p9', 12, -120.5, 38.15).result).rejects.toThrow();
  });

  it('returns a transparent tile far outside the map without reading the image', async () => {
    const { data } = await tile('0123456789abcdef-p1', 12, -100, 45).result;
    expect(data).toBeInstanceOf(FakeBitmap);
    expect([data.width, data.height]).toEqual([256, 256]);
    expect(data.draws).toEqual([]);
    expect(readPageImage).not.toHaveBeenCalled();
  });

  it('draws a tile through the true projection and decodes the JPEG once', async () => {
    const [a, b, c] = await Promise.all([
      tile('0123456789abcdef-p1', 14, -120.5, 38.15).result,
      tile('0123456789abcdef-p1', 14, -120.45, 38.15).result,
      tile('0123456789abcdef-p1', 14, -120.5, 38.1).result,
    ]);
    expect(readPageImage).toHaveBeenCalledTimes(1);
    expect(readPageImage).toHaveBeenCalledWith('0123456789abcdef', 1);
    for (const r of [a, b, c]) {
      expect([r.data.width, r.data.height]).toEqual([256, 256]);
      expect(r.data.draws.length).toBeGreaterThan(0);
    }

    // The canvas transform maps level px to the right tile px.
    const z = 14;
    const { x, y, result } = tile('0123456789abcdef-p1', z, -120.47, 38.13);
    const { data } = await result;
    const rnd = mulberry32(3);
    for (let i = 0; i < 50; i++) {
      const u = rnd() * 256;
      const v = rnd() * 256;
      const draw = data.draws.find(
        ({ clip: [x0, y0, x1, y1] }) => u >= x0 && u < x1 && v >= y0 && v < y1,
      )!;
      expect(draw).toBeDefined();
      const sx = draw.image.width / IMG_W;
      const sy = draw.image.height / IMG_H;
      const [ix, iy] = imageOf(...tilePxToLonLat(z, x, y, 256, u, v));
      const [pu, pv] = apply(draw.transform as Affine, ix * sx, iy * sy);
      expect(Math.hypot(pu - u, pv - v)).toBeLessThan(0.35);
      // The source rect covers the sampled point.
      const [s0, t0, sw, sh] = draw.src;
      expect(ix * sx).toBeGreaterThanOrEqual(s0);
      expect(ix * sx).toBeLessThanOrEqual(s0 + sw);
      expect(iy * sy).toBeGreaterThanOrEqual(t0);
      expect(iy * sy).toBeLessThanOrEqual(t0 + sh);
    }
  });

  it('draws zoomed-out tiles from a halved copy, at least 1 source px per tile px', async () => {
    // z10: the 17.6 km frame is ~66 tile px wide → ~60 source px per tile px.
    const { data } = await tile('0123456789abcdef-p1', 10, -120.5, 38.15).result;
    expect(data.draws.length).toBeGreaterThan(0);
    const level = data.draws[0].image;
    expect(level.width).toBeLessThan(IMG_W);
    const sizes = pyramidSizes(IMG_W, IMG_H);
    const k = sizes.findIndex(([w, h]) => w === level.width && h === level.height);
    expect(k).toBeGreaterThan(0);
    // One level smaller would upsample.
    const [a, b] = data.draws[0].transform;
    const tilePxPerLevelPx = Math.hypot(a, b);
    expect(1 / tilePxPerLevelPx).toBeGreaterThanOrEqual(1);
    expect((sizes[k + 1][0] / level.width) / tilePxPerLevelPx).toBeLessThan(1);
    // Every level up to k was built once, by halving.
    expect(canvases.slice(0, k).map((cv) => [cv.width, cv.height])).toEqual(sizes.slice(1, k + 1));

    // A second zoomed-out tile reuses the pyramid.
    const built = canvases.length;
    await tile('0123456789abcdef-p1', 10, -120.41, 38.09).result;
    expect(canvases.length).toBe(built + 1); // just the output tile
  });

  it('paints 512 px tiles on dense screens', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { data } = await tile('0123456789abcdef-p1', 14, -120.5, 38.15).result;
    expect([data.width, data.height]).toEqual([512, 512]);
  });

  it('honours an abort before and during the image read', async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(tile('0123456789abcdef-p1', 14, -120.5, 38.15, pre).result).rejects.toMatchObject({
      name: 'AbortError',
    });

    let release!: () => void;
    vi.mocked(readPageImage).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ w: IMG_W, h: IMG_H } as unknown as Blob);
        }),
    );
    const ac = new AbortController();
    const pending = tile('0123456789abcdef-p1', 14, -120.5, 38.15, ac).result;
    await vi.waitFor(() => expect(readPageImage).toHaveBeenCalled());
    ac.abort();
    release();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('retries the image read after a failure', async () => {
    vi.mocked(readPageImage).mockResolvedValueOnce(null);
    await expect(tile('0123456789abcdef-p1', 14, -120.5, 38.15).result).rejects.toThrow();
    await expect(tile('0123456789abcdef-p1', 14, -120.5, 38.15).result).resolves.toBeTruthy();
    expect(readPageImage).toHaveBeenCalledTimes(2);
  });

  it('closes the images of maps no longer shown, keeping the one asked for', async () => {
    await tile('0123456789abcdef-p1', 10, -120.5, 38.15).result; // builds a pyramid
    await tile('fedcba9876543210-p3', 14, -120.5, 38.15).result;
    const levels = canvases.length;
    expect(decoded).toHaveLength(2);

    releaseUserMapImages('fedcba9876543210-p3');
    await Promise.resolve();
    await Promise.resolve();
    expect(decoded[0].closed).toBe(true);
    expect(decoded[1].closed).toBe(false);

    // The released map decodes again on its next tile; the kept one doesn't.
    await tile('fedcba9876543210-p3', 14, -120.45, 38.15).result;
    expect(readPageImage).toHaveBeenCalledTimes(2);
    await tile('0123456789abcdef-p1', 10, -120.5, 38.15).result;
    expect(readPageImage).toHaveBeenCalledTimes(3);
    expect(canvases.length).toBeGreaterThan(levels + 2); // pyramid rebuilt

    releaseUserMapImages(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(decoded.every((b) => b.closed)).toBe(true);
  });

  it('aborts a tile whose map is released mid-render', async () => {
    let release!: () => void;
    vi.mocked(readPageImage).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ w: IMG_W, h: IMG_H } as unknown as Blob);
        }),
    );
    const pending = tile('0123456789abcdef-p1', 14, -120.5, 38.15).result;
    await vi.waitFor(() => expect(readPageImage).toHaveBeenCalled());
    releaseUserMapImages();
    release();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(decoded[0]?.closed).toBe(true));
  });
});
