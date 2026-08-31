#!/usr/bin/env python3
"""Validate the executable Frozen Spins cross-discretization runtime probe.

The Rust producer runs the production FDM/FEM Frozen Spins planners and the
reference solver for coarse/medium/fine meshes.  This validator is deliberately
independent of that process: it checks the persisted contract, every lane's
hard-restore invariant and the cross-lane refinement/parity properties before
writing a stable evidence receipt.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
from typing import Any, Sequence


INPUT_SCHEMA = "fullmag.frozen_spins.cross_discretization.runtime.v1"
OUTPUT_SCHEMA = "fullmag.frozen_spins.cross_discretization.runtime.evidence.v1"
BACKENDS = ("fdm", "fem")
REFINEMENTS = ("coarse", "medium", "fine")
LEVELS = {name: index for index, name in enumerate(REFINEMENTS)}
PARITY_RELATIVE_TOLERANCE = 1.0e-9
SHA256_LENGTH = 64


class EvidenceError(ValueError):
    """Raised when a runtime artifact cannot prove the required contract."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise EvidenceError(message)


def _object(value: Any, label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be an object")
    return value


def _array(value: Any, label: str) -> list[Any]:
    _require(isinstance(value, list), f"{label} must be an array")
    return value


def _string(value: Any, label: str) -> str:
    _require(isinstance(value, str) and bool(value.strip()), f"{label} must be a non-empty string")
    return value


def _sha256(value: Any, label: str) -> str:
    text = _string(value, label).lower()
    digest = text.removeprefix("sha256:")
    _require(
        len(digest) == SHA256_LENGTH and all(character in "0123456789abcdef" for character in digest),
        f"{label} must be a SHA-256 identity",
    )
    return digest


def _finite(value: Any, label: str) -> float:
    _require(isinstance(value, (int, float)) and not isinstance(value, bool), f"{label} must be numeric")
    number = float(value)
    _require(math.isfinite(number), f"{label} must be finite")
    return number


def _nonnegative_integer(value: Any, label: str) -> int:
    _require(isinstance(value, int) and not isinstance(value, bool) and value >= 0, f"{label} must be a non-negative integer")
    return value


def _positive_integer(value: Any, label: str) -> int:
    _require(isinstance(value, int) and not isinstance(value, bool) and value > 0, f"{label} must be a positive integer")
    return value


def _close(left: float, right: float, relative: float = PARITY_RELATIVE_TOLERANCE) -> bool:
    scale = max(abs(left), abs(right), 1.0e-300)
    return abs(left - right) <= relative * scale


def _validate_row(raw: Any, backend: str, refinement: str) -> dict[str, Any]:
    row = _object(raw, f"row[{backend}/{refinement}]")
    _require(row.get("backend") == backend, f"row[{backend}/{refinement}] backend mismatch")
    _require(row.get("refinement") == refinement, f"row[{backend}/{refinement}] refinement mismatch")
    _require(row.get("refinement_level") == LEVELS[refinement], f"row[{backend}/{refinement}] level mismatch")
    resolution = _array(row.get("resolution"), f"row[{backend}/{refinement}].resolution")
    _require(len(resolution) == 3, f"row[{backend}/{refinement}] resolution must have three axes")
    resolution = [_positive_integer(value, f"row[{backend}/{refinement}].resolution[{axis}]") for axis, value in enumerate(resolution)]
    _require(len(set(resolution)) == 1, f"row[{backend}/{refinement}] resolution must be cubic")
    active = _positive_integer(row.get("active_dof_count"), f"row[{backend}/{refinement}].active_dof_count")
    frozen = _nonnegative_integer(row.get("frozen_dof_count"), f"row[{backend}/{refinement}].frozen_dof_count")
    free = _nonnegative_integer(row.get("free_dof_count"), f"row[{backend}/{refinement}].free_dof_count")
    _require(frozen > 0, f"row[{backend}/{refinement}] must contain frozen DOFs")
    _require(free > 0, f"row[{backend}/{refinement}] must contain free DOFs")
    _require(active == frozen + free, f"row[{backend}/{refinement}] DOF counts do not add up")
    mask_digest = _sha256(row.get("resolved_mask_sha256"), f"row[{backend}/{refinement}].resolved_mask_sha256")

    solver = _object(row.get("solver"), f"row[{backend}/{refinement}].solver")
    _require(solver.get("status") == "completed", f"row[{backend}/{refinement}] solver did not complete")
    steps = _positive_integer(solver.get("steps_executed"), f"row[{backend}/{refinement}].solver.steps_executed")
    _require(solver.get("energy_finite") is True, f"row[{backend}/{refinement}] energy is not finite")
    _require(solver.get("frozen_dof_present") is True, f"row[{backend}/{refinement}] lacks frozen DOF evidence")
    _require(solver.get("free_dof_mobility_observed") is True, f"row[{backend}/{refinement}] lacks free mobility evidence")
    frozen_abs = _finite(solver.get("frozen_max_abs_drift"), f"row[{backend}/{refinement}].solver.frozen_max_abs_drift")
    _require(frozen_abs == 0.0, f"row[{backend}/{refinement}] frozen absolute drift is non-zero")
    _require(solver.get("frozen_max_ulp_drift") == 0, f"row[{backend}/{refinement}] frozen ULP drift is non-zero")
    displacement = _finite(solver.get("free_max_displacement"), f"row[{backend}/{refinement}].solver.free_max_displacement")
    _require(displacement > 0.0, f"row[{backend}/{refinement}] free displacement is not positive")
    _require(solver.get("fallback_used") is False, f"row[{backend}/{refinement}] used a fallback")
    _require(solver.get("per_step_frozen_transfer_bytes") == 0, f"row[{backend}/{refinement}] transferred frozen payload per step")
    metrics = {}
    for key in ("max_rhs_free", "max_rhs_all", "max_torque_free", "max_torque_all"):
        metrics[key] = _finite(solver.get(key), f"row[{backend}/{refinement}].solver.{key}")
        _require(metrics[key] >= 0.0, f"row[{backend}/{refinement}].solver.{key} must be non-negative")
    _require(metrics["max_rhs_all"] + 1.0e-12 >= metrics["max_rhs_free"], f"row[{backend}/{refinement}] all-node RHS is below free RHS")
    _require(metrics["max_torque_all"] + 1.0e-12 >= metrics["max_torque_free"], f"row[{backend}/{refinement}] all-node torque is below free torque")
    return {
        "backend": backend,
        "refinement": refinement,
        "refinement_level": LEVELS[refinement],
        "resolution": resolution,
        "active_dof_count": active,
        "frozen_dof_count": frozen,
        "free_dof_count": free,
        "resolved_mask_sha256": mask_digest,
        "steps_executed": steps,
        "frozen_max_abs_drift": frozen_abs,
        "frozen_max_ulp_drift": 0,
        "free_max_displacement": displacement,
        **metrics,
        "final_magnetization_sha256": _sha256(row.get("final_magnetization_sha256"), f"row[{backend}/{refinement}].final_magnetization_sha256"),
    }


def build_evidence(raw_bytes: bytes, input_label: str = "<input>") -> dict[str, Any]:
    try:
        root = json.loads(raw_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EvidenceError(f"runtime artifact is not valid UTF-8 JSON: {error}") from error
    root = _object(root, input_label)
    _require(root.get("schema_version") == INPUT_SCHEMA, f"{input_label}: schema_version must be {INPUT_SCHEMA}")
    _require(root.get("status") == "PASS", f"{input_label}: producer status is not PASS")
    _require(root.get("implementation_status") == "EXECUTED_PRODUCTION_PLANNER_AND_REFERENCE_RUNTIME", f"{input_label}: runtime was not executed by production planners")
    _require(root.get("qualification_status") == "UNQUALIFIED", f"{input_label}: managed qualification must remain explicitly UNQUALIFIED")
    _require("managed_clean_source" in _string(root.get("qualification_blocker"), f"{input_label}.qualification_blocker"), f"{input_label}: qualification blocker must name managed clean source")
    case_ids = _array(root.get("test_case_ids"), f"{input_label}.test_case_ids")
    _require(case_ids == ["FS-P15-CROSS-DISCRETIZATION"], f"{input_label}: unexpected test_case_ids")

    contract = _object(root.get("contract"), f"{input_label}.contract")
    expected_contract = {
        "shared_selector": "production_planner_compile_fdm_and_compile_fem",
        "reference_policy": "capture_current_at_activation",
        "membership_policy": "static",
        "integrator": "heun",
        "precision": "double",
        "resolved_mask_hashes_cross_lane": "NOT_COMPARED",
    }
    for key, expected in expected_contract.items():
        _require(contract.get(key) == expected, f"{input_label}.contract.{key} must be {expected!r}")
    dt = _finite(contract.get("dt_s"), f"{input_label}.contract.dt_s")
    _require(dt > 0.0, f"{input_label}.contract.dt_s must be positive")

    rows = _array(root.get("rows"), f"{input_label}.rows")
    _require(len(rows) == 6, f"{input_label}: exactly six runtime rows are required")
    validated: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for backend in BACKENDS:
        for refinement in REFINEMENTS:
            matching = [row for row in rows if isinstance(row, dict) and row.get("backend") == backend and row.get("refinement") == refinement]
            _require(len(matching) == 1, f"{input_label}: missing or duplicate row {backend}/{refinement}")
            validated.append(_validate_row(matching[0], backend, refinement))
            seen.add((backend, refinement))
    _require(len(seen) == 6, f"{input_label}: row coverage is incomplete")

    convergence: dict[str, Any] = {}
    for backend in BACKENDS:
        lane = [row for row in validated if row["backend"] == backend]
        resolutions = [row["resolution"][0] for row in lane]
        _require(resolutions == sorted(resolutions) and len(set(resolutions)) == 3, f"{backend}: refinement resolutions are not strictly increasing")
        convergence[backend] = {
            "refinements": [row["refinement"] for row in lane],
            "resolutions": resolutions,
            "frozen_max_abs_drift": [row["frozen_max_abs_drift"] for row in lane],
            "frozen_max_ulp_drift": [row["frozen_max_ulp_drift"] for row in lane],
            "free_max_displacement": [row["free_max_displacement"] for row in lane],
            "hard_restore_zero_ulp": True,
            "free_mobility_all_levels": True,
        }

    parity: list[dict[str, Any]] = []
    for refinement in REFINEMENTS:
        fdm = next(row for row in validated if row["backend"] == "fdm" and row["refinement"] == refinement)
        fem = next(row for row in validated if row["backend"] == "fem" and row["refinement"] == refinement)
        comparisons = {}
        for key in ("max_rhs_free", "max_rhs_all", "max_torque_free", "max_torque_all", "free_max_displacement"):
            left, right = fdm[key], fem[key]
            scale = max(abs(left), abs(right), 1.0e-300)
            relative_error = abs(left - right) / scale
            _require(relative_error <= PARITY_RELATIVE_TOLERANCE, f"{refinement}: FDM/FEM {key} parity exceeds tolerance")
            comparisons[key] = {"fdm": left, "fem": right, "relative_error": relative_error}
        _require(fdm["frozen_max_abs_drift"] == fem["frozen_max_abs_drift"] == 0.0, f"{refinement}: frozen drift differs across lanes")
        _require(fdm["frozen_max_ulp_drift"] == fem["frozen_max_ulp_drift"] == 0, f"{refinement}: frozen ULP drift differs across lanes")
        parity.append({"refinement": refinement, "comparisons": comparisons, "resolved_mask_hashes_are_discretization_specific": fdm["resolved_mask_sha256"] != fem["resolved_mask_sha256"]})

    digest = hashlib.sha256(raw_bytes).hexdigest()
    return {
        "schema_version": OUTPUT_SCHEMA,
        "evidence_id": f"frozen-spins-cross-discretization-runtime-{digest}",
        "status": "PASS",
        "implementation_status": "RUNTIME_CONFIRMED_REFERENCE_LANES",
        "qualification_status": "UNQUALIFIED",
        "qualification_blocker": "managed_clean_source_receipt_required",
        "test_case_ids": ["FS-P15-CROSS-DISCRETIZATION"],
        "contracts": {
            "production_planner_compile_fdm_and_fem": "PASS",
            "reference_solver_step_all_six_rows": "PASS",
            "hard_restore_zero_ulp_all_rows": "PASS",
            "free_dof_mobility_all_rows": "PASS",
            "energy_finite_all_rows": "PASS",
            "no_fallback_or_per_step_frozen_transfer": "PASS",
            "refinement_coverage": "PASS",
            "cross_lane_observable_parity": "PASS",
            "resolved_mask_hash_cross_lane_equality": "NOT_REQUIRED_DISCRETIZATION_SPECIFIC",
        },
        "contract": contract,
        "convergence": convergence,
        "parity": parity,
        "rows": validated,
        "input_artifact": {"path": input_label, "bytes": len(raw_bytes), "sha256": digest},
    }


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args(argv)
    try:
        raw_bytes = arguments.input.read_bytes()
        try:
            input_label = arguments.input.resolve().relative_to(Path.cwd().resolve()).as_posix()
        except ValueError:
            input_label = arguments.input.as_posix()
        write_json_atomic(arguments.output, build_evidence(raw_bytes, input_label=input_label))
    except (OSError, EvidenceError) as error:
        print(f"FROZEN_SPINS_CROSS_DISCRETIZATION_RUNTIME_EVIDENCE_ERROR={error}")
        return 2
    print(json.dumps({"output": arguments.output.as_posix(), "status": "PASS", "test_case_id": "FS-P15-CROSS-DISCRETIZATION"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
