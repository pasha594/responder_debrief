import { describe, expect, it } from 'vitest';
import { crsDatumToWgs84, crsFromWkt, forward, wgs84ToCrsDatum } from './projection';

// Reference values from PROJ 9 via GDAL 3.13.2:
//   gdaltransform -s_srs <the WKT's own GEOGCS> -t_srs <the PROJCS WKT> -output_xy
// so no datum change is involved — only
// the projection maths. ESRI WKT1 exactly as ArcGIS writes it into GeoPDFs
// (several are copied verbatim from the sample corpus).

const NAD83 =
  'GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const HARN =
  'GEOGCS["GCS_North_American_1983_HARN",DATUM["D_North_American_1983_HARN",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const NAD83_2011 =
  'GEOGCS["GCS_NAD_1983_2011",DATUM["D_NAD_1983_2011",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const CORS96 =
  'GEOGCS["GCS_NAD_1983_CORS96",DATUM["D_NAD_1983_CORS96",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const NAD27 =
  'GEOGCS["GCS_North_American_1927",DATUM["D_North_American_1927",SPHEROID["Clarke_1866",6378206.4,294.9786982]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const WGS84 =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const JAD2001 =
  'GEOGCS["GCS_JAD_2001",DATUM["D_Jamaica_2001",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const AUX_SPHERE =
  'GEOGCS["GCS_WGS_1984_Major_AuxSphere",DATUM["D_WGS_1984_Major_AuxSphere",SPHEROID["WGS_1984",6378137.0,0.0]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const METER = 'UNIT["Meter",1.0]';
const FOOT_US = 'UNIT["Foot_US",0.3048006096012192]';
const FOOT = 'UNIT["Foot",0.3048]';

function projcs(name: string, geog: string, projection: string, params: [string, string][], unit: string) {
  const ps = params.map(([k, v]) => `PARAMETER["${k}",${v}],`).join('');
  return `PROJCS["${name}",${geog},PROJECTION["${projection}"],${ps}${unit}]`;
}

const utm = (name: string, geog: string, cm: string) =>
  projcs(name, geog, 'Transverse_Mercator', [
    ['False_Easting', '500000.0'],
    ['False_Northing', '0.0'],
    ['Central_Meridian', cm],
    ['Scale_Factor', '0.9996'],
    ['Latitude_Of_Origin', '0.0'],
  ], METER);

/** [lon, lat, x, y] in the CRS's own datum and linear unit. */
type Pt = [number, number, number, number];

interface Case {
  label: string;
  wkt: string;
  kind: string;
  unitM: number;
  points: Pt[];
}

