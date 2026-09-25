/**
 * Douglas–Peucker line simplification in local meters (equirectangular about
 * the line's own latitude — exact enough at fire scale). Finger strokes log a
 * point every few screen pixels, most of them redundant; dropping the ones
 * within a couple of meters of the simplified line is invisible at any zoom
 * the app allows and roughly halves a drawing's share size.
 */
type Pt = [number, number];

const M_PER_DEG = 111_320;

/** A line's extent: its bounding box diagonal, in metres. */
function extentM(pts: readonly Pt[]): number {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of pts) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  const kx = M_PER_DEG * Math.cos((((s + n) / 2) * Math.PI) / 180);
  return Math.hypot((e - w) * kx, (n - s) * M_PER_DEG);
}

/** Tolerance for a drawn line: 1/200 of its extent, between 0.5 m and 2 m,
 * so a small sketch keeps its detail and a long line sheds the most points. */
export function toleranceFor(pts: readonly Pt[]): number {
  return Math.min(2, Math.max(0.5, extentM(pts) / 200));
}

/** Tolerance for a directions route: 1/1000 of its extent, between 1 m and
 * 5 m — engines log a point every few metres of road, and a shared route is
 * a stand-in until the recipient's phone routes the same pins itself. */
export function routeToleranceFor(pts: readonly Pt[]): number {
  return Math.min(5, Math.max(1, extentM(pts) / 1000));
}

export function simplifyLine(pts: readonly Pt[], tolM: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const lat0 = (pts[0][1] * Math.PI) / 180;
  const kx = M_PER_DEG * Math.cos(lat0);
  const P = pts.map(([x, y]) => [x * kx, y * M_PER_DEG]);
  const keep = new Uint8Array(P.length);
  keep[0] = keep[P.length - 1] = 1;
  const stack: [number, number][] = [[0, P.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = P[a];
    const [bx, by] = P[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = P[i];
      // distance to the SEGMENT, so a stroke that doubles back (or closes
      // on itself) keeps its far end
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolM) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
