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


def fire_key(cornea_id: str | None) -> str | None:
    """A fire's identity as a path-safe key: its cornea_id lowercased with
    the braces dropped ("{5152…-C13CE748EC08}" → "5152…-c13ce748ec08").
    The API writes the same id braced or bare, upper or lower case, so
    compare ids only through this. fire_slug is just the name, shared by
    unrelated fires and swapped between active ones; never key on it."""
    k = re.sub(r"[^0-9a-z-]", "", (cornea_id or "").lower())[:64]
    return k or None


_FIRE_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def is_fire_id(value: str | None) -> bool:
    """True for a cornea_id GUID in any spelling (braces, case). A fire slug
    or name is not one: names are shared between fires."""
    if not value or not re.fullmatch(r"\{?[0-9A-Fa-f-]+\}?", value.strip()):
        return False
    return bool(_FIRE_ID_RE.fullmatch(fire_key(value) or ""))


def slugify(name: str) -> str:
    """Lowercase, non-alnum runs -> single dash, trimmed."""
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower())
    return s.strip("-")


def fire_slug(fire: dict) -> str:
    return slugify(fire.get("post_title") or fire.get("cornea_id") or "unknown")


#: One page of the active-fires index. The fetch is not paginated, so a page
#: this full may be truncated: jobs that act on a fire's ABSENCE (migration,
#: prune) refuse to run on one.
ACTIVE_FIRES_LIMIT = 500
#: A list under this share of the previous catalog's active fires is taken
#: for a partial answer, not for that many fires going out at once.
MIN_ACTIVE_SHARE = 0.8


def fire_list_suspect(raw_rows: int, n_fires: int, prev_active: int | None) -> str | None:
    """Why an active-fire list may be incomplete, so that a fire missing
    from it proves nothing; None when it looks whole. `raw_rows` is
    fetch_active_fires' meta, `prev_active` the previous catalog's
    counts.active_fires."""
    if raw_rows >= ACTIVE_FIRES_LIMIT:
        return f"API returned {raw_rows} rows (page limit {ACTIVE_FIRES_LIMIT}): may be truncated"
    if prev_active and n_fires < MIN_ACTIVE_SHARE * prev_active:
        return (f"{n_fires} active fires, under {MIN_ACTIVE_SHARE:.0%} of the previous "
                f"catalog's {prev_active}")
    return None


def fetch_active_fires(client: httpx.Client, meta: dict | None = None) -> list[dict]:
    """GET /fires?active=true&limit=500&fields=... -> wildfires with parsed coords.

    `meta`, when given, receives `raw_rows`: how many rows the API returned
    before the wildfire filter (compare with ACTIVE_FIRES_LIMIT)."""
    resp = get(
        client,
        f"{config.FIRE_API}/fires",
        params={
            "active": "true",
            "limit": ACTIVE_FIRES_LIMIT,
            "fields": ",".join(FIRE_FIELDS),
        },
    )
    fires = resp.json().get("fires", [])
    if meta is not None:
        meta["raw_rows"] = len(fires)
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
        # bulk sweep -> dev instance (prod is reserved for live-site traffic)
        r = client.get(f"{config.FIRE_API_DEV}/fires/{cornea_id}/perimeters",
                       timeout=15)
        r.raise_for_status()
        d = r.json()
        return len(d) if isinstance(d, list) else None
    except Exception:
        return None
