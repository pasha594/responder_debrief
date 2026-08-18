/**
 * Bottom timeline dock: play/pause (with buffering spinner), scrubbable
 * track, and a fire-local-time readout. Hosts the playback engine.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { useFire } from '../api/queries';
import { makeLinearScale } from './timeScale';
import { TimelineTrack, formatDateTime, tzAbbreviation } from './TimelineTrack';
import { WeatherStrip } from './WeatherStrip';
import { useIsDesktop } from '../utils/useMediaQuery';
import { usePlayback } from './usePlayback';
import './timeline.css';

/** The scroll viewport always shows this many days of timeline. */
const WINDOW_DAYS = 10;
/** Mobile weather lane height (matches --timeline-wx-h's desktop value). */
const WX_LANE_PX = 46;

/**
 * Drive the height tokens at the ROOT while a reveal drag is live (inline
 * beats the stylesheet), so everything laid out against --timeline-h — map
 * inset, sheet, legend — follows the finger. Null restores the stylesheet.
 */
function setRootLaneVars(reveal: number | null): void {
  const st = document.documentElement.style;
  if (reveal === null) {
    st.removeProperty('--timeline-h');
    st.removeProperty('--timeline-wx-h');
    return;
  }
  const lane = Math.round(reveal * WX_LANE_PX);
  st.setProperty('--timeline-h', `${48 + lane}px`);
  st.setProperty('--timeline-wx-h', `${lane}px`);
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3.5 1.75 12 7l-8.5 5.25z" fill="var(--color-accent)" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="2.5" y="1.75" width="3.4" height="10.5" rx="1" fill="var(--color-accent)" />
      <rect x="8.1" y="1.75" width="3.4" height="10.5" rx="1" fill="var(--color-accent)" />
    </svg>
  );
}

export function Timeline() {
  usePlayback();

  const playing = useStore((s) => s.time.playing);
  const buffering = useStore((s) => s.time.buffering);
  const currentTime = useStore((s) => s.time.currentTime);
  const actions = useStore((s) => s.actions);
  const view = useStore((s) => s.view);

  const corneaId = view.mode === 'fire' ? view.corneaId : null;
  const { data: fire } = useFire(corneaId);
  const tz = view.mode === 'fire' ? (fire?.timezone ?? null) : null;

  const togglePlay = () => {
    const { time } = useStore.getState();
    if (time.playing) {
      actions.pause();
      return;
    }
    // At (or within a second of) the domain end, restart from NOW (clamped).
    if (time.currentTime >= time.domain[1] - 1000) {
      actions.setTime(Math.min(Math.max(time.now, time.domain[0]), time.domain[1]));
    }
    actions.play();
  };

  const domain = useStore((s) => s.time.domain);

  // Radio-dial scrubbing: the playhead is FIXED at the viewport center and
  // the content (dates, track, weather) slides beneath it. The transform is
  // a pure function of currentTime, so playback and programmatic seeks move
  // the dial for free; dragging ANY part of the dock pans it.
  const viewportRef = useRef<HTMLDivElement>(null);
  const [vw, setVw] = useState(0);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setVw(e.contentRect.width);
    });
    ro.observe(el);
    setVw(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const spanMs = Math.max(1, domain[1] - domain[0]);
  const spanDays = spanMs / 86_400_000;
  const contentW = Math.max(vw, (spanDays / WINDOW_DAYS) * vw);
  const scale = makeLinearScale(domain, contentW);
  const translateX = vw / 2 - scale.timeToX(currentTime);
  const msPerPx = spanMs / contentW;

  // ---- dial pan / tap-seek / mobile weather reveal ----
  // The first significant movement locks the gesture's axis: horizontal pans
  // the dial; vertical (mobile) swipes the weather lane open or closed.
  const isDesktop = useIsDesktop();
  const [wxOpen, setWxOpen] = useState(false);
  // While a vertical drag is live, the lane height follows the finger:
  // 0 = tucked, 1 = fully out. Null when no vertical drag is in flight.
  const [wxDrag, setWxDrag] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{
    startX: number;
    startY: number;
    startTime: number;
    startReveal: number;
    axis: 'h' | 'v' | null;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (useStore.getState().time.playing) actions.pause();
    viewportRef.current?.setPointerCapture(e.pointerId);
    gesture.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTime: currentTime,
      startReveal: wxOpen ? 1 : 0,
      axis: null,
    };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.axis && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
      g.axis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
    }
    // Dragging the dial left tunes forward in time, like spinning it.
    if (g.axis === 'h') actions.setTime(g.startTime - dx * msPerPx);
    // Vertical (mobile): the weather lane peeks out under the finger, and
    // the ROOT height token tracks it live so the map and sheet above are
    // pushed smoothly instead of jumping when the reveal class lands.
    if (g.axis === 'v' && !isDesktop) {
      const r = Math.min(1, Math.max(0, g.startReveal - dy / WX_LANE_PX));
      setWxDrag(r);
      setRootLaneVars(r);
    }
  };
  const endGesture = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    setDragging(false);
    viewportRef.current?.releasePointerCapture(e.pointerId);
    if (g.axis === 'v' && !isDesktop) {
      // Settle to whichever side the lane is closer to; the tokens take
      // back over from the live inline vars.
      const dy = e.clientY - g.startY;
      const reveal = Math.min(1, Math.max(0, g.startReveal - dy / WX_LANE_PX));
      setWxOpen(reveal > 0.5);
      setWxDrag(null);
      setRootLaneVars(null);
      return;
    }
    if (!g.axis && viewportRef.current) {
      // A plain tap tunes the dial to the tapped instant.
      const rect = viewportRef.current.getBoundingClientRect();
      const contentX = e.clientX - rect.left - translateX;
      actions.setTime(scale.xToTime(contentX));
    }
  };

  // Live reveal fraction: follows the finger mid-drag, snaps with wxOpen.
  const wxReveal = wxDrag ?? (wxOpen ? 1 : 0);
  // Clear any live vars if the dock unmounts mid-gesture.
  useEffect(() => () => setRootLaneVars(null), []);
  const onWheel = (e: React.WheelEvent) => {
    const d = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (d) actions.setTime(useStore.getState().time.currentTime + d * msPerPx);
  };

  return (
    <div
      className={`rd-timeline${wxReveal > 0 ? ' rd-timeline--wx-open' : ''}${
        wxDrag === null ? ' rd-timeline--wx-anim' : ''
      }`}
    >
      <button
        type="button"
        className="rd-play-btn"
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause' : 'Play'}
      >
        {buffering ? <span className="rd-play-spinner" /> : playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div
        className={`rd-tl-viewport${dragging ? ' rd-tl-viewport--dragging' : ''}`}
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onWheel={onWheel}
      >
        <div
          className="rd-tl-content"
          style={{ width: contentW || undefined, transform: `translateX(${translateX}px)` }}
        >
          <TimelineTrack />
          <div className="rd-wx-row">
            {(isDesktop || wxReveal > 0) && <WeatherStrip />}
          </div>
        </div>
        <div className="rd-dial-playhead" aria-hidden="true">
          <div className="rd-playhead-line" />
          <div className="rd-playhead-handle" />
        </div>
      </div>
      <div className="rd-time-readout">
        {formatDateTime(currentTime, tz)} {tzAbbreviation(currentTime, tz)}
      </div>
    </div>
  );
}
