from __future__ import annotations

import json
from pathlib import Path
import stat
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
CAPTURE = ROOT / "scripts/capture_fem_eigen_k0_periodic_airbox_performance.py"
sys.path.insert(0, str(ROOT / "scripts"))

from verify_fem_eigen_k0_periodic_airbox_performance import (  # noqa: E402
    verify_performance,
)


RECIPE = "run-fem-frequency-domain-eigen-k0-poisson-airbox-performance-case"


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")


def _make_fake_just(tmp_path: Path) -> Path:
    command = tmp_path / "just"
    command.write_text(
        """#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import time

parser = argparse.ArgumentParser()
parser.add_argument("recipe")
parser.add_argument("--run-id")
parser.add_argument("--phase", choices=["run", "cancellation", "sanitizer"], default="run")
args = parser.parse_args()
if args.phase == "cancellation":
    Path(os.environ["FULLMAG_K0_PERFORMANCE_PARTIAL_ARTIFACT"]).parent.mkdir(parents=True, exist_ok=True)
    Path(os.environ["FULLMAG_K0_PERFORMANCE_PARTIAL_ARTIFACT"]).write_text(json.dumps({
        "schema_version": "fem_k0_modal_partial.v1",
        "complete": False,
        "stop_reason": "cancelled",
        "preserved_mode_count": 1,
    }), encoding="utf-8")
elif args.phase == "sanitizer":
    Path(os.environ["FULLMAG_K0_PERFORMANCE_SANITIZER_LOG"]).parent.mkdir(parents=True, exist_ok=True)
    Path(os.environ["FULLMAG_K0_PERFORMANCE_SANITIZER_LOG"]).write_text("ERROR SUMMARY: 0 errors\\n", encoding="utf-8")
else:
    run_id = args.run_id
    signatures = {
        "dof-128-initial": ("fnv1a64:aaaaaaaaaaaaaaaa", False),
        "dof-128-reuse": ("fnv1a64:aaaaaaaaaaaaaaaa", True),
        "dof-256": ("fnv1a64:bbbbbbbbbbbbbbbb", False),
        "dof-512": ("fnv1a64:cccccccccccccccc", False),
    }
    signature, reused = signatures[run_id]
    time.sleep({"dof-128-initial": 0.01, "dof-128-reuse": 0.02, "dof-256": 0.04, "dof-512": 0.08}[run_id])
    diagnostics = {
        "schema_version": "poisson_airbox_modal_eigen_gpu_petsc.v1",
        "status": "ok",
        "execution_lane": "production_gpu",
        "gpu_device_resident_modal_eigensolver": True,
        "fallback_used": False,
        "operator_context_signature": signature,
        "operator_context_reused": reused,
        "augmented_dof_count": {"dof-128-initial": 128, "dof-128-reuse": 128, "dof-256": 256, "dof-512": 512}[run_id],
        "per_iteration_h2d_transfer_count": 0,
        "per_iteration_d2h_transfer_count": 0,
        "per_iteration_full_vector_transfers": 0,
        "hot_loop_allocations": 0,
        "hot_loop_h2d_bytes": 0,
        "hot_loop_d2h_bytes": 0,
    }
    if os.environ.get("FAKE_MISSING_HOT_LOOP_FIELDS") == "1":
        diagnostics.pop("hot_loop_allocations")
    output = Path(os.environ["FULLMAG_K0_PERFORMANCE_NATIVE_DIAGNOSTICS"])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(diagnostics, sort_keys=True), encoding="utf-8")
print("managed K0 performance case complete")
""",
        encoding="utf-8",
    )
    command.chmod(command.stat().st_mode | stat.S_IXUSR)
    return command


