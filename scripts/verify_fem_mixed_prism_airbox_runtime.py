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
import struct
import sys
from typing import Any


CANONICAL_MAX_STEPS = "max_steps=50_000"
BOUNDED_MAX_STEPS = "max_steps=1"
EXPECTED_PROBLEM_NAME = "mumag_sp4_fem_relax_projected_gradient_bb"
EXPECTED_ALGORITHM = "projected_gradient_bb"
RUN_SCHEMA_VERSION = "fem_mixed_prism_airbox_runtime_run.v4"
COMPARISON_SCHEMA_VERSION = "fem_mixed_prism_airbox_cpu_gpu.v3"
STEP0_OPERATOR_SCHEMA_VERSION = "fem_mixed_step0_operator_artifacts.v1"
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
STEP0_FIELD_TOLERANCES = {
    "H_ex": {"rtol": 5.0e-8, "atol_apm": 1.0e-6},
    "H_demag": {"rtol": 5.0e-8, "atol_apm": 1.0e-6},
    "H_eff": {"rtol": 5.0e-8, "atol_apm": 1.0e-6},
}
STEP0_FIELD_OBSERVABLES = tuple(STEP0_FIELD_TOLERANCES)
GPU_PGBB_CONTROL_READBACK_BASE = 3
GPU_PGBB_CONTROL_READBACK_PER_STEP = 4
GPU_SCALAR_RESULT_SLOTS = 32
DOUBLE_BYTES = 8
DIMENSIONLESS_RECOMPUTATION_ATOL = 16.0 * sys.float_info.epsilon
MAX_MAGNETIZATION_NORM_DEFECT = 1.0e-9
SCALAR_CSV_SERIALIZATION_RTOL = 1.0e-15
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


def _strict_bool(value: object, label: str) -> bool:
    if value is True or value == "true":
        return True
    if value is False or value == "false":
        return False
    raise ContractError(f"{label} must be true or false")


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
            required = {
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
            }
            missing = required - set(reader.fieldnames or ())
            if missing:
                raise ContractError(f"scalars.csv is missing columns {sorted(missing)}")
            rows = list(reader)
    except OSError as error:
        raise ContractError(f"cannot read scalar artifact {path}: {error}") from error
    if len(rows) != 2:
        raise ContractError(
            f"scalars.csv must contain exactly step-0 and step-1 rows, got {len(rows)}"
        )
    steps = [
        _nonnegative_int(row.get("step"), f"scalars.csv row {index} step")
        for index, row in enumerate(rows)
    ]
    if steps != [0, 1]:
        raise ContractError(f"scalars.csv steps must equal [0, 1], got {steps}")
    scalar_fields = (
        "E_ex",
        "E_demag",
        "E_ext",
        "E_ani",
        "E_dmi",
        "E_total",
        "max_torque_Apm",
        "max_torque_T",
    )
    row_values: list[dict[str, float]] = []
    for index, row in enumerate(rows):
        row_values.append(
            {
                field: _finite(row.get(field), f"scalars.csv row {index} {field}")
                for field in scalar_fields
            }
        )
    step0_time = _finite(rows[0].get("time"), "scalars.csv step-0 time")
    step0_solver_dt = _finite(
        rows[0].get("solver_dt"), "scalars.csv step-0 solver_dt"
    )
    if step0_time != 0.0 or step0_solver_dt != 0.0:
        raise ContractError("scalars.csv step-0 time and solver_dt must both be zero")
    for field in ("E_ext", "E_ani", "E_dmi"):
        if row_values[0][field] != 0.0:
            raise ContractError(f"scalars.csv step-0 inactive {field} must be zero")
    return {
        "scalar_rows": 2,
        "scalar_steps": steps,
        "initial_scalar_step": 0,
        "initial_scalar_values": row_values[0],
        "initial_scalar_time_s": step0_time,
        "initial_scalar_solver_dt_s": step0_solver_dt,
        "final_scalar_step": 1,
        "final_scalar_values": row_values[1],
    }


def _validate_step0_field_artifact(
    artifacts: Path,
    observable: str,
    *,
    expected_source_hash: str,
    expected_engine: str,
    expected_node_count: int,
) -> dict[str, object]:
    relative_path = Path("fields") / f"{observable}.zarr"
    store = artifacts / relative_path
    attrs_path = store / ".zattrs"
    array_path = store / ".zarray"
    samples_path = store / "samples.csv"
    attrs = _read_json_object(attrs_path, f"{observable} Zarr attributes")
    expected_attrs = {
        "observable": observable,
        "unit": "A/m",
        "axes": ["sample", "component", "cell"],
        "component_order": ["x", "y", "z"],
        "storage_layout": "soa_component_major",
        "sample_index_file": "samples.csv",
    }
    for key, expected in expected_attrs.items():
        if attrs.get(key) != expected:
            raise ContractError(f"{observable} Zarr attribute {key} must be {expected!r}")
    provenance = _object(attrs.get("provenance"), f"{observable} Zarr provenance")
    expected_provenance = {
        "problem_name": EXPECTED_PROBLEM_NAME,
        "source_hash": expected_source_hash,
        "execution_mode": "strict",
        "execution_engine": expected_engine,
        "precision": "double",
    }
    for key, expected in expected_provenance.items():
        if provenance.get(key) != expected:
            raise ContractError(
                f"{observable} Zarr provenance {key} must be {expected!r}"
            )

    array = _read_json_object(array_path, f"{observable} Zarr array metadata")
    expected_array = {
        "zarr_format": 2,
        "shape": [2, 3, expected_node_count],
        "chunks": [1, 3, expected_node_count],
        "dtype": "<f8",
        "compressor": None,
        "order": "C",
        "filters": None,
        "dimension_separator": ".",
    }
    for key, expected in expected_array.items():
        if array.get(key) != expected:
            raise ContractError(
                f"{observable} Zarr array metadata {key} must be {expected!r}"
            )

    try:
        with samples_path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            required = {
                "sample",
                "step",
                "time",
                "solver_dt",
                "chunk_key",
                "dtype",
                "scalar_bytes",
                "cell_count",
            }
            missing = required - set(reader.fieldnames or ())
            if missing:
                raise ContractError(
                    f"{observable} samples.csv is missing columns {sorted(missing)}"
                )
            rows = list(reader)
    except OSError as error:
        raise ContractError(
            f"cannot read {observable} sample index {samples_path}: {error}"
        ) from error
    if len(rows) != 2:
        raise ContractError(f"{observable} samples.csv must contain exactly two rows")
    for sample, (row, expected_step) in enumerate(zip(rows, (0, 1))):
        if _nonnegative_int(row.get("sample"), f"{observable} sample index") != sample:
            raise ContractError(f"{observable} sample indices must equal [0, 1]")
        if _nonnegative_int(row.get("step"), f"{observable} sample step") != expected_step:
            raise ContractError(f"{observable} sample steps must equal [0, 1]")
        if row.get("chunk_key") != f"{sample}.0.0":
            raise ContractError(f"{observable} sample chunk key is invalid")
        if row.get("dtype") != "<f8":
            raise ContractError(f"{observable} sample dtype must be <f8")
        if _nonnegative_int(row.get("scalar_bytes"), f"{observable} scalar bytes") != 8:
            raise ContractError(f"{observable} sample scalar_bytes must be 8")
        if _nonnegative_int(row.get("cell_count"), f"{observable} cell count") != expected_node_count:
            raise ContractError(
                f"{observable} sample cell_count must equal mesh.node_count"
            )
        time_s = _finite(row.get("time"), f"{observable} sample time")
        solver_dt_s = _finite(row.get("solver_dt"), f"{observable} sample solver_dt")
        if sample == 0 and (time_s != 0.0 or solver_dt_s != 0.0):
            raise ContractError(
                f"{observable} step-0 sample time and solver_dt must both be zero"
            )

    expected_payload_bytes = 3 * expected_node_count * DOUBLE_BYTES
    chunk_hashes: dict[str, str] = {}
    for chunk_key in ("0.0.0", "1.0.0"):
        chunk_path = store / chunk_key
        try:
            payload = chunk_path.read_bytes()
        except OSError as error:
            raise ContractError(
                f"cannot read {observable} Zarr chunk {chunk_path}: {error}"
            ) from error
        if len(payload) != expected_payload_bytes:
            raise ContractError(
                f"{observable} Zarr chunk {chunk_key} has {len(payload)} bytes; "
                f"expected {expected_payload_bytes}"
            )
        values = struct.unpack(f"<{3 * expected_node_count}d", payload)
        if not all(math.isfinite(value) for value in values):
            raise ContractError(f"{observable} Zarr chunk {chunk_key} is non-finite")
        chunk_hashes[chunk_key] = _sha256_bytes(payload)

    return {
        "relative_path": relative_path.as_posix(),
        "unit": "A/m",
        "node_count": expected_node_count,
        "component_count": 3,
        "dtype": "<f8",
        "attrs_sha256": _sha256_file(attrs_path),
        "array_sha256": _sha256_file(array_path),
        "samples_sha256": _sha256_file(samples_path),
        "step0_chunk_key": "0.0.0",
        "step0_chunk_sha256": chunk_hashes["0.0.0"],
        "final_chunk_key": "1.0.0",
        "final_chunk_sha256": chunk_hashes["1.0.0"],
    }


