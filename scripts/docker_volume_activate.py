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
import hashlib
import json
import os
from collections.abc import Mapping
from pathlib import Path, PurePath, PurePosixPath
import re
import sys
import uuid

import fullmag_storage as storage
from docker_build_control import (
    BuildControl,
    BuildControlError,
    ControlOutcomeUnknown,
    canonical,
    compose_capture,
    docker_capture,
    toolchain_configuration,
)


ATTEMPT_RE = re.compile(r"^[0-9a-f]{32}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
CONTROL_ROOT = "/opt/fullmag/control"
ACTIVATE_EXIT_UNKNOWN = 75

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
    if (
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
    script_path: str,
    provenance_path: str,
    provenance_sha256: str,
    helper_sha256: str,
    activation_timeout_seconds: float,
    activation_receipt_path: str,
    activation_receipt_key: str,
) -> dict[str, object]:
    environment = (
        "FULLMAG_STARTUP_ENABLED=1",
        "FULLMAG_STARTUP_SCRIPT=" + script_path,
        "FULLMAG_STARTUP_PROVENANCE=" + provenance_path,
        "FULLMAG_STARTUP_PROVENANCE_SHA256=" + provenance_sha256,
        "FULLMAG_STARTUP_HELPER_SHA256=" + helper_sha256,
        "FULLMAG_STARTUP_RECEIPT_KEY=" + activation_receipt_key,
        "FULLMAG_STARTUP_API=http://127.0.0.1:8081",
    )
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
        if value is None or value.get("state") not in {"activated", "rejected"}:
            raise BuildControlError("Backend activation wrapper returned no terminal result")
        return value
    if value is not None and value.get("state") == "unknown":
        raise ControlOutcomeUnknown(
            "Startup activation outcome is unknown; activation.json prevents retry: "
            + str(value.get("error", "No diagnostic supplied"))[-4096:]
        )
    marker = docker_capture(
        "exec",
        backend_id,
        "test",
        "-f",
        activation_receipt_path,
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
    if result["state"] == "rejected":
        raise BuildControlError(
            "Backend activation was rejected; terminal activation receipt retained and retry is forbidden"
        )


def activate(args: argparse.Namespace) -> None:
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
        operation["receipt"].update(
            state="executing",
            provenance_path=CONTROL_ROOT + "/" + provenance_relative,
            helper_sha256=helper_hashes["docker_startup_script.py"],
        )
        operation["daemon_pending"] = True
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
            raise
        except BuildControlError:
            operation["daemon_pending"] = False
            raise
        control.write(operation["root"] + "/result.json", result)
        # Keep the lease pending until the terminal technical receipt is
        # durable.  A committed API result with a failed receipt publication
        # must not look like a safe retry.
        _record_activation_result(operation, result)


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
