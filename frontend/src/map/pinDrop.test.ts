import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clicksClaimed, createClickGate, pinClickAction, type PinClickFacts } from './pinDrop';
import type { AppState } from '../state/store';

const idle: PinClickFacts = {
  claimed: false,
  pinShown: false,
  onMarker: false,
  onFeature: false,
  popupOpen: false,
};

describe('pinClickAction', () => {
  it('drops a pin on a plain click of an idle map', () => {
    expect(pinClickAction(idle)).toBe('drop');
  });

  it('the next click anywhere only dismisses — even on a feature', () => {
    expect(pinClickAction({ ...idle, pinShown: true })).toBe('dismiss');
    expect(pinClickAction({ ...idle, pinShown: true, onFeature: true })).toBe('dismiss');
  });

  it('leaves feature clicks and popup-closing clicks alone', () => {
    expect(pinClickAction({ ...idle, onFeature: true })).toBe('none');
    expect(pinClickAction({ ...idle, popupOpen: true })).toBe('none');
  });

  it('never acts while a draw tool or directions own the click', () => {
    expect(pinClickAction({ ...idle, claimed: true })).toBe('none');
    expect(pinClickAction({ ...idle, claimed: true, pinShown: true })).toBe('none');
  });

  it('ignores clicks on markers, the pin itself included', () => {
    expect(pinClickAction({ ...idle, onMarker: true })).toBe('none');
    expect(pinClickAction({ ...idle, onMarker: true, pinShown: true })).toBe('none');
  });
});

describe('clicksClaimed', () => {
  const state = (
    tool: AppState['draw']['tool'],
    d: Partial<AppState['directions']> = {},
  ): Pick<AppState, 'draw' | 'directions'> => ({
    draw: { tool, features: [], past: [], future: [] },
    directions: { a: null, b: null, profile: 'drive', route: null, armed: false, ...d },
  });
  const pt = { coords: [-120, 40] as [number, number], label: 'x' };

  it('is free only with no tool armed and directions idle', () => {
    expect(clicksClaimed(state('none'))).toBe(false);
    expect(clicksClaimed(state('freehand'))).toBe(true);
    expect(clicksClaimed(state('marker:camp'))).toBe(true);
    expect(clicksClaimed(state('none', { armed: true }))).toBe(true);
    expect(clicksClaimed(state('none', { a: pt }))).toBe(true);
    expect(clicksClaimed(state('none', { b: pt }))).toBe(true);
  });
});

describe('createClickGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lands a single click once the double-click window passes', () => {
    const gate = createClickGate(300);
    const run = vi.fn();
    gate.click({ x: 10, y: 10 }, () => run);
    vi.advanceTimersByTime(299);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledOnce();
  });

  it('a double-click does nothing: the twin click cancels without deciding', () => {
    const gate = createClickGate(300);
    const run = vi.fn();
    const decide = vi.fn(() => run);
    gate.click({ x: 10, y: 10 }, decide);
    vi.advanceTimersByTime(120);
    gate.click({ x: 12, y: 11 }, decide);
    vi.advanceTimersByTime(1000);
    expect(decide).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it('a quick click elsewhere is its own click: the held one lands first', () => {
    const gate = createClickGate(300);
    const order: string[] = [];
    gate.click({ x: 10, y: 10 }, () => () => order.push('first'));
    vi.advanceTimersByTime(100);
    gate.click({ x: 200, y: 10 }, () => {
      order.push('decide second');
      return () => order.push('second');
    });
    expect(order).toEqual(['first', 'decide second']);
    vi.advanceTimersByTime(300);
    expect(order).toEqual(['first', 'decide second', 'second']);
  });

  it('the same spot after the window is a new click, not a twin', () => {
    const gate = createClickGate(300);
    const run = vi.fn();
    gate.click({ x: 10, y: 10 }, () => run);
    vi.advanceTimersByTime(400);
    gate.click({ x: 10, y: 10 }, () => run);
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancel drops the held effect', () => {
    const gate = createClickGate(300);
    const run = vi.fn();
    gate.click({ x: 10, y: 10 }, () => run);
    gate.cancel();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
  });

  it('a click with nothing to do holds nothing', () => {
    const gate = createClickGate(300);
    const run = vi.fn();
    gate.click({ x: 10, y: 10 }, () => null);
    gate.click({ x: 200, y: 10 }, () => run);
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledOnce();
  });
});
