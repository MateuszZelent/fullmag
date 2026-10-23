"""Recover a stopped runtime namespace while preserving explicitly cancelled runs.

This command consumes one successful, typed unclaimed-task cancellation. It
revalidates the original Unknown namespace evidence, proves the original IDs
are absent, removes only the exact successful maintenance pair, and starts the
replacement through the selected Compose group's ordinary managed path. It
does not edit the run catalog or start a script/solver.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import uuid
from collections.abc import Mapping
from typing import Any

import fullmag_storage as storage
from docker_build_control import (
    BuildControl,
    BuildControlError,
    bounded_capture,
    canonical,
    build_volume_runtime_images,
    build_volume_toolchain,
    docker_capture,
    toolchain_configuration,
)
from docker_dev_host import docker_argv, require_host


OPERATION_SCHEMA = "fullmag.docker-volume-cancelled-recovery.v1"
MANIFEST_SCHEMA = "fullmag.docker-cancelled-namespace-recovery-manifest.v1"
OPERATOR_SCHEMA = "fullmag.docker-cancelled-namespace-recovery-authorization.v1"
RUNTIME_ROOT = "runtime-control"
RECOVERY_ROOT = "runtime-services/container-recovery"
RUN_STORE_RELATIVE = "runs/docker-all/session-store"
MAX_CONTROL_BYTES = 8 * 1024 * 1024
MAX_RUN_FILE_BYTES = 16 * 1024 * 1024
MAX_RETAINED_RUN_BYTES = 128 * 1024 * 1024
MAX_RETAINED_RUNS = 128
MAX_LOG_BYTES = 1024 * 1024
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
ATTEMPT_RE = re.compile(r"[0-9a-f]{32}\Z")
CONTAINER_RE = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
REQUEST_ID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)
RUN_ID_RE = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*\Z")


def _fail(message: str) -> None:
    raise BuildControlError(message)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _read_raw(control: BuildControl, relative: str, *, optional: bool = False,
              maximum: int = MAX_CONTROL_BYTES) -> bytes | None:
    import docker_volume_unclaimed_cancellation as cancellation

    return cancellation._control_raw(control, relative, optional=optional, maximum=maximum)


def _read_json(control: BuildControl, relative: str, *, optional: bool = False,
               maximum: int = MAX_CONTROL_BYTES) -> tuple[dict[str, Any] | None, bytes | None]:
    raw = _read_raw(control, relative, optional=optional, maximum=maximum)
    if raw is None:
        return None, None
    import docker_volume_unclaimed_cancellation as cancellation

    return cancellation._json_object(raw, relative, maximum=maximum), raw


def _require_sha(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        _fail(label + " is not a lowercase SHA-256")
    return value


def _require_attempt(value: object, label: str) -> str:
    if not isinstance(value, str) or ATTEMPT_RE.fullmatch(value) is None:
        _fail(label + " is not an operation UUID")
    return value


def _require_container(value: object, label: str) -> str:
    if not isinstance(value, str) or CONTAINER_RE.fullmatch(value) is None:
        _fail(label + " is not a complete Docker container ID")
    return value


def _require_image(value: object, label: str) -> str:
    if not isinstance(value, str) or IMAGE_RE.fullmatch(value) is None:
        _fail(label + " is not an immutable image ID")
    return value


def _request_id(value: object) -> str:
    if not isinstance(value, str) or REQUEST_ID_RE.fullmatch(value) is None:
        _fail("--request-id must be a canonical UUID")
    try:
        parsed = uuid.UUID(value)
    except ValueError as error:
        raise BuildControlError("--request-id must be a canonical UUID") from error
    if parsed.int == 0 or str(parsed) != value:
        _fail("--request-id must be a canonical nonzero UUID")
    return value


def _control_record_absent(control: BuildControl, relative: str) -> None:
    if _read_raw(control, relative, optional=True) is not None:
        _fail("Container recovery record already exists; automatic replay is refused: " + relative)


def _group_ledger(control: BuildControl, attempt: str, engine_sha256: str) -> tuple[dict[str, Any], bytes]:
    record, raw = _read_json(control, f"development/attempts/{attempt}/group-ledger.json")
    if record is None or raw is None:
        _fail("Pinned development attempt has no group-ledger identity")
    if (set(record) != {"schema", "profile", "daemon_id_sha256", "compose_project", "volume_name", "host_id"}
            or record.get("schema") != "fullmag.docker-group-ledger.v1"
            or record.get("profile") != "group-ledger-v1"
            or record.get("daemon_id_sha256") != engine_sha256
            or record.get("compose_project") != control.project
            or not isinstance(record.get("volume_name"), str)
            or not isinstance(record.get("host_id"), str)):
        _fail("Pinned group ledger does not belong to the current Docker daemon and Compose group")
    return record, raw


def _absence_observation(identifier: str) -> dict[str, Any]:
    """Require both exact inspect-not-found and an empty full-ID ps -a query."""
    inspected = docker_capture("inspect", identifier, allow_failure=True, timeout=60)
    if inspected.returncode == 0:
        _fail("Pinned old container remains inspectable: " + identifier)
    inspect_output = bytes(inspected.stderr) + bytes(inspected.stdout)
    detail = inspect_output.decode("utf-8", "replace")
    if re.search(
        r"(?:no such object|no such container):\s*" + re.escape(identifier) + r"(?:\s|$)",
        detail,
        re.IGNORECASE,
    ) is None:
        _fail("Docker did not authoritatively report the exact container ID absent")
    listed = docker_capture(
        "ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + identifier, timeout=60
    )
    if listed.returncode or listed.stdout.decode("utf-8", "replace").split():
        _fail("Docker ps -a still lists the exact pinned container ID")
    return {
        "inspect": {
            "outcome": "no_such_object",
            "matched_container_id": identifier,
            "output_sha256": _sha256(inspect_output),
        },
        "ps_all": {"outcome": "empty", "output_sha256": _sha256(bytes(listed.stdout))},
    }


def _verify_absent_pair(pins: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "container_id": pin["container_id"],
            "image_id": pin["image_id"],
            "config_sha256": pin["config_sha256"],
            "service": pin["service"],
            "absence": _absence_observation(pin["container_id"]),
        }
        for pin in pins
    ]


def _retained_run_pins(state: Path, request: Mapping[str, Any], native_result: Mapping[str, Any]) -> list[dict[str, str]]:
    """Capture bounded raw run-record pins for the native cancellation validator."""
    import docker_volume_dev as volume_dev

    store_root = storage.validate_path(state / RUN_STORE_RELATIVE, state, "retained session store")
    runs_root = storage.validate_path(store_root / "runs", store_root, "retained run inventory")
    if runs_root.is_symlink() or not runs_root.is_dir():
        _fail("Retained run inventory is not a regular directory")
    run_ids: list[str] = []
    for entry in os.scandir(runs_root):
        if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
            _fail("Retained run inventory contains a non-directory or symlink")
        name = entry.name
        if RUN_ID_RE.fullmatch(name) is None or name.endswith("."):
            _fail("Retained run inventory contains an unsafe run ID")
        run_ids.append(name)
        if len(run_ids) > MAX_RETAINED_RUNS:
            _fail("Retained run inventory exceeds the native recovery bound")
    if not run_ids:
        _fail("There are no retained runs to validate after cancellation")

    host = volume_dev._session_host()
    total_bytes = 0
    pins: list[dict[str, str]] = []
    requested_run = request.get("run_id")
    requested_task = request.get("task_id")
    expected_task = request.get("expected_task")
    expected_revision = native_result.get("catalog_revision")
    requested_catalog = None
    for run_id in sorted(run_ids):
        run_root = storage.validate_path(store_root / "runs" / run_id, store_root, "retained run")
        records: dict[str, bytes] = {}
        for filename in ("run_intent.json", "run_catalog.json"):
            path = storage.validate_path(run_root / filename, store_root, "retained run record")
            if path.is_symlink():
                _fail("Retained run record is a symlink")
            raw = host.read_owned_regular(path, maximum=MAX_RUN_FILE_BYTES)
            if len(raw) > MAX_RUN_FILE_BYTES:
                _fail("Retained run record exceeds its per-file bound")
            total_bytes += len(raw)
            if total_bytes > MAX_RETAINED_RUN_BYTES:
                _fail("Retained run records exceed the aggregate byte bound")
            records[filename] = raw
        import docker_volume_unclaimed_cancellation as cancellation

        intent = cancellation._json_object(
            records["run_intent.json"], "retained run intent", maximum=MAX_RUN_FILE_BYTES
        )
        catalog = cancellation._json_object(
            records["run_catalog.json"], "retained run catalog", maximum=MAX_RUN_FILE_BYTES
        )
        if (not isinstance(intent, Mapping) or intent.get("run_id") != run_id
                or not isinstance(catalog, Mapping) or catalog.get("run_id") != run_id
                or isinstance(catalog.get("revision"), bool)
                or not isinstance(catalog.get("revision"), int) or catalog["revision"] <= 0
                or not isinstance(catalog.get("tasks"), list)):
            _fail("Retained run intent/catalog identity or revision is invalid")
        if run_id == requested_run:
            requested_catalog = catalog
            if (catalog.get("revision") != expected_revision
                    or not isinstance(expected_task, Mapping)):
                _fail("Cancellation terminal does not bind the current cancelled catalog revision")
            tasks = [task for task in catalog["tasks"]
                     if isinstance(task, Mapping) and task.get("task_id") == requested_task]
            expected = dict(expected_task)
            expected["lifecycle"] = "cancelled"
            if len(tasks) != 1 or dict(tasks[0]) != expected:
                _fail("Current cancelled task differs from the exact accepted-task snapshot")
        pins.append({
            "run_id": run_id,
            "run_intent_sha256": _sha256(records["run_intent.json"]),
            "run_catalog_sha256": _sha256(records["run_catalog.json"]),
        })
    if requested_catalog is None:
        _fail("Cancellation target run is missing from the retained store")
    return pins


def _validate_operation(control: BuildControl, attempt: str, terminal_raw: bytes,
                        terminal: Mapping[str, Any], expected_terminal_sha: str,
                        selected: Path) -> tuple[dict[str, Any], bytes, bytes, dict[str, Any], bytes,
                                                 dict[str, Any], bytes, dict[str, Any], bytes]:
    import docker_volume_unclaimed_cancellation as cancellation

    if _sha256(terminal_raw) != expected_terminal_sha:
        _fail("Cancellation terminal bytes differ from --cancellation-terminal-sha256")
    if (terminal.get("schema") != "fullmag.docker-build-operation.v1"
            or terminal.get("phase") != "development"
            or terminal.get("state") != "succeeded"
            or terminal.get("attempt") != attempt
            or terminal.get("compose_project") != control.project
            or terminal.get("control_volume") != control.volume
            or terminal.get("helper_container") != "fullmag-control-" + attempt
            or (control.namespace and terminal.get("control_namespace") != control.namespace)
            or (control.namespace and terminal.get("namespace_registry_sha256")
                != control.namespace_registry_sha256)):
        _fail("Selected cancellation attempt is not the exact successful managed terminal")
    inputs = terminal.get("inputs")
    if not isinstance(inputs, Mapping) or inputs.get("source_root") != str(selected):
        _fail("Successful cancellation attempt belongs to another source checkout")
    maintenance = inputs.get("unclaimed_cancellation")
    if (not isinstance(maintenance, Mapping)
            or set(maintenance) != {"request_id", "request_sha256", "request_path"}):
        _fail("Successful attempt has no exact unclaimed-cancellation binding")
    request_id = _request_id(maintenance.get("request_id"))
    request_sha = _require_sha(maintenance.get("request_sha256"), "cancellation request digest")
    if maintenance.get("request_path") != cancellation._request_path(request_id):
        _fail("Successful attempt has an unsupported cancellation request path")

    result = terminal.get("unclaimed_cancellation_result")
    result_fields = {
        "schema", "state", "request_id", "request_sha256", "native_result",
        "maintenance_receipt_sha256", "maintenance_receipt_path", "backend_container_id",
        "backend_finished_at", "admission", "admission_sha256",
    }
    if (not isinstance(result, Mapping) or set(result) != result_fields
            or result.get("schema") != cancellation.OPERATION_SCHEMA
            or result.get("state") != "cancelled"
            or result.get("request_id") != request_id
            or result.get("request_sha256") != request_sha):
        _fail("Cancellation terminal does not contain one completed typed cancelled result")
    native = result.get("native_result")
    if (not isinstance(native, Mapping) or set(native) != {
                "schema_version", "request_id", "disposition", "run_id", "task_id", "catalog_revision"
            }
            or native.get("schema_version") != cancellation.REQUEST_SCHEMA
            or native.get("request_id") != request_id
            or native.get("disposition") != "cancelled"):
        _fail("Cancellation result is not the exact native cancelled disposition")
    if (isinstance(native.get("catalog_revision"), bool)
            or not isinstance(native.get("catalog_revision"), int)
            or native["catalog_revision"] <= 0):
        _fail("Native cancellation result has no positive resulting catalog revision")
    receipt_path = result.get("maintenance_receipt_path")
    if (not isinstance(receipt_path, str)
            or not receipt_path.startswith(cancellation.RECEIPT_ROOT + "/")
            or "/" in receipt_path[len(cancellation.RECEIPT_ROOT) + 1:]):
        _fail("Cancellation result has an invalid immutable receipt path")
    receipt_raw = _read_raw(control, receipt_path, maximum=256 * 1024)
    if receipt_raw is None or _sha256(receipt_raw) != result.get("maintenance_receipt_sha256"):
        _fail("Immutable cancellation receipt is missing or differs from its terminal pin")
    receipt = cancellation._json_object(receipt_raw, "successful cancellation receipt", maximum=256 * 1024)
    admission = result.get("admission")
    if (not isinstance(admission, Mapping) or set(admission) != {
                "schema", "attempt", "request_id", "request_sha256", "backend_container_id",
                "backend_started_at", "backend_build_receipt_sha256",
            }
            or admission.get("schema") != "fullmag.docker-runtime-unclaimed-cancellation-admission.v1"
            or admission.get("attempt") != attempt
            or admission.get("request_id") != request_id
            or admission.get("request_sha256") != request_sha
            or not isinstance(admission.get("backend_started_at"), str)
            or not admission.get("backend_started_at")
            or not isinstance(admission.get("backend_build_receipt_sha256"), str)
            or SHA256_RE.fullmatch(admission["backend_build_receipt_sha256"]) is None
            or terminal.get("unclaimed_cancellation_admission") != dict(admission)
            or terminal.get("backend_build_receipt_sha256") != admission.get("backend_build_receipt_sha256")
            or result.get("admission_sha256") != _sha256(canonical(admission) + b"\n")):
        _fail("Cancellation admission is not bound to this terminal and package")
    admission_raw = _read_raw(
        control,
        "backend/runtime-service/unclaimed-cancellation/admissions/" + attempt + ".json",
        maximum=256 * 1024,
    )
    if admission_raw is None or _sha256(admission_raw) != result.get("admission_sha256"):
        _fail("Immutable cancellation admission bytes differ from the terminal")
    saved_admission = cancellation._json_object(admission_raw, "successful cancellation admission", maximum=256 * 1024)
    if saved_admission != dict(admission):
        _fail("Saved cancellation admission differs from its typed terminal result")
    if (set(receipt) != {
                "schema", "request_id", "request_sha256", "state", "native_result",
                "native_stdout_sha256", "attempt", "admission_sha256",
            }
            or receipt.get("schema") != cancellation.MAINTENANCE_RECEIPT_SCHEMA
            or receipt.get("request_id") != request_id
            or receipt.get("request_sha256") != request_sha
            or receipt.get("state") != "cancelled"
            or receipt.get("native_result") != dict(native)
            or receipt.get("attempt") != attempt
            or receipt.get("admission_sha256") != result.get("admission_sha256")
            or not isinstance(receipt.get("native_stdout_sha256"), str)
            or SHA256_RE.fullmatch(receipt["native_stdout_sha256"]) is None):
        _fail("Immutable cancellation receipt does not bind the successful native result")
    result_hash = _sha256(canonical(native) + b"\n")
    if Path(receipt_path).name != f"{attempt}-{request_id}-{request_sha}-{result_hash}.json":
        _fail("Cancellation receipt filename does not bind the exact typed result")

    compose, compose_raw = _read_json(control, f"development/attempts/{attempt}/compose.json")
    if compose is None or compose_raw is None:
        _fail("Successful cancellation attempt has no retained Compose document")
    if (compose.get("name") != control.project
            or set(compose.get("services", {})) != {"backend", "frontend"}
            or terminal.get("config_sha256") != _sha256(canonical(compose))):
        _fail("Cancellation Compose document differs from the successful terminal pin")
    env = compose.get("services", {}).get("backend", {}).get("environment", {})
    if (env.get("FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_REQUEST") != maintenance["request_path"]
            or env.get("FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_REQUEST_SHA256") != request_sha
            or env.get("FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_ATTEMPT") != attempt
            or env.get("FULLMAG_STARTUP_ENABLED", "0") == "1"
            or env.get("FULLMAG_ACCEPTED_REATTACH_REQUEST") is not None):
        _fail("Retained Compose document does not prove cancellation-only startup")
    request_raw = _read_raw(control, cancellation.REQUEST_ROOT + "/" + request_id + ".json",
                            maximum=cancellation.MAX_REQUEST_BYTES)
    if request_raw is None or _sha256(request_raw) != request_sha:
        _fail("Original immutable cancellation request is missing or changed")
    request = cancellation._json_object(request_raw, "original cancellation request",
                                        maximum=cancellation.MAX_REQUEST_BYTES)
    if (request.get("schema_version") != cancellation.REQUEST_SCHEMA
            or request.get("request_id") != request_id
            or request.get("run_id") != native.get("run_id")
            or request.get("task_id") != native.get("task_id")):
        _fail("Cancellation request differs from the typed terminal result")
    preflight, preflight_raw = _read_json(
        control, f"development/attempts/{attempt}/unclaimed-cancellation-before.json",
        maximum=256 * 1024,
    )
    if (preflight is None or preflight_raw is None
            or preflight.get("schema") != "fullmag.docker-volume-unclaimed-cancellation-before.v1"
            or canonical(preflight) + b"\n" != preflight_raw
            or terminal.get("unclaimed_cancellation_preflight") != preflight
            or preflight.get("request_id") != request_id
            or preflight.get("request_sha256") != request_sha
            or preflight.get("prior_runtime_config_sha256") != request.get("config_sha256")
            or preflight.get("prior_owner_sha256") != request.get("owner_sha256")):
        _fail("Cancellation attempt does not retain its exact original preflight")
    if (native.get("run_id") != request.get("run_id")
            or native.get("task_id") != request.get("task_id")):
        _fail("Cancellation result does not target the request-pinned task")
    return (dict(result), receipt_raw, admission_raw, dict(request), request_raw,
            dict(preflight), preflight_raw, dict(compose), compose_raw)


def _read_original_attempt(control: BuildControl, selected: Path, preflight: Mapping[str, Any]):
    import docker_volume_unclaimed_cancellation as cancellation

    attempt = _require_attempt(preflight.get("prior_attempt"), "original development attempt")
    terminal_raw = _read_raw(control, f"development/attempts/{attempt}/terminal.json")
    compose_raw = _read_raw(control, f"development/attempts/{attempt}/compose.json")
    if terminal_raw is None or compose_raw is None:
        _fail("Original development terminal or Compose archive is missing")
    terminal = cancellation._json_object(terminal_raw, "original development terminal")
    compose = cancellation._json_object(compose_raw, "original development Compose document")
    inputs = terminal.get("inputs")
    if (terminal.get("schema") != "fullmag.docker-build-operation.v1"
            or terminal.get("phase") != "development"
            or terminal.get("state") not in {"succeeded", "failed-confirmed"}
            or terminal.get("attempt") != attempt
            or terminal.get("compose_project") != control.project
            or not isinstance(inputs, Mapping)
            or inputs.get("source_root") != str(selected)
            or inputs.get("image_id") is None
            or preflight.get("prior_terminal_sha256") != _sha256(terminal_raw)
            or preflight.get("prior_compose_sha256") != _sha256(canonical(compose))
            or compose.get("name") != control.project
            or set(compose.get("services", {})) != {"backend", "frontend"}):
        _fail("Original development terminal/Compose pins differ from the cancellation preflight")
    original_image = _require_image(inputs.get("image_id"), "original development image")
    if terminal.get("backend_container") != preflight.get("backend", {}).get("container_id"):
        _fail("Original backend ID differs from its cancellation preflight")
    if terminal.get("frontend_container") != preflight.get("frontend", {}).get("container_id"):
        _fail("Original frontend ID differs from its cancellation preflight")
    pins = __import__("docker_volume_container_recovery")._validate_container_pins(
        preflight.get("container_pins")
    )
    by_service = {pin["service"]: pin for pin in pins}
    if set(by_service) != {"backend", "frontend"}:
        _fail("Original cancellation preflight does not pin the exact backend/frontend pair")
    for service in ("backend", "frontend"):
        pin = by_service[service]
        summary = preflight.get(service)
        if (pin.get("container_id") != terminal.get(service + "_container")
                or pin.get("image_id") != original_image
                or pin.get("compose_project") != control.project
                or not isinstance(summary, Mapping)
                or summary.get("container_id") != pin.get("container_id")
                or summary.get("image_id") != original_image
                or summary.get("config_sha256") != pin.get("config_sha256")):
            _fail("Original service pin differs from its terminal/preflight evidence: " + service)
    return terminal, terminal_raw, compose, compose_raw, original_image, pins


def _prior_runtime_evidence(control: BuildControl, cancellation_attempt: str,
                            preflight: Mapping[str, Any], preflight_raw: bytes,
                            request: Mapping[str, Any]):
    import docker_volume_unclaimed_cancellation as cancellation
    import docker_volume_container_recovery as recovery

    names = {
        "config": "prior-runtime-config.json",
        "owner": "prior-runtime-owner.json",
        "process": "prior-process-tree.json",
    }
    archived: dict[str, bytes] = {}
    for name in names.values():
        raw = _read_raw(control, f"development/attempts/{cancellation_attempt}/{name}")
        if raw is None:
            _fail("Successful cancellation attempt lacks its original runtime archive: " + name)
        archived[name] = raw
    config, config_raw, config_sha = recovery._runtime_config(control)
    owner, owner_raw, owner_sha = recovery._runtime_owner(control)
    launch, launch_raw, launch_sha = recovery._runtime_launch(control)
    process_raw = _read_raw(control, RUNTIME_ROOT + "/runtime-service/process-tree.json")
    if process_raw is None:
        _fail("runtime-service process receipt is missing from the control volume")
    process = cancellation._json_object(process_raw, "runtime-service process receipt")
    if (process.get("schema") != "fullmag.docker-process-tree.v1"
            or process.get("state") != "shutdown_unknown"):
        _fail("container recovery requires the exact shutdown_unknown process receipt")
    recovery._validate_process_receipt_owner(process, owner)
    process_sha = _sha256(process_raw)
    if (archived[names["config"]] != config_raw
            or archived[names["owner"]] != owner_raw
            or archived[names["process"]] != process_raw):
        _fail("Current native config/owner/process bytes differ from the original cancellation archive")
    if (config_sha != preflight.get("prior_runtime_config_sha256")
            or owner_sha != preflight.get("prior_owner_sha256")
            or process_sha != preflight.get("prior_process_receipt_sha256")
            or config_sha != request.get("config_sha256")
            or owner_sha != request.get("owner_sha256")
            or owner != request.get("expected_owner")
            or owner.get("state") != "unknown"
            or process.get("state") != "shutdown_unknown"
            or process.get("service_owner") != owner):
        _fail("Current native owner/config/process evidence differs from the Unknown cancellation pins")
    if config.get("store_root") != "/state/runs/docker-all/session-store":
        _fail("Runtime configuration does not bind the retained accepted session store")
    return {
        "config": config, "config_raw": config_raw, "config_sha256": config_sha,
        "owner": owner, "owner_raw": owner_raw, "owner_sha256": owner_sha,
        "launch": launch, "launch_raw": launch_raw, "launch_sha256": launch_sha,
        "process": process, "process_raw": process_raw, "process_sha256": process_sha,
        "preflight_sha256": _sha256(preflight_raw),
    }


def _current_pair(control: BuildControl, identity: Mapping[str, Any], terminal: Mapping[str, Any],
                  compose: Mapping[str, Any], result: Mapping[str, Any], admission: Mapping[str, Any]):
    import docker_volume_dev as volume_dev
    from docker_compose_identity import validate_source_labels

    backend_id = _require_container(terminal.get("backend_container"), "successful maintenance backend")
    frontend_id = _require_container(terminal.get("frontend_container"), "successful maintenance frontend")
    if (backend_id == frontend_id or result.get("backend_container_id") != backend_id
            or admission.get("backend_container_id") != backend_id):
        _fail("Successful cancellation terminal does not pin two distinct current services")
    try:
        rows = json.loads(docker_capture("inspect", backend_id, frontend_id, timeout=90).stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Current cancellation service inspect is invalid") from error
    if not isinstance(rows, list) or len(rows) != 2:
        _fail("Current cancellation service pair is not present")
    by_id = {row.get("Id"): row for row in rows if isinstance(row, Mapping)}
    if set(by_id) != {backend_id, frontend_id}:
        _fail("Current cancellation service IDs differ from the successful terminal")
    image = _require_image(terminal.get("inputs", {}).get("image_id"), "cancellation backend image")
    image_rows = json.loads(docker_capture("image", "inspect", image, timeout=60).stdout)
    if len(image_rows) != 1 or image_rows[0].get("Id") != image:
        _fail("Successful cancellation image is no longer inspectable by immutable ID")
    image_config = image_rows[0].get("Config")
    if not isinstance(image_config, Mapping):
        _fail("Successful cancellation image has no image configuration")
    actual = {"backend": by_id[backend_id], "frontend": by_id[frontend_id]}
    for service, row in actual.items():
        labels = row.get("Config", {}).get("Labels", {})
        if (row.get("Image") != image
                or labels.get("com.docker.compose.project") != control.project
                or labels.get("com.docker.compose.service") != service):
            _fail("Current service belongs to another image or Compose identity: " + service)
        validate_source_labels(row, control.identity)
        volume_dev._validate_retained_service(
            compose, row, service, image_config,
            expected_started_at=(admission["backend_started_at"] if service == "backend" else None),
        )
    backend_state = actual["backend"].get("State", {})
    frontend_state = actual["frontend"].get("State", {})
    if (backend_state.get("Running") is not False or type(backend_state.get("Pid")) is not int
            or backend_state.get("Pid") != 0
            or type(backend_state.get("ExitCode")) is not int or backend_state["ExitCode"] != 0
            or backend_state.get("OOMKilled") is not False
            or not isinstance(backend_state.get("FinishedAt"), str) or not backend_state["FinishedAt"]
            or backend_state.get("FinishedAt") != result.get("backend_finished_at")
            or frontend_state.get("Running") is not True):
        _fail("Current maintenance backend/frontend are not at the expected completed/serving boundary")
    volume_dev._assert_private_restart_network(actual, {"backend": backend_id, "frontend": frontend_id}, control.project)
    return actual, image, image_config


def _assert_consumers(control: BuildControl, expected: set[str]) -> None:
    import docker_volume_unclaimed_cancellation as cancellation

    if (cancellation._project_container_ids(control.project) != expected
            or cancellation._volume_consumer_ids(control.volume) != expected):
        _fail("Compose project or control volume has consumers beyond the exact pinned set")


def _read_retained_certificate(layout: Mapping[str, Any], cancellation_terminal: Mapping[str, Any],
                               cancellation_compose: Mapping[str, Any]):
    import docker_volume_dev as volume_dev

    state_path = storage.validate_path(
        Path(cancellation_terminal.get("state_root", "")),
        Path(layout["runtime_root"]),
        "retained cancelled runtime state",
    )
    certificate = volume_dev._retained_certificate(state_path, cancellation_compose)
    image = cancellation_terminal.get("inputs", {}).get("image_id")
    if (not isinstance(image, str) or IMAGE_RE.fullmatch(image) is None
            or certificate.get("image_id") != image):
        _fail("Retained session certificate differs from the successful cancellation image")
    return state_path, certificate


def _run_pins_from_preflight(preflight: Mapping[str, Any], original_attempt: str,
                             original_terminal_raw: bytes, original_compose_raw: bytes):
    original_compose = _json_bytes(original_compose_raw, "original development Compose document", MAX_CONTROL_BYTES)
    if (preflight.get("prior_attempt") != original_attempt
            or preflight.get("prior_terminal_sha256") != _sha256(original_terminal_raw)
            or preflight.get("prior_compose_sha256") != _sha256(canonical(original_compose))):
        _fail("Original terminal/Compose provenance does not match the cancellation preflight")


def _archive_logs(control: BuildControl, operation: Mapping[str, Any], actual: Mapping[str, Any]):
    import docker_volume_unclaimed_cancellation as cancellation

    result = {}
    summaries = {}
    for service in ("backend", "frontend"):
        row = actual[service]
        logs = bounded_capture(
            docker_argv("logs", "--tail", "500", row["Id"]),
            timeout=60,
            maximum=MAX_LOG_BYTES,
        )
        if logs.returncode:
            _fail("Cannot preserve bounded Docker log tail for the current " + service)
        raw = bytes(logs.stdout) + bytes(logs.stderr)
        if len(raw) > MAX_LOG_BYTES:
            _fail("Current " + service + " Docker log tail exceeds its preservation bound")
        control.write_bytes(operation["root"] + "/cancelled-current-" + service + "-docker-logs.txt", raw)
        summaries[service] = cancellation._safe_inspect_summary(row)
        result[service] = _sha256(raw)
    control.write(operation["root"] + "/cancelled-current-inspect.json", {
        "schema": "fullmag.docker-cancelled-current-service-inspect.v1",
        "services": summaries,
        "docker_log_sha256": result,
    })
    return summaries, result


def _json_bytes(raw: bytes, label: str, maximum: int) -> dict[str, Any]:
    import docker_volume_unclaimed_cancellation as cancellation

    return cancellation._json_object(raw, label, maximum=maximum)


def _saved_resource_budget(control: BuildControl,
                           cancellation_compose: Mapping[str, Any]) -> dict[str, Any]:
    """Bind the saved increase to its own immutable parent attempt and rendered profile."""
    import copy
    import docker_volume_resources as resources

    raw = _read_raw(control, "backend/resource-budget.json", maximum=64 * 1024)
    if raw is None:
        _fail("Retained backend has no explicit saved resource budget")
    profile = _json_bytes(raw, "saved backend resource budget", 64 * 1024)
    relative = profile.get("receipt_path")
    if (profile.get("schema") != resources.SCHEMA
            or profile.get("state") != "succeeded"
            or profile.get("compose_project") != control.project
            or profile.get("control_namespace") != control.namespace
            or not isinstance(relative, str)
            or re.fullmatch(
                r"development/attempts/[0-9a-f]{32}/resource-increases/[0-9a-f]{32}/receipt\.json",
                relative,
            ) is None):
        _fail("Saved backend resource-budget profile is not namespace-pinned")
    receipt_raw = _read_raw(control, relative, maximum=64 * 1024)
    if receipt_raw is None or _sha256(receipt_raw) != profile.get("receipt_sha256"):
        _fail("Saved backend resource-budget receipt is missing or changed")
    receipt = _json_bytes(receipt_raw, "saved backend resource-budget receipt", 64 * 1024)
    parent_attempt = _require_attempt(receipt.get("parent_attempt"), "resource-budget parent attempt")
    if (parent_attempt != relative.split("/")[2]
            or receipt.get("adjustment_id") != relative.split("/")[4]):
        _fail("Saved backend resource-budget receipt path differs from its parent identity")
    parent_terminal_raw = _read_raw(
        control, f"development/attempts/{parent_attempt}/terminal.json"
    )
    parent_compose_raw = _read_raw(
        control, f"development/attempts/{parent_attempt}/compose.json"
    )
    if parent_terminal_raw is None or parent_compose_raw is None:
        _fail("Saved resource-budget parent attempt has no immutable terminal/Compose evidence")
    parent_terminal = _json_bytes(parent_terminal_raw, "resource-budget parent terminal", MAX_CONTROL_BYTES)
    parent_compose = _json_bytes(parent_compose_raw, "resource-budget parent Compose", MAX_CONTROL_BYTES)
    parent_inputs = parent_terminal.get("inputs")
    if (parent_terminal.get("schema") != "fullmag.docker-build-operation.v1"
            or parent_terminal.get("phase") != "development"
            or parent_terminal.get("state") not in {"succeeded", "failed-confirmed"}
            or parent_terminal.get("attempt") != parent_attempt
            or parent_terminal.get("compose_project") != control.project
            or parent_terminal.get("control_volume") != control.volume
            or (control.namespace and parent_terminal.get("control_namespace") != control.namespace)
            or not isinstance(parent_inputs, Mapping)
            or parent_terminal.get("backend_container") != receipt.get("backend_container_id")
            or parent_terminal.get("backend_started_at") != receipt.get("started_at")
            or parent_inputs.get("image_id") != receipt.get("image_id")
            or parent_compose.get("name") != control.project
            or set(parent_compose.get("services", {})) != {"backend", "frontend"}
            or parent_terminal.get("config_sha256") != _sha256(canonical(parent_compose))):
        _fail("Saved resource-budget receipt does not match its own parent attempt")
    _require_container(receipt.get("backend_container_id"), "resource-budget backend")
    _require_image(receipt.get("image_id"), "resource-budget image")
    budget = profile.get("budget")
    if (not isinstance(budget, Mapping)
            or set(budget) != {"memory_bytes", "cpus", "memory_swap_bytes"}
            or any(type(budget.get(key)) is not int for key in budget)
            or budget.get("memory_bytes") != 128 * 1024 ** 3
            or budget.get("cpus") != 16
            or (budget.get("memory_swap_bytes") != -1
                and budget["memory_swap_bytes"] < budget["memory_bytes"])
            or receipt.get("schema") != resources.SCHEMA
            or receipt.get("state") != "succeeded"
            or receipt.get("compose_project") != control.project
            or receipt.get("control_namespace") != control.namespace
            or receipt.get("budget") != dict(budget)):
        _fail("Saved 128 GiB/16 CPU resource receipt does not bind its pinned increase")

    def as_bytes(value: object) -> int:
        try:
            return int(str(value).removesuffix("b"))
        except (TypeError, ValueError) as error:
            raise BuildControlError("Retained Compose memory budget is malformed") from error

    prior_service = parent_compose.get("services", {}).get("backend", {})
    before = receipt.get("before")
    if (not isinstance(before, Mapping)
            or before.get("memory_bytes") != as_bytes(prior_service.get("mem_limit", "0"))
            or before.get("nano_cpus") != float(prior_service.get("cpus", 0)) * 10**9
            or ("memswap_limit" in prior_service
                and before.get("memory_swap_bytes") != as_bytes(prior_service["memswap_limit"]))):
        _fail("Original Compose limits differ from the saved resource increase receipt")

    rendered = copy.deepcopy(dict(cancellation_compose))
    resources.apply_saved_budget(control, rendered)
    expected = rendered.get("services", {}).get("backend", {})
    actual = cancellation_compose.get("services", {}).get("backend", {})
    expected_environment = expected.get("environment", {})
    actual_environment = actual.get("environment", {})
    if (as_bytes(actual.get("mem_limit", "0")) != budget["memory_bytes"]
            or float(actual.get("cpus", 0)) != budget["cpus"]
            or as_bytes(actual.get("memswap_limit", "0")) != budget["memory_swap_bytes"]
            or any(actual_environment.get(key) != expected_environment.get(key)
                   for key in ("CARGO_BUILD_JOBS", "FULLMAG_DOCKER_CPU_MILLIS",
                               "FULLMAG_DOCKER_MEMORY_BYTES"))
            or expected_environment.get("CARGO_BUILD_JOBS") != str(min(budget["cpus"], 64))):
        _fail("Successful cancellation Compose does not retain the saved 128 GiB/16 CPU build budget")
    return {
        "profile": profile,
        "profile_sha256": _sha256(raw),
        "receipt": receipt,
        "receipt_sha256": _sha256(receipt_raw),
        "parent_attempt": parent_attempt,
        "parent_terminal_sha256": _sha256(parent_terminal_raw),
        "parent_compose_sha256": _sha256(parent_compose_raw),
        "budget": dict(budget),
    }


def _validate_live_budget(row: Mapping[str, Any], budget: Mapping[str, Any]) -> None:
    host = row.get("HostConfig", {})
    if (host.get("Memory") != budget["memory_bytes"]
            or host.get("NanoCpus") != budget["cpus"] * 10**9
            or host.get("MemorySwap") != budget["memory_swap_bytes"]):
        _fail("Successful cancellation backend does not run with the saved resource limits")


def recover_cancelled(args) -> dict[str, Any]:
    """Run one managed recovery after a successful unclaimed-task cancellation."""
    from docker_dev import (
        _compose_identity, _resolve_gpu_access, _select_source, _verify_docker_gpu_access,
    )
    import docker_volume_container_recovery as recovery
    import docker_volume_dev as volume_dev
    import docker_volume_unclaimed_cancellation as cancellation
    import docker_group_ledger as group_ledger

    require_host()
    attempt = _require_attempt(getattr(args, "attempt", None), "--attempt")
    request_id = _request_id(getattr(args, "request_id", None))
    terminal_sha = _require_sha(
        getattr(args, "cancellation_terminal_sha256", None), "--cancellation-terminal-sha256"
    )
    if isinstance(getattr(args, "port", None), bool) or not isinstance(args.port, int) or not 1 <= args.port <= 65535:
        _fail("--port must be an explicit frontend port in 1..65535")
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    try:
        helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    except (KeyError, TypeError) as error:
        raise BuildControlError("Selected Compose group has no pinned managed build-control image") from error
    control = BuildControl(identity, helper_image)
    volume = docker_capture("volume", "inspect", control.volume, allow_failure=True, timeout=60)
    if volume.returncode:
        _fail("Selected Compose group has no existing control volume; cancelled recovery cannot create a namespace")
    control.prepare()

    cancel_root = f"development/attempts/{attempt}"
    cancellation_terminal, cancellation_terminal_raw = _read_json(control, cancel_root + "/terminal.json")
    if cancellation_terminal is None or cancellation_terminal_raw is None:
        _fail("Successful cancellation terminal is missing")
    (result, cancellation_receipt_raw, cancellation_admission_raw, request, request_raw, preflight, preflight_raw,
     cancellation_compose, cancellation_compose_raw) = _validate_operation(
        control, attempt, cancellation_terminal_raw, cancellation_terminal, terminal_sha, selected
    )
    if result.get("request_id") != request_id:
        _fail("Successful cancellation terminal belongs to another --request-id")
    native_result = result["native_result"]
    cancellation_inputs = cancellation_terminal["inputs"]
    previous, previous_raw, previous_compose, previous_compose_raw, original_image, old_pins = _read_original_attempt(
        control, selected, preflight
    )
    _run_pins_from_preflight(preflight, previous["attempt"], previous_raw, previous_compose_raw)
    if (previous.get("inputs", {}).get("source_root") != str(selected)
            or cancellation_inputs.get("source_root") != str(selected)
            or cancellation_terminal.get("state_root") != previous.get("state_root")):
        _fail("Original and cancelled runtime attempts do not share one registered source/state root")
    frontend_ports = previous_compose.get("services", {}).get("frontend", {}).get("ports")
    if (not isinstance(frontend_ports, list) or len(frontend_ports) != 1
            or not isinstance(frontend_ports[0], Mapping)
            or frontend_ports[0].get("host_ip") != "127.0.0.1"
            or frontend_ports[0].get("target") != 8080
            or frontend_ports[0].get("protocol") != "tcp"
            or frontend_ports[0].get("published") != str(args.port)):
        _fail("Explicit frontend port differs from the original Compose configuration")
    current_ports = cancellation_compose.get("services", {}).get("frontend", {}).get("ports")
    if current_ports != frontend_ports:
        _fail("Successful cancellation Compose changed the retained frontend port")

    # The cancellation path archived only the three original runtime files;
    # LAUNCH remains a separate live pin and is included in the new manifest.
    native = _prior_runtime_evidence(control, attempt, preflight, preflight_raw, request)
    state, certificate = _read_retained_certificate(layout, cancellation_terminal, cancellation_compose)
    if state != storage.validate_path(Path(previous["state_root"]), Path(layout["runtime_root"]), "original runtime state"):
        _fail("Cancellation changed the retained storage root")
    engine_sha = recovery._docker_engine_sha()
    original_ledger, original_ledger_raw = _group_ledger(control, previous["attempt"], engine_sha)
    current_ledger, current_ledger_raw = _group_ledger(control, attempt, engine_sha)
    if original_ledger != current_ledger:
        _fail("Original and cancellation attempts do not retain one daemon-owned group ledger")

    pins_by_service = {pin["service"]: pin for pin in old_pins}
    old_ordered_pins = [pins_by_service["backend"], pins_by_service["frontend"]]
    if old_ordered_pins[0]["image_id"] != old_ordered_pins[1]["image_id"]:
        _fail("Native recovery authorization requires one original application image for both services")
    for pin in old_ordered_pins:
        _absence_observation(pin["container_id"])

    cancellation_pair, cancellation_image, cancellation_image_config = _current_pair(
        control, identity, cancellation_terminal, cancellation_compose, result, result["admission"]
    )
    current_ids = {service: cancellation_pair[service]["Id"] for service in ("backend", "frontend")}
    if set(current_ids.values()) & {pin["container_id"] for pin in old_ordered_pins}:
        _fail("Original namespace IDs overlap the current cancellation maintenance pair")

    native_request_root = f"{RECOVERY_ROOT}/{request_id}"
    for name in ("operator-authorization.json", "manifest.json", "request.json", "attestation.json", "authorization.json"):
        _control_record_absent(control, native_request_root + "/" + name)
    import docker_volume_unclaimed_cancellation as cancellation_module
    if (cancellation_module._project_container_ids(control.project) != set(current_ids.values())
            or cancellation_module._volume_consumer_ids(control.volume) != set(current_ids.values())):
        _fail("Compose group or control volume has consumers beyond the successful cancellation pair")

    previous_inputs = previous.get("inputs")
    policy = previous_inputs.get("gpu_access_requested") if isinstance(previous_inputs, Mapping) else None
    old_access = previous_compose.get("services", {}).get("backend", {}).get("environment", {}).get(
        "FULLMAG_DOCKER_DEVICE_ACCESS"
    )
    current_access = cancellation_compose.get("services", {}).get("backend", {}).get("environment", {}).get(
        "FULLMAG_DOCKER_DEVICE_ACCESS"
    )
    if (policy not in {"auto", "required", "disabled"}
            or old_access not in {"cpu", "gpu"}
            or current_access != old_access
            or cancellation_inputs.get("gpu_access_requested") != policy
            or cancellation_inputs.get("device_access") != old_access):
        _fail("Original and cancellation attempts have different CPU/GPU admission pins")
    device_release, device_mapping = recovery._device_release_from_config(
        native["config"], device_access=old_access
    )

    budget = _saved_resource_budget(control, cancellation_compose)
    _validate_live_budget(cancellation_pair["backend"], budget["budget"])
    operator_probe = volume_dev._operator_probe_record_from_retained(
        cancellation_inputs, cancellation_compose
    )
    toolchain = build_volume_toolchain(selected)
    if toolchain.get("inputs", {}).get("build_args", {}).get("FULLMAG_CUDA_BASE_IMAGE") != helper_image:
        _fail("Managed toolchain helper differs from the control image selected for this group")
    images_control = BuildControl(identity, helper_image)
    images = build_volume_runtime_images(selected, images_control, toolchain)
    prepared = recovery._prepared_context(toolchain, images)
    new_image = prepared["images"]["backend"]["image_id"]
    device_access = _verify_docker_gpu_access(_resolve_gpu_access(policy), policy, new_image, control.project)
    if device_access != old_access:
        _fail("Current Docker CPU/GPU availability differs from the retained group admission")

    run_pins = _retained_run_pins(state, request, native_result)
    retained_storage = recovery._ledger_and_store_snapshot(
        control,
        cancellation_pair["backend"],
        compose=cancellation_compose,
        retained_cancelled_runs=run_pins,
    )
    if retained_storage.get("run_records") != run_pins:
        _fail("Isolated accepted-store snapshot differs from the current retained-run pins")

    operation_inputs = {
        "source_root": str(selected),
        "image_id": new_image,
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "source_checkout_kind": identity["checkout_kind"],
        "gpu_access_requested": policy,
        "device_access": device_access,
        "gpu_preflight": "PASS" if device_access == "gpu" else "NOT_REQUIRED",
        **operator_probe,
        "cancelled_namespace_recovery": {
            "schema": OPERATION_SCHEMA,
            "request_id": request_id,
            "cancellation_attempt": attempt,
            "cancellation_terminal_sha256": terminal_sha,
            "cancellation_request_sha256": result["request_sha256"],
            "original_attempt": previous["attempt"],
            "preflight_sha256": _sha256(preflight_raw),
            "retained_run_count": len(run_pins),
            "resource_budget_profile_sha256": budget["profile_sha256"],
            "resource_budget_receipt_sha256": budget["receipt_sha256"],
        },
    }
    args.profile = "dev"
    args.image = None
    args.toolchain_image = None
    args.source_manifest = None
    args.script = None
    args.gpu_access = policy
    args.migrate_host_capacity = False
    args.fresh_state = False
    args.port_explicit = True
    retained_allowlist = set(volume_dev.include_untracked_from_compose(cancellation_compose))
    explicit_allowlist = set(volume_dev.normalize_include_untracked_paths(
        getattr(args, "include_untracked", None)
    ))
    args.include_untracked = volume_dev.normalize_include_untracked_paths(
        sorted(retained_allowlist | explicit_allowlist)
    )

    with control.operation("development", operation_inputs) as operation:
        operation["receipt"]["ledger_profile"] = group_ledger.PROFILE
        helper_id = cancellation._operation_helper_id(control, operation)
        current_ids_set = set(current_ids.values())
        _assert_consumers(control, current_ids_set | {helper_id})

        # Re-read every durable source pin after acquiring the operation lease.
        current_terminal_raw = _read_raw(control, cancel_root + "/terminal.json")
        current_original_raw = _read_raw(control, f"development/attempts/{previous['attempt']}/terminal.json")
        current_original_compose_raw = _read_raw(control, f"development/attempts/{previous['attempt']}/compose.json")
        current_config_raw = _read_raw(control, RUNTIME_ROOT + "/runtime-service/docker-all.json", maximum=256 * 1024)
        current_owner_raw = _read_raw(control, RUNTIME_ROOT + "/runtime-services/OWNER.json", maximum=256 * 1024)
        current_process_raw = _read_raw(control, RUNTIME_ROOT + "/runtime-service/process-tree.json")
        current_launch_raw = _read_raw(control, RUNTIME_ROOT + "/runtime-services/LAUNCH.json", maximum=256 * 1024)
        current_request_raw = _read_raw(control, cancellation.REQUEST_ROOT + "/" + request_id + ".json",
                                        maximum=cancellation.MAX_REQUEST_BYTES)
        current_cancellation_receipt_raw = _read_raw(
            control, result["maintenance_receipt_path"], maximum=256 * 1024
        )
        current_cancellation_admission_raw = _read_raw(
            control,
            "backend/runtime-service/unclaimed-cancellation/admissions/" + attempt + ".json",
            maximum=256 * 1024,
        )
        current_cancellation_compose_raw = _read_raw(control, cancel_root + "/compose.json")
        current_preflight_raw = _read_raw(control, cancel_root + "/unclaimed-cancellation-before.json",
                                          maximum=256 * 1024)
        if (current_terminal_raw != cancellation_terminal_raw
                or current_original_raw != previous_raw
                or current_original_compose_raw != previous_compose_raw
                or current_config_raw != native["config_raw"]
                or current_owner_raw != native["owner_raw"]
                or current_process_raw != native["process_raw"]
                or current_launch_raw != native["launch_raw"]
                or current_request_raw != request_raw
                or current_cancellation_receipt_raw != cancellation_receipt_raw
                or current_cancellation_admission_raw != cancellation_admission_raw
                or current_cancellation_compose_raw != cancellation_compose_raw
                or current_preflight_raw != preflight_raw):
            _fail("Cancellation terminal, original source, native pins, or request changed under the lease")
        leased_budget = _saved_resource_budget(control, cancellation_compose)
        if (leased_budget["profile_sha256"] != budget["profile_sha256"]
                or leased_budget["receipt_sha256"] != budget["receipt_sha256"]
                or leased_budget["parent_terminal_sha256"] != budget["parent_terminal_sha256"]
                or leased_budget["parent_compose_sha256"] != budget["parent_compose_sha256"]):
            _fail("Saved 128 GiB/16 CPU resource budget changed under the lifecycle lease")
        _assert_consumers(control, current_ids_set | {helper_id})

        leased_pair, leased_image, leased_image_config = _current_pair(
            control, identity, cancellation_terminal, cancellation_compose, result, result["admission"]
        )
        if leased_image != cancellation_image:
            _fail("Successful cancellation service image changed under the lifecycle lease")
        for service in ("backend", "frontend"):
            if cancellation._safe_inspect_summary(leased_pair[service]) != cancellation._safe_inspect_summary(
                cancellation_pair[service]
            ):
                _fail("Successful cancellation service inspect changed under the lifecycle lease: " + service)
        _validate_live_budget(leased_pair["backend"], budget["budget"])
        leased_old_absence = _verify_absent_pair(old_ordered_pins)
        leased_run_pins = _retained_run_pins(state, request, native_result)
        if leased_run_pins != run_pins:
            _fail("Retained run catalog pins changed under the lifecycle lease")
        leased_storage = recovery._ledger_and_store_snapshot(
            control, leased_pair["backend"], compose=cancellation_compose,
            retained_cancelled_runs=leased_run_pins,
        )
        if leased_storage != retained_storage:
            _fail("Accepted store or released ledger snapshot changed under the lifecycle lease")
        if _read_raw(control, f"development/attempts/{previous['attempt']}/group-ledger.json") != original_ledger_raw:
            _fail("Original group-ledger identity changed under the lifecycle lease")
        if _read_raw(control, f"development/attempts/{attempt}/group-ledger.json") != current_ledger_raw:
            _fail("Cancellation group-ledger identity changed under the lifecycle lease")
        # Network names are carried by the original preflight inspect summaries.
        old_summary_networks = preflight["backend"].get("networks", {})
        frontend_summary_networks = preflight["frontend"].get("networks", {})
        if (not isinstance(old_summary_networks, Mapping) or len(old_summary_networks) != 1
                or not isinstance(frontend_summary_networks, Mapping)
                or set(old_summary_networks) != set(frontend_summary_networks)
                or next(iter(old_summary_networks)) != identity.get("network_name")):
            _fail("Original namespace preflight does not bind one selected private network")
        old_network_name = next(iter(old_summary_networks))
        current_network_name = recovery._network_name(leased_pair["backend"], "backend")
        if current_network_name != old_network_name:
            _fail("Successful cancellation pair moved to another group network")

        inspect_summaries, docker_log_sha = _archive_logs(control, operation, leased_pair)
        for name in ("operator-authorization.json", "manifest.json", "request.json",
                     "attestation.json", "authorization.json"):
            _control_record_absent(control, native_request_root + "/" + name)
        host_prepared = {
            "schema": "fullmag.docker-cancelled-namespace-recovery-host-transition.v1",
            "state": "prepared-before-current-pair-removal",
            "request_id": request_id,
            "cancellation_attempt": attempt,
            "cancellation_terminal_sha256": terminal_sha,
            "cancellation_receipt_sha256": result["maintenance_receipt_sha256"],
            "cancellation_admission_sha256": result["admission_sha256"],
            "original_attempt": previous["attempt"],
            "original_terminal_sha256": _sha256(previous_raw),
            "original_compose_sha256": _sha256(canonical(previous_compose)),
            "preflight_sha256": _sha256(preflight_raw),
            "original_container_pins": old_ordered_pins,
            "original_absence_before": leased_old_absence,
            "current_container_ids": dict(current_ids),
            "current_inspect": inspect_summaries,
            "current_docker_log_sha256": docker_log_sha,
            "runtime_config_sha256": native["config_sha256"],
            "owner_sha256": native["owner_sha256"],
            "launch_sha256": native["launch_sha256"],
            "process_receipt_sha256": native["process_sha256"],
            "retained_cancelled_runs": run_pins,
            "storage_proof": retained_storage,
            "group_ledger_sha256": _sha256(current_ledger_raw),
            "resource_budget": {
                "profile_sha256": budget["profile_sha256"],
                "receipt_sha256": budget["receipt_sha256"],
                "budget": budget["budget"],
            },
        }
        prepared_raw = canonical(host_prepared) + b"\n"
        control.write_bytes(operation["root"] + "/cancelled-recovery-prepared.json", prepared_raw)
        operation["receipt"]["cancelled_namespace_recovery_prepared"] = host_prepared
        control.write(operation["root"] + "/receipt.json", operation["receipt"])

        # The backend maintenance hook has already exited successfully. Stop
        # only the exact frontend and then remove only these two app IDs.
        operation["receipt"].update(state="stopping-cancelled-maintenance-frontend")
        operation["daemon_pending"] = True
        docker_capture("stop", "--time", "60", current_ids["frontend"], timeout=90)
        operation["daemon_pending"] = False
        stopped_pair = {}
        for service in ("backend", "frontend"):
            identifier = current_ids[service]
            rows = json.loads(docker_capture("inspect", identifier, timeout=60).stdout)
            if len(rows) != 1 or rows[0].get("Id") != identifier:
                _fail("Stopped cancellation service inspect is ambiguous: " + service)
            stopped_pair[service] = rows[0]
            cancellation._assert_container_unchanged(leased_pair[service], rows[0], service, stopped=True)
        volume_dev._assert_private_restart_network(stopped_pair, current_ids, control.project)
        _assert_consumers(control, current_ids_set | {helper_id})
        operation["receipt"]["cancelled_namespace_recovery_stopped"] = {
            "backend": cancellation._safe_inspect_summary(stopped_pair["backend"]),
            "frontend": cancellation._safe_inspect_summary(stopped_pair["frontend"]),
        }
        control.write(operation["root"] + "/receipt.json", operation["receipt"])

        operation["receipt"].update(state="removing-cancelled-maintenance-pair")
        operation["daemon_pending"] = True
        docker_capture("rm", current_ids["backend"], current_ids["frontend"], timeout=90)
        operation["daemon_pending"] = False
        current_absence = [
            {"container_id": current_ids[service], "service": service,
             "absence": _absence_observation(current_ids[service])}
            for service in ("backend", "frontend")
        ]
        old_absence = _verify_absent_pair(old_ordered_pins)
        if cancellation._project_container_ids(control.project) != {helper_id}:
            _fail("Compose project retains a container beyond its active operation helper")
        if cancellation._volume_consumer_ids(control.volume) != {helper_id}:
            _fail("Control volume retains a consumer beyond its active operation helper")
        network_state = recovery._verify_network_after_removal(
            current_network_name, list(current_ids.values()), control.project
        )
        removed_record = {
            "schema": "fullmag.docker-cancelled-namespace-recovery-removed.v1",
            "state": "exact-maintenance-pair-removed",
            "request_id": request_id,
            "cancellation_attempt": attempt,
            "cancellation_terminal_sha256": terminal_sha,
            "prepared_sha256": _sha256(prepared_raw),
            "current_container_ids": dict(current_ids),
            "stopped": operation["receipt"]["cancelled_namespace_recovery_stopped"],
            "current_namespace_absence": current_absence,
            "original_container_pins": old_ordered_pins,
            "original_namespace_absence": old_absence,
            "network_name": current_network_name,
            "network_state_after_removal": network_state,
            "remaining_project_consumers": [helper_id],
            "remaining_control_volume_consumers": [helper_id],
        }
        removed_raw = canonical(removed_record) + b"\n"
        control.write_bytes(operation["root"] + "/cancelled-recovery-removed.json", removed_raw)
        operation["receipt"]["cancelled_namespace_recovery_removed"] = removed_record
        control.write(operation["root"] + "/receipt.json", operation["receipt"])

        operator_document = {
            "schema": OPERATOR_SCHEMA,
            "request_id": request_id,
            "source_root": str(selected),
            "compose_project": control.project,
            "cancellation_attempt": attempt,
            "cancellation_terminal_sha256": terminal_sha,
            "cancellation_request_sha256": result["request_sha256"],
            "cancellation_maintenance_receipt_sha256": result["maintenance_receipt_sha256"],
            "cancellation_admission_sha256": result["admission_sha256"],
            "original_attempt": previous["attempt"],
            "original_terminal_sha256": _sha256(previous_raw),
            "original_compose_sha256": _sha256(canonical(previous_compose)),
            "preflight_sha256": _sha256(preflight_raw),
            "removed_journal_sha256": _sha256(removed_raw),
            "prior_stop_journal_sha256": _sha256(preflight_raw),
            "prior_ready_owner_proof_sha256": _sha256(preflight_raw),
            "runtime_config_sha256": native["config_sha256"],
            "owner_sha256": native["owner_sha256"],
            "launch_sha256": native["launch_sha256"],
            "process_receipt_sha256": native["process_sha256"],
            "cancellation_compose_sha256": _sha256(canonical(cancellation_compose)),
            "retained_cancelled_runs": run_pins,
        }
        operator_relative = native_request_root + "/operator-authorization.json"
        operator_sha, _ = recovery._write_record(control, operator_relative, operator_document)
        manifest = {
            "schema": MANIFEST_SCHEMA,
            "request_id": request_id,
            "source_root": str(selected),
            "compose_project": control.project,
            "docker_engine_id_sha256": engine_sha,
            "operator_authorization_sha256": operator_sha,
            "cancellation": {
                "attempt": attempt,
                "terminal_sha256": terminal_sha,
                "request_sha256": result["request_sha256"],
                "maintenance_receipt_sha256": result["maintenance_receipt_sha256"],
                "admission_sha256": result["admission_sha256"],
                "native_result": dict(native_result),
                "compose_sha256": _sha256(canonical(cancellation_compose)),
            },
            "original": {
                "attempt": previous["attempt"],
                "terminal_sha256": _sha256(previous_raw),
                "compose_sha256": _sha256(canonical(previous_compose)),
                "preflight_sha256": _sha256(preflight_raw),
                "container_pins": old_ordered_pins,
                "namespace_absence": old_absence,
            },
            "current_maintenance": {
                "container_ids": dict(current_ids),
                "inspect": inspect_summaries,
                "docker_log_sha256": docker_log_sha,
                "stopped": operation["receipt"]["cancelled_namespace_recovery_stopped"],
                "namespace_absence": current_absence,
                "removed_journal_sha256": _sha256(removed_raw),
                "network_name": current_network_name,
                "network_state_after_removal": network_state,
            },
            "runtime_pins": {
                "config_sha256": native["config_sha256"],
                "owner_sha256": native["owner_sha256"],
                "launch_sha256": native["launch_sha256"],
                "process_receipt_sha256": native["process_sha256"],
                "prior_ready_owner_proof_sha256": _sha256(preflight_raw),
            },
            "retained_cancelled_runs": run_pins,
            "storage_proof": retained_storage,
            "group_ledger": {
                "record_sha256": _sha256(current_ledger_raw),
                "daemon_id_sha256": engine_sha,
                "volume_name": current_ledger["volume_name"],
                "host_id": current_ledger["host_id"],
            },
            "device_release": {"resource_id": device_release["resource_id"],
                               "mapping": device_mapping,
                               "mapping_sha256": device_release["mapping_sha256"]},
            "resource_budget": {
                "profile_sha256": budget["profile_sha256"],
                "receipt_sha256": budget["receipt_sha256"],
                "budget": budget["budget"],
            },
            "session_certificate_sha256": _sha256(canonical(certificate)),
        }
        manifest_relative = native_request_root + "/manifest.json"
        manifest_sha, _ = recovery._write_record(control, manifest_relative, manifest)

        request_authorization = dict(operator_document)
        request_authorization["prior_ready_owner_proof_sha256"] = _sha256(preflight_raw)
        request_document = recovery._build_request(
            request_authorization,
            owner=native["owner"],
            owner_sha256=native["owner_sha256"],
            launch_sha256=native["launch_sha256"],
            config=native["config"],
            control=control,
            device_release=device_release,
            config_sha256=native["config_sha256"],
            store_root_sha256=retained_storage["store_root_sha256"],
            ledger_root_sha256=retained_storage["ledger_root_sha256"],
            ledger_snapshot_sha256=retained_storage["ledger_snapshot_sha256"],
            docker_engine_id_sha256=engine_sha,
            manifest_sha256=manifest_sha,
            containers=old_ordered_pins,
            retained_cancelled_runs=run_pins,
        )
        request_relative = native_request_root + "/request.json"
        request_raw_out = recovery._canonical(request_document)
        request_sha_out = _sha256(request_raw_out)
        control.write_bytes(request_relative, request_raw_out)
        absence_attestation = {
            "schema_version": recovery.ABSENCE_ATTESTATION_SCHEMA,
            "request_sha256": request_sha_out,
            "docker_engine_id_sha256": engine_sha,
            "containers": old_absence,
            "device_release": dict(device_release),
            "manifest_sha256": manifest_sha,
            "result": "authoritative_namespace_absence",
        }
        absence_attestation = recovery.validate_attestation(
            absence_attestation, request_document, request_sha_out
        )
        attestation_relative = native_request_root + "/attestation.json"
        attestation_sha, _ = recovery._write_record(control, attestation_relative, absence_attestation)
        operator = {
            "request_id": request_id,
            "source_root": str(selected),
            "compose_project": control.project,
            "backend_container_id": old_ordered_pins[0]["container_id"],
            "frontend_container_id": old_ordered_pins[1]["container_id"],
            "old_image_id": original_image,
            "prior_stop_journal_sha256": _sha256(preflight_raw),
        }
        authorization = recovery._runtime_authorization(
            operator,
            operator_sha256=operator_sha,
            request_relative=request_relative,
            request_sha256=request_sha_out,
            attestation_relative=attestation_relative,
            attestation_sha256=attestation_sha,
            manifest_relative=manifest_relative,
            manifest_sha256=manifest_sha,
            config_sha256=native["config_sha256"],
            owner_sha256=native["owner_sha256"],
            launch_sha256=native["launch_sha256"],
        )
        authorization_relative = native_request_root + "/authorization.json"
        authorization_sha, _ = recovery._write_record(control, authorization_relative, authorization)
        recovery_environment = {
            recovery.AUTHORIZATION_ENV: recovery.CONTROL_ROOT + "/" + authorization_relative,
            recovery.AUTHORIZATION_SHA_ENV: authorization_sha,
        }
        recovery_metadata = volume_dev._validate_recovery_metadata({
            "schema": "fullmag.container-recovery.v1",
            "request_id": request_id,
            "request_sha256": request_sha_out,
            "attestation_sha256": attestation_sha,
            "manifest_sha256": manifest_sha,
            "authorization_sha256": authorization_sha,
            "stop_journal_sha256": _sha256(preflight_raw),
            "removed_container_ids": [pin["container_id"] for pin in old_ordered_pins],
        })
        operation["receipt"].update(
            state="starting-native-cancelled-run-recovery",
            container_recovery=recovery_metadata,
            container_recovery_environment=sorted(recovery_environment),
            cancelled_namespace_recovery={
                "request_sha256": request_sha_out,
                "attestation_sha256": attestation_sha,
                "manifest_sha256": manifest_sha,
                "authorization_sha256": authorization_sha,
                "current_container_absence": current_absence,
                "original_container_absence": old_absence,
            },
        )
        control.write(operation["root"] + "/receipt.json", operation["receipt"])

        host = volume_dev._session_host()
        reuse_state = {
            "state": state,
            "host_certificate": volume_dev._certificate_path(state),
            "owner_marker": state / host.OWNER_NAME,
            "receipt": {"image_id": cancellation_image},
            "operator_probe_environment_record": operator_probe,
        }
        start_args = __import__("copy").copy(args)
        start_args.source_root = selected
        start_args.gpu_access = policy
        volume_dev.start(
            start_args,
            reuse_state=reuse_state,
            control=control,
            operation=operation,
            prepared=prepared,
            recovery_environment=recovery_environment,
            recovery_metadata=recovery_metadata,
        )

    final = operation["receipt"].get("container_recovery")
    if (operation["receipt"].get("state") != "succeeded"
            or final != recovery_metadata):
        _fail("Managed cancelled-run recovery did not finish with its pinned native authorization")
    print(json.dumps({
        "schema": OPERATION_SCHEMA,
        "state": "succeeded",
        "request_id": request_id,
        "cancellation_attempt": attempt,
        "recovery_attempt": operation["receipt"].get("attempt"),
        "request_sha256": request_sha_out,
        "attestation_sha256": attestation_sha,
        "manifest_sha256": manifest_sha,
        "authorization_sha256": authorization_sha,
        "backend_container": operation["receipt"].get("backend_container"),
        "frontend_container": operation["receipt"].get("frontend_container"),
        "url": operation["receipt"].get("url"),
    }, ensure_ascii=False, sort_keys=True))
    return dict(operation["receipt"])


__all__ = ["OPERATION_SCHEMA", "recover_cancelled"]
