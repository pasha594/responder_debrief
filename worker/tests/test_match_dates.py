"""The mirror job's side of the date sanity check: dating a folder from the
listings it already makes, and re-validating matches cached in state (the
bound fire found by fire ID, the folder dated by its own uploads)."""
from types import SimpleNamespace

from responder_worker import cli
from responder_worker.fires import fire_key
from responder_worker.matching import IncidentCandidate


def _entry(name, mtime, is_dir=False, url=None):
    return SimpleNamespace(name=name, mtime=mtime, is_dir=is_dir,
                           url=url or f"https://x/{name}{'/' if is_dir else ''}")


def test_gather_unit_tokens_dates_the_folder(monkeypatch):
    listings = {
        "https://x/2026_Corral/": [
            _entry("Products", "2026-04-25 19:40", True, "https://x/2026_Corral/Products/"),
            _entry("IR", "2026-04-24 18:11", True, "https://x/2026_Corral/IR/"),
        ],
        "https://x/2026_Corral/Products/": [
            _entry("20260425", "2026-04-26 02:00", True, "https://x/2026_Corral/Products/20260425/"),
        ],
        "https://x/2026_Corral/Products/20260425/": [
            _entry("ops_11x17_land_20260425_1955_Corral_AZASF000120_0426day.pdf", "2026-04-26 02:00"),
            _entry("brief_arch_e_land_20260425_1949_Corral_AZASF000120_0426day.pdf", "2026-04-26 01:58"),
        ],
    }
    monkeypatch.setattr(cli, "list_dir", lambda client, url: listings[url])
    cand = IncidentCandidate(region="southwest", year=2026, dir_name="2026_Corral",
                             dir_url="https://x/2026_Corral/", dir_mtime="2026-04-24 18:11")
    tokens = cli._gather_unit_tokens(None, cand)
    assert tokens == {"2026-AZASF-000120": 2}
    assert cand.newest_file_mtime == "2026-04-26 02:00"
    assert cand.newest_dir_mtime == "2026-04-26 02:00"
    assert cand.newest_activity == "2026-04-26 02:00"


CORRALS_NM = "{E42E66D2-0000-4000-8000-000000000001}"
CORRAL_AZ = "{00B5F441-0000-4000-8000-000000000002}"
APRIL = "Sun, 26 Apr 2026 02:00:33 GMT"


def _rec(method="name_fuzzy", cornea_id=CORRALS_NM, lm=APRIL, **kw):
    """southwest/2026_Corral: April's Arizona sheets, cached as a name match
    to a fire. Its fire_slug names whatever fire held 'corrals' when it was
    first mirrored; only cornea_id says which fire it is bound to."""
    rec = {"fire_slug": "corrals", "storage_prefix": "corrals", "cornea_id": cornea_id,
           "match": {"method": method, "confidence": 0.923},
           "dir_mtime": "2026-04-24 18:11",
           "files": {"products/20260425/ops_11x17_land_20260425_1955_Corral_AZASF000120.pdf":
                     {"sha16": "aa", "lm": lm}},
           # merged across the fire's folders by the old manifest build:
           # never the folder's own evidence
           "latest_upload_ts": "2026-09-30T00:00:00Z", "latest_upload": "2026-09-30"}
    rec.update(kw)
    return rec


def _fires(*fires):
    return {fire_key(f["cornea_id"]): f for f in fires}


NM = {"fire_slug": "corrals", "cornea_id": CORRALS_NM, "created_on": "2026-09-17T19:53:09Z"}
FIRES = _fires(NM)


def test_cached_fuzzy_match_to_a_much_newer_fire_is_rejected():
    reason = cli._cached_match_predates_fire(_rec(), FIRES)
    assert reason and "2026-04-26T02:00:33Z" in reason and "7 days" in reason
    assert cli._cached_match_predates_fire(_rec(method="name_exact"), FIRES)


def test_cached_check_looks_up_fire_by_id_not_slug():
    # The folder is bound to April's Arizona fire. The 'corrals' slug now
    # names September's New Mexico fire, which a slug lookup would have
    # compared it to (and detached it, as it did WA Twin Sisters).
    az = {"fire_slug": "corral", "cornea_id": CORRAL_AZ, "created_on": "2026-04-20T00:00:00Z"}
    fires = _fires(NM, az)
    assert cli._cached_match_predates_fire(_rec(cornea_id=CORRAL_AZ), fires) is None
    # any spelling of the bound id finds the fire
    bare = _rec(cornea_id=CORRALS_NM.strip("{}").lower())
    assert cli._cached_match_predates_fire(bare, fires)


def test_cached_check_inactive_fire_is_noop():
    assert cli._cached_match_predates_fire(_rec(), {}) is None
    # bound to a fire that is no longer active, while a same-slug fire is
    other = {"fire_slug": "corrals", "cornea_id": CORRAL_AZ, "created_on": "2026-09-20T00:00:00Z"}
    assert cli._cached_match_predates_fire(_rec(), _fires(other)) is None


def test_cached_check_dates_the_folder_by_its_own_uploads():
    # One recent map upload of its own is enough to keep the match; the
    # fire-wide merged latest_upload* never counts, nor do template files.
    recent = _rec()
    recent["files"]["products/20260918/ops_corral_0918.pdf"] = {
        "sha16": "bb", "lm": "Fri, 18 Sep 2026 08:00:00 GMT"}
    assert cli._cached_match_predates_fire(recent, FIRES) is None
    template = _rec()
    template["files"]["products/yymmdd/ops_template.pdf"] = {
        "sha16": "cc", "lm": "Fri, 18 Sep 2026 08:00:00 GMT"}
    assert cli._cached_match_predates_fire(template, FIRES)
    # no map file with an upload time: the folder's listing mtimes stand in
    bare = _rec(files={}, dir_mtime="2026-04-24 18:11", children={"Products": "2026-09-18 01:00"})
    assert cli._cached_match_predates_fire(bare, FIRES) is None
    nothing = _rec(files={}, dir_mtime=None)
    assert cli._cached_match_predates_fire(nothing, FIRES) is None


def test_cached_check_leaves_deterministic_and_unknown_cases_alone():
    assert cli._cached_match_predates_fire(_rec(method="unit_id"), FIRES) is None
    assert cli._cached_match_predates_fire(_rec(method="override"), FIRES) is None
    detached = _rec(match=None)
    assert cli._cached_match_predates_fire(detached, FIRES) is None
    unresolved = _rec(cornea_id=None, match=None, id_unresolved={"reason": "date"})
    assert cli._cached_match_predates_fire(unresolved, FIRES) is None
    no_created = _fires(dict(NM, created_on=None))
    assert cli._cached_match_predates_fire(_rec(), no_created) is None
