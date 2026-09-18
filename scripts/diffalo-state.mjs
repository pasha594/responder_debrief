#!/usr/bin/env node
/**
 * Diffalo review state families for Responder Debrief.
 *
 * This app has no accounts or sign-in. Never emit `account` — the generic
 * Diffalo skill says to mint one; that is wrong here and failed a review.
 * Never emit `clientState` — Diffalo refuses it without an account today.
 * Delete that restriction once Diffalo supports account-less clientState.
 *
 * Never invent a fire slug; slugs come from the live fire API, and which fire
 * is active changes daily. That is why diffalo.json declares no fire route and
 * no fire place: Diffalo's routeKey is an exact pathname match, so a pinned
 * /fire/<slug> goes stale and the gate falls back to the home tagline. The
 * global expectText is the <title>, which every fire pathname renders.
 *
 * `expectText` feeds the dump-dom gate and means "the SPA shell loaded".
 * Readiness for the recording browser goes in `ready`, not `expectText`.
 *
 * Contract: docs at Diffalo — `list` / `run <name> --args '<json>'`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIRE_API = 'https://fire-api-prod.web.app';

/** Worker catalogs on B2. Mirrors diffalo.json's env block. */
const DATA_BASE_URL =
  process.env.VITE_DATA_BASE_URL || 'https://f005.backblazeb2.com/file/responder-debrief-data';

/** Manifests to open before giving up; candidates are largest-acreage first. */
const MAP_SHEET_SCAN_LIMIT = 20;

/**
 * First choice when it is still active; otherwise the largest active fire that
 * has a published perimeter, so the map outline is on screen either way.
 */
export const PREFERRED_SLUG = '2026-07-16-WA-LITTLE-GIANT';

// Mirrors frontend/src/app/urlState.ts + RENDERED_WEATHER_PRODUCTS — a
// bad arg must fail here, because decodeSearch drops unknown values.
const SPREAD_PRODUCTS = [
  'spread-rate', 'flame-length', 'crown-fire',
  'hours-since-burned', 'time-of-arrival', 'isochrones',
];
const PERCENTILES = [10, 30, 50, 70, 90];
const WEATHER_PRODUCTS = [
  'tmpf', 'rh', 'ws', 'wg', 'ffwi', 'smoke', 'apcp01',
];
const BASEMAPS = ['satellite', 'topo'];
const TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/;
const FIRE_QUERY_PARAMS = [
  't', 'hs', 'pm', 'hist', 'tr', 'ri', 'wx', 'ff', 'bm', 'map', 'mv', 'ir',
];
const FIRE_READY = {
  shell: 'rd-fire-shell',
  perimeter: 'rd-fire-perimeter',
};

export function parseTime(s) {
  const m = TIME_RE.exec(s);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isFinite(t) ? t : null;
}

/** unique_slug "2026-07-16-WA-LITTLE-GIANT" → url id "little-giant-wa-2026-07-16" */
export function slugToUrlId(uniqueSlug) {
  const m = /^(\d{4}-\d{2}-\d{2})-([A-Za-z]{2})-(.+)$/.exec(uniqueSlug);
  const out = m ? `${m[3]}-${m[2]}-${m[1]}` : uniqueSlug;
  return out.toLowerCase();
}

export function slugToPathname(uniqueSlug) {
  return `/fire/${slugToUrlId(uniqueSlug)}`;
}

