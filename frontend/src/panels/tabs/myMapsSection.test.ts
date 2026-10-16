/**
 * MyMapsSection: its pure helpers, plus one static render that pins the
 * privacy invariant (the whole section is ph-no-capture, so file names never
 * reach PostHog autocapture or replay) and the DESIGN wording.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Map as MlMap } from 'maplibre-gl';
import type { Box, UserMapMeta, UserMapsState } from '../../userMaps/types';

const h = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('../../userMaps/session', () => ({
  addUserMapFile: vi.fn(),
  cancelUserMapImport: vi.fn(),
  deleteUserMap: vi.fn(),
  dismissUserMapNotice: vi.fn(),
  onUserMapAdded: vi.fn(),
  retryCrashedImport: vi.fn(),
}));
vi.mock('../../map/MapRoot', () => ({ useMap: () => null }));
vi.mock('../../state/store', () => ({
  useStore: (sel: (s: unknown) => unknown) => sel(h.state),
}));
vi.mock('../../api/queries', () => ({
  useFire: () => ({ data: { fire_coordinates: '45, -120' } }),
  useMasterCatalog: () => ({ data: undefined }),
}));
vi.mock('../../userMaps/storage', () => ({
  readSource: vi.fn(async () => null),
  readThumb: vi.fn(async () => null),
  sortUserMaps: (l: unknown[]) => l,
}));

const m = await import('./MyMapsSection');
const session = await import('../../userMaps/session');

describe('importStatusText', () => {
  it('words every stage', () => {
    expect(m.importStatusText({ fileName: 'ops.pdf', stage: 'reading' })).toBe('Reading ops.pdf…');
    expect(m.importStatusText({ fileName: 'x', stage: 'saving' })).toBe('Saving…');
    expect(m.importStatusText({ fileName: 'x', stage: 'locating' })).toBe('Finding map coordinates…');
    expect(m.importStatusText({ fileName: 'x', stage: 'drawing', page: 2, pages: 3 })).toBe(
      'Drawing page 2 of 3…',
    );
    expect(m.importStatusText({ fileName: 'x', stage: 'drawing' })).toBe('Drawing…');
    expect(m.importStatusText({ fileName: 'x', stage: 'finishing' })).toBe('Finishing…');
  });
});

describe('distanceFromFire / userMapMetaLine', () => {
  const fire: [number, number] = [-120, 45];
  it('rounds miles, under 1 mi, far beyond 300 mi, nothing without a fire', () => {
    expect(m.distanceFromFire(null, [-120, 45])).toBeNull();
    expect(m.distanceFromFire(fire, [-120, 45.001])).toBe('under 1 mi from this fire');
    expect(m.distanceFromFire(fire, [-120, 45.1])).toBe('7 mi from this fire'); // 6.9 mi
    expect(m.distanceFromFire(fire, [-120, 49.3])).toBe('297 mi from this fire');
    expect(m.distanceFromFire(fire, [-120, 49.4])).toBe('far from this fire');
  });
  it('joins date, size and distance', () => {
    const now = Date.parse('2026-10-16T18:00:00Z');
    expect(
      m.userMapMetaLine(
        { addedAt: '2026-10-16T17:00:00Z', fileBytes: 8.3 * 1024 * 1024, center: [-120, 45.1] },
        fire,
        now,
      ),
    ).toBe('Added Oct 16 · 8.3 MB · 7 mi from this fire');
    expect(
      m.userMapMetaLine({ addedAt: '2025-07-04T17:00:00Z', fileBytes: 900_000, center: [0, 0] }, null, now),
    ).toBe('Added Jul 4, 2025 · 879 KB');
  });
});

describe('dragHasFiles', () => {
  it('only file drags', () => {
    expect(m.dragHasFiles(['text/plain', 'Files'])).toBe(true);
    expect(m.dragHasFiles(['text/uri-list'])).toBe(false);
    expect(m.dragHasFiles(null)).toBe(false);
  });
});

describe('file drop guard (outside My maps)', () => {
  /** A cancelable drag event as the window sees it, after React's root handlers. */
  const drag = (type: string, types: string[], claimed = false) => {
    const e = new Event(type, { cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { types, dropEffect: 'copy' } });
    if (claimed) e.preventDefault(); // the section's onDragOver / onDrop got it first
    return e as Event & { dataTransfer: { dropEffect: string } };
  };

  it('refuses a file drag nothing claimed: no navigation, "not here" cursor', () => {
    const target = new EventTarget();
    const off = m.installFileDropGuard(target);
    const over = drag('dragover', ['Files']);
    target.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('none');
    const drop = drag('drop', ['Files']);
    target.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    off();
    const after = drag('drop', ['Files']);
    target.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('leaves the section’s own drop and non-file drags alone', () => {
    const target = new EventTarget();
    const off = m.installFileDropGuard(target);
    const claimed = drag('dragover', ['Files'], true);
    target.dispatchEvent(claimed);
    expect(claimed.dataTransfer.dropEffect).toBe('copy');
    const text = drag('dragover', ['text/plain']);
    target.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
    expect(text.dataTransfer.dropEffect).toBe('copy');
    off();
  });
});

