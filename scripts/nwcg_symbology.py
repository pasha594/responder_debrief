#!/usr/bin/env python3
"""
Regenerate the Draw tab's official NWCG PMS 936 symbology.

    python3 scripts/nwcg_symbology.py [--zip Current_GeoOps_Folder_Structure.zip]

Stdlib only (Python 3.10+). Writes:
  frontend/src/map/nwcg/points/<id>.png   the 50 Event Point icons, byte-for-byte from NWCG
  frontend/src/map/nwcg/symbology.gen.ts  point sizes + every line style, as draw instructions

Sources — both official, both public:
  * Point icons: the PNGs on NWCG's PMS 936 Point Feature Symbology page
    https://www.nwcg.gov/publications/pms936/symbology/pms-936-point-feature-symbology
    (hosted on NWCG's S3 bucket; nwcg.gov itself sits behind a browser challenge).
  * Line styles and on-map point sizes: NIFC's GeoOps layer files, the CIM definitions
    ArcGIS Pro draws incident maps with — "Event Group - All Layers 2026.lyrx" inside
    "#2026 GeoOps Folder Structure" (nifc.maps.arcgis.com item e8459196b0324fa187ba3f407e08141e),
    linked from https://www.nwcg.gov/publications/pms936/symbology.

Where the layer file isn't enough, and what we did about it:
  * 14 line styles draw marks with characters from Esri fonts that ship with ArcGIS Pro, not
    with the layer files. GLYPHS stands in for them, measured from NWCG's own sample images on
    the Line Feature Symbology page (sizes as a fraction of the font size).
  * The one CMYK colour (Fence) uses the RGB ArcGIS itself renders for it.
  * Black parts of the styles NWCG draws in black get a light halo (HALO_STYLES) so they read
    on dark basemaps — PMS 936 lets the GISS "use halo ... while maintaining the essential
    design of the standard symbols". The halo itself is drawn by the app.

Output conventions (all lengths in points, 1/72 in; the app draws 1 pt = 4/3 CSS px):
  * Marks live in a frame where x runs along the line in the drawing direction and y points to
    the RIGHT of travel (down for a line drawn left to right), origin on the line.
  * CIM places along-line marks at k * spacing - offsetAlongLine; `at` holds those phases.
  * Dashed strokes keep their dash template (the app draws them as native line dashes).
"""
from __future__ import annotations

import argparse
import io
import json
import math
import re
import struct
import sys
import urllib.request
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'frontend' / 'src' / 'map' / 'nwcg'
ICON_DIR = OUT_DIR / 'points'
GEN_TS = OUT_DIR / 'symbology.gen.ts'

GEOOPS_ZIP_URL = ('https://nifc.maps.arcgis.com/sharing/rest/content/items/'
                  'e8459196b0324fa187ba3f407e08141e/data')
LYRX_NAME = 'Event Group - All Layers 2026.lyrx'
S3 = 'https://fs-prod-nwcg.s3.us-gov-west-1.amazonaws.com/styles/thumbnail/s3/'

