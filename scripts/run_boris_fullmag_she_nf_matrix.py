#!/usr/bin/env python3
"""Run and validate the bounded BORIS/Fullmag N/F comparison matrix.

The matrix is deliberately fail-closed: a solver failure is retained as a
per-run ``not_run`` record and the aggregate validator refuses to call the
matrix qualified until every resolution/tolerance tuple has comparable,
finite observables.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
from typing import Any, Sequence

from compare_boris_fullmag_she_nf import compare_transport_artifacts, load_fullmag_m2_artifact, normalize_boris_artifact
from run_boris_nf_interface import run_boris_case
from run_fullmag_m2_nf_reference import Resolution, run_fullmag_nf_reference
from boris_nf_interface_smoke import NfCaseConfig


DEFAULT_RESOLUTIONS = (
    Resolution(10, 4, 2, 2),
    Resolution(20, 8, 4, 4),
    Resolution(40, 16, 8, 8),
)
DEFAULT_TOLERANCES = (1.0e-8, 1.0e-10)


def _finite(value: object, label: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
        raise ValueError(f"{label} must be finite")
    return float(value)


def _run_key(resolution: Resolution, tolerance: float) -> str:
    return (
        f"{resolution.nx}x{resolution.ny}x{resolution.nz_n}+{resolution.nz_f}"
        f"__tol-{tolerance:.0e}"
    )


def _sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


def run_resolution_matrix(
    resolutions: Sequence[Resolution],
    tolerances: Sequence[float],
    boris_build_root: Path,
    fullmag_binary: Path,
    report_root: Path,
    *,
    device: str = "cuda",
) -> dict[str, object]:
    """Run every declared tuple and retain failures without fabricating fields."""

    if not resolutions:
        raise ValueError("matrix requires at least one resolution")
    if device not in {"cpu", "cuda"}:
        raise ValueError("matrix device must be cpu or cuda")
    normalized_tolerances = tuple(_finite(value, "tolerance") for value in tolerances)
    if not normalized_tolerances or any(value <= 0.0 for value in normalized_tolerances):
        raise ValueError("matrix tolerances must be finite and positive")
    report_root = report_root.expanduser().resolve()
    report_root.mkdir(parents=True, exist_ok=True)
    runtime_container = os.environ.get("FULLMAG_BORIS_RUNTIME_CONTAINER")
    runs: list[dict[str, object]] = []
    for resolution in resolutions:
        for tolerance in normalized_tolerances:
            run_key = _run_key(resolution, tolerance)
            run_root = report_root / run_key
            if run_root.exists() and any(run_root.iterdir()):
                raise RuntimeError(f"matrix run directory is non-empty: {run_root}")
            run_root.mkdir(parents=True, exist_ok=True)
            boris_root = run_root / "boris"
            fullmag_root = run_root / "fullmag"
            entry: dict[str, object] = {
                "run_key": run_key,
                "device": device,
                "resolution": {
                    "nx": resolution.nx,
                    "ny": resolution.ny,
                    "nz_n": resolution.nz_n,
                    "nz_f": resolution.nz_f,
                    "cell_m": list(resolution.cell_m),
                },
                "tolerance": tolerance,
                "status": "not_run",
            }
            try:
                boris_config = NfCaseConfig(
                    nx=resolution.nx,
                    ny=resolution.ny,
                    nz_n=resolution.nz_n,
                    nz_f=resolution.nz_f,
                    cell_x_m=resolution.cell_m[0],
                    cell_y_m=resolution.cell_m[1],
                    cell_z_m=resolution.cell_m[2],
                    transport_tolerance=tolerance,
                    output_dir=boris_root,
                )
                boris_summary = run_boris_case(
                    boris_config,
                    boris_build_root,
                    boris_root,
                    device,
                    runtime_container=runtime_container,
                )
                fullmag_artifact = run_fullmag_nf_reference(
                    fullmag_binary,
                    Resolution(
                        resolution.nx,
                        resolution.ny,
                        resolution.nz_n,
                        resolution.nz_f,
                        resolution.cell_m,
                        solver_tolerance=tolerance,
                    ),
                    fullmag_root,
                )
                report = compare_transport_artifacts(
                    normalize_boris_artifact(boris_summary),
                    load_fullmag_m2_artifact(fullmag_artifact),
                )
                _write_json(run_root / "comparison.json", report)
                entry.update(
                    {
                        "status": report["status"],
                        "boris_summary": str(boris_summary),
                        "fullmag_artifact": str(fullmag_artifact),
                        "comparison": {
                            "status": report["status"],
                            "observables": report["observables"],
                            "incomparable_observables": report.get("incomparable_observables", {}),
                        },
                        "scenario_sha256": _sha256(boris_root / "scenario.json"),
                        "runtime_sha256": _sha256(boris_root / "runtime.json"),
                        "fullmag_binary_sha256": _sha256(fullmag_binary.resolve()),
                    }
                )
            except Exception as error:  # preserve exact solver failure for the aggregate report
                entry["reason"] = str(error)
                _write_json(run_root / "failure.json", entry)
            runs.append(entry)
    summary: dict[str, object] = {
        "schema_version": "fullmag.boris_fullmag_she_nf_matrix.v1",
        "qualification": {"status": "diagnostic", "reason": "matrix is fail-closed"},
        "device": device,
        "declared_resolutions": len(resolutions),
        "declared_tolerances": list(normalized_tolerances),
        "runs": runs,
    }
    _write_json(report_root / "matrix.json", summary)
    return summary


def _run_sort_key(entry: dict[str, object]) -> tuple[int, int, int, int, float]:
    resolution = entry["resolution"]
    if not isinstance(resolution, dict):
        raise ValueError("matrix resolution entry is malformed")
    return (
        int(resolution["nx"]),
        int(resolution["ny"]),
        int(resolution["nz_n"]),
        int(resolution["nz_f"]),
        float(entry["tolerance"]),
    )


def validate_matrix_summary(summary: dict[str, object]) -> None:
    """Require the complete six-run finite, comparable and monotone matrix."""

    resolutions = summary.get("declared_resolutions")
    tolerances = summary.get("declared_tolerances")
    runs = summary.get("runs")
    if resolutions != 3:
        raise ValueError("matrix requires three resolutions")
    if not isinstance(tolerances, list) or len(tolerances) != 2:
        raise ValueError("matrix requires two tolerances")
    if not isinstance(runs, list) or len(runs) != 6:
        raise ValueError("matrix must contain six resolution/tolerance runs")
    identities: set[str] = set()
    for entry in runs:
        if not isinstance(entry, dict):
            raise ValueError("matrix run entry is malformed")
        run_key = entry.get("run_key")
        if not isinstance(run_key, str) or run_key in identities:
            raise ValueError("matrix contains a duplicate run identity")
        identities.add(run_key)
        if entry.get("status") != "diagnostic_match":
            raise ValueError(f"matrix run {run_key} is not diagnostic_match")
        comparison = entry.get("comparison")
        if not isinstance(comparison, dict) or comparison.get("status") != "diagnostic_match":
            raise ValueError(f"matrix run {run_key} has no comparable report")
        observables = comparison.get("observables")
        if not isinstance(observables, dict) or not observables:
            raise ValueError(f"matrix run {run_key} has no observables")
        for name, metric in observables.items():
            if not isinstance(metric, dict):
                raise ValueError(f"matrix observable {name} is malformed")
            for metric_name in ("max_absolute_error", "max_relative_error", "normalized_l2_error", "endpoint_error"):
                _finite(metric.get(metric_name), f"{run_key}.{name}.{metric_name}")
    ordered = sorted(runs, key=_run_sort_key)
    by_resolution: dict[tuple[int, int, int, int], list[dict[str, object]]] = {}
    for entry in ordered:
        resolution = entry["resolution"]
        assert isinstance(resolution, dict)
        key = tuple(int(resolution[name]) for name in ("nx", "ny", "nz_n", "nz_f"))
        by_resolution.setdefault(key, []).append(entry)
    if len(by_resolution) != 3 or any(len(items) != 2 for items in by_resolution.values()):
        raise ValueError("matrix does not contain two tolerances for each of three resolutions")
    for key, entries in by_resolution.items():
        loose, tight = sorted(entries, key=lambda item: float(item["tolerance"]), reverse=True)
        loose_obs = loose["comparison"]["observables"]
        tight_obs = tight["comparison"]["observables"]
        assert isinstance(loose_obs, dict) and isinstance(tight_obs, dict)
        for name in loose_obs:
            loose_error = _finite(loose_obs[name]["max_relative_error"], f"{key}.{name}.loose")
            tight_error = _finite(tight_obs[name]["max_relative_error"], f"{key}.{name}.tight")
            if tight_error > loose_error + 1.0e-15:
                raise ValueError(f"matrix error is not monotone across tolerance for {key}/{name}")
    resolution_groups = sorted(by_resolution.items())
    for index in range(1, len(resolution_groups)):
        previous = resolution_groups[index - 1][1][0]["comparison"]["observables"]
        current = resolution_groups[index][1][0]["comparison"]["observables"]
        assert isinstance(previous, dict) and isinstance(current, dict)
        for name in previous:
            if _finite(current[name]["max_relative_error"], f"{name}.fine") > _finite(
                previous[name]["max_relative_error"], f"{name}.coarse"
            ) + 1.0e-15:
                raise ValueError(f"matrix error is not monotone across resolution for {name}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boris-build-root", type=Path, required=True)
    parser.add_argument("--fullmag", type=Path, required=True)
    parser.add_argument("--report-root", type=Path, required=True)
    parser.add_argument(
        "--device",
        choices=("cpu", "cuda"),
        default=os.environ.get("FULLMAG_BORIS_DEVICE", "cuda"),
    )
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    matrix_path = args.report_root / "matrix.json"
    if args.validate_only:
        summary = json.loads(matrix_path.read_text(encoding="utf-8"))
        validate_matrix_summary(summary)
    else:
        summary = run_resolution_matrix(
            DEFAULT_RESOLUTIONS,
            DEFAULT_TOLERANCES,
            args.boris_build_root,
            args.fullmag,
            args.report_root,
            device=args.device,
        )
        validate_matrix_summary(summary)
    print(json.dumps({"status": "diagnostic_match", "matrix": str(matrix_path)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
