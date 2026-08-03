#!/usr/bin/env python3
"""Validate FEM demag mesh-observable and airbox-extent convergence evidence."""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from collections import Counter
from pathlib import Path
from typing import Iterable, Mapping


BACKENDS = ("fem_cpu", "fem_gpu")
ALGORITHMS = ("projected_gradient_bb", "nonlinear_cg")
RESOLUTIONS = ("coarse", "medium", "fine")
LEGACY_SUITE_SCHEMA = "fullmag.fem_gpu.performance_fixture_suite.v1"
TYPED_SUITE_SCHEMA = "fullmag.fem_gpu.performance_fixture_suite.v2"
AIRBOX_EXTENT_SCALES = (1.0, 1.5, 2.0)
# The Task 0 meshes are performance fixtures with widely spaced resolutions and
# no analytical reference. These ceilings are deliberately only a fail-closed
# trend-integrity check: medium must be closer to fine than coarse, and no
# medium/fine observable may be almost completely decorrelated. They are not a
# quantitative physics-convergence tolerance and can never qualify Task 17.
MESH_TREND_RELATIVE_DELTA_CEILINGS = {
    "final_e_demag_j": 0.90,
    "max_h_demag": 0.90,
}
# The airbox sweep uses equal 0.5x extent increments at fixed hmax. Its tail
# delta must shrink and remain within this predeclared quantitative smoke bound.
AIRBOX_RELATIVE_DELTA_LIMITS = {
    "final_e_demag_j": 0.15,
    "max_h_demag": 0.15,
}
BASE_AIRBOX_SIZE_M = 1.0e-6
REQUIRED_OBSERVABLES = tuple(MESH_TREND_RELATIVE_DELTA_CEILINGS)


def _count_alias(
    mapping: Mapping[str, object],
    *,
    aliases: tuple[str, ...],
    label: str,
    require_explicit: bool,
) -> int:
    if require_explicit and aliases[0] not in mapping:
        raise ValueError(f"{label}: missing explicit {aliases[0]}")
    present = [mapping[name] for name in aliases if name in mapping]
    if not present:
        raise ValueError(f"{label}: missing topology count {aliases[0]}")
    try:
        values = [int(value) for value in present]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label}: topology count {aliases[0]} must be an integer") from exc
    if any(value != values[0] for value in values[1:]):
        raise ValueError(f"{label}: conflicting topology count aliases for {aliases[0]}")
    return values[0]


