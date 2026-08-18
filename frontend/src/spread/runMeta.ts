/**
 * Freshness of a spread run. A responder reading the Forecast tab has to be
 * able to tell "the model ran this morning" from "the model ran last Tuesday
 * and nobody has published since" — the two look identical once the forecast
 * is painted on the map, so the panel badges the second case.
 */
import type { PyrecastRun } from '../api/types';

/** Runs older than this are badged as stale (published cadence is ~hourly). */
export const STALE_RUN_HOURS = 24;

/** Hours between the run's start and now; null when run_time is unparseable. */
export function runAgeHours(run: PyrecastRun, nowMs: number = Date.now()): number | null {
  const t = Date.parse(run.run_time);
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 3.6e6;
}

/**
 * True when the newest available run is old enough to mislead. Future-dated
 * run times (clock skew) are never stale.
 */
export function isStaleRun(run: PyrecastRun, nowMs: number = Date.now()): boolean {
  const age = runAgeHours(run, nowMs);
  return age !== null && age >= STALE_RUN_HOURS;
}

/** Compact age for the stale badge: "26 h old" / "5 d old"; null when fresh. */
export function staleBadgeLabel(run: PyrecastRun, nowMs: number = Date.now()): string | null {
  const age = runAgeHours(run, nowMs);
  if (age === null || age < STALE_RUN_HOURS) return null;
  const days = age / 24;
  return days >= 2 ? `${Math.round(days)} d old` : `${Math.round(age)} h old`;
}
