/**
 * App shell. Two modes, one hash router:
 *   ''            → the fire directory (no map is mounted)
 *   '#/fire/{id}' → the full-screen map shell, scoped to that one fire
 */
import { useEffect, useRef, useState } from 'react';
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

function MapLayerBridge() {
  useMapLayerSync();
  useTimelineDomain();
  return null;
}

function parseHash(): string | null {
  const m = /^#\/fire\/(.+)$/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Two-way sync between the URL hash (#/fire/{corneaId}) and store.view; no
 * hash (or '#/') is the directory. Hash routing keeps GitHub Pages deploys
 * trivial (no 404 fallback needed) and costs no router dependency.
 */
function HashSync() {
  const view = useStore((s) => s.view);
  const actions = useStore((s) => s.actions);

  // hash → store (also runs once on mount for deep links)
  useEffect(() => {
    const apply = () => {
      const id = parseHash();
      const cur = useStore.getState().view;
      if (id && (cur.mode !== 'fire' || cur.corneaId !== id)) {
        actions.selectFire(id);
      } else if (!id && cur.mode !== 'directory') {
        actions.backToDirectory();
      }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [actions]);

  // store → hash (row clicks, map pin clicks, back button)
  //
  // Both effects run on mount, and this one sees the INITIAL view (directory)
  // in that first pass — so on a cold load of a #/fire/{id} deep link it used
  // to strip the hash before the hash → store effect could apply it, dumping
  // the visitor on the directory. Skip until the hash has been read once.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      if (parseHash()) return; // a deep link is being applied — do not clobber it
      if (window.location.hash === '#/health') return; // health page owns the hash
    }
    const want = view.mode === 'fire' ? `#/fire/${encodeURIComponent(view.corneaId)}` : '';
    const cur = window.location.hash;
    if (want && cur !== want) {
      window.location.hash = want;
    } else if (!want && cur && cur !== '#/') {
      // Clear without adding a history entry for the empty state.
      history.pushState(null, '', window.location.pathname + window.location.search);
    }
  }, [view]);

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

/** Raw location.hash, live — for routes outside store.view (#/health). */
function useHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function App() {
  const mode = useStore((s) => s.view.mode);
  const hash = useHash();
  if (hash === '#/health') {
    return (
      <div className="rd-app">
        <HealthView />
      </div>
    );
  }
  return (
    <div className="rd-app">
      <HashSync />
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
