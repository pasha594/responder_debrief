/**
 * responder-debrief-wms — Cloudflare Worker caching proxy for pyrecast WMS.
 *
 * Single-file plain-JavaScript ES module: no npm, no build step. The pure
 * validation / canonicalization / TTL rules are named exports (unit-tested by
 * tests.js under plain Node); the Worker entry point is `export default`.
 *
 * Routes:
 *   GET /        → tiny JSON service descriptor
 *   GET /wms01   → geoserver01 /ows (weather, detections, risk, fuels)
 *   GET /wms02   → geoserver02 /ows (fire spread forecasts)
 *
 * Why this exists: pyrecast's geoservers hard-403 every browser Origin except
 * https://pyrecast.org. The Worker fetches upstream WITHOUT Origin/Cookie
 * headers (passing their allowlist) and adds an edge cache + ACAO:* so the
 * GitHub Pages frontend can use the layers.
 *
 * Design source: docs/spec-backend.md §"WMS proxy (Cloudflare Worker) pseudocode"
 * and docs/plan.md §"WMS caching proxy".
 */

// ---------------------------------------------------------------------------
// Pure rules (no Workers-runtime types — unit-testable under plain Node)
// ---------------------------------------------------------------------------

/** Route path → upstream GeoServer OWS endpoint. @type {Record<string, string>} */
export const UPSTREAM = {
  "/wms01": "https://geoserver-usw1.pyrecast.org/geoserver01/ows",
  "/wms02": "https://geoserver-usw1.pyrecast.org/geoserver02/ows",
};

/** Allowed WMS request types (lowercased). GetCapabilities is NEVER allowed. */
export const ALLOWED_REQUESTS = new Set([
  "getmap",
  "getlegendgraphic",
  "getfeatureinfo",
]);

/**
 * Query-parameter allowlist (lowercased keys). Anything outside this set —
 * notably sld, sld_body, env, viewparams — causes a 400 and is never
 * forwarded upstream (no SSRF / style injection).
 */
export const ALLOWED_PARAMS = new Set([
  "service",
  "version",
  "request",
  "layers",
  "query_layers",
  "layer",
  "styles",
  "crs",
  "srs",
  "bbox",
  "width",
  "height",
  "format",
  "transparent",
  "time",
  "info_format",
  "i",
  "j",
  "x",
  "y",
  "feature_count",
]);

/** Character allowlist for a single layer name. */
export const LAYER_RE = /^[A-Za-z0-9_.:-]+$/;

/** Workspace-namespace prefixes a layer name must start with. */
export const LAYER_NS = [
  "fire-spread-forecast_",
  "fire-weather-forecast_",
  "fire-risk-forecast_",
  "fire-detections_",
  "fuels-and-topography_",
];

/** Allowed output formats (format / info_format values, lowercased). */
export const FORMAT_OK = new Set([
  "image/png",
  "image/jpeg",
  "application/json",
]);

/** Max GetMap/GetFeatureInfo width/height in pixels. */
export const MAX_DIM = 2048;

/** TTLs in seconds, by cache class. */
export const TTL = {
  spreadGetMap: 604800, // 7 d  — run-stamped, effectively immutable
  weatherGetMap: 259200, // 3 d — run-stamped, effectively immutable
  otherGetMap: 3600, // conservative default for other namespaces (e.g. fire-detections_)
  legend: 86400, // 1 d
  featureInfo: 3600, // 1 h
};

/**
 * @typedef {{ ok: true, requestType: string, layers: string[] }} ValidOk
 *   requestType — lowercased request type, e.g. "getmap".
 *   layers — all layer names referenced by the request (split on commas).
 * @typedef {{ ok: false, error: string }} ValidErr
 *   error — human-readable reason, returned in the 400 body.
 * @typedef {ValidOk | ValidErr} ValidationResult
 */

/** Case-insensitive params whose VALUES are lowercased during canonicalization. */
const CI_VALUE_PARAMS = new Set([
  "service",
  "version",
  "request",
  "format",
  "info_format",
  "transparent",
  "crs",
  "srs",
]);

/**
 * @param {string} error
 * @returns {ValidErr}
 */
function err(error) {
  return { ok: false, error };
}

/**
 * Split comma-separated layer params into individual layer names.
 * @param {URLSearchParams} params
 * @returns {string[]}
 */
export function extractLayers(params) {
  const out = [];
  for (const key of ["layers", "query_layers", "layer"]) {
    for (const [k, v] of params.entries()) {
      if (k.toLowerCase() === key && v !== "") {
        for (const name of v.split(",")) {
          const trimmed = name.trim();
          if (trimmed !== "") out.push(trimmed);
        }
      }
    }
  }
  return out;
}

