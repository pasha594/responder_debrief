# Trails overlay + offline off-road routing — working notes

Status (2026-09-25): the merged plan is `FINAL_PLAN.md`; the first full build
(worker + frontend) is on this branch — see `STATUS.md` for what is done,
tested and unverified. These are working notes for the build, not
user-facing docs — condense or remove them before merging to `main` (the
repo is public).

## What we're building

1. **Trails overlay.** Forest Service, BLM and Park Service trails, normalized
   to one schema, baked weekly by the worker into a national PMTiles archive on
   B2 (versioned immutable key + mutable pointer JSON), drawn in our own style
   with tap popups (name, number, agency, class, allowed uses / official
   restrictions, source date) and a Layers-tab toggle. Each fire's offline pack
   gets a small per-fire trails extract.
2. **Offline off-road foot routing ("Walk" upgraded).** For every active fire
   the worker builds a routing bundle: an OSM + agency-trail graph and a 30 m
   travel-cost grid (slope + LANDFIRE vegetation per the USFS Ground Evacuation
   Time v2 multipliers, streams, water, >45° impassable). The browser runs
   hybrid A* in a Web Worker, avoids the latest perimeter, and shows road/trail
   legs solid and cross-country legs dashed and colored by vegetation, with a
   time range (Sullivan 2020 loaded-crew tertiles on trail, GET v2 off trail),
   a trail/cross-country split, climb, steps, and a persistent
   "Cross-country legs are modeled, not scouted" label. Optional Vegetation
   layer painted from the same grid. Outside a fire's routing area, Walk falls
   back to today's online engines and draws any unreachable end-gap dashed.

## Owner decisions (final)

- Tile format: **PMTiles** — the `pmtiles` npm package (7.7 kB gz, dep: fflate)
  is approved. Per-fire extract in the offline pack.
- **Upgrade Walk** (no separate mode button).
- **Route on all trails** regardless of legal-use restrictions (crews count as
  administrative use); show restrictions in popups.
- **All active fires** get routing bundles (~312 today), biggest first.
  Cost checked: B2 storage ~$6.95/TB-month (first 10 GB free), uploads free,
  egress free up to 3× stored per month — negligible for this feature.

## Standing owner preferences

- Minimal npm dependencies (justify any package; prefer ~50 lines of our own
  code unless that would rebuild a vendor SDK), Python for tooling/data work.
- GitHub-only hosting: GitHub Pages + Actions + Backblaze B2. No servers,
  proxies or Cloudflare.
- Bulk/backfill fire-API traffic goes to `https://fire-api-dev.web.app`; prod
  is for the live site only.
- Never auto-prune FTP-derived incident data; deletes are manual only.
- Offline packs: OPFS + main-thread `window.fetch` wrapper (not SW caching).

## Files here

- `STATUS.md` — what is built, how it was tested on real data, open questions.
- `FINAL_PLAN.md` — the merged design (STATUS wins where they disagree).

The research notes, codebase maps and the three competing draft designs that
led here were trimmed before merging to main; they remain in this branch's
history (commit 30d76d5).

## Must-knows the judges flagged

- `main` moved after the designs were written: dropped-pin work added
  `frontend/src/map/pinDrop.ts` `FEATURE_LAYERS` / `clicksClaimed`, the NWCG
  draw work renamed the `rd-draw-*` ids, and `ensureOrder` was rewritten
  (plus `rd-hotspot-flames`). Every new clickable layer must join
  `FEATURE_LAYERS` — not optional.
- Off-trail slope must use GET v2's isotropic rate on terrain slope (sidehill
  travel is penalized), not directional grade — pipeline/model got this wrong
  (contouring a 35° timbered slope came out ~3× too fast).
- NHD HU8 GeoPackage lookup: only the field design's TNM title filter matches.
- Hard perimeter block (with a standoff, graph nodes included) and explicit
  behavior when an endpoint is inside the perimeter; endpoint snapping.
- No automated `--confirm` pruning from cron (repo deletion convention).
- Pin `runs-on: ubuntu-24.04` (GDAL 3.8.4); don't read PMTiles with GDAL 3.8.4.
