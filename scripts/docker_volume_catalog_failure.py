"""Read-only proof and authenticated drain for one catalog-failed activation."""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from pathlib import PurePosixPath
from typing import Any

from docker_build_control import BuildControlError, docker_capture


_CONTAINER_ID_RE = re.compile(r"[0-9a-f]{64}\Z")
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
_REQUEST_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
_MAX_DOCUMENT_BYTES = 1024 * 1024
_MAX_PROBE_OUTPUT_BYTES = 2 * _MAX_DOCUMENT_BYTES


def _fail(message: str) -> BuildControlError:
    return BuildControlError(message)


_CATALOG_FAILURE_PROBE = r'''import hashlib, http.client, json, os, pathlib, re, stat, sys

MAX_BYTES = 1024 * 1024
HEX64 = re.compile(r"[0-9a-f]{64}\Z")

def fail(message):
    raise RuntimeError(message)

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("duplicate JSON object key")
        result[key] = value
    return result

def parse_object(raw, label):
    try:
        value = json.loads(raw, object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(label + " is not valid JSON: " + str(error))
    if not isinstance(value, dict):
        fail(label + " is not a JSON object")
    return value

def read_bounded_regular(path, label):
    path = pathlib.Path(path)
    if not path.is_absolute() or path.parent.resolve(strict=True) != path.parent:
        fail(label + " path has a noncanonical parent")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    try:
        initial = os.fstat(descriptor)
        if not stat.S_ISREG(initial.st_mode) or initial.st_nlink != 1 or initial.st_size > MAX_BYTES:
            fail(label + " is not a bounded regular file")
        chunks = bytearray()
        while len(chunks) <= MAX_BYTES:
            chunk = os.read(descriptor, min(65536, MAX_BYTES + 1 - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
        if len(chunks) > MAX_BYTES or len(chunks) != initial.st_size:
            fail(label + " changed or exceeds the one-megabyte bound")
        final = os.fstat(descriptor)
        current = os.stat(path, follow_symlinks=False)
        identity = (initial.st_dev, initial.st_ino, initial.st_size, initial.st_mtime_ns)
        if (not stat.S_ISREG(final.st_mode) or not stat.S_ISREG(current.st_mode)
                or final.st_nlink != 1 or current.st_nlink != 1
                or identity != (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns)
                or identity != (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns)):
            fail(label + " changed while being read")
        return bytes(chunks)
    finally:
        os.close(descriptor)

def owner_identity_document(service, owner):
    identity = service._owner_identity(owner)
    children = service._owner_child_identity(owner)
    return {**identity, "children": [list(pair) for pair in children]}

def require_live_pid(pid, label):
    if type(pid) is not int or pid <= 0:
        fail(label + " pid is invalid")
    try:
        os.kill(pid, 0)
    except PermissionError:
        # kill(pid, 0) did not send a signal; EPERM still proves the pid exists.
        return
    except ProcessLookupError:
        fail(label + " process is absent")

def api_document(service, path, expected_identity):
    connection = http.client.HTTPConnection("127.0.0.1", 8081, timeout=15)
    try:
        connection.request("GET", path, headers={"Host": "localhost", "Accept": "application/json", "Connection": "close"})
        response = connection.getresponse()
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            fail("API response exceeds the one-megabyte bound: " + path)
        headers = response.getheaders()
        instances = [value.strip() for key, value in headers if key.lower() == "x-fullmag-api-instance"]
        contracts = [value.strip() for key, value in headers if key.lower() == "x-api-contract-version"]
        if (response.status != 200 or len(instances) != 1 or len(contracts) != 1
                or instances[0] != expected_identity.get("api_instance_id")
                or contracts[0] != expected_identity.get("api_contract_version")):
            fail("API endpoint status or exact instance identity differs: " + path)
        return raw, parse_object(raw, "API response " + path)
    finally:
        connection.close()

def main():
    if len(sys.argv) != 5:
        fail("probe arguments are incomplete")
    request_id, source_sha256, source_relative, backend_id = sys.argv[1:]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", request_id):
        fail("activation request identity is invalid")
    if not HEX64.fullmatch(source_sha256):
        fail("activation source digest is invalid")
    relative = pathlib.PurePosixPath(source_relative)
    if (not source_relative or relative.is_absolute() or relative.as_posix() != source_relative
            or any(part in ("", ".", "..") for part in relative.parts)
            or "\\" in source_relative or "\x00" in source_relative):
        fail("activation source-relative path is unsafe")
    if not re.fullmatch(r"[0-9a-f]{64}", backend_id):
        fail("backend container identity is invalid")

    sys.path.insert(0, "/opt/fullmag")
    import runtime_service as service

    paths = service.canonical_paths()
    process_path = service.process_receipt_path(paths)
    process_raw = read_bounded_regular(process_path, "canonical process receipt")
    process = parse_object(process_raw, "canonical process receipt")
    config_raw = read_bounded_regular(paths.config, "canonical runtime config")
    config = parse_object(config_raw, "canonical runtime config")
    if (process.get("schema") != "fullmag.docker-process-tree.v1"
            or process.get("state") != "ready"):
        fail("canonical process receipt is not ready")
    if (config.get("schema_version") != "runtime_service_config.v2"
            or config.get("store_root") != str(paths.store)
            or config.get("target_id") != service.TARGET_ID):
        fail("canonical runtime config identity differs")

    api_pid = process.get("api_pid")
    bootstrap = process.get("bootstrap")
    service_owner = process.get("service_owner")
    if type(api_pid) is not int or api_pid <= 0 or not isinstance(bootstrap, dict):
        fail("ready process receipt has incomplete API/bootstrap identity")
    binding = bootstrap.get("binding")
    if not isinstance(binding, str) or not HEX64.fullmatch(binding):
        fail("ready process receipt has an invalid accepted-store binding")
    if not isinstance(service_owner, dict):
        fail("ready process receipt has no service owner")
    service._validate_terminal_owner(service_owner, state="ready", name="process receipt owner")
    if (config.get("compute_pool_id") != service_owner.get("compute_pool_id")
            or config.get("preparation_pool_id") != service_owner.get("preparation_pool_id")):
        fail("runtime config scheduler identity differs from the ready owner")

    ready_owner = service._read_ready_owner(paths)
    service._validate_terminal_owner(ready_owner, state="ready", name="canonical ready owner")
    pin_path = service._owner_pin_path(paths, service_owner)
    pin = parse_object(read_bounded_regular(pin_path, "canonical owner pin"), "canonical owner pin")
    service._validate_terminal_owner(pin, state="ready", name="pinned ready owner")
    owners = (ready_owner, pin, service_owner)
    reference = owners[0]
    for candidate in owners[1:]:
        if (service._owner_identity(candidate) != service._owner_identity(reference)
                or service._owner_child_identity(candidate) != service._owner_child_identity(reference)):
            fail("ready owner, owner pin, and process receipt identities differ")

    child_pids = []
    for child in ready_owner.get("children", []):
        child_pids.append(child.get("pid"))
    for pid, label in ([(ready_owner.get("pid"), "native owner")]
            + [(pid, "native scheduler child") for pid in child_pids]):
        require_live_pid(pid, label)

    # The shared runtime helper performs the canonical OpenAPI/store-binding
    # identity check and the runtime-service liveness check. Keep its HTTP cap
    # at the narrower bound required for this evidence probe.
    service.MAX_HTTP_BYTES = MAX_BYTES
    identity, _profile = service._probe_api_identity(paths, 8081, binding, timeout=15)
    service._probe_api_liveness(8081, identity, timeout=15)

    status_raw, status = api_document(service, "/v2/sessions/current/status", identity)
    prep_raw, preparation = api_document(service, "/v2/sessions/current/simulation/preparation", identity)
    commands_raw, commands = api_document(service, "/v2/sessions/current/simulation/commands", identity)
    run_raw, current_run = api_document(service, "/v2/sessions/current/simulation/runs/current", identity)
    queue_raw, queue = api_document(service, "/v2/platform/compute/queue?limit=100", identity)

    expected_session = "docker-startup-" + hashlib.sha256(
        (request_id + "\0" + source_sha256).encode("utf-8")
    ).hexdigest()
    session = status.get("session")
    script = session.get("script") if isinstance(session, dict) else None
    summary_run = status.get("run")
    solver = status.get("solver")
    run_id = current_run.get("run_id")
    if (not isinstance(session, dict) or session.get("session_id") != expected_session
            or not isinstance(script, dict)
            or script.get("path") != "/opt/fullmag/source/" + source_relative):
        fail("Live status session or startup script identity differs")
    if (not isinstance(run_id, str) or not run_id
            or not isinstance(summary_run, dict) or summary_run.get("run_id") != run_id
            or current_run.get("session_id") != expected_session
            or current_run.get("status") != "waiting_for_compute"
            or not isinstance(solver, dict) or solver.get("state") != "waiting_for_compute"
            or type(summary_run.get("solver_steps")) is not int or summary_run["solver_steps"] != 0):
        fail("current run is not the exact unstarted waiting-for-compute run")

    failure = preparation.get("failure")
    if (preparation.get("status") != "failed"
            or preparation.get("active_stage_id") is not None
            or not isinstance(failure, dict)
            or failure.get("error_code") != "accepted_run_catalog_failed"):
        fail("preparation is not the accepted-run catalog failure")

    count_fields = ("pending_count", "accepted_count", "dispatched_count", "running_count",
                    "completed_count", "rejected_count", "failed_count")
    if (type(commands.get("revision")) is not int or commands["revision"] != 0
            or any(type(commands.get(field)) is not int or commands[field] != 0 for field in count_fields)
            or commands.get("commands") != []):
        fail("command ledger is not empty")

    expected_item_id = "run/" + run_id + "/materialization"
    items = queue.get("items")
    if (queue.get("schema_version") != "compute_queue.v1"
            or not isinstance(items, list) or len(items) != 1
            or queue.get("next_cursor") is not None):
        fail("compute queue is not the single unpaginated catalog-failure item")
    item = items[0]
    if (not isinstance(item, dict) or item.get("item_id") != expected_item_id
            or item.get("run_id") != run_id
            or item.get("state") != "pending_materialization"
            or type(item.get("scheduling_priority")) is not int or item["scheduling_priority"] != 0
            or not isinstance(item.get("project_id"), str) or not item["project_id"]
            or item.get("task_id") is not None or item.get("attempt_id") is not None
            or item.get("ownership_epoch") is not None or item.get("resource_id") is not None
            or item.get("blocking_reason") is not None):
        fail("compute queue item is not the exact pending materialization for this run")

    session_identity = {
        "session_id": session["session_id"],
        "session_epoch": session.get("session_epoch"),
        "request_scope_epoch": session.get("request_scope_epoch"),
        "script_path": script["path"],
        "run_id": run_id,
    }
    if (not isinstance(session_identity["session_epoch"], str) or not session_identity["session_epoch"]
            or not isinstance(session_identity["request_scope_epoch"], str)
            or not session_identity["request_scope_epoch"]):
        fail("Live session has no complete request identity")
    return {
        "backend_id": backend_id,
        "runtime_config_sha256": hashlib.sha256(config_raw).hexdigest(),
        "process_receipt_sha256": hashlib.sha256(process_raw).hexdigest(),
        "process_receipt": process,
        "ready_owner_identity": owner_identity_document(service, ready_owner),
        "api_instance_id": identity["api_instance_id"],
        "session_identity": session_identity,
        "run_id": run_id,
        "project_id": item["project_id"],
        "preparation_sha256": hashlib.sha256(prep_raw).hexdigest(),
        "commands_sha256": hashlib.sha256(commands_raw).hexdigest(),
    }

try:
    print(json.dumps(main(), sort_keys=True, separators=(",", ":")))
except Exception as error:
    print(str(error), file=sys.stderr)
    raise
'''