def _validate_step0_operator_artifacts(
    artifacts: Path,
    *,
    expected_source_hash: str,
    expected_engine: str,
    expected_node_count: int,
    initial_state_sha256: str,
    topology_fingerprint: str,
    magnetic_node_indices: set[int],
    scalar_evidence: dict[str, object],
) -> dict[str, object]:
    fields_dir = artifacts / "fields"
    try:
        stores = sorted(path.name for path in fields_dir.iterdir() if path.is_dir())
    except OSError as error:
        raise ContractError(f"cannot read required operator fields {fields_dir}: {error}") from error
    expected_stores = sorted(f"{name}.zarr" for name in STEP0_FIELD_OBSERVABLES)
    if stores != expected_stores:
        raise ContractError(
            f"operator field stores must equal {expected_stores}, got {stores}"
        )
    fields = {
        observable: _validate_step0_field_artifact(
            artifacts,
            observable,
            expected_source_hash=expected_source_hash,
            expected_engine=expected_engine,
            expected_node_count=expected_node_count,
        )
        for observable in STEP0_FIELD_OBSERVABLES
    }
    initial_values = _object(
        scalar_evidence.get("initial_scalar_values"), "initial scalar values"
    )
    magnetic_nodes = sorted(magnetic_node_indices)
    magnetic_nodes_sha256 = _sha256_bytes(
        json.dumps(magnetic_nodes, separators=(",", ":")).encode("utf-8")
    )
    return {
        "schema_version": STEP0_OPERATOR_SCHEMA_VERSION,
        "step": 0,
        "time_s": scalar_evidence["initial_scalar_time_s"],
        "solver_dt_s": scalar_evidence["initial_scalar_solver_dt_s"],
        "initial_state_sha256": initial_state_sha256,
        "topology_fingerprint": topology_fingerprint,
        "magnetic_node_count": len(magnetic_nodes),
        "magnetic_node_indices_sha256": magnetic_nodes_sha256,
        "fields": fields,
        "energy_terms_j": {
            name: initial_values[name] for name in ("E_ex", "E_demag", "E_total")
        },
        "max_torque_apm": initial_values["max_torque_Apm"],
        "max_torque_t": initial_values["max_torque_T"],
        "scalar_source": {"relative_path": "scalars.csv", "row_index": 0},
    }


def _validate_solver_steps(path: Path) -> dict[str, Any]:
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            required = {
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
            }
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
    demag_residual = _finite(
        rows[0].get("demag_residual"), "solver_steps.csv demag_residual"
    )
    if demag_residual < 0.0:
        raise ContractError("solver_steps.csv demag_residual must be non-negative")
    if not _strict_bool(
        rows[0].get("accepted_energy_proof_available"),
        "solver_steps.csv accepted_energy_proof_available",
    ):
        raise ContractError("accepted energy proof must be available for the accepted PG-BB step")
    energy_delta = _finite(
        rows[0].get("accepted_energy_delta_j"),
        "solver_steps.csv accepted_energy_delta_j",
    )
    roundoff_bound = _finite(
        rows[0].get("accepted_energy_roundoff_bound_j"),
        "solver_steps.csv accepted_energy_roundoff_bound_j",
    )
    delta_upper = _finite(
        rows[0].get("accepted_energy_delta_upper_j"),
        "solver_steps.csv accepted_energy_delta_upper_j",
    )
    armijo_rhs = _finite(
        rows[0].get("armijo_increment_rhs_j"),
        "solver_steps.csv armijo_increment_rhs_j",
    )
    if roundoff_bound < 0.0:
        raise ContractError("accepted energy proof roundoff bound must be non-negative")
    if energy_delta + roundoff_bound != delta_upper:
        raise ContractError(
            "accepted energy proof upper endpoint must equal delta plus roundoff bound"
        )
    if not (delta_upper <= armijo_rhs < 0.0):
        raise ContractError(
            "accepted Armijo proof must satisfy delta_upper <= armijo_rhs < 0"
        )
    return {
        "accepted_steps": 1,
        "total_rhs_evals": _nonnegative_int(rows[0].get("rhs_evals"), "solver_steps.csv rhs_evals"),
        "rejected_attempts": _nonnegative_int(
            rows[0].get("rejected_attempts"), "solver_steps.csv rejected_attempts"
        ),
        "demag_solves": _nonnegative_int(
            rows[0].get("demag_solves"), "solver_steps.csv demag_solves"
        ),
        "demag_iterations": _nonnegative_int(
            rows[0].get("demag_iterations"), "solver_steps.csv demag_iterations"
        ),
        "demag_residual": demag_residual,
        "accepted_energy_proof": {
            "available": True,
            "delta_j": energy_delta,
            "roundoff_bound_j": roundoff_bound,
            "delta_upper_j": delta_upper,
            "armijo_rhs_j": armijo_rhs,
            "strict_armijo": True,
            "energy_nonincrease": True,
        },
    }


