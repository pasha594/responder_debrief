/**
 * PostHog, through its official browser SDK, loaded late so it never
 * competes with the first paint: the SDK is dynamically imported once the
 * page has loaded and the browser goes idle. Calls made before then queue in
 * memory and replay on init.
 *
 * The SDK brings sessions, pageviews on PATH changes (the share-state sync's
 * query-string rewrites never count — see its history autocapture), page
 * leave, device and referrer properties, click autocapture, and session
 * replay (recording also needs replay switched on in the PostHog project).
 *
 * Our explicit events keep their names and call sites. Two backstops from the
 * hand-rolled client still guard them — a noisy call site can't flood:
 *   - rate limiter: at most MAX_PER_MINUTE explicit events a minute and
 *     MAX_PER_PAGE_LOAD per page load, beyond which they are dropped;
 *   - per-view dedupe: `trackOncePer(scope, ...)` logs an action once per
 *     scope (e.g. once per fire view), for anything a user repeats rapidly.
 *
 * Disabled entirely without a key (dev builds log to console.debug instead).
 */
import type { PostHog } from 'posthog-js';

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';

/** PostHog's dated behavior snapshot: pins SDK defaults until we opt into a
 * newer one. Among others it sets pageview capture to 'history_change'. */
export const POSTHOG_DEFAULTS = '2026-08-30';

const MAX_PER_MINUTE = 30;
const MAX_PER_PAGE_LOAD = 300;
/** Pre-load queue bound: the SDK normally arrives within seconds. */
const MAX_PENDING = 100;
/** Fallback delay where requestIdleCallback is missing (Safari). */
const IDLE_FALLBACK_MS = 1500;
const IDLE_TIMEOUT_MS = 3000;

let client: PostHog | null = null;
let pending: [string, Record<string, unknown>][] = [];
let loading: Promise<void> | null = null;
let pageLoadCount = 0;
let minuteCount = 0;
let minuteStart = 0;
const oncePerScope = new Map<string, Set<string>>();

function allowed(): boolean {
  if (pageLoadCount >= MAX_PER_PAGE_LOAD) return false;
  const now = Date.now();
  if (now - minuteStart > 60_000) {
    minuteStart = now;
    minuteCount = 0;
  }
  if (minuteCount >= MAX_PER_MINUTE) return false;
  minuteCount += 1;
  pageLoadCount += 1;
  return true;
}

/** One discrete user action. Silently dropped beyond the rate limits. */
export function track(event: string, properties: Record<string, unknown> = {}): void {
  if (!KEY) {
    if (import.meta.env.DEV) console.debug('[analytics]', event, properties);
    return;
  }
  if (!allowed()) return;
  if (client) client.capture(event, properties);
  else if (pending.length < MAX_PENDING) pending.push([event, properties]);
}

/** Once per (scope, event+detail) — for actions a user repeats rapidly.
 * Reset the scope when its context ends (e.g. leaving a fire). */
export function trackOncePer(
  scope: string,
  event: string,
  properties: Record<string, unknown> = {},
): void {
  const key = `${event}|${JSON.stringify(properties)}`;
  let seen = oncePerScope.get(scope);
  if (!seen) {
    seen = new Set();
    oncePerScope.set(scope, seen);
  }
  if (seen.has(key)) return;
  seen.add(key);
  track(event, properties);
}

export function resetScope(scope: string): void {
  oncePerScope.delete(scope);
}

function load(): Promise<void> {
  if (!KEY) return Promise.resolve();
  loading ??= (async () => {
    try {
      const { default: posthog } = await import('posthog-js');
      posthog.init(KEY, {
        api_host: HOST,
        defaults: POSTHOG_DEFAULTS,
        // localStorage only: no cookies, as before the SDK.
        persistence: 'localStorage',
      });
      client = posthog;
      // Queued events replay WITHOUT their original timestamps on purpose:
      // they predate the session the SDK just started, and PostHog drops
      // events that are older than their session's id from session stats.
      const queued = pending;
      pending = [];
      for (const [event, properties] of queued) posthog.capture(event, properties);
      try {
        localStorage.removeItem('rd_did'); // the hand-rolled client's device id
      } catch {
        /* storage blocked */
      }
    } catch {
      // Blocked by an extension, or offline before the chunk was ever cached.
      // Analytics is best-effort: allow one retry when connectivity returns.
      loading = null;
      if (typeof window !== 'undefined') {
        window.addEventListener('online', () => void load(), { once: true });
      }
    }
  })();
  return loading;
}

/** Load the SDK once the page has loaded and the browser is idle. */
export function startAnalytics(): void {
  if (!KEY || typeof window === 'undefined') return;
  const whenIdle = () => {
    const ric = (window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (ric) ric(() => void load(), { timeout: IDLE_TIMEOUT_MS });
    else setTimeout(() => void load(), IDLE_FALLBACK_MS);
  };
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });
}

/** Test seams. */
export function _resetForTest(): void {
  client = null;
  pending = [];
  loading = null;
  pageLoadCount = 0;
  minuteCount = 0;
  minuteStart = 0;
  oncePerScope.clear();
}
export function _pageLoadCountForTest(): number {
  return pageLoadCount;
}
export function _pendingCountForTest(): number {
  return pending.length;
}
export const _loadForTest = load;