def _load_fixture_suite(path: Path) -> dict[str, dict[str, object]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{path}: invalid fixture suite JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{path}: fixture suite JSON must be an object")
    schema = payload.get("schema")
    if schema not in {LEGACY_SUITE_SCHEMA, TYPED_SUITE_SCHEMA}:
        raise ValueError(f"{path}: unsupported fixture suite schema {schema!r}")
    fixtures = payload.get("fixtures")
    if not isinstance(fixtures, list):
        raise ValueError(f"{path}: fixture suite JSON is missing fixtures")
    by_resolution: dict[str, dict[str, object]] = {}
    for fixture in fixtures:
        if not isinstance(fixture, dict):
            raise ValueError(f"{path}: every fixture must be an object")
        resolution = fixture.get("resolution")
        if not isinstance(resolution, str) or resolution in by_resolution:
            raise ValueError(f"{path}: duplicate or invalid fixture resolution {resolution!r}")
        for key in ("solver_mesh_signature", "problem_ir_sha256"):
            if key not in fixture:
                raise ValueError(f"{path}: {resolution} fixture is missing {key}")
        fixture = dict(fixture)
        fixture["_suite_schema"] = schema
        require_explicit = schema == TYPED_SUITE_SCHEMA
        fixture["_solver_mesh_node_count"] = _count_alias(
            fixture,
            aliases=("solver_mesh_node_count", "node_count"),
            label=f"{path}: {resolution}",
            require_explicit=require_explicit,
        )
        fixture["_solver_mesh_cell_count"] = _count_alias(
            fixture,
            aliases=("solver_mesh_cell_count", "cell_count", "element_count"),
            label=f"{path}: {resolution}",
            require_explicit=require_explicit,
        )
        for field, aliases in (
            (
                "_solver_mesh_facet_count",
                ("solver_mesh_facet_count", "facet_count", "boundary_face_count"),
            ),
            (
                "_solver_mesh_exterior_facet_count",
                ("solver_mesh_exterior_facet_count", "exterior_facet_count"),
            ),
            (
                "_solver_mesh_interface_facet_count",
                ("solver_mesh_interface_facet_count", "interface_facet_count"),
            ),
        ):
            if not require_explicit and not any(name in fixture for name in aliases):
                fixture[field] = 0
            else:
                fixture[field] = _count_alias(
                    fixture,
                    aliases=aliases,
                    label=f"{path}: {resolution}",
                    require_explicit=require_explicit,
                )
        by_resolution[resolution] = fixture
    if set(by_resolution) != set(RESOLUTIONS):
        raise ValueError(
            f"{path}: fixture resolutions must be exactly {list(RESOLUTIONS)}"
        )
    return by_resolution


def _read_csv(path: Path, *, required_fields: Iterable[str]) -> list[dict[str, str]]:
    try:
        with path.open(encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            fieldnames = reader.fieldnames
            if fieldnames is None:
                raise ValueError(f"{path}: CSV has no header")
            missing = sorted(set(required_fields) - set(fieldnames))
            if missing:
                raise ValueError(f"{path}: CSV is missing fields {missing}")
            rows = list(reader)
    except (OSError, csv.Error) as exc:
        raise ValueError(f"{path}: invalid CSV: {exc}") from exc
    if not rows:
        raise ValueError(f"{path}: CSV has no data rows")
    if any(None in row or any(value is None for value in row.values()) for row in rows):
        raise ValueError(f"{path}: malformed CSV row")
    return rows


def _integer(row: Mapping[str, str], field: str, *, label: str) -> int:
    try:
        value = int(row[field])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"{label}: {field} must be an integer") from exc
    return value


def _finite_float(row: Mapping[str, str], field: str, *, label: str) -> float:
    try:
        value = float(row[field])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"{label}: {field} must be numeric") from exc
    if not math.isfinite(value):
        raise ValueError(f"{label}: {field} must be finite")
    return value


def _require_exact_cartesian_keys(
    *,
    actual: Iterable[tuple[object, ...]],
    expected: set[tuple[object, ...]],
    label: str,
) -> None:
    counts = Counter(actual)
    actual_keys = set(counts)
    missing = sorted(expected - actual_keys)
    unexpected = sorted(actual_keys - expected)
    duplicates = sorted(key for key, count in counts.items() if count != 1)
    if missing or unexpected or duplicates:
        raise ValueError(
            f"{label}: Cartesian key mismatch; missing={missing}, "
            f"unexpected={unexpected}, duplicates={duplicates}"
        )


def _relative_delta(left: float, right: float) -> float:
    denominator = max(abs(left), abs(right), 1.0e-300)
    return abs(left - right) / denominator


