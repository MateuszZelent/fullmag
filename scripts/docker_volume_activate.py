#!/usr/bin/env python3
"""Activate one Python study in an already running volume DEV workspace.

This is deliberately an activation operation, not a Compose operation.  The
host validates the exact retained attempt and writes only bounded provenance to
the group's control volume.  A fixed image-owned wrapper in the existing
backend then calls ``docker_startup_script.run_from_environment``.  The live
API remains the authority for the empty-workspace/current-request fence.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from collections.abc import Mapping
from pathlib import Path, PurePath, PurePosixPath
import re
import shlex
import sys
import time
import uuid

import fullmag_storage as storage
from docker_build_control import (
    BuildControl,
    BuildControlError,
    ControlOutcomeUnknown,
    bounded_capture,
    canonical,
    compose_capture,
    control_read_script,
    docker_capture,
    toolchain_configuration,
)


ATTEMPT_RE = re.compile(r"^[0-9a-f]{32}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CONTROL_ROOT = "/opt/fullmag/control"
ACTIVATE_EXIT_UNKNOWN = 75
OPERATION_SCHEMA = "fullmag.docker-build-operation.v1"
RETIREMENT_CAS_PAYLOAD_BYTES = 32 * 1024
RETIREMENT_REFUSAL_SCHEMA = "fullmag.live-retirement-refusal.v1"
RETIREMENT_REFUSAL_CODES = frozenset({
    "preflight_failed",
    "live_retirement_invalid_request",
    "live_retirement_current_mismatch",
    "live_retirement_runtime_not_terminal",
    "live_retirement_busy",
    "live_retirement_capture_failed",
})
RETIREMENT_REFUSAL_EXIT = 78

# This is an image-owned, constant wrapper.  User input is supplied only via
# the bounded environment below; the script path, provenance path and helper
# digest are never interpolated into Python source or a shell command.  Keep
# the helper attestation here because this route deliberately does not rebuild
# or modify the running image's entrypoint.
FIXED_ACTIVATION_SCRIPT = r'''import hashlib, importlib.util, json, os, stat, sys
from pathlib import Path

helper_path = Path("/opt/fullmag/docker_startup_script.py")
expected = os.environ.get("FULLMAG_STARTUP_HELPER_SHA256", "")
if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected):
    raise RuntimeError("startup helper hash is missing or invalid")
descriptor = os.open(helper_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
try:
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1024 * 1024:
        raise RuntimeError("startup helper is not a bounded regular file")
    checksum = hashlib.sha256()
    for block in iter(lambda: os.read(descriptor, 64 * 1024), b""):
        checksum.update(block)
finally:
    os.close(descriptor)
if checksum.hexdigest() != expected:
    raise RuntimeError("startup helper differs from the image-attested bytes")
if "/opt/fullmag" not in sys.path:
    sys.path.insert(0, "/opt/fullmag")
spec = importlib.util.spec_from_file_location("fullmag_image_docker_startup_script", helper_path)
if spec is None or spec.loader is None:
    raise RuntimeError("startup helper cannot be loaded from the image")
helper = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = helper
spec.loader.exec_module(helper)
receipt_key = os.environ.get("FULLMAG_STARTUP_RECEIPT_KEY")
if receipt_key is not None:
    if len(receipt_key) != 64 or any(character not in "0123456789abcdef" for character in receipt_key):
        raise RuntimeError("startup receipt key is missing or invalid")
    path_for_key = getattr(helper, "activation_receipt_path_for_key", None)
    if not callable(path_for_key):
        raise RuntimeError("startup helper has no managed receipt-path contract")
    helper.ACTIVATION_RECEIPT_PATH = path_for_key(receipt_key)
retirement = None
retirement_operation_id = os.environ.get("FULLMAG_RETIREMENT_OPERATION_ID")
retirement_only = os.environ.get("FULLMAG_RETIREMENT_ONLY") == "1"
retirement_require_existing_intent = os.environ.get(
    "FULLMAG_RETIREMENT_REQUIRE_EXISTING_INTENT"
) == "1"
if retirement_require_existing_intent and not retirement_only:
    raise RuntimeError("existing retirement intent requires retirement-only mode")
retirement_inputs_sha256 = os.environ.get("FULLMAG_RETIREMENT_INPUTS_SHA256")
if retirement_operation_id is not None:
    if (not isinstance(retirement_inputs_sha256, str)
            or len(retirement_inputs_sha256) != 64
            or any(character not in "0123456789abcdef" for character in retirement_inputs_sha256)):
        raise RuntimeError("managed retirement inputs digest is missing or invalid")
retirement_identity = None
retirement_session_id = os.environ.get("FULLMAG_RETIREMENT_SESSION_ID")
retirement_run_id = os.environ.get("FULLMAG_RETIREMENT_RUN_ID")
if (retirement_session_id is None) != (retirement_run_id is None):
    raise RuntimeError("managed retirement identity is incomplete")
if retirement_session_id is not None:
    if not retirement_session_id.strip() or not retirement_run_id.strip():
        raise RuntimeError("managed retirement identity is empty")
    retirement_identity = {
        "session_id": retirement_session_id,
        "run_id": retirement_run_id,
    }
retirement_predecessor = None
predecessor_sha256 = os.environ.get("FULLMAG_RETIREMENT_PREDECESSOR_SHA256")
predecessor_scope = os.environ.get("FULLMAG_RETIREMENT_PREDECESSOR_SCOPE")
if (predecessor_sha256 is None) != (predecessor_scope is None):
    raise RuntimeError("managed retirement predecessor is incomplete")
if predecessor_sha256 is not None:
    if (len(predecessor_sha256) != 64
            or any(character not in "0123456789abcdef" for character in predecessor_sha256)
            or not isinstance(predecessor_scope, str)
            or not predecessor_scope.strip()
            or ":" not in predecessor_scope):
        raise RuntimeError("managed retirement predecessor is invalid")
    retirement_predecessor = {
        "proof_sha256": predecessor_sha256,
        "request_scope_epoch": predecessor_scope,
    }
if retirement_operation_id:
    try:
        retirement_arguments = {
            "operation_inputs_sha256": retirement_inputs_sha256,
            "api_base": os.environ.get("FULLMAG_STARTUP_API", "http://127.0.0.1:8081"),
            "predecessor": retirement_predecessor,
            "retained_identity": retirement_identity,
        }
        if retirement_require_existing_intent:
            retirement_arguments["require_existing_intent"] = True
        retirement = helper.retire_current_workspace(
            retirement_operation_id,
            **retirement_arguments,
        )
    except Exception as error:
        refusal_type = getattr(helper, "RetirementRefused", None)
        refusal = getattr(error, "diagnostic", None)
        refusal_codes = {
            "preflight_failed",
            "live_retirement_invalid_request",
            "live_retirement_current_mismatch",
            "live_retirement_runtime_not_terminal",
            "live_retirement_busy",
            "live_retirement_capture_failed",
        }
        if (
            retirement_only
            and isinstance(refusal_type, type)
            and isinstance(error, refusal_type)
            and isinstance(refusal, dict)
            and refusal.get("schema") == "fullmag.live-retirement-refusal.v1"
            and refusal.get("state") == "refused"
            and refusal.get("operation_id") == retirement_operation_id
            and refusal.get("code") in refusal_codes
        ):
            if retirement_require_existing_intent:
                evidence_reader = getattr(helper, "retirement_receipt_evidence", None)
                if not callable(evidence_reader):
                    raise RuntimeError("startup helper has no retirement evidence contract")
                evidence = evidence_reader(retirement_operation_id, retirement_inputs_sha256)
                if (not isinstance(evidence, dict)
                        or evidence.get("state") != "rejected"
                        or evidence.get("operation_id") != retirement_operation_id):
                    raise RuntimeError("retirement refusal has no image-owned rejected intent")
                refusal["retirement"] = evidence
            print(json.dumps(refusal, sort_keys=True), flush=True)
            raise SystemExit(78)
        unknown_type = getattr(helper, "RetirementOutcomeUnknown", None)
        diagnostic = getattr(error, "diagnostic", None)
        if (isinstance(unknown_type, type) and isinstance(error, unknown_type)
                and isinstance(diagnostic, dict)
                and diagnostic.get("schema") == "fullmag.live-retirement-diagnostic.v1"
                and diagnostic.get("state") == "unknown"
                and isinstance(diagnostic.get("operation_id"), str)
                and isinstance(diagnostic.get("phase"), str)
                and isinstance(diagnostic.get("error"), str)):
            if "retirement" not in diagnostic and retirement_operation_id is not None:
                evidence_reader = getattr(helper, "retirement_receipt_evidence", None)
                if not callable(evidence_reader):
                    raise RuntimeError("startup helper has no retirement evidence contract")
                evidence = evidence_reader(retirement_operation_id, retirement_inputs_sha256)
                if isinstance(evidence, dict):
                    diagnostic["retirement"] = evidence
            print(json.dumps(diagnostic, sort_keys=True), flush=True)
            raise SystemExit(75)
        startup_error_type = getattr(helper, "StartupScriptError", None)
        if retirement_only and isinstance(startup_error_type, type) and isinstance(error, startup_error_type):
            evidence_reader = getattr(helper, "retirement_receipt_evidence", None)
            if not callable(evidence_reader):
                raise
            try:
                evidence = evidence_reader(retirement_operation_id, retirement_inputs_sha256)
            except Exception:
                # A failed evidence read cannot authenticate the operation;
                # preserve the original nonterminal outcome as raw unknown.
                raise
            valid_evidence = (
                isinstance(evidence, dict)
                and evidence.get("operation_id") == retirement_operation_id
                and evidence.get("state") in {"pending", "retired", "replayed"}
                and isinstance(evidence.get("session_id"), str)
                and bool(evidence.get("session_id", "").strip())
                and isinstance(evidence.get("run_id"), str)
                and bool(evidence.get("run_id", "").strip())
                and isinstance(evidence.get("request_scope_epoch"), str)
                and ":" in evidence.get("request_scope_epoch", "")
                and isinstance(evidence.get("api_request_scope_epoch"), str)
                and ":" in evidence.get("api_request_scope_epoch", "")
                and isinstance(evidence.get("marker_sha256"), str)
                and len(evidence["marker_sha256"]) == 64
                and all(character in "0123456789abcdef" for character in evidence["marker_sha256"])
            )
            if valid_evidence and evidence.get("state") in {"retired", "replayed"}:
                archive = evidence.get("archive_sha256")
                valid_evidence = (
                    isinstance(archive, str)
                    and len(archive) == 64
                    and all(character in "0123456789abcdef" for character in archive)
                )
            if valid_evidence:
                diagnostic = {
                    "schema": "fullmag.live-retirement-diagnostic.v1",
                    "state": "unknown",
                    "operation_id": retirement_operation_id,
                    "phase": "retirement",
                    "error": str(error)[-4096:],
                    "retirement": dict(evidence),
                }
                print(json.dumps(diagnostic, sort_keys=True), flush=True)
                raise SystemExit(75)
        raise
if retirement_only:
    if retirement_operation_id is None:
        raise RuntimeError("managed retirement-only activation has no operation id")
    result = {"state": "retirement-only", "retirement": retirement}
else:
    try:
        result = helper.run_from_environment()
    except Exception as error:
        unknown_type = getattr(helper, "StartupActivationOutcomeUnknown", None)
        diagnostic = getattr(error, "diagnostic", None)
        if (isinstance(unknown_type, type) and isinstance(error, unknown_type)
                and isinstance(diagnostic, dict)
                and diagnostic.get("schema") == "fullmag.startup-activation-diagnostic.v1"
                and diagnostic.get("state") == "unknown"
                and diagnostic.get("durable_state") == "started"
                and isinstance(diagnostic.get("request_id"), str)
                and isinstance(diagnostic.get("source_sha256"), str)
                and isinstance(diagnostic.get("source_relative"), str)
                and isinstance(diagnostic.get("error"), str)):
            print(json.dumps(diagnostic, sort_keys=True), flush=True)
            raise SystemExit(75)
        raise
if result is None:
    result = {"state": "noop"}
if not isinstance(result, dict) or not isinstance(result.get("state"), str):
    raise RuntimeError("startup activation helper returned no state")
if retirement is not None:
    result["retirement"] = retirement
print(json.dumps(result, sort_keys=True), flush=True)
'''


def _docker_text(*args: str, timeout: int = 90, combined: bool = False) -> str:
    result = docker_capture(*args, timeout=timeout)
    payload = result.stdout
    if combined:
        payload += result.stderr
    return payload.decode("utf-8", "replace")


def _helper_error_type(startup_helper):
    error_type = getattr(startup_helper, "StartupScriptError", None)
    if not isinstance(error_type, type) or not issubclass(error_type, Exception):
        raise BuildControlError("Selected startup helper has no valid error contract")
    return error_type


def _request_id(startup_helper, attempt: str, source_sha256: str, explicit: str | None) -> str:
    if explicit is not None:
        try:
            return startup_helper._validate_request_id(explicit)
        except _helper_error_type(startup_helper) as error:
            raise BuildControlError(str(error)) from error
    return "docker-volume-" + uuid.uuid4().hex


def _authorization_bytes(startup_helper, authorization: Mapping[str, object]) -> bytes:
    try:
        payload = startup_helper._json_payload(
            authorization,
            startup_helper.MAX_PROVENANCE_BYTES,
            "startup provenance",
        )
    except (TypeError, ValueError) as error:
        raise BuildControlError(str(error)) from error
    except _helper_error_type(startup_helper) as error:
        raise BuildControlError(str(error)) from error
    return payload


def _posix_container_path(value: object, *, label: str) -> str:
    """Render an image path with POSIX separators and reject host paths."""
    if not isinstance(value, (str, PurePath)):
        raise BuildControlError(f"{label} is not a valid path object")
    try:
        path = value if isinstance(value, PurePath) else PurePath(value)
        rendered = path.as_posix()
    except (OSError, TypeError, ValueError) as error:
        raise BuildControlError(f"{label} is not a valid path") from error
    if (
        not rendered.startswith("/")
        or rendered.startswith("//")
        or "\x00" in rendered
        or len(rendered) > 1024
        or any(part == ".." for part in PurePosixPath(rendered).parts)
    ):
        raise BuildControlError(f"{label} is not a valid POSIX container path")
    return rendered


def _activation_contract(startup_helper) -> tuple[float, str]:
    timeout = getattr(startup_helper, "STARTUP_ACTIVATION_TIMEOUT_SECONDS", None)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= 3600:
        raise BuildControlError("Selected startup helper has an invalid activation timeout")
    marker = getattr(startup_helper, "ACTIVATION_RECEIPT_PATH", None)
    if not isinstance(marker, (str, PurePath)):
        raise BuildControlError("Selected startup helper has no activation receipt path")
    marker = _posix_container_path(marker, label="Selected startup helper activation receipt path")
    return float(timeout) + 60, marker


def _managed_activation_receipt_contract(startup_helper, request_id: str) -> tuple[str, str]:
    key = hashlib.sha256(request_id.encode("utf-8")).hexdigest()
    path_for_key = getattr(startup_helper, "activation_receipt_path_for_key", None)
    if not callable(path_for_key):
        raise BuildControlError("Selected startup helper has no managed receipt-path contract")
    try:
        candidate = path_for_key(key)
    except Exception as error:
        raise BuildControlError(f"Selected startup helper rejected the receipt key: {error}") from error
    rendered = _posix_container_path(candidate, label="Selected startup helper receipt path")
    expected = "/opt/fullmag/control/backend/script-activation-" + key + "/activation.json"
    if rendered != expected:
        raise BuildControlError("Selected startup helper receipt path differs from the managed namespace")
    return key, rendered


def _one_container(document: Mapping[str, object], service: str) -> str:
    raw = compose_capture(document, "ps", "--all", "--quiet", service).decode()
    identifiers = [line.strip() for line in raw.splitlines() if line.strip()]
    if len(identifiers) != 1 or not re.fullmatch(r"[0-9a-f]{64}", identifiers[0]):
        raise BuildControlError(f"Retained Compose service identity is ambiguous: {service}")
    return identifiers[0]


def _canonical_host_path(value: object) -> str:
    """Normalize the two host-side spellings used by Compose and Docker."""
    if not isinstance(value, str) or not value.strip():
        return ""
    normalized = value.strip().replace("\\", "/")
    for prefix in ("/host_mnt/", "/run/desktop/mnt/host/"):
        if normalized.casefold().startswith(prefix) and len(normalized) > len(prefix):
            drive = normalized[len(prefix)]
            if drive.isalpha() and normalized[len(prefix) + 1 : len(prefix) + 2] == "/":
                normalized = drive.upper() + ":" + normalized[len(prefix) + 1 :]
                break
    return os.path.normcase(os.path.normpath(normalized)).replace("\\", "/")


def _same_host_path(left: object, right: object) -> bool:
    left_key = _canonical_host_path(left)
    right_key = _canonical_host_path(right)
    return bool(left_key and right_key and left_key == right_key)


def _validate_running_group(
    control: BuildControl,
    identity: Mapping[str, str],
    document: Mapping[str, object],
    terminal: Mapping[str, object],
    image: str,
    *,
    source_root: str | None = None,
    require_healthy: bool = True,
) -> tuple[str, str]:
    if not isinstance(document, Mapping):
        raise BuildControlError("Retained Compose configuration is not an object")
    if not isinstance(terminal, Mapping):
        raise BuildControlError("Retained runtime terminal is not an object")
    if document.get("name") != control.project:
        raise BuildControlError("Retained Compose project differs from the selected group")
    if not IMAGE_ID_RE.fullmatch(image):
        raise BuildControlError("Retained backend image is not immutable")
    from docker_volume_dev import _validate_retained_service

    services = document.get("services")
    if not isinstance(services, Mapping):
        raise BuildControlError("Retained Compose services are not an object")
    ids: dict[str, str] = {}
    for service in ("backend", "frontend"):
        service_document = services.get(service)
        if not isinstance(service_document, Mapping):
            raise BuildControlError(f"Retained {service} service configuration is not an object")
        service_image = service_document.get("image")
        if not isinstance(service_image, str) or not IMAGE_ID_RE.fullmatch(service_image):
            raise BuildControlError(f"Retained {service} image is not immutable")
        if service == "backend" and service_image != image:
            raise BuildControlError("Retained backend image differs from the terminal receipt")
        image_documents = json.loads(_docker_text("image", "inspect", service_image))
        if len(image_documents) != 1:
            raise BuildControlError(f"Retained {service} image identity is ambiguous")
        image_config = image_documents[0].get("Config")
        if not isinstance(image_config, dict):
            raise BuildControlError(f"Retained {service} image configuration is missing")
        identifier = _one_container(document, service)
        records = json.loads(_docker_text("inspect", identifier))
        if len(records) != 1:
            raise BuildControlError(f"Retained {service} identity is ambiguous")
        observed = records[0]
        labels = observed.get("Config", {}).get("Labels", {})
        if (
            observed.get("Image") != service_image
            or labels.get("com.docker.compose.project") != control.project
            or labels.get("com.docker.compose.service") != service
            or labels.get("org.fullmag.source.worktree-id") != identity["worktree_id"]
        ):
            raise BuildControlError(f"Retained {service} ownership differs")
        recorded = terminal.get(service + "_container")
        if recorded is not None and recorded != observed.get("Id"):
            raise BuildControlError(f"Retained {service} incarnation differs")
        _validate_retained_service(document, observed, service, image_config)
        if not observed.get("State", {}).get("Running"):
            raise BuildControlError(f"Retained {service} is not running")
        ids[service] = identifier

    backend_document = services.get("backend")
    if not isinstance(backend_document, Mapping):
        raise BuildControlError("Retained backend service configuration is not an object")
    backend_mounts = backend_document.get("volumes", [])
    if not isinstance(backend_mounts, list) or any(
        not isinstance(mount, Mapping) for mount in backend_mounts
    ):
        raise BuildControlError("Retained backend volume declarations are not objects")
    source_mount = next(
        (mount for mount in backend_mounts if mount.get("target") == "/opt/fullmag/source"),
        None,
    )
    if not isinstance(source_mount, Mapping) or source_mount.get("type") != "bind" or not source_mount.get("read_only"):
        raise BuildControlError("Retained backend source is not a readonly bind")
    environment = backend_document.get("environment", {})
    if not isinstance(environment, Mapping):
        raise BuildControlError("Retained backend source identity is missing")
    if environment.get("FULLMAG_SESSION_STORAGE_PROFILE") not in {"windows-folder-v1", "linux-native-v1"}:
        raise BuildControlError("Retained backend has no supported explicit storage profile")
    source_identity = environment.get("FULLMAG_SOURCE_HOST_ROOT")
    if not isinstance(source_identity, str) or not source_identity.strip():
        raise BuildControlError("Retained backend source identity is missing")
    # Compare selected/client paths here. Daemon namespace aliases are pinned
    # separately in x-fullmag-daemon-binds by _validate_retained_service above.
    if not _same_host_path(source_mount.get("source"), source_identity):
        raise BuildControlError("Retained backend source identity differs from its readonly bind")
    if source_root is not None and not _same_host_path(source_identity, source_root):
        raise BuildControlError("Retained backend source differs from the selected source")
    if require_healthy and (
        json.loads(_docker_text("inspect", ids["backend"]))[0]
        .get("State", {})
        .get("Health", {})
        .get("Status")
        != "healthy"
    ):
        raise BuildControlError("Retained backend is not healthy")
    return ids["backend"], ids["frontend"]


def _validate_linked_runtime_terminal(
    terminal: Mapping[str, object],
    *,
    phase: str,
    original_attempt: str,
    original: Mapping[str, object],
    source_root: str,
    image: str,
    config_sha256: str,
) -> None:
    if not isinstance(terminal, Mapping):
        raise BuildControlError("Linked runtime terminal is not an object")
    if not isinstance(original, Mapping):
        raise BuildControlError("Original runtime terminal is not an object")
    if terminal.get("phase") != phase or terminal.get("state") != "succeeded":
        raise BuildControlError("Linked runtime terminal is not a succeeded " + phase)
    if terminal.get("compose_project") != original.get("compose_project"):
        raise BuildControlError("Linked runtime terminal belongs to another Compose group")
    linked_attempt = terminal.get("attempt")
    if (
        not isinstance(linked_attempt, str)
        or not ATTEMPT_RE.fullmatch(linked_attempt)
        or linked_attempt == original_attempt
    ):
        raise BuildControlError("Linked runtime terminal has an invalid attempt identity")
    if terminal.get("config_sha256") != config_sha256:
        raise BuildControlError("Linked runtime terminal/config pin differs")
    inputs = terminal.get("inputs")
    if not isinstance(inputs, Mapping):
        raise BuildControlError("Linked runtime terminal inputs are missing")
    if inputs.get("attempt") != original_attempt:
        raise BuildControlError("Linked runtime terminal is not linked to the retained attempt")
    if inputs.get("config_sha256") != config_sha256:
        raise BuildControlError("Linked runtime terminal input/config pin differs")
    if "source_root" in inputs and inputs["source_root"] != source_root:
        raise BuildControlError("Linked runtime terminal source selection differs")
    if "image_id" in inputs and inputs["image_id"] != image:
        raise BuildControlError("Linked runtime terminal image differs")

    for key in ("backend_container", "frontend_container"):
        value = terminal.get(key)
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
            raise BuildControlError("Linked runtime terminal has an invalid " + key)

    source_fields = {
        "source_commit": re.compile(r"^[0-9a-f]{40}$"),
        "source_digest": SHA256_RE,
        "source_snapshot_sha256": SHA256_RE,
        "backend_build_receipt_sha256": SHA256_RE,
    }
    for key, pattern in source_fields.items():
        value = terminal.get(key)
        if not isinstance(value, str) or not pattern.fullmatch(value):
            raise BuildControlError("Linked runtime terminal has an invalid " + key)
        if key in original and value != original.get(key):
            raise BuildControlError("Linked runtime terminal " + key + " differs")

    for key in ("state_root", "backend_volumes", "frontend_volume"):
        if key in original and terminal.get(key) != original.get(key):
            raise BuildControlError("Linked runtime terminal " + key + " differs")


def _linked_runtime_terminals(
    control: BuildControl,
    original_attempt: str,
    original: Mapping[str, object],
    *,
    source_root: str,
    image: str,
    config_sha256: str,
) -> list[Mapping[str, object]]:
    if not isinstance(original, Mapping):
        raise BuildControlError("Original DEV terminal is not an object")
    state = original.get("state")
    if state == "succeeded":
        return [original]
    if state != "failed-confirmed":
        raise BuildControlError("Script activation requires a successful retained DEV start or linked recovery")
    linked: list[Mapping[str, object]] = []
    for phase in ("resume", "iteration"):
        verified = control.read(phase + "/verified.json", optional=True)
        if verified is None:
            continue
        if not isinstance(verified, Mapping):
            raise BuildControlError("Linked " + phase + " verification is not an object")
        if verified.get("phase") != phase or verified.get("state") != "succeeded":
            raise BuildControlError("Linked " + phase + " verification is not terminal success")
        verified_inputs = verified.get("inputs")
        if not isinstance(verified_inputs, Mapping):
            raise BuildControlError("Linked " + phase + " verification inputs are missing")
        if verified_inputs.get("attempt") != original_attempt:
            continue
        if verified.get("config_sha256") != config_sha256:
            raise BuildControlError("Linked " + phase + " verification/config pin differs")
        if verified_inputs.get("config_sha256") != config_sha256:
            raise BuildControlError("Linked " + phase + " input/config pin differs")
        linked_attempt = verified.get("attempt")
        if not isinstance(linked_attempt, str) or not ATTEMPT_RE.fullmatch(linked_attempt):
            raise BuildControlError("Linked " + phase + " verification attempt is invalid")
        terminal = control.read(
            phase + "/attempts/" + linked_attempt + "/terminal.json"
        )
        if not isinstance(terminal, Mapping):
            raise BuildControlError("Linked " + phase + " terminal is not an object")
        if canonical(terminal) != canonical(verified):
            raise BuildControlError("Linked " + phase + " terminal differs from verified receipt")
        _validate_linked_runtime_terminal(
            terminal,
            phase=phase,
            original_attempt=original_attempt,
            original=original,
            source_root=source_root,
            image=image,
            config_sha256=config_sha256,
        )
        linked.append(terminal)
    if not linked:
        raise BuildControlError("No succeeded resume or iteration is linked to the retained DEV attempt")
    return linked


def _json_result(output: bytes) -> dict[str, object] | None:
    for line in reversed(output.decode("utf-8", "replace").splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and isinstance(value.get("state"), str):
            return value
    return None


def _run_fixed_activation(
    backend_id: str,
    *,
    script_path: str | None,
    provenance_path: str | None,
    provenance_sha256: str | None,
    helper_sha256: str,
    activation_timeout_seconds: float,
    activation_receipt_path: str | None = None,
    activation_receipt_key: str | None = None,
    retirement_operation_id: str | None = None,
    retirement_inputs_sha256: str | None = None,
    retirement_predecessor: Mapping[str, str] | None = None,
    retirement_identity: Mapping[str, str] | None = None,
    retirement_require_existing_intent: bool = False,
    retirement_only: bool = False,
) -> dict[str, object]:
    if retirement_require_existing_intent and not retirement_only:
        raise BuildControlError("Existing retirement intent requires retirement-only activation")
    if retirement_only:
        if (retirement_operation_id is None
                or not ATTEMPT_RE.fullmatch(retirement_operation_id)
                or not isinstance(retirement_inputs_sha256, str)
                or SHA256_RE.fullmatch(retirement_inputs_sha256) is None):
            raise BuildControlError("Managed retirement-only activation is incomplete")
        if retirement_predecessor is not None:
            if not isinstance(retirement_predecessor, Mapping):
                raise BuildControlError("Managed retirement predecessor is not an object")
            if set(retirement_predecessor) != {"proof_sha256", "request_scope_epoch"}:
                raise BuildControlError("Managed retirement predecessor fields are invalid")
            if (not isinstance(retirement_predecessor.get("proof_sha256"), str)
                    or SHA256_RE.fullmatch(retirement_predecessor["proof_sha256"]) is None
                    or not isinstance(retirement_predecessor.get("request_scope_epoch"), str)
                    or not retirement_predecessor["request_scope_epoch"].strip()
                    or ":" not in retirement_predecessor["request_scope_epoch"]):
                raise BuildControlError("Managed retirement predecessor is invalid")
        if retirement_identity is not None:
            if (
                not isinstance(retirement_identity, Mapping)
                or set(retirement_identity) != {"session_id", "run_id"}
                or any(
                    not isinstance(retirement_identity.get(field), str)
                    or not str(retirement_identity[field]).strip()
                    for field in ("session_id", "run_id")
                )
            ):
                raise BuildControlError("Managed retirement identity is incomplete")
        environment_values = [
            "FULLMAG_RETIREMENT_ONLY=1",
            "FULLMAG_RETIREMENT_OPERATION_ID=" + retirement_operation_id,
            "FULLMAG_RETIREMENT_INPUTS_SHA256=" + retirement_inputs_sha256,
            "FULLMAG_STARTUP_HELPER_SHA256=" + helper_sha256,
            "FULLMAG_STARTUP_API=http://127.0.0.1:8081",
        ]
        if retirement_require_existing_intent:
            environment_values.append("FULLMAG_RETIREMENT_REQUIRE_EXISTING_INTENT=1")
        if retirement_predecessor is not None:
            environment_values.extend((
                "FULLMAG_RETIREMENT_PREDECESSOR_SHA256=" + str(retirement_predecessor["proof_sha256"]),
                "FULLMAG_RETIREMENT_PREDECESSOR_SCOPE=" + str(retirement_predecessor["request_scope_epoch"]),
            ))
        if retirement_identity is not None:
            environment_values.extend((
                "FULLMAG_RETIREMENT_SESSION_ID=" + str(retirement_identity["session_id"]),
                "FULLMAG_RETIREMENT_RUN_ID=" + str(retirement_identity["run_id"]),
            ))
    else:
        if (script_path is None or provenance_path is None or provenance_sha256 is None
                or activation_receipt_path is None or activation_receipt_key is None):
            raise BuildControlError("Backend activation envelope is incomplete")
        environment_values = [
            "FULLMAG_STARTUP_ENABLED=1",
            "FULLMAG_STARTUP_SCRIPT=" + script_path,
            "FULLMAG_STARTUP_PROVENANCE=" + provenance_path,
            "FULLMAG_STARTUP_PROVENANCE_SHA256=" + provenance_sha256,
            "FULLMAG_STARTUP_HELPER_SHA256=" + helper_sha256,
            "FULLMAG_STARTUP_RECEIPT_KEY=" + activation_receipt_key,
            "FULLMAG_STARTUP_API=http://127.0.0.1:8081",
        ]
    if retirement_operation_id is not None:
        if not ATTEMPT_RE.fullmatch(retirement_operation_id):
            raise BuildControlError("Activation retirement operation id is invalid")
    environment = tuple(environment_values)
    result = docker_capture(
        "exec",
        *sum((["--env", value] for value in environment), []),
        backend_id,
        "/usr/local/bin/python3",
        "-I",
        "-B",
        "-c",
        FIXED_ACTIVATION_SCRIPT,
        timeout=activation_timeout_seconds,
        allow_failure=True,
    )
    output = result.stdout + result.stderr
    value = _json_result(output)
    if result.returncode == 0:
        expected_states = {"retirement-only"} if retirement_only else {"activated", "rejected"}
        if value is None or value.get("state") not in expected_states:
            raise BuildControlError("Backend activation wrapper returned no terminal result")
        return value
    if result.returncode == RETIREMENT_REFUSAL_EXIT:
        if (
            isinstance(value, Mapping)
            and retirement_only
            and value.get("schema") == RETIREMENT_REFUSAL_SCHEMA
            and value.get("state") == "refused"
            and value.get("operation_id") == retirement_operation_id
            and value.get("code") in RETIREMENT_REFUSAL_CODES
        ):
            error = BuildControlError(
                "Backend retirement was refused before mutation: " + str(value["code"])
            )
            setattr(error, "retirement_refusal", dict(value))
            raise error
        raise ControlOutcomeUnknown(
            "Managed retirement returned a malformed refusal diagnostic; the operation remains quarantined"
        )
    if value is not None and value.get("state") == "unknown":
        error = ControlOutcomeUnknown(
            "Startup activation outcome is unknown; activation.json prevents retry: "
            + str(value.get("error", "No diagnostic supplied"))[-4096:]
        )
        if isinstance(value.get("retirement"), Mapping):
            setattr(error, "retirement", dict(value["retirement"]))
        raise error
    if retirement_only:
        raise ControlOutcomeUnknown(
            "Managed retirement outcome is unknown; the retained control operation remains leased: "
            + output.decode("utf-8", "replace")[-4096:]
        )
    marker = docker_capture(
        "exec",
        backend_id,
        "test",
        "-f",
        activation_receipt_path or "/dev/null",
        timeout=30,
        allow_failure=True,
    )
    if marker.returncode == 0:
        raise ControlOutcomeUnknown(
            "Backend activation failed after publishing activation.json; retry is forbidden: "
            + output.decode("utf-8", "replace")[-4096:]
        )
    detail = output.decode("utf-8", "replace")[-4096:]
    raise BuildControlError(f"Backend activation wrapper failed: {detail}")


def _activation_operation_inputs(
    *,
    development_attempt: str,
    config_sha256: str,
    source_root: str,
    image: str,
    source_relative: str,
    source_sha256: str,
    request_id: str,
    provenance_sha256: str,
    backend_container: str,
    activation_receipt_key: str,
    activation_receipt_path: str,
) -> dict[str, str]:
    """Build activation inputs without colliding with operation.attempt."""
    return {
        "development_attempt": development_attempt,
        "config_sha256": config_sha256,
        "source_root": source_root,
        "image_id": image,
        "source_relative": source_relative,
        "source_sha256": source_sha256,
        "request_id": request_id,
        "provenance_sha256": provenance_sha256,
        "backend_container": backend_container,
        "activation_receipt_key": activation_receipt_key,
        "activation_receipt_path": activation_receipt_path,
    }


def _record_activation_result(operation: dict[str, object], result: Mapping[str, object]) -> None:
    """Commit a known activation result and fail the host command on rejection."""
    if not isinstance(result, Mapping) or result.get("state") not in {"activated", "rejected"}:
        raise BuildControlError("Backend activation wrapper returned an invalid terminal result")
    receipt = operation.get("receipt")
    if not isinstance(receipt, dict):
        raise BuildControlError("Activation operation receipt is missing")
    operation["daemon_pending"] = False
    response = result.get("response")
    receipt.update(
        state="succeeded" if result["state"] == "activated" else "failed-confirmed",
        activation_state=result["state"],
        session_id=response.get("session_id") if isinstance(response, Mapping) else None,
        run_id=response.get("run_id") if isinstance(response, Mapping) else None,
    )
    if isinstance(result.get("retirement"), Mapping):
        receipt["retirement"] = dict(result["retirement"])
    if result["state"] == "rejected":
        error = BuildControlError(
            "Backend activation was rejected; terminal activation receipt retained and retry is forbidden"
        )
        if isinstance(result.get("rejection"), Mapping):
            setattr(error, "rejection", dict(result["rejection"]))
        raise error


def _read_control_bytes(
    control: BuildControl,
    relative: str,
    *,
    optional: bool = False,
    maximum: int = 8 * 1024 * 1024,
) -> bytes | None:
    """Read one existing operation record through the image-owned reader."""

    result = bounded_capture(
        control.helper_args(control_read_script(control.path(relative), maximum)),
        data=b"",
        timeout=90,
    )
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        raise BuildControlError(
            f"cannot read retained activation record {relative}: "
            + result.stderr.decode("utf-8", "replace")[-2048:]
        )
    if len(result.stdout) > maximum:
        raise BuildControlError(f"retained activation record {relative} exceeds its size bound")
    return bytes(result.stdout)


def _retirement_inputs_sha256(inputs: Mapping[str, object]) -> str:
    """Hash the exact immutable activation envelope bound into the image marker."""

    try:
        digest = hashlib.sha256(canonical(dict(inputs))).hexdigest()
    except (TypeError, ValueError) as error:
        raise BuildControlError("Activation inputs cannot be canonically hashed") from error
    if SHA256_RE.fullmatch(digest) is None:  # pragma: no cover - hashlib invariant
        raise BuildControlError("Activation inputs digest is invalid")
    return digest


def _validate_activation_input_bindings(
    inputs: Mapping[str, object],
    *,
    operation_id: str,
) -> dict[str, str]:
    """Validate every request/source/provenance/receipt binding before replay."""

    source_relative = inputs.get("source_relative")
    if (not isinstance(source_relative, str) or not source_relative
            or len(source_relative) > 1024 or "\x00" in source_relative):
        raise BuildControlError("Retained activation source path is invalid")
    source_path = PurePosixPath(source_relative)
    if (source_path.is_absolute() or ".." in source_path.parts
            or any(part in {"", "."} for part in source_path.parts)):
        raise BuildControlError("Retained activation source path escapes the selected source")
    source_sha256 = inputs.get("source_sha256")
    if not isinstance(source_sha256, str) or SHA256_RE.fullmatch(source_sha256) is None:
        raise BuildControlError("Retained activation source digest is invalid")
    request_id = inputs.get("request_id")
    if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
        raise BuildControlError("Retained activation request id is invalid")
    provenance_sha256 = inputs.get("provenance_sha256")
    if not isinstance(provenance_sha256, str) or SHA256_RE.fullmatch(provenance_sha256) is None:
        raise BuildControlError("Retained activation provenance digest is invalid")
    receipt_key = inputs.get("activation_receipt_key")
    if not isinstance(receipt_key, str) or SHA256_RE.fullmatch(receipt_key) is None:
        raise BuildControlError("Retained activation receipt key is invalid")
    if hashlib.sha256(request_id.encode("utf-8")).hexdigest() != receipt_key:
        raise BuildControlError("Retained activation receipt key does not bind its request id")
    expected_path = (
        "/opt/fullmag/control/backend/script-activation-" + receipt_key + "/activation.json"
    )
    receipt_path = inputs.get("activation_receipt_path")
    if receipt_path != expected_path:
        raise BuildControlError("Retained activation receipt path differs from its key")
    expected_provenance_path = (
        CONTROL_ROOT + "/activation/attempts/" + operation_id + "/startup-provenance.json"
    )
    return {
        "source_relative": source_relative,
        "source_sha256": source_sha256,
        "request_id": request_id,
        "provenance_sha256": provenance_sha256,
        "activation_receipt_key": receipt_key,
        "activation_receipt_path": expected_path,
        "provenance_path": expected_provenance_path,
    }


def _retirement_scope(value: object, label: str) -> str:
    if (not isinstance(value, str) or not value.strip() or ":" not in value
            or len(value) > 512 or any(character.isspace() or ord(character) < 32 for character in value)):
        raise BuildControlError(f"{label} is invalid")
    return value


def _retirement_context_from_mapping(
    retirement: Mapping[str, object],
    *,
    operation_id: str,
    helper_sha256: str,
    inputs_sha256: str,
    bindings: Mapping[str, str],
    phase: str = "retirement",
) -> dict[str, object]:
    """Validate one image-owned retirement projection and derive replay pins."""

    if retirement.get("operation_id") != operation_id:
        raise BuildControlError("retained retirement operation identity differs")
    if (not isinstance(retirement.get("session_id"), str)
            or not retirement["session_id"].strip()):
        raise BuildControlError("retained retirement session identity is missing")
    if (not isinstance(retirement.get("run_id"), str)
            or not retirement["run_id"].strip()):
        raise BuildControlError("retained retirement run identity is missing")
    predecessor_scope = _retirement_scope(
        retirement.get("request_scope_epoch"),
        "retained retirement predecessor scope",
    )
    api_scope = _retirement_scope(
        retirement.get("api_request_scope_epoch"),
        "retained retirement API incarnation",
    )
    archive_sha256 = retirement.get("archive_sha256")
    if archive_sha256 is not None and (
        not isinstance(archive_sha256, str) or SHA256_RE.fullmatch(archive_sha256) is None
    ):
        raise BuildControlError("retained retirement archive digest is invalid")
    if archive_sha256 is None:
        marker_sha256 = retirement.get("marker_sha256")
        if (retirement.get("state") not in {"pending", "rejected"}
                or not isinstance(marker_sha256, str)
                or SHA256_RE.fullmatch(marker_sha256) is None):
            raise BuildControlError("retained retirement has no archive or authenticated marker")
    elif (retirement.get("state") is not None
            and retirement.get("state") not in {"retired", "replayed"}):
        raise BuildControlError("retained retirement response state is invalid")
    context = {
        "operation_id": operation_id,
        "helper_sha256": helper_sha256,
        "session_id": retirement["session_id"],
        "run_id": retirement["run_id"],
        "archive_sha256": archive_sha256,
        "request_scope_epoch": predecessor_scope,
        "api_request_scope_epoch": api_scope,
        "inputs_sha256": inputs_sha256,
        "bindings": bindings,
        "phase": phase,
        "retirement": dict(retirement),
    }
    if archive_sha256 is not None:
        context["predecessor"] = {
            "proof_sha256": archive_sha256,
            "request_scope_epoch": predecessor_scope,
        }
    return context


def _validate_retirement_receipt(
    receipt: Mapping[str, object],
    *,
    operation_id: str,
    development_attempt: str,
    config_sha256: str,
    source_root: str,
    image_id: str,
    backend_id: str,
) -> tuple[dict[str, object], dict[str, object]]:
    expected = {
        "schema": OPERATION_SCHEMA,
        "phase": "activation",
        "state": "outcome-unknown-resources-retained",
        "attempt": operation_id,
    }
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise BuildControlError("retained retirement receipt is not an unknown activation operation")
    if receipt.get("helper_container") != "fullmag-control-" + operation_id:
        raise BuildControlError("retained retirement helper identity differs")
    inputs = receipt.get("inputs")
    if not isinstance(inputs, Mapping):
        raise BuildControlError("retained retirement receipt has no immutable activation inputs")
    for key, expected_value in {
        "development_attempt": development_attempt,
        "config_sha256": config_sha256,
        "source_root": source_root,
        "image_id": image_id,
        "backend_container": backend_id,
    }.items():
        if inputs.get(key) != expected_value:
            raise BuildControlError("retained retirement activation input differs: " + key)
    helper_sha256 = receipt.get("helper_sha256")
    if not isinstance(helper_sha256, str) or SHA256_RE.fullmatch(helper_sha256) is None:
        raise BuildControlError("retained retirement helper digest is invalid")
    bindings = _validate_activation_input_bindings(inputs, operation_id=operation_id)
    inputs_sha256 = receipt.get("retirement_inputs_sha256")
    if not isinstance(inputs_sha256, str) or SHA256_RE.fullmatch(inputs_sha256) is None:
        raise BuildControlError("retained retirement inputs digest is missing")
    if inputs_sha256 != _retirement_inputs_sha256(inputs):
        raise BuildControlError("retained retirement inputs digest differs")
    retirement = receipt.get("retirement")
    phase = receipt.get("retirement_phase")
    if phase is not None and phase not in {"retirement", "startup"}:
        raise BuildControlError("retained activation retirement phase is invalid")
    if not isinstance(retirement, Mapping):
        if phase == "startup":
            # A successful no-op retirement is still a durable predecessor
            # phase.  The startup marker/quarantine, rather than this host,
            # owns recovery if the following POST is uncertain.
            retirement_result = receipt.get("retirement_result")
            if (not isinstance(retirement_result, Mapping)
                    or retirement_result.get("state") != "retirement-only"
                    or retirement_result.get("retirement") is not None):
                raise BuildControlError("retained startup phase has no retirement result")
            context = {
                "operation_id": operation_id,
                "helper_sha256": helper_sha256,
                "phase": "startup",
                "inputs_sha256": inputs_sha256,
                "bindings": bindings,
            }
            return dict(receipt), context
        if phase != "retirement":
            raise BuildControlError(
                "retained retirement outcome has no managed predecessor receipt; refusing a new script"
            )
        context = {
            "operation_id": operation_id,
            "helper_sha256": helper_sha256,
            "phase": "retirement",
            "inputs_sha256": inputs_sha256,
            "bindings": bindings,
            # The host may have died after the fixed image wrapper completed
            # its POST but before it copied the image-owned intent into this
            # receipt.  Recovery must authenticate that marker in the image;
            # absence remains unknown and never starts a fresh retirement.
            "missing_retirement": True,
        }
        return dict(receipt), context
    if phase == "startup":
        retirement_result = receipt.get("retirement_result")
        if (not isinstance(retirement_result, Mapping)
                or retirement_result.get("state") != "retirement-only"
                or retirement_result.get("retirement") != dict(retirement)):
            raise BuildControlError("retained startup phase retirement result differs")
    context = _retirement_context_from_mapping(
        retirement,
        operation_id=operation_id,
        helper_sha256=helper_sha256,
        inputs_sha256=inputs_sha256,
        bindings=bindings,
        phase=phase or "retirement",
    )
    return dict(receipt), context


def _retained_retirement_context(
    control: BuildControl,
    *,
    development_attempt: str,
    config_sha256: str,
    source_root: str,
    image_id: str,
    backend_id: str,
) -> tuple[dict[str, object], dict[str, object], bytes] | None:
    active_raw = _read_control_bytes(control, "active", optional=True, maximum=256)
    if active_raw is None:
        return None
    operation_id = active_raw.decode("utf-8", "replace").strip()
    if (not ATTEMPT_RE.fullmatch(operation_id)
            or not _retirement_lease_matches(active_raw, operation_id)):
        raise BuildControlError("retained active operation identity is invalid")
    receipt_relative = "activation/attempts/" + operation_id + "/receipt.json"
    receipt_raw = _read_control_bytes(control, receipt_relative)
    try:
        receipt = json.loads(receipt_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("retained activation receipt is not valid JSON") from error
    if not isinstance(receipt, Mapping):
        raise BuildControlError("retained activation receipt is not an object")
    validated, context = _validate_retirement_receipt(
        receipt,
        operation_id=operation_id,
        development_attempt=development_attempt,
        config_sha256=config_sha256,
        source_root=source_root,
        image_id=image_id,
        backend_id=backend_id,
    )
    bindings = context.get("bindings")
    if not isinstance(bindings, Mapping):
        raise BuildControlError("retained activation bindings are missing")
    provenance_raw = _read_control_bytes(
        control,
        "activation/attempts/" + operation_id + "/startup-provenance.json",
        maximum=8 * 1024 * 1024,
    )
    if hashlib.sha256(provenance_raw).hexdigest() != bindings.get("provenance_sha256"):
        raise BuildControlError("retained startup provenance bytes differ from its immutable digest")
    try:
        provenance_document = json.loads(provenance_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("retained startup provenance is not valid JSON") from error
    if (not isinstance(provenance_document, Mapping)
            or provenance_document.get("request_id") != bindings["request_id"]
            or provenance_document.get("source_sha256") != bindings["source_sha256"]
            or provenance_document.get("source_relative") != bindings["source_relative"]
            or provenance_document.get("container_script_path")
            != "/opt/fullmag/source/" + bindings["source_relative"]):
        raise BuildControlError("retained startup provenance bindings differ")
    terminal = _read_control_bytes(
        control,
        "activation/attempts/" + operation_id + "/terminal.json",
        optional=True,
        maximum=8 * 1024 * 1024,
    )
    if terminal is not None:
        if context.get("phase") != "retirement":
            raise BuildControlError("retained startup operation has an unexpected terminal record")
        try:
            terminal_value = json.loads(terminal.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BuildControlError("retained retirement terminal is not valid JSON") from error
        if (not isinstance(terminal_value, Mapping)
                or terminal_value.get("schema") != OPERATION_SCHEMA
                or terminal_value.get("attempt") != operation_id
                or terminal_value.get("state") != "failed-confirmed"
                or terminal_value.get("activation_state") not in {
                    "retirement-replayed",
                    "retirement-refused-recovered",
                }):
            raise BuildControlError("retained retirement terminal is not a replay finalization")
        for key in (
            "schema",
            "phase",
            "attempt",
            "helper_container",
            "helper_sha256",
            "inputs",
            "retirement_inputs_sha256",
            "retirement_phase",
        ):
            if terminal_value.get(key) != receipt.get(key):
                raise BuildControlError("retained retirement terminal pin differs: " + key)
        terminal_retirement = terminal_value.get("retirement")
        if context.get("missing_retirement"):
            if not isinstance(terminal_retirement, Mapping):
                raise BuildControlError("retained retirement terminal has no image-owned result")
            expected_states = (
                {"rejected"}
                if terminal_value.get("activation_state") == "retirement-refused-recovered"
                else {"retired", "replayed"}
            )
            if terminal_retirement.get("state") not in expected_states:
                raise BuildControlError("retained retirement terminal state is not confirmed")
            terminal_context = _retirement_context_from_mapping(
                terminal_retirement,
                operation_id=operation_id,
                helper_sha256=str(context["helper_sha256"]),
                inputs_sha256=str(context["inputs_sha256"]),
                bindings=bindings,
            )
            for key in (
                "session_id",
                "run_id",
                "archive_sha256",
                "request_scope_epoch",
                "api_request_scope_epoch",
                "predecessor",
            ):
                if key in terminal_context:
                    context[key] = terminal_context[key]
            context["terminal_retirement"] = terminal_context
        elif terminal_retirement != receipt.get("retirement"):
            raise BuildControlError("retained retirement terminal predecessor differs")
        context["terminal"] = dict(terminal_value)
    return validated, context, receipt_raw


def _record_payload(value: Mapping[str, object], label: str) -> bytes:
    try:
        payload = canonical(dict(value)) + b"\n"
    except (TypeError, ValueError) as error:
        raise BuildControlError(label + " is not serializable") from error
    if len(payload) > 8 * 1024 * 1024:
        raise BuildControlError(label + " exceeds its byte budget")
    return payload


def _ensure_control_record(
    control: BuildControl,
    relative: str,
    value: Mapping[str, object],
    *,
    label: str,
) -> bytes:
    expected = _record_payload(value, label)
    existing = _read_control_bytes(control, relative, optional=True)
    if existing is not None:
        if existing != expected:
            raise ControlOutcomeUnknown(label + " changed before finalization")
        return existing
    control.write_bytes(relative, expected)
    return expected


def _retirement_lease_matches(raw: bytes, operation_id: str) -> bool:
    expected = operation_id.encode("ascii")
    return raw in (expected, expected + b"\n")


def _retirement_previous_current(control: BuildControl, target: bytes) -> bytes | None:
    previous = _read_control_bytes(control, "activation/current.json", optional=True,
                                   maximum=RETIREMENT_CAS_PAYLOAD_BYTES)
    if previous is None or previous == target:
        return previous
    try:
        record = json.loads(previous)
    except (ValueError, UnicodeDecodeError) as error:
        raise ControlOutcomeUnknown("retained retirement current pointer is invalid") from error
    if (not isinstance(record, dict)
            or record.get("schema") != OPERATION_SCHEMA
            or record.get("phase") != "activation"
            or record.get("state") not in {"succeeded", "failed-confirmed"}
            or record.get("compose_project") != control.project
            or record.get("control_volume") != control.volume
            or not isinstance(record.get("attempt"), str)
            or ATTEMPT_RE.fullmatch(record["attempt"]) is None):
        raise ControlOutcomeUnknown("retained retirement current pointer is not a terminal of this group")
    predecessor = _read_control_bytes(
        control, "activation/attempts/" + record["attempt"] + "/terminal.json",
        maximum=RETIREMENT_CAS_PAYLOAD_BYTES)
    if predecessor != previous:
        raise ControlOutcomeUnknown("retained retirement current pointer differs from its terminal")
    return previous


def _retirement_cas_script(
    *,
    operation_id: str,
    active_raw: bytes,
    receipt_raw: bytes,
    result_raw: bytes,
    terminal_raw: bytes,
    current_raw: bytes,
    namespace_registry_sha256: str | None = None,
    expected_current_raw: bytes | None = None,
    logger_present: bool = False,
) -> str:
    """CAS-publish records; a live, authenticated logger releases its own lease."""
    if not ATTEMPT_RE.fullmatch(operation_id):
        raise BuildControlError("retirement CAS operation id is invalid")
    payloads = (receipt_raw, result_raw, terminal_raw, current_raw)
    if (not active_raw or len(active_raw) > 256 or not receipt_raw
            or any(len(payload) > RETIREMENT_CAS_PAYLOAD_BYTES for payload in payloads)
            or (expected_current_raw is not None
                and len(expected_current_raw) > RETIREMENT_CAS_PAYLOAD_BYTES)):
        raise BuildControlError("retirement CAS expected records are incomplete")
    if not _retirement_lease_matches(active_raw, operation_id):
        raise ControlOutcomeUnknown("retained retirement active lease belongs to another operation")
    if (namespace_registry_sha256 is not None
            and (not isinstance(namespace_registry_sha256, str)
                 or SHA256_RE.fullmatch(namespace_registry_sha256) is None)):
        raise BuildControlError("retirement CAS namespace registry digest is invalid")
    root = "/control/activation/attempts/" + operation_id
    active, receipt = "/control/active", root + "/receipt.json"
    result, terminal = root + "/result.json", root + "/terminal.json"
    current = "/control/activation/current.json"

    def digest(raw: bytes) -> str:
        return hashlib.sha256(raw).hexdigest()

    def verify(path: str, raw: bytes) -> str:
        return f"verify {shlex.quote(path)} '{digest(raw)}'; "

    def publish(path: str, raw: bytes, predecessor: bytes | None = None) -> str:
        encoded = base64.b64encode(raw).decode("ascii")
        old = digest(predecessor) if predecessor is not None else ""
        return f"publish {shlex.quote(path)} '{digest(raw)}' '{encoded}' '{old}'; "

    admission = "test ! -L /control/operation.lock; "
    if not logger_present:
        lock = "/registry/operation.lock" if namespace_registry_sha256 else "/control/operation.lock"
        mode = "<" if namespace_registry_sha256 else ">"
        admission += f"exec 9{mode}{lock}; flock -n 9; "
    if namespace_registry_sha256 is not None:
        admission += (
            "test \"$(stat -c '%d:%i' /control/operation.lock)\" = "
            "\"$(stat -c '%d:%i' /registry/operation.lock)\"; "
            "test \"$(sha256sum /registry/namespaces/current.json | cut -d ' ' -f 1)\" = "
            f"'{namespace_registry_sha256}'; "
        )
    guard_current = f"test ! -L {current}; "
    if expected_current_raw is None:
        guard_current += f"if test -e {current}; then " + verify(current, current_raw) + "fi; "
    else:
        guard_current += (
            f"if test \"$(sha256sum {current} | cut -d ' ' -f 1)\" = '{digest(current_raw)}'; then "
            + verify(current, current_raw) + "else "
            + verify(current, expected_current_raw) + "fi; "
        )
        if expected_current_raw != current_raw:
            try:
                predecessor = json.loads(expected_current_raw)
            except (ValueError, UnicodeDecodeError) as error:
                raise BuildControlError("retirement CAS predecessor is invalid") from error
            predecessor_id = predecessor.get("attempt") if isinstance(predecessor, dict) else None
            if not isinstance(predecessor_id, str) or ATTEMPT_RE.fullmatch(predecessor_id) is None:
                raise BuildControlError("retirement CAS predecessor attempt is invalid")
            predecessor_root = "/control/activation/attempts/" + predecessor_id
            guard_current += (
                f"test -d {predecessor_root}; test ! -L {predecessor_root}; "
                + verify(predecessor_root + "/terminal.json", expected_current_raw)
            )
    # Fixed paths and base64 payloads keep record text out of shell syntax.
    script = (
        "umask 027; set -eu; " + admission
        + "test -d /control; test ! -L /control; "
        "test -d /control/activation; test ! -L /control/activation; "
        "test -d /control/activation/attempts; test ! -L /control/activation/attempts; "
        f"test -d {root}; test ! -L {root}; "
        "verify() { test -f \"$1\"; test ! -L \"$1\"; "
        "test \"$(stat -c %h \"$1\")\" = 1; "
        "test \"$(sha256sum \"$1\" | cut -d ' ' -f 1)\" = \"$2\"; }; "
        + verify(receipt, receipt_raw)
        + f"if test ! -L {active} && test ! -e {active}; then "
        + verify(result, result_raw) + verify(current, current_raw) + verify(terminal, terminal_raw)
        + "printf 'ALREADY_FINALIZED\\n'; exit 0; fi; "
        + verify(active, active_raw) + guard_current
        + f"if test -e {result} || test -L {result}; then " + verify(result, result_raw) + "fi; "
        + f"if test -e {terminal} || test -L {terminal}; then " + verify(terminal, terminal_raw) + "fi; "
        + "publish() { p=\"$1\"; expected=\"$2\"; payload=\"$3\"; old=\"$4\"; "
        "test ! -L \"$p\"; parent=\"${p%/*}\"; test -d \"$parent\"; test ! -L \"$parent\"; "
        "if test -e \"$p\"; then "
        "if test \"$(sha256sum \"$p\" | cut -d ' ' -f 1)\" = \"$expected\"; then "
        "verify \"$p\" \"$expected\"; return; fi; "
        "test \"$p\" = /control/activation/current.json; test -n \"$old\"; verify \"$p\" \"$old\"; fi; "
        "t=$(mktemp \"$parent/.retirement.XXXXXXXX\"); trap 'rm -f -- \"$t\"' EXIT; "
        "printf '%s' \"$payload\" | base64 -d > \"$t\"; sync \"$t\"; verify \"$t\" \"$expected\"; "
        "mv -T -- \"$t\" \"$p\"; sync \"$parent\"; }; "
        + publish(result, result_raw)
        + publish(current, current_raw, expected_current_raw)
        + publish(terminal, terminal_raw)
    )
    if logger_present:
        return script + "printf 'RECORDS_PUBLISHED\\n'"
    return (script + verify(active, active_raw)
            + f"rm -- {active}; sync /control; sync {root}; printf 'FINALIZED\\n'")


def _wait_retirement_lease_release(
    control: BuildControl,
    *,
    operation_id: str,
    timeout: float = 30.0,
) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        remaining = _read_control_bytes(control, "active", optional=True, maximum=256)
        if remaining is None:
            return True
        if not _retirement_lease_matches(remaining, operation_id):
            raise ControlOutcomeUnknown("retained retirement control lease changed after finalization")
        time.sleep(0.1)
    return False


def _finalize_retained_retirement(
    control: BuildControl,
    *,
    operation_id: str,
    receipt_raw: bytes,
    result: Mapping[str, object],
    terminal: Mapping[str, object],
    retained_receipt: Mapping[str, object] | None = None,
) -> None:
    """CAS the latest pointer before publishing terminal and releasing the lease."""
    from docker_volume_activation_reconcile import _probe_helper_absence
    from docker_dev_host import docker_argv

    root = "activation/attempts/" + operation_id
    result_raw = _record_payload(result, "retained retirement result")
    terminal_raw = _record_payload(terminal, "retained retirement terminal")
    helper_name = "fullmag-control-" + operation_id
    for retry in range(2):
        logger_present = _probe_helper_absence(helper_name) is None
        helper = None
        if logger_present:
            try:
                decoded = json.loads(receipt_raw)
            except (ValueError, UnicodeDecodeError) as error:
                raise ControlOutcomeUnknown("retained retirement helper receipt is invalid") from error
            retained = dict(retained_receipt) if retained_receipt is not None else decoded
            if (not isinstance(retained, dict) or retained != decoded
                    or retained.get("attempt") != operation_id
                    or retained.get("phase") != "activation"):
                raise ControlOutcomeUnknown("retained retirement helper receipt identity differs")
            helper = control._inspect_operation_helper({"receipt": retained})
        active_raw = _read_control_bytes(control, "active", optional=True, maximum=256)
        if active_raw is None:
            if (
                _read_control_bytes(control, root + "/result.json", optional=True) == result_raw
                and _read_control_bytes(control, "activation/current.json", optional=True) == terminal_raw
                and _read_control_bytes(control, root + "/terminal.json", optional=True) == terminal_raw
            ):
                return
            raise ControlOutcomeUnknown("retained retirement active lease disappeared before records were complete")
        if not _retirement_lease_matches(active_raw, operation_id):
            raise ControlOutcomeUnknown("retained retirement active lease changed to another operation")
        receipt_now = _read_control_bytes(control, root + "/receipt.json")
        if receipt_now != receipt_raw:
            raise ControlOutcomeUnknown("retained retirement receipt changed before logger-absence finalization")
        previous = _retirement_previous_current(control, terminal_raw)
        script = _retirement_cas_script(
            operation_id=operation_id, active_raw=active_raw, receipt_raw=receipt_now,
            result_raw=result_raw, terminal_raw=terminal_raw, current_raw=terminal_raw,
            namespace_registry_sha256=control.namespace_registry_sha256,
            expected_current_raw=previous, logger_present=logger_present,
        )
        if logger_present:
            control._inspect_operation_helper({"receipt": retained}, expected_id=helper)
            command = [*docker_argv("exec"), "--user", "65532:65532", helper,
                       "/bin/bash", "-euo", "pipefail", "-c", control._namespace_guard(script)]
        else:
            command = control.helper_args(script)
        outcome = bounded_capture(command, data=b"", timeout=90)
        proofs = (b"RECORDS_PUBLISHED\n", b"ALREADY_FINALIZED\n") if logger_present else (
            b"FINALIZED\n", b"ALREADY_FINALIZED\n")
        if outcome.returncode or not any(proof in outcome.stdout for proof in proofs):
            raise ControlOutcomeUnknown(
                "retained retirement CAS did not finalize: "
                + outcome.stderr.decode("utf-8", "replace")[-2048:])
        if not logger_present or _wait_retirement_lease_release(control, operation_id=operation_id):
            return
        if _probe_helper_absence(helper_name) is None or retry:
            raise ControlOutcomeUnknown("retained retirement control lease did not finalize")
    raise ControlOutcomeUnknown("retained retirement control lease did not finalize")


def _resume_retained_retirement(
    control: BuildControl,
    *,
    backend_id: str,
    operation_id: str,
    context: Mapping[str, object],
    receipt: Mapping[str, object],
    receipt_raw: bytes,
    helper_sha256: str,
    activation_timeout_seconds: float,
) -> None:
    if receipt.get("helper_sha256") != helper_sha256:
        raise BuildControlError("retained retirement helper differs from the selected image")
    root = "activation/attempts/" + operation_id
    existing_terminal = context.get("terminal")
    if isinstance(existing_terminal, Mapping):
        result_raw = _read_control_bytes(control, root + "/result.json")
        try:
            existing_result = json.loads(result_raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BuildControlError("retained retirement result is not valid JSON") from error
        if (not isinstance(existing_result, Mapping)
                or existing_result.get("state") != "retirement-only"
                or not isinstance(existing_result.get("retirement"), Mapping)
                or existing_result.get("retirement") != existing_terminal.get("retirement")):
            raise BuildControlError("retained retirement partial terminal result differs")
        _finalize_retained_retirement(
            control,
            operation_id=operation_id,
            receipt_raw=receipt_raw,
            retained_receipt=receipt,
            result=dict(existing_result),
            terminal=dict(existing_terminal),
        )
        return

    if context.get("missing_retirement"):
        # The host receipt may predate the image-owned intent because the
        # host died after the fixed wrapper's result and before its receipt
        # write.  Let the attested helper read that exact marker first.  The
        # helper's require_existing_intent guard makes marker absence an
        # unknown outcome and prevents binding this old operation to a new
        # current workspace.
        try:
            result = _run_fixed_activation(
                backend_id,
                script_path=None,
                provenance_path=None,
                provenance_sha256=None,
                helper_sha256=helper_sha256,
                activation_timeout_seconds=activation_timeout_seconds,
                activation_receipt_path=None,
                activation_receipt_key=None,
                retirement_operation_id=operation_id,
                retirement_inputs_sha256=str(context["inputs_sha256"]),
                retirement_predecessor=None,
                retirement_identity=None,
                retirement_require_existing_intent=True,
                retirement_only=True,
            )
        except BuildControlError as error:
            refusal = getattr(error, "retirement_refusal", None)
            if not isinstance(refusal, Mapping):
                raise
            retirement = refusal.get("retirement")
            bindings = context.get("bindings")
            if not isinstance(retirement, Mapping) or not isinstance(bindings, Mapping):
                raise BuildControlError("retained retirement refusal has no image-owned evidence") from error
            _retirement_context_from_mapping(
                retirement,
                operation_id=operation_id,
                helper_sha256=helper_sha256,
                inputs_sha256=str(context["inputs_sha256"]),
                bindings=bindings,
            )
            if retirement.get("state") != "rejected":
                raise BuildControlError("retained retirement refusal evidence is not rejected") from error
            active_after = _read_control_bytes(control, "active", maximum=256)
            if not _retirement_lease_matches(active_after, operation_id):
                raise ControlOutcomeUnknown("retained retirement control lease changed before refusal finalization")
            receipt_after = _read_control_bytes(control, root + "/receipt.json")
            if receipt_after != receipt_raw:
                raise ControlOutcomeUnknown("retained retirement receipt changed before refusal finalization")
            terminal = dict(receipt)
            terminal.update(
                state="failed-confirmed",
                activation_state="retirement-refused-recovered",
                retirement=dict(retirement),
                retirement_resume_state="refused",
            )
            _finalize_retained_retirement(
                control,
                operation_id=operation_id,
                receipt_raw=receipt_raw,
                retained_receipt=receipt,
                result={"state": "retirement-only", "retirement": dict(retirement)},
                terminal=terminal,
            )
            return
        retirement = result.get("retirement")
        bindings = context.get("bindings")
        if not isinstance(retirement, Mapping) or not isinstance(bindings, Mapping):
            raise BuildControlError("managed retirement recovery returned no image-owned response")
        context = _retirement_context_from_mapping(
            retirement,
            operation_id=operation_id,
            helper_sha256=helper_sha256,
            inputs_sha256=str(context["inputs_sha256"]),
            bindings=bindings,
        )
    else:
        predecessor = context.get("predecessor")
        if predecessor is not None and not isinstance(predecessor, Mapping):
            raise BuildControlError("retained retirement predecessor is invalid")
        result = _run_fixed_activation(
            backend_id,
            script_path=None,
            provenance_path=None,
            provenance_sha256=None,
            helper_sha256=helper_sha256,
            activation_timeout_seconds=activation_timeout_seconds,
            activation_receipt_path=None,
            activation_receipt_key=None,
            retirement_operation_id=operation_id,
            retirement_inputs_sha256=str(context["inputs_sha256"]),
            retirement_predecessor=(
                {
                    "proof_sha256": str(predecessor["proof_sha256"]),
                    "request_scope_epoch": str(predecessor["request_scope_epoch"]),
                }
                if isinstance(predecessor, Mapping) else None
            ),
            retirement_identity={
                "session_id": str(context["session_id"]),
                "run_id": str(context["run_id"]),
            },
            retirement_require_existing_intent=True,
            retirement_only=True,
        )
    retirement = result.get("retirement")
    if not isinstance(retirement, Mapping):
        raise BuildControlError("managed retirement replay returned no retirement response")
    # Operation/session/run are immutable owner pins.  A pending image-owned
    # intent is different: its recorded scope is only the observation made
    # before the first POST.  If that POST was lost across an API restart,
    # the helper has already re-observed and authenticated the current scope
    # in its response.  Once an archive exists, the predecessor scope is an
    # immutable proof and must remain byte-for-byte stable on every replay.
    for key in ("operation_id", "session_id", "run_id"):
        if retirement.get(key) != context.get(key):
            raise BuildControlError("managed retirement replay changed its immutable " + key)
    expected_archive = context.get("archive_sha256")
    observed_archive = retirement.get("archive_sha256")
    if (not isinstance(observed_archive, str)
            or SHA256_RE.fullmatch(observed_archive) is None
            or (expected_archive is not None and observed_archive != expected_archive)):
        raise BuildControlError("managed retirement replay changed its archive proof")
    observed_scope = _retirement_scope(
        retirement.get("request_scope_epoch"),
        "managed retirement replay predecessor scope",
    )
    if expected_archive is not None and observed_scope != context.get("request_scope_epoch"):
        raise BuildControlError("managed retirement replay changed its immutable request scope")
    if retirement.get("state") not in {"retired", "replayed"}:
        raise BuildControlError("managed retirement replay returned an invalid state")
    _retirement_scope(
        retirement.get("api_request_scope_epoch"),
        "managed retirement replay API incarnation",
    )
    active_after = _read_control_bytes(control, "active", maximum=256)
    if not _retirement_lease_matches(active_after, operation_id):
        raise ControlOutcomeUnknown("retained retirement control lease changed before finalization")
    receipt_after = _read_control_bytes(control, root + "/receipt.json")
    if receipt_after != receipt_raw:
        raise ControlOutcomeUnknown("retained retirement receipt changed before finalization")
    terminal = dict(receipt)
    terminal.update(
        state="failed-confirmed",
        activation_state="retirement-replayed",
        retirement=dict(retirement),
        retirement_resume_state="succeeded",
    )
    _finalize_retained_retirement(
        control,
        operation_id=operation_id,
        receipt_raw=receipt_raw,
        retained_receipt=receipt,
        result=result,
        terminal=terminal,
    )


def activate(args: argparse.Namespace) -> dict[str, object]:
    from docker_dev import _compose_identity, _select_source
    from docker_dev_host import require_host

    require_host()
    if not ATTEMPT_RE.fullmatch(args.attempt):
        raise BuildControlError("Script activation requires an exact attempt UUID")
    if not SHA256_RE.fullmatch(args.config_sha256):
        raise BuildControlError("Script activation requires a lowercase config SHA-256")
    repo = Path(args.repo_root).resolve(strict=True)
    selected, layout = _select_source(repo, args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, helper_image)
    control.prepare()

    root = "development/attempts/" + args.attempt
    terminal = control.read(root + "/terminal.json")
    document = control.read(root + "/compose.json")
    if not isinstance(terminal, Mapping):
        raise BuildControlError("Retained DEV terminal is not an object")
    if not isinstance(document, Mapping):
        raise BuildControlError("Retained Compose configuration is not an object")
    if terminal.get("compose_project") != control.project:
        raise BuildControlError("Retained DEV attempt belongs to another Compose group")
    if hashlib.sha256(canonical(document)).hexdigest() != args.config_sha256:
        raise BuildControlError("Retained Compose configuration/CAS differs")
    if terminal.get("config_sha256") not in (None, args.config_sha256):
        raise BuildControlError("Retained terminal receipt/config pin differs")
    inputs = terminal.get("inputs")
    if not isinstance(inputs, Mapping) or inputs.get("source_root") != str(selected):
        raise BuildControlError("Retained source selection differs")
    image = inputs.get("image_id")
    if not isinstance(image, str) or not IMAGE_ID_RE.fullmatch(image):
        raise BuildControlError("Retained backend image is not immutable")
    runtime_terminals = _linked_runtime_terminals(
        control,
        args.attempt,
        terminal,
        source_root=str(selected),
        image=image,
        config_sha256=args.config_sha256,
    )
    backend_id = frontend_id = None
    validation_error = None
    for runtime_terminal in runtime_terminals:
        try:
            backend_id, frontend_id = _validate_running_group(
                control, identity, document, runtime_terminal, image,
                source_root=str(selected),
            )
            break
        except BuildControlError as error:
            validation_error = error
    if backend_id is None or frontend_id is None:
        detail = f": {validation_error}" if validation_error else ""
        raise BuildControlError("No linked runtime terminal matches the running Compose group" + detail)

    # An earlier startup activation may have reached the backend before the
    # host lost observation.  Its image-owned marker is deliberately retained
    # and fences every later POST/RunIntent until a canonical recovery route
    # proves the outcome; a new request must never bypass that quarantine.
    from docker_volume_activation_reconcile import assert_no_unresolved_activation
    assert_no_unresolved_activation(
        control,
        development_attempt=args.attempt,
        config_sha256=args.config_sha256,
        source_root=str(selected),
        image_id=image,
        backend_container=backend_id,
        request_id=args.request_id,
    )

    from docker_volume_dev import _startup_helper

    startup_helper, helper_hashes = _startup_helper(control, selected, image)
    activation_timeout_seconds, _original_activation_receipt_path = _activation_contract(startup_helper)
    retained_retirement = _retained_retirement_context(
        control,
        development_attempt=args.attempt,
        config_sha256=args.config_sha256,
        source_root=str(selected),
        image_id=image,
        backend_id=backend_id,
    )
    if retained_retirement is not None:
        retained_receipt, retirement_context, retained_receipt_raw = retained_retirement
        if retirement_context.get("phase") == "startup":
            raise ControlOutcomeUnknown(
                "startup activation outcome is unknown; canonical marker/quarantine reconciliation is required"
            )
        _resume_retained_retirement(
            control,
            backend_id=backend_id,
            operation_id=str(retirement_context["operation_id"]),
            context=retirement_context,
            receipt=retained_receipt,
            receipt_raw=retained_receipt_raw,
            helper_sha256=helper_hashes["docker_startup_script.py"],
            activation_timeout_seconds=activation_timeout_seconds,
        )
    source_commit = storage.git(selected, "rev-parse", "HEAD")
    probe_request_id = args.request_id or f"docker-volume-{args.attempt}-probe"
    authorization = startup_helper.prepare(
        selected,
        args.script,
        request_id=probe_request_id,
        source_commit=source_commit,
    )
    request_id = _request_id(startup_helper, args.attempt, authorization.source_sha256, args.request_id)
    if request_id != authorization.request_id:
        authorization = startup_helper.prepare(
            selected,
            args.script,
            request_id=request_id,
            source_commit=source_commit,
        )
    activation_receipt_key, activation_receipt_path = _managed_activation_receipt_contract(
        startup_helper, authorization.request_id
    )
    authorization_document = authorization.as_dict()
    provenance = _authorization_bytes(startup_helper, authorization_document)
    provenance_sha256 = hashlib.sha256(provenance).hexdigest()

    inputs = _activation_operation_inputs(
        development_attempt=args.attempt,
        config_sha256=args.config_sha256,
        source_root=str(selected),
        image=image,
        source_relative=authorization.source_relative,
        source_sha256=authorization.source_sha256,
        request_id=authorization.request_id,
        provenance_sha256=provenance_sha256,
        backend_container=backend_id,
        activation_receipt_key=activation_receipt_key,
        activation_receipt_path=activation_receipt_path,
    )
    with control.operation("activation", inputs) as operation:
        operation["receipt"].update(inputs, state="preparing")
        provenance_relative = operation["root"] + "/startup-provenance.json"
        control.write_bytes(provenance_relative, provenance)
        control.write(operation["root"] + "/authorization.json", authorization_document)
        retirement_operation_id = operation["receipt"].get("attempt")
        if not isinstance(retirement_operation_id, str) or not ATTEMPT_RE.fullmatch(retirement_operation_id):
            raise BuildControlError("Activation operation has no valid retirement operation id")
        retirement_inputs_sha256 = _retirement_inputs_sha256(inputs)
        operation["receipt"].update(
            state="outcome-unknown-resources-retained",
            provenance_path=CONTROL_ROOT + "/" + provenance_relative,
            helper_sha256=helper_hashes["docker_startup_script.py"],
            retirement_phase="retirement",
            retirement_inputs_sha256=retirement_inputs_sha256,
        )
        # Publish the pre-retirement pins before the first API call.  A lost
        # host process therefore leaves a recognizable exact operation rather
        # than an unclassifiable active lease.
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        operation["daemon_pending"] = True
        try:
            retirement_result = _run_fixed_activation(
                backend_id,
                script_path=None,
                provenance_path=None,
                provenance_sha256=None,
                helper_sha256=helper_hashes["docker_startup_script.py"],
                activation_timeout_seconds=activation_timeout_seconds,
                retirement_operation_id=retirement_operation_id,
                retirement_inputs_sha256=retirement_inputs_sha256,
                retirement_only=True,
            )
        except ControlOutcomeUnknown as error:
            retirement_context = getattr(error, "retirement", None)
            if isinstance(retirement_context, Mapping):
                operation["receipt"]["retirement"] = dict(retirement_context)
            operation["receipt"]["retirement_result"] = {
                "state": "unknown",
                "error": str(error)[-4096:],
            }
            raise
        except BuildControlError:
            operation["daemon_pending"] = False
            raise
        operation["receipt"]["retirement_phase"] = "startup"
        operation["receipt"]["retirement_result"] = dict(retirement_result)
        if isinstance(retirement_result.get("retirement"), Mapping):
            operation["receipt"]["retirement"] = dict(retirement_result["retirement"])
        # This is the boundary: the exact retirement response and all startup
        # request pins are durable before the startup POST can be attempted.
        control.write(operation["root"] + "/receipt.json", operation["receipt"])
        try:
            result = _run_fixed_activation(
                backend_id,
                script_path=authorization.container_script_path,
                provenance_path=CONTROL_ROOT + "/" + provenance_relative,
                provenance_sha256=provenance_sha256,
                helper_sha256=helper_hashes["docker_startup_script.py"],
                activation_timeout_seconds=activation_timeout_seconds,
                activation_receipt_path=activation_receipt_path,
                activation_receipt_key=activation_receipt_key,
            )
        except ControlOutcomeUnknown:
            # The receipt already records phase=startup.  Reconciliation must
            # consume the image-owned startup marker; this route must not run
            # retirement again or construct a second RunIntent.
            raise
        except BuildControlError:
            operation["daemon_pending"] = False
            raise
        control.write(operation["root"] + "/result.json", result)
        # Keep the lease pending until the terminal technical receipt is
        # durable.  A committed API result with a failed receipt publication
        # must not look like a safe retry.
        _record_activation_result(operation, result)
        return dict(result)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--script", type=Path, required=True)
    parser.add_argument("--request-id")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        activate(args)
    except (BuildControlError, OSError, ValueError) as error:
        print(f"docker-dev-script: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
