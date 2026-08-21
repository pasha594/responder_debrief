"""Fire API access: active fires index + slug/coordinate helpers.

Read-only GETs against https://fire-api-prod.web.app. NEVER calls POST /ingest.
"""

from __future__ import annotations

import re

import httpx

from . import config
from .http import get

# Slim field list for the index fetch (one ~125 KB page for all active fires).
FIRE_FIELDS = [
    "cornea_id",
    "post_title",
    "fire_coordinates",
    "state",
    "acres",
    "containment",
    "active",
    "contained_at",
    "firetype",
    "created_on",
    "last_updated",
    "poly_last_updated",
    "timezone",
    "unique_slug",
    "unique_fire_id",
]


def parse_fire_coordinates(value: str | None) -> list[float] | None:
    """Parse the API's '"lat, lon"' string into [lon, lat] (GeoJSON order)."""
    if not value:
        return None
    parts = [p.strip() for p in str(value).split(",")]
    if len(parts) != 2:
        return None
    try:
        lat, lon = float(parts[0]), float(parts[1])
    except ValueError:
        return None
    return [lon, lat]


def slugify(name: str) -> str:
    """Lowercase, non-alnum runs -> single dash, trimmed."""
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower())
    return s.strip("-")


def fire_slug(fire: dict) -> str:
    return slugify(fire.get("post_title") or fire.get("cornea_id") or "unknown")


def fetch_active_fires(client: httpx.Client) -> list[dict]:
    """GET /fires?active=true&limit=500&fields=... -> wildfires with parsed coords."""
    resp = get(
        client,
        f"{config.FIRE_API}/fires",
        params={
            "active": "true",
            "limit": 500,
            "fields": ",".join(FIRE_FIELDS),
        },
    )
    fires = resp.json().get("fires", [])
    out: list[dict] = []
    seen_slugs: dict[str, int] = {}
    for f in fires:
        if (f.get("firetype") or "").lower() != "wildfire":
            continue
        f = dict(f)
        f["coordinates"] = parse_fire_coordinates(f.get("fire_coordinates"))
        slug = fire_slug(f)
        # de-dupe identical name slugs (append state, then counter)
        if slug in seen_slugs:
            alt = f"{slug}-{(f.get('state') or 'xx').lower()}"
            if alt in seen_slugs:
                seen_slugs[slug] += 1
                alt = f"{slug}-{seen_slugs[slug]}"
            slug = alt
        seen_slugs.setdefault(slug, 1)
        f["fire_slug"] = slug
        out.append(f)
    return out


def fetch_perimeter_count(client: httpx.Client, cornea_id: str) -> int | None:
    """Number of published perimeter versions for one fire (index length)."""
    try:
        r = client.get(f"{config.FIRE_API}/fires/{cornea_id}/perimeters",
                       timeout=15)
        r.raise_for_status()
        d = r.json()
        return len(d) if isinstance(d, list) else None
    except Exception:
        return None
