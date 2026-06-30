#!/usr/bin/env python3
"""Write strict-M5 static FEM PBC equilibrium comparison reports."""

from __future__ import annotations

import argparse
import csv
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any


DEFAULT_MAX_E_DEMAG_RELERR = 2.0e-2
DEFAULT_MAX_H_DEMAG_P99_RELERR = 2.0e-2
DEFAULT_MAX_DEMAG_PHI_RANGE_RELERR = 2.0e-2
DEFAULT_MAX_SUPERCELL_DEMAG_PHI_DELTA_A = 1.0e-6
DEFAULT_MAX_AVERAGE_M_L2_DELTA = 2.0e-2
DEFAULT_MAX_TORQUE_RELERR = 2.0e-1


def fail(message: str) -> None:
    raise ValueError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def require_object(value: Any, name: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{name} must be a JSON object")
    return value


def require_list(value: Any, name: str) -> list[Any]:
    require(isinstance(value, list), f"{name} must be a JSON list")
    return value


def finite_number(value: Any, name: str) -> float:
    require(isinstance(value, (int, float)), f"{name} must be numeric")
    number = float(value)
    require(math.isfinite(number), f"{name} must be finite")
    return number


def relative_error(actual: float, expected: float) -> float:
    scale = max(abs(actual), abs(expected), 1.0e-300)
    return abs(actual - expected) / scale


def load_json(path: Path) -> dict[str, Any]:
    require(path.is_file(), f"missing JSON file: {path}")
    return require_object(json.loads(path.read_text(encoding="utf-8")), str(path))


def load_metadata(root: Path) -> dict[str, Any]:
    return load_json(root / "metadata.json")


def qualification(metadata: dict[str, Any]) -> dict[str, Any]:
    for key in ("fem_cpu_relaxation_qualification", "fem_gpu_relaxation_qualification"):
        value = metadata.get(key)
        if isinstance(value, dict):
            return value
    fail("metadata must contain fem_cpu_relaxation_qualification or fem_gpu_relaxation_qualification")


def final_energy_terms(metadata: dict[str, Any]) -> dict[str, Any]:
    return require_object(qualification(metadata).get("final_energy_terms_j"), "final_energy_terms_j")


def final_e_demag(root: Path) -> float:
    return finite_number(final_energy_terms(load_metadata(root)).get("E_demag"), f"{root}/E_demag")


def final_torque(root: Path) -> float:
    return finite_number(qualification(load_metadata(root)).get("final_torque_apm"), f"{root}/final_torque_apm")


def metadata_contract(root: Path) -> dict[str, Any]:
    metadata = load_metadata(root)
    pbc = require_object(metadata.get("pbc"), f"{root}/metadata.pbc")
    require(
        pbc.get("demag") == "periodic_airbox_k0",
        f"{root}/metadata.pbc.demag must be periodic_airbox_k0",
    )
    axes = require_list(pbc.get("axes"), f"{root}/metadata.pbc.axes")
    periodic = require_object(
        metadata.get("periodic_antidot_relaxation"),
        f"{root}/metadata.periodic_antidot_relaxation",
    )
    scenario = periodic.get("scenario")
    require(isinstance(scenario, str) and scenario, f"{root}/metadata.periodic_antidot_relaxation.scenario must be non-empty")
    film_size = require_list(periodic.get("film_size_m"), f"{root}/metadata.periodic_antidot_relaxation.film_size_m")
    require(len(film_size) == 3, f"{root}/metadata.periodic_antidot_relaxation.film_size_m must be a 3-vector")
    universe_size = require_list(
        periodic.get("universe_size_m"),
        f"{root}/metadata.periodic_antidot_relaxation.universe_size_m",
    )
    require(len(universe_size) == 3, f"{root}/metadata.periodic_antidot_relaxation.universe_size_m must be a 3-vector")
    lateral_air_gap = require_list(
        periodic.get("lateral_air_gap_m"),
        f"{root}/metadata.periodic_antidot_relaxation.lateral_air_gap_m",
    )
    require(
        len(lateral_air_gap) == 2,
        f"{root}/metadata.periodic_antidot_relaxation.lateral_air_gap_m must be a 2-vector",
    )
    periodic_pair_ids = [str(value) for value in require_list(
        periodic.get("periodic_pair_ids"),
        f"{root}/metadata.periodic_antidot_relaxation.periodic_pair_ids",
    )]
    require(periodic_pair_ids, f"{root}/metadata.periodic_antidot_relaxation.periodic_pair_ids must be non-empty")
    return {
        "axes": axes,
        "scenario": scenario,
        "film_size_m": [finite_number(value, f"{root}/film_size_m[{index}]") for index, value in enumerate(film_size)],
        "universe_size_m": [
            finite_number(value, f"{root}/universe_size_m[{index}]")
            for index, value in enumerate(universe_size)
        ],
        "lateral_air_gap_m": [
            finite_number(value, f"{root}/lateral_air_gap_m[{index}]")
            for index, value in enumerate(lateral_air_gap)
        ],
        "periodic_pair_ids": periodic_pair_ids,
        "exchange_coupled_across_periods": bool(periodic.get("exchange_coupled_across_periods")),
    }


def require_same_static_workload(left_root: Path, right_root: Path) -> dict[str, Any]:
    left = metadata_contract(left_root)
    right = metadata_contract(right_root)
    for key in (
        "axes",
        "scenario",
        "film_size_m",
        "lateral_air_gap_m",
        "periodic_pair_ids",
        "exchange_coupled_across_periods",
    ):
        require(left[key] == right[key], f"{key} must match for strict M5 comparison")
    return left


def require_z_padding_workload(reference_root: Path, candidate_root: Path) -> dict[str, Any]:
    reference = metadata_contract(reference_root)
    candidate = metadata_contract(candidate_root)
    for key in (
        "axes",
        "scenario",
        "film_size_m",
        "lateral_air_gap_m",
        "periodic_pair_ids",
        "exchange_coupled_across_periods",
    ):
        require(reference[key] == candidate[key], f"{key} must match for strict M5 comparison")
    require(
        reference["axes"] == ["periodic", "periodic", "open"],
        "z-padding comparison requires x/y periodic and open z axes",
    )
    reference_universe = reference["universe_size_m"]
    candidate_universe = candidate["universe_size_m"]
    require(
        reference_universe[:2] == candidate_universe[:2],
        "z-padding comparison requires matching lateral universe_size_m",
    )
    require(
        reference_universe[2] > candidate_universe[2],
        "z-padding comparison requires different open-z universe_size_m with reference thicker than candidate",
    )
    return {
        **candidate,
        "reference_universe_size_m": reference_universe,
        "candidate_universe_size_m": candidate_universe,
    }


def require_supercell_workload(
    unit_root: Path,
    supercell_root: Path,
    *,
    repeat_x: int,
    repeat_y: int,
) -> dict[str, Any]:
    unit = metadata_contract(unit_root)
    supercell = metadata_contract(supercell_root)
    for key in (
        "axes",
        "scenario",
        "film_size_m",
        "lateral_air_gap_m",
        "periodic_pair_ids",
        "exchange_coupled_across_periods",
    ):
        require(unit[key] == supercell[key], f"{key} must match for strict M5 comparison")
    require(
        unit["axes"] == ["periodic", "periodic", "open"],
        "supercell comparison requires x/y periodic and open z axes",
    )
    unit_universe = unit["universe_size_m"]
    supercell_universe = supercell["universe_size_m"]
    expected_supercell_universe = [
        unit_universe[0] * repeat_x,
        unit_universe[1] * repeat_y,
        unit_universe[2],
    ]
    require(
        all(
            math.isclose(actual, expected, rel_tol=1.0e-12, abs_tol=1.0e-18)
            for actual, expected in zip(supercell_universe, expected_supercell_universe)
        ),
        (
            "supercell comparison requires lateral universe_size_m scaled by "
            "repeat_x/repeat_y and matching open-z universe_size_m"
        ),
    )
    return {
        **unit,
        "unit_universe_size_m": unit_universe,
        "supercell_universe_size_m": supercell_universe,
        "expected_supercell_universe_size_m": expected_supercell_universe,
    }


def load_m_values(root: Path) -> list[list[float]]:
    data = load_json(root / "m_final.json")
    values = require_list(data.get("values"), "m_final.values")
    out: list[list[float]] = []
    for index, raw in enumerate(values):
        vector = require_list(raw, f"m_final.values[{index}]")
        require(len(vector) == 3, f"m_final.values[{index}] must be a 3-vector")
        out.append([finite_number(vector[i], f"m_final.values[{index}][{i}]") for i in range(3)])
    require(out, "m_final.values must be non-empty")
    return out


def average_m(root: Path) -> list[float]:
    values = load_m_values(root)
    return average_vectors(values, list(range(len(values))), "m_final.values")


def average_vectors(values: list[list[float]], indices: list[int], name: str) -> list[float]:
    require(indices, f"{name} index list must be non-empty")
    inv = 1.0 / float(len(indices))
    return [
        sum(values[index][component] for index in indices) * inv
        for component in range(3)
    ]


def l2_delta(a: list[float], b: list[float]) -> float:
    require(len(a) == len(b), "vectors must have the same length")
    return math.sqrt(sum((ai - bi) ** 2 for ai, bi in zip(a, b)))


def load_zarr_values(root: Path, observable: str) -> tuple[list[str], list[float]]:
    field_dir = root / "fields" / f"{observable}.zarr"
    require(field_dir.is_dir(), f"missing {observable} zarr directory: {field_dir}")
    attrs = load_json(field_dir / ".zattrs")
    array = load_json(field_dir / ".zarray")
    component_order = require_list(attrs.get("component_order"), f"{observable}.component_order")
    component_names = [str(component) for component in component_order]
    require(array.get("dtype") == "<f8", f"{observable} zarr dtype must be <f8")
    require(array.get("order") == "C", f"{observable} zarr order must be C")
    shape = require_list(array.get("shape"), f"{observable}.shape")
    require(len(shape) == 3 and shape[0] == 1, f"{observable}.shape must be [1, components, cells]")
    component_count = int(shape[1])
    cell_count = int(shape[2])
    require(component_count == len(component_names), f"{observable}.shape/component_order mismatch")
    require(component_count > 0 and cell_count > 0, f"{observable} zarr dimensions must be positive")
    with (field_dir / "samples.csv").open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    require(rows, f"{observable} samples.csv must not be empty")
    chunk_key = rows[-1].get("chunk_key")
    require(isinstance(chunk_key, str) and chunk_key, f"{observable} chunk_key must be present")
    raw = (field_dir / chunk_key).read_bytes()
    expected = component_count * cell_count
    require(len(raw) == expected * 8, f"{observable} chunk byte length mismatch")
    values = list(struct.unpack(f"<{expected}d", raw))
    return component_names, values


def require_index_list(value: Any, name: str, upper_bound: int) -> list[int]:
    raw_values = require_list(value, name)
    require(raw_values, f"{name} must be non-empty")
    indices: list[int] = []
    seen: set[int] = set()
    for position, raw in enumerate(raw_values):
        require(isinstance(raw, int), f"{name}[{position}] must be an integer")
        require(0 <= raw < upper_bound, f"{name}[{position}] must be in [0, {upper_bound})")
        require(raw not in seen, f"{name}[{position}] duplicates index {raw}")
        seen.add(raw)
        indices.append(raw)
    return indices


def h_demag_max_norm_from_indices(root: Path, indices: list[int]) -> float:
    components, values = load_zarr_values(root, "H_demag")
    require(components == ["x", "y", "z"], "H_demag component_order must be x/y/z")
    cell_count = len(values) // 3
    bounded_indices = require_index_list(indices, "central-cell field_cell_indices", cell_count)
    return max(
        math.sqrt(values[i] ** 2 + values[cell_count + i] ** 2 + values[2 * cell_count + i] ** 2)
        for i in bounded_indices
    )


def h_demag_max_norm(root: Path) -> float:
    components, values = load_zarr_values(root, "H_demag")
    require(components == ["x", "y", "z"], "H_demag component_order must be x/y/z")
    cell_count = len(values) // 3
    return h_demag_max_norm_from_indices(root, list(range(cell_count)))


def h_demag_norm_percentile(root: Path, percentile: float) -> float:
    require(0.0 <= percentile <= 1.0, "H_demag percentile must be in [0, 1]")
    components, values = load_zarr_values(root, "H_demag")
    require(components == ["x", "y", "z"], "H_demag component_order must be x/y/z")
    cell_count = len(values) // 3
    norms = sorted(
        math.sqrt(values[i] ** 2 + values[cell_count + i] ** 2 + values[2 * cell_count + i] ** 2)
        for i in range(cell_count)
    )
    require(norms, "H_demag norms must be non-empty")
    index = min(len(norms) - 1, int(percentile * (len(norms) - 1)))
    return norms[index]


def demag_phi_range_from_indices(root: Path, indices: list[int]) -> float:
    components, values = load_zarr_values(root, "demag_phi")
    require(components == ["scalar"], "demag_phi component_order must be scalar")
    bounded_indices = require_index_list(indices, "central-cell field_cell_indices", len(values))
    selected = [values[index] for index in bounded_indices]
    return max(selected) - min(selected)


def demag_phi_range(root: Path) -> float:
    components, values = load_zarr_values(root, "demag_phi")
    require(components == ["scalar"], "demag_phi component_order must be scalar")
    return max(values) - min(values)


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def require_different_roots(left: Path, right: Path, message: str) -> None:
    require(left.resolve() != right.resolve(), message)


def load_supercell_central_cell_extraction(
    root: Path,
    *,
    repeat_x: int,
    repeat_y: int,
) -> dict[str, Any]:
    path = root / "diagnostics" / "fem_static_pbc_supercell_central_cell.v1.json"
    require(path.is_file(), f"missing supercell central-cell extraction artifact: {path}")
    payload = load_json(path)
    require(
        payload.get("schema_version") == "fem_static_pbc_supercell_central_cell.v1",
        (
            "supercell central-cell extraction schema_version must be "
            f"fem_static_pbc_supercell_central_cell.v1, got {payload.get('schema_version')!r}"
        ),
    )
    require(payload.get("repeat_x") == repeat_x, "supercell central-cell extraction repeat_x must match report repeat_x")
    require(payload.get("repeat_y") == repeat_y, "supercell central-cell extraction repeat_y must match report repeat_y")
    require(
        payload.get("cell_count") == repeat_x * repeat_y,
        "supercell central-cell extraction cell_count must equal repeat_x * repeat_y",
    )
    central_index = require_list(payload.get("central_cell_index"), "supercell central-cell extraction central_cell_index")
    require(len(central_index) == 2, "supercell central-cell extraction central_cell_index must be a 2-vector")
    for axis, (value, repeat) in enumerate(zip(central_index, [repeat_x, repeat_y])):
        require(isinstance(value, int), f"supercell central-cell extraction central_cell_index[{axis}] must be an integer")
        require(0 <= value < repeat, f"supercell central-cell extraction central_cell_index[{axis}] must be in [0, {repeat})")
    energy = finite_number(
        payload.get("central_cell_demag_energy_j"),
        "supercell central-cell extraction central_cell_demag_energy_j",
    )
    torque = finite_number(
        payload.get("central_cell_torque_apm"),
        "supercell central-cell extraction central_cell_torque_apm",
    )
    require(energy >= 0.0, "supercell central-cell extraction central_cell_demag_energy_j must be non-negative")
    require(torque >= 0.0, "supercell central-cell extraction central_cell_torque_apm must be non-negative")
    m_values = load_m_values(root)
    _, h_values = load_zarr_values(root, "H_demag")
    _, phi_values = load_zarr_values(root, "demag_phi")
    magnetic_indices = require_index_list(
        payload.get("magnetic_node_indices"),
        "supercell central-cell extraction magnetic_node_indices",
        len(m_values),
    )
    field_indices = require_index_list(
        payload.get("field_cell_indices"),
        "supercell central-cell extraction field_cell_indices",
        min(len(h_values) // 3, len(phi_values)),
    )
    return {
        "schema_version": payload["schema_version"],
        "path": str(path),
        "repeat_x": repeat_x,
        "repeat_y": repeat_y,
        "cell_count": repeat_x * repeat_y,
        "central_cell_index": central_index,
        "magnetic_node_count": len(magnetic_indices),
        "field_cell_count": len(field_indices),
        "magnetic_node_indices": magnetic_indices,
        "field_cell_indices": field_indices,
        "central_cell_demag_energy_j": energy,
        "central_cell_torque_apm": torque,
    }


def status_from_limits(metrics: dict[str, float], limits: dict[str, float]) -> tuple[str, list[str]]:
    failures = [
        f"{name}={metrics[name]:.6e} exceeds {limit:.6e}"
        for name, limit in limits.items()
        if metrics[name] > limit
    ]
    return ("failed" if failures else "ok"), failures


def compare_z_padding(args: argparse.Namespace) -> dict[str, Any]:
    require_different_roots(
        args.reference,
        args.candidate,
        "reference and candidate artifact roots must be different",
    )
    workload = require_z_padding_workload(args.reference, args.candidate)
    candidate_h_max = h_demag_max_norm(args.candidate)
    reference_h_max = h_demag_max_norm(args.reference)
    candidate_h_p99 = h_demag_norm_percentile(args.candidate, 0.99)
    reference_h_p99 = h_demag_norm_percentile(args.reference, 0.99)
    candidate_phi_range = demag_phi_range(args.candidate)
    reference_phi_range = demag_phi_range(args.reference)
    metrics = {
        "e_demag_relative_error": relative_error(final_e_demag(args.candidate), final_e_demag(args.reference)),
        "h_demag_p99_relative_error": relative_error(candidate_h_p99, reference_h_p99),
        "demag_phi_range_relative_error": relative_error(candidate_phi_range, reference_phi_range),
        "h_demag_max_abs_delta_Apm": abs(candidate_h_max - reference_h_max),
        "h_demag_max_relative_error": relative_error(candidate_h_max, reference_h_max),
        "demag_phi_max_abs_delta_A": abs(candidate_phi_range - reference_phi_range),
    }
    limits = {
        "e_demag_relative_error": args.max_e_demag_relative_error,
        "h_demag_p99_relative_error": args.max_h_demag_p99_relative_error,
        "demag_phi_range_relative_error": args.max_demag_phi_range_relative_error,
    }
    status, failures = status_from_limits(metrics, limits)
    return {
        "schema_version": "fem_static_pbc_z_padding_validation.v1",
        "status": status,
        "reference_artifacts": str(args.reference),
        "candidate_artifacts": str(args.candidate),
        "metrics": metrics,
        "workload": workload,
        "thresholds": limits,
        "failure_reasons": failures,
    }


def compare_supercell(args: argparse.Namespace) -> dict[str, Any]:
    require_different_roots(
        args.unit_cell,
        args.supercell,
        "unit-cell and supercell artifact roots must be different",
    )
    workload = require_supercell_workload(
        args.unit_cell,
        args.supercell,
        repeat_x=args.repeat_x,
        repeat_y=args.repeat_y,
    )
    cell_count = args.repeat_x * args.repeat_y
    unit_e = final_e_demag(args.unit_cell)
    extraction = load_supercell_central_cell_extraction(
        args.supercell,
        repeat_x=args.repeat_x,
        repeat_y=args.repeat_y,
    )
    supercell_e_density = float(extraction["central_cell_demag_energy_j"])
    unit_h = h_demag_max_norm(args.unit_cell)
    supercell_h = h_demag_max_norm_from_indices(args.supercell, extraction["field_cell_indices"])
    metrics = {
        "average_m_l2_delta": l2_delta(
            average_vectors(load_m_values(args.supercell), extraction["magnetic_node_indices"], "m_final.values"),
            average_m(args.unit_cell),
        ),
        "e_demag_density_relative_error": relative_error(supercell_e_density, unit_e),
        "h_demag_stats_relative_error": relative_error(supercell_h, unit_h),
        "demag_phi_max_abs_delta_A": abs(
            demag_phi_range_from_indices(args.supercell, extraction["field_cell_indices"])
            - demag_phi_range(args.unit_cell)
        ),
        "central_cell_torque_residual_relative_error": relative_error(
            float(extraction["central_cell_torque_apm"]),
            final_torque(args.unit_cell),
        ),
    }
    limits = {
        "average_m_l2_delta": args.max_average_m_l2_delta,
        "e_demag_density_relative_error": args.max_e_demag_density_relative_error,
        "h_demag_stats_relative_error": args.max_h_demag_stats_relative_error,
        "demag_phi_max_abs_delta_A": args.max_demag_phi_max_abs_delta_a,
        "central_cell_torque_residual_relative_error": args.max_central_cell_torque_residual_relative_error,
    }
    status, failures = status_from_limits(metrics, limits)
    return {
        "schema_version": "fem_static_pbc_supercell_validation.v1",
        "status": status,
        "unit_cell_artifacts": str(args.unit_cell),
        "supercell_artifacts": str(args.supercell),
        "repeat_x": args.repeat_x,
        "repeat_y": args.repeat_y,
        "cell_count": cell_count,
        "central_cell_extraction": {
            key: value
            for key, value in extraction.items()
            if key not in {"magnetic_node_indices", "field_cell_indices"}
        },
        "metrics": metrics,
        "workload": workload,
        "thresholds": limits,
        "failure_reasons": failures,
    }


def add_common_report_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--report", type=Path, required=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    z_padding = subparsers.add_parser("z-padding")
    z_padding.add_argument("--reference", type=Path, required=True)
    z_padding.add_argument("--candidate", type=Path, required=True)
    z_padding.add_argument("--max-e-demag-relative-error", type=float, default=DEFAULT_MAX_E_DEMAG_RELERR)
    z_padding.add_argument("--max-h-demag-p99-relative-error", type=float, default=DEFAULT_MAX_H_DEMAG_P99_RELERR)
    z_padding.add_argument("--max-demag-phi-range-relative-error", type=float, default=DEFAULT_MAX_DEMAG_PHI_RANGE_RELERR)
    add_common_report_arg(z_padding)

    supercell = subparsers.add_parser("supercell")
    supercell.add_argument("--unit-cell", type=Path, required=True)
    supercell.add_argument("--supercell", type=Path, required=True)
    supercell.add_argument("--repeat-x", type=int, required=True)
    supercell.add_argument("--repeat-y", type=int, required=True)
    supercell.add_argument("--max-average-m-l2-delta", type=float, default=DEFAULT_MAX_AVERAGE_M_L2_DELTA)
    supercell.add_argument("--max-e-demag-density-relative-error", type=float, default=DEFAULT_MAX_E_DEMAG_RELERR)
    supercell.add_argument("--max-h-demag-stats-relative-error", type=float, default=DEFAULT_MAX_E_DEMAG_RELERR)
    supercell.add_argument("--max-demag-phi-max-abs-delta-a", type=float, default=DEFAULT_MAX_SUPERCELL_DEMAG_PHI_DELTA_A)
    supercell.add_argument(
        "--max-central-cell-torque-residual-relative-error",
        type=float,
        default=DEFAULT_MAX_TORQUE_RELERR,
    )
    add_common_report_arg(supercell)

    args = parser.parse_args()
    for name, value in vars(args).items():
        if name.startswith("max_"):
            require(math.isfinite(value) and value >= 0.0, f"--{name.replace('_', '-')} must be non-negative")
    if args.command == "supercell":
        require(args.repeat_x > 0 and args.repeat_y > 0, "--repeat-x and --repeat-y must be positive")
        require(args.repeat_x * args.repeat_y > 1, "supercell comparison requires more than one repeated cell")
    return args


def main() -> int:
    try:
        args = parse_args()
        report = compare_z_padding(args) if args.command == "z-padding" else compare_supercell(args)
        write_report(args.report, report)
        if report["status"] != "ok":
            print("\n".join(report["failure_reasons"]), file=sys.stderr)
            return 1
        return 0
    except Exception as exc:
        print(f"invalid FEM static PBC comparison artifacts: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
