import { describe, expect, it } from 'vitest';
import { spreadCreditVisible } from './credit';

describe('spreadCreditVisible', () => {
  it('shows while the forecast layer is drawn for a fire with a run', () => {
    expect(spreadCreditVisible({ fireMode: true, spreadVisible: true, hasRun: true })).toBe(true);
  });

  it('hides outside fire mode, when the layer is off, or when there is no run', () => {
    expect(spreadCreditVisible({ fireMode: false, spreadVisible: true, hasRun: true })).toBe(false);
    expect(spreadCreditVisible({ fireMode: true, spreadVisible: false, hasRun: true })).toBe(false);
    expect(spreadCreditVisible({ fireMode: true, spreadVisible: true, hasRun: false })).toBe(false);
  });
});
