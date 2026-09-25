/**
 * IR heat-class key, shared by the active IR flight row (the only legend on
 * phones) and the map's LegendBar, so the two can never disagree. Lists only
 * the classes the flight actually has.
 */
import type React from 'react';
import { IR_HEAT_COLOR } from '../map/layers/irHeatLayer';

type HeatType = keyof typeof IR_HEAT_COLOR;

/** Legend order + wording (NIROPS's own names); chip shape mirrors the map. */
const IR_LEGEND: { type: HeatType; label: string; chip?: 'outline' | 'dot' | 'ring' | 'dashed' }[] = [
  { type: 'Perimeter', label: 'Heat perimeter', chip: 'outline' },
  { type: 'Intense', label: 'Intense heat' },
  { type: 'Scattered', label: 'Scattered heat' },
  { type: 'Isolated', label: 'Isolated heat', chip: 'dot' },
  { type: 'Possible', label: 'Possible heat', chip: 'ring' },
  { type: 'Obscured', label: 'Imagery obscured', chip: 'dashed' },
];

export function IrHeatLegend({ heatTypes }: { heatTypes: string[] }) {
  const rows = IR_LEGEND.filter((r) => heatTypes.includes(r.type));
  if (!rows.length) return null;
  return (
    <div className="rd-ir-legend">
      {rows.map((r) => (
        <span
          key={r.type}
          className="rd-swatch"
          title={
            r.type === 'Obscured'
              ? 'Clouds, smoke or gaps in coverage: heat there may be unmapped'
              : undefined
          }
        >
          <span
            className={`rd-swatch-chip${r.chip ? ` rd-swatch-chip--${r.chip}` : ''}`}
            aria-hidden
            style={{ '--chip': IR_HEAT_COLOR[r.type] } as React.CSSProperties}
          />
          <span className="rd-swatch-label">{r.label}</span>
        </span>
      ))}
    </div>
  );
}
