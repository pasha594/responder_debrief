/** Recomputes the timeline domain when the view or its data changes. */
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
import { NATIONAL_PAST_MS } from '../app/config';
import { spreadCoverage } from './framePlan';

export function useTimelineDomain(): void {
  const view = useStore((s) => s.view);
  const now = useStore((s) => s.time.now);
  const setDomain = useStore((s) => s.actions.setDomain);

  const corneaId = view.mode === 'fire' ? view.corneaId : null;
  const { data: fire } = useFire(corneaId);
  const { data: catalog } = useMasterCatalog();
  const { data: pyrecastRuns } = usePyrecastRuns();
  const { data: weatherRuns } = useWeatherRuns();

  const fireSlug =
    catalog?.fires.find((f) => f.cornea_id === corneaId)?.fire_slug ??
    fire?.unique_slug ??
    null;

  const domain = useMemo<[number, number]>(() => {
    const weatherRun = latestWeatherRun(weatherRuns);
    const weatherEnd = weatherRun?.hours.length
      ? Date.parse(weatherRun.hours[weatherRun.hours.length - 1])
      : NaN;

    // Defensive: the hook only mounts inside the fire-mode map shell.
    if (view.mode !== 'fire') {
      const end = Number.isFinite(weatherEnd) ? weatherEnd : now + 48 * 3600_000;
      return [now - NATIONAL_PAST_MS, Math.max(end, now + 3600_000)];
    }

    const created = fire ? Date.parse(fire.created_on) : NaN;
    const start = Number.isFinite(created) ? created : now - NATIONAL_PAST_MS;
    const run = latestRun(pyrecastRuns, fireSlug);
    const cov = spreadCoverage(run);
    const spreadEnd = cov ? cov[1] : NaN;
    const end = Math.max(
      Number.isFinite(spreadEnd) ? spreadEnd : 0,
      Number.isFinite(weatherEnd) ? weatherEnd : 0,
      now + 3600_000,
    );
    return [start, end];
  }, [view.mode, fire, fireSlug, pyrecastRuns, weatherRuns, now]);

  useEffect(() => {
    setDomain(domain);
  }, [domain, setDomain]);
}
