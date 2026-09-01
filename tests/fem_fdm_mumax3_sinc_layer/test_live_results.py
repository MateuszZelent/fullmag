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
        self.assertIn("results/mumax3_aligned_v3/table.txt", self.page)
        self.assertIn("fdm_case.zarr", self.page)
        self.assertIn("fdm_gpu_case.zarr", self.page)
        self.assertIn("fem_cpu_case.zarr", self.page)
        self.assertIn("fem_gpu_case.zarr", self.page)
        self.assertNotIn('roots: ["fem_case.zarr"', self.page)

    def test_page_declares_cpu_gpu_series_and_latest_mumax_version(self) -> None:
        expected_series = (
            ('id: "fdm_cpu"', 'label: "Fullmag FDM · CPU · double"', 'lineStyle: "solid"'),
            ('id: "fdm_gpu"', 'label: "Fullmag FDM · GPU · double"', 'lineStyle: "dashed"'),
            ('id: "fem_cpu"', 'label: "Fullmag FEM · CPU · double"', 'lineStyle: "solid"'),
            ('id: "fem_gpu"', 'label: "Fullmag FEM · GPU · double"', 'lineStyle: "dashed"'),
            ('id: "mumax3"', 'label: "MuMax3 · v3.12.3-20260819 · GPU"', 'lineStyle: "dotted"'),
        )
        for series in expected_series:
            for marker in series:
                self.assertIn(marker, self.page)
        self.assertIn('color: "var(--fdm)"', self.page)
        self.assertIn('color: "var(--fem)"', self.page)
        self.assertIn('color: "var(--mumax)"', self.page)

    def test_page_refreshes_without_browser_or_server_cache(self) -> None:
        self.assertIn('cache: "no-store"', self.page)
        self.assertRegex(self.page, r"setInterval\(refreshAll,\s*1000\)")
        self.assertIn("_live=", self.page)
        self.assertIn("no-store, no-cache, must-revalidate", self.server)

    def test_page_contains_all_requested_scalar_series(self) -> None:
        for column in ("mx", "my", "mz", "e_ex", "e_demag", "e_ext", "e_drive", "e_external_total", "e_ani", "e_dmi", "e_total"):
            self.assertIn(f'"{column}"', self.page)
        self.assertIn("e_zeeman", self.page)

    def test_series_styles_are_definition_driven_and_mumax3_is_dotted(self) -> None:
        self.assertIn(
            'strokeDasharray: definition.strokeDasharray || null',
            self.page,
        )
        self.assertIn('strokeDasharray: "1 6"', self.page)
        self.assertIn('strokeDasharray: "8 5"', self.page)
        self.assertIn(
            'if (series.strokeDasharray) path.setAttribute("stroke-dasharray", series.strokeDasharray);',
            self.page,
        )
        self.assertIn('swatch.dataset.lineStyle = series.lineStyle;', self.page)

    def test_legend_toggles_backend_curves_globally(self) -> None:
        self.assertIn("hiddenBackends: new Set()", self.page)
        self.assertIn("function toggleBackend(backendId)", self.page)
        self.assertIn('item.setAttribute("aria-pressed", String(series.visible));', self.page)
        self.assertIn(
            'item.addEventListener("click", () => toggleBackend(series.id));',
            self.page,
        )

    def test_chart_legends_keep_unavailable_lanes_visible(self) -> None:
        self.assertIn("available: hasData", self.page)
        self.assertIn(
            'const visibleSeries = seriesList.filter((series) => series.visible && series.available);',
            self.page,
        )
        self.assertIn('item.setAttribute("aria-disabled", String(!series.available));', self.page)
        self.assertIn('series.availability === "not_applicable" ? "brak składowej" : "oczekuje"', self.page)

    def test_fullmag_external_energy_is_not_added_to_drive_twice(self) -> None:
        self.assertNotIn("normalized.e_external_total = row.e_ext + row.e_drive;", self.page)

    def test_completed_fullmag_table_uses_native_energy_columns_and_precedes_live_summary(self) -> None:
        self.assertIn(
            'const required = ["time_s", ...MAGNETIZATION, "e_ex", "e_demag", "e_ext", "e_drive", "e_ani", "e_dmi", "e_total"];',
            self.page,
        )
        self.assertLess(
            self.page.index("for (const path of definition.csv || [])"),
            self.page.index("for (const path of definition.liveCsv || [])"),
        )

    def test_fullmag_read_prefers_completed_csv_before_streaming_zarr_probe(self) -> None:
        self.assertLess(
            self.page.index("for (const path of definition.csv || [])"),
            self.page.index("for (const root of definition.roots || [])"),
        )
        self.assertLess(
            self.page.index("for (const path of definition.liveCsv || [])"),
            self.page.index("for (const root of definition.roots || [])"),
        )

    def test_page_has_no_field_snapshot_reader(self) -> None:
        self.assertNotIn("m_initial", self.page)
        self.assertNotIn("fields/", self.page)
        self.assertNotRegex(self.page, r"\b(?:save|autosave)\s*\(\s*m\b")

    def test_server_is_valid_python(self) -> None:
        ast.parse(self.server, filename=str(SERVER))


if __name__ == "__main__":
    unittest.main()
