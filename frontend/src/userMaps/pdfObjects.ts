/**
 * Hand-rolled PDF object reader for My maps: reads a page's /VP viewports
 * (BBox, and the /Measure /GEO GPTS, LPTS and Bounds, plus /GCS /WKT, or a
 * WKT for its /EPSG when it has none) straight from the file bytes. It also
 * sniffs a file before anything heavier runs.
 *
 * Why not pdf.js: its public API never hands out a page dictionary, and it
 * is a lazy 0.7 MB chunk. This module is pure and runs (and is tested) in
 * node. Why no xref chain: on all 69 sampled GeoPDFs a raw "N G obj" scan
 * plus object streams finds every page and georef object, with no xref or
 * PNG-predictor parsing:
 * - Top-level objects: one byte pass per buffer, cached in a WeakMap. The
 *   LAST "N G obj" wins, so an incremental update reads its new version.
 * - Anything else lives in /Type /ObjStm streams. They are inflated lazily
 *   with DecompressionStream('deflate') on EXACTLY /Length bytes, resolving
 *   an indirect /Length (1096/1202 sampled streams use one). A trailing EOL
 *   makes the inflate throw "Trailing junk", and 8/1202 payloads end in CR
 *   or LF, so cutting at "endstream" is only a fallback.
 * - /VP, each viewport, /Measure and /GCS may be direct or indirect.
 *   three-queens keeps Measure and GCS inside an object stream, and two
 *   ArcGIS Pro 3.5.6 files keep the page object itself in one.
 * Only small slices are ever turned into strings; the file is never decoded
 * as a whole.
 */
import type { Box, PdfSniff, RawViewport } from './types';

/** The file's structure can't be read: object missing, bad syntax, or an unreadable object stream. */
export class PdfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfParseError';
  }
}

// ---------- bytes ----------

const REGULAR = 0;
const SPACE = 1;
const DELIM = 2;
/** PDF character classes (ISO 32000 §7.2.2): whitespace, delimiters, the rest regular. */
const CLS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) CLS[c] = SPACE;
for (const c of '()<>[]{}/%') CLS[c.charCodeAt(0)] = DELIM;

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const PDF_MAGIC = ascii('%PDF-');
const ENCRYPT = ascii('/Encrypt');
const LGIDICT = ascii('LGIDict');
const OBJSTM = ascii('/ObjStm');
const TRAILER = ascii('trailer');
const STREAM = ascii('stream');
const ENDSTREAM = ascii('endstream');
/** How far back from an /Encrypt key to look for its "trailer" keyword. */
const TRAILER_WINDOW = 1 << 16;

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** Bytes [s, e) as a latin1 string — only ever called on small slices. */
function latin1(b: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i < e; i += 8192) out += String.fromCharCode(...b.subarray(i, Math.min(e, i + 8192)));
  return out;
}

/** True when `pat` sits at `at` and is followed by a non-regular byte (or the end). */
function wordAt(b: Uint8Array, at: number, pat: Uint8Array): boolean {
  if (at < 0 || at + pat.length > b.length) return false;
  for (let k = 0; k < pat.length; k++) if (b[at + k] !== pat[k]) return false;
  return at + pat.length === b.length || CLS[b[at + pat.length]] !== REGULAR;
}

/** First index ≥ from where `pat` occurs, or -1 (native indexOf finds the candidates). */
function indexOfSeq(b: Uint8Array, pat: Uint8Array, from: number): number {
  const last = b.length - pat.length;
  for (let i = b.indexOf(pat[0], from); i >= 0 && i <= last; i = b.indexOf(pat[0], i + 1)) {
    let k = 1;
    while (k < pat.length && b[i + k] === pat[k]) k++;
    if (k === pat.length) return i;
  }
  return -1;
}

