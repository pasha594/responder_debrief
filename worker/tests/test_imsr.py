"""IMSR sit-report parsing + fire matching (fixture: real 2026-08-18 lines)."""

from pathlib import Path

from responder_worker.imsr import (
    match_imsr,
    parse_imsr_narratives,
    parse_imsr_rows,
)

FIXTURE = (Path(__file__).parent / "fixtures" / "imsr_excerpt.txt").read_text()


class TestParseRows:
    def test_parses_the_big_grass_row(self):
        rows = {r["name"]: r for r in parse_imsr_rows(FIXTURE)}
        bg = rows["Big Grass"]
        assert bg["unit"] == "OR-VAD"
        assert bg["acres"] == 579134
        assert bg["contained_pct"] == 82
        assert bg["est_containment"] == "8/22"
        assert bg["personnel"] == 975
        assert bg["personnel_change"] == -16
        assert (bg["crews"], bg["engines"], bg["helicopters"]) == (17, 54, 4)
        assert bg["structures_lost"] == 0
        assert bg["cost_to_date"] == "56.2M"
        assert bg["owner"] == "BLM"

    def test_wrapped_name_takes_the_preceding_line(self):
        rows = {r["name"]: r for r in parse_imsr_rows(FIXTURE)}
        assert "Rowe Creek" in rows
        assert rows["Rowe Creek"]["unit"] == "OR-PRD"
        assert rows["Rowe Creek"]["acres"] == 373784

    def test_dashes_parse_as_none_and_star_prefix_strips(self):
        rows = {r["name"]: r for r in parse_imsr_rows(FIXTURE)}
        rb = rows["Reevas Basin"]  # "* Reevas Basin ... --- ... ---"
        assert rb["acres_change"] is None
        assert rb["personnel_change"] is None
        assert rb["cost_to_date"] == "100K"

    def test_narrative_lines_do_not_parse_as_rows(self):
        names = {r["name"] for r in parse_imsr_rows(FIXTURE)}
        assert "Little Weitas" not in names  # only its narrative is present


class TestNarratives:
    def test_big_grass_paragraph_captured_and_flattened(self):
        narr = parse_imsr_narratives(FIXTURE)
        text = narr["big grass"] if "big grass" in narr else narr.get("biggrass")
        assert text and "NW Team 10" in text
        assert "Evacuations" in text
        assert "\n" not in text


class TestMatch:
    FIRES = [
        {"fire_slug": "big-grass", "post_title": "BIG GRASS", "state": "OR"},
        {"fire_slug": "big-grass-mt", "post_title": "Big Grass", "state": "MT"},
        {"fire_slug": "sinlahekin", "post_title": "Sinlahekin", "state": "WA"},
    ]

    def test_matches_by_name_and_unit_state(self):
        rows = parse_imsr_rows(FIXTURE)
        out = match_imsr(rows, parse_imsr_narratives(FIXTURE), self.FIRES)
        assert "big-grass" in out
        assert "big-grass-mt" not in out  # OR-VAD unit != MT fire
        assert out["big-grass"]["crews"] == 17
        assert "NW Team 10" in (out["big-grass"]["narrative"] or "")
        assert out["sinlahekin"]["personnel"] == 1731
