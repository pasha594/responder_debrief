/**
 * "My maps" raster tiles, painted in the browser from the stored JPEG.
 *
 * A user map is a JPEG of one GeoPDF map frame (./storage) plus that
 * frame's georeferencing (./georef). MapLibre shows it as an ordinary
 * raster source whose tile URLs use a custom scheme,
 * rdusermap://{id}/{z}/{x}/{y}. maplibregl.addProtocol routes those URLs
 * to this module on the main thread. The module paints each tile through
 * the map's real projection and returns an ImageBitmap, which MapLibre
 * passes straight through (maplibre-gl/src/util/image_request.ts:166).
 *
 * Why tiles and not a 4-corner image source: MapLibre draws an image
 * source as two affine triangles in Mercator. Measured against GDAL, that
 * is about 27 m off on a 28 × 30 km sheet and 0.9 to 3.6 km off on area
 * maps. An image source also renders an opaque black quad above
 * MAX_TEXTURE_SIZE. Tiles have no texture limit, are transparent outside
 * the frame, and land where GDAL puts them.
 *
 * Why a protocol URL and not a blob: URL: a theme change, or regaining
 * signal, runs setStyle, which re-adds every rd- source from its
 * serialized spec. A protocol URL reloads from the device. A revoked
 * blob: URL breaks with no error.
 *
 * How a tile is painted:
 * - planTile splits the tile into at most 8 × 8 cells.
 * - In each cell, one affine map (image px → tile px) is within ~0.35
 *   tile px of the true projection.
 * - Each cell is clipped to its integer rectangle, and the JPEG is drawn
 *   through that cell's affine.
 * - The JPEG is decoded once per map. Halved copies (a lazy pyramid) keep
 *   zoomed-out tiles from sampling a 12 MP bitmap. Each tile draws from
 *   the smallest copy that is still at least 1 source px per tile px.
 *
 * Tiles are square powers of two (256 or 512 px). That is fine here:
 * MapLibre uploads raster tiles with mipmaps. The square power-of-two
 * black-texture bug only affects image sources that switch filters.
 */
import type { addProtocol as maplibreAddProtocol } from 'maplibre-gl';
import { buildGeoModel } from './georef';
import { readPageImage } from './storage';
import type { Affine, Box, UserMapMeta } from './types';

export const USER_MAP_PROTOCOL = 'rdusermap';

/** The raster source's `tiles` template for one user map. */
export function userMapTileUrl(id: string): string {
  return `${USER_MAP_PROTOCOL}://${id}/{z}/{x}/{y}`;
}

/**
 * Device px per painted tile. The source's tileSize is always 256, so a
 * 512 px bitmap is a sharp @2x tile on high-density screens.
 */
export function tilePixelSize(dpr: number = globalThis.devicePixelRatio ?? 1): number {
  return dpr >= 1.5 ? 512 : 256;
}

// ── URL + tile maths ────────────────────────────────────────────────────

const TILE_URL = new RegExp(
  `^${USER_MAP_PROTOCOL}://([A-Za-z0-9_-]{1,128})/(0|[1-9]\\d?)/(0|[1-9]\\d{0,9})/(0|[1-9]\\d{0,9})$`,
);

/** Strict parse of rdusermap://{id}/{z}/{x}/{y}; null for anything else. */
export function parseUserMapTileUrl(
  url: string,
): { id: string; z: number; x: number; y: number } | null {
  const m = TILE_URL.exec(url);
  if (!m) return null;
  const z = Number(m[2]);
  const x = Number(m[3]);
  const y = Number(m[4]);
  if (z > 30) return null;
  const n = 2 ** z;
  if (x >= n || y >= n) return null;
  return { id: m[1], z, x, y };
}

/** Latitude of a Web Mercator tile row edge (y may be fractional; y down). */
function mercatorLat(y: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
}

/** WGS84 [w, s, e, n] of tile z/x/y. */
export function tileBounds(z: number, x: number, y: number): Box {
  const n = 2 ** z;
  return [(x / n) * 360 - 180, mercatorLat(y + 1, n), ((x + 1) / n) * 360 - 180, mercatorLat(y, n)];
}