/** Last index in [min, before) where `pat` starts, or -1. */
function lastIndexOfSeq(b: Uint8Array, pat: Uint8Array, before: number, min: number): number {
  let from = Math.min(before, b.length) - pat.length;
  while (from >= min) {
    const i = b.lastIndexOf(pat[0], from);
    if (i < min) return -1;
    let k = 1;
    while (k < pat.length && b[i + k] === pat[k]) k++;
    if (k === pat.length) return i;
    from = i - 1;
  }
  return -1;
}

// ---------- values + tokenizer ----------

/** A literal or hex string, kept as bytes until it is used as text. */
class PdfString {
  constructor(readonly bytes: Uint8Array) {}
}

/** An indirect reference "num gen R". */
class PdfRef {
  constructor(readonly num: number, readonly gen: number) {}
}

/** A bare keyword (endobj, stream, an operator, a stray delimiter) — never a value. */
class Keyword {
  constructor(readonly word: string) {}
}

type PdfDict = Map<string, PdfValue>;
/** Names are plain strings (no slash); strings, refs, arrays and dicts have their own types. */
type PdfValue = number | boolean | null | string | PdfString | PdfRef | PdfValue[] | PdfDict;

/** '.5', '-0.346', '+3', '4.'; an exponent isn't PDF syntax, but accepting one costs nothing. */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const UINT = /^\d+$/;
/** Deeper nesting than this is a malformed (or hostile) file, not a map. */
const MAX_DEPTH = 64;

/** Recursive-descent parser over a byte range; `pos` moves as values are read. */
class Parser {
  constructor(
    readonly b: Uint8Array,
    public pos: number,
    readonly end: number = b.length,
  ) {}

  /** Skips whitespace and % comments. */
  skipSpace(): void {
    const { b, end } = this;
    let p = this.pos;
    while (p < end) {
      const c = b[p];
      if (CLS[c] === SPACE) p++;
      else if (c === 0x25) {
        while (p < end && b[p] !== 0x0a && b[p] !== 0x0d) p++;
      } else break;
    }
    this.pos = p;
  }

  /** A run of regular bytes (a number or keyword); '' at a delimiter. */
  regular(): string {
    const { b, end } = this;
    const s = this.pos;
    let p = s;
    while (p < end && CLS[b[p]] === REGULAR) p++;
    this.pos = p;
    return latin1(b, s, p);
  }

  /** The next value; a bare keyword comes back as a Keyword. */
  value(depth = 0): PdfValue | Keyword {
    if (depth > MAX_DEPTH) throw new PdfParseError('objects nested too deeply');
    this.skipSpace();
    if (this.pos >= this.end) throw new PdfParseError('unexpected end of data');
    const { b } = this;
    const c = b[this.pos];
    if (c === 0x2f) return this.name();
    if (c === 0x28) return this.literal();
    if (c === 0x5b) return this.array(depth);
    if (c === 0x3c) return b[this.pos + 1] === 0x3c ? this.dict(depth) : this.hex();
    if (CLS[c] === DELIM) {
      this.pos++;
      return new Keyword(String.fromCharCode(c));
    }
    const tok = this.regular();
    if (NUMBER.test(tok)) return UINT.test(tok) ? this.refOr(Number(tok)) : Number(tok);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return new Keyword(tok);
  }

  /** After an unsigned integer: "gen R" makes it a reference, else it stays a number. */
  private refOr(num: number): number | PdfRef {
    const save = this.pos;
    this.skipSpace();
    const gen = this.regular();
    if (UINT.test(gen)) {
      this.skipSpace();
      const p = this.pos;
      if (this.b[p] === 0x52 && (p + 1 >= this.end || CLS[this.b[p + 1]] !== REGULAR)) {
        this.pos = p + 1;
        return new PdfRef(num, Number(gen));
      }
    }
    this.pos = save;
    return num;
  }

  /** /Name with #xx escapes, as a latin1 string without the slash. */
  private name(): string {
    const { b, end } = this;
    let p = this.pos + 1;
    let out = '';
    while (p < end && CLS[b[p]] === REGULAR) {
      let c = b[p++];
      if (c === 0x23 && p + 1 < end) {
        const hi = hexVal(b[p]);
        const lo = hexVal(b[p + 1]);
        if (hi >= 0 && lo >= 0) {
          c = hi * 16 + lo;
          p += 2;
        }
      }
      out += String.fromCharCode(c);
    }
    this.pos = p;
    return out;
  }

