#!/usr/bin/env python3
"""Compare FEM CPU/GPU FP64 LLG qualification at common physical times."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def vector_distance(left: list[float], right: list[float]) -> float:
    require(len(left) == len(right), "parity vectors must have equal length")
    return math.sqrt(sum((float(a) - float(b)) ** 2 for a, b in zip(left, right)))


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
        require(cpu.get("status") == gpu.get("status") == "pass", "both lanes must pass independently")
        require(cpu.get("device") == "cpu" and gpu.get("device") == "gpu", "parity inputs must be CPU and GPU")
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
