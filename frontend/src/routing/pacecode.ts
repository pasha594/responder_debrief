/**
 * The routing grid's pace band (`logpace-v1`, worker cost_grid.py):
 * code c in 1..254 → P(c) = 0.8 · 1024^((c−1)/253) s/m (GET v2 cross-country
 * pace incl. terrain slope and vegetation); 0 and 255 are impassable.
 */
export const PACE_MIN = 0.8;
export const PACE_SPAN = 1024;
export const PACE_STEPS = 253;
export const IMPASSABLE = 255;

export function paceOf(code: number): number {
  if (code <= 0 || code >= IMPASSABLE) return Infinity;
  return PACE_MIN * PACE_SPAN ** ((code - 1) / PACE_STEPS);
}

/** code → s/m (Infinity when impassable). */
export const PACE_LUT: Float64Array = (() => {
  const lut = new Float64Array(256);
  for (let c = 0; c < 256; c++) lut[c] = paceOf(c);
  return lut;
})();
