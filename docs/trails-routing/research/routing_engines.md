# Routing engines and hosted APIs for on-foot trail routing (plus off-road vehicle options), callable from a static browser app

Research date: 2026-09-24. Scope: US backcountry, for the Walk/hike mode of Responder Debrief (static GitHub Pages, MapLibre, no backend or proxy, keys must be safe to expose). Empirical tests were run from the CLI on 2026-09-24 between 20:34 and 20:36 UTC, sending `Origin: https://incibrief.com` so CORS headers could be observed. In total 25 requests went to public endpoints, at least 3 s apart: 3 Overpass attempts (all failed with 504 or timeout), 3 Nominatim lookups for coordinates, and 19 routing or CORS-preflight requests. Raw responses are saved in `scratchpad/rt/tests/*.body`, with the request log in `scratchpad/rt/tests/request_log*.json`.

Test coordinates come from Nominatim (OSM) lookups on 2026-09-24:
- Iron Creek Trailhead, Sawtooth NF, ID: 44.19870, -115.01402 (OSM `highway=trailhead`, on the "Iron Creek-Stanley Lake Trail").
- Stanley Lake Trailhead, ID: 44.24711, -115.06576. The straight-line distance from Iron Creek is 6.78 km.
- South Fork Teton Trailhead, Bob Marshall Wilderness front, MT: 47.84753, -112.78245 (on the "Headquarters Creek Trail").
- Rocky Mountain summit (OSM `natural=peak`): 47.81245, -112.80032. It is 4.12 km in a straight line from that trailhead and about 814 m from the nearest mapped way.

---

## 1. Valhalla pedestrian costing, location snapping, exclude_polygons, /height, vehicle off-road options, and the FOSSGIS public server (valhalla1.openstreetmap.de)

### Takeaway
Valhalla's pedestrian costing has no "prefer trails" control for typical US trails tagged `highway=path`:
- `walkway_factor` only affects `highway=footway`.
- `max_hiking_difficulty` (default 1 = sac_scale T1) only blocks trails that carry a `sac_scale` tag. Untagged trails are always allowed.
- Grade always slows pedestrian time, via a DIN 33466/Tobler-style table. `use_hills` (default 0.5) adds a separate cost penalty on hills.

Off-network points are snapped silently to the nearest well-connected edge. By default that can be up to 35 km away. The /route response never states the gap, but `search_cutoff` can turn a far snap into an explicit error.

The FOSSGIS server is keyless and CORS-open, including a preflight that allows `X-Client-Id`. It limits clients to 1 request per second per user, with bursts of 10. Apps published to end users are asked to announce themselves and send `X-Client-Id`. The maintainers originally said it is not for third-party production services.

### Cited Findings
**Pedestrian costing options and defaults** (Valhalla master; FOSSGIS runs 3.9.0):
- Pedestrian defaults in source:
  - `walking_speed` 5.1 km/h (range 0.5–25).
  - `max_hiking_difficulty` default 1 (T1 "hiking"), range 0–6.
  - `walkway_factor` 1.0; `sidewalk_factor` 1.0; `alley_factor` 2.0; `driveway_factor` 5.0; `step_penalty` 30 s.
  - `service_penalty` 0 s; `use_hills` 0.5.
  - `max_distance` 100 km for foot.
  - `max_grade` default 90 for foot and 12 for wheelchair.
  - `type` defaults to "foot".
  — [pedestriancost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/pedestriancost.cc)
- `use_tracks` defaults to 0.5 in the shared DynamicCost, and pedestrian costing does not override it. The resulting track factor is:
  - 1.0 (neutral) at 0.5.
  - It falls linearly to 0.8 at 1.0 (a mild preference for tracks).
  - It rises to 4.0, plus a 300 s one-time penalty, at 0.
  — [dynamiccost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/dynamiccost.cc)
