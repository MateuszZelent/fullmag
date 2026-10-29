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
from pathlib import Path, PurePosixPath, PureWindowsPath
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
ABRUPT_OPERATOR_SCHEMA = "fullmag.docker-container-recovery-operator-authorization.v2"
ABRUPT_PROOF_SCHEMA = "fullmag.docker-abrupt-stop-proof.v1"
_DESKTOP_HOST_PREFIXES = (
    "/run/desktop/mnt/host/", "/host_mnt/", "/mnt/host/",
)
ABRUPT_PROOF_HELD_MANUAL_SCHEMA = "fullmag.docker-abrupt-stop-proof.v2"
TERMINAL_REQUEST_SCHEMA = "runtime_service_container_recovery_request.v3"
HELD_MANUAL_REQUEST_SCHEMA = "runtime_service_container_recovery_request.v4"
ATTEMPT_HISTORY_REQUEST_SCHEMA = "runtime_service_container_recovery_request.v5"
ABRUPT_PROOF_ATTEMPT_HISTORY_SCHEMA = "fullmag.docker-abrupt-stop-proof.v3"
AUTHORIZATION_SCHEMA = "fullmag.docker-container-recovery-authorization.v1"
REQUEST_SCHEMA = "runtime_service_container_recovery_request.v1"
RETAINED_REQUEST_SCHEMA = "runtime_service_container_recovery_request.v2"
ATTESTATION_SCHEMA = "docker_namespace_teardown_attestation.v1"
ABSENCE_ATTESTATION_SCHEMA = "docker_namespace_absence_attestation.v1"
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


