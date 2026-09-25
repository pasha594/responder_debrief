"""Per-fire off-trail travel-cost grid (pure numpy): LANDFIRE + NHD -> pace
code + vegetation class + DEM on the fire's 30 m UTM grid.

Model (docs/trails-routing/FINAL_PLAN.md §2.5; research/offtrail_travel_science.md):
- GET v2 (USFS Ground Evacuation Time v2) isotropic off-trail rate on the
  TERRAIN slope σ (LF2020 SlpD):
      rGET(σ) = (0.0065σ² + 80.8887) / (0.1402σ² + 70.3892)  m/s
  Using terrain slope, not the direction of travel, is what makes contouring
  a steep sidehill expensive, as GET intends. The browser adds only a
  round-trip-preserving uphill/downhill factor from the DEM.
- GET v2 vegetation multipliers M: tree 4; shrub 1 + 3·cover; herb, sparse,
  barren, agriculture, developed 1; x2 for heavy litter (FBFM40 TL4/TL5/TL7);
  x5 for slash/blowdown (SB1-SB4; GET's table value); x5 on perennial streams.
  Snow/ice 3 and unknown 4 are our choices (GET is silent; conservative).
- Impassable: slope > 45°, open water (EVC 11, EVT 7292, FBFM40 NB8=98, NHD
  perennial waterbody or river polygon), and no data.

Lifeform comes from EVC, which encodes lifeform AND cover in one code
(110-199 tree %, 210-299 shrub %, 310-399 herb %), so no EVT lookup table is
needed; FBFM40 fills cells where EVC has no lifeform. EVT only cross-checks
water/snow/barren.

LF2025 covers only some GeoAreas until Nov 2026: `mosaic_versions` picks
LF2025 per pixel where EVT, EVC and FBFM40 are all valid there, else LF2024,
so a fire straddling a GeoArea boundary never gets a nodata hole.

Encodings (shared with frontend/src/routing/pacecode.ts, vegClasses.ts):
- pace code c in 1..254: P(c) = 0.8 * 1024**((c-1)/253) s/m (0.8..819 s/m,
  2.8 % steps); 0 and 255 impassable.
- veg byte: low nibble = class (VEG_*), bit 0x10 = perennial stream.
"""

from __future__ import annotations

import numpy as np

PACE_MIN = 0.8
PACE_SPAN = 1024.0
PACE_STEPS = 253
IMPASSABLE = 255

VEG_UNKNOWN, VEG_GRASS, VEG_SHRUB_LIGHT, VEG_SHRUB_DENSE = 0, 1, 2, 3
VEG_TIMBER, VEG_TIMBER_LITTER, VEG_SLASH, VEG_SPARSE = 4, 5, 6, 7
VEG_DEVELOPED, VEG_SNOW, VEG_WATER, VEG_STEEP = 8, 9, 10, 11
STREAM_BIT = 0x10
DENSE_SHRUB_COVER = 0.40

LF_NODATA = (-9999, 32767)  # exportImage and WCS NoData
MAX_SLOPE = 45.0

M_TREE, M_SNOW, M_UNKNOWN = 4.0, 3.0, 4.0
M_LITTER, M_SLASH, M_STREAM = 2.0, 5.0, 5.0
LITTER_FBFM = (184, 185, 187)          # TL4, TL5, TL7
SLASH_FBFM = (201, 202, 203, 204)      # SB1-SB4
FBFM_WATER = 98                        # NB8
EVT_WATER, EVT_SNOW, EVT_BARREN = 7292, 7735, 7295


def r_get(slope_deg):
    s = np.asarray(slope_deg, dtype=np.float64)
    return (0.0065 * s * s + 80.8887) / (0.1402 * s * s + 70.3892)


def pace_encode(pace_s_per_m):
    p = np.asarray(pace_s_per_m, dtype=np.float64)
    c = 1 + np.rint(PACE_STEPS * np.log(np.maximum(p, PACE_MIN) / PACE_MIN) / np.log(PACE_SPAN))
    return np.clip(c, 1, 254).astype(np.uint8)


def pace_decode(code):
    c = np.asarray(code, dtype=np.float64)
    return PACE_MIN * PACE_SPAN ** ((c - 1) / PACE_STEPS)


def valid_lf(a) -> np.ndarray:
    a = np.asarray(a)
    return (a >= 0) & ~np.isin(a, LF_NODATA)


def mosaic_versions(v25: dict | None, v24: dict | None) -> tuple[dict, str]:
    """Per-pixel LF2025 else LF2024, consistent across evt/evc/fbfm.

    v25/v24: {"evt", "evc", "fbfm"} arrays on the same grid (either may be
    None). -> ({"evt","evc","fbfm"}, label)."""
    keys = ("evt", "evc", "fbfm")
    if v25 is None and v24 is None:
        raise ValueError("no LANDFIRE vegetation layers")
    if v25 is None:
        return {k: v24[k] for k in keys}, "LF2024"
    use25 = valid_lf(v25["evt"]) & valid_lf(v25["evc"]) & valid_lf(v25["fbfm"])
    if v24 is None or use25.all():
        return {k: v25[k] for k in keys}, "LF2025"
    if not use25.any():
        return {k: v24[k] for k in keys}, "LF2024"
    return {k: np.where(use25, v25[k], v24[k]) for k in keys}, "LF2025+LF2024"


