#!/usr/bin/env python3
"""Focused tests for FEM demag mesh/airbox qualification validation."""

from __future__ import annotations

import csv
import json
import tempfile
import unittest
from pathlib import Path

from validate_fem_demag_mesh_airbox_convergence import validate_qualification


BACKENDS = ("fem_cpu", "fem_gpu")
ALGORITHMS = ("projected_gradient_bb", "nonlinear_cg")


class FemDemagMeshAirboxConvergenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.fixtures = {
            "coarse": self._fixture("coarse", "a", 52, 149),
            "medium": self._fixture("medium", "b", 153, 473),
            "fine": self._fixture("fine", "c", 1200, 5138),
        }
        self.suite_path = self.root / "suite.json"
        self.suite_path.write_text(
            json.dumps(
                {
                    "schema": "fullmag.fem_gpu.performance_fixture_suite.v1",
                    "scenario": "box500_airbox_exchange_demag",
                    "airbox_factor": 2.0,
                    "fixtures": list(self.fixtures.values()),
                }
            ),
            encoding="utf-8",
        )
        self.mesh_inputs = self._write_mesh_inputs(repeat_count=2)
        self.airbox_inputs = self._write_airbox_inputs()

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    @staticmethod
    def _fixture(
        resolution: str,
        signature_character: str,
        node_count: int,
        element_count: int,
    ) -> dict[str, object]:
        return {
            "resolution": resolution,
            "solver_mesh_path": f"{resolution}.mesh.json",
            "solver_mesh_sha256": signature_character * 64,
            "solver_mesh_signature": signature_character * 64,
            "problem_ir_sha256": signature_character.upper() * 64,
            "node_count": node_count,
            "element_count": element_count,
            "domain_hmax_m": 1.0,
            "airbox_hmax_m": 2.0,
        }

    @staticmethod
    def _write_csv(path: Path, rows: list[dict[str, object]]) -> None:
        fieldnames = list(rows[0])
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)

    @staticmethod
    def _read_csv(path: Path) -> list[dict[str, str]]:
        with path.open(encoding="utf-8", newline="") as handle:
            return list(csv.DictReader(handle))

    def _mesh_row(
        self,
        resolution: str,
        backend: str,
        algorithm: str,
        repeat_index: int,
    ) -> dict[str, object]:
        fixture = self.fixtures[resolution]
        energy = {"coarse": 80.0, "medium": 95.0, "fine": 100.0}[resolution]
        field = {"coarse": 160.0, "medium": 190.0, "fine": 200.0}[resolution]
        return {
            "status": "ok",
            "solver_mesh_signature": fixture["solver_mesh_signature"],
            "qualification_fixture_problem_ir_sha256": fixture["problem_ir_sha256"],
            "node_count": fixture["node_count"],
            "element_count": fixture["element_count"],
            "backend": backend,
            "relaxation_algorithm": algorithm,
            "repeat_index": repeat_index,
            "final_e_demag_j": energy,
            "max_h_demag": field,
        }

    def _write_mesh_inputs(
        self,
        *,
        repeat_count: int,
    ) -> dict[str, tuple[Path, Path]]:
        inputs: dict[str, tuple[Path, Path]] = {}
        for resolution in self.fixtures:
            warmup_rows = [
                self._mesh_row(resolution, backend, algorithm, 0)
                for backend in BACKENDS
                for algorithm in ALGORITHMS
            ]
            measured_rows = [
                self._mesh_row(resolution, backend, algorithm, repeat_index)
                for backend in BACKENDS
                for algorithm in ALGORITHMS
                for repeat_index in range(repeat_count)
            ]
            warmup_path = self.root / f"{resolution}-warmup.csv"
            measured_path = self.root / f"{resolution}.csv"
            self._write_csv(warmup_path, warmup_rows)
            self._write_csv(measured_path, measured_rows)
            inputs[resolution] = (warmup_path, measured_path)
        return inputs

    def _write_airbox_inputs(self) -> dict[float, Path]:
        inputs: dict[float, Path] = {}
        observables = {
            1.0: (90.0, 180.0),
            1.5: (98.0, 196.0),
            2.0: (100.0, 200.0),
        }
        for scale, (energy, field) in observables.items():
            rows = []
            problem_ir_sha256 = f"{int(scale * 10):064x}"
            for backend in BACKENDS:
                rows.append(
                    {
                        "status": "ok",
                        "backend": backend,
                        "relaxation_algorithm": "nonlinear_cg",
                        "repeat_index": 0,
                        "qualification_airbox_extent_scale": scale,
                        "qualification_airbox_size_x_m": scale * 1.0e-6,
                        "qualification_airbox_size_y_m": scale * 1.0e-6,
                        "qualification_airbox_size_z_m": scale * 1.0e-6,
                        "executed_problem_ir_sha256": problem_ir_sha256,
                        "final_e_demag_j": energy,
                        "max_h_demag": field,
                    }
                )
            path = self.root / f"airbox-{scale}.csv"
            self._write_csv(path, rows)
            inputs[scale] = path
        return inputs

    def test_accepts_exact_cartesian_matrix_and_convergent_observables(self) -> None:
        output_path = self.root / "summary.json"
        summary = validate_qualification(
            fixture_suite_path=self.suite_path,
            mesh_inputs=self.mesh_inputs,
            airbox_inputs=self.airbox_inputs,
            repeat_count=2,
            output_path=output_path,
        )

        self.assertEqual(summary["status"], "pass")
        self.assertEqual(summary["qualification_status"], "no_go")
        self.assertEqual(
            summary["mesh_observable_convergence"]["status"],
            "trend_only_nonqualifying",
        )
        self.assertEqual(summary["mesh_matrix"]["measured_row_count"], 24)
        self.assertEqual(summary["airbox_extent_sweep"]["row_count"], 6)
        self.assertEqual(
            json.loads(output_path.read_text(encoding="utf-8")),
            summary,
        )

    def test_rejects_duplicate_that_masks_missing_cartesian_key(self) -> None:
        _, measured_path = self.mesh_inputs["medium"]
        rows = self._read_csv(measured_path)
        rows[-1] = dict(rows[0])
        self._write_csv(measured_path, rows)

        with self.assertRaisesRegex(ValueError, "Cartesian key"):
            validate_qualification(
                fixture_suite_path=self.suite_path,
                mesh_inputs=self.mesh_inputs,
                airbox_inputs=self.airbox_inputs,
                repeat_count=2,
            )

    def test_rejects_malformed_csv(self) -> None:
        _, measured_path = self.mesh_inputs["coarse"]
        rows = self._read_csv(measured_path)
        for row in rows:
            row.pop("max_h_demag")
        self._write_csv(measured_path, rows)

        with self.assertRaisesRegex(ValueError, "max_h_demag"):
            validate_qualification(
                fixture_suite_path=self.suite_path,
                mesh_inputs=self.mesh_inputs,
                airbox_inputs=self.airbox_inputs,
                repeat_count=2,
            )

    def test_rejects_malformed_fixture_json(self) -> None:
        self.suite_path.write_text("{", encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "fixture suite JSON"):
            validate_qualification(
                fixture_suite_path=self.suite_path,
                mesh_inputs=self.mesh_inputs,
                airbox_inputs=self.airbox_inputs,
                repeat_count=2,
            )

    def test_rejects_nonconvergent_mesh_observables(self) -> None:
        _, measured_path = self.mesh_inputs["medium"]
        rows = self._read_csv(measured_path)
        for row in rows:
            row["final_e_demag_j"] = "10.0"
            row["max_h_demag"] = "20.0"
        self._write_csv(measured_path, rows)

        with self.assertRaisesRegex(ValueError, "mesh trend check"):
            validate_qualification(
                fixture_suite_path=self.suite_path,
                mesh_inputs=self.mesh_inputs,
                airbox_inputs=self.airbox_inputs,
                repeat_count=2,
            )

    def test_rejects_nonconvergent_airbox_extent_sweep(self) -> None:
        path = self.airbox_inputs[2.0]
        rows = self._read_csv(path)
        for row in rows:
            row["final_e_demag_j"] = "150.0"
            row["max_h_demag"] = "300.0"
        self._write_csv(path, rows)

        with self.assertRaisesRegex(ValueError, "airbox convergence"):
            validate_qualification(
                fixture_suite_path=self.suite_path,
                mesh_inputs=self.mesh_inputs,
                airbox_inputs=self.airbox_inputs,
                repeat_count=2,
            )

    def test_preserves_metrics_in_failure_report(self) -> None:
        path = self.airbox_inputs[2.0]
        rows = self._read_csv(path)
        for row in rows:
            row["final_e_demag_j"] = "150.0"
            row["max_h_demag"] = "300.0"
        self._write_csv(path, rows)
        output_path = self.root / "failed-summary.json"

        with self.assertRaisesRegex(ValueError, "airbox convergence"):
            validate_qualification(
                fixture_suite_path=self.suite_path,
                mesh_inputs=self.mesh_inputs,
                airbox_inputs=self.airbox_inputs,
                repeat_count=2,
                output_path=output_path,
            )

        summary = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(summary["status"], "fail")
        airbox = summary["airbox_extent_sweep"]
        self.assertEqual(airbox["status"], "fail")
        self.assertEqual(len(airbox["metrics"]), 4)
        self.assertEqual(len(airbox["failures"]), 4)
        self.assertEqual(
            airbox["metrics"][0]["values"]["2.0"],
            150.0,
        )


if __name__ == "__main__":
    unittest.main()
