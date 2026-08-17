/**
 * Minimal USTAR reader for the archive's hourly-product tars (plain GNU/pax
 * tars of small regular files). Parses 512-byte headers, yields regular-file
 * members as subarray views into the source buffer (zero-copy). No streaming:
 * tars are 3–9 MB and already fully downloaded when this runs.
 */

export interface TarMember {
  name: string;
  /** View into the input buffer — copy before transferring/detaching. */
  bytes: Uint8Array;
}

const BLOCK = 512;

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const stop = offset + length;
  while (end < stop && block[end] !== 0) end++;
  let s = '';
  for (let i = offset; i < end; i++) s += String.fromCharCode(block[i]);
  return s;
}

/** Octal number field (NUL/space padded). NaN on garbage. */
function readOctal(block: Uint8Array, offset: number, length: number): number {
  const raw = readString(block, offset, length).trim();
  if (raw === '') return 0;
  const n = Number.parseInt(raw, 8);
  return Number.isNaN(n) ? NaN : n;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < BLOCK; i++) if (block[i] !== 0) return false;
  return true;
}

/**
 * Parse a tar archive → regular-file members in archive order. Non-file
 * entries (directories, pax/gnu metadata) are skipped; a malformed size field
 * aborts with an error rather than mis-slicing the rest of the archive.
 */
export function untar(data: ArrayBuffer | Uint8Array): TarMember[] {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const members: TarMember[] = [];
  let off = 0;
  while (off + BLOCK <= u8.length) {
    const header = u8.subarray(off, off + BLOCK);
    if (isZeroBlock(header)) break; // end-of-archive marker
    const name = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    if (Number.isNaN(size) || size < 0) throw new Error(`untar: bad size field at offset ${off}`);
    const typeflag = header[156]; // 0 / '0' = regular file
    // USTAR prefix field (long paths split across prefix + name).
    const prefix = readString(header, 345, 155);
    off += BLOCK;
    if (typeflag === 0 || typeflag === 0x30) {
      members.push({
        name: prefix ? `${prefix}/${name}` : name,
        bytes: u8.subarray(off, off + size),
      });
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return members;
}