# NWCG's Point Feature Symbology table: name -> (category column, image path on S3).
POINT_PAGE = {
    'Aerial Hazard': ('Air Ops', '2024-02/936-point-aerial-hazard_0.png'),
    'Airstrip or Airport': ('Air Ops', '2024-02/936-point-airport-reupload-test.png'),
    'Aviation Check Point': ('Air Ops', '2023-06/936-point-checkpoint.png'),
    'Branch Break': ('Assignment Break', '2023-06/936-point-break-branch.png'),
    'Bridge': ('Reference', '2023-06/936-point-bridge.png'),
    'Camp': ('Logistics', '2023-06/936-point-camp.png'),
    'Clean Up Area': ('Repair', '2023-06/936-point-clean-up.png'),
    'Closure': ('Logistics', '2023-06/936-point-closure.png'),
    'Culvert': ('Repair', '2023-06/936-point-culvert.png'),
    'Dip Site': ('Water', '2023-06/936-point-dip.png'),
    'Division Break': ('Assignment Break', '2023-06/936-point-break-division.png'),
    'Dozer Push': ('Repair', '2023-06/936-point-dozer-push.png'),
    'Draft Site': ('Water', '2025-01/936-point-draft-site.png'),
    'Drop Point': ('Logistics', '2023-06/936-point-drop-point.png'),
    'Fence - Cut/Damaged': ('Repair', '2023-06/936-point-fence-cut.png'),
    'Fire Origin': ('Fire', '2023-06/936-point-fire-origin.png'),
    'Fire Station': ('Reference', '2023-06/936-point-fire-station.png'),
    'Gate': ('Reference', '2023-06/936-point-gate.png'),
    'Hazard': ('Safety', '2023-06/936-point-hazard.png'),
    'Hazard Tree': ('Safety', '2025-01/936-point-hazard-tree.png'),
    'Helibase': ('Air Ops', '2023-06/936-point-helibase.png'),
    'Helispot': ('Air Ops', '2023-06/936-point-heli-spot.png'),
    'Hot Spot - Spot Fire': ('Fire', '2023-06/936-point-spot-fire.png'),
    'Hydrant': ('Water', '2024-02/936-point-hydrant_0.png'),
    'Incident Command Post': ('Logistics', '2023-06/936-point-icp.png'),
    'Internet Access': ('Communications', '2023-06/936-point-wifi.png'),
    'Invasive Plant': ('Repair', '2025-01/936-point-invasive-plant.png'),
    'Landing or Log Deck': ('Repair', '2023-06/936-point-landing-log-deck.png'),
    'Landmark': ('Reference', '2023-06/936-point-landmark.png'),
    'Lookout': ('Ops', '2023-06/936-point-lookout.png'),
    'Medical': ('Logistics', '2023-06/936-point-medical.png'),
    'Mobile Retardant Base': ('Air Ops', '2023-06/936-point-mobile-retardant-base.png'),
    'Mobile Weather Unit': ('Communications', '2023-06/936-point-wx.png'),
    'Other': ('Reference', '2023-06/936-point-other.png'),
    'Repair Point': ('Repair', '2023-06/936-point-repair-point.png'),
    'Repeater': ('Communications', '2023-06/936-point-repeater.png'),
    'Resource Location': ('Repair', '2023-06/936-point-resource-location.png'),
    'Restricted Water Source': ('Water', '2023-06/936-point-restricted-water-source.png'),
    'Retardant in Avoidance Area': ('Repair', '2023-06/936-point-rtd-in-avoid.png'),
    'Road Repair': ('Repair', '2024-01/936-point-road-repair.png'),
    'Safety Zone': ('Safety', '2023-06/936-point-safety-zone.png'),
    'Slash Pile': ('Repair', '2025-01/936-point-slash-pile.png'),
    'Sling Site': ('Air Ops', '2023-06/936-point-sling.png'),
    'Staging Area': ('Logistics', '2023-06/936-point-staging.png'),
    'Stream Crossing': ('Repair', '2023-06/936-point-stream-crossing.png'),
    'Structure Wrap': ('Repair', '2023-06/936-point-struct-wrap.png'),
    'UAS Launch and Recovery': ('Air Ops', '2024-02/936-point-uas-launch-and-recovery.png'),
    'Unimproved Landing Area': ('Air Ops', '2023-06/936-point-unimproved-landing.png'),
    'Value at Risk': ('Reference', '2023-06/936-point-value-at-risk.png'),
    'Zone Break': ('Assignment Break', '2023-06/936-point-zone-break.png'),
}

# NWCG's Line Feature Symbology table: page name -> (category column, layer-file class label).
LINE_PAGE = {
    'Access Route': ('Reference', 'Access Route'),
    'Aerial Hazard': ('Air Ops', 'Aerial Hazard'),
    'Aviation Route': ('Air Ops', 'Aviation Route'),
    'Break Line': ('Reference', 'Break Line'),
    'Completed Burnout': ('Ops Completed', 'Completed Burnout'),
    'Completed Dozer Line': ('Ops Completed', 'Completed Dozer Line'),
    'Completed Fuel Break': ('Ops Completed', 'Completed Fuel Break'),
    'Completed Hand Line': ('Ops Completed', 'Completed Hand Line'),
    'Completed Mixed Construction Line': ('Ops Completed', 'Completed Mixed Construction Line'),
    'Completed Plow Line': ('Ops Completed', 'Completed Plow Line'),
    'Completed Road as Line': ('Ops Completed', 'Completed Road as Line'),
    'Contained Fire Edge': ('Fire', 'Contained Fire Edge'),
    'Escape Route': ('Safety', 'Escape Route'),
    'Fence': ('Reference', 'Fence'),
    'Fire Edge (Field Collection)': ('Fire', 'Fire Edge (Field Collection)'),
    'Highlighted Feature': ('Reference', 'Highlighted Feature'),
    'Hoselay': ('Ops Completed', 'Hoselay'),
    'Management Action Point': ('Reference', 'Management Action Point'),
    'Other': ('Reference', 'Other'),
    'Planned Burnout': ('Planning', 'Planned Burnout'),
    'Planned Dozer Line': ('Planning', 'Planned Dozer Line'),
    'Planned Fuel Break': ('Planning', 'Planned Fuel Break'),
    'Planned Hand Line': ('Planning', 'Planned Hand Line'),
    'Planned Mixed Construction Line': ('Planning', 'Planned Mixed Construction Line'),
    'Planned Plow Line': ('Planning', 'Planned Plow Line'),
    'Planned Road as Line': ('Planning', 'Planned Road as Line'),
    'Proposed Line': ('Planning', 'Proposed Line'),
    'Repair Line': ('Repair', 'Repair Line'),
    'Retardant Drop': ('Air Ops', 'Retardant Drop'),
    'Road Repair': ('Repair', 'Road Repair'),
    'Temporary Flight Restriction': ('Air Ops', 'Temporary Flight Restriction'),
    'Uncontained': ('Fire', 'Uncontained Fire Edge'),
}

