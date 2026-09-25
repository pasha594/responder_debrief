"""WGS84 <-> UTM, Krüger n-series to 4th order (mm-level inside a zone).

Pure numpy, vectorized: every function takes scalars or arrays. The routing
bundle builder uses it for AOI boxes, OSM node projection and the graph
coordinates; the browser mirrors the forward direction in
frontend/src/spread/utm.ts so A/B pins land in the same grid cells.
"""

from __future__ import annotations

import math

import numpy as np

A_AXIS = 6378137.0
F = 1 / 298.257223563
K0 = 0.9996
E0 = 500000.0
N0_SOUTH = 10000000.0

_n = F / (2 - F)
_A = A_AXIS / (1 + _n) * (1 + _n**2 / 4 + _n**4 / 64)
_ALPHA = (
    _n / 2 - 2 * _n**2 / 3 + 5 * _n**3 / 16 + 41 * _n**4 / 180,
    13 * _n**2 / 48 - 3 * _n**3 / 5 + 557 * _n**4 / 1440,
    61 * _n**3 / 240 - 103 * _n**4 / 140,
    49561 * _n**4 / 161280,
)
_BETA = (
    _n / 2 - 2 * _n**2 / 3 + 37 * _n**3 / 96 - _n**4 / 360,
    _n**2 / 48 + _n**3 / 15 - 437 * _n**4 / 1440,
    17 * _n**3 / 480 - 37 * _n**4 / 840,
    4397 * _n**4 / 161280,
)
_DELTA = (
    2 * _n - 2 * _n**2 / 3 - 2 * _n**3 + 116 * _n**4 / 45,
    7 * _n**2 / 3 - 8 * _n**3 / 5 - 227 * _n**4 / 45,
    56 * _n**3 / 15 - 136 * _n**4 / 35,
    4279 * _n**4 / 630,
)
_C = 2 * math.sqrt(_n) / (1 + _n)


def zone_for(lon: float) -> int:
    return int(min(60, max(1, math.floor((lon + 180) / 6) + 1)))


def epsg_for(lon: float, lat: float) -> int:
    return (32600 if lat >= 0 else 32700) + zone_for(lon)


def zone_of_epsg(epsg: int) -> tuple[int, bool]:
    base, zone = divmod(int(epsg), 100)
    if base not in (326, 327) or not 1 <= zone <= 60:
        raise ValueError(f"not a WGS84 UTM epsg: {epsg}")
    return zone, base == 326


def central_meridian(zone: int) -> float:
    return zone * 6 - 183.0


def fwd(lon, lat, zone: int, northern: bool = True):
    """lon/lat degrees -> (easting, northing) metres."""
    phi = np.radians(np.asarray(lat, dtype=np.float64))
    lam = np.radians(np.asarray(lon, dtype=np.float64) - central_meridian(zone))
    sphi = np.sin(phi)
    t = np.sinh(np.arctanh(sphi) - _C * np.arctanh(_C * sphi))
    xi_p = np.arctan2(t, np.cos(lam))
    eta_p = np.arctanh(np.sin(lam) / np.sqrt(1 + t * t))
    xi, eta = xi_p.copy(), eta_p.copy()
    for j, a in enumerate(_ALPHA, start=1):
        xi = xi + a * np.sin(2 * j * xi_p) * np.cosh(2 * j * eta_p)
        eta = eta + a * np.cos(2 * j * xi_p) * np.sinh(2 * j * eta_p)
    e = E0 + K0 * _A * eta
    n = K0 * _A * xi + (0.0 if northern else N0_SOUTH)
    if np.ndim(e) == 0:
        return float(e), float(n)
    return e, n


def inv(easting, northing, zone: int, northern: bool = True):
    """(easting, northing) metres -> (lon, lat) degrees."""
    e = np.asarray(easting, dtype=np.float64)
    n = np.asarray(northing, dtype=np.float64) - (0.0 if northern else N0_SOUTH)
    xi = n / (K0 * _A)
    eta = (e - E0) / (K0 * _A)
    xi_p, eta_p = xi.copy(), eta.copy()
    for j, b in enumerate(_BETA, start=1):
        xi_p = xi_p - b * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
        eta_p = eta_p - b * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
    chi = np.arcsin(np.sin(xi_p) / np.cosh(eta_p))
    phi = chi.copy()
    for j, d in enumerate(_DELTA, start=1):
        phi = phi + d * np.sin(2 * j * chi)
    lam = np.arctan2(np.sinh(eta_p), np.cos(xi_p))
    lon = central_meridian(zone) + np.degrees(lam)
    lat = np.degrees(phi)
    if np.ndim(lon) == 0:
        return float(lon), float(lat)
    return lon, lat


def bbox_lonlat_to_utm(bbox4326, zone: int, northern: bool = True, samples: int = 8):
    """Enclosing UTM box of a lon/lat box (edges densified: the projected
    rectangle is curved, so corners alone under-cover it)."""
    w, s, e, nn = bbox4326
    ts = np.linspace(0.0, 1.0, samples + 1)
    lons = np.concatenate([w + (e - w) * ts, np.full_like(ts, e), w + (e - w) * ts, np.full_like(ts, w)])
    lats = np.concatenate([np.full_like(ts, s), s + (nn - s) * ts, np.full_like(ts, nn), s + (nn - s) * ts])
    x, y = fwd(lons, lats, zone, northern)
    return (float(x.min()), float(y.min()), float(x.max()), float(y.max()))


def bbox_utm_to_lonlat(bbox_utm, zone: int, northern: bool = True, samples: int = 8):
    """Enclosing lon/lat box of a UTM rectangle (edges densified)."""
    x0, y0, x1, y1 = bbox_utm
    ts = np.linspace(0.0, 1.0, samples + 1)
    xs = np.concatenate([x0 + (x1 - x0) * ts, np.full_like(ts, x1), x0 + (x1 - x0) * ts, np.full_like(ts, x0)])
    ys = np.concatenate([np.full_like(ts, y0), y0 + (y1 - y0) * ts, np.full_like(ts, y1), y0 + (y1 - y0) * ts])
    lon, lat = inv(xs, ys, zone, northern)
    return (float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max()))
