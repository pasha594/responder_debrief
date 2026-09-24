import { describe, expect, it } from 'vitest';
import { parseCoordinateInput, pickBestCity, streetAddressFrom, type PlaceHit } from './geocode';

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

// Shapes from live Nominatim /reverse (format=jsonv2, zoom=18) responses.
describe('streetAddressFrom', () => {
  it('reads a TIGER house number as envelope lines, US state abbreviated', () => {
    const at: [number, number] = [-121.6031, 39.7652];
    expect(
      streetAddressFrom(
        {
          lat: '39.7652084',
          lon: '-121.6030747',
          address: {
            house_number: '1091',
            road: 'Central Park Drive',
            town: 'Paradise',
            county: 'Butte County',
            state: 'California',
            'ISO3166-2-lvl4': 'US-CA',
            postcode: '95969',
            country_code: 'us',
          },
        },
        at,
      ),
    ).toEqual({ line1: '1091 Central Park Drive', line2: 'Paradise, CA 95969' });
  });

  it('prefers the city over the borough for the locality', () => {
    expect(
      streetAddressFrom(
        {
          lat: '40.7654840',
          lon: '-73.9835479',
          address: {
            amenity: 'Matts Grill',
            house_number: '932',
            road: '8th Avenue',
            suburb: 'Manhattan',
            city: 'New York',
            state: 'New York',
            'ISO3166-2-lvl4': 'US-NY',
            postcode: '10019',
            country_code: 'us',
          },
        },
        [-73.983655, 40.765606],
      ),
    ).toEqual({ line1: '932 8th Avenue', line2: 'New York, NY 10019' });
  });

  it('falls back to the county, and to the full state name outside the US', () => {
    expect(
      streetAddressFrom(
        {
          lat: '40',
          lon: '-121',
          address: { house_number: '5', road: 'Ridge Rd', county: 'Plumas County',
                     'ISO3166-2-lvl4': 'US-CA', country_code: 'us' },
        },
        [-121, 40],
      )?.line2,
    ).toBe('Plumas County, CA');
    expect(
      streetAddressFrom(
        {
          lat: '49.28',
          lon: '-123.12',
          address: { house_number: '800', road: 'Robson Street', city: 'Vancouver',
                     state: 'British Columbia', 'ISO3166-2-lvl4': 'CA-BC', country_code: 'ca' },
        },
        [-123.12, 49.28],
      )?.line2,
    ).toBe('Vancouver, British Columbia');
  });

  it('is null in wildland: a county, a road, or a creek is not an address', () => {
    const at: [number, number] = [-121.25, 40.05];
    expect(
      streetAddressFrom(
        { lat: '39.94', lon: '-120.81', address: { county: 'Plumas County', state: 'California' } },
        at,
      ),
    ).toBeNull();
    expect(
      streetAddressFrom(
        { lat: '40.0502', lon: '-121.2501', address: { road: 'Northeast Crooked River Drive' } },
        at,
      ),
    ).toBeNull();
    expect(streetAddressFrom({}, at)).toBeNull();
  });

  it('is null when the nearest house number is somebody else\'s (> 150 m off)', () => {
    const address = { house_number: '12', road: 'Main St', town: 'X' };
    // 0.001° of latitude ≈ 111 m; 0.002° ≈ 222 m
    expect(streetAddressFrom({ lat: '40.001', lon: '-121', address }, [-121, 40])).not.toBeNull();
    expect(streetAddressFrom({ lat: '40.002', lon: '-121', address }, [-121, 40])).toBeNull();
    expect(streetAddressFrom({ lat: 'x', lon: '-121', address }, [-121, 40])).toBeNull();
  });
});
