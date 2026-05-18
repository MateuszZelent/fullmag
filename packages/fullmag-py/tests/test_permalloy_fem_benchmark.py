from __future__ import annotations

import importlib.util
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
BENCHMARK_PATH = REPO_ROOT / "scripts" / "benchmark_permalloy_fem_demag.py"


def load_benchmark_module():
    spec = importlib.util.spec_from_file_location(
        "benchmark_permalloy_fem_demag", BENCHMARK_PATH
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


SAMPLE_CPU_LOG = """
[fullmag-runner] live FEM engine: resolved_engine_id=fem_cpu_native fallback=None
[fullmag-fem] cpu runtime: poisson_solver=CG preconditioner=AMG cpu_threads=manual requested_omp_threads=20 effective_omp_threads=20 mesh_nodes=56253 elements=290000
info: native FEM backend active: engine=fem_cpu_native device='mfem_cpu_native_poisson_robin_demag' precision=double demag_solver=CG preconditioner=AMG
[fullmag-fem] demag call: step=0 call=1 dt=1.000e-13 assemble=90ms solve=30ms recover=80ms energy=0ms total=200ms lin_iters=10 residual=1.000e-6
[fullmag-fem] demag call: step=0 call=2 dt=1.000e-13 assemble=100ms solve=40ms recover=160ms energy=0ms total=300ms lin_iters=12 residual=8.000e-7
stage 1/1 (flat_relax)  step      1  t=1.0000e-13  dt=1.000e-13  max_torque[T]=4.5e0  E_total=-4.0e-15  |H_eff|=1.0e7  [1000ms] phases[ex=5ms demag=430ms rhs=2ms extra=9ms snap=0ms] rk[rhs_evals=2 rejected=0 fsal=0] demag[solves=2 lin_iters=22 residual=8.000e-7]
stage 1/1 (flat_relax)  step      1  t=1.0000e-13  dt=1.000e-13  max_torque[T]=4.5e0  E_total=-4.0e-15  |H_eff|=1.0e7  [1000ms] phases[ex=5ms demag=430ms rhs=2ms extra=9ms snap=0ms] rk[rhs_evals=2 rejected=0 fsal=0] demag[solves=2 lin_iters=22 residual=8.000e-7]
[fullmag-fem] demag call: step=1 call=3 dt=1.100e-13 assemble=110ms solve=50ms recover=240ms energy=0ms total=400ms lin_iters=14 residual=6.000e-7
stage 1/1 (flat_relax)  step      2  t=2.1000e-13  dt=1.100e-13  max_torque[T]=4.3e0  E_total=-4.1e-15  |H_eff|=9.0e6  [1200ms] phases[ex=6ms demag=620ms rhs=3ms extra=11ms snap=0ms] rk[rhs_evals=2 rejected=1 fsal=0] demag[solves=2 lin_iters=26 residual=6.000e-7]
"""


SAMPLE_GPU_FALLBACK_LOG = """
[fullmag-runner] live FEM engine: resolved_engine_id=fem_cpu_native fallback=Some("gpu_unavailable")
[fullmag-fem] cpu runtime: poisson_solver=CG preconditioner=AMG cpu_threads=manual requested_omp_threads=8 effective_omp_threads=8 mesh_nodes=120 elements=400
[fullmag-fem] demag call: step=0 call=1 dt=1.000e-13 assemble=10ms solve=2ms recover=9ms energy=0ms total=21ms lin_iters=3 residual=1.000e-8
"""


def test_parse_benchmark_log_extracts_demag_stage_and_runtime_metrics():
    bench = load_benchmark_module()

    summary = bench.parse_benchmark_log(
        SAMPLE_CPU_LOG,
        label="cpu-20t",
        requested_execution="cpu",
        requested_threads=20,
        returncode=0,
        elapsed_s=8.5,
        log_path=Path(".fullmag/logs/cpu-20t.log"),
    )

    assert summary["status"] == "ok"
    assert summary["resolved_engine_id"] == "fem_cpu_native"
    assert summary["backend_device"] == "mfem_cpu_native_poisson_robin_demag"
    assert summary["requested_omp_threads"] == 20
    assert summary["effective_omp_threads"] == 20
    assert summary["mesh_nodes"] == 56253
    assert summary["mesh_elements"] == 290000
    assert summary["demag_call_count"] == 3
    assert summary["stage_sample_count"] == 2
    assert summary["rejected_steps"] == 1
    assert summary["demag_total_median_ms"] == 300.0
    assert summary["demag_assemble_median_ms"] == 100.0
    assert summary["demag_solve_median_ms"] == 40.0
    assert summary["demag_recover_median_ms"] == 160.0
    assert summary["demag_lin_iters_median"] == 12.0
    assert summary["demag_residual_last"] == 6.0e-7
    assert summary["step_time_median_ms"] == 1100.0
    assert summary["stage_demag_median_ms"] == 525.0


def test_parse_benchmark_log_marks_gpu_fallback():
    bench = load_benchmark_module()

    summary = bench.parse_benchmark_log(
        SAMPLE_GPU_FALLBACK_LOG,
        label="gpu",
        requested_execution="gpu",
        requested_threads=None,
        returncode=0,
        elapsed_s=1.0,
        log_path=Path(".fullmag/logs/gpu.log"),
    )

    assert summary["status"] == "ok"
    assert summary["gpu_fallback"] is True
    assert summary["fallback"] == 'Some("gpu_unavailable")'
    assert summary["resolved_engine_id"] == "fem_cpu_native"


def test_case_environment_enables_profiler_threads_and_device():
    bench = load_benchmark_module()
    case = bench.BenchmarkCase(label="cpu-30t", execution="cpu", threads=30)

    env = bench.build_case_environment(case, {"PATH": "/bin"}, max_steps=100)

    assert env["FULLMAG_FEM_STEP_PROFILE"] == "1"
    assert str(bench.FULLMAG_PY_SRC) in env["PYTHONPATH"]
    assert str(bench.BUNDLED_PY_SITE) in env["PYTHONPATH"]
    assert env["FULLMAG_FEM_EXECUTION"] == "cpu"
    assert env["FULLMAG_CPU_THREADS"] == "30"
    assert env["OMP_NUM_THREADS"] == "30"
    assert env["RAYON_NUM_THREADS"] == "30"
    assert env["PERMALLOY_DEVICE"] == "cpu"
    assert env["PERMALLOY_MAX_STEPS"] == "100"


def test_enrich_summary_with_metadata_uses_nanosecond_demag_profile():
    bench = load_benchmark_module()
    summary = {"label": "cpu-20t"}
    metadata = {
        "demag_runtime": {
            "actual_iterations": 7,
            "final_residual_norm": 4.2e-7,
            "requested_fem_omp_threads": 20,
            "effective_fem_omp_threads": 20,
            "mfem_device": "cpu",
            "fem_assembly_mode": "legacy_sparse",
            "timings_ns": {
                "assemble": 12_500_000,
                "solve": 33_250_000,
                "solver_setup": 2_000_000,
                "solver_apply": 31_250_000,
                "recover": 44_750_000,
                "energy": 100_000,
                "total": 90_600_000,
            },
        }
    }

    bench.enrich_summary_with_metadata(summary, metadata)

    assert summary["metadata_profile"] is True
    assert summary["metadata_demag_total_ms"] == 90.6
    assert summary["metadata_demag_assemble_ms"] == 12.5
    assert summary["metadata_demag_solve_ms"] == 33.25
    assert summary["metadata_demag_solver_apply_ms"] == 31.25
    assert summary["metadata_demag_recover_ms"] == 44.75
    assert summary["metadata_demag_actual_iterations"] == 7
    assert summary["metadata_demag_final_residual"] == 4.2e-7
    assert summary["metadata_mfem_device"] == "cpu"
    assert summary["metadata_fem_assembly_mode"] == "legacy_sparse"


def test_render_markdown_report_includes_ranking_and_fallback_status():
    bench = load_benchmark_module()
    cpu = bench.parse_benchmark_log(
        SAMPLE_CPU_LOG,
        label="cpu-20t",
        requested_execution="cpu",
        requested_threads=20,
        returncode=0,
        elapsed_s=8.5,
        log_path=Path(".fullmag/logs/cpu-20t.log"),
    )
    gpu = bench.parse_benchmark_log(
        SAMPLE_GPU_FALLBACK_LOG,
        label="gpu",
        requested_execution="gpu",
        requested_threads=None,
        returncode=0,
        elapsed_s=1.0,
        log_path=Path(".fullmag/logs/gpu.log"),
    )
    bench.enrich_summary_with_metadata(
        cpu,
        {
            "demag_runtime": {
                "timings_ns": {"total": 123_400_000, "solver_apply": 10_000_000}
            }
        },
    )

    report = bench.render_markdown_report(
        [cpu, gpu],
        generated_at="2026-05-17T12:00:00+02:00",
        command="pytest",
    )

    assert "# Permalloy FEM demag benchmark" in report
    assert "| cpu-20t | ok | cpu | fem_cpu_native | no | 20 | 20 |" in report
    assert "| gpu | ok | gpu | fem_cpu_native | yes |" in report
    assert "123.4" in report
    assert "## Ranking" in report
    assert "gpu fallback: yes" in report.lower()
    assert "bottleneck" in report.lower()