def _magnetic_node_indices(metadata: dict[str, Any], node_count: int) -> set[int]:
    execution_plan = _object(metadata.get("execution_plan"), "execution_plan")
    backend_plan = _object(
        execution_plan.get("backend_plan"), "execution_plan.backend_plan"
    )
    mesh_parts = backend_plan.get("mesh_parts")
    if not isinstance(mesh_parts, list):
        raise ContractError("execution_plan.backend_plan.mesh_parts must be an array")
    magnetic_nodes: set[int] = set()
    for part_index, raw_part in enumerate(mesh_parts):
        part = _object(raw_part, f"mesh_parts[{part_index}]")
        if part.get("role") != "magnetic_object":
            continue
        raw_indices = part.get("node_indices", [])
        if not isinstance(raw_indices, list):
            raise ContractError(f"mesh_parts[{part_index}].node_indices must be an array")
        explicit_indices: list[int] = []
        for index, raw_node in enumerate(raw_indices):
            if isinstance(raw_node, bool) or not isinstance(raw_node, int) or raw_node < 0:
                raise ContractError(
                    f"mesh_parts[{part_index}].node_indices[{index}] "
                    "must be a non-negative integer"
                )
            explicit_indices.append(raw_node)
        if explicit_indices:
            magnetic_nodes.update(
                index for index in explicit_indices if index < node_count
            )
            continue
        selector = _object(
            part.get("node_selector"), f"mesh_parts[{part_index}].node_selector"
        )
        if selector.get("kind") != "node_range":
            continue
        start = selector.get("start")
        count = selector.get("count")
        for field, value in (("start", start), ("count", count)):
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ContractError(
                    f"mesh_parts[{part_index}].node_selector.{field} "
                    "must be a non-negative integer"
                )
        magnetic_nodes.update(range(start, min(start + count, node_count)))
    if not magnetic_nodes:
        return set(range(node_count))
    return magnetic_nodes


def _validate_final_field(
    path: Path,
    *,
    expected_step: int,
    expected_source_hash: str,
    expected_engine: str,
    expected_precision: str,
    expected_node_count: int,
    magnetic_node_indices: set[int],
) -> tuple[list[list[float]], float]:
    field = _read_json_object(path, "final magnetization artifact")
    if field.get("observable") != "m":
        raise ContractError("m_final.json observable must be m")
    if field.get("unit") != "dimensionless":
        raise ContractError("m_final.json unit must be dimensionless")
    step = _nonnegative_int(field.get("step"), "m_final.json step")
    if step != expected_step:
        raise ContractError(
            f"m_final.json step must match executed step {expected_step}, got {step}"
        )
    provenance = _object(field.get("provenance"), "m_final.json provenance")
    expected_provenance = {
        "source_hash": expected_source_hash,
        "execution_engine": expected_engine,
        "precision": expected_precision,
    }
    for key, expected in expected_provenance.items():
        if provenance.get(key) != expected:
            raise ContractError(f"m_final.json provenance {key} must be {expected!r}")
    values = field.get("values")
    if not isinstance(values, list) or len(values) != expected_node_count:
        raise ContractError(
            "m_final.json vector count must match mesh.node_count "
            f"{expected_node_count}"
        )
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
    norm_defect = max(
        abs(math.sqrt(sum(component * component for component in vector)) - 1.0)
        for index, vector in enumerate(result)
        if index in magnetic_node_indices
    )
    return result, norm_defect


