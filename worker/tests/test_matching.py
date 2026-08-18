"""Matching: unit-token regex, name normalizer, placeholder filtering,
GACC-state constraint, pyrecast slug matching — pinned to real observed names."""

from collections import Counter

from responder_worker.matching import (
    IncidentCandidate,
    UNIT_TOKEN_RE,
    candidate_dir_name,
    extract_unit_tokens,
    is_placeholder_dir,
    match_candidate,
    match_pyrecast_slug,
    name_variants,
    normalize_name,
)


def _fire(slug, title, state, uid=None):
    return {
        "fire_slug": slug,
        "post_title": title,
        "state": state,
        "unique_fire_id": uid,
    }


# ---------------------------------------------------------------------------
# unit-token regex on real filenames
# ---------------------------------------------------------------------------

class TestUnitToken:
    def test_elk_cogmf(self):
        fn = "ops_arch_e_port_20260816_2100_Elk_COGMF000114_817day.pdf"
        m = UNIT_TOKEN_RE.search(fn)
        assert m and m.group("unit") == "COGMF" and m.group("num") == "000114"

    def test_caneu(self):
        fn = "ops_arch_d_port_20260815_1900_Garnet_CANEU020978_0815day.pdf"
        tokens = extract_unit_tokens([fn])
        assert tokens == Counter({"2026-CANEU-020978": 1})

    def test_orprd(self):
        fn = "iap_11x17_land_20260810_0600_Rail_Ridge_ORPRD000511_0810day.pdf"
        tokens = extract_unit_tokens([fn])
        assert tokens == Counter({"2026-ORPRD-000511": 1})

    def test_token_before_dot(self):
        fn = "mobile_72x96_land_20260816_2056_Elk_COGMF000114.pdf"
        assert extract_unit_tokens([fn]) == Counter({"2026-COGMF-000114": 1})

    def test_majority_vote_across_files(self):
        files = [
            "ops_arch_e_port_20260816_2100_Elk_COGMF000114_817day.pdf",
            "brief_arch_e_land_20260816_2052_Elk_COGMF000114_0817day.pdf",
            "trans_arch_e_land_20260816_2100_Elk_COGMF000113_817day.pdf",  # typo
        ]
        tokens = extract_unit_tokens(files)
        assert tokens.most_common(1)[0][0] == "2026-COGMF-000114"

    def test_no_false_positive_on_dates(self):
        # date/time blocks must not read as unit tokens
        assert extract_unit_tokens(["ops_arch_e_port_20260816_2100_day.pdf"]) == Counter()


# ---------------------------------------------------------------------------
# name normalizer on real dir names
# ---------------------------------------------------------------------------

class TestNormalizer:
    def test_camelcase_complex(self):
        assert normalize_name("2026_HayCreekComplex") == "hay creek complex"

    def test_urlencoded_space(self):
        assert normalize_name("2026_Aspen%20Acres") == "aspen acres"

    def test_hyphen_underscore(self):
        assert normalize_name("2026_P-L_Gulch") == "p l gulch"

    def test_acronym_run_stays_one_token(self):
        assert normalize_name("2026_I5MM57NB") == "i5mm57nb"

    def test_variants_strip_complex_and_fire(self):
        assert "hay creek" in name_variants("hay creek complex")
        assert "bologna" in name_variants("bologna fire")


# ---------------------------------------------------------------------------
# placeholder filtering
# ---------------------------------------------------------------------------

class TestPlaceholders:
    def test_firename(self):
        assert is_placeholder_dir("2026_FireName")
        assert candidate_dir_name("2026_FireName/") is None

    def test_zfirename4(self):
        assert is_placeholder_dir("2026_zFireName4")
        assert candidate_dir_name("2026_zFireName4/") is None

    def test_real_dirs_pass(self):
        assert candidate_dir_name("2026_Elk/") == "Elk"
        assert candidate_dir_name("2026_Aspen%20Acres/") == "Aspen Acres"

    def test_wrong_year_rejected(self):
        assert candidate_dir_name("2025_Elk/") is None

    def test_template_date_dir_rejected(self):
        assert candidate_dir_name("260816/") is None


# ---------------------------------------------------------------------------
# match_candidate: unit_id beats names; GACC-state constraint
# ---------------------------------------------------------------------------

