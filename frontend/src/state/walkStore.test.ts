import { describe, expect, it } from 'vitest';

// Same node stubs as drawStore.test.ts: the store touches document at load.
(globalThis as { document?: unknown }).document ??= {
  documentElement: { dataset: {} },
};
(globalThis as { window?: unknown }).window ??= globalThis;
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { useStore } = await import('./store');

describe('trails / vegetation / Walk slices', () => {
  it('defaults: trails auto, vegetation off, perimeter avoidance on', () => {
    const s = useStore.getState();
    expect(s.layers.trails.mode).toBe('auto');
    expect(s.layers.vegetation).toEqual({ visible: false, opacity: 0.55 });
    expect(s.directions.avoidPerimeter).toBe(true);
  });

  it('trails + vegetation persist across fires; avoidPerimeter survives resets', () => {
    const a = useStore.getState().actions;
    a.setTrailsMode('on');
    a.setVegetation({ visible: true });
    a.setVegetation({ opacity: 0.8 });
    a.setAvoidPerimeter(false);
    a.selectFire('{FIRE-2}');
    let s = useStore.getState();
    expect(s.layers.trails.mode).toBe('on');
    expect(s.layers.vegetation).toEqual({ visible: true, opacity: 0.8 });
    expect(s.directions.avoidPerimeter).toBe(false);
    a.clearDirections();
    s = useStore.getState();
    expect(s.directions.avoidPerimeter).toBe(false);
    expect('picking' in s.directions).toBe(false);
  });

  it('toggling avoidance drops the drawn route so Walk recomputes', () => {
    const a = useStore.getState().actions;
    a.setDirectionsRoute({
      geometry: { type: 'LineString', coordinates: [] }, distanceM: 0, durationS: 0,
      trafficDelayS: null, steps: [], engine: 'offroad',
    });
    a.setAvoidPerimeter(true);
    expect(useStore.getState().directions.route).toBeNull();
  });
});
