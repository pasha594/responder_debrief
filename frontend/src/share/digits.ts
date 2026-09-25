/**
 * Bytes ⇄ decimal digits for the QR payload. A QR code's numeric mode packs 3
 * digits into 10 bits, so writing binary as digits costs ~1% over the raw
 * bytes — base64 through byte mode costs 33%. Digits are also URL-safe, so
 * the payload can ride in a link fragment. Passkey ("FIDO:/…") and SMART
 * Health Card ("shc:/…") codes use the same trick.
 *
 * Every 7 bytes become exactly 17 digits (10^17 > 2^56); a short tail chunk of
 * k bytes takes TAIL_DIGITS[k] digits. Those widths are all distinct, so the
 * decoder recovers the tail length from the digit count alone.
 */
import { ShareFormatError } from './bytes';

const CHUNK = 7;
const CHUNK_DIGITS = 17;
/** Digits for a k-byte chunk: ceil(8k · log10 2). */
const TAIL_DIGITS = [0, 3, 5, 8, 10, 13, 15, 17];

export function bytesToDigits(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += CHUNK) {
    const chunk = b.subarray(i, i + CHUNK);
    let v = 0n;
    for (const byte of chunk) v = (v << 8n) | BigInt(byte);
    out += v.toString().padStart(TAIL_DIGITS[chunk.length], '0');
  }
  return out;
}

export function digitsToBytes(s: string): Uint8Array {
  if (!/^\d*$/.test(s)) throw new ShareFormatError('not a digit string');
  const full = Math.floor(s.length / CHUNK_DIGITS);
  const tailDigits = s.length % CHUNK_DIGITS;
  const tailBytes = TAIL_DIGITS.indexOf(tailDigits);
  if (tailBytes < 0) throw new ShareFormatError('bad digit count');
  const out = new Uint8Array(full * CHUNK + tailBytes);
  let o = 0;
  const put = (digits: string, n: number) => {
    let v = BigInt(digits);
    if (v >= 1n << BigInt(8 * n)) throw new ShareFormatError('digit chunk out of range');
    for (let i = n - 1; i >= 0; i--) {
      out[o + i] = Number(v & 0xffn);
      v >>= 8n;
    }
    o += n;
  };
  for (let c = 0; c < full; c++) put(s.slice(c * CHUNK_DIGITS, (c + 1) * CHUNK_DIGITS), CHUNK);
  if (tailBytes) put(s.slice(full * CHUNK_DIGITS), tailBytes);
  return out;
}
