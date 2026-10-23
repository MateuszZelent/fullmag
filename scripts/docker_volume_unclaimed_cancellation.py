"""Run one explicitly pinned unclaimed-task cancellation through volume DEV.

This maintenance path is deliberately separate from ordinary recreate and
container recovery.  It removes only the exact stopped backend/frontend pair
after preserving their runtime evidence, starts the new package through the
selected Compose group, and returns when the image-owned cancellation hook
publishes its typed terminal receipt.  It never starts a replacement API or
solver after that receipt.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
import uuid
from collections.abc import Mapping
from typing import Any

import fullmag_storage as storage
from docker_build_control import (
    BuildControl,
    BuildControlError,
    ControlOutcomeUnknown,
    bounded_capture,
    canonical,
    compose_capture,
    docker_capture,
    toolchain_configuration,
    build_volume_toolchain,
    build_volume_runtime_images,
)
from docker_dev_host import require_host


REQUEST_SCHEMA = "runtime_service_unclaimed_cancellation_request.v1"
MAINTENANCE_RECEIPT_SCHEMA = "fullmag.docker-runtime-unclaimed-cancellation-maintenance.v1"
OPERATION_SCHEMA = "fullmag.docker-volume-unclaimed-cancellation.v1"
RUNTIME_ROOT = "runtime-control"
REQUEST_ROOT = "backend/runtime-service/unclaimed-cancellation/requests"
RECEIPT_ROOT = "backend/runtime-service/unclaimed-cancellation/receipts"
MAX_CONTROL_BYTES = 8 * 1024 * 1024
MAX_REQUEST_BYTES = 256 * 1024
MAX_CATALOG_BYTES = 16 * 1024 * 1024
MAX_LOG_BYTES = 1024 * 1024
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
ATTEMPT_RE = re.compile(r"[0-9a-f]{32}\Z")
CONTAINER_RE = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
STORE_ID_RE = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*\Z")
REQUEST_ID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z"
)
PRESTART_RESUME_ERROR = (
    "Fullmag project containers include an unadmitted container; "
    "only the exact active build-control helper may be retained"
)
NATIVE_FAILURE_RESUME_ERROR = "Unclaimed cancellation backend has no clean terminal container outcome"
NATIVE_FAILURE_LOG_MARKER = "runtime generation differs from the execution pin"


def _fail(message: str) -> None:
    raise BuildControlError(message)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _json_object(raw: bytes, label: str, *, maximum: int = MAX_CONTROL_BYTES) -> dict[str, Any]:
    if len(raw) > maximum:
        _fail(label + " exceeds its bounded size")

    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                _fail(label + " contains a duplicate JSON key")
            value[key] = item
        return value

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError(label + " is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        _fail(label + " must be a JSON object")
    return value


def _control_raw(control: BuildControl, relative: str, *, optional: bool = False,
                 maximum: int = MAX_CONTROL_BYTES) -> bytes | None:
    try:
        return control.read_bytes(relative, optional=optional, maximum=maximum, timeout=90)
    except ControlOutcomeUnknown:
        # Preserve the uncertain-operation type so BuildControl retains the
        # helper lease instead of publishing a false terminal failure.
        raise
    except BuildControlError as error:
        raise BuildControlError(
            "Cannot read control-volume evidence " + relative + ": " + str(error)[-1024:]
        ) from error


def _publish_immutable(control: BuildControl, relative: str, raw: bytes) -> None:
    """Create a control record without replacing an existing request."""
    if len(raw) > MAX_REQUEST_BYTES:
        _fail("Unclaimed cancellation request exceeds the control-volume bound")
    path = control.path(relative)
    parent = str(Path(path).parent)
    script = f"""set -euo pipefail
parent={shlex.quote(parent)}
path={shlex.quote(path)}
mkdir -p -- "$parent"
test ! -L "$parent"
test "$(readlink -f -- "$parent")" = "$parent"
tmp=$(mktemp "$parent/.publish.XXXXXXXX")
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp"
chmod 0440 "$tmp"
sync "$tmp"
if test -e "$path" || test -L "$path"; then
  test ! -L "$path"
  test -f "$path"
  test "$(stat -c %h "$path")" = 1
  cmp -s -- "$path" "$tmp"
else
  ln -- "$tmp" "$path"
  sync "$parent"
