# Off-trail (cross-country) foot travel time for wildland firefighters: travel-rate science, fire-specific data products, and tools (US, current to Sept 2026)

Context for the report writer: the consumer is Responder Debrief (incibrief.com). It is a static MapLibre and React site with a Python/GDAL worker on GitHub Actions and static files on Backblaze B2. Its Walk mode today uses openrouteservice foot-hiking or FOSSGIS Valhalla pedestrian (`frontend/src/api/routing.ts`). Those engines give generic walking times with no firefighter or cross-country modeling. Throughout, "computed" means I evaluated a published equation myself. Such values are not quoted from the papers, except where the papers report the same numbers (noted where they do).

## Q1. Travel-rate functions vs slope (Tobler, Naismith/Langmuir, Campbell/Dennison/Butler line of work), vegetation and roughness effects, on- vs off-trail, and follow-up through 2026

### Takeaway
All the classic functions (Tobler, Naismith/Langmuir) and the firefighter-specific ones share the same basic shape. Speed peaks on a slight downhill of about −1.5° to −3° and falls off on both sides.
- **On trails with packs**, the best-calibrated option is Sullivan et al. (2020). It fits a Lorentz function by quantile regression to GPS tracks of hotshot crews carrying about 50 lb. Its low, moderate and high tertiles work out to about 17, 12 and 10 min per flat km.
- **Off trail**, the evidence says vegetation density is the largest penalty, bigger than slope over short distances, with ground roughness also mattering. Campbell et al. (2017) show this, and the 2024 STRIDE model generalizes it. STRIDE is one on/off-path model that divides a Lorentz slope term by (1 + 15.265·density + 16.505·roughness).
- **Least-cost paths** timed with STRIDE took on average 1.5× longer than slope-only estimates.
- **A 2026 random-forest follow-up** exists (Cutler et al.), but its numbers were not retrievable.

### Cited Findings