# Black-bodied symbols that get the light halo (the scope the user approved).
HALO_POINTS = {'Division Break', 'Branch Break', 'Zone Break', 'Lookout'}
HALO_STYLES = {
    'Hoselay', 'Completed Burnout', 'Completed Dozer Line', 'Completed Fuel Break',
    'Completed Hand Line', 'Completed Mixed Construction Line', 'Completed Plow Line',
    'Completed Road as Line', 'Highlighted Feature', 'Contained Fire Edge',
}

# ArcGIS's own sRGB rendering of the layer file's CMYK inks (NWCG sample + NIFC service agree).
CMYK_AS_RENDERED = {(0, 80, 71, 20): (204, 0, 23)}

# Esri font characters, as shapes in em units (1 em = the marker size), y up, centred on the
# placement point. Measured from NWCG's sample images (px per pt from each sample's spacing).
_HATCH = [  # ESRI Hazardous Materials 243: the dozer-line lattice (planned sample, 6.67 px/pt)
    [(-6.22, -4.2), (0.9, 4.2)], [(-3.6, 4.2), (3.52, -4.2)], [(-1.8, -4.2), (6.37, 4.2)],
    [(1.87, 4.2), (6.3, -1.2)], [(-4.05, -1.8), (-1.8, -4.2)],
]
GLYPHS = {
    # dots: burnout, highlighted feature and MAP samples all give 0.675 x size
    ('ESRI Default Marker', 33): [('circle', 0.3375)],
    # squares: escape route sample, 0.667 x size
    ('ESRI Default Marker', 34): [('rect', -0.3333, -0.3333, 0.3333, 0.3333)],
    # burnout tick: 1.2 pt x 11.7 pt at size 15, sitting 0.35 pt above its anchor
    ('ESRI Cartography', 74): [('rect', -0.04, -0.367, 0.04, 0.413)],
    ('ESRI Hazardous Materials', 243): [('lines', [[(x / 18, y / 18) for x, y in seg] for seg in _HATCH],
                                         0.52 / 18)],
    # planned construction lines' square (planned hand line sample: 3.0 pt at size 10)
    ('ESRI NIMA VMAP1&2 PT', 66): [('rect', -0.15, -0.15, 0.15, 0.15)],
}
# The Proposed Line sample draws the same character visibly bigger (6.7 pt at size 14).
GLYPH_OVERRIDES = {('Proposed Line', 'ESRI NIMA VMAP1&2 PT', 66): [('rect', -0.24, -0.24, 0.24, 0.24)]}


# ---------------------------------------------------------------- fetching

def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={'User-Agent': 'responder-debrief-symbology/1'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def load_lyrx(zip_path: str | None) -> dict:
    data = Path(zip_path).read_bytes() if zip_path else fetch(GEOOPS_ZIP_URL)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        name = next(n for n in z.namelist() if n.endswith('/' + LYRX_NAME))
        return json.loads(z.read(name).decode('utf-8-sig'))


# ---------------------------------------------------------------- PNG (content height only)

def png_content_height(data: bytes) -> int:
    """Rows spanned by pixels with alpha > 24 (8-bit RGBA, non-interlaced)."""
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    pos, idat = 8, b''
    while pos < len(data):
        (n,) = struct.unpack('>I', data[pos:pos + 4])
        kind, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b'IHDR':
            w, h, depth, colour, _, _, interlace = struct.unpack('>IIBBBBB', body)
        elif kind == b'IDAT':
            idat += body
    if (depth, colour, interlace) != (8, 6, 0):
        raise SystemExit(f'unexpected PNG format {depth}/{colour}/{interlace}')
    raw, stride, prev, rows, i = zlib.decompress(idat), w * 4, bytearray(w * 4), [], 0
    for y in range(h):
        ft, line = raw[i], bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - 4] if x >= 4 else 0
            b, c = prev[x], (prev[x - 4] if x >= 4 else 0)
            if ft == 1:
                line[x] = (line[x] + a) & 255
            elif ft == 2:
                line[x] = (line[x] + b) & 255
            elif ft == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif ft == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        if any(line[x] > 24 for x in range(3, stride, 4)):
            rows.append(y)
    return rows[-1] - rows[0] + 1


# ---------------------------------------------------------------- colours + numbers

def colour(c: dict | None) -> str:
    if not c:
        raise SystemExit('missing colour')
    v = c['values']
    if c['type'] == 'CIMRGBColor':
        r, g, b = v[:3]
    elif c['type'] == 'CIMCMYKColor':
        key = tuple(round(x) for x in v[:4])
        if key not in CMYK_AS_RENDERED:
            raise SystemExit(f'CMYK {key} needs an entry in CMYK_AS_RENDERED')
        r, g, b = CMYK_AS_RENDERED[key]
    else:
        raise SystemExit(f"unsupported colour {c['type']}")
    alpha = v[-1] / 100
    hexc = f'#{round(r):02x}{round(g):02x}{round(b):02x}'
    return hexc if alpha >= 0.999 else f'rgba({round(r)},{round(g)},{round(b)},{alpha:.2f})'


