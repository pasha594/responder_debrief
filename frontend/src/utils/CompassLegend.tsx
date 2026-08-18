/**
 * Compass-aware legend for wind DIRECTION.
 *
 * The ramp is circular — 0° and 360° are the same bearing, north — so the
 * plain min→max GradientLegend reads as a scale that starts and ends
 * somewhere different, which is exactly backwards. This one keeps the same
 * gradient bar but labels it with cardinal points, so the colors read as a
 * compass rose unrolled onto a line.
 */
import type { CSSProperties } from 'react';
import { stopPercents } from './GradientLegend';

/** Cardinal bearings, including the wrap-around north at 360°. */
export const COMPASS_POINTS: readonly (readonly [number, string])[] = [
  [0, 'N'],
  [90, 'E'],
  [180, 'S'],
  [270, 'W'],
  [360, 'N'],
];

export interface CompassTick {
  /** Bearing in degrees. */
  value: number;
  /** Cardinal label. */
  label: string;
  /** Position across the bar, 0–100. */
  pct: number;
}

/**
 * Cardinal ticks across a [min, max] bearing span, positioned with the same
 * linear map the gradient uses. Points outside the published span are
 * dropped (a partial ramp still labels only what it actually covers), and a
 * degenerate span yields nothing. Pure; exported for tests.
 */
export function compassTicks(min: number, max: number): CompassTick[] {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return [];
  const ticks: CompassTick[] = [];
  for (const [value, label] of COMPASS_POINTS) {
    if (value < min || value > max) continue;
    ticks.push({ value, label, pct: ((value - min) / span) * 100 });
  }
  return ticks;
}

const tickLabelStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  fontSize: 10,
  letterSpacing: '0.04em',
  color: 'var(--color-text-muted)',
  whiteSpace: 'nowrap',
};

export function CompassLegend({
  stops,
  className,
}: {
  stops: [number, string][];
  className?: string;
}) {
  if (stops.length < 2) return null;
  const percents = stopPercents(stops);
  const gradient = `linear-gradient(to right, ${stops
    .map(([, color], i) => `${color} ${percents[i]}%`)
    .join(', ')})`;
  const min = stops[0][0];
  const max = stops[stops.length - 1][0];
  const ticks = compassTicks(min, max);

  return (
    <div className={className} style={{ width: '100%' }}>
      <div
        style={{ height: 12, borderRadius: 'var(--radius)', background: gradient }}
        role="img"
        aria-label={`Wind direction legend, ${ticks.map((t) => t.label).join(' to ')}`}
      />
      <div style={{ position: 'relative', height: 13, marginTop: 2 }}>
        {ticks.map((t) => (
          <span
            key={t.value}
            style={{
              ...tickLabelStyle,
              left: `${t.pct}%`,
              // Pin the ends inside the bar; center every interior tick.
              transform:
                t.pct <= 0 ? 'none' : t.pct >= 100 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
