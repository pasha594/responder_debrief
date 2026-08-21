import { describe, expect, it } from 'vitest';
import { ageColorExpr, timeRadiusExpr, timeStrokeExpr, HOTSPOT_MAX_AGE_MS } from './hotspotLayer';

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

describe('hotspot time window (paint-gated)', () => {
  const radius = timeRadiusExpr(T) as unknown[];
  // ["interpolate", ["linear"], ["zoom"], 5, gate, 9, gate, 13, gate]
  const gate = radius[4] as unknown[];
  const cond = gate[1] as unknown[];

  it('keeps ["zoom"] at the top level (MapLibre requirement) and collapses radius to 0 outside the window', () => {
    expect(radius[0]).toBe('interpolate');
    expect((radius[2] as unknown[])[0]).toBe('zoom');
    expect(gate[0]).toBe('case');
    expect(gate[3]).toBe(0);
  });

  it('shows only detections acquired at or before the scrub time', () => {
    const upper = cond[1] as unknown[];
    expect(upper[0]).toBe('<=');
    expect(upper[2]).toBe(T);
  });

  it('hides detections older than 3 days', () => {
    const lower = cond[2] as unknown[];
    expect(lower[0]).toBe('>=');
    expect(lower[2]).toBe(T - HOTSPOT_MAX_AGE_MS);
  });

  it('gates the stroke the same way (no phantom rings)', () => {
    const stroke = timeStrokeExpr(T) as unknown[];
    expect(stroke[0]).toBe('case');
    expect(stroke[3]).toBe(0);
  });
});