describe('isIosBrowserTab', () => {
  const nav = (ua: string, platform = 'iPhone', touch = 5, standalone?: boolean) =>
    ({ userAgent: ua, platform, maxTouchPoints: touch, standalone }) as unknown as Navigator;
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
  it('iPhone tab yes, Home Screen app no, iPadOS-as-Mac yes, real Mac and Android no', () => {
    expect(m.isIosBrowserTab(nav(iphone), false)).toBe(true);
    expect(m.isIosBrowserTab(nav(iphone, 'iPhone', 5, true), false)).toBe(false);
    expect(m.isIosBrowserTab(nav(iphone), true)).toBe(false);
    expect(m.isIosBrowserTab(nav(mac, 'MacIntel', 5), false)).toBe(true);
    expect(m.isIosBrowserTab(nav(mac, 'MacIntel', 0), false)).toBe(false);
    expect(m.isIosBrowserTab(nav('Mozilla/5.0 (Linux; Android 14)', 'Linux armv8l', 5), false)).toBe(false);
    expect(m.isIosBrowserTab(undefined, false)).toBe(false);
  });
});

describe('fitPadding', () => {
  it('desktop: directions padding, widened by the open sidebar', () => {
    expect(m.fitPadding({ width: 1400, height: 800 }, { right: 380, bottom: 0 })).toEqual({
      top: 80,
      bottom: 140,
      left: 80,
      right: 440,
    });
    expect(m.fitPadding({ width: 1400, height: 800 })).toEqual({ top: 80, bottom: 140, left: 80, right: 80 });
  });
  it('phone: clears the sheet unless that leaves too little map', () => {
    expect(m.fitPadding({ width: 375, height: 700 }, { right: 0, bottom: 96 })).toEqual({
      top: 60,
      bottom: 120,
      left: 24,
      right: 24,
    });
    expect(m.fitPadding({ width: 375, height: 700 }, { right: 0, bottom: 315 })).toEqual({
      top: 60,
      bottom: 331,
      left: 24,
      right: 24,
    });
    expect(m.fitPadding({ width: 375, height: 700 }, { right: 0, bottom: 630 })).toEqual({
      top: 60,
      bottom: 120,
      left: 24,
      right: 24,
    });
  });
  it('768–800 px desktop layout (tablet sidebar over the map) still clears the panel', () => {
    // Open (320 px tablet sidebar) and collapsed (48 px rail).
    expect(m.fitPadding({ width: 768, height: 900 }, { right: 320, bottom: 0 })).toEqual({
      top: 80,
      bottom: 140,
      left: 80,
      right: 380,
    });
    expect(m.fitPadding({ width: 800, height: 900 }, { right: 48, bottom: 0 }).right).toBe(108);
  });
});

describe('alreadyOnUserMap', () => {
  const sheet: Box = [-121, 44, -119, 46];
  const pad = { top: 80, bottom: 140, left: 80, right: 380 };
  const fakeMap = (view: Box, zoom: number, fitZoom: number | undefined) => {
    const cameraForBounds = vi.fn(() => (fitZoom == null ? undefined : { zoom: fitZoom }));
    const map = {
      getBounds: () => ({
        getWest: () => view[0],
        getSouth: () => view[1],
        getEast: () => view[2],
        getNorth: () => view[3],
      }),
      getZoom: () => zoom,
      cameraForBounds,
    } as unknown as MlMap;
    return { map, cameraForBounds };
  };

  it('zoomed in on part of the sheet (or at its full fit): stay', () => {
    const { map, cameraForBounds } = fakeMap([-120.1, 44.9, -120, 45], 15, 9.2);
    expect(m.alreadyOnUserMap(map, sheet, pad)).toBe(true);
    expect(cameraForBounds).toHaveBeenCalledWith([[-121, 44], [-119, 46]], { padding: pad });
    expect(m.alreadyOnUserMap(fakeMap([-123, 43, -117, 47], 9.2, 9.2).map, sheet, pad)).toBe(true);
  });
  it('sheet off screen, a speck from far out, or unfittable: fly', () => {
    expect(m.alreadyOnUserMap(fakeMap([-110, 30, -100, 40], 15, 9.2).map, sheet, pad)).toBe(false);
    expect(m.alreadyOnUserMap(fakeMap([-130, 25, -65, 50], 4, 9.2).map, sheet, pad)).toBe(false);
    expect(m.alreadyOnUserMap(fakeMap([-120.1, 44.9, -120, 45], 15, undefined).map, sheet, pad)).toBe(
      false,
    );
  });
});

