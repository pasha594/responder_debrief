/**
 * North compass for the visible map corner: MapLibre's own compass control
 * (the zoom buttons' sibling), mounted here instead of in MapLibre's corner,
 * which sits under the sidebar on desktop and under the sheet on phones (see
 * ScaleBar). The needle follows the map's bearing; a click turns the map back
 * to north, and dragging it rotates the map.
 */
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useMap } from '../map/MapRoot';

export function MapCompass() {
  const map = useMap();
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!map || !el) return;
    // Bearing only: pitch belongs to the 3D button, so a compass click must
    // not level a tilt the user asked for.
    const control = new maplibregl.NavigationControl({ showZoom: false, showCompass: true });
    el.appendChild(control.onAdd(map));
    return () => control.onRemove();
  }, [map]);

  return <div ref={host} className="rd-compass" />;
}