/**
 * Validate an incoming WMS query against the allowlists.
 * Rejects (400): unknown request types (incl. GetCapabilities), any
 * non-allowlisted param (sld, sld_body, env, viewparams, ...), bad layer
 * characters or namespaces, oversized dims, unknown formats.
 * @param {URLSearchParams} params
 * @returns {ValidationResult}
 */
export function validateRequest(params) {
  // 1. Every param key must be on the allowlist. Reject — never silently
  //    strip-and-forward — so sld_body etc. can never reach upstream.
  for (const [key] of params.entries()) {
    if (!ALLOWED_PARAMS.has(key.toLowerCase())) {
      return err(`parameter not allowed: ${key.toLowerCase()}`);
    }
  }

  // 2. service must be WMS.
  const service = (getParamCI(params, "service") ?? "").toLowerCase();
  if (service !== "wms") {
    return err("service must be WMS");
  }

  // 3. request must be one of the allowed types. GetCapabilities is blocked.
  const requestType = (getParamCI(params, "request") ?? "").toLowerCase();
  if (!ALLOWED_REQUESTS.has(requestType)) {
    return err(
      requestType === "getcapabilities"
        ? "GetCapabilities is not served by this proxy"
        : `request not allowed: ${requestType || "(missing)"}`,
    );
  }

  // 4. Layers: at least one, each matching the char regex + namespace prefix.
  const layers = extractLayers(params);
  if (layers.length === 0) {
    return err("no layer specified");
  }
  for (const name of layers) {
    if (!LAYER_RE.test(name)) {
      return err(`invalid layer name: ${name}`);
    }
    if (!LAYER_NS.some((ns) => name.startsWith(ns))) {
      return err(`layer namespace not allowed: ${name}`);
    }
  }

  // 5. Dimensions: integers in [1, MAX_DIM]. Required for GetMap.
  for (const dim of ["width", "height"]) {
    const raw = getParamCI(params, dim);
    if (raw === undefined) {
      if (requestType === "getmap") return err(`missing ${dim}`);
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DIM) {
      return err(`${dim} must be an integer between 1 and ${MAX_DIM}`);
    }
  }

  // 6. Formats.
  const format = getParamCI(params, "format");
  if (requestType === "getmap" || requestType === "getlegendgraphic") {
    if (format === undefined || !FORMAT_OK.has(format.toLowerCase())) {
      return err(`format must be one of: ${[...FORMAT_OK].join(", ")}`);
    }
  } else if (format !== undefined && !FORMAT_OK.has(format.toLowerCase())) {
    return err(`format must be one of: ${[...FORMAT_OK].join(", ")}`);
  }
  const infoFormat = getParamCI(params, "info_format");
  if (infoFormat !== undefined && !FORMAT_OK.has(infoFormat.toLowerCase())) {
    return err(`info_format must be one of: ${[...FORMAT_OK].join(", ")}`);
  }

  return { ok: true, requestType, layers };
}

/**
 * First value for a key, matched case-insensitively.
 * @param {URLSearchParams} params
 * @param {string} key
 * @returns {string | undefined}
 */
function getParamCI(params, key) {
  for (const [k, v] of params.entries()) {
    if (k.toLowerCase() === key) return v;
  }
  return undefined;
}

/**
 * Canonical query string = the cache key (and the exact upstream query).
 * - keys lowercased; values of case-insensitive params lowercased
 * - entries sorted by key, then value (stable regardless of client ordering)
 * - only allowlisted params survive (defense in depth: even if validation
 *   were bypassed, sld_body/env/viewparams can never appear here)
 * - TIME is included verbatim — every timeline frame is its own cache entry
 * @param {URLSearchParams} params
 * @returns {string}
 */
