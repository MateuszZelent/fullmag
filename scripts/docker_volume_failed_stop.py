"""Failure-only proof for an unconfirmed backend stop.

This module classifies the failed Docker stop and preserves its evidence. It
never drains or repairs the native runtime, restarts/removes containers, reads
the session store, releases a native lease, or authorizes a retry. Native
recovery remains independently required; native drain is unconfirmed.
"""
from __future__ import annotations

import json
import math
from pathlib import Path, PurePosixPath
import re
import shlex

SCHEMA = "fullmag.docker-iteration-failed-stop-reconciliation.v1"
SHUTDOWN_ERROR = (
    "Command '['/opt/fullmag/package/bin/fullmag-api']' timed out after 10 seconds"
)
FAILED_STOP_ERROR = (
    "Backend termination is not confirmed graceful; restart withheld"
)
TERMINAL_SCHEMA = "fullmag.docker-terminal-session-drain-preflight.v1"
PROCESS_SCHEMA = "fullmag.docker-process-tree.v1"
OWNER_SCHEMA = "runtime_service_owner.v1"

_PROOF_KEYS = {
    "previous_receipt_sha256",
    "terminal_preflight_sha256",
    "idle_preflight_sha256",
    "process_receipt_sha256",
    "native_owner_sha256",
    "verified_sha256",
    "backend_finished_at",
    "frontend_finished_at",
    "backend_exit_code",
    "frontend_exit_code",
}
_OWNER_KEYS = {
    "schema_version", "owner_token", "process_start_token", "pid", "host",
    "target_id", "protocol", "state", "acquired_at", "heartbeat_at",
    "compute_pool_generation", "preparation_pool_generation", "control_address",
    "build_commit", "build_snapshot", "compute_pool_id", "preparation_pool_id",
    "children",
}
_PROCESS_KEYS = {
    "accepted_store", "api_pid", "bootstrap", "qualification", "schema",
    "service_owner", "shutdown_error", "state",
}
_CHILD_KEYS = {"role", "pid", "status"}
_CHILD_ROLES = {"compute", "preparation"}
_NO_STOP_CHECKPOINTS = (
    "backend-drain.json",
    "idle-stop-containers.json",
    "saved-authoring-checkpoint.json",
    "saved-authoring-preflight.json",
    "saved-authoring-final-preflight.json",
    "diagnostic-terminal-preflight.json",
    "diagnostic-terminal-process-before.json",
    "backend-build-receipt.json",
    "provenance.json",
    "backend-failure-log.json",
    "process-failure.json",
    "readiness-failure.json",
    "before.json",
    "request.json",
    "native-capabilities.json",
    "storage-gate-timeout-log.json",
    "after.json",
)


def _decode(raw, label, require):
    try:
        value = json.loads(raw)
    except (TypeError, ValueError, UnicodeDecodeError) as error:
        require(False, label + " is not valid bounded JSON: " + str(error))
        return None
    require(isinstance(value, dict), label + " must be a JSON object")
    return value


def _nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def _positive_int(value):
    return type(value) is int and value > 0


def _validate_terminal_preflight(preflight, require):
    require(preflight.get("schema") == TERMINAL_SCHEMA,
            "Terminal preflight schema differs")
    api_instance = preflight.get("api_instance_id")
    require(isinstance(api_instance, str)
            and re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", api_instance),
            "Terminal preflight API instance identity is invalid")
    session_id = preflight.get("session_id")
    run = preflight.get("run")
    require(_nonempty(session_id) and isinstance(run, dict)
            and run.get("status") == "completed"
            and _nonempty(run.get("run_id"))
            and run.get("session_id") == session_id,
            "Terminal preflight does not identify this completed run")
    started_at = run.get("started_at")
    require(isinstance(started_at, str)
            and re.fullmatch(r"[0-9]{1,20}", started_at) is not None
            and int(started_at) > 0
            and preflight.get("session_epoch") == session_id + "@" + started_at,
            "Terminal preflight session epoch differs from its completed run")
    request_scope = preflight.get("request_scope_epoch")
    require(isinstance(request_scope, str), "Terminal preflight request scope is missing")
    instance, separator, epoch = request_scope.partition(":")
    require(separator == ":" and instance == api_instance
            and re.fullmatch(r"[1-9][0-9]{0,19}", epoch) is not None
            and int(epoch) <= 18446744073709551615,
            "Terminal preflight request scope is not bound to its API instance")
    queue = preflight.get("compute_queue")
    require(isinstance(queue, dict)
            and queue.get("schema_version") == "compute_queue.v1"
            and queue.get("next_cursor") is None
            and queue.get("items") == [],
            "Failed-stop settlement requires an empty compute queue")
    held = preflight.get("held_run_intent_sha256")
    require(held is None or held == {},
            "Terminal-only failed-stop settlement cannot carry held-run pins")
    runtime = preflight.get("runtime_service")
    require(isinstance(runtime, dict)
            and runtime.get("schema_version") == "application_service_status.v1"
            and runtime.get("configured") is True
            and runtime.get("state") == "ready"
            and isinstance(runtime.get("reason"), dict)
            and runtime["reason"].get("code") == "service_ready",
            "Terminal preflight did not observe the configured runtime Ready")


