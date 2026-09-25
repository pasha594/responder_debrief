/**
 * Ground switcher: vector map / USGS satellite (hybrid) / USGS topo.
 * One pill on the map's top line naming the current ground; tapping it drops
 * all three down underneath (so every button on the line stays in view), and
 * a pick (or a tap elsewhere) closes them again.
 */
import { useCallback, useRef, useState } from 'react';
import { useStore, type AppState } from '../state/store';
import { useDismiss } from '../utils/useDismiss';

const CHOICES: { id: AppState['ui']['basemap']; label: string }[] = [
  { id: 'map', label: 'Map' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'topo', label: 'Topo' },
];

export function BasemapControl() {
  const basemap = useStore((s) => s.ui.basemap);
  const setBasemap = useStore((s) => s.actions.setBasemap);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const choices = (
    <div
      className="rd-basemap-control rd-basemap-menu"
      role="group"
      aria-label="Basemap"
    >
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
  const current = CHOICES.find((c) => c.id === basemap) ?? CHOICES[0];
  return (
    <div className="rd-basemap-fold" ref={ref}>
      <div className="rd-basemap-control">
        <button
          type="button"
          className="rd-basemap-btn rd-basemap-btn--active"
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={`Basemap: ${current.label}`}
          onClick={() => setOpen(!open)}
        >
          {current.label} ▾
        </button>
      </div>
      {open && choices}
    </div>
  );
}
