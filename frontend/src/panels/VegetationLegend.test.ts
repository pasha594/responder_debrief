import { describe, expect, it } from 'vitest';
import { STREAM_COLOR, VEG_CLASSES } from '../routing/vegClasses';
import { VEG_LEGEND_ROWS } from './VegetationLegend';

describe('vegetation legend', () => {
  it('lists every class the layer paints, then the creek, in its colours', () => {
    expect(VEG_LEGEND_ROWS.map((r) => r.color)).toEqual([
      ...VEG_CLASSES.filter((c) => c.id > 0).map((c) => c.color),
      STREAM_COLOR,
    ]);
  });

  it('keeps every label to one short line on the map card', () => {
    const labels = VEG_LEGEND_ROWS.map((r) => r.label);
    expect(labels).toContain('Light brush');
    expect(labels).toContain('Dense brush');
    expect(labels).toContain('Water / river (impassable)');
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(28);
  });
});
