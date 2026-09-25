/**
 * The Walk card (owner calls, SISI hands-on testing): collapsed by default to
 * one line — the typical time, distance and climb — with no "crew pace", no
 * separator dots, no "modeled, not scouted" box, no weighted-search caveat
 * and no provenance/attribution paragraph (the credit is in the map's
 * attribution control). No fast/slow bound anywhere.
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
  engine: 'offroad', modeled: true,
  notes: [
    { level: 'warn', code: 'XC_STREAM', text: 'Unbridged crossing of Weasel Creek, cross-country.' },
    { level: 'info', code: 'WEIGHTED', text: 'Long search — route is near-optimal, not guaranteed shortest.' },
  ],
  legs: [
    { kind: 'trail', coordinates: [[-120.8, 48.4], [-120.795, 48.405]], distanceM: 9_000, climbM: 900,
      descentM: 40, durationS: 7_000, durationRangeS: [5_600, 10_000], name: 'Company Creek Trail' },
    { kind: 'xc', coordinates: [[-120.795, 48.405], [-120.79, 48.41]], distanceM: 3_035, climbM: 224,
      descentM: 25, durationS: 3_086, durationRangeS: [2_473, 4_445], vegM: { 4: 2_500, 1: 535 },
      streamCrossings: 1 },
  ],
  provenance: { bundleId: 'b', builtAt: '2026-09-25T10:00:00Z', perimeterDate: null, avoidPerimeter: true,
    cellM: 30, weighted: true, ms: 34, landfire: 'LF2025', osmDate: '2026-09-24' },
};

const html = (r: RouteResult, open?: boolean) =>
  renderToStaticMarkup(createElement(WalkRouteDetails, { route: r, defaultOpen: open }));

describe('WalkRouteDetails', () => {
  it('collapsed: time, distance and climb only, with a warning count', () => {
    const h = html(offroad);
    expect(h).toContain('<strong>2 h 48 min</strong>'); // whole minutes, like the mode button
    expect(h).toContain('7.5 mi');
    expect(h).toContain('↑ 3,690 ft');
    expect(h).toContain('⚠ 1');
    expect(h).not.toMatch(/Cross-country|Weasel|Steps|Avoid fire perimeter/);
  });

  it('expanded: details without dots, crew pace, the modeled box or the search caveat', () => {
    const h = html(offroad, true);
    expect(h).toContain('Unbridged crossing of Weasel Creek');
    expect(h).toContain('Cross-country');
    expect(h).toContain('Steps');
    expect(h).not.toContain(' · ');
    expect(h).not.toMatch(/crew pace|modeled, not scouted|near-optimal/);
    expect(h).not.toMatch(/2 h 15 min|4 h\b|up to|≤/); // fast / slow ends
    expect(h).not.toMatch(/OpenStreetMap|computed on this device|Terrain &amp; trails built|LANDFIRE/);
    expect(h).not.toContain('⚠ 1'); // the count only stands in for hidden notes
  });

  it('an online route is just its time', () => {
    const h = html({ ...offroad, engine: 'valhalla', modeled: false, notes: [], durationRangeS: undefined });
    expect(h).toContain('<strong>2 h 48 min</strong>');
    expect(h).not.toContain('⚠');
  });
});
