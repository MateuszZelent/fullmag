from __future__ import annotations

import importlib.util
import hashlib
import json
import sys
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parent / "analysis" / "benchmark_fem_gpu_runtime_architectures.py"
HARNESS_SCRIPT = Path(__file__).resolve().parent / "build_managed_fem_gpu_runner_harness.sh"
HARNESS_PUBLISHER = Path(__file__).resolve().parent / "publish_fem_gpu_runner_harness.py"
JUSTFILE = Path(__file__).resolve().parents[1] / "justfile"


def load_module():
    spec = importlib.util.spec_from_file_location("benchmark_fem_gpu_runtime_architectures", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_cache_directory_must_be_new_or_empty(tmp_path: Path) -> None:
    module = load_module()
    cache = tmp_path / "cache"
    module.prepare_empty_cache(cache)
    assert cache.is_dir()
    (cache / "compiled.bin").write_bytes(b"cached")

    with pytest.raises(ValueError, match="not empty"):
        module.prepare_empty_cache(cache)


def test_same_runner_is_pinned_to_each_selected_runtime(tmp_path: Path) -> None:
    module = load_module()
    repo = tmp_path / "repo"
    python_extension_root = tmp_path / "candidate"
    runner = tmp_path / "runner-harness" / "fullmag-fem-gpu-bin"
    baseline = tmp_path / "baseline"
    candidate = tmp_path / "candidate-libraries"

    baseline_env = module.runtime_environment(
        repo, python_extension_root, runner, baseline, tmp_path / "a"
    )
    candidate_env = module.runtime_environment(
        repo, python_extension_root, runner, candidate, tmp_path / "b"
    )

    assert baseline_env["FULLMAG_BENCH_GPU_BIN"] == str(runner)
    assert candidate_env["FULLMAG_BENCH_GPU_BIN"] == str(runner)
    assert baseline_env["FULLMAG_FEM_RUNTIME_ROOT"] == str(baseline)
    assert candidate_env["FULLMAG_FEM_RUNTIME_ROOT"] == str(candidate)
    assert baseline_env["LD_LIBRARY_PATH"].split(":", 1)[0] == str(baseline / "lib")
    assert candidate_env["LD_LIBRARY_PATH"].split(":", 1)[0] == str(candidate / "lib")
    assert str(python_extension_root) in baseline_env["PYTHONPATH"].split(":")
    assert str(runner.parent) not in baseline_env["PYTHONPATH"].split(":")
    assert baseline_env["FULLMAG_BENCH_DOMAIN_HMAX"] == "5e-08"
    assert baseline_env["FULLMAG_BENCH_AIRBOX_HMAX"] == "1e-07"


def test_logged_run_requests_persistent_raw_case_output(tmp_path: Path, monkeypatch) -> None:
    module = load_module()
    captured = {}

    def fake_run(command, **kwargs):
        captured.update(kwargs)
        return type("Completed", (), {"stdout": "ok", "stderr": "", "returncode": 0})()

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    log_path = tmp_path / "trial.log"
    module.run_logged(["true"], cwd=tmp_path, env={}, log_path=log_path)

    assert captured["env"]["FULLMAG_BENCH_RAW_CASE_OUTPUT"] == str(
        tmp_path / "trial.case-output.log"
    )


def test_benchmark_command_separates_cold_and_steady_repeats(tmp_path: Path) -> None:
    module = load_module()
    cold = module.benchmark_command(tmp_path, repeat=1, warmup=False, output=tmp_path / "cold.csv")
    steady = module.benchmark_command(tmp_path, repeat=5, warmup=True, output=tmp_path / "steady.csv")

    assert cold[cold.index("--repeat") + 1] == "1"
    assert "--gpu-warmup" not in cold
    assert steady[steady.index("--repeat") + 1] == "5"
    assert "--gpu-warmup" in steady
    assert steady[steady.index("--steps") + 1] == "64"


def test_benchmark_script_uses_a_writable_per_run_workspace(tmp_path: Path) -> None:
    spec = importlib.util.spec_from_file_location(
        "fem_gpu_benchmark", Path(__file__).parent / "analysis/fem_gpu_benchmark.py"
    )
    assert spec is not None and spec.loader is not None
    benchmark = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = benchmark
    spec.loader.exec_module(benchmark)

    command = benchmark.script_execution_command(tmp_path / "fullmag", tmp_path / "run")

    assert command[command.index("--workspace-root") + 1] == str(
        tmp_path / "run/workspace-history"
    )


def test_script_run_summary_is_extracted_after_benchmark_output(tmp_path: Path) -> None:
    spec = importlib.util.spec_from_file_location(
        "fem_gpu_benchmark_summary", Path(__file__).parent / "analysis/fem_gpu_benchmark.py"
    )
    assert spec is not None and spec.loader is not None
    benchmark = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = benchmark
    spec.loader.exec_module(benchmark)
    output = """BENCHMARK_RESULT={\"status\":\"ok\"}
solver log
{
  \"status\": \"completed\",
  \"backend_create_wall_time_ns\": 123000,
  \"first_accepted_step_demag_solver_apply_wall_time_ns\": 45000,
  \"workspace_dir\": \"/tmp/workspace\"
}
"""

    summary = benchmark.parse_script_run_summary(output)

    assert summary is not None
    assert summary["backend_create_wall_time_ns"] == 123000
    assert summary["first_accepted_step_demag_solver_apply_wall_time_ns"] == 45000

    run_json_summary = benchmark.parse_script_run_summary(
        '{"status":"completed","backend_create_wall_time_ns":91,'
        '"first_accepted_step_demag_solver_apply_wall_time_ns":41,"output_dir":"/tmp/run"}'
    )
    assert run_json_summary is not None
    assert run_json_summary["backend_create_wall_time_ns"] == 91


def test_localized_fixture_preserves_task0_physical_contract(tmp_path: Path) -> None:
    module = load_module()
    localized_manifest, localized_environment, identity = (
        module.write_localized_fixture_identity(
            module.REPO_ROOT,
            tmp_path,
            {
                "status": "ok",
                "solver_mesh_signature": "a" * 64,
                "executed_problem_ir_sha256": "b" * 64,
                "node_count": "1200",
                "element_count": "5138",
                "reported_scenario": "box500_airbox_exchange_demag",
                "reported_relaxation_algorithm": "nonlinear_cg",
                "steps": "64",
                "executed_steps": "64",
                "requested_demag_solver": "CG",
                "requested_demag_preconditioner": "AMG",
                "requested_demag_amg_relax_type": "6",
                "requested_demag_relative_tolerance": "1e-12",
            },
        )
    )

    manifest = json.loads(localized_manifest.read_text(encoding="utf-8"))
    environment = json.loads(localized_environment.read_text(encoding="utf-8"))
    source = json.loads(module.TASK0_FIXTURE_MANIFEST.read_text(encoding="utf-8"))
    assert manifest["solver_mesh_sha256"] == module.TASK0_SOLVER_MESH_SHA256
    assert manifest["solver_mesh_sha256"] == source["solver_mesh_sha256"]
    assert manifest["node_count"] == 1200
    assert manifest["element_count"] == 5138
    assert manifest["domain_hmax_m"] == 50e-9
    assert manifest["airbox_hmax_m"] == 100e-9
    assert manifest["problem_ir_sha256"] == "b" * 64
    assert manifest["solver_mesh_signature"] == "a" * 64
    assert Path(manifest["solver_mesh_path"]).resolve() == module.TASK0_SOLVER_MESH.resolve()
    assert environment["fixture"]["manifest_sha256"] == identity["manifest_sha256"]


def test_cross_variant_rows_must_match_localized_ir_and_mesh_identity() -> None:
    module = load_module()
    identity = {
        "problem_ir_sha256": "same-ir",
        "solver_mesh_signature": "same-mesh",
    }
    row = {
        "executed_problem_ir_sha256": "same-ir",
        "solver_mesh_signature": "same-mesh",
    }
    module.verify_cross_variant_fixture_identity([row], [dict(row)], identity)

    mismatched = dict(row, solver_mesh_signature="different-mesh")
    with pytest.raises(ValueError, match="localized fixture identity"):
        module.verify_cross_variant_fixture_identity([row], [mismatched], identity)


def test_ab_requires_explicit_common_runner_harness(tmp_path: Path) -> None:
    module = load_module()
    args = module.parse_args(
        [
            "--baseline-variant",
            "baseline",
            "--candidate-variant",
            "candidate",
            "--runner",
            str(tmp_path / "harness/fullmag-fem-gpu-bin"),
            "--output-dir",
            str(tmp_path / "report"),
        ]
    )

    assert args.runner == tmp_path / "harness/fullmag-fem-gpu-bin"


def test_runner_harness_must_be_independent_and_hash_addressed(tmp_path: Path) -> None:
    module = load_module()
    baseline = tmp_path / "variants/baseline"
    candidate = tmp_path / "variants/candidate"
    baseline.mkdir(parents=True)
    candidate.mkdir(parents=True)
    candidate_manifest = candidate / "manifest.json"
    candidate_manifest.write_text('{"schema": 2}\n', encoding="utf-8")
    candidate_manifest_sha256 = hashlib.sha256(candidate_manifest.read_bytes()).hexdigest()

    worker_bytes = b"instrumented-runner"
    worker_sha256 = hashlib.sha256(worker_bytes).hexdigest()
    harness_id = hashlib.sha256(
        f"{worker_sha256}:{candidate_manifest_sha256}".encode("ascii")
    ).hexdigest()
    harness_root = tmp_path / "runners/fem-gpu-task6" / harness_id
    harness_root.mkdir(parents=True)
    runner = harness_root / "fullmag-fem-gpu-bin"
    runner.write_bytes(worker_bytes)
    runner.chmod(0o755)
    (harness_root / "manifest.json").write_text(
        json.dumps(
            {
                "schema": "fullmag.fem_gpu.runner_harness.v1",
                "worker": "fullmag-fem-gpu-bin",
                "worker_sha256": worker_sha256,
                "source_candidate_manifest_sha256": candidate_manifest_sha256,
                "harness_id": harness_id,
            }
        ),
        encoding="utf-8",
    )

    assert (
        module.validate_runner_harness(runner, baseline, candidate)
        == worker_sha256
    )

    nested_runner = candidate / "bin/fullmag-fem-gpu-bin"
    nested_runner.parent.mkdir()
    nested_runner.write_bytes(worker_bytes)
    nested_runner.chmod(0o755)
    with pytest.raises(ValueError, match="independent"):
        module.validate_runner_harness(nested_runner, baseline, candidate)


def test_runner_harness_build_is_managed_cli_only_and_candidate_immutable() -> None:
    source = HARNESS_SCRIPT.read_text(encoding="utf-8")
    publisher = HARNESS_PUBLISHER.read_text(encoding="utf-8")
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert "docker compose --profile fem-gpu run --rm -T --no-deps" in source
    assert "cargo +nightly build" in source
    assert "-p fullmag-cli" in source
    assert "-p fullmag-api" not in source
    assert "-p fullmag-py-core" not in source
    assert ".fullmag/runners/fem-gpu-task6" in source
    assert "fullmag.fem_gpu.runner_harness.v1" in publisher
    assert "source_candidate_manifest_sha256" in publisher
    assert "loader_trace" in publisher
    assert "cp " not in source or "${candidate_root}" not in source.split("cp ", 1)[1]
    assert (
        "build-fem-gpu-task6-runner-harness candidate_variant:" in justfile
    )
    assert (
        "benchmark-fem-gpu-runtime-architecture-ab baseline_variant candidate_variant runner output_dir:"
        in justfile
    )
    ensure_recipe = justfile.split("ensure-managed-fem-runtime:", 1)[1].split(
        "inspect-managed-fem-frequency-domain-deps:", 1
    )[0]
    assert "capture_source_snapshot_identity.py" in ensure_recipe
    assert '--require-source-snapshot-sha256 "$source_snapshot"' in ensure_recipe
    assert "runtime_source_change_policy.py" in ensure_recipe
    assert "FULLMAG_FEM_RUNTIME_REUSE_BUILD=0 just rebuild-fem-runtime" in ensure_recipe
    assert "-newer" not in ensure_recipe
    assert "if [ ! -L .fullmag/runtimes/fem-gpu-host ]" not in ensure_recipe
