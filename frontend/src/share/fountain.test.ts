import { describe, expect, it } from 'vitest';
import { FountainDecoder, FountainEncoder, fragmentsFor, parseFrame } from './fountain';

function message(n: number, seed = 5): Uint8Array {
  let s = seed;
  return Uint8Array.from({ length: n }, () => ((s = (s * 1103515245 + 12345) >>> 0) >>> 16) & 0xff);
}

/** Feed frames until done; returns how many frames it took. */
function transmit(msg: Uint8Array, opts: { frag: number; start?: number; drop?: number; seed?: number }) {
  const enc = new FountainEncoder(msg, opts.frag);
  const dec = new FountainDecoder();
  let s = opts.seed ?? 9;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  let used = 0;
  for (let seq = opts.start ?? 1; seq < (opts.start ?? 1) + 50 * enc.k + 50; seq++) {
    if (rand() < (opts.drop ?? 0)) continue;
    used += 1;
    const out = dec.receive(parseFrame(enc.frame(seq)));
    if (out) return { out, used, k: enc.k };
  }
  return { out: null, used, k: enc.k };
}

describe('fountain frames', () => {
  it('the first k frames are the plain fragments', () => {
    expect(fragmentsFor(1, 5, 123)).toEqual([0]);
    expect(fragmentsFor(5, 5, 123)).toEqual([4]);
    const mixed = fragmentsFor(6, 5, 123);
    expect(mixed.length).toBeGreaterThanOrEqual(1);
    expect(new Set(mixed).size).toBe(mixed.length);
    expect(fragmentsFor(6, 5, 123)).toEqual(mixed); // deterministic
  });

  it('delivers a clean loop in exactly k frames', () => {
    const msg = message(3000);
    const r = transmit(msg, { frag: 440 });
    expect(r.out).toEqual(msg);
    expect(r.used).toBe(r.k);
  });

  it.each([1, 7, 439, 440, 441, 2000, 9000])('recovers %i bytes with 30%% of frames lost', (n) => {
    const msg = message(n, n);
    const r = transmit(msg, { frag: 440, drop: 0.3, seed: n });
    expect(r.out).toEqual(msg);
    // fountain overhead stays modest
    expect(r.used).toBeLessThan(r.k * 3 + 6);
  });

  it('works when the scanner joins mid-loop (mixed frames only)', () => {
    const msg = message(5000, 3);
    const r = transmit(msg, { frag: 440, start: 40 });
    expect(r.out).toEqual(msg);
  });

  it('restarts on a frame from a different share', () => {
    const a = new FountainEncoder(message(2000, 1), 440);
    const b = new FountainEncoder(message(2000, 2), 440);
    const dec = new FountainDecoder();
    dec.receive(parseFrame(a.frame(1)));
    dec.receive(parseFrame(a.frame(2)));
    expect(dec.progress.solved).toBe(2);
    dec.receive(parseFrame(b.frame(1)));
    expect(dec.progress.solved).toBe(1);
  });

  it('ignores duplicate frames', () => {
    const enc = new FountainEncoder(message(1000), 440);
    const dec = new FountainDecoder();
    for (let i = 0; i < 5; i++) dec.receive(parseFrame(enc.frame(1)));
    expect(dec.progress).toEqual({ solved: 1, total: enc.k });
  });

  it('rejects malformed frame headers', () => {
    const f = new FountainEncoder(message(1000), 440).frame(1);
    expect(() => parseFrame(f.slice(0, 8))).toThrow();
    expect(() => parseFrame(f.slice(0, -1))).toThrow();
  });
});