const CASES: Case[] = [
  {
    label: 'UTM 11N (NAD83), incl. 4.3° off the central meridian and 70°N',
    wkt: utm('NAD_1983_UTM_Zone_11N', NAD83, '-117.0'),
    kind: 'tm',
    unitM: 1,
    points: [
      [-117, 0, 500000.0, 0.0],
      [-117, 45, 500000.0, 4982950.40010685],
      [-115.2, 43.1, 646478.519649372, 4773492.12264231],
      [-119.9, 46.5, 277482.391159801, 5153689.8808887],
      [-113.5, 38.2, 806499.447007389, 4233799.09913476],
      [-121.3, 41.0, 138315.681071344, 4547670.14272672],
      [-117.5, 70, 480914.552217311, 7765951.38979749],
    ],
  },
  {
    label: 'UTM 11N on NAD27 (Clarke 1866)',
    wkt: utm('NAD_1927_UTM_Zone_11N', NAD27, '-117.0'),
    kind: 'tm',
    unitM: 1,
    points: [
      [-118.2, 36.4, 392390.728980484, 4028782.97293075],
      [-116.1, 33.9, 583213.487703099, 3751238.67400577],
    ],
  },
  {
    label: 'OCRS Bend-Klamath Falls TM (lat0 41.75, k 1.0002)',
    wkt: projcs('OCRS_Bend-Klamath_Falls_NAD_1983_2011_TM_Meters', NAD83_2011, 'Transverse_Mercator', [
      ['False_Easting', '80000.0'],
      ['False_Northing', '0.0'],
      ['Central_Meridian', '-121.75'],
      ['Scale_Factor', '1.0002'],
      ['Latitude_Of_Origin', '41.75'],
    ], METER),
    kind: 'tm',
    unitM: 1,
    points: [
      [-121.75, 41.75, 80000.0, 0],
      [-121.2, 42.3, 125362.395974254, 61249.3248912354],
      [-122.4, 43.6, 27506.4473171081, 205756.317023918],
      [-121.9, 41.0, 67377.1961389654, -83301.6930135074],
    ],
  },
  {
    label: 'State Plane Idaho West TM, US survey feet',
    wkt: projcs('NAD_1983_StatePlane_Idaho_West_FIPS_1103_Feet', NAD83, 'Transverse_Mercator', [
      ['False_Easting', '2624666.666666666'],
      ['False_Northing', '0.0'],
      ['Central_Meridian', '-115.75'],
      ['Scale_Factor', '0.9999333333333333'],
      ['Latitude_Of_Origin', '41.66666666666666'],
    ], FOOT_US),
    kind: 'tm',
    unitM: 0.3048006096012192,
    points: [
      [-115.75, 41.66666666666666, 2624666.66666667, 0],
      [-116.5, 44.2, 2427986.41542274, 924166.342335061],
      [-114.8, 47.9, 2857690.88420388, 2273899.21032997],
    ],
  },
  {
    label: 'Gauss_Kruger is Transverse Mercator',
    wkt: projcs('GK_Test', NAD83, 'Gauss_Kruger', [
      ['False_Easting', '500000.0'],
      ['False_Northing', '0.0'],
      ['Central_Meridian', '-117.0'],
      ['Scale_Factor', '1.0'],
      ['Latitude_Of_Origin', '0.0'],
    ], METER),
    kind: 'tm',
    unitM: 1,
    points: [[-115.4, 44.2, 627898.532301025, 4897290.37135664]],
  },
  {
    label: 'Oregon Statewide Lambert, international feet (LCC 2SP)',
    wkt: projcs('NAD_1983_Oregon_Statewide_Lambert_Feet_Intl', NAD83, 'Lambert_Conformal_Conic', [
      ['False_Easting', '1312335.958005249'],
      ['False_Northing', '0.0'],
      ['Central_Meridian', '-120.5'],
      ['Standard_Parallel_1', '43.0'],
      ['Standard_Parallel_2', '45.5'],
      ['Latitude_Of_Origin', '41.75'],
    ], FOOT),
    kind: 'lcc',
    unitM: 0.3048,
    points: [
      [-120.5, 41.75, 1312335.95800525, 0.0],
      [-123.9, 45.9, 446782.210875326, 1530735.9295708],
      [-117.0, 42.1, 2262363.58545194, 147869.224371942],
      [-121.3, 44.06, 1102085.27606611, 843040.238412977],
    ],
  },
  {
    label: 'State Plane Washington North (HARN), US survey feet (LCC 2SP)',
    wkt: projcs('NAD_1983_HARN_StatePlane_Washington_North_FIPS_4601_Feet', HARN, 'Lambert_Conformal_Conic', [
      ['False_Easting', '1640416.666666667'],
      ['False_Northing', '0.0'],
      ['Central_Meridian', '-120.8333333333333'],
      ['Standard_Parallel_1', '47.5'],
      ['Standard_Parallel_2', '48.73333333333333'],
      ['Latitude_Of_Origin', '47.0'],
    ], FOOT_US),
    kind: 'lcc',
    unitM: 0.3048006096012192,
    points: [
      [-120.8333333333333, 47.0, 1640416.66666659, 0.0],
      [-119.6, 48.6, 1938840.38883, 586039.999995927],
      [-122.3, 47.6, 1278588.87894797, 222309.799110092],
      [-119.75, 48.5, 1903061.72435358, 549015.17816057],
    ],
  },
  {
    label: 'State Plane Colorado Central (CORS96), meters (LCC 2SP)',
    wkt: projcs('NAD_1983_CORS96_StatePlane_Colorado_Central_FIPS_0502', CORS96, 'Lambert_Conformal_Conic', [
      ['False_Easting', '914401.8289'],
      ['False_Northing', '304800.6096'],
      ['Central_Meridian', '-105.5'],
      ['Standard_Parallel_1', '38.45'],
      ['Standard_Parallel_2', '39.75'],
      ['Latitude_Of_Origin', '37.83333333333334'],
    ], METER),
    kind: 'lcc',
    unitM: 1,
    points: [
      [-105.5, 37.83333333333334, 914401.8289, 304800.609600007],
      [-106.1, 39.2, 862576.249065822, 456682.012029014],
    ],
  },
  {
    label: 'LCC 1SP as ESRI writes it (no Standard_Parallel_2)',
    wkt: projcs('JAD_2001_Jamaica_Grid', JAD2001, 'Lambert_Conformal_Conic', [
      ['False_Easting', '750000.0'],
      ['False_Northing', '650000.0'],
      ['Central_Meridian', '-77.0'],
      ['Standard_Parallel_1', '18.0'],
      ['Scale_Factor', '1.0'],
      ['Latitude_Of_Origin', '18.0'],
    ], METER),
    kind: 'lcc',
    unitM: 1,
    points: [
      [-77.0, 18.0, 750000.0, 650000.0],
      [-76.3, 18.4, 823966.164294927, 694413.056097316],
      [-78.2, 17.9, 622843.276001399, 639343.495445375],
    ],
  },
  {
    label: 'LCC 1SP with SP1 = SP2 = latitude of origin and k ≠ 1',
    wkt: projcs('LCC_1SP_Scaled', NAD83, 'Lambert_Conformal_Conic', [
      ['False_Easting', '1500000.0'],
      ['False_Northing', '1166200.0'],
      ['Central_Meridian', '-110.0'],
      ['Standard_Parallel_1', '32.5'],
      ['Standard_Parallel_2', '32.5'],
      ['Scale_Factor', '0.9987864078'],
      ['Latitude_Of_Origin', '32.5'],
    ], METER),
    kind: 'lcc',
    unitM: 1,
    points: [
      [-110.0, 32.5, 1500000.0, 1166200.0],
      [-108.2, 35.1, 1664081.38193641, 1455723.07543588],
      [-112.6, 30.4, 1250310.19231623, 936632.845243694],
    ],
  },
  {
    label: 'CONUS Albers',
    wkt: projcs('NAD_1983_Contiguous_USA_Albers', NAD83, 'Albers', [
      ['False_Easting', '0.0'],
      ['False_Northing', '0.0'],
      ['Central_Meridian', '-96.0'],
      ['Standard_Parallel_1', '29.5'],
      ['Standard_Parallel_2', '45.5'],
      ['Latitude_Of_Origin', '23.0'],
    ], METER),
    kind: 'albers',
    unitM: 1,
    points: [
      [-96.0, 23.0, 0.0, 0.0],
      [-122.3, 45.6, -2026382.57716405, 2794638.22909436],
      [-75.0, 40.0, 1762648.05347658, 2082524.86469573],
      [-80.2, 25.8, 1592562.7904327, 438476.499662122],
      [-120.9, 46.4, -1898066.37160386, 2851324.37670121],
    ],
  },
  {
    label: 'Web Mercator (Mercator_Auxiliary_Sphere)',
    wkt: projcs('WGS_1984_Web_Mercator_Auxiliary_Sphere', WGS84, 'Mercator_Auxiliary_Sphere', [
      ['False_Easting', '0.0'],
      ['False_Northing', '0.0'],
      ['Central_Meridian', '0.0'],
      ['Standard_Parallel_1', '0.0'],
      ['Auxiliary_Sphere_Type', '0.0'],
    ], METER),
    kind: 'webmercator',
    unitM: 1,
    points: [
      [0.0, 0.0, 0.0, 0.0],
      [-116.5, 46.0, -12968720.6774164, 5780349.22025635],
      [-179.0, 84.0, -19926188.851996, 18807214.0967477],
    ],
  },
  {
    label: 'Web Mercator as the sample PDFs write it (Mercator, 1/f = 0)',
    wkt: projcs('WGS_1984_Web_Mercator', AUX_SPHERE, 'Mercator', [
      ['False_Easting', '0.0'],
      ['False_Northing', '0.0'],
      ['Central_Meridian', '0.0'],
      ['Standard_Parallel_1', '0.0'],
    ], METER),
    kind: 'webmercator',
    unitM: 1,
    points: [
      [-116.5, 46.0, -12968720.6774164, 5780349.22025635],
      [-111.2, 47.3, -12378727.376212, 5991179.92465175],
    ],
  },
  {
    label: 'World Mercator (ellipsoidal)',
    wkt: projcs('WGS_1984_World_Mercator', WGS84, 'Mercator', [
      ['False_Easting', '0.0'],
      ['False_Northing', '0.0'],
      ['Central_Meridian', '0.0'],
      ['Standard_Parallel_1', '0.0'],
    ], METER),
    kind: 'mercator',
    unitM: 1,
    points: [
      [-116.5, 46.0, -12968720.6774164, 5749599.54636159],
      [10.0, -60.0, 1113194.90793274, -8362698.54850075],
    ],
  },
  {
    label: 'Mercator 2SP (standard parallel −41°)',
    wkt: projcs('WGS_1984_Mercator_41', WGS84, 'Mercator', [
      ['False_Easting', '0.0'],
      ['False_Northing', '0.0'],
      ['Central_Meridian', '100.0'],
      ['Standard_Parallel_1', '-41.0'],
    ], METER),
    kind: 'mercator',
    unitM: 1,
    points: [
      [147.3, -42.9, 3979594.2558956, -3981299.31723373],
      [100.0, 0.0, 0.0, 0.0],
    ],
  },
];

