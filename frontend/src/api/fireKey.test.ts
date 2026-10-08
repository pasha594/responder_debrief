import { describe, expect, it } from 'vitest';
import { entryForFire, fireKey, sameFire } from './fireKey';
import { latestRun, manifestBelongsTo } from './queries';
import type { IncidentManifest, PyrecastRun } from './types';

const FL = '{961F6E41-0000-4000-8000-00000000000F}';
const WI = '{0C1D2E3F-0000-4000-8000-0000000000A1}';

describe('fireKey', () => {
  it('matches the worker key for every spelling of an id', () => {
    const want = '51528708-a49a-42fa-8855-c13ce748ec08';
    for (const id of [
      '{51528708-A49A-42FA-8855-C13CE748EC08}',
      '51528708-A49A-42FA-8855-C13CE748EC08',
      '51528708-a49a-42fa-8855-c13ce748ec08',
    ]) {
      expect(fireKey(id)).toBe(want);
    }
    expect(fireKey('')).toBeNull();
    expect(sameFire(null, null)).toBe(false);
    expect(sameFire('{ABC-1}', 'abc-1')).toBe(true);
  });
});

describe('entryForFire', () => {
  // Two active fires named Chipmunk swap the bare slug between syncs: this
  // forecast file was written while FL held "chipmunk", and the catalog the
  // site read later gives "chipmunk" to WI.
  const runs = {
    chipmunk: { cornea_id: FL, runs: [{ run_time: 'fl-run' }] },
  };

  it('finds the entry by fire id, whatever slug it sits under', () => {
    expect(entryForFire(runs, FL, 'chipmunk-fl')?.runs[0].run_time).toBe('fl-run');
    expect(entryForFire(runs, WI, 'chipmunk')).toBeUndefined();
  });

  it('falls back to the slug only for files without ids', () => {
    const old = { chipmunk: { runs: [{ run_time: 'old' }] } };
    expect(entryForFire(old, WI, 'chipmunk')?.runs[0].run_time).toBe('old');
    expect(entryForFire(old, WI, null)).toBeUndefined();
  });

  it('feeds latestRun', () => {
    const run = { workspace: 'fl', toa: { percentiles: [50], url_template: 'x' } } as unknown as PyrecastRun;
    const cat = { fires: { chipmunk: { cornea_id: FL, runs: [run] } } };
    expect(latestRun(cat, FL, 'chipmunk-fl')).toBe(run);
    expect(latestRun(cat, WI, 'chipmunk')).toBeNull();
  });
});

describe('manifestBelongsTo', () => {
  it("rejects another fire's incident maps filed under the same name", () => {
    const m = { cornea_id: '{44ACF72D-362D-4818-8504-FDB896A95A16}' } as IncidentManifest;
    expect(manifestBelongsTo(m, '{44acf72d-362d-4818-8504-fdb896a95a16}')).toBe(true);
    expect(manifestBelongsTo(m, '{A28D94D7-34C2-4D25-AE16-036B15DA80CD}')).toBe(false);
    expect(manifestBelongsTo({} as IncidentManifest, WI)).toBe(true); // no id to check
  });
});
