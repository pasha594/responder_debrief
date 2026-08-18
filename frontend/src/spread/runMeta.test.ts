import { describe, expect, it } from 'vitest';
import type { PyrecastRun } from '../api/types';
import { isStaleRun, runAgeHours, staleBadgeLabel, STALE_RUN_HOURS } from './runMeta';

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);

function runAt(iso: string): PyrecastRun {
  return {
    workspace: 'x',
    slug: 'x',
    run_ts: 'x',
    run_time: iso,
    horizon_hours: 169,
    centroid: null,
    bbox: null,
    toa: null,
    products: {},
  };
}

const hoursAgo = (h: number) => new Date(NOW - h * 3.6e6).toISOString();

describe('runAgeHours', () => {
  it('measures hours between run_time and now', () => {
    expect(runAgeHours(runAt(hoursAgo(5)), NOW)).toBeCloseTo(5);
  });
  it('is null for an unparseable run_time', () => {
    expect(runAgeHours(runAt('not a date'), NOW)).toBeNull();
  });
});

describe('isStaleRun', () => {
  it('is fresh inside the 24 h window and stale at the boundary', () => {
    expect(isStaleRun(runAt(hoursAgo(23.9)), NOW)).toBe(false);
    expect(isStaleRun(runAt(hoursAgo(STALE_RUN_HOURS)), NOW)).toBe(true);
    expect(isStaleRun(runAt(hoursAgo(120)), NOW)).toBe(true);
  });
  it('never flags a future-dated run (clock skew) or a broken timestamp', () => {
    expect(isStaleRun(runAt(hoursAgo(-3)), NOW)).toBe(false);
    expect(isStaleRun(runAt(''), NOW)).toBe(false);
  });
});

describe('staleBadgeLabel', () => {
  it('is null while the run is fresh', () => {
    expect(staleBadgeLabel(runAt(hoursAgo(6)), NOW)).toBeNull();
  });
  it('reads in hours just past the threshold and in days beyond that', () => {
    expect(staleBadgeLabel(runAt(hoursAgo(26)), NOW)).toBe('26 h old');
    expect(staleBadgeLabel(runAt(hoursAgo(120)), NOW)).toBe('5 d old');
  });
});
