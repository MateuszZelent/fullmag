"""Controlled recovery of one stopped Docker DEV namespace.

The command is intentionally narrower than an ordinary ``docker-dev up``.
It consumes an operator authorization already published in the selected
control volume, proves the exact stopped backend/frontend pair, writes the
native request and teardown attestation to that same volume, removes only the
pin-ned old containers, and reuses the normal two-service development start.

Build caches, request documents, manifests and lifecycle receipts stay in the
Compose control volume.  Windows session and result data are read through the
existing ``/state`` bind and are never copied into a host build directory.
"""
from __future__ import annotations

import argparse
import copy
from collections.abc import Mapping, Sequence
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import uuid

import fullmag_storage as storage
from docker_dev_host import docker_argv
from docker_build_control import (
    BuildControl,
    BuildControlError,
    bounded_capture,
    canonical,
    control_read_script,
    docker_capture,
    toolchain_configuration,
)


# The host-side operator document and the document consumed by PID 1 are two
# different capabilities.  Keeping the schemas separate prevents a file that
# merely names old containers from being accepted as native recovery proof.
OPERATOR_AUTHORIZATION_SCHEMA = (
    "fullmag.docker-container-recovery-operator-authorization.v1"
)
AUTHORIZATION_SCHEMA = "fullmag.docker-container-recovery-authorization.v1"
REQUEST_SCHEMA = "runtime_service_container_recovery_request.v1"
ATTESTATION_SCHEMA = "docker_namespace_teardown_attestation.v1"
AUTHORIZATION_ENV = "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION"
AUTHORIZATION_SHA_ENV = "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION_SHA256"
CONTROL_ROOT = "/opt/fullmag/control"
RUNTIME_CONTROL_RELATIVE = "runtime-control"
RECOVERY_RELATIVE_ROOT = "runtime-services/container-recovery"
MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
MAX_AUTHORIZATION_BYTES = 256 * 1024
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
CONTAINER_RE = re.compile(r"[0-9a-f]{64}\Z")
ATTEMPT_RE = re.compile(r"[0-9a-f]{32}\Z")
# Compose projects retain the full registered worktree identity.  Docker's
# 63-byte limit applies to the derived network alias, not the project label.
# Keep this validator in lock-step with docker_compose_identity.py.
PROJECT_RE = re.compile(r"[a-z0-9][a-z0-9_-]*\Z")
REQUEST_ID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)


class ContainerRecoveryError(BuildControlError):
    """The explicit stopped-namespace recovery proof is absent or stale."""


def _fail(message: str) -> None:
    raise ContainerRecoveryError(message)


