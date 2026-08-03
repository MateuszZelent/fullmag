#!/usr/bin/env python3
"""RED/acceptance checks for the FEM analytic-demag qualification gate."""

from __future__ import annotations

import importlib.util
import hashlib
import io
import json
import math
import copy
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("validate_fem_demag_analytic_qualification.py")
SPEC = importlib.util.spec_from_file_location("analytic_demag_validator", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import wiring guard
    raise RuntimeError(f"cannot load analytic-demag validator: {SCRIPT_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FemDemagAnalyticQualificationRedTests(unittest.TestCase):
    def test_accepts_complete_geometry_derived_managed_matrix(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            suite_path = root / "suite.json"
            suite = json.loads(
                (Path(__file__).parents[1] / "examples/assets/fem_demag_analytic_qualification_suite_v1.json").read_text(encoding="utf-8")
            )
            suite_path.write_text(json.dumps(suite), encoding="utf-8")
            suite_sha256 = hashlib.sha256(suite_path.read_bytes()).hexdigest()
            source_snapshot_sha256 = "a" * 64
            source_path = root / "source.json"
            source_path.write_text(json.dumps({"source_snapshot_sha256": source_snapshot_sha256}), encoding="utf-8")
            runtime_path = root / "manifest.json"
            runtime_path.write_text(
                json.dumps(
                    {
                        "docker_image_id": "sha256:" + "b" * 64,
                        "native_libraries": {"fullmag_fem": {"sha256": "c" * 64}},
                    }
                ),
                encoding="utf-8",
            )
            artifact = {
                "schema_version": MODULE.SCHEMA,
                "managed_runtime_identity": {
                    "runtime_manifest_sha256": hashlib.sha256(runtime_path.read_bytes()).hexdigest(),
                    "native_library_sha256": "c" * 64,
                    "container_image": "sha256:" + "b" * 64,
                },
                "source_provenance": {
                    "source_snapshot_sha256": source_snapshot_sha256,
                    "qualification_suite_sha256": suite_sha256,
                },
                "physics_rows": [],
                "timing_rows": [],
            }
            errors = {"coarse": 0.02, "medium": 0.01, "fine": 0.005}
            scale_errors = {1.5: 0.01, 2.0: 0.007, 2.5: 0.004, 3.0: 0.002}
            for case in suite["cases"]:
                for axis in case["axes"]:
                    n_oracle = MODULE._case_oracle(case, axis)
                    for refinement in MODULE.REFINEMENTS:
                        for scale in MODULE.AIRBOX_SCALES:
                            mesh_sha256 = hashlib.sha256(f"{case['case_id']}:{refinement}:{scale}:mesh".encode()).hexdigest()
                            airbox_sha256 = hashlib.sha256(f"{case['case_id']}:{refinement}:{scale}:airbox".encode()).hexdigest()
                            problem_sha256 = hashlib.sha256(f"{case['case_id']}:{refinement}:{scale}:problem".encode()).hexdigest()
                            signature = hashlib.sha256(f"{case['case_id']}:{refinement}:{scale}:signature".encode()).hexdigest()
                            volume = 4.0 * math.pi * math.prod(case["semi_axes_m"]) / 3.0
                            ms = 800_000.0
                            error = errors[refinement] + scale_errors[scale]
                            energy = 0.5 * 4.0e-7 * math.pi * n_oracle * ms * ms * volume * 1.001 * (1.0 + error)
                            axis_index = {"x": 0, "y": 1, "z": 2}[axis]
                            field = [0.0, 0.0, 0.0]
                            field[axis_index] = -n_oracle * ms * (1.0 + error)
                            for backend in MODULE.BACKENDS:
                                row = {
                                    "case_id": case["case_id"], "axis": axis,
                                    "mesh_refinement": refinement, "airbox_scale": scale,
                                    "backend": backend, "initial_state_kind": "prescribed_uniform",
                                    "demag_evaluation_count": 1, "relaxation_algorithm": "none",
                                    "demag_solver": "CG", "demag_preconditioner": "AMG",
                                    "demag_rtol": 1e-12, "fresh_zero_solve": True,
                                    "precision": "double", "demag_realization": "poisson_robin",
                                    "solver_mesh_signature": signature,
                                    "solver_mesh_node_count": {"coarse": 100, "medium": 200, "fine": 400}[refinement],
                                    "solver_mesh_cell_count": {"coarse": 200, "medium": 400, "fine": 800}[refinement],
                                    "airbox_identity_sha256": airbox_sha256,
                                    "source_provenance": {"source_snapshot_sha256": source_snapshot_sha256, "serialized_typed_mesh_sha256": mesh_sha256, "problem_ir_sha256": problem_sha256},
                                    "ms_Apm": ms, "analytic_geometry_volume_m3": volume,
                                    "magnetic_weighted_volume_m3": volume * 1.001,
                                    "prescribed_m": [1.0 if component == axis_index else 0.0 for component in range(3)],
                                    "h_demag_mean_magnetic_Apm": field, "e_demag_J": energy,
                                    "e_demag_analytic_J": 0.5 * 4.0e-7 * math.pi * n_oracle * ms * ms * volume,
                                    "n_analytic": n_oracle, "demag_linear_residual": 1e-13,
                                    "demag_linear_iterations": 4, "magnetic_region_only": True,
                                    "field_lumped_weight_sha256": "d" * 64,
                                    "energy_lumped_weight_sha256": "d" * 64,
                                }
                                artifact["physics_rows"].append(row)
                                for repeat_index in MODULE.TIMING_REPEATS:
                                    artifact["timing_rows"].append({**row, "repeat_index": repeat_index, "demag_wall_time_ns": 1_000 + repeat_index})
            artifact_path = root / "artifact.json"
            artifact_path.write_text(json.dumps(artifact), encoding="utf-8")

            summary = MODULE.validate_qualification(
                artifact_path,
                suite_path,
                source_path,
                runtime_path,
            )

            self.assertTrue(summary["qualified"])
            with self.assertRaisesRegex(ValueError, "expected source identity and expected runtime manifest are required"):
                MODULE.validate_qualification(artifact_path, suite_path)
            mutations = (
                ("source identity", lambda value: value["source_provenance"].update({"source_snapshot_sha256": "0" * 64}), "current expected identity"),
                ("runtime identity", lambda value: value["managed_runtime_identity"].update({"native_library_sha256": "0" * 64}), "current managed runtime"),
                ("solve policy", lambda value: value["physics_rows"][0].update({"demag_solver": "GMRES"}), "solve policy"),
                ("typed mesh parity", lambda value: value["physics_rows"][1]["source_provenance"].update({"serialized_typed_mesh_sha256": "0" * 64}), "serialized typed mesh bytes mismatch"),
                ("field vector parity", lambda value: value["physics_rows"][1].update({"h_demag_mean_magnetic_Apm": [value["physics_rows"][1]["h_demag_mean_magnetic_Apm"][0], 0.04, -0.04]}), "full H_demag vector mismatch"),
                ("positive timing", lambda value: value["timing_rows"][0].update({"demag_wall_time_ns": 0}), "must be positive"),
                ("weight identity", lambda value: value["physics_rows"][0].update({"energy_lumped_weight_sha256": "0" * 64}), "same lumped-volume weights"),
                ("weighted volume envelope", lambda value: value["physics_rows"][0].update({"magnetic_weighted_volume_m3": value["physics_rows"][0]["magnetic_weighted_volume_m3"] * 1.2}), "weighted magnetic volume"),
            )
            for name, mutate, message in mutations:
                with self.subTest(name=name):
                    candidate = copy.deepcopy(artifact)
                    mutate(candidate)
                    candidate_path = root / f"{name}.json"
                    candidate_path.write_text(json.dumps(candidate), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, message):
                        MODULE.validate_qualification(candidate_path, suite_path, source_path, runtime_path)

            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as missing_identity:
                MODULE.main(["--artifact", str(artifact_path), "--suite", str(suite_path)])
            self.assertEqual(missing_identity.exception.code, 2)

    def test_rejects_missing_complete_managed_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "missing complete managed artifact"):
                MODULE.validate_qualification(Path(temporary) / "absent.json")

    def test_rejects_relaxed_box_artifact_as_analytic_qualification(self) -> None:
        """A relaxation-derived box row cannot be promoted as a field oracle."""
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "relaxed-box.json"
            artifact.write_text(
                json.dumps(
                    {
                        "schema_version": "fullmag.fem_demag_analytic_qualification.v1",
                        "runtime": {"managed": True},
                        "physics_rows": [
                            {
                                "case_id": "box500_airbox_exchange_demag",
                                "initial_state_kind": "relaxed",
                                "demag_evaluation_count": 64,
                                "relaxation_algorithm": "nonlinear_cg",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "prescribed_uniform"):
                MODULE.validate_qualification(
                    artifact,
                    expected_source_identity_path=Path("source-identity.json"),
                    expected_runtime_manifest_path=Path("runtime-manifest.json"),
                )

    def test_rejects_self_certified_sphere_factor(self) -> None:
        ms = 800_000.0
        volume = 4.0 * math.pi * (50e-9) ** 3 / 3.0
        snapshot = "a" * 64
        row = {
            "case_id": "sphere_uniform",
            "axis": "z",
            "mesh_refinement": "fine",
            "airbox_scale": 3.0,
            "backend": "fem_cpu",
            "initial_state_kind": "prescribed_uniform",
            "demag_evaluation_count": 1,
            "relaxation_algorithm": "none",
            "demag_solver": "CG",
            "demag_preconditioner": "AMG",
            "demag_rtol": 1e-12,
            "fresh_zero_solve": True,
            "precision": "double",
            "demag_realization": "poisson_robin",
            "solver_mesh_signature": "b" * 64,
            "solver_mesh_node_count": 10,
            "solver_mesh_cell_count": 20,
            "airbox_identity_sha256": "e" * 64,
            "source_provenance": {
                "source_snapshot_sha256": snapshot,
                "serialized_typed_mesh_sha256": "c" * 64,
                "problem_ir_sha256": "d" * 64,
            },
            "ms_Apm": ms,
            "analytic_geometry_volume_m3": volume,
            "magnetic_weighted_volume_m3": volume,
            "prescribed_m": [0.0, 0.0, 1.0],
            "h_demag_mean_magnetic_Apm": [0.0, 0.0, -ms / 3.0],
            "e_demag_J": 0.5 * 4.0e-7 * math.pi * (1.0 / 3.0) * ms * ms * volume,
            "e_demag_analytic_J": 0.5 * 4.0e-7 * math.pi * (1.0 / 3.0) * ms * ms * volume,
            "n_analytic": 0.5,
            "demag_linear_residual": 1.0e-13,
            "demag_linear_iterations": 4,
            "magnetic_region_only": True,
            "field_lumped_weight_sha256": "f" * 64,
            "energy_lumped_weight_sha256": "f" * 64,
        }
        sphere = {
            "case_id": "sphere_uniform",
            "kind": "sphere",
            "semi_axes_m": [50e-9, 50e-9, 50e-9],
        }

        with self.assertRaisesRegex(ValueError, "geometry-derived sphere/Osborn oracle"):
            MODULE._validate_row(
                row,
                0,
                sphere,
                snapshot,
                {"demag_solver": "CG", "demag_preconditioner": "AMG", "demag_rtol": 1e-12, "fresh_zero_solve": True, "precision": "double", "demag_realization": "poisson_robin", "magnetic_weighted_volume_relative_error_max": 0.05},
                0.05,
            )

    def test_rejects_incomplete_cpu_gpu_pair_without_key_error(self) -> None:
        rows = [
            {
                "case_id": "sphere_uniform",
                "axis": "z",
                "mesh_refinement": "fine",
                "airbox_scale": 3.0,
                "backend": "fem_cpu",
            }
        ]

        with self.assertRaisesRegex(ValueError, "CPU/GPU pair is incomplete"):
            MODULE._validate_cpu_gpu_parity(rows)


if __name__ == "__main__":
    unittest.main()
