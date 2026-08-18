import { describe, expect, it } from 'vitest';
import {
  activitySamples,
  bucketHotspotsByDay,
  enumerateFireLocalDays,
  fireLocalDayKey,
  fireLocalDayStart,
  hotspotActivity,
  normalizeCounts,
  sparklinePath,
} from './hotspotActivity';
import type { HotspotFeatureCollection } from '../api/types';

const LA = 'America/Los_Angeles';
const DAY = 86400_000;

function fc(timestamps: (number | undefined)[]): HotspotFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: timestamps.map((ts) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-120, 47] },
      properties: {
        latitude: 47,
        longitude: -120,
        source: 'SNPP',
        acq_date: '2026-08-17',
        acq_time: '2200.0',
        confidence: 'n',
        frp: null,
        brightness: null,
        acq_ts: ts,
      },
    })),
  } as HotspotFeatureCollection;
}

describe('fire-local day identity', () => {
  it('assigns a UTC-next-day detection to the fire-local evening', () => {
    // 2026-08-18T05:00Z is already the 18th in UTC, but 22:00 on the 17th in LA.
    const t = Date.parse('2026-08-18T05:00:00Z');
    expect(fireLocalDayKey(t, LA)).toBe('2026-08-17');
    expect(fireLocalDayKey(t, 'UTC')).toBe('2026-08-18');
  });

  it('assigns a UTC-same-day early-morning detection to the fire-local morning', () => {
    // 08:30Z = 01:30 PDT on the same calendar date.
    expect(fireLocalDayKey(Date.parse('2026-08-18T08:30:00Z'), LA)).toBe('2026-08-18');
  });

  it('finds fire-local midnight', () => {
    const t = Date.parse('2026-08-18T05:00:00Z');
    expect(fireLocalDayStart(t, LA)).toBe(Date.parse('2026-08-17T07:00:00Z'));
    expect(fireLocalDayStart(t, 'UTC')).toBe(Date.parse('2026-08-18T00:00:00Z'));
  });

  it('finds midnight on both DST transition days', () => {
    // spring forward (23h local day): 20:00 PDT on 2026-03-08
    expect(fireLocalDayStart(Date.parse('2026-03-09T03:00:00Z'), LA)).toBe(
      Date.parse('2026-03-08T08:00:00Z'),
    );
    // fall back (25h local day): 23:00 PST on 2026-11-01
    expect(fireLocalDayStart(Date.parse('2026-11-02T07:00:00Z'), LA)).toBe(
      Date.parse('2026-11-01T07:00:00Z'),
    );
  });

  it('falls back to viewer-local for an unusable IANA name', () => {
    expect(() => fireLocalDayKey(Date.now(), 'Not/AZone')).not.toThrow();
  });
});

describe('enumerateFireLocalDays', () => {
  it('covers every local day touching the window, contiguously', () => {
    const from = Date.parse('2026-08-15T18:00:00Z'); // 11:00 PDT on the 15th
    const to = Date.parse('2026-08-18T05:00:00Z'); // 22:00 PDT on the 17th
    const days = enumerateFireLocalDays(from, to, LA);
    expect(days.map((d) => d.key)).toEqual(['2026-08-15', '2026-08-16', '2026-08-17']);
    for (let i = 1; i < days.length; i++) {
      expect(days[i].start).toBe(days[i - 1].end);
    }
    expect(days[0].start).toBeLessThanOrEqual(from);
  });

  it('handles the DST fall-back day (25 local hours)', () => {
    const from = Date.parse('2026-10-31T12:00:00Z');
    const to = Date.parse('2026-11-03T12:00:00Z');
    const days = enumerateFireLocalDays(from, to, LA);
    expect(days.map((d) => d.key)).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ]);
    const fallBack = days.find((d) => d.key === '2026-11-01')!;
    expect(fallBack.end - fallBack.start).toBe(25 * 3600_000);
  });

  it('handles the DST spring-forward day (23 local hours)', () => {
    const days = enumerateFireLocalDays(
      Date.parse('2026-03-07T12:00:00Z'),
      Date.parse('2026-03-10T12:00:00Z'),
      LA,
    );
    expect(days.map((d) => d.key)).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
    ]);
    const springForward = days.find((d) => d.key === '2026-03-08')!;
    expect(springForward.end - springForward.start).toBe(23 * 3600_000);
  });

  it('returns nothing for an inverted or non-finite window', () => {
    expect(enumerateFireLocalDays(2, 1, LA)).toEqual([]);
    expect(enumerateFireLocalDays(NaN, 1, LA)).toEqual([]);
  });

  it('cannot run away on an absurd window', () => {
    const days = enumerateFireLocalDays(0, 400 * DAY, 'UTC', 30);
    expect(days).toHaveLength(30);
  });
});

