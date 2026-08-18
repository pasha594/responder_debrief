/**
 * Draw-tab symbology, mirroring the legend on the incident map sheets (NWCG
 * conventions): purple circles for aviation, blue squares for ground
 * facilities, blue diamonds for comms, plain glyphs for the break marks —
 * plus the standard line styles (letters repeating along construction lines,
 * dots for aviation routes). "Black" legend inks render as light gray so
 * they read on the dark basemap.
 */

export type MarkerShape = 'circle' | 'square' | 'diamond' | 'none';

export interface DrawSymbol {
  id: string;
  label: string;
  /** Text drawn on/inside the marker. */
  glyph: string;
  shape: MarkerShape;
  color: string;
}

const PURPLE = '#b05de1';
const BLUE = '#5a7cff';
const GRAY = '#a89ea4';
const INK = '#d8d2d5';
const RED = '#e63c32';

export const DRAW_SYMBOLS: DrawSymbol[] = [
  { id: 'division', label: 'Division Break', glyph: ')(', shape: 'none', color: INK },
  { id: 'branch', label: 'Branch Break', glyph: '][', shape: 'none', color: INK },
  { id: 'airstrip', label: 'Airstrip / Airport', glyph: 'A', shape: 'circle', color: PURPLE },
  { id: 'helispot', label: 'Helispot', glyph: 'H', shape: 'circle', color: PURPLE },
  { id: 'uas', label: 'UAS Launch & Recovery', glyph: 'U', shape: 'circle', color: PURPLE },
  { id: 'lookout', label: 'Lookout', glyph: 'LO', shape: 'square', color: BLUE },
  { id: 'drop', label: 'Drop Point', glyph: 'DP', shape: 'square', color: BLUE },
  { id: 'camp', label: 'Camp', glyph: 'C', shape: 'square', color: BLUE },
  { id: 'staging', label: 'Staging Area', glyph: 'S', shape: 'square', color: BLUE },
  { id: 'dip', label: 'Dip Site', glyph: 'D', shape: 'circle', color: BLUE },
  { id: 'wxunit', label: 'Mobile Weather Unit', glyph: 'W', shape: 'diamond', color: BLUE },
  { id: 'repeater', label: 'Repeater', glyph: 'R', shape: 'diamond', color: BLUE },
  { id: 'risk', label: 'Value at Risk', glyph: '!', shape: 'circle', color: GRAY },
  { id: 'landmark', label: 'Landmark', glyph: 'LM', shape: 'circle', color: GRAY },
  { id: 'firestation', label: 'Fire Station', glyph: 'F', shape: 'circle', color: GRAY },
];

export const DRAW_SYMBOL_BY_ID: Record<string, DrawSymbol> = Object.fromEntries(
  DRAW_SYMBOLS.map((s) => [s.id, s]),
);

// ---------- line styles ----------

export type LineDash = 'solid' | 'dash' | 'dots' | 'hatch';

export interface DrawLineStyle {
  id: string;
  label: string;
  color: string;
  dash: LineDash;
  /** Letter repeated along the line (hand/mixed/road construction lines). */
  letter?: string;
  width?: number;
}

export const DRAW_LINES: DrawLineStyle[] = [
  { id: 'sketch', label: 'Sketch', color: '#ffbd5a', dash: 'solid' },
  { id: 'dozer', label: 'Completed Dozer Line', color: GRAY, dash: 'hatch' },
  { id: 'fuelbreak', label: 'Completed Fuel Break', color: INK, dash: 'dash' },
  { id: 'handline', label: 'Completed Hand Line', color: INK, dash: 'solid', letter: 'H' },
  { id: 'mixedline', label: 'Completed Mixed Construction', color: INK, dash: 'solid', letter: 'M' },
  { id: 'roadline', label: 'Completed Road as Line', color: INK, dash: 'solid', letter: 'R' },
  { id: 'aviation', label: 'Aviation Route', color: PURPLE, dash: 'dots' },
  { id: 'contained', label: 'Contained Fire Edge', color: INK, dash: 'solid', width: 3.5 },
  { id: 'uncontained', label: 'Uncontained Fire Edge', color: RED, dash: 'solid', width: 3.5 },
  { id: 'perimeter', label: 'Wildfire Perimeter', color: '#cc0000', dash: 'solid', width: 4 },
];

export const DRAW_LINE_BY_ID: Record<string, DrawLineStyle> = Object.fromEntries(
  DRAW_LINES.map((l) => [l.id, l]),
);

/** Default freehand color (the Sketch style). */
export const DRAW_LINE_COLOR = '#ffbd5a';
