/**
 * Vegetation classes of the routing grid's veg band (`veg-v1`; worker
 * responder_worker/cost_grid.py) — one table for the Vegetation layer, the
 * cross-country route-leg colours and the legend (toaBands.ts pattern).
 * Low nibble = class id; bit 0x10 = perennial stream a crew can ford (a
 * river or large creek is class 10, impassable water, since the worker's
 * COST_GRID_VERSION 2). `impassable` mirrors what the worker bakes into the
 * pace band; the router itself only reads the pace.
 */
export const STREAM_BIT = 0x10;
export const STREAM_COLOR = '#2f8fd8';

export interface VegClass {
  id: number;
  key: string;
  label: string;
  /** Short word for step text: "through timber". */
  short: string;
  color: string;
  impassable?: boolean;
}

export const VEG_CLASSES: VegClass[] = [
  { id: 0, key: 'unknown', label: 'Unknown', short: 'unmapped ground', color: '#7a7a7a' },
  { id: 1, key: 'grass', label: 'Grass / herb', short: 'grass', color: '#e3cf6f' },
  { id: 2, key: 'shrub_light', label: 'Light brush (< 40% cover)', short: 'light brush', color: '#c9a25a' },
  { id: 3, key: 'shrub_dense', label: 'Dense brush (≥ 40% cover)', short: 'dense brush', color: '#9a6a33' },
  { id: 4, key: 'timber', label: 'Timber', short: 'timber', color: '#4f8a3c' },
  { id: 5, key: 'timber_litter', label: 'Timber, heavy litter', short: 'timber with heavy litter', color: '#2f5f2a' },
  { id: 6, key: 'slash', label: 'Slash / blowdown', short: 'slash', color: '#b4532a' },
  { id: 7, key: 'sparse', label: 'Rock / sparse', short: 'rock', color: '#a6a6a6' },
  { id: 8, key: 'developed', label: 'Developed / agriculture', short: 'developed ground', color: '#d9b9a3' },
  // impassable since COST_GRID_VERSION 3 (glaciers and permanent snow/ice)
  { id: 9, key: 'snow', label: 'Snow / ice (impassable)', short: 'snow and ice', color: '#e6f2ff', impassable: true },
  { id: 10, key: 'water', label: 'Open water (impassable)', short: 'water', color: '#3b78c2', impassable: true },
  { id: 11, key: 'steep', label: 'Too steep > 45° (impassable)', short: 'steep ground', color: '#5b3a29', impassable: true },
];

export const vegClass = (id: number): VegClass => VEG_CLASSES[id & 0x0f] ?? VEG_CLASSES[0];

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 256-entry RGBA LUT over the raw veg byte (stream bit wins). */
export function buildVegLut(alpha = 255): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let v = 0; v < 256; v++) {
    const [r, g, b] = hexRgb(v & STREAM_BIT ? STREAM_COLOR : vegClass(v).color);
    lut.set([r, g, b, (v & 0x0f) <= 11 ? alpha : 0], v * 4);
  }
  return lut;
}

/** MapLibre `match` over a feature's `veg` property (route xc legs). */
export function vegColorMatch(): unknown[] {
  const m: unknown[] = ['match', ['get', 'veg']];
  for (const c of VEG_CLASSES) m.push(c.id, c.color);
  m.push('#bdbdbd');
  return m;
}
