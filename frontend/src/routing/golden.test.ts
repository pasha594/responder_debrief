/**
 * Golden Walk routes on a REAL fire bundle (routes and checks: golden.ts).
 * Skipped unless ROUTING_GOLDEN_DIR names a directory holding one bundle
 * and its golden perimeter, as written by
 *
 *   cd worker && uv run python scripts/golden_bundle.py <bundle dir> <golden dir>
 *   cd frontend && ROUTING_GOLDEN_DIR=<golden dir> npx vitest run src/routing/golden.test.ts
 *
 * Real bundles are not committed (MBs, and they change with every build).
 * Each route runs through api/walkRouting.routeWalk with the Web Worker
 * client swapped for the engine in-process, so the notes checked are the
 * ones the Walk card shows (NEAR_PERIM, CROSSES_PERIM come from there).
 *
 * Every route: the drawn cross-country line never crosses an impassable or
 * BARRIER_CLASSES cell (river or open water, snow and ice, too steep)
 * other than its legs' end cells; every cut off a
 * trail and back saves LEAVE_TRAIL_PENALTY_S (less CUT_SAVING_SLACK_S)
 * over the network between its ends; with avoidance on, the
 * line stays out of the fire and its standoff except around a pin that sits
 * in them; the time range brackets the typical time, which is the sum of
 * the legs (no search-only penalty in it). Then each route's own `expect`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PerimeterFeature } from '../api/types';
import type { OffroadEngine as Engine, routeSync as RouteSync } from './engine';
import {
  CUT_SAVING_SLACK_S, GOLDEN, LEAVE_TRAIL_PENALTY_S, measureRoute, pinZone, straightClasses,
  type GoldenRoute,
} from './golden';
import { pointInRings, polygonsOf } from './safety';
import type { RoutingBundle } from './types';

const DIR = process.env.ROUTING_GOLDEN_DIR;

const hoisted = vi.hoisted(() => ({
  engine: null as unknown as Engine,
  routeSync: null as unknown as typeof RouteSync,
}));
vi.mock('./offroadClient', () => ({
  ensureBundle: async () => undefined,
  setPerimeter: async (key: string | null, polygons: [number, number][][][] | null) => {
    hoisted.engine.setPerimeter(key, polygons);
  },
  routeOffroad: async (a: [number, number], b: [number, number], avoidPerimeter: boolean,
    perimeterDate: string | null) => hoisted.routeSync(hoisted.engine, a, b, { avoidPerimeter, perimeterDate }),
}));

const SKIP = 'set ROUTING_GOLDEN_DIR to a bundle copied by worker/scripts/golden_bundle.py';

if (!DIR) {
  describe('golden Walk routes on a real bundle', () => {
    // a runtime skip, so reporters list the reason (a static it.skip in a
    // file with nothing else shows only "1 skipped")
    it(`skipped: ${SKIP}`, (ctx) => ctx.skip());
  });
} else {
  const file = (name: string) => join(DIR, name);
  for (const f of ['bundle.json', 'grid.tif', 'dem.tif', 'graph.bin.gz', 'perimeter.json']) {
    if (!existsSync(file(f))) throw new Error(`ROUTING_GOLDEN_DIR=${DIR} has no ${f} (${SKIP})`);
  }
  const bundle = JSON.parse(readFileSync(file('bundle.json'), 'utf8')) as RoutingBundle;
  const per = JSON.parse(readFileSync(file('perimeter.json'), 'utf8')) as {
    path: string; date: string; geometry: PerimeterFeature['geometry'] };
  const polys = polygonsOf(per.geometry);
  const routes = GOLDEN[bundle.fire_key];
  const buf = (name: string) => {
    const b = readFileSync(file(name));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };

  describe(`golden Walk routes: ${bundle.fire_name ?? bundle.fire_key} bundle ${bundle.bundle_id}, perimeter ${per.date}`, () => {
    let routeWalk: typeof import('../api/walkRouting').routeWalk;
    let standoffM: number;
    beforeAll(async () => {
      const eng = await import('./engine');
      hoisted.routeSync = eng.routeSync;
      hoisted.engine = await eng.OffroadEngine.load(bundle, buf('grid.tif'), buf('dem.tif'), buf('graph.bin.gz'));
      standoffM = eng.PERIMETER_STANDOFF_M;
      routeWalk = (await import('../api/walkRouting')).routeWalk;
    });

    it('has golden routes for this fire', () => {
      expect(routes, `no golden routes for fire_key ${bundle.fire_key} in golden.ts`).toBeDefined();
    });

    const walk = (rt: GoldenRoute, avoid: boolean) => routeWalk(rt.a, rt.b, {
      corneaId: bundle.cornea_id, online: false, avoidPerimeter: avoid, bundle, packed: true,
      getPerimeter: async () => ({ path: per.path, date: per.date,
        feature: { type: 'Feature', properties: {}, geometry: per.geometry } as PerimeterFeature }),
      // an hour after the perimeter: no PERIM_OLD
      nowMs: Date.parse(per.date) + 3_600_000,
    });

    for (const rt of routes ?? []) {
      it(`${rt.id}: ${rt.what}`, async () => {
        const e = hoisted.engine;
        const avoid = rt.avoid ?? true;
        // preconditions: the golden perimeter and terrain are the ones the
        // route was written for
        for (const [p, want, who] of [[rt.a, rt.pins?.a ?? 'clear', 'A'], [rt.b, rt.pins?.b ?? 'clear', 'B']] as const) {
          expect(pinZone(p, polys, standoffM), `precondition: ${who} is ${want} on perimeter ${per.date}`).toBe(want);
        }
        if (rt.straightCrosses != null) {
          expect(straightClasses(e, rt.a, rt.b).has(rt.straightCrosses),
            `precondition: the straight A–B line crosses veg class ${rt.straightCrosses}`).toBe(true);
        }

        const r = await walk(rt, avoid);
        const m = measureRoute(e, r, rt.a, rt.b, polys, avoid ? e.mask : null);
        const codes = (r.notes ?? []).map((n) => n.code);
        const got = JSON.stringify({ km: +(m.distanceM / 1000).toFixed(2), h: +(m.typicalS / 3600).toFixed(2),
          net: +m.networkShare.toFixed(3), cuts: m.cuts.map((c) => Math.round(c.savingS)), bridges: m.bridges, codes });

        // every route
        expect(m.xcBarriers, `cross-country through river, snow/ice or cliff cells: ${got}`).toEqual({});
        for (const c of m.cuts) {
          expect(c.savingS, `a ${Math.round(c.lengthM)} m cut off ${c.from} saves under the leave penalty: ${got}`)
            .toBeGreaterThanOrEqual(LEAVE_TRAIL_PENALTY_S - CUT_SAVING_SLACK_S);
        }
        expect(Math.abs(r.durationS - (r.legs ?? []).reduce((s, l) => s + (l.durationS ?? 0), 0))).toBeLessThan(1);
        expect(r.durationRangeS![0]).toBeLessThanOrEqual(r.durationS);
        expect(r.durationRangeS![1]).toBeGreaterThanOrEqual(r.durationS);
        if (avoid) {
          const pinPolys = polys.map((poly, i) => (pointInRings(rt.a, poly) || pointInRings(rt.b, poly) ? i : -1))
            .filter((i) => i >= 0);
          expect(m.firePolys.filter((i) => !pinPolys.includes(i)), `enters a fire polygon no pin is in: ${got}`).toEqual([]);
          if (!pinPolys.length) {
            // half a cell: a graph leg between two clear vertices may clip a
            // masked cell's corner
            expect(m.maskedFarM, `metres in the fire or its standoff away from the pins: ${got}`).toBeLessThanOrEqual(15);
          }
        }

        // this route's own
        const x = rt.expect;
        if (x.minNetworkShare != null) expect(m.networkShare, got).toBeGreaterThanOrEqual(x.minNetworkShare);
        if (x.maxNetworkShare != null) expect(m.networkShare, got).toBeLessThanOrEqual(x.maxNetworkShare);
        if (x.maxXcM != null) expect(m.xcM, got).toBeLessThanOrEqual(x.maxXcM);
        if (x.typicalS) {
          expect(m.typicalS, got).toBeGreaterThanOrEqual(x.typicalS[0]);
          expect(m.typicalS, got).toBeLessThanOrEqual(x.typicalS[1]);
        }
        if (x.maxCuts != null) expect(m.cuts.length, `switchback cuts: ${got}`).toBeLessThanOrEqual(x.maxCuts);
        if (x.bridge) {
          expect(m.bridges.length, `crosses no river on a graph bridge: ${got}`).toBeGreaterThan(0);
          if (typeof x.bridge === 'string') expect(m.bridges, got).toContain(x.bridge);
        }
        for (const name of x.via ?? []) expect(m.legNames, got).toContain(name);
        for (const c of x.notes ?? []) expect(codes, got).toContain(c);
        for (const c of x.noNotes ?? []) expect(codes, got).not.toContain(c);
        for (const name of x.noFords ?? []) expect(m.fords, got).not.toContain(name);
        if (x.maxFireM != null) expect(m.fireM, `metres inside the fire: ${got}`).toBeLessThanOrEqual(x.maxFireM);
      });
    }
  });
}
