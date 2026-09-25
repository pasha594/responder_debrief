/**
 * QR sharing between phones, no signal needed (see share/). One dialog, two
 * jobs:
 *   Show — the open fire's view (camera, basemap, playhead, forecast and
 *          weather layers, the draped sheet) and optionally its drawings, as
 *          one code, or an animated run when that won't fit;
 *   Scan — the rear camera, reading another phone's code into the preview
 *          card (IncomingShareCard) where the user decides to apply it.
 * The directory opens it on Scan only: there is no view to show there.
 *
 * Portalled like MapLightbox, and keeps the screen awake while open.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useFire } from '../api/queries';
import { track } from '../app/analytics';
import { useMap } from '../map/MapRoot';
import { useStore } from '../state/store';
import { captureShare, hasRoutingToShare } from '../share/captureShare';
import { ShareFormatError } from '../share/bytes';
import { FountainDecoder } from '../share/fountain';
import { paintQr } from '../share/paintQr';
import { FRAME_INTERVAL_MS, planShareCodes, type SharePlan } from '../share/qrCodes';
import { ScanStartError, startScanner, type ScanProblem } from '../share/scanner';
import { decodeShareBody, encodeShareBody } from '../share/shareCodec';
import { parseShareText, shareLinkPrefix } from '../share/transport';

export type QrTab = 'show' | 'scan';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** On-screen size of the code, CSS px (capped by the dialog width). */
const CODE_CSS_PX = 340;

const PROBLEM_TEXT: Record<ScanProblem, string> = {
  denied: 'Camera access is off. Allow the camera for this site in your browser settings, then try again.',
  'no-camera': 'No camera found on this device.',
  busy: 'The camera is busy or stopped. Close other apps using it, then try again.',
  insecure: 'The camera needs a secure (https) connection.',
  unsupported: 'This browser can’t open the camera.',
  failed: 'The scanner couldn’t start. Try again.',
};

/** Keep the screen on while a code is shown or the camera is up. */
function useWakeLock(): void {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let done = false;
    const acquire = async () => {
      try {
        const next = (await navigator.wakeLock?.request('screen')) ?? null;
        if (done) void next?.release().catch(() => undefined);
        else lock = next;
      } catch {
        /* wake lock is best-effort */
      }
    };
    // the browser drops the lock whenever the page is hidden
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}

function CodeView({ plan }: { plan: SharePlan }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (plan.kind === 'single') {
      paintQr(canvas, plan.code, CODE_CSS_PX);
      return;
    }
    let seq = 1;
    paintQr(canvas, plan.frameCode(seq), CODE_CSS_PX);
    const t = setInterval(() => {
      seq += 1;
      paintQr(canvas, plan.frameCode(seq), CODE_CSS_PX);
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(t);
  }, [plan]);
  return <canvas className="rd-qr-code" ref={canvasRef} role="img" aria-label="Share code" />;
}

function ShowPanel() {
  const map = useMap();
  const view = useStore((s) => s.view);
  const corneaId = view.mode === 'fire' ? view.corneaId : null;
  const { data: fire } = useFire(corneaId);
  const markCount = useStore((s) => s.draw.features.length);
  const hasRouting = useStore(hasRoutingToShare);
  const [withDrawings, setWithDrawings] = useState(markCount > 0);
  const [withRouting, setWithRouting] = useState(true);
  const fireName = fire?.post_title ?? '';
  const drawings = withDrawings && markCount > 0;
  const routing = withRouting && hasRouting;

  // Snapshot of the view as the dialog opened: the modal covers the map, so
  // nothing changes under a scanner halfway through an animated run.
  const built = useMemo(() => {
    if (!map) return null;
    const share = captureShare(map, fireName, { drawings, routing });
    if (!share) return null;
    const body = encodeShareBody(share);
    return { plan: planShareCodes(body, shareLinkPrefix()), bytes: body.length };
  }, [map, fireName, drawings, routing]);

  useEffect(() => {
    if (!built) return;
    track('share_code_shown', {
      parts: built.plan.kind === 'single' ? 1 : built.plan.frames,
      bytes: built.bytes,
      drawings: drawings ? markCount : null,
      directions: routing,
    });
  }, [built, drawings, routing, markCount]);

  const contents = ['map view', 'layers', 'incident sheet'];
  if (drawings) contents.push('drawings');
  if (routing) contents.push('directions');
  const listed = `${contents.slice(0, -1).join(', ')} and ${contents[contents.length - 1]}`;

  return (
    <div className="rd-qr-show">
      <label className={`rd-qr-check${markCount ? '' : ' rd-qr-check--off'}`}>
        <input
          type="checkbox"
          checked={withDrawings && markCount > 0}
          disabled={!markCount}
          onChange={(e) => setWithDrawings(e.target.checked)}
        />
        <span>
          {markCount
            ? `Include drawings (${markCount} mark${markCount === 1 ? '' : 's'}) — replaces theirs on this fire`
            : 'No drawings on this fire to include'}
        </span>
      </label>
      {hasRouting && (
        <label className="rd-qr-check">
          <input
            type="checkbox"
            checked={withRouting}
            onChange={(e) => setWithRouting(e.target.checked)}
          />
          <span>Include directions and dropped pin — replaces theirs</span>
        </label>
      )}
      <div className="rd-qr-frame">
        {built ? <CodeView plan={built.plan} /> : <div className="rd-qr-wait">Preparing code…</div>}
      </div>
      {built && (
        <div className="rd-qr-caption">
          {built.plan.kind === 'single'
            ? `One code: ${listed}`
            : `Animated code · ${built.plan.frames} parts — keep it on screen until the other phone finishes`}
        </div>
      )}
      <p className="rd-qr-hint">
        On the other phone, open this fire’s QR button and pick <b>Scan code</b>, or tap
        <b> Scan code</b> in the fire list. Turn this screen’s brightness up.
      </p>
    </div>
  );
}

