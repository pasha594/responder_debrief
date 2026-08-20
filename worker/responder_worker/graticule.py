"""Georeference flat map sheets from their graticule TEXT labels.

Many IMT sheets lose their embedded georeferencing on export but keep the
vector text layer — including the lat/long labels along the map frame
(validated live: Big Grass sheets carry 60-140 of them; fully flattened
exports have none and simply fall through). `pdftotext -bbox` yields every
label WITH its page position; latitude is (approximately) linear in y and
longitude in x on a north-up sheet, so two robust line fits recover an
axis-aligned mapping, validated hard before anyone trusts it:

  - >= MIN_LABELS kept per axis after outlier rejection (inset overview maps
    contribute strays), >= 2 distinct values each
  - fit RMS <= RMS_MAX_DEG on both axes
  - north-up orientation (lat decreasing with y, lon increasing with x)
  - plausible CONUS-ish bounds and sheet span

The result feeds GCPs into the ordinary GDAL pipeline; accuracy on real
sheets measured at ~0.0002-0.005 deg RMS (tens to a few hundred meters) —
briefing-overlay grade, not survey grade.
"""

from __future__ import annotations

import html
import re
import shutil
import statistics
import subprocess
from dataclasses import dataclass
from pathlib import Path

# <word xMin=".." yMin=".." xMax=".." yMax="..">text</word> (pdftotext -bbox)
_WORD_RE = re.compile(
    r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>')
_PAGE_RE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)"')

# 42°55'N · 117°10'0"W · 117°13.5'W · -116°59' · 43°21'
_COORD_RE = re.compile(
    r"^(-?)(\d{1,3})\s*[°º]\s*"
    r"(?:(\d{1,2}(?:\.\d+)?)\s*['′])?\s*"
    r"(?:(\d{1,2}(?:\.\d+)?)\s*[\"″])?\s*"
    r"([NSEW])?$")

MIN_LABELS = 3
RMS_MAX_DEG = 0.005
SPAN_DEG = (0.02, 6.0)
LON_RANGE = (-170.0, -60.0)
LAT_RANGE = (15.0, 72.0)


@dataclass
class GraticuleFit:
    """lon = lon_a*x + lon_b ; lat = lat_a*y + lat_b (page points, y down)."""
    lon_a: float
    lon_b: float
    lat_a: float
    lat_b: float
    page_w: float
    page_h: float
    # map-frame bbox in page points (label extremes + padding) for cropping
    frame_pts: tuple[float, float, float, float]
    n_lat: int
    n_lon: int
    rms_lat: float
    rms_lon: float

    def lon_of_x(self, x: float) -> float:
        return self.lon_a * x + self.lon_b

    def lat_of_y(self, y: float) -> float:
        return self.lat_a * y + self.lat_b

    @property
    def rms_max(self) -> float:
        return max(self.rms_lat, self.rms_lon)

    def gcps_points(self) -> list[tuple[float, float, float, float]]:
        """(x_pt, y_pt, lon, lat) at the page corners — scale x/y by dpi/72
        for a raster rendered at `dpi`."""
        return [
            (x, y, self.lon_of_x(x), self.lat_of_y(y))
            for x in (0.0, self.page_w)
            for y in (0.0, self.page_h)
        ]

    def frame_bounds_4326(self) -> tuple[float, float, float, float]:
        """[w, s, e, n] of the map frame (crops the title-block collar)."""
        x0, y0, x1, y1 = self.frame_pts
        lons = sorted((self.lon_of_x(x0), self.lon_of_x(x1)))
        lats = sorted((self.lat_of_y(y0), self.lat_of_y(y1)))
        return (lons[0], lats[0], lons[1], lats[1])


def pdftotext_available() -> bool:
    return shutil.which("pdftotext") is not None


def parse_coord(text: str) -> tuple[str, float] | None:
    """('lat'|'lon', signed degrees) or None. Unhemisphered, unsigned values
    use the CONUS convention: >= 60° reads as a WEST longitude."""
    m = _COORD_RE.match(text.strip())
    if not m:
        return None
    sign, deg, mins, secs, hem = m.groups()
    deg_i = int(deg)
    if deg_i > 180 or float(mins or 0) >= 60 or float(secs or 0) >= 60:
        return None
    v = deg_i + float(mins or 0) / 60 + float(secs or 0) / 3600
    if hem in ("N", "S"):
        return ("lat", -v if hem == "S" else v)
    if hem in ("E", "W"):
        return ("lon", -v if hem == "W" else v)
    if sign == "-":
        return ("lon", -v) if deg_i >= 60 else ("lat", -v)
    # bare value: CONUS heuristic
    return ("lon", -v) if deg_i >= 60 else ("lat", v)


