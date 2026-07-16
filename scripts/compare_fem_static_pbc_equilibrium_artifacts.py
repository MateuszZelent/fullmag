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
DEFAULT_MAX_RELAXATION_STATE_MEAN_DEVIATION_RELERR = 2.0e-1
DEFAULT_MAPPED_SUPERCELL_NEAREST_DISTANCE_M = 1.0e-8
DEFAULT_MAX_MAPPED_M_P99_L2_DELTA = 2.0e-2
DEFAULT_MAX_MAPPED_H_DEMAG_P99_RELERR = 2.0e-2
DEFAULT_MAX_MAPPED_DEMAG_PHI_DELTA_A = 1.0e-6
DEFAULT_MAX_MAPPED_SUPERCELL_NEAREST_DISTANCE_M = 1.0e-12
DEFAULT_INTERPOLATION_BARYCENTRIC_TOL = 1.0e-10
DEFAULT_MAX_INTERPOLATED_M_P99_L2_DELTA = 2.0e-2
DEFAULT_MAX_INTERPOLATED_H_DEMAG_P99_RELERR = 2.0e-2
DEFAULT_MAX_INTERPOLATED_DEMAG_PHI_DELTA_A = 1.0e-6
DEFAULT_MAX_M_SEAM_MISMATCH = 1.0e-6
DEFAULT_MAX_H_DEMAG_SEAM_MISMATCH_APM = 1.0e-3
DEFAULT_MAX_DEMAG_PHI_SEAM_MISMATCH_A = 1.0e-6
DEFAULT_MAX_B_NORMAL_FLUX_SEAM_MISMATCH_T = 1.0e-12
DEFAULT_MAX_SIDE_MAGNETIC_CHARGE_SUM_ABS_AM = 1.0e-18
STATE_FINAL = "final"
STATE_INITIAL = "initial"


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
    require(
        isinstance(value, (int, float)) and not isinstance(value, bool),
        f"{name} must be numeric",
    )
    number = float(value)
    require(math.isfinite(number), f"{name} must be finite")
    return number


def json_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def relative_error(actual: float, expected: float) -> float:
    scale = max(abs(actual), abs(expected), 1.0e-300)
    return abs(actual - expected) / scale


def load_json(path: Path) -> dict[str, Any]:
    require(path.is_file(), f"missing JSON file: {path}")
    return require_object(json.loads(path.read_text(encoding="utf-8")), str(path))


def load_metadata(root: Path) -> dict[str, Any]:
    return load_json(root / "metadata.json")


def initial_magnetization_state_override(root: Path) -> dict[str, Any] | None:
    metadata = load_metadata(root)
    problem_meta = metadata.get("problem_meta")
    if not isinstance(problem_meta, dict):
        return None
    runtime_metadata = problem_meta.get("runtime_metadata")
    if not isinstance(runtime_metadata, dict):
        return None
    override = runtime_metadata.get("initial_magnetization_state_override")
    if not isinstance(override, dict):
        return None
    return override


def artifact_provenance(root: Path) -> dict[str, Any]:
    fixture_path = root / "diagnostics" / "fem_static_pbc_tiled_supercell_fixture.v1.json"
    periodic_pairs = load_json(root / "mesh" / "periodic_pairs.v1.json")
    certificate_status = periodic_pairs.get("certificate_status")
    diagnostic_identity = periodic_pairs.get("diagnostic_fixture_identity")
    has_diagnostic_identity = isinstance(diagnostic_identity, dict)
    diagnostic_fixture = fixture_path.is_file() or certificate_status == "diagnostic_tiled_fixture" or has_diagnostic_identity
    provenance: dict[str, Any] = {
        "runtime_solve": not diagnostic_fixture,
        "diagnostic_fixture": diagnostic_fixture,
        "not_a_runtime_solve": diagnostic_fixture,
        "periodic_pairs_certificate_status": certificate_status,
    }
    if has_diagnostic_identity:
        identity = require_object(diagnostic_identity, f"{root}/mesh/periodic_pairs.v1.json.diagnostic_fixture_identity")
        digest = identity.get("sha256")
        require(
            isinstance(digest, str)
            and len(digest) == 64
            and all(character in "0123456789abcdef" for character in digest),
            f"{root}/mesh/periodic_pairs.v1.json.diagnostic_fixture_identity.sha256 must be lowercase SHA-256",
        )
        provenance["diagnostic_fixture_identity"] = identity
    if fixture_path.is_file():
        fixture = load_json(fixture_path)
        require(
            fixture.get("schema_version") == "fem_static_pbc_tiled_supercell_fixture.v1",
            f"{fixture_path}.schema_version must be fem_static_pbc_tiled_supercell_fixture.v1",
        )
        require(fixture.get("status") == "diagnostic_fixture", f"{fixture_path}.status must be diagnostic_fixture")
        require(fixture.get("not_a_runtime_solve") is True, f"{fixture_path}.not_a_runtime_solve must be true")
        provenance["fixture_schema_version"] = fixture["schema_version"]
        provenance["fixture_status"] = fixture["status"]
    return provenance


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
    require_static_pbc_demag_runtime_contract(root, metadata)
    require_periodic_pairs_artifact(root, metadata)
    require_static_pbc_demag_seam_diagnostics(root)
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


def m_final_step(root: Path) -> int:
    payload = load_json(root / "m_final.json")
    step = payload.get("step")
    require(json_integer(step) and step >= 0, f"{root}/m_final.json.step must be non-negative integer")
    return step


def require_static_pbc_demag_seam_diagnostics(root: Path) -> None:
    path = root / "diagnostics" / "fem_static_pbc_demag_seams.v1.json"
    require(path.is_file(), f"missing static PBC demag seam diagnostics artifact: {path}")
    payload = load_json(path)
    require(
        payload.get("schema_version") == "fem_static_pbc_demag_seams.v1",
        f"{path}.schema_version must be fem_static_pbc_demag_seams.v1",
    )
    require(payload.get("status") == "ok", f"{path}.status must be ok")
    require(
        payload.get("step") == m_final_step(root),
        f"{path}.step must match m_final.json.step",
    )
    pair_diagnostics = require_list(payload.get("pair_diagnostics"), f"{path}.pair_diagnostics")
    pair_ids: set[str] = set()
    for index, raw_pair in enumerate(pair_diagnostics):
        pair = require_object(raw_pair, f"{path}.pair_diagnostics[{index}]")
        pair_id = pair.get("pair_id")
        require(isinstance(pair_id, str) and pair_id, f"{path}.pair_diagnostics[{index}].pair_id must be non-empty")
        pair_ids.add(pair_id)
        metric_limits = {
            "m_seam_max": DEFAULT_MAX_M_SEAM_MISMATCH,
            "h_demag_seam_max_Apm": DEFAULT_MAX_H_DEMAG_SEAM_MISMATCH_APM,
            "demag_phi_seam_max_after_offset_A": DEFAULT_MAX_DEMAG_PHI_SEAM_MISMATCH_A,
            "b_normal_flux_seam_max_T": DEFAULT_MAX_B_NORMAL_FLUX_SEAM_MISMATCH_T,
            "side_magnetic_charge_sum_abs_Am": DEFAULT_MAX_SIDE_MAGNETIC_CHARGE_SUM_ABS_AM,
        }
        for metric, limit in metric_limits.items():
            value = finite_number(pair.get(metric), f"{path}.{pair_id}.{metric}")
            require(value >= 0.0, f"{path}.{pair_id}.{metric} must be non-negative")
            require(
                value <= limit,
                f"{path}.{pair_id}.{metric} exceeds {limit:.6e}: {value:.6e}",
            )
    for pair_id in ("x_faces", "y_faces"):
        require(pair_id in pair_ids, f"{path} missing pair {pair_id}")


