from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from verify_fem_eigen_k0_periodic_airbox_performance import (  # noqa: E402
    PerformanceError,
    verify_performance,
)


PERFORMANCE_RECIPE = "run-fem-frequency-domain-eigen-k0-poisson-airbox-performance-case"


def _write_evidence(tmp_path: Path, relative: str, content: bytes) -> dict[str, str]:
    path = tmp_path / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return {
        "path": relative,
        "sha256": "sha256:" + hashlib.sha256(content).hexdigest(),
    }


def _valid_payload(tmp_path: Path) -> dict[str, object]:
    runtime_identity = {
        "producer": "managed_just",
        "recipe": "run-fem-frequency-domain-eigen-k0-poisson-airbox-performance-case",
        "runtime_bundle": _write_evidence(tmp_path, "identity/runtime.json", b"runtime"),
        "source_snapshot": _write_evidence(tmp_path, "identity/source.txt", b"source"),
        "environment": _write_evidence(tmp_path, "identity/environment.json", b"environment"),
    }
    run_specs = [
        ("dof-128-initial", 128, 1.0, 100_000_000, "fnv1a64:aaaaaaaaaaaaaaaa", False),
        ("dof-128-reuse", 128, 1.1, 110_000_000, "fnv1a64:aaaaaaaaaaaaaaaa", True),
        ("dof-256", 256, 3.0, 200_000_000, "fnv1a64:bbbbbbbbbbbbbbbb", False),
        ("dof-512", 512, 10.0, 400_000_000, "fnv1a64:cccccccccccccccc", False),
    ]
    runs: list[dict[str, object]] = []
    for run_id, dof_count, elapsed, peak_memory, signature, reused in run_specs:
        native_diagnostics = {
            "schema_version": "poisson_airbox_modal_eigen_gpu_petsc.v1",
            "status": "ok",
            "execution_lane": "production_gpu",
            "gpu_device_resident_modal_eigensolver": True,
            "fallback_used": False,
            "operator_context_signature": signature,
            "operator_context_reused": reused,
            "augmented_dof_count": dof_count,
            "per_iteration_h2d_transfer_count": 0,
            "per_iteration_d2h_transfer_count": 0,
            "per_iteration_full_vector_transfers": 0,
            "hot_loop_allocations": 0,
            "hot_loop_h2d_bytes": 0,
            "hot_loop_d2h_bytes": 0,
        }
        native_diagnostics_ref = _write_evidence(
            tmp_path,
            f"runs/{run_id}.native-diagnostics.json",
            json.dumps(native_diagnostics, sort_keys=True).encode("utf-8"),
        )
        runtime_telemetry = {
            "schema_version": "fem_k0_modal_performance_telemetry.v1",
            "measurement_source": "managed_native_runtime",
            "run_id": run_id,
            "dof_count": dof_count,
            "elapsed_seconds": elapsed,
            "peak_memory_bytes": peak_memory,
            "hot_loop_allocations": 0,
            "hot_loop_h2d_bytes": 0,
            "hot_loop_d2h_bytes": 0,
        }
        runtime_telemetry_ref = _write_evidence(
            tmp_path,
            f"runs/{run_id}.runtime-telemetry.json",
            json.dumps(runtime_telemetry, sort_keys=True).encode("utf-8"),
        )
        run = {
            "run_id": run_id,
            "dof_count": dof_count,
            "elapsed_seconds": elapsed,
            "peak_memory_bytes": peak_memory,
            "operator_context_signature": signature,
            "operator_context_reused": reused,
            "hot_loop_allocations": 0,
            "hot_loop_h2d_bytes": 0,
            "hot_loop_d2h_bytes": 0,
            "native_diagnostics": native_diagnostics_ref,
            "runtime_telemetry": runtime_telemetry_ref,
        }
        artifact = {
            "schema_version": "fem_k0_modal_performance_run.v1",
            **run,
        }
        run["evidence"] = _write_evidence(
            tmp_path,
            f"runs/{run_id}.json",
            json.dumps(artifact, sort_keys=True).encode("utf-8"),
        )
        runs.append(run)
    execution_stdout = _write_evidence(
        tmp_path,
        "execution/performance.stdout.json",
        json.dumps(
            {
                "schema_version": "fem_k0_modal_performance_stdout.v1",
                "status": "passed",
                "run_ids": [run["run_id"] for run in runs],
                "cancellation_status": "passed",
                "sanitizer_error_count": 0,
            },
            sort_keys=True,
        ).encode("utf-8"),
    )
    execution_stderr = _write_evidence(
        tmp_path, "execution/performance.stderr.log", b""
    )
    return {
        "schema_version": "fem_k0_modal_performance.v1",
        "status": "passed",
        "device": "gpu",
        "precision": "double",
        "runtime_identity": runtime_identity,
        "execution_proof": {
            "schema_version": "fem_k0_modal_performance_execution.v1",
            "command": ["just", PERFORMANCE_RECIPE],
            "exit_code": 0,
            "executed_at": "2026-08-05T12:00:00Z",
            "runtime_bundle_sha256": runtime_identity["runtime_bundle"]["sha256"],
            "runtime_source_snapshot_sha256": runtime_identity["source_snapshot"]["sha256"],
            "stdout": execution_stdout,
            "stderr": execution_stderr,
        },
        "memory_budget_bytes": 2_000_000_000,
        "max_scaling_exponent": 4.0,
        "runs": runs,
        "cancellation": {
            "status": "passed",
            "partial_artifacts_preserved": True,
            "partial_artifact": _write_evidence(
                tmp_path,
                "cancellation/partial.json",
                json.dumps(
                    {
                        "schema_version": "fem_k0_modal_partial.v1",
                        "complete": False,
                        "stop_reason": "cancelled",
                        "preserved_mode_count": 1,
                    },
                    sort_keys=True,
                ).encode("utf-8"),
            ),
        },
        "compute_sanitizer": {
            "status": "passed",
            "error_count": 0,
            "log": _write_evidence(tmp_path, "sanitizer/compute-sanitizer.log", b"ERROR SUMMARY: 0 errors"),
        },
    }


