/**
 * Dependency-free behavior tests for the pure rule functions in worker.js.
 *
 * Run with any modern JS runtime that supports ES modules — no npm install:
 *
 *   node tests.js
 *
 * Ported 1:1 from the original vitest suite (34 tests). Prints one line per
 * test, a final pass count, and exits non-zero (throws) on any failure.
 */

import {
  validateRequest,
  canonicalQuery,
  ttlFor,
  upstreamContentTypeOk,
  extractLayers,
  UPSTREAM,
  TTL,
  MAX_DIM,
} from "./worker.js";

// --- tiny test harness -----------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    console.error(`FAIL ${name}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg ?? "not equal"} — expected ${b}, got ${a}`);
  }
}

function assertMatch(str, re, msg) {
  if (!re.test(str)) {
    throw new Error(`${msg ?? "no match"} — expected ${JSON.stringify(str)} to match ${re}`);
  }
}

// --- fixtures --------------------------------------------------------------

const SPREAD_LAYER =
  "fire-spread-forecast_or-paradise_20260817_112500:elmfire_landfire_50_spread-rate";
const WEATHER_LAYER = "fire-weather-forecast_hrrr_20260817_12:tmpf_20260817_180000";

function getMapParams(overrides = {}) {
  return new URLSearchParams({
    service: "WMS",
    version: "1.3.0",
    request: "GetMap",
    layers: SPREAD_LAYER,
    styles: "",
    crs: "EPSG:3857",
    bbox: "-13135699,5621521,-13024380,5713820",
    width: "1024",
    height: "1024",
    format: "image/png",
    transparent: "true",
    time: "2026-08-17T11:25:00.000Z",
    ...overrides,
  });
}

// --- validateRequest -------------------------------------------------------

test("validateRequest: accepts a well-formed spread GetMap", () => {
  const v = validateRequest(getMapParams());
  assert(v.ok === true, `expected ok, got error: ${v.error}`);
  assertEqual(v.requestType, "getmap");
  assertEqual(v.layers, [SPREAD_LAYER]);
});

test("validateRequest: accepts a GetLegendGraphic with `layer` param and no dims", () => {
  const v = validateRequest(
    new URLSearchParams({
      service: "WMS",
      version: "1.3.0",
      request: "GetLegendGraphic",
      layer: SPREAD_LAYER,
      format: "image/png",
    }),
  );
  assert(v.ok === true, `expected ok, got error: ${v.error}`);
});

test("validateRequest: accepts a GetFeatureInfo with query_layers and info_format json", () => {
  const v = validateRequest(
    new URLSearchParams({
      service: "WMS",
      version: "1.3.0",
      request: "GetFeatureInfo",
      layers: WEATHER_LAYER,
      query_layers: WEATHER_LAYER,
      crs: "EPSG:3857",
      bbox: "-13135699,5621521,-13024380,5713820",
      width: "256",
      height: "256",
      i: "128",
      j: "128",
      info_format: "application/json",
    }),
  );
  assert(v.ok === true, `expected ok, got error: ${v.error}`);
});

test("validateRequest: rejects GetCapabilities", () => {
  const v = validateRequest(
    new URLSearchParams({ service: "WMS", request: "GetCapabilities" }),
  );
  assert(v.ok === false, "expected rejection");
  assertMatch(v.error, /GetCapabilities/);
});

test("validateRequest: rejects GetCapabilities regardless of case", () => {
  const v = validateRequest(
    new URLSearchParams({ service: "wms", request: "getCAPABILITIES" }),
  );
  assert(v.ok === false, "expected rejection");
});

test("validateRequest: rejects unknown request types", () => {
  const v = validateRequest(
    new URLSearchParams({ service: "WMS", request: "DescribeLayer", layers: SPREAD_LAYER }),
  );
  assert(v.ok === false, "expected rejection");
});

test("validateRequest: rejects sld_body (never forwarded upstream)", () => {
  const params = getMapParams({ sld_body: "<StyledLayerDescriptor/>" });
  const v = validateRequest(params);
  assert(v.ok === false, "expected rejection");
  assert(v.error.includes("sld_body"), `error should mention sld_body: ${v.error}`);
  // Defense in depth: even the canonicalizer refuses to carry it.
  assert(!canonicalQuery(params).includes("sld_body"), "canonicalQuery carried sld_body");
  assert(
    !canonicalQuery(params).includes("StyledLayerDescriptor"),
    "canonicalQuery carried the SLD body",
  );
});