fi
"""
    result = bounded_capture(control.helper_args(script), data=raw, timeout=90)
    if result.returncode:
        _fail(
            "Cannot publish immutable cancellation request: "
            + result.stderr.decode("utf-8", "replace")[-1024:]
        )


def _safe_id(value: object, label: str) -> str:
    if not isinstance(value, str) or STORE_ID_RE.fullmatch(value) is None or value.endswith("."):
        _fail(label + " is not a canonical session-store id")
    return value


def _request_inputs(args, control, previous, document, state, owner_raw, config_raw):
    request_id = getattr(args, "request_id", None)
    if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
        _fail("--request-id must be a canonical nonzero UUID")
    try:
        if uuid.UUID(request_id).int == 0 or str(uuid.UUID(request_id)) != request_id:
            _fail("--request-id must be a canonical nonzero UUID")
    except ValueError as error:
        raise BuildControlError("--request-id must be a canonical nonzero UUID") from error

    run_id = _safe_id(getattr(args, "run_id", None), "--run-id")
    task_id = _safe_id(getattr(args, "task_id", None), "--task-id")
    reason = getattr(args, "reason", None)
    if (not isinstance(reason, str) or not reason.strip() or len(reason.encode("utf-8")) > 4096
            or any(ord(character) < 0x20 or ord(character) == 0x7f for character in reason)):
        _fail("--reason must be non-empty, bounded, and contain no control characters")

    config = _json_object(config_raw, "retained runtime-service configuration", maximum=256 * 1024)
    if (config.get("store_root") != "/state/runs/docker-all/session-store"
            or config.get("host_execution") is None):
        _fail("Retained native configuration does not bind the expected managed session store")
    owner = _json_object(owner_raw, "retained runtime-service owner", maximum=256 * 1024)
    if (owner.get("schema_version") != "runtime_service_owner.v1"
            or owner.get("state") not in {"unknown", "failed"}
            or owner.get("target_id") != config.get("target_id")):
        _fail("Unclaimed cancellation requires the exact retained Unknown or Failed owner")
    for field in ("owner_token", "process_start_token", "host", "target_id", "protocol"):
        if not isinstance(owner.get(field), str) or not owner[field] or len(owner[field]) > 255:
            _fail("Retained owner descriptor has an invalid " + field)
    if type(owner.get("pid")) is not int or owner["pid"] <= 0:
        _fail("Retained owner descriptor has no positive PID identity")
    children = owner.get("children")
    if not isinstance(children, list) or len(children) != 2:
        _fail("Retained owner descriptor does not contain both scheduler identities")

    state = Path(state)
    store_root = storage.validate_path(
        state / "runs" / "docker-all" / "session-store", state,
        "retained accepted session store",
    )
    run_root = storage.validate_path(store_root / "runs" / run_id, store_root,
                                     "pinned accepted run")
    catalog_path = storage.validate_path(run_root / "run_catalog.json", store_root,
                                         "pinned accepted run catalog")
    host = __import__("docker_volume_dev")._session_host()
    catalog_raw = host.read_owned_regular(catalog_path, maximum=MAX_CATALOG_BYTES)
    catalog = _json_object(catalog_raw, "pinned accepted run catalog", maximum=MAX_CATALOG_BYTES)
    revision = catalog.get("revision")
    tasks = catalog.get("tasks")
    if (catalog.get("run_id") != run_id or type(revision) is not int or revision <= 0
            or not isinstance(tasks, list) or len(tasks) > 4096):
        _fail("Pinned run catalog identity or revision is invalid")
    matches = [task for task in tasks if isinstance(task, dict) and task.get("task_id") == task_id]
    if len(matches) != 1:
        _fail("Pinned run catalog does not contain exactly one requested task")
    task = matches[0]
    lifecycle = task.get("lifecycle")
    if lifecycle not in {"accepted", "queued"}:
        _fail("A new cancellation request requires an Accepted or Queued task")
    if any(task.get(field) is not None for field in (
        "attempt_id", "resource_id", "resolved_input_fingerprint",
        "coordinator_watermark", "coordinator_genesis",
    )):
        _fail("Requested task is already claimed or has durable execution evidence")
    if not isinstance(task.get("artifact_ids", []), list) or len(task.get("artifact_ids", [])) > 4096:
        _fail("Requested task artifact list exceeds its bound")

    request = {
        "schema_version": REQUEST_SCHEMA,
        "request_id": request_id,
        "config_sha256": _sha256(config_raw),
        "owner_sha256": _sha256(owner_raw),
        "expected_owner": owner,
        "run_id": run_id,
        "task_id": task_id,
        "expected_catalog_revision": revision,
        "expected_catalog_sha256": _sha256(catalog_raw),
        "expected_task": task,
        "reason": reason,
    }
    raw = canonical(request) + b"\n"
    if len(raw) > MAX_REQUEST_BYTES:
        _fail("Unclaimed cancellation request exceeds its byte limit")
    return request, raw, catalog_raw


def _project_container_ids(project: str) -> set[str]:
    result: set[str] = set()
    for label in ("com.docker.compose.project", "org.fullmag.compose.project"):
        output = docker_capture(
            "ps", "--all", "--quiet", "--no-trunc", "--filter", "label=" + label + "=" + project,
            timeout=60,
        ).stdout.decode("utf-8", "replace")
        result.update(line.strip() for line in output.splitlines() if line.strip())
    return result


def _volume_consumer_ids(volume: str) -> set[str]:
    output = docker_capture(
        "ps", "--all", "--quiet", "--no-trunc", "--filter", "volume=" + volume,
        timeout=60,
    ).stdout.decode("utf-8", "replace")
    return {line.strip() for line in output.splitlines() if line.strip()}


def _operation_helper_id(control, operation):
    """Authenticate the one long-lived BuildControl helper for this lease."""
    receipt = operation.get("receipt") if isinstance(operation, Mapping) else None
    name = receipt.get("helper_container") if isinstance(receipt, Mapping) else None
    attempt = receipt.get("attempt") if isinstance(receipt, Mapping) else None
    if (not isinstance(attempt, str) or ATTEMPT_RE.fullmatch(attempt) is None
            or name != "fullmag-control-" + attempt):
        _fail("Active development operation has no exact control-helper identity")
    rows = json.loads(docker_capture("inspect", name, timeout=60).stdout)
    if len(rows) != 1:
        _fail("Active development control helper is ambiguous")
    row = rows[0]
    config = row.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    state = row.get("State")
    host = row.get("HostConfig")
    if (not isinstance(labels, Mapping) or not isinstance(row.get("Id"), str)
            or CONTAINER_RE.fullmatch(row["Id"]) is None
            or not isinstance(config, Mapping) or config.get("Image") != control.image
            or labels.get("com.docker.compose.project") != control.project
            or labels.get("com.docker.compose.service") != "build-control"
            or labels.get("org.fullmag.compose.project") != control.project
            or not isinstance(state, Mapping) or state.get("Running") is not True
            or type(state.get("Pid")) is not int or state["Pid"] <= 0
            or not isinstance(host, Mapping) or host.get("NetworkMode") != "none"):
        _fail("Active development control helper does not match this private lease")
    mounts = row.get("Mounts")
    control_mounts = [mount for mount in mounts if isinstance(mount, Mapping)
                      and mount.get("Destination") == "/control"] if isinstance(mounts, list) else []
    if (len(control_mounts) != 1 or control_mounts[0].get("Type") != "volume"
            or control_mounts[0].get("Name") != control.volume):
        _fail("Active development control helper does not mount the exact control volume")
    command = config.get("Cmd") if isinstance(config, Mapping) else None
    command_text = " ".join(command) if isinstance(command, list) and all(
        isinstance(item, str) for item in command
    ) else ""
    if ("/control/development/attempts/" + attempt not in command_text
            or "until test -f" not in command_text
            or "/control/active" not in command_text):
        _fail("Active development helper command is not the exact held lease script")
    from docker_compose_identity import validate_source_labels
    validate_source_labels(row, control.identity)
    return row["Id"]


def _observe_retained_namespace(args, control, identity, previous, document, *, operation=None):
    import docker_volume_container_recovery as container_recovery
    import docker_volume_dev as volume_dev
    from docker_compose_identity import validate_source_labels

    ids = {}
    actual = {}
    for service in ("backend", "frontend"):
        identifier = compose_capture(document, "ps", "--all", "--quiet", service).decode().strip()
        if CONTAINER_RE.fullmatch(identifier) is None:
            _fail("Retained Compose does not return one exact " + service + " container")
        if previous.get(service + "_container") != identifier:
            _fail("Retained terminal receipt does not pin the current " + service + " container")
        ids[service] = identifier
        rows = json.loads(docker_capture("inspect", identifier, timeout=60).stdout)
        if len(rows) != 1 or rows[0].get("Id") != identifier:
            _fail("Retained " + service + " inspection is ambiguous")
        row = actual[service] = rows[0]
        config = row.get("Config", {})
        labels = config.get("Labels", {}) if isinstance(config, Mapping) else {}
        previous_inputs = previous.get("inputs")
        previous_image = previous_inputs.get("image_id") if isinstance(previous_inputs, Mapping) else None
        if (row.get("Image") != previous_image
                or labels.get("com.docker.compose.project") != control.project
                or labels.get("com.docker.compose.service") != service):
            _fail("Retained " + service + " belongs to another image or Compose identity")
        validate_source_labels(row, identity)

    if actual["backend"].get("State", {}).get("Running") is not False:
        _fail("Unclaimed cancellation requires the exact backend container already stopped")
    if actual["backend"].get("State", {}).get("Pid") != 0:
        _fail("Stopped backend still has a daemon PID; namespace teardown is withheld")
    if actual["backend"].get("State", {}).get("OOMKilled") is True:
        _fail("Backend stop was caused by OOM; use explicit native recovery before cancellation")

    previous_inputs = previous.get("inputs")
    image_id = previous_inputs.get("image_id") if isinstance(previous_inputs, Mapping) else None
    if not isinstance(image_id, str) or IMAGE_RE.fullmatch(image_id) is None:
        _fail("Retained DEV attempt has no immutable image ID")
    image_rows = json.loads(docker_capture("image", "inspect", image_id, timeout=60).stdout)
    if len(image_rows) != 1 or image_rows[0].get("Id") != image_id:
        _fail("Retained image identity is ambiguous")
    image_config = image_rows[0].get("Config")
    if not isinstance(image_config, Mapping):
        _fail("Retained image config is missing")
    for service in ("backend", "frontend"):
        volume_dev._validate_retained_service(
            document, actual[service], service, image_config,
            allow_legacy_frontend=True,
        )
        container_recovery._container_pin(actual[service], service, control.project)

    # The stopped process may have an unknown result, but its PID and network
    # namespaces must still be private so removing this exact container can
    # only tear down this Compose group.
    networks = actual["backend"].get("NetworkSettings", {}).get("Networks", {})
    front_networks = actual["frontend"].get("NetworkSettings", {}).get("Networks", {})
    if len(networks) != 1 or set(networks) != set(front_networks):
        _fail("Retained app services do not share exactly one private group bridge")
    network_name = next(iter(networks))
    if network_name != identity.get("network_name"):
        _fail("Retained app bridge is not the selected checkout's deterministic network")
    volume_dev._assert_private_restart_network(actual, ids, control.project)

    helper_id = _operation_helper_id(control, operation) if operation is not None else None
    expected_ids = set(ids.values())
    expected_group_ids = expected_ids | ({helper_id} if helper_id is not None else set())
    if _project_container_ids(control.project) != expected_group_ids:
        _fail("Compose group has foreign or unlisted containers; no teardown was started")
    if _volume_consumer_ids(control.volume) != expected_group_ids:
        _fail("Control namespace has foreign consumers; no teardown was started")
    return ids, actual, image_id, image_config, helper_id


def _assert_container_unchanged(before, after, service: str, *, stopped: bool) -> None:
    if (before.get("Id") != after.get("Id") or before.get("Image") != after.get("Image")
            or before.get("State", {}).get("StartedAt") != after.get("State", {}).get("StartedAt")):
        _fail("Retained " + service + " container incarnation changed during maintenance")
    state = after.get("State", {})
    if stopped and (state.get("Running") is not False or state.get("Pid") != 0
                    or not isinstance(state.get("FinishedAt"), str) or not state["FinishedAt"]):
        _fail("Retained " + service + " has no authoritative stopped-container observation")


def _assert_removed(identifier: str, service: str) -> None:
    inspected = docker_capture("inspect", identifier, allow_failure=True, timeout=60)
    if inspected.returncode == 0:
        _fail("Pinned old " + service + " container remains inspectable after exact removal")
    detail = (inspected.stderr + inspected.stdout).decode("utf-8", "replace")
    if re.search(r"(?:no such object|no such container):\s*" + re.escape(identifier) + r"(?:\s|$)",
                 detail, re.IGNORECASE) is None:
        _fail("Docker did not authoritatively confirm old " + service + " container absence")
    listed = docker_capture(
        "ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + identifier, timeout=60
    )
    if listed.returncode or listed.stdout.decode("utf-8", "replace").split():
        _fail("Removed old " + service + " container ID remains listed")


def _safe_inspect_summary(actual: Mapping[str, Any]) -> dict[str, Any]:
    config = actual.get("Config", {})
    host = actual.get("HostConfig", {})
    state = actual.get("State", {})
    networks = actual.get("NetworkSettings", {}).get("Networks", {})
    mounts = actual.get("Mounts", [])
    return {
        "container_id": actual.get("Id"),
        "image_id": actual.get("Image"),
        "service": (config.get("Labels") or {}).get("com.docker.compose.service"),
        "project": (config.get("Labels") or {}).get("com.docker.compose.project"),
        "started_at": state.get("StartedAt"),
        "finished_at": state.get("FinishedAt"),
        "running": state.get("Running"),
        "pid": state.get("Pid"),
        "exit_code": state.get("ExitCode"),
        "oom_killed": state.get("OOMKilled"),
        "config_sha256": _sha256(canonical(config)),
        "host_config_sha256": _sha256(canonical(host)),
        "mounts": [
            {key: mount.get(key) for key in ("Type", "Name", "Source", "Destination", "Driver", "RW")}
            for mount in mounts if isinstance(mount, Mapping)
        ],
        "networks": {
            name: {
                "network_id": item.get("NetworkID"),
                "endpoint_id": item.get("EndpointID"),
                "gateway": item.get("Gateway"),
                "ip_address": item.get("IPAddress"),
            }
            for name, item in networks.items() if isinstance(item, Mapping)
        },
    }


def _request_path(request_id: str) -> str:
    return "/opt/fullmag/control/" + REQUEST_ROOT + "/" + request_id + ".json"


def _publish_terminal_result(control, operation, maintenance, result):
    if not isinstance(result, Mapping):
        _fail("Backend maintenance did not return a typed unclaimed-cancellation result")
    if operation["receipt"].get("unclaimed_cancellation") != dict(maintenance):
        _fail("Maintenance operation request binding changed before terminal publication")
    operation["receipt"]["unclaimed_cancellation_result"] = dict(result)


def wait_for_maintenance(control, operation, backend_id, document, maintenance, *, timeout=600):
    """Validate a completed one-shot cancellation container and its receipts.

    Called by ``docker_volume_dev._finish`` after package publication,
    storage admission, cgroup attestation and ledger attestation, before API
    readiness checks.  The maintenance hook is expected to stop PID 1 after
    it publishes its immutable result; this observer never execs into the
    backend or starts a replacement service.
    """
    if (not isinstance(maintenance, Mapping)
            or set(maintenance) != {"request_id", "request_sha256", "request_path"}):
        _fail("Maintenance invocation pins do not match the closed schema")
    request_id = maintenance["request_id"]
    request_sha256 = maintenance["request_sha256"]
    request_path = maintenance["request_path"]
    if (not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None
            or not isinstance(request_sha256, str) or SHA256_RE.fullmatch(request_sha256) is None
            or request_path != _request_path(request_id)):
        _fail("Maintenance invocation contains an invalid cancellation pin")

    operation_receipt = operation.get("receipt")
    if not isinstance(operation_receipt, Mapping):
        _fail("Maintenance operation has no durable receipt")
    attempt = operation_receipt.get("attempt")
    if not isinstance(attempt, str) or ATTEMPT_RE.fullmatch(attempt) is None:
        _fail("Maintenance operation attempt is invalid")
    if operation_receipt.get("unclaimed_cancellation") != dict(maintenance):
        _fail("Maintenance operation receipt does not retain the exact invocation pins")
    admission_relative = (
        "backend/runtime-service/unclaimed-cancellation/admissions/" + attempt + ".json"
    )
    admission_raw = _control_raw(control, admission_relative, maximum=MAX_REQUEST_BYTES)
    if admission_raw is None:
        _fail("Maintenance backend has no host admission receipt")
    admission = _json_object(admission_raw, "unclaimed cancellation admission")
    if set(admission) != {
        "schema", "attempt", "request_id", "request_sha256", "backend_container_id",
        "backend_started_at", "backend_build_receipt_sha256",
    }:
        _fail("Unclaimed cancellation admission has an unsupported shape")
    expected_build_sha256 = operation_receipt.get("backend_build_receipt_sha256")
    started_at = operation_receipt.get("backend_started_at")
    if (admission.get("schema") != "fullmag.docker-runtime-unclaimed-cancellation-admission.v1"
            or admission.get("attempt") != attempt
            or admission.get("request_id") != request_id
            or admission.get("request_sha256") != request_sha256
            or admission.get("backend_container_id") != backend_id
            or not isinstance(started_at, str) or not started_at
            or admission.get("backend_started_at") != started_at
            or not isinstance(expected_build_sha256, str)
            or SHA256_RE.fullmatch(expected_build_sha256) is None
            or admission.get("backend_build_receipt_sha256") != expected_build_sha256
            or operation_receipt.get("unclaimed_cancellation_admission") != admission):
        _fail("Unclaimed cancellation admission differs from the current package or backend")
    admission_sha256 = _sha256(admission_raw)
    deadline = time.monotonic() + timeout
    terminal = None
    while time.monotonic() < deadline:
        rows = json.loads(docker_capture("inspect", backend_id, timeout=60).stdout)
        if len(rows) != 1 or rows[0].get("Id") != backend_id:
            _fail("Maintenance backend identity became ambiguous")
        observed = rows[0]
        state = observed.get("State", {})
        if started_at is not None and state.get("StartedAt") != started_at:
            _fail("Maintenance backend incarnation changed while waiting for its receipt")
        if state.get("Running") is False:
            terminal = observed
            break
        time.sleep(1)
    if terminal is None:
        _fail("Unclaimed cancellation maintenance did not stop within its bounded wait")
    state = terminal.get("State", {})
    if (state.get("Pid") != 0 or state.get("ExitCode") != 0 or state.get("OOMKilled") is not False
            or not isinstance(state.get("FinishedAt"), str) or not state.get("FinishedAt")):
        detail = "Docker logs unavailable"
        try:
            captured = docker_capture("logs", "--tail", "500", backend_id, timeout=60)
            failure_log = bytes(captured.stdout) + bytes(captured.stderr)
            if len(failure_log) <= MAX_LOG_BYTES:
                control.write_bytes(operation["root"] + "/unclaimed-cancellation-failure-log.txt",
                                    failure_log)
                lines = failure_log.decode("utf-8", "replace").splitlines()
                candidates = [line.strip() for line in lines if re.search(
                    r"(?:RuntimeError|Error|failed|failure|Traceback)", line, re.IGNORECASE
                )]
                if candidates:
                    detail = candidates[-1][-768:]
                elif lines:
                    detail = lines[-1][-768:]
                else:
                    detail = "container produced no log output"
            else:
                detail = "bounded Docker log tail exceeded its preservation limit"
        except (BuildControlError, OSError, subprocess.SubprocessError):
            pass
        _fail(
            NATIVE_FAILURE_RESUME_ERROR + "; exit=" + str(state.get("ExitCode"))
            + "; oom=" + str(state.get("OOMKilled")) + "; native failure: " + detail
        )
    labels = terminal.get("Config", {}).get("Labels", {})
    if (terminal.get("Image") != operation_receipt.get("inputs", {}).get("image_id")
            or labels.get("com.docker.compose.project") != control.project
            or labels.get("com.docker.compose.service") != "backend"):
        _fail("Terminal maintenance container does not belong to the selected backend service")
    import docker_volume_dev as volume_dev
    image_id = operation_receipt.get("inputs", {}).get("image_id")
    image_rows = json.loads(docker_capture("image", "inspect", image_id, timeout=60).stdout)
    if len(image_rows) != 1 or image_rows[0].get("Id") != image_id:
        _fail("Terminal maintenance backend image identity is ambiguous")
    volume_dev._validate_retained_service(
        document, terminal, "backend", image_rows[0].get("Config"),
        expected_started_at=started_at,
    )

    request_relative = REQUEST_ROOT + "/" + request_id + ".json"
    request_raw = _control_raw(control, request_relative, maximum=MAX_REQUEST_BYTES)
    if request_raw is None or _sha256(request_raw) != request_sha256:
        _fail("Terminal maintenance request bytes differ from the host pin")
    request = _json_object(request_raw, "terminal unclaimed cancellation request", maximum=MAX_REQUEST_BYTES)
    if request.get("schema_version") != REQUEST_SCHEMA or request.get("request_id") != request_id:
        _fail("Terminal maintenance request identity differs")

    # The image-owned hook writes result-addressed receipts prefixed by the
    # managed attempt. Enumerate only this attempt/request and require a
    # single match for its typed result digest.
    receipt_dir = control.path(RECEIPT_ROOT)
    list_script = f"""set -euo pipefail
root={shlex.quote(receipt_dir)}
test ! -L "$root"
test -d "$root"
test "$(readlink -f -- "$root")" = "$root"
        find "$root" -mindepth 1 -maxdepth 1 -type f -name {shlex.quote(attempt + "-" + request_id + "-" + request_sha256 + "-*.json")} -print
"""
    listed = bounded_capture(control.helper_args(list_script), data=b"", timeout=90)
    if listed.returncode:
        _fail("Cannot enumerate immutable cancellation receipts")
    receipt_paths = [line.decode("utf-8", "strict") for line in listed.stdout.splitlines() if line]
    if len(receipt_paths) != 1:
        _fail("Terminal maintenance has no unique immutable receipt for this request")
    relative = receipt_paths[0]
    if not relative.startswith(receipt_dir + "/") or "/" in relative[len(receipt_dir) + 1:]:
        _fail("Maintenance receipt path escaped its private control directory")
    receipt_raw = _control_raw(control, relative[len("/control/"):], maximum=256 * 1024)
    if receipt_raw is None:
        _fail("Maintenance receipt disappeared after enumeration")
    receipt = _json_object(receipt_raw, "unclaimed cancellation maintenance receipt", maximum=256 * 1024)
    if set(receipt) != {
        "schema", "request_id", "request_sha256", "state", "native_result",
        "native_stdout_sha256", "attempt", "admission_sha256",
    }:
        _fail("Maintenance receipt has an unsupported shape")
    if (receipt.get("schema") != MAINTENANCE_RECEIPT_SCHEMA
            or receipt.get("request_id") != request_id
            or receipt.get("request_sha256") != request_sha256
            or receipt.get("attempt") != attempt
            or receipt.get("admission_sha256") != admission_sha256):
        _fail("Maintenance receipt identity differs from request and admission")
    native = receipt.get("native_result")
    if (not isinstance(native, Mapping) or set(native) != {
                "schema_version", "request_id", "disposition", "run_id", "task_id", "catalog_revision"
            }
            or native.get("schema_version") != REQUEST_SCHEMA
            or native.get("request_id") != request_id
            or native.get("run_id") != request.get("run_id")
            or native.get("task_id") != request.get("task_id")
            or native.get("disposition") not in {
                "cancelled", "cancellation_requested_projection_deferred"
            }):
        _fail("Maintenance receipt does not contain the exact native typed result")
    if (receipt.get("state") != ("cancelled" if native["disposition"] == "cancelled"
                                 else "projection_deferred")
            or not isinstance(receipt.get("native_stdout_sha256"), str)
            or SHA256_RE.fullmatch(receipt["native_stdout_sha256"]) is None):
        _fail("Maintenance receipt disposition or native result digest is invalid")

    if (isinstance(native.get("catalog_revision"), bool)
            or not isinstance(native.get("catalog_revision"), int)
            or native["catalog_revision"] <= 0):
        _fail("Maintenance receipt has an invalid resulting catalog revision")
    native_result_sha256 = _sha256(canonical(native) + b"\n")
    expected_name = (
        attempt + "-" + request_id + "-" + request_sha256 + "-"
        + native_result_sha256 + ".json"
    )
    if Path(relative).name != expected_name:
        _fail("Maintenance receipt filename is not bound to the typed native result")
    result = {
        "schema": OPERATION_SCHEMA,
        "state": receipt["state"],
        "request_id": request_id,
        "request_sha256": request_sha256,
        "native_result": dict(native),
        "maintenance_receipt_sha256": _sha256(receipt_raw),
        "maintenance_receipt_path": relative.removeprefix("/control/"),
        "backend_container_id": backend_id,
        "backend_finished_at": state["FinishedAt"],
        "admission": dict(admission),
        "admission_sha256": admission_sha256,
    }
    _publish_terminal_result(control, operation, maintenance, result)
    operation_receipt["unclaimed_cancellation_result"] = result
    control.write(operation["root"] + "/unclaimed-cancellation-receipt.json", receipt)
    control.write(operation["root"] + "/unclaimed-cancellation-terminal.json", result)
    if native["disposition"] != "cancelled":
        _fail(
            "Native cancellation intent is durable but its catalog projection is deferred; "
            "the typed receipt is preserved and no recovery may proceed"
        )
    return result


def _already_completed_receipt(control, request, request_raw):
    """Return a prior immutable result for a repeated identical request."""
    request_id = request["request_id"]
    request_sha256 = _sha256(request_raw)
    receipt_dir = control.path(RECEIPT_ROOT)
    script = f"""set -euo pipefail