def _stable_container_observation(value):
    """Docker Mounts is an unordered inventory; preserve every mount field."""
    if not isinstance(value, Mapping) or not isinstance(value.get("Mounts"), list):
        _fail("Docker observation has no complete mount inventory")
    mounts = value["Mounts"]
    destinations = []
    for mount in mounts:
        if not isinstance(mount, Mapping):
            _fail("Docker observation mount is malformed")
        destination = mount.get("Destination")
        if not isinstance(destination, str) or not destination:
            _fail("Docker observation mount destination is missing")
        destinations.append(destination)
    if len(set(destinations)) != len(destinations):
        _fail("Docker observation has duplicate mount destinations")
    return {**value, "Mounts": sorted(mounts, key=lambda item: item["Destination"])}


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
    abrupt = authorization.get("schema_version") == ABRUPT_OPERATOR_SCHEMA
    if abrupt:
        required = (required - {"prior_stop_journal", "prior_stop_journal_sha256"}) | {
            "abrupt_stop_proof", "abrupt_stop_proof_sha256"}
    if set(authorization) != required:
        _fail("operator authorization fields do not match the frozen schema")
    if authorization.get("schema_version") not in {OPERATOR_AUTHORIZATION_SCHEMA, ABRUPT_OPERATOR_SCHEMA}:
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
        "compose_config_sha256", "process_receipt_sha256",
        "config_sha256", "owner_sha256", "launch_sha256",
    ):
        _require_sha(authorization.get(key), f"operator authorization {key}")
    for key in ("backend_container_id", "frontend_container_id"):
        _require_container(authorization.get(key), f"operator authorization {key}")
    _require_image(authorization.get("old_image_id"), "operator authorization old_image_id")
    proof_key = "abrupt_stop_proof" if abrupt else "prior_stop_journal"
    proof_path = _relative_control_path(authorization.get(proof_key))
    proof_sha = _require_sha(authorization.get(proof_key + "_sha256"), "operator proof SHA-256")
    if authorization["backend_container_id"] == authorization["frontend_container_id"]:
        _fail("operator authorization repeats the backend/frontend container")
    return {
        **authorization,
        "request_id": request_id,
        "development_attempt": attempt,
        "attempt": attempt,
        "source_root": source_root,
        "compose_project": project,
        "stop_journal_path": proof_path,
        "stop_journal_sha256": proof_sha,
        # The evidence digest is either the v1 journal or the v2 original
        # abrupt-stop archive. The native transport retains its historical
        # field names; v2 never manufactures a stop journal or process state.
        "prior_ready_owner_proof_sha256": proof_sha,
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
    if type(owner.get("pid")) is not int or owner["pid"] <= 0:
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


def _validate_attempt_histories(histories, terminal_pins):
    if not isinstance(histories, list) or not 1 <= len(histories) <= 128:
        _fail("v5 requires a nonempty bounded retained-attempt history list")
    terminal_ids = {pin["run_id"] for pin in terminal_pins}
    runs = set()
    total = 0
    for history in histories:
        if not isinstance(history, Mapping) or set(history) != {"run_id", "run_evidence_sha256", "attempts"}:
            _fail("invalid retained-attempt history pin")
        run_id = history.get("run_id")
        if run_id not in terminal_ids or run_id in runs:
            _fail("history run must be a unique retained terminal run")
        runs.add(run_id)
        _require_sha(history.get("run_evidence_sha256"), "run_evidence_sha256")
        attempts = history.get("attempts")
        if not isinstance(attempts, list) or not attempts:
            _fail("retained-attempt history requires nonempty attempts")
        claims = set()
        epochs = set()
        for claim in attempts:
            total += 1
            if total > 128 or not isinstance(claim, Mapping) or set(claim) != {
                "task_id", "attempt_id", "ownership_epoch", "resource_id"}:
                _fail("historical claim inventory is invalid or exceeds 128")
            for key in ("task_id", "attempt_id", "resource_id"):
                value = _require_text(claim.get(key), "historical " + key, 255 if key == "resource_id" else 128)
                if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", value) or value.endswith("."):
                    _fail("historical claim has an unsafe identity")
            epoch = claim.get("ownership_epoch")
            if type(epoch) is not int or epoch <= 0:
                _fail("historical claim ownership epoch must be positive")
            identity = (claim["task_id"], claim["attempt_id"])
            epoch_identity = (claim["task_id"], epoch)
            if identity in claims or epoch_identity in epochs:
                _fail("duplicate historical attempt or task epoch")
            claims.add(identity)
            epochs.add(epoch_identity)
    return histories


def expected_recovery_outcome(request: Mapping[str, object]) -> str:
    """Bind receipt semantics to the explicit request version, never its outcome alone."""
    if request.get("schema_version") == ATTEMPT_HISTORY_REQUEST_SCHEMA:
        paired = {key: value for key, value in request.items() if key != "retained_attempt_histories"}
        paired["schema_version"] = HELD_MANUAL_REQUEST_SCHEMA
        expected_recovery_outcome(paired)
        _validate_attempt_histories(request.get("retained_attempt_histories"), request["retained_terminal_runs"])
        return "retained_attempt_history_recovered"
    if "retained_attempt_histories" in request:
        _fail("retained-attempt history pins require v5 recovery")
    if request.get("schema_version") == HELD_MANUAL_REQUEST_SCHEMA:
        if "retained_cancelled_runs" in request:
            _fail("v4 recovery cannot carry cancelled-run pins")
        terminal_pins = request.get("retained_terminal_runs")
        held_pins = request.get("retained_held_manual_runs")
        if not isinstance(terminal_pins, list) or not 0 <= len(terminal_pins) <= 128:
            _fail("v4 recovery requires 0..128 retained terminal run pins")
        if not isinstance(held_pins, list) or not 1 <= len(held_pins) <= 128:
            _fail("v4 recovery requires 1..128 retained held-manual run pins")
        if len(terminal_pins) + len(held_pins) > 128:
            _fail("v4 recovery retained run pins exceed the combined limit")
        seen = set()
        for pin in terminal_pins:
            if not isinstance(pin, Mapping) or set(pin) != {
                "run_id", "run_intent_sha256", "run_catalog_sha256", "artifact_catalog_sha256"}:
                _fail("invalid v4 retained terminal run pin")
            run_id = _require_text(pin.get("run_id"), "retained terminal run id", 128)
            if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", run_id) or run_id.endswith("."):
                _fail("unsafe retained terminal run id")
            if run_id in seen:
                _fail("duplicate v4 retained run pin")
            seen.add(run_id)
            for key in ("run_intent_sha256", "run_catalog_sha256"):
                _require_sha(pin.get(key), key)
            if pin["artifact_catalog_sha256"] is not None:
                _require_sha(pin["artifact_catalog_sha256"], "artifact_catalog_sha256")
        for pin in held_pins:
            if not isinstance(pin, Mapping) or set(pin) != {
                "run_id", "run_intent_sha256", "run_catalog_sha256", "start_release"}:
                _fail("invalid retained held-manual run pin")
            run_id = _require_text(pin.get("run_id"), "retained held-manual run id", 128)
            if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", run_id) or run_id.endswith("."):
                _fail("unsafe retained held-manual run id")
            if run_id in seen:
                _fail("duplicate v4 retained run pin")
            seen.add(run_id)
            for key in ("run_intent_sha256", "run_catalog_sha256"):
                _require_sha(pin.get(key), key)
            if pin.get("start_release") != "absent":
                _fail("held-manual run must pin start_release as absent")
        return "retained_manual_held_runs_recovered"
    if "retained_held_manual_runs" in request and request.get("schema_version") != HELD_MANUAL_REQUEST_SCHEMA:
        _fail("held-manual run pins require v4 recovery")
    if request.get("schema_version") == TERMINAL_REQUEST_SCHEMA:
        if request.get("retained_cancelled_runs") is not None:
            _fail("v3 recovery cannot carry cancelled-only pins")
        pins = request.get("retained_terminal_runs")
        if not isinstance(pins, list) or not 1 <= len(pins) <= 128:
            _fail("v3 recovery requires 1..128 retained terminal run pins")
        seen = set()
        for pin in pins:
            if not isinstance(pin, Mapping) or set(pin) != {
                "run_id", "run_intent_sha256", "run_catalog_sha256", "artifact_catalog_sha256"}:
                _fail("invalid retained terminal run pin")
            run_id = _require_text(pin.get("run_id"), "retained terminal run id", 128)
            if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", run_id) or run_id.endswith("."):
                _fail("unsafe retained terminal run id")
            if run_id in seen:
                _fail("duplicate retained terminal run pin")
            seen.add(run_id)
            for key in ("run_intent_sha256", "run_catalog_sha256"):
                _require_sha(pin.get(key), key)
            if pin["artifact_catalog_sha256"] is not None:
                _require_sha(pin["artifact_catalog_sha256"], "artifact_catalog_sha256")
        return "retained_terminal_runs_recovered"
    if request.get("retained_terminal_runs") is not None:
        _fail("terminal run pins require v3 recovery")
    if "retained_held_manual_runs" in request:
        _fail("held-manual run pins require v4 recovery")
    if request.get("schema_version") == REQUEST_SCHEMA:
        if request.get("retained_cancelled_runs") is not None:
            _fail("v1 recovery cannot retain cancelled runs")
        return "empty_namespace_recovered"
    if request.get("schema_version") != RETAINED_REQUEST_SCHEMA:
        _fail("unsupported runtime service container recovery request schema")
    pins = request.get("retained_cancelled_runs")
    if not isinstance(pins, list) or not 1 <= len(pins) <= 128:
        _fail("v2 recovery requires 1..128 retained cancelled run pins")
    seen = set()
    for pin in pins:
        if not isinstance(pin, Mapping) or set(pin) != {
            "run_id", "run_intent_sha256", "run_catalog_sha256"
        }:
            _fail("invalid retained cancelled run pin")
        run_id = _require_text(pin.get("run_id"), "retained run id", 128)
        if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", run_id) or run_id.endswith("."):
            _fail("unsafe retained run id")
        if run_id in seen:
            _fail("duplicate retained cancelled run pin")
        seen.add(run_id)
        _require_sha(pin.get("run_intent_sha256"), "retained run intent digest")
        _require_sha(pin.get("run_catalog_sha256"), "retained run catalog digest")
    return "retained_cancelled_runs_recovered"


def validate_request(value: Mapping[str, object]) -> dict[str, object]:
    """Validate the JSON shape accepted by native ``service-recover-container``."""

    request = _require_mapping(value, "runtime service container recovery request")
    expected_recovery_outcome(request)
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
    """Validate an exited proof or recovery-only exact-ID absence proof."""

    request = validate_request(request)
    _require_sha(request_sha256, "request file SHA-256")
    attestation = _require_mapping(value, "Docker namespace teardown attestation")
    if attestation.get("schema_version") == ABSENCE_ATTESTATION_SCHEMA:
        if (
            not (
                request.get("schema_version") == RETAINED_REQUEST_SCHEMA
                and isinstance(request.get("retained_cancelled_runs"), list)
            )
            and not (
                request.get("schema_version") == TERMINAL_REQUEST_SCHEMA
                and isinstance(request.get("retained_terminal_runs"), list)
            )
            and not (
                request.get("schema_version") in {HELD_MANUAL_REQUEST_SCHEMA, ATTEMPT_HISTORY_REQUEST_SCHEMA}
                and isinstance(request.get("retained_terminal_runs"), list)
                and isinstance(request.get("retained_held_manual_runs"), list)
            )
        ):
            _fail("Docker namespace absence proof requires a retained-run v2/v3/v4/v5 request")
        if set(attestation) != {
            "schema_version", "request_sha256", "docker_engine_id_sha256",
            "containers", "device_release", "manifest_sha256", "result",
        }:
            _fail("Docker namespace absence attestation has unexpected fields")
        if attestation.get("request_sha256") != request_sha256:
            _fail("namespace absence attestation request digest differs from raw request bytes")
        for key in ("docker_engine_id_sha256", "manifest_sha256"):
            _require_sha(attestation.get(key), f"namespace absence {key}")
        if attestation["docker_engine_id_sha256"] != request["docker_engine_id_sha256"]:
            _fail("namespace absence attestation engine differs from request")
        if attestation["manifest_sha256"] != request["docker_manifest_sha256"]:
            _fail("namespace absence attestation manifest differs from request")
        if attestation.get("result") != "authoritative_namespace_absence":
            _fail("namespace absence result is not authoritative")
        pins = {item["container_id"]: item for item in request["containers"]}
        observations = attestation.get("containers")
        if not isinstance(observations, list) or len(observations) != len(pins):
            _fail("namespace absence observation count differs from request")
        observed_ids = set()
        for raw in observations:
            item = _require_mapping(raw, "namespace absence container observation")
            if set(item) != {"container_id", "image_id", "config_sha256", "service", "absence"}:
                _fail("namespace absence container observation has unexpected fields")
            identifier = _require_container(item.get("container_id"), "absence container_id")
            if identifier in observed_ids or identifier not in pins:
                _fail("namespace absence repeats or introduces a container ID")
            observed_ids.add(identifier)
            pin = pins[identifier]
            if any(item.get(field) != pin.get(field) for field in ("image_id", "config_sha256", "service")):
                _fail("namespace absence container identity differs from request")
            absence = _require_mapping(item.get("absence"), "namespace absence evidence")
            if set(absence) != {"inspect", "ps_all"}:
                _fail("namespace absence evidence has unexpected fields")
            inspect = _require_mapping(absence.get("inspect"), "namespace inspect absence")
            if set(inspect) != {"outcome", "matched_container_id", "output_sha256"}:
                _fail("namespace inspect absence has unexpected fields")
            if inspect.get("outcome") != "no_such_object" or inspect.get("matched_container_id") != identifier:
                _fail("namespace inspect absence does not target the exact pinned ID")
            _require_sha(inspect.get("output_sha256"), "namespace inspect output SHA-256")
            ps_all = _require_mapping(absence.get("ps_all"), "namespace docker ps -a absence")
            if set(ps_all) != {"outcome", "output_sha256"} or ps_all.get("outcome") != "empty":
                _fail("namespace docker ps -a is not an empty listing")
            _require_sha(ps_all.get("output_sha256"), "namespace docker ps -a output SHA-256")
        if observed_ids != set(pins):
            _fail("namespace absence does not cover every pinned container")
        device = _require_mapping(attestation.get("device_release"), "absence device release")
        expected_device_fields = {"resource_id", "mapping_sha256", "mapping_detached"}
        if request.get("device_release_gpu_uuid") is not None:
            expected_device_fields.add("gpu_uuid")
        if set(device) != expected_device_fields:
            _fail("namespace absence device release has unexpected fields")
        if (
            device.get("resource_id") != request["device_release_resource_id"]
            or device.get("gpu_uuid") != request.get("device_release_gpu_uuid")
            or device.get("mapping_sha256") != request["device_release_mapping_sha256"]
            or device.get("mapping_detached") is not True
        ):
            _fail("namespace absence device release differs from request")
        return {**attestation, "containers": list(observations), "device_release": device}

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


def _runtime_process_receipt(control: BuildControl, *, abrupt: bool = False) -> tuple[dict[str, object], bytes, str]:
    receipt, raw = _control_json(
        control, f"{RUNTIME_CONTROL_RELATIVE}/runtime-service/process-tree.json"
    )
    if receipt is None or raw is None:
        _fail("runtime-service process receipt is missing from the control volume")
    if receipt.get("schema") != "fullmag.docker-process-tree.v1":
        _fail("runtime-service process receipt schema differs from the image-owned schema")
    if receipt.get("state") not in ({"ready", "shutdown_unknown"} if abrupt else {"shutdown_unknown"}):
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
    retained_cancelled_runs: Sequence[Mapping[str, object]] | None = None,
    retained_terminal_runs: Sequence[Mapping[str, object]] | None = None,
    retained_held_manual_runs: Sequence[Mapping[str, object]] | None = None,
    retained_attempt_histories: Sequence[Mapping[str, object]] | None = None,
) -> dict[str, object]:
    device = _require_mapping(device_release, "device release")
    _require_text(device.get("resource_id"), "device release resource_id", 255)
    _require_sha(device.get("mapping_sha256"), "device release mapping_sha256")
    if device.get("mapping_detached") is not True:
        _fail("device release mapping is not detached")
    if retained_held_manual_runs is not None and retained_terminal_runs is None:
        _fail("v4 held-manual runs require the paired terminal run list")
    if retained_held_manual_runs is not None and retained_cancelled_runs is not None:
        _fail("v4 recovery cannot mix held-manual and cancelled run pins")
    request = {
        "schema_version": ATTEMPT_HISTORY_REQUEST_SCHEMA if retained_attempt_histories is not None else (HELD_MANUAL_REQUEST_SCHEMA if retained_held_manual_runs is not None else (TERMINAL_REQUEST_SCHEMA if retained_terminal_runs is not None else (RETAINED_REQUEST_SCHEMA if retained_cancelled_runs is not None else REQUEST_SCHEMA))),
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
        **({"retained_attempt_histories": [dict(item) for item in retained_attempt_histories]}
           if retained_attempt_histories is not None else {}),
        **({"retained_terminal_runs": [dict(item) for item in retained_terminal_runs]}
           if retained_terminal_runs is not None else {}),
        **({"retained_held_manual_runs": [dict(item) for item in retained_held_manual_runs]}
           if retained_held_manual_runs is not None else {}),
        **(
            {"retained_cancelled_runs": [dict(item) for item in retained_cancelled_runs]}
            if retained_cancelled_runs is not None
            else {}
        ),
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
    import docker_group_ledger as group_ledger
    if retained is None and group_ledger.is_group_ledger_mount(mounted):
        # A DEV group ledger is the group's own named volume (ADR 0067).
        if not isinstance(compose, Mapping) or compose.get("name") != control.project:
            _fail("group ledger requires its retained Compose document")
        expected = compose.get("volumes", {}).get(group_ledger.COMPOSE_VOLUME)
        if (not isinstance(expected, Mapping) or expected.get("external") is not True
                or expected.get("name") != mounted.get("Name")
                or not group_ledger.is_group_ledger_backend(service.get("environment", {}))
                or mounted.get("Driver") != "local" or mounted.get("RW") is not True):
            _fail("group ledger mount differs from its retained Compose volume")
        return f"type=volume,src={mounted['Name']},dst=/host-ledger,readonly,volume-nocopy", None
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
    control: BuildControl,
    backend: Mapping[str, object],
    *,
    compose=None,
    retained_cancelled_runs: Sequence[Mapping[str, object]] | None = None,
    retained_terminal_runs: Sequence[Mapping[str, object]] | None = None,
    retained_held_manual_runs: Sequence[Mapping[str, object]] | None = None,
    retained_attempt_histories: Sequence[Mapping[str, object]] | None = None,
) -> dict[str, object]:
    """Read the exact accepted store and shared ledger through an isolated helper."""

    if retained_held_manual_runs is not None and (
        retained_terminal_runs is None or retained_cancelled_runs is not None
    ):
        _fail("v4 held-manual pins require terminal pins and cannot mix cancelled pins")
    if retained_terminal_runs is not None and retained_cancelled_runs is not None:
        _fail("cannot mix terminal and cancelled-only retained run pins")
    v5_mode = retained_attempt_histories is not None
    if v5_mode and retained_held_manual_runs is None:
        _fail("v5 history requires both retained terminal and held-manual arrays")
    v4_mode = retained_held_manual_runs is not None
    terminal_mode = retained_terminal_runs is not None
    retained_pins = [dict(pin) for pin in retained_terminal_runs] if terminal_mode else None
    held_pins = [dict(pin) for pin in retained_held_manual_runs] if v4_mode else None
    if v4_mode:
        expected_recovery_outcome({
            "schema_version": ATTEMPT_HISTORY_REQUEST_SCHEMA if v5_mode else HELD_MANUAL_REQUEST_SCHEMA,
            **({"retained_attempt_histories": list(retained_attempt_histories)} if v5_mode else {}),
            "retained_terminal_runs": retained_pins,
            "retained_held_manual_runs": held_pins,
        })
        retained_pins = retained_pins + held_pins
    elif terminal_mode:
        expected_recovery_outcome({"schema_version": TERMINAL_REQUEST_SCHEMA,
                                   "retained_terminal_runs": retained_pins})
    if retained_cancelled_runs is not None:
        retained_pins = [dict(pin) for pin in retained_cancelled_runs]
        expected_recovery_outcome({
            "schema_version": RETAINED_REQUEST_SCHEMA,
            "retained_cancelled_runs": retained_pins,
        })
    state_source = _bind_source(backend, "/state")
    if compose is not None and state_source.startswith("/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/"):
        # The service validator must have bound this alias to the retained
        # canonical Compose mount. Never create an alias or guess a fallback.
        mounts = compose.get("services", {}).get("backend", {}).get("volumes", [])
        candidates = [m for m in mounts if isinstance(m, Mapping) and m.get("target") == "/state"]
        if len(candidates) != 1 or candidates[0].get("type") != "bind":
            _fail("retained Compose has no unique canonical state bind")
        pinned_alias = compose.get("services", {}).get("backend", {}).get("x-fullmag-daemon-binds", {}).get("/state")
        if pinned_alias != state_source:
            _fail("canonical state mount is not bound to the retained daemon alias")
        state_source = _require_text(candidates[0].get("source"), "canonical Compose state source")
        if not state_source.startswith("/") or ".." in PurePosixPath(state_source).parts:
            _fail("canonical state mount is not an absolute host path")
    ledger_mount, ledger_descriptor = _ledger_snapshot_mount(control, backend, compose)
    script = r'''import fcntl, hashlib, json, os, pathlib, stat, time
MAX_ENTRIES=8192
MAX_STORE_FILES=32768
MAX_STORE_DIRECTORIES=4096
MAX_STORE_RUNS=128
STORE_WALK_SECONDS=30
MAX_CAS_OBJECT_BYTES=128*1024*1024
CAS_READ_CHUNK_BYTES=1024*1024

def cas_identity(metadata):
    return (metadata.st_dev,metadata.st_ino,stat.S_IFMT(metadata.st_mode),metadata.st_size,metadata.st_mtime_ns,metadata.st_ctime_ns)

def hash_cas_object(path, expected, remaining_budget):
    path=os.fspath(path)
    maximum=min(MAX_CAS_OBJECT_BYTES,remaining_budget)
    flags=os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_CLOEXEC',0)
    fd=os.open(path,flags)
    try:
        before=os.fstat(fd)
        named_before=os.lstat(path)
        identity=cas_identity(before)
        if (not stat.S_ISREG(before.st_mode) or not stat.S_ISREG(named_before.st_mode)
                or identity!=cas_identity(named_before) or before.st_size<0 or before.st_size>maximum):
            raise RuntimeError('retained input CAS object exceeds its size/aggregate bound or changed before read')
        digest=hashlib.sha256()
        count=0
        while True:
            chunk=os.read(fd,CAS_READ_CHUNK_BYTES)
            if not chunk: break
            count+=len(chunk)
            if count>maximum or count>before.st_size:
                raise RuntimeError('retained input CAS object exceeds its size/aggregate bound or changed while reading')
            digest.update(chunk)
        after=os.fstat(fd)
        named_after=os.lstat(path)
        if (identity!=cas_identity(after) or identity!=cas_identity(named_after)
                or count!=before.st_size):
            raise RuntimeError('retained input CAS object metadata changed while reading')
        if digest.hexdigest()!=expected:
            raise RuntimeError('retained input CAS object bytes differ')
        return count
    finally:
        os.close(fd)
def regular(path, label, maximum=8*1024*1024):
    path=pathlib.Path(path)
    if not path.is_absolute() or '..' in path.parts or path.is_symlink() or not path.is_file(): raise RuntimeError(label+' is not a regular file')
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_CLOEXEC',0))
    try:
        before=os.fstat(fd); identity=cas_identity(before)
        if not stat.S_ISREG(before.st_mode) or before.st_size>maximum or identity!=cas_identity(os.lstat(path)):
            raise RuntimeError(label+' exceeds its size bound or changed before read')
        with os.fdopen(fd,'rb',closefd=False) as reader:
            data=reader.read(maximum+1)
        if (len(data)>maximum or len(data)!=before.st_size
                or identity!=cas_identity(os.fstat(fd)) or identity!=cas_identity(os.lstat(path))):
            raise RuntimeError(label+' exceeds its size bound or changed while reading')
        return data
    finally: os.close(fd)
def canonical(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()

def terminal_prepared_refs(run_root,run_id,tasks,read_budget):
    root=run_root/'task_prepared_observations'
    if not os.path.lexists(root): return set()
    if root.is_symlink() or not root.is_dir(): raise RuntimeError('terminal prepared observation namespace is invalid')
    def sha(value):
        return isinstance(value,str) and len(value)==64 and all(c in '0123456789abcdef' for c in value)
    def unique(pairs):
        value={}
        for key,item in pairs:
            if key in value: raise RuntimeError('terminal preparation record contains a duplicate JSON key')
            value[key]=item
        return value
    def prepared_raw(path):
        raw=regular(path,'terminal preparation record',min(16*1024*1024,read_budget[0]))
        read_budget[0]-=len(raw)
        return raw
    def record(path):
        raw=prepared_raw(path)
        value=json.loads(raw,object_pairs_hook=unique)
        if not isinstance(value,dict): raise RuntimeError('terminal preparation record is not an object')
        return raw,value
    refs=set(); evidence={}
    observation_fields={'schema_version','run_id','task_id','step_id','preparation_id','plan_fingerprint','magnetization_values_sha256','evaluation_lane','requested_lane','outcome','created_at'}
    receipt_fields={'schema_version','run_id','task_id','step_id','input_fingerprint','preparation_id','plan_fingerprint','payload_sha256','payload','created_at'}
    for path in root.iterdir():
        raw,item=record(path)
        task_id=path.name.removesuffix('.json')
        step=item.get('step_id'); fingerprint=item.get('plan_fingerprint')
        if (set(item)!=observation_fields or item.get('schema_version')!='task_prepared_observation.v1'
                or path.name!=task_id+'.json' or task_id not in tasks
                or item.get('run_id')!=run_id or item.get('task_id')!=task_id
                or not isinstance(step,str) or not step.strip() or len(step.encode())>256
                or any(ord(c)<32 or 127<=ord(c)<=159 or c in '/\\' for c in step)
                or task_id!='task-'+hashlib.sha256((run_id+'\0'+step).encode()).hexdigest()
                or item.get('preparation_id')!='prep-'+task_id
                or not isinstance(fingerprint,str) or not fingerprint.startswith('sha256:') or not sha(fingerprint[7:])
                or not sha(item.get('magnetization_values_sha256'))
                or any(item.get(key) not in {'fdm_cpu','fdm_gpu','fem_cpu','fem_gpu'} for key in ('evaluation_lane','requested_lane'))
                or not isinstance(item.get('created_at'),str) or not item['created_at']):
            raise RuntimeError('terminal prepared observation identity/shape is invalid')
        receipt_path=run_root/'task_preparation_receipts'/(task_id+'.json')
        receipt_raw,receipt=record(receipt_path)
        payload=receipt.get('payload')
        if (set(receipt)!=receipt_fields or receipt.get('schema_version')!='task_preparation_receipt.v1'
                or any(receipt.get(key)!=item[key] for key in ('run_id','task_id','step_id','preparation_id','plan_fingerprint'))
                or not sha(receipt.get('input_fingerprint'))
                or receipt['input_fingerprint']!=tasks[task_id].get('input_fingerprint')
                or not sha(receipt.get('payload_sha256')) or not isinstance(payload,dict)
                or payload.get('schema_version') not in {'preparation_receipt.v1','closed_loop_preparation_receipt.v1'}
                or any(payload.get(key)!=item[key] for key in ('preparation_id','plan_fingerprint'))
                or not isinstance(receipt.get('created_at'),str) or not receipt['created_at']):
            raise RuntimeError('terminal prepared observation differs from its task preparation receipt')
        # Native typed admission additionally validates canonical payload/RunSpec
        # digests. Python must not substitute its float JSON encoding for Rust's.
        outcome=item.get('outcome')
        if not isinstance(outcome,dict): raise RuntimeError('terminal prepared observation outcome is invalid')
        if outcome.get('state')=='published':
            object_refs=outcome.get('object_refs'); bundle=outcome.get('bundle_object_ref')
            if (set(outcome)!={'state','bundle_object_ref','object_refs'} or not isinstance(object_refs,list)
                    or not 1<=len(object_refs)<=4096 or any(not sha(ref) for ref in object_refs)
                    or len(set(object_refs))!=len(object_refs) or not sha(bundle) or bundle not in object_refs):
                raise RuntimeError('terminal prepared observation CAS references are invalid')
            refs.update(object_refs)
        elif outcome.get('state')=='unavailable':
            reason=outcome.get('reason')
            if set(outcome)!={'state','reason'} or not isinstance(reason,str) or not reason.strip() or len(reason.encode())>2048:
                raise RuntimeError('terminal prepared observation unavailable reason is invalid')
        else: raise RuntimeError('terminal prepared observation outcome is unsupported')
        evidence[path]=hashlib.sha256(raw).hexdigest()
        evidence[receipt_path]=hashlib.sha256(receipt_raw).hexdigest()
    for path,digest in evidence.items():
        if hashlib.sha256(prepared_raw(path)).hexdigest()!=digest:
            raise RuntimeError('terminal preparation observation/receipt changed before final CAS')
    return refs
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
v5=observation.get('v5_mode') is True
history_pins=observation.get('retained_attempt_histories')
if v5:
    if observation.get('v4_mode') is not True or not isinstance(history_pins,list) or not 1<=len(history_pins)<=128:
        raise RuntimeError('v5 retained attempt history mode/pins are invalid')
else:
    if history_pins is not None: raise RuntimeError('attempt histories require explicit v5 mode')
history_by_run={}
historical_count=0
for history in history_pins or []:
    if not isinstance(history,dict) or set(history)!={'run_id','run_evidence_sha256','attempts'}:
        raise RuntimeError('v5 historical pin shape differs')
    run_id=history.get('run_id'); digest=history.get('run_evidence_sha256'); attempts=history.get('attempts')
    if not isinstance(run_id,str) or not run_id or '/' in run_id or '..' in run_id or run_id in history_by_run:
        raise RuntimeError('v5 history run identity is invalid or repeated')
    if not isinstance(digest,str) or len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest):
        raise RuntimeError('v5 run evidence digest is invalid')
    if not isinstance(attempts,list) or not attempts: raise RuntimeError('v5 history attempts are missing')
    claims=set(); epochs=set()
    for claim in attempts:
        historical_count+=1
        if historical_count>128 or not isinstance(claim,dict) or set(claim)!={'task_id','attempt_id','ownership_epoch','resource_id'}:
            raise RuntimeError('v5 historical claim inventory is invalid or exceeds 128')
        if any(not isinstance(claim.get(key),str) or not claim[key] or '/' in claim[key] or '..' in claim[key] for key in ('task_id','attempt_id','resource_id')):
            raise RuntimeError('v5 historical claim identity is invalid')
        if type(claim.get('ownership_epoch')) is not int or claim['ownership_epoch']<=0:
            raise RuntimeError('v5 historical claim epoch is invalid')
        key=(claim['task_id'],claim['attempt_id']); epoch=(claim['task_id'],claim['ownership_epoch'])
        if key in claims or epoch in epochs: raise RuntimeError('v5 history has duplicate attempt/epoch')
        claims.add(key); epochs.add(epoch)
    history_by_run[run_id]=history
store_file_limit=MAX_STORE_FILES if v5 else MAX_ENTRIES
store_run_limit=MAX_STORE_RUNS if v5 else MAX_ENTRIES
walk_deadline=time.monotonic()+STORE_WALK_SECONDS if v5 else None
run_evidence={run_id:{} for run_id in history_by_run}
def run_file_sha(path):
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
    try:
        before=os.fstat(fd); identity=cas_identity(before)
        if not stat.S_ISREG(before.st_mode) or identity!=cas_identity(os.lstat(path)):
            raise RuntimeError('v5 run evidence is not a stable regular file')
        digest=hashlib.sha256(); size=0
        while True:
            if time.monotonic()>=walk_deadline: raise RuntimeError('v5 accepted store walk exceeded its time bound')
            chunk=os.read(fd,CAS_READ_CHUNK_BYTES)
            if not chunk: break
            size+=len(chunk); digest.update(chunk)
        if size!=before.st_size or identity!=cas_identity(os.fstat(fd)) or identity!=cas_identity(os.lstat(path)):
            raise RuntimeError('v5 run evidence metadata changed while reading')
        return digest.hexdigest()
    finally: os.close(fd)
run_dirs=[]
for entry in os.scandir(runs):
    if v5 and time.monotonic()>=walk_deadline: raise RuntimeError('v5 accepted store walk exceeded its time bound')
    if entry.is_symlink() or not entry.is_dir(follow_symlinks=False): raise RuntimeError('accepted store runs has an invalid entry')
    run_dirs.append(entry.name)
    if len(run_dirs)>store_run_limit: raise RuntimeError('accepted store inventory is unbounded')
records={}; run_file_paths={}; count=0; directory_count=0
for current, directories, files in os.walk(store, topdown=True, followlinks=False):
    if v5 and time.monotonic()>=walk_deadline: raise RuntimeError('v5 accepted store walk exceeded its time bound')
    directory_count+=1
    if v5 and directory_count>MAX_STORE_DIRECTORIES: raise RuntimeError('v5 accepted store directory inventory is unbounded')
    current_path=pathlib.Path(current)
    if any((current_path/name).is_symlink() for name in directories): raise RuntimeError('accepted store contains a symlink')
    for name in files:
        if v5 and time.monotonic()>=walk_deadline: raise RuntimeError('v5 accepted store walk exceeded its time bound')
        count+=1
        if count>store_file_limit: raise RuntimeError('accepted store inventory is unbounded')
        path=current_path/name
        if path.is_symlink() or not path.is_file(): raise RuntimeError('accepted store contains an invalid file')
        if path.is_relative_to(runs):
            relative=path.relative_to(runs)
            run_file_paths[relative.as_posix()]=path
            if relative.parts[0] in run_evidence:
                run_evidence[relative.parts[0]][path.relative_to(runs/relative.parts[0]).as_posix()]=run_file_sha(path)
        if name in ({'run_intent.json','run_catalog.json','artifact_catalog.json'} if observation.get('terminal_mode') else {'run_intent.json','run_catalog.json'}):
            relative=path.relative_to(store).as_posix()
            records[relative]=hashlib.sha256(regular(path,'retained run record')).hexdigest()
if v5:
    if time.monotonic()>=walk_deadline: raise RuntimeError('v5 accepted store walk exceeded its time bound')
    for run_id,files in run_evidence.items():
        if hashlib.sha256(canonical(files)).hexdigest()!=history_by_run[run_id]['run_evidence_sha256']:
            raise RuntimeError('v5 full run evidence inventory/digest differs from history pin')
pins=observation.get('retained_cancelled_runs')
v4=observation.get('v4_mode') is True
terminal_expected={}
held_expected={}
if v4:
    terminal_pins=observation.get('retained_terminal_runs')
    held_pins=observation.get('retained_held_manual_runs')
    if not isinstance(terminal_pins,list) or not 0<=len(terminal_pins)<=128 or not isinstance(held_pins,list) or not 1<=len(held_pins)<=128 or len(terminal_pins)+len(held_pins)>128 or pins is not None:
        raise RuntimeError('v4 retained run pin pair is invalid or unbounded')
    expected={}
    for pin in terminal_pins:
        if not isinstance(pin,dict) or set(pin)!={'run_id','run_intent_sha256','run_catalog_sha256','artifact_catalog_sha256'}:
            raise RuntimeError('v4 terminal pin has an invalid shape')
        run_id=pin.get('run_id')
        if not isinstance(run_id,str) or not run_id or '/' in run_id or '..' in run_id:
            raise RuntimeError('v4 terminal run id is invalid')
        for key in ('run_intent_sha256','run_catalog_sha256'):
            value=pin.get(key)
            if not isinstance(value,str) or len(value)!=64 or any(c not in '0123456789abcdef' for c in value): raise RuntimeError('v4 terminal digest is invalid')
        if pin['artifact_catalog_sha256'] is not None and (not isinstance(pin['artifact_catalog_sha256'],str) or len(pin['artifact_catalog_sha256'])!=64 or any(c not in '0123456789abcdef' for c in pin['artifact_catalog_sha256'])): raise RuntimeError('v4 artifact catalog digest is invalid')
        if run_id in expected: raise RuntimeError('v4 retained run id is repeated')
        expected[run_id]=pin; terminal_expected[run_id]=pin
    for pin in held_pins:
        if not isinstance(pin,dict) or set(pin)!={'run_id','run_intent_sha256','run_catalog_sha256','start_release'} or pin.get('start_release')!='absent':
            raise RuntimeError('held-manual pin has an invalid shape or release expectation')
        run_id=pin.get('run_id')
        if not isinstance(run_id,str) or not run_id or '/' in run_id or '..' in run_id:
            raise RuntimeError('held-manual run id is invalid')
        for key in ('run_intent_sha256','run_catalog_sha256'):
            value=pin.get(key)
            if not isinstance(value,str) or len(value)!=64 or any(c not in '0123456789abcdef' for c in value): raise RuntimeError('held-manual digest is invalid')
        if run_id in expected: raise RuntimeError('v4 retained run id is repeated')
        expected[run_id]=pin; held_expected[run_id]=pin
    if set(run_dirs)!=set(expected): raise RuntimeError('v4 retained run pins do not exactly match run directories')
    if any(run_id not in terminal_expected for run_id in history_by_run): raise RuntimeError('v5 history run is not in terminal subset')
    expected_records={}
    for run_id,pin in expected.items():
        expected_records['runs/'+run_id+'/run_intent.json']=pin['run_intent_sha256']
        expected_records['runs/'+run_id+'/run_catalog.json']=pin['run_catalog_sha256']
        if run_id in terminal_expected and pin['artifact_catalog_sha256'] is not None:
            expected_records['runs/'+run_id+'/artifact_catalog.json']=pin['artifact_catalog_sha256']
    if set(records)!=set(expected_records): raise RuntimeError('v4 accepted-store record inventory differs from retained pins')
    if records!=expected_records: raise RuntimeError('v4 accepted-store record bytes differ from retained pins')
    run_records=[dict(pin) for run_id,pin in sorted(expected.items())]
elif pins is None:
    if records: raise RuntimeError('accepted store contains admitted run records')
    run_records=[]
else:
    if not isinstance(pins,list) or not 1<=len(pins)<=128: raise RuntimeError('retained run pins are invalid or unbounded')
    expected={}
    for pin in pins:
        if not isinstance(pin,dict) or set(pin)!=({'run_id','run_intent_sha256','run_catalog_sha256','artifact_catalog_sha256'} if observation.get('terminal_mode') else {'run_id','run_intent_sha256','run_catalog_sha256'}): raise RuntimeError('retained run pin has an invalid shape')
        run_id=pin.get('run_id')
        if not isinstance(run_id,str) or not run_id or '/' in run_id or '..' in run_id: raise RuntimeError('retained run id is invalid')
        for key in ('run_intent_sha256','run_catalog_sha256'):
            value=pin.get(key)
            if not isinstance(value,str) or len(value)!=64 or any(c not in '0123456789abcdef' for c in value): raise RuntimeError('retained run digest is invalid')
        if run_id in expected: raise RuntimeError('retained run id is repeated')
        expected[run_id]=pin
    if set(run_dirs)!=set(expected): raise RuntimeError('retained run pins do not exactly match run directories')
    expected_records={}
    for run_id,pin in expected.items():
        expected_records['runs/'+run_id+'/run_intent.json']=pin['run_intent_sha256']
        expected_records['runs/'+run_id+'/run_catalog.json']=pin['run_catalog_sha256']
        if observation.get('terminal_mode') and pin['artifact_catalog_sha256'] is not None:
            expected_records['runs/'+run_id+'/artifact_catalog.json']=pin['artifact_catalog_sha256']
    if set(records)!=set(expected_records): raise RuntimeError('accepted store run-record inventory differs from retained pins')
    if records!=expected_records: raise RuntimeError('accepted store run-record bytes differ from retained pins')
    run_records=[dict(pin) for run_id,pin in sorted(expected.items())]
if observation.get('terminal_mode') or v4:
    for folder in ('manifests','live_command_journals','recovery','temp','batches'):
        root=store/folder
        if root.exists():
            if root.is_symlink() or not root.is_dir() or any(root.iterdir()): raise RuntimeError('pending or unknown runtime work: '+folder)
    scheduler=store/'scheduler_pools'
    if scheduler.exists():
        if scheduler.is_symlink() or not scheduler.is_dir(): raise RuntimeError('invalid scheduler namespace')
        for path in scheduler.iterdir():
            checkpoint=json.loads(regular(path,'scheduler checkpoint'))
            if any(run_id not in expected for run_id in checkpoint.get('run_ids',[])) or (checkpoint.get('next_run_id') is not None and checkpoint['next_run_id'] not in expected): raise RuntimeError('scheduler references unknown work')
    referenced=set()
    # Shared by all terminal runs, including each final metadata reread.
    # Separate from the CAS object-byte allowance checked below.
    prepared_record_read_budget=[1024*1024*1024]
    terminal_subset=terminal_expected if v4 else expected
    for run_id,pin in terminal_subset.items():
        intent=json.loads(regular(runs/run_id/'run_intent.json','run intent'))
        refs=[intent.get(key) for key in ('definition_object_ref','study_object_ref','study_catalog_object_ref')]
        assets=intent.get('asset_object_refs',{})
        if not isinstance(assets,dict): raise RuntimeError('retained input asset refs are invalid')
        refs.extend(assets.values())
        for ref in refs:
            if ref is None: continue
            if not isinstance(ref,str) or len(ref)!=64 or any(c not in '0123456789abcdef' for c in ref): raise RuntimeError('retained input CAS ref is invalid')
            referenced.add(ref)
        catalog=json.loads(regular(runs/run_id/'run_catalog.json','run catalog'))
        tasks=catalog.get('tasks')
        if not isinstance(tasks,list) or not tasks: raise RuntimeError('terminal run has no tasks')
        if any(not isinstance(t,dict) or t.get('lifecycle') not in ('succeeded','failed','cancelled') for t in tasks): raise RuntimeError('run contains nonterminal tasks')
        if pin['artifact_catalog_sha256'] is None and any(t.get('artifact_ids') for t in tasks): raise RuntimeError('terminal run outputs have no artifact catalog')
        task_by_id={t.get('task_id'):t for t in tasks if isinstance(t.get('task_id'),str)}
        if len(task_by_id)!=len(tasks): raise RuntimeError('terminal task identity inventory is invalid')
        referenced.update(terminal_prepared_refs(runs/run_id,run_id,task_by_id,prepared_record_read_budget))
        historical_claims={}
        for claim in history_by_run.get(run_id,{}).get('attempts',[]):
            task=task_by_id.get(claim['task_id'])
            if (task is None or type(task.get('ownership_epoch')) is not int
                    or claim['ownership_epoch']>=task['ownership_epoch'] or claim['attempt_id']==task.get('attempt_id')):
                raise RuntimeError('v5 historical claim is not older than its current terminal task')
            historical_claims[(claim['task_id'],claim['attempt_id'],claim['ownership_epoch'],claim['resource_id'])]=claim
        for task_id in {key[0] for key in historical_claims}:
            epochs=sorted(key[2] for key in historical_claims if key[0]==task_id)
            if epochs!=list(range(1,task_by_id[task_id]['ownership_epoch'])):
                raise RuntimeError('v5 historical admission epoch chain contains a gap')
        def claim_key(record):
            return (record.get('task_id'),record.get('attempt_id'),record.get('ownership_epoch'),record.get('resource_id'))
        def current_attempt(record,label):
            task=task_by_id.get(record.get('task_id'))
            attempt=record.get('attempt_id')
            if (task is not None and isinstance(attempt,str) and attempt
                    and task.get('attempt_id')==attempt and record.get('run_id',run_id)==run_id
                    and record.get('ownership_epoch')==task.get('ownership_epoch')):
                return task
            historical=historical_claims.get(claim_key(record)) if record.get('run_id',run_id)==run_id else None
            if historical is not None:
                return {**task,**historical,'lifecycle':'failed','artifact_ids':[]}
            raise RuntimeError('unsupported historical retry: '+label+' differs from current terminal catalog attempt')
        solver_leases={}
        for folder in ('resource_leases','preparation_resource_leases'):
            root=runs/run_id/folder
            if root.exists():
                if root.is_symlink() or not root.is_dir(): raise RuntimeError('invalid local lease directory')
                for path in root.rglob('*'):
                    if path.is_symlink(): raise RuntimeError('local lease symlink')
                    if path.is_file():
                        lease=json.loads(regular(path,'local lease'))
                        if lease.get('state')!='released': raise RuntimeError('active or unknown local lease')
                        if folder=='resource_leases':
                            if lease.get('run_id')!=run_id: raise RuntimeError('retained solver lease belongs to another run')
                            task=current_attempt(lease,'retained solver lease')
                            epoch=lease.get('ownership_epoch')
                            attempt=lease.get('attempt_id')
                            resource=lease.get('resource_id')
                            if (type(epoch) is not int or epoch<=0 or not isinstance(attempt,str) or not attempt
                                    or not isinstance(resource,str) or not resource
                                    or resource!=task.get('resource_id')):
                                raise RuntimeError('retained solver lease has an invalid task resource identity')
                            key=(task['task_id'],attempt,epoch,resource)
                            if key in solver_leases: raise RuntimeError('duplicate retained solver lease identity')
                            solver_leases[key]=lease
        seen_admissions=set()
        admissions=runs/run_id/'task_admissions'
        if admissions.exists():
            if admissions.is_symlink() or not admissions.is_dir(): raise RuntimeError('invalid task admission directory')
            for path in admissions.rglob('*'):
                if path.is_symlink(): raise RuntimeError('task admission symlink')
                if path.is_file():
                    admission=json.loads(regular(path,'retained task admission'))
                    task=admission.get('task'); lease=admission.get('lease')
                    if not isinstance(task,dict) or not isinstance(lease,dict): raise RuntimeError('retained task admission has no task and lease')
                    current_attempt(task,'retained task admission task')
                    current_attempt(lease,'retained task admission lease')
                    parts=path.relative_to(admissions).parts
                    if len(parts)!=2 or parts[0]!=task.get('task_id') or parts[1]!=task.get('attempt_id')+'.json': raise RuntimeError('unsupported historical retry: retained task admission path differs from current terminal attempt')
                    if run_id in history_by_run:
                        key=claim_key(task)
                        released=solver_leases.get(key)
                        identity_fields=('schema_version','resource_id','kind','budget','run_id','task_id','attempt_id','ownership_epoch','lease_token','host_launch_binding')
                        if (key!=claim_key(lease) or key in seen_admissions or released is None
                                or any(lease.get(field)!=released.get(field) for field in identity_fields)
                                or not isinstance(released.get('lease_token'),str) or not released['lease_token']
                                or not isinstance(released.get('released_at'),str) or not released['released_at']):
                            raise RuntimeError('v5 admission has no exact released lease identity')
                        seen_admissions.add(key)
        if run_id in history_by_run:
            if not set(historical_claims).issubset(solver_leases) or not set(historical_claims).issubset(seen_admissions):
                raise RuntimeError('v5 history claim lacks its released lease or admission')
            retry_by_claim={}; exit_by_claim={}
            for folder in ('retry_decisions','worker_process_exit_receipts'):
                root=runs/run_id/folder
                if not root.is_dir() or root.is_symlink(): raise RuntimeError('v5 history lacks retry/exit evidence')
                for path in root.iterdir():
                    record=json.loads(regular(path,'v5 historical '+folder))
                    if record.get('run_id')!=run_id: raise RuntimeError('v5 retry/exit belongs to another run')
                    if folder=='retry_decisions':
                        # Retry decisions have no resource field; bind it through
                        # the uniquely pinned task/attempt/epoch, never current task.
                        matches=[key for key in historical_claims if key[:3]==(record.get('task_id'),record.get('attempt_id'),record.get('ownership_epoch'))]
                        if len(matches)!=1: raise RuntimeError('v5 retry decision refers to an unpinned historical claim')
                        key=matches[0]
                        if (key in retry_by_claim or record.get('schema_version')!='retry_decision.v1'
                                or record.get('trigger')!='explicit_operator_request' or record.get('action')!='retry'
                                or path.name!=str(record.get('decision_id'))+'.json'):
                            raise RuntimeError('v5 historical retry is missing, duplicated or not explicit')
                        retry_by_claim[key]=record
                    else:
                        current_attempt(record,'v5 worker exit evidence')
                        key=claim_key(record)
                        if key not in historical_claims: continue
                        lease=solver_leases[key]
                        if (key in exit_by_claim or record.get('status_success') is not False
                                or type(record.get('exit_code')) is not int or record['exit_code']==0
                                or record.get('timed_out') is not False
                                or record.get('lease_token')!=lease.get('lease_token')
                                or record.get('lease_heartbeat_sequence')!=lease.get('heartbeat_sequence')
                                or type(record.get('process_id')) is not int or record['process_id']<=0):
                            raise RuntimeError('v5 historical failed exit does not bind its released lease')
                        exit_by_claim[key]=record
            if set(retry_by_claim)!=set(historical_claims) or set(exit_by_claim)!=set(historical_claims):
                raise RuntimeError('v5 historical claim has no unique explicit retry and failed exit')
        artifact_path=runs/run_id/'artifact_catalog.json'
        artifact_sha=pin.get('artifact_catalog_sha256')
        if artifact_sha is None:
            if any(task.get('artifact_ids') for task in tasks):
                raise RuntimeError('terminal run outputs have no artifact catalog')
        else:
            artifact_raw=regular(artifact_path,'retained artifact catalog')
            if hashlib.sha256(artifact_raw).hexdigest()!=artifact_sha:
                raise RuntimeError('retained artifact catalog bytes differ from its pin')
            def unique_object(pairs):
                value={}
                for key,item in pairs:
                    if key in value: raise RuntimeError('retained artifact catalog contains a duplicate JSON key')
                    value[key]=item
                return value
            artifact_catalog=json.loads(artifact_raw.decode(),object_pairs_hook=unique_object)
            entries=artifact_catalog.get('entries') if isinstance(artifact_catalog,dict) else None
            if (not isinstance(artifact_catalog,dict)
                    or set(artifact_catalog)!={'schema_version','run_id','revision','updated_at','entries'}
                    or artifact_catalog.get('schema_version')!='artifact_catalog.v1'
                    or artifact_catalog.get('run_id')!=run_id
                    or type(artifact_catalog.get('revision')) is not int or artifact_catalog['revision']<=0
                    or not isinstance(artifact_catalog.get('updated_at'),str) or not artifact_catalog['updated_at']
                    or not isinstance(entries,list) or len(entries)>MAX_ENTRIES):
                raise RuntimeError('retained artifact catalog identity/inventory is invalid')
            artifact_ids_by_task={}
            seen_artifacts=set()
            for entry in entries:
                required_fields={'artifact_id','task_id','attempt_id','ownership_epoch','logical_path','artifact_type','content_sha256','status','required'}
                if (not isinstance(entry,dict) or not required_fields.issubset(entry)
                        or set(entry)-required_fields-{'object_ref','study_output'}):
                    raise RuntimeError('retained artifact entry has an invalid shape')
                task_id=entry.get('task_id')
                task=task_by_id.get(task_id)
                if task is None:
                    raise RuntimeError('retained artifact refers to an unlisted task')
                attempt=task.get('attempt_id')
                epoch=task.get('ownership_epoch')
                resource=task.get('resource_id')
                if (not isinstance(attempt,str) or not attempt or type(epoch) is not int or epoch<=0
                        or not isinstance(resource,str) or not resource
                        or entry.get('attempt_id')!=attempt or type(entry.get('ownership_epoch')) is not int
                        or entry['ownership_epoch']!=epoch):
                    raise RuntimeError('retained artifact differs from its task attempt/epoch/resource')
                if (task_id,attempt,epoch,resource) not in solver_leases:
                    raise RuntimeError('retained artifact has no matching released task lease')
                artifact_id=entry.get('artifact_id')
                content_sha=entry.get('content_sha256')
                if (not isinstance(artifact_id,str) or not artifact_id or artifact_id in seen_artifacts
                        or not isinstance(content_sha,str) or len(content_sha)!=64
                        or any(c not in '0123456789abcdef' for c in content_sha)
                        or type(entry.get('required')) is not bool):
                    raise RuntimeError('retained artifact identity/content metadata is invalid')
                seen_artifacts.add(artifact_id)
                object_ref=entry.get('object_ref')
                if entry.get('status')=='published':
                    if not isinstance(object_ref,str) or len(object_ref)!=64 or any(c not in '0123456789abcdef' for c in object_ref) or object_ref!=content_sha:
                        raise RuntimeError('published retained artifact has no matching CAS object reference')
                    referenced.add(object_ref)
                elif entry.get('status') in {'unavailable','failed'}:
                    if object_ref is not None:
                        raise RuntimeError('unpublished retained artifact unexpectedly references CAS content')
                else:
                    raise RuntimeError('retained artifact status is unsupported')
                artifact_ids_by_task.setdefault(task_id,set()).add(artifact_id)
            for task_id,task in task_by_id.items():
                declared=task.get('artifact_ids',[])
                if not isinstance(declared,list) or len(set(declared))!=len(declared) or set(declared)!=artifact_ids_by_task.get(task_id,set()):
                    raise RuntimeError('terminal task artifact references differ from its pinned catalog')
    if v4:
        allowed_exact={'run_intent.json','run_catalog.json','preparation_receipt.json'}
        allowed_dirs={'preparation_resource_leases','preparation_process_launches','preparation_process_exit_receipts','task_preparation_receipts','accepted_stage_preparation_receipts','task_prepared_observations'}
        for run_id,pin in held_expected.items():
            run_root=runs/run_id
            release=run_root/'start_release.json'
            if os.path.lexists(str(release)):
                raise RuntimeError('held-manual run already has start_release.json')
            intent=json.loads(regular(run_root/'run_intent.json','held-manual run intent'))
            if intent.get('schema_version')!='run_intent.v1' or intent.get('run_id')!=run_id or not isinstance(intent.get('specification'),dict):
                raise RuntimeError('held-manual run intent identity differs')
            specification=intent.get('specification')
            parameters=specification.get('parameters')
            policy=parameters.get('fullmag.accepted_run_start') if isinstance(parameters,dict) else None
            if policy!={'schema_version':'accepted_run_start_policy.v1','mode':'manual'}:
                raise RuntimeError('held-manual run has no exact accepted manual-start policy')
            refs=[intent.get(key) for key in ('definition_object_ref','study_object_ref','study_catalog_object_ref')]
            assets=intent.get('asset_object_refs',{})
            if not isinstance(assets,dict):
                raise RuntimeError('held-manual input asset refs are invalid')
            refs.extend(assets.values())
            for ref in refs:
                if ref is None: continue
                if not isinstance(ref,str) or len(ref)!=64 or any(c not in '0123456789abcdef' for c in ref):
                    raise RuntimeError('held-manual input CAS ref is invalid')
                referenced.add(ref)
            catalog=json.loads(regular(run_root/'run_catalog.json','held-manual run catalog'))
            tasks=catalog.get('tasks')
            revision=catalog.get('revision')
            if (catalog.get('schema_version')!='run_catalog.v1' or catalog.get('run_id')!=run_id
                    or type(revision) is not int or revision<=0
                    or not isinstance(tasks,list) or not tasks or len(tasks)>1024):
                raise RuntimeError('held-manual run catalog identity/task inventory is invalid')
            task_ids=set()
            for task in tasks:
                task_fields={'task_id','input_fingerprint','lifecycle','readiness','artifact_ids','attempt_id','ownership_epoch','resolved_input_fingerprint','observation','resource_id','coordinator_watermark','coordinator_genesis'}
                if not isinstance(task,dict) or set(task)-task_fields or task.get('lifecycle')!='accepted':
                    raise RuntimeError('held-manual run contains an invalid or non-Accepted task')
                fingerprint=task.get('input_fingerprint')
                if not isinstance(fingerprint,str) or len(fingerprint)!=64 or any(c not in '0123456789abcdef' for c in fingerprint):
                    raise RuntimeError('held-manual task input fingerprint is invalid')
                readiness=task.get('readiness')
                if not isinstance(readiness,dict) or set(readiness)!={'state','reason'} or readiness.get('state')!='blocked' or not isinstance(readiness.get('reason'),str) or not readiness['reason'].strip():
                    raise RuntimeError('held-manual task is not explicitly Blocked')
                if any(task.get(key) is not None for key in ('attempt_id','ownership_epoch','resolved_input_fingerprint','resource_id','coordinator_watermark','coordinator_genesis','observation')) or task.get('artifact_ids',[])!=[]:
                    raise RuntimeError('held-manual task has compute claims or artifact outputs')
                task_id=task.get('task_id')
                if not isinstance(task_id,str) or not task_id or task_id in task_ids:
                    raise RuntimeError('held-manual task identity is invalid')
                task_ids.add(task_id)
            prefix=run_id+'/'
            local_evidence={}
            preparation={}
            for relative,path in run_file_paths.items():
                if not relative.startswith(prefix): continue
                suffix=relative[len(prefix):]
                parts=suffix.split('/')
                valid=(suffix in allowed_exact
                       or (len(parts)==2 and parts[0] in allowed_dirs-{'preparation_resource_leases'} and parts[1].endswith('.json'))
                       or (len(parts)==3 and parts[0]=='preparation_resource_leases' and parts[2].endswith('.json')))
                if not valid:
                    raise RuntimeError('held-manual recovery rejects compute/cancellation/unknown evidence: '+suffix)
                raw=regular(path,'held-manual evidence')
                local_evidence[relative]=hashlib.sha256(raw).hexdigest()
                if suffix not in {'run_intent.json','run_catalog.json'}:
                    try: item=json.loads(raw.decode())
                    except (UnicodeDecodeError,json.JSONDecodeError) as error:
                        raise RuntimeError('held-manual preparation evidence is invalid JSON') from error
                    if not isinstance(item,dict):
                        raise RuntimeError('held-manual preparation evidence is not an object')
                    preparation[suffix]=item
            leases={}; launches={}; exits={}; receipts={}
            def preparation_key(item):
                return tuple(item.get(key) for key in ('task_id','preparation_attempt_id','resource_id','lease_token'))
            for suffix,item in preparation.items():
                leaf=suffix.split('/')[0]
                key=preparation_key(item) if leaf in {'preparation_resource_leases','preparation_process_launches','preparation_process_exit_receipts'} else None
                if leaf=='preparation_resource_leases':
                    heartbeat=item.get('heartbeat_sequence')
                    if (item.get('run_id')!=run_id or item.get('state')!='released'
                            or not isinstance(item.get('released_at'),str) or not item['released_at']
                            or type(heartbeat) is not int or heartbeat<0 or key[0] not in task_ids or None in key or key in leases):
                        raise RuntimeError('held-manual preparation has an active or invalid lease')
                    leases[key]=item
                elif leaf=='preparation_process_launches':
                    sequence=item.get('lease_heartbeat_sequence')
                    process_id=item.get('supervisor_process_id')
                    if (item.get('run_id')!=run_id or key[0] not in task_ids or None in key or key in launches
                            or type(sequence) is not int or sequence<0 or type(process_id) is not int or process_id<=0):
                        raise RuntimeError('held-manual preparation launch identity differs')
                    launches[key]=item
                elif leaf=='preparation_process_exit_receipts':
                    exit_code=item.get('exit_code')
                    sequence=item.get('lease_heartbeat_sequence')
                    process_id=item.get('process_id')
                    if (item.get('run_id')!=run_id or key[0] not in task_ids or None in key or key in exits
                            or item.get('status_success') is not True or type(exit_code) is not int or exit_code!=0
                            or item.get('timed_out') is not False or item.get('failure_reason') is not None
                            or type(sequence) is not int or sequence<0 or type(process_id) is not int or process_id<=0
                            or not isinstance(item.get('observed_at'),str) or not item['observed_at']):
                        raise RuntimeError('held-manual preparation lacks a successful exit-zero receipt')
                    exits[key]=item
                elif leaf=='task_preparation_receipts':
                    task_id=item.get('task_id')
                    if item.get('run_id')!=run_id or task_id not in task_ids or task_id in receipts:
                        raise RuntimeError('held-manual task preparation receipt identity differs')
                    receipts[task_id]=item
                elif leaf=='task_prepared_observations':
                    if item.get('run_id')!=run_id or item.get('task_id') not in task_ids:
                        raise RuntimeError('held-manual preparation observation identity differs')
                    outcome=item.get('outcome')
                    if isinstance(outcome,dict) and outcome.get('state')=='published':
                        published=[outcome.get('bundle_object_ref')]
                        object_refs=outcome.get('object_refs')
                        if not isinstance(object_refs,list): raise RuntimeError('held-manual prepared object refs are invalid')
                        published.extend(object_refs)
                        for ref in published:
                            if not isinstance(ref,str) or len(ref)!=64 or any(c not in '0123456789abcdef' for c in ref):
                                raise RuntimeError('held-manual prepared object reference is invalid')
                            referenced.add(ref)
            if len(leases)!=len(launches) or len(leases)!=len(exits):
                raise RuntimeError('held-manual preparation lease/launch/exit inventory is incomplete')
            for key,lease in leases.items():
                if key not in launches or key not in exits or key[0] not in receipts:
                    raise RuntimeError('released held-manual preparation lacks its launch, successful exit, or task receipt')
                launch=launches[key]; exit_receipt=exits[key]
                if (launch['lease_heartbeat_sequence']>exit_receipt['lease_heartbeat_sequence']
                        or exit_receipt['lease_heartbeat_sequence']!=lease['heartbeat_sequence']):
                    raise RuntimeError('held-manual preparation heartbeat evidence differs')
            if receipts and any(task_id not in {key[0] for key in leases} for task_id in receipts):
                raise RuntimeError('held-manual task preparation receipt has no released preparation lease')
            for relative,digest in local_evidence.items():
                if hashlib.sha256(regular(runs/relative,'held-manual evidence final CAS')).hexdigest()!=digest:
                    raise RuntimeError('held-manual evidence changed before final CAS')
            if os.path.lexists(str(release)):
                raise RuntimeError('held-manual start release appeared during snapshot')
    pin_root=store/'objects/pins'
    if pin_root.is_symlink() or not pin_root.is_dir(): raise RuntimeError('retained input CAS pins directory is missing')
    for path in pin_root.iterdir():
        pin=json.loads(regular(path,'retained input CAS pin',4096))
        ref=path.name.removesuffix('.json')
        if path.suffix!='.json' or set(pin)!={'schema','object_ref'} or pin['schema']!='fullmag.cas-pin.v1' or pin['object_ref']!=ref or ref not in referenced: raise RuntimeError('retained input CAS pin is not referenced by the retained intents')
    total=0
    # Prepared terminal observations share v4's bounded aggregate I/O allowance;
    # cancelled/default paths and the 128 MiB per-object bound stay unchanged.
    cas_budget=1024*1024*1024 if observation.get('terminal_mode') or v4 else 128*1024*1024
    for ref in sorted(referenced):
        total+=hash_cas_object(store/'objects/sha256'/ref,ref,cas_budget-total)

print(json.dumps({'schema':'fullmag.container-recovery-storage-proof.v1','store_root_sha256':hashlib.sha256(b'/state/runs/docker-all/session-store').hexdigest(),'ledger_root_sha256':hashlib.sha256(b'/host-ledger/ledger').hexdigest(),'ledger_snapshot_sha256':ledger_digest,'store_file_count':count,'run_directories':sorted(run_dirs),'run_records':run_records,**({'retained_attempt_histories':history_pins} if v5 else {}),**({'host_ledger_volume_probe':volume_proof} if volume_proof is not None else {})},sort_keys=True))
'''
    if ledger_descriptor is not None:
        import docker_host_ledger as ledger
        # Reuse the bounded unprivileged mount/marker proof in this same helper.
        # Descriptor data travels as argv, never as executable Python source.
        script = (
            ledger.HOST_VOLUME_PROBE_FUNCTIONS
            + "\nimport json,signal,sys\nsignal.alarm(45)\n"
            + "observation=json.loads(sys.argv[1])\n"
            + "volume_proof=probe(observation['ledger_descriptor'])\n"
            + script
        )
    else:
        script = "import json,sys\nobservation=json.loads(sys.argv[1])\nvolume_proof=None\n" + script
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
    args.append(canonical({
        "ledger_descriptor": ledger_descriptor,
        "retained_cancelled_runs": [dict(pin) for pin in retained_pins] if retained_pins is not None and not v4_mode else None,
        "terminal_mode": terminal_mode,
        "retained_terminal_runs": [dict(pin) for pin in retained_terminal_runs] if retained_terminal_runs is not None else None,
        "retained_held_manual_runs": held_pins,
        "v4_mode": v4_mode,
        "v5_mode": v5_mode,
        "retained_attempt_histories": list(retained_attempt_histories) if v5_mode else None,
    }).decode("utf-8"))
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
    expected_records = []
    if retained_pins is not None:
        expected_records = [dict(pin) for pin in sorted(retained_pins, key=lambda item: item["run_id"])]
    if value.get("run_records") != expected_records:
        _fail("accepted store/ledger proof run records differ from retained pins")
    if v5_mode and value.get("retained_attempt_histories") != list(retained_attempt_histories):
        _fail("accepted-store history evidence differs from v5 pins")
    return dict(value)


