#!/usr/bin/env python3
"""Validate one managed periodic-antidot relax-to-eigenmodes run."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any


EXPECTED_PBC = {
    "axes": ["periodic", "periodic", "open"],
    "demag": "periodic_airbox_k0",
}
EXPECTED_SCENARIO = {
    "scenario": "relax_then_eigenmodes_k0",
    "exchange_coupled_across_periods": True,
    "magnetostatic_pbc": "periodic_airbox_k0",
    "periodic_pair_ids": ["x_faces", "y_faces"],
    "open_axis": "z",
    "film_size_m": [200e-9, 200e-9, 10e-9],
    "universe_size_m": [200e-9, 200e-9, 400e-9],
    "hole_radius_m": 25e-9,
    "bias_field_t": [10e-3, 0.0, 0.0],
    "frequency_window_hz": [0.5e9, 30.0e9],
    "mode_count": 8,
    "saved_mode_indices": [0, 1, 2, 3],
}


class ValidationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def read_json(path: Path) -> dict[str, Any]:
    require(path.is_file(), f"missing JSON artifact: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"{path} must contain a JSON object")
    return value


def require_object(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label} must be a JSON object")
    return value


def require_non_empty_string(value: Any, label: str) -> str:
    require(isinstance(value, str) and bool(value.strip()), f"{label} must be non-empty")
    return value


def require_finite_number(value: Any, label: str) -> float:
    require(
        isinstance(value, (int, float)) and not isinstance(value, bool),
        f"{label} must be numeric",
    )
    result = float(value)
    require(math.isfinite(result), f"{label} must be finite")
    return result


def require_sha256(value: Any, label: str) -> str:
    digest = require_non_empty_string(value, label)
    require(
        len(digest) == 71
        and digest.startswith("sha256:")
        and all(character in "0123456789abcdef" for character in digest[7:]),
        f"{label} must be a lowercase sha256 digest",
    )
    return digest


def validate_requested_execution(
    metadata: dict[str, Any], expected_device: str, label: str
) -> None:
    requested = require_object(metadata.get("requested_execution"), f"{label}.requested_execution")
    require(requested.get("backend") == "fem", f"{label} must request FEM")
    require(
        requested.get("device") == expected_device,
        f"{label} must request device={expected_device}",
    )
    require(requested.get("precision") == "double", f"{label} must request double")
    require(requested.get("mode") == "strict", f"{label} must request strict mode")
    require(
        requested.get("fallback_policy") == "forbidden",
        f"{label} must forbid fallback",
    )


def scenario_metadata(metadata: dict[str, Any], label: str) -> dict[str, Any]:
    problem_meta = require_object(metadata.get("problem_meta"), f"{label}.problem_meta")
    runtime_metadata = require_object(
        problem_meta.get("runtime_metadata"), f"{label}.problem_meta.runtime_metadata"
    )
    return require_object(
        runtime_metadata.get("periodic_antidot_eigensolve"),
        f"{label}.periodic_antidot_eigensolve",
    )


def validate_scenario(metadata: dict[str, Any], device: str, label: str) -> None:
    scenario = scenario_metadata(metadata, label)
    for key, expected in EXPECTED_SCENARIO.items():
        require(
            scenario.get(key) == expected,
            f"{label}.periodic_antidot_eigensolve.{key} drifted",
        )
    require(
        scenario.get("requested_modal_device") == device,
        f"{label}.periodic_antidot_eigensolve.requested_modal_device must be {device}",
    )
    require(metadata.get("pbc") == EXPECTED_PBC, f"{label}.pbc drifted")


def validate_entrypoint(metadata: dict[str, Any], expected: str, label: str) -> None:
    problem_meta = require_object(metadata.get("problem_meta"), f"{label}.problem_meta")
    require(
        problem_meta.get("entrypoint_kind") == expected,
        f"{label}.entrypoint_kind must be {expected}",
    )
    require(metadata.get("status") == "completed", f"{label}.status must be completed")


def validate_relaxation(metadata: dict[str, Any]) -> None:
    qualification = require_object(
        metadata.get("fem_cpu_relaxation_qualification"),
        "relax.fem_cpu_relaxation_qualification",
    )
    require(
        qualification.get("relaxation_algorithm") == "nonlinear_cg",
        "relaxation_algorithm must be nonlinear_cg",
    )
    steps = qualification.get("executed_steps")
    require(
        isinstance(steps, int) and not isinstance(steps, bool) and steps > 0,
        "relaxation must execute at least one step",
    )
    require(qualification.get("stop_reason") == "torque", "relaxation must stop on torque")
    require(
        qualification.get("stop_metric_kind") == "max_torque_apm",
        "relaxation stop metric must be max_torque_apm",
    )
    metric = require_finite_number(
        qualification.get("stop_metric_value"), "relax.stop_metric_value"
    )
    threshold = require_finite_number(
        qualification.get("stop_threshold"), "relax.stop_threshold"
    )
    final_torque = require_finite_number(
        qualification.get("final_torque_apm"), "relax.final_torque_apm"
    )
    require(threshold > 0.0, "relax.stop_threshold must be positive")
    require(metric <= threshold, "relax stop metric exceeds its threshold")
    require(final_torque <= threshold, "relax final torque exceeds its threshold")


def mesh_identity(metadata: dict[str, Any], label: str) -> tuple[str, str]:
    mesh = require_object(metadata.get("mesh"), f"{label}.mesh")
    generation_id = require_non_empty_string(
        mesh.get("mesh_generation_id"), f"{label}.mesh.mesh_generation_id"
    )
    topology_fingerprint = require_non_empty_string(
        mesh.get("topology_fingerprint"), f"{label}.mesh.topology_fingerprint"
    )
    require(
        topology_fingerprint.startswith("sha256:"),
        f"{label}.mesh.topology_fingerprint must be a sha256 identity",
    )
    return generation_id, topology_fingerprint


def validate_state_handoff(relax_root: Path, artifacts: Path) -> None:
    relaxed = read_json(relax_root / "m_final.json")
    linearized = read_json(artifacts / "m_initial.json")
    require(relaxed.get("observable") == "m", "relax m_final observable must be m")
    require(linearized.get("observable") == "m", "eigen m_initial observable must be m")
    relaxed_values = relaxed.get("values")
    require(isinstance(relaxed_values, list) and bool(relaxed_values), "relax m_final is empty")
    require(
        linearized.get("values") == relaxed_values,
        "eigen m_initial does not match relax m_final stage continuation",
    )


def validate_eigen_handoff(artifacts: Path) -> None:
    summary = read_json(artifacts / "eigen/metadata/eigen_summary.json")
    equilibrium_source = summary.get("equilibrium_source")
    require(
        isinstance(equilibrium_source, dict),
        "eigen_summary must prove relaxed_initial_state with stage_continuation",
    )
    require(
        equilibrium_source.get("kind") == "relaxed_initial_state"
        and equilibrium_source.get("handoff") == "stage_continuation",
        "eigen_summary must prove relaxed_initial_state with stage_continuation",
    )
    source_content_sha256 = require_sha256(
        equilibrium_source.get("content_sha256"),
        "eigen_summary.equilibrium_source.content_sha256",
    )
    source_equilibrium_sha256 = require_sha256(
        equilibrium_source.get("equilibrium_content_sha256"),
        "eigen_summary.equilibrium_source.equilibrium_content_sha256",
    )
    solver_diagnostics = require_object(
        summary.get("solver_diagnostics"), "eigen_summary.solver_diagnostics"
    )
    diagnostic_content_sha256 = require_sha256(
        solver_diagnostics.get("relax_to_eigen_handoff_sha256"),
        "eigen_summary.solver_diagnostics.relax_to_eigen_handoff_sha256",
    )
    handoff = require_object(
        solver_diagnostics.get("relax_to_eigen_handoff"),
        "eigen_summary.solver_diagnostics.relax_to_eigen_handoff",
    )
    require(
        handoff.get("schema_version") == "AcceptedFemRelaxStageHandoff.v1",
        "relax-to-eigen handoff schema_version drifted",
    )
    for field in ("source_run_id", "source_stage_id", "source_stage_kind"):
        require_non_empty_string(handoff.get(field), f"relax-to-eigen handoff {field}")
    handoff_content_sha256 = require_sha256(
        handoff.get("content_sha256"), "relax-to-eigen handoff content_sha256"
    )
    handoff_equilibrium_sha256 = require_sha256(
        handoff.get("equilibrium_content_sha256"),
        "relax-to-eigen handoff equilibrium_content_sha256",
    )
    require(
        source_content_sha256
        == diagnostic_content_sha256
        == handoff_content_sha256,
        "relax-to-eigen handoff content_sha256 bindings disagree",
    )
    require(
        source_equilibrium_sha256 == handoff_equilibrium_sha256,
        "relax-to-eigen handoff equilibrium_content_sha256 bindings disagree",
    )
    require(
        summary.get("relaxation_steps") == 0,
        "eigen stage must not run a second independent relaxation",
    )
    require(summary.get("mode_count") == 8, "eigen_summary.mode_count must be 8")
    require(
        summary.get("operator") == {"kind": "full2x2", "include_demag": True},
        "eigen_summary.operator drifted",
    )
    require(
        summary.get("k_sampling") == [0.0, 0.0, 0.0],
        "eigen_summary must describe one K0 sample",
    )
    equilibrium = read_json(artifacts / "eigen/metadata/equilibrium_artifact.v6.json")
    require(
        equilibrium.get("accepted_for_linearization") is True,
        "equilibrium artifact was not accepted for linearization",
    )
    linearization = read_json(artifacts / "eigen/metadata/linearization_state.v6.json")
    require(
        linearization.get("accepted_for_frequency_operator") is True,
        "linearization state was not accepted for the frequency operator",
    )


def validate_spectrum_and_modes(
    artifacts: Path,
    source_mesh_identity: dict[str, Any],
) -> None:
    node_count = source_mesh_identity["node_count"]
    spectrum = read_json(artifacts / "eigen/spectrum.v2.json")
    require(
        spectrum.get("schema_version") == "eigen_spectrum.v2",
        "eigen/spectrum.v2.json must use eigen_spectrum.v2",
    )
    require(spectrum.get("complete") is True, "eigen spectrum.v2 must be complete")
    samples = spectrum.get("samples")
    require(isinstance(samples, list) and len(samples) == 1, "spectrum.v2 must contain one K0 sample")
    sample = require_object(samples[0], "spectrum.v2.samples[0]")
    require(sample.get("status") == "complete", "spectrum.v2 K0 sample must be complete")
    modes = sample.get("modes")
    require(isinstance(modes, list) and bool(modes), "spectrum.v2 modes must not be empty")
    if len(modes) < EXPECTED_SCENARIO["mode_count"]:
        certificate = require_object(
            spectrum.get("window_completeness"), "spectrum.v2.window_completeness"
        )
        require(
            certificate.get("status") == "certified",
            "spectrum.v2 has fewer modes than requested without a certified window",
        )

    diagnostics = read_json(artifacts / "eigen/diagnostics/solver.v1.json")
    eps_phi = require_finite_number(diagnostics.get("eps_phi"), "solver diagnostics eps_phi")
    require(eps_phi >= 0.0, "solver diagnostics eps_phi must be non-negative")

    modes_by_index: dict[int, dict[str, Any]] = {}
    for item in modes:
        mode = require_object(item, "spectrum.v2 mode")
        raw_index = mode.get("raw_mode_index")
        require(
            isinstance(raw_index, int) and not isinstance(raw_index, bool) and raw_index >= 0,
            "spectrum.v2 mode.raw_mode_index must be a non-negative integer",
        )
        require(raw_index not in modes_by_index, "spectrum.v2 contains duplicate mode indices")
        require_finite_number(mode.get("frequency_hz"), f"mode {raw_index} frequency_hz")
        require_finite_number(
            mode.get("residual_relative_l2"), f"mode {raw_index} residual_relative_l2"
        )
        modes_by_index[raw_index] = mode

    for mode_index in EXPECTED_SCENARIO["saved_mode_indices"]:
        require(mode_index in modes_by_index, f"spectrum.v2 is missing requested mode {mode_index}")
        mode_relative = f"eigen/modes/sample_0000/mode_{mode_index:04}.json"
        mode = read_json(artifacts / mode_relative)
        require(
            mode.get("value_kind") == "complex_spatial_vector"
            and mode.get("component_basis") == "global_xyz"
            and mode.get("component_count") == 3,
            f"mode {mode_index} must expose complex Cartesian delta_m",
        )
        identity = require_object(
            mode.get("source_mesh_identity"), f"mode {mode_index}.source_mesh_identity"
        )
        require(
            identity == source_mesh_identity,
            f"mode {mode_index}.source_mesh_identity differs from the frozen stage mesh",
        )
        expected_array_relative = (
            f"eigen/mode_fields.zarr/sample_0000/mode_{mode_index:04}/"
            "vector_xyz_complex"
        )
        chunk_relative = require_non_empty_string(
            mode.get("zarr_chunk_path"), f"mode {mode_index}.zarr_chunk_path"
        )
        require(
            chunk_relative == f"{expected_array_relative}/0.0.0",
            f"mode {mode_index} must reference the canonical Zarr v2 chunk 0.0.0",
        )
        require(
            mode.get("storage_format") == "zarr"
            and mode.get("zarr_array_path") == expected_array_relative
            and mode.get("zarr_dtype") == "<f8"
            and mode.get("zarr_shape") == [node_count, 3, 2]
            and mode.get("zarr_chunk_shape") == [node_count, 3, 2]
            and mode.get("zarr_compressor") is None,
            f"mode {mode_index} Zarr dtype/shape metadata drifted",
        )
        zarray = read_json(artifacts / expected_array_relative / ".zarray")
        require(zarray.get("zarr_format") == 2, f"mode {mode_index} must use Zarr v2")
        require(zarray.get("dtype") == "<f8", f"mode {mode_index} Zarr dtype must be <f8")
        require(
            zarray.get("shape") == [node_count, 3, 2]
            and zarray.get("chunks") == [node_count, 3, 2],
            f"mode {mode_index} Zarr shape/chunks must be [{node_count}, 3, 2]",
        )
        require(
            zarray.get("compressor") is None
            and zarray.get("order") == "C"
            and zarray.get("dimension_separator") == ".",
            f"mode {mode_index} Zarr v2 storage metadata drifted",
        )
        chunk = artifacts / chunk_relative
        require(chunk.is_file(), f"mode {mode_index} complex delta_m mode field chunk is missing")
        payload = chunk.read_bytes()
        expected_size = node_count * 3 * 2 * 8
        require(
            len(payload) == expected_size,
            f"mode {mode_index} Zarr chunk size {len(payload)} != {expected_size}",
        )
        values = struct.unpack(f"<{node_count * 6}d", payload)
        require(
            all(math.isfinite(value) for value in values),
            f"mode {mode_index} real/imag XYZ payload values must be finite",
        )
        payload_sha256 = require_sha256(
            mode.get("payload_sha256"), f"mode {mode_index}.payload_sha256"
        )
        require(
            payload_sha256 == "sha256:" + hashlib.sha256(payload).hexdigest(),
            f"mode {mode_index}.payload_sha256 does not match the Zarr chunk",
        )


def resolve_session(report_root: Path) -> Path:
    history = report_root / "workspace-history"
    require(history.is_dir(), f"workspace history does not exist: {history}")
    sessions = sorted(path for path in history.glob("session-*") if path.is_dir())
    require(len(sessions) == 1, "workspace history must contain exactly one session directory")
    return sessions[0]


def validate_report(report_root: Path, device: str) -> dict[str, Any]:
    require(device in {"cpu", "gpu"}, "device must be cpu or gpu")
    require(report_root.is_dir(), f"report root does not exist: {report_root}")
    runtime_log = report_root / "runtime.log"
    require(runtime_log.is_file() and runtime_log.stat().st_size > 0, "runtime.log is missing")
    artifacts = report_root / "artifacts"
    require(artifacts.is_dir(), f"final artifacts directory does not exist: {artifacts}")

    session = resolve_session(report_root)
    stages_root = session / "stages"
    require(stages_root.is_dir(), f"stage artifacts directory does not exist: {stages_root}")
    actual_stage_names = sorted(path.name for path in stages_root.iterdir() if path.is_dir())
    expected_stage_names = ["stage_00_flat_relax"]
    if device == "gpu":
        expected_stage_names.append("stage_01_flat_change_device")
    require(
        actual_stage_names == expected_stage_names,
        f"stage directories drifted: got {actual_stage_names}, expected {expected_stage_names}",
    )

    relax_root = stages_root / "stage_00_flat_relax"
    relax_metadata = read_json(relax_root / "metadata.json")
    final_metadata = read_json(artifacts / "metadata.json")
    validate_entrypoint(relax_metadata, "flat_relax", "relax")
    validate_entrypoint(final_metadata, "flat_eigenmodes", "eigen")
    validate_requested_execution(relax_metadata, "cpu", "relax")
    validate_requested_execution(final_metadata, device, "eigen")
    validate_scenario(relax_metadata, device, "relax")
    validate_scenario(final_metadata, device, "eigen")
    require(
        scenario_metadata(relax_metadata, "relax")
        == scenario_metadata(final_metadata, "eigen"),
        "scenario metadata differs between relax and eigen stages",
    )
    validate_relaxation(relax_metadata)

    relax_generation, relax_topology = mesh_identity(relax_metadata, "relax")
    eigen_generation, eigen_topology = mesh_identity(final_metadata, "eigen")
    require(
        eigen_generation == relax_generation,
        "mesh_generation_id differs between relax and eigen stages",
    )
    require(
        eigen_topology == relax_topology,
        "topology_fingerprint differs between relax and eigen stages",
    )

    if device == "gpu":
        transition = read_json(
            stages_root / "stage_01_flat_change_device/synthetic_stage.json"
        )
        require(
            transition.get("kind") == "change_device"
            and transition.get("device") == "gpu",
            "GPU stage must contain an explicit change_device transition",
        )

    validate_state_handoff(relax_root, artifacts)
    validate_eigen_handoff(artifacts)
    eigen_mesh = require_object(final_metadata.get("mesh"), "eigen.mesh")
    mesh_id = require_non_empty_string(eigen_mesh.get("mesh_name"), "eigen.mesh.mesh_name")
    node_count = eigen_mesh.get("node_count")
    require(
        isinstance(node_count, int) and not isinstance(node_count, bool) and node_count > 0,
        "eigen.mesh.node_count must be a positive integer",
    )
    validate_spectrum_and_modes(
        artifacts,
        {
            "mesh_id": mesh_id,
            "topology_fingerprint": eigen_topology,
            "indexing": "full_domain_node_order",
            "node_count": node_count,
        },
    )
    return {
        "status": "ok",
        "device": device,
        "stage_count": 2 if device == "cpu" else 3,
        "mesh_generation_id": relax_generation,
        "topology_fingerprint": relax_topology,
        "report_root": str(report_root.resolve()),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report_root", type=Path)
    parser.add_argument("--device", required=True, choices=("cpu", "gpu"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = validate_report(args.report_root, args.device)
    except (OSError, json.JSONDecodeError, ValidationError) as error:
        print(f"PERIODIC_ANTIDOT_EIGENMODES_VALIDATION_ERROR={error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