describe('addedAnnouncement', () => {
  const list = [{ id: 'a-p1', title: 'Ops Day 3' }];
  const running = { importing: true, shownId: null };
  it('says the map was added when the import ends by showing it', () => {
    expect(m.addedAnnouncement(running, { importing: false, shownId: 'a-p1' }, list, false)).toBe(
      'Added Ops Day 3, shown on the map.',
    );
  });
  it('silent on cancel, on a notice (failure, duplicate), and outside an import', () => {
    const shown = { importing: true, shownId: 'a-p1' };
    expect(m.addedAnnouncement(shown, { importing: false, shownId: 'a-p1' }, list, false)).toBeNull();
    expect(m.addedAnnouncement(running, { importing: false, shownId: null }, list, false)).toBeNull();
    expect(m.addedAnnouncement(running, { importing: false, shownId: 'a-p1' }, list, true)).toBeNull();
    expect(
      m.addedAnnouncement({ importing: false, shownId: null }, { importing: false, shownId: 'a-p1' }, list, false),
    ).toBeNull();
    expect(m.addedAnnouncement(running, { importing: true, shownId: 'a-p1' }, list, false)).toBeNull();
  });
});

describe('NoticeCard focus hand-off', () => {
  type Btn = { props: { onClick: () => void; children?: unknown; 'aria-label'?: string } };
  /** The <button> elements of a hook-free component's rendered tree. */
  const buttons = (node: unknown): Btn[] => {
    const out: Btn[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      const el = n as { type?: unknown; props?: { children?: unknown } };
      if (el.type === 'button') out.push(el as Btn);
      walk(el.props?.children);
    };
    walk(node);
    return out;
  };
  afterEach(() => vi.clearAllMocks());

  it('Try again and Dismiss on a crash notice both hand focus on', () => {
    const onDone = vi.fn();
    const [retry, dismiss] = buttons(
      m.NoticeCard({ notice: { kind: 'crashed', text: 'x', docId: 'd' }, onDone }),
    );
    retry.props.onClick();
    expect(session.retryCrashedImport).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledTimes(1);
    dismiss.props.onClick();
    expect(session.dismissUserMapNotice).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledTimes(2);
  });
  it('the close button on an error notice does too', () => {
    const onDone = vi.fn();
    const [close] = buttons(m.NoticeCard({ notice: { kind: 'error', text: 'x' }, onDone }));
    expect(close.props['aria-label']).toBe('Dismiss');
    close.props.onClick();
    expect(session.dismissUserMapNotice).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledOnce();
  });
});

describe('MyMapsSection render', () => {
  const row = {
    id: 'abc-p1',
    docId: 'abc',
    page: 1,
    pageCount: 1,
    title: 'Secret_Ops_Map_Day_Shift',
    fileName: 'Secret_Ops_Map_Day_Shift.pdf',
    fileBytes: 8_700_000,
    addedAt: '2026-10-16T17:00:00Z',
    center: [-120, 45.1],
    bounds: [-121, 44, -119, 46],
    warnings: ['approximate_projection'],
  } as unknown as UserMapMeta;
  const render = (userMaps: UserMapsState) => {
    h.state = {
      layers: { userMap: { id: 'abc-p1' }, incidentMap: { opacity: 0.75 } },
      actions: {},
      userMaps,
    };
    return renderToStaticMarkup(createElement(m.MyMapsSection, { corneaId: 'c' }));
  };

  it('keeps file names out of analytics: the whole section, input included, is ph-no-capture', () => {
    const html = render({
      list: [row],
      loaded: true,
      sessionOnly: false,
      import: { fileName: 'Secret_Ops_Map_Day_Shift.pdf', stage: 'reading' },
      notice: null,
    });
    expect(html).toMatch(/^<section class="rd-map-group rd-my-maps ph-no-capture"/);
    expect(html).toContain('accept="application/pdf,.pdf"');
    expect(html).toContain('Reading Secret_Ops_Map_Day_Shift.pdf…');
    expect(html).toContain('Keep this screen open.');
    expect(html).toContain('Shown on map');
    expect(html).toContain('Position approximate');
    expect(html).toContain('Add PDF map');
  });

  it('empty, session-only, with an error notice', () => {
    const html = render({
      list: [],
      loaded: true,
      sessionOnly: true,
      import: null,
      notice: { kind: 'error', text: 'That file isn’t a PDF.' },
    });
    expect(html).toContain(
      'Lay your own georeferenced PDF (like an incident map) on the map. It stays on this device.',
    );
    expect(html).toContain('This browser can’t keep maps — they’ll be gone when you close the page.');
    expect(html).toContain('That file isn’t a PDF.');
  });

  it('iPhone Safari tab: the Home Screen note names the app as its icon does', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
      platform: 'iPhone',
      maxTouchPoints: 5,
    });
    try {
      const html = render({ list: [row], loaded: true, sessionOnly: false, import: null, notice: null });
      expect(html).toContain(
        'Safari may clear saved maps after a week away. Add Incibrief to your Home Screen to keep them.',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
