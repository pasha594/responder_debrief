/**
 * Ground switcher: vector map / USGS satellite (hybrid) / USGS topo.
 * A floating segmented pill under the back control at the map's top-left;
 * on phones, touch tablets and narrow windows it folds to one pill naming
 * the current ground, which opens to all three when tapped and closes again
 * on a pick (or a tap elsewhere).
 */
import { useCallback, useRef, useState } from 'react';
import { useStore, type AppState } from '../state/store';
import { useCompactControls } from '../utils/useMediaQuery';
import { useDismiss } from '../utils/useDismiss';

const CHOICES: { id: AppState['ui']['basemap']; label: string }[] = [
  { id: 'map', label: 'Map' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'topo', label: 'Topo' },
];

export function BasemapControl() {
  const basemap = useStore((s) => s.ui.basemap);
  const setBasemap = useStore((s) => s.actions.setBasemap);
  const fullControls = !useCompactControls();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  if (!fullControls && !open) {
    const current = CHOICES.find((c) => c.id === basemap) ?? CHOICES[0];
    return (
      <div className="rd-basemap-control" ref={ref}>
        <button
          type="button"
          className="rd-basemap-btn rd-basemap-btn--active"
          aria-haspopup="true"
          aria-expanded={false}
          aria-label={`Basemap: ${current.label}`}
          onClick={() => setOpen(true)}
        >
          {current.label} ▾
        </button>
      </div>
    );
  }

  return (
    <div className="rd-basemap-control" role="group" aria-label="Basemap" ref={ref}>
      {CHOICES.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`rd-basemap-btn${basemap === c.id ? ' rd-basemap-btn--active' : ''}`}
          aria-pressed={basemap === c.id}
          onClick={() => {
            setBasemap(c.id);
            setOpen(false);
          }}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