def require_periodic_pairs_artifact(root: Path, metadata: dict[str, Any]) -> None:
    path = root / "mesh" / "periodic_pairs.v1.json"
    require(path.is_file(), f"missing periodic pairs artifact: {path}")
    payload = load_json(path)
    require(payload.get("schema_version") == "periodic_pairs.v1", f"{path}.schema_version must be periodic_pairs.v1")
    require(payload.get("validation_status") == "ok", f"{path}.validation_status must be ok")
    mesh = require_object(metadata.get("mesh"), f"{root}/metadata.mesh")
    mesh_node_count = mesh.get("periodic_node_pair_count")
    require(
        json_integer(mesh_node_count) and mesh_node_count > 0,
        f"{root}/metadata.mesh.periodic_node_pair_count must be positive integer",
    )
    mesh_boundary_count = mesh.get("periodic_boundary_pair_count")
    require(
        json_integer(mesh_boundary_count) and mesh_boundary_count > 0,
        f"{root}/metadata.mesh.periodic_boundary_pair_count must be positive integer",
    )
    mesh_node_counts = require_object(
        mesh.get("periodic_node_pair_counts_by_id"),
        f"{root}/metadata.mesh.periodic_node_pair_counts_by_id",
    )
    mesh_boundary_counts = require_object(
        mesh.get("periodic_boundary_pair_counts_by_id"),
        f"{root}/metadata.mesh.periodic_boundary_pair_counts_by_id",
    )

    topology_node_count: int | None = None
    topology_boundary_face_count: int | None = None
    execution_plan = metadata.get("execution_plan")
    if isinstance(execution_plan, dict):
        backend_plan = require_object(execution_plan.get("backend_plan"), f"{root}/metadata.execution_plan.backend_plan")
        topology = require_object(backend_plan.get("mesh"), f"{root}/metadata.execution_plan.backend_plan.mesh")
        topology_node_count = len(
            require_list(topology.get("nodes"), f"{root}/metadata.execution_plan.backend_plan.mesh.nodes")
        )
        if "boundary_faces" in topology:
            topology_boundary_face_count = len(
                require_list(
                    topology.get("boundary_faces"),
                    f"{root}/metadata.execution_plan.backend_plan.mesh.boundary_faces",
                )
            )

    pairs = require_list(payload.get("pairs"), f"{path}.pairs")
    pair_count = payload.get("pair_count")
    require(json_integer(pair_count), f"{path}.pair_count must be an integer")
    require(pair_count == len(pairs), f"{path}.pair_count must match pairs length")
    require(
        len(pairs) == mesh_boundary_count,
        f"{path}.pair_count must match metadata.mesh periodic boundary-pair definitions",
    )
    pair_ids: set[str] = set()
    artifact_paired_node_sum = 0
    observed_node_sets_by_id: dict[str, set[tuple[int, int]]] = {}
    observed_boundary_definition_counts: dict[str, int] = {}
    fragmented_node_sets: dict[tuple[str, tuple[tuple[float, float, float], ...]], set[tuple[int, int]]] = {}
    fragmented_domain_counts: dict[tuple[str, tuple[tuple[float, float, float], ...]], tuple[int, int]] = {}
    for index, raw_pair in enumerate(pairs):
        pair = require_object(raw_pair, f"{path}.pairs[{index}]")
        pair_id = pair.get("pair_id")
        require(isinstance(pair_id, str) and pair_id, f"{path}.pairs[{index}].pair_id must be non-empty")
        pair_ids.add(pair_id)
        require(pair.get("status") == "valid", f"{path}.{pair_id}.status must be valid")
        paired_node_count = pair.get("paired_node_count")
        require(json_integer(paired_node_count) and paired_node_count > 0, f"{path}.{pair_id}.paired_node_count must be positive integer")
        mesh_pair_node_count = mesh_node_counts.get(pair_id)
        require(
            json_integer(mesh_pair_node_count) and mesh_pair_node_count > 0,
            f"{root}/metadata.mesh.periodic_node_pair_counts_by_id.{pair_id} must be positive integer",
        )
        require(
            paired_node_count == mesh_pair_node_count,
            f"{path}.{pair_id}.paired_node_count must match metadata.mesh",
        )
        artifact_paired_node_sum += mesh_pair_node_count
        observed_boundary_definition_counts[pair_id] = observed_boundary_definition_counts.get(pair_id, 0) + 1
        domain_counts = require_object(pair.get("domain_node_pair_counts"), f"{path}.{pair_id}.domain_node_pair_counts")
        magnetic_count = domain_counts.get("magnetic")
        airbox_count = domain_counts.get("airbox")
        require(json_integer(magnetic_count) and magnetic_count >= 0, f"{path}.{pair_id}.domain_node_pair_counts.magnetic must be non-negative integer")
        require(json_integer(airbox_count) and airbox_count > 0, f"{path}.{pair_id}.domain_node_pair_counts.airbox must be positive integer")
        require(
            magnetic_count + airbox_count == paired_node_count,
            f"{path}.{pair_id}.domain_node_pair_counts must sum to paired_node_count",
        )
        node_pairs = require_list(pair.get("node_pairs"), f"{path}.{pair_id}.node_pairs")
        require(
            len(node_pairs) == paired_node_count,
            f"{path}.{pair_id}.node_pairs must contain {paired_node_count} entries",
        )
        canonical_node_pairs: set[tuple[int, int]] = set()
        for node_pair_index, raw_node_pair in enumerate(node_pairs):
            node_pair = require_object(raw_node_pair, f"{path}.{pair_id}.node_pairs[{node_pair_index}]")
            node_a = node_pair.get("node_a")
            node_b = node_pair.get("node_b")
            require(
                json_integer(node_a) and node_a >= 0,
                f"{path}.{pair_id}.node_pairs[{node_pair_index}].node_a must be non-negative integer",
            )
            require(
                json_integer(node_b) and node_b >= 0,
                f"{path}.{pair_id}.node_pairs[{node_pair_index}].node_b must be non-negative integer",
            )
            if topology_node_count is not None:
                require(
                    node_a < topology_node_count,
                    f"{path}.{pair_id}.node_pairs[{node_pair_index}].node_a must be less than mesh node count {topology_node_count}",
                )
                require(
                    node_b < topology_node_count,
                    f"{path}.{pair_id}.node_pairs[{node_pair_index}].node_b must be less than mesh node count {topology_node_count}",
                )
            canonical_node_pairs.add((node_a, node_b))
        require(
            len(canonical_node_pairs) == paired_node_count,
            f"{path}.{pair_id}.node_pairs must not contain duplicate mappings",
        )
        observed_node_sets_by_id.setdefault(pair_id, set()).update(canonical_node_pairs)

        boundary_face_pairs = require_list(pair.get("boundary_face_pairs"), f"{path}.{pair_id}.boundary_face_pairs")
        require(boundary_face_pairs, f"{path}.{pair_id}.boundary_face_pairs must be non-empty")
        translations: set[tuple[float, float, float]] = set()
        for face_pair_index, raw_face_pair in enumerate(boundary_face_pairs):
            face_pair = require_object(raw_face_pair, f"{path}.{pair_id}.boundary_face_pairs[{face_pair_index}]")
            face_a = face_pair.get("face_a")
            face_b = face_pair.get("face_b")
            require(
                json_integer(face_a) and face_a >= 0,
                f"{path}.{pair_id}.boundary_face_pairs[{face_pair_index}].face_a must be non-negative integer",
            )
            require(
                json_integer(face_b) and face_b >= 0,
                f"{path}.{pair_id}.boundary_face_pairs[{face_pair_index}].face_b must be non-negative integer",
            )
            if topology_boundary_face_count is not None:
                require(
                    face_a < topology_boundary_face_count,
                    f"{path}.{pair_id}.boundary_face_pairs[{face_pair_index}].face_a must be less than mesh boundary face count {topology_boundary_face_count}",
                )
                require(
                    face_b < topology_boundary_face_count,
                    f"{path}.{pair_id}.boundary_face_pairs[{face_pair_index}].face_b must be less than mesh boundary face count {topology_boundary_face_count}",
                )
            translation = require_list(
                face_pair.get("translation_m"),
                f"{path}.{pair_id}.boundary_face_pairs[{face_pair_index}].translation_m",
            )
            require(
                len(translation) == 3,
                f"{path}.{pair_id}.boundary_face_pairs[{face_pair_index}].translation_m must be a 3-vector",
            )
            translations.add(tuple(
                finite_number(
                    component,
                    f"{path}.{pair_id}.boundary_face_pairs[{face_pair_index}].translation_m[{component_index}]",
                )
                for component_index, component in enumerate(translation)
            ))
            require(
                face_pair.get("orientation") == "opposed_normals",
                f"{path}.{pair_id}.boundary_face_pairs[{face_pair_index}].orientation must be opposed_normals",
            )
            normal_dot = finite_number(
                face_pair.get("normal_dot"),
                f"{path}.{pair_id}.boundary_face_pairs[{face_pair_index}].normal_dot",
            )
            require(
                normal_dot <= -0.999,
                f"{path}.{pair_id}.boundary_face_pairs[{face_pair_index}].normal_dot must be <= -0.999",
            )
        definition_key = (pair_id, tuple(sorted(translations)))
        previous_node_pairs = fragmented_node_sets.get(definition_key)
        if previous_node_pairs is None:
            fragmented_node_sets[definition_key] = canonical_node_pairs
            fragmented_domain_counts[definition_key] = (magnetic_count, airbox_count)
        else:
            require(
                canonical_node_pairs == previous_node_pairs,
                f"{path}.{pair_id}.node_pairs must match every fragmented definition for the same translation",
            )
            require(
                fragmented_domain_counts[definition_key] == (magnetic_count, airbox_count),
                f"{path}.{pair_id}.domain_node_pair_counts must match every fragmented definition for the same translation",
            )
    for pair_id in ("x_faces", "y_faces"):
        require(pair_id in pair_ids, f"{path} missing pair {pair_id}")
    aggregate_paired_node_count = payload.get("paired_node_count")
    require(json_integer(aggregate_paired_node_count), f"{path}.paired_node_count must be an integer")
    require(
        aggregate_paired_node_count == artifact_paired_node_sum,
        f"{path}.paired_node_count must match the sum across pair definitions",
    )
    require(
        sum(len(node_pairs) for node_pairs in observed_node_sets_by_id.values()) == mesh_node_count,
        f"{path}.paired_node_count must match unique per-pair-id metadata sum",
    )
    for pair_id in pair_ids:
        require(
            len(observed_node_sets_by_id[pair_id]) == mesh_node_counts[pair_id],
            f"{path}.{pair_id}.unique node-pair mappings must match metadata.mesh",
        )
        expected_definition_count = mesh_boundary_counts.get(pair_id)
        require(
            json_integer(expected_definition_count) and expected_definition_count > 0,
            f"{root}/metadata.mesh.periodic_boundary_pair_counts_by_id.{pair_id} must be positive integer",
        )
        require(
            observed_boundary_definition_counts[pair_id] == expected_definition_count,
            f"{path}.{pair_id} definition count must match metadata.mesh",
        )
    require(
        sum(observed_boundary_definition_counts.values()) == mesh_boundary_count,
        f"{path}.pair_count must match metadata.mesh aggregate",
    )


