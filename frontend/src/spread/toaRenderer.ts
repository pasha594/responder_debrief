/**
 * Time-of-arrival renderer: decodes a {pct}.tif from the public forecast
 * archive (float32, per-fire UTM grid, values = HOURS since forecast start,
 * nodata 0) ONCE, then repaints an RGBA canvas in one of two modes from that
 * same decoded Float32Array — switching modes or dragging the reach slider
 * never re-fetches or re-decodes:
 *
 *   TIMELINE (renderAt / paintToa) — "what has burned as of the playhead":
 *     nodata → transparent, toa <= hours-recent → dark burned, hours-recent <
 *     toa <= hours → bright leading edge, toa > hours → transparent.
 *   WHOLE (renderWhole / paintToaBands) — "how long until it reaches here",
 *     for the entire run at once and independent of the playhead: nodata and
 *     toa > withinHours → transparent, else the discrete toaBands color for
 *     that arrival hour.
 *
 * Either paint pass is a simple typed-array loop over ≤1536² pixels (~5–15 ms);
 * the layer manager throttles calls with requestAnimationFrame, and both
 * modes reuse one ImageData buffer so slider drags stay smooth.
 *
 * Also hosts `decodeSpreadTiff`, the geotiff→grid decode shared with
 * productRenderer (both consume the same UTM grids).
 */
import { fromArrayBuffer } from 'geotiff';
import type { ToaRamp } from '../api/types';
import { TOA_BAND_ALPHA, TOA_BANDS, toaBandIndex } from './toaBands';
import { epsgToUtm, utmBoundsTo4326, type Corners } from './utm';

/** Decode cap: readRasters resamples on read to at most this width. */
export const MAX_DECODE_WIDTH = 1536;

/** Skip ToA repaints when the scrub moved less than this many model-hours. */
export const TOA_MIN_REPAINT_HOURS = 0.25;

/** Georeferencing of a decoded archive raster, ready for MapLibre. */
export interface SpreadGrid {
  /** Decoded (possibly downsampled) raster dimensions. */
  width: number;
  height: number;
  epsg: number;
  /** Native [minX, minY, maxX, maxY] in UTM meters. */
  bboxUtm: [number, number, number, number];
  /** Canvas-source corner pins TL,TR,BR,BL in [lon, lat]. */
  corners: Corners;
  /** Enclosing [w, s, e, n] EPSG:4326 bounds. */
  bounds: [number, number, number, number];
}

export interface DecodedTiff {
  grid: SpreadGrid;
  /** Band 0: Float32Array (ToA) or Uint8Array (hourly products). */
  values: Float32Array | Uint8Array;
}

/**
 * Decode band 0 of an archive GeoTIFF, downsampling on read to ≤ maxWidth
 * (aspect preserved), and derive the WGS84 corner pins from the UTM bbox +
 * 326xx/327xx geokey.
 */
export async function decodeSpreadTiff(
  buf: ArrayBuffer,
  maxWidth = MAX_DECODE_WIDTH,
): Promise<DecodedTiff> {
  const tiff = await fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const epsg: unknown = img.geoKeys?.ProjectedCSTypeGeoKey;
  const utm = typeof epsg === 'number' ? epsgToUtm(epsg) : null;
  if (!utm) throw new Error(`spread tif: unsupported CRS geokey ${String(epsg)}`);
  const bboxUtm = img.getBoundingBox() as [number, number, number, number];
  const nativeW = img.getWidth();
  const nativeH = img.getHeight();
  const width = Math.min(nativeW, maxWidth);
  const height = Math.max(1, Math.round((nativeH * width) / nativeW));
  const rasters = (await img.readRasters({ width, height })) as unknown as Array<
    Float32Array | Uint8Array
  >;
  const { corners, bounds } = utmBoundsTo4326(bboxUtm, utm.zone, utm.northern);
  return {
    grid: { width, height, epsg: epsg as number, bboxUtm, corners, bounds },
    values: rasters[0],
  };
}

