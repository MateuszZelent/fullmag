#!/usr/bin/env python3
"""Pure host-side validation and Engine attestation for a claimed interruption.

The orchestrator owns Docker lifecycle operations. This module only validates
its request and bounded Engine/manifest observations; it never stops a service
or reports a worker exit code or scientific outcome.
"""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
import hashlib
import json
import math
import re
from typing import Any

import docker_orphan_recovery as recovery


REQUEST_SCHEMA = "claimed_worker_interruption.v1"
TEARDOWN_ATTESTATION_SCHEMA = "docker_namespace_teardown_attestation.v1"
MAX_SAFE_INTEGER = (1 << 53) - 1
MAX_REQUEST_BYTES = 256 * 1024
MAX_PRESERVED_MANIFEST_BYTES = 1024 * 1024
MAX_PRESERVED_FILES = 100_000
MAX_DEVICE_REQUESTS = 128
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{64}$")
STORE_COMPONENT_RE = re.compile(r"^[A-Za-z0-9._-]{1,200}$")
GPU_UUID_RE = re.compile(r"^GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")

_REQUEST_FIELDS = {
    "schema_version",
    "request_id",
    "identity",
    "consumed_launch_token",
    "catalog_before_sha256",
    "catalog_revision",
    "expected_task",
    "pins",
    "docker_engine_id_sha256",
    "device_release_mapping_sha256",
    "gpu_uuid",
    "container",
    "container_started_at",
}
_IDENTITY_FIELDS = {
    "store_id",
    "host_id",
    "run_id",
    "task_id",
    "attempt_id",
    "ownership_epoch",
    "resource_id",
    "lease_token",
    "reservation_request_sha256",
    "reservation_before_sha256",
    "lease_before_sha256",
    "runtime_generation_sha256",
}
_PIN_FIELDS = {
    "owner_sha256",
    "config_sha256",
    "process_receipt_sha256",
    "launch_sha256",
    "journal_sha256",
    "inbox_sha256",
    "execution_started_sha256",
    "supervisor_slot_sha256",
    "package_receipt_sha256",
    "executable_sha256",
    "source_snapshot_sha256",
    "mount_attestation_sha256",
    "preserved_files_manifest_sha256",
}
_CONTAINER_FIELDS = {
    "scope",
    "container_id",
    "image_id",
    "compose_project",
    "service",
    "config_sha256",
    "private_pid_namespace",
    "host_pid",
    "sole_worker_scope",
    "device_requests",
}
_TASK_FIELDS = {
    "task_id",
    "input_fingerprint",
    "lifecycle",
    "readiness",
    "observation",
    "attempt_id",
    "ownership_epoch",
    "resolved_input_fingerprint",
    "artifact_ids",
    "resource_id",
    "coordinator_watermark",
    "coordinator_genesis",
}


def _fail(message: str) -> None:
    recovery._fail(f"claimed worker interruption: {message}")


def _exact_mapping(
    value: Any,
    label: str,
    *,
    required: set[str],
    optional: set[str] | None = None,
) -> dict[str, Any]:
    result = recovery._mapping(value, label)
    if any(not isinstance(key, str) for key in result):
        _fail(f"{label} contains a non-string field name")
    optional = optional or set()
    unknown = set(result) - required - optional
    missing = required - set(result)
    if unknown:
        _fail(f"{label} has unknown fields: {', '.join(sorted(unknown))}")
    if missing:
        _fail(f"{label} is missing fields: {', '.join(sorted(missing))}")
    return result


def _digest(value: Any, label: str) -> str:
    return recovery._sha(value, label, nonzero=True)


def _store_component(value: Any, label: str) -> str:
    """Mirror repository_path::validate_store_id without V1 request parsing."""

    if not isinstance(value, str) or STORE_COMPONENT_RE.fullmatch(value) is None:
        _fail(f"{label} is not a native repository identifier")
    if value in {".", ".."} or value.endswith("."):
        _fail(f"{label} is not a native repository identifier")
    stem = value.split(".", 1)[0].upper()
    if stem in {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}:
        _fail(f"{label} is a reserved repository identifier")
    if len(stem) == 4 and stem[:3] in {"COM", "LPT"} and stem[3] in "123456789":
        _fail(f"{label} is a reserved repository identifier")
    return value


