/**
 * Playback engine + prefetch warming. Frame-index-driven (never wall-clock):
 * the plan is the sorted union of active layers' frame times from the
 * playhead to the domain end; each step's delay is proportional to the
 * model-time gap it covers (1000/speed ms per model-hour, floor 120 ms).
 *
 * Spread frames gate on the prefetcher (single-image swaps must be atomic);
 * weather tiles do NOT gate — the A/B crossfade masks tile loading.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../state/store';
import {
  latestRun,
  latestWeatherRun,
  useFire,
  useInvalidateForecasts,
  useMasterCatalog,
  usePyrecastRuns,
  useWeatherRuns,
} from '../api/queries';
import { spreadFrameUrl } from '../api/wmsUrls';
import { buildFrameTimes, resolveSpreadFrame } from './framePlan';
import { framePrefetcher } from './prefetch';

const MIN_STEP_MS = 120;
const ERROR_TOAST_THROTTLE_MS = 30_000;

export function usePlayback(): void {
  const view = useStore((s) => s.view);
  const playing = useStore((s) => s.time.playing);
  const speed = useStore((s) => s.time.speed);
  const domainEnd = useStore((s) => s.time.domain[1]);
  const spread = useStore((s) => s.layers.spread);
  const weather = useStore((s) => s.layers.weather);
  const actions = useStore((s) => s.actions);

  const corneaId = view.mode === 'fire' ? view.corneaId : null;
  const { data: selectedFire } = useFire(corneaId);
  const { data: catalog } = useMasterCatalog();
  const { data: pyrecastRuns } = usePyrecastRuns();
  const { data: weatherRuns } = useWeatherRuns();
  const invalidateForecasts = useInvalidateForecasts();

  const fireSlug =
    catalog?.fires.find((f) => f.cornea_id === corneaId)?.fire_slug ??
    selectedFire?.unique_slug ??
    null;

  const spreadRun = useMemo(() => latestRun(pyrecastRuns, fireSlug), [pyrecastRuns, fireSlug]);
  const weatherRun = useMemo(() => latestWeatherRun(weatherRuns), [weatherRuns]);

  const product = spread.product;
  const percentile = spread.percentile;
  const spreadTimed = !!spreadRun?.products[product]?.timed;
  const spreadActive = view.mode === 'fire' && spread.visible && !!spreadRun && spreadTimed;

  /** Sorted key of visible weather products — a cheap restart trigger. */
  const weatherKey = Object.entries(weather)
    .filter(([, st]) => st?.visible)
    .map(([k]) => k)
    .sort()
    .join(',');
  const weatherActive = weatherKey !== '' && !!weatherRun;

  // ---- Frame-error handling: invalidate catalogs + toast, throttled 30 s ----
  const errorCtxRef = useRef({ invalidateForecasts, showToast: actions.showToast });
  errorCtxRef.current = { invalidateForecasts, showToast: actions.showToast };
  useEffect(() => {
    let lastNotified = 0;
    framePrefetcher.onError = () => {
      const t = Date.now();
      if (t - lastNotified < ERROR_TOAST_THROTTLE_MS) return;
      lastNotified = t;
      errorCtxRef.current.invalidateForecasts();
      errorCtxRef.current.showToast('Forecast updated to a newer run — reloading');
    };
    return () => {
      framePrefetcher.onError = null;
    };
  }, []);

  // ---- Prefetch warming: on product/percentile/run change, even paused -----
  // Priority: playhead-forward, then backward (warm scrubbing both ways).
  useEffect(() => {
    if (!spreadActive || !spreadRun) return;
    const t = useStore.getState().time.currentTime;
    const instants = spreadRun.time_instants.map((s) => ({ s, ts: Date.parse(s) }));
    const forward = instants.filter((p) => p.ts >= t);
    const backward = instants.filter((p) => p.ts < t).reverse();
    const urls = [...forward, ...backward].map((p) =>
      spreadFrameUrl(spreadRun, product, percentile, p.s),
    );
    framePrefetcher.enqueue(urls);
  }, [spreadActive, spreadRun, product, percentile]);

  // ---- Playback loop -------------------------------------------------------
  // Restarts (re-plans from the current playhead) on play/pause, speed change,
  // product/percentile change, run rotation, or layer visibility changes.
  useEffect(() => {
    if (!playing) return;

    const from = useStore.getState().time.currentTime;
    const frameTimes = buildFrameTimes({
      spreadRun,
      spreadActive,
      weatherRun,
      weatherActive,
      from,
      to: domainEnd,
    });
    if (frameTimes.length === 0) {
      actions.pause();
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubLoaded: (() => void) | null = null;
    let unsubError: (() => void) | null = null;

    const urlForTime = (t: number): string | null => {
      if (!spreadActive || !spreadRun) return null;
      const frame = resolveSpreadFrame(spreadRun, t);
      return frame ? spreadFrameUrl(spreadRun, product, percentile, frame.instant) : null;
    };

    const cleanupWait = () => {
      unsubLoaded?.();
      unsubLoaded = null;
      unsubError?.();
      unsubError = null;
    };

    const advance = (index: number) => {
      if (cancelled) return;
      const t = frameTimes[index];
      actions.setTime(t);
      const next = index + 1;
      if (next >= frameTimes.length) {
        actions.pause(); // domain end reached
        return;
      }
      const gapHours = (frameTimes[next] - t) / 3600_000;
      const delayMs = Math.max(MIN_STEP_MS, (gapHours * 1000) / speed);
      timer = setTimeout(() => step(next), delayMs);
    };

    const step = (index: number) => {
      if (cancelled) return;
      const url = urlForTime(frameTimes[index]);
      if (url && !framePrefetcher.has(url)) {
        // Gate: buffer until the frame is decoded. Re-prioritize the queue to
        // the remaining playback path so the awaited frame loads first.
        actions.setBuffering(true);
        const remaining: string[] = [];
        for (let i = index; i < frameTimes.length; i++) {
          const u = urlForTime(frameTimes[i]);
          if (u) remaining.push(u);
        }
        framePrefetcher.enqueue(remaining);
        const proceed = () => {
          cleanupWait();
          if (cancelled) return;
          actions.setBuffering(false);
          advance(index);
        };
        unsubLoaded = framePrefetcher.on('loaded', (loaded) => {
          if (loaded === url) proceed();
        });
        // A failed frame (run rotated away) must not hang playback: advance
        // anyway; onError already kicked off catalog invalidation + toast.
        unsubError = framePrefetcher.on('error', (failed) => {
          if (failed === url) proceed();
        });
        return;
      }
      advance(index);
    };

    step(0);

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      cleanupWait();
      actions.setBuffering(false);
    };
  }, [
    playing,
    speed,
    domainEnd,
    spreadActive,
    spreadRun,
    product,
    percentile,
    weatherActive,
    weatherRun,
    weatherKey,
    actions,
  ]);
}
