"""Compare runtime-origin FDM multilayer Airbox carriers on common cell centres."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

from verify_fdm_multilayer_airbox_carrier import AirboxCarrierError, verify_airbox_carrier


class AirboxConvergenceError(ValueError):
    """Raised when an Airbox convergence comparison cannot be qualified."""


def _fail(reason: str) -> None:
    raise AirboxConvergenceError(f"not_qualified: {reason}")


def _read_field(manifest: dict[str, Any]) -> tuple[dict[str, Any], list[list[float]]]:
    manifest_path = Path(manifest["manifest_path"])
    field_path = (manifest_path.parent / manifest["field_artifact"]).resolve()
    try:
        payload = json.loads(field_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _fail(f"field_artifact_unreadable:{field_path}:{exc}")
    if not isinstance(payload, dict):
        _fail("field_artifact_malformed")
    values = payload.get("values")
    if not isinstance(values, list):
        _fail("field_values_missing")
    return payload, values


def _grid(payload: dict[str, Any], manifest: dict[str, Any]) -> tuple[tuple[int, int, int], tuple[float, float, float], tuple[float, float, float]]:
    grid = payload.get("grid")
    if not isinstance(grid, dict):
        _fail("field_grid_missing")
    manifest_grid = manifest.get("grid")
    if not isinstance(manifest_grid, dict):
        _fail("manifest_grid_missing")
    try:
        cells = tuple(int(value) for value in grid["cells"])
        origin = tuple(float(value) for value in grid["origin_m"])
        spacing = tuple(float(value) for value in grid["cell_size_m"])
        manifest_cells = tuple(int(value) for value in manifest_grid["cells"])
        manifest_origin = tuple(float(value) for value in manifest_grid["origin_m"])
        manifest_spacing = tuple(float(value) for value in manifest_grid["cell_size_m"])
    except (KeyError, TypeError, ValueError) as exc:
        _fail(f"grid_malformed:{exc}")
    if len(cells) != 3 or len(origin) != 3 or len(spacing) != 3:
        _fail("grid_must_have_three_dimensions")
    if (cells, origin, spacing) != (manifest_cells, manifest_origin, manifest_spacing):
        _fail("field_manifest_grid_mismatch")
    if any(value <= 0 for value in cells) or any(not math.isfinite(value) or value <= 0 for value in spacing):
        _fail("grid_values_invalid")
    return cells, origin, spacing


def _coordinate_key(value: float) -> int:
    """Quantize SI coordinates well below the smallest supported cell size."""

    return round(value * 1.0e18)


def _field_by_coordinate(
    payload: dict[str, Any], manifest: dict[str, Any]
) -> tuple[dict[tuple[int, int, int], tuple[float, float, float]], tuple[int, int, int], tuple[float, float, float]]:
    values = payload["values"]
    cells, origin, spacing = _grid(payload, manifest)
    expected = cells[0] * cells[1] * cells[2]
    if len(values) != expected:
        _fail(f"field_sample_count_mismatch:{len(values)}:{expected}")
    field: dict[tuple[int, int, int], tuple[float, float, float]] = {}
    nx, ny, nz = cells
    for index, vector in enumerate(values):
        if not isinstance(vector, list) or len(vector) != 3:
            _fail(f"field_vector_malformed:{index}")
        if any(not isinstance(component, (int, float)) or not math.isfinite(float(component)) for component in vector):
            _fail(f"field_vector_non_finite:{index}")
        k, remainder = divmod(index, nx * ny)
        j, i = divmod(remainder, nx)
        centre = tuple(origin[axis] + (coordinate + 0.5) * spacing[axis] for axis, coordinate in enumerate((i, j, k)))
        key = tuple(_coordinate_key(value) for value in centre)
        if key in field:
            _fail(f"duplicate_cell_centre:{key}")
        field[key] = tuple(float(component) for component in vector)
    return field, cells, spacing


def _same(value_a: float, value_b: float) -> bool:
    return math.isclose(value_a, value_b, rel_tol=1.0e-12, abs_tol=1.0e-18)


def compare_airbox_carriers(
    baseline_path: str | Path,
    candidate_path: str | Path,
    *,
    atol_a_per_m: float = 1.0e-5,
    rtol: float = 1.0e-10,
) -> dict[str, Any]:
    """Compare all baseline cell centres against a wider candidate carrier."""

    baseline = verify_airbox_carrier(baseline_path)
    candidate = verify_airbox_carrier(candidate_path)
    baseline_payload, _ = _read_field(baseline)
    candidate_payload, _ = _read_field(candidate)
    baseline_field, baseline_cells, baseline_spacing = _field_by_coordinate(baseline_payload, baseline)
    candidate_field, candidate_cells, candidate_spacing = _field_by_coordinate(candidate_payload, candidate)

    if baseline_cells[:2] != candidate_cells[:2] or any(
        not _same(a, b) for a, b in zip(baseline_spacing, candidate_spacing)
    ):
        _fail("candidate_must_preserve_xy_and_cell_spacing")
    if baseline_cells == candidate_cells:
        _fail("candidate_airbox_mesh_not_changed")
    if baseline.get("source_grid_fingerprints") != candidate.get("source_grid_fingerprints"):
        _fail("source_grid_fingerprints_changed")
    baseline_common = baseline.get("source_common_grid")
    candidate_common = candidate.get("source_common_grid")
    if baseline_common != candidate_common:
        _fail("source_common_grid_changed")
    for key in ("execution_engine", "precision", "demag_operator_kind", "fft_backend", "run_status"):
        if baseline.get("source_runtime_identity", {}).get(key) != candidate.get("source_runtime_identity", {}).get(key):
            _fail(f"source_runtime_identity_changed:{key}")

    common_keys = sorted(set(baseline_field) & set(candidate_field))
    if len(common_keys) != len(baseline_field):
        _fail(f"baseline_cells_missing_from_candidate:{len(baseline_field) - len(common_keys)}")
    if not common_keys:
        _fail("no_common_cell_centres")

    squared_error = 0.0
    squared_reference = 0.0
    max_abs = 0.0
    max_reference = 0.0
    for key in common_keys:
        reference = baseline_field[key]
        observed = candidate_field[key]
        for expected, actual in zip(reference, observed):
            difference = actual - expected
            squared_error += difference * difference
            squared_reference += expected * expected
            max_abs = max(max_abs, abs(difference))
            max_reference = max(max_reference, abs(expected))
    component_count = 3 * len(common_keys)
    rms = math.sqrt(squared_error / component_count)
    relative_l2 = math.sqrt(squared_error) / max(math.sqrt(squared_reference), 1.0e-30)
    tolerance = atol_a_per_m + rtol * max_reference
    status = "qualified" if max_abs <= tolerance else "not_qualified"
    report = {
        "schema_version": "fdm_multilayer_airbox_convergence.v1",
        "qualification_status": status,
        "baseline_manifest": baseline["manifest_path"],
        "candidate_manifest": candidate["manifest_path"],
        "baseline_cells": list(baseline_cells),
        "candidate_cells": list(candidate_cells),
        "common_cell_centres": len(common_keys),
        "baseline_cell_count": len(baseline_field),
        "candidate_cell_count": len(candidate_field),
        "max_abs_component_error_A_per_m": max_abs,
        "rms_component_error_A_per_m": rms,
        "relative_l2_error": relative_l2,
        "max_reference_component_A_per_m": max_reference,
        "absolute_tolerance_A_per_m": atol_a_per_m,
        "relative_tolerance": rtol,
        "combined_tolerance_A_per_m": tolerance,
        "comparison_rule": "baseline cell centres must be present in wider candidate Airbox",
    }
    if status != "qualified":
        raise AirboxConvergenceError(json.dumps(report, sort_keys=True))
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--atol-a-per-m", type=float, default=1.0e-5)
    parser.add_argument("--rtol", type=float, default=1.0e-10)
    args = parser.parse_args(argv)
    try:
        report = compare_airbox_carriers(
            args.baseline,
            args.candidate,
            atol_a_per_m=args.atol_a_per_m,
            rtol=args.rtol,
        )
    except (AirboxCarrierError, AirboxConvergenceError) as exc:
        print(str(exc))
        return 3
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