def _validate_idle_preflight(idle, require):
    uptime = idle.get("uptime_seconds")
    try:
        finite_uptime = type(uptime) in (int, float) and math.isfinite(uptime)
    except (OverflowError, TypeError, ValueError):
        finite_uptime = False
    require(idle.get("status") == "ok"
            and idle.get("active_session") is True
            and idle.get("api_contract_version") == "1.0.0"
            and finite_uptime and uptime > 0,
            "Idle preflight is missing, unhealthy, or contradicts the completed session")


def _validate_owner(owner, require, label):
    require(isinstance(owner, dict) and set(owner) == _OWNER_KEYS,
            label + " fields are incomplete or unsupported")
    require(owner.get("schema_version") == OWNER_SCHEMA and owner.get("state") == "ready",
            label + " is not the preserved Ready owner")
    for key in ("owner_token", "process_start_token", "host", "protocol",
                "control_address", "compute_pool_id", "preparation_pool_id",
                "acquired_at", "heartbeat_at"):
        require(_nonempty(owner.get(key)), label + " identity field is missing: " + key)
    require(owner.get("target_id") == "docker-all" and _positive_int(owner.get("pid")),
            label + " process identity differs")
    build_commit = owner.get("build_commit")
    build_snapshot = owner.get("build_snapshot")
    require(isinstance(build_commit, str)
            and re.fullmatch(r"[0-9a-f]{40}", build_commit) is not None
            and isinstance(build_snapshot, str)
            and re.fullmatch(r"[0-9a-f]{64}", build_snapshot) is not None,
            label + " build identity is invalid")
    for key in ("compute_pool_generation", "preparation_pool_generation"):
        require(_positive_int(owner.get(key)), label + " pool generation is invalid")
    children = owner.get("children")
    require(isinstance(children, list) and len(children) == 2
            and all(isinstance(child, dict) and set(child) == _CHILD_KEYS
                    for child in children)
            and all(isinstance(child.get("role"), str) for child in children)
            and {child.get("role") for child in children} == _CHILD_ROLES
            and all(_positive_int(child.get("pid")) and child.get("status") == "running"
                    for child in children)
            and len({child["pid"] for child in children}) == 2,
            label + " child identity is incomplete")
    return owner


def _validate_native_records(process, owner, require):
    allowed_process_keys = (_PROCESS_KEYS, _PROCESS_KEYS | {"api_failure_fence"})
    require(isinstance(process, dict) and set(process) in allowed_process_keys
            and process.get("schema") == PROCESS_SCHEMA
            and process.get("state") == "shutdown_unknown"
            and process.get("shutdown_error") == SHUTDOWN_ERROR
            and _positive_int(process.get("api_pid"))
            and process.get("accepted_store") == "/state/runs/docker-all/session-store"
            and isinstance(process.get("bootstrap"), dict)
            and isinstance(process.get("qualification"), str),
            "Native process receipt does not match the exact unknown-shutdown outcome")
    # Newer entrypoints add this immutable path as diagnostic metadata. It is
    # validated structurally only; this failure-only proof never opens it.
    if "api_failure_fence" in process:
        require(isinstance(process["api_failure_fence"], str)
                and re.fullmatch(
                    r"/opt/fullmag/runtime-control/runtime-service/api-failure-[0-9a-f]{32}[.]json",
                    process["api_failure_fence"],
                ) is not None,
                "Native API failure-fence path is outside its fixed namespace")
    process_owner = _validate_owner(process.get("service_owner"), require,
                                    "Process receipt owner")
    disk_owner = _validate_owner(owner, require, "OWNER.json")
    process_identity = {key: value for key, value in process_owner.items()
                        if key != "heartbeat_at"}
    disk_identity = {key: value for key, value in disk_owner.items()
                     if key != "heartbeat_at"}
    require(process_identity == disk_identity,
            "Ready owner identity changed beyond the independent heartbeat")
    return process, owner


