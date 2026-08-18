/**
 * The Draw tab's symbol palette — the marks crews expect from incident maps
 * (NWCG/ICS conventions, rendered as lettered discs so the basemap's glyph
 * ranges always cover them). Shared by the palette UI and the map layer.
 */

export interface DrawSymbol {
  id: string;
  /** Palette name. */
  label: string;
  /** Short glyph drawn inside the disc on the map. */
  glyph: string;
  color: string;
}

export const DRAW_SYMBOLS: DrawSymbol[] = [
  { id: 'origin', label: 'Fire origin', glyph: 'O', color: '#e63c32' },
  { id: 'spot', label: 'Spot fire', glyph: 'X', color: '#ff7518' },
  { id: 'icp', label: 'Incident command post', glyph: 'ICP', color: '#ffbd5a' },
  { id: 'camp', label: 'Camp', glyph: 'C', color: '#ffbd5a' },
  { id: 'staging', label: 'Staging area', glyph: 'S', color: '#ffbd5a' },
  { id: 'helispot', label: 'Helispot', glyph: 'H', color: '#6ab4ff' },
  { id: 'helibase', label: 'Helibase', glyph: 'HB', color: '#6ab4ff' },
  { id: 'water', label: 'Water source', glyph: 'W', color: '#50aaf0' },
  { id: 'drop', label: 'Drop point', glyph: 'DP', color: '#8fd06a' },
  { id: 'safety', label: 'Safety zone', glyph: 'SZ', color: '#8fd06a' },
  { id: 'lookout', label: 'Lookout', glyph: 'LO', color: '#c9a0ff' },
  { id: 'hazard', label: 'Hazard', glyph: '!', color: '#e63c32' },
];

export const DRAW_SYMBOL_BY_ID: Record<string, DrawSymbol> = Object.fromEntries(
  DRAW_SYMBOLS.map((s) => [s.id, s]),
);

/** Freehand line color (the accent reads on both basemap and rasters). */
export const DRAW_LINE_COLOR = '#ffbd5a';