  /** (literal) with escapes, \ddd octal, line continuations and balanced nested parens. */
  private literal(): PdfString {
    const { b, end } = this;
    let p = this.pos + 1;
    let depth = 1;
    const out: number[] = [];
    for (;;) {
      if (p >= end) throw new PdfParseError('unterminated string');
      const c = b[p++];
      if (c === 0x5c) {
        if (p >= end) throw new PdfParseError('unterminated string');
        const e = b[p++];
        if (e === 0x6e) out.push(0x0a);
        else if (e === 0x72) out.push(0x0d);
        else if (e === 0x74) out.push(0x09);
        else if (e === 0x62) out.push(0x08);
        else if (e === 0x66) out.push(0x0c);
        else if (e === 0x0d) {
          if (b[p] === 0x0a) p++; // backslash + EOL: the string continues on the next line
        } else if (e === 0x0a) {
          // continuation
        } else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2 && p < end && b[p] >= 0x30 && b[p] <= 0x37; k++) v = v * 8 + (b[p++] - 0x30);
          out.push(v & 0xff);
        } else out.push(e); // \( \) \\ and unknown escapes: the byte itself
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else if (c === 0x0d) {
        out.push(0x0a); // an unescaped EOL (CR, LF or CRLF) reads as LF
        if (b[p] === 0x0a) p++;
      } else out.push(c);
    }
    this.pos = p;
    return new PdfString(Uint8Array.from(out));
  }

  /** <hex string>; whitespace ignored, an odd final digit padded with 0. */
  private hex(): PdfString {
    const { b, end } = this;
    let p = this.pos + 1;
    const out: number[] = [];
    let hi = -1;
    for (;;) {
      if (p >= end) throw new PdfParseError('unterminated hex string');
      const c = b[p++];
      if (c === 0x3e) break;
      const v = hexVal(c);
      if (v < 0) continue; // whitespace (or junk, which pdf.js also skips)
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    this.pos = p;
    return new PdfString(Uint8Array.from(out));
  }

  private array(depth: number): PdfValue[] {
    this.pos++;
    const out: PdfValue[] = [];
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.end) throw new PdfParseError('unterminated array');
      if (this.b[this.pos] === 0x5d) {
        this.pos++;
        return out;
      }
      const v = this.value(depth + 1);
      out.push(v instanceof Keyword ? null : v);
    }
  }

  private dict(depth: number): PdfDict {
    this.pos += 2;
    const out: PdfDict = new Map();
    const { b } = this;
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.end) throw new PdfParseError('unterminated dictionary');
      if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return out;
      }
      const key = this.value(depth + 1);
      if (typeof key !== 'string') continue; // junk where a key belongs: skip it
      this.skipSpace();
      if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) continue; // key with no value
      const v = this.value(depth + 1);
      out.set(key, v instanceof Keyword ? null : v);
    }
  }
}

/** A text string (ISO 32000 §7.9.2.2): UTF-16BE or UTF-8 with a BOM, else PDFDocEncoding ≈ latin1. */
function pdfText(s: PdfString): string {
  const b = s.bytes;
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < b.length; i += 2) out += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return out;
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return new TextDecoder().decode(b.subarray(3));
  }
  return latin1(b, 0, b.length);
}

// ---------- object index ----------

interface ObjStmRef {
  /** Position just past the stream object's "obj". */
  start: number;
  dict: PdfDict;
  dataStart: number;
}

interface ObjStmData {
  data: Uint8Array;
  first: number;
  /** Object number → offset from /First (last entry wins within one stream). */
  offsets: Map<number, number>;
}

