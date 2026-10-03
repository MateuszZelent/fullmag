"""Focused interpreted regressions for the serial/adaptive postsolve gate."""

from __future__ import annotations

import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
PYTHON_SOURCE_DIR = SCRIPT_DIR.parent / "packages" / "fullmag-py" / "src"
if str(PYTHON_SOURCE_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_SOURCE_DIR))

from test_de_smoke_parallel_probe import (  # noqa: E402
    PARALLEL_PROBE_VECTORS_RAD_PER_M,
    _metadata,
    _write_native_probe_artifacts,
)
from test_validate_parallel_execution_report import _adaptive_report  # noqa: E402
from validate_serial_adaptive_probe import (  # noqa: E402
    MANIFEST_RELATIVE_PATH,
    PILOT,
    REPORT_RELATIVE_PATH,
    ValidationError,
    validate_serial_adaptive_probe,
)


def _dynamic_probe() -> dict[str, object]:
    def direction() -> dict[str, object]:
        return {
            "attempted": True,
            "passed": True,
            "q_l2_norm": 1.0,
            "potential_relative_residual": 1e-12,
            "self_energy_j": 0.0,
            "potential_energy_j": 0.0,
            "energy_form_relative_defect": 0.0,
        }

    return {
        "schema_version": "floquet_dynamic_demag_operator_probe.v1",
        "status": "passed",
        "potential_equation": "P_phi_plus_A_phiq_q_equals_zero",
        "potential_coefficient_unit": "A",
        "energy_unit": "J",
        "relative_tolerance": 1e-8,
        "hermitian_relative_defect": 0.0,
        "global_y": direction(),
        "global_z": direction(),
    }


def _add_row_and_probe_evidence(case: Path, *, frequency_hz: float = 11.2e9) -> None:
    diagnostics_path = case / "eigen/diagnostics/solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text(encoding="utf-8"))
    for record in diagnostics["sample_solver_diagnostics"]:
        for subwindow_index, subwindow in enumerate(record["diagnostics"]["subwindows"]):
            subwindow["index"] = subwindow_index
            subwindow["dynamic_demag_operator_probe"] = _dynamic_probe()
    diagnostics_path.write_text(json.dumps(diagnostics), encoding="utf-8")

    spectrum_path = case / "eigen/spectrum.v3.json"
    spectrum = json.loads(spectrum_path.read_text(encoding="utf-8"))
    for sample in spectrum["samples"]:
        mode = sample["modes"][0]
        block = mode["block_residuals"]
        block["scope"] = "full_projected_weak_form_and_periodic_seams"
        block["eps_reduced"] = max(block["eps_q"], block["eps_phi"])
        block["eps_gauge"] = None
        block["reduced_pencil_certified"] = True
        block["full_descriptor_certified"] = True
        mode["potential_representation"] = "complex_coefficients"
        mode["gauge_constraint_policy"] = "nonzero_k_poisson_without_mean_constraint"
        mode["gauge_constraint_backward_error"] = None
        mode["floquet_full_magnetic_relative_residual"] = block["floquet_full_magnetic_relative_residual"]
        mode["floquet_full_potential_relative_residual"] = block["floquet_full_potential_relative_residual"]
        mode["magnetic_relative_residual"] = block["eps_q"]
        mode["potential_relative_residual"] = block["eps_phi"]
        for seam_name in (
            "floquet_scalar_phase_seam_relative_residual",
            "floquet_tangent_frame_seam_relative_residual",
            "floquet_cartesian_magnetic_seam_relative_residual",
            "floquet_equilibrium_pair_relative_residual",
        ):
            mode[seam_name] = block[seam_name]
        mode["poisson_boundary_kind"] = "poisson_dirichlet"
        mode["poisson_gauge_policy"] = "none"
        mode["frequency_hz"] = frequency_hz
    spectrum_path.write_text(json.dumps(spectrum), encoding="utf-8")
    rows = [
        "sample_index,raw_mode_index,branch_id,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,frequency_hz,residual_norm"
    ]
    for sample_index, vector in enumerate(PARALLEL_PROBE_VECTORS_RAD_PER_M):
        rows.append(
            f"{sample_index},0,0,{vector[0]},{vector[1]},{vector[2]},{frequency_hz},1e-10"
        )
    (case / "eigen/dispersion.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")


