#!/usr/bin/env python3
"""Qualify a default relaxation torque tolerance from FEM CPU/GPU sweeps."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import struct
import zlib
from collections import defaultdict
from collections.abc import Mapping, Sequence
from pathlib import Path


MU0 = 4.0 * math.pi * 1.0e-7
DEFAULT_PHYSICAL_CAP_T = 1.0e-4
DEFAULT_SAFETY_FACTOR = 2.0
MAX_LAST_BUDGET_CHANGE = 0.10
MAX_FINAL_TO_INITIAL_RATIO = 0.25
MAX_CPU_GPU_SPREAD = 0.10
CALIBRATION_SCHEMA_V2 = "fullmag.relaxation_torque_calibration.v2"
CALIBRATION_SUITE_SCHEMA_V2 = "fullmag.relaxation_torque_calibration_suite.v2"
CALIBRATION_ALGORITHMS_V2 = (
    "projected_gradient_bb",
    "nonlinear_cg",
    "llg_overdamped",
)
CALIBRATION_BACKENDS_V2 = ("fem_cpu", "fem_gpu")
CALIBRATION_REQUIRED_SCENARIOS_V2 = {
    "exchange_only",
    "exchange_demag",
    "exchange_demag_uniaxial",
    "box500_airbox_exchange_demag_multidomain",
}
CALIBRATION_STOP_REASONS_V2 = {
    "max_steps",
    "torque",
    "torque_tolerance",
    "converged",
    "residual_tolerance",
}
MAX_LAST_ENERGY_CHANGE_V2 = 0.10
MAX_FINAL_NORM_DEFECT_V2 = 1.0e-6


def finite_float(row: Mapping[str, object], field: str) -> float | None:
    try:
        value = float(row.get(field, ""))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def positive_int(row: Mapping[str, object], field: str) -> int | None:
    try:
        value = int(row.get(field, ""))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def case_key(row: Mapping[str, object]) -> tuple[str, ...]:
    return (
        str(row.get("solver_mesh_signature") or ""),
        str(row.get("scenario") or ""),
        str(row.get("integrator") or ""),
        str(row.get("timestep_policy") or ""),
        str(row.get("demag_model") or "none"),
    )


def calibration_case_key(row: Mapping[str, object]) -> tuple[str, ...]:
    """Return the v2 identity of one algorithm/physics/mesh trajectory.

    Repeat index and step budget deliberately do not participate in the key:
    they are observations of the same case, not a different physical case.
    """

    algorithm = str(row.get("algorithm") or row.get("relaxation_algorithm") or "")
    return (
        algorithm,
        str(row.get("scenario") or ""),
        str(row.get("initial_state_identity") or ""),
        str(row.get("solver_mesh_signature") or ""),
        str(row.get("integrator") or ""),
        str(row.get("timestep_policy") or ""),
        str(row.get("demag_model") or "none"),
    )


def _as_int(value: object) -> int | None:
    try:
        parsed = int(str(value))
    except (TypeError, ValueError):
        return None
    return parsed


def _as_nonempty(value: object) -> str:
    return str(value or "").strip()


def _row_source_snapshot(row: Mapping[str, object]) -> str:
    """Read the canonical source snapshot from benchmark or synthetic rows."""

    return _as_nonempty(
        row.get("source_snapshot_sha256")
        or row.get("runtime_source_snapshot_sha256")
    )


def _row_problem_ir(row: Mapping[str, object]) -> str:
    """Read the executed ProblemIR identity emitted by the benchmark."""

    return _as_nonempty(
        row.get("problem_ir_sha256")
        or row.get("executed_problem_ir_sha256")
    )


def _is_sha256(value: str) -> bool:
    return re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _suite_meshes(suite: Mapping[str, object]) -> dict[str, str]:
    meshes = suite.get("meshes")
    if not isinstance(meshes, Sequence) or isinstance(meshes, (str, bytes)):
        return {}
    result: dict[str, str] = {}
    for item in meshes:
        if not isinstance(item, Mapping):
            continue
        signature = _as_nonempty(item.get("solver_mesh_signature"))
        mesh_id = _as_nonempty(item.get("id"))
        if signature:
            result[signature] = mesh_id
    return result


def _suite_mesh_problem_hashes(suite: Mapping[str, object]) -> dict[str, str]:
    meshes = suite.get("meshes")
    if not isinstance(meshes, Sequence) or isinstance(meshes, (str, bytes)):
        return {}
    result: dict[str, str] = {}
    for item in meshes:
        if not isinstance(item, Mapping):
            continue
        signature = _as_nonempty(item.get("solver_mesh_signature"))
        problem_hash = _as_nonempty(item.get("problem_ir_sha256"))
        if signature and problem_hash:
            result[signature] = problem_hash
    return result


def _suite_scenarios(suite: Mapping[str, object]) -> dict[str, str]:
    scenarios = suite.get("scenarios")
    if not isinstance(scenarios, Sequence) or isinstance(scenarios, (str, bytes)):
        return {}
    result: dict[str, str] = {}
    for item in scenarios:
        if not isinstance(item, Mapping):
            continue
        scenario_id = _as_nonempty(item.get("id"))
        initial_state = _as_nonempty(item.get("initial_state_identity"))
        if scenario_id:
            result[scenario_id] = initial_state
    return result


def _scenario_class(scenario: str) -> str:
    normalized = scenario.strip().lower()
    if "multidomain" in normalized:
        return "box500_airbox_exchange_demag_multidomain"
    if "demag" in normalized and ("anis_uniaxial" in normalized or "uniaxial" in normalized):
        return "exchange_demag_uniaxial"
    if "demag" in normalized:
        return "exchange_demag"
    if "exchange_only" in normalized:
        return "exchange_only"
    return normalized


def validate_calibration_suite(
    suite: Mapping[str, object],
    rows: Sequence[Mapping[str, object]],
    *,
    allow_incomplete_matrix: bool = False,
) -> list[str]:
    """Validate the immutable v2 matrix before any recommendation is made."""

    failures: list[str] = []
    if suite.get("schema") != CALIBRATION_SUITE_SCHEMA_V2:
        failures.append("calibration suite must use schema v2")

    runtime_manifest = _as_nonempty(suite.get("runtime_manifest_sha256"))
    source_snapshot = _as_nonempty(suite.get("source_snapshot_sha256"))
    problem_ir = _as_nonempty(suite.get("problem_ir_sha256"))
    if not runtime_manifest:
        failures.append("calibration suite is missing runtime_manifest_sha256")
    if not source_snapshot:
        failures.append("calibration suite is missing source_snapshot_sha256")
    if not problem_ir:
        failures.append("calibration suite is missing problem_ir_sha256")

    algorithms = {
        _as_nonempty(value) for value in suite.get("algorithms", [])
    }
    missing_algorithms = set(CALIBRATION_ALGORITHMS_V2) - algorithms
    if missing_algorithms and not allow_incomplete_matrix:
        failures.append(
            "calibration matrix is missing algorithms: "
            + ", ".join(sorted(missing_algorithms))
        )

    mesh_signatures = set(_suite_meshes(suite))
    if len(mesh_signatures) < 3 and not allow_incomplete_matrix:
        failures.append("calibration requires at least three typed solver meshes")

    scenario_initial_states = _suite_scenarios(suite)
    scenario_classes = {_scenario_class(value) for value in scenario_initial_states}
    missing_scenarios = CALIBRATION_REQUIRED_SCENARIOS_V2 - scenario_classes
    if missing_scenarios and not allow_incomplete_matrix:
        failures.append(
            "calibration matrix is missing scenarios: "
            + ", ".join(sorted(missing_scenarios))
        )
    if (
        not scenario_initial_states.get("box500_airbox_exchange_demag_multidomain")
        and not allow_incomplete_matrix
    ):
        failures.append("multidomain scenario requires an explicit initial-state identity")

    backends = {_as_nonempty(value) for value in suite.get("backends", [])}
    missing_backends = set(CALIBRATION_BACKENDS_V2) - backends
    if missing_backends and not allow_incomplete_matrix:
        failures.append(
            "calibration requires CPU and GPU backends: "
            + ", ".join(sorted(missing_backends))
        )

    repeats = _as_int(suite.get("repeats"))
    if (repeats is None or repeats < 3) and not allow_incomplete_matrix:
        failures.append("calibration requires at least three repeats")
    budgets = sorted(
        {
            parsed
            for value in suite.get("step_budgets", [])
            if (parsed := _as_int(value)) is not None and parsed > 0
        }
    )
    if (len(budgets) < 3 or budgets != sorted(set(budgets))) and not allow_incomplete_matrix:
        failures.append("calibration requires at least three increasing step budgets")

    llg_policies = {
        _as_nonempty(value) for value in suite.get("llg_timestep_policies", [])
    }
    if not {"fixed", "adaptive"}.issubset(llg_policies) and not allow_incomplete_matrix:
        failures.append("LLG calibration requires fixed and adaptive timestep policies")

    expected_algorithms = set(CALIBRATION_ALGORITHMS_V2)
    expected_meshes = mesh_signatures
    mesh_problem_hashes = _suite_mesh_problem_hashes(suite)
    expected_scenarios = set(scenario_initial_states)
    expected_backends = set(CALIBRATION_BACKENDS_V2)
    expected_repeats = set(range(repeats or 0))
    row_groups: dict[tuple[str, ...], set[int]] = defaultdict(set)
    for index, row in enumerate(rows):
        algorithm = _as_nonempty(row.get("algorithm") or row.get("relaxation_algorithm"))
        scenario = _as_nonempty(row.get("scenario"))
        mesh = _as_nonempty(row.get("solver_mesh_signature"))
        backend = _as_nonempty(row.get("backend"))
        repeat = _as_int(row.get("repeat_index"))
        steps = _as_int(row.get("step_budget") or row.get("steps"))
        if algorithm not in expected_algorithms:
            failures.append(f"row {index} has unknown algorithm {algorithm!r}")
        if scenario not in expected_scenarios:
            failures.append(f"row {index} has unknown scenario {scenario!r}")
        if mesh not in expected_meshes:
            failures.append(f"row {index} has unknown solver mesh signature {mesh!r}")
        if backend not in expected_backends:
            failures.append(f"row {index} has unknown backend {backend!r}")
        if repeat not in expected_repeats:
            failures.append(f"row {index} has invalid repeat_index {repeat!r}")
        if steps not in budgets:
            failures.append(f"row {index} has an unlisted step budget {steps!r}")
        if _as_nonempty(row.get("runtime_manifest_sha256")) != runtime_manifest:
            failures.append(f"row {index} does not match suite runtime_manifest_sha256")
        if _row_source_snapshot(row) != source_snapshot:
            failures.append(f"row {index} does not match suite source_snapshot_sha256")
        row_problem_ir = _row_problem_ir(row)
        if not _is_sha256(row_problem_ir):
            failures.append(
                f"row {index} is missing a canonical executed ProblemIR SHA-256"
            )
        expected_initial_state = scenario_initial_states.get(scenario, "")
        if _as_nonempty(row.get("initial_state_identity")) != expected_initial_state:
            failures.append(f"row {index} does not match scenario initial-state identity")
        status = _as_nonempty(row.get("status"))
        stop_reason = _as_nonempty(row.get("stop_reason"))
        if status != "ok":
            failures.append(f"row {index} does not have status=ok")
        if stop_reason.lower() in {"timeout", "timed_out", "case_timeout", "error"}:
            failures.append(f"row {index} ended by undocumented timeout/error")
        elif stop_reason not in CALIBRATION_STOP_REASONS_V2:
            failures.append(f"row {index} has undocumented stop_reason {stop_reason!r}")
        if (
            finite_float(row, "final_torque_apm") is None
            or finite_float(row, "final_e_total_j") is None
            or finite_float(row, "norm_defect") is None
        ):
            failures.append(f"row {index} is missing finite plateau observables")
        if repeat is not None and steps is not None:
            group_key = (
                algorithm,
                scenario,
                _as_nonempty(row.get("initial_state_identity")),
                mesh,
                backend,
                _as_nonempty(row.get("integrator")),
                _as_nonempty(row.get("timestep_policy")),
                str(repeat),
            )
            row_groups[group_key].add(steps)

    problem_identity_groups: dict[tuple[tuple[str, ...], int], set[str]] = defaultdict(set)
    for row in rows:
        steps = _as_int(row.get("step_budget") or row.get("steps"))
        problem_identity = _row_problem_ir(row)
        if steps is None or not problem_identity:
            continue
        problem_identity_groups[(calibration_case_key(row), steps)].add(problem_identity)
    for key, identities in sorted(problem_identity_groups.items()):
        if len(identities) != 1:
            failures.append(
                f"case={key} has different executed ProblemIR identities across backends/repeats"
            )

    if not failures and not allow_incomplete_matrix:
        expected_budget_set = set(budgets)
        for key, observed in sorted(row_groups.items()):
            if observed != expected_budget_set:
                failures.append(
                    f"case={key} does not contain every step budget {budgets}"
                )
        llg_policy_count = len(llg_policies)
        expected_group_count = (
            len(expected_algorithms)
            * len(expected_scenarios)
            * len(expected_meshes)
            * len(expected_backends)
            * len(expected_repeats)
        )
        expected_group_count += (
            len(expected_scenarios)
            * len(expected_meshes)
            * len(expected_backends)
            * len(expected_repeats)
            * max(llg_policy_count - 1, 0)
        )
        if len(row_groups) != expected_group_count:
            failures.append(
                f"calibration matrix has {len(row_groups)} groups; expected {expected_group_count}"
            )

    return sorted(set(failures))


def _v2_group_quality(
    rows: Sequence[Mapping[str, object]],
    *,
    expected_budgets: Sequence[int],
) -> tuple[dict[str, object], list[float], list[str]]:
    failures: list[str] = []
    by_backend_repeat: dict[tuple[str, str], dict[int, Mapping[str, object]]] = {}
    for row in rows:
        backend = _as_nonempty(row.get("backend"))
        repeat = _as_int(row.get("repeat_index"))
        steps = _as_int(row.get("step_budget") or row.get("steps"))
        if repeat is None or steps is None:
            continue
        by_backend_repeat.setdefault((backend, str(repeat)), {})[steps] = row

    floors: list[float] = []
    final_torques: list[float] = []
    final_energies: list[float] = []
    final_norm_defects: list[float] = []
    for (backend, repeat), by_steps in sorted(by_backend_repeat.items()):
        if set(by_steps) != set(expected_budgets):
            failures.append(
                f"backend={backend},repeat={repeat} is missing one or more step budgets"
            )
            continue
        ordered = sorted(expected_budgets)
        initial, previous, final = (by_steps[step] for step in (ordered[0], ordered[-2], ordered[-1]))
        torques = [finite_float(by_steps[step], "final_torque_apm") for step in ordered]
        energies = [finite_float(by_steps[step], "final_e_total_j") for step in ordered]
        norm_defect = finite_float(final, "norm_defect")
        if any(value is None or value < 0.0 for value in torques):
            failures.append(f"backend={backend},repeat={repeat} has invalid torque")
            continue
        if any(value is None for value in energies):
            failures.append(f"backend={backend},repeat={repeat} has invalid energy")
            continue
        assert torques[-1] is not None
        assert torques[-2] is not None
        assert torques[0] is not None
        assert energies[-1] is not None
        assert energies[-2] is not None
        assert norm_defect is not None
        last_torque_change = relative_difference(torques[-2], torques[-1])
        last_energy_change = relative_difference(energies[-2], energies[-1])
        final_to_initial = torques[-1] / max(torques[0], 1.0e-300)
        stop_reason = _as_nonempty(final.get("stop_reason"))
        if last_torque_change > MAX_LAST_BUDGET_CHANGE:
            failures.append(
                f"backend={backend},repeat={repeat} torque is not plateaued ({last_torque_change:.6g})"
            )
        if last_energy_change > MAX_LAST_ENERGY_CHANGE_V2:
            failures.append(
                f"backend={backend},repeat={repeat} energy is not plateaued ({last_energy_change:.6g})"
            )
        if final_to_initial > MAX_FINAL_TO_INITIAL_RATIO:
            failures.append(
                f"backend={backend},repeat={repeat} torque did not relax ({final_to_initial:.6g})"
            )
        if norm_defect > MAX_FINAL_NORM_DEFECT_V2:
            failures.append(
                f"backend={backend},repeat={repeat} norm defect {norm_defect:.6g} exceeds {MAX_FINAL_NORM_DEFECT_V2:.6g}"
            )
        if stop_reason.lower() in {"timeout", "timed_out", "case_timeout", "error"}:
            failures.append(f"backend={backend},repeat={repeat} ended by timeout/error")
        elif stop_reason not in CALIBRATION_STOP_REASONS_V2:
            failures.append(
                f"backend={backend},repeat={repeat} has undocumented stop reason {stop_reason!r}"
            )
        final_torques.append(torques[-1])
        final_energies.append(energies[-1])
        final_norm_defects.append(norm_defect)
        floors.append(torques[-1])

    backends = sorted({backend for backend, _ in by_backend_repeat})
    repeats = sorted({repeat for _, repeat in by_backend_repeat})
    for repeat in repeats:
        cpu = by_backend_repeat.get(("fem_cpu", repeat), {}).get(max(expected_budgets))
        gpu = by_backend_repeat.get(("fem_gpu", repeat), {}).get(max(expected_budgets))
        if cpu is None or gpu is None:
            failures.append(f"repeat={repeat} requires matching FEM CPU and GPU rows")
            continue
        cpu_torque = finite_float(cpu, "final_torque_apm")
        gpu_torque = finite_float(gpu, "final_torque_apm")
        if cpu_torque is not None and gpu_torque is not None:
            spread = relative_difference(cpu_torque, gpu_torque)
            if spread > MAX_CPU_GPU_SPREAD:
                failures.append(
                    f"repeat={repeat} CPU/GPU torque spread {spread:.6g} exceeds {MAX_CPU_GPU_SPREAD:.6g}"
                )

    summary = {
        "step_budgets": list(expected_budgets),
        "backends": backends,
        "repeat_count": len(repeats),
        "final_torque_apm_min": min(final_torques) if final_torques else None,
        "final_torque_apm_max": max(final_torques) if final_torques else None,
        "final_energy_j_min": min(final_energies) if final_energies else None,
        "final_energy_j_max": max(final_energies) if final_energies else None,
        "final_norm_defect_max": max(final_norm_defects) if final_norm_defects else None,
        "qualified": not failures and bool(floors),
    }
    return summary, floors, failures


def analyze_rows_v2(
    rows: Sequence[Mapping[str, object]],
    *,
    suite: Mapping[str, object],
    physical_cap_t: float = DEFAULT_PHYSICAL_CAP_T,
    safety_factor: float = DEFAULT_SAFETY_FACTOR,
    allow_incomplete_matrix: bool = False,
) -> dict[str, object]:
    """Analyze the full v2 matrix and return an explicit qualification decision."""

    failures = validate_calibration_suite(
        suite, rows, allow_incomplete_matrix=allow_incomplete_matrix
    )
    expected_budgets = sorted(
        {
            parsed
            for value in suite.get("step_budgets", [])
            if (parsed := _as_int(value)) is not None and parsed > 0
        }
    )
    grouped: dict[tuple[str, ...], list[Mapping[str, object]]] = defaultdict(list)
    for row in rows:
        grouped[calibration_case_key(row)].append(row)

    algorithm_floors: dict[str, list[float]] = defaultdict(list)
    algorithm_cases: dict[str, list[dict[str, object]]] = defaultdict(list)
    for key, case_rows in sorted(grouped.items()):
        algorithm = key[0]
        summary, floors, case_failures = _v2_group_quality(
            case_rows, expected_budgets=expected_budgets
        )
        case_summary = {"case_key": list(key), **summary}
        algorithm_cases[algorithm].append(case_summary)
        algorithm_floors[algorithm].extend(floors)
        failures.extend(f"case={key} {failure}" for failure in case_failures)

    algorithm_recommendations: dict[str, float] = {}
    algorithm_decisions: dict[str, str] = {}
    physical_cap_apm = physical_cap_t / MU0
    for algorithm in CALIBRATION_ALGORITHMS_V2:
        floors = algorithm_floors.get(algorithm, [])
        cases = algorithm_cases.get(algorithm, [])
        if not floors or not cases or not all(case["qualified"] for case in cases):
            algorithm_decisions[algorithm] = "no_qualified_default"
            continue
        candidate = round_up_one_significant_digit(safety_factor * max(floors))
        algorithm_recommendations[algorithm] = candidate
        algorithm_decisions[algorithm] = (
            "qualified" if candidate <= physical_cap_apm else "physical_cap_exceeded"
        )

    if failures or set(algorithm_decisions.values()) != {"qualified"}:
        if not failures and algorithm_decisions and all(
            decision == "physical_cap_exceeded" for decision in algorithm_decisions.values()
        ):
            decision = "algorithm_specific_qualified"
        else:
            decision = "no_qualified_default"
    else:
        decision = "universal_qualified"

    universal_candidate = (
        max(algorithm_recommendations.values())
        if algorithm_recommendations
        else None
    )
    if decision == "universal_qualified" and universal_candidate is not None:
        recommended_apm: float | None = universal_candidate
        recommended_t = recommended_apm * MU0
    else:
        recommended_apm = None
        recommended_t = None

    published_algorithm_recommendations = (
        algorithm_recommendations
        if decision in {"universal_qualified", "algorithm_specific_qualified"}
        else {}
    )
    return {
        "schema": CALIBRATION_SCHEMA_V2,
        "decision": decision,
        "qualified": decision == "universal_qualified",
        "failures": sorted(set(failures)),
        "validation_failures": sorted(
            set(
                validate_calibration_suite(
                    suite, rows, allow_incomplete_matrix=allow_incomplete_matrix
                )
            )
        ),
        "matrix_scope": "partial" if allow_incomplete_matrix else "full",
        "case_count": len(grouped),
        "algorithm_decisions": algorithm_decisions,
        "algorithm_recommendations": published_algorithm_recommendations,
        "universal_candidate_torque_tolerance_apm": universal_candidate,
        "universal_candidate_torque_tolerance_t": universal_candidate * MU0
        if universal_candidate is not None
        else None,
        "recommended_torque_tolerance_apm": recommended_apm,
        "recommended_torque_tolerance_t": recommended_t,
        "physical_cap_t": physical_cap_t,
        "physical_cap_apm": physical_cap_apm,
        "safety_factor": safety_factor,
        "runtime_manifest_sha256": _as_nonempty(suite.get("runtime_manifest_sha256")),
        "source_snapshot_sha256": _as_nonempty(suite.get("source_snapshot_sha256")),
        "problem_ir_sha256": _as_nonempty(suite.get("problem_ir_sha256")),
        "algorithms": {
            algorithm: {
                "decision": algorithm_decisions.get(algorithm, "no_qualified_default"),
                "recommended_torque_tolerance_apm": published_algorithm_recommendations.get(
                    algorithm
                ),
                "cases": algorithm_cases.get(algorithm, []),
            }
            for algorithm in CALIBRATION_ALGORITHMS_V2
        },
    }


def round_up_one_significant_digit(value: float) -> float:
    exponent = math.floor(math.log10(value))
    scale = 10.0**exponent
    return math.ceil(value / scale) * scale


def relative_difference(left: float, right: float) -> float:
    return abs(left - right) / max(abs(left), abs(right), 1.0e-300)


def analyze_rows(
    rows: Sequence[Mapping[str, object]],
    *,
    physical_cap_t: float = DEFAULT_PHYSICAL_CAP_T,
    safety_factor: float = DEFAULT_SAFETY_FACTOR,
) -> dict[str, object]:
    failures: list[str] = []
    usable = [
        row
        for row in rows
        if row.get("status") == "ok"
        and row.get("relaxation_algorithm") == "llg_overdamped"
        and row.get("backend") in {"fem_cpu", "fem_gpu"}
    ]
    if not usable:
        return {
            "schema": "fullmag.relaxation-torque-calibration.v1",
            "qualified": False,
            "failures": ["no successful llg_overdamped FEM CPU/GPU rows"],
            "case_count": 0,
            "recommended_torque_tolerance_apm": None,
            "recommended_torque_tolerance_t": None,
        }

    meshes = {str(row.get("solver_mesh_signature") or "") for row in usable}
    policies = {str(row.get("timestep_policy") or "") for row in usable}
    scenarios = {str(row.get("scenario") or "") for row in usable}
    if "" in meshes or len(meshes) < 2:
        failures.append("calibration requires at least two stable solver mesh signatures")
    if not {"fixed", "adaptive"}.issubset(policies):
        failures.append("calibration requires fixed and adaptive timestep policies")
    if not any("exchange_only" in scenario for scenario in scenarios):
        failures.append("calibration requires an exchange-only scenario")
    if not any("demag" in scenario for scenario in scenarios):
        failures.append("calibration requires a production demag scenario")

    grouped: dict[tuple[str, ...], dict[str, dict[int, float]]] = defaultdict(
        lambda: defaultdict(dict)
    )
    for row in usable:
        backend = str(row["backend"])
        steps = positive_int(row, "steps")
        torque = finite_float(row, "final_torque_apm")
        if steps is None or torque is None or torque < 0.0:
            failures.append(f"case={case_key(row)} has invalid steps or final torque")
            continue
        grouped[case_key(row)][backend][steps] = torque

    qualified_floors: list[float] = []
    case_summaries: list[dict[str, object]] = []
    for key, by_backend in sorted(grouped.items()):
        if set(by_backend) != {"fem_cpu", "fem_gpu"}:
            failures.append(f"case={key} requires matching FEM CPU and GPU rows")
            continue
        common_steps = sorted(set(by_backend["fem_cpu"]) & set(by_backend["fem_gpu"]))
        if len(common_steps) < 3:
            failures.append(f"case={key} requires at least three common step budgets")
            continue

        first_steps, previous_steps, final_steps = common_steps[0], common_steps[-2], common_steps[-1]
        final_values = [by_backend[backend][final_steps] for backend in ("fem_cpu", "fem_gpu")]
        previous_values = [
            by_backend[backend][previous_steps] for backend in ("fem_cpu", "fem_gpu")
        ]
        initial_values = [by_backend[backend][first_steps] for backend in ("fem_cpu", "fem_gpu")]
        last_budget_change = max(
            relative_difference(previous, final)
            for previous, final in zip(previous_values, final_values)
        )
        final_to_initial = max(
            final / max(initial, 1.0e-300)
            for initial, final in zip(initial_values, final_values)
        )
        cpu_gpu_spread = relative_difference(final_values[0], final_values[1])

        case_failures: list[str] = []
        if last_budget_change > MAX_LAST_BUDGET_CHANGE:
            case_failures.append(
                f"not plateaued: last-budget torque change {last_budget_change:.6g} exceeds {MAX_LAST_BUDGET_CHANGE:.6g}"
            )
        if final_to_initial > MAX_FINAL_TO_INITIAL_RATIO:
            case_failures.append(
                f"insufficient relaxation: final/initial torque {final_to_initial:.6g} exceeds {MAX_FINAL_TO_INITIAL_RATIO:.6g}"
            )
        if cpu_gpu_spread > MAX_CPU_GPU_SPREAD:
            case_failures.append(
                f"CPU/GPU torque spread {cpu_gpu_spread:.6g} exceeds {MAX_CPU_GPU_SPREAD:.6g}"
            )
        if case_failures:
            failures.extend(f"case={key} {failure}" for failure in case_failures)
        else:
            qualified_floors.extend(final_values)
        case_summaries.append(
            {
                "case_key": list(key),
                "step_budgets": common_steps,
                "final_cpu_torque_apm": final_values[0],
                "final_gpu_torque_apm": final_values[1],
                "last_budget_change": last_budget_change,
                "final_to_initial_ratio": final_to_initial,
                "cpu_gpu_spread": cpu_gpu_spread,
                "qualified": not case_failures,
            }
        )

    recommendation_apm: float | None = None
    recommendation_t: float | None = None
    if qualified_floors and not failures:
        recommendation_apm = round_up_one_significant_digit(
            safety_factor * max(qualified_floors)
        )
        recommendation_t = recommendation_apm * MU0
        if recommendation_t > physical_cap_t:
            failures.append(
                f"recommended {recommendation_t:.6g} T exceeds physical cap {physical_cap_t:.6g} T"
            )

    qualified = bool(qualified_floors) and not failures
    return {
        "schema": "fullmag.relaxation-torque-calibration.v1",
        "qualified": qualified,
        "failures": failures,
        "case_count": len(grouped),
        "physical_cap_t": physical_cap_t,
        "safety_factor": safety_factor,
        "recommended_torque_tolerance_apm": recommendation_apm if qualified else None,
        "recommended_torque_tolerance_t": recommendation_t if qualified else None,
        "cases": case_summaries,
    }


def read_rows(paths: Sequence[Path]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for path in paths:
        with path.open(newline="", encoding="utf-8") as handle:
            rows.extend(csv.DictReader(handle))
    return rows


def write_plot(rows: Sequence[Mapping[str, object]], result: Mapping[str, object], path: Path) -> None:
    grouped: dict[tuple[str, str, str], list[tuple[int, float]]] = defaultdict(list)
    for row in rows:
        steps = positive_int(row, "steps")
        torque = finite_float(row, "final_torque_apm")
        if steps is None or torque is None or torque <= 0.0:
            continue
        label = (
            str(row.get("backend") or ""),
            str(row.get("scenario") or ""),
            str(row.get("solver_mesh_signature") or "")[:8],
        )
        grouped[label].append((steps, torque))
    all_values = [value for values in grouped.values() for value in values]
    if not all_values:
        raise ValueError("cannot plot calibration without positive torque samples")
    recommendation = result.get("recommended_torque_tolerance_apm")
    width, height = 1200, 720
    left, right, top, bottom = 90, 35, 35, 75
    pixels = bytearray([255] * (width * height * 3))

    def set_pixel(x: int, y: int, color: tuple[int, int, int]) -> None:
        if 0 <= x < width and 0 <= y < height:
            offset = (y * width + x) * 3
            pixels[offset : offset + 3] = bytes(color)

    def line(x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int]) -> None:
        dx, sx = abs(x1 - x0), 1 if x0 < x1 else -1
        dy, sy = -abs(y1 - y0), 1 if y0 < y1 else -1
        error = dx + dy
        while True:
            set_pixel(x0, y0, color)
            if x0 == x1 and y0 == y1:
                break
            doubled = 2 * error
            if doubled >= dy:
                error += dy
                x0 += sx
            if doubled <= dx:
                error += dx
                y0 += sy

    x_logs = [math.log2(steps) for steps, _ in all_values]
    y_logs = [math.log10(torque) for _, torque in all_values]
    if isinstance(recommendation, (int, float)) and recommendation > 0.0:
        y_logs.append(math.log10(recommendation))
    x_min, x_max = min(x_logs), max(x_logs)
    y_min, y_max = min(y_logs), max(y_logs)
    if x_min == x_max:
        x_max += 1.0
    if y_min == y_max:
        y_max += 1.0

    def point(steps: int, torque: float) -> tuple[int, int]:
        x = left + round((math.log2(steps) - x_min) / (x_max - x_min) * (width - left - right))
        y = top + round((y_max - math.log10(torque)) / (y_max - y_min) * (height - top - bottom))
        return x, y

    grid = (220, 220, 220)
    axis = (30, 30, 30)
    for index in range(6):
        x = left + round(index / 5 * (width - left - right))
        line(x, top, x, height - bottom, grid)
        y = top + round(index / 5 * (height - top - bottom))
        line(left, y, width - right, y, grid)
    line(left, top, left, height - bottom, axis)
    line(left, height - bottom, width - right, height - bottom, axis)

    colors = (
        (31, 119, 180),
        (255, 127, 14),
        (44, 160, 44),
        (214, 39, 40),
        (148, 103, 189),
        (140, 86, 75),
        (227, 119, 194),
        (23, 190, 207),
    )
    for index, (_, values) in enumerate(sorted(grouped.items())):
        points = [point(steps, torque) for steps, torque in sorted(values)]
        color = colors[index % len(colors)]
        for start, end in zip(points, points[1:]):
            line(*start, *end, color)
        for x, y in points:
            for offset_x in range(-3, 4):
                for offset_y in range(-3, 4):
                    set_pixel(x + offset_x, y + offset_y, color)
    if isinstance(recommendation, (int, float)) and recommendation > 0.0:
        _, y = point(int(2**x_min), recommendation)
        for x in range(left, width - right, 8):
            line(x, y, min(x + 4, width - right), y, axis)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    scanlines = b"".join(
        b"\x00" + bytes(pixels[row * width * 3 : (row + 1) * width * 3])
        for row in range(height)
    )
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(scanlines, level=9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path, help="Benchmark CSV files")
    parser.add_argument(
        "--suite",
        type=Path,
        default=Path("examples/assets/fem_performance/relaxation_torque_calibration_suite_v2.json"),
        help="Immutable v2 calibration suite manifest",
    )
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--plot", type=Path, required=True)
    parser.add_argument(
        "--allow-incomplete-matrix",
        action="store_true",
        help="Analyze a bounded smoke scope without promoting a default",
    )
    parser.add_argument("--physical-cap-t", type=float, default=DEFAULT_PHYSICAL_CAP_T)
    parser.add_argument("--safety-factor", type=float, default=DEFAULT_SAFETY_FACTOR)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows = read_rows(args.inputs)
    with args.suite.open(encoding="utf-8") as handle:
        suite = json.load(handle)
    result = analyze_rows_v2(
        rows,
        suite=suite,
        physical_cap_t=args.physical_cap_t,
        safety_factor=args.safety_factor,
        allow_incomplete_matrix=args.allow_incomplete_matrix,
    )
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    write_plot(rows, result, args.plot)
    if result["validation_failures"]:
        for failure in result["validation_failures"]:
            print(f"RELAXATION_TORQUE_CALIBRATION_ERROR={failure}")
        raise SystemExit(2)
    if result["decision"] == "no_qualified_default":
        for failure in result["failures"]:
            print(f"RELAXATION_TORQUE_CALIBRATION_ERROR={failure}")
        print(f"RELAXATION_TORQUE_CALIBRATION_DECISION={result['decision']}")
        return
    print(
        "RELAXATION_TORQUE_CALIBRATION_DECISION="
        + result["decision"]
        + "\nRELAXATION_TORQUE_CALIBRATION="
        + json.dumps(
            {
                "torque_tolerance_apm": result["recommended_torque_tolerance_apm"],
                "torque_tolerance_t": result["recommended_torque_tolerance_t"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
