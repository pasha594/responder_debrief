/**
 * Bottom timeline dock: play/pause (with buffering spinner), scrubbable
 * track, and a fire-local-time readout. Hosts the playback engine.
 */
import { useStore } from '../state/store';
import { useFire } from '../api/queries';
import { TimelineTrack, formatDateTime, tzAbbreviation } from './TimelineTrack';
import { WeatherStrip } from './WeatherStrip';
import { usePlayback } from './usePlayback';
import './timeline.css';

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

  return (
    <div className="rd-timeline">
      <div className="rd-wx-row">
        <WeatherStrip />
      </div>
      <button
        type="button"
        className="rd-play-btn"
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause' : 'Play'}
      >
        {buffering ? <span className="rd-play-spinner" /> : playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <TimelineTrack />
      <div className="rd-time-readout">
        {formatDateTime(currentTime, tz)} {tzAbbreviation(currentTime, tz)}
      </div>
    </div>
  );
}
