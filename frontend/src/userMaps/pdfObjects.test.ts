/**
 * pdfObjects: the hand-rolled /VP reader, first on small PDFs built here
 * (node:zlib makes the object streams), covering each layout seen in the
 * 69-file survey of FTP incident GeoPDFs: an inline /VP; a
 * page inside an object stream; Measure and GCS as references into an
 * object stream whose /Length is itself a reference; incremental updates;
 * escaped WKT strings.
 *
 * Then on the real GeoPDFs behind the GDAL fixtures: every viewport of every
 * fixture page must come back exactly as the Python survey reader saw it.
 * CI has no PDFs, so that half is skipped there:
 *
 *   USER_MAPS_FIXTURES=<…/georef/fixtures.json> npx vitest run src/userMaps/pdfObjects.test.ts
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PdfParseError, readPageViewports, sniffPdf, wktForEpsg } from './pdfObjects';
import { crsFromWkt } from './projection';
import type { RawViewport } from './types';

type Part = string | Uint8Array;

const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

function concat(parts: Part[]): Uint8Array {
  const bufs = parts.map((p) => (typeof p === 'string' ? latin1(p) : p));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of bufs) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

const TAIL = 'xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 99 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n';

/** Header + parts + tail. No real xref: the reader never needs one. */
const pdf = (parts: Part[], tail = TAIL): Uint8Array =>
  concat(['%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', ...parts, tail]);

const obj = (num: number, body: string): string => `${num} 0 obj\n${body}\nendobj\n`;

/**
 * A FlateDecode object stream holding `members`. /Length is direct, or a
 * reference to `lengthRef` (written right after). The data ends in CRLF
 * before "endstream": inflating past /Length throws "Trailing junk" in node.
 */
function objStm(num: number, members: [number, string][], opts: { lengthRef?: number; length?: number; junk?: string } = {}): Part[] {
  let body = '';
  const header: string[] = [];
  for (const [n, src] of members) {
    header.push(`${n} ${body.length}`);
    body += `${src}\n`;
  }
  const head = `${header.join(' ')}\n`;
  const z = new Uint8Array(deflateSync(latin1(head + body)));
  const len = opts.lengthRef !== undefined ? `${opts.lengthRef} 0 R` : String(opts.length ?? z.length);
  return [
    `${num} 0 obj\n<< /Type /ObjStm /N ${members.length} /First ${head.length} /Filter /FlateDecode /Length ${len} >>\nstream\r\n`,
    z,
    `${opts.junk ?? ''}\r\nendstream\nendobj\n`,
    ...(opts.lengthRef !== undefined ? [obj(opts.lengthRef, String(z.length))] : []),
  ];
}

const UTM11 =
  'PROJCS["NAD_1983_UTM_Zone_11N",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",' +
  'SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],' +
  'PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],' +
  'PARAMETER["Central_Meridian",-117.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
const GPTS = [41.75431, -117.80602, 43.16053, -117.82426, 43.15817, -115.89557, 41.75206, -115.92001];
const LPTS = [0, 0, 0, 1, 1, 1, 1, 0];
const BOUNDS = [0, 0, 0, 1, 1, 1, 1, 0, 0, 0];

const gcs = (wkt = UTM11): string => `<< /Type /PROJCS /WKT (${wkt}) >>`;
const measure = (g = gcs()): string =>
  `<< /Type /Measure /Subtype /GEO /Bounds [${BOUNDS.join(' ')}] /GPTS [${GPTS.join(' ')}] /LPTS [${LPTS.join(' ')}] /GCS ${g} >>`;
const viewport = (m = measure(), name = '(Layers)', bbox = '[140.7 127.3 5079.2 5045.7]'): string =>
  `<< /Type /Viewport /BBox ${bbox} /Name ${name} /Measure ${m} >>`;
