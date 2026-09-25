/**
 * Walk route card. Collapsed (the default) it is one line: the typical time,
 * distance and climb, plus a ⚠ count when the route carries warnings, so a
 * safety note is never silently hidden. Expanded it adds the trail vs
 * cross-country split, the cross-country vegetation breakdown, the notes,
 * the perimeter toggle and the steps. The time is Sullivan 2020's middle
 * tertile for hotshot crews with packs; owner call: no fast or slow bound
 * anywhere in the UI (the data keeps durationRangeS). The OSM (ODbL) and
 * agency credit is in the map's attribution control while Walk's routing
 * area is shown (routingAreaLayer).
 */
import { useState } from 'react';
import type { RouteResult } from '../../api/routing';
import { fmtFeet, fmtMiles, totals } from '../../routing/legs';
import { vegClass } from '../../routing/vegClasses';
import { useStore } from '../../state/store';
import './walk.css';

/** Notes the card leaves out (owner call): the weighted-search caveat. */
const HIDDEN_NOTES = new Set(['WEIGHTED']);

/** Every "the route meets the fire" note — A or B inside or near the
 * perimeter, the line crossing it or passing close — reads as this one line
 * (owner call: one plain warning, not one per pin). */
const PERIM_CODES = new Set(['CROSSES_PERIM', 'NEAR_PERIM', 'ENDPOINT_IN_PERIM', 'ENDPOINT_NEAR_PERIM']);
const PERIM_NOTE = { level: 'warn' as const, code: 'PERIM', text: 'This route goes near the latest fire perimeter.' };

/** Whole minutes, like the Walk mode button, so the two always agree. */
function fmtTime(s: number): string {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min`;
  const m = min % 60;
  return m ? `${Math.floor(min / 60)} h ${m} min` : `${Math.floor(min / 60)} h`;
}

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Survives route recomputes (drags, avoid toggles) within the session. */
let detailsOpenPref = false;

export function WalkRouteDetails({ route, defaultOpen }: { route: RouteResult; defaultOpen?: boolean }) {
  const [open, setOpenState] = useState(defaultOpen ?? detailsOpenPref);
  const setOpen = (v: boolean) => {
    detailsOpenPref = v;
    setOpenState(v);
  };
  const [stepsOpen, setStepsOpen] = useState(false);
  const avoid = useStore((s) => s.directions.avoidPerimeter);
  const setAvoid = useStore((s) => s.actions.setAvoidPerimeter);
  const legs = route.legs ?? [];
  const t = totals(legs);
  const xc = legs.filter((l) => l.kind === 'xc');
  const vegM: Record<number, number> = {};
  let streams = 0;
  for (const l of xc) {
    for (const [k, m] of Object.entries(l.vegM ?? {})) vegM[+k] = (vegM[+k] ?? 0) + m;
    streams += l.streamCrossings ?? 0;
  }
  const vegList = Object.entries(vegM).sort((a, b) => b[1] - a[1]).filter(([, m]) => m >= 20);
  const pv = route.provenance;
  const gapM = legs.filter((l) => l.kind === 'gap').reduce((s, l) => s + l.distanceM, 0);
  const trailPct = t.distanceM ? Math.round((100 * t.trailM) / t.distanceM) : 0;
  const raw = (route.notes ?? []).filter((n) => !HIDDEN_NOTES.has(n.code));
  const notes = raw.some((n) => PERIM_CODES.has(n.code))
    ? [PERIM_NOTE, ...raw.filter((n) => !PERIM_CODES.has(n.code))]
    : raw;
  const warnings = notes.filter((n) => n.level === 'warn').length;
  return (
    <div className={open ? 'rd-walk rd-walk--open' : 'rd-walk'}>
      <button
        type="button"
        className="rd-walk-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={open ? 'Hide route details' : 'Show route details'}
      >
        <span className="rd-walk-stats">
          <strong>{fmtTime(route.durationS)}</strong>
          <span className="rd-walk-muted">{fmtMiles(t.distanceM)}</span>
          {(t.climbM >= 3 || t.descentM >= 3) && (
            <span className="rd-walk-muted">↑ {fmtFeet(t.climbM)} ↓ {fmtFeet(t.descentM)}</span>
          )}
        </span>
        {!open && warnings > 0 && (
          <span className="rd-walk-warncount" aria-label={`${warnings} warning${warnings > 1 ? 's' : ''}`}>
            ⚠ {warnings}
          </span>
        )}
        <span className="rd-walk-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          <div className="rd-walk-split" aria-label="Trail and cross-country split">
            <span className="rd-walk-bar rd-walk-bar--trail" style={{ flexGrow: Math.max(1, t.trailM) }} />
            <span className="rd-walk-bar rd-walk-bar--xc" style={{ flexGrow: t.xcM }} />
          </div>
          <div className="rd-walk-items rd-walk-muted">
            <span>▬ {route.engine === 'offroad' ? 'Trail & road' : 'Online route'} {fmtMiles(t.trailM)}</span>
            {t.xcM > 0 && <span>┅ Cross-country {fmtMiles(t.xcM)}</span>}
            {route.engine === 'offroad' && <span>{trailPct}% on trail/road</span>}
          </div>
          {vegList.length > 0 && (
            <div className="rd-walk-items">
              {vegList.map(([k, m]) => (
                <span key={k}>
                  <span className="rd-hist-chip" style={{ background: vegClass(+k).color }} /> {vegClass(+k).label} {fmtMiles(m)}
                </span>
              ))}
              {streams > 0 && <span>{streams} stream crossing{streams > 1 ? 's' : ''}</span>}
            </div>
          )}
          {gapM > 0 && (
            <div className="rd-walk-muted">+ {fmtMiles(gapM)} straight-line gap to the pins, not timed</div>
          )}
          {notes.map((n) => (
            <div key={n.code + n.text} className={`rd-walk-note rd-walk-note--${n.level}`}>{n.text}</div>
          ))}
          {route.engine === 'offroad' && (
            <label className="rd-field--row rd-walk-avoid">
              <input type="checkbox" checked={avoid} onChange={(e) => setAvoid(e.target.checked)} />
              <span>
                Avoid fire perimeter
                {pv?.perimeterDate ? ` (${fmtWhen(pv.perimeterDate)}, +60 m)` : ''}
              </span>
            </label>
          )}
          <button type="button" className="rd-mini-btn" onClick={() => setStepsOpen((v) => !v)}
            aria-expanded={stepsOpen}>
            {stepsOpen ? 'Steps ▾' : 'Steps ▸'}
          </button>
          {stepsOpen && (
            <ol className="rd-walk-steps">
              {route.steps.map((s, i) => <li key={i}>{s.text}</li>)}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
