#!/usr/bin/env python3
"""Validate managed FEM periodic-antidot relaxation runtime artifacts."""

from __future__ import annotations

import argparse
import csv
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any


SUPPORTED_SCENARIOS = {"air_gap", "exchange_coupled", "uniform_slab"}
SUPPORTED_ENGINES = {"cpu", "gpu"}
SUPPORTED_ALGORITHMS = {
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
}
MAX_MAGNETIZATION_NORM_DEFECT = 1.0e-9
MAX_DEFAULT_FINAL_TORQUE_APM = 1.0e12
MAX_DEFAULT_M_SEAM_MISMATCH = 1.0e-6
MAX_DEFAULT_H_DEMAG_SEAM_MISMATCH_APM = 1.0e-3
MAX_DEFAULT_DEMAG_PHI_SEAM_MISMATCH_A = 1.0e-6
MAX_DEFAULT_B_NORMAL_FLUX_SEAM_MISMATCH_T = 1.0e-12
MAX_DEFAULT_SIDE_MAGNETIC_CHARGE_SUM_ABS_AM = 1.0e-18
MAX_DEMAG_ENERGY_NEGATIVE_NOISE_J = 1.0e-24
MAX_STATIC_Z_PADDING_E_DEMAG_RELERR = 2.0e-2
MAX_STATIC_Z_PADDING_H_DEMAG_P99_RELERR = 2.0e-2
MAX_STATIC_Z_PADDING_DEMAG_PHI_RANGE_RELERR = 2.0e-2
MAX_STATIC_SUPERCELL_AVERAGE_M_L2_DELTA = 2.0e-2
MAX_STATIC_SUPERCELL_E_DEMAG_DENSITY_RELERR = 2.0e-2
MAX_STATIC_SUPERCELL_H_DEMAG_STATS_RELERR = 2.0e-2
MAX_STATIC_SUPERCELL_DEMAG_PHI_DELTA_A = 1.0e-6
MAX_STATIC_SUPERCELL_TORQUE_RELERR = 2.0e-1
MAX_STATIC_SUPERCELL_RELAXATION_STATE_MEAN_DEVIATION_RELERR = 2.0e-1
MAX_STATIC_SUPERCELL_INTERPOLATED_M_P99_L2_DELTA = 2.0e-2
MAX_STATIC_SUPERCELL_INTERPOLATED_H_DEMAG_P99_RELERR = 2.0e-2
MAX_STATIC_SUPERCELL_INTERPOLATED_DEMAG_PHI_DELTA_A = 1.0e-6
MAX_INITIAL_STATE_OVERRIDE_COMPONENT_DELTA = 1.0e-12


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log_path", type=Path)
    parser.add_argument("--scenario", required=True, choices=sorted(SUPPORTED_SCENARIOS))
    parser.add_argument("--engine", required=True, choices=sorted(SUPPORTED_ENGINES))
    parser.add_argument("--algorithm", required=True, choices=sorted(SUPPORTED_ALGORITHMS))
    parser.add_argument("--min-steps", type=int, default=2)
    parser.add_argument(
        "--max-final-torque-apm",
        type=float,
        default=MAX_DEFAULT_FINAL_TORQUE_APM,
        help="Maximum accepted final |m x H_eff| residual in A/m.",
    )
    parser.add_argument(
        "--max-m-seam-mismatch",
        type=float,
        default=MAX_DEFAULT_M_SEAM_MISMATCH,
        help="Maximum accepted vector mismatch across periodic seams in m_final.",
    )
    parser.add_argument(
        "--max-h-demag-seam-mismatch-apm",
        type=float,
        default=MAX_DEFAULT_H_DEMAG_SEAM_MISMATCH_APM,
        help="Maximum accepted vector mismatch across periodic seams in H_demag [A/m].",
    )
    parser.add_argument(
        "--max-demag-phi-seam-mismatch-a",
        type=float,
        default=MAX_DEFAULT_DEMAG_PHI_SEAM_MISMATCH_A,
        help="Maximum accepted scalar mismatch across periodic seams in demag_phi [A].",
    )
    parser.add_argument(
        "--max-b-normal-flux-seam-mismatch-t",
        type=float,
        default=MAX_DEFAULT_B_NORMAL_FLUX_SEAM_MISMATCH_T,
        help="Maximum accepted normal B flux mismatch across periodic seams [T].",
    )
    parser.add_argument(
        "--max-side-magnetic-charge-sum-abs-am",
        type=float,
        default=MAX_DEFAULT_SIDE_MAGNETIC_CHARGE_SUM_ABS_AM,
        help="Maximum accepted absolute paired side magnetic charge sum [A m].",
    )
    parser.add_argument(
        "--require-z-padding-report",
        type=Path,
        default=None,
        help=(
            "Require a fem_static_pbc_z_padding_validation.v1 JSON report with "
            "status=ok before accepting the equilibrium."
        ),
    )
    parser.add_argument(
        "--require-supercell-report",
        type=Path,
        default=None,
        help=(
            "Require a fem_static_pbc_supercell_validation.v1 JSON report with "
            "status=ok before accepting the equilibrium."
        ),
    )
    parser.add_argument(
        "--require-repeated-state-supercell-report",
        type=Path,
        default=None,
        help=(
            "Require a fem_static_pbc_supercell_validation.v1 JSON report whose "
            "supercell artifact was seeded through initial_magnetization_state_override."
        ),
    )
    parser.add_argument(
        "--require-interpolated-supercell-report",
        type=Path,
        default=None,
        help=(
            "Require a fem_static_pbc_supercell_validation.v1 JSON report with "
            "acceptance_basis=interpolated_remesh."
        ),
    )
    parser.add_argument(
        "--supercell-repeat",
        type=int,
        nargs=2,
        metavar=("REPEAT_X", "REPEAT_Y"),
        default=None,
        help=(
            "Validate a prepared repeated-supercell artifact instead of the primitive "
            "periodic-antidot unit-cell artifact."
        ),
    )
    parser.add_argument(
        "--require-initial-magnetization-state-override",
        action="store_true",
        help=(
            "Require metadata proving the run was seeded from a file-backed initial "
            "magnetization state."
        ),
    )
    args = parser.parse_args()
    if args.min_steps < 1:
        parser.error("--min-steps must be positive")
    if not math.isfinite(args.max_final_torque_apm) or args.max_final_torque_apm <= 0.0:
        parser.error("--max-final-torque-apm must be a positive finite number")
    if not math.isfinite(args.max_m_seam_mismatch) or args.max_m_seam_mismatch < 0.0:
        parser.error("--max-m-seam-mismatch must be a non-negative finite number")
    if (
        not math.isfinite(args.max_h_demag_seam_mismatch_apm)
        or args.max_h_demag_seam_mismatch_apm < 0.0
    ):
        parser.error("--max-h-demag-seam-mismatch-apm must be a non-negative finite number")
    if (
        not math.isfinite(args.max_demag_phi_seam_mismatch_a)
        or args.max_demag_phi_seam_mismatch_a < 0.0
    ):
        parser.error("--max-demag-phi-seam-mismatch-a must be a non-negative finite number")
    if (
        not math.isfinite(args.max_b_normal_flux_seam_mismatch_t)
        or args.max_b_normal_flux_seam_mismatch_t < 0.0
    ):
        parser.error("--max-b-normal-flux-seam-mismatch-t must be a non-negative finite number")
    if (
        not math.isfinite(args.max_side_magnetic_charge_sum_abs_am)
        or args.max_side_magnetic_charge_sum_abs_am < 0.0
    ):
        parser.error("--max-side-magnetic-charge-sum-abs-am must be a non-negative finite number")
    if args.supercell_repeat is not None:
        repeat_x, repeat_y = args.supercell_repeat
        if repeat_x < 1 or repeat_y < 1 or repeat_x * repeat_y <= 1:
            parser.error("--supercell-repeat must describe a repeated cell count greater than one")
    return args


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


def require_finite_number(value: Any, name: str) -> float:
    require(isinstance(value, (int, float)), f"{name} must be a finite number")
    number = float(value)
    require(math.isfinite(number), f"{name} must be finite")
    return number


