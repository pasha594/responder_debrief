/**
 * The QR share format, version 1: what one phone shows another about a fire —
 * the camera, basemap and playhead, the forecast and weather layers, the
 * draped incident sheet — plus, when the sender includes them, the fire's
 * drawings. Pure data in, bytes out; transport.ts turns the bytes into one QR
 * code or an animated run of them.
 *
 * Codes point at data rather than carry it: the sheet travels as its id and
 * the layers as their names, resolved against the RECIPIENT's offline copy of
 * the fire. Only the drawings travel whole.
 *
 * Body layout (integers are LEB128 varints unless noted):
 *   u8 version · flags · fire id · fire name · shared-at (epoch minute)
 *   [sender's offline-copy minute] · camera: center ×1e5 (zigzag), u8 zoom×10,
 *   u8 bearing (1/256 turns), u8 pitch° · u8 basemap · [playhead minute]
 *   u8 forecast product | percentile<<4 · u8 forecast opacity % · arrival hours
 *   weather mask (WIRE_WEATHER bits) + u8 opacity % per set bit
 *   [sheet id] [series key] · u8 sheet opacity % · [IR flight id] · [drawings]
 *
 * Drawings: a count, then per mark a head byte — kind in the top 2 bits
 * (marker, turned marker, line), the WIRE_* table index below (63: the id
 * follows as a string) — then coordinates at 1e-5° (~1 m) as zigzag deltas
 * from the previous point, starting at the camera center. Lines are
 * simplified first (see simplify.ts).
 */
import type { DrawFeature, ToaMode } from '../state/store';
import type { Percentile, SpreadProduct, WeatherProduct } from '../api/types';
import { ByteReader, ByteWriter, ShareFormatError, truncateUtf8 } from './bytes';
import { simplifyLine, toleranceFor } from './simplify';
import {
  WIRE_BASEMAPS,
  WIRE_LINES,
  WIRE_PERCENTILES,
  WIRE_POINTS,
  WIRE_SPREAD,
  WIRE_WEATHER,
} from './wireTables';

export const SHARE_FORMAT_VERSION = 1;

export interface ShareCamera {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

export interface ShareLayers {
  spread: {
    visible: boolean;
    product: SpreadProduct;
    percentile: Percentile;
    opacity: number;
    toaMode: ToaMode;
    toaWithinHours: number;
  };
  /** Visible weather layers → opacity (absent = hidden). */
  weather: Partial<Record<WeatherProduct, number>>;
  hotspots: boolean;
  perimeters: boolean;
  historic: boolean;
  traffic: boolean;
  incidents: boolean;
  incidentMap: { mapId: string | null; series: string | null; opacity: number };
  irFlight: string | null;
}

export interface ShareState {
  fire: { corneaId: string; name: string };
  /** Epoch ms, minute precision. */
  sharedAt: number;
  /** When the SENDER's offline copy of the fire was saved (null: none). */
  packSavedAt: number | null;
  camera: ShareCamera;
  basemap: (typeof WIRE_BASEMAPS)[number];
  /** Playhead, epoch ms; null means "now" on the recipient's clock. */
  time: number | null;
  layers: ShareLayers;
  /** Null: not included, so the recipient's drawings stay as they are. */
  drawings: DrawFeature[] | null;
}

const F_TIME = 1 << 0;
const F_SHEET = 1 << 1;
const F_SERIES = 1 << 2;
const F_IR = 1 << 3;
const F_DRAWINGS = 1 << 4;
const F_PACK = 1 << 5;
const F_SPREAD = 1 << 6;
const F_TOA_WHOLE = 1 << 7;
const F_HOTSPOTS = 1 << 8;
const F_PERIMETERS = 1 << 9;
const F_HISTORIC = 1 << 10;
const F_TRAFFIC = 1 << 11;
const F_INCIDENTS = 1 << 12;
const KNOWN_FLAGS = (1 << 13) - 1;

/** 1e-5° ≈ 1.1 m of latitude: finer than a fingertip at any zoom the app allows. */
const COORD_SCALE = 1e5;
const MINUTE = 60_000;
const NAME_MAX_BYTES = 60;
const ESCAPE = 63;
const KIND_MARKER = 0;
const KIND_TURNED_MARKER = 1;
const KIND_LINE = 2;

const GUID = /^(\{?)([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})(\}?)$/i;
const HEX16 = /^[0-9a-f]{16}$/;

const pct = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100);
const fromPct = (v: number) => Math.min(100, v) / 100;
const minutes = (ms: number) => Math.floor(ms / MINUTE);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- fire id: cornea_id is a braced IRWIN GUID or a bare UUID ----------

