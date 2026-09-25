import { describe, expect, it } from 'vitest';
import type { DrawFeature } from '../state/store';
import { ShareFormatError, crc32 } from './bytes';
import { decodeShareBody, encodeShareBody, type ShareState } from './shareCodec';
import { decodeCodeBytes, parseShareText, singleCodeBytes } from './transport';
import { bytesToDigits } from './digits';
import {
  WIRE_BASEMAPS,
  WIRE_LINES,
  WIRE_PERCENTILES,
  WIRE_POINTS,
  WIRE_SPREAD,
  WIRE_WEATHER,
} from './wireTables';

const LAT0 = 44.05;
const LON0 = -121.31;

function base(over: Partial<ShareState> = {}): ShareState {
  return {
    fire: { corneaId: '{2F1C0E9A-7B3D-4E5F-8A9B-0C1D2E3F4A5B}', name: 'BIG GRASS' },
    sharedAt: Date.UTC(2026, 8, 25, 14, 32),
    packSavedAt: Date.UTC(2026, 8, 25, 6, 5),
    camera: { center: [LON0, LAT0], zoom: 12.3, bearing: -30, pitch: 45 },
    basemap: 'satellite',
    time: Date.UTC(2026, 8, 25, 21, 0),
    layers: {
      spread: {
        visible: true,
        product: 'flame-length',
        percentile: 90,
        opacity: 0.8,
        toaMode: 'whole',
        toaWithinHours: 24,
      },
      weather: { ws: 0.7, rh: 0.55, smoke: 1 },
      hotspots: true,
      perimeters: false,
      historic: true,
      traffic: false,
      incidents: true,
      incidentMap: { mapId: '0123456789abcdef', series: null, opacity: 0.75 },
      irFlight: '20260824_2230',
    },
    drawings: null,
    ...over,
  };
}

const marker = (lon: number, lat: number, sym: string, rot?: number): DrawFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { fid: 'x', kind: 'marker', sym, ...(rot !== undefined ? { rot } : {}) },
});

const line = (coords: [number, number][], style: string): DrawFeature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: coords },
  properties: { fid: 'y', kind: 'line', style },
});

/** Finger-like stroke: a point every ~20 m with a little jitter. */
function stroke(n: number, seed: number): [number, number][] {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  const pts: [number, number][] = [];
  let x = LON0, y = LAT0, h = rand() * 6;
  for (let i = 0; i < n; i++) {
    pts.push([x + rand() * 2e-5, y + rand() * 2e-5]);
    h += rand() * 0.3;
    x += Math.cos(h) * 2.5e-4;
    y += Math.sin(h) * 1.8e-4;
  }
  return pts;
}

const roundTrip = (s: ShareState) => decodeShareBody(encodeShareBody(s));

