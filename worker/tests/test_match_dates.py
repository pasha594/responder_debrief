"""The mirror job's side of the date sanity check: dating a folder from the
listings it already makes, and re-validating matches cached in state."""
from types import SimpleNamespace

from responder_worker import cli
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


def _rec(method="name_fuzzy", **kw):
    rec = {"fire_slug": "corrals", "match": {"method": method, "confidence": 0.923},
           "latest_upload_ts": "2026-04-26T02:00:33Z", "latest_upload": "2026-04-26",
           "dir_mtime": "2026-04-24 18:11"}
    rec.update(kw)
    return rec


FIRES = {"corrals": {"fire_slug": "corrals", "created_on": "2026-09-17T19:53:09Z"}}


def test_cached_fuzzy_match_to_a_much_newer_fire_is_rejected():
    reason = cli._cached_match_predates_fire(_rec(), FIRES)
    assert reason and "2026-04-26T02:00:33Z" in reason and "7 days" in reason
    assert cli._cached_match_predates_fire(_rec(method="name_exact"), FIRES)


def test_cached_check_uses_the_newest_stamp_it_has():
    # One recent signal is enough to keep the match.
    assert cli._cached_match_predates_fire(_rec(latest_upload="2026-09-18"), FIRES) is None
    # No usable stamps: no evidence, no veto.
    bare = _rec(latest_upload_ts=None, latest_upload=None, dir_mtime=None)
    assert cli._cached_match_predates_fire(bare, FIRES) is None


def test_cached_check_leaves_deterministic_and_unknown_cases_alone():
    assert cli._cached_match_predates_fire(_rec(method="unit_id"), FIRES) is None
    assert cli._cached_match_predates_fire(_rec(method="override"), FIRES) is None
    assert cli._cached_match_predates_fire(_rec(), {}) is None            # fire no longer active
    assert cli._cached_match_predates_fire({"fire_slug": "corrals"}, FIRES) is None  # already detached
    no_created = {"corrals": {"fire_slug": "corrals", "created_on": None}}
    assert cli._cached_match_predates_fire(_rec(), no_created) is None