/** False when tile z/x/y can't touch `bounds` ([w, s, e, n]; NaN bounds never touch). */
export function tileIntersectsBounds(bounds: Box, z: number, x: number, y: number): boolean {
  const [w, s, e, n] = tileBounds(z, x, y);
  return w < bounds[2] && e > bounds[0] && s < bounds[3] && n > bounds[1];
}

// ── Affine helpers (canvas order: x' = a·x + c·y + e, y' = b·x + d·y + f) ─

function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function invertAffine(m: Affine): Affine | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0 || !Number.isFinite(det)) return null;
  const inv: Affine = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
  return inv.every(Number.isFinite) ? inv : null;
}

// ── Planning (pure) ─────────────────────────────────────────────────────

export type LonLatToImage = (lon: number, lat: number) => [number, number];

/** One planned cell of a tile. */
export interface TileCell {
  /** Integer tile-px rectangle [x0, y0, x1, y1] (clip region). */
  rect: [number, number, number, number];
  /** Image px → tile px: the least-squares affine through the cell's four true corners. */
  imageToTile: Affine;
}

/**
 * Plan how to paint tile z/x/y (Web Mercator, y down) at tilePx per side.
 *
 * Starting from the whole tile, each cell gets one affine map, fitted by
 * least squares to the true image positions of its four corners. The fit
 * is checked at those corners, the centre and the four edge midpoints;
 * together those see every quadratic term of the warp. The cell splits
 * 2 × 2, up to maxDepth levels, while any check point lands more than
 * tolPx tile px from where the affine puts it.
 *
 * Why four corners and not three: an affine through three exact corners
 * puts the whole twist of the warp on the fourth corner. Spreading it
 * cuts the worst error about 4×. On a 157 km UTM sheet at z5 with 512 px
 * tiles, the 8 × 8 limit then gives 0.29 px instead of 1.15 px.
 *
 * Non-finite or throwing lonLatToImage results are not fatal:
 * - A cell whose points are all bad is dropped.
 * - A partly bad cell is split, and at maxDepth it is dropped.
 * So a projection that fails over part of the tile leaves that part
 * transparent.
 */
export function planTile(
  lonLatToImage: LonLatToImage,
  z: number,
  x: number,
  y: number,
  tilePx: number,
  maxDepth = 3,
  tolPx = 0.35,
): TileCell[] {
  const n = 2 ** z;
  const memo = new Map<string, [number, number] | null>();
  /** True image px of tile px (u, v), or null when unusable. */
  const at = (u: number, v: number): [number, number] | null => {
    const key = `${u},${v}`;
    let hit = memo.get(key);
    if (hit !== undefined) return hit;
    const lon = ((x + u / tilePx) / n) * 360 - 180;
    const lat = mercatorLat(y + v / tilePx, n);
    hit = null;
    try {
      const p = lonLatToImage(lon, lat);
      if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) hit = [p[0], p[1]];
    } catch {
      hit = null;
    }
    memo.set(key, hit);
    return hit;
  };

  const cells: TileCell[] = [];
  const visit = (u0: number, v0: number, size: number, depth: number): void => {
    const u1 = u0 + size;
    const v1 = v0 + size;
    const um = u0 + size / 2;
    const vm = v0 + size / 2;
    const tl = at(u0, v0);
    const tr = at(u1, v0);
    const bl = at(u0, v1);
    const br = at(u1, v1);
    const checks: [number, number, [number, number] | null][] = [
      [u0, v0, tl],
      [u1, v0, tr],
      [u0, v1, bl],
      [u1, v1, br],
      [um, vm, at(um, vm)],
      [um, v0, at(um, v0)],
      [u0, vm, at(u0, vm)],
      [u1, vm, at(u1, vm)],
      [um, v1, at(um, v1)],
    ];
    const canSplit = depth < maxDepth;
    const split = () => {
      const h = size / 2;
      visit(u0, v0, h, depth + 1);
      visit(u0 + h, v0, h, depth + 1);
      visit(u0, v0 + h, h, depth + 1);
      visit(u0 + h, v0 + h, h, depth + 1);
    };

    if (!tl || !tr || !bl || !br || checks.some((c) => !c[2])) {
      if (canSplit && checks.some((c) => c[2])) split();
      return;
    }

    // Least-squares affine (tile px → image px) through the four corners:
    // exact for an affine warp, and a quarter of the 3-corner fit's error
    // for the twist that dominates real warps.
    const a = (tr[0] + br[0] - tl[0] - bl[0]) / (2 * size);
    const b = (tr[1] + br[1] - tl[1] - bl[1]) / (2 * size);
    const c = (bl[0] + br[0] - tl[0] - tr[0]) / (2 * size);
    const d = (bl[1] + br[1] - tl[1] - tr[1]) / (2 * size);
    const mx = (tl[0] + tr[0] + bl[0] + br[0]) / 4;
    const my = (tl[1] + tr[1] + bl[1] + br[1]) / 4;
    const tileToImage: Affine = [a, b, c, d, mx - a * um - c * vm, my - b * um - d * vm];
    const imageToTile = invertAffine(tileToImage);
    if (!imageToTile) {
      if (canSplit) split();
      return;
    }

    if (canSplit) {
      for (const [u, v, img] of checks) {
        const [pu, pv] = applyAffine(imageToTile, img![0], img![1]);
        if (Math.hypot(pu - u, pv - v) > tolPx) {
          split();
          return;
        }
      }
    }

    const rect: [number, number, number, number] = [
      Math.round(u0),
      Math.round(v0),
      Math.round(u1),
      Math.round(v1),
    ];
    if (rect[2] > rect[0] && rect[3] > rect[1]) cells.push({ rect, imageToTile });
  };

  visit(0, 0, tilePx, 0);
  return cells;
}

