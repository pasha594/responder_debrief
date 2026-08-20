/**
 * Path-based routes (no '#'):
 *   {base}              → fire directory
 *   {base}fire/{id}     → single-fire map shell
 *   {base}health        → ingestion observability
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
  const m = /^fire\/(.+)$/.exec(p);
  if (m) return { name: 'fire', id: safeDecode(m[1]) };
  return { name: 'directory' };
}

export function routePath(route: Route): string {
  if (route.name === 'health') return `${BASE}health`;
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
    const onChange = () => setRoute(parseLocation());
    window.addEventListener('popstate', onChange);
    window.addEventListener(NAV_EVENT, onChange);
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
