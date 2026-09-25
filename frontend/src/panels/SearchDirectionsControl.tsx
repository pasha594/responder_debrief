/**
 * Always-visible search bar under the basemap switcher. Searching (or a
 * plain click on the map — pans never count, MapLibre only emits 'click'
 * on non-drags) drops point A; the B field then opens below and the route
 * computes automatically whenever both ends exist, the profile changes, or
 * a pin is dragged. Drive-time rings (15/30/60 min) draw automatically
 * around A. Endpoints are draggable Markers.
 */
import { createRef, useEffect, useRef, useState, type RefObject } from 'react';
import { Marker } from 'maplibre-gl';
import { searchPlaces, type PlaceHit } from '../api/geocode';
import {
  apparatusAvailable,
  fetchReachableRange,
  fetchRoute,
  type RouteProfile,
} from '../api/routing';
import { RANGE_COLORS } from '../map/layers/rangeLayer';
import { WalkError, routeWalk } from '../api/walkRouting';
import { useWalkContext } from './walk/useWalkRouting';
import { WalkRouteDetails } from './walk/WalkRouteDetails';
import { geolocationAvailable, locateOnce, watchLocation } from '../app/geolocation';
import { track } from '../app/analytics';
import { useStore } from '../state/store';
import { useMap } from '../map/MapRoot';
import { useIsDesktop } from '../utils/useMediaQuery';

const MY_LOCATION_LABEL = 'My location';
const DEBOUNCE_MS = 350;
const MIN_CHARS = 3;

/** The start (A) field. Only the fire map mounts this control, so one
 * module-level ref is enough. */
const startInput = createRef<HTMLInputElement>();

/** Cursor into the start field — the dropped pin's "Directions" hands the
 * user straight to it. Call it from the click itself, as a tap on the field
 * would: touch browsers only move focus during a user gesture. */
export function focusRouteStart(): void {
  startInput.current?.focus();
}

function fmtDistance(m: number): string {
  const mi = m / 1609.344;
  return mi >= 10 ? `${Math.round(mi)} mi` : `${mi.toFixed(1)} mi`;
}