describe('forward', () => {
  it.each(CASES)('$label matches PROJ to 1 mm', ({ wkt, kind, unitM, points }) => {
    const crs = crsFromWkt(wkt, [0, 0]);
    expect(crs.kind).toBe(kind);
    expect(crs.approximate).toBe(false);
    expect(crs.unitM).toBe(unitM);
    for (const [lon, lat, x, y] of points) {
      const [px, py] = forward(crs, lon, lat);
      // 1 mm, expressed in the CRS unit.
      expect(Math.abs(px - x) * unitM).toBeLessThan(1e-3);
      expect(Math.abs(py - y) * unitM).toBeLessThan(1e-3);
    }
  });

  it('accepts OGC WKT1 spellings (Albers_Conic_Equal_Area, latitude_of_center …)', () => {
    const ogc =
      'PROJCS["NAD83 / Conus Albers",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","6269"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4269"]],PROJECTION["Albers_Conic_Equal_Area"],PARAMETER["latitude_of_center",23],PARAMETER["longitude_of_center",-96],PARAMETER["standard_parallel_1",29.5],PARAMETER["standard_parallel_2",45.5],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","5070"]]';
    const crs = crsFromWkt(ogc, [0, 0]);
    expect(crs.kind).toBe('albers');
    const [x, y] = forward(crs, -122.3, 45.6);
    expect(x).toBeCloseTo(-2026382.57716405, 3);
    expect(y).toBeCloseTo(2794638.22909436, 3);
  });

  it('passes lon/lat straight through for a bare GEOGCS', () => {
    const crs = crsFromWkt(WGS84, [0, 0]);
    expect(crs.kind).toBe('geographic');
    expect(crs.approximate).toBe(false);
    expect(forward(crs, -116.25, 45.5)).toEqual([-116.25, 45.5]);
  });
});

