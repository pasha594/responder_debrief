import { describe, expect, it } from 'vitest';
import { formatAcres, formatBytes, formatDateTime, formatPct, formatRelative } from './format';

describe('formatAcres', () => {
  it('groups small values', () => {
    expect(formatAcres(1234)).toBe('1,234 ac');
    expect(formatAcres(0)).toBe('0 ac');
    expect(formatAcres(9999)).toBe('9,999 ac');
  });
  it('abbreviates thousands', () => {
    expect(formatAcres(12_340)).toBe('12.3k ac');
    expect(formatAcres(50_000)).toBe('50k ac');
  });
  it('abbreviates millions', () => {
    expect(formatAcres(1_230_000)).toBe('1.2M ac');
    expect(formatAcres(2_000_000)).toBe('2M ac');
  });
  it('em-dashes nulls and junk', () => {
    expect(formatAcres(null)).toBe('—');
    expect(formatAcres(undefined)).toBe('—');
    expect(formatAcres(NaN)).toBe('—');
    expect(formatAcres(-5)).toBe('—');
  });
});

describe('formatPct', () => {
  it('rounds and suffixes', () => {
    expect(formatPct(71)).toBe('71%');
    expect(formatPct(70.6)).toBe('71%');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(100)).toBe('100%');
  });
  it('em-dashes nulls', () => {
    expect(formatPct(null)).toBe('—');
    expect(formatPct(undefined)).toBe('—');
    expect(formatPct(NaN)).toBe('—');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-08-17T12:00:00Z');
  it('handles just now', () => {
    expect(formatRelative('2026-08-17T11:59:40Z', now)).toBe('just now');
  });
  it('handles minutes', () => {
    expect(formatRelative('2026-08-17T11:55:00Z', now)).toBe('5 min ago');
  });
  it('handles hours', () => {
    expect(formatRelative('2026-08-17T10:00:00Z', now)).toBe('2 h ago');
  });
  it('handles days', () => {
    expect(formatRelative('2026-08-14T12:00:00Z', now)).toBe('3 d ago');
  });
  it('handles the future', () => {
    expect(formatRelative('2026-08-17T14:00:00Z', now)).toBe('in 2 h');
  });
  it('em-dashes junk', () => {
    expect(formatRelative('not a date', now)).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('formats in the given IANA zone with a short tz name', () => {
    const s = formatDateTime('2026-08-17T18:00:00Z', 'America/Denver');
    expect(s).toContain('Aug 17');
    expect(s).toContain('12');
    expect(s).toContain('MDT');
  });
  it('survives an invalid timezone', () => {
    const s = formatDateTime('2026-08-17T18:00:00Z', 'Not/AZone');
    expect(s).toContain('Aug 17');
  });
  it('honors option overrides', () => {
    const s = formatDateTime('2026-08-17T18:00:00Z', 'UTC', { timeZoneName: undefined });
    expect(s).not.toContain('UTC');
  });
  it('em-dashes junk', () => {
    expect(formatDateTime('nope')).toBe('—');
  });
});

describe('formatBytes', () => {
  it('covers all magnitudes', () => {
    expect(formatBytes(890)).toBe('890 B');
    expect(formatBytes(348_160)).toBe('340 KB');
    expect(formatBytes(11 * 1024 * 1024)).toBe('11 MB');
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
  });
  it('one decimal below 10 MB', () => {
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
  it('em-dashes nulls', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});
