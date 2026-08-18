/**
 * Piecewise-linear timeline scale. The past [domain0, now] gets
 * TIMELINE_PAST_FRACTION of the track width; the future [now, domain1] gets
 * the rest, with the seam exactly at NOW. Nonlinearity is presentation-only —
 * all app logic stays in time-space; this maps between the two.
 *
 * Degenerate cases (now outside the open interval, zero width/span) fall back
 * to a plain linear scale. Both directions clamp at the edges, and within the
 * clamped range timeToX/xToTime are exact inverses.
 */
import { TIMELINE_PAST_FRACTION } from '../app/config';

export interface TimeScale {
  /** epoch ms → px offset in [0, width] (clamped). */
  timeToX(t: number): number;
  /** px offset → epoch ms in [domain0, domain1] (clamped). */
  xToTime(x: number): number;
  /** px position of the past/future seam, or null when the scale is linear. */
  seamX: number | null;
}

export function makeScale(domain: [number, number], now: number, width: number): TimeScale {
  const [d0, d1] = domain;
  const span = d1 - d0;

  // Fully degenerate: nothing to map.
  if (!(width > 0) || !(span > 0)) {
    return { timeToX: () => 0, xToTime: () => d0, seamX: null };
  }

  const clampT = (t: number) => Math.min(d1, Math.max(d0, t));
  const clampX = (x: number) => Math.min(width, Math.max(0, x));

  // now outside the open interval → linear fallback.
  if (now <= d0 || now >= d1) {
    return {
      timeToX: (t) => ((clampT(t) - d0) / span) * width,
      xToTime: (x) => d0 + (clampX(x) / width) * span,
      seamX: null,
    };
  }

  const seamX = width * TIMELINE_PAST_FRACTION;
  const futureW = width - seamX;
  const pastSpan = now - d0;
  const futureSpan = d1 - now;

  return {
    timeToX: (t) => {
      const tt = clampT(t);
      return tt <= now
        ? ((tt - d0) / pastSpan) * seamX
        : seamX + ((tt - now) / futureSpan) * futureW;
    },
    xToTime: (x) => {
      const xx = clampX(x);
      return xx <= seamX
        ? d0 + (xx / seamX) * pastSpan
        : now + ((xx - seamX) / futureW) * futureSpan;
    },
    seamX,
  };
}


/**
 * Plain linear scale — the scrolling track's mapping. Day widths are
 * constant (the dock windows 10 days and scrolls), so past/future
 * compression is gone; the piecewise makeScale remains for callers that
 * still want a fixed-width seam layout.
 */
export function makeLinearScale(domain: [number, number], width: number): TimeScale {
  const [d0, d1] = domain;
  const span = d1 - d0;
  if (!(width > 0) || !(span > 0)) {
    return { timeToX: () => 0, xToTime: () => d0, seamX: null };
  }
  const clampT = (t: number) => Math.min(d1, Math.max(d0, t));
  const clampX = (x: number) => Math.min(width, Math.max(0, x));
  return {
    timeToX: (t) => ((clampT(t) - d0) / span) * width,
    xToTime: (x) => d0 + (clampX(x) / width) * span,
    seamX: null,
  };
}
