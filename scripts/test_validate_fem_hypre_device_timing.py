from __future__ import annotations

import importlib.util
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "validate_fem_hypre_device_timing.py"


def load_module():
    spec = importlib.util.spec_from_file_location("validate_fem_hypre_device_timing", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def row(resolution: str, profiled: bool) -> dict[str, object]:
    return {
        "backend": "fem_gpu",
        "status": "ok",
        "mesh_name": f"box500_airbox_exchange_demag_{resolution}",
        "step_profiler_enabled": int(profiled),
        "demag_solves": 2,
        "demag_hypre_wait_in_enqueue_wall_time_ms": 0.2 if profiled else 0.0,
        "demag_hypre_host_api_wall_time_ms": 0.3 if profiled else 0.0,
        "demag_hypre_device_elapsed_time_ms": 4.0 if profiled else 0.0,
        "demag_hypre_wait_out_enqueue_wall_time_ms": 0.1 if profiled else 0.0,
        "demag_hypre_event_wait_count": 2 if profiled else 0,
        "demag_hypre_timed_solve_count": 2 if profiled else 0,
        "hot_loop_compute_host_sync_count": 0,
    }


def test_profiled_coarse_fine_rows_pass():
    module = load_module()
    summary = module.validate_rows(
        [row(resolution, profiled) for resolution in ("coarse", "fine") for profiled in (False, True)]
    )
    assert summary["status"] == "pass"
    assert summary["failures"] == []


def test_profiled_row_requires_device_elapsed_and_matching_solve_count():
    module = load_module()
    bad = row("coarse", True)
    bad["demag_hypre_device_elapsed_time_ms"] = 0.0
    bad["demag_hypre_timed_solve_count"] = 1
    summary = module.validate_rows(
        [row("coarse", False), bad, row("fine", False), row("fine", True)]
    )
    assert summary["status"] == "fail"
    assert any("device elapsed" in failure for failure in summary["failures"])
    assert any("timed_solve_count" in failure for failure in summary["failures"])


def test_profiler_off_must_not_publish_timing_events():
    module = load_module()
    bad = row("fine", False)
    bad["demag_hypre_device_elapsed_time_ms"] = 1.0
    summary = module.validate_rows(
        [row("coarse", False), row("coarse", True), row("fine", True), bad]
    )
    assert summary["status"] == "fail"
    assert any("profiler-off" in failure for failure in summary["failures"])


def test_profiled_row_rejects_compute_synchronization():
    module = load_module()
    bad = row("coarse", True)
    bad["hot_loop_compute_host_sync_count"] = 1
    summary = module.validate_rows(
        [row("coarse", False), bad, row("fine", False), row("fine", True)]
    )
    assert summary["status"] == "fail"
    assert any("synchronization count" in failure for failure in summary["failures"])


def test_hypre_timing_recipe_supplies_resolved_relaxation_torque_policy():
    justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    recipe = justfile.split("verify-fem-hypre-device-timing:", 1)[1].split(
        "\n\n", 1
    )[0]
    assert (
        'FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE="${'
        'FULLMAG_BENCH_RELAX_TORQUE_TOLERANCE:-8000.0}"'
    ) in recipe


def test_hypre_timing_recipe_mounts_the_resolved_runtime_bundle():
    justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    recipe = justfile.split("verify-fem-hypre-device-timing:", 1)[1].split(
        "\n\n", 1
    )[0]
    assert 'runtime_root="$(readlink -f .fullmag/runtimes/fem-gpu-host)"' in recipe
    assert '-v "$runtime_root:/workspace/.fullmag/runtime:ro"' in recipe
    assert "FULLMAG_FEM_RUNTIME_ROOT=/workspace/.fullmag/runtime" in recipe
    assert "FULLMAG_BENCH_GPU_BIN=/workspace/.fullmag/runtime/bin/fullmag-fem-gpu" in recipe
    assert (
        "--relaxation-torque-calibration-suite "
        "examples/assets/fem_performance/relaxation_torque_calibration_suite_v2.json"
    ) in recipe
    assert "--generated-domain-mesh-cache-dir" not in recipe
