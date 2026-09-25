/**
 * IR heat key, shared by the active IR flight row and the map's key
 * (LegendBar), so the two can never disagree. Wording,
 * order and symbols follow the legend printed on the NIROPS IR PDFs; the
 * chips are the map's own symbol images (irHeatImages.ts) on the PDF's white
 * paper. Lists only the classes the flight actually has.
 */
import type React from 'react';
import {
  IR_GREY,
  IR_IMAGE_SIZE,
  IR_IMAGES,
  IR_RED,
  irImageUrl,
  type IrImageId,
} from '../map/layers/irHeatImages';

interface LegendRow {
  type: string;
  label: string;
  /** Point symbol drawn centered on the chip. */
  icon?: IrImageId;
  /** Area fill pattern, tiled across the chip. */
  pattern?: IrImageId;
  /** Area outline: [css width px, color]. */
  outline?: [number, string];
}

const IR_LEGEND: LegendRow[] = [
  { type: 'Isolated', label: 'IR Isolated Heat Source', icon: IR_IMAGES.isolated },
  { type: 'Possible', label: 'Possible IR Heat Source', icon: IR_IMAGES.possible },
  { type: 'Perimeter', label: 'IR Heat Perimeter', outline: [2, IR_RED] },
  { type: 'Intense', label: 'IR Intense Heat', pattern: IR_IMAGES.intense, outline: [1, IR_RED] },
  { type: 'Scattered', label: 'IR Scattered Heat', pattern: IR_IMAGES.scattered, outline: [1, IR_RED] },
  { type: 'Obscured', label: 'Cloud Cover / No Data', pattern: IR_IMAGES.obscured, outline: [2, IR_GREY] },
];

function chipStyle(r: LegendRow): React.CSSProperties {
  const img = r.icon ?? r.pattern;
  const url = img ? irImageUrl(img) : null;
  const size = img ? `${IR_IMAGE_SIZE[img]}px` : undefined;
  return {
    backgroundImage: url ? `url(${url})` : undefined,
    backgroundSize: size ? `${size} ${size}` : undefined,
    backgroundRepeat: r.icon ? 'no-repeat' : 'repeat',
    backgroundPosition: r.icon ? 'center' : '0 0',
    border: r.outline ? `${r.outline[0]}px solid ${r.outline[1]}` : undefined,
  };
}

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
              ? 'The sensor could not see here: heat may be present but unmapped'
              : undefined
          }
        >
          <span className="rd-ir-chip" aria-hidden style={chipStyle(r)} />
          <span className="rd-swatch-label">{r.label}</span>
        </span>
      ))}
    </div>
  );
}
