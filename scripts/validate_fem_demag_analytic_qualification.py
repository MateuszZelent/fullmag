#!/usr/bin/env python3
"""Fail-closed validator for prescribed-state FEM Poisson-demag qualification.

This gate intentionally accepts only a managed artifact produced by one
``compute_fields`` evaluation of a prescribed uniform magnetization.  It does
not reinterpret relaxation output as an analytic demag measurement.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable


SCHEMA = "fullmag.fem_demag_analytic_qualification.v1"
BACKENDS = ("fem_cpu", "fem_gpu")
REFINEMENTS = ("coarse", "medium", "fine")
AIRBOX_SCALES = (1.5, 2.0, 2.5, 3.0)
TIMING_REPEATS = (0, 1, 2)
FINE_FACTOR_RTOL = 0.05
FINE_ENERGY_RTOL = 0.05
ELLIPSOID_SUM_ATOL = 0.05
CPU_GPU_RTOL = 1.0e-6
RESIDUAL_ATOL = 1.0e-12
SHA256_RE = re.compile(r"[0-9a-f]{64}")


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _object(value: object, label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be an object")
    return value


def _list(value: object, label: str) -> list[Any]:
    _require(isinstance(value, list), f"{label} must be a list")
    return value


def _finite(value: object, label: str) -> float:
    _require(isinstance(value, (int, float)) and not isinstance(value, bool), f"{label} must be numeric")
    numeric = float(value)
    _require(math.isfinite(numeric), f"{label} must be finite")
    return numeric


def _relative_error(actual: float, expected: float) -> float:
    return abs(actual - expected) / max(abs(expected), 1.0e-300)


def _sha256(value: object, label: str) -> str:
    _require(isinstance(value, str) and SHA256_RE.fullmatch(value) is not None, f"{label} must be a lowercase SHA-256")
    return value


@lru_cache(maxsize=None)
def _osborn_factors(axes: tuple[float, float, float]) -> tuple[float, float, float]:
    """Compute Osborn factors directly from the semi-axis integral."""
    _require(all(axis > 0.0 and math.isfinite(axis) for axis in axes), "ellipsoid semi_axes_m must be positive finite values")
    if max(axes) / min(axes) <= 1.0 + 1.0e-12:
        return (1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0)
    scale = max(axis * axis for axis in axes)
    intervals = 8192
    factors: list[float] = []
    product = axes[0] * axes[1] * axes[2]
    for axis in axes:
        integral = 0.0
        for index in range(intervals + 1):
            t = index / intervals
            if index == intervals:
                integrand = 0.0
            else:
                denominator = 1.0 - t
                s = scale * t / denominator
                radius = math.sqrt(math.prod(s + other * other for other in axes))
                integrand = scale / (denominator * denominator * (s + axis * axis) * radius)
            weight = 1.0 if index in (0, intervals) else (4.0 if index % 2 else 2.0)
            integral += weight * integrand
        factors.append(0.5 * product * integral / (3.0 * intervals))
    return tuple(factors)  # type: ignore[return-value]


def _case_oracle(case: dict[str, Any], axis: str) -> float:
    kind = case.get("kind")
    axes = _list(case.get("semi_axes_m"), f"suite case {case.get('case_id')}.semi_axes_m")
    _require(len(axes) == 3, f"suite case {case.get('case_id')}.semi_axes_m must contain three values")
    values = tuple(_finite(value, f"suite case {case.get('case_id')}.semi_axes_m") for value in axes)
    _require(axis in ("x", "y", "z"), f"invalid axis {axis}")
    if kind == "sphere":
        _require(max(values) / min(values) <= 1.0 + 1.0e-12, f"suite sphere {case.get('case_id')} must have equal semi-axes")
        return 1.0 / 3.0
    _require(kind == "ellipsoid", f"suite case {case.get('case_id')} kind must be sphere or ellipsoid")
    return _osborn_factors(values)[{"x": 0, "y": 1, "z": 2}[axis]]


def _identity(row: dict[str, Any]) -> tuple[str, str, str, float, str]:
    return (
        str(row.get("case_id")),
        str(row.get("axis")),
        str(row.get("mesh_refinement")),
        _finite(row.get("airbox_scale"), "physics row airbox_scale"),
        str(row.get("backend")),
    )


def _pair_identity(row: dict[str, Any]) -> tuple[str, str, str, float]:
    case_id, axis, refinement, airbox_scale, _ = _identity(row)
    return case_id, axis, refinement, airbox_scale


def _load_artifact(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"missing complete managed artifact: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid analytic qualification JSON: {exc}") from exc
    return _object(value, "analytic qualification artifact")


def _validate_provenance(artifact: dict[str, Any]) -> None:
    runtime = _object(artifact.get("managed_runtime_identity"), "managed_runtime_identity")
    for key in ("runtime_manifest_sha256", "native_library_sha256"):
        _sha256(runtime.get(key), f"managed_runtime_identity.{key}")
    container_image = runtime.get("container_image")
    _require(isinstance(container_image, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", container_image) is not None, "managed_runtime_identity.container_image must be an immutable SHA-256 image digest")
    source = _object(artifact.get("source_provenance"), "source_provenance")
    for key in ("source_snapshot_sha256", "qualification_suite_sha256"):
        _sha256(source.get(key), f"source_provenance.{key}")


def _validate_row_policy(row: dict[str, Any], index: int) -> None:
    label = f"physics_rows[{index}]"
    _require(row.get("initial_state_kind") == "prescribed_uniform", f"{label}: initial_state_kind must be prescribed_uniform")
    _require(row.get("demag_evaluation_count") == 1, f"{label}: demag_evaluation_count must be 1")
    _require(row.get("relaxation_algorithm") == "none", f"{label}: relaxation_algorithm must be none")


def _validate_row(row: dict[str, Any], index: int, case: dict[str, Any], source_snapshot_sha256: str) -> None:
    label = f"physics_rows[{index}]"
    _validate_row_policy(row, index)
    _require(row.get("backend") in BACKENDS, f"{label}: backend must be one of {BACKENDS}")
    _require(row.get("mesh_refinement") in REFINEMENTS, f"{label}: mesh_refinement is invalid")
    _require(_finite(row.get("airbox_scale"), f"{label}.airbox_scale") in AIRBOX_SCALES, f"{label}: airbox_scale is invalid")
    _require(row.get("axis") in ("x", "y", "z"), f"{label}: axis must be x, y, or z")
    _sha256(row.get("solver_mesh_signature"), f"{label}.solver_mesh_signature")
    row_source = _object(row.get("source_provenance"), f"{label}.source_provenance")
    _require(_sha256(row_source.get("source_snapshot_sha256"), f"{label}.source_provenance.source_snapshot_sha256") == source_snapshot_sha256, f"{label}: source snapshot provenance differs from artifact identity")
    _sha256(row_source.get("serialized_typed_mesh_sha256"), f"{label}.source_provenance.serialized_typed_mesh_sha256")
    _sha256(row_source.get("problem_ir_sha256"), f"{label}.source_provenance.problem_ir_sha256")
    for key in ("ms_Apm", "magnetic_volume_m3", "e_demag_J", "e_demag_analytic_J", "n_analytic"):
        _finite(row.get(key), f"{label}.{key}")
    ms = _finite(row["ms_Apm"], f"{label}.ms_Apm")
    _require(ms > 0.0, f"{label}.ms_Apm must be positive")
    field = _list(row.get("h_demag_mean_magnetic_Apm"), f"{label}.h_demag_mean_magnetic_Apm")
    _require(len(field) == 3, f"{label}.h_demag_mean_magnetic_Apm must have 3 components")
    field_values = [_finite(value, f"{label}.h_demag_mean_magnetic_Apm") for value in field]
    axis_index = {"x": 0, "y": 1, "z": 2}[str(row["axis"])]
    n_from_field = -field_values[axis_index] / ms
    n_from_energy = 2.0 * _finite(row["e_demag_J"], f"{label}.e_demag_J") / (
        4.0e-7 * math.pi * ms * ms * _finite(row["magnetic_volume_m3"], f"{label}.magnetic_volume_m3")
    )
    n_analytic = _finite(row["n_analytic"], f"{label}.n_analytic")
    oracle = _case_oracle(case, str(row["axis"]))
    _require(_relative_error(n_analytic, oracle) <= 1.0e-12, f"{label}: n_analytic is not the geometry-derived sphere/Osborn oracle")
    _require(n_analytic > 0.0, f"{label}.n_analytic must be positive")
    _require(_finite(row.get("demag_linear_residual"), f"{label}.demag_linear_residual") <= RESIDUAL_ATOL, f"{label}: demag_linear_residual exceeds 1e-12")
    _finite(row.get("demag_linear_iterations"), f"{label}.demag_linear_iterations")
    row["_field_factor_relative_error"] = _relative_error(n_from_field, n_analytic)
    row["_energy_factor_relative_error"] = _relative_error(n_from_energy, n_analytic)
    row["_energy_relative_error"] = _relative_error(
        _finite(row["e_demag_J"], f"{label}.e_demag_J"),
        _finite(row["e_demag_analytic_J"], f"{label}.e_demag_analytic_J"),
    )
    row["_n_from_field"] = n_from_field
    row["_n_from_energy"] = n_from_energy


def _validate_exact_matrix(rows: list[dict[str, Any]], suite: dict[str, Any]) -> None:
    cases = _list(suite.get("cases"), "suite.cases")
    expected: set[tuple[str, str, str, float, str]] = set()
    for case in cases:
        case_obj = _object(case, "suite case")
        case_id = case_obj.get("case_id")
        axes = _list(case_obj.get("axes"), f"suite case {case_id}.axes")
        _require(isinstance(case_id, str) and case_id, "suite case_id is required")
        for axis in axes:
            _require(axis in ("x", "y", "z"), f"suite case {case_id}: invalid axis")
            for refinement in REFINEMENTS:
                for scale in AIRBOX_SCALES:
                    for backend in BACKENDS:
                        expected.add((case_id, str(axis), refinement, scale, backend))
    actual = [_identity(row) for row in rows]
    duplicate = {key for key in actual if actual.count(key) != 1}
    missing = expected - set(actual)
    unexpected = set(actual) - expected
    _require(not (missing or unexpected or duplicate), f"physics matrix mismatch; missing={sorted(missing)}, unexpected={sorted(unexpected)}, duplicates={sorted(duplicate)}")


def _validate_timing_rows(rows: list[dict[str, Any]], timing_rows: list[Any]) -> None:
    physics = {_identity(row) for row in rows}
    expected = {(identity, repeat) for identity in physics for repeat in TIMING_REPEATS}
    actual: set[tuple[tuple[str, str, str, float, str], int]] = set()
    for index, candidate in enumerate(timing_rows):
        row = _object(candidate, f"timing_rows[{index}]")
        _require(row.get("initial_state_kind") == "prescribed_uniform", f"timing_rows[{index}]: initial_state_kind must be prescribed_uniform")
        _require(row.get("demag_evaluation_count") == 1, f"timing_rows[{index}]: demag_evaluation_count must be 1")
        _require(row.get("relaxation_algorithm") == "none", f"timing_rows[{index}]: relaxation_algorithm must be none")
        repeat = row.get("repeat_index")
        _require(isinstance(repeat, int) and repeat in TIMING_REPEATS, f"timing_rows[{index}]: repeat_index must be 0, 1, or 2")
        _finite(row.get("demag_wall_time_ns"), f"timing_rows[{index}].demag_wall_time_ns")
        actual.add((_identity(row), repeat))
    _require(actual == expected, "timing matrix must contain exactly three repeats for every physics identity")


def _validate_fine_errors(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        if row["mesh_refinement"] != "fine":
            continue
        label = "/".join(map(str, _identity(row)))
        _require(row["_field_factor_relative_error"] <= FINE_FACTOR_RTOL, f"{label}: finest field factor error exceeds 5%")
        _require(row["_energy_factor_relative_error"] <= FINE_FACTOR_RTOL, f"{label}: finest energy factor error exceeds 5%")
        _require(row["_energy_relative_error"] <= FINE_ENERGY_RTOL, f"{label}: finest energy error exceeds 5%")


def _validate_refinement_and_airbox(rows: list[dict[str, Any]]) -> None:
    by_key: dict[tuple[str, str, float, str], dict[str, dict[str, Any]]] = defaultdict(dict)
    for row in rows:
        case_id, axis, refinement, scale, backend = _identity(row)
        by_key[(case_id, axis, scale, backend)][refinement] = row
    for key, levels in by_key.items():
        _require(set(levels) == set(REFINEMENTS), f"{key}: refinement rows must include coarse, medium, and fine")
        coarse, fine = levels["coarse"], levels["fine"]
        _require(
            fine["_field_factor_relative_error"] + fine["_energy_relative_error"]
            < coarse["_field_factor_relative_error"] + coarse["_energy_relative_error"],
            f"{key}: refinement must decrease combined field/energy error",
        )
    by_airbox: dict[tuple[str, str, str, str], dict[float, dict[str, Any]]] = defaultdict(dict)
    for row in rows:
        case_id, axis, refinement, scale, backend = _identity(row)
        if refinement == "fine":
            by_airbox[(case_id, axis, refinement, backend)][scale] = row
    for key, scales in by_airbox.items():
        _require(set(scales) == set(AIRBOX_SCALES), f"{key}: airbox rows must include {AIRBOX_SCALES}")
        low, high = scales[1.5], scales[3.0]
        _require(
            high["_field_factor_relative_error"] + high["_energy_relative_error"]
            <= low["_field_factor_relative_error"] + low["_energy_relative_error"],
            f"{key}: airbox scale 3.0 is worse than 1.5",
        )


def _validate_ellipsoid_sums(rows: list[dict[str, Any]], suite: dict[str, Any]) -> None:
    ellipsoids = {str(case["case_id"]) for case in _list(suite["cases"], "suite.cases") if _object(case, "suite case").get("kind") == "ellipsoid"}
    grouped: dict[tuple[str, str, float, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if str(row["case_id"]) in ellipsoids:
            grouped[(str(row["case_id"]), str(row["mesh_refinement"]), _finite(row["airbox_scale"], "airbox_scale"), str(row["backend"]))].append(row)
    for key, values in grouped.items():
        _require({row["axis"] for row in values} == {"x", "y", "z"}, f"{key}: ellipsoid axes are incomplete")
        total = sum(row["_n_from_field"] for row in values)
        _require(abs(total - 1.0) <= ELLIPSOID_SUM_ATOL, f"{key}: ellipsoid factor sum differs from one by more than 0.05")


def _validate_cpu_gpu_parity(rows: list[dict[str, Any]]) -> None:
    grouped: dict[tuple[str, str, str, float], dict[str, dict[str, Any]]] = defaultdict(dict)
    for row in rows:
        grouped[_pair_identity(row)][str(row["backend"])] = row
    for key, pair in grouped.items():
        _require(set(pair) == set(BACKENDS), f"{key}: CPU/GPU pair is incomplete")
        cpu, gpu = pair["fem_cpu"], pair["fem_gpu"]
        _require(cpu["solver_mesh_signature"] == gpu["solver_mesh_signature"], f"{key}: CPU/GPU typed mesh mismatch")
        _require(_relative_error(cpu["_n_from_field"], gpu["_n_from_field"]) <= CPU_GPU_RTOL, f"{key}: CPU/GPU field mismatch exceeds 1e-6")
        _require(_relative_error(_finite(cpu["e_demag_J"], "cpu energy"), _finite(gpu["e_demag_J"], "gpu energy")) <= CPU_GPU_RTOL, f"{key}: CPU/GPU energy mismatch exceeds 1e-6")


def validate_qualification(artifact_path: Path, suite_path: Path | None = None) -> dict[str, Any]:
    """Validate an existing managed analytic artifact and return its summary.

    A missing artifact is a failure, not a skipped or inferred qualification.
    """
    artifact = _load_artifact(artifact_path)
    _require(artifact.get("schema_version") == SCHEMA, "analytic qualification schema_version is invalid")
    rows = [_object(value, f"physics_rows[{index}]") for index, value in enumerate(_list(artifact.get("physics_rows"), "physics_rows"))]
    _require(rows, "physics_rows must not be empty")
    for index, row in enumerate(rows):
        _validate_row_policy(row, index)
    _validate_provenance(artifact)
    suite = _object(artifact.get("suite") if suite_path is None else _load_artifact(suite_path), "analytic qualification suite")
    if suite_path is not None:
        expected_suite_sha256 = hashlib.sha256(suite_path.read_bytes()).hexdigest()
        actual_suite_sha256 = _sha256(
            _object(artifact["source_provenance"], "source_provenance").get("qualification_suite_sha256"),
            "source_provenance.qualification_suite_sha256",
        )
        _require(actual_suite_sha256 == expected_suite_sha256, "source_provenance.qualification_suite_sha256 does not match the supplied suite")
    cases = {
        str(case["case_id"]): _object(case, "suite case")
        for case in _list(suite.get("cases"), "suite.cases")
        if isinstance(case, dict) and isinstance(case.get("case_id"), str)
    }
    _require(cases, "suite.cases must contain identified cases")
    source_snapshot_sha256 = _sha256(
        _object(artifact["source_provenance"], "source_provenance").get("source_snapshot_sha256"),
        "source_provenance.source_snapshot_sha256",
    )
    for index, row in enumerate(rows):
        case_id = str(row.get("case_id"))
        _require(case_id in cases, f"physics_rows[{index}]: unknown suite case_id {case_id}")
        _validate_row(row, index, cases[case_id], source_snapshot_sha256)
    _validate_exact_matrix(rows, suite)
    _validate_timing_rows(rows, _list(artifact.get("timing_rows"), "timing_rows"))
    _validate_fine_errors(rows)
    _validate_refinement_and_airbox(rows)
    _validate_ellipsoid_sums(rows, suite)
    _validate_cpu_gpu_parity(rows)
    return {
        "schema_version": SCHEMA,
        "qualified": True,
        "decision": "promote",
        "physics_row_count": len(rows),
        "timing_row_count": len(artifact["timing_rows"]),
    }


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--suite", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        summary = validate_qualification(args.artifact, args.suite)
    except ValueError as exc:
        summary = {"schema_version": SCHEMA, "qualified": False, "decision": "no_go", "reason": str(exc)}
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"FAIL: {exc}")
        return 1
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