root={shlex.quote(receipt_dir)}
if test ! -e "$root"; then exit 44; fi
test ! -L "$root"
test -d "$root"
test "$(readlink -f -- "$root")" = "$root"
find "$root" -mindepth 1 -maxdepth 1 -type f -name {shlex.quote("*-" + request_id + "-" + request_sha256 + "-*.json")} -print
"""
    result = bounded_capture(control.helper_args(script), data=b"", timeout=90)
    if result.returncode == 44:
        return None
    if result.returncode:
        _fail("Cannot inspect prior immutable cancellation receipts")
    paths = [line.decode("utf-8", "strict") for line in result.stdout.splitlines() if line]
    if not paths:
        return None
    if len(paths) != 1 or not paths[0].startswith(receipt_dir + "/"):
        _fail("Prior cancellation receipt set is ambiguous")
    raw = _control_raw(control, paths[0][len("/control/"):], maximum=256 * 1024)
    if raw is None:
        _fail("Prior cancellation receipt disappeared")
    receipt = _json_object(raw, "prior unclaimed cancellation receipt", maximum=256 * 1024)
    if set(receipt) != {
        "schema", "request_id", "request_sha256", "state", "native_result",
        "native_stdout_sha256", "attempt", "admission_sha256",
    }:
        _fail("Prior cancellation receipt has an unsupported shape")
    native = receipt.get("native_result")
    if (receipt.get("schema") != MAINTENANCE_RECEIPT_SCHEMA
            or receipt.get("request_id") != request_id
            or receipt.get("request_sha256") != request_sha256
            or not isinstance(native, Mapping) or set(native) != {
                "schema_version", "request_id", "disposition", "run_id", "task_id", "catalog_revision"
            }
            or native.get("request_id") != request_id
            or native.get("schema_version") != REQUEST_SCHEMA
            or native.get("run_id") != request.get("run_id")
            or native.get("task_id") != request.get("task_id")
            or native.get("disposition") not in {"cancelled", "cancellation_requested_projection_deferred"}):
        _fail("Prior cancellation receipt is not bound to its immutable request")
    attempt = receipt.get("attempt")
    admission_sha256 = receipt.get("admission_sha256")
    if (not isinstance(attempt, str) or ATTEMPT_RE.fullmatch(attempt) is None
            or not isinstance(admission_sha256, str) or SHA256_RE.fullmatch(admission_sha256) is None
            or ("cancelled" if native["disposition"] == "cancelled" else "projection_deferred")
            != receipt.get("state")
            or not isinstance(receipt.get("native_stdout_sha256"), str)
            or SHA256_RE.fullmatch(receipt["native_stdout_sha256"]) is None
            or isinstance(native.get("catalog_revision"), bool)
            or not isinstance(native.get("catalog_revision"), int)
            or native["catalog_revision"] <= 0):
        _fail("Prior cancellation receipt has an invalid state, attempt, or digest")
    result_digest = _sha256(canonical(native) + b"\n")
    expected_name = f"{attempt}-{request_id}-{request_sha256}-{result_digest}.json"
    if Path(paths[0]).name != expected_name:
        _fail("Prior cancellation receipt filename does not bind its typed result")
    admission_raw = _control_raw(
        control, "backend/runtime-service/unclaimed-cancellation/admissions/" + attempt + ".json",
        maximum=MAX_REQUEST_BYTES,
    )
    if admission_raw is None or _sha256(admission_raw) != admission_sha256:
        _fail("Prior cancellation receipt does not bind its immutable host admission")
    admission = _json_object(admission_raw, "prior unclaimed cancellation admission")
    if (set(admission) != {
            "schema", "attempt", "request_id", "request_sha256", "backend_container_id",
            "backend_started_at", "backend_build_receipt_sha256",
        }
            or admission.get("schema") != "fullmag.docker-runtime-unclaimed-cancellation-admission.v1"
            or admission.get("attempt") != attempt
            or admission.get("request_id") != request_id
            or admission.get("request_sha256") != request_sha256
            or not isinstance(admission.get("backend_container_id"), str)
            or CONTAINER_RE.fullmatch(admission["backend_container_id"]) is None
            or not isinstance(admission.get("backend_started_at"), str)
            or not admission["backend_started_at"]
            or not isinstance(admission.get("backend_build_receipt_sha256"), str)
            or SHA256_RE.fullmatch(admission["backend_build_receipt_sha256"]) is None):
        _fail("Prior cancellation admission is not bound to the immutable request")
    return {
        "schema": OPERATION_SCHEMA,
        "state": receipt["state"],
        "request_id": request_id,
        "request_sha256": request_sha256,
        "native_result": dict(native),
        "maintenance_receipt_sha256": _sha256(raw),
        "maintenance_receipt_path": paths[0].removeprefix("/control/"),
        "backend_container_id": admission["backend_container_id"],
        "admission": admission,
        "admission_sha256": admission_sha256,
        "replayed_receipt": True,
    }


def _assert_no_request_receipt(control, request_id: str) -> None:
    """Reject any native terminal for this request ID before a one-shot resume."""
    receipt_dir = control.path(RECEIPT_ROOT)
    script = f"""set -euo pipefail
root={shlex.quote(receipt_dir)}
if test ! -e "$root"; then exit 44; fi
test ! -L "$root"
test -d "$root"
test "$(readlink -f -- "$root")" = "$root"
find "$root" -mindepth 1 -maxdepth 1 -name {shlex.quote("*-" + request_id + "-*.json")} -print -quit
"""
    result = bounded_capture(control.helper_args(script), data=b"", timeout=90)
    if result.returncode not in (0, 44):
        _fail("Cannot inspect native cancellation receipts before maintenance resume")
    if result.stdout.strip():
        _fail("A native cancellation receipt already exists for this request ID")


def _assert_no_task_cancellation_intent(state: Path, run_id: str, task_id: str) -> None:
    """Fail closed unless the exact task has no durable native intent."""
    store_root = storage.validate_path(
        state / "runs" / "docker-all" / "session-store", state,
        "retained accepted session store",
    )
    run_root = storage.validate_path(store_root / "runs" / run_id, store_root,
                                     "pinned accepted run")
    intent_path = storage.validate_path(
        run_root / "task_cancellation_intents" / (task_id + ".json"),
        store_root, "pinned task cancellation intent",
    )
    try:
        __import__("docker_volume_dev")._session_host().read_owned_regular(
            intent_path, maximum=256 * 1024
        )
    except FileNotFoundError:
        return
    except (OSError, ValueError, storage.StorageError) as error:
        raise BuildControlError(
            "Cannot prove the pinned task cancellation intent is absent"
        ) from error
    _fail("A durable task cancellation intent already exists; no replay is permitted")


def _saved_backend_budget(control, backend_id, document):
    """Validate the namespace's saved resource budget that start() will reapply."""
    raw = _control_raw(control, "backend/resource-budget.json", maximum=64 * 1024)
    if raw is None:
        _fail("Retained 128 GiB/16 CPU budget has no saved namespace receipt")
    profile = _json_object(raw, "saved backend resource budget", maximum=64 * 1024)
    relative = profile.get("receipt_path")
    if (profile.get("schema") != "fullmag.docker-backend-resource-budget.v1"
            or profile.get("state") != "succeeded"
            or profile.get("compose_project") != control.project
            or profile.get("control_namespace") != control.namespace
            or not isinstance(relative, str)
            or re.fullmatch(
                r"development/attempts/[0-9a-f]{32}/resource-increases/[0-9a-f]{32}/receipt\.json",
                relative,
            ) is None):
        _fail("Saved backend resource budget identity is invalid")
    receipt_raw = _control_raw(control, relative, maximum=64 * 1024)
    if receipt_raw is None or _sha256(receipt_raw) != profile.get("receipt_sha256"):
        _fail("Saved backend resource budget receipt is missing or changed")
    receipt = _json_object(receipt_raw, "backend resource budget receipt", maximum=64 * 1024)
    budget = profile.get("budget")
    if (not isinstance(budget, Mapping)
            or set(budget) != {"memory_bytes", "cpus", "memory_swap_bytes"}
            or receipt.get("schema") != profile["schema"] or receipt.get("state") != "succeeded"
            or receipt.get("compose_project") != control.project
            or receipt.get("control_namespace") != control.namespace
            or receipt.get("budget") != dict(budget)
            or receipt.get("backend_container_id") != backend_id
            or receipt.get("adjustment_id") != relative.split("/")[4]
            or receipt.get("parent_attempt") != relative.split("/")[2]
            or any(type(budget.get(key)) is not int for key in budget)
            or budget["memory_bytes"] != 128 * 1024 ** 3
            or budget["cpus"] != 16
            or (budget["memory_swap_bytes"] != -1
                and budget["memory_swap_bytes"] < budget["memory_bytes"])):
        _fail("Saved resource receipt does not bind the requested 128 GiB/16 CPU profile")
    service = document.get("services", {}).get("backend", {})
    try:
        compose_memory = int(str(service.get("mem_limit", "0")).removesuffix("b"))
        compose_cpus = float(service.get("cpus", 0))
        compose_swap = (
            int(str(service["memswap_limit"]).removesuffix("b"))
            if "memswap_limit" in service else None
        )
    except (TypeError, ValueError):
        _fail("Failed Compose document has an invalid retained backend budget")
    # A live increase changes Docker limits and saves a budget receipt; it
    # deliberately does not rewrite the original immutable Compose document.
    before = receipt.get("before", {})
    if (before.get("memory_bytes") != compose_memory
            or before.get("nano_cpus") != compose_cpus * 10**9
            or (compose_swap is not None and before.get("memory_swap_bytes") != compose_swap)
            or compose_memory > budget["memory_bytes"] or compose_cpus > budget["cpus"]):
        _fail("Failed Compose budget differs from the saved increase's original limits")
    actual = json.loads(docker_capture("inspect", backend_id, timeout=60).stdout)
    if len(actual) != 1 or actual[0].get("Id") != backend_id:
        _fail("Cannot bind saved backend budget to the exact failed container")
    host = actual[0].get("HostConfig", {})
    if (host.get("Memory") != budget["memory_bytes"]
            or host.get("NanoCpus") != budget["cpus"] * 10**9
            or host.get("MemorySwap") != budget["memory_swap_bytes"]):
        _fail("Failed backend container no longer has the saved 128 GiB/16 CPU limits")
    return {"profile": profile, "profile_raw": raw, "receipt_raw": receipt_raw,
            "profile_sha256": _sha256(raw), "receipt_sha256": _sha256(receipt_raw),
            "budget": dict(budget), "receipt_path": relative}


def _verified_image_receipt(control, phase: str) -> dict[str, Any]:
    raw = _control_raw(control, phase + "/verified.json")
    if raw is None:
        _fail("Successful cached image receipt is missing: " + phase)
    receipt = _json_object(raw, "verified " + phase + " image receipt")
    attempt = receipt.get("attempt")
    if (receipt.get("schema") != "fullmag.docker-build-operation.v1"
            or receipt.get("phase") != phase or receipt.get("state") != "succeeded"
            or receipt.get("compose_project") != control.project
            or receipt.get("control_volume") != control.volume
            or not isinstance(attempt, str) or ATTEMPT_RE.fullmatch(attempt) is None
            or _control_raw(control, phase + "/attempts/" + attempt + "/terminal.json") != raw):
        _fail("Cached " + phase + " receipt is not an exact successful terminal")
    return receipt


