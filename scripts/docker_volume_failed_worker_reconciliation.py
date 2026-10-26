"""Run one managed failed-worker release reconciliation in a retained backend.

The parent activation helper remains the only control lease.  This module may
capture and build an isolated candidate package, but it never rotates the live
package, starts the API, starts a scheduler, or creates a new RunIntent.  The
native runtime-service command owns the store and host-ledger transition.
"""
from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import uuid
from typing import Any

from docker_build_control import BuildControl, BuildControlError, MAX_DOCUMENT_BYTES, canonical


REQUEST_SCHEMA = "fullmag.docker-volume-failed-worker-reconciliation.v1"
NATIVE_REQUEST_SCHEMA = "runtime_service_failed_worker_exit_reconciliation_request.v1"
NATIVE_RESULT_SCHEMA = NATIVE_REQUEST_SCHEMA
SUBOPERATION_SCHEMA = "fullmag.docker-failed-worker-reconciliation.v1"
RECEIPT_SCHEMA = "fullmag.docker-failed-worker-reconciliation-receipt.v1"
COLLECTION_SCHEMA = "fullmag.failed-worker-reconciliation-inputs.v1"

MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_RESULT_BYTES = 1024 * 1024
MAX_RECORD_BYTES = 16 * 1024 * 1024
MAX_LOG_BYTES = 256 * 1024
MAX_CANDIDATE_RECEIPT_BYTES = 8 * 1024 * 1024
MAX_BUILD_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_CONTROL_PUBLISH_BYTES = 256 * 1024
LOG_TAIL_BYTES = 32 * 1024

ATTEMPT_RE = re.compile(r"[0-9a-f]{32}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
STORE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
CONTAINER_RE = re.compile(r"[0-9a-f]{64}\Z")
UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z"
)


@dataclass
class ReconciliationOperation:
    """One child operation under the retained parent activation lease."""

    request_id: str
    root: str
    phase: str = "context"
    recordable: bool = False
    prepared_candidate: bool = False
    native_invoked: bool = False
    terminal_recorded: bool = False

    def path(self, name: str) -> str:
        return self.root + "/" + name


class ReconciliationError(BuildControlError):
    """The retained worker reconciliation is not safely admissible."""


