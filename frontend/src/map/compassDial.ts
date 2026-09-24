/**
 * Compass dial geometry and drag math — pure, so it's unit-tested. The dial
 * is drawn in a viewBox centered on 0,0 with "up" as north; angles are
 * degrees clockwise from up, matching compass bearings.
 */

/** Where every tick ends: the rim, just inside the button's border. */
export const DIAL_RADIUS = 19.5;

/** One SVG path holding a radial tick every 10° that `keep` accepts, each
 * `length` long and ending at the rim. */
export function tickPath(
  keep: (deg: number) => boolean,
  length: number,
  radius: number = DIAL_RADIUS,
): string {
  let d = '';
  for (let deg = 0; deg < 360; deg += 10) {
    if (!keep(deg)) continue;
    const rad = (deg * Math.PI) / 180;
    const [s, c] = [Math.sin(rad), Math.cos(rad)];
    const r1 = radius - length;
    d += `M${(r1 * s).toFixed(2)} ${(-r1 * c).toFixed(2)}L${(radius * s).toFixed(2)} ${(-radius * c).toFixed(2)}`;
  }
  return d;
}

/** The 10° notches between the 30° marks. */
export const MINOR_TICKS = tickPath((d) => d % 30 !== 0, 2.5);
/** Every 30°, except the cardinal directions. */
export const MAJOR_TICKS = tickPath((d) => d % 30 === 0 && d % 90 !== 0, 4);
/** East, south and west. North is the red mark instead. */
export const CARDINAL_TICKS = tickPath((d) => d % 90 === 0 && d !== 0, 5.5);

/** Pointer angle around the dial's center, degrees clockwise from up.
 * dx/dy are screen offsets from the center (y grows downward). */
export function pointerAngle(dx: number, dy: number): number {
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

/**
 * Map bearing while the dial is being turned. The dial follows the pointer,
 * so turning it clockwise turns the map clockwise, which LOWERS the bearing
 * (the top of the screen now faces further counter-clockwise). The shortest
 * turn from the press angle is used, so crossing the ±180° seam doesn't jump.
 */
export function dragBearing(bearingAtPress: number, angleAtPress: number, angle: number): number {
  const delta = ((angle - angleAtPress + 540) % 360) - 180;
  return bearingAtPress - delta;
}
