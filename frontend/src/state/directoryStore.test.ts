import { describe, expect, it } from 'vitest';

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
const { DEFAULT_DIRECTORY_SORT } = await import('../directory/rowModel');

describe('directory sort', () => {
  it('opens on the default: newest FTP files first', () => {
    expect(useStore.getState().ui.directory.sort).toEqual({ key: 'files', dir: 'desc' });
    expect(useStore.getState().ui.directory.sort).toEqual(DEFAULT_DIRECTORY_SORT);
  });

  it('near mode sorts by distance and falls back to the default when cleared', () => {
    const { actions } = useStore.getState();
    actions.setDirectoryNear({ query: 'reno', label: 'Reno, NV', coords: [-119.81, 39.53] });
    expect(useStore.getState().ui.directory.sort).toEqual({ key: 'distance', dir: 'asc' });
    actions.setDirectoryNear(null);
    expect(useStore.getState().ui.directory.sort).toEqual(DEFAULT_DIRECTORY_SORT);
  });

  it('a column the user picked survives leaving near mode', () => {
    const { actions } = useStore.getState();
    actions.setDirectoryNear({ query: 'reno', label: 'Reno, NV', coords: [-119.81, 39.53] });
    actions.toggleDirectorySort('acres');
    actions.setDirectoryNear(null);
    expect(useStore.getState().ui.directory.sort).toEqual({ key: 'acres', dir: 'desc' });
  });
});
