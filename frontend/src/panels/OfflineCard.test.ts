/**
 * The Offline card for a downloaded fire: Update needs the fire in the
 * catalog (a download looks it up there), so a fire that dropped out of the
 * catalog gets a disabled Update with a reason instead of a failed download.
 * Remove never depends on the catalog.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PackMeta } from '../offline/packModel';

const FL = '{8E2C1A4B-0F3D-4C6E-9A7B-1D2E3F4A5B6C}';
const FL_FK = '8e2c1a4b-0f3d-4c6e-9a7b-1d2e3f4a5b6c';

const hoisted = vi.hoisted(() => ({
  catalog: undefined as { fires: { cornea_id: string }[] } | undefined,
  state: {} as Record<string, unknown>,
}));
vi.mock('../api/queries', () => ({ useMasterCatalog: () => ({ data: hoisted.catalog }) }));
vi.mock('../routing/hooks', () => ({ useFireBundle: () => ({ data: null }) }));
vi.mock('../state/store', () => ({
  useStore: (sel: (s: Record<string, unknown>) => unknown) => sel(hoisted.state),
}));
vi.mock('../offline/packs', async () => {
  const model = await import('../offline/packModel');
  return {
    cancelActiveDownload: () => undefined,
    downloadPack: vi.fn(),
    removePack: vi.fn(),
    formatBytes: model.formatBytes,
    opfsSupported: () => true,
    packForFire: model.packForFire,
  };
});

const { OfflineCard } = await import('./OfflineCard');

const pack: PackMeta = {
  version: 1, slug: 'chipmunk', corneaId: FL, name: 'Chipmunk', state: 'FL',
  downloadedAt: '2026-10-06T00:00:00Z', bytes: 1_000_000, fileCount: 1, files: {}, prefixes: [],
};

function setup(catalog: typeof hoisted.catalog, online = true) {
  hoisted.catalog = catalog;
  hoisted.state = {
    offline: { packs: { [FL_FK]: pack }, progress: null, online },
    actions: { showToast: () => undefined },
  };
}

const button = (label: string) => {
  const h = renderToStaticMarkup(createElement(OfflineCard, { corneaId: FL }));
  const tag = new RegExp(`<button([^>]*)>${label}</button>`).exec(h)?.[1];
  if (tag === undefined) throw new Error(`no ${label} button in ${h}`);
  return { disabled: tag.includes('disabled'), title: /title="([^"]*)"/.exec(tag)?.[1] };
};

describe('OfflineCard Update', () => {
  it('is enabled when the fire is in the catalog', () => {
    setup({ fires: [{ cornea_id: FL_FK }] });
    expect(button('Update')).toEqual({ disabled: false, title: 'Re-download with the newest data' });
  });

  it('is disabled for a downloaded fire no longer in the catalog; Remove still works', () => {
    setup({ fires: [] });
    expect(button('Update')).toEqual({ disabled: true, title: 'Not in the catalog right now' });
    expect(button('Remove').disabled).toBe(false);
  });

  it('waits for the catalog to load', () => {
    setup(undefined);
    expect(button('Update')).toEqual({ disabled: true, title: 'Waiting for the catalog' });
  });

  it('asks to reconnect first when offline', () => {
    setup(undefined, false);
    expect(button('Update')).toEqual({ disabled: true, title: 'Reconnect to update' });
  });
});