def require_static_pbc_demag_runtime_contract(root: Path, metadata: dict[str, Any]) -> None:
    demag = require_object(metadata.get("demag_runtime"), f"{root}/metadata.demag_runtime")
    require(
        demag.get("magnetostatic_boundary_model") == "periodic_airbox_k0",
        (
            f"{root}/metadata.demag_runtime.magnetostatic_boundary_model "
            "must be periodic_airbox_k0"
        ),
    )
    require(
        demag.get("poisson_operator") == "pbc_reduced_poisson",
        f"{root}/metadata.demag_runtime.poisson_operator must be pbc_reduced_poisson",
    )
    periodic_reduction = require_object(
        demag.get("periodic_reduction"),
        f"{root}/metadata.demag_runtime.periodic_reduction",
    )
    require(
        periodic_reduction.get("enabled") is True,
        f"{root}/metadata.demag_runtime.periodic_reduction.enabled must be true",
    )
    require(
        periodic_reduction.get("method") == "P^T A P",
        f"{root}/metadata.demag_runtime.periodic_reduction.method must be P^T A P",
    )
    require(
        periodic_reduction.get("periodic_boundary_markers_excluded_from_robin") is True,
        (
            f"{root}/metadata.demag_runtime.periodic_reduction."
            "periodic_boundary_markers_excluded_from_robin must be true"
        ),
    )
    mesh = require_object(metadata.get("mesh"), f"{root}/metadata.mesh")
    mesh_node_count = mesh.get("periodic_node_pair_count")
    require(
        json_integer(mesh_node_count) and mesh_node_count > 0,
        f"{root}/metadata.mesh.periodic_node_pair_count must be positive",
    )
    mesh_boundary_count = mesh.get("periodic_boundary_pair_count")
    require(
        json_integer(mesh_boundary_count) and mesh_boundary_count > 0,
        f"{root}/metadata.mesh.periodic_boundary_pair_count must be positive",
    )
    mesh_node_counts = require_object(
        mesh.get("periodic_node_pair_counts_by_id"),
        f"{root}/metadata.mesh.periodic_node_pair_counts_by_id",
    )
    mesh_boundary_counts = require_object(
        mesh.get("periodic_boundary_pair_counts_by_id"),
        f"{root}/metadata.mesh.periodic_boundary_pair_counts_by_id",
    )
    reduction_node_count = periodic_reduction.get("node_pair_count")
    reduction_boundary_count = periodic_reduction.get("boundary_pair_count")
    reduction_node_counts = require_object(
        periodic_reduction.get("node_pair_counts_by_id"),
        f"{root}/metadata.demag_runtime.periodic_reduction.node_pair_counts_by_id",
    )
    reduction_boundary_counts = require_object(
        periodic_reduction.get("boundary_pair_counts_by_id"),
        f"{root}/metadata.demag_runtime.periodic_reduction.boundary_pair_counts_by_id",
    )
    node_sum = 0
    boundary_sum = 0
    for pair_id in ("x_faces", "y_faces"):
        mesh_pair_node_count = mesh_node_counts.get(pair_id)
        require(
            json_integer(mesh_pair_node_count) and mesh_pair_node_count > 0,
            f"{root}/metadata.mesh.periodic_node_pair_counts_by_id.{pair_id} must be positive",
        )
        node_sum += mesh_pair_node_count
        require(
            reduction_node_counts.get(pair_id) == mesh_pair_node_count,
            (
                f"{root}/metadata.demag_runtime.periodic_reduction."
                f"node_pair_counts_by_id.{pair_id} must match metadata.mesh"
            ),
        )
        mesh_pair_boundary_count = mesh_boundary_counts.get(pair_id)
        require(
            json_integer(mesh_pair_boundary_count) and mesh_pair_boundary_count > 0,
            f"{root}/metadata.mesh.periodic_boundary_pair_counts_by_id.{pair_id} must be positive",
        )
        boundary_sum += mesh_pair_boundary_count
        require(
            reduction_boundary_counts.get(pair_id) == mesh_pair_boundary_count,
            (
                f"{root}/metadata.demag_runtime.periodic_reduction."
                f"boundary_pair_counts_by_id.{pair_id} must match metadata.mesh"
            ),
        )
    require(
        reduction_node_count == mesh_node_count == node_sum,
        (
            f"{root}/metadata.demag_runtime.periodic_reduction.node_pair_count "
            "must match metadata.mesh and per-pair-id sum"
        ),
    )
    require(
        reduction_boundary_count == mesh_boundary_count == boundary_sum,
        (
            f"{root}/metadata.demag_runtime.periodic_reduction.boundary_pair_count "
            "must match metadata.mesh and per-pair-id sum"
        ),
    )


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


def m_artifact_name(state: str) -> str:
    if state == STATE_INITIAL:
        return "m_initial.json"
    require(state == STATE_FINAL, f"unsupported comparison state {state!r}")
    return "m_final.json"


def load_m_values(root: Path, *, state: str = STATE_FINAL) -> list[list[float]]:
    artifact_name = m_artifact_name(state)
    data = load_json(root / artifact_name)
    values_name = f"{artifact_name}.values"
    values = require_list(data.get("values"), values_name)
    out: list[list[float]] = []
    for index, raw in enumerate(values):
        vector = require_list(raw, f"{values_name}[{index}]")
        require(len(vector) == 3, f"{values_name}[{index}] must be a 3-vector")
        out.append([finite_number(vector[i], f"{values_name}[{index}][{i}]") for i in range(3)])
    require(out, f"{values_name} must be non-empty")
    return out


def average_m(root: Path, *, state: str = STATE_FINAL) -> list[float]:
    values = load_m_values(root, state=state)
    return average_vectors(values, magnetic_node_indices(root, len(values)), f"{m_artifact_name(state)}.values")


def magnetic_node_indices(root: Path, node_count: int) -> list[int]:
    geometry_path = root / "mesh" / "node_geometry.v1.json"
    if not geometry_path.is_file():
        return metadata_magnetic_node_indices(root, node_count)
    geometry = load_json(geometry_path)
    mask = require_list(geometry.get("magnetic_node_mask"), "mesh/node_geometry.v1.json magnetic_node_mask")
    require(len(mask) == node_count, "mesh/node_geometry.v1.json magnetic_node_mask length must match m_final.values")
    indices: list[int] = []
    for index, value in enumerate(mask):
        require(isinstance(value, bool), f"mesh/node_geometry.v1.json magnetic_node_mask[{index}] must be boolean")
        if value:
            indices.append(index)
    require(indices, "mesh/node_geometry.v1.json magnetic_node_mask must select at least one magnetic node")
    return indices


def metadata_magnetic_node_indices(root: Path, node_count: int) -> list[int]:
    metadata_path = root / "metadata.json"
    if not metadata_path.is_file():
        return list(range(node_count))
    metadata = load_json(metadata_path)
    execution_plan = metadata.get("execution_plan")
    if not isinstance(execution_plan, dict):
        return list(range(node_count))
    backend_plan = execution_plan.get("backend_plan")
    if not isinstance(backend_plan, dict):
        return list(range(node_count))
    mesh = backend_plan.get("mesh")
    if not isinstance(mesh, dict):
        return list(range(node_count))
    nodes = require_list(mesh.get("nodes"), "metadata.execution_plan.backend_plan.mesh.nodes")
    require(len(nodes) == node_count, "metadata mesh node count must match m_final.values")
    elements = require_list(mesh.get("elements"), "metadata.execution_plan.backend_plan.mesh.elements")
    markers = mesh.get("element_markers")
    marker_values: list[int] = []
    if markers is not None:
        raw_markers = require_list(markers, "metadata.execution_plan.backend_plan.mesh.element_markers")
        require(len(raw_markers) == len(elements), "metadata mesh element_markers length must match elements")
        marker_values = [int(value) for value in raw_markers]
    has_mixed_airbox = bool(marker_values) and any(value == 0 for value in marker_values) and any(
        value != 0 for value in marker_values
    )
    magnetic: set[int] = set()
    for element_index, raw_element in enumerate(elements):
        if has_mixed_airbox and marker_values[element_index] == 0:
            continue
        element = require_list(raw_element, f"metadata.execution_plan.backend_plan.mesh.elements[{element_index}]")
        require(len(element) == 4, f"metadata mesh element {element_index} must be a tetrahedron")
        for raw_node in element:
            require(json_integer(raw_node), f"metadata mesh element {element_index} node index must be integer")
            require(0 <= raw_node < node_count, f"metadata mesh element {element_index} node index out of range")
            magnetic.add(raw_node)
    require(magnetic, "metadata mesh magnetic node selection must not be empty")
    return sorted(magnetic)


def metadata_mesh(root: Path) -> tuple[list[list[float]], list[list[int]], list[int] | None]:
    metadata = load_metadata(root)
    execution_plan = require_object(metadata.get("execution_plan"), "metadata.execution_plan")
    backend_plan = require_object(
        execution_plan.get("backend_plan"),
        "metadata.execution_plan.backend_plan",
    )
    mesh = require_object(backend_plan.get("mesh"), "metadata.execution_plan.backend_plan.mesh")
    raw_nodes = require_list(mesh.get("nodes"), "metadata.execution_plan.backend_plan.mesh.nodes")
    nodes: list[list[float]] = []
    for index, raw in enumerate(raw_nodes):
        node = require_list(raw, f"metadata.execution_plan.backend_plan.mesh.nodes[{index}]")
        require(len(node) == 3, f"metadata mesh node {index} must be a 3-vector")
        nodes.append([finite_number(node[axis], f"metadata mesh node {index}[{axis}]") for axis in range(3)])
    raw_elements = require_list(mesh.get("elements"), "metadata.execution_plan.backend_plan.mesh.elements")
    elements: list[list[int]] = []
    for element_index, raw_element in enumerate(raw_elements):
        element = require_list(raw_element, f"metadata mesh element {element_index}")
        require(len(element) == 4, f"metadata mesh element {element_index} must be a tetrahedron")
        parsed: list[int] = []
        for local_index, raw_node in enumerate(element):
            require(json_integer(raw_node), f"metadata mesh element {element_index}[{local_index}] must be integer")
            require(0 <= raw_node < len(nodes), f"metadata mesh element {element_index}[{local_index}] out of node range")
            parsed.append(raw_node)
        elements.append(parsed)
    markers = None
    raw_markers = mesh.get("element_markers")
    if raw_markers is not None:
        marker_values = require_list(raw_markers, "metadata.execution_plan.backend_plan.mesh.element_markers")
        require(len(marker_values) == len(elements), "metadata mesh element_markers length must match elements")
        markers = []
        for index, marker in enumerate(marker_values):
            require(json_integer(marker), f"metadata mesh element_markers[{index}] must be integer")
            markers.append(marker)
    return nodes, elements, markers


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


def det3(a: list[float], b: list[float], c: list[float]) -> float:
    return (
        a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0])
    )


def vec_sub(a: list[float], b: list[float]) -> list[float]:
    return [ai - bi for ai, bi in zip(a, b)]


def barycentric_weights(
    point: list[float],
    tetra: list[list[float]],
    *,
    tolerance: float,
) -> list[float] | None:
    p0, p1, p2, p3 = tetra
    e1 = vec_sub(p1, p0)
    e2 = vec_sub(p2, p0)
    e3 = vec_sub(p3, p0)
    rhs = vec_sub(point, p0)
    det = det3(e1, e2, e3)
    if abs(det) <= 1.0e-300:
        return None
    u = det3(rhs, e2, e3) / det
    v = det3(e1, rhs, e3) / det
    w = det3(e1, e2, rhs) / det
    weights = [1.0 - u - v - w, u, v, w]
    if min(weights) < -tolerance or max(weights) > 1.0 + tolerance:
        return None
    return weights


def interpolate_vector(values: list[list[float]], element: list[int], weights: list[float]) -> list[float]:
    return [
        sum(weights[local] * values[node_index][component] for local, node_index in enumerate(element))
        for component in range(3)
    ]


def interpolate_scalar(values: list[float], element: list[int], weights: list[float]) -> float:
    return sum(weights[local] * values[node_index] for local, node_index in enumerate(element))


