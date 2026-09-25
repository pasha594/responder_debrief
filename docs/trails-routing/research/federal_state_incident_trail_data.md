# Authoritative US public-land trail, road and wildfire-incident line datasets (federal, state, NIFC), for a trails overlay and trail-aware routing

Method note: most service facts below come from live requests I made on 2026-09-24. Each request was a GET with the header `Origin: https://incibrief.com`. I recorded the HTTP status, `Access-Control-Allow-Origin` (ACAO), `Access-Control-Allow-Credentials` (ACAC), feature counts (`returnCountOnly=true`) and attribute distributions (`outStatistics` with `groupByFieldsForStatistics`). For these facts the cited "source" is the endpoint URL itself. Facts from documents cite the document. I found no API keys, logins or sign-ups necessary for anything below, except where a dataset is stated to be restricted.

## Q1. USFS EDW: National Forest System Trails (TrailNFS_Publish), NFS Roads, and MVUM roads/trails

### Takeaway
All three USFS datasets are available two ways. The first is national FGDB and shapefile zips on data.fs.usda.gov, refreshed weekly; the Sep 2026 sizes are trails 119 MB, roads 240 MB, MVUM roads 119 MB and MVUM trails 36 MB (all FGDB zips). The second is dynamic ArcGIS MapServers at apps.fs.usda.gov/arcx. Those return GeoJSON/PBF, cap results at 2,000 records per request, support pagination, and echo the request Origin in CORS headers, so a browser can call them directly. No vector-tile service exists. Trail attributes are rich (class 1–5, allowed/managed uses per mode with date ranges, grade, tread width, surface), but about 12% of trail miles are published at "centerline only" with no class or use data. Roads carry operational maintenance levels 1–5 (ML2 = high-clearance, ML3+ = passenger car), and MVUM adds vehicle-class and seasonal designations.

