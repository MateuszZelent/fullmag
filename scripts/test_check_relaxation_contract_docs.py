import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.check_relaxation_contract_docs import check_relaxation_contract_docs


MARKDOWN_PATHS = (
    "docs/physics/0500-fdm-relaxation-algorithms.md",
    "docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md",
    "docs/physics/0530-shared-relaxation-stop-and-field-refresh-semantics.md",
    "docs/architecture/backend-golden-masterplan.md",
    "docs/specs/problem-ir-v0.md",
    "docs/specs/problem-ir-compatibility-v1.md",
    "docs/specs/capability-matrix-v0.md",
    "docs/specs/resource-first-control-room-api-v2.md",
)


class RelaxationContractDocsTest(unittest.TestCase):
    def _repo(self, text: str) -> Path:
        root = Path(tempfile.mkdtemp())
        for relative in MARKDOWN_PATHS:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        capability = root / "docs/specs/capability-matrix-v0.json"
        capability.write_text(
            """{
              "features": [
                {"id":"relaxation_llg_overdamped","notes":"Defaults 1e-4 A/m and 50000; max_torque_Apm and max_rhs_norm_per_s."},
                {"id":"relaxation_projected_gradient_bb","notes":"m/A line-search step and no RK."},
                {"id":"relaxation_nonlinear_cg","notes":"m/A line-search step and no RK."},
                {"id":"relaxation_tangent_plane_implicit","lanes":{"fem_cpu_public":"development_executable","fem_gpu_public":"unsupported"},"notes":"Strict and forced GPU reject; extended resolves CPU/MFEM."}
              ]
            }""",
            encoding="utf-8",
        )
        return root

    def test_accepts_canonical_contract(self) -> None:
        root = self._repo(
            """
            The public default torque tolerance is `1e-4 A/m` and max_steps is 50000.
            `max_torque_Apm` is the exact accepted-state field residual in `A/m`;
            `max_torque_T = mu0 * max_torque_Apm` is the equivalent value in `T`,
            while `max_rhs_norm_per_s` is a separate dynamic observable in `1/s`.
            Direct-minimizer line-search step lambda has unit `m/A`; PG-BB and NCG
            own no RK integrator or physical/pseudo time.
            TPI is rejected in strict mode and on GPU; extended mode may resolve
            it only to the CPU/MFEM development lane.
            """
        )
        self.assertEqual(check_relaxation_contract_docs(root), [])

    def test_rejects_each_stale_contract_family(self) -> None:
        root = self._repo(
            """
            Direct-minimizer lambda is dimensionless and its line-search pseudo-time is in s.
            The default torque tolerance is 1e-6 A/m.
            Tangent-plane implicit is strict-production and GPU-executable.
            max_torque is reconstructed from dm/dt.
            Projected-gradient uses RK4 integration.
            """
        )
        errors = "\n".join(check_relaxation_contract_docs(root))
        for contract in ("step-unit", "default-torque", "tpi-capability", "torque-observable", "direct-rk"):
            self.assertIn(contract, errors)

    def test_rejects_multiline_tpi_production_and_automatic_fallback_claim(self) -> None:
        root = self._repo(
            """
            The public default torque tolerance is `1e-4 A/m` and max_steps is 50000.
            `max_torque_Apm` is the exact accepted-state field residual in `A/m`;
            `max_torque_T = mu0 * max_torque_Apm` is the equivalent value in `T`,
            while `max_rhs_norm_per_s` is a separate dynamic observable in `1/s`.
            Direct-minimizer line-search step lambda has unit `m/A`; PG-BB and NCG
            own no RK integrator or physical/pseudo time.
            TPI is rejected in strict mode and on GPU; extended mode may resolve
            it only to the CPU/MFEM development lane.
            """
        )
        matrix = root / "docs/specs/capability-matrix-v0.md"
        matrix.write_text(
            matrix.read_text(encoding="utf-8")
            + """
            FEM relaxation algorithms llg_overdamped, projected_gradient_bb,
            nonlinear_cg, and CPU/MFEM tangent_plane_implicit are the current
            production-executable relaxation set. In automatic runtime selection,
            a GPU TPI plan falls back to fem_cpu_native.
            """,
            encoding="utf-8",
        )
        errors = "\n".join(check_relaxation_contract_docs(root))
        self.assertIn("tpi-capability", errors)
        self.assertIn("hidden-fallback", errors)


class DirectMinimizerDocumentationStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = REPO_ROOT

    def _read(self, relative: str) -> str:
        return (self.root / relative).read_text(encoding="utf-8")

    @staticmethod
    def _combined_block(combined: str, name: str) -> str:
        match = re.search(
            rf"<!-- BEGIN {re.escape(name)} -->\n\n(.*?)\n<!-- END {re.escape(name)} -->",
            combined,
            re.DOTALL,
        )
        if match is None:
            raise AssertionError(f"missing combined block: {name}")
        return match.group(1).strip()

    def test_reports_diagonal_source_and_unqualified_remediation(self) -> None:
        note = self._read(
            "docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md"
        )
        audit = self._read("docs/audits/2026-09-02-fem-gpu-solver-completion.md")
        performance_root = (
            "docs/performance/fem-gpu-performance-remediation-2026-09-01/"
            "fem-gpu-performance-remediation-2026-09-01"
        )
        performance = self._read(
            f"{performance_root}/07-relaxation-preconditioning-remediation.md"
        )
        manifest = json.loads(self._read(f"{performance_root}/manifest.json"))

        self.assertIn("Current source status (2026-09-04)", note)
        self.assertIn("diagonal/Jacobi approximation", note)
        self.assertIn(r"\lambda\frac{2}{\mu_0}K_{ii}", note)
        self.assertNotIn(r"M_i+\lambda K_{ii}", note)
        self.assertIn("does not apply the off-diagonal entries", note)
        self.assertIn("Historical no-go (2026-07-26)", note)
        self.assertIn("Phase 1 remediation (approved, not qualified)", note)
        self.assertIn("Capability: `NOT VERIFIED`", note)
        self.assertIn("Runtime: `NOT VERIFIED`", note)
        self.assertIn("CPU/GPU parity: `NOT VERIFIED`", note)
        self.assertIn("Physics validation: `NOT VERIFIED`", note)
        self.assertIn("Performance: `NOT VERIFIED`", note)
        self.assertIn("The production default remains `none`", note)

        task_10 = next(
            line for line in audit.splitlines() if line.startswith("| **Task 10**")
        )
        self.assertIn("**NOT VERIFIED**", task_10)
        self.assertNotIn("redukcja kroków NCG/PGBB", task_10)

        self.assertIn("Current source status (2026-09-04)", performance)
        self.assertIn("diagonal/Jacobi approximation", performance)
        self.assertIn("The production default remains `none`", performance)
        self.assertEqual(
            manifest["relaxation_preconditioner_capability"], "NOT VERIFIED"
        )
        self.assertEqual(manifest["relaxation_preconditioner_runtime"], "NOT VERIFIED")
        self.assertEqual(manifest["relaxation_preconditioner_parity"], "NOT VERIFIED")
        self.assertEqual(manifest["relaxation_preconditioner_physics"], "NOT VERIFIED")
        self.assertEqual(
            manifest["relaxation_preconditioner_performance"], "NOT VERIFIED"
        )
        self.assertEqual(manifest["relaxation_preconditioner_default"], "none")

    def test_changed_terminal_pages_have_adjacent_path_symbol_maps(self) -> None:
        for stem in (
            "0510-fem-relaxation-algorithms-mfem-gpu",
            "0560-all-in-gpu-fem-runtime",
            "0581-fem-gpu-direct-minimizer-preconditioning",
            "0900-native-fem-operator-contracts-and-validation",
        ):
            with self.subTest(stem=stem):
                map_path = self.root / f"docs/physics/{stem}.source-map.json"
                self.assertTrue(map_path.is_file(), f"missing source map: {map_path}")
                source_map = json.loads(map_path.read_text(encoding="utf-8"))
                self.assertEqual(source_map["document"]["path"], f"docs/physics/{stem}.md")
                self.assertTrue(source_map["sources"])
                for source in source_map["sources"]:
                    self.assertFalse(Path(source["path"]).is_absolute())
                    self.assertTrue(source["symbol"].strip())

    def test_preconditioner_claim_maps_cover_owners_tests_and_history(self) -> None:
        common_symbols = {
            "GpuExchangeMassPreconditioner::setup",
            "GpuExchangeMassPreconditioner::apply_device_component",
            "gpu_relax_compute_current_metrics",
            "gpu_relax_compute_effective_field_energy_gradient_and_direction",
            "struct ManufacturedSpdMatrix",
            "main",
        }
        for stem in (
            "0560-all-in-gpu-fem-runtime",
            "0581-fem-gpu-direct-minimizer-preconditioning",
            "0900-native-fem-operator-contracts-and-validation",
        ):
            with self.subTest(stem=stem):
                source_map = json.loads(
                    self._read(f"docs/physics/{stem}.source-map.json")
                )
                mapped = {source["symbol"] for source in source_map["sources"]}
                self.assertTrue(common_symbols <= mapped, common_symbols - mapped)

        note_map = json.loads(
            self._read(
                "docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.source-map.json"
            )
        )
        mapped = {source["symbol"] for source in note_map["sources"]}
        self.assertIn("exchange_hessian_scale_from_step_m_per_a", mapped)
        self.assertIn("void exchange_hessian_uses_si_field_scale", mapped)
        evidence_paths = {
            evidence["path"] for evidence in note_map.get("evidence_artifacts", [])
        }
        self.assertIn(
            "docs/audits/evidence/task-11/task-11-relaxation-preconditioner.csv",
            evidence_paths,
        )
        self.assertIn(
            "docs/audits/evidence/task-11/task-11-relaxation-preconditioner-qualification.json",
            evidence_paths,
        )

    def test_preconditioner_fixture_claims_state_the_diagonal_only_limit(self) -> None:
        forbidden = (
            "off-diagonal fixture",
            "distinguishes the pointwise path from a full sparse solve",
        )
        for stem in (
            "0560-all-in-gpu-fem-runtime",
            "0581-fem-gpu-direct-minimizer-preconditioning",
            "0900-native-fem-operator-contracts-and-validation",
        ):
            page = self._read(f"docs/physics/{stem}.md")
            source_map = json.loads(
                self._read(f"docs/physics/{stem}.source-map.json")
            )
            fixture = next(
                source for source in source_map["sources"]
                if source["symbol"] == "struct ManufacturedSpdMatrix"
            )
            contract = next(
                source for source in source_map["sources"]
                if source["path"] == "backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp"
                and source["symbol"] == "main"
            )
            claims = f"{page}\n{fixture['responsibility']}\n{contract['responsibility']}".lower()
            with self.subTest(stem=stem):
                self.assertIn("diagonal-only", fixture["responsibility"].lower())
                self.assertIn(
                    "does not distinguish pointwise apply from a full sparse solve",
                    fixture["responsibility"].lower(),
                )
                self.assertIn("no sparse negative control", contract["responsibility"].lower())
                for phrase in forbidden:
                    self.assertNotIn(phrase, claims)

        fixture_source = self._read(
            "backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp"
        )
        fixture_body = fixture_source.split("struct ManufacturedSpdMatrix", 1)[1].split("};", 1)[0]
        self.assertIn("std::vector<double> diag", fixture_body)
        self.assertIn("y[i] = diag[i] * x[i]", fixture_body)

    def test_0510_maps_exact_index_operator_and_si_contracts(self) -> None:
        page = self._read("docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md")
        source_map = json.loads(
            self._read(
                "docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.source-map.json"
            )
        )
        symbols = {symbol["latex"]: symbol for symbol in source_map["symbols"]}
        equation_labels = set(re.findall(
            r"```\{math\}\s*\n(?::[^\n]+\n)*:label:\s*([^\s]+)", page
        ))
        mapped_equations = {equation["id"] for equation in source_map["equations"]}
        self.assertEqual(equation_labels, mapped_equations)
        self.assertNotIn(r"\[", page)
        self.assertNotIn(r"\]", page)
        required_tokens = {
            "i", "k", "n", "R_m", "R_{m_i}", "R_{m_n}",
            "P_m", "P_{m_i}", "P_{m_k}", "\\sum_i",
            "\\mathbin{\\cdot}", "\\lVert\\cdot\\rVert", "(\\cdot)^T",
            "m_{0,i},m_{1,i}", "\\mathrm{fp}", "\\in", "\\le", "<",
        }
        self.assertTrue(required_tokens <= symbols.keys(), required_tokens - symbols.keys())
        self.assertNotIn("a,b", symbols)
        self.assertNotIn("operand-dependent SI unit", page)
        self.assertNotIn("operand-dependent SI unit", json.dumps(source_map))
        self.assertNotIn("\\mathcal{R}_{m_n}", page)
        self.assertIn(r"E(R_m(\lambda p))", page)
        for symbol in source_map["symbols"]:
            self.assertTrue(
                symbol["si_unit"] == "1" or symbol["si_unit"].startswith("\\mathrm{"),
                symbol,
            )
        for equation in source_map["equations"]:
            self.assertTrue(equation["symbols"], equation["id"])

    def test_performance_package_combined_mirror_and_manifest_stats_are_exact(self) -> None:
        package = (
            self.root
            / "docs/performance/fem-gpu-performance-remediation-2026-09-01"
            / "fem-gpu-performance-remediation-2026-09-01"
        )
        manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
        combined = (
            self.root
            / "docs/performance/fem-gpu-performance-remediation-2026-09-01"
            / "fem-gpu-performance-remediation-plan-combined-2026-09-01.md"
        ).read_text(encoding="utf-8")

        for entry in manifest["files"]:
            name = Path(entry["path"]).name
            source = (package / name).read_text(encoding="utf-8").strip()
            mirror = self._combined_block(combined, name)
            if name == "README.md":
                mirror = mirror.replace(
                    "(fem-gpu-performance-remediation-2026-09-01/", "("
                )
            with self.subTest(name=name, contract="combined"):
                self.assertEqual(source, mirror)

            text = (package / name).read_text(encoding="utf-8")
            expected_stats = {
                "bytes": len(text.encode("utf-8")),
                "lines": len(text.splitlines()),
                "words": len(text.split()),
            }
            with self.subTest(name=name, contract="manifest"):
                self.assertEqual(expected_stats, {
                    field: entry[field] for field in ("bytes", "lines", "words")
                })

    def test_rl01_status_is_identical_on_every_published_surface(self) -> None:
        package_root = (
            "docs/performance/fem-gpu-performance-remediation-2026-09-01/"
            "fem-gpu-performance-remediation-2026-09-01"
        )
        matrix = self._read(f"{package_root}/10-finding-coverage-matrix.md")
        row = next(line for line in matrix.splitlines() if line.startswith("| RL-01 |"))
        combined = self._read(
            "docs/performance/fem-gpu-performance-remediation-2026-09-01/"
            "fem-gpu-performance-remediation-plan-combined-2026-09-01.md"
        )
        combined_matrix = self._combined_block(
            combined, "10-finding-coverage-matrix.md"
        )
        combined_row = next(
            line for line in combined_matrix.splitlines() if line.startswith("| RL-01 |")
        )
        self.assertEqual(row, combined_row)

        surfaces = (
            self._read(f"{package_root}/README.md"),
            self._read(f"{package_root}/07-relaxation-preconditioning-remediation.md"),
            matrix,
            combined,
            self._read(f"{package_root}/manifest.json"),
        )
        for surface in surfaces:
            self.assertIn("NOT VERIFIED", surface)


if __name__ == "__main__":
    unittest.main()