def _validate_required_mounts(backend, control, require):
    volume = getattr(control, "volume", None)
    require(_nonempty(volume), "Control volume identity is unavailable")
    host_mounts = (backend.get("HostConfig") or {}).get("Mounts")
    require(isinstance(host_mounts, list), "Backend declared mounts are unavailable")
    observed_mounts = backend.get("Mounts")
    require(isinstance(observed_mounts, list), "Backend mounted volumes are unavailable")
    expected = {
        "/opt/fullmag/runtime-control": {"NoCopy": True, "Subpath": "runtime-control"},
        "/opt/fullmag/control": {"NoCopy": True},
    }
    for target, options in expected.items():
        declared = [mount for mount in host_mounts
                    if isinstance(mount, dict) and mount.get("Target") == target]
        require(len(declared) == 1, "Backend control mount is missing or duplicated: " + target)
        mount = declared[0]
        actual_options = mount.get("VolumeOptions")
        require(mount.get("Type") == "volume" and mount.get("Source") == volume
                and mount.get("ReadOnly", False) is False
                and isinstance(actual_options, dict) and actual_options == options,
                "Backend control mount source, access, or subpath differs: " + target)
        mounted = [entry for entry in observed_mounts
                   if isinstance(entry, dict) and entry.get("Destination") == target]
        require(len(mounted) == 1
                and mounted[0].get("Type") == "volume"
                and mounted[0].get("Name") == volume
                and mounted[0].get("RW") is True,
                "Backend control mount is not the pinned writable volume: " + target)


def _validate_stopped_pair(actual, request, proof, require):
    for name, finished_key, exit_key, expected_code in (
        ("backend", "backend_finished_at", "backend_exit_code", 1),
        ("frontend", "frontend_finished_at", "frontend_exit_code", 0),
    ):
        container = actual.get(name)
        require(isinstance(container, dict), "Stopped container inspection is missing: " + name)
        state = container.get("State")
        pin = request["containers"][name]
        require(isinstance(state, dict)
                and container.get("Id") == pin["id"]
                and container.get("Image") == pin["image"]
                and state.get("StartedAt") == pin["started_at"]
                and state.get("Status") == "exited"
                and state.get("Running") is False
                and state.get("Paused") is False
                and state.get("Restarting") is False
                and state.get("OOMKilled") is False
                and state.get("Dead") is False
                and type(state.get("Pid")) is int and state["Pid"] == 0
                and state.get("Error") == ""
                and state.get("FinishedAt") == proof[finished_key]
                and type(state.get("ExitCode")) is int
                and state["ExitCode"] == proof[exit_key] == expected_code,
                "Container is not the exact stopped failed-stop incarnation: " + name)


def _load_pinned(control, relative, expected, read_raw, digest, require, label):
    raw = read_raw(control, relative)
    require(digest(raw) == expected, label + " CAS differs")
    return raw


def _forbid_stop_checkpoints(control, root, read_raw, require):
    for name in _NO_STOP_CHECKPOINTS:
        require(read_raw(control, root + "/" + name, optional=True) is None,
                "Unexpected drain, authoring, diagnostic, startup, or build checkpoint: " + name)


