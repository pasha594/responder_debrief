import { describe, expect, it } from 'vitest';
import {
  CARDINAL_TICKS,
  DIAL_RADIUS,
  MAJOR_TICKS,
  MINOR_TICKS,
  dragBearing,
  pointerAngle,
  tickPath,
} from './compassDial';

const count = (d: string) => (d.match(/M/g) ?? []).length;

describe('compass dial ticks', () => {
  it('notches every 10°: 24 minor, 8 major, 3 cardinal, and north left for the red mark', () => {
    expect(count(MINOR_TICKS)).toBe(24);
    expect(count(MAJOR_TICKS)).toBe(8);
    expect(count(CARDINAL_TICKS)).toBe(3);
    expect(count(MINOR_TICKS) + count(MAJOR_TICKS) + count(CARDINAL_TICKS)).toBe(35);
  });

  it('runs each tick radially inward from the rim', () => {
    // due east: from (rim - length, 0) to (rim, 0)
    expect(tickPath((d) => d === 90, 4)).toBe(`M${(DIAL_RADIUS - 4).toFixed(2)} -0.00L${DIAL_RADIUS.toFixed(2)} -0.00`);
    // due south: straight down, y positive
    expect(tickPath((d) => d === 180, 2, 10)).toBe('M0.00 8.00L0.00 10.00');
  });
});

describe('compass dial drag', () => {
  it('measures pointer angles clockwise from up', () => {
    expect(pointerAngle(0, -1)).toBeCloseTo(0);
    expect(pointerAngle(1, 0)).toBeCloseTo(90);
    expect(Math.abs(pointerAngle(0, 1))).toBeCloseTo(180);
    expect(pointerAngle(-1, 0)).toBeCloseTo(-90);
  });

  it('turning the dial clockwise lowers the bearing, one for one', () => {
    expect(dragBearing(30, 0, 10)).toBeCloseTo(20);
    expect(dragBearing(30, 0, -15)).toBeCloseTo(45);
  });

  it('takes the short way across the ±180° seam', () => {
    // 170° → -170° is a 20° clockwise turn, not a 340° counter-clockwise one
    expect(dragBearing(0, 170, -170)).toBeCloseTo(-20);
    expect(dragBearing(0, -170, 170)).toBeCloseTo(20);
  });
});