function ScanPanel({ onDone }: { onDone: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const setIncomingShare = useStore((s) => s.actions.setIncomingShare);
  const [problem, setProblem] = useState<ScanProblem | null>(null);
  const [progress, setProgress] = useState<{ solved: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Latest callback without restarting the camera when a parent re-renders.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setProblem(null);
    setProgress(null);
    setNote(null);
    const session = new AbortController();
    const decoder = new FountainDecoder();
    const started = Date.now();

    const finish = (body: Uint8Array, parts: number): boolean => {
      try {
        const share = decodeShareBody(body);
        session.abort(); // camera off before the card opens
        track('share_code_scanned', { parts, ms: Date.now() - started });
        setIncomingShare(share);
        onDoneRef.current();
        return true;
      } catch (err) {
        setNote(err instanceof ShareFormatError && err.reason === 'newer'
          ? 'This code comes from a newer version of the app — reconnect to update, then scan again.'
          : 'That code couldn’t be read. Try again.');
        return false;
      }
    };
    const onTexts = (texts: string[]) => {
      for (const text of texts) {
        let code;
        try {
          code = parseShareText(text);
        } catch (err) {
          setNote(err instanceof ShareFormatError && err.reason === 'newer'
            ? 'This code comes from a newer version of the app — reconnect to update, then scan again.'
            : 'That code couldn’t be read. Hold steady and try again.');
          continue;
        }
        if (!code) {
          setNote('That QR code isn’t a share from this app.');
          continue;
        }
        if (code.kind === 'single') {
          if (finish(code.body, 1)) return;
          continue;
        }
        const whole = decoder.receive(code.frame);
        if (whole && finish(whole, code.frame.k)) return;
        setNote(null);
        setProgress({ ...decoder.progress });
      }
    };

    startScanner(video, onTexts, (p) => {
      if (!session.signal.aborted) setProblem(p);
    }, session.signal).catch((err: unknown) => {
      if (!session.signal.aborted) setProblem(err instanceof ScanStartError ? err.problem : 'failed');
    });
    return () => session.abort();
  }, [attempt, setIncomingShare]);

  return (
    <div className="rd-qr-scan">
      <div className="rd-qr-viewfinder">
        <video ref={videoRef} className="rd-qr-video" muted playsInline autoPlay />
        <div className="rd-qr-reticle" aria-hidden="true" />
      </div>
      {problem ? (
        <div className="rd-qr-problem">
          <p>{PROBLEM_TEXT[problem]}</p>
          <button type="button" className="rd-mini-btn" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
        </div>
      ) : progress ? (
        <div className="rd-qr-progress">
          <div className="rd-qr-caption">
            Receiving… {progress.solved} of {progress.total} parts
          </div>
          <div className="rd-offline-bar">
            <div
              className="rd-offline-bar-fill"
              style={{ width: `${Math.round((progress.solved / progress.total) * 100)}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="rd-qr-caption">
          Point the camera at the code on the other phone, about a hand’s width away.
        </div>
      )}
      {note && !problem && <div className="rd-qr-note">{note}</div>}
    </div>
  );
}

export function QrDialog({
  initial,
  canShow,
  onClose,
}: {
  initial: QrTab;
  /** False in the directory: there's no fire view to share. */
  canShow: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<QrTab>(canShow ? initial : 'scan');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<Element | null>(null);
  useWakeLock();

  useEffect(() => {
    restoreRef.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      const el = restoreRef.current;
      if (el instanceof HTMLElement && document.contains(el)) el.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  /** Minimal trap: Tab cycles within the dialog's own controls. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const nodes = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !root.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="rd-lightbox rd-qr-backdrop"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="rd-lightbox-dialog rd-qr-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Share offline"
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <div className="rd-lightbox-bar">
          <span className="rd-lightbox-title">Share offline</span>
          <button
            type="button"
            className="rd-lightbox-x"
            aria-label="Close"
            ref={closeRef}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {canShow && (
          <div className="rd-settings-segment rd-qr-tabs" role="tablist" aria-label="Share or scan">
            {(['show', 'scan'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`rd-settings-seg${tab === t ? ' rd-settings-seg--on' : ''}`}
                onClick={() => setTab(t)}
              >
                {t === 'show' ? 'Show code' : 'Scan code'}
              </button>
            ))}
          </div>
        )}
        <div className="rd-qr-body">
          {tab === 'show' ? <ShowPanel /> : <ScanPanel onDone={onClose} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}
