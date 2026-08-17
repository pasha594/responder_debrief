# WMS caching proxy (Cloudflare Worker)

Caching proxy in front of the pyrecast geoservers, deployed to
`https://responder-debrief-wms.<account>.workers.dev`. It exists because
pyrecast 403s every browser Origin except `https://pyrecast.org`: the Worker
fetches upstream with fresh headers (no Origin/Cookie), caches tiles at the
edge (`caches.default`), and adds `access-control-allow-origin: *` so the
GitHub Pages frontend can use the layers.

**No npm.** Three files, zero dependencies:

| File | What |
|---|---|
| `worker.js` | The entire Worker — plain-JS ES module. Pure rule functions (`validateRequest`, `canonicalQuery`, `ttlFor`, `upstreamContentTypeOk`, ...) are named exports; the fetch handler is the default export. |
| `tests.js` | 34 behavior tests for the pure rules. Dependency-free ESM with its own tiny assert harness. |
| `deploy.py` | Python 3 stdlib-only deploy: uploads `worker.js` via the Cloudflare API, enables the workers.dev route, prints the URL. |

## Tests

```sh
node tests.js        # any Node ≥18 works; prints "34/34 tests passed"
```

(GitHub's ubuntu-latest runners have Node preinstalled — no npm install anywhere.)

## Deploy

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... python3 deploy.py
python3 deploy.py --dry-run    # build+inspect the upload body; no network/creds
```

The token needs the **Workers Scripts: Edit** permission. CI
(`.github/workflows/deploy-proxy.yml`) runs `node proxy/tests.js` then
`python3 proxy/deploy.py` on every push to `main` touching `proxy/**`.

## Local dev

There is no local Worker runtime here (that was wrangler). App development
doesn't need one — the frontend's Vite dev server proxies `/wms01`/`/wms02`
straight to the geoservers with the Origin header stripped. The Worker's live
behavior (caching, CORS, validation) is verified after deploy with curl; see
the root README for example requests.
