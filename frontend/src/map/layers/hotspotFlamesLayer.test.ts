import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MlMap } from 'maplibre-gl';
import type { HotspotFeatureCollection } from '../../api/types';
import type { LayerContext } from '../layerTypes';
import {
  FLAME_MAX_AGE_MS,
  FLAME_SETTLE_MS,
  FLAME_SLACK_MS,
  buildFlameIndex,
  hotspotFlamesLayer,
  planFlames,
  timeSlice,
} from './hotspotFlamesLayer';

// The real layer needs WebGL; this stand-in records what the adapter asks of it.
const flames = vi.hoisted(() => {
  class FakeFireLayer {
    static last: FakeFireLayer | null = null;
    readonly type = 'custom';
    readonly id: string;
    paused = false;
    resumes = 0;
    constructor(o: { id: string }) {
      this.id = o.id;
      FakeFireLayer.last = this;
    }
    pause() {
      this.paused = true;
      return this;
    }
    resume() {
      this.paused = false;
      this.resumes += 1;
      return this;
    }
    setHotspots() {
      return this;
    }
    setTimeRange() {
      return this;
    }
  }
  return { FakeFireLayer };
});
vi.mock('../vendor/fire-layer/fire-layer.js', () => ({ FireLayer: flames.FakeFireLayer }));

const H = 3_600_000;
const T0 = Date.parse('2026-09-18T12:00:00Z');

function fc(times: (number | null | undefined)[]): HotspotFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: times.map((acq_ts, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-120 + i * 0.01, 48] },
      properties: { acq_ts, frp: 10 },
    })),
  } as unknown as HotspotFeatureCollection;
}

describe('buildFlameIndex', () => {
  it('sorts oldest first and drops detections with no usable time', () => {
    const input = fc([T0, null, T0 - 5 * H, undefined, 0, T0 - 2 * H]);
    const before = input.features.map((f) => f.properties.acq_ts);
    const idx = buildFlameIndex(input);
    expect([...idx.times]).toEqual([T0 - 5 * H, T0 - 2 * H, T0]);
    expect(idx.features.map((f) => f.properties.acq_ts)).toEqual([...idx.times]);
    // the query's own array is never reordered — the circles share it
    expect(input.features.map((f) => f.properties.acq_ts)).toEqual(before);
  });

  it('is empty for no data', () => {
    expect(buildFlameIndex(undefined).times.length).toBe(0);
  });
});

describe('timeSlice', () => {
  const times = Float64Array.from([10, 20, 20, 30, 40]);
  it('is inclusive at both ends', () => {
    expect(timeSlice(times, 20, 30)).toEqual([1, 4]);
    expect(timeSlice(times, 21, 29)).toEqual([3, 3]);
    expect(timeSlice(times, 0, 100)).toEqual([0, 5]);
    expect(timeSlice(times, 41, 100)).toEqual([5, 5]);
  });
});

describe('planFlames', () => {
  const times = buildFlameIndex(
    fc([T0 - 40 * H, T0 - 13 * H, T0 - 11 * H, T0 - 1 * H, T0 + 2 * H]),
  ).times;

  it('burns exactly the last 12 h before the playhead — the still-yellow ones', () => {
    const plan = planFlames(times, T0, null);
    expect(plan.burning).toEqual([T0 - FLAME_MAX_AGE_MS, T0]);
    expect(plan.count).toBe(2); // 11 h and 1 h old; 13 h is orange, +2 h has not happened
  });

  it('feeds the layer the window plus slack the first time', () => {
    const plan = planFlames(times, T0, null);
    expect(plan.refeed).toEqual([T0 - FLAME_MAX_AGE_MS - FLAME_SLACK_MS, T0 + FLAME_SLACK_MS]);
  });

  it('scrubbing inside the slack is a time-range change only, never a re-feed', () => {
    const loaded = planFlames(times, T0, null).refeed!;
    expect(planFlames(times, T0 + 6 * H, loaded).refeed).toBeNull();
    expect(planFlames(times, T0 - 12 * H, loaded).refeed).toBeNull();
    expect(planFlames(times, T0 + 12 * H, loaded).refeed).toBeNull();
  });

  it('re-feeds once the playhead leaves the slack, recentred on it', () => {
    const loaded = planFlames(times, T0, null).refeed!;
    const far = T0 + 13 * H;
    expect(planFlames(times, far, loaded).refeed).toEqual([
      far - FLAME_MAX_AGE_MS - FLAME_SLACK_MS,
      far + FLAME_SLACK_MS,
    ]);
  });

  it('counts nothing when the fire has gone quiet, so the layer can pause', () => {
    expect(planFlames(times, T0 + 30 * H, null).count).toBe(0);
    expect(planFlames(new Float64Array(0), T0, null).count).toBe(0);
  });
});