for (const key of ["sld", "env", "viewparams", "propertyname"]) {
  test(`validateRequest: rejects non-allowlisted param ${key}`, () => {
    const v = validateRequest(getMapParams({ [key]: "x" }));
    assert(v.ok === false, "expected rejection");
  });
}

test("validateRequest: rejects layers outside the namespace allowlist", () => {
  const v = validateRequest(getMapParams({ layers: "topp:states" }));
  assert(v.ok === false, "expected rejection");
  assertMatch(v.error, /namespace/);
});

test("validateRequest: rejects layers with disallowed characters", () => {
  const v = validateRequest(
    getMapParams({ layers: "fire-spread-forecast_x;DROP TABLE" }),
  );
  assert(v.ok === false, "expected rejection");
});

test("validateRequest: rejects a layer list where only one entry is bad", () => {
  const v = validateRequest(
    getMapParams({ layers: `${SPREAD_LAYER},topp:states` }),
  );
  assert(v.ok === false, "expected rejection");
});

test("validateRequest: rejects missing layers", () => {
  const params = getMapParams();
  params.delete("layers");
  assert(validateRequest(params).ok === false, "expected rejection");
});

test(`validateRequest: caps width/height at ${MAX_DIM}`, () => {
  assert(validateRequest(getMapParams({ width: "4096" })).ok === false, "4096 accepted");
  assert(validateRequest(getMapParams({ height: "2049" })).ok === false, "2049 accepted");
  assert(validateRequest(getMapParams({ width: "0" })).ok === false, "0 accepted");
  assert(validateRequest(getMapParams({ width: "512.5" })).ok === false, "512.5 accepted");
  assert(
    validateRequest(getMapParams({ width: "2048", height: "2048" })).ok === true,
    "2048x2048 rejected",
  );
});

test("validateRequest: rejects non-allowlisted formats", () => {
  assert(validateRequest(getMapParams({ format: "image/svg+xml" })).ok === false, "svg accepted");
  assert(validateRequest(getMapParams({ format: "application/pdf" })).ok === false, "pdf accepted");
  assert(validateRequest(getMapParams({ format: "image/jpeg" })).ok === true, "jpeg rejected");
});

test("validateRequest: rejects non-WMS service", () => {
  assert(validateRequest(getMapParams({ service: "WFS" })).ok === false, "WFS accepted");
});

// --- canonicalQuery --------------------------------------------------------

test("canonicalQuery: produces identical keys for different client param orderings", () => {
  const a = new URLSearchParams(
    "service=WMS&request=GetMap&layers=" +
      encodeURIComponent(SPREAD_LAYER) +
      "&width=512&height=512&format=image/png&bbox=1,2,3,4&crs=EPSG:3857&version=1.3.0&styles=&transparent=true&time=2026-08-17T11:25:00.000Z",
  );
  const b = new URLSearchParams(
    "time=2026-08-17T11:25:00.000Z&transparent=TRUE&styles=&version=1.3.0&crs=epsg:3857&bbox=1,2,3,4&FORMAT=image/png&HEIGHT=512&WIDTH=512&LAYERS=" +
      encodeURIComponent(SPREAD_LAYER) +
      "&REQUEST=getmap&SERVICE=wms",
  );
  assertEqual(canonicalQuery(a), canonicalQuery(b));
});

test("canonicalQuery: sorts keys and lowercases them", () => {
  const q = canonicalQuery(getMapParams());
  const keys = q.split("&").map((kv) => kv.split("=")[0]);
  assertEqual(keys, [...keys].sort());
  assert(keys.every((k) => k === k.toLowerCase()), "keys not all lowercase");
});

test("canonicalQuery: preserves layer-name and TIME case verbatim", () => {
  const q = canonicalQuery(getMapParams());
  assert(q.includes(encodeURIComponent(SPREAD_LAYER)), "layer name mangled");
  assert(q.includes(encodeURIComponent("2026-08-17T11:25:00.000Z")), "TIME mangled");
});