describe('share body', () => {
  it('round-trips the view, layers and sheet', () => {
    const s = base();
    const out = roundTrip(s);
    expect(out.fire).toEqual(s.fire);
    expect(out.sharedAt).toBe(s.sharedAt);
    expect(out.packSavedAt).toBe(s.packSavedAt);
    expect(out.camera.center[0]).toBeCloseTo(LON0, 5);
    expect(out.camera.center[1]).toBeCloseTo(LAT0, 5);
    expect(out.camera.zoom).toBeCloseTo(12.3, 5);
    expect(out.camera.bearing).toBeCloseTo(-30, 0);
    expect(out.camera.pitch).toBe(45);
    expect(out.basemap).toBe('satellite');
    expect(out.time).toBe(s.time);
    expect(out.layers).toEqual(s.layers);
    expect(out.drawings).toBeNull();
  });

  it('keeps optional parts optional', () => {
    const s = base({
      packSavedAt: null,
      time: null,
      layers: {
        ...base().layers,
        spread: { ...base().layers.spread, visible: false, toaMode: 'timeline' },
        weather: {},
        incidentMap: { mapId: null, series: 'ops|north|landscape', opacity: 0.5 },
        irFlight: null,
      },
    });
    const out = roundTrip(s);
    expect(out.packSavedAt).toBeNull();
    expect(out.time).toBeNull();
    expect(out.layers).toEqual(s.layers);
  });

  it('is small: a view with a sheet, an IR flight and three weather layers is ~85 bytes', () => {
    expect(encodeShareBody(base()).length).toBeLessThan(100);
  });

  it.each([
    '{2F1C0E9A-7B3D-4E5F-8A9B-0C1D2E3F4A5B}',
    '2f1c0e9a-7b3d-4e5f-8a9b-0c1d2e3f4a5b',
    '{2f1c0e9a-7b3d-4e5f-8a9b-0c1d2e3f4a5b}',
    '2F1C0E9A-7B3D-4E5F-8A9B-0C1D2E3F4A5B',
    '2F1c0e9a-7b3d-4e5f-8a9b-0c1d2e3f4a5b', // mixed case: travels as text
    '{2f1c0e9a-7b3d-4e5f-8a9b-0c1d2e3f4a5b', // unbalanced brace: text
    'not-a-guid',
  ])('reproduces fire id %s exactly', (id) => {
    expect(roundTrip(base({ fire: { corneaId: id, name: 'X' } })).fire.corneaId).toBe(id);
  });

  it('carries non-hex sheet ids as text', () => {
    const s = base();
    s.layers.incidentMap.mapId = 'Sheet-7';
    expect(roundTrip(s).layers.incidentMap.mapId).toBe('Sheet-7');
  });
});

describe('drawings', () => {
  it('round-trips markers (with turn) and lines to ~1 m', () => {
    const feats = [
      marker(LON0 + 0.01, LAT0 - 0.02, 'helispot'),
      marker(LON0 - 0.03, LAT0 + 0.01, 'division-break', 93),
      line([[LON0, LAT0], [LON0 + 0.001, LAT0 + 0.002], [LON0 + 0.003, LAT0 + 0.001]], 'completed-dozer-line'),
    ];
    const out = roundTrip(base({ drawings: feats }))!.drawings!;
    expect(out).toHaveLength(3);
    expect(out[0].properties).toMatchObject({ kind: 'marker', sym: 'helispot' });
    expect(out[0].properties.rot).toBeUndefined();
    expect(out[1].properties).toMatchObject({ kind: 'marker', sym: 'division-break' });
    expect(out[1].properties.rot).toBeCloseTo(93, 0);
    expect(out[2].properties).toMatchObject({ kind: 'line', style: 'completed-dozer-line' });
    const close = (a: number[], b: number[]) => {
      expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-5);
      expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-5);
    };
    close(out[0].geometry.coordinates as number[], feats[0].geometry.coordinates as number[]);
    close(out[1].geometry.coordinates as number[], feats[1].geometry.coordinates as number[]);
    (feats[2].geometry.coordinates as number[][]).forEach((c, i) =>
      close((out[2].geometry.coordinates as number[][])[i], c));
    // fresh, unique ids
    expect(new Set(out.map((f) => f.properties.fid)).size).toBe(3);
  });

  it('carries symbols outside the frozen tables as their string id', () => {
    const feats = [marker(LON0, LAT0, 'brand-new-symbol'), line([[LON0, LAT0], [LON0 + 1e-3, LAT0]], 'new-line')];
    const out = roundTrip(base({ drawings: feats })).drawings!;
    expect(out[0].properties.sym).toBe('brand-new-symbol');
    expect(out[1].properties.style).toBe('new-line');
  });

  it('keeps an empty drawing set distinct from "not included"', () => {
    expect(roundTrip(base({ drawings: [] })).drawings).toEqual([]);
    expect(roundTrip(base({ drawings: null })).drawings).toBeNull();
  });

  it('simplifies finger strokes without moving them more than ~2 m', () => {
    const coords = stroke(300, 11);
    const out = roundTrip(base({ drawings: [line(coords, 'sketch')] })).drawings![0];
    const kept = out.geometry.coordinates as [number, number][];
    expect(kept.length).toBeLessThan(coords.length);
    expect(kept[0][0]).toBeCloseTo(coords[0][0], 4);
    expect(kept[kept.length - 1][1]).toBeCloseTo(coords[coords.length - 1][1], 4);
    // every original point stays within tolerance (+ quantization) of the kept line
    const kx = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
    const segDist = (p: number[], a: number[], b: number[]) => {
      const [px, py, ax, ay, bx, by] = [p[0] * kx, p[1] * 111_320, a[0] * kx, a[1] * 111_320, b[0] * kx, b[1] * 111_320];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      return Math.hypot(px - ax - t * dx, py - ay - t * dy);
    };
    for (const p of coords) {
      let best = Infinity;
      for (let i = 1; i < kept.length; i++) best = Math.min(best, segDist(p, kept[i - 1], kept[i]));
      expect(best).toBeLessThan(3.2);
    }
  });

  it('packs a medium briefing set (40 marks, 8 lines) into one-code range', () => {
    const feats: DrawFeature[] = [];
    for (let i = 0; i < 40; i++) {
      feats.push(marker(LON0 + ((i * 37) % 100) / 1e3, LAT0 + ((i * 53) % 100) / 1e3, WIRE_POINTS[i % 50]));
    }
    for (let i = 0; i < 8; i++) feats.push(line(stroke(60 + i * 20, i + 1), 'planned-hand-line'));
    const body = encodeShareBody(base({ drawings: feats }));
    expect(body.length).toBeLessThan(1400);
    expect(roundTrip(base({ drawings: feats })).drawings).toHaveLength(48);
  });
});

