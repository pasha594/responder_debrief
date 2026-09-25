/**
 * The Walk card's time wording (owner call, SISI hands-on testing): the
 * typical time and "crew pace" only — no fast/slow bound, no "up to" — and
 * no provenance/attribution paragraph (the credit is in the map's
 * attribution control).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RouteResult } from '../../api/routing';
import { WalkRouteDetails } from './WalkRouteDetails';

const offroad: RouteResult = {
  geometry: { type: 'LineString', coordinates: [[-120.8, 48.4], [-120.79, 48.41]] },
  distanceM: 12_035, durationS: 10_086, durationRangeS: [8_073, 14_445], trafficDelayS: null,
  steps: [{ text: 'Follow Company Creek Trail 7.5 mi — about 2 h 50 min', distanceM: 12_035 }],
  engine: 'offroad', modeled: true, notes: [],
  legs: [{ kind: 'trail', coordinates: [[-120.8, 48.4], [-120.79, 48.41]], distanceM: 12_035, climbM: 1124,
    descentM: 65, durationS: 10_086, durationRangeS: [8_073, 14_445], name: 'Company Creek Trail' }],
  provenance: { bundleId: 'b', builtAt: '2026-09-25T10:00:00Z', perimeterDate: null, avoidPerimeter: true,
    cellM: 30, weighted: false, ms: 34, landfire: 'LF2025', osmDate: '2026-09-24' },
};

const html = (r: RouteResult) => renderToStaticMarkup(createElement(WalkRouteDetails, { route: r }));

describe('WalkRouteDetails', () => {
  it('leads with the typical time at crew pace and shows no bound', () => {
    const h = html(offroad);
    expect(h).toContain('<strong>2 h 50 min</strong>');
    expect(h).toContain(' · crew pace');
    expect(h).not.toMatch(/2 h 15 min|4 h\b|up to|≤|slow 4/); // fast / slow ends
    expect(h).toContain('cross-country times are modeled, not measured');
  });

  it('has no provenance or attribution paragraph', () => {
    const h = html(offroad);
    expect(h).not.toMatch(/OpenStreetMap|computed on this device|Terrain &amp; trails built|LANDFIRE/);
  });

  it('an online route is just its time', () => {
    const h = html({ ...offroad, engine: 'valhalla', modeled: false, durationRangeS: undefined });
    expect(h).toContain('<strong>2 h 50 min</strong>');
    expect(h).not.toContain('crew pace');
  });
});
