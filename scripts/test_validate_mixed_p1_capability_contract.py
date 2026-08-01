import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
VALIDATOR = REPO_ROOT / "scripts/validate_mixed_p1_capability_contract.py"


class MixedP1CapabilityContractTest(unittest.TestCase):
    def _run(self, root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(VALIDATOR), "--root", str(root)],
            check=False,
            capture_output=True,
            text=True,
        )

    def _copy_contract(self, root: Path) -> None:
        specs = root / "docs/specs"
        specs.mkdir(parents=True)
        for name in ("capability-matrix-v0.md", "capability-matrix-v0.json"):
            (specs / name).write_text(
                (REPO_ROOT / "docs/specs" / name).read_text(encoding="utf-8"),
                encoding="utf-8",
            )
        runner = root / "crates/fullmag-runner/src/capabilities.rs"
        runner.parent.mkdir(parents=True)
        runner.write_text(
            (REPO_ROOT / "crates/fullmag-runner/src/capabilities.rs").read_text(
                encoding="utf-8"
            ),
            encoding="utf-8",
        )

    def test_repository_contract_is_consistent(self) -> None:
        result = self._run(REPO_ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_repository_cpu_lane_is_not_promoted_without_public_runtime_evidence(self) -> None:
        matrix = json.loads(
            (REPO_ROOT / "docs/specs/capability-matrix-v0.json").read_text(
                encoding="utf-8"
            )
        )
        by_id = {feature["id"]: feature for feature in matrix["features"]}
        for capability_id in (
            "mesh.topology.mixed_p1",
            "mesh.swept.prism",
            "mesh.transition.pyramid_tet",
            "mesh.exact_layer_count",
            "fem.cpu.exchange_demag.mixed_p1",
        ):
            self.assertEqual(
                by_id[capability_id]["lanes"]["fem_cpu_public"],
                "implemented",
                capability_id,
            )

    def test_repository_gpu_lane_is_implemented_without_public_promotion(self) -> None:
        matrix = json.loads(
            (REPO_ROOT / "docs/specs/capability-matrix-v0.json").read_text(
                encoding="utf-8"
            )
        )
        by_id = {feature["id"]: feature for feature in matrix["features"]}
        for capability_id in (
            "mesh.topology.mixed_p1",
            "mesh.swept.prism",
            "mesh.transition.pyramid_tet",
            "mesh.exact_layer_count",
            "fem.gpu.exchange_demag.mixed_p1",
        ):
            self.assertEqual(
                by_id[capability_id]["lanes"]["fem_gpu_public"],
                "implemented",
                capability_id,
            )

    def test_repository_publication_source_map_has_complete_thin_film_ir_paths(self) -> None:
        source_map = json.loads(
            (
                REPO_ROOT
                / "docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.source-map.json"
            ).read_text(encoding="utf-8")
        )
        parameters = {
            parameter["python"]: parameter
            for parameter in source_map["public_api"]["parameters"]
        }
        prefix = "problem_meta.runtime_metadata.mesh_workflow.per_geometry[]"
        self.assertEqual(
            {
                "GeometryMeshHandle.thin_film.maximum_element_size": f"{prefix}.maximum_element_size",
                "GeometryMeshHandle.thin_film.layers": f"{prefix}.through_thickness_elements",
                "GeometryMeshHandle.thin_film.topology": f"{prefix}.topology",
                "GeometryMeshHandle.thin_film.exact_layers": f"{prefix}.exact_layer_count",
                "GeometryMeshHandle.thin_film.transition": f"{prefix}.transition_policy",
                "GeometryMeshHandle.thin_film.order": f"{prefix}.order",
            },
            {
                parameter: details["problem_ir"]
                for parameter, details in parameters.items()
            },
        )
        self.assertEqual(
            parameters["GeometryMeshHandle.thin_film.maximum_element_size"][
                "compatibility_alias"
            ],
            {
                "python": "GeometryMeshHandle.thin_film.hmax",
                "problem_ir": f"{prefix}.hmax",
            },
        )

    def test_rejects_cpu_operator_demotion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._copy_contract(root)
            specs = root / "docs/specs"
            matrix_path = specs / "capability-matrix-v0.json"
            matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
            feature = next(
                item
                for item in matrix["features"]
                if item["id"] == "fem.cpu.exchange_demag.mixed_p1"
            )
            feature["lanes"]["fem_cpu_public"] = "unsupported"
            matrix_path.write_text(json.dumps(matrix), encoding="utf-8")

            result = self._run(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be implemented", result.stderr)

    def test_rejects_markdown_cpu_operator_demotion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._copy_contract(root)
            markdown = root / "docs/specs/capability-matrix-v0.md"
            markdown.write_text(
                markdown.read_text(encoding="utf-8").replace(
                    "| `fem.cpu.exchange_demag.mixed_p1` | `implemented` | implemented |",
                    "| `fem.cpu.exchange_demag.mixed_p1` | `unsupported` | source_visible |",
                    1,
                ),
                encoding="utf-8",
            )

            result = self._run(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Markdown status", result.stderr)

    def test_rejects_duplicate_or_extra_mixed_id(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._copy_contract(root)
            matrix_path = root / "docs/specs/capability-matrix-v0.json"
            matrix = matrix_path.read_text(encoding="utf-8")
            duplicate = json.loads(matrix)
            duplicate["features"].append(duplicate["features"][1])
            matrix_path.write_text(json.dumps(duplicate), encoding="utf-8")

            result = self._run(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate feature IDs", result.stderr)

    def test_rejects_duplicate_markdown_row(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._copy_contract(root)
            markdown = root / "docs/specs/capability-matrix-v0.md"
            row = "| `mesh.topology.mixed_p1` | CPU/GPU `implemented`; FDM `unsupported` | implemented | duplicate | none |\n"
            markdown.write_text(
                markdown.read_text(encoding="utf-8") + row,
                encoding="utf-8",
            )

            result = self._run(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exactly one status row", result.stderr)

    def test_rejects_runner_id_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._copy_contract(root)
            runner = root / "crates/fullmag-runner/src/capabilities.rs"
            runner.write_text(
                runner.read_text(encoding="utf-8").replace(
                    '"mesh.exact_layer_count",',
                    '"mesh.exact_layer_count_drifted",',
                    1,
                ),
                encoding="utf-8",
            )

            result = self._run(root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("runner mixed-P1 mesh capability IDs", result.stderr)


if __name__ == "__main__":
    unittest.main()
