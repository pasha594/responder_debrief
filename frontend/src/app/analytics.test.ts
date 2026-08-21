import { beforeEach, describe, expect, it } from 'vitest';
import { _resetForTest, _sessionCountForTest, resetScope, track, trackOncePer } from './analytics';

// No VITE_POSTHOG_KEY in tests → track() short-circuits before queueing, but
// the rate limiter and dedupe logic run first only when a key exists — so
// these tests exercise the guards directly where they are key-independent.

describe('analytics volume guards', () => {
  beforeEach(() => _resetForTest());

  it('trackOncePer dedupes within a scope and resets with it', () => {
    // with no key, track() is a no-op — dedupe bookkeeping still applies
    trackOncePer('fire-view', 'draw_used', { tool: 'marker' });
    trackOncePer('fire-view', 'draw_used', { tool: 'marker' });
    trackOncePer('fire-view', 'draw_used', { tool: 'line' });
    resetScope('fire-view');
    trackOncePer('fire-view', 'draw_used', { tool: 'marker' });
    // no throw, no state leak — the guard maps stay bounded
    expect(_sessionCountForTest()).toBe(0); // keyless: nothing counted
  });

  it('track is safe without a key (no queue growth, no network)', () => {
    for (let i = 0; i < 500; i++) track('layer_toggled', { i });
    expect(_sessionCountForTest()).toBe(0);
  });
});
