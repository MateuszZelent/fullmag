#!/usr/bin/env python3
"""Fail-closed performance and residency gate for the FEM K0 GPU lane."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any


_SHA256_PREFIX = "sha256:"
_PERFORMANCE_RECIPE = "run-fem-frequency-domain-eigen-k0-poisson-airbox-performance-case"
_RFC3339_UTC = re.compile(
    r"^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$"
)


class PerformanceError(ValueError):
    """Raised when a K0 performance/residency contract is not met."""


def _fail(message: str) -> None:
    raise PerformanceError(message)


def _number(value: Any, path: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{path} must be numeric")
    result = float(value)
    if not math.isfinite(result) or (positive and result <= 0.0):
        _fail(f"{path} must be finite and {'positive' if positive else 'non-negative'}")
    if not positive and result < 0.0:
        _fail(f"{path} must be non-negative")
    return result


def _integer(value: Any, path: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(f"{path} must be an integer")
    if value < (1 if positive else 0):
        _fail(f"{path} must be {'positive' if positive else 'non-negative'}")
    return value


def _sha256_file(path: Path, field: str) -> str:
    if not path.is_file():
        _fail(f"{field} must resolve to a regular file")
    return _SHA256_PREFIX + hashlib.sha256(path.read_bytes()).hexdigest()


def _resolve_hashed_file(raw: Any, *, base_dir: Path, field: str) -> Path:
    if not isinstance(raw, dict) or set(raw) != {"path", "sha256"}:
        _fail(f"{field} must contain exactly path and sha256")
    relative = raw["path"]
    digest = raw["sha256"]
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        _fail(f"{field}.path must be a non-empty relative path")
    if (
        not isinstance(digest, str)
        or not digest.startswith(_SHA256_PREFIX)
        or len(digest) != len(_SHA256_PREFIX) + 64
        or any(character not in "0123456789abcdef" for character in digest[len(_SHA256_PREFIX) :])
    ):
        _fail(f"{field}.sha256 must be a lowercase sha256:<64 hex chars> token")
    try:
        candidate = (base_dir / relative).resolve()
        candidate.relative_to(base_dir.resolve())
    except ValueError:
        _fail(f"{field}.path must remain inside the performance evidence directory")
    actual = _sha256_file(candidate, field)
    if digest != actual:
        _fail(f"{field}.sha256 does not match {actual}")
    return candidate


def _read_json_file(path: Path, field: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail(f"{field} is not valid UTF-8 JSON: {exc}")
    if not isinstance(value, dict):
        _fail(f"{field} must contain a JSON object")
    return value


def _validate_native_diagnostics(
    raw: Any,
    *,
    base_dir: Path,
    index: int,
    run: dict[str, Any],
) -> None:
    path = _resolve_hashed_file(
        raw,
        base_dir=base_dir,
        field=f"runs[{index}].native_diagnostics",
    )
    diagnostics = _read_json_file(path, f"runs[{index}].native_diagnostics")
    if diagnostics.get("schema_version") not in {
        "poisson_airbox_modal_eigen_gpu_petsc.v1",
        "frequency_domain_modal_solver_diagnostics.v1",
    }:
        _fail(f"runs[{index}].native_diagnostics has an unsupported schema")
    if diagnostics.get("status") != "ok":
        _fail(f"runs[{index}].native_diagnostics must report status=ok")
    if diagnostics.get("execution_lane") != "production_gpu":
        _fail(
            f"runs[{index}].native_diagnostics must report execution_lane=production_gpu"
        )
    if diagnostics.get("gpu_device_resident_modal_eigensolver") is not True:
        _fail(
            f"runs[{index}].native_diagnostics must prove GPU device-resident modal execution"
        )
    if diagnostics.get("fallback_used") is not False:
        _fail(f"runs[{index}].native_diagnostics must prove fallback_used=false")
    augmented_dof_count = _integer(
        diagnostics.get("augmented_dof_count"),
        f"runs[{index}].native_diagnostics.augmented_dof_count",
        positive=True,
    )
    if augmented_dof_count != run.get("dof_count"):
        _fail(
            f"runs[{index}].native_diagnostics.augmented_dof_count disagrees with the measured DOF record"
        )
    for field in (
        "operator_context_signature",
        "operator_context_reused",
    ):
        if diagnostics.get(field) != run.get(field):
            _fail(
                f"runs[{index}].native_diagnostics.{field} disagrees with the run record"
            )
    for field in (
        "per_iteration_h2d_transfer_count",
        "per_iteration_d2h_transfer_count",
        "per_iteration_full_vector_transfers",
    ):
        if _integer(
            diagnostics.get(field), f"runs[{index}].native_diagnostics.{field}"
        ) != 0:
            _fail(
                f"runs[{index}].native_diagnostics.{field} must be zero in the hot loop"
            )
    for field in ("hot_loop_allocations", "hot_loop_h2d_bytes", "hot_loop_d2h_bytes"):
        if _integer(
            diagnostics.get(field), f"runs[{index}].native_diagnostics.{field}"
        ) != 0:
            _fail(
                f"runs[{index}].native_diagnostics.{field} must be zero in the production hot loop"
            )


def _validate_runtime_telemetry(
    raw: Any,
    *,
    base_dir: Path,
    index: int,
    run: dict[str, Any],
) -> None:
    path = _resolve_hashed_file(
        raw,
        base_dir=base_dir,
        field=f"runs[{index}].runtime_telemetry",
    )
    telemetry = _read_json_file(path, f"runs[{index}].runtime_telemetry")
    if telemetry.get("schema_version") != "fem_k0_modal_performance_telemetry.v1":
        _fail(f"runs[{index}].runtime_telemetry has an unsupported schema")
    if telemetry.get("measurement_source") != "managed_native_runtime":
        _fail(
            f"runs[{index}].runtime_telemetry must be measured by managed_native_runtime"
        )
    for field in (
        "run_id",
        "dof_count",
        "elapsed_seconds",
        "peak_memory_bytes",
        "hot_loop_allocations",
        "hot_loop_h2d_bytes",
        "hot_loop_d2h_bytes",
    ):
        if telemetry.get(field) != run.get(field):
            _fail(
                f"runs[{index}].runtime_telemetry.{field} disagrees with the run record"
            )


def _validate_runtime_identity(value: Any, base_dir: Path) -> None:
    if not isinstance(value, dict):
        _fail("runtime_identity must be an object")
    required = {"producer", "recipe", "runtime_bundle", "source_snapshot", "environment"}
    if set(value) != required:
        _fail(f"runtime_identity must contain exactly {sorted(required)!r}")
    if value["producer"] != "managed_just":
        _fail("runtime_identity.producer must be managed_just")
    if value["recipe"] != _PERFORMANCE_RECIPE:
        _fail(f"runtime_identity.recipe must be {_PERFORMANCE_RECIPE}")
    for field in ("runtime_bundle", "source_snapshot", "environment"):
        _resolve_hashed_file(value[field], base_dir=base_dir, field=f"runtime_identity.{field}")


def _validate_run_artifact(raw: dict[str, Any], index: int, base_dir: Path) -> None:
    path = _resolve_hashed_file(
        raw.get("evidence"),
        base_dir=base_dir,
        field=f"runs[{index}].evidence",
    )
    artifact = _read_json_file(path, f"runs[{index}].evidence")
    if artifact.get("schema_version") != "fem_k0_modal_performance_run.v1":
        _fail(
            f"runs[{index}].evidence.schema_version must be "
            "fem_k0_modal_performance_run.v1"
        )
    mirrored_fields = (
        "run_id",
        "dof_count",
        "elapsed_seconds",
        "peak_memory_bytes",
        "operator_context_signature",
        "operator_context_reused",
        "hot_loop_allocations",
        "hot_loop_h2d_bytes",
        "hot_loop_d2h_bytes",
    )
    for field in mirrored_fields:
        if artifact.get(field) != raw.get(field):
            _fail(f"runs[{index}].evidence.{field} disagrees with the run record")
    for field in ("native_diagnostics", "runtime_telemetry"):
        if artifact.get(field) != raw.get(field):
            _fail(f"runs[{index}].evidence.{field} disagrees with the run record")
    _validate_native_diagnostics(
        artifact.get("native_diagnostics"),
        base_dir=base_dir,
        index=index,
        run=raw,
    )
    _validate_runtime_telemetry(
        artifact.get("runtime_telemetry"),
        base_dir=base_dir,
        index=index,
        run=raw,
    )


def _validate_execution_proof(
    value: Any,
    *,
    base_dir: Path,
    runtime_identity: dict[str, Any],
    run_ids: list[str],
) -> None:
    if not isinstance(value, dict):
        _fail("execution_proof must be an object")
    required = {
        "schema_version",
        "command",
        "exit_code",
        "executed_at",
        "runtime_bundle_sha256",
        "runtime_source_snapshot_sha256",
        "stdout",
        "stderr",
    }
    if set(value) != required:
        _fail(f"execution_proof must contain exactly {sorted(required)!r}")
    if value["schema_version"] != "fem_k0_modal_performance_execution.v1":
        _fail("execution_proof.schema_version is unsupported")
    command = value["command"]
    if (
        not isinstance(command, list)
        or not command
        or any(not isinstance(part, str) or not part or "\x00" in part for part in command)
    ):
        _fail("execution_proof.command must be a non-empty argv array")
    if isinstance(value["exit_code"], bool) or not isinstance(value["exit_code"], int):
        _fail("execution_proof.exit_code must be an integer")
    if value["exit_code"] != 0:
        _fail("execution_proof.exit_code must be zero")
    executed_at = value["executed_at"]
    if not isinstance(executed_at, str) or _RFC3339_UTC.fullmatch(executed_at) is None:
        _fail("execution_proof.executed_at must be an RFC3339 UTC timestamp")
    try:
        datetime.fromisoformat(executed_at.replace("Z", "+00:00"))
    except ValueError as exc:
        _fail(f"execution_proof.executed_at is invalid: {exc}")

    for field, identity_field in (
        ("runtime_bundle_sha256", "runtime_bundle"),
        ("runtime_source_snapshot_sha256", "source_snapshot"),
    ):
        if value[field] != runtime_identity[identity_field]["sha256"]:
            _fail(f"execution_proof.{field} disagrees with runtime_identity")

    stdout = _resolve_hashed_file(
        value["stdout"], base_dir=base_dir, field="execution_proof.stdout"
    )
    _resolve_hashed_file(
        value["stderr"], base_dir=base_dir, field="execution_proof.stderr"
    )
    try:
        stdout_record = json.loads(stdout.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail(f"execution_proof.stdout is not a JSON execution record: {exc}")
    if not isinstance(stdout_record, dict):
        _fail("execution_proof.stdout must contain an object")
    if set(stdout_record) != {
        "schema_version",
        "status",
        "run_ids",
        "cancellation_status",
        "sanitizer_error_count",
    }:
        _fail("execution_proof.stdout has an unsupported execution-record shape")
    if stdout_record["schema_version"] != "fem_k0_modal_performance_stdout.v1":
        _fail("execution_proof.stdout schema_version is unsupported")
    if stdout_record["status"] != "passed" or stdout_record["cancellation_status"] != "passed":
        _fail("execution_proof.stdout does not report a passed managed run")
    if stdout_record["run_ids"] != run_ids:
        _fail("execution_proof.stdout run_ids do not match the raw run artifacts")
    if stdout_record["sanitizer_error_count"] != 0:
        _fail("execution_proof.stdout reports Compute Sanitizer errors")


def _validate_partial_artifact(value: Any, *, base_dir: Path) -> None:
    path = _resolve_hashed_file(
        value, base_dir=base_dir, field="cancellation.partial_artifact"
    )
    try:
        artifact = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail(f"cancellation.partial_artifact is not valid JSON: {exc}")
    if not isinstance(artifact, dict):
        _fail("cancellation.partial_artifact must be an object")
    if set(artifact) != {
        "schema_version",
        "complete",
        "stop_reason",
        "preserved_mode_count",
    }:
        _fail("cancellation.partial_artifact has an unsupported schema")
    if artifact["schema_version"] != "fem_k0_modal_partial.v1":
        _fail("cancellation.partial_artifact schema_version is unsupported")
    if artifact["complete"] is not False:
        _fail("cancellation.partial_artifact.complete must be false")
    if not isinstance(artifact["stop_reason"], str) or not artifact["stop_reason"]:
        _fail("cancellation.partial_artifact.stop_reason must be non-empty")
    _integer(
        artifact["preserved_mode_count"],
        "cancellation.partial_artifact.preserved_mode_count",
    )


def _validate_sanitizer_log(value: Any, *, base_dir: Path) -> None:
    path = _resolve_hashed_file(value, base_dir=base_dir, field="compute_sanitizer.log")
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        _fail(f"compute_sanitizer.log is not valid UTF-8 text: {exc}")
    if re.search(r"ERROR SUMMARY:\s*0 errors\b", content) is None:
        _fail("compute_sanitizer.log does not contain a zero-error summary")


def verify_performance(payload: Any, *, base_dir: Path | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        _fail("performance proof must be an object")
    if payload.get("schema_version") != "fem_k0_modal_performance.v1":
        _fail("schema_version must be fem_k0_modal_performance.v1")
    if payload.get("status") != "passed":
        _fail("performance proof status must be passed")
    if payload.get("device") != "gpu" or payload.get("precision") != "double":
        _fail("performance proof must describe the production GPU double lane")
    if base_dir is None:
        _fail("performance evidence directory is required")
    _validate_runtime_identity(payload.get("runtime_identity"), base_dir)
    memory_budget = _integer(
        payload.get("memory_budget_bytes"), "memory_budget_bytes", positive=True
    )
    max_exponent = _number(
        payload.get("max_scaling_exponent"), "max_scaling_exponent", positive=True
    )
    runs = payload.get("runs")
    if not isinstance(runs, list) or len(runs) < 3:
        _fail("runs must contain at least three chronological records")
    normalized: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw in enumerate(runs):
        if not isinstance(raw, dict):
            _fail(f"runs[{index}] must be an object")
        run_id = raw.get("run_id")
        if not isinstance(run_id, str) or not run_id:
            _fail(f"runs[{index}].run_id must be non-empty")
        if run_id in seen_ids:
            _fail("run_id values must be unique")
        seen_ids.add(run_id)
        dof_count = _integer(raw.get("dof_count"), f"runs[{index}].dof_count", positive=True)
        _validate_run_artifact(raw, index, base_dir)
        elapsed = _number(raw.get("elapsed_seconds"), f"runs[{index}].elapsed_seconds", positive=True)
        peak_memory = _integer(
            raw.get("peak_memory_bytes"), f"runs[{index}].peak_memory_bytes", positive=True
        )
        if peak_memory > memory_budget:
            _fail(f"runs[{index}].peak_memory_bytes exceeds memory_budget_bytes")
        signature = raw.get("operator_context_signature")
        if not isinstance(signature, str) or not signature:
            _fail(f"runs[{index}].operator_context_signature must be non-empty")
        reused = raw.get("operator_context_reused")
        if not isinstance(reused, bool):
            _fail(f"runs[{index}].operator_context_reused must be boolean")
        for field in ("hot_loop_allocations", "hot_loop_h2d_bytes", "hot_loop_d2h_bytes"):
            value = _integer(raw.get(field), f"runs[{index}].{field}")
            if value != 0:
                _fail(f"runs[{index}].{field} must be zero in the production hot loop")
        normalized.append(
            {
                "run_id": run_id,
                "dof_count": dof_count,
                "elapsed_seconds": elapsed,
                "peak_memory_bytes": peak_memory,
                "operator_context_signature": signature,
                "operator_context_reused": reused,
            }
        )

    distinct_dofs = {run["dof_count"] for run in normalized}
    if len(distinct_dofs) < 3:
        _fail("runs must cover at least three distinct DOF sizes")
    reuse_count = 0
    invalidation_count = 0
    for index, run in enumerate(normalized):
        if index == 0:
            if run["operator_context_reused"]:
                _fail("first run cannot claim operator context reuse")
            continue
        previous = normalized[index - 1]
        same_signature = (
            run["dof_count"] == previous["dof_count"]
            and run["operator_context_signature"]
            == previous["operator_context_signature"]
        )
        if (
            run["dof_count"] != previous["dof_count"]
            and run["operator_context_signature"]
            == previous["operator_context_signature"]
        ):
            _fail("operator_context_signature must change when DOF size changes")
        if run["operator_context_reused"] != same_signature:
            _fail("operator context reuse flag is inconsistent with the signature")
        if same_signature:
            reuse_count += 1
        elif run["operator_context_signature"] != previous["operator_context_signature"]:
            invalidation_count += 1
    if reuse_count == 0:
        _fail("performance proof must contain an operator context reuse")
    if invalidation_count == 0:
        _fail("performance proof must contain an operator context invalidation")

    _validate_execution_proof(
        payload.get("execution_proof"),
        base_dir=base_dir,
        runtime_identity=payload["runtime_identity"],
        run_ids=[run["run_id"] for run in normalized],
    )

    elapsed_by_dof: dict[int, list[float]] = {}
    for run in normalized:
        elapsed_by_dof.setdefault(run["dof_count"], []).append(run["elapsed_seconds"])
    scaled = sorted(
        (dof_count, max(elapsed)) for dof_count, elapsed in elapsed_by_dof.items()
    )
    if any(left[1] > right[1] for left, right in zip(scaled, scaled[1:])):
        _fail("maximum elapsed_seconds must be non-decreasing with DOF size")
    first = scaled[0]
    last = scaled[-1]
    scaling_exponent = math.log(last[1] / first[1]) / math.log(last[0] / first[0])
    if not math.isfinite(scaling_exponent) or scaling_exponent > max_exponent:
        _fail(
            f"observed scaling exponent {scaling_exponent:g} exceeds {max_exponent:g}"
        )

    cancellation = payload.get("cancellation")
    if not isinstance(cancellation, dict) or cancellation.get("status") != "passed":
        _fail("cancellation gate must pass")
    if cancellation.get("partial_artifacts_preserved") is not True:
        _fail("cancellation gate must preserve partial artifacts")
    _validate_partial_artifact(
        cancellation.get("partial_artifact"), base_dir=base_dir
    )
    sanitizer = payload.get("compute_sanitizer")
    if not isinstance(sanitizer, dict) or sanitizer.get("status") != "passed":
        _fail("Compute Sanitizer gate must pass")
    if _integer(sanitizer.get("error_count"), "compute_sanitizer.error_count") != 0:
        _fail("Compute Sanitizer reported errors")
    _validate_sanitizer_log(sanitizer.get("log"), base_dir=base_dir)

    return {
        "schema_version": "fem_k0_modal_performance.v1",
        "status": "passed",
        "device": "gpu",
        "precision": "double",
        "run_count": len(normalized),
        "dof_sizes": sorted(distinct_dofs),
        "context_reuse_count": reuse_count,
        "context_invalidation_count": invalidation_count,
        "max_peak_memory_bytes": max(run["peak_memory_bytes"] for run in normalized),
        "observed_scaling_exponent": scaling_exponent,
        "max_scaling_exponent": max_exponent,
        "memory_budget_bytes": memory_budget,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        payload = json.loads(args.input.read_text(encoding="utf-8"))
        result = verify_performance(payload, base_dir=args.input.resolve().parent)
        if args.output is not None:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps(result, indent=2, sort_keys=True))
    except (OSError, json.JSONDecodeError, PerformanceError) as exc:
        print(f"invalid FEM K0 performance proof: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(__import__("sys").argv[1:]))