const page = (extra: string): string =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 5184 5184] /Contents 4 0 R ${extra} >>`;

const CATALOG: Part[] = [
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>'),
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
];
const CONTENT: Part = '4 0 obj\n<< /Length 9 >>\nstream\nq 1 0 0 1\nendstream\nendobj\n';

const MAIN: RawViewport = {
  bbox: [140.7, 127.3, 5079.2, 5045.7],
  name: 'Layers',
  geo: true,
  gpts: GPTS,
  lpts: LPTS,
  bounds: BOUNDS,
  wkt: UTM11,
};

describe('readPageViewports', () => {
  it('reads an inline /VP with direct Measure and GCS, values exactly as written', async () => {
    const bytes = pdf([
      ...CATALOG,
      obj(3, page(`/VP [${viewport()} ${viewport(
        '<< /Subtype /RL /GPTS [1 2] >>',
        '(Scale bar)',
        '[.5 -0.346 +3 4.]',
      )} << /Type /Viewport /BBox [161.31 3418.8 4000 -.25] >>]`)),
      CONTENT,
    ]);
    expect(await readPageViewports(bytes, 3)).toEqual([
      MAIN,
      { bbox: [0.5, -0.346, 3, 4], name: 'Scale bar', geo: false, gpts: [1, 2], lpts: [], bounds: null, wkt: null },
      // inverted BBox kept as written (LPTS are applied to it in that order)
      { bbox: [161.31, 3418.8, 4000, -0.25], name: null, geo: false, gpts: [], lpts: [], bounds: null, wkt: null },
    ]);
  });

  it('tolerates "obj<<", % comments, CR-only line ends and junk where a key belongs', async () => {
    const bytes = pdf([
      ...CATALOG,
      '3 0 obj<</Type/Page% a comment with ) and >> in it\r/VP[<</BBox[0 0 1 1]/Measure',
      measure(),
      '>>]/Junk/Rotate 0 7 /Kids[]>>endobj\r',
    ]);
    expect(await readPageViewports(bytes, 3)).toEqual([{ ...MAIN, bbox: [0, 0, 1, 1], name: null }]);
  });

  it('finds a page object that lives inside an object stream', async () => {
    const bytes = pdf([
      ...CATALOG,
      ...objStm(10, [
        [5, '<< /Foo [1 2 3] >>'],
        [3, page(`/VP [${viewport()}]`)],
      ]),
      CONTENT,
    ]);
    expect(await readPageViewports(bytes, 3)).toEqual([MAIN]);
  });

  it('follows indirect /VP, viewport and BBox entries, and Measure + GCS inside an object stream with an indirect /Length', async () => {
    // three-queens__LARGE (ArcMap 10.5.1 + Adobe PDF Library 15): /Measure n 0 R → ObjStm → /GCS n 0 R → same ObjStm
    const bytes = pdf([
      ...CATALOG,
      obj(3, page('/VP 6 0 R')),
      CONTENT,
      obj(6, '[7 0 R]'),
      obj(7, '<< /Type /Viewport /BBox [140.7 127.3 5079.2 8 0 R] /Name (Layers) /Measure 11 0 R >>'),
      obj(8, '5045.7'),
      ...objStm(20, [
        [11, measure('12 0 R')],
        [12, gcs()],
      ], { lengthRef: 21 }),
    ]);
    expect(await readPageViewports(bytes, 3)).toEqual([MAIN]);
  });

  it('reads exactly /Length bytes: junk between the data and endstream is ignored', async () => {
    const bytes = pdf([...CATALOG, ...objStm(10, [[3, page(`/VP [${viewport()}]`)]], { junk: 'XYZ' })]);
    expect(await readPageViewports(bytes, 3)).toEqual([MAIN]);
  });

  it('falls back to cutting at endstream when /Length is wrong', async () => {
    const bytes = pdf([...CATALOG, ...objStm(10, [[3, page(`/VP [${viewport()}]`)]], { length: 7 })]);
    expect(await readPageViewports(bytes, 3)).toEqual([MAIN]);
  });

  it('takes the last definition of an object (incremental update), top-level or in object streams', async () => {
    const bytes = pdf([
      ...CATALOG,
      obj(3, page(`/VP [${viewport(measure(), '(Old)')}]`)),
      CONTENT,
      ...objStm(20, [[11, measure(gcs('GEOGCS["Old"]'))]]),
      TAIL,
      // the update: page 3 again, and Measure 11 again in a newer object stream
      obj(3, page(`/VP [${viewport('11 0 R', '(New)')}]`)),
      ...objStm(22, [[11, measure(gcs('GEOGCS["New"]'))]]),
    ]);
    expect(await readPageViewports(bytes, 3)).toEqual([{ ...MAIN, name: 'New', wkt: 'GEOGCS["New"]' }]);
  });

  it('decodes literal strings (escaped and nested parens, octal, \\n, line continuations), hex text and #xx names', async () => {
    const wkt =
      'GEOGCS["GCS_WGS_1984_\\(ITRF00\\)",DATUM["D_(nested (twice))"],X["\\101\\60\\0607"],Y["a\\nb"],Z["line\\\ncontinued"],W["\\\\"]';
    const bytes = pdf([
      ...CATALOG,
      obj(3, page(
        // name: UTF-16BE "Map Layers" as a hex string; /Mea#73ure is /Measure, /G#45O is /GEO
        `/VP [<< /BBox [0 0 1 1] /Name <FEFF004D 006100700020004C00610079006500720073> /Mea#73ure << /Subtype /G#45O /GPTS [${GPTS.join(' ')}] /LPTS [${LPTS.join(' ')}] /GCS << /WKT (${wkt}) >> >> >>]`,
      )),
    ]);
    const [vp] = await readPageViewports(bytes, 3);
    expect(vp.name).toBe('Map Layers');
    expect(vp.geo).toBe(true);
    expect(vp.wkt).toBe('GEOGCS["GCS_WGS_1984_(ITRF00)",DATUM["D_(nested (twice))"],X["A007"],Y["a\nb"],Z["linecontinued"],W["\\"]');
  });

  it('reads a /GCS with /EPSG and no /WKT as that CRS, not the approximate fallback', async () => {
    const bytes = pdf([
      ...CATALOG,
      obj(3, page(`/VP [${viewport(measure('<< /Type /PROJCS /EPSG 12 0 R >>'))} ${viewport(
        measure('<< /Type /GEOGCS /EPSG 4326 >>'),
      )} ${viewport(measure(`<< /Type /PROJCS /EPSG 4326 /WKT (${UTM11}) >>`))}]`)),
      obj(12, '26911'),
    ]);
    const [utm, geog, both] = await readPageViewports(bytes, 3);
    const strip = ({ name: _n, ...c }: ReturnType<typeof crsFromWkt>) => c;
    // Same projection as the WKT GDAL would have written (indirect /EPSG followed).
    expect(strip(crsFromWkt(utm.wkt, [-117, 42]))).toEqual(strip(crsFromWkt(UTM11, [-117, 42])));
    expect(crsFromWkt(geog.wkt, [-117, 42])).toMatchObject({ kind: 'geographic', approximate: false, datum: 'wgs84' });
    // A /WKT always wins over /EPSG.
    expect(both.wkt).toBe(UTM11);
  });

  it('maps the EPSG codes incident maps use to their exact CRS, and nothing else', () => {
    const crs = (code: unknown, type: unknown = 'PROJCS') => {
      const wkt = wktForEpsg(code, type);
      return wkt === null ? null : crsFromWkt(wkt, [0, 45]);
    };
    expect(crs(4326, 'GEOGCS')).toMatchObject({ kind: 'geographic', datum: 'wgs84', a: 6378137 });
    expect(crs(4269, 'GEOGCS')).toMatchObject({ kind: 'geographic', datum: 'wgs84', f: 1 / 298.257222101 });
    expect(crs(4267, 'GEOGCS')).toMatchObject({ kind: 'geographic', datum: 'nad27', a: 6378206.4 });
    expect(crs(32611)).toMatchObject({ kind: 'tm', datum: 'wgs84', lon0: -117, k0: 0.9996, fe: 500000, fn: 0 });
    expect(crs(32711)).toMatchObject({ kind: 'tm', lon0: -117, fn: 10000000 });
    expect(crs(32601)).toMatchObject({ kind: 'tm', lon0: -177 });
    expect(crs(32660)).toMatchObject({ kind: 'tm', lon0: 177 });
    expect(crs(26905)).toMatchObject({ kind: 'tm', datum: 'wgs84', lon0: -153, f: 1 / 298.257222101 });
    expect(crs(26710)).toMatchObject({ kind: 'tm', datum: 'nad27', lon0: -123 });
    expect(crs(3857)).toMatchObject({ kind: 'webmercator', approximate: false });
    expect(crs(102100)).toMatchObject({ kind: 'webmercator', approximate: false });
    expect(crs(5070)).toMatchObject({ kind: 'albers', lon0: -96, lat0: 23, lat1: 29.5, lat2: 45.5, fn: 0 });
    expect(crs(3338)).toMatchObject({ kind: 'albers', lon0: -154, lat0: 50, lat1: 55, lat2: 65 });
    expect(crs(3310)).toMatchObject({ kind: 'albers', lon0: -120, lat0: 0, lat1: 34, lat2: 40.5, fn: -4000000 });
    // Not UTM despite the prefix (NAD83 / NAD27 State Plane), no zone 0 or 61,
    // an unlisted code, a non-integer and a missing code: no WKT — unless the
    // /Type says the frame is plain lon/lat.
    for (const code of [26929, 26729, 32600, 32661, 2229, 4326.5, null]) expect(wktForEpsg(code, 'PROJCS')).toBeNull();
    expect(crs(4152, 'GEOGCS')).toMatchObject({ kind: 'geographic', approximate: false });
    expect(crs(null, 'GEOGCS')).toMatchObject({ kind: 'geographic', approximate: false });
  });

  it('gives [] for a page without /VP', async () => {
    const bytes = pdf([...CATALOG, obj(3, page('')), CONTENT]);
    expect(await readPageViewports(bytes, 3)).toEqual([]);
  });

  it('reads a dangling Measure reference as no Measure (ISO 32000 §7.3.10)', async () => {
    const bytes = pdf([...CATALOG, obj(3, page(`/VP [${viewport('99 0 R')}]`))]);
    expect(await readPageViewports(bytes, 3)).toEqual([
      { ...MAIN, geo: false, gpts: [], lpts: [], bounds: null, wkt: null },
    ]);
  });

  it('throws PdfParseError for a missing page, a non-dictionary page and non-PDF bytes', async () => {
    const bytes = pdf([...CATALOG, obj(3, '[1 2 3]')]);
    await expect(readPageViewports(bytes, 42)).rejects.toBeInstanceOf(PdfParseError);
    await expect(readPageViewports(bytes, 3)).rejects.toThrow(/not a page dictionary/);
    await expect(readPageViewports(latin1('\x89PNG\r\n\x1a\n not a pdf'), 3)).rejects.toBeInstanceOf(PdfParseError);
    await expect(readPageViewports(pdf([obj(3, '<< /VP [<< /BBox [0 0 1 1] /Name (oops >> ] >>')]), 3)).rejects.toThrow(
      /unterminated/,
    );
  });

  it('fails (rather than "no georef") when an unreadable object stream may hold the object', async () => {
    const garbage = latin1('this is not deflate data at all');
    const bytes = pdf([
      ...CATALOG,
      obj(3, page(`/VP [${viewport('11 0 R')}]`)),
      `20 0 obj\n<< /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode /Length ${garbage.length} >>\nstream\n`,
      garbage,
      '\nendstream\nendobj\n',
    ]);
    await expect(readPageViewports(bytes, 3)).rejects.toThrow(/object stream could not be read/);
    await expect(readPageViewports(bytes, 5)).rejects.toThrow(/page object 5 not found \(an object stream/);
  });
});

