#!/usr/bin/env python3
"""Dependency-free contract smoke test for the T4 equilibrium gate.

This check runs before any managed runtime is rebuilt.  It exercises the
fail-closed semantics with synthetic rows only; it does not qualify a solver
or a GPU device.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR_PATH = REPO_ROOT / "scripts" / "validate_fem_relaxation_equilibrium_parity.py"
SUITE_PATH = (
    REPO_ROOT
    / "examples"
    / "assets"
    / "fem_performance"
    / "equilibrium_qualification_suite_v1.json"
)


def load_validator():
    spec = importlib.util.spec_from_file_location(
        "fullmag_fem_relaxation_equilibrium_parity_contract", VALIDATOR_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load validator: {VALIDATOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def valid_row(validator, backend: str, steps: int) -> dict[str, object]:
    values = [(1.0, 0.0, 0.0)]
    return {
        "backend": backend,
        "status": "ok",
        "solver_mesh_signature": "contract-mesh",
        "solver_mesh_signature_schema": validator.MESH_SIGNATURE_SCHEMA,
        "solver_mesh_node_count": 1,
        "converged": True,
        "stop_reason": "torque",
        "resolved_torque_tolerance_apm": 8000.0,
        "final_torque_apm": 1.0,
        "time_to_tolerance_seconds": 0.01,
        "time_to_tolerance_source": validator.SOLVER_TIME_SOURCE,
        "accepted_steps_to_tolerance": steps,
        "executed_steps": steps,
        "demag_solve_count_total": 1,
        "final_e_total_j": -1.0e-18,
        "final_e_ex_j": -1.0e-19,
        "final_e_demag_j": -9.0e-19,
        "final_e_ext_j": 0.0,
        "final_e_ani_j": 0.0,
        "final_e_dmi_j": 0.0,
        "norm_defect": 0.0,
        "final_magnetization_present": True,
        "final_magnetization_observable": "m",
        "final_magnetization_unit": "1",
        "final_magnetization_step": steps,
        "final_magnetization_node_count": 1,
        "final_magnetization_values_json": json.dumps(values),
    }


def main() -> int:
    validator = load_validator()
    cpu = valid_row(validator, "fem_cpu", 3)
    gpu = valid_row(validator, "fem_gpu", 7)
    values = validator._vectors(cpu)
    assert values is not None
    cpu["final_magnetization_sha256"] = validator._final_magnetization_content_sha256(
        observable="m", unit="1", step=3, values=values
    )
    values = validator._vectors(gpu)
    assert values is not None
    gpu["final_magnetization_sha256"] = validator._final_magnetization_content_sha256(
        observable="m", unit="1", step=7, values=values
    )
    assert validator.stop_state_failures(cpu) == []
    assert validator.stop_state_failures(gpu) == []
    comparison = validator.compare_equilibrium_states(cpu, gpu)
    assert comparison.passed and comparison.executed_step_delta == 4
    gpu["resolved_torque_tolerance_apm"] = 4000.0
    assert any(
        "tolerance mismatch" in failure
        for failure in validator.compare_equilibrium_states(cpu, gpu).failures
    )
    suite = json.loads(SUITE_PATH.read_text(encoding="utf-8"))
    loaded_suite = validator.load_qualification_suite(SUITE_PATH)
    assert suite["schema"] == "fullmag.fem.relaxation_equilibrium_qualification_suite.v1"
    assert suite["immutable"] is True
    assert suite["max_steps"] == 50000
    assert suite["torque_tolerance_apm"] == 8000.0
    assert suite["algorithms"] == ["projected_gradient_bb", "nonlinear_cg"]
    assert suite["scenarios"] == [
        "box500_airbox_exchange_only",
        "box500_airbox_exchange_demag",
    ]
    assert loaded_suite["fixture_signatures"]["coarse"] == (
        "4831e3b71f597ef03933e82c14e959b412872c92a3b9258363b1c0e3cb467ce6"
    )
    print("FEM_RELAXATION_EQUILIBRIUM_PARITY_SEMANTICS=pass")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"FEM_RELAXATION_EQUILIBRIUM_PARITY_SEMANTICS=fail: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
