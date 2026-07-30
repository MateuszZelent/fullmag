from __future__ import annotations

import csv
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from scripts import plan_fem_sp4_mixed_matrix as planner
from scripts import run_fem_sp4_mixed_matrix as executor

ORIGINAL_STORAGE_VALIDATOR = executor._validate_durable_storage
ORIGINAL_PIN_EXECUTION_IDENTITY = executor._pin_execution_identity
ORIGINAL_ASSERT_EXECUTION_IDENTITY = executor._assert_execution_identity
ORIGINAL_AUTHORITATIVE_RUNTIME_VALIDATOR = executor._run_authoritative_runtime_validator


class MixedSP4MatrixExecutorTests(unittest.TestCase):
    @staticmethod
    def _runtime_manifest_payload() -> dict[str, object]:
        library = {
            "path": "lib/library.so",
            "sha256": "4" * 64,
            "soname": "library.so",
            "loaded_soname": "library.so",
            "cuda_required": True,
            "cubins": ["sm_89"],
            "ptx": [],
        }
        return {
            "schema": 3,
            "runtime": "fem-gpu-host",
            "variant": "hypre-baseline",
            "build_identity": {
                "git_commit": "a" * 40,
                "worktree_state": "dirty",
                "source_snapshot_sha256": "b" * 64,
            },
            "integrity": {
                "launcher_sha256": "1" * 64,
                "worker_sha256": "2" * 64,
                "api_sha256": "3" * 64,
            },
            "native_libraries": {
                name: {**library, "path": f"lib/{name}.so", "soname": f"{name}.so", "loaded_soname": f"{name}.so"}
                for name in ("fullmag_fem", "mfem", "hypre", "libceed")
            },
            "build": {
                "mfem_version": "4.9",
                "hypre_version": "3.1.0",
                "libceed_version": "0.12.0",
                "cuda_toolkit": "12.8",
            },
            "runtime_diagnostics": {
                "device_name": "NVIDIA GeForce RTX 4080",
                "compute_capability": "8.9",
                "cuda_driver_version": "575.64",
            },
        }

    def setUp(self) -> None:
        self.storage_patch = mock.patch.object(
            executor,
            "_validate_durable_storage",
            autospec=True,
        )
        self.storage_validator = self.storage_patch.start()
        self.addCleanup(self.storage_patch.stop)
        self.authoritative_receipt = {
            "validator": "/repo/scripts/validate_managed_fem_runtime_bundle.py",
            "validator_sha256": "5" * 64,
            "runtime_root": "/runtime",
            "result": {
                "bundle": "valid",
                "git_commit": "a" * 40,
                "worktree_state": "dirty",
                "source_snapshot_sha256": "b" * 64,
                "compute_capability": "8.9",
                "source_identity_compatibility": "exact-schema-3",
            },
        }
        self.authoritative_patch = mock.patch.object(
            executor,
            "_run_authoritative_runtime_validator",
            return_value=self.authoritative_receipt,
        )
        self.authoritative_validator = self.authoritative_patch.start()
        self.addCleanup(self.authoritative_patch.stop)
        self.execution_identity = {
            "plan_source_snapshot_sha256": "9" * 64,
            "bounded_source_sha256": hashlib.sha256(
                executor.BOUNDED_SOURCE.read_bytes()
            ).hexdigest(),
            "runtime_manifest_sha256": "8" * 64,
            "runtime": "fem-gpu-host",
            "variant": "test-runtime",
            "build_identity": {
                "git_commit": "7" * 40,
                "worktree_state": "dirty",
                "source_snapshot_sha256": "6" * 64,
            },
            "gpu_device_identity": {
                "device_name": "NVIDIA GeForce RTX 4080",
                "compute_capability": "8.9",
            },
            "native_build_identity": {
                "mfem_version": "4.9",
                "hypre_version": "3.1.0",
            },
        }
        self.pin_patch = mock.patch.object(
            executor,
            "_pin_execution_identity",
            return_value=self.execution_identity,
            create=True,
        )
        self.pin_identity = self.pin_patch.start()
        self.addCleanup(self.pin_patch.stop)
        self.guard_patch = mock.patch.object(
            executor,
            "_assert_execution_identity",
            create=True,
        )
        self.identity_guard = self.guard_patch.start()
        self.addCleanup(self.guard_patch.stop)

    def _plans(self) -> list[dict[str, object]]:
        return [planner.build_plan(stage) for stage in planner.STAGES]

    @staticmethod
    def _successful_launch(
        spec: dict[str, object],
        artifact_dir: Path,
        environment: dict[str, str],
        log_path: Path,
        *,
        budget_exhausted: bool = False,
    ) -> int:
        artifact_dir.mkdir(parents=True)
        engine = "fem_cpu_native" if spec["device"] == "cpu" else "fem_native_gpu"
        fingerprint = "sha256:" + "a" * 64
        source_hash = hashlib.sha256(executor.BOUNDED_SOURCE.read_bytes()).hexdigest()
        cell_quality = {"prism6": 0.8, "pyramid5": 0.7, "tet4": 0.6}
        final_torque_apm = 4.0 if budget_exhausted else 0.5
        final_torque_t = final_torque_apm * (4e-7 * math.pi)
        metadata = {
            "source_hash": source_hash,
            "status": "completed",
            "requested_execution": {
                "backend": "fem",
                "device": spec["device"],
                "precision": "double",
                "mode": "strict",
                "fallback_policy": "forbidden",
            },
            "execution_provenance": {
                "execution_engine": engine,
                "precision": "double",
                "lossy_fallback_used": False,
            },
            "problem_meta": {
                "runtime_metadata": {
                    "domain_frame": {
                        "declared_universe": {
                            "size": spec["airbox_dimensions_m"],
                            "airbox_hmax": spec["airbox_hmax_m"],
                        }
                    },
                    "mesh_workflow": {
                        "per_geometry": [
                            {
                                "maximum_element_size": spec["mesh_hmax_m"],
                                "through_thickness_elements": spec["layers"],
                            }
                        ]
                    },
                }
            },
            "execution_plan": {
                "backend_plan": {
                    "mesh_parts": [
                        {
                            "role": "magnetic_object",
                            "node_indices": [0],
                        }
                    ]
                }
            },
            "mesh": {
                "node_count": 1,
                "topology_fingerprint": fingerprint,
                "mesh_build_report": {
                    "fallbacks_triggered": [],
                    "degraded": False,
                    "mixed_topology_provenance": {
                        "requested_topology": spec["topology_variant"],
                        "resolved_topology": spec["topology_variant"],
                        "requested_device": spec["device"],
                        "precision": "double",
                        "accepted_certificate_fingerprint": fingerprint,
                    },
                    "mixed_layer_topology_certificate": {
                        "schema_version": "mixed_layer_topology_certificate.v1",
                        "certificate_status": "accepted",
                        "requested_sweep_direction": "z",
                        "resolved_sweep_direction": "z",
                        "topology_fingerprint": fingerprint,
                        "topology_fingerprint_version": "v3",
                        "requested_layer_count": spec["layers"],
                        "realized_layer_count": spec["layers"],
                        "magnetic_plane_coordinates_m": [
                            float(index) for index in range(int(spec["layers"]) + 1)
                        ],
                        "plane_tolerance_m": 1.0e-12,
                        "transition_shell_thickness_m": 1.0e-9,
                        "transition_shell_interface_tri3_count": 1,
                        "interface_marker": 1,
                        "outer_boundary_marker": 2,
                        "magnetic_bounds_min_m": [-2.5e-7, -6.25e-8, -1.5e-9],
                        "magnetic_bounds_max_m": [2.5e-7, 6.25e-8, 1.5e-9],
                        "airbox_bounds_min_m": [-4.0e-7, -1.25e-7, -1.0e-7],
                        "airbox_bounds_max_m": [4.0e-7, 1.25e-7, 1.0e-7],
                        "magnetic_bounds_relative_error": 0.0,
                        "airbox_bounds_relative_error": 0.0,
                        "cell_family_counts_by_part": {
                            "magnetic": {"prism6": 1},
                            "transition_air": {"pyramid5": 1, "tet4": 1},
                            "far_air": {"tet4": 1},
                        },
                        "cell_family_counts_by_marker": {
                            "1": {"prism6": 1},
                            "2": {"pyramid5": 1, "tet4": 2},
                        },
                        "facet_family_counts_by_role_marker": {
                            "interface:1": {"tri3": 1},
                            "outer_boundary:2": {"tri3": 1, "quad4": 1},
                        },
                        "jacobian_minima_m3_by_family": {
                            family: 1.0e-27 for family in cell_quality
                        },
                        "quality_metric": "tetra_decomposition_scaled_jacobian.v1",
                        "scaled_jacobian_minima_by_family": cell_quality,
                        "scaled_jacobian_p05_by_family": cell_quality,
                        "magnetic_volume_m3": 1.0e-21,
                        "expected_magnetic_volume_m3": 1.0e-21,
                        "magnetic_relative_volume_error": 0.0,
                        "air_volume_m3": 3.0e-20,
                        "shared_domain_volume_m3": 3.1e-20,
                        "expected_shared_domain_volume_m3": 3.1e-20,
                        "shared_domain_relative_volume_error": 0.0,
                        "marker_coverage_complete": True,
                        "nonconforming_face_count": 0,
                        "orphan_face_count": 0,
                        "nonmanifold_face_count": 0,
                        "coincident_interface_face_count": 0,
                        "gmsh_version": "4.15.2",
                        "strategy": "shared_geo_extrusion_partitioned_pyramid_tet.v2",
                        "effective_gmsh_thread_count": 1,
                        "deterministic_inputs": {"fixture": True},
                        "fallbacks_triggered": [],
                    },
                },
            },
            f"fem_{spec['device']}_relaxation_qualification": {
                "relaxation_algorithm": spec["relaxation_algorithm"],
                "converged": not budget_exhausted,
                "stop_reason": "max_steps" if budget_exhausted else "torque",
                "stop_metric_kind": "steps" if budget_exhausted else "max_torque_apm",
                "stop_metric_unit": "count" if budget_exhausted else "A/m",
                "stop_metric_name": "steps" if budget_exhausted else "max_torque_apm",
                "stop_metric_value": 1.0 if budget_exhausted else final_torque_apm,
                "stop_threshold": 1.0 if budget_exhausted else spec["torque_tolerance_apm"],
                "executed_steps": 1,
                "total_rhs_evals": 2,
                "rejected_attempts": 0,
                "final_energy_terms_j": {
                    "E_ex": 0.2,
                    "E_demag": 0.3,
                    "E_ext": 0.0,
                    "e_drive": 0.0,
                    "E_ani": 0.0,
                    "E_dmi": 0.0,
                    "E_total": 0.5,
                },
                "final_torque_apm": final_torque_apm,
                "final_torque_t": final_torque_t,
                "norm_defect": 0.0,
            },
        }
        if spec["device"] == "gpu":
            control_syncs = {
                "llg_overdamped": 0,
                "projected_gradient_bb": 7,
                "nonlinear_cg": 6,
            }[str(spec["relaxation_algorithm"])]
            metadata["execution_provenance"].update(
                {
                    "mfem_device": "cuda",
                    "fem_execution_mode": "all_in_gpu_legacy_sparse",
                    "fem_data_residency": "device_source_of_truth",
                    "fem_exchange_operator_mode": "legacy_sparse_gpu",
                    "uses_cuda_kernels": True,
                    "uses_gpu_poisson": True,
                    "fem_demag_operator_mode": "device_hypre_poisson",
                    "hypre_execution_policy": "device",
                    "demag_residency": "device",
                    "fem_gpu_state_allocated": True,
                    "hot_loop_host_sync_count": control_syncs,
                    "hot_loop_exchange_h2d_bytes": 0,
                    "hot_loop_exchange_d2h_bytes": 0,
                    "hot_loop_exchange_host_sync_count": 0,
                    "hot_loop_compute_h2d_bytes": 0,
                    "hot_loop_compute_d2h_bytes": 0,
                    "hot_loop_compute_host_sync_count": 0,
                    "hot_loop_control_scalar_d2h_bytes": control_syncs * 8,
                    "hot_loop_control_scalar_host_sync_count": control_syncs,
                    "device_name": "NVIDIA GeForce RTX 4080",
                    "compute_capability": "8.9",
                    "mfem_version": "4.9",
                }
            )
            metadata["fem_gpu_relaxation_qualification"]["device_policy"] = {
                "execution_mode": "all_in_gpu_legacy_sparse",
                "data_residency": "device_source_of_truth",
                "exchange_operator_mode": "legacy_sparse_gpu",
                "demag_operator_mode": "device_hypre_poisson",
                "uses_cuda_kernels": True,
                "uses_gpu_poisson": True,
                "hot_loop_exchange_host_sync_count": 0,
                "hot_loop_compute_host_sync_count": 0,
                "hot_loop_control_scalar_host_sync_count": control_syncs,
            }
            metadata["demag_runtime"] = {
                "mfem_device": "cuda",
                "solver": "HyprePCG",
                "preconditioner": "HypreBoomerAMG",
                "relative_tolerance": 1.0e-12,
                "final_residual_norm": 1.0e-13,
                "hypre_version": "3.1.0",
            }
        (artifact_dir / "metadata.json").write_text(
            json.dumps(metadata), encoding="utf-8"
        )
        with (artifact_dir / "scalars.csv").open(
            "w", newline="", encoding="utf-8"
        ) as stream:
            writer = csv.DictWriter(
                stream,
                fieldnames=(
                    "step",
                    "time",
                    "E_ex",
                    "E_demag",
                    "E_total",
                    "max_torque_Apm",
                    "max_torque_T",
                ),
            )
            writer.writeheader()
            writer.writerow(
                {
                    "step": 0,
                    "time": 0.0,
                    "E_ex": 0.4,
                    "E_demag": 0.6,
                    "E_total": 1.0,
                    "max_torque_Apm": 4.0,
                    "max_torque_T": 5.0e-6,
                }
            )
            writer.writerow(
                {
                    "step": 1,
                    "time": 0.0,
                    "E_ex": 0.2,
                    "E_demag": 0.3,
                    "E_total": 0.5,
                    "max_torque_Apm": final_torque_apm,
                    "max_torque_T": final_torque_t,
                }
            )
        (artifact_dir / "m_final.json").write_text(
            json.dumps(
                {
                    "observable": "m",
                    "unit": "dimensionless",
                    "step": 1,
                    "provenance": {
                        "source_hash": source_hash,
                        "execution_engine": engine,
                        "precision": "double",
                    },
                    "values": [[1.0, 0.0, 0.0]],
                }
            ),
            encoding="utf-8",
        )
        log_path.write_text(
            f"resolved_engine_id={engine} fallback=None\n", encoding="utf-8"
        )
        return 0

    def test_collects_exactly_fifteen_unique_execution_cases(self) -> None:
        cases = executor.collect_execution_cases(self._plans())

        self.assertEqual(len(cases), 15)
        self.assertEqual(len({case["run_id"] for case in cases}), 15)
        self.assertEqual(len({case["artifact_path"] for case in cases}), 15)
        self.assertEqual(
            {case["layers"] for case in cases},
            {1, 2, 3},
        )
        self.assertEqual(
            {case["device"] for case in cases},
            {"cpu", "gpu"},
        )
        self.assertEqual(
            {case["airbox_id"] for case in cases},
            {"baseline", "expanded"},
        )

    def test_executes_cases_with_identity_environment_and_manifests(self) -> None:
        observed: list[tuple[dict[str, object], dict[str, str]]] = []

        def launch(
            spec: dict[str, object],
            artifact_dir: Path,
            environment: dict[str, str],
            log_path: Path,
        ) -> int:
            observed.append((spec, environment))
            return self._successful_launch(spec, artifact_dir, environment, log_path)

        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            root = durable_root / "matrix"
            summary = executor.execute_matrix(
                root,
                durable_root=durable_root,
                max_steps=1,
                launch=launch,
            )

            self.assertEqual(summary["status"], "completed_nonqualifying")
            self.assertEqual(summary["executed_case_count"], 15)
            self.assertEqual(len(observed), 15)
            for spec, environment in observed:
                self.assertEqual(environment["FULLMAG_SP4_PHASE"], "relax")
                self.assertEqual(environment["FULLMAG_SP4_TOPOLOGY_VARIANT"], "mixed_p1")
                self.assertEqual(environment["FULLMAG_SP4_LAYERS"], str(spec["layers"]))
                self.assertEqual(environment["FULLMAG_SP4_MESH"], spec["mesh_level"])
                self.assertEqual(environment["FULLMAG_SP4_AIRBOX"], spec["airbox_id"])
                self.assertEqual(environment["FULLMAG_SP4_DEVICE"], spec["device"])
                self.assertEqual(
                    environment["FULLMAG_SP4_RELAX_ALGORITHM"],
                    spec["relaxation_algorithm"],
                )
                self.assertEqual(environment["FULLMAG_SP4_RELAX_MAX_STEPS"], "1")
                self.assertEqual(
                    environment["FULLMAG_SP4_RELAX_TOL_APM"],
                    str(spec["torque_tolerance_apm"]),
                )
                manifest_path = (
                    root
                    / Path(str(spec["artifact_path"])).parent
                    / executor.RUN_MANIFEST
                )
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                self.assertEqual(manifest["status"], "completed_nonqualifying")
                if spec["stage_id"] in {"stage1_layers", "stage2_airbox"}:
                    self.assertEqual(
                        manifest["scientific_scope"]["status"],
                        "execution_only_deferred",
                    )
                    self.assertIs(
                        manifest["scientific_scope"]["convergence_claimed"], False
                    )
                self.assertEqual(manifest["run_spec"], spec)
                self.assertEqual(manifest["environment"], environment)
                self.assertEqual(
                    manifest["execution_identity"], self.execution_identity
                )
                self.assertEqual(
                    manifest["artifact_evidence"]["execution_identity"],
                    self.execution_identity,
                )

            persisted = json.loads(
                (root / executor.SUMMARY_FILENAME).read_text(encoding="utf-8")
            )
            self.assertEqual(persisted, summary)
            self.assertEqual(summary["execution_identity"], self.execution_identity)

    def test_one_step_runtime_smoke_accepts_max_step_completion(self) -> None:
        def launch(
            spec: dict[str, object],
            artifact_dir: Path,
            environment: dict[str, str],
            log_path: Path,
        ) -> int:
            return self._successful_launch(
                spec,
                artifact_dir,
                environment,
                log_path,
                budget_exhausted=True,
            )

        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            summary = executor.execute_matrix(
                durable_root / "matrix",
                durable_root=durable_root,
                max_steps=1,
                evidence_mode="one_step_runtime_smoke",
                launch=launch,
            )

        self.assertEqual(summary["status"], "completed_nonqualifying")

    def test_one_step_runtime_smoke_accepts_genuine_torque_convergence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            summary = executor.execute_matrix(
                durable_root / "matrix",
                durable_root=durable_root,
                max_steps=1,
                evidence_mode=executor.ONE_STEP_RUNTIME_SMOKE,
                launch=self._successful_launch,
            )

        self.assertEqual(summary["status"], "completed_nonqualifying")

    def test_one_step_runtime_smoke_rejects_incomplete_budget_evidence(self) -> None:
        [spec, *_] = executor.collect_execution_cases(self._plans())

        def mutate_wrong_stop_reason(
            qualification: dict[str, object],
        ) -> None:
            qualification["stop_reason"] = "torque"

        def mutate_zero_steps(qualification: dict[str, object]) -> None:
            qualification["executed_steps"] = 0

        def mutate_two_steps(qualification: dict[str, object]) -> None:
            qualification["executed_steps"] = 2

        def mutate_missing_torque(qualification: dict[str, object]) -> None:
            qualification.pop("final_torque_apm")

        def mutate_nonfinite_torque(qualification: dict[str, object]) -> None:
            qualification["final_torque_t"] = float("nan")

        def mutate_budget_metric_kind(qualification: dict[str, object]) -> None:
            qualification["stop_metric_kind"] = "max_torque_apm"

        def mutate_budget_metric_name(qualification: dict[str, object]) -> None:
            qualification["stop_metric_name"] = "max_torque_apm"

        def mutate_budget_metric_unit(qualification: dict[str, object]) -> None:
            qualification["stop_metric_unit"] = "A/m"

        def mutate_budget_metric_value(qualification: dict[str, object]) -> None:
            qualification["stop_metric_value"] = 0.0

        def mutate_budget_metric_threshold(qualification: dict[str, object]) -> None:
            qualification["stop_threshold"] = 2.0

        def mutate_budget_metric_value_below(qualification: dict[str, object]) -> None:
            qualification["stop_metric_value"] = 1.0 - 5.0e-13

        def mutate_budget_metric_value_above(qualification: dict[str, object]) -> None:
            qualification["stop_metric_value"] = 1.0 + 5.0e-13

        def mutate_budget_metric_threshold_below(
            qualification: dict[str, object],
        ) -> None:
            qualification["stop_threshold"] = 1.0 - 5.0e-13

        def mutate_budget_metric_threshold_above(
            qualification: dict[str, object],
        ) -> None:
            qualification["stop_threshold"] = 1.0 + 5.0e-13

        mutations = {
            "wrong_stop_reason": mutate_wrong_stop_reason,
            "zero_steps": mutate_zero_steps,
            "two_steps": mutate_two_steps,
            "missing_torque": mutate_missing_torque,
            "nonfinite_torque": mutate_nonfinite_torque,
            "budget_metric_kind": mutate_budget_metric_kind,
            "budget_metric_name": mutate_budget_metric_name,
            "budget_metric_unit": mutate_budget_metric_unit,
            "budget_metric_value": mutate_budget_metric_value,
            "budget_metric_threshold": mutate_budget_metric_threshold,
            "budget_metric_value_below": mutate_budget_metric_value_below,
            "budget_metric_value_above": mutate_budget_metric_value_above,
            "budget_metric_threshold_below": mutate_budget_metric_threshold_below,
            "budget_metric_threshold_above": mutate_budget_metric_threshold_above,
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                artifact_dir = root / "artifacts"
                log_path = root / executor.RUNTIME_LOG
                self._successful_launch(
                    spec,
                    artifact_dir,
                    {},
                    log_path,
                    budget_exhausted=True,
                )
                metadata_path = artifact_dir / "metadata.json"
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                qualification = metadata[
                    "fem_cpu_relaxation_qualification"
                ]
                self.assertIsInstance(qualification, dict)
                mutate(qualification)
                metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

                with self.assertRaises(executor.ExecutionError):
                    executor._validate_case_artifacts(
                        spec,
                        artifact_dir,
                        log_path,
                        max_steps=1,
                        evidence_mode=executor.ONE_STEP_RUNTIME_SMOKE,
                    )

    def test_one_step_runtime_smoke_rejects_false_convergence_with_torque_stop(self) -> None:
        [spec, *_] = executor.collect_execution_cases(self._plans())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact_dir = root / "artifacts"
            log_path = root / executor.RUNTIME_LOG
            self._successful_launch(
                spec,
                artifact_dir,
                {},
                log_path,
                budget_exhausted=True,
            )
            metadata_path = artifact_dir / "metadata.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            qualification = metadata["fem_cpu_relaxation_qualification"]
            self.assertIsInstance(qualification, dict)
            qualification["stop_reason"] = "torque"
            qualification["stop_metric_kind"] = "max_torque_apm"
            qualification["stop_metric_name"] = "max_torque_apm"
            qualification["stop_metric_unit"] = "A/m"
            qualification["stop_metric_value"] = qualification["final_torque_apm"]
            qualification["stop_threshold"] = spec["torque_tolerance_apm"]
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

            with self.assertRaisesRegex(executor.ExecutionError, "max_steps"):
                executor._validate_case_artifacts(
                    spec,
                    artifact_dir,
                    log_path,
                    max_steps=1,
                    evidence_mode=executor.ONE_STEP_RUNTIME_SMOKE,
                )

    def test_execute_matrix_rejects_invalid_evidence_mode_before_launch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            with self.assertRaisesRegex(executor.ExecutionError, "unsupported"):
                executor.execute_matrix(
                    durable_root / "matrix",
                    durable_root=durable_root,
                    evidence_mode="unknown",
                    launch=self._successful_launch,
                )

    def test_one_step_runtime_smoke_rejects_nonunit_step_budget_before_launch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            with self.assertRaisesRegex(executor.ExecutionError, "max_steps=1"):
                executor.execute_matrix(
                    durable_root / "matrix",
                    durable_root=durable_root,
                    max_steps=2,
                    evidence_mode=executor.ONE_STEP_RUNTIME_SMOKE,
                    launch=self._successful_launch,
                )

    def test_full_matrix_rejects_one_step_max_step_completion(self) -> None:
        def launch(
            spec: dict[str, object],
            artifact_dir: Path,
            environment: dict[str, str],
            log_path: Path,
        ) -> int:
            return self._successful_launch(
                spec,
                artifact_dir,
                environment,
                log_path,
                budget_exhausted=True,
            )

        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            with self.assertRaisesRegex(executor.ExecutionError, "did not converge"):
                executor.execute_matrix(
                    durable_root / "matrix",
                    durable_root=durable_root,
                    max_steps=1,
                    launch=launch,
                )

    def test_stops_when_execution_identity_changes_after_launch(self) -> None:
        launches = 0

        def launch(
            spec: dict[str, object],
            artifact_dir: Path,
            environment: dict[str, str],
            log_path: Path,
        ) -> int:
            nonlocal launches
            launches += 1
            return self._successful_launch(spec, artifact_dir, environment, log_path)

        self.identity_guard.side_effect = [
            None,
            executor.ExecutionError("managed runtime identity changed"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            report_root = durable_root / "matrix"
            with self.assertRaisesRegex(executor.ExecutionError, "identity changed"):
                executor.execute_matrix(
                    report_root,
                    durable_root=durable_root,
                    max_steps=1,
                    launch=launch,
                )

            self.assertEqual(launches, 1)
            summary = json.loads(
                (report_root / executor.SUMMARY_FILENAME).read_text(encoding="utf-8")
            )
            self.assertEqual(summary["status"], "failed")
            self.assertEqual(summary["failed_case"]["failure_kind"], "identity_drift")

    def test_reads_only_schema3_runtime_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            payload = self._runtime_manifest_payload()
            manifest.write_text(json.dumps(payload), encoding="utf-8")

            identity = executor._read_runtime_identity(manifest)

            self.assertEqual(identity["schema"], 3)
            self.assertEqual(identity["build_identity"], payload["build_identity"])
            self.assertEqual(
                identity["authoritative_validator_receipt"],
                self.authoritative_receipt,
            )
            self.assertEqual(
                identity["runtime_manifest_sha256"],
                hashlib.sha256(manifest.read_bytes()).hexdigest(),
            )
            payload["schema"] = 2
            manifest.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(executor.ExecutionError, "schema 3"):
                executor._read_runtime_identity(manifest)

    def test_schema3_runtime_identity_requires_native_build_and_device_subset(self) -> None:
        mutations = (
            ("integrity", lambda payload: payload["integrity"].pop("worker_sha256")),
            ("library", lambda payload: payload["native_libraries"].pop("hypre")),
            ("build", lambda payload: payload["build"].pop("hypre_version")),
            ("device", lambda payload: payload["runtime_diagnostics"].pop("device_name")),
        )
        for label, mutate in mutations:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                manifest = Path(directory) / "manifest.json"
                payload = self._runtime_manifest_payload()
                mutate(payload)
                manifest.write_text(json.dumps(payload), encoding="utf-8")
                with self.assertRaises(executor.ExecutionError):
                    executor._read_runtime_identity(manifest)

    def test_schema3_runtime_rejects_bundle_when_authoritative_validator_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            manifest.write_text(
                json.dumps(self._runtime_manifest_payload()), encoding="utf-8"
            )
            self.authoritative_validator.side_effect = executor.ExecutionError(
                "authoritative managed runtime bundle validation failed: forged loader trace"
            )
            with self.assertRaisesRegex(executor.ExecutionError, "forged loader trace"):
                executor._read_runtime_identity(manifest)

    def test_authoritative_validator_is_bound_to_exact_source_and_device(self) -> None:
        payload = self._runtime_manifest_payload()
        completed = subprocess.CompletedProcess(
            args=(),
            returncode=0,
            stdout=json.dumps(
                {
                    "bundle": "valid",
                    "git_commit": "a" * 40,
                    "worktree_state": "dirty",
                    "source_snapshot_sha256": "b" * 64,
                    "compute_capability": "8.9",
                    "source_identity_compatibility": "exact-schema-3",
                }
            ),
            stderr="",
        )
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            executor.subprocess, "run", return_value=completed
        ) as run:
            manifest = Path(directory) / "manifest.json"
            receipt = ORIGINAL_AUTHORITATIVE_RUNTIME_VALIDATOR(
                manifest, payload["build_identity"], "8.9"
            )
        command = run.call_args.args[0]
        self.assertIn("--require-git-commit", command)
        self.assertIn("--require-worktree-state", command)
        self.assertIn("--require-source-snapshot-sha256", command)
        self.assertIn("--require-compute-capability", command)
        self.assertEqual(receipt["result"]["bundle"], "valid")

    def test_pins_exact_runtime_manifest_bytes_and_source_identities(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            payload = self._runtime_manifest_payload()
            raw_manifest = json.dumps(payload, indent=2).encode("utf-8")
            manifest.write_bytes(raw_manifest)
            plans = [
                {"source_snapshot_sha256": "c" * 64},
                {"source_snapshot_sha256": "c" * 64},
            ]
            report_root = root / "report"

            with self.assertRaisesRegex(
                executor.ExecutionError,
                "runtime source snapshot does not match",
            ):
                ORIGINAL_PIN_EXECUTION_IDENTITY(plans, report_root, manifest)

            self.assertFalse((report_root / executor.PINNED_RUNTIME_MANIFEST).exists())

    def test_pins_authoritative_runtime_validator_receipt(self) -> None:
        plans = self._plans()
        first = plans[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            payload = self._runtime_manifest_payload()
            payload["build_identity"] = {
                "git_commit": first["head_commit_full"],
                "worktree_state": (
                    "dirty" if first["source_snapshot_dirty"] else "clean"
                ),
                "source_snapshot_sha256": first["source_snapshot_sha256"],
            }
            manifest.write_text(json.dumps(payload), encoding="utf-8")
            report_root = root / "report"

            ORIGINAL_PIN_EXECUTION_IDENTITY(plans, report_root, manifest)

            receipt = json.loads(
                (report_root / executor.RUNTIME_VALIDATOR_RECEIPT).read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(receipt, self.authoritative_receipt)

    def test_summary_and_run_manifests_remain_explicitly_nonqualifying(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            report_root = durable_root / "matrix"
            summary = executor.execute_matrix(
                report_root,
                durable_root=durable_root,
                max_steps=1,
                launch=self._successful_launch,
            )

            self.assertIs(summary["qualifying"], False)
            self.assertEqual(
                summary["qualification_claim"], "implemented_evidence_only"
            )
            self.assertEqual(
                summary["deferred_axes"],
                ["stage4-all-tet-comparator", "case-a-dynamics", "case-b-dynamics"],
            )
            emitted_plans = [
                json.loads(
                    (
                        report_root
                        / "plans"
                        / stage
                        / planner.PLAN_FILENAME
                    ).read_text(encoding="utf-8")
                )
                for stage in planner.STAGES
            ]
            [first_case, *_] = executor.collect_execution_cases(emitted_plans)
            manifest = json.loads(
                (
                    report_root
                    / Path(str(first_case["artifact_path"])).parent
                    / executor.RUN_MANIFEST
                ).read_text(encoding="utf-8")
            )
            self.assertIs(manifest["qualifying"], False)
            self.assertEqual(
                manifest["qualification_claim"], "implemented_evidence_only"
            )
            self.assertEqual(manifest["deferred_axes"], summary["deferred_axes"])
            self.assertEqual(
                summary["stage1_layers"]["status"], "execution_only_deferred"
            )
            self.assertEqual(
                summary["stage2_airbox"]["status"], "execution_only_deferred"
            )

    def test_gpu_transfer_budget_is_algorithm_specific(self) -> None:
        for algorithm in ("llg_overdamped", "nonlinear_cg"):
            spec = next(
                case
                for case in executor.collect_execution_cases(self._plans())
                if case["device"] == "gpu"
                and case["relaxation_algorithm"] == algorithm
            )
            with self.subTest(algorithm=algorithm), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                artifacts = root / "artifacts"
                log_path = root / executor.RUNTIME_LOG
                self._successful_launch(spec, artifacts, {}, log_path)
                metadata_path = artifacts / "metadata.json"
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                metadata["execution_provenance"]["hot_loop_host_sync_count"] = 7
                metadata["execution_provenance"]["hot_loop_control_scalar_host_sync_count"] = 7
                metadata["execution_provenance"]["hot_loop_control_scalar_d2h_bytes"] = 56
                qualification = metadata["fem_gpu_relaxation_qualification"]
                qualification["device_policy"]["hot_loop_control_scalar_host_sync_count"] = 7
                metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

                with self.assertRaisesRegex(executor.ExecutionError, "bounded gate budget"):
                    executor._validate_case_artifacts(
                        spec, artifacts, log_path, 1, self.execution_identity
                    )

    def test_gpu_algorithm_counters_reject_impossible_relationships(self) -> None:
        mutations = {
            "llg_overdamped": {"total_rhs_evals": 0, "rejected_attempts": 0},
            "projected_gradient_bb": {"total_rhs_evals": 2, "rejected_attempts": 1},
            "nonlinear_cg": {"total_rhs_evals": 2, "rejected_attempts": 3},
        }
        for algorithm, counters in mutations.items():
            spec = next(
                case
                for case in executor.collect_execution_cases(self._plans())
                if case["device"] == "gpu"
                and case["relaxation_algorithm"] == algorithm
            )
            with self.subTest(algorithm=algorithm), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                artifacts = root / "artifacts"
                log_path = root / executor.RUNTIME_LOG
                self._successful_launch(spec, artifacts, {}, log_path)
                metadata_path = artifacts / "metadata.json"
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                metadata["fem_gpu_relaxation_qualification"].update(counters)
                metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
                with self.assertRaisesRegex(
                    executor.ExecutionError, "algorithm counter contract"
                ):
                    executor._validate_case_artifacts(
                        spec, artifacts, log_path, 1, self.execution_identity
                    )

    def test_gpu_execution_must_match_pinned_device_identity(self) -> None:
        spec = next(
            case for case in executor.collect_execution_cases(self._plans())
            if case["device"] == "gpu"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = root / "artifacts"
            log_path = root / executor.RUNTIME_LOG
            self._successful_launch(spec, artifacts, {}, log_path)
            metadata_path = artifacts / "metadata.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            metadata["execution_provenance"]["device_name"] = "wrong GPU"
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

            with self.assertRaisesRegex(executor.ExecutionError, "device identity"):
                executor._validate_case_artifacts(
                    spec, artifacts, log_path, 1, self.execution_identity
                )

    def test_gpu_case_requires_cuda_hypre_residency_and_bounded_transfers(self) -> None:
        spec = next(
            case
            for case in executor.collect_execution_cases(self._plans())
            if case["device"] == "gpu"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = root / "artifacts"
            log_path = root / executor.RUNTIME_LOG
            self._successful_launch(spec, artifacts, {}, log_path)
            metadata_path = artifacts / "metadata.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            metadata["execution_provenance"].pop("mfem_device")
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

            with self.assertRaisesRegex(
                executor.ExecutionError,
                "GPU execution mfem_device",
            ):
                executor._validate_case_artifacts(
                    spec, artifacts, log_path, max_steps=1,
                    execution_identity=self.execution_identity,
                )

    def test_stage3_cpu_gpu_pair_rejects_topology_identity_drift(self) -> None:
        def launch(
            spec: dict[str, object],
            artifact_dir: Path,
            environment: dict[str, str],
            log_path: Path,
        ) -> int:
            result = self._successful_launch(spec, artifact_dir, environment, log_path)
            if spec["device"] == "gpu":
                metadata_path = artifact_dir / "metadata.json"
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                drifted = "sha256:" + "b" * 64
                metadata["mesh"]["topology_fingerprint"] = drifted
                metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
            return result

        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            with self.assertRaisesRegex(
                executor.ExecutionError,
                "Stage 3 CPU/GPU topology fingerprint mismatch",
            ):
                executor.execute_matrix(
                    durable_root / "matrix",
                    durable_root=durable_root,
                    max_steps=1,
                    launch=launch,
                )

    def test_identity_guard_rejects_runtime_manifest_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            payload = self._runtime_manifest_payload()
            manifest.write_text(json.dumps(payload), encoding="utf-8")
            identity = {
                "schema": 3,
                "runtime_manifest_sha256": hashlib.sha256(
                    manifest.read_bytes()
                ).hexdigest(),
                "runtime": "fem-gpu-host",
                "variant": "hypre-baseline",
                "build_identity": payload["build_identity"],
                "plan_source_snapshot_sha256": "c" * 64,
                "bounded_source_sha256": hashlib.sha256(
                    executor.BOUNDED_SOURCE.read_bytes()
                ).hexdigest(),
            }
            payload["variant"] = "rebuilt-between-cases"
            manifest.write_text(json.dumps(payload), encoding="utf-8")

            with mock.patch.object(
                planner,
                "_source_identity",
                return_value={"source_snapshot_sha256": "c" * 64},
            ), self.assertRaisesRegex(executor.ExecutionError, "identity changed"):
                ORIGINAL_ASSERT_EXECUTION_IDENTITY(
                    identity,
                    plan_root=root / "plans",
                    runtime_manifest=manifest,
                )

    def test_fails_closed_on_failed_case_and_stops_later_cases(self) -> None:
        launches = 0

        def launch(
            spec: dict[str, object],
            artifact_dir: Path,
            environment: dict[str, str],
            log_path: Path,
        ) -> int:
            nonlocal launches
            launches += 1
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_path.write_text("native failure\n", encoding="utf-8")
            return 23

        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            root = durable_root / "matrix"
            with self.assertRaisesRegex(executor.ExecutionError, "exited with status 23"):
                executor.execute_matrix(
                    root,
                    durable_root=durable_root,
                    max_steps=1,
                    launch=launch,
                )

            self.assertEqual(launches, 1)
            summary = json.loads(
                (root / executor.SUMMARY_FILENAME).read_text(encoding="utf-8")
            )
            self.assertEqual(summary["status"], "failed")
            self.assertEqual(summary["executed_case_count"], 1)
            self.assertEqual(summary["completed_case_count"], 0)
            self.assertEqual(summary["failed_case"]["exit_status"], 23)

    def test_fails_closed_when_successful_process_omits_required_artifact(self) -> None:
        def launch(
            spec: dict[str, object],
            artifact_dir: Path,
            environment: dict[str, str],
            log_path: Path,
        ) -> int:
            artifact_dir.mkdir(parents=True)
            log_path.write_text("incomplete output\n", encoding="utf-8")
            return 0

        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            root = durable_root / "matrix"
            with self.assertRaisesRegex(executor.ExecutionError, "missing required artifacts"):
                executor.execute_matrix(
                    root,
                    durable_root=durable_root,
                    max_steps=1,
                    launch=launch,
                )

            summary = json.loads(
                (root / executor.SUMMARY_FILENAME).read_text(encoding="utf-8")
            )
            self.assertEqual(summary["status"], "failed")
            self.assertEqual(summary["executed_case_count"], 1)
            self.assertEqual(
                summary["failed_case"]["missing_artifacts"],
                list(executor.REQUIRED_ARTIFACTS),
            )

    def test_fails_closed_and_records_launcher_exception(self) -> None:
        def launch(
            spec: dict[str, object],
            artifact_dir: Path,
            environment: dict[str, str],
            log_path: Path,
        ) -> int:
            raise OSError("managed launcher unavailable")

        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            root = durable_root / "matrix"
            with self.assertRaisesRegex(
                executor.ExecutionError,
                "managed launcher unavailable",
            ):
                executor.execute_matrix(
                    root,
                    durable_root=durable_root,
                    max_steps=1,
                    launch=launch,
                )

            summary = json.loads(
                (root / executor.SUMMARY_FILENAME).read_text(encoding="utf-8")
            )
            self.assertEqual(summary["status"], "failed")
            self.assertEqual(summary["executed_case_count"], 1)
            self.assertEqual(summary["failed_case"]["failure_kind"], "launcher_error")
            self.assertEqual(summary["completed_case_count"], 0)

    def test_rejects_artifact_identity_that_does_not_match_run_spec(self) -> None:
        def launch(
            spec: dict[str, object],
            artifact_dir: Path,
            environment: dict[str, str],
            log_path: Path,
        ) -> int:
            self._successful_launch(spec, artifact_dir, environment, log_path)
            metadata_path = artifact_dir / "metadata.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            metadata["execution_provenance"]["execution_engine"] = "fem_native_gpu"
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
            return 0

        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            report_root = durable_root / "matrix"
            with self.assertRaisesRegex(executor.ExecutionError, "execution engine"):
                executor.execute_matrix(
                    report_root,
                    durable_root=durable_root,
                    max_steps=1,
                    launch=launch,
                )

            summary = json.loads(
                (report_root / executor.SUMMARY_FILENAME).read_text(encoding="utf-8")
            )
            self.assertEqual(summary["executed_case_count"], 1)
            self.assertEqual(summary["completed_case_count"], 0)

    def test_binds_every_runtime_artifact_to_planned_axes_and_step_budget(self) -> None:
        [spec, *_] = executor.collect_execution_cases(self._plans())

        def mutate_airbox(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["problem_meta"]["runtime_metadata"]["domain_frame"][
                "declared_universe"
            ]["size"][0] *= 2

        def mutate_mesh(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["problem_meta"]["runtime_metadata"]["mesh_workflow"][
                "per_geometry"
            ][0]["maximum_element_size"] *= 2

        def mutate_layers(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ]["realized_layer_count"] = 3

        def mutate_algorithm(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["fem_cpu_relaxation_qualification"][
                "relaxation_algorithm"
            ] = "nonlinear_cg"

        def mutate_fallback(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["execution_provenance"]["lossy_fallback_used"] = True

        def mutate_certificate(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ]["topology_fingerprint"] = "sha256:" + "b" * 64

        def mutate_budget(metadata: dict[str, object], final: dict[str, object]) -> None:
            metadata["fem_cpu_relaxation_qualification"]["executed_steps"] = 2
            final["step"] = 2

        def mutate_source(metadata: dict[str, object], final: dict[str, object]) -> None:
            metadata["source_hash"] = "c" * 64
            final["provenance"]["source_hash"] = "c" * 64

        def mutate_quality(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["mesh"]["mesh_build_report"][
                "mixed_layer_topology_certificate"
            ]["scaled_jacobian_p05_by_family"] = {}

        def mutate_energy(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["fem_cpu_relaxation_qualification"]["final_energy_terms_j"][
                "E_total"
            ] = 0.6

        def mutate_torque(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["fem_cpu_relaxation_qualification"]["final_torque_t"] = 3.0e-6

        def mutate_convergence(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["fem_cpu_relaxation_qualification"]["converged"] = False

        def mutate_stop_threshold(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["fem_cpu_relaxation_qualification"]["stop_threshold"] = 7.957747154594767

        def mutate_negative_torque(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["fem_cpu_relaxation_qualification"]["final_torque_apm"] = -0.5

        def mutate_torque_units(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["fem_cpu_relaxation_qualification"]["final_torque_apm"] = 0.25

        def mutate_stop_provenance(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["fem_cpu_relaxation_qualification"]["stop_metric_unit"] = "T"

        def mutate_stop_value(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["fem_cpu_relaxation_qualification"]["stop_metric_value"] = 0.25

        def mutate_norm(metadata: dict[str, object], _final: dict[str, object]) -> None:
            metadata["fem_cpu_relaxation_qualification"]["norm_defect"] = 1.0e-6

        mutations = {
            "airbox": mutate_airbox,
            "mesh": mutate_mesh,
            "layers": mutate_layers,
            "algorithm": mutate_algorithm,
            "fallback": mutate_fallback,
            "certificate": mutate_certificate,
            "max_steps": mutate_budget,
            "source_hash": mutate_source,
            "quality": mutate_quality,
            "energy": mutate_energy,
            "torque": mutate_torque,
            "convergence": mutate_convergence,
            "stop_threshold": mutate_stop_threshold,
            "negative_torque": mutate_negative_torque,
            "torque_units": mutate_torque_units,
            "stop_provenance": mutate_stop_provenance,
            "stop_value": mutate_stop_value,
            "norm_defect": mutate_norm,
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                artifact_dir = root / "artifacts"
                log_path = root / executor.RUNTIME_LOG
                self._successful_launch(spec, artifact_dir, {}, log_path)
                metadata_path = artifact_dir / "metadata.json"
                final_path = artifact_dir / "m_final.json"
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                final = json.loads(final_path.read_text(encoding="utf-8"))
                mutate(metadata, final)
                metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
                final_path.write_text(json.dumps(final), encoding="utf-8")

                with self.assertRaises(executor.ExecutionError):
                    executor._validate_case_artifacts(
                        spec,
                        artifact_dir,
                        log_path,
                        max_steps=1,
                    )

    def test_rejects_symlink_required_artifact(self) -> None:
        def launch(
            spec: dict[str, object],
            artifact_dir: Path,
            environment: dict[str, str],
            log_path: Path,
        ) -> int:
            self._successful_launch(spec, artifact_dir, environment, log_path)
            metadata_path = artifact_dir / "metadata.json"
            real_metadata = artifact_dir.parent / "external-metadata.json"
            metadata_path.replace(real_metadata)
            metadata_path.symlink_to(real_metadata)
            return 0

        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            with self.assertRaisesRegex(executor.ExecutionError, "regular file"):
                executor.execute_matrix(
                    durable_root / "matrix",
                    durable_root=durable_root,
                    max_steps=1,
                    launch=launch,
                )

    def test_preflights_every_case_before_writing_summary_or_launching(self) -> None:
        launches = 0
        cases = executor.collect_execution_cases(self._plans())
        last_case = cases[-1]
        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            report_root = durable_root / "matrix"
            manifest = (
                report_root
                / Path(str(last_case["artifact_path"])).parent
                / executor.RUN_MANIFEST
            )
            manifest.parent.mkdir(parents=True)
            original = {"schema": executor.RUN_SCHEMA, "status": "passed"}
            manifest.write_text(json.dumps(original), encoding="utf-8")

            def launch(*_args: object) -> int:
                nonlocal launches
                launches += 1
                return 0

            with self.assertRaisesRegex(executor.ExecutionError, "refusing to overwrite"):
                executor.execute_matrix(
                    report_root,
                    durable_root=durable_root,
                    max_steps=1,
                    launch=launch,
                )

            self.assertEqual(launches, 0)
            self.assertFalse((report_root / executor.SUMMARY_FILENAME).exists())
            self.assertEqual(json.loads(manifest.read_text(encoding="utf-8")), original)

    def test_global_lock_rejects_concurrent_matrix_before_summary_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            report_root = durable_root / "matrix"
            lock_path = durable_root / ".matrix.execution.lock"
            descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(executor.ExecutionError, "already in progress"):
                    executor.execute_matrix(
                        report_root,
                        durable_root=durable_root,
                        max_steps=1,
                        launch=self._successful_launch,
                    )
            finally:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)

            self.assertFalse((report_root / executor.SUMMARY_FILENAME).exists())

    def test_justfile_exposes_bounded_smoke_and_full_recipes(self) -> None:
        justfile = (planner.REPO_ROOT / "justfile").read_text(encoding="utf-8")
        recipes = justfile.split("verify-fem-sp4-mixed-matrix-smoke:", 1)[1].split(
            "\nfem-managed-container-headless", 1
        )[0]

        self.assertIn("verify-fem-sp4-mixed-matrix-smoke:", justfile)
        self.assertIn("verify-fem-sp4-mixed-matrix:", justfile)
        self.assertIn("FULLMAG_SP4_MIXED_MATRIX_DURABLE_ROOT", recipes)
        self.assertIn("FULLMAG_SP4_MIXED_MATRIX_REPORT_ROOT", recipes)
        self.assertIn("/mnt/fullmag-zfn2-native", recipes)
        self.assertIn("--durable-root", recipes)
        self.assertIn("--max-steps 1", recipes)
        self.assertIn("--evidence-mode one_step_runtime_smoke", recipes)
        self.assertEqual(recipes.count("create_managed_fem_report_run_root"), 2)
        self.assertIn('echo "mixed SP4 matrix report root: $report_root"', recipes)
        self.assertNotIn(".fullmag/reports", recipes)

    def test_rejects_report_root_outside_durable_root_before_planning(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            durable_root = root / "durable"
            durable_root.mkdir()
            report_root = root / "outside" / "matrix"

            with self.assertRaisesRegex(
                executor.ExecutionError,
                "must be contained by durable root",
            ):
                executor.execute_matrix(
                    report_root,
                    durable_root=durable_root,
                    max_steps=1,
                    launch=self._successful_launch,
                )

            self.assertFalse(report_root.exists())

    def test_rejects_symlink_component_in_report_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory) / "durable"
            durable_root.mkdir()
            real_reports = durable_root / "real-reports"
            real_reports.mkdir()
            alias = durable_root / "reports"
            alias.symlink_to(real_reports, target_is_directory=True)

            with self.assertRaisesRegex(
                executor.ExecutionError,
                "must not contain symlinks",
            ):
                executor.execute_matrix(
                    alias / "matrix",
                    durable_root=durable_root,
                    max_steps=1,
                    launch=self._successful_launch,
                )

            self.assertEqual(list(real_reports.iterdir()), [])

    def test_rejects_symlink_ancestor_of_durable_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real_parent = root / "real"
            real_parent.mkdir()
            alias_parent = root / "alias"
            alias_parent.symlink_to(real_parent, target_is_directory=True)
            durable_root = alias_parent / "durable"
            durable_root.mkdir()

            with self.assertRaisesRegex(executor.ExecutionError, "ancestor.*symlink"):
                executor.execute_matrix(
                    durable_root / "matrix",
                    durable_root=durable_root,
                    max_steps=1,
                    launch=self._successful_launch,
                )

    def test_exact_storage_validator_rejects_unmounted_canonical_view(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mount_view = root / "native-mount"
            durable_root = mount_view / "reports"
            durable_root.mkdir(parents=True)
            expected_image = root / "fullmag-native.ext4"
            completed = (
                subprocess.CompletedProcess([], 0, "", ""),
                subprocess.CompletedProcess([], 0, "/ ext4 /dev/loop7\n", ""),
            )
            with mock.patch.object(
                executor.subprocess, "run", side_effect=completed
            ) as run:
                with self.assertRaisesRegex(
                    executor.ExecutionError,
                    "not the exact mounted ext4 loop filesystem",
                ):
                    ORIGINAL_STORAGE_VALIDATOR(
                        durable_root,
                        mount_view=mount_view,
                        expected_backing_image=expected_image,
                        loop_sysfs_root=root / "sys-block",
                    )

            helper_command = run.call_args_list[0].args[0]
            self.assertIn(str(executor.MANAGED_STORAGE_HELPER), helper_command)
            self.assertIn(str(expected_image), helper_command)

    def test_rejects_broken_symlink_at_case_artifact_before_launch(self) -> None:
        launches = 0

        def launch(
            spec: dict[str, object],
            artifact_dir: Path,
            environment: dict[str, str],
            log_path: Path,
        ) -> int:
            nonlocal launches
            launches += 1
            return self._successful_launch(spec, artifact_dir, environment, log_path)

        [first_case, *_] = executor.collect_execution_cases(self._plans())
        with tempfile.TemporaryDirectory() as directory:
            durable_root = Path(directory)
            report_root = durable_root / "matrix"
            artifact_dir = report_root / str(first_case["artifact_path"])
            artifact_dir.parent.mkdir(parents=True)
            artifact_dir.symlink_to(durable_root / "missing-external-artifacts")

            with self.assertRaisesRegex(
                executor.ExecutionError,
                "must not contain symlinks",
            ):
                executor.execute_matrix(
                    report_root,
                    durable_root=durable_root,
                    max_steps=1,
                    launch=launch,
                )

            self.assertEqual(launches, 0)
            self.assertTrue(artifact_dir.is_symlink())

    def test_direct_cli_is_importable_from_the_repository_root(self) -> None:
        result = subprocess.run(
            [sys.executable, str(executor.__file__), "--help"],
            cwd=planner.REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--report-root", result.stdout)
        self.assertIn("--durable-root", result.stdout)


if __name__ == "__main__":
    unittest.main()
