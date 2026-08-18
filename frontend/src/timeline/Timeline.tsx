/**
 * Bottom timeline dock: play/pause (with buffering spinner), scrubbable
 * track, and a fire-local-time readout. Hosts the playback engine.
 */
import { useEffect, useRef } from 'react';
import { useStore } from '../state/store';
import { useFire } from '../api/queries';
import { TimelineTrack, formatDateTime, tzAbbreviation } from './TimelineTrack';
import { WeatherStrip } from './WeatherStrip';
import { usePlayback } from './usePlayback';
import './timeline.css';

/** The scroll viewport always shows this many days of timeline. */
const WINDOW_DAYS = 10;

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

  // Fixed 10-day window: the scroll viewport always spans WINDOW_DAYS, the
  // content stretches to the whole domain at that constant px/day, and the
  // dock opens scrolled to the right end (NOW + the forecast).
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  const spanDays = Math.max(1, (domain[1] - domain[0]) / 86_400_000);
  const contentPct = Math.max(100, (spanDays / WINDOW_DAYS) * 100);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const key = `${corneaId}|${domain[0]}`;
    if (scrolledFor.current === key) return;
    // The dock can mount before layout settles (scrollWidth ~0) — retry on
    // frames until the content is real, THEN snap to the right end once.
    let raf = 0;
    const tryScroll = () => {
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
        el.scrollLeft = el.scrollWidth;
        scrolledFor.current = key;
        return;
      }
      raf = requestAnimationFrame(tryScroll);
    };
    tryScroll();
    return () => cancelAnimationFrame(raf);
  }, [corneaId, domain, contentPct]);

  return (
    <div className="rd-timeline">
      <button
        type="button"
        className="rd-play-btn"
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause' : 'Play'}
      >
        {buffering ? <span className="rd-play-spinner" /> : playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="rd-tl-scroll" ref={scrollRef}>
        <div className="rd-tl-content" style={{ width: `${contentPct}%` }}>
          <TimelineTrack />
          <div className="rd-wx-row">
            <WeatherStrip />
          </div>
        </div>
      </div>
      <div className="rd-time-readout">
        {formatDateTime(currentTime, tz)} {tzAbbreviation(currentTime, tz)}
      </div>
    </div>
  );
}