**Classic functions (as reproduced in Campbell et al. 2019, Applied Geography 106:93–107)**
- Tobler's hiking function (THF) is v = 1.6̄ × exp(−3.5 × |tan θ + 0.05|) in m/s, with θ the slope. It was derived from Imhof (1950) data and peaks at −2.86°. On flat ground THF gives 1.39 m/s and Naismith gives 1.40 m/s. — [Campbell et al. 2019 (RMRS PDF)](https://www.fs.usda.gov/rm/pubs_journals/2019/rmrs_2019_campbell_m001.pdf)
- Tobler's own 1993 NCGIA report says his hiking function (its "Figure II") was "estimated from empirical data given by Imhof (1950, pp 217-220)". It is meant for minimum-time path computation over an elevation matrix. — [Tobler 1993, NCGIA TR 93-1 (eScholarship)](https://escholarship.org/uc/item/05r820mz)
- Tobler's off-path adjustment is a 3/5 multiplier on the on-path speed. — [Wikipedia: Tobler's hiking function](https://en.wikipedia.org/wiki/Tobler%27s_hiking_function) (secondary). The 3/5 value is not in the extracted report text; it is presumably in the figure, so I could not verify it in the primary PDF (see Gaps).
- The STRIDE authors note that past work handled off-path travel by "lumping the vast diversity of landscape characteristics into a single multiplier". They cite Tobler and Irmischer & Clarke 2018 for that, and others for "a small number of fixed multipliers specific to broad land cover categories". — [Campbell, Cutler & Dennison 2024, Sci. Rep. (Europe PMC full text)](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11399398/fullTextXML)
- **Naismith (1892):** 1 h per 3 horizontal miles plus 1 h per 2,000 ft of ascent. As a function this is v = 1/(0.72 + 6·tan θ) in m/s, and it says nothing about descents. — [Campbell et al. 2019](https://www.fs.usda.gov/rm/pubs_journals/2019/rmrs_2019_campbell_m001.pdf)
- **Langmuir (1984) corrections:**
  - steep descents (θ ≤ −12°): v = 1/(0.72 − 2·tan θ)
  - moderate descents (−12° < θ ≤ −5°): v = 1/(0.72 + 2·tan θ)
  - Campbell et al. call the result counter-intuitive: fastest at −12° (3.39 m/s), then dropping to 0.87 m/s at −12.1°.
  - GRASS r.walk implements the Langmuir-corrected Naismith rule.
  - [Campbell et al. 2019](https://www.fs.usda.gov/rm/pubs_journals/2019/rmrs_2019_campbell_m001.pdf)
- **Irmischer & Clarke (2018):** 200 US Military Academy cadets, Gaussian fit v = 0.11 + exp(−(100·tan θ + 5)²/1800). — [Campbell et al. 2019](https://www.fs.usda.gov/rm/pubs_journals/2019/rmrs_2019_campbell_m001.pdf); [Irmischer & Clarke 2018, CaGIS 45:177–186 (metadata)](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1080/15230406.2017.1292150)

**Campbell, Dennison & Butler 2017, IJWF 26(10):884–895 — LiDAR vegetation density and roughness, off-trail**
- Study site: Levan Wildland Management Area, Utah (grass, sagebrush, Utah juniper), with lidar at 11.93 pts/m². — [Campbell et al. 2017 (reprint PDF)](https://content.csbs.utah.edu/~pdennison/reprints/denn/2017_Campbell_etal_IJWF.pdf); [DOI 10.1071/WF17031](https://doi.org/10.1071/WF17031)
- Design: 31 participants, none of them firefighters. Mean age 27, 39% female, no firefighting gear. They walked twenty-two 100 m transects in both directions, for 1,276 timed walks. — [same](https://content.csbs.utah.edu/~pdennison/reprints/denn/2017_Campbell_etal_IJWF.pdf)
- Metric definitions: [same](https://content.csbs.utah.edu/~pdennison/reprints/denn/2017_Campbell_etal_IJWF.pdf)
  - Vegetation density is lidar normalized relative point density (NRD) for 0.15–2.75 m, the best of all height ranges tested (R²m 0.54, R²c 0.84).
  - Roughness is the mean absolute difference between a 0.25 m DTM and its 2.5 m-radius focal mean, within a 5 m transect buffer.
  - Slope comes from a 1 m DTM.
- The fitted mixed model (R²m = 0.59, R²c = 0.82) is: [same](https://content.csbs.utah.edu/~pdennison/reprints/denn/2017_Campbell_etal_IJWF.pdf)
  - travel rate (m/s) = 1.662 − 1.076·density − 9.011·roughness − 5.191×10⁻³·slope − 1.127×10⁻³·slope²
  - slope is in signed degrees; density is NRD 0–1; roughness is in metres
  - standardized betas: density 0.551, slope² 0.263, roughness 0.171, slope 0.168 (all p < 0.001)
- The fastest speed is 1.67 m/s at −2.3°. — [Campbell et al. 2019](https://www.fs.usda.gov/rm/pubs_journals/2019/rmrs_2019_campbell_m001.pdf)
- The maximum sampled slope was under 15°, so steeper slopes are extrapolated. The quadratic reaches zero speed above about 36° and below about −40°. — [Campbell et al. 2017](https://content.csbs.utah.edu/~pdennison/reprints/denn/2017_Campbell_etal_IJWF.pdf)
- The authors caution that "estimating travel rates should be done with great caution" in a dangerous fire environment. — [same](https://content.csbs.utah.edu/~pdennison/reprints/denn/2017_Campbell_etal_IJWF.pdf)
- The model does not encode trail or road access. Alexander et al. (2005) found that improved trails (flagged, cleared of brush) significantly reduced escape-route travel time. A clear trail in smoke may beat the "optimal" route. — [same](https://content.csbs.utah.edu/~pdennison/reprints/denn/2017_Campbell_etal_IJWF.pdf)
- Application: coefficients were rasterized at 5 m and routed with R gdistance (8-neighbour, Dijkstra). One simulated escape route: straight line 941.5 m, route 1,038.9 m, 969.6 s. — [same](https://content.csbs.utah.edu/~pdennison/reprints/denn/2017_Campbell_etal_IJWF.pdf)
- The paper also lists Soule & Goldman (1972) / Pandolf terrain energy-cost factors: blacktop 1.0, dirt road 1.1, light brush 1.2, heavy brush 1.5, loose sand 2.1, soft snow 2.5. Categorical factors like these have been used for tsunami evacuation modeling (Schmidtlein & Wood 2015). — [same](https://content.csbs.utah.edu/~pdennison/reprints/denn/2017_Campbell_etal_IJWF.pdf)

**Campbell, Dennison, Butler & Page 2019, Applied Geography 106:93–107 — crowdsourced (Strava) slope vs travel rate**
- Data: Strava Metro, 29,928 people and 421,247 hikes, jogs and runs on natural-surface trails around Salt Lake City (2016 to June 2017). Slope came from a 2 m lidar DTM, and slopes above 30° were excluded. — [Campbell et al. 2019](https://www.fs.usda.gov/rm/pubs_journals/2019/rmrs_2019_campbell_m001.pdf)
- They fit Laplace, Gauss and Lorentz forms for percentiles 1st, 5th to 95th by 5, and 99th. The Lorentz form is v = c·[1/(π·b·(1 + ((θ − a)/b)²))] + d + e·θ, where the linear e term captures uphill/downhill asymmetry. — [Campbell et al. 2019](https://www.fs.usda.gov/rm/pubs_journals/2019/rmrs_2019_campbell_m001.pdf); π term confirmed in [Sullivan et al. 2020 Eq. 4](https://www.fs.usda.gov/rm/pubs_journals/2020/rmrs_2020_sullivan_p001.pdf)
- Mean fit across percentiles: Lorentz R² 0.958, MAE 0.078 m/s; Laplace 0.953 / 0.088; Gauss 0.949 / 0.090. The authors recommend Lorentz. Peak-speed slope (a) runs from −1.41° to −4.00°. All e terms are negative, meaning uphill is slower than downhill. — [Campbell et al. 2019](https://www.fs.usda.gov/rm/pubs_journals/2019/rmrs_2019_campbell_m001.pdf)
- The per-percentile coefficients are only in the supplement. One set is published elsewhere: the Escape Route Index paper uses the Lorentz **5th percentile**, "recommended for simulating an average hiking pace", with a = −1.53, b = 14.04, c = 36.81, d = 0.32, e = −0.0027. — [Campbell, Page, Dennison & Butler 2019, Fire 2(3):40 (PDF)](https://mdpi-res.com/d_attachment/fire/fire-02-00040/article_deploy/fire-02-00040.pdf)
- Existing walking functions (Tobler, Naismith–Langmuir, Rees) resemble the low Strava percentiles; Irmischer & Clarke is closest to the 5th. Campbell 2017's short-transect model behaves like the ~45th percentile, which the authors attribute to 100 m transects having no fatigue. — [Campbell et al. 2019](https://www.fs.usda.gov/rm/pubs_journals/2019/rmrs_2019_campbell_m001.pdf)

**Campbell, Dennison & Thompson 2022, CEUS 97:101866 — variability in travel rates (AllTrails)**
- Nearly 2,000 AllTrails hikes on trails in Utah and California, modeled as slope-based percentile functions from the 2.5th to the 97.5th percentile. — [abstract via Semantic Scholar API](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1016/j.compenvurbsys.2022.101866); [DOI](https://doi.org/10.1016/j.compenvurbsys.2022.101866)
- The 50th percentile ("typical individual") improved on existing functions, and modeled percentiles predicted actual percentiles with <10% error. — [same](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1016/j.compenvurbsys.2022.101866)

**Campbell, Cutler & Dennison 2024, Scientific Reports 14 — STRIDE (single on/off-path model)**
- Model form, with coefficients (NLS): — [Campbell et al. 2024 (Europe PMC full text)](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11399398/fullTextXML); [DOI 10.1038/s41598-024-71359-6](https://doi.org/10.1038/s41598-024-71359-6)
  - travel rate (m/s) = [c · 1/(π·b·(1 + ((slope − a)/b)²))] / (1 + d·density + e·roughness)
  - a = −2.320, b = 26.315, c = 147.362, d = 15.265, e = 16.505
- Metric definitions: — [same](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11399398/fullTextXML)
  - Density is NRD in the 0.85–1.20 m band, roughly waist to chest. Bands from 0.45 to 1.70 m came within 2% error.
  - Roughness (m) is the mean absolute difference between the DTM and its focal mean with a 2 m radius.
  - Accuracy: cross-validated R² 0.806, RMSE 0.168 m/s (16% of the mean rate).
- The data come from three experiments: — [same](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11399398/fullTextXML)
  - Levan, UT, Sept 2016: up to 31 subjects, 22 transects.
  - Central Wasatch, Aug 2023: up to 9 subjects, 11 transects, "sparsely vegetated flat areas to very steep forested areas".
  - Salt Lake City, Jan 2024: 8 paved transects, 8 subjects.
- With no vegetation and median trail roughness, STRIDE was nearly identical to the 67.5th-percentile on-path crowdsourced function (R² 0.996). — [same](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11399398/fullTextXML)
- In a 6×6 km area around Alta, UT, STRIDE travel times averaged **1.5×** those from a slope-only model (the Campbell 2022 50th-percentile function). — [same](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11399398/fullTextXML)
- The authors say that because 100 m transects cause little fatigue, using STRIDE paths for travel-time estimates "would require that a scaling factor be added". Listed future work: fatigue, load carriage, more vegetation types, surface moisture. — [same](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11399398/fullTextXML)
- There is an open-source R package, `stride` (https://github.com/mickeycampbell/stride), with functions such as gen_dtm() and map_lcp(). It needs an airborne lidar point cloud. — [same](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11399398/fullTextXML)
- The GitHub API shows no license on the repo (license: null; last push 2024-06-28). — [GitHub API](https://api.github.com/repos/mickeycampbell/stride)
- Europe PMC metadata lists the article license as CC BY-NC-ND. — [Europe PMC XML](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11399398/fullTextXML)

**Cutler, Campbell, Brewer & Dennison 2026, GIScience & Remote Sensing 63(1):2626632**
- "Machine learning estimation of off-trail pedestrian travel rates using LiDAR-derived slope, vegetation, and surface roughness", published 2026-02-09. — [Crossref](https://api.crossref.org/works/10.1080/15481603.2026.2626632); [T&F](https://www.tandfonline.com/doi/full/10.1080/15481603.2026.2626632)
- It uses random forests on instantaneous (high-resolution trajectory) travel rates along off-path transects, calling this "the first known examination of instantaneous travel rates using random forests". Named applications include wildland firefighter safety. — [T&F search snippet](https://www.tandfonline.com/doi/full/10.1080/15481603.2026.2626632) (full text blocked; 403)

**Firefighter on-trail data:** see Q3 (Sullivan et al. 2020 hotshot GPS study).

### Inferences
- **Speed comparison, computed from the equations above.** Speeds are m/s; slopes are degrees (negative is downhill). My Sullivan "high" values give 16.1, 11.9, 9.9, 14.0 and 19.7 min/km at −30°, −15°, 0°, +15° and +30°. Those match the paper's Table 4 exactly, which validates the Lorentz implementation.

| Model | −30° | −15° | −5° | 0° | +5° | +15° | +30° |
|---|---|---|---|---|---|---|---|
| Tobler on-path | 0.263 | 0.777 | 1.462 | 1.399 | 1.030 | 0.548 | 0.185 |
| Tobler off-path ×0.6 | 0.158 | 0.466 | 0.877 | 0.839 | 0.618 | 0.329 | 0.111 |
| Naismith + Langmuir | 0.533 | 0.796 | 1.835 | 1.389 | 0.803 | 0.430 | 0.239 |
| Campbell 2017 (density 0, roughness 0) | 0.803 | 1.486 | 1.660 | 1.662 | 1.608 | 1.331 | 0.492 |
| Campbell 2019 Lorentz p5 (ERI parameters) | 0.564 | 0.795 | 1.120 | 1.145 | 0.993 | 0.629 | 0.377 |
| Sullivan 2020 low (with packs) | 0.334 | 0.759 | 0.966 | 0.961 | 0.881 | 0.624 | 0.322 |
| Sullivan 2020 moderate | 0.675 | 1.111 | 1.392 | 1.381 | 1.256 | 0.901 | 0.552 |
| Sullivan 2020 high | 1.035 | 1.403 | 1.684 | 1.680 | 1.552 | 1.190 | 0.847 |
| GET v2 isotropic slope term (Q2) | 0.441 | 0.808 | 1.097 | 1.149 | 1.097 | 0.808 | 0.441 |
| STRIDE, density 0, roughness 0.02 m | 0.636 | 1.088 | 1.326 | 1.330 | 1.244 | 0.935 | 0.534 |
| STRIDE, density 0.1, roughness 0.03 m | 0.280 | 0.479 | 0.584 | 0.585 | 0.548 | 0.412 | 0.235 |
| STRIDE, density 0.3, roughness 0.05 m | 0.132 | 0.226 | 0.275 | 0.276 | 0.258 | 0.194 | 0.111 |

- **The STRIDE density and roughness inputs in that table are illustrative guesses, not published typical values.** STRIDE is very sensitive to density. Going from 0 to 0.1 NRD in the 0.85–1.2 m band roughly halves speed. The denominator is multiplicative and unbounded, so a browser implementation needs lidar-quality density. LANDFIRE-type proxies would add large error.
- **Campbell 2017 density effect on flat ground (computed):** density 0.5 gives 1.124 m/s (−32%); density 1.0 gives 0.586 m/s (−65%).
- **Tobler's on-path peak overstates sustained speed.** It gives 1.40 m/s flat, about the same as the Sullivan moderate tertile with packs (1.38). Tobler falls off much faster than the firefighter curves on steep slopes: at +30° it gives 0.19 m/s, against 0.55 for Sullivan moderate and 0.32 for low. Tobler ×0.6 as a blanket off-trail factor is crude. The fire literature (GET v2, Alexander, STRIDE) implies penalties from about 1× (grass or trail) to 4–8× or more (dense timber or shrub plus slash), not a constant 1.67× time penalty.
- **Strava and crowdsourced percentiles include runners.** For a firefighter briefing tool, the defensible on-trail choices are the Sullivan 2020 tertiles, which are measured with loads and in groups. The Campbell 2022 / GET v2 50th percentile is a conservative "typical hiker" alternative.

### Gaps
- I could not verify the Tobler 3/5 off-path factor in the primary 1993 report text (it appears to be in a figure); it is cited here via Wikipedia.
- I did not retrieve the Campbell 2019 per-percentile Lorentz coefficient table (supplement) or the original asymmetric Campbell 2022 (CEUS) coefficients. Only the ERI p5 set and the GET v2 isotropic refit (Q2) were available.
- The Cutler et al. 2026 full text was inaccessible (HTTP 403), so its accuracy numbers, variable importance and any on/off-trail quantification are unknown.
- I found no retrievable Irmischer & Clarke (2018) off-road multiplier value.

## Q2. Escape-route and evacuation products: USFS RMRS/RMA layers (Ground Evacuation Time, SDI, PCL) and escape-route mapping tools (Dennison lab and others)

### Takeaway
**GET v2 (Estimated Ground Evacuation Time) is the most directly reusable national product.** It is a 30 m CONUS raster of hospital evacuation time that combines road driving with a documented off-road pedestrian cost model:
- an isotropic Lorentz slope function
- multipliers for vegetation, slash and streams
- impassable slopes above 45° and major water

The layer is served publicly as an ArcGIS ImageServer under a CC0 waiver, but only as five binned classes (0–1, 1–2, 2–4, 4–6, >6 h). SDI and PCL are RMA Dashboard layers (PCL is 30 m, western US, annual). The Dennison/Campbell lab has published an Escape Route Index method, the STRIDE R package (no license file) and the SSDE safety-zone web tool. I found no public, operational escape-route routing tool.

### Cited Findings

**Estimated Ground Evacuation Time v2 (Campbell, Gannon, Rahman, Stratton & Dennison 2024, Fire 7(8):292)**
- GET has been used for about a decade in CONUS strategic response planning. v2 updates the inputs and adds minor roads and trails, streams, woody debris, cliffs, and improved shrub handling. v2 generally gives slightly faster times than v1, with regional variation, and reported incident evacuation times were correlated with predictions. — [Crossref abstract](https://api.crossref.org/works/10.3390/fire7080292); [DOI](https://doi.org/10.3390/fire7080292)
- Hospitals: HIFLD hospitals with STATUS "OPEN" and TYPE "GENERAL ACUTE CARE" or "CRITICAL ACCESS", 5,136 in CONUS. — [GET v2 paper PDF](https://mdpi-res.com/d_attachment/fire/fire-07-00292/article_deploy/fire-07-00292.pdf)
- Roads: HERE 2020 roads via HIFLD, replacing NAVTEQ 2010.2. SpeedCat classes 1–8 map to 80/70/60/50/40/30/15/5 mph, converted to costs of 0.02796–0.44739 s/m and rasterized at 30 m. — [same](https://mdpi-res.com/d_attachment/fire/fire-07-00292/article_deploy/fire-07-00292.pdf)
- Method: reciprocal outward cost-distance from each hospital, accumulated up to 6 h, taking the per-pixel minimum across hospitals. Processing used Esri ArcGIS Pro 3.2.1. — [same](https://mdpi-res.com/d_attachment/fire/fire-07-00292/article_deploy/fire-07-00292.pdf)
- **Off-road slope term:** a symmetric refit of the Campbell et al. 2022 crowdsourced hiking data. The authors built an isotropic function because anisotropic cost accumulation is hard at CONUS scale. — [same](https://mdpi-res.com/d_attachment/fire/fire-07-00292/article_deploy/fire-07-00292.pdf)
  - r (m/s) = b·[1/(π·a·(1 + (s/a)²))] + c, with s in degrees, a = 22.4056, b = 77.6196, c = 0.0464
  - equivalently, r = (0.0065·s² + 80.8887)/(0.1402·s² + 70.3892), and cost = 1/r
  - slope source: LANDFIRE slope (2020 release), 30 m
- **Off-road multipliers**, which multiply together: — [same](https://mdpi-res.com/d_attachment/fire/fire-07-00292/article_deploy/fire-07-00292.pdf)
  - slope above 45° or major water: impassable
  - trails and minor roads from the USGS National Transportation Dataset (NTD): 1×
  - grass and non-burnable: 1×
  - shrub: 1× at 0% cover to 4× at 100% cover (continuous, from LANDFIRE EVC)
  - tree-dominated: 4×
  - LANDFIRE FBFM40 TL4, TL5 and TL7: an extra 2×
  - SB1–SB4 (slash and blowdown): an extra 5× in the table and the overview sentence, but "4×" in one sentence of the methods (internal inconsistency)
  - perennial streams from NHDPlus HR, rasterized at 30 m: an extra 5×
  - example: tree plus TL slash = 8× the slope-only cost
- Where no published travel-rate function existed, the multipliers came from expert opinion, "intended to be a conservative representation". — [same](https://mdpi-res.com/d_attachment/fire/fire-07-00292/article_deploy/fire-07-00292.pdf)
- **GET v1 (the WFDSS "Ground Medevac Time" layer)** used slope-class × land-cover speed tables in mph: — [ERI paper, Table 2](https://mdpi-res.com/d_attachment/fire/fire-02-00040/article_deploy/fire-02-00040.pdf) (table parsed from PDF text)
  - grass/non-burnable: 3.0 flat (≤10°), 1.5 moderate (10–30°), 1.0 steep (≥30°)
  - brush: 1.5 / 0.75 / 0.5
  - timber: 0.75 / 0.25 / 0.10
  - water: 0.01
- **Publication and license:** — [ArcGIS item JSON](https://www.arcgis.com/sharing/rest/content/items/525dbe8ad7e14e90872e5a62a5779fba?f=pjson); [ImageServer pjson](https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_SAB_FirefighterEstimatedGroundEvacuation/ImageServer?f=pjson)
  - ArcGIS item "Firefighter Estimated Ground Evacuation (Image Service)": access **public**; created 2024-06-21, modified 2025-09-03.
  - URL: https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_SAB_FirefighterEstimatedGroundEvacuation/ImageServer
  - Service: 30 m pixels, U16, values 1–5, Web Mercator, capabilities Image/Metadata/Catalog/Mensuration.
  - License: a standard USFS no-warranty disclaimer plus "the U.S. Forest Service waives copyright and related rights in the work worldwide through the CC0".
- The paper also says GET v2 "is publicly available via the Strategic Analytics Branch, Risk Management Assistance Dashboard". — [GET v2 PDF](https://mdpi-res.com/d_attachment/fire/fire-07-00292/article_deploy/fire-07-00292.pdf)
- **Layer caveats in the metadata:** — [ArcGIS item](https://www.arcgis.com/sharing/rest/content/items/525dbe8ad7e14e90872e5a62a5779fba?f=pjson)
  - times are binned into broad classes "commensurate with the precision of the analysis"
  - they are "best-case estimates" covering travel only, and assume "the litter crew can travel at the median pedestrian rate"
  - the layer "is meant to complement but not replace incident level safety and medical planning"

**RMA Dashboard, SDI and PCL**
- The RMA Dashboard is "an online hub" run by the USFS FAM Strategic Analytics Branch with WRMS/RMRS and the Missoula Fire Lab. URL: https://experience.arcgis.com/experience/f9d7f7f920494c3db43a23a8dffe4664/page/Map-Viewer. It hosts PCL, SDI, Snag Hazard, quantitative risk assessments, ISAP inputs, PODs, FireCon and Fireline Effectiveness. The product page mentions no login requirement. — [RMRS RMA Dashboard page](https://research.fs.usda.gov/rmrs/products/dataandtools/risk-management-assistance-rma-dashboard)
- **SDI** combines topography, fuels, expected fire behavior under severe weather (15 mph upslope wind, fully cured fuels, 90th/97th percentile fuel moistures), line production rates by fuel, and accessibility (distance from roads and trails). It is downloadable as a raster or KMZ from the RMA Dashboard. Citation: Rodríguez y Silva et al. 2020, IJWF 29:739–751. — [RMRS SDI page](https://research.fs.usda.gov/rmrs/products/dataandtools/suppression-difficulty-index)
- **PCL** uses gradient-boosted regression on 2002–2021 containment successes and failures, with topography, fuels, accessibility, SDI and fire behavior as inputs. It is scaled 0–100, 30 m, western US, updated annually. In 2022–2023 it correctly predicted >80% of containment successes and 90% of failures. It is available in the RMA viewer or as a raster/KMZ download (O'Connor et al. 2017). — [RMRS PCL page](https://research.fs.usda.gov/rmrs/products/dataandtools/potential-control-location-suitability-model); [FRAMES SDI entry](https://www.frames.gov/catalog/71803)
- A PCL ImageServer URL appears in search results. My unauthenticated JSON request returned no service metadata. — [PCL ImageServer](https://apps.fs.usda.gov/fsgisx03/rest/services/wo_spf_fam/Potential_Control_Location/ImageServer)

**Dennison/Campbell lab escape-route and safety tools**
- **Escape Route Index (ERI), 2019:** ERI runs 0–1. It is the ratio of distance reachable in a time window (10, 20 or 30 min), with slope and vegetation impedance, to the unimpeded distance. It has mean, min, max and azimuth variants and was demonstrated on the Angeles NF. Land cover affected ERI more than slope, and ERI was generally low at recent entrapment starting points. — [Campbell et al. 2019 Fire 2(3):40 (Crossref abstract)](https://api.crossref.org/works/10.3390/fire2030040); [PDF](https://mdpi-res.com/d_attachment/fire/fire-02-00040/article_deploy/fire-02-00040.pdf)
- ERI notes NWCG's description of escape routes as "probably the most elusive component of LCES". It says real-time escape-route mapping needs crew location, safety-zone location and a third input. — [ERI PDF](https://mdpi-res.com/d_attachment/fire/fire-02-00040/article_deploy/fire-02-00040.pdf)
- **SSDE (Safe Separation Distance Evaluator), 2022:** an online tool for safety-zone suitability, not travel time. It found LANDFIRE EVH and GEDI/Landsat underestimate vegetation height against lidar, applied a bias correction, and says "all SZ polygons evaluated using SSDE are validated on the ground prior to use". — [Crossref abstract](https://api.crossref.org/works/10.3390/fire5010005); [RMRS PDF](https://www.fs.usda.gov/rm/pubs_journals/2022/rmrs_2022_campbell_m002.pdf)
- **STRIDE R package:** source available at github.com/mickeycampbell/stride, with no license file. — [GitHub API](https://api.github.com/repos/mickeycampbell/stride)
- **Fryer et al. (2013):** modeled spatial evacuation triggers from fire spread plus travel rates, but used a pedestrian function "not calibrated to firefighters". — [Sullivan et al. 2020](https://www.fs.usda.gov/rm/pubs_journals/2020/rmrs_2020_sullivan_p001.pdf)

### Inferences
- **GET v2 is the best off-the-shelf, agency-vetted off-trail recipe.** It is fully specified and uses national public-domain inputs: LANDFIRE EVT/EVC/FBFM40, NHDPlus HR, USGS NTD, and HERE/HIFLD roads (HERE may carry license limits, not checked). A Python/GDAL worker could reproduce its off-road cost surface per fire at 30 m with no server. That would mean reimplementing the multipliers, not calling a USFS API.
- **The public GET ImageServer only gives 1–5 hospital-time classes.** It could be shown as context ("remote: >2 h to hospital by ground"), but it cannot time an arbitrary road-to-spot-fire leg.
- **The STRIDE equation can be reimplemented from the paper.** Equations and coefficients are published facts. Copying the R code itself is legally unclear because the repo has no license (my inference, not legal advice).

### Gaps
- I could not confirm whether the RMA Dashboard, SDI downloads or the PCL ImageServer work without an agency login (the PCL service returned no JSON to an unauthenticated request).
- SDI spatial resolution and the current SDI/PCL service URLs were not verified.
- I found no statement of GET v2 update frequency.
- I found no public, maintained escape-route routing web tool from the Dennison lab or others. ERI is a published method, and I found no hosted ERI layer.

## Q3. Load-carrying firefighter pace data, NWCG guidance (LCES, IRPG), and incident reviews emphasizing escape-route travel time

### Takeaway
- **Measured hotshot pace with ~50 lb loads:** about 0.97, 1.40 and 1.70 m/s peak for the low, moderate and high tertiles. On flat trail that is about 17, 12 and 10 min/km (Sullivan et al. 2020).
- **Pack penalty:** dropping a 16 kg line pack on a steep 20.75% trail made transit 21.5% (men) to 26.3% (women) faster (Ruby et al. 2003).
- **Fuel type:** Canadian trials found open fuels fastest, with 1.3× travel time in lodgepole and 1.8× in dense spruce/fir (Alexander et al. 2005, via ERI).
- **Current IRPG (January 2025):** escape routes should be "Scouted… Timed considering slowest person, fatigue, and temperature factors", and crews should "Evaluate escape time vs. rate of spread".
- **Fatality reconstructions (Mann Gulch, South Canyon, Yarnell Hill)** anchor the field-speed ranges, roughly 0.3–1.7 m/s depending on slope and terrain.

### Cited Findings
- **Sullivan, Campbell, Dennison, Brewer & Butler 2020, Fire 3(3):52:** — [Sullivan et al. 2020 (RMRS PDF)](https://www.fs.usda.gov/rm/pubs_journals/2020/rmrs_2020_sullivan_p001.pdf); [MDPI](https://www.mdpi.com/2571-6255/3/3/52)
  - Eleven IHCs of 20–22 people agreed to take part during 2019 training. The final dataset is 21 firefighters from 3 crews: 108,600 GPS points, 44 hikes on 9 trails, 209 km.
  - Loads averaged 50 lb (22.7 kg), range 40–85 lb; mean age 29.
  - Points were snapped to digitized trails (mean drift 1.5 m); slope came from a lidar DTM.
- **Sullivan tertile models** (Lorentz, non-linear quantile regression at the 16.7th, 50th and 83.3rd percentiles): — [same](https://www.fs.usda.gov/rm/pubs_journals/2020/rmrs_2020_sullivan_p001.pdf)
  - Low: a = −3.3717, b = 25.8255, c = 92.6594, d = −0.1624, e = 0.0019; peak 0.974 m/s
  - Moderate: a = −2.8292, b = 20.9482, c = 77.6346, d = 0.2228, e = −0.0004; peak 1.404 m/s at −2.9°
  - High: a = −2.2893, b = 19.4024, c = 65.3577, d = 0.6226, e = −0.0020; peak 1.699 m/s at −2.6°
  - Cross-validated MAE / R²: low 0.172 m/s / 0.39; moderate 0.081 / 0.86; high 0.152 / 0.57
- **Sullivan guidance:** — [same](https://www.fs.usda.gov/rm/pubs_journals/2020/rmrs_2020_sullivan_p001.pdf)
  - Moderate: about 12 min per km, "adding three minutes for a downhill 15° slope and… six minutes for an uphill 15° slope".
  - Low: 17 min per km, +5 min at −15° and +9 min at +15°.
  - High, from Table 4: 1 km takes 16.1, 11.9, 9.9, 14.0 and 19.7 min at −30°, −15°, 0°, +15° and +30°; 1 mile takes 25.9, 19.1, 16.0, 22.5 and 31.7 min.
  - Use-case suggestion: low for an injured crew member, high when the fire is encroaching.
- **Sullivan caveats:** — [same](https://www.fs.usda.gov/rm/pubs_journals/2020/rmrs_2020_sullivan_p001.pdf)
  - The functions "assume load carriage"; if firefighters drop packs and run, rates increase.
  - If the orderly escape breaks down, group-travel assumptions fail.
  - Data came from pre-season training (so fatigue, heat, panic and time on fire are not modeled), on gravel or dirt roads and trails, not cross-country.
  - Firefighters "generally move faster than non-firefighting personnel".
- **Ruby, Leadbetter, Armstrong & Gaskill 2003, IJWF 12:111–116:** — [FRAMES](https://www.frames.gov/catalog/8955); [IJWF abstract page](https://connectsci.au/wf/article-abstract/12/1/111/22619/Wildland-firefighter-load-carriage-effects-on?redirectedFrom=fulltext)
  - 8 men and 5 women did maximal hikes on a 660.5 m dirt trail with 137 m rise (20.75% grade), each carrying a fire shelter and Pulaski, with and without a 16 kg (35 lb) line pack.
  - Without the pack, transit was 21.5% (men) and 26.3% (women) faster.
- **Alexander et al. 2005 (Alberta):** open fuel types (grass, logging slash) gave the fastest travel. Lodgepole pine with open understory raised travel time about 1.3×, and dense spruce/fir about 1.8×. Load also slowed travel. — [ERI paper](https://mdpi-res.com/d_attachment/fire/fire-02-00040/article_deploy/fire-02-00040.pdf); [Campbell et al. 2017](https://content.csbs.utah.edu/~pdennison/reprints/denn/2017_Campbell_etal_IJWF.pdf)
- **Historic reconstructions:** — [Sullivan et al. 2020](https://www.fs.usda.gov/rm/pubs_journals/2020/rmrs_2020_sullivan_p001.pdf)
  - Putnam's South Canyon (1994) reenactments: 0.3–1.7 m/s depending on terrain, with an "extremely fast" reenactment at 2.1 m/s.
  - Butler et al. used Mann Gulch and South Canyon data to derive about 1.3 m/s on flat, 0.9 on 10–20% slopes, 0.6 on 20–40%, and 0.3 on 40–60%.
  - Rothermel gave minute-by-minute crew locations and travel rates for Mann Gulch (1949).
- **South Canyon and Yarnell Hill (per Campbell 2017):** at South Canyon, firefighters died "trying to outrun flames up rocky slopes as steep as 55% (29°)" in dense Gambel oak and pinyon–juniper. At Yarnell Hill (2013), they were entrapped while travelling an escape route through boulders and "thick chaparral brush". The model also ignores fire location, which could make an escape route "unsuitable or even fatal, as in the case of the Yarnell Hill fire". — [Campbell et al. 2017](https://content.csbs.utah.edu/~pdennison/reprints/denn/2017_Campbell_etal_IJWF.pdf)
- **Work Capacity Test (arduous):** a 3-mile hike with a 45 lb pack on level terrain in ≤45 minutes, walking only (no running). That approximates 22.5 ml·kg⁻¹·min⁻¹ oxygen consumption. — [NWCG WCT Administrator's Guide, PMS 307](https://www.fs.usda.gov/sites/default/files/pms307.pdf); [USFS WCT brochure](https://www.fs.usda.gov/sites/default/files/2023-03/Work-Capacity-Test-brochure.pdf)
- **IRPG, PMS 461, dated January 2025** (the current NWCG PDF): — [NWCG IRPG PMS 461 PDF (Jan 2025)](https://fs-prod-nwcg.s3.us-gov-west-1.amazonaws.com/s3fs-public/publication/pms461.pdf)
  - LCES "must be established and known to ALL firefighters BEFORE it is needed".
  - Escape routes: "More than one escape route; Avoid steep, uphill escape routes; Scouted for loose soils, rocks, vegetation; Timed considering slowest person, fatigue, and temperature factors; Marked for day or night; Evaluate escape time vs. rate of spread; Vehicles parked for escape".
  - "Time available to use escape routes will decrease and safety zone size will increase (possibly by more than double) as wind exceeds 10 mph and/or slope exceeds 20%!"
  - Watch Out Situations include "Establishing escape routes that are uphill or difficult to travel".
- NWCG issued Memo 23-01 requesting IRPG revision updates, which indicates an active revision cycle. — [NWCG announcement](https://www.nwcg.gov/announcement/general/request-for-nwcg-incident-response-pocket-guide-pms-461-revision-updates-memo-23-01)
- Page et al. found entrapments are likely substantially under-reported, and named better travel-rate functions over complex terrain as a research need. — [Sullivan et al. 2020](https://www.fs.usda.gov/rm/pubs_journals/2020/rmrs_2020_sullivan_p001.pdf)

### Inferences
- **The WCT arduous pace is a maximal test, not a sustained escape-route rate.** 3 mi in 45 min is 1.79 m/s (6.4 km/h, computed), faster than even Sullivan's high-tertile peak (1.70 m/s). Planning times should use the Sullivan tertiles.
- **A firefighter-honest on-trail estimate** is Sullivan moderate as the central value, with the low/high tertiles as the range, following the IRPG "slowest person" logic. For off-trail legs, apply a vegetation/debris multiplier (GET v2 style) or STRIDE on top. Displaying "time if packs dropped" is not supported by published functions.

### Gaps
- I did not retrieve the primary Yarnell Hill SAIR, South Canyon (Butler et al. 1998) or Mann Gulch (Rothermel 1993) documents. Their travel-rate details are cited via Sullivan 2020 and Campbell 2017, and exact per-segment times were not verified.
- The Alexander et al. 2005 / Baxter et al. 2004 FERIC primary reports (Canada) were not retrieved; the numbers above come via the ERI paper.
- I found no NWCG-published travel-rate table for escape routes. The IRPG says "timed", with no rate table.

## Q4. Cost-surface inputs: LANDFIRE, 3DEP, AWS Terrain Tiles (terrarium/joerd), hydrography (NHD/3DHP), cliffs

### Takeaway
- **LANDFIRE:** the latest complete release is **LF 2024**, 30 m, public domain. It was released by GeoArea from April to December 2025 (CONUS complete October 2025) and reflects disturbance through FY2024. Access is via LFPS API, Full Extent Downloads and WCS/WMS.
- **3DEP:** the live ImageServer (1 m finest pixel, WCS enabled) reflects data published as of 24 Aug 2026. A seamless 1 m CONUS DEM has been in production since mid-2025.
- **AWS Terrain Tiles:** over the US they come from NED/3DEP 1/3 arc-second (~10 m) at z10–15, plus 1/9 arc-second (~3 m) where available. They are a 2016–2017 build, so z15 pixels (~3.7 m at 40°N) are oversampled.
- **NHD:** retired 1 Oct 2023 and succeeded by 3DHP, which is due to reach full coverage by 2032.
- **Cliffs:** no dedicated national cliff layer turned up. GET v2 handles cliffs as slope above 45° = impassable.

### Cited Findings
- **LANDFIRE LF 2024:** — [LANDFIRE LF 2024 page](https://www.landfire.gov/data/lf2024)
  - Release dates: Alaska April 2025; SW CONUS May 2025; NW June 2025; remaining CONUS GeoAreas (SC, SE, NC, NE) October 2025; Hawaii and PR/USVI December 2025.
  - It "accounts for disturbances up through Fiscal Year 2024".
  - Products include EVT, EVC, EVH, FBFM13, FBFM40, CC, CH, CBH, CBD, FVC, FVH and FVT.
  - Access is via LF Map Viewer, Full Extent Downloads, LF Product Service (LFPS, https://lfps.usgs.gov/) and WCS/WMS.
- Downstream users cite LF 2024 as "LF 2024 Update v2.5.0", and the full CONUS release is noted as complete. — [boettiger-lab issue #515](https://github.com/boettiger-lab/data-workflows/issues/515); [LANDFIRE Alerts](https://www.landfire.gov/data/alerts)
- LANDFIRE data are public domain with no use restrictions; derivatives should be labeled as modified. Native resolution is 30 m. LFPS is a REST API returning multiband rasters over HTTPS. — [LANDFIRE FAQs](https://www.landfire.gov/faqs); [Earth Engine LANDFIRE EVH catalog (terms)](https://developers.google.com/earth-engine/datasets/catalog/LANDFIRE_Vegetation_EVH_v1_4_0); [rlandfire (LFPS client)](https://rdrr.io/cran/rlandfire/)
- **How GET v2 used LANDFIRE:** EVT and EVC for tree, shrub and grass classes and continuous shrub cover; FBFM40 for timber litter and slash/blowdown; LANDFIRE 2020 slope at 30 m. — [GET v2 PDF](https://mdpi-res.com/d_attachment/fire/fire-07-00292/article_deploy/fire-07-00292.pdf)
- **LANDFIRE vegetation height bias:** EVH tends to underestimate vegetation height against lidar. — [SSDE paper abstract](https://api.crossref.org/works/10.3390/fire5010005)
- **3DEP ImageServer** (`elevation.nationalmap.gov/.../3DEPElevation/ImageServer`): — [3DEP ImageServer pjson](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer?f=pjson)
  - pixel size 1 m (finest), F32, maximum request 8000×8000
  - WMS and WCS enabled, with dynamic slope and hillshade functions
  - "Data available in this map service reflects all 3DEP DEM data published as of August 24, 2026"
- **Seamless 1 m DEM (S1M) for CONUS:** in production since mid-2025, delivered as 10×10 km COG tiles. The seamless 1/3 arc-second DEM covers CONUS, HI, PR, territories and limited Alaska, in NAD83 geographic coordinates with NAVD88 metres. — [data.gov S1M](https://catalog.data.gov/dataset/seamless-1-meter-digital-elevation-models-dems-usgs-national-map-3dep-downloadable-data-co); [USGS 1/3 arc-second catalog](https://data.usgs.gov/datacatalog/data/USGS:3a81321b-c153-416f-98b7-cc8e5f0e17c3); [About 3DEP products](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services)
- **AWS Terrain Tiles (tilezen/joerd) sources:** 3DEP (formerly NED) at 10 m outside Alaska and 3 m in select areas; SRTM 30 m; GMTED at low zooms; ETOPO1 bathymetry. — [joerd data-sources.md](https://github.com/tilezen/joerd/blob/master/docs/data-sources.md)
- **Joerd sources per zoom (US land):** — [same](https://github.com/tilezen/joerd/blob/master/docs/data-sources.md)
  - z4–6: GMTED
  - z7–9: SRTM
  - z10: SRTM and NED/3DEP 1/3 arcsec
  - z11–15: SRTM and NED/3DEP 1/3 arcsec and 1/9 arcsec
  - Ground resolution formula: cos(lat)·2π·6378137 / (256·2^z).
  - The docs note that on land in general, z15 values are often oversampled from coarser sources.
- **Terrain Tiles build and distribution:** v1 was built 2016Q2 (released 2016Q3) and v1.1 was built 2017Q3 (released 2017Q4). — [joerd data-sources (fetched summary)](https://github.com/tilezen/joerd/blob/master/docs/data-sources.md)
  - The AWS Open Data registry lists bucket `elevation-tiles-prod` (us-east-1, plus an EU replica), managed by "Mapzen, a Linux Foundation project", with update frequency "New data is added based on community feedback". — [AWS registry YAML](https://github.com/awslabs/open-data-registry/blob/main/datasets/terrain-tiles.yaml)
- **Terrarium encoding:** elevation = (R·256 + G + B/256) − 32768, in metres, Web Mercator, 256/260/512/516 px tiles. — [joerd formats.md](https://github.com/tilezen/joerd/blob/master/docs/formats.md)
- **Terrain Tiles attribution:** required, e.g. "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey". 3DEP itself is public domain. — [joerd attribution.md](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
- **NHD and 3DHP:** — [USGS NHD page](https://www.usgs.gov/national-hydrography/national-hydrography-dataset); [USGS 3DHP access](https://www.usgs.gov/3d-hydrography-program/access-3dhp-data-products); [3DHP FeatureServer](https://3dhp.nationalmap.gov/arcgis/rest/services/usgs_3dhp_all/FeatureServer)
  - NHD was retired 1 Oct 2023; it remains available but is no longer maintained.
  - In 2024 USGS shifted to producing 3D Hydrography Program (3DHP) products instead of NHD, WBD and NHDPlus HR. The first data went out as a service in October 2023, with full US coverage expected by 2032.
  - New elevation-derived hydrography (EDH) is added to the services quarterly, and downloads update early each fiscal year.
- **Hydrography barriers in GET v2:** NHDPlus HR perennial streams at 5×; major water bodies (LANDFIRE EVT water) impassable. **Cliffs:** handled as slope above 45° = impassable (the paper mentions a "cliff band"). — [GET v2 PDF](https://mdpi-res.com/d_attachment/fire/fire-07-00292/article_deploy/fire-07-00292.pdf)
- **ERI and LANDFIRE road detection:** at 30 m, only roads roughly ≥30 m wide show up in LANDFIRE, so separate road and trail vectors are needed. — [ERI PDF](https://mdpi-res.com/d_attachment/fire/fire-02-00040/article_deploy/fire-02-00040.pdf)

### Inferences
- **The map's existing terrarium DEM is ~10 m NED circa 2016–2017, resampled.** Slope computed from it is adequate for GET-style 30 m cost surfaces. It will smooth short cliff bands and gullies that lidar-based models (Campbell 2017, STRIDE) resolve, which likely makes steep cross-country legs optimistic. For better slope, the worker can pull current 3DEP (10 m, or 1 m where available) via the ImageServer or WCS and precompute per-fire cost rasters.
- **Browser-side versus worker-side:** STRIDE's density term needs lidar point clouds (NRD in the 0.85–1.2 m band). That is not practical in a static browser app. A GET-v2-style multiplier approach using LANDFIRE EVT/EVC/FBFM40 is feasible in a Python/GDAL cron and could be shipped as static rasters or tiles for the offline pack.

### Gaps
- I did not verify AWS S3 or TNM Access API routes for 3DEP downloads, or the status and coverage of the 1/9 arc-second product.
- I did not verify whether an LF 2025 update is scheduled or released as of Sept 2026.
- I found no national cliff dataset (the OSM natural=cliff tag was not researched).
- The exact extent of 1/9 arc-second data inside the terrain tiles was not determined.

## Q5. Operational and consumer tools that estimate off-trail routes or travel times, and how they present uncertainty

### Takeaway
None of the tools found offers firefighter-calibrated cross-country time estimates or explicit uncertainty ranges.
- **CalTopo** gives Munter-method travel times per line, with "hike", "bushwhack", "ski" and custom rates, and no uncertainty display found.
- **onX Backcountry and Gaia GPS** document distance and elevation for routes but no published off-trail time model.
- **Wildland Fire TAK (WFTAK)** provides offline common-operating-picture maps, with no documented routing or escape-route timing.
- **Fire Lab's WiSE app** handles safety-zone distance, not travel.

### Cited Findings
- **CalTopo:** "Travel Time" on a line uses the Munter Method, with travel modes hike, bushwhack, ski and custom. The presets "fill in the accepted generic rates for that travel mode uphill, downhill and across flats". It is computed "in 50m increments as opposed to the whole leg at once". — [CalTopo Training: existing lines](https://training.caltopo.com/all_users/objects/existing-lines)
- **Gaia GPS:** the official forum threads show no robust built-in time estimator. Users apply their own pace rules; one user suggested 30 min per mile plus 30 min per 1,000 ft, which is not an official formula. — [Gaia GPS community: estimated hiking times](https://help.gaiagps.com/hc/en-us/community/posts/360001979528-Estimated-hiking-and-cycling-times); [Gaia: unrealistic time calculation](https://help.gaiagps.com/hc/en-us/community/posts/115008068888-Create-route-has-unrealistic-time-calculation) (weak, community sources)
- **onX Backcountry:** Route Builder reports distance and elevation gain and loss. I found no documentation of an off-trail time model. — [onX Backcountry Route Builder](https://www.onxmaps.com/backcountry/app/features/route-builder)
- **WFTAK:** a USDA Forest Service and Colorado Center of Excellence program, via FAM IM Tools & Technology. It supports iTAK, ATAK, TACX (Windows/Linux) and WebTAK, has offline basemap downloads and hardware/software plugins, and is labeled "BETA… test and evaluation mode". It documents no routing or travel-time feature. — [WFTAK: What is WFTAK](https://wftak.wildfire.gov/pages/what-is-wftak)
- **ATAK plugins:** a "Fire Area Survey" plugin captures walked or driven perimeters and tracks. — [Google Play: ATAK Fire Area Survey plugin](https://play.google.com/store/apps/details?id=com.atakmap.android.firesurvey.plugin)
- **ATAK history:** TAK was introduced to USFS and the Prescott Fire Dept. after Yarnell Hill for crew tracking. — [Wildfire Intel forum (secondary)](https://forums.wildfireintel.org/t/tak-information/9540)
- **WiSE app** (Missoula Fire Sciences Lab and Technosylva): released May 1, 2025, iOS and Android, works offline. It computes safe separation distance from wind, slope, vegetation height and burning conditions, capped at 1,000 ft. "The new safety zone guideline used in the WiSE app has not yet been formally approved by the National Wildfire Coordinating Group". It was listed as temporarily unavailable in the stores. — [RMRS/Fire Lab WiSE page](https://research.fs.usda.gov/firelab/products/dataandtools/wildfire-safety-evaluator-wise-app)
- **Research tools:** STRIDE R package (least-cost path plus travel time from lidar) and SSDE (online safety-zone evaluator). — [STRIDE paper](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11399398/fullTextXML); [SSDE paper](https://www.fs.usda.gov/rm/pubs_journals/2022/rmrs_2022_campbell_m002.pdf)

### Inferences
- **An opening for Responder Debrief.** Showing on-trail vs cross-country legs with a low/moderate/high range (Sullivan tertiles), plus an explicit off-trail multiplier source (GET v2 classes), would go beyond what consumer apps expose. CalTopo's "bushwhack" preset is the closest consumer analogue, but its rates and basis are undocumented.

### Gaps
- I could not find numeric CalTopo preset rates or any CalTopo uncertainty display.
- I found no documentation of onX or Gaia off-trail time algorithms.
- I found no evidence of a TAK plugin for escape-route timing in wildland fire.
- Avenza and Esri Field Maps were not researched.

## Q6. Safety and liability cautions for publishing routes or travel times to firefighters

### Takeaway
Agencies and authors consistently frame modeled travel and evacuation times as coarse, best-case decision support that must be validated on the ground, and never as a substitute for scouting and timing escape routes. The public record has a clear precedent of navigation apps routing civilians toward fire (Waze during the 2017 Skirball Fire). I found no published NWCG policy specific to third-party routing apps.

### Cited Findings
- **USFS GET metadata:** "makes no warranty… nor assumes any legal liability"; "Natural hazards may or may not be depicted"; the user is responsible for verifying limitations. The layer is "best-case", binned to its precision, and "meant to complement but not replace incident level safety and medical planning". — [GET ArcGIS item](https://www.arcgis.com/sharing/rest/content/items/525dbe8ad7e14e90872e5a62a5779fba?f=pjson)
- **GET v2 paper:** input datasets "possess inherent spatial and thematic uncertainty" that propagates through the workflow, and expert opinion was used to stay conservative. — [GET v2 PDF](https://mdpi-res.com/d_attachment/fire/fire-07-00292/article_deploy/fire-07-00292.pdf)
- **IRPG (Jan 2025):** escape routes must be "Scouted…", "Timed considering slowest person, fatigue, and temperature factors", "Marked for day or night", and "Evaluate escape time vs. rate of spread". Available escape time shrinks as wind exceeds 10 mph and/or slope exceeds 20%. — [IRPG PMS 461 (Jan 2025)](https://fs-prod-nwcg.s3.us-gov-west-1.amazonaws.com/s3fs-public/publication/pms461.pdf)
- **Campbell et al. 2017:**
  - "estimating travel rates should be done with great caution, particularly when simulating escape routes travel in a potentially dangerous wildfire environment"
  - the fastest route is not always the best one, since a defined trail may be safer in smoke
  - the models ignore fire location (Yarnell Hill)
  - [Campbell et al. 2017](https://content.csbs.utah.edu/~pdennison/reprints/denn/2017_Campbell_etal_IJWF.pdf)
- **Sullivan et al. 2020:** predictions assume load carriage and orderly group travel, and do not include fatigue or panic. — [Sullivan et al. 2020](https://www.fs.usda.gov/rm/pubs_journals/2020/rmrs_2020_sullivan_p001.pdf)
- **STRIDE:** short-transect models need a scaling factor for long-distance times. — [STRIDE](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11399398/fullTextXML)
- **SSDE:** "it is essential that all SZ polygons evaluated using SSDE are validated on the ground prior to use". — [SSDE (Crossref abstract)](https://api.crossref.org/works/10.3390/fire5010005)
- **WiSE:** its safety-zone guideline is not yet NWCG-approved. — [WiSE page](https://research.fs.usda.gov/firelab/products/dataandtools/wildfire-safety-evaluator-wise-app)
- **Skirball Fire, December 2017 (Los Angeles):** LAPD warned drivers not to use navigation apps like Waze and Google Maps. Waze rerouted drivers onto empty streets in burning evacuation zones, with "no indication… that any streets on the suggested route would be in fire territory". — [LAist](https://laist.com/news/kpcc-archive/lapd-warns-navigation-apps-sent-drivers-into-skirb); [AP via 12News](https://www.12news.com/article/news/nation-world/waze-sent-commuters-toward-california-wildfires-drivers-say/507-497699772); [AI Incident Database #22](https://incidentdatabase.ai/cite/22/)

### Inferences
Suggested presentation guardrails, drawn from the sources above:
- label cross-country legs as "modeled, unscouted"
- show ranges, not single times
- state the assumptions (loaded crew, orderly group, daylight, no fire effects)
- avoid implying that a displayed route is a designated escape route
- mirror the IRPG language: "scout, time with the slowest person, re-evaluate"
- the repo already flags that routing engines "don't know about fire closures"; this should be extended to cross-country legs

### Gaps
- I found no NWCG memo or policy that addresses consumer or third-party navigation apps or published travel times for firefighters.
- I found no Lessons Learned Center report in which a navigation app misled a wildland fire crew; searches returned none, which is not proof of absence.
- Legal liability analysis for a private publisher of such estimates was not researched.