describe('crsFromWkt', () => {
  it('reads ellipsoid, datum and parameters', () => {
    const crs = crsFromWkt(utm('NAD_1927_UTM_Zone_11N', NAD27, '-117.0'), [0, 0]);
    expect(crs.name).toBe('NAD_1927_UTM_Zone_11N');
    expect(crs.datum).toBe('nad27');
    expect(crs.a).toBe(6378206.4);
    expect(1 / crs.f).toBeCloseTo(294.9786982, 9);
    expect(crs.lon0).toBe(-117);
    expect(crs.k0).toBe(0.9996);
    expect(crs.fe).toBe(500000);
    const nad83 = crsFromWkt(utm('NAD_1983_UTM_Zone_11N', NAD83, '-117.0'), [0, 0]);
    expect(nad83.datum).toBe('wgs84');
  });

  it('falls back to a local TM at the control-point centroid for unknown projections', () => {
    const wkt = projcs('Some_Polyconic', NAD83, 'Polyconic', [['Central_Meridian', '-100.0']], METER);
    const crs = crsFromWkt(wkt, [-116.4, 43.2]);
    expect(crs.kind).toBe('local-tm');
    expect(crs.approximate).toBe(true);
    expect([crs.lon0, crs.lat0]).toEqual([-116.4, 43.2]);
    // Origin of the local TM is the centroid.
    const [x, y] = forward(crs, -116.4, 43.2);
    expect(Math.abs(x)).toBeLessThan(1e-6);
    expect(Math.abs(y)).toBeLessThan(1e-6);
  });

  it('falls back to a local TM for a missing or malformed WKT', () => {
    for (const wkt of [null, '', 'PROJCS["broken",GEOGCS[', 'not wkt at all']) {
      const crs = crsFromWkt(wkt, [-120, 40]);
      expect(crs.kind).toBe('local-tm');
      expect(crs.approximate).toBe(true);
      expect(crs.datum).toBe('wgs84');
      expect(crs.a).toBe(6378137);
    }
  });

  it('keeps the NAD27 datum on a local-TM fallback', () => {
    const wkt = projcs('NAD27_Polyconic', NAD27, 'Polyconic', [], METER);
    const crs = crsFromWkt(wkt, [-120, 40]);
    expect(crs.kind).toBe('local-tm');
    expect(crs.datum).toBe('nad27');
  });
});

