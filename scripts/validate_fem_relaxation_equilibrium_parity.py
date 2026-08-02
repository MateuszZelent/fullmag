#!/usr/bin/env python3
"""Fail-closed CPU/GPU same-tolerance equilibrium comparison.

This verifier intentionally consumes benchmark rows rather than terminal
process wall time.  The benchmark runner must publish the solver-owned
``time_to_tolerance_seconds`` and final ``m`` evidence before this gate can
qualify a pair.  A fixed step budget is execution coverage only: only a
converged ``torque`` stop state can enter the equilibrium comparator.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import statistics
import struct
import sys
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import product
from pathlib import Path
from typing import Any


SCHEMA = "fullmag.fem.relaxation_equilibrium_parity.v1"
MESH_SIGNATURE_SCHEMA = "fullmag.fem.solver_mesh_signature.v2"
SOLVER_TIME_SOURCE = "accepted_step_diagnostics_wall_time_ns"
QUALIFICATION_SUITE_SCHEMA = (
    "fullmag.fem.relaxation_equilibrium_qualification_suite.v1"
)
SUPPORTED_BACKENDS = {"fem_cpu", "fem_gpu", "cpu", "gpu"}
ENERGY_FIELDS = (
    "final_e_total_j",
    "final_e_ex_j",
    "final_e_demag_j",
    "final_e_ext_j",
    "final_e_ani_j",
    "final_e_dmi_j",
)
ENERGY_ALIASES = {
    "final_e_total_j": ("final_e_total_j", "e_total_j", "E_total"),
    "final_e_ex_j": ("final_e_ex_j", "e_ex_j", "E_ex"),
    "final_e_demag_j": ("final_e_demag_j", "e_demag_j", "E_demag"),
    "final_e_ext_j": ("final_e_ext_j", "e_ext_j", "E_ext"),
    "final_e_ani_j": ("final_e_ani_j", "e_ani_j", "E_ani"),
    "final_e_dmi_j": ("final_e_dmi_j", "e_dmi_j", "E_dmi"),
}


@dataclass(frozen=True)
class EquilibriumThresholds:
    """Initial FP64 parity envelope from the existing CPU/GPU contract."""

    energy_rtol: float = 1.0e-6
    energy_atol_j: float = 1.0e-30
    norm_defect_max: float = 1.0e-9
    max_component_difference: float = 1.0e-9

    @property
    def norm_defect_atol(self) -> float:
        """Compatibility spelling for callers that call the bound an atol."""

        return self.norm_defect_max

    @property
    def max_component_atol(self) -> float:
        return self.max_component_difference

    def as_dict(self) -> dict[str, float]:
        return {
            "energy_rtol": self.energy_rtol,
            "energy_atol_j": self.energy_atol_j,
            "norm_defect_max": self.norm_defect_max,
            "max_component_difference": self.max_component_difference,
            "equal_step_count_required": False,
        }


@dataclass(frozen=True)
class EquilibriumComparison:
    passed: bool
    failures: tuple[str, ...]
    max_component_difference: float | None
    rms_component_difference: float | None
    p99_vector_difference: float | None
    mean_vector_difference: float | None
    energy_component_differences: dict[str, float]
    executed_step_delta: int | None

    @property
    def energy_differences(self) -> dict[str, float]:
        return self.energy_component_differences

    def as_dict(self) -> dict[str, object]:
        return {
            "status": "pass" if self.passed else "fail",
            "passed": self.passed,
            "failures": list(self.failures),
            "max_component_difference": self.max_component_difference,
            "rms_component_difference": self.rms_component_difference,
            "p99_vector_difference": self.p99_vector_difference,
            "mean_vector_difference": self.mean_vector_difference,
            "energy_component_differences": self.energy_component_differences,
            "executed_step_delta": self.executed_step_delta,
        }


def _float(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return result


def _bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _first(row: Mapping[str, object], *names: str) -> object | None:
    for name in names:
        value = row.get(name)
        if value is not None and value != "":
            return value
    return None


def _backend_name(row: Mapping[str, object]) -> str:
    backend = str(row.get("backend") or "").strip().lower()
    if backend == "cpu":
        return "fem_cpu"
    if backend == "gpu":
        return "fem_gpu"
    return backend


def _energy_value(row: Mapping[str, object], field: str) -> float | None:
    return _float(_first(row, *ENERGY_ALIASES[field]))


def _vectors(row: Mapping[str, object]) -> list[tuple[float, float, float]] | None:
    payload: object = _first(
        row,
        "final_magnetization_values_json",
        "final_magnetization_values",
        "m_final_values",
    )
    if payload is None:
        artifact_path = _first(row, "final_magnetization_path", "m_final_path")
        if artifact_path is None:
            artifact_dir = _first(row, "artifact_dir", "run_dir")
            if artifact_dir is not None:
                artifact_path = Path(str(artifact_dir)) / "m_final.json"
        if artifact_path is not None:
            try:
                payload = json.loads(Path(str(artifact_path)).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                payload = None
            if isinstance(payload, Mapping):
                payload = payload.get("values")
    if payload is None and isinstance(row.get("m_final"), Mapping):
        payload = row["m_final"].get("values")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return None
    if (
        not isinstance(payload, Sequence)
        or isinstance(payload, (str, bytes))
        or not payload
    ):
        return None
    values: list[tuple[float, float, float]] = []
    for vector in payload:
        if (
            not isinstance(vector, Sequence)
            or isinstance(vector, (str, bytes))
            or len(vector) != 3
        ):
            return None
        components = tuple(_float(component) for component in vector)
        if any(component is None for component in components):
            return None
        values.append((float(components[0]), float(components[1]), float(components[2])))
    return values


def _has_final_magnetization(row: Mapping[str, object]) -> bool:
    explicit = row.get("final_magnetization_present")
    if explicit is not None and not _bool(explicit):
        return False
    values = _vectors(row)
    if values is None:
        return False
    observable = _first(row, "final_magnetization_observable")
    unit = _first(row, "final_magnetization_unit")
    if observable is not None and observable != "m":
        return False
    if unit is not None and unit != "1":
        return False
    return True


def _final_magnetization_content_sha256(
    *,
    observable: str,
    unit: str,
    step: int,
    values: Sequence[tuple[float, float, float]],
) -> str:
    """Return the canonical digest used by ``m_final.json`` evidence."""

    digest = hashlib.sha256()
    digest.update(b"fullmag.task11.final_magnetization.v1\0")
    for text in (observable, unit):
        encoded = text.encode("utf-8")
        digest.update(struct.pack(">I", len(encoded)))
        digest.update(encoded)
    digest.update(struct.pack(">Q", step))
    digest.update(struct.pack(">Q", len(values)))
    for vector in values:
        digest.update(struct.pack(">ddd", *vector))
    return digest.hexdigest()


def stop_state_failures(
    row: Mapping[str, object],
    *,
    label: str = "row",
    thresholds: EquilibriumThresholds | None = None,
) -> list[str]:
    """Validate the state that owns a terminal torque decision."""

    limits = thresholds or EquilibriumThresholds()
    failures: list[str] = []
    backend = _backend_name(row)
    if backend not in {"fem_cpu", "fem_gpu"}:
        failures.append(f"{label} backend must be fem_cpu or fem_gpu, got {backend!r}")
    status = row.get("status")
    if status is not None and status != "ok" and status != "completed":
        failures.append(f"{label} runtime status is not completed: {status!r}")
    if row.get("converged") is not True and not _bool(row.get("converged")):
        failures.append(f"{label} converged must be true")
    if row.get("stop_reason") != "torque":
        failures.append(
            f"{label} stop_reason must be torque, got {row.get('stop_reason')!r}"
        )

    target = _float(
        _first(
            row,
            "resolved_torque_tolerance_apm",
        )
    )
    if target is None or target <= 0.0:
        failures.append(f"{label} resolved_torque_tolerance_apm is missing or invalid")
    final_torque = _float(
        _first(row, "final_torque_apm", "max_torque_Apm", "max_torque_apm")
    )
    if final_torque is None or final_torque < 0.0:
        failures.append(f"{label} final torque is missing or invalid")
    elif target is not None and final_torque > target:
        failures.append(
            f"{label} final torque {final_torque:.16g} exceeds target {target:.16g}"
        )

    elapsed = _float(
        _first(
            row,
            "time_to_tolerance_seconds",
            "time_to_tolerance_s",
            "solver_time_to_tolerance_seconds",
        )
    )
    if elapsed is None or elapsed < 0.0:
        failures.append(f"{label} time_to_tolerance_seconds is missing or invalid")
    if row.get("time_to_tolerance_source") != SOLVER_TIME_SOURCE:
        failures.append(
            f"{label} time_to_tolerance_source must be {SOLVER_TIME_SOURCE!r}"
        )
    steps = _int(_first(row, "executed_steps", "total_steps"))
    if steps is None or steps < 0:
        failures.append(f"{label} executed_steps must be a non-negative integer")
    accepted_steps = _int(row.get("accepted_steps_to_tolerance"))
    if accepted_steps is None or accepted_steps < 0:
        failures.append(
            f"{label} accepted_steps_to_tolerance must be a non-negative integer"
        )
    elif steps is not None and accepted_steps > steps:
        failures.append(
            f"{label} accepted_steps_to_tolerance exceeds executed_steps"
        )
    solve_count = _int(
        _first(
            row,
            "demag_solve_count_total",
            "cumulative_demag_solves",
            "demag_solves",
        )
    )
    if solve_count is None or solve_count < 0:
        failures.append(f"{label} demag_solve_count_total is missing or invalid")

    for field in ENERGY_FIELDS:
        if _energy_value(row, field) is None:
            failures.append(f"{label} {field} is missing or non-finite")
    norm_defect = _float(row.get("norm_defect"))
    if norm_defect is None or norm_defect < 0.0:
        failures.append(f"{label} norm_defect is missing or invalid")
    elif norm_defect > limits.norm_defect_max:
        failures.append(
            f"{label} norm_defect {norm_defect:.16g} exceeds {limits.norm_defect_max:.16g}"
        )

    if not _has_final_magnetization(row):
        failures.append(f"{label} m_final.json magnetization evidence is missing or invalid")
    values = _vectors(row)
    if row.get("final_magnetization_observable") != "m":
        failures.append(f"{label} final magnetization observable must be m")
    if row.get("final_magnetization_unit") != "1":
        failures.append(f"{label} final magnetization unit must be 1")
    node_count = _int(row.get("solver_mesh_node_count"))
    final_node_count = _int(row.get("final_magnetization_node_count"))
    if node_count is None or node_count <= 0:
        failures.append(f"{label} solver_mesh_node_count is missing or invalid")
    if final_node_count is None or final_node_count <= 0:
        failures.append(f"{label} final_magnetization_node_count is missing or invalid")
    if values is not None and final_node_count is not None and final_node_count != len(values):
        failures.append(f"{label} final_magnetization_node_count does not match m_final values")
    if values is not None and node_count is not None and node_count != len(values):
        failures.append(f"{label} m_final vector count does not match solver mesh node count")
    final_step = _int(row.get("final_magnetization_step"))
    if final_step is None or final_step < 0:
        failures.append(f"{label} final_magnetization_step is missing or invalid")
    elif steps is not None and final_step != steps:
        failures.append(f"{label} m_final step does not match executed_steps")

    content_sha = row.get("final_magnetization_sha256")
    if (
        not isinstance(content_sha, str)
        or len(content_sha) != 64
        or any(character not in "0123456789abcdef" for character in content_sha)
    ):
        failures.append(f"{label} final_magnetization_sha256 is missing or invalid")
    elif values is not None and final_step is not None:
        expected_sha = _final_magnetization_content_sha256(
            observable="m",
            unit="1",
            step=final_step,
            values=values,
        )
        if content_sha != expected_sha:
            failures.append(f"{label} final_magnetization_sha256 does not match m_final values")

    signature = _first(row, "solver_mesh_signature")
    if not isinstance(signature, str) or not signature:
        failures.append(f"{label} solver_mesh_signature is missing")
    signature_schema = _first(row, "solver_mesh_signature_schema")
    if signature_schema != MESH_SIGNATURE_SCHEMA:
        failures.append(
            f"{label} solver_mesh_signature_schema must be {MESH_SIGNATURE_SCHEMA!r}"
        )
    return failures


def validate_stop_state(
    row: Mapping[str, object],
    *,
    label: str = "row",
    thresholds: EquilibriumThresholds | None = None,
) -> list[str]:
    """Public alias used by lightweight managed callers and unit tests."""

    return stop_state_failures(row, label=label, thresholds=thresholds)


def _percentile(values: Sequence[float], percentile: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    index = max(0, min(len(ordered) - 1, math.ceil(percentile * len(ordered)) - 1))
    return float(ordered[index])


def compare_equilibrium_states(
    cpu: Mapping[str, object],
    gpu: Mapping[str, object],
    thresholds: EquilibriumThresholds | None = None,
) -> EquilibriumComparison:
    """Compare converged states on one identical solver mesh.

    The number of accepted steps is intentionally not a comparison criterion;
    it is retained as ``executed_step_delta`` for diagnostics.
    """

    limits = thresholds or EquilibriumThresholds()
    failures = list(stop_state_failures(cpu, label="cpu", thresholds=limits))
    failures.extend(stop_state_failures(gpu, label="gpu", thresholds=limits))
    cpu_signature = _first(cpu, "solver_mesh_signature")
    gpu_signature = _first(gpu, "solver_mesh_signature")
    if cpu_signature != gpu_signature:
        failures.append(
            "CPU/GPU solver mesh signature mismatch: "
            f"cpu={cpu_signature!r} gpu={gpu_signature!r}"
        )
    cpu_target = _float(
        _first(cpu, "resolved_torque_tolerance_apm")
    )
    gpu_target = _float(
        _first(gpu, "resolved_torque_tolerance_apm")
    )
    if cpu_target is not None and gpu_target is not None and cpu_target != gpu_target:
        failures.append(
            "CPU/GPU resolved torque tolerance mismatch: "
            f"cpu={cpu_target:.16g} gpu={gpu_target:.16g}"
        )
    cpu_schema = _first(cpu, "solver_mesh_signature_schema")
    gpu_schema = _first(gpu, "solver_mesh_signature_schema")
    if cpu_schema is not None and gpu_schema is not None and cpu_schema != gpu_schema:
        failures.append(
            "CPU/GPU solver mesh signature schema mismatch: "
            f"cpu={cpu_schema!r} gpu={gpu_schema!r}"
        )

    cpu_values = _vectors(cpu)
    gpu_values = _vectors(gpu)
    max_component: float | None = None
    rms_component: float | None = None
    p99_vector: float | None = None
    mean_vector: float | None = None
    if cpu_values is None or gpu_values is None:
        failures.append("CPU/GPU final magnetization evidence is missing")
    elif len(cpu_values) != len(gpu_values):
        failures.append(
            "CPU/GPU final magnetization node count mismatch: "
            f"cpu={len(cpu_values)} gpu={len(gpu_values)}"
        )
    else:
        component_differences = [
            abs(left - right)
            for left, right in zip(cpu_values, gpu_values)
            for left, right in zip(left, right)
        ]
        vector_differences = [
            math.sqrt(sum((left - right) ** 2 for left, right in zip(a, b)))
            for a, b in zip(cpu_values, gpu_values)
        ]
        max_component = max(component_differences, default=0.0)
        rms_component = math.sqrt(
            sum(value * value for value in component_differences)
            / max(1, len(component_differences))
        )
        p99_vector = _percentile(vector_differences, 0.99)
        cpu_mean = tuple(sum(vector[index] for vector in cpu_values) / len(cpu_values) for index in range(3))
        gpu_mean = tuple(sum(vector[index] for vector in gpu_values) / len(gpu_values) for index in range(3))
        mean_vector = math.sqrt(sum((a - b) ** 2 for a, b in zip(cpu_mean, gpu_mean)))
        if max_component > limits.max_component_difference:
            failures.append(
                "final magnetization max component difference exceeds threshold: "
                f"{max_component:.16g} > {limits.max_component_difference:.16g}"
            )

    energy_differences: dict[str, float] = {}
    for field in ENERGY_FIELDS:
        left = _energy_value(cpu, field)
        right = _energy_value(gpu, field)
        if left is None or right is None:
            continue
        difference = abs(left - right)
        energy_differences[field] = difference
        if difference > limits.energy_atol_j + limits.energy_rtol * max(abs(left), abs(right)):
            failures.append(
                f"{field} parity mismatch: cpu={left:.16g} gpu={right:.16g} "
                f"diff={difference:.6g}"
            )

    cpu_steps = _int(_first(cpu, "executed_steps", "total_steps"))
    gpu_steps = _int(_first(gpu, "executed_steps", "total_steps"))
    step_delta = abs(cpu_steps - gpu_steps) if cpu_steps is not None and gpu_steps is not None else None
    return EquilibriumComparison(
        passed=not failures,
        failures=tuple(failures),
        max_component_difference=max_component,
        rms_component_difference=rms_component,
        p99_vector_difference=p99_vector,
        mean_vector_difference=mean_vector,
        energy_component_differences=energy_differences,
        executed_step_delta=step_delta,
    )


def _typed_row(row: Mapping[str, object]) -> dict[str, object]:
    result = dict(row)
    for key in (
        "converged",
        "final_magnetization_present",
        "warmup",
    ):
        if key in result and isinstance(result[key], str):
            result[key] = _bool(result[key])
    for key in (
        "executed_steps",
        "total_steps",
        "demag_solve_count_total",
        "demag_solves",
        "cumulative_demag_solves",
        "accepted_steps_to_tolerance",
        "solver_mesh_node_count",
        "final_magnetization_node_count",
        "final_magnetization_step",
    ):
        if key in result and result[key] != "":
            parsed = _int(result[key])
            if parsed is not None:
                result[key] = parsed
    for key in (
        "resolved_torque_tolerance_apm",
        "requested_relax_torque_tolerance_apm",
        "time_to_tolerance_seconds",
        "time_to_tolerance_s",
        "final_torque_apm",
        "final_torque_t",
        "norm_defect",
        *ENERGY_FIELDS,
    ):
        if key in result and result[key] != "":
            parsed = _float(result[key])
            if parsed is not None:
                result[key] = parsed
    return result


def load_rows(path: Path) -> list[dict[str, object]]:
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8") as handle:
            return [_typed_row(row) for row in csv.DictReader(handle)]
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, Mapping):
        for key in ("rows", "results"):
            if isinstance(payload.get(key), list):
                return [_typed_row(row) for row in payload[key] if isinstance(row, Mapping)]
        if isinstance(payload.get("pairs"), list):
            rows: list[dict[str, object]] = []
            for pair in payload["pairs"]:
                if not isinstance(pair, Mapping):
                    continue
                for backend in ("cpu", "gpu"):
                    row = pair.get(backend)
                    if isinstance(row, Mapping):
                        rows.append(_typed_row(row))
            return rows
        return [_typed_row(payload)]
    if isinstance(payload, list):
        return [_typed_row(row) for row in payload if isinstance(row, Mapping)]
    raise ValueError(f"equilibrium input must be an object, array, or CSV: {path}")


def load_qualification_suite(path: Path) -> dict[str, object]:
    """Load immutable case identities for the strict parity matrix gate."""

    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping) or payload.get("schema") != QUALIFICATION_SUITE_SCHEMA:
        raise ValueError("unsupported FEM equilibrium qualification suite schema")
    if payload.get("immutable") is not True:
        raise ValueError("FEM equilibrium qualification suite must be immutable")
    if payload.get("initial_state") != "same_unit_x_plus_y_normalized_v1":
        raise ValueError("FEM equilibrium qualification initial state differs from v1")
    if payload.get("max_steps") != 50_000 or payload.get("torque_tolerance_apm") != 8000.0:
        raise ValueError("FEM equilibrium qualification stop contract differs from v1")
    if payload.get("demag_policy") != {
        "solver": "CG",
        "preconditioner": "AMG",
        "rtol": 1e-12,
        "amg_relax_type": 6,
        "amg_coarsening": 8,
        "amg_interpolation": 6,
        "amg_aggressive_coarsening": 1,
    }:
        raise ValueError("FEM equilibrium qualification demag policy differs from v1")
    fixtures = payload.get("fixtures")
    if not isinstance(fixtures, list) or not fixtures:
        raise ValueError("FEM equilibrium qualification suite has no fixtures")
    fixture_signatures: dict[str, str] = {}
    for fixture in fixtures:
        if not isinstance(fixture, Mapping):
            raise ValueError("FEM equilibrium qualification fixture must be an object")
        resolution = str(fixture.get("resolution") or "")
        signature = fixture.get("solver_mesh_signature")
        if not resolution or not isinstance(signature, str) or len(signature) != 64:
            raise ValueError("FEM equilibrium qualification fixture identity is invalid")
        fixture_signatures[resolution] = signature
    algorithms = payload.get("algorithms")
    scenarios = payload.get("scenarios")
    if not isinstance(algorithms, list) or not all(isinstance(value, str) for value in algorithms):
        raise ValueError("FEM equilibrium qualification suite algorithms are invalid")
    if not isinstance(scenarios, list) or not all(isinstance(value, str) for value in scenarios):
        raise ValueError("FEM equilibrium qualification suite scenarios are invalid")
    return {
        "resolutions": tuple(fixture_signatures),
        "fixture_signatures": fixture_signatures,
        "algorithms": tuple(algorithms),
        "scenarios": tuple(scenarios),
        "max_steps": payload.get("max_steps"),
        "torque_tolerance_apm": payload.get("torque_tolerance_apm"),
    }


def _pair_key(row: Mapping[str, object]) -> tuple[object, ...]:
    resolution = _first(row, "resolution", "mesh_size", "mesh_path")
    return (
        resolution,
        row.get("scenario"),
        row.get("relaxation_algorithm") or row.get("reported_relaxation_algorithm"),
        row.get("solver_mesh_signature"),
        row.get("repeat_index", 0),
    )


def _distribution(values: Sequence[float]) -> dict[str, float | int] | None:
    if not values:
        return None
    ordered = sorted(values)
    return {
        "count": len(ordered),
        "p50": float(statistics.median(ordered)),
        "p95": _percentile(ordered, 0.95),
        "stddev": float(statistics.pstdev(ordered)),
    }


def validate_rows(
    rows: Sequence[Mapping[str, object]],
    *,
    thresholds: EquilibriumThresholds | None = None,
    require_parity: bool = False,
    expected_resolutions: Sequence[str] | None = None,
    expected_scenarios: Sequence[str] | None = None,
    expected_algorithms: Sequence[str] | None = None,
    expected_repeat_count: int | None = None,
    expected_fixture_signatures: Mapping[str, str] | None = None,
) -> dict[str, object]:
    limits = thresholds or EquilibriumThresholds()
    grouped: dict[tuple[object, ...], dict[str, dict[str, object]]] = defaultdict(dict)
    unpaired_failures: list[str] = []
    for index, raw_row in enumerate(rows):
        row = _typed_row(raw_row)
        backend = _backend_name(row)
        if backend not in {"fem_cpu", "fem_gpu"}:
            continue
        key = _pair_key(row)
        if backend in grouped[key]:
            unpaired_failures.append(f"duplicate {backend} row for case={key}")
        grouped[key][backend] = row
    pairs: list[dict[str, object]] = []
    failures = list(unpaired_failures)
    for key, by_backend in sorted(grouped.items(), key=lambda item: str(item[0])):
        cpu = by_backend.get("fem_cpu")
        gpu = by_backend.get("fem_gpu")
        if cpu is None or gpu is None:
            failures.append(f"case={key} requires one fem_cpu and one fem_gpu row")
            continue
        comparison = compare_equilibrium_states(cpu, gpu, limits)
        pair = {
            "case": list(key),
            "status": "pass" if comparison.passed else "fail",
            "cpu": dict(cpu),
            "gpu": dict(gpu),
            "comparison": comparison.as_dict(),
        }
        pairs.append(pair)
        failures.extend(f"case={key} {failure}" for failure in comparison.failures)
        if expected_fixture_signatures is not None:
            resolution = str(_first(cpu, "resolution", "mesh_size", "mesh_path") or "")
            expected_signature = expected_fixture_signatures.get(resolution)
            if expected_signature is None:
                failures.append(f"case={key} is outside the immutable fixture suite")
            elif cpu.get("solver_mesh_signature") != expected_signature or gpu.get(
                "solver_mesh_signature"
            ) != expected_signature:
                failures.append(
                    f"case={key} solver mesh signature does not match immutable fixture "
                    f"{expected_signature}"
                )
    if require_parity and all(
        value is not None
        for value in (
            expected_resolutions,
            expected_scenarios,
            expected_algorithms,
            expected_repeat_count,
        )
    ):
        if expected_repeat_count is None or expected_repeat_count <= 0:
            failures.append("expected repeat count must be positive")
        else:
            expected_cases = {
                (resolution, scenario, algorithm, repeat_index)
                for resolution, scenario, algorithm, repeat_index in product(
                    expected_resolutions or (),
                    expected_scenarios or (),
                    expected_algorithms or (),
                    range(expected_repeat_count),
                )
            }
            observed_cases = {
                (
                    str(_first(row, "resolution", "mesh_size", "mesh_path") or ""),
                    str(row.get("scenario") or ""),
                    str(
                        row.get("relaxation_algorithm")
                        or row.get("reported_relaxation_algorithm")
                        or ""
                    ),
                    _int(row.get("repeat_index")) or 0,
                )
                for by_backend in grouped.values()
                for row in by_backend.values()
            }
            for missing in sorted(expected_cases - observed_cases):
                failures.append(f"missing expected equilibrium case={missing}")
            for unexpected in sorted(observed_cases - expected_cases):
                failures.append(f"unexpected equilibrium case={unexpected}")
    if pairs and not failures:
        status = "pass"
        parity_status = "checked"
    elif pairs:
        status = "fail"
        parity_status = "failed"
    else:
        status = "not_qualified"
        parity_status = "not_requested"
    if require_parity and (not pairs or failures):
        status = "fail"
        parity_status = "failed"
        if not failures:
            failures.append("equilibrium parity was not checked")

    distributions: dict[str, dict[str, dict[str, float | int] | None]] = {}
    for backend in ("fem_cpu", "fem_gpu"):
        backend_rows = [pair[backend] for pair in pairs if isinstance(pair.get(backend), Mapping)]
        distributions[backend] = {
            "time_to_tolerance_seconds": _distribution(
                [
                    elapsed
                    for row in backend_rows
                    if (elapsed := _float(row.get("time_to_tolerance_seconds"))) is not None
                    and not _bool(row.get("warmup"))
                ]
            ),
            "executed_steps": _distribution(
                [
                    float(steps)
                    for row in backend_rows
                    if (steps := _int(row.get("executed_steps"))) is not None
                    and not _bool(row.get("warmup"))
                ]
            ),
            "demag_solve_count_total": _distribution(
                [
                    float(count)
                    for row in backend_rows
                    if (count := _int(row.get("demag_solve_count_total"))) is not None
                    and not _bool(row.get("warmup"))
                ]
            ),
        }
    return {
        "schema": SCHEMA,
        "status": status,
        "equilibrium_parity_status": parity_status,
        "thresholds": limits.as_dict(),
        "pair_count": len(pairs),
        "row_count": len(rows),
        "pairs": pairs,
        "distributions": distributions,
        "failures": failures,
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Benchmark CSV or JSON rows")
    parser.add_argument("--output", type=Path, required=True, help="Summary JSON output")
    parser.add_argument(
        "--require-equilibrium-parity",
        action="store_true",
        help="Fail unless at least one CPU/GPU pair passes the same-tolerance gate",
    )
    parser.add_argument(
        "--scope",
        default=None,
        help="Optional scope label retained in the summary (does not change identity or tolerance)",
    )
    parser.add_argument(
        "--equilibrium-suite",
        type=Path,
        default=None,
        help="Immutable suite used to require fixture identities and complete case coverage",
    )
    parser.add_argument(
        "--expected-repeat-count",
        type=int,
        default=None,
        help="Expected measured repeats for the strict equilibrium matrix",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        rows = load_rows(args.input)
        suite = load_qualification_suite(args.equilibrium_suite) if args.equilibrium_suite else None
        expected_resolutions = None
        if suite is not None:
            expected_resolutions = tuple(
                value.strip() for value in (args.scope or ",".join(suite["resolutions"])).split(",") if value.strip()
            )
        summary = validate_rows(
            rows,
            require_parity=args.require_equilibrium_parity,
            expected_resolutions=expected_resolutions,
            expected_scenarios=suite["scenarios"] if suite is not None else None,
            expected_algorithms=suite["algorithms"] if suite is not None else None,
            expected_repeat_count=args.expected_repeat_count,
            expected_fixture_signatures=(
                suite["fixture_signatures"] if suite is not None else None
            ),
        )
        if args.scope is not None:
            summary["scope"] = args.scope
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"[validate_fem_relaxation_equilibrium_parity] {exc}", file=sys.stderr)
        return 2
    print(
        "[validate_fem_relaxation_equilibrium_parity] "
        f"status={summary['status']} pairs={summary['pair_count']} output={args.output}"
    )
    return 0 if summary["status"] == "pass" or not args.require_equilibrium_parity else 20


if __name__ == "__main__":
    raise SystemExit(main())
