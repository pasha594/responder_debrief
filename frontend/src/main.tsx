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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
