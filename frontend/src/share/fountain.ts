/**
 * Animated codes for shares too big for one QR code: a fountain code in the
 * style of Blockchain Commons' multipart UR (what hardware crypto wallets use
 * to pass transactions over a screen), reduced to what a camera-to-screen
 * link needs.
 *
 * The message is cut into k equal fragments. Frames 1..k carry them in order
 * (one pass with no misses is enough); every later frame carries the XOR of a
 * pseudo-random handful, chosen from the message checksum and the frame's
 * sequence number, so both ends derive the same mix without sending it. The
 * receiver peels: any frame reduced to one unknown fragment solves it, and
 * each solution may unlock others. Frames arrive in any order, a missed frame
 * costs nothing but time, and a scanner can join mid-loop.
 *
 * Frame bytes: [2][checksum u32][k][message length][seq][fragment], the
 * numbers as LEB128 varints. The checksum is the message's CRC-32 and doubles
 * as the session id: a frame from another share restarts the decoder.
 */
import { ByteReader, ByteWriter, ShareFormatError, crc32 } from './bytes';

export const FRAME_TYPE = 2;

/** Mulberry32: tiny, fast, and identical on every JS engine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which fragments frame `seq` (1-based) mixes. The first k are the fragments
 * themselves; later degrees follow weights 1/d (many low-degree frames, which
 * peel easily, and a few wide ones that cover stragglers).
 */
export function fragmentsFor(seq: number, k: number, checksum: number): number[] {
  if (seq <= k) return [seq - 1];
  const rand = rng(checksum ^ Math.imul(seq, 0x9e3779b1));
  let total = 0;
  for (let d = 1; d <= k; d++) total += 1 / d;
  let pick = rand() * total;
  let degree = 1;
  for (; degree < k; degree++) {
    pick -= 1 / degree;
    if (pick <= 0) break;
  }
  const idx = Array.from({ length: k }, (_, i) => i);
  for (let i = 0; i < degree; i++) {
    const j = i + Math.floor(rand() * (k - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, degree).sort((a, b) => a - b);
}

function xorInto(target: Uint8Array, src: Uint8Array): void {
  for (let i = 0; i < target.length; i++) target[i] ^= src[i];
}

export class FountainEncoder {
  readonly k: number;
  readonly checksum: number;
  private readonly fragments: Uint8Array[];

  constructor(private readonly message: Uint8Array, maxFragment: number) {
    this.k = Math.max(1, Math.ceil(message.length / maxFragment));
    const len = Math.ceil(message.length / this.k);
    const padded = new Uint8Array(len * this.k);
    padded.set(message);
    this.fragments = Array.from({ length: this.k }, (_, i) =>
      padded.subarray(i * len, (i + 1) * len));
    this.checksum = crc32(message);
  }

  /** Frame bytes for sequence number `seq` (1, 2, 3, … forever). */
  frame(seq: number): Uint8Array {
    const parts = fragmentsFor(seq, this.k, this.checksum);
    const data = this.fragments[parts[0]].slice();
    for (const p of parts.slice(1)) xorInto(data, this.fragments[p]);
    const w = new ByteWriter();
    w.u8(FRAME_TYPE);
    w.u32(this.checksum);
    w.varint(this.k);
    w.varint(this.message.length);
    w.varint(seq);
    w.bytes(data);
    return w.finish();
  }
}

export interface FrameInfo {
  checksum: number;
  k: number;
  length: number;
  seq: number;
  data: Uint8Array;
}

export function parseFrame(bytes: Uint8Array): FrameInfo {
  const r = new ByteReader(bytes);
  if (r.u8() !== FRAME_TYPE) throw new ShareFormatError('not a frame');
  const checksum = r.u32();
  const k = r.varint();
  const length = r.varint();
  const seq = r.varint();
  const data = r.bytes(r.remaining);
  if (k < 1 || k > 1000 || seq < 1 || data.length * k < length
      || data.length !== Math.ceil(length / k)) {
    throw new ShareFormatError('bad frame header');
  }
  return { checksum, k, length, seq, data };
}

export class FountainDecoder {
  private session: { checksum: number; k: number; length: number } | null = null;
  private solved: (Uint8Array | undefined)[] = [];
  private solvedCount = 0;
  private pending: { parts: Set<number>; data: Uint8Array }[] = [];
  private seen = new Set<number>();
  private done: Uint8Array | null = null;

  /** Fragments recovered so far, of how many. */
  get progress(): { solved: number; total: number } {
    return { solved: this.solvedCount, total: this.session?.k ?? 0 };
  }

  get message(): Uint8Array | null {
    return this.done;
  }

  /** Feed one scanned frame. Returns the whole message once it is complete. */
  receive(frame: FrameInfo): Uint8Array | null {
    const s = this.session;
    if (!s || s.checksum !== frame.checksum || s.k !== frame.k || s.length !== frame.length) {
      this.reset(frame);
    }
    if (this.done || this.seen.has(frame.seq)) return this.done;
    this.seen.add(frame.seq);

    const parts = fragmentsFor(frame.seq, frame.k, frame.checksum);
    const data = frame.data.slice();
    const unknown = new Set<number>();
    for (const p of parts) {
      const known = this.solved[p];
      if (known) xorInto(data, known);
      else unknown.add(p);
    }
    if (unknown.size === 1) this.solve([...unknown][0], data);
    else if (unknown.size > 1) this.pending.push({ parts: unknown, data });

    if (this.solvedCount === frame.k) this.finish();
    return this.done;
  }

  private reset(frame: FrameInfo): void {
    this.session = { checksum: frame.checksum, k: frame.k, length: frame.length };
    this.solved = new Array(frame.k);
    this.solvedCount = 0;
    this.pending = [];
    this.seen = new Set();
    this.done = null;
  }

  private solve(first: number, firstData: Uint8Array): void {
    const queue: [number, Uint8Array][] = [[first, firstData]];
    while (queue.length) {
      const [i, d] = queue.pop()!;
      if (this.solved[i]) continue;
      this.solved[i] = d;
      this.solvedCount += 1;
      // Peel: every mixed frame that included i loses it.
      const still: typeof this.pending = [];
      for (const eq of this.pending) {
        if (eq.parts.has(i)) {
          xorInto(eq.data, d);
          eq.parts.delete(i);
        }
        if (eq.parts.size === 1) queue.push([[...eq.parts][0], eq.data]);
        else if (eq.parts.size > 1) still.push(eq);
      }
      this.pending = still;
    }
  }

  private finish(): void {
    const s = this.session!;
    const len = this.solved[0]!.length;
    const joined = new Uint8Array(len * s.k);
    this.solved.forEach((frag, i) => joined.set(frag!, i * len));
    const message = joined.slice(0, s.length);
    if (crc32(message) !== s.checksum) {
      // A corrupt frame poisoned the peel: start the session over.
      this.session = null;
      return;
    }
    this.done = message;
  }
}
