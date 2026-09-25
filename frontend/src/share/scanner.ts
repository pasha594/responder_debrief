/**
 * The in-app scanner: rear camera → the centre square of each frame (what the
 * square viewfinder shows) → the decode worker. One decode in flight at a
 * time, so a slow phone samples fewer frames instead of queueing stale ones.
 */
import type { ScanReply, ScanRequest } from './scanWorker';

export type ScanProblem = 'denied' | 'no-camera' | 'busy' | 'insecure' | 'unsupported' | 'failed';

export class ScanStartError extends Error {
  constructor(readonly problem: ScanProblem) {
    super(problem);
  }
}

/** Decode at most this many pixels across (the square crop is downscaled). */
const MAX_SIDE = 1080;
/** Consecutive decoder failures before giving up (the worker never loaded). */
const MAX_FAILURES = 5;

let worker: Worker | null = null;
let nextId = 0;

/** One worker for the app's lifetime: the WebAssembly compile happens once. */
function scanWorker(): Worker {
  worker ??= new Worker(new URL('./scanWorker.ts', import.meta.url), { type: 'module' });
  return worker;
}

function problemFor(err: unknown): ScanProblem {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-camera';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'failed';
}

/**
 * Open the camera into `video` and decode until `signal` aborts. Aborting
 * while the camera is still opening releases it without touching `video` —
 * a newer session (a retry, or React's dev double-run) may own it by then.
 */
export async function startScanner(
  video: HTMLVideoElement,
  onTexts: (texts: string[]) => void,
  onFailure: (problem: ScanProblem) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new ScanStartError(window.isSecureContext ? 'unsupported' : 'insecure');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch (err) {
    throw new ScanStartError(problemFor(err));
  }
  if (signal.aborted) {
    for (const t of stream.getTracks()) t.stop();
    return;
  }

  let stopped = false;
  let raf = 0;
  let inFlight: number | null = null;
  let failures = 0;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = scanWorker();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    w.removeEventListener('message', onReply);
    w.removeEventListener('error', onWorkerError);
    for (const t of stream.getTracks()) t.stop();
    if (video.srcObject === stream) video.srcObject = null;
  };
  signal.addEventListener('abort', stop);
  const fail = (problem: ScanProblem) => {
    if (stopped) return;
    stop();
    onFailure(problem);
  };
  function onReply(e: MessageEvent<ScanReply>) {
    if (e.data.id !== inFlight) return; // a previous session's decode
    inFlight = null;
    if (e.data.error) {
      if (++failures >= MAX_FAILURES) fail('failed');
      return;
    }
    failures = 0;
    if (e.data.texts.length && !stopped) onTexts(e.data.texts);
  }
  function onWorkerError() {
    fail('failed');
  }
  w.addEventListener('message', onReply);
  w.addEventListener('error', onWorkerError);
  for (const t of stream.getVideoTracks()) t.addEventListener('ended', () => fail('busy'));

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
  } catch {
    /* autoplay refusal still leaves frames flowing on a muted inline video */
  }
  if (stopped) return;

  const tick = () => {
    if (stopped) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (inFlight === null && ctx && vw && vh && video.readyState >= 2) {
      const side = Math.min(vw, vh);
      const out = Math.min(side, MAX_SIDE);
      if (canvas.width !== out) canvas.width = canvas.height = out;
      ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, out, out);
      const img = ctx.getImageData(0, 0, out, out);
      inFlight = ++nextId;
      const req: ScanRequest = { id: inFlight, width: out, height: out, data: img.data.buffer };
      w.postMessage(req, [req.data]);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