def _safe_uint(value: Any, label: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < (1 if positive else 0):
        qualifier = "positive" if positive else "non-negative"
        _fail(f"{label} must be a {qualifier} safe integer")
    if value > MAX_SAFE_INTEGER:
        _fail(f"{label} exceeds the safe integer range")
    return value


def _json_safe(value: Any, label: str) -> None:
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int):
        if not -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
            _fail(f"{label} contains an unsafe integer")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            _fail(f"{label} contains a non-finite number")
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                _fail(f"{label} contains a non-string object key")
            _json_safe(item, label)
        return
    if isinstance(value, list):
        for item in value:
            _json_safe(item, label)
        return
    _fail(f"{label} contains a value that is not JSON")


def _normalize_task(value: Any) -> dict[str, Any]:
    task = _exact_mapping(
        value,
        "expected_task",
        required={"task_id", "input_fingerprint", "lifecycle"},
        optional=_TASK_FIELDS - {"task_id", "input_fingerprint", "lifecycle"},
    )
    _json_safe(task, "expected_task")
    lifecycle = task["lifecycle"]
    if not isinstance(lifecycle, str) or lifecycle not in {
        "accepted", "queued", "preparing", "running", "stopping",
        "succeeded", "failed", "cancelled", "interrupted",
    }:
        _fail("expected_task.lifecycle is not a native task lifecycle")
    readiness = task.get("readiness", {"state": "ready"})
    readiness = _exact_mapping(
        readiness,
        "expected_task.readiness",
        required={"state"},
        optional={"reason"},
    )
    if readiness["state"] == "ready":
        if set(readiness) != {"state"}:
            _fail("ready task readiness has an unexpected reason")
        normalized_readiness = {"state": "ready"}
    elif readiness["state"] == "blocked":
        if set(readiness) != {"state", "reason"}:
            _fail("blocked task readiness requires one reason")
        reason = recovery._string(readiness["reason"], "expected_task.readiness.reason")
        if not reason.strip():
            _fail("blocked task readiness reason is empty")
        normalized_readiness = {"state": "blocked", "reason": reason}
    else:
        _fail("expected_task.readiness.state is not native")

    normalized: dict[str, Any] = {
        "task_id": _store_component(task["task_id"], "expected_task.task_id"),
        "input_fingerprint": _digest(task["input_fingerprint"], "expected_task.input_fingerprint"),
        "lifecycle": lifecycle,
        "readiness": normalized_readiness,
    }
    observation = task.get("observation")
    if observation is not None:
        if not isinstance(observation, str) or observation not in {
            "live", "stale", "disconnected", "reconciling",
        }:
            _fail("expected_task.observation is not native")
        normalized["observation"] = observation
    attempt_id = task.get("attempt_id")
    if attempt_id is not None:
        normalized["attempt_id"] = _store_component(attempt_id, "expected_task.attempt_id")
    ownership_epoch = task.get("ownership_epoch")
    if ownership_epoch is not None:
        normalized["ownership_epoch"] = _safe_uint(
            ownership_epoch, "expected_task.ownership_epoch", positive=True
        )
    resolved_fingerprint = task.get("resolved_input_fingerprint")
    if resolved_fingerprint is not None:
        normalized["resolved_input_fingerprint"] = _digest(
            resolved_fingerprint, "expected_task.resolved_input_fingerprint"
        )
    artifact_ids = task.get("artifact_ids", [])
    if not isinstance(artifact_ids, list):
        _fail("expected_task.artifact_ids must be an array")
    normalized["artifact_ids"] = [
        _store_component(value, "expected_task.artifact_ids[]") for value in artifact_ids
    ]
    resource_id = task.get("resource_id")
    if resource_id is not None:
        normalized["resource_id"] = _store_component(resource_id, "expected_task.resource_id")

    watermark = task.get("coordinator_watermark")
    if watermark is not None:
        watermark = _exact_mapping(
            watermark,
            "expected_task.coordinator_watermark",
            required={"command_sequence", "event_sequence"},
        )
        if ownership_epoch is None:
            _fail("coordinator watermark requires an ownership epoch")
        normalized["coordinator_watermark"] = {
            "command_sequence": _safe_uint(watermark["command_sequence"], "command_sequence"),
            "event_sequence": _safe_uint(watermark["event_sequence"], "event_sequence"),
        }

    genesis = task.get("coordinator_genesis")
    if genesis is not None:
        genesis = _validate_genesis(genesis, normalized)
        if watermark is None:
            _fail("coordinator genesis requires a catalog watermark")
        normalized["coordinator_genesis"] = genesis
    return normalized


