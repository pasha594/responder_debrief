/**
 * Settings gear (top right of both the directory and the fire map): app theme
 * (dark/light — the machinery lived in the store all along, this is its first
 * UI) and the basemap style, three keyless variants per theme (see MAP_STYLES).
 */
import { useEffect, useRef, useState } from 'react';
import { MAP_STYLES } from '../app/config';
import { useStore } from '../state/store';

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
      <path d="M12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm7.4-2.6c.04-.3.06-.6.06-.9s-.02-.6-.06-.9l2-1.6a.5.5 0 0 0 .12-.63l-1.9-3.3a.5.5 0 0 0-.6-.22l-2.4.96a7.3 7.3 0 0 0-1.55-.9l-.36-2.54a.5.5 0 0 0-.5-.42h-3.8a.5.5 0 0 0-.5.42l-.36 2.54c-.55.23-1.07.53-1.55.9l-2.4-.96a.5.5 0 0 0-.6.22l-1.9 3.3a.5.5 0 0 0 .12.63l2 1.6c-.04.3-.06.6-.06.9s.02.6.06.9l-2 1.6a.5.5 0 0 0-.12.63l1.9 3.3c.13.22.39.31.6.22l2.4-.96c.48.37 1 .67 1.55.9l.36 2.54c.04.24.25.42.5.42h3.8a.5.5 0 0 0 .5-.42l.36-2.54a7.3 7.3 0 0 0 1.55-.9l2.4.96c.21.09.47 0 .6-.22l1.9-3.3a.5.5 0 0 0-.12-.63l-2-1.6z" />
    </svg>
  );
}

export function SettingsControl() {
  const theme = useStore((s) => s.ui.theme);
  const mapStyle = useStore((s) => s.ui.mapStyle);
  const actions = useStore((s) => s.actions);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      // Swallow the click this pointerdown produces: on the fire map it
      // would otherwise fall through to the canvas and drop a directions
      // point. Standard popover behavior — the dismissing click only dismisses.
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(
        () => document.removeEventListener('click', swallow, { capture: true }),
        400,
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="rd-settings" ref={rootRef}>
      <button
        type="button"
        className="rd-mini-btn rd-settings-gear"
        title="Settings"
        aria-label="Settings"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <GearIcon />
      </button>
      {open && (
        <div className="rd-settings-panel" role="dialog" aria-label="Settings">
          <div className="rd-settings-label">Theme</div>
          <div className="rd-settings-segment" role="group" aria-label="App theme">
            {(['dark', 'light'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`rd-settings-seg${theme === t ? ' rd-settings-seg--on' : ''}`}
                aria-pressed={theme === t}
                onClick={() => actions.setTheme(t)}
              >
                {t === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>

          <div className="rd-settings-label">Map style</div>
          <div role="radiogroup" aria-label="Map style">
            {MAP_STYLES[theme].map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={mapStyle[theme] === s.id}
                className={`rd-settings-style${mapStyle[theme] === s.id ? ' rd-settings-style--on' : ''}`}
                onClick={() => actions.setMapStyle(theme, s.id)}
              >
                <span className="rd-settings-swatch" style={{ background: s.swatch }} />
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
