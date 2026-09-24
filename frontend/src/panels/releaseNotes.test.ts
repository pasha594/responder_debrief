import { describe, expect, it } from 'vitest';
import { RELEASE_NOTES, formatReleaseDate } from './releaseNotes';

describe('RELEASE_NOTES', () => {
  it('lists real calendar days, newest first, each once', () => {
    const dates = RELEASE_NOTES.map((d) => d.date);
    for (const date of dates) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
    }
    expect(dates).toEqual([...dates].sort().reverse());
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('gives every day notes with a title and one-line summary, fixes last', () => {
    for (const day of RELEASE_NOTES) {
      expect(day.notes.length).toBeGreaterThan(0);
      // Titles key the list items.
      expect(new Set(day.notes.map((n) => n.title)).size).toBe(day.notes.length);
      for (const n of day.notes) {
        expect(n.title.trim()).not.toBe('');
        expect(n.summary.trim()).not.toBe('');
        expect(n.summary).not.toContain('\n');
      }
      const firstFix = day.notes.findIndex((n) => n.fix);
      if (firstFix >= 0) expect(day.notes.slice(firstFix).every((n) => n.fix)).toBe(true);
    }
  });
});

describe('formatReleaseDate', () => {
  it('formats the calendar day without a time-zone shift', () => {
    expect(formatReleaseDate('2026-09-24')).toBe('Thu, Sep 24, 2026');
    expect(formatReleaseDate('2026-08-17')).toBe('Mon, Aug 17, 2026');
  });
});