def _classify(evt, evc, fbfm):
    """-> (base class, base multiplier, shrub cover 0..1) before modifiers."""
    shape = evc.shape
    cls = np.full(shape, VEG_UNKNOWN, np.uint8)
    m = np.full(shape, M_UNKNOWN, np.float32)
    cover = np.zeros(shape, np.float32)

    def put(mask, c, mult):
        cls[mask] = c
        m[mask] = mult

    # FBFM40 first (the fallback), then EVC overwrites wherever it knows.
    fb = fbfm
    put((fb >= 101) & (fb <= 109), VEG_GRASS, 1.0)               # GR
    gs = (fb >= 121) & (fb <= 124)                                # grass-shrub
    sh = (fb >= 141) & (fb <= 149)                                # shrub
    cover[gs] = 0.3
    cover[sh] = 0.5
    put(gs, VEG_SHRUB_LIGHT, 1.9)
    put(sh, VEG_SHRUB_DENSE, 2.5)
    put(((fb >= 161) & (fb <= 165)) | ((fb >= 181) & (fb <= 189)), VEG_TIMBER, M_TREE)
    put(fb == 91, VEG_DEVELOPED, 1.0)
    put(fb == 92, VEG_SNOW, M_SNOW)
    put(fb == 93, VEG_DEVELOPED, 1.0)
    put(fb == 99, VEG_SPARSE, 1.0)

    e = evc
    put(e == 12, VEG_SNOW, M_SNOW)
    put(((e >= 13) & (e <= 25)) | ((e >= 61) & (e <= 82)), VEG_DEVELOPED, 1.0)
    put((e == 31) | (e == 32) | (e == 100), VEG_SPARSE, 1.0)
    put((e >= 110) & (e <= 199), VEG_TIMBER, M_TREE)
    shrub = (e >= 210) & (e <= 299)
    cover[shrub] = (e[shrub] - 200) / 100.0
    cls[shrub] = np.where(cover[shrub] >= DENSE_SHRUB_COVER, VEG_SHRUB_DENSE, VEG_SHRUB_LIGHT)
    m[shrub] = 1.0 + 3.0 * cover[shrub]
    put((e >= 310) & (e <= 399), VEG_GRASS, 1.0)

    put(evt == EVT_SNOW, VEG_SNOW, M_SNOW)
    put((evt == EVT_BARREN) & (cls == VEG_UNKNOWN), VEG_SPARSE, 1.0)
    return cls, m, cover


def compute(*, evt, evc, fbfm, slope, elev, streams=None, water=None) -> dict:
    """All inputs are same-shape arrays on the target grid.

    slope: degrees (float or int; LF nodata allowed); elev: metres.
    streams / water: 0/1 NHD rasters (perennial flowlines all-touched;
    perennial waterbodies + river polygons cell-centre).
    -> {"pace": u8, "veg": u8, "dem": i16, "stats": {...}}"""
    evt = np.asarray(evt)
    evc = np.asarray(evc)
    fbfm = np.asarray(fbfm)
    slope = np.asarray(slope, dtype=np.float64)
    elev = np.asarray(elev, dtype=np.float64)
    shape = evc.shape
    streams = np.zeros(shape, bool) if streams is None else np.asarray(streams) > 0
    water_nhd = np.zeros(shape, bool) if water is None else np.asarray(water) > 0

    cls, m, _cover = _classify(evt, evc, fbfm)
    litter = np.isin(fbfm, LITTER_FBFM)
    slash = np.isin(fbfm, SLASH_FBFM)
    m = m * np.where(litter, M_LITTER, 1.0) * np.where(slash, M_SLASH, 1.0)
    m = m * np.where(streams, M_STREAM, 1.0)
    cls = np.where(litter & (cls == VEG_TIMBER), VEG_TIMBER_LITTER, cls).astype(np.uint8)
    cls = np.where(slash, VEG_SLASH, cls).astype(np.uint8)

    topo_nodata = ~np.isfinite(slope) | ~np.isfinite(elev) | np.isin(slope, LF_NODATA) \
        | (slope < 0) | np.isin(elev, LF_NODATA) | (elev < -500)
    is_water = (evc == 11) | (evt == EVT_WATER) | (fbfm == FBFM_WATER) | water_nhd
    steep = (slope > MAX_SLOPE) & ~topo_nodata
    veg_nodata = ~valid_lf(evc) & ~valid_lf(fbfm) & ~valid_lf(evt)
    impassable = is_water | steep | topo_nodata | veg_nodata

    s = np.where(topo_nodata, 0.0, slope)
    pace = pace_encode(m / r_get(s))
    pace[impassable] = IMPASSABLE

    cls = np.where(is_water, VEG_WATER, cls)
    cls = np.where(steep & ~is_water, VEG_STEEP, cls).astype(np.uint8)
    veg = cls | np.where(streams & ~is_water, STREAM_BIT, 0).astype(np.uint8)

    dem = np.where(topo_nodata, -32768, np.clip(np.rint(elev), -500, 9000)).astype(np.int16)

    n = cls.size
    class_pct = {int(k): round(100.0 * int(v) / n, 2)
                 for k, v in zip(*np.unique(cls, return_counts=True))}
    stats = {
        "cells": int(n),
        "impassable_pct": round(100.0 * float(impassable.mean()), 2),
        "nodata_pct": round(100.0 * float((topo_nodata | veg_nodata).mean()), 2),
        "steep_pct": round(100.0 * float(steep.mean()), 2),
        "stream_cells": int((streams & ~is_water).sum()),
        "class_pct": class_pct,
    }
    return {"pace": pace, "veg": veg.astype(np.uint8), "dem": dem, "stats": stats}
