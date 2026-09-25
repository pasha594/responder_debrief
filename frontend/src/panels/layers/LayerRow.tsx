/**
 * One Layers-tab row: the whole line is the toggle (a full-width label, so a
 * click anywhere on it flips the layer), ruled off below like its neighbours.
 * Children — legend, opacity, notes — sit under the line inside the same row;
 * callers pass them only while the layer is on.
 */
import type { ReactNode } from 'react';

export function LayerRow({
  label,
  meta,
  title,
  checked,
  disabled,
  onChange,
  children,
}: {
  label: string;
  /** Muted note after the label (source, "not built yet"). */
  meta?: ReactNode;
  title?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="rd-layer-row">
      <label className="rd-field--row rd-layer-row-toggle" title={title}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{label}</span>
        {meta && <span className="rd-title-meta">{meta}</span>}
      </label>
      {children && <div className="rd-layer-row-body">{children}</div>}
    </div>
  );
}