test("canonicalQuery: distinct TIME values yield distinct keys", () => {
  const a = canonicalQuery(getMapParams({ time: "2026-08-17T12:00:00.000Z" }));
  const b = canonicalQuery(getMapParams({ time: "2026-08-17T13:00:00.000Z" }));
  assert(a !== b, "distinct TIMEs collided");
});

test("canonicalQuery: never carries non-allowlisted params", () => {
  const q = canonicalQuery(
    getMapParams({ sld: "http://evil.example/style.sld", env: "a:b", viewparams: "x:y" }),
  );
  assert(!/sld|env=|viewparams|evil/.test(q), `leaked disallowed params: ${q}`);
});

// --- ttlFor ----------------------------------------------------------------

test("ttlFor: spread GetMap -> 7 days", () => {
  assertEqual(ttlFor("getmap", [SPREAD_LAYER]), 604800);
  assertEqual(ttlFor("getmap", [SPREAD_LAYER]), TTL.spreadGetMap);
});

test("ttlFor: weather GetMap -> 3 days", () => {
  assertEqual(ttlFor("getmap", [WEATHER_LAYER]), 259200);
});

test("ttlFor: legend -> 1 day", () => {
  assertEqual(ttlFor("getlegendgraphic", [SPREAD_LAYER]), 86400);
});

test("ttlFor: featureinfo -> 1 hour", () => {
  assertEqual(ttlFor("getfeatureinfo", [WEATHER_LAYER]), 3600);
});

test("ttlFor: other-namespace GetMap gets the conservative default", () => {
  assertEqual(
    ttlFor("getmap", ["fire-detections_current-year-perimeters:x"]),
    TTL.otherGetMap,
  );
});

test("ttlFor: mixed spread+weather layer list falls back to the conservative default", () => {
  assertEqual(ttlFor("getmap", [SPREAD_LAYER, WEATHER_LAYER]), TTL.otherGetMap);
});

// --- upstreamContentTypeOk -------------------------------------------------

test("upstreamContentTypeOk: accepts image/* for GetMap", () => {
  assert(upstreamContentTypeOk("getmap", "image/png") === true, "image/png rejected");
  assert(
    upstreamContentTypeOk("getmap", "image/jpeg;charset=UTF-8") === true,
    "image/jpeg;charset rejected",
  );
});

test("upstreamContentTypeOk: rejects GeoServer 200-XML ServiceException bodies", () => {
  assert(
    upstreamContentTypeOk("getmap", "application/vnd.ogc.se_xml;charset=UTF-8") === false,
    "se_xml accepted",
  );
  assert(upstreamContentTypeOk("getmap", "text/xml") === false, "text/xml accepted");
  assert(upstreamContentTypeOk("getmap", null) === false, "null content-type accepted");
});

test("upstreamContentTypeOk: accepts JSON for GetFeatureInfo but not XML", () => {
  assert(
    upstreamContentTypeOk("getfeatureinfo", "application/json") === true,
    "application/json rejected",
  );
  assert(upstreamContentTypeOk("getfeatureinfo", "text/xml") === false, "text/xml accepted");
});

// --- extractLayers / UPSTREAM ----------------------------------------------

test("extractLayers: splits comma lists and gathers layers, query_layers and layer", () => {
  const params = new URLSearchParams({
    layers: `${SPREAD_LAYER},${WEATHER_LAYER}`,
    query_layers: WEATHER_LAYER,
  });
  assertEqual(extractLayers(params), [SPREAD_LAYER, WEATHER_LAYER, WEATHER_LAYER]);
});

test("UPSTREAM: maps /wms01 and /wms02 to the two geoserver /ows endpoints", () => {
  assertEqual(UPSTREAM["/wms01"], "https://geoserver-usw1.pyrecast.org/geoserver01/ows");
  assertEqual(UPSTREAM["/wms02"], "https://geoserver-usw1.pyrecast.org/geoserver02/ows");
});

// --- summary ---------------------------------------------------------------

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) {
  throw new Error(`${failed} test(s) failed:\n  ${failures.join("\n  ")}`);
}