def _activation_values(activation_inputs: Mapping[str, Any]) -> tuple[str, str, str]:
    if not isinstance(activation_inputs, Mapping):
        raise _fail("activation inputs are not an object")
    request_id = activation_inputs.get("request_id")
    source_sha256 = activation_inputs.get("source_sha256")
    source_relative = activation_inputs.get("source_relative")
    if not isinstance(request_id, str) or _REQUEST_ID_RE.fullmatch(request_id) is None:
        raise _fail("activation request identity is invalid")
    if not isinstance(source_sha256, str) or _SHA256_RE.fullmatch(source_sha256) is None:
        raise _fail("activation source digest is invalid")
    if not isinstance(source_relative, str):
        raise _fail("activation source-relative path is missing")
    relative = PurePosixPath(source_relative)
    if (
        not source_relative
        or relative.is_absolute()
        or relative.as_posix() != source_relative
        or any(part in ("", ".", "..") for part in relative.parts)
        or "\\" in source_relative
        or "\x00" in source_relative
    ):
        raise _fail("activation source-relative path is unsafe")
    return request_id, source_sha256, source_relative


def probe_catalog_failure(backend_id: str, activation_inputs: Mapping[str, Any]) -> dict[str, Any]:
    """Read-only proof that the exact startup run failed before any Compute work."""
    if not isinstance(backend_id, str) or _CONTAINER_ID_RE.fullmatch(backend_id) is None:
        raise _fail("backend container identity is invalid")
    request_id, source_sha256, source_relative = _activation_values(activation_inputs)
    result = docker_capture(
        "exec",
        backend_id,
        "/usr/local/bin/python3",
        "-I",
        "-B",
        "-c",
        _CATALOG_FAILURE_PROBE,
        request_id,
        source_sha256,
        source_relative,
        backend_id,
        timeout=90,
    )
    if len(result.stdout) > _MAX_PROBE_OUTPUT_BYTES or len(result.stderr) > _MAX_DOCUMENT_BYTES:
        raise _fail("catalog-failure probe output exceeds its bounded capture")
    try:
        proof = json.loads(result.stdout, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail("catalog-failure probe returned invalid JSON") from error
    if not isinstance(proof, dict):
        raise _fail("catalog-failure probe returned a non-object")
    expected_keys = {
        "backend_id",
        "runtime_config_sha256",
        "process_receipt_sha256",
        "process_receipt",
        "ready_owner_identity",
        "api_instance_id",
        "session_identity",
        "run_id",
        "project_id",
        "preparation_sha256",
        "commands_sha256",
    }
    if set(proof) != expected_keys:
        raise _fail("catalog-failure probe proof fields are incomplete")
    if proof["backend_id"] != backend_id:
        raise _fail("catalog-failure probe came from a different backend")
    for field in (
        "runtime_config_sha256",
        "process_receipt_sha256",
        "preparation_sha256",
        "commands_sha256",
    ):
        if not isinstance(proof.get(field), str) or _SHA256_RE.fullmatch(proof[field]) is None:
            raise _fail(f"catalog-failure probe has an invalid {field}")
    return proof


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _owner_identity_document(owner: Mapping[str, Any], label: str) -> dict[str, Any]:
    fields = (
        "owner_token",
        "process_start_token",
        "pid",
        "host",
        "target_id",
        "control_address",
        "build_commit",
        "build_snapshot",
        "compute_pool_id",
        "preparation_pool_id",
        "compute_pool_generation",
        "preparation_pool_generation",
    )
    children = owner.get("children")
    if not isinstance(children, list):
        raise _fail(f"{label} has no scheduler child identity")
    child_identity: list[list[Any]] = []
    for child in children:
        if not isinstance(child, Mapping):
            raise _fail(f"{label} has an invalid scheduler child")
        child_identity.append([child.get("role"), child.get("pid")])
    child_identity.sort(key=lambda item: (str(item[0]), str(item[1])))
    return {**{field: owner.get(field) for field in fields}, "children": child_identity}


def verify_catalog_failure_drain(
    control: Any,
    stopped_backend: Mapping[str, Any],
    before: Mapping[str, Any],
) -> dict[str, Any]:
    """Authenticate and bind the graceful native drain to the proven Ready owner."""
    if not isinstance(stopped_backend, Mapping) or not isinstance(before, Mapping):
        raise _fail("catalog-failure drain inputs are incomplete")
    state = stopped_backend.get("State")
    backend_id = stopped_backend.get("Id")
    if (
        not isinstance(backend_id, str)
        or _CONTAINER_ID_RE.fullmatch(backend_id) is None
        or backend_id != before.get("backend_id")
        or not isinstance(state, Mapping)
        or state.get("Running") is not False
        or type(state.get("Pid")) is not int
        or state.get("Pid") != 0
        or state.get("OOMKilled") is not False
        or type(state.get("ExitCode")) is not int
        or state.get("ExitCode") != 0
        or state.get("Status") != "exited"
        or not isinstance(state.get("StartedAt"), str)
        or not state.get("StartedAt")
        or not isinstance(state.get("FinishedAt"), str)
        or not state.get("FinishedAt")
    ):
        raise _fail("backend did not stop cleanly as the exact catalog-failure incarnation")

    from docker_volume_stop_unadmitted import _owner_identity_key, _read_terminal_process_receipt

    raw, drained = _read_terminal_process_receipt(stopped_backend, control)
    if (
        drained.get("schema") != "fullmag.docker-process-tree.v1"
        or drained.get("state") != "drained"
        or not isinstance(drained.get("service_owner"), Mapping)
        or not isinstance(drained.get("terminal_service_owner"), Mapping)
    ):
        raise _fail("stopped backend has no authenticated native drain transition")
    original = before.get("process_receipt")
    if (
        not isinstance(original, Mapping)
        or original.get("schema") != "fullmag.docker-process-tree.v1"
        or original.get("state") != "ready"
        or type(original.get("api_pid")) is not int
        or original.get("api_pid") <= 0
        or type(drained.get("api_pid")) is not int
        or drained.get("api_pid") != original.get("api_pid")
        or not isinstance(before.get("api_instance_id"), str)
        or not before.get("api_instance_id")
    ):
        raise _fail("drained API process identity differs from the Ready probe")

    expected_owner = before.get("ready_owner_identity")
    ready_owner = drained["service_owner"]
    terminal_owner = drained["terminal_service_owner"]
    if (
        not isinstance(expected_owner, Mapping)
        or _owner_identity_document(ready_owner, "drained receipt Ready owner") != dict(expected_owner)
        or _owner_identity_key(original.get("service_owner", {}), "original Ready owner")
        != _owner_identity_key(ready_owner, "drained receipt Ready owner")
        or _owner_identity_key(ready_owner, "drained receipt Ready owner")
        != _owner_identity_key(terminal_owner, "terminal drained owner")
    ):
        raise _fail("authenticated terminal owner differs from the exact Ready owner")
    children = terminal_owner.get("children")
    if (
        not isinstance(children, list)
        or len(children) != 2
        or {child.get("role") for child in children if isinstance(child, Mapping)}
        != {"compute", "preparation"}
        or any(
            not isinstance(child, Mapping) or child.get("status") != "exited_success"
            for child in children
        )
    ):
        raise _fail("native scheduler children did not both drain successfully")

    identity_raw = json.dumps(
        dict(expected_owner), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return {
        "schema": "fullmag.docker-catalog-failure-drain.v1",
        "state": "drained",
        "backend_id": backend_id,
        "backend_image_id": stopped_backend.get("Image"),
        "backend_started_at": state["StartedAt"],
        "backend_finished_at": state["FinishedAt"],
        "backend_exit_code": state["ExitCode"],
        "docker_oom_killed": state["OOMKilled"],
        "api_pid": original["api_pid"],
        "api_instance_id": before["api_instance_id"],
        "drained_process_receipt_sha256": hashlib.sha256(raw).hexdigest(),
        "drained_process_receipt": drained,
        "ready_owner_identity_sha256": hashlib.sha256(identity_raw).hexdigest(),
        "native_children_exit_status": "exited_success",
    }
