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
from managed_runtime_artifact_root import (  # noqa: E402
    CONTAINER_ROOT,
    resolve_runtime_artifact_root,
)
from validate_serial_adaptive_probe import (  # noqa: E402
    EvidenceUnavailable,
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
        mode["equilibrium_artifact_sha256"] = "sha256:a76db36f38ab8b3398fb6dcc061e236f08ae1b16dc6b888c1a073aca851cc850"
        mode["linearization_state_sha256"] = "sha256:" + str(sample["sample_index"] + 1) * 64
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
        "equilibrium_artifact_sha256": "sha256:" + "a76db36f38ab8b3398fb6dcc061e236f08ae1b16dc6b888c1a073aca851cc850",
        "linearization_state_sha256": "sha256:" + "1" * 64,
    }), encoding="utf-8")


def _nest_managed_case(root: Path, *, mode: str, model_hash: str, job_id: str) -> Path:
    run_id = f"{mode}-{job_id[:8]}"
    session_id = f"{mode}-session"
    case_dir = root / PILOT
    workspace = root / f"{PILOT}-{run_id}-0"
    artifact_dir = workspace / "artifacts"
    workspace.mkdir(parents=True)
    case_dir.rename(artifact_dir)

    metadata_path = artifact_dir / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["source_hash"] = model_hash
    metadata["problem_meta"]["runtime_metadata"]["producer_run_id"] = run_id
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    container_workspace = f"{CONTAINER_ROOT}/{workspace.name}"
    (workspace / "fullmag-run.json").write_text(json.dumps({
        "schema": "fullmag.run_manifest.v1",
        "status": "completed",
        "exit_code": 0,
        "source": {"sha256": model_hash},
        "run_id": run_id,
        "session_id": session_id,
        "outputs": [{"path": "artifacts/metadata.json", "kind": "metadata"}],
    }), encoding="utf-8")
    (workspace / "output-storage.json").write_text(json.dumps({
        "schema": "fullmag.output_storage.resolved.v1",
        "state": "succeeded",
        "resolved": {"output_dir": container_workspace, "run_id": run_id},
    }), encoding="utf-8")
    summary = {
        "status": "completed",
        "backend": "fem",
        "mode": "strict",
        "precision": "double",
        "workspace_dir": container_workspace,
        "artifact_dir": container_workspace + "/artifacts",
        "run_id": run_id,
        "session_id": session_id,
    }
    (root / PILOT).mkdir()
    (root / PILOT / "runtime.log").write_text(
        "[solver] progress\n" + json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    return artifact_dir


def _artifact_dir(root: Path) -> Path:
    result = json.loads((root / "run-result.json").read_text(encoding="utf-8"))
    return Path(result["runtime_output_binding"]["artifact_dir"])


def _bind_semantic_fault(root: Path, artifact: Path) -> None:
    """Model an honestly receipted bad payload to exercise semantic checks."""
    path = root / "run-result.json"
    result = json.loads(path.read_text(encoding="utf-8"))
    payload = artifact.read_bytes()
    relative = artifact.relative_to(_artifact_dir(root)).as_posix()
    result["artifacts"]["required_artifact_hashes"][relative] = {
        "sha256": hashlib.sha256(payload).hexdigest(), "size": len(payload)
    }
    path.write_text(json.dumps(result), encoding="utf-8")


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
        "equilibrium_artifact_sha256": "ce9d630b90234933cce60304b5564f543304d587680d08e5793e114be1f655d1",
        "equilibrium_artifact_content_sha256": "sha256:a76db36f38ab8b3398fb6dcc061e236f08ae1b16dc6b888c1a073aca851cc850",
        "equilibrium_artifact_role": "solver_consumed",
        "linearization_state_sha256": "c0e5bb847a17b5da0f43b1c0a7ba3303028be44f3dcd926cd3e7e620f242864e",
        "linearization_state_content_sha256": "sha256:b036435669ac317b84410b3e20516ccb91f52064081f20ba44650d1f68ed641e",
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
        "equilibrium_artifact_sha256": "ce9d630b90234933cce60304b5564f543304d587680d08e5793e114be1f655d1",
        "equilibrium_artifact_content_sha256": "sha256:a76db36f38ab8b3398fb6dcc061e236f08ae1b16dc6b888c1a073aca851cc850",
        "equilibrium_artifact_role": "solver_consumed",
        "linearization_state_sha256": "c0e5bb847a17b5da0f43b1c0a7ba3303028be44f3dcd926cd3e7e620f242864e",
        "linearization_state_content_sha256": "sha256:b036435669ac317b84410b3e20516ccb91f52064081f20ba44650d1f68ed641e",
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
    _, result["runtime_output_binding"] = resolve_runtime_artifact_root(
        root, PILOT, model_hash
    )
    artifact_root = Path(result["runtime_output_binding"]["artifact_dir"])
    hashes = artifacts.setdefault("required_artifact_hashes", {})
    for path in artifact_root.rglob("*"):
        if path.is_file():
            payload = path.read_bytes()
            entry = hashes.setdefault(path.relative_to(artifact_root).as_posix(), {
                "sha256": hashlib.sha256(payload).hexdigest()
            })
            entry.setdefault("size", len(payload))

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
        input_item["equilibrium_artifact_sha256"] = "sha256:a76db36f38ab8b3398fb6dcc061e236f08ae1b16dc6b888c1a073aca851cc850"
    report_bytes = (json.dumps(report, separators=(",", ":")) + "\n").encode("utf-8")
    (adaptive_case / REPORT_RELATIVE_PATH).parent.mkdir(parents=True, exist_ok=True)
    (adaptive_case / REPORT_RELATIVE_PATH).write_bytes(report_bytes)
    _nest_managed_case(
        serial_root, mode="serial", model_hash=source_hash, job_id="s" * 32
    )
    _nest_managed_case(
        adaptive_root, mode="adaptive", model_hash=source_hash, job_id="a" * 32
    )
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
            serial_binding = json.loads((serial / "run-result.json").read_text(encoding="utf-8"))["runtime_output_binding"]
            self.assertEqual(Path(serial_binding["artifact_dir"]), _artifact_dir(serial))
            self.assertNotEqual(Path(serial_binding["artifact_dir"]), serial / PILOT)
            self.assertFalse(result["structural_report"]["serial_process_pool_report"]["present"])
            self.assertEqual(result["science"]["status"], "NOT VERIFIED")

    def test_every_declared_artifact_is_bound_even_when_both_modes_match(self) -> None:
        paths = ("metadata.json", "eigen/diagnostics/solver.v1.json", "eigen/dispersion.csv",
                 "eigen/spectrum.v3.json", MANIFEST_RELATIVE_PATH)
        for relative in paths:
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                serial, adaptive = _make_batches(Path(directory))
                for root in (serial, adaptive):
                    path = _artifact_dir(root) / relative
                    path.write_bytes(path.read_bytes() + b" ")
                # Metadata also binds the managed output location; that earlier
                # integrity gate rejects it before the numeric catalog is read.
                rejection = ("runtime_output_binding differs" if relative == "metadata.json"
                             else "receipt-bound artifact failed")
                with self.assertRaisesRegex(ValidationError, rejection):
                    validate_serial_adaptive_probe(serial, adaptive)

    def test_missing_numeric_artifact_binding_is_not_verified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            path = serial / "run-result.json"
            result = json.loads(path.read_text(encoding="utf-8"))
            del result["artifacts"]["required_artifact_hashes"]["eigen/spectrum.v3.json"]
            path.write_text(json.dumps(result), encoding="utf-8")
            report = validate_serial_adaptive_probe(serial, adaptive)
            self.assertEqual(report["status"], "not_verified")
            self.assertIn("omits", report["structural_report"]["reason"])

    def test_missing_runtime_output_binding_is_not_verified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            result_path = adaptive / "run-result.json"
            result_receipt = json.loads(result_path.read_text(encoding="utf-8"))
            result_receipt.pop("runtime_output_binding")
            result_path.write_text(json.dumps(result_receipt), encoding="utf-8")

            result = validate_serial_adaptive_probe(serial, adaptive)
            self.assertEqual(result["status"], "not_verified")
            self.assertIn("missing runtime_output_binding", result["structural_report"]["reason"])

    def test_tampered_runtime_output_binding_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            result_path = adaptive / "run-result.json"
            result_receipt = json.loads(result_path.read_text(encoding="utf-8"))
            result_receipt["runtime_output_binding"]["metadata_sha256"] = "0" * 64
            result_path.write_text(json.dumps(result_receipt), encoding="utf-8")

            with self.assertRaisesRegex(ValidationError, "runtime_output_binding differs"):
                validate_serial_adaptive_probe(serial, adaptive)

    def test_missing_content_identity_is_unavailable_without_raw_hash_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            for root in (serial, adaptive):
                for name in ("run-request.json", "run-result.json"):
                    path = root / name
                    value = json.loads(path.read_text())
                    for owner in ("parallel_probe", "model_source"):
                        value[owner].pop("equilibrium_artifact_content_sha256")
                    path.write_text(json.dumps(value))
            with self.assertRaisesRegex(EvidenceUnavailable, "content_sha256"):
                validate_serial_adaptive_probe(serial, adaptive)

    def test_raw_and_content_receipt_bindings_reject_independent_mutations(self) -> None:
        for key in ("equilibrium_artifact_sha256", "equilibrium_artifact_content_sha256",
                    "linearization_state_sha256", "linearization_state_content_sha256"):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                serial, adaptive = _make_batches(Path(directory))
                for name in ("run-request.json", "run-result.json"):
                    path = adaptive / name
                    value = json.loads(path.read_text())
                    value["model_source"][key] = "f" * 64
                    path.write_text(json.dumps(value))
                with self.assertRaisesRegex(ValidationError, "model_source and parallel_probe"):
                    validate_serial_adaptive_probe(serial, adaptive)

    def test_native_manifest_raw_hash_substitution_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            path = _artifact_dir(adaptive) / MANIFEST_RELATIVE_PATH
            value = json.loads(path.read_text())
            value["equilibrium_artifact_sha256"] = "sha256:ce9d630b90234933cce60304b5564f543304d587680d08e5793e114be1f655d1"
            path.write_text(json.dumps(value))
            _bind_semantic_fault(adaptive, path)
            with self.assertRaisesRegex(ValidationError, "manifest.equilibrium_artifact_sha256"):
                validate_serial_adaptive_probe(serial, adaptive)

    def test_second_sample_native_state_mutation_fails_parity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            path = _artifact_dir(adaptive) / "eigen/spectrum.v3.json"
            value = json.loads(path.read_text())
            value["samples"][1]["modes"][0]["linearization_state_sha256"] = "sha256:" + "f" * 64
            path.write_text(json.dumps(value))
            _bind_semantic_fault(adaptive, path)
            with self.assertRaisesRegex(ValidationError, "native_states_by_sample"):
                validate_serial_adaptive_probe(serial, adaptive)

    def test_missing_native_state_is_not_verified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            path = _artifact_dir(adaptive) / "eigen/spectrum.v3.json"
            value = json.loads(path.read_text())
            value["samples"][1]["modes"][0].pop("linearization_state_sha256")
            path.write_text(json.dumps(value))
            _bind_semantic_fault(adaptive, path)
            result = validate_serial_adaptive_probe(serial, adaptive)
            self.assertEqual(result["status"], "not_verified")
            self.assertIn("linearization_state_sha256", result["structural_report"]["reason"])

    def test_native_report_raw_hash_substitution_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            path = _artifact_dir(adaptive) / REPORT_RELATIVE_PATH
            value = json.loads(path.read_text())
            value["inputs"][0]["equilibrium_artifact_sha256"] = "sha256:ce9d630b90234933cce60304b5564f543304d587680d08e5793e114be1f655d1"
            path.write_text(json.dumps(value))
            _bind_semantic_fault(adaptive, path)
            with self.assertRaisesRegex(ValidationError, "different equilibrium"):
                validate_serial_adaptive_probe(serial, adaptive)

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
            report_path = _artifact_dir(adaptive) / REPORT_RELATIVE_PATH
            report_path.unlink()
            result_path = adaptive / "run-result.json"
            result = json.loads(result_path.read_text(encoding="utf-8"))
            result["artifacts"]["required_artifact_hashes"].pop(REPORT_RELATIVE_PATH)
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
            result["artifacts"]["required_artifact_hashes"].pop(REPORT_RELATIVE_PATH)
            result_path.write_text(json.dumps(result), encoding="utf-8")
            result = validate_serial_adaptive_probe(serial, adaptive)
            adaptive_report = result["structural_report"]["adaptive_process_pool_report"]
            self.assertTrue(adaptive_report["present"])
            self.assertEqual(adaptive_report["status"], "not_verified")
            self.assertIn("does not bind", adaptive_report["reason"])
            self.assertEqual(result["status"], "not_verified")

    def test_mesh_identity_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            manifest_path = _artifact_dir(adaptive) / MANIFEST_RELATIVE_PATH
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["mesh_identity"] = "sha256:" + "a" * 64
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            _bind_semantic_fault(adaptive, manifest_path)
            with self.assertRaisesRegex(ValidationError, "mesh or operator identity"):
                validate_serial_adaptive_probe(serial, adaptive)

    def test_physical_residual_above_one_e_minus_eight_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            spectrum_path = _artifact_dir(adaptive) / "eigen/spectrum.v3.json"
            spectrum = json.loads(spectrum_path.read_text(encoding="utf-8"))
            for sample in spectrum["samples"]:
                mode = sample["modes"][0]
                mode["residual_relative_l2"] = 2e-8
                mode["block_residuals"]["floquet_full_magnetic_relative_residual"] = 2e-8
            spectrum_path.write_text(json.dumps(spectrum), encoding="utf-8")
            _bind_semantic_fault(adaptive, spectrum_path)
            with self.assertRaisesRegex(ValidationError, "physical residual"):
                validate_serial_adaptive_probe(serial, adaptive)

    def test_phase_mismatch_in_second_sample_fails_parity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            path = _artifact_dir(adaptive) / "eigen/spectrum.v3.json"
            spectrum = json.loads(path.read_text(encoding="utf-8"))
            spectrum["samples"][1]["modes"][0]["phase_constraint_sha256"] = "sha256:" + "f" * 64
            path.write_text(json.dumps(spectrum), encoding="utf-8")
            _bind_semantic_fault(adaptive, path)
            with self.assertRaisesRegex(ValidationError, "phase_constraints_by_sample"):
                validate_serial_adaptive_probe(serial, adaptive)

    def test_report_hash_is_bound_to_completed_adaptive_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            serial, adaptive = _make_batches(Path(directory))
            report_path = _artifact_dir(adaptive) / REPORT_RELATIVE_PATH
            report_path.write_bytes(report_path.read_bytes() + b"\n")
            with self.assertRaisesRegex(ValidationError, "report hash"):
                validate_serial_adaptive_probe(serial, adaptive)


if __name__ == "__main__":
    unittest.main()