function writeFireId(w: ByteWriter, id: string): void {
  const m = GUID.exec(id);
  if (m && m[1].length === m[7].length) {
    const hex = m.slice(2, 7).join('');
    const lower = hex === hex.toLowerCase();
    const upper = hex === hex.toUpperCase();
    if (lower || upper) {
      // kind: bit 0 uppercase, bit 1 braced — 16 raw bytes follow
      w.u8((lower ? 0 : 1) | (m[1] ? 2 : 0));
      w.bytes(hexToBytes(hex.toLowerCase()));
      return;
    }
  }
  w.u8(4);
  w.str(id);
}

function readFireId(r: ByteReader): string {
  const kind = r.u8();
  if (kind === 4) return r.str();
  if (kind > 3) throw new ShareFormatError('bad fire id');
  let hex = bytesToHex(r.bytes(16));
  if (kind & 1) hex = hex.toUpperCase();
  const guid = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  return kind & 2 ? `{${guid}}` : guid;
}

// ---------- drawings ----------

type Q = [number, number];

function quantize([lon, lat]: [number, number]): Q {
  return [Math.round(lon * COORD_SCALE), Math.round(lat * COORD_SCALE)];
}

function finite(c: readonly number[]): boolean {
  return c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]);
}

function writeHead(w: ByteWriter, kind: number, table: readonly string[], id: string | undefined): void {
  const i = id ? table.indexOf(id) : -1;
  if (i >= 0 && i < ESCAPE) {
    w.u8((kind << 6) | i);
  } else {
    w.u8((kind << 6) | ESCAPE);
    w.str(id ?? '');
  }
}

function writeDrawings(w: ByteWriter, features: DrawFeature[], origin: Q): void {
  // Marks that can't be drawn anyway (broken coordinates) don't travel.
  const ok = features.filter((f) =>
    f.geometry.type === 'Point'
      ? finite(f.geometry.coordinates)
      : f.geometry.coordinates.length > 1 && f.geometry.coordinates.every(finite),
  );
  w.varint(ok.length);
  let [cx, cy] = origin;
  const put = ([qx, qy]: Q) => {
    w.zigzag(qx - cx);
    w.zigzag(qy - cy);
    cx = qx;
    cy = qy;
  };
  for (const f of ok) {
    if (f.geometry.type === 'Point') {
      const rot = f.properties.rot;
      const turned = typeof rot === 'number' && Number.isFinite(rot);
      writeHead(w, turned ? KIND_TURNED_MARKER : KIND_MARKER, WIRE_POINTS, f.properties.sym);
      put(quantize(f.geometry.coordinates));
      if (turned) w.u8(Math.round(((((rot % 360) + 360) % 360) / 360) * 256) & 0xff);
    } else {
      const coords = f.geometry.coordinates;
      const pts: Q[] = [];
      for (const c of simplifyLine(coords, toleranceFor(coords))) {
        const q = quantize(c);
        const last = pts[pts.length - 1];
        if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
      }
      if (pts.length === 1) pts.push(pts[0]); // a dot-sized stroke stays a line
      writeHead(w, KIND_LINE, WIRE_LINES, f.properties.style);
      w.varint(pts.length);
      for (const q of pts) put(q);
    }
  }
}