def is_dark(css: str) -> bool:
    m = re.match(r'#(..)(..)(..)', css)
    return bool(m) and max(int(g, 16) for g in m.groups()) < 64


def n(v: float) -> str:
    s = f'{v:.3f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def slug(label: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')


# ---------------------------------------------------------------- geometry -> SVG paths

class Xf:
    """Affine map from a marker's y-up frame into the output frame (x along, y right/down)."""

    def __init__(self, a=1.0, b=0.0, c=0.0, d=1.0, e=0.0, f=0.0):
        self.m = (a, b, c, d, e, f)  # x' = a x + c y + e ; y' = b x + d y + f (y-up)

    def then(self, o: 'Xf') -> 'Xf':
        a, b, c, d, e, f = self.m
        A, B, C, D, E, F = o.m
        return Xf(A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d,
                  A * e + C * f + E, B * e + D * f + F)

    def up(self, x: float, y: float) -> tuple[float, float]:
        a, b, c, d, e, f = self.m
        return a * x + c * y + e, b * x + d * y + f

    def pt(self, x: float, y: float) -> tuple[float, float]:
        X, Y = self.up(x, y)
        return X, -Y  # flip: y-down is the right-hand side of travel

    @property
    def scale(self) -> float:
        a, b, _, _, _, _ = self.m
        return math.hypot(a, b)


def translate(x, y):
    return Xf(e=x, f=y)


def scale(k):
    return Xf(a=k, d=k)


def rotate(deg):
    r = math.radians(deg)
    return Xf(math.cos(r), math.sin(r), -math.sin(r), math.cos(r))


def circumcentre(a, b, c):
    (ax, ay), (bx, by), (cx, cy) = a, b, c
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:
        return None
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return ux, uy


def arc_cmds(xf: Xf, centre, start, turn: int, span: float, rot=0.0, ratio=1.0) -> str:
    """A circular or elliptic arc in frame units (y up) as two SVG arcs of <= 180 deg each.
    turn: +1 counter-clockwise, -1 clockwise (frame space); span in parameter radians (2*pi =
    full ellipse); rot: major-axis angle (radians); ratio: minor / major axis."""
    cx, cy = centre
    cr, sr = math.cos(rot), math.sin(rot)
    qx, qy = start[0] - cx, start[1] - cy
    ux, uy = qx * cr + qy * sr, -qx * sr + qy * cr  # start in the ellipse's own axes
    major = math.hypot(ux, uy / ratio)
    t0 = math.atan2(uy / ratio, ux)
    a, b = major * xf.scale, major * ratio * xf.scale
    xf_rot = math.degrees(math.atan2(xf.m[1], xf.m[0]))
    phi = -(math.degrees(rot) + xf_rot)  # the output flips y
    sweep = 0 if turn > 0 else 1  # a CCW frame arc stays CCW on screen after the y flip
    out = []
    for f in (0.5, 1.0):
        t = t0 + turn * span * f
        ex, ey = major * math.cos(t), major * ratio * math.sin(t)
        x, y = xf.pt(cx + ex * cr - ey * sr, cy + ex * sr + ey * cr)
        out.append(f'A{n(a)} {n(b)} {n(phi % 360)} 0 {sweep} {n(x)} {n(y)}')
    return ''.join(out)


def arc_3pt(xf: Xf, start, mid, end) -> str:
    """Esri 'c' segment: the circular arc from start through mid to end (frame units)."""
    centre = circumcentre(start, mid, end)
    if centre is None:
        x, y = xf.pt(*end)
        return f'L{n(x)} {n(y)}'
    orient = (mid[0] - start[0]) * (end[1] - mid[1]) - (mid[1] - start[1]) * (end[0] - mid[0])
    turn = 1 if orient > 0 else -1
    a0 = math.atan2(start[1] - centre[1], start[0] - centre[0])
    a1 = math.atan2(end[1] - centre[1], end[0] - centre[0])
    span = ((a1 - a0) * turn) % (2 * math.pi) or 2 * math.pi
    return arc_cmds(xf, centre, start, turn, span)


def arc_centre(xf: Xf, start, seg: list) -> str:
    """Esri 'a' segment: [end, centre, minor, clockwise(, rotation, semi-major axis, ratio)]."""
    end, centre, minor, clockwise = seg[0], seg[1], seg[2], seg[3]
    rot, ratio = (seg[4], seg[6]) if len(seg) > 4 else (0.0, 1.0)
    turn = -1 if clockwise else 1

    def param(p):  # eccentric-anomaly angle of a point on the ellipse
        qx, qy = p[0] - centre[0], p[1] - centre[1]
        ux, uy = qx * math.cos(rot) + qy * math.sin(rot), -qx * math.sin(rot) + qy * math.cos(rot)
        return math.atan2(uy / ratio, ux)

    span = ((param(end) - param(start)) * turn) % (2 * math.pi)
    if span < 1e-9:
        span = 2 * math.pi  # start == end: the whole ellipse
    elif minor and span > math.pi + 1e-9:
        raise SystemExit('arc flagged minor spans more than 180 degrees')
    return arc_cmds(xf, centre, start, turn, span, rot, ratio)


