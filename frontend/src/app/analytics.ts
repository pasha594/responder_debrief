/**
 * PostHog via its plain HTTP batch API — no SDK, no cookies, ~1 request per
 * 10 s of activity. Volume discipline is the design center: every event is a
 * DISCRETE user action from the explicit list below. Nothing continuous is
 * ever instrumented (scrubbing, playback ticks, pointer/camera moves, URL
 * writes), and two backstops guarantee usage can't run away even if a noisy
 * call site slips in later:
 *   - rate limiter: at most MAX_PER_MINUTE events/min, MAX_PER_SESSION/page
 *     load — beyond that events are silently dropped;
 *   - per-view dedupe: `trackOncePer(scope, ...)` logs an event once per
 *     scope (e.g. once per fire view), used for anything a user can repeat
 *     rapidly (draw strokes, play/pause).
 * Disabled entirely without a key (dev builds log to console.debug instead).
 */

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';

const MAX_PER_MINUTE = 30;
const MAX_PER_SESSION = 300;
const FLUSH_MS = 10_000;
const FLUSH_AT = 10;

interface QueuedEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let sessionCount = 0;
let minuteCount = 0;
let minuteStart = 0;
const oncePerScope = new Map<string, Set<string>>();

function distinctId(): string {
  try {
    let id = localStorage.getItem('rd_did');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('rd_did', id);
    }
    return id;
  } catch {
    return 'anon';
  }
}

function allowed(): boolean {
  if (sessionCount >= MAX_PER_SESSION) return false;
  const now = Date.now();
  if (now - minuteStart > 60_000) {
    minuteStart = now;
    minuteCount = 0;
  }
  if (minuteCount >= MAX_PER_MINUTE) return false;
  minuteCount += 1;
  sessionCount += 1;
  return true;
}

function send(body: string, beacon: boolean): void {
  const url = `${HOST}/batch/`;
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon(url, body);
    return;
  }
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

function flush(beacon = false): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!queue.length || !KEY) return;
  const body = JSON.stringify({ api_key: KEY, batch: queue });
  queue = [];
  send(body, beacon);
}

/** One discrete user action. Silently dropped beyond the rate limits. */
export function track(event: string, properties: Record<string, unknown> = {}): void {
  if (!KEY) {
    if (import.meta.env.DEV) console.debug('[analytics]', event, properties);
    return;
  }
  if (!allowed()) return;
  queue.push({
    event,
    properties: { distinct_id: distinctId(), ...properties },
    timestamp: new Date().toISOString(),
  });
  if (queue.length >= FLUSH_AT) flush();
  else if (!flushTimer) flushTimer = setTimeout(() => flush(), FLUSH_MS);
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

/** Pageview on PATH change only — search-param rewrites (share-state URL
 * sync) must never count. */
let lastPath: string | null = null;
export function trackPageview(): void {
  const path = window.location.pathname;
  if (path === lastPath) return;
  lastPath = path;
  track('$pageview', { $current_url: window.location.origin + path });
}

// Guarded for node test environments that stub a partial `window`.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
}

/** Test seam. */
export function _resetForTest(): void {
  queue = [];
  sessionCount = 0;
  minuteCount = 0;
  minuteStart = 0;
  lastPath = null;
  oncePerScope.clear();
}
export function _sessionCountForTest(): number {
  return sessionCount;
}
