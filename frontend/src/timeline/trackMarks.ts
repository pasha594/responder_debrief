/**
 * Track decoration math — pure. Label thinning and marker placement, kept out
 * of the component so both are unit-testable without a DOM.
 */

/**
 * How many day ticks to skip between labels so no two labels can collide.
 *
 * The track scale is piecewise (past is stretched, future compressed), so the
 * TIGHTEST gap in the run decides for everyone — that keeps the rhythm regular
 * instead of dropping labels ad hoc in the dense stretch.
 */
export function dayLabelStride(xs: number[], minGapPx: number): number {
  if (xs.length < 2 || !(minGapPx > 0)) return 1;
  let minGap = Infinity;
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1];
    if (gap < minGap) minGap = gap;
  }
  if (!(minGap > 0)) return xs.length; // degenerate: a single label
  return Math.max(1, Math.min(xs.length, Math.ceil(minGapPx / minGap)));
}

export interface MarkPlacement {
  x: number;
  /** true when the time fell outside the domain and was pulled to an edge. */
  clamped: boolean;
}

/**
 * Where a moment sits on the track. Times outside the domain clamp to the
 * nearest edge and say so, so the caller can dim the mark rather than drop it
 * (silently vanishing marks are worse than honest edge markers).
 */
export function markPlacement(
  t: number,
  domain: [number, number],
  timeToX: (t: number) => number,
): MarkPlacement | null {
  if (!Number.isFinite(t)) return null;
  const [d0, d1] = domain;
  if (!(d1 > d0)) return null;
  const clamped = t < d0 || t > d1;
  return { x: timeToX(Math.min(d1, Math.max(d0, t))), clamped };
}