// ---------- ToA colorize ----------

/** RGBA channels 0–255. */
export type Rgba = [number, number, number, number];

export interface ResolvedToaRamp {
  recentHours: number;
  burned: Rgba;
  recent: Rgba;
}

/** #rgb / #rrggbb → [r, g, b], or null on anything else. */
export function parseHexColor(css: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  const n = Number.parseInt(hex, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const BURNED_ALPHA = Math.round(0.55 * 255);
const RECENT_ALPHA = Math.round(0.85 * 255);

export const DEFAULT_TOA_RAMP: ResolvedToaRamp = {
  recentHours: 12,
  burned: [0x7a, 0x1f, 0x1f, BURNED_ALPHA],
  recent: [0xff, 0x6a, 0x2b, RECENT_ALPHA],
};

/** Resolve the manifest's toa_ramp hint (missing pieces → spec defaults). */
export function resolveToaRamp(ramp?: ToaRamp | null): ResolvedToaRamp {
  if (!ramp) return DEFAULT_TOA_RAMP;
  const byName = new Map(ramp.stops ?? []);
  const burnedRgb = parseHexColor(byName.get('burned') ?? '') ?? DEFAULT_TOA_RAMP.burned;
  const recentRgb = parseHexColor(byName.get('recent') ?? '') ?? DEFAULT_TOA_RAMP.recent;
  return {
    recentHours:
      Number.isFinite(ramp.recent_hours) && ramp.recent_hours > 0
        ? ramp.recent_hours
        : DEFAULT_TOA_RAMP.recentHours,
    burned: [burnedRgb[0], burnedRgb[1], burnedRgb[2], BURNED_ALPHA],
    recent: [recentRgb[0], recentRgb[1], recentRgb[2], RECENT_ALPHA],
  };
}

/**
 * Pure threshold paint (exported for tests): write RGBA for every pixel of
 * `values` into `out` (length 4 × values.length). Nodata is 0; NaN and
 * negative values are treated as nodata too (`v > 0` guards all three).
 * `hours` < 0 (scrub before run start) paints fully transparent.
 */
export function paintToa(
  values: ArrayLike<number>,
  hours: number,
  ramp: ResolvedToaRamp,
  out: Uint8ClampedArray,
): void {
  const edgeStart = hours - ramp.recentHours;
  const [br, bg, bb, ba] = ramp.burned;
  const [rr, rg, rb, ra] = ramp.recent;
  for (let i = 0, o = 0; i < values.length; i++, o += 4) {
    const v = values[i];
    if (v > 0 && v <= hours) {
      if (v <= edgeStart) {
        out[o] = br;
        out[o + 1] = bg;
        out[o + 2] = bb;
        out[o + 3] = ba;
      } else {
        out[o] = rr;
        out[o + 1] = rg;
        out[o + 2] = rb;
        out[o + 3] = ra;
      }
    } else {
      out[o + 3] = 0; // transparent; rgb left stale is fine at alpha 0
    }
  }
}

// ---------- Whole-prediction band colorize ----------

/**
 * TOA_BANDS resolved to RGBA once at module load — same order, same
 * boundaries, so a legend swatch and the pixels under it can never drift.
 */
export const TOA_BAND_RGBA: Rgba[] = TOA_BANDS.map((b) => {
  const rgb = parseHexColor(b.color) ?? [0, 0, 0];
  return [rgb[0], rgb[1], rgb[2], Math.round(TOA_BAND_ALPHA * 255)];
});

/**
 * Pure band paint (exported for tests): every pixel is filled with the color
 * of the band its arrival hour falls in. Nodata is 0; NaN and negatives are
 * nodata too (`v > 0` guards all three). Arrivals later than `withinHours`
 * are transparent — dragging that value down peels the prediction back toward
 * the ignition area. Note there is no time argument: whole mode cannot depend
 * on the playhead.
 */
export function paintToaBands(
  values: ArrayLike<number>,
  withinHours: number,
  out: Uint8ClampedArray,
  bands: Rgba[] = TOA_BAND_RGBA,
): void {
  for (let i = 0, o = 0; i < values.length; i++, o += 4) {
    const v = values[i];
    if (v > 0 && v <= withinHours) {
      const [r, g, b, a] = bands[toaBandIndex(v)];
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    } else {
      out[o + 3] = 0; // transparent; rgb left stale is fine at alpha 0
    }
  }
}

export interface ToaRendererOptions {
  /** Date.parse(run.run_time) — toa values are hours since this instant. */
  runStartMs: number;
  ramp?: ToaRamp | null;
}

export class ToaRenderer {
  readonly grid: SpreadGrid;
  private readonly values: Float32Array;
  private readonly ramp: ResolvedToaRamp;
  private readonly runStartMs: number;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private imageData: ImageData | null = null;
  /** What the canvas currently holds, so no-op repaints can be skipped. */
  private lastMode: 'timeline' | 'whole' | null = null;
  private lastHours: number | null = null;
  private lastWithin: number | null = null;

  constructor(grid: SpreadGrid, values: Float32Array, opts: ToaRendererOptions) {
    this.grid = grid;
    this.values = values;
    this.ramp = resolveToaRamp(opts.ramp);
    this.runStartMs = opts.runStartMs;
  }

  /** Fetch + decode a {pct}.tif. Throws on HTTP/decode/CRS errors. */
  static async load(url: string, opts: ToaRendererOptions): Promise<ToaRenderer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`toa tif ${res.status} for ${url}`);
    const { grid, values } = await decodeSpreadTiff(await res.arrayBuffer());
    if (!(values instanceof Float32Array)) {
      throw new Error('toa tif: expected a float32 band');
    }
    return new ToaRenderer(grid, values, opts);
  }

  /** Bind (and size) the canvas this renderer paints into. */
  attach(canvas: HTMLCanvasElement): void {
    canvas.width = this.grid.width;
    canvas.height = this.grid.height;
    this.ctx2d = canvas.getContext('2d');
    this.imageData = this.ctx2d
      ? this.ctx2d.createImageData(this.grid.width, this.grid.height)
      : null;
    this.lastMode = null;
    this.lastHours = null;
    this.lastWithin = null;
  }

  /**
   * TIMELINE mode: repaint for scrub time tMs. Returns true when the canvas
   * changed; skips (false) when the scrub moved < TOA_MIN_REPAINT_HOURS since
   * the last paint. A mode switch always repaints.
   */
  renderAt(tMs: number): boolean {
    if (!this.ctx2d || !this.imageData) return false;
    const hours = (tMs - this.runStartMs) / 3.6e6;
    if (
      this.lastMode === 'timeline' &&
      this.lastHours !== null &&
      Math.abs(hours - this.lastHours) < TOA_MIN_REPAINT_HOURS
    ) {
      return false;
    }
    this.lastMode = 'timeline';
    this.lastHours = hours;
    paintToa(this.values, hours, this.ramp, this.imageData.data);
    this.ctx2d.putImageData(this.imageData, 0, 0);
    return true;
  }

  /**
   * WHOLE mode: repaint the entire prediction as hours-to-arrival bands,
   * hiding anything the model reaches later than `withinHours`. Deliberately
   * takes no time argument — the playhead cannot alter this paint, so
   * scrubbing costs nothing. Returns true when the canvas changed; repeated
   * calls with the same reach are skipped (false).
   */
  renderWhole(withinHours: number): boolean {
    if (!this.ctx2d || !this.imageData) return false;
    if (this.lastMode === 'whole' && this.lastWithin === withinHours) return false;
    this.lastMode = 'whole';
    this.lastWithin = withinHours;
    paintToaBands(this.values, withinHours, this.imageData.data);
    this.ctx2d.putImageData(this.imageData, 0, 0);
    return true;
  }
}