describe('NAD27 3-parameter shift', () => {
  // PROJ with exactly the same transform (no NADCON grids):
  //   gdaltransform -s_srs '+proj=longlat +ellps=clrk66 +towgs84=-8,160,176,0,0,0,0'
  //                 -t_srs '+proj=longlat +datum=WGS84'
  const TO_WGS84: Pt[] = [
    [-117.3, 34.1, -117.300872305038, 34.1000249705173],
    [-105.0, 40.0, -105.00057543594, 39.9999880480788],
    [-120.6, 38.9, -120.601018265185, 38.8998965980415],
    [-80.0, 35.0, -79.9997819499385, 35.0001085112154],
    [-149.9, 61.2, -149.902649100707, 61.1995315179692],
  ];
  // …and the reverse direction (input WGS84, output NAD27).
  const FROM_WGS84: Pt[] = [
    [-117.3, 34.1, -117.29912772097, 34.0999750227362],
    [-105.0, 40.0, -104.999424584809, 40.0000119491546],
    [-120.6, 38.9, -120.598981763542, 38.9001033945528],
    [-80.0, 35.0, -80.0002180418509, 34.9998914867393],
    [-149.9, 61.2, -149.897350920622, 61.2004684206996],
  ];
  const crs = crsFromWkt(utm('NAD_1927_UTM_Zone_11N', NAD27, '-117.0'), [0, 0]);

  it('NAD27 → WGS84 matches PROJ to ~1 mm', () => {
    for (const [lon, lat, wlon, wlat] of TO_WGS84) {
      const [x, y] = crsDatumToWgs84(crs, lon, lat);
      expect(Math.abs(x - wlon)).toBeLessThan(1e-8);
      expect(Math.abs(y - wlat)).toBeLessThan(1e-8);
    }
  });

  it('WGS84 → NAD27 matches PROJ to ~1 mm and inverts the forward shift exactly', () => {
    for (const [lon, lat, nlon, nlat] of FROM_WGS84) {
      const [x, y] = wgs84ToCrsDatum(crs, lon, lat);
      expect(Math.abs(x - nlon)).toBeLessThan(1e-8);
      expect(Math.abs(y - nlat)).toBeLessThan(1e-8);
      const [blon, blat] = crsDatumToWgs84(crs, x, y);
      expect(Math.abs(blon - lon)).toBeLessThan(1e-11);
      expect(Math.abs(blat - lat)).toBeLessThan(1e-11);
    }
  });

  it('is the identity for every other datum', () => {
    const nad83 = crsFromWkt(utm('NAD_1983_UTM_Zone_11N', NAD83, '-117.0'), [0, 0]);
    expect(crsDatumToWgs84(nad83, -117.3, 34.1)).toEqual([-117.3, 34.1]);
    expect(wgs84ToCrsDatum(nad83, -117.3, 34.1)).toEqual([-117.3, 34.1]);
  });
});