def validate_failure_pin(proof):
    """Keep a local definition so call sites get a stable public validator."""
    import docker_volume_reconcile as reconciliation

    require = reconciliation.require
    require(isinstance(proof, dict) and set(proof) == _PROOF_KEYS,
            "Exact failed-stop proof fields required")
    digest_keys = _PROOF_KEYS - {
        "verified_sha256", "backend_finished_at", "frontend_finished_at",
        "backend_exit_code", "frontend_exit_code",
    }
    require(all(isinstance(proof[key], str) and reconciliation.SHA.fullmatch(proof[key])
                for key in digest_keys),
            "Invalid failed-stop evidence digest")
    verified = proof["verified_sha256"]
    require(verified is None or (
        isinstance(verified, str) and reconciliation.SHA.fullmatch(verified)
    ), "Invalid verified iteration digest")
    for key in ("backend_finished_at", "frontend_finished_at"):
        require(isinstance(proof[key], str) and proof[key].strip(),
                "Invalid failed-stop FinishedAt pin: " + key)
    require(type(proof["backend_exit_code"]) is int and proof["backend_exit_code"] == 1
            and type(proof["frontend_exit_code"]) is int and proof["frontend_exit_code"] == 0,
            "Only the pinned backend failure and clean frontend stop are supported")


def validate_failure(control, root, request, original, actual, state) -> dict:
    """Confirm stop failure only; native recovery remains required and drain unconfirmed."""
    import docker_volume_reconcile as reconciliation

    require, digest, canonical, read_raw = (
        reconciliation.require, reconciliation.digest,
        reconciliation.canonical, reconciliation.read_raw,
    )
    require(isinstance(request, dict), "Failed-stop request must be an object")
    proof = request.get("failure")
    validate_failure_pin(proof)
    require(request.get("schema") == SCHEMA
            and root == "iteration/attempts/" + request.get("attempt", ""),
            "Failed-stop request and operation root differ")
    helper_sha = request.get("failed_stop_helper_sha256")
    require(isinstance(helper_sha, str) and reconciliation.SHA.fullmatch(helper_sha)
            and digest(Path(__file__).read_bytes()) == helper_sha,
            "Failed-stop helper differs from the reviewed request")
    require(isinstance(original, dict)
            and original.get("schema") == "fullmag.docker-build-operation.v1"
            and original.get("phase") == "iteration"
            and original.get("attempt") == request["attempt"]
            and original.get("state") == "outcome-unknown-resources-retained"
            and original.get("error") == FAILED_STOP_ERROR,
            "Original operation is not the exact retained failed-stop outcome")
    inputs = original.get("inputs")
    require(isinstance(inputs, dict)
            and inputs.get("source_root") == request.get("source_root")
            and inputs.get("config_sha256") == request.get("config_sha256"),
            "Original failed-stop source or configuration differs")
    previous_attempt = inputs.get("attempt")
    require(isinstance(previous_attempt, str)
            and reconciliation.TOKEN.fullmatch(previous_attempt),
            "Original development attempt identity is invalid")

    previous_relative = "development/attempts/" + previous_attempt + "/terminal.json"
    previous_raw = _load_pinned(
        control, previous_relative, proof["previous_receipt_sha256"],
        read_raw, digest, require, "Previous development receipt",
    )
    previous = _decode(previous_raw, "Previous development receipt", require)
    require(previous.get("state") == "succeeded"
            and previous.get("attempt") == previous_attempt
            and previous.get("compose_project") == request.get("compose_project")
            and previous.get("config_sha256") == request.get("config_sha256")
            and previous.get("state_root") == original.get("state_root")
            and previous.get("backend_container") == request["containers"]["backend"]["id"]
            and previous.get("frontend_container") == request["containers"]["frontend"]["id"]
            and previous.get("backend_started_at")
                == request["containers"]["backend"]["started_at"],
            "Previous development resources or backend incarnation differ")

    preflight_relative = root + "/terminal-session-preflight.json"
    preflight_raw = _load_pinned(
        control, preflight_relative, proof["terminal_preflight_sha256"],
        read_raw, digest, require, "Terminal session preflight",
    )
    preflight = _decode(preflight_raw, "Terminal session preflight", require)
    require(original.get("terminal_session_preflight_sha256")
            == digest(canonical(preflight)),
            "Original terminal preflight canonical CAS differs")
    _validate_terminal_preflight(preflight, require)

    idle_raw = _load_pinned(
        control, root + "/idle-preflight.json", proof["idle_preflight_sha256"],
        read_raw, digest, require, "Idle preflight",
    )
    idle = _decode(idle_raw, "Idle preflight", require)
    _validate_idle_preflight(idle, require)

    process_raw = _load_pinned(
        control, "runtime-control/runtime-service/process-tree.json",
        proof["process_receipt_sha256"], read_raw, digest, require,
        "Native process receipt",
    )
    owner_raw = _load_pinned(
        control, "runtime-control/runtime-services/OWNER.json",
        proof["native_owner_sha256"], read_raw, digest, require,
        "Native OWNER.json",
    )
    process = _decode(process_raw, "Native process receipt", require)
    owner = _decode(owner_raw, "Native OWNER.json", require)
    _validate_native_records(process, owner, require)
    _validate_required_mounts(actual["backend"], control, require)
    _validate_stopped_pair(actual, request, proof, require)
    _forbid_stop_checkpoints(control, root, read_raw, require)

    verified_raw = read_raw(control, "iteration/verified.json", optional=True)
    if proof["verified_sha256"] is None:
        require(verified_raw is None, "A verified iteration appeared after the failed stop")
    else:
        require(verified_raw is not None and digest(verified_raw) == proof["verified_sha256"],
                "Last verified iteration CAS differs")

    # state is deliberately unused: validation does not inspect session-store,
    # leases, or any state-root user data.
    del state
    return {
        **proof,
        "native_recovery_required": True,
        "native_drain": "unconfirmed",
    }


