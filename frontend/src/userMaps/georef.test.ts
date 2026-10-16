import { describe, expect, it } from 'vitest';
import { buildGeoModel, georefFromViewports, plausibleLocation } from './georef';
import { crsDatumToWgs84, crsFromWkt } from './projection';
import type { Box, GeoModel, LonLat, RawViewport } from './types';
import { utmToLonLat } from '../spread/utm';
import fixture from './__fixtures__/gdalGeoref.json';

// Ground truth: GDAL 3.13.2's own placement of 67 real GeoPDF pages
// (GDAL_PDF_DPI=72 gdalinfo → frame corners → gdaltransform to EPSG:4326, and
// to the PDF's own GEOGCS for the "native" set). Viewports are the pages' /VP
// exactly as written (de-duplicated; /Bounds dropped — it always equals the
// LPTS ring and nothing reads it), with the full /GCS /WKT. The frame corner
// GDAL reports must come back to the same page point through lonLatToPage.
type Corners = Record<'tl' | 'tr' | 'br' | 'bl' | 'center', LonLat>;
interface FixturePage {
  name: string;
  viewports: RawViewport[];
  mainViewportIndex: number;
  frame: Box;
  gdalCornersLonLat: Corners;
  gdalCornersLonLatNative: Corners;
}
const PAGES = (fixture as unknown as { pages: FixturePage[] }).pages.map((p, i) => ({
  ...p,
  label: `${i}: ${p.name}`,
}));

function page(re: RegExp): (typeof PAGES)[number] {
  const p = PAGES.find((x) => re.test(x.name));
  if (!p) throw new Error(`no fixture page matches ${re}`);
  return p;
}

/** Ground meters between two nearby WGS84 points. */
function meters(a: LonLat, b: LonLat): number {
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dy = (b[1] - a[1]) * 111132.954;
  const dx = (b[0] - a[0]) * 111319.49 * Math.cos(lat);
  return Math.hypot(dx, dy);
}

/** Per-corner page-point error of lonLatToPage(GDAL corner), in ground meters. */
function cornerErrors(
  p: FixturePage,
  model: GeoModel,
  corners: Corners = p.gdalCornersLonLat,
): Record<string, number> {
  const [x0, y0, x1, y1] = model.georef.frame;
  const truth: Record<string, [number, number]> = {
    tl: [x0, y1],
    tr: [x1, y1],
    br: [x1, y0],
    bl: [x0, y0],
    center: [(x0 + x1) / 2, (y0 + y1) / 2],
  };
  const out: Record<string, number> = {};
  for (const k of Object.keys(truth)) {
    const [lon, lat] = corners[k as keyof Corners];
    const [px, py] = model.lonLatToPage(lon, lat);
    out[k] = Math.hypot(px - truth[k][0], py - truth[k][1]) * model.metersPerPoint;
  }
  return out;
}

/**
 * Corner/centre tolerance against GDAL's EPSG:4326 corners, which include
 * PROJ's NAD83 → WGS84 transform (≤1.3 m) that we treat as identity; NAD27 is
 * shifted with 3 parameters here vs the NADCON grid in PROJ. Measured worst
 * cases (m): TM 0.99, LCC 1.27 (HARN; a uniform datum offset), Albers 0.86,
 * geographic and Web Mercator ~0, NAD27 2.94. Against GDAL's native-datum
 * corners every page is within 0.093 m (GDAL anchors its north-up snap on the
 * MediaBox corners, we on the frame corners).
 */
function tolerance(p: FixturePage): number {
  const wkt = p.viewports[p.mainViewportIndex].wkt;
  if (crsFromWkt(wkt, [0, 0]).datum === 'nad27') return 10;
  if (/three-queens__LARGE/.test(p.name)) return 2;
  return 1.5;
}

