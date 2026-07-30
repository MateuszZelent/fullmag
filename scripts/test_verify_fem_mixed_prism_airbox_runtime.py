from __future__ import annotations

import ast
import copy
import csv
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest

import scripts.verify_fem_mixed_prism_airbox_runtime as verifier
from scripts.verify_fem_mixed_prism_airbox_runtime import (
    ContractError,
    prepare_bounded_scenario,
)


REPO_ROOT = Path(__file__).resolve().parents[1]


def validate_runtime_artifacts(*args, runtime_manifest: Path, **kwargs):
    return verifier.validate_runtime_artifacts(
        *args,
        runtime_manifest=runtime_manifest,
        source_snapshot=runtime_manifest.parent / "source-snapshot.v2.json",
        **kwargs,
    )


class MixedPrismAirboxRuntimeVerifierTest(unittest.TestCase):
    @staticmethod
    def _source_snapshot_payload() -> dict[str, object]:
        dirty_content = [{
            "path": "fixture",
            "kind": "regular_file",
            "mode": "100644",
            "sha256": "9" * 64,
            "git_index_entries": [],
        }]
        core = {
            "schema": "fullmag.source-snapshot.v2",
            "head_commit_full": "a" * 40,
            "head_tree_sha256": "8" * 64,
            "git_status_porcelain_v1": [{"status": "??", "paths": ["fixture"]}],
            "dirty_path_content": dirty_content,
        }
        def canonical(value: object) -> bytes:
            return (
                json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
                + "\n"
            ).encode("utf-8")
        return {
            **core,
            "source_snapshot_dirty": True,
            "dirty_content_sha256": hashlib.sha256(canonical(dirty_content)).hexdigest(),
            "source_snapshot_sha256": hashlib.sha256(canonical(core)).hexdigest(),
        }

    def test_canonical_scenario_requests_exact_step0_operator_fields(self) -> None:
        scenario = (
            REPO_ROOT
            / "tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py"
        )
        tree = ast.parse(scenario.read_text(encoding="utf-8"))
        calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "FieldAutosave"
        ]

        self.assertEqual(len(calls), 3)
        observed = {}
        for call in calls:
            self.assertEqual(len(call.args), 1)
            self.assertIsInstance(call.args[0], ast.Constant)
            cadence = next(
                keyword.value
                for keyword in call.keywords
                if keyword.arg == "every_steps"
            )
            self.assertIsInstance(cadence, ast.Constant)
            observed[call.args[0].value] = cadence.value
        self.assertEqual(
            observed,
            {"H_ex": 50_000, "H_demag": 50_000, "H_eff": 50_000},
        )

    def test_active_native_direct_minimizer_records_step0_scalars_before_solver(self) -> None:
        source = (REPO_ROOT / "crates/fullmag-runner/src/dispatch.rs").read_text(
            encoding="utf-8"
        )
        execute_start = source.index("fn execute_native_fem(")
        branch = source.index(
            "if let Some(native_step_control) = native_relaxation_step", execute_start
        )
        before_solver = source[execute_start:branch]

        self.assertIn("native_relaxation_step.is_some()", before_solver)
        self.assertIn("current_stats.step == 0", before_solver)
        self.assertIn("artifacts.record_scalar(&current_stats)?;", before_solver)

    def test_prepare_replaces_exactly_one_step_limit_without_mutating_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "scenario.py"
            output = root / "bounded.py"
            original = "study.stages.add_relax(\n    max_steps=50_000,\n)\n"
            source.write_text(original, encoding="utf-8")

            evidence = prepare_bounded_scenario(source, output)

            self.assertEqual(source.read_text(encoding="utf-8"), original)
            self.assertEqual(
                output.read_text(encoding="utf-8"),
                original.replace("max_steps=50_000", "max_steps=1"),
            )
            self.assertEqual(evidence["replacement_count"], 1)
            self.assertEqual(evidence["bounded_max_steps"], 1)

    def test_prepare_fails_closed_for_zero_or_multiple_canonical_limits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, source_text in (
                ("zero", "max_steps=32\n"),
                ("multiple", "max_steps=50_000\nmax_steps=50_000\n"),
            ):
                source = root / f"{name}.py"
                output = root / f"{name}.bounded.py"
                source.write_text(source_text, encoding="utf-8")
                with self.subTest(name=name), self.assertRaisesRegex(
                    ContractError, "exactly one"
                ):
                    prepare_bounded_scenario(source, output)
                self.assertFalse(output.exists())

    def test_prepare_exact_sp4_source_changes_only_the_authored_step_limit(self) -> None:
        source = (
            REPO_ROOT
            / "tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py"
        )
        with tempfile.TemporaryDirectory() as directory:
            bounded = Path(directory) / "bounded.py"

            evidence = prepare_bounded_scenario(source, bounded)

            expected = source.read_text(encoding="utf-8").replace(
                "max_steps=50_000", "max_steps=1", 1
            )
            self.assertEqual(bounded.read_text(encoding="utf-8"), expected)
            self.assertEqual(evidence["replacement_count"], 1)
            self.assertEqual(
                evidence["canonical_source_sha256"],
                hashlib.sha256(source.read_bytes()).hexdigest(),
            )

    def _write_runtime_manifest(self, root: Path) -> Path:
        runtime_root = root / "fem-gpu-variants" / ("hypre-baseline-" + "f" * 64)
        runtime_root.mkdir(parents=True)
        snapshot = self._source_snapshot_payload()
        library = {
            "path": "lib/library.so",
            "sha256": "4" * 64,
            "soname": "library.so",
            "loaded_soname": "library.so",
            "cuda_required": True,
            "cubins": ["sm_89"],
            "ptx": [],
        }
        manifest = {
            "schema": 3,
            "runtime": "fem-gpu-host",
            "variant": "hypre-baseline",
            "created_at": "2026-07-29T12:00:00+00:00",
            "docker_image_id": "sha256:" + "d" * 64,
            "source_manifest_sha256": "e" * 64,
            "build_identity": {
                "git_commit": "a" * 40,
                "worktree_state": "dirty",
                "source_snapshot_sha256": snapshot["source_snapshot_sha256"],
            },
            "integrity": {
                "launcher_sha256": "1" * 64,
                "worker_sha256": "2" * 64,
                "api_sha256": "3" * 64,
            },
            "native_libraries": {
                name: {
                    **library,
                    "path": f"lib/{name}.so",
                    "soname": f"{name}.so",
                    "loaded_soname": f"{name}.so",
                }
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
        path = runtime_root / "manifest.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        (runtime_root / "source-snapshot.v2.json").write_text(
            json.dumps(snapshot), encoding="utf-8"
        )
        return path

    def _write_step0_operator_fields(
        self,
        artifacts: Path,
        *,
        device: str,
        source_hash: str,
        engine: str,
        node_count: int,
    ) -> None:
        air_value = 900.0 if device == "cpu" else -900.0
        fields = {
            "H_ex": [
                1.0,
                2.0,
                air_value,
                3.0,
                4.0,
                air_value,
                5.0,
                6.0,
                air_value,
            ],
            "H_demag": [
                -0.5,
                -1.0,
                air_value,
                -1.5,
                -2.0,
                air_value,
                -2.5,
                -3.0,
                air_value,
            ],
            "H_eff": [
                0.5,
                1.0,
                air_value,
                1.5,
                2.0,
                air_value,
                2.5,
                3.0,
                air_value,
            ],
        }
        for observable, step0_values in fields.items():
            store = artifacts / "fields" / f"{observable}.zarr"
            store.mkdir(parents=True)
            (store / ".zattrs").write_text(
                json.dumps(
                    {
                        "observable": observable,
                        "unit": "A/m",
                        "axes": ["sample", "component", "cell"],
                        "component_order": ["x", "y", "z"],
                        "storage_layout": "soa_component_major",
                        "sample_index_file": "samples.csv",
                        "layout": {},
                        "provenance": {
                            "problem_name": verifier.EXPECTED_PROBLEM_NAME,
                            "ir_version": "1",
                            "source_hash": source_hash,
                            "execution_mode": "strict",
                            "execution_engine": engine,
                            "precision": "double",
                        },
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )
            (store / ".zarray").write_text(
                json.dumps(
                    {
                        "zarr_format": 2,
                        "shape": [2, 3, node_count],
                        "chunks": [1, 3, node_count],
                        "dtype": "<f8",
                        "compressor": None,
                        "fill_value": 0.0,
                        "order": "C",
                        "filters": None,
                        "dimension_separator": ".",
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )
            (store / "samples.csv").write_text(
                "sample,step,time,solver_dt,chunk_key,dtype,scalar_bytes,cell_count\n"
                f"0,0,0.000000000000000e+00,0.000000000000000e+00,0.0.0,<f8,8,{node_count}\n"
                f"1,1,0.000000000000000e+00,0.000000000000000e+00,1.0.0,<f8,8,{node_count}\n",
                encoding="utf-8",
            )
            payload = struct.pack(f"<{len(step0_values)}d", *step0_values)
            (store / "0.0.0").write_bytes(payload)
            (store / "1.0.0").write_bytes(payload)

    def _write_valid_bundle(
        self, root: Path, device: str
    ) -> tuple[Path, Path, Path, Path, Path, dict[str, object]]:
        source = root / "scenario.py"
        bounded = root / "bounded.py"
        artifacts = root / f"{device}-artifacts"
        artifacts.mkdir()
        source.write_text("max_steps=50_000\n", encoding="utf-8")
        bounded_text = "max_steps=1\n"
        bounded.write_text(bounded_text, encoding="utf-8")
        topology_fingerprint = "sha256:" + "a" * 64
        certificate_fingerprint = "sha256:" + "c" * 64
        certificate = {
            "schema_version": "mixed_layer_topology_certificate.v1",
            "certificate_status": "accepted",
            "topology_fingerprint_version": "v3",
            "topology_fingerprint": certificate_fingerprint,
            "requested_layer_count": 1,
            "realized_layer_count": 1,
            "magnetic_plane_coordinates_m": [-1.5e-9, 1.5e-9],
            "cell_family_counts_by_part": {
                "magnetic": {"prism6": 2},
                "transition_air": {"pyramid5": 4, "tet4": 4},
                "far_air": {"tet4": 8},
            },
            "marker_coverage_complete": True,
            "nonconforming_face_count": 0,
            "orphan_face_count": 0,
            "nonmanifold_face_count": 0,
            "coincident_interface_face_count": 0,
            "fallbacks_triggered": [],
        }
        report = {
            "build_mode": "shared_domain",
            "fallbacks_triggered": [],
            "degraded": False,
            "mixed_layer_topology_certificate": certificate,
            "mixed_topology_provenance": {
                "requested_topology": "mixed_p1",
                "resolved_topology": "mixed_p1",
                "accepted_certificate_fingerprint": certificate_fingerprint,
                "requested_device": device,
                "precision": "double",
                "capability_status": "implemented",
            },
        }
        energy_terms = {
            "E_ex": 1.2345678901234567,
            "E_demag": 2.345678901234567,
            "E_ext": 0.0,
            "e_drive": 0.0,
            "E_ani": 0.0,
            "E_dmi": 0.0,
            "E_total": 3.5802467913580237,
        }
        final_torque_t = 5.123456789012345e-6
        engine = "fem_cpu_native" if device == "cpu" else "fem_native_gpu"
        execution_provenance: dict[str, object] = {
            "execution_engine": engine,
            "precision": "double",
            "lossy_fallback_used": False,
            "ignored_terms": [],
        }
        metadata: dict[str, object] = {
            "problem_name": "mumag_sp4_fem_relax_projected_gradient_bb",
            "source_hash": hashlib.sha256(bounded_text.encode()).hexdigest(),
            "status": "completed",
            "problem_meta": {
                "runtime_metadata": {
                    "runtime_selection": {"device": "auto"},
                    "model_builder": {"problem": {"runtime": {"device": "auto"}}},
                    "runtime_device_override": {
                        "device": device,
                        "source": "managed_launcher",
                    },
                }
            },
            "requested_execution": {
                "backend": "fem",
                "device": device,
                "precision": "double",
                "mode": "strict",
                "fallback_policy": "forbidden",
            },
            "execution_provenance": execution_provenance,
            "execution_plan": {
                "backend_plan": {
                    "mesh_parts": [
                        {
                            "role": "magnetic_object",
                            "node_indices": [0],
                            "node_selector": {
                                "kind": "node_range",
                                "start": 2,
                                "count": 1,
                            },
                        },
                        {
                            "role": "magnetic_object",
                            "node_selector": {
                                "kind": "node_range",
                                "start": 1,
                                "count": 1,
                            },
                        },
                        {
                            "role": "air",
                            "node_indices": [2],
                            "node_selector": {
                                "kind": "node_range",
                                "start": 2,
                                "count": 1,
                            },
                        },
                    ]
                }
            },
            "mesh": {
                "topology_fingerprint": topology_fingerprint,
                "node_count": 3,
                "mesh_build_report": report,
            },
        }
        qualification = {
            "schema_version": f"fem_{device}_relaxation_qualification.v1",
            "relaxation_algorithm": "projected_gradient_bb",
            "algorithm_policy": {
                "realization": (
                    "native_mfem_pgbb" if device == "cpu" else "native_cuda_pgbb"
                ),
                "metric": "mu0_ms_fem_lumped_volume",
                **(
                    {"preconditioner": "exchange_plus_mass_tangent_gradient"}
                    if device == "cpu"
                    else {"gradient_policy": "device_tangent_gradient"}
                ),
            },
            "executed_steps": 1,
            "final_energy_terms_j": energy_terms,
            "final_torque_apm": 4.0,
            "final_torque_t": final_torque_t,
            "norm_defect": 0.0,
        }
        if device == "cpu":
            execution_provenance.update(
                {
                    "mfem_device": "cpu",
                    "fem_execution_mode": "cpu_native",
                    "fem_data_residency": "host_source_of_truth",
                    "uses_cuda_kernels": False,
                    "uses_gpu_poisson": False,
                }
            )
            metadata["fem_cpu_relaxation_qualification"] = qualification
        else:
            execution_provenance.update(
                {
                    "device_name": "NVIDIA GeForce RTX 4080",
                    "compute_capability": "8.9",
                    "mfem_version": "4.9",
                    "mfem_device": "cuda",
                    "fem_assembly_mode": "legacy_sparse",
                    "fem_execution_mode": "all_in_gpu_legacy_sparse",
                    "fem_data_residency": "device_source_of_truth",
                    "fem_exchange_operator_mode": "legacy_sparse_gpu",
                    "uses_cuda_kernels": True,
                    "uses_gpu_poisson": True,
                    "fem_demag_operator_mode": "device_hypre_poisson",
                    "hypre_execution_policy": "device",
                    "demag_residency": "device",
                    "fem_gpu_state_allocated": True,
                    "hot_loop_host_sync_count": 7,
                    "hot_loop_exchange_h2d_bytes": 0,
                    "hot_loop_exchange_d2h_bytes": 0,
                    "hot_loop_exchange_host_sync_count": 0,
                    "hot_loop_compute_h2d_bytes": 0,
                    "hot_loop_compute_d2h_bytes": 0,
                    "hot_loop_compute_host_sync_count": 0,
                    "hot_loop_control_scalar_d2h_bytes": 56,
                    "hot_loop_control_scalar_host_sync_count": 7,
                }
            )
            metadata["demag_runtime"] = {
                "mfem_device": "cuda",
                "actual_iterations": 12,
                "final_residual_norm": 1.0e-13,
                "relative_tolerance": 1.0e-12,
                "hypre_version": "3.1.0",
                "runtime_solver": "HyprePCG",
                "runtime_preconditioner": "HypreBoomerAMG",
            }
            qualification["device_policy"] = {
                "execution_mode": "all_in_gpu_legacy_sparse",
                "data_residency": "device_source_of_truth",
                "exchange_operator_mode": "legacy_sparse_gpu",
                "demag_operator_mode": "device_hypre_poisson",
                "uses_cuda_kernels": True,
                "uses_gpu_poisson": True,
                "hot_loop_exchange_host_sync_count": 0,
                "hot_loop_compute_host_sync_count": 0,
                "hot_loop_control_scalar_host_sync_count": 7,
            }
            metadata["fem_gpu_relaxation_qualification"] = qualification
        (artifacts / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
        with (artifacts / "scalars.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(
                stream,
                fieldnames=[
                    "step",
                    "time",
                    "solver_dt",
                    "E_ex",
                    "E_demag",
                    "E_ext",
                    "E_ani",
                    "E_dmi",
                    "E_total",
                    "max_torque_Apm",
                    "max_torque_T",
                ],
            )
            writer.writeheader()
            writer.writerow(
                {
                    "step": 0,
                    "time": "0.000000000000000e+00",
                    "solver_dt": "0.000000000000000e+00",
                    "E_ex": "1.000000000000000e+00",
                    "E_demag": "2.000000000000000e+00",
                    "E_ext": "0.000000000000000e+00",
                    "E_ani": "0.000000000000000e+00",
                    "E_dmi": "0.000000000000000e+00",
                    "E_total": "3.000000000000000e+00",
                    "max_torque_Apm": "7.000000000000000e+00",
                    "max_torque_T": "8.796459430051421e-06",
                }
            )
            writer.writerow(
                {
                    "step": 1,
                    "time": "0.000000000000000e+00",
                    "solver_dt": "0.000000000000000e+00",
                    "E_ex": format(energy_terms["E_ex"], ".15e"),
                    "E_demag": format(energy_terms["E_demag"], ".15e"),
                    "E_ext": "0.000000000000000e+00",
                    "E_ani": "0.000000000000000e+00",
                    "E_dmi": "0.000000000000000e+00",
                    "E_total": format(energy_terms["E_total"], ".15e"),
                    "max_torque_Apm": "4.000000000000000e+00",
                    "max_torque_T": format(final_torque_t, ".15e"),
                }
            )
        with (artifacts / "solver_steps.csv").open(
            "w", newline="", encoding="utf-8"
        ) as stream:
            writer = csv.DictWriter(
                stream,
                fieldnames=[
                    "step",
                    "rhs_evals",
                    "rejected_attempts",
                    "demag_solves",
                    "demag_iterations",
                    "demag_residual",
                    "accepted_energy_proof_available",
                    "accepted_energy_delta_j",
                    "accepted_energy_roundoff_bound_j",
                    "accepted_energy_delta_upper_j",
                    "armijo_increment_rhs_j",
                ],
            )
            writer.writeheader()
            writer.writerow(
                {
                    "step": 1,
                    "rhs_evals": 2,
                    "rejected_attempts": 0,
                    "demag_solves": 1,
                    "demag_iterations": 12,
                    "demag_residual": 1.0e-13,
                    "accepted_energy_proof_available": "true",
                    "accepted_energy_delta_j": -2.0e-3,
                    "accepted_energy_roundoff_bound_j": 1.0e-12,
                    "accepted_energy_delta_upper_j": -1.999999999e-3,
                    "armijo_increment_rhs_j": -1.0e-6,
                }
            )
        initial_values = [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0],
        ]
        (artifacts / "m_initial.json").write_text(
            json.dumps(
                {
                    "observable": "m",
                    "unit": "dimensionless",
                    "step": 0,
                    "time": 0.0,
                    "solver_dt": 0.0,
                    "provenance": {
                        "source_hash": hashlib.sha256(bounded_text.encode()).hexdigest(),
                        "execution_engine": engine,
                        "precision": "double",
                    },
                    "values": initial_values,
                }
            ),
            encoding="utf-8",
        )
        (artifacts / "m_final.json").write_text(
            json.dumps(
                {
                    "observable": "m",
                    "unit": "dimensionless",
                    "step": 1,
                    "time": 0.0,
                    "solver_dt": 0.0,
                    "provenance": {
                        "source_hash": hashlib.sha256(bounded_text.encode()).hexdigest(),
                        "execution_engine": engine,
                        "precision": "double",
                    },
                    "values": [
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 0.0],
                    ],
                }
            ),
            encoding="utf-8",
        )
        self._write_step0_operator_fields(
            artifacts,
            device=device,
            source_hash=hashlib.sha256(bounded_text.encode()).hexdigest(),
            engine=engine,
            node_count=3,
        )
        runtime_log = root / f"{device}.log"
        runtime_log.write_text(
            f"resolved_engine_id={engine} fallback=None\n", encoding="utf-8"
        )
        runtime_manifest = root / "fem-gpu-variants" / ("hypre-baseline-" + "f" * 64) / "manifest.json"
        if not runtime_manifest.exists():
            runtime_manifest = self._write_runtime_manifest(root)
        return source, bounded, artifacts, runtime_log, runtime_manifest, metadata

    def test_validate_and_compare_accept_exact_cpu_gpu_evidence(self) -> None:
        self.assertTrue(hasattr(verifier, "compare_runtime_summaries"))
        self.assertTrue(hasattr(verifier, "write_comparison_csv"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cpu = self._write_valid_bundle(root, "cpu")
            gpu = self._write_valid_bundle(root, "gpu")

            cpu_summary = validate_runtime_artifacts(
                cpu[0], cpu[1], cpu[2], device="cpu", runtime_log=cpu[3], runtime_manifest=cpu[4]
            )
            gpu_summary = validate_runtime_artifacts(
                gpu[0], gpu[1], gpu[2], device="gpu", runtime_log=gpu[3], runtime_manifest=gpu[4]
            )
            comparison = verifier.compare_runtime_summaries(
                cpu_summary,
                gpu_summary,
                cpu_artifacts=cpu[2],
                gpu_artifacts=gpu[2],
            )
            csv_path = root / "comparison.v3.csv"
            verifier.write_comparison_csv(csv_path, comparison)

            self.assertEqual(cpu_summary["execution_engine"], "fem_cpu_native")
            self.assertEqual(gpu_summary["execution_engine"], "fem_native_gpu")
            self.assertEqual(cpu_summary["runtime_git_commit"], "a" * 40)
            self.assertEqual(
                cpu_summary["runtime_source_snapshot_sha256"],
                self._source_snapshot_payload()["source_snapshot_sha256"],
            )
            self.assertEqual(
                cpu_summary["runtime_source_identity_compatibility"],
                "exact-schema-3",
            )
            self.assertEqual(
                comparison["runtime_source_snapshot_sha256"],
                self._source_snapshot_payload()["source_snapshot_sha256"],
            )
            self.assertNotEqual(
                cpu_summary["topology_fingerprint"],
                cpu_summary["certificate_fingerprint"],
                "global/periodic v6 and mixed-certificate v3 identities are distinct",
            )
            self.assertEqual(gpu_summary["gpu_transfer_telemetry"]["control_scalar_host_sync_count"], 7)  # type: ignore[index]
            self.assertEqual(
                cpu_summary["schema_version"],
                "fem_mixed_prism_airbox_runtime_run.v4",
            )
            self.assertEqual(
                comparison["schema_version"], "fem_mixed_prism_airbox_cpu_gpu.v3"
            )
            self.assertEqual(comparison["status"], "pass")
            self.assertEqual(
                comparison["same_state_operator_parity"]["status"],  # type: ignore[index]
                "pass",
            )
            self.assertTrue(
                comparison["same_state_operator_parity"][  # type: ignore[index]
                    "operator_parity_claimed"
                ]
            )
            self.assertFalse(
                comparison["same_state_operator_parity"][  # type: ignore[index]
                    "capability_promotion_claimed"
                ]
            )
            self.assertEqual(
                comparison["initial_state_identity"]["max_component_abs_delta"],  # type: ignore[index]
                0.0,
            )
            self.assertEqual(comparison["qualification_status"], "implemented")
            with csv_path.open(newline="", encoding="utf-8") as stream:
                comparison_rows = {
                    row["quantity"]: row for row in csv.DictReader(stream)
                }
            expected_units = {
                "initial_m_max_component_abs_delta": "1",
                "initial_m_rms_component_abs_delta": "1",
                "step0_H_ex_max_component_abs_delta": "A/m",
                "step0_H_ex_rms_component_abs_delta": "A/m",
                "step0_H_demag_max_component_abs_delta": "A/m",
                "step0_H_demag_rms_component_abs_delta": "A/m",
                "step0_H_eff_max_component_abs_delta": "A/m",
                "step0_H_eff_rms_component_abs_delta": "A/m",
                "step0_E_ex": "J",
                "step0_E_demag": "J",
                "step0_E_total": "J",
                "step0_max_torque_Apm": "A/m",
                "step0_max_torque_T": "T",
                "cpu_accepted_energy_delta_upper": "J",
                "cpu_accepted_armijo_rhs": "J",
                "gpu_accepted_energy_delta_upper": "J",
                "gpu_accepted_armijo_rhs": "J",
            }
            self.assertEqual(set(comparison_rows), set(expected_units))
            for quantity, unit in expected_units.items():
                with self.subTest(quantity=quantity):
                    self.assertEqual(comparison_rows[quantity]["unit"], unit)
                    self.assertEqual(comparison_rows[quantity]["status"], "pass")
            self.assertEqual(verifier.SCALAR_CSV_SERIALIZATION_RTOL, 1.0e-15)
            self.assertNotEqual(
                cpu_summary["final_scalar_values"]["E_ex"],  # type: ignore[index]
                cpu_summary["final_energy_terms_j"]["E_ex"],  # type: ignore[index]
            )

    def test_schema_2_runtime_is_legacy_unbound_and_cannot_qualify(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = self._write_valid_bundle(root, "cpu")
            manifest_path = bundle[4]
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["schema"] = 2
            manifest.pop("build_identity")
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaisesRegex(
                ContractError,
                "schema 2 is legacy/unbound and cannot qualify",
            ):
                validate_runtime_artifacts(
                    bundle[0],
                    bundle[1],
                    bundle[2],
                    device="cpu",
                    runtime_log=bundle[3],
                    runtime_manifest=manifest_path,
                )

    def test_schema_3_runtime_requires_exact_source_identity(self) -> None:
        for field, value in (
            ("git_commit", "a" * 8),
            ("worktree_state", "unknown"),
            ("source_snapshot_sha256", "b" * 8),
        ):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                bundle = self._write_valid_bundle(root, "cpu")
                manifest_path = bundle[4]
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                manifest["build_identity"][field] = value
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

                with self.assertRaisesRegex(ContractError, "runtime build_identity"):
                    validate_runtime_artifacts(
                        bundle[0],
                        bundle[1],
                        bundle[2],
                        device="cpu",
                        runtime_log=bundle[3],
                        runtime_manifest=manifest_path,
                    )

    def test_schema_3_runtime_requires_full_native_identity(self) -> None:
        mutations = (
            ("integrity", lambda manifest: manifest["integrity"].pop("worker_sha256")),
            ("native_library", lambda manifest: manifest["native_libraries"].pop("hypre")),
            ("build", lambda manifest: manifest["build"].pop("hypre_version")),
            ("device", lambda manifest: manifest["runtime_diagnostics"].pop("device_name")),
        )
        for label, mutate in mutations:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                bundle = self._write_valid_bundle(root, "cpu")
                manifest_path = bundle[4]
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                mutate(manifest)
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                with self.assertRaises(ContractError):
                    validate_runtime_artifacts(
                        bundle[0], bundle[1], bundle[2], device="cpu",
                        runtime_log=bundle[3], runtime_manifest=manifest_path,
                    )

    def test_schema_3_runtime_requires_soname_key_but_allows_absent_dt_soname(self) -> None:
        mutations = (
            ("absent_dt_soname", lambda entry: entry.__setitem__("soname", None), True),
            ("missing_soname", lambda entry: entry.pop("soname"), False),
            ("empty_soname", lambda entry: entry.__setitem__("soname", ""), False),
            ("numeric_soname", lambda entry: entry.__setitem__("soname", 1), False),
        )
        for label, mutate, accepted in mutations:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                bundle = self._write_valid_bundle(root, "cpu")
                manifest_path = bundle[4]
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                entry = manifest["native_libraries"]["libceed"]
                self.assertIsInstance(entry, dict)
                mutate(entry)
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

                if accepted:
                    validate_runtime_artifacts(
                        bundle[0], bundle[1], bundle[2], device="cpu",
                        runtime_log=bundle[3], runtime_manifest=manifest_path,
                    )
                else:
                    with self.assertRaisesRegex(
                        ContractError, "runtime native library libceed.soname must be present"
                    ):
                        validate_runtime_artifacts(
                            bundle[0], bundle[1], bundle[2], device="cpu",
                            runtime_log=bundle[3], runtime_manifest=manifest_path,
                        )

    def test_source_snapshot_recomputes_all_canonical_digests(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = self._write_valid_bundle(root, "cpu")
            snapshot_path = bundle[4].parent / "source-snapshot.v2.json"
            snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
            snapshot["dirty_path_content"][0]["sha256"] = "7" * 64
            snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
            with self.assertRaisesRegex(ContractError, "dirty content digest"):
                validate_runtime_artifacts(
                    bundle[0], bundle[1], bundle[2], device="cpu",
                    runtime_log=bundle[3], runtime_manifest=bundle[4],
                )

    def test_validate_rejects_runtime_built_from_a_different_source_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = self._write_valid_bundle(root, "cpu")
            snapshot_path = root / "source-snapshot.v2.json"
            snapshot = self._source_snapshot_payload()
            snapshot["head_tree_sha256"] = "c" * 64
            core = {
                key: snapshot[key]
                for key in (
                    "schema",
                    "head_commit_full",
                    "head_tree_sha256",
                    "git_status_porcelain_v1",
                    "dirty_path_content",
                )
            }
            snapshot["source_snapshot_sha256"] = hashlib.sha256(
                (
                    json.dumps(
                        core,
                        ensure_ascii=False,
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                    + "\n"
                ).encode("utf-8")
            ).hexdigest()
            snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")

            with self.assertRaisesRegex(
                ContractError,
                "runtime source snapshot does not match",
            ):
                verifier.validate_runtime_artifacts(
                    bundle[0],
                    bundle[1],
                    bundle[2],
                    device="cpu",
                    runtime_log=bundle[3],
                    runtime_manifest=bundle[4],
                    source_snapshot=snapshot_path,
                )

    def test_validate_rejects_missing_tampered_or_unbound_step0_artifacts(self) -> None:
        cases = ("missing_field", "tampered_chunk", "wrong_engine", "wrong_samples", "missing_step0")
        for case in cases:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, bounded, artifacts, runtime_log, manifest, _ = (
                    self._write_valid_bundle(root, "cpu")
                )
                if case == "missing_field":
                    (artifacts / "fields/H_ex.zarr/.zattrs").unlink()
                elif case == "tampered_chunk":
                    chunk = artifacts / "fields/H_demag.zarr/0.0.0"
                    chunk.write_bytes(chunk.read_bytes() + b"tamper")
                elif case == "wrong_engine":
                    attrs_path = artifacts / "fields/H_eff.zarr/.zattrs"
                    attrs = json.loads(attrs_path.read_text(encoding="utf-8"))
                    attrs["provenance"]["execution_engine"] = "fem_native_gpu"
                    attrs_path.write_text(json.dumps(attrs), encoding="utf-8")
                elif case == "wrong_samples":
                    samples = artifacts / "fields/H_ex.zarr/samples.csv"
                    rows = samples.read_text(encoding="utf-8").splitlines()
                    samples.write_text("\n".join([rows[0], rows[2], rows[1]]) + "\n", encoding="utf-8")
                else:
                    scalar_rows = (artifacts / "scalars.csv").read_text(
                        encoding="utf-8"
                    ).splitlines()
                    (artifacts / "scalars.csv").write_text(
                        "\n".join([scalar_rows[0], scalar_rows[2]]) + "\n",
                        encoding="utf-8",
                    )

                with self.subTest(case=case), self.assertRaises(ContractError):
                    validate_runtime_artifacts(
                        source,
                        bounded,
                        artifacts,
                        device="cpu",
                        runtime_log=runtime_log,
                        runtime_manifest=manifest,
                    )

    def test_compare_rejects_step0_field_energy_and_torque_outside_frozen_tolerances(self) -> None:
        mutations = ("H_ex", "energy", "torque")
        for mutation in mutations:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                cpu = self._write_valid_bundle(root, "cpu")
                gpu = self._write_valid_bundle(root, "gpu")
                if mutation == "H_ex":
                    chunk = gpu[2] / "fields/H_ex.zarr/0.0.0"
                    values = list(struct.unpack("<9d", chunk.read_bytes()))
                    values[0] += 1.0
                    chunk.write_bytes(struct.pack("<9d", *values))
                else:
                    scalar_path = gpu[2] / "scalars.csv"
                    with scalar_path.open(newline="", encoding="utf-8") as stream:
                        rows = list(csv.DictReader(stream))
                        fieldnames = list(rows[0])
                    if mutation == "energy":
                        rows[0]["E_ex"] = "2.0"
                    else:
                        rows[0]["max_torque_Apm"] = "8.0"
                    with scalar_path.open("w", newline="", encoding="utf-8") as stream:
                        writer = csv.DictWriter(stream, fieldnames=fieldnames)
                        writer.writeheader()
                        writer.writerows(rows)

                cpu_summary = validate_runtime_artifacts(
                    cpu[0], cpu[1], cpu[2], device="cpu", runtime_log=cpu[3], runtime_manifest=cpu[4]
                )
                gpu_summary = validate_runtime_artifacts(
                    gpu[0], gpu[1], gpu[2], device="gpu", runtime_log=gpu[3], runtime_manifest=gpu[4]
                )
                with self.subTest(mutation=mutation), self.assertRaises(ContractError):
                    verifier.compare_runtime_summaries(
                        cpu_summary,
                        gpu_summary,
                        cpu_artifacts=cpu[2],
                        gpu_artifacts=gpu[2],
                    )

    def test_compare_rejects_step0_summary_scalars_not_bound_to_raw_csv(self) -> None:
        mutations = ("energy", "torque")
        for mutation in mutations:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                cpu = self._write_valid_bundle(root, "cpu")
                gpu = self._write_valid_bundle(root, "gpu")
                cpu_summary = validate_runtime_artifacts(
                    cpu[0], cpu[1], cpu[2], device="cpu", runtime_log=cpu[3], runtime_manifest=cpu[4]
                )
                gpu_summary = validate_runtime_artifacts(
                    gpu[0], gpu[1], gpu[2], device="gpu", runtime_log=gpu[3], runtime_manifest=gpu[4]
                )
                for summary in (cpu_summary, gpu_summary):
                    step0 = summary["step0_operator_artifacts"]
                    if mutation == "energy":
                        step0["energy_terms_j"]["E_ex"] = 123.0
                    else:
                        step0["max_torque_apm"] = 456.0

                with self.subTest(mutation=mutation), self.assertRaises(ContractError):
                    verifier.compare_runtime_summaries(
                        cpu_summary,
                        gpu_summary,
                        cpu_artifacts=cpu[2],
                        gpu_artifacts=gpu[2],
                    )

    def test_compare_rejects_final_field_chunk_tampered_after_validation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cpu = self._write_valid_bundle(root, "cpu")
            gpu = self._write_valid_bundle(root, "gpu")
            cpu_summary = validate_runtime_artifacts(
                cpu[0], cpu[1], cpu[2], device="cpu", runtime_log=cpu[3], runtime_manifest=cpu[4]
            )
            gpu_summary = validate_runtime_artifacts(
                gpu[0], gpu[1], gpu[2], device="gpu", runtime_log=gpu[3], runtime_manifest=gpu[4]
            )
            (gpu[2] / "fields/H_demag.zarr/1.0.0").write_bytes(
                struct.pack("<9d", *([123.0] * 9))
            )

            with self.assertRaises(ContractError):
                verifier.compare_runtime_summaries(
                    cpu_summary,
                    gpu_summary,
                    cpu_artifacts=cpu[2],
                    gpu_artifacts=gpu[2],
                )

    def test_compare_rejects_summary_alias_of_final_chunk_to_step0_chunk(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cpu = self._write_valid_bundle(root, "cpu")
            gpu = self._write_valid_bundle(root, "gpu")
            cpu_summary = validate_runtime_artifacts(
                cpu[0], cpu[1], cpu[2], device="cpu", runtime_log=cpu[3], runtime_manifest=cpu[4]
            )
            gpu_summary = validate_runtime_artifacts(
                gpu[0], gpu[1], gpu[2], device="gpu", runtime_log=gpu[3], runtime_manifest=gpu[4]
            )
            descriptor = gpu_summary["step0_operator_artifacts"]["fields"]["H_demag"]
            descriptor["final_chunk_key"] = descriptor["step0_chunk_key"]
            descriptor["final_chunk_sha256"] = descriptor["step0_chunk_sha256"]
            (gpu[2] / "fields/H_demag.zarr/1.0.0").write_bytes(
                struct.pack("<9d", *([321.0] * 9))
            )

            with self.assertRaises(ContractError):
                verifier.compare_runtime_summaries(
                    cpu_summary,
                    gpu_summary,
                    cpu_artifacts=cpu[2],
                    gpu_artifacts=gpu[2],
                )

    def test_step0_field_tolerances_match_native_cpu_gpu_parity_contract(self) -> None:
        self.assertEqual(
            verifier.STEP0_FIELD_TOLERANCES,
            {
                "H_ex": {"rtol": 5.0e-8, "atol_apm": 1.0e-6},
                "H_demag": {"rtol": 5.0e-8, "atol_apm": 1.0e-6},
                "H_eff": {"rtol": 5.0e-8, "atol_apm": 1.0e-6},
            },
        )

    def test_validate_accepts_canonically_omitted_empty_ignored_terms(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, bounded, artifacts, runtime_log, manifest, metadata = (
                self._write_valid_bundle(root, "cpu")
            )
            metadata["execution_provenance"].pop("ignored_terms")  # type: ignore[index]
            (artifacts / "metadata.json").write_text(
                json.dumps(metadata), encoding="utf-8"
            )

            summary = validate_runtime_artifacts(
                source,
                bounded,
                artifacts,
                device="cpu",
                runtime_log=runtime_log,
                runtime_manifest=manifest,
            )

            self.assertEqual(summary["execution_engine"], "fem_cpu_native")

    def test_validate_rejects_incomplete_certificate_coverage_and_air_families(self) -> None:
        mutations = (
            (
                "marker_coverage_complete",
                lambda certificate: certificate.__setitem__(
                    "marker_coverage_complete", False
                ),
            ),
            (
                "nonconforming_face_count",
                lambda certificate: certificate.__setitem__(
                    "nonconforming_face_count", 1
                ),
            ),
            (
                "orphan_face_count",
                lambda certificate: certificate.__setitem__("orphan_face_count", 1),
            ),
            (
                "nonmanifold_face_count",
                lambda certificate: certificate.__setitem__(
                    "nonmanifold_face_count", 1
                ),
            ),
            (
                "coincident_interface_face_count",
                lambda certificate: certificate.__setitem__(
                    "coincident_interface_face_count", 1
                ),
            ),
            (
                "transition_pyramid5",
                lambda certificate: certificate["cell_family_counts_by_part"].__setitem__(
                    "transition_air", {"tet4": 4}
                ),
            ),
            (
                "transition_tet4",
                lambda certificate: certificate["cell_family_counts_by_part"].__setitem__(
                    "transition_air", {"pyramid5": 4}
                ),
            ),
            (
                "far_air_tet4",
                lambda certificate: certificate["cell_family_counts_by_part"].__setitem__(
                    "far_air", {"pyramid5": 8}
                ),
            ),
        )
        for case, mutate in mutations:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, bounded, artifacts, runtime_log, manifest, metadata = (
                    self._write_valid_bundle(root, "cpu")
                )
                mutated = copy.deepcopy(metadata)
                certificate = mutated["mesh"]["mesh_build_report"][  # type: ignore[index]
                    "mixed_layer_topology_certificate"
                ]
                mutate(certificate)
                (artifacts / "metadata.json").write_text(
                    json.dumps(mutated), encoding="utf-8"
                )
                with self.subTest(case=case), self.assertRaises(ContractError):
                    validate_runtime_artifacts(
                        source,
                        bounded,
                        artifacts,
                        device="cpu",
                        runtime_log=runtime_log,
                        runtime_manifest=manifest,
                    )

    def test_validate_rejects_stale_truncated_or_cross_unbound_final_artifacts(self) -> None:
        cases = (
            "observable",
            "unit",
            "step_zero",
            "source",
            "engine",
            "precision",
            "truncated_values",
            "mesh_node_count",
            "scalar_energy",
            "scalar_torque",
            "norm_defect",
        )
        for case in cases:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, bounded, artifacts, runtime_log, manifest, metadata = (
                    self._write_valid_bundle(root, "cpu")
                )
                field_path = artifacts / "m_final.json"
                field = json.loads(field_path.read_text(encoding="utf-8"))
                if case == "observable":
                    field["observable"] = "H_eff"
                elif case == "unit":
                    field["unit"] = "A/m"
                elif case == "step_zero":
                    field["step"] = 0
                elif case == "source":
                    field["provenance"]["source_hash"] = "0" * 64
                elif case == "engine":
                    field["provenance"]["execution_engine"] = "fem_native_gpu"
                elif case == "precision":
                    field["provenance"]["precision"] = "single"
                elif case == "truncated_values":
                    field["values"] = field["values"][:1]
                elif case == "mesh_node_count":
                    metadata["mesh"]["node_count"] = 4  # type: ignore[index]
                    (artifacts / "metadata.json").write_text(
                        json.dumps(metadata), encoding="utf-8"
                    )
                elif case == "scalar_energy":
                    (artifacts / "scalars.csv").write_text(
                        "step,E_ex,E_demag,E_total,max_torque_T\n1,9.0,2.0,3.0,5e-6\n",
                        encoding="utf-8",
                    )
                elif case == "scalar_torque":
                    (artifacts / "scalars.csv").write_text(
                        "step,E_ex,E_demag,E_total,max_torque_T\n1,1.0,2.0,3.0,6e-6\n",
                        encoding="utf-8",
                    )
                elif case == "norm_defect":
                    metadata["fem_cpu_relaxation_qualification"][  # type: ignore[index]
                        "norm_defect"
                    ] = 1.0e-10
                    (artifacts / "metadata.json").write_text(
                        json.dumps(metadata), encoding="utf-8"
                    )
                field_path.write_text(json.dumps(field), encoding="utf-8")
                with self.subTest(case=case), self.assertRaises(ContractError):
                    validate_runtime_artifacts(
                        source,
                        bounded,
                        artifacts,
                        device="cpu",
                        runtime_log=runtime_log,
                        runtime_manifest=manifest,
                    )

    def test_norm_defect_recomputation_excludes_nonunit_shared_domain_air_nodes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, bounded, artifacts, runtime_log, manifest, _ = (
                self._write_valid_bundle(root, "cpu")
            )

            summary = validate_runtime_artifacts(
                source,
                bounded,
                artifacts,
                device="cpu",
                runtime_log=runtime_log,
                runtime_manifest=manifest,
            )

            self.assertEqual(summary["norm_defect"], 0.0)
            self.assertEqual(summary["final_magnetization"][-1], [0.0, 0.0, 0.0])

    def test_dimensionless_recomputation_tolerance_is_exactly_sixteen_epsilon(self) -> None:
        self.assertEqual(
            verifier.DIMENSIONLESS_RECOMPUTATION_ATOL,
            16.0 * math.ulp(1.0),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, bounded, artifacts, runtime_log, manifest, metadata = (
                self._write_valid_bundle(root, "cpu")
            )
            qualification = metadata["fem_cpu_relaxation_qualification"]  # type: ignore[assignment]
            qualification["norm_defect"] = verifier.DIMENSIONLESS_RECOMPUTATION_ATOL
            (artifacts / "metadata.json").write_text(
                json.dumps(metadata), encoding="utf-8"
            )

            validate_runtime_artifacts(
                source,
                bounded,
                artifacts,
                device="cpu",
                runtime_log=runtime_log,
                runtime_manifest=manifest,
            )

            qualification["norm_defect"] = (
                2.0 * verifier.DIMENSIONLESS_RECOMPUTATION_ATOL
            )
            (artifacts / "metadata.json").write_text(
                json.dumps(metadata), encoding="utf-8"
            )
            with self.assertRaises(ContractError):
                validate_runtime_artifacts(
                    source,
                    bounded,
                    artifacts,
                    device="cpu",
                    runtime_log=runtime_log,
                    runtime_manifest=manifest,
                )

    def test_validate_rejects_per_run_device_fallback_topology_and_source_violations(self) -> None:
        cases = (
            "authored_device",
            "override_source",
            "effective_device",
            "engine",
            "resolved_fallback",
            "ignored_terms",
            "report_fallback",
            "degraded",
            "global_topology_fingerprint",
            "certificate_fingerprint",
            "topology_version",
            "layer_count",
            "magnetic_family",
            "steps",
            "energy",
            "torque",
            "source_hash",
        )
        for case in cases:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, bounded, artifacts, runtime_log, manifest, metadata = (
                    self._write_valid_bundle(root, "cpu")
                )
                mutated = copy.deepcopy(metadata)
                runtime = mutated["problem_meta"]["runtime_metadata"]  # type: ignore[index]
                provenance = mutated["execution_provenance"]  # type: ignore[assignment]
                report = mutated["mesh"]["mesh_build_report"]  # type: ignore[index]
                certificate = report["mixed_layer_topology_certificate"]  # type: ignore[index]
                qualification = mutated["fem_cpu_relaxation_qualification"]  # type: ignore[assignment]
                if case == "authored_device":
                    runtime["runtime_selection"]["device"] = "cpu"
                elif case == "override_source":
                    runtime["runtime_device_override"]["source"] = "script"
                elif case == "effective_device":
                    mutated["requested_execution"]["device"] = "gpu"  # type: ignore[index]
                elif case == "engine":
                    provenance["execution_engine"] = "fem_native_gpu"
                elif case == "resolved_fallback":
                    provenance["resolved_fallback"] = {"occurred": True}
                elif case == "ignored_terms":
                    provenance["ignored_terms"] = ["exchange"]
                elif case == "report_fallback":
                    report["fallbacks_triggered"] = ["tet_conversion"]
                elif case == "degraded":
                    report["degraded"] = True
                elif case == "global_topology_fingerprint":
                    mutated["mesh"]["topology_fingerprint"] = (  # type: ignore[index]
                        "sha256:invalid"
                    )
                elif case == "certificate_fingerprint":
                    certificate["topology_fingerprint"] = "sha256:" + "b" * 64
                elif case == "topology_version":
                    certificate["topology_fingerprint_version"] = "v2"
                elif case == "layer_count":
                    certificate["realized_layer_count"] = 2
                elif case == "magnetic_family":
                    certificate["cell_family_counts_by_part"]["magnetic"] = {"tet4": 2}
                elif case == "steps":
                    qualification["executed_steps"] = 2
                elif case == "energy":
                    qualification["final_energy_terms_j"]["E_total"] = math.nan
                elif case == "torque":
                    qualification["final_torque_t"] = math.inf
                elif case == "source_hash":
                    mutated["source_hash"] = "0" * 64
                (artifacts / "metadata.json").write_text(
                    json.dumps(mutated), encoding="utf-8"
                )
                with self.subTest(case=case), self.assertRaises(ContractError):
                    validate_runtime_artifacts(
                        source,
                        bounded,
                        artifacts,
                        device="cpu",
                        runtime_log=runtime_log,
                        runtime_manifest=manifest,
                    )

    def test_validate_rejects_each_gpu_identity_residency_and_telemetry_violation(self) -> None:
        cases = {
            "device_name": "Different GPU",
            "mfem_version": "4.8",
            "mfem_device": "cpu",
            "fem_execution_mode": "hybrid_legacy_sparse",
            "fem_data_residency": "host_source_of_truth",
            "fem_exchange_operator_mode": "unsupported",
            "uses_cuda_kernels": False,
            "uses_gpu_poisson": False,
            "fem_demag_operator_mode": "hybrid_cpu_poisson",
            "hypre_execution_policy": "host",
            "demag_residency": "host_device_roundtrip",
            "hot_loop_exchange_h2d_bytes": 8,
            "hot_loop_exchange_d2h_bytes": 8,
            "hot_loop_exchange_host_sync_count": 1,
            "hot_loop_compute_h2d_bytes": 8,
            "hot_loop_compute_d2h_bytes": 8,
            "hot_loop_compute_host_sync_count": 1,
            "hot_loop_control_scalar_host_sync_count": 8,
        }
        for field, value in cases.items():
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, bounded, artifacts, runtime_log, manifest, metadata = (
                    self._write_valid_bundle(root, "gpu")
                )
                mutated = copy.deepcopy(metadata)
                mutated["execution_provenance"][field] = value  # type: ignore[index]
                (artifacts / "metadata.json").write_text(
                    json.dumps(mutated), encoding="utf-8"
                )
                with self.subTest(field=field), self.assertRaises(ContractError):
                    validate_runtime_artifacts(
                        source,
                        bounded,
                        artifacts,
                        device="gpu",
                        runtime_log=runtime_log,
                        runtime_manifest=manifest,
                    )

    def test_validate_rejects_missing_gpu_mfem_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, bounded, artifacts, runtime_log, manifest, metadata = (
                self._write_valid_bundle(root, "gpu")
            )
            del metadata["execution_provenance"]["mfem_version"]  # type: ignore[index]
            (artifacts / "metadata.json").write_text(
                json.dumps(metadata), encoding="utf-8"
            )

            with self.assertRaises(ContractError):
                validate_runtime_artifacts(
                    source,
                    bounded,
                    artifacts,
                    device="gpu",
                    runtime_log=runtime_log,
                    runtime_manifest=manifest,
                )

    def test_validate_rejects_legacy_ceed_cuda_device_labels(self) -> None:
        for section in ("execution_provenance", "demag_runtime"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, bounded, artifacts, runtime_log, manifest, metadata = (
                    self._write_valid_bundle(root, "gpu")
                )
                metadata[section]["mfem_device"] = "ceed-cuda:/gpu/cuda/shared"  # type: ignore[index]
                (artifacts / "metadata.json").write_text(
                    json.dumps(metadata), encoding="utf-8"
                )

                with self.subTest(section=section), self.assertRaises(ContractError):
                    validate_runtime_artifacts(
                        source,
                        bounded,
                        artifacts,
                        device="gpu",
                        runtime_log=runtime_log,
                        runtime_manifest=manifest,
                    )

    def test_validate_rejects_missing_or_unbound_gpu_demag_step_evidence(self) -> None:
        for case in ("missing_columns", "zero_solves", "iterations", "residual"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, bounded, artifacts, runtime_log, manifest, _ = (
                    self._write_valid_bundle(root, "gpu")
                )
                path = artifacts / "solver_steps.csv"
                with path.open(newline="", encoding="utf-8") as stream:
                    row = next(csv.DictReader(stream))
                if case == "missing_columns":
                    fieldnames = ["step", "rhs_evals", "rejected_attempts"]
                else:
                    fieldnames = list(row)
                    if case == "zero_solves":
                        row["demag_solves"] = "0"
                    elif case == "iterations":
                        row["demag_iterations"] = "11"
                    elif case == "residual":
                        row["demag_residual"] = "2e-13"
                with path.open("w", newline="", encoding="utf-8") as stream:
                    writer = csv.DictWriter(stream, fieldnames=fieldnames)
                    writer.writeheader()
                    writer.writerow({field: row[field] for field in fieldnames})

                with self.subTest(case=case), self.assertRaises(ContractError):
                    validate_runtime_artifacts(
                        source,
                        bounded,
                        artifacts,
                        device="gpu",
                        runtime_log=runtime_log,
                        runtime_manifest=manifest,
                    )

    def test_validate_rejects_missing_or_unexpected_gradient_policy(self) -> None:
        cases = (
            (
                "cpu_missing",
                "cpu",
                lambda policy: policy.pop("preconditioner"),
            ),
            (
                "cpu_unexpected",
                "cpu",
                lambda policy: policy.__setitem__(
                    "preconditioner", "raw_tangent_gradient"
                ),
            ),
            (
                "gpu_missing",
                "gpu",
                lambda policy: policy.pop("gradient_policy"),
            ),
            (
                "gpu_unexpected",
                "gpu",
                lambda policy: policy.__setitem__(
                    "gradient_policy", "exchange_plus_mass_tangent_gradient"
                ),
            ),
        )
        for case, device, mutate in cases:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, bounded, artifacts, runtime_log, manifest, metadata = (
                    self._write_valid_bundle(root, device)
                )
                qualification = metadata[
                    f"fem_{device}_relaxation_qualification"
                ]
                mutate(qualification["algorithm_policy"])  # type: ignore[index]
                (artifacts / "metadata.json").write_text(
                    json.dumps(metadata), encoding="utf-8"
                )

                with self.subTest(case=case), self.assertRaisesRegex(
                    ContractError, "gradient policy"
                ):
                    validate_runtime_artifacts(
                        source,
                        bounded,
                        artifacts,
                        device=device,
                        runtime_log=runtime_log,
                        runtime_manifest=manifest,
                    )

    def test_validate_rejects_missing_or_tampered_initial_state(self) -> None:
        for case in ("missing", "step", "value"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, bounded, artifacts, runtime_log, manifest, _ = (
                    self._write_valid_bundle(root, "cpu")
                )
                path = artifacts / "m_initial.json"
                if case == "missing":
                    path.unlink()
                else:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                    if case == "step":
                        payload["step"] = 1
                    else:
                        payload["values"][0][0] = 0.5
                    path.write_text(json.dumps(payload), encoding="utf-8")

                with self.subTest(case=case), self.assertRaises(ContractError):
                    validate_runtime_artifacts(
                        source,
                        bounded,
                        artifacts,
                        device="cpu",
                        runtime_log=runtime_log,
                        runtime_manifest=manifest,
                    )

    def test_validate_rejects_invalid_accepted_armijo_proof(self) -> None:
        mutations = {
            "unavailable": {"accepted_energy_proof_available": "false"},
            "positive_upper": {
                "accepted_energy_delta_j": "1e-3",
                "accepted_energy_roundoff_bound_j": "0",
                "accepted_energy_delta_upper_j": "1e-3",
            },
            "rhs_nonnegative": {"armijo_increment_rhs_j": "0"},
            "armijo_failed": {
                "accepted_energy_delta_j": "-1e-7",
                "accepted_energy_roundoff_bound_j": "0",
                "accepted_energy_delta_upper_j": "-1e-7",
                "armijo_increment_rhs_j": "-1e-6",
            },
        }
        for case, updates in mutations.items():
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, bounded, artifacts, runtime_log, manifest, _ = (
                    self._write_valid_bundle(root, "cpu")
                )
                path = artifacts / "solver_steps.csv"
                with path.open(newline="", encoding="utf-8") as stream:
                    row = next(csv.DictReader(stream))
                row.update(updates)
                with path.open("w", newline="", encoding="utf-8") as stream:
                    writer = csv.DictWriter(stream, fieldnames=list(row))
                    writer.writeheader()
                    writer.writerow(row)

                with self.subTest(case=case), self.assertRaisesRegex(
                    ContractError, "Armijo|energy proof"
                ):
                    validate_runtime_artifacts(
                        source,
                        bounded,
                        artifacts,
                        device="cpu",
                        runtime_log=runtime_log,
                        runtime_manifest=manifest,
                    )

    def test_compare_accepts_policy_specific_one_step_endpoints(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cpu = self._write_valid_bundle(root, "cpu")
            gpu = self._write_valid_bundle(root, "gpu")
            gpu_field_path = gpu[2] / "m_final.json"
            gpu_field = json.loads(gpu_field_path.read_text(encoding="utf-8"))
            gpu_field["values"][0] = [0.8, 0.6, 0.0]
            gpu_field_path.write_text(json.dumps(gpu_field), encoding="utf-8")
            gpu_metadata = gpu[5]
            gpu_metadata["fem_gpu_relaxation_qualification"][  # type: ignore[index]
                "final_energy_terms_j"
            ]["E_ex"] = 9.0
            gpu_metadata["fem_gpu_relaxation_qualification"][  # type: ignore[index]
                "final_torque_apm"
            ] = 12.0
            (gpu[2] / "metadata.json").write_text(
                json.dumps(gpu_metadata), encoding="utf-8"
            )
            scalar_path = gpu[2] / "scalars.csv"
            with scalar_path.open(newline="", encoding="utf-8") as stream:
                scalar_rows = list(csv.DictReader(stream))
                scalar_fields = list(scalar_rows[0])
            scalar_rows[1]["E_ex"] = "9.000000000000000e+00"
            with scalar_path.open("w", newline="", encoding="utf-8") as stream:
                writer = csv.DictWriter(stream, fieldnames=scalar_fields)
                writer.writeheader()
                writer.writerows(scalar_rows)

            cpu_summary = validate_runtime_artifacts(
                cpu[0], cpu[1], cpu[2], device="cpu", runtime_log=cpu[3], runtime_manifest=cpu[4]
            )
            gpu_summary = validate_runtime_artifacts(
                gpu[0], gpu[1], gpu[2], device="gpu", runtime_log=gpu[3], runtime_manifest=gpu[4]
            )

            comparison = verifier.compare_runtime_summaries(
                cpu_summary,
                gpu_summary,
                cpu_artifacts=cpu[2],
                gpu_artifacts=gpu[2],
            )

            self.assertEqual(comparison["status"], "pass")
            self.assertEqual(
                comparison["one_step_endpoint_parity"]["status"],  # type: ignore[index]
                "not_applicable",
            )

    def test_compare_rejects_initial_state_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cpu = self._write_valid_bundle(root, "cpu")
            gpu = self._write_valid_bundle(root, "gpu")
            initial_path = gpu[2] / "m_initial.json"
            initial = json.loads(initial_path.read_text(encoding="utf-8"))
            initial["values"][0] = [0.0, 1.0, 0.0]
            initial_path.write_text(json.dumps(initial), encoding="utf-8")
            cpu_summary = validate_runtime_artifacts(
                cpu[0], cpu[1], cpu[2], device="cpu", runtime_log=cpu[3], runtime_manifest=cpu[4]
            )
            gpu_summary = validate_runtime_artifacts(
                gpu[0], gpu[1], gpu[2], device="gpu", runtime_log=gpu[3], runtime_manifest=gpu[4]
            )

            with self.assertRaisesRegex(ContractError, "initial magnetization"):
                verifier.compare_runtime_summaries(
                    cpu_summary,
                    gpu_summary,
                    cpu_artifacts=cpu[2],
                    gpu_artifacts=gpu[2],
                )

    def test_compare_rejects_runtime_source_topology_and_initial_state_drift(self) -> None:
        mutations = (
            ("runtime", lambda summary: summary.__setitem__("runtime_manifest_sha256", "0" * 64)),
            (
                "runtime_source",
                lambda summary: summary.__setitem__(
                    "runtime_source_snapshot_sha256", "0" * 64
                ),
            ),
            (
                "captured_source_file",
                lambda summary: summary.__setitem__(
                    "source_snapshot_identity_sha256", "0" * 64
                ),
            ),
            ("source", lambda summary: summary.__setitem__("bounded_source_sha256", "0" * 64)),
            ("topology", lambda summary: summary.__setitem__("topology_fingerprint", "sha256:" + "b" * 64)),
            (
                "certificate",
                lambda summary: summary.__setitem__(
                    "certificate_fingerprint", "sha256:" + "b" * 64
                ),
            ),
            (
                "initial_state",
                lambda summary: summary["initial_magnetization"][0].__setitem__(
                    0, 0.5
                ),
            ),
        )
        for case, mutate in mutations:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                cpu = self._write_valid_bundle(root, "cpu")
                gpu = self._write_valid_bundle(root, "gpu")
                cpu_summary = validate_runtime_artifacts(
                    cpu[0], cpu[1], cpu[2], device="cpu", runtime_log=cpu[3], runtime_manifest=cpu[4]
                )
                gpu_summary = validate_runtime_artifacts(
                    gpu[0], gpu[1], gpu[2], device="gpu", runtime_log=gpu[3], runtime_manifest=gpu[4]
                )
                mutate(gpu_summary)
                with self.subTest(case=case), self.assertRaises(ContractError):
                    verifier.compare_runtime_summaries(
                        cpu_summary,
                        gpu_summary,
                        cpu_artifacts=cpu[2],
                        gpu_artifacts=gpu[2],
                    )

    def test_compare_revalidates_persisted_lane_proofs(self) -> None:
        mutations = (
            ("schema", "cpu", lambda summary: summary.__setitem__("schema_version", "stale")),
            ("fallback", "cpu", lambda summary: summary.__setitem__("fallbacks_triggered", ["hidden"])),
            ("degraded", "cpu", lambda summary: summary.__setitem__("degraded", True)),
            ("norm", "cpu", lambda summary: summary.__setitem__("norm_defect", 0.5)),
            (
                "armijo_available",
                "cpu",
                lambda summary: summary["accepted_energy_proof"].__setitem__(
                    "available", False
                ),
            ),
            (
                "armijo_upper",
                "cpu",
                lambda summary: summary["accepted_energy_proof"].__setitem__(
                    "delta_upper_j", 1.0
                ),
            ),
            (
                "cpu_residency",
                "cpu",
                lambda summary: summary.__setitem__(
                    "residency", {"mode": "hidden_gpu_fallback"}
                ),
            ),
            (
                "gpu_residency",
                "gpu",
                lambda summary: summary["residency"].__setitem__(
                    "mode", "host_source_of_truth"
                ),
            ),
            (
                "gpu_transfer",
                "gpu",
                lambda summary: summary["residency"]["transfer_telemetry"][
                    "raw"
                ].__setitem__("hot_loop_compute_d2h_bytes", 8),
            ),
            (
                "gpu_budget",
                "gpu",
                lambda summary: summary["residency"]["transfer_telemetry"].update(
                    {
                        "allowed_control_scalar_host_sync_count": 999,
                        "allowed_control_scalar_d2h_bytes": 999,
                    }
                ),
            ),
            (
                "gpu_total_sync",
                "gpu",
                lambda summary: summary["residency"]["transfer_telemetry"][
                    "raw"
                ].__setitem__("hot_loop_host_sync_count", 999),
            ),
            (
                "gpu_unaligned_bytes",
                "gpu",
                lambda summary: (
                    summary["residency"]["transfer_telemetry"].__setitem__(
                        "control_scalar_d2h_bytes", 593
                    ),
                    summary["residency"]["transfer_telemetry"]["raw"].__setitem__(
                        "hot_loop_control_scalar_d2h_bytes", 593
                    ),
                ),
            ),
        )
        for case, device, mutate in mutations:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                cpu = self._write_valid_bundle(root, "cpu")
                gpu = self._write_valid_bundle(root, "gpu")
                cpu_summary = validate_runtime_artifacts(
                    cpu[0], cpu[1], cpu[2], device="cpu", runtime_log=cpu[3], runtime_manifest=cpu[4]
                )
                gpu_summary = validate_runtime_artifacts(
                    gpu[0], gpu[1], gpu[2], device="gpu", runtime_log=gpu[3], runtime_manifest=gpu[4]
                )
                mutate(cpu_summary if device == "cpu" else gpu_summary)

                with self.subTest(case=case), self.assertRaises(ContractError):
                    verifier.compare_runtime_summaries(
                        cpu_summary,
                        gpu_summary,
                        cpu_artifacts=cpu[2],
                        gpu_artifacts=gpu[2],
                    )

    def test_just_recipe_is_append_only_managed_cpu_gpu_gate(self) -> None:
        justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
        recipe = justfile.split(
            "verify-fem-mixed-prism-airbox-runtime:", 1
        )[1].split("\nverify-fem-mixed-p1-native-contract:", 1)[0]
        self.assertIn(
            "tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py",
            recipe,
        )
        self.assertIn("just ensure-managed-fem-runtime", recipe)
        self.assertIn("just fem-managed-headless cpu", recipe)
        self.assertIn("just fem-managed-headless gpu", recipe)
        self.assertEqual(
            recipe.count("verify_fem_mixed_prism_airbox_runtime.py prepare"), 1
        )
        self.assertEqual(
            recipe.count("verify_fem_mixed_prism_airbox_runtime.py validate"), 2
        )
        self.assertIn("verify_fem_mixed_prism_airbox_runtime.py compare", recipe)
        self.assertIn("runtime-manifest", recipe)
        self.assertIn("runtime-manifest.v3.json", recipe)
        self.assertNotIn("runtime-manifest.v2.json", recipe)
        self.assertIn('cpu/summary.v4.json', recipe)
        self.assertIn('gpu/summary.v4.json', recipe)
        self.assertIn('--cpu-artifacts "$run_dir/cpu/artifacts"', recipe)
        self.assertIn('--gpu-artifacts "$run_dir/gpu/artifacts"', recipe)
        self.assertIn('summary.v3.json', recipe)
        self.assertIn('comparison.v3.csv', recipe)
        self.assertNotIn('summary.v2.json', recipe)
        self.assertNotIn('comparison.v2.csv', recipe)
        self.assertIn("mktemp -d", recipe)
        self.assertIn("capture_source_snapshot_identity.py", recipe)
        self.assertEqual(
            recipe.count('--compare "$run_dir/source-snapshot.v2.json"'), 3
        )
        self.assertIn("create_managed_fem_report_run_root", recipe)
        self.assertIn("source-snapshot.v2.json", recipe)
        self.assertIn("/mnt/fullmag-zfn2-native", recipe)
        report_helper = (
            REPO_ROOT / "scripts/lib/managed_fem_report_storage.sh"
        ).read_text(encoding="utf-8")
        self.assertIn('runs/run.XXXXXXXX', report_helper)
        self.assertNotIn("docker ", recipe)
        self.assertNotIn("--skip-geometry-assets", recipe)
        self.assertNotIn("FULLMAG_RUN_SLOW_REAL_ASSET_TESTS", recipe)

    def test_common_report_storage_rejects_outside_and_symlink_paths(self) -> None:
        helper = REPO_ROOT / "scripts/lib/managed_fem_report_storage.sh"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            durable = root / "durable"
            durable.mkdir()
            outside = root / "outside" / "report"
            symlink = durable / "link"
            symlink.symlink_to(root / "outside", target_is_directory=True)
            for label, report, expected in (
                ("outside", outside, "contained by durable root"),
                ("symlink", symlink / "report", "must not be a symlink"),
            ):
                completed = subprocess.run(
                    (
                        "bash", "-euo", "pipefail", "-c",
                        'source "$1"; validate_managed_fem_report_path "$2" "$3"',
                        "report-path-test", str(helper), str(durable), str(report),
                    ),
                    capture_output=True,
                    text=True,
                    check=False,
                )
                with self.subTest(label=label):
                    self.assertEqual(completed.returncode, 2)
                    self.assertIn(expected, completed.stderr)

    def test_all_mixed_report_recipes_use_common_fail_closed_helper(self) -> None:
        justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
        for recipe_name, next_recipe in (
            ("verify-fem-mixed-prism-airbox-runtime:", "verify-fem-mixed-p1-native-contract:"),
            ("verify-fem-sp4-mixed-matrix-smoke:", "verify-fem-sp4-mixed-matrix:"),
            ("verify-fem-sp4-mixed-matrix:", "fem-managed-container-headless"),
        ):
            recipe = justfile.split(recipe_name, 1)[1].split(next_recipe, 1)[0]
            with self.subTest(recipe=recipe_name):
                self.assertIn("create_managed_fem_report_run_root", recipe)
                helper_index = recipe.index("create_managed_fem_report_run_root")
                report_mkdir_index = recipe.find("mkdir -p")
                report_mktemp_index = recipe.find("mktemp -d")
                self.assertTrue(
                    report_mkdir_index == -1 or helper_index < report_mkdir_index
                )
                self.assertTrue(
                    report_mktemp_index == -1 or helper_index < report_mktemp_index
                )

    def test_worktree_gate_reuses_valid_shared_python_without_host_ensurepip(self) -> None:
        justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
        managed_recipe = justfile.split("fem-managed-headless fem_execution", 1)[1].split(
            "\nfem-sp4-run", 1
        )[0]
        gate_recipe = justfile.split(
            "verify-fem-mixed-prism-airbox-runtime:", 1
        )[1].split("\nverify-fem-mixed-p1-native-contract:", 1)[0]

        self.assertIn('if [ -z "${FULLMAG_PYTHON:-}" ]; then just ensure-python; fi', managed_recipe)
        self.assertIn('managed_python="${FULLMAG_PYTHON:-{{repo_python}}}"', managed_recipe)
        self.assertIn('FULLMAG_PYTHON="$managed_python"', managed_recipe)
        self.assertIn("git rev-parse --path-format=absolute --git-common-dir", gate_recipe)
        self.assertIn('FULLMAG_PYTHON="$managed_python" just fem-managed-headless cpu', gate_recipe)
        self.assertIn('FULLMAG_PYTHON="$managed_python" just fem-managed-headless gpu', gate_recipe)


if __name__ == "__main__":
    unittest.main()