def _is_abrupt(authorization: Mapping[str, object]) -> bool:
    return authorization.get("schema_version") == ABRUPT_OPERATOR_SCHEMA


def _assert_request_matches_abrupt_retained_pins(
    request: Mapping[str, object], proof: Mapping[str, object]
) -> None:
    if request.get("retained_terminal_runs") != proof.get("retained_terminal_runs"):
        _fail("prepared request terminal pins differ from abrupt proof")
    if proof.get("schema") in {ABRUPT_PROOF_HELD_MANUAL_SCHEMA, ABRUPT_PROOF_ATTEMPT_HISTORY_SCHEMA}:
        expected_schema = ATTEMPT_HISTORY_REQUEST_SCHEMA if proof.get("schema") == ABRUPT_PROOF_ATTEMPT_HISTORY_SCHEMA else HELD_MANUAL_REQUEST_SCHEMA
        if request.get("schema_version") != expected_schema:
            _fail("abrupt proof requires its matching retained recovery request version")
        if request.get("retained_held_manual_runs") != proof.get("retained_held_manual_runs"):
            _fail("prepared request held-manual pins differ from abrupt proof")
    elif "retained_held_manual_runs" in request:
        _fail("held-manual pins have no matching v4 abrupt proof")
    if request.get("retained_attempt_histories") != proof.get("retained_attempt_histories"):
        _fail("prepared request attempt-history pins differ from abrupt proof")
    if "retained_attempt_histories" in request and proof.get("schema") != ABRUPT_PROOF_ATTEMPT_HISTORY_SCHEMA:
        _fail("attempt-history pins have no matching v5 abrupt proof")


