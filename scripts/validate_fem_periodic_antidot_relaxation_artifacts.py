#!/usr/bin/env python3
"""Validate managed FEM periodic-antidot relaxation runtime artifacts."""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path
from typing import Any


SUPPORTED_SCENARIOS = {"air_gap", "exchange_coupled"}
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


def load_final_magnetization_artifact(artifact_dir: Path) -> dict[str, Any]:
    path = artifact_dir / "m_final.json"
    require(path.is_file(), f"missing final magnetization artifact: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    return require_object(value, "m_final.json")


def load_demag_field_snapshot_artifact(artifact_dir: Path) -> dict[str, Any]:
    field_dir = artifact_dir / "fields" / "H_demag"
    require(field_dir.is_dir(), f"missing H_demag field snapshot directory: {field_dir}")
    candidates = sorted(field_dir.glob("step_*.json"))
    require(candidates, f"missing H_demag field snapshot artifact in {field_dir}")
    value = json.loads(candidates[-1].read_text(encoding="utf-8"))
    return require_object(value, str(candidates[-1]))


def load_demag_phi_snapshot_artifact(artifact_dir: Path) -> dict[str, Any]:
    field_dir = artifact_dir / "fields" / "demag_phi"
    require(field_dir.is_dir(), f"missing demag_phi field snapshot directory: {field_dir}")
    candidates = sorted(field_dir.glob("step_*.json"))
    require(candidates, f"missing demag_phi field snapshot artifact in {field_dir}")
    value = json.loads(candidates[-1].read_text(encoding="utf-8"))
    return require_object(value, str(candidates[-1]))


def load_scalars_rows(artifact_dir: Path) -> list[dict[str, str]]:
    path = artifact_dir / "scalars.csv"
    require(path.is_file(), f"missing scalar history artifact: {path}")
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    return rows


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
) -> int:
    require(summary.get("status") == "completed", f"unexpected status: {summary.get('status')!r}")
    require(summary.get("backend") == "fem", f"unexpected backend: {summary.get('backend')!r}")
    require(summary.get("mode") == "strict", f"unexpected mode: {summary.get('mode')!r}")
    require(summary.get("precision") == "double", f"unexpected precision: {summary.get('precision')!r}")
    require(
        summary.get("problem_name") == f"fem_periodic_antidot_relax_{scenario}",
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


def validate_scenario_metadata(metadata: dict[str, Any], scenario: str) -> None:
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
        coupled is (scenario == "exchange_coupled"),
        "exchange_coupled_across_periods does not match requested scenario",
    )
    film_size = [require_finite_number(v, f"film_size_m[{i}]") for i, v in enumerate(require_list(scenario_meta.get("film_size_m"), "film_size_m"))]
    universe_size = [require_finite_number(v, f"universe_size_m[{i}]") for i, v in enumerate(require_list(scenario_meta.get("universe_size_m"), "universe_size_m"))]
    lateral_gap = [require_finite_number(v, f"lateral_air_gap_m[{i}]") for i, v in enumerate(require_list(scenario_meta.get("lateral_air_gap_m"), "lateral_air_gap_m"))]
    require(len(film_size) == 3, "film_size_m must be a 3-vector")
    require(len(universe_size) == 3, "universe_size_m must be a 3-vector")
    require(len(lateral_gap) == 2, "lateral_air_gap_m must be a 2-vector")
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
            "exchange_coupled scenario must have zero lateral air gap",
        )
        require(
            universe_size[0] == film_size[0] and universe_size[1] == film_size[1],
            "exchange_coupled universe must match the magnetic film laterally",
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


def validate_periodic_pairs_artifact(artifact: dict[str, Any]) -> list[tuple[int, int, str]]:
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
    for node_a, node_b, pair_id in node_pairs:
        require(
            node_a < len(values) and node_b < len(values),
            f"{field_name} seam pair {pair_id} references nodes outside field values: {node_a}, {node_b}",
        )
        delta = abs(values[node_a] - values[node_b])
        if delta > max_mismatch:
            max_mismatch = delta
            max_pair_id = pair_id
    require(
        max_mismatch <= tolerance,
        f"{field_name} periodic seam mismatch exceeds {tolerance:.6e}: {max_mismatch:.6e} on {max_pair_id}",
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
    require(final_demag >= 0.0, "scalars.csv final E_demag must be non-negative")
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


def validate_demag_runtime(metadata: dict[str, Any], engine: str) -> None:
    demag = require_object(metadata.get("demag_runtime"), "metadata.demag_runtime")
    require(
        demag.get("model") == "airbox",
        f"demag_runtime.model must be airbox, got {demag.get('model')!r}",
    )
    require(
        demag.get("boundary_variant") == "robin",
        f"demag_runtime.boundary_variant must be robin, got {demag.get('boundary_variant')!r}",
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
    require(e_demag >= 0.0, f"{key}.final_energy_terms_j.E_demag must be non-negative")
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


def main() -> int:
    args = parse_args()
    try:
        text = args.log_path.read_text(encoding="utf-8", errors="replace")
        validate_text_markers(text, args.engine)
        summary = load_last_json_object(text)
        summary_total_steps = validate_summary(
            summary,
            scenario=args.scenario,
            algorithm=args.algorithm,
            min_steps=args.min_steps,
        )
        artifact_dir = resolve_artifact_dir(summary, args.log_path)
        metadata = load_metadata(artifact_dir)
        validate_scenario_metadata(metadata, args.scenario)
        validate_problem_pbc(metadata)
        validate_periodic_mesh_metadata(metadata)
        node_pairs = validate_periodic_pairs_artifact(load_periodic_pairs_artifact(artifact_dir))
        final_step, final_m_values = validate_final_magnetization_artifact(
            load_final_magnetization_artifact(artifact_dir)
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
    except Exception as exc:
        print(f"invalid FEM periodic antidot relaxation artifacts: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
