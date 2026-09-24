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

const SPOT: [number, number] = [-121.6031, 39.7652];
const pin = () => useStore.getState().droppedPin;

describe('dropped pin slice', () => {
  beforeEach(() => {
    const { actions } = useStore.getState();
    actions.clearDirections();
    actions.setDrawTool('none');
    actions.dropPin(SPOT);
  });

  it('drops and clears', () => {
    expect(pin()).toEqual(SPOT);
    useStore.getState().actions.clearDroppedPin();
    expect(pin()).toBeNull();
  });

  it('a route endpoint takes over the map click, so the pin goes', () => {
    useStore.getState().actions.setDirectionsPoint('b', { coords: SPOT, label: 'x' });
    expect(pin()).toBeNull();
  });

  it('emptying a route field leaves the pin alone', () => {
    useStore.getState().actions.setDirectionsPoint('a', null);
    expect(pin()).toEqual(SPOT);
  });

  it('arming a draw tool clears it; disarming does not', () => {
    const { actions } = useStore.getState();
    actions.setDrawTool('none');
    expect(pin()).toEqual(SPOT);
    actions.setDrawTool('marker:camp');
    expect(pin()).toBeNull();
  });

  it('switching fires or leaving the map clears it', () => {
    useStore.getState().actions.selectFire('fire-1');
    expect(pin()).toBeNull();
    useStore.getState().actions.dropPin(SPOT);
    useStore.getState().actions.backToDirectory();
    expect(pin()).toBeNull();
  });
});
