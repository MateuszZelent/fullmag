"""Authenticate a stopped pre-API successor without changing its native stop proof."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import re
from types import SimpleNamespace
from typing import Mapping

from docker_build_control import BuildControlError, canonical, docker_capture
from docker_volume_capture_failure_reconcile import (
    TIMESTAMP, _container_state, validate_timestamped_log_streams,
)
from docker_volume_post_build_generation import _validate_actual_namespace


SCHEMA = "fullmag.docker-native-init-successor.v1"
POLICY_ERROR = "stored host resource policy differs from explicit ledger configuration"
UUID32 = re.compile(r"[0-9a-f]{32}\Z")


def _require(condition, message):
    if not condition:
        raise BuildControlError("Native init successor: " + message)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


class NativeInitSuccessorContext(dict):
    """Existing start kwargs plus separately authenticated replacement evidence."""

    def __init__(self, context, witness):
        super().__init__(context)
        self.witness = witness
        self.target_device_access = "gpu"


def validate_log_streams(streams, state):
    """Require the exact initialization traceback before any API handoff."""
    streams = validate_timestamped_log_streams(streams, state)
    combined = (streams["stdout"] + streams["stderr"]).decode("utf-8", "strict")
    forbidden = (
        "[fullmag-backend] Starting API and runtime service",
        "API ready", "API listening", "native runtime service ready",
    )
    _require(not any(marker in combined for marker in forbidden),
             "logs contain API/runtime admission")
    frames = (
        r'File "/opt/fullmag/entrypoint\.py", line [0-9]+, in serve',
        r'File "/opt/fullmag/runtime_service\.py", line [0-9]+, in ensure_configuration',
        r'File "/opt/fullmag/runtime_service\.py", line [0-9]+, in initialize_host_configuration',
    )
    matched = 0
    traceback_count = 0
    for stream in streams.values():
        lines = [TIMESTAMP.sub(b"", line, count=1).decode("utf-8", "strict")
                 for line in stream.splitlines() if line]
        lines = [line for line in lines if line.strip()]
        tracebacks = [i for i, line in enumerate(lines)
                      if line == "Traceback (most recent call last):"]
        traceback_count += len(tracebacks)
        if not tracebacks:
            continue
        tail = lines[tracebacks[-1] + 1:]
        cursor = 0
        for frame in frames:
            found = next((i for i in range(cursor, len(tail))
                          if re.search(frame, tail[i])), None)
            if found is None:
                break
            cursor = found + 1
        else:
            final = tail[-1] if tail else ""
            if (final.startswith("runtime_service.RuntimeServiceError: "
                                 "native Docker host profile initialization failed: ")
                    and final.endswith(POLICY_ERROR)):
                matched += 1
    _require(matched == 1 and traceback_count == 1,
             "logs lack one exact ordered host-policy initialization failure")
    return streams


def _read(control, relative, label):
    from docker_volume_dev import _read_canonical_control_record
    return _read_canonical_control_record(control, relative, label)


def _timestamp(value, label):
    _require(type(value) in (int, float) and math.isfinite(value) and value > 0,
             label + " has no finite timestamp")
    return value


def retained_context(control, previous, document, backend_id, *, fresh_state,
                     removed_container_proof=None):
    """Observe only. Publication and container replacement belong to the caller."""
    import docker_volume_dev as dev
    from docker_volume_pre_ack_retry import _released_snapshot
    from docker_volume_stop_unadmitted import _control_bytes

    inputs = previous.get("inputs", {})
    native = inputs.get("native_failed_restart")
    if (not isinstance(native, Mapping)
            or native.get("failure_kind") != "native-after-ready-failure"
            or native.get("container_id") == backend_id):
        return None
    _require(not fresh_state and removed_container_proof is None,
             "requires the exact still-retained stopped successor")
    _require(native.get("schema") == dev._NATIVE_STOP_RECREATE_METADATA_SCHEMA
             and native.get("claim_pending") is False,
             "original after-ready proof is incomplete")
    attempt = previous.get("attempt")
    _require(isinstance(attempt, str) and UUID32.fullmatch(attempt),
             "successor attempt is invalid")
    root = "development/attempts/" + attempt
    previous_raw, recorded = _read(control, root + "/terminal.json", "successor terminal")
    current_raw, current = _read(control, "development/current.json", "current development terminal")
    compose_raw, recorded_compose = _read(control, root + "/compose.json", "successor Compose")
    _require(recorded == previous and current == previous and current_raw == previous_raw
             and recorded_compose == document, "successor is not the current immutable terminal")
    _require(previous.get("schema") == "fullmag.docker-build-operation.v1"
             and previous.get("phase") == "development"
             and previous.get("state") == "failed-confirmed"
             and previous.get("compose_project") == control.project
             and previous.get("control_volume") == control.volume,
             "successor operation identity differs")
    _require(inputs.get("gpu_access_requested") == "auto"
             and dev._retained_device_access(previous, document) == "cpu",
             "successor does not prove the auto/GPU-to-CPU regression")
    _require(document.get("name") == control.project
             and inputs.get("source_root") == control.identity["source_root"],
             "successor source/project differs")
    _require(not any(key in inputs for key in
                     ("accepted_reattach", "post_build_generation"))
             and "container_recovery" not in previous,
             "successor carries unrelated recovery authority")
    environment = document["services"]["backend"]["environment"]
    _require(environment.get("FULLMAG_STARTUP_ENABLED") != "1"
             and _control_bytes(control, "activation/unresolved.json", optional=True) is None,
             "successor has startup Solve or unresolved activation")

    recreation_raw, recreation = _read(
        control, "recreate-services/current.json", "completed predecessor recreation")
    recreation_id = recreation.get("attempt")
    _require(isinstance(recreation_id, str) and UUID32.fullmatch(recreation_id),
             "predecessor recreation attempt is invalid")
    recreation_root = "recreate-services/attempts/" + recreation_id
    terminal_raw, terminal = _read(control, recreation_root + "/terminal.json",
                                   "predecessor recreation terminal")
    _require(terminal_raw == recreation_raw and terminal == recreation,
             "recreation pointer differs from its immutable terminal")
    prior_inputs = recreation.get("inputs", {})
    parent_id = prior_inputs.get("attempt")
    _require(isinstance(parent_id, str) and UUID32.fullmatch(parent_id)
             and parent_id != attempt, "predecessor development attempt is invalid")
    parent_root = "development/attempts/" + parent_id
    parent_raw, parent = _read(control, parent_root + "/terminal.json", "parent terminal")
    parent_compose_raw, parent_compose = _read(control, parent_root + "/compose.json",
                                              "parent Compose")
    snapshot_raw, snapshot = _read(control, recreation_root + "/retained-containers.json",
                                   "removed predecessor snapshot")
    parent_inputs = parent.get("inputs", {})
    identity = {
        "project_id": inputs.get("source_project_id"),
        "worktree_id": inputs.get("source_worktree_id"),
        "checkout_kind": inputs.get("source_checkout_kind"),
    }
    _require(all(isinstance(value, str) and value for value in identity.values()),
             "successor source identity is incomplete")
    _require(parent_inputs.get("source_root") == inputs.get("source_root")
             and all(parent_inputs.get("source_" + key) == value
                     for key, value in identity.items())
             and parent_inputs.get("image_id") == inputs.get("image_id")
             and parent_inputs.get("gpu_access_requested") == "auto"
             and dev._retained_device_access(parent, parent_compose) == "gpu",
             "parent does not authenticate the original auto/GPU profile")
    _require(parent.get("state_root") == previous.get("state_root")
             and parent.get("backend_volumes") == previous.get("backend_volumes")
             and parent.get("frontend_volume") == previous.get("frontend_volume"),
             "successor changed retained storage/cache")
    _require(_timestamp(recreation.get("finished_at"), "recreation finish")
             <= _timestamp(previous.get("started_at"), "successor start")
             <= _timestamp(previous.get("finished_at"), "successor finish"),
             "successor does not follow the completed predecessor removal")
    config_sha = _sha(canonical(parent_compose))
    _require(prior_inputs.get("config_sha256") == config_sha,
             "predecessor Compose CAS differs")
    args = SimpleNamespace(attempt=parent_id, config_sha256=config_sha)
    _, proof, context = dev._validate_removed_recreation_proof(
        args, control, parent, parent_compose, identity,
        operation_id=recreation_id, operation_raw=terminal_raw,
        operation_terminal=terminal, retained_raw=snapshot_raw, retained=snapshot,
        previous_raw=parent_raw, document_raw=parent_compose_raw,
        operator_probe_record=dev._operator_probe_record_from_retained(parent, parent_compose),
    )
    _require(proof.get("container_id") == native.get("container_id")
             and context.get("native_restart_metadata") == native
             and inputs.get("previous_config_sha256") == context.get("previous_config_sha256"),
             "original native restart context changed")

    observed = json.loads(dev.docker_text("inspect", backend_id))
    _require(isinstance(observed, list) and len(observed) == 1,
             "successor namespace is ambiguous")
    actual = observed[0]
    state = _container_state(actual, expected_exit=1)
    _require(type(actual.get("RestartCount")) is int and actual["RestartCount"] == 0
             and actual["State"].get("Error") == "",
             "successor was restarted or has a Docker lifecycle error")
    namespace = _validate_actual_namespace(
        actual, project=control.project, project_id=identity["project_id"],
        worktree_id=identity["worktree_id"], checkout_kind=identity["checkout_kind"],
        image_id=inputs["image_id"],
    )
    _require(actual.get("Id") == backend_id
             and previous.get("backend_started_at") == state["started_at"]
             and (previous.get("backend_container") in (None, backend_id)),
             "successor incarnation differs from its operation")
    image = json.loads(dev.docker_text("image", "inspect", inputs["image_id"]))
    _require(len(image) == 1 and image[0].get("Id") == inputs["image_id"],
             "successor immutable image is unavailable")
    dev._validate_retained_service(document, actual, "backend", image[0]["Config"])
    logs = docker_capture("logs", "--timestamps", "--since", state["started_at"],
                          "--until", state["finished_at"], backend_id, timeout=90)
    _require(logs.returncode == 0, "cannot read the exact stopped successor logs")
    streams = validate_log_streams({"stdout": logs.stdout, "stderr": logs.stderr}, state)
    released = _released_snapshot(control, actual)
    _require(isinstance(released, Mapping) and released.get("active_count") == 0,
             "host/local resources are not all released")
    # Keep the full exact log streams in the managed receipt, not only their hashes.
    witness = {
        "schema": SCHEMA, "successor_attempt": attempt, "compose_project": control.project,
        "control_volume": control.volume, "namespace": namespace,
        "successor_terminal_sha256": _sha(previous_raw),
        "successor_compose_sha256": _sha(compose_raw),
        "predecessor_attempt": parent_id, "predecessor_terminal_sha256": _sha(parent_raw),
        "predecessor_compose_sha256": _sha(parent_compose_raw),
        "recreation_attempt": recreation_id, "recreation_terminal_sha256": _sha(terminal_raw),
        "retained_snapshot_sha256": _sha(snapshot_raw), "removed_predecessor": proof,
        "original_native_restart": dict(native),
        "previous_config_sha256": context["previous_config_sha256"],
        "observed_device_access": "cpu", "target_device_access": "gpu",
        "released_observation": released,
        "logs": {name: {"sha256": _sha(raw), "base64": base64.b64encode(raw).decode("ascii")}
                 for name, raw in streams.items()},
    }
    _require(len(canonical(witness)) <= 7 * 1024 * 1024, "witness exceeds its byte bound")
    return NativeInitSuccessorContext(context, witness)
