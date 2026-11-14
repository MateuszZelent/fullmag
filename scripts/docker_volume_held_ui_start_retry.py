"""Exact, one-shot continuation of a failed held-UI pre-materialization start.

The lifecycle controller lives in :mod:`docker_volume_dev`; this module owns
the closed plan format, option boundary, and immutable archive restore helper.
It never submits Compute or changes the accepted RunIntent.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from collections.abc import Mapping
from pathlib import PurePosixPath

from docker_build_control import BuildControlError, canonical


PLAN_SCHEMA = "fullmag.held-ui-start-retry-plan.v1"
RETRY_CONTEXT_SCHEMA = "fullmag.docker-failed-held-ui-start-retry-context.v1"
TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CONTAINER_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
RUN_ID_RE = re.compile(r"^run-[A-Za-z0-9_-]{1,128}$")
MAX_AUTHORITY_BYTES = 256 * 1024
MAX_PLAN_BYTES = 2 * 1024 * 1024

PLAN_FIELDS = {
    "schema", "original", "failed", "namespace", "runtime",
    "released_snapshot_sha256", "native_locks", "certificate",
    "frontend_handoff", "authority_sha256", "new_source",
}
ORIGINAL_FIELDS = {
    "attempt", "config_sha256", "request_id", "run_id", "plan_sha256",
    "request_sha256", "recreate_terminal_sha256",
}
FAILED_FIELDS = {
    "attempt", "terminal_sha256", "compose_sha256", "config_sha256",
    "verified_sha256", "backend_container_id", "frontend_container_id",
    "backend_started_at", "frontend_started_at", "image_id",
}
NAMESPACE_FIELDS = {
    "compose_project", "control_volume", "namespace", "namespace_registry_sha256",
    "source_root", "state_root", "accepted_store", "accepted_store_binding",
}
RUNTIME_FIELDS = {
    "process_sha256", "failure_fence_relative", "failure_fence_sha256",
    "launch_sha256", "launch_id", "input_sha256", "native_config_sha256",
    "api_pin", "store_snapshot",
}
CERTIFICATE_FIELDS = {
    "sha256", "owner_sha256", "owner_token", "image_id", "host_inode",
    "storage_profile", "restart_verified",
}
FRONTEND_HANDOFF_FIELDS = {
    "schema", "attempt", "terminal_sha256", "current_sha256", "compose_sha256",
    "verified_sha256", "source_root", "state_root", "frontend_generation_id",
    "frontend_generation_subpath",
}
NATIVE_LOCK_NAMES = (
    "owner", "startup_gate", "launch", "host_inventory_owner",
)
AUTHORITY_FILENAMES = (
    "request.json", "preflight.json", "inventory.json", "api-quiescence-intent.json",
    "api-quiescence-start.json", "api-quiescence.json", "native-drain.json",
    "recreate-start.json",
)
AUTHORITY_NAMES = AUTHORITY_FILENAMES


class RetryError(BuildControlError):
    """The retained failed-start retry authority is incomplete or changed."""


def _fail(message: str) -> None:
    raise RetryError(message)


def _exact_keys(value, expected, label):
    if not isinstance(value, Mapping) or set(value) != expected:
        _fail(label + " has missing or unexpected fields")


def _sha(value, label):
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        _fail(label + " is not lowercase SHA-256")
    return value


def _token(value, label):
    if not isinstance(value, str) or TOKEN_RE.fullmatch(value) is None:
        _fail(label + " is not a 32-character operation token")
    return value


def _text(value, label, maximum=4096):
    if (not isinstance(value, str) or not value or len(value) > maximum
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        _fail(label + " is malformed")
    return value


def _absolute_path(value, label):
    text = _text(value, label)
    path = PurePosixPath(text)
    if not path.is_absolute() or ".." in path.parts or str(path) != text:
        _fail(label + " is not a normalized absolute POSIX path")
    return text


def _json_only(value, label):
    """Reject floats and non-JSON values before computing a cross-process plan hash."""
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int):
        return
    if isinstance(value, list):
        for item in value:
            _json_only(item, label)
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                _fail(label + " contains a non-string object key")
            _json_only(item, label)
        return
    _fail(label + " contains a noncanonical transport value")


def validate_plan(plan):
    """Validate the exact immutable retry plan shape and cross-field bindings."""
    _exact_keys(plan, PLAN_FIELDS, "Held UI retry plan")
    if plan.get("schema") != PLAN_SCHEMA:
        _fail("Held UI retry plan schema is unsupported")
    _json_only(plan, "Held UI retry plan")

    original = plan["original"]
    _exact_keys(original, ORIGINAL_FIELDS, "Original held UI authority")
    _token(original["attempt"], "Original development attempt")
    _sha(original["config_sha256"], "Original Compose digest")
    if not isinstance(original["request_id"], str) or UUID_RE.fullmatch(original["request_id"]) is None:
        _fail("Original maintenance request id is malformed")
    if not isinstance(original["run_id"], str) or RUN_ID_RE.fullmatch(original["run_id"]) is None:
        _fail("Original accepted run id is malformed")
    for key in ("plan_sha256", "request_sha256", "recreate_terminal_sha256"):
        _sha(original[key], "Original " + key)

    failed = plan["failed"]
    _exact_keys(failed, FAILED_FIELDS, "Failed held UI start")
    _token(failed["attempt"], "Failed development attempt")
    if failed["attempt"] == original["attempt"]:
        _fail("Failed start cannot replace its immutable original development parent")
    for key in ("terminal_sha256", "compose_sha256", "config_sha256", "verified_sha256"):
        _sha(failed[key], "Failed " + key)
    for key in ("backend_container_id", "frontend_container_id"):
        value = failed[key]
        if not isinstance(value, str) or CONTAINER_RE.fullmatch(value) is None:
            _fail("Failed service container id is malformed")
    if failed["backend_container_id"] == failed["frontend_container_id"]:
        _fail("Failed backend and frontend container identities collide")
    for key in ("backend_started_at", "frontend_started_at"):
        _text(failed[key], "Failed " + key)
    if not isinstance(failed["image_id"], str) or IMAGE_RE.fullmatch(failed["image_id"]) is None:
        _fail("Failed backend image identity is malformed")

    new_source = plan["new_source"]
    _exact_keys(new_source, {"commit", "source_digest", "source_snapshot_sha256"},
                "New managed retry source")
    if not isinstance(new_source["commit"], str) or re.fullmatch(r"[0-9a-f]{40}", new_source["commit"]) is None:
        _fail("New managed retry source commit is malformed")
    _sha(new_source["source_digest"], "New managed retry source digest")
    _sha(new_source["source_snapshot_sha256"], "New managed retry source snapshot")

    namespace = plan["namespace"]
    _exact_keys(namespace, NAMESPACE_FIELDS, "Retained retry namespace")
    for key in ("compose_project", "control_volume"):
        _text(namespace[key], "Retained " + key)
    namespace_name = namespace["namespace"]
    if (not isinstance(namespace_name, str) or len(namespace_name) > 256
            or any(ord(char) < 32 or ord(char) == 127 for char in namespace_name)):
        _fail("Retained namespace is malformed")
    _absolute_path(namespace["source_root"], "Selected source root")
    _absolute_path(namespace["state_root"], "Retained session state root")
    _absolute_path(namespace["accepted_store"], "Accepted session store")
    _sha(namespace["accepted_store_binding"], "Accepted store binding")
    registry = namespace["namespace_registry_sha256"]
    if namespace["namespace"]:
        _sha(registry, "Namespace registry digest")
    elif registry is not None:
        _fail("Unnamespaced retry cannot carry a namespace registry digest")

    runtime = plan["runtime"]
    _exact_keys(runtime, RUNTIME_FIELDS, "Retained runtime evidence")
    for key in ("process_sha256", "failure_fence_sha256", "launch_sha256",
                "input_sha256", "native_config_sha256"):
        _sha(runtime[key], "Runtime " + key)
    relative = _text(runtime["failure_fence_relative"], "Failure fence path")
    parsed = PurePosixPath(relative)
    if parsed.is_absolute() or str(parsed) != relative or ".." in parsed.parts:
        _fail("Failure fence path is not a bounded relative path")
    if not isinstance(runtime["launch_id"], str) or UUID_RE.fullmatch(runtime["launch_id"]) is None:
        _fail("Failed launch id is malformed")
    if not isinstance(runtime["api_pin"], Mapping) or not runtime["api_pin"]:
        _fail("Diagnostic API identity pin is missing")
    if not isinstance(runtime["store_snapshot"], Mapping):
        _fail("Released store snapshot is missing")
    # The runtime snapshot pins accepted-run/CAS identities; the separate
    # released snapshot pins the host ledger and local resource leases. They
    # are independent observations and must never be conflated.
    _sha(plan["released_snapshot_sha256"], "Released snapshot digest")

    locks = plan["native_locks"]
    _exact_keys(locks, set(NATIVE_LOCK_NAMES), "Native lock identities")
    for name in NATIVE_LOCK_NAMES:
        identity = locks[name]
        _exact_keys(identity, {"device", "inode", "unlocked"}, name + " identity")
        if identity["unlocked"] is not True:
            _fail(name + " is still locked")
        for key in ("device", "inode"):
            if type(identity[key]) is not int or identity[key] <= 0:
                _fail(name + " has an invalid " + key)

    certificate = plan["certificate"]
    _exact_keys(certificate, CERTIFICATE_FIELDS, "Retained host certificate")
    _sha(certificate["sha256"], "Host certificate digest")
    _sha(certificate["owner_sha256"], "Host owner-marker digest")
    if certificate["sha256"] != certificate["owner_sha256"]:
        _fail("Host certificate and owner marker bytes differ")
    if not isinstance(certificate["owner_token"], str) or TOKEN_RE.fullmatch(certificate["owner_token"]) is None:
        _fail("Host certificate owner token is malformed")
    if not isinstance(certificate["image_id"], str) or IMAGE_RE.fullmatch(certificate["image_id"]) is None:
        _fail("Host certificate image id is malformed")
    if type(certificate["host_inode"]) is not int or certificate["host_inode"] <= 0:
        _fail("Host certificate state inode is malformed")
    if (certificate["storage_profile"] != "linux-native-v1"
            or type(certificate["restart_verified"]) is not bool
            or certificate["image_id"] != failed["image_id"]):
        _fail("Host certificate storage profile or verification state is malformed")

    handoff = plan["frontend_handoff"]
    _exact_keys(handoff, FRONTEND_HANDOFF_FIELDS, "Failed frontend generation handoff")
    if (handoff.get("schema") != "fullmag.frontend-start-handoff.v1"
            or handoff.get("attempt") != failed["attempt"]
            or handoff.get("terminal_sha256") != failed["terminal_sha256"]
            or handoff.get("current_sha256") != failed["terminal_sha256"]
            or handoff.get("compose_sha256") != failed["compose_sha256"]
            or handoff.get("verified_sha256") != failed["verified_sha256"]
            or handoff.get("source_root") != namespace["source_root"]
            or handoff.get("state_root") != namespace["state_root"]):
        _fail("Frontend handoff is not bound to the failed current parent")
    generation = handoff.get("frontend_generation_id")
    if not isinstance(generation, str) or TOKEN_RE.fullmatch(generation) is None:
        _fail("Frontend generation id is malformed")
    if handoff.get("frontend_generation_subpath") != "private/frontend/generations/" + generation:
        _fail("Frontend generation subpath differs from its exact generation id")

    authority = plan["authority_sha256"]
    _exact_keys(authority, set(AUTHORITY_FILENAMES), "Immutable held UI authority hashes")
    for name, digest in authority.items():
        _sha(digest, "Immutable " + name + " digest")
    return plan


def canonical(value) -> bytes:
    """The stable compact representation used by the preview/apply plan CAS."""
    _json_only(value, "Canonical held UI retry data")
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise RetryError("Held UI retry data cannot be canonically encoded") from error


def plan_digest(plan) -> str:
    validate_plan(plan)
    raw = canonical(plan)
    if len(raw) > MAX_PLAN_BYTES:
        _fail("Held UI retry plan exceeds its bounded size")
    return hashlib.sha256(raw).hexdigest()


def retry_plan(body) -> dict:
    """Return the validated plan and its immutable preview digest."""
    digest = plan_digest(body)
    return body, digest


def validate_retry_options(args):
    """Validate the CLI boundary before any control reads or lifecycle calls."""
    original_attempt = _token(getattr(args, "attempt", None), "Original development attempt")
    failed_attempt = _token(getattr(args, "failed_held_start_attempt", None), "Failed development attempt")
    if original_attempt == failed_attempt:
        _fail("Original and failed development attempts must be distinct")
    _sha(getattr(args, "config_sha256", None), "Original development config digest")
    _sha(getattr(args, "expected_plan_sha256", None), "Original held UI plan digest")
    _sha(getattr(args, "failed_held_start_sha256", None), "Failed terminal digest")
    request_id = getattr(args, "request_id", None)
    if not isinstance(request_id, str) or UUID_RE.fullmatch(request_id) is None:
        _fail("Maintenance request id is malformed")
    run_id = getattr(args, "run_id", None)
    if not isinstance(run_id, str) or RUN_ID_RE.fullmatch(run_id) is None:
        _fail("Accepted run id is malformed")
    source_root = _absolute_path(str(getattr(args, "source_root", "")), "Selected source root")
    port = getattr(args, "port", None)
    if type(port) is not int or not 1024 <= port <= 65535:
        _fail("Frontend port is outside its valid range")
    preview, apply = getattr(args, "preview", False), getattr(args, "apply", False)
    if type(preview) is not bool or type(apply) is not bool or preview == apply:
        _fail("Select exactly one held UI retry mode")
    retry_sha = getattr(args, "retry_plan_sha256", None)
    if apply:
        _sha(retry_sha, "Retry apply plan digest")
    elif retry_sha is not None:
        _fail("Retry preview cannot carry an apply plan digest")
    for forbidden in ("script", "fresh_state", "restart_backend", "resume_recreation"):
        value = getattr(args, forbidden, None)
        if value not in (None, False, ""):
            _fail("Held UI retry cannot combine with " + forbidden)
    return {
        "attempt": original_attempt, "failed_attempt": failed_attempt,
        "request_id": request_id, "run_id": run_id, "source_root": source_root,
        "port": port, "apply": apply, "preview": preview,
    }


def validate_apply_digest(actual: str, expected: str) -> None:
    _sha(actual, "Current retry plan digest")
    _sha(expected, "Approved retry plan digest")
    if actual != expected:
        _fail("Held UI retry plan changed after preview; no operation was started")


def validate_apply_plan(plan, expected_sha256: str) -> str:
    """Recompute the live plan and compare it to the explicit apply pin."""
    actual = plan_digest(plan)
    validate_apply_digest(actual, expected_sha256)
    return actual


def restore_archived_authority(control, archive_attempt: str, request_id: str,
                               expected_raw_by_name: Mapping[str, bytes]) -> dict[str, str]:
    """Restore only the eight original authority files, byte-for-byte, after archive.

    Every source is read and checked before the first destination is written.
    Existing destinations are an outcome-unknown condition and are never replaced.
    """
    _token(archive_attempt, "Runtime-control archive attempt")
    if not isinstance(request_id, str) or UUID_RE.fullmatch(request_id) is None:
        _fail("Original request id is malformed")
    _exact_keys(expected_raw_by_name, set(AUTHORITY_FILENAMES), "Archived authority byte set")
    request_root = "held-ui-materialization/" + request_id
    raw_by_name: dict[str, bytes] = {}
    for name in AUTHORITY_FILENAMES:
        expected = expected_raw_by_name[name]
        if not isinstance(expected, bytes) or len(expected) > MAX_AUTHORITY_BYTES:
            _fail("Expected archived " + name + " bytes are missing or exceed their bound")
        expected_digest = hashlib.sha256(expected).hexdigest()
        relative = request_root + "/" + name
        archive_path = "runtime-archives/" + archive_attempt + "/" + relative
        try:
            raw = control.read_bytes(archive_path, maximum=MAX_AUTHORITY_BYTES)
        except (OSError, BuildControlError) as error:
            raise RetryError("Archived " + name + " is unavailable") from error
        if not isinstance(raw, bytes) or len(raw) > MAX_AUTHORITY_BYTES:
            _fail("Archived " + name + " is missing or exceeds its bound")
        if hashlib.sha256(raw).hexdigest() != expected_digest or raw != expected:
            _fail("Archived " + name + " differs from its pre-archive byte pin")
        raw_by_name[name] = raw
    destinations = {name: "runtime-control/" + request_root + "/" + name
                    for name in AUTHORITY_FILENAMES}
    for name, relative in destinations.items():
        if control.read_bytes(relative, optional=True, maximum=MAX_AUTHORITY_BYTES) is not None:
            _fail("Fresh runtime already contains held UI authority " + name)
    from docker_volume_pre_ack_retry import _publish_raw
    for name, relative in destinations.items():
        try:
            _publish_raw(control, relative, raw_by_name[name], maximum=MAX_AUTHORITY_BYTES)
            restored = control.read_bytes(relative, maximum=MAX_AUTHORITY_BYTES)
        except (OSError, BuildControlError) as error:
            raise RetryError("Create-only held UI authority restore failed: " + name) from error
        if restored != raw_by_name[name]:
            _fail("Restored held UI authority bytes did not read back: " + name)
    return {name: hashlib.sha256(raw_by_name[name]).hexdigest() for name in AUTHORITY_FILENAMES}


def run(args):
    """Delegate the managed lifecycle to its existing DEV owner after CLI validation."""
    validate_retry_options(args)
    import docker_volume_held_ui_start_retry_lifecycle as lifecycle
    return lifecycle.run(args, controller=sys.modules[__name__])