describe('sniffPdf', () => {
  const plain = pdf([...CATALOG, obj(3, page(`/VP [${viewport()}]`))]);

  it('reads a plain PDF as unencrypted, without LGIDict', () => {
    expect(sniffPdf(plain)).toEqual({ isPdf: true, encrypted: false, lgidict: false });
  });

  it('finds /Encrypt in a trailer and in a cross-reference stream dictionary', () => {
    const trailer = pdf([...CATALOG], 'trailer\n<< /Size 9 /Root 1 0 R /Encrypt 8 0 R /ID [<00><00>] >>\nstartxref\n0\n%%EOF\n');
    expect(sniffPdf(trailer).encrypted).toBe(true);
    const xrefStm = pdf(
      [...CATALOG, '30 0 obj\n<< /Type /XRef /Size 31 /W [1 2 1] /Root 1 0 R /Encrypt 8 0 R /Length 0 >>\nstream\n\nendstream\nendobj\n'],
      'startxref\n0\n%%EOF\n',
    );
    expect(sniffPdf(xrefStm).encrypted).toBe(true);
  });

  it('ignores /Encrypt outside trailers and /EncryptMetadata', () => {
    const bytes = pdf([
      ...CATALOG,
      obj(3, page('/Note (see /Encrypt) /PieceInfo << /Encrypt 5 >>')),
      obj(8, '<< /Filter /Standard /V 4 /EncryptMetadata false >>'),
    ]);
    expect(sniffPdf(bytes).encrypted).toBe(false);
  });

  it('flags LGIDict (OGC / TerraGo georeferencing)', () => {
    const bytes = pdf([...CATALOG, obj(3, page('/LGIDict 9 0 R'))]);
    expect(sniffPdf(bytes)).toEqual({ isPdf: true, encrypted: false, lgidict: true });
  });

  it('accepts %PDF- within the first 1024 bytes only', () => {
    expect(sniffPdf(concat([' '.repeat(1019), plain])).isPdf).toBe(true);
    expect(sniffPdf(concat([' '.repeat(1024), plain])).isPdf).toBe(false);
    expect(sniffPdf(latin1('\x89PNG\r\n\x1a\n LGIDict /Encrypt'))).toEqual({ isPdf: false, encrypted: false, lgidict: false });
    expect(sniffPdf(new Uint8Array(0)).isPdf).toBe(false);
  });
});

