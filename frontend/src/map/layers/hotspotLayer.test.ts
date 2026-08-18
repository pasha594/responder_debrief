import { describe, expect, it } from 'vitest';
import { ageColorExpr, timeFilter, HOTSPOT_MAX_AGE_MS } from './hotspotLayer';

const T = Date.parse('2026-08-18T00:00:00Z');
const DAY = 86_400_000;

/** Evaluate the maplibre 'interpolate' ramp the way the GPU would. */
function evalRamp(expr: unknown[], ageMs: number): string {
  const stops = expr.slice(3) as (number | string)[];
  for (let i = 0; i < stops.length - 2; i += 2) {
    const a = stops[i] as number;
    const b = stops[i + 2] as number;
    if (ageMs >= a && ageMs <= b) return `${stops[i + 1]}→${stops[i + 3]}`;
  }
  return ageMs <= (stops[0] as number)
    ? (stops[1] as string)
    : (stops[stops.length - 1] as string);
}

describe('hotspot age ramp', () => {
  const expr = ageColorExpr(T) as unknown[];

  it('is yellow at the moment of detection and orange at 1 day', () => {
    expect(expr[4]).toBe('#ffd400');
    expect(expr[5]).toBe(DAY);
    expect(expr[6]).toBe('#ff7518');
  });

  it('reaches purple at 2 days', () => {
    expect(expr[7]).toBe(2 * DAY);
    expect(expr[8]).toBe('#c05de1');
  });

  it('interpolates smoothly between the bands (not stepped)', () => {
    expect(expr[1]).toEqual(['linear']);
    expect(evalRamp(expr, 12 * 3600_000)).toBe('#ffd400→#ff7518'); // 12 h: yellow→orange
    expect(evalRamp(expr, 1.5 * DAY)).toBe('#ff7518→#c05de1'); //   36 h: orange→purple
  });
});

describe('hotspot time window', () => {
  it('shows only detections acquired at or before the scrub time', () => {
    const f = timeFilter(T) as unknown[];
    expect(f[0]).toBe('all');
    expect((f[1] as unknown[])[0]).toBe('<=');
  });

  it('hides detections older than 3 days', () => {
    expect(HOTSPOT_MAX_AGE_MS).toBe(3 * DAY);
    const lower = (timeFilter(T) as unknown[])[2] as unknown[];
    expect(lower[0]).toBe('>=');
    expect(lower[2]).toBe(T - 3 * DAY);
  });
});