def _write_manifest(case: Path, *, mesh: str = "c" * 64) -> None:
    case.joinpath("frequency_domain").mkdir(parents=True, exist_ok=True)
    (case / "frequency_domain/manifest.v1.json").write_text(json.dumps({
        "schema_version": "frequency_domain_manifest.v1",
        "study_product": "modal_eigen",
        "stage_kind": "eigenmodes",
        "mesh_identity": "sha256:" + mesh,
        "operator_input_signature_sha256": "sha256:" + "d" * 64,
        "periodic_mesh_certificate_sha256": "sha256:" + "e" * 64,
        "equilibrium_artifact_sha256": "sha256:" + "e" * 64,
        "linearization_state_sha256": "sha256:" + "c" * 64,
    }), encoding="utf-8")


def _request_and_result(
    root: Path,
    *,
    mode: str,
    model_hash: str,
    job_id: str,
    report_hash: str | None = None,
    status: str = "completed_unqualified",
    return_code: int = 0,
) -> None:
    policy = {
        "mode": mode,
        "max_cpu_percent": 90.0,
        "max_memory_percent": 80.0,
        "memory_reserve_bytes": 1024**3,
        "max_workers": 2,
        "threads_per_worker": 1,
    }
    model_source = {
        "kind": "pinned_parallel_probe_input",
        "source_commit": "6cf0b786dc688e6a6993f7273df96dcb50727b1b",
        "path": "serial-adaptive-probe-v1/model-input.py",
        "sha256": model_hash,
        "manifest_path": "serial-adaptive-probe-v1/input/input-manifest.json",
        "manifest_sha256": "f" * 64,
        "equilibrium_artifact_sha256": "e" * 64,
        "equilibrium_artifact_role": "solver_consumed",
        "linearization_state_sha256": "c" * 64,
        "linearization_state_role": "reference_provenance_only_not_consumed_by_solver",
        "parallel_mode": mode,
        "policy": policy,
        "required_cpu_cores": 4,
        "required_memory_bytes": 8 * 1024**3,
    }
    probe = {
        "schema": "fullmag.parallel-probe-request.v1",
        "mode": mode,
        "model_source_commit": model_source["source_commit"],
        "model_sha256": model_hash,
        "policy": policy,
        "required_cpu_cores": 4,
        "required_memory_bytes": 8 * 1024**3,
        "input_manifest_sha256": "f" * 64,
        "equilibrium_artifact_sha256": "e" * 64,
        "equilibrium_artifact_role": "solver_consumed",
        "linearization_state_sha256": "c" * 64,
        "linearization_state_role": "reference_provenance_only_not_consumed_by_solver",
    }
    shared_source = {
        "capsule_id": "fullmag-runtime-v2",
        "source_snapshot_sha256": "d" * 64,
    }
    shared_runtime = {
        "profile": "fem-cpu-slepc-runtime-v2",
        "image_digest": "sha256:" + "a" * 64,
        "backend": "fem-cpu",
        "precision": "double",
    }
    shared_job = {
        "job_id": job_id,
        "profile": "fem-cpu-slepc-runtime-v2",
        "source_digest": "b" * 64,
        "worktree_id": "eigensolve-dispersion-plan-20260912",
    }
    request = {
        "schema": "fullmag.de-smoke.request.v1",
        "pilot": PILOT,
        "operation": PILOT + "-numerical-pilot",
        "public_model": "de-smoke-parallel-probe",
        "cases": [PILOT],
        "sampling": "parallel-probe",
        "model_sha256": model_hash,
        "orchestrator_sha256": "a" * 64,
        "parallel_probe": probe,
        "model_source": model_source,
        "job": shared_job,
        "source": shared_source,
        "runtime": shared_runtime,
    }
    artifacts: dict[str, object] = {}
    if report_hash is not None:
        artifacts["required_artifact_hashes"] = {
            REPORT_RELATIVE_PATH: {"sha256": report_hash}
        }
    result = {
        "schema": "fullmag.de-smoke.result.v1",
        "pilot": PILOT,
        "status": status,
        "qualification": "NOT VERIFIED",
        "job": shared_job,
        "source": shared_source,
        "runtime": shared_runtime,
        "model_sha256": model_hash,
        "return_code": return_code,
        "artifacts": artifacts,
        "parallel_probe": probe,
        "model_source": model_source,
    }
    root.mkdir(parents=True, exist_ok=True)
    (root / "run-request.json").write_text(json.dumps(request), encoding="utf-8")
    (root / "run-result.json").write_text(json.dumps(result), encoding="utf-8")


