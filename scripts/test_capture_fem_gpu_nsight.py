from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "scripts" / "analysis" / "capture_fem_gpu_nsight.py"


def load_capture_module():
    assert MODULE_PATH.is_file(), "Task 13 capture harness is missing"
    spec = importlib.util.spec_from_file_location("capture_fem_gpu_nsight", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_nsight_sys_admin_capability_is_capture_only() -> None:
    capture = subprocess.run(
        ["just", "--dry-run", "capture-fem-gpu-nsight"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    capture = capture.stdout + capture.stderr
    assert capture.count("--cap-add SYS_ADMIN") == 3

    ordinary_commands = (
        ["just", "--dry-run", "rebuild-fem-runtime"],
        ["just", "--dry-run", "verify-fem-relaxation-runtime"],
        [
            "just",
            "--dry-run",
            "fem-managed-container-headless",
            "gpu",
            "examples/bench_fem_gpu_long.py",
        ],
    )
    for command in ordinary_commands:
        completed = subprocess.run(
            command,
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        rendered = completed.stdout + completed.stderr
        assert "--cap-add SYS_ADMIN" not in rendered

    compose = (REPO_ROOT / "compose.yaml").read_text(encoding="utf-8")
    assert "SYS_ADMIN" not in compose
    assert "cap_add:" not in compose


def test_task13_sources_wire_exact_stable_ranges_and_opt_in_build() -> None:
    required_ranges = {
        "fem.relax.ncg.step",
        "fem.relax.armijo",
        "fem.demag.rhs",
        "fem.demag.hypre.apply",
        "fullmag.demag.wait_in_enqueue",
        "fullmag.demag.hypre_mult_host",
        "fullmag.demag.hypre_device",
        "fullmag.demag.wait_out_enqueue",
        "fem.demag.recovery",
        "fem.preview.snapshot",
        "fem.host.callback",
        "fem.host.publish",
    }
    sources = {
        path: (REPO_ROOT / path).read_text(encoding="utf-8")
        for path in (
            "backends/fem/gpu/cuda/runtime/nvtx_ranges.hpp",
            "backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp",
            "backends/fem/gpu/cuda/relaxation/pgbb.cpp",
            "backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp",
            "backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.cpp",
            "crates/fullmag-runner/src/fem/relax/preview.rs",
            "crates/fullmag-cli/src/nvtx_range.rs",
            "crates/fullmag-cli/src/orchestrator.rs",
            "crates/fullmag-cli/src/live_workspace.rs",
            "docker/fem-gpu/Dockerfile",
        )
    }
    combined = "\n".join(sources.values())
    assert required_ranges <= {name for name in required_ranges if name in combined}

    header = sources["backends/fem/gpu/cuda/runtime/nvtx_ranges.hpp"]
    assert "#if FULLMAG_ENABLE_NVTX" in header
    assert "nvtxRangePushA" in header
    assert "nvtxRangePop" in header
    assert "new " not in header

    cmake = (REPO_ROOT / "backends/fem/CMakeLists.txt").read_text(encoding="utf-8")
    assert 'option(FULLMAG_ENABLE_NVTX "Enable phase-level FEM GPU NVTX ranges" OFF)' in cmake
    assert "FULLMAG_ENABLE_NVTX=1" in cmake

    sys_build = (REPO_ROOT / "crates/fullmag-fem-sys/build.rs").read_text(encoding="utf-8")
    assert 'rerun-if-env-changed=FULLMAG_ENABLE_NVTX' in sys_build
    assert '"-DFULLMAG_ENABLE_NVTX={}"' in sys_build

    exporter = (REPO_ROOT / "scripts/export_fem_gpu_runtime.sh").read_text(encoding="utf-8")
    # The four HYPRE subranges are emitted by the native demag stage, not by
    # the runtime exporter script.  Keep the exporter assertion limited to the
    # ranges that this script itself owns; the combined source assertion above
    # covers the native labels.
    exporter_owned_ranges = required_ranges - {
        "fullmag.demag.wait_in_enqueue",
        "fullmag.demag.hypre_mult_host",
        "fullmag.demag.hypre_device",
        "fullmag.demag.wait_out_enqueue",
    }
    assert exporter_owned_ranges <= {name for name in exporter_owned_ranges if name in exporter}
    assert '-e FULLMAG_ENABLE_NVTX="${FULLMAG_ENABLE_NVTX}"' in exporter
    assert "--cfg fullmag_enable_nvtx" in exporter
    assert '"nvtx_enabled"' in exporter
    clean = "cargo +nightly clean -p fullmag-build-info"
    build = "cargo +nightly build"
    assert clean in exporter
    assert exporter.index(clean) < exporter.index(build)
    assert "inherited RUSTFLAGS contains fullmag_enable_nvtx" in exporter
    assert "only_native_lib_dir" in exporter
    stale_native_clean = (
        'find target/release/build -maxdepth 1 -type d -name "fullmag-fem-sys-*"'
    )
    assert stale_native_clean in exporter
    stale_guard = "stale fullmag-fem-sys native artifacts remain after targeted clean"
    assert stale_guard in exporter
    assert (
        exporter.index(clean)
        < exporter.index(stale_native_clean)
        < exporter.index(stale_guard)
        < exporter.index(build)
    )
    assert "validate_nvtx_artifact" in exporter
    assert "validate_nvtx_symbol_contract" in exporter
    assert "nm -D --defined-only" in exporter
    assert "nm -D --undefined-only" in exporter
    assert "readelf -d" in exporter
    assert "fullmag_fem_nvtx_range_start" in exporter
    assert "fullmag_fem_nvtx_range_end" in exporter
    assert 'combined_symbols="$(nm -D "$native_artifact" "$worker_artifact")"' in exporter
    assert 'nm -D "$native_artifact" "$worker_artifact" | grep' not in exporter
    for range_name in exporter_owned_ranges:
        assert range_name in exporter

    interop = sources[
        "backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.cpp"
    ]
    wrapper_start = interop.index(
        'extern "C" uint64_t fullmag_fem_nvtx_range_start'
    )
    wrapper_end = interop.index("namespace {", wrapper_start)
    guarded_wrappers = interop[interop.rfind("#if", 0, wrapper_start):wrapper_end]
    assert "#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_ENABLE_NVTX" in guarded_wrappers
    assert "#endif" in guarded_wrappers

    dockerfile = sources["docker/fem-gpu/Dockerfile"]
    assert (
        "FULLMAG_NSIGHT_SYSTEMS_ROOT=/opt/nvidia/nsight-compute/2024.1.1/host/target-linux-x64"
        in dockerfile
    )
    assert "PATH=${FULLMAG_NSIGHT_SYSTEMS_ROOT}:${PATH}" in dockerfile
    assert "RUN nsys --version && ncu --version" in dockerfile

    assert "mod nvtx_range;" in (REPO_ROOT / "crates/fullmag-cli/src/main.rs").read_text(
        encoding="utf-8"
    )
    assert "mod nvtx_range" not in sources["crates/fullmag-cli/src/orchestrator.rs"]
    assert "mod nvtx_range" not in sources["crates/fullmag-cli/src/live_workspace.rs"]


def test_preview_nvtx_range_is_owned_until_snapshot_materialization_finishes() -> None:
    source = (REPO_ROOT / "crates/fullmag-runner/src/fem/relax/preview.rs").read_text(
        encoding="utf-8"
    )
    pending_job = source[source.index("enum PendingFemPreviewJob {"):source.index(
        "struct PreviewResult"
    )]
    worker = source[source.index("let worker = std::thread::Builder"):source.index(
        ".expect(\"spawn bounded FEM preview materializer\")"
    )]

    assert pending_job.count("nvtx: nvtx_range::Range") == 2
    assert pending_job.count("nvtx: _nvtx") == 2
    assert "let nvtx = nvtx_range::Range::new(b\"fem.preview.snapshot\\0\");" in source
    assert "(deferred, scheduled, nvtx)" in worker
    assert "|(deferred, scheduled, _nvtx)|" in worker
    assert worker.index("|(deferred, scheduled, _nvtx)|") < worker.index(
        "materialize_magnetization(snapshot, deferred)"
    )


def test_preflight_marks_missing_tool_unavailable() -> None:
    capture = load_capture_module()

    def fake_run(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        if command[0] == "nsys":
            return subprocess.CompletedProcess(command, 0, "NVIDIA Nsight Systems 2026.1", "")
        if command[0] == "nvidia-smi":
            return subprocess.CompletedProcess(command, 0, "RTX 4080 SUPER, 591.86\n", "")
        return subprocess.CompletedProcess(command, 127, "", "ncu: command not found")

    result = capture.preflight_tools(fake_run)

    assert result["status"] == "unavailable"
    assert result["tools"]["nsys"]["available"] is True
    assert result["tools"]["ncu"]["available"] is False
    assert result["blockers"] == ["ncu unavailable in managed fixture image"]
    assert result["tools"]["ncu"]["reason"] == "missing_binary"


@pytest.mark.parametrize(
    ("stderr", "reason_prefix", "reason"),
    (
        ("NVIDIA-SMI has failed because no devices were found", "no CUDA device:", "no_cuda_device"),
        ("ERR_NVGPUCTRPERM: permission denied", "permission:", "permission"),
        ("NVIDIA driver/library version mismatch", "driver/tool mismatch:", "driver_tool_mismatch"),
    ),
)
def test_preflight_records_fail_closed_cuda_reason(
    stderr: str, reason_prefix: str, reason: str
) -> None:
    capture = load_capture_module()

    def fake_run(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        if command[0] in {"nsys", "ncu"}:
            return subprocess.CompletedProcess(command, 0, f"{command[0]} 2026.1", "")
        return subprocess.CompletedProcess(command, 1, "", stderr)

    result = capture.preflight_tools(fake_run)

    assert result["status"] == "unavailable"
    assert reason in result["reasons"]
    assert result["cuda_device"]["reason"] == reason
    assert any(str(blocker).startswith(reason_prefix) for blocker in result["blockers"])


def test_preflight_only_accepts_available_tools_with_default_off_bundle(
    tmp_path: Path, monkeypatch
) -> None:
    capture = load_capture_module()
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "manifest.json").write_text(
        json.dumps({"schema": 2, "instrumentation": {"nvtx_enabled": False}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        capture,
        "preflight_tools",
        lambda: {
            "status": "available",
            "tools": {
                "nsys": {"available": True, "version": "nsys test"},
                "ncu": {"available": True, "version": "ncu test"},
            },
            "blockers": [],
        },
    )

    assert (
        capture.main(
            [
                "--preflight-only",
                "--runtime-root",
                str(runtime),
                "--output-dir",
                str(tmp_path / "output"),
            ]
        )
        == 0
    )
    payload = json.loads(
        (tmp_path / "output" / capture.DEFAULT_RUN_ID / "summary.json").read_text(
            encoding="utf-8"
        )
    )
    assert payload["status"] == "available"
    assert payload["bundle"]["nvtx_enabled"] is False


def test_actual_capture_rejects_default_off_bundle_before_profiling(tmp_path: Path) -> None:
    capture = load_capture_module()
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "manifest.json").write_text(
        json.dumps({"schema": 2, "instrumentation": {"nvtx_enabled": False}}),
        encoding="utf-8",
    )
    args = capture.parse_args(
        ["--runtime-root", str(runtime), "--output-dir", str(tmp_path / "output")]
    )
    preflight = {"status": "available", "blockers": []}

    assert capture._run_capture(args, preflight) == 2
    payload = json.loads(
        (tmp_path / "output" / capture.DEFAULT_RUN_ID / "summary.json").read_text(
            encoding="utf-8"
        )
    )
    assert payload["status"] == "unavailable"
    assert payload["blockers"] == [
        "managed FEM bundle was not built with FULLMAG_ENABLE_NVTX=1"
    ]


def test_fixture_command_keeps_canonical_fixture_on_headless_run_json_path(
    tmp_path: Path,
) -> None:
    capture = load_capture_module()

    command = capture._fixture_command(tmp_path)

    assert command[command.index("--fixture-manifest") + 1] == str(
        capture.FIXTURE_MANIFEST
    )
    assert "--ui-surface" not in command


def test_capture_environment_reproduces_canonical_fixture_mesh_inputs() -> None:
    capture = load_capture_module()

    environment = capture.capture_environment({})

    assert environment["FULLMAG_BENCH_DOMAIN_HMAX"] == "50e-9"
    assert environment["FULLMAG_BENCH_AIRBOX_HMAX"] == "100e-9"


def test_run_group_has_distinct_headless_compute_and_interactive_host_passes(
    tmp_path: Path,
) -> None:
    capture = load_capture_module()

    compute = capture._fixture_command(tmp_path / "compute")
    host = capture._interactive_fixture_command(tmp_path / "host")
    host_environment = capture.capture_environment({}, interactive=True)

    assert "--fixture-manifest" in compute
    assert "--ui-surface" not in compute
    assert "--fixture-manifest" not in host
    assert host[host.index("--ui-surface") + 1] == "interactive"
    assert host_environment["FULLMAG_BENCH_DOMAIN_MESH"] == str(
        capture.FIXTURE_MANIFEST.parent
        / "box500_airbox_exchange_demag_v1.mesh.json"
    )
    assert capture.COMPUTE_NVTX_RANGES == (
        "fem.relax.ncg.step",
        "fem.relax.armijo",
        "fem.demag.rhs",
        "fem.demag.hypre.apply",
        "fullmag.demag.wait_in_enqueue",
        "fullmag.demag.hypre_mult_host",
        "fullmag.demag.hypre_device",
        "fullmag.demag.wait_out_enqueue",
        "fem.demag.recovery",
    )
    assert capture.HOST_NVTX_RANGES == (
        "fem.preview.snapshot",
        "fem.host.callback",
        "fem.host.publish",
    )


def test_interactive_identity_requires_actual_problem_ir_and_mesh_hashes(
    tmp_path: Path,
) -> None:
    capture = load_capture_module()
    csv_path = tmp_path / "interactive.csv"
    expected = {
        "problem_ir_sha256": "a" * 64,
        "solver_mesh_sha256": "b" * 64,
        "solver_mesh_signature": "c" * 64,
        "scenario": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "nonlinear_cg",
        "stop_condition": {"max_steps": 64},
    }
    csv_path.write_text(
        "status,executed_problem_ir_sha256,solver_mesh_sha256,solver_mesh_signature,"
        "reported_scenario,reported_integrator,reported_relaxation_algorithm,"
        "reported_timestep_policy,steps,executed_steps\n"
        f"ok,{'d' * 64},{expected['solver_mesh_sha256']},"
        f"{expected['solver_mesh_signature']},box500_airbox_exchange_demag,heun,"
        "nonlinear_cg,fixed,64,64\n",
        encoding="utf-8",
    )

    identity = capture.validate_interactive_identity(csv_path, expected)
    assert identity["problem_ir_sha256"] == "d" * 64
    assert identity["requested_steps"] == "64"
    assert identity["executed_steps"] == "64"

    csv_path.write_text(
        "status,executed_problem_ir_sha256,solver_mesh_sha256,solver_mesh_signature,"
        "reported_scenario,reported_integrator,reported_relaxation_algorithm,"
        "reported_timestep_policy,steps,executed_steps\n"
        f"ok,{expected['problem_ir_sha256']},{expected['solver_mesh_sha256']},"
        f"{expected['solver_mesh_signature']},box500_airbox_exchange_demag,heun,"
        "nonlinear_cg,fixed,64,64\n",
        encoding="utf-8",
    )
    equal_identity = capture.validate_interactive_identity(csv_path, expected)
    assert equal_identity["problem_ir_sha256"] == "a" * 64

    actual = capture.read_interactive_identity(csv_path)
    assert actual["problem_ir_sha256"] == "a" * 64
    assert capture.interactive_identity_failures(actual, expected) == []

    csv_path.write_text(
        csv_path.read_text(encoding="utf-8").replace("a" * 64, "A" * 64),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="canonical lowercase SHA-256"):
        capture.validate_interactive_identity(csv_path, expected)


def test_interactive_benchmark_propagates_reported_problem_ir_identity() -> None:
    source = (REPO_ROOT / "scripts/analysis/fem_gpu_benchmark.py").read_text(
        encoding="utf-8"
    )

    assert 'payload.get("executed_problem_ir_sha256")' in source


def test_compute_identity_reads_actual_row_and_rejects_early_completion(
    tmp_path: Path,
) -> None:
    capture = load_capture_module()
    expected = {
        "problem_ir_sha256": "a" * 64,
        "solver_mesh_sha256": "b" * 64,
        "solver_mesh_signature": "c" * 64,
        "scenario": "box500_airbox_exchange_demag",
        "relaxation_algorithm": "nonlinear_cg",
        "stop_condition": {"max_steps": 64},
    }
    csv_path = tmp_path / "compute" / "fixture.csv"
    csv_path.parent.mkdir()
    csv_path.write_text(
        "status,executed_problem_ir_sha256,solver_mesh_sha256,solver_mesh_signature,"
        "reported_scenario,reported_integrator,reported_relaxation_algorithm,"
        "reported_timestep_policy,steps,executed_steps\n"
        f"ok,{'d' * 64},{expected['solver_mesh_sha256']},"
        f"{expected['solver_mesh_signature']},box500_airbox_exchange_demag,heun,"
        "nonlinear_cg,fixed,64,63\n",
        encoding="utf-8",
    )

    actual = capture.read_execution_identity(csv_path, "compute")
    failures = capture.execution_identity_failures(
        actual,
        expected,
        label="compute",
        require_problem_ir_match=True,
    )

    assert actual["problem_ir_sha256"] == "d" * 64
    assert actual["executed_steps"] == "63"
    assert any("canonical fixture" in failure for failure in failures)
    assert any("expected 64, got 63" in failure for failure in failures)


def test_optional_kernel_stats_are_empty_when_nsys_has_no_kernel_table(
    tmp_path: Path,
) -> None:
    capture = load_capture_module()
    prefix = tmp_path / "compute-stats"

    assert capture._stats_rows(prefix, "cuda_gpu_kern_sum", optional=True) == []
    with pytest.raises(ValueError, match="cuda_api_sum"):
        capture._stats_rows(prefix, "cuda_api_sum")


def test_stats_and_timeline_summary_extract_required_metrics() -> None:
    capture = load_capture_module()
    api_csv = """Time (%),Total Time (ns),Num Calls,Name
50.0,4500,3,cudaStreamWaitEvent
50.0,4500,9,cudaLaunchKernel
"""
    kernel_csv = """Time (%),Total Time (ns),Instances,Name
60.0,6000,6,fullmag_reduce_sum
30.0,3000,2,hypre_SpMV
10.0,1000,4,small_kernel
"""
    nvtx_csv = """Time (%),Total Time (ns),Instances,Range
70.0,7000,2,fem.demag.hypre.apply
20.0,2000,2,fem.host.callback
10.0,1000,1,fem.host.publish
"""
    events = [
        {
            "kind": "runtime",
            "name": "cudaLaunchKernel",
            "start_ns": 100,
            "end_ns": 110,
            "thread_id": 1,
        },
        {
            "kind": "runtime",
            "name": "cudaLaunchKernel",
            "start_ns": 200,
            "end_ns": 210,
            "thread_id": 2,
        },
        {
            "kind": "runtime",
            "name": "cudaLaunchKernel",
            "start_ns": 260,
            "end_ns": 270,
            "thread_id": 1,
        },
        {"kind": "kernel", "name": "k0", "start_ns": 100, "end_ns": 220},
        {"kind": "kernel", "name": "k1", "start_ns": 180, "end_ns": 360},
        {
            "kind": "nvtx",
            "name": "fem.preview.snapshot",
            "start_ns": 150,
            "end_ns": 300,
        },
        {
            "kind": "nvtx",
            "name": "fem.host.callback",
            "start_ns": 100,
            "end_ns": 280,
        },
        {
            "kind": "nvtx",
            "name": "fem.host.publish",
            "start_ns": 240,
            "end_ns": 320,
        },
        {
            "kind": "nvtx",
            "name": "fem.host.publish",
            "start_ns": 300,
            "end_ns": 360,
        },
    ]

    summary = capture.summarize_stats(
        capture.parse_nsys_csv(api_csv),
        capture.parse_nsys_csv(kernel_csv),
        capture.parse_nsys_csv(nvtx_csv),
        events,
    )

    assert summary["cpu_launch_gaps_ns"] == {"count": 1, "max": 150, "p50": 150, "p95": 150}
    assert summary["stream_waits"] == {"count": 3, "total_time_ns": 4500}
    assert summary["hypre_apply"] == {"count": 2, "total_time_ns": 7000}
    assert summary["kernels"]["count"] == 12
    assert summary["kernels"]["reduction_count"] == 6
    assert summary["overlap_ns"]["preview_with_gpu"] == 150
    assert summary["overlap_ns"]["callback_with_publish"] == 40


def test_preview_overlap_includes_cuda_memcpy_activity() -> None:
    capture = load_capture_module()
    events = [
        {
            "kind": "nvtx",
            "name": "fem.preview.snapshot",
            "start_ns": 100,
            "end_ns": 300,
        },
        {"kind": "kernel", "name": "kernel", "start_ns": 110, "end_ns": 120},
        {"kind": "memcpy", "name": "memcpy", "start_ns": 200, "end_ns": 260},
    ]

    summary = capture.summarize_stats([], [], [], events)

    assert summary["overlap_ns"]["preview_with_kernels"] == 10
    assert summary["overlap_ns"]["preview_with_memcpy"] == 60
    assert summary["overlap_ns"]["preview_with_gpu"] == 70


def test_sqlite_loader_handles_documented_runtime_kernel_and_nvtx_tables(
    tmp_path: Path,
) -> None:
    capture = load_capture_module()
    database = tmp_path / "timeline.sqlite"
    connection = sqlite3.connect(database)
    connection.executescript(
        """
        CREATE TABLE StringIds (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO StringIds VALUES
            (1, 'cudaLaunchKernel'),
            (2, 'kernel_demangled(double*)'),
            (3, 'fem.preview.snapshot'),
            (4, '_Z16kernel_mangledPd');
        CREATE TABLE CUPTI_ACTIVITY_KIND_RUNTIME (
            start INTEGER, end INTEGER, nameId INTEGER, globalTid INTEGER
        );
        INSERT INTO CUPTI_ACTIVITY_KIND_RUNTIME VALUES (10, 20, 1, 101);
        CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (
            start INTEGER, end INTEGER, shortName INTEGER,
            demangledName INTEGER, globalTid INTEGER
        );
        INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (30, 60, 4, 2, 202);
        CREATE TABLE NVTX_EVENTS (
            start INTEGER, end INTEGER, text TEXT, textId INTEGER, globalTid INTEGER
        );
        INSERT INTO NVTX_EVENTS VALUES (15, 55, NULL, 3, 101);
        CREATE TABLE CUPTI_ACTIVITY_KIND_MEMCPY (
            start INTEGER, end INTEGER, copyKind INTEGER, globalTid INTEGER
        );
        INSERT INTO CUPTI_ACTIVITY_KIND_MEMCPY VALUES (40, 70, 1, 303);
        """
    )
    connection.commit()
    connection.close()

    events = capture.load_timeline_events(database)

    assert events == [
        {
            "kind": "runtime",
            "name": "cudaLaunchKernel",
            "start_ns": 10,
            "end_ns": 20,
            "thread_id": 101,
        },
        {
            "kind": "kernel",
            "name": "kernel_demangled(double*)",
            "start_ns": 30,
            "end_ns": 60,
            "thread_id": 202,
        },
        {
            "kind": "nvtx",
            "name": "fem.preview.snapshot",
            "start_ns": 15,
            "end_ns": 55,
            "thread_id": 101,
        },
        {
            "kind": "memcpy",
            "name": "memcpy",
            "start_ns": 40,
            "end_ns": 70,
            "thread_id": 303,
        },
    ]


def test_ncu_passes_are_individually_bounded_to_top_five_kernels() -> None:
    capture = load_capture_module()
    kernel_rows = [
        {"Name": f"kernel_{index}", "Total Time (ns)": str(100 - index), "Instances": "2"}
        for index in range(7)
    ]

    top = capture.top_kernel_names(kernel_rows)
    commands = capture.build_ncu_commands(
        top,
        ["fullmag", "run-json", "fixture.json"],
        Path("ncu"),
    )

    assert top == [f"kernel_{index}" for index in range(5)]
    assert len(commands) == 5
    for index, (kernel_name, command) in enumerate(zip(top, commands), start=1):
        assert command[0] == "ncu"
        assert command[command.index("--launch-count") + 1] == "1"
        assert command[command.index("--kill") + 1] == "yes"
        assert command[command.index("--rename-kernels") + 1] == "off"
        assert command.count("--section") == 4
        assert command[command.index("--kernel-name") + 1] == kernel_name
        assert command[command.index("--log-file") + 1].endswith(
            f"top-kernel-{index:02d}.csv"
        )
        assert command[command.index("--export") + 1].endswith(
            f"top-kernel-{index:02d}"
        )


def test_ncu_top_kernel_runner_is_outer_bounded_and_preserves_exact_error(
    tmp_path: Path,
) -> None:
    capture = load_capture_module()
    observed: dict[str, object] = {}

    def timeout_runner(command, **kwargs):
        observed["timeout"] = kwargs.get("timeout")
        raise subprocess.TimeoutExpired(
            command,
            kwargs["timeout"],
            output="==ERROR== ERR_NVGPUCTRPERM - permission denied\n",
        )

    result = capture.run_ncu_top_kernel_pass(
        ["ncu", "fixture"],
        tmp_path,
        1,
        {},
        runner=timeout_runner,
    )

    assert observed["timeout"] == capture.NCU_TIMEOUT_SECONDS
    assert result["status"] == "unavailable"
    assert result["error_code"] == "ERR_NVGPUCTRPERM"
    assert result["blocker"] == "ncu top-kernel pass 1 failed: ERR_NVGPUCTRPERM"
    assert "ERR_NVGPUCTRPERM" in (tmp_path / "ncu-01.log").read_text(
        encoding="utf-8"
    )


def test_ncu_access_probe_is_bounded_unfiltered_and_persists_permission_error(
    tmp_path: Path,
) -> None:
    capture = load_capture_module()
    command = capture.build_ncu_access_probe_command(
        ["python3", "fixture.py"], tmp_path / "ncu-access-probe"
    )
    assert command[command.index("--launch-count") + 1] == "1"
    assert command[command.index("--kill") + 1] == "yes"
    assert command[command.index("--section") + 1] == "LaunchStats"
    assert "--kernel-name" not in command

    def denied_runner(*args, **kwargs):
        return subprocess.CompletedProcess(
            args[0],
            1,
            "",
            "==ERROR== ERR_NVGPUCTRPERM - permission denied\n",
        )

    result = capture.run_ncu_access_probe(
        ["python3", "fixture.py"], tmp_path, {}, runner=denied_runner
    )

    assert result["status"] == "unavailable"
    assert result["error_code"] == "ERR_NVGPUCTRPERM"
    assert result["blocker"] == "ncu access probe failed: ERR_NVGPUCTRPERM"
    assert "ERR_NVGPUCTRPERM" in (tmp_path / "ncu-access-probe.log").read_text(
        encoding="utf-8"
    )


def test_ncu_access_probe_is_always_run_before_top_kernel_passes(
    tmp_path: Path, monkeypatch
) -> None:
    capture = load_capture_module()
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "manifest.json").write_text(
        json.dumps({"schema": 2, "instrumentation": {"nvtx_enabled": True}}),
        encoding="utf-8",
    )
    expected = json.loads(capture.FIXTURE_MANIFEST.read_text(encoding="utf-8"))

    def write_identity(path: Path, *, problem_ir: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "status,executed_problem_ir_sha256,solver_mesh_sha256,solver_mesh_signature,"
            "reported_scenario,reported_integrator,reported_relaxation_algorithm,"
            "reported_timestep_policy,steps,executed_steps\n"
            f"ok,{problem_ir},{expected['solver_mesh_sha256']},"
            f"{expected['solver_mesh_signature']},{expected['scenario']},heun,"
            f"{expected['relaxation_algorithm']},fixed,64,64\n",
            encoding="utf-8",
        )

    output_root = tmp_path / "output"
    run_root = output_root / capture.DEFAULT_RUN_ID
    write_identity(
        run_root / "compute" / "fixture.csv",
        problem_ir=expected["problem_ir_sha256"],
    )
    write_identity(run_root / "host" / "fixture.csv", problem_ir="d" * 64)
    nvtx_rows = [{"Range": name, "Instances": "1", "Total Time (ns)": "1"}
                 for name in capture.REQUIRED_NVTX_RANGES]
    kernel_rows = [
        {"Name": f"kernel_{index}", "Total Time (ns)": str(10 - index), "Instances": "1"}
        for index in range(5)
    ]
    monkeypatch.setattr(
        capture,
        "_run_nsys_pass",
        lambda *args, **kwargs: {
            "api_rows": [],
            "kernel_rows": kernel_rows,
            "nvtx_rows": nvtx_rows,
            "events": [],
            "profile_command": [],
            "stats_command": [],
            "export_command": [],
        },
    )
    calls: list[str] = []

    def denied_probe(*args, **kwargs):
        calls.append("probe")
        return {
            "status": "unavailable",
            "error_code": "ERR_NVGPUCTRPERM",
            "blocker": "ncu access probe failed: ERR_NVGPUCTRPERM",
        }

    monkeypatch.setattr(capture, "run_ncu_access_probe", denied_probe)
    monkeypatch.setattr(
        capture,
        "build_ncu_commands",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("top-kernel NCU ran before access probe passed")
        ),
    )
    args = capture.parse_args(
        ["--runtime-root", str(runtime), "--output-dir", str(output_root)]
    )

    assert capture._run_capture(args, {"status": "available", "blockers": []}) == 1
    summary = json.loads((run_root / "summary.json").read_text(encoding="utf-8"))
    assert calls == ["probe"]
    assert summary["ncu_access_probe"]["error_code"] == "ERR_NVGPUCTRPERM"
    assert summary["execution_identities"]["pass_a_compute_run_json"][
        "problem_ir_sha256"
    ] == expected["problem_ir_sha256"]


def test_ncu_csv_is_parsed_into_required_metric_groups() -> None:
    capture = load_capture_module()
    rows = [
        {
            "Kernel Name": "kernel_0",
            "Section Name": "Occupancy",
            "Metric Name": "Achieved Occupancy",
            "Metric Unit": "%",
            "Metric Value": "72.5",
        },
        {
            "Kernel Name": "kernel_0",
            "Section Name": "SpeedOfLight",
            "Metric Name": "DRAM Throughput",
            "Metric Unit": "%",
            "Metric Value": "61.2",
        },
        {
            "Kernel Name": "kernel_0",
            "Section Name": "LaunchStats",
            "Metric Name": "Grid Size",
            "Metric Unit": "block",
            "Metric Value": "1200",
        },
        {
            "Kernel Name": "kernel_0",
            "Section Name": "WarpStateStats",
            "Metric Name": "Stall Long Scoreboard",
            "Metric Unit": "cycle",
            "Metric Value": "3.5",
        },
    ]

    parsed = capture.parse_ncu_metrics(rows)

    assert parsed["kernel_0"]["occupancy"][0]["value"] == "72.5"
    assert parsed["kernel_0"]["achieved_bandwidth"][0]["value"] == "61.2"
    assert parsed["kernel_0"]["launch_grid"][0]["name"] == "Grid Size"
    assert parsed["kernel_0"]["warp_stalls"][0]["name"] == "Stall Long Scoreboard"


def test_ncu_metric_parser_rejects_sections_theoretical_compute_only_and_nonnumeric() -> None:
    capture = load_capture_module()
    rows = [
        {
            "Kernel Name": "kernel_0",
            "Section Name": "Occupancy",
            "Metric Name": "Theoretical Occupancy",
            "Metric Value": "100",
        },
        {
            "Kernel Name": "kernel_0",
            "Section Name": "SpeedOfLight",
            "Metric Name": "SM Compute Throughput",
            "Metric Value": "87.5",
        },
        {
            "Kernel Name": "kernel_0",
            "Section Name": "LaunchStats",
            "Metric Name": "Registers Per Thread",
            "Metric Value": "32",
        },
        {
            "Kernel Name": "kernel_0",
            "Section Name": "WarpStateStats",
            "Metric Name": "Stall Long Scoreboard",
            "Metric Value": "n/a",
        },
    ]

    assert capture.parse_ncu_metrics(rows) == {}


def test_ncu_csv_parser_skips_profiler_preamble() -> None:
    capture = load_capture_module()
    text = '''==PROF== Connected to process 42
"ID","Kernel Name","Section Name","Metric Name","Metric Unit","Metric Value"
"1","kernel_0","Occupancy","Achieved Occupancy","%","72.5"
'''

    rows = capture.parse_ncu_csv(text)

    assert rows == [
        {
            "ID": "1",
            "Kernel Name": "kernel_0",
            "Section Name": "Occupancy",
            "Metric Name": "Achieved Occupancy",
            "Metric Unit": "%",
            "Metric Value": "72.5",
        }
    ]


def test_identity_and_status_artifacts_preserve_run_bundle_and_architectures(tmp_path: Path) -> None:
    capture = load_capture_module()
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    manifest = {
        "schema": 3,
        "source_provenance": {
            "git_commit": "a" * 40,
            "git_tree": "b" * 40,
            "dirty": False,
            "dirty_patch_sha256": None,
            "source_inputs_sha256": "c" * 64,
            "source_input_manifest": "scripts/managed_fem_runtime_source_inputs.v1.txt",
        },
        "build": {
            "requested_cuda_architectures": "80-real;89-real;90-virtual",
            "effective_cuda_architectures": ["sm_80", "sm_89", "compute_90"],
        },
        "native_libraries": {
            "fullmag_fem": {"sha256": "b" * 64},
            "hypre": {"sha256": "c" * 64},
        },
        "instrumentation": {"nvtx_enabled": True},
    }
    manifest_path = runtime / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    identity = capture.collect_bundle_identity(runtime)
    payload = {
        "schema": "fullmag.fem_gpu.nsight_capture.v1",
        "status": "unavailable",
        "run_id": capture.DEFAULT_RUN_ID,
        "bundle": identity,
        "blockers": ["ncu unavailable in managed fixture image"],
    }
    json_path, markdown_path = capture.write_summary_artifacts(tmp_path / "report", payload)

    persisted = json.loads(json_path.read_text(encoding="utf-8"))
    assert persisted["run_id"] == capture.DEFAULT_RUN_ID
    assert persisted["bundle"]["runtime_git_commit"] == "a" * 40
    assert persisted["bundle"]["runtime_source_inputs_sha256"] == "c" * 64
    assert persisted["bundle"]["runtime_dirty"] is False
    assert persisted["bundle"]["libraries"]["fullmag_fem"] == "b" * 64
    assert persisted["bundle"]["requested_cuda_architectures"] == "80-real;89-real;90-virtual"
    assert "status: `unavailable`" in markdown_path.read_text(encoding="utf-8")


def test_commands_use_exact_nsys_reports_and_same_managed_fixture_image() -> None:
    capture = load_capture_module()
    profile = capture.build_nsys_profile_command(
        ["python3", "fixture.py"], Path("timeline")
    )
    assert profile[profile.index("--cuda-flush-interval") + 1] == "1000"
    stats = capture.build_nsys_stats_command(Path("trace.nsys-rep"), Path("stats"))
    assert stats[stats.index("--report") + 1] == "cuda_api_sum,cuda_gpu_kern_sum,nvtx_sum"
    assert "--force-overwrite=true" in stats
    assert "--force-export=true" in stats
    harness = MODULE_PATH.read_text(encoding="utf-8")
    assert "--trace-fork-before-exec=true" not in harness

    justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    recipe = justfile.split("capture-fem-gpu-nsight:", 1)[1].split("\n\n", 1)[0]
    assert recipe.count("fem-gpu") >= 2
    assert recipe.count("--preflight-only") == 2
    assert "FULLMAG_ENABLE_NVTX=1" in recipe
    assert "status=unavailable" in recipe
    assert "prior_target=\"$(readlink \"$active\")\"" in recipe
    assert "trap restore_active EXIT" in recipe
    assert 'ln -sfn "$prior_target" "$next"' in recipe
    assert 'mv -Tf "$next" "$active"' in recipe
    first_preflight = recipe.index("--preflight-only")
    image_build = recipe.index("docker compose --profile fem-gpu build fem-gpu")
    rebuild = recipe.index("FULLMAG_ENABLE_NVTX=1 just rebuild-fem-runtime")
    second_preflight = recipe.index("--preflight-only", first_preflight + 1)
    capture_run = recipe.rindex("capture_fem_gpu_nsight.py")
    assert image_build < first_preflight < rebuild < second_preflight < capture_run
