import { describe, expect, it } from 'vitest';
import { groundKey, trailPopupHtml, trailTitle, trailsVisible, usesText } from './trailsStyle';

describe('trails ground + visibility', () => {
  it('picks the ground', () => {
    expect(groundKey('topo', 'dark', false)).toBe('topo');
    expect(groundKey('satellite', 'light', false)).toBe('satellite');
    expect(groundKey('map', 'dark', false)).toBe('map-dark');
    expect(groundKey('map', 'light', false)).toBe('map-light');
    expect(groundKey('topo', 'dark', true)).toBe('offline');
  });

  it("'auto' shows trails only offline; explicit choices win", () => {
    expect(trailsVisible('auto', 'topo')).toBe(false);
    expect(trailsVisible('auto', 'offline')).toBe(true);
    expect(trailsVisible('on', 'topo')).toBe(true);
    expect(trailsVisible('off', 'offline')).toBe(false);
  });
});

describe('trail popup', () => {
  it('titles and uses', () => {
    expect(trailTitle({ name: 'Iron Creek', num: '640' })).toBe('Iron Creek #640');
    expect(trailTitle({ num: '12' })).toBe('Trail #12');
    expect(trailTitle({})).toBe('Unnamed trail');
    expect(usesText('H,P,B')).toBe('Allowed: hiker, pack & saddle, bicycle');
    expect(usesText('')).toBe('Allowed uses not published');
  });

  it('shows restrictions (still routed) and escapes everything', () => {
    const html = trailPopupHtml({
      name: '<img src=x onerror=alert(1)>', agency: 'USFS', cls: 3, uses: 'H',
      restr: 'Hiker restricted 01/01–12/31', season: '05/15–09/15', mgmt: 'Wilderness',
      src_date: '2026-09-23', status: 'open',
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('Restricted: Hiker restricted 01/01–12/31');
    expect(html).toContain('Walk routes still use it');
    expect(html).toContain('Class 3 (developed)');
    expect(html).toContain('USFS National Forest System Trails, 2026-09-23');
    expect(html).toContain('data-walk-here');
    const blm = trailPopupHtml({ agency: 'BLM', status: 'not_assessed', uses: '' });
    expect(blm).toContain('Not assessed');
    expect(blm).not.toContain('Restricted');
  });
});
