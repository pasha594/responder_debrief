/**
 * Hourly-product renderer: fetches a {pct}_{product}.tar from the public
 * forecast archive once (module LRU, ~3 tars), untars it, indexes members by
 * the UTC timestamp in their names ({product}_{YYYYMMDD}_{HHMMSS}.tif), and
 * per scrub tick decodes + colormaps the nearest member at-or-before t.
 * Members are Byte rasters (nodata 0, value ≈ physical quantity) on the same
 * UTM grid; colors come from the manifest's legend_stops (piecewise-linear,
 * or exact-match when legend_labels marks the product discrete).
 */
import { untar, type TarMember } from './untar';
import { decodeSpreadTiff, parseHexColor, type SpreadGrid } from './toaRenderer';

// ---------- member naming ----------

const MEMBER_RE = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.tif$/;

/** "{product}_{YYYYMMDD}_{HHMMSS}.tif" → UTC epoch ms, or null. */
export function parseMemberTime(name: string): number | null {
  const m = MEMBER_RE.exec(name);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

export interface ProductMember {
  name: string;
  timeMs: number;
  bytes: Uint8Array;
}

/** Parse+filter tar members to timestamped tifs, sorted ascending by time. */
export function indexMembers(members: TarMember[]): ProductMember[] {
  const out: ProductMember[] = [];
  for (const m of members) {
    const timeMs = parseMemberTime(m.name);
    if (timeMs !== null) out.push({ name: m.name, timeMs, bytes: m.bytes });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

/** Index of the last time <= t (binary search), or -1 when t precedes all. */
export function memberIndexAt(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

// ---------- colormap ----------

/**
 * 256×RGBA lookup table for Byte rasters. Value 0 (nodata) is transparent.
 * Continuous products: clamp below/above the ramp, lerp between stops.
 * Discrete products (legend_labels present, e.g. crown-fire): exact stop
 * values only; everything else transparent.
 */
export function buildLut(
  stops: readonly (readonly [number, string])[],
  discrete = false,
): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  const parsed = stops
    .map(([v, css]) => ({ v, rgb: parseHexColor(css) }))
    .filter((s): s is { v: number; rgb: [number, number, number] } => s.rgb !== null)
    .sort((a, b) => a.v - b.v);
  if (!parsed.length) return lut;

  const write = (value: number, rgb: [number, number, number]) => {
    const o = value * 4;
    lut[o] = rgb[0];
    lut[o + 1] = rgb[1];
    lut[o + 2] = rgb[2];
    lut[o + 3] = 255;
  };

  if (discrete) {
    for (const s of parsed) {
      if (Number.isInteger(s.v) && s.v >= 1 && s.v <= 255) write(s.v, s.rgb);
    }
    return lut;
  }

  for (let v = 1; v <= 255; v++) {
    if (v <= parsed[0].v) {
      write(v, parsed[0].rgb);
      continue;
    }
    const last = parsed[parsed.length - 1];
    if (v >= last.v) {
      write(v, last.rgb);
      continue;
    }
    let i = 0;
    while (parsed[i + 1].v < v) i++;
    const a = parsed[i];
    const b = parsed[i + 1];
    const k = (v - a.v) / (b.v - a.v);
    write(v, [
      Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k),
      Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k),
      Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k),
    ]);
  }
  return lut;
}

/** Pure LUT paint (exported for tests): byte values → RGBA. */
export function paintProduct(
  values: ArrayLike<number>,
  lut: Uint8ClampedArray,
  out: Uint8ClampedArray,
): void {
  for (let i = 0, o = 0; i < values.length; i++, o += 4) {
    const l = (values[i] & 0xff) * 4;
    out[o] = lut[l];
    out[o + 1] = lut[l + 1];
    out[o + 2] = lut[l + 2];
    out[o + 3] = lut[l + 3];
  }
}

// ---------- tar bundle cache ----------

interface TarBundle {
  members: ProductMember[];
  times: number[];
  grid: SpreadGrid;
}

const TAR_CACHE_MAX = 3;
/** url → in-flight/settled bundle; insertion order doubles as the LRU. */
const tarCache = new Map<string, Promise<TarBundle>>();

function memberArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // geotiff wants an ArrayBuffer; members are views into the tar buffer.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function loadTarBundle(url: string): Promise<TarBundle> {
  const cached = tarCache.get(url);
  if (cached) {
    // touch: most recently used
    tarCache.delete(url);
    tarCache.set(url, cached);
    return cached;
  }
  const p = (async (): Promise<TarBundle> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`product tar ${res.status} for ${url}`);
    const buf = await res.arrayBuffer();
    // Yield once so the multi-MB sync untar pass never rides the same task
    // as response delivery (keeps scrub/paint latency bounded).
    await new Promise((r) => setTimeout(r, 0));
    const members = indexMembers(untar(buf));
    if (!members.length) throw new Error(`product tar has no timestamped members: ${url}`);
    const { grid } = await decodeSpreadTiff(memberArrayBuffer(members[0].bytes));
    return { members, times: members.map((m) => m.timeMs), grid };
  })();
  tarCache.set(url, p);
  while (tarCache.size > TAR_CACHE_MAX) {
    const oldest = tarCache.keys().next().value;
    if (oldest === undefined) break;
    tarCache.delete(oldest);
  }
  p.catch(() => tarCache.delete(url)); // never cache failures
  return p;
}

// ---------- renderer ----------

const DECODE_CACHE_MAX = 8;

export interface ProductRendererOptions {
  legendStops: readonly (readonly [number, string])[];
  legendLabels?: readonly string[] | null;
}

export class ProductRenderer {
  readonly grid: SpreadGrid;
  readonly times: number[];
  private readonly members: ProductMember[];
  private readonly lut: Uint8ClampedArray;
  /** member index → decoded band (LRU, ≤ DECODE_CACHE_MAX). */
  private readonly decoded = new Map<number, Uint8Array>();
  private ctx2d: CanvasRenderingContext2D | null = null;
  private imageData: ImageData | null = null;
  private lastIndex: number | null = null;
  private renderToken = 0;

  constructor(bundle: TarBundle, opts: ProductRendererOptions) {
    this.grid = bundle.grid;
    this.members = bundle.members;
    this.times = bundle.times;
    this.lut = buildLut(opts.legendStops, !!opts.legendLabels?.length);
  }

  /** Fetch + untar + index a {pct}_{product}.tar (module LRU across calls). */
  static async load(tarUrl: string, opts: ProductRendererOptions): Promise<ProductRenderer> {
    return new ProductRenderer(await loadTarBundle(tarUrl), opts);
  }

  /** Bind (and size) the canvas this renderer paints into. */
  attach(canvas: HTMLCanvasElement): void {
    canvas.width = this.grid.width;
    canvas.height = this.grid.height;
    this.ctx2d = canvas.getContext('2d');
    this.imageData = this.ctx2d
      ? this.ctx2d.createImageData(this.grid.width, this.grid.height)
      : null;
    this.lastIndex = null;
  }

  private async decodeMember(index: number): Promise<Uint8Array> {
    const hit = this.decoded.get(index);
    if (hit) {
      this.decoded.delete(index);
      this.decoded.set(index, hit); // touch
      return hit;
    }
    const { values } = await decodeSpreadTiff(memberArrayBuffer(this.members[index].bytes));
    const band = values instanceof Uint8Array ? values : Uint8Array.from(values);
    this.decoded.set(index, band);
    while (this.decoded.size > DECODE_CACHE_MAX) {
      const oldest = this.decoded.keys().next().value;
      if (oldest === undefined) break;
      this.decoded.delete(oldest);
    }
    return band;
  }

  /**
   * Paint the member nearest at-or-before tMs. Skips (false) when that member
   * is the one already painted — member steps are hourly, so this is the
   * floor(hours)-unchanged throttle. Async (member decode); stale renders are
   * dropped via a token.
   */
  async renderAt(tMs: number): Promise<boolean> {
    if (!this.ctx2d || !this.imageData) return false;
    const index = memberIndexAt(this.times, tMs);
    if (index === this.lastIndex) return false;
    const token = ++this.renderToken;
    if (index < 0) {
      this.lastIndex = index;
      this.ctx2d.clearRect(0, 0, this.grid.width, this.grid.height);
      return true;
    }
    const band = await this.decodeMember(index);
    if (token !== this.renderToken || !this.ctx2d || !this.imageData) return false;
    this.lastIndex = index;
    paintProduct(band, this.lut, this.imageData.data);
    this.ctx2d.putImageData(this.imageData, 0, 0);
    return true;
  }
}
