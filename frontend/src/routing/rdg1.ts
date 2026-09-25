/**
 * RDG1 road/trail network decoder (the byte contract with the worker's
 * graph_build.encode_rdg1; FINAL_PLAN.md §2.6). Views into one buffer — no
 * per-edge copies. Coordinates are decimetres: x east of x0, y SOUTH of y0
 * (grid row direction).
 */
export const KIND = { paved: 1, unpaved: 2, track: 3, path: 4, steps: 5, agency: 6 } as const;
export const SRC = { osm: 1, usfs: 2, blm: 3, nps: 4 } as const;
export const FLAG = {
  restricted: 1, seasonal: 2, bridge: 4, tunnel: 8,
  wilderness: 16, notAssessed: 32, agencyNamed: 64, ford: 128,
} as const;
export const NONE = 0xffffffff;

export interface Rdg1 {
  epsg: number;
  x0: number;
  y0: number;
  nodes: Int32Array; // 2N
  from: Uint32Array;
  to: Uint32Array;
  dstart: Uint32Array; // E+1
  deltas: Int16Array; // 2D
  name: Uint32Array;
  ref: Uint32Array;
  note: Uint32Array;
  kind: Uint8Array;
  src: Uint8Array;
  sac: Uint8Array;
  flags: Uint8Array;
  strings: string[];
}

export async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export function parseRdg1(buf: ArrayBuffer): Rdg1 {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'RDG1' || dv.getUint16(4, true) !== 1) throw new Error('not an RDG1 v1 graph');
  const hdr = dv.getUint16(6, true);
  const N = dv.getUint32(8, true);
  const E = dv.getUint32(12, true);
  const D = dv.getUint32(16, true);
  const K = dv.getUint32(20, true);
  const S = dv.getUint32(24, true);
  const epsg = dv.getUint32(28, true);
  const x0 = dv.getFloat64(32, true);
  const y0 = dv.getFloat64(40, true);
  let pos = hdr;
  const align = () => {
    pos = (pos + 3) & ~3;
  };
  const i32 = (n: number) => {
    const a = new Int32Array(buf, pos, n);
    pos += 4 * n;
    return a;
  };
  const u32 = (n: number) => {
    const a = new Uint32Array(buf, pos, n);
    pos += 4 * n;
    return a;
  };
  const u8 = (n: number) => {
    const a = new Uint8Array(buf, pos, n);
    pos += n;
    return a;
  };
  const nodes = i32(2 * N);
  const from = u32(E);
  const to = u32(E);
  const dstart = u32(E + 1);
  const deltas = new Int16Array(buf, pos, 2 * D);
  pos += 4 * D;
  align();
  const name = u32(E);
  const ref = u32(E);
  const note = u32(E);
  const kind = u8(E);
  const src = u8(E);
  const sac = u8(E);
  const flags = u8(E);
  align();
  const offs = u32(K + 1);
  const bytes = new Uint8Array(buf, pos, S);
  const dec = new TextDecoder();
  const strings: string[] = [];
  for (let i = 0; i < K; i++) strings.push(dec.decode(bytes.subarray(offs[i], offs[i + 1])));
  return { epsg, x0, y0, nodes, from, to, dstart, deltas, name, ref, note, kind, src, sac, flags, strings };
}

export function str(g: Rdg1, idx: number): string | null {
  return idx === NONE ? null : g.strings[idx] ?? null;
}
