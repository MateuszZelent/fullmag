"""Run one explicitly pinned native cancellation as a startup maintenance stop.

This bridge does not inspect or mutate the session catalog itself. The native
runtime-service CLI owns the config, owner, catalog, cancellation-intent, and
host-ledger checks. PID 1 only authenticates the control-volume request bytes,
invokes that CLI, and retains its typed result in a separate immutable receipt.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Mapping


REQUEST_ENV = "FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_REQUEST"
REQUEST_SHA256_ENV = "FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_REQUEST_SHA256"
ATTEMPT_ENV = "FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_ATTEMPT"
ADMISSION_SCHEMA = "fullmag.docker-runtime-unclaimed-cancellation-admission.v1"
REQUEST_SCHEMA = "runtime_service_unclaimed_cancellation_request.v1"
RECEIPT_SCHEMA = "fullmag.docker-runtime-unclaimed-cancellation-maintenance.v1"
CONTROL_ROOT = Path("/opt/fullmag/control/backend/runtime-service/unclaimed-cancellation")
REQUESTS_ROOT = CONTROL_ROOT / "requests"
RECEIPTS_ROOT = CONTROL_ROOT / "receipts"
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_RESULT_BYTES = 64 * 1024
MAX_RECEIPT_BYTES = 256 * 1024
CLI_TIMEOUT_SECONDS = 180
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_REQUEST_FILENAME = re.compile(r"([0-9a-f-]{36})\.json\Z")


def _fail(message: str) -> None:
    raise RuntimeError(message)


def _read_stable(path: Path, name: str, service: Any, maximum: int) -> bytes:
    first = service._bounded_regular(path, name, maximum)
    second = service._bounded_regular(path, name, maximum)
    if first != second:
        _fail(f"{name} changed during bounded admission")
    return first


def _read_json(raw: bytes, name: str, service: Any) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=service._reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"{name} is not valid UTF-8 JSON: {error}")
    if not isinstance(value, dict):
        _fail(f"{name} must contain a JSON object")
    return value


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode(
        "utf-8"
    )


def _request_path(value: str, service: Any) -> tuple[Path, str]:
    path = Path(value)
    if (not path.is_absolute() or any(part in {"..", "."} for part in path.parts)
            or str(path) != value or "\\" in value):
        _fail(f"{REQUEST_ENV} must be a canonical absolute POSIX path")
    try:
        relative = path.relative_to(REQUESTS_ROOT)
    except ValueError:
        _fail(f"{REQUEST_ENV} is outside the private cancellation request directory")
    if len(relative.parts) != 1:
        _fail(f"{REQUEST_ENV} must name one direct request file")
    match = _REQUEST_FILENAME.fullmatch(relative.name)
    if match is None:
        _fail("unclaimed cancellation request filename must be <request_id>.json")
    request_id = match.group(1)
    try:
        parsed_id = uuid.UUID(request_id)
    except ValueError as error:
        raise RuntimeError("unclaimed cancellation request filename has an invalid UUID") from error
    if parsed_id.int == 0 or str(parsed_id) != request_id:
        _fail("unclaimed cancellation request filename must use a canonical nonzero UUID")
    service._assert_no_links(path.parent, "unclaimed cancellation request parent")
    return path, request_id


def _validate_native_result(
    value: Any, *, request_id: str, run_id: Any, task_id: Any
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "schema_version", "request_id", "disposition", "run_id", "task_id", "catalog_revision"
    }:
        _fail("native unclaimed cancellation result has an unsupported shape")
    if (value.get("schema_version") != REQUEST_SCHEMA
            or value.get("request_id") != request_id
            or value.get("run_id") != run_id
            or value.get("task_id") != task_id):
        _fail("native unclaimed cancellation result does not match its pinned request")
    if value.get("disposition") not in {
        "cancelled", "cancellation_requested_projection_deferred"
    }:
        _fail("native unclaimed cancellation result has an unsupported disposition")
    revision = value.get("catalog_revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision <= 0:
        _fail("native unclaimed cancellation result has an invalid catalog revision")
    return value


def _receipt(
    result: Mapping[str, Any], request_id: str, request_sha256: str, stdout: bytes
) -> dict[str, Any]:
    disposition = result["disposition"]
    return {
        "schema": RECEIPT_SCHEMA,
        "request_id": request_id,
        "request_sha256": request_sha256,
        "state": "cancelled" if disposition == "cancelled" else "projection_deferred",
        "native_result": dict(result),
        "native_stdout_sha256": hashlib.sha256(stdout).hexdigest(),
    }


def _invoke_native(paths: Any, request_raw: bytes, service: Any):
    """Give the native CLI a private copy of the digest-verified request."""
    with tempfile.TemporaryDirectory(
        prefix="fullmag-unclaimed-cancellation-", dir="/tmp"
    ) as directory:
        staged_path = Path(directory) / "request.json"
        service._assert_no_links(staged_path.parent, "unclaimed cancellation staging directory")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(staged_path, flags, 0o400)
        try:
            view = memoryview(request_raw)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    _fail("short write while staging the pinned cancellation request")
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if _read_stable(
            staged_path, "staged unclaimed cancellation request", service, MAX_REQUEST_BYTES
        ) != request_raw:
            _fail("staged unclaimed cancellation request differs from its pinned bytes")
        executable = paths.package / "bin" / "fullmag-runtime-service"
        service._assert_no_links(executable, "native unclaimed cancellation executable")
        if not executable.is_file() or not os.access(executable, os.X_OK):
            _fail("native unclaimed cancellation executable is unavailable")
        try:
            return subprocess.run(
                [str(executable), "--cancel-unclaimed", "--config", str(paths.config),
                 "--request", str(staged_path)],
                cwd=str(paths.state),
                env=service.process_environment(paths, service=True),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=CLI_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(
                "native unclaimed cancellation timed out with an unknown durable outcome; "
                "keep the API stopped and inspect the cancellation intent before retrying"
            ) from error


def _wait_for_admission(paths, service, request_id, request_sha256, attempt, stopping):
    """Keep PID 1 alive until the host completes storage and build admission."""
    admission_path = CONTROL_ROOT / "admissions" / f"{attempt}.json"
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        service._assert_no_links(admission_path, "cancellation admission")
        if admission_path.exists():
            raw = _read_stable(admission_path, "cancellation admission", service, MAX_RESULT_BYTES)
            value = _read_json(raw, "cancellation admission", service)
            if set(value) != {"schema", "attempt", "request_id", "request_sha256",
                              "backend_container_id", "backend_started_at",
                              "backend_build_receipt_sha256"}:
                _fail("cancellation admission has an unsupported shape")
            if (value["schema"] != ADMISSION_SCHEMA or value["attempt"] != attempt
                    or value["request_id"] != request_id
                    or value["request_sha256"] != request_sha256
                    or not isinstance(value["backend_container_id"], str)
                    or _SHA256.fullmatch(value["backend_container_id"]) is None
                    or not isinstance(value["backend_started_at"], str)
                    or not value["backend_started_at"]):
                _fail("cancellation admission differs from this maintenance invocation")
            package = _read_stable(paths.package / "backend-build-receipt.json",
                                   "backend build receipt", service, 8 * 1024 * 1024)
            if hashlib.sha256(package).hexdigest() != value["backend_build_receipt_sha256"]:
                _fail("cancellation admission belongs to another built package")
            return hashlib.sha256(raw).hexdigest()
        if stopping is not None:
            if stopping.wait(0.25):
                _fail("cancellation maintenance stopped before host admission")
        else:
            time.sleep(0.25)
    _fail("cancellation maintenance host admission timed out; task was not cancelled")


def run(paths: Any, service: Any, stopping=None) -> dict[str, Any] | None:
    """Execute the opt-in cancellation and return its durable receipt result.

    With neither control variable present, normal startup continues. When
    supplied, this function returns only after the native typed result has
    been durably published; callers must stop startup for either disposition.
    """
    request_value = os.environ.get(REQUEST_ENV)
    digest_value = os.environ.get(REQUEST_SHA256_ENV)
    attempt = os.environ.get(ATTEMPT_ENV)
    if request_value is None and digest_value is None and attempt is None:
        return None
    if not request_value or not digest_value or _SHA256.fullmatch(digest_value) is None:
        _fail("unclaimed cancellation requires both its request path and raw SHA-256")
    if not isinstance(attempt, str) or re.fullmatch(r"[0-9a-f]{32}", attempt) is None:
        _fail("unclaimed cancellation requires a managed development attempt")

    request_path, filename_id = _request_path(request_value, service)
    request_raw = _read_stable(
        request_path, "unclaimed cancellation request", service, MAX_REQUEST_BYTES
    )
    request_sha256 = hashlib.sha256(request_raw).hexdigest()
    if request_sha256 != digest_value:
        _fail("unclaimed cancellation request bytes differ from the host-pinned SHA-256")
    request = _read_json(request_raw, "unclaimed cancellation request", service)
    request_id = request.get("request_id")
    if (request.get("schema_version") != REQUEST_SCHEMA or request_id != filename_id
            or not isinstance(request.get("run_id"), str)
            or not isinstance(request.get("task_id"), str)):
        _fail("unclaimed cancellation request identity differs from its control-volume path")

    admission_sha256 = _wait_for_admission(
        paths, service, request_id, request_sha256, attempt, stopping
    )
    result = _invoke_native(paths, request_raw, service)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).decode("utf-8", errors="replace")[-4096:]
        _fail("native unclaimed cancellation failed: " + detail)
    if not result.stdout or len(result.stdout) > MAX_RESULT_BYTES:
        _fail("native unclaimed cancellation returned no bounded typed result")
    native_result = _validate_native_result(
        _read_json(result.stdout, "native unclaimed cancellation result", service),
        request_id=request_id,
        run_id=request["run_id"],
        task_id=request["task_id"],
    )
    receipt = _receipt(native_result, request_id, request_sha256, result.stdout)
    receipt.update(attempt=attempt, admission_sha256=admission_sha256)
    receipt_raw = _canonical_json(receipt)
    if len(receipt_raw) > MAX_RECEIPT_BYTES:
        _fail("unclaimed cancellation maintenance receipt exceeds its size bound")
    result_sha256 = hashlib.sha256(_canonical_json(native_result)).hexdigest()
    receipt_path = RECEIPTS_ROOT / f"{attempt}-{request_id}-{request_sha256}-{result_sha256}.json"
    service._publish_accepted_reattach_raw(
        receipt_path, receipt_raw, "unclaimed cancellation maintenance receipt"
    )
    return {**receipt, "receipt_path": str(receipt_path)}