def _validate_genesis(value: Any, task: Mapping[str, Any]) -> dict[str, Any]:
    genesis = _exact_mapping(
        value,
        "expected_task.coordinator_genesis",
        required={
            "run_id",
            "task_id",
            "attempt_id",
            "ownership_epoch",
            "lease_token",
            "lease_heartbeat_sequence",
            "checkpoint_sha256",
            "checkpoint",
        },
    )
    run_id = _store_component(genesis["run_id"], "coordinator_genesis.run_id")
    task_id = _store_component(genesis["task_id"], "coordinator_genesis.task_id")
    attempt_id = _store_component(genesis["attempt_id"], "coordinator_genesis.attempt_id")
    epoch = _safe_uint(genesis["ownership_epoch"], "coordinator_genesis.ownership_epoch", positive=True)
    lease_token = _store_component(genesis["lease_token"], "coordinator_genesis.lease_token")
    heartbeat = _safe_uint(genesis["lease_heartbeat_sequence"], "coordinator_genesis.lease_heartbeat_sequence")
    checkpoint = deepcopy(genesis["checkpoint"])
    _json_safe(checkpoint, "coordinator_genesis.checkpoint")
    checkpoint_sha = _digest(genesis["checkpoint_sha256"], "coordinator_genesis.checkpoint_sha256")
    if recovery.canonical_json_sha256(checkpoint) != checkpoint_sha:
        _fail("coordinator genesis checkpoint hash differs")
    if not isinstance(checkpoint, Mapping):
        _fail("coordinator genesis checkpoint must be an object")
    claim = checkpoint.get("claim")
    lease = claim.get("lease") if isinstance(claim, Mapping) else None
    checkpoint_task = checkpoint.get("task")
    command_sequence = checkpoint.get("command_sequence")
    event_sequence = checkpoint.get("event_sequence")
    claim_epoch = claim.get("ownership_epoch") if isinstance(claim, Mapping) else None
    heartbeat_sequence = lease.get("heartbeat_sequence") if isinstance(lease, Mapping) else None
    task_epoch = checkpoint_task.get("ownership_epoch") if isinstance(checkpoint_task, Mapping) else None
    for value, label in (
        (command_sequence, "checkpoint.command_sequence"),
        (event_sequence, "checkpoint.event_sequence"),
        (claim_epoch, "checkpoint.claim.ownership_epoch"),
        (heartbeat_sequence, "checkpoint.claim.lease.heartbeat_sequence"),
        (task_epoch, "checkpoint.task.ownership_epoch"),
    ):
        _safe_uint(value, label)
    if (
        checkpoint.get("schema_version") != "coordinator_checkpoint.v1"
        or command_sequence != 0
        or event_sequence != 0
        or not isinstance(claim, Mapping)
        or not isinstance(lease, Mapping)
        or not isinstance(checkpoint_task, Mapping)
        or claim.get("run_id") != run_id
        or claim.get("task_id") != task_id
        or claim.get("attempt_id") != attempt_id
        or claim.get("ownership_epoch") != epoch
        or lease.get("lease_token") != lease_token
        or lease.get("heartbeat_sequence") != heartbeat
        or checkpoint_task.get("run_id") != run_id
        or checkpoint_task.get("task_id") != task_id
        or checkpoint_task.get("attempt_id") != attempt_id
        or checkpoint_task.get("ownership_epoch") != epoch
    ):
        _fail("coordinator genesis metadata differs from its checkpoint claim")
    if (
        task.get("task_id") != task_id
        or task.get("attempt_id") != attempt_id
        or task.get("ownership_epoch") != epoch
    ):
        _fail("coordinator genesis differs from the expected task claim")
    return {
        "run_id": run_id,
        "task_id": task_id,
        "attempt_id": attempt_id,
        "ownership_epoch": epoch,
        "lease_token": lease_token,
        "lease_heartbeat_sequence": heartbeat,
        "checkpoint_sha256": checkpoint_sha,
        "checkpoint": checkpoint,
    }


