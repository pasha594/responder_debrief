"""Autoindex parsing pinned to real snapshot pages from ftp.wildfire.gov."""

from responder_worker.ftp_index import parse_autoindex, parse_size_hint

BASE_ROCKY = "https://ftp.wildfire.gov/public/incident_specific_maps/rocky_mtn/2026/"
BASE_ELK = "https://ftp.wildfire.gov/public/incident_specific_maps/rocky_mtn/2026/2026_Elk/"
BASE_ELK_DAILY = BASE_ELK + "Products/20260817/"


class TestRockyMtnIndex:
    def test_dirs_parsed(self, fixtures):
        html = (fixtures / "autoindex_rocky_mtn_2026.html").read_text()
        entries = parse_autoindex(html, BASE_ROCKY)
        names = [e.name for e in entries]
        assert "2026_Elk" in names
        assert "2026_P-L_Gulch" in names
        assert "2026_FireName" in names  # placeholder present in raw listing
        # URL-decoded name
        assert "2026_Aspen Acres" in names
        assert all(e.is_dir for e in entries)

    def test_no_sort_or_parent_rows(self, fixtures):
        html = (fixtures / "autoindex_rocky_mtn_2026.html").read_text()
        entries = parse_autoindex(html, BASE_ROCKY)
        assert not any(e.href.startswith("?") for e in entries)
        assert not any("Parent" in e.name for e in entries)

    def test_urls_joined_and_encoded(self, fixtures):
        html = (fixtures / "autoindex_rocky_mtn_2026.html").read_text()
        entries = parse_autoindex(html, BASE_ROCKY)
        aspen = next(e for e in entries if e.name == "2026_Aspen Acres")
        assert aspen.url == BASE_ROCKY + "2026_Aspen%20Acres/"


class TestElkIndex:
    def test_children_and_mtimes(self, fixtures):
        html = (fixtures / "autoindex_elk.html").read_text()
        entries = parse_autoindex(html, BASE_ELK)
        by_name = {e.name: e for e in entries}
        assert set(by_name) == {"IR", "Products", "QR"}
        assert by_name["IR"].mtime == "2026-08-17 06:56"
        assert by_name["Products"].mtime == "2026-08-16 22:06"
        assert by_name["QR"].mtime == "2026-08-16 22:46"
        assert all(e.is_dir for e in entries)


class TestElkDailyProducts:
    def test_files_parsed(self, fixtures):
        html = (fixtures / "autoindex_elk_products_20260817.html").read_text()
        entries = parse_autoindex(html, BASE_ELK_DAILY)
        assert all(not e.is_dir for e in entries)
        names = [e.name for e in entries]
        assert "ops_arch_e_port_20260816_2100_Elk_COGMF000114_817day.pdf" in names
        assert "mobile_72x96_land_20260816_2056_Elk_COGMF000114_817.pdf" in names
        # every file row has an mtime and a size hint
        assert all(e.mtime for e in entries)
        assert all(e.size_hint and e.size_hint > 0 for e in entries)

    def test_dirs_vs_files_flags(self, fixtures):
        elk = parse_autoindex((fixtures / "autoindex_elk.html").read_text(), BASE_ELK)
        daily = parse_autoindex(
            (fixtures / "autoindex_elk_products_20260817.html").read_text(),
            BASE_ELK_DAILY,
        )
        assert {e.is_dir for e in elk} == {True}
        assert {e.is_dir for e in daily} == {False}


class TestSizeHints:
    def test_units(self):
        assert parse_size_hint("4.4M") == int(4.4 * 1024 * 1024)
        assert parse_size_hint("523K") == 523 * 1024
        assert parse_size_hint("1.2G") == int(1.2 * 1024**3)
        assert parse_size_hint("17") == 17
        assert parse_size_hint("-") is None
        assert parse_size_hint("") is None
