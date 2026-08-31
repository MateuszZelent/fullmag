#!/usr/bin/env python3
"""Fail-closed readiness check for a completed FEM SP4 relaxation bundle."""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path


TORQUE_LIMIT_T = 1e-5
ENERGY_RELATIVE_BUDGET = 1e-10
MUMAX3_SP4_PROFILE = "mumax3_sp4_v1"
MUMAX3_SP4_REFERENCE_PATH = (
    Path(__file__).resolve().parents[1]
    / "tests/standard_problems/mumag/sp4/fem/mumax3_compatibility_reference.v1.json"
)


def _qualification(
    metadata: dict[str, object],
    expected_device: str | None,
) -> dict[str, object] | None:
    if expected_device is not None:
        value = metadata.get(f"fem_{expected_device}_relaxation_qualification")
        return value if isinstance(value, dict) else None
    for key in (
        "fem_gpu_relaxation_qualification",
        "fem_cpu_relaxation_qualification",
    ):
        value = metadata.get(key)
        if isinstance(value, dict):
            return value
    return None


def _finite_float(value: object) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("non-finite numeric value")
    return result


def _scalar_tail_is_ready(path: Path) -> bool:
    with path.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        required = {"E_total", "max_torque_T"}
        if not required.issubset(reader.fieldnames or ()):
            return False
        rows = list(reader)
    if len(rows) < 2:
        return False
    energies = [_finite_float(row["E_total"]) for row in rows]
    torques = [_finite_float(row["max_torque_T"]) for row in rows]
    tail = energies[-min(10, len(energies)) :]
    scale = max(max(abs(value) for value in tail), 1e-30)
    budget = ENERGY_RELATIVE_BUDGET * scale
    if any(right - left > budget for left, right in zip(tail, tail[1:])):
        return False
    if tail[-1] - tail[0] > budget:
        return False
    return 0.0 <= torques[-1] <= TORQUE_LIMIT_T


def _field_is_finite(path: Path) -> bool:
    field = json.loads(path.read_text(encoding="utf-8"))
    values = field.get("values") if isinstance(field, dict) else None
    if not isinstance(values, list) or not values:
        return False
    for vector in values:
        if not isinstance(vector, list) or len(vector) != 3:
            return False
        if not all(math.isfinite(float(component)) for component in vector):
            return False
    return True


def _relative_error(actual: float, expected: float) -> float:
    return abs(actual - expected) / abs(expected)


def _close_vector(actual: object, expected: object, *, absolute: float) -> bool:
    if not isinstance(actual, list) or not isinstance(expected, list):
        return False
    if len(actual) != 3 or len(expected) != 3:
        return False
    return all(
        abs(_finite_float(left) - _finite_float(right)) <= absolute
        for left, right in zip(actual, expected)
    )


