import { describe, expect, it } from 'vitest';
import { untar } from './untar';

/** Build a valid 512-byte USTAR header (correct checksum). */
function tarHeader(
  name: string,
  size: number,
  opts: { typeflag?: string; prefix?: string } = {},
): Uint8Array {
  const b = new Uint8Array(512);
  const write = (s: string, off: number) => {
    for (let i = 0; i < s.length; i++) b[off + i] = s.charCodeAt(i);
  };
  write(name, 0);
  write('0000644\0', 100); // mode
  write('0000000\0', 108); // uid
  write('0000000\0', 116); // gid
  write(size.toString(8).padStart(11, '0') + '\0', 124); // size (octal)
  write('14700000000\0', 136); // mtime
  write('        ', 148); // checksum field = spaces while summing
  write(opts.typeflag ?? '0', 156);
  write('ustar\0', 257);
  write('00', 263);
  if (opts.prefix) write(opts.prefix, 345);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}

function tarFile(name: string, payload: Uint8Array, prefix?: string): Uint8Array[] {
  const padded = new Uint8Array(Math.ceil(payload.length / 512) * 512);
  padded.set(payload);
  return [tarHeader(name, payload.length, { prefix }), padded];
}

function concat(blocks: Uint8Array[]): Uint8Array {
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('untar', () => {
  it('parses a two-member fixture with 512-byte USTAR headers', () => {
    const p1 = text('hello tif one'); // 13 bytes — exercises padding
    const p2 = text('x'.repeat(512)); // exact block multiple
    const tar = concat([
      ...tarFile('spread-rate_20260817_112500.tif', p1),
      ...tarFile('spread-rate_20260817_120000.tif', p2),
      new Uint8Array(512),
      new Uint8Array(512), // end-of-archive marker
    ]);
    const members = untar(tar);
    expect(members.map((m) => m.name)).toEqual([
      'spread-rate_20260817_112500.tif',
      'spread-rate_20260817_120000.tif',
    ]);
    expect(members[0].bytes.length).toBe(13);
    expect(new TextDecoder().decode(members[0].bytes)).toBe('hello tif one');
    expect(members[1].bytes.length).toBe(512);
    expect(members[1].bytes[0]).toBe('x'.charCodeAt(0));
  });

  it('accepts a raw ArrayBuffer input', () => {
    const tar = concat([...tarFile('a.tif', text('abc')), new Uint8Array(1024)]);
    const copy = new Uint8Array(tar).buffer;
    expect(untar(copy).map((m) => m.name)).toEqual(['a.tif']);
  });

  it('skips non-file entries (directories) but keeps walking', () => {
    const tar = concat([
      tarHeader('somedir/', 0, { typeflag: '5' }),
      ...tarFile('after-dir.tif', text('ok')),
      new Uint8Array(1024),
    ]);
    const members = untar(tar);
    expect(members.map((m) => m.name)).toEqual(['after-dir.tif']);
  });

  it('joins the USTAR prefix field for long paths', () => {
    const tar = concat([
      ...tarFile('member.tif', text('p'), 'deeply/nested'),
      new Uint8Array(1024),
    ]);
    expect(untar(tar)[0].name).toBe('deeply/nested/member.tif');
  });

  it('stops cleanly at the zero-block end-of-archive marker', () => {
    const tar = concat([
      ...tarFile('only.tif', text('1')),
      new Uint8Array(512),
      new Uint8Array(512),
      // garbage after the marker must be ignored
      text('!'.repeat(512)),
    ]);
    expect(untar(tar).length).toBe(1);
  });

  it('throws on a garbage size field instead of mis-slicing', () => {
    const bad = tarHeader('bad.tif', 3);
    bad.set(text('zzzzzzzzzzz\0'), 124);
    expect(() => untar(concat([bad, new Uint8Array(512)]))).toThrow(/bad size/);
  });
});