// ---------- real GeoPDFs vs the survey's fixtures ----------

// The survey's fixtures name local PDFs (not in the repo), so these run only
// when USER_MAPS_FIXTURES points at that fixtures.json; CI skips them.
const FIXTURES = process.env.USER_MAPS_FIXTURES ?? '';

interface FixtureViewport {
  bbox: number[];
  gpts: number[];
  lpts: number[];
  bounds: number[] | null;
  name: string | null;
  wktName: string;
  gcsType: string;
  datum: string | null;
}
interface FixturePage {
  file: string;
  page: number;
  pageObjNum?: number;
  viewports?: FixtureViewport[];
}

const PAGES: FixturePage[] = existsSync(FIXTURES)
  ? (JSON.parse(readFileSync(FIXTURES, 'utf8')) as FixturePage[]).filter(
      (p) => p.pageObjNum !== undefined && p.viewports && existsSync(p.file),
    )
  : [];

/** A fresh, unshared Uint8Array of the file (a new WeakMap key, so it is indexed from scratch). */
function fileBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** 'PROJCS["NAD_1983_UTM_Zone_11N"' — the WKT's type and name. */
const wktHead = (wkt: string | null): string | null => {
  const m = wkt && /^(\w+)\["([^"]*)"/.exec(wkt);
  return m ? `${m[1]}["${m[2]}"` : null;
};

