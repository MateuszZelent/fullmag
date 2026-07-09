#!/usr/bin/env python3
"""Write a PA-G1 GPU Poisson parity artifact from CPU/GPU response bundles."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import NoReturn


RELATIVE_TOLERANCE = 1.0e-6


def fail(message: str) -> NoReturn:
    raise SystemExit(f"cannot write GPU Poisson parity artifact:\n{message}")


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


def demag_contribution(bundle: Path) -> dict[str, object]:
    point = frequency_point(bundle)
    demag = point.get("demag_contribution")
    if not isinstance(demag, dict):
        fail(f"{bundle} frequency_0000.json lacks demag_contribution object")
    return demag


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


def complex_pairs(demag: dict[str, object], key: str) -> list[complex]:
    raw = demag.get(key)
    if not isinstance(raw, list):
        fail(f"demag_contribution.{key} must be an array")
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
            fail(f"demag_contribution.{key}[{index}] must be [real, imag]")
        real = float(item[0])
        imag = float(item[1])
        if not math.isfinite(real) or not math.isfinite(imag):
            fail(f"demag_contribution.{key}[{index}] must be finite")
        values.append(complex(real, imag))
    return values


def relative_l2_error(reference: list[complex], candidate: list[complex], key: str) -> float:
    if len(reference) != len(candidate):
        fail(f"{key} length mismatch: CPU={len(reference)} GPU={len(candidate)}")
    numerator = math.sqrt(sum(abs(a - b) ** 2 for a, b in zip(reference, candidate)))
    denominator = math.sqrt(sum(abs(a) ** 2 for a in reference))
    if denominator == 0.0:
        return numerator
    return numerator / denominator


def write_parity_artifact(cpu_bundle: Path, gpu_bundle: Path, output_path: Path) -> None:
    require_gpu_device_poisson(gpu_bundle)

    cpu_demag = demag_contribution(cpu_bundle)
    gpu_demag = demag_contribution(gpu_bundle)
    phi_error = relative_l2_error(
        complex_pairs(cpu_demag, "delta_phi_complex"),
        complex_pairs(gpu_demag, "delta_phi_complex"),
        "delta_phi_complex",
    )
    field_error = relative_l2_error(
        complex_pairs(cpu_demag, "h_demag_complex"),
        complex_pairs(gpu_demag, "h_demag_complex"),
        "h_demag_complex",
    )

    if phi_error > RELATIVE_TOLERANCE:
        fail(
            "max_relative_phi_error="
            f"{phi_error:.17g} exceeds tolerance {RELATIVE_TOLERANCE:.17g}"
        )
    if field_error > RELATIVE_TOLERANCE:
        fail(
            "max_relative_field_error="
            f"{field_error:.17g} exceeds tolerance {RELATIVE_TOLERANCE:.17g}"
        )

    payload = {
        "schema_version": "gpu_poisson_parity.v1",
        "lane": "gpu_poisson_airbox_k0",
        "execution_policy": "device",
        "memory_location": "device",
        "fallback_used": False,
        "source": {
            "cpu_bundle": str(cpu_bundle),
            "gpu_bundle": str(gpu_bundle),
            "frequency_point": "frequency_0000",
            "phi_quantity": "demag_contribution.delta_phi_complex",
            "field_quantity": "demag_contribution.h_demag_complex",
        },
        "gpu_poisson_parity": {
            "status": "passed",
            "max_relative_phi_error": phi_error,
            "max_relative_field_error": field_error,
            "h2d_count": 0,
            "d2h_count": 0,
            "fallback_used": False,
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(
            "usage: write_fem_gpu_poisson_parity_artifact.py "
            "<cpu-artifacts> <gpu-artifacts> <gpu_poisson_parity.v1.json>",
            file=sys.stderr,
        )
        return 2
    write_parity_artifact(Path(argv[1]), Path(argv[2]), Path(argv[3]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