def _validate_mesh_rows(
    *,
    fixtures: Mapping[str, Mapping[str, object]],
    mesh_inputs: Mapping[str, tuple[Path, Path]],
    repeat_count: int,
) -> tuple[list[dict[str, str]], list[dict[str, object]]]:
    if repeat_count <= 0:
        raise ValueError("repeat_count must be positive")
    if set(mesh_inputs) != set(RESOLUTIONS):
        raise ValueError(f"mesh inputs must be exactly {list(RESOLUTIONS)}")
    required = {
        "status",
        "solver_mesh_signature",
        "qualification_fixture_problem_ir_sha256",
        "backend",
        "relaxation_algorithm",
        "repeat_index",
        *REQUIRED_OBSERVABLES,
    }
    measured_all: list[dict[str, str]] = []
    evidence: list[dict[str, object]] = []
    for resolution in RESOLUTIONS:
        fixture = fixtures[resolution]
        warmup_path, measured_path = mesh_inputs[resolution]
        warmup = _read_csv(warmup_path, required_fields=required)
        measured = _read_csv(measured_path, required_fields=required)
        signature = str(fixture["solver_mesh_signature"])
        problem_ir_sha256 = str(fixture["problem_ir_sha256"])
        node_count = int(fixture["_solver_mesh_node_count"])
        element_count = int(fixture["_solver_mesh_cell_count"])
        require_explicit = fixture.get("_suite_schema") == TYPED_SUITE_SCHEMA
        for phase, rows in (("warmup", warmup), ("measured", measured)):
            for index, row in enumerate(rows):
                label = f"{resolution}/{phase}/row[{index}]"
                if row["status"] != "ok":
                    raise ValueError(f"{label}: status must be ok")
                row_node_count = _count_alias(
                    row,
                    aliases=("solver_mesh_node_count", "node_count"),
                    label=label,
                    require_explicit=require_explicit,
                )
                row_cell_count = _count_alias(
                    row,
                    aliases=("solver_mesh_cell_count", "cell_count", "element_count"),
                    label=label,
                    require_explicit=require_explicit,
                )
                if (
                    row["solver_mesh_signature"] != signature
                    or row["qualification_fixture_problem_ir_sha256"]
                    != problem_ir_sha256
                    or row_node_count != node_count
                    or row_cell_count != element_count
                ):
                    raise ValueError(f"{label}: fixture identity mismatch")
                for observable in REQUIRED_OBSERVABLES:
                    _finite_float(row, observable, label=label)
        warmup_expected = {
            (signature, backend, algorithm, 0)
            for backend in BACKENDS
            for algorithm in ALGORITHMS
        }
        measured_expected = {
            (signature, backend, algorithm, repeat_index)
            for backend in BACKENDS
            for algorithm in ALGORITHMS
            for repeat_index in range(repeat_count)
        }
        key = lambda row: (
            row["solver_mesh_signature"],
            row["backend"],
            row["relaxation_algorithm"],
            _integer(row, "repeat_index", label=f"{resolution}/key"),
        )
        _require_exact_cartesian_keys(
            actual=(key(row) for row in warmup),
            expected=warmup_expected,
            label=f"{resolution}/warmup",
        )
        _require_exact_cartesian_keys(
            actual=(key(row) for row in measured),
            expected=measured_expected,
            label=f"{resolution}/measured",
        )
        for row in measured:
            row["_qualification_resolution"] = resolution
        measured_all.extend(measured)
        evidence.append(
            {
                "resolution": resolution,
                "solver_mesh_signature": signature,
                "solver_mesh_node_count": node_count,
                "solver_mesh_cell_count": element_count,
                "solver_mesh_facet_count": fixture["_solver_mesh_facet_count"],
                "solver_mesh_exterior_facet_count": fixture[
                    "_solver_mesh_exterior_facet_count"
                ],
                "solver_mesh_interface_facet_count": fixture[
                    "_solver_mesh_interface_facet_count"
                ],
                "warmup_row_count": len(warmup),
                "measured_row_count": len(measured),
                "status": "pass",
            }
        )
    return measured_all, evidence


def _mesh_convergence_metrics(
    rows: list[dict[str, str]],
) -> tuple[list[dict[str, object]], list[str]]:
    metrics: list[dict[str, object]] = []
    failures: list[str] = []
    for backend in BACKENDS:
        for algorithm in ALGORITHMS:
            selected = {
                resolution: [
                    row
                    for row in rows
                    if row["_qualification_resolution"] == resolution
                    and row["backend"] == backend
                    and row["relaxation_algorithm"] == algorithm
                ]
                for resolution in RESOLUTIONS
            }
            for observable, limit in MESH_TREND_RELATIVE_DELTA_CEILINGS.items():
                medians = {
                    resolution: statistics.median(
                        _finite_float(
                            row,
                            observable,
                            label=f"mesh/{backend}/{algorithm}/{resolution}",
                        )
                        for row in selected[resolution]
                    )
                    for resolution in RESOLUTIONS
                }
                coarse_to_fine = _relative_delta(medians["coarse"], medians["fine"])
                medium_to_fine = _relative_delta(medians["medium"], medians["fine"])
                passed = not (
                    medium_to_fine > limit
                    or medium_to_fine > coarse_to_fine + 1.0e-12
                )
                if not passed:
                    failures.append(
                        f"mesh trend check failed for {backend}/{algorithm}/{observable}: "
                        f"medium-to-fine={medium_to_fine:.6g}, "
                        f"coarse-to-fine={coarse_to_fine:.6g}, limit={limit:.6g}"
                    )
                metrics.append(
                    {
                        "backend": backend,
                        "algorithm": algorithm,
                        "observable": observable,
                        "medians": medians,
                        "coarse_to_fine_relative_delta": coarse_to_fine,
                        "medium_to_fine_relative_delta": medium_to_fine,
                        "maximum_medium_to_fine_relative_delta": limit,
                        "status": "pass" if passed else "fail",
                    }
                )
    return metrics, failures


