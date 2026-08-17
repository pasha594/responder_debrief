/**
 * Data-driven weather legend: a horizontal CSS gradient bar built from the
 * manifest's `legend_stops` ramp ([value, color] pairs), cornea style —
 * min/max captions in small uppercase under the bar. Replaces legend images
 * for catalogs that publish stops (HRRR worker).
 */
import type { CSSProperties } from 'react';

/**
 * Percentage position of each stop across [min, max] (first/last stop
 * values). Pure; exported for tests. A degenerate span (all stops equal)
 * maps everything to 0%.
 */
export function stopPercents(stops: readonly (readonly [number, string])[]): number[] {
  if (!stops.length) return [];
  const min = stops[0][0];
  const max = stops[stops.length - 1][0];
  const span = max - min;
  if (span <= 0) return stops.map(() => 0);
  return stops.map(([value]) => ((value - min) / span) * 100);
}

/** Trim float noise: 0.05 -> "0.05", 20 -> "20". */
function formatValue(value: number): string {
  return String(value);
}

const captionStyle: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--color-text-muted)',
};

export function GradientLegend({
  stops,
  units,
  className,
}: {
  stops: [number, string][];
  units?: string;
  className?: string;
}) {
  if (stops.length < 2) return null;
  const percents = stopPercents(stops);
  const gradient = `linear-gradient(to right, ${stops
    .map(([, color], i) => `${color} ${percents[i]}%`)
    .join(', ')})`;
  const min = stops[0][0];
  const max = stops[stops.length - 1][0];
  const suffix = units ?? '';
  return (
    <div className={className} style={{ width: '100%' }}>
      <div
        style={{
          height: 12,
          borderRadius: 'var(--radius)',
          background: gradient,
        }}
        role="img"
        aria-label={`Legend from ${formatValue(min)}${suffix} to ${formatValue(max)}${suffix}`}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={captionStyle}>
          {formatValue(min)}
          {suffix}
        </span>
        <span style={captionStyle}>
          {formatValue(max)}
          {suffix}
        </span>
      </div>
    </div>
  );
}