function fakeMap() {
  const handlers = new Map<string, Set<() => void>>();
  const layers = new Set<string>();
  return {
    on(ev: string, fn: () => void) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(fn);
    },
    off(ev: string, fn: () => void) {
      handlers.get(ev)?.delete(fn);
    },
    emit(ev: string) {
      for (const fn of handlers.get(ev) ?? []) fn();
    },
    listenerCount: (ev: string) => handlers.get(ev)?.size ?? 0,
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    addLayer: (l: { id: string }) => void layers.add(l.id),
    removeLayer: (id: string) => void layers.delete(id),
    isStyleLoaded: () => true,
    getStyle: () => ({ layers: [] }),
  };
}

function ctx(times: number[], now: number): LayerContext {
  return {
    layers: { hotspots: { visible: true } },
    hotspots: fc(times),
    currentTime: now,
    now,
  } as unknown as LayerContext;
}

describe('flames move only with the camera', () => {
  let fake: ReturnType<typeof fakeMap>;
  let map: MlMap;
  const layer = () => flames.FakeFireLayer.last!;

  beforeEach(() => {
    vi.useFakeTimers();
    fake = fakeMap();
    map = fake as unknown as MlMap;
    hotspotFlamesLayer.mount(map);
  });
  afterEach(() => {
    hotspotFlamesLayer.unmount(map);
    vi.useRealTimers();
  });

  it('holds burning flames still while the map is at rest', () => {
    hotspotFlamesLayer.update(map, ctx([T0 - H], T0));
    expect(layer().paused).toBe(true);
    expect(layer().resumes).toBe(0);
  });

  it('animates while the camera moves, then settles after FLAME_SETTLE_MS', () => {
    hotspotFlamesLayer.update(map, ctx([T0 - H], T0));
    fake.emit('move');
    expect(layer().paused).toBe(false);
    vi.advanceTimersByTime(FLAME_SETTLE_MS - 1);
    fake.emit('move'); // still panning: the deadline moves back
    vi.advanceTimersByTime(FLAME_SETTLE_MS - 1);
    expect(layer().paused).toBe(false);
    vi.advanceTimersByTime(1);
    expect(layer().paused).toBe(true);
    expect(layer().resumes).toBe(1); // one resume per burst of movement, not per frame
  });

  it('starts moving when flames arrive mid-pan', () => {
    fake.emit('move');
    expect(layer().paused).toBe(true); // nothing burning yet
    hotspotFlamesLayer.update(map, ctx([T0 - H], T0));
    expect(layer().paused).toBe(false);
    vi.advanceTimersByTime(FLAME_SETTLE_MS);
    expect(layer().paused).toBe(true);
  });

  it('stays still on camera moves when nothing is burning', () => {
    hotspotFlamesLayer.update(map, ctx([T0 - 30 * H], T0));
    fake.emit('move');
    expect(layer().paused).toBe(true);
    expect(layer().resumes).toBe(0);
  });

  it('unmount drops the move listener and the pending settle', () => {
    hotspotFlamesLayer.update(map, ctx([T0 - H], T0));
    fake.emit('move');
    hotspotFlamesLayer.unmount(map);
    expect(fake.listenerCount('move')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