/**
 * Pixels of a w × h image (per axis) that a cell samples, scaled by
 * (scaleX, scaleY) into a pyramid level. Padded for the smoothing filter,
 * and clamped to the image. Null when the cell misses the image.
 */
function cellSourceRect(
  cell: TileCell,
  scaleX: number,
  scaleY: number,
  w: number,
  h: number,
): [number, number, number, number] | null {
  const tileToImage = invertAffine(cell.imageToTile);
  if (!tileToImage) return null;
  const [x0, y0, x1, y1] = cell.rect;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [u, v] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    const [ix, iy] = applyAffine(tileToImage, u, v);
    minX = Math.min(minX, ix * scaleX);
    maxX = Math.max(maxX, ix * scaleX);
    minY = Math.min(minY, iy * scaleY);
    maxY = Math.max(maxY, iy * scaleY);
  }
  // A few px beyond the cell so the clip, not the source rect, makes the
  // edge (drawImage clamps sampling to the source rect).
  const PAD = 4;
  const sx0 = Math.max(0, Math.floor(minX) - PAD);
  const sy0 = Math.max(0, Math.floor(minY) - PAD);
  const sx1 = Math.min(w, Math.ceil(maxX) + PAD);
  const sy1 = Math.min(h, Math.ceil(maxY) + PAD);
  return sx1 > sx0 && sy1 > sy0 ? [sx0, sy0, sx1, sy1] : null;
}

/** Fewest image px per tile px over the cells, in any direction (1 / largest singular value). */
function sourcePxPerTilePx(cells: TileCell[]): number {
  let s = Infinity;
  for (const { imageToTile: [a, b, c, d] } of cells) {
    const t = a * a + b * b + c * c + d * d;
    const det = a * d - b * c;
    const sMax = Math.sqrt((t + Math.sqrt(Math.max(0, t * t - 4 * det * det))) / 2);
    s = Math.min(s, 1 / sMax);
  }
  return s;
}

/** Sizes of pyramid levels 0…k: each level is the previous one halved, rounded up, down to 1 × 1. */
export function pyramidSizes(width: number, height: number): [number, number][] {
  const sizes: [number, number][] = [[width, height]];
  let [w, h] = sizes[0];
  while (w > 1 || h > 1) {
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
    sizes.push([w, h]);
  }
  return sizes;
}

