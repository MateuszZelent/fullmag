from __future__ import annotations

import ast
import unittest
from pathlib import Path


CASE_DIR = Path(__file__).resolve().parent
PAGE = CASE_DIR / "live-results.html"
SERVER = CASE_DIR.parents[1] / "scripts" / "analysis" / "serve_fdm_fem_mumax3_live.py"


class LiveResultsContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.page = PAGE.read_text(encoding="utf-8")
        cls.server = SERVER.read_text(encoding="utf-8")

    def test_page_and_server_exist(self) -> None:
        self.assertTrue(PAGE.is_file())
        self.assertTrue(SERVER.is_file())

    def test_page_reads_streaming_table_and_final_scalar_table(self) -> None:
        self.assertIn("${base}/.zattrs", self.page)
        self.assertIn("${base}/.zarray", self.page)
        self.assertIn("${base}/${index}.0", self.page)
        self.assertIn("artifacts/tables/default/table.csv", self.page)
        self.assertIn("artifacts/scalars.csv", self.page)
        self.assertIn("parseFullmagLiveCsv", self.page)
        self.assertIn("results/mumax3/table.txt", self.page)
        self.assertIn("results/mumax3_aligned_v2/table.txt", self.page)
        self.assertIn("fdm_case.zarr", self.page)
        self.assertIn("fem_case.zarr", self.page)

    def test_page_refreshes_without_browser_or_server_cache(self) -> None:
        self.assertIn('cache: "no-store"', self.page)
        self.assertRegex(self.page, r"setInterval\(refreshAll,\s*1000\)")
        self.assertIn("_live=", self.page)
        self.assertIn("no-store, no-cache, must-revalidate", self.server)

    def test_page_contains_all_requested_scalar_series(self) -> None:
        for column in ("mx", "my", "mz", "e_ex", "e_demag", "e_ext", "e_drive", "e_external_total", "e_ani", "e_dmi", "e_total"):
            self.assertIn(f'"{column}"', self.page)
        self.assertIn("e_zeeman", self.page)

    def test_page_has_no_field_snapshot_reader(self) -> None:
        self.assertNotIn("m_initial", self.page)
        self.assertNotIn("fields/", self.page)
        self.assertNotRegex(self.page, r"\b(?:save|autosave)\s*\(\s*m\b")

    def test_server_is_valid_python(self) -> None:
        ast.parse(self.server, filename=str(SERVER))


if __name__ == "__main__":
    unittest.main()
