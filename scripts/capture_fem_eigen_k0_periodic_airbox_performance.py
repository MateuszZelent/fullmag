#!/usr/bin/env python3
"""Capture a managed FEM K0 GPU performance proof.

The configuration describes the exact managed ``just`` command and every
measured case.  The command is executed once per case; wall time and child
peak RSS are measured here, while native diagnostics must provide the operator
signature and hot-loop transfer/allocation counters.  A cancellation command
and a Compute Sanitizer command are executed separately.  The script hashes
all copied evidence and runs the fail-closed verifier before writing the final
``fem_k0_modal_performance.v1`` proof.

No timing, residency, cancellation, or sanitizer result is inferred from a
configuration value.  Missing or stale command output is an error.

Configuration paths are relative to the configuration file unless absolute.
Generated paths beneath the managed working directory are passed to the
command in that working directory's relative spelling, so a container-backed
``just`` recipe sees the same path through its repository mount.
The managed command receives these environment variables:

* ``FULLMAG_K0_PERFORMANCE_PHASE`` (``run``, ``cancellation``, or
  ``sanitizer``);
* ``FULLMAG_K0_PERFORMANCE_RUN_ID`` and
  ``FULLMAG_K0_PERFORMANCE_DOF_COUNT`` for a run;
* ``FULLMAG_K0_PERFORMANCE_NATIVE_DIAGNOSTICS`` for a run output path;
* ``FULLMAG_K0_PERFORMANCE_PARTIAL_ARTIFACT`` for cancellation output; and
* ``FULLMAG_K0_PERFORMANCE_SANITIZER_LOG`` for Sanitizer output.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Mapping, Sequence

from verify_fem_eigen_k0_periodic_airbox_performance import verify_performance


CONFIG_SCHEMA = "fem_k0_modal_performance_capture_config.v1"
PERFORMANCE_SCHEMA = "fem_k0_modal_performance.v1"
# This is the managed per-case executor.  The similarly named ``verify``
# recipe only validates a completed proof and must never be used as the
# measurement command.
PERFORMANCE_RECIPE = "run-fem-frequency-domain-eigen-k0-poisson-airbox-performance-case"
SHA256_PREFIX = "sha256:"
_HOT_LOOP_FIELDS = ("hot_loop_allocations", "hot_loop_h2d_bytes", "hot_loop_d2h_bytes")


class CaptureError(ValueError):
    """Raised when a managed capture cannot produce a verifiable proof."""


def _fail(message: str) -> None:
    raise CaptureError(message)


def _string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        _fail(f"{field} must be a non-empty string")
    return value


def _integer(value: Any, field: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(f"{field} must be an integer")
    if value < (1 if positive else 0):
        _fail(f"{field} must be {'positive' if positive else 'non-negative'}")
    return value


def _number(value: Any, field: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{field} must be numeric")
    result = float(value)
    if not math.isfinite(result) or (positive and result <= 0.0) or (not positive and result < 0.0):
        _fail(f"{field} must be finite and {'positive' if positive else 'non-negative'}")
    return result


def _argv(value: Any, field: str) -> list[str]:
    if (
        not isinstance(value, list)
        or any(not isinstance(part, str) or not part or "\x00" in part for part in value)
    ):
        _fail(f"{field} must be an argv array of non-empty strings")
    return list(value)


def _read_json(path: Path, field: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail(f"{field} is not valid UTF-8 JSON: {exc}")
    if not isinstance(value, dict):
        _fail(f"{field} must contain a JSON object")
    return value


def _write_text(path: Path, content: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    except OSError as exc:
        _fail(f"cannot write capture artifact {path}: {exc}")


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        _fail(f"cannot serialize capture artifact {path}: {exc}")
    _write_text(path, encoded + "\n")


def _sha256(path: Path) -> str:
    try:
        return SHA256_PREFIX + hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        _fail(f"cannot hash evidence file {path}: {exc}")


def _resolve_path(raw: Any, *, base: Path, field: str, must_exist: bool) -> Path:
    value = _string(raw, field)
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = base / candidate
    try:
        resolved = candidate.resolve(strict=must_exist)
    except OSError as exc:
        _fail(f"{field} cannot be resolved: {exc}")
    if must_exist and not resolved.is_file():
        _fail(f"{field} must resolve to a regular file")
    return resolved


def _command_visible_path(path: Path, working_directory: Path) -> str:
    try:
        return path.resolve().relative_to(working_directory.resolve()).as_posix()
    except ValueError:
        return str(path)


def _reference(source: Path, destination: Path, root: Path) -> dict[str, str]:
    if not source.is_file():
        _fail(f"evidence source must be a regular file: {source}")
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.resolve() != destination.resolve():
            shutil.copy2(source, destination)
        relative = destination.resolve().relative_to(root.resolve()).as_posix()
    except (OSError, ValueError) as exc:
        _fail(f"cannot package evidence {source}: {exc}")
    return {"path": relative, "sha256": _sha256(destination)}


def _fingerprint(path: Path) -> tuple[int, int, str] | None:
    try:
        metadata = path.stat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        _fail(f"cannot inspect generated artifact {path}: {exc}")
    return (metadata.st_mtime_ns, metadata.st_size, _sha256(path))


def _require_updated(path: Path, before: tuple[int, int, str] | None, field: str) -> None:
    after = _fingerprint(path)
    if after is None:
        _fail(f"managed command did not write {field}: {path}")
    if before is not None and after == before:
        _fail(f"managed command left stale {field} unchanged: {path}")


def _load_config(path: Path) -> dict[str, Any]:
    config = _read_json(path, "configuration")
    required = {
        "schema_version",
        "working_directory",
        "managed_command",
        "timeout_seconds",
        "runtime_identity",
        "memory_budget_bytes",
        "max_scaling_exponent",
        "runs",
        "cancellation",
        "compute_sanitizer",
    }
    unknown = set(config) - required - {"environment"}
    if unknown:
        _fail(f"configuration contains unsupported keys: {sorted(unknown)!r}")
    if config.get("schema_version") != CONFIG_SCHEMA:
        _fail(f"configuration schema_version must be {CONFIG_SCHEMA}")
    command = _argv(config.get("managed_command"), "managed_command")
    if not command or PERFORMANCE_RECIPE not in command:
        _fail(f"managed_command must name {PERFORMANCE_RECIPE}")
    if Path(command[0]).name not in {"just", "just.exe"}:
        _fail("managed_command must execute the managed just entrypoint")
    timeout_seconds = _number(config.get("timeout_seconds"), "timeout_seconds", positive=True)
    memory_budget = _integer(config.get("memory_budget_bytes"), "memory_budget_bytes", positive=True)
    max_scaling = _number(config.get("max_scaling_exponent"), "max_scaling_exponent", positive=True)
    working_directory = _resolve_path(
        config.get("working_directory"),
        base=path.parent,
        field="working_directory",
        must_exist=False,
    )
    if not working_directory.is_dir():
        _fail(f"working_directory must be an existing directory: {working_directory}")
    runtime_identity = config.get("runtime_identity")
    if not isinstance(runtime_identity, dict) or set(runtime_identity) != {
        "runtime_bundle",
        "source_snapshot",
        "environment",
    }:
        _fail("runtime_identity must contain exactly runtime_bundle, source_snapshot, environment")
    identity_paths = {
        field: _resolve_path(value, base=path.parent, field=f"runtime_identity.{field}", must_exist=True)
        for field, value in runtime_identity.items()
    }
    runs = config.get("runs")
    if not isinstance(runs, list) or len(runs) < 3:
        _fail("runs must contain at least three cases")
    normalized_runs: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw in enumerate(runs):
        if not isinstance(raw, dict) or set(raw) != {
            "run_id",
            "dof_count",
            "arguments",
            "native_diagnostics",
        }:
            _fail(f"runs[{index}] must contain exactly run_id, dof_count, arguments, native_diagnostics")
        run_id = _string(raw["run_id"], f"runs[{index}].run_id")
        if run_id in seen_ids:
            _fail("run_id values must be unique")
        seen_ids.add(run_id)
        normalized_runs.append(
            {
                "run_id": run_id,
                "dof_count": _integer(raw["dof_count"], f"runs[{index}].dof_count", positive=True),
                "arguments": _argv(raw["arguments"], f"runs[{index}].arguments"),
                "native_diagnostics": _resolve_path(
                    raw["native_diagnostics"],
                    base=path.parent,
                    field=f"runs[{index}].native_diagnostics",
                    must_exist=False,
                ),
            }
        )
    for normalized in normalized_runs:
        normalized["native_diagnostics_command_path"] = _command_visible_path(
            normalized["native_diagnostics"], working_directory
        )
    cancellation = config.get("cancellation")
    if not isinstance(cancellation, dict) or set(cancellation) != {"arguments", "partial_artifact"}:
        _fail("cancellation must contain exactly arguments and partial_artifact")
    compute_sanitizer = config.get("compute_sanitizer")
    if not isinstance(compute_sanitizer, dict) or set(compute_sanitizer) != {"arguments", "log"}:
        _fail("compute_sanitizer must contain exactly arguments and log")
    config["_config_path"] = path
    config["_working_directory"] = working_directory
    config["_command"] = command
    config["_timeout_seconds"] = timeout_seconds
    config["_memory_budget_bytes"] = memory_budget
    config["_max_scaling_exponent"] = max_scaling
    config["_identity_paths"] = identity_paths
    config["_runs"] = normalized_runs
    cancellation_path = _resolve_path(
        cancellation["partial_artifact"],
        base=path.parent,
        field="cancellation.partial_artifact",
        must_exist=False,
    )
    config["_cancellation"] = {
        "arguments": _argv(cancellation["arguments"], "cancellation.arguments"),
        "partial_artifact": cancellation_path,
        "partial_artifact_command_path": _command_visible_path(cancellation_path, working_directory),
    }
    sanitizer_path = _resolve_path(
        compute_sanitizer["log"],
        base=path.parent,
        field="compute_sanitizer.log",
        must_exist=False,
    )
    config["_compute_sanitizer"] = {
        "arguments": _argv(compute_sanitizer["arguments"], "compute_sanitizer.arguments"),
        "log": sanitizer_path,
        "log_command_path": _command_visible_path(sanitizer_path, working_directory),
    }
    environment = config.get("environment", {})
    if not isinstance(environment, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in environment.items()
    ):
        _fail("environment must be a string-to-string object")
    config["_environment"] = dict(environment)
    return config


def _run_command(
    config: Mapping[str, Any],
    arguments: list[str],
    overrides: Mapping[str, str],
    measurement_root: Path,
) -> tuple[str, str, float, int]:
    environment = os.environ.copy()
    environment.update(config["_environment"])
    environment.update(overrides)
    command = [*config["_command"], *arguments]
    time_binary = Path("/usr/bin/time")
    if not time_binary.is_file():
        _fail("managed per-run memory capture requires /usr/bin/time")
    measurement_root.mkdir(parents=True, exist_ok=True)
    measurement_handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=measurement_root,
        prefix=".managed-time-",
        suffix=".txt",
        delete=False,
    )
    measurement_path = Path(measurement_handle.name)
    measurement_handle.close()
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            [str(time_binary), "-f", "%M", "-o", str(measurement_path), "--", *command],
            cwd=config["_working_directory"],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
            timeout=config["_timeout_seconds"],
        )
    except subprocess.TimeoutExpired as exc:
        try:
            measurement_path.unlink()
        except OSError:
            pass
        _fail(f"managed command timed out after {config['_timeout_seconds']} seconds")
    except OSError as exc:
        try:
            measurement_path.unlink()
        except OSError:
            pass
        _fail(f"cannot execute managed command: {exc}")
    elapsed = max(time.perf_counter() - started, 1e-12)
    if completed.returncode != 0:
        try:
            measurement_path.unlink()
        except OSError:
            pass
        _fail(f"managed command exited with status {completed.returncode}: {(completed.stderr or '')[-4000:]}")
    try:
        peak_memory_kib = int(measurement_path.read_text(encoding="utf-8").strip())
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        try:
            measurement_path.unlink()
        except OSError:
            pass
        _fail(f"managed command did not produce a valid per-run peak RSS measurement: {exc}")
    try:
        measurement_path.unlink()
    except OSError as exc:
        _fail(f"cannot remove temporary per-run memory measurement: {exc}")
    if peak_memory_kib <= 0:
        _fail("managed command reported a non-positive per-run peak RSS")
    # GNU time reports maximum resident set size in KiB on the managed Linux
    # runtime.  This is the command-specific high-water mark, not a cumulative
    # parent-process estimate.
    peak_memory = peak_memory_kib * 1024
    return completed.stdout or "", completed.stderr or "", elapsed, peak_memory


def _read_native_diagnostics(path: Path, index: int) -> dict[str, Any]:
    diagnostics = _read_json(path, f"runs[{index}].native_diagnostics")
    for field in ("operator_context_signature", "operator_context_reused"):
        if field not in diagnostics:
            _fail(f"runs[{index}].native_diagnostics is missing {field}")
    if not isinstance(diagnostics["operator_context_signature"], str) or not diagnostics["operator_context_signature"]:
        _fail(f"runs[{index}].native_diagnostics.operator_context_signature must be non-empty")
    if not isinstance(diagnostics["operator_context_reused"], bool):
        _fail(f"runs[{index}].native_diagnostics.operator_context_reused must be boolean")
    _integer(
        diagnostics.get("augmented_dof_count"),
        f"runs[{index}].native_diagnostics.augmented_dof_count",
        positive=True,
    )
    for field in _HOT_LOOP_FIELDS:
        _integer(diagnostics.get(field), f"runs[{index}].native_diagnostics.{field}")
    return diagnostics


def _run_reference(run_id: str, index: int, suffix: str, root: Path) -> Path:
    token = hashlib.sha256(run_id.encode("utf-8")).hexdigest()[:12]
    return root / "evidence" / "runs" / f"{index:04d}-{token}.{suffix}"


def _timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def capture_performance(config_path: Path, output_path: Path) -> dict[str, Any]:
    root = output_path.resolve().parent
    root.mkdir(parents=True, exist_ok=True)
    config = _load_config(config_path.resolve())
    evidence_root = root / "evidence"
    command_evidence_root = _command_visible_path(evidence_root, config["_working_directory"])
    runtime_identity: dict[str, dict[str, str]] = {
        field: _reference(source, evidence_root / "identity" / f"{field}.evidence", root)
        for field, source in config["_identity_paths"].items()
    }
    raw_stdout: list[str] = []
    raw_stderr: list[str] = []
    packaged_runs: list[dict[str, Any]] = []
    for index, spec in enumerate(config["_runs"]):
        diagnostics_path = spec["native_diagnostics"]
        before = _fingerprint(diagnostics_path)
        stdout, stderr, elapsed, peak_memory = _run_command(
            config,
            spec["arguments"],
            {
                "FULLMAG_K0_PERFORMANCE_PHASE": "run",
                "FULLMAG_K0_PERFORMANCE_RUN_ID": spec["run_id"],
                "FULLMAG_K0_PERFORMANCE_DOF_COUNT": str(spec["dof_count"]),
                "FULLMAG_K0_PERFORMANCE_NATIVE_DIAGNOSTICS": spec["native_diagnostics_command_path"],
                "FULLMAG_K0_PERFORMANCE_EVIDENCE_ROOT": command_evidence_root,
            },
            evidence_root,
        )
        _require_updated(diagnostics_path, before, f"runs[{index}].native_diagnostics")
        diagnostics = _read_native_diagnostics(diagnostics_path, index)
        raw_stdout.append(f"===== run {spec['run_id']} stdout =====\n{stdout}")
        raw_stderr.append(f"===== run {spec['run_id']} stderr =====\n{stderr}")
        run = {
            "run_id": spec["run_id"],
            # The native result, not the requested mesh label, is the source
            # of truth for the measured problem size.
            "dof_count": diagnostics["augmented_dof_count"],
            "elapsed_seconds": elapsed,
            "peak_memory_bytes": peak_memory,
            "operator_context_signature": diagnostics["operator_context_signature"],
            "operator_context_reused": diagnostics["operator_context_reused"],
            **{field: diagnostics[field] for field in _HOT_LOOP_FIELDS},
        }
        native_ref = _reference(
            diagnostics_path,
            _run_reference(spec["run_id"], index, "native-diagnostics.json", root),
            root,
        )
        telemetry_path = _run_reference(spec["run_id"], index, "runtime-telemetry.json", root)
        _write_json(
            telemetry_path,
            {
                "schema_version": "fem_k0_modal_performance_telemetry.v1",
                "measurement_source": "managed_native_runtime",
                **run,
            },
        )
        telemetry_ref = {
            "path": telemetry_path.relative_to(root.resolve()).as_posix(),
            "sha256": _sha256(telemetry_path),
        }
        artifact_path = _run_reference(spec["run_id"], index, "evidence.json", root)
        _write_json(
            artifact_path,
            {
                "schema_version": "fem_k0_modal_performance_run.v1",
                **run,
                "native_diagnostics": native_ref,
                "runtime_telemetry": telemetry_ref,
            },
        )
        packaged_runs.append(
            {
                **run,
                "native_diagnostics": native_ref,
                "runtime_telemetry": telemetry_ref,
                "evidence": {
                    "path": artifact_path.relative_to(root.resolve()).as_posix(),
                    "sha256": _sha256(artifact_path),
                },
            }
        )

    cancellation_path = config["_cancellation"]["partial_artifact"]
    cancellation_before = _fingerprint(cancellation_path)
    stdout, stderr, _elapsed, _peak = _run_command(
        config,
        config["_cancellation"]["arguments"],
        {
            "FULLMAG_K0_PERFORMANCE_PHASE": "cancellation",
            "FULLMAG_K0_PERFORMANCE_PARTIAL_ARTIFACT": config["_cancellation"]["partial_artifact_command_path"],
            "FULLMAG_K0_PERFORMANCE_EVIDENCE_ROOT": command_evidence_root,
        },
        evidence_root,
    )
    _require_updated(cancellation_path, cancellation_before, "cancellation.partial_artifact")
    raw_stdout.append(f"===== cancellation stdout =====\n{stdout}")
    raw_stderr.append(f"===== cancellation stderr =====\n{stderr}")

    sanitizer_path = config["_compute_sanitizer"]["log"]
    sanitizer_before = _fingerprint(sanitizer_path)
    stdout, stderr, _elapsed, _peak = _run_command(
        config,
        config["_compute_sanitizer"]["arguments"],
        {
            "FULLMAG_K0_PERFORMANCE_PHASE": "sanitizer",
            "FULLMAG_K0_PERFORMANCE_SANITIZER_LOG": config["_compute_sanitizer"]["log_command_path"],
            "FULLMAG_K0_PERFORMANCE_EVIDENCE_ROOT": command_evidence_root,
        },
        evidence_root,
    )
    _require_updated(sanitizer_path, sanitizer_before, "compute_sanitizer.log")
    raw_stdout.append(f"===== sanitizer stdout =====\n{stdout}")
    raw_stderr.append(f"===== sanitizer stderr =====\n{stderr}")
    try:
        sanitizer_content = sanitizer_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        _fail(f"compute_sanitizer.log is not valid UTF-8 text: {exc}")
    marker = "ERROR SUMMARY:"
    if marker not in sanitizer_content:
        _fail("compute_sanitizer.log has no ERROR SUMMARY marker")
    try:
        error_count = int(sanitizer_content.split(marker, 1)[1].split("errors", 1)[0].strip())
    except (IndexError, ValueError) as exc:
        _fail(f"compute_sanitizer.log has no parseable error count: {exc}")
    if error_count != 0:
        _fail(f"Compute Sanitizer reported {error_count} errors")

    partial_ref = _reference(cancellation_path, evidence_root / "cancellation" / "partial.json", root)
    sanitizer_ref = _reference(sanitizer_path, evidence_root / "sanitizer" / "compute-sanitizer.log", root)
    execution_stdout_path = evidence_root / "execution" / "managed.stdout.json"
    execution_stderr_path = evidence_root / "execution" / "managed.stderr.log"
    _write_text(evidence_root / "execution" / "managed.raw.stdout.log", "\n".join(raw_stdout) + "\n")
    _write_text(execution_stderr_path, "\n".join(raw_stderr) + "\n")
    _write_json(
        execution_stdout_path,
        {
            "schema_version": "fem_k0_modal_performance_stdout.v1",
            "status": "passed",
            "run_ids": [run["run_id"] for run in packaged_runs],
            "cancellation_status": "passed",
            "sanitizer_error_count": error_count,
        },
    )
    execution_stdout_ref = {
        "path": execution_stdout_path.relative_to(root.resolve()).as_posix(),
        "sha256": _sha256(execution_stdout_path),
    }
    execution_stderr_ref = {
        "path": execution_stderr_path.relative_to(root.resolve()).as_posix(),
        "sha256": _sha256(execution_stderr_path),
    }
    payload: dict[str, Any] = {
        "schema_version": PERFORMANCE_SCHEMA,
        "status": "passed",
        "device": "gpu",
        "precision": "double",
        "runtime_identity": {
            "producer": "managed_just",
            "recipe": PERFORMANCE_RECIPE,
            **runtime_identity,
        },
        "execution_proof": {
            "schema_version": "fem_k0_modal_performance_execution.v1",
            "command": list(config["_command"]),
            "exit_code": 0,
            "executed_at": _timestamp(),
            "runtime_bundle_sha256": runtime_identity["runtime_bundle"]["sha256"],
            "runtime_source_snapshot_sha256": runtime_identity["source_snapshot"]["sha256"],
            "stdout": execution_stdout_ref,
            "stderr": execution_stderr_ref,
        },
        "memory_budget_bytes": config["_memory_budget_bytes"],
        "max_scaling_exponent": config["_max_scaling_exponent"],
        "runs": packaged_runs,
        "cancellation": {
            "status": "passed",
            "partial_artifacts_preserved": True,
            "partial_artifact": partial_ref,
        },
        "compute_sanitizer": {
            "status": "passed",
            "error_count": error_count,
            "log": sanitizer_ref,
        },
    }
    try:
        verify_performance(payload, base_dir=root)
    except ValueError as exc:
        _fail(f"captured evidence failed the production verifier: {exc}")
    _write_json(output_path.resolve(), payload)
    return payload


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        payload = capture_performance(args.config, args.output)
        print(
            json.dumps(
                {
                    "schema_version": payload["schema_version"],
                    "status": payload["status"],
                    "output": str(args.output.resolve()),
                },
                sort_keys=True,
            )
        )
    except (CaptureError, OSError, ValueError) as exc:
        print(f"invalid FEM K0 performance capture: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