def validate_request(value: Mapping[str, Any]) -> dict[str, Any]:
    """Return a deep-copied native-shaped request after fail-closed validation."""

    request = deepcopy(_exact_mapping(value, "claimed interruption request", required=_REQUEST_FIELDS))
    if request["schema_version"] != REQUEST_SCHEMA:
        _fail("unsupported claimed interruption request schema")
    request["request_id"] = recovery._uuid_text(request["request_id"], "request_id")
    request["consumed_launch_token"] = recovery._uuid_text(
        request["consumed_launch_token"], "consumed_launch_token"
    )

    identity = _exact_mapping(request["identity"], "identity", required=_IDENTITY_FIELDS)
    identity["store_id"] = recovery._store_id(identity["store_id"], "identity.store_id")
    identity["host_id"] = recovery._string(identity["host_id"], "identity.host_id")
    if not identity["host_id"].strip():
        _fail("identity.host_id is empty")
    for field in ("run_id", "task_id", "attempt_id", "resource_id", "lease_token"):
        identity[field] = _store_component(identity[field], f"identity.{field}")
    identity["ownership_epoch"] = _safe_uint(
        identity["ownership_epoch"], "identity.ownership_epoch", positive=True
    )
    for field in (
        "reservation_request_sha256",
        "reservation_before_sha256",
        "lease_before_sha256",
        "runtime_generation_sha256",
    ):
        identity[field] = _digest(identity[field], f"identity.{field}")

    request["catalog_before_sha256"] = _digest(
        request["catalog_before_sha256"], "catalog_before_sha256"
    )
    request["catalog_revision"] = _safe_uint(
        request["catalog_revision"], "catalog_revision", positive=True
    )
    request["docker_engine_id_sha256"] = _digest(
        request["docker_engine_id_sha256"], "docker_engine_id_sha256"
    )
    request["device_release_mapping_sha256"] = _digest(
        request["device_release_mapping_sha256"], "device_release_mapping_sha256"
    )
    gpu_uuid = request["gpu_uuid"]
    if gpu_uuid is not None:
        gpu_uuid = recovery._string(gpu_uuid, "gpu_uuid", maximum=255)
        if GPU_UUID_RE.fullmatch(gpu_uuid) is None:
            _fail("gpu_uuid must be a canonical physical NVML GPU identity")
    request["gpu_uuid"] = gpu_uuid
    pins = _exact_mapping(request["pins"], "pins", required=_PIN_FIELDS)
    for field in _PIN_FIELDS:
        pins[field] = _digest(pins[field], f"pins.{field}")

    task = _normalize_task(request["expected_task"])
    if (
        task["task_id"] != identity["task_id"]
        or task.get("attempt_id") != identity["attempt_id"]
        or task.get("ownership_epoch") != identity["ownership_epoch"]
        or task.get("resource_id") != identity["resource_id"]
        or task["lifecycle"] not in {"running", "stopping"}
    ):
        _fail("expected_task is not the exact running/stopping claim")

    container = _exact_mapping(request["container"], "container", required=_CONTAINER_FIELDS)
    if container["scope"] != "dedicated_parent":
        _fail("claimed interruption requires the dedicated parent scope")
    if not isinstance(container["container_id"], str) or CONTAINER_ID_RE.fullmatch(container["container_id"]) is None:
        _fail("container.container_id must be a full lowercase Docker ID")
    image = recovery._image(container["image_id"], "container.image_id")
    _digest(image.removeprefix("sha256:"), "container.image_id")
    container["compose_project"] = recovery._string(
        container["compose_project"], "container.compose_project", maximum=512
    )
    if not container["compose_project"].strip() or container["service"] != "backend":
        _fail("claimed interruption requires the dedicated backend service")
    container["config_sha256"] = _digest(container["config_sha256"], "container.config_sha256")
    # This binds Docker inspect.Config. pins.config_sha256 instead binds the
    # native service JSON bytes; each is checked against its own producer.
    if container["private_pid_namespace"] is not True or container["host_pid"] is not False:
        _fail("claimed interruption requires a private PID namespace")
    if container["sole_worker_scope"] is not True:
        _fail("claimed interruption requires the explicitly pinned sole-worker scope")
    device_requests = container["device_requests"]
    if not isinstance(device_requests, list) or not device_requests or len(device_requests) > MAX_DEVICE_REQUESTS:
        _fail("container.device_requests must contain the bounded GPU device mapping")
    _json_safe(device_requests, "container.device_requests")

    request["container_started_at"] = recovery._string(
        request["container_started_at"], "container_started_at"
    )
    recovery._finished_timestamp(request["container_started_at"])
    request["identity"] = identity
    request["pins"] = pins
    request["expected_task"] = task
    request["container"] = container
    try:
        if len(recovery._canonical(request)) > MAX_REQUEST_BYTES:
            _fail("request exceeds its native publication budget")
    except recovery.OrphanRecoveryError:
        raise
    except Exception as error:  # pragma: no cover - defensive serialization boundary
        _fail(f"request is not canonical JSON: {error}")
    return request


