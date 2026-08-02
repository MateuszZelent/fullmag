#!/usr/bin/env python3
"""Dependency-free managed-container check for CPU/GPU consistency semantics."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_PATH = REPO_ROOT / "scripts" / "analysis" / "fem_gpu_benchmark.py"


def load_benchmark_module():
    spec = importlib.util.spec_from_file_location("fullmag_fem_gpu_benchmark", BENCHMARK_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load benchmark module: {BENCHMARK_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def paired_rows(algorithm: str) -> list[dict[str, object]]:
    common: dict[str, object] = {
        "scenario": "box500_airbox_exchange_demag",
        "reported_relaxation_algorithm": algorithm,
        "relaxation_algorithm": algorithm,
        "integrator": "heun",
        "timestep_policy": "fixed",
        "dt_s": 1.0e-13,
        "steps": 32,
        "status": "ok",
        "solver_mesh_signature": "mesh-a",
        "executed_steps": 32,
        "final_e_total_j": -1.0e-17,
        "final_e_ex_j": 1.0e-22,
        "final_e_demag_j": 2.0e-19,
        "final_e_ext_j": -1.02e-17,
        "final_torque_apm": 2.0e4,
        "final_torque_t": 2.5e-2,
    }
    rows: list[dict[str, object]] = []
    for backend, engine, mode, cuda in (
        ("fem_cpu", "fem_cpu_native", "cpu_native", False),
        ("fem_gpu", "fem_native_gpu", "all_in_gpu_legacy_sparse", True),
    ):
        rows.append(
            {
                **common,
                "backend": backend,
                "execution_engine": engine,
                "fem_execution_mode": mode,
                "mfem_device": "cuda" if cuda else "cpu",
                "uses_cuda_kernels": cuda,
            }
        )
    return rows


def main() -> int:
    benchmark = load_benchmark_module()
    manifests = benchmark.cpu_gpu_case_manifests(
        scenarios=["box500_airbox_exchange_demag"],
        relaxation_algorithms=["nonlinear_cg"],
        steps=32,
        dt=1.0e-13,
        energy_rtol=1.0e-6,
        energy_atol=1.0e-30,
        torque_rtol=1.0e-6,
        torque_atol_apm=1.0e-9,
        torque_atol_t=1.0e-15,
        max_step_delta=0,
    )
    rows = paired_rows("nonlinear_cg")
    summary = benchmark.cpu_gpu_consistency_summary(
        rows,
        case_manifests=manifests,
    )
    assert summary["status"] == "coverage_only"
    assert summary["consistency_status"] == "coverage_only"
    assert summary["equilibrium_parity_status"] == "not_requested"
    report = benchmark.render_cpu_gpu_benchmark_report(
        summary,
        {"status": "pass", "gate_failure_count": 0, "group_failure_count": 0, "failures": []},
    )
    assert "- status: coverage_only" in report
    assert "coverage_only" in report
    assert "CPU/GPU consistency: pass" not in report

    gated = benchmark.cpu_gpu_consistency_summary(
        rows,
        case_manifests=manifests,
        require_equilibrium_parity=True,
    )
    assert gated["status"] == "failed"
    assert "direct minimizer equilibrium parity was not checked" in gated["failures"]
    print("fem relaxation consistency semantics valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