class TestMatchCandidate:
    def test_unit_id_wins(self):
        fires = [
            _fire("elk", "Elk", "CO", uid="2026-COGMF-000114"),
            _fire("elk-ca", "Elk", "CA", uid="2026-CANEU-020978"),
        ]
        cand = IncidentCandidate(
            region="rocky_mtn", year=2026, dir_name="2026_Elk",
            dir_url="https://x/2026_Elk/",
            unit_tokens=Counter({"2026-COGMF-000114": 5}),
        )
        m = match_candidate(cand, fires)
        assert m and m.method == "unit_id" and m.confidence == 1.0
        assert m.fire_slug == "elk"

    def test_gacc_state_constraint_disambiguates(self):
        # duplicate fire names in CO and CA; rocky_mtn dir must pick CO
        fires = [
            _fire("willow-co", "Willow", "CO"),
            _fire("willow-ca", "Willow", "CA"),
        ]
        cand = IncidentCandidate(
            region="rocky_mtn", year=2026, dir_name="2026_Willow",
            dir_url="https://x/2026_Willow/",
        )
        m = match_candidate(cand, fires)
        assert m and m.method == "name_exact" and m.fire_slug == "willow-co"

    def test_out_of_region_state_never_matches(self):
        fires = [_fire("willow-ca", "Willow", "CA")]
        cand = IncidentCandidate(
            region="rocky_mtn", year=2026, dir_name="2026_Willow",
            dir_url="https://x/2026_Willow/",
        )
        assert match_candidate(cand, fires) is None

    def test_complex_stripped_exact(self):
        fires = [_fire("hay-creek", "Hay Creek", "SD")]
        cand = IncidentCandidate(
            region="rocky_mtn", year=2026, dir_name="2026_HayCreekComplex",
            dir_url="https://x/",
        )
        m = match_candidate(cand, fires)
        assert m and m.method == "name_exact" and m.fire_slug == "hay-creek"

    def test_tie_stays_unmatched(self):
        fires = [
            _fire("willow-1", "Willow", "CO"),
            _fire("willow-2", "Willow", "WY"),
        ]
        cand = IncidentCandidate(
            region="rocky_mtn", year=2026, dir_name="2026_Willow",
            dir_url="https://x/",
        )
        assert match_candidate(cand, fires) is None

    def test_override_pin_and_ignore(self):
        fires = [_fire("elk", "Elk", "CO")]
        cand = IncidentCandidate(
            region="rocky_mtn", year=2026, dir_name="2026_Mystery",
            dir_url="https://x/",
        )
        m = match_candidate(cand, fires, {"rocky_mtn/2026/2026_Mystery": "elk"})
        assert m and m.method == "override" and m.fire_slug == "elk"
        assert match_candidate(cand, fires, {"rocky_mtn/2026/2026_Mystery": "ignore"}) is None


# ---------------------------------------------------------------------------
# pyrecast slug matching
# ---------------------------------------------------------------------------

class TestPyrecastSlug:
    def test_or_paradise(self):
        fires = [
            _fire("paradise", "Paradise", "OR"),
            _fire("paradise-ca", "Paradise", "CA"),
        ]
        fire, method, conf = match_pyrecast_slug("or-paradise", fires)
        assert fire and fire["fire_slug"] == "paradise"
        assert method == "name_exact" and conf == 0.95

    def test_ar_dallas_with_incident_number(self):
        fires = [_fire("dallas", "Dallas", "AR", uid="2026-ARARF-500153")]
        fire, method, conf = match_pyrecast_slug("ar-dallas-500153", fires)
        assert fire and fire["fire_slug"] == "dallas"
        assert conf == 1.0 and method == "unit_num"

    def test_multiword_slug(self):
        fires = [_fire("false-bottom-creek", "False Bottom Creek", "SD")]
        fire, method, conf = match_pyrecast_slug("sd-false-bottom-creek", fires)
        assert fire and fire["fire_slug"] == "false-bottom-creek"

    def test_state_prefix_must_match(self):
        fires = [_fire("paradise-ca", "Paradise", "CA")]
        fire, method, _ = match_pyrecast_slug("or-paradise", fires)
        assert fire is None and method == "unmatched"


# ---------------------------------------------------------------------------
# Crawl ordering: runs are wall-clock bounded, so ORDER decides what makes it
# onto the site after a partial sync (user asked to prioritize Big Grass).
# ---------------------------------------------------------------------------

def _cand(dir_name):
    from responder_worker.matching import IncidentCandidate
    return IncidentCandidate(region="pacific_nw", year=2026, dir_name=dir_name,
                             dir_url=f"https://x/{dir_name}/", dir_mtime=None)


FIRES = [
    {"fire_slug": "big-grass", "post_title": "BIG GRASS", "acres": 578422,
     "last_updated": "2026-08-17T13:51:18Z"},
    {"fire_slug": "coleman-creek", "post_title": "Coleman Creek", "acres": 308721,
     "last_updated": "2026-08-17T16:54:55Z"},
    {"fire_slug": "tiny", "post_title": "Tiny", "acres": 12,
     "last_updated": "2026-08-17T18:00:00Z"},
]


def test_rank_orders_by_acreage_desc_by_default():
    from responder_worker.cli import _rank_candidates
    cands = [_cand("2026_Tiny"), _cand("2026_ColemanCreek"), _cand("2026_BigGrass")]
    got = [c.dir_name for c in _rank_candidates(cands, FIRES, [])]
    assert got == ["2026_BigGrass", "2026_ColemanCreek", "2026_Tiny"]


def test_rank_puts_priority_fire_first_even_when_small():
    from responder_worker.cli import _rank_candidates
    cands = [_cand("2026_BigGrass"), _cand("2026_Tiny")]
    got = [c.dir_name for c in _rank_candidates(cands, FIRES, ["tiny"])]
    assert got == ["2026_Tiny", "2026_BigGrass"]


def test_rank_priority_accepts_slug_or_display_name():
    from responder_worker.cli import _rank_candidates
    cands = [_cand("2026_ColemanCreek"), _cand("2026_BigGrass")]
    for spelling in ("big-grass", "BIG GRASS", "biggrass"):
        got = [c.dir_name for c in _rank_candidates(cands, FIRES, [spelling])]
        assert got[0] == "2026_BigGrass", spelling


def test_rank_tolerates_unmatched_dirs():
    from responder_worker.cli import _rank_candidates
    cands = [_cand("2026_NotAFireWeKnow"), _cand("2026_BigGrass")]
    got = [c.dir_name for c in _rank_candidates(cands, FIRES, [])]
    assert got[0] == "2026_BigGrass"  # unknown dirs sink to the end (0 acres)