describe('bucketHotspotsByDay', () => {
  it('counts detections per fire-local day and ignores unstamped ones', () => {
    const counts = bucketHotspotsByDay(
      fc([
        Date.parse('2026-08-18T05:00:00Z'), // 8/17 local
        Date.parse('2026-08-18T06:30:00Z'), // 8/17 local
        Date.parse('2026-08-18T20:00:00Z'), // 8/18 local
        undefined,
        NaN,
      ]),
      LA,
    );
    expect(counts.get('2026-08-17')).toBe(2);
    expect(counts.get('2026-08-18')).toBe(1);
    expect(counts.size).toBe(2);
  });

  it('is empty for missing/empty collections', () => {
    expect(bucketHotspotsByDay(undefined, LA).size).toBe(0);
    expect(bucketHotspotsByDay(fc([]), LA).size).toBe(0);
  });
});

describe('normalizeCounts', () => {
  it('scales against the busiest day', () => {
    expect(normalizeCounts([0, 5, 10, 2])).toEqual([0, 0.5, 1, 0.2]);
  });

  it('returns nothing when there is no activity at all', () => {
    expect(normalizeCounts([0, 0, 0])).toEqual([]);
    expect(normalizeCounts([])).toEqual([]);
  });
});

describe('hotspotActivity', () => {
  const from = Date.parse('2026-08-15T18:00:00Z');
  const to = Date.parse('2026-08-18T05:00:00Z');

  it('emits one sample per local day with real zeros between peaks', () => {
    const series = hotspotActivity(
      fc([
        Date.parse('2026-08-16T02:00:00Z'), // 8/15 local
        Date.parse('2026-08-18T04:00:00Z'), // 8/17 local
        Date.parse('2026-08-18T05:00:00Z'), // 8/17 local
      ]),
      from,
      to,
      LA,
    );
    expect(series.map((d) => d.key)).toEqual(['2026-08-15', '2026-08-16', '2026-08-17']);
    expect(series.map((d) => d.count)).toEqual([1, 0, 2]);
    expect(series.map((d) => d.value)).toEqual([0.5, 0, 1]);
  });

  it('keeps the trailing partial day inside the window (never past NOW)', () => {
    const series = hotspotActivity(fc([Date.parse('2026-08-16T02:00:00Z')]), from, to, LA);
    for (const d of series) {
      expect(d.center).toBeGreaterThanOrEqual(from);
      expect(d.center).toBeLessThanOrEqual(to);
    }
  });

  it('renders nothing when hotspots are missing or all-zero', () => {
    expect(hotspotActivity(undefined, from, to, LA)).toEqual([]);
    expect(hotspotActivity(fc([]), from, to, LA)).toEqual([]);
  });
});

describe('activitySamples', () => {
  const from = Date.parse('2026-08-15T18:00:00Z');
  const to = Date.parse('2026-08-18T05:00:00Z');
  const series = hotspotActivity(fc([Date.parse('2026-08-16T02:00:00Z')]), from, to, LA);

  it('holds the partial trailing day flat so the line reaches the NOW seam', () => {
    const pts = activitySamples(series, to);
    expect(pts).toHaveLength(series.length + 1);
    expect(pts[pts.length - 1].t).toBe(to);
    expect(pts[pts.length - 1].value).toBe(series[series.length - 1].value);
  });

  it('adds nothing when the last sample already sits on the seam', () => {
    const pts = activitySamples(series, series[series.length - 1].center);
    expect(pts).toHaveLength(series.length);
  });

  it('is empty for an empty series', () => {
    expect(activitySamples([], to)).toEqual([]);
  });
});

describe('sparklinePath', () => {
  it('maps value 0 to the baseline and 1 to the full amplitude', () => {
    const geo = sparklinePath(
      [
        { x: 0, value: 0 },
        { x: 10, value: 1 },
        { x: 20, value: 0.5 },
      ],
      30,
      20,
    )!;
    expect(geo.line).toBe('M0,30 L10,10 L20,20');
    expect(geo.area).toBe('M0,30 L0,30 L10,10 L20,20 L20,30 Z');
  });

  it('clamps out-of-range values and refuses a zero-height lane', () => {
    const geo = sparklinePath([{ x: 5, value: 4 }], 30, 20)!;
    expect(geo.line).toBe('M5,10');
    expect(sparklinePath([{ x: 5, value: 1 }], 30, 0)).toBeNull();
    expect(sparklinePath([], 30, 20)).toBeNull();
  });
});