function readDrawings(r: ByteReader, origin: Q): DrawFeature[] {
  const count = r.varint();
  // every mark takes at least 3 bytes — a larger count is a corrupt payload
  if (count * 3 > r.remaining) throw new ShareFormatError('bad drawing count');
  let [cx, cy] = origin;
  const take = (): [number, number] => {
    cx += r.zigzag();
    cy += r.zigzag();
    return [cx / COORD_SCALE, cy / COORD_SCALE];
  };
  const stamp = Date.now().toString(36);
  const out: DrawFeature[] = [];
  for (let i = 0; i < count; i++) {
    const head = r.u8();
    const kind = head >> 6;
    const idx = head & ESCAPE;
    const table = kind === KIND_LINE ? WIRE_LINES : WIRE_POINTS;
    if (kind > KIND_LINE) throw new ShareFormatError('bad mark kind');
    let id: string | undefined;
    if (idx === ESCAPE) id = r.str() || undefined;
    else if (idx < table.length) id = table[idx];
    else throw new ShareFormatError('bad symbol index');
    const fid = `s${stamp}-${i}`;
    if (kind === KIND_LINE) {
      const n = r.varint();
      if (n < 2 || n * 2 > r.remaining) throw new ShareFormatError('bad line');
      const coordinates: [number, number][] = [];
      for (let k = 0; k < n; k++) coordinates.push(take());
      out.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: { fid, kind: 'line', ...(id ? { style: id } : {}) },
      });
    } else {
      const coordinates = take();
      const rot = kind === KIND_TURNED_MARKER ? (r.u8() * 360) / 256 : undefined;
      out.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates },
        properties: {
          fid,
          kind: 'marker',
          ...(id ? { sym: id } : {}),
          ...(rot !== undefined ? { rot } : {}),
        },
      });
    }
  }
  return out;
}

// ---------- body ----------

export function encodeShareBody(s: ShareState): Uint8Array {
  const L = s.layers;
  const w = new ByteWriter();
  let flags = 0;
  if (s.time != null) flags |= F_TIME;
  if (L.incidentMap.mapId) flags |= F_SHEET;
  if (L.incidentMap.series) flags |= F_SERIES;
  if (L.irFlight) flags |= F_IR;
  if (s.drawings) flags |= F_DRAWINGS;
  if (s.packSavedAt != null) flags |= F_PACK;
  if (L.spread.visible) flags |= F_SPREAD;
  if (L.spread.toaMode === 'whole') flags |= F_TOA_WHOLE;
  if (L.hotspots) flags |= F_HOTSPOTS;
  if (L.perimeters) flags |= F_PERIMETERS;
  if (L.historic) flags |= F_HISTORIC;
  if (L.traffic) flags |= F_TRAFFIC;
  if (L.incidents) flags |= F_INCIDENTS;

  w.u8(SHARE_FORMAT_VERSION);
  w.varint(flags);
  writeFireId(w, s.fire.corneaId);
  w.str(truncateUtf8(s.fire.name, NAME_MAX_BYTES));
  w.varint(minutes(s.sharedAt));
  if (s.packSavedAt != null) w.varint(minutes(s.packSavedAt));

  const center = quantize(s.camera.center);
  w.zigzag(center[0]);
  w.zigzag(center[1]);
  w.u8(Math.round(Math.min(25, Math.max(0, s.camera.zoom)) * 10));
  w.u8(Math.round(((((s.camera.bearing % 360) + 360) % 360) / 360) * 256) & 0xff);
  w.u8(Math.round(Math.min(90, Math.max(0, s.camera.pitch))));
  w.u8(Math.max(0, WIRE_BASEMAPS.indexOf(s.basemap)));
  if (s.time != null) w.varint(minutes(s.time));

  w.u8(
    Math.max(0, WIRE_SPREAD.indexOf(L.spread.product))
      | (Math.max(0, WIRE_PERCENTILES.indexOf(L.spread.percentile)) << 4),
  );
  w.u8(pct(L.spread.opacity));
  w.varint(Math.max(0, Math.round(L.spread.toaWithinHours)));

  let mask = 0;
  WIRE_WEATHER.forEach((p, i) => {
    if (L.weather[p] != null) mask |= 1 << i;
  });
  w.varint(mask);
  WIRE_WEATHER.forEach((p) => {
    const o = L.weather[p];
    if (o != null) w.u8(pct(o));
  });

  const mapId = L.incidentMap.mapId;
  if (mapId) {
    if (HEX16.test(mapId)) {
      w.u8(0);
      w.bytes(hexToBytes(mapId));
    } else {
      w.u8(1);
      w.str(mapId);
    }
  }
  if (L.incidentMap.series) w.str(L.incidentMap.series);
  w.u8(pct(L.incidentMap.opacity));
  if (L.irFlight) w.str(L.irFlight);

  if (s.drawings) writeDrawings(w, s.drawings, center);
  return w.finish();
}

