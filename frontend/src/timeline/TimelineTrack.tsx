/**
 * The scrubbable track: day/hour ticks, NOW seam, perimeter-version dots,
 * playhead + cover, drag tooltip. All positions come from timeScale; all
 * seek logic emits time-space values via actions.setTime.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { useFire, usePerimeterIndex } from '../api/queries';
import { makeScale } from './timeScale';

const HOUR = 3600_000;
/** Minimum px per hour before hourly ticks render. */
const HOUR_TICK_MIN_PX = 3;

// ---------- fire-local time formatting (shared with Timeline readout) -------

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function getFormat(kind: string, tz: string | null | undefined, opts: Intl.DateTimeFormatOptions) {
  const key = `${kind}|${tz ?? 'local'}`;
  let fmt = fmtCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz ?? undefined });
    } catch {
      // invalid IANA name from the API → viewer-local
      fmt = new Intl.DateTimeFormat('en-US', opts);
    }
    fmtCache.set(key, fmt);
  }
  return fmt;
}

/** "PDT" / "MST" … for the fire's tz (viewer-local when tz is null). */
export function tzAbbreviation(t: number, tz: string | null | undefined): string {
  const parts = getFormat('abbr', tz, { hour: '2-digit', timeZoneName: 'short' }).formatToParts(t);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/** "Aug 17, 14:32" in the fire's tz. */
export function formatDateTime(t: number, tz: string | null | undefined): string {
  return getFormat('datetime', tz, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(t);
}

/** "Mon 18" day label in the fire's tz. */
function formatDayLabel(t: number, tz: string | null | undefined): string {
  return getFormat('day', tz, { weekday: 'short', day: 'numeric' }).format(t);
}

/** "2026-08-18" — day identity in the fire's tz, for boundary detection. */
function dayKey(t: number, tz: string | null | undefined): string {
  return getFormat('daykey', tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}

// ---------- tick model ------------------------------------------------------

interface DayTick {
  x: number;
  label: string;
}
interface HourTick {
  x: number;
}

function buildTicks(
  domain: [number, number],
  scale: ReturnType<typeof makeScale>,
  tz: string | null | undefined,
): { days: DayTick[]; hours: HourTick[] } {
  const days: DayTick[] = [];
  const hours: HourTick[] = [];
  const [d0, d1] = domain;
  if (!(d1 > d0)) return { days, hours };

  const firstHour = Math.ceil(d0 / HOUR) * HOUR;
  let prevKey = dayKey(Math.max(d0, firstHour - HOUR), tz);
  for (let h = firstHour; h <= d1; h += HOUR) {
    const key = dayKey(h, tz);
    if (key !== prevKey) {
      prevKey = key;
      days.push({ x: scale.timeToX(h), label: formatDayLabel(h, tz) });
      continue; // day boundary supersedes an hour tick
    }
    // Hourly ticks where dense enough; otherwise sparse 6-hour ticks.
    const px = scale.timeToX(h + HOUR) - scale.timeToX(h);
    if (px >= HOUR_TICK_MIN_PX) {
      hours.push({ x: scale.timeToX(h) });
    } else if (px >= HOUR_TICK_MIN_PX / 6 && new Date(h).getUTCHours() % 6 === 0) {
      hours.push({ x: scale.timeToX(h) });
    }
  }
  return { days, hours };
}

// ---------- component -------------------------------------------------------

export function TimelineTrack() {
  const domain = useStore((s) => s.time.domain);
  const now = useStore((s) => s.time.now);
  const currentTime = useStore((s) => s.time.currentTime);
  const actions = useStore((s) => s.actions);
  const view = useStore((s) => s.view);

  const corneaId = view.mode === 'fire' ? view.corneaId : null;
  const { data: fire } = useFire(corneaId);
  const tz = view.mode === 'fire' ? (fire?.timezone ?? null) : null;
  const { data: perimeterIndex } = usePerimeterIndex(corneaId);

  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const scale = useMemo(() => makeScale(domain, now, width), [domain, now, width]);

  const ticks = useMemo(() => buildTicks(domain, scale, tz), [domain, scale, tz]);

  const versionDots = useMemo(() => {
    if (!perimeterIndex?.length || width <= 0) return [];
    return perimeterIndex.map((item) => {
      const ts = Date.parse(item.date);
      return {
        ts,
        x: scale.timeToX(ts),
        title: `Perimeter ${formatDateTime(ts, tz)} ${tzAbbreviation(ts, tz)}`,
      };
    });
  }, [perimeterIndex, scale, width, tz]);

  // ---- seek / drag (pointer events + capture) ----
  const seekFromEvent = (e: React.PointerEvent) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
    actions.setTime(scale.xToTime(x));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = trackRef.current;
    if (!el) return;
    if (useStore.getState().time.playing) actions.pause();
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    seekFromEvent(e);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    seekFromEvent(e);
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    trackRef.current?.releasePointerCapture(e.pointerId);
  };

  const playheadX = scale.timeToX(currentTime);
  const nowInDomain = now > domain[0] && now < domain[1];
  const nowX = scale.timeToX(now);
  const tooltipX = Math.min(Math.max(playheadX, 48), Math.max(width - 48, 48));

  return (
    <div
      ref={trackRef}
      className="rd-track"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {ticks.days.map((d, i) => (
        <div key={`d${i}`}>
          <div className="rd-tick-day" style={{ left: d.x }} />
          {d.x < width - 48 && (
            <div className="rd-tick-day-label" style={{ left: d.x + 4 }}>
              {d.label}
            </div>
          )}
        </div>
      ))}
      {ticks.hours.map((h, i) => (
        <div key={`h${i}`} className="rd-tick-hour" style={{ left: h.x }} />
      ))}

      {nowInDomain && (
        <>
          <div className="rd-now-line" style={{ left: nowX }} />
          <div className="rd-now-label" style={{ left: nowX + 3 }}>
            NOW
          </div>
        </>
      )}

      {versionDots.map((v, i) => (
        <button
          key={`v${i}`}
          type="button"
          className="rd-perim-dot"
          style={{ left: v.x }}
          title={v.title}
          aria-label={v.title}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => actions.setTime(v.ts)}
        />
      ))}

      <div className="rd-track-cover" style={{ left: playheadX, width: Math.max(0, width - playheadX) }} />

      <div className={`rd-playhead${dragging ? ' rd-playhead-dragging' : ''}`} style={{ left: playheadX }}>
        <div className="rd-playhead-line" />
        <div className="rd-playhead-handle" />
      </div>

      {dragging && (
        <div className="rd-drag-tooltip" style={{ left: tooltipX }}>
          {formatDateTime(currentTime, tz)} {tzAbbreviation(currentTime, tz)}
        </div>
      )}
    </div>
  );
}
