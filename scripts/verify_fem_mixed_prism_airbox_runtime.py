#!/usr/bin/env python3
"""Prepare and validate managed CPU/GPU mixed prism-airbox runtime evidence."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any


CANONICAL_MAX_STEPS = "max_steps=50_000"
BOUNDED_MAX_STEPS = "max_steps=1"
EXPECTED_PROBLEM_NAME = "mumag_sp4_fem_relax_projected_gradient_bb"
EXPECTED_ALGORITHM = "projected_gradient_bb"
RUN_SCHEMA_VERSION = "fem_mixed_prism_airbox_runtime_run.v2"
COMPARISON_SCHEMA_VERSION = "fem_mixed_prism_airbox_cpu_gpu.v1"
TOPOLOGY_FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")

# Frozen existing Fullmag FEM CPU/GPU contracts. Do not tune these from this
# workload's observed output.
STATE_MAX_COMPONENT_ATOL = 1.0e-9
ENERGY_RTOL = 1.0e-6
ENERGY_ATOL_J = 1.0e-30
TORQUE_RTOL = 1.0e-6
TORQUE_ATOL_APM = 1.0e-9
TORQUE_ATOL_T = 1.0e-15
GPU_PGBB_CONTROL_READBACK_BASE = 3
GPU_PGBB_CONTROL_READBACK_PER_STEP = 4
GPU_SCALAR_RESULT_SLOTS = 32
DOUBLE_BYTES = 8
TOLERANCE_SOURCE = {
    "state": "scripts/analysis/fem_gpu_benchmark.py:TASK11_CPU_GPU_MAGNETIZATION_ATOL",
    "energy_torque": "scripts/analysis/fem_gpu_benchmark.py:DEFAULT_CPU_GPU_*",
    "gpu_control_readback": "scripts/analysis/fem_gpu_benchmark.py:DEFAULT_GPU_PGBB_CONTROL_READBACK_PER_STEP",
}


class ContractError(ValueError):
    """Raised when bounded runtime evidence is absent, stale, or malformed."""


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    try:
        return _sha256_bytes(path.read_bytes())
    except OSError as error:
        raise ContractError(f"cannot read required artifact {path}: {error}") from error


def _object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{label} must be an object")
    return value


def _finite(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise ContractError(f"{label} must be a finite number")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ContractError(f"{label} must be a finite number") from error
    if not math.isfinite(result):
        raise ContractError(f"{label} must be finite")
    return result


def _nonnegative_int(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise ContractError(f"{label} must be a non-negative integer")
    if isinstance(value, int):
        result = value
    elif isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]*", value):
        result = int(value)
    else:
        raise ContractError(f"{label} must be a non-negative integer")
    if result < 0:
        raise ContractError(f"{label} must be a non-negative integer")
    return result


def _canonical_sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise ContractError(f"{label} must be a canonical SHA-256")
    return value


def _read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ContractError(f"cannot read {label} {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ContractError(f"{label} {path} is not valid JSON: {error}") from error
    return _object(value, label)


def prepare_bounded_scenario(source: Path, output: Path) -> dict[str, object]:
    try:
        source_bytes = source.read_bytes()
        source_text = source_bytes.decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise ContractError(f"cannot read canonical scenario {source}: {error}") from error
    replacement_count = source_text.count(CANONICAL_MAX_STEPS)
    if replacement_count != 1:
        raise ContractError(
            "canonical scenario must contain exactly one "
            f"{CANONICAL_MAX_STEPS!r}; found {replacement_count}"
        )
    bounded_text = source_text.replace(CANONICAL_MAX_STEPS, BOUNDED_MAX_STEPS, 1)
    bounded_bytes = bounded_text.encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(bounded_bytes)
    return {
        "schema_version": "fem_mixed_prism_airbox_runtime_source.v1",
        "canonical_source": str(source),
        "canonical_source_sha256": _sha256_bytes(source_bytes),
        "bounded_source_sha256": _sha256_bytes(bounded_bytes),
        "canonical_max_steps": 50_000,
        "bounded_max_steps": 1,
        "replacement_count": replacement_count,
    }


def _validate_source_identity(source: Path, bounded_source: Path) -> dict[str, object]:
    try:
        canonical_bytes = source.read_bytes()
        bounded_bytes = bounded_source.read_bytes()
        canonical_text = canonical_bytes.decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise ContractError(f"cannot read runtime source identity: {error}") from error
    if canonical_text.count(CANONICAL_MAX_STEPS) != 1:
        raise ContractError("canonical source no longer has exactly one authored max_steps=50_000")
    expected = canonical_text.replace(CANONICAL_MAX_STEPS, BOUNDED_MAX_STEPS, 1).encode(
        "utf-8"
    )
    if bounded_bytes != expected:
        raise ContractError("bounded source differs from the canonical source beyond max_steps=1")
    return {
        "canonical_source": str(source.resolve()),
        "canonical_source_sha256": _sha256_bytes(canonical_bytes),
        "bounded_source_sha256": _sha256_bytes(bounded_bytes),
    }


def _validate_runtime_manifest(path: Path) -> dict[str, object]:
    manifest = _read_json_object(path, "managed runtime manifest")
    if manifest.get("schema") != 2 or manifest.get("runtime") != "fem-gpu-host":
        raise ContractError("managed runtime manifest must be schema 2 fem-gpu-host")
    for field in ("variant", "created_at", "docker_image_id"):
        if not isinstance(manifest.get(field), str) or not manifest[field]:
            raise ContractError(f"managed runtime manifest {field} must be present")
    source_manifest_sha256 = _canonical_sha256(
        manifest.get("source_manifest_sha256"), "runtime source_manifest_sha256"
    )
    integrity = _object(manifest.get("integrity"), "runtime integrity")
    integrity_identity = {
        field: _canonical_sha256(integrity.get(field), f"runtime integrity.{field}")
        for field in ("launcher_sha256", "worker_sha256", "api_sha256")
    }
    native_libraries = _object(manifest.get("native_libraries"), "runtime native_libraries")
    fullmag_fem = _object(native_libraries.get("fullmag_fem"), "runtime fullmag_fem")
    fullmag_fem_sha256 = _canonical_sha256(
        fullmag_fem.get("sha256"), "runtime fullmag_fem.sha256"
    )
    diagnostics = _object(manifest.get("runtime_diagnostics"), "runtime diagnostics")
    device_identity: dict[str, object] = {}
    for field in ("device_name", "compute_capability", "cuda_driver_version"):
        value = diagnostics.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ContractError(f"runtime diagnostics {field} must be present")
        device_identity[field] = value
    resolved_manifest = path.resolve()
    return {
        "runtime_manifest_path": str(resolved_manifest),
        "runtime_bundle_path": str(resolved_manifest.parent),
        "runtime_bundle_name": resolved_manifest.parent.name,
        "runtime_manifest_sha256": _sha256_file(path),
        "runtime": manifest["runtime"],
        "variant": manifest["variant"],
        "created_at": manifest["created_at"],
        "docker_image_id": manifest["docker_image_id"],
        "source_manifest_sha256": source_manifest_sha256,
        "integrity": integrity_identity,
        "libfullmag_fem_sha256": fullmag_fem_sha256,
        "gpu_device_identity": device_identity,
    }


def _validate_scalar_artifact(path: Path) -> dict[str, object]:
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            required = {"step", "E_ex", "E_demag", "E_total", "max_torque_T"}
            missing = required - set(reader.fieldnames or ())
            if missing:
                raise ContractError(f"scalars.csv is missing columns {sorted(missing)}")
            rows = list(reader)
    except OSError as error:
        raise ContractError(f"cannot read scalar artifact {path}: {error}") from error
    if not rows:
        raise ContractError("scalars.csv must contain at least one row")
    for index, row in enumerate(rows):
        for field in ("E_ex", "E_demag", "E_total", "max_torque_T"):
            _finite(row.get(field), f"scalars.csv row {index} {field}")
    try:
        final_step = int(rows[-1]["step"])
    except (KeyError, TypeError, ValueError) as error:
        raise ContractError("scalars.csv final step must be an integer") from error
    if final_step != 1:
        raise ContractError(f"scalars.csv final step must be 1, got {final_step}")
    return {"scalar_rows": len(rows), "final_scalar_step": final_step}


def _validate_solver_steps(path: Path) -> dict[str, int]:
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            required = {"step", "rhs_evals", "rejected_attempts"}
            missing = required - set(reader.fieldnames or ())
            if missing:
                raise ContractError(f"solver_steps.csv is missing columns {sorted(missing)}")
            rows = list(reader)
    except OSError as error:
        raise ContractError(f"cannot read solver-step artifact {path}: {error}") from error
    if len(rows) != 1:
        raise ContractError(f"solver_steps.csv must contain exactly one accepted step, got {len(rows)}")
    step = _nonnegative_int(rows[0].get("step"), "solver_steps.csv step")
    if step != 1:
        raise ContractError(f"solver_steps.csv accepted step must be 1, got {step}")
    return {
        "accepted_steps": 1,
        "total_rhs_evals": _nonnegative_int(rows[0].get("rhs_evals"), "solver_steps.csv rhs_evals"),
        "rejected_attempts": _nonnegative_int(
            rows[0].get("rejected_attempts"), "solver_steps.csv rejected_attempts"
        ),
    }


def _validate_final_field(path: Path) -> list[list[float]]:
    field = _read_json_object(path, "final magnetization artifact")
    values = field.get("values")
    if not isinstance(values, list) or not values:
        raise ContractError("m_final.json values must be a non-empty array")
    result: list[list[float]] = []
    for index, vector in enumerate(values):
        if not isinstance(vector, list) or len(vector) != 3:
            raise ContractError(f"m_final.json values[{index}] must be a three-vector")
        result.append(
            [
                _finite(value, f"m_final.json values[{index}][{component}]")
                for component, value in enumerate(vector)
            ]
        )
    return result


def _validate_mixed_certificate(
    metadata: dict[str, Any], device: str
) -> tuple[str, dict[str, Any]]:
    mesh = _object(metadata.get("mesh"), "mesh metadata")
    topology_fingerprint = mesh.get("topology_fingerprint")
    if not isinstance(topology_fingerprint, str) or not TOPOLOGY_FINGERPRINT.fullmatch(
        topology_fingerprint
    ):
        raise ContractError("mesh topology_fingerprint must be canonical sha256 identity")
    report = _object(mesh.get("mesh_build_report"), "mesh build report")
    if report.get("fallbacks_triggered") != [] or report.get("degraded") is not False:
        raise ContractError("mesh build report must prove empty fallbacks and degraded=false")
    certificate = _object(
        report.get("mixed_layer_topology_certificate"),
        "mixed layer topology certificate",
    )
    expected_certificate = {
        "schema_version": "mixed_layer_topology_certificate.v1",
        "certificate_status": "accepted",
        "topology_fingerprint_version": "v3",
        "topology_fingerprint": topology_fingerprint,
        "fallbacks_triggered": [],
        "requested_layer_count": 1,
        "realized_layer_count": 1,
    }
    for key, expected in expected_certificate.items():
        if certificate.get(key) != expected:
            raise ContractError(f"mixed topology certificate {key} must be {expected!r}")
    planes = certificate.get("magnetic_plane_coordinates_m")
    if not isinstance(planes, list) or len(planes) != 2:
        raise ContractError("mixed topology certificate must contain exactly two planes")
    finite_planes = [
        _finite(value, f"mixed topology plane {index}")
        for index, value in enumerate(planes)
    ]
    if finite_planes[0] >= finite_planes[1]:
        raise ContractError("mixed topology planes must be strictly increasing")
    cell_counts = _object(
        certificate.get("cell_family_counts_by_part"),
        "mixed topology cell-family counts",
    )
    magnetic_counts = _object(cell_counts.get("magnetic"), "magnetic cell-family counts")
    if set(magnetic_counts) != {"prism6"}:
        raise ContractError("magnetic mixed-P1 cells must be prism6 only")
    if _nonnegative_int(magnetic_counts.get("prism6"), "magnetic prism6 count") < 1:
        raise ContractError("magnetic mixed-P1 mesh must contain at least one prism6 cell")

    mixed_provenance = _object(
        report.get("mixed_topology_provenance"), "mixed topology provenance"
    )
    expected_mixed = {
        "requested_topology": "mixed_p1",
        "resolved_topology": "mixed_p1",
        "accepted_certificate_fingerprint": topology_fingerprint,
        "requested_device": device,
        "precision": "double",
        "capability_status": "implemented",
    }
    for key, expected in expected_mixed.items():
        if mixed_provenance.get(key) != expected:
            raise ContractError(f"mixed topology provenance {key} must be {expected!r}")
    return topology_fingerprint, certificate


def _expected_control_sync_budget(steps: dict[str, int]) -> int:
    logical_rhs_trials = max(
        0,
        steps["total_rhs_evals"] - 2 * steps["accepted_steps"],
    )
    return (
        GPU_PGBB_CONTROL_READBACK_BASE
        + GPU_PGBB_CONTROL_READBACK_PER_STEP * steps["accepted_steps"]
        + logical_rhs_trials
    )


def _validate_gpu_execution(
    metadata: dict[str, Any],
    execution: dict[str, Any],
    qualification: dict[str, Any],
    runtime_identity: dict[str, object],
    steps: dict[str, int],
) -> dict[str, object]:
    manifest_device = _object(
        runtime_identity.get("gpu_device_identity"), "runtime GPU device identity"
    )
    for field in ("device_name", "compute_capability"):
        if execution.get(field) != manifest_device.get(field):
            raise ContractError(
                f"GPU execution {field} does not match the managed runtime manifest"
            )

    expected_execution = {
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
    }
    mfem_device = execution.get("mfem_device")
    if not isinstance(mfem_device, str) or not mfem_device.startswith("ceed-cuda:"):
        raise ContractError("GPU execution mfem_device must be a ceed-cuda device")
    for field, expected in expected_execution.items():
        if execution.get(field) != expected:
            raise ContractError(f"GPU execution {field} must be {expected!r}")

    device_policy = _object(qualification.get("device_policy"), "GPU device policy")
    policy_expected = {
        "execution_mode": "all_in_gpu_legacy_sparse",
        "data_residency": "device_source_of_truth",
        "exchange_operator_mode": "legacy_sparse_gpu",
        "demag_operator_mode": "device_hypre_poisson",
        "uses_cuda_kernels": True,
        "uses_gpu_poisson": True,
        "hot_loop_exchange_host_sync_count": 0,
        "hot_loop_compute_host_sync_count": 0,
    }
    for field, expected in policy_expected.items():
        if device_policy.get(field) != expected:
            raise ContractError(f"GPU device policy {field} must be {expected!r}")

    telemetry_fields = (
        "hot_loop_h2d_bytes",
        "hot_loop_d2h_bytes",
        "hot_loop_host_sync_count",
        "hot_loop_exchange_h2d_bytes",
        "hot_loop_exchange_d2h_bytes",
        "hot_loop_exchange_host_sync_count",
        "hot_loop_compute_h2d_bytes",
        "hot_loop_compute_d2h_bytes",
        "hot_loop_compute_host_sync_count",
        "hot_loop_control_scalar_d2h_bytes",
        "hot_loop_control_scalar_host_sync_count",
    )
    telemetry = {
        field: _nonnegative_int(execution.get(field), f"GPU execution {field}")
        for field in telemetry_fields
    }
    for scope in ("exchange", "compute"):
        for suffix in ("h2d_bytes", "d2h_bytes", "host_sync_count"):
            field = f"hot_loop_{scope}_{suffix}"
            if telemetry[field] != 0:
                raise ContractError(f"GPU scoped transfer telemetry {field} must be zero")
    if telemetry["hot_loop_h2d_bytes"] != 0:
        raise ContractError("GPU hot-loop H2D bytes must be zero")
    if telemetry["hot_loop_d2h_bytes"] != telemetry["hot_loop_control_scalar_d2h_bytes"]:
        raise ContractError("GPU D2H bytes must be control-scalar-only")
    if telemetry["hot_loop_host_sync_count"] != telemetry[
        "hot_loop_control_scalar_host_sync_count"
    ]:
        raise ContractError("GPU host syncs must be control-scalar-only")
    if device_policy.get("hot_loop_control_scalar_host_sync_count") != telemetry[
        "hot_loop_control_scalar_host_sync_count"
    ]:
        raise ContractError("GPU qualification and provenance control-sync counts differ")

    sync_budget = _expected_control_sync_budget(steps)
    control_syncs = telemetry["hot_loop_control_scalar_host_sync_count"]
    control_bytes = telemetry["hot_loop_control_scalar_d2h_bytes"]
    byte_budget = sync_budget * GPU_SCALAR_RESULT_SLOTS * DOUBLE_BYTES
    if control_syncs > sync_budget or control_bytes > byte_budget:
        raise ContractError(
            "GPU control-scalar readbacks exceed the bounded PGBB budget: "
            f"syncs={control_syncs}/{sync_budget}, bytes={control_bytes}/{byte_budget}"
        )
    if control_bytes % DOUBLE_BYTES != 0:
        raise ContractError("GPU control-scalar D2H bytes must contain complete doubles")
    if (control_syncs == 0) != (control_bytes == 0):
        raise ContractError("GPU control-scalar bytes and syncs must have matching zero state")

    demag_runtime = _object(metadata.get("demag_runtime"), "GPU demag runtime")
    if not str(demag_runtime.get("mfem_device", "")).startswith("ceed-cuda:"):
        raise ContractError("GPU demag runtime must use a ceed-cuda MFEM device")
    relative_tolerance = _finite(
        demag_runtime.get("relative_tolerance"), "GPU demag relative tolerance"
    )
    residual = _finite(
        demag_runtime.get("final_residual_norm"), "GPU demag final residual"
    )
    if not 0.0 < relative_tolerance <= 1.0e-12:
        raise ContractError("GPU demag relative tolerance must be in (0, 1e-12]")
    if residual < 0.0 or residual > relative_tolerance:
        raise ContractError("GPU demag final residual must satisfy the strict tolerance")
    iterations = _nonnegative_int(
        demag_runtime.get("actual_iterations"), "GPU demag actual iterations"
    )
    return {
        "raw": telemetry,
        "control_scalar_host_sync_count": control_syncs,
        "control_scalar_d2h_bytes": control_bytes,
        "allowed_control_scalar_host_sync_count": sync_budget,
        "allowed_control_scalar_d2h_bytes": byte_budget,
        "demag_actual_iterations": iterations,
        "demag_final_residual_norm": residual,
        "demag_relative_tolerance": relative_tolerance,
    }


def validate_runtime_artifacts(
    source: Path,
    bounded_source: Path,
    artifacts: Path,
    *,
    device: str,
    runtime_log: Path | None = None,
    runtime_manifest: Path | None = None,
) -> dict[str, object]:
    if device not in {"cpu", "gpu"}:
        raise ContractError("device must be cpu or gpu")
    if runtime_manifest is None:
        raise ContractError("managed runtime manifest is required")
    source_identity = _validate_source_identity(source, bounded_source)
    runtime_identity = _validate_runtime_manifest(runtime_manifest)
    metadata_path = artifacts / "metadata.json"
    scalars_path = artifacts / "scalars.csv"
    solver_steps_path = artifacts / "solver_steps.csv"
    final_field_path = artifacts / "m_final.json"
    metadata = _read_json_object(metadata_path, "runtime metadata")

    if metadata.get("problem_name") != EXPECTED_PROBLEM_NAME:
        raise ContractError(f"problem_name must be {EXPECTED_PROBLEM_NAME}")
    if metadata.get("source_hash") != source_identity["bounded_source_sha256"]:
        raise ContractError("runtime source_hash does not match the generated bounded source")
    if metadata.get("status") != "completed":
        raise ContractError("runtime metadata status must be completed")

    problem_meta = _object(metadata.get("problem_meta"), "problem_meta")
    runtime = _object(problem_meta.get("runtime_metadata"), "runtime_metadata")
    selection = _object(runtime.get("runtime_selection"), "runtime_selection")
    if selection.get("device") != "auto":
        raise ContractError("authored runtime_selection.device must remain auto")
    model_builder = _object(runtime.get("model_builder"), "model_builder")
    model_problem = _object(model_builder.get("problem"), "model_builder.problem")
    model_runtime = _object(model_problem.get("runtime"), "model_builder.problem.runtime")
    if model_runtime.get("device") != "auto":
        raise ContractError("authored model-builder runtime device must remain auto")
    override = _object(runtime.get("runtime_device_override"), "runtime_device_override")
    expected_override = {"device": device, "source": "managed_launcher"}
    if override != expected_override:
        raise ContractError(
            f"managed runtime device override must equal {expected_override}"
        )

    requested = _object(metadata.get("requested_execution"), "requested_execution")
    expected_requested = {
        "backend": "fem",
        "device": device,
        "precision": "double",
        "mode": "strict",
        "fallback_policy": "forbidden",
    }
    if requested != expected_requested:
        raise ContractError(f"requested_execution must equal {expected_requested}")

    execution = _object(metadata.get("execution_provenance"), "execution_provenance")
    engine = "fem_cpu_native" if device == "cpu" else "fem_native_gpu"
    if execution.get("execution_engine") != engine:
        raise ContractError(f"resolved execution engine must be {engine}")
    if execution.get("precision") != "double":
        raise ContractError("resolved execution precision must be double")
    if execution.get("lossy_fallback_used") is not False:
        raise ContractError("lossy_fallback_used must be explicitly false")
    if execution.get("resolved_fallback") is not None:
        raise ContractError("resolved_fallback must be absent")
    if execution.get("ignored_terms") != []:
        raise ContractError("ignored_terms must be exactly empty")

    topology_fingerprint, certificate = _validate_mixed_certificate(metadata, device)
    qualification_key = f"fem_{device}_relaxation_qualification"
    qualification = _object(
        metadata.get(qualification_key),
        f"FEM {device.upper()} relaxation qualification",
    )
    expected_qualification_schema = f"fem_{device}_relaxation_qualification.v1"
    if qualification.get("schema_version") != expected_qualification_schema:
        raise ContractError(
            f"FEM {device.upper()} relaxation qualification schema is not v1"
        )
    if qualification.get("relaxation_algorithm") != EXPECTED_ALGORITHM:
        raise ContractError(f"relaxation algorithm must be {EXPECTED_ALGORITHM}")
    if qualification.get("executed_steps") != 1:
        raise ContractError("FEM relaxation qualification executed_steps must be 1")
    energy_terms = _object(
        qualification.get("final_energy_terms_j"), "final energy terms"
    )
    for name in ("E_ex", "E_demag", "E_ext", "e_drive", "E_ani", "E_dmi", "E_total"):
        _finite(energy_terms.get(name), f"final_energy_terms_j.{name}")
    final_torque_apm = _finite(
        qualification.get("final_torque_apm"), "final_torque_apm"
    )
    final_torque_t = _finite(
        qualification.get("final_torque_t"), "final_torque_t"
    )
    norm_defect = _finite(qualification.get("norm_defect"), "norm_defect")

    scalar_evidence = _validate_scalar_artifact(scalars_path)
    solver_step_evidence = _validate_solver_steps(solver_steps_path)
    final_field_vectors = _validate_final_field(final_field_path)
    if runtime_log is None:
        raise ContractError("runtime log is required")
    try:
        runtime_text = runtime_log.read_text(encoding="utf-8")
    except OSError as error:
        raise ContractError(f"cannot read runtime log {runtime_log}: {error}") from error
    expected_log_proof = f"resolved_engine_id={engine} fallback=None"
    if expected_log_proof not in runtime_text:
        raise ContractError(f"runtime log does not prove {engine} with fallback=None")

    gpu_transfer_telemetry = None
    if device == "gpu":
        gpu_transfer_telemetry = _validate_gpu_execution(
            metadata,
            execution,
            qualification,
            runtime_identity,
            solver_step_evidence,
        )

    return {
        "schema_version": RUN_SCHEMA_VERSION,
        "qualification_status": "implemented",
        **source_identity,
        **runtime_identity,
        "metadata_sha256": _sha256_file(metadata_path),
        "scalars_sha256": _sha256_file(scalars_path),
        "solver_steps_sha256": _sha256_file(solver_steps_path),
        "m_final_sha256": _sha256_file(final_field_path),
        "runtime_log_sha256": _sha256_file(runtime_log),
        "topology_fingerprint": topology_fingerprint,
        "certificate_fingerprint": certificate["topology_fingerprint"],
        "topology_fingerprint_version": certificate["topology_fingerprint_version"],
        "fallbacks_triggered": [],
        "degraded": False,
        "authored_device": "auto",
        "managed_override": override,
        "effective_device": device,
        "execution_engine": engine,
        "executed_steps": 1,
        "final_energy_terms_j": energy_terms,
        "final_torque_apm": final_torque_apm,
        "final_torque_t": final_torque_t,
        "norm_defect": norm_defect,
        "final_magnetization": final_field_vectors,
        "gpu_transfer_telemetry": gpu_transfer_telemetry,
        **scalar_evidence,
        **solver_step_evidence,
    }


def _close_comparison(
    name: str,
    cpu_value: object,
    gpu_value: object,
    *,
    relative_tolerance: float,
    absolute_tolerance: float,
    unit: str,
) -> dict[str, object]:
    cpu = _finite(cpu_value, f"CPU {name}")
    gpu = _finite(gpu_value, f"GPU {name}")
    absolute_delta = abs(cpu - gpu)
    allowed_delta = absolute_tolerance + relative_tolerance * max(abs(cpu), abs(gpu))
    if absolute_delta > allowed_delta:
        raise ContractError(
            f"CPU/GPU {name} parity failed: delta={absolute_delta}, allowed={allowed_delta}"
        )
    return {
        "name": name,
        "unit": unit,
        "cpu": cpu,
        "gpu": gpu,
        "absolute_delta": absolute_delta,
        "relative_tolerance": relative_tolerance,
        "absolute_tolerance": absolute_tolerance,
        "allowed_delta": allowed_delta,
        "status": "pass",
    }


def compare_runtime_summaries(
    cpu: dict[str, object], gpu: dict[str, object]
) -> dict[str, object]:
    exact_fields = (
        "runtime_manifest_sha256",
        "runtime_bundle_path",
        "runtime_bundle_name",
        "source_manifest_sha256",
        "libfullmag_fem_sha256",
        "canonical_source",
        "canonical_source_sha256",
        "bounded_source_sha256",
        "topology_fingerprint",
        "certificate_fingerprint",
        "topology_fingerprint_version",
        "executed_steps",
        "accepted_steps",
    )
    for field in exact_fields:
        if cpu.get(field) != gpu.get(field):
            raise ContractError(f"CPU/GPU exact identity mismatch for {field}")
    if cpu.get("execution_engine") != "fem_cpu_native":
        raise ContractError("CPU summary does not prove fem_cpu_native")
    if gpu.get("execution_engine") != "fem_native_gpu":
        raise ContractError("GPU summary does not prove fem_native_gpu")
    if cpu.get("effective_device") != "cpu" or gpu.get("effective_device") != "gpu":
        raise ContractError("CPU/GPU summaries do not prove distinct strict devices")

    cpu_vectors = cpu.get("final_magnetization")
    gpu_vectors = gpu.get("final_magnetization")
    if not isinstance(cpu_vectors, list) or not isinstance(gpu_vectors, list):
        raise ContractError("CPU/GPU final magnetization arrays are required")
    if len(cpu_vectors) != len(gpu_vectors) or not cpu_vectors:
        raise ContractError("CPU/GPU final magnetization shapes differ")
    component_deltas: list[float] = []
    for index, (cpu_vector, gpu_vector) in enumerate(zip(cpu_vectors, gpu_vectors)):
        if not isinstance(cpu_vector, list) or not isinstance(gpu_vector, list):
            raise ContractError(f"CPU/GPU magnetization vector {index} is malformed")
        if len(cpu_vector) != 3 or len(gpu_vector) != 3:
            raise ContractError(f"CPU/GPU magnetization vector {index} is not a three-vector")
        component_deltas.extend(
            abs(
                _finite(cpu_value, f"CPU m[{index}][{component}]")
                - _finite(gpu_value, f"GPU m[{index}][{component}]")
            )
            for component, (cpu_value, gpu_value) in enumerate(zip(cpu_vector, gpu_vector))
        )
    max_component_delta = max(component_deltas)
    rms_component_delta = math.sqrt(
        sum(delta * delta for delta in component_deltas) / len(component_deltas)
    )
    if max_component_delta > STATE_MAX_COMPONENT_ATOL:
        raise ContractError(
            "CPU/GPU final magnetization parity failed: "
            f"max component delta={max_component_delta}"
        )
    state_parity = {
        "component_count": len(component_deltas),
        "max_component_abs_delta": max_component_delta,
        "rms_component_abs_delta": rms_component_delta,
        "max_component_absolute_tolerance": STATE_MAX_COMPONENT_ATOL,
        "status": "pass",
    }

    cpu_energies = _object(cpu.get("final_energy_terms_j"), "CPU final energy terms")
    gpu_energies = _object(gpu.get("final_energy_terms_j"), "GPU final energy terms")
    comparisons = [
        _close_comparison(
            name,
            cpu_energies.get(name),
            gpu_energies.get(name),
            relative_tolerance=ENERGY_RTOL,
            absolute_tolerance=ENERGY_ATOL_J,
            unit="J",
        )
        for name in ("E_ex", "E_demag", "E_total")
    ]
    comparisons.extend(
        (
            _close_comparison(
                "final_torque_apm",
                cpu.get("final_torque_apm"),
                gpu.get("final_torque_apm"),
                relative_tolerance=TORQUE_RTOL,
                absolute_tolerance=TORQUE_ATOL_APM,
                unit="A/m",
            ),
            _close_comparison(
                "final_torque_t",
                cpu.get("final_torque_t"),
                gpu.get("final_torque_t"),
                relative_tolerance=TORQUE_RTOL,
                absolute_tolerance=TORQUE_ATOL_T,
                unit="T",
            ),
        )
    )
    artifact_hashes = {
        device: {
            field: summary.get(field)
            for field in (
                "metadata_sha256",
                "scalars_sha256",
                "solver_steps_sha256",
                "m_final_sha256",
                "runtime_log_sha256",
            )
        }
        for device, summary in (("cpu", cpu), ("gpu", gpu))
    }
    return {
        "schema_version": COMPARISON_SCHEMA_VERSION,
        "status": "pass",
        "qualification_status": "implemented",
        "runtime_manifest_sha256": cpu["runtime_manifest_sha256"],
        "runtime_bundle_path": cpu["runtime_bundle_path"],
        "runtime_bundle_name": cpu["runtime_bundle_name"],
        "source_manifest_sha256": cpu["source_manifest_sha256"],
        "libfullmag_fem_sha256": cpu["libfullmag_fem_sha256"],
        "canonical_source": cpu["canonical_source"],
        "canonical_source_sha256": cpu["canonical_source_sha256"],
        "bounded_source_sha256": cpu["bounded_source_sha256"],
        "topology_fingerprint": cpu["topology_fingerprint"],
        "certificate_fingerprint": cpu["certificate_fingerprint"],
        "topology_fingerprint_version": cpu["topology_fingerprint_version"],
        "gpu_device_identity": gpu["gpu_device_identity"],
        "artifact_hashes": artifact_hashes,
        "state_parity": state_parity,
        "comparisons": comparisons,
        "tolerance_source": TOLERANCE_SOURCE,
        "cpu": {
            "execution_engine": cpu["execution_engine"],
            "final_energy_terms_j": cpu["final_energy_terms_j"],
            "final_torque_apm": cpu["final_torque_apm"],
            "final_torque_t": cpu["final_torque_t"],
        },
        "gpu": {
            "execution_engine": gpu["execution_engine"],
            "final_energy_terms_j": gpu["final_energy_terms_j"],
            "final_torque_apm": gpu["final_torque_apm"],
            "final_torque_t": gpu["final_torque_t"],
            "transfer_telemetry": gpu["gpu_transfer_telemetry"],
        },
    }


def write_comparison_csv(path: Path, comparison: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state = _object(comparison.get("state_parity"), "state parity")
    rows = [
        {
            "quantity": "m_max_component_abs_delta",
            "unit": "1",
            "cpu": "",
            "gpu": "",
            "absolute_delta": state["max_component_abs_delta"],
            "allowed_delta": state["max_component_absolute_tolerance"],
            "status": state["status"],
        },
        {
            "quantity": "m_rms_component_abs_delta",
            "unit": "1",
            "cpu": "",
            "gpu": "",
            "absolute_delta": state["rms_component_abs_delta"],
            "allowed_delta": state["max_component_absolute_tolerance"],
            "status": state["status"],
        },
    ]
    comparisons = comparison.get("comparisons")
    if not isinstance(comparisons, list):
        raise ContractError("comparison rows are required")
    rows.extend(
        {
            "quantity": row["name"],
            "unit": row["unit"],
            "cpu": row["cpu"],
            "gpu": row["gpu"],
            "absolute_delta": row["absolute_delta"],
            "allowed_delta": row["allowed_delta"],
            "status": row["status"],
        }
        for raw_row in comparisons
        for row in (_object(raw_row, "comparison row"),)
    )
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(
            stream,
            fieldnames=(
                "quantity",
                "unit",
                "cpu",
                "gpu",
                "absolute_delta",
                "allowed_delta",
                "status",
            ),
        )
        writer.writeheader()
        writer.writerows(rows)


def _write_json(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("source", type=Path)
    prepare.add_argument("output", type=Path)
    prepare.add_argument("--evidence", type=Path)

    validate = subparsers.add_parser("validate")
    validate.add_argument("source", type=Path)
    validate.add_argument("bounded_source", type=Path)
    validate.add_argument("artifacts", type=Path)
    validate.add_argument("--device", choices=("cpu", "gpu"), required=True)
    validate.add_argument("--runtime-log", type=Path, required=True)
    validate.add_argument("--runtime-manifest", type=Path, required=True)
    validate.add_argument("--output", type=Path, required=True)

    compare = subparsers.add_parser("compare")
    compare.add_argument("--cpu-summary", type=Path, required=True)
    compare.add_argument("--gpu-summary", type=Path, required=True)
    compare.add_argument("--runtime-manifest", type=Path, required=True)
    compare.add_argument("--output", type=Path, required=True)
    compare.add_argument("--csv-output", type=Path, required=True)

    args = parser.parse_args()
    try:
        if args.command == "prepare":
            evidence = prepare_bounded_scenario(args.source, args.output)
            if args.evidence is not None:
                _write_json(args.evidence, evidence)
            else:
                print(json.dumps(evidence, sort_keys=True))
        elif args.command == "validate":
            summary = validate_runtime_artifacts(
                args.source,
                args.bounded_source,
                args.artifacts,
                device=args.device,
                runtime_log=args.runtime_log,
                runtime_manifest=args.runtime_manifest,
            )
            _write_json(args.output, summary)
        else:
            cpu_summary = _read_json_object(args.cpu_summary, "CPU runtime summary")
            gpu_summary = _read_json_object(args.gpu_summary, "GPU runtime summary")
            active_runtime = _validate_runtime_manifest(args.runtime_manifest)
            active_hash = active_runtime["runtime_manifest_sha256"]
            if cpu_summary.get("runtime_manifest_sha256") != active_hash:
                raise ContractError("CPU summary runtime bundle is no longer active")
            if gpu_summary.get("runtime_manifest_sha256") != active_hash:
                raise ContractError("GPU summary runtime bundle is no longer active")
            comparison = compare_runtime_summaries(cpu_summary, gpu_summary)
            _write_json(args.output, comparison)
            write_comparison_csv(args.csv_output, comparison)
    except ContractError as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