def element_index_filter(markers: list[int] | None, *, magnetic_only: bool) -> list[int] | None:
    if not magnetic_only or markers is None:
        return None
    has_mixed_airbox = any(marker == 0 for marker in markers) and any(marker != 0 for marker in markers)
    if not has_mixed_airbox:
        return None
    return [index for index, marker in enumerate(markers) if marker != 0]


def containing_tetra(
    point: list[float],
    *,
    nodes: list[list[float]],
    elements: list[list[int]],
    candidate_element_indices: list[int] | None,
    spatial_index: dict[tuple[int, int, int], list[int]] | None = None,
    spatial_cell_size: float | None = None,
    tolerance: float,
) -> tuple[list[int], list[float], float] | None:
    if spatial_index is not None and spatial_cell_size is not None:
        spatial_candidates = element_candidates_from_spatial_index(
            point,
            spatial_index=spatial_index,
            cell_size=spatial_cell_size,
        )
        indices = spatial_candidates if spatial_candidates else (
            candidate_element_indices if candidate_element_indices is not None else range(len(elements))
        )
    else:
        indices = candidate_element_indices if candidate_element_indices is not None else range(len(elements))
    best: tuple[list[int], list[float], float] | None = None
    for element_index in indices:
        element = elements[element_index]
        tetra = [nodes[node_index] for node_index in element]
        weights = barycentric_weights(point, tetra, tolerance=tolerance)
        if weights is None:
            continue
        min_weight = min(weights)
        if best is None or min_weight > best[2]:
            best = (element, weights, min_weight)
    return best


def percentile(values: list[float], q: float) -> float:
    require(values, "percentile values must be non-empty")
    require(0.0 <= q <= 1.0, "percentile q must be in [0, 1]")
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(q * (len(ordered) - 1)))
    return ordered[index]


def vector_deviation_stats(
    values: list[list[float]],
    indices: list[int],
    reference: list[float],
    name: str,
) -> dict[str, float]:
    require(indices, f"{name} index list must be non-empty")
    deviations = [l2_delta(values[index], reference) for index in indices]
    return {
        "mean_l2": sum(deviations) / float(len(deviations)),
        "max_l2": max(deviations),
    }


def load_node_geometry_nodes(root: Path, *, expected_count: int) -> list[list[float]]:
    geometry_path = root / "mesh" / "node_geometry.v1.json"
    if geometry_path.is_file():
        geometry = load_json(geometry_path)
        nodes = require_list(geometry.get("nodes_m"), "mesh/node_geometry.v1.json nodes_m")
    else:
        metadata = load_metadata(root)
        execution_plan = require_object(metadata.get("execution_plan"), "metadata.execution_plan")
        backend_plan = require_object(
            execution_plan.get("backend_plan"),
            "metadata.execution_plan.backend_plan",
        )
        mesh = require_object(backend_plan.get("mesh"), "metadata.execution_plan.backend_plan.mesh")
        nodes = require_list(mesh.get("nodes"), "metadata.execution_plan.backend_plan.mesh.nodes")
    require(
        len(nodes) == expected_count,
        "node coordinate length must match field length",
    )
    parsed: list[list[float]] = []
    for index, raw in enumerate(nodes):
        node = require_list(raw, f"mesh/node_geometry.v1.json nodes_m[{index}]")
        require(len(node) == 3, f"mesh/node_geometry.v1.json nodes_m[{index}] must be a 3-vector")
        parsed.append(
            [
                finite_number(node[axis], f"mesh/node_geometry.v1.json nodes_m[{index}][{axis}]")
                for axis in range(3)
            ]
        )
    return parsed


def reduce_periodic_coordinate(value: float, period: float) -> float:
    return ((value + 0.5 * period) % period) - 0.5 * period


def spatial_key(point: list[float], cell_size: float) -> tuple[int, int, int]:
    return (
        math.floor(point[0] / cell_size),
        math.floor(point[1] / cell_size),
        math.floor(point[2] / cell_size),
    )


def element_bbox(nodes: list[list[float]], element: list[int]) -> tuple[list[float], list[float]]:
    points = [nodes[node_index] for node_index in element]
    return (
        [min(point[axis] for point in points) for axis in range(3)],
        [max(point[axis] for point in points) for axis in range(3)],
    )


def estimate_element_cell_size(nodes: list[list[float]], elements: list[list[int]]) -> float:
    mins = [min(node[axis] for node in nodes) for axis in range(3)]
    maxs = [max(node[axis] for node in nodes) for axis in range(3)]
    spans = [maxs[axis] - mins[axis] for axis in range(3)]
    positive_spans = [span for span in spans if span > 0.0]
    if not positive_spans:
        return 1.0
    volume = 1.0
    for span in positive_spans:
        volume *= span
    characteristic = (volume / float(max(len(elements), 1))) ** (1.0 / float(len(positive_spans)))
    return max(characteristic * 4.0, max(positive_spans) * 1.0e-6, 1.0e-15)


def build_element_spatial_index(
    *,
    nodes: list[list[float]],
    elements: list[list[int]],
    candidate_element_indices: list[int] | None,
    cell_size: float,
    tolerance: float,
) -> dict[tuple[int, int, int], list[int]]:
    indices = candidate_element_indices if candidate_element_indices is not None else range(len(elements))
    index: dict[tuple[int, int, int], list[int]] = {}
    for element_index in indices:
        bbox_min, bbox_max = element_bbox(nodes, elements[element_index])
        min_key = spatial_key([bbox_min[axis] - tolerance for axis in range(3)], cell_size)
        max_key = spatial_key([bbox_max[axis] + tolerance for axis in range(3)], cell_size)
        for ix in range(min_key[0], max_key[0] + 1):
            for iy in range(min_key[1], max_key[1] + 1):
                for iz in range(min_key[2], max_key[2] + 1):
                    index.setdefault((ix, iy, iz), []).append(element_index)
    return index


def element_candidates_from_spatial_index(
    point: list[float],
    *,
    spatial_index: dict[tuple[int, int, int], list[int]],
    cell_size: float,
) -> list[int]:
    base_key = spatial_key(point, cell_size)
    seen: set[int] = set()
    candidates: list[int] = []
    for radius in (0, 1, 2):
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                for dz in range(-radius, radius + 1):
                    key = (base_key[0] + dx, base_key[1] + dy, base_key[2] + dz)
                    for element_index in spatial_index.get(key, []):
                        if element_index in seen:
                            continue
                        seen.add(element_index)
                        candidates.append(element_index)
        if candidates:
            return candidates
    return candidates


def build_spatial_index(
    nodes: list[list[float]],
    indices: list[int],
    *,
    cell_size: float,
) -> dict[tuple[int, int, int], list[int]]:
    index: dict[tuple[int, int, int], list[int]] = {}
    for node_index in indices:
        index.setdefault(spatial_key(nodes[node_index], cell_size), []).append(node_index)
    return index


def nearest_periodic_unit_node(
    point: list[float],
    *,
    unit_nodes: list[list[float]],
    candidate_indices: list[int],
    unit_periods: list[float],
    spatial_index: dict[tuple[int, int, int], list[int]],
    cell_size: float,
) -> tuple[int, float]:
    reduced = [
        reduce_periodic_coordinate(point[0], unit_periods[0]),
        reduce_periodic_coordinate(point[1], unit_periods[1]),
        point[2],
    ]
    base_key = spatial_key(reduced, cell_size)
    best_index = -1
    best_distance2 = math.inf
    for radius in (1, 2, 4):
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                for dz in range(-radius, radius + 1):
                    key = (base_key[0] + dx, base_key[1] + dy, base_key[2] + dz)
                    for candidate in spatial_index.get(key, []):
                        node = unit_nodes[candidate]
                        distance2 = sum((reduced[axis] - node[axis]) ** 2 for axis in range(3))
                        if distance2 < best_distance2:
                            best_index = candidate
                            best_distance2 = distance2
        if best_index >= 0:
            return best_index, math.sqrt(best_distance2)
    for candidate in candidate_indices:
        node = unit_nodes[candidate]
        distance2 = sum((reduced[axis] - node[axis]) ** 2 for axis in range(3))
        if distance2 < best_distance2:
            best_index = candidate
            best_distance2 = distance2
    require(best_index >= 0, "nearest-node mapping requires at least one candidate unit node")
    return best_index, math.sqrt(best_distance2)


def zarr_vectors(root: Path, observable: str, *, state: str = STATE_FINAL) -> list[list[float]]:
    components, values = load_zarr_values(root, observable, state=state)
    require(components == ["x", "y", "z"], f"{observable} component_order must be x/y/z")
    cell_count = len(values) // 3
    return [
        [values[index], values[cell_count + index], values[2 * cell_count + index]]
        for index in range(cell_count)
    ]


def zarr_scalars(root: Path, observable: str, *, state: str = STATE_FINAL) -> list[float]:
    components, values = load_zarr_values(root, observable, state=state)
    require(components == ["scalar"], f"{observable} component_order must be scalar")
    return values


def mapped_pair_indices(
    *,
    unit_nodes: list[list[float]],
    supercell_nodes: list[list[float]],
    supercell_indices: list[int],
    unit_candidate_indices: list[int],
    unit_periods: list[float],
) -> tuple[list[tuple[int, int]], list[float]]:
    cell_size = max(DEFAULT_MAPPED_SUPERCELL_NEAREST_DISTANCE_M, 1.0e-15)
    spatial_index = build_spatial_index(unit_nodes, unit_candidate_indices, cell_size=cell_size)
    pairs: list[tuple[int, int]] = []
    distances: list[float] = []
    for supercell_index in supercell_indices:
        unit_index, distance = nearest_periodic_unit_node(
            supercell_nodes[supercell_index],
            unit_nodes=unit_nodes,
            candidate_indices=unit_candidate_indices,
            unit_periods=unit_periods,
            spatial_index=spatial_index,
            cell_size=cell_size,
        )
        pairs.append((unit_index, supercell_index))
        distances.append(distance)
    return pairs, distances


def vector_pair_delta_stats(
    *,
    unit_values: list[list[float]],
    supercell_values: list[list[float]],
    pairs: list[tuple[int, int]],
) -> dict[str, float]:
    zero = [0.0, 0.0, 0.0]
    deltas = [
        l2_delta(supercell_values[supercell_index], unit_values[unit_index])
        for unit_index, supercell_index in pairs
    ]
    unit_norms = [l2_delta(unit_values[unit_index], zero) for unit_index, _ in pairs]
    supercell_norms = [l2_delta(supercell_values[supercell_index], zero) for _, supercell_index in pairs]
    scale = max(percentile(unit_norms, 0.99), percentile(supercell_norms, 0.99), 1.0e-300)
    return {
        "mean_l2_delta": sum(deltas) / float(len(deltas)),
        "p99_l2_delta": percentile(deltas, 0.99),
        "max_l2_delta": max(deltas),
        "p99_relative_error": percentile(deltas, 0.99) / scale,
    }


