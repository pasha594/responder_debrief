import { beforeEach, describe, expect, it } from 'vitest';

// The store reads document.documentElement.dataset.theme at module load;
// these tests run in node, so give it the minimum it touches.
(globalThis as { document?: unknown }).document ??= {
  documentElement: { dataset: {} },
};
(globalThis as { window?: unknown }).window ??= globalThis;
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { useStore } = await import('./store');

const layers = () => useStore.getState().layers;
const actions = () => useStore.getState().actions;

describe('map overlays are mutually exclusive', () => {
  beforeEach(() => {
    actions().setIncidentMap(null);
    actions().setIrFlight(null);
  });

  it('showing an IR flight takes down the incident map, and back', () => {
    actions().setIncidentMap('sheet-1');
    actions().setIrFlight('20260925_IR');
    expect(layers().incidentMap.mapId).toBeNull();
    expect(layers().irFlight.flightId).toBe('20260925_IR');

    actions().setIncidentMap('sheet-2');
    expect(layers().irFlight.flightId).toBeNull();
    expect(layers().incidentMap.mapId).toBe('sheet-2');
  });

  it('a map series replaces the IR flight too', () => {
    actions().setIrFlight('20260925_IR');
    actions().setIncidentMapSeries('ops|arch_e');
    expect(layers().irFlight.flightId).toBeNull();
    expect(layers().incidentMap.series).toBe('ops|arch_e');

    actions().setIrFlight('20260924_IR');
    expect(layers().incidentMap.series).toBeNull();
  });

  it('turning one off leaves the other alone, and keeps the sheet opacity', () => {
    actions().setIncidentMapOpacity(0.5);
    actions().setIrFlight('20260925_IR');
    actions().setIncidentMap(null);
    expect(layers().irFlight.flightId).toBe('20260925_IR');
    actions().setIncidentMap('sheet-1');
    actions().setIrFlight(null);
    expect(layers().incidentMap.mapId).toBe('sheet-1');
    expect(layers().incidentMap.opacity).toBe(0.5);
  });
});
