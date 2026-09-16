/**
 * "3D" toggle: tilts the camera (what a two-finger drag does on a phone) so
 * the always-on terrain reads as relief. Reflects the live pitch, so a tilt
 * made by gesture lights the button too, and a second press levels the map.
 */
import { useEffect, useState } from 'react';
import { useMap } from '../map/MapRoot';

const TILT_DEG = 60;

export function PitchControl() {
  const map = useMap();
  const [pitched, setPitched] = useState(false);

  useEffect(() => {
    if (!map) return;
    const sync = () => setPitched(map.getPitch() > 1);
    sync();
    map.on('pitch', sync);
    return () => {
      map.off('pitch', sync);
    };
  }, [map]);

  return (
    <button
      type="button"
      className={`rd-3d-btn${pitched ? ' rd-3d-btn--on' : ''}`}
      aria-pressed={pitched}
      title={pitched ? 'Level the map' : 'Tilt the map (3D)'}
      onClick={() => map?.easeTo({ pitch: pitched ? 0 : TILT_DEG, duration: 700 })}
    >
      3D
    </button>
  );
}