def scalar_pair_delta_stats_with_offset(
    *,
    unit_values: list[float],
    supercell_values: list[float],
    pairs: list[tuple[int, int]],
) -> dict[str, float]:
    offsets = [
        supercell_values[supercell_index] - unit_values[unit_index]
        for unit_index, supercell_index in pairs
    ]
    best_offset = sum(offsets) / float(len(offsets))
    residuals = [abs(offset - best_offset) for offset in offsets]
    return {
        "best_constant_offset_A": best_offset,
        "mean_abs_delta_after_offset_A": sum(residuals) / float(len(residuals)),
        "p99_abs_delta_after_offset_A": percentile(residuals, 0.99),
        "max_abs_delta_after_offset_A": max(residuals),
    }


def vector_interpolated_delta_stats(
    *,
    reference_values: list[list[float]],
    sample_values: list[list[float]],
    sample_points_m: list[list[float]] | None = None,
    unit_periods_m: list[float] | None = None,
) -> dict[str, Any]:
    zero = [0.0, 0.0, 0.0]
    deltas = [l2_delta(sample, reference) for sample, reference in zip(sample_values, reference_values)]
    delta_vectors = [
        [sample[component] - reference[component] for component in range(3)]
        for sample, reference in zip(sample_values, reference_values)
    ]
    mean_delta = [
        sum(delta[component] for delta in delta_vectors) / float(len(delta_vectors))
        for component in range(3)
    ]
    deltas_after_mean = [
        l2_delta(delta, mean_delta)
        for delta in delta_vectors
    ]
    reference_norms = [l2_delta(value, zero) for value in reference_values]
    sample_norms = [l2_delta(value, zero) for value in sample_values]
    scale = max(percentile(reference_norms, 0.99), percentile(sample_norms, 0.99), 1.0e-300)
    result = {
        "mean_l2_delta": sum(deltas) / float(len(deltas)),
        "p99_l2_delta": percentile(deltas, 0.99),
        "max_l2_delta": max(deltas),
        "p99_relative_error": percentile(deltas, 0.99) / scale,
        "mean_delta_vector_Apm": mean_delta,
        "p99_l2_delta_after_mean_delta": percentile(deltas_after_mean, 0.99),
        "max_l2_delta_after_mean_delta": max(deltas_after_mean),
        "p99_relative_error_after_mean_delta": percentile(deltas_after_mean, 0.99) / scale,
    }
    if sample_points_m is not None and unit_periods_m is not None:
        result["spatial_error_profile"] = spatial_error_profile(
            points=sample_points_m,
            errors=deltas,
            unit_periods_m=unit_periods_m,
        )
        result["spatial_error_profile_after_mean_delta"] = spatial_error_profile(
            points=sample_points_m,
            errors=deltas_after_mean,
            unit_periods_m=unit_periods_m,
        )
    return result


def lateral_seam_distance_m(point: list[float], unit_periods_m: list[float]) -> float:
    distances: list[float] = []
    for axis in (0, 1):
        period = unit_periods_m[axis]
        coordinate = reduce_periodic_coordinate(point[axis], period)
        distances.append(coordinate)
        distances.append(period - coordinate)
    return min(distances)


def spatial_error_profile(
    *,
    points: list[list[float]],
    errors: list[float],
    unit_periods_m: list[float],
) -> dict[str, Any]:
    require(len(points) == len(errors), "spatial error profile points/errors length mismatch")
    require(points, "spatial error profile requires at least one sample")
    max_index = max(range(len(errors)), key=lambda index: errors[index])
    ranked_indices = sorted(range(len(errors)), key=lambda index: errors[index], reverse=True)
    top_count = max(1, int(math.ceil(len(errors) * 0.01)))
    top_indices = ranked_indices[:top_count]
    top_distances = [lateral_seam_distance_m(points[index], unit_periods_m) for index in top_indices]
    return {
        "sample_count": len(errors),
        "top_error_fraction": 0.01,
        "top_error_sample_count": top_count,
        "max_error": errors[max_index],
        "max_error_point_m": points[max_index],
        "max_error_lateral_seam_distance_m": lateral_seam_distance_m(points[max_index], unit_periods_m),
        "max_error_z_m": points[max_index][2],
        "top_error_mean_lateral_seam_distance_m": sum(top_distances) / float(len(top_distances)),
        "top_error_min_lateral_seam_distance_m": min(top_distances),
        "top_error_max_lateral_seam_distance_m": max(top_distances),
    }


def solve_linear_system(matrix: list[list[float]], rhs: list[float]) -> list[float] | None:
    size = len(rhs)
    augmented = [row[:] + [rhs[index]] for index, row in enumerate(matrix)]
    for pivot_index in range(size):
        pivot_row = max(range(pivot_index, size), key=lambda row: abs(augmented[row][pivot_index]))
        pivot_value = augmented[pivot_row][pivot_index]
        if abs(pivot_value) <= 1.0e-300:
            return None
        if pivot_row != pivot_index:
            augmented[pivot_index], augmented[pivot_row] = augmented[pivot_row], augmented[pivot_index]
        pivot_value = augmented[pivot_index][pivot_index]
        for column in range(pivot_index, size + 1):
            augmented[pivot_index][column] /= pivot_value
        for row in range(size):
            if row == pivot_index:
                continue
            factor = augmented[row][pivot_index]
            if factor == 0.0:
                continue
            for column in range(pivot_index, size + 1):
                augmented[row][column] -= factor * augmented[pivot_index][column]
    return [augmented[row][size] for row in range(size)]


def affine_delta_fit(
    *,
    points: list[list[float]],
    offsets: list[float],
) -> tuple[list[float], list[float]]:
    normal = [[0.0 for _ in range(4)] for _ in range(4)]
    rhs = [0.0 for _ in range(4)]
    for point, offset in zip(points, offsets):
        row = [1.0, point[0], point[1], point[2]]
        for i in range(4):
            rhs[i] += row[i] * offset
            for j in range(4):
                normal[i][j] += row[i] * row[j]
    coefficients = solve_linear_system(normal, rhs)
    if coefficients is None:
        best_offset = sum(offsets) / float(len(offsets))
        coefficients = [best_offset, 0.0, 0.0, 0.0]
    residuals = [
        abs(offset - (coefficients[0] + coefficients[1] * point[0] + coefficients[2] * point[1] + coefficients[3] * point[2]))
        for point, offset in zip(points, offsets)
    ]
    return coefficients, residuals


def scalar_interpolated_delta_stats_with_offset(
    *,
    reference_values: list[float],
    sample_values: list[float],
    sample_points_m: list[list[float]] | None = None,
    unit_periods_m: list[float] | None = None,
) -> dict[str, Any]:
    offsets = [sample - reference for sample, reference in zip(sample_values, reference_values)]
    best_offset = sum(offsets) / float(len(offsets))
    residuals = [abs(offset - best_offset) for offset in offsets]
    result = {
        "best_constant_offset_A": best_offset,
        "mean_abs_delta_after_offset_A": sum(residuals) / float(len(residuals)),
        "p99_abs_delta_after_offset_A": percentile(residuals, 0.99),
        "max_abs_delta_after_offset_A": max(residuals),
    }
    if sample_points_m is not None and unit_periods_m is not None:
        result["spatial_residual_profile_after_offset"] = spatial_error_profile(
            points=sample_points_m,
            errors=residuals,
            unit_periods_m=unit_periods_m,
        )
    if sample_points_m is not None and len(sample_points_m) == len(offsets):
        coefficients, affine_residuals = affine_delta_fit(points=sample_points_m, offsets=offsets)
        result.update(
            {
                "best_affine_offset_A": coefficients[0],
                "best_affine_gradient_A_per_m": coefficients[1:4],
                "mean_abs_delta_after_affine_A": sum(affine_residuals) / float(len(affine_residuals)),
                "p99_abs_delta_after_affine_A": percentile(affine_residuals, 0.99),
                "max_abs_delta_after_affine_A": max(affine_residuals),
            }
        )
        if unit_periods_m is not None:
            result["spatial_residual_profile_after_affine"] = spatial_error_profile(
                points=sample_points_m,
                errors=affine_residuals,
                unit_periods_m=unit_periods_m,
            )
    return result


def zarr_sample_row(rows: list[dict[str, str]], *, observable: str, state: str) -> dict[str, str]:
    if state == STATE_INITIAL:
        return rows[0]
    if state == STATE_FINAL:
        return rows[-1]
    fail(f"{observable} zarr state must be '{STATE_FINAL}' or '{STATE_INITIAL}', got {state!r}")


def load_zarr_values(root: Path, observable: str, *, state: str = STATE_FINAL) -> tuple[list[str], list[float]]:
    field_dir = root / "fields" / f"{observable}.zarr"
    require(field_dir.is_dir(), f"missing {observable} zarr directory: {field_dir}")
    attrs = load_json(field_dir / ".zattrs")
    array = load_json(field_dir / ".zarray")
    component_order = require_list(attrs.get("component_order"), f"{observable}.component_order")
    component_names = [str(component) for component in component_order]
    require(array.get("dtype") == "<f8", f"{observable} zarr dtype must be <f8")
    require(array.get("order") == "C", f"{observable} zarr order must be C")
    shape = require_list(array.get("shape"), f"{observable}.shape")
    require(
        len(shape) == 3
        and json_integer(shape[0])
        and json_integer(shape[1])
        and json_integer(shape[2]),
        f"{observable}.shape must be [samples, components, cells]",
    )
    sample_count = int(shape[0])
    component_count = int(shape[1])
    cell_count = int(shape[2])
    require(component_count == len(component_names), f"{observable}.shape/component_order mismatch")
    require(
        sample_count > 0 and component_count > 0 and cell_count > 0,
        f"{observable} zarr dimensions must be positive",
    )
    with (field_dir / "samples.csv").open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    require(rows, f"{observable} samples.csv must not be empty")
    require(
        len(rows) <= sample_count,
        f"{observable} samples.csv has {len(rows)} rows but shape declares {sample_count} samples",
    )
    chunk_key = zarr_sample_row(rows, observable=observable, state=state).get("chunk_key")
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
        require(json_integer(raw), f"{name}[{position}] must be an integer")
        require(0 <= raw < upper_bound, f"{name}[{position}] must be in [0, {upper_bound})")
        require(raw not in seen, f"{name}[{position}] duplicates index {raw}")
        seen.add(raw)
        indices.append(raw)
    return indices


