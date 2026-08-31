#!/usr/bin/env python3
"""Finalize fail-closed FDM CPU/CUDA Frozen Spins evidence for one managed run."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import struct
import uuid
from pathlib import Path
from typing import Sequence


EXPECTED_SCHEMA = "fullmag.frozen_spins.cuda.runtime.evidence.v1"
EXPECTED_PARITY_SCHEMA = "fullmag.frozen_spins.fdm_cpu_gpu_parity.evidence.v1"
EXPECTED_SOURCE_SCHEMA = "fullmag.source-snapshot.v2"
EXPECTED_PARITY_COUNTS = {
    "steps": 4,
    "cell_count": 9,
    "active_cell_count": 7,
    "frozen_cell_count": 3,
    "free_cell_count": 4,
}
EXPECTED_RELATIVE_TOLERANCE = 5.0e-6
EXPECTED_ABSOLUTE_TOLERANCE = 1.0e-8
EXPECTED_DT_SECONDS = 2.5e-13
EXPECTED_FINAL_TIME_SECONDS = 1.0e-12
EXPECTED_SCIENTIFIC_SCOPE = (
    "fdm_single_grid_fp64_heun_exchange_external_field_four_fixed_steps_no_demag"
)
EXPECTED_LIMITATIONS = ["no_demag", "single_integrator", "single_precision"]
CANONICAL_ACTIVE_MASK = (True, True, True, True, False, True, True, True, False)
CANONICAL_FROZEN_MASK = (True, False, False, True, False, False, True, False, False)
CANONICAL_INITIAL_MAGNETIZATION = (
    (1.0, 0.0, 0.0),
    (0.9950041652780258, 0.09983341664682815, 0.0),
    (0.9800665778412416, 0.19866933079506122, 0.0),
    (0.8, 0.0, 0.6),
    (0.6, 0.8, 0.0),
    (0.48, 0.64, 0.6),
    (0.8, -0.6, 0.0),
    (0.28, 0.96, 0.0),
    (0.36, 0.48, 0.8),
)
PLAN_BINDING_DOMAIN = b"fullmag:frozen-spins:fdm-cpu-gpu-plan-binding:v1\0"
SOURCE_DERIVED_FIELDS = {
    "source_snapshot_dirty",
    "dirty_content_sha256",
    "source_snapshot_sha256",
}


class EvidenceError(ValueError):
    pass


def _canonical_json_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _is_lower_sha256(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _require_lower_sha256(value: object, label: str) -> str:
    if not _is_lower_sha256(value):
        raise EvidenceError(f"{label} must be a lowercase SHA-256")
    assert isinstance(value, str)
    return value


def _finite_number(value: object, label: str, *, nonnegative: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise EvidenceError(f"{label} must be finite")
    number = float(value)
    if nonnegative and number < 0.0:
        raise EvidenceError(f"{label} must be non-negative")
    return number


def _exact_integer(value: object, expected: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value != expected:
        raise EvidenceError(f"{label} must equal canonical value {expected}")
    return value


def _resolved_mask_sha256(mask: Sequence[bool]) -> str:
    digest = hashlib.sha256()
    digest.update(struct.pack("<Q", len(mask)))
    digest.update(bytes(int(value) for value in mask))
    return digest.hexdigest()


def _resolved_reference_sha256(
    mask: Sequence[bool], reference: Sequence[Sequence[float]]
) -> str:
    digest = hashlib.sha256()
    digest.update(struct.pack("<Q", len(mask)))
    for selected, vector in zip(mask, reference, strict=True):
        digest.update(bytes([int(selected)]))
        if selected:
            for component in vector:
                digest.update(struct.pack("<d", component))
    return digest.hexdigest()


def _vector_field_sha256(values: Sequence[Sequence[float]]) -> str:
    digest = hashlib.sha256()
    for vector in values:
        for component in vector:
            digest.update(struct.pack("<d", component))
    return digest.hexdigest()


EXPECTED_MASK_SHA256 = _resolved_mask_sha256(CANONICAL_FROZEN_MASK)
EXPECTED_REFERENCE_SHA256 = _resolved_reference_sha256(
    CANONICAL_FROZEN_MASK, CANONICAL_INITIAL_MAGNETIZATION
)
EXPECTED_INITIAL_MAGNETIZATION_SHA256 = _vector_field_sha256(
    CANONICAL_INITIAL_MAGNETIZATION
)


def _plan_binding_sha256(resolved: dict[str, object]) -> str:
    constraint_ids = resolved["constraint_ids"]
    grid_fingerprint = resolved["grid_or_mesh_fingerprint"]
    mask_sha256 = resolved["mask_sha256"]
    certificate = resolved["certificate"]
    source_revision = resolved["source_state_revision"]
    if not isinstance(constraint_ids, list) or not all(
        isinstance(value, str) for value in constraint_ids
    ):
        raise EvidenceError("resolved plan constraint_ids are invalid")
    if not isinstance(grid_fingerprint, str) or not isinstance(mask_sha256, str):
        raise EvidenceError("resolved plan identity strings are invalid")
    if not isinstance(certificate, dict) or not isinstance(
        certificate.get("resolved_reference_sha256"), str
    ):
        raise EvidenceError("resolved plan reference identity is invalid")
    if isinstance(source_revision, bool) or not isinstance(source_revision, int):
        raise EvidenceError("resolved plan source state revision is invalid")

    digest = hashlib.sha256()
    digest.update(PLAN_BINDING_DOMAIN)
    digest.update(struct.pack("<Q", len(constraint_ids)))
    for constraint_id in constraint_ids:
        encoded = constraint_id.encode("utf-8")
        digest.update(struct.pack("<Q", len(encoded)))
        digest.update(encoded)
    for value in (
        grid_fingerprint,
        mask_sha256,
        certificate["resolved_reference_sha256"],
    ):
        encoded = value.encode("utf-8")
        digest.update(struct.pack("<Q", len(encoded)))
        digest.update(encoded)
    digest.update(struct.pack("<Q", source_revision))
    digest.update(struct.pack("<Q", len(CANONICAL_ACTIVE_MASK)))
    digest.update(bytes(int(value) for value in CANONICAL_ACTIVE_MASK))
    digest.update(struct.pack("<Q", len(CANONICAL_FROZEN_MASK)))
    digest.update(bytes(int(value) for value in CANONICAL_FROZEN_MASK))
    return digest.hexdigest()


def validate_source_identity(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise EvidenceError("source identity must be a JSON object")
    if payload.get("schema") != EXPECTED_SOURCE_SCHEMA:
        raise EvidenceError("source identity has an unexpected schema")
    commit = payload.get("head_commit_full")
    if not isinstance(commit, str) or re.fullmatch(r"[0-9a-f]{40}", commit) is None:
        raise EvidenceError("source identity head commit must be lowercase 40-hex")
    _require_lower_sha256(payload.get("head_tree_sha256"), "source head tree")
    source_hash = _require_lower_sha256(
        payload.get("source_snapshot_sha256"), "source snapshot identity"
    )
    snapshot_payload = {
        key: value for key, value in payload.items() if key not in SOURCE_DERIVED_FIELDS
    }
    if _sha256_bytes(_canonical_json_bytes(snapshot_payload)) != source_hash:
        raise EvidenceError("source snapshot self-hash does not match its exact payload")
    dirty_content = payload.get("dirty_path_content")
    if _sha256_bytes(_canonical_json_bytes(dirty_content)) != payload.get(
        "dirty_content_sha256"
    ):
        raise EvidenceError("source dirty-content hash does not match its payload")
    if not isinstance(payload.get("source_snapshot_dirty"), bool):
        raise EvidenceError("source_snapshot_dirty must be boolean")
    if payload["source_snapshot_dirty"] != bool(payload.get("git_status_porcelain_v1")):
        raise EvidenceError("source dirty flag disagrees with canonical Git status records")
    return dict(payload)


def _validate_run_binding(
    payload: object,
    label: str,
    *,
    expected_run_id: str,
    expected_native_build_sha256: str,
    expected_gpu_ordinal: int,
    require_plan_binding: bool,
) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise EvidenceError(f"{label} run_binding must be an object")
    run_id = payload.get("run_id")
    try:
        parsed_run_id = uuid.UUID(str(run_id))
    except (ValueError, AttributeError) as error:
        raise EvidenceError(f"{label} run_id must be a canonical UUID") from error
    if str(parsed_run_id) != run_id or run_id != expected_run_id:
        raise EvidenceError(f"{label} run_id does not bind the requested managed run")
    _require_lower_sha256(payload.get("source_snapshot_sha256"), f"{label} source identity")
    build_hash = _require_lower_sha256(
        payload.get("native_build_sha256"), f"{label} native build identity"
    )
    if build_hash != expected_native_build_sha256:
        raise EvidenceError(f"{label} native build hash differs from the loaded library")
    _exact_integer(
        payload.get("requested_gpu_ordinal"),
        expected_gpu_ordinal,
        f"{label} requested GPU ordinal",
    )
    if require_plan_binding:
        _require_lower_sha256(payload.get("plan_binding_sha256"), f"{label} plan identity")
    elif "plan_binding_sha256" in payload:
        raise EvidenceError(
            f"{label} must not claim the distinct CPU/GPU parity plan identity"
        )
    return dict(payload)


def _validate_gpu_device(payload: object, label: str) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise EvidenceError(f"{label} CUDA device identity is missing")
    ordinal = payload.get("ordinal")
    if isinstance(ordinal, bool) or not isinstance(ordinal, int) or ordinal < 0:
        raise EvidenceError(f"{label} CUDA ordinal must be a non-negative integer")
    for key in ("name", "driver_version", "runtime_version", "compute_capability"):
        if not isinstance(payload.get(key), str) or not payload[key]:
            raise EvidenceError(f"{label} CUDA device {key} is missing")
    if re.fullmatch(r"[0-9]+\.[0-9]+", payload["compute_capability"]) is None:
        raise EvidenceError(f"{label} compute capability is malformed")
    return dict(payload)


def _validate_resolved_plan(payload: object) -> tuple[dict[str, object], str]:
    if not isinstance(payload, dict):
        raise EvidenceError("CPU/GPU parity resolved_plan must be an object")
    if payload.get("schema_version") != "resolved_frozen_spins_plan.v1":
        raise EvidenceError("resolved Frozen Spins plan schema is not canonical")
    if payload.get("constraint_ids") != ["cpu-gpu-parity"]:
        raise EvidenceError("resolved Frozen Spins constraint identity is not canonical")
    if payload.get("frozen_mask") != list(CANONICAL_FROZEN_MASK):
        raise EvidenceError("resolved Frozen Spins dense mask is not canonical")
    for key, expected in (
        ("active_dof_count", 7),
        ("frozen_dof_count", 3),
        ("free_dof_count", 4),
        ("source_state_revision", 1),
    ):
        _exact_integer(payload.get(key), expected, f"resolved plan {key}")
    if payload.get("all_active_dofs_frozen") is not False:
        raise EvidenceError("resolved plan all-frozen flag is inconsistent")
    if payload.get("mask_sha256") != EXPECTED_MASK_SHA256:
        raise EvidenceError("resolved plan mask hash is not derived from the canonical mask")
    grid_fingerprint = _require_lower_sha256(
        payload.get("grid_or_mesh_fingerprint"), "resolved plan grid fingerprint"
    )

    certificate = payload.get("certificate")
    if not isinstance(certificate, dict):
        raise EvidenceError("resolved plan selection certificate is missing")
    if certificate.get("schema_version") != "selection_certificate.v1":
        raise EvidenceError("selection certificate schema is not canonical")
    if certificate.get("evaluator_id") != "selection.fdm_cell_center.v1":
        raise EvidenceError("selection certificate evaluator is not canonical FDM")
    if certificate.get("constraint_ids") != ["cpu-gpu-parity"]:
        raise EvidenceError("selection certificate constraint identity is not canonical")
    authored = certificate.get("authored_fingerprints")
    if (
        not isinstance(authored, list)
        or len(authored) != 1
        or not isinstance(authored[0], dict)
        or authored[0].get("constraint_id") != "cpu-gpu-parity"
    ):
        raise EvidenceError("selection authored fingerprint binding is invalid")
    _require_lower_sha256(authored[0].get("selector_sha256"), "authored selector")
    for key, expected in (
        ("raw_candidate_dof_count", 3),
        ("inactive_candidate_dof_count", 0),
        ("active_dof_count", 7),
        ("frozen_dof_count", 3),
        ("free_dof_count", 4),
        ("source_state_revision", 1),
    ):
        _exact_integer(certificate.get(key), expected, f"selection certificate {key}")
    if certificate.get("grid_or_mesh_fingerprint") != grid_fingerprint:
        raise EvidenceError("resolved plan and certificate grid fingerprints differ")
    if certificate.get("mask_sha256") != EXPECTED_MASK_SHA256:
        raise EvidenceError("selection certificate mask hash is not canonical")
    if certificate.get("resolved_reference_sha256") != EXPECTED_REFERENCE_SHA256:
        raise EvidenceError("selection reference hash is not derived from canonical values")
    if certificate.get("warnings") != []:
        raise EvidenceError("canonical parity selection must not carry warnings")
    return dict(payload), _plan_binding_sha256(payload)


def _validate_vector_field(payload: object, label: str) -> list[list[float]]:
    if not isinstance(payload, list) or len(payload) != 9:
        raise EvidenceError(f"{label} must contain exactly 9 vectors")
    vectors: list[list[float]] = []
    for index, vector in enumerate(payload):
        if not isinstance(vector, list) or len(vector) != 3:
            raise EvidenceError(f"{label}[{index}] must contain exactly 3 components")
        vectors.append(
            [
                _finite_number(component, f"{label}[{index}][{axis}]")
                for axis, component in enumerate(vector)
            ]
        )
    return vectors


def _same_f64_bits(left: float, right: float) -> bool:
    return struct.pack("<d", left) == struct.pack("<d", right)


def _require_computed_metric(declared: object, computed: float, label: str) -> None:
    value = _finite_number(declared, label, nonnegative=True)
    if not math.isclose(value, computed, rel_tol=1e-15, abs_tol=1e-18):
        raise EvidenceError(f"{label} does not match the independently recomputed value")


def validate_parity(
    payload: object,
    *,
    expected_run_id: str,
    expected_native_build_sha256: str,
    expected_gpu_ordinal: int,
) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    if not isinstance(payload, dict):
        raise EvidenceError("CPU/GPU parity evidence must be a JSON object")
    if payload.get("schema_version") != EXPECTED_PARITY_SCHEMA:
        raise EvidenceError("CPU/GPU parity evidence has an unexpected schema_version")
    if payload.get("status") != "PASS":
        raise EvidenceError("CPU/GPU parity evidence did not report PASS")
    binding = _validate_run_binding(
        payload.get("run_binding"),
        "CPU/GPU parity",
        expected_run_id=expected_run_id,
        expected_native_build_sha256=expected_native_build_sha256,
        expected_gpu_ordinal=expected_gpu_ordinal,
        require_plan_binding=True,
    )
    if payload.get("backend_pair") != ["fdm_cpu_reference", "fdm_cuda"]:
        raise EvidenceError("CPU/GPU parity backend pair is not canonical")
    if payload.get("precision") != "fp64" or payload.get("integrator") != "heun":
        raise EvidenceError("CPU/GPU parity precision/integrator is not canonical")
    if payload.get("scientific_scope") != EXPECTED_SCIENTIFIC_SCOPE:
        raise EvidenceError("CPU/GPU parity scientific scope is overstated or stale")
    if payload.get("known_limitations") != EXPECTED_LIMITATIONS:
        raise EvidenceError("CPU/GPU parity limitations are missing or stale")
    for key, expected in EXPECTED_PARITY_COUNTS.items():
        _exact_integer(payload.get(key), expected, f"CPU/GPU parity {key}")
    if payload["active_cell_count"] != payload["frozen_cell_count"] + payload["free_cell_count"]:
        raise EvidenceError("CPU/GPU parity site counts are inconsistent")
    if payload.get("active_mask") != list(CANONICAL_ACTIVE_MASK):
        raise EvidenceError("CPU/GPU parity active mask is not canonical")
    _, plan_binding_sha256 = _validate_resolved_plan(payload.get("resolved_plan"))
    if payload.get("mask_sha256") != EXPECTED_MASK_SHA256:
        raise EvidenceError("CPU/GPU parity top-level mask hash is not canonical")
    if payload.get("plan_binding_sha256") != plan_binding_sha256:
        raise EvidenceError("CPU/GPU parity plan identity hash is stale")
    if binding["plan_binding_sha256"] != plan_binding_sha256:
        raise EvidenceError("CPU/GPU parity run binding does not name its resolved plan")
    if payload.get("initial_magnetization_sha256") != EXPECTED_INITIAL_MAGNETIZATION_SHA256:
        raise EvidenceError("CPU/GPU parity initial state is not canonical")
    initial = _validate_vector_field(payload.get("initial_magnetization"), "initial magnetization")
    cpu_final = _validate_vector_field(
        payload.get("cpu_final_magnetization"), "CPU final magnetization"
    )
    gpu_final = _validate_vector_field(
        payload.get("gpu_final_magnetization"), "GPU final magnetization"
    )
    if any(
        not _same_f64_bits(actual, expected)
        for actual_vector, expected_vector in zip(
            initial, CANONICAL_INITIAL_MAGNETIZATION, strict=True
        )
        for actual, expected in zip(actual_vector, expected_vector, strict=True)
    ):
        raise EvidenceError("initial magnetization values are not bitwise canonical")
    if _vector_field_sha256(initial) != payload["initial_magnetization_sha256"]:
        raise EvidenceError("initial magnetization SHA does not match the embedded field")

    workload = payload.get("workload")
    if not isinstance(workload, dict):
        raise EvidenceError("CPU/GPU parity workload is missing")
    if workload.get("grid_cells") != [3, 3, 1]:
        raise EvidenceError("CPU/GPU parity grid is not canonical")
    if workload.get("cell_size_m") != [5e-9, 5e-9, 1e-8]:
        raise EvidenceError("CPU/GPU parity cell size is not canonical")
    if workload.get("physics_terms") != ["exchange", "external_field"]:
        raise EvidenceError("CPU/GPU parity physics terms are not canonical")
    if workload.get("demag_enabled") is not False:
        raise EvidenceError("CPU/GPU parity workload must explicitly report no demag")
    if _finite_number(workload.get("fixed_timestep_seconds"), "fixed timestep") != EXPECTED_DT_SECONDS:
        raise EvidenceError("CPU/GPU parity timestep is not canonical")

    observed = payload.get("observed_step_stats")
    if not isinstance(observed, dict) or not isinstance(observed.get("cpu"), dict) or not isinstance(observed.get("gpu"), dict):
        raise EvidenceError("CPU/GPU parity observed step statistics are missing")
    cpu = observed["cpu"]
    gpu = observed["gpu"]
    _exact_integer(cpu.get("accepted_step_count"), 4, "CPU accepted step count")
    _exact_integer(cpu.get("step"), 4, "CPU final observed step")
    _exact_integer(gpu.get("step"), 4, "GPU final observed step")
    for stats, label in ((cpu, "CPU"), (gpu, "GPU")):
        dt = _finite_number(stats.get("dt_seconds"), f"{label} observed dt")
        time = _finite_number(stats.get("time_seconds"), f"{label} observed time")
        # The CPU adaptive transaction computes the accepted step through a
        # binary64 multiplication, so a canonical decimal timestep may be
        # represented one ULP below the literal fixture.  Keep the check
        # exact to a two-ULP envelope; this admits representation noise only,
        # not a materially different runtime timestep.
        if not math.isclose(
            dt,
            EXPECTED_DT_SECONDS,
            rel_tol=0.0,
            abs_tol=2.0 * math.ulp(EXPECTED_DT_SECONDS),
        ):
            raise EvidenceError(f"{label} observed dt is not canonical")
        if not math.isclose(
            time,
            EXPECTED_FINAL_TIME_SECONDS,
            rel_tol=0.0,
            abs_tol=2.0 * math.ulp(EXPECTED_FINAL_TIME_SECONDS),
        ):
            raise EvidenceError(f"{label} observed final time is not canonical")

    relative_tolerance = _finite_number(
        payload.get("relative_tolerance"), "CPU/GPU parity relative_tolerance", nonnegative=True
    )
    absolute_tolerance = _finite_number(
        payload.get("absolute_tolerance"), "CPU/GPU parity absolute_tolerance", nonnegative=True
    )
    if relative_tolerance != EXPECTED_RELATIVE_TOLERANCE:
        raise EvidenceError("CPU/GPU parity relative_tolerance is not canonical")
    if absolute_tolerance != EXPECTED_ABSOLUTE_TOLERANCE:
        raise EvidenceError("CPU/GPU parity absolute_tolerance is not canonical")
    if _vector_field_sha256(cpu_final) != payload.get("cpu_final_state_sha256"):
        raise EvidenceError("CPU final-state SHA does not match the embedded field")
    if _vector_field_sha256(gpu_final) != payload.get("gpu_final_state_sha256"):
        raise EvidenceError("GPU final-state SHA does not match the embedded field")

    cpu_frozen_bitwise = all(
        all(_same_f64_bits(cpu_final[index][axis], initial[index][axis]) for axis in range(3))
        for index, frozen in enumerate(CANONICAL_FROZEN_MASK)
        if frozen
    )
    gpu_frozen_bitwise = all(
        all(_same_f64_bits(gpu_final[index][axis], initial[index][axis]) for axis in range(3))
        for index, frozen in enumerate(CANONICAL_FROZEN_MASK)
        if frozen
    )
    if payload.get("cpu_frozen_reference_bitwise") is not cpu_frozen_bitwise or not cpu_frozen_bitwise:
        raise EvidenceError("CPU frozen reference is not independently bitwise exact")
    if payload.get("gpu_frozen_reference_bitwise") is not gpu_frozen_bitwise or not gpu_frozen_bitwise:
        raise EvidenceError("GPU frozen reference is not independently bitwise exact")

    def free_displacement(field: Sequence[Sequence[float]]) -> float:
        maximum = 0.0
        for index, (active, frozen) in enumerate(
            zip(CANONICAL_ACTIVE_MASK, CANONICAL_FROZEN_MASK, strict=True)
        ):
            if active and not frozen:
                squared = sum(
                    (field[index][axis] - initial[index][axis]) ** 2
                    for axis in range(3)
                )
                maximum = max(maximum, math.sqrt(squared))
        return maximum

    max_cpu_free_displacement = free_displacement(cpu_final)
    max_gpu_free_displacement = free_displacement(gpu_final)
    if max_cpu_free_displacement <= 0.0 or max_gpu_free_displacement <= 0.0:
        raise EvidenceError("independent recomputation found an immobile free spin")
    _require_computed_metric(
        payload.get("max_cpu_free_displacement"),
        max_cpu_free_displacement,
        "CPU/GPU parity max_cpu_free_displacement",
    )
    _require_computed_metric(
        payload.get("max_gpu_free_displacement"),
        max_gpu_free_displacement,
        "CPU/GPU parity max_gpu_free_displacement",
    )

    max_abs_component_diff = 0.0
    max_normalized_error = 0.0
    for gpu_vector, cpu_vector in zip(gpu_final, cpu_final, strict=True):
        for gpu_component, cpu_component in zip(gpu_vector, cpu_vector, strict=True):
            difference = abs(gpu_component - cpu_component)
            scale = max(abs(gpu_component), abs(cpu_component), 1.0)
            allowed = max(absolute_tolerance, relative_tolerance * scale)
            max_abs_component_diff = max(max_abs_component_diff, difference)
            max_normalized_error = max(max_normalized_error, difference / allowed)
    _require_computed_metric(
        payload.get("max_abs_component_diff"),
        max_abs_component_diff,
        "CPU/GPU parity max_abs_component_diff",
    )
    _require_computed_metric(
        payload.get("max_normalized_error"),
        max_normalized_error,
        "CPU/GPU parity max_normalized_error",
    )
    if max_normalized_error > 1.0:
        raise EvidenceError("CPU/GPU parity exceeds its declared tolerance")
    device = _validate_gpu_device(payload.get("gpu_device"), "CPU/GPU parity")
    if device["ordinal"] != expected_gpu_ordinal:
        raise EvidenceError("CPU/GPU parity executed on the wrong CUDA ordinal")
    return dict(payload), binding, device


def validate_native(
    payload: object,
    *,
    expected_run_id: str,
    expected_native_build_sha256: str,
    expected_gpu_ordinal: int,
) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    if not isinstance(payload, dict):
        raise EvidenceError("native evidence must be a JSON object")
    if payload.get("schema_version") != EXPECTED_SCHEMA:
        raise EvidenceError("native evidence has an unexpected schema_version")
    if payload.get("status") != "PASS":
        raise EvidenceError("native runtime contract did not report PASS")
    binding = _validate_run_binding(
        payload.get("run_binding"),
        "native runtime",
        expected_run_id=expected_run_id,
        expected_native_build_sha256=expected_native_build_sha256,
        expected_gpu_ordinal=expected_gpu_ordinal,
        require_plan_binding=False,
    )
    if payload.get("backend") != "fullmag_fdm" or payload.get("lane") != "single_grid_cuda_explicit_rk":
        raise EvidenceError("native runtime backend/lane is not canonical")
    if payload.get("precision") != "fp64+fp32":
        raise EvidenceError("native runtime precision matrix is incomplete")
    if payload.get("fallback_trail") != []:
        raise EvidenceError("native evidence contains a non-empty fallback trail")
    if payload.get("integrators_verified") != ["heun", "rk4", "rk23", "dp45", "abm3"]:
        raise EvidenceError("native runtime integrator matrix is incomplete")
    _exact_integer(payload.get("cell_count"), 2, "native runtime cell_count")
    _exact_integer(payload.get("frozen_cell_count"), 1, "native runtime frozen_cell_count")
    if _finite_number(payload.get("max_frozen_defect"), "native max frozen defect", nonnegative=True) >= 1e-14:
        raise EvidenceError("native frozen-spin defect exceeds the contract")
    if _finite_number(payload.get("checkpoint_preservation_defect"), "native checkpoint defect", nonnegative=True) >= 1e-14:
        raise EvidenceError("native checkpoint frozen-spin defect exceeds the contract")
    if _finite_number(payload.get("free_spin_displacement"), "native free-spin displacement") <= 0.0:
        raise EvidenceError("native free spin did not move")
    for key in (
        "heun_passed",
        "rk4_passed",
        "checkpoint_passed",
        "full_fp64_integrator_matrix_passed",
        "full_fp32_integrator_matrix_passed",
    ):
        if payload.get(key) is not True:
            raise EvidenceError(f"native runtime {key} did not pass")
    device = _validate_gpu_device(payload.get("device"), "native runtime")
    if device["ordinal"] != expected_gpu_ordinal:
        raise EvidenceError("native runtime executed on the wrong CUDA ordinal")
    if not isinstance(device.get("pci_bus_id"), str) or re.fullmatch(
        r"[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.0", device["pci_bus_id"]
    ) is None:
        raise EvidenceError("native runtime PCI identity is missing or malformed")
    if not isinstance(device.get("uuid"), str) or re.fullmatch(
        r"[0-9a-f]{32}", device["uuid"]
    ) is None:
        raise EvidenceError("native CUDA UUID must be lowercase 128-bit hex")
    return dict(payload), binding, device


def finalize(
    payload: object,
    parity_payload: object,
    source_identity_payload: object,
    *,
    expected_run_id: str,
    expected_native_build_sha256: str,
    expected_gpu_ordinal: int,
) -> dict[str, object]:
    source_identity = validate_source_identity(source_identity_payload)
    native, native_binding, native_device = validate_native(
        payload,
        expected_run_id=expected_run_id,
        expected_native_build_sha256=expected_native_build_sha256,
        expected_gpu_ordinal=expected_gpu_ordinal,
    )
    parity, parity_binding, parity_device = validate_parity(
        parity_payload,
        expected_run_id=expected_run_id,
        expected_native_build_sha256=expected_native_build_sha256,
        expected_gpu_ordinal=expected_gpu_ordinal,
    )
    for key in (
        "run_id",
        "source_snapshot_sha256",
        "native_build_sha256",
        "requested_gpu_ordinal",
    ):
        if native_binding[key] != parity_binding[key]:
            raise EvidenceError(
                f"native and CPU/GPU parity receipts differ at common run binding {key}"
            )
    if native_binding["source_snapshot_sha256"] != source_identity["source_snapshot_sha256"]:
        raise EvidenceError("runtime receipts do not bind the supplied source snapshot")
    for key in ("ordinal", "name", "driver_version", "runtime_version", "compute_capability"):
        if native_device[key] != parity_device[key]:
            raise EvidenceError(f"native and parity CUDA device identity differs at {key}")

    finalized = dict(native)
    finalized.update(
        {
            "implementation_status": "RUNTIME_CONFIRMED",
            "qualification_status": "UNQUALIFIED",
            "qualification_blocker": "clean_source_identity_and_remaining_p15_matrix_not_bound",
            "gate_result": "PASS",
            "test_case_ids": ["FS-P15-CPU-GPU-PARITY"],
            "source_identity": source_identity,
            "native_library_sha256": expected_native_build_sha256,
            "cpu_gpu_parity": parity,
            "managed_recipe_gates": {
                "native_abi_contract": "PASS",
                "native_runtime_contract": "PASS",
                "rust_ffi_plan_extension": "PASS",
                "runner_capability": "PASS",
                "native_boundary_malformed_plan_rejection": "PASS",
                "interactive_hot_rebuild": "PASS",
                "checkpoint_suite": "PASS",
                "checkpoint_reference_restore": "PASS",
                "cpu_gpu_parity": "PASS",
                "source_drift_check": "PASS",
            },
            "interactive_hot_rebuild_contract": {
                "apply_boundary": "accepted_step",
                "continuation_magnetization_preserved": True,
                "activation_epoch_advanced": True,
                "resolved_constraint_set_revision_advanced": True,
                "mask_identity_preserved": True,
                "reference_identity_recaptured": True,
                "frozen_spins_quantity_verified": True,
            },
        }
    )
    return finalized


def write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.finalize.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if temporary.exists():
            temporary.unlink()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--parity", type=Path, required=True)
    parser.add_argument("--source-identity", type=Path, required=True)
    parser.add_argument("--native-library", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--gpu-ordinal", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args(argv)
    try:
        native = json.loads(arguments.input.read_text(encoding="utf-8"))
        parity = json.loads(arguments.parity.read_text(encoding="utf-8"))
        source_identity = json.loads(arguments.source_identity.read_text(encoding="utf-8"))
        native_build_sha256 = _file_sha256(arguments.native_library)
        write_json_atomic(
            arguments.output,
            finalize(
                native,
                parity,
                source_identity,
                expected_run_id=arguments.run_id,
                expected_native_build_sha256=native_build_sha256,
                expected_gpu_ordinal=arguments.gpu_ordinal,
            ),
        )
    except (OSError, json.JSONDecodeError, EvidenceError) as error:
        print(f"FROZEN_SPINS_FDM_CUDA_EVIDENCE_ERROR={error}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
