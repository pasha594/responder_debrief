/**
 * Ground switcher: vector map / USGS satellite (hybrid) / USGS topo.
 * A floating segmented pill under the back control at the map's top-left.
 */
import { useStore, type AppState } from '../state/store';

const CHOICES: { id: AppState['ui']['basemap']; label: string }[] = [
  { id: 'map', label: 'Map' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'topo', label: 'Topo' },
];

export function BasemapControl() {
  const basemap = useStore((s) => s.ui.basemap);
  const setBasemap = useStore((s) => s.actions.setBasemap);
  return (
    <div className="rd-basemap-control" role="group" aria-label="Basemap">
      {CHOICES.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`rd-basemap-btn${basemap === c.id ? ' rd-basemap-btn--active' : ''}`}
          aria-pressed={basemap === c.id}
          onClick={() => setBasemap(c.id)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
