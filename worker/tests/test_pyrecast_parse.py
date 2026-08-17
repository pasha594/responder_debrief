"""gs01 national detection layers probe (rotating timestamped snapshots).

(gs02 spread caps parsing removed — spread forecasts are client-rendered from
the public forecast archive, see test_archives.py. gs01 HRRR weather parsing
removed earlier — weather is NOAA AWS now, see test_hrrr.py.)
"""

from responder_worker import pyrecast
from responder_worker.pyrecast import caps_url

NATIONAL_CAPS = b"""<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities xmlns="http://www.opengis.net/wms" version="1.3.0">
  <Capability><Layer>
    <Layer queryable="1"><Name>fire-detections_current-year-perimeters:current-year-perimeters_20260817_130700</Name></Layer>
    <Layer queryable="1"><Name>fire-detections_current-year-perimeters:current-year-perimeters_20260817_184800</Name></Layer>
    <Layer queryable="1"><Name>fire-detections_current-year-perimeters:current-year-perimeters_20260817_175600</Name></Layer>
    <Layer queryable="1"><Name>other-ws:not-a-perimeter_20260817_190000</Name></Layer>
  </Layer></Capability>
</WMS_Capabilities>
"""


def test_caps_url_namespace_filtered():
    url = caps_url("https://gs01.example/ows",
                   namespace="fire-detections_current-year-perimeters")
    assert url.startswith("https://gs01.example/ows?")
    assert "request=GetCapabilities" in url
    assert "namespace=fire-detections_current-year-perimeters" in url


def test_parse_gs01_national_layers_picks_newest():
    got = pyrecast.parse_gs01_national_layers(NATIONAL_CAPS)
    assert got is not None
    assert got["layer"] == (
        "fire-detections_current-year-perimeters:current-year-perimeters_20260817_184800"
    )
    assert got["as_of"] == "2026-08-17T18:48:00Z"


def test_parse_gs01_national_layers_empty():
    empty = b"""<?xml version="1.0"?><WMS_Capabilities xmlns="http://www.opengis.net/wms" version="1.3.0"><Capability><Layer/></Capability></WMS_Capabilities>"""
    assert pyrecast.parse_gs01_national_layers(empty) is None  # noqa