def canonical_request_sha256(value: Mapping[str, Any]) -> str:
    """Return the same sorted compact JSON digest used by the native DTO."""

    return recovery.canonical_json_sha256(validate_request(value))


def _validate_preserved_files_manifest(value: Any, request: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the immutable SessionStore inventory pinned before interruption."""

    manifest = _exact_mapping(
        value,
        "preserved_files_manifest",
        required={"schema_version", "root_relative", "files"},
    )
    if manifest["schema_version"] != "claimed_worker_preserved_files.v1":
        _fail("preserved files manifest has an unsupported schema")
    identity = request["identity"]
    expected_root = (
        f"runs/{identity['run_id']}/worker-attempts/{identity['task_id']}/"
        f"{identity['attempt_id']}/epoch-{identity['ownership_epoch']}"
    )
    if manifest["root_relative"] != expected_root:
        _fail("preserved files manifest is not rooted at the exact worker epoch")

    files = recovery._mapping(manifest["files"], "preserved files manifest.files")
    if len(files) > MAX_PRESERVED_FILES:
        _fail("preserved files manifest exceeds its file budget")
    normalized_files: dict[str, dict[str, Any]] = {}
    for relative, record in files.items():
        try:
            relative_size = len(relative.encode("utf-8")) if isinstance(relative, str) else 0
        except UnicodeEncodeError:
            _fail("preserved files manifest contains a non-Unicode relative path")
        if (
            not isinstance(relative, str)
            or not relative
            or relative_size > 4096
            or relative.startswith("/")
            or "\\" in relative
            or ":" in relative
            or any(ord(char) < 0x20 or ord(char) == 0x7f for char in relative)
            or any(part in {"", ".", ".."} for part in relative.split("/"))
        ):
            _fail("preserved files manifest contains an unsafe relative path")
        entry = _exact_mapping(
            record,
            f"preserved files manifest.files[{relative!r}]",
            required={"bytes", "sha256"},
        )
        normalized_files[relative] = {
            "bytes": _safe_uint(entry["bytes"], f"preserved file {relative}.bytes"),
            "sha256": _digest(entry["sha256"], f"preserved file {relative}.sha256"),
        }

    started = normalized_files.get("worker_execution_started.v1.json")
    if started is None or started["sha256"] != request["pins"]["execution_started_sha256"]:
        _fail("preserved files manifest does not retain the exact Started receipt")
    normalized = {
        "schema_version": "claimed_worker_preserved_files.v1",
        "root_relative": expected_root,
        "files": normalized_files,
    }
    try:
        if len(recovery._canonical(normalized)) > MAX_PRESERVED_MANIFEST_BYTES:
            _fail("preserved files manifest exceeds its native publication budget")
    except recovery.OrphanRecoveryError:
        raise
    except Exception as error:  # pragma: no cover - defensive serialization boundary
        _fail(f"preserved files manifest is not canonical JSON: {error}")
    digest = recovery.canonical_json_sha256(normalized)
    if digest != request["pins"]["preserved_files_manifest_sha256"]:
        _fail("preserved files manifest differs from its pre-prepare pin")
    return normalized


def _inspection_manifest(value: Any) -> Mapping[str, Any]:
    """Require the existing bounded Docker observation manifest reference."""

    reference = recovery._mapping(value, "inspection_manifest")
    if set(reference) == {"path", "sha256"}:
        return reference
    if set(reference) == {"manifest_path", "manifest_sha256"}:
        return reference
    _fail("inspection_manifest requires exactly its path and SHA-256")


def _started_at(inspect: Mapping[str, Any], label: str) -> str:
    state = recovery._state(inspect)
    value = recovery._string(state.get("StartedAt"), f"{label}.State.StartedAt")
    recovery._finished_timestamp(value)
    return value


def _checked_engine_pid(inspect: Mapping[str, Any], label: str, *, stopped: bool) -> int:
    state = recovery._state(inspect)
    pid = state.get("Pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid < 0 or pid > MAX_SAFE_INTEGER:
        _fail(f"{label}.State.Pid is not a safe integer")
    if stopped and pid != 0:
        _fail("Docker Engine did not report exited PID 0")
    if not stopped and pid <= 0:
        _fail("Docker Engine before-inspect does not report a live PID")
    return pid


def build_teardown_attestation(
    request: Mapping[str, Any],
    engine_before: Mapping[str, Any],
    engine_after: Mapping[str, Any],
    beforeinspect: Mapping[str, Any],
    afterinspect: Mapping[str, Any],
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    """Build the native attestation from Engine and both pinned manifests.

    ``manifest`` is a strict wrapper with ``inspection_manifest`` (the existing
    Docker before/after observation artifact) and ``preserved_files_manifest``
    (the SessionStore worker-epoch inventory).
    """

    request = validate_request(request)
    before_engine_id = recovery._engine_id(engine_before, "engine_before")
    after_engine_id = recovery._engine_id(engine_after, "engine_after")
    engine_sha = hashlib.sha256(before_engine_id.encode("utf-8")).hexdigest()
    if before_engine_id != after_engine_id or engine_sha != request["docker_engine_id_sha256"]:
        _fail("Docker Engine identity changed or differs from the request")

    before_started_at = _started_at(beforeinspect, "beforeinspect")
    after_started_at = _started_at(afterinspect, "afterinspect")
    if (
        before_started_at != request["container_started_at"]
        or after_started_at != request["container_started_at"]
        or before_started_at != after_started_at
    ):
        _fail("Docker Engine StartedAt changed from the pinned container incarnation")
    before_pid = _checked_engine_pid(beforeinspect, "beforeinspect", stopped=False)
    after_pid = _checked_engine_pid(afterinspect, "afterinspect", stopped=True)

    binding = request["container"]
    before = recovery._observed_container(binding, beforeinspect, stopped=False)
    after = recovery._observed_container(binding, afterinspect, stopped=True)
    recovery._finished_timestamp(after["finished_at"])

    manifest = _exact_mapping(
        manifest,
        "claimed interruption manifests",
        required={"inspection_manifest", "preserved_files_manifest"},
    )
    preserved_manifest = _validate_preserved_files_manifest(
        manifest["preserved_files_manifest"], request
    )
    inspection = manifest["inspection_manifest"]
    if isinstance(inspection, Mapping) and set(inspection) == {"document", "sha256"}:
        manifest_document = deepcopy(recovery._mapping(inspection["document"], "inspection document"))
        _json_safe(manifest_document, "inspection document")
        manifest_sha = _digest(inspection["sha256"], "inspection manifest digest")
        if recovery.canonical_json_sha256(manifest_document) != manifest_sha:
            _fail("inspection document differs from its canonical SHA-256")
    else:
        manifest_sha, manifest_document = recovery._manifest_digest(_inspection_manifest(inspection))
    observations = recovery._validate_manifest_observation(manifest_document, binding)
    manifest_before = observations["before"]
    manifest_after = observations["after"]
    engine_before_state = recovery._state(beforeinspect)
    engine_after_state = recovery._state(afterinspect)
    if (
        isinstance(manifest_before.get("pid"), bool)
        or not isinstance(manifest_before.get("pid"), int)
        or isinstance(manifest_after.get("pid"), bool)
        or not isinstance(manifest_after.get("pid"), int)
        or isinstance(manifest_after.get("descendant_count"), bool)
        or not isinstance(manifest_after.get("descendant_count"), int)
        or manifest_before.get("state") != engine_before_state.get("Status")
        or manifest_before.get("pid") != before_pid
        or manifest_after.get("state") != engine_after_state.get("Status")
        or manifest_after.get("pid") != after_pid
        or manifest_after.get("descendant_count") != 0
        or manifest_after.get("finished_at") != after["finished_at"]
    ):
        _fail("preserved-files manifest observations differ from Docker Engine inspection")

    release_fields = {"resource_id", "mapping_sha256", "mapping_detached"}
    if request["gpu_uuid"] is not None:
        release_fields.add("gpu_uuid")
    release = _exact_mapping(
        manifest_document.get("device_release"),
        "device release",
        required=release_fields,
    )
    if release.get("resource_id") != request["identity"]["resource_id"]:
        _fail("manifest device release belongs to another resource")
    if release.get("mapping_detached") is not True:
        _fail("manifest does not prove all GPU mappings detached")
    mapping_sha = _digest(release.get("mapping_sha256"), "device_release.mapping_sha256")
    if mapping_sha != request["device_release_mapping_sha256"]:
        _fail("manifest configured placement digest differs from its request pin")
    gpu_uuid = release.get("gpu_uuid")
    if gpu_uuid is not None:
        gpu_uuid = recovery._string(gpu_uuid, "device_release.gpu_uuid", maximum=255)
    if gpu_uuid != request["gpu_uuid"]:
        _fail("manifest GPU UUID differs from its configured placement pin")

    namespace = {
        "schema_version": TEARDOWN_ATTESTATION_SCHEMA,
        "request_sha256": canonical_request_sha256(request),
        "docker_engine_id_sha256": request["docker_engine_id_sha256"],
        "containers": [{
            "container_id": binding["container_id"],
            "image_id": binding["image_id"],
            "config_sha256": binding["config_sha256"],
            "before": before,
            "after": after,
        }],
        "device_release": {
            "resource_id": request["identity"]["resource_id"],
            **({"gpu_uuid": gpu_uuid} if gpu_uuid is not None else {}),
            "mapping_sha256": mapping_sha,
            "mapping_detached": True,
        },
        "manifest_sha256": manifest_sha,
        "result": "authoritative_teardown",
    }
    preserved_manifest_sha = recovery.canonical_json_sha256(preserved_manifest)
    return {
        "namespace": namespace,
        "before_started_at": before_started_at,
        "after_started_at": after_started_at,
        "preserved_files_manifest_sha256": preserved_manifest_sha,
    }


__all__ = ["REQUEST_SCHEMA", "canonical_request_sha256", "build_teardown_attestation", "validate_request"]
