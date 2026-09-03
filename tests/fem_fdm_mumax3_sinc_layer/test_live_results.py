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
        self.assertIn("mumax3_case.zarr/table.txt", self.page)
        self.assertIn("fdm_case.zarr", self.page)
        self.assertIn("fdm_gpu_dt50fs_diagnostic_retry", self.page)
        self.assertIn("fem_cpu_case.zarr", self.page)
        self.assertIn("fem_gpu_case.zarr", self.page)
        self.assertIn("fem_pr_cpu", self.page)
        self.assertIn("fem_pr_gpu", self.page)
        self.assertIn("fem_fk_cpu", self.page)
        self.assertIn("fem_fk_gpu", self.page)
        self.assertNotIn('roots: ["fem_case.zarr"', self.page)

    def test_mumax_uses_the_current_case_artifact(self) -> None:
        start = self.page.index('id: "mumax3"')
        end = self.page.index('];', start)
        definition = self.page[start:end]
        self.assertIn('paths: ["mumax3_case.zarr/table.txt"]', definition)
        self.assertNotIn("results/mumax3_aligned_v3/table.txt", definition)

    def test_page_declares_cpu_gpu_series_and_latest_mumax_version(self) -> None:
        expected_series = (
            ('id: "fdm_cpu"', 'label: "Fullmag FDM · CPU · double"', 'lineStyle: "solid"'),
            ('id: "fdm_gpu"', 'label: "Fullmag FDM · GPU · double"', 'lineStyle: "dashed"'),
            ('id: "fem_pr_cpu"', 'label: "Fullmag FEM · Poisson–Robin · CPU · double"', 'lineStyle: "solid"'),
            ('id: "fem_pr_gpu"', 'label: "Fullmag FEM · Poisson–Robin · GPU · double"', 'lineStyle: "dashed"'),
            ('id: "fem_fk_cpu"', 'label: "Fullmag FEM · Fredkin–Köhler · CPU · double"', 'lineStyle: "solid"'),
            ('id: "fem_fk_gpu"', 'label: "Fullmag FEM · Fredkin–Köhler · GPU · double"', 'lineStyle: "dashed"'),
            ('id: "mumax3"', 'label: "MuMax3 · v3.12.3-20260819 · GPU"', 'lineStyle: "dotted"'),
        )
        for series in expected_series:
            for marker in series:
                self.assertIn(marker, self.page)
        self.assertIn('color: "var(--fdm)"', self.page)
        self.assertIn('color: "var(--fem)"', self.page)
        self.assertIn('color: "var(--fem-fk)"', self.page)
        self.assertIn('color: "var(--mumax)"', self.page)

    def test_page_marks_fredkin_koehler_lanes_as_unavailable_until_runtime_support_exists(self) -> None:
        self.assertIn('availability: "pending"', self.page)
        self.assertIn("FEM Fredkin–Köhler", self.page)

    def test_fredkin_koehler_data_requires_passed_runtime_qualification(self) -> None:
        self.assertIn('qualification: ["results/current/fem_fk_cpu/qualification.json"]', self.page)
        self.assertIn('qualification: ["results/current/fem_fk_gpu/qualification.json"]', self.page)
        self.assertIn("async function requireQualification(definition)", self.page)
        self.assertIn('report.status !== "PASS"', self.page)

    def test_page_refreshes_without_browser_or_server_cache(self) -> None:
        self.assertIn('cache: "no-store"', self.page)
        self.assertRegex(self.page, r"setInterval\(refreshAll,\s*1000\)")
        self.assertIn("_live=", self.page)
        self.assertIn("no-store, no-cache, must-revalidate", self.server)

    def test_page_contains_all_requested_scalar_series(self) -> None:
        for column in ("mx", "my", "mz", "e_ex", "e_demag", "e_ext", "e_drive", "e_external_total", "e_ani", "e_dmi", "e_total"):
            self.assertIn(f'"{column}"', self.page)
        self.assertIn("e_zeeman", self.page)

    def test_page_contains_post_relaxation_comparison_for_all_sources(self) -> None:
        self.assertIn('id="relaxation-grid"', self.page)
        self.assertIn('results/mumax3_relax_v2/table.txt', self.page)
        self.assertIn("relaxationCsv", self.page)
        self.assertIn("relaxationLiveCsv", self.page)
        self.assertIn("relaxationRoots", self.page)
        self.assertIn("RELAXATION_STAGE_CANDIDATES", self.page)
        self.assertIn("parseFullmagRelaxationCsv", self.page)
        self.assertIn('read("relaxation")', self.page)
        self.assertIn("function relaxationSeries", self.page)
        self.assertIn("function renderRelaxation", self.page)

    def test_fdm_gpu_uses_the_dt50fs_comparison_bundle(self) -> None:
        start = self.page.index('id: "fdm_gpu"')
        end = self.page.index('id: "fem_pr_cpu"', start)
        definition = self.page[start:end]
        self.assertIn("results/current/fdm_gpu_dt50fs_diagnostic_retry", definition)
        self.assertNotIn('results/current/fdm_gpu",', definition)
        self.assertNotIn("fdm_gpu_case.zarr", definition)

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
            self.page.index("for (const path of csvPaths || [])"),
            self.page.index("for (const path of liveCsvPaths || [])"),
        )

    def test_fullmag_read_prefers_completed_csv_before_streaming_zarr_probe(self) -> None:
        self.assertLess(
            self.page.index("for (const path of csvPaths || [])"),
            self.page.index("for (const root of roots || [])"),
        )
        self.assertLess(
            self.page.index("for (const path of liveCsvPaths || [])"),
            self.page.index("for (const root of roots || [])"),
        )

    def test_page_has_no_field_snapshot_reader(self) -> None:
        self.assertNotIn("m_initial", self.page)
        self.assertNotIn("fields/", self.page)
        self.assertNotRegex(self.page, r"\b(?:save|autosave)\s*\(\s*m\b")

    def test_server_is_valid_python(self) -> None:
        ast.parse(self.server, filename=str(SERVER))


if __name__ == "__main__":
    unittest.main()
