import { describe, expect, it } from 'vitest';
import {
  epsgToUtm,
  lonLatToUtm,
  utmBoundsTo4326,
  utmToLonLat,
  utmZoneFor,
  zoneCentralMeridian,
} from './utm';

// Reference pairs generated with GDAL (gdaltransform -s_srs EPSG:326xx
// -t_srs EPSG:4326) — zones 10, 11 and 13. Assertions at 1e-5° (~1 m),
// far tighter than the 30 m archive pixels.
const CASES: {
  epsg: number;
  utm: [number, number];
  lonLat: [number, number];
}[] = [
  { epsg: 32610, utm: [550000, 5272000], lonLat: [-122.334848983095, 47.5994802452969] },
  { epsg: 32611, utm: [302778.27, 5401705], lonLat: [-119.682441858261, 48.7371212511715] },
  { epsg: 32613, utm: [500000, 4400000], lonLat: [-105, 39.7499075191046] },
];

describe('epsgToUtm', () => {
  it('decodes 326xx (north) and 327xx (south)', () => {
    expect(epsgToUtm(32611)).toEqual({ zone: 11, northern: true });
    expect(epsgToUtm(32719)).toEqual({ zone: 19, northern: false });
  });
  it('rejects non-UTM codes', () => {
    expect(epsgToUtm(4326)).toBeNull();
    expect(epsgToUtm(32661)).toBeNull(); // zone 61 does not exist
    expect(epsgToUtm(3857)).toBeNull();
  });
});

describe('utmToLonLat', () => {
  it.each(CASES)('matches the GDAL reference for EPSG:$epsg', ({ epsg, utm, lonLat }) => {
    const { zone, northern } = epsgToUtm(epsg)!;
    const [lon, lat] = utmToLonLat(utm[0], utm[1], zone, northern);
    expect(lon).toBeCloseTo(lonLat[0], 5);
    expect(lat).toBeCloseTo(lonLat[1], 5);
  });

  it('is exact on the central meridian at the equator', () => {
    const [lon, lat] = utmToLonLat(500000, 0, 10, true);
    expect(lon).toBeCloseTo(zoneCentralMeridian(10), 9);
    expect(lat).toBeCloseTo(0, 9);
  });
});

describe('utmBoundsTo4326', () => {
  // Real archive grid (wa-sinlahekin, EPSG:32611): GDAL corner references.
  const bbox: [number, number, number, number] = [253218.27, 5354785, 352338.27, 5448625];

  it('corner-pins TL,TR,BR,BL and encloses them in [w,s,e,n]', () => {
    const { corners, bounds } = utmBoundsTo4326(bbox, 11, true);
    const [tl, tr, br, bl] = corners;
    // GDAL: BL (minX,minY) → -120.327692439699, 48.2980811540256
    expect(bl[0]).toBeCloseTo(-120.327692439699, 5);
    expect(bl[1]).toBeCloseTo(48.2980811540256, 5);
    // GDAL: TR (maxX,maxY) → -119.025894249654, 49.1726545522232
    expect(tr[0]).toBeCloseTo(-119.025894249654, 5);
    expect(tr[1]).toBeCloseTo(49.1726545522232, 5);
    // Corner ordering sanity: TL west of TR, TL north of BL.
    expect(tl[0]).toBeLessThan(tr[0]);
    expect(tl[1]).toBeGreaterThan(bl[1]);
    expect(br[1]).toBeLessThan(tr[1]);
    // Bounds enclose every corner.
    for (const [lon, lat] of corners) {
      expect(lon).toBeGreaterThanOrEqual(bounds[0]);
      expect(lat).toBeGreaterThanOrEqual(bounds[1]);
      expect(lon).toBeLessThanOrEqual(bounds[2]);
      expect(lat).toBeLessThanOrEqual(bounds[3]);
    }
  });

  it('reflects the projected rectangle not being lon/lat-aligned', () => {
    const { corners } = utmBoundsTo4326(bbox, 11, true);
    const [tl, , , bl] = corners;
    // West of the central meridian the grid tilts: TL and BL lons differ.
    expect(Math.abs(tl[0] - bl[0])).toBeGreaterThan(1e-4);
  });
});

describe('lonLatToUtm (forward)', () => {
  it('matches the GDAL reference pairs to a centimetre', () => {
    for (const c of CASES) {
      const z = epsgToUtm(c.epsg)!;
      const [e, n] = lonLatToUtm(c.lonLat[0], c.lonLat[1], z.zone, z.northern);
      expect(Math.abs(e - c.utm[0])).toBeLessThan(0.01);
      expect(Math.abs(n - c.utm[1])).toBeLessThan(0.01);
    }
    // worker/responder_worker/utm.py test point (gdaltransform EPSG:32611)
    const [e, n] = lonLatToUtm(-115, 44, 11);
    expect(e).toBeCloseTo(660349.4106, 3);
    expect(n).toBeCloseTo(4873817.3334, 3);
  });

  it('round-trips with the inverse across zones and hemispheres', () => {
    for (const zone of [10, 11, 12, 13, 17, 19]) {
      for (const dl of [-3, -1.5, 0, 1.2, 2.9]) {
        for (const lat of [26, 35.5, 44.2, 48.9]) {
          const lon = zoneCentralMeridian(zone) + dl;
          const [e, n] = lonLatToUtm(lon, lat, zone);
          const [lo, la] = utmToLonLat(e, n, zone);
          expect(Math.abs(lo - lon)).toBeLessThan(1e-5);
          expect(Math.abs(la - lat)).toBeLessThan(1e-5);
        }
      }
    }
    const [e, n] = lonLatToUtm(-170.7, -14.3, 2, false);
    const [lo, la] = utmToLonLat(e, n, 2, false);
    expect(lo).toBeCloseTo(-170.7, 5);
    expect(la).toBeCloseTo(-14.3, 5);
  });

  it('picks the zone from longitude', () => {
    expect(utmZoneFor(-115.2)).toBe(11);
    expect(utmZoneFor(-120)).toBe(11);
    expect(utmZoneFor(-120.01)).toBe(10);
  });
});
