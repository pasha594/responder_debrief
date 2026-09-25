import { describe, expect, it } from 'vitest';
import {
  formatUnitId,
  landClass,
  landQueryUrl,
  landUnitAt,
  type LandStatusFC,
} from './nifcLandStatus';

describe('landQueryUrl', () => {
  it('builds a public-only, simplified, paged envelope query', () => {
    const url = landQueryUrl([-121.4, 47.8, -120.2, 48.8], 2000);
    expect(url).toContain('where=JurisdictionalCategory+IS+NOT+NULL');
    expect(url).toContain('geometry=-121.4%2C47.8%2C-120.2%2C48.8');
    expect(url).toContain('resultOffset=2000');
    expect(url).toContain('resultRecordCount=2000');
    expect(url).toContain('maxAllowableOffset=0.0001');
    expect(url).toContain('orderByFields=OBJECTID');
    expect(url).toContain('f=geojson');
    expect(url).toContain(
      'outFields=JurisdictionalUnitName%2CJurisdictionalCategory%2CJurisdictionalUnitID_sansUS',
    );
  });
});

describe('formatUnitId', () => {
  it('writes NWCG unit IDs with the state dash', () => {
    expect(formatUnitId('WAOWF')).toBe('WA-OWF');
    expect(formatUnitId('CANEU')).toBe('CA-NEU');
    expect(formatUnitId(null)).toBeNull();
    expect(formatUnitId('')).toBeNull();
  });
});

describe('landClass', () => {
  it("uses NIFC's colors, grouped codes sharing one class", () => {
    expect(landClass('USFS').fill).toBe('#cdebc5');
    expect(landClass('BIA')).toBe(landClass('Tribal'));
    expect(landClass('County')).toBe(landClass('City'));
  });
  it('falls back to other federal for unknown codes', () => {
    expect(landClass('NewAgency')).toBe(landClass('OthFed'));
    expect(landClass(null)).toBe(landClass('OthFed'));
  });
});

describe('landUnitAt', () => {
  const box: [number, number, number, number] = [0, 0, 10, 10];
  const square = (x0: number, y0: number, x1: number, y1: number) => [
    [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0],
  ];
  const fc: LandStatusFC = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        // a forest with a private inholding cut out of it
        geometry: { type: 'Polygon', coordinates: [square(0, 0, 5, 5), square(2, 2, 3, 3)] },
        properties: {
          JurisdictionalUnitName: 'Okanogan-Wenatchee National Forest',
          JurisdictionalCategory: 'USFS',
          JurisdictionalUnitID_sansUS: 'WAOWF',
        },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[square(6, 6, 7, 7)], [square(8, 8, 9, 9)]],
        },
        properties: {
          JurisdictionalUnitName: 'Some Refuge',
          JurisdictionalCategory: 'USFWS',
          JurisdictionalUnitID_sansUS: null,
        },
      },
    ],
  };

  it('names the public unit under the point', () => {
    expect(landUnitAt(fc, box, [1, 1])).toEqual({
      name: 'Okanogan-Wenatchee National Forest',
      category: 'USFS',
      agency: 'USFS',
      unitId: 'WA-OWF',
    });
  });
  it('finds points in any part of a multipolygon, with printed agency names', () => {
    expect(landUnitAt(fc, box, [8.5, 8.5])).toMatchObject({ agency: 'FWS', unitId: null });
  });
  it('reads holes and gaps inside the box as private', () => {
    expect(landUnitAt(fc, box, [2.5, 2.5])).toBe('private');
    expect(landUnitAt(fc, box, [7.5, 2])).toBe('private');
  });
  it('says nothing outside the fetched box', () => {
    expect(landUnitAt(fc, box, [11, 5])).toBeNull();
  });
});