def h_demag_max_norm_from_indices(root: Path, indices: list[int], *, state: str = STATE_FINAL) -> float:
    components, values = load_zarr_values(root, "H_demag", state=state)
    require(components == ["x", "y", "z"], "H_demag component_order must be x/y/z")
    cell_count = len(values) // 3
    bounded_indices = require_index_list(indices, "central-cell field_cell_indices", cell_count)
    return max(
        math.sqrt(values[i] ** 2 + values[cell_count + i] ** 2 + values[2 * cell_count + i] ** 2)
        for i in bounded_indices
    )


def h_demag_max_norm(root: Path, *, state: str = STATE_FINAL) -> float:
    components, values = load_zarr_values(root, "H_demag", state=state)
    require(components == ["x", "y", "z"], "H_demag component_order must be x/y/z")
    cell_count = len(values) // 3
    return h_demag_max_norm_from_indices(root, list(range(cell_count)), state=state)


def h_demag_cell_count(root: Path, *, state: str = STATE_FINAL) -> int:
    components, values = load_zarr_values(root, "H_demag", state=state)
    require(components == ["x", "y", "z"], "H_demag component_order must be x/y/z")
    return len(values) // 3


def h_demag_norm_percentile(root: Path, percentile: float, *, state: str = STATE_FINAL) -> float:
    require(0.0 <= percentile <= 1.0, "H_demag percentile must be in [0, 1]")
    components, values = load_zarr_values(root, "H_demag", state=state)
    require(components == ["x", "y", "z"], "H_demag component_order must be x/y/z")
    cell_count = len(values) // 3
    norms = sorted(
        math.sqrt(values[i] ** 2 + values[cell_count + i] ** 2 + values[2 * cell_count + i] ** 2)
        for i in range(cell_count)
    )
    require(norms, "H_demag norms must be non-empty")
    index = min(len(norms) - 1, int(percentile * (len(norms) - 1)))
    return norms[index]


def demag_phi_range_from_indices(root: Path, indices: list[int], *, state: str = STATE_FINAL) -> float:
    components, values = load_zarr_values(root, "demag_phi", state=state)
    require(components == ["scalar"], "demag_phi component_order must be scalar")
    bounded_indices = require_index_list(indices, "central-cell field_cell_indices", len(values))
    selected = [values[index] for index in bounded_indices]
    return max(selected) - min(selected)


def demag_phi_range(root: Path, *, state: str = STATE_FINAL) -> float:
    components, values = load_zarr_values(root, "demag_phi", state=state)
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
    state: str = STATE_FINAL,
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
        require(json_integer(value), f"supercell central-cell extraction central_cell_index[{axis}] must be an integer")
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
    m_values = load_m_values(root, state=state)
    _, h_values = load_zarr_values(root, "H_demag", state=state)
    _, phi_values = load_zarr_values(root, "demag_phi", state=state)
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


def mapped_central_cell_comparability(
    unit_root: Path,
    supercell_root: Path,
    *,
    extraction: dict[str, Any],
    workload: dict[str, Any],
    unit_m_values: list[list[float]],
    unit_magnetic_indices: list[int],
    supercell_m_values: list[list[float]],
    same_local_distance_limit_m: float,
    unit_state: str = STATE_FINAL,
    supercell_state: str = STATE_FINAL,
) -> dict[str, Any]:
    unit_nodes = load_node_geometry_nodes(unit_root, expected_count=len(unit_m_values))
    supercell_nodes = load_node_geometry_nodes(supercell_root, expected_count=len(supercell_m_values))
    raw_periods = require_list(workload.get("unit_universe_size_m"), "workload.unit_universe_size_m")
    unit_periods = [
        finite_number(value, f"workload.unit_universe_size_m[{index}]")
        for index, value in enumerate(raw_periods)
    ]
    magnetic_pairs, magnetic_distances = mapped_pair_indices(
        unit_nodes=unit_nodes,
        supercell_nodes=supercell_nodes,
        supercell_indices=extraction["magnetic_node_indices"],
        unit_candidate_indices=unit_magnetic_indices,
        unit_periods=unit_periods,
    )
    field_pairs, field_distances = mapped_pair_indices(
        unit_nodes=unit_nodes,
        supercell_nodes=supercell_nodes,
        supercell_indices=extraction["field_cell_indices"],
        unit_candidate_indices=list(range(len(unit_nodes))),
        unit_periods=unit_periods,
    )
    max_magnetic_distance = max(magnetic_distances)
    max_field_distance = max(field_distances)
    same_local = (
        max_magnetic_distance <= same_local_distance_limit_m
        and max_field_distance <= same_local_distance_limit_m
    )
    return {
        "schema_version": "fem_static_pbc_supercell_mapped_comparison.v1",
        "mapping": "supercell central-cell node -> modulo(x/y) nearest primitive-cell node",
        "same_local_discretization": same_local,
        "same_local_discretization_limit_m": same_local_distance_limit_m,
        "magnetic_pair_count": len(magnetic_pairs),
        "field_pair_count": len(field_pairs),
        "max_nearest_magnetic_node_distance_m": max_magnetic_distance,
        "mean_nearest_magnetic_node_distance_m": sum(magnetic_distances) / float(len(magnetic_distances)),
        "max_nearest_field_node_distance_m": max_field_distance,
        "mean_nearest_field_node_distance_m": sum(field_distances) / float(len(field_distances)),
        "m": vector_pair_delta_stats(
            unit_values=unit_m_values,
            supercell_values=supercell_m_values,
            pairs=magnetic_pairs,
        ),
        "H_demag": vector_pair_delta_stats(
            unit_values=zarr_vectors(unit_root, "H_demag", state=unit_state),
            supercell_values=zarr_vectors(supercell_root, "H_demag", state=supercell_state),
            pairs=field_pairs,
        ),
        "demag_phi": scalar_pair_delta_stats_with_offset(
            unit_values=zarr_scalars(unit_root, "demag_phi", state=unit_state),
            supercell_values=zarr_scalars(supercell_root, "demag_phi", state=supercell_state),
            pairs=field_pairs,
        ),
    }


