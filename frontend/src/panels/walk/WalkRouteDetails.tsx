/**
 * Walk route card: slow–fast range (slow bound first — IRPG: time escape
 * routes with your slowest person), trail vs cross-country split, the
 * cross-country vegetation breakdown, climb, notes, the perimeter toggle,
 * provenance, attribution and steps. "Cross-country legs are modeled, not
 * scouted." is always shown on a modeled route and cannot be dismissed.
 */
import { useState } from 'react';
import type { RouteResult } from '../../api/routing';
import { fmtDur, fmtFeet, fmtMiles, totals } from '../../routing/legs';
import { vegClass } from '../../routing/vegClasses';
import { useStore } from '../../state/store';
import './walk.css';

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function WalkRouteDetails({ route }: { route: RouteResult }) {
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
  const range = route.durationRangeS;
  const pv = route.provenance;
  const gapM = legs.filter((l) => l.kind === 'gap').reduce((s, l) => s + l.distanceM, 0);
  const trailPct = t.distanceM ? Math.round((100 * t.trailM) / t.distanceM) : 0;
  return (
    <div className="rd-walk">
      <div className="rd-walk-time">
        {range ? (
          <>
            <strong>up to {fmtDur(range[1])}</strong>
            <span className="rd-walk-muted"> · {fmtDur(range[0])}–{fmtDur(range[1])}, typical {fmtDur(route.durationS)}</span>
          </>
        ) : (
          <strong>{fmtDur(route.durationS)}</strong>
        )}
        <span className="rd-walk-muted"> · {fmtMiles(t.distanceM)}</span>
        {(t.climbM >= 3 || t.descentM >= 3) && (
          <span className="rd-walk-muted"> · ↑ {fmtFeet(t.climbM)} ↓ {fmtFeet(t.descentM)}</span>
        )}
      </div>
      <div className="rd-walk-split" aria-label="Trail and cross-country split">
        <span className="rd-walk-bar rd-walk-bar--trail" style={{ flexGrow: Math.max(1, t.trailM) }} />
        <span className="rd-walk-bar rd-walk-bar--xc" style={{ flexGrow: t.xcM }} />
      </div>
      <div className="rd-walk-muted">
        ▬ {route.engine === 'offroad' ? 'Trail & road' : 'Online route'} {fmtMiles(t.trailM)}
        {t.xcM > 0 && <> · ┅ Cross-country {fmtMiles(t.xcM)}</>}
        {route.engine === 'offroad' && <> · {trailPct}% on trail/road</>}
      </div>
      {vegList.length > 0 && (
        <div className="rd-walk-veg">
          Cross-country:{' '}
          {vegList.map(([k, m], i) => (
            <span key={k}>
              {i > 0 && ' · '}
              <span className="rd-hist-chip" style={{ background: vegClass(+k).color }} /> {vegClass(+k).label} {fmtMiles(m)}
            </span>
          ))}
          {streams > 0 && <> · {streams} stream crossing{streams > 1 ? 's' : ''}</>}
        </div>
      )}
      {gapM > 0 && (
        <div className="rd-walk-muted">+ {fmtMiles(gapM)} straight-line gap to the pins, not timed</div>
      )}
      {(route.modeled || route.engine === 'offroad') && (
        <div className="rd-walk-label" role="note">
          ⚠ Cross-country legs are modeled, not scouted.
          <span className="rd-walk-sub"> Times assume a loaded crew in daylight. Scout and time escape routes with your slowest person.</span>
        </div>
      )}
      {(route.notes ?? []).map((n) => (
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
      {pv && (
        <div className="rd-walk-prov">
          Terrain & trails built {fmtDay(pv.builtAt)}
          {pv.landfire ? ` · LANDFIRE ${pv.landfire}` : ''}
          {pv.osmDate ? ` · OSM ${fmtDay(pv.osmDate)}` : ''} · computed on this device in{' '}
          {(pv.ms / 1000).toFixed(1)} s
        </div>
      )}
      {route.engine === 'offroad' && (
        <div className="rd-walk-prov">
          Route data © OpenStreetMap contributors (ODbL) · USFS · BLM · NPS · LANDFIRE · USGS NHD
        </div>
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
    </div>
  );
}