def _canonical(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        _fail(f"recovery record is not canonical JSON: {error}")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _require_sha(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        _fail(f"{label} must be a lowercase SHA-256")
    if set(value) == {"0"}:
        _fail(f"{label} cannot be an all-zero placeholder")
    return value


def _require_image(value: object, label: str) -> str:
    if not isinstance(value, str) or IMAGE_RE.fullmatch(value) is None:
        _fail(f"{label} must be an immutable image ID")
    return value


def _require_container(value: object, label: str) -> str:
    if not isinstance(value, str) or CONTAINER_RE.fullmatch(value) is None:
        _fail(f"{label} must be a complete Docker container ID")
    return value


def _require_text(value: object, label: str, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        _fail(f"{label} must be a bounded non-empty string")
    if any(ord(character) < 0x20 or ord(character) == 0x7f for character in value):
        _fail(f"{label} contains a control character")
    return value


def _require_mapping(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, Mapping):
        _fail(f"{label} must be an object")
    return dict(value)


def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _parse_json(raw: bytes, label: str) -> dict[str, object]:
    if len(raw) > MAX_DOCUMENT_BYTES:
        _fail(f"{label} exceeds the document budget")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        _fail(f"{label} is not valid JSON: {error}")
    return _require_mapping(value, label)


def _relative_control_path(value: object) -> str:
    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value:
        _fail("recovery authorization must be a relative control-volume path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or str(path) != value:
        _fail("recovery authorization path escapes the control volume")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", value):
        _fail("recovery authorization path contains unsupported characters")
    return value


def validate_operator_authorization(value: Mapping[str, object]) -> dict[str, object]:
    """Validate the exact operator fence, without touching Docker or storage."""

    authorization = _require_mapping(value, "container recovery operator authorization")
    required = {
        "schema_version", "request_id", "source_root", "compose_project",
        "development_attempt", "compose_config_sha256", "backend_container_id",
        "frontend_container_id", "old_image_id", "prior_stop_journal",
        "prior_stop_journal_sha256", "process_receipt_sha256", "config_sha256",
        "owner_sha256", "launch_sha256",
    }
    if set(authorization) != required:
        _fail("operator authorization fields do not match the frozen v1 schema")
    if authorization.get("schema_version") != OPERATOR_AUTHORIZATION_SCHEMA:
        _fail("unsupported container recovery operator authorization schema")
    request_id = authorization.get("request_id")
    if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
        _fail("operator authorization request_id must be a canonical UUID")
    attempt = authorization.get("development_attempt")
    if not isinstance(attempt, str) or ATTEMPT_RE.fullmatch(attempt) is None:
        _fail("operator authorization development_attempt is invalid")
    source_root = _require_text(authorization.get("source_root"), "operator source_root")
    project = authorization.get("compose_project")
    if not isinstance(project, str) or PROJECT_RE.fullmatch(project) is None:
        _fail("operator authorization Compose project is invalid")
    for key in (
        "compose_config_sha256", "prior_stop_journal_sha256", "process_receipt_sha256",
        "config_sha256", "owner_sha256", "launch_sha256",
    ):
        _require_sha(authorization.get(key), f"operator authorization {key}")
    for key in ("backend_container_id", "frontend_container_id"):
        _require_container(authorization.get(key), f"operator authorization {key}")
    _require_image(authorization.get("old_image_id"), "operator authorization old_image_id")
    prior_stop_journal = _relative_control_path(authorization.get("prior_stop_journal"))
    if authorization["backend_container_id"] == authorization["frontend_container_id"]:
        _fail("operator authorization repeats the backend/frontend container")
    return {
        **authorization,
        "request_id": request_id,
        "development_attempt": attempt,
        "attempt": attempt,
        "source_root": source_root,
        "compose_project": project,
        "stop_journal_path": prior_stop_journal,
        "stop_journal_sha256": authorization["prior_stop_journal_sha256"],
        # The stop journal is the immutable proof bundle.  It contains the
        # last ready-owner reprobe and the empty-store/ledger observation.  Do
        # not substitute the post-failure process receipt: that receipt only
        # proves that the failed container reached shutdown_unknown.
        "prior_ready_owner_proof_sha256": authorization["prior_stop_journal_sha256"],
        "services": {
            "backend": {
                "container_id": authorization["backend_container_id"],
                "image_id": authorization["old_image_id"],
            },
            "frontend": {
                "container_id": authorization["frontend_container_id"],
                "image_id": authorization["old_image_id"],
            },
        },
    }


def validate_authorization(value: Mapping[str, object]) -> dict[str, object]:
    """Backward-compatible public name for the operator authorization validator."""

    return validate_operator_authorization(value)


def validate_runtime_authorization(value: Mapping[str, object]) -> dict[str, object]:
    """Validate the bounded authorization consumed by the backend entrypoint."""

    authorization = _require_mapping(value, "container recovery runtime authorization")
    required = {
        "schema_version", "request_id", "source_root", "compose_project",
        "backend_container_id", "frontend_container_id", "old_image_id",
        "config_sha256", "owner_sha256", "launch_sha256",
        "operator_authorization_sha256", "native_request_path",
        "native_request_sha256", "attestation_path", "attestation_sha256",
        "manifest_path", "manifest_sha256", "prior_stop_journal_sha256",
    }
    if set(authorization) != required:
        _fail("runtime authorization fields do not match the frozen v1 schema")
    if authorization.get("schema_version") != AUTHORIZATION_SCHEMA:
        _fail("unsupported container recovery runtime authorization schema")
    request_id = authorization.get("request_id")
    if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
        _fail("runtime authorization request_id must be a canonical UUID")
    for key in (
        "config_sha256", "owner_sha256", "launch_sha256",
        "operator_authorization_sha256", "native_request_sha256",
        "attestation_sha256", "manifest_sha256", "prior_stop_journal_sha256",
    ):
        _require_sha(authorization.get(key), f"runtime authorization {key}")
    for key in ("source_root", "compose_project"):
        _require_text(authorization.get(key), f"runtime authorization {key}")
    _require_container(authorization.get("backend_container_id"), "runtime authorization backend_container_id")
    _require_container(authorization.get("frontend_container_id"), "runtime authorization frontend_container_id")
    _require_image(authorization.get("old_image_id"), "runtime authorization old_image_id")
    paths = {}
    for key in ("native_request_path", "attestation_path", "manifest_path"):
        value_path = authorization.get(key)
        if not isinstance(value_path, str) or not value_path.startswith(CONTROL_ROOT + "/"):
            _fail(f"runtime authorization {key} must be inside the control volume")
        paths[key] = value_path
    return {**authorization, **paths}


def _owner_for_native(owner: object) -> dict[str, object]:
    owner = _require_mapping(owner, "expected runtime-service owner")
    # Native owns the complete descriptor validation. The host checks only
    # fields needed to bind the Docker evidence and refuses a synthetic owner.
    if owner.get("schema_version") != "runtime_service_owner.v1":
        _fail("runtime-service owner schema differs from the image-owned schema")
    if owner.get("state") not in {"ready", "unknown"}:
        _fail("native container recovery cannot consume a drained or fabricated owner")
    for key in ("owner_token", "process_start_token", "target_id", "host", "protocol"):
        _require_text(owner.get(key), f"expected_owner.{key}", 255)
    if not isinstance(owner.get("pid"), int) or owner["pid"] <= 0:
        _fail("expected_owner.pid is not a live owner identity")
    children = owner.get("children")
    if not isinstance(children, list) or len(children) != 2:
        _fail("expected_owner must retain the two native child identities")
    return owner


def _owner_identity_key(owner: Mapping[str, object]) -> tuple[object, ...]:
    """Return the owner/child identity used to bind process receipts."""

    children = owner.get("children")
    if not isinstance(children, list):
        _fail("runtime-service owner has no child identity")
    child_identity = []
    for child in children:
        item = _require_mapping(child, "runtime-service owner child")
        role = _require_text(item.get("role"), "runtime-service owner child role", 64)
        pid = item.get("pid")
        if type(pid) is not int or pid <= 0:
            _fail("runtime-service owner child has no positive pid")
        child_identity.append((role, pid))
    return (
        owner.get("owner_token"), owner.get("process_start_token"), owner.get("pid"),
        owner.get("host"), owner.get("target_id"), owner.get("protocol"),
        tuple(sorted(child_identity)),
    )


def _validate_container_pins(pins: Sequence[object]) -> list[dict[str, object]]:
    if not isinstance(pins, list) or len(pins) != 2:
        _fail("container recovery requires exactly two container pins")
    result = []
    services = set()
    ids = set()
    projects = set()
    for raw in pins:
        item = _require_mapping(raw, "container pin")
        _require_container(item.get("container_id"), "container_id")
        _require_image(item.get("image_id"), "container image_id")
        _require_sha(item.get("config_sha256"), "container config_sha256")
        service = _require_text(item.get("service"), "container service", 255)
        project = _require_text(item.get("compose_project"), "container Compose project", 255)
        if service in services or item["container_id"] in ids:
            _fail("container recovery repeats a service or container")
        services.add(service)
        ids.add(item["container_id"])
        projects.add(project)
        if item.get("private_pid_namespace") is not True or item.get("host_pid") is not False:
            _fail("container recovery requires private PID namespaces without host PID")
        _require_sha(item.get("device_requests_sha256"), "container device_requests_sha256")
        result.append(item)
    if services != {"backend", "frontend"} or len(projects) != 1:
        _fail("container recovery pins must be backend/frontend in one Compose project")
    return result


def validate_request(value: Mapping[str, object]) -> dict[str, object]:
    """Validate the JSON shape accepted by native ``service-recover-container``."""

    request = _require_mapping(value, "runtime service container recovery request")
    if request.get("schema_version") != REQUEST_SCHEMA:
        _fail("unsupported runtime service container recovery request schema")
    request_id = request.get("request_id")
    if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
        _fail("runtime recovery request_id is not a canonical UUID")
    for key in (
        "config_sha256", "owner_sha256", "launch_sha256", "store_root_sha256",
        "ledger_root_sha256", "ledger_snapshot_sha256", "docker_engine_id_sha256",
        "docker_manifest_sha256", "prior_ready_owner_proof_sha256",
        "device_release_mapping_sha256",
    ):
        _require_sha(request.get(key), f"runtime recovery {key}")
    owner = _owner_for_native(request.get("expected_owner"))
    application = _require_mapping(request.get("application"), "runtime recovery application")
    if application.get("mode") not in {"external_only", "persisted"}:
        _fail("runtime recovery application mode is unsupported")
    _require_sha(application.get("raw_sha256"), "runtime recovery application raw_sha256")
    _require_text(request.get("device_release_resource_id"), "device_release_resource_id", 255)
    if request.get("device_release_gpu_uuid") is not None:
        _require_text(request["device_release_gpu_uuid"], "device_release_gpu_uuid", 255)
    containers = _validate_container_pins(request.get("containers"))
    return {**request, "expected_owner": owner, "application": application, "containers": containers}


def validate_attestation(
    value: Mapping[str, object], request: Mapping[str, object], request_sha256: str
) -> dict[str, object]:
    """Validate the teardown proof before it is written to the control volume."""

    request = validate_request(request)
    _require_sha(request_sha256, "request file SHA-256")
    attestation = _require_mapping(value, "Docker namespace teardown attestation")
    if attestation.get("schema_version") != ATTESTATION_SCHEMA:
        _fail("unsupported Docker namespace teardown attestation schema")
    if attestation.get("request_sha256") != request_sha256:
        _fail("teardown attestation request digest differs from raw request bytes")
    for key in ("docker_engine_id_sha256", "manifest_sha256"):
        _require_sha(attestation.get(key), f"teardown attestation {key}")
    if attestation["docker_engine_id_sha256"] != request["docker_engine_id_sha256"]:
        _fail("teardown attestation engine differs from request")
    if attestation["manifest_sha256"] != request["docker_manifest_sha256"]:
        _fail("teardown attestation manifest differs from request")
    device = _require_mapping(attestation.get("device_release"), "teardown device release")
    if (
        device.get("resource_id") != request["device_release_resource_id"]
        or device.get("gpu_uuid") != request.get("device_release_gpu_uuid")
        or device.get("mapping_sha256") != request["device_release_mapping_sha256"]
        or device.get("mapping_detached") is not True
    ):
        _fail("teardown device release differs from request")
    observations = attestation.get("containers")
    if not isinstance(observations, list) or len(observations) != len(request["containers"]):
        _fail("teardown container count differs from request")
    pins = {item["container_id"]: item for item in request["containers"]}
    observed_ids = set()
    for raw in observations:
        item = _require_mapping(raw, "teardown container observation")
        identifier = _require_container(item.get("container_id"), "teardown container_id")
        if identifier in observed_ids or identifier not in pins:
            _fail("teardown contains an unknown or repeated container")
        observed_ids.add(identifier)
        pin = pins[identifier]
        if item.get("image_id") != pin["image_id"] or item.get("config_sha256") != pin["config_sha256"]:
            _fail("teardown container identity differs from request")
        before = _require_mapping(item.get("before"), "teardown before observation")
        after = _require_mapping(item.get("after"), "teardown after observation")
        if (
            before.get("private_pid_namespace") != pin["private_pid_namespace"]
            or before.get("host_pid") != pin["host_pid"]
            or before.get("device_requests_sha256") != pin["device_requests_sha256"]
            or after.get("device_requests_sha256") != pin["device_requests_sha256"]
            or after.get("state") != "exited"
            or after.get("pid") != 0
            or after.get("descendant_count") != 0
            or after.get("private_pid_namespace") is not True
            or after.get("host_pid") is not False
            or not isinstance(after.get("finished_at"), str)
            or not after["finished_at"]
        ):
            _fail("teardown container after-state is not an authoritative exit proof")
    if observed_ids != set(pins):
        _fail("teardown does not cover every pinned service")
    if attestation.get("result") != "authoritative_teardown":
        _fail("teardown result is not authoritative")
    return {**attestation, "containers": list(observations), "device_release": device}


def _control_bytes(control: BuildControl, relative: str, *, optional: bool = False) -> bytes | None:
    path = control.path(relative)
    script = control_read_script(path, MAX_DOCUMENT_BYTES)
    result = bounded_capture(control.helper_args(script), data=b"", timeout=90)
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        _fail(f"cannot read control-volume record {relative}: " + result.stderr.decode("utf-8", "replace")[-1024:])
    if len(result.stdout) > MAX_DOCUMENT_BYTES:
        _fail(f"control-volume record {relative} exceeds its size bound")
    return bytes(result.stdout)


def _control_json(control: BuildControl, relative: str, *, optional: bool = False) -> tuple[dict[str, object] | None, bytes | None]:
    raw = _control_bytes(control, relative, optional=optional)
    if raw is None:
        return None, None
    return _parse_json(raw, f"control-volume record {relative}"), raw


def _env_map(container: Mapping[str, object]) -> dict[str, str]:
    config = container.get("Config")
    values = config.get("Env", []) if isinstance(config, Mapping) else []
    if not isinstance(values, list):
        _fail("container environment is malformed")
    result = {}
    for value in values:
        if isinstance(value, str) and "=" in value:
            name, item = value.split("=", 1)
            result[name] = item
    return result


def _device_requests(container: Mapping[str, object]) -> list[object]:
    host = container.get("HostConfig")
    value = host.get("DeviceRequests", []) if isinstance(host, Mapping) else []
    # Docker's inspect API emits JSON null when no device request was attached
    # to a container.  The canonical evidence representation is an empty list;
    # null and [] therefore have the same meaning, while other shapes remain
    # fail-closed.
    if value is None:
        return []
    if not isinstance(value, list):
        _fail("Docker DeviceRequests is malformed")
    return value


def _container_pin(container: Mapping[str, object], service: str, project: str) -> dict[str, object]:
    config = _require_mapping(container.get("Config"), f"{service} Config")
    labels = _require_mapping(config.get("Labels"), f"{service} labels")
    if labels.get("com.docker.compose.project") != project or labels.get("com.docker.compose.service") != service:
        _fail(f"{service} does not belong to the selected Compose project")
    identifier = _require_container(container.get("Id"), f"{service} container Id")
    image = _require_image(container.get("Image"), f"{service} image")
    host = _require_mapping(container.get("HostConfig"), f"{service} HostConfig")
    pid_mode = host.get("PidMode")
    private_pid = pid_mode in (None, "", "private")
    host_pid = pid_mode == "host"
    if not private_pid or host_pid:
        _fail(f"{service} does not use a private PID namespace")
    devices = _device_requests(container)
    return {
        "container_id": identifier,
        "image_id": image,
        "config_sha256": _sha256(_canonical(config)),
        "service": service,
        "compose_project": project,
        "private_pid_namespace": private_pid,
        "host_pid": host_pid,
        "device_requests_sha256": _sha256(_canonical(devices)),
    }


def _container_observation(container: Mapping[str, object], pin: Mapping[str, object], *, after: bool) -> dict[str, object]:
    state = _require_mapping(container.get("State"), "Docker container state")
    if after:
        if state.get("Status") != "exited" or state.get("Running") is True or state.get("Pid") != 0:
            _fail("stopped container has no authoritative exited namespace observation")
        finished = state.get("FinishedAt")
        if not isinstance(finished, str) or not finished.strip():
            _fail("stopped container has no FinishedAt")
        host = _require_mapping(container.get("HostConfig"), "Docker HostConfig")
        pid_mode = host.get("PidMode")
        return {
            "state": "exited",
            "pid": 0,
            "finished_at": finished,
            "descendant_count": 0,
            "private_pid_namespace": pid_mode in (None, "", "private"),
            "host_pid": pid_mode == "host",
            "device_requests_sha256": pin["device_requests_sha256"],
        }
    host = _require_mapping(container.get("HostConfig"), "Docker HostConfig")
    pid_mode = host.get("PidMode")
    return {
        "private_pid_namespace": pid_mode in (None, "", "private"),
        "host_pid": pid_mode == "host",
        "device_requests_sha256": pin["device_requests_sha256"],
    }


def _runtime_owner(control: BuildControl) -> tuple[dict[str, object], bytes, str]:
    owner, raw = _control_json(control, f"{RUNTIME_CONTROL_RELATIVE}/runtime-services/OWNER.json")
    if owner is None or raw is None:
        _fail("runtime-service OWNER.json is missing from the control volume")
    return _owner_for_native(owner), raw, _sha256(raw)


def _runtime_launch(control: BuildControl) -> tuple[dict[str, object], bytes, str]:
    launch, raw = _control_json(control, f"{RUNTIME_CONTROL_RELATIVE}/runtime-services/LAUNCH.json")
    if launch is None or raw is None:
        _fail("runtime-service LAUNCH.json is missing from the control volume")
    return launch, raw, _sha256(raw)


def _runtime_config(control: BuildControl) -> tuple[dict[str, object], bytes, str]:
    config, raw = _control_json(control, f"{RUNTIME_CONTROL_RELATIVE}/runtime-service/docker-all.json")
    if config is None or raw is None:
        _fail("runtime-service docker-all.json is missing from the control volume")
    return config, raw, _sha256(raw)


def _runtime_process_receipt(control: BuildControl) -> tuple[dict[str, object], bytes, str]:
    receipt, raw = _control_json(
        control, f"{RUNTIME_CONTROL_RELATIVE}/runtime-service/process-tree.json"
    )
    if receipt is None or raw is None:
        _fail("runtime-service process receipt is missing from the control volume")
    if receipt.get("schema") != "fullmag.docker-process-tree.v1":
        _fail("runtime-service process receipt schema differs from the image-owned schema")
    if receipt.get("state") != "shutdown_unknown":
        _fail("container recovery requires the current shutdown_unknown process receipt")
    if "startup_activation" in receipt:
        _fail("container recovery cannot consume an internal startup activation receipt")
    return receipt, raw, _sha256(raw)


def _application_pin(control: BuildControl, config_sha256: str) -> dict[str, str]:
    application, raw = _control_json(
        control, f"{RUNTIME_CONTROL_RELATIVE}/runtime-services/APPLICATION.json", optional=True
    )
    if application is None or raw is None:
        return {"mode": "external_only", "raw_sha256": config_sha256}
    return {"mode": "persisted", "raw_sha256": _sha256(raw)}


def _path_sha(value: object, label: str) -> str:
    path = _require_text(value, label, 4096)
    if not path.startswith("/") or ".." in PurePosixPath(path).parts:
        _fail(f"{label} is not an absolute POSIX path")
    return _sha256(path.encode("utf-8"))


def _device_release_from_config(
    config: Mapping[str, object], *, device_access: str | None = None
) -> tuple[dict[str, object], object]:
    """Derive the release pin from the image-owned host profile.

    The operator authorization intentionally contains no device mapping.  A
    mapping copied from a host-side JSON file would be an untrusted second
    source of truth.  The already authenticated runtime configuration is the
    only source used here; the mapping is hashed before it is put in either
    native document.
    """

    host = config.get("host_execution")
    if not isinstance(host, Mapping):
        _fail("runtime-service configuration has no host execution profile")
    placements = host.get("compute_placements")
    if not isinstance(placements, Mapping):
        _fail("runtime-service host profile has no compute placements")
    resources = config.get("compute_resources")
    if not isinstance(resources, list):
        _fail("runtime-service configuration has no compute resources")
    candidates: list[Mapping[str, object]] = []
    for item in resources:
        if not isinstance(item, Mapping):
            _fail("runtime-service compute resource is malformed")
        kind = item.get("kind")
        if device_access is None or kind == device_access:
            candidates.append(item)
    if len(candidates) != 1:
        _fail("runtime-service configuration does not identify one compute device release")
    resource_id = candidates[0].get("resource_id")
    _require_text(resource_id, "device release resource_id", 255)
    mapping = placements.get(resource_id)
    if not isinstance(mapping, Mapping):
        _fail("runtime-service host profile lacks the selected resource placement")
    mapping = dict(mapping)
    mapping_sha256 = _sha256(_canonical(mapping))
    release = {
        "resource_id": resource_id,
        "mapping_sha256": mapping_sha256,
        "mapping_detached": True,
    }
    gpu_uuid = mapping.get("gpu_uuid")
    if gpu_uuid is not None:
        _require_text(gpu_uuid, "device release gpu_uuid", 255)
        release["gpu_uuid"] = gpu_uuid
    return release, mapping


def _build_request(
    authorization: Mapping[str, object],
    *,
    owner: Mapping[str, object],
    owner_sha256: str,
    launch_sha256: str,
    config: Mapping[str, object],
    control: BuildControl,
    device_release: Mapping[str, object],
    config_sha256: str,
    store_root_sha256: str,
    ledger_root_sha256: str,
    ledger_snapshot_sha256: str,
    docker_engine_id_sha256: str,
    manifest_sha256: str,
    containers: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    device = _require_mapping(device_release, "device release")
    _require_text(device.get("resource_id"), "device release resource_id", 255)
    _require_sha(device.get("mapping_sha256"), "device release mapping_sha256")
    if device.get("mapping_detached") is not True:
        _fail("device release mapping is not detached")
    request = {
        "schema_version": REQUEST_SCHEMA,
        "request_id": authorization["request_id"],
        "config_sha256": config_sha256,
        "owner_sha256": owner_sha256,
        "launch_sha256": launch_sha256,
        "expected_owner": dict(owner),
        "store_root_sha256": store_root_sha256,
        "application": _application_pin(control, config_sha256),
        "ledger_root_sha256": ledger_root_sha256,
        "ledger_snapshot_sha256": ledger_snapshot_sha256,
        "docker_engine_id_sha256": docker_engine_id_sha256,
        "docker_manifest_sha256": manifest_sha256,
        "prior_ready_owner_proof_sha256": authorization["prior_ready_owner_proof_sha256"],
        "device_release_resource_id": device["resource_id"],
        "device_release_mapping_sha256": device["mapping_sha256"],
        **({"device_release_gpu_uuid": device["gpu_uuid"]} if "gpu_uuid" in device else {}),
        "containers": [dict(item) for item in containers],
    }
    return validate_request(request)


def _build_attestation(
    request: Mapping[str, object],
    request_sha256: str,
    engine_sha256: str,
    observations: Sequence[Mapping[str, object]],
    manifest_sha256: str,
    device_release: Mapping[str, object],
) -> dict[str, object]:
    attestation = {
        "schema_version": ATTESTATION_SCHEMA,
        "request_sha256": request_sha256,
        "docker_engine_id_sha256": engine_sha256,
        "containers": [dict(item) for item in observations],
        "device_release": dict(device_release),
        "manifest_sha256": manifest_sha256,
        "result": "authoritative_teardown",
    }
    return validate_attestation(attestation, request, request_sha256)


def _docker_engine_sha() -> str:
    output = _docker_engine_id()
    return _sha256(output.encode("utf-8"))


def _docker_engine_id() -> str:
    output = docker_capture("info", "--format", "{{.ID}}", timeout=60).stdout.decode().strip()
    if not output:
        _fail("Docker engine returned no immutable ID")
    return output


def _bind_source(container: Mapping[str, object], destination: str) -> str:
    mounts = container.get("Mounts")
    if not isinstance(mounts, list):
        _fail("stopped backend mount inventory is missing")
    candidates = [
        item for item in mounts
        if isinstance(item, Mapping) and item.get("Destination") == destination
    ]
    if len(candidates) != 1:
        _fail(f"stopped backend must have exactly one {destination} bind")
    mount = candidates[0]
    source = mount.get("Source")
    if mount.get("Type") != "bind" or not isinstance(source, str) or not source:
        _fail(f"stopped backend {destination} mount is not a host bind")
    if mount.get("RW") is not True:
        _fail(f"stopped backend {destination} mount must remain writable for its owner")
    return source


def _ledger_snapshot_mount(control, backend, compose):
    """Admit the CAS-pinned daemon volume or preserve the legacy host bind."""
    import docker_host_ledger as ledger

    service = compose.get("services", {}).get("backend", {}) if isinstance(compose, Mapping) else {}
    retained = service.get("x-fullmag-host-ledger-volume")
    mounts = [mount for mount in backend.get("Mounts", []) if isinstance(mount, Mapping)
              and mount.get("Destination") == "/host-ledger"]
    if len(mounts) != 1:
        _fail("stopped backend must have exactly one host-ledger mount")
    mounted = mounts[0]
    if retained is None and mounted.get("Type") == "bind":
        source = _bind_source(backend, "/host-ledger")
        return f"type=bind,src={source},dst=/host-ledger,readonly", None
    if not isinstance(retained, Mapping) or not isinstance(compose, Mapping):
        _fail("host-ledger volume requires its retained Compose descriptor")
    try:
        environment = service.get("environment", {})
        receipt = retained.get("host_receipt")
        ledger._validate_host_receipt(receipt, {
            "project_id": environment.get("FULLMAG_HOST_LEDGER_PROJECT_ID"),
            "mount_root": environment.get("FULLMAG_HOST_LEDGER_MOUNT_ROOT"),
            "backing_image": environment.get("FULLMAG_HOST_LEDGER_BACKING_IMAGE"),
        })
        descriptor = ledger.host_volume_descriptor(control.project,
            environment.get("FULLMAG_HOST_LEDGER_PROJECT_ID"),
            environment.get("FULLMAG_HOST_LEDGER_MOUNT_ROOT"), receipt)
        expected_mounts = [mount for mount in service.get("volumes", [])
                           if mount.get("target") == "/host-ledger"]
        if (compose.get("name") != control.project or retained != descriptor
                or compose.get("volumes", {}).get("host-ledger") != descriptor["compose_volume"]
                or expected_mounts != [descriptor["mount"]]
                or mounted.get("Type") != "volume" or mounted.get("Name") != descriptor["name"]
                or mounted.get("Driver") != "local" or mounted.get("RW") is not True):
            _fail("host-ledger mount differs from its canonical retained volume descriptor")
        observed = json.loads(docker_capture("volume", "inspect", descriptor["name"], timeout=30).stdout)
        volume = ledger._validate_host_volume(observed, descriptor)
        if mounted.get("Source") != volume["Mountpoint"]:
            _fail("host-ledger source differs from the inspected volume mountpoint")
    except (ledger.HostLedgerError, TypeError, ValueError, KeyError) as error:
        _fail(f"host-ledger volume proof is unavailable: {error}")
    return f"type=volume,src={descriptor['name']},dst=/host-ledger,readonly,volume-nocopy", descriptor


def _ledger_and_store_snapshot(
    control: BuildControl, backend: Mapping[str, object], *, compose=None
) -> dict[str, str]:
    """Read the exact accepted store and shared ledger through an isolated helper."""

    state_source = _bind_source(backend, "/state")
    ledger_mount, ledger_descriptor = _ledger_snapshot_mount(control, backend, compose)
    script = r'''import fcntl, hashlib, json, os, pathlib, time
MAX_ENTRIES=8192
def regular(path, label, maximum=8*1024*1024):
    path=pathlib.Path(path)
    if not path.is_absolute() or '..' in path.parts or path.is_symlink() or not path.is_file(): raise RuntimeError(label+' is not a regular file')
    data=path.read_bytes()
    if len(data)>maximum: raise RuntimeError(label+' exceeds the size bound')
    return data
def canonical(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
ledger=pathlib.Path('/host-ledger/ledger')
fd=os.open(ledger/'WRITER.lock', os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
try:
    deadline=time.monotonic()+5
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
            break
        except BlockingIOError as error:
            if time.monotonic()>=deadline: raise RuntimeError('host ledger writer lock remained busy within the observation budget') from error
            time.sleep(0.05)
        except OSError as error:
            raise RuntimeError('host ledger writer lock outcome is unknown') from error
    document=json.loads(regular(ledger/'HOST_RESOURCE_LEDGER.json','host ledger').decode())
    if not isinstance(document,dict) or not isinstance(document.get('reservations'),list): raise RuntimeError('host ledger reservations are missing')
    if any(not isinstance(item,dict) or item.get('state')!='released' for item in document['reservations']): raise RuntimeError('host ledger has active or unknown reservations')
    snapshot={'policy':document.get('policy'),'reservations':document['reservations'],'node_policy':document.get('node_policy')}
    if snapshot['policy'] is None: raise RuntimeError('host ledger policy is missing')
    ledger_digest=hashlib.sha256(canonical(snapshot)).hexdigest()
finally:
    fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)
store=pathlib.Path('/state/runs/docker-all/session-store')
if not store.is_dir() or store.is_symlink(): raise RuntimeError('accepted store root is missing')
runs=store/'runs'
if not runs.is_dir() or runs.is_symlink(): raise RuntimeError('accepted store runs directory is missing')
run_dirs=[]
for entry in os.scandir(runs):
    if entry.is_symlink() or not entry.is_dir(follow_symlinks=False): raise RuntimeError('accepted store runs has an invalid entry')
    run_dirs.append(entry.name)
    if len(run_dirs)>MAX_ENTRIES: raise RuntimeError('accepted store inventory is unbounded')
records=[]; count=0
for current, directories, files in os.walk(store, topdown=True, followlinks=False):
    current_path=pathlib.Path(current)
    if any((current_path/name).is_symlink() for name in directories): raise RuntimeError('accepted store contains a symlink')
    for name in files:
        count+=1
        if count>MAX_ENTRIES: raise RuntimeError('accepted store inventory is unbounded')
        path=current_path/name
        if path.is_symlink() or not path.is_file(): raise RuntimeError('accepted store contains an invalid file')
        if name in {'run_intent.json','run_catalog.json'}: records.append(str(path.relative_to(store)))
if records: raise RuntimeError('accepted store contains admitted run records')
print(json.dumps({'schema':'fullmag.container-recovery-storage-proof.v1','store_root_sha256':hashlib.sha256(b'/state/runs/docker-all/session-store').hexdigest(),'ledger_root_sha256':hashlib.sha256(b'/host-ledger/ledger').hexdigest(),'ledger_snapshot_sha256':ledger_digest,'store_file_count':count,'run_directories':sorted(run_dirs),'run_records':records,**({'host_ledger_volume_probe':volume_proof} if volume_proof is not None else {})},sort_keys=True))
'''
    if ledger_descriptor is not None:
        import docker_host_ledger as ledger
        # Reuse the bounded unprivileged mount/marker proof in this same helper.
        # Descriptor data travels as argv, never as executable Python source.
        script = (ledger.HOST_VOLUME_PROBE_FUNCTIONS + "\nimport json,signal,sys\nsignal.alarm(45)\n"
                  + "volume_proof=probe(json.loads(sys.argv[1]))\n" + script)
    else:
        script = "volume_proof=None\n" + script
    image = backend.get("Image")
    if not isinstance(image, str) or IMAGE_RE.fullmatch(image) is None:
        _fail("stopped backend image is unavailable for accepted-store proof")
    # Use the stopped backend image: the canonical helper image is a build
    # toolchain and is not guaranteed to contain the runtime Python used by
    # the store/ledger readers.  The script is passed as Python argv, never as
    # a shell program, so the probe cannot accidentally execute through bash.
    args = [
        *docker_argv("run"), "--rm", "-i",
        "--pull", "never", "--network", "none", "--runtime", "runc",
        "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--pids-limit", "32",
        "--memory", "64m", "--cpus", "0.25",
        "--env", "NVIDIA_VISIBLE_DEVICES=void",
        "--label", f"com.docker.compose.project={control.project}",
        "--label", "com.docker.compose.service=host-runtime-maintenance",
        "--label", f"org.fullmag.compose.project={control.project}",
        "--mount", f"type=bind,src={state_source},dst=/state,readonly",
        "--mount", ledger_mount,
        "--user", "65532:65532", "--entrypoint", "/usr/local/bin/python3",
        image, "-B", "-c", script,
    ]
    if ledger_descriptor is not None:
        args.append(canonical(ledger_descriptor).decode("utf-8"))
    result = bounded_capture(args, data=b"", timeout=90)
    if result.returncode:
        _fail("accepted store/ledger proof failed: " + result.stderr.decode("utf-8", "replace")[-4096:])
    try:
        value = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"accepted store/ledger proof is invalid JSON: {error}")
    if not isinstance(value, Mapping):
        _fail("accepted store/ledger proof is not an object")
    for key in ("store_root_sha256", "ledger_root_sha256", "ledger_snapshot_sha256"):
        _require_sha(value.get(key), f"storage proof {key}")
    if value.get("run_records") != []:
        _fail("accepted store/ledger proof contains run records")
    return dict(value)


def _inspect_pair(
    authorization: Mapping[str, object],
    project: str,
    compose: Mapping[str, object],
) -> tuple[dict[str, object], dict[str, object]]:
    """Read and validate the exact stopped Compose pair before mutation."""

    from docker_volume_dev import _assert_private_restart_network, _validate_retained_service

    services = authorization["services"]
    identifiers = {
        service: _require_container(_require_mapping(services[service], f"{service} authorization")["container_id"], f"{service} container_id")
        for service in ("backend", "frontend")
    }
    try:
        records = json.loads(docker_capture("inspect", identifiers["backend"], identifiers["frontend"], timeout=90).stdout)
    except (json.JSONDecodeError, TypeError) as error:
        _fail(f"pinned Docker services returned invalid inspection data: {error}")
    if not isinstance(records, list) or len(records) != 2:
        _fail("pinned Docker services are not both present")
    by_id = {item.get("Id"): item for item in records if isinstance(item, Mapping)}
    if set(by_id) != set(identifiers.values()):
        _fail("pinned Docker service identities changed before recovery")
    try:
        image_documents = json.loads(
            docker_capture("image", "inspect", authorization["old_image_id"], timeout=90).stdout
        )
    except (json.JSONDecodeError, TypeError) as error:
        _fail(f"pinned Docker image returned invalid inspection data: {error}")
    if not isinstance(image_documents, list) or len(image_documents) != 1:
        _fail("pinned Docker image is not available as one immutable image")
    image_config = _require_mapping(image_documents[0].get("Config"), "pinned image Config")
    result = {}
    for service, identifier in identifiers.items():
        item = by_id[identifier]
        config = _require_mapping(item.get("Config"), f"{service} Config")
        labels = _require_mapping(config.get("Labels"), f"{service} labels")
        if (
            labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != service
            or item.get("Image") != authorization["old_image_id"]
        ):
            _fail(f"pinned {service} ownership differs")
        state = _require_mapping(item.get("State"), f"{service} state")
        if state.get("Running") is True or state.get("Pid") not in (0, None):
            _fail(f"pinned {service} must remain stopped before recovery")
        try:
            _validate_retained_service(compose, item, service, image_config)
        except Exception as error:
            _fail(f"pinned {service} configuration or mount proof failed: {error}")
        result[service] = item
    actual = {"backend": result["backend"], "frontend": result["frontend"]}
    try:
        _assert_private_restart_network(actual, identifiers, project)
    except Exception as error:
        _fail(f"pinned private network proof failed: {error}")
    backend_networks = _require_mapping(
        _require_mapping(actual["backend"].get("NetworkSettings"), "backend NetworkSettings").get("Networks"),
        "backend networks",
    )
    frontend_networks = _require_mapping(
        _require_mapping(actual["frontend"].get("NetworkSettings"), "frontend NetworkSettings").get("Networks"),
        "frontend networks",
    )
    if set(backend_networks) != set(frontend_networks) or len(backend_networks) != 1:
        _fail("pinned backend/frontend do not share exactly one private network")
    return result["backend"], result["frontend"]


def _validate_pre_admission_stop_journal(
    journal: Mapping[str, object],
    authorization: Mapping[str, object],
    attempt: str,
) -> None:
    """Validate the immutable pre-admission proof for an unknown stop outcome."""

    if journal.get("attempt") != attempt:
        _fail("stop journal does not bind the exact development attempt")
    state = journal.get("state")
    if state not in {"outcome-unknown", "stopped-confirmed"}:
        _fail("stop journal does not describe a recoverable stopped namespace")
    if (
        journal.get("backend_container_id") != authorization["backend_container_id"]
        or journal.get("frontend_container_id") != authorization["frontend_container_id"]
        or journal.get("image_id") != authorization["old_image_id"]
    ):
        _fail("stop journal container identity differs from operator authorization")
    if journal.get("process_receipt_sha256") is not None:
        _require_sha(journal.get("process_receipt_sha256"), "stop journal process_receipt_sha256")
    if state == "stopped-confirmed":
        if not isinstance(journal.get("drained_process_receipt"), Mapping):
            _fail("successful stop journal has no durable drained receipt")
        return

    # The backend stop returned an outcome-unknown error.  The prior probe is
    # still usable because it was written before that stop began, but only if
    # it proves that no run was admitted and every host reservation was already
    # released.  The current shutdown_unknown receipt is checked separately.
    probe = _require_mapping(journal.get("proof_recheck"), "stop journal proof_recheck")
    if probe.get("schema") != "fullmag.docker-unadmitted-stop-probe.v1":
        _fail("outcome-unknown stop journal has no canonical reprobe")
    for key in ("request_id", "session_id", "source_sha256", "activation_marker_sha256"):
        if key not in probe:
            _fail(f"outcome-unknown reprobe has no {key}")
    if probe.get("request_id") != journal.get("request_id"):
        _fail("outcome-unknown reprobe request differs from stop journal")
    if probe.get("session_id") != journal.get("session_id"):
        _fail("outcome-unknown reprobe session differs from stop journal")
    if probe.get("source_sha256") != journal.get("source_sha256"):
        _fail("outcome-unknown reprobe source differs from stop journal")
    if probe.get("activation_marker_sha256") != journal.get("failure_marker_sha256"):
        _fail("outcome-unknown reprobe activation marker differs from stop journal")
    if probe.get("process_receipt_sha256") != journal.get("process_receipt_sha256"):
        _fail("outcome-unknown reprobe does not bind the prior process receipt")
    session = _require_mapping(probe.get("current_session"), "outcome-unknown current session")
    if session.get("status") != "startup_failed":
        _fail("outcome-unknown reprobe session is not startup_failed")
    queue = _require_mapping(probe.get("compute_queue"), "outcome-unknown compute queue")
    if queue.get("items") != []:
        _fail("outcome-unknown reprobe compute queue is not empty")
    if probe.get("current_run_status") != 404:
        _fail("outcome-unknown reprobe does not prove the current run is absent")
    store = _require_mapping(probe.get("accepted_store"), "outcome-unknown accepted store")
    if store.get("run_records") != []:
        _fail("outcome-unknown reprobe accepted store contains run records")
    ledger = _require_mapping(probe.get("host_ledger"), "outcome-unknown host ledger")
    states = ledger.get("reservation_states")
    if not isinstance(states, list) or any(state != "released" for state in states):
        _fail("outcome-unknown reprobe host ledger is not fully released")
    runtime = _require_mapping(probe.get("runtime_service"), "outcome-unknown runtime service")
    if runtime.get("state") != "ready" or runtime.get("configured") is not True:
        _fail("outcome-unknown reprobe native runtime is not ready")


def _network_name(container: Mapping[str, object], service: str) -> str:
    settings = _require_mapping(container.get("NetworkSettings"), f"{service} NetworkSettings")
    networks = _require_mapping(settings.get("Networks"), f"{service} networks")
    if len(networks) != 1:
        _fail(f"{service} does not have exactly one private network")
    name = next(iter(networks))
    _require_text(name, f"{service} private network", 255)
    return name


def _verify_network_after_removal(
    network_name: str, old_container_ids: Sequence[str], project: str
) -> str:
    """Prove that removing the pinned pair did not leave another consumer."""

    observed = docker_capture("network", "inspect", network_name, allow_failure=True, timeout=60)
    if observed.returncode:
        error = observed.stderr.decode("utf-8", "replace").lower()
        if "no such network" in error or "network not found" in error:
            return "absent"
        _fail("private Compose network could not be re-inspected after removal")
    try:
        documents = json.loads(observed.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"post-removal Compose network inspection is invalid: {error}")
    if not isinstance(documents, list) or len(documents) != 1:
        _fail("post-removal Compose network inspection is ambiguous")
    network = _require_mapping(documents[0], "post-removal Compose network")
    if network.get("Driver") != "bridge":
        _fail("post-removal Compose network driver changed")
    labels = _require_mapping(network.get("Labels"), "post-removal Compose network labels")
    if labels.get("com.docker.compose.project") != project:
        _fail("post-removal Compose network ownership changed")
    consumers = network.get("Containers", {})
    if not isinstance(consumers, Mapping):
        _fail("post-removal Compose network consumers are malformed")
    if set(consumers) & set(old_container_ids) or consumers:
        _fail("post-removal Compose network still has a consumer")
    return "empty"


def _assert_container_absent(identifier: str) -> None:
    observed = docker_capture("inspect", identifier, allow_failure=True)
    if observed.returncode == 0:
        _fail("recovery transition found an old Docker container after removal")
    error = observed.stderr.decode("utf-8", "replace").lower()
    if "no such object" not in error:
        _fail("recovery transition has no authoritative old-container absence proof")


def _load_recovery_transition(
    control: BuildControl,
    authorization: Mapping[str, object],
    project: str,
    compose: Mapping[str, object] | None = None,
) -> dict[str, object] | None:
    """Load an interrupted transition and prove its current boundary.

    ``prepared.json`` is intentionally sufficient to resume.  A process can
    disappear after the old containers have been removed and before
    ``absence.json`` is published.  Requiring both files would leave that
    exact destructive window unrecoverable.  When only the prepared record is
    present, each old container is either absent or revalidated as the exact
    stopped pinned incarnation; the caller removes any remaining incarnation
    while holding the lifecycle lease and then publishes ``absence.json``.
    """

    root = f"{RECOVERY_RELATIVE_ROOT}/{authorization['request_id']}"
    prepared, prepared_raw = _control_json(control, root + "/prepared.json", optional=True)
    absence, absence_raw = _control_json(control, root + "/absence.json", optional=True)
    if prepared is None and absence is None:
        return None
    if prepared is None or prepared_raw is None:
        _fail("recovery transition has an absence sidecar without its prepared record")
    if prepared.get("schema") != "fullmag.docker-container-recovery-transition.v1" or prepared.get("state") != "prepared-before-removal":
        _fail("recovery prepared sidecar schema/state is unsupported")
    if absence is not None:
        if absence_raw is None:
            _fail("recovery absence sidecar has no authenticated bytes")
        if absence.get("schema") != "fullmag.docker-container-recovery-transition.v1" or absence.get("state") != "old-containers-absent":
            _fail("recovery absence sidecar schema/state is unsupported")
    request, request_raw = _control_json(control, root + "/request.json")
    manifest, manifest_raw = _control_json(control, root + "/manifest.json")
    if request is None or request_raw is None or manifest is None or manifest_raw is None:
        _fail("recovery transition is missing its durable request or manifest")
    request_sha = _sha256(request_raw)
    manifest_sha = _sha256(manifest_raw)
    if request_sha != prepared.get("request_sha256"):
        _fail("recovery transition request digest is inconsistent")
    if manifest_sha != prepared.get("manifest_sha256"):
        _fail("recovery transition manifest digest is inconsistent")
    if absence is not None and (
        request_sha != absence.get("request_sha256")
        or manifest_sha != absence.get("manifest_sha256")
    ):
        _fail("recovery absence request or manifest digest is inconsistent")
    prepared_sha = _sha256(prepared_raw)
    if absence is not None and absence.get("prepared_sha256") != prepared_sha:
        _fail("recovery transition prepared sidecar digest is inconsistent")
    if any(
        prepared.get(key) != authorization.get(source)
        for key, source in (
            ("request_id", "request_id"),
            ("old_image_id", "old_image_id"),
            ("stop_journal_sha256", "stop_journal_sha256"),
        )
    ):
        _fail("recovery transition is bound to another authorization")
    old_ids = [authorization["backend_container_id"], authorization["frontend_container_id"]]
    if prepared.get("old_container_ids") != old_ids:
        _fail("recovery transition old-container identities differ from authorization")
    if absence is not None and absence.get("old_container_ids") != old_ids:
        _fail("recovery absence old-container identities differ from authorization")
    if absence is not None and absence.get("request_id") != authorization["request_id"]:
        _fail("recovery absence sidecar request differs from authorization")
    request = validate_request(request)
    if request.get("request_id") != authorization["request_id"] or request.get("docker_manifest_sha256") != manifest_sha:
        _fail("recovery transition request is not bound to its manifest")
    pins = _validate_container_pins(request.get("containers"))
    by_service = {pin["service"]: pin for pin in pins}
    if set(by_service) != {"backend", "frontend"}:
        _fail("recovery transition request has the wrong service set")
    if any(pin["container_id"] != old_ids[index] or pin["image_id"] != authorization["old_image_id"]
           for index, pin in enumerate((by_service["backend"], by_service["frontend"]))):
        _fail("recovery transition request container pins differ from authorization")
    if manifest.get("schema") != "fullmag.docker-container-recovery-manifest.v1" or manifest.get("request_id") != authorization["request_id"] or manifest.get("compose_project") != project:
        _fail("recovery transition manifest identity is unsupported")
    entries = manifest.get("containers")
    if not isinstance(entries, list) or len(entries) != 2:
        _fail("recovery transition manifest has no exact service observations")
    observed: dict[str, dict[str, object]] = {}
    for entry in entries:
        item = _require_mapping(entry, "recovery transition manifest service")
        service = _require_text(item.get("service"), "recovery transition manifest service name", 64)
        if service in observed:
            _fail("recovery transition manifest repeats a service")
        pin = _require_mapping(item.get("pin"), "recovery transition manifest pin")
        if pin != by_service.get(service):
            _fail("recovery transition manifest pin differs from request")
        container = _require_mapping(item.get("inspect"), "recovery transition manifest inspection")
        if container.get("Id") != pin.get("container_id") or container.get("Image") != pin.get("image_id"):
            _fail("recovery transition manifest inspection identity differs from pin")
        config = _require_mapping(container.get("Config"), "recovery transition manifest Config")
        if _sha256(_canonical(config)) != pin.get("config_sha256"):
            _fail("recovery transition manifest Config digest differs from pin")
        state = _require_mapping(container.get("State"), "recovery transition manifest state")
        if state.get("Running") is True or state.get("Pid") not in (0, None):
            _fail("recovery transition manifest does not prove stopped old services")
        observed[service] = container
    if set(observed) != {"backend", "frontend"}:
        _fail("recovery transition manifest does not cover backend and frontend")
    # The prepared record predates the network absence proof.  Derive the
    # private network from its immutable stopped observation so a crash before
    # absence.json remains resumable.
    manifest_backend_network = _network_name(observed["backend"], "backend")
    manifest_frontend_network = _network_name(observed["frontend"], "frontend")
    if manifest_backend_network != manifest_frontend_network:
        _fail("recovery transition manifest services do not share one private network")
    network_name = manifest_backend_network
    present: dict[str, dict[str, object]] = {}
    for service, pin in by_service.items():
        observed_current = docker_capture("inspect", pin["container_id"], allow_failure=True)
        if observed_current.returncode:
            error = observed_current.stderr.decode("utf-8", "replace").lower()
            if "no such object" not in error:
                _fail("recovery transition old-container inspection outcome is unknown")
            continue
        try:
            documents = json.loads(observed_current.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            _fail(f"recovery transition current {service} inspection is invalid: {error}")
        if not isinstance(documents, list) or len(documents) != 1 or not isinstance(documents[0], Mapping):
            _fail(f"recovery transition current {service} inspection is ambiguous")
        current = dict(documents[0])
        current_pin = _container_pin(current, service, project)
        if current_pin != pin:
            _fail(f"recovery transition current {service} differs from its prepared pin")
        state = _require_mapping(current.get("State"), f"current {service} state")
        if state.get("Running") is True or state.get("Pid") not in (0, None):
            _fail(f"recovery transition current {service} is not stopped")
        current_network = _network_name(current, service)
        if current_network != network_name:
            _fail(f"recovery transition current {service} changed private network")
        if compose is not None:
            from docker_volume_dev import _validate_retained_service

            image_documents = json.loads(
                docker_capture("image", "inspect", authorization["old_image_id"], timeout=90).stdout
            )
            if not isinstance(image_documents, list) or len(image_documents) != 1:
                _fail("recovery transition pinned image inspection is ambiguous")
            image_config = _require_mapping(image_documents[0].get("Config"), "pinned image Config")
            try:
                _validate_retained_service(compose, current, service, image_config)
            except Exception as error:
                _fail(f"recovery transition current {service} configuration changed: {error}")
        present[service] = current

    if absence is not None:
        absence_network = _require_text(absence.get("network_name"), "recovery transition network name", 255)
        if absence_network != network_name:
            _fail("recovery transition network name changed")
        for identifier in old_ids:
            _assert_container_absent(identifier)
        network_state = _verify_network_after_removal(network_name, old_ids, project)
        if absence.get("network_state") != network_state:
            _fail("recovery transition network absence proof changed")
    else:
        network_state = None
    return {
        "root": root,
        "prepared": prepared,
        "absence": absence,
        "prepared_sha": prepared_sha,
        "absence_sha": _sha256(absence_raw) if absence_raw is not None else None,
        "request": request,
        "request_raw": request_raw,
        "request_sha": request_sha,
        "manifest": manifest,
        "manifest_raw": manifest_raw,
        "manifest_sha": manifest_sha,
        "backend": observed["backend"],
        "frontend": observed["frontend"],
        "pins": pins,
        "network_name": network_name,
        "present": present,
        "network_state": network_state,
    }


def _validate_owner_host(owner: Mapping[str, object], backend: Mapping[str, object]) -> None:
    hostname = _require_mapping(backend.get("Config"), "backend Config").get("Hostname")
    if hostname != owner.get("host"):
        _fail("backend hostname does not bind the native owner host")


def _reused_session_host():
    from docker_volume_dev import _session_host
    return _session_host()


def _validate_reused_session_before_removal(
    layout: Mapping[str, object], state_root: object, old_image_id: str, engine_id: str
) -> dict[str, object]:
    """Validate the selected host profile before any old container removal."""

    try:
        state = storage.validate_path(
            Path(state_root),
            Path(layout["runtime_root"]),
            "retained session storage",
        )
    except (KeyError, TypeError, ValueError, storage.StorageError) as error:
        _fail("retained session state is outside the selected runtime root")
    host = _reused_session_host()
    windows = host.HOST_SCHEMA == "fullmag.windows-folder-host.v1"
    if not windows and host.HOST_SCHEMA != "fullmag.linux-native-host.v1":
        _fail("retained session host profile is unsupported")
    label = "Windows" if windows else "Linux"
    profile = "windows-folder-v1" if windows else "linux-native-v1"
    scope = "docker-desktop-linux" if windows else "docker-linux"
    certificate_path = state / Path(host.HOST_CERT_PATH).name
    owner_marker = state / host.OWNER_NAME
    try:
        certificate = json.loads(host.read_owned_regular(certificate_path))
        marker = json.loads(host.read_owned_regular(owner_marker))
        native = host.local_volume(state)
    except (OSError, ValueError, RuntimeError) as error:
        _fail(f"retained {label} storage proof is unavailable before removal: {error}")
    if (not isinstance(certificate, Mapping) or certificate != marker
            or certificate.get("schema") != host.HOST_SCHEMA):
        _fail(f"retained {label} storage certificate and owner marker differ")
    if (
        certificate.get("storage_profile") != profile
        or certificate.get("role") != "session"
        or certificate.get("owner_scope") != scope
    ):
        _fail(f"retained {label} storage certificate has the wrong ownership scope")
    owner_token = certificate.get("owner_token")
    try:
        parsed = uuid.UUID(str(owner_token))
    except (ValueError, TypeError, AttributeError) as error:
        _fail(f"retained {label} storage owner token is invalid")
    canonical_token = str(parsed) if windows else parsed.hex
    if parsed.int == 0 or canonical_token != owner_token:
        _fail(f"retained {label} storage owner token is not canonical")
    identity_fields = (
        "host_root", "host_filesystem", "host_drive_type", "host_volume_serial",
        "host_root_no_reparse",
    ) if windows else (
        "host_root", "host_filesystem", "host_platform", "host_device", "host_root_no_reparse",
    )
    for field in identity_fields:
        if certificate.get(field) != native.get(field):
            _fail(f"retained {label} storage identity changed: " + field)
    if not windows and certificate.get("host_inode") != state.stat().st_ino:
        _fail("retained Linux storage directory inode changed")
    if certificate.get("image_id") != old_image_id:
        _fail(f"retained {label} storage certificate does not belong to the old image")
    if certificate.get("engine_id") != engine_id:
        _fail(f"retained {label} storage certificate belongs to another Docker engine")
    return {
        "state": state,
        "host_certificate": certificate_path,
        "owner_marker": owner_marker,
        "certificate": certificate,
    }


def _validate_process_receipt_owner(
    process_receipt: Mapping[str, object], owner: Mapping[str, object]
) -> None:
    receipt_owner = process_receipt.get("service_owner")
    if not isinstance(receipt_owner, Mapping):
        _fail("runtime-service process receipt has no authenticated service owner")
    if _owner_identity_key(receipt_owner) != _owner_identity_key(owner):
        _fail("runtime-service process receipt owner differs from OWNER.json")


def _revalidate_recovery_boundary(
    control: BuildControl,
    authorization: Mapping[str, object],
    attempt: str,
    project: str,
    compose: Mapping[str, object],
    *,
    expected_backend: Mapping[str, object],
    expected_frontend: Mapping[str, object],
    expected_owner: Mapping[str, object],
    expected_process_receipt_sha: str,
    expected_config_sha: str,
    expected_launch_sha: str,
    expected_storage: Mapping[str, object],
    transition: Mapping[str, object] | None = None,
) -> dict[str, object]:
    """Re-read every destructive-boundary proof under the lifecycle lease.

    Image preparation happens before the development lease is acquired.  This
    second read is therefore mandatory: a stopped service, its owner proof or
    the empty accepted store may have changed while BuildKit was running.
    """

    terminal, _ = _control_json(control, f"development/attempts/{attempt}/terminal.json")
    current_compose, compose_raw = _control_json(
        control, f"development/attempts/{attempt}/compose.json"
    )
    journal, journal_raw = _control_json(control, authorization["stop_journal_path"])
    if (
        terminal is None
        or current_compose is None
        or compose_raw is None
        or journal is None
        or journal_raw is None
    ):
        _fail("recovery proof disappeared before the destructive boundary")
    if _sha256(_canonical(current_compose)) != authorization["compose_config_sha256"]:
        _fail("Compose configuration changed before the destructive boundary")
    if _sha256(journal_raw) != authorization["stop_journal_sha256"]:
        _fail("stop journal changed before the destructive boundary")
    if current_compose.get("name") != project or current_compose != compose:
        _fail("retained Compose document changed before the destructive boundary")
    if terminal.get("phase") != "development" or terminal.get("attempt") != attempt:
        _fail("retained development attempt changed before the destructive boundary")
    _validate_pre_admission_stop_journal(journal, authorization, attempt)

    current_transition = _load_recovery_transition(
        control, authorization, project, current_compose
    )
    if (transition is None) != (current_transition is None):
        _fail("recovery transition state changed before the destructive boundary")
    if transition is None:
        backend, frontend = _inspect_pair(authorization, project, current_compose)
        network_name = _network_name(backend, "backend")
        if network_name != _network_name(expected_backend, "backend"):
            _fail("private Compose network changed before the destructive boundary")
        pinned_backend = backend
    else:
        if current_transition is None:
            _fail("prepared recovery transition disappeared before the destructive boundary")
        # The manifest is the immutable pre-removal observation.  Current
        # containers, when any remain, were checked against its exact pin by
        # _load_recovery_transition.  Use the manifest observation for mounts,
        # owner hostname and storage proof because a prepared-only retry may
        # already have removed the backend.
        backend = current_transition["backend"]
        frontend = current_transition["frontend"]
        network_name = current_transition["network_name"]
        pinned_backend = (
            current_transition["present"].get("backend")
            or backend
        )
        if backend.get("Id") != expected_backend.get("Id") or frontend.get("Id") != expected_frontend.get("Id"):
            _fail("prepared recovery manifest changed before the destructive boundary")
    process_receipt, _, process_receipt_sha = _runtime_process_receipt(control)
    if process_receipt_sha != expected_process_receipt_sha:
        _fail("shutdown_unknown process receipt changed before the destructive boundary")
    owner, owner_raw, owner_sha = _runtime_owner(control)
    if owner_sha != authorization["owner_sha256"]:
        _fail("runtime-service owner changed before the destructive boundary")
    if _owner_identity_key(owner) != _owner_identity_key(expected_owner):
        _fail("runtime-service owner identity changed before the destructive boundary")
    _validate_process_receipt_owner(process_receipt, owner)
    _validate_owner_host(owner, backend)
    launch, _, launch_sha = _runtime_launch(control)
    runtime_config, _, config_sha = _runtime_config(control)
    if config_sha != expected_config_sha or config_sha != authorization["config_sha256"]:
        _fail("runtime-service configuration changed before the destructive boundary")
    if launch_sha != expected_launch_sha or launch_sha != authorization["launch_sha256"]:
        _fail("runtime-service launch changed before the destructive boundary")
    if runtime_config.get("store_root") is None:
        _fail("runtime-service configuration has no accepted store root")
    old_env = _env_map(backend)
    old_access = old_env.get("FULLMAG_DOCKER_DEVICE_ACCESS")
    if old_access not in {"cpu", "gpu"}:
        _fail("stopped backend lost its CPU/GPU device-access pin")
    device_release, device_mapping = _device_release_from_config(
        runtime_config, device_access=old_access
    )
    engine_id = _docker_engine_id()
    engine_sha = _sha256(engine_id.encode("utf-8"))
    pins = (
        current_transition["pins"]
        if current_transition is not None
        else [
            _container_pin(backend, "backend", project),
            _container_pin(frontend, "frontend", project),
        ]
    )
    expected_ids = {
        "backend": authorization["backend_container_id"],
        "frontend": authorization["frontend_container_id"],
    }
    if any(pins[index]["container_id"] != expected_ids[service]
           for index, service in enumerate(("backend", "frontend"))):
        _fail("Docker container identities changed before the destructive boundary")
    if any(pin["image_id"] != authorization["old_image_id"] for pin in pins):
        _fail("Docker container images changed before the destructive boundary")
    if backend.get("Id") != expected_backend.get("Id") or frontend.get("Id") != expected_frontend.get("Id"):
        _fail("Docker inspection identities changed before the destructive boundary")
    storage_proof = _ledger_and_store_snapshot(control, pinned_backend, compose=compose)
    for key in ("store_root_sha256", "ledger_root_sha256", "ledger_snapshot_sha256"):
        if storage_proof.get(key) != expected_storage.get(key):
            _fail(f"storage proof {key} changed before the destructive boundary")
    return {
        "backend": backend,
        "frontend": frontend,
        "network_name": network_name,
        "process_receipt": process_receipt,
        "owner": owner,
        "owner_raw": owner_raw,
        "launch": launch,
        "launch_sha": launch_sha,
        "runtime_config": runtime_config,
        "config_sha": config_sha,
        "old_access": old_access,
        "device_release": device_release,
        "device_mapping": device_mapping,
        "engine_id": engine_id,
        "engine_sha": engine_sha,
        "pins": pins,
        "storage_proof": storage_proof,
        "transition": current_transition,
    }


def _manifest(
    authorization: Mapping[str, object],
    engine_sha256: str,
    backend: Mapping[str, object],
    frontend: Mapping[str, object],
    pins: Sequence[Mapping[str, object]],
    device_release: Mapping[str, object],
    device_mapping: object,
) -> dict[str, object]:
    return {
        "schema": "fullmag.docker-container-recovery-manifest.v1",
        "request_id": authorization["request_id"],
        "compose_project": authorization["compose_project"],
        "docker_engine_id_sha256": engine_sha256,
        "source_root": authorization["source_root"],
        "containers": [
            {
                "service": service,
                "pin": dict(pin),
                "inspect": dict(item),
            }
            for service, pin, item in (
                ("backend", pins[0], backend),
                ("frontend", pins[1], frontend),
            )
        ],
        "device_release": {
            "resource_id": device_release["resource_id"],
            "mapping": device_mapping,
            "mapping_sha256": device_release["mapping_sha256"],
        },
        "prior_ready_owner_proof_sha256": authorization["prior_ready_owner_proof_sha256"],
        "stop_journal_sha256": authorization["stop_journal_sha256"],
    }


def _write_record(control: BuildControl, relative: str, value: Mapping[str, object]) -> tuple[str, bytes]:
    raw = _canonical(value)
    if len(raw) > MAX_DOCUMENT_BYTES:
        _fail(f"recovery record {relative} exceeds the document budget")
    control.write_bytes(relative, raw)
    return _sha256(raw), raw


def _runtime_authorization(
    operator: Mapping[str, object],
    *,
    operator_sha256: str,
    request_relative: str,
    request_sha256: str,
    attestation_relative: str,
    attestation_sha256: str,
    manifest_relative: str,
    manifest_sha256: str,
    config_sha256: str,
    owner_sha256: str,
    launch_sha256: str,
) -> dict[str, object]:
    """Create the exact two-environment authorization consumed by PID 1."""

    value = {
        "schema_version": AUTHORIZATION_SCHEMA,
        "request_id": operator["request_id"],
        "source_root": operator["source_root"],
        "compose_project": operator["compose_project"],
        "backend_container_id": operator["backend_container_id"],
        "frontend_container_id": operator["frontend_container_id"],
        "old_image_id": operator["old_image_id"],
        "config_sha256": config_sha256,
        "owner_sha256": owner_sha256,
        "launch_sha256": launch_sha256,
        "operator_authorization_sha256": operator_sha256,
        "native_request_path": f"{CONTROL_ROOT}/{request_relative}",
        "native_request_sha256": request_sha256,
        "attestation_path": f"{CONTROL_ROOT}/{attestation_relative}",
        "attestation_sha256": attestation_sha256,
        "manifest_path": f"{CONTROL_ROOT}/{manifest_relative}",
        "manifest_sha256": manifest_sha256,
        "prior_stop_journal_sha256": operator["prior_stop_journal_sha256"],
    }
    return validate_runtime_authorization(value)


def _prepared_context(toolchain: Mapping[str, object], images: Mapping[str, object]) -> dict[str, object]:
    backend = _require_mapping(images.get("backend"), "prepared backend image")
    return {
        "toolchain": {
            "image_id": _require_image(toolchain.get("image_id"), "prepared toolchain image"),
            "inputs": _require_mapping(toolchain.get("inputs"), "prepared toolchain inputs"),
        },
        "images": {
            "backend": {
                "image_id": _require_image(backend.get("image_id"), "prepared backend image")
            }
        },
    }


def _recover_args(args: argparse.Namespace, selected: Path) -> argparse.Namespace:
    result = copy.copy(args)
    result.source_root = selected
    result.script = None
    result.profile = "dev"
    result.image = None
    result.toolchain_image = None
    result.source_manifest = None
    result.include_untracked = []
    return result


def recover(args: argparse.Namespace) -> None:
    """Run one explicit pre-admission container recovery.

    This function is the only mutating boundary. All proof construction before
    the development operation is read-only; once the operation is acquired,
    the request/manifest are published before the exact old IDs are removed.
    """

    from docker_dev import _compose_identity, _select_source, _resolve_gpu_access, _verify_docker_gpu_access
    from docker_volume_dev import (
        _operator_probe_record_from_retained,
        _validate_recovery_metadata,
        start,
    )
    authorization_reference = getattr(args, "recovery_authorization", None)
    if not isinstance(authorization_reference, str):
        _fail(f"{AUTHORIZATION_ENV} is required")
    authorization_reference = _relative_control_path(authorization_reference.removeprefix(CONTROL_ROOT + "/"))
    repo = Path(args.repo_root).resolve(strict=True)
    selected, layout = _select_source(repo, args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    try:
        helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    except (KeyError, TypeError) as error:
        _fail(f"canonical Docker toolchain helper image is unavailable: {error}")
    control = BuildControl(identity, helper_image)
    control.prepare()
    authorization_raw = _control_bytes(control, authorization_reference)
    if authorization_raw is None:
        _fail("recovery authorization is missing")
    authorization = validate_operator_authorization(
        _parse_json(authorization_raw, "recovery operator authorization")
    )
    expected_auth_sha = getattr(args, "recovery_authorization_sha256", None)
    if expected_auth_sha is not None and _require_sha(expected_auth_sha, "authorization SHA-256") != _sha256(authorization_raw):
        _fail("recovery authorization changed since operator publication")
    expected_config_sha = getattr(args, "config_sha256", None)
    if expected_config_sha is not None and _require_sha(expected_config_sha, "Compose configuration SHA-256") != authorization["compose_config_sha256"]:
        _fail("recovery authorization does not bind the requested Compose configuration")
    attempt = authorization["development_attempt"]
    if getattr(args, "attempt", attempt) != attempt:
        _fail("recovery authorization does not bind the requested development attempt")
    if getattr(args, "source_root", None) is not None and str(args.source_root) != str(authorization["source_root"]):
        _fail("recovery authorization does not bind the requested source root")
    if authorization["compose_project"] != control.project or authorization["source_root"] != str(selected):
        _fail("recovery authorization does not bind the selected Compose group/source")

    terminal, terminal_raw = _control_json(control, f"development/attempts/{attempt}/terminal.json")
    compose, compose_raw = _control_json(control, f"development/attempts/{attempt}/compose.json")
    journal, journal_raw = _control_json(control, authorization["stop_journal_path"])
    if terminal is None or compose is None or journal is None or terminal_raw is None or compose_raw is None or journal_raw is None:
        _fail("retained development, Compose or stop proof is missing")
    if _sha256(_canonical(compose)) != authorization["compose_config_sha256"] or _sha256(journal_raw) != authorization["stop_journal_sha256"]:
        _fail("retained Compose or stop journal bytes differ from authorization")
    _validate_pre_admission_stop_journal(journal, authorization, attempt)
    if terminal.get("phase") != "development" or terminal.get("attempt") != attempt:
        _fail("retained attempt is not the selected development operation")
    if compose.get("name") != control.project:
        _fail("retained Compose document belongs to another project")
    transition = _load_recovery_transition(
        control, authorization, control.project, compose
    )
    if transition is None:
        backend, frontend = _inspect_pair(authorization, control.project, compose)
        network_name = _network_name(backend, "backend")
    else:
        backend, frontend = transition["backend"], transition["frontend"]
        network_name = transition["network_name"]
    process_receipt, process_receipt_raw, process_receipt_sha = _runtime_process_receipt(control)
    if process_receipt_sha != authorization["process_receipt_sha256"]:
        _fail("current shutdown_unknown process receipt differs from operator authorization")
    owner, owner_raw, observed_owner_sha = _runtime_owner(control)
    if observed_owner_sha != authorization["owner_sha256"]:
        _fail("runtime-service owner bytes differ from operator authorization")
    _validate_process_receipt_owner(process_receipt, owner)
    _validate_owner_host(owner, backend)
    launch, launch_raw, launch_sha = _runtime_launch(control)
    runtime_config, runtime_config_raw, config_sha = _runtime_config(control)
    if config_sha != authorization["config_sha256"]:
        _fail("runtime-service configuration bytes differ from operator authorization")
    if launch_sha != authorization["launch_sha256"]:
        _fail("runtime-service launch bytes differ from operator authorization")
    if runtime_config.get("store_root") is None:
        _fail("runtime-service configuration has no accepted store root")
    old_env = _env_map(backend)
    old_access = old_env.get("FULLMAG_DOCKER_DEVICE_ACCESS")
    if old_access not in {"cpu", "gpu"}:
        _fail("stopped backend has no explicit CPU/GPU device-access pin")
    device_release, device_mapping = _device_release_from_config(
        runtime_config, device_access=old_access
    )
    engine_sha = _docker_engine_sha()
    pins = transition["pins"] if transition is not None else [
        _container_pin(backend, "backend", control.project),
        _container_pin(frontend, "frontend", control.project),
    ]
    if (
        pins[0]["container_id"] != authorization["backend_container_id"]
        or pins[1]["container_id"] != authorization["frontend_container_id"]
        or pins[0]["image_id"] != authorization["old_image_id"]
        or pins[1]["image_id"] != authorization["old_image_id"]
    ):
        _fail("Docker container pins changed since authorization")
    storage_proof = _ledger_and_store_snapshot(control, backend, compose=compose)
    manifest = transition["manifest"] if transition is not None else _manifest(
        authorization, engine_sha, backend, frontend, pins, device_release, device_mapping
    )

    # Images are prepared before the development lease is opened. The lease
    # receipt therefore freezes exactly the same standard inputs that the
    # ordinary start path validates on entry.
    from docker_build_control import build_volume_toolchain, build_volume_runtime_images
    toolchain = build_volume_toolchain(selected)
    images_control = BuildControl(identity, toolchain["inputs"]["build_args"]["FULLMAG_CUDA_BASE_IMAGE"])
    images = build_volume_runtime_images(selected, images_control, toolchain)
    backend_image = images["backend"]["image_id"]
    retained_operation = terminal.get("inputs")
    if not isinstance(retained_operation, Mapping):
        _fail("retained development attempt has no operation inputs")
    operator_probe = _operator_probe_record_from_retained(retained_operation, compose)
    policy = retained_operation.get("gpu_access_requested")
    if policy not in {"auto", "required", "disabled"}:
        _fail("retained development operation has no valid requested GPU access policy")
    device_access = _verify_docker_gpu_access(_resolve_gpu_access(policy), policy, backend_image, control.project)
    if device_access != old_access:
        _fail("current Docker GPU availability does not match the retained device-access proof")
    operation_inputs = {
        "source_root": str(selected),
        "image_id": backend_image,
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "source_checkout_kind": identity["checkout_kind"],
        "gpu_access_requested": policy,
        "device_access": device_access,
        "gpu_preflight": "PASS" if device_access == "gpu" else "NOT_REQUIRED",
        **operator_probe,
        "container_recovery": {
            "authorization_sha256": _sha256(authorization_raw),
            "stop_journal_sha256": authorization["stop_journal_sha256"],
            "prior_ready_owner_proof_sha256": authorization["prior_ready_owner_proof_sha256"],
            "old_container_ids": [pin["container_id"] for pin in pins],
            "old_image_id": authorization["old_image_id"],
        },
    }
    with control.operation("development", operation_inputs) as operation:
        fresh = _revalidate_recovery_boundary(
            control,
            authorization,
            attempt,
            control.project,
            compose,
            expected_backend=backend,
            expected_frontend=frontend,
            expected_owner=owner,
            expected_process_receipt_sha=process_receipt_sha,
            expected_config_sha=config_sha,
            expected_launch_sha=launch_sha,
            expected_storage=storage_proof,
            transition=transition,
        )
        backend = fresh["backend"]
        frontend = fresh["frontend"]
        network_name = fresh["network_name"]
        owner = fresh["owner"]
        launch_sha = fresh["launch_sha"]
        runtime_config = fresh["runtime_config"]
        config_sha = fresh["config_sha"]
        if fresh["old_access"] != old_access:
            _fail("CPU/GPU device access changed before the destructive boundary")
        device_release = fresh["device_release"]
        device_mapping = fresh["device_mapping"]
        engine_id = fresh["engine_id"]
        engine_sha = fresh["engine_sha"]
        pins = fresh["pins"]
        storage_proof = fresh["storage_proof"]
        transition = fresh["transition"]
        retained_session = _validate_reused_session_before_removal(
            layout,
            terminal.get("state_root"),
            authorization["old_image_id"],
            engine_id,
        )
        transition_root = f"{RECOVERY_RELATIVE_ROOT}/{authorization['request_id']}"
        if transition is None:
            manifest = _manifest(
                authorization, engine_sha, backend, frontend, pins, device_release, device_mapping
            )
            manifest_sha, _ = _write_record(
                control,
                transition_root + "/manifest.json",
                manifest,
            )
            request = _build_request(
                authorization,
                owner=owner,
                owner_sha256=authorization["owner_sha256"],
                launch_sha256=launch_sha,
                config=runtime_config,
                control=control,
                device_release=device_release,
                config_sha256=config_sha,
                store_root_sha256=storage_proof["store_root_sha256"],
                ledger_root_sha256=storage_proof["ledger_root_sha256"],
                ledger_snapshot_sha256=storage_proof["ledger_snapshot_sha256"],
                docker_engine_id_sha256=engine_sha,
                manifest_sha256=manifest_sha,
                containers=pins,
            )
            request_raw = _canonical(request)
            request_sha = _sha256(request_raw)
            request_relative = transition_root + "/request.json"
            control.write_bytes(request_relative, request_raw)
            prepared_sha, _ = _write_record(
                control,
                transition_root + "/prepared.json",
                {
                    "schema": "fullmag.docker-container-recovery-transition.v1",
                    "state": "prepared-before-removal",
                    "request_id": authorization["request_id"],
                    "old_container_ids": [pin["container_id"] for pin in pins],
                    "old_image_id": authorization["old_image_id"],
                    "request_sha256": request_sha,
                    "manifest_sha256": manifest_sha,
                    "stop_journal_sha256": authorization["stop_journal_sha256"],
                    "process_receipt_sha256": process_receipt_sha,
                    "owner_sha256": authorization["owner_sha256"],
                    "config_sha256": config_sha,
                    "launch_sha256": launch_sha,
                    "network_name": network_name,
                    "storage_proof": dict(storage_proof),
                },
            )
        else:
            # A previous invocation already published the request, manifest
            # and prepared fence.  Reuse their exact bytes: changing either
            # digest would make native recovery accept a different transition.
            manifest = transition["manifest"]
            manifest_sha = transition["manifest_sha"]
            request = transition["request"]
            request_raw = transition["request_raw"]
            request_sha = transition["request_sha"]
            request_relative = transition_root + "/request.json"
            prepared_sha = transition["prepared_sha"]
        # The operation holds the lifecycle lock while the final old-container
        # observation, removal and replacement happen. No old ID is removed
        # before request, manifest and the prepared transition are durable in
        # the control volume.
        operation["receipt"].update(
            state="recovering-stopped-container-namespace",
            recovery_request_sha256=request_sha,
            recovery_manifest_sha256=manifest_sha,
            recovery_prepared_sha256=prepared_sha,
            old_container_ids=[pin["container_id"] for pin in pins],
        )
        if transition is not None and transition["absence"] is not None:
            # The previous invocation completed the destructive boundary and
            # published the absence proof.  Do not repeat docker rm or mutate
            # its immutable evidence on a same-authorization retry.
            absence_sha = transition["absence_sha"]
            network_state = transition["network_state"]
        else:
            remaining = (
                list(transition["present"].values())
                if transition is not None
                else [backend, frontend]
            )
            if remaining:
                docker_capture("rm", *[item["Id"] for item in remaining], timeout=120)
            for pin in pins:
                _assert_container_absent(pin["container_id"])
            network_state = _verify_network_after_removal(
                network_name,
                [pin["container_id"] for pin in pins],
                control.project,
            )
            absence_sha, _ = _write_record(
                control,
                transition_root + "/absence.json",
                {
                    "schema": "fullmag.docker-container-recovery-transition.v1",
                    "state": "old-containers-absent",
                    "request_id": authorization["request_id"],
                    "old_container_ids": [pin["container_id"] for pin in pins],
                    "request_sha256": request_sha,
                    "manifest_sha256": manifest_sha,
                    "prepared_sha256": prepared_sha,
                    "network_name": network_name,
                    "network_state": network_state,
                },
            )
        operation["receipt"]["recovery_absence_sha256"] = absence_sha
        # The after observation is the authenticated Docker exit inspected
        # under the lease (or preserved in the immutable prepared manifest).
        # A private namespace ends at that exit. Removing its container is a
        # separate restart fence, proven above by exact-ID absence; it must not
        # fabricate a new exit time or claim that a foreign GPU user stopped.
        attestation_observations = []
        for pin, container in zip(pins, (backend, frontend), strict=True):
            attestation_observations.append({
                "container_id": pin["container_id"],
                "image_id": pin["image_id"],
                "config_sha256": pin["config_sha256"],
                "before": _container_observation(container, pin, after=False),
                "after": _container_observation(container, pin, after=True),
            })
        attestation = _build_attestation(request, request_sha, engine_sha, attestation_observations, manifest_sha, device_release)
        attestation_sha, _ = _write_record(
            control,
            f"{RECOVERY_RELATIVE_ROOT}/{authorization['request_id']}/attestation.json",
            attestation,
        )
        attestation_relative = f"{RECOVERY_RELATIVE_ROOT}/{authorization['request_id']}/attestation.json"
        runtime_authorization = _runtime_authorization(
            authorization,
            operator_sha256=_sha256(authorization_raw),
            request_relative=request_relative,
            request_sha256=request_sha,
            attestation_relative=attestation_relative,
            attestation_sha256=attestation_sha,
            manifest_relative=f"{RECOVERY_RELATIVE_ROOT}/{authorization['request_id']}/manifest.json",
            manifest_sha256=manifest_sha,
            config_sha256=config_sha,
            owner_sha256=authorization["owner_sha256"],
            launch_sha256=launch_sha,
        )
        runtime_authorization_relative = (
            f"{RECOVERY_RELATIVE_ROOT}/{authorization['request_id']}/authorization.json"
        )
        runtime_authorization_sha, _ = _write_record(
            control, runtime_authorization_relative, runtime_authorization
        )
        # PID 1 receives only these two allowlisted variables.  Request and
        # teardown paths are authenticated through the runtime document.
        recovery_environment = {
            AUTHORIZATION_ENV: f"{CONTROL_ROOT}/{runtime_authorization_relative}",
            AUTHORIZATION_SHA_ENV: runtime_authorization_sha,
        }
        recovery_metadata = _validate_recovery_metadata({
            "schema": "fullmag.container-recovery.v1",
            "request_id": authorization["request_id"],
            "request_sha256": request_sha,
            "attestation_sha256": attestation_sha,
            "manifest_sha256": manifest_sha,
            "authorization_sha256": runtime_authorization_sha,
            "stop_journal_sha256": authorization["stop_journal_sha256"],
            "removed_container_ids": [pin["container_id"] for pin in pins],
        })
        reuse_state = {
            "state": retained_session["state"],
            "host_certificate": retained_session["host_certificate"],
            "owner_marker": retained_session["owner_marker"],
            # The reused host certificate is authenticated against the old
            # runtime image.  start() rotates it to the freshly prepared image
            # only after the new Compose services are admitted.
            "receipt": {"image_id": authorization["old_image_id"]},
            "operator_probe_environment_record": operator_probe,
        }
        start_args = _recover_args(args, selected)
        start_args.gpu_access = policy
        prepared = _prepared_context(toolchain, images)
        start(
            start_args,
            reuse_state=reuse_state,
            control=control,
            operation=operation,
            prepared=prepared,
            recovery_environment=recovery_environment,
            recovery_metadata=recovery_metadata,
        )


__all__ = [
    "AUTHORIZATION_SCHEMA",
    "ATTESTATION_SCHEMA",
    "OPERATOR_AUTHORIZATION_SCHEMA",
    "REQUEST_SCHEMA",
    "ContainerRecoveryError",
    "validate_authorization",
    "validate_operator_authorization",
    "validate_runtime_authorization",
    "validate_request",
    "validate_attestation",
    "recover",
]