def _reuse_prepared_images(selected: Path, control, helper_image: str,
                           expected_backend_id: str) -> dict[str, Any]:
    """Validate already-built immutable images without invoking any build route."""
    from bootstrap_docker_toolchain import tracked_input_files, read_input, input_files
    from docker_dev import BASE_CONTEXT_FILES, RUNTIME_IMAGE_CONTEXT_FILES

    configured = toolchain_configuration(selected, control.identity)
    service = configured["services"].get("fem-gpu-toolchain", {})
    build = service.get("build", {}) if isinstance(service, Mapping) else {}
    if (configured.get("name") != control.project
            or build.get("args", {}).get("FULLMAG_CUDA_BASE_IMAGE") != helper_image):
        _fail("Selected checkout's immutable toolchain configuration changed")
    manifest = [
        {"path": path.as_posix(), "sha256": _sha256(read_input(selected, path))}
        for path in tracked_input_files(selected)
    ]
    if {path.as_posix() for path in input_files(selected)} != {item["path"] for item in manifest}:
        _fail("Toolchain inputs changed or contain an untracked dependency during resume")
    toolchain_inputs = {
        "source_inputs": manifest,
        "build_args": build.get("args", {}),
        "target": build.get("target"),
    }
    toolchain = _verified_image_receipt(control, "toolchain")
    toolchain_id = toolchain.get("image_id")
    if (toolchain.get("inputs") != toolchain_inputs
            or toolchain.get("source_digest") != _sha256(canonical(toolchain_inputs))
            or not isinstance(toolchain_id, str) or IMAGE_RE.fullmatch(toolchain_id) is None):
        _fail("Cached toolchain receipt no longer matches its source inputs")
    rows = json.loads(docker_capture("image", "inspect", toolchain_id, timeout=60).stdout)
    if len(rows) != 1 or rows[0].get("Id") != toolchain_id:
        _fail("Cached toolchain image is no longer locally available by immutable ID")

    parent = toolchain_id
    images: dict[str, Any] = {}
    for kind, inventory in (("dev", BASE_CONTEXT_FILES),
                            ("backend", RUNTIME_IMAGE_CONTEXT_FILES)):
        names = sorted({relative for _, relative in inventory}
                       | {f"docker/all-in-one/Dockerfile.{kind}.dockerignore"})
        files = [
            {"path": name, "sha256": _sha256(read_input(selected, name))}
            for name in names
        ]
        expected_inputs = {"parent_image_id": parent, "files": files}
        receipt = _verified_image_receipt(control, "image-" + kind)
        image_id = receipt.get("image_id")
        digest = _sha256(canonical(expected_inputs))
        if (receipt.get("inputs") != expected_inputs
                or receipt.get("source_digest") != digest
                or not isinstance(image_id, str) or IMAGE_RE.fullmatch(image_id) is None):
            _fail("Cached image-" + kind + " receipt no longer matches its exact source inputs")
        rows = json.loads(docker_capture("image", "inspect", image_id, timeout=60).stdout)
        if len(rows) != 1 or rows[0].get("Id") != image_id:
            _fail("Cached image-" + kind + " image is no longer locally available by immutable ID")
        labels = rows[0].get("Config", {}).get("Labels", {})
        if (labels.get("org.fullmag.compose.project") != control.project
                or labels.get("org.fullmag.build.input-digest") != digest):
            _fail("Cached image-" + kind + " immutable source labels differ")
        images[kind] = receipt
        parent = image_id
    if images["backend"].get("image_id") != expected_backend_id:
        _fail("Failed maintenance attempt does not pin the verified cached backend image")
    return {"toolchain": toolchain, "images": images}


def _resume_cancel_unclaimed(args, selected, layout, identity, helper_image, control):
    """Resume only the observed failure before the first replacement container."""
    from docker_dev import _resolve_gpu_access, _verify_docker_gpu_access
    import docker_volume_dev as volume_dev

    resume_attempt = getattr(args, "resume_maintenance_attempt", None)
    if not isinstance(resume_attempt, str) or ATTEMPT_RE.fullmatch(resume_attempt) is None:
        _fail("--resume-maintenance-attempt must name one exact prior maintenance attempt")
    failed_root = "development/attempts/" + resume_attempt
    terminal_raw = _control_raw(control, failed_root + "/terminal.json")
    receipt_raw = _control_raw(control, failed_root + "/receipt.json")
    current_raw = _control_raw(control, "development/current.json")
    if terminal_raw is None or terminal_raw != receipt_raw or terminal_raw != current_raw:
        _fail("Resume requires the exact current terminal receipt for the pinned failed attempt")
    failed = _json_object(terminal_raw, "failed cancellation maintenance terminal")
    request_id = getattr(args, "request_id", None)
    if (not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None):
        _fail("--request-id must be a canonical nonzero UUID")
    try:
        if uuid.UUID(request_id).int == 0 or str(uuid.UUID(request_id)) != request_id:
            _fail("--request-id must be a canonical nonzero UUID")
    except ValueError as error:
        raise BuildControlError("--request-id must be a canonical nonzero UUID") from error
    expected_maintenance_shape = {
        "request_id": request_id,
        "request_sha256": None,
        "request_path": _request_path(request_id),
    }
    inputs = failed.get("inputs")
    maintenance = inputs.get("unclaimed_cancellation") if isinstance(inputs, Mapping) else None
    if (failed.get("schema") != "fullmag.docker-build-operation.v1"
            or failed.get("phase") != "development"
            or failed.get("state") != "failed-confirmed"
            or failed.get("attempt") != resume_attempt
            or failed.get("compose_project") != control.project
            or failed.get("control_volume") != control.volume
            or failed.get("helper_container") != "fullmag-control-" + resume_attempt
            or (control.namespace and failed.get("control_namespace") != control.namespace)
            or (control.namespace and failed.get("namespace_registry_sha256")
                != control.namespace_registry_sha256)
            or failed.get("error") != PRESTART_RESUME_ERROR
            or not isinstance(maintenance, Mapping)
            or set(maintenance) != {"request_id", "request_sha256", "request_path"}
            or maintenance.get("request_id") != expected_maintenance_shape["request_id"]
            or maintenance.get("request_path") != expected_maintenance_shape["request_path"]
            or not isinstance(maintenance.get("request_sha256"), str)
            or SHA256_RE.fullmatch(maintenance["request_sha256"]) is None
            or any(key in failed for key in (
                "backend_started_at", "backend_build_receipt_sha256",
                "unclaimed_cancellation_admission", "unclaimed_cancellation_result",
                "backend_container", "frontend_container",
            ))):
        _fail("Resume is limited to the exact failed pre-start cancellation boundary")

    before_raw = _control_raw(control, failed_root + "/unclaimed-cancellation-before.json")
    if before_raw is None:
        _fail("Failed maintenance attempt has no durable preflight evidence")
    before = _json_object(before_raw, "failed cancellation preflight evidence")
    if (before.get("schema") != "fullmag.docker-volume-unclaimed-cancellation-before.v1"
            or failed.get("unclaimed_cancellation_preflight") != before
            or canonical(before) + b"\n" != before_raw
            or before.get("request_id") != maintenance["request_id"]
            or before.get("request_sha256") != maintenance["request_sha256"]
            or before.get("prior_attempt") != args.attempt
            or before.get("prior_compose_sha256") != args.config_sha256):
        _fail("Failed maintenance preflight does not bind the original request and Compose pins")
    # Newer attempts persist these checkpoints. The current failed attempt
    # predates that addition, so its exact pre-start failure is instead bound
    # by the preserved preflight plus the authoritative absence checks below.
    stopped_checkpoint = _control_raw(
        control, failed_root + "/unclaimed-cancellation-stopped.json", optional=True
    )
    removed_checkpoint = _control_raw(
        control, failed_root + "/unclaimed-cancellation-removed.json", optional=True
    )
    if (stopped_checkpoint is None) != (removed_checkpoint is None):
        _fail("Maintenance stop/removal checkpoints are incomplete")

    previous_root = "development/attempts/" + args.attempt
    previous_raw = _control_raw(control, previous_root + "/terminal.json")
    document_raw = _control_raw(control, previous_root + "/compose.json")
    if previous_raw is None or document_raw is None:
        _fail("Original development terminal or Compose evidence is missing")
    previous = _json_object(previous_raw, "original development terminal")
    document = _json_object(document_raw, "original development Compose document")
    previous_inputs = previous.get("inputs")
    if (previous.get("state") not in {"succeeded", "failed-confirmed"}
            or previous.get("attempt") != args.attempt
            or previous.get("compose_project") != control.project
            or not isinstance(previous_inputs, Mapping)
            or previous_inputs.get("source_root") != str(selected)
            or previous_inputs.get("source_project_id") != identity.get("project_id")
            or previous_inputs.get("source_worktree_id") != identity.get("worktree_id")
            or previous_inputs.get("source_checkout_kind") != identity.get("checkout_kind")
            or _sha256(canonical(document)) != args.config_sha256
            or document.get("name") != control.project
            or set(document.get("services", {})) != {"backend", "frontend"}
            or before.get("prior_terminal_sha256") != _sha256(previous_raw)
            or before.get("prior_compose_sha256") != args.config_sha256):
        _fail("Original development terminal or Compose pins changed")
    frontend_ports = document.get("services", {}).get("frontend", {}).get("ports")
    if not isinstance(frontend_ports, list) or len(frontend_ports) != 1:
        _fail("Original frontend port is ambiguous")
    port = frontend_ports[0]
    if (not isinstance(port, Mapping) or port.get("host_ip") != "127.0.0.1"
            or port.get("target") != 8080 or port.get("protocol") != "tcp"
            or port.get("published") != str(args.port)):
        _fail("Resume port differs from the original Compose pin")

    state = storage.validate_path(
        Path(previous.get("state_root", "")), layout["runtime_root"],
        "retained Linux/Windows user state",
    )
    config_relative = RUNTIME_ROOT + "/runtime-service/docker-all.json"
    owner_relative = RUNTIME_ROOT + "/runtime-services/OWNER.json"
    process_relative = RUNTIME_ROOT + "/runtime-service/process-tree.json"
    config_raw = _control_raw(control, config_relative, maximum=256 * 1024)
    owner_raw = _control_raw(control, owner_relative, maximum=256 * 1024)
    process_raw = _control_raw(control, process_relative, maximum=MAX_CONTROL_BYTES)
    archived = {
        "prior-runtime-config.json": config_raw,
        "prior-runtime-owner.json": owner_raw,
        "prior-process-tree.json": process_raw,
    }
    for name, current in archived.items():
        raw = _control_raw(control, failed_root + "/" + name)
        if current is None or raw != current:
            _fail("Current native evidence changed from the failed-attempt archive: " + name)
    process = _json_object(process_raw, "current runtime process receipt")
    if (process.get("schema") != "fullmag.docker-process-tree.v1"
            or process.get("state") != "shutdown_unknown"
            or before.get("prior_runtime_config_sha256") != _sha256(config_raw)
            or before.get("prior_owner_sha256") != _sha256(owner_raw)
            or before.get("prior_process_receipt_sha256") != _sha256(process_raw)):
        _fail("Current native owner/config/process evidence differs from the original preflight")

    request_relative = REQUEST_ROOT + "/" + args.request_id + ".json"
    request_raw = _control_raw(control, request_relative, maximum=MAX_REQUEST_BYTES)
    if request_raw is None or _sha256(request_raw) != maintenance["request_sha256"]:
        _fail("Original immutable cancellation request is missing or changed")
    request, expected_request_raw, catalog_raw = _request_inputs(
        args, control, previous, document, state, owner_raw, config_raw
    )
    if expected_request_raw != request_raw:
        _fail("Resume arguments or current catalog differ from the original immutable request")
    if (before.get("prior_catalog_sha256") != _sha256(catalog_raw)
            or request.get("expected_catalog_sha256") != _sha256(catalog_raw)):
        _fail("Current accepted-run catalog differs from the original preflight pin")
    _assert_no_request_receipt(control, args.request_id)
    admission_relative = (
        "backend/runtime-service/unclaimed-cancellation/admissions/" + resume_attempt + ".json"
    )
    if _control_raw(control, admission_relative, optional=True, maximum=MAX_REQUEST_BYTES) is not None:
        _fail("Failed pre-start attempt already published a backend admission")

    services = (before.get("backend"), before.get("frontend"))
    pins = before.get("container_pins")
    if not isinstance(pins, list) or len(pins) != 2:
        _fail("Original preflight does not pin exactly two retained services")
    old_ids = {}
    old_image_id = previous_inputs.get("image_id")
    for service, summary, pin in zip(("backend", "frontend"), services, pins):
        if (not isinstance(summary, Mapping) or not isinstance(pin, Mapping)
                or summary.get("service") != service
                or summary.get("project") != control.project
                or summary.get("image_id") != old_image_id
                or pin.get("service") != service
                or pin.get("compose_project") != control.project
                or pin.get("image_id") != old_image_id
                or pin.get("container_id") != summary.get("container_id")
                or pin.get("private_pid_namespace") is not True
                or pin.get("host_pid") is not False
                or not isinstance(pin.get("config_sha256"), str)
                or SHA256_RE.fullmatch(pin["config_sha256"]) is None
                or not isinstance(pin.get("device_requests_sha256"), str)
                or SHA256_RE.fullmatch(pin["device_requests_sha256"]) is None):
            _fail("Original service preflight pin is malformed: " + service)
        identifier = summary.get("container_id")
        if not isinstance(identifier, str) or CONTAINER_RE.fullmatch(identifier) is None:
            _fail("Original service container identity is malformed: " + service)
        old_ids[service] = identifier
        _assert_removed(identifier, service)
    if (previous.get("backend_container") != old_ids["backend"]
            or previous.get("frontend_container") != old_ids["frontend"]
            or services[0].get("running") is not False
            or services[0].get("pid") != 0):
        _fail("Original stopped backend or exact container IDs differ from retained receipts")
    if _project_container_ids(control.project) or _volume_consumer_ids(control.volume):
        _fail("Compose project or control volume has consumers; maintenance resume is withheld")

    # Validate any newer stop/removal checkpoints and the exact Docker log
    # archives they bind. The original failed attempt has neither checkpoint.
    if stopped_checkpoint is not None:
        stopped = _json_object(stopped_checkpoint, "stopped cancellation checkpoint")
        removed = _json_object(removed_checkpoint, "removed cancellation checkpoint")
        expected_ids = {service: old_ids[service] for service in ("backend", "frontend")}
        if (stopped.get("schema") != "fullmag.docker-volume-unclaimed-cancellation-stopped.v1"
                or removed.get("schema") != "fullmag.docker-volume-unclaimed-cancellation-removed.v1"
                or canonical(stopped) + b"\n" != stopped_checkpoint
                or canonical(removed) + b"\n" != removed_checkpoint
                or failed.get("unclaimed_cancellation_stopped") != stopped
                or failed.get("unclaimed_cancellation_removed") != removed
                or stopped.get("request_id") != args.request_id
                or removed.get("request_id") != args.request_id
                or stopped.get("request_sha256") != maintenance["request_sha256"]
                or removed.get("request_sha256") != maintenance["request_sha256"]
                or stopped.get("preflight_sha256") != _sha256(before_raw)
                or removed.get("preflight_sha256") != _sha256(before_raw)
                or stopped.get("container_ids") != expected_ids
                or removed.get("container_ids") != expected_ids
                or removed.get("stopped_sha256") != _sha256(stopped_checkpoint)):
            _fail("Persisted stop/removal checkpoints do not bind the exact original containers")
        stopped_containers = stopped.get("containers")
        if not isinstance(stopped_containers, Mapping) or set(stopped_containers) != {"backend", "frontend"}:
            _fail("Stopped checkpoint has no exact two-service container observations")
        for service in ("backend", "frontend"):
            observation = stopped_containers[service]
            if (not isinstance(observation, Mapping)
                    or observation.get("container_id") != old_ids[service]
                    or observation.get("service") != service
                    or observation.get("project") != control.project
                    or observation.get("running") is not False
                    or observation.get("pid") != 0
                    or not isinstance(observation.get("finished_at"), str)
                    or not observation["finished_at"]):
                _fail("Stopped checkpoint differs from the exact exited service: " + service)
        log_hashes = stopped.get("docker_log_sha256")
        if not isinstance(log_hashes, Mapping) or set(log_hashes) != {"backend", "frontend"}:
            _fail("Stopped checkpoint has no bounded Docker log digests")
        for service in ("backend", "frontend"):
            log_raw = _control_raw(control, failed_root + "/" + service + "-docker-logs.txt",
                                   maximum=MAX_LOG_BYTES)
            if log_raw is None or _sha256(log_raw) != log_hashes.get(service):
                _fail("Bounded Docker log archive differs from stop evidence: " + service)

    policy = previous_inputs.get("gpu_access_requested")
    old_access = document.get("services", {}).get("backend", {}).get("environment", {}).get(
        "FULLMAG_DOCKER_DEVICE_ACCESS"
    )
    failed_inputs = failed.get("inputs")
    if (policy not in {"auto", "required", "disabled"} or old_access not in {"cpu", "gpu"}
            or previous_inputs.get("device_access") != old_access
            or not isinstance(failed_inputs, Mapping)
            or failed_inputs.get("source_root") != str(selected)
            or failed_inputs.get("gpu_access_requested") != policy
            or failed_inputs.get("device_access") != old_access):
        _fail("Failed maintenance and original runtime have different device-access pins")
    prepared = _reuse_prepared_images(
        selected, control, helper_image, failed_inputs.get("image_id")
    )
    backend_image = prepared["images"]["backend"].get("image_id")
    device_access = _verify_docker_gpu_access(
        _resolve_gpu_access(policy), policy, backend_image, control.project
    )
    if device_access != old_access:
        _fail("Current Docker device access differs from the retained service proof")

    certificate_path = volume_dev._certificate_path(state)
    certificate = volume_dev._retained_certificate(state, document)
    if certificate.get("image_id") != old_image_id:
        _fail("Retained session certificate differs from the original application image")
    operator_probe_record = volume_dev._operator_probe_record_from_retained(previous, document)
    operation_inputs = {
        "source_root": str(selected), "image_id": backend_image,
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "source_checkout_kind": identity["checkout_kind"],
        "gpu_access_requested": policy, "device_access": device_access,
        "gpu_preflight": "PASS" if device_access == "gpu" else "NOT_REQUIRED",
        **operator_probe_record, "unclaimed_cancellation": dict(maintenance),
    }
    args.profile = "dev"
    args.script = None
    args.image = None
    args.toolchain_image = None
    args.source_manifest = None
    args.gpu_access = policy
    retained_allowlist = set(volume_dev.include_untracked_from_compose(document))
    explicit_allowlist = set(volume_dev.normalize_include_untracked_paths(
        getattr(args, "include_untracked", None)
    ))
    args.include_untracked = volume_dev.normalize_include_untracked_paths(
        sorted(retained_allowlist | explicit_allowlist)
    )
    args.migrate_host_capacity = False
    args.fresh_state = False
    args.port_explicit = True
    if isinstance(args.port, bool) or not isinstance(args.port, int) or not 1 <= args.port <= 65535:
        _fail("--port must be the explicit original frontend port")

    with control.operation("development", operation_inputs) as operation:
        import docker_group_ledger as group_ledger
        operation["receipt"]["ledger_profile"] = (
            group_ledger.PROFILE
            if group_ledger.is_group_ledger_backend(
                document.get("services", {}).get("backend", {}).get("environment", {})
            ) else "host-ledger-v1"
        )
        helper_id = _operation_helper_id(control, operation)
        if (_project_container_ids(control.project) != {helper_id}
                or _volume_consumer_ids(control.volume) != {helper_id}):
            _fail("A group or control-volume consumer appeared before resumed start")
        for identifier, service in ((old_ids["backend"], "backend"),
                                    (old_ids["frontend"], "frontend")):
            _assert_removed(identifier, service)
        if (_control_raw(control, config_relative, maximum=256 * 1024) != config_raw
                or _control_raw(control, owner_relative, maximum=256 * 1024) != owner_raw
                or _control_raw(control, process_relative, maximum=MAX_CONTROL_BYTES) != process_raw):
            _fail("Native configuration, owner, or process receipt changed under the operation lease")
        current_request = _control_raw(control, request_relative, maximum=MAX_REQUEST_BYTES)
        if current_request != request_raw:
            _fail("Immutable cancellation request changed under the operation lease")
        request, expected_request_raw, current_catalog_raw = _request_inputs(
            args, control, previous, document, state, owner_raw, config_raw
        )
        if (expected_request_raw != request_raw or current_catalog_raw != catalog_raw
                or _control_raw(control, admission_relative, optional=True,
                                maximum=MAX_REQUEST_BYTES) is not None):
            _fail("Cancellation request, accepted catalog, or admission changed under the operation lease")
        operation["receipt"]["unclaimed_cancellation_preflight"] = before
        operation["receipt"]["unclaimed_cancellation_resume"] = {
            "failed_attempt": resume_attempt,
            "failed_terminal_sha256": _sha256(terminal_raw),
            "preflight_sha256": _sha256(before_raw),
        }
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        host = volume_dev._session_host()
        reuse = {
            "state": state, "host_certificate": certificate_path,
            "owner_marker": state / host.OWNER_NAME,
            "receipt": {"image_id": old_image_id},
            "operator_probe_environment_record": operator_probe_record,
        }
        volume_dev.start(
            args, reuse_state=reuse, control=control, operation=operation,
            prepared=prepared, maintenance=dict(maintenance),
        )
    result = operation["receipt"].get("unclaimed_cancellation_result")
    native_result = result.get("native_result") if isinstance(result, Mapping) else None
    if (not isinstance(result, Mapping) or result.get("state") != "cancelled"
            or not isinstance(native_result, Mapping)
            or native_result.get("disposition") != "cancelled"
            or native_result.get("request_id") != args.request_id):
        _fail("Resumed maintenance did not publish a completed cancellation result")
    print(json.dumps(dict(result), ensure_ascii=False, sort_keys=True))
    return dict(result)


