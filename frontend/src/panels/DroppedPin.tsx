/**
 * Dropped pin, Google Maps' way: on an idle map (no draw tool armed, the
 * directions flow not engaged) a plain click drops a pin and opens a card at
 * the bottom of the visible map with the spot's coordinates, its street
 * address when it has one (rare out on a fire), and Directions — which routes
 * there from the user's current location. The next click anywhere on the map
 * only dismisses the pin; the one after drops a new one. Click rules live in
 * map/pinDrop.ts.
 */
import { useEffect, useRef } from 'react';
import { Marker, type MapMouseEvent } from 'maplibre-gl';
import { useStreetAddress } from '../api/queries';
import { MY_LOCATION_LABEL, geolocationAvailable, locateOnce } from '../app/geolocation';
import { track, trackOncePer } from '../app/analytics';
import { useMap } from '../map/MapRoot';
import {
  FEATURE_LAYERS,
  clicksClaimed,
  createClickGate,
  pinClickAction,
} from '../map/pinDrop';
import { useStore } from '../state/store';

/** Long enough to tell a click from the first half of a double-click. */
const CLICK_HOLD_MS = 300;
/** Where a nudged pin's tip lands above its card, px: pin height + a gap. */
const PIN_LIFT_PX = 44;

/** The fire pins' teardrop (markerImages), smaller and neutral so it never
 * reads as a fire. Tip at bottom-center, where the click landed. */
function pinElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'rd-drop-pin';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML =
    '<svg viewBox="0 0 26 34" width="26" height="34">' +
    '<path class="rd-drop-pin-body" d="M13 33Q4.4 20.8 3.6 12.4A9.4 9.4 0 0 1 22.4 12.4Q21.6 20.8 13 33Z"/>' +
    '<circle class="rd-drop-pin-core" cx="13" cy="12.4" r="3.4"/>' +
    '</svg>';
  return el;
}

function DirectionsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M12 1.8 22.2 12 12 22.2 1.8 12Z M8 16V11.2L8.8 10.4H13.2V8.2L16.8 11.4 13.2 14.6V12.4H10V16Z"
      />
    </svg>
  );
}