describe('GDAL fixtures', () => {
  it('covers all 67 georeferenced sample pages', () => {
    expect(PAGES).toHaveLength(67);
  });

  it.each(PAGES)('$label lands on GDAL’s frame', (p) => {
    const georef = georefFromViewports(p.viewports);
    expect(georef).not.toBeNull();
    // Main frame = the viewport GDAL picked, normalized.
    expect(georef!.frame).toEqual(p.frame);
    expect(georef!.wkt).toBe(p.viewports[p.mainViewportIndex].wkt);

    const model = buildGeoModel(georef!);
    expect(model.approximate).toBe(false);
    expect(model.fitResidualM).toBeLessThan(1);
    expect(georef!.warnings).not.toContain('poor_fit');

    const errs = cornerErrors(p, model);
    const tol = tolerance(p);
    for (const k of ['tl', 'tr', 'br', 'bl', 'center']) expect(errs[k], k).toBeLessThan(tol);

    // Same corners in the PDF's own datum (our NAD27 shift applied, then
    // undone by lonLatToPage): only the projection + fit differ from GDAL's.
    const crs = crsFromWkt(georef!.wkt, [0, 0]);
    const native = Object.fromEntries(
      Object.entries(p.gdalCornersLonLatNative).map(([k, ll]) => [k, crsDatumToWgs84(crs, ll[0], ll[1])]),
    ) as Corners;
    const nativeErrs = cornerErrors(p, model, native);
    for (const k of ['tl', 'tr', 'br', 'bl', 'center']) expect(nativeErrs[k], `native ${k}`).toBeLessThan(0.15);

    // pageToLonLat ∘ lonLatToPage round-trips at every corner and the centre.
    for (const ll of Object.values(p.gdalCornersLonLat)) {
      const [px, py] = model.lonLatToPage(ll[0], ll[1]);
      expect(meters(model.pageToLonLat(px, py), ll)).toBeLessThan(0.01);
    }
  });

  it('three-queens LARGE (inverted BBox, LPTS outside the unit square, Albers) is within 2 m', () => {
    const p = page(/three-queens__LARGE/);
    const vp = p.viewports[p.mainViewportIndex];
    expect(vp.bbox[1]).toBeGreaterThan(vp.bbox[3]); // inverted as written
    expect(vp.lpts.some((v) => v < 0 || v > 1)).toBe(true);
    const georef = georefFromViewports(p.viewports)!;
    expect(crsFromWkt(georef.wkt, [0, 0]).kind).toBe('albers');
    expect(georef.frame[1]).toBeLessThan(georef.frame[3]);
    const errs = cornerErrors(p, buildGeoModel(georef));
    expect(Math.max(...Object.values(errs))).toBeLessThan(2);
  });

  it('sinlahekin camp (frame rotated 90°: page-left is north) is within 1.5 m', () => {
    const p = page(/sinlahekin__camp/);
    const model = buildGeoModel(georefFromViewports(p.viewports)!);
    const errs = cornerErrors(p, model);
    expect(Math.max(...Object.values(errs))).toBeLessThan(1.5);
    const [x0, y0, x1, y1] = model.georef.frame;
    const left = model.pageToLonLat(x0, (y0 + y1) / 2);
    const right = model.pageToLonLat(x1, (y0 + y1) / 2);
    const top = model.pageToLonLat((x0 + x1) / 2, y1);
    const bottom = model.pageToLonLat((x0 + x1) / 2, y0);
    expect(left[1]).toBeGreaterThan(right[1]); // left edge is north
    expect(top[0]).toBeGreaterThan(bottom[0]); // top edge is east
  });

  it('Elk PIO (LPTS in TL, BL, BR, TR order) is within 1.5 m', () => {
    const p = page(/pio_85x11_port_20260816_2056_Elk/);
    expect(p.viewports[p.mainViewportIndex].lpts).toEqual([0, 1, 0, 0, 1, 0, 1, 1]);
    const errs = cornerErrors(p, buildGeoModel(georefFromViewports(p.viewports)!));
    expect(Math.max(...Object.values(errs))).toBeLessThan(1.5);
  });

  it('NAD27 page is shifted to WGS84 (GDAL used NADCON: ~90 m) within 10 m', () => {
    const p = page(/dome__pilot_combined_11x17_land_20261013/);
    const georef = georefFromViewports(p.viewports)!;
    const model = buildGeoModel(georef);
    expect(georef.warnings).toContain('nad27_shifted');
    expect(Math.max(...Object.values(cornerErrors(p, model)))).toBeLessThan(10);
  });

  it('metersPerPoint matches GDAL’s pixel size (BAM 72×72: 31.750 grid m/pt ÷ k 0.9996)', () => {
    const p = page(/BAM_72x72_sqar_BigGrass_20260817/);
    const model = buildGeoModel(georefFromViewports(p.viewports)!);
    expect(model.metersPerPoint).toBeCloseTo(31.7501 / 0.9996, 2);
  });

  it('only mcconnell (GPTS at 0.04°N) fails plausibleLocation', () => {
    const failing = PAGES.filter(
      (p) => !plausibleLocation(buildGeoModel(georefFromViewports(p.viewports)!)),
    ).map((p) => p.name);
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatch(/^mcconnell__pilot_table/);
  });

  it('flags inset_in_frame exactly on the pages with an inset inside the main frame', () => {
    const flagged = PAGES.filter((p) =>
      georefFromViewports(p.viewports)!.warnings.includes('inset_in_frame'),
    ).map((p) => p.name.replace(/#p\d+$/, ''));
    // georef-formats.md: BigGrass trans_* ×3, wrights-spring, frijoles pio, mukluk.
    // Not the locator maps beside the frame (Coleman ops ×2, Elk PIO).
    expect(flagged.sort()).toEqual(
      [
        'frijoles__pio_8.5x11_port_20260826_2116_Frijoles_NMSNF000444_0827day.pdf',
        'mukluk__facilities_85_x_11_land_20260903_2019_Mukluk_AKTAS613487_0904day.pdf',
        'trans_arch_e_land_20260817_1943_BigGrass_ORVAD260201_0818day.pdf',
        'trans_arch_e_land_20260817_2104_BigGrass_ORVAD260201_0818day.pdf',
        'trans_arch_e_land_20260818_0625_BigGrass_ORVAD260201_0818day.pdf',
        'wrights-spring__pio_arch_e_land_20260820_0752_WrightsSpring_ORFWF260286_0820Day.pdf',
      ].sort(),
    );
  });
});

// ───────────────────────── synthetic viewports ─────────────────────────

const UTM11 =
  'PROJCS["NAD_1983_UTM_Zone_11N",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-117.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

// A 19 × 25 km north-up UTM 11N frame near 43°N: corners are a grid
// rectangle, so they are exactly affine to the page frame.
const [BL, TL, TR, BR] = (
  [
    [470000, 4760000],
    [470000, 4785000],
    [489000, 4785000],
    [489000, 4760000],
  ] as const
).map(([e, n]) => utmToLonLat(e, n, 11));
/** BL, TL, TR, BR as (lat, lon) — ISO 32000 GPTS order. */
const GPTS = [BL, TL, TR, BR].flatMap(([lon, lat]) => [lat, lon]);

function vp(over: Partial<RawViewport> = {}): RawViewport {
  return {
    bbox: [36, 36, 576, 756],
    name: null,
    geo: true,
    gpts: GPTS,
    lpts: [0, 0, 0, 1, 1, 1, 1, 0],
    bounds: null,
    wkt: UTM11,
    ...over,
  };
}

describe('georefFromViewports', () => {
  it('returns null without a usable GEO viewport', () => {
    expect(georefFromViewports([])).toBeNull();
    expect(georefFromViewports([vp({ geo: false })])).toBeNull();
    // Only two valid points (one lat out of range, one NaN).
    expect(georefFromViewports([vp({ gpts: [43, -116.4, 95, -116.4, 43.2, -116.2, NaN, -116.2] })])).toBeNull();
    // Collinear control points.
    expect(georefFromViewports([vp({ lpts: [0, 0, 0.5, 0.5, 1, 1, 0.25, 0.25] })])).toBeNull();
    // Degenerate BBox.
    expect(georefFromViewports([vp({ bbox: [36, 36, 36, 756] })])).toBeNull();
  });

  it('applies LPTS to the BBox as written and swaps GPTS to lon/lat', () => {
    const g = georefFromViewports([vp({ bbox: [36, 756, 576, 36] })])!;
    expect(g.frame).toEqual([36, 36, 576, 756]);
    // y = y0 + ly·(y1 − y0) with the inverted y0 = 756.
    expect(g.points[0]).toEqual({ page: [36, 756], lonLat: BL });
    expect(g.points[1]).toEqual({ page: [36, 36], lonLat: TL });
    expect(g.v).toBe(1);
    expect(g.wkt).toBe(UTM11);
  });

  it('picks the first strictly largest GEO viewport after de-duplication', () => {
    const small = vp({ bbox: [100, 100, 200, 200] });
    const big = vp();
    const twin = vp({ name: 'same size, later', gpts: GPTS.map((v) => v + 0.5) });
    const notGeo = vp({ geo: false, bbox: [0, 0, 612, 792] });
    const g = georefFromViewports([small, notGeo, big, twin])!;
    expect(g.points[0].lonLat).toEqual(BL);
  });

  it('flags an inset inside the main frame but not a duplicate of the main viewport or a locator beside it', () => {
    const main = vp();
    expect(georefFromViewports([main, vp(), vp()])!.warnings).toEqual([]);
    const beside = vp({ bbox: [400, 756, 576, 790] });
    expect(georefFromViewports([main, beside])!.warnings).toEqual([]);
    const inset = vp({ bbox: [400, 36, 576, 200] });
    expect(georefFromViewports([main, inset])!.warnings).toEqual(['inset_in_frame']);
  });
});

describe('buildGeoModel', () => {
  it('round-trips and samples a 64-point footprint starting at the top-left', () => {
    const g = georefFromViewports([vp()])!;
    const m = buildGeoModel(g);
    const fp = m.footprint();
    expect(fp).toHaveLength(64);
    expect(meters(fp[0], TL)).toBeLessThan(0.01);
    expect(meters(fp[16], TR)).toBeLessThan(0.01);
    expect(meters(fp[32], BR)).toBeLessThan(0.01);
    expect(meters(fp[48], BL)).toBeLessThan(0.01);
    expect(m.fitResidualM).toBeLessThan(0.01);
    const [px, py] = m.lonLatToPage(-116.3, 43.1);
    expect(meters(m.pageToLonLat(px, py), [-116.3, 43.1])).toBeLessThan(0.001);
    expect(m.metersPerPoint).toBeGreaterThan(30);
    expect(m.metersPerPoint).toBeLessThan(40);
    expect(g.warnings).toEqual([]);
  });

  it('warns poor_fit when a control point is ~100 m off, once', () => {
    // TL moved 0.001° (111 m) north.
    const g = georefFromViewports([vp({ gpts: GPTS.map((v, i) => (i === 2 ? v + 0.001 : v)) })])!;
    const m = buildGeoModel(g);
    expect(m.fitResidualM).toBeGreaterThan(5);
    buildGeoModel(g);
    expect(g.warnings).toEqual(['poor_fit']);
  });

  it('warns approximate_projection for an unsupported projection and still places the map', () => {
    const wkt = UTM11.replace('Transverse_Mercator', 'Polyconic');
    const g = georefFromViewports([vp({ wkt })])!;
    const m = buildGeoModel(g);
    expect(m.approximate).toBe(true);
    expect(g.warnings).toContain('approximate_projection');
    const [x, y] = m.lonLatToPage(TL[0], TL[1]);
    expect(Math.hypot(x - 36, y - 756) * m.metersPerPoint).toBeLessThan(5);
  });

  it('throws on collinear control points handed in directly', () => {
    const g = georefFromViewports([vp()])!;
    g.points = g.points.map((p, i) => ({ ...p, page: [i, i] as [number, number] }));
    expect(() => buildGeoModel(g)).toThrow();
  });
});

describe('plausibleLocation', () => {
  it('accepts a normal sheet', () => {
    expect(plausibleLocation(buildGeoModel(georefFromViewports([vp()])!))).toBe(true);
  });

  it('rejects null island, the poles and continent-sized fits', () => {
    const geog =
      'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
    const box = (s: number, w: number, n: number, e: number) =>
      buildGeoModel(georefFromViewports([vp({ wkt: geog, gpts: [s, w, n, w, n, e, s, e] })])!);
    expect(plausibleLocation(box(0.1, 0.1, 0.3, 0.3))).toBe(false);
    expect(plausibleLocation(box(86, 10, 87, 12))).toBe(false);
    // 180° × 90° and 10° × 65°: hemisphere-scale, not a map sheet.
    expect(plausibleLocation(box(-50, -170, 40, 10))).toBe(false);
    expect(plausibleLocation(box(-10, -100, 55, -90))).toBe(false);
    expect(plausibleLocation(box(40, -120, 41, -119))).toBe(true);
  });

  // Conic frames fan out in longitude: these exact fits span 55.6° (Alaska
  // statewide with the panhandle) and 63.9° × 29.3° (CONUS), and must not be
  // refused as "don't point to a real place". Corners: gdaltransform of each
  // frame from EPSG:3338 / EPSG:5070 to EPSG:4269.
  const albers = (name: string, lon0: number, sp1: number, sp2: number, lat0: number) =>
    `PROJCS["${name}",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Albers"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",${lon0}],PARAMETER["Standard_Parallel_1",${sp1}],PARAMETER["Standard_Parallel_2",${sp2}],PARAMETER["Latitude_Of_Origin",${lat0}],UNIT["Meter",1.0]]`;
  /** BL, TL, TR, BR as [lon, lat] → GPTS (lat, lon). */
  const gpts = (corners: LonLat[]) => corners.flatMap(([lon, lat]) => [lat, lon]);

  it('accepts a statewide Alaska Albers sheet', () => {
    // x −650…1550 km, y 400…2400 km.
    const m = buildGeoModel(
      georefFromViewports([
        vp({
          bbox: [36, 36, 756, 690],
          wkt: albers('NAD_1983_Alaska_Albers', -154, 55, 65, 50),
          gpts: gpts([
            [-163.731487643566, 53.1844122987377],
            [-171.536848900967, 70.811772860495],
            [-115.96798895367, 67.451149315548],
            [-131.525755884615, 51.2246527675051],
          ]),
        }),
      ])!,
    );
    expect(m.approximate).toBe(false);
    expect(m.fitResidualM).toBeLessThan(1);
    expect(plausibleLocation(m)).toBe(true);
  });

  it('accepts a CONUS Albers sheet', () => {
    // x −2400…2300 km, y 250…3200 km.
    const m = buildGeoModel(
      georefFromViewports([
        vp({
          bbox: [36, 36, 756, 488],
          wkt: albers('NAD_1983_Contiguous_USA_Albers', -96, 29.5, 45.5, 23),
          gpts: gpts([
            [-119.09865489394, 22.6029566232771],
            [-128.558678263554, 48.0602643562574],
            [-64.7000869481897, 48.3594850916255],
            [-73.8285369229992, 22.8203032065269],
          ]),
        }),
      ])!,
    );
    expect(m.approximate).toBe(false);
    expect(m.fitResidualM).toBeLessThan(1);
    expect(plausibleLocation(m)).toBe(true);
  });
});