def interpolated_central_cell_comparability(
    unit_root: Path,
    supercell_root: Path,
    *,
    extraction: dict[str, Any],
    workload: dict[str, Any],
    unit_m_values: list[list[float]],
    supercell_m_values: list[list[float]],
    barycentric_tolerance: float,
    unit_state: str = STATE_FINAL,
    supercell_state: str = STATE_FINAL,
) -> dict[str, Any]:
    unit_nodes, unit_elements, unit_markers = metadata_mesh(unit_root)
    require(len(unit_nodes) == len(unit_m_values), "unit metadata mesh node count must match m_final.values")
    supercell_nodes = load_node_geometry_nodes(supercell_root, expected_count=len(supercell_m_values))
    raw_periods = require_list(workload.get("unit_universe_size_m"), "workload.unit_universe_size_m")
    unit_periods = [
        finite_number(value, f"workload.unit_universe_size_m[{index}]")
        for index, value in enumerate(raw_periods)
    ]
    unit_h = zarr_vectors(unit_root, "H_demag", state=unit_state)
    unit_phi = zarr_scalars(unit_root, "demag_phi", state=unit_state)
    require(len(unit_h) == len(unit_nodes), "unit H_demag node count must match metadata mesh nodes")
    require(len(unit_phi) == len(unit_nodes), "unit demag_phi node count must match metadata mesh nodes")
    supercell_h = zarr_vectors(supercell_root, "H_demag", state=supercell_state)
    supercell_phi = zarr_scalars(supercell_root, "demag_phi", state=supercell_state)

    magnetic_element_indices = element_index_filter(unit_markers, magnetic_only=True)
    spatial_cell_size = estimate_element_cell_size(unit_nodes, unit_elements)
    field_spatial_index = build_element_spatial_index(
        nodes=unit_nodes,
        elements=unit_elements,
        candidate_element_indices=None,
        cell_size=spatial_cell_size,
        tolerance=barycentric_tolerance,
    )
    magnetic_spatial_index = build_element_spatial_index(
        nodes=unit_nodes,
        elements=unit_elements,
        candidate_element_indices=magnetic_element_indices,
        cell_size=spatial_cell_size,
        tolerance=barycentric_tolerance,
    )
    field_sample_values: list[list[float]] = []
    field_reference_values: list[list[float]] = []
    phi_sample_values: list[float] = []
    phi_reference_values: list[float] = []
    field_sample_points_m: list[list[float]] = []
    magnetic_sample_values: list[list[float]] = []
    magnetic_reference_values: list[list[float]] = []
    min_barycentric_weight = math.inf
    missed_field = 0
    missed_magnetic = 0

    for supercell_index in extraction["field_cell_indices"]:
        reduced = [
            reduce_periodic_coordinate(supercell_nodes[supercell_index][0], unit_periods[0]),
            reduce_periodic_coordinate(supercell_nodes[supercell_index][1], unit_periods[1]),
            supercell_nodes[supercell_index][2],
        ]
        located = containing_tetra(
            reduced,
            nodes=unit_nodes,
            elements=unit_elements,
            candidate_element_indices=None,
            spatial_index=field_spatial_index,
            spatial_cell_size=spatial_cell_size,
            tolerance=barycentric_tolerance,
        )
        if located is None:
            missed_field += 1
            continue
        element, weights, min_weight = located
        min_barycentric_weight = min(min_barycentric_weight, min_weight)
        field_reference_values.append(interpolate_vector(unit_h, element, weights))
        field_sample_values.append(supercell_h[supercell_index])
        phi_reference_values.append(interpolate_scalar(unit_phi, element, weights))
        phi_sample_values.append(supercell_phi[supercell_index])
        field_sample_points_m.append(reduced)

    for supercell_index in extraction["magnetic_node_indices"]:
        reduced = [
            reduce_periodic_coordinate(supercell_nodes[supercell_index][0], unit_periods[0]),
            reduce_periodic_coordinate(supercell_nodes[supercell_index][1], unit_periods[1]),
            supercell_nodes[supercell_index][2],
        ]
        located = containing_tetra(
            reduced,
            nodes=unit_nodes,
            elements=unit_elements,
            candidate_element_indices=magnetic_element_indices,
            spatial_index=magnetic_spatial_index,
            spatial_cell_size=spatial_cell_size,
            tolerance=barycentric_tolerance,
        )
        if located is None:
            missed_magnetic += 1
            continue
        element, weights, min_weight = located
        min_barycentric_weight = min(min_barycentric_weight, min_weight)
        magnetic_reference_values.append(interpolate_vector(unit_m_values, element, weights))
        magnetic_sample_values.append(supercell_m_values[supercell_index])

    field_count = int(extraction["field_cell_count"])
    magnetic_count = int(extraction["magnetic_node_count"])
    require(field_count > 0 and magnetic_count > 0, "interpolated comparison requires non-empty central-cell selections")
    require(field_sample_values, "interpolated comparison located no field samples in the primitive mesh")
    require(magnetic_sample_values, "interpolated comparison located no magnetic samples in the primitive mesh")
    if not math.isfinite(min_barycentric_weight):
        min_barycentric_weight = 0.0
    return {
        "schema_version": "fem_static_pbc_supercell_interpolated_comparison.v1",
        "mapping": "supercell central-cell node -> modulo(x/y) primitive tetrahedral linear interpolation",
        "interpolation_method": "linear_tetrahedral_barycentric",
        "barycentric_tolerance": barycentric_tolerance,
        "spatial_index_cell_size_m": spatial_cell_size,
        "field_sample_count": field_count,
        "field_located_count": len(field_sample_values),
        "field_missed_count": missed_field,
        "field_coverage_ratio": len(field_sample_values) / float(field_count),
        "magnetic_sample_count": magnetic_count,
        "magnetic_located_count": len(magnetic_sample_values),
        "magnetic_missed_count": missed_magnetic,
        "magnetic_coverage_ratio": len(magnetic_sample_values) / float(magnetic_count),
        "min_barycentric_weight": min_barycentric_weight,
        "m": vector_interpolated_delta_stats(
            reference_values=magnetic_reference_values,
            sample_values=magnetic_sample_values,
        ),
        "H_demag": vector_interpolated_delta_stats(
            reference_values=field_reference_values,
            sample_values=field_sample_values,
            sample_points_m=field_sample_points_m,
            unit_periods_m=unit_periods,
        ),
        "demag_phi": scalar_interpolated_delta_stats_with_offset(
            reference_values=phi_reference_values,
            sample_values=phi_sample_values,
            sample_points_m=field_sample_points_m,
            unit_periods_m=unit_periods,
        ),
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


def supercell_comparison_contract(*, unit_state: str, supercell_state: str) -> dict[str, Any]:
    if unit_state == STATE_FINAL and supercell_state == STATE_INITIAL:
        return {
            "purpose": "frozen_repeated_state_operator_equivalence",
            "precision_class": "technical_operator",
            "primitive_supercell_equivalence": "same_magnetization_state_only",
            "independent_supercell_relaxation": False,
            "recommended_h_demag_p99_relative_error_band": [1.0e-6, 1.0e-4],
            "recommended_e_demag_density_relative_error_band": [1.0e-6, 1.0e-4],
            "status_semantics": "operator_consistency_gate_not_physical_supercell_convergence",
        }
    if unit_state == STATE_INITIAL and supercell_state == STATE_INITIAL:
        return {
            "purpose": "initial_state_operator_equivalence",
            "precision_class": "technical_operator",
            "primitive_supercell_equivalence": "same_magnetization_state_only",
            "independent_supercell_relaxation": False,
            "recommended_h_demag_p99_relative_error_band": [1.0e-6, 1.0e-4],
            "recommended_e_demag_density_relative_error_band": [1.0e-6, 1.0e-4],
            "status_semantics": "operator_consistency_gate_not_physical_supercell_convergence",
        }
    if unit_state == STATE_FINAL and supercell_state == STATE_FINAL:
        return {
            "purpose": "independent_relaxed_supercell_convergence",
            "precision_class": "physical_convergence",
            "primitive_supercell_equivalence": "not_exact_unless_state_periodicity_is_constrained",
            "independent_supercell_relaxation": True,
            "recommended_h_demag_p99_relative_error_band": [1.0e-2, 5.0e-2],
            "recommended_e_demag_density_relative_error_band": [1.0e-2, 2.0e-2],
            "status_semantics": "acceptance_gate_not_exact_equality",
        }
    return {
        "purpose": "asymmetric_state_diagnostic",
        "precision_class": "diagnostic",
        "primitive_supercell_equivalence": "not_a_physical_equivalence_claim",
        "independent_supercell_relaxation": False,
        "recommended_h_demag_p99_relative_error_band": [1.0e-2, 5.0e-2],
        "recommended_e_demag_density_relative_error_band": [1.0e-2, 2.0e-2],
        "status_semantics": "diagnostic_only",
    }


def compare_supercell(args: argparse.Namespace) -> dict[str, Any]:
    require_different_roots(
        args.unit_cell,
        args.supercell,
        "unit-cell and supercell artifact roots must be different",
    )
    unit_state = args.unit_state or args.state
    supercell_state = args.supercell_state or args.state
    provenance = {
        "unit_cell": artifact_provenance(args.unit_cell),
        "supercell": artifact_provenance(args.supercell),
    }
    if unit_state == STATE_FINAL and supercell_state == STATE_FINAL:
        require(
            not provenance["unit_cell"]["diagnostic_fixture"],
            "diagnostic tiled unit-cell fixture cannot produce physical convergence evidence",
        )
        require(
            not provenance["supercell"]["diagnostic_fixture"],
            "diagnostic tiled supercell fixture cannot produce physical convergence evidence",
        )
    workload = require_supercell_workload(
        args.unit_cell,
        args.supercell,
        repeat_x=args.repeat_x,
        repeat_y=args.repeat_y,
    )
    comparison_state = unit_state if unit_state == supercell_state else f"{unit_state}_to_{supercell_state}"
    cell_count = args.repeat_x * args.repeat_y
    extraction = load_supercell_central_cell_extraction(
        args.supercell,
        repeat_x=args.repeat_x,
        repeat_y=args.repeat_y,
        state=supercell_state,
    )
    unit_m_values = load_m_values(args.unit_cell, state=unit_state)
    unit_magnetic_indices = magnetic_node_indices(args.unit_cell, len(unit_m_values))
    unit_m_values_name = f"{m_artifact_name(unit_state)}.values"
    supercell_m_values_name = f"{m_artifact_name(supercell_state)}.values"
    unit_average_m = average_vectors(unit_m_values, unit_magnetic_indices, unit_m_values_name)
    supercell_m_values = load_m_values(args.supercell, state=supercell_state)
    supercell_average_m = average_vectors(
        supercell_m_values,
        extraction["magnetic_node_indices"],
        supercell_m_values_name,
    )
    unit_field_cell_count = h_demag_cell_count(args.unit_cell, state=unit_state)
    unit_h = h_demag_max_norm(args.unit_cell, state=unit_state)
    supercell_h = h_demag_max_norm_from_indices(
        args.supercell,
        extraction["field_cell_indices"],
        state=supercell_state,
    )
    unit_deviation = vector_deviation_stats(
        unit_m_values,
        unit_magnetic_indices,
        unit_average_m,
        f"unit-cell {unit_m_values_name}",
    )
    central_deviation = vector_deviation_stats(
        supercell_m_values,
        extraction["magnetic_node_indices"],
        unit_average_m,
        f"supercell central-cell {supercell_m_values_name}",
    )
    relaxation_state = {
        "unit_average_m": unit_average_m,
        "central_cell_average_m": supercell_average_m,
        "central_cell_average_m_l2_delta": l2_delta(supercell_average_m, unit_average_m),
        "unit_mean_l2_deviation_from_unit_average_m": unit_deviation["mean_l2"],
        "unit_max_l2_deviation_from_unit_average_m": unit_deviation["max_l2"],
        "central_cell_mean_l2_deviation_from_unit_average_m": central_deviation["mean_l2"],
        "central_cell_max_l2_deviation_from_unit_average_m": central_deviation["max_l2"],
        "mean_l2_deviation_relative_error": relative_error(
            central_deviation["mean_l2"],
            unit_deviation["mean_l2"],
        ),
    }
    mapped_comparison = mapped_central_cell_comparability(
        args.unit_cell,
        args.supercell,
        extraction=extraction,
        workload=workload,
        unit_m_values=unit_m_values,
        unit_magnetic_indices=unit_magnetic_indices,
        supercell_m_values=supercell_m_values,
        same_local_distance_limit_m=args.max_mapped_nearest_distance_m,
        unit_state=unit_state,
        supercell_state=supercell_state,
    )
    interpolated_comparison = None
    if args.include_interpolated_comparison or args.accept_interpolated_comparison:
        interpolated_comparison = interpolated_central_cell_comparability(
            args.unit_cell,
            args.supercell,
            extraction=extraction,
            workload=workload,
            unit_m_values=unit_m_values,
            supercell_m_values=supercell_m_values,
            barycentric_tolerance=args.interpolation_barycentric_tolerance,
            unit_state=unit_state,
            supercell_state=supercell_state,
        )
    mesh_comparability = {
        "unit_magnetic_node_count": len(unit_magnetic_indices),
        "central_cell_magnetic_node_count": int(extraction["magnetic_node_count"]),
        "magnetic_node_count_relative_error": relative_error(
            float(extraction["magnetic_node_count"]),
            float(len(unit_magnetic_indices)),
        ),
        "unit_field_cell_count": unit_field_cell_count,
        "central_cell_field_cell_count": int(extraction["field_cell_count"]),
        "field_cell_count_relative_error": relative_error(
            float(extraction["field_cell_count"]),
            float(unit_field_cell_count),
        ),
    }
    metrics = {
        "average_m_l2_delta": relaxation_state["central_cell_average_m_l2_delta"],
        "h_demag_stats_relative_error": relative_error(supercell_h, unit_h),
        "demag_phi_max_abs_delta_A": abs(
            demag_phi_range_from_indices(args.supercell, extraction["field_cell_indices"], state=supercell_state)
            - demag_phi_range(args.unit_cell, state=unit_state)
        ),
        "relaxation_state_mean_deviation_relative_error": relaxation_state["mean_l2_deviation_relative_error"],
        "mapped_m_p99_l2_delta": mapped_comparison["m"]["p99_l2_delta"],
        "mapped_h_demag_p99_relative_error": mapped_comparison["H_demag"]["p99_relative_error"],
        "mapped_demag_phi_max_abs_delta_after_offset_A": mapped_comparison["demag_phi"][
            "max_abs_delta_after_offset_A"
        ],
        "mapped_max_nearest_field_node_distance_m": mapped_comparison["max_nearest_field_node_distance_m"],
        "mapped_max_nearest_magnetic_node_distance_m": mapped_comparison[
            "max_nearest_magnetic_node_distance_m"
        ],
        "magnetic_node_count_relative_error": mesh_comparability["magnetic_node_count_relative_error"],
        "field_cell_count_relative_error": mesh_comparability["field_cell_count_relative_error"],
    }
    acceptance_basis = "same_local_mapped"
    limits = {
        "average_m_l2_delta": args.max_average_m_l2_delta,
        "h_demag_stats_relative_error": args.max_h_demag_stats_relative_error,
        "demag_phi_max_abs_delta_A": args.max_demag_phi_max_abs_delta_a,
        "relaxation_state_mean_deviation_relative_error": args.max_relaxation_state_mean_deviation_relative_error,
        "mapped_m_p99_l2_delta": args.max_mapped_m_p99_l2_delta,
        "mapped_h_demag_p99_relative_error": args.max_mapped_h_demag_p99_relative_error,
        "mapped_demag_phi_max_abs_delta_after_offset_A": args.max_mapped_demag_phi_max_abs_delta_after_offset_a,
        "mapped_max_nearest_field_node_distance_m": args.max_mapped_nearest_distance_m,
        "mapped_max_nearest_magnetic_node_distance_m": args.max_mapped_nearest_distance_m,
    }
    if args.accept_interpolated_comparison:
        require(interpolated_comparison is not None, "interpolated acceptance requires interpolated comparison")
        acceptance_basis = "interpolated_remesh"
        metrics.update(
            {
                "interpolated_field_missed_count": float(interpolated_comparison["field_missed_count"]),
                "interpolated_magnetic_missed_count": float(interpolated_comparison["magnetic_missed_count"]),
                "interpolated_m_p99_l2_delta": interpolated_comparison["m"]["p99_l2_delta"],
                "interpolated_h_demag_p99_relative_error": interpolated_comparison["H_demag"][
                    "p99_relative_error"
                ],
                "interpolated_demag_phi_max_abs_delta_after_offset_A": interpolated_comparison["demag_phi"][
                    "max_abs_delta_after_offset_A"
                ],
            }
        )
        limits = {
            "interpolated_field_missed_count": 0.0,
            "interpolated_magnetic_missed_count": 0.0,
            "interpolated_m_p99_l2_delta": args.max_interpolated_m_p99_l2_delta,
            "interpolated_h_demag_p99_relative_error": args.max_interpolated_h_demag_p99_relative_error,
            "interpolated_demag_phi_max_abs_delta_after_offset_A": (
                args.max_interpolated_demag_phi_max_abs_delta_after_offset_a
            ),
        }
    if unit_state == STATE_FINAL and supercell_state == STATE_FINAL:
        unit_e = final_e_demag(args.unit_cell)
        supercell_e_density = float(extraction["central_cell_demag_energy_j"])
        metrics["e_demag_density_relative_error"] = relative_error(supercell_e_density, unit_e)
        metrics["central_cell_torque_residual_relative_error"] = relative_error(
            float(extraction["central_cell_torque_apm"]),
            final_torque(args.unit_cell),
        )
        limits["e_demag_density_relative_error"] = args.max_e_demag_density_relative_error
        limits["central_cell_torque_residual_relative_error"] = args.max_central_cell_torque_residual_relative_error
    status, failures = status_from_limits(metrics, limits)
    report = {
        "schema_version": "fem_static_pbc_supercell_validation.v1",
        "status": status,
        "comparison_state": comparison_state,
        "unit_comparison_state": unit_state,
        "supercell_comparison_state": supercell_state,
        "comparison_contract": supercell_comparison_contract(
            unit_state=unit_state,
            supercell_state=supercell_state,
        ),
        "artifact_provenance": provenance,
        "unit_cell_artifacts": str(args.unit_cell),
        "supercell_artifacts": str(args.supercell),
        "repeat_x": args.repeat_x,
        "repeat_y": args.repeat_y,
        "cell_count": cell_count,
        "acceptance_basis": acceptance_basis,
        "central_cell_extraction": {
            key: value
            for key, value in extraction.items()
            if key not in {"magnetic_node_indices", "field_cell_indices"}
        },
        "mesh_comparability": mesh_comparability,
        "relaxation_state_comparability": relaxation_state,
        "mapped_central_cell_comparability": mapped_comparison,
        "metrics": metrics,
        "workload": workload,
        "thresholds": limits,
        "failure_reasons": failures,
    }
    if interpolated_comparison is not None:
        report["interpolated_central_cell_comparability"] = interpolated_comparison
    override = initial_magnetization_state_override(args.supercell)
    if override is not None:
        report["supercell_initial_magnetization_state_override"] = override
    return report


def add_common_report_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--report", type=Path, required=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-failed-status",
        action="store_true",
        help=(
            "Write a failed comparison report with exit status 0 when artifacts are valid "
            "but threshold metrics fail. Invalid or incompatible artifacts still fail."
        ),
    )
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
    supercell.add_argument(
        "--state",
        choices=[STATE_FINAL, STATE_INITIAL],
        default=STATE_FINAL,
        help=(
            "Field/magnetization state to compare. 'final' uses m_final and the last field snapshot; "
            "'initial' uses m_initial and the first field snapshot and does not gate final energy/torque."
        ),
    )
    supercell.add_argument(
        "--unit-state",
        choices=[STATE_FINAL, STATE_INITIAL],
        default=None,
        help="Override the primitive unit-cell state used as the comparison reference.",
    )
    supercell.add_argument(
        "--supercell-state",
        choices=[STATE_FINAL, STATE_INITIAL],
        default=None,
        help="Override the repeated supercell state used as the comparison sample.",
    )
    supercell.add_argument("--max-average-m-l2-delta", type=float, default=DEFAULT_MAX_AVERAGE_M_L2_DELTA)
    supercell.add_argument("--max-e-demag-density-relative-error", type=float, default=DEFAULT_MAX_E_DEMAG_RELERR)
    supercell.add_argument("--max-h-demag-stats-relative-error", type=float, default=DEFAULT_MAX_E_DEMAG_RELERR)
    supercell.add_argument("--max-demag-phi-max-abs-delta-a", type=float, default=DEFAULT_MAX_SUPERCELL_DEMAG_PHI_DELTA_A)
    supercell.add_argument(
        "--max-central-cell-torque-residual-relative-error",
        type=float,
        default=DEFAULT_MAX_TORQUE_RELERR,
    )
    supercell.add_argument(
        "--max-relaxation-state-mean-deviation-relative-error",
        type=float,
        default=DEFAULT_MAX_RELAXATION_STATE_MEAN_DEVIATION_RELERR,
    )
    supercell.add_argument("--max-mapped-m-p99-l2-delta", type=float, default=DEFAULT_MAX_MAPPED_M_P99_L2_DELTA)
    supercell.add_argument(
        "--max-mapped-h-demag-p99-relative-error",
        type=float,
        default=DEFAULT_MAX_MAPPED_H_DEMAG_P99_RELERR,
    )
    supercell.add_argument(
        "--max-mapped-demag-phi-max-abs-delta-after-offset-a",
        type=float,
        default=DEFAULT_MAX_MAPPED_DEMAG_PHI_DELTA_A,
    )
    supercell.add_argument(
        "--max-mapped-nearest-distance-m",
        type=float,
        default=DEFAULT_MAX_MAPPED_SUPERCELL_NEAREST_DISTANCE_M,
    )
    supercell.add_argument(
        "--include-interpolated-comparison",
        action="store_true",
        help=(
            "Add a diagnostic primitive-tetrahedron interpolation comparison for independently remeshed "
            "supercell central cells. This does not replace the strict same-local nearest-node gate."
        ),
    )
    supercell.add_argument(
        "--accept-interpolated-comparison",
        action="store_true",
        help=(
            "Use the primitive-tetrahedron interpolated central-cell comparison as the report acceptance basis. "
            "This explicit independently-remeshed supercell gate does not change the default strict same-local "
            "nearest-node gate."
        ),
    )
    supercell.add_argument(
        "--max-interpolated-m-p99-l2-delta",
        type=float,
        default=DEFAULT_MAX_INTERPOLATED_M_P99_L2_DELTA,
    )
    supercell.add_argument(
        "--max-interpolated-h-demag-p99-relative-error",
        type=float,
        default=DEFAULT_MAX_INTERPOLATED_H_DEMAG_P99_RELERR,
    )
    supercell.add_argument(
        "--max-interpolated-demag-phi-max-abs-delta-after-offset-a",
        type=float,
        default=DEFAULT_MAX_INTERPOLATED_DEMAG_PHI_DELTA_A,
    )
    supercell.add_argument(
        "--interpolation-barycentric-tolerance",
        type=float,
        default=DEFAULT_INTERPOLATION_BARYCENTRIC_TOL,
    )
    add_common_report_arg(supercell)

    args = parser.parse_args()
    for name, value in vars(args).items():
        if name.startswith("max_"):
            require(math.isfinite(value) and value >= 0.0, f"--{name.replace('_', '-')} must be non-negative")
    if args.command == "supercell":
        require(args.repeat_x > 0 and args.repeat_y > 0, "--repeat-x and --repeat-y must be positive")
        require(args.repeat_x * args.repeat_y > 1, "supercell comparison requires more than one repeated cell")
        require(
            math.isfinite(args.interpolation_barycentric_tolerance)
            and args.interpolation_barycentric_tolerance >= 0.0,
            "--interpolation-barycentric-tolerance must be non-negative",
        )
    return args


def main() -> int:
    try:
        args = parse_args()
        report = compare_z_padding(args) if args.command == "z-padding" else compare_supercell(args)
        write_report(args.report, report)
        if report["status"] != "ok":
            print("\n".join(report["failure_reasons"]), file=sys.stderr)
            if args.allow_failed_status:
                return 0
            return 1
        return 0
    except Exception as exc:
        print(f"invalid FEM static PBC comparison artifacts: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