/**
 * The smallest pyramid level that still has at least 1 source px per tile
 * px, given srcPxPerTilePx at level 0. The largest such k never
 * upsamples from a small level while a bigger one exists.
 */
export function pickPyramidLevel(width: number, height: number, srcPxPerTilePx: number): number {
  const sizes = pyramidSizes(width, height);
  let k = 0;
  while (
    k + 1 < sizes.length &&
    srcPxPerTilePx * Math.min(sizes[k + 1][0] / width, sizes[k + 1][1] / height) >= 1
  ) {
    k++;
  }
  return k;
}

// ── Canvas plumbing ─────────────────────────────────────────────────────

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

interface Surface {
  ctx: Ctx2D;
  /** Snapshot as an ImageBitmap and release the canvas. */
  finish(): Promise<ImageBitmap>;
}

/** A w × h 2D canvas: OffscreenCanvas when it has a 2D context, else a DOM canvas. */
function surface(w: number, h: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (ctx) return { ctx, finish: async () => canvas.transferToImageBitmap() };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas available to draw the map');
  return {
    ctx,
    finish: async () => {
      try {
        return await createImageBitmap(canvas);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
  };
}

function smooth(ctx: Ctx2D): void {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

function blankTile(tilePx: number): Promise<ImageBitmap> {
  return surface(tilePx, tilePx).finish();
}

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

const isAbort = (err: unknown) => err instanceof Error && err.name === 'AbortError';

// ── Per-map cache: model, decoded JPEG, lazy pyramid ────────────────────

interface Entry {
  /** Changes when the stored map is replaced under the same id. */
  sig: string;
  meta: UserMapMeta;
  lonLatToImage: LonLatToImage;
  base: Promise<ImageBitmap> | null;
  /** levels[k] for k ≥ 1; level 0 is `base`. */
  levels: (Promise<ImageBitmap> | undefined)[];
  released: boolean;
}

/** Only one user map shows at a time; keep the outgoing one too while tiles cross-fade. */
const MAX_CACHED = 2;
const cache = new Map<string, Entry>();

const signature = (m: UserMapMeta) => `${m.addedAt}|${m.image.width}x${m.image.height}`;

function entryFor(meta: UserMapMeta): Entry {
  const sig = signature(meta);
  const hit = cache.get(meta.id);
  if (hit && hit.sig === sig) {
    cache.delete(meta.id); // LRU bump
    cache.set(meta.id, hit);
    return hit;
  }
  if (hit) releaseEntry(meta.id, hit);

  // A copy, so buildGeoModel's warning bookkeeping never mutates store state.
  const model = buildGeoModel({ ...meta.georef, warnings: [...meta.georef.warnings] });
  const [a, b, c, d, e, f] = meta.image.pageToImage;
  const lonLatToImage: LonLatToImage = (lon, lat) => {
    const [px, py] = model.lonLatToPage(lon, lat);
    return [a * px + c * py + e, b * px + d * py + f];
  };
  const entry: Entry = { sig, meta, lonLatToImage, base: null, levels: [], released: false };
  cache.set(meta.id, entry);
  while (cache.size > MAX_CACHED) {
    const [oldId, old] = cache.entries().next().value as [string, Entry];
    releaseEntry(oldId, old);
  }
  return entry;
}

function baseBitmap(id: string, entry: Entry): Promise<ImageBitmap> {
  if (!entry.base) {
    const { docId, page } = entry.meta;
    const p = readPageImage(docId, page).then((blob) => {
      if (!blob) throw new Error('This map’s image is missing from this device');
      return createImageBitmap(blob);
    });
    entry.base = p;
    // A failed read is retried by the next tile, not cached forever.
    p.catch(() => {
      if (cache.get(id) === entry) cache.delete(id);
    });
  }
  return entry.base;
}

function levelBitmap(id: string, entry: Entry, k: number): Promise<ImageBitmap> {
  if (k === 0) return baseBitmap(id, entry);
  let p = entry.levels[k];
  if (!p) {
    p = levelBitmap(id, entry, k - 1).then((prev) => {
      if (entry.released) throw abortError();
      const w = Math.ceil(prev.width / 2);
      const h = Math.ceil(prev.height / 2);
      const s = surface(w, h);
      smooth(s.ctx);
      s.ctx.drawImage(prev, 0, 0, w, h);
      return s.finish();
    });
    entry.levels[k] = p;
    const mine = p;
    p.catch(() => {
      if (entry.levels[k] === mine) entry.levels[k] = undefined;
    });
  }
  return p;
}

function closeLater(p: Promise<ImageBitmap> | null | undefined): void {
  p?.then(
    (bitmap) => bitmap.close(),
    () => {},
  );
}

function releaseEntry(id: string, entry: Entry): void {
  entry.released = true;
  if (cache.get(id) === entry) cache.delete(id);
  closeLater(entry.base);
  entry.levels.forEach(closeLater);
  entry.levels.length = 0;
}

/** Close the decoded images (and pyramids) of every user map except keepId. */
export function releaseUserMapImages(keepId?: string | null): void {
  for (const [id, entry] of [...cache]) {
    if (id !== keepId) releaseEntry(id, entry);
  }
}

// ── Protocol handler ────────────────────────────────────────────────────

type AddProtocol = typeof maplibreAddProtocol;
type ProtocolAction = Parameters<AddProtocol>[1];

let getMetaFn: ((id: string) => UserMapMeta | undefined) | null = null;
let registeredWith: AddProtocol | null = null;

const loadUserMapTile: ProtocolAction = async (params, abortController) => {
  const { signal } = abortController;
  const req = parseUserMapTileUrl(params.url);
  if (!req) throw new Error('Not a My maps tile URL');
  const meta = getMetaFn?.(req.id);
  if (!meta) throw new Error('That map is no longer on this device');
  if (signal.aborted) throw abortError();

  const { z, x, y } = req;
  const tilePx = tilePixelSize();
  if (!tileIntersectsBounds(meta.bounds, z, x, y)) return { data: await blankTile(tilePx) };

  const entry = entryFor(meta);
  const { width: imgW, height: imgH } = meta.image;
  const cells = planTile(entry.lonLatToImage, z, x, y, tilePx).filter(
    (cell) => cellSourceRect(cell, 1, 1, imgW, imgH) !== null,
  );
  if (!cells.length) return { data: await blankTile(tilePx) };

  const alive = () => {
    if (signal.aborted || entry.released) throw abortError();
  };
  const base = await baseBitmap(req.id, entry);
  alive();
  // Source px per tile px in the decoded bitmap's own px (normally == meta's).
  const decodedScale = Math.min(base.width / imgW, base.height / imgH);
  const k = pickPyramidLevel(base.width, base.height, sourcePxPerTilePx(cells) * decodedScale);
  let level = base;
  if (k > 0) {
    try {
      level = await levelBitmap(req.id, entry, k);
    } catch (err) {
      if (isAbort(err)) throw err;
      level = base; // No room for a halved copy: draw from the full image.
    }
    alive();
  }

  const sx = level.width / imgW;
  const sy = level.height / imgH;
  const out = surface(tilePx, tilePx);
  const { ctx } = out;
  smooth(ctx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const cell of cells) {
    const src = cellSourceRect(cell, sx, sy, level.width, level.height);
    if (!src) continue;
    const [x0, y0, x1, y1] = cell.rect;
    const [a, b, c, d, e, f] = cell.imageToTile;
    const [s0, t0, s1, t1] = src;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.setTransform(a / sx, b / sx, c / sy, d / sy, e, f);
    ctx.drawImage(level, s0, t0, s1 - s0, t1 - t0, s0, t0, s1 - s0, t1 - t0);
    ctx.restore();
  }
  return { data: await out.finish() };
};

/**
 * Register the rdusermap protocol with MapLibre. It is safe to call on
 * every mount: the handler is added once per addProtocol function, and
 * the latest getMeta always wins.
 */
export function registerUserMapProtocol(
  addProtocol: AddProtocol,
  getMeta: (id: string) => UserMapMeta | undefined,
): void {
  getMetaFn = getMeta;
  if (registeredWith === addProtocol) return;
  addProtocol(USER_MAP_PROTOCOL, loadUserMapTile);
  registeredWith = addProtocol;
}
