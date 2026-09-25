/**
 * QR symbols for a share (lean-qr). Each code is two segments — the link
 * prefix in plain ASCII, then the payload digits in numeric mode — which every
 * reader joins back into one string.
 *
 * One static code when the share fits in version 25 (117×117 modules) at
 * error-correction M: the densest code current phones read reliably off
 * another phone's screen. Anything larger animates: ~440-byte fragments land
 * each frame near version 15 (77×77) at correction L, easy to catch mid-loop.
 */
import { correction, generate, mode, type Bitmap2D } from 'lean-qr';
import { bytesToDigits } from './digits';
import { FountainEncoder } from './fountain';
import { singleCodeBytes } from './transport';

const SINGLE_MAX_VERSION = 25;
export const FRAME_FRAGMENT_BYTES = 440;
/** Frame pace: 5 a second — slow enough for mid-range phones to decode most. */
export const FRAME_INTERVAL_MS = 200;

function symbol(
  prefix: string,
  bytes: Uint8Array,
  opts: { min: 'L' | 'M'; minVersion?: number; maxVersion?: number },
): Bitmap2D {
  return generate(mode.multi(mode.ascii(prefix), mode.numeric(bytesToDigits(bytes))), {
    minCorrectionLevel: correction[opts.min],
    minVersion: opts.minVersion,
    maxVersion: opts.maxVersion,
  });
}

export function versionOf(code: Bitmap2D): number {
  return (code.size - 17) / 4;
}

export type SharePlan =
  | { kind: 'single'; code: Bitmap2D }
  | { kind: 'animated'; frames: number; frameCode(seq: number): Bitmap2D };

export function planShareCodes(body: Uint8Array, prefix: string): SharePlan {
  try {
    return {
      kind: 'single',
      code: symbol(prefix, singleCodeBytes(body), { min: 'M', maxVersion: SINGLE_MAX_VERSION }),
    };
  } catch {
    // too big for one code (lean-qr throws when nothing up to maxVersion fits)
  }
  const encoder = new FountainEncoder(body, FRAME_FRAGMENT_BYTES);
  let floor: number | undefined;
  return {
    kind: 'animated',
    frames: encoder.k,
    frameCode(seq) {
      // Hold the first frame's size so the code doesn't pulse between versions.
      const code = symbol(prefix, encoder.frame(seq), { min: 'L', minVersion: floor });
      floor ??= versionOf(code);
      return code;
    },
  };
}