def _mumax3_sp4_profile_is_ready(
    metadata: dict[str, object],
    scalars_path: Path,
) -> bool:
    reference = json.loads(MUMAX3_SP4_REFERENCE_PATH.read_text(encoding="utf-8"))
    if not isinstance(reference, dict):
        return False
    if reference.get("schema_version") != (
        "fullmag.mumag.sp4.mumax3-compatibility-reference.v1"
    ) or reference.get("profile") != MUMAX3_SP4_PROFILE:
        return False

    problem_meta = metadata.get("problem_meta")
    if not isinstance(problem_meta, dict):
        return False
    runtime_metadata = problem_meta.get("runtime_metadata")
    if not isinstance(runtime_metadata, dict):
        return False
    contract = runtime_metadata.get("fem_demag_accuracy_contract")
    if contract != {
        "schema_version": "fullmag.fem.demag_accuracy.v1",
        "profile": MUMAX3_SP4_PROFILE,
        "required_potential_order": 2,
        "required_topology": "all_tet",
    }:
        return False

    required = reference.get("required_configuration")
    if not isinstance(required, dict):
        return False
    universe = runtime_metadata.get("study_universe")
    if not isinstance(universe, dict) or not _close_vector(
        universe.get("size"),
        required.get("airbox_dimensions_m"),
        absolute=1e-18,
    ):
        return False
    mesh_workflow = runtime_metadata.get("mesh_workflow")
    if not isinstance(mesh_workflow, dict):
        return False
    per_geometry = mesh_workflow.get("per_geometry")
    if not isinstance(per_geometry, list) or not per_geometry:
        return False
    maximum_hmax = _finite_float(required["maximum_magnetic_hmax_m"])
    for entry in per_geometry:
        if not isinstance(entry, dict):
            return False
        hmax = entry.get("hmax", entry.get("maximum_element_size"))
        if hmax is None or _finite_float(hmax) > maximum_hmax:
            return False

    provenance = metadata.get("execution_provenance")
    mesh = metadata.get("mesh")
    if not isinstance(provenance, dict) or not isinstance(mesh, dict):
        return False
    if provenance.get("resolved_demag_realization") != "fem_poisson_robin":
        return False
    poisson = provenance.get("fem_poisson_demag")
    if not isinstance(poisson, dict):
        return False
    potential_order = int(poisson.get("potential_order", 0))
    potential_dofs = int(poisson.get("potential_true_dof_count", 0))
    node_count = int(mesh.get("node_count", 0))
    if potential_order != int(required["potential_order"]):
        return False
    if node_count <= 0 or potential_dofs <= node_count:
        return False
    if int(mesh.get("periodic_node_pair_count", 0)) != 0:
        return False

    with scalars_path.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        required_columns = {
            "step",
            "mx",
            "my",
            "mz",
            "E_ex",
            "E_demag",
            "E_total",
        }
        if not required_columns.issubset(reader.fieldnames or ()):
            return False
        rows = list(reader)
    if len(rows) < 2 or int(rows[0]["step"]) != 0:
        return False

    oracle = reference.get("fdm_reference")
    limits = reference.get("acceptance_limits")
    if not isinstance(oracle, dict) or not isinstance(limits, dict):
        return False
    initial_demag = _finite_float(rows[0]["E_demag"])
    if _relative_error(
        initial_demag,
        _finite_float(oracle["initial_uniform_demag_energy_j"]),
    ) > _finite_float(limits["initial_demag_relative"]):
        return False

    final = rows[-1]
    final_average = [_finite_float(final[name]) for name in ("mx", "my", "mz")]
    reference_average = [
        _finite_float(value) for value in oracle["final_average_m"]
    ]
    component_limit = _finite_float(
        limits["final_average_component_absolute"]
    )
    if any(
        abs(actual - expected) > component_limit
        for actual, expected in zip(final_average, reference_average)
    ):
        return False
    vector_rms = math.sqrt(
        sum(
            (actual - expected) ** 2
            for actual, expected in zip(final_average, reference_average)
        )
        / 3.0
    )
    if vector_rms > _finite_float(limits["final_average_vector_rms"]):
        return False
    for column, oracle_key, limit_key in (
        ("E_ex", "final_exchange_energy_j", "final_exchange_relative"),
        ("E_demag", "final_demag_energy_j", "final_demag_relative"),
        ("E_total", "final_total_energy_j", "final_total_relative"),
    ):
        if _relative_error(
            _finite_float(final[column]),
            _finite_float(oracle[oracle_key]),
        ) > _finite_float(limits[limit_key]):
            return False
    return True


def relaxation_is_ready(
    artifacts: Path,
    *,
    expected_algorithm: str | None = None,
    expected_device: str | None = None,
    expected_compatibility_profile: str | None = None,
) -> bool:
    try:
        if expected_device not in {None, "cpu", "gpu"}:
            return False
        metadata = json.loads(
            (artifacts / "metadata.json").read_text(encoding="utf-8")
        )
        if not isinstance(metadata, dict):
            return False
        qualification = _qualification(metadata, expected_device)
        if qualification is None:
            return False
        final_torque_t = _finite_float(qualification["final_torque_t"])
        stop_value = _finite_float(qualification["stop_metric_value"])
        stop_threshold = _finite_float(qualification["stop_threshold"])
        executed_steps = int(qualification["executed_steps"])
        algorithm = qualification.get("relaxation_algorithm")
        ready = (
            qualification.get("converged") is True
            and isinstance(algorithm, str)
            and bool(algorithm)
            and (expected_algorithm is None or algorithm == expected_algorithm)
            and isinstance(qualification.get("stop_reason"), str)
            and bool(qualification["stop_reason"])
            and isinstance(qualification.get("stop_metric_name"), str)
            and bool(qualification["stop_metric_name"])
            and stop_value >= 0.0
            and stop_threshold > 0.0
            and executed_steps > 0
            and 0.0 <= final_torque_t <= TORQUE_LIMIT_T
            and _scalar_tail_is_ready(artifacts / "scalars.csv")
            and _field_is_finite(artifacts / "m_final.json")
        )
        if not ready:
            return False
        if expected_compatibility_profile is None:
            return True
        if expected_compatibility_profile != MUMAX3_SP4_PROFILE:
            return False
        return _mumax3_sp4_profile_is_ready(
            metadata,
            artifacts / "scalars.csv",
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument(
        "--expected-algorithm",
        choices=("llg_overdamped", "projected_gradient_bb", "nonlinear_cg"),
    )
    parser.add_argument("--expected-device", choices=("cpu", "gpu"))
    parser.add_argument(
        "--expected-compatibility-profile",
        choices=(MUMAX3_SP4_PROFILE,),
    )
    args = parser.parse_args()
    return 0 if relaxation_is_ready(
        args.artifacts,
        expected_algorithm=args.expected_algorithm,
        expected_device=args.expected_device,
        expected_compatibility_profile=args.expected_compatibility_profile,
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
