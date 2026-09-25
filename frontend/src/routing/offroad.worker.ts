/**
 * Offline Walk router, Web Worker shell (a module worker — vite.config
 * `worker.format: 'es'` — because geotiff's codecs are dynamic imports).
 *
 * It never fetches: the main thread loads the bundle through the offline-
 * aware window.fetch and transfers the buffers here (a worker's own fetch
 * would bypass the OPFS pack). Searches run in slices and yield between
 * them through a MessageChannel tick, so a newer 'route' message
 * supersedes a running one and marker drags stay responsive.
 */
import { OffroadEngine } from './engine';
import type { FromWorker, ToWorker } from './protocol';

interface WorkerScope {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  postMessage(msg: FromWorker, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

let engine: OffroadEngine | null = null;
let latestRoute = 0;

const tickChannel = new MessageChannel();
const tickWaiters: (() => void)[] = [];
tickChannel.port1.onmessage = () => tickWaiters.shift()?.();
function tick(): Promise<void> {
  return new Promise((r) => {
    tickWaiters.push(r);
    tickChannel.port2.postMessage(0);
  });
}

async function runRoute(m: Extract<ToWorker, { t: 'route' }>): Promise<void> {
  if (!engine) {
    scope.postMessage({ t: 'error', id: m.id, code: 'not-loaded', message: 'No terrain model loaded' });
    return;
  }
  latestRoute = m.id;
  const it = engine.route(m.a, m.b, { avoidPerimeter: m.avoidPerimeter, perimeterDate: m.perimeterDate });
  let slices = 0;
  for (;;) {
    const r = it.next();
    if (r.done) {
      scope.postMessage({ t: 'route', id: m.id, result: r.value });
      return;
    }
    if (++slices % 5 === 0) scope.postMessage({ t: 'progress', id: m.id, settled: r.value });
    await tick();
    if (latestRoute !== m.id) {
      scope.postMessage({ t: 'route', id: m.id,
        result: { ok: false, code: 'superseded', message: 'superseded' } });
      return;
    }
  }
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'load') {
    const t0 = performance.now();
    engine = null;
    OffroadEngine.load(m.bundle, m.grid, m.dem, m.graph).then((eng) => {
      engine = eng;
      scope.postMessage({ t: 'loaded', id: m.id, bundleId: m.bundle.bundle_id,
        ms: Math.round(performance.now() - t0), cells: eng.grid.width * eng.grid.height,
        nodes: eng.graph.n });
    }).catch((err: unknown) => {
      scope.postMessage({ t: 'error', id: m.id, code: 'decode-failed', message: String(err) });
    });
  } else if (m.t === 'perimeter') {
    if (!engine) {
      scope.postMessage({ t: 'error', id: m.id, code: 'not-loaded', message: 'No terrain model loaded' });
      return;
    }
    const masked = engine.setPerimeter(m.key, m.polygons);
    scope.postMessage({ t: 'perimeterSet', id: m.id, key: m.key, masked });
  } else if (m.t === 'route') {
    void runRoute(m);
  } else if (m.t === 'veg') {
    if (!engine) {
      scope.postMessage({ t: 'error', id: m.id, code: 'not-loaded', message: 'No terrain model loaded' });
      return;
    }
    const img = engine.vegImage(m.maxWidth, m.alpha);
    const rgba = img.rgba.buffer as ArrayBuffer;
    scope.postMessage({ t: 'veg', id: m.id, width: img.width, height: img.height, rgba }, [rgba]);
  }
};
