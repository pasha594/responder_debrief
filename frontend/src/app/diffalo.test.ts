/**
 * Diffalo review contract. Three things broke a review before these existed:
 * an `account` in the state result, an `expectText` the dump-dom gate could
 * not see, and a fire pathname pinned in diffalo.json that went stale.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assembleResult, PREFERRED_SLUG, slugToPathname } from '../../../scripts/diffalo-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const spec = JSON.parse(read('diffalo.json')) as {
  app: Record<string, unknown>;
  env?: Record<string, string>;
  recordable: {
    expectText: string[];
    places: Record<string, string>;
    routes: Record<string, unknown>;
  };
};

describe('diffalo state result', () => {
  it('never contains an account or clientState key', () => {
    const result = assembleResult('fire-detail', slugToPathname(PREFERRED_SLUG), {});
    expect('account' in result).toBe(false);
    expect('clientState' in result).toBe(false);
  });

  it('asks the recording browser to wait on a testid the app renders', () => {
    const shell = assembleResult('fire-detail', '/fire/x', { ready: 'shell' });
    const perimeter = assembleResult('fire-detail', '/fire/x', {});
    expect(shell.ready).toEqual({ testId: 'rd-fire-shell' });
    expect(perimeter.ready).toEqual({ testId: 'rd-fire-perimeter' });
    expect(read('frontend/src/panels/BackControl.tsx')).toContain('data-testid="rd-fire-shell"');
    expect(read('frontend/src/app/App.tsx')).toContain('data-testid="rd-fire-perimeter"');
  });
});

describe('diffalo.json', () => {
  // The gate renders with --dump-dom, so it reads the served HTML. Text only
  // React paints times out at 90s; text in index.html is there on every route.
  it('declares global expectText that the served HTML already contains', () => {
    const html = read('frontend/index.html');
    for (const text of spec.recordable.expectText) expect(html).toContain(text);
  });

  // routeKey is an exact pathname match and active fires rotate weekly, so a
  // pinned fire path silently hands the fire page the home tagline.
  it('pins no fire pathname', () => {
    expect(Object.keys(spec.recordable.places)).not.toContain('fire');
    for (const route of Object.keys(spec.recordable.routes)) {
      expect(route.startsWith('/fire')).toBe(false);
    }
  });

  // Diffalo's app block reads only install/dev/cwd, so an env map nested there
  // is dropped silently and the review records the app with no data URL.
  it('keeps env at the top level and off the app block', () => {
    expect(spec.env?.VITE_DATA_BASE_URL).toBeTruthy();
    expect(spec.app).not.toHaveProperty('env');
  });

  // f004 returns 404 for every path in this bucket.
  it('points the data URL at the host that serves the bucket', () => {
    expect(spec.env?.VITE_DATA_BASE_URL).toBe(
      'https://f005.backblazeb2.com/file/responder-debrief-data',
    );
  });

  // These tests import node: builtins. The app tsconfig has no Node types,
  // and `npm run build` runs `tsc --noEmit` first — leaving them included
  // fails Pages deploys.
  it('keeps Node-importing tests out of the app typecheck', () => {
    const tsconfig = JSON.parse(read('frontend/tsconfig.json')) as {
      exclude?: string[];
    };
    expect(tsconfig.exclude).toContain('src/**/*.test.ts');
  });
});

describe('diffalo scaffolding doc', () => {
  // An earlier draft of this page told agents to add places.fire and
  // /fire/review, which is the stale-slug trap the rest of this file locks.
  it('does not tell agents to pin a fire place or review path', () => {
    const doc = read('docs/diffalo-review-scaffolding.md');
    expect(doc).not.toMatch(/places\.fire/);
    expect(doc).not.toContain('/fire/review');
  });
});