def load_last_json_object(text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    last: dict[str, Any] | None = None
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            last = value
    if last is None:
        fail("runtime log does not contain a JSON run summary")
    return last


def resolve_artifact_dir(summary: dict[str, Any], log_path: Path) -> Path:
    raw = summary.get("artifact_dir")
    require(isinstance(raw, str) and raw, "JSON run summary must include artifact_dir")
    path = Path(raw)
    if not path.is_absolute():
        path = (log_path.parent / path).resolve()
        if not path.exists():
            path = (Path.cwd() / raw).resolve()
    require(path.is_dir(), f"artifact_dir does not exist or is not a directory: {path}")
    return path


def load_metadata(artifact_dir: Path) -> dict[str, Any]:
    path = artifact_dir / "metadata.json"
    require(path.is_file(), f"missing metadata artifact: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    return require_object(value, "metadata")


def load_periodic_pairs_artifact(artifact_dir: Path) -> dict[str, Any]:
    path = artifact_dir / "mesh" / "periodic_pairs.v1.json"
    require(path.is_file(), f"missing periodic pairs artifact: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    return require_object(value, "mesh/periodic_pairs.v1.json")


def load_node_geometry_artifact(artifact_dir: Path) -> dict[str, Any]:
    path = artifact_dir / "mesh" / "node_geometry.v1.json"
    require(path.is_file(), f"missing node geometry artifact: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    return require_object(value, "mesh/node_geometry.v1.json")


def load_final_magnetization_artifact(artifact_dir: Path) -> dict[str, Any]:
    path = artifact_dir / "m_final.json"
    require(path.is_file(), f"missing final magnetization artifact: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    return require_object(value, "m_final.json")


def load_initial_magnetization_artifact(artifact_dir: Path) -> dict[str, Any]:
    path = artifact_dir / "m_initial.json"
    require(path.is_file(), f"missing initial magnetization artifact: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    return require_object(value, "m_initial.json")


def load_demag_field_snapshot_artifact(artifact_dir: Path) -> dict[str, Any]:
    field_dir = artifact_dir / "fields" / "H_demag"
    if field_dir.is_dir():
        candidates = sorted(field_dir.glob("step_*.json"))
        require(candidates, f"missing H_demag field snapshot artifact in {field_dir}")
        value = json.loads(candidates[-1].read_text(encoding="utf-8"))
        return require_object(value, str(candidates[-1]))
    return load_zarr_field_snapshot_artifact(artifact_dir, "H_demag")


def load_demag_phi_snapshot_artifact(artifact_dir: Path) -> dict[str, Any]:
    field_dir = artifact_dir / "fields" / "demag_phi"
    if field_dir.is_dir():
        candidates = sorted(field_dir.glob("step_*.json"))
        require(candidates, f"missing demag_phi field snapshot artifact in {field_dir}")
        value = json.loads(candidates[-1].read_text(encoding="utf-8"))
        return require_object(value, str(candidates[-1]))
    return load_zarr_field_snapshot_artifact(artifact_dir, "demag_phi")


def load_zarr_field_snapshot_artifact(artifact_dir: Path, observable: str) -> dict[str, Any]:
    field_dir = artifact_dir / "fields" / f"{observable}.zarr"
    require(field_dir.is_dir(), f"missing {observable} zarr field snapshot directory: {field_dir}")
    attrs_path = field_dir / ".zattrs"
    array_path = field_dir / ".zarray"
    samples_path = field_dir / "samples.csv"
    require(attrs_path.is_file(), f"missing {observable} zarr attrs: {attrs_path}")
    require(array_path.is_file(), f"missing {observable} zarr array metadata: {array_path}")
    require(samples_path.is_file(), f"missing {observable} zarr sample index: {samples_path}")
    attrs = require_object(json.loads(attrs_path.read_text(encoding="utf-8")), str(attrs_path))
    array = require_object(json.loads(array_path.read_text(encoding="utf-8")), str(array_path))
    with samples_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    require(rows, f"{observable} zarr samples.csv must contain at least one sample")
    sample = rows[-1]
    chunk_key = sample.get("chunk_key")
    require(isinstance(chunk_key, str) and chunk_key, f"{observable} zarr chunk_key must be non-empty")
    chunk_path = field_dir / chunk_key
    require(chunk_path.is_file(), f"missing {observable} zarr chunk: {chunk_path}")
    require(array.get("dtype") == "<f8", f"{observable} zarr dtype must be <f8, got {array.get('dtype')!r}")
    require(array.get("order") == "C", f"{observable} zarr order must be C, got {array.get('order')!r}")
    shape = require_list(array.get("shape"), f"{observable} zarr shape")
    require(
        len(shape) == 3
        and isinstance(shape[0], int)
        and isinstance(shape[1], int)
        and isinstance(shape[2], int),
        f"{observable} zarr shape must be [sample_count, component_count, cell_count], got {shape!r}",
    )
    sample_count = int(shape[0])
    component_count = int(shape[1])
    cell_count = int(shape[2])
    require(
        sample_count > 0 and component_count > 0 and cell_count > 0,
        f"{observable} zarr shape must be positive",
    )
    require(
        len(rows) <= sample_count,
        f"{observable} zarr samples.csv has {len(rows)} rows but shape declares {sample_count} samples",
    )
    raw = chunk_path.read_bytes()
    expected_values = component_count * cell_count
    require(
        len(raw) == expected_values * 8,
        f"{observable} zarr chunk byte length must be {expected_values * 8}, got {len(raw)}",
    )
    values = list(struct.unpack(f"<{expected_values}d", raw))
    component_order = require_list(attrs.get("component_order"), f"{observable} zarr component_order")
    if component_order == ["x", "y", "z"]:
        require(component_count == 3, f"{observable} vector zarr must have 3 components")
        field_values: list[Any] = [
            [values[index], values[cell_count + index], values[2 * cell_count + index]]
            for index in range(cell_count)
        ]
    elif component_order == ["scalar"]:
        require(component_count == 1, f"{observable} scalar zarr must have 1 component")
        field_values = values
    else:
        fail(f"{observable} zarr has unsupported component_order {component_order!r}")
    try:
        step = int(sample.get("step", "-1"))
        time = float(sample.get("time", "nan"))
        solver_dt = float(sample.get("solver_dt", "nan"))
    except (TypeError, ValueError):
        fail(f"{observable} zarr sample has invalid step/time/solver_dt")
    return {
        "observable": attrs.get("observable"),
        "unit": attrs.get("unit"),
        "step": step,
        "time": time,
        "solver_dt": solver_dt,
        "values": field_values,
    }


def load_static_pbc_demag_seam_diagnostics_artifact(artifact_dir: Path) -> dict[str, Any]:
    path = artifact_dir / "diagnostics" / "fem_static_pbc_demag_seams.v1.json"
    require(path.is_file(), f"missing static PBC demag seam diagnostics artifact: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    return require_object(value, "diagnostics/fem_static_pbc_demag_seams.v1.json")


def load_scalars_rows(artifact_dir: Path) -> list[dict[str, str]]:
    path = artifact_dir / "scalars.csv"
    require(path.is_file(), f"missing scalar history artifact: {path}")
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    return rows


def load_required_report(path: Path, report_name: str) -> dict[str, Any]:
    require(path.is_file(), f"missing required {report_name} comparison report: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    return require_object(value, f"{report_name} comparison report")


def expected_problem_name(scenario: str, supercell_repeat: list[int] | None) -> str:
    if scenario == "uniform_slab":
        name = "fem_periodic_uniform_slab_relax"
    else:
        name = f"fem_periodic_antidot_relax_{scenario}"
    if supercell_repeat is not None:
        name = f"{name}_supercell_{supercell_repeat[0]}x{supercell_repeat[1]}"
    return name


def validate_text_markers(text: str, engine: str) -> None:
    expected_engine = "fem_native_gpu" if engine == "gpu" else "fem_cpu_native"
    require(
        f"resolved_engine_id={expected_engine} fallback=None" in text,
        f"runtime log must show resolved_engine_id={expected_engine} fallback=None",
    )
    require(
        f"native FEM backend active: engine={expected_engine}" in text,
        f"runtime log must show the native FEM {engine.upper()} backend as active",
    )
    for marker in [
        "MPI_INIT failed",
        "No network interfaces were found",
        "fallback=Some",
    ]:
        require(marker not in text, f"runtime log contains failure/fallback marker: {marker}")
    if engine == "gpu":
        for marker in [
            "falling back to MFEM/libCEED/hypre CPU FEM",
            "resolved_engine_id=fem_cpu_native",
        ]:
            require(marker not in text, f"runtime log contains GPU fallback marker: {marker}")


def validate_summary(
    summary: dict[str, Any],
    *,
    scenario: str,
    algorithm: str,
    min_steps: int,
    supercell_repeat: list[int] | None,
) -> int:
    require(summary.get("status") == "completed", f"unexpected status: {summary.get('status')!r}")
    require(summary.get("backend") == "fem", f"unexpected backend: {summary.get('backend')!r}")
    require(summary.get("mode") == "strict", f"unexpected mode: {summary.get('mode')!r}")
    require(summary.get("precision") == "double", f"unexpected precision: {summary.get('precision')!r}")
    expected_name = expected_problem_name(scenario, supercell_repeat)
    require(
        summary.get("problem_name") == expected_name,
        f"unexpected problem_name: {summary.get('problem_name')!r}",
    )
    total_steps = summary.get("total_steps")
    require(
        isinstance(total_steps, int) and total_steps >= min_steps,
        f"total_steps must be >= {min_steps}, got {total_steps!r}",
    )
    if algorithm:
        require(isinstance(algorithm, str) and algorithm, "--algorithm must be non-empty")
    return total_steps


def validate_relaxation_qualification(
    metadata: dict[str, Any],
    *,
    algorithm: str,
    min_steps: int,
    engine: str,
) -> None:
    key = (
        "fem_gpu_relaxation_qualification"
        if engine == "gpu"
        else "fem_cpu_relaxation_qualification"
    )
    qualification = require_object(metadata.get(key), f"metadata.{key}")
    require(
        qualification.get("relaxation_algorithm") == algorithm,
        f"{key}.relaxation_algorithm must be {algorithm}",
    )
    executed_steps = qualification.get("executed_steps")
    require(
        isinstance(executed_steps, int) and executed_steps >= min_steps,
        f"{key}.executed_steps must be >= {min_steps}",
    )
    norm_defect = require_finite_number(qualification.get("norm_defect"), f"{key}.norm_defect")
    require(
        0.0 <= norm_defect <= MAX_MAGNETIZATION_NORM_DEFECT,
        f"{key}.norm_defect exceeds {MAX_MAGNETIZATION_NORM_DEFECT:.1e}: {norm_defect:.15e}",
    )
    require(
        isinstance(qualification.get("stop_reason"), str) and qualification.get("stop_reason"),
        f"{key}.stop_reason must be a non-empty string",
    )


def require_close(actual: float, expected: float, message: str) -> None:
    require(
        math.isclose(actual, expected, rel_tol=1.0e-12, abs_tol=1.0e-18),
        f"{message}: got {actual:.15e}, expected {expected:.15e}",
    )


def validate_scenario_metadata(
    metadata: dict[str, Any],
    scenario: str,
    *,
    supercell_repeat: list[int] | None,
) -> None:
    scenario_meta = require_object(
        metadata.get("periodic_antidot_relaxation"),
        "metadata.periodic_antidot_relaxation",
    )
    require(
        scenario_meta.get("scenario") == scenario,
        f"scenario metadata mismatch: {scenario_meta.get('scenario')!r}",
    )
    require(
        scenario_meta.get("magnetostatic_pbc") == "periodic_airbox_k0",
        "scenario metadata must request magnetostatic_pbc=periodic_airbox_k0",
    )
    require(
        scenario_meta.get("periodic_pair_ids") == ["x_faces", "y_faces"],
        "scenario metadata must use x_faces/y_faces PBC",
    )
    coupled = scenario_meta.get("exchange_coupled_across_periods")
    require(isinstance(coupled, bool), "exchange_coupled_across_periods must be boolean")
    require(
        coupled is (scenario in {"exchange_coupled", "uniform_slab"}),
        "exchange_coupled_across_periods does not match requested scenario",
    )
    film_size = [require_finite_number(v, f"film_size_m[{i}]") for i, v in enumerate(require_list(scenario_meta.get("film_size_m"), "film_size_m"))]
    universe_size = [require_finite_number(v, f"universe_size_m[{i}]") for i, v in enumerate(require_list(scenario_meta.get("universe_size_m"), "universe_size_m"))]
    lateral_gap = [require_finite_number(v, f"lateral_air_gap_m[{i}]") for i, v in enumerate(require_list(scenario_meta.get("lateral_air_gap_m"), "lateral_air_gap_m"))]
    require(len(film_size) == 3, "film_size_m must be a 3-vector")
    require(len(universe_size) == 3, "universe_size_m must be a 3-vector")
    require(len(lateral_gap) == 2, "lateral_air_gap_m must be a 2-vector")
    raw_supercell_repeat = scenario_meta.get("supercell_repeat")
    if supercell_repeat is None:
        require(
            raw_supercell_repeat is None,
            "primitive validation must not receive metadata.periodic_antidot_relaxation.supercell_repeat",
        )
    else:
        require(
            scenario == "exchange_coupled",
            "prepared supercell validation currently supports only exchange_coupled",
        )
        require(
            raw_supercell_repeat == supercell_repeat,
            (
                "metadata.periodic_antidot_relaxation.supercell_repeat must match "
                f"{supercell_repeat!r}"
            ),
        )
    if scenario == "air_gap":
        require(
            lateral_gap[0] > 0.0 and lateral_gap[1] > 0.0,
            "air_gap scenario must have positive lateral air gap",
        )
        require(
            universe_size[0] > film_size[0] and universe_size[1] > film_size[1],
            "air_gap universe must be laterally larger than the magnetic film",
        )
    else:
        require(
            lateral_gap == [0.0, 0.0],
            "exchange-coupled PBC scenarios must have zero lateral air gap",
        )
        if supercell_repeat is None:
            require(
                universe_size[0] == film_size[0] and universe_size[1] == film_size[1],
                "exchange-coupled PBC universe must match the magnetic film laterally",
            )
        else:
            require_close(
                universe_size[0],
                film_size[0] * supercell_repeat[0],
                "supercell universe_size_m[0] must equal primitive universe x repeat_x",
            )
            require_close(
                universe_size[1],
                film_size[1] * supercell_repeat[1],
                "supercell universe_size_m[1] must equal primitive universe y repeat_y",
            )
            require(
                universe_size[2] > film_size[2],
                "supercell universe_size_m[2] must remain an open-z airbox thickness",
            )


def validate_periodic_mesh_metadata(metadata: dict[str, Any]) -> None:
    mesh = require_object(metadata.get("mesh"), "metadata.mesh")
    boundary_pairs = mesh.get("periodic_boundary_pair_count")
    node_pairs = mesh.get("periodic_node_pair_count")
    require(
        isinstance(boundary_pairs, int) and boundary_pairs >= 2,
        "mesh.periodic_boundary_pair_count must be at least 2",
    )
    require(
        isinstance(node_pairs, int) and node_pairs > 0,
        "mesh.periodic_node_pair_count must be positive",
    )
    by_boundary_id = require_object(
        mesh.get("periodic_boundary_pair_counts_by_id"),
        "mesh.periodic_boundary_pair_counts_by_id",
    )
    by_node_id = require_object(
        mesh.get("periodic_node_pair_counts_by_id"),
        "mesh.periodic_node_pair_counts_by_id",
    )
    for pair_id in ["x_faces", "y_faces"]:
        require(int(by_boundary_id.get(pair_id, 0)) > 0, f"missing boundary pair {pair_id}")
        require(int(by_node_id.get(pair_id, 0)) > 0, f"missing node pair {pair_id}")


def validate_periodic_pairs_artifact(artifact: dict[str, Any], *, scenario: str) -> list[tuple[int, int, str]]:
    require(
        artifact.get("schema_version") == "periodic_pairs.v1",
        f"periodic pairs schema_version must be periodic_pairs.v1, got {artifact.get('schema_version')!r}",
    )
    require(
        artifact.get("validation_status") == "ok",
        f"periodic pairs validation_status must be ok, got {artifact.get('validation_status')!r}",
    )
    pair_count = artifact.get("pair_count")
    require(
        isinstance(pair_count, int) and pair_count >= 2,
        f"periodic pairs pair_count must be at least 2, got {pair_count!r}",
    )
    paired_node_count = artifact.get("paired_node_count")
    require(
        isinstance(paired_node_count, int) and paired_node_count > 0,
        f"periodic pairs paired_node_count must be positive, got {paired_node_count!r}",
    )
    max_residual = artifact.get("max_translation_residual_m")
    if max_residual is not None:
        require_finite_number(max_residual, "periodic pairs max_translation_residual_m")
    pairs = require_list(artifact.get("pairs"), "periodic pairs pairs")
    pair_ids = set()
    node_pairs: list[tuple[int, int, str]] = []
    for index, pair in enumerate(pairs):
        pair_object = require_object(pair, f"periodic pairs pairs[{index}]")
        pair_id = pair_object.get("pair_id")
        require(isinstance(pair_id, str) and pair_id, f"periodic pairs pairs[{index}].pair_id must be non-empty")
        pair_ids.add(pair_id)
        require(
            pair_object.get("status") == "valid",
            f"periodic pairs pair {pair_id} status must be valid",
        )
        paired = pair_object.get("paired_node_count")
        require(
            isinstance(paired, int) and paired > 0,
            f"periodic pairs pair {pair_id} paired_node_count must be positive",
        )
        domain_counts = require_object(
            pair_object.get("domain_node_pair_counts"),
            f"periodic pairs pair {pair_id}.domain_node_pair_counts",
        )
        magnetic_count = domain_counts.get("magnetic")
        airbox_count = domain_counts.get("airbox")
        require(
            isinstance(magnetic_count, int) and magnetic_count >= 0,
            f"periodic pairs pair {pair_id}.domain_node_pair_counts.magnetic must be non-negative",
        )
        if scenario in {"exchange_coupled", "uniform_slab"}:
            require(
                magnetic_count > 0,
                f"periodic pairs pair {pair_id}.domain_node_pair_counts.magnetic must be positive for exchange-coupled PBC",
            )
        else:
            require(
                scenario == "air_gap",
                f"unsupported scenario for periodic-pair domain validation: {scenario!r}",
            )
        require(
            magnetic_count > 0 or scenario == "air_gap",
            f"periodic pairs pair {pair_id}.domain_node_pair_counts.magnetic must be positive",
        )
        require(
            isinstance(airbox_count, int) and airbox_count > 0,
            f"periodic pairs pair {pair_id}.domain_node_pair_counts.airbox must be positive",
        )
        require(
            magnetic_count + airbox_count == paired,
            f"periodic pairs pair {pair_id}.domain_node_pair_counts must sum to paired_node_count",
        )
        require_finite_number(pair_object.get("max_residual_m"), f"periodic pairs pair {pair_id}.max_residual_m")
        unpaired_source = pair_object.get("unpaired_source_node_count")
        unpaired_destination = pair_object.get("unpaired_destination_node_count")
        require(
            isinstance(unpaired_source, int) and unpaired_source == 0,
            f"periodic pairs pair {pair_id} has unpaired source nodes",
        )
        require(
            isinstance(unpaired_destination, int) and unpaired_destination == 0,
            f"periodic pairs pair {pair_id} has unpaired destination nodes",
        )
        raw_node_pairs = require_list(
            pair_object.get("node_pairs"),
            f"periodic pairs pair {pair_id}.node_pairs",
        )
        require(
            len(raw_node_pairs) == paired,
            f"periodic pairs pair {pair_id}.node_pairs must contain {paired} entries, got {len(raw_node_pairs)}",
        )
        raw_face_pairs = require_list(
            pair_object.get("boundary_face_pairs"),
            f"periodic pairs pair {pair_id}.boundary_face_pairs",
        )
        require(
            len(raw_face_pairs) > 0,
            f"periodic pairs pair {pair_id}.boundary_face_pairs must be non-empty",
        )
        for face_pair_index, raw_face_pair in enumerate(raw_face_pairs):
            face_pair = require_object(
                raw_face_pair,
                f"periodic pairs pair {pair_id}.boundary_face_pairs[{face_pair_index}]",
            )
            face_a = face_pair.get("face_a")
            face_b = face_pair.get("face_b")
            require(
                isinstance(face_a, int) and face_a >= 0,
                f"periodic pairs pair {pair_id}.boundary_face_pairs[{face_pair_index}].face_a must be non-negative integer",
            )
            require(
                isinstance(face_b, int) and face_b >= 0,
                f"periodic pairs pair {pair_id}.boundary_face_pairs[{face_pair_index}].face_b must be non-negative integer",
            )
            translation = require_list(
                face_pair.get("translation_m"),
                f"periodic pairs pair {pair_id}.boundary_face_pairs[{face_pair_index}].translation_m",
            )
            require(
                len(translation) == 3,
                f"periodic pairs pair {pair_id}.boundary_face_pairs[{face_pair_index}].translation_m must be a 3-vector",
            )
            for component_index, component in enumerate(translation):
                require_finite_number(
                    component,
                    f"periodic pairs pair {pair_id}.boundary_face_pairs[{face_pair_index}].translation_m[{component_index}]",
                )
            orientation = face_pair.get("orientation")
            require(
                orientation == "opposed_normals",
                f"periodic pairs pair {pair_id}.boundary_face_pairs[{face_pair_index}].orientation must be opposed_normals",
            )
            normal_dot = require_finite_number(
                face_pair.get("normal_dot"),
                f"periodic pairs pair {pair_id}.boundary_face_pairs[{face_pair_index}].normal_dot",
            )
            require(
                normal_dot <= -0.999,
                f"periodic pairs pair {pair_id}.boundary_face_pairs[{face_pair_index}].normal_dot must be <= -0.999",
            )
        for node_pair_index, raw_node_pair in enumerate(raw_node_pairs):
            node_pair = require_object(
                raw_node_pair,
                f"periodic pairs pair {pair_id}.node_pairs[{node_pair_index}]",
            )
            node_a = node_pair.get("node_a")
            node_b = node_pair.get("node_b")
            require(
                isinstance(node_a, int) and node_a >= 0,
                f"periodic pairs pair {pair_id}.node_pairs[{node_pair_index}].node_a must be non-negative integer",
            )
            require(
                isinstance(node_b, int) and node_b >= 0,
                f"periodic pairs pair {pair_id}.node_pairs[{node_pair_index}].node_b must be non-negative integer",
            )
            node_pairs.append((node_a, node_b, pair_id))
    for pair_id in ["x_faces", "y_faces"]:
        require(pair_id in pair_ids, f"periodic pairs artifact missing pair {pair_id}")
    return node_pairs


def validate_supercell_node_geometry_artifact(
    artifact: dict[str, Any],
    *,
    expected_node_count: int,
    expected_vector_field_count: int,
    expected_scalar_field_count: int,
) -> None:
    require(
        artifact.get("schema_version") == "fem_mesh_node_geometry.v1",
        (
            "node geometry schema_version must be fem_mesh_node_geometry.v1, "
            f"got {artifact.get('schema_version')!r}"
        ),
    )
    require(
        artifact.get("artifact_path") == "mesh/node_geometry.v1.json",
        "node geometry artifact_path must be mesh/node_geometry.v1.json",
    )
    node_count = artifact.get("node_count")
    require(
        isinstance(node_count, int) and node_count == expected_node_count,
        f"node geometry node_count must match m_final node count {expected_node_count}, got {node_count!r}",
    )
    nodes_m = require_list(artifact.get("nodes_m"), "node geometry nodes_m")
    require(
        len(nodes_m) == node_count,
        f"node geometry nodes_m length must match node_count {node_count}, got {len(nodes_m)}",
    )
    for node_index, raw_node in enumerate(nodes_m):
        node = require_list(raw_node, f"node geometry nodes_m[{node_index}]")
        require(len(node) == 3, f"node geometry nodes_m[{node_index}] must be a 3-vector")
        for component_index, component in enumerate(node):
            require_finite_number(
                component,
                f"node geometry nodes_m[{node_index}][{component_index}]",
            )
    magnetic_node_mask = require_list(
        artifact.get("magnetic_node_mask"),
        "node geometry magnetic_node_mask",
    )
    require(
        len(magnetic_node_mask) == node_count,
        (
            "node geometry magnetic_node_mask length must match node_count "
            f"{node_count}, got {len(magnetic_node_mask)}"
        ),
    )
    require(
        all(isinstance(value, bool) for value in magnetic_node_mask),
        "node geometry magnetic_node_mask must contain booleans",
    )
    magnetic_node_count = artifact.get("magnetic_node_count")
    require(
        isinstance(magnetic_node_count, int) and magnetic_node_count == sum(magnetic_node_mask),
        "node geometry magnetic_node_count must equal true magnetic_node_mask entries",
    )
    require(magnetic_node_count > 0, "node geometry magnetic_node_count must be positive")
    alignment = require_object(artifact.get("field_cell_alignment"), "node geometry field_cell_alignment")
    require(
        alignment.get("m") == "node_index",
        "node geometry field_cell_alignment.m must be node_index",
    )
    require(
        alignment.get("H_demag") == "node_index",
        "node geometry field_cell_alignment.H_demag must be node_index",
    )
    require(
        alignment.get("H_eff") == "node_index",
        "node geometry field_cell_alignment.H_eff must be node_index",
    )
    require(
        alignment.get("demag_phi") == "node_index",
        "node geometry field_cell_alignment.demag_phi must be node_index",
    )
    require(
        expected_vector_field_count == node_count,
        (
            "H_demag snapshot count must match node geometry node_count "
            f"{node_count}, got {expected_vector_field_count}"
        ),
    )
    require(
        expected_scalar_field_count == node_count,
        (
            "demag_phi snapshot count must match node geometry node_count "
            f"{node_count}, got {expected_scalar_field_count}"
        ),
    )


def validate_vector_field_values(values: Any, name: str) -> list[list[float]]:
    field_values = require_list(values, f"{name} values")
    require(len(field_values) > 0, f"{name} values must be non-empty")
    normalized_values: list[list[float]] = []
    for value_index, raw_value in enumerate(field_values):
        vector = require_list(raw_value, f"{name} values[{value_index}]")
        require(len(vector) == 3, f"{name} values[{value_index}] must be a 3-vector")
        normalized_vector = []
        for component_index, component in enumerate(vector):
            normalized_vector.append(
                require_finite_number(component, f"{name} values[{value_index}][{component_index}]")
            )
        normalized_values.append(normalized_vector)
    return normalized_values


def validate_scalar_field_values(values: Any, name: str) -> list[float]:
    field_values = require_list(values, f"{name} values")
    require(len(field_values) > 0, f"{name} values must be non-empty")
    return [
        require_finite_number(value, f"{name} values[{value_index}]")
        for value_index, value in enumerate(field_values)
    ]


def validate_final_magnetization_artifact(artifact: dict[str, Any]) -> tuple[int, list[list[float]]]:
    require(
        artifact.get("observable") == "m",
        f"m_final.json observable must be m, got {artifact.get('observable')!r}",
    )
    require(
        artifact.get("unit") == "dimensionless",
        f"m_final.json unit must be dimensionless, got {artifact.get('unit')!r}",
    )
    step = artifact.get("step")
    require(isinstance(step, int) and step >= 0, f"m_final.json step must be non-negative, got {step!r}")
    require_finite_number(artifact.get("time"), "m_final.json time")
    return step, validate_vector_field_values(artifact.get("values"), "m_final.json")


def validate_initial_magnetization_artifact(artifact: dict[str, Any]) -> list[list[float]]:
    require(
        artifact.get("observable") == "m",
        f"m_initial.json observable must be m, got {artifact.get('observable')!r}",
    )
    require(
        artifact.get("unit") == "dimensionless",
        f"m_initial.json unit must be dimensionless, got {artifact.get('unit')!r}",
    )
    return validate_vector_field_values(artifact.get("values"), "m_initial.json")


def validate_demag_field_snapshot_artifact(
    artifact: dict[str, Any],
    *,
    expected_step: int,
) -> list[list[float]]:
    require(
        artifact.get("observable") == "H_demag",
        f"H_demag snapshot observable must be H_demag, got {artifact.get('observable')!r}",
    )
    require(
        artifact.get("unit") == "A/m",
        f"H_demag snapshot unit must be A/m, got {artifact.get('unit')!r}",
    )
    step = artifact.get("step")
    require(isinstance(step, int) and step >= 0, f"H_demag snapshot step must be non-negative, got {step!r}")
    require(
        step == expected_step,
        f"H_demag snapshot step must match m_final.json step {expected_step}, got {step}",
    )
    require_finite_number(artifact.get("time"), "H_demag snapshot time")
    return validate_vector_field_values(artifact.get("values"), "H_demag snapshot")


def validate_demag_phi_snapshot_artifact(
    artifact: dict[str, Any],
    *,
    expected_step: int,
) -> list[float]:
    require(
        artifact.get("observable") == "demag_phi",
        f"demag_phi snapshot observable must be demag_phi, got {artifact.get('observable')!r}",
    )
    require(
        artifact.get("unit") == "A",
        f"demag_phi snapshot unit must be A, got {artifact.get('unit')!r}",
    )
    step = artifact.get("step")
    require(isinstance(step, int) and step >= 0, f"demag_phi snapshot step must be non-negative, got {step!r}")
    require(
        step == expected_step,
        f"demag_phi snapshot step must match m_final.json step {expected_step}, got {step}",
    )
    require_finite_number(artifact.get("time"), "demag_phi snapshot time")
    return validate_scalar_field_values(artifact.get("values"), "demag_phi snapshot")


def validate_periodic_field_seam_mismatch(
    *,
    values: list[list[float]],
    node_pairs: list[tuple[int, int, str]],
    field_name: str,
    tolerance: float,
) -> None:
    max_mismatch = 0.0
    max_pair_id = ""
    require(tolerance >= 0.0, f"{field_name} seam tolerance must be non-negative")
    for node_a, node_b, pair_id in node_pairs:
        require(
            node_a < len(values) and node_b < len(values),
            f"{field_name} seam pair {pair_id} references nodes outside field values: {node_a}, {node_b}",
        )
        delta = math.sqrt(
            sum((values[node_a][component] - values[node_b][component]) ** 2 for component in range(3))
        )
        if delta > max_mismatch:
            max_mismatch = delta
            max_pair_id = pair_id
    require(
        max_mismatch <= tolerance,
        f"{field_name} periodic seam mismatch exceeds {tolerance:.6e}: {max_mismatch:.6e} on {max_pair_id}",
    )


def validate_periodic_scalar_field_seam_mismatch(
    *,
    values: list[float],
    node_pairs: list[tuple[int, int, str]],
    field_name: str,
    tolerance: float,
) -> None:
    max_mismatch = 0.0
    max_pair_id = ""
    require(tolerance >= 0.0, f"{field_name} seam tolerance must be non-negative")
    deltas_by_pair_id: dict[str, list[float]] = {}
    for node_a, node_b, pair_id in node_pairs:
        require(
            node_a < len(values) and node_b < len(values),
            f"{field_name} seam pair {pair_id} references nodes outside field values: {node_a}, {node_b}",
        )
        deltas_by_pair_id.setdefault(pair_id, []).append(values[node_a] - values[node_b])
    for pair_id, deltas in deltas_by_pair_id.items():
        best_constant_offset = sum(deltas) / len(deltas)
        for delta in deltas:
            residual = abs(delta - best_constant_offset)
            if residual > max_mismatch:
                max_mismatch = residual
                max_pair_id = pair_id
    require(
        max_mismatch <= tolerance,
        f"{field_name} periodic seam mismatch exceeds {tolerance:.6e} after constant offset: {max_mismatch:.6e} on {max_pair_id}",
    )


def validate_static_pbc_demag_seam_diagnostics(
    artifact: dict[str, Any],
    *,
    expected_step: int,
    max_m_seam_mismatch: float,
    max_h_demag_seam_mismatch_apm: float,
    max_demag_phi_seam_mismatch_a: float,
    max_b_normal_flux_seam_mismatch_t: float,
    max_side_magnetic_charge_sum_abs_am: float,
) -> None:
    require(
        artifact.get("schema_version") == "fem_static_pbc_demag_seams.v1",
        (
            "static PBC demag seam diagnostics schema_version must be "
            f"fem_static_pbc_demag_seams.v1, got {artifact.get('schema_version')!r}"
        ),
    )
    require(
        artifact.get("status") == "ok",
        f"static PBC demag seam diagnostics status must be ok, got {artifact.get('status')!r}",
    )
    step = artifact.get("step")
    require(
        step == expected_step,
        f"static PBC demag seam diagnostics step must match m_final.json step {expected_step}, got {step!r}",
    )
    pair_diagnostics = require_list(
        artifact.get("pair_diagnostics"),
        "static PBC demag seam diagnostics pair_diagnostics",
    )
    pair_ids: set[str] = set()
    for index, raw_pair in enumerate(pair_diagnostics):
        pair = require_object(
            raw_pair,
            f"static PBC demag seam diagnostics pair_diagnostics[{index}]",
        )
        pair_id = pair.get("pair_id")
        require(
            isinstance(pair_id, str) and pair_id,
            f"static PBC demag seam diagnostics pair_diagnostics[{index}].pair_id must be non-empty",
        )
        pair_ids.add(pair_id)
        metric_limits = [
            ("m_seam_max", max_m_seam_mismatch),
            ("h_demag_seam_max_Apm", max_h_demag_seam_mismatch_apm),
            ("demag_phi_seam_max_after_offset_A", max_demag_phi_seam_mismatch_a),
            ("b_normal_flux_seam_max_T", max_b_normal_flux_seam_mismatch_t),
            ("side_magnetic_charge_sum_abs_Am", max_side_magnetic_charge_sum_abs_am),
        ]
        for metric, limit in metric_limits:
            value = require_finite_number(
                pair.get(metric),
                f"static PBC demag seam diagnostics {pair_id}.{metric}",
            )
            require(
                value >= 0.0,
                f"static PBC demag seam diagnostics {pair_id}.{metric} must be non-negative",
            )
            require(
                value <= limit,
                (
                    f"static PBC demag seam diagnostics {pair_id}.{metric} exceeds "
                    f"{limit:.6e}: {value:.6e}"
                ),
            )
    for pair_id in ["x_faces", "y_faces"]:
        require(
            pair_id in pair_ids,
            f"static PBC demag seam diagnostics missing pair {pair_id}",
        )


def finite_csv_number(row: dict[str, str], column: str, row_name: str) -> float:
    require(column in row, f"scalars.csv missing column {column}")
    try:
        value = float(row[column])
    except ValueError as exc:
        fail(f"scalars.csv {row_name}.{column} must be a finite number: {exc}")
    require(math.isfinite(value), f"scalars.csv {row_name}.{column} must be finite")
    return value


def validate_scalar_history(
    rows: list[dict[str, str]],
    *,
    min_steps: int,
    max_final_torque_apm: float,
) -> int:
    require(
        len(rows) >= min_steps,
        f"scalars.csv must contain at least {min_steps} rows, got {len(rows)}",
    )
    first = rows[0]
    final = rows[-1]
    for index, row in enumerate(rows):
        row_name = f"row[{index}]"
        for column in ["time", "E_demag", "E_total", "max_torque_Apm"]:
            finite_csv_number(row, column, row_name)
    initial_total = finite_csv_number(first, "E_total", "first")
    final_total = finite_csv_number(final, "E_total", "final")
    final_demag = finite_csv_number(final, "E_demag", "final")
    final_torque = finite_csv_number(final, "max_torque_Apm", "final")
    final_step_float = finite_csv_number(final, "step", "final")
    final_step = int(final_step_float)
    require(
        final_step_float == final_step and final_step >= min_steps,
        f"scalars.csv final step must be an integer >= {min_steps}, got {final_step_float!r}",
    )
    tolerance = max(abs(initial_total) * 1.0e-9, 1.0e-30)
    require(
        final_total <= initial_total + tolerance,
        f"scalars.csv final E_total increased from {initial_total:.6e} to {final_total:.6e}",
    )
    require(
        final_demag >= -MAX_DEMAG_ENERGY_NEGATIVE_NOISE_J,
        (
            "scalars.csv final E_demag must be non-negative within "
            f"{MAX_DEMAG_ENERGY_NEGATIVE_NOISE_J:.1e} J numerical noise"
        ),
    )
    require(
        0.0 <= final_torque <= max_final_torque_apm,
        f"scalars.csv final max_torque_Apm exceeds {max_final_torque_apm:.6e}: {final_torque:.6e}",
    )
    return final_step


def validate_problem_pbc(metadata: dict[str, Any]) -> None:
    pbc = require_object(metadata.get("pbc"), "metadata.pbc")
    require(
        pbc.get("axes") == ["periodic", "periodic", "open"],
        f"metadata.pbc.axes must be ['periodic', 'periodic', 'open'], got {pbc.get('axes')!r}",
    )
    require(
        pbc.get("demag") == "periodic_airbox_k0",
        f"metadata.pbc.demag must be periodic_airbox_k0 for FEM static PBC, got {pbc.get('demag')!r}",
    )
    require(
        "image_counts" not in pbc,
        "metadata.pbc.image_counts must be absent for FEM static PBC",
    )


def validate_initial_magnetization_state_override(
    metadata: dict[str, Any],
    *,
    artifact_dir: Path,
    expected_vector_count: int,
) -> None:
    problem_meta_value = metadata.get("problem_meta")
    require(
        isinstance(problem_meta_value, dict),
        "missing metadata.problem_meta.runtime_metadata.initial_magnetization_state_override",
    )
    problem_meta = problem_meta_value
    runtime_metadata_value = problem_meta.get("runtime_metadata")
    require(
        isinstance(runtime_metadata_value, dict),
        "missing metadata.problem_meta.runtime_metadata.initial_magnetization_state_override",
    )
    runtime_metadata = runtime_metadata_value
    override = require_object(
        runtime_metadata.get("initial_magnetization_state_override"),
        "metadata.problem_meta.runtime_metadata.initial_magnetization_state_override",
    )
    require(
        override.get("kind") == "initial_magnetization_state_override",
        "initial_magnetization_state_override.kind must be initial_magnetization_state_override",
    )
    source_path = override.get("source_path")
    require(
        isinstance(source_path, str) and source_path,
        "initial_magnetization_state_override.source_path must be a non-empty string",
    )
    state_format = override.get("format")
    require(
        state_format == "json",
        f"initial_magnetization_state_override.format must be json for artifact comparison, got {state_format!r}",
    )
    if override.get("dataset") is not None:
        require(
            isinstance(override.get("dataset"), str) and override.get("dataset"),
            "initial_magnetization_state_override.dataset must be null or a non-empty string",
        )
    if override.get("sample_index") is not None:
        require(
            isinstance(override.get("sample_index"), int),
            "initial_magnetization_state_override.sample_index must be null or an integer",
        )
    vector_count = override.get("vector_count")
    require(
        isinstance(vector_count, int) and vector_count == expected_vector_count,
        (
            "initial_magnetization_state_override.vector_count must match m_final vector count "
            f"{expected_vector_count}, got {vector_count!r}"
        ),
    )
    source_file = resolve_initial_magnetization_state_override_source_path(
        source_path,
        artifact_dir=artifact_dir,
    )
    source_state = require_object(
        json.loads(source_file.read_text(encoding="utf-8")),
        "initial_magnetization_state_override source",
    )
    source_values = validate_vector_field_values(
        source_state.get("values"),
        "initial_magnetization_state_override source",
    )
    require(
        len(source_values) == expected_vector_count,
        (
            "initial_magnetization_state_override source vector count must match "
            f"m_final vector count {expected_vector_count}, got {len(source_values)}"
        ),
    )
    initial_values = validate_initial_magnetization_artifact(
        load_initial_magnetization_artifact(artifact_dir)
    )
    require(
        len(initial_values) == len(source_values),
        (
            "m_initial.json vector count must match initial_magnetization_state_override "
            f"source vector count {len(source_values)}, got {len(initial_values)}"
        ),
    )
    max_delta = max(
        abs(initial_values[index][axis] - source_values[index][axis])
        for index in range(len(source_values))
        for axis in range(3)
    )
    require(
        max_delta <= MAX_INITIAL_STATE_OVERRIDE_COMPONENT_DELTA,
        (
            "m_initial.json values must match initial_magnetization_state_override source "
            f"within {MAX_INITIAL_STATE_OVERRIDE_COMPONENT_DELTA:.1e}, got max delta {max_delta:.6e}"
        ),
    )


def resolve_initial_magnetization_state_override_source_path(
    source_path: str,
    *,
    artifact_dir: Path,
) -> Path:
    path = Path(source_path)
    if path.is_absolute():
        candidates = [path]
    else:
        candidates = [
            path,
            artifact_dir / path,
            artifact_dir.parent / path,
        ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    fail(f"initial_magnetization_state_override.source_path file does not exist: {source_path}")


def expected_static_comparison_workload(metadata: dict[str, Any], scenario: str) -> dict[str, Any]:
    pbc = require_object(metadata.get("pbc"), "metadata.pbc")
    scenario_meta = require_object(
        metadata.get("periodic_antidot_relaxation"),
        "metadata.periodic_antidot_relaxation",
    )
    film_size = [
        require_finite_number(value, f"metadata.periodic_antidot_relaxation.film_size_m[{index}]")
        for index, value in enumerate(require_list(scenario_meta.get("film_size_m"), "metadata.periodic_antidot_relaxation.film_size_m"))
    ]
    require(len(film_size) == 3, "metadata.periodic_antidot_relaxation.film_size_m must be a 3-vector")
    lateral_air_gap = [
        require_finite_number(value, f"metadata.periodic_antidot_relaxation.lateral_air_gap_m[{index}]")
        for index, value in enumerate(require_list(scenario_meta.get("lateral_air_gap_m"), "metadata.periodic_antidot_relaxation.lateral_air_gap_m"))
    ]
    require(len(lateral_air_gap) == 2, "metadata.periodic_antidot_relaxation.lateral_air_gap_m must be a 2-vector")
    periodic_pair_ids = [
        str(value)
        for value in require_list(scenario_meta.get("periodic_pair_ids"), "metadata.periodic_antidot_relaxation.periodic_pair_ids")
    ]
    require(periodic_pair_ids, "metadata.periodic_antidot_relaxation.periodic_pair_ids must be non-empty")
    return {
        "axes": require_list(pbc.get("axes"), "metadata.pbc.axes"),
        "scenario": scenario,
        "film_size_m": film_size,
        "lateral_air_gap_m": lateral_air_gap,
        "periodic_pair_ids": periodic_pair_ids,
        "exchange_coupled_across_periods": bool(scenario_meta.get("exchange_coupled_across_periods")),
    }


def comparison_float_list(workload: dict[str, Any], report_name: str, key: str, length: int) -> list[float]:
    values = [
        require_finite_number(value, f"{report_name} comparison report workload.{key}[{index}]")
        for index, value in enumerate(
            require_list(workload.get(key), f"{report_name} comparison report workload.{key}")
        )
    ]
    require(len(values) == length, f"{report_name} comparison report workload.{key} must be a {length}-vector")
    return values


def validate_static_comparison_workload(report: dict[str, Any], *, report_name: str, expected: dict[str, Any]) -> None:
    workload = require_object(report.get("workload"), f"{report_name} comparison report workload")
    axes = require_list(workload.get("axes"), f"{report_name} comparison report workload.axes")
    require(
        axes == expected["axes"],
        f"{report_name} comparison report workload.axes must match {expected['axes']!r}",
    )
    scenario = workload.get("scenario")
    require(
        scenario == expected["scenario"],
        f"{report_name} comparison report workload.scenario must match {expected['scenario']}",
    )
    film_size = comparison_float_list(workload, report_name, "film_size_m", 3)
    require(
        film_size == expected["film_size_m"],
        f"{report_name} comparison report workload.film_size_m must match {expected['film_size_m']!r}",
    )
    lateral_air_gap = comparison_float_list(workload, report_name, "lateral_air_gap_m", 2)
    require(
        lateral_air_gap == expected["lateral_air_gap_m"],
        f"{report_name} comparison report workload.lateral_air_gap_m must match {expected['lateral_air_gap_m']!r}",
    )
    periodic_pair_ids = [
        str(value)
        for value in require_list(workload.get("periodic_pair_ids"), f"{report_name} comparison report workload.periodic_pair_ids")
    ]
    require(
        periodic_pair_ids == expected["periodic_pair_ids"],
        f"{report_name} comparison report workload.periodic_pair_ids must match {expected['periodic_pair_ids']!r}",
    )
    require(
        workload.get("exchange_coupled_across_periods") == expected["exchange_coupled_across_periods"],
        (
            f"{report_name} comparison report workload.exchange_coupled_across_periods must match "
            f"{expected['exchange_coupled_across_periods']!r}"
        ),
    )


def validate_z_padding_workload_geometry(report: dict[str, Any]) -> None:
    workload = require_object(report.get("workload"), "z-padding comparison report workload")
    axes = require_list(workload.get("axes"), "z-padding comparison report workload.axes")
    require(
        axes == ["periodic", "periodic", "open"],
        "z-padding comparison report workload.axes must be ['periodic', 'periodic', 'open']",
    )
    reference_universe = [
        require_finite_number(value, f"z-padding comparison report workload.reference_universe_size_m[{index}]")
        for index, value in enumerate(
            require_list(
                workload.get("reference_universe_size_m"),
                "z-padding comparison report workload.reference_universe_size_m",
            )
        )
    ]
    candidate_universe = [
        require_finite_number(value, f"z-padding comparison report workload.candidate_universe_size_m[{index}]")
        for index, value in enumerate(
            require_list(
                workload.get("candidate_universe_size_m"),
                "z-padding comparison report workload.candidate_universe_size_m",
            )
        )
    ]
    require(
        len(reference_universe) == 3,
        "z-padding comparison report workload.reference_universe_size_m must be a 3-vector",
    )
    require(
        len(candidate_universe) == 3,
        "z-padding comparison report workload.candidate_universe_size_m must be a 3-vector",
    )
    require(
        reference_universe[:2] == candidate_universe[:2],
        "z-padding comparison report workload must have matching lateral universe_size_m",
    )
    require(
        reference_universe[2] > candidate_universe[2],
        "z-padding comparison report workload requires reference open-z universe_size_m thicker than candidate",
    )


def validate_supercell_workload_geometry(report: dict[str, Any]) -> None:
    workload = require_object(report.get("workload"), "supercell comparison report workload")
    axes = require_list(workload.get("axes"), "supercell comparison report workload.axes")
    require(
        axes == ["periodic", "periodic", "open"],
        "supercell comparison report workload.axes must be ['periodic', 'periodic', 'open']",
    )
    unit_universe = [
        require_finite_number(value, f"supercell comparison report workload.unit_universe_size_m[{index}]")
        for index, value in enumerate(
            require_list(
                workload.get("unit_universe_size_m"),
                "supercell comparison report workload.unit_universe_size_m",
            )
        )
    ]
    supercell_universe = [
        require_finite_number(value, f"supercell comparison report workload.supercell_universe_size_m[{index}]")
        for index, value in enumerate(
            require_list(
                workload.get("supercell_universe_size_m"),
                "supercell comparison report workload.supercell_universe_size_m",
            )
        )
    ]
    expected_supercell_universe = [
        require_finite_number(value, f"supercell comparison report workload.expected_supercell_universe_size_m[{index}]")
        for index, value in enumerate(
            require_list(
                workload.get("expected_supercell_universe_size_m"),
                "supercell comparison report workload.expected_supercell_universe_size_m",
            )
        )
    ]
    for name, values in (
        ("unit_universe_size_m", unit_universe),
        ("supercell_universe_size_m", supercell_universe),
        ("expected_supercell_universe_size_m", expected_supercell_universe),
    ):
        require(
            len(values) == 3,
            f"supercell comparison report workload.{name} must be a 3-vector",
        )
    require(
        all(
            math.isclose(actual, expected, rel_tol=1.0e-12, abs_tol=1.0e-18)
            for actual, expected in zip(supercell_universe, expected_supercell_universe)
        ),
        "supercell comparison report workload.supercell_universe_size_m must match expected_supercell_universe_size_m",
    )
    require(
        supercell_universe[0] > unit_universe[0] and supercell_universe[1] > unit_universe[1],
        "supercell comparison report workload requires larger lateral supercell universe_size_m",
    )
    require(
        math.isclose(supercell_universe[2], unit_universe[2], rel_tol=1.0e-12, abs_tol=1.0e-18),
        "supercell comparison report workload requires matching open-z universe_size_m",
    )


def validate_static_comparison_metric_limits(
    metrics: dict[str, Any],
    *,
    report_name: str,
    limits: dict[str, float],
) -> None:
    for metric, limit in limits.items():
        value = require_finite_number(metrics.get(metric), f"{report_name} comparison report metrics.{metric}")
        require(value >= 0.0, f"{report_name} comparison report metrics.{metric} must be non-negative")
        require(
            value <= limit,
            f"{report_name} comparison report metrics.{metric} exceeds {limit:.6e}: {value:.6e}",
        )


def validate_demag_runtime(metadata: dict[str, Any], engine: str) -> None:
    demag = require_object(metadata.get("demag_runtime"), "metadata.demag_runtime")
    require(
        demag.get("model") == "airbox",
        f"demag_runtime.model must be airbox, got {demag.get('model')!r}",
    )
    require(
        demag.get("magnetostatic_boundary_model") == "periodic_airbox_k0",
        (
            "demag_runtime.magnetostatic_boundary_model must be "
            f"periodic_airbox_k0, got {demag.get('magnetostatic_boundary_model')!r}"
        ),
    )
    require(
        demag.get("boundary_variant") == "robin",
        f"demag_runtime.boundary_variant must be robin, got {demag.get('boundary_variant')!r}",
    )
    require(
        demag.get("poisson_operator") == "pbc_reduced_poisson",
        f"demag_runtime.poisson_operator must be pbc_reduced_poisson, got {demag.get('poisson_operator')!r}",
    )
    periodic_reduction = require_object(
        demag.get("periodic_reduction"),
        "demag_runtime.periodic_reduction",
    )
    require(
        periodic_reduction.get("enabled") is True,
        "demag_runtime.periodic_reduction.enabled must be true",
    )
    require(
        periodic_reduction.get("method") == "P^T A P",
        (
            "demag_runtime.periodic_reduction.method must be P^T A P, "
            f"got {periodic_reduction.get('method')!r}"
        ),
    )
    node_pair_count = periodic_reduction.get("node_pair_count")
    require(
        isinstance(node_pair_count, int) and node_pair_count > 0,
        "demag_runtime.periodic_reduction.node_pair_count must be positive",
    )
    boundary_pair_count = periodic_reduction.get("boundary_pair_count")
    require(
        isinstance(boundary_pair_count, int) and boundary_pair_count > 0,
        "demag_runtime.periodic_reduction.boundary_pair_count must be positive",
    )
    require(
        periodic_reduction.get("periodic_boundary_markers_excluded_from_robin") is True,
        (
            "demag_runtime.periodic_reduction."
            "periodic_boundary_markers_excluded_from_robin must be true"
        ),
    )
    require(
        demag.get("linear_solver") in {"CG", "PCG"},
        f"demag_runtime.linear_solver must be CG/PCG, got {demag.get('linear_solver')!r}",
    )
    require(
        demag.get("preconditioner") in {"AMG", "BoomerAMG"},
        f"demag_runtime.preconditioner must be AMG/BoomerAMG, got {demag.get('preconditioner')!r}",
    )
    relative_tolerance = require_finite_number(
        demag.get("relative_tolerance"),
        "demag_runtime.relative_tolerance",
    )
    require(
        0.0 < relative_tolerance <= 1.0e-3,
        "demag_runtime.relative_tolerance must be positive and <= 1e-3",
    )
    max_iterations = demag.get("max_iterations")
    require(
        isinstance(max_iterations, int) and max_iterations > 0,
        "demag_runtime.max_iterations must be positive",
    )
    actual_iterations = demag.get("actual_iterations")
    require(
        isinstance(actual_iterations, int) and 0 < actual_iterations <= max_iterations,
        "demag_runtime.actual_iterations must be positive and <= max_iterations",
    )
    final_residual = require_finite_number(
        demag.get("final_residual_norm"),
        "demag_runtime.final_residual_norm",
    )
    require(
        0.0 <= final_residual <= relative_tolerance,
        "demag_runtime.final_residual_norm must be non-negative and <= relative_tolerance",
    )
    mfem_device = demag.get("mfem_device")
    if engine == "gpu" and isinstance(mfem_device, str):
        require("cuda" in mfem_device.lower(), "GPU demag_runtime.mfem_device must mention cuda")


def validate_equilibrium_observables(
    metadata: dict[str, Any],
    *,
    engine: str,
    max_final_torque_apm: float,
) -> None:
    key = (
        "fem_gpu_relaxation_qualification"
        if engine == "gpu"
        else "fem_cpu_relaxation_qualification"
    )
    qualification = require_object(metadata.get(key), f"metadata.{key}")
    energies = require_object(
        qualification.get("final_energy_terms_j"),
        f"metadata.{key}.final_energy_terms_j",
    )
    e_demag = require_finite_number(energies.get("E_demag"), f"{key}.final_energy_terms_j.E_demag")
    e_total = require_finite_number(energies.get("E_total"), f"{key}.final_energy_terms_j.E_total")
    require(
        e_demag >= -MAX_DEMAG_ENERGY_NEGATIVE_NOISE_J,
        (
            f"{key}.final_energy_terms_j.E_demag must be non-negative within "
            f"{MAX_DEMAG_ENERGY_NEGATIVE_NOISE_J:.1e} J numerical noise"
        ),
    )
    require(math.isfinite(e_total), f"{key}.final_energy_terms_j.E_total must be finite")
    final_torque = require_finite_number(qualification.get("final_torque_apm"), f"{key}.final_torque_apm")
    require(final_torque >= 0.0, f"{key}.final_torque_apm must be non-negative")
    require(
        final_torque <= max_final_torque_apm,
        f"{key}.final_torque_apm exceeds {max_final_torque_apm:.6e}: {final_torque:.6e}",
    )
    if engine == "gpu":
        device_policy = require_object(
            qualification.get("device_policy"),
            f"metadata.{key}.device_policy",
        )
        require(
            device_policy.get("uses_cuda_kernels") is True,
            f"{key}.device_policy.uses_cuda_kernels must be true",
        )
        require(
            device_policy.get("uses_gpu_poisson") is True,
            f"{key}.device_policy.uses_gpu_poisson must be true",
        )
        require(
            device_policy.get("demag_operator_mode") == "device_hypre_poisson",
            f"{key}.device_policy.demag_operator_mode must be device_hypre_poisson",
        )


def validate_static_z_padding_report(report: dict[str, Any], *, expected_workload: dict[str, Any]) -> None:
    require(
        report.get("schema_version") == "fem_static_pbc_z_padding_validation.v1",
        f"z-padding comparison report schema_version must be fem_static_pbc_z_padding_validation.v1, got {report.get('schema_version')!r}",
    )
    require(
        report.get("status") == "ok",
        f"z-padding comparison report status must be ok, got {report.get('status')!r}",
    )
    require(
        isinstance(report.get("reference_artifacts"), str) and report.get("reference_artifacts"),
        "z-padding comparison report reference_artifacts must be a non-empty string",
    )
    require(
        isinstance(report.get("candidate_artifacts"), str) and report.get("candidate_artifacts"),
        "z-padding comparison report candidate_artifacts must be a non-empty string",
    )
    validate_static_comparison_workload(report, report_name="z-padding", expected=expected_workload)
    validate_z_padding_workload_geometry(report)
    metrics = require_object(report.get("metrics"), "z-padding comparison report metrics")
    validate_static_comparison_metric_limits(
        metrics,
        report_name="z-padding",
        limits={
            "e_demag_relative_error": MAX_STATIC_Z_PADDING_E_DEMAG_RELERR,
            "h_demag_p99_relative_error": MAX_STATIC_Z_PADDING_H_DEMAG_P99_RELERR,
            "demag_phi_range_relative_error": MAX_STATIC_Z_PADDING_DEMAG_PHI_RANGE_RELERR,
        },
    )


def validate_supercell_central_cell_extraction_summary(
    report: dict[str, Any],
    *,
    repeat_x: int,
    repeat_y: int,
    cell_count: int,
) -> None:
    extraction = require_object(
        report.get("central_cell_extraction"),
        "supercell comparison report central_cell_extraction",
    )
    require(
        extraction.get("schema_version") == "fem_static_pbc_supercell_central_cell.v1",
        (
            "supercell comparison report central_cell_extraction.schema_version must be "
            f"fem_static_pbc_supercell_central_cell.v1, got {extraction.get('schema_version')!r}"
        ),
    )
    require(
        isinstance(extraction.get("path"), str) and extraction.get("path"),
        "supercell comparison report central_cell_extraction.path must be a non-empty string",
    )
    require(
        extraction.get("repeat_x") == repeat_x,
        "supercell comparison report central_cell_extraction.repeat_x must match repeat_x",
    )
    require(
        extraction.get("repeat_y") == repeat_y,
        "supercell comparison report central_cell_extraction.repeat_y must match repeat_y",
    )
    require(
        extraction.get("cell_count") == cell_count,
        "supercell comparison report central_cell_extraction.cell_count must match cell_count",
    )
    central_index = require_list(
        extraction.get("central_cell_index"),
        "supercell comparison report central_cell_extraction.central_cell_index",
    )
    require(
        len(central_index) == 2,
        "supercell comparison report central_cell_extraction.central_cell_index must be a 2-vector",
    )
    for axis, (value, repeat) in enumerate(zip(central_index, [repeat_x, repeat_y])):
        require(
            isinstance(value, int),
            f"supercell comparison report central_cell_extraction.central_cell_index[{axis}] must be an integer",
        )
        require(
            0 <= value < repeat,
            f"supercell comparison report central_cell_extraction.central_cell_index[{axis}] must be in [0, {repeat})",
        )
    for key in ("magnetic_node_count", "field_cell_count"):
        value = extraction.get(key)
        require(
            isinstance(value, int) and value > 0,
            f"supercell comparison report central_cell_extraction.{key} must be positive",
        )
    for key in ("central_cell_demag_energy_j", "central_cell_torque_apm"):
        value = require_finite_number(
            extraction.get(key),
            f"supercell comparison report central_cell_extraction.{key}",
        )
        require(
            value >= 0.0,
            f"supercell comparison report central_cell_extraction.{key} must be non-negative",
        )


def validate_supercell_relaxation_state_comparability(report: dict[str, Any]) -> dict[str, Any]:
    state = require_object(
        report.get("relaxation_state_comparability"),
        "supercell comparison report relaxation_state_comparability",
    )
    unit_average = require_list(
        state.get("unit_average_m"),
        "supercell comparison report relaxation_state_comparability.unit_average_m",
    )
    central_average = require_list(
        state.get("central_cell_average_m"),
        "supercell comparison report relaxation_state_comparability.central_cell_average_m",
    )
    for name, values in (
        ("unit_average_m", unit_average),
        ("central_cell_average_m", central_average),
    ):
        require(
            len(values) == 3,
            f"supercell comparison report relaxation_state_comparability.{name} must be a 3-vector",
        )
        for index, value in enumerate(values):
            require_finite_number(
                value,
                f"supercell comparison report relaxation_state_comparability.{name}[{index}]",
            )
    for key in (
        "central_cell_average_m_l2_delta",
        "unit_mean_l2_deviation_from_unit_average_m",
        "unit_max_l2_deviation_from_unit_average_m",
        "central_cell_mean_l2_deviation_from_unit_average_m",
        "central_cell_max_l2_deviation_from_unit_average_m",
        "mean_l2_deviation_relative_error",
    ):
        value = require_finite_number(
            state.get(key),
            f"supercell comparison report relaxation_state_comparability.{key}",
        )
        require(
            value >= 0.0,
            f"supercell comparison report relaxation_state_comparability.{key} must be non-negative",
        )
    return state


def validate_supercell_mapped_comparability(report: dict[str, Any]) -> dict[str, Any]:
    mapped = require_object(
        report.get("mapped_central_cell_comparability"),
        "supercell comparison report mapped_central_cell_comparability",
    )
    require(
        mapped.get("schema_version") == "fem_static_pbc_supercell_mapped_comparison.v1",
        (
            "supercell comparison report mapped_central_cell_comparability.schema_version "
            "must be fem_static_pbc_supercell_mapped_comparison.v1"
        ),
    )
    for key in ("magnetic_pair_count", "field_pair_count"):
        value = mapped.get(key)
        require(
            isinstance(value, int) and value > 0,
            f"supercell comparison report mapped_central_cell_comparability.{key} must be positive",
        )
    same_local = mapped.get("same_local_discretization")
    require(
        isinstance(same_local, bool),
        "supercell comparison report mapped_central_cell_comparability.same_local_discretization must be boolean",
    )
    same_local_limit = require_finite_number(
        mapped.get("same_local_discretization_limit_m"),
        "supercell comparison report mapped_central_cell_comparability.same_local_discretization_limit_m",
    )
    require(
        same_local_limit >= 0.0,
        "supercell comparison report mapped_central_cell_comparability.same_local_discretization_limit_m must be non-negative",
    )
    distances: dict[str, float] = {}
    for key in (
        "max_nearest_magnetic_node_distance_m",
        "mean_nearest_magnetic_node_distance_m",
        "max_nearest_field_node_distance_m",
        "mean_nearest_field_node_distance_m",
    ):
        value = require_finite_number(
            mapped.get(key),
            f"supercell comparison report mapped_central_cell_comparability.{key}",
        )
        require(
            value >= 0.0,
            f"supercell comparison report mapped_central_cell_comparability.{key} must be non-negative",
        )
        distances[key] = value
    expected_same_local = (
        distances["max_nearest_magnetic_node_distance_m"] <= same_local_limit
        and distances["max_nearest_field_node_distance_m"] <= same_local_limit
    )
    require(
        same_local == expected_same_local,
        (
            "supercell comparison report mapped_central_cell_comparability.same_local_discretization "
            "must match max nearest-node distances and same_local_discretization_limit_m"
        ),
    )
    for section_name in ("m", "H_demag"):
        section = require_object(
            mapped.get(section_name),
            f"supercell comparison report mapped_central_cell_comparability.{section_name}",
        )
        for key in ("mean_l2_delta", "p99_l2_delta", "max_l2_delta", "p99_relative_error"):
            value = require_finite_number(
                section.get(key),
                f"supercell comparison report mapped_central_cell_comparability.{section_name}.{key}",
            )
            require(
                value >= 0.0,
                (
                    "supercell comparison report "
                    f"mapped_central_cell_comparability.{section_name}.{key} must be non-negative"
                ),
            )
    phi = require_object(
        mapped.get("demag_phi"),
        "supercell comparison report mapped_central_cell_comparability.demag_phi",
    )
    require_finite_number(
        phi.get("best_constant_offset_A"),
        "supercell comparison report mapped_central_cell_comparability.demag_phi.best_constant_offset_A",
    )
    for key in (
        "mean_abs_delta_after_offset_A",
        "p99_abs_delta_after_offset_A",
        "max_abs_delta_after_offset_A",
    ):
        value = require_finite_number(
            phi.get(key),
            f"supercell comparison report mapped_central_cell_comparability.demag_phi.{key}",
        )
        require(
            value >= 0.0,
            f"supercell comparison report mapped_central_cell_comparability.demag_phi.{key} must be non-negative",
        )
    return mapped


def validate_nonnegative_stats_section(section: dict[str, Any], *, name: str) -> None:
    for key in ("mean_l2_delta", "p99_l2_delta", "max_l2_delta", "p99_relative_error"):
        value = require_finite_number(section.get(key), f"{name}.{key}")
        require(value >= 0.0, f"{name}.{key} must be non-negative")


def validate_supercell_interpolated_comparability(report: dict[str, Any]) -> dict[str, Any] | None:
    raw = report.get("interpolated_central_cell_comparability")
    if raw is None:
        return None
    interpolated = require_object(
        raw,
        "supercell comparison report interpolated_central_cell_comparability",
    )
    require(
        interpolated.get("schema_version") == "fem_static_pbc_supercell_interpolated_comparison.v1",
        (
            "supercell comparison report interpolated_central_cell_comparability.schema_version "
            "must be fem_static_pbc_supercell_interpolated_comparison.v1"
        ),
    )
    for key in ("field_sample_count", "field_located_count", "magnetic_sample_count", "magnetic_located_count"):
        value = interpolated.get(key)
        require(
            isinstance(value, int) and value > 0,
            f"supercell comparison report interpolated_central_cell_comparability.{key} must be positive",
        )
    for key in ("field_missed_count", "magnetic_missed_count"):
        value = interpolated.get(key)
        require(
            isinstance(value, int) and value >= 0,
            f"supercell comparison report interpolated_central_cell_comparability.{key} must be non-negative",
        )
    for key in ("field_coverage_ratio", "magnetic_coverage_ratio"):
        value = require_finite_number(
            interpolated.get(key),
            f"supercell comparison report interpolated_central_cell_comparability.{key}",
        )
        require(
            0.0 <= value <= 1.0,
            f"supercell comparison report interpolated_central_cell_comparability.{key} must be in [0, 1]",
        )
    barycentric_tolerance = require_finite_number(
        interpolated.get("barycentric_tolerance"),
        "supercell comparison report interpolated_central_cell_comparability.barycentric_tolerance",
    )
    require(
        barycentric_tolerance >= 0.0,
        "supercell comparison report interpolated_central_cell_comparability.barycentric_tolerance must be non-negative",
    )
    require_finite_number(
        interpolated.get("min_barycentric_weight"),
        "supercell comparison report interpolated_central_cell_comparability.min_barycentric_weight",
    )
    for section_name in ("m", "H_demag"):
        validate_nonnegative_stats_section(
            require_object(
                interpolated.get(section_name),
                f"supercell comparison report interpolated_central_cell_comparability.{section_name}",
            ),
            name=f"supercell comparison report interpolated_central_cell_comparability.{section_name}",
        )
    phi = require_object(
        interpolated.get("demag_phi"),
        "supercell comparison report interpolated_central_cell_comparability.demag_phi",
    )
    require_finite_number(
        phi.get("best_constant_offset_A"),
        "supercell comparison report interpolated_central_cell_comparability.demag_phi.best_constant_offset_A",
    )
    for key in (
        "mean_abs_delta_after_offset_A",
        "p99_abs_delta_after_offset_A",
        "max_abs_delta_after_offset_A",
    ):
        value = require_finite_number(
            phi.get(key),
            f"supercell comparison report interpolated_central_cell_comparability.demag_phi.{key}",
        )
        require(
            value >= 0.0,
            f"supercell comparison report interpolated_central_cell_comparability.demag_phi.{key} must be non-negative",
        )
    return interpolated


def validate_static_supercell_report_structure(
    report: dict[str, Any],
    *,
    expected_workload: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    require(
        report.get("schema_version") == "fem_static_pbc_supercell_validation.v1",
        f"supercell comparison report schema_version must be fem_static_pbc_supercell_validation.v1, got {report.get('schema_version')!r}",
    )
    require(
        report.get("status") == "ok",
        f"supercell comparison report status must be ok, got {report.get('status')!r}",
    )
    require(
        isinstance(report.get("unit_cell_artifacts"), str) and report.get("unit_cell_artifacts"),
        "supercell comparison report unit_cell_artifacts must be a non-empty string",
    )
    require(
        isinstance(report.get("supercell_artifacts"), str) and report.get("supercell_artifacts"),
        "supercell comparison report supercell_artifacts must be a non-empty string",
    )
    validate_static_comparison_workload(report, report_name="supercell", expected=expected_workload)
    validate_supercell_workload_geometry(report)
    repeat_x = report.get("repeat_x")
    repeat_y = report.get("repeat_y")
    cell_count = report.get("cell_count")
    require(isinstance(repeat_x, int) and repeat_x > 0, "supercell comparison report repeat_x must be positive")
    require(isinstance(repeat_y, int) and repeat_y > 0, "supercell comparison report repeat_y must be positive")
    require(
        isinstance(cell_count, int) and cell_count == repeat_x * repeat_y and cell_count > 1,
        "supercell comparison report cell_count must equal repeat_x * repeat_y and be greater than one",
    )
    validate_supercell_central_cell_extraction_summary(
        report,
        repeat_x=repeat_x,
        repeat_y=repeat_y,
        cell_count=cell_count,
    )
    mapped = validate_supercell_mapped_comparability(report)
    interpolated = validate_supercell_interpolated_comparability(report)
    return mapped, interpolated


def validate_static_supercell_report(report: dict[str, Any], *, expected_workload: dict[str, Any]) -> None:
    mapped, _ = validate_static_supercell_report_structure(report, expected_workload=expected_workload)
    relaxation_state = validate_supercell_relaxation_state_comparability(report)
    metrics = require_object(report.get("metrics"), "supercell comparison report metrics")
    metric_state_relerr = require_finite_number(
        metrics.get("relaxation_state_mean_deviation_relative_error"),
        "supercell comparison report metrics.relaxation_state_mean_deviation_relative_error",
    )
    state_relerr = require_finite_number(
        relaxation_state.get("mean_l2_deviation_relative_error"),
        "supercell comparison report relaxation_state_comparability.mean_l2_deviation_relative_error",
    )
    require(
        math.isclose(metric_state_relerr, state_relerr, rel_tol=1.0e-12, abs_tol=1.0e-15),
        (
            "supercell comparison report metrics.relaxation_state_mean_deviation_relative_error "
            "must match relaxation_state_comparability.mean_l2_deviation_relative_error"
        ),
    )
    mapped_metric_pairs = {
        "mapped_m_p99_l2_delta": mapped["m"]["p99_l2_delta"],
        "mapped_h_demag_p99_relative_error": mapped["H_demag"]["p99_relative_error"],
        "mapped_demag_phi_max_abs_delta_after_offset_A": mapped["demag_phi"][
            "max_abs_delta_after_offset_A"
        ],
        "mapped_max_nearest_field_node_distance_m": mapped["max_nearest_field_node_distance_m"],
        "mapped_max_nearest_magnetic_node_distance_m": mapped["max_nearest_magnetic_node_distance_m"],
    }
    for metric, expected in mapped_metric_pairs.items():
        value = require_finite_number(metrics.get(metric), f"supercell comparison report metrics.{metric}")
        require(
            math.isclose(value, expected, rel_tol=1.0e-12, abs_tol=1.0e-18),
            (
                f"supercell comparison report metrics.{metric} must match "
                "mapped_central_cell_comparability"
            ),
        )
    validate_static_comparison_metric_limits(
        metrics,
        report_name="supercell",
        limits={
            "average_m_l2_delta": MAX_STATIC_SUPERCELL_AVERAGE_M_L2_DELTA,
            "e_demag_density_relative_error": MAX_STATIC_SUPERCELL_E_DEMAG_DENSITY_RELERR,
            "h_demag_stats_relative_error": MAX_STATIC_SUPERCELL_H_DEMAG_STATS_RELERR,
            "demag_phi_max_abs_delta_A": MAX_STATIC_SUPERCELL_DEMAG_PHI_DELTA_A,
            "central_cell_torque_residual_relative_error": MAX_STATIC_SUPERCELL_TORQUE_RELERR,
            "relaxation_state_mean_deviation_relative_error": (
                MAX_STATIC_SUPERCELL_RELAXATION_STATE_MEAN_DEVIATION_RELERR
            ),
        },
    )


def validate_interpolated_supercell_report(
    report: dict[str, Any],
    *,
    expected_workload: dict[str, Any],
) -> None:
    _, interpolated = validate_static_supercell_report_structure(report, expected_workload=expected_workload)
    require(
        report.get("acceptance_basis") == "interpolated_remesh",
        (
            "interpolated supercell comparison report acceptance_basis must be "
            "interpolated_remesh"
        ),
    )
    require(
        interpolated is not None,
        "interpolated supercell comparison report interpolated_central_cell_comparability is required",
    )
    metrics = require_object(report.get("metrics"), "interpolated supercell comparison report metrics")
    metric_pairs = {
        "interpolated_field_missed_count": float(interpolated["field_missed_count"]),
        "interpolated_magnetic_missed_count": float(interpolated["magnetic_missed_count"]),
        "interpolated_m_p99_l2_delta": interpolated["m"]["p99_l2_delta"],
        "interpolated_h_demag_p99_relative_error": interpolated["H_demag"]["p99_relative_error"],
        "interpolated_demag_phi_max_abs_delta_after_offset_A": interpolated["demag_phi"][
            "max_abs_delta_after_offset_A"
        ],
    }
    for metric, expected in metric_pairs.items():
        value = require_finite_number(metrics.get(metric), f"interpolated supercell comparison report metrics.{metric}")
        require(
            math.isclose(value, expected, rel_tol=1.0e-12, abs_tol=1.0e-18),
            (
                f"interpolated supercell comparison report metrics.{metric} must match "
                "interpolated_central_cell_comparability"
            ),
        )
    validate_static_comparison_metric_limits(
        metrics,
        report_name="interpolated supercell",
        limits={
            "interpolated_field_missed_count": 0.0,
            "interpolated_magnetic_missed_count": 0.0,
            "interpolated_m_p99_l2_delta": MAX_STATIC_SUPERCELL_INTERPOLATED_M_P99_L2_DELTA,
            "interpolated_h_demag_p99_relative_error": MAX_STATIC_SUPERCELL_INTERPOLATED_H_DEMAG_P99_RELERR,
            "interpolated_demag_phi_max_abs_delta_after_offset_A": (
                MAX_STATIC_SUPERCELL_INTERPOLATED_DEMAG_PHI_DELTA_A
            ),
            "e_demag_density_relative_error": MAX_STATIC_SUPERCELL_E_DEMAG_DENSITY_RELERR,
            "central_cell_torque_residual_relative_error": MAX_STATIC_SUPERCELL_TORQUE_RELERR,
        },
    )


def validate_repeated_state_supercell_report(
    report: dict[str, Any],
    *,
    expected_workload: dict[str, Any],
) -> None:
    validate_static_supercell_report(report, expected_workload=expected_workload)
    override = require_object(
        report.get("supercell_initial_magnetization_state_override"),
        "supercell comparison report supercell_initial_magnetization_state_override",
    )
    require(
        override.get("kind") == "initial_magnetization_state_override",
        (
            "supercell comparison report supercell_initial_magnetization_state_override.kind "
            "must be initial_magnetization_state_override"
        ),
    )
    require(
        isinstance(override.get("source_path"), str) and override.get("source_path"),
        (
            "supercell comparison report supercell_initial_magnetization_state_override.source_path "
            "must be a non-empty string"
        ),
    )
    require(
        override.get("format") == "json",
        (
            "supercell comparison report supercell_initial_magnetization_state_override.format "
            "must be json"
        ),
    )
    vector_count = override.get("vector_count")
    require(
        isinstance(vector_count, int) and vector_count > 0,
        (
            "supercell comparison report supercell_initial_magnetization_state_override.vector_count "
            "must be positive"
        ),
    )


def main() -> int:
    args = parse_args()
    supercell_repeat = args.supercell_repeat
    try:
        text = args.log_path.read_text(encoding="utf-8", errors="replace")
        validate_text_markers(text, args.engine)
        summary = load_last_json_object(text)
        summary_total_steps = validate_summary(
            summary,
            scenario=args.scenario,
            algorithm=args.algorithm,
            min_steps=args.min_steps,
            supercell_repeat=supercell_repeat,
        )
        artifact_dir = resolve_artifact_dir(summary, args.log_path)
        metadata = load_metadata(artifact_dir)
        validate_scenario_metadata(
            metadata,
            args.scenario,
            supercell_repeat=supercell_repeat,
        )
        validate_problem_pbc(metadata)
        validate_periodic_mesh_metadata(metadata)
        node_pairs = validate_periodic_pairs_artifact(
            load_periodic_pairs_artifact(artifact_dir),
            scenario=args.scenario,
        )
        final_step, final_m_values = validate_final_magnetization_artifact(
            load_final_magnetization_artifact(artifact_dir)
        )
        if args.require_initial_magnetization_state_override:
            validate_initial_magnetization_state_override(
                metadata,
                artifact_dir=artifact_dir,
                expected_vector_count=len(final_m_values),
            )
        require(
            final_step == summary_total_steps,
            f"m_final.json step must match summary total_steps {summary_total_steps}, got {final_step}",
        )
        h_demag_values = validate_demag_field_snapshot_artifact(
            load_demag_field_snapshot_artifact(artifact_dir),
            expected_step=final_step,
        )
        demag_phi_values = validate_demag_phi_snapshot_artifact(
            load_demag_phi_snapshot_artifact(artifact_dir),
            expected_step=final_step,
        )
        if supercell_repeat is not None:
            validate_supercell_node_geometry_artifact(
                load_node_geometry_artifact(artifact_dir),
                expected_node_count=len(final_m_values),
                expected_vector_field_count=len(h_demag_values),
                expected_scalar_field_count=len(demag_phi_values),
            )
        validate_periodic_field_seam_mismatch(
            values=final_m_values,
            node_pairs=node_pairs,
            field_name="m_final.json",
            tolerance=args.max_m_seam_mismatch,
        )
        validate_periodic_field_seam_mismatch(
            values=h_demag_values,
            node_pairs=node_pairs,
            field_name="H_demag snapshot",
            tolerance=args.max_h_demag_seam_mismatch_apm,
        )
        validate_periodic_scalar_field_seam_mismatch(
            values=demag_phi_values,
            node_pairs=node_pairs,
            field_name="demag_phi snapshot",
            tolerance=args.max_demag_phi_seam_mismatch_a,
        )
        validate_static_pbc_demag_seam_diagnostics(
            load_static_pbc_demag_seam_diagnostics_artifact(artifact_dir),
            expected_step=final_step,
            max_m_seam_mismatch=args.max_m_seam_mismatch,
            max_h_demag_seam_mismatch_apm=args.max_h_demag_seam_mismatch_apm,
            max_demag_phi_seam_mismatch_a=args.max_demag_phi_seam_mismatch_a,
            max_b_normal_flux_seam_mismatch_t=args.max_b_normal_flux_seam_mismatch_t,
            max_side_magnetic_charge_sum_abs_am=args.max_side_magnetic_charge_sum_abs_am,
        )
        scalar_final_step = validate_scalar_history(
            load_scalars_rows(artifact_dir),
            min_steps=args.min_steps,
            max_final_torque_apm=args.max_final_torque_apm,
        )
        require(
            scalar_final_step == final_step,
            f"scalars.csv final step must match m_final.json step {final_step}, got {scalar_final_step}",
        )
        validate_demag_runtime(metadata, args.engine)
        validate_relaxation_qualification(
            metadata,
            algorithm=args.algorithm,
            min_steps=args.min_steps,
            engine=args.engine,
        )
        validate_equilibrium_observables(
            metadata,
            engine=args.engine,
            max_final_torque_apm=args.max_final_torque_apm,
        )
        expected_workload = expected_static_comparison_workload(metadata, args.scenario)
        if args.require_z_padding_report is not None:
            validate_static_z_padding_report(
                load_required_report(args.require_z_padding_report, "z-padding"),
                expected_workload=expected_workload,
            )
        if args.require_supercell_report is not None:
            validate_static_supercell_report(
                load_required_report(args.require_supercell_report, "supercell"),
                expected_workload=expected_workload,
            )
        if args.require_interpolated_supercell_report is not None:
            validate_interpolated_supercell_report(
                load_required_report(args.require_interpolated_supercell_report, "interpolated supercell"),
                expected_workload=expected_workload,
            )
        if args.require_repeated_state_supercell_report is not None:
            validate_repeated_state_supercell_report(
                load_required_report(
                    args.require_repeated_state_supercell_report,
                    "repeated-state supercell",
                ),
                expected_workload=expected_workload,
            )
    except Exception as exc:
        print(f"invalid FEM periodic antidot relaxation artifacts: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
