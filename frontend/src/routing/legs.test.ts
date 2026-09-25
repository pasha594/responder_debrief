import { describe, expect, it } from 'vitest';
import { stepsFor, type WalkLeg } from './legs';

// lon/lat for metres east/north of a point near Stehekin
const LAT0 = 48.4;
const at = (x: number, y: number): [number, number] =>
  [-120.8 + x / (111_320 * Math.cos((LAT0 * Math.PI) / 180)), LAT0 + y / 111_320];

/** A cross-country leg along the corners, 15 m apart like xcLeg's line. */
function xc(corners: [number, number][]): WalkLeg {
  const coordinates: [number, number][] = [at(...corners[0])];
  let distanceM = 0;
  for (let i = 0; i + 1 < corners.length; i++) {
    const [x0, y0] = corners[i];
    const [x1, y1] = corners[i + 1];
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.ceil(d / 15);
    for (let k = 1; k <= n; k++) coordinates.push(at(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n));
    distanceM += d;
  }
  return { kind: 'xc', coordinates, distanceM, climbM: 0, descentM: 0, durationS: 1800, vegM: { 4: distanceM } };
}

describe('cross-country step text', () => {
  it('names each main bend of a leg that bends, not one end-to-end bearing', () => {
    // up a creek 1 km, then east 1 km round a cliff: "NE 1.2 mi" would
    // cut the corner across it
    const [s] = stepsFor([xc([[0, 0], [0, 1000], [1000, 1000]])]);
    expect(s.text).toBe('Head cross-country 1.2 mi through timber: N 0.6 mi, then E 0.6 mi — about 30 min');
  });

  it('keeps one bearing for a straight leg, wiggles and all', () => {
    const [s] = stepsFor([xc([[0, 0], [300, 330], [600, 580], [900, 950]])]);
    expect(s.text).toBe('Head cross-country NE 0.8 mi through timber — about 30 min');
  });

  it('keeps at most four parts, and folds a short jog into its neighbour', () => {
    const stairs = xc([[0, 0], [0, 800], [800, 800], [800, 1600], [1600, 1600], [1600, 2400], [2400, 2400]]);
    expect(stepsFor([stairs])[0].text.split(', then ')).toHaveLength(4);
    // a 150 m jog east (a bend, but under 0.1 mi) between two runs north
    // reads as one part
    const [s] = stepsFor([xc([[0, 0], [0, 1200], [150, 1200], [150, 1600]])]);
    expect(s.text).toBe('Head cross-country N 1.1 mi through timber — about 30 min');
  });
});
