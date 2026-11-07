"""Stop one pinned DEV backend that retains only a fenced diagnostic API.

This command preserves the failed native owner and all durable leases.  It
stops the exact backend supervisor/API pair after authenticating the failure
fence and proving that the native owner, schedulers, and workers are absent.
The resulting receipt deliberately records execution state as unknown.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
import re
import shlex
import sys
import time

from docker_build_control import (
    BuildControl,
    BuildControlError,
    canonical,
    compose_capture,
    control_read_script,
    docker_capture,
    toolchain_configuration,
)
from docker_dev_host import require_host


ATTEMPT_RE = re.compile(r"[0-9a-f]{32}\Z")
CONTAINER_RE = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
MAX_EVIDENCE_BYTES = 1024 * 1024
PROCESS_RECEIPT_PATH = "/opt/fullmag/runtime-control/runtime-service/process-tree.json"
OWNER_PATH = "/opt/fullmag/runtime-control/runtime-services/OWNER.json"
RUNTIME_CONFIG_PATH = "/opt/fullmag/runtime-control/runtime-service/docker-all.json"
FENCE_PARENT = "/opt/fullmag/runtime-control/runtime-service"
STARTUP_RECOVERY_PROBE_SCHEMA = "fullmag.docker-startup-recovery-stop-probe.v1"
STARTUP_RECOVERY_STOP_SCHEMA = "fullmag.docker-startup-recovery-stop.v1"
STARTUP_RECOVERY_FAILURE_SUFFIX = (
    "\nError: unapplied terminal heartbeat requires a failed nonzero process-exit receipt"
)


def _fail(message: str) -> None:
    raise BuildControlError(message)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _single_id(value: bytes, label: str) -> str:
    rows = value.decode("utf-8", "strict").splitlines()
    if len(rows) != 1 or CONTAINER_RE.fullmatch(rows[0]) is None:
        _fail("Compose did not identify one exact " + label)
    return rows[0]


def _port_matches(document: Mapping[str, object], port: int) -> None:
    services = document.get("services")
    frontend = services.get("frontend") if isinstance(services, Mapping) else None
    ports = frontend.get("ports") if isinstance(frontend, Mapping) else None
    if not isinstance(ports, list) or len(ports) != 1:
        _fail("Retained Compose frontend port is ambiguous")
    binding = ports[0]
    if (not isinstance(binding, Mapping)
            or binding.get("host_ip") != "127.0.0.1"
            or binding.get("target") != 8080
            or binding.get("protocol") != "tcp"
            or binding.get("mode") != "ingress"
            or binding.get("published") != str(port)):
        _fail("Requested port differs from the retained Compose frontend")


def _validate_startup_recovery_development(control, previous, selected, config_sha256, actual):
    """Qualify only the failed initial start and its retained cgroup admission."""
    inputs = previous.get("inputs")
    cgroup = previous.get("worker_cgroup")
    if (previous.get("schema") != "fullmag.docker-build-operation.v1"
            or previous.get("phase") != "development"
            or previous.get("state") != "failed-confirmed"
            or previous.get("compose_project") != control.project
            or previous.get("control_volume") != control.volume
            or previous.get("config_sha256") not in (None, config_sha256)
            or not isinstance(inputs, Mapping)
            or inputs.get("source_root") != str(selected)
            or not isinstance(inputs.get("image_id"), str)
            or IMAGE_RE.fullmatch(inputs["image_id"]) is None):
        _fail("Startup recovery requires the exact failed-confirmed development terminal")
    if control.namespace:
        if previous.get("control_namespace") != control.namespace:
            _fail("Startup recovery terminal belongs to another control namespace")
    elif "control_namespace" in previous:
        _fail("Startup recovery terminal has an unexpected control namespace")
    backend_id, frontend_id = previous.get("backend_container"), previous.get("frontend_container")
    if (not isinstance(backend_id, str) or CONTAINER_RE.fullmatch(backend_id) is None
            or not isinstance(frontend_id, str) or CONTAINER_RE.fullmatch(frontend_id) is None
            or backend_id == frontend_id):
        _fail("Startup recovery terminal does not pin the exact backend/frontend pair")
    if not isinstance(cgroup, Mapping):
        _fail("Startup recovery terminal has no ready worker cgroup pin")
    if (cgroup.get("schema") != "fullmag.worker-cgroup-ready.v1"
            or cgroup.get("state") != "ready"
            or cgroup.get("compose_project") != control.project
            or cgroup.get("container_id") != backend_id
            or cgroup.get("image_id") != inputs["image_id"]
            or cgroup.get("root") != "/opt/fullmag/worker-cgroup"
            or not isinstance(cgroup.get("nonce"), str)
            or re.fullmatch(r"[0-9a-f]{32}", cgroup["nonce"]) is None
            or type(cgroup.get("pid")) is not int or cgroup["pid"] <= 0
            or not isinstance(cgroup.get("process_start_token"), str)
            or not cgroup["process_start_token"]
            or not isinstance(cgroup.get("boot_id"), str)
            or not cgroup["boot_id"]
            or type(cgroup.get("root_device")) is not int or cgroup["root_device"] < 0
            or type(cgroup.get("root_inode")) is not int or cgroup["root_inode"] <= 0
            or "cpu" not in cgroup.get("controllers", [])
            or "cpu" not in cgroup.get("subtree_control", [])
            or cgroup.get("delegated_uid") != 65532
            or cgroup.get("delegated_gid") != 65532):
        _fail("Startup recovery cgroup pin is incomplete or belongs to another backend")
    for service, identifier in (("backend", backend_id), ("frontend", frontend_id)):
        row = actual.get(service)
        state = row.get("State") if isinstance(row, Mapping) else None
        started = previous.get(service + "_started_at")
        if (not isinstance(row, Mapping) or row.get("Id") != identifier
                or row.get("Image") != inputs["image_id"]
                or not isinstance(state, Mapping) or state.get("Running") is not True
                or not isinstance(started, str) or not started
                or state.get("StartedAt") != started
                or state.get("OOMKilled") is True):
            _fail("Startup recovery service differs from its retained running incarnation: " + service)
    return dict(cgroup)


def _validate_startup_recovery_native_receipt(receipt, authorization, request):
    """Accept an absent or exact prepared receipt; a completed receipt is not this path."""
    if receipt is None:
        return None
    if not isinstance(receipt, Mapping):
        _fail("Native container-recovery receipt is malformed")
    required = {
        "schema_version", "request_id", "request_sha256", "status", "outcome", "target_id",
        "config_sha256", "owner_state_before", "owner_sha256_before", "owner_state_after",
        "owner_sha256_after", "store_root_sha256", "application", "ledger_root_sha256",
        "ledger_snapshot_sha256", "attestation_sha256", "docker_manifest_sha256",
        "prior_ready_owner_proof_sha256", "device_release_mapping_sha256",
        "archived_evidence_path", "archived_evidence_sha256", "archived_files",
        "historical_build_commit", "historical_build_snapshot", "executor_build_commit",
        "executor_build_snapshot", "created_at", "completed_at",
    }
    allowed = required | {"archived_absent_sources"}
    if (not required.issubset(receipt) or set(receipt) - allowed
            or receipt.get("schema_version") != "runtime_service_container_recovery.v1"
            or receipt.get("status") != "prepared" or receipt.get("completed_at") is not None):
        _fail("Native container-recovery receipt is complete or unsupported")
    expected_owner = request.get("expected_owner")
    if not isinstance(expected_owner, Mapping):
        _fail("Native container-recovery request has no exact ready-owner pin")
    try:
        from docker_volume_container_recovery import expected_recovery_outcome
        expected_outcome = expected_recovery_outcome(request)
    except (BuildControlError, TypeError, ValueError, KeyError) as error:
        raise BuildControlError("Native recovery request outcome is not authentic") from error
    expected = {
        "request_id": authorization.get("request_id"),
        "request_sha256": authorization.get("native_request_sha256"),
        "outcome": expected_outcome,
        "target_id": expected_owner.get("target_id"),
        "config_sha256": request.get("config_sha256"),
        "owner_state_before": expected_owner.get("state"),
        "owner_sha256_before": request.get("owner_sha256"),
        "owner_state_after": "failed",
        "store_root_sha256": request.get("store_root_sha256"),
        "application": request.get("application"),
        "ledger_root_sha256": request.get("ledger_root_sha256"),
        "ledger_snapshot_sha256": request.get("ledger_snapshot_sha256"),
        "attestation_sha256": authorization.get("attestation_sha256"),
        "docker_manifest_sha256": authorization.get("manifest_sha256"),
        "prior_ready_owner_proof_sha256": request.get("prior_ready_owner_proof_sha256"),
        "device_release_mapping_sha256": request.get("device_release_mapping_sha256"),
        "historical_build_commit": expected_owner.get("build_commit"),
        "historical_build_snapshot": expected_owner.get("build_snapshot"),
    }
    if any(receipt.get(key) != value for key, value in expected.items()):
        _fail("Prepared native container-recovery receipt differs from its request")
    if (expected_owner.get("state") != "ready"
            or not isinstance(receipt.get("owner_sha256_after"), str)
            or SHA256_RE.fullmatch(receipt["owner_sha256_after"]) is None
            or receipt["owner_sha256_after"] == request.get("owner_sha256")
            or not isinstance(receipt.get("archived_evidence_path"), str)
            or not receipt["archived_evidence_path"].startswith("/state/")
            or not isinstance(receipt.get("archived_files"), Mapping)
            or not receipt["archived_files"]
            or not isinstance(receipt.get("archived_absent_sources", {}), Mapping)
            or not isinstance(receipt.get("created_at"), str)
            or not receipt["created_at"]):
        _fail("Prepared native container-recovery receipt is incomplete")
    for field in ("archived_evidence_sha256", "executor_build_snapshot"):
        if not isinstance(receipt.get(field), str) or SHA256_RE.fullmatch(receipt[field]) is None:
            _fail("Prepared native container-recovery receipt has an invalid " + field)
    for field in ("historical_build_commit", "executor_build_commit"):
        if not isinstance(receipt.get(field), str) or re.fullmatch(r"[0-9a-f]{40}", receipt[field]) is None:
            _fail("Prepared native container-recovery receipt has an invalid " + field)
    return dict(receipt)


def _validate_startup_recovery_observation(probe, authorization, request, expected_cgroup,
                                           storage_proof, released_snapshot,
                                           operator_authorization=None):
    """Requalify guest, pending authority, store, leases, and historical bytes."""
    from docker_volume_stop_failed import _validate_native_ready_owner

    if not isinstance(probe, Mapping) or probe.get("schema") != STARTUP_RECOVERY_PROBE_SCHEMA:
        _fail("Startup recovery guest observation has an unsupported schema")
    raw_fields = ("runtime_config", "owner", "launch", "process_receipt", "failure_fence",
                  "provenance", "worker_cgroup", "worker_cgroup_request")
    raw = {name: _decode_probe(probe, name) for name in raw_fields}
    values = {name: _json(data, "startup recovery " + name.replace("_", " "))
              for name, data in raw.items()}
    owner = _validate_native_ready_owner(values["owner"])
    config, launch = values["runtime_config"], values["launch"]
    process, fence, provenance = (values["process_receipt"], values["failure_fence"], values["provenance"])
    if (operator_authorization is not None
            and _sha256(raw["process_receipt"]) != operator_authorization.get("process_receipt_sha256")):
        _fail("Historical process-tree bytes differ from the original operator authorization")
    if (config.get("schema_version") != "runtime_service_config.v2"
            or config.get("target_id") != "docker-all"
            or config.get("store_root") != "/state/runs/docker-all/session-store"
            or launch.get("schema_version") != "runtime_service_launch.v1"
            or launch.get("state") != "ready"):
        _fail("Startup recovery configuration or launch record is not canonical")
    if (process.get("schema") != "fullmag.docker-process-tree.v1"
            or process.get("state") != "shutdown_unknown"
            or "service_owner" in process or "terminal_service_owner" in process
            or process.get("runtime_pid") is not None
            or process.get("startup_activation") is not None
            or type(process.get("api_pid")) is not int or process["api_pid"] <= 0
            or type(process.get("api_exit_code")) is not int or process["api_exit_code"] == 0
            or not isinstance(process.get("api_failure_fence"), str)):
        _fail("Historical process tree is not the original shutdown-unknown record")
    old_fence_relative = _runtime_relative(process["api_failure_fence"])
    current_fence_relative = _runtime_relative(probe.get("api_failure_fence"))
    reason = fence.get("reason")
    if (fence.get("schema") != "fullmag.api-runtime-failure-fence.v1"
            or fence.get("stage") != "runtime_startup"
            or not isinstance(reason, str)
            or not reason.startswith("runtime CLI failed: [fullmag] version:")
            or not reason.endswith(STARTUP_RECOVERY_FAILURE_SUFFIX)
            or old_fence_relative == current_fence_relative):
        _fail("Live failure fence is not the exact retained-terminal startup failure")
    commit = provenance.get("commit")
    snapshot = provenance.get("native_source_identity", {}).get("source_snapshot_sha256")
    if (not isinstance(commit, str) or re.fullmatch(r"[0-9a-f]{40}", commit) is None
            or not isinstance(snapshot, str) or SHA256_RE.fullmatch(snapshot) is None
            or ("| commit: " + commit) not in reason or ("| source snapshot: " + snapshot) not in reason):
        _fail("Startup failure fence build identity differs from published provenance")
    instance = probe.get("api_instance_id")
    if not isinstance(instance, str) or UUID_RE.fullmatch(instance) is None:
        _fail("Startup API instance identity is incomplete")
    process_ids = probe.get("process_ids")
    if (not isinstance(process_ids, list) or len(process_ids) != 4
            or len(set(process_ids)) != 4 or 1 not in process_ids
            or probe.get("api_pid") not in process_ids
            or probe.get("supervisor_pid") not in process_ids
            or probe.get("probe_pid") not in process_ids
            or process.get("api_pid") in process_ids):
        _fail("Startup API process inventory differs from its exact current PID tree")
    if probe.get("owner_pids_absent") != sorted(
            [owner["pid"], *(child["pid"] for child in owner["children"])]):
        _fail("Historical ready owner or scheduler PID is not proven absent")
    if (probe.get("health_status") != 200
            or probe.get("health") != {"status": "degraded", "active_session": False}
            or probe.get("health_instance_id") != instance
            or probe.get("openapi_status") != 200
            or probe.get("build_identity") != {"git_commit": commit,
                                                "source_snapshot_sha256": snapshot}
            or probe.get("current_status") != 503
            or not isinstance(probe.get("current_status_body"), Mapping)
            or probe["current_status_body"].get("code") != "runtime_unavailable"):
        _fail("Live API health, build identity, or execution-disabled status changed")
    if values["worker_cgroup"] != dict(expected_cgroup):
        _fail("Live ready cgroup receipt differs from the failed development terminal")
    cgroup = values["worker_cgroup"]
    cgroup_request = values["worker_cgroup_request"]
    if cgroup_request.get("schema") != "fullmag.worker-cgroup-request.v1":
        _fail("Worker cgroup request schema differs")
    for key in ("compose_project", "container_id", "nonce", "pid",
                "process_start_token", "boot_id"):
        if cgroup_request.get(key) != cgroup.get(key):
            _fail("Worker cgroup request differs from its ready receipt: " + key)
    if cgroup.get("pid") != probe.get("supervisor_pid"):
        _fail("Ready cgroup process pin differs from the live backend supervisor")
    hashes = {name: _sha256(raw[name]) for name in raw}
    expected_hashes = {
        "runtime_config": authorization.get("config_sha256"),
        "owner": authorization.get("owner_sha256"),
        "launch": authorization.get("launch_sha256"),
    }
    if any(hashes[name] != digest for name, digest in expected_hashes.items()):
        _fail("Startup recovery OWNER/configuration/launch bytes differ from authorization")
    if (request.get("request_id") != authorization.get("request_id")
            or request.get("config_sha256") != hashes["runtime_config"]
            or request.get("owner_sha256") != hashes["owner"]
            or request.get("launch_sha256") != hashes["launch"]
            or request.get("expected_owner") != owner):
        _fail("Native recovery request differs from current retained owner/configuration")
    storage_hashes = ("store_root_sha256", "ledger_root_sha256", "ledger_snapshot_sha256")
    if (not isinstance(storage_proof, Mapping)
            or any(storage_proof.get(key) != request.get(key) for key in storage_hashes)):
        _fail("Current store/ledger inventory differs from the pending native request")
    if (not isinstance(released_snapshot, Mapping)
            or released_snapshot.get("active_count") != 0
            or any(row.get("state") != "released" for row in released_snapshot.get("reservations", [])
                   if isinstance(row, Mapping))
            or any(row.get("state") != "released" for row in released_snapshot.get("leases", [])
                   if isinstance(row, Mapping))):
        _fail("A store/ledger reservation or execution lease remains active")
    return {
        "runtime_config_sha256": hashes["runtime_config"],
        "owner_sha256": hashes["owner"],
        "launch_sha256": hashes["launch"],
        "historical_process_receipt_sha256": hashes["process_receipt"],
        "startup_failure_fence_sha256": hashes["failure_fence"],
        "provenance_sha256": hashes["provenance"],
        "worker_cgroup_ready_sha256": hashes["worker_cgroup"],
        "worker_cgroup_request_sha256": hashes["worker_cgroup_request"],
        "api_instance_id": instance,
        "api_pid": probe["api_pid"],
        "supervisor_pid": probe["supervisor_pid"],
        "process_ids": sorted(pid for pid in process_ids if pid != probe["probe_pid"]),
        "api_process": dict(probe["api_process"]),
        "supervisor_process": dict(probe["supervisor_process"]),
        "owner_pids_absent": list(probe["owner_pids_absent"]),
        "api_failure_fence": probe["api_failure_fence"],
        "build_commit": commit,
        "build_snapshot": snapshot,
    }


def _read_raw(control: BuildControl, relative: str, *, maximum: int = MAX_EVIDENCE_BYTES) -> bytes:
    from docker_volume_unclaimed_cancellation import _control_raw

    raw = _control_raw(control, relative, maximum=maximum)
    if raw is None:
        _fail("Required control-volume evidence is missing: " + relative)
    return raw


def _optional_sidecar_sha256(control: BuildControl, previous_root: str) -> str | None:
    from docker_volume_unclaimed_cancellation import _control_raw

    raw = _control_raw(
        control, previous_root + "/process-failure.json", optional=True,
        maximum=MAX_EVIDENCE_BYTES,
    )
    return _sha256(raw) if raw is not None else None


def _json(raw: bytes, label: str) -> dict[str, object]:
    from docker_volume_unclaimed_cancellation import _json_object

    return _json_object(raw, label, maximum=MAX_EVIDENCE_BYTES)


def _runtime_relative(path: object) -> str:
    if not isinstance(path, str) or not path.startswith(FENCE_PARENT + "/"):
        _fail("API failure fence is outside the canonical runtime-service directory")
    name = path[len(FENCE_PARENT) + 1 :]
    if re.fullmatch(r"api-failure-[0-9a-f]{32}\.json", name) is None:
        _fail("API failure fence filename is not an exact incarnation marker")
    return "runtime-control/runtime-service/" + name


def _validate_resume_terminal(
    control: BuildControl,
    resume_attempt: object,
    *,
    development_attempt: str,
    config_sha256: str,
    previous: Mapping[str, object],
    phase: str = "resume",
) -> dict[str, object]:
    if phase not in {"resume", "iteration"}:
        _fail("Unsupported backend continuation phase")
    if not isinstance(resume_attempt, str) or ATTEMPT_RE.fullmatch(resume_attempt) is None:
        _fail("Resume attempt is not a complete lowercase identity")
    relative = phase + "/attempts/" + resume_attempt + "/terminal.json"
    raw = _read_raw(control, relative)
    receipt = _json(raw, "retained resume terminal")
    inputs = receipt.get("inputs")
    previous_inputs = previous.get("inputs")
    expected_state_root = previous.get("state_root")
    expected_backend = previous.get("backend_container")
    expected_frontend = previous.get("frontend_container")
    image = previous_inputs.get("image_id") if isinstance(previous_inputs, Mapping) else None
    # A build can fail before _finish records the service IDs in the initial
    # development terminal. Its successful linked resume is then the identity
    # authority; validate that complete existing contract before adopting IDs.
    if expected_backend is None or expected_frontend is None:
        from docker_volume_activate import _validate_linked_runtime_terminal
        _validate_linked_runtime_terminal(
            receipt, phase=phase, original_attempt=development_attempt,
            original=previous, source_root=previous_inputs.get("source_root"),
            image=image, config_sha256=config_sha256,
        )
        expected_backend = expected_backend or receipt.get("backend_container")
        expected_frontend = expected_frontend or receipt.get("frontend_container")
    cgroup = receipt.get("worker_cgroup")
    if (
        receipt.get("schema") != "fullmag.docker-build-operation.v1"
        or receipt.get("phase") != phase
        or receipt.get("state") != "succeeded"
        or receipt.get("attempt") != resume_attempt
        or receipt.get("compose_project") != control.project
        or receipt.get("control_volume") != control.volume
        or receipt.get("config_sha256") != config_sha256
        or not isinstance(inputs, Mapping)
        or inputs.get("attempt") != development_attempt
        or inputs.get("config_sha256") != config_sha256
        or not isinstance(expected_state_root, str)
        or not expected_state_root
        or receipt.get("state_root") != expected_state_root
        or not isinstance(expected_backend, str)
        or CONTAINER_RE.fullmatch(expected_backend) is None
        or receipt.get("backend_container") != expected_backend
        or not isinstance(expected_frontend, str)
        or CONTAINER_RE.fullmatch(expected_frontend) is None
        or receipt.get("frontend_container") != expected_frontend
        or not isinstance(image, str)
        or IMAGE_RE.fullmatch(image) is None
        or not isinstance(cgroup, Mapping)
        or cgroup.get("schema") != "fullmag.worker-cgroup-ready.v1"
        or cgroup.get("compose_project") != control.project
        or cgroup.get("container_id") != expected_backend
        or cgroup.get("image_id") != image
        or cgroup.get("state") != "ready"
        or cgroup.get("root") != "/opt/fullmag/worker-cgroup"
    ):
        _fail("Resume terminal is not the exact successful continuation of this development attempt")
    expected_namespace = previous.get("control_namespace")
    if control.namespace:
        if (expected_namespace != control.namespace
                or receipt.get("control_namespace") != control.namespace):
            _fail("Resume terminal belongs to a different control namespace")
    elif "control_namespace" in receipt or "control_namespace" in previous:
        _fail("Resume terminal or development attempt has an unexpected control namespace")
    started_at = receipt.get("backend_started_at")
    if not isinstance(started_at, str) or not started_at:
        _fail("Resume terminal does not pin the backend start time")
    return {
        "attempt": resume_attempt,
        "phase": phase,
        "relative": relative,
        "sha256": _sha256(raw),
        "backend_started_at": started_at,
        "backend_container": expected_backend,
        "frontend_container": expected_frontend,
    }


def _validate_failed_iteration_terminal(control, attempt, expected_sha256, *,
                                        development_attempt, config_sha256, previous):
    """Authenticate an explicit failed frontend probe; never promote its state."""
    if (not isinstance(attempt, str) or ATTEMPT_RE.fullmatch(attempt) is None
            or not isinstance(expected_sha256, str) or SHA256_RE.fullmatch(expected_sha256) is None):
        _fail("Failed iteration requires its exact attempt and terminal SHA-256")
    relative = "iteration/attempts/" + attempt + "/terminal.json"
    raw = _read_raw(control, relative)
    receipt = _json(raw, "failed iteration terminal")
    inputs = receipt.get("inputs", {})
    original_inputs = previous.get("inputs", {})
    error = receipt.get("error", "")
    expected = {"schema": "fullmag.docker-build-operation.v1", "phase": "iteration",
                "state": "failed-confirmed", "attempt": attempt,
                "compose_project": control.project, "control_volume": control.volume,
                "config_sha256": config_sha256, "state_root": previous.get("state_root"),
                "backend_container": previous.get("backend_container"),
                "frontend_container": previous.get("frontend_container"),
                "control_namespace": previous.get("control_namespace")}
    if (_sha256(raw) != expected_sha256 or not isinstance(inputs, Mapping)
            or any(receipt.get(key) != value for key, value in expected.items())
            or inputs.get("attempt") != development_attempt
            or inputs.get("config_sha256") != config_sha256
            or any(inputs.get(key) != original_inputs.get(key) for key in ("source_root", "image_id"))
            or not isinstance(error, str) or "linux_native_probe.py" not in error
            or re.search(r"OSError: \[Errno 28\] No space left on device: '/state/\.linux-native-probe-[^'\n]+'$", error) is None
            or any(not isinstance(receipt.get(key), str) or not receipt[key]
                   for key in ("backend_started_at", "frontend_started_at"))):
        _fail("Failed iteration is not the exact retained frontend ENOSPC probe")
    return {"attempt": attempt, "phase": "iteration", "relative": relative,
            "sha256": expected_sha256, "backend_started_at": receipt["backend_started_at"],
            "frontend_started_at": receipt["frontend_started_at"],
            "backend_container": receipt["backend_container"],
            "frontend_container": receipt["frontend_container"], "failed_iteration": True}


def _probe_script() -> str:
    import inspect
    from docker_dev_recovery_build import require, validate_diagnostic_build

    # The shared check authenticates Unknown identity only. The probe below
    # independently requires the exact fenced API and absence of every worker.
    prefix = inspect.getsource(require) + "\n" + inspect.getsource(validate_diagnostic_build) + "\n"
    return prefix + r'''import base64, hashlib, json, os, pathlib, re, stat, sys, urllib.request

MAX=1024*1024
PROCESS='/opt/fullmag/runtime-control/runtime-service/process-tree.json'
OWNER='/opt/fullmag/runtime-control/runtime-services/OWNER.json'
CONFIG='/opt/fullmag/runtime-control/runtime-service/docker-all.json'
FENCE_PARENT=pathlib.Path('/opt/fullmag/runtime-control/runtime-service')

def regular(path, label, maximum=MAX):
    path=pathlib.Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise RuntimeError(label+' path is not canonical')
    if path.parent.resolve(strict=True) != path.parent:
        raise RuntimeError(label+' parent is not canonical')
    fd=os.open(path, os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > maximum:
            raise RuntimeError(label+' is not a bounded regular file')
        raw=os.read(fd, maximum+1)
        if len(raw)>maximum:
            raise RuntimeError(label+' exceeds its byte bound')
        return raw
    finally: os.close(fd)

def unique(pairs):
    value={}
    for key,item in pairs:
        if key in value: raise RuntimeError('duplicate JSON key')
        value[key]=item
    return value

def obj(raw,label):
    try: value=json.loads(raw.decode('utf-8'), object_pairs_hook=unique)
    except (UnicodeDecodeError,json.JSONDecodeError) as error:
        raise RuntimeError(label+' is invalid JSON') from error
    if not isinstance(value,dict): raise RuntimeError(label+' is not an object')
    return value

process_raw=regular(PROCESS,'process receipt')
owner_raw=regular(OWNER,'runtime owner')
config_raw=regular(CONFIG,'runtime configuration')
process=obj(process_raw,'process receipt')
owner=obj(owner_raw,'runtime owner')
config=obj(config_raw,'runtime configuration')
if (process.get('schema')!='fullmag.docker-process-tree.v1'
        or process.get('state')!='failed_outcome_retained'
        or process.get('api_diagnostic_only') is not True
        or process.get('runtime_pid') is not None
        or not isinstance(process.get('service_owner'),dict)
        or 'terminal_service_owner' in process):
    raise RuntimeError('process receipt is not the exact retained diagnostic-only API state')
if type(process.get('api_pid')) is not int or process['api_pid']<=0:
    raise RuntimeError('retained diagnostic API pid is invalid')
if not isinstance(process.get('error'),str) or not process['error']:
    raise RuntimeError('retained process receipt has no failure detail')
if (config.get('schema_version')!='runtime_service_config.v2'
        or config.get('target_id')!='docker-all'
        or config.get('store_root')!='/state/runs/docker-all/session-store'):
    raise RuntimeError('runtime configuration is not bound to the managed store')

sys.path.insert(0,'/opt/fullmag')
import runtime_service
paths=runtime_service.canonical_paths()
if owner.get('state')=='unknown':
    validate_diagnostic_build(process,owner)
else:
    runtime_service._validate_terminal_owner(
        owner,state='failed',name='retained failed runtime owner',
        allowed_child_statuses=('exited_success','exited_failure'))
ready_owner=process['service_owner']
runtime_service._validate_terminal_owner(ready_owner,state='ready',name='retained ready owner pin')
if (runtime_service._owner_identity(ready_owner)!=runtime_service._owner_identity(owner)
        or runtime_service._owner_child_identity(ready_owner)!=runtime_service._owner_child_identity(owner)):
    raise RuntimeError('retained ready owner pin differs from the failed OWNER identity')
if runtime_service._read_json(paths.config,'runtime service configuration')!=config:
    raise RuntimeError('runtime configuration changed during read')

failure_path=process.get('api_failure_fence')
if (not isinstance(failure_path,str) or pathlib.Path(failure_path).parent!=FENCE_PARENT
        or FENCE_PARENT.resolve(strict=True)!=FENCE_PARENT):
    raise RuntimeError('runtime receipt does not bind a canonical API failure fence')
failure_name=pathlib.Path(failure_path).name
if re.fullmatch(r'api-failure-[0-9a-f]{32}\.json',failure_name) is None:
    raise RuntimeError('API failure fence filename is invalid')
fence_raw=regular(failure_path,'API failure fence',256*1024)
fence=obj(fence_raw,'API failure fence')
api_pid=process['api_pid']
api_instance=fence.get('api_instance_id')
if (fence.get('schema')!='fullmag.api-runtime-failure-fence.v1'
        or fence.get('stage')!='runtime_supervision'
        or fence.get('api_pid')!=api_pid
        or not isinstance(api_instance,str)
        or re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',api_instance) is None):
    raise RuntimeError('API failure fence is not bound to this runtime-supervision failure')

owner_pids=[owner.get('pid')]
children=owner.get('children')
if not isinstance(children,list) or len(children)!=2:
    raise RuntimeError('failed owner does not identify both native schedulers')
for child in children:
    if not isinstance(child,dict) or type(child.get('pid')) is not int:
        raise RuntimeError('failed owner child identity is invalid')
    owner_pids.append(child['pid'])
if any(type(pid) is not int or pid<=0 or pathlib.Path('/proc/'+str(pid)).exists()
       for pid in owner_pids):
    raise RuntimeError('failed owner or a native scheduler is still present in /proc')

def proc(pid):
    root=pathlib.Path('/proc')/str(pid)
    status=(root/'status').read_text(encoding='utf-8')
    match=re.search(r'^PPid:\s+(\d+)$',status,re.MULTILINE)
    if match is None: raise RuntimeError('process parent identity is unavailable')
    return {
        'pid':pid,
        'ppid':int(match.group(1)),
        'comm':(root/'comm').read_text(encoding='utf-8').strip(),
        'exe':os.readlink(root/'exe'),
        'argv':(root/'cmdline').read_bytes().split(b'\0'),
    }

rows=[]
for item in pathlib.Path('/proc').iterdir():
    if item.name.isdigit(): rows.append(proc(int(item.name)))
by_pid={row['pid']:row for row in rows}
self_pid=os.getpid()
if self_pid not in by_pid: raise RuntimeError('current bounded probe is absent from /proc')
init=by_pid.get(1)
if init is None or init['comm'] not in {'docker-init','tini'}:
    raise RuntimeError('container init identity is unexpected')
supervisors=[row for row in rows if row['pid']!=1 and any(
    arg==b'/opt/fullmag/entrypoint.py' for arg in row['argv'])]
if len(supervisors)!=1:
    raise RuntimeError('backend supervisor process is missing or ambiguous')
supervisor=supervisors[0]
if supervisor['ppid']!=1 or not pathlib.Path(supervisor['exe']).name.startswith('python3'):
    raise RuntimeError('backend supervisor parent or executable differs')
api=by_pid.get(api_pid)
if api is None or api['ppid']!=supervisor['pid'] or not api['exe'].endswith('/fullmag-api'):
    raise RuntimeError('retained API process identity differs from its receipt')
if len({1,supervisor['pid'],api_pid,self_pid})!=4 or set(by_pid)!={1,supervisor['pid'],api_pid,self_pid}:
    raise RuntimeError('container has a process beyond init, supervisor, fenced API, and this probe')
environment=(pathlib.Path('/proc')/str(api_pid)/'environ').read_bytes().split(b'\0')
if b'FULLMAG_API_RUNTIME_FAILURE_FENCE='+failure_path.encode() not in environment:
    raise RuntimeError('API process environment does not contain its exact failure-fence path')

with urllib.request.urlopen('http://127.0.0.1:8081/v2/platform/health',timeout=5) as response:
    health=obj(response.read(256*1024),'API health')
    if (response.status!=200 or health.get('status')!='degraded'
            or response.headers.get('x-fullmag-api-instance')!=api_instance):
        raise RuntimeError('API health does not acknowledge the exact diagnostic fence')

print(json.dumps({
    'schema':'fullmag.docker-api-diagnostic-stop-probe.v1',
    'runtime_config':base64.b64encode(config_raw).decode('ascii'),
    'owner':base64.b64encode(owner_raw).decode('ascii'),
    'process_receipt':base64.b64encode(process_raw).decode('ascii'),
    'failure_fence':base64.b64encode(fence_raw).decode('ascii'),
    'api_pid':api_pid,'api_instance_id':api_instance,
    'api_failure_fence':failure_path,
    'owner_pids_absent':sorted(owner_pids),
    'process_ids':[1,supervisor['pid'],api_pid,self_pid],
    'health_status':'degraded',
},sort_keys=True,separators=(',',':')))
'''


def _decode_probe(probe: Mapping[str, object], name: str) -> bytes:
    value = probe.get(name)
    if not isinstance(value, str):
        _fail("In-container diagnostic probe omitted " + name)
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise BuildControlError("In-container diagnostic probe returned invalid " + name) from error
    if len(raw) > MAX_EVIDENCE_BYTES:
        _fail("In-container diagnostic evidence exceeds its byte bound")
    return raw


def _probe_backend(backend_id: str) -> dict[str, object]:
    result = docker_capture(
        "exec", backend_id, "/usr/local/bin/python3", "-B", "-c", _probe_script(),
        timeout=30,
    )
    try:
        probe = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Diagnostic-only backend probe returned invalid JSON") from error
    if (not isinstance(probe, dict)
            or probe.get("schema") != "fullmag.docker-api-diagnostic-stop-probe.v1"):
        _fail("Diagnostic-only backend probe has an unsupported schema")
    return probe


def _startup_recovery_probe_script(expected_cgroup: Mapping[str, object]) -> str:
    encoded = base64.b64encode(canonical(dict(expected_cgroup))).decode("ascii")
    script = r'''import base64,json,os,pathlib,re,stat,sys,urllib.error,urllib.request,uuid
sys.path.insert(0,"/opt/fullmag")
import runtime_service as runtime
paths=runtime.canonical_paths()
expected=json.loads(base64.b64decode("EXPECTED_CGROUP"))
process_path=runtime.process_receipt_path(paths)
owner_path=runtime.runtime_services_root(paths)/"OWNER.json"
launch_path=runtime.runtime_services_root(paths)/"LAUNCH.json"
worker=pathlib.Path("/opt/fullmag/runtime-control/worker-cgroup")
def read(path,label,maximum=1024*1024):
 first=runtime._bounded_regular(path,label,maximum)
 if first!=runtime._bounded_regular(path,label,maximum): raise RuntimeError(label+" changed")
 return first
def obj(raw,label):
 def unique(pairs):
  value={}
  for key,item in pairs:
   if key in value: raise RuntimeError(label+" has duplicate keys")
   value[key]=item
  return value
 value=json.loads(raw.decode("utf-8"),object_pairs_hook=unique)
 if not isinstance(value,dict): raise RuntimeError(label+" is not an object")
 return value
def proc(pid):
 root=pathlib.Path("/proc")/str(pid)
 tail=(root/"stat").read_text().rsplit(")",1)[1].split()
 status=(root/"status").read_text()
 parent=re.search(r"^PPid:\s+(\d+)$",status,re.M)
 command=(root/"cmdline").read_bytes()
 if parent is None or len(tail)<=19 or len(command)>65536: raise RuntimeError("process identity incomplete")
 return {"pid":pid,"ppid":int(parent.group(1)),"start_ticks":tail[19],
         "exe":os.readlink(root/"exe"),"argv":[x.decode() for x in command.split(b"\0") if x]}
config_raw=read(paths.config,"runtime configuration",256*1024)
owner_raw=read(owner_path,"historical ready owner",256*1024)
launch_raw=read(launch_path,"historical launch record",256*1024)
process_raw=read(process_path,"historical process tree")
provenance_raw=read(paths.provenance,"published provenance",256*1024)
request_raw=read(worker/"request.json","worker cgroup request",16384)
ready_raw=read(worker/"ready.json","worker cgroup ready receipt",16384)
config=obj(config_raw,"runtime configuration");owner=obj(owner_raw,"ready owner")
launch=obj(launch_raw,"launch record");history=obj(process_raw,"process tree")
provenance=obj(provenance_raw,"provenance");request=obj(request_raw,"cgroup request")
ready=obj(ready_raw,"cgroup ready receipt")
runtime._validate_terminal_owner(owner,state="ready",name="historical Ready owner")
if (config.get("schema_version")!="runtime_service_config.v2" or config.get("target_id")!="docker-all"
    or pathlib.Path(config.get("store_root",""))!=paths.store
    or launch.get("schema_version")!="runtime_service_launch.v1" or launch.get("state")!="ready"):
 raise RuntimeError("runtime configuration or launch identity differs")
if (history.get("schema")!="fullmag.docker-process-tree.v1" or history.get("state")!="shutdown_unknown"
    or "service_owner" in history or "terminal_service_owner" in history
    or history.get("runtime_pid") is not None or history.get("startup_activation") is not None
    or type(history.get("api_pid")) is not int or type(history.get("api_exit_code")) is not int
    or history.get("api_exit_code")==0):
 raise RuntimeError("process tree is not unchanged historical shutdown_unknown")
owner_pids=[owner["pid"],*[child["pid"] for child in owner["children"]]]
if any(type(pid) is not int or pid<=0 or pathlib.Path("/proc",str(pid)).exists() for pid in owner_pids):
 raise RuntimeError("historical owner or scheduler is still live")
rows=[proc(int(item.name)) for item in pathlib.Path("/proc").iterdir() if item.name.isdigit()]
by_pid={row["pid"]:row for row in rows}
sup=[row for row in rows if "/opt/fullmag/entrypoint.py" in row["argv"]]
apis=[row for row in rows if row["exe"].endswith("/fullmag-api")]
if (len(rows)>256 or 1 not in by_pid or pathlib.Path(by_pid[1]["exe"]).name not in {"docker-init","tini"}
    or len(sup)!=1 or len(apis)!=1):
 raise RuntimeError("startup process tree is missing or ambiguous")
supervisor=sup[0];api=apis[0];api_pid=api["pid"]
if (supervisor["ppid"]!=1 or api["ppid"]!=supervisor["pid"] or history["api_pid"] in by_pid
    or set(by_pid)!={1,supervisor["pid"],api_pid,os.getpid()}):
 raise RuntimeError("startup process tree contains an unknown process")
if ready!=expected or ready.get("schema")!="fullmag.worker-cgroup-ready.v1" or ready.get("state")!="ready":
 raise RuntimeError("ready cgroup receipt differs from retained proof")
if (request.get("schema")!="fullmag.worker-cgroup-request.v1"
    or any(request.get(k)!=ready.get(k) for k in ("compose_project","nonce","pid","process_start_token","boot_id"))
    or request.get("container_id") not in (None,ready.get("container_id")) or ready.get("pid") not in by_pid
    or proc(ready["pid"])["start_ticks"]!=str(ready["process_start_token"])):
 raise RuntimeError("worker cgroup request differs from the live backend")
root_path=pathlib.Path(ready.get("root",""))
st=root_path.stat(follow_symlinks=False)
if (ready.get("root")!="/opt/fullmag/worker-cgroup" or not stat.S_ISDIR(st.st_mode)
    or root_path.is_symlink() or not os.path.ismount(root_path)
    or (st.st_dev,st.st_ino)!=(ready.get("root_device"),ready.get("root_inode"))):
 raise RuntimeError("worker cgroup mount identity changed")
env=(pathlib.Path("/proc")/str(api_pid)/"environ").read_bytes()
fences=[x.split(b"=",1)[1].decode() for x in env.split(b"\0") if x.startswith(b"FULLMAG_API_RUNTIME_FAILURE_FENCE=")]
if len(fences)!=1: raise RuntimeError("startup API does not pin one failure fence")
fence_path=pathlib.Path(fences[0]);parent=process_path.parent
if fence_path.parent!=parent or re.fullmatch(r"api-failure-[0-9a-f]{32}\.json",fence_path.name) is None:
 raise RuntimeError("startup API fence path is not canonical")
fence_raw=read(fence_path,"startup failure fence",256*1024);fence=obj(fence_raw,"startup failure fence")
suffix="\nError: unapplied terminal heartbeat requires a failed nonzero process-exit receipt"
if (fence.get("schema")!="fullmag.api-runtime-failure-fence.v1" or fence.get("stage")!="runtime_startup"
    or ("api_pid" in fence and fence["api_pid"]!=api_pid) or not isinstance(fence.get("reason"),str)
    or not fence["reason"].startswith("runtime CLI failed: [fullmag] version:")
    or not fence["reason"].endswith(suffix)):
 raise RuntimeError("startup API fence is not the exact retained-terminal error")
instance=None
def get(path,status,limit=256*1024):
 global instance
 try: response=urllib.request.urlopen("http://127.0.0.1:8081"+path,timeout=10)
 except urllib.error.HTTPError as error: response=error
 with response:
  body=response.read(limit+1);seen=response.headers.get("x-fullmag-api-instance")
  if instance is None:
   if path!="/v2/platform/health" or not seen or str(uuid.UUID(seen))!=seen: raise RuntimeError("API instance header missing")
   instance=seen
  if len(body)>limit or response.code!=status or seen!=instance: raise RuntimeError("API status/instance changed")
  return obj(body,"API response")
health=get("/v2/platform/health",200)
if health.get("status")!="degraded" or health.get("active_session") is not False: raise RuntimeError("API is not fenced")
openapi=get("/v2/platform/openapi.json",200,4*1024*1024);identity=openapi.get("x-fullmag-build-identity",{})
commit=provenance.get("commit");snapshot=provenance.get("native_source_identity",{}).get("source_snapshot_sha256")
if (identity.get("git_commit")!=commit or identity.get("source_snapshot_sha256")!=snapshot
    or ("| commit: "+str(commit)) not in fence["reason"] or ("| source snapshot: "+str(snapshot)) not in fence["reason"]):
 raise RuntimeError("API build identity differs from provenance and fence")
current=get("/v2/sessions/current/status",503)
if current.get("code")!="runtime_unavailable": raise RuntimeError("current API still allows execution")
if (read(paths.config,"runtime configuration",256*1024)!=config_raw
    or read(owner_path,"historical ready owner",256*1024)!=owner_raw
    or read(launch_path,"historical launch record",256*1024)!=launch_raw
    or read(process_path,"historical process tree")!=process_raw
    or read(fence_path,"startup failure fence",256*1024)!=fence_raw
    or read(paths.provenance,"published provenance",256*1024)!=provenance_raw
    or read(worker/"request.json","worker cgroup request",16384)!=request_raw
    or read(worker/"ready.json","worker cgroup ready receipt",16384)!=ready_raw
    or proc(supervisor["pid"])!=supervisor or proc(api_pid)!=api):
 raise RuntimeError("startup diagnostic identity changed during observation")
final_rows=[proc(int(item.name)) for item in pathlib.Path("/proc").iterdir() if item.name.isdigit()]
if ({row["pid"] for row in final_rows}!=set(by_pid)
    or any(pathlib.Path("/proc",str(pid)).exists() for pid in owner_pids)):
 raise RuntimeError("startup process inventory changed during observation")
print(json.dumps({"schema":"PROBE_SCHEMA","runtime_config":base64.b64encode(config_raw).decode(),
 "owner":base64.b64encode(owner_raw).decode(),"launch":base64.b64encode(launch_raw).decode(),
 "process_receipt":base64.b64encode(process_raw).decode(),"failure_fence":base64.b64encode(fence_raw).decode(),
 "provenance":base64.b64encode(provenance_raw).decode(),"worker_cgroup":base64.b64encode(ready_raw).decode(),
 "worker_cgroup_request":base64.b64encode(request_raw).decode(),"api_pid":api_pid,"supervisor_pid":supervisor["pid"],
 "probe_pid":os.getpid(),"api_instance_id":instance,"api_failure_fence":str(fence_path),
 "process_ids":[1,supervisor["pid"],api_pid,os.getpid()],"owner_pids_absent":sorted(owner_pids),
 "api_process":api,"supervisor_process":supervisor,
 "health_status":200,"health":{"status":health.get("status"),"active_session":health.get("active_session")},
 "health_instance_id":instance,"openapi_status":200,
 "build_identity":{"git_commit":identity.get("git_commit"),"source_snapshot_sha256":identity.get("source_snapshot_sha256")},"current_status":503,"current_status_body":current},sort_keys=True,separators=(",",":")))
'''
    return script.replace("EXPECTED_CGROUP", encoded).replace("PROBE_SCHEMA", STARTUP_RECOVERY_PROBE_SCHEMA)


def _probe_startup_recovery_backend(backend_id: str, expected_cgroup: Mapping[str, object]):
    result = docker_capture("exec", backend_id, "/usr/local/bin/python3", "-B", "-c",
                            _startup_recovery_probe_script(expected_cgroup), timeout=60)
    try:
        probe = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Startup recovery backend probe returned invalid JSON") from error
    if not isinstance(probe, Mapping) or probe.get("schema") != STARTUP_RECOVERY_PROBE_SCHEMA:
        _fail("Startup recovery backend probe has an unsupported schema")
    return dict(probe)


def _startup_recovery_authority(control, previous, document, backend, selected):
    import docker_volume_container_recovery as recovery
    from docker_volume_dev import _retained_recovery_context, _validate_completed_recovery_receipt
    from docker_volume_pre_ack_retry import _released_snapshot
    from docker_volume_unclaimed_cancellation import _control_raw

    context = _retained_recovery_context(
        control, previous, document, fresh_state=False, backend_id=backend["Id"], actual=backend,
    )
    environment = context.get("recovery_environment") if isinstance(context, Mapping) else None
    if not isinstance(environment, Mapping) or set(environment) != {
            recovery.AUTHORIZATION_ENV, recovery.AUTHORIZATION_SHA_ENV}:
        _fail("Startup recovery requires the original complete native authorization")
    auth_path = environment[recovery.AUTHORIZATION_ENV]
    if not isinstance(auth_path, str) or not auth_path.startswith(recovery.CONTROL_ROOT + "/"):
        _fail("Retained runtime authorization escapes the control volume")
    auth_relative = recovery._relative_control_path(auth_path[len(recovery.CONTROL_ROOT) + 1:])
    auth_raw = _read_raw(control, auth_relative, maximum=recovery.MAX_AUTHORIZATION_BYTES)
    if (_sha256(auth_raw) != environment[recovery.AUTHORIZATION_SHA_ENV]
            or _sha256(auth_raw) != context.get("recovery_metadata", {}).get("authorization_sha256")):
        _fail("Retained runtime authorization bytes differ from their immutable digest")
    authorization = recovery.validate_runtime_authorization(_json(auth_raw, "retained runtime authorization"))
    request_id = authorization["request_id"]
    root = recovery.RECOVERY_RELATIVE_ROOT + "/" + request_id
    operator_raw = _read_raw(control, root + "/operator.json", maximum=256 * 1024)
    if _sha256(operator_raw) != authorization["operator_authorization_sha256"]:
        _fail("Original operator authorization digest differs from the retained runtime authorization")
    operator = recovery.validate_operator_authorization(_json(operator_raw, "original operator authorization"))
    proof_raw = _read_raw(control, operator["stop_journal_path"], maximum=8 * 1024 * 1024)
    if _sha256(proof_raw) != operator["stop_journal_sha256"]:
        _fail("Original abrupt-stop proof digest differs from its operator authorization")
    proof = _json(proof_raw, "original abrupt-stop proof")
    recovery.validate_abrupt_stop_proof(proof, operator)
    current_recovery = previous.get("inputs", {}).get("container_recovery")
    if (operator.get("request_id") != request_id
            or operator.get("source_root") != str(selected)
            or operator.get("compose_project") != control.project
            or authorization.get("source_root") != str(selected)
            or authorization.get("compose_project") != control.project
            or not isinstance(current_recovery, Mapping)
            or current_recovery.get("authorization_sha256") != authorization["operator_authorization_sha256"]):
        _fail("Current failed development terminal is not bound to this recovery authorization")

    def load(path, digest, label):
        if not isinstance(path, str) or not path.startswith(recovery.CONTROL_ROOT + "/"):
            _fail(label + " path escapes the control volume")
        relative = recovery._relative_control_path(path[len(recovery.CONTROL_ROOT) + 1:])
        raw = _read_raw(control, relative, maximum=8 * 1024 * 1024)
        if _sha256(raw) != digest:
            _fail(label + " bytes differ from retained authorization")
        return raw, _json(raw, label)

    request_raw, request = load(authorization["native_request_path"],
                                authorization["native_request_sha256"], "native recovery request")
    request = recovery.validate_request(request)
    attestation_raw, attestation = load(authorization["attestation_path"],
                                        authorization["attestation_sha256"], "recovery attestation")
    attestation = recovery.validate_attestation(attestation, request, authorization["native_request_sha256"])
    if _sha256(recovery._canonical(attestation)) != authorization["attestation_sha256"]:
        _fail("Recovery attestation canonical digest differs from authorization")
    manifest_raw, manifest = load(authorization["manifest_path"],
                                  authorization["manifest_sha256"], "recovery manifest")
    if (request.get("request_id") != request_id
            or request.get("config_sha256") != authorization["config_sha256"]
            or request.get("owner_sha256") != authorization["owner_sha256"]
            or request.get("launch_sha256") != authorization["launch_sha256"]
            or request.get("docker_manifest_sha256") != authorization["manifest_sha256"]
            or manifest.get("schema") != "fullmag.docker-container-recovery-manifest.v1"
            or manifest.get("request_id") != request_id
            or manifest.get("compose_project") != control.project):
        _fail("Pending native request or manifest differs from its original authorization")
    config_raw = _read_raw(control, "runtime-control/runtime-service/docker-all.json", maximum=256 * 1024)
    owner_raw = _read_raw(control, "runtime-control/runtime-services/OWNER.json", maximum=256 * 1024)
    launch_raw = _read_raw(control, "runtime-control/runtime-services/LAUNCH.json", maximum=256 * 1024)
    if any(_sha256(raw) != authorization[key] for raw, key in (
            (config_raw, "config_sha256"), (owner_raw, "owner_sha256"), (launch_raw, "launch_sha256"))):
        _fail("Canonical OWNER, configuration, or launch bytes differ from original authorization")
    if _validate_completed_recovery_receipt(control, authorization, recovery):
        _fail("Native container recovery is complete; this stop path cannot replay it")
    receipt_relative = ("runtime-control/runtime-services/container-recovery/"
                        + authorization["native_request_sha256"] + "/receipt.json")
    receipt_raw = _control_raw(control, receipt_relative, optional=True, maximum=256 * 1024)
    receipt = _json(receipt_raw, "prepared native recovery receipt") if receipt_raw is not None else None
    _validate_startup_recovery_native_receipt(receipt, authorization, request)

    store_kwargs = {key: request[key] for key in (
        "retained_cancelled_runs", "retained_terminal_runs",
        "retained_held_manual_runs", "retained_attempt_histories") if key in request}
    storage_proof = recovery._ledger_and_store_snapshot(
        control, backend, compose=document, **store_kwargs,
    )
    released = _released_snapshot(control, backend)
    if storage_proof != proof.get("storage_proof"):
        _fail("Current store/ledger snapshot differs from the original abrupt-stop proof")
    if any(storage_proof.get(key) != request.get(key) for key in (
            "store_root_sha256", "ledger_root_sha256", "ledger_snapshot_sha256")):
        _fail("Current store/ledger snapshot differs from native recovery request")
    return {
        "authorization": authorization, "request": request, "operator_authorization": operator,
        "storage_proof": storage_proof, "released_snapshot": released, "receipt": receipt,
        "raw": {"runtime_authorization": auth_raw, "operator_authorization": operator_raw,
                "abrupt_proof": proof_raw, "native_request": request_raw,
                "attestation": attestation_raw, "manifest": manifest_raw,
                "prepared_receipt": receipt_raw, "runtime_config": config_raw,
                "owner": owner_raw, "launch": launch_raw},
    }


def _assert_startup_recovery_consumers(control, operation, ids, actual, document):
    from docker_volume_dev import _assert_private_restart_network

    helper_id = _assert_group_consumers(control, operation, ids)
    _assert_private_restart_network(actual, ids, control.project)
    return helper_id


def _startup_recovery_container_pin(actual):
    from docker_volume_container_recovery import _stable_container_observation

    pinned = _stable_container_observation(actual)
    pinned["State"] = {key: value for key, value in actual.get("State", {}).items() if key != "Health"}
    return pinned


def _capture_startup_recovery_plan(args, selected, identity, control, previous,
                                   previous_root, document, operation):
    import docker_volume_container_recovery as recovery

    image, ids, actual = _container_snapshot(
        args, selected, identity, control, previous, document,
    )
    cgroup = _validate_startup_recovery_development(
        control, previous, selected, args.config_sha256, actual,
    )
    helper_id = _assert_startup_recovery_consumers(
        control, operation, ids, actual, document,
    )
    authority = _startup_recovery_authority(
        control, previous, document, actual["backend"], selected,
    )
    probe = _probe_startup_recovery_backend(ids["backend"], cgroup)
    observation = _validate_startup_recovery_observation(
        probe, authority["authorization"], authority["request"], cgroup,
        authority["storage_proof"], authority["released_snapshot"],
        operator_authorization=authority["operator_authorization"],
    )
    terminal_raw = _read_raw(control, previous_root + "/terminal.json")
    compose_raw = _read_raw(control, previous_root + "/compose.json")
    plan = {
        "schema": "fullmag.docker-startup-recovery-stop-plan.v1",
        "attempt": args.attempt,
        "config_sha256": args.config_sha256,
        "source_root": str(selected),
        "compose_project": control.project,
        "terminal_sha256": _sha256(terminal_raw),
        "compose_sha256": _sha256(compose_raw),
        "backend": _startup_recovery_container_pin(actual["backend"]),
        "frontend": _startup_recovery_container_pin(actual["frontend"]),
        "backend_image_id": image,
        "backend_started_at": actual["backend"]["State"]["StartedAt"],
        "frontend_started_at": actual["frontend"]["State"]["StartedAt"],
        "guest_observation": observation,
        "recovery_authorization_sha256": _sha256(authority["raw"]["runtime_authorization"]),
        "operator_authorization_sha256": _sha256(authority["raw"]["operator_authorization"]),
        "abrupt_proof_sha256": _sha256(authority["raw"]["abrupt_proof"]),
        "native_request_sha256": _sha256(authority["raw"]["native_request"]),
        "attestation_sha256": _sha256(authority["raw"]["attestation"]),
        "manifest_sha256": _sha256(authority["raw"]["manifest"]),
        "prepared_receipt_sha256": (
            _sha256(authority["raw"]["prepared_receipt"])
            if authority["raw"]["prepared_receipt"] is not None else None
        ),
        "storage_proof": authority["storage_proof"],
        "released_snapshot": authority["released_snapshot"],
        "execution_state": "unknown",
        "native_recovery_state": "pending",
        "owner_state": "ready-preserved",
        "historical_process_state": "shutdown_unknown-preserved",
    }
    return plan, image, ids, actual, authority


def _load_startup_recovery_preview(control, inputs, expected_plan_sha256):
    if not isinstance(expected_plan_sha256, str) or SHA256_RE.fullmatch(expected_plan_sha256) is None:
        _fail("Apply requires the complete preview plan SHA-256")
    preview = control.read("startup-recovery-stop-preview/verified.json")
    if (not isinstance(preview, Mapping)
            or preview.get("phase") != "startup-recovery-stop-preview"
            or preview.get("state") != "succeeded"
            or preview.get("inputs") != inputs
            or preview.get("result", {}).get("plan_sha256") != expected_plan_sha256):
        _fail("Apply requires the exact successful startup-recovery preview")
    attempt = preview.get("attempt")
    if not isinstance(attempt, str) or ATTEMPT_RE.fullmatch(attempt) is None:
        _fail("Startup-recovery preview attempt is invalid")
    terminal = control.read("startup-recovery-stop-preview/attempts/" + attempt + "/terminal.json")
    plan = control.read("startup-recovery-stop-preview/attempts/" + attempt + "/preflight.json")
    if terminal != preview or not isinstance(plan, Mapping) or _sha256(canonical(dict(plan))) != expected_plan_sha256:
        _fail("Startup-recovery preview artifact differs from its immutable terminal")
    return dict(plan), dict(preview)


def _stop_startup_recovery_diagnostic(args):
    from docker_dev import _compose_identity, _select_source
    from docker_volume_unclaimed_cancellation import _control_raw
    from docker_volume_dev import _operator_probe_record_from_retained

    for value, pattern, label in (
        (args.attempt, ATTEMPT_RE, "attempt"),
        (args.config_sha256, SHA256_RE, "Compose config SHA-256"),
    ):
        if not isinstance(value, str) or pattern.fullmatch(value) is None:
            _fail(label + " is not a complete lowercase identity")
    preview_only = bool(getattr(args, "preview", False))
    expected_plan_sha256 = getattr(args, "expected_plan_sha256", None)
    if preview_only:
        if expected_plan_sha256 is not None:
            _fail("Preview does not accept an apply plan digest")
    elif not isinstance(expected_plan_sha256, str) or SHA256_RE.fullmatch(expected_plan_sha256) is None:
        _fail("Startup-recovery apply requires --expected-plan-sha256 from preview")
    forbidden = ("resume_attempt", "iteration_attempt", "failed_iteration_attempt",
                 "failed_iteration_sha256", "pending_activation", "reconcile_read_attempt")
    if any(getattr(args, key, None) is not None for key in forbidden) or getattr(args, "catalog_failure", False):
        _fail("Startup recovery is exclusive to the initial failed-confirmed development attempt")
    if type(args.port) is not int or not 1 <= args.port <= 65535:
        _fail("Frontend port is outside the valid range")
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, helper_image)
    control.prepare()

    previous_root = "development/attempts/" + args.attempt
    terminal_raw = _read_raw(control, previous_root + "/terminal.json")
    previous = _json(terminal_raw, "retained development terminal")
    document_raw = _read_raw(control, previous_root + "/compose.json")
    document = _json(document_raw, "retained Compose document")
    if (previous.get("schema") != "fullmag.docker-build-operation.v1"
            or previous.get("phase") != "development"
            or previous.get("state") != "failed-confirmed"
            or previous.get("attempt") != args.attempt
            or previous.get("compose_project") != control.project
            or previous.get("control_volume") != control.volume
            or _sha256(canonical(document)) != args.config_sha256
            or document.get("name") != control.project):
        _fail("Startup recovery requires the exact retained failed-confirmed development and Compose")
    inputs = previous.get("inputs")
    if not isinstance(inputs, Mapping) or inputs.get("source_root") != str(selected):
        _fail("Startup recovery terminal belongs to another selected checkout")
    _operator_probe_record_from_retained(previous, document)
    _port_matches(document, args.port)

    # Pin the complete service pair before opening the control lease. Every
    # destructive-boundary observation below repeats this exact admission.
    image, ids, actual = _container_snapshot(args, selected, identity, control, previous, document)
    cgroup = _validate_startup_recovery_development(
        control, previous, selected, args.config_sha256, actual,
    )
    current_recovery = previous.get("container_recovery")
    if not isinstance(current_recovery, Mapping):
        _fail("Failed development terminal has no retained native recovery metadata")
    operation_inputs = {
        "attempt": args.attempt,
        "config_sha256": args.config_sha256,
        "source_root": str(selected),
        "image_id": image,
        "backend_container_id": ids["backend"],
        "frontend_container_id": ids["frontend"],
        "backend_started_at": actual["backend"]["State"]["StartedAt"],
        "frontend_started_at": actual["frontend"]["State"]["StartedAt"],
        "terminal_sha256": _sha256(terminal_raw),
        "compose_sha256": _sha256(document_raw),
        "recovery_authorization_sha256": current_recovery.get("authorization_sha256"),
        "controller_sha256": _sha256(Path(__file__).read_bytes()),
        "guest_probe_sha256": _sha256(_startup_recovery_probe_script(cgroup).encode("utf-8")),
        "startup_recovery": True,
        "preview_only": preview_only,
    }
    reviewed_plan = None
    if not preview_only:
        preview_inputs = {**operation_inputs, "preview_only": True}
        reviewed_plan, _ = _load_startup_recovery_preview(
            control, preview_inputs, expected_plan_sha256,
        )
    phase = "startup-recovery-stop-preview" if preview_only else "startup-recovery-stop"
    with control.operation(phase, operation_inputs) as operation:
        operation["receipt"]["image_id"] = image
        plan, fresh_image, fresh_ids, fresh_actual, authority = _capture_startup_recovery_plan(
            args, selected, identity, control, previous, previous_root, document, operation,
        )
        if (fresh_image != image or fresh_ids != ids
                or plan["backend_started_at"] != operation_inputs["backend_started_at"]
                or plan["frontend_started_at"] != operation_inputs["frontend_started_at"]):
            _fail("Startup recovery service pair changed under the managed lease")
        plan_sha256 = _sha256(canonical(plan))
        control.write(operation["root"] + "/preflight.json", plan)
        operation["receipt"]["helper_container_id"] = _assert_group_consumers(control, operation, ids)
        if preview_only:
            operation["receipt"].update(
                state="succeeded", stop_applied=False, execution_state="unknown",
                result={"state": "preview-passed", "plan_sha256": plan_sha256,
                        "preflight": operation["root"] + "/preflight.json"},
            )
            return {"state": "preview-passed", "stop_applied": False,
                    "plan_sha256": plan_sha256, "preflight": operation["root"] + "/preflight.json"}
        if plan != reviewed_plan or plan_sha256 != expected_plan_sha256:
            _fail("Fresh startup-recovery evidence differs from the reviewed preview plan")

        repeated, repeat_image, repeat_ids, repeat_actual, repeat_authority = _capture_startup_recovery_plan(
            args, selected, identity, control, previous, previous_root, document, operation,
        )
        if (repeated != plan or repeat_image != image or repeat_ids != ids
                or repeat_authority["raw"] != authority["raw"]):
            _fail("Startup-recovery evidence changed immediately before stop")

        intent_relative = "verification/startup-recovery-stop-intent-" + ids["backend"] + ".json"
        receipt_relative = "verification/startup-recovery-stop-" + ids["backend"] + ".json"
        if (_control_raw(control, intent_relative, optional=True) is not None
                or _control_raw(control, receipt_relative, optional=True) is not None):
            _fail("A startup-recovery stop intent or receipt already exists; do not repeat the stop")
        intent = {
            "schema": "fullmag.docker-startup-recovery-stop-intent.v1",
            "state": "stop-planned",
            "plan_sha256": plan_sha256,
            "backend_container_id": ids["backend"],
            "backend_image_id": image,
            "backend_started_at": operation_inputs["backend_started_at"],
            "frontend_container_id": ids["frontend"],
            "terminal_sha256": operation_inputs["terminal_sha256"],
            "compose_sha256": operation_inputs["compose_sha256"],
            "native_recovery_state": "pending",
            "execution_state": "unknown",
        }
        control.write(intent_relative, intent)
        operation["receipt"].update(state="stopping-startup-diagnostic-api",
                                    helper_container_id=operation.get("helper_container_id"))
        operation["daemon_pending"] = True
        # Docker waits indefinitely; this path never escalates to SIGKILL.
        docker_capture("stop", "--time", "-1", ids["backend"], timeout=21600)
        stopped_rows = json.loads(docker_capture("inspect", ids["backend"]).stdout)
        if len(stopped_rows) != 1:
            _fail("Stopped startup backend inspection is ambiguous")
        stopped = stopped_rows[0]
        state = stopped.get("State", {})
        if (stopped.get("Id") != ids["backend"] or stopped.get("Image") != image
                or state.get("StartedAt") != operation_inputs["backend_started_at"]
                or state.get("Running") is not False or state.get("Pid") != 0
                or state.get("OOMKilled") is not False or type(state.get("ExitCode")) is not int
                or not isinstance(state.get("FinishedAt"), str) or not state["FinishedAt"]):
            _fail("Docker did not confirm a graceful stop of the exact backend incarnation")

        _fresh_image, stopped_ids, after_services = _container_snapshot(
            args, selected, identity, control, previous, document, allow_stopped_backend=True,
        )
        if _fresh_image != image or stopped_ids != ids:
            _fail("Compose service identity changed after startup backend stop")
        frontend = after_services["frontend"]
        from docker_volume_container_recovery import _stable_container_observation
        if (_startup_recovery_container_pin(frontend)
                != plan["frontend"]
                or frontend.get("State", {}).get("Running") is not True):
            _fail("Frontend incarnation changed while stopping only the backend")
        _assert_startup_recovery_consumers(control, operation, ids, after_services, document)
        after_authority = _startup_recovery_authority(
            control, previous, document, stopped, selected,
        )
        if (after_authority["raw"] != authority["raw"]
                or after_authority["storage_proof"] != authority["storage_proof"]
                or after_authority["released_snapshot"] != authority["released_snapshot"]):
            _fail("Authorization, owner/configuration, store, ledger, or lease evidence changed during stop")
        process_raw = _read_raw(control, "runtime-control/runtime-service/process-tree.json")
        owner_raw = _read_raw(control, "runtime-control/runtime-services/OWNER.json", maximum=256 * 1024)
        config_raw = _read_raw(control, "runtime-control/runtime-service/docker-all.json", maximum=256 * 1024)
        launch_raw = _read_raw(control, "runtime-control/runtime-services/LAUNCH.json", maximum=256 * 1024)
        if (_sha256(process_raw) != plan["guest_observation"]["historical_process_receipt_sha256"]
                or _sha256(owner_raw) != plan["guest_observation"]["owner_sha256"]
                or _sha256(config_raw) != plan["guest_observation"]["runtime_config_sha256"]
                or _sha256(launch_raw) != plan["guest_observation"]["launch_sha256"]):
            _fail("Historical process tree, Ready OWNER, configuration, or launch bytes changed")
        fence_relative = _runtime_relative(plan["guest_observation"]["api_failure_fence"])
        fence_raw = _read_raw(control, fence_relative, maximum=256 * 1024)
        cgroup_ready_raw = _read_raw(control, "runtime-control/worker-cgroup/ready.json", maximum=16384)
        cgroup_request_raw = _read_raw(control, "runtime-control/worker-cgroup/request.json", maximum=16384)
        if (_sha256(fence_raw) != plan["guest_observation"]["startup_failure_fence_sha256"]
                or _sha256(cgroup_ready_raw) != plan["guest_observation"]["worker_cgroup_ready_sha256"]
                or _sha256(cgroup_request_raw) != plan["guest_observation"]["worker_cgroup_request_sha256"]):
            _fail("Startup failure fence or worker cgroup proof changed during stop")
        if (_sha256(_read_raw(control, previous_root + "/terminal.json")) != operation_inputs["terminal_sha256"]
                or _sha256(_read_raw(control, previous_root + "/compose.json")) != operation_inputs["compose_sha256"]):
            _fail("Original failed development terminal or Compose document changed during stop")

        terminal = {
            "schema": STARTUP_RECOVERY_STOP_SCHEMA,
            "state": "stopped-confirmed",
            "attempt": args.attempt,
            "config_sha256": args.config_sha256,
            "backend_container_id": ids["backend"],
            "backend_image_id": image,
            "backend_started_at": state["StartedAt"],
            "backend_finished_at": state["FinishedAt"],
            "backend_exit_code": state["ExitCode"],
            "backend_running": False,
            "frontend_container_id": ids["frontend"],
            "frontend_started_at": operation_inputs["frontend_started_at"],
            "owner_state": "ready-preserved",
            "historical_process_state": "shutdown_unknown-preserved",
            "native_recovery_state": "pending",
            "execution_state": "unknown",
            "resource_leases": "unchanged-released",
            "plan_sha256": plan_sha256,
            "intent": intent_relative,
            "intent_sha256": _sha256(canonical(intent)),
            "guest_observation": plan["guest_observation"],
            "recovery_authorization_sha256": plan["recovery_authorization_sha256"],
            "operator_authorization_sha256": plan["operator_authorization_sha256"],
            "native_request_sha256": plan["native_request_sha256"],
            "storage_proof": authority["storage_proof"],
            "released_snapshot": authority["released_snapshot"],
        }
        control.write(operation["root"] + "/startup-recovery-stop-terminal.json", terminal)
        control.write(receipt_relative, terminal)
        operation["daemon_pending"] = False
        operation["receipt"].update(
            state="succeeded", stopped_backend=True, execution_state="unknown",
            startup_recovery_stop_sha256=_sha256(canonical(terminal)),
            result={"state": "stopped-confirmed", "receipt": receipt_relative},
        )
        return terminal


def _failed_iteration_runtime_probe(backend, before):
    if before["failed_owner"].get("state") != "failed":
        _fail("Failed iteration stop requires a terminal Failed owner")
    script = r'''import hashlib,json,pathlib,os,stat
root=pathlib.Path('/opt/fullmag/runtime-control/worker-cgroup')
def read(p):
 if any(parent.is_symlink() for parent in p.parents): raise RuntimeError('symlink proof ancestor')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  if not stat.S_ISREG(os.fstat(fd).st_mode): raise RuntimeError('proof is not regular')
  raw=os.read(fd,1048577)
  if len(raw)>1048576: raise RuntimeError('proof exceeds bound')
  return raw
 finally: os.close(fd)
request_raw=read(root/'request.json');ready_raw=read(root/'ready.json')
request=json.loads(request_raw);ready=json.loads(ready_raw)
pid=request.get('pid')
if type(pid)!=int or pid<=0: raise RuntimeError('invalid request PID')
start=(pathlib.Path('/proc')/str(pid)/'stat').read_text().rsplit(') ',1)[1].split()[19]
if (request.get('schema')!='fullmag.worker-cgroup-request.v1' or start!=request.get('process_start_token')
 or request.get('nonce')==ready.get('nonce') or ready.get('schema')!='fullmag.worker-cgroup-ready.v1'):
 raise RuntimeError('not a live pending cgroup request with stale READY')
rows=list(pathlib.Path('/state/runs/docker-all/session-store/runs').iterdir())
if len(rows)>128: raise RuntimeError('run inventory exceeds bound')
catalogs={}
for run in rows:
 if run.is_symlink() or not run.is_dir(): raise RuntimeError('unsafe run inventory')
 raw=read(run/'run_catalog.json');catalog=json.loads(raw);tasks=catalog.get('tasks')
 if not isinstance(tasks,list) or not tasks: raise RuntimeError('invalid task inventory')
 for task in tasks:
  state=task.get('lifecycle')
  if state not in {'succeeded','failed','cancelled','interrupted','accepted','queued'}: raise RuntimeError('active task')
  if state in {'accepted','queued'} and (task.get('artifact_ids') or any(task.get(k) is not None for k in ('attempt_id','resource_id','resolved_input_fingerprint','coordinator_watermark','coordinator_genesis'))): raise RuntimeError('claimed task')
 catalogs[run.name]=hashlib.sha256(raw).hexdigest()
if read(root/'request.json')!=request_raw or read(root/'ready.json')!=ready_raw: raise RuntimeError('cgroup proof changed')
print(json.dumps({'request':request,'stale_ready':ready,'catalogs':catalogs,'cgroup_not_ready':True},sort_keys=True))
'''
    raw = docker_capture("exec", backend["Id"], "/usr/local/bin/python3", "-I", "-B", "-c", script, timeout=30).stdout
    proof = _json(raw, "pending cgroup stop proof")
    request, ready = proof.get("request", {}), proof.get("stale_ready", {})
    if (proof.get("cgroup_not_ready") is not True
            or any(request.get(key) != value or ready.get(key) != value for key, value in
                   (("container_id", backend["Id"]), ("compose_project", backend["Config"]["Labels"]["com.docker.compose.project"])))
            or ready.get("image_id") != backend["Image"]
            or request.get("pid") not in before["probe"]["process_ids"]
            or request.get("pid") in (1, before["process_receipt"]["api_pid"])
            or not isinstance(request.get("nonce"), str)
            or ATTEMPT_RE.fullmatch(request["nonce"]) is None):
        _fail("Pending cgroup request does not belong to the exact supervisor/group")
    return proof


def _probe_evidence(control: BuildControl, previous_root: str, probe: Mapping[str, object]):
    from docker_volume_stop_failed import (
        _owner_identity_key,
        _validate_native_failed_owner,
        _validate_native_ready_owner,
    )

    config_raw = _read_raw(control, "runtime-control/runtime-service/docker-all.json", maximum=256 * 1024)
    owner_raw = _read_raw(control, "runtime-control/runtime-services/OWNER.json", maximum=256 * 1024)
    process_raw = _read_raw(control, "runtime-control/runtime-service/process-tree.json")
    from docker_volume_unclaimed_cancellation import _control_raw
    sidecar_raw = _control_raw(
        control, previous_root + "/process-failure.json", optional=True,
        maximum=MAX_EVIDENCE_BYTES,
    )
    config = _json(config_raw, "runtime service configuration")
    owner = _json(owner_raw, "retained failed runtime owner")
    process = _json(process_raw, "retained diagnostic process receipt")
    sidecar = _json(sidecar_raw, "retained process-failure sidecar") if sidecar_raw is not None else None
    fence_path = probe.get("api_failure_fence")
    relative = _runtime_relative(fence_path)
    fence_raw = _read_raw(control, relative, maximum=256 * 1024)
    fence = _json(fence_raw, "API failure fence")
    probe_config = _decode_probe(probe, "runtime_config")
    probe_owner = _decode_probe(probe, "owner")
    probe_process = _decode_probe(probe, "process_receipt")
    probe_fence = _decode_probe(probe, "failure_fence")
    if (probe_config != config_raw or probe_owner != owner_raw
            or probe_process != process_raw or probe_fence != fence_raw):
        _fail("In-container diagnostic observation differs from canonical control-volume bytes")
    if sidecar is not None and sidecar != process:
        _fail("Retained attempt process-failure sidecar differs from the current process receipt")
    if (config.get("schema_version") != "runtime_service_config.v2"
            or config.get("target_id") != "docker-all"
            or config.get("store_root") != "/state/runs/docker-all/session-store"):
        _fail("Runtime configuration is not bound to the selected accepted store")
    if owner.get("state") == "unknown":
        from docker_dev_recovery_build import validate_diagnostic_build
        try:
            validate_diagnostic_build(process, owner)
        except ValueError as error:
            _fail("Unknown diagnostic owner identity differs: " + str(error))
        # Preserve Unknown exactly; this is permission to stop the fenced API,
        # never evidence of a native exit, release, Failed, or Drained state.
        failed_owner = dict(owner)
    else:
        failed_owner = _validate_native_failed_owner(
            owner, allowed_child_statuses=frozenset({"exited_success", "exited_failure"})
        )
    if (process.get("schema") != "fullmag.docker-process-tree.v1"
            or process.get("state") != "failed_outcome_retained"
            or process.get("api_diagnostic_only") is not True
            or process.get("runtime_pid") is not None
            or not isinstance(process.get("service_owner"), Mapping)
            or "terminal_service_owner" in process
            or type(process.get("api_pid")) is not int or process["api_pid"] <= 0
            or process.get("api_failure_fence") != fence_path):
        _fail("Process receipt does not prove a retained diagnostic-only API and ready-owner pin")
    if (fence.get("schema") != "fullmag.api-runtime-failure-fence.v1"
            or fence.get("stage") != "runtime_supervision"
            or fence.get("api_pid") != process.get("api_pid")
            or fence.get("api_instance_id") != probe.get("api_instance_id")):
        _fail("API failure marker is not bound to the retained API incarnation")
    ready_owner = _validate_native_ready_owner(process["service_owner"])
    if _owner_identity_key(ready_owner, "retained ready owner") != _owner_identity_key(
        failed_owner, "failed owner"
    ):
        _fail("Failed OWNER identity differs from the retained ready-owner pin")
    return {
        "runtime_config_sha256": _sha256(config_raw),
        "failed_owner_sha256": _sha256(owner_raw),
        "process_receipt_sha256": _sha256(process_raw),
        "process_failure_sidecar_sha256": _sha256(sidecar_raw) if sidecar_raw is not None else None,
        "api_failure_fence_sha256": _sha256(fence_raw),
        "runtime_config": config,
        "failed_owner": failed_owner,
        "ready_owner": ready_owner,
        "process_receipt": process,
        "api_failure_fence": fence,
        "api_failure_fence_relative": relative,
        "probe": dict(probe),
    }


def _container_snapshot(args, selected, identity, control, previous, document, *, allow_stopped_backend=False):
    from docker_compose_identity import validate_source_labels
    from docker_volume_dev import _validate_retained_service
    from docker_volume_stop_unadmitted import _validate_network

    services = document.get("services")
    if not isinstance(services, Mapping) or set(services) != {"backend", "frontend"}:
        _fail("Retained Compose must contain exactly the fixed backend/frontend pair")
    image = previous.get("inputs", {}).get("image_id")
    if not isinstance(image, str) or IMAGE_RE.fullmatch(image) is None:
        _fail("Retained attempt has no immutable development image identity")
    ids = {
        service: _single_id(compose_capture(document, "ps", "--all", "--quiet", service), service)
        for service in ("backend", "frontend")
    }
    for service in ids:
        recorded = previous.get(service + "_container")
        if recorded is not None and recorded != ids[service]:
            _fail("Retained attempt names a different " + service + " incarnation")
    inspected = json.loads(docker_capture("inspect", ids["backend"], ids["frontend"]).stdout)
    by_id = {row.get("Id"): row for row in inspected if isinstance(row, Mapping)}
    if set(by_id) != set(ids.values()):
        _fail("Compose service inspection is incomplete or ambiguous")
    actual = {service: by_id[identifier] for service, identifier in ids.items()}
    image_rows = json.loads(docker_capture("image", "inspect", image).stdout)
    if len(image_rows) != 1 or not isinstance(image_rows[0].get("Config"), Mapping):
        _fail("Retained development image inspection is incomplete")
    image_config = image_rows[0]["Config"]
    for service, identifier in ids.items():
        row = actual[service]
        labels = row.get("Config", {}).get("Labels", {})
        if (row.get("Id") != identifier or row.get("Image") != image
                or labels.get("com.docker.compose.project") != control.project
                or labels.get("com.docker.compose.service") != service):
            _fail("Retained service identity differs from its Compose/source pin")
        validate_source_labels(row, identity)
        _validate_retained_service(
            document, row, service, image_config,
            expected_started_at=(previous.get("backend_started_at") if service == "backend" else None),
        )
        if (row.get("State", {}).get("Running") is not True
                and not (allow_stopped_backend and service == "backend"
                         and row.get("State", {}).get("Running") is False)):
            _fail("Diagnostic stop requires both exact Compose services running")
    if (actual["backend"].get("State", {}).get("StartedAt")
            != previous.get("backend_started_at")):
        _fail("Backend incarnation differs from the failed start receipt")
    _validate_network(
        actual, ids, control.project,
        allow_stopped_backend=(allow_stopped_backend and actual["backend"].get("State", {}).get("Running") is False),
    )
    return image, ids, actual


def _assert_group_consumers(control: BuildControl, operation, ids: Mapping[str, str]) -> str:
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids
    from docker_compose_identity import validate_source_labels

    receipt = operation.get("receipt", {})
    attempt = receipt.get("attempt")
    name = receipt.get("helper_container")
    if (not isinstance(attempt, str) or ATTEMPT_RE.fullmatch(attempt) is None
            or name != "fullmag-control-" + attempt):
        _fail("Diagnostic stop lease has no exact BuildControl helper identity")
    rows = json.loads(docker_capture("inspect", name).stdout)
    if len(rows) != 1:
        _fail("Diagnostic stop BuildControl helper is ambiguous")
    helper = rows[0]
    config = helper.get("Config", {})
    labels = config.get("Labels", {})
    if (helper.get("Id") is None or not CONTAINER_RE.fullmatch(helper["Id"])
            or config.get("Image") != control.image
            or labels.get("com.docker.compose.project") != control.project
            or labels.get("com.docker.compose.service") != "build-control"
            or labels.get("org.fullmag.compose.project") != control.project
            or helper.get("State", {}).get("Running") is not True
            or helper.get("HostConfig", {}).get("NetworkMode") != "none"):
        _fail("Diagnostic stop BuildControl helper does not match its private lease")
    validate_source_labels(helper, control.identity)
    mounts = helper.get("Mounts")
    control_mounts = [item for item in mounts if isinstance(item, Mapping)
                      and item.get("Destination") == "/control"] if isinstance(mounts, list) else []
    if (len(control_mounts) != 1 or control_mounts[0].get("Type") != "volume"
            or control_mounts[0].get("Name") != control.volume):
        _fail("Diagnostic stop helper does not mount the selected control volume")
    command = config.get("Cmd")
    command_text = " ".join(command) if isinstance(command, list) and all(
        isinstance(item, str) for item in command
    ) else ""
    inputs = receipt.get("inputs", {})
    phase_prefix = "startup-recovery-stop" if inputs.get("startup_recovery") is True else "stop-diagnostic"
    expected_phase = phase_prefix + ("-preview" if inputs.get("preview_only") is True else "")
    if (receipt.get("phase") != expected_phase
            or "/control/" + expected_phase + "/attempts/" + attempt not in command_text
            or "until test -f" not in command_text or "/control/active" not in command_text):
        _fail("BuildControl helper is not holding this exact diagnostic stop lease")
    expected = set(ids.values()) | {helper["Id"]}
    if (_project_container_ids(control.project) != expected
            or _volume_consumer_ids(control.volume) != expected):
        _fail("Compose group or control volume has another consumer")
    return helper["Id"]


def _terminal_receipt(control: BuildControl, operation, backend_id: str,
                      before: Mapping[str, object], stopped: Mapping[str, object],
                      resume_pin: Mapping[str, object] | None = None) -> dict[str, object]:
    state = stopped.get("State")
    if (stopped.get("Id") != backend_id
            or stopped.get("Image") != operation["receipt"].get("image_id")
            or not isinstance(state, Mapping)
            or state.get("Running") is not False
            or state.get("OOMKilled") is not False
            or type(state.get("ExitCode")) is not int
            or not isinstance(state.get("FinishedAt"), str)
            or not state["FinishedAt"]):
        _fail("Backend stop outcome is not confirmed for the exact retained incarnation")
    process_raw = _read_raw(control, "runtime-control/runtime-service/process-tree.json")
    owner_raw = _read_raw(control, "runtime-control/runtime-services/OWNER.json", maximum=256 * 1024)
    fence_raw = _read_raw(control, before["api_failure_fence_relative"], maximum=256 * 1024)
    process = _json(process_raw, "terminal diagnostic process receipt")
    if (process.get("schema") != "fullmag.docker-process-tree.v1"
            or process.get("state") != "shutdown_unknown"
            or process.get("runtime_pid") is not None
            or type(process.get("api_exit_code")) is not int
            or process.get("api_diagnostic_only") is not True
            or process.get("api_pid") != before["process_receipt"].get("api_pid")
            or process.get("api_failure_fence") != before["process_receipt"].get("api_failure_fence")
            or process.get("shutdown_error") != "runtime service owner is not ready"
            or not isinstance(process.get("service_owner"), Mapping)
            or "terminal_service_owner" in process):
        _fail("Stopped diagnostic supervisor did not publish canonical shutdown_unknown evidence")
    from docker_volume_stop_failed import _owner_identity_key, _validate_native_ready_owner
    ready_owner = _validate_native_ready_owner(process["service_owner"])
    if _owner_identity_key(ready_owner, "terminal ready-owner pin") != _owner_identity_key(
        before["failed_owner"], "preserved failed owner"
    ):
        _fail("Terminal ready-owner pin differs from the preserved failed OWNER")
    config_raw = _read_raw(control, "runtime-control/runtime-service/docker-all.json", maximum=256 * 1024)
    if (_sha256(config_raw) != before["runtime_config_sha256"]
            or _sha256(owner_raw) != before["failed_owner_sha256"]
            or _sha256(fence_raw) != before["api_failure_fence_sha256"]):
        _fail("Failed owner or API failure fence changed while stopping the diagnostic API")
    receipt = {
        "schema": "fullmag.docker-api-diagnostic-stop.v1",
        "state": "stopped-execution-unknown",
        "attempt": operation["receipt"]["inputs"]["attempt"],
        "config_sha256": operation["receipt"]["inputs"]["config_sha256"],
        "backend_container_id": backend_id,
        "backend_image_id": stopped.get("Image"),
        "backend_started_at": stopped.get("State", {}).get("StartedAt"),
        "backend_finished_at": state["FinishedAt"],
        "backend_exit_code": state["ExitCode"],
        "frontend_container_id": operation["receipt"]["inputs"]["frontend_container_id"],
        "runtime_owner_state": before["failed_owner"]["state"] + "-preserved",
        "execution_state": "unknown",
        "resource_leases": "untouched",
        "runtime_config_sha256": before["runtime_config_sha256"],
        "failed_owner_sha256": before["failed_owner_sha256"],
        "failure_process_receipt_sha256": before["process_receipt_sha256"],
        "terminal_process_receipt_sha256": _sha256(process_raw),
        "api_failure_fence_sha256": before["api_failure_fence_sha256"],
        "api_instance_id": before["probe"]["api_instance_id"],
        "api_exit_code": process["api_exit_code"],
        "shutdown_error": process["shutdown_error"],
        "retained_ready_owner": ready_owner,
    }
    if resume_pin is not None:
        receipt["resume_attempt"] = resume_pin["attempt"]
        receipt["resume_terminal_sha256"] = resume_pin["sha256"]
        receipt["continuation_phase"] = resume_pin.get("phase", "resume")
    control.write(operation["root"] + "/diagnostic-stop-terminal.json", receipt)
    return receipt


def _read_from_original_helper(
    control: BuildControl,
    helper_id: str,
    relative: str,
    *,
    optional: bool = False,
    maximum: int = MAX_EVIDENCE_BYTES,
) -> bytes | None:
    if not isinstance(helper_id, str) or CONTAINER_RE.fullmatch(helper_id) is None:
        _fail("Original stop-diagnostic helper ID is not canonical")
    script = control._namespace_guard(
        control_read_script(control.path(relative), maximum)
    )
    result = docker_capture(
        "exec", "--user", "65532:65532", helper_id,
        "/bin/bash", "-euo", "pipefail", "-c", script,
        timeout=90, allow_failure=True,
    )
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        _fail("Original helper could not read pinned control evidence: " + relative)
    raw = bytes(result.stdout)
    if len(raw) > maximum:
        _fail("Original helper returned oversized control evidence: " + relative)
    return raw


def _assert_read_timeout_attempt(
    control: BuildControl,
    helper_id: str,
    attempt: str,
    operation_inputs: Mapping[str, object],
    *,
    active_raw: bytes,
    receipt_raw: bytes,
) -> dict[str, object]:
    root = "stop-diagnostic/attempts/" + attempt
    if active_raw != (attempt + "\n").encode("ascii"):
        _fail("Original stop-diagnostic active marker differs from the named attempt")
    receipt = _json(receipt_raw, "retained stop-diagnostic receipt")
    expected_name = "fullmag-control-" + attempt
    expected_error = (
        "Docker observation exceeded its time/output budget during "
        "_control_raw (timeout=90s); daemon resources retained"
    )
    if (
        receipt.get("schema") != "fullmag.docker-build-operation.v1"
        or receipt.get("phase") != "stop-diagnostic"
        or receipt.get("state") != "outcome-unknown-resources-retained"
        or receipt.get("attempt") != attempt
        or receipt.get("compose_project") != control.project
        or receipt.get("control_volume") != control.volume
        or receipt.get("helper_container") != expected_name
        or receipt.get("error") != expected_error
        or not isinstance(receipt.get("inputs"), Mapping)
        or dict(receipt["inputs"]) != dict(operation_inputs)
    ):
        _fail("Old operation is not the exact preflight control-read timeout for these pins")
    if control.namespace:
        if (receipt.get("control_namespace") != control.namespace
                or receipt.get("namespace_registry_sha256") != control.namespace_registry_sha256):
            _fail("Old stop-diagnostic operation belongs to a different control namespace")
    elif "control_namespace" in receipt or "namespace_registry_sha256" in receipt:
        _fail("Old stop-diagnostic operation unexpectedly carries a control namespace")
    if expected_name != receipt.get("helper_container"):
        _fail("Old stop-diagnostic operation helper identity differs")

    for name in ("terminal.json", "diagnostic-stop-preflight.json", "diagnostic-stop-terminal.json"):
        if _read_from_original_helper(
            control, helper_id, root + "/" + name, optional=True
        ) is not None:
            _fail("Old stop-diagnostic attempt has evidence that forbids read-timeout reconciliation")
    return receipt


def _service_incarnation(actual: Mapping[str, object], service: str) -> dict[str, object]:
    row = actual.get(service)
    state = row.get("State") if isinstance(row, Mapping) else None
    if (not isinstance(row, Mapping) or not isinstance(state, Mapping)
            or state.get("Running") is not True
            or not isinstance(state.get("StartedAt"), str)
            or not state.get("StartedAt")
            or type(row.get("RestartCount")) is not int):
        _fail("Both exact retained services must remain running during read-timeout reconciliation")
    return {
        "container_id": row.get("Id"),
        "started_at": state["StartedAt"],
        "restart_count": row["RestartCount"],
        "running": True,
    }


def _publish_read_timeout_reconciliation(
    control: BuildControl,
    helper_id: str,
    *,
    root: str,
    active_sha256: str,
    receipt_sha256: str,
    proof_raw: bytes,
    terminal_raw: bytes,
) -> None:
    active_path = shlex.quote(control.path("active"))
    receipt_path = shlex.quote(control.path(root + "/receipt.json"))
    proof_path = shlex.quote(control.path(root + "/read-timeout-reconciliation-proof.json"))
    preflight_path = shlex.quote(control.path(root + "/diagnostic-stop-preflight.json"))
    diagnostic_terminal_path = shlex.quote(control.path(root + "/diagnostic-stop-terminal.json"))
    terminal_path = shlex.quote(control.path(root + "/terminal.json"))
    directory = shlex.quote(control.path(root))

    def assert_original_pins() -> str:
        return (
            f"test ! -L {active_path}; test -f {active_path}; test $(stat -c %h {active_path}) = 1; "
            f"test \"$(sha256sum {active_path} | cut -d' ' -f1)\" = {shlex.quote(active_sha256)}; "
            f"test ! -L {receipt_path}; test -f {receipt_path}; test $(stat -c %h {receipt_path}) = 1; "
            f"test \"$(sha256sum {receipt_path} | cut -d' ' -f1)\" = {shlex.quote(receipt_sha256)}; "
        )

    def publish(target: str, payload: bytes) -> str:
        encoded = shlex.quote(base64.b64encode(payload).decode("ascii"))
        return (
            f"test ! -e {target}; test ! -L {target}; "
            f"tmp=$(mktemp {directory}/.read-timeout-reconcile.XXXXXXXX); "
            f"trap 'rm -f -- \"$tmp\"' EXIT; "
            f"printf %s {encoded} | base64 -d > \"$tmp\"; chmod 0440 \"$tmp\"; "
            # Link publication is atomic and refuses an existing target even
            # if two reconciliations passed the preceding absence check.
            f"sync \"$tmp\"; ln -T -- \"$tmp\" {target}; rm -f -- \"$tmp\"; sync {directory}; "
        )

    script = (
        "set -euo pipefail; umask 027; "
        f"test ! -L {directory}; test -d {directory}; test \"$(readlink -f {directory})\" = {directory}; "
        + assert_original_pins()
        + f"test ! -e {proof_path}; test ! -L {proof_path}; "
        + f"test ! -e {terminal_path}; test ! -L {terminal_path}; "
        + publish(proof_path, proof_raw)
        + assert_original_pins()
        + f"test -f {proof_path}; test ! -L {proof_path}; test $(stat -c %h {proof_path}) = 1; "
        + f"test \"$(sha256sum {proof_path} | cut -d' ' -f1)\" = {shlex.quote(_sha256(proof_raw))}; "
        + f"test ! -e {preflight_path}; test ! -L {preflight_path}; "
        + f"test ! -e {diagnostic_terminal_path}; test ! -L {diagnostic_terminal_path}; "
        + publish(terminal_path, terminal_raw)
        + f"sync {directory}; sync /control; printf 'RECONCILED\\n'"
    )
    script = control._namespace_guard(script)
    result = docker_capture(
        "exec", "--user", "65532:65532", helper_id,
        "/bin/bash", "-euo", "pipefail", "-c", script,
        timeout=90, allow_failure=True,
    )
    if result.returncode:
        _fail("Original helper did not acknowledge read-timeout reconciliation publication")
    if result.stdout.strip() != b"RECONCILED":
        _fail("Original helper returned no canonical read-timeout reconciliation acknowledgement")


def _reconcile_read_timeout_attempt(
    args: argparse.Namespace,
    control: BuildControl,
    selected: Path,
    identity: Mapping[str, object],
    effective_previous: Mapping[str, object],
    document: Mapping[str, object],
    operation_inputs: Mapping[str, object],
) -> dict[str, object] | None:
    attempt = getattr(args, "reconcile_read_attempt", None)
    if attempt is None:
        return None
    if not isinstance(attempt, str) or ATTEMPT_RE.fullmatch(attempt) is None:
        _fail("Read-timeout reconciliation attempt is not a complete lowercase identity")

    from docker_volume_activation_reconcile import _validate_helper, _validate_helper_logged, _wait_for_helper_exit

    helper_name = "fullmag-control-" + attempt
    helper_document, helper_id = _validate_helper(
        control, helper_name, attempt, phase="stop-diagnostic"
    )
    if helper_document.get("Id") != helper_id:
        _fail("Original stop-diagnostic helper ID changed during authentication")
    _validate_helper_logged(helper_id)

    root = "stop-diagnostic/attempts/" + attempt
    active_raw = _read_from_original_helper(control, helper_id, "active", maximum=128)
    receipt_raw = _read_from_original_helper(control, helper_id, root + "/receipt.json")
    receipt = _assert_read_timeout_attempt(
        control, helper_id, attempt, operation_inputs,
        active_raw=active_raw or b"", receipt_raw=receipt_raw or b"",
    )

    image, ids, actual = _container_snapshot(
        args, selected, identity, control, effective_previous, document
    )
    if (image != operation_inputs.get("image_id")
            or ids.get("backend") != operation_inputs.get("backend_container_id")
            or ids.get("frontend") != operation_inputs.get("frontend_container_id")
            or actual["backend"].get("State", {}).get("StartedAt")
                != operation_inputs.get("backend_started_at")):
        _fail("Live Compose services differ from the old stop-diagnostic pins")
    original_operation = {"receipt": receipt}
    if _assert_group_consumers(control, original_operation, ids) != helper_id:
        _fail("Only the retained services and exact original helper may consume the group")
    service_incarnations = {
        name: _service_incarnation(actual, name) for name in ("backend", "frontend")
    }

    # Re-authenticate and reread all decision pins immediately before the
    # helper's CAS publication. Any stop preflight or service restart aborts.
    final_helper_document, final_helper_id = _validate_helper(
        control, helper_name, attempt, phase="stop-diagnostic"
    )
    if final_helper_id != helper_id or final_helper_document.get("Id") != helper_id:
        _fail("Original stop-diagnostic helper changed before reconciliation publication")
    _validate_helper_logged(helper_id)
    final_image, final_ids, final_actual = _container_snapshot(
        args, selected, identity, control, effective_previous, document
    )
    final_service_incarnations = {
        name: _service_incarnation(final_actual, name) for name in ("backend", "frontend")
    }
    if (final_image != image or final_ids != ids
            or final_service_incarnations != service_incarnations):
        _fail("A service identity or running incarnation changed before reconciliation publication")
    if _assert_group_consumers(control, original_operation, ids) != helper_id:
        _fail("Compose group acquired another consumer before reconciliation publication")
    final_active = _read_from_original_helper(control, helper_id, "active", maximum=128)
    final_receipt = _read_from_original_helper(control, helper_id, root + "/receipt.json")
    if final_active != active_raw or final_receipt != receipt_raw:
        _fail("Original active marker or receipt changed before reconciliation publication")
    _assert_read_timeout_attempt(
        control, helper_id, attempt, operation_inputs,
        active_raw=final_active or b"", receipt_raw=final_receipt or b"",
    )

    proof = {
        "schema": "fullmag.docker-api-diagnostic-stop-read-timeout-proof.v1",
        "state": "no-stop-confirmed",
        "attempt": attempt,
        "development_attempt": operation_inputs["attempt"],
        "config_sha256": operation_inputs["config_sha256"],
        "operation_inputs_sha256": _sha256(canonical(dict(operation_inputs))),
        "active_sha256": _sha256(active_raw or b""),
        "receipt_sha256": _sha256(receipt_raw or b""),
        "original_error": receipt["error"],
        "stop_preflight": "absent",
        "diagnostic_stop_terminal": "absent",
        "services": final_service_incarnations,
        "stop_action_performed": False,
        "created_at": time.time(),
    }
    proof_raw = canonical(proof) + b"\n"
    terminal = {
        **receipt,
        "state": "failed-confirmed",
        "error": receipt["error"],
        "reconciliation": "read-timeout-before-diagnostic-stop-preflight",
        "reconciliation_proof": root + "/read-timeout-reconciliation-proof.json",
        "reconciliation_proof_sha256": _sha256(proof_raw),
        "finished_at": time.time(),
    }
    terminal_raw = canonical(terminal) + b"\n"
    _publish_read_timeout_reconciliation(
        control, helper_id,
        root=root,
        active_sha256=_sha256(active_raw or b""),
        receipt_sha256=_sha256(receipt_raw or b""),
        proof_raw=proof_raw,
        terminal_raw=terminal_raw,
    )
    _wait_for_helper_exit(helper_id)
    return {
        "state": "failed-confirmed-no-stop",
        "attempt": attempt,
        "terminal_sha256": _sha256(terminal_raw),
        "proof_sha256": _sha256(proof_raw),
        "backend_container_id": ids["backend"],
        "backend_started_at": final_service_incarnations["backend"]["started_at"],
        "resource_leases": "untouched",
    }


def stop_diagnostic(args: argparse.Namespace) -> dict[str, object]:
    if getattr(args, "startup_recovery", False):
        return _stop_startup_recovery_diagnostic(args)
    if getattr(args, "expected_plan_sha256", None) is not None:
        _fail("A preview plan digest requires --startup-recovery")
    from docker_dev import _compose_identity, _select_source
    from docker_volume_unclaimed_cancellation import _control_raw, _json_object
    from docker_volume_dev import _operator_probe_record_from_retained

    for value, pattern, label in (
        (args.attempt, ATTEMPT_RE, "attempt"),
        (args.config_sha256, SHA256_RE, "Compose config SHA-256"),
    ):
        if not isinstance(value, str) or pattern.fullmatch(value) is None:
            _fail(label + " is not a complete lowercase identity")
    if type(args.port) is not int or not 1 <= args.port <= 65535:
        _fail("Frontend port is outside the valid range")
    resume_attempt = getattr(args, "resume_attempt", None)
    iteration_attempt = getattr(args, "iteration_attempt", None)
    failed_iteration = getattr(args, "failed_iteration_attempt", None)
    failed_sha = getattr(args, "failed_iteration_sha256", None)
    if bool(failed_iteration) != bool(failed_sha) or (failed_iteration and (resume_attempt or iteration_attempt)):
        _fail("Failed iteration requires its digest and excludes other continuation pins")
    if resume_attempt is not None and iteration_attempt is not None:
        _fail("Specify one exact resume or iteration, never both")
    continuation_phase = "iteration" if iteration_attempt is not None else "resume"
    resume_attempt = iteration_attempt if iteration_attempt is not None else resume_attempt
    if resume_attempt is not None and (
        not isinstance(resume_attempt, str) or ATTEMPT_RE.fullmatch(resume_attempt) is None
    ):
        _fail("Resume attempt is not a complete lowercase identity")
    preview = bool(getattr(args, "preview", False))
    if getattr(args, "catalog_failure", False) and getattr(args, "pending_activation", None) is None:
        _fail("Catalog-failure drain requires one exact pending activation")
    if (preview and getattr(args, "pending_activation", None) is not None
            and not getattr(args, "catalog_failure", False)):
        _fail("Diagnostic preview cannot abort a pending activation")
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(
        selected, identity
    )
    helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, helper_image)
    control.prepare()

    previous_root = "development/attempts/" + args.attempt
    terminal_raw = _read_raw(control, previous_root + "/terminal.json")
    previous = _json(terminal_raw, "retained development terminal")
    if (previous.get("schema") != "fullmag.docker-build-operation.v1"
            or previous.get("phase") != "development"
            or previous.get("state") not in {"failed-confirmed", "succeeded"}
            or previous.get("attempt") != args.attempt
            or previous.get("compose_project") != control.project):
        _fail("Diagnostic stop requires the exact terminal development attempt")
    inputs = previous.get("inputs")
    if not isinstance(inputs, Mapping) or inputs.get("source_root") != str(selected):
        _fail("Failed development attempt belongs to a different selected checkout")
    document_raw = _read_raw(control, previous_root + "/compose.json")
    document = _json(document_raw, "retained Compose document")
    if (_sha256(canonical(document)) != args.config_sha256
            or document.get("name") != control.project):
        _fail("Retained Compose project/configuration pin differs")
    _operator_probe_record_from_retained(previous, document)
    _port_matches(document, args.port)
    started_at = previous.get("backend_started_at")
    if not isinstance(started_at, str) or not started_at:
        _fail("Failed attempt does not pin the backend start time")
    resume_pin = None
    effective_previous = previous
    if resume_attempt is not None:
        resume_pin = _validate_resume_terminal(
            control,
            resume_attempt,
            development_attempt=args.attempt,
            config_sha256=args.config_sha256,
            previous=previous,
            phase=continuation_phase,
        )
        started_at = resume_pin["backend_started_at"]
        effective_previous = dict(previous)
        effective_previous["backend_started_at"] = started_at
        effective_previous["backend_container"] = resume_pin["backend_container"]
        effective_previous["frontend_container"] = resume_pin["frontend_container"]
    if failed_iteration:
        resume_pin = _validate_failed_iteration_terminal(control, failed_iteration, failed_sha,
            development_attempt=args.attempt, config_sha256=args.config_sha256, previous=previous)
        started_at = resume_pin["backend_started_at"]
        effective_previous = dict(previous, backend_started_at=started_at)
    # A failed-confirmed start has a _finish process sidecar; a succeeded
    # start may fail later under supervision, so current process-tree bytes
    # are the live failure pin in that case.
    sidecar_raw = _control_raw(
        control, previous_root + "/process-failure.json", optional=True,
        maximum=MAX_EVIDENCE_BYTES,
    )
    if previous["state"] == "failed-confirmed" and sidecar_raw is None and resume_pin is None:
        _fail("Failed-confirmed attempt has no process-failure sidecar")
    process_raw = _read_raw(control, "runtime-control/runtime-service/process-tree.json")
    if (sidecar_raw is not None
            and _json(sidecar_raw, "retained process-failure sidecar")
                != _json(process_raw, "retained diagnostic process receipt")):
        _fail("Retained process-failure sidecar differs from the current process receipt")

    operation_inputs = {
        "attempt": args.attempt,
        "config_sha256": args.config_sha256,
        "source_root": str(selected),
        "image_id": inputs.get("image_id"),
        "backend_started_at": started_at,
        "backend_container_id": previous.get("backend_container"),
        "frontend_container_id": previous.get("frontend_container"),
        "terminal_sha256": _sha256(terminal_raw),
        "compose_sha256": _sha256(document_raw),
        "process_receipt_sha256": _sha256(process_raw),
    }
    if resume_pin is not None:
        operation_inputs.update(
            resume_attempt=resume_pin["attempt"],
            resume_terminal_sha256=resume_pin["sha256"],
        )
    if getattr(args, "pending_activation", None) is not None:
        from docker_volume_preparation_abort import abort_pending_preparation
        return abort_pending_preparation(
            args, control, selected, identity, effective_previous, document,
            previous_root, operation_inputs, resume_pin,
        )
    if not preview:
        _reconcile_read_timeout_attempt(
            args, control, selected, identity, effective_previous, document, operation_inputs
        )
    operation_inputs["preview_only"] = preview
    phase = "stop-diagnostic-preview" if preview else "stop-diagnostic"
    with control.operation(phase, operation_inputs) as operation:
        from docker_volume_preparation_abort import pin_completed_fresh_archive
        pin_completed_fresh_archive(control)
        operation["receipt"].update(state="validating-diagnostic-api")
        image, ids, actual = _container_snapshot(
            args, selected, identity, control, effective_previous, document
        )
        operation["receipt"]["image_id"] = image
        operation["receipt"]["inputs"].update(
            backend_container_id=ids["backend"], frontend_container_id=ids["frontend"]
        )
        helper_id = _assert_group_consumers(control, operation, ids)
        guest_probe = _probe_backend(ids["backend"])
        before = _probe_evidence(control, previous_root, guest_probe)
        failed_runtime = None
        if failed_iteration:
            if actual["frontend"]["State"]["StartedAt"] != resume_pin["frontend_started_at"]:
                _fail("Frontend incarnation differs from the failed iteration")
            failed_runtime = _failed_iteration_runtime_probe(actual["backend"], before)
        if before["process_receipt_sha256"] != operation_inputs["process_receipt_sha256"]:
            _fail("Diagnostic process receipt changed since the retained failure was pinned")
        # Re-read the pins and repeat both process and health observation
        # immediately before signaling the exact backend container.
        if (_sha256(_read_raw(control, previous_root + "/terminal.json")) != operation_inputs["terminal_sha256"]
                or _sha256(_read_raw(control, previous_root + "/compose.json")) != operation_inputs["compose_sha256"]
                or _optional_sidecar_sha256(control, previous_root) != before["process_failure_sidecar_sha256"]):
            _fail("Retained terminal, Compose, or process-failure evidence changed under the stop lease")
        if (resume_pin is not None
                and _sha256(_read_raw(control, resume_pin["relative"])) != resume_pin["sha256"]):
            _fail("Successful resume terminal changed under the diagnostic stop lease")
        fresh_image, fresh_ids, fresh_actual = _container_snapshot(
            args, selected, identity, control, effective_previous, document
        )
        if (fresh_image != image or fresh_ids != ids
                or any(fresh_actual[name].get("State", {}).get("StartedAt")
                       != actual[name].get("State", {}).get("StartedAt")
                       for name in ids)):
            _fail("Compose container incarnation changed during diagnostic stop preflight")
        fresh_probe = _probe_backend(ids["backend"])
        rechecked = _probe_evidence(control, previous_root, fresh_probe)
        if failed_iteration and _failed_iteration_runtime_probe(fresh_actual["backend"], rechecked) != failed_runtime:
            _fail("Failed iteration pending cgroup/run evidence changed")
        stable_keys = (
            "runtime_config_sha256", "failed_owner_sha256", "process_receipt_sha256",
            "process_failure_sidecar_sha256", "api_failure_fence_sha256",
        )
        if any(rechecked[key] != before[key] for key in stable_keys):
            _fail("Runtime configuration, owner, process receipt, or failure fence changed before stop")
        if fresh_probe.get("api_instance_id") != guest_probe.get("api_instance_id"):
            _fail("Diagnostic API incarnation changed during stop preflight")
        operation["receipt"].update(state="stopping-diagnostic-api", helper_container_id=helper_id)
        preflight = {
            "schema": "fullmag.docker-api-diagnostic-stop-preflight.v1",
            "attempt": args.attempt,
            "config_sha256": args.config_sha256,
            "terminal_sha256": operation_inputs["terminal_sha256"],
            "compose_sha256": operation_inputs["compose_sha256"],
            "backend_container_id": ids["backend"],
            "backend_image_id": image,
            "backend_started_at": started_at,
            "frontend_container_id": ids["frontend"],
            "runtime_config_sha256": before["runtime_config_sha256"],
            "failed_owner_sha256": before["failed_owner_sha256"],
            "failed_owner": before["failed_owner"],
            "retained_ready_owner": before["ready_owner"],
            "process_receipt_sha256": before["process_receipt_sha256"],
            "process_failure_sidecar_sha256": before["process_failure_sidecar_sha256"],
            "api_failure_fence_sha256": before["api_failure_fence_sha256"],
            "api_instance_id": guest_probe["api_instance_id"],
            "probe_process_ids": fresh_probe["process_ids"],
            "owner_pids_absent": fresh_probe["owner_pids_absent"],
            "resource_leases": "untouched",
        }
        if resume_pin is not None:
            preflight["resume_attempt"] = resume_pin["attempt"]
            preflight["resume_terminal_sha256"] = resume_pin["sha256"]
        if failed_runtime is not None:
            preflight["failed_iteration_stop_only"] = failed_runtime
        control.write(operation["root"] + "/diagnostic-stop-preflight.json", preflight)
        if (
            _sha256(_read_raw(control, previous_root + "/terminal.json"))
            != operation_inputs["terminal_sha256"]
            or (
                resume_pin is not None
                and _sha256(_read_raw(control, resume_pin["relative"])) != resume_pin["sha256"]
            )
        ):
            _fail("Original or resume terminal changed immediately before the backend stop")
        if preview:
            operation["receipt"].update(state="succeeded", stopped_backend=False, execution_state="unknown")
            return {"state": "preview-passed", "stop_applied": False,
                    "backend_container_id": ids["backend"], "frontend_container_id": ids["frontend"],
                    "owner_state": before["failed_owner"]["state"],
                    "preflight": operation["root"] + "/diagnostic-stop-preflight.json"}
        operation["daemon_pending"] = True
        docker_capture("stop", "--time", "60", ids["backend"], timeout=90)
        observed = json.loads(docker_capture("inspect", ids["backend"]).stdout)
        if len(observed) != 1:
            _fail("Stopped backend inspection is ambiguous")
        stopped = observed[0]
        if (stopped.get("Id") != ids["backend"]
                or stopped.get("Image") != image
                or stopped.get("State", {}).get("StartedAt") != started_at
                or stopped.get("State", {}).get("Running") is not False):
            _fail("Docker did not confirm stopping the exact retained backend incarnation")
        operation["daemon_pending"] = False
        frontend_now = json.loads(docker_capture("inspect", ids["frontend"]).stdout)
        if (len(frontend_now) != 1
                or frontend_now[0].get("Id") != ids["frontend"]
                or frontend_now[0].get("Image") != image
                or frontend_now[0].get("State", {}).get("StartedAt")
                    != actual["frontend"].get("State", {}).get("StartedAt")
                or frontend_now[0].get("State", {}).get("Running") is not True):
            _fail("Frontend changed while stopping the backend; no further lifecycle action was taken")
        terminal_result = _terminal_receipt(
            control, operation, ids["backend"], before, stopped, resume_pin
        )
        operation["receipt"].update(
            state="succeeded",
            stopped_backend=True,
            execution_state="unknown",
            diagnostic_stop_terminal_sha256=_sha256(canonical(terminal_result)),
        )
        return terminal_result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--failed-iteration-attempt")
    parser.add_argument("--failed-iteration-sha256")
    parser.add_argument(
        "--resume-attempt",
        help="exact successful retained resume attempt that pins the current backend start time",
    )
    parser.add_argument(
        "--reconcile-read-attempt",
        help="reconcile one exact preflight control-read timeout before beginning a new stop attempt",
    )
    args = parser.parse_args(argv)
    try:
        result = stop_diagnostic(args)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (BuildControlError, ValueError, OSError, json.JSONDecodeError) as error:
        print("stop-diagnostic-volume: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