export function canonicalQuery(params) {
  /** @type {Array<[string, string]>} */
  const entries = [];
  for (const [k, v] of params.entries()) {
    const key = k.toLowerCase();
    if (!ALLOWED_PARAMS.has(key)) continue;
    const value = CI_VALUE_PARAMS.has(key) ? v.toLowerCase() : v;
    entries.push([key, value]);
  }
  entries.sort(([ka, va], [kb, vb]) =>
    ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0,
  );
  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/**
 * Cache TTL in seconds for a validated request.
 * spread GetMap 7 d / weather GetMap 3 d (both run-stamped workspaces →
 * effectively immutable), legends 1 d, GetFeatureInfo 1 h. GetMap on other
 * namespaces (e.g. fire-detections_current-year-perimeters, which updates
 * continuously) gets a conservative 1 h.
 * @param {string} requestType
 * @param {string[]} layers
 * @returns {number}
 */
export function ttlFor(requestType, layers) {
  switch (requestType) {
    case "getlegendgraphic":
      return TTL.legend;
    case "getfeatureinfo":
      return TTL.featureInfo;
    case "getmap": {
      if (layers.every((l) => l.startsWith("fire-spread-forecast_"))) {
        return TTL.spreadGetMap;
      }
      if (layers.every((l) => l.startsWith("fire-weather-forecast_"))) {
        return TTL.weatherGetMap;
      }
      return TTL.otherGetMap;
    }
    default:
      return TTL.featureInfo;
  }
}

/**
 * Is the upstream 200 response cacheable/returnable for this request type?
 * GeoServer reports ServiceExceptions as 200 + XML — those must become a
 * 502 no-store, never a cached "image".
 * @param {string} requestType
 * @param {string | null} contentType
 * @returns {boolean}
 */
export function upstreamContentTypeOk(requestType, contentType) {
  const ct = (contentType ?? "").toLowerCase();
  if (requestType === "getfeatureinfo") {
    return ct.includes("json") || ct.startsWith("image/");
  }
  return ct.startsWith("image/");
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET",
  "access-control-max-age": "86400",
};

/**
 * @param {unknown} body
 * @param {number} status
 * @param {Record<string, string>} [extra]
 * @returns {Response}
 */
function jsonResponse(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extra,
    },
  });
}

export default {
  /**
   * @param {Request} request
   * @param {unknown} _env
   * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, 405, {
        allow: "GET, OPTIONS",
        "cache-control": "no-store",
      });
    }

    if (url.pathname === "/") {
      return jsonResponse(
        { service: "responder-debrief-wms", routes: ["/wms01", "/wms02"] },
        200,
        { "cache-control": "public, max-age=3600" },
      );
    }

    const upstreamBase = UPSTREAM[url.pathname];
    if (upstreamBase === undefined) {
      return jsonResponse({ error: "not found" }, 404, { "cache-control": "no-store" });
    }

    // --- Validate against the allowlists --------------------------------
    const verdict = validateRequest(url.searchParams);
    if (!verdict.ok) {
      return jsonResponse({ error: verdict.error }, 400, { "cache-control": "no-store" });
    }

    // --- Cache lookup on the canonical sorted query ---------------------
    const canonical = canonicalQuery(url.searchParams);
    const cacheKey = new Request(`${url.origin}${url.pathname}?${canonical}`, {
      method: "GET",
    });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("x-proxy-cache", "HIT");
      headers.set("access-control-allow-origin", "*");
      return new Response(hit.body, { status: hit.status, headers });
    }

    // --- Upstream fetch: fresh headers only — no Origin, no Cookie ------
    // (pyrecast 403s foreign Origins; GS_FLOW_CONTROL cookies are dropped
    // in both directions because we never copy request or response headers.)
    let upstream;
    try {
      upstream = await fetch(`${upstreamBase}?${canonical}`, {
        method: "GET",
        headers: {
          accept: "image/png,image/jpeg,application/json,*/*",
          "user-agent": "responder-debrief-wms-proxy/1.0",
        },
        redirect: "follow",
      });
    } catch {
      return jsonResponse({ error: "upstream unreachable" }, 502, {
        "cache-control": "no-store",
        "x-upstream-status": "0",
      });
    }

    if (!upstream.ok) {
      // Frontend uses x-upstream-status: 404 as its run-rotation signal.
      return jsonResponse({ error: "upstream error" }, 502, {
        "cache-control": "no-store",
        "x-upstream-status": String(upstream.status),
      });
    }

    const contentType = upstream.headers.get("content-type");
    if (!upstreamContentTypeOk(verdict.requestType, contentType)) {
      // GeoServer ServiceException: 200 + XML. Don't cache, don't pass off
      // as an image.
      return jsonResponse({ error: "upstream returned non-image response" }, 502, {
        "cache-control": "no-store",
        "x-upstream-status": String(upstream.status),
        "x-upstream-content-type": contentType ?? "",
      });
    }

    const ttl = ttlFor(verdict.requestType, verdict.layers);
    const body = await upstream.arrayBuffer();
    const headers = new Headers({
      "content-type": contentType ?? "application/octet-stream",
      "cache-control": `public, max-age=${ttl}`,
      "access-control-allow-origin": "*",
      "x-proxy-cache": "MISS",
    });
    // Observability: surface GeoServer flow-control delay if reported.
    const flowDelay = upstream.headers.get("x-upstream-flow-delay");
    if (flowDelay !== null) headers.set("x-upstream-flow-delay", flowDelay);
    // Note: Set-Cookie is never forwarded — headers above are built fresh.

    const response = new Response(body, { status: 200, headers });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
