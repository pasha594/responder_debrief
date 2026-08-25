import { describe, expect, it } from 'vitest';
import { clampIncidentBox, INCIDENT_KINDS } from './tomtomTraffic';

describe('clampIncidentBox', () => {
  it('clamps oversized boxes under the API area limit', () => {
    const out = clampIncidentBox([-122, 40, -119, 43]);
    expect(out[2] - out[0]).toBeCloseTo(1.1, 5);
    expect(out[3] - out[1]).toBeCloseTo(0.9, 5);
    // centered on the original box
    expect((out[0] + out[2]) / 2).toBeCloseTo(-120.5, 5);
  });

  it('leaves small boxes untouched', () => {
    const out = clampIncidentBox([-120.4, 47.8, -120.0, 48.1]);
    expect(out[0]).toBeCloseTo(-120.4, 5);
    expect(out[3]).toBeCloseTo(48.1, 5);
  });
});

describe('incident kinds', () => {
  it('flags road closures distinctly', () => {
    expect(INCIDENT_KINDS[8].closure).toBe(true);
    expect(INCIDENT_KINDS[9].closure).toBe(false);
  });
});
