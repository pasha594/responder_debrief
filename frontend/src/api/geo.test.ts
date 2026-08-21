import { describe, expect, it } from 'vitest';
import {
  bboxParam,
  boundsToImageCoords,
  boundsToLatFirst,
  bounds4326To3857,
  frameDims,
  hotspotAcqTs,
  padBounds,
  parseFireCoordinates,
  snapBoundsOut,
  geometryBounds,
} from './geo';

describe('parseFireCoordinates', () => {
  it('parses the API "lat, lon" string into [lon, lat]', () => {
    expect(parseFireCoordinates('42.6498057724059, -117.303363051783')).toEqual([
      -117.303363051783, 42.6498057724059,
    ]);
  });
  it('rejects junk', () => {
    expect(parseFireCoordinates(null)).toBeNull();
    expect(parseFireCoordinates('')).toBeNull();
    expect(parseFireCoordinates('not, numbers')).toBeNull();
    expect(parseFireCoordinates('91, 0')).toBeNull(); // lat out of range
    expect(parseFireCoordinates('0, 181')).toBeNull();
    expect(parseFireCoordinates('42.5')).toBeNull();
  });
});

describe('LatFirstBbox serialization', () => {
  it('serializes LAT-FIRST (API convention, not GeoJSON)', () => {
    expect(bboxParam({ minLat: 42.0, minLon: -118.0, maxLat: 43.0, maxLon: -117.0 })).toBe(
      '42,-118,43,-117',
    );
  });
  it('converts [w,s,e,n] bounds', () => {
    expect(boundsToLatFirst([-118, 42, -117, 43])).toEqual({
      minLat: 42,
      minLon: -118,
      maxLat: 43,
      maxLon: -117,
    });
  });
});

describe('bounds helpers', () => {
  it('pads outward', () => {
    const [w, s, e, n] = padBounds([-118, 42, -117, 43], 0.2);
    expect(w).toBeCloseTo(-118.2);
    expect(s).toBeCloseTo(41.8);
    expect(e).toBeCloseTo(-116.8);
    expect(n).toBeCloseTo(43.2);
  });
  it('snaps outward to grid', () => {
    expect(snapBoundsOut([-117.9, 42.1, -117.2, 42.6], 0.25)).toEqual([-118, 42, -117, 42.75]);
  });
});

describe('mercator', () => {
  it('projects known points', () => {
    const [x, y] = bounds4326To3857([0, 0, 0, 0]).slice(0, 2);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    const [minX, minY, maxX, maxY] = bounds4326To3857([-118, 42, -117, 43]);
    expect(minX).toBeLessThan(maxX);
    expect(minY).toBeLessThan(maxY);
    expect(minX).toBeCloseTo(-13135699.91, 0);
  });
  it('frameDims keeps aspect and caps the long edge', () => {
    const d = frameDims([0, 0, 2000, 1000], 1536);
    expect(d.width).toBe(1536);
    expect(d.height).toBe(768);
    const d2 = frameDims([0, 0, 500, 1000], 1536);
    expect(d2.height).toBe(1536);
    expect(d2.width).toBe(768);
  });
  it('image coords are TL,TR,BR,BL', () => {
    expect(boundsToImageCoords([-118, 42, -117, 43])).toEqual([
      [-118, 43],
      [-117, 43],
      [-117, 42],
      [-118, 42],
    ]);
  });
});

describe('hotspotAcqTs', () => {
  it('parses HHMM float strings as UTC', () => {
    expect(hotspotAcqTs('2026-08-16', '421.0')).toBe(Date.parse('2026-08-16T04:21:00Z'));
    expect(hotspotAcqTs('2026-08-16', '1735.0')).toBe(Date.parse('2026-08-16T17:35:00Z'));
    expect(hotspotAcqTs('2026-08-16', '0.0')).toBe(Date.parse('2026-08-16T00:00:00Z'));
  });
});

describe('geometryBounds', () => {
  it('walks polygons and multipolygons', () => {
    expect(geometryBounds({
      type: 'Polygon',
      coordinates: [[[-120, 48], [-119, 48.5], [-119.5, 47.5], [-120, 48]]],
    })).toEqual([-120, 47.5, -119, 48.5]);
    expect(geometryBounds({
      type: 'MultiPolygon',
      coordinates: [[[[-1, -1], [1, 1], [0, 2]]], [[[5, 5], [6, 4], [5.5, 6]]]],
    })).toEqual([-1, -1, 6, 6]);
    expect(geometryBounds(null)).toBeNull();
    expect(geometryBounds({ type: 'Polygon', coordinates: [] })).toBeNull();
  });
});
