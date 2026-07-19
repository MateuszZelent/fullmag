#!/usr/bin/env python3
"""Compare qualified periodic-antidot CPU/GPU FP64 relax-to-run evidence."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"{path} must contain an object")
    return value


def flat_values(path: Path) -> list[float]:
    rows = load(path).get("values")
    require(isinstance(rows, list) and len(rows) == 1781, f"{path} must contain 1781 node vectors")
    result: list[float] = []
    for row in rows:
        require(isinstance(row, list) and len(row) == 3, f"{path} contains an invalid node vector")
        result.extend(float(value) for value in row)
    require(all(math.isfinite(value) for value in result), f"{path} contains a nonfinite value")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cpu", type=Path, required=True)
    parser.add_argument("--gpu", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        cpu = load(args.cpu / "periodic_antidot_qualification.json")
        gpu = load(args.gpu / "periodic_antidot_qualification.json")
        require(cpu.get("status") == gpu.get("status") == "pass", "both runtime lanes must pass independently")
        require(cpu.get("device") == "cpu" and gpu.get("device") == "gpu", "parity inputs must be CPU and GPU")
        require(cpu.get("mesh") == gpu.get("mesh"), "CPU/GPU qualification meshes differ")
        cpu_time = float(cpu["run"]["endpoint_time_s"])
        gpu_time = float(gpu["run"]["endpoint_time_s"])
        require(cpu_time == gpu_time == 1.0e-15, "CPU/GPU lanes must end at the same physical time")

        increments: dict[str, list[float]] = {}
        for device, root in (("cpu", args.cpu), ("gpu", args.gpu)):
            initial = flat_values(root / "artifacts/m_initial.json")
            final = flat_values(root / "artifacts/m_final.json")
            increments[device] = [right - left for left, right in zip(initial, final, strict=True)]
        differences = [left - right for left, right in zip(increments["cpu"], increments["gpu"], strict=True)]
        max_increment_difference = max(abs(value) for value in differences)
        rms_increment_difference = math.sqrt(sum(value * value for value in differences) / len(differences))
        require(max_increment_difference <= 2.0e-8, "CPU/GPU one-step magnetization increment parity budget exceeded")

        cpu_energy = float(cpu["energy"]["run_final_j"])
        gpu_energy = float(gpu["energy"]["run_final_j"])
        energy_relative_difference = abs(cpu_energy - gpu_energy) / max(abs(cpu_energy), abs(gpu_energy))
        require(energy_relative_difference <= 5.0e-5, "CPU/GPU endpoint total-energy parity budget exceeded")
        result = {
            "schema_version": "fem_periodic_antidot_llg_runtime_parity.v1",
            "status": "pass",
            "precision": "fp64",
            "common_physical_time_s": cpu_time,
            "max_magnetization_increment_difference": max_increment_difference,
            "rms_magnetization_increment_difference": rms_increment_difference,
            "endpoint_total_energy_relative_difference": energy_relative_difference,
            "note": "Endpoint-state differences include independently certified CPU/GPU relaxation paths; parity compares the subsequent common-time LLG increment.",
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, RuntimeError) as error:
        print(f"FAIL: {error}")
        return 1
    print("FEM periodic-antidot CPU/GPU FP64 runtime parity PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