def _resume_native_cancellation_failure(args, selected, layout, identity, helper_image, control):
    """Continue one exact native-start failure before cancellation publication."""
    from docker_dev import _resolve_gpu_access, _verify_docker_gpu_access
    import docker_volume_dev as volume_dev
    from docker_compose_identity import validate_source_labels

    failed_attempt = getattr(args, "resume_native_failure_attempt", None)
    failed_backend_id = getattr(args, "failed_backend_container_id", None)
    if not isinstance(failed_attempt, str) or ATTEMPT_RE.fullmatch(failed_attempt) is None:
        _fail("--resume-native-failure-attempt must name one exact prior maintenance attempt")
    if not isinstance(failed_backend_id, str) or CONTAINER_RE.fullmatch(failed_backend_id) is None:
        _fail("--failed-backend-container-id must be one full immutable container ID")

    failed_root = "development/attempts/" + failed_attempt
    terminal_raw = _control_raw(control, failed_root + "/terminal.json")
    receipt_raw = _control_raw(control, failed_root + "/receipt.json")
    current_raw = _control_raw(control, "development/current.json")
    if terminal_raw is None or terminal_raw != receipt_raw or terminal_raw != current_raw:
        _fail("Native-failure continuation requires the exact current terminal receipt")
    failed = _json_object(terminal_raw, "failed native cancellation terminal")

    request_id = getattr(args, "request_id", None)
    if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
        _fail("--request-id must be a canonical nonzero UUID")
    try:
        if uuid.UUID(request_id).int == 0 or str(uuid.UUID(request_id)) != request_id:
            _fail("--request-id must be a canonical nonzero UUID")
    except ValueError as error:
        raise BuildControlError("--request-id must be a canonical nonzero UUID") from error

    failed_inputs = failed.get("inputs")
    maintenance = failed_inputs.get("unclaimed_cancellation") if isinstance(failed_inputs, Mapping) else None
    failed_error = failed.get("error")
    native_failure_error = (
        failed_error == NATIVE_FAILURE_RESUME_ERROR
        or (isinstance(failed_error, str)
            and failed_error.startswith(
                NATIVE_FAILURE_RESUME_ERROR + "; exit=1; oom=False; native failure: "
            ))
    )
    if (failed.get("schema") != "fullmag.docker-build-operation.v1"
            or failed.get("phase") != "development"
            or failed.get("state") != "failed-confirmed"
            or failed.get("attempt") != failed_attempt
            or failed.get("compose_project") != control.project
            or failed.get("control_volume") != control.volume
            or failed.get("helper_container") != "fullmag-control-" + failed_attempt
            or (control.namespace and failed.get("control_namespace") != control.namespace)
            or (control.namespace and failed.get("namespace_registry_sha256")
                != control.namespace_registry_sha256)
            or not native_failure_error
            or not isinstance(maintenance, Mapping)
            or set(maintenance) != {"request_id", "request_sha256", "request_path"}
            or maintenance.get("request_id") != request_id
            or maintenance.get("request_path") != _request_path(request_id)
            or not isinstance(maintenance.get("request_sha256"), str)
            or SHA256_RE.fullmatch(maintenance["request_sha256"]) is None
            or failed.get("backend_container") != failed_backend_id
            or "unclaimed_cancellation_result" in failed
            or not isinstance(failed.get("backend_started_at"), str)
            or not failed.get("backend_started_at")
            or not isinstance(failed.get("backend_build_receipt_sha256"), str)
            or SHA256_RE.fullmatch(failed["backend_build_receipt_sha256"]) is None):
        _fail("Continuation is limited to the exact native cancellation failure boundary")

    for relative in (
        failed_root + "/unclaimed-cancellation-terminal.json",
        failed_root + "/unclaimed-cancellation-receipt.json",
    ):
        if _control_raw(control, relative, optional=True, maximum=256 * 1024) is not None:
            _fail("Failed attempt already has cancellation terminal evidence; inspect it instead of replaying")

    resume_link = failed.get("unclaimed_cancellation_resume")
    if (not isinstance(resume_link, Mapping)
            or set(resume_link) != {"failed_attempt", "failed_terminal_sha256", "preflight_sha256"}
            or not isinstance(resume_link.get("failed_attempt"), str)
            or ATTEMPT_RE.fullmatch(resume_link["failed_attempt"]) is None
            or resume_link["failed_attempt"] == failed_attempt
            or not isinstance(resume_link.get("failed_terminal_sha256"), str)
            or SHA256_RE.fullmatch(resume_link["failed_terminal_sha256"]) is None
            or not isinstance(resume_link.get("preflight_sha256"), str)
            or SHA256_RE.fullmatch(resume_link["preflight_sha256"]) is None):
        _fail("Native-failure attempt does not pin its original pre-start archive")
    prestart_root = "development/attempts/" + resume_link["failed_attempt"]
    prestart_terminal_raw = _control_raw(control, prestart_root + "/terminal.json")
    prestart_receipt_raw = _control_raw(control, prestart_root + "/receipt.json")
    before_raw = _control_raw(control, prestart_root + "/unclaimed-cancellation-before.json")
    if (prestart_terminal_raw is None or prestart_terminal_raw != prestart_receipt_raw
            or _sha256(prestart_terminal_raw) != resume_link["failed_terminal_sha256"]
            or before_raw is None or _sha256(before_raw) != resume_link["preflight_sha256"]):
        _fail("Native-failure attempt's linked pre-start archive is missing or changed")
    prestart = _json_object(prestart_terminal_raw, "original pre-start cancellation terminal")
    before = _json_object(before_raw, "native cancellation preflight evidence")
    prestart_inputs = prestart.get("inputs")
    if (prestart.get("schema") != "fullmag.docker-build-operation.v1"
            or prestart.get("phase") != "development"
            or prestart.get("state") != "failed-confirmed"
            or prestart.get("attempt") != resume_link["failed_attempt"]
            or prestart.get("compose_project") != control.project
            or prestart.get("control_volume") != control.volume
            or prestart.get("helper_container") != "fullmag-control-" + resume_link["failed_attempt"]
            or (control.namespace and prestart.get("control_namespace") != control.namespace)
            or (control.namespace and prestart.get("namespace_registry_sha256")
                != control.namespace_registry_sha256)
            or prestart.get("error") != PRESTART_RESUME_ERROR
            or not isinstance(prestart_inputs, Mapping)
            or prestart_inputs.get("unclaimed_cancellation") != maintenance
            or any(key in prestart for key in (
                "backend_started_at", "backend_build_receipt_sha256",
                "unclaimed_cancellation_admission", "unclaimed_cancellation_result",
                "backend_container", "frontend_container",
            ))
            or before.get("schema") != "fullmag.docker-volume-unclaimed-cancellation-before.v1"
            or prestart.get("unclaimed_cancellation_preflight") != before
            or failed.get("unclaimed_cancellation_preflight") != before
            or canonical(before) + b"\n" != before_raw
            or before.get("request_id") != request_id
            or before.get("request_sha256") != maintenance["request_sha256"]
            or before.get("prior_attempt") != args.attempt
            or before.get("prior_compose_sha256") != args.config_sha256):
        _fail("Native-failure preflight does not bind the original request and Compose pins")

    previous_root = "development/attempts/" + args.attempt
    previous_raw = _control_raw(control, previous_root + "/terminal.json")
    document_raw = _control_raw(control, previous_root + "/compose.json")
    if previous_raw is None or document_raw is None:
        _fail("Original development terminal or Compose evidence is missing")
    previous = _json_object(previous_raw, "original development terminal")
    document = _json_object(document_raw, "original development Compose document")
    previous_inputs = previous.get("inputs")
    if (previous.get("state") not in {"succeeded", "failed-confirmed"}
            or previous.get("attempt") != args.attempt
            or previous.get("compose_project") != control.project
            or not isinstance(previous_inputs, Mapping)
            or previous_inputs.get("source_root") != str(selected)
            or previous_inputs.get("source_project_id") != identity.get("project_id")
            or previous_inputs.get("source_worktree_id") != identity.get("worktree_id")
            or previous_inputs.get("source_checkout_kind") != identity.get("checkout_kind")
            or _sha256(canonical(document)) != args.config_sha256
            or document.get("name") != control.project
            or set(document.get("services", {})) != {"backend", "frontend"}
            or before.get("prior_terminal_sha256") != _sha256(previous_raw)
            or before.get("prior_compose_sha256") != args.config_sha256):
        _fail("Original development terminal or Compose pins changed")
    frontend_ports = document.get("services", {}).get("frontend", {}).get("ports")
    if not isinstance(frontend_ports, list) or len(frontend_ports) != 1:
        _fail("Original frontend port is ambiguous")
    port = frontend_ports[0]
    if (not isinstance(port, Mapping) or port.get("host_ip") != "127.0.0.1"
            or port.get("target") != 8080 or port.get("protocol") != "tcp"
            or port.get("published") != str(args.port)):
        _fail("Continuation port differs from the original Compose pin")

    state = storage.validate_path(
        Path(previous.get("state_root", "")), layout["runtime_root"],
        "retained Linux/Windows user state",
    )
    if failed.get("state_root") != str(state):
        _fail("Failed native attempt was not built against the retained state root")
    config_relative = RUNTIME_ROOT + "/runtime-service/docker-all.json"
    owner_relative = RUNTIME_ROOT + "/runtime-services/OWNER.json"
    process_relative = RUNTIME_ROOT + "/runtime-service/process-tree.json"
    config_raw = _control_raw(control, config_relative, maximum=256 * 1024)
    owner_raw = _control_raw(control, owner_relative, maximum=256 * 1024)
    process_raw = _control_raw(control, process_relative, maximum=MAX_CONTROL_BYTES)
    prior_runtime_evidence = {}
    for name, current in (
        ("prior-runtime-config.json", config_raw),
        ("prior-runtime-owner.json", owner_raw),
        ("prior-process-tree.json", process_raw),
    ):
        archived = _control_raw(control, prestart_root + "/" + name)
        if current is None or archived != current:
            _fail("Current native evidence changed from the failed-attempt archive: " + name)
        prior_runtime_evidence[name] = archived
    process = _json_object(process_raw, "current runtime process receipt")
    if (process.get("schema") != "fullmag.docker-process-tree.v1"
            or process.get("state") != "shutdown_unknown"
            or before.get("prior_runtime_config_sha256") != _sha256(config_raw)
            or before.get("prior_owner_sha256") != _sha256(owner_raw)
            or before.get("prior_process_receipt_sha256") != _sha256(process_raw)):
        _fail("Current native owner/config/process evidence differs from the original preflight")

    request_relative = REQUEST_ROOT + "/" + request_id + ".json"
    request_raw = _control_raw(control, request_relative, maximum=MAX_REQUEST_BYTES)
    if request_raw is None or _sha256(request_raw) != maintenance["request_sha256"]:
        _fail("Original immutable cancellation request is missing or changed")
    request, expected_request_raw, catalog_raw = _request_inputs(
        args, control, previous, document, state, owner_raw, config_raw
    )
    if (expected_request_raw != request_raw
            or before.get("prior_catalog_sha256") != _sha256(catalog_raw)
            or request.get("expected_catalog_sha256") != _sha256(catalog_raw)):
        _fail("Cancellation request, current owner, or accepted catalog differs from its original pin")
    _assert_no_request_receipt(control, request_id)
    _assert_no_task_cancellation_intent(state, request["run_id"], request["task_id"])

    admission_relative = (
        "backend/runtime-service/unclaimed-cancellation/admissions/" + failed_attempt + ".json"
    )
    admission_raw = _control_raw(control, admission_relative, maximum=MAX_REQUEST_BYTES)
    if admission_raw is None:
        _fail("Failed native attempt has no exact host admission receipt")
    admission = _json_object(admission_raw, "failed native cancellation admission")
    if (set(admission) != {
                "schema", "attempt", "request_id", "request_sha256", "backend_container_id",
                "backend_started_at", "backend_build_receipt_sha256",
            }
            or admission.get("schema") != "fullmag.docker-runtime-unclaimed-cancellation-admission.v1"
            or admission.get("attempt") != failed_attempt
            or admission.get("request_id") != request_id
            or admission.get("request_sha256") != maintenance["request_sha256"]
            or admission.get("backend_container_id") != failed_backend_id
            or admission.get("backend_started_at") != failed.get("backend_started_at")
            or admission.get("backend_build_receipt_sha256") != failed.get("backend_build_receipt_sha256")
            or failed.get("unclaimed_cancellation_admission") != admission):
        _fail("Failed native admission does not bind the exact backend, request, and package")

    failed_document_raw = _control_raw(control, failed_root + "/compose.json")
    if failed_document_raw is None:
        _fail("Failed native attempt has no rendered Compose document")
    failed_document = _json_object(failed_document_raw, "failed maintenance Compose document")
    failed_environment = failed_document.get("services", {}).get("backend", {}).get("environment", {})
    if (failed.get("config_sha256") != _sha256(canonical(failed_document))
            or failed_document.get("name") != control.project
            or set(failed_document.get("services", {})) != {"backend", "frontend"}
            or failed_environment.get("FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_REQUEST")
                != maintenance["request_path"]
            or failed_environment.get("FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_REQUEST_SHA256")
                != maintenance["request_sha256"]
            or failed_environment.get("FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_ATTEMPT") != failed_attempt
            or failed_environment.get("FULLMAG_STARTUP_ENABLED", "0") == "1"
            or failed_environment.get("FULLMAG_ACCEPTED_REATTACH_REQUEST") is not None):
        _fail("Failed Compose document does not prove cancellation-only startup")

    saved_budget = _saved_backend_budget(control, failed_backend_id, failed_document)

    build_receipt_raw = _control_raw(control, failed_root + "/backend-build-receipt.json")
    provenance_raw = _control_raw(control, failed_root + "/provenance.json")
    if build_receipt_raw is None or provenance_raw is None:
        _fail("Failed attempt has no durable successful package publication evidence")
    build_receipt = _json_object(build_receipt_raw, "failed attempt backend build receipt")
    provenance = _json_object(provenance_raw, "failed attempt backend provenance")
    # _finish archives the parsed receipt through BuildControl.write, which
    # canonical-reserializes it; the package's raw-file digest is instead
    # carried unchanged by provenance and the host admission.
    if (build_receipt.get("schema") != "fullmag.direct-compose.backend-build-receipt.v1"
            or build_receipt.get("state") != "succeeded"
            or provenance.get("schema") != "fullmag.docker-all-image.v1"
            or provenance.get("state") != "succeeded"
            or provenance.get("build_receipt_sha256") != failed.get("backend_build_receipt_sha256")
            or provenance.get("build_receipt_sha256") != admission["backend_build_receipt_sha256"]):
        _fail("Failed attempt package receipt does not match its immutable admission")

    old_services = (before.get("backend"), before.get("frontend"))
    old_pins = before.get("container_pins")
    if not isinstance(old_pins, list) or len(old_pins) != 2:
        _fail("Original preflight does not pin exactly two prior services")
    old_ids = {}
    old_image_id = previous_inputs.get("image_id")
    for service, summary, pin in zip(("backend", "frontend"), old_services, old_pins):
        if (not isinstance(summary, Mapping) or not isinstance(pin, Mapping)
                or summary.get("service") != service or summary.get("project") != control.project
                or summary.get("image_id") != old_image_id
                or pin.get("service") != service or pin.get("compose_project") != control.project
                or pin.get("image_id") != old_image_id
                or pin.get("container_id") != summary.get("container_id")
                or pin.get("private_pid_namespace") is not True or pin.get("host_pid") is not False
                or not isinstance(pin.get("config_sha256"), str)
                or SHA256_RE.fullmatch(pin["config_sha256"]) is None
                or not isinstance(pin.get("device_requests_sha256"), str)
                or SHA256_RE.fullmatch(pin["device_requests_sha256"]) is None):
            _fail("Original service preflight pin is malformed: " + service)
        identifier = summary.get("container_id")
        if not isinstance(identifier, str) or CONTAINER_RE.fullmatch(identifier) is None:
            _fail("Original service container identity is malformed: " + service)
        old_ids[service] = identifier
        _assert_removed(identifier, service)
    if (previous.get("backend_container") != old_ids["backend"]
            or previous.get("frontend_container") != old_ids["frontend"]
            or old_ids["backend"] == failed_backend_id):
        _fail("Original service absence pins overlap the failed maintenance backend")

    failed_frontend_id = failed.get("frontend_container")
    if (not isinstance(failed_frontend_id, str) or CONTAINER_RE.fullmatch(failed_frontend_id) is None
            or failed_frontend_id == failed_backend_id
            or failed_frontend_id in old_ids.values()):
        _fail("Failed maintenance attempt has no distinct exact frontend identity")
    failed_inputs = failed["inputs"]
    old_access = document.get("services", {}).get("backend", {}).get("environment", {}).get(
        "FULLMAG_DOCKER_DEVICE_ACCESS"
    )
    policy = previous_inputs.get("gpu_access_requested")
    if (policy not in {"auto", "required", "disabled"} or old_access not in {"cpu", "gpu"}
            or previous_inputs.get("device_access") != old_access
            or failed_inputs.get("source_root") != str(selected)
            or failed_inputs.get("gpu_access_requested") != policy
            or failed_inputs.get("device_access") != old_access):
        _fail("Failed maintenance and original runtime have different device-access pins")

    failed_image_id = failed_inputs.get("image_id")
    if not isinstance(failed_image_id, str) or IMAGE_RE.fullmatch(failed_image_id) is None:
        _fail("Failed native attempt does not pin its immutable backend image")
    # The native recovery sources may have changed after this failed start.
    # Re-resolve and build through the selected Compose group before acquiring
    # its lifecycle lease; validate the failed containers against their old
    # image below, then pass this current image context to the managed start.
    toolchain = build_volume_toolchain(selected)
    toolchain_helper = toolchain.get("inputs", {}).get("build_args", {}).get(
        "FULLMAG_CUDA_BASE_IMAGE"
    )
    if toolchain_helper != helper_image:
        _fail("Current managed toolchain helper differs from the selected control image")
    images_control = BuildControl(identity, toolchain_helper)
    images = build_volume_runtime_images(selected, images_control, toolchain)
    from docker_volume_container_recovery import _prepared_context
    prepared = _prepared_context(toolchain, images)
    backend_image = prepared["images"]["backend"]["image_id"]
    from docker_dev import _resolve_gpu_access
    device_access = _verify_docker_gpu_access(
        _resolve_gpu_access(policy), policy, backend_image, control.project
    )
    if device_access != old_access:
        _fail("Current Docker device access differs from the retained service proof")

    certificate_path = volume_dev._certificate_path(state)
    certificate = volume_dev._retained_certificate(state, failed_document)
    if certificate.get("image_id") != failed_image_id:
        _fail("Retained session certificate differs from the admitted maintenance image")
    operator_probe_record = volume_dev._operator_probe_record_from_retained(previous, document)
    operation_inputs = {
        "source_root": str(selected), "image_id": backend_image,
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "source_checkout_kind": identity["checkout_kind"],
        "gpu_access_requested": policy, "device_access": device_access,
        "gpu_preflight": "PASS" if device_access == "gpu" else "NOT_REQUIRED",
        **operator_probe_record, "unclaimed_cancellation": dict(maintenance),
    }
    args.profile = "dev"
    args.script = None
    args.image = None
    args.toolchain_image = None
    args.source_manifest = None
    args.gpu_access = policy
    retained_allowlist = set(volume_dev.include_untracked_from_compose(document))
    explicit_allowlist = set(volume_dev.normalize_include_untracked_paths(
        getattr(args, "include_untracked", None)
    ))
    args.include_untracked = volume_dev.normalize_include_untracked_paths(
        sorted(retained_allowlist | explicit_allowlist)
    )
    args.migrate_host_capacity = False
    args.fresh_state = False
    args.port_explicit = True
    if isinstance(args.port, bool) or not isinstance(args.port, int) or not 1 <= args.port <= 65535:
        _fail("--port must be the explicit original frontend port")

    with control.operation("development", operation_inputs) as operation:
        import docker_group_ledger as group_ledger
        operation["receipt"]["ledger_profile"] = (
            group_ledger.PROFILE if group_ledger.is_group_ledger_backend(
                document.get("services", {}).get("backend", {}).get("environment", {})
            ) else "host-ledger-v1"
        )
        helper_id = _operation_helper_id(control, operation)
        current_ids = {"backend": failed_backend_id, "frontend": failed_frontend_id}
        expected_consumers = set(current_ids.values()) | {helper_id}
        if (_project_container_ids(control.project) != expected_consumers
                or _volume_consumer_ids(control.volume) != expected_consumers):
            _fail("Project or control-volume consumers differ from the exact failed service pair")

        current_config_raw = _control_raw(control, config_relative, maximum=256 * 1024)
        current_owner_raw = _control_raw(control, owner_relative, maximum=256 * 1024)
        current_process_raw = _control_raw(control, process_relative, maximum=MAX_CONTROL_BYTES)
        current_request_raw = _control_raw(control, request_relative, maximum=MAX_REQUEST_BYTES)
        if (current_config_raw != config_raw or current_owner_raw != owner_raw
                or current_process_raw != process_raw or current_request_raw != request_raw):
            _fail("Native configuration, owner, process receipt, or request changed under the lease")
        _, current_request, current_catalog_raw = _request_inputs(
            args, control, previous, document, state, owner_raw, config_raw
        )
        if (current_request != request_raw or current_catalog_raw != catalog_raw
                or _control_raw(control, admission_relative, maximum=MAX_REQUEST_BYTES) != admission_raw):
            _fail("Request, catalog, or failed admission changed under the operation lease")
        _assert_no_request_receipt(control, request_id)
        _assert_no_task_cancellation_intent(state, request["run_id"], request["task_id"])
        leased_budget = _saved_backend_budget(control, failed_backend_id, failed_document)
        if (leased_budget["profile_sha256"] != saved_budget["profile_sha256"]
                or leased_budget["receipt_sha256"] != saved_budget["receipt_sha256"]):
            _fail("Saved 128 GiB/16 CPU budget changed under the operation lease")

        actual = {}
        image_rows = json.loads(docker_capture("image", "inspect", failed_image_id, timeout=60).stdout)
        if len(image_rows) != 1 or image_rows[0].get("Id") != failed_image_id:
            _fail("Failed maintenance image identity is ambiguous")
        image_config = image_rows[0].get("Config")
        for service, identifier in current_ids.items():
            rows = json.loads(docker_capture("inspect", identifier, timeout=60).stdout)
            if len(rows) != 1 or rows[0].get("Id") != identifier:
                _fail("Failed maintenance service identity is ambiguous: " + service)
            row = actual[service] = rows[0]
            labels = row.get("Config", {}).get("Labels", {})
            if (row.get("Image") != failed_image_id
                    or labels.get("com.docker.compose.project") != control.project
                    or labels.get("com.docker.compose.service") != service):
                _fail("Failed maintenance service belongs to another image or Compose identity")
            validate_source_labels(row, identity)
            volume_dev._validate_retained_service(
                failed_document, row, service, image_config,
                expected_started_at=admission["backend_started_at"] if service == "backend" else None,
            )
        backend_state = actual["backend"].get("State", {})
        if (actual["backend"].get("Id") != failed_backend_id
                or backend_state.get("Running") is not False or backend_state.get("Pid") != 0
                or backend_state.get("ExitCode") != 1 or backend_state.get("OOMKilled") is not False
                or not isinstance(backend_state.get("FinishedAt"), str)
                or not backend_state.get("FinishedAt")):
            _fail("Pinned failed backend is not the exact stopped exit-1 maintenance container")
        networks = actual["backend"].get("NetworkSettings", {}).get("Networks", {})
        frontend_networks = actual["frontend"].get("NetworkSettings", {}).get("Networks", {})
        if (len(networks) != 1 or set(networks) != set(frontend_networks)
                or next(iter(networks)) != identity.get("network_name")):
            _fail("Failed services do not share exactly the selected private group bridge")
        volume_dev._assert_private_restart_network(actual, current_ids, control.project)

        docker_logs = {}
        docker_log_sha256 = {}
        for service, identifier in current_ids.items():
            captured = docker_capture("logs", "--tail", "500", identifier, timeout=60)
            data = bytes(captured.stdout) + bytes(captured.stderr)
            if len(data) > MAX_LOG_BYTES:
                _fail("Failed " + service + " Docker log tail exceeds its preservation bound")
            docker_logs[service] = data
            docker_log_sha256[service] = _sha256(data)
        backend_log = docker_logs["backend"].decode("utf-8", "replace")
        if NATIVE_FAILURE_LOG_MARKER not in backend_log:
            _fail("Failed backend logs do not contain the pinned native generation mismatch")

        operation["receipt"]["unclaimed_cancellation_preflight"] = before
        operation["receipt"]["unclaimed_cancellation_native_failure_resume"] = {
            "failed_attempt": failed_attempt,
            "failed_terminal_sha256": _sha256(terminal_raw),
            "failed_backend_container_id": failed_backend_id,
            "failed_backend_started_at": admission["backend_started_at"],
            "admission_sha256": _sha256(admission_raw),
            "prestart_archive": {
                "attempt": resume_link["failed_attempt"],
                "terminal_sha256": _sha256(prestart_terminal_raw),
                "preflight_sha256": _sha256(before_raw),
                "prior_runtime_config_sha256": _sha256(
                    prior_runtime_evidence["prior-runtime-config.json"]
                ),
                "prior_runtime_owner_sha256": _sha256(
                    prior_runtime_evidence["prior-runtime-owner.json"]
                ),
                "prior_process_tree_sha256": _sha256(
                    prior_runtime_evidence["prior-process-tree.json"]
                ),
            },
            "request_id": request_id,
            "request_sha256": maintenance["request_sha256"],
            "catalog_sha256": _sha256(catalog_raw),
            "resource_budget": {
                "profile_sha256": saved_budget["profile_sha256"],
                "receipt_sha256": saved_budget["receipt_sha256"],
                "receipt_path": saved_budget["receipt_path"],
                "budget": saved_budget["budget"],
            },
        }
        control.write_bytes(operation["root"] + "/failed-native-terminal.json", terminal_raw)
        control.write_bytes(operation["root"] + "/unclaimed-cancellation-prestart-terminal.json",
                            prestart_terminal_raw)
        control.write_bytes(operation["root"] + "/unclaimed-cancellation-before.json", before_raw)
        control.write_bytes(operation["root"] + "/prior-runtime-config.json",
                            prior_runtime_evidence["prior-runtime-config.json"])
        control.write_bytes(operation["root"] + "/prior-runtime-owner.json",
                            prior_runtime_evidence["prior-runtime-owner.json"])
        control.write_bytes(operation["root"] + "/prior-process-tree.json",
                            prior_runtime_evidence["prior-process-tree.json"])
        control.write_bytes(operation["root"] + "/failed-native-compose.json", failed_document_raw)
        control.write_bytes(operation["root"] + "/failed-native-backend-build-receipt.json", build_receipt_raw)
        control.write_bytes(operation["root"] + "/failed-native-provenance.json", provenance_raw)
        control.write_bytes(operation["root"] + "/failed-native-admission.json", admission_raw)
        control.write_bytes(operation["root"] + "/failed-native-request.json", request_raw)
        control.write_bytes(operation["root"] + "/failed-native-catalog.json", catalog_raw)
        control.write_bytes(operation["root"] + "/failed-native-runtime-config.json", config_raw)
        control.write_bytes(operation["root"] + "/failed-native-owner.json", owner_raw)
        control.write_bytes(operation["root"] + "/failed-native-process-tree.json", process_raw)
        control.write_bytes(operation["root"] + "/failed-native-resource-budget.json",
                            saved_budget["profile_raw"])
        control.write_bytes(operation["root"] + "/failed-native-resource-budget-receipt.json",
                            saved_budget["receipt_raw"])
        for service, data in docker_logs.items():
            control.write_bytes(operation["root"] + "/failed-native-" + service + "-docker-logs.txt", data)
        control.write(operation["root"] + "/failed-native-container-inspect.json", {
            "backend": _safe_inspect_summary(actual["backend"]),
            "frontend": _safe_inspect_summary(actual["frontend"]),
            "docker_log_sha256": docker_log_sha256,
        })
        control.write(operation["root"] + "/receipt.json", operation["receipt"])

        operation["receipt"].update(state="stopping-failed-cancellation-frontend")
        operation["daemon_pending"] = True
        if actual["frontend"].get("State", {}).get("Running") is True:
            docker_capture("stop", "--time", "60", failed_frontend_id, timeout=90)
        operation["daemon_pending"] = False
        stopped = {}
        for service, identifier in current_ids.items():
            rows = json.loads(docker_capture("inspect", identifier, timeout=60).stdout)
            if len(rows) != 1 or rows[0].get("Id") != identifier:
                _fail("Failed service inspect became ambiguous after stop: " + service)
            stopped[service] = rows[0]
            _assert_container_unchanged(actual[service], rows[0], service, stopped=True)
        _assert_private_network_after_stop(stopped, current_ids, control.project, identity)
        stopped_record = {
            "schema": "fullmag.docker-volume-unclaimed-cancellation-native-failure-stopped.v1",
            "failed_attempt": failed_attempt,
            "failed_terminal_sha256": _sha256(terminal_raw),
            "request_id": request_id,
            "request_sha256": maintenance["request_sha256"],
            "container_ids": dict(current_ids),
            "containers": {service: _safe_inspect_summary(stopped[service]) for service in current_ids},
            "docker_log_sha256": docker_log_sha256,
        }
        stopped_raw = canonical(stopped_record) + b"\n"
        control.write_bytes(operation["root"] + "/failed-native-stopped.json", stopped_raw)
        operation["receipt"]["unclaimed_cancellation_native_failure_stopped"] = stopped_record
        control.write(operation["root"] + "/receipt.json", operation["receipt"])

        operation["receipt"].update(state="removing-exact-failed-cancellation-services")
        operation["daemon_pending"] = True
        docker_capture("rm", failed_backend_id, failed_frontend_id, timeout=90)
        operation["daemon_pending"] = False
        for service, identifier in current_ids.items():
            _assert_removed(identifier, service)
        if (_project_container_ids(control.project) != {helper_id}
                or _volume_consumer_ids(control.volume) != {helper_id}):
            _fail("Project or control volume has consumers beyond the active operation helper")
        removed_record = {
            "schema": "fullmag.docker-volume-unclaimed-cancellation-native-failure-removed.v1",
            "failed_attempt": failed_attempt,
            "failed_terminal_sha256": _sha256(terminal_raw),
            "request_id": request_id,
            "request_sha256": maintenance["request_sha256"],
            "container_ids": dict(current_ids),
            "stopped_sha256": _sha256(stopped_raw),
            "helper_container_id": helper_id,
        }
        control.write(operation["root"] + "/failed-native-removed.json", removed_record)
        operation["receipt"]["unclaimed_cancellation_native_failure_removed"] = removed_record
        control.write(operation["root"] + "/receipt.json", operation["receipt"])

        host = volume_dev._session_host()
        reuse = {
            "state": state,
            "host_certificate": certificate_path,
            "owner_marker": state / host.OWNER_NAME,
            "receipt": {"image_id": failed_image_id},
            "operator_probe_environment_record": operator_probe_record,
        }
        volume_dev.start(
            args, reuse_state=reuse, control=control, operation=operation,
            prepared=prepared, maintenance=dict(maintenance),
        )

    result = operation["receipt"].get("unclaimed_cancellation_result")
    native_result = result.get("native_result") if isinstance(result, Mapping) else None
    if (not isinstance(result, Mapping) or result.get("state") != "cancelled"
            or not isinstance(native_result, Mapping)
            or native_result.get("disposition") != "cancelled"
            or native_result.get("request_id") != request_id):
        _fail("Native-failure continuation did not publish a completed cancellation result")
    print(json.dumps(dict(result), ensure_ascii=False, sort_keys=True))
    return dict(result)