def _validate_initial_field(
    path: Path,
    *,
    expected_source_hash: str,
    expected_engine: str,
    expected_precision: str,
    expected_node_count: int,
    magnetic_node_indices: set[int],
) -> tuple[list[list[float]], float, str]:
    values, norm_defect = _validate_final_field(
        path,
        expected_step=0,
        expected_source_hash=expected_source_hash,
        expected_engine=expected_engine,
        expected_precision=expected_precision,
        expected_node_count=expected_node_count,
        magnetic_node_indices=magnetic_node_indices,
    )
    if norm_defect > MAX_MAGNETIZATION_NORM_DEFECT:
        raise ContractError(
            "m_initial.json norm_defect exceeds the frozen bound: "
            f"{norm_defect} > {MAX_MAGNETIZATION_NORM_DEFECT}"
        )
    canonical_values = json.dumps(
        values,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return values, norm_defect, _sha256_bytes(canonical_values)


def _validate_gradient_policy(
    qualification: dict[str, Any], device: str
) -> dict[str, str]:
    policy = _object(qualification.get("algorithm_policy"), "algorithm_policy")
    if policy.get("metric") != "mu0_ms_fem_lumped_volume":
        raise ContractError(
            "PG-BB gradient policy metric must be mu0_ms_fem_lumped_volume"
        )
    if device == "cpu":
        expected = {
            "realization": "native_mfem_pgbb",
            "gradient_policy": "exchange_plus_mass_tangent_gradient",
        }
        observed = {
            "realization": policy.get("realization"),
            "gradient_policy": policy.get("preconditioner"),
        }
    else:
        expected = {
            "realization": "native_cuda_pgbb",
            "gradient_policy": "device_tangent_gradient",
        }
        observed = {
            "realization": policy.get("realization"),
            "gradient_policy": policy.get("gradient_policy"),
        }
    if observed != expected:
        raise ContractError(
            f"{device.upper()} PG-BB gradient policy must equal {expected}, got {observed}"
        )
    return {**expected, "metric": "mu0_ms_fem_lumped_volume"}


def _validate_cpu_execution(execution: dict[str, Any]) -> dict[str, object]:
    expected = {
        "mfem_device": "cpu",
        "fem_execution_mode": "cpu_native",
        "fem_data_residency": "host_source_of_truth",
        "uses_cuda_kernels": False,
        "uses_gpu_poisson": False,
    }
    for field, value in expected.items():
        if execution.get(field) != value:
            raise ContractError(f"CPU execution {field} must be {value!r}")
    return expected


def _validate_persisted_lane_summary(
    summary: dict[str, object], device: str
) -> dict[str, object]:
    if summary.get("schema_version") != RUN_SCHEMA_VERSION:
        raise ContractError(f"{device.upper()} summary schema is not {RUN_SCHEMA_VERSION}")
    if summary.get("effective_device") != device:
        raise ContractError(f"{device.upper()} summary effective device is invalid")
    if summary.get("fallbacks_triggered") != [] or summary.get("degraded") is not False:
        raise ContractError(f"{device.upper()} summary must prove no fallback or degradation")
    if summary.get("qualification_status") != "implemented":
        raise ContractError(f"{device.upper()} summary qualification status is invalid")
    if summary.get("accepted_steps") != 1 or summary.get("executed_steps") != 1:
        raise ContractError(f"{device.upper()} summary must prove one accepted executed step")

    for field in ("initial_norm_defect", "norm_defect"):
        defect = _finite(summary.get(field), f"{device} summary {field}")
        if defect < 0.0 or defect > MAX_MAGNETIZATION_NORM_DEFECT:
            raise ContractError(
                f"{device.upper()} summary {field} exceeds the frozen norm bound"
            )

    proof = _object(
        summary.get("accepted_energy_proof"),
        f"{device} summary accepted energy proof",
    )
    if proof.get("available") is not True:
        raise ContractError(f"{device.upper()} accepted energy proof must be available")
    if proof.get("strict_armijo") is not True or proof.get("energy_nonincrease") is not True:
        raise ContractError(f"{device.upper()} accepted Armijo predicates must be true")
    delta = _finite(proof.get("delta_j"), f"{device} accepted energy delta")
    roundoff = _finite(
        proof.get("roundoff_bound_j"), f"{device} accepted energy roundoff bound"
    )
    upper = _finite(
        proof.get("delta_upper_j"), f"{device} accepted energy upper endpoint"
    )
    armijo_rhs = _finite(proof.get("armijo_rhs_j"), f"{device} Armijo RHS")
    if roundoff < 0.0 or delta + roundoff != upper:
        raise ContractError(f"{device.upper()} accepted energy proof arithmetic is invalid")
    if not (upper <= armijo_rhs < 0.0):
        raise ContractError(f"{device.upper()} accepted Armijo proof is invalid")
    normalized_proof = {
        "available": True,
        "delta_j": delta,
        "roundoff_bound_j": roundoff,
        "delta_upper_j": upper,
        "armijo_rhs_j": armijo_rhs,
        "strict_armijo": True,
        "energy_nonincrease": True,
    }

    residency = _object(summary.get("residency"), f"{device} summary residency")
    if device == "cpu":
        normalized_residency = _validate_cpu_execution(residency)
    else:
        if residency.get("mode") != "device_source_of_truth":
            raise ContractError("GPU summary must preserve device source-of-truth residency")
        telemetry = _object(
            residency.get("transfer_telemetry"), "GPU summary transfer telemetry"
        )
        if telemetry != summary.get("gpu_transfer_telemetry"):
            raise ContractError("GPU summary residency telemetry identity is invalid")
        raw = _object(telemetry.get("raw"), "GPU summary raw transfer telemetry")
        for field in (
            "hot_loop_compute_h2d_bytes",
            "hot_loop_compute_d2h_bytes",
            "hot_loop_compute_host_sync_count",
            "hot_loop_exchange_h2d_bytes",
            "hot_loop_exchange_d2h_bytes",
            "hot_loop_exchange_host_sync_count",
        ):
            if _nonnegative_int(raw.get(field), f"GPU summary {field}") != 0:
                raise ContractError(f"GPU summary {field} must be zero")
        control_syncs = _nonnegative_int(
            raw.get("hot_loop_control_scalar_host_sync_count"),
            "GPU summary control scalar host sync count",
        )
        control_bytes = _nonnegative_int(
            raw.get("hot_loop_control_scalar_d2h_bytes"),
            "GPU summary control scalar D2H bytes",
        )
        total_syncs = _nonnegative_int(
            raw.get("hot_loop_host_sync_count"),
            "GPU summary total host sync count",
        )
        if total_syncs != control_syncs:
            raise ContractError("GPU summary host syncs must be control-scalar-only")
        if control_syncs != _nonnegative_int(
            telemetry.get("control_scalar_host_sync_count"),
            "GPU summary control scalar host sync total",
        ) or control_bytes != _nonnegative_int(
            telemetry.get("control_scalar_d2h_bytes"),
            "GPU summary control scalar D2H total",
        ):
            raise ContractError("GPU summary control scalar telemetry is inconsistent")
        sync_budget = _expected_control_sync_budget(
            {
                "accepted_steps": summary["accepted_steps"],
                "total_rhs_evals": _nonnegative_int(
                    summary.get("total_rhs_evals"),
                    "GPU summary total RHS evaluations",
                ),
            }
        )
        byte_budget = sync_budget * GPU_SCALAR_RESULT_SLOTS * DOUBLE_BYTES
        if _nonnegative_int(
            telemetry.get("allowed_control_scalar_host_sync_count"),
            "GPU summary allowed control scalar sync count",
        ) != sync_budget or _nonnegative_int(
            telemetry.get("allowed_control_scalar_d2h_bytes"),
            "GPU summary allowed control scalar D2H bytes",
        ) != byte_budget:
            raise ContractError("GPU summary control-scalar budget is not reproducible")
        if control_syncs > sync_budget or control_bytes > byte_budget:
            raise ContractError("GPU summary exceeds the bounded control-scalar budget")
        if control_bytes % DOUBLE_BYTES != 0:
            raise ContractError("GPU summary control-scalar bytes must contain complete doubles")
        if (control_syncs == 0) != (control_bytes == 0):
            raise ContractError("GPU summary control-scalar bytes and syncs disagree")
        normalized_residency = {
            "mode": "device_source_of_truth",
            "transfer_telemetry": telemetry,
        }

    return {
        "accepted_energy_proof": normalized_proof,
        "norm_defect": summary["norm_defect"],
        "residency": normalized_residency,
    }


def _cross_check_final_scalars(
    scalar_evidence: dict[str, object],
    energy_terms: dict[str, Any],
    final_torque_t: float,
) -> None:
    values = _object(scalar_evidence.get("final_scalar_values"), "final scalar values")
    expected = {
        "E_ex": _finite(energy_terms.get("E_ex"), "final_energy_terms_j.E_ex"),
        "E_demag": _finite(
            energy_terms.get("E_demag"), "final_energy_terms_j.E_demag"
        ),
        "E_total": _finite(
            energy_terms.get("E_total"), "final_energy_terms_j.E_total"
        ),
        "max_torque_T": final_torque_t,
    }
    for field, expected_value in expected.items():
        observed_value = _finite(values.get(field), f"scalars.csv final {field}")
        absolute_delta = abs(observed_value - expected_value)
        allowed_delta = SCALAR_CSV_SERIALIZATION_RTOL * max(
            abs(observed_value), abs(expected_value)
        )
        if absolute_delta > allowed_delta:
            raise ContractError(
                f"scalars.csv final {field} does not match relaxation qualification: "
                f"delta={absolute_delta}, allowed={allowed_delta}"
            )


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
    certificate_fingerprint = certificate.get("topology_fingerprint")
    if not isinstance(certificate_fingerprint, str) or not TOPOLOGY_FINGERPRINT.fullmatch(
        certificate_fingerprint
    ):
        raise ContractError(
            "mixed topology certificate topology_fingerprint must be canonical sha256 identity"
        )
    expected_certificate = {
        "schema_version": "mixed_layer_topology_certificate.v1",
        "certificate_status": "accepted",
        "topology_fingerprint_version": "v3",
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
    if certificate.get("marker_coverage_complete") is not True:
        raise ContractError("mixed topology certificate marker coverage must be complete")
    for field in (
        "nonconforming_face_count",
        "orphan_face_count",
        "nonmanifold_face_count",
        "coincident_interface_face_count",
    ):
        if _nonnegative_int(certificate.get(field), f"mixed topology {field}") != 0:
            raise ContractError(f"mixed topology certificate {field} must be zero")
    cell_counts = _object(
        certificate.get("cell_family_counts_by_part"),
        "mixed topology cell-family counts",
    )
    if set(cell_counts) != {"magnetic", "transition_air", "far_air"}:
        raise ContractError(
            "mixed topology certificate must contain magnetic, transition_air, and far_air counts"
        )
    magnetic_counts = _object(cell_counts.get("magnetic"), "magnetic cell-family counts")
    if set(magnetic_counts) != {"prism6"}:
        raise ContractError("magnetic mixed-P1 cells must be prism6 only")
    if _nonnegative_int(magnetic_counts.get("prism6"), "magnetic prism6 count") < 1:
        raise ContractError("magnetic mixed-P1 mesh must contain at least one prism6 cell")
    transition_counts = _object(
        cell_counts.get("transition_air"), "transition-air cell-family counts"
    )
    if set(transition_counts) != {"pyramid5", "tet4"}:
        raise ContractError(
            "transition-air mixed-P1 cells must contain pyramid5 and tet4 only"
        )
    for family in ("pyramid5", "tet4"):
        if _nonnegative_int(
            transition_counts.get(family), f"transition-air {family} count"
        ) < 1:
            raise ContractError(
                f"transition-air mixed-P1 mesh must contain at least one {family} cell"
            )
    far_counts = _object(cell_counts.get("far_air"), "far-air cell-family counts")
    if set(far_counts) != {"tet4"}:
        raise ContractError("far-air mixed-P1 cells must be tet4 only")
    if _nonnegative_int(far_counts.get("tet4"), "far-air tet4 count") < 1:
        raise ContractError("far-air mixed-P1 mesh must contain at least one tet4 cell")

    mixed_provenance = _object(
        report.get("mixed_topology_provenance"), "mixed topology provenance"
    )
    expected_mixed = {
        "requested_topology": "mixed_p1",
        "resolved_topology": "mixed_p1",
        "accepted_certificate_fingerprint": certificate_fingerprint,
        "requested_device": device,
        "precision": "double",
        "capability_status": "implemented",
    }
    for key, expected in expected_mixed.items():
        if mixed_provenance.get(key) != expected:
            raise ContractError(f"mixed topology provenance {key} must be {expected!r}")
    return topology_fingerprint, certificate


def _expected_control_sync_budget(steps: dict[str, Any]) -> int:
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
    steps: dict[str, Any],
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
    if mfem_device != "cuda":
        raise ContractError("GPU execution mfem_device must be exactly 'cuda'")
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
    if demag_runtime.get("mfem_device") != "cuda":
        raise ContractError("GPU demag runtime mfem_device must be exactly 'cuda'")
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
    if steps["demag_solves"] < 1:
        raise ContractError("GPU solver_steps.csv must prove at least one demag solve")
    if steps["demag_iterations"] != iterations:
        raise ContractError(
            "GPU solver-step demag iterations do not match demag runtime diagnostics"
        )
    if steps["demag_residual"] != residual:
        raise ContractError(
            "GPU solver-step demag residual does not match demag runtime diagnostics"
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
        "demag_solves": steps["demag_solves"],
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
    initial_field_path = artifacts / "m_initial.json"
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
    if execution.get("ignored_terms", []) != []:
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
    gradient_policy = _validate_gradient_policy(qualification, device)
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
    if scalar_evidence["final_scalar_step"] != qualification["executed_steps"]:
        raise ContractError(
            "scalars.csv final step does not match relaxation qualification executed_steps"
        )
    _cross_check_final_scalars(scalar_evidence, energy_terms, final_torque_t)
    mesh = _object(metadata.get("mesh"), "mesh metadata")
    mesh_node_count = _nonnegative_int(mesh.get("node_count"), "mesh.node_count")
    if mesh_node_count < 1:
        raise ContractError("mesh.node_count must be positive")
    magnetic_node_indices = _magnetic_node_indices(metadata, mesh_node_count)
    initial_field_vectors, initial_norm_defect, initial_state_sha256 = (
        _validate_initial_field(
            initial_field_path,
            expected_source_hash=source_identity["bounded_source_sha256"],
            expected_engine=engine,
            expected_precision="double",
            expected_node_count=mesh_node_count,
            magnetic_node_indices=magnetic_node_indices,
        )
    )
    final_field_vectors, recomputed_norm_defect = _validate_final_field(
        final_field_path,
        expected_step=qualification["executed_steps"],
        expected_source_hash=source_identity["bounded_source_sha256"],
        expected_engine=engine,
        expected_precision="double",
        expected_node_count=mesh_node_count,
        magnetic_node_indices=magnetic_node_indices,
    )
    step0_operator_artifacts = _validate_step0_operator_artifacts(
        artifacts,
        expected_source_hash=source_identity["bounded_source_sha256"],
        expected_engine=engine,
        expected_node_count=mesh_node_count,
        initial_state_sha256=initial_state_sha256,
        topology_fingerprint=topology_fingerprint,
        magnetic_node_indices=magnetic_node_indices,
        scalar_evidence=scalar_evidence,
    )
    if abs(recomputed_norm_defect - norm_defect) > DIMENSIONLESS_RECOMPUTATION_ATOL:
        raise ContractError(
            "m_final.json recomputed norm_defect does not match relaxation qualification: "
            f"delta={abs(recomputed_norm_defect - norm_defect)}, "
            f"allowed={DIMENSIONLESS_RECOMPUTATION_ATOL}"
        )
    if norm_defect > MAX_MAGNETIZATION_NORM_DEFECT:
        raise ContractError(
            "final magnetization norm_defect exceeds the frozen bound: "
            f"{norm_defect} > {MAX_MAGNETIZATION_NORM_DEFECT}"
        )
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
        residency = {
            "mode": "device_source_of_truth",
            "transfer_telemetry": gpu_transfer_telemetry,
        }
    else:
        residency = _validate_cpu_execution(execution)

    return {
        "schema_version": RUN_SCHEMA_VERSION,
        "qualification_status": "implemented",
        **source_identity,
        **runtime_identity,
        "metadata_sha256": _sha256_file(metadata_path),
        "scalars_sha256": _sha256_file(scalars_path),
        "solver_steps_sha256": _sha256_file(solver_steps_path),
        "m_initial_sha256": _sha256_file(initial_field_path),
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
        "gradient_policy": gradient_policy,
        "initial_state_sha256": initial_state_sha256,
        "initial_norm_defect": initial_norm_defect,
        "initial_magnetization": initial_field_vectors,
        "step0_operator_artifacts": step0_operator_artifacts,
        "final_energy_terms_j": energy_terms,
        "final_torque_apm": final_torque_apm,
        "final_torque_t": final_torque_t,
        "norm_defect": norm_defect,
        "final_magnetization": final_field_vectors,
        "gpu_transfer_telemetry": gpu_transfer_telemetry,
        "residency": residency,
        **scalar_evidence,
        **solver_step_evidence,
    }


def _validated_step0_summary(
    summary: dict[str, object], device: str
) -> dict[str, Any]:
    step0 = _object(
        summary.get("step0_operator_artifacts"),
        f"{device} step-0 operator artifacts",
    )
    if step0.get("schema_version") != STEP0_OPERATOR_SCHEMA_VERSION:
        raise ContractError(f"{device.upper()} step-0 operator schema is invalid")
    if step0.get("step") != 0 or step0.get("time_s") != 0.0 or step0.get("solver_dt_s") != 0.0:
        raise ContractError(f"{device.upper()} step-0 operator coordinate is invalid")
    if step0.get("initial_state_sha256") != summary.get("initial_state_sha256"):
        raise ContractError(f"{device.upper()} step-0 initial-state identity is invalid")
    if step0.get("topology_fingerprint") != summary.get("topology_fingerprint"):
        raise ContractError(f"{device.upper()} step-0 topology identity is invalid")
    fields = _object(step0.get("fields"), f"{device} step-0 fields")
    if set(fields) != set(STEP0_FIELD_OBSERVABLES):
        raise ContractError(f"{device.upper()} step-0 fields are incomplete")
    energy = _object(step0.get("energy_terms_j"), f"{device} step-0 energy")
    for name in ("E_ex", "E_demag", "E_total"):
        _finite(energy.get(name), f"{device} step-0 {name}")
    _finite(step0.get("max_torque_apm"), f"{device} step-0 max torque A/m")
    _finite(step0.get("max_torque_t"), f"{device} step-0 max torque T")
    return step0


def _load_bound_step0_field(
    artifacts: Path,
    summary: dict[str, object],
    step0: dict[str, Any],
    observable: str,
) -> tuple[list[float], int]:
    descriptor = _object(
        _object(step0.get("fields"), "step-0 fields").get(observable),
        f"step-0 {observable}",
    )
    relative = descriptor.get("relative_path")
    if relative != f"fields/{observable}.zarr":
        raise ContractError(f"step-0 {observable} relative path is invalid")
    store = artifacts / relative
    bound_files = {
        ".zattrs": "attrs_sha256",
        ".zarray": "array_sha256",
        "samples.csv": "samples_sha256",
        str(descriptor.get("step0_chunk_key")): "step0_chunk_sha256",
        str(descriptor.get("final_chunk_key")): "final_chunk_sha256",
    }
    for filename, hash_field in bound_files.items():
        expected_hash = _canonical_sha256(
            descriptor.get(hash_field), f"step-0 {observable} {hash_field}"
        )
        if _sha256_file(store / filename) != expected_hash:
            raise ContractError(f"step-0 {observable} artifact hash changed for {filename}")
    node_count = _nonnegative_int(
        descriptor.get("node_count"), f"step-0 {observable} node_count"
    )
    if descriptor.get("component_count") != 3 or descriptor.get("dtype") != "<f8":
        raise ContractError(f"step-0 {observable} descriptor shape is invalid")
    expected_len = 3 * node_count * DOUBLE_BYTES
    step0_values: list[float] | None = None
    for sample_name, key_field in (
        ("step-0", "step0_chunk_key"),
        ("final", "final_chunk_key"),
    ):
        payload = (store / str(descriptor[key_field])).read_bytes()
        if len(payload) != expected_len:
            raise ContractError(f"{sample_name} {observable} payload length changed")
        values = list(struct.unpack(f"<{3 * node_count}d", payload))
        if not all(math.isfinite(value) for value in values):
            raise ContractError(f"{sample_name} {observable} payload is non-finite")
        if sample_name == "step-0":
            step0_values = values
    if step0_values is None:
        raise ContractError(f"step-0 {observable} payload is absent")
    return step0_values, node_count


def _load_bound_step0_scalars(
    artifacts: Path, summary: dict[str, object], step0: dict[str, Any]
) -> dict[str, object]:
    scalar_path = artifacts / "scalars.csv"
    if _sha256_file(scalar_path) != summary.get("scalars_sha256"):
        raise ContractError("scalar artifact changed after validation")
    evidence = _validate_scalar_artifact(scalar_path)
    raw_values = _object(
        evidence.get("initial_scalar_values"), "raw step-0 scalar values"
    )
    summary_energy = _object(step0.get("energy_terms_j"), "summary step-0 energy")
    for name in ("E_ex", "E_demag", "E_total"):
        raw = _finite(raw_values.get(name), f"raw step-0 {name}")
        persisted = _finite(summary_energy.get(name), f"summary step-0 {name}")
        if persisted != raw:
            raise ContractError(
                f"summary step-0 {name} is not bound to raw scalars.csv"
            )
    scalar_bindings = (
        ("max_torque_apm", "max_torque_Apm"),
        ("max_torque_t", "max_torque_T"),
    )
    for summary_name, raw_name in scalar_bindings:
        raw = _finite(raw_values.get(raw_name), f"raw step-0 {raw_name}")
        persisted = _finite(step0.get(summary_name), f"summary step-0 {summary_name}")
        if persisted != raw:
            raise ContractError(
                f"summary step-0 {summary_name} is not bound to raw scalars.csv"
            )
    return {
        "energy_terms_j": {
            name: raw_values[name] for name in ("E_ex", "E_demag", "E_total")
        },
        "max_torque_apm": raw_values["max_torque_Apm"],
        "max_torque_t": raw_values["max_torque_T"],
    }


def _load_bound_magnetic_nodes(
    artifacts: Path, summary: dict[str, object], step0: dict[str, Any]
) -> tuple[list[int], int]:
    metadata_path = artifacts / "metadata.json"
    if _sha256_file(metadata_path) != summary.get("metadata_sha256"):
        raise ContractError("runtime metadata artifact changed after validation")
    if _sha256_file(artifacts / "scalars.csv") != summary.get("scalars_sha256"):
        raise ContractError("scalar artifact changed after validation")
    metadata = _read_json_object(metadata_path, "runtime metadata")
    mesh = _object(metadata.get("mesh"), "mesh metadata")
    node_count = _nonnegative_int(mesh.get("node_count"), "mesh.node_count")
    nodes = sorted(_magnetic_node_indices(metadata, node_count))
    digest = _sha256_bytes(json.dumps(nodes, separators=(",", ":")).encode("utf-8"))
    if digest != step0.get("magnetic_node_indices_sha256"):
        raise ContractError("magnetic-node selection changed after validation")
    if len(nodes) != step0.get("magnetic_node_count"):
        raise ContractError("magnetic-node count changed after validation")
    return nodes, node_count


def _compare_scalar(
    label: str, cpu_value: object, gpu_value: object, *, rtol: float, atol: float
) -> dict[str, object]:
    cpu_number = _finite(cpu_value, f"CPU {label}")
    gpu_number = _finite(gpu_value, f"GPU {label}")
    delta = abs(cpu_number - gpu_number)
    allowed = atol + rtol * max(abs(cpu_number), abs(gpu_number))
    if delta > allowed:
        raise ContractError(
            f"same-state {label} parity failed: delta={delta}, allowed={allowed}"
        )
    return {
        "cpu": cpu_number,
        "gpu": gpu_number,
        "absolute_delta": delta,
        "allowed_delta": allowed,
        "rtol": rtol,
        "atol": atol,
        "status": "pass",
    }


def compare_runtime_summaries(
    cpu: dict[str, object],
    gpu: dict[str, object],
    *,
    cpu_artifacts: Path,
    gpu_artifacts: Path,
) -> dict[str, object]:
    lane_evidence = {
        "cpu": _validate_persisted_lane_summary(cpu, "cpu"),
        "gpu": _validate_persisted_lane_summary(gpu, "gpu"),
    }
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

    expected_policies = {
        "cpu": {
            "realization": "native_mfem_pgbb",
            "gradient_policy": "exchange_plus_mass_tangent_gradient",
            "metric": "mu0_ms_fem_lumped_volume",
        },
        "gpu": {
            "realization": "native_cuda_pgbb",
            "gradient_policy": "device_tangent_gradient",
            "metric": "mu0_ms_fem_lumped_volume",
        },
    }
    for device, summary in (("cpu", cpu), ("gpu", gpu)):
        observed = _object(summary.get("gradient_policy"), f"{device} gradient policy")
        if observed != expected_policies[device]:
            raise ContractError(
                f"{device.upper()} summary gradient policy must equal "
                f"{expected_policies[device]}"
            )

    cpu_vectors = cpu.get("initial_magnetization")
    gpu_vectors = gpu.get("initial_magnetization")
    if not isinstance(cpu_vectors, list) or not isinstance(gpu_vectors, list):
        raise ContractError("CPU/GPU initial magnetization arrays are required")
    if len(cpu_vectors) != len(gpu_vectors) or not cpu_vectors:
        raise ContractError("CPU/GPU initial magnetization shapes differ")
    component_deltas: list[float] = []
    for index, (cpu_vector, gpu_vector) in enumerate(zip(cpu_vectors, gpu_vectors)):
        if not isinstance(cpu_vector, list) or not isinstance(gpu_vector, list):
            raise ContractError(f"CPU/GPU initial magnetization vector {index} is malformed")
        if len(cpu_vector) != 3 or len(gpu_vector) != 3:
            raise ContractError(
                f"CPU/GPU initial magnetization vector {index} is not a three-vector"
            )
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
    if max_component_delta != 0.0 or cpu.get("initial_state_sha256") != gpu.get(
        "initial_state_sha256"
    ):
        raise ContractError(
            "CPU/GPU initial magnetization identity failed: "
            f"max component delta={max_component_delta}"
        )
    initial_state_identity = {
        "state_sha256": cpu["initial_state_sha256"],
        "component_count": len(component_deltas),
        "max_component_abs_delta": max_component_delta,
        "rms_component_abs_delta": rms_component_delta,
        "max_component_absolute_tolerance": 0.0,
        "status": "pass",
    }
    cpu_step0 = _validated_step0_summary(cpu, "cpu")
    gpu_step0 = _validated_step0_summary(gpu, "gpu")
    cpu_nodes, cpu_node_count = _load_bound_magnetic_nodes(
        cpu_artifacts, cpu, cpu_step0
    )
    gpu_nodes, gpu_node_count = _load_bound_magnetic_nodes(
        gpu_artifacts, gpu, gpu_step0
    )
    cpu_step0_scalars = _load_bound_step0_scalars(
        cpu_artifacts, cpu, cpu_step0
    )
    gpu_step0_scalars = _load_bound_step0_scalars(
        gpu_artifacts, gpu, gpu_step0
    )
    if cpu_node_count != gpu_node_count or cpu_nodes != gpu_nodes:
        raise ContractError("CPU/GPU magnetic-node operator domains differ")
    field_parity: dict[str, object] = {}
    for observable in STEP0_FIELD_OBSERVABLES:
        cpu_field, cpu_field_nodes = _load_bound_step0_field(
            cpu_artifacts, cpu, cpu_step0, observable
        )
        gpu_field, gpu_field_nodes = _load_bound_step0_field(
            gpu_artifacts, gpu, gpu_step0, observable
        )
        if cpu_field_nodes != cpu_node_count or gpu_field_nodes != gpu_node_count:
            raise ContractError(f"{observable} node count does not match metadata")
        tolerance = STEP0_FIELD_TOLERANCES[observable]
        deltas: list[float] = []
        allowed_values: list[float] = []
        for component in range(3):
            for node in cpu_nodes:
                offset = component * cpu_node_count + node
                cpu_value = cpu_field[offset]
                gpu_value = gpu_field[offset]
                delta = abs(cpu_value - gpu_value)
                allowed = tolerance["atol_apm"] + tolerance["rtol"] * max(
                    abs(cpu_value), abs(gpu_value)
                )
                if delta > allowed:
                    raise ContractError(
                        f"same-state {observable} parity failed at component={component} "
                        f"node={node}: delta={delta}, allowed={allowed}"
                    )
                deltas.append(delta)
                allowed_values.append(allowed)
        field_parity[observable] = {
            "unit": "A/m",
            "component_count": len(deltas),
            "max_component_abs_delta": max(deltas),
            "rms_component_abs_delta": math.sqrt(
                sum(delta * delta for delta in deltas) / len(deltas)
            ),
            "max_allowed_delta": max(allowed_values),
            "rtol": tolerance["rtol"],
            "atol_apm": tolerance["atol_apm"],
            "status": "pass",
        }
    cpu_energy = _object(
        cpu_step0_scalars.get("energy_terms_j"), "CPU raw step-0 energy"
    )
    gpu_energy = _object(
        gpu_step0_scalars.get("energy_terms_j"), "GPU raw step-0 energy"
    )
    energy_parity = {
        name: _compare_scalar(
            name,
            cpu_energy.get(name),
            gpu_energy.get(name),
            rtol=ENERGY_RTOL,
            atol=ENERGY_ATOL_J,
        )
        for name in ("E_ex", "E_demag", "E_total")
    }
    torque_apm_parity = _compare_scalar(
        "max_torque_Apm",
        cpu_step0_scalars.get("max_torque_apm"),
        gpu_step0_scalars.get("max_torque_apm"),
        rtol=TORQUE_RTOL,
        atol=TORQUE_ATOL_APM,
    )
    torque_t_parity = _compare_scalar(
        "max_torque_T",
        cpu_step0_scalars.get("max_torque_t"),
        gpu_step0_scalars.get("max_torque_t"),
        rtol=TORQUE_RTOL,
        atol=TORQUE_ATOL_T,
    )
    artifact_hashes = {
        device: {
            field: summary.get(field)
            for field in (
                "metadata_sha256",
                "scalars_sha256",
                "solver_steps_sha256",
                "m_initial_sha256",
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
        "initial_state_identity": initial_state_identity,
        "gradient_policies": expected_policies,
        "same_state_operator_parity": {
            "status": "pass",
            "operator_parity_claimed": True,
            "capability_promotion_claimed": False,
            "scope": "step0_same_m_same_topology",
            "state_identity": {
                "initial_state_sha256": cpu["initial_state_sha256"],
                "topology_fingerprint": cpu["topology_fingerprint"],
                "magnetic_node_indices_sha256": cpu_step0[
                    "magnetic_node_indices_sha256"
                ],
            },
            "fields": field_parity,
            "energy_terms_j": energy_parity,
            "max_torque_apm": torque_apm_parity,
            "max_torque_t": torque_t_parity,
            "device_proof": {
                "cpu_execution_engine": cpu["execution_engine"],
                "gpu_execution_engine": gpu["execution_engine"],
                "gpu_residency": lane_evidence["gpu"]["residency"],
            },
        },
        "one_step_endpoint_parity": {
            "status": "not_applicable",
            "qualification_claimed": False,
            "reason": (
                "CPU and GPU execute different explicit PG-BB gradient policies; "
                "their first accepted iterates are not a same-algorithm parity target"
            ),
        },
        "converged_state_parity": {
            "status": "deferred_to_sp4_convergence_matrix",
            "qualification_claimed": False,
            "frozen_tolerances": {
                "state_max_component_atol": STATE_MAX_COMPONENT_ATOL,
                "energy_rtol": ENERGY_RTOL,
                "energy_atol_j": ENERGY_ATOL_J,
                "torque_rtol": TORQUE_RTOL,
                "torque_atol_apm": TORQUE_ATOL_APM,
                "torque_atol_t": TORQUE_ATOL_T,
            },
            "tolerance_source": TOLERANCE_SOURCE,
        },
        "cpu": {
            "execution_engine": cpu["execution_engine"],
            "gradient_policy": cpu["gradient_policy"],
            **lane_evidence["cpu"],
            "final_energy_terms_j": cpu["final_energy_terms_j"],
            "final_torque_apm": cpu["final_torque_apm"],
            "final_torque_t": cpu["final_torque_t"],
        },
        "gpu": {
            "execution_engine": gpu["execution_engine"],
            "gradient_policy": gpu["gradient_policy"],
            **lane_evidence["gpu"],
            "final_energy_terms_j": gpu["final_energy_terms_j"],
            "final_torque_apm": gpu["final_torque_apm"],
            "final_torque_t": gpu["final_torque_t"],
            "transfer_telemetry": gpu["gpu_transfer_telemetry"],
        },
    }


def write_comparison_csv(path: Path, comparison: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state = _object(
        comparison.get("initial_state_identity"), "initial state identity"
    )
    rows = [
        {
            "quantity": "initial_m_max_component_abs_delta",
            "unit": "1",
            "cpu": "",
            "gpu": "",
            "absolute_delta": state["max_component_abs_delta"],
            "allowed_delta": state["max_component_absolute_tolerance"],
            "status": state["status"],
        },
        {
            "quantity": "initial_m_rms_component_abs_delta",
            "unit": "1",
            "cpu": "",
            "gpu": "",
            "absolute_delta": state["rms_component_abs_delta"],
            "allowed_delta": state["max_component_absolute_tolerance"],
            "status": state["status"],
        },
    ]
    operator = _object(
        comparison.get("same_state_operator_parity"),
        "same-state operator parity",
    )
    fields = _object(operator.get("fields"), "same-state operator fields")
    for observable in STEP0_FIELD_OBSERVABLES:
        field = _object(fields.get(observable), f"same-state {observable}")
        rows.extend(
            (
                {
                    "quantity": f"step0_{observable}_max_component_abs_delta",
                    "unit": "A/m",
                    "cpu": "",
                    "gpu": "",
                    "absolute_delta": field["max_component_abs_delta"],
                    "allowed_delta": field["max_allowed_delta"],
                    "status": field["status"],
                },
                {
                    "quantity": f"step0_{observable}_rms_component_abs_delta",
                    "unit": "A/m",
                    "cpu": "",
                    "gpu": "",
                    "absolute_delta": field["rms_component_abs_delta"],
                    "allowed_delta": field["max_allowed_delta"],
                    "status": field["status"],
                },
            )
        )
    energies = _object(operator.get("energy_terms_j"), "same-state energy parity")
    for name in ("E_ex", "E_demag", "E_total"):
        value = _object(energies.get(name), f"same-state {name}")
        rows.append(
            {
                "quantity": f"step0_{name}",
                "unit": "J",
                "cpu": value["cpu"],
                "gpu": value["gpu"],
                "absolute_delta": value["absolute_delta"],
                "allowed_delta": value["allowed_delta"],
                "status": value["status"],
            }
        )
    for key, quantity, unit in (
        ("max_torque_apm", "step0_max_torque_Apm", "A/m"),
        ("max_torque_t", "step0_max_torque_T", "T"),
    ):
        value = _object(operator.get(key), f"same-state {key}")
        rows.append(
            {
                "quantity": quantity,
                "unit": unit,
                "cpu": value["cpu"],
                "gpu": value["gpu"],
                "absolute_delta": value["absolute_delta"],
                "allowed_delta": value["allowed_delta"],
                "status": value["status"],
            }
        )
    for device in ("cpu", "gpu"):
        lane = _object(comparison.get(device), f"{device} comparison lane")
        proof = _object(lane.get("accepted_energy_proof"), f"{device} energy proof")
        proof_status = (
            "pass"
            if proof.get("strict_armijo") is True
            and proof.get("energy_nonincrease") is True
            else "fail"
        )
        rows.extend(
            (
                {
                    "quantity": f"{device}_accepted_energy_delta_upper",
                    "unit": "J",
                    "cpu": proof["delta_upper_j"] if device == "cpu" else "",
                    "gpu": proof["delta_upper_j"] if device == "gpu" else "",
                    "absolute_delta": "",
                    "allowed_delta": proof["armijo_rhs_j"],
                    "status": proof_status,
                },
                {
                    "quantity": f"{device}_accepted_armijo_rhs",
                    "unit": "J",
                    "cpu": proof["armijo_rhs_j"] if device == "cpu" else "",
                    "gpu": proof["armijo_rhs_j"] if device == "gpu" else "",
                    "absolute_delta": "",
                    "allowed_delta": 0.0,
                    "status": proof_status,
                },
            )
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
    compare.add_argument("--cpu-artifacts", type=Path, required=True)
    compare.add_argument("--gpu-artifacts", type=Path, required=True)
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
            comparison = compare_runtime_summaries(
                cpu_summary,
                gpu_summary,
                cpu_artifacts=args.cpu_artifacts,
                gpu_artifacts=args.gpu_artifacts,
            )
            _write_json(args.output, comparison)
            write_comparison_csv(args.csv_output, comparison)
    except ContractError as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
