#!/usr/bin/env python3
"""Validate managed FEM periodic-antidot relaxation runtime artifacts."""

from __future__ import annotations

import argparse
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
    args = parser.parse_args()
    if args.min_steps < 1:
        parser.error("--min-steps must be positive")
    if not math.isfinite(args.max_final_torque_apm) or args.max_final_torque_apm <= 0.0:
        parser.error("--max-final-torque-apm must be a positive finite number")
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
) -> None:
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


def validate_problem_pbc(metadata: dict[str, Any]) -> None:
    pbc = require_object(metadata.get("pbc"), "metadata.pbc")
    require(
        pbc.get("axes") == ["periodic", "periodic", "open"],
        f"metadata.pbc.axes must be ['periodic', 'periodic', 'open'], got {pbc.get('axes')!r}",
    )
    require(
        pbc.get("demag") == "open",
        f"metadata.pbc.demag must be open for FEM static PBC, got {pbc.get('demag')!r}",
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
    if actual_iterations is not None:
        require(
            isinstance(actual_iterations, int) and actual_iterations >= 0,
            "demag_runtime.actual_iterations must be non-negative",
        )
    final_residual = demag.get("final_residual_norm")
    if final_residual is not None:
        require_finite_number(final_residual, "demag_runtime.final_residual_norm")
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
        validate_summary(
            summary,
            scenario=args.scenario,
            algorithm=args.algorithm,
            min_steps=args.min_steps,
        )
        metadata = load_metadata(resolve_artifact_dir(summary, args.log_path))
        validate_scenario_metadata(metadata, args.scenario)
        validate_problem_pbc(metadata)
        validate_periodic_mesh_metadata(metadata)
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