def _abrupt_pins(value: Mapping[str, object]) -> dict[str, object]:
    """The input to preparation excludes the as-yet uncomputed proof digest."""
    keys = {"request_id", "source_root", "compose_project", "development_attempt",
            "compose_config_sha256", "backend_container_id", "frontend_container_id",
            "old_image_id", "process_receipt_sha256", "config_sha256", "owner_sha256", "launch_sha256"}
    pins = dict(value)
    if set(pins) != keys:
        _fail("abrupt preparation authorization_pins fields differ from the frozen schema")
    if not REQUEST_ID_RE.fullmatch(str(pins["request_id"])) or not ATTEMPT_RE.fullmatch(str(pins["development_attempt"])):
        _fail("abrupt preparation request/attempt identity is invalid")
    _require_text(pins["source_root"], "abrupt source root")
    if not isinstance(pins["compose_project"], str) or not PROJECT_RE.fullmatch(pins["compose_project"]):
        _fail("abrupt preparation project is invalid")
    for key in keys:
        if key.endswith("_sha256"):
            _require_sha(pins[key], key)
    for key in ("backend_container_id", "frontend_container_id"):
        _require_container(pins[key], key)
    if pins["backend_container_id"] == pins["frontend_container_id"]:
        _fail("abrupt preparation repeats a service identity")
    _require_image(pins["old_image_id"], "abrupt old image")
    return pins


