#!/usr/bin/env python3
"""Shared immutable binding rules for relaxation qualification receipts.

The receipt validators and the source-bound producer must agree on the
physical scope of a qualification cell.  Keeping these values in one small
module prevents a receipt from silently changing material representation,
active-region semantics, or solver realization between validators.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping, Sequence


RECEIPT_SCHEMA = "fullmag.relaxation_qualification_receipt.v2"
PARITY_SCHEMA = "fullmag.relaxation.parity_artifact.v1"

UNIFORM_MATERIAL_REPRESENTATION: dict[str, Any] = {
    "schema_version": "fullmag.relaxation.material_representation.v1",
    "kind": "uniform",
    "location": "cell_or_element_constant",
    "heterogeneous_material": False,
    "coefficients": {
        "Ms": "scalar",
        "Aex": "scalar",
        "alpha": "scalar",
    },
}

REALIZATION_IDS = {
    "llg_overdamped": {
        "fdm_cpu_reference": "native_llg_time_integrator",
        "fdm_gpu_production": "native_llg_time_integrator",
        "fem_cpu_public": "native_llg_time_integrator",
        "fem_gpu_public": "native_llg_time_integrator",
    },
    "projected_gradient_bb": {
        "fdm_cpu_reference": "cpu_soa_tangent_gradient",
        "fdm_gpu_production": "native_cuda_pgbb",
        "fem_cpu_public": "native_mfem_pgbb",
        "fem_gpu_public": "native_cuda_pgbb",
    },
    "nonlinear_cg": {
        "fdm_cpu_reference": "cpu_soa_tangent_gradient",
        "fdm_gpu_production": "native_cuda_nonlinear_cg",
        "fem_cpu_public": "native_mfem_nonlinear_cg",
        "fem_gpu_public": "native_cuda_nonlinear_cg",
    },
    "tangent_plane_implicit": {
        "fdm_cpu_reference": "not_applicable",
        "fdm_gpu_production": "not_applicable",
        "fem_cpu_public": "native_mfem_tpi",
        "fem_gpu_public": "not_applicable",
    },
}

DIRECTION_POLICIES = {
    "llg_overdamped": "not_applicable",
    "fdm_cpu_reference": "raw_tangent_gradient",
    "fdm_gpu_production": "device_tangent_gradient",
    "fem_cpu_public": "exchange_mass_preconditioned",
    "fem_gpu_public": "device_tangent_gradient",
}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def material_payload(workload_id: str) -> dict[str, Any]:
    return {
        "schema_version": "fullmag.relaxation.material_payload.v1",
        "workload_id": workload_id,
        "representation": UNIFORM_MATERIAL_REPRESENTATION,
        "values_si": {
            "Ms_Apm": 800e3,
            "Aex_Jpm": 13e-12,
            "alpha": 0.5,
        },
    }


def active_mask_payload(workload_id: str, mesh_level: str) -> dict[str, Any]:
    return {
        "schema_version": "fullmag.relaxation.active_mask.v1",
        "workload_id": workload_id,
        "mesh_level": mesh_level,
        "kind": "analytic_full_magnetic_body",
        "body_extent_m": [40e-9, 40e-9, 10e-9],
        "active_fraction": 1.0,
    }


def material_hashes(workload_ids: Sequence[str]) -> dict[str, str]:
    return {workload_id: sha256_json(material_payload(workload_id)) for workload_id in workload_ids}


def active_mask_hashes(workload_ids: Sequence[str], mesh_levels: Sequence[str]) -> dict[str, dict[str, str]]:
    return {
        workload_id: {
            mesh_level: sha256_json(active_mask_payload(workload_id, mesh_level))
            for mesh_level in mesh_levels
        }
        for workload_id in workload_ids
    }


def direction_policy(lane: str, algorithm: str) -> str:
    if algorithm == "llg_overdamped":
        return DIRECTION_POLICIES[algorithm]
    try:
        return DIRECTION_POLICIES[lane]
    except KeyError as error:
        raise ValueError(f"no direction policy for lane={lane} algorithm={algorithm}") from error


def parity_baseline(lane: str, precision: str) -> dict[str, str] | None:
    if lane == "fdm_gpu_production" and precision == "fp64":
        return {"lane": "fdm_cpu_reference", "precision": "fp64"}
    if lane == "fdm_gpu_production" and precision == "fp32":
        return {"lane": "fdm_gpu_production", "precision": "fp64"}
    if lane == "fem_gpu_public" and precision == "fp64":
        return {"lane": "fem_cpu_public", "precision": "fp64"}
    return None


def parity_scope(lane: str, precision: str) -> dict[str, Any]:
    baseline = parity_baseline(lane, precision)
    if baseline is None:
        return {"status": "not_applicable", "reason": "reference_lane"}
    return {
        "status": "required",
        "baseline_lane": baseline["lane"],
        "baseline_precision": baseline["precision"],
        "comparison_scope": "same_workload_mesh_input_and_final_state",
    }


def realization_id(lane: str, algorithm: str) -> str:
    try:
        return REALIZATION_IDS[algorithm][lane]
    except KeyError as error:
        raise ValueError(f"no realization id for lane={lane} algorithm={algorithm}") from error


def canonical_binding(
    *,
    lane: str,
    algorithm: str,
    workload_ids: Sequence[str],
    mesh_levels: Sequence[str],
    realized_id: str | None = None,
    resolved_direction_policy: str | None = None,
) -> dict[str, Any]:
    expected_realization = realization_id(lane, algorithm)
    expected_direction = direction_policy(lane, algorithm)
    if realized_id is not None and realized_id != expected_realization:
        raise ValueError(
            f"runtime realization {realized_id!r} is not canonical {expected_realization!r}"
        )
    if resolved_direction_policy is not None and resolved_direction_policy != expected_direction:
        raise ValueError(
            "runtime direction policy "
            f"{resolved_direction_policy!r} is not canonical {expected_direction!r}"
        )
    return {
        "material_representation": UNIFORM_MATERIAL_REPRESENTATION,
        "material_payload_sha256": material_hashes(workload_ids),
        "active_mask_sha256": active_mask_hashes(workload_ids, mesh_levels),
        "realization_id": expected_realization,
        "direction_policy": expected_direction,
    }


def validate_sha256_mapping(value: object, *, nested: bool = False) -> bool:
    if not isinstance(value, Mapping) or not value:
        return False
    for key, item in value.items():
        if not isinstance(key, str):
            return False
        if nested:
            if not validate_sha256_mapping(item, nested=False):
                return False
        elif not isinstance(item, str) or len(item) != 64 or any(
            character not in "0123456789abcdef" for character in item
        ):
            return False
    return True


def validate_mesh_refinement(value: object, workload_ids: Sequence[str]) -> bool:
    if not isinstance(value, Mapping):
        return False
    if value.get("levels") != ["coarse", "medium", "fine"]:
        return False
    if value.get("strategy") != "same_physical_problem":
        return False
    observations = value.get("observations")
    if not isinstance(observations, list) or len(observations) != len(workload_ids) * 3:
        return False
    expected_pairs = {(workload, level) for workload in workload_ids for level in value["levels"]}
    observed_pairs: set[tuple[str, str]] = set()
    for item in observations:
        if not isinstance(item, Mapping):
            return False
        workload = item.get("workload_id")
        level = item.get("mesh_level")
        if not isinstance(workload, str) or not isinstance(level, str):
            return False
        pair = (workload, level)
        if pair in observed_pairs or pair not in expected_pairs:
            return False
        observed_pairs.add(pair)
        if not isinstance(item.get("input_contract_sha256"), str) or len(item["input_contract_sha256"]) != 64:
            return False
        if item.get("measured_run_count") != 5:
            return False
        if not _valid_hash_list(item.get("final_state_sha256"), 5):
            return False
        if not _valid_result(item.get("result")):
            return False
    return observed_pairs == expected_pairs


def validate_repeatability(value: object, workload_ids: Sequence[str]) -> bool:
    if not isinstance(value, Mapping):
        return False
    if value.get("warmup_runs") != 1 or value.get("measured_runs") != 5:
        return False
    if value.get("determinism_policy") != "same_input_contract_and_bounded_metric_spread":
        return False
    observations = value.get("observations")
    if not isinstance(observations, list) or len(observations) != len(workload_ids) * 3:
        return False
    expected_pairs = {(workload, level) for workload in workload_ids for level in ("coarse", "medium", "fine")}
    observed_pairs: set[tuple[str, str]] = set()
    for item in observations:
        if not isinstance(item, Mapping):
            return False
        workload = item.get("workload_id")
        level = item.get("mesh_level")
        pair = (workload, level)
        if pair in observed_pairs or pair not in expected_pairs:
            return False
        observed_pairs.add(pair)
        if item.get("warmup_run_count") != 1 or item.get("measured_run_count") != 5:
            return False
        if not isinstance(item.get("input_contract_sha256"), str) or len(item["input_contract_sha256"]) != 64:
            return False
        if not _valid_hash_list(item.get("final_state_sha256"), 5):
            return False
        if not isinstance(item.get("run_log_paths"), list) or len(item["run_log_paths"]) != 5:
            return False
        if not all(isinstance(path, str) and path for path in item["run_log_paths"]):
            return False
        spread = item.get("energy_relative_spread")
        if not isinstance(spread, (int, float)) or not float(spread) == float(spread) or float(spread) > 5e-2:
            return False
    return observed_pairs == expected_pairs


def _valid_hash_list(value: object, expected_length: int) -> bool:
    return (
        isinstance(value, list)
        and len(value) == expected_length
        and all(
            isinstance(item, str)
            and len(item) == 64
            and all(character in "0123456789abcdef" for character in item)
            for item in value
        )
    )


def _valid_result(value: object) -> bool:
    if not isinstance(value, Mapping):
        return False
    return (
        value.get("status") == "passed"
        and value.get("converged") is True
        and value.get("termination_reason") in {"torque", "energy"}
        and isinstance(value.get("accepted_steps"), int)
        and isinstance(value.get("max_steps"), int)
        and value["max_steps"] > value["accepted_steps"] >= 0
        and isinstance(value.get("metrics"), Mapping)
    )
