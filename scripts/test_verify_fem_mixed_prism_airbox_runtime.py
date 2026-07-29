from __future__ import annotations

import copy
import csv
import hashlib
import json
import math
from pathlib import Path
import tempfile
import unittest

import scripts.verify_fem_mixed_prism_airbox_runtime as verifier
from scripts.verify_fem_mixed_prism_airbox_runtime import (
    ContractError,
    prepare_bounded_scenario,
    validate_runtime_artifacts,
)


REPO_ROOT = Path(__file__).resolve().parents[1]


class MixedPrismAirboxRuntimeVerifierTest(unittest.TestCase):
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
        manifest = {
            "schema": 2,
            "runtime": "fem-gpu-host",
            "variant": "hypre-baseline",
            "created_at": "2026-07-29T12:00:00+00:00",
            "docker_image_id": "sha256:" + "d" * 64,
            "source_manifest_sha256": "e" * 64,
            "integrity": {
                "launcher_sha256": "1" * 64,
                "worker_sha256": "2" * 64,
                "api_sha256": "3" * 64,
            },
            "native_libraries": {
                "fullmag_fem": {
                    "path": "lib/libfullmag_fem.so.0",
                    "sha256": "4" * 64,
                }
            },
            "runtime_diagnostics": {
                "device_name": "NVIDIA GeForce RTX 4080",
                "compute_capability": "8.9",
                "cuda_driver_version": "575.64",
            },
        }
        path = runtime_root / "manifest.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        return path

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
        fingerprint = "sha256:" + "a" * 64
        certificate = {
            "schema_version": "mixed_layer_topology_certificate.v1",
            "certificate_status": "accepted",
            "topology_fingerprint_version": "v3",
            "topology_fingerprint": fingerprint,
            "requested_layer_count": 1,
            "realized_layer_count": 1,
            "magnetic_plane_coordinates_m": [-1.5e-9, 1.5e-9],
            "cell_family_counts_by_part": {
                "magnetic": {"prism6": 2},
                "transition_air": {"pyramid5": 4, "tet4": 4},
                "far_air": {"tet4": 8},
            },
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
                "accepted_certificate_fingerprint": fingerprint,
                "requested_device": device,
                "precision": "double",
                "capability_status": "implemented",
            },
        }
        energy_terms = {
            "E_ex": 1.0,
            "E_demag": 2.0,
            "E_ext": 0.0,
            "e_drive": 0.0,
            "E_ani": 0.0,
            "E_dmi": 0.0,
            "E_total": 3.0,
        }
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
            "mesh": {
                "topology_fingerprint": fingerprint,
                "mesh_build_report": report,
            },
        }
        qualification = {
            "schema_version": f"fem_{device}_relaxation_qualification.v1",
            "relaxation_algorithm": "projected_gradient_bb",
            "executed_steps": 1,
            "final_energy_terms_j": energy_terms,
            "final_torque_apm": 4.0,
            "final_torque_t": 5.0e-6,
            "norm_defect": 0.0,
        }
        if device == "cpu":
            metadata["fem_cpu_relaxation_qualification"] = qualification
        else:
            execution_provenance.update(
                {
                    "device_name": "NVIDIA GeForce RTX 4080",
                    "compute_capability": "8.9",
                    "mfem_device": "ceed-cuda:/gpu/cuda/shared",
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
                    "hot_loop_h2d_bytes": 0,
                    "hot_loop_d2h_bytes": 56,
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
                "mfem_device": "ceed-cuda:/gpu/cuda/shared",
                "actual_iterations": 12,
                "final_residual_norm": 1.0e-13,
                "relative_tolerance": 1.0e-12,
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
                fieldnames=["step", "E_ex", "E_demag", "E_total", "max_torque_T"],
            )
            writer.writeheader()
            writer.writerow(
                {
                    "step": 1,
                    "E_ex": 1.0,
                    "E_demag": 2.0,
                    "E_total": 3.0,
                    "max_torque_T": 5.0e-6,
                }
            )
        with (artifacts / "solver_steps.csv").open(
            "w", newline="", encoding="utf-8"
        ) as stream:
            writer = csv.DictWriter(
                stream,
                fieldnames=["step", "rhs_evals", "rejected_attempts"],
            )
            writer.writeheader()
            writer.writerow({"step": 1, "rhs_evals": 2, "rejected_attempts": 0})
        (artifacts / "m_final.json").write_text(
            json.dumps({"values": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]}),
            encoding="utf-8",
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
            comparison = verifier.compare_runtime_summaries(cpu_summary, gpu_summary)
            csv_path = root / "comparison.v1.csv"
            verifier.write_comparison_csv(csv_path, comparison)

            self.assertEqual(cpu_summary["execution_engine"], "fem_cpu_native")
            self.assertEqual(gpu_summary["execution_engine"], "fem_native_gpu")
            self.assertEqual(gpu_summary["gpu_transfer_telemetry"]["control_scalar_host_sync_count"], 7)  # type: ignore[index]
            self.assertEqual(comparison["schema_version"], "fem_mixed_prism_airbox_cpu_gpu.v1")
            self.assertEqual(comparison["status"], "pass")
            self.assertEqual(comparison["state_parity"]["max_component_abs_delta"], 0.0)  # type: ignore[index]
            self.assertEqual(comparison["qualification_status"], "implemented")
            self.assertIn("E_ex", csv_path.read_text(encoding="utf-8"))

    def test_validate_rejects_per_run_device_fallback_topology_and_source_violations(self) -> None:
        cases = (
            "authored_device",
            "override_source",
            "effective_device",
            "engine",
            "resolved_fallback",
            "report_fallback",
            "degraded",
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
                elif case == "report_fallback":
                    report["fallbacks_triggered"] = ["tet_conversion"]
                elif case == "degraded":
                    report["degraded"] = True
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

    def test_compare_rejects_runtime_source_topology_state_energy_and_torque_drift(self) -> None:
        mutations = (
            ("runtime", lambda summary: summary.__setitem__("runtime_manifest_sha256", "0" * 64)),
            ("source", lambda summary: summary.__setitem__("bounded_source_sha256", "0" * 64)),
            ("topology", lambda summary: summary.__setitem__("topology_fingerprint", "sha256:" + "b" * 64)),
            ("state", lambda summary: summary["final_magnetization"][0].__setitem__(0, 1.0 - 2.0e-9)),
            ("energy", lambda summary: summary["final_energy_terms_j"].__setitem__("E_ex", 1.1)),
            ("torque", lambda summary: summary.__setitem__("final_torque_apm", 5.0)),
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
                    verifier.compare_runtime_summaries(cpu_summary, gpu_summary)

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
        self.assertIn("mktemp -d", recipe)
        self.assertNotIn("docker ", recipe)
        self.assertNotIn("--skip-geometry-assets", recipe)
        self.assertNotIn("FULLMAG_RUN_SLOW_REAL_ASSET_TESTS", recipe)

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