def _abrupt_authorization_pins(authorization):
    return _abrupt_pins({key: authorization[key] for key in (
        "request_id", "source_root", "compose_project", "development_attempt",
        "compose_config_sha256", "backend_container_id", "frontend_container_id", "old_image_id",
        "process_receipt_sha256", "config_sha256", "owner_sha256", "launch_sha256")})


def _strict_stopped(container: Mapping[str, object]) -> None:
    state = _require_mapping(container.get("State"), "abrupt Docker State")
    if (state.get("Status") != "exited" or state.get("Running") is not False
            or type(state.get("Pid")) is not int or state["Pid"] != 0
            or type(state.get("ExitCode")) is not int
            or not 0 <= state["ExitCode"] <= 255
            or state.get("Restarting") is not False or state.get("Paused") is not False):
        _fail("abrupt recovery requires an exact stopped, unpaused Docker namespace")
    for key in ("StartedAt", "FinishedAt"):
        timestamp = _require_text(state.get(key), f"stopped {key}", 128)
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T[0-9:.]+Z", timestamp) or timestamp.startswith("0001-"):
            _fail("abrupt Docker timestamps are not authoritative")
    host = _require_mapping(container.get("HostConfig"), "abrupt HostConfig")
    if host.get("PidMode") not in (None, "", "private") or host.get("IpcMode") not in ("private", ""):
        _fail("abrupt recovery requires private PID and IPC namespaces")
    name = _network_name(container, "stopped service")
    if host.get("NetworkMode") != name:
        _fail("abrupt recovery requires the exact private service network namespace")