def _rewrite_run_artifact(
    payload: dict[str, object], tmp_path: Path, index: int, updates: dict[str, object]
) -> None:
    run = payload["runs"][index]  # type: ignore[index]
    reference = run["evidence"]  # type: ignore[index]
    path = tmp_path / reference["path"]  # type: ignore[index]
    artifact = json.loads(path.read_text(encoding="utf-8"))
    artifact.update(updates)
    content = json.dumps(artifact, sort_keys=True).encode("utf-8")
    path.write_bytes(content)
    reference["sha256"] = "sha256:" + hashlib.sha256(content).hexdigest()  # type: ignore[index]


def test_performance_accepts_three_sizes_reuse_and_invalidation(tmp_path: Path) -> None:
    result = verify_performance(_valid_payload(tmp_path), base_dir=tmp_path)
    assert result["status"] == "passed"
    assert result["run_count"] == 4
    assert result["context_reuse_count"] == 1
    assert result["context_invalidation_count"] == 2


def test_performance_rejects_hot_loop_transfer(tmp_path: Path) -> None:
    payload = _valid_payload(tmp_path)
    payload["runs"][1]["hot_loop_h2d_bytes"] = 8  # type: ignore[index]
    with pytest.raises(PerformanceError, match="hot_loop_h2d_bytes"):
        verify_performance(payload, base_dir=tmp_path)


def test_performance_rejects_missing_managed_execution_proof(tmp_path: Path) -> None:
    payload = _valid_payload(tmp_path)
    payload.pop("execution_proof")
    with pytest.raises(PerformanceError, match="execution_proof"):
        verify_performance(payload, base_dir=tmp_path)


def test_performance_rejects_missing_context_invalidation(tmp_path: Path) -> None:
    payload = _valid_payload(tmp_path)
    payload["runs"][2]["operator_context_signature"] = "fnv1a64:aaaaaaaaaaaaaaaa"  # type: ignore[index]
    payload["runs"][2]["operator_context_reused"] = False  # type: ignore[index]
    payload["runs"][3]["operator_context_signature"] = "fnv1a64:aaaaaaaaaaaaaaaa"  # type: ignore[index]
    payload["runs"][3]["operator_context_reused"] = False  # type: ignore[index]
    _rewrite_run_artifact(
        payload,
        tmp_path,
        2,
        {
            "operator_context_signature": "fnv1a64:aaaaaaaaaaaaaaaa",
            "operator_context_reused": False,
        },
    )
    _rewrite_run_artifact(
        payload,
        tmp_path,
        3,
        {
            "operator_context_signature": "fnv1a64:aaaaaaaaaaaaaaaa",
            "operator_context_reused": False,
        },
    )
    with pytest.raises(PerformanceError, match="operator_context_signature"):
        verify_performance(payload, base_dir=tmp_path)


def test_performance_rejects_sanitizer_failure(tmp_path: Path) -> None:
    payload = _valid_payload(tmp_path)
    payload["compute_sanitizer"] = {"status": "failed", "error_count": 1}
    with pytest.raises(PerformanceError, match="Compute Sanitizer"):
        verify_performance(payload, base_dir=tmp_path)


def test_performance_rejects_untyped_cancellation_artifact(tmp_path: Path) -> None:
    payload = _valid_payload(tmp_path)
    reference = payload["cancellation"]["partial_artifact"]  # type: ignore[index]
    path = tmp_path / reference["path"]  # type: ignore[index]
    path.write_bytes(b"partial")
    reference["sha256"] = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()  # type: ignore[index]
    with pytest.raises(PerformanceError, match="partial_artifact"):
        verify_performance(payload, base_dir=tmp_path)