def geom_path(geom: dict, xf: Xf) -> str:
    out = []
    for key, closed in (('rings', True), ('curveRings', True), ('paths', False), ('curvePaths', False)):
        for part in geom.get(key, []):
            cur = None
            for i, v in enumerate(part):
                if isinstance(v, list):
                    p = xf.pt(v[0], v[1])
                    out.append(f"{'M' if i == 0 else 'L'}{n(p[0])} {n(p[1])}")
                    cur = (v[0], v[1])
                elif 'b' in v:
                    (ex, ey), (c1x, c1y), (c2x, c2y) = v['b']
                    q1, q2, e = xf.pt(c1x, c1y), xf.pt(c2x, c2y), xf.pt(ex, ey)
                    out.append(f'C{n(q1[0])} {n(q1[1])} {n(q2[0])} {n(q2[1])} {n(e[0])} {n(e[1])}')
                    cur = (ex, ey)
                elif 'c' in v:
                    (ex, ey), (ix, iy) = v['c']
                    out.append(arc_3pt(xf, cur, (ix, iy), (ex, ey)))
                    cur = (ex, ey)
                elif 'a' in v:
                    out.append(arc_centre(xf, cur, v['a']))
                    cur = tuple(v['a'][0][:2])
                else:
                    raise SystemExit(f'unsupported curve segment {list(v)}')
            if closed:
                out.append('Z')
    return ''.join(out)


