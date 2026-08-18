import { describe, expect, it } from 'vitest';
import type { IncidentMapEntry } from '../api/types';
import {
  compareEntries,
  friendlyOpDate,
  groupMapsByDate,
  localToday,
  productBase,
  rowAction,
  shiftIsoDate,
} from './incidentMaps';

function entry(over: Partial<IncidentMapEntry> = {}): IncidentMapEntry {
  return {
    id: over.id ?? Math.random().toString(16).slice(2),
    kind: 'product',
    product: 'other',
    product_label: 'Map',
    sheet: null,
    orientation: null,
    op_date: '2026-08-17',
    period: null,
    filename: 'a.pdf',
    pdf_url: '/raw/a.pdf',
    size_bytes: 1000,
    georeferenced: false,
    projection: null,
    preview_url: null,
    tiles: null,
    tiling_pending: false,
    rev: 1,
    ...over,
  } as IncidentMapEntry;
}

const TILES = {
  url_template: '/tiles/x/{z}/{x}/{y}.png',
  minzoom: 6,
  maxzoom: 12,
  bounds: [-119, 43, -117, 44] as [number, number, number, number],
};

describe('productBase', () => {
  it('strips the worker variant suffix', () => {
    expect(productBase('ops_arche')).toBe('ops');
    expect(productBase('trans_arche')).toBe('trans');
    expect(productBase('pio')).toBe('pio');
  });

  it('prefers the longest matching base', () => {
    expect(productBase('suppression_repair_arche')).toBe('suppression_repair');
    expect(productBase('repair_arche')).toBe('repair');
  });

  it('falls back to other for unknown or empty products', () => {
    expect(productBase('gibberish_map')).toBe('other');
    expect(productBase('')).toBe('other');
    expect(productBase(null)).toBe('other');
  });
});

describe('compareEntries', () => {
  it('orders by operational priority: ops > iap > brief > airops > evac > trans > pio', () => {
    const products = ['pio', 'trans', 'evac', 'airops', 'brief', 'iap', 'ops'];
    const sorted = products.map((p) => entry({ product: p })).sort(compareEntries);
    expect(sorted.map((e) => e.product)).toEqual([
      'ops',
      'iap',
      'brief',
      'airops',
      'evac',
      'trans',
      'pio',
    ]);
  });

  it('ranks suppression repair together, then owner, then other', () => {
    const sorted = [
      entry({ product: 'other' }),
      entry({ product: 'owner' }),
      entry({ product: 'repair_arche' }),
      entry({ product: 'suprep' }),
      entry({ product: 'pio' }),
    ].sort(compareEntries);
    expect(sorted.map((e) => productBase(e.product))).toEqual([
      'pio',
      'repair',
      'suprep',
      'owner',
      'other',
    ]);
  });

  it('puts qr after every product and mobile dead last', () => {
    const sorted = [
      entry({ kind: 'mobile', product: 'mobile' }),
      entry({ kind: 'qr', product: 'other' }),
      entry({ kind: 'product', product: 'other' }),
      entry({ kind: 'product', product: 'ops' }),
    ].sort(compareEntries);
    expect(sorted.map((e) => `${e.kind}:${e.product}`)).toEqual([
      'product:ops',
      'product:other',
      'qr:other',
      'mobile:mobile',
    ]);
  });

  it('within a type: night after day, then filename', () => {
    const sorted = [
      entry({ product: 'ops', period: 'night', filename: 'b.pdf' }),
      entry({ product: 'ops', period: 'day', filename: 'z.pdf' }),
      entry({ product: 'ops', period: 'day', filename: 'a.pdf' }),
    ].sort(compareEntries);
    expect(sorted.map((e) => `${e.period}/${e.filename}`)).toEqual([
      'day/a.pdf',
      'day/z.pdf',
      'night/b.pdf',
    ]);
  });
});

