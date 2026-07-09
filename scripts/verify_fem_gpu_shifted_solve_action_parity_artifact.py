#!/usr/bin/env python3
"""Validate a GPU shifted-solve action parity artifact for PA-G3a gating."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import NoReturn


DEFAULT_RELATIVE_TOLERANCE = 1.0e-6


def fail(message: str) -> NoReturn:
    raise SystemExit(f"invalid GPU shifted-solve action parity artifact:\n{message}")


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


def require_nonnegative_finite_number(
    payload: dict[str, object],
    key: str,
    *,
    upper_bound: float | None = None,
) -> float:
    actual = payload.get(key)
    if not isinstance(actual, (int, float)) or isinstance(actual, bool):
        fail(f"{key} must be a finite number")
    value = float(actual)
    if not math.isfinite(value) or value < 0.0:
        fail(f"{key} must be finite and nonnegative, got {actual!r}")
    if upper_bound is not None and value > upper_bound:
        fail(f"{key}={value:.17g} exceeds tolerance {upper_bound:.17g}")
    return value


def validate_payload(payload: dict[str, object]) -> None:
    require_equal(payload, "schema_version", "gpu_shifted_solve_action_parity.v1")
    require_equal(payload, "lane", "gpu_poisson_airbox_k0")
    require_equal(payload, "execution_policy", "device")
    require_equal(payload, "memory_location", "device")
    require_equal(payload, "fallback_used", False)

    parity = payload.get("gpu_shifted_solve_action_parity")
    if not isinstance(parity, dict):
        fail("gpu_shifted_solve_action_parity must be a JSON object")

    require_equal(parity, "status", "passed")
    require_equal(parity, "fallback_used", False)
    require_equal(parity, "operator_family", "frequency_response_shifted_linear_solve")
    require_equal(parity, "rhs_family", "dynamic_field_phasor")
    require_equal(parity, "full_modal_shift_invert_claim", False)
    require_nonnegative_finite_number(
        parity,
        "max_relative_action_error",
        upper_bound=DEFAULT_RELATIVE_TOLERANCE,
    )
    require_nonnegative_finite_number(
        parity,
        "magnetization_response_relative_l2_error",
        upper_bound=DEFAULT_RELATIVE_TOLERANCE,
    )
    require_nonnegative_finite_number(
        parity,
        "component_amplitude_relative_l2_error",
        upper_bound=DEFAULT_RELATIVE_TOLERANCE,
    )
    require_nonnegative_finite_number(
        parity,
        "component_phase_max_abs_error_rad",
        upper_bound=DEFAULT_RELATIVE_TOLERANCE,
    )


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(
            "usage: verify_fem_gpu_shifted_solve_action_parity_artifact.py "
            "<gpu_shifted_solve_action_parity.v1.json>",
            file=sys.stderr,
        )
        return 2
    validate_payload(load_payload(Path(argv[1])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
