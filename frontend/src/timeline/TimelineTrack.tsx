/**
 * The scrubbable track. Lanes, top to bottom:
 *   day labels (m/d) → hour ticks → activity lane (hotspot sparkline behind,
 *   perimeter diamonds + the spread-forecast mark on top).
 * The NOW seam, playhead and drag tooltip sit above everything.
 *
 * All positions come from timeScale; all seek logic emits time-space values
 * via actions.setTime.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { latestRun, useFire, useMasterCatalog, usePerimeterIndex, usePyrecastRuns } from '../api/queries';
import { useFireHotspots } from '../api/useFireHotspots';
import { useIsDesktop } from '../utils/useMediaQuery';
import { makeLinearScale, type TimeScale } from './timeScale';
import { activitySamples, hotspotActivity, sparklinePath } from './hotspotActivity';
import { dayLabelStride, markPlacement } from './trackMarks';

const HOUR = 3600_000;
/** Minimum px per hour before hourly ticks render. */
const HOUR_TICK_MIN_PX = 3;
/** Widest an "8/17" label gets, plus breathing room. */
const DAY_LABEL_MIN_GAP_PX = 34;
/** Below this track width the sparkline caption would crowd the lane. */
const CAPTION_MIN_TRACK_PX = 300;
/** Drag auto-scroll speed (px/frame) at the viewport's outermost edge. */
const EDGE_SCROLL_MAX_PX = 22;

/** Activity-lane geometry (px insets inside the track), per breakpoint. */
const LANE = {
  desktop: { top: 24, bottom: 10 },
  mobile: { top: 18, bottom: 3 },
};

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

/**
 * "8/17" day label in the fire's tz — no leading zeros, no year (the readout
 * and tooltips carry the full stamp; the track only needs the calendar rhythm).
 */