export function DroppedPin() {
  const map = useMap();
  const pin = useStore((s) => s.droppedPin);
  const online = useStore((s) => s.offline.online);
  const sheetSnap = useStore((s) => s.ui.sheetSnap);
  const rail = useStore((s) => s.ui.sidebarCollapsed);
  const actions = useStore((s) => s.actions);
  const { data: address } = useStreetAddress(pin, online);
  const cardRef = useRef<HTMLElement>(null);

  // ---- map clicks: drop / dismiss, held past the double-click window ----
  useEffect(() => {
    if (!map) return;
    const gate = createClickGate(CLICK_HOLD_MS);
    const onClick = (e: MapMouseEvent) => {
      gate.click(e.point, () => {
        const st = useStore.getState();
        const layers = FEATURE_LAYERS.filter((l) => map.getLayer(l));
        const target = e.originalEvent.target as Element | null;
        const action = pinClickAction({
          claimed: clicksClaimed(st),
          pinShown: !!st.droppedPin,
          onMarker: !!target?.closest?.('.maplibregl-marker'),
          onFeature:
            layers.length > 0 && map.queryRenderedFeatures(e.point, { layers }).length > 0,
          popupOpen: !!map.getContainer().querySelector('.maplibregl-popup'),
        });
        if (action === 'none') return null;
        if (action === 'dismiss') return () => useStore.getState().actions.clearDroppedPin();
        const at: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        return () => {
          const now = useStore.getState();
          if (clicksClaimed(now)) return; // a draw tool or the search took over meanwhile
          now.actions.dropPin(at);
          trackOncePer('fire-view', 'pin_dropped');
        };
      });
    };
    // The user's own zoom or pan (a double-tap zoom starts one) — not a click.
    const onMoveStart = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) gate.cancel();
    };
    map.on('click', onClick);
    map.on('dblclick', gate.cancel);
    map.on('movestart', onMoveStart);
    return () => {
      gate.cancel();
      map.off('click', onClick);
      map.off('dblclick', gate.cancel);
      map.off('movestart', onMoveStart);
    };
  }, [map]);

  // ---- the pin: a fresh Marker per drop, so every drop replays its landing ----
  useEffect(() => {
    if (!map || !pin) return;
    const marker = new Marker({ element: pinElement(), anchor: 'bottom' })
      .setLngLat(pin)
      .addTo(map);
    return () => {
      marker.remove();
    };
  }, [map, pin]);

  // ---- the card covers the bottom of the map: nudge a pin dropped under it
  // back into view (once, at the drop — never under a user who has moved on;
  // the lift leaves room for the address line growing the card later) ----
  useEffect(() => {
    const card = cardRef.current?.getBoundingClientRect();
    if (!map || !pin || !card) return;
    const box = map.getContainer().getBoundingClientRect();
    const p = map.project(pin);
    const x = box.left + p.x;
    const halfPin = 13;
    if (x < card.left - halfPin || x > card.right + halfPin || box.top + p.y < card.top) return;
    // Slide the ground by (pin − the point now at the target spot): the pin
    // lands exactly there even on a tilted map, where pixel pans overshoot.
    const target = map.unproject([p.x, card.top - box.top - PIN_LIFT_PX]);
    const c = map.getCenter();
    map.easeTo({
      center: [c.lng + pin[0] - target.lng, c.lat + pin[1] - target.lat],
      duration: 300,
    });
  }, [map, pin]);

  // ---- Escape closes it — unless a dialog or a text field owns the key ----
  useEffect(() => {
    if (!pin) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[role="dialog"]')) return;
      if ((e.target as Element | null)?.closest?.('input, textarea, select')) return;
      useStore.getState().actions.clearDroppedPin();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pin]);

  if (!pin) return null;
  const coords = `${pin[1].toFixed(5)}, ${pin[0].toFixed(5)}`;

  // Destination = the pin (setting it clears the pin); start = my location,
  // live-followed like the search bar's own "use my location".
  const directionsHere = () => {
    track('pin_directions');
    actions.setDirectionsPoint('b', { coords: pin, label: address?.line1 ?? coords });
    const startHere = (from: [number, number]) => {
      useStore.getState().actions.setDirectionsPoint('a', { coords: from, label: MY_LOCATION_LABEL });
      track('location_used', { context: 'pin' });
    };
    const fix = useStore.getState().location.coords;
    if (fix) {
      startHere(fix);
      return;
    }
    if (!geolocationAvailable()) return; // the empty start field asks instead
    locateOnce()
      .then(({ coords: from }) => {
        // Only if this is still the route the button started, start unfilled.
        const d = useStore.getState().directions;
        if (d.b?.coords === pin && !d.a) startHere(from);
      })
      .catch(() => {
        useStore.getState().actions.showToast('Location unavailable — check browser permissions');
      });
  };

  return (
    <section
      ref={cardRef}
      className={`rd-pin-card rd-pin-card--sheet-${sheetSnap}${rail ? ' rd-pin-card--rail' : ''}`}
      aria-label="Dropped pin"
    >
      <div className="rd-pin-card-head">
        <div className="rd-pin-card-title">{address ? address.line1 : 'Dropped pin'}</div>
        <button
          type="button"
          className="rd-pin-card-x"
          title="Close"
          aria-label="Close"
          onClick={actions.clearDroppedPin}
        >
          ✕
        </button>
      </div>
      {address?.line2 && <div className="rd-pin-card-sub">{address.line2}</div>}
      <div className="rd-pin-card-foot">
        <span className="rd-pin-card-coords">{coords}</span>
        <button type="button" className="rd-pin-card-go" onClick={directionsHere}>
          <DirectionsIcon />
          Directions
        </button>
      </div>
    </section>
  );
}