export function decodeShareBody(b: Uint8Array): ShareState {
  const r = new ByteReader(b);
  const version = r.u8();
  if (version > SHARE_FORMAT_VERSION) {
    throw new ShareFormatError(`format v${version}`, 'newer');
  }
  if (version !== SHARE_FORMAT_VERSION) throw new ShareFormatError('bad version');
  const flags = r.varint();
  if (flags & ~KNOWN_FLAGS) throw new ShareFormatError('unknown flags', 'newer');
  const has = (f: number) => (flags & f) !== 0;

  const corneaId = readFireId(r);
  const name = r.str();
  const sharedAt = r.varint() * MINUTE;
  const packSavedAt = has(F_PACK) ? r.varint() * MINUTE : null;

  const center: Q = [r.zigzag(), r.zigzag()];
  const zoom = r.u8() / 10;
  let bearing = (r.u8() * 360) / 256;
  if (bearing > 180) bearing -= 360;
  const pitch = r.u8();
  const basemap = WIRE_BASEMAPS[r.u8()];
  if (!basemap) throw new ShareFormatError('bad basemap');
  const time = has(F_TIME) ? r.varint() * MINUTE : null;

  const sp = r.u8();
  const product = WIRE_SPREAD[sp & 0x0f];
  const percentile = WIRE_PERCENTILES[sp >> 4];
  if (!product || !percentile) throw new ShareFormatError('bad forecast');
  const spreadOpacity = fromPct(r.u8());
  const toaWithinHours = r.varint();

  const mask = r.varint();
  if (mask >= 1 << WIRE_WEATHER.length) throw new ShareFormatError('bad weather mask');
  const weather: Partial<Record<WeatherProduct, number>> = {};
  WIRE_WEATHER.forEach((p, i) => {
    if (mask & (1 << i)) weather[p] = fromPct(r.u8());
  });

  let mapId: string | null = null;
  if (has(F_SHEET)) {
    const kind = r.u8();
    if (kind === 0) mapId = bytesToHex(r.bytes(8));
    else if (kind === 1) mapId = r.str();
    else throw new ShareFormatError('bad sheet id');
  }
  const series = has(F_SERIES) ? r.str() : null;
  const sheetOpacity = fromPct(r.u8());
  const irFlight = has(F_IR) ? r.str() : null;

  const drawings = has(F_DRAWINGS) ? readDrawings(r, center) : null;
  if (r.remaining !== 0) throw new ShareFormatError('trailing bytes');

  return {
    fire: { corneaId, name },
    sharedAt,
    packSavedAt,
    camera: {
      center: [center[0] / COORD_SCALE, center[1] / COORD_SCALE],
      zoom,
      bearing,
      pitch,
    },
    basemap,
    time,
    layers: {
      spread: {
        visible: has(F_SPREAD),
        product,
        percentile,
        opacity: spreadOpacity,
        toaMode: has(F_TOA_WHOLE) ? 'whole' : 'timeline',
        toaWithinHours,
      },
      weather,
      hotspots: has(F_HOTSPOTS),
      perimeters: has(F_PERIMETERS),
      historic: has(F_HISTORIC),
      traffic: has(F_TRAFFIC),
      incidents: has(F_INCIDENTS),
      incidentMap: { mapId, series, opacity: sheetOpacity },
      irFlight,
    },
    drawings,
  };
}