def _path_fence(control, relative, expected, maximum, require):
    path = control.path(relative)
    require(isinstance(path, str) and re.fullmatch(r"/control/[A-Za-z0-9_./-]+", path),
            "Invalid read-only reconciliation fence path")
    parsed = PurePosixPath(path)
    require(parsed.is_absolute() and str(parsed) == path and ".." not in parsed.parts
            and parsed.parts[1] == "control",
            "Invalid read-only reconciliation fence path")
    quoted = shlex.quote(path)
    commands = []
    for parent in reversed(parsed.parents):
        parent_text = str(parent)
        if parent_text == "/" or not (
            parent_text == "/control" or parent_text.startswith("/control/")
        ):
            continue
        parent_quoted = shlex.quote(parent_text)
        commands.extend((
            "test ! -L " + parent_quoted,
            "test -d " + parent_quoted,
            'test "$(readlink -f ' + parent_quoted + ')" = ' + parent_quoted,
        ))
    commands.append("test ! -L " + quoted)
    if expected is None:
        commands.append("test ! -e " + quoted)
    else:
        require(isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected),
                "Invalid read-only reconciliation CAS")
        commands.extend((
            "test -f " + quoted,
            'test "$(stat -c %h ' + quoted + ')" = 1',
            'size=$(stat -c %s ' + quoted + '); test "$size" -le ' + str(maximum),
            'actual=$(sha256sum ' + quoted + " | cut -d' ' -f1); test \"$actual\" = '"
                + expected + "'",
        ))
    return "; ".join(commands)