def _abrupt_network(backend, frontend, project):
    from docker_stopped_network import observe_stopped_bridge
    from docker_volume_dev import _assert_private_restart_network
    try:
        return observe_stopped_bridge(backend, frontend, project, capture=docker_capture,
                                      validate_owned_bridge=_assert_private_restart_network)
    except BuildControlError as error:
        _fail(str(error))


def _retained_compose_state_root(backend, compose, *, project="fullmag-master"):
    if (not isinstance(project, str) or PROJECT_RE.fullmatch(project) is None
            or not isinstance(compose, Mapping) or compose.get("name") != project
            or backend.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") != project):
        _fail("foreign alias proof has no retained selected Compose identity")
    service = compose.get("services", {}).get("backend", {})
    volumes = service.get("volumes") if isinstance(service, Mapping) else None
    candidates = [item for item in volumes if isinstance(item, Mapping)
                  and item.get("target") == "/state"] if isinstance(volumes, list) else []
    if len(candidates) != 1 or candidates[0].get("type") != "bind":
        _fail("foreign alias proof has no unique retained canonical backend state bind")
    source = candidates[0].get("source")
    if (not isinstance(source, str) or not source.startswith("/")
            or ".." in PurePosixPath(source).parts or str(PurePosixPath(source)) != source):
        _fail("foreign alias proof retained state source is unsafe")
    actual = [item for item in backend.get("Mounts", [])
              if isinstance(item, Mapping) and item.get("Destination") == "/state"]
    daemon_binds = service.get("x-fullmag-daemon-binds")
    if (len(actual) != 1 or actual[0].get("Type") != "bind"
            or not isinstance(actual[0].get("Source"), str)
            or not isinstance(daemon_binds, Mapping)
            or daemon_binds.get("/state") != actual[0].get("Source")):
        _fail("foreign alias proof backend state mount differs from its retained daemon pin")
    path = Path(source)
    try:
        if any(storage.is_link(item) for item in (path, *path.parents)):
            _fail("foreign alias proof retained state traverses a symlink")
        resolved = path.resolve(strict=True)
    except OSError as error:
        _fail("foreign alias proof retained state is unavailable: " + str(error))
    if resolved != path or not path.is_dir():
        _fail("foreign alias proof retained state is not a canonical directory")
    image = backend.get("Image")
    if not isinstance(image, str) or IMAGE_RE.fullmatch(image) is None:
        _fail("foreign alias proof retained backend image is not immutable")
    try:
        documents = json.loads(docker_capture("image", "inspect", image, timeout=90).stdout)
        if (not isinstance(documents, list) or len(documents) != 1
                or documents[0].get("Id") != image):
            _fail("foreign alias proof retained backend image is unavailable")
        from docker_volume_dev import _validate_retained_service
        _validate_retained_service(compose, backend, "backend", documents[0].get("Config", {}))
    except (json.JSONDecodeError, TypeError, ValueError, BuildControlError) as error:
        _fail("foreign alias proof retained backend service is not authenticated: " + str(error))
    return path


def _prove_foreign_alias_for_abrupt(control, backend, container, alias, compose):
    from docker_bind_overlap_probe import prove_foreign_alias_disjoint
    state_root = _retained_compose_state_root(backend, compose)
    return prove_foreign_alias_disjoint(control, backend, container, alias, state_root)


def _posix_paths_overlap(left, right):
    # Keep host preflight compatible with Python 3.8 hosts.
    left, right = PurePosixPath(left), PurePosixPath(right)
    return left == right or left in right.parents or right in left.parents


def _read_foreign_docker_consumers(excluded):
    # Short-lived helpers can disappear between ps and bulk inspect. Restart
    # the entire read only when the inventory actually changed; never accept
    # a partial inspect or reinterpret an unchanged permission/daemon failure.
    for observation in range(3):
        listed = docker_capture("ps", "-aq", "--no-trunc", timeout=60).stdout.decode().split()
        if len(listed) != len(set(listed)):
            _fail("Docker consumer inventory contains duplicate IDs")
        foreign = sorted(set(listed) - excluded)
        if not foreign:
            return []
        if len(foreign) > 512:
            _fail("Docker consumer inventory exceeds the observation budget")
        for identifier in foreign:
            _require_container(identifier, "foreign Docker consumer ID")
        try:
            raw = docker_capture("inspect", *foreign, timeout=90).stdout
        except BuildControlError:
            after = docker_capture("ps", "-aq", "--no-trunc", timeout=60).stdout.decode().split()
            if observation == 2 or set(after) == set(listed):
                raise
            continue
        records = json.loads(raw)
        if (not isinstance(records, list) or len(records) != len(foreign)
                or any(not isinstance(item, Mapping) for item in records)
                or {item.get("Id") for item in records} != set(foreign)):
            _fail("foreign Docker consumer inventory changed during observation")
        return records
    _fail("Docker consumer inventory did not stabilize")


def _prove_foreign_windows_bind(control, backend, item, source, compose):
    state_root = _retained_compose_state_root(backend, compose, project=control.project)
    from docker_windows_bind_isolation import (
        WindowsBindObservationDrift, prove_windows_bind_disjoint,
        validate_windows_bind_disjoint_proof)
    try:
        for observation in range(3):
            try:
                proof = prove_windows_bind_disjoint(control, backend, item, source, state_root)
                validate_windows_bind_disjoint_proof(proof, source=source, container_id=item.get("Id"))
                return
            except WindowsBindObservationDrift as drift:
                if not drift.ordinary_inventory_only or observation == 2:
                    raise
                # Discard this attempt entirely. A new proof must independently
                # re-observe all metadata and satisfy exact before/after equality.
    except WindowsBindObservationDrift as unstable:
        _fail("foreign Windows bind proof remained unstable: container="
              + str(item.get("Id")) + "; " + str(unstable))
    except Exception as present_error:
        # A removed historical source needs positive, typed absence evidence;
        # stopped state or lexical path differences alone never qualify.
        try:
            from docker_windows_absent_bind_isolation import (
                prove_absent_stopped_windows_bind, validate_absent_stopped_windows_bind_proof)
            proof = prove_absent_stopped_windows_bind(control, backend, item, source, state_root)
            validate_absent_stopped_windows_bind_proof(proof, source=source, container_id=item.get("Id"))
        except Exception as absent_error:
            _fail("foreign Windows bind has unresolved storage identity: container="
                  + str(item.get("Id")) + "; present proof: " + str(present_error)
                  + "; absent-stopped proof: " + str(absent_error))


def _assert_no_foreign_storage_consumers(control, backend, frontend, compose=None, *,
                                         prove_foreign_disjoint=None):
    """Fence every Docker consumer, including stopped containers able to restart."""
    protected = set()
    for container in (backend, frontend):
        for mount in container.get("Mounts", []):
            if mount.get("Destination") in {"/state", "/host-ledger", CONTROL_ROOT}:
                protected.add((mount.get("Type"), mount.get("Name") if mount.get("Type") == "volume" else mount.get("Source")))
    if compose is not None:
        for service in ("backend", "frontend"):
            for mount in compose.get("services", {}).get(service, {}).get("volumes", []):
                if mount.get("type") == "bind" and mount.get("target") in {"/state", "/host-ledger", CONTROL_ROOT}:
                    protected.add(("bind", mount.get("source")))
    if not protected:
        _fail("abrupt recovery has no protected runtime mount inventory")
    own = {backend["Id"], frontend["Id"]}
    operation = getattr(control, "_active_operation", None)
    if operation is not None:
        # Only the exact helper holding this object's current lease is exempt.
        # BuildControl revalidates its image, full command, namespace and every
        # mount. Labels alone cannot authorize another control-volume consumer.
        authenticate = getattr(control, "_pin_operation_helper", None)
        if not callable(authenticate):
            _fail("active recovery operation has no authenticated control helper")
        helper_id = authenticate(operation)
        own.add(_require_container(helper_id, "authenticated operation helper ID"))
    records = _read_foreign_docker_consumers(own)
    for item in records:
        alias_mapping = None
        alias_mapping_decided = False
        mounts = item.get("Mounts")
        if not isinstance(mounts, list):
            _fail("foreign Docker consumer has no complete mount inventory")
        for mount in mounts:
            if not isinstance(mount, Mapping):
                _fail("foreign Docker consumer mount is malformed")
            kind = mount.get("Type")
            if kind == "bind":
                source = mount.get("Source")
                if isinstance(source, str) and re.fullmatch(r"[A-Za-z]:[\\/].+", source):
                    windows_source = PureWindowsPath(source)
                    if any(kind == "bind" and isinstance(path, str)
                            and re.fullmatch(r"[A-Za-z]:[\\/].+", path)
                            and (windows_source == PureWindowsPath(path)
                                 or windows_source in PureWindowsPath(path).parents
                                 or PureWindowsPath(path) in windows_source.parents)
                            for kind, path in protected):
                        _fail("a foreign Docker container references the recovery store/control/ledger")
                    _prove_foreign_windows_bind(control, backend, item, source, compose)
                    continue
                if (not isinstance(source, str) or not source.startswith("/") or source.startswith("//")
                        or ".." in PurePosixPath(source).parts
                        or str(PurePosixPath(source)) != source):
                    _fail("foreign Docker consumer bind source is unsafe")
                raw_key = (kind, source)
            elif kind == "volume":
                name = mount.get("Name")
                if not isinstance(name, str) or not name:
                    _fail("foreign Docker consumer volume identity is unresolved")
                raw_key = (kind, name)
            elif kind == "tmpfs":
                raw_key = (kind, None)
            else:
                _fail("foreign Docker consumer mount type is unresolved")
            key = raw_key
            alias = raw_key[1] if raw_key[0] == "bind" else None
            needs_physical_proof = False
            # Preserve exact and ancestor/descendant source checks before any
            # cross-group resolver or kernel probe is allowed to run.
            raw_overlap = raw_key in protected
            if raw_key[0] == "bind":
                raw_source = PurePosixPath(raw_key[1])
                raw_overlap = raw_overlap or any(kind == "bind" and isinstance(path, str)
                    and _posix_paths_overlap(raw_source, path)
                    for kind, path in protected)
            if raw_overlap:
                _fail("a foreign Docker container references the recovery store/control/ledger")
            if (isinstance(alias, str)
                    and any(alias == prefix.rstrip("/") or alias.startswith(prefix)
                            for prefix in _DESKTOP_HOST_PREFIXES)
                    and not alias.startswith("/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/")):
                # Daemon drive aliases require the same independent native
                # Windows/DrvFs proof as literal drive paths. Their textual
                # difference from WSL storage is never isolation evidence.
                _prove_foreign_windows_bind(control, backend, item, alias, compose)
                continue
            if (isinstance(alias, str)
                    and alias.startswith("/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/")):
                # Alias hashes are not identities. A missing/denied registered
                # mapping requires an independent physical kernel proof.
                if not alias_mapping_decided:
                    try:
                        from docker_foreign_bind_identity import canonical_bind_sources
                        alias_mapping = canonical_bind_sources(item)
                    except Exception:
                        alias_mapping = None
                    alias_mapping_decided = True
                if alias_mapping is None:
                    needs_physical_proof = True
                elif not isinstance(alias_mapping, dict):
                    _fail("foreign Docker Desktop bind resolver returned a malformed mapping")
                elif alias not in alias_mapping:
                    needs_physical_proof = True
                else:
                    canonical_source = alias_mapping[alias]
                    if (not isinstance(canonical_source, str) or not canonical_source.startswith("/")
                            or ".." in PurePosixPath(canonical_source).parts
                            or str(PurePosixPath(canonical_source)) != canonical_source):
                        _fail("foreign registered bind source is not a canonical absolute path")
                    key = ("bind", canonical_source)
            if needs_physical_proof:
                callback = prove_foreign_disjoint or (
                    lambda current, current_alias: _prove_foreign_alias_for_abrupt(
                        control, backend, current, current_alias, compose))
                try:
                    proof = callback(item, alias)
                    from docker_bind_overlap_probe import validate_foreign_alias_disjoint_proof
                    validate_foreign_alias_disjoint_proof(
                        proof, alias=alias, container_id=item.get("Id"))
                except Exception as error:
                    _fail("foreign Docker Desktop bind alias has unresolved storage identity: " + str(error))
                continue
            overlap = key in protected
            if key[0] == "bind" and isinstance(key[1], str):
                source = PurePosixPath(key[1])
                overlap = overlap or any(kind == "bind" and isinstance(path, str)
                    and _posix_paths_overlap(source, path)
                    for kind, path in protected)
            if overlap:
                _fail("a foreign Docker container references the recovery store/control/ledger")


def prepare_abrupt_stop_proof(
    control, authorization_pins, compose, *,
    retained_terminal_runs=None, retained_held_manual_runs=None, retained_attempt_histories=None
):
    """Observe without writes. Publish the returned immutable JSON in a control operation.

    authorization_pins contains the twelve operator fields except schema_version,
    abrupt_stop_proof and abrupt_stop_proof_sha256. This function never creates a
    stop journal, modifies OWNER/process-tree, removes containers, or runs Solve.
    """
    pins = _abrupt_pins(authorization_pins)
    engine_sha = _docker_engine_sha()
    if retained_terminal_runs is not None:
        retained_terminal_runs = [dict(item) for item in retained_terminal_runs]
    if retained_held_manual_runs is not None:
        retained_held_manual_runs = [dict(item) for item in retained_held_manual_runs]
        if retained_terminal_runs is None:
            _fail("v4 abrupt proof requires the paired terminal pin array")
        expected_recovery_outcome({
            "schema_version": ATTEMPT_HISTORY_REQUEST_SCHEMA if retained_attempt_histories is not None else HELD_MANUAL_REQUEST_SCHEMA,
            **({"retained_attempt_histories": retained_attempt_histories} if retained_attempt_histories is not None else {}),
            "retained_terminal_runs": retained_terminal_runs,
            "retained_held_manual_runs": retained_held_manual_runs,
        })
    if retained_attempt_histories is not None and retained_held_manual_runs is None:
        _fail("v5 abrupt history proof requires the paired held-manual pin array")
    if pins["compose_project"] != control.project or compose.get("name") != control.project:
        _fail("abrupt proof belongs to another Compose project")
    if _sha256(_canonical(compose)) != pins["compose_config_sha256"]:
        _fail("abrupt retained Compose configuration digest differs")
    auth = {**pins, "schema_version": ABRUPT_OPERATOR_SCHEMA,
            "services": {service: {"container_id": pins[service + "_container_id"]} for service in ("backend", "frontend")}}
    backend, frontend = _inspect_pair(auth, control.project, compose)
    process, process_raw, process_sha = _runtime_process_receipt(control, abrupt=True)
    owner, owner_raw, owner_sha = _runtime_owner(control)
    launch, launch_raw, launch_sha = _runtime_launch(control)
    config, config_raw, config_sha = _runtime_config(control)
    _validate_process_receipt_owner(process, owner)
    _validate_owner_host(owner, backend)
    raw_records = {}
    for key, raw, sha, path in (
        ("process_receipt", process_raw, process_sha, "runtime-service/process-tree.json"),
        ("owner", owner_raw, owner_sha, "runtime-services/OWNER.json"),
        ("launch", launch_raw, launch_sha, "runtime-services/LAUNCH.json"),
        ("config", config_raw, config_sha, "runtime-service/docker-all.json")):
        if pins[key + "_sha256"] != sha:
            _fail(f"abrupt {key} bytes differ from operator pins")
        raw_records[key] = {"path": RUNTIME_CONTROL_RELATIVE + "/" + path,
                            "raw_utf8": raw.decode("utf-8"), "sha256": sha}
    _assert_no_foreign_storage_consumers(control, backend, frontend, compose)
    storage_proof = _ledger_and_store_snapshot(control, backend, compose=compose,
                                              retained_terminal_runs=retained_terminal_runs,
                                              retained_held_manual_runs=retained_held_manual_runs,
                                              retained_attempt_histories=retained_attempt_histories)
    if _docker_engine_sha() != engine_sha:
        _fail("Docker engine changed during abrupt proof preparation")
    proof = {"schema": ABRUPT_PROOF_ATTEMPT_HISTORY_SCHEMA if retained_attempt_histories is not None else (ABRUPT_PROOF_HELD_MANUAL_SCHEMA if retained_held_manual_runs is not None else ABRUPT_PROOF_SCHEMA),
             "authorization_pins": pins,
             "docker_engine_id_sha256": engine_sha, "raw_records": raw_records,
             "containers": {"backend": _stable_container_observation(backend),
                            "frontend": _stable_container_observation(frontend)},
             "network": _abrupt_network(backend, frontend, control.project),
             "storage_proof": storage_proof,
             "retained_terminal_runs": copy.deepcopy(retained_terminal_runs)}
    if retained_held_manual_runs is not None:
        proof["retained_held_manual_runs"] = copy.deepcopy(retained_held_manual_runs)
    if retained_attempt_histories is not None:
        proof["retained_attempt_histories"] = copy.deepcopy(retained_attempt_histories)
    return proof


def validate_abrupt_stop_proof(proof, authorization, *, control=None, compose=None, transition=None):
    """Validate archived originals; with control/compose also CAS current evidence.

    The caller holds the group operation lock for the destructive-boundary call.
    A prepared retry compares its manifest to the original archived observations
    and revalidates all remaining containers before any further removal.
    """
    proof_schema = proof.get("schema")
    legacy_fields = {"schema", "authorization_pins", "docker_engine_id_sha256", "raw_records", "containers", "network", "storage_proof", "retained_terminal_runs"}
    held_fields = legacy_fields | {"retained_held_manual_runs"}
    history_fields = held_fields | {"retained_attempt_histories"}
    if ((proof_schema == ABRUPT_PROOF_SCHEMA and set(proof) != legacy_fields)
            or (proof_schema == ABRUPT_PROOF_HELD_MANUAL_SCHEMA and set(proof) != held_fields)
            or (proof_schema == ABRUPT_PROOF_ATTEMPT_HISTORY_SCHEMA and set(proof) != history_fields)
            or proof_schema not in {ABRUPT_PROOF_SCHEMA, ABRUPT_PROOF_HELD_MANUAL_SCHEMA, ABRUPT_PROOF_ATTEMPT_HISTORY_SCHEMA}):
        _fail("abrupt stop proof does not match its frozen schema")
    if proof["authorization_pins"] != _abrupt_authorization_pins(authorization):
        _fail("abrupt proof operator pins differ")
    _require_sha(proof["docker_engine_id_sha256"], "abrupt engine digest")
    terminal_pins = proof["retained_terminal_runs"]
    held_pins = proof.get("retained_held_manual_runs")
    history_pins = proof.get("retained_attempt_histories")
    if proof_schema in {ABRUPT_PROOF_HELD_MANUAL_SCHEMA, ABRUPT_PROOF_ATTEMPT_HISTORY_SCHEMA}:
        if terminal_pins is None or held_pins is None:
            _fail("v2 abrupt proof must carry both v4 retained pin arrays")
        expected_recovery_outcome({
            "schema_version": ATTEMPT_HISTORY_REQUEST_SCHEMA if proof_schema == ABRUPT_PROOF_ATTEMPT_HISTORY_SCHEMA else HELD_MANUAL_REQUEST_SCHEMA,
            **({"retained_attempt_histories": history_pins} if proof_schema == ABRUPT_PROOF_ATTEMPT_HISTORY_SCHEMA else {}),
            "retained_terminal_runs": terminal_pins,
            "retained_held_manual_runs": held_pins,
        })
        storage = _require_mapping(proof.get("storage_proof"), "v4 abrupt storage proof")
        expected_records = sorted(
            [dict(pin) for pin in terminal_pins + held_pins],
            key=lambda item: item["run_id"],
        )
        if history_pins is not None and storage.get("retained_attempt_histories") != history_pins:
            _fail("v5 abrupt storage proof does not match historical evidence pins")
        if storage.get("run_records") != expected_records:
            _fail("v4 abrupt storage proof does not cover both retained pin arrays")
    elif terminal_pins is not None:
        expected_recovery_outcome({"schema_version": TERMINAL_REQUEST_SCHEMA, "retained_terminal_runs": terminal_pins})
    records = _require_mapping(proof["raw_records"], "abrupt raw records")
    if set(records) != {"process_receipt", "owner", "launch", "config"}:
        _fail("abrupt raw record inventory differs")
    expected_paths = {"process_receipt": "runtime-service/process-tree.json", "owner": "runtime-services/OWNER.json", "launch": "runtime-services/LAUNCH.json", "config": "runtime-service/docker-all.json"}
    decoded = {}
    for key, item in records.items():
        if not isinstance(item, Mapping) or set(item) != {"path", "raw_utf8", "sha256"} or not isinstance(item["raw_utf8"], str):
            _fail("abrupt original record has an invalid shape")
        raw = item["raw_utf8"].encode("utf-8")
        if item["path"] != RUNTIME_CONTROL_RELATIVE + "/" + expected_paths[key] or _sha256(raw) != authorization[key + "_sha256"] or item["sha256"] != _sha256(raw):
            _fail("abrupt original record bytes or path differ")
        decoded[key] = _parse_json(raw, "abrupt original " + key)
        if control is not None and _control_bytes(control, item["path"]) != raw:
            _fail("abrupt raw proof is stale: " + key)
    process = decoded["process_receipt"]
    if process.get("schema") != "fullmag.docker-process-tree.v1" or process.get("state") not in {"ready", "shutdown_unknown"} or "startup_activation" in process:
        _fail("abrupt archived process state is unsupported")
    owner = _owner_for_native(decoded["owner"])
    _validate_process_receipt_owner(process, owner)
    containers = _require_mapping(proof["containers"], "abrupt archived containers")
    if set(containers) != {"backend", "frontend"}:
        _fail("abrupt archived service inventory differs")
    for service, item in containers.items():
        _strict_stopped(item)
        pin = _container_pin(item, service, authorization["compose_project"])
        if pin["container_id"] != authorization[service + "_container_id"] or pin["image_id"] != authorization["old_image_id"]:
            _fail("abrupt archived container differs from authorization")
    containers = {service: _stable_container_observation(item) for service, item in containers.items()}
    _validate_owner_host(owner, containers["backend"])
    if control is not None:
        if _docker_engine_sha() != proof["docker_engine_id_sha256"]:
            _fail("abrupt Docker engine changed")
        if transition is None:
            current = _inspect_pair(authorization, control.project, compose)
            if {"backend": _stable_container_observation(current[0]),
                    "frontend": _stable_container_observation(current[1])} != containers:
                _fail("abrupt Docker observations changed")
            if _abrupt_network(*current, control.project) != proof["network"]:
                _fail("abrupt private network observations changed")
        else:
            if {service: _stable_container_observation(transition[service])
                    for service in ("backend", "frontend")} != containers:
                _fail("prepared retry differs from original abrupt observations")
            for service, item in transition["present"].items():
                _strict_stopped(item)
                if _stable_container_observation(item) != containers[service]:
                    _fail("prepared retry Docker observations changed")
            # Old containers may now be absent; network can only be absent or
            # the exact owned bridge without consumers other than the old pair.
            _abrupt_network(containers["backend"], containers["frontend"], control.project)
        _assert_no_foreign_storage_consumers(control, containers["backend"], containers["frontend"], compose)
        observed = _ledger_and_store_snapshot(
            control, containers["backend"], compose=compose,
            retained_terminal_runs=terminal_pins,
            retained_held_manual_runs=held_pins,
            retained_attempt_histories=history_pins,
        )
        if observed != proof["storage_proof"]:
            _fail("abrupt store/ledger snapshot changed")
    return proof


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
        if _is_abrupt(authorization):
            _strict_stopped(item)
        result[service] = item
    actual = {"backend": result["backend"], "frontend": result["frontend"]}
    try:
        if _is_abrupt(authorization):
            _abrupt_network(actual["backend"], actual["frontend"], project)
        else:
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
    network_name: str, old_container_ids: Sequence[str], project: str, *, abrupt: bool = False
) -> str:
    """Prove that removing the pinned pair did not leave another consumer."""

    def absent_from_inventory():
        result = docker_capture("network", "ls", "--no-trunc", "--format", "{{json .}}", timeout=60)
        try:
            rows = [json.loads(line) for line in result.stdout.decode().splitlines() if line.strip()]
        except (UnicodeDecodeError, ValueError) as error:
            _fail(f"post-removal network inventory is invalid: {error}")
        if any(not isinstance(row, dict) or not isinstance(row.get("Name"), str) or not isinstance(row.get("ID"), str) for row in rows):
            _fail("post-removal network inventory identities are missing")
        return all(row["Name"] != network_name for row in rows)
    absent_before = absent_from_inventory() if abrupt else None
    observed = docker_capture("network", "inspect", network_name, allow_failure=True, timeout=60)
    if observed.returncode:
        from docker_stopped_network import authoritative_network_not_found
        if authoritative_network_not_found(observed, network_name):
            if abrupt and (not absent_before or not absent_from_inventory()):
                _fail("post-removal network absence conflicts with Docker inventory")
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
    if _is_abrupt(authorization):
        proof, proof_raw = _control_json(control, authorization["stop_journal_path"])
        if proof is None or proof_raw is None or _sha256(proof_raw) != authorization["stop_journal_sha256"]:
            _fail("prepared abrupt proof bytes changed")
        validate_abrupt_stop_proof(proof, authorization)
        _assert_request_matches_abrupt_retained_pins(request, proof)
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
        if _is_abrupt(authorization):
            _strict_stopped(current)
        present[service] = current

    if absence is not None:
        absence_network = _require_text(absence.get("network_name"), "recovery transition network name", 255)
        if absence_network != network_name:
            _fail("recovery transition network name changed")
        for identifier in old_ids:
            _assert_container_absent(identifier)
        network_state = _verify_network_after_removal(network_name, old_ids, project, abrupt=_is_abrupt(authorization))
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
    if _is_abrupt(authorization):
        validate_abrupt_stop_proof(journal, authorization)
    else:
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
    process_receipt, _, process_receipt_sha = _runtime_process_receipt(control, abrupt=_is_abrupt(authorization))
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
    terminal_pins = journal.get("retained_terminal_runs") if _is_abrupt(authorization) else None
    held_pins = journal.get("retained_held_manual_runs") if _is_abrupt(authorization) else None
    history_pins = journal.get("retained_attempt_histories") if _is_abrupt(authorization) else None
    if _is_abrupt(authorization):
        validate_abrupt_stop_proof(journal, authorization, control=control, compose=current_compose, transition=current_transition)
    storage_proof = _ledger_and_store_snapshot(
        control, pinned_backend, compose=compose,
        retained_terminal_runs=terminal_pins,
        retained_held_manual_runs=held_pins,
        retained_attempt_histories=history_pins,
    )
    for key in (set(storage_proof) | set(expected_storage)):
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
    previous = _control_bytes(control, relative, optional=True)
    if previous is not None and previous != raw:
        _fail("recovery history already contains different bytes: " + relative)
    if previous is None:
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
        "prior_stop_journal_sha256": operator["stop_journal_sha256"],
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
    if _is_abrupt(authorization):
        validate_abrupt_stop_proof(journal, authorization)
    else:
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
    process_receipt, process_receipt_raw, process_receipt_sha = _runtime_process_receipt(control, abrupt=_is_abrupt(authorization))
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
    terminal_pins = journal.get("retained_terminal_runs") if _is_abrupt(authorization) else None
    held_pins = journal.get("retained_held_manual_runs") if _is_abrupt(authorization) else None
    history_pins = journal.get("retained_attempt_histories") if _is_abrupt(authorization) else None
    if _is_abrupt(authorization):
        validate_abrupt_stop_proof(journal, authorization, control=control, compose=compose, transition=transition)
    storage_proof = _ledger_and_store_snapshot(
        control, backend, compose=compose,
        retained_terminal_runs=terminal_pins,
        retained_held_manual_runs=held_pins,
        retained_attempt_histories=history_pins,
    )
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
        # Recovery keeps the ledger of the stopped backend; its storage proof
        # was taken from that ledger. A later normal start may switch it.
        import docker_group_ledger as group_ledger
        operation["receipt"]["ledger_profile"] = (
            group_ledger.PROFILE
            if group_ledger.is_group_ledger_backend(
                compose.get("services", {}).get("backend", {}).get("environment", {}))
            else "host-ledger-v1")
        if _control_bytes(control, authorization_reference) != authorization_raw:
            _fail("operator authorization changed before the destructive boundary")
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
                retained_terminal_runs=terminal_pins,
                retained_held_manual_runs=held_pins,
                retained_attempt_histories=history_pins,
            )
            request_raw = _canonical(request)
            request_sha = _sha256(request_raw)
            request_relative = transition_root + "/request.json"
            _write_record(control, request_relative, request)
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
                abrupt=_is_abrupt(authorization),
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
    "ABRUPT_OPERATOR_SCHEMA",
    "ABRUPT_PROOF_SCHEMA",
    "TERMINAL_REQUEST_SCHEMA",
    "prepare_abrupt_stop_proof",
    "validate_abrupt_stop_proof",
    "REQUEST_SCHEMA",
    "ContainerRecoveryError",
    "validate_authorization",
    "validate_operator_authorization",
    "validate_runtime_authorization",
    "validate_request",
    "validate_attestation",
    "recover",
]
