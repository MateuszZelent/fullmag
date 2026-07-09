#!/usr/bin/env python3
"""Write a PA-G3a shifted-solve action parity artifact from CPU/GPU response bundles."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import NoReturn


RELATIVE_TOLERANCE = 1.0e-6


def fail(message: str) -> NoReturn:
    raise SystemExit(f"cannot write GPU shifted-solve action parity artifact:\n{message}")


def load_json(path: Path) -> dict[str, object]:
    if not path.is_file():
        fail(f"{path} does not exist")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"{path} is not valid JSON: {error}")
    if not isinstance(payload, dict):
        fail(f"{path} must contain a JSON object")
    return payload


def solver_diagnostics(bundle: Path) -> dict[str, object]:
    return load_json(bundle / "response" / "diagnostics" / "solver.v1.json")


def frequency_point(bundle: Path) -> dict[str, object]:
    return load_json(bundle / "response" / "frequency_points" / "frequency_0000.json")


def require_gpu_device_poisson(gpu_bundle: Path) -> None:
    diagnostics = solver_diagnostics(gpu_bundle)
    required: dict[str, object] = {
        "uses_gpu_poisson": True,
        "hypre_execution_policy": "device",
        "demag_provider_residency": "gpu",
        "validation_fallback_used": False,
    }
    for key, expected in required.items():
        actual = diagnostics.get(key)
        if actual != expected:
            fail(f"GPU diagnostics {key} must be {expected!r}, got {actual!r}")


def require_point_ready(point: dict[str, object], bundle: Path) -> None:
    if point.get("complete") is not True:
        fail(f"{bundle} frequency_0000.json must report complete=true")
    if point.get("status") not in {"ok", "ready"}:
        fail(f"{bundle} frequency_0000.json must report status='ok' or status='ready'")
    residual = point.get("relative_residual_l2_norm")
    if not isinstance(residual, (int, float)) or isinstance(residual, bool):
        fail(f"{bundle} frequency_0000.json must report a finite relative_residual_l2_norm")
    residual_value = float(residual)
    if not math.isfinite(residual_value) or residual_value < 0.0 or residual_value > 1.0e-6:
        fail(f"{bundle} relative_residual_l2_norm={residual_value:.17g} exceeds 1e-6")


def complex_pairs(point: dict[str, object], key: str) -> list[complex]:
    raw = point.get(key)
    if not isinstance(raw, list):
        fail(f"frequency_0000.json {key} must be an array")
    values: list[complex] = []
    for index, item in enumerate(raw):
        if (
            not isinstance(item, list)
            or len(item) != 2
            or not isinstance(item[0], (int, float))
            or not isinstance(item[1], (int, float))
            or isinstance(item[0], bool)
            or isinstance(item[1], bool)
        ):
            fail(f"frequency_0000.json {key}[{index}] must be [real, imag]")
        real = float(item[0])
        imag = float(item[1])
        if not math.isfinite(real) or not math.isfinite(imag):
            fail(f"frequency_0000.json {key}[{index}] must be finite")
        values.append(complex(real, imag))
    return values


def real_array(point: dict[str, object], key: str) -> list[float]:
    raw = point.get(key)
    if not isinstance(raw, list):
        fail(f"frequency_0000.json {key} must be an array")
    values: list[float] = []
    for index, item in enumerate(raw):
        if not isinstance(item, (int, float)) or isinstance(item, bool):
            fail(f"frequency_0000.json {key}[{index}] must be a finite number")
        value = float(item)
        if not math.isfinite(value):
            fail(f"frequency_0000.json {key}[{index}] must be finite")
        values.append(value)
    return values


def relative_l2_error(reference: list[complex] | list[float], candidate: list[complex] | list[float], key: str) -> float:
    if len(reference) != len(candidate):
        fail(f"{key} length mismatch: CPU={len(reference)} GPU={len(candidate)}")
    numerator = math.sqrt(sum(abs(a - b) ** 2 for a, b in zip(reference, candidate)))
    denominator = math.sqrt(sum(abs(a) ** 2 for a in reference))
    if denominator == 0.0:
        return numerator
    return numerator / denominator


def max_abs_difference(reference: list[float], candidate: list[float], key: str) -> float:
    if len(reference) != len(candidate):
        fail(f"{key} length mismatch: CPU={len(reference)} GPU={len(candidate)}")
    return max((abs(a - b) for a, b in zip(reference, candidate)), default=0.0)


def write_parity_artifact(cpu_bundle: Path, gpu_bundle: Path, output_path: Path) -> None:
    require_gpu_device_poisson(gpu_bundle)
    cpu_point = frequency_point(cpu_bundle)
    gpu_point = frequency_point(gpu_bundle)
    require_point_ready(cpu_point, cpu_bundle)
    require_point_ready(gpu_point, gpu_bundle)

    response_error = relative_l2_error(
        complex_pairs(cpu_point, "m_complex"),
        complex_pairs(gpu_point, "m_complex"),
        "m_complex",
    )
    amplitude_error = relative_l2_error(
        real_array(cpu_point, "component_response_amplitude"),
        real_array(gpu_point, "component_response_amplitude"),
        "component_response_amplitude",
    )
    phase_error = max_abs_difference(
        real_array(cpu_point, "component_response_phase"),
        real_array(gpu_point, "component_response_phase"),
        "component_response_phase",
    )
    max_action_error = max(response_error, amplitude_error, phase_error)

    if max_action_error > RELATIVE_TOLERANCE:
        fail(
            "max_relative_action_error="
            f"{max_action_error:.17g} exceeds tolerance {RELATIVE_TOLERANCE:.17g}"
        )

    payload = {
        "schema_version": "gpu_shifted_solve_action_parity.v1",
        "lane": "gpu_poisson_airbox_k0",
        "execution_policy": "device",
        "memory_location": "device",
        "fallback_used": False,
        "source": {
            "cpu_bundle": str(cpu_bundle),
            "gpu_bundle": str(gpu_bundle),
            "frequency_point": "frequency_0000",
            "response_quantity": "m_complex",
            "operator_family": "frequency_response_shifted_linear_solve",
        },
        "gpu_shifted_solve_action_parity": {
            "status": "passed",
            "operator_family": "frequency_response_shifted_linear_solve",
            "rhs_family": "dynamic_field_phasor",
            "full_modal_shift_invert_claim": False,
            "max_relative_action_error": max_action_error,
            "magnetization_response_relative_l2_error": response_error,
            "component_amplitude_relative_l2_error": amplitude_error,
            "component_phase_max_abs_error_rad": phase_error,
            "fallback_used": False,
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(
            "usage: write_fem_gpu_shifted_solve_action_parity_artifact.py "
            "<cpu-artifacts> <gpu-artifacts> <gpu_shifted_solve_action_parity.v1.json>",
            file=sys.stderr,
        )
        return 2
    write_parity_artifact(Path(argv[1]), Path(argv[2]), Path(argv[3]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
