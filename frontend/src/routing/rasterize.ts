/**
 * Fire-perimeter mask on the routing grid (pure). Polygons arrive in GRID
 * coordinates (fractional col, row; bundleIndex.toGrid). A cell is masked
 * when its centre is inside (even-odd per polygon, so holes stay open), when
 * any perimeter edge touches it (supercover — a thin sliver still blocks), or
 * when it is within the standoff of either (disk dilation).
 */
export type GridRing = [number, number][];
export type GridPolygon = GridRing[];

function setCell(mask: Uint8Array, w: number, h: number, c: number, r: number): void {
  if (c >= 0 && r >= 0 && c < w && r < h) mask[r * w + c] = 1;
}

/** Every cell a segment passes through (Amanatides–Woo). */
function supercover(mask: Uint8Array, w: number, h: number, x0: number, y0: number,
  x1: number, y1: number): void {
  let c = Math.floor(x0);
  let r = Math.floor(y0);
  const c1 = Math.floor(x1);
  const r1 = Math.floor(y1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tx = dx !== 0 ? (dx > 0 ? c + 1 - x0 : x0 - c) * tdx : Infinity;
  let ty = dy !== 0 ? (dy > 0 ? r + 1 - y0 : y0 - r) * tdy : Infinity;
  setCell(mask, w, h, c, r);
  let guard = Math.abs(c1 - c) + Math.abs(r1 - r) + 2;
  while ((c !== c1 || r !== r1) && guard-- > 0) {
    if (tx < ty) {
      tx += tdx;
      c += sx;
    } else {
      ty += tdy;
      r += sy;
    }
    setCell(mask, w, h, c, r);
  }
}

function fillPolygon(mask: Uint8Array, w: number, h: number, poly: GridPolygon): void {
  let minR = Infinity;
  let maxR = -Infinity;
  for (const ring of poly) {
    for (const [, y] of ring) {
      if (y < minR) minR = y;
      if (y > maxR) maxR = y;
    }
  }
  const r0 = Math.max(0, Math.floor(minR));
  const r1 = Math.min(h - 1, Math.ceil(maxR));
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const y = r + 0.5;
    xs.length = 0;
    for (const ring of poly) {
      const n = ring.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const ca = Math.max(0, Math.ceil(xs[k] - 0.5));
      const cb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let c = ca; c <= cb; c++) mask[r * w + c] = 1;
    }
  }
  for (const ring of poly) {
    for (let i = 0; i + 1 < ring.length; i++) {
      supercover(mask, w, h, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
    }
  }
}

/** Dilate a 0/1 mask by `radius` cells (disk); only boundary cells stamp. */
export function dilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const out = mask.slice();
  const R = Math.ceil(radius);
  const offs: [number, number][] = [];
  for (let dr = -R; dr <= R; dr++) {
    for (let dc = -R; dc <= R; dc++) if (dr * dr + dc * dc <= radius * radius + 1e-9) offs.push([dc, dr]);
  }
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (!mask[i]) continue;
      const edge = c === 0 || r === 0 || c === w - 1 || r === h - 1
        || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w];
      if (!edge) continue;
      for (const [dc, dr] of offs) setCell(out, w, h, c + dc, r + dr);
    }
  }
  return out;
}

/** Mask cells for (Multi)Polygon rings in grid coordinates, + standoff. */
export function rasterizePolygons(polys: GridPolygon[], w: number, h: number,
  standoffCells: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (const p of polys) fillPolygon(mask, w, h, p);
  return dilate(mask, w, h, standoffCells);
}
