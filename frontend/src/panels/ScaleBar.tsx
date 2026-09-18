/**
 * Dual-unit scale bar, bottom-right of the VISIBLE map: miles (feet up close)
 * over kilometers (meters up close) on one shared line, resizing as the map
 * zooms. It lives out here with the other map overlays rather than in
 * MapLibre's own corner because that corner is the full-bleed canvas's — under
 * the sidebar on desktop and under the sheet on phones.
 */
import { useEffect, useState } from 'react';
import { useMap } from '../map/MapRoot';
import {
  panStableMetersPerPixel,
  scaleReadings,
  type ScaleLock,
  type ScaleReadings,
} from '../map/scaleReadings';
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
    let lock: ScaleLock | null = null;
    const update = () => {
      // From the camera, never from the ground: see panStableMetersPerPixel
      // for why measuring (unproject) or trusting getZoom() wobbles on pans.
      const centerElevationM = map.getCameraTargetElevation();
      const stable = panStableMetersPerPixel(
        {
          lat: map.getCenter().lat,
          zoom: map.getZoom(),
          pitchDeg: map.getPitch(),
          verticalFovDeg: map.getVerticalFieldOfView(),
          viewportHeightPx: map.getContainer().clientHeight,
          centerElevationM,
          // meters above sea level in MapLibre 5 (it was center-relative in 3/4)
          groundElevationM: map.queryTerrainElevation(map.getCenter()) ?? centerElevationM,
        },
        lock,
      );
      lock = stable.lock;
      const next = scaleReadings(stable.metersPerPixel * MAX_WIDTH_PX, MAX_WIDTH_PX);
      setReadings((prev) => (sameReadings(prev, next) ? prev : next));
    };
    update();
    // 'idle' catches the terrain tiles landing after the camera has settled.
    const events = ['move', 'moveend', 'resize', 'idle'] as const;
    for (const ev of events) map.on(ev, update);
    return () => {
      for (const ev of events) map.off(ev, update);
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
