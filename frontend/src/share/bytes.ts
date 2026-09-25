/**
 * Byte plumbing for the QR share format: a growable writer, a bounds-checked
 * reader (running past the end is a ShareFormatError, never garbage), LEB128
 * varints, zigzag for signed deltas, and CRC-32 for end-to-end checks.
 *
 * Varints stay exact up to Number.MAX_SAFE_INTEGER (arithmetic, not 32-bit
 * bitwise ops), which covers every epoch-minute and coordinate we store.
 */

/** Anything wrong with a scanned payload: truncated, corrupt, or foreign. */
export class ShareFormatError extends Error {
  /** 'newer' — written by a newer app version; everything else is 'corrupt'. */
  readonly reason: 'corrupt' | 'newer';

  constructor(message: string, reason: 'corrupt' | 'newer' = 'corrupt') {
    super(message);
    this.reason = reason;
  }
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export class ByteWriter {
  private buf = new Uint8Array(256);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  u32(v: number): void {
    this.ensure(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }

  /** Unsigned LEB128. */
  varint(v: number): void {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`varint out of range: ${v}`);
    while (v >= 0x80) {
      this.u8((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.u8(v);
  }

  /** Signed integer as zigzag LEB128 (small magnitudes stay small). */
  zigzag(v: number): void {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  /** Length-prefixed UTF-8. */
  str(s: string): void {
    const b = utf8Encoder.encode(s);
    this.varint(b.length);
    this.bytes(b);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new ShareFormatError('payload ends early');
    return this.buf[this.pos++];
  }

  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }

  varint(): number {
    let v = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      v += (b & 0x7f) * scale;
      if (!(b & 0x80)) {
        if (!Number.isSafeInteger(v)) break;
        return v;
      }
      scale *= 0x80;
    }
    throw new ShareFormatError('varint too long');
  }

  zigzag(): number {
    const z = this.varint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  bytes(n: number): Uint8Array {
    if (n > this.remaining) throw new ShareFormatError('payload ends early');
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  str(): string {
    const b = this.bytes(this.varint());
    try {
      return utf8Decoder.decode(b);
    } catch {
      throw new ShareFormatError('bad text');
    }
  }
}

// ---------- CRC-32 (IEEE 802.3, the zip/PNG one) ----------

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

export function crc32(b: Uint8Array): number {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Trim a string to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (utf8Encoder.encode(s).length <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = utf8Encoder.encode(ch).length;
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}
