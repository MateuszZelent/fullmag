#!/usr/bin/env python3
"""Compare FEM CPU/GPU FP64 LLG qualification at common physical times."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

GPU_OPERATOR_BITS = {
    "exchange": 1 << 0,
    "demag_rhs": 1 << 1,
    "demag_solve": 1 << 2,
    "demag_recovery": 1 << 3,
    "local_fields": 1 << 4,
    "direct_torques": 1 << 5,
    "llg_rhs": 1 << 6,
    "rk_stepper": 1 << 7,
    "reductions": 1 << 8,
    "preconditioner": 1 << 9,
}

GPU_EXECUTION_RECEIPT_SCHEMA = (
    "fullmag.fem_gpu_execution_receipt.native_projection.v1"
)
GPU_EXECUTION_RECEIPT_RUST_PROJECTION = "FemGpuExecutionReceipt.v1"
QUALIFICATION_SCHEMA = "fem_llg_time_domain_qualification.v1"
GPU_EXECUTION_RECEIPT_FIELDS = {
    "schema_version",
    "native_abi_version",
    "native_struct_size",
    "rust_projection",
    "requested",
    "resolved",
    "executed",
    "execution_class",
    "device_ordinal",
    "precision",
    "integrator",
    "required_operator_mask",
    "resolved_device_operator_mask",
    "resolved_host_operator_mask",
    "resolved_unknown_operator_mask",
    "executed_device_operator_mask",
    "executed_host_operator_mask",
    "executed_unknown_operator_mask",
    "fallback_count",
    "accepted_step_count",
    "rejected_attempt_count",
    "failed_attempt_count",
    "hot_loop_compute_h2d_bytes",
    "hot_loop_compute_d2h_bytes",
    "hot_loop_compute_host_sync_count",
    "accounting_valid",
    "operator_ids",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def validate_qualification_document(
    document: dict[str, Any], lane: str
) -> dict[str, Any]:
    require(
        isinstance(document, dict)
        and document.get("schema_version") == QUALIFICATION_SCHEMA,
        f"{lane} qualification schema_version must equal {QUALIFICATION_SCHEMA}",
    )
    return document


def vector_distance(left: list[float], right: list[float]) -> float:
    require(len(left) == len(right), "parity vectors must have equal length")
    return math.sqrt(sum((float(a) - float(b)) ** 2 for a, b in zip(left, right)))


def source_snapshot_sha256(document: dict[str, Any], lane: str) -> str:
    source_identity = document.get("source_identity")
    require(isinstance(source_identity, dict), f"{lane} source_identity is required")
    value = source_identity.get("source_snapshot_sha256")
    require(
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value.lower()),
        f"{lane} source snapshot hash must contain 64 hex digits",
    )
    return value.lower()


def validate_gpu_execution_receipt(gpu: dict[str, Any]) -> dict[str, Any]:
    receipt = gpu.get("execution_receipt")
    require(
        isinstance(receipt, dict),
        "GPU qualification execution_receipt is required",
    )
    require(
        gpu.get("qualification_mode") == "strict",
        "GPU qualification must declare strict mode",
    )
    require(
        set(receipt) == GPU_EXECUTION_RECEIPT_FIELDS,
        "GPU execution receipt fields must match native projection v1",
    )
    require(
        receipt["schema_version"] == GPU_EXECUTION_RECEIPT_SCHEMA,
        "unsupported GPU execution receipt schema",
    )
    require(
        type(receipt["native_abi_version"]) is int
        and receipt["native_abi_version"] == 1
        and type(receipt["native_struct_size"]) is int
        and receipt["native_struct_size"] == 136,
        "GPU execution receipt must use native ABI v1",
    )
    require(
        receipt["rust_projection"] == GPU_EXECUTION_RECEIPT_RUST_PROJECTION,
        "unsupported Rust receipt projection",
    )
    require(
        receipt["requested"] == "strict_device",
        "GPU execution receipt requested mode must be strict_device",
    )
    require(
        receipt["execution_class"] != "hybrid_cpu_poisson",
        "hybrid execution cannot satisfy strict qualification",
    )
    require(
        receipt["resolved"] == "device_resident",
        "GPU execution receipt resolution is not device_resident",
    )
    require(
        receipt["executed"] == "cuda_fem",
        "GPU execution receipt did not execute cuda_fem",
    )
    require(
        receipt["execution_class"] == "device_resident",
        "GPU execution receipt must be device_resident",
    )
    require(
        isinstance(receipt["device_ordinal"], int)
        and not isinstance(receipt["device_ordinal"], bool)
        and receipt["device_ordinal"] >= 0,
        "GPU execution receipt device_ordinal must be non-negative",
    )
    require(
        receipt["precision"] == "double" and gpu.get("precision") == "fp64",
        "GPU execution receipt precision must be double",
    )
    require(
        receipt["integrator"] == "rk45"
        and receipt["integrator"] == gpu.get("integrator"),
        "GPU execution receipt integrator must match qualification",
    )
    require(
        receipt["accounting_valid"] is True,
        "GPU execution receipt accounting is invalid",
    )
    integer_fields = (
        "required_operator_mask",
        "resolved_device_operator_mask",
        "resolved_host_operator_mask",
        "resolved_unknown_operator_mask",
        "executed_device_operator_mask",
        "executed_host_operator_mask",
        "executed_unknown_operator_mask",
        "fallback_count",
        "accepted_step_count",
        "rejected_attempt_count",
        "failed_attempt_count",
        "hot_loop_compute_h2d_bytes",
        "hot_loop_compute_d2h_bytes",
        "hot_loop_compute_host_sync_count",
    )
    require(
        all(
            isinstance(receipt.get(field), int)
            and not isinstance(receipt.get(field), bool)
            for field in integer_fields
        ),
        "GPU execution receipt counters and masks must be integers",
    )
    required_mask = receipt["required_operator_mask"]
    known_mask = sum(GPU_OPERATOR_BITS.values())
    require(
        required_mask != 0 and required_mask & ~known_mask == 0,
        "GPU execution receipt required mask is empty or unknown",
    )
    require(
        receipt["resolved_device_operator_mask"] == required_mask
        and receipt["resolved_host_operator_mask"] == 0
        and receipt["resolved_unknown_operator_mask"] == 0,
        "GPU execution receipt did not resolve every required operator to device",
    )
    require(
        receipt["executed_device_operator_mask"] == required_mask
        and receipt["executed_host_operator_mask"] == 0
        and receipt["executed_unknown_operator_mask"] == 0,
        "GPU execution receipt does not prove complete device execution",
    )
    require(
        receipt["fallback_count"] == 0,
        "GPU execution receipt observed fallback",
    )
    require(
        receipt["accepted_step_count"] > 0,
        "GPU execution receipt has no accepted step",
    )
    require(
        receipt["rejected_attempt_count"] >= 0
        and receipt["failed_attempt_count"] >= 0,
        "GPU execution receipt counters must be non-negative",
    )
    require(
        receipt["hot_loop_compute_h2d_bytes"] == 0
        and receipt["hot_loop_compute_d2h_bytes"] == 0
        and receipt["hot_loop_compute_host_sync_count"] == 0,
        "GPU execution receipt observed strict compute transfer or host synchronization",
    )
    operator_ids = receipt.get("operator_ids")
    expected_operator_ids = {
        operator_id
        for operator_id, bit in GPU_OPERATOR_BITS.items()
        if required_mask & bit
    }
    require(
        isinstance(operator_ids, list)
        and all(isinstance(operator_id, str) for operator_id in operator_ids)
        and len(operator_ids) == len(set(operator_ids))
        and set(operator_ids) == expected_operator_ids,
        "GPU execution receipt operator_ids are incomplete",
    )
    return receipt


def validate_parity_energy_contract(
    cpu: dict[str, Any], gpu: dict[str, Any]
) -> dict[str, str]:
    cpu_contract = cpu.get("energy_balance")
    gpu_contract = gpu.get("energy_balance")
    require(
        isinstance(cpu_contract, dict) and isinstance(gpu_contract, dict),
        "both parity inputs must declare an energy balance contract",
    )
    fields = ("energy_balance_kind", "energy_balance_validator")
    require(
        all(cpu_contract.get(field) == gpu_contract.get(field) for field in fields),
        "CPU/GPU energy balance contracts must match",
    )
    return {field: str(cpu_contract[field]) for field in fields}


def validate_relax_to_run_increment_parity(
    cpu: dict[str, Any], gpu: dict[str, Any]
) -> float:
    cpu_case = cpu.get("relax_to_run")
    gpu_case = gpu.get("relax_to_run")
    require(
        isinstance(cpu_case, dict) and isinstance(gpu_case, dict),
        "both parity inputs must declare relax-to-run evidence",
    )
    cpu_dt = float(cpu_case["accepted_dt_s"])
    gpu_dt = float(gpu_case["accepted_dt_s"])
    require(
        abs(cpu_dt - gpu_dt) <= 1.0e-24,
        "relax-to-run lanes must compare at a common physical time",
    )
    cpu_handoff = cpu_case.get("handoff_m")
    gpu_handoff = gpu_case.get("handoff_m")
    cpu_endpoint = cpu_case.get("endpoint_m")
    gpu_endpoint = gpu_case.get("endpoint_m")
    for name, value in (
        ("CPU handoff_m", cpu_handoff),
        ("GPU handoff_m", gpu_handoff),
        ("CPU endpoint_m", cpu_endpoint),
        ("GPU endpoint_m", gpu_endpoint),
    ):
        require(isinstance(value, list), f"{name} must be a vector")
    require(
        len(cpu_handoff) == len(cpu_endpoint) == len(gpu_handoff) == len(gpu_endpoint),
        "relax-to-run vectors must have equal lengths",
    )
    cpu_increment = [
        float(endpoint) - float(handoff)
        for endpoint, handoff in zip(cpu_endpoint, cpu_handoff, strict=True)
    ]
    gpu_increment = [
        float(endpoint) - float(handoff)
        for endpoint, handoff in zip(gpu_endpoint, gpu_handoff, strict=True)
    ]
    difference = vector_distance(cpu_increment, gpu_increment)
    require(
        difference <= 5.0e-8,
        "relax-to-run CPU/GPU common-time increment parity budget exceeded",
    )
    return difference


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cpu", type=Path, required=True)
    parser.add_argument("--gpu", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        cpu: dict[str, Any] = json.loads(args.cpu.read_text(encoding="utf-8"))
        gpu: dict[str, Any] = json.loads(args.gpu.read_text(encoding="utf-8"))
        validate_qualification_document(cpu, "CPU")
        validate_qualification_document(gpu, "GPU")
        require(cpu.get("status") == gpu.get("status") == "pass", "both lanes must pass independently")
        require(cpu.get("device") == "cpu" and gpu.get("device") == "gpu", "parity inputs must be CPU and GPU")
        cpu_source_hash = source_snapshot_sha256(cpu, "CPU")
        gpu_source_hash = source_snapshot_sha256(gpu, "GPU")
        require(
            cpu_source_hash == gpu_source_hash,
            "CPU/GPU source snapshot hashes must match",
        )
        execution_receipt = validate_gpu_execution_receipt(gpu)
        energy_contract = validate_parity_energy_contract(cpu, gpu)
        macrospin_differences: list[float] = []
        for cpu_row, gpu_row in zip(cpu["macrospin"], gpu["macrospin"], strict=True):
            require(cpu_row["alpha"] == gpu_row["alpha"], "macrospin damping cases must align")
            require(abs(cpu_row["time_s"] - gpu_row["time_s"]) <= 1.0e-24, "macrospin lanes must compare at common physical time")
            macrospin_differences.append(vector_distance(cpu_row["m"], gpu_row["m"]))
        require(max(macrospin_differences) <= 5.0e-10, "macrospin CPU/GPU FP64 parity budget exceeded")
        exchange_differences: list[float] = []
        for cpu_row, gpu_row in zip(cpu["exchange_eigenmode"]["dt_study"], gpu["exchange_eigenmode"]["dt_study"], strict=True):
            require(cpu_row["dt_s"] == gpu_row["dt_s"], "exchange dt studies must align")
            require(abs(cpu_row["time_s"] - gpu_row["time_s"]) <= 1.0e-24, "exchange lanes must compare at common physical time")
            exchange_differences.append(vector_distance(cpu_row["mode"], gpu_row["mode"]))
        require(max(exchange_differences) <= 5.0e-8, "exchange CPU/GPU FP64 parity budget exceeded")
        increment_difference = validate_relax_to_run_increment_parity(cpu, gpu)
        result = {
            "schema_version": "fem_llg_time_domain_parity.v1",
            "status": "pass",
            "precision": "fp64",
            "source_identity": {
                "source_snapshot_sha256": cpu_source_hash,
            },
            "qualification_mode": "strict",
            "gpu_execution_receipt": execution_receipt,
            **energy_contract,
            "applied_validator": "fem_llg_time_domain_cpu_gpu_parity.v1",
            "macrospin_max_vector_difference": max(macrospin_differences),
            "exchange_max_mode_difference": max(exchange_differences),
            "relax_to_run_common_time_increment_difference": increment_difference,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, KeyError, ValueError, TypeError, RuntimeError) as error:
        print(f"FAIL: {error}")
        return 1
    print("FEM LLG time-domain CPU/GPU FP64 parity PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
