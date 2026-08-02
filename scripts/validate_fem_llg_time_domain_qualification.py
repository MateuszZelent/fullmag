#!/usr/bin/env python3
"""Validate managed FEM LLG time-domain scientific qualification evidence."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


class QualificationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise QualificationError(message)


def finite_number(value: Any, label: str) -> float:
    require(isinstance(value, (int, float)) and not isinstance(value, bool), f"{label} must be numeric")
    result = float(value)
    require(math.isfinite(result), f"{label} must be finite")
    return result


def validate_energy_balance(case: Any) -> None:
    require(isinstance(case, dict), "energy_balance evidence is required")
    kind = case.get("energy_balance_kind")
    validators = {
        "undriven_dissipative": "undriven_dissipative_energy_balance.v1",
        "externally_driven": "externally_driven_power_balance.v1",
        "spin_torque_driven": "spin_torque_power_balance.v1",
    }
    require(kind in validators, "energy_balance_kind is unsupported")
    require(
        case.get("energy_balance_validator") == validators[kind],
        f"{kind} requires {validators[kind]}",
    )
    energy_delta = finite_number(case.get("energy_delta_j"), "energy_balance.energy_delta_j")
    tolerance = finite_number(
        case.get("energy_balance_tolerance_j"),
        "energy_balance.energy_balance_tolerance_j",
    )
    require(tolerance >= 0.0, "energy balance tolerance must be non-negative")
    if kind == "undriven_dissipative":
        require(
            energy_delta <= tolerance,
            "undriven dissipative energy increase exceeds the discretization tolerance",
        )
        return
    finite_number(case.get("source_work_j"), "energy_balance.source_work_j")
    finite_number(
        case.get("dissipated_energy_j"), "energy_balance.dissipated_energy_j"
    )
    residual = finite_number(
        case.get("energy_balance_residual_j"),
        "energy_balance.energy_balance_residual_j",
    )
    require(abs(residual) <= tolerance, "driven energy balance residual exceeds tolerance")
    if kind == "spin_torque_driven":
        finite_number(
            case.get("nonconservative_work_j"),
            "energy_balance.nonconservative_work_j",
        )


def validate_macrospin(rows: Any) -> None:
    require(isinstance(rows, list) and len(rows) == 3, "macrospin must contain exactly three damping cases")
    expected_alphas = [0.1, 1.0, 10.0]
    actual_alphas = sorted(finite_number(row.get("alpha"), "macrospin.alpha") for row in rows)
    require(actual_alphas == expected_alphas, "macrospin must qualify alpha={0.1,1,10}")
    for row in rows:
        require(isinstance(row, dict), "each macrospin row must be an object")
        require(finite_number(row.get("time_s"), "macrospin.time_s") > 0.0, "macrospin time must advance")
        require(finite_number(row.get("vector_error"), "macrospin.vector_error") <= 2.0e-8, "macrospin vector error exceeds FP64 budget")
        require(finite_number(row.get("norm_defect"), "macrospin.norm_defect") <= 5.0e-12, "macrospin norm defect exceeds FP64 budget")
        require(finite_number(row.get("frequency_relative_error"), "macrospin.frequency_relative_error") <= 2.0e-8, "macrospin frequency error exceeds FP64 budget")
        require(finite_number(row.get("damping_relative_error"), "macrospin.damping_relative_error") <= 2.0e-8, "macrospin damping error exceeds FP64 budget")
        magnetization = row.get("m")
        require(isinstance(magnetization, list) and len(magnetization) == 3, "macrospin m must contain three components")
        for component in magnetization:
            finite_number(component, "macrospin.m")
        require(isinstance(row.get("accepted_steps"), int) and row["accepted_steps"] > 0, "macrospin accepted_steps must be positive")
        require(isinstance(row.get("rejected_attempts"), int) and row["rejected_attempts"] >= 0, "macrospin rejected_attempts must be non-negative")


def validate_exchange(case: Any) -> None:
    require(isinstance(case, dict), "exchange_eigenmode evidence is required")
    require(case.get("integrator") == "rk45", "exchange eigenmode must qualify RK45")
    steps = case.get("dt_study")
    require(isinstance(steps, list) and len(steps) == 3, "exchange eigenmode requires dt, dt/2, dt/4")
    dts = [finite_number(row.get("dt_s"), "exchange.dt_s") for row in steps]
    require(abs(dts[0] / dts[1] - 2.0) <= 1.0e-12 and abs(dts[1] / dts[2] - 2.0) <= 1.0e-12, "exchange timestep study must halve dt exactly")
    order = finite_number(case.get("observed_order"), "exchange.observed_order")
    require(order >= 4.5, "RK45 exchange eigenmode observed order must be at least 4.5")
    require(finite_number(case.get("frequency_relative_error"), "exchange.frequency_relative_error") <= 2.0e-3, "exchange frequency error exceeds budget")
    require(finite_number(case.get("decay_relative_error"), "exchange.decay_relative_error") <= 2.0e-3, "exchange decay error exceeds budget")
    for row in steps:
        mode = row.get("mode")
        require(isinstance(mode, list) and len(mode) == 2, "exchange mode must contain real and imaginary components")
        finite_number(mode[0], "exchange.mode.real")
        finite_number(mode[1], "exchange.mode.imag")


def validate_fast_mode(case: Any) -> None:
    require(isinstance(case, dict), "fast_mode evidence is required")
    require(case.get("decision") == "accepted_after_rejection", "fast mode must reject the unstable first proposal")
    require(isinstance(case.get("rejected_attempts"), int) and case["rejected_attempts"] > 0, "fast mode must report at least one rejection")
    require(finite_number(case.get("amplitude_ratio"), "fast_mode.amplitude_ratio") <= 1.0, "accepted fast mode must not grow")
    require(finite_number(case.get("eta"), "fast_mode.eta") <= 1.0, "accepted fast-mode eta must be within tolerance")


def validate_relax_to_run(case: Any) -> None:
    require(isinstance(case, dict), "relax_to_run evidence is required")
    for field in (
        "state_handoff_exact",
        "run_clock_zero_before_first_attempt",
        "fresh_endpoint_fields",
        "energy_descent_within_budget",
        "trace_replay_exact",
        "state_replay_within_budget",
    ):
        require(case.get(field) is True, f"relax_to_run.{field} must be true")
    require(case.get("relax_converged") is True, "relax_to_run requires a strict relaxation certificate")
    require(finite_number(case.get("energy_delta_j"), "relax_to_run.energy_delta_j") <= finite_number(case.get("energy_budget_j"), "relax_to_run.energy_budget_j"), "relax-to-run energy exceeds its numerical budget")
    require(finite_number(case.get("demag_residual"), "relax_to_run.demag_residual") >= 0.0, "relax-to-run demag residual must be non-negative")
    require(finite_number(case.get("state_replay_max_abs_error"), "relax_to_run.state_replay_max_abs_error") <= 1.0e-14, "relax-to-run replay state mismatch exceeds FP64 budget")
    require(finite_number(case.get("demag_residual_replay_abs_error"), "relax_to_run.demag_residual_replay_abs_error") <= 1.0e-15, "relax-to-run replay demag residual mismatch exceeds FP64 budget")
    endpoint_m = case.get("endpoint_m")
    require(isinstance(endpoint_m, list) and len(endpoint_m) == 12, "relax-to-run endpoint_m must contain the four-node vector field")
    for component in endpoint_m:
        finite_number(component, "relax_to_run.endpoint_m")


def validate(document: Any, expected_device: str) -> None:
    require(isinstance(document, dict), "qualification root must be an object")
    require(document.get("schema_version") == "fem_llg_time_domain_qualification.v1", "unexpected qualification schema")
    require(document.get("status") == "pass", "qualification status must be pass")
    require(document.get("backend") == "fem", "qualification backend must be fem")
    require(document.get("device") == expected_device, f"qualification device must be {expected_device}")
    require(document.get("precision") == "fp64", "first qualification lane must be FP64")
    validate_energy_balance(document.get("energy_balance"))
    validate_macrospin(document.get("macrospin"))
    validate_exchange(document.get("exchange_eigenmode"))
    validate_fast_mode(document.get("fast_mode"))
    validate_relax_to_run(document.get("relax_to_run"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--device", choices=("cpu", "gpu"), default="cpu")
    args = parser.parse_args()
    try:
        validate(json.loads(args.artifact.read_text(encoding="utf-8")), args.device)
    except (OSError, json.JSONDecodeError, QualificationError) as error:
        print(f"FAIL: {error}")
        return 1
    print(f"FEM LLG time-domain {args.device.upper()} FP64 qualification artifact PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