def _validate_airbox_sweep(
    airbox_inputs: Mapping[float, Path],
) -> tuple[list[dict[str, str]], list[dict[str, object]], list[str]]:
    scales = tuple(sorted(airbox_inputs))
    if scales != AIRBOX_EXTENT_SCALES:
        raise ValueError(
            f"airbox inputs must use exact scales {list(AIRBOX_EXTENT_SCALES)}"
        )
    required = {
        "status",
        "backend",
        "relaxation_algorithm",
        "repeat_index",
        "qualification_airbox_extent_scale",
        "qualification_airbox_size_x_m",
        "qualification_airbox_size_y_m",
        "qualification_airbox_size_z_m",
        "executed_problem_ir_sha256",
        *REQUIRED_OBSERVABLES,
    }
    all_rows: list[dict[str, str]] = []
    problem_ir_by_scale: dict[float, str] = {}
    for scale in scales:
        rows = _read_csv(airbox_inputs[scale], required_fields=required)
        expected_keys = {
            (scale, backend, "nonlinear_cg", 0) for backend in BACKENDS
        }
        actual_keys = []
        ir_hashes: set[str] = set()
        for index, row in enumerate(rows):
            label = f"airbox/{scale}/row[{index}]"
            actual_scale = _finite_float(
                row, "qualification_airbox_extent_scale", label=label
            )
            if row["status"] != "ok" or not math.isclose(
                actual_scale, scale, rel_tol=0.0, abs_tol=1.0e-12
            ):
                raise ValueError(f"{label}: status or extent-scale mismatch")
            expected_extent = BASE_AIRBOX_SIZE_M * scale
            for axis in "xyz":
                actual_extent = _finite_float(
                    row, f"qualification_airbox_size_{axis}_m", label=label
                )
                if not math.isclose(
                    actual_extent, expected_extent, rel_tol=1.0e-12, abs_tol=1.0e-18
                ):
                    raise ValueError(f"{label}: airbox extent provenance mismatch")
            problem_ir_sha256 = row["executed_problem_ir_sha256"]
            if len(problem_ir_sha256) != 64 or any(
                character not in "0123456789abcdef" for character in problem_ir_sha256
            ):
                raise ValueError(f"{label}: invalid executed ProblemIR SHA-256")
            ir_hashes.add(problem_ir_sha256)
            for observable in REQUIRED_OBSERVABLES:
                _finite_float(row, observable, label=label)
            actual_keys.append(
                (
                    actual_scale,
                    row["backend"],
                    row["relaxation_algorithm"],
                    _integer(row, "repeat_index", label=label),
                )
            )
        _require_exact_cartesian_keys(
            actual=actual_keys,
            expected=expected_keys,
            label=f"airbox/{scale}",
        )
        if len(ir_hashes) != 1:
            raise ValueError(f"airbox/{scale}: CPU/GPU ProblemIR identity mismatch")
        problem_ir_by_scale[scale] = next(iter(ir_hashes))
        all_rows.extend(rows)
    if len(set(problem_ir_by_scale.values())) != len(scales):
        raise ValueError("airbox sweep ProblemIR identities are not distinct")

    metrics: list[dict[str, object]] = []
    failures: list[str] = []
    for backend in BACKENDS:
        for observable, limit in AIRBOX_RELATIVE_DELTA_LIMITS.items():
            values = {
                scale: statistics.median(
                    _finite_float(
                        row,
                        observable,
                        label=f"airbox/{backend}/{scale}/{observable}",
                    )
                    for row in all_rows
                    if math.isclose(
                        float(row["qualification_airbox_extent_scale"]), scale
                    )
                    and row["backend"] == backend
                )
                for scale in scales
            }
            leading_delta = _relative_delta(values[scales[0]], values[scales[1]])
            tail_delta = _relative_delta(values[scales[1]], values[scales[2]])
            passed = not (
                tail_delta > limit or tail_delta > leading_delta + 1.0e-12
            )
            if not passed:
                failures.append(
                    f"airbox convergence failed for {backend}/{observable}: "
                    f"tail={tail_delta:.6g}, leading={leading_delta:.6g}, "
                    f"limit={limit:.6g}"
                )
            metrics.append(
                {
                    "backend": backend,
                    "observable": observable,
                    "values": {str(scale): values[scale] for scale in scales},
                    "leading_relative_delta": leading_delta,
                    "tail_relative_delta": tail_delta,
                    "maximum_tail_relative_delta": limit,
                    "status": "pass" if passed else "fail",
                }
            )
    return all_rows, metrics, failures


