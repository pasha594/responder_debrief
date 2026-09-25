/**
 * Path-based routes (no '#'):
 *   {base}              → fire directory
 *   {base}fire/{id}     → single-fire map shell
 *   {base}health        → ingestion observability
 *   {base}sources       → upstream data sources
 *   {base}release_notes → what shipped each day ('release-notes' also works)
 *   {base}s#<digits>    → a QR share code opened as a link (share/transport.ts)
 *
 * GitHub Pages has no server-side rewrites, so deep links are served by the
 * 404.html-copy-of-index.html trick (see deploy-pages.yml). Legacy '#/fire/…'
 * and '#/health' links people have already shared still resolve: the hash is
 * read first and immediately rewritten to the path form.
 */
import { useEffect, useState } from 'react';

const BASE = import.meta.env.BASE_URL; // '/' in dev, '/responder_debrief/' on Pages

export type Route =
  | { name: 'directory' }
  | { name: 'health' }
  | { name: 'sources' }
  | { name: 'release_notes' }
  | { name: 'share' }
  | { name: 'fire'; id: string };

/** decodeURIComponent that survives malformed %-encoding (truncated links
 * happen in the wild — a URIError here would white-screen the app, since
 * parseLocation runs during render via useRoute). */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseLocation(
  pathname: string = window.location.pathname,
  hash: string = window.location.hash,
): Route {
  const hm = /^#\/fire\/(.+)$/.exec(hash);
  if (hm) return { name: 'fire', id: safeDecode(hm[1]) };
  if (hash === '#/health') return { name: 'health' };

  let p = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\//, '');
  p = p.replace(/\/+$/, '');
  if (p === 'health') return { name: 'health' };
  if (p === 'sources') return { name: 'sources' };
  if (p === 'release_notes' || p === 'release-notes') return { name: 'release_notes' };
  if (p === 's') return { name: 'share' };
  const m = /^fire\/(.+)$/.exec(p);
  if (m) return { name: 'fire', id: safeDecode(m[1]) };
  return { name: 'directory' };
}

export function routePath(route: Route): string {
  if (route.name === 'health') return `${BASE}health`;
  if (route.name === 'sources') return `${BASE}sources`;
  if (route.name === 'release_notes') return `${BASE}release_notes`;
  if (route.name === 'share') return `${BASE}s`;
  if (route.name === 'fire') return `${BASE}fire/${encodeURIComponent(route.id)}`;
  return BASE;
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.name === b.name && (a.name !== 'fire' || a.id === (b as { id: string }).id);
}

/** Fired after PathSync pushes/replaces history so useRoute() re-parses. */
export const NAV_EVENT = 'rd-nav';

export function navNotify(): void {
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** Live current route — popstate (back/forward) + in-app navigations. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseLocation());
  useEffect(() => {
    // Pageviews are the PostHog SDK's own history autocapture (path changes
    // only), see app/analytics.ts.
    const onChange = () => {
      setRoute(parseLocation());
    };
    window.addEventListener('popstate', onChange);
    window.addEventListener(NAV_EVENT, onChange);
    // A child's mount effect runs before this one and may already have
    // navigated (the /s share landing does) — catch up on it once.
    setRoute((prev) => {
      const next = parseLocation();
      return sameRoute(prev, next) ? prev : next;
    });
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener(NAV_EVENT, onChange);
    };
  }, []);
  return route;
}

/** Href helpers for plain anchors (full page loads are fine for these). */
export const HREF_DIRECTORY = BASE;
export const HREF_HEALTH = `${BASE}health`;
export const HREF_SOURCES = `${BASE}sources`;
export const HREF_RELEASE_NOTES = `${BASE}release_notes`;