function fmtDuration(s: number): string {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function fmtDurationShort(s: number): string {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h} h`;
}

/** Debounced Photon autocomplete input. */
function PlaceInput({
  placeholder,
  value,
  onPick,
  onClear,
  onFocusChange,
  inputRef,
}: {
  placeholder: string;
  value: string;
  onPick: (hit: PlaceHit) => void;
  onClear?: () => void;
  onFocusChange?: (focused: boolean) => void;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  const [text, setText] = useState(value);
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const map = useMap();

  useEffect(() => setText(value), [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const mapCenter = (): [number, number] | null => {
    if (!map) return null;
    const c = map.getCenter();
    return [c.lng, c.lat];
  };

  const runSearch = async (q: string) => {
    const mySeq = ++seq.current;
    try {
      const results = await searchPlaces(q, mapCenter());
      if (mySeq !== seq.current) return;
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
      seq.current++;
      setHits([]);
      setOpen(false);
      if (q.trim() === '') onClear?.();
      return;
    }
    timer.current = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
  };

  const pick = (h: PlaceHit) => {
    if (timer.current) clearTimeout(timer.current);
    seq.current++;
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

  return (
    <div className="rd-place-input">
      <input
        ref={inputRef}
        type="text"
        value={text}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => void onKeyDown(e)}
        onFocus={() => {
          setOpen(hits.length > 0);
          onFocusChange?.(true);
        }}
        onBlur={() => {
          setTimeout(() => setOpen(false), 150);
          onFocusChange?.(false);
        }}
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

function TargetIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
    </svg>
  );
}

function CarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11v6a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-6zm2.2-4L6 11h12l-1.2-4a1 1 0 0 0-.9-.7H8.1a1 1 0 0 0-.9.7zM7.5 14.5a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5zm9 0a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5z" />
    </svg>
  );
}

function TruckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M2 6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v8h1.2l1.3-3.2a1 1 0 0 1 .9-.6H20a2 2 0 0 1 2 2v4a1 1 0 0 1-1 1h-1.3a2.2 2.2 0 0 1-4.2 0H8.7a2.2 2.2 0 0 1-4.2 0H3a1 1 0 0 1-1-1V6zm4.6 12.2a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm10.1 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM17.7 12l-.8 2H20v-1.7a.3.3 0 0 0-.3-.3h-2z" />
    </svg>
  );
}

function WalkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M13.2 5.4a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4zM9.6 22l1.5-6.6 1.7 1.6V22h2v-6.2l-1.9-1.9.6-2.8A5 5 0 0 0 17 13v-1.9a3.4 3.4 0 0 1-2.7-1.5l-.9-1.5a1.9 1.9 0 0 0-1.6-.9c-.25 0-.48.04-.7.12L8 8.3V12h1.9V9.6l1.2-.5-1.1 5.3L7.4 21l2.2 1z" />
    </svg>
  );
}

const MODES: { p: RouteProfile; label: string; Icon: () => JSX.Element }[] = [
  { p: 'drive', label: 'Drive', Icon: CarIcon },
  { p: 'apparatus', label: 'Apparatus', Icon: TruckIcon },
  { p: 'hike', label: 'Walk', Icon: WalkIcon },
];

function endpointEl(which: 'a' | 'b'): HTMLElement {
  const el = document.createElement('div');
  const inner = document.createElement('div');
  inner.className = `rd-route-pin rd-route-pin--${which}`;
  inner.textContent = which === 'a' ? 'A' : 'B';
  el.appendChild(inner);
  return el;
}

export function SearchDirectionsControl() {
  const map = useMap();
  // phones get a compact "Search" pill that widens while it's in use (CSS)
  const isDesktop = useIsDesktop();
  const directions = useStore((s) => s.directions);
  const range = useStore((s) => s.range);
  const actions = useStore((s) => s.actions);
  const [routeError, setRouteError] = useState<string | null>(null);
  const rangeSeq = useRef(0);
  const [ringsOn, setRingsOn] = useState(false);
  const tracking = useStore((st) => st.location.tracking);
  const locationFix = useStore((st) => st.location.coords);
  const [locating, setLocating] = useState(false);
  const locMarker = useRef<Marker | null>(null);
  const stopWatch = useRef<(() => void) | null>(null);
  const markers = useRef<{ a: Marker | null; b: Marker | null }>({ a: null, b: null });
  const routeSeq = useRef(0);

  // A target is "active" when its search box holds the user's location;
  // dragging or re-searching rewrites the label and deactivates it.
  const aIsMyLoc = directions.a?.label === MY_LOCATION_LABEL;
  const bIsMyLoc = directions.b?.label === MY_LOCATION_LABEL;
  const dotShown = tracking || aIsMyLoc || bIsMyLoc;

  // ---- live location: watch while any target is active; pulsing dot follows fixes ----
  useEffect(() => {
    if (!dotShown) {
      stopWatch.current?.();
      stopWatch.current = null;
      const st = useStore.getState();
      if (st.location.coords) st.actions.setLocationTracking(false);
      return;
    }
    setLocating(true);
    stopWatch.current = watchLocation(
      (fix) => {
        setLocating(false);
        useStore.getState().actions.setLocationFix(fix.coords, fix.accuracy);
      },
      () => {
        setLocating(false);
        useStore.getState().actions.showToast(
          'Location unavailable — check browser permissions',
        );
        useStore.getState().actions.setLocationTracking(false);
      },
    );
    return () => {
      stopWatch.current?.();
      stopWatch.current = null;
    };
  }, [dotShown]);

  const centeredOnce = useRef(false);
  useEffect(() => {
    if (!map) return;
    if (!locationFix) {
      locMarker.current?.remove();
      locMarker.current = null;
      centeredOnce.current = false;
      return;
    }
    if (!locMarker.current) {
      const el = document.createElement('div');
      const dot = document.createElement('div');
      dot.className = 'rd-loc-dot';
      el.appendChild(dot);
      locMarker.current = new Marker({ element: el }).setLngLat(locationFix).addTo(map);
    } else {
      locMarker.current.setLngLat(locationFix);
    }
    if (!centeredOnce.current) {
      centeredOnce.current = true;
      map.flyTo({ center: locationFix, zoom: Math.max(map.getZoom(), 12), duration: 800 });
    }
  }, [map, locationFix]);

  const useMyLocation = (which: 'a' | 'b') => async () => {
    try {
      const fix = await locateOnce();
      actions.setDirectionsPoint(which, { coords: fix.coords, label: MY_LOCATION_LABEL });
      track('location_used', { context: which });
    } catch {
      actions.showToast('Location unavailable — check browser permissions');
    }
  };

  // ---- draggable endpoint markers follow the store; dragend re-routes ----
  useEffect(() => {
    if (!map) return;
    for (const which of ['a', 'b'] as const) {
      const point = directions[which];
      const existing = markers.current[which];
      if (!point) {
        existing?.remove();
        markers.current[which] = null;
        continue;
      }
      if (existing) {
        existing.setLngLat(point.coords);
      } else {
        const m = new Marker({ element: endpointEl(which), draggable: true })
          .setLngLat(point.coords)
          .addTo(map);
        m.on('dragend', () => {
          const ll = m.getLngLat();
          useStore.getState().actions.setDirectionsPoint(which, {
            coords: [ll.lng, ll.lat],
            label: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`,
          });
        });
        markers.current[which] = m;
      }
    }
  }, [map, directions]);

  useEffect(() => {
    const current = markers.current;
    return () => {
      current.a?.remove();
      current.b?.remove();
      current.a = null;
      current.b = null;
    };
  }, []);

  // ---- all-mode routing: when both ends exist, fetch every profile in
  // parallel (Google-style times row); the ACTIVE profile's result becomes
  // the drawn route. Profile switches apply instantly from cache. Walk runs
  // in its own effect (below): it also reruns when the fire's routing
  // bundle or latest perimeter resolves, which must not refetch the drive
  // engines. Offline, Drive/Apparatus say so instead of "no route". ----
  type ModeState =
    | import('../api/routing').RouteResult
    | 'pending'
    | 'failed'
    | 'offline'
    | { error: string; alternative?: import('../api/routing').RouteResult };
  const [modes, setModes] = useState<Partial<Record<RouteProfile, ModeState>>>({});
  const endpointsKey = `${directions.a?.coords}|${directions.b?.coords}`;
  const online = useStore((s) => s.offline.online);
  const walk = useWalkContext();
  const walkSeq = useRef(0);
  /** True while a Walk rerun is in flight: its cached result is stale (older
   * endpoints / perimeter / avoid setting) and must not be re-applied. */
  const hikeStale = useRef(false);
  const modeError = (p: RouteProfile, st: ModeState | undefined): string | null => {
    if (st === 'offline') return 'Needs a connection — Walk works offline inside the fire\'s routing area.';
    if (st && typeof st === 'object' && 'error' in st) return st.error;
    if (st === 'failed') {
      return p === 'apparatus'
        ? 'No apparatus-legal route found for these points.'
        : 'No route found — try different points.';
    }
    return null;
  };

  const applyRoute = (result: import('../api/routing').RouteResult) => {
    setRouteError(null);
    actions.setDirectionsRoute(result);
    if (map) {
      let w = Infinity, sMin = Infinity, e = -Infinity, n = -Infinity;
      for (const [x, y] of result.geometry.coordinates) {
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < sMin) sMin = y;
        if (y > n) n = y;
      }
      const cw = map.getContainer().clientWidth;
      const pad = cw > 800
        ? { top: 80, bottom: 140, left: 80, right: 440 }
        : { top: 60, bottom: 120, left: 24, right: 24 };
      map.fitBounds([[w, sMin], [e, n]], { padding: pad, duration: 800 });
    }
  };

  useEffect(() => {
    const mySeq = ++routeSeq.current;
    const { a, b } = directions;
    if (!a || !b) {
      setModes({});
      return;
    }
    const profiles: RouteProfile[] = apparatusAvailable
      ? ['drive', 'apparatus', 'hike']
      : ['drive', 'hike'];
    setModes(Object.fromEntries(profiles.map((p) => [p, 'pending'])));
    setRouteError(null);
    track('directions_requested', { modes: profiles.length });
    for (const p of profiles) {
      if (p === 'hike') continue; // the Walk effect owns it
      if (!online) {
        setModes((m) => ({ ...m, [p]: 'offline' }));
        continue;
      }
      void fetchRoute(a.coords, b.coords, p)
        .then((result) => {
          if (mySeq !== routeSeq.current) return;
          setModes((m) => ({ ...m, [p]: result }));
          if (useStore.getState().directions.profile === p) applyRoute(result);
        })
        .catch(() => {
          if (mySeq !== routeSeq.current) return;
          setModes((m) => ({ ...m, [p]: 'failed' }));
          if (useStore.getState().directions.profile === p) {
            setRouteError(
              p === 'apparatus'
                ? 'No apparatus-legal route found for these points.'
                : 'No route found — try different points.',
            );
          }
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpointsKey, online]);

  // ---- Walk: the offline off-road router inside the fire's routing area,
  // the online foot engines elsewhere (api/walkRouting). ----
  useEffect(() => {
    const mySeq = ++walkSeq.current;
    const { a, b } = directions;
    if (!a || !b) return;
    hikeStale.current = true;
    setModes((m) => ({ ...m, hike: 'pending' }));
    if (useStore.getState().directions.profile === 'hike') {
      // never leave a route computed for other inputs on screen
      actions.setDirectionsRoute(null);
      setRouteError(null);
    }
    void routeWalk(a.coords, b.coords, walk.ctx())
      .then((result) => {
        if (mySeq !== walkSeq.current) return;
        hikeStale.current = false;
        setModes((m) => ({ ...m, hike: result }));
        if (useStore.getState().directions.profile === 'hike') applyRoute(result);
        if (result.engine === 'offroad') {
          track('walk_route_computed', {
            engine: result.engine,
            offline: !navigator.onLine,
            ms_bucket: (result.provenance?.ms ?? 0) < 250 ? '<250'
              : (result.provenance?.ms ?? 0) < 1000 ? '<1000' : (result.provenance?.ms ?? 0) < 3000 ? '<3000' : '>=3000',
            avoided_perimeter: !!result.provenance?.avoidPerimeter,
          });
        }
      })
      .catch((err: unknown) => {
        if (mySeq !== walkSeq.current) return;
        if (err instanceof WalkError && err.code === 'superseded') return;
        hikeStale.current = false;
        const state: ModeState = err instanceof WalkError
          ? { error: err.message, alternative: err.alternative }
          : 'failed';
        setModes((m) => ({ ...m, hike: state }));
        if (err instanceof WalkError) track('walk_route_failed', { code: err.code });
        if (useStore.getState().directions.profile === 'hike') setRouteError(modeError('hike', state));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpointsKey, walk.key]);

  // profile switch: apply from cache instantly
  useEffect(() => {
    const cached = modes[directions.profile];
    if (directions.route || !directions.a || !directions.b) return;
    if (directions.profile === 'hike' && hikeStale.current) return;
    const err = modeError(directions.profile, cached);
    if (err) setRouteError(err);
    else if (cached && typeof cached === 'object' && !('error' in cached)) applyRoute(cached);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directions.profile, directions.route, modes]);

  // ---- drive-time rings: opt-in toggle, following A while enabled ----
  useEffect(() => {
    const a = directions.a;
    const mySeq = ++rangeSeq.current;
    if (!a || !ringsOn || directions.profile === 'hike') {
      actions.setRangeRings([]);
      return;
    }
    void (async () => {
      try {
        const { rings, engine } = await fetchReachableRange(a.coords);
        if (mySeq !== rangeSeq.current) return;
        actions.setRangeRings(rings);
        track('range_requested', { engine });
      } catch {
        if (mySeq === rangeSeq.current) actions.setRangeRings([]);
      }
    })();
  }, [directions.a, directions.profile, ringsOn, actions]);

  const route = directions.route;
  const showDestination = !!directions.a || !!directions.b;

  const setPoint = (which: 'a' | 'b') => (hit: PlaceHit) => {
    if (which === 'a') track('place_searched', { kind: hit.kind });
    actions.setDirectionsPoint(which, { coords: hit.coords, label: hit.label });
    if (which === 'a' && map && !useStore.getState().directions.b) {
      map.flyTo({ center: hit.coords, zoom: Math.max(map.getZoom(), 11), duration: 800 });
    }
  };

  const clearAll = () => {
    actions.clearDirections();
    setRouteError(null);
  };

  return (
    <div className="rd-sd-control">
      <div className="rd-sd-toprow">
        <div className="rd-sd-card rd-sd-bar">
          {showDestination && (
            <div className="rd-sd-row rd-sd-modes">
              {MODES.map(({ p, label, Icon }) => {
                const gated = p === 'apparatus' && !apparatusAvailable;
                const state = modes[p];
                // Every mode shows its typical time (Walk: crew pace).
                const time =
                  state === 'pending'
                    ? '…'
                    : state === 'failed' || state === 'offline' || (state && 'error' in state)
                      ? '—'
                      : state
                        ? fmtDurationShort(state.durationS)
                        : null;
                return (
                  <button
                    key={p}
                    type="button"
                    disabled={gated}
                    className={`rd-mode${directions.profile === p ? ' rd-mode--on' : ''}`}
                    title={
                      gated
                        ? 'Needs the TomTom key'
                        : state === 'offline'
                          ? 'Needs a connection'
                          : p === 'apparatus'
                            ? 'Truck routing with typical engine/tender dimensions'
                            : p === 'hike'
                              ? "Walk: trail + cross-country model inside this fire's routing area (works offline); online engine elsewhere"
                              : label
                    }
                    aria-label={label}
                    onClick={() => actions.setDirectionsProfile(p)}
                  >
                    <Icon />
                    {time && <span className="rd-mode-time">{time}</span>}
                  </button>
                );
              })}
              <span className="rd-sd-spacer" />
              <button
                type="button"
                className="rd-mini-btn rd-sd-close"
                title="Clear"
                onClick={clearAll}
              >
                ✕
              </button>
            </div>
          )}

          <div className="rd-sd-row">
            {showDestination && (
              <span className="rd-route-pin rd-route-pin--a rd-sd-badge">A</span>
            )}
            <PlaceInput
              inputRef={startInput}
              placeholder={isDesktop ? 'Search place or coordinates' : 'Search'}
              value={directions.a?.label ?? ''}
              onPick={setPoint('a')}
              onClear={() => actions.setDirectionsPoint('a', null)}
              onFocusChange={(f) => actions.setDirectionsArmed(f)}
            />
            {showDestination && geolocationAvailable() && (
              <button
                type="button"
                className={`rd-mini-btn rd-loc-mini${aIsMyLoc ? ' rd-mini-btn--on' : ''}`}
                title="Use my current location as the start"
                onClick={() => void useMyLocation('a')()}
              >
                <TargetIcon />
              </button>
            )}
          </div>

          {showDestination && (
            <>
              <div className="rd-sd-row">
                <span className="rd-route-pin rd-route-pin--b rd-sd-badge">B</span>
                <PlaceInput
                  placeholder="Search place or coordinates"
                  value={directions.b?.label ?? ''}
                  onPick={setPoint('b')}
                  onClear={() => actions.setDirectionsPoint('b', null)}
                  onFocusChange={(f) => actions.setDirectionsArmed(f)}
                />
                {geolocationAvailable() && (
                  <button
                    type="button"
                    className={`rd-mini-btn rd-loc-mini${bIsMyLoc ? ' rd-mini-btn--on' : ''}`}
                    title="Use my current location as the destination"
                    onClick={() => void useMyLocation('b')()}
                  >
                    <TargetIcon />
                  </button>
                )}
              </div>
              {!directions.b && (
                <div className="rd-sd-note">Click the map or search to set the destination.</div>
              )}
              {walk.status && directions.profile === 'hike' && modes.hike === 'pending' && (
                <div className="rd-sd-note">{walk.status}</div>
              )}
              {routeError && <div className="rd-sd-note rd-sd-error">{routeError}</div>}
              {routeError && directions.profile === 'hike' && (() => {
                const st = modes.hike;
                const alt = st && typeof st === 'object' && 'error' in st ? st.alternative : undefined;
                return alt ? (
                  <button type="button" className="rd-mini-btn rd-walk-alt"
                    onClick={() => applyRoute(alt)}>
                    Show the route through the perimeter
                  </button>
                ) : null;
              })()}
              {route?.legs && <WalkRouteDetails route={route} />}
              {route && !route.legs && (
                <div className="rd-sd-result">
                  <div className="rd-sd-summary">
                    <strong>{fmtDuration(route.durationS)}</strong> · {fmtDistance(route.distanceM)}
                    {route.trafficDelayS != null && route.trafficDelayS > 60 && (
                      <span className="rd-sd-traffic"> · +{fmtDuration(route.trafficDelayS)} traffic</span>
                    )}
                    {directions.profile !== 'hike' && (
                      <label className="rd-rings-toggle rd-rings-inline">
                        <input
                          type="checkbox"
                          checked={ringsOn}
                          onChange={() => setRingsOn(!ringsOn)}
                        />
                        <span>Show isochrones</span>
                      </label>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {showDestination && !route && directions.profile !== 'hike' && (
            <div className="rd-sd-row rd-sd-rangelegend">
              <label className="rd-rings-toggle">
                <input
                  type="checkbox"
                  checked={ringsOn}
                  onChange={() => setRingsOn(!ringsOn)}
                />
                <span>Show isochrones</span>
              </label>
            </div>
          )}
          {ringsOn && range.rings.length > 0 && (
            <div className="rd-sd-row rd-sd-rangelegend">
              <div className="rd-sd-profiles rd-range-legend">
                {[15, 30, 60].map((m) => (
                  <span key={m} className="rd-range-key">
                    <span className="rd-hist-chip" style={{ background: RANGE_COLORS[m] }} />
                    {m}m
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        {geolocationAvailable() && (
          <button
            type="button"
            className={`rd-mini-btn rd-loc-btn${tracking ? ' rd-mini-btn--on' : ''}`}
            title={
              aIsMyLoc || bIsMyLoc
                ? 'Center the map on my location'
                : tracking
                  ? 'Stop showing my location'
                  : 'Show my location'
            }
            onClick={() => {
              const st = useStore.getState();
              if (aIsMyLoc || bIsMyLoc) {
                const fix = st.location.coords;
                if (fix && map) {
                  map.flyTo({ center: fix, zoom: Math.max(map.getZoom(), 12), duration: 600 });
                }
                return;
              }
              const on = !st.location.tracking;
              actions.setLocationTracking(on);
              if (on) track('location_used', { context: 'map' });
              if (!on) centeredOnce.current = false;
            }}
          >
            {locating ? '…' : <TargetIcon />}
          </button>
        )}
      </div>
    </div>
  );
}