def fit_axis(pairs: list[tuple[float, float]]
             ) -> tuple[float, float, list[tuple[float, float]], float] | None:
    """Least-squares line with iterative median-based outlier rejection.
    Returns (slope, intercept, kept_pairs, rms) or None."""
    a = b = 0.0
    for _ in range(3):
        n = len(pairs)
        if n < 2:
            return None
        sx = sum(p[0] for p in pairs)
        sy = sum(p[1] for p in pairs)
        sxx = sum(p[0] * p[0] for p in pairs)
        sxy = sum(p[0] * p[1] for p in pairs)
        d = n * sxx - sx * sx
        if abs(d) < 1e-9:
            return None
        a = (n * sxy - sx * sy) / d
        b = (sy - a * sx) / n
        res = [abs(p[1] - (a * p[0] + b)) for p in pairs]
        med = statistics.median(res) or 1e-6
        kept = [p for p, r in zip(pairs, res) if r <= max(3 * med, 1e-4)]
        if len(kept) == len(pairs):
            break
        pairs = kept
    rms = (sum((p[1] - (a * p[0] + b)) ** 2 for p in pairs) / len(pairs)) ** 0.5
    return a, b, pairs, rms


def extract_words(pdf_path: Path) -> tuple[list[tuple[float, float, str]],
                                           tuple[float, float]] | None:
    """Page-1 words as (center_x, center_y, text) in PDF points, plus the
    page size. None when pdftotext is missing or the PDF has no text layer."""
    if not pdftotext_available():
        return None
    res = subprocess.run(
        ["pdftotext", "-bbox", "-l", "1", str(pdf_path), "-"],
        capture_output=True, text=True, timeout=120,
    )
    if res.returncode != 0:
        return None
    xml = res.stdout.split("</page>", 1)[0]
    pg = _PAGE_RE.search(xml)
    if not pg:
        return None
    words = [
        ((float(x0) + float(x1)) / 2, (float(y0) + float(y1)) / 2,
         html.unescape(t))
        for x0, y0, x1, y1, t in _WORD_RE.findall(xml)
    ]
    if not words:
        return None
    return words, (float(pg.group(1)), float(pg.group(2)))


def solve_from_words(words: list[tuple[float, float, str]],
                     page: tuple[float, float]) -> GraticuleFit | None:
    """Fit + validate the graticule mapping from positioned words."""
    lat_pairs: list[tuple[float, float]] = []
    lon_pairs: list[tuple[float, float]] = []
    for cx, cy, text in words:
        parsed = parse_coord(text)
        if not parsed:
            continue
        axis, v = parsed
        if axis == "lat":
            lat_pairs.append((cy, v))
        else:
            lon_pairs.append((cx, v))

    flat = fit_axis(lat_pairs)
    flon = fit_axis(lon_pairs)
    if not flat or not flon:
        return None
    lat_a, lat_b, lat_kept, rms_lat = flat
    lon_a, lon_b, lon_kept, rms_lon = flon

    if (len(lat_kept) < MIN_LABELS or len(lon_kept) < MIN_LABELS
            or len({p[1] for p in lat_kept}) < 2
            or len({p[1] for p in lon_kept}) < 2):
        return None
    if rms_lat > RMS_MAX_DEG or rms_lon > RMS_MAX_DEG:
        return None
    if lat_a >= 0 or lon_a <= 0:  # must be north-up
        return None

    w, h = page
    fit = GraticuleFit(
        lon_a=lon_a, lon_b=lon_b, lat_a=lat_a, lat_b=lat_b,
        page_w=w, page_h=h,
        frame_pts=_frame(lat_kept, lon_kept, w, h),
        n_lat=len(lat_kept), n_lon=len(lon_kept),
        rms_lat=rms_lat, rms_lon=rms_lon,
    )

    wl, sl, el, nl = fit.frame_bounds_4326()
    if not (SPAN_DEG[0] <= el - wl <= SPAN_DEG[1]
            and SPAN_DEG[0] <= nl - sl <= SPAN_DEG[1]):
        return None
    cx, cy = (wl + el) / 2, (sl + nl) / 2
    if not (LON_RANGE[0] <= cx <= LON_RANGE[1] and LAT_RANGE[0] <= cy <= LAT_RANGE[1]):
        return None
    return fit


def _median_spacing(coords: list[float]) -> float:
    vals = sorted(set(round(c, 1) for c in coords))
    gaps = [b - a for a, b in zip(vals, vals[1:]) if b - a > 1.0]
    return statistics.median(gaps) if gaps else 0.0


def _frame(lat_kept, lon_kept, w: float, h: float
           ) -> tuple[float, float, float, float]:
    """Map-frame bbox ≈ the label extremes padded by ~half a graticule
    spacing (the frame edge sits at most about one grid interval past the
    outermost label), clamped to the page. Errs toward keeping map margin
    over shaving it; any over-reach into the collar is cosmetic."""
    xs = [p[0] for p in lon_kept]
    ys = [p[0] for p in lat_kept]
    pad_x = max(0.01 * w, 0.5 * _median_spacing(xs))
    pad_y = max(0.01 * h, 0.5 * _median_spacing(ys))
    return (
        max(0.0, min(xs) - pad_x),
        max(0.0, min(ys) - pad_y),
        min(w, max(xs) + pad_x),
        min(h, max(ys) + pad_y),
    )


def solve(pdf_path: Path) -> GraticuleFit | None:
    """End to end: text layer -> validated graticule fit, or None."""
    try:
        extracted = extract_words(Path(pdf_path))
        if extracted is None:
            return None
        words, page = extracted
        return solve_from_words(words, page)
    except Exception:
        return None
