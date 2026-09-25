/**
 * End to end without a camera: lean-qr draws the codes, zxing-wasm (the
 * decoder the phones run) reads them back from pixels, and the share comes
 * out whole — for a single code and for an animated run.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Bitmap2D } from 'lean-qr';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import type { DrawFeature } from '../state/store';
import { decodeShareBody, encodeShareBody, type ShareState } from './shareCodec';
import { FountainDecoder } from './fountain';
import { planShareCodes, versionOf } from './qrCodes';
import { parseShareText } from './transport';

const PREFIX = 'https://incibrief.com/s#';

beforeAll(async () => {
  const wasm = readFileSync(
    new URL('../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url),
  );
  await prepareZXingModule({
    overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) },
    fireImmediately: true,
  });
});

/** Rasterize like a phone screen would show it: 3 px per module, quiet zone. */
function pixels(code: Bitmap2D, scale = 3, pad = 4) {
  const n = (code.size + pad * 2) * scale;
  const data = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.get(x, y)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + pad) * scale + dy) * n + (x + pad) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: n, height: n } as unknown as ImageData;
}

async function scan(code: Bitmap2D): Promise<string> {
  const results = await readBarcodes(pixels(code), { formats: ['QRCode'] });
  expect(results).toHaveLength(1);
  return results[0].text;
}

function share(markers: number, lines: number): ShareState {
  const drawings: DrawFeature[] = [];
  let s = 17;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  for (let i = 0; i < markers; i++) {
    drawings.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-121.3 + rand() * 0.2, 44 + rand() * 0.15] },
      properties: { fid: `m${i}`, kind: 'marker', sym: 'helispot' },
    });
  }
  for (let i = 0; i < lines; i++) {
    const coords: [number, number][] = [];
    let x = -121.3 + rand() * 0.1, y = 44 + rand() * 0.1, h = rand() * 6;
    for (let k = 0; k < 90; k++) {
      coords.push([x + rand() * 2e-5, y + rand() * 2e-5]);
      h += rand() * 0.3;
      x += Math.cos(h) * 2.5e-4;
      y += Math.sin(h) * 1.8e-4;
    }
    drawings.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: { fid: `l${i}`, kind: 'line', style: 'completed-dozer-line' },
    });
  }
  return {
    fire: { corneaId: '{2F1C0E9A-7B3D-4E5F-8A9B-0C1D2E3F4A5B}', name: 'BIG GRASS' },
    sharedAt: Date.UTC(2026, 8, 25, 14, 32),
    packSavedAt: null,
    camera: { center: [-121.3, 44], zoom: 12, bearing: 0, pitch: 0 },
    basemap: 'topo',
    time: null,
    layers: {
      spread: { visible: true, product: 'time-of-arrival', percentile: 50, opacity: 0.8, toaMode: 'timeline', toaWithinHours: 24 },
      weather: { ws: 0.7 },
      hotspots: true,
      perimeters: true,
      historic: false,
      traffic: false,
      incidents: false,
      incidentMap: { mapId: '0123456789abcdef', series: null, opacity: 0.75 },
      irFlight: null,
      trails: 'auto',
      vegetation: { visible: false, opacity: null },
      land: false,
    },
    drawings,
    routing: null,
  };
}

describe('QR round trip through zxing-wasm', () => {
  it('a view plus a small drawing set is one small code', async () => {
    const s = share(10, 2);
    const plan = planShareCodes(encodeShareBody(s), PREFIX);
    expect(plan.kind).toBe('single');
    if (plan.kind !== 'single') return;
    expect(versionOf(plan.code)).toBeLessThanOrEqual(15);
    const text = await scan(plan.code);
    expect(text.startsWith(PREFIX)).toBe(true);
    const parsed = parseShareText(text);
    expect(parsed?.kind).toBe('single');
    if (parsed?.kind !== 'single') return;
    const out = decodeShareBody(parsed.body);
    expect(out.drawings).toHaveLength(12);
    expect(out.layers.incidentMap.mapId).toBe('0123456789abcdef');
  });

  it('never makes a single code denser than version 25', () => {
    for (const [m, l] of [[0, 0], [20, 4], [40, 8], [60, 10]]) {
      const plan = planShareCodes(encodeShareBody(share(m, l)), PREFIX);
      if (plan.kind === 'single') expect(versionOf(plan.code)).toBeLessThanOrEqual(25);
    }
  });

  it('a large set animates, and the frames reassemble', async () => {
    const s = share(100, 25);
    const body = encodeShareBody(s);
    const plan = planShareCodes(body, PREFIX);
    expect(plan.kind).toBe('animated');
    if (plan.kind !== 'animated') return;
    expect(plan.frames).toBeGreaterThan(2);
    const dec = new FountainDecoder();
    let got: Uint8Array | null = null;
    // skip every third frame, as a scanner would miss some
    for (let seq = 1; seq < plan.frames * 4 && !got; seq++) {
      if (seq % 3 === 0) continue;
      const code = plan.frameCode(seq);
      expect(versionOf(code)).toBeLessThanOrEqual(18);
      const parsed = parseShareText(await scan(code));
      expect(parsed?.kind).toBe('frame');
      if (parsed?.kind === 'frame') got = dec.receive(parsed.frame);
    }
    expect(got).toEqual(body);
    expect(decodeShareBody(got!).drawings).toHaveLength(125);
  }, 30_000);
});
