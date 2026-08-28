import { describe, expect, it } from 'vitest';
import { parseCoordinateInput, pickBestCity, type PlaceHit } from './geocode';

describe('parseCoordinateInput', () => {
  it('parses lat-first pairs into [lon, lat]', () => {
    expect(parseCoordinateInput('48.016, -120.846')).toEqual([-120.846, 48.016]);
    expect(parseCoordinateInput('48.016 -120.846')).toEqual([-120.846, 48.016]);
    expect(parseCoordinateInput(' 37.5;-119.2 ')).toEqual([-119.2, 37.5]);
  });

  it('flips pairs that only make sense lon-first', () => {
    expect(parseCoordinateInput('-120.846, 48.016')).toEqual([-120.846, 48.016]);
  });

  it('rejects non-coordinates', () => {
    expect(parseCoordinateInput('big grass')).toBeNull();
    expect(parseCoordinateInput('200, 300')).toBeNull();
    expect(parseCoordinateInput('48')).toBeNull();
  });
});

function hit(over: Partial<PlaceHit>): PlaceHit {
  return {
    label: 'Reno',
    detail: '',
    coords: [-119.8, 39.5],
    kind: 'city',
    countryCode: 'US',
    ...over,
  };
}

describe('pickBestCity', () => {
  it('prefers a city over counties, villages, and hamlets', () => {
    const best = pickBestCity([
      hit({ kind: 'county', label: 'Reno County' }),
      hit({ kind: 'village', label: 'Reno TX', coords: [-97.6, 33.7] }),
      hit({ kind: 'city', label: 'Reno NV', state: 'Nevada' }),
      hit({ kind: 'hamlet', label: 'Reno IT', countryCode: 'IT' }),
    ]);
    expect(best?.label).toBe('Reno NV');
  });

  it('keeps the provider order within the same kind (importance ranking)', () => {
    const best = pickBestCity([
      hit({ kind: 'city', label: 'Portland OR' }),
      hit({ kind: 'city', label: 'Portland ME' }),
    ]);
    expect(best?.label).toBe('Portland OR');
  });

  it('ignores non-US places entirely', () => {
    expect(
      pickBestCity([
        hit({ kind: 'city', label: 'Moscow RU', countryCode: 'RU' }),
        hit({ kind: 'town', label: 'Moscow ID', state: 'Idaho' }),
      ])?.label,
    ).toBe('Moscow ID');
    expect(pickBestCity([hit({ kind: 'city', countryCode: 'RU' })])).toBeNull();
  });

  it('falls back through town and village when no city exists', () => {
    expect(
      pickBestCity([
        hit({ kind: 'hamlet', label: 'H' }),
        hit({ kind: 'village', label: 'V' }),
      ])?.label,
    ).toBe('V');
  });

  it('returns null for streets, counties, and empty input', () => {
    expect(pickBestCity([])).toBeNull();
    expect(pickBestCity([hit({ kind: 'county' }), hit({ kind: 'residential' })])).toBeNull();
  });

  it('raw coordinates pass straight through', () => {
    const best = pickBestCity([
      hit({ kind: 'coordinates', label: '43.7, -120.5', countryCode: undefined }),
      hit({ kind: 'city' }),
    ]);
    expect(best?.kind).toBe('coordinates');
  });
});