describe('versioning and corruption', () => {
  it('flags codes from a newer format as newer', () => {
    const body = encodeShareBody(base());
    body[0] = 2;
    expect(() => decodeShareBody(body)).toThrow(expect.objectContaining({ reason: 'newer' }));
  });

  it('rejects trailing bytes and truncation', () => {
    const body = encodeShareBody(base({ drawings: [marker(LON0, LAT0, 'camp')] }));
    expect(() => decodeShareBody(new Uint8Array([...body, 0]))).toThrow(ShareFormatError);
    expect(() => decodeShareBody(body.slice(0, -1))).toThrow(ShareFormatError);
  });

  it('single codes carry a checksum', () => {
    const bytes = singleCodeBytes(encodeShareBody(base()));
    expect(decodeCodeBytes(bytes).kind).toBe('single');
    bytes[10] ^= 1;
    expect(() => decodeCodeBytes(bytes)).toThrow(ShareFormatError);
  });

  it('parses share links from any origin, and nothing else', () => {
    const digits = bytesToDigits(singleCodeBytes(encodeShareBody(base())));
    for (const origin of ['https://incibrief.com/s#', 'http://localhost:5173/s#', 'https://x.github.io/responder_debrief/s#']) {
      const parsed = parseShareText(origin + digits);
      expect(parsed?.kind).toBe('single');
    }
    expect(parseShareText('https://incibrief.com/fire/abc')).toBeNull();
    expect(parseShareText('hello')).toBeNull();
  });
});

describe('frozen tables', () => {
  it('have no duplicates and still hold every v1 palette id', () => {
    expect(new Set(WIRE_POINTS).size).toBe(WIRE_POINTS.length);
    expect(new Set(WIRE_LINES).size).toBe(WIRE_LINES.length);
    expect(WIRE_POINTS.length).toBeLessThan(63);
    expect(WIRE_LINES.length).toBeLessThan(63);
  });

  it('never change (phones offline for days run older versions)', () => {
    const sum = (t: readonly unknown[]) => crc32(new TextEncoder().encode(JSON.stringify(t)));
    expect([WIRE_POINTS, WIRE_LINES, WIRE_WEATHER, WIRE_SPREAD, WIRE_PERCENTILES, WIRE_BASEMAPS].map(sum))
      .toEqual(FROZEN_SUMS);
  });

});

/** CRC-32 of each v1 table's JSON. A change here breaks every code already out there. */
const FROZEN_SUMS = [4267384549, 4014468453, 1214840391, 3080909498, 3441555201, 602398202];
