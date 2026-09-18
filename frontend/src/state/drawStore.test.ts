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
import type { DrawFeature } from './store';

function marker(fid: string): DrawFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-117, 42] },
    properties: { fid, kind: 'marker', sym: 'camp', glyph: 'C', color: '#fb5' },
  };
}

const A = marker('a');
const B = marker('b');

describe('draw slice', () => {
  beforeEach(() => {
    useStore.getState().actions.drawHydrate([]);
  });

  it('commit pushes history; undo/redo walk it', () => {
    const { actions } = useStore.getState();
    actions.drawCommit([A]);
    actions.drawCommit([A, B]);
    expect(useStore.getState().draw.features).toHaveLength(2);

    actions.drawUndo();
    expect(useStore.getState().draw.features).toEqual([A]);
    actions.drawUndo();
    expect(useStore.getState().draw.features).toEqual([]);
    actions.drawUndo(); // past exhausted — no-op
    expect(useStore.getState().draw.features).toEqual([]);

    actions.drawRedo();
    actions.drawRedo();
    expect(useStore.getState().draw.features).toEqual([A, B]);
    actions.drawRedo(); // future exhausted — no-op
    expect(useStore.getState().draw.features).toEqual([A, B]);
  });

  it('a new commit clears the redo branch', () => {
    const { actions } = useStore.getState();
    actions.drawCommit([A]);
    actions.drawUndo();
    actions.drawCommit([B]);
    expect(useStore.getState().draw.future).toEqual([]);
    actions.drawRedo();
    expect(useStore.getState().draw.features).toEqual([B]);
  });

  it('clear is undoable and no-ops when already empty', () => {
    const { actions } = useStore.getState();
    actions.drawClear();
    expect(useStore.getState().draw.past).toEqual([]);
    actions.drawCommit([A, B]);
    actions.drawClear();
    expect(useStore.getState().draw.features).toEqual([]);
    actions.drawUndo();
    expect(useStore.getState().draw.features).toEqual([A, B]);
  });

  it('hydrate replaces features, resets history and tool', () => {
    const { actions } = useStore.getState();
    actions.setDrawTool('freehand');
    actions.drawCommit([A]);
    actions.drawHydrate([B]);
    const d = useStore.getState().draw;
    expect(d.features).toEqual([B]);
    expect(d.past).toEqual([]);
    expect(d.future).toEqual([]);
    expect(d.tool).toBe('none');
  });

  it('leaving the Draw tab disarms the tool; marks and history stay', () => {
    const { actions } = useStore.getState();
    actions.setSidebarTab('draw');
    actions.drawCommit([A]);
    actions.drawCommit([A, B]);
    actions.drawUndo();
    actions.setDrawTool('marker:camp');

    actions.setSidebarTab('forecast');
    const d = useStore.getState().draw;
    expect(d.tool).toBe('none');
    expect(d.features).toEqual([A]);
    expect(d.past).toEqual([[]]);
    expect(d.future).toEqual([[A, B]]);

    // coming back doesn't re-arm — the palette starts with nothing picked
    actions.setSidebarTab('draw');
    expect(useStore.getState().draw.tool).toBe('none');
  });

  it('re-tapping the Draw tab keeps the picked tool', () => {
    const { actions } = useStore.getState();
    actions.setSidebarTab('draw');
    actions.setDrawTool('erase');
    actions.setSidebarTab('draw');
    expect(useStore.getState().draw.tool).toBe('erase');
  });

  it('tab switches with no tool picked leave the draw slice untouched', () => {
    const { actions } = useStore.getState();
    actions.setSidebarTab('draw');
    const before = useStore.getState().draw;
    actions.setSidebarTab('overview');
    // same identity: the draw layer re-renders on slice identity
    expect(useStore.getState().draw).toBe(before);
  });

  it('opening a fire or going back to the directory disarms too', () => {
    const { actions } = useStore.getState();
    actions.setSidebarTab('draw');
    actions.setDrawTool('freehand');
    actions.selectFire('fire-1'); // tab snaps back to Overview
    expect(useStore.getState().ui.sidebarTab).toBe('overview');
    expect(useStore.getState().draw.tool).toBe('none');

    actions.setSidebarTab('draw');
    actions.setDrawTool('line:hand');
    actions.backToDirectory();
    expect(useStore.getState().draw.tool).toBe('none');
  });
});