def _config(tmp_path: Path) -> tuple[Path, Path]:
    identity = tmp_path / "identity"
    identity.mkdir()
    runtime = identity / "runtime.json"
    source = identity / "source.json"
    environment = identity / "environment.json"
    runtime.write_text("managed runtime\n", encoding="utf-8")
    source.write_text("source snapshot\n", encoding="utf-8")
    environment.write_text("environment\n", encoding="utf-8")
    fake_just = _make_fake_just(tmp_path)
    specs = [
        ("dof-128-initial", 128, "fnv1a64:aaaaaaaaaaaaaaaa", False),
        ("dof-128-reuse", 128, "fnv1a64:aaaaaaaaaaaaaaaa", True),
        ("dof-256", 256, "fnv1a64:bbbbbbbbbbbbbbbb", False),
        ("dof-512", 512, "fnv1a64:cccccccccccccccc", False),
    ]
    config = tmp_path / "config.json"
    _write_json(
        config,
        {
            "schema_version": "fem_k0_modal_performance_capture_config.v1",
            "working_directory": str(tmp_path),
            "managed_command": [str(fake_just), RECIPE],
            "timeout_seconds": 30,
            "runtime_identity": {
                "runtime_bundle": str(runtime),
                "source_snapshot": str(source),
                "environment": str(environment),
            },
            "memory_budget_bytes": 2_000_000_000,
            "max_scaling_exponent": 4.0,
            "runs": [
                {
                    "run_id": run_id,
                    "dof_count": dof_count,
                    "arguments": ["--run-id", run_id],
                    "native_diagnostics": str(tmp_path / "raw" / f"{run_id}.json"),
                }
                for run_id, dof_count, _signature, _reused in specs
            ],
            "cancellation": {
                "arguments": ["--phase", "cancellation"],
                "partial_artifact": str(tmp_path / "raw" / "partial.json"),
            },
            "compute_sanitizer": {
                "arguments": ["--phase", "sanitizer"],
                "log": str(tmp_path / "raw" / "compute-sanitizer.log"),
            },
        },
    )
    return config, tmp_path / "performance.json"


def _run_capture(config: Path, output: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        (sys.executable, str(CAPTURE), "--config", str(config), "--output", str(output)),
        text=True,
        capture_output=True,
        check=False,
    )


def test_capture_runs_each_managed_case_and_emits_verifiable_proof(tmp_path: Path) -> None:
    config, output = _config(tmp_path)
    result = _run_capture(config, output)
    assert result.returncode == 0, result.stderr
    payload = json.loads(output.read_text(encoding="utf-8"))
    verified = verify_performance(payload, base_dir=output.parent)
    assert verified["status"] == "passed"
    assert verified["run_count"] == 4
    assert payload["execution_proof"]["command"][1] == RECIPE
    assert payload["execution_proof"]["exit_code"] == 0
    assert all(run["elapsed_seconds"] > 0 for run in payload["runs"])


def test_capture_rejects_native_diagnostics_without_measured_hot_loop_fields(tmp_path: Path) -> None:
    config, output = _config(tmp_path)
    config_value = json.loads(config.read_text(encoding="utf-8"))
    config_value["environment"] = {"FAKE_MISSING_HOT_LOOP_FIELDS": "1"}
    config.write_text(json.dumps(config_value), encoding="utf-8")
    result = _run_capture(config, output)
    assert result.returncode != 0
    assert "hot_loop_allocations" in result.stderr or "hot_loop_allocations" in result.stdout


def test_capture_rejects_non_managed_command(tmp_path: Path) -> None:
    config, output = _config(tmp_path)
    config_value = json.loads(config.read_text(encoding="utf-8"))
    config_value["managed_command"] = ["python3", "not-managed"]
    config.write_text(json.dumps(config_value), encoding="utf-8")
    result = _run_capture(config, output)
    assert result.returncode != 0
    assert "must name" in result.stderr


def test_just_recipe_dispatches_to_capture_script() -> None:
    result = subprocess.run(
        (
            "just",
            "--dry-run",
            "capture-fem-frequency-domain-eigen-k0-poisson-airbox-performance",
            "config.json",
            "performance.json",
        ),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "capture_fem_eigen_k0_periodic_airbox_performance.py" in (result.stdout + result.stderr)


def test_managed_performance_case_recipe_has_all_fail_closed_phases() -> None:
    result = subprocess.run(
        (
            "just",
            "--dry-run",
            RECIPE,
        ),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    recipe = result.stdout + result.stderr
    assert "docker compose --profile fem-gpu run --rm" in recipe
    assert "FULLMAG_K0_PERFORMANCE_NATIVE_DIAGNOSTICS" in recipe
    assert "FULLMAG_K0_PERFORMANCE_PARTIAL_ARTIFACT" in recipe
    assert "FULLMAG_K0_PERFORMANCE_SANITIZER_LOG" in recipe
    assert "FULLMAG_FEM_EIGEN_CANCEL_AFTER_MS" in recipe
    assert "compute-sanitizer --tool memcheck --error-exitcode 1" in recipe
