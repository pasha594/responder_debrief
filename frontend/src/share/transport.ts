/**
 * From share bytes to QR text and back. Every code — a single one or each
 * frame of an animated run — reads as a link into the app:
 *
 *   https://incibrief.com/s#<digits>
 *
 * so a phone's own camera app opens it when online (the part after '#' never
 * leaves the phone), while the in-app scanner reads it offline. The digits
 * decode (digits.ts) to a type byte and its payload:
 *   1 — a whole share: body + CRC-32 of the body;
 *   2 — one frame of an animated share (fountain.ts).
 */
import { ByteWriter, ShareFormatError, crc32 } from './bytes';
import { bytesToDigits, digitsToBytes } from './digits';
import { FRAME_TYPE, parseFrame, type FrameInfo } from './fountain';

export const SINGLE_TYPE = 1;

/** The link every code starts with: this app's own origin and base, route /s. */
export function shareLinkPrefix(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}s#`;
}

export function singleCodeBytes(body: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.u8(SINGLE_TYPE);
  w.bytes(body);
  w.u32(crc32(body));
  return w.finish();
}

export type ScannedCode =
  | { kind: 'single'; body: Uint8Array }
  | { kind: 'frame'; frame: FrameInfo };

/** Payload bytes of a scanned code (single or frame). */
export function decodeCodeBytes(bytes: Uint8Array): ScannedCode {
  if (bytes[0] === SINGLE_TYPE) {
    if (bytes.length < 6) throw new ShareFormatError('too short');
    const body = bytes.slice(1, -4);
    const t = bytes.length - 4;
    const crc = ((bytes[t] << 24) | (bytes[t + 1] << 16) | (bytes[t + 2] << 8) | bytes[t + 3]) >>> 0;
    if (crc32(body) !== crc) throw new ShareFormatError('checksum mismatch');
    return { kind: 'single', body };
  }
  if (bytes[0] === FRAME_TYPE) return { kind: 'frame', frame: parseFrame(bytes) };
  throw new ShareFormatError('unknown code type', bytes[0] > FRAME_TYPE ? 'newer' : 'corrupt');
}

/**
 * The digits of a share link, from scanned text or `location.hash`: anything
 * ending in `/s#<digits>` (any origin — dev, preview and production builds
 * read each other's codes). Null for text that isn't a share code.
 */
export function shareDigits(text: string): string | null {
  const m = /\/s#(\d+)\s*$/.exec(text.trim());
  return m ? m[1] : null;
}

export function parseShareText(text: string): ScannedCode | null {
  const digits = shareDigits(text);
  return digits ? decodeCodeBytes(digitsToBytes(digits)) : null;
}

export { bytesToDigits };