def validate_qualification(
    *,
    fixture_suite_path: Path,
    mesh_inputs: Mapping[str, tuple[Path, Path]],
    airbox_inputs: Mapping[float, Path],
    repeat_count: int,
    output_path: Path | None = None,
) -> dict[str, object]:
    fixtures = _load_fixture_suite(fixture_suite_path)
    mesh_rows, mesh_evidence = _validate_mesh_rows(
        fixtures=fixtures,
        mesh_inputs=mesh_inputs,
        repeat_count=repeat_count,
    )
    mesh_metrics, mesh_failures = _mesh_convergence_metrics(mesh_rows)
    airbox_rows, airbox_metrics, airbox_failures = _validate_airbox_sweep(
        airbox_inputs
    )
    failures = mesh_failures + airbox_failures
    summary: dict[str, object] = {
        "schema": "fullmag.fem.demag_mesh_airbox_convergence.v2",
        "status": "fail" if failures else "pass",
        "qualification_status": "no_go",
        "validation_state": "box_trend_regression",
        "promotion_policy": "supplemental_only_never_analytic_qualification",
        "measured_repeat_count": repeat_count,
        "mesh_matrix": {
            "status": "pass",
            "warmup_row_count": sum(
                int(entry["warmup_row_count"]) for entry in mesh_evidence
            ),
            "measured_row_count": len(mesh_rows),
            "exact_cartesian_keys": True,
            "evidence": mesh_evidence,
        },
        "mesh_observable_convergence": {
            "status": (
                "fail" if mesh_failures else "trend_only_nonqualifying"
            ),
            "quantitative_convergence_validated": False,
            "reason": (
                "Task 0 performance fixtures have widely spaced resolutions and "
                "no analytical reference"
            ),
            "reference_resolution": "fine",
            "acceptance": {
                "classification": "trend_integrity_only",
                "medium_to_fine_relative_delta_ceilings": (
                    MESH_TREND_RELATIVE_DELTA_CEILINGS
                ),
                "require_medium_closer_to_fine_than_coarse": True,
            },
            "metrics": mesh_metrics,
            "failures": mesh_failures,
        },
        "airbox_extent_sweep": {
            "status": "fail" if airbox_failures else "pass",
            "scales": list(AIRBOX_EXTENT_SCALES),
            "row_count": len(airbox_rows),
            "exact_cartesian_keys": True,
            "acceptance": {
                "tail_relative_delta_limits": AIRBOX_RELATIVE_DELTA_LIMITS,
                "require_tail_no_larger_than_leading": True,
            },
            "metrics": airbox_metrics,
            "failures": airbox_failures,
        },
    }
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    if failures:
        raise ValueError("; ".join(failures))
    return summary


def _mesh_input(value: str) -> tuple[str, tuple[Path, Path]]:
    parts = value.split(":", 2)
    if len(parts) != 3:
        raise argparse.ArgumentTypeError(
            "mesh input must be RESOLUTION:WARMUP_CSV:MEASURED_CSV"
        )
    return parts[0], (Path(parts[1]), Path(parts[2]))


def _airbox_input(value: str) -> tuple[float, Path]:
    parts = value.split(":", 1)
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("airbox input must be SCALE:CSV")
    try:
        scale = float(parts[0])
    except ValueError as exc:
        raise argparse.ArgumentTypeError("airbox scale must be numeric") from exc
    return scale, Path(parts[1])


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-suite", type=Path, required=True)
    parser.add_argument("--mesh-input", type=_mesh_input, action="append", required=True)
    parser.add_argument("--airbox-input", type=_airbox_input, action="append", required=True)
    parser.add_argument("--repeat", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        summary = validate_qualification(
            fixture_suite_path=args.fixture_suite,
            mesh_inputs=dict(args.mesh_input),
            airbox_inputs=dict(args.airbox_input),
            repeat_count=args.repeat,
            output_path=args.output,
        )
    except ValueError as exc:
        print(f"FAIL: {exc}")
        return 1
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
