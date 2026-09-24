import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _pageLoadCountForTest,
  _resetForTest,
  resetScope,
  track,
  trackOncePer,
} from './analytics';

const sdk = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn() }));
vi.mock('posthog-js', () => ({ default: sdk }));

// No VITE_POSTHOG_KEY in tests by default → track() short-circuits, so the
// keyless tests exercise the guards' bookkeeping directly.
describe('analytics without a key', () => {
  beforeEach(() => _resetForTest());

  it('trackOncePer dedupes within a scope and resets with it', () => {
    trackOncePer('fire-view', 'draw_used', { tool: 'marker' });
    trackOncePer('fire-view', 'draw_used', { tool: 'marker' });
    trackOncePer('fire-view', 'draw_used', { tool: 'line' });
    resetScope('fire-view');
    trackOncePer('fire-view', 'draw_used', { tool: 'marker' });
    expect(_pageLoadCountForTest()).toBe(0); // keyless: nothing counted
  });

  it('track is safe without a key (no queue growth, no network)', () => {
    for (let i = 0; i < 500; i++) track('layer_toggled', { i });
    expect(_pageLoadCountForTest()).toBe(0);
    expect(sdk.init).not.toHaveBeenCalled();
  });
});

describe('analytics with a key', () => {
  async function freshModule() {
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    vi.resetModules();
    return import('./analytics');
  }

  beforeEach(() => {
    sdk.init.mockReset();
    sdk.capture.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('queues events until the SDK loads, then replays them in order', async () => {
    const a = await freshModule();
    a.track('layer_toggled', { layer: 'hotspots', on: false });
    a.track('basemap_changed', { basemap: 'topo' });
    expect(sdk.capture).not.toHaveBeenCalled();
    expect(a._pendingCountForTest()).toBe(2);

    await a._loadForTest();

    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({ persistence: 'localStorage', defaults: a.POSTHOG_DEFAULTS }),
    );
    expect(sdk.capture.mock.calls).toEqual([
      ['layer_toggled', { layer: 'hotspots', on: false }],
      ['basemap_changed', { basemap: 'topo' }],
    ]);
    expect(a._pendingCountForTest()).toBe(0);

    // After load, events go straight to the SDK.
    a.track('theme_changed', { theme: 'light' });
    expect(sdk.capture).toHaveBeenLastCalledWith('theme_changed', { theme: 'light' });
  });

  it('initializes once however often load is requested', async () => {
    const a = await freshModule();
    await Promise.all([a._loadForTest(), a._loadForTest(), a._loadForTest()]);
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it('still rate-limits explicit events', async () => {
    const a = await freshModule();
    await a._loadForTest();
    for (let i = 0; i < 100; i++) a.track('layer_toggled', { i });
    expect(sdk.capture).toHaveBeenCalledTimes(30); // MAX_PER_MINUTE
  });

  it('bounds the pre-load queue', async () => {
    const a = await freshModule();
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let m = 0; m < 5; m++) {
      // spread across simulated minutes so the rate limiter isn't what caps it
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 24, 12, m * 2)));
      for (let i = 0; i < 30; i++) a.track('layer_toggled', { m, i });
    }
    vi.useRealTimers();
    expect(a._pendingCountForTest()).toBe(100); // MAX_PENDING
  });
});
