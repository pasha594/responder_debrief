import { describe, expect, it } from 'vitest';
import {
  MAX_DPI,
  MAX_FILE_BYTES,
  MAX_SIDE,
  MIN_BUDGET,
  budgetLadder,
  cropSize,
  isTouchDevice,
  pixelBudget,
} from './renderBudget';

function nav(userAgent: string, platform = '', maxTouchPoints = 0): Navigator {
  return { userAgent, platform, maxTouchPoints } as Navigator;
}

const IPHONE = nav(
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
  'iPhone',
  5,
);
const IPAD_OLD_UA = nav(
  'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  'iPad',
  5,
);
/** iPadOS 13+ Safari requests the desktop site: indistinguishable from a Mac but for touch. */
const IPAD_DESKTOP_UA = nav(
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'MacIntel',
  5,
);
const MAC = nav(
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'MacIntel',
  0,
);
const ANDROID = nav(
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  'Linux armv8l',
  5,
);
const WINDOWS_TOUCH_LAPTOP = nav(
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Win32',
  10,
);

/** Page sizes in points (72/in) of the sample incident maps. */
const ARCH_E = [3456, 2592] as const;
const BAM_72 = [5184, 5184] as const;
const LETTER = [612, 792] as const;
/** A 2 × 96 inch strip map (a long road or river corridor). */
const STRIP = [144, 6912] as const;

describe('isTouchDevice', () => {
  it('treats iPhone, iPad and Android user agents as touch devices', () => {
    expect(isTouchDevice(IPHONE)).toBe(true);
    expect(isTouchDevice(IPAD_OLD_UA)).toBe(true);
    expect(isTouchDevice(ANDROID)).toBe(true);
  });

  it('spots iPadOS behind its desktop (MacIntel) user agent by its touch points', () => {
    expect(isTouchDevice(IPAD_DESKTOP_UA)).toBe(true);
    expect(isTouchDevice(MAC)).toBe(false);
  });

  it('keeps touch-screen laptops on the desktop budget', () => {
    expect(isTouchDevice(WINDOWS_TOUCH_LAPTOP)).toBe(false);
  });

  it('is false with no navigator at all', () => {
    expect(isTouchDevice(undefined)).toBe(false);
  });
});

describe('pixelBudget', () => {
  it('gives phones and tablets 12 MP and desktops 32 MP', () => {
    expect(pixelBudget(IPHONE)).toBe(12e6);
    expect(pixelBudget(IPAD_DESKTOP_UA)).toBe(12e6);
    expect(pixelBudget(ANDROID)).toBe(12e6);
    expect(pixelBudget(MAC)).toBe(32e6);
    expect(pixelBudget(WINDOWS_TOUCH_LAPTOP)).toBe(32e6);
  });

  it('every budget leaves room to retry at least once', () => {
    for (const n of [IPHONE, MAC]) expect(pixelBudget(n)).toBeGreaterThan(MIN_BUDGET);
  });
});

describe('constants', () => {
  it('match the design limits', () => {
    expect(MAX_SIDE).toBe(16384);
    expect(MIN_BUDGET).toBe(2e6);
    expect(MAX_FILE_BYTES).toBe(150 * 1024 * 1024);
  });
});