def test_performance_rejects_missing_native_diagnostics(tmp_path: Path) -> None:
    payload = _valid_payload(tmp_path)
    payload["runs"][0].pop("native_diagnostics")  # type: ignore[index]
    with pytest.raises(PerformanceError, match="native_diagnostics"):
        verify_performance(payload, base_dir=tmp_path)


def test_performance_rejects_gpu_diagnostics_that_claim_fallback(tmp_path: Path) -> None:
    payload = _valid_payload(tmp_path)
    run = payload["runs"][0]  # type: ignore[index]
    reference = run["native_diagnostics"]  # type: ignore[index]
    path = tmp_path / reference["path"]  # type: ignore[index]
    diagnostics = json.loads(path.read_text(encoding="utf-8"))
    diagnostics["fallback_used"] = True
    content = json.dumps(diagnostics, sort_keys=True).encode("utf-8")
    path.write_bytes(content)
    reference["sha256"] = "sha256:" + hashlib.sha256(content).hexdigest()  # type: ignore[index]
    artifact_ref = run["evidence"]  # type: ignore[index]
    artifact_path = tmp_path / artifact_ref["path"]  # type: ignore[index]
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    artifact["native_diagnostics"] = reference
    artifact_content = json.dumps(artifact, sort_keys=True).encode("utf-8")
    artifact_path.write_bytes(artifact_content)
    artifact_ref["sha256"] = "sha256:" + hashlib.sha256(artifact_content).hexdigest()  # type: ignore[index]
    with pytest.raises(PerformanceError, match="fallback"):
        verify_performance(payload, base_dir=tmp_path)


def test_performance_rejects_native_diagnostics_without_hot_loop_telemetry(tmp_path: Path) -> None:
    payload = _valid_payload(tmp_path)
    run = payload["runs"][0]  # type: ignore[index]
    reference = run["native_diagnostics"]  # type: ignore[index]
    path = tmp_path / reference["path"]  # type: ignore[index]
    diagnostics = json.loads(path.read_text(encoding="utf-8"))
    diagnostics.pop("hot_loop_allocations")
    content = json.dumps(diagnostics, sort_keys=True).encode("utf-8")
    path.write_bytes(content)
    reference["sha256"] = "sha256:" + hashlib.sha256(content).hexdigest()  # type: ignore[index]
    artifact_ref = run["evidence"]  # type: ignore[index]
    artifact_path = tmp_path / artifact_ref["path"]  # type: ignore[index]
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    artifact["native_diagnostics"] = reference
    artifact_content = json.dumps(artifact, sort_keys=True).encode("utf-8")
    artifact_path.write_bytes(artifact_content)
    artifact_ref["sha256"] = "sha256:" + hashlib.sha256(artifact_content).hexdigest()  # type: ignore[index]
    with pytest.raises(PerformanceError, match="hot_loop_allocations"):
        verify_performance(payload, base_dir=tmp_path)


def test_performance_rejects_runtime_telemetry_mismatch(tmp_path: Path) -> None:
    payload = _valid_payload(tmp_path)
    run = payload["runs"][0]  # type: ignore[index]
    reference = run["runtime_telemetry"]  # type: ignore[index]
    path = tmp_path / reference["path"]  # type: ignore[index]
    telemetry = json.loads(path.read_text(encoding="utf-8"))
    telemetry["elapsed_seconds"] = 99.0
    content = json.dumps(telemetry, sort_keys=True).encode("utf-8")
    path.write_bytes(content)
    reference["sha256"] = "sha256:" + hashlib.sha256(content).hexdigest()  # type: ignore[index]
    artifact_ref = run["evidence"]  # type: ignore[index]
    artifact_path = tmp_path / artifact_ref["path"]  # type: ignore[index]
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    artifact["runtime_telemetry"] = reference
    artifact_content = json.dumps(artifact, sort_keys=True).encode("utf-8")
    artifact_path.write_bytes(artifact_content)
    artifact_ref["sha256"] = "sha256:" + hashlib.sha256(artifact_content).hexdigest()  # type: ignore[index]
    with pytest.raises(PerformanceError, match="runtime_telemetry"):
        verify_performance(payload, base_dir=tmp_path)


def test_performance_cli_fixture_is_json_serializable(tmp_path: Path) -> None:
    path = tmp_path / "performance.json"
    path.write_text(json.dumps(_valid_payload(tmp_path)), encoding="utf-8")
    assert json.loads(path.read_text(encoding="utf-8"))["schema_version"] == (
        "fem_k0_modal_performance.v1"
    )
