/** App shell: map + panels + timeline; URL hash ↔ store view sync. */
import { useEffect } from 'react';
import { MapRoot } from '../map/MapRoot';
import { useMapLayerSync } from '../map/useMapLayerSync';
import { useStore } from '../state/store';
import { Sidebar } from '../panels/Sidebar';
import { Timeline } from '../timeline/Timeline';
import { LegendBar } from '../panels/LegendBar';
import { useTimelineDomain } from '../timeline/useTimelineDomain';

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
 * Two-way sync between the URL hash (#/fire/{corneaId}) and store.view.
 * Hash routing keeps GitHub Pages deploys trivial (no 404 fallback needed)
 * and costs no router dependency.
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
      } else if (!id && cur.mode !== 'national') {
        actions.backToNational();
      }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [actions]);

  // store → hash (map pin clicks, back button)
  useEffect(() => {
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

export function App() {
  return (
    <div className="rd-app">
      <MapRoot>
        <MapLayerBridge />
        <HashSync />
        <NowSampler />
        <Sidebar />
        <LegendBar />
        <Timeline />
        <Toast />
      </MapRoot>
    </div>
  );
}