def cancel_unclaimed(args) -> dict[str, Any]:
    """Cancel one explicitly named unclaimed run task without starting its API."""
    from docker_dev import (
        _compose_identity,
        _resolve_gpu_access,
        _select_source,
        _verify_docker_gpu_access,
    )
    import docker_volume_dev as volume_dev

    require_host()
    if not re.fullmatch(r"[0-9a-f]{32}", str(getattr(args, "attempt", ""))):
        _fail("--attempt must identify one exact prior volume DEV operation")
    if not isinstance(getattr(args, "config_sha256", None), str) or SHA256_RE.fullmatch(args.config_sha256) is None:
        _fail("--config-sha256 must be a lowercase SHA-256")
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    configured_toolchain = toolchain_configuration(selected, identity)
    try:
        helper_image = configured_toolchain["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    except (KeyError, TypeError) as error:
        raise BuildControlError("Selected Compose toolchain has no immutable build-control image") from error
    control = BuildControl(identity, helper_image)
    volume = docker_capture("volume", "inspect", control.volume, allow_failure=True, timeout=60)
    if volume.returncode:
        _fail("Selected group has no existing control volume; cancellation cannot adopt a new namespace")
    control.prepare()

    native_resume = getattr(args, "resume_native_failure_attempt", None)
    failed_backend_id = getattr(args, "failed_backend_container_id", None)
    if native_resume is not None:
        if getattr(args, "resume_maintenance_attempt", None) is not None:
            _fail("Choose only one maintenance continuation mode")
        return _resume_native_cancellation_failure(
            args, selected, layout, identity, helper_image, control
        )
    if failed_backend_id is not None:
        _fail("--failed-backend-container-id is valid only with --resume-native-failure-attempt")
    if getattr(args, "resume_maintenance_attempt", None) is not None:
        return _resume_cancel_unclaimed(
            args, selected, layout, identity, helper_image, control
        )

    previous_root = "development/attempts/" + args.attempt
    previous_raw = _control_raw(control, previous_root + "/terminal.json")
    if previous_raw is None:
        _fail("Pinned previous development terminal receipt is missing")
    previous = _json_object(previous_raw, "previous development terminal receipt")
    if (previous.get("state") not in {"succeeded", "failed-confirmed"}
            or previous.get("attempt") != args.attempt
            or previous.get("compose_project") != control.project):
        _fail("Previous development attempt is not an admissible exact terminal")
    document_raw = _control_raw(control, previous_root + "/compose.json")
    if document_raw is None:
        _fail("Previous development Compose document is missing")
    document = _json_object(document_raw, "previous development Compose document")
    if (_sha256(canonical(document)) != args.config_sha256 or document.get("name") != control.project
            or set(document.get("services", {})) != {"backend", "frontend"}):
        _fail("Previous Compose identity or explicit config pin differs")
    previous_inputs = previous.get("inputs")
    if not isinstance(previous_inputs, Mapping) or previous_inputs.get("source_root") != str(selected):
        _fail("Previous operation does not belong to the explicitly selected source checkout")
    frontend_ports = document.get("services", {}).get("frontend", {}).get("ports")
    if not isinstance(frontend_ports, list) or len(frontend_ports) != 1:
        _fail("Retained frontend port is ambiguous")
    frontend_port = frontend_ports[0]
    if (not isinstance(frontend_port, Mapping)
            or frontend_port.get("host_ip") != "127.0.0.1"
            or frontend_port.get("target") != 8080
            or frontend_port.get("protocol") != "tcp"
            or not isinstance(frontend_port.get("published"), str)
            or not frontend_port["published"].isdigit()
            or int(frontend_port["published"]) != args.port):
        _fail("Explicit frontend port differs from the retained Compose pin")
    request_id = getattr(args, "request_id", None)
    if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
        _fail("--request-id must be a canonical nonzero UUID")
    try:
        if uuid.UUID(request_id).int == 0 or str(uuid.UUID(request_id)) != request_id:
            _fail("--request-id must be a canonical nonzero UUID")
    except ValueError as error:
        raise BuildControlError("--request-id must be a canonical nonzero UUID") from error
    request_relative = REQUEST_ROOT + "/" + request_id + ".json"
    existing_request_raw = _control_raw(
        control, request_relative, optional=True, maximum=MAX_REQUEST_BYTES
    )
    if existing_request_raw is not None:
        existing_request = _json_object(
            existing_request_raw, "existing unclaimed cancellation request",
            maximum=MAX_REQUEST_BYTES,
        )
        expected_keys = {
            "schema_version", "request_id", "config_sha256", "owner_sha256",
            "expected_owner", "run_id", "task_id", "expected_catalog_revision",
            "expected_catalog_sha256", "expected_task", "reason",
        }
        expected_task = existing_request.get("expected_task")
        expected_owner = existing_request.get("expected_owner")
        if (set(existing_request) != expected_keys
                or canonical(existing_request) + b"\n" != existing_request_raw
                or existing_request.get("schema_version") != REQUEST_SCHEMA
                or existing_request.get("request_id") != request_id
                or existing_request.get("config_sha256") != args.config_sha256
                or existing_request.get("run_id") != getattr(args, "run_id", None)
                or existing_request.get("task_id") != getattr(args, "task_id", None)
                or existing_request.get("reason") != getattr(args, "reason", None)
                or not isinstance(existing_request.get("owner_sha256"), str)
                or SHA256_RE.fullmatch(existing_request["owner_sha256"]) is None
                or not isinstance(existing_request.get("expected_catalog_sha256"), str)
                or SHA256_RE.fullmatch(existing_request["expected_catalog_sha256"]) is None
                or isinstance(existing_request.get("expected_catalog_revision"), bool)
                or not isinstance(existing_request.get("expected_catalog_revision"), int)
                or existing_request["expected_catalog_revision"] <= 0
                or not isinstance(expected_owner, Mapping)
                or expected_owner.get("schema_version") != "runtime_service_owner.v1"
                or expected_owner.get("state") not in {"unknown", "failed"}
                or not isinstance(expected_task, Mapping)
                or expected_task.get("task_id") != existing_request.get("task_id")
                or expected_task.get("lifecycle") not in {"accepted", "queued"}
                or any(expected_task.get(field) is not None for field in (
                    "attempt_id", "resource_id", "resolved_input_fingerprint",
                    "coordinator_watermark", "coordinator_genesis",
                ))):
            _fail("Existing request_id is not the exact explicit cancellation request")
        completed = _already_completed_receipt(
            control, existing_request, existing_request_raw
        )
        if completed is None:
            _fail("Cancellation request already exists without a terminal receipt; no automatic retry is allowed")
        print(json.dumps(completed, ensure_ascii=False, sort_keys=True))
        return completed
    state = storage.validate_path(
        Path(previous.get("state_root", "")), layout["runtime_root"],
        "retained Linux/Windows user state",
    )
    certificate_path = volume_dev._certificate_path(state)
    certificate = volume_dev._retained_certificate(state, document)
    if certificate.get("image_id") != previous.get("inputs", {}).get("image_id"):
        _fail("Retained storage certificate differs from the previous application image")

    # Current mutable native pins are captured before image preparation and
    # rechecked under the new development lease immediately before teardown.
    config_relative = RUNTIME_ROOT + "/runtime-service/docker-all.json"
    owner_relative = RUNTIME_ROOT + "/runtime-services/OWNER.json"
    process_relative = RUNTIME_ROOT + "/runtime-service/process-tree.json"
    config_raw = _control_raw(control, config_relative, maximum=256 * 1024)
    owner_raw = _control_raw(control, owner_relative, maximum=256 * 1024)
    process_raw = _control_raw(control, process_relative, maximum=MAX_CONTROL_BYTES)
    if config_raw is None or owner_raw is None or process_raw is None:
        _fail("Retained native configuration, owner, or process receipt is missing")
    process_receipt = _json_object(process_raw, "retained process-tree receipt")
    if (process_receipt.get("schema") != "fullmag.docker-process-tree.v1"
            or process_receipt.get("state") != "shutdown_unknown"):
        _fail("Cancellation requires the exact retained shutdown_unknown process receipt")
    request, request_raw, catalog_raw = _request_inputs(
        args, control, previous, document, state, owner_raw, config_raw
    )
    request_sha256 = _sha256(request_raw)

    ids, actual, old_image_id, image_config, _ = _observe_retained_namespace(
        args, control, identity, previous, document
    )
    attempt_inputs = previous_inputs
    policy = attempt_inputs.get("gpu_access_requested") if isinstance(attempt_inputs, Mapping) else None
    if policy not in {"auto", "required", "disabled"}:
        _fail("Previous operation has no retained GPU access intent")
    old_access = document.get("services", {}).get("backend", {}).get("environment", {}).get(
        "FULLMAG_DOCKER_DEVICE_ACCESS"
    )
    if (old_access not in {"cpu", "gpu"}
            or attempt_inputs.get("device_access") != old_access):
        _fail("Retained operation and backend Compose disagree on the resolved device-access route")
    import docker_volume_dev as volume_dev
    operator_probe_record = volume_dev._operator_probe_record_from_retained(previous, document)

    # Use the existing managed BuildKit image preparation. The application
    # package itself is compiled only after the exact old services are gone,
    # in the persistent Compose backend service started below.
    toolchain = build_volume_toolchain(selected)
    if toolchain.get("inputs", {}).get("build_args", {}).get("FULLMAG_CUDA_BASE_IMAGE") != helper_image:
        _fail("Selected toolchain changed while preparing cancellation")
    images = build_volume_runtime_images(selected, control, toolchain)
    image = images.get("backend", {}).get("image_id") if isinstance(images, Mapping) else None
    if not isinstance(image, str) or IMAGE_RE.fullmatch(image) is None:
        _fail("Prepared backend image has no immutable identity")
    device_access = _verify_docker_gpu_access(
        _resolve_gpu_access(policy), policy, image, control.project
    )
    if device_access != old_access:
        _fail("Current Docker GPU availability does not match the retained device-access proof")
    maintenance = {
        "request_id": request["request_id"],
        "request_sha256": request_sha256,
        "request_path": _request_path(request["request_id"]),
    }
    operation_inputs = {
        "source_root": str(selected),
        "image_id": image,
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "source_checkout_kind": identity["checkout_kind"],
        "gpu_access_requested": policy,
        "device_access": device_access,
        "gpu_preflight": "PASS" if device_access == "gpu" else "NOT_REQUIRED",
        **operator_probe_record,
        "unclaimed_cancellation": maintenance,
    }
    args.profile = "dev"
    args.script = None
    args.image = None
    args.toolchain_image = None
    args.source_manifest = None
    args.gpu_access = policy
    retained_allowlist = volume_dev.include_untracked_from_compose(document)
    explicit_allowlist = volume_dev.normalize_include_untracked_paths(
        getattr(args, "include_untracked", None)
    )
    args.include_untracked = volume_dev.normalize_include_untracked_paths(
        sorted(set(retained_allowlist) | set(explicit_allowlist))
    )
    args.migrate_host_capacity = False
    args.fresh_state = False
    args.port_explicit = True
    if isinstance(args.port, bool) or not isinstance(args.port, int) or not 1 <= args.port <= 65535:
        _fail("--port must be the explicit retained frontend port")

    with control.operation("development", operation_inputs) as operation:
        import docker_group_ledger as group_ledger
        operation["receipt"]["ledger_profile"] = (
            group_ledger.PROFILE
            if group_ledger.is_group_ledger_backend(
                document.get("services", {}).get("backend", {}).get("environment", {})
            )
            else "host-ledger-v1"
        )
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        # Re-observe the namespace and native pins under the exact group lease.
        leased_ids, leased_actual, _, _, helper_id = _observe_retained_namespace(
            args, control, identity, previous, document, operation=operation
        )
        if leased_ids != ids:
            _fail("Retained service IDs changed before cancellation teardown")
        for service in ("backend", "frontend"):
            before = _safe_inspect_summary(actual[service])
            after = _safe_inspect_summary(leased_actual[service])
            if before != after:
                _fail("Retained " + service + " inspect evidence changed before teardown")
        current_config_raw = _control_raw(control, config_relative, maximum=256 * 1024)
        current_owner_raw = _control_raw(control, owner_relative, maximum=256 * 1024)
        current_process_raw = _control_raw(control, process_relative, maximum=MAX_CONTROL_BYTES)
        if (current_config_raw != config_raw or current_owner_raw != owner_raw
                or current_process_raw != process_raw):
            _fail("Native configuration, owner, or process receipt changed before teardown")
        current_catalog_path = storage.validate_path(
            state / "runs" / "docker-all" / "session-store" / "runs"
            / request["run_id"] / "run_catalog.json",
            state / "runs" / "docker-all" / "session-store",
            "pinned accepted run catalog",
        )
        if volume_dev._session_host().read_owned_regular(
            current_catalog_path, maximum=MAX_CATALOG_BYTES
        ) != catalog_raw:
            _fail("Run catalog changed before cancellation teardown")

        evidence = {
            "schema": "fullmag.docker-volume-unclaimed-cancellation-before.v1",
            "request_id": request["request_id"],
            "request_sha256": request_sha256,
            "prior_attempt": args.attempt,
            "prior_terminal_sha256": _sha256(previous_raw),
            "prior_compose_sha256": args.config_sha256,
            "prior_runtime_config_sha256": _sha256(config_raw),
            "prior_owner_sha256": _sha256(owner_raw),
            "prior_process_receipt_sha256": _sha256(process_raw),
            "prior_catalog_sha256": _sha256(catalog_raw),
            "backend": _safe_inspect_summary(leased_actual["backend"]),
            "frontend": _safe_inspect_summary(leased_actual["frontend"]),
            "container_pins": [
                __import__("docker_volume_container_recovery")._container_pin(
                    leased_actual[service], service, control.project
                )
                for service in ("backend", "frontend")
            ],
        }
        operation["receipt"]["unclaimed_cancellation_preflight"] = evidence
        control.write(operation["root"] + "/unclaimed-cancellation-before.json", evidence)
        control.write_bytes(operation["root"] + "/prior-runtime-config.json", config_raw)
        control.write_bytes(operation["root"] + "/prior-runtime-owner.json", owner_raw)
        control.write_bytes(operation["root"] + "/prior-process-tree.json", process_raw)
        _publish_immutable(control, request_relative, request_raw)
        if _control_raw(control, request_relative, maximum=MAX_REQUEST_BYTES) != request_raw:
            _fail("Published cancellation request did not retain its pinned raw bytes")

        operation["receipt"].update(state="stopping-owned-frontend", previous_state_root=str(state))
        operation["daemon_pending"] = True
        if leased_actual["frontend"].get("State", {}).get("Running") is True:
            docker_capture("stop", "--time", "60", ids["frontend"], timeout=90)
        operation["daemon_pending"] = False
        stopped = {}
        for service in ("backend", "frontend"):
            rows = json.loads(docker_capture("inspect", ids[service], timeout=60).stdout)
            if len(rows) != 1 or rows[0].get("Id") != ids[service]:
                _fail("Stopped namespace inspect became ambiguous: " + service)
            stopped[service] = rows[0]
            _assert_container_unchanged(
                leased_actual[service], rows[0], service, stopped=True
            )
        _assert_private_network_after_stop(stopped, ids, control.project, identity)
        docker_log_sha256 = {}
        for service in ("backend", "frontend"):
            captured = docker_capture("logs", "--tail", "500", ids[service], timeout=60)
            docker_logs = bytes(captured.stdout) + bytes(captured.stderr)
            if len(docker_logs) > MAX_LOG_BYTES:
                _fail("Stopped " + service + " Docker log tail exceeds its preservation bound")
            control.write_bytes(operation["root"] + "/" + service + "-docker-logs.txt", docker_logs)
            docker_log_sha256[service] = _sha256(docker_logs)
        preflight_sha256 = _sha256(canonical(evidence) + b"\n")
        stopped_record = {
            "schema": "fullmag.docker-volume-unclaimed-cancellation-stopped.v1",
            "request_id": request["request_id"], "request_sha256": request_sha256,
            "prior_attempt": args.attempt, "preflight_sha256": preflight_sha256,
            "container_ids": dict(ids),
            "containers": {
                service: _safe_inspect_summary(stopped[service])
                for service in ("backend", "frontend")
            },
            "docker_log_sha256": docker_log_sha256,
            "docker_log_tail_lines": 500,
        }
        stopped_raw = canonical(stopped_record) + b"\n"
        control.write_bytes(operation["root"] + "/unclaimed-cancellation-stopped.json", stopped_raw)
        operation["receipt"]["unclaimed_cancellation_stopped"] = stopped_record
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        operation["receipt"].update(state="removing-exact-stopped-containers")
        operation["daemon_pending"] = True
        docker_capture("rm", ids["backend"], ids["frontend"], timeout=90)
        operation["daemon_pending"] = False
        for service in ("backend", "frontend"):
            _assert_removed(ids[service], service)
        if helper_id is None or _project_container_ids(control.project) != {helper_id}:
            _fail("Compose project still contains an unlisted container after exact teardown")
        if _volume_consumer_ids(control.volume) != {helper_id}:
            _fail("Control volume still has an unlisted consumer after exact teardown")
        removed_record = {
            "schema": "fullmag.docker-volume-unclaimed-cancellation-removed.v1",
            "request_id": request["request_id"], "request_sha256": request_sha256,
            "prior_attempt": args.attempt, "preflight_sha256": preflight_sha256,
            "container_ids": dict(ids), "stopped_sha256": _sha256(stopped_raw),
            "helper_container_id": helper_id,
        }
        control.write(operation["root"] + "/unclaimed-cancellation-removed.json", removed_record)
        operation["receipt"]["unclaimed_cancellation_removed"] = removed_record
        control.write(operation["root"] + "/receipt.json", operation["receipt"])

        host = volume_dev._session_host()
        reuse = {
            "state": state,
            "host_certificate": certificate_path,
            "owner_marker": state / host.OWNER_NAME,
            "receipt": {"image_id": old_image_id},
            "operator_probe_environment_record": operator_probe_record,
        }
        volume_dev.start(
            args,
            reuse_state=reuse,
            control=control,
            operation=operation,
            prepared={"toolchain": toolchain, "images": images},
            maintenance=maintenance,
        )

    result = operation["receipt"].get("unclaimed_cancellation_result")
    if not isinstance(result, Mapping):
        _fail("Managed startup exited without a typed cancellation terminal receipt")
    print(json.dumps(dict(result), ensure_ascii=False, sort_keys=True))
    return dict(result)


def _assert_private_network_after_stop(stopped, ids, project, identity):
    import docker_volume_dev as volume_dev

    backend = stopped["backend"]
    if backend.get("HostConfig", {}).get("PortBindings"):
        _fail("Stopped backend unexpectedly publishes host ports")
    networks = backend.get("NetworkSettings", {}).get("Networks", {})
    if len(networks) != 1:
        _fail("Stopped backend does not have exactly one private group network")
    network_name = next(iter(networks))
    if network_name != identity.get("network_name"):
        _fail("Stopped backend network differs from the deterministic group bridge")
    volume_dev._assert_private_restart_network(stopped, ids, project)
