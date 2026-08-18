/**
 * Windy-style weather lane above the timeline track: per-slot icon, temp,
 * and wind (arrow rotated to where the air moves, speed in mph) at the fire
 * origin, from Open-Meteo. Sits in the timeline grid's track column, so its
 * x-axis matches the track by construction — it just rebuilds the same
 * piecewise scale at its own measured width.
 */
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { useOriginWeather } from '../api/openMeteo';
import { makeLinearScale } from './timeScale';
import { buildWeatherSlots } from './weatherStripModel';
import { formatDateTime, formatDayLabel, tzAbbreviation } from './TimelineTrack';
import { useFire } from '../api/queries';

/** Columns closer than this to either edge are dropped (they'd clip). */
const EDGE_PX = 18;

export function WeatherStrip() {
  const view = useStore((s) => s.view);
  const domain = useStore((s) => s.time.domain);
  const now = useStore((s) => s.time.now);

  const corneaId = view.mode === 'fire' ? view.corneaId : null;
  const { data: fire } = useFire(corneaId);
  const tz = fire?.timezone ?? null;
  const { data: hours } = useOriginWeather(corneaId, domain[0]);

  // Callback ref, not a mount-once effect: the strip div appears only after
  // the fire + desktop checks pass, which can be AFTER first mount.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [el]);

  const slots = useMemo(() => {
    if (!hours?.length || width <= 0) return [];
    const scale = makeLinearScale(domain, width);
    return buildWeatherSlots(hours, domain, now, scale.timeToX).filter(
      (s) => s.x >= EDGE_PX && s.x <= width - EDGE_PX,
    );
  }, [hours, domain, now, width]);

  // Mounted only while its lane is visible (Timeline gates mobile).
  if (!corneaId) return null;

  return (
    <div ref={setEl} className="rd-wx-strip" aria-label="Weather at fire origin">
      {slots.map((s) => (
        <div
          key={s.t}
          className="rd-wx-col"
          style={{ left: s.x }}
          title={
            s.daily
              ? `${s.label} — high ${s.tempF}°F, peak wind ${s.windMph} mph · ${formatDayLabel(s.t + 43_200_000, tz)}`
              : `${s.label} — ${s.tempF}°F, wind ${s.windMph} mph · ${formatDateTime(s.t, tz)} ${tzAbbreviation(s.t, tz)}`
          }
        >
          <span className="rd-wx-icon">{s.icon}</span>
          <span className="rd-wx-temp">{s.tempF}°</span>
          <span className="rd-wx-wind">
            <span className="rd-wx-arrow" style={{ transform: `rotate(${s.arrowDeg}deg)` }}>
              ↑
            </span>
            {s.windMph}
          </span>
        </div>
      ))}
    </div>
  );
}
