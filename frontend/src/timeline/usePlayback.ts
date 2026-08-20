/**
 * Playback engine. Frame-index-driven (never wall-clock): the plan is the
 * sorted union of active layers' frame times from the playhead to the domain
 * end; each step's delay is proportional to the model-time gap it covers
 * (1000/speed ms per model-hour, floor 120 ms).
 *
 * Spread renders CONTINUOUSLY client-side from archive data (no frame
 * gating, no prefetching — the spread layer decodes and paints itself; its
 * hourly ticks only pace playback). Weather frames don't gate either — the
 * A/B crossfade masks image loading.
 */
import { useEffect, useMemo } from 'react';
import { useStore } from '../state/store';
import {
  latestRun,
  latestWeatherRun,
  useFire,
  useMasterCatalog,
  usePyrecastRuns,
  useWeatherRuns,
} from '../api/queries';
import { setSpreadArchiveBase } from '../api/wmsUrls';
import { buildFrameTimes } from './framePlan';

const MIN_STEP_MS = 120;

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

  // v2 catalogs carry the public archive origin — remember it so the spread
  // URL resolvers join the runs' relative templates correctly.
  useEffect(() => {
    setSpreadArchiveBase(pyrecastRuns?.archive_base);
  }, [pyrecastRuns]);

  const fireSlug =
    catalog?.fires.find((f) => f.cornea_id === corneaId)?.fire_slug ??
    selectedFire?.unique_slug ??
    null;

  const spreadRun = useMemo(() => latestRun(pyrecastRuns, fireSlug), [pyrecastRuns, fireSlug]);
  const weatherRun = useMemo(() => latestWeatherRun(weatherRuns), [weatherRuns]);

  const spreadActive = view.mode === 'fire' && spread.visible && !!spreadRun;

  /** Sorted key of visible weather products — a cheap restart trigger. */
  const weatherKey = Object.entries(weather)
    .filter(([, st]) => st?.visible)
    .map(([k]) => k)
    .sort()
    .join(',');
  const weatherActive = weatherKey !== '' && !!weatherRun;

  // ---- Playback loop -------------------------------------------------------
  // Restarts (re-plans from the current playhead) on play/pause, speed change,
  // run rotation, or layer visibility changes.
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
      actions.setStepMs(delayMs);
      timer = setTimeout(() => advance(next), delayMs);
    };

    advance(0);

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [
    playing,
    speed,
    domainEnd,
    spreadActive,
    spreadRun,
    weatherActive,
    weatherRun,
    weatherKey,
    actions,
  ]);
}
