/**
 * Main-thread side of the offline Walk router: a lazily created module
 * Worker singleton (never at import time — vitest imports this module, and
 * React StrictMode double-runs effects), bundle loading through the
 * offline-aware window.fetch, request ids, and idle shutdown.
 */
import { dataUrl } from '../api/catalogs';
import type { OffroadResult } from './engine';
import type { FromWorker, ToWorker } from './protocol';
import type { RoutingBundle } from './types';

const IDLE_MS = 10 * 60_000;

let worker: Worker | null = null;
let loadedBundle: string | null = null;
let loading: { id: string; p: Promise<void> } | null = null;
let perimeterKey: string | null | undefined;
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, { resolve: (m: FromWorker) => void; reject: (e: Error) => void }>();

function touch(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(shutdown, IDLE_MS);
}

export function shutdown(): void {
  worker?.terminate();
  worker = null;
  loadedBundle = null;
  loading = null;
  perimeterKey = undefined;
  for (const p of pending.values()) p.reject(new Error('router stopped'));
  pending.clear();
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./offroad.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.t === 'progress') return;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      p.resolve(m);
    };
    worker.onerror = () => {
      const err = new Error('routing worker crashed');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      worker = null;
      loadedBundle = null;
      perimeterKey = undefined;
    };
  }
  touch();
  return worker;
}

type Req = ToWorker extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never;

function call(msg: Req, transfer: Transferable[] = []): Promise<FromWorker> {
  const id = nextId++;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, id } as ToWorker, transfer);
  });
}

async function fetchBuffer(path: string): Promise<ArrayBuffer> {
  const res = await fetch(dataUrl(path));
  if (!res.ok) throw new Error(`${res.status} for ${path}`);
  return res.arrayBuffer();
}

export function loadedBundleId(): string | null {
  return loadedBundle;
}

/** Load a bundle into the worker (no-op when already loaded). */
export function ensureBundle(b: RoutingBundle): Promise<void> {
  if (loadedBundle === b.bundle_id) {
    touch();
    return Promise.resolve();
  }
  if (loading?.id === b.bundle_id) return loading.p;
  const p = (async () => {
    const [grid, dem, graph] = await Promise.all([
      fetchBuffer(b.files.grid.path), fetchBuffer(b.files.dem.path), fetchBuffer(b.files.graph.path),
    ]);
    const m = await call({ t: 'load', bundle: b, grid, dem, graph }, [grid, dem, graph]);
    if (m.t !== 'loaded') throw new Error(m.t === 'error' ? m.message : 'load failed');
    loadedBundle = b.bundle_id;
    perimeterKey = undefined;
  })();
  loading = { id: b.bundle_id, p };
  return p.finally(() => {
    if (loading?.p === p) loading = null;
  });
}

export async function setPerimeter(key: string | null,
  polygons: [number, number][][][] | null): Promise<void> {
  if (perimeterKey === key) return;
  const m = await call({ t: 'perimeter', key, polygons });
  if (m.t === 'perimeterSet') perimeterKey = key;
}

export async function routeOffroad(a: [number, number], b: [number, number], avoidPerimeter: boolean,
  perimeterDate: string | null): Promise<OffroadResult> {
  const m = await call({ t: 'route', a, b, avoidPerimeter, perimeterDate });
  if (m.t === 'route') return m.result;
  if (m.t === 'error') return { ok: false, code: 'decode-failed', message: m.message };
  throw new Error('unexpected worker reply');
}

export async function vegImage(maxWidth: number, alpha = 255)
  : Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  const m = await call({ t: 'veg', maxWidth, alpha });
  if (m.t !== 'veg') throw new Error(m.t === 'error' ? m.message : 'veg failed');
  return { width: m.width, height: m.height, rgba: new Uint8ClampedArray(m.rgba) };
}
