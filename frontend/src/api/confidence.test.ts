import { describe, expect, it } from 'vitest';
import { normalizeConfidence } from './confidence';

describe('normalizeConfidence', () => {
  it('maps the VIIRS l/n/h and Landsat L/M/H letter codes', () => {
    expect(['l', 'n', 'h'].map(normalizeConfidence)).toEqual(['low', 'nominal', 'high']);
    expect(['L', 'M', 'H'].map(normalizeConfidence)).toEqual(['low', 'nominal', 'high']);
  });
  it('buckets MODIS percentages', () => {
    expect(['25', '45', '95'].map(normalizeConfidence)).toEqual(['low', 'nominal', 'high']);
  });
  it('treats missing values as nominal', () => {
    expect(normalizeConfidence(null)).toBe('nominal');
    expect(normalizeConfidence('')).toBe('nominal');
  });
});
