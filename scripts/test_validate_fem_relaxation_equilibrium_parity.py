#!/usr/bin/env python3
"""RED/contract tests for the same-tolerance FEM equilibrium gate."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR_PATH = REPO_ROOT / "scripts" / "validate_fem_relaxation_equilibrium_parity.py"
SUITE_PATH = REPO_ROOT / "examples" / "assets" / "fem_performance" / "equilibrium_qualification_suite_v1.json"


def load_validator():
    spec = importlib.util.spec_from_file_location("fem_equilibrium_parity", VALIDATOR_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_benchmark():
    path = REPO_ROOT / "scripts" / "analysis" / "fem_gpu_benchmark.py"
    spec = importlib.util.spec_from_file_location("fem_gpu_benchmark_t4", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_benchmark_case():
    path = REPO_ROOT / "examples" / "bench_fem_gpu_long.py"
    sys.path.insert(0, str(REPO_ROOT / "packages" / "fullmag-py" / "src"))
    spec = importlib.util.spec_from_file_location("bench_fem_gpu_long_t4", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def final_magnetization_sha256(step: int) -> str:
    values = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0))
    digest = hashlib.sha256()
    digest.update(b"fullmag.task11.final_magnetization.v1\0")
    for text in ("m", "1"):
        encoded = text.encode("utf-8")
        digest.update(struct.pack(">I", len(encoded)))
        digest.update(encoded)
    digest.update(struct.pack(">Q", step))
    digest.update(struct.pack(">Q", len(values)))
    for vector in values:
        digest.update(struct.pack(">ddd", *vector))
    return digest.hexdigest()


def state_row(*, backend: str, steps: int = 11, stop_reason: str = "torque") -> dict[str, object]:
    return {
        "backend": backend,
        "resolution": "coarse",
        "scenario": "exchange_demag",
        "relaxation_algorithm": "nonlinear_cg",
        "solver_mesh_signature": "mesh-v2-coarse",
        "solver_mesh_signature_schema": "fullmag.fem.solver_mesh_signature.v2",
        "solver_mesh_node_count": 2,
        "converged": True,
        "stop_reason": stop_reason,
        "resolved_torque_tolerance_apm": 8000.0,
        "time_to_tolerance_seconds": 0.25 if backend == "fem_cpu" else 0.10,
        "time_to_tolerance_source": "accepted_step_diagnostics_wall_time_ns",
        "executed_steps": steps,
        "accepted_steps_to_tolerance": steps,
        "demag_solve_count_total": 22,
        "final_e_total_j": -1.0e-18,
        "final_e_ex_j": -2.0e-19,
        "final_e_demag_j": -8.0e-19,
        "final_e_ext_j": 0.0,
        "final_e_ani_j": 0.0,
        "final_e_dmi_j": 0.0,
        "final_torque_apm": 100.0,
        "final_torque_t": 1.2566370614359172e-4,
        "norm_defect": 0.0,
        "final_magnetization_present": True,
        "final_magnetization_observable": "m",
        "final_magnetization_unit": "1",
        "final_magnetization_step": steps,
        "final_magnetization_node_count": 2,
        "final_magnetization_sha256": final_magnetization_sha256(steps),
        "final_magnetization_values_json": "[[1.0,0.0,0.0],[0.0,1.0,0.0]]",
    }


def test_stop_state_requires_torque_and_convergence() -> None:
    validator = load_validator()
    row = state_row(backend="fem_cpu", stop_reason="max_steps")
    failures = validator.stop_state_failures(row, label="cpu")
    assert any("stop_reason" in failure for failure in failures)
    row = state_row(backend="fem_gpu")
    row["converged"] = False
    failures = validator.stop_state_failures(row, label="gpu")
    assert any("converged" in failure for failure in failures)


def test_comparator_accepts_different_step_counts_and_reports_metrics() -> None:
    validator = load_validator()
    cpu = state_row(backend="fem_cpu", steps=11)
    gpu = state_row(backend="fem_gpu", steps=29)
    comparison = validator.compare_equilibrium_states(
        cpu, gpu, validator.EquilibriumThresholds()
    )
    assert comparison.passed is True
    assert comparison.executed_step_delta == 18
    assert comparison.max_component_difference == 0.0
    assert comparison.rms_component_difference == 0.0
    assert comparison.p99_vector_difference == 0.0
    assert comparison.mean_vector_difference == 0.0


def test_comparator_rejects_signature_drift_and_field_drift() -> None:
    validator = load_validator()
    cpu = state_row(backend="fem_cpu")
    gpu = state_row(backend="fem_gpu", steps=19)
    gpu["solver_mesh_signature"] = "mesh-v2-fine"
    gpu["final_magnetization_values_json"] = "[[1.0,0.0,0.0],[0.0,0.0,1.0]]"
    comparison = validator.compare_equilibrium_states(
        cpu, gpu, validator.EquilibriumThresholds()
    )
    assert comparison.passed is False
    assert any("solver mesh signature" in failure for failure in comparison.failures)
    assert any("magnetization" in failure for failure in comparison.failures)


def test_comparator_rejects_different_resolved_tolerances() -> None:
    validator = load_validator()
    cpu = state_row(backend="fem_cpu")
    gpu = state_row(backend="fem_gpu")
    gpu["resolved_torque_tolerance_apm"] = 4000.0
    comparison = validator.compare_equilibrium_states(cpu, gpu)
    assert comparison.passed is False
    assert any("tolerance mismatch" in failure for failure in comparison.failures)


def test_stop_state_requires_m_final_identity_metadata() -> None:
    validator = load_validator()
    row = state_row(backend="fem_cpu")
    row.pop("final_magnetization_sha256")
    failures = validator.stop_state_failures(row, label="cpu")
    assert any("sha256" in failure for failure in failures)
    row = state_row(backend="fem_cpu")
    row["solver_mesh_signature_schema"] = "legacy"
    failures = validator.stop_state_failures(row, label="cpu")
    assert any("signature_schema" in failure for failure in failures)


@pytest.mark.parametrize(
    "mutator,needle",
    [
        (lambda row: row.pop("final_magnetization_values_json"), "m_final"),
        (lambda row: row.update(final_torque_apm=9000.0), "torque"),
        (lambda row: row.update(norm_defect=1.0e-8), "norm_defect"),
        (lambda row: row.update(time_to_tolerance_seconds=None), "time_to_tolerance"),
    ],
)
def test_stop_state_gate_fails_closed(mutator, needle: str) -> None:
    validator = load_validator()
    row = state_row(backend="fem_cpu")
    mutator(row)
    failures = validator.stop_state_failures(row, label="cpu")
    assert any(needle in failure for failure in failures)


def test_summary_schema_and_cli_are_fail_closed(tmp_path: Path) -> None:
    validator = load_validator()
    cpu = state_row(backend="fem_cpu", steps=11)
    gpu = state_row(backend="fem_gpu", steps=29)
    input_path = tmp_path / "rows.json"
    output_path = tmp_path / "summary.json"
    input_path.write_text(json.dumps({"rows": [cpu, gpu]}), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(VALIDATOR_PATH), str(input_path), "--output", str(output_path)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    summary = json.loads(output_path.read_text(encoding="utf-8"))
    assert summary["schema"] == "fullmag.fem.relaxation_equilibrium_parity.v1"
    assert summary["status"] == "pass"
    assert summary["equilibrium_parity_status"] == "checked"
    assert summary["pairs"][0]["cpu"]["executed_steps"] == 11
    assert summary["pairs"][0]["gpu"]["executed_steps"] == 29


def test_immutable_qualification_suite_is_explicit() -> None:
    suite = json.loads(SUITE_PATH.read_text(encoding="utf-8"))
    assert suite["schema"] == "fullmag.fem.relaxation_equilibrium_qualification_suite.v1"
    assert suite["max_steps"] == 50_000
    assert suite["initial_state"] == "same_unit_x_plus_y_normalized_v1"
    assert suite["demag_policy"]["rtol"] == 1.0e-12
    assert suite["torque_tolerance_apm"] == 8000.0
    assert suite["algorithms"] == ["projected_gradient_bb", "nonlinear_cg"]
    assert suite["scenarios"] == ["exchange_only", "exchange_demag"]
    assert [fixture["resolution"] for fixture in suite["fixtures"]] == [
        "coarse",
        "medium",
        "fine",
    ]
    assert all(
        fixture["solver_mesh_signature_schema"]
        == "fullmag.fem.solver_mesh_signature.v2"
        for fixture in suite["fixtures"]
    )


def test_required_matrix_does_not_accept_a_single_passing_pair() -> None:
    validator = load_validator()
    rows = [state_row(backend="fem_cpu"), state_row(backend="fem_gpu", steps=13)]
    summary = validator.validate_rows(
        rows,
        require_parity=True,
        expected_resolutions=("coarse", "medium", "fine"),
        expected_scenarios=("exchange_only", "exchange_demag"),
        expected_algorithms=("projected_gradient_bb", "nonlinear_cg"),
        expected_repeat_count=5,
        expected_fixture_signatures={"coarse": "mesh-v2-coarse"},
    )
    assert summary["status"] == "fail"
    assert any("missing expected equilibrium case" in failure for failure in summary["failures"])


def test_suite_loader_exposes_immutable_fixture_signatures() -> None:
    validator = load_validator()
    suite = validator.load_qualification_suite(SUITE_PATH)
    assert suite["resolutions"] == ("coarse", "medium", "fine")
    assert suite["fixture_signatures"]["coarse"] == (
        "0bcaf9731f36f911f8af210037eeadf1d6555446534e25cc977da6408b014412"
    )


def test_benchmark_requires_final_state_capture_for_qualification() -> None:
    benchmark = load_benchmark()
    with pytest.raises(SystemExit):
        benchmark.parse_args(["--require-equilibrium-parity"])
    args = benchmark.parse_args(
        ["--require-equilibrium-parity", "--capture-final-magnetization"]
    )
    assert args.require_equilibrium_parity is True
    assert args.capture_final_magnetization is True


def test_benchmark_equilibrium_wrapper_preserves_time_and_step_delta() -> None:
    benchmark = load_benchmark()
    cpu = state_row(backend="fem_cpu", steps=11)
    gpu = state_row(backend="fem_gpu", steps=29)
    summary = benchmark.equilibrium_parity_summary([cpu, gpu], require_parity=True)
    assert summary["schema"] == "fullmag.fem.relaxation_equilibrium_parity.v1"
    assert summary["status"] == "pass"
    assert summary["pairs"][0]["comparison"]["executed_step_delta"] == 18


def test_solver_time_to_tolerance_stops_at_first_accepted_state() -> None:
    benchmark_case = load_benchmark_case()
    Step = type("Step", (), {})
    steps = []
    for wall_time_ns, demag_solves, torque in (
        (10, 2, 9000.0),
        (20, 3, 7999.0),
        (1000, 99, 1.0),
    ):
        step = Step()
        step.wall_time_ns = wall_time_ns
        step.demag_solves = demag_solves
        step.max_torque_Apm = torque
        steps.append(step)
    assert benchmark_case.solver_time_to_tolerance_evidence(steps, 8000.0) == (
        pytest.approx(30e-9),
        2,
        5,
    )