interface PdfIndex {
  /** The indexed bytes (the WeakMap key; a value pointing at its key doesn't keep it alive). */
  b: Uint8Array;
  /** b.length when indexed — a detached buffer reads as 0 and gets re-indexed. */
  length: number;
  /** Object number → position just past its LAST top-level "N G obj". */
  top: Map<number, number>;
  /** Every header's position just past "obj", ascending: which object holds byte p. */
  starts: number[];
  /** Parsed objects by number (a stream object is cached as its dict). */
  values: Map<number, PdfValue>;
  /** /Type /ObjStm stream objects in file order, found on first need. */
  objStms: ObjStmRef[] | null;
  /** Inflated + header-parsed object streams by start (null = unreadable). */
  stmData: Map<number, Promise<ObjStmData | null>>;
  /** Some object stream couldn't be inflated, so a missing object is a parse failure. */
  stmFailed: boolean;
}

const indexes = new WeakMap<Uint8Array, PdfIndex>();

function indexFor(b: Uint8Array): PdfIndex {
  let ix = indexes.get(b);
  if (!ix || ix.length !== b.length) {
    ix = scanObjects(b);
    indexes.set(b, ix);
  }
  return ix;
}

/**
 * One pass over the bytes for every "N G obj" header ("obj" found forwards,
 * the numbers checked backwards): 27 MB in ~15 ms in node. Later headers
 * overwrite earlier ones — an incremental update appends its new version.
 */
function scanObjects(b: Uint8Array): PdfIndex {
  const top = new Map<number, number>();
  const starts: number[] = [];
  const n = b.length;
  for (let j = 2; j < n; j++) {
    if (b[j] !== 0x6a || b[j - 1] !== 0x62 || b[j - 2] !== 0x6f) continue;
    if (j + 1 < n && CLS[b[j + 1]] === REGULAR) continue;
    const num = headerNum(b, j - 3);
    if (num < 0) continue;
    top.set(num, j + 1);
    starts.push(j + 1);
  }
  return { b, length: n, top, starts, values: new Map(), objStms: null, stmData: new Map(), stmFailed: false };
}

/** Object number of the "num gen obj" header whose "obj" begins at p + 1, or -1. */
function headerNum(b: Uint8Array, p: number): number {
  if (p < 0 || CLS[b[p]] !== SPACE) return -1;
  while (p >= 0 && CLS[b[p]] === SPACE) p--;
  const genEnd = p;
  while (p >= 0 && isDigit(b[p])) p--;
  if (p === genEnd || genEnd - p > 5 || p < 0 || CLS[b[p]] !== SPACE) return -1;
  while (p >= 0 && CLS[b[p]] === SPACE) p--;
  const numEnd = p;
  while (p >= 0 && isDigit(b[p])) p--;
  if (p === numEnd || numEnd - p > 10 || (p >= 0 && CLS[b[p]] === REGULAR)) return -1;
  let num = 0;
  for (let k = p + 1; k <= numEnd; k++) num = num * 10 + (b[k] - 0x30);
  return num;
}