function queryString(args) {
  const q = new URLSearchParams();
  for (const key of Object.keys(args)) {
    if (FIRE_QUERY_PARAMS.includes(key)) q.set(key, String(args[key]));
  }
  const str = q.toString();
  return str ? `?${str}` : '';
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} for ${url}`);
  }
  return res.json();
}

async function fetchActiveFires() {
  const fields = 'cornea_id,unique_slug,post_title,acres,poly_last_updated';
  // The whole active list, not a page of it: /fires is ordered by last update,
  // so limit=20 left out a 172k-acre fire and picked a 0-acre one instead.
  const url = `${FIRE_API}/fires?active=true&limit=500&fields=${fields}`;
  const body = await fetchJson(url).catch((error) => {
    throw new Error(`fire-api ${error.message}`);
  });
  return Array.isArray(body?.fires) ? body.fires : [];
}

/**
 * A forecast run still covers the playhead. `has_spread_forecast` only says a
 * run exists — most are weeks stale, and the weather rasters only carry frames
 * from now forward, so a stale run and the weather never paint at the same
 * instant. A story that wants both on screen needs a run whose horizon spans
 * now.
 */
function runCoversNow(run, nowMs) {
  const start = Date.parse(run?.run_time ?? '');
  if (!Number.isFinite(start)) return false;
  return nowMs >= start && nowMs <= start + (Number(run.horizon_hours) || 0) * 3600 * 1000;
}

/** `ff` is "{product}.{percentile}"; the picker only needs the product half. */
function forecastProduct(ff) {
  if (!ff) return null;
  const text = String(ff);
  return text.slice(0, text.lastIndexOf('.')) || null;
}

/**
 * A fire that can put the whole raster stack on screen at once: active, with a
 * georeferenced incident-map sheet, and — when the story also seeds a forecast
 * — a run that still covers now and offers the product asked for.
 *
 * PREFERRED_SLUG is no use here. `has_incident_maps` only means the FTP crawl
 * matched the fire; the sheet has to be georeferenced before it tiles, and the
 * preferred fire currently advertises the flag over an empty manifest. Only a
 * `tiles` block actually paints on the map, so that is what we filter on.
 */
async function pickFireWithMapSheet(product) {
  const nowMs = Date.now();
  const [fires, catalog, pyrecast] = await Promise.all([
    fetchActiveFires(),
    fetchJson(`${DATA_BASE_URL}/catalogs/catalog.json`),
    product ? fetchJson(`${DATA_BASE_URL}/catalogs/pyrecast_runs.json`) : null,
  ]);
  const byCorneaId = new Map(fires.filter((f) => f?.cornea_id).map((f) => [f.cornea_id, f]));

  const servesProduct = (slug) => {
    if (!product) return true;
    const runs = pyrecast?.fires?.[slug]?.runs ?? [];
    const latest = runs[runs.length - 1];
    if (!runCoversNow(latest, nowMs)) return false;
    const percentiles =
      product === 'time-of-arrival' ? latest.toa?.percentiles : latest.products?.[product]?.percentiles;
    return Array.isArray(percentiles) && percentiles.length > 0;
  };

  const candidates = (catalog?.fires ?? [])
    .filter(
      (f) =>
        f?.active &&
        f?.incident_manifest &&
        f?.has_spread_forecast &&
        byCorneaId.has(f.cornea_id) &&
        servesProduct(f.fire_slug),
    )
    .sort((a, b) => (Number(b.acres) || 0) - (Number(a.acres) || 0))
    .slice(0, MAP_SHEET_SCAN_LIMIT);

  for (const candidate of candidates) {
    const manifest = await fetchJson(`${DATA_BASE_URL}${candidate.incident_manifest}`);
    const sheet = (manifest?.maps ?? []).find((m) => m?.tiles && m?.id);
    if (sheet) return { fire: byCorneaId.get(candidate.cornea_id), mapId: sheet.id };
  }
  throw new Error(
    product
      ? `no active fire has a georeferenced incident map and a live ${product} forecast today`
      : 'no active fire has both a spread forecast and a georeferenced incident map today',
  );
}

async function pickActiveFire() {
  const fires = await fetchActiveFires();
  const preferred = fires.find((f) => f?.unique_slug === PREFERRED_SLUG);
  if (preferred?.cornea_id) return preferred;
  const withPerim = fires
    .filter((f) => f?.cornea_id && f?.poly_last_updated)
    .sort((a, b) => (Number(b.acres) || 0) - (Number(a.acres) || 0));
  const fire = withPerim[0] ?? fires.find((f) => f?.cornea_id);
  if (!fire?.cornea_id) {
    throw new Error('fire-api returned no active fires with cornea_id');
  }
  return fire;
}

export const FAMILIES = {
  directory: {
    description:
      'The national active-fire directory (default home): searchable roster of live fires, no map mounted.',
    tags: ['directory', 'home'],
    platforms: ['web'],
    args: {},
    build: async () => '/',
  },
  'fire-detail': {
    description:
      'A single active fire map shell: overview panel, layers, timeline, and map for one live incident.',
    tags: ['fire', 'map'],
    platforms: ['web'],
    args: {
      t: { time: true },
      hs: { enum: ['0'] },
      pm: { enum: ['0'] },
      hist: { enum: ['1'] },
      tr: { enum: ['1'] },
      ri: { enum: ['1'] },
      wx: { parts: WEATHER_PRODUCTS },
      ff: { products: SPREAD_PRODUCTS, percentiles: PERCENTILES },
      bm: { enum: BASEMAPS },
      map: {},
      mv: {},
      ir: {},
      ready: { enum: ['shell', 'perimeter'] },
    },
    // Perimeter outlasts the 1200ms load flyTo; shell is the mounted chrome only.
    ready: (args) => ({
      testId: args.ready === 'shell' ? FIRE_READY.shell : FIRE_READY.perimeter,
    }),
    build: async (args) => {
      const fire = await pickActiveFire();
      const pathname = fire.unique_slug
        ? slugToPathname(fire.unique_slug)
        : `/fire/${fire.cornea_id}`;
      return `${pathname}${queryString(args)}`;
    },
  },
  'fire-map-overlay': {
    description:
      'One fire with a georeferenced incident-map sheet pinned on the map, so the weather / spread-forecast / map-sheet rasters are all on screen at once.',
    tags: ['fire', 'map', 'incident'],
    platforms: ['web'],
    args: {
      t: { time: true },
      wx: { parts: WEATHER_PRODUCTS },
      ff: { products: SPREAD_PRODUCTS, percentiles: PERCENTILES },
      bm: { enum: BASEMAPS },
    },
    // The mounted fire chrome, and deliberately not the perimeter outline.
    // This family seeds from live data, so it cannot promise the fire it picks
    // has a perimeter at all — waiting on that outline is what left overlay
    // stories with no recording. The overlay rasters are what the story is
    // about, but they are the wrong thing to gate on for the same reason: a
    // product missing from today's run, or a playhead outside its coverage,
    // is a thinner review, not a review that should refuse to start.
    ready: () => ({ testId: FIRE_READY.shell }),
    // `map` is chosen here, not passed in: sheet ids are per-fire and rotate
    // with the FTP mirror, so a pinned one goes stale within the day.
    build: async (args) => {
      const { fire, mapId } = await pickFireWithMapSheet(forecastProduct(args.ff));
      const pathname = fire.unique_slug
        ? slugToPathname(fire.unique_slug)
        : `/fire/${fire.cornea_id}`;
      return `${pathname}${queryString({ ...args, map: mapId })}`;
    },
  },
  health: {
    description: 'Ingestion health: pipeline freshness and recent GitHub Actions runs.',
    tags: ['health'],
    platforms: ['web'],
    args: {},
    build: async () => '/health',
  },
  sources: {
    description: 'Sources page listing the public data feeds behind the map.',
    tags: ['sources'],
    platforms: ['web'],
    args: {},
    build: async () => '/sources',
  },
};

export function assembleResult(name, route, args) {
  const family = FAMILIES[name];
  const payload = { route };
  if (typeof family?.ready === 'function') {
    payload.ready = family.ready(args);
  }
  return payload;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function checkArg(name, key, schema, value) {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    fail(`state "${name}" argument "${key}" must be one of ${schema.enum.join(', ')}`);
  }
  if (schema.time && parseTime(value) == null) {
    fail(`state "${name}" argument "${key}" must be a UTC playhead like 20260820T1930Z`);
  }
  if (Array.isArray(schema.parts)) {
    const items = String(value).split('.');
    if (!items.length || items.some((p) => !schema.parts.includes(p))) {
      fail(
        `state "${name}" argument "${key}" must be dot-separated values from ${schema.parts.join(', ')}`,
      );
    }
  }
  if (Array.isArray(schema.products) && Array.isArray(schema.percentiles)) {
    const text = String(value);
    const dot = text.lastIndexOf('.');
    const product = text.slice(0, dot);
    const pct = Number(text.slice(dot + 1));
    if (!schema.products.includes(product) || !schema.percentiles.includes(pct)) {
      fail(
        `state "${name}" argument "${key}" must be {product}.{percentile} ` +
          `(products: ${schema.products.join(', ')}; percentiles: ${schema.percentiles.join(', ')})`,
      );
    }
  }
}

export function list() {
  const states = Object.entries(FAMILIES).map(([name, family]) => ({
    name,
    description: family.description,
    args: family.args,
    ...(family.tags ? { tags: family.tags } : {}),
    ...(family.platforms ? { platforms: family.platforms } : {}),
  }));
  process.stdout.write(`${JSON.stringify({ states })}\n`);
}

export async function run(name, rawArgs) {
  const family = FAMILIES[name];
  if (!family) {
    fail(`no such state "${name}"; this command builds ${Object.keys(FAMILIES).join(', ')}`);
  }
  let args;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch (error) {
    return fail(`--args is not JSON (${error.message})`);
  }
  for (const [key, value] of Object.entries(args)) {
    const schema = family.args[key];
    if (!schema) fail(`state "${name}" has no argument "${key}"`);
    checkArg(name, key, schema, value);
  }
  if (args.map !== undefined && args.mv !== undefined) {
    fail(`state "${name}" cannot take both "map" and "mv"`);
  }
  let route;
  try {
    route = await family.build(args);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  process.stdout.write(`${JSON.stringify(assembleResult(name, route, args))}\n`);
}

function invokedDirectly() {
  const entry = process.argv[1];
  return Boolean(entry) && fileURLToPath(import.meta.url) === path.resolve(entry);
}

function main() {
  const [subcommand, name] = process.argv.slice(2);
  if (subcommand === 'list') list();
  else if (subcommand === 'run') {
    const argsIdx = process.argv.indexOf('--args');
    const rawArgs = argsIdx >= 0 ? process.argv[argsIdx + 1] : '{}';
    run(name, rawArgs).catch((error) => fail(error instanceof Error ? error.message : String(error)));
  } else {
    fail('usage: diffalo-state.mjs list | diffalo-state.mjs run <name> --args \'<json>\'');
  }
}

if (invokedDirectly()) main();
