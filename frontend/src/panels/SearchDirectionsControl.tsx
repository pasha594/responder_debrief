/**
 * Map-corner control: location search (Photon autocomplete + raw
 * coordinates) and A→B directions (drive with live-traffic ETA when the
 * TomTom key ships; hike on OSM trails). Sits under the basemap switcher.
 */
import { useEffect, useRef, useState } from 'react';
import { Marker } from 'maplibre-gl';
import { searchPlaces, type PlaceHit } from '../api/geocode';
import {
  apparatusAvailable,
  fetchReachableRange,
  fetchRoute,
  type RouteProfile,
} from '../api/routing';
import { RANGE_COLORS } from '../map/layers/rangeLayer';
import { track } from '../app/analytics';
import { useStore } from '../state/store';
import { useMap } from '../map/MapRoot';

const DEBOUNCE_MS = 350;
const MIN_CHARS = 3;

function fmtDistance(m: number): string {
  const mi = m / 1609.344;
  return mi >= 10 ? `${Math.round(mi)} mi` : `${mi.toFixed(1)} mi`;
}

function fmtDuration(s: number): string {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Debounced Photon autocomplete input. */
function PlaceInput({
  placeholder,
  value,
  onPick,
}: {
  placeholder: string;
  value: string;
  onPick: (hit: PlaceHit) => void;
}) {
  const [text, setText] = useState(value);
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  useEffect(() => setText(value), [value]);
  useEffect(() => () => {
    // pending debounce must not fire a wasted request after unmount
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const runSearch = async (q: string) => {
    const mySeq = ++seq.current;
    try {
      const results = await searchPlaces(q, mapCenter());
      if (mySeq !== seq.current) return; // a newer query superseded this one
      setHits(results);
      setOpen(results.length > 0);
      return results;
    } catch {
      if (mySeq === seq.current) setHits([]);
    }
  };

  const onChange = (q: string) => {
    setText(q);
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < MIN_CHARS) {
      seq.current++; // invalidate anything in flight
      setHits([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
  };

  const pick = (h: PlaceHit) => {
    if (timer.current) clearTimeout(timer.current);
    seq.current++; // nothing in flight may reopen the list over the choice
    setText(h.label);
    setOpen(false);
    onPick(h);
  };

  const onKeyDown = async (e: { key: string }) => {
    if (e.key !== 'Enter') return;
    if (open && hits.length) {
      pick(hits[0]);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    if (text.trim().length >= MIN_CHARS) {
      const results = await runSearch(text);
      if (results?.length) pick(results[0]);
    }
  };

  const map = useMap();
  const mapCenter = (): [number, number] | null => {
    if (!map) return null;
    const c = map.getCenter();
    return [c.lng, c.lat];
  };

  return (
    <div className="rd-place-input">
      <input
        type="text"
        value={text}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => void onKeyDown(e)}
        onFocus={() => setOpen(hits.length > 0)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <ul className="rd-place-hits">
          {hits.map((h, i) => (
            <li key={i}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(h)}
              >
                <span className="rd-place-name">{h.label}</span>
                {h.detail && <span className="rd-place-detail">{h.detail}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SearchDirectionsControl() {
  const map = useMap();
  const [mode, setMode] = useState<'closed' | 'search' | 'directions' | 'range'>('closed');
  const range = useStore((s) => s.range);
  const [ranging, setRanging] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const directions = useStore((s) => s.directions);
  const actions = useStore((s) => s.actions);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const searchMarker = useRef<Marker | null>(null);

  // A dropped search pin follows the control's lifecycle.
  useEffect(() => {
    return () => {
      searchMarker.current?.remove();
      searchMarker.current = null;
    };
  }, []);

  const dropSearchPin = (hit: PlaceHit) => {
    if (!map) return;
    track('place_searched', { kind: hit.kind });
    searchMarker.current?.remove();
    const el = document.createElement('div');
    const inner = document.createElement('div');
    inner.className = 'rd-search-pin';
    el.appendChild(inner);
    searchMarker.current = new Marker({ element: el }).setLngLat(hit.coords).addTo(map);
    map.flyTo({ center: hit.coords, zoom: Math.max(map.getZoom(), 12), duration: 800 });
  };

  const go = async () => {
    const { a, b, profile } = useStore.getState().directions;
    if (!a || !b) return;
    setRouting(true);
    setRouteError(null);
    try {
      const route = await fetchRoute(a.coords, b.coords, profile);
      actions.setDirectionsRoute(route);
      track('directions_requested', { profile, engine: route.engine });
      if (map) {
        // loop, never spread: long routes have tens of thousands of vertices
        let w = Infinity, sMin = Infinity, e = -Infinity, n = -Infinity;
        for (const [x, y] of route.geometry.coordinates) {
          if (x < w) w = x;
          if (x > e) e = x;
          if (y < sMin) sMin = y;
          if (y > n) n = y;
        }
        // padding wider than the canvas makes fitBounds a silent no-op —
        // reserve the sidebar strip only when there is room for one
        const cw = map.getContainer().clientWidth;
        const pad = cw > 800
          ? { top: 80, bottom: 140, left: 80, right: 440 }
          : { top: 60, bottom: 120, left: 24, right: 24 };
        map.fitBounds([[w, sMin], [e, n]], { padding: pad, duration: 800 });
      }
    } catch {
      setRouteError(
        useStore.getState().directions.profile === 'apparatus'
          ? 'No apparatus-legal route found for these points.'
          : 'No route found — try different points.',
      );
    } finally {
      setRouting(false);
    }
  };

  const goRange = async () => {
    const origin = useStore.getState().range.origin;
    if (!origin) return;
    setRanging(true);
    setRangeError(null);
    try {
      const { rings, engine } = await fetchReachableRange(origin.coords);
      actions.setRangeRings(rings);
      track('range_requested', { engine });
      if (map && rings.length) {
        let w = Infinity, sMin = Infinity, e = -Infinity, n = -Infinity;
        for (const ring of rings) {
          for (const [x, y] of ring.polygon.coordinates[0] ?? []) {
            if (x < w) w = x;
            if (x > e) e = x;
            if (y < sMin) sMin = y;
            if (y > n) n = y;
          }
        }
        const cw = map.getContainer().clientWidth;
        const pad = cw > 800
          ? { top: 80, bottom: 140, left: 80, right: 440 }
          : { top: 60, bottom: 120, left: 24, right: 24 };
        map.fitBounds([[w, sMin], [e, n]], { padding: pad, duration: 800 });
      }
    } catch {
      setRangeError('Could not compute the range for this point.');
    } finally {
      setRanging(false);
    }
  };

  const setPoint = (which: 'a' | 'b') => (hit: PlaceHit) =>
    actions.setDirectionsPoint(which, { coords: hit.coords, label: hit.label });

  // Armed pick mode must not outlive the card — a later map click would
  // silently overwrite an endpoint and wipe the rendered route.
  useEffect(() => {
    const picking = useStore.getState().directions.picking;
    const belongs =
      (picking === 'range' && mode === 'range') ||
      ((picking === 'a' || picking === 'b') && mode === 'directions');
    if (picking && !belongs) {
      actions.setDirectionsPicking(null);
    }
    return () => {
      if (useStore.getState().directions.picking) actions.setDirectionsPicking(null);
    };
  }, [mode, actions]);

  const route = directions.route;

  return (
    <div className="rd-sd-control">
      <div className="rd-sd-buttons">
        <button
          type="button"
          className={`rd-mini-btn${mode === 'search' ? ' rd-mini-btn--on' : ''}`}
          title="Search for a location"
          onClick={() => setMode(mode === 'search' ? 'closed' : 'search')}
        >
          ⌕
        </button>
        <button
          type="button"
          className={`rd-mini-btn${mode === 'directions' ? ' rd-mini-btn--on' : ''}`}
          title="Directions"
          onClick={() => setMode(mode === 'directions' ? 'closed' : 'directions')}
        >
          ⇄
        </button>
        <button
          type="button"
          className={`rd-mini-btn${mode === 'range' ? ' rd-mini-btn--on' : ''}`}
          title="Drive-time range from a point"
          onClick={() => setMode(mode === 'range' ? 'closed' : 'range')}
        >
          ◔
        </button>
      </div>

      {mode === 'search' && (
        <div className="rd-sd-card">
          <PlaceInput placeholder="Search place or 47.6, -120.3" value="" onPick={dropSearchPin} />
        </div>
      )}

      {mode === 'directions' && (
        <div className="rd-sd-card">
          <div className="rd-sd-row">
            <PlaceInput placeholder="From — search or pick on map" value={directions.a?.label ?? ''} onPick={setPoint('a')} />
            <button
              type="button"
              className={`rd-mini-btn${directions.picking === 'a' ? ' rd-mini-btn--on' : ''}`}
              title="Pick start on the map"
              onClick={() => actions.setDirectionsPicking(directions.picking === 'a' ? null : 'a')}
            >
              ⌖
            </button>
          </div>
          <div className="rd-sd-row">
            <PlaceInput placeholder="To — search or pick on map" value={directions.b?.label ?? ''} onPick={setPoint('b')} />
            <button
              type="button"
              className={`rd-mini-btn${directions.picking === 'b' ? ' rd-mini-btn--on' : ''}`}
              title="Pick destination on the map"
              onClick={() => actions.setDirectionsPicking(directions.picking === 'b' ? null : 'b')}
            >
              ⌖
            </button>
          </div>
          <div className="rd-sd-row rd-sd-actions">
            <div className="rd-sd-profiles">
              {(['drive', 'apparatus', 'hike'] as RouteProfile[]).map((p) => {
                const gated = p === 'apparatus' && !apparatusAvailable;
                return (
                  <button
                    key={p}
                    type="button"
                    disabled={gated}
                    className={`rd-chip${directions.profile === p ? ' rd-chip--on' : ''}`}
                    title={
                      p === 'apparatus'
                        ? gated
                          ? 'Needs the TomTom key'
                          : 'Truck routing with typical engine/tender dimensions'
                        : undefined
                    }
                    onClick={() => actions.setDirectionsProfile(p)}
                  >
                    {p === 'drive' ? 'Drive' : p === 'apparatus' ? 'Apparatus' : 'Hike'}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="rd-mini-btn"
              title="Clear route"
              onClick={() => actions.clearDirections()}
            >
              ✕
            </button>
            <button
              type="button"
              className="rd-go-btn"
              disabled={!directions.a || !directions.b || routing}
              onClick={() => void go()}
            >
              {routing ? '…' : 'Go'}
            </button>
          </div>
          {directions.picking && (
            <div className="rd-sd-note">Click the map to set the {directions.picking === 'a' ? 'start' : 'destination'}.</div>
          )}
          {routeError && <div className="rd-sd-note rd-sd-error">{routeError}</div>}
          {route && (
            <div className="rd-sd-result">
              <div className="rd-sd-summary">
                <strong>{fmtDuration(route.durationS)}</strong> · {fmtDistance(route.distanceM)}
                {route.trafficDelayS != null && route.trafficDelayS > 60 && (
                  <span className="rd-sd-traffic"> · +{fmtDuration(route.trafficDelayS)} traffic</span>
                )}
              </div>
              <details className="rd-sd-steps">
                <summary>{route.steps.length} steps</summary>
                <ol>
                  {route.steps.map((s, i) => (
                    <li key={i}>
                      {s.text}
                      {s.distanceM > 0 && <span className="rd-sd-stepdist"> — {fmtDistance(s.distanceM)}</span>}
                    </li>
                  ))}
                </ol>
              </details>
              <div className="rd-sd-note">
                Routes reflect map data, not fire closures — verify with incident traffic control.
              </div>
            </div>
          )}
        </div>
      )}

      {mode === 'range' && (
        <div className="rd-sd-card">
          <div className="rd-sd-row">
            <PlaceInput
              placeholder="From — search or pick on map"
              value={range.origin?.label ?? ''}
              onPick={(h) => actions.setRangeOrigin({ coords: h.coords, label: h.label })}
            />
            <button
              type="button"
              className={`rd-mini-btn${directions.picking === 'range' ? ' rd-mini-btn--on' : ''}`}
              title="Pick the origin on the map"
              onClick={() =>
                actions.setDirectionsPicking(directions.picking === 'range' ? null : 'range')
              }
            >
              ⌖
            </button>
          </div>
          <div className="rd-sd-row rd-sd-actions">
            <div className="rd-sd-profiles rd-range-legend">
              {[15, 30, 60].map((m) => (
                <span key={m} className="rd-range-key">
                  <span className="rd-hist-chip" style={{ background: RANGE_COLORS[m] }} />
                  {m}m
                </span>
              ))}
            </div>
            <button
              type="button"
              className="rd-mini-btn"
              title="Clear rings"
              onClick={() => actions.setRangeOrigin(null)}
            >
              ✕
            </button>
            <button
              type="button"
              className="rd-go-btn"
              disabled={!range.origin || ranging}
              onClick={() => void goRange()}
            >
              {ranging ? '…' : 'Go'}
            </button>
          </div>
          {directions.picking === 'range' && (
            <div className="rd-sd-note">Click the map to set the origin.</div>
          )}
          {rangeError && <div className="rd-sd-note rd-sd-error">{rangeError}</div>}
          {range.rings.length > 0 && (
            <div className="rd-sd-note">
              Drive-time reach at current conditions — not a fire-closure map.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