def glyph_paths(prims: list, xf: Xf) -> list[tuple[str, str, float | None]]:
    """[(path, kind, stroke width)] for a glyph; kind 'fill' or 'line'."""
    res = []
    for prim in prims:
        if prim[0] == 'circle':
            r = prim[1]
            (x0, y0), (x1, y1) = xf.pt(-r, 0), xf.pt(r, 0)
            rr = r * xf.scale
            res.append((f'M{n(x0)} {n(y0)}A{n(rr)} {n(rr)} 0 1 0 {n(x1)} {n(y1)}'
                        f'A{n(rr)} {n(rr)} 0 1 0 {n(x0)} {n(y0)}Z', 'fill', None))
        elif prim[0] == 'rect':
            _, x0, y0, x1, y1 = prim
            pts = [xf.pt(x, y) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
            res.append(('M' + 'L'.join(f'{n(x)} {n(y)}' for x, y in pts) + 'Z', 'fill', None))
        elif prim[0] == 'lines':
            _, segs, width = prim
            d = ''.join('M' + 'L'.join(f'{n(x)} {n(y)}' for x, y in (xf.pt(*p) for p in seg)) for seg in segs)
            res.append((d, 'line', width * xf.scale))
    return res


# ---------------------------------------------------------------- CIM -> shapes

def symbol_shapes(sym: dict, path: str, stroke_k: float, halo: bool, kind='fill') -> list[dict]:
    """Fill/stroke shapes for one polygon/line symbol applied to `path`, bottom → top."""
    shapes = []
    for sl in reversed(sym.get('symbolLayers', [])):
        if not sl.get('enable', True):
            continue
        if sl['type'] == 'CIMSolidFill':
            c = colour(sl['color'])
            s = {'d': path, 'fill': c} if kind == 'fill' else {'d': path, 'stroke': c, 'width': kind}
            if halo and is_dark(c):
                s['halo'] = True
            shapes.append(s)
        elif sl['type'] == 'CIMSolidStroke':
            c = colour(sl['color'])
            s = {'d': path, 'stroke': c, 'width': round(sl['width'] * stroke_k, 3),
                 'cap': sl.get('capStyle', 'Round').lower(), 'join': sl.get('joinStyle', 'Round').lower()}
            if halo and is_dark(c):
                s['halo'] = True
            shapes.append(s)
        else:
            raise SystemExit(f"unsupported marker symbol layer {sl['type']}")
    return shapes


def marker_shapes(ml: dict, parent: Xf, stroke_k: float, style: str, halo: bool) -> list[dict]:
    """Shapes of a vector/character marker whose placement point is `parent`'s origin."""
    off = translate(ml.get('offsetX', 0), ml.get('offsetY', 0))
    rot = rotate(ml.get('rotation', 0) or 0)
    if ml['type'] == 'CIMCharacterMarker':
        key = (ml['fontFamilyName'], ml['characterIndex'])
        prims = GLYPH_OVERRIDES.get((style,) + key) or GLYPHS.get(key)
        if prims is None:
            raise SystemExit(f'{style}: no stand-in for font glyph {key}')
        xf = scale(ml['size']).then(rot).then(off).then(parent)
        shapes = []
        for d, kind, width in glyph_paths(prims, xf):
            shapes += symbol_shapes(ml['symbol'], d, 1.0, halo, 'fill' if kind == 'fill' else round(width, 3))
        return shapes
    if ml['type'] != 'CIMVectorMarker':
        raise SystemExit(f"{style}: unsupported marker {ml['type']}")
    f = ml['frame']
    k = ml['size'] / (f['ymax'] - f['ymin'])
    cx, cy = (f['xmin'] + f['xmax']) / 2, (f['ymin'] + f['ymax']) / 2
    xf = translate(-cx, -cy).then(scale(k)).then(rot).then(off).then(parent)
    sk = stroke_k * (k if ml.get('scaleSymbolsProportionally') else 1.0)
    shapes = []
    for mg in ml.get('markerGraphics', []):
        g, sym = mg['geometry'], mg['symbol']
        if sym['type'] == 'CIMPointSymbol':  # a marker nested at a point of this frame
            at = translate(g['x'], g['y']).then(xf)
            for sub in reversed(sym['symbolLayers']):
                if sub.get('enable', True):
                    shapes += marker_shapes(sub, at, sk, style, halo)
            continue
        d = geom_path(g, xf)
        if sym['type'] == 'CIMLineSymbol':
            for sl in reversed(sym['symbolLayers']):
                if sl.get('enable', True):
                    c = colour(sl['color'])
                    s = {'d': d, 'stroke': c, 'width': round(sl['width'] * sk, 3),
                         'cap': sl.get('capStyle', 'Round').lower(), 'join': sl.get('joinStyle', 'Round').lower()}
                    if halo and is_dark(c):
                        s['halo'] = True
                    shapes.append(s)
        else:
            shapes += symbol_shapes(sym, d, sk, halo)
    return shapes


def path_points(d: str) -> list[tuple[float, float]]:
    """Points sampled along our own path data (M/L/C/A/Z) — for extents."""
    toks = re.findall(r'[MLCAZ]|-?\d+(?:\.\d+)?', d)
    pts, i, cur, cmd = [], 0, (0.0, 0.0), None
    while i < len(toks):
        if toks[i] in 'MLCAZ':
            cmd = toks[i]
            i += 1
            if cmd == 'Z':
                continue
        vals = lambda k: [float(t) for t in toks[i:i + k]]  # noqa: E731
        if cmd in ('M', 'L'):
            cur = tuple(vals(2))
            pts.append(cur)
            i += 2
        elif cmd == 'C':
            x1, y1, x2, y2, x, y = vals(6)
            x0, y0 = cur
            for s in range(1, 17):
                t = s / 16
                u = 1 - t
                pts.append((u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x,
                            u ** 3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y))
            cur = (x, y)
            i += 6
        elif cmd == 'A':
            rx, ry, phi, large, sweep, x, y = vals(7)
            pts += arc_samples(cur, (x, y), rx, ry, math.radians(phi), int(large), int(sweep))
            cur = (x, y)
            i += 7
    return pts


def arc_samples(p0, p1, rx, ry, phi, large, sweep, steps=24):
    """SVG endpoint arc → sampled points (SVG spec F.6.5 centre conversion)."""
    (x1, y1), (x2, y2) = p0, p1
    if rx == 0 or ry == 0 or (x1, y1) == (x2, y2):
        return [p1]
    cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = cp * dx + sp * dy, -sp * dx + cp * dy
    lam = (x1p / rx) ** 2 + (y1p / ry) ** 2
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    co = math.sqrt(max(0.0, num / den)) * (-1 if large == sweep else 1)
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx, cy = cp * cxp - sp * cyp + (x1 + x2) / 2, sp * cxp + cp * cyp + (y1 + y2) / 2
    ang = lambda ux, uy: math.atan2(uy, ux)  # noqa: E731
    t1 = ang((x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((-x1p - cxp) / rx, (-y1p - cyp) / ry) - t1
    if sweep and dt < 0:
        dt += 2 * math.pi
    elif not sweep and dt > 0:
        dt -= 2 * math.pi
    return [(cx + rx * math.cos(t1 + dt * s / steps) * cp - ry * math.sin(t1 + dt * s / steps) * sp,
             cy + rx * math.cos(t1 + dt * s / steps) * sp + ry * math.sin(t1 + dt * s / steps) * cp)
            for s in range(1, steps + 1)]


def shapes_box(shapes: list[dict]) -> list[float]:
    """[minX, minY, maxX, maxY] of a mark's ink, stroke widths included (points)."""
    x0 = y0 = math.inf
    x1 = y1 = -math.inf
    for s in shapes:
        pad = (s.get('width') or 0) / 2 if 'stroke' in s else 0
        for x, y in path_points(s['d']):
            x0, y0, x1, y1 = min(x0, x - pad), min(y0, y - pad), max(x1, x + pad), max(y1, y + pad)
    return [round(v, 2) for v in (x0, y0, x1, y1)]


def line_parts(label: str, sym: dict) -> list[dict]:
    halo = label in HALO_STYLES
    parts = []
    for sl in reversed(sym['symbolLayers']):  # CIM lists top first; emit bottom → top
        if not sl.get('enable', True):
            continue
        t = sl['type']
        if t == 'CIMSolidStroke':
            c = colour(sl['color'])
            cap = sl.get('capStyle', 'Round').lower()
            effects = {e['type']: e for e in sl.get('effects') or []}
            dash = effects.pop('CIMGeometricEffectDashes', None)
            offset = effects.pop('CIMGeometricEffectOffset', None)
            if effects:
                raise SystemExit(f'{label}: unsupported line effects {list(effects)}')
            p = {'kind': 'stroke', 'color': c, 'width': sl['width'], 'cap': cap,
                 'join': sl.get('joinStyle', 'Round').lower()}
            if dash:
                if offset or dash.get('lineDashEnding', 'NoConstraint') != 'NoConstraint':
                    raise SystemExit(f'{label}: unsupported dash settings {dash}')
                p['dash'] = dash['dashTemplate']
            if offset:
                p['offset'] = -offset['offset']  # CIM + is left of travel; ours + is right
            if halo and is_dark(c):
                p['halo'] = True
            parts.append(p)
        elif t in ('CIMVectorMarker', 'CIMCharacterMarker'):
            mp = sl['markerPlacement']
            mtype = mp['type']
            upright = not mp.get('angleToLine', False)
            across = translate(0, mp.get('offset', 0))  # CIM + is left of travel (y up)
            shapes = marker_shapes(sl, across, 1.0, label, halo)
            if mtype == 'CIMMarkerPlacementAlongLineSameSize':
                tmpl = mp['placementTemplate']
                period = sum(tmpl)
                starts = [sum(tmpl[:i]) for i in range(len(tmpl))]
                at = sorted({round((s - mp.get('offsetAlongLine', 0)) % period, 3) for s in starts})
                parts.append({'kind': 'marks', 'period': period, 'at': at, 'upright': upright,
                              'box': shapes_box(shapes), 'shapes': shapes})
                if mp.get('endings') == 'WithMarkers':
                    parts.append({'kind': 'ends', 'inset': 0, 'flipFirst': False,
                                  'box': shapes_box(shapes), 'shapes': shapes})
            elif mtype == 'CIMMarkerPlacementAtRatioPositions':
                if mp.get('positionArray') != [0, 1] or mp.get('beginPosition') != mp.get('endPosition'):
                    raise SystemExit(f'{label}: unsupported ratio placement {mp}')
                parts.append({'kind': 'ends', 'inset': mp.get('beginPosition', 0),
                              'flipFirst': bool(mp.get('flipFirst')), 'box': shapes_box(shapes),
                              'shapes': shapes})
            else:
                raise SystemExit(f'{label}: unsupported placement {mtype}')
        else:
            raise SystemExit(f'{label}: unsupported symbol layer {t}')
    return parts


# ---------------------------------------------------------------- emit

def ts_value(v, indent=0) -> str:
    pad = '  ' * indent
    if isinstance(v, dict):
        items = [f"{pad}  {k}: {ts_value(x, indent + 1)}," for k, x in v.items()]
        return '{\n' + '\n'.join(items) + f'\n{pad}}}'
    if isinstance(v, list):
        if all(isinstance(x, (int, float)) for x in v):
            return '[' + ', '.join(n(x) for x in v) + ']'
        return '[\n' + '\n'.join(f'{pad}  {ts_value(x, indent + 1)},' for x in v) + f'\n{pad}]'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return n(v)
    return json.dumps(v)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--zip', help='local copy of Current_GeoOps_Folder_Structure.zip (else downloaded)')
    args = ap.parse_args()

    lyrx = load_lyrx(args.zip)
    layers = {ld['name']: ld for ld in lyrx['layerDefinitions']}

    # ---- points: official PNGs sized by the layer file
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    points, cats = [], []
    for g in layers['Event Point']['renderer']['groups']:
        for c in g['classes']:
            label = c['label']
            category, s3path = POINT_PAGE[label]
            ml = next(s for s in c['symbol']['symbol']['symbolLayers'] if s.get('enable', True))
            f = ml['frame']
            frame_h = f['ymax'] - f['ymin']
            content_h = content_extent_h(ml)
            png = fetch(S3 + s3path)
            pid = slug(label)
            (ICON_DIR / f'{pid}.png').write_bytes(png)
            # image px per CSS px so the icon's artwork is as tall as the layer file draws it
            art_px = ml['size'] * content_h / frame_h * 4 / 3
            ratio = png_content_height(png) / art_px
            points.append({'id': pid, 'label': label, 'category': category, 'sizePt': ml['size'],
                           'pixelRatio': round(ratio, 4), **({'halo': True} if label in HALO_POINTS else {})})
            if category not in cats:
                cats.append(category)
            print(f'  point {label}: {ml["size"]} pt, pixelRatio {ratio:.3f}')
    if len(points) != len(POINT_PAGE):
        raise SystemExit(f'layer file has {len(points)} Event Point classes, page has {len(POINT_PAGE)}')

    # ---- lines: every class of Event Line + Perimeter Line, named as on NWCG's page
    by_label = {}
    for lname in ('Event Line', 'Perimeter Line'):
        for g in layers[lname]['renderer']['groups']:
            for c in g['classes']:
                by_label[c['label']] = c['symbol']['symbol']
    order = [lbl for lbl in by_label]  # layer-file legend order
    page_by_file = {v[1]: (k, v[0]) for k, v in LINE_PAGE.items()}
    lines, line_cats = [], []
    for file_label in order:
        if file_label not in page_by_file:
            raise SystemExit(f'layer-file line {file_label!r} is not on the NWCG page table')
        page_name, category = page_by_file[file_label]
        parts = line_parts(page_name, by_label[file_label])
        lines.append({'id': slug(page_name), 'label': page_name, 'category': category, 'parts': parts})
        if category not in line_cats:
            line_cats.append(category)
        print(f'  line {page_name}: {len(parts)} parts')
    if len(lines) != len(LINE_PAGE):
        raise SystemExit(f'{len(lines)} line styles vs {len(LINE_PAGE)} on the page')

    body = [
        '/* generated by scripts/nwcg_symbology.py — do not edit */',
        '/**',
        ' * Official NWCG PMS 936 symbology for the Draw tab. Point icons are NWCG\'s own PNGs',
        ' * (./points), sized by NIFC\'s 2026 GeoOps layer files; line styles are those layer',
        ' * files\' CIM definitions as draw instructions. Lengths in points (1 pt = 4/3 CSS px).',
        ' * Marks: x along the drawing direction, y to the right of travel, origin on the line.',
        ' */',
        '',
        'export interface NwcgShape {',
        '  /** SVG path data, in points. */',
        '  d: string;',
        '  fill?: string;',
        '  stroke?: string;',
        '  width?: number;',
        '  cap?: \'butt\' | \'round\' | \'square\';',
        '  join?: \'miter\' | \'round\' | \'bevel\';',
        '  /** Black ink that gets the light halo on dark basemaps. */',
        '  halo?: boolean;',
        '}',
        '',
        'export type NwcgLinePart =',
        '  | {',
        '      kind: \'stroke\';',
        '      color: string;',
        '      width: number;',
        '      cap: \'butt\' | \'round\' | \'square\';',
        '      join: \'miter\' | \'round\' | \'bevel\';',
        '      /** Dash, gap, dash, … lengths from the start of the line. */',
        '      dash?: number[];',
        '      /** Perpendicular shift, + to the right of travel. */',
        '      offset?: number;',
        '      halo?: boolean;',
        '    }',
        '  | {',
        '      kind: \'marks\';',
        '      /** Repeat distance; marks sit at each `at` phase within it. */',
        '      period: number;',
        '      at: number[];',
        '      /** Upright marks keep their orientation instead of turning with the line. */',
        '      upright: boolean;',
        '      /** Ink extent of one mark around its anchor: [minX, minY, maxX, maxY]. */',
        '      box: [number, number, number, number];',
        '      shapes: NwcgShape[];',
        '    }',
        '  | {',
        '      kind: \'ends\';',
        '      /** Distance in from each end of the line. */',
        '      inset: number;',
        '      flipFirst: boolean;',
        '      box: [number, number, number, number];',
        '      shapes: NwcgShape[];',
        '    };',
        '',
        'export interface NwcgLineStyle {',
        '  id: string;',
        '  label: string;',
        '  category: string;',
        '  /** Bottom → top. */',
        '  parts: NwcgLinePart[];',
        '}',
        '',
        'export interface NwcgPointSymbol {',
        '  id: string;',
        '  label: string;',
        '  category: string;',
        '  sizePt: number;',
        '  /** Image px per CSS px that draws the PNG at the layer file\'s size. */',
        '  pixelRatio: number;',
        '  halo?: boolean;',
        '}',
        '',
        f'export const NWCG_POINT_CATEGORIES = {json.dumps(cats)};',
        '',
        f'export const NWCG_POINTS: NwcgPointSymbol[] = {ts_value(points)};',
        '',
        f'export const NWCG_LINE_CATEGORIES = {json.dumps(line_cats)};',
        '',
        f'export const NWCG_LINES: NwcgLineStyle[] = {ts_value(lines)};',
        '',
    ]
    GEN_TS.write_text('\n'.join(body))
    print(f'wrote {GEN_TS.relative_to(ROOT)} and {len(points)} icons in {ICON_DIR.relative_to(ROOT)}')


def content_extent_h(ml: dict) -> float:
    """Height of a point marker's artwork in its frame units (strokes included)."""
    ys = []
    for mg in ml.get('markerGraphics', []):
        g = mg['geometry']
        sw = 0.0
        for sl in mg['symbol'].get('symbolLayers', []):
            if sl.get('enable', True) and sl['type'] == 'CIMSolidStroke':
                sw = max(sw, sl.get('width', 0))
        for key in ('rings', 'curveRings', 'paths', 'curvePaths'):
            for part in g.get(key, []):
                for v in part:
                    y = v[1] if isinstance(v, list) else next(v[k][0][1] for k in ('b', 'c', 'a') if k in v)
                    ys += [y - sw / 2, y + sw / 2]
    return max(ys) - min(ys)


if __name__ == '__main__':
    sys.exit(main())
