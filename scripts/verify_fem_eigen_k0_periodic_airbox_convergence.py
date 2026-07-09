#!/usr/bin/env python3
"""Verify a multi-run PA-E4b K0 periodic-airbox convergence bundle."""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"error: {message}")


def load_json(path: Path) -> dict[str, object]:
    if not path.is_file():
        fail(f"missing required file: {path}")
    try:
        value = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON in {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"{path} must contain a JSON object")
    return value


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


def load_convergence_row(root: Path) -> dict[str, str]:
    convergence_path = root / "validation" / "kittel_k0_pbc" / "convergence.v1.csv"
    if not convergence_path.is_file():
        fail(f"missing convergence table: {convergence_path}")
    reader = csv.DictReader(convergence_path.read_text().splitlines())
    rows = list(reader)
    if len(rows) != 1:
        fail(f"{convergence_path} must contain exactly one data row for this multi-run verifier")
    return rows[0]


def verify_root(root: Path, max_relative_error: float) -> dict[str, float]:
    solver = load_json(root / "eigen" / "diagnostics" / "solver.v1.json")
    if solver.get("solver_adapter") != "k0_poisson_airbox_cpu_full_coupled_slepc":
        fail(f"{root}: solver_adapter must be k0_poisson_airbox_cpu_full_coupled_slepc")
    if solver.get("solver_model") != "k0_poisson_airbox_cpu_full_coupled_slepc":
        fail(f"{root}: solver_model must be k0_poisson_airbox_cpu_full_coupled_slepc")
    if solver.get("resolved_solver_family") != "k0_poisson_airbox_full_coupled":
        fail(f"{root}: resolved_solver_family must be k0_poisson_airbox_full_coupled")
    if solver.get("demag_kind") != "periodic_airbox_k0":
        fail(f"{root}: demag_kind must be periodic_airbox_k0")
    if solver.get("execution_lane") != "production_cpu":
        fail(f"{root}: execution_lane must be production_cpu")

    summary = load_json(root / "validation" / "kittel_k0_pbc" / "summary.v1.json")
    if summary.get("case_id") != "K0-3":
        fail(f"{root}: summary case_id must be K0-3")
    if summary.get("demag_kind") != "periodic_airbox_k0":
        fail(f"{root}: summary demag_kind must be periodic_airbox_k0")
    relative_error = finite_float(
        summary.get("max_relative_frequency_error"),
        "summary.max_relative_frequency_error",
        root,
    )
    if relative_error > max_relative_error:
        fail(f"{root}: max_relative_frequency_error {relative_error:g} exceeds {max_relative_error:g}")

    row = load_convergence_row(root)
    if row.get("case_id") != "K0-3" or row.get("demag_kind") != "periodic_airbox_k0":
        fail(f"{root}: convergence row must be K0-3 periodic_airbox_k0")
    mesh_resolution = positive_float(row.get("mesh_resolution_m"), "mesh_resolution_m", root)
    phi_dof_count = positive_float(row.get("phi_dof_count"), "phi_dof_count", root)
    poisson_residual = finite_float(row.get("poisson_residual_relative"), "poisson_residual_relative", root)
    if poisson_residual < 0.0 or poisson_residual > 1.0e-8:
        fail(f"{root}: poisson_residual_relative must be in [0, 1e-8]")

    return {
        "mesh_resolution_m": mesh_resolution,
        "phi_dof_count": phi_dof_count,
        "relative_error": relative_error,
        "poisson_residual": poisson_residual,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-relative-error", type=float, default=5.0e-2)
    parser.add_argument("roots", nargs="+", type=Path)
    args = parser.parse_args()

    if len(args.roots) < 2:
        fail("at least two artifact roots are required for convergence verification")

    metrics = [verify_root(root, args.max_relative_error) for root in args.roots]
    mesh_resolutions = {metric["mesh_resolution_m"] for metric in metrics}
    if len(mesh_resolutions) < 2:
        fail("convergence verification requires at least two distinct mesh resolutions")
    if max(metric["phi_dof_count"] for metric in metrics) <= 0:
        fail("convergence verification requires positive phi DOFs")

    print(
        json.dumps(
            {
                "status": "passed",
                "case_id": "K0-3",
                "demag_kind": "periodic_airbox_k0",
                "sample_count": len(metrics),
                "mesh_resolution_m": sorted(mesh_resolutions),
                "max_relative_error": max(metric["relative_error"] for metric in metrics),
                "max_poisson_residual": max(metric["poisson_residual"] for metric in metrics),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