describe('groupMapsByDate', () => {
  it('groups by op_date, most recent first, undated last', () => {
    const maps = [
      entry({ op_date: '2026-08-15', product: 'ops' }),
      entry({ op_date: null, kind: 'qr' }),
      entry({ op_date: '2026-08-17', product: 'pio' }),
      entry({ op_date: '2026-08-16', product: 'ops' }),
      entry({ op_date: '2026-08-17', product: 'ops' }),
    ];
    const groups = groupMapsByDate(maps);
    expect(groups.map((g) => g.date)).toEqual(['2026-08-17', '2026-08-16', '2026-08-15', null]);
    // Newest group is sorted by type priority, not manifest order.
    expect(groups[0].entries.map((e) => e.product)).toEqual(['ops', 'pio']);
  });

  it('does not mutate the input array or its order', () => {
    const maps = [
      entry({ op_date: '2026-08-15', product: 'pio' }),
      entry({ op_date: '2026-08-15', product: 'ops' }),
    ];
    const snapshot = maps.map((m) => m.product);
    groupMapsByDate(maps);
    expect(maps.map((m) => m.product)).toEqual(snapshot);
  });

  it('handles an empty manifest', () => {
    expect(groupMapsByDate([])).toEqual([]);
  });

  it('keeps a single undated group when nothing is dated', () => {
    const groups = groupMapsByDate([entry({ op_date: null }), entry({ op_date: null })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].date).toBeNull();
    expect(groups[0].entries).toHaveLength(2);
  });
});

describe('shiftIsoDate', () => {
  it('walks backwards across a month boundary', () => {
    expect(shiftIsoDate('2026-08-01', -1)).toBe('2026-07-31');
    expect(shiftIsoDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftIsoDate('2026-08-17', 1)).toBe('2026-08-18');
  });

  it('passes garbage through untouched', () => {
    expect(shiftIsoDate('not-a-date', -1)).toBe('not-a-date');
  });
});

describe('localToday', () => {
  it('uses the fire timezone, not the viewer zone', () => {
    // 2026-08-18T05:00Z is still Aug 17 in Boise (UTC-6) and Aug 18 in UTC.
    const t = Date.parse('2026-08-18T05:00:00Z');
    expect(localToday('America/Boise', t)).toBe('2026-08-17');
    expect(localToday('UTC', t)).toBe('2026-08-18');
  });

  it('falls back to the viewer zone on a bad IANA name', () => {
    expect(localToday('Not/AZone', Date.parse('2026-08-18T05:00:00Z'))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe('friendlyOpDate', () => {
  it('labels today and yesterday relative to the fire-local date', () => {
    expect(friendlyOpDate('2026-08-17', '2026-08-17').primary).toBe('Today');
    expect(friendlyOpDate('2026-08-16', '2026-08-17').primary).toBe('Yesterday');
  });

  it('falls back to a month/day label with a weekday subtitle', () => {
    const h = friendlyOpDate('2026-08-15', '2026-08-17');
    expect(h.primary).toBe('Aug 15');
    expect(h.secondary).toBe('Sat, Aug 15');
  });

  it('renders the calendar day literally (no timezone slippage)', () => {
    // Aug 17 must never render as Aug 16 for a viewer west of GMT.
    expect(friendlyOpDate('2026-08-17', '2026-08-20').secondary).toBe('Mon, Aug 17');
  });

  it('adds the year for a different-year date', () => {
    expect(friendlyOpDate('2025-09-04', '2026-08-17').primary).toBe('Sep 4, 2025');
  });

  it('handles null and unparseable dates', () => {
    expect(friendlyOpDate(null, '2026-08-17')).toEqual({ primary: 'Undated', secondary: null });
    expect(friendlyOpDate('13/13/13', '2026-08-17').primary).toBe('13/13/13');
  });
});

describe('rowAction', () => {
  it('mobile packages are downloads regardless of georeferencing', () => {
    expect(rowAction(entry({ kind: 'mobile', georeferenced: true, tiles: TILES }))).toBe('download');
  });

  it('georeferenced + tiles overlays the map', () => {
    expect(rowAction(entry({ georeferenced: true, tiles: TILES }))).toBe('overlay');
  });

  it('georeferenced without tiles is a temporary pending state', () => {
    expect(rowAction(entry({ georeferenced: true, tiles: null, tiling_pending: true }))).toBe(
      'overlay-soon',
    );
    // Even without the pending flag: georeferencing decides, tiling does not.
    expect(rowAction(entry({ georeferenced: true, tiles: null, tiling_pending: false }))).toBe(
      'overlay-soon',
    );
  });

  it('a flat sheet offers the lightbox, never an overlay', () => {
    expect(rowAction(entry({ georeferenced: false, tiles: null, tiling_pending: true }))).toBe(
      'view',
    );
    expect(rowAction(entry({ kind: 'qr', georeferenced: false }))).toBe('view');
  });
});