### Cited Findings
**Endpoints and service behavior (tested 2026-09-24)**
- The EDW REST folder (ArcGIS Server 11.5) lists `EDW/EDW_TrailNFSPublish_01`, `EDW/EDW_TrailNFSPublishWithDataStatus_01`, `EDW/EDW_RoadBasic_01`, `EDW/EDW_MVUM_01` and `EDW/EDW_MVUM_02`, all MapServer. It has no FeatureServer and no VectorTileServer. — [EDW services directory](https://apps.fs.usda.gov/arcx/rest/services/EDW?f=json)
- CORS: every EDW REST response, including `/query`, returned `ACAO: https://incibrief.com` (the request Origin echoed back) and `ACAC: true`. Browser `fetch()` of queries and export images works cross-origin. — [TrailNFSPublish MapServer](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer?f=json)
- TrailNFSPublish_01 has a single layer, 0 `Trans_Trail_NFS_Publish` (polyline). Service settings:
  - `maxRecordCount` is 2000.
  - `supportedQueryFormats` are JSON, geoJSON and PBF.
  - Capabilities are Map, Query and Data.
  - Layer `minScale` is 288,895, which limits drawing only, not queries.
  - `advancedQueryCapabilities` include supportsPagination, supportsOrderBy and supportsDistinct, all true.
  — [Trail layer 0 JSON](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0?f=json)
- Trail layer field list (exact names): objectid, trail_name, trail_type, trail_cn, bmp, emp, segment_length, admin_org, managing_org, security_id, attributesubset, national_trail_designation, trail_class, accessibility_status, trail_surface, surface_firmness, typical_trail_grade, typical_tread_width, minimum_trail_width, typical_tread_cross_slope, special_mgmt_area, terra_base_symbology, mvum_symbol, terra_motorized, snow_motorized, water_motorized, allowed_terra_use, allowed_snow_use. Each of these modes has `_managed`, `_accpt`, `_disc`, `_accpt_disc` and `_restricted` fields: hiker_pedestrian, pack_saddle, bicycle, motorcycle, atv, fourwd, snowcoach_snowcat, snowmobile, snowshoe, xcountry_ski, motor_watercraft, nonmotor_watercraft. Also present: trail_no, gis_miles, e_bike_class1/2/3_* and globalid. — [Trail layer 0 JSON](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0?f=json)
- RoadBasic_01 has two layers:
  - Layer 0, "National Forest System Roads" (minScale 400,000), has 174,027 segments.
  - Layer 1, "National Forest System Roads closed to motorized uses" (minScale 144,500), has 193,903 segments.
  - Road fields: rte_cn, id, name, bmp, emp, seg_length, jurisdiction, system, route_status, oper_maint_level, objective_maint_level, functional_class, surface_type, lanes, primary_maintainer, county, admin_org, service_life, level_of_service, pfsr_classification, managing_org, loc_error, gis_miles, openforuseto, ivm_symbol and symbol_name.
  — [RoadBasic MapServer](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RoadBasic_01/MapServer?f=json); [layer 0](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RoadBasic_01/MapServer/0?f=json)
- The service defines a road as "a motor vehicle travel way over 50 inches wide, unless classified and managed as a trail." — [RoadBasic MapServer description](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RoadBasic_01/MapServer?f=json)
- Operational maintenance level distribution:
  - Layer 0 (open roads):
    - "2 - HIGH CLEARANCE VEHICLES": 142,670 segments, about 165,166 mi
    - "3 - SUITABLE FOR PASSENGER CARS": 22,223 segments, about 47,677 mi
    - "4 - MODERATE DEGREE OF USER COMFORT": 6,225 segments, about 10,899 mi
    - "5 - HIGH DEGREE OF USER COMFORT": 2,881 segments, about 3,074 mi
  - Layer 1 (closed to motorized use):
    - "1 - BASIC CUSTODIAL CARE (CLOSED)": 148,879 segments
    - ML2: 41,252 segments
    - ML3–5: about 3,500 segments
  — [RoadBasic layer 0 query](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RoadBasic_01/MapServer/0/query); [layer 1 query](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RoadBasic_01/MapServer/1/query)
- MVUM layers:
  - The service description says it covers roads and trails "designated for motor vehicle use under ... 36 CFR 212.56". MVUM_02 differs from MVUM_01 only in that its MVUM symbology group is labeled.
  - Layers: 1 "Motor Vehicle Use Map: Roads" with 150,792 segments and 2 "Motor Vehicle Use Map: Trails" with 62,778 segments. Layers 4 and 5 repeat them under Visitor Map symbology; the remaining layers are status polygons.
  — [MVUM_02 MapServer](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/MapServer?f=json)
- MVUM road fields: symbol, mvum_symbol_name, operationalmaintlevel, surfacetype and seasonal. These vehicle classes each have a flag field plus a `_datesopen` field: passengervehicle, highclearancevehicle, truck, bus, motorhome, fourwd_gt50inches, twowd_gt50inches, tracked_ohv_gt50inches, other_ohv_gt50inches, atv, motorcycle, otherwheeled_ohv, tracked_ohv_lt50inches, other_ohv_lt50inches. Also present: e_bike_class1/2/3 with `_dur`, districtname and forestname. Trails add trailclass, trailsystem and trailstatus. — [MVUM roads layer 1](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/MapServer/1?f=json); [MVUM trails layer 2](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/MapServer/2?f=json)
- MVUM designation classes:
  - Roads:
    - "Roads open to all Vehicles, Yearlong": 71,970
    - "Roads open to highway legal vehicles only, Yearlong": 40,025
    - "... all Vehicles, Seasonal": 23,154
    - "... highway legal ... Seasonal": 11,942
    - "Special Designation" (Seasonal plus Yearlong): 3,701
  - Trails:
    - "Trails open to all vehicles, Yearlong": 13,426
    - "Special Designation, Yearlong": 11,859
    - "Trails open to vehicles 50" or less in width, Seasonal": 10,622
    - "Trails open to vehicles 50" or less in width, Yearlong": 7,961
    - "Special Designation, Seasonal": 5,039
    - "Trails open to motorcycles, Yearlong": 4,903
    - "Trails open to motorcycles, Seasonal": 2,717
  — [MVUM roads query](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/MapServer/1/query); [MVUM trails query](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/MapServer/2/query)
- Data-quality evidence in MVUM: the `seasonal` field mixes "yearlong" (113,466), "seasonal" (36,326), "Seasonal" (398), "seasonal " with a trailing space (140), " " (130), null (331) and one literal date "4/1 - 12/25". `highclearancevehicle` has 4,031 nulls and a few truncated values such as "05/0". — [MVUM roads query](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/MapServer/1/query)
- Live-query payload test (2026-09-24). Query: bbox -105.72,39.98,-105.47,40.18 (Indian Peaks, CO), `outFields=*`, `f=geojson`.
  - EDW trails returned 105 features, 3.88 MB, in 2.6 s.
  - EDW roads returned 144 features, 0.45 MB, in 0.5 s.
  — [Trail layer query endpoint](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query)
- MapServer `export` works as a browser raster overlay. A z14 tile-sized request (`bbox` in 3857, `size=256,256`, `format=png32`, `transparent=true`) returned `image/png` with ACAO echoed:
  - TrailNFS: 1.8 KB in 0.2 s. It showed the Mitchell Lake trail line.
  - MVUM layers 1 and 2: 4.5 KB.
  — [TrailNFS export endpoint](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/export)

**Bulk downloads (EDW datasets page, verified by HEAD 2026-09-24)**
- "National Forest System Trails" was last refreshed Sep 23, 2026:
  - `https://data.fs.usda.gov/geodata/edw/edw_resources/fc/Trans_Trail_NFS_Publish.gdb.zip` is 119,372,878 bytes, Last-Modified Wed 23 Sep 2026 13:34 GMT.
  - The shapefile `.../shp/Trans_Trail_NFS_Publish.zip` is 247,800,436 bytes.
  - Metadata is at `.../meta/Trans_Trail_NFS_Publish.xml`.
  — [EDW datasets page](https://data.fs.usda.gov/geodata/edw/datasets.php); [FGDB zip](https://data.fs.usda.gov/geodata/edw/edw_resources/fc/Trans_Trail_NFS_Publish.gdb.zip)
- "National Forest System Roads" (`Trans_RoadCore_FS`) was last refreshed Sep 23, 2026. The FGDB zip is 239,555,262 bytes; the shapefile is about 429 MB. Description: "Existing Forest Service roads with attributes representing their characteristics." — [EDW datasets page](https://data.fs.usda.gov/geodata/edw/datasets.php); [FGDB zip](https://data.fs.usda.gov/geodata/edw/edw_resources/fc/Trans_RoadCore_FS.gdb.zip)
- MVUM downloads, both last refreshed Sep 22, 2026:
  - "Motor Vehicle Use Map: Roads" (`Trans_MVUM_Road`): FGDB 118,617,316 bytes, shapefile about 227 MB.
  - "Motor Vehicle Use Map: Trails" (`Trans_MVUM_Trail`): FGDB 35,902,062 bytes, shapefile about 69 MB.
  — [EDW datasets page](https://data.fs.usda.gov/geodata/edw/datasets.php); [MVUM road FGDB](https://data.fs.usda.gov/geodata/edw/edw_resources/fc/Trans_MVUM_Road.gdb.zip)
- The data.fs.usda.gov zips return a fixed `Access-Control-Allow-Origin: https://www.fs.usda.gov`. This does not match other origins, so a browser on incibrief.com cannot fetch them. — [HEAD of trails FGDB zip](https://data.fs.usda.gov/geodata/edw/edw_resources/fc/Trans_Trail_NFS_Publish.gdb.zip)
- Cadence: the datasets page refers to a "weekly refresh process" and on 2026-09-24 carried the notice: "We are experiencing network issues that are causing the weekly refresh process to fail. Until this is resolved, these datasets may not be refreshed on the weekly cycle." It also says: "To obtain a KML file for any EDW dataset, go to the Geospatial Data Discovery Tool" (data-usfs.hub.arcgis.com). — [EDW datasets page](https://data.fs.usda.gov/geodata/edw/datasets.php)
- The USFS ArcGIS Online item "National Forest System Trails (Feature Layer)" points back to the same EDW MapServer layer; the item was modified 2022-08-25. I found no separate hosted FeatureServer. — [ArcGIS item 0969eb1c…](https://www.arcgis.com/sharing/rest/content/items/0969eb1cbb2f4a1d861ee58fff587cc2?f=json)

**TrailNFS schema semantics (FGDC metadata, S_USA.TrailNFS_Publish.xml)**
- The metadata's publication date is 2025-05-14 and its update frequency is "Irregular". It reported 83,282 features at that time. — [TrailNFS metadata](https://data.fs.usda.gov/geodata/edw/edw_resources/meta/S_USA.TrailNFS_Publish.xml)
- There are three attribute subsets, and each Forest approves which one it publishes:
  - TRAILNFS_CENTERLINE: name, number, location, BMP/EMP.
  - TRAILNFS_BASIC: adds trail class, accessibility, surface, national designation and other basic characteristics.
  - TRAILNFS_MGMT: adds motorized and non-motorized allowed/managed use data, which "must be consistent with the Forest's published Motorized Vehicle Use Map".
  — [TrailNFS metadata](https://data.fs.usda.gov/geodata/edw/edw_resources/meta/S_USA.TrailNFS_Publish.xml)
- Coded values:
  - TRAIL_CLASS: 1 Minimally, 2 Moderately, 3 Developed, 4 Highly, 5 Fully developed, plus N (not populated).
  - TRAIL_TYPE: TERRA, SNOW or WATER.
  - ALLOWED_TERRA_USE concatenates digits: 1 Hiker/Pedestrian, 2 Pack & Saddle, 3 Bicycle, 4 Motorcycle, 5 ATV, 6 4WD>50".
  - ALLOWED_SNOW_USE: 1 Snowshoe, 2 XC ski, 3 Snowmobile.
  - TYPICAL_TRAIL_GRADE bins: 0-5%, 5-8%, 8-10%, 10-12%, 12-20%, 20-30%, 30-40%, 40-50%, >50%.
  - TYPICAL_TREAD_WIDTH and MINIMUM_TRAIL_WIDTH are in inches.
  - SURFACE_FIRMNESS: P, H, F, S, VS.
  - NATIONAL_TRAIL_DESIGNATION: 0 not populated, 1 not designated, 2 all other, 3 Scenic or Historic.
  - The *_MANAGED/_ACCPT/_DISC/_RESTRICTED fields hold MM/DD date ranges.
  - SPECIAL_MGMT_AREA includes WILDERNESS, IRA, WSA and others.
  — [TrailNFS metadata](https://data.fs.usda.gov/geodata/edw/edw_resources/meta/S_USA.TrailNFS_Publish.xml)
- License and terms: Access Constraints "None". Use Constraints: a standard USFS no-warranty disclaimer. Contact: SM.FS.data@usda.gov. — [TrailNFS metadata](https://data.fs.usda.gov/geodata/edw/edw_resources/meta/S_USA.TrailNFS_Publish.xml)

**Live content statistics (2026-09-24)**
- There are 86,417 trail segments. By attribute subset:
  - TrailNFS_MGMT: 75,150 segments, about 119,170 mi.
  - TrailNFS_Basic: 5,767 segments, about 9,514 mi.
  - TrailNFS_Centerline: 5,500 segments, about 16,809 mi.
  - Total is about 145,500 mi.
  — [Trail layer query](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query)
- trail_class distribution:
  - Class 3: 42,597 segments, 70,147 mi.
  - Class 2: 26,448 segments, 40,177 mi.
  - Class 4: 6,529 segments.
  - Class 1: 4,361 segments.
  - Class 5: 593 segments.
  - "N": 5,500 segments, 16,809 mi (exactly the centerline-only set).
  - null: 389 segments.
  — [Trail layer query](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query)
- trail_type: TERRA 78,156 segments (125,057 mi), SNOW 8,185 (19,592 mi), WATER 76. The most common allowed_terra_use codes are "321" (27,291), "21" (12,364), "N/A" (11,267), "54321" (10,774), null (7,010) and "1" (4,205). — [Trail layer query](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query)

### Inferences
- **Ingest these.** A weekly or nightly worker can read the FGDB zips directly with GDAL 3.8's OpenFileGDB driver, either downloading them or via `/vsizip//vsicurl/`, then clip to western forests and fire AOIs. Together the four zips are about 510 MB per refresh. Checking `Last-Modified` or `ETag` avoids re-downloading unchanged weeks.
- Snow and water trails (about 8,261 segments) should be filtered out for a summer-season trail overlay and for walking routing (`trail_type='TERRA'`).
- **Walk-routing signals.** For a pedestrian or crew routing profile, the useful signals are:
  - allowed_terra_use containing "1", or hiker_pedestrian_managed/accpt populated;
  - trail_class (1–2 is rough and minimally developed);
  - typical_trail_grade and typical_tread_width.
- **Gap for walk routing.** Centerline-only segments (about 16.8k mi) and N/A or null uses (about 18k segments) carry none of those signals, so routing needs a default ("unknown, assume passable on foot").
- **Road access classes.** For apparatus and engine routing, ML2 means high-clearance only and ML3+ means passenger car. Closed roads (layer 1, mostly ML1) are relevant to firefighters as potential dozer or engine access and as contingency lines. They should be a separate, clearly styled layer, not routable by default.
- **Seasonal MVUM designations.** The `*_datesopen` strings need normalization; the observed values are messy, see the seasonal-field findings above.
- **Live browser use is possible but heavy.** CORS works, and the MapServer export gives a zero-ingest raster overlay via a MapLibre raster source with a `{bbox-epsg-3857}` tile URL. GeoJSON query payloads are very large, about 37 KB per trail feature with `outFields=*`, and nothing would be cached for the offline pack. Live use is only sensible as an optional online raster overlay; the offline pack must come from worker-built static files.

### Gaps
- I read the older metadata file S_USA.TrailNFS_Publish.xml (pub. 2025-05-14), not the current `Trans_Trail_NFS_Publish.xml` that the datasets page now links. Field definitions may have been revised since.
- I did not verify topology, meaning whether trail segments are noded to each other and to NFS roads at junctions. Segments are split at attribute changes (BMP/EMP linear referencing), so network building will need snapping and noding.
- I did not verify whether USFS publishes vector-tile packages (VTPK). The OSM Merge write-up cited in Q6 mentions agency "vector map tile sets", but I found no USFS VectorTileServer.
- I did not verify how RoadCore_FS (download) differs from RoadBasic layers 0 and 1 (service). Download feature counts were not measured.

## Q2. NPS trails, BLM Ground Transportation Linear Features (GTLF), and USFWS trails

### Takeaway
All three agencies publish national linear datasets through ArcGIS REST with CORS enabled, but none has a vector-tile service or an agency-hosted static bulk file that I could verify:
- NPS: NPS_Public_Trails, 31,491 segments, edited to Sep 22, 2026.
- BLM: GTLF public subsets, about 173k features across the public-display layers, refreshed Sep 21–22, 2026.
- USFWS: FWS HQ Trails, 6,420 segments.

The worker should page them with GDAL's ESRIJSON driver. BLM's GTLF is the richest for fire access because it includes primitive roads, route-use class (2WD/4WD high-clearance/ATV/single-track) and an "Admin Only (BLM, Fire, etc.)" access flag. NPS attributes are sparsely and inconsistently populated.

### Cited Findings
**NPS**
- The `mapservices.nps.gov/arcgis/rest/services/NationalDatasets` folder contains NPS_Public_Trails (MapServer and FeatureServer), NPS_Public_Trails_Geographic (MapServer and FeatureServer), NPS_Public_Roads (MapServer and FeatureServer) and NPS_Public_Roads_Geographic (MapServer and FeatureServer). Every response echoed the Origin in ACAO. — [NPS NationalDatasets folder](https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets?f=json)
- NPS_Public_Trails MapServer: layer 0 "Trails", maxRecordCount 2000, formats JSON, geoJSON and PBF, copyright "National Park Service, ngp_support@nps.gov". The `_Geographic` FeatureServer is Query-only and JSON-only. — [NPS_Public_Trails MapServer](https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/MapServer?f=json); [NPS_Public_Trails_Geographic FeatureServer](https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails_Geographic/FeatureServer?f=json)
- NPS layer fields: TRLFEATTYPE, TRLNAME, TRLALTNAME, MAPLABEL, TRLSTATUS, TRLSURFACE, TRLTYPE, TRLCLASS, TRLUSE, PUBLICDISPLAY, DATAACCESS, ACCESSNOTES, ORIGINATOR, UNITCODE, UNITNAME, UNITTYPE, GROUPCODE, REGIONCODE, CREATEDATE, EDITDATE, LINETYPE, MAPMETHOD, MAPSOURCE, SOURCEDATE, XYACCURACY, GEOMETRYID, FEATUREID, FACLOCID, FACASSETID, OPENTOPUBLIC, SEASONAL, SEASDESC, MAINTAINER and NOTES. There are 31,491 features and the maximum EDITDATE is 2026-09-22. — [NPS_Public_Trails_Geographic layer 0](https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails_Geographic/FeatureServer/0?f=json)
- The layer "contains lines representing formal and informal trails as well as routes within and across National Park Units" and uses "core attributes designed by the NPS enterprise geospatial committee". This is from a search-result summary of the service's iteminfo, which I did not fetch directly. — [NPS_Public_Trails iteminfo](https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/MapServer/info/iteminfo)
- Attribute completeness:
  - TRLCLASS: "Unknown" 14,924 of 31,491; Class 3 5,846; Class 1 3,694; Class 5 2,765; Class 2 2,252; Class 4 1,415; plus stray codes "4", "3", "6".
  - TRLUSE is free-text-like: "Hiker/Pedestrian" 9,888, "Unknown" 9,284, "Hike" 2,936, "Hiker / Pedestrian" 1,975, and many pipe-delimited variants.
  - TRLSURFACE: "Unknown" 11,404.
  - OPENTOPUBLIC: null for all 31,491.
  — [NPS_Public_Trails layer 0 query](https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/MapServer/0/query)
- A live bbox GeoJSON query near Rocky Mountain NP's east edge returned 4 features, 30 KB, in 0.1 s. — [NPS_Public_Trails layer 0 query](https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/MapServer/0/query)
- License text on the NPS national trails item: "The National Park Service shall not be held liable for improper or incorrect use of the data...". This is a disclaimer, not a restrictive license. Note that the item was registered by a non-NPS account (mm.atlas) that points to the NPS service. — [ArcGIS item 857c2c5e…](https://www.arcgis.com/sharing/rest/content/items/857c2c5eb3aa41d59c0664f6bf630f1b?f=json)
- The NPS org's ArcGIS Online (services1.arcgis.com/fBc8EJBxQRMcHlei, 1,455 services, ACAO `*`) also hosts per-park trail layers such as YOSE_Trails, YELL_TRAILS, GLAC_Trails_2019, GRSM_TRAILS, JOTR_CMP_Trails and PacificCrestTrail. — [NPS AGOL services list](https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services?f=json)
- NPS's own page says IRMA/DataStore hosts authoritative NPS trail datasets "as ESRI shapefiles/feature services" for public download. This comes from search results, not fetched directly. — [NPS National Trails Office GIS data](https://www.nps.gov/orgs/1453/gis-data.htm)

**BLM GTLF**
- The GTLF data standard (IM 2015-061) defines a ground transportation linear feature as including "roads, primitive roads, primitive routes, trails, temporary routes, and linear disturbances." — [BLM IM 2015-061](https://www.blm.gov/policy/im-2015-061)
- The `gis.blm.gov/arcgis/rest/services/transportation` folder has two services, both echoing Origin in ACAO with ACAC true, maxRecordCount 2000, formats JSON/geoJSON/PBF:
  - BLM_Natl_GTLF_Public_Display MapServer, layers 0–7 with counts:
    - 0 Roads Managed for Public Motorized Use: 110,413
    - 1 Roads Managed for Limited Public Motorized Use: 25,893
    - 2 Trails Managed for Public Motorized Use: 1,938
    - 3 Trails Managed for Limited Public Motorized Use: 5,294
    - 4 Trails ... Public Non-Motorized Use: 3,043
    - 5 Trails ... Public Non-Mechanized Use: 2,318
    - 6 Trails Not Assessed for Public: 5,038
    - 7 Trails Managed for Public: 19,532
  - BLM_Natl_GTLF MapServer: 1 layer, 10,382 features, described as "for the Recreation mapping project".
  — [BLM transportation folder](https://gis.blm.gov/arcgis/rest/services/transportation?f=json); [Public_Display MapServer](https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF_Public_Display/MapServer?f=json)
- GTLF fields and domains useful to firefighters:
  - PLAN_ASSET_CLASS: Road (low-clearance, 4+ wheels), Primitive Road (4WD/high-clearance), Trail, Temporary Route, Primitive Route - WSA/LWC, Linear Disturbance, Not Assessed.
  - PLAN_OHV_ROUTE_DSGNTN: Open, Closed, Limited, Unknown.
  - PLAN_MODE_TRNSPRT: Non-Mechanized, Non-Motorized, Motorized.
  - PLAN_ACCESS_RSTRCT: All, "Admin Only=Government management uses only (BLM, Fire, etc.)", Authorized/Permitted, None, Unknown.
  - PLAN_SEASON_RSTRCT_CODE.
  - OBSRVE_ROUTE_USE_CLASS: 2WD Low, 4WD Low, 4WD High Clearance/Specialized, UTV, ATV, Motorized Single Track, Non-Motorized, Non-Mechanized, Over Snow Vehicle, Impassable.
  - OBSRVE_SRFCE_TYPE: Solid Surface, Aggregate, Natural Improved, Natural, Snow, and others.
  - ROUTE_PRMRY_NM and ROUTE_SPCL_DSGNTN_TYPE (NHT/NST/NRT/Back Country Byway).
  - COORD_SRC_TYPE (GPS, IMG, DLG, and others) and ACCURACY_FT.
  - ADMIN_ST covers AK, AZ, CA, CO, ES, ID, MT, NM, NV, OR, UT, WY.
  — [BLM_Natl_GTLF layer 0](https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF/MapServer/0?f=json)
- The BLM national hub publishes hosted FeatureServers on services1.arcgis.com/KbxwQRRfWyEYLgp4. All return ACAO `*`, maxRecordCount 2000 and JSON/geoJSON/PBF, and support coordinate quantization. Items were modified 2026-09-22; data last edited 2026-09-21. Services:
  - BLM_Natl_GTLF_Public_Motorized_Roads (layer 3, 110,413)
  - ..._Public_Managed_Trails (layer 2, 19,532)
  - ..._Public_Nonmechanized_Trails (layer 5, 2,318)
  - ..._Public_Nonmotorized_Trails
  - ..._Public_Motorized_Trails
  - ..._Limited_Public_Motorized_Roads
  - ..._Limited_Public_Motorized_Trails
  - ..._Public_Not_Assessed_Trails
  — [BLM hub Motorized Roads FeatureServer](https://services1.arcgis.com/KbxwQRRfWyEYLgp4/arcgis/rest/services/BLM_Natl_GTLF_Public_Motorized_Roads/FeatureServer?f=json); [ArcGIS search "GTLF"](https://www.arcgis.com/sharing/rest/search?q=title:%22GTLF%22%20access:public&f=json)
- Hub item description: "This dataset is a subset of the official national dataset, containing features and attributes intended for public release and has been optimized for online map service performance." License: "These data are provided by BLM 'as is' and may contain errors or omissions. The User assumes the entire risk...". — [ArcGIS item f94999eb…](https://www.arcgis.com/sharing/rest/content/items/f94999eb674d4085be0c86729fe4a151?f=json)
- State GTLF services also exist, for example BLM ID GTLF (gis.blm.gov/idarcgis, modified 2026-06-12) and BLM AK GTLF (gis.blm.gov/akarcgis). — [BLM ID GTLF (hub)](https://gbp-blm-egis.hub.arcgis.com/datasets/BLM-EGIS::blm-id-ground-transportation-linear-features-gtlf); [BLM AK GTLF FeatureServer](https://gis.blm.gov/akarcgis/rest/services/Transportation/BLM_AK_Ground_Transportation_Linear_Features_GTLF/FeatureServer/0)
- An ArcGIS Online search for public File Geodatabase items titled "GTLF" returned 0 results. I found no static national FGDB, so bulk access is through the hub's on-the-fly exports or FeatureServer paging. — [ArcGIS search](https://www.arcgis.com/sharing/rest/search?q=title:%22GTLF%22%20type:%22File%20Geodatabase%22%20access:public&f=json)

**USFWS**
- "FWS Trails - Public View" is at `services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/FWS_HQ_Trails_Cycle_3_Public_View/FeatureServer`, layer 1 "FWS HQ Trail Segments". It has 6,420 features, data last edited 2026-09-24, and returns ACAO `*`. Fields include TRNAME, TRNUMBER, TRTYPE, TRSURFACE, TRCLASS, TRCONDITION, DESIGNEDUSE, MANAGEDUSE, TRUSE, WIDTH, MAXSLOPE, AVGSLOPE, AVGXSLOPE, SEASONAL, PUBLICDISPLAY, DATAACCESS, MAPMETHOD, XYACCURACY, BICYCLES, DOGS and ACCESSIBILITYINFO. — [FWS trails layer 1](https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/FWS_HQ_Trails_Cycle_3_Public_View/FeatureServer/1?f=json)
- FWS license text: "The United States Fish and Wildlife Service (Service) shall not be held liable for improper..." (a disclaimer). — [ArcGIS search "FWS trails"](https://www.arcgis.com/sharing/rest/search?q=title:%22FWS%22%20trails%20access:public&f=json)

**Tooling**
- The ESRIJSON driver in GDAL (checked on 3.13; the option has long existed) exposes the open option `FEATURE_SERVER_PAGING`, described as "Whether to automatically scroll through results with a ArcGIS Feature Service endpoint". `ogr2ogr` can therefore pull a whole 2,000-record-capped layer in one command. — [GDAL ESRIJSON driver docs](https://gdal.org/en/stable/drivers/vector/esrijson.html) (confirmed locally with `ogrinfo --format ESRIJSON`)

### Inferences
- **BLM:** ingest from the hub FeatureServers, whose ACAO is `*` and which were refreshed about weekly in Sep 2026. Paginate with GDAL. Keep PLAN_ASSET_CLASS, PLAN_ACCESS_RSTRCT, OBSRVE_ROUTE_USE_CLASS, PLAN_OHV_ROUTE_DSGNTN and ACCURACY_FT. "Primitive Road" plus "4WD High Clearance" maps naturally onto the app's Drive/Apparatus distinctions. BLM's "Linear Disturbance" and "Not Assessed" routes are exactly the two-tracks crews encounter, but they should not be treated as legal or maintained routes.
- **NPS:** use it only as an overlay and pedestrian-network source. With about half of TRLCLASS and TRLUSE "Unknown", it offers little for routing weights. The dataset is small (31k features), so a full re-pull each week is cheap.
- **USFWS:** small and marginal for western fire country, but cheap to include. It is also already inside USGS NDT (about 8.9k FWS features; see Q3).

### Gaps
- NPS and BLM refresh cadences are not documented in anything I read; the Sep 21–22, 2026 edit dates only imply frequent updates.
- I did not verify a static NPS bulk download (IRMA/DataStore file) or its size.
- BLM "official national dataset" (non-public attributes) access rules were not investigated.
- NPS_Public_Roads was not profiled.

## Q3. USGS National Digital Trails (NDT) and The National Map transportation, including USGS Topo rendering

### Takeaway
NDT is the only multi-agency national trail aggregation: 591,392 segments and about 307,639 miles in the live service in Sep 2026, from 62 source organizations. It is the TNM transportation "Trails" layer and is downloadable per state as FGDB, Shapefile or GeoPackage (Feb 2026 vintage, ACAO `*` on S3). Its federal content (USFS/BLM/NPS/FWS) is a lagged copy of the agency data. Its main added value in the West is Colorado (COTREX), Utah (UGRC) and California/Washington state-park trails. It contains no Oregon, Montana, Arizona, New Mexico or Wyoming state-agency trail sources. The USGS Topo cached basemap draws trails at z14 but not at z13 (one-site test).

### Cited Findings
- TNM transportation MapServer: layer 37 "Trails", layer 11 "National Trails", layer 35 "4WD Roads", layer 36 "Closed Roads". Service settings: maxRecordCount 2000; formats JSON, geoJSON, PBF; ACAO `*`; copyright line "...Data Refreshed July, 2026." The description calls it "based on TIGER/Line data ... and road data from U.S. Forest Service" and says "The National Map download client allows free downloads of public domain transportation data in either Esri File Geodatabase or Shapefile formats." — [TNM transportation MapServer](https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer?f=json)
- The Trails layer is described as "Recreational trails of the United States, including National Scenic Trails." Fields:
  - Identity and naming: permanentidentifier, name, namealternate, trailnumber, trailnumberalternate, maplabel.
  - Source lineage: sourcefeatureid, sourcedatasetid, sourcedatadecscription (sic), sourceoriginator, loaddate, sourceeditdate, publisheddate.
  - Type and use flags (Y/N domains): trailtype, routetype, hikerpedestrian, bicycle, packsaddle, motorcycle, ohvover50inches, ohvisorunder50inches, snowshoe, crosscountryski, dogsled, nonmotorizedwatercraft, osvm, ebike, livestock, pets.
  - Other: seasonopen (text), trailsurface, primarytrailmaintainer, nationaltraildesignation, lengthmiles, networklength.
  - Domains: routetype is Road / Trail / Road and Trail. trailtype is Water / Snow / Standard-Terra. trailsurface is Paved / Unpaved-Improved / Unpaved-Native / Snow / Water / Unknown.
  — [Trails layer 37](https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37?f=json)
- Size (queried 2026-09-24): 591,392 features, total lengthmiles 307,639, max loaddate 2026-05-20. — [Trails layer 37 query](https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37/query)
- Aggregated sources by sourceoriginator (62 groups; segments, then approximate miles):
  - U.S. Forest Service: 145,903 segments, 143,697 mi
  - Colorado Parks and Wildlife: 50,883 segments, 7,891 mi
  - National Park Service: 46,991 segments, 19,372 mi
  - Bureau of Land Management: 37,361 segments, 11,752 mi
  - Utah AGRC: 9,035 segments, 2,293 mi
  - U.S. Fish and Wildlife Service: 8,937 segments, 3,782 mi
  - California Coastal Commission: 8,567 segments
  - California Dept. of Parks and Recreation: 7,867 segments
  - Washington State Parks: 2,067 segments
  - Alaska DNR Parks: 1,306 segments, last loaded 2022-01-03
  - Continental Divide Trail Coalition: 620 segments
  - Nevada DCNR: 611 segments
  - Idaho Dept. of Parks and Recreation: 400 segments
  - Also many eastern and Midwest state agencies (VA, MA, NH, VT, CT, MI, PA, NJ, MN, IN, NY, and others), plus Appalachian Trail Conservancy, North Country Trail Association and Ice Age Trail Alliance.
  No Oregon, Montana, Arizona, New Mexico or Wyoming state agency appears among the 62 originators. — [Trails layer 37 query](https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37/query)
- Source vintages (sourcedatadecscription): "USFS Trails Update 03/2026" 64,336 and "USFS Trails Update 01/2025" 29,587; "Colorado Parks and Wildlife Trails Update 10/2023" 39,880; "BLM Trails Update 03/2026" 20,350; "NPS Trails Update 08/2025" 18,622 and "NPS Trails Update 03/2026" 17,380; "Virginia State Trails 09/2020"; "Massachusetts State Trails 05/2020". — [Trails layer 37 query](https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37/query)
- primarytrailmaintainer: State 199,432; FS 148,010; null 97,615; NPS 37,534; BLM 37,368; Local Government 20,170; Unknown 18,553; County 13,995; FWS 9,220; NGO 5,269; others small. — [Trails layer 37 query](https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37/query)
- Live bbox GeoJSON test (Indian Peaks, CO): 211 features, 3.36 MB, 1.3 s, ACAO `*`. — [Trails layer 37 query](https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37/query)
- Bulk download via the TNM Access API:
  - The dataset "Transportation" (sbDatasetTag "National Transportation Dataset (NTD)") offers Shapefile, FileGDB 10.1 and GeoPackage. There are 170 NTD products (per state or territory × 3 formats), published 2026-02-11/12.
  - Examples: Colorado FGDB 259.7 MB, GPKG 319.0 MB, SHP 284.1 MB. California GPKG 1.06 GB. Arizona GPKG 298.2 MB.
  - URL pattern: `https://prd-tnm.s3.amazonaws.com/StagedProducts/Tran/{GDB|GPKG|Shape}/TRAN_<State>_State_{GDB|GPKG|Shape}.zip`.
  - The API itself returns ACAO `*`.
  — [TNM Access API datasets](https://tnmaccess.nationalmap.gov/api/v1/datasets); [TNM Access API products (NTD)](https://tnmaccess.nationalmap.gov/api/v1/products?datasets=National%20Transportation%20Dataset%20(NTD))
- A HEAD on TRAN_Colorado_State_GPKG.zip returned Content-Length 304,886,201 and Last-Modified 12 Feb 2026 (the API reports 319,029,248 bytes). The zip contains TRAN_Colorado_State_GPKG.gpkg (894 MB uncompressed), an .xml metadata file and a .jpg. With `Origin` sent, S3 returned `Access-Control-Allow-Origin: *` and methods GET, HEAD. — [Colorado NTD GPKG zip](https://prd-tnm.s3.amazonaws.com/StagedProducts/Tran/GPKG/TRAN_Colorado_State_GPKG.zip)
- GeoPackage contents, verified with GDAL `ogrinfo` over `/vsizip//vsicurl/` on the Delaware package: Trans_AirportPoint, Trans_AirportRunway, Trans_RailFeature, Trans_RoadSegment, **Trans_TrailSegment (Measured Multi Line String)**, Meta_ProcessDetail, BPFeatureToMetadata and Meta_DatasetDetail. GDAL warned that CLIPPOLY is referenced in gpkg_contents but missing. — [Delaware NTD GPKG zip](https://prd-tnm.s3.amazonaws.com/StagedProducts/Tran/GPKG/TRAN_Delaware_State_GPKG.zip)
- USGS says NDT trails were "aggregated by the USGS over the past several years from predominantly authoritative sources". The project is "continuing to build the nationwide trails dataset". NDT is "part of the USGS National Transportation Database". Access is through the TNM Viewer and the Trails Explorer (https://apps.nationalmap.gov/trails-explorer/). — [USGS NDT Data & Tools](https://www.usgs.gov/national-digital-trails/data)
- 2024 highlights (published Jan 23, 2025): TRAILS (Trail Routing Analysis and Information Linkage System) gained improved route analysis and viewshed features. An Aug 19–20, 2024 Trail Data Aggregation Seminar had participants from 14 states, four federal agencies, OpenStreetMap and American Trails. — [NDT Highlights of 2024](https://www.usgs.gov/national-digital-trails-newsletter/national-digital-trails-project-highlights-2024)
- A search summary of the NDT newsletter pages cited "277,254 miles". I could not tie this to a dated page. — [NDT newsletter index](https://www.usgs.gov/national-digital-trails-newsletter)
- USGS Topo basemap (`basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer`): tile cache (singleFusedMapCache true), 24 LODs (0–23), ACAO `*`. Its copyright line lists the National Transportation Dataset and USFS road data among sources. — [USGSTopo MapServer](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer?f=json)
- USGS Topo trail rendering test at Brainard Lake / Indian Peaks, CO:
  - Tiles fetched: `/tile/{z}/{y}/{x}` at z11–16, JPEG, ACAO `*`.
  - The z13 tile (1693/3098) intersects 23 NDT trail features, including USFS Mitchell Lake, Mount Audubon, Beaver Creek and South Saint Vrain. It showed no trail symbology.
  - The z14 child tile (3386/6197) showed the brown dashed Mitchell Lake trail with its label.
  - I viewed the tiles myself. — [USGSTopo tile z14](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/14/6197/3386); [z13](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/13/3098/1693)
- A TNM transportation `export` of layer 37 only (`layers=show:37`, png32, transparent, z14 bbox) returned a 6 KB PNG with orange dashed trail lines and ACAO `*`. This is usable as a live MapLibre raster overlay at any zoom. — [TNM transportation export](https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/export)

### Inferences
- **Recommended ingest pattern.** Use NDT per-state GeoPackages for western states (CO, UT, CA, WA, NV, ID and so on) as the source of non-federal trails, with a filter such as `sourceoriginator NOT IN ('U.S. Forest Service','Bureau of Land Management','National Park Service','U.S. Fish and Wildlife Service')`. Take federal trails directly from the fresher agency sources (Q1, Q2). NDT's USFS copy is as of 03/2026, while EDW refreshes weekly.
- **State gaps.** For OR, MT, AZ, NM and WY, NDT adds essentially nothing beyond federal data. There, OSM is the only broad source of non-federal trails.
- **Routing.** NDT's Y/N use flags (hikerpedestrian, packsaddle, bicycle, ohv...) are uniform across all agencies. That makes NDT the easiest single schema for a crew-walking cost model. `routetype` includes "Road" rows, for example CPW's "Brainard Lake Road", so filter or type them.
- **Freshness.** The live service is fresher than the state downloads: loaddate reaches 2026-05-20 and the copyright says "Refreshed July, 2026", against Feb 2026 downloads. The worker could instead page layer 37 with a bbox or state filter via GDAL. At about 590k features, that is roughly 300 requests of 2,000 each.
- **USGS Topo.** If it is ever used as a basemap, trails appear only from z14. Trail visibility at z10–13 would need the app's own overlay.

### Gaps
- USGS does not publish (in what I read) an NDT completeness map or percentage by state for 2025–2026. NDT newsletters for 2025 were not found.
- The refresh cadence of the TNM staged downloads is not documented. Only observed: the Feb 2026 vintage and a service refresh in July 2026.
- The meaning of `networklength`, and whether NDT is noded for routing (TRAILS does routing), is not verified.
- The USGS Topo zoom threshold was verified at one location only. Other areas or trail types (for example national scenic trails) may differ.
- I did not check whether basemap.nationalmap.gov offers any vector-tile basemap with trails.

## Q4. State trail aggregations in western fire country (brief)

### Takeaway
Only Colorado (COTREX), Utah (UGRC) and Washington (RCO Trails Database) have clearly identified statewide aggregations with public ArcGIS endpoints or downloads; Idaho has an IDPR service with a restrictive license. Colorado's and Utah's are also partly inside NDT. Licenses are disclaimers rather than open licenses, except Idaho, which forbids commercial use and requires attribution. For Oregon, California (statewide), Montana, Arizona and New Mexico I found no verified statewide trail aggregation.

### Cited Findings
- Colorado (COTREX):
  - Service: CPWAdminData FeatureServer layer 15 "COTREX Trails", 83,008 segments, data last edited 2026-08-27, ACAO `*`, maxRecordCount 2000.
  - Fields: name, trail_num, surface, oneway, type, hiking, horse, bike, motorcycle, atv, ohv_gt_50, highway_ve, dogs, access, min/max elevation, length_mi_, manager, snowmobile, ski, snowshoe, plowed, groomed, seasonality fields, url.
  — [COTREX Trails layer](https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/ArcGIS/rest/services/CPWAdminData/FeatureServer/15?f=json)
- COTREX license and download: "This map is a product and property of the Colorado Parks and Wildlife, a division of the Colorado Department of Natural Resources. Care should be taken in interpreting these data..." CPW also publishes a "CPW Trails Shapefile Download" item. — [ArcGIS search, CPW items](https://www.arcgis.com/sharing/rest/search?q=COTREX%20owner:rsaccoCPW&f=json)
- Utah (UGRC "Utah Trails and Pathways"):
  - Service: TrailsAndPathways FeatureServer layer 0, 48,132 features, data last edited 2026-09-18, ACAO `*`.
  - Fields: PrimaryName, Status, DesignatedUses, SurfaceType, Class, HorseAllowed, MotorizedAllowed, HikeDifficulty, BikeDifficulty, ADAAccessible, OwnerSteward, SystemName, TransNetwork, DataSource.
  - Item text: "Last Update: 08/5/2026"; "This map layer features many of Utah's recreational trails but is not yet complete."
  - License: data provided "as is" and "as available"... "for informational purposes only".
  — [UGRC TrailsAndPathways](https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/TrailsAndPathways/FeatureServer/0?f=json); [ArcGIS item 3080c0a2…](https://www.arcgis.com/sharing/rest/content/items/3080c0a2859a4d23a279e17e17c703c8?f=json)
- Washington (RCO Trails Database):
  - Version 2.0 was published April 15, 2025 and covers "over 22,000 miles of trails". It is compiled from data submitted by state and local agencies and partners.
  - Downloads are available through geo.wa.gov and the Trails Database Hub.
  - Disclaimer: "not intended to be used for route-finding or navigation."
  — [WA RCO Trails Database Public View](https://geo.wa.gov/datasets/wa-rco::wa-rco-trails-database-public-view); [WA RCO Trails Hub data download](https://trails-wa-rco.hub.arcgis.com/pages/data-download)
- Idaho (IDPR "Idaho Recreation Trails" hosted services, modified 2026-07-27). License: "Not for commercial use and may not be used in 3rd party apps without source attribution. Contact IDPR for Schema information..." — [ArcGIS search, Idaho Recreation Trails](https://www.arcgis.com/sharing/rest/search?q=title:%22Idaho%20Recreation%20Trails%22&f=json); [service](https://services1.arcgis.com/CNPdEkvnGl65jCX8/arcgis/rest/services/Idaho_Recreation_Trails/FeatureServer)
- Oregon: searches found only the general portals (Oregon GEOHub, Oregon Spatial Data Library), not a statewide trail layer. — [Oregon GEOHub](https://geohub.oregon.gov/); [Oregon Spatial Data Library](https://spatialdata.oregonexplorer.info/)
- Inside NDT (Q3), the western state sources are CPW, Utah AGRC, CA State Parks, CA Coastal Commission, WA State Parks, Nevada DCNR and Idaho IDPR (400 segments). — [Trails layer 37 query](https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37/query)

### Inferences
- **Colorado:** COTREX's live service (Aug 2026) is much fresher than NDT's CPW copy (10/2023). Its per-mode flags (hiking/horse/bike/motorcycle/atv/ohv_gt_50) are routing-ready.
- **Utah:** UGRC is similarly fresher than NDT's copy.
- **Washington:** RCO data is mostly urban and regional multi-use trails, and carries an explicit "not for navigation" disclaimer. Low priority.
- **Idaho:** the IDPR license ("third-party apps ... attribution", "not for commercial use") needs owner review before ingest.

### Gaps
- No verified statewide trail aggregation for Oregon, California, Montana, Arizona or New Mexico. California appears only through State Parks and the Coastal Commission in NDT.
- Terms for COTREX (CPW) redistribution in a third-party app were not found explicitly. The license text is a disclaimer/ownership notice, not a grant.
- Update cadences of the state services are not documented; only last-edit dates were observed.

## Q5. Wildfire-incident line data: NIFS Event Line / Event Point, public availability, and ftp.wildfire.gov conventions

### Takeaway
Current-season NIFS event lines and points (dozer, hand and road-as-line; drop points, helispots, safety zones) are **restricted**: they need a NIFC ArcGIS Online account or EGP cooperator access. Since May 4, 2026, the FTP's `incident_specific_data` tree (which held incident geodatabases) sits behind FAMAuth at `/protected/`. What is public:
1. NIFC's yearly **Operational Data Archive** FeatureServers and FGDBs for 2018–2025, published about late January for the prior season, with ACAO `*`. The 2025 archive has 392,216 Event_Line and 208,380 Event_Point records, counting every edit version.
2. The FTP's public `incident_specific_maps` tree, which holds mostly PDFs plus IR KMZ, shapefile and GDB zips, but no event geodatabases.

### Cited Findings
**Public NIFC archives (tested 2026-09-24)**
- The NIFC org (services3.arcgis.com/T4QMspbfLg3qTGWY, 618 services, ACAO `*`) hosts public FeatureServers named `Operational_Data_Archive_2022`, `_2023`, `_2024` and `_2025`, plus `2019_NIFS_OpenData` and `National_Incident_Feature_Service_2018`. — [NIFC org services](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services?f=json)
- Operational_Data_Archive_2025 layers: 2 Event_Point (208,380), 4 Event_Line (392,216), 5 Perimeter_Line (60,463), 6 Event_Polygon (116,532). maxRecordCount 2000, pagination supported, JSON/geoJSON/PBF, ACAO `*`. Layer names differ by year: the 2022 archive uses EventPoint2022, EventLine2022 (176,760), PerimeterLine2022 and EventPolygon2022. — [Operational_Data_Archive_2025](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/Operational_Data_Archive_2025/FeatureServer?f=json); [Operational_Data_Archive_2022](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/Operational_Data_Archive_2022/FeatureServer?f=json)
- Item description: "This is an export of the data archived from the 2025 National Incident Feature Service. Sensitive fields and features have been removed. Each edit to a feature is captured in the Archive. The GDB_FROM and GDB_TO fields show the date range that the feature existed..." The service is based on the NWCG Wildland Fire Event data standard. License: "The National Interagency Fire Center shall not be held liable for improper or incorrect use of the data..." The Feature Service item was created 2026-01-29. — [ArcGIS item 894926a4…](https://www.arcgis.com/sharing/rest/content/items/894926a4714949259b7e6c230be36372?f=json)
- The 2025 File Geodatabase item is 770,234,920 bytes, created 2026-01-30. Its description says "2024", apparently a copy-paste error. Earlier archive creation dates: 2024 archive 2025-01-15; 2023 archive 2024-01-22; 2022 archive 2023-01-04. FGDB items exist for 2018–2025. — [ArcGIS item 0badddd4…](https://www.arcgis.com/sharing/rest/content/items/0badddd4550a4670b16b3a4b3e551476?f=json); [ArcGIS search "Operational Data Archive"](https://www.arcgis.com/sharing/rest/search?q=title:%22Operational%20Data%20Archive%22%20orgid:T4QMspbfLg3qTGWY&f=json)
- Event_Line fields: GDB_FROM_DATE, GDB_TO_DATE, SourceOID, SourceGlobalID, IncidentName, FeatureCategory, MapMethod, Comments, Label, StrategicLineType, RepairStatus, RepairsNeeded, RepairComments, RepairPriority, ArchClearance, DeleteThis, FeatureAccess, FeatureStatus, IsVisible, LineDateTime, CreateDate, DateCurrent, LengthFeet, LineWidthFeet, IRWINID, CpxName, GISS_Misc, GISS_Misc2 and GlobalID. Event_Point adds PointName, PointDateTime, ElevationFeet, LatWGS84_DDM, LongWGS84_DDM and Angle. — [Event_Line layer 4](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/Operational_Data_Archive_2025/FeatureServer/4?f=json)
- 2025 Event_Line FeatureCategory counts, including every edit version:
  - Completed Dozer Line: 155,361
  - Completed Hand Line: 51,246
  - Completed Road as Line: 40,752
  - Access Route: 40,547
  - Fire Edge (Field Collection): 14,103
  - Planned Dozer Line: 12,821
  - Planned Road as Line: 12,095
  - Proposed Line: 11,656
  - Road Repair: 9,831
  - Completed Mixed Construction Line: 8,916
  - Highlighted Feature: 7,052
  - Planned Hand Line: 5,272
  - Completed Fuel Break: 4,814
  - Retardant Drop: 3,845
  - Fence: 3,811
  - Planned Mixed Construction Line: 3,305
  - Completed Burnout: 2,125
  - Aerial Hazard: 2,029
  - Planned Fuel Break: 1,263
  - Completed Plow Line: 561
  - Planned Burnout: 547
  - Planned Plow Line: 245
  — [Event_Line layer 4 query](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/Operational_Data_Archive_2025/FeatureServer/4/query)
- 2025 Event_Point FeatureCategory counts:
  - Drop Point: 26,966
  - Dozer Push: 20,100
  - Hazard: 18,440
  - Helispot: 18,422
  - Hot Spot - Spot Fire: 18,138
  - Road Repair: 11,968
  - Culvert: 11,653
  - Fence - Cut/Damaged: 11,124
  - Slash Pile: 9,853
  - Division Break: 7,296
  - Draft Site: 7,179
  - Stream Crossing: 7,042
  - Hazard Tree: 5,892
  - Dip Site: 4,207
  - Hydrant: 3,493
  - Staging Area: 3,274
  - Sling Site: 2,685
  - Lookout: 2,673
  - Bridge: 2,500
  - Unimproved Landing Area: 1,903
  - Camp: 1,660
  - Incident Command Post: 1,468
  - Safety Zone: 1,107
  - Helibase: 686
  - Water Source: 33
  — [Event_Point layer 2 query](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/Operational_Data_Archive_2025/FeatureServer/2/query)
- Versioning and visibility fields (2025 Event_Line):
  - DeleteThis: No 378,983; "Yes - No Longer Needed" 9,960; "Yes - Editing Mistake" 2,963.
  - FeatureAccess: Cooperators 380,844; Public 5,782; Incident 5,281; Restricted 70.
  - FeatureStatus: Approved 299,996; Proposed 62,201; Archive 23,965; In Review 5,895.
  - IsVisible: Yes 382,116; No 9,822.
  - GDB_TO_DATE is set on 348,713 rows (range 2024-12-17 to 2026-01-02). The remaining 43,503 rows have no GDB_TO_DATE.
  — [Event_Line layer 4 query](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/Operational_Data_Archive_2025/FeatureServer/4/query)
- Other public NIFC-org line layers:
  - `NWCC_Fire_Line_History`: 46,180 historical fire lines for the NW Coordination Center area, last edited 2026-06-08, described as "a work in progress and will be updated as new lines are discovered".
  - `NV_BLM_Potential_Control_Lines_view`: 1,240 lines, last edited 2025-05-13.
  - `NWCC_Operational_Layers_view`: current points and polygons only, no event lines.
  - All return ACAO `*`.
  — [NWCC_Fire_Line_History](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/NWCC_Fire_Line_History/FeatureServer?f=json); [NV_BLM_Potential_Control_Lines_view](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/NV_BLM_Potential_Control_Lines_view/FeatureServer?f=json); [NWCC_Operational_Layers_view](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/NWCC_Operational_Layers_view/FeatureServer?f=json)

**Restricted current-season NIFS**
- NIFS and its supplemental services "are available to wildland fire cooperators with a NIFC AGOL account". Editing requires a NIFC Org account. EGP viewers give cooperators view-only access. "Only features with FeatureStatus = Approved and FeatureAccess = Public or Cooperators will be visible in the EGP." This is from a search-result summary of NWCG and EGP pages; the NWCG site blocked automated fetches with a bot check, so I did not read them directly. — [NWCG National Incident Feature Services](https://www.nwcg.gov/publications/pms936/event-geodatabase-national-incident-feature-services); [EGP Data](https://portal.wildfire.gov/egp/data/)
- NWCG: the Event GDB "was approved by the NWCG's Geospatial Subcommittee in the spring of 2017 along with the NWCG Wildland Fire Event Point, Event Line, and Event Polygon Data Standards" and is used "in all phases of a wildfire incident including initial attack, extended fire management activities, and rehabilitation and repair". — [NWCG Event Geodatabase](https://www.nwcg.gov/publications/pms936/event-geodatabase)
- NWCG symbology lists "Completed Dozer Line" as an Event Line feature in symbol category "Line", subcategory "Ops Completed". There are also "Completed Road as Line" and "Completed Line" pages. — [NWCG Completed Dozer Line](https://www.nwcg.gov/symbology/line/completed-dozer-line); [Completed Road as Line](https://www.nwcg.gov/symbology/line/completed-road-line)

**FTP (ftp.wildfire.gov) conventions, 2026**
- The NIFC File Share root page says: "Authenticated Access area of the NIFC File Share requires authentication via FAMAuth as of May 4, 2026". "https://ftp.wildfire.gov/public/incident_specific_data changed to https://ftp.wildfire.gov/protected/incident_specific_data". "The path for the Incident Specific Maps folder has not changed". The public area "does not require authentication and is intended for public available files such as maps". All posted information must be "non-sensitive, unclassified, not copyrighted". — [NIFC File Share](https://ftp.wildfire.gov/)
- `https://ftp.wildfire.gov/public/` now lists only `incident_specific_maps/`. The old `/public/incident_specific_data/` returns 404. GACC folders: alaska, calif_n, calif_s, california_statewide, eastern, great_basin, n_rockies, pacific_nw, rocky_mtn, southern, southwest. Directory listings carry no ACAO header. — [FTP /public/](https://ftp.wildfire.gov/public/); [FTP incident_specific_maps](https://ftp.wildfire.gov/public/incident_specific_maps/)
- Structure observed by crawling about 570 directory listings of 2026 folders:
  - Paths are `<gacc>/2026/2026_<Incident>/` or `pacific_nw/2026_Incidents_Oregon/2026_<Incident>/`.
  - Subfolders: `IR/`, `Products/`, `QR/`, and sometimes `GIS/`. Each holds `YYYYMMDD/` dated folders, occasionally with suffixes such as `20260718_Day/` or `_Night/`.
  - IR files look like `20260807_Bobcat_IR.kmz`, `..._IR_ShapeFileOutputs.zip` and `20260806_2025_Bobcat_IR.gdb.zip`.
  - The `GIS/` folders I opened held only dated PDF map products, following PMS 936 names, for example `ops_ansi_e_land_20260713_1547_Elephant_CATNF001154_0713day.pdf`.
  - File-type totals: roughly 1,300 PDFs, 118 zips, 72 KMZs and a few loose FGDB parts. No incident event geodatabases were found.
  — [e.g., 2026_Elk incident folder](https://ftp.wildfire.gov/public/incident_specific_maps/rocky_mtn/2026/2026_Elk/); [2026_Elephant GIS folder](https://ftp.wildfire.gov/public/incident_specific_maps/calif_n/2026/2026_Elephant/GIS/)
- PMS 936 incident directory structure: `incident_data` ("data created on or for the incident") with `edit` (Offline Copy mobile geodatabase) and `backups` (time-stamped incident GDB backups), plus `base_data`, `products` and `tools`. "Folder names must not contain spaces, special characters, or periods" (underscore only). — [NWCG Directory Structure](https://www.nwcg.gov/publications/pms936/directory-structure); [NWCG Implement the Incident Directory Structure](https://www.nwcg.gov/publications/pms936-1/implement-the-incident-directory-structure)

### Inferences
- **Worker ingest.** Pull the Operational Data Archives once a year (late January) via GDAL paging, or download the FGDB item (770 MB for 2025).
  - Build the final-state lines by keeping one row per SourceGlobalID with the latest GDB_FROM_DATE. The rows without GDB_TO_DATE are probably the versions current at export; this is unverified.
  - Then filter `DeleteThis='No'`, `IsVisible='Yes'` and FeatureStatus Approved/Archive, and keep the "Completed …" categories.
  - The result is a "historical firelines" layer (old dozer, hand and plow lines, fuel breaks, road-as-line). Crews value it for contingency planning and cross-country access.
- **No live event data.** The public archives carry nothing for the active season, so current-season event lines cannot legitimately reach the app from public sources. Only PDFs, IR KMZ and shapefiles on incident_specific_maps are public, and the existing worker already mirrors those.
- **FTP mirror.** Any worker code still pointing at `/public/incident_specific_data/` will 404 after May 4, 2026. The repo's worker already uses `/public/incident_specific_maps/`.
- **Sensitivity.** Most archived features are flagged FeatureAccess "Cooperators", not "Public", even though NIFC published them after removing sensitive features. Showing them in a public web map is presumably permitted by NIFC's open-data release, but the owner may want to label them "historical, may be rehabilitated".

### Gaps
- I could not read the NWCG data-standard pages for the authoritative Event Line/Point FeatureCategory domain lists (bot check). The category lists above are the values actually present in the 2025 archive.
- Whether the rows with null GDB_TO_DATE are exactly the final versions, and what exactly "Sensitive fields and features have been removed" covers, are unverified.
- I did not verify whether any GACC or state publishes current-season public event-line views beyond the NWCC and NV layers noted.
- The FTP crawl was a sample, not exhaustive. Some incidents may post IncidentData exports to the public maps tree.

## Q6. Completeness/accuracy comparisons among these datasets and versus OpenStreetMap (US national forests, BLM land)

### Takeaway
I found no peer-reviewed quantitative comparison of OSM versus USFS, BLM or NDT trail and road completeness for western public lands. The best evidence is practitioner work (OSM Merge / OSM US) and my own cross-dataset counts:
- Agency data is authoritative for designation, legal use and class, but carries reference-number inconsistencies, stale condition data and many unpopulated attributes.
- OSM often inherits old TIGER/USFS geometry and misses attributes, but can be more current on physical closures.
- NDT's federal content lags the agencies by months, and some state sources by years.

### Cited Findings
- OSM Merge, an OpenStreetMap US community project, conflates "rural road and trail data from ... the US Forest Service, the National Parks Service, as well as state and local governments" with OSM, because much remote road and trail data "comes from the TIGER import in 2007 and 2008, and hasn't been reviewed or updated since". — [OSM US: Welcome OSM Merge (Nov 2024)](https://openstreetmap.us/news/2024/11/welcome-osmmerge/); [osm-merge docs](https://osm-merge.github.io/osm-merge/highways/)
- osm-merge documentation:
  - "the geometry in OSM was from the same USDA datasets at some point in the past."
  - "all of the datasets have issues with some features lacking a geometry."
  - MVUM reference numbers often contain "an additional number (often 5 or 7) prefixed to the actual number" and "many highways with a .1 suffix, which some street signs don't display."
  - TIGER data is "often inaccurate".
  — [osm-merge Highways](https://osm-merge.github.io/osm-merge/highways/)
- OSM Merge "Ground-Truthing MVUM Highways" (Rob Savoye's field write-up, undated, after SOTM-US 2024). Observations:
  - Agency data inconsistencies seem "related to the age of the data".
  - Surface and smoothness tags in the USDA data were "reasonably accurate".
  - "some roads stopped being maintained a long time ago", so OSM "is probably more up to date on the highway condition".
  - Many remote OSM features are "only tagged with highway=track".
  - Recent closures, such as a road dug up by a backhoe, appear in OSM but in no agency dataset.
  - "The recent release of vector map tile sets appears to be correct and accurate, but isn't in a usable format." The BLM S1 Mobile app "uses the latest vector tile package".
  - "many government agencies have been shifting to ArcGIS Online, where the data is viewable, but you can't download it anymore."
  - The stated motivation is firefighters from out of state who depend on OSM-based apps.
  — [OSM Merge: Ground-Truthing MVUM Highways (PDF)](https://osmmerge.org/tech/routt.pdf)
- USGS highlights OSM US's Trails Stewardship Initiative. A search summary of the TSI and USGS pages states that "a single, digital, authoritative trail dataset does not exist in the US", so many navigation apps (AllTrails, CalTopo, Gaia GPS, onX and others) rely on OSM. It also says the TSI Trails Working Group, formed in Dec 2021, includes NPS and USFS representatives. I did not read the pages directly. — [USGS: OSM US Trails Stewardship Initiative](https://www.usgs.gov/national-digital-trails/through-its-trails-stewardship-initiative-openstreetmap-us-leading-efforts); [OSM US Trails Stewardship Initiative](https://openstreetmap.us/our-work/trails/); [OSM wiki TSI](https://wiki.openstreetmap.org/wiki/Organised_Editing/Activities/Trails_Stewardship_Initiative)
- Peer-reviewed literature found concerns urban bicycle facilities (Hochmair et al., 2015) or county-level road completeness (a 2025 paper indexed in PubMed that I could not open), not backcountry trails. — [Hochmair et al. (ResearchGate)](https://www.researchgate.net/publication/264710596_Assessing_the_Completeness_of_Bicycle_Trail_and_Lane_Features_in_OpenStreetMap_for_the_United_States); [PubMed 41000462](https://pubmed.ncbi.nlm.nih.gov/41000462/)
- Cross-dataset consistency I measured:
  - USFS trail miles in EDW (about 145,500 mi) match NDT's USFS-originated miles (143,697 mi).
  - The EDW and NDT exports draw the same Mitchell Lake geometry at z14, so NDT reuses agency geometry.
  - EDW grew from 83,282 features (May 2025 metadata) to 86,417 (Sep 2026).
  - NDT's CPW data is from 10/2023, while the COTREX service was edited 2026-08-27.
  — [Trail layer query](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query); [NDT Trails query](https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37/query); [TrailNFS metadata](https://data.fs.usda.gov/geodata/edw/edw_resources/meta/S_USA.TrailNFS_Publish.xml)
- Attribute completeness gaps in the authoritative data:
  - USFS: 12% of trail miles are centerline-only, with no class or use data.
  - NPS: 47% of TRLCLASS values and about 29% of TRLUSE values are "Unknown".
  - MVUM: the seasonal-field inconsistencies documented in Q1.
  — [Trail layer query](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query); [NPS layer query](https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/MapServer/0/query)

### Inferences
- **Coverage.** For national forests and BLM land, the agency datasets (EDW trails, roads and MVUM; BLM GTLF) should be the designation and legal-use layer, and OSM the physical-network and gap-filling layer. The current Valhalla pedestrian router sees only OSM, which lacks agency class, use and seasonal restrictions. Agency data lacks non-system user-created trails, which OSM often has.
- **Condition.** Neither source reliably represents current passability. Agency maintenance levels can be stale, and OSM closures depend on local mappers. The UI should present road condition attributes as "designed/maintained for", not "currently passable".
- **Licensing.** Federal agency data appears unrestricted apart from disclaimers (USFS Access Constraints "None"; USGS "public domain"). It can be mixed with OSM (ODbL) in a derived routing graph only if ODbL share-alike obligations for the derived database are respected. This is a legal consideration, not verified here.

### Gaps
- No quantitative study (percent completeness, positional error in metres) comparing OSM against USFS, BLM or NDT trails for western public lands was found.
- A dataset-level OSM versus EDW/GTLF mileage comparison for a sample forest was not performed; it would need an OSM extract.
- The date and full contents of the OSM Merge ground-truthing write-up are unverified; the PDF is largely images plus text.
