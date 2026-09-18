/**
 * Dual-unit scale bar, bottom-right of the VISIBLE map: miles (feet up close)
 * over kilometers (meters up close) on one shared line, resizing as the map
 * zooms. It lives out here with the other map overlays rather than in
 * MapLibre's own corner because that corner is the full-bleed canvas's — under
 * the sidebar on desktop and under the sheet on phones.
 */
import { useEffect, useState } from 'react';
import { useMap } from '../map/MapRoot';
import { scaleReadings, type ScaleReadings } from '../map/scaleReadings';
import { useStore } from '../state/store';

/** Widest a bar gets; round distances land between half of this and all of it. */
const MAX_WIDTH_PX = 100;

function sameReadings(a: ScaleReadings | null, b: ScaleReadings | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.imperial.label === b.imperial.label &&
    a.imperial.widthPx === b.imperial.widthPx &&
    a.metric.label === b.metric.label &&
    a.metric.widthPx === b.metric.widthPx
  );
}

export function ScaleBar() {
  const map = useMap();
  const sidebarCollapsed = useStore((s) => s.ui.sidebarCollapsed);
  const sheetSnap = useStore((s) => s.ui.sheetSnap);
  const [readings, setReadings] = useState<ScaleReadings | null>(null);

  useEffect(() => {
    if (!map) return;
    const update = () => {
      // Same sampling as MapLibre's own control: the ground distance across
      // MAX_WIDTH_PX at the vertical middle of the map (scale varies with
      // latitude, so pans move it too — 'move' covers zoom and pan alike).
      const y = map.getContainer().clientHeight / 2;
      const meters = map.unproject([0, y]).distanceTo(map.unproject([MAX_WIDTH_PX, y]));
      const next = scaleReadings(meters, MAX_WIDTH_PX);
      setReadings((prev) => (sameReadings(prev, next) ? prev : next));
    };
    update();
    map.on('move', update);
    map.on('resize', update);
    return () => {
      map.off('move', update);
      map.off('resize', update);
    };
  }, [map]);

  if (!readings) return null;
  const { imperial, metric } = readings;

  return (
    <div
      className={`rd-scalebar rd-scalebar--sheet-${sheetSnap}${
        sidebarCollapsed ? ' rd-scalebar--rail' : ''
      }`}
      role="img"
      aria-label={`Map scale: ${imperial.label}, ${metric.label}`}
    >
      <div className="rd-scalebar-row rd-scalebar-row--imperial" style={{ width: imperial.widthPx }}>
        {imperial.label}
      </div>
      <div className="rd-scalebar-row rd-scalebar-row--metric" style={{ width: metric.widthPx }}>
        {metric.label}
      </div>
    </div>
  );
}