def _make_batches(tmp: Path, *, adaptive_frequency_hz: float = 11.2e9):
    serial_root = tmp / "serial"
    adaptive_root = tmp / "adaptive"
    metadata, source_hash = _metadata("serial")
    metadata["problem_meta"]["runtime_metadata"]["de_smoke"]["eigen_solver_rtol"] = 1e-9
    adaptive_metadata = copy.deepcopy(metadata)
    adaptive_metadata["problem_meta"]["runtime_metadata"]["model_builder"]["problem"]["runtime"]["parallel_execution"]["mode"] = "adaptive"
    serial_case = serial_root / PILOT
    adaptive_case = adaptive_root / PILOT
    for case, mode, case_metadata, frequency in (
        (serial_case, "serial", metadata, 11.2e9),
        (adaptive_case, "adaptive", adaptive_metadata, adaptive_frequency_hz),
    ):
        _write_native_probe_artifacts(case)
        _add_row_and_probe_evidence(case, frequency_hz=frequency)
        _write_manifest(case)
        (case / "metadata.json").write_text(json.dumps(case_metadata), encoding="utf-8")

    report = _adaptive_report()["report"]
    report = copy.deepcopy(report)
    for input_item in report["inputs"]:
        input_item["equilibrium_artifact_sha256"] = "sha256:" + "e" * 64
    report_bytes = (json.dumps(report, separators=(",", ":")) + "\n").encode("utf-8")
    (adaptive_case / REPORT_RELATIVE_PATH).parent.mkdir(parents=True, exist_ok=True)
    (adaptive_case / REPORT_RELATIVE_PATH).write_bytes(report_bytes)
    _request_and_result(
        serial_root,
        mode="serial",
        model_hash=source_hash,
        job_id="s" * 32,
    )
    _request_and_result(
        adaptive_root,
        mode="adaptive",
        model_hash=source_hash,
        job_id="a" * 32,
        report_hash=hashlib.sha256(report_bytes).hexdigest(),
    )
    return serial_root, adaptive_root