describe.skipIf(PAGES.length === 0)('readPageViewports on the fixture GeoPDFs', () => {
  it.each(PAGES.map((p) => [`${basename(p.file)} p${p.page}`, p] as const))('%s', async (_, p) => {
    const got = await readPageViewports(fileBytes(p.file), p.pageObjNum!);
    expect(got.map((v) => ({ ...v, wkt: wktHead(v.wkt) }))).toEqual(
      p.viewports!.map((f) => ({
        bbox: f.bbox,
        name: f.name,
        geo: true,
        gpts: f.gpts,
        lpts: f.lpts,
        bounds: f.bounds,
        wkt: `${f.gcsType}["${f.wktName}"`,
      })),
    );
    for (const [i, f] of p.viewports!.entries()) {
      if (f.datum) expect(got[i].wkt).toContain(`DATUM["${f.datum}"`);
    }
  });

  it('indexes and reads the largest file quickly', async () => {
    const p = PAGES.reduce((a, c) => (statSync(c.file).size > statSync(a.file).size ? c : a));
    const bytes = fileBytes(p.file);
    const t0 = performance.now();
    const vps = await readPageViewports(bytes, p.pageObjNum!);
    const ms = performance.now() - t0;
    console.log(
      `pdfObjects: ${basename(p.file)} (${(bytes.length / 1e6).toFixed(1)} MB, ${vps.length} viewports): ` +
        `index + /VP read ${ms.toFixed(1)} ms`,
    );
    expect(vps.length).toBe(p.viewports!.length);
    expect(ms).toBeLessThan(1000); // a sanity bound for slow machines, not the benchmark (~25 ms here)
  });
});
