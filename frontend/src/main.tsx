// TEMP diagnostics: capture full error stacks for integration debugging.
if (import.meta.env.DEV) {
  // Hidden-tab rAF shim: embedded/background tabs suspend requestAnimationFrame,
  // freezing MapLibre's render loop. Fall back to timers so the map still
  // renders during automated verification. Dev only.
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    document.hidden
      ? (window.setTimeout(() => cb(performance.now()), 33) as unknown as number)
      : nativeRaf(cb);
  window.cancelAnimationFrame = (id: number): void => {
    clearTimeout(id);
    nativeCancel(id);
  };

  const w = window as unknown as { __rdErrors: string[] };
  w.__rdErrors = [];
  window.addEventListener('error', (e) => {
    w.__rdErrors.push(`[error] ${e.message}\n${e.error?.stack ?? '(no stack)'}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined;
    w.__rdErrors.push(`[rejection] ${r?.message ?? String(e.reason)}\n${r?.stack ?? ''}`);
  });
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import './app/tokens.css'; // includes vendored @font-face (public/fonts/*.woff2)

import { App } from './app/App';
import { initOfflinePacks, installOfflineFetch } from './offline/packs';

// Offline packs: wrap fetch before anything (map, queries) issues a request,
// then hydrate the pack index from OPFS in the background.
installOfflineFetch();
void initOfflinePacks();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
});

// Offline app shell: prod-only (dev serves from memory and a SW would fight
// HMR). See scripts/build-sw.mjs for the rollback-safe design.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* shell caching is best-effort */
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