class SerialAdaptiveProbeTests(unittest.TestCase):
    def test_passes_parity_with_optional_serial_report_absent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            result = validate_serial_adaptive_probe(serial, adaptive)
            self.assertEqual(result["status"], "pass")
            self.assertEqual(result["qualification"], "NOT VERIFIED")
            self.assertEqual(result["numeric_parity"]["status"], "pass")
            self.assertEqual(result["concurrency"]["status"], "observed_from_active_count")
            self.assertFalse(result["structural_report"]["serial_process_pool_report"]["present"])
            self.assertEqual(result["science"]["status"], "NOT VERIFIED")

    def test_receipt_must_be_completed_unqualified_zero(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            result_path = serial / "run-result.json"
            result = json.loads(result_path.read_text(encoding="utf-8"))
            result["status"] = "failed"
            result["return_code"] = 7
            result_path.write_text(json.dumps(result), encoding="utf-8")
            with self.assertRaisesRegex(ValidationError, "completed_unqualified"):
                validate_serial_adaptive_probe(serial, adaptive)

    def test_frequency_difference_fails_parity_without_relaxing_row_preflight(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory), adaptive_frequency_hz=11.2002e9)
            result = validate_serial_adaptive_probe(serial, adaptive)
            self.assertEqual(result["status"], "not_verified")
            self.assertEqual(result["numeric_parity"]["status"], "not_verified")
            self.assertGreater(result["numeric_parity"]["max_frequency_difference_hz"], 1e5)

    def test_missing_adaptive_report_is_explicitly_not_verified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            report_path = adaptive / PILOT / REPORT_RELATIVE_PATH
            report_path.unlink()
            result_path = adaptive / "run-result.json"
            result = json.loads(result_path.read_text(encoding="utf-8"))
            result["artifacts"] = {}
            result_path.write_text(json.dumps(result), encoding="utf-8")
            result = validate_serial_adaptive_probe(serial, adaptive)
            adaptive_report = result["structural_report"]["adaptive_process_pool_report"]
            self.assertFalse(adaptive_report["present"])
            self.assertEqual(adaptive_report["status"], "not_verified")
            self.assertEqual(result["status"], "not_verified")

    def test_adaptive_report_without_receipt_hash_is_not_verified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            result_path = adaptive / "run-result.json"
            result = json.loads(result_path.read_text(encoding="utf-8"))
            result["artifacts"] = {}
            result_path.write_text(json.dumps(result), encoding="utf-8")
            result = validate_serial_adaptive_probe(serial, adaptive)
            adaptive_report = result["structural_report"]["adaptive_process_pool_report"]
            self.assertTrue(adaptive_report["present"])
            self.assertEqual(adaptive_report["status"], "not_verified")
            self.assertIn("required_artifact_hashes", adaptive_report["reason"])
            self.assertEqual(result["status"], "not_verified")

    def test_mesh_identity_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            manifest_path = adaptive / PILOT / MANIFEST_RELATIVE_PATH
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["mesh_identity"] = "sha256:" + "a" * 64
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValidationError, "mesh or operator identity"):
                validate_serial_adaptive_probe(serial, adaptive)

    def test_physical_residual_above_one_e_minus_eight_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            spectrum_path = adaptive / PILOT / "eigen/spectrum.v3.json"
            spectrum = json.loads(spectrum_path.read_text(encoding="utf-8"))
            for sample in spectrum["samples"]:
                mode = sample["modes"][0]
                mode["residual_relative_l2"] = 2e-8
                mode["block_residuals"]["floquet_full_magnetic_relative_residual"] = 2e-8
            spectrum_path.write_text(json.dumps(spectrum), encoding="utf-8")
            with self.assertRaisesRegex(ValidationError, "physical residual"):
                validate_serial_adaptive_probe(serial, adaptive)

    def test_phase_mismatch_in_second_sample_fails_parity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            path = adaptive / PILOT / "eigen/spectrum.v3.json"
            spectrum = json.loads(path.read_text(encoding="utf-8"))
            spectrum["samples"][1]["modes"][0]["phase_constraint_sha256"] = "sha256:" + "f" * 64
            path.write_text(json.dumps(spectrum), encoding="utf-8")
            with self.assertRaisesRegex(ValidationError, "phase_constraints_by_sample"):
                validate_serial_adaptive_probe(serial, adaptive)

    def test_report_hash_is_bound_to_completed_adaptive_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            report_path = adaptive / PILOT / REPORT_RELATIVE_PATH
            report_path.write_bytes(report_path.read_bytes() + b"\n")
            with self.assertRaisesRegex(ValidationError, "report hash"):
                validate_serial_adaptive_probe(serial, adaptive)


if __name__ == "__main__":
    unittest.main()
