/**
 * Compass dial above the scale bar: a bezel notched every 10° (longer every
 * 30°, longest at east, south and west) with a red north mark and an N, turning
 * with the map's bearing. Click it to face north; drag it to turn the map.
 *
 * Custom rather than MapLibre's compass control, which only draws a fixed
 * arrow icon. Bearing only: pitch belongs to the 3D button, so facing north
 * never levels a tilt the user asked for.
 */
import { useEffect, useRef, type PointerEvent } from 'react';
import { useMap } from '../map/MapRoot';
import {
  CARDINAL_TICKS,
  MAJOR_TICKS,
  MINOR_TICKS,
  dragBearing,
  pointerAngle,
} from '../map/compassDial';

/** Pointer travel before a press counts as a drag rather than a click. */
const DRAG_SLOP_PX = 3;

interface DialDrag {
  pointerId: number;
  /** Dial center and press point, in client pixels. */
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  angle0: number;
  bearing0: number;
  dragging: boolean;
}

export function MapCompass() {
  const map = useMap();
  const dial = useRef<SVGGElement>(null);
  const drag = useRef<DialDrag | null>(null);
  const suppressClick = useRef(false);

  // Turn the bezel with the map. Straight to the DOM: 'rotate' fires every
  // frame of a rotation, and there is nothing for React to reconcile.
  useEffect(() => {
    if (!map) return;
    const sync = () => dial.current?.setAttribute('transform', `rotate(${-map.getBearing()})`);
    sync();
    map.on('rotate', sync);
    return () => {
      map.off('rotate', sync);
    };
  }, [map]);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (!map || e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    drag.current = {
      pointerId: e.pointerId,
      cx,
      cy,
      x0: e.clientX,
      y0: e.clientY,
      angle0: pointerAngle(e.clientX - cx, e.clientY - cy),
      bearing0: map.getBearing(),
      dragging: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!map || !d || d.pointerId !== e.pointerId) return;
    if (!d.dragging && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_SLOP_PX) return;
    d.dragging = true;
    map.setBearing(dragBearing(d.bearing0, d.angle0, pointerAngle(e.clientX - d.cx, e.clientY - d.cy)));
  };

  const onPointerEnd = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    // The click that trails a drag must not snap the map back to north.
    if (d.dragging) suppressClick.current = true;
  };

  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    map?.resetNorth();
  };

  return (
    <button
      type="button"
      className="rd-compass"
      aria-label="Compass: face north"
      title="Click to face north, drag to turn the map"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClick={onClick}
    >
      <svg viewBox="-23 -23 46 46" aria-hidden="true">
        <g ref={dial}>
          <path className="rd-compass-tick" d={MINOR_TICKS} />
          <path className="rd-compass-tick rd-compass-tick--major" d={MAJOR_TICKS} />
          <path className="rd-compass-tick rd-compass-tick--cardinal" d={CARDINAL_TICKS} />
          <path className="rd-compass-north" d="M0 -20.5L3 -15L-3 -15Z" />
          <path className="rd-compass-n" d="M-2.4 -5.5V-12L2.4 -5.5V-12" />
        </g>
        <circle className="rd-compass-pin" r="1.3" />
      </svg>
    </button>
  );
}
