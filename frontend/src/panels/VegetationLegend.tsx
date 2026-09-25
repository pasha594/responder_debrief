/**
 * Vegetation key, shared by the Vegetation row (the only legend on phones)
 * and the map's LegendBar, so the two can never disagree. One column, one
 * swatch per class the layer paints (vegClasses.ts), then the creek bit.
 */
import { STREAM_COLOR, STREAM_LABEL, VEG_CLASSES } from '../routing/vegClasses';

export const VEG_LEGEND_ROWS: { color: string; label: string }[] = [
  ...VEG_CLASSES.filter((c) => c.id > 0).map((c) => ({ color: c.color, label: c.legend ?? c.label })),
  { color: STREAM_COLOR, label: STREAM_LABEL },
];

export function VegetationLegend() {
  return (
    <div className="rd-veg-legend">
      {VEG_LEGEND_ROWS.map((r) => (
        <span key={r.label} className="rd-swatch">
          <span className="rd-swatch-chip" aria-hidden style={{ background: r.color }} />
          <span className="rd-swatch-label">{r.label}</span>
        </span>
      ))}
    </div>
  );
}
