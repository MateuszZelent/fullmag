#!/usr/bin/env python3
"""Verify independent mesh and airbox convergence for FEM K0-3 artifacts."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
from typing import Any


CERTIFIED_SOLVER_PROFILES: dict[str, dict[str, Any]] = {
    "production_cpu": {
        "adapters": {
            "k0_poisson_airbox_cpu_full_coupled_slepc": "k0_poisson_airbox_full_coupled",
            "k0_poisson_airbox_cpu_schur_slepc": "k0_poisson_airbox_schur",
        },
        "label": "CPU",
    },
    "production_gpu": {
        "adapters": {
            "k0_poisson_airbox_gpu_petsc_slepc": "device_resident_arnoldi_shift_invert",
        },
        "label": "GPU",
    },
}


def fail(message: str) -> None:
    raise SystemExit(f"error: {message}")


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        fail(f"missing required file: {path}")
    try:
        value = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON in {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"{path} must contain a JSON object")
    return value


def load_csv(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        fail(f"missing required file: {path}")
    rows = list(csv.DictReader(path.read_text().splitlines()))
    if not rows:
        fail(f"{path} must contain at least one data row")
    return rows


def finite_float(value: object, field: str, path: Path) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        fail(f"{path}: {field} must be numeric")
    if not math.isfinite(number):
        fail(f"{path}: {field} must be finite")
    return number


def positive_float(value: object, field: str, path: Path) -> float:
    number = finite_float(value, field, path)
    if number <= 0.0:
        fail(f"{path}: {field} must be positive")
    return number


def relative_delta(lhs: float, rhs: float) -> float:
    return abs(lhs - rhs) / max(abs(lhs), abs(rhs), 1.0)


def fit_effective_magnetisation(
    fields_t: list[float], frequencies_hz: list[float], gamma_rad_s_t: float, mu0: float
) -> tuple[float, float, float]:
    if len(fields_t) < 2:
        fail("Kittel fit requires at least two distinct bias fields")
    frequency_scale = gamma_rad_s_t / math.tau
    transformed = [
        (frequency / frequency_scale) ** 2 - field_t * field_t
        for field_t, frequency in zip(fields_t, frequencies_hz, strict=True)
    ]
    denominator = sum(field_t * field_t for field_t in fields_t)
    if denominator <= 0.0:
        fail("Kittel fit requires positive bias fields")
    slope = sum(
        field_t * value for field_t, value in zip(fields_t, transformed, strict=True)
    ) / denominator
    effective_magnetisation = slope / mu0
    residuals = [
        value - slope * field_t
        for field_t, value in zip(fields_t, transformed, strict=True)
    ]
    degrees_of_freedom = max(1, len(fields_t) - 1)
    residual_sigma = math.sqrt(sum(value * value for value in residuals) / degrees_of_freedom)
    standard_uncertainty = residual_sigma / math.sqrt(denominator) / mu0
    # The fit itself is intentionally constrained through the origin.  For a
    # conditioning diagnostic, use the independently scaled two-column
    # Jacobian [1, H0] so the reported value reflects the field-span quality
    # rather than a fabricated scalar condition number of one.
    intercept_norm = math.sqrt(float(len(fields_t)))
    field_norm = math.sqrt(denominator)
    correlation = sum(fields_t) / (intercept_norm * field_norm)
    if not math.isfinite(correlation) or abs(correlation) >= 1.0:
        fail("Kittel fit Jacobian is singular or ill-conditioned")
    scaled_jacobian_condition_number = math.sqrt(
        (1.0 + abs(correlation)) / (1.0 - abs(correlation))
    )
    return effective_magnetisation, standard_uncertainty, scaled_jacobian_condition_number


def artifact_signature(root: Path) -> str:
    digest = hashlib.sha256()
    for relative in (
        "eigen/diagnostics/solver.v1.json",
        "validation/kittel_k0_pbc/points.v1.csv",
        "validation/kittel_k0_pbc/convergence.v1.csv",
    ):
        path = root / relative
        if not path.is_file():
            fail(f"missing signature input: {path}")
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return f"sha256:{digest.hexdigest()}"


def verify_root(
    root: Path,
    max_relative_error: float,
    minimum_field_count: int,
    expected_execution_lane: str = "production_cpu",
) -> dict[str, Any]:
    solver = load_json(root / "eigen" / "diagnostics" / "solver.v1.json")
    try:
        profile = CERTIFIED_SOLVER_PROFILES[expected_execution_lane]
    except KeyError:
        fail(f"unsupported expected execution lane: {expected_execution_lane}")
    certified_adapters = profile["adapters"]
    profile_label = profile["label"]
    adapter = solver.get("solver_adapter")
    if adapter not in certified_adapters:
        fail(f"{root}: solver_adapter is not a certified {profile_label} K0 adapter")
    if solver.get("solver_model") != adapter:
        fail(f"{root}: solver_model must match solver_adapter")
    if solver.get("resolved_solver_family") != certified_adapters[adapter]:
        fail(f"{root}: resolved_solver_family does not match solver_adapter")
    if solver.get("demag_kind") != "periodic_airbox_k0":
        fail(f"{root}: demag_kind must be periodic_airbox_k0")
    if solver.get("execution_lane") != expected_execution_lane:
        fail(f"{root}: execution_lane must be {expected_execution_lane}")
    constants = solver.get("constants")
    if not isinstance(constants, dict):
        fail(f"{root}: solver constants are required")
    gamma_rad_s_t = positive_float(constants.get("gamma_rad_s_T"), "gamma_rad_s_T", root)
    mu0 = positive_float(constants.get("mu0_T_m_per_A"), "mu0_T_m_per_A", root)

    summary = load_json(root / "validation" / "kittel_k0_pbc" / "summary.v1.json")
    if summary.get("case_id") != "K0-3" or summary.get("demag_kind") != "periodic_airbox_k0":
        fail(f"{root}: summary must describe K0-3 periodic_airbox_k0")
    relative_error = finite_float(
        summary.get("max_relative_frequency_error"),
        "summary.max_relative_frequency_error",
        root,
    )
    if relative_error > max_relative_error:
        fail(f"{root}: max_relative_frequency_error {relative_error:g} exceeds {max_relative_error:g}")

    convergence_path = root / "validation" / "kittel_k0_pbc" / "convergence.v1.csv"
    convergence_rows = load_csv(convergence_path)
    if len(convergence_rows) != 1:
        fail(f"{convergence_path} must contain exactly one data row")
    convergence = convergence_rows[0]
    if convergence.get("case_id") != "K0-3" or convergence.get("demag_kind") != "periodic_airbox_k0":
        fail(f"{root}: convergence row must be K0-3 periodic_airbox_k0")
    mesh_resolution = positive_float(convergence.get("mesh_resolution_m"), "mesh_resolution_m", root)
    airbox_size = positive_float(convergence.get("airbox_size_m"), "airbox_size_m", root)
    phi_dof_count = positive_float(convergence.get("phi_dof_count"), "phi_dof_count", root)
    poisson_residual = finite_float(
        convergence.get("poisson_residual_relative"), "poisson_residual_relative", root
    )
    if poisson_residual < 0.0 or poisson_residual > 1.0e-8:
        fail(f"{root}: poisson_residual_relative must be in [0, 1e-8]")
    reference_magnetisation = positive_float(
        convergence.get("effective_magnetisation_A_per_m"),
        "effective_magnetisation_A_per_m",
        root,
    )

    point_path = root / "validation" / "kittel_k0_pbc" / "points.v1.csv"
    points = load_csv(point_path)
    if len(points) < minimum_field_count:
        fail(f"{root}: points.v1.csv requires at least {minimum_field_count} field rows")
    fields_t: list[float] = []
    frequencies_hz: list[float] = []
    for index, point in enumerate(points):
        if int(point.get("field_index", "-1")) != index:
            fail(f"{point_path}: field_index must be contiguous from zero")
        fields_t.append(positive_float(point.get("mu0_H0_T"), "mu0_H0_T", point_path))
        frequencies_hz.append(
            positive_float(point.get("eigen_frequency_hz"), "eigen_frequency_hz", point_path)
        )
    effective_magnetisation, standard_uncertainty, condition_number = fit_effective_magnetisation(
        fields_t, frequencies_hz, gamma_rad_s_t, mu0
    )
    return {
        "root": str(root.resolve()),
        "run_signature": artifact_signature(root),
        "mesh_resolution_m": mesh_resolution,
        "airbox_size_m": airbox_size,
        "phi_dof_count": phi_dof_count,
        "poisson_residual": poisson_residual,
        "relative_error": relative_error,
        "fields_t": fields_t,
        "frequencies_hz": frequencies_hz,
        "effective_magnetisation_A_per_m": effective_magnetisation,
        "effective_magnetisation_standard_uncertainty_A_per_m": standard_uncertainty,
        "scaled_jacobian_condition_number": condition_number,
        "reference_magnetisation_A_per_m": reference_magnetisation,
    }


def ensure_common_fields(metrics: list[dict[str, Any]]) -> None:
    reference = metrics[0]["fields_t"]
    for metric in metrics[1:]:
        fields = metric["fields_t"]
        if len(fields) != len(reference) or any(
            relative_delta(left, right) > 1.0e-12
            for left, right in zip(reference, fields, strict=True)
        ):
            fail("all convergence runs must use the identical positive field set")


def linear_fit_residual(xs: list[float], ys: list[float]) -> float:
    count = len(xs)
    mean_x = sum(xs) / count
    mean_y = sum(ys) / count
    denominator = sum((value - mean_x) ** 2 for value in xs)
    if denominator <= 0.0:
        fail("convergence fit requires distinct abscissa values")
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys, strict=True)) / denominator
    intercept = mean_y - slope * mean_x
    return max(
        abs(y - (intercept + slope * x)) / max(abs(y), 1.0)
        for x, y in zip(xs, ys, strict=True)
    )


def solve_observed_order(xs: list[float], ys: list[float]) -> dict[str, Any]:
    """Estimate y(0), C, and p from the three finest y = y(0) + C x**p levels."""
    if len(xs) < 3 or len(ys) < 3:
        fail("observed-order estimation requires at least three levels")
    x0, x1, x2 = xs[-3:]
    y0, y1, y2 = ys[-3:]
    if not (x0 > x1 > x2 > 0.0):
        fail("observed-order abscissae must be positive and ordered coarse to fine")

    coarse_delta = y0 - y1
    fine_delta = y1 - y2
    scale = max(abs(y0), abs(y1), abs(y2), 1.0)
    roundoff_tolerance = 1.0e-12 * scale
    fallback_error = relative_delta(y2, y1)
    if max(abs(coarse_delta), abs(fine_delta)) <= roundoff_tolerance:
        return {
            "status": "roundoff_plateau",
            "value": None,
            "extrapolated_limit": None,
            "richardson_relative_error_estimate": fallback_error,
        }
    if coarse_delta * fine_delta <= 0.0 or abs(fine_delta) <= roundoff_tolerance:
        return {
            "status": "unresolved",
            "value": None,
            "extrapolated_limit": None,
            "richardson_relative_error_estimate": fallback_error,
        }

    observed_ratio = coarse_delta / fine_delta

    def residual(order: float) -> float:
        predicted_ratio = (x0**order - x1**order) / (x1**order - x2**order)
        return predicted_ratio - observed_ratio

    lower = 0.05
    lower_residual = residual(lower)
    bracket: tuple[float, float] | None = None
    for index in range(1, 241):
        upper = 0.05 + index * (12.0 - 0.05) / 240.0
        upper_residual = residual(upper)
        if lower_residual == 0.0:
            bracket = (lower, lower)
            break
        if lower_residual * upper_residual <= 0.0:
            bracket = (lower, upper)
            break
        lower = upper
        lower_residual = upper_residual
    if bracket is None:
        return {
            "status": "unresolved",
            "value": None,
            "extrapolated_limit": None,
            "richardson_relative_error_estimate": fallback_error,
        }

    lower, upper = bracket
    if lower != upper:
        for _ in range(80):
            midpoint = 0.5 * (lower + upper)
            midpoint_residual = residual(midpoint)
            if residual(lower) * midpoint_residual <= 0.0:
                upper = midpoint
            else:
                lower = midpoint
    order = 0.5 * (lower + upper)
    denominator = x1**order - x2**order
    if denominator == 0.0:
        return {
            "status": "unresolved",
            "value": None,
            "extrapolated_limit": None,
            "richardson_relative_error_estimate": fallback_error,
        }
    extrapolated_limit = (y2 * x1**order - y1 * x2**order) / denominator
    return {
        "status": "estimated",
        "value": order,
        "extrapolated_limit": extrapolated_limit,
        "richardson_relative_error_estimate": relative_delta(y2, extrapolated_limit),
    }


def summarize_frequency_orders(estimates: list[dict[str, Any]]) -> dict[str, Any]:
    orders = [
        estimate["value"]
        for estimate in estimates
        if estimate["status"] == "estimated"
    ]
    plateau_count = sum(
        estimate["status"] == "roundoff_plateau" for estimate in estimates
    )
    unresolved_count = sum(estimate["status"] == "unresolved" for estimate in estimates)
    if len(orders) == len(estimates):
        status = "estimated"
    elif plateau_count == len(estimates):
        status = "roundoff_plateau"
    elif orders:
        status = "partially_estimated"
    else:
        status = "unresolved"
    return {
        "status": status,
        "estimated_count": len(orders),
        "roundoff_plateau_count": plateau_count,
        "unresolved_count": unresolved_count,
        "minimum": min(orders) if orders else None,
        "maximum": max(orders) if orders else None,
        "per_field": estimates,
    }


def sequence_metrics(
    kind: str, metrics: list[dict[str, Any]], budget: float
) -> dict[str, Any]:
    if len(metrics) < 3:
        fail(f"{kind} convergence requires at least three runtime roots")
    roots = [metric["root"] for metric in metrics]
    if len(set(roots)) != len(roots):
        fail(f"{kind} convergence roots must be unique")
    signatures = [metric["run_signature"] for metric in metrics]
    if len(set(signatures)) != len(signatures):
        fail(f"{kind} convergence requires distinct runtime signatures")

    if kind == "mesh":
        levels = [metric["mesh_resolution_m"] for metric in metrics]
        fixed = [metric["airbox_size_m"] for metric in metrics]
        if len(set(levels)) != len(levels):
            fail("mesh convergence requires at least three distinct mesh resolutions")
        if max(fixed) - min(fixed) > 1.0e-12 * max(fixed):
            fail("mesh convergence must keep airbox size fixed")
        ordered = sorted(metrics, key=lambda metric: metric["mesh_resolution_m"], reverse=True)
        fit_x = [metric["mesh_resolution_m"] for metric in ordered]
    else:
        levels = [metric["airbox_size_m"] for metric in metrics]
        fixed = [metric["mesh_resolution_m"] for metric in metrics]
        if len(set(levels)) != len(levels):
            fail("airbox convergence requires at least three distinct airbox sizes")
        if max(fixed) - min(fixed) > 1.0e-12 * max(fixed):
            fail("airbox convergence must keep magnetic mesh resolution fixed")
        ordered = sorted(metrics, key=lambda metric: metric["airbox_size_m"])
        fit_x = [1.0 / metric["airbox_size_m"] for metric in ordered]

    finest, next_finest = ordered[-1], ordered[-2]
    point_deltas = [
        relative_delta(left, right)
        for left, right in zip(
            finest["frequencies_hz"], next_finest["frequencies_hz"], strict=True
        )
    ]
    max_finest_two_delta = max(point_deltas)
    meff_delta = relative_delta(
        finest["effective_magnetisation_A_per_m"],
        next_finest["effective_magnetisation_A_per_m"],
    )
    frequency_order_estimates = [
        solve_observed_order(
            fit_x,
            [metric["frequencies_hz"][field_index] for metric in ordered],
        )
        for field_index in range(len(finest["fields_t"]))
    ]
    frequency_observed_order = summarize_frequency_orders(frequency_order_estimates)
    max_richardson_frequency_error = max(
        estimate["richardson_relative_error_estimate"]
        for estimate in frequency_order_estimates
    )
    meff_observed_order = solve_observed_order(
        fit_x,
        [metric["effective_magnetisation_A_per_m"] for metric in ordered],
    )
    richardson_meff_error = meff_observed_order["richardson_relative_error_estimate"]
    fit_residual = max(
        linear_fit_residual(
            fit_x,
            [metric["frequencies_hz"][field_index] for metric in ordered],
        )
        for field_index in range(len(finest["fields_t"]))
    )
    monotone_field_count = 0
    for field_index in range(len(finest["fields_t"])):
        values = [metric["frequencies_hz"][field_index] for metric in ordered]
        increasing = all(left <= right for left, right in zip(values, values[1:]))
        decreasing = all(left >= right for left, right in zip(values, values[1:]))
        monotone_field_count += int(increasing or decreasing)
    if max_finest_two_delta > budget:
        fail(f"{kind} finest-two frequency delta {max_finest_two_delta:g} exceeds {budget:g}")
    if meff_delta > budget:
        fail(f"{kind} finest-two fitted M_eff delta {meff_delta:g} exceeds {budget:g}")
    if max_richardson_frequency_error > budget:
        fail(
            f"{kind} Richardson frequency error estimate "
            f"{max_richardson_frequency_error:g} exceeds {budget:g}"
        )
    if richardson_meff_error > budget:
        fail(
            f"{kind} Richardson fitted M_eff error estimate "
            f"{richardson_meff_error:g} exceeds {budget:g}"
        )
    if monotone_field_count != len(finest["fields_t"]) and fit_residual > 0.25 * budget:
        fail(
            f"{kind} sequence is non-monotone and asymptotic fit residual "
            f"{fit_residual:g} exceeds {0.25 * budget:g}"
        )
    return {
        "kind": kind,
        "level_count": len(ordered),
        "levels": levels,
        "fixed_value": fixed[0],
        "max_finest_two_frequency_delta": max_finest_two_delta,
        "finest_two_effective_magnetisation_delta": meff_delta,
        "frequency_observed_order": frequency_observed_order,
        "effective_magnetisation_observed_order": meff_observed_order,
        "max_richardson_frequency_error_estimate": max_richardson_frequency_error,
        "richardson_effective_magnetisation_error_estimate": richardson_meff_error,
        "max_linear_asymptotic_fit_residual": fit_residual,
        "monotone_field_count": monotone_field_count,
        "field_count": len(finest["fields_t"]),
        "rows": ordered,
    }


def write_sequence_csv(path: Path, sequence: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "sequence_kind",
                "level_index",
                "run_signature",
                "mesh_resolution_m",
                "airbox_size_m",
                "phi_dof_count",
                "max_relative_frequency_error",
                "effective_magnetisation_A_per_m",
                "effective_magnetisation_standard_uncertainty_A_per_m",
                "scaled_jacobian_condition_number",
                "poisson_residual_relative",
            ]
        )
        for index, row in enumerate(sequence["rows"]):
            writer.writerow(
                [
                    sequence["kind"],
                    index,
                    row["run_signature"],
                    f'{row["mesh_resolution_m"]:.17g}',
                    f'{row["airbox_size_m"]:.17g}',
                    int(row["phi_dof_count"]),
                    f'{row["relative_error"]:.17g}',
                    f'{row["effective_magnetisation_A_per_m"]:.17g}',
                    f'{row["effective_magnetisation_standard_uncertainty_A_per_m"]:.17g}',
                    f'{row["scaled_jacobian_condition_number"]:.17g}',
                    f'{row["poisson_residual"]:.17g}',
                ]
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mesh-root", action="append", type=Path, default=[])
    parser.add_argument("--airbox-root", action="append", type=Path, default=[])
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--max-relative-error", type=float, default=5.0e-2)
    parser.add_argument("--max-mesh-delta", type=float, default=2.0e-2)
    parser.add_argument("--max-airbox-delta", type=float, default=2.0e-2)
    parser.add_argument("--max-fitted-meff-relative-error", type=float, default=2.0e-2)
    parser.add_argument("--max-fitted-meff-relative-uncertainty", type=float, default=1.0e-2)
    parser.add_argument("--max-scaled-jacobian-condition-number", type=float, default=1.0e4)
    parser.add_argument("--minimum-field-count", type=int, default=15)
    parser.add_argument(
        "--execution-lane",
        choices=sorted(CERTIFIED_SOLVER_PROFILES),
        default="production_cpu",
        help="certified runtime lane expected in every solver artifact",
    )
    args = parser.parse_args()

    mesh_metrics = [
        verify_root(
            root,
            args.max_relative_error,
            args.minimum_field_count,
            args.execution_lane,
        )
        for root in args.mesh_root
    ]
    airbox_metrics = [
        verify_root(
            root,
            args.max_relative_error,
            args.minimum_field_count,
            args.execution_lane,
        )
        for root in args.airbox_root
    ]
    all_metrics = mesh_metrics + airbox_metrics
    if not all_metrics:
        fail("mesh and airbox convergence roots are required")
    ensure_common_fields(all_metrics)
    references = {metric["reference_magnetisation_A_per_m"] for metric in all_metrics}
    if len(references) != 1:
        fail("all convergence runs must use the same reference magnetisation")

    mesh = sequence_metrics("mesh", mesh_metrics, args.max_mesh_delta)
    airbox = sequence_metrics("airbox", airbox_metrics, args.max_airbox_delta)
    production = mesh["rows"][-1]
    reference_magnetisation = next(iter(references))
    meff_relative_error = relative_delta(
        production["effective_magnetisation_A_per_m"], reference_magnetisation
    )
    meff_relative_uncertainty = (
        production["effective_magnetisation_standard_uncertainty_A_per_m"]
        / abs(production["effective_magnetisation_A_per_m"])
    )
    if meff_relative_error > args.max_fitted_meff_relative_error:
        fail(
            f"fitted M_eff relative error {meff_relative_error:g} exceeds "
            f"{args.max_fitted_meff_relative_error:g}"
        )
    if meff_relative_uncertainty > args.max_fitted_meff_relative_uncertainty:
        fail(
            f"fitted M_eff relative uncertainty {meff_relative_uncertainty:g} exceeds "
            f"{args.max_fitted_meff_relative_uncertainty:g}"
        )
    condition_number = production["scaled_jacobian_condition_number"]
    if condition_number > args.max_scaled_jacobian_condition_number:
        fail(
            f"scaled Jacobian condition number {condition_number:g} exceeds "
            f"{args.max_scaled_jacobian_condition_number:g}"
        )

    summary = {
        "schema_version": "kittel_k0_periodic_airbox_convergence.v2",
        "status": "passed",
        "case_id": "K0-3",
        "demag_kind": "periodic_airbox_k0",
        "field_count": len(production["fields_t"]),
        "mesh": {key: value for key, value in mesh.items() if key != "rows"},
        "airbox": {key: value for key, value in airbox.items() if key != "rows"},
        "fit": {
            "effective_magnetisation_A_per_m": production[
                "effective_magnetisation_A_per_m"
            ],
            "reference_magnetisation_A_per_m": reference_magnetisation,
            "relative_error": meff_relative_error,
            "relative_standard_uncertainty": meff_relative_uncertainty,
            "scaled_jacobian_condition_number": condition_number,
        },
    }
    if args.output_dir is not None:
        output = args.output_dir / "validation" / "kittel_k0_pbc"
        write_sequence_csv(output / "mesh_convergence.v2.csv", mesh)
        write_sequence_csv(output / "airbox_convergence.v2.csv", airbox)
        output.mkdir(parents=True, exist_ok=True)
        (output / "fit.v2.json").write_text(json.dumps(summary["fit"], indent=2, sort_keys=True) + "\n")
        (output / "summary.v2.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
        (output / "independence_audit.v1.json").write_text(
            json.dumps(
                {
                    "schema_version": "kittel_k0_convergence_independence_audit.v1",
                    "status": "passed",
                    "mesh_fixed_airbox_size_m": mesh["fixed_value"],
                    "airbox_fixed_mesh_resolution_m": airbox["fixed_value"],
                    "mesh_run_signatures": [row["run_signature"] for row in mesh["rows"]],
                    "airbox_run_signatures": [row["run_signature"] for row in airbox["rows"]],
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
