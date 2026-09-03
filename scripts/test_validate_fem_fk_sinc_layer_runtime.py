#!/usr/bin/env python3
"""Testy walidatora runtime FEM/BEM Fredkina–Köhlera dla warstwy sinc."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR_PATH = REPO_ROOT / "scripts" / "validate_fem_fk_sinc_layer_runtime.py"


def load_validator():
    spec = importlib.util.spec_from_file_location("validate_fem_fk_sinc_layer_runtime", VALIDATOR_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load validator: {VALIDATOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _bem_provenance(device: str) -> dict[str, object]:
    return {
        "operator_mode": "hierarchical_h2" if device == "cpu" else "device_hypre_fem_bem",
        "operator_fingerprint": "sha256:" + "a" * 64,
        "boundary_node_count": 4,
        "boundary_triangle_count": 4,
        "near_block_count": 4,
        "far_block_count": 2,
        "near_entry_count": 16,
        "far_row_count": 4,
        "max_rank": 2,
        "relative_error_estimate": 1.0e-10,
        "resident_bytes": 4096,
        "device_bytes": 0 if device == "cpu" else 8192,
        "operator_build_count": 1,
        "operator_upload_count": 0 if device == "cpu" else 1,
        "apply_count": 160001,
    }


def _receipt() -> dict[str, object]:
    return {
        "requested": "strict_device",
        "resolved": "device_resident",
        "executed": "cuda_fem",
        "execution_class": "device_resident",
        "device_ordinal": 0,
        "precision": "double",
        "integrator": "rk45",
        "required_operator_mask": 0x3FF,
        "resolved_device_operator_mask": 0x3FF,
        "resolved_host_operator_mask": 0,
        "resolved_unknown_operator_mask": 0,
        "executed_device_operator_mask": 0x3FF,
        "executed_host_operator_mask": 0,
        "executed_unknown_operator_mask": 0,
        "fallback_count": 0,
        "accepted_step_count": 80000,
        "rejected_attempt_count": 0,
        "failed_attempt_count": 0,
        "hot_loop_compute_h2d_bytes": 0,
        "hot_loop_compute_d2h_bytes": 0,
        "hot_loop_compute_host_sync_count": 0,
        "accounting_valid": True,
    }


def _case_metadata() -> dict[str, object]:
    return {
        "schema_version": "fullmag.run-metadata.v1",
        "problem_name": "fdm_fem_mumax3_sinc_layer",
        "status": "completed",
        "completion": {"status": "completed", "converged": True},
        "scalar_rows": 107,
        "accepted_solver_steps": 80002,
        "field_snapshots": 0,
        "pbc": [False, False, False],
        "requested_execution": {
            "backend": "fem",
            "device": "cpu",
            "precision": "double",
            "mode": "strict",
            "fallback_policy": "forbidden",
        },
        "problem_meta": {
            "runtime_metadata": {
                "fdm_fem_mumax3_sinc_layer": {
                    "schema_version": "fdm_fem_mumax3_sinc_layer.v1",
                    "backend": "fem",
                    "fem_demag": "fredkin_koehler",
                    "fem_mesh_mode": "body_only_free_tetrahedral",
                    "geometry_size_m": [500e-9, 500e-9, 10e-9],
                    "fdm_cell_m": [2.5e-9, 2.5e-9, 10e-9],
                    "pbc": [False, False, False],
                    "material": {
                        "name": "Py",
                        "Ms_A_per_m": 800e3,
                        "A_J_per_m": 13e-12,
                        "alpha": 0.01,
                    },
                    "bias_B_T": [100e-3, 0.0, 0.0],
                    "drive": {
                        "amplitude_B_T": 1e-3,
                        "direction": [0.0, 1.0, 0.0],
                        "cutoff_hz": 10e9,
                        "t0_s": 2e-9,
                    },
                    "duration_s": 4e-9,
                    "dynamic_steps": 80000,
                    "dynamic_timestep_s": 5e-14,
                    "dynamic_initial_state": "relaxed_state_after_llg_overdamped",
                    "relaxation_policy": "same_script_pre_dynamic_llg_overdamped",
                    "relaxation": {
                        "algorithm": "llg_overdamped",
                        "solver": "heun",
                        "fixed_timestep_s": 5e-14,
                        "torque_tolerance_T": 1e-5,
                        "max_steps": 50000,
                        "state_artifact": "relaxed_state",
                        "field_drive_active": False,
                    },
                    "table_sampling_policy": {
                        "kind": "auto_sinc_cutoff",
                        "nyquist_guard_factor": 1.3,
                    },
                    "magnetization_field_outputs": False,
                }
            }
        },
        "execution_plan": {
            "common": {
                "requested_backend": "fem",
                "resolved_backend": "fem",
                "execution_mode": "strict",
            },
            "backend_plan": {
                "kind": "fem",
                "domain_mesh_mode": "merged_magnetic_mesh",
                "fe_order": 1,
                "hmax": 2.5e-9,
                "mesh_name": "fk_body",
                "mesh_parts": [{"role": "magnetic_object"}],
                "object_segments": [{"role": "magnetic_object"}],
                "mesh": {
                    "node_count": 4,
                    "periodic_node_pair_count": 0,
                    "periodic_boundary_pair_count": 0,
                },
                "material": {
                    "name": "Py",
                    "saturation_magnetisation": 800e3,
                    "exchange_stiffness": 13e-12,
                    "damping": 0.01,
                },
                "enable_exchange": True,
                "enable_demag": True,
                "external_field": [100e-3, 0.0, 0.0],
                "precision": "double",
                "demag_realization": "fredkin_koehler",
                "air_box_config": None,
            },
        },
        "mesh": {
            "node_count": 4,
            "element_count": 1,
            "periodic_node_pair_count": 0,
            "periodic_boundary_pair_count": 0,
        },
        "build_identity": {
            "git_commit": "b" * 40,
            "source_snapshot_sha256": "c" * 64,
            "worktree_state": "clean",
        },
        "demag_runtime": {
            "model": "fredkin_koehler",
            "magnetostatic_boundary_model": "fredkin_koehler",
            "poisson_operator": None,
            "boundary_variant": None,
            "airbox_factor": None,
            "robin_beta_mode": None,
            "robin_beta_factor": None,
            "bem_operator": _bem_provenance("cpu"),
        },
        "execution_provenance": {
            "execution_engine": "fem_cpu_native",
            "precision": "double",
            "lossy_fallback_used": False,
            "requested_demag_realization": "fredkin_koehler",
            "resolved_demag_realization": "fredkin_koehler",
            "fem_assembly_mode": "legacy_sparse",
            "fem_execution_mode": "cpu_native",
            "fem_demag_operator_mode": "hierarchical_h2",
            "hypre_execution_policy": "host_mfem_hypre",
            "demag_residency": "host",
            "energy_minimizer_realization": "native_llg_time_integrator",
            "llg_mode": "pure_damping",
            "fem_bem_demag": _bem_provenance("cpu"),
        },
        "fem_cpu_relaxation_qualification": {
            "schema_version": "fem_cpu_relaxation_qualification.v1",
            "benchmark_gate_version": "fem_cpu_no_pbc_adaptive.v1",
            "relaxation_algorithm": "llg_overdamped",
            "algorithm_policy": {
                "realization": "native_llg_time_integrator",
                "time_integrator": "heun",
                "precession_policy": "disabled_pure_damping",
                "rhs_policy": "llg_overdamped_rhs",
            },
            "assembly_mode": "legacy_sparse",
            "converged": True,
            "stop_reason": "torque",
            "stop_metric_unit": "T",
            "stop_metric_value": 1.0e-6,
            "stop_threshold": 1.0e-5,
            "final_torque_apm": 0.8,
            "final_torque_t": 1.0e-6,
            "norm_defect": 1.0e-12,
            "executed_steps": 2,
        },
        "sampling_resolution": {
            "schema_version": "sampling_resolution.v1",
            "requested_policy": {"kind": "auto_sinc_cutoff", "nyquist_guard_factor": 1.3},
            "sample_period_s": 1.0 / (2.0 * 1.3 * 10e9),
            "sampling_frequency_hz": 26e9,
            "maximum_cutoff_hz": 10e9,
            "nyquist_guard_factor": 1.3,
            "target_stage_id": "dynamic",
        },
    }


def _write_table(path: Path, dynamic: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = "step,time,solver_dt,mx,my,mz,E_ex,E_demag,E_ext,E_drive,E_ani,E_dmi,E_total\n"
    rows: list[str] = []
    if not dynamic:
        for step, energy in ((1, -1.0e-20), (2, -1.1e-20)):
            rows.append(
                f"{step}, {step * 5e-14:.16e},5e-14,1,0,0,0,0,{energy},0,0,0,{energy}\n"
            )
    else:
        dt = 5e-14
        sample = 1.0 / (2.0 * 1.3 * 10e9)
        for index in range(105):
            step = 1 if index == 0 else round(index * sample / dt)
            if index == 104:
                step = 80000
            time_s = step * dt
            rows.append(
                f"{step},{time_s:.16e},{dt:.16e},1,0,0,0,1e-20,-1e-20,0,0,0,0\n"
            )
    path.write_text(header + "".join(rows), encoding="utf-8")


def _write_fixture(root: Path, device: str) -> None:
    metadata = _case_metadata()
    metadata["requested_execution"]["device"] = device  # type: ignore[index]
    metadata["execution_provenance"]["execution_engine"] = (  # type: ignore[index]
        "fem_native_gpu" if device == "gpu" else "fem_cpu_native"
    )
    provenance = metadata["execution_provenance"]  # type: ignore[assignment]
    assert isinstance(provenance, dict)
    bem = _bem_provenance(device)
    provenance["fem_bem_demag"] = bem
    provenance["fem_execution_mode"] = "all_in_gpu_legacy_sparse" if device == "gpu" else "cpu_native"
    provenance["fem_demag_operator_mode"] = "device_hypre_fem_bem" if device == "gpu" else "hierarchical_h2"
    provenance["hypre_execution_policy"] = "device_hypre_cuda" if device == "gpu" else "host_mfem_hypre"
    provenance["demag_residency"] = "device" if device == "gpu" else "host"
    provenance["fem_gpu_qualification_status"] = "production_executable" if device == "gpu" else None
    metadata["demag_runtime"]["bem_operator"] = bem  # type: ignore[index]
    if device == "gpu":
        provenance["uses_cuda_kernels"] = True
        provenance["uses_gpu_poisson"] = True
        provenance["fem_data_residency"] = "device_source_of_truth"
        provenance["hot_loop_compute_h2d_bytes"] = 0
        provenance["hot_loop_compute_d2h_bytes"] = 0
        provenance["hot_loop_compute_host_sync_count"] = 0
        provenance["fem_gpu_execution_receipt"] = _receipt()
        metadata["fem_gpu_relaxation_qualification"] = {  # type: ignore[index]
            "schema_version": "fem_gpu_relaxation_qualification.v1",
            "relaxation_algorithm": "llg_overdamped",
            "algorithm_policy": {
                "realization": "native_llg_time_integrator",
                "time_integrator": "heun",
                "precession_policy": "disabled_pure_damping",
                "rhs_policy": "llg_overdamped_rhs",
            },
            "device_policy": {
                "execution_mode": "all_in_gpu_legacy_sparse",
                "qualification_status": "production_executable",
                "data_residency": "device_source_of_truth",
                "exchange_operator_mode": "legacy_sparse_gpu",
                "demag_operator_mode": "device_hypre_fem_bem",
                "uses_cuda_kernels": True,
                "uses_gpu_poisson": True,
                "hot_loop_exchange_host_sync_count": 0,
                "hot_loop_compute_host_sync_count": 0,
                "hot_loop_control_scalar_host_sync_count": 0,
            },
            "converged": True,
            "stop_reason": "torque",
            "stop_metric_unit": "T",
            "stop_metric_value": 1e-6,
            "stop_threshold": 1e-5,
            "final_torque_apm": 0.8,
            "final_torque_t": 1e-6,
            "norm_defect": 1e-12,
            "executed_steps": 2,
        }
        metadata["fem_cpu_relaxation_qualification"] = None
    else:
        metadata["fem_gpu_relaxation_qualification"] = None
    root.mkdir(parents=True, exist_ok=True)
    (root / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    _write_table(root / "tables" / "relaxation" / "table.csv", dynamic=False)
    _write_table(root / "tables" / "default" / "table.csv", dynamic=True)
    for name in ("m_initial.json", "m_final.json"):
        (root / name).write_text(
            json.dumps({"observable": "m", "values": [[1.0, 0.0, 0.0]] * 4}),
            encoding="utf-8",
        )
    (root / "states").mkdir()
    (root / "states" / "relaxed_state.json").write_text(
        json.dumps({"format": "json", "kind": "magnetization_state", "values": [[1.0, 0.0, 0.0]] * 4}),
        encoding="utf-8",
    )


class FemFkSincLayerValidatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.validator = load_validator()

    def test_cpu_exact_fixture_passes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "cpu"
            _write_fixture(root, "cpu")
            report = self.validator.validate_lane(root, "cpu")
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["metrics"]["dynamic_steps"], 80000)
        self.assertEqual(report["metrics"]["bem_operator"]["operator_mode"], "hierarchical_h2")

    def test_gpu_host_operator_bit_is_not_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "gpu"
            _write_fixture(root, "gpu")
            metadata_path = root / "metadata.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            metadata["execution_provenance"]["fem_gpu_execution_receipt"]["executed_host_operator_mask"] = 1
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
            report = self.validator.validate_lane(root, "gpu")
        self.assertEqual(report["status"], "NOT VERIFIED")
        self.assertTrue(any("host operator" in item["detail"] for item in report["checks"] if item["status"] == "FAIL"))

    def test_missing_energy_column_is_not_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "cpu"
            _write_fixture(root, "cpu")
            table = root / "tables" / "default" / "table.csv"
            table.write_text(table.read_text(encoding="utf-8").replace(",E_dmi,", ","), encoding="utf-8")
            report = self.validator.validate_lane(root, "cpu")
        self.assertEqual(report["status"], "NOT VERIFIED")
        self.assertTrue(any("energy" in item["detail"].lower() for item in report["checks"] if item["status"] == "FAIL"))


if __name__ == "__main__":
    unittest.main()