export function formatDayLabel(t: number, tz: string | null | undefined): string {
  return getFormat('mdlabel', tz, { month: 'numeric', day: 'numeric' }).format(t);
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
  scale: TimeScale,
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
  const isDesktop = useIsDesktop();

  const corneaId = view.mode === 'fire' ? view.corneaId : null;
  const { data: fire } = useFire(corneaId);
  const tz = view.mode === 'fire' ? (fire?.timezone ?? null) : null;
  const { data: perimeterIndex } = usePerimeterIndex(corneaId);
  const { data: catalog } = useMasterCatalog();
  const { data: pyrecastRuns } = usePyrecastRuns();
  // Shared cache entry with useMapLayerSync — one fetch feeds map and track.
  const { data: hotspots } = useFireHotspots(corneaId);

  const trackRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const { width, height } = size;

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setSize({ width: e.contentRect.width, height: e.contentRect.height });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setSize({ width: r.width, height: r.height });
    return () => ro.disconnect();
  }, []);

  const scale = useMemo(() => makeLinearScale(domain, width), [domain, width]);

  const ticks = useMemo(() => buildTicks(domain, scale, tz), [domain, scale, tz]);

  /** Thin day labels until the tightest pair clears DAY_LABEL_MIN_GAP_PX. */
  const labelStride = useMemo(
    () => dayLabelStride(ticks.days.map((d) => d.x), DAY_LABEL_MIN_GAP_PX),
    [ticks.days],
  );

  const versionMarks = useMemo(() => {
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

  // ---- spread-forecast publication mark (resolved exactly as the map does) ----
  const fireSlug =
    catalog?.fires.find((f) => f.cornea_id === corneaId)?.fire_slug ?? fire?.unique_slug ?? null;
  const spreadRun = useMemo(() => latestRun(pyrecastRuns, fireSlug), [pyrecastRuns, fireSlug]);

  const forecastMark = useMemo(() => {
    if (!spreadRun || width <= 0) return null;
    const ts = Date.parse(spreadRun.run_time);
    const placed = markPlacement(ts, domain, scale.timeToX);
    if (!placed) return null;
    return {
      ...placed,
      title: `Spread forecast published ${formatDateTime(ts, tz)} ${tzAbbreviation(ts, tz)}`,
    };
  }, [spreadRun, domain, scale, width, tz]);

  // ---- hotspot activity throughline ----
  const lane = isDesktop ? LANE.desktop : LANE.mobile;
  const laneHeight = Math.max(0, height - lane.top - lane.bottom);

  const sparkline = useMemo(() => {
    if (width <= 0 || laneHeight <= 6) return null;
    const to = Math.min(now, domain[1]);
    const days = hotspotActivity(hotspots, domain[0], to, tz);
    if (days.length < 1) return null;
    // 2px of headroom keeps the busiest day off the lane's ceiling.
    return sparklinePath(
      activitySamples(days, to).map((p) => ({ x: scale.timeToX(p.t), value: p.value })),
      laneHeight,
      laneHeight - 2,
    );
  }, [hotspots, domain, now, tz, scale, width, laneHeight]);

  const showCaption = !!sparkline && isDesktop && width >= CAPTION_MIN_TRACK_PX;

  // ---- seek / drag (pointer events + capture) ----
  const seekFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    actions.setTime(scale.xToTime(x));
  };

  // While a drag hovers the viewport's outer thirds, scroll the 10-day
  // window under the pointer so the user can scrub past the fold. Velocity
  // ramps from 0 at the third's inner edge to EDGE_SCROLL_MAX_PX at the rim.
  const dragClientX = useRef<number | null>(null);
  const edgeRaf = useRef(0);
  const edgeScrollLoop = () => {
    const el = trackRef.current;
    const sc = el?.closest('.rd-tl-scroll') as HTMLElement | null;
    const cx = dragClientX.current;
    if (!el || !sc || cx === null) return;
    const vr = sc.getBoundingClientRect();
    const third = vr.width / 3;
    let v = 0;
    if (cx < vr.left + third) {
      v = -EDGE_SCROLL_MAX_PX * Math.min(1, (vr.left + third - cx) / third);
    } else if (cx > vr.right - third) {
      v = EDGE_SCROLL_MAX_PX * Math.min(1, (cx - (vr.right - third)) / third);
    }
    if (v !== 0) {
      const max = sc.scrollWidth - sc.clientWidth;
      const next = Math.min(max, Math.max(0, sc.scrollLeft + v));
      if (next !== sc.scrollLeft) {
        sc.scrollLeft = next;
        seekFromClientX(cx); // the content moved under a stationary pointer
      }
    }
    edgeRaf.current = requestAnimationFrame(edgeScrollLoop);
  };
  useEffect(() => () => cancelAnimationFrame(edgeRaf.current), []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = trackRef.current;
    if (!el) return;
    if (useStore.getState().time.playing) actions.pause();
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    dragClientX.current = e.clientX;
    seekFromClientX(e.clientX);
    cancelAnimationFrame(edgeRaf.current);
    edgeRaf.current = requestAnimationFrame(edgeScrollLoop);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    dragClientX.current = e.clientX;
    seekFromClientX(e.clientX);
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    dragClientX.current = null;
    cancelAnimationFrame(edgeRaf.current);
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
      {sparkline && (
        <svg
          className="rd-spark"
          style={{ top: lane.top, height: laneHeight }}
          width={width}
          height={laneHeight}
          viewBox={`0 0 ${Math.max(1, width)} ${laneHeight}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path className="rd-spark-area" d={sparkline.area} />
          <path className="rd-spark-line" d={sparkline.line} />
        </svg>
      )}
      {showCaption && <div className="rd-spark-caption">hotspot activity</div>}

      {ticks.days.map((d, i) => (
        <div key={`d${i}`}>
          <div className="rd-tick-day" style={{ left: d.x }} />
          {i % labelStride === 0 && d.x < width - 40 && (
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

      {forecastMark && (
        <div
          className={`rd-forecast-mark${forecastMark.clamped ? ' rd-forecast-mark-clamped' : ''}`}
          style={{ left: forecastMark.x, top: lane.top, height: laneHeight }}
          title={
            forecastMark.clamped
              ? `${forecastMark.title} (outside the visible range)`
              : forecastMark.title
          }
          role="img"
          aria-label={forecastMark.title}
        >
          <svg width="11" height={Math.max(8, laneHeight)} viewBox={`0 0 11 ${Math.max(8, laneHeight)}`}>
            <line
              x1="5.5"
              y1="5"
              x2="5.5"
              y2={Math.max(8, laneHeight)}
              stroke="var(--color-accent)"
              strokeWidth="1"
              opacity="0.55"
            />
            <path d="M5.5 0.5 10 7 1 7 Z" fill="var(--color-accent)" />
          </svg>
        </div>
      )}

      {versionMarks.map((v, i) => (
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