- The docs describe `max_hiking_difficulty` as values 0–6 that correspond to OSM `sac_scale`. The default of 1 allows well-cleared trails that are mostly flat or gently sloped. The docs describe `use_tracks` as "near 1 will favor tracks a little bit", default 0.5 for pedestrian. — [Valhalla route API reference (docs source)](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md)
- The sac_scale mapping, taken from the code comments and GraphHopper's identical `hike_rating` encoding:

  | Value | sac_scale | SAC grade |
  |---|---|---|
  | 0 | missing | – |
  | 1 | hiking | T1 |
  | 2 | mountain_hiking | T2 |
  | 3 | demanding_mountain_hiking | T3 |
  | 4 | alpine_hiking | T4 |
  | 5 | demanding_alpine_hiking | T5 |
  | 6 | difficult_alpine_hiking | T6 |

  — [pedestriancost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/pedestriancost.cc); [GraphHopper custom-models doc](https://github.com/graphhopper/graphhopper/blob/master/docs/core/custom-models.md)
- An edge is disallowed when its `sac_scale` exceeds `max_hiking_difficulty`. For `type` "wheelchair" or "blind", `max_hiking_difficulty` is forced to 0, so no sac_scale-tagged trail can be used. — [pedestriancost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/pedestriancost.cc)
- **sac_scale changes both time and cost.**
  - Time multipliers: T1 ×1.11, T2 ×1.25, T3 ×1.54, T4 ×2.5, T5 ×4.0, T6 ×6.67.
  - Cost additions on top of a base of 1.0: T1 +0.25, T2 +0.75, T3 +1.25, T4 +2.0, T5 +2.5, T6 +3.0.
  - Untagged edges (0) get ×1.0 and +0.
  — [pedestriancost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/pedestriancost.cc)
- **Elevation affects pedestrian time, not just cost.** Edge time is length × (3.6 / walking_speed) × sac-scale speed factor × `kGradeBasedSpeedFactor[weighted_grade]`. The code comments cite DIN 33466 and a modified Tobler function. The grade factors include:

  | Grade | Factor |
  |---|---|
  | −10% | 1.33 |
  | −3% | 0.88 (faster than flat) |
  | 0% | 1.0 |
  | +5% | 1.33 |
  | +8% | 1.57 |
  | +10% | 1.83 |
  | +15% (top bucket) | 2.50 |

  — [pedestriancost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/pedestriancost.cc)
- `use_hills` only adds a cost penalty, never time. The penalty is (1 − use_hills) × strength. Strengths include 0.3 at +5%, 0.5 at +8%, 1.0 at +11.5%, 3.0 at +13%, 5.0 at +15%, and 2.0 at −10%. — [pedestriancost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/pedestriancost.cc)
- Weighted grade is computed at tile-build time. Elevation is sampled every 60 m along an edge and combined with a weighting function. — [elevation-costing.md](https://github.com/valhalla/valhalla/blob/master/docs/docs/concepts/costing/elevation-costing.md)
- **`walkway_factor` does not touch `highway=path`.**
  - Pedestrian costing applies per-use factors only to footway (`walkway_factor`), sidewalk, alley, driveway, track, living street, and service road. — [pedestriancost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/pedestriancost.cc)
  - In the OSM import, `highway=path` becomes use 27 (`kPath`) and `highway=footway` becomes `kFootway` (25). — [lua/graph.lua](https://github.com/valhalla/valhalla/blob/master/lua/graph.lua); [graphconstants.h](https://github.com/valhalla/valhalla/blob/master/valhalla/baldr/graphconstants.h)
  - Ordinary roads get no pedestrian penalty either (factor 1). So a pedestrian route is neutral between a trail and a state highway, apart from grade and sac_scale. — [pedestriancost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/pedestriancost.cc)
- `highway=bridleway` defaults to `pedestrian_forward = false` in Valhalla's import. Horse trails tagged that way are not walkable unless foot access tags say otherwise. — [lua/graph.lua](https://github.com/valhalla/valhalla/blob/master/lua/graph.lua)
- The `max_grade` access check in pedestrian `Allowed()` is commented out in current source, so `max_grade` has no effect today. — [pedestriancost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/pedestriancost.cc)
- `shortest: true` switches the cost to distance only and ignores all penalties. Pedestrian costing sets `use_hierarchy_limits = false`, so the docs' caveat about hierarchy pruning does not bite for pedestrians. — [route API reference](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md); [pedestriancost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/pedestriancost.cc)
- `service_penalty` defaults to 0 for pedestrians. It is applied when transitioning onto a generic service road; `service_factor` (default 1) multiplies their cost. — [route API reference](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md); [pedestriancost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/pedestriancost.cc)
- `type`: "foot" is the default. "wheelchair" changes the max_distance, speed and step defaults. "blind" adds extra instructions. — [route API reference](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md)

**Location snapping defaults and what the response exposes**
- Service defaults are `radius` 0, `minimum_reachability` 50, `search_cutoff` 35,000 m, `node_snap_tolerance` 5 m, `street_side_tolerance` 5 m, `street_side_max_distance` 1,000 m, and `heading_tolerance` 60. Default service limits are `max_radius` 200 m and `max_reachability` 100. — [valhalla_build_config](https://github.com/valhalla/valhalla/blob/master/scripts/valhalla_build_config)
- On `radius`, the docs say that if no candidates fall within it, Valhalla returns the closest candidate "within reason". On `search_cutoff`, beyond it the input is treated as too far from any network to correlate (default 35 km). — [route API reference](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md)
- `side_of_street` appears in the response when a break location is offset from the street. It is the only offset hint in /route. — [route API reference](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md)
- Empirically, `trip.locations` echoes the input lat/lon, not the snapped point. The snapped point is the first or last shape vertex. `/locate` with `"verbose":true` returns `correlated_lat`/`correlated_lon` and a `distance` in metres (see section 7). — [test request V3](https://valhalla1.openstreetmap.de/route?json={"locations":[{"lat":47.84753,"lon":-112.78245},{"lat":47.81245,"lon":-112.80032}],"costing":"pedestrian","units":"kilometers"}); [test request V5](https://valhalla1.openstreetmap.de/locate?json={"locations":[{"lat":47.81245,"lon":-112.80032}],"costing":"pedestrian","verbose":true})
- A per-location `search_cutoff` of 500 m on an off-trail destination (814 m from the trail) returned HTTP 400, `error_code` 171, "No suitable edges near location". — [test request V6](https://valhalla1.openstreetmap.de/route?json={"locations":[{"lat":47.84753,"lon":-112.78245},{"lat":47.81245,"lon":-112.80032,"search_cutoff":500}],"costing":"pedestrian","units":"kilometers"})

**exclude_polygons and exclude_locations**
- `exclude_polygons` takes exterior rings as nested `[lon, lat]` arrays, or a GeoJSON FeatureCollection with optional `levels`. Roads that intersect the rings are avoided, and open rings are closed automatically. `exclude_locations` snaps points to the nearest roads and excludes those roads. — [route API reference](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md)
- Default service limits in master:
  - `max_exclude_polygons_length` 10,000 m, the total perimeter of all polygons.
  - `max_exclude_polygons_vertices` 100, the total vertices across all polygons.
  - `max_exclude_locations` 50.
  — [valhalla_build_config](https://github.com/valhalla/valhalla/blob/master/scripts/valhalla_build_config)

**/height elevation endpoint and elevation along routes**
- `/height` takes a `shape` or `encoded_polyline`. It supports `range` (cumulative distance), `resample_distance` and `height_precision` (0–2 decimals). — [elevation API docs](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/elevation.md)
- `elevation_interval` on /route returns an elevation array per leg; the docs recommend 30 m. — [route API reference](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md)
- The FOSSGIS /height endpoint was deliberately turned off in June 2026; the maintainer said it would come back "in the next few weeks". — [GitHub discussion #3373 (2026-06-19)](https://github.com/valhalla/valhalla/discussions/3373)
- On 2026-09-24 it worked: Rocky Mountain summit 2858 m, trailhead 1769 m, range 4127 m. /route with `elevation_interval: 30` also returned elevations. — [test request V7](https://valhalla1.openstreetmap.de/height?json={"range":true,"shape":[{"lat":47.81245,"lon":-112.80032},{"lat":47.84753,"lon":-112.78245}]})

**Vehicle off-road and unpaved options**
- `auto`: `use_tracks` defaults to 0 (tracks avoided). — [autocost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/autocost.cc)
- The docs give `use_tracks` defaults of 0 for autos and 0.5 for motor scooters and motorcycles, and note that tracks may still be used when needed to complete a route. — [route API reference](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md)
- `exclude_unpaved` allows unpaved roads only at the start and end of a route. — [route API reference](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md); [autocost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/autocost.cc)
- `motorcycle`: `use_trails` ranges 0–1 and defaults to 0.
  - At 0 it avoids trails, tracks, unclassified roads and bad surfaces.
  - Toward 1 it favours secondary roads and "adventure".
  - In code it drives a surface bias factor of up to 8.
  — [route API reference](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md); [motorcyclecost.cc](https://github.com/valhalla/valhalla/blob/master/src/sif/motorcyclecost.cc)
- `bicycle`: `bicycle_type: mountain` and `avoid_bad_surfaces` are also available. — [route API reference](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md)
- Hosted Valhalla profiles listed by Stadia are auto, bus, taxi, truck, bicycle, bikeshare, motor_scooter, motorcycle, low_speed_vehicle and pedestrian. There is no OHV/ATV profile. — [Stadia Standard Routing docs](https://docs.stadiamaps.com/routing/standard-routing/) (via search summary)

**FOSSGIS public server: policy, rate limits, CORS, version**
- **README.**
  - FOSSGIS hosts a public demo server with a full planet graph. The API is on valhalla1.openstreetmap.de.
  - Use follows the same fair-usage policy as the OSRM and Nominatim demo servers, "somewhat enforced" by rate limits.
  - Apps published to end users should announce themselves in GitHub Discussions and send an identifying `X-Client-Id` header.
  — [Valhalla README](https://github.com/valhalla/valhalla/blob/master/README.md)
- **Maintainer (nilsnolde) statements in discussion #3373.**
  - 2021-10-28 announcement: the server would need strict rate limiting, so it "won't be usable for any production service for third parties".
  - 2021-11-15: "1 call/user/sec and 100 calls/sec total", with service limits a bit stricter than the defaults.
  - 2026-09-05: bursts of 10 are allowed. Service limits are now "a lot stricter". It runs the full planet on a low-spec machine.
  — [GitHub discussion #3373](https://github.com/valhalla/valhalla/discussions/3373)
- In 2024–2026 several apps posted announcements in that thread with their `X-Client-Id`, for example "tripreadygo.com", "buchungsverwaltung" and "fuel-calculator-android". The maintainer asked for a proper User-Agent for "mass" deployments (2024-02-27). — [GitHub discussion #3373](https://github.com/valhalla/valhalla/discussions/3373)
- An Interline collaborator (drewda, 2026-02-25) noted that several firms sell hosted Valhalla access, including Interline. — [GitHub discussion #3373](https://github.com/valhalla/valhalla/discussions/3373)
- **CORS, tested 2026-09-24.**
  - GET responses carry `access-control-allow-origin: *`.
  - The OPTIONS preflight returned 204 with allow-headers `Content-Type, X-Client-Id`, allow-methods `GET, POST, OPTIONS`, and max-age 86400.
  — [test C1 preflight](https://valhalla1.openstreetmap.de/route)
- `/status` reported version `3.9.0-e8b4007` and `tileset_last_modified` 1790259111 (2026-09-24 14:11 UTC). `height` is among the available actions. No service limits were exposed. — [test V0](https://valhalla1.openstreetmap.de/status)
- Valhalla 3.9.0 was released 2026-09-19. — [valhalla releases](https://github.com/valhalla/valhalla/releases)

### Inferences
- Valhalla's pedestrian model optimises walking time, adjusted for grade and sac_scale. Where a flatter road parallels a hilly trail, it will pick the road. The Sawtooth test showed exactly this (section 7), and none of `max_hiking_difficulty: 6`, `use_tracks: 1` or `use_hills: 1` changed the route.
- The only request-level control likely to push Valhalla onto that trail is `shortest: true`, because the trail was 1.1 km shorter. This was not tested.
- For most US trails, `max_hiking_difficulty` matters only where local mappers added `sac_scale`. Neither test area had any. Where T2+ tags exist, the default of 1 silently refuses them.
- For fit crews carrying tools, 3 (T3) is a defensible cap. It matches BRouter hiking-mountain's default `SAC_scale_limit` of 3. A value of 6 would allow alpine T4–T6 terrain; that is an inference, not tested.
- Valhalla's default exclude-polygon limits (10 km total perimeter, 100 vertices) fit only small areas, roughly a 2.5 km square. Real fire perimeters (tens of km of perimeter, thousands of vertices) would need heavy simplification, such as a convex hull or a buffered simplified polygon, or would be rejected. The FOSSGIS limits are stricter than the defaults but unpublished.
- Sending `X-Client-Id` from the browser is CORS-safe, because the preflight allows it. It turns each GET into a preflighted request, but the preflight is cached for 24 h.

### Gaps
- The FOSSGIS server's actual service limits are not published: exclude_polygons perimeter and vertex caps, pedestrian `max_distance`, `max_radius`. /status did not expose them, and I did not probe them to keep request volume low.
- No explicit FOSSGIS statement for 2025–2026 on whether a public production web app is acceptable if it announces itself. The 2021 statement says it is not for third-party production. The 2026 thread shows apps announcing and being tolerated, but I found no explicit approval.
- The German FOSSGIS news post and full policy referenced by the maintainers were not read.
- `shortest: true` behaviour on the Sawtooth pair was not tested.

---

## 2. openrouteservice (ORS) foot-hiking

### Takeaway
ORS says outright that an API key must not be used client-side. That rules out the current `VITE_ORS_KEY` design for a static app, unless each user brings their own key.

Other public-API limits relevant here:
- Snapping is capped at 350 m, so the off-trail summit in the tests would fail.
- `avoid_polygons` is capped at 200 km² area and 20 km extent, with routes up to 150 km when avoiding areas.
- The free Standard plan allows about 2,000 directions requests per day and 40 per minute.

CORS preflight works.

### Cited Findings
- The ORS FAQ says an API key must not be used client-side, because inspecting the app's requests would leak it. It recommends either server-side requests or users supplying their own keys. — [ORS FAQ](https://giscience.github.io/openrouteservice/frequently-asked-questions.html)
- **Snapping.** The public API's maximum distance for snapping to road segments is 350 m. Local installs can change it via `maximum_snapping_radius`. — [ORS FAQ](https://giscience.github.io/openrouteservice/frequently-asked-questions.html)
- The open-source config sample defaults `maximum_snapping_radius` to 400. — [ors-config.yml](https://github.com/GIScience/openrouteservice/blob/main/ors-config.yml)
- **Quotas.** The minute limit is a sliding window: any 60 s may contain at most 40 directions requests. The daily limit resets 24 h after the first request. — [ORS FAQ](https://giscience.github.io/openrouteservice/frequently-asked-questions.html)
- The 2,000 directions per day figure for the Standard plan comes from the search snippet for the same FAQ and plans pages. The official plans page (openrouteservice.org/plans, which now redirects to account.heigit.org/info/plans) is JavaScript-rendered and could not be read. — [ORS FAQ](https://giscience.github.io/openrouteservice/frequently-asked-questions.html); [HeiGIT plans (unreadable)](https://account.heigit.org/info/plans)
- **Public API restrictions page.**

  | Limit | Value |
  |---|---|
  | Waypoints | 50 |
  | foot-hiking maximum distance | 6,000 km |
  | Distance with avoid areas | 150 km |
  | Alternative or round-trip distance | 100 km |
  | Avoid-polygon area | 200 km² |
  | Avoid-polygon extent (height or width) | 20 km |
  | Alternative routes | 3 |
  | Elevation endpoint vertices | 2,000 |
  | Isochrones, foot | up to 20 h |

  — [ORS API Restrictions](https://openrouteservice.org/restrictions/)
- The open-source config sample has `maximum_avoid_polygon_area: 200000000` (m²), `maximum_avoid_polygon_extent: 20000` and `maximum_distance_avoid_areas: 100000`. The last differs from the public page's 150 km. — [ors-config.yml](https://github.com/GIScience/openrouteservice/blob/main/ors-config.yml)
- `options.avoid_polygons` takes a GeoJSON Polygon or MultiPolygon. Foot profiles also have "green" and "quiet" weightings (0 or 1). — [ORS routing options](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/routing-options)
- The directions docs have extra-info sections for Steepness, Surface, Category, Type, Difficulty and Restriction IDs. — [ORS directions endpoint docs](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/)
- `traildifficulty` maps sac_scale hiking→1 up to difficult_alpine_hiking→6 for foot profiles. For bikes it maps mtb:scale 0–6 to 1–7. — [ORS trail difficulty](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/extra-info/trail-difficulty)
- OSM edits take about 2–3 weeks to reach the ORS public service. — [ORS FAQ](https://giscience.github.io/openrouteservice/frequently-asked-questions.html)
- **CORS, tested 2026-09-24.** An OPTIONS preflight to `/v2/directions/foot-hiking/geojson` returned 204. It carried `access-control-allow-origin: *`, allow-headers including `Authorization` and `Content-Type`, and max-age 1,728,000. — [test C2](https://api.openrouteservice.org/v2/directions/foot-hiking/geojson)
- The latest ORS release is v10.0.1, dated 2026-09-24. — [ORS releases](https://github.com/GIScience/openrouteservice/releases)

### Inferences
- In production today (key not set), the ORS branch never runs. Setting `VITE_ORS_KEY` would bake the key into a public JS bundle, which contradicts the ORS FAQ.
- For off-trail destinations more than 350 m from a way, ORS errors instead of snapping far. The ORS message is "Could not find routable point within a radius of 350.0 meters". That is safer than silent snapping, but the app would need its own fallback, such as a straight segment.
- The 200 km² and 20 km avoid-polygon caps fit many initial-attack fires but not large campaign fires.

### Gaps
- How the foot-hiking profile weights trails versus roads, and which sac_scale values it allows, was not found in the pages read.
- The exact text of the `radiuses` parameter (default, and the meaning of −1 on the public API) was not retrieved. The FAQ's 350 m cap is the only figure.
- The `elevation` parameter details (ascent and descent in the summary) were not retrieved this session.
- The official 2026 plans page is JavaScript-only. The 2,000 per day figure comes from a search snippet, not from the plans page itself.

---

## 3. BRouter (brouter.de)

### Takeaway
BRouter's `hiking-mountain` profile is the only keyless engine tested that walked the actual trail between the two Sawtooth trailheads. It has sac_scale-aware penalties and a hard cap at T3 by default. Elevation cost is optional via `consider_elevation`.

For off-network points it silently snaps (a first pass within 250 m, then a dynamic second pass up to 60 km). With `profile:add_beeline=1` it instead appends a straight segment to the exact off-trail point.

It supports circle, polyline and polygon no-go areas. The public server is CORS-open. However, no usage policy exists for third-party API use of brouter.de; it is primarily the backend for brouter-web.

### Cited Findings
- **Request format that was tested.** `https://brouter.de/brouter?lonlats=lon,lat|lon,lat&profile=hiking-mountain&alternativeidx=0&format=geojson` returned GeoJSON (`application/vnd.geo+json`) with `access-control-allow-origin: *`. — [test B1](https://brouter.de/brouter?lonlats=-115.01402,44.1987|-115.06576,44.24711&profile=hiking-mountain&alternativeidx=0&format=geojson)
- **Server parameters in source.**
  - `lonlats` (required), `profile`, `nogos`, `polylines`, `polygons`, `straight`, `pois`, `heading`, `direction`, `alternativeidx`, `timode`, `exportWaypoints`, `format`.
  - `profile:<var>` overrides a profile variable.
  - `straight` takes waypoint indices and marks the segment *after* each listed waypoint as a beeline, skipping routing.
  — [RoutingParamCollector.java](https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/RoutingParamCollector.java); [RoutingEngine.java](https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/RoutingEngine.java)
- **Off-network matching.**
  - `waypointCatchingRange` defaults to 250 m, and `use_dynamic_range` defaults to 1.
  - If a waypoint is not matched, a second pass searches up to `MAX_DYNAMIC_RANGE` = 60,000 m.
  - If still unmatched, it throws "<name>-position not mapped in existing datafile".
  - With `add_beeline` = 1, a matched point farther than the catching range gets a beeline segment from the input point to the network.
  — [RoutingContext.java](https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/RoutingContext.java); [RoutingEngine.java](https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/RoutingEngine.java)
- **hiking-mountain.brf defaults.**
  - `SAC_scale_limit` 3: paths above T3 are forbidden.
  - `SAC_scale_preferred` 1: levels below are slightly penalised, levels above strongly.
  - `consider_elevation` false: uphill and downhill costs apply only when it is true.
  - `add_beeline` false; `turnInstructionCatchingRange` 20.
  — [hiking-mountain.brf](https://github.com/abrensch/brouter/blob/master/misc/profiles2/hiking-mountain.brf)
- BRouter elevation comes from hole-filled SRTM v4.1 (CGIAR), or Lidar above 60°N. It reports a noise-filtered ascent. — [BRouter elevation docs](https://github.com/abrensch/brouter/blob/master/docs/features/elevation.md)
- **Self-hosted HTTP server.**
  - `/brouter` accepts GET. POST and PUT bodies (for large `nogos`/`polylines`/`polygons`) work only if the server starts with `-DusePOSTRequests=true`, which is off by default.
  - Body size is capped by `maxRequestLength` (default 1,000,000 bytes).
  - The sample start options use a 128 MB Java heap (`-Xmx128M`).
  — [BRouter http_server.md](https://github.com/abrensch/brouter/blob/master/docs/developers/http_server.md)
- Nogo areas cover obstacles missing from the map, and brouter-web can edit them. The format examples in http_server.md show `polygons=lon,lat,lon,lat,...`. — [BRouter vianogo.md](https://github.com/abrensch/brouter/blob/master/docs/features/vianogo.md); [http_server.md](https://github.com/abrensch/brouter/blob/master/docs/developers/http_server.md)
- **Data and version.** Planet segment files are regenerated weekly and downloadable from brouter.de/brouter/segments4. — [BRouter README](https://github.com/abrensch/brouter/blob/master/README.md). The latest release is v1.7.10 (2026-07-17). — [brouter releases](https://github.com/abrensch/brouter/releases)
- **Server policy.**
  - The BRouter README points to the self-hosted HTTP server and to brouter.de/brouter-web as "an online instance".
  - The brouter-web README credits brouter.de/brouter-web to @abrensch.
  - Neither states a usage policy for third-party API calls to brouter.de.
  - A search summary claimed "there is no public API service provided by brouter.de", but I could not find that sentence in the current README.
  — [BRouter README](https://github.com/abrensch/brouter/blob/master/README.md); [brouter-web README](https://github.com/nrenner/brouter-web/blob/master/README.md)

### Inferences
- BRouter's behaviour fits a wildland crew planner best: it seeks trails, has an SAC cap, and can end at the exact off-trail point with a straight segment. The beeline segment's elevation and time are not realistic, though. In the test, the beeline end reported the snapped point's elevation (2313.5 m) instead of the summit's (~2858 m).
- Relying on brouter.de from a production PWA is unsanctioned. The owner should ask the maintainer (abrensch) before shipping. Otherwise this becomes the one case where self-hosting is worth arguing: a Java server with a 128 MB heap and US rd5 segment files.
- Large fire polygons over GET will hit URL-length limits (typically about 8 KB on nginx, not verified). They need simplification. POST support on brouter.de is unknown.

### Gaps
- No published rate limits, terms or attribution requirements for brouter.de. I could not confirm whether brouter.de enables POST.
- Exact nogo parameter syntax and weights (soft versus hard avoidance) were seen only as parameter names in code. The full format spec was not read.
- Whether `total-time` for foot profiles uses a walking model or a bike-derived physics model was not verified. R1 gave 11,621 s for 14.0 km with 459 m of climbing.

---

## 4. GraphHopper Directions API

### Takeaway
The Free plan is non-commercial only (500 credits per day, 5 locations). It is limited to the car, bike and foot profiles, so no `hike`. It excludes "flexible mode" (`ch.disable=true`), which per-request custom models need. That means no avoid-areas and no trail priority on Free.

Custom models are otherwise the most expressive avoidance and preference tool of any engine here: `hike_rating` (sac_scale), `track_type`, `surface`, `road_class`, `average_slope`/`max_slope`, and GeoJSON `areas`.

CORS preflight works. The key travels as a URL parameter, so it is visible in the browser.

### Cited Findings
- **Plans.**

  | Plan | Price per month | Credits per day | Max locations |
  |---|---|---|---|
  | Free | €0 | 500 | 5 |
  | Basic | €69 | 5,000 | 30 |
  | Standard | €199 | 15,000 | 80 |
  | Premium | €479 | 50,000 | 200 |

  - "The Free Plan is for non-commercial use only." It has a limited credit count per minute, limited profiles, and no flexible mode (`ch.disable=true`).
  - Paid plans need no attribution; attributing earns a 20% discount.
  - OSM data is updated at least weekly.
  — [GraphHopper pricing](https://www.graphhopper.com/pricing/)
- The API error text quoted on the GraphHopper forum restricts free accounts to [car, bike, foot]. — [GraphHopper forum](https://discuss.graphhopper.com/t/message-for-your-account-the-profile-parameter-can-only-be-one-of-car-bike-foot-but-was-small-truck/9468)
- Per-request custom models can modify any profile, for example to avoid areas. — [GraphHopper customized routing profiles](https://docs.graphhopper.com/openapi/map-data-and-routing-profiles/openstreetmap/customized-routing-profiles)
- **Custom-model encoded values.**
  - `road_class` (includes TRACK, FOOTWAY), `surface`, `track_type` (GRADE1–5).
  - `hike_rating` (sac_scale 0–6), `mtb_rating`, `horse_rating`.
  - `average_slope` and `max_slope`, which flip sign in reverse.
  - `areas` given as a GeoJSON FeatureCollection of Polygon features, referenced as `in_<id>`, can block an area by multiplying speed or priority by 0.
  - Edge weight = distance / (speed × priority) + distance × `distance_influence` + turn penalty.
  — [GraphHopper custom-models.md](https://github.com/graphhopper/graphhopper/blob/master/docs/core/custom-models.md)
- **CORS, tested 2026-09-24.** An OPTIONS preflight to `https://graphhopper.com/api/1/route` returned 200 with `access-control-allow-origin: *` and allow-headers including `Content-Type`. `Authorization` is not listed, because the key goes in the query string. — [test C3](https://graphhopper.com/api/1/route)
- The latest open-source release is 11.0 (2025-10-14). — [graphhopper releases](https://github.com/graphhopper/graphhopper/releases)

### Inferences
- The Free plan can't do trail-aware hiking or fire avoidance: foot only, no custom models. It is also non-commercial only. Whether incibrief.com counts as commercial is for the owner to judge.
- A paid plan (from €69/month) with the `hike` profile, a custom model and `areas` would be the richest hosted option for "avoid the fire perimeter". The key would still be exposed in the browser.

### Gaps
- Credit cost per route request, the default or maximum snapping distance, and the error behaviour for far off-network points were not documented on the pages read.
- Limits on area polygon size and complexity in custom models were not found.
- How the `hike` profile differs from `foot` on the hosted API was not retrieved; the docs pages are JavaScript-rendered.

---

## 5. OSRM foot on routing.openstreetmap.de (FOSSGIS)

### Takeaway
The FOSSGIS OSRM foot server is keyless, CORS-open and fast. It reports the snap distance explicitly (`waypoints[].distance`).

Its profile has no elevation handling. It prefers paths and footways only mildly (rate 1.2 versus 1.0 on residential roads). It treats any trail tagged sac_scale ≥ mountain_hiking (T2) as not routable, and sac_scale=hiking as slow (3.5 km/h, rate 0.5).

The usage policy is 1 request per second, no heavy use, a valid User-Agent/Referer, and attribution with a "fix the map" link.

### Cited Findings
- **Policy.** At most one request per second; no scraping and no heavy use; a valid user agent and, if applicable, a correct referrer; display attribution and a "fix the map" link. There are car, bike and foot profiles worldwide, and data updates roughly every two days. The full policy is on the FOSSGIS site in German. — [FOSSGIS routing about page](https://routing.openstreetmap.de/about.html)
- **foot.lua** (commit 2025-07-27 syncs with osrm-backend):
  - Default speed 4.5 km/h.
  - Rates: footway and path 1.2, track 1.1, residential and unclassified 1.0, tertiary 0.9, secondary 0.8, primary 0.7.
  - Surfaces: dirt, grass and mud 3.5 km/h (rate 0.5); gravel 3.5 (rate 0.7); ground and unpaved 4.5 (rate 0.8).
  - sac_scale: hiking gets rate 0.5 at 3.5 km/h. mountain_hiking through difficult_alpine_hiking get {0,0}.
  — [cbf-routing-profiles foot.lua](https://github.com/fossgis-routing-server/cbf-routing-profiles/blob/master/foot.lua)
- The commit on 2025-04-27 is titled "convert 0 speed to not routable". — [cbf-routing-profiles commits](https://github.com/fossgis-routing-server/cbf-routing-profiles/commits/master)
- foot.lua has no elevation, slope or height handling. The only grep matches are the tracktype "grade1–5" entries. — [foot.lua](https://github.com/fossgis-routing-server/cbf-routing-profiles/blob/master/foot.lua)
- **CORS, tested 2026-09-24.** The response carried `access-control-allow-origin: *`, `access-control-allow-methods: GET`, and `access-control-allow-headers: X-Requested-With, Content-Type`. A custom `X-Client-Id` header would not pass a preflight here. — [test O1](https://routing.openstreetmap.de/routed-foot/route/v1/foot/-115.01402,44.1987;-115.06576,44.24711?overview=full&geometries=geojson&steps=true)
- **Off-network behaviour, tested.** The route ended on the nearest trail, and `waypoints[1].distance` = 815 m reported the snap distance explicitly. — [test O2](https://routing.openstreetmap.de/routed-foot/route/v1/foot/-112.78245,47.84753;-112.80032,47.81245?overview=full&geometries=geojson&steps=true)

### Inferences
- OSRM foot is a reasonable keyless fallback, and its explicit snap distance is the easiest of any engine to surface in the UI. It is not trail-seeking (in the Sawtooth test it used roads) and not grade-aware.
- It hard-excludes T2+ trails. Where US mappers tag sac_scale, that could send crews on long detours or return no route.

### Gaps
- The OSRM `radiuses` default (unlimited) and the lack of polygon avoidance in OSRM's HTTP API were not re-verified this session. The code and profile read show no polygon-avoid feature.

---

## 6. Brief: Stadia Maps (hosted Valhalla), Mapbox Directions walking, Esri Walking Time, TomTom pedestrian

### Takeaway
- **Stadia** is the cleanest paid path to hosted Valhalla from a static site. Domain-based auth means no key in the bundle. The Free plan is non-commercial; Starter at $20/month allows commercial use; a route costs 20 credits.
- **Mapbox walking** claims to use "sidewalks and trails". It allows 25 coordinates and point exclusions only (no polygons), about 100k free requests per month, and use on non-Mapbox maps with attribution.
- **Esri Walking Time** and **TomTom pedestrian** don't document trail coverage. TomTom's avoidance is limited to 10 rectangles.

### Cited Findings
- **Stadia pricing.**

  | Plan | Price per month | Credits per month | Overage |
  |---|---|---|---|
  | Free | $0 | 200,000 | no overage; non-commercial |
  | Starter | $20 | 1,000,000 | $0.03 per 1,000 |
  | Standard | $80 | 7,500,000 | $0.02 per 1,000 |
  | Professional | $250 | 25,000,000 | $0.015 per 1,000 |

  A standard routing request is 20 credits; traffic-aware profiles cost more. — [Stadia pricing](https://stadiamaps.com/pricing/)
- **Stadia routing.** The endpoint is `https://api.stadiamaps.com/route/v1` (EU: api-eu). Routes are limited to 50 locations, and pedestrian routes to 250 km of straight-line distance across all locations. Domain-based auth is the browser option; an API key is needed only when domain auth can't be used. — [Stadia Standard Routing](https://docs.stadiamaps.com/routing/standard-routing/)
- Domain-based auth validates the `Origin` and `Referer` headers. A `no-referrer` Referrer-Policy breaks it, and localhost needs no key. — [Stadia authentication docs](https://docs.stadiamaps.com/authentication/)
- Stadia's guide covers `exclude_polygons` (rings; roads intersecting them are excluded) and `exclude_locations`, and recommends `elevation_interval` of about 30 m. It gives no polygon size limits and does not list `max_hiking_difficulty`. — [Stadia "Getting the Best Routes" guide](https://docs.stadiamaps.com/guides/getting-the-best-routes-with-valhalla-turn-by-turn-directions-apis/)
- **CORS, tested 2026-09-24.** The OPTIONS preflight to /route/v1 returned 204 with `access-control-allow-origin: *` and allow-headers `Stadia-Auth,Content-Type`. — [test C4](https://api.stadiamaps.com/route/v1)
- **Mapbox walking** is for pedestrian and hiking routing and says it uses sidewalks and trails.
  - Up to 25 coordinates.
  - `exclude` accepts up to 50 WKT points, snapped to roads; no polygons.
  - `radiuses` accepts a number or `unlimited`; a NoSegment error is returned when no road is within the radius.
  - The response's waypoint `distance` is the straight-line distance from the input to the snapped point.
  — [Mapbox Directions API docs](https://docs.mapbox.com/api/navigation/directions/)
- Mapbox services may be used on a non-Mapbox map if they are attributed prominently on or next to it. — [Mapbox attribution help](https://docs.mapbox.com/help/dive-deeper/attribution/)
- Mapbox Directions includes 100,000 free requests per month, then $2.00 per 1,000. These figures come from secondary sources; mapbox.com/pricing was not read. — [storerocket.io](https://storerocket.io/learn/mapbox-pricing); [apicostcalc.com](https://apicostcalc.com/mapbox.html)
- **Esri Walking Time** travels on paths and roads that allow pedestrians, avoids roads that prohibit them such as highways, and assumes 5 km/h. Trails and the data source are not mentioned. — [Esri travel modes](https://doc.arcgis.com/en/arcgis-online/analyze/travel-modes-analysis-mv.htm)
- The ArcGIS Location Platform free tier includes 20K basic routes per month, then $0.50 per 1,000. — [ArcGIS Location Platform pricing](https://location.arcgis.com/pricing/)
- **TomTom pedestrian.** Pedestrian is not among the beta travel modes (bus, motorcycle, taxi and van are). `avoidAreas` is at most 10 rectangles, each up to about 160 × 160 km. — [TomTom common routing parameters](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/common-routing-parameters)
- TomTom's pricing page lists "Routing API: 20K monthly" free with no credit card. — [TomTom pricing](https://docs.tomtom.com/pricing). An aggregator instead cites 2,500 free non-tile requests per day. — [apio.sh](https://apio.sh/apis/tomtom-routing). These conflict, and the official page is newer.

### Inferences
- Stadia behaves like FOSSGIS Valhalla on routing, including trail neutrality and silent snapping, but adds commercial terms and domain auth. It fixes the policy problems but not the trail-preference problem.
- Mapbox walking is the only large commercial API claiming trails. Its trail coverage in US wilderness is untested, and it can't avoid polygons.
- Esri and TomTom are unlikely to have backcountry trail coverage because they document none. They are not suitable for Walk in wilderness.

### Gaps
- Whether Stadia passes through the full set of Valhalla pedestrian `costing_options` (for example `max_hiking_difficulty`), and its exclude_polygons limits, are not documented on the pages read.
- Mapbox walking's data source and US trail coverage, and Esri or TomTom trail coverage, are all undocumented. No keyless test was possible.
- Whether Esri polygon barriers exist and what their limits are was not checked.

---

## 7. Empirical check (2026-09-24): identical routes through FOSSGIS Valhalla, BRouter hiking-mountain and FOSSGIS OSRM foot

### Takeaway
**R1 (Iron Creek TH to Stanley Lake TH).** Only BRouter used the connecting trail: 14.05 km, 99% on `highway=path`.

Valhalla (default, `{max_hiking_difficulty:6, use_tracks:1}`, and `{use_hills:1, max_hiking_difficulty:6}`) and OSRM all routed about 15.0–15.2 km on FS 619, ID-21 and Stanley Lake Road. The trail was in Valhalla's graph and allowed: trace_attributes matched all 14.04 km, sac_scale 0 throughout. Valhalla's grade model (+5 to +6.7% weighted grade on the trail edges) made it slower.

**R2 (trailhead to Rocky Mountain summit, 814 m off-trail).** All three engines silently ended about 813 m short on Headquarters Creek Trail #165:
- Valhalla gave no gap field; `/locate` returned `distance: 814`, and a 500 m `search_cutoff` produced error 171.
- OSRM reported `waypoints[1].distance: 815`.
- BRouter, with `profile:add_beeline=1`, drew the extra 814 m straight line to the summit.

### Cited Findings
**R1 results** (straight-line 6.78 km):

| Engine and options | Distance | Time | Trail used? | Route composition |
|---|---|---|---|---|
| Valhalla pedestrian, default (current app request) | 15.154 km | 10,969 s (3.05 h) | No | 0.03 km Iron Creek-Stanley Lake Trail/640, 0.18 km unnamed, 5.04 km FS 619, 3.95 km "ID 21 South", 5.95 km Stanley Lake Road |
| Valhalla `{max_hiking_difficulty:6, use_tracks:1}` + `elevation_interval:30` | 15.185 km | 10,988 s | No | Same roads; elevation 1921.5–2049.7 m, 508 samples |
| Valhalla `{use_hills:1, max_hiking_difficulty:6}` | 15.154 km | 10,969 s | No | Identical to default |
| BRouter hiking-mountain | 14,045 m | 11,621 s (3.23 h) | Yes | 13,938 m `highway=path` + 106 m footway; no sac_scale tags; filtered ascent 459 m |
| OSRM foot (FOSSGIS) | 14,996 m | 11,978 s (3.33 h) | No | 5,037 m FS 619, 5,843 m Stanley Lake Road, 4,068 m unnamed (likely ID-21; OSRM step names omit refs), 47 m trail |

Snap gaps were 0 m for every engine on R1.

Sources: [V1](https://valhalla1.openstreetmap.de/route?json={"locations":[{"lat":44.1987,"lon":-115.01402},{"lat":44.24711,"lon":-115.06576}],"costing":"pedestrian","units":"kilometers"}); [V2](https://valhalla1.openstreetmap.de/route?json={"locations":[{"lat":44.1987,"lon":-115.01402},{"lat":44.24711,"lon":-115.06576}],"costing":"pedestrian","units":"kilometers","costing_options":{"pedestrian":{"max_hiking_difficulty":6,"use_tracks":1}},"elevation_interval":30}); [V8](https://valhalla1.openstreetmap.de/route?json={"locations":[{"lat":44.1987,"lon":-115.01402},{"lat":44.24711,"lon":-115.06576}],"costing":"pedestrian","units":"kilometers","costing_options":{"pedestrian":{"use_hills":1,"max_hiking_difficulty":6}}}); [B1](https://brouter.de/brouter?lonlats=-115.01402,44.1987|-115.06576,44.24711&profile=hiking-mountain&alternativeidx=0&format=geojson); [O1](https://routing.openstreetmap.de/routed-foot/route/v1/foot/-115.01402,44.1987;-115.06576,44.24711?overview=full&geometries=geojson&steps=true)

**Valhalla trace_attributes on BRouter's R1 trail line** (POST, pedestrian, `shape_match: map_snap`, `max_hiking_difficulty: 6`; about 220 points):
- Matched 14.04 km over 13 edges: 10 `path` and 3 `footway`. `sac_scale` was 0 on every edge.
- 2.88 km of Iron Creek–Stanley Lake Trail (ways 609787427, 1545174493, 314733940) at weighted grade +5.0%, max up 11–13%.
- 8.31 km of Alpine Way Trail #528 (way 231733491) at weighted grade +6.67%, max up 32%, max down −28%.
- 0% on the remaining ~2.9 km.

— [test V9](https://valhalla1.openstreetmap.de/trace_attributes)

**R2 results** (straight-line 4.12 km; the summit is 814 m from the nearest trail):

| Engine and options | Distance | Time | Snap behaviour |
|---|---|---|---|
| Valhalla default (current app request) | 6.167 km | 5,990 s (1.66 h, 3.71 km/h) | All on Headquarters Creek Trail/165. Ends at 47.816274, -112.809602, 813 m from the summit. `trip.locations` echoes the input coordinates plus `side_of_street: "left"`. Last maneuver: "Your destination is on the left." No warnings. |
| Valhalla `{max_hiking_difficulty:6, use_tracks:1}` + elevation | 6.167 km | 5,990 s | Identical route; elevation 1768.5→2310.3 m (max 2365.4 m) |
| Valhalla `/locate` (verbose) on the summit | – | – | Snap to way 891388425 "Headquarters Creek Trail/165" at 47.816274, -112.809602, `distance: 814.0`, reach 100 |
| Valhalla with destination `search_cutoff: 500` | – | – | HTTP 400, error_code 171 "No suitable edges near location" |
| Valhalla `/height` | – | – | Summit 2858 m, trailhead 1769 m |
| BRouter hiking-mountain | 6,162 m | 6,179 s | All `highway=footway`, filtered ascent 575 m; ends 813 m short; no error or flag |
| BRouter + `&profile:add_beeline=1` | 6,976 m | 7,551 s | Ends exactly at the summit (gap 0). The extra 814 m segment has no way tags. Final elevation shown is 2313.5 m, the snapped point's, not the summit's. |
| OSRM foot | 6,166 m | 6,342 s (3.5 km/h) | `waypoints[1].distance` = 815 m; ends 813 m short |

Sources: [V3](https://valhalla1.openstreetmap.de/route?json={"locations":[{"lat":47.84753,"lon":-112.78245},{"lat":47.81245,"lon":-112.80032}],"costing":"pedestrian","units":"kilometers"}); [V4](https://valhalla1.openstreetmap.de/route?json={"locations":[{"lat":47.84753,"lon":-112.78245},{"lat":47.81245,"lon":-112.80032}],"costing":"pedestrian","units":"kilometers","costing_options":{"pedestrian":{"max_hiking_difficulty":6,"use_tracks":1}},"elevation_interval":30}); [V5](https://valhalla1.openstreetmap.de/locate?json={"locations":[{"lat":47.81245,"lon":-112.80032}],"costing":"pedestrian","verbose":true}); [V6](https://valhalla1.openstreetmap.de/route?json={"locations":[{"lat":47.84753,"lon":-112.78245},{"lat":47.81245,"lon":-112.80032,"search_cutoff":500}],"costing":"pedestrian","units":"kilometers"}); [V7](https://valhalla1.openstreetmap.de/height?json={"range":true,"shape":[{"lat":47.81245,"lon":-112.80032},{"lat":47.84753,"lon":-112.78245}]}); [B2](https://brouter.de/brouter?lonlats=-112.78245,47.84753|-112.80032,47.81245&profile=hiking-mountain&alternativeidx=0&format=geojson); [B3](https://brouter.de/brouter?lonlats=-112.78245,47.84753|-112.80032,47.81245&profile=hiking-mountain&alternativeidx=0&format=geojson&profile:add_beeline=1); [O2](https://routing.openstreetmap.de/routed-foot/route/v1/foot/-112.78245,47.84753;-112.80032,47.81245?overview=full&geometries=geojson&steps=true)

**CORS summary** (all tests 2026-09-24 with `Origin: https://incibrief.com`):
- valhalla1.openstreetmap.de: ACAO `*`; preflight allows `Content-Type, X-Client-Id`.
- brouter.de: ACAO `*`.
- routing.openstreetmap.de: ACAO `*`; allows GET with `X-Requested-With, Content-Type`.
- ORS: preflight allows `Authorization`.
- GraphHopper: preflight OK.
- Stadia: preflight allows `Stadia-Auth, Content-Type`.

— see tests C1–C4 and the GET responses above.

Response times were all under 0.5 s.

### Inferences
- Applying Valhalla's own tables to the trace_attributes grades gives a trail time of roughly 13,100 s. That is about 20% slower than its road route (10,969 s), which explains the choice.
  - Working: 2.88 km at ×1.33 + 8.31 km at ×1.43 + about 2.85 km at ×1.0, all at 5.1 km/h.
  - This is my arithmetic, not a Valhalla output.
- A single 8.3 km edge carries one weighted grade (+6.67%) even though it both climbs and descends steeply (+32% / −28%). Long, undulating wilderness trail edges may be systematically penalised against flat valley roads. Only one direction was checked.
- Valhalla's road choice is not absurd on time. A Naismith-style estimate makes the 460 m-climb trail slightly slower. The real issue is that the UI can't express "prefer the trail", and Valhalla sent walkers along 3.95 km of a state highway.
- `max_hiking_difficulty` had no effect in either area because neither had sac_scale tags. The option matters only where US mappers have added them.

### Gaps
- Overpass was unavailable (504 and timeouts), so I could not measure how common `sac_scale` is on US trails, or find a test trail tagged T2+ to demonstrate `max_hiking_difficulty` blocking.
- `shortest: true`, ORS, GraphHopper, Stadia and Mapbox were not run: some are keyed, and I kept request volume low.
- Only one direction of R1 was traced, so reverse weighted grades are unknown.

---

## 8. What the current Walk request (frontend/src/api/routing.ts) actually does on backcountry trails

### Takeaway
In production (`VITE_ORS_KEY` unset), Walk sends a bare FOSSGIS Valhalla pedestrian GET request: no `costing_options`, no `X-Client-Id`, and no snap or gap handling.

In practice this means:
- It uses Valhalla's T1 sac_scale cap and has no trail preference. In the Sawtooth test it walked roads, including a state highway, instead of the connecting trail.
- It silently ends routes up to 35 km from off-network destinations. The 814 m case in the tests showed no warning, and the displayed distance and time excluded the cross-country leg.
- It does not follow the FOSSGIS request that published apps send `X-Client-Id` and announce themselves.

### Cited Findings
- The current request is `{locations:[{lat,lon},{lat,lon}], costing:'pedestrian', units:'kilometers'}`, sent as a GET to `valhalla1.openstreetmap.de/route?json=...`. Results are mapped to distance in metres (length × 1000), `time` becomes `durationS`, and maneuvers become steps. There is no custom header and no check of snap distance. — `frontend/src/api/routing.ts` (lines 211–240, read 2026-09-24)
- The ORS branch posts `{coordinates:[a,b]}` to foot-hiking with the key in the `authorization` header, and is only used when `VITE_ORS_KEY` is set. — `frontend/src/api/routing.ts` (lines 157–182, 264–271)
- The same request as the app (test V1) produced the 15.15 km road route on R1, and a route ending 813 m short on R2 with only "Your destination is on the left". — [V1](https://valhalla1.openstreetmap.de/route?json={"locations":[{"lat":44.1987,"lon":-115.01402},{"lat":44.24711,"lon":-115.06576}],"costing":"pedestrian","units":"kilometers"}); [V3](https://valhalla1.openstreetmap.de/route?json={"locations":[{"lat":47.84753,"lon":-112.78245},{"lat":47.81245,"lon":-112.80032}],"costing":"pedestrian","units":"kilometers"})
- Default snapping allows candidates up to `search_cutoff` 35 km away. — [valhalla_build_config](https://github.com/valhalla/valhalla/blob/master/scripts/valhalla_build_config)
- Published apps are asked to send `X-Client-Id` and announce themselves. — [Valhalla README](https://github.com/valhalla/valhalla/blob/master/README.md)

### Inferences
Low-risk changes that stay within the current engine:
- Add `costing_options.pedestrian` with `max_hiking_difficulty` 3 (or 6 if crews accept alpine terrain) and `use_tracks` about 0.5–1.
- Add a per-location `search_cutoff` of a few km so absurd snaps become explicit errors.
- Compute the gap between each input and the route's first or last shape vertex, and draw it as a dashed "cross-country" segment. Use `/height` or `elevation_interval` for its climb.
- Send `X-Client-Id: incibrief.com`, which the preflight allows, and post in discussion #3373.
- Space requests at 1 per second or more.

### Gaps
- The UI's handling of routing errors (for example error 171) was not reviewed. Only `routing.ts` was read.

---

## 9. Polygon avoidance (for example an active fire perimeter): which engines, and how large or complex

### Takeaway
Engines that can avoid polygons:
- Valhalla / Stadia: `exclude_polygons`. Default caps are 10 km total perimeter and 100 vertices; FOSSGIS is stricter and unpublished; Stadia's are undocumented.
- ORS: `avoid_polygons`, up to 200 km², 20 km extent, and 150 km routes.
- BRouter: `polygons` / `polylines` / `nogos`. No documented size caps, but GET URL length applies and POST is off by default.
- GraphHopper: custom-model `areas`. Paid plans only, because it needs flexible mode.

TomTom is limited to 10 rectangles of up to ~160 × 160 km. Mapbox allows exclusion points only. OSRM has no polygon avoidance.

### Cited Findings
- **Valhalla** `exclude_polygons` semantics and default limits: `max_exclude_polygons_length` 10,000 m, `max_exclude_polygons_vertices` 100. — [route API reference](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md); [valhalla_build_config](https://github.com/valhalla/valhalla/blob/master/scripts/valhalla_build_config)
- FOSSGIS service limits are "a bit stricter than the defaults" (2021) and "a lot stricter now" (2026). — [discussion #3373](https://github.com/valhalla/valhalla/discussions/3373)
- **Stadia** supports `exclude_polygons` and recommends `exclude_locations` as faster for a few roads. No limits are published. — [Stadia guide](https://docs.stadiamaps.com/guides/getting-the-best-routes-with-valhalla-turn-by-turn-directions-apis/)
- **ORS**: GeoJSON Polygon or MultiPolygon, 200 km² area, 20 km extent, 150 km route distance with avoid areas. — [ORS routing options](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/routing-options); [ORS restrictions](https://openrouteservice.org/restrictions/)
- **BRouter**: `nogos`, `polylines` and `polygons` parameters. POST for large payloads only when the server enables it, with a default 1 MB cap. — [RoutingParamCollector.java](https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/RoutingParamCollector.java); [http_server.md](https://github.com/abrensch/brouter/blob/master/docs/developers/http_server.md)
- **GraphHopper**: `areas` as a GeoJSON FeatureCollection of Polygons, blocked with `multiply_by: 0`. The Free plan has no flexible mode. — [custom-models.md](https://github.com/graphhopper/graphhopper/blob/master/docs/core/custom-models.md); [GraphHopper pricing](https://www.graphhopper.com/pricing/)
- **TomTom**: `avoidAreas` rectangles, at most 10, each up to ~160 × 160 km. — [TomTom common routing parameters](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/common-routing-parameters)
- **Mapbox**: `exclude` points only, up to 50. — [Mapbox Directions docs](https://docs.mapbox.com/api/navigation/directions/)

### Inferences
- Walking crews need a "don't route through the fire" guard. The practical keyless approach combines two steps:
  1. Simplify the perimeter to a coarse convex hull or buffered polygon with a small vertex count.
  2. Pass it to BRouter `polygons`, or to Valhalla `exclude_polygons` if it fits within about 10 km of perimeter.
- As a backstop, check client-side whether the returned line intersects the full-resolution perimeter, which the app already has, and warn if it does.
- For large fires, only BRouter (with URL-length caveats) or paid GraphHopper can express realistic polygons. ORS caps at 20 km extent, and Valhalla's default at a 10 km perimeter.

### Gaps
- Actual FOSSGIS and Stadia exclude-polygon limits were not probed.
- BRouter's practical maximum polygon size on brouter.de (URL length, server timeouts) is unknown.
- Esri polygon barrier limits were not checked.

---

## 10. Which Walk engine(s) and exact request options (synthesis inputs)

### Takeaway
No keyless engine is both sanctioned for production and trail-seeking:
- **BRouter hiking-mountain** gives the best trail behaviour and the best off-trail handling (`profile:add_beeline=1`), but brouter.de has no third-party usage policy.
- **FOSSGIS Valhalla** is conditionally tolerated (announce, `X-Client-Id`, 1 request per second) but trail-neutral and grade-biased toward valley roads.
- **FOSSGIS OSRM** is policy-clear and reports snap distance, but is not trail- or grade-aware and blocks T2+ trails.
- **ORS** is ruled out by its own no-client-side-key guidance.
- **Stadia** (from $20/month commercial, domain auth) and **GraphHopper paid** (from €69/month) are the realistic paid upgrades.

### Cited Findings
- BRouter was the only engine to use the trail on R1, and supports beelines to off-network points (section 7). — [B1](https://brouter.de/brouter?lonlats=-115.01402,44.1987|-115.06576,44.24711&profile=hiking-mountain&alternativeidx=0&format=geojson); [B3](https://brouter.de/brouter?lonlats=-112.78245,47.84753|-112.80032,47.81245&profile=hiking-mountain&alternativeidx=0&format=geojson&profile:add_beeline=1)
- FOSSGIS Valhalla terms: 1 call/user/sec, bursts of 10, `X-Client-Id` plus an announcement; not intended for third-party production (2021). — [Valhalla README](https://github.com/valhalla/valhalla/blob/master/README.md); [discussion #3373](https://github.com/valhalla/valhalla/discussions/3373)
- FOSSGIS OSRM policy: 1 request per second, no heavy use, User-Agent/Referer, attribution plus a "fix the map" link. — [FOSSGIS about](https://routing.openstreetmap.de/about.html)
- ORS says no client-side keys. — [ORS FAQ](https://giscience.github.io/openrouteservice/frequently-asked-questions.html)
- Stadia: domain auth; Starter is commercial at $20/month for 1M credits (about 50k routes at 20 credits each). — [Stadia pricing](https://stadiamaps.com/pricing/); [Stadia auth](https://docs.stadiamaps.com/authentication/)
- GraphHopper Free: non-commercial; car/bike/foot only; no custom models. — [GraphHopper pricing](https://www.graphhopper.com/pricing/); [GraphHopper forum](https://discuss.graphhopper.com/t/message-for-your-account-the-profile-parameter-can-only-be-one-of-car-bike-foot-but-was-small-truck/9468)

### Inferences
Candidate request templates, reasoned from the findings; engine names are for the report writer:

- **BRouter** (GET):
  ```
  https://brouter.de/brouter?lonlats={lon},{lat}|{lon},{lat}&profile=hiking-mountain&alternativeidx=0&format=geojson&profile:add_beeline=1[&polygons=...]
  ```
  Optionally add `&profile:consider_elevation=1` for elevation-aware cost (untested).
  - Read `track-length`, `total-time` and `filtered ascend`.
  - Detect beeline segments as `messages` rows with empty WayTags.
  - Recompute the beeline's climb with Valhalla `/height` or the app's DEM, because BRouter doesn't model it.
- **FOSSGIS Valhalla** (GET, header `X-Client-Id: incibrief.com`):
  ```json
  {"locations":[{"lat":..,"lon":..,"search_cutoff":3000},{"lat":..,"lon":..,"search_cutoff":3000}],
   "costing":"pedestrian",
   "costing_options":{"pedestrian":{"max_hiking_difficulty":3,"use_tracks":0.5}},
   "units":"kilometers",
   "elevation_interval":30}
  ```
  - Optionally add `exclude_polygons` with a simplified perimeter under the server's limits.
  - Compute the snap gap from input versus shape endpoints, or with `/locate` `distance`.
  - Consider `shortest:true` as a "prefer trails when shorter" variant (untested).
- **FOSSGIS OSRM foot** (fallback):
  ```
  https://routing.openstreetmap.de/routed-foot/route/v1/foot/{lon},{lat};{lon},{lat}?overview=full&geometries=geojson&steps=true
  ```
  Surface `waypoints[].distance` as the cross-country gap.
- **Off-trail endpoints, all engines.** Never present a silently snapped route as reaching the destination. Show the network route plus a dashed straight-line "cross-country" leg with its distance and DEM climb. This fits the separate cross-country travel research in this folder.
- **Offline PWA packs.** None of these hosted engines work offline. Offline Walk would need precomputed routes or an in-browser router (see Gaps).
- **Self-hosting.** If ever justified, BRouter is the lightest option: a Java server with a 128 MB heap in the sample config, plus weekly rd5 segments. A planet-scale Valhalla is heavier; FOSSGIS runs one on a "low spec machine" and rebuilds about every 2 days. The owner's GitHub-only constraint rules both out for now.

### Gaps
- No answer yet from the BRouter or FOSSGIS maintainers on sanctioned use by incibrief.com; the owner would need to ask.
- It is unclear whether incibrief.com counts as "commercial" under the Stadia or GraphHopper free-plan terms.
- No in-browser (WASM or JS) build of Valhalla, BRouter or GraphHopper was researched for offline PWA routing.
- Real-world walking-time accuracy of each engine for crews (loads, off-trail travel rates) is outside this note; see the off-trail travel science notes in this folder.
