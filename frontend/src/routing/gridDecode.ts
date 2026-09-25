/**
 * Routing grid + DEM decode (geotiff, DOM-free, FULL resolution — the
 * spread renderer's 1536 px downsample-on-read must never touch routing).
 * Validates the georef against the descriptor so a mismatched pair of
 * files fails loudly instead of routing on shifted cells.
 */
import { fromArrayBuffer } from 'geotiff';
import type { RoutingBundle } from './types';

export interface RoutingGrid {
  width: number;
  height: number;
  cell: number;
  /** Pace codes (pacecode.ts) and veg bytes (vegClasses.ts), row-major. */
  pace: Uint8Array;
  veg: Uint8Array;
  /** Metres; -32768 = nodata. */
  dem: Int16Array;
}

async function readTiff(buf: ArrayBuffer, b: RoutingBundle, what: string) {
  const tiff = await fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const w = img.getWidth();
  const h = img.getHeight();
  if (w !== b.grid.width || h !== b.grid.height) {
    throw new Error(`${what}: ${w}x${h} != descriptor ${b.grid.width}x${b.grid.height}`);
  }
  const geo = img.getGeoKeys() as Record<string, number> | null;
  const epsg = geo?.ProjectedCSTypeGeoKey;
  if (epsg !== b.crs.epsg) throw new Error(`${what}: EPSG ${epsg} != ${b.crs.epsg}`);
  const [ox, oy] = img.getOrigin();
  if (Math.abs(ox - b.grid.x0) > 0.01 || Math.abs(oy - b.grid.y0) > 0.01) {
    throw new Error(`${what}: origin ${ox},${oy} != ${b.grid.x0},${b.grid.y0}`);
  }
  return img.readRasters({ interleave: false });
}

export async function decodeGrid(gridBuf: ArrayBuffer, demBuf: ArrayBuffer,
  b: RoutingBundle): Promise<RoutingGrid> {
  const g = await readTiff(gridBuf, b, 'grid.tif');
  const d = await readTiff(demBuf, b, 'dem.tif');
  const pace = g[0] as Uint8Array;
  const veg = g[1] as Uint8Array;
  const dem = d[0] as Int16Array;
  if (!(pace instanceof Uint8Array) || !(veg instanceof Uint8Array) || !(dem instanceof Int16Array)) {
    throw new Error('unexpected raster band types');
  }
  return { width: b.grid.width, height: b.grid.height, cell: b.grid.cell_m, pace, veg, dem };
}
