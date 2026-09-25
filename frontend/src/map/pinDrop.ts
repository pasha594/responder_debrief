/**
 * Click rules for the dropped pin (panels/DroppedPin), Google Maps' way: on
 * an idle map a plain click drops a pin; the next click anywhere only
 * dismisses it — the same way it would close an open feature popup — and
 * the one after drops a new pin. Pans never count: MapLibre only emits
 * 'click' for non-drags.
 */
import type { AppState } from '../state/store';

/** Layers whose clicks already mean something: a popup opens (hotspots,
 * burn scars, road incidents) or a fire gets selected (fire pins). */
export const FEATURE_LAYERS = [
  'rd-hotspots',
  'rd-hist-perims-fill',
  'rd-incidents-line',
  'rd-incidents-pt',
  'rd-fire-pins',
  'rd-trails-hit',
];

/**
 * An armed draw tool or the directions flow owns map clicks — the same
 * states useMapLayerSync's route-pin handler and the draw layer act on.
 */
export function clicksClaimed(s: Pick<AppState, 'draw' | 'directions'>): boolean {
  const d = s.directions;
  return s.draw.tool !== 'none' || d.armed || !!d.a || !!d.b;
}

export interface PinClickFacts {
  claimed: boolean;
  pinShown: boolean;
  /** Landed on a DOM marker: this pin, a route end, the location dot. */
  onMarker: boolean;
  /** Landed on a FEATURE_LAYERS feature. */
  onFeature: boolean;
  /** A feature popup was already open — this click is closing it. */
  popupOpen: boolean;
}

export type PinClick = 'drop' | 'dismiss' | 'none';

export function pinClickAction(f: PinClickFacts): PinClick {
  if (f.claimed || f.onMarker) return 'none';
  if (f.pinShown) return 'dismiss';
  // Like a shown pin, an open popup is dismissed by this click, not joined.
  if (f.onFeature || f.popupOpen) return 'none';
  return 'drop';
}

export interface ClickGate {
  /**
   * Feed every map click. `decide` runs now — after any earlier click still
   * on hold has landed — and returns the effect to hold, or null.
   */
  click(point: { x: number; y: number }, decide: () => (() => void) | null): void;
  /** Drop the held effect (dblclick, a user camera move, teardown). */
  cancel(): void;
}

/**
 * Holds a click's effect until it can no longer be half of a double-click,
 * so double-click / double-tap zoom never drops or dismisses the pin: a
 * second click on the same spot inside the window cancels it. A click
 * elsewhere is its own click — the held one lands first.
 */
export function createClickGate(windowMs: number, twinPx = 30): ClickGate {
  let held: { run: () => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let last: { x: number; y: number; t: number } | null = null;

  const cancel = () => {
    if (held) clearTimeout(held.timer);
    held = null;
  };
  const land = () => {
    const run = held?.run;
    cancel();
    run?.();
  };

  return {
    click(point, decide) {
      const t = Date.now();
      const twin =
        !!last &&
        t - last.t <= windowMs &&
        Math.hypot(point.x - last.x, point.y - last.y) <= twinPx;
      // A third click starts over rather than pairing with the second.
      last = twin ? null : { x: point.x, y: point.y, t };
      if (twin) {
        cancel();
        return;
      }
      land();
      const run = decide();
      if (run) held = { run, timer: setTimeout(land, windowMs) };
    },
    cancel,
  };
}
