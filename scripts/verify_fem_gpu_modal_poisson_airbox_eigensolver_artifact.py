#!/usr/bin/env python3
"""Validate a GPU Poisson-airbox modal eigensolver artifact for GPU-G5a."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import NoReturn


DEFAULT_RELATIVE_FREQUENCY_TOLERANCE = 1.0e-8
DEFAULT_RESIDUAL_TOLERANCE = 1.0e-8


def fail(message: str) -> NoReturn:
    raise SystemExit(
        "invalid GPU Poisson-airbox modal eigensolver artifact:\n" + message
    )


def load_payload(path: Path) -> dict[str, object]:
    if not path.is_file():
        fail(f"{path} does not exist")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"{path} is not valid JSON: {error}")
    if not isinstance(payload, dict):
        fail(f"{path} must contain a JSON object")
    return payload


def require_equal(payload: dict[str, object], key: str, expected: object) -> None:
    actual = payload.get(key)
    if actual != expected:
        fail(f"{key} must be {expected!r}, got {actual!r}")


def require_object(payload: dict[str, object], key: str) -> dict[str, object]:
    value = payload.get(key)
    if not isinstance(value, dict):
        fail(f"{key} must be a JSON object")
    return value


def require_positive_integer(payload: dict[str, object], key: str) -> int:
    actual = payload.get(key)
    if not isinstance(actual, int) or isinstance(actual, bool):
        fail(f"{key} must be a positive integer")
    if actual <= 0:
        fail(f"{key} must be positive, got {actual!r}")
    return actual


def require_zero_integer(payload: dict[str, object], key: str) -> None:
    actual = payload.get(key)
    if not isinstance(actual, int) or isinstance(actual, bool):
        fail(f"{key} must be integer 0")
    if actual != 0:
        fail(f"{key} must be 0, got {actual!r}")


def require_finite_number(payload: dict[str, object], key: str) -> float:
    actual = payload.get(key)
    if not isinstance(actual, (int, float)) or isinstance(actual, bool):
        fail(f"{key} must be a finite number")
    value = float(actual)
    if not math.isfinite(value):
        fail(f"{key} must be finite, got {actual!r}")
    return value


def require_nonnegative_finite_number(
    payload: dict[str, object],
    key: str,
    *,
    upper_bound: float | None = None,
) -> float:
    value = require_finite_number(payload, key)
    if value < 0.0:
        fail(f"{key} must be nonnegative, got {value:.17g}")
    if upper_bound is not None and value > upper_bound:
        fail(f"{key}={value:.17g} exceeds tolerance {upper_bound:.17g}")
    return value


def require_positive_finite_number(payload: dict[str, object], key: str) -> float:
    value = require_finite_number(payload, key)
    if value <= 0.0:
        fail(f"{key} must be positive, got {value:.17g}")
    return value


def validate_payload(payload: dict[str, object]) -> None:
    require_equal(payload, "schema_version", "gpu_modal_poisson_airbox_eigensolver.v1")
    require_equal(payload, "status", "ok")
    require_equal(payload, "study_product", "modal_eigen")
    require_equal(payload, "lane", "gpu_poisson_airbox_k0_dense_validation")
    require_equal(payload, "execution_lane", "gpu_dense_modal_validation")
    require_equal(
        payload,
        "solver_adapter",
        "gpu_dense_poisson_airbox_modal_dense_validation_contract",
    )
    require_equal(payload, "solver_family", "modal_eigen")
    require_equal(payload, "solver_library", "cuda_dense_inverse_iteration")
    require_equal(payload, "demag_kind", "periodic_airbox_k0")
    require_equal(payload, "gauge_policy", "mean_zero_augmented")
    require_equal(payload, "phasor_convention", "exp_plus_i_omega_t")
    require_equal(payload, "eigenvalue_convention", "lambda_imag_positive_frequency")
    require_equal(payload, "operator_family", "full_coupled_poisson_airbox_modal_pencil")
    require_equal(payload, "spectral_transform", "shift_invert")
    require_equal(payload, "frequency_response_proxy", False)
    require_equal(payload, "operator_storage", "device")
    require_equal(payload, "eigensolver_iteration_location", "device")
    require_equal(payload, "persistent_solver_context", False)
    require_equal(payload, "scalable_sparse_or_matrix_free", False)
    require_equal(payload, "validation_only", True)
    require_equal(payload, "production_modal_claim", False)
    require_equal(payload, "gpu_device_resident_modal_eigensolver", False)
    require_equal(payload, "cpu_fallback", "disabled")
    require_equal(payload, "fallback_used", False)
    require_zero_integer(payload, "per_iteration_h2d_count")
    require_zero_integer(payload, "per_iteration_d2h_count")

    q_dof_count = require_positive_integer(payload, "q_dof_count")
    phi_dof_count = require_positive_integer(payload, "phi_dof_count")
    augmented_dof_count = require_positive_integer(payload, "augmented_dof_count")
    if augmented_dof_count != q_dof_count + phi_dof_count + 1:
        fail(
            "augmented_dof_count must equal q_dof_count + phi_dof_count + 1, "
            f"got {augmented_dof_count}"
        )
    require_positive_integer(payload, "max_iterations")

    sigma = require_object(payload, "sigma")
    require_finite_number(sigma, "real")
    require_finite_number(sigma, "imag")

    eigenpair = require_object(payload, "eigenpair")
    require_finite_number(eigenpair, "eigenvalue_real")
    eigenvalue_imag = require_positive_finite_number(eigenpair, "eigenvalue_imag")
    omega_rad_s = require_positive_finite_number(eigenpair, "omega_rad_s")
    frequency_hz = require_positive_finite_number(eigenpair, "frequency_hz")
    if not math.isclose(omega_rad_s, eigenvalue_imag, rel_tol=1.0e-12, abs_tol=1.0e-6):
        fail("omega_rad_s must match eigenvalue_imag for positive-frequency branch")
    expected_frequency_hz = omega_rad_s / (2.0 * math.pi)
    if not math.isclose(
        frequency_hz,
        expected_frequency_hz,
        rel_tol=1.0e-12,
        abs_tol=1.0e-6,
    ):
        fail("frequency_hz must equal omega_rad_s / (2*pi)")

    metrics = require_object(payload, "metrics")
    require_nonnegative_finite_number(
        metrics,
        "relative_reference_frequency_error",
        upper_bound=DEFAULT_RELATIVE_FREQUENCY_TOLERANCE,
    )
    require_nonnegative_finite_number(
        metrics,
        "full_descriptor_relative_residual",
        upper_bound=DEFAULT_RESIDUAL_TOLERANCE,
    )


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(
            "usage: verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py "
            "<gpu_modal_poisson_airbox_eigensolver.v1.json>",
            file=sys.stderr,
        )
        return 2
    validate_payload(load_payload(Path(argv[1])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
