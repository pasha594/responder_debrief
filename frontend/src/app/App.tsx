/**
 * App shell. Three path routes (see router.ts):
 *   {base}          → the fire directory (no map is mounted)
 *   {base}fire/{id} → the full-screen map shell, scoped to that one fire
 *   {base}health    → ingestion observability
 */
import { useEffect, useRef } from 'react';
import { MapRoot } from '../map/MapRoot';
import { useMapLayerSync } from '../map/useMapLayerSync';
import { useStore } from '../state/store';
import { Sidebar } from '../panels/Sidebar';
import { BackControl } from '../panels/BackControl';
import { BasemapControl } from '../panels/BasemapControl';
import { HealthView } from '../panels/HealthView';
import { Timeline } from '../timeline/Timeline';
import { LegendBar } from '../panels/LegendBar';
import { ErrorBoundary } from '../utils/ErrorBoundary';
import { useTimelineDomain } from '../timeline/useTimelineDomain';
import { DirectoryView } from '../directory/DirectoryView';
import { navNotify, parseLocation, routePath, sameRoute, useRoute, type Route } from './router';
import { applyViewState, buildSearch, decodeSearch } from './urlState';

function MapLayerBridge() {
  useMapLayerSync();
  useTimelineDomain();
  return null;
}

/**
 * Two-way sync between the URL path and store.view. (Legacy '#/…' links are
 * rewritten to their path form by App — it must also cover the health route,
 * where PathSync never mounts.)
 */
function PathSync() {
  const view = useStore((s) => s.view);
  const actions = useStore((s) => s.actions);

  // URL → store (also runs once on mount for deep links)
  useEffect(() => {
    const apply = () => {
      const route = parseLocation();
      const cur = useStore.getState().view;
      if (route.name === 'fire' && (cur.mode !== 'fire' || cur.corneaId !== route.id)) {
        actions.selectFire(route.id);
      } else if (route.name === 'directory' && cur.mode !== 'directory') {
        actions.backToDirectory();
      }
      // 'health' renders over whatever store mode is current — no store change.
    };
    apply();
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, [actions]);

  // store → URL (row clicks, map pin clicks, back button)
  //
  // Read the view FRESH from the store here, never from the render closure:
  // on a cold deep-link load (and again on StrictMode's dev double-mount)
  // this effect fires while the closure still holds the initial directory
  // view — acting on that would push the directory path over the deep link,
  // stripping the shared ?query. The URL → store effect above always runs
  // first and zustand updates synchronously, so getState() is truthful.
  useEffect(() => {
    const cur = parseLocation();
    if (cur.name === 'health') return; // the health page owns the URL
    const v = useStore.getState().view;
    const want: Route =
      v.mode === 'fire' ? { name: 'fire', id: v.corneaId } : { name: 'directory' };
    if (!sameRoute(cur, want)) {
      // Route changes drop the query — view state is per-fire.
      history.pushState(null, '', routePath(want));
      navNotify();
    }
  }, [view]);

  return null;
}

/**
 * Shareable view state ⇄ query string (fire mode only — mounted inside
 * FireMapView). On mount the query is decoded into the store; afterwards the
 * relevant slices are debounced back into the URL via replaceState, so the
 * address bar always reproduces the current view.
 */
function UrlStateSync() {
  const actions = useStore((s) => s.actions);

  // A shared playhead may point outside the initial timeline domain (the
  // real domain arrives with catalog data). Keep re-applying until it fits.
  const pendingT = useRef<number | null>(null);

  useEffect(() => {
    pendingT.current = applyViewState(
      decodeSearch(window.location.search), useStore.getState(), actions);
    const expiry = setTimeout(() => { pendingT.current = null; }, 30_000);

    let last = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const write = (delay: number) => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        // Hold while a shared playhead waits for the real domain — writing
        // now would strip its t param before it ever applied.
        if (pendingT.current != null) return;
        const st = useStore.getState();
        if (st.view.mode !== 'fire') return;
        const search = buildSearch(st);
        if (search === last) return;
        last = search;
        history.replaceState(null, '', routePath({ name: 'fire', id: st.view.corneaId }) + search);
      }, delay);
    };

    let prevTime = useStore.getState().time.currentTime;
    const unsub = useStore.subscribe((s) => {
      if (pendingT.current != null) {
        const [d0, d1] = s.time.domain;
        if (pendingT.current >= d0 && pendingT.current <= d1) {
          const t = pendingT.current;
          pendingT.current = null;
          if (Math.abs(s.time.currentTime - t) > 1000) actions.setTime(t);
        } else if (s.time.playing || s.time.currentTime !== prevTime) {
          // The user moved the playhead (or hit play) first — their intent
          // wins over the shared link's.
          pendingT.current = null;
        }
      }
      prevTime = s.time.currentTime;
      write(1000);
    });
    // Carried-over state (weather picks, basemap) should reach the URL right
    // away, not only after the next store change.
    write(50);
    return () => {
      clearTimeout(expiry);
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [actions]);

  return null;
}

function Toast() {
  const toast = useStore((s) => s.ui.toast);
  if (!toast) return null;
  return <div className="rd-toast">{toast}</div>;
}

function NowSampler() {
  const sampleNow = useStore((s) => s.actions.sampleNow);
  useEffect(() => {
    const id = setInterval(sampleNow, 60_000);
    return () => clearInterval(id);
  }, [sampleNow]);
  return null;
}

/**
 * Single-fire map shell. Mounted only in fire mode: entering the directory
 * unmounts MapRoot, which disposes the maplibre instance and every layer
 * manager, so a repeat entry starts from a clean map.
 */
function FireMapView() {
  return (
    <MapRoot>
      <MapLayerBridge />
      <UrlStateSync />
      <BackControl />
      <BasemapControl />
      <ErrorBoundary label="Fire panel">
        <Sidebar />
      </ErrorBoundary>
      <ErrorBoundary label="Legend">
        <LegendBar />
      </ErrorBoundary>
      <ErrorBoundary label="Timeline">
        <Timeline />
      </ErrorBoundary>
    </MapRoot>
  );
}

export function App() {
  const mode = useStore((s) => s.view.mode);
  const route = useRoute();

  // Legacy '#/…' links rewrite to the path form here — above the health
  // early-return, because PathSync never mounts on the health route.
  useEffect(() => {
    if (window.location.hash.startsWith('#/')) {
      history.replaceState(null, '', routePath(parseLocation()));
      navNotify();
    }
  }, []);

  if (route.name === 'health') {
    return (
      <div className="rd-app">
        <HealthView />
      </div>
    );
  }
  return (
    <div className="rd-app">
      <PathSync />
      <NowSampler />
      {mode === 'fire' ? (
        <FireMapView />
      ) : (
        <ErrorBoundary label="Fire directory">
          <DirectoryView />
        </ErrorBoundary>
      )}
      <Toast />
    </div>
  );
}