def commit_fences(control, root, request) -> str:
    """Return read-only shell CAS checks for commit-time failure-only publication."""
    import docker_volume_reconcile as reconciliation
    from docker_build_control import MAX_DOCUMENT_BYTES

    require, digest, canonical, read_raw = (
        reconciliation.require, reconciliation.digest,
        reconciliation.canonical, reconciliation.read_raw,
    )
    proof = request.get("failure") if isinstance(request, dict) else None
    validate_failure_pin(proof)
    require(request.get("schema") == SCHEMA
            and root == "iteration/attempts/" + request.get("attempt", ""),
            "Failed-stop commit root differs from its request")
    helper_sha = request.get("failed_stop_helper_sha256")
    require(isinstance(helper_sha, str) and reconciliation.SHA.fullmatch(helper_sha)
            and digest(Path(__file__).read_bytes()) == helper_sha,
            "Failed-stop helper source changed before commit")

    # The observer script is assembled before unknown-receipt.json is created.
    # At that point the original bytes still live in receipt.json. Never fall
    # back after finding a present but mismatched unknown-receipt.json.
    unknown_raw = read_raw(control, root + "/unknown-receipt.json", optional=True)
    if unknown_raw is None:
        original_raw = read_raw(control, root + "/receipt.json")
    else:
        original_raw = unknown_raw
    require(digest(original_raw) == request.get("unknown_receipt_sha256"),
            "Unknown operation receipt CAS differs while preparing commit fences")
    original = _decode(original_raw, "Unknown operation receipt", require)
    require(original.get("schema") == "fullmag.docker-build-operation.v1"
            and original.get("phase") == "iteration"
            and original.get("attempt") == request.get("attempt")
            and original.get("state") == "outcome-unknown-resources-retained"
            and original.get("error") == FAILED_STOP_ERROR,
            "Unknown operation receipt is not the pinned failed-stop outcome")
    inputs = original.get("inputs")
    previous_attempt = inputs.get("attempt") if isinstance(inputs, dict) else None
    require(isinstance(previous_attempt, str)
            and reconciliation.TOKEN.fullmatch(previous_attempt)
            and inputs.get("source_root") == request.get("source_root")
            and inputs.get("config_sha256") == request.get("config_sha256"),
            "Unknown receipt has no pinned previous development attempt or source")

    previous_relative = "development/attempts/" + previous_attempt + "/terminal.json"
    previous_raw = _load_pinned(control, previous_relative, proof["previous_receipt_sha256"],
                                read_raw, digest, require, "Previous development receipt")
    preflight_relative = root + "/terminal-session-preflight.json"
    preflight_raw = _load_pinned(control, preflight_relative, proof["terminal_preflight_sha256"],
                                 read_raw, digest, require, "Terminal session preflight")
    preflight = _decode(preflight_raw, "Terminal session preflight", require)
    require(original.get("terminal_session_preflight_sha256") == digest(canonical(preflight)),
            "Terminal preflight canonical CAS differs before commit")
    _validate_terminal_preflight(preflight, require)
    idle_relative = root + "/idle-preflight.json"
    idle_raw = _load_pinned(control, idle_relative, proof["idle_preflight_sha256"],
                            read_raw, digest, require, "Idle preflight")
    _validate_idle_preflight(_decode(idle_raw, "Idle preflight", require), require)
    process_relative = "runtime-control/runtime-service/process-tree.json"
    owner_relative = "runtime-control/runtime-services/OWNER.json"
    process_raw = _load_pinned(control, process_relative, proof["process_receipt_sha256"],
                               read_raw, digest, require, "Native process receipt")
    owner_raw = _load_pinned(control, owner_relative, proof["native_owner_sha256"],
                             read_raw, digest, require, "Native OWNER.json")
    _validate_native_records(
        _decode(process_raw, "Native process receipt", require),
        _decode(owner_raw, "Native OWNER.json", require), require,
    )
    verified_relative = "iteration/verified.json"
    verified_raw = read_raw(control, verified_relative, optional=True)
    require((verified_raw is None and proof["verified_sha256"] is None)
            or (verified_raw is not None
                and proof["verified_sha256"] is not None
                and digest(verified_raw) == proof["verified_sha256"]),
            "Verified iteration state differs before commit")
    _forbid_stop_checkpoints(control, root, read_raw, require)

    guards = [
        _path_fence(control, previous_relative, proof["previous_receipt_sha256"],
                    MAX_DOCUMENT_BYTES, require),
        _path_fence(control, preflight_relative, proof["terminal_preflight_sha256"],
                    MAX_DOCUMENT_BYTES, require),
        _path_fence(control, idle_relative, proof["idle_preflight_sha256"],
                    MAX_DOCUMENT_BYTES, require),
        _path_fence(control, process_relative, proof["process_receipt_sha256"],
                    MAX_DOCUMENT_BYTES, require),
        _path_fence(control, owner_relative, proof["native_owner_sha256"],
                    MAX_DOCUMENT_BYTES, require),
        _path_fence(control, verified_relative, proof["verified_sha256"],
                    MAX_DOCUMENT_BYTES, require),
    ]
    guards.extend(
        _path_fence(control, root + "/" + name, None, MAX_DOCUMENT_BYTES, require)
        for name in _NO_STOP_CHECKPOINTS
    )
    return "; ".join(guards) + ";"
