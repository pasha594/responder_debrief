/**
 * Smoke: prove the shipped spread modules decode the REAL archive data.
 *  1. geotiff decode of the local sample tif (size/bbox/geokey).
 *  2. Local /tmp/raster.tar through untar() + member index + LUT paint.
 *  3. LIVE archive: wa-sinlahekin ToA 50.tif (decode + paintToa census) and
 *     50_crown-fire.tar (untar + member decode).
 * Run: npx vite-node smoke_spread.ts   (from frontend/)
 */
import { readFile } from 'node:fs/promises';
import { fromArrayBuffer } from 'geotiff';
import { untar } from './src/spread/untar';
import { utmBoundsTo4326, epsgToUtm } from './src/spread/utm';
import { decodeSpreadTiff, paintToa, resolveToaRamp } from './src/spread/toaRenderer';
import {
  buildLut,
  indexMembers,
  memberIndexAt,
  paintProduct,
} from './src/spread/productRenderer';

const ARCHIVE = 'https://f005.backblazeb2.com/file/fire-forecast-archive';

function toAb(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

// ---- 1. required check: raw geotiff on the local sample tif ----
{
  const buf = toAb(await readFile('/tmp/tifcheck/spread-rate_20260817_120000.tif'));
  const tiff = await fromArrayBuffer(buf);
  const img = await tiff.getImage();
  console.log('[1] local tif size:', img.getWidth(), 'x', img.getHeight());
  console.log('[1] local tif bbox (UTM):', img.getBoundingBox());
  console.log('[1] local tif ProjectedCSTypeGeoKey:', img.geoKeys?.ProjectedCSTypeGeoKey);
  const utm = epsgToUtm(img.geoKeys.ProjectedCSTypeGeoKey)!;
  const { corners } = utmBoundsTo4326(
    img.getBoundingBox() as [number, number, number, number],
    utm.zone,
    utm.northern,
  );
  console.log('[1] corner pins TL,TR,BR,BL:', corners.map((c) => c.map((v) => +v.toFixed(5))));
}

// ---- 2. local tar end-to-end (untar + index + decode + colormap) ----
{
  const tarBuf = await readFile('/tmp/raster.tar');
  const members = indexMembers(untar(toAb(tarBuf)));
  console.log('[2] /tmp/raster.tar members:', members.length, 'first:', members[0].name);
  const times = members.map((m) => m.timeMs);
  const t = Date.parse('2026-08-18T12:30:00Z');
  const idx = memberIndexAt(times, t);
  console.log('[2] nearest member <= 2026-08-18T12:30Z:', members[idx].name);
  const { grid, values } = await decodeSpreadTiff(toAb(members[idx].bytes));
  const lut = buildLut([[1, '#ffdc50'], [10, '#ff9628'], [25, '#e63c32'], [50, '#aa2882'], [100, '#6e1450']]);
  const out = new Uint8ClampedArray(values.length * 4);
  paintProduct(values, lut, out);
  let colored = 0;
  for (let i = 3; i < out.length; i += 4) if (out[i]) colored++;
  console.log('[2] decoded grid:', grid.width, 'x', grid.height, 'epsg', grid.epsg, '— colored px:', colored);
}

// ---- 3a. LIVE ToA tif ----
{
  const url = `${ARCHIVE}/forecast_archive/wa-sinlahekin/20260817_100500/50.tif`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status} ${url}`);
  const { grid, values } = await decodeSpreadTiff(await res.arrayBuffer());
  console.log('[3a] LIVE ToA 50.tif grid:', grid.width, 'x', grid.height, 'epsg', grid.epsg);
  console.log('[3a] bounds [w,s,e,n]:', grid.bounds.map((v) => +v.toFixed(5)));
  const out = new Uint8ClampedArray(values.length * 4);
  const ramp = resolveToaRamp(null);
  paintToa(values as Float32Array, 24, ramp, out); // 24 h after run start
  let burned = 0, edge = 0;
  for (let i = 3; i < out.length; i += 4) {
    if (out[i] === ramp.burned[3]) burned++;
    else if (out[i] === ramp.recent[3]) edge++;
  }
  console.log('[3a] paint @ +24h: burned px', burned, '· leading-edge px', edge);
}

// ---- 3b. LIVE crown-fire tar ----
{
  const url = `${ARCHIVE}/forecast_archive/wa-sinlahekin/20260817_112500/50_crown-fire.tar`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  const members = indexMembers(untar(buf));
  console.log('[3b] LIVE 50_crown-fire.tar:', (buf.byteLength / 1e6).toFixed(2), 'MB,', members.length, 'members');
  const last = members[members.length - 1];
  const { grid, values } = await decodeSpreadTiff(toAb(last.bytes));
  let nz = 0;
  for (let i = 0; i < values.length; i++) if (values[i]) nz++;
  console.log('[3b] last member', last.name, '→', grid.width, 'x', grid.height, 'nonzero px:', nz);
}
console.log('SMOKE OK');