def _fail(message: str) -> None:
    raise ReconciliationError(message)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _canonical_json(value: object) -> bytes:
    try:
        return (
            json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
            + "\n"
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ReconciliationError("reconciliation record is not finite JSON") from error


def _require_digest(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        _fail(label + " is not a lowercase SHA-256")
    return value


def _require_store_id(value: object, label: str) -> str:
    if not isinstance(value, str) or STORE_ID_RE.fullmatch(value) is None:
        _fail(label + " is not a canonical store identity")
    return value


def _require_attempt(value: object, label: str) -> str:
    if not isinstance(value, str) or ATTEMPT_RE.fullmatch(value) is None:
        _fail(label + " is not a complete lowercase attempt identity")
    return value


def _require_uuid(value: object, label: str) -> str:
    if not isinstance(value, str) or UUID_RE.fullmatch(value) is None:
        _fail(label + " is not a canonical UUID")
    try:
        parsed = uuid.UUID(value)
    except ValueError as error:
        raise ReconciliationError(label + " is not a canonical UUID") from error
    if parsed.int == 0 or str(parsed) != value:
        _fail(label + " is not a canonical nonzero UUID")
    return value


def _object(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        _fail(label + " must be an object")
    return value


def _validate_identity_consistency(records: Mapping[str, object]) -> dict[str, Mapping[str, object]]:
    task = _object(records.get("expected_task"), "expected task")
    lease = _object(records.get("expected_lease"), "expected lease")
    receipt = _object(records.get("expected_receipt"), "expected exit receipt")
    reservation = _object(records.get("expected_reservation"), "expected host reservation")
    identity = _object(reservation.get("identity"), "expected reservation identity")
    owner = _object(identity.get("owner"), "expected reservation owner")

    task_id = _require_store_id(task.get("task_id"), "task id")
    run_id = _require_store_id(lease.get("run_id"), "lease run id")
    if task.get("lifecycle") != "failed":
        _fail("failed-worker reconciliation requires a failed task")
    readiness = task.get("readiness")
    if readiness != "ready" and not (
        isinstance(readiness, Mapping) and readiness.get("state") == "ready"
    ):
        # Serde enum representations differ between old and current fixtures;
        # the native validator remains authoritative for the full typed value.
        _fail("failed-worker reconciliation requires a ready task")
    attempt_id = _require_store_id(task.get("attempt_id"), "task attempt id")
    epoch = task.get("ownership_epoch")
    if type(epoch) is not int or epoch <= 0:
        _fail("task ownership epoch is invalid")
    resource_id = _require_store_id(task.get("resource_id"), "task resource id")
    lease_token = _require_store_id(lease.get("lease_token"), "lease token")
    receipt_id = _require_store_id(receipt.get("receipt_id"), "exit receipt id")

    pairs = (
        (lease.get("task_id"), task_id, "lease task"),
        (receipt.get("task_id"), task_id, "receipt task"),
        (identity.get("task_id"), task_id, "reservation task"),
        (lease.get("run_id"), run_id, "lease run"),
        (receipt.get("run_id"), run_id, "receipt run"),
        (identity.get("run_id"), run_id, "reservation run"),
        (lease.get("attempt_id"), attempt_id, "lease attempt"),
        (receipt.get("attempt_id"), attempt_id, "receipt attempt"),
        (owner.get("attempt_id"), attempt_id, "reservation owner attempt"),
        (lease.get("resource_id"), resource_id, "lease resource"),
        (receipt.get("resource_id"), resource_id, "receipt resource"),
        (identity.get("resource_id"), resource_id, "reservation resource"),
        (lease.get("ownership_epoch"), epoch, "lease ownership epoch"),
        (receipt.get("ownership_epoch"), epoch, "receipt ownership epoch"),
        (owner.get("ownership_epoch"), epoch, "reservation ownership epoch"),
        (lease_token, receipt.get("lease_token"), "receipt lease"),
        (lease_token, identity.get("lease_token"), "reservation lease"),
    )
    for observed, expected, label in pairs:
        if observed != expected:
            _fail(label + " identity differs from the task claim")
    if owner.get("kind") != "solver":
        _fail("failed-worker reconciliation requires a solver reservation")
    if lease.get("state") != "active":
        _fail("failed-worker reconciliation requires an active local lease")
    if receipt.get("status_success") is not False:
        _fail("failed-worker reconciliation requires a failed worker receipt")
    if receipt.get("timed_out") is not False or receipt.get("stop_requested") is not False:
        _fail("failed-worker reconciliation cannot consume timeout or stop receipts")
    if type(receipt.get("exit_code")) is not int or receipt.get("exit_code") == 0:
        _fail("failed-worker reconciliation requires a nonzero worker exit")
    if reservation.get("state") != "quarantined":
        _fail("failed-worker reconciliation requires a quarantined host reservation")
    if reservation.get("release_proof_sha256") is not None:
        _fail("failed-worker reconciliation cannot replace an existing release proof")
    return {
        "task": task,
        "lease": lease,
        "receipt": receipt,
        "reservation": reservation,
    }


def build_native_request(records: Mapping[str, object]) -> dict[str, object]:
    """Build the exact deny-unknown native request from collected records."""

    if not isinstance(records, Mapping):
        _fail("reconciliation inputs must be an object")
    request_id = _require_uuid(records.get("request_id"), "reconciliation request id")
    config_sha256 = _require_digest(records.get("config_sha256"), "runtime config digest")
    owner_sha256 = _require_digest(records.get("owner_sha256"), "runtime owner digest")
    catalog_sha256 = _require_digest(records.get("catalog_sha256"), "run catalog digest")
    lease_sha256 = _require_digest(records.get("lease_sha256"), "resource lease digest")
    receipt_sha256 = _require_digest(records.get("receipt_sha256"), "exit receipt digest")
    owner = _object(records.get("expected_owner"), "expected runtime owner")
    if (
        owner.get("schema_version") != "runtime_service_owner.v1"
        or owner.get("state") != "failed"
        or owner.get("target_id") != "docker-all"
    ):
        _fail("failed-worker reconciliation requires the exact Failed owner")
    revision = records.get("catalog_revision")
    if type(revision) is not int or revision <= 0:
        _fail("run catalog revision must be positive")
    values = _validate_identity_consistency(records)
    nested = {
        "expected_catalog_revision": revision,
        "expected_task": dict(values["task"]),
        "expected_lease": dict(values["lease"]),
        "expected_receipt": dict(values["receipt"]),
        "expected_reservation": dict(values["reservation"]),
    }
    request = {
        "schema_version": NATIVE_REQUEST_SCHEMA,
        "request_id": request_id,
        "config_sha256": config_sha256,
        "owner_sha256": owner_sha256,
        "expected_owner": dict(owner),
        "expected_catalog_sha256": catalog_sha256,
        "expected_lease_sha256": lease_sha256,
        "expected_receipt_sha256": receipt_sha256,
        "reconciliation": nested,
    }
    raw = _canonical_json(request)
    if len(raw) > MAX_REQUEST_BYTES:
        _fail("failed-worker reconciliation request exceeds its byte bound")
    return request


def validate_candidate_receipt(
    receipt: Mapping[str, object], source_probe: Mapping[str, object]
) -> dict[str, object]:
    """Require a successful isolated package bound to one live source capture."""

    if not isinstance(receipt, Mapping):
        _fail("candidate build receipt is not an object")
    if receipt.get("schema") != "fullmag.direct-compose.backend-build-receipt.v1":
        _fail("candidate build receipt schema is unsupported")
    if receipt.get("state") != "succeeded":
        _fail("candidate build did not publish a succeeded receipt")
    source = _object(receipt.get("source"), "candidate source receipt")
    for key in ("resolved_commit", "source_digest", "source_snapshot_sha256", "live_manifest_sha256"):
        expected = source_probe.get(key)
        observed = source.get(key)
        if not isinstance(expected, str) or observed != expected:
            _fail("candidate receipt source pin differs: " + key)
    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, list):
        _fail("candidate receipt has no artifact inventory")
    native = [
        item for item in artifacts
        if isinstance(item, Mapping) and item.get("path") == "bin/fullmag-runtime-service"
    ]
    if len(native) != 1 or _require_digest(native[0].get("sha256"), "candidate runtime-service hash") is None:
        _fail("candidate receipt does not attest one runtime-service binary")
    return dict(receipt)


def validate_native_result(
    value: Mapping[str, object],
    request_sha256: str,
    run_id: str,
    task_id: str,
    lease_token: str,
    receipt_id: str,
    request_id: str | None = None,
) -> dict[str, object]:
    """Validate the fixed typed result emitted by native runtime-service."""

    if not isinstance(value, Mapping):
        _fail("native failed-worker result is not an object")
    expected_fields = {
        "schema_version", "request_id", "request_sha256", "disposition", "run_id",
        "task_id", "lease_token", "receipt_id", "release_proof_sha256",
        "task_lifecycle", "solver_replayed", "artifacts_requalified",
    }
    if set(value) != expected_fields:
        _fail("native failed-worker result has an unsupported shape")
    if value.get("schema_version") != NATIVE_RESULT_SCHEMA:
        _fail("native failed-worker result schema is unsupported")
    _require_uuid(value.get("request_id"), "native result request id")
    if request_id is not None and value.get("request_id") != request_id:
        _fail("native failed-worker result scope differs from its request")
    if value.get("request_sha256") != _require_digest(request_sha256, "native request digest"):
        _fail("native failed-worker result request digest differs from its request")
    if value.get("run_id") != run_id or value.get("task_id") != task_id:
        _fail("native failed-worker result scope differs from its request")
    if value.get("lease_token") != lease_token or value.get("receipt_id") != receipt_id:
        _fail("native failed-worker result lease/receipt scope differs from its request")
    if value.get("disposition") not in {"validated", "released"}:
        _fail("native failed-worker result has an unsupported disposition")
    proof = value.get("release_proof_sha256")
    if proof is not None:
        _require_digest(proof, "native release proof")
    if value.get("task_lifecycle") != "failed":
        _fail("native failed-worker result task lifecycle is not failed")
    if value.get("solver_replayed") is not False or value.get("artifacts_requalified") is not False:
        _fail("native failed-worker result attempted solver or artifact replay")
    return dict(value)


def native_command(
    executable: str, config_path: str, request_path: str, *, apply: bool
) -> list[str]:
    """Construct the only native command this wrapper may execute."""

    for value, label in ((executable, "candidate executable"), (config_path, "runtime config path"), (request_path, "request path")):
        if not isinstance(value, str) or not value.startswith("/") or "\x00" in value:
            _fail(label + " is not an absolute path")
        path = PurePosixPath(value)
        if str(path) != value or ".." in path.parts:
            _fail(label + " is not canonical")
    command = [executable, "--reconcile-failed-worker-exit", "--config", config_path, "--request", request_path]
    if apply:
        command.append("--apply")
    return command


def _operation_id(activation_attempt: str, run_id: str, task_id: str, receipt_id: str) -> str:
    for value, label in ((activation_attempt, "activation attempt"), (run_id, "run id"), (task_id, "task id"), (receipt_id, "receipt id")):
        _require_store_id(value, label)
    return str(uuid.uuid5(
        uuid.NAMESPACE_URL,
        ":".join((REQUEST_SCHEMA, activation_attempt, run_id, task_id, receipt_id)),
    ))


def _request_id_for_args(args: argparse.Namespace) -> str:
    explicit = getattr(args, "request_id", None)
    if explicit is not None:
        return _require_uuid(explicit, "reconciliation request id")
    return _operation_id(
        args.pending_activation,
        args.run_id,
        args.task_id,
        args.exit_receipt_id,
    )


def _operation_root(activation_attempt: str) -> str:
    _require_attempt(activation_attempt, "pending activation")
    return "activation/attempts/" + activation_attempt + "/failed-worker-reconciliation"


def _read_json_bytes(raw: bytes, label: str, maximum: int = MAX_RECORD_BYTES) -> dict[str, object]:
    if not isinstance(raw, bytes) or not raw or len(raw) > maximum:
        _fail(label + " exceeds its byte bound")

    def unique(pairs):
        value: dict[str, object] = {}
        for key, item in pairs:
            if key in value:
                _fail(label + " contains a duplicate JSON key")
            value[key] = item
        return value

    try:
        value = json.loads(
            raw.decode("utf-8"), object_pairs_hook=unique,
            parse_constant=lambda token: (_ for _ in ()).throw(ValueError(token)),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ReconciliationError(label + " is not finite UTF-8 JSON") from error
    if not isinstance(value, dict):
        _fail(label + " must be a JSON object")
    return value


def _source_relative(root: str, request_id: str) -> str:
    if not isinstance(root, str) or not root.startswith("/build/maintenance/"):
        _fail("maintenance root is outside the backend build volume")
    if not isinstance(request_id, str) or UUID_RE.fullmatch(request_id) is None:
        _fail("maintenance request id is invalid")
    path = PurePosixPath(root)
    if str(path) != root or ".." in path.parts:
        _fail("maintenance root is not canonical")
    return root.rstrip("/") + "/source"


def _bounded_text(data: bytes, maximum: int = MAX_LOG_BYTES) -> str:
    if not isinstance(data, bytes):
        data = bytes(data)
    return data[-maximum:].decode("utf-8", "replace")


def _control_raw(
    control: Any,
    relative: str,
    *,
    optional: bool = False,
    maximum: int = MAX_DOCUMENT_BYTES,
) -> bytes | None:
    from docker_volume_unclaimed_cancellation import _control_raw as read_control_raw

    raw = read_control_raw(control, relative, optional=optional, maximum=maximum)
    if raw is None:
        if optional:
            return None
        _fail("required control-volume record is missing: " + relative)
    return raw


def _exec(container: str, arguments: Sequence[object], *, timeout: int = 120,
          input_bytes: bytes | None = None, stdout_limit: int = MAX_RECORD_BYTES,
          stderr_limit: int = MAX_LOG_BYTES, environment: Mapping[str, str] | None = None) -> tuple[bytes, bytes]:
    from docker_dev_codegen import _exec as codegen_exec

    try:
        return codegen_exec(
            container,
            arguments,
            timeout=timeout,
            input_bytes=input_bytes,
            stdout_limit=stdout_limit,
            stderr_limit=stderr_limit,
            environment=environment,
        )
    except RuntimeError as error:
        raise ReconciliationError(
            "managed backend maintenance command failed: " + str(error)[-2048:]
        ) from error


def _publish_immutable(control: Any, relative: str, raw: bytes) -> None:
    from docker_volume_unclaimed_cancellation import _publish_immutable as publish

    if len(raw) > MAX_CONTROL_PUBLISH_BYTES:
        _fail("failed-worker reconciliation control record exceeds its byte bound")
    publish(control, relative, raw)


def _publish_log_once(control: Any, relative: str, raw: bytes, request_id: str) -> None:
    existing = _control_raw(control, relative, optional=True, maximum=MAX_CONTROL_PUBLISH_BYTES)
    if existing is not None:
        document = _read_json_bytes(existing, "existing reconciliation log", MAX_CONTROL_PUBLISH_BYTES)
        if document.get("schema") != SUBOPERATION_SCHEMA or document.get("operation_id") != request_id:
            _fail("existing reconciliation log has a foreign identity")
        return
    _publish_immutable(control, relative, raw)


def _capture_source(backend_id: str, request_id: str) -> tuple[dict[str, object], bytes]:
    stdout, _ = _exec(
        backend_id,
        ("/usr/local/bin/python3", "-B", "-c", SOURCE_CAPTURE_SCRIPT, request_id),
        timeout=600,
        stdout_limit=MAX_CANDIDATE_RECEIPT_BYTES,
    )
    document = _read_json_bytes(stdout, "live source capture", MAX_CANDIDATE_RECEIPT_BYTES)
    manifest_path = document.get("manifest_path")
    if manifest_path != (
        "/build/maintenance/" + request_id + "/source-capture/.fullmag-live-source/manifest.json"
    ):
        _fail("live source capture returned an out-of-scope manifest path")
    if document.get("source_mode") != "live-shadow-v1":
        _fail("live source capture returned an unsupported source mode")
    for key in ("resolved_commit", "source_digest", "source_snapshot_sha256", "live_manifest_sha256"):
        value = document.get(key)
        if key == "resolved_commit":
            if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{40}", value) is None:
                _fail("live source capture has an invalid commit pin")
        else:
            _require_digest(value, "live source capture " + key)
    return document, stdout


def _collect_expected_records(backend_id: str, run_id: str, task_id: str, receipt_id: str) -> dict[str, object]:
    stdout, _ = _exec(
        backend_id,
        ("/usr/local/bin/python3", "-B", "-c", COLLECT_EXPECTED_SCRIPT, run_id, task_id, receipt_id),
        timeout=120,
        stdout_limit=MAX_RECORD_BYTES,
    )
    records = _read_json_bytes(stdout, "failed-worker durable records", MAX_RECORD_BYTES)
    if records.get("schema") != COLLECTION_SCHEMA:
        _fail("failed-worker durable records schema is unsupported")
    return records


def _prepare_candidate(
    backend_id: str, request_id: str, source: Mapping[str, object]
) -> tuple[str, dict[str, object], bytes, bytes, bytes]:
    _require_uuid(request_id, "reconciliation request id")
    root = "/build/maintenance/" + request_id
    _source_relative(root, request_id)
    manifest_path = source.get("manifest_path")
    if not isinstance(manifest_path, str):
        _fail("source capture has no manifest path")
    package = root + "/package"
    stdout, stderr = _exec(
        backend_id,
        (
            "/usr/local/bin/python3", "-B", "/opt/fullmag/backend_dev.py", "prepare",
            "--manifest", manifest_path,
            "--source-root", "/opt/fullmag/source",
            "--git-common-root", "/opt/fullmag/source-git",
            "--output", package,
            # Keep the backend's existing workspace/cache and isolate only the
            # package output under this request.  backend_dev.py's prepare
            # contract writes its receipt at <output>/backend-build-receipt.json.
            "--build-root", "/build",
        ),
        timeout=3600,
        stdout_limit=MAX_BUILD_OUTPUT_BYTES,
        stderr_limit=MAX_BUILD_OUTPUT_BYTES,
    )
    receipt_path = package + "/backend-build-receipt.json"
    receipt_raw, _ = _exec(
        backend_id,
        ("/usr/local/bin/python3", "-B", "-c", READ_REGULAR_JSON_SCRIPT, receipt_path),
        timeout=120,
        stdout_limit=MAX_CANDIDATE_RECEIPT_BYTES,
    )
    receipt = _read_json_bytes(receipt_raw, "isolated candidate build receipt", MAX_CANDIDATE_RECEIPT_BYTES)
    validate_candidate_receipt(receipt, source)
    return package, receipt, receipt_raw, stdout, stderr


def _read_candidate_receipt(
    backend_id: str, package: str, source: Mapping[str, object]
) -> tuple[dict[str, object], bytes]:
    receipt_path = package.rstrip("/") + "/backend-build-receipt.json"
    receipt_raw, _ = _exec(
        backend_id,
        ("/usr/local/bin/python3", "-B", "-c", READ_REGULAR_JSON_SCRIPT, receipt_path),
        timeout=120,
        stdout_limit=MAX_CANDIDATE_RECEIPT_BYTES,
    )
    receipt = _read_json_bytes(
        receipt_raw, "isolated candidate build receipt", MAX_CANDIDATE_RECEIPT_BYTES
    )
    validate_candidate_receipt(receipt, source)
    return receipt, receipt_raw


def _candidate_executable(package: str) -> str:
    path = PurePosixPath(package)
    if str(path) != package or ".." in path.parts or not package.startswith("/build/maintenance/"):
        _fail("candidate package path is outside the isolated maintenance root")
    return package.rstrip("/") + "/bin/fullmag-runtime-service"


def _native_output(raw: bytes) -> dict[str, object]:
    return _read_json_bytes(raw, "native failed-worker result", MAX_RESULT_BYTES)


def _validate_incarnation(backend_id: str, image_id: str, started_at: str) -> None:
    from docker_dev_codegen import _inspect

    try:
        document = _inspect(backend_id)
    except RuntimeError as error:
        raise ReconciliationError("cannot revalidate backend incarnation: " + str(error)) from error
    state = document.get("State")
    if (document.get("Id") != backend_id or document.get("Image") != image_id
            or not isinstance(state, Mapping) or state.get("Running") is not True
            or state.get("StartedAt") != started_at):
        _fail("retained backend incarnation changed during reconciliation")


def _validate_args(args: argparse.Namespace) -> None:
    _require_attempt(getattr(args, "attempt", None), "development attempt")
    _require_attempt(getattr(args, "iteration_attempt", None), "iteration attempt")
    _require_attempt(getattr(args, "pending_activation", None), "pending activation")
    _require_digest(getattr(args, "config_sha256", None), "Compose config digest")
    source_root = getattr(args, "source_root", None)
    if not isinstance(source_root, Path) or source_root.is_symlink() or not source_root.is_dir():
        _fail("selected source root is not a real directory")
    port = getattr(args, "port", None)
    if type(port) is not int or not 1 <= port <= 65535:
        _fail("frontend port is outside the valid range")
    for value, label in (
        (getattr(args, "run_id", None), "run id"),
        (getattr(args, "task_id", None), "task id"),
        (getattr(args, "exit_receipt_id", None), "exit receipt id"),
    ):
        _require_store_id(value, label)
    _request_id_for_args(args)
    if getattr(args, "prepare_candidate", False) and getattr(args, "apply", False):
        _fail("--prepare-candidate and --apply are mutually exclusive")


def _load_context(args: argparse.Namespace) -> dict[str, object]:
    from docker_dev import _compose_identity, _select_source
    from docker_dev_codegen import _running_service
    from docker_volume_activation_reconcile import (
        _validate_activation_receipt,
        _validate_helper,
        _validate_helper_logged,
    )
    from docker_volume_stop_diagnostic import _port_matches, _validate_resume_terminal
    from docker_build_control import toolchain_configuration
    from docker_dev_host import require_host

    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    if selected != args.source_root.resolve(strict=True):
        _fail("selected checkout differs from the explicit source root")
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    services = configured.get("services")
    toolchain = services.get("fem-gpu-toolchain") if isinstance(services, Mapping) else None
    build = toolchain.get("build") if isinstance(toolchain, Mapping) else None
    build_args = build.get("args") if isinstance(build, Mapping) else None
    helper_image = build_args.get("FULLMAG_CUDA_BASE_IMAGE") if isinstance(build_args, Mapping) else None
    if not isinstance(helper_image, str):
        _fail("selected Compose configuration has no pinned control helper image")
    control = BuildControl(identity, helper_image)
    control.prepare()
    previous_root = "development/attempts/" + args.attempt
    previous_raw = _control_raw(control, previous_root + "/terminal.json")
    previous = _read_json_bytes(previous_raw, "retained development terminal")
    if (
        previous.get("schema") != "fullmag.docker-build-operation.v1"
        or previous.get("phase") != "development"
        or previous.get("state") not in {"succeeded", "failed-confirmed"}
        or previous.get("attempt") != args.attempt
        or previous.get("compose_project") != control.project
    ):
        _fail("failed-worker reconciliation requires the exact retained development terminal")
    inputs = _object(previous.get("inputs"), "retained development inputs")
    if inputs.get("source_root") != str(selected):
        _fail("retained development attempt belongs to a different selected checkout")
    image_id = inputs.get("image_id")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        _fail("retained development terminal has no immutable image identity")
    backend_container = previous.get("backend_container")
    if not isinstance(backend_container, str) or CONTAINER_RE.fullmatch(backend_container) is None:
        _fail("retained development terminal has no immutable backend identity")
    if previous.get("backend_started_at") is None or not isinstance(previous.get("backend_started_at"), str):
        _fail("retained development terminal has no backend start-time pin")
    iteration_pin = _validate_resume_terminal(
        control,
        args.iteration_attempt,
        development_attempt=args.attempt,
        config_sha256=args.config_sha256,
        previous=previous,
        phase="iteration",
    )
    compose_raw = _control_raw(control, previous_root + "/compose.json")
    document = _read_json_bytes(compose_raw, "retained Compose document")
    if _sha256(canonical(document)) != args.config_sha256 or document.get("name") != control.project:
        _fail("retained Compose configuration pin differs")
    _port_matches(document, args.port)
    try:
        backend_id, backend_document = _running_service(control.project, "backend", identity, selected)
    except RuntimeError as error:
        raise ReconciliationError("cannot locate the exact retained backend: " + str(error)) from error
    # docker ps may return a short ID; compare the full inspected identity.
    backend_id = backend_document.get("Id")
    if (
        not isinstance(backend_id, str) or CONTAINER_RE.fullmatch(backend_id) is None
        or backend_id != iteration_pin["backend_container"]
        or backend_document.get("Image") != image_id
        or backend_document.get("State", {}).get("StartedAt") != iteration_pin["backend_started_at"]
    ):
        _fail("running backend differs from the exact successful iteration pin")
    started_at = iteration_pin["backend_started_at"]
    helper_name = "fullmag-control-" + args.pending_activation
    _, helper_id = _validate_helper(control, helper_name, args.pending_activation)
    active_raw = _control_raw(control, "active")
    if active_raw != (args.pending_activation + "\n").encode("ascii"):
        _fail("original activation does not own the exact control lease")
    activation_raw = _control_raw(control, "activation/attempts/" + args.pending_activation + "/receipt.json")
    activation, _, activation_inputs = _validate_activation_receipt(
        control,
        activation_attempt=args.pending_activation,
        development_attempt=args.attempt,
        config_sha256=args.config_sha256,
        source_root=str(selected),
        image_id=image_id,
        backend_id=backend_container,
    )
    del activation_raw, activation
    _validate_helper_logged(helper_id)
    config_raw = _control_raw(control, "runtime-control/runtime-service/docker-all.json", maximum=256 * 1024)
    owner_raw = _control_raw(control, "runtime-control/runtime-services/OWNER.json", maximum=256 * 1024)
    config = _read_json_bytes(config_raw, "runtime service configuration", 256 * 1024)
    owner = _read_json_bytes(owner_raw, "runtime service owner", 256 * 1024)
    if config.get("schema_version") != "runtime_service_config.v2" or config.get("target_id") != "docker-all":
        _fail("runtime service configuration is outside the selected accepted store")
    if (owner.get("schema_version") != "runtime_service_owner.v1"
            or owner.get("state") != "failed"
            or owner.get("target_id") != "docker-all"):
        _fail("runtime service owner descriptor is outside the selected accepted store")
    _validate_incarnation(backend_id, image_id, started_at)
    return {
        "selected": selected,
        "layout": layout,
        "identity": identity,
        "control": control,
        "previous": previous,
        "document": document,
        "compose_raw": compose_raw,
        "backend_id": backend_id,
        "backend_document": backend_document,
        "image_id": image_id,
        "backend_started_at": started_at,
        "original_backend_id": backend_container,
        "iteration_attempt": args.iteration_attempt,
        "iteration_relative": iteration_pin["relative"],
        "iteration_sha256": iteration_pin["sha256"],
        "helper_id": helper_id,
        "activation_inputs": activation_inputs,
        "config_raw": config_raw,
        "owner_raw": owner_raw,
        "config": config,
        "owner": owner,
    }


def _assert_child_lock_alive(context: Mapping[str, object]) -> None:
    lock_process = context.get("maintenance_lock_process")
    if lock_process is not None and lock_process.poll() is not None:
        _fail("maintenance child lock exited; inspect the operation before retrying")


def _recheck_context(args: argparse.Namespace, context: Mapping[str, object]) -> None:
    _assert_child_lock_alive(context)
    from docker_volume_activation_reconcile import (
        _validate_activation_receipt,
        _validate_helper,
        _validate_helper_logged,
    )
    from docker_volume_stop_diagnostic import _validate_resume_terminal

    control = context["control"]
    pending = args.pending_activation
    helper_name = "fullmag-control-" + pending
    _, helper_id = _validate_helper(control, helper_name, pending)
    if helper_id != context["helper_id"]:
        _fail("original activation helper incarnation changed")
    if _control_raw(control, "active") != (pending + "\n").encode("ascii"):
        _fail("original activation no longer owns the exact control lease")
    _validate_helper_logged(helper_id)
    _validate_activation_receipt(
        control,
        activation_attempt=pending,
        development_attempt=args.attempt,
        config_sha256=args.config_sha256,
        source_root=str(context["selected"]),
        image_id=context["image_id"],
        backend_id=context["original_backend_id"],
    )
    iteration = _validate_resume_terminal(
        control,
        context["iteration_attempt"],
        development_attempt=args.attempt,
        config_sha256=args.config_sha256,
        previous=context["previous"],
        phase="iteration",
    )
    if (
        iteration.get("relative") != context["iteration_relative"]
        or iteration.get("sha256") != context["iteration_sha256"]
        or iteration.get("backend_container") != context["backend_id"]
        or iteration.get("backend_started_at") != context["backend_started_at"]
    ):
        _fail("successful iteration continuation changed under the retained helper")
    config_raw = _control_raw(control, "runtime-control/runtime-service/docker-all.json", maximum=256 * 1024)
    owner_raw = _control_raw(control, "runtime-control/runtime-services/OWNER.json", maximum=256 * 1024)
    if _sha256(config_raw) != _sha256(context["config_raw"]):
        _fail("runtime service configuration changed under the retained helper")
    if _sha256(owner_raw) != _sha256(context["owner_raw"]):
        _fail("runtime service owner changed under the retained helper")
    _validate_incarnation(
        context["backend_id"], context["image_id"], context["backend_started_at"]
    )


def _build_records(
    args: argparse.Namespace,
    context: Mapping[str, object],
    request_id: str,
    durable: Mapping[str, object],
) -> dict[str, object]:
    records = {
        **durable,
        "request_id": request_id,
        "config_sha256": _sha256(context["config_raw"]),
        "owner_sha256": _sha256(context["owner_raw"]),
        "expected_owner": context["owner"],
    }
    if records.get("catalog_sha256") is None or records.get("lease_sha256") is None or records.get("receipt_sha256") is None:
        _fail("failed-worker durable records omitted one immutable raw digest")
    return records


def _plan_document(
    args: argparse.Namespace,
    context: Mapping[str, object],
    request_id: str,
    native_request: Mapping[str, object],
    request_raw: bytes,
    source: Mapping[str, object],
) -> dict[str, object]:
    reconciliation = native_request["reconciliation"]
    lease = reconciliation["expected_lease"]
    receipt = reconciliation["expected_receipt"]
    return {
        "schema": REQUEST_SCHEMA,
        "state": "preview",
        "operation_id": request_id,
        "compose_project": context["control"].project,
        "control_volume": context["control"].volume,
        "development_attempt": args.attempt,
        "iteration_attempt": args.iteration_attempt,
        "iteration_terminal_sha256": context["iteration_sha256"],
        "activation_attempt": args.pending_activation,
        "config_sha256": native_request["config_sha256"],
        "owner_sha256": native_request["owner_sha256"],
        "request_sha256": _sha256(request_raw),
        "request_bytes": len(request_raw),
        "source_identity": {
            key: source[key]
            for key in ("resolved_commit", "source_digest", "source_snapshot_sha256", "live_manifest_sha256")
        },
        "backend": {
            "container_id": context["backend_id"],
            "image_id": context["image_id"],
            "started_at": context["backend_started_at"],
        },
        "run_id": lease["run_id"],
        "task_id": lease["task_id"],
        "lease_token": lease["lease_token"],
        "receipt_id": receipt["receipt_id"],
        "candidate": "not-built-in-preview",
        "native_request": dict(native_request),
    }


def _log_document(
    request_id: str,
    *,
    capture_raw: bytes = b"",
    build_stdout: bytes = b"",
    build_stderr: bytes = b"",
    native_stdout: bytes = b"",
    native_stderr: bytes = b"",
) -> dict[str, object]:
    streams = {
        "capture": capture_raw,
        "build_stdout": build_stdout,
        "build_stderr": build_stderr,
        "native_stdout": native_stdout,
        "native_stderr": native_stderr,
    }
    return {
        "schema": SUBOPERATION_SCHEMA,
        "state": "logged",
        "operation_id": request_id,
        "streams": {
            name: {
                "sha256": _sha256(data),
                "bytes": len(data),
                "tail": _bounded_text(data, LOG_TAIL_BYTES),
            }
            for name, data in streams.items()
        },
    }


def _receipt_document(
    args: argparse.Namespace,
    context: Mapping[str, object],
    request_id: str,
    request_raw: bytes,
    *,
    state: str,
    native_result: Mapping[str, object] | None = None,
    error: str | None = None,
    candidate_receipt_sha256: str | None = None,
    candidate_package: str | None = None,
    phase: str | None = None,
    native_invoked: bool | None = None,
) -> dict[str, object]:
    document: dict[str, object] = {
        "schema": RECEIPT_SCHEMA,
        "state": state,
        "operation_id": request_id,
        "compose_project": context["control"].project,
        "control_volume": context["control"].volume,
        "development_attempt": args.attempt,
        "iteration_attempt": args.iteration_attempt,
        "iteration_terminal_sha256": context["iteration_sha256"],
        "activation_attempt": args.pending_activation,
        "request_sha256": _sha256(request_raw),
        "request_bytes": len(request_raw),
        "backend_container_id": context["backend_id"],
        "backend_started_at": context["backend_started_at"],
        "candidate_receipt_sha256": candidate_receipt_sha256,
        "candidate_package": candidate_package,
        "native_result": dict(native_result) if native_result is not None else None,
    }
    if error is not None:
        document["error"] = " ".join(str(error).split())[-2048:]
    if phase is not None:
        document["phase"] = phase
    if native_invoked is not None:
        document["native_invoked"] = native_invoked
    return document


def _source_record(request_id: str, source: Mapping[str, object]) -> dict[str, object]:
    identity_keys = (
        "resolved_commit",
        "source_digest",
        "source_snapshot_sha256",
        "live_manifest_sha256",
    )
    return {
        "schema": "fullmag.docker-failed-worker-reconciliation-source.v1",
        "operation_id": request_id,
        "manifest_path": source["manifest_path"],
        "source_identity": {key: source[key] for key in identity_keys},
    }


def _existing_operation(
    control: Any,
    operation_root: str,
    request_id: str,
) -> tuple[
    dict[str, object] | None,
    bytes | None,
    dict[str, object] | None,
    dict[str, object] | None,
]:
    prior_failure_raw = _control_raw(control, operation_root + "/pre-native-failure.json", optional=True)
    if prior_failure_raw is not None:
        prior_failure = _read_json_bytes(prior_failure_raw, "prior pre-native failure")
        if prior_failure.get("schema") != RECEIPT_SCHEMA or prior_failure.get("operation_id") != request_id:
            _fail("prior pre-native failure has a foreign identity")
        _fail("this operation failed before native execution; inspect it before a new request")
    # Preparation and apply have separate immutable terminals.  A native apply
    # may have released the lease before the client was interrupted; never try
    # to overwrite the preparation receipt while recovering that outcome.
    receipt_raw = _control_raw(control, operation_root + "/terminal.json", optional=True)
    if receipt_raw is None:
        receipt_raw = _control_raw(control, operation_root + "/prepare-receipt.json", optional=True)
    if receipt_raw is None:
        return None, None, None, None
    receipt = _read_json_bytes(receipt_raw, "existing reconciliation receipt")
    if (
        receipt.get("schema") != RECEIPT_SCHEMA
        or receipt.get("operation_id") != request_id
    ):
        _fail("existing failed-worker reconciliation receipt has a foreign identity")
    request_raw = _control_raw(control, operation_root + "/request.json", optional=True)
    source_raw = _control_raw(control, operation_root + "/source.json", optional=True)
    request = (
        _read_json_bytes(request_raw, "existing reconciliation request")
        if request_raw is not None
        else None
    )
    source = (
        _read_json_bytes(source_raw, "existing reconciliation source")
        if source_raw is not None
        else None
    )
    return receipt, request_raw, request, source


def _invoke_native(
    backend_id: str,
    package: str,
    config_path: str,
    request_path: str,
    *,
    apply: bool,
    candidate_receipt_sha256: str,
    candidate_receipt_path: str,
) -> tuple[bytes, bytes]:
    _require_digest(candidate_receipt_sha256, "candidate receipt digest")
    command = native_command(
        _candidate_executable(package), config_path, request_path, apply=apply
    )
    request_parent = str(PurePosixPath(request_path).parent)
    if candidate_receipt_path != request_parent + "/candidate-receipt.json":
        _fail("maintenance candidate receipt is outside the immutable request scope")
    command.extend(("--candidate-receipt", candidate_receipt_path,
                    "--candidate-receipt-sha256", candidate_receipt_sha256))
    environment = {
        "FULLMAG_RUNTIME_ROOT": package,
        "FULLMAG_RUNTIME_PACKAGE_ROOT": package,
        "FULLMAG_WEB_STATIC_DIR": package + "/web",
        "PATH": package + "/bin:/opt/fullmag-deps/bin:/usr/local/cuda/bin:/usr/local/bin:/usr/bin:/bin",
    }
    return _exec(
        backend_id,
        ("/usr/local/bin/python3", "-B", "-c", VALIDATE_AND_EXEC_CANDIDATE_SCRIPT,
         package, candidate_receipt_sha256, *command),
        timeout=600,
        stdout_limit=MAX_RESULT_BYTES,
        stderr_limit=MAX_LOG_BYTES,
        environment=environment,
    )


def _validate_existing_candidate(
    control: Any,
    operation_root: str,
    request_id: str,
    request_raw: bytes,
    source: Mapping[str, object],
    receipt: Mapping[str, object],
    stored_request_raw: bytes | None,
    stored_source: Mapping[str, object] | None,
) -> tuple[str, dict[str, object], bytes]:
    if stored_request_raw != request_raw:
        _fail("prepared candidate request differs from the current durable pins")
    request = _read_json_bytes(request_raw, "prepared candidate native request")
    reconciliation = _object(request.get("reconciliation"), "prepared candidate reconciliation")
    lease = _object(reconciliation.get("expected_lease"), "prepared candidate lease")
    exit_receipt = _object(reconciliation.get("expected_receipt"), "prepared candidate exit receipt")
    native_result = validate_native_result(
        _object(receipt.get("native_result"), "prepared native preview"),
        _sha256(request_raw), lease.get("run_id"), lease.get("task_id"),
        lease.get("lease_token"), exit_receipt.get("receipt_id"), request_id=request_id,
    )
    if native_result.get("disposition") != "validated" or native_result.get("release_proof_sha256") is not None:
        _fail("prepared candidate has no successful native preview")
    if not isinstance(stored_source, Mapping):
        _fail("prepared candidate has no immutable source capture record")
    if (
        stored_source.get("schema") != "fullmag.docker-failed-worker-reconciliation-source.v1"
        or stored_source.get("operation_id") != request_id
        or stored_source.get("manifest_path") != source.get("manifest_path")
        or stored_source.get("source_identity") != {
            key: source[key]
            for key in (
                "resolved_commit",
                "source_digest",
                "source_snapshot_sha256",
                "live_manifest_sha256",
            )
        }
    ):
        _fail("prepared candidate source capture differs from the current source")
    candidate_package = receipt.get("candidate_package")
    expected_package = "/build/maintenance/" + request_id + "/package"
    if candidate_package != expected_package:
        _fail("prepared candidate package path differs from its request")
    candidate_raw = _control_raw(
        control, operation_root + "/candidate-receipt.json", maximum=MAX_CANDIDATE_RECEIPT_BYTES
    )
    if candidate_raw is None:
        _fail("prepared candidate has no immutable build receipt")
    candidate = _read_json_bytes(
        candidate_raw, "prepared candidate build receipt", MAX_CANDIDATE_RECEIPT_BYTES
    )
    validate_candidate_receipt(candidate, source)
    candidate_digest = _sha256(candidate_raw)
    if receipt.get("candidate_receipt_sha256") != candidate_digest:
        _fail("prepared candidate receipt digest differs from its terminal receipt")
    return expected_package, candidate, candidate_raw


def _validate_stored_native_request(
    request: Mapping[str, object],
    request_raw: bytes,
    request_id: str,
    args: argparse.Namespace,
    context: Mapping[str, object],
    receipt: Mapping[str, object],
) -> dict[str, object]:
    if _canonical_json(dict(request)) != request_raw:
        _fail("prepared candidate request is not canonical and immutable")
    if set(request) != {
        "schema_version", "request_id", "config_sha256", "owner_sha256",
        "expected_owner", "expected_catalog_sha256", "expected_lease_sha256",
        "expected_receipt_sha256", "reconciliation",
    }:
        _fail("prepared candidate request has an unsupported shape")
    if request.get("schema_version") != NATIVE_REQUEST_SCHEMA or request.get("request_id") != request_id:
        _fail("prepared candidate request identity differs")
    if request.get("config_sha256") != _sha256(context["config_raw"]):
        _fail("prepared candidate runtime config pin differs")
    if request.get("owner_sha256") != _sha256(context["owner_raw"]):
        _fail("prepared candidate runtime owner pin differs")
    if request.get("expected_owner") != context["owner"]:
        _fail("prepared candidate expected owner differs")
    reconciliation = request.get("reconciliation")
    if not isinstance(reconciliation, Mapping) or set(reconciliation) != {
        "expected_catalog_revision", "expected_task", "expected_lease",
        "expected_receipt", "expected_reservation",
    }:
        _fail("prepared candidate reconciliation shape differs")
    task = reconciliation.get("expected_task")
    lease = reconciliation.get("expected_lease")
    worker_receipt = reconciliation.get("expected_receipt")
    if not isinstance(task, Mapping) or not isinstance(lease, Mapping) or not isinstance(worker_receipt, Mapping):
        _fail("prepared candidate reconciliation records are malformed")
    if (
        lease.get("state") != "active"
        or lease.get("run_id") != args.run_id
        or lease.get("task_id") != args.task_id
        or task.get("task_id") != args.task_id
        or worker_receipt.get("run_id") != args.run_id
        or worker_receipt.get("task_id") != args.task_id
        or worker_receipt.get("receipt_id") != args.exit_receipt_id
        or receipt.get("request_sha256") != _sha256(request_raw)
    ):
        _fail("prepared candidate request scope or original active lease differs")
    return dict(request)


def run(args: argparse.Namespace) -> dict[str, object]:
    """Preview, prepare, or apply one exact reconciliation under the parent lease."""

    _validate_args(args)
    try:
        context = _load_context(args)
    except ReconciliationError:
        raise
    except RuntimeError as error:
        raise ReconciliationError("failed-worker context validation failed: " + str(error)) from error
    request_id = _request_id_for_args(args)
    operation = ReconciliationOperation(
        request_id=request_id,
        root=_operation_root(args.pending_activation) + "/" + request_id,
    )
    # Serialize maintenance children and resource changes while retaining the
    # original activation helper as the only /control/active owner.
    with _maintenance_lock(context["control"], args.pending_activation) as lock_process:
        if lock_process is None or lock_process.poll() is not None:
            _fail("maintenance child lock is not alive")
        context["maintenance_lock_process"] = lock_process
        return _run_with_failure_receipt(args, context, operation)


def _maintenance_lock(control: Any, activation_attempt: str):
    from docker_volume_resources import _resource_lock

    _require_attempt(activation_attempt, "pending activation")
    return _resource_lock(control, "activation/attempts/" + activation_attempt, activation_attempt)


def _run_with_failure_receipt(
    args: argparse.Namespace,
    context: Mapping[str, object],
    operation: ReconciliationOperation,
) -> dict[str, object]:
    try:
        return _run_authenticated(args, context, operation)
    except Exception as error:
        if (operation.recordable and not operation.native_invoked and not operation.terminal_recorded
                and (getattr(args, "prepare_candidate", False) or getattr(args, "apply", False))):
            try:
                _record_pre_native_failure(args, context, operation, error)
            except Exception as record_error:
                raise ReconciliationError(
                    "failure before native execution could not be recorded safely: " + str(record_error)
                ) from error
        raise


def _record_pre_native_failure(
    args: argparse.Namespace,
    context: Mapping[str, object],
    operation: ReconciliationOperation,
    error: Exception,
) -> None:
    # Only publish under a still-authenticated parent helper. A client timeout
    # may leave a Docker-side capture/build running, even though native release
    # was never invoked; record that uncertainty separately from ledger state.
    _recheck_context(args, context)
    cause = error.__cause__
    document = {
        "schema": RECEIPT_SCHEMA,
        "state": "failed-before-native",
        "operation_id": operation.request_id,
        "phase": operation.phase,
        "development_attempt": args.attempt,
        "iteration_attempt": args.iteration_attempt,
        "activation_attempt": args.pending_activation,
        "compose_project": context["control"].project,
        "control_volume": context["control"].volume,
        "backend_container_id": context["backend_id"],
        "run_id": args.run_id,
        "task_id": args.task_id,
        "exit_receipt_id": args.exit_receipt_id,
        "native_invoked": False,
        "daemon_operation_may_remain": bool(getattr(cause, "reconciliation_required", False)),
        "error": " ".join(str(error).split())[-2048:],
    }
    raw = _canonical_json(document)
    if operation.prepared_candidate:
        name = "apply-pre-native-failure-" + _sha256(raw) + ".json"
    else:
        name = "pre-native-failure.json"
    _publish_immutable(context["control"], operation.path(name), raw)


def _run_authenticated(
    args: argparse.Namespace,
    context: Mapping[str, object],
    operation: ReconciliationOperation,
) -> dict[str, object]:
    request_id = operation.request_id
    control = context["control"]
    operation_root = operation.root
    request_relative = operation.path("request.json")
    source_relative = operation.path("source.json")
    candidate_relative = operation.path("candidate-receipt.json")
    prepare_log_relative = operation.path("prepare-log.json")
    prepare_receipt_relative = operation.path("prepare-receipt.json")
    apply_log_relative = operation.path("apply-log.json")
    terminal_relative = operation.path("terminal.json")
    operation_relative = operation.path("operation.json")

    _recheck_context(args, context)
    existing, stored_request_raw, stored_request, stored_source = _existing_operation(
        control, operation_root, request_id
    )
    if existing is not None and existing.get("state") == "succeeded":
        if (
            stored_request_raw is None
            or existing.get("request_sha256") != _sha256(stored_request_raw)
            or existing.get("compose_project") != control.project
            or existing.get("control_volume") != control.volume
            or existing.get("development_attempt") != args.attempt
            or existing.get("activation_attempt") != args.pending_activation
            or existing.get("iteration_attempt") != args.iteration_attempt
            or existing.get("iteration_terminal_sha256") != context["iteration_sha256"]
            or existing.get("backend_container_id") != context["backend_id"]
            or existing.get("backend_started_at") != context["backend_started_at"]
        ):
            _fail("existing failed-worker terminal receipt is not pinned to this context")
        if stored_request is None:
            _fail("existing failed-worker success has no immutable request")
        request = _validate_stored_native_request(
            stored_request, stored_request_raw, request_id, args, context, existing
        )
        lease = request["reconciliation"]["expected_lease"]
        result = validate_native_result(
            _object(existing.get("native_result"), "stored native result"),
            _sha256(stored_request_raw), args.run_id, args.task_id,
            lease["lease_token"], args.exit_receipt_id, request_id=request_id,
        )
        if result["disposition"] != "released" or result["release_proof_sha256"] is None:
            _fail("existing failed-worker success has no native release proof")
        return existing
    if existing is not None and existing.get("state") not in {"candidate-prepared"}:
        _fail("existing failed-worker reconciliation has no safe terminal success")
    if existing is not None and (
        existing.get("compose_project") != control.project
        or existing.get("control_volume") != control.volume
        or existing.get("development_attempt") != args.attempt
        or existing.get("activation_attempt") != args.pending_activation
        or existing.get("iteration_attempt") != args.iteration_attempt
        or existing.get("iteration_terminal_sha256") != context["iteration_sha256"]
        or existing.get("backend_container_id") != context["backend_id"]
        or existing.get("backend_started_at") != context["backend_started_at"]
    ):
        _fail("existing prepared candidate receipt is not pinned to this context")

    prepare_candidate = bool(getattr(args, "prepare_candidate", False))
    apply = bool(getattr(args, "apply", False))
    if apply and existing is None:
        _fail("apply requires the same successfully prepared and native-validated candidate")
    if apply and _control_raw(control, operation.path("apply-start.json"), optional=True) is not None:
        _fail("a previous apply may still be running or have committed; inspect its durable outcome")
    operation.recordable = True
    operation.prepared_candidate = existing is not None
    operation.phase = "source-capture"
    source, capture_raw = _capture_source(context["backend_id"], request_id)
    _recheck_context(args, context)
    if existing is not None and apply:
        if stored_request is None or stored_request_raw is None:
            _fail("prepared candidate has no immutable request")
        native_request = _validate_stored_native_request(
            stored_request,
            stored_request_raw,
            request_id,
            args,
            context,
            existing,
        )
        request_raw = stored_request_raw
    else:
        operation.phase = "collect-durable-records"
        durable = _collect_expected_records(
            context["backend_id"], args.run_id, args.task_id, args.exit_receipt_id
        )
        records = _build_records(args, context, request_id, durable)
        native_request = build_native_request(records)
        request_raw = _canonical_json(native_request)
    plan = _plan_document(args, context, request_id, native_request, request_raw, source)
    if not prepare_candidate and not apply:
        return plan

    # A prepared candidate is resumable only if every input is still the same
    # byte-for-byte request and its source/build receipt remain pinned.
    package: str | None = None
    candidate_receipt: dict[str, object] | None = None
    candidate_receipt_raw: bytes | None = None
    build_stdout = b""
    build_stderr = b""
    if existing is not None:
        operation.phase = "validate-prepared-candidate"
        if stored_request is None or stored_request_raw is None:
            _fail("prepared candidate has no immutable request")
        package, candidate_receipt, candidate_receipt_raw = _validate_existing_candidate(
            control,
            operation_root,
            request_id,
            request_raw,
            source,
            existing,
            stored_request_raw,
            stored_source,
        )
        actual_candidate, actual_candidate_raw = _read_candidate_receipt(
            context["backend_id"], package, source
        )
        if actual_candidate_raw != candidate_receipt_raw or actual_candidate != candidate_receipt:
            _fail("prepared candidate package receipt differs from its immutable control receipt")
        if prepare_candidate:
            return existing
    else:
        operation.phase = "publish-request"
        _assert_child_lock_alive(context)
        _publish_immutable(control, request_relative, request_raw)
        _assert_child_lock_alive(context)
        _publish_immutable(control, source_relative, _canonical_json(_source_record(request_id, source)))
        operation_record = {
            "schema": SUBOPERATION_SCHEMA,
            "state": "request-published",
            "operation_id": request_id,
            "development_attempt": args.attempt,
            "activation_attempt": args.pending_activation,
            "request_path": request_relative,
            "request_sha256": _sha256(request_raw),
            "compose_project": control.project,
            "control_volume": control.volume,
            "config_sha256": native_request["config_sha256"],
            "owner_sha256": native_request["owner_sha256"],
            "source_identity": plan["source_identity"],
            "backend": plan["backend"],
            "native_scope": {
                "run_id": args.run_id,
                "task_id": args.task_id,
                "receipt_id": args.exit_receipt_id,
            },
            "mode": "prepare-candidate" if prepare_candidate else "apply",
        }
        _assert_child_lock_alive(context)
        _publish_immutable(control, operation_relative, _canonical_json(operation_record))
        _recheck_context(args, context)
        operation.phase = "candidate-build"
        package, candidate_receipt, candidate_receipt_raw, build_stdout, build_stderr = _prepare_candidate(
            context["backend_id"], request_id, source
        )
        _recheck_context(args, context)
        _publish_immutable(control, candidate_relative, candidate_receipt_raw)

    if package is None or candidate_receipt is None or candidate_receipt_raw is None:
        _fail("failed-worker reconciliation candidate state is incomplete")
    candidate_receipt_sha256 = _sha256(candidate_receipt_raw)
    request_path = "/opt/fullmag/control/" + request_relative
    config_path = "/opt/fullmag/runtime-control/runtime-service/docker-all.json"
    native_stdout = b""
    native_stderr = b""
    native_started = False
    try:
        _recheck_context(args, context)
        if apply:
            # Persist the fence before invoking native. A lost client response
            # cannot silently turn an uncertain mutation into a fresh retry.
            apply_start = {
                "schema": SUBOPERATION_SCHEMA,
                "state": "applying",
                "operation_id": request_id,
                "activation_attempt": args.pending_activation,
                "iteration_attempt": args.iteration_attempt,
                "request_sha256": _sha256(request_raw),
                "candidate_receipt_sha256": candidate_receipt_sha256,
                "backend_container_id": context["backend_id"],
                "backend_started_at": context["backend_started_at"],
                "run_id": args.run_id,
                "task_id": args.task_id,
                "exit_receipt_id": args.exit_receipt_id,
            }
            _publish_immutable(control, operation.path("apply-start.json"), _canonical_json(apply_start))
        native_started = True
        operation.native_invoked = True
        operation.phase = "native-apply" if apply else "native-preview"
        native_stdout, native_stderr = _invoke_native(
            context["backend_id"],
            package,
            config_path,
            request_path,
            apply=apply,
            candidate_receipt_sha256=candidate_receipt_sha256,
            candidate_receipt_path="/opt/fullmag/control/" + candidate_relative,
        )
        native_result = _native_output(native_stdout)
        reconciliation = native_request["reconciliation"]
        lease = reconciliation["expected_lease"]
        receipt = reconciliation["expected_receipt"]
        validated = validate_native_result(
            native_result,
            _sha256(request_raw),
            lease["run_id"],
            lease["task_id"],
            lease["lease_token"],
            receipt["receipt_id"],
            request_id=request_id,
        )
        if prepare_candidate and (
            validated.get("disposition") != "validated"
            or validated.get("release_proof_sha256") is not None
        ):
            _fail("candidate preparation native probe attempted a release")
        if apply and (
            validated.get("disposition") != "released"
            or not isinstance(validated.get("release_proof_sha256"), str)
        ):
            _fail("native reconciliation did not publish a release proof")
        _recheck_context(args, context)
        _publish_log_once(
            control,
            apply_log_relative if apply else prepare_log_relative,
            _canonical_json(
                _log_document(
                    request_id,
                    capture_raw=capture_raw,
                    build_stdout=build_stdout,
                    build_stderr=build_stderr,
                    native_stdout=native_stdout,
                    native_stderr=native_stderr,
                )
            ),
            request_id,
        )
        terminal = _receipt_document(
            args,
            context,
            request_id,
            request_raw,
            state="succeeded" if apply else "candidate-prepared",
            native_result=validated,
            candidate_receipt_sha256=candidate_receipt_sha256,
            candidate_package=package,
        )
        _publish_immutable(
            control,
            terminal_relative if apply else prepare_receipt_relative,
            _canonical_json(terminal),
        )
        return terminal
    except Exception as error:
        # A candidate build/probe failure is known before native mutation. A
        # native timeout/nonzero result is retained as unknown because the
        # writer may have committed before the client observed it.
        state = "outcome-unknown-resources-retained" if apply and native_started else "failed-confirmed"
        try:
            _recheck_context(args, context)
            _publish_log_once(
                control,
                apply_log_relative if apply else prepare_log_relative,
                _canonical_json(
                    _log_document(
                        request_id,
                        capture_raw=capture_raw,
                        build_stdout=build_stdout,
                        build_stderr=build_stderr,
                        native_stdout=native_stdout,
                        native_stderr=native_stderr,
                    )
                ),
                request_id,
            )
            _publish_immutable(
                control,
                terminal_relative if apply else prepare_receipt_relative,
                _canonical_json(
                    _receipt_document(
                        args,
                        context,
                        request_id,
                        request_raw,
                        state=state,
                        error=error,
                        candidate_receipt_sha256=candidate_receipt_sha256,
                        candidate_package=package,
                        phase=operation.phase,
                        native_invoked=native_started,
                    )
                ),
            )
            operation.terminal_recorded = True
        except Exception as record_error:
            raise ReconciliationError(
                "failed-worker reconciliation outcome requires inspection and its receipt could not be retained: "
                + str(record_error)
            ) from error
        raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--iteration-attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--pending-activation", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--exit-receipt-id", required=True)
    parser.add_argument(
        "--request-id",
        help="optional canonical UUID; reuse it to apply a previously prepared candidate",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--prepare-candidate",
        action="store_true",
        help="build and native-validate an isolated candidate without releasing the lease",
    )
    mode.add_argument(
        "--apply",
        action="store_true",
        help="publish and invoke the exact native reconciliation; default is preview",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = run(args)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (BuildControlError, OSError, ValueError, TypeError) as error:
        print("failed-worker-reconciliation: " + str(error), file=os.sys.stderr)
        return 2


SOURCE_CAPTURE_SCRIPT = r'''
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, "/opt/fullmag")
from backend_source import capture_live_source_manifest

token = sys.argv[1]
if not token or any(character not in "0123456789abcdef-" for character in token):
    raise SystemExit("invalid reconciliation request token")
root = Path("/build/maintenance") / token
capture_root = root / "source-capture"
capture_root.mkdir(parents=True, exist_ok=True)
manifest = capture_live_source_manifest(
    Path("/opt/fullmag/source"), Path("/opt/fullmag/source-git"), capture_root
)
raw = manifest.read_bytes()
if len(raw) > 64 * 1024 * 1024:
    raise RuntimeError("live source manifest exceeds its bound")
value = json.loads(raw)
if not isinstance(value, dict):
    raise RuntimeError("live source manifest is not an object")
value["manifest_path"] = str(manifest)
value["manifest_sha256"] = hashlib.sha256(raw).hexdigest()
sys.stdout.write(json.dumps(value, sort_keys=True, separators=(",", ":")))
sys.stdout.write("\n")
'''



VALIDATE_AND_EXEC_CANDIDATE_SCRIPT = r'''
import hashlib
import os
from pathlib import Path
import stat
import sys

sys.path.insert(0, "/opt/fullmag")
from backend_dev import _validated_package, _assert_direct_candidate_inventory

root = Path(sys.argv[1])
expected_receipt_sha256 = sys.argv[2]
command = sys.argv[3:]
if not root.is_absolute() or root.resolve() != root:
    raise RuntimeError("candidate package root is not canonical")
for parent in (*reversed(root.parents), root):
    metadata = parent.lstat()
    if not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError("candidate package parent is not a regular directory")
receipt, receipt_raw, _ = _validated_package(root, "failed-worker maintenance")
# Reuse the image-owned package tree gate before executing anything. The
# legacy prepare route may contain the known, unused launcher bin/fullmag.
records = list(receipt["artifacts"])
legacy_launcher = root / "bin/fullmag"
if legacy_launcher.exists() or legacy_launcher.is_symlink():
    records.append({"path": "bin/fullmag"})
_assert_direct_candidate_inventory(root, records, include_receipt=True)
if hashlib.sha256(receipt_raw).hexdigest() != expected_receipt_sha256:
    raise RuntimeError("candidate receipt differs from immutable control receipt")
binary = root / "bin/fullmag-runtime-service"
if not command or command[0] != str(binary):
    raise RuntimeError("candidate command executable differs")
for parent in (root / "bin",):
    if not stat.S_ISDIR(parent.lstat().st_mode):
        raise RuntimeError("candidate binary parent is not a regular directory")
artifact = next(item for item in receipt["artifacts"] if item["path"] == "bin/fullmag-runtime-service")
fd = os.open(binary, os.O_RDONLY | os.O_NOFOLLOW)
try:
    before = os.fstat(fd)
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or not before.st_mode & 0o111 or not 0 < before.st_size <= 16 * 1024**3
            or before.st_size != artifact["size"]):
        raise RuntimeError("candidate executable metadata differs from its receipt")
    digest = hashlib.sha256()
    remaining = before.st_size
    while remaining:
        chunk = os.read(fd, min(1024 * 1024, remaining))
        if not chunk:
            raise RuntimeError("candidate executable was truncated")
        digest.update(chunk)
        remaining -= len(chunk)
    after = os.fstat(fd)
    def signature(metadata):
        return (metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_nlink,
                metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns)
    if (signature(before) != signature(after) or digest.hexdigest() != artifact["sha256"]):
        raise RuntimeError("candidate executable bytes differ from its receipt")
    # Execute the verified open file, rather than reopening a replaceable path.
    os.execve(fd, command, dict(os.environ))
finally:
    os.close(fd)
'''


READ_REGULAR_JSON_SCRIPT = r'''
import os
import stat
import sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.is_absolute() or ".." in path.parts or path.is_symlink():
    raise SystemExit("record path is not canonical")
if path.parent.resolve(strict=True) != path.parent:
    raise SystemExit("record parent is not canonical")
fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
try:
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise SystemExit("record is not one regular file")
    data = os.read(fd, 8 * 1024 * 1024 + 1)
    if len(data) != metadata.st_size or len(data) > 8 * 1024 * 1024:
        raise SystemExit("record exceeds its byte bound")
finally:
    os.close(fd)
sys.stdout.buffer.write(data)
'''


COLLECT_EXPECTED_SCRIPT = r'''
import hashlib
import json
import os
import pathlib
import stat
import sys

RUN_ID, TASK_ID, RECEIPT_ID = sys.argv[1:4]
ID_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-")
MAX = 16 * 1024 * 1024

def valid_id(value):
    return (isinstance(value, str) and 0 < len(value) <= 128
            and value not in (".", "..") and set(value) <= ID_CHARS)

if not all(valid_id(value) for value in (RUN_ID, TASK_ID, RECEIPT_ID)):
    raise RuntimeError("reconciliation identity is invalid")

def raw(path, maximum=MAX):
    path = pathlib.Path(path)
    if (not path.is_absolute() or ".." in path.parts
            or path.parent.resolve(strict=True) != path.parent):
        raise RuntimeError("record path is not canonical")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        metadata = os.fstat(fd)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                or metadata.st_size > maximum):
            raise RuntimeError("record is not one bounded regular file")
        data = os.read(fd, maximum + 1)
        if len(data) != metadata.st_size or len(data) > maximum:
            raise RuntimeError("record changed while being read")
        return data
    finally:
        os.close(fd)

def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise RuntimeError("duplicate JSON key")
        value[key] = item
    return value

def obj(data, label):
    try:
        value = json.loads(
            data.decode("utf-8"), object_pairs_hook=unique,
            parse_constant=lambda token: (_ for _ in ()).throw(ValueError(token)),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise RuntimeError(label + " is not finite JSON") from error
    if not isinstance(value, dict):
        raise RuntimeError(label + " is not an object")
    return value

root = pathlib.Path("/state/runs/docker-all/session-store")
if root.resolve(strict=True) != root:
    raise RuntimeError("session store root is not canonical")
run_root = root / "runs" / RUN_ID
catalog_path = run_root / "run_catalog.json"
catalog_raw = raw(catalog_path)
catalog = obj(catalog_raw, "run catalog")
if catalog.get("schema_version") != "run_catalog.v1" or catalog.get("run_id") != RUN_ID:
    raise RuntimeError("run catalog identity differs")
revision = catalog.get("revision")
if type(revision) is not int or revision <= 0:
    raise RuntimeError("run catalog revision is invalid")
tasks = catalog.get("tasks")
if not isinstance(tasks, list):
    raise RuntimeError("run catalog task list is invalid")
matches = [task for task in tasks if isinstance(task, dict) and task.get("task_id") == TASK_ID]
if len(matches) != 1:
    raise RuntimeError("run catalog does not contain one exact task")
task = matches[0]
if task.get("lifecycle") != "failed":
    raise RuntimeError("selected task is not failed")
for key in ("attempt_id", "ownership_epoch", "resource_id"):
    if task.get(key) is None:
        raise RuntimeError("failed task has no durable " + key)
# The authoritative exit receipt identifies the exact lease; never scan the
# resource directory and infer a lease from a terminal task alone.
receipt_path = run_root / "worker_process_exit_receipts" / (RECEIPT_ID + ".json")
receipt_raw = raw(receipt_path)
receipt = obj(receipt_raw, "worker process exit receipt")
resource_id = receipt.get("resource_id")
lease_token = receipt.get("lease_token")
if (not valid_id(resource_id) or not valid_id(lease_token)
        or receipt.get("receipt_id") != RECEIPT_ID or receipt.get("run_id") != RUN_ID
        or receipt.get("task_id") != TASK_ID or resource_id != task.get("resource_id")
        or receipt.get("attempt_id") != task.get("attempt_id")
        or receipt.get("ownership_epoch") != task.get("ownership_epoch")):
    raise RuntimeError("worker process exit receipt identity differs")
lease_path = run_root / "resource_leases" / resource_id / (lease_token + ".json")
lease_raw = raw(lease_path)
lease = obj(lease_raw, "resource lease")
if (lease.get("state") != "active" or lease.get("run_id") != RUN_ID
        or lease.get("task_id") != TASK_ID or lease.get("resource_id") != resource_id
        or lease.get("lease_token") != lease_token
        or lease.get("attempt_id") != task.get("attempt_id")
        or lease.get("ownership_epoch") != task.get("ownership_epoch")
        or lease.get("heartbeat_sequence") != receipt.get("lease_heartbeat_sequence")):
    raise RuntimeError("exact resource lease differs from the observed failed worker")

ledger_path = pathlib.Path("/host-ledger/ledger/HOST_RESOURCE_LEDGER.json")
ledger_raw = raw(ledger_path)
ledger = obj(ledger_raw, "host resource ledger")
if ledger.get("schema_version") not in {"host_resource_ledger.v4", "host_resource_ledger.v5"}:
    raise RuntimeError("host resource ledger schema is unsupported")
rows = ledger.get("reservations")
if isinstance(rows, dict):
    rows = list(rows.values())
if not isinstance(rows, list):
    raise RuntimeError("host resource ledger reservations are invalid")
reservation_matches = []
for row in rows:
    if not isinstance(row, dict):
        raise RuntimeError("host resource ledger contains a malformed reservation")
    identity = row.get("identity")
    owner = identity.get("owner") if isinstance(identity, dict) else None
    if (isinstance(identity, dict) and isinstance(owner, dict)
            and identity.get("run_id") == RUN_ID and identity.get("task_id") == TASK_ID
            and identity.get("resource_id") == lease.get("resource_id")
            and identity.get("lease_token") == lease.get("lease_token")
            and owner.get("kind") == "solver"
            and owner.get("attempt_id") == lease.get("attempt_id")
            and owner.get("ownership_epoch") == lease.get("ownership_epoch")):
        reservation_matches.append(row)
if len(reservation_matches) != 1:
    raise RuntimeError("host ledger does not contain one exact worker reservation")
reservation = reservation_matches[0]
if reservation.get("state") != "quarantined" or reservation.get("release_proof_sha256") is not None:
    raise RuntimeError("host reservation is not an unreleased quarantine")

def digest(data):
    return hashlib.sha256(data).hexdigest()

print(json.dumps({
    "schema": "fullmag.failed-worker-reconciliation-inputs.v1",
    "catalog_revision": revision,
    "catalog_sha256": digest(catalog_raw),
    "expected_task": task,
    "expected_lease": lease,
    "lease_sha256": digest(lease_raw),
    "expected_receipt": receipt,
    "receipt_sha256": digest(receipt_raw),
    "expected_reservation": reservation,
}, sort_keys=True, separators=(",", ":")))
'''


if __name__ == "__main__":
    raise SystemExit(main())
