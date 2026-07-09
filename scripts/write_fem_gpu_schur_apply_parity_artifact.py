#!/usr/bin/env python3
"""Write a PA-G2 GPU Schur-apply parity artifact from GPU solver diagnostics."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import NoReturn


RELATIVE_TOLERANCE = 1.0e-6


def fail(message: str) -> NoReturn:
    raise SystemExit(f"cannot write GPU Schur-apply parity artifact:\n{message}")


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


def require_gpu_device_poisson(diagnostics: dict[str, object]) -> None:
    required: dict[str, object] = {
        "uses_gpu_poisson": True,
        "hypre_execution_policy": "device",
        "demag_provider_residency": "gpu",
        "validation_fallback_used": False,
        "gpu_operator_parity_probe_available": True,
    }
    for key, expected in required.items():
        actual = diagnostics.get(key)
        if actual != expected:
            fail(f"GPU diagnostics {key} must be {expected!r}, got {actual!r}")


def require_metric(diagnostics: dict[str, object], key: str) -> float:
    actual = diagnostics.get(key)
    if not isinstance(actual, (int, float)) or isinstance(actual, bool):
        fail(f"GPU diagnostics {key} must be a finite number")
    value = float(actual)
    if not math.isfinite(value) or value < 0.0:
        fail(f"GPU diagnostics {key} must be finite and nonnegative, got {actual!r}")
    if value > RELATIVE_TOLERANCE:
        fail(f"GPU diagnostics {key}={value:.17g} exceeds tolerance {RELATIVE_TOLERANCE:.17g}")
    return value


def write_parity_artifact(gpu_bundle: Path, output_path: Path) -> None:
    diagnostics = solver_diagnostics(gpu_bundle)
    require_gpu_device_poisson(diagnostics)

    complex_operator_error = require_metric(
        diagnostics,
        "gpu_reduced_complex_operator_parity_relative_l2_error",
    )
    real_stiffness_error = require_metric(
        diagnostics,
        "gpu_reduced_complex_real_stiffness_parity_relative_l2_error",
    )
    imag_stiffness_error = require_metric(
        diagnostics,
        "gpu_reduced_complex_imag_stiffness_parity_relative_l2_error",
    )
    real_mass_error = require_metric(
        diagnostics,
        "gpu_reduced_complex_real_mass_parity_relative_l2_error",
    )
    imag_mass_error = require_metric(
        diagnostics,
        "gpu_reduced_complex_imag_mass_parity_relative_l2_error",
    )
    demag_tangent_error = require_metric(
        diagnostics,
        "gpu_reduced_complex_real_demag_tangent_parity_relative_l2_error",
    )
    split_formula_error = require_metric(
        diagnostics,
        "gpu_reduced_split_vs_gmres_formula_relative_l2_error",
    )
    gmres_formula_error = require_metric(
        diagnostics,
        "gpu_reduced_gmres_formula_operator_parity_relative_l2_error",
    )
    max_schur_apply_error = max(
        complex_operator_error,
        real_stiffness_error,
        imag_stiffness_error,
        real_mass_error,
        imag_mass_error,
        demag_tangent_error,
        split_formula_error,
        gmres_formula_error,
    )

    payload = {
        "schema_version": "gpu_schur_apply_parity.v1",
        "lane": "gpu_poisson_airbox_k0",
        "execution_policy": "device",
        "memory_location": "device",
        "fallback_used": False,
        "source": {
            "gpu_bundle": str(gpu_bundle),
            "solver_diagnostics": "response/diagnostics/solver.v1.json",
            "operator_source": diagnostics.get("dynamic_demag_operator_source"),
            "matrix_form": diagnostics.get("dynamic_demag_matrix_form"),
        },
        "gpu_schur_apply_parity": {
            "status": "passed",
            "probe_available": True,
            "vector_set": "deterministic_frequency_response_probe",
            "max_relative_schur_apply_error": max_schur_apply_error,
            "complex_operator_relative_l2_error": complex_operator_error,
            "real_stiffness_relative_l2_error": real_stiffness_error,
            "imag_stiffness_relative_l2_error": imag_stiffness_error,
            "real_mass_relative_l2_error": real_mass_error,
            "imag_mass_relative_l2_error": imag_mass_error,
            "demag_tangent_relative_l2_error": demag_tangent_error,
            "split_vs_gmres_formula_relative_l2_error": split_formula_error,
            "gmres_formula_operator_relative_l2_error": gmres_formula_error,
            "fallback_used": False,
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(
            "usage: write_fem_gpu_schur_apply_parity_artifact.py "
            "<gpu-artifacts> <gpu_schur_apply_parity.v1.json>",
            file=sys.stderr,
        )
        return 2
    write_parity_artifact(Path(argv[1]), Path(argv[2]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