/** Start of the last object header at or before byte h, or -1. */
function containing(starts: number[], h: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= h) {
      best = starts[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** The top-level object right after "obj" at `start`; for a stream, where its data begins. */
function readTop(b: Uint8Array, start: number): { value: PdfValue; dataStart: number | null } {
  const p = new Parser(b, start);
  const v = p.value();
  if (v instanceof Keyword) return { value: null, dataStart: null }; // "N 0 obj endobj"
  let dataStart: number | null = null;
  if (v instanceof Map) {
    p.skipSpace();
    if (wordAt(b, p.pos, STREAM)) {
      let d = p.pos + STREAM.length;
      if (b[d] === 0x0d) d++; // CRLF (a lone CR is tolerated)
      if (b[d] === 0x0a) d++;
      dataStart = d;
    }
  }
  return { value: v, dataStart };
}

/** Follows references through top-level objects only (stream /Length, /N, /First, /Filter). */
function topValue(ix: PdfIndex, v: PdfValue | undefined): PdfValue | undefined {
  for (let hops = 0; v instanceof PdfRef; hops++) {
    const at = ix.top.get(v.num);
    if (at === undefined || hops > 32) return undefined;
    v = readTop(ix.b, at).value;
  }
  return v;
}

const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Every /Type /ObjStm stream object, in file order (found by a byte search for "/ObjStm"). */
function objStms(ix: PdfIndex): ObjStmRef[] {
  if (ix.objStms) return ix.objStms;
  const { b } = ix;
  const found: ObjStmRef[] = [];
  const seen = new Set<number>();
  for (let h = indexOfSeq(b, OBJSTM, 0); h >= 0; h = indexOfSeq(b, OBJSTM, h + OBJSTM.length)) {
    if (!wordAt(b, h, OBJSTM)) continue;
    const start = containing(ix.starts, h);
    if (start < 0 || seen.has(start)) continue;
    seen.add(start);
    try {
      const { value, dataStart } = readTop(b, start);
      if (dataStart !== null && value instanceof Map && value.get('Type') === 'ObjStm') {
        found.push({ start, dict: value, dataStart });
      }
    } catch {
      // "/ObjStm" bytes inside something else (or a broken object): not a stream we can use
    }
  }
  ix.objStms = found;
  return found;
}

function loadObjStm(ix: PdfIndex, s: ObjStmRef): Promise<ObjStmData | null> {
  let p = ix.stmData.get(s.start);
  if (!p) {
    p = decodeObjStm(ix, s)
      .catch(() => null)
      .then((d) => {
        if (!d) ix.stmFailed = true;
        return d;
      });
    ix.stmData.set(s.start, p);
  }
  return p;
}

async function decodeObjStm(ix: PdfIndex, s: ObjStmRef): Promise<ObjStmData | null> {
  const n = topValue(ix, s.dict.get('N'));
  const first = topValue(ix, s.dict.get('First'));
  if (!isUint(n) || !isUint(first)) return null;
  const data = await streamData(ix, s);
  if (!data || first > data.length) return null;
  const offsets = new Map<number, number>();
  const hp = new Parser(data, 0, first);
  for (let i = 0; i < n; i++) {
    const num = hp.value();
    const off = hp.value();
    if (!isUint(num) || !isUint(off)) return null;
    offsets.set(num, off);
  }
  return { data, first, offsets };
}

/**
 * The decoded payload of an object stream: exactly /Length bytes after the
 * "stream" EOL, inflated. Only when that fails (missing or wrong /Length) is
 * the data cut at "endstream" minus one EOL and tried again.
 */
async function streamData(ix: PdfIndex, s: ObjStmRef): Promise<Uint8Array | null> {
  const { b } = ix;
  const filter = topValue(ix, s.dict.get('Filter'));
  const filters = filter == null ? [] : Array.isArray(filter) ? filter : [filter];
  const flate = filters.length === 1 && (filters[0] === 'FlateDecode' || filters[0] === 'Fl');
  if (filters.length && !flate) return null;
  const parms = topValue(ix, s.dict.get('DecodeParms'));
  const pm = Array.isArray(parms) ? parms[0] : parms;
  if (pm instanceof Map) {
    const predictor = topValue(ix, pm.get('Predictor'));
    if (typeof predictor === 'number' && predictor > 1) return null; // never seen on an ObjStm
  }
  const decode = async (raw: Uint8Array): Promise<Uint8Array | null> => {
    if (!flate) return raw;
    try {
      return await inflate(raw);
    } catch {
      return null;
    }
  };
  const len = topValue(ix, s.dict.get('Length'));
  let tried = -1;
  if (isUint(len) && s.dataStart + len <= b.length) {
    const out = await decode(b.subarray(s.dataStart, s.dataStart + len));
    if (out) return out;
    tried = len;
  }
  const es = indexOfSeq(b, ENDSTREAM, s.dataStart);
  if (es < 0) return null;
  let e = es;
  if (e > s.dataStart && b[e - 1] === 0x0a) e--;
  if (e > s.dataStart && b[e - 1] === 0x0d) e--;
  return e - s.dataStart === tried ? null : decode(b.subarray(s.dataStart, e));
}

/** zlib inflate with the platform's DecompressionStream (no dependency). */
async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  // TS types a write as BufferSource (ArrayBuffer-backed); the file bytes always are
  writer.write(raw as Uint8Array<ArrayBuffer>).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Object `num` from the object streams, latest stream first; undefined when none has it. */
async function fromObjStms(ix: PdfIndex, num: number): Promise<PdfValue | undefined> {
  const stms = objStms(ix);
  for (let i = stms.length - 1; i >= 0; i--) {
    const d = await loadObjStm(ix, stms[i]);
    const off = d?.offsets.get(num);
    if (!d || off === undefined) continue;
    const v = new Parser(d.data, d.first + off).value();
    return v instanceof Keyword ? null : v;
  }
  return undefined;
}

/** Object `num`: the last top-level definition, else the object streams. undefined = absent. */
async function lookup(ix: PdfIndex, num: number): Promise<PdfValue | undefined> {
  if (ix.values.has(num)) return ix.values.get(num);
  const at = ix.top.get(num);
  const v = at !== undefined ? readTop(ix.b, at).value : await fromObjStms(ix, num);
  if (v !== undefined) ix.values.set(num, v);
  return v;
}

/**
 * Follows references. A reference to an absent object is null (ISO 32000
 * §7.3.10) — unless an object stream couldn't be read, when the object may
 * well be in it and the honest answer is a parse failure.
 */
async function resolve(ix: PdfIndex, v: PdfValue | undefined): Promise<PdfValue> {
  for (let hops = 0; v instanceof PdfRef; hops++) {
    if (hops > 32) throw new PdfParseError('reference loop');
    const num: number = v.num;
    v = await lookup(ix, num);
    if (v === undefined) {
      if (ix.stmFailed) throw new PdfParseError(`object ${num} not found (an object stream could not be read)`);
      return null;
    }
  }
  return v ?? null;
}

/** An array of numbers (each possibly indirect), or null when it isn't one. */
async function numbers(ix: PdfIndex, v: PdfValue | undefined): Promise<number[] | null> {
  const arr = await resolve(ix, v);
  if (!Array.isArray(arr)) return null;
  const out: number[] = [];
  for (const x of arr) {
    const n = x instanceof PdfRef ? await resolve(ix, x) : x;
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

function textOf(v: PdfValue): string | null {
  if (v instanceof PdfString) return pdfText(v);
  return typeof v === 'string' ? v : null;
}

// ---------- /GCS /EPSG ----------

// ISO 32000 lets a /GCS give /EPSG instead of /WKT, and GDAL honours either
// (pdfdataset.cpp). Without a WKT the fit falls back to an approximate local
// TM that drifts by km on a geographic frame, so the codes incident maps are
// drawn in get an equivalent ESRI-style WKT here, and everything downstream
// (crsFromWkt, the stored georef) stays WKT-only. No sampled ArcGIS file
// writes /EPSG; unknown projected codes keep the approximate fallback.
const DEG_UNIT = 'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]';
const GEOG = {
  wgs84: `GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],${DEG_UNIT}]`,
  nad83: `GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],${DEG_UNIT}]`,
  nad27: `GEOGCS["GCS_North_American_1927",DATUM["D_North_American_1927",SPHEROID["Clarke_1866",6378206.4,294.9786982]],${DEG_UNIT}]`,
};
type Geog = keyof typeof GEOG;

function projcs(name: string, geog: Geog, projection: string, params: Record<string, number>): string {
  const p = Object.entries(params).map(([k, v]) => `,PARAMETER["${k}",${v}]`).join('');
  return `PROJCS["${name}",${GEOG[geog]},PROJECTION["${projection}"]${p},UNIT["Meter",1.0]]`;
}

const albers = (name: string, geog: Geog, lon0: number, sp1: number, sp2: number, lat0: number, fn = 0) =>
  projcs(name, geog, 'Albers', {
    False_Easting: 0,
    False_Northing: fn,
    Central_Meridian: lon0,
    Standard_Parallel_1: sp1,
    Standard_Parallel_2: sp2,
    Latitude_Of_Origin: lat0,
  });

const GEOGRAPHIC_EPSG: Record<number, Geog> = { 4326: 'wgs84', 4269: 'nad83', 4267: 'nad27' };

/** EPSG codes (and ESRI 102100) with exact parameters; UTM is computed below. */
function namedEpsgWkt(code: number): string | null {
  switch (code) {
    case 3857:
    case 102100:
      return projcs('WGS_1984_Web_Mercator_Auxiliary_Sphere', 'wgs84', 'Mercator_Auxiliary_Sphere', {
        False_Easting: 0,
        False_Northing: 0,
        Central_Meridian: 0,
        Standard_Parallel_1: 0,
      });
    case 5070:
      return albers('NAD_1983_Contiguous_USA_Albers', 'nad83', -96, 29.5, 45.5, 23);
    case 3338:
      return albers('NAD_1983_Alaska_Albers', 'nad83', -154, 55, 65, 50);
    case 3310:
      return albers('NAD_1983_California_Teale_Albers', 'nad83', -120, 34, 40.5, 0, -4000000);
  }
  return null;
}

/** UTM: 326zz / 327zz WGS84 north / south, 269zz NAD83 and 267zz NAD27 north. */
function utmEpsgWkt(code: number): string | null {
  const zone = code % 100;
  const series = Math.floor(code / 100);
  const which: [Geog, boolean] | null =
    series === 326 && zone <= 60
      ? ['wgs84', false]
      : series === 327 && zone <= 60
        ? ['wgs84', true]
        : series === 269 && zone <= 23 // 26929+ are NAD83 State Plane
          ? ['nad83', false]
          : series === 267 && zone <= 22 // 26729+ are NAD27 State Plane
            ? ['nad27', false]
            : null;
  if (!which || zone < 1) return null;
  const [geog, south] = which;
  return projcs(`UTM_Zone_${zone}${south ? 'S' : 'N'}`, geog, 'Transverse_Mercator', {
    False_Easting: 500000,
    False_Northing: south ? 10000000 : 0,
    Central_Meridian: -183 + 6 * zone,
    Scale_Factor: 0.9996,
    Latitude_Of_Origin: 0,
  });
}

/**
 * A WKT for a /GCS that has no /WKT: from its /EPSG code, else a WGS84
 * GEOGCS when its /Type says the frame is plain lon/lat (GPTS are lon/lat,
 * so that fit is exact up to datum). null = unknown; the caller's approximate
 * local TM applies.
 */
export function wktForEpsg(epsg: unknown, type: unknown): string | null {
  if (typeof epsg === 'number' && Number.isInteger(epsg)) {
    const geog = GEOGRAPHIC_EPSG[epsg];
    const wkt = geog ? GEOG[geog] : (namedEpsgWkt(epsg) ?? utmEpsgWkt(epsg));
    if (wkt) return wkt;
  }
  return type === 'GEOGCS' ? GEOG.wgs84 : null;
}

async function readViewport(ix: PdfIndex, item: PdfValue): Promise<RawViewport | null> {
  const vp = await resolve(ix, item);
  if (!(vp instanceof Map)) return null;
  const bbox = await numbers(ix, vp.get('BBox'));
  if (!bbox || bbox.length !== 4) return null;
  const measure = await resolve(ix, vp.get('Measure'));
  const m = measure instanceof Map ? measure : null;
  const gcs = m ? await resolve(ix, m.get('GCS')) : null;
  let wkt: string | null = null;
  if (gcs instanceof Map) {
    wkt = textOf(await resolve(ix, gcs.get('WKT')));
    if (!wkt?.trim()) {
      wkt = wktForEpsg(await resolve(ix, gcs.get('EPSG')), await resolve(ix, gcs.get('Type')));
    }
  }
  return {
    bbox: bbox as Box,
    name: textOf(await resolve(ix, vp.get('Name'))),
    geo: m !== null && (await resolve(ix, m.get('Subtype'))) === 'GEO',
    gpts: (m && (await numbers(ix, m.get('GPTS')))) ?? [],
    lpts: (m && (await numbers(ix, m.get('LPTS')))) ?? [],
    bounds: m ? await numbers(ix, m.get('Bounds')) : null,
    wkt,
  };
}

// ---------- public API ----------

/**
 * The /VP viewports of page object `pageObjNum` (pdf.js PDFPageProxy.ref.num),
 * values exactly as written; [] when the page has none. The object index is
 * built once per Uint8Array instance, so pass the same one for every page.
 */
export async function readPageViewports(bytes: Uint8Array, pageObjNum: number): Promise<RawViewport[]> {
  try {
    return await pageViewports(bytes, pageObjNum);
  } catch (e) {
    throw e instanceof PdfParseError ? e : new PdfParseError(e instanceof Error ? e.message : String(e));
  }
}

async function pageViewports(bytes: Uint8Array, pageObjNum: number): Promise<RawViewport[]> {
  const ix = indexFor(bytes);
  const page = await lookup(ix, pageObjNum);
  if (page === undefined) {
    throw new PdfParseError(
      ix.stmFailed
        ? `page object ${pageObjNum} not found (an object stream could not be read)`
        : `page object ${pageObjNum} not found`,
    );
  }
  if (!(page instanceof Map)) throw new PdfParseError(`object ${pageObjNum} is not a page dictionary`);
  const vp = await resolve(ix, page.get('VP'));
  const items = Array.isArray(vp) ? vp : vp instanceof Map ? [vp] : [];
  const out: RawViewport[] = [];
  for (const item of items) {
    const v = await readViewport(ix, item);
    if (v) out.push(v);
  }
  return out;
}

/**
 * A byte sniff before any parsing: "%PDF-" within the first 1024 bytes;
 * /Encrypt as a key of a trailer or cross-reference stream dictionary
 * (anywhere else it isn't encryption, and /EncryptMetadata isn't /Encrypt);
 * "LGIDict" (OGC/TerraGo georeferencing) anywhere in the raw bytes.
 */
export function sniffPdf(bytes: Uint8Array): PdfSniff {
  const isPdf = indexOfSeq(bytes.subarray(0, 1024 + PDF_MAGIC.length - 1), PDF_MAGIC, 0) >= 0;
  if (!isPdf) return { isPdf, encrypted: false, lgidict: false };
  return { isPdf, encrypted: hasEncryptEntry(bytes), lgidict: indexOfSeq(bytes, LGIDICT, 0) >= 0 };
}

function hasEncryptEntry(b: Uint8Array): boolean {
  for (let h = indexOfSeq(b, ENCRYPT, 0); h >= 0; h = indexOfSeq(b, ENCRYPT, h + 1)) {
    if (!wordAt(b, h, ENCRYPT)) continue;
    if (trailerAt(b, h)?.has('Encrypt')) return true;
  }
  return false;
}

/** The trailer or xref-stream dictionary byte h sits in, or null. */
function trailerAt(b: Uint8Array, h: number): PdfDict | null {
  const objAt = containing(indexFor(b).starts, h);
  let t = lastIndexOfSeq(b, TRAILER, h, Math.max(0, objAt, h - TRAILER_WINDOW));
  while (t >= 0 && !(wordAt(b, t, TRAILER) && (t === 0 || CLS[b[t - 1]] !== REGULAR))) {
    t = lastIndexOfSeq(b, TRAILER, t, Math.max(0, objAt, h - TRAILER_WINDOW));
  }
  try {
    if (t >= 0) {
      const v = new Parser(b, t + TRAILER.length).value();
      return v instanceof Map ? v : null;
    }
    if (objAt >= 0) {
      const v = new Parser(b, objAt).value();
      return v instanceof Map && v.get('Type') === 'XRef' ? v : null;
    }
  } catch {
    // malformed: not a dictionary we can vouch for
  }
  return null;
}