describe('cropSize', () => {
  it('fills the budget on an ARCH E sheet with the sheet aspect', () => {
    const { width, height, scale } = cropSize(ARCH_E[0], ARCH_E[1], 12e6);
    expect(width).toBe(4000);
    expect(height).toBe(3000);
    expect(scale).toBeCloseTo(4000 / 3456, 9);
    expect(scale * 72).toBeCloseTo(83.3, 1); // dpi on a phone
  });

  it('gives a desktop ARCH E render ~136 dpi within 32 MP', () => {
    const { width, height, scale } = cropSize(ARCH_E[0], ARCH_E[1], 32e6);
    expect(width * height).toBeLessThanOrEqual(32e6);
    expect(width * height).toBeGreaterThan(32e6 * 0.999);
    expect(width / height).toBeCloseTo(ARCH_E[0] / ARCH_E[1], 3);
    expect(scale * 72).toBeCloseTo(136.1, 1);
  });

  it('renders a square 72×72 in map square', () => {
    const { width, height } = cropSize(BAM_72[0], BAM_72[1], 12e6);
    expect(width).toBe(height);
    expect(width).toBe(Math.floor(Math.sqrt(12e6)));
  });

  it('upscales small frames (a letter page) to the budget', () => {
    const { width, height, scale } = cropSize(LETTER[0], LETTER[1], MIN_BUDGET);
    expect(scale).toBeGreaterThan(1);
    expect(width * height).toBeLessThanOrEqual(MIN_BUDGET);
    expect(width * height).toBeGreaterThan(MIN_BUDGET * 0.998);
  });

  it('stops at MAX_DPI on small sheets instead of filling the budget', () => {
    const { width, height, scale } = cropSize(LETTER[0], LETTER[1], 32e6);
    expect(scale * 72).toBeCloseTo(MAX_DPI, 9);
    expect([width, height]).toEqual([2550, 3300]); // 8.5×11 in at 300 dpi
  });

  it('caps the long side at MAX_SIDE when the budget and MAX_DPI would allow more', () => {
    const BIG = [BAM_72[0] * 1.5, BAM_72[1] * 1.5]; // 108 in square: 32,400 px at 300 dpi
    const { width, height, scale } = cropSize(BIG[0], BIG[1], 1e9);
    expect(width).toBe(MAX_SIDE);
    expect(height).toBe(MAX_SIDE);
    expect(scale).toBeCloseTo(MAX_SIDE / BIG[0], 12);
  });

  it('keeps a 2×96 in strip map to MAX_SIDE long, under budget, in both orientations', () => {
    for (const budget of [12e6, 32e6]) {
      const tall = cropSize(STRIP[0], STRIP[1], budget);
      expect(tall.height).toBe(MAX_SIDE); // side cap binds, not the budget
      expect(tall.width).toBe(Math.floor(144 * (MAX_SIDE / 6912)));
      expect(tall.width * tall.height).toBeLessThanOrEqual(budget);
      const wide = cropSize(STRIP[1], STRIP[0], budget);
      expect([wide.width, wide.height]).toEqual([tall.height, tall.width]);
      expect(wide.scale).toBe(tall.scale);
    }
  });

  it('lets the budget bind on a strip map when it is the tighter limit', () => {
    const { width, height, scale } = cropSize(STRIP[0], STRIP[1], MIN_BUDGET);
    expect(height).toBeLessThan(MAX_SIDE);
    expect(width * height).toBeLessThanOrEqual(MIN_BUDGET);
    expect(width * height).toBeGreaterThan(MIN_BUDGET * 0.99);
    expect(scale).toBeCloseTo(Math.sqrt(MIN_BUDGET / (STRIP[0] * STRIP[1])), 12);
  });

  it('never goes below 1 px on a needle-thin frame', () => {
    const { width, height } = cropSize(0.5, 200000, 12e6);
    expect(width).toBe(1);
    expect(height).toBe(MAX_SIDE);
  });

  it('never exceeds the budget or MAX_SIDE across many frame shapes', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2000; i++) {
      const w = 10 + rand() * 20000;
      const h = 10 + rand() * 20000;
      const budget = MIN_BUDGET + rand() * 40e6;
      const { width, height, scale } = cropSize(w, h, budget);
      expect(Number.isInteger(width) && Number.isInteger(height)).toBe(true);
      expect(width).toBeGreaterThanOrEqual(1);
      expect(height).toBeGreaterThanOrEqual(1);
      expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_SIDE);
      expect(width * height).toBeLessThanOrEqual(budget);
      // the floored sides lose less than one pixel each
      expect(w * scale - width).toBeLessThan(1);
      expect(h * scale - height).toBeLessThan(1);
    }
  });

  it('rejects empty, negative and non-finite input', () => {
    expect(() => cropSize(0, 100, 12e6)).toThrow(RangeError);
    expect(() => cropSize(100, -1, 12e6)).toThrow(RangeError);
    expect(() => cropSize(Number.NaN, 100, 12e6)).toThrow(RangeError);
    expect(() => cropSize(100, Number.POSITIVE_INFINITY, 12e6)).toThrow(RangeError);
    expect(() => cropSize(100, 100, 0)).toThrow(RangeError);
    expect(() => cropSize(100, 100, Number.NaN)).toThrow(RangeError);
  });
});

describe('budgetLadder', () => {
  it('halves the phone budget down to exactly MIN_BUDGET', () => {
    expect(budgetLadder(12e6)).toEqual([12e6, 6e6, 3e6, 2e6]);
  });

  it('halves the desktop budget down to exactly MIN_BUDGET', () => {
    expect(budgetLadder(32e6)).toEqual([32e6, 16e6, 8e6, 4e6, 2e6]);
  });

  it('tries a crash retry already at or below MIN_BUDGET once', () => {
    expect(budgetLadder(MIN_BUDGET)).toEqual([MIN_BUDGET]);
    expect(budgetLadder(1e6)).toEqual([1e6]);
  });
});
