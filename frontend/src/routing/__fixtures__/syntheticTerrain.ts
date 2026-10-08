/** Terrarium-style tile source from a height function of web-mercator
 * metres east/north of a lon/lat origin (tests: plains, ramps, cliffs). */
import type { TileSource } from '../terrainTiles';

type LonLat = [number, number];

export function syntheticTiles(origin: LonLat, height: (east: number, north: number) => number): TileSource {
  const ky = 111_320;
  const kx = ky * Math.cos((origin[1] * Math.PI) / 180);
  return async (z, tx, ty) => {
    const n = 256 * 2 ** z;
    const h = new Float32Array(256 * 256);
    for (let r = 0; r < 256; r++) {
      const y = (ty * 256 + r + 0.5) / n;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
      for (let c = 0; c < 256; c++) {
        const lon = ((tx * 256 + c + 0.5) / n) * 360 - 180;
        h[r * 256 + c] = height((lon - origin[0]) * kx, (lat - origin[1]) * ky);
      }
    }
    return h;
  };
}
