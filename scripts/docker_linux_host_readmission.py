#!/usr/bin/env python3
"""Explicitly readmit one retained Linux DEV store after a WSL device drift.

The default invocation is read-only. ``--execute`` publishes only the
precomputed certificate and owner-marker bytes while the selected Compose
operation, native OWNER lock, and host WRITER lock are all held. It never
starts or removes application containers and never changes runtime records.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import select
import stat
import subprocess
import sys
import uuid

# This is an operator CLI, and even its default validation mode must not
# create source-tree bytecode as a side effect of importing project helpers.
sys.dont_write_bytecode = True

from docker_build_control import (
    BuildControl,
    BuildControlError,
    ControlOutcomeUnknown,
    canonical,
    docker_capture,
    toolchain_configuration,
)
from docker_compose_identity import compose_project_identity, source_labels
from docker_development_inputs import select_checkout
import docker_dev_host
import fullmag_storage as storage
import linux_native_host as host
import linux_native_readmission as native


OPERATOR_SCHEMA = "fullmag.linux-host-readmission-operator.v1"
PREPARED_SCHEMA = "fullmag.linux-host-readmission-prepared.v1"
RESULT_SCHEMA = "fullmag.linux-host-readmission-result.v1"
PHASE = "linux-host-readmission"
MAX_OPERATOR_BYTES = 256 * 1024
MAX_RECORD_BYTES = 1024 * 1024
MAX_CONTROL_BYTES = 8 * 1024 * 1024
MAX_RUNNING_CONTAINERS = 8192
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
_CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")
_ATTEMPT = re.compile(r"[0-9a-f]{32}\Z")
_PROJECT = re.compile(r"[a-z0-9][a-z0-9_-]*\Z")
_OWNER_LOCK = "runtime-control/runtime-services/OWNER.lock"
_RUNTIME_RECORDS = {
    "runtime_owner": "runtime-control/runtime-services/OWNER.json",
    "process_receipt": "runtime-control/runtime-service/process-tree.json",
    "runtime_config": "runtime-control/runtime-service/docker-all.json",
    "launch": "runtime-control/runtime-services/LAUNCH.json",
}
_RUNTIME_HASH_FIELDS = {
    "runtime_owner": "runtime_owner_sha256",
    "process_receipt": "process_receipt_sha256",
    "runtime_config": "runtime_config_sha256",
    "launch": "launch_sha256",
}
_NATIVE_RELATIVES = {
    "certificate": host.CERTIFICATE_NAME,
    "owner_marker": host.OWNER_NAME,
    "sentinel": ".linux-native-sentinel",
    "restart": ".linux-native-restart",
    "probe": ".linux-native-probe.json",
}
_ARCHIVE_NAMES = (
    "request", "terminal", "compose", "certificate", "owner_marker", "sentinel",
    "restart", "probe", "runtime_owner", "process_receipt", "runtime_config", "launch",
)
_WSL_ALIAS_PREFIXES = (
    "/run/desktop/mnt/host/wsl/",
    "/mnt/host/wsl/",
    "/mnt/wsl/docker-desktop-bind-mounts/",
)
_DESKTOP_HOST_PREFIXES = (
    "/run/desktop/mnt/host/", "/host_mnt/", "/mnt/host/",
)


class ReadmissionError(BuildControlError):
    """A requested host readmission could not be proved safely."""


def _fail(message):
    raise ReadmissionError(message)


def _reject_duplicate_keys(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("readmission JSON contains a duplicate key")
        value[key] = item
    return value


def _reject_json_constant(value):
    raise ValueError("readmission JSON contains a non-JSON numeric value")


def _parse_object(raw, label):
    if not isinstance(raw, bytes) or len(raw) > MAX_CONTROL_BYTES:
        raise ValueError(label + " exceeds its byte limit")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys,
                           parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError(label + " is not unambiguous UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ValueError(label + " must be a JSON object")
    return value


def _strict_int(value, label, *, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError(label + " must be a strict integer")
    return value


def _sha(value, label):
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None or value == "0" * 64:
        raise ValueError(label + " must be a non-placeholder lowercase SHA-256")
    return value


def _bounded_text(value, label, maximum=4096):
    if (not isinstance(value, str) or not value or len(value) > maximum
            or any(ord(character) < 0x20 or ord(character) == 0x7f for character in value)):
        raise ValueError(label + " must be bounded non-empty text without control characters")
    return value


def _canonical_uuid(value, label):
    if not isinstance(value, str):
        raise ValueError(label + " must be a canonical lowercase UUID")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError, TypeError) as error:
        raise ValueError(label + " must be a canonical lowercase UUID") from error
    if parsed.int == 0 or str(parsed) != value:
        raise ValueError(label + " must be a canonical nonzero lowercase UUID")
    return value


def parse_operator_bytes(raw):
    """Validate the exact frozen operator JSON and all strict scalar types."""
    value = _parse_object(raw, "Linux host readmission operator request")
    required = {
        "schema_version", "request_id", "source_root", "compose_project",
        "development_attempt", "compose_config_sha256", "backend_container_id",
        "frontend_container_id", "old_image_id", "expected_certificate_sha256",
        "expected_owner_sha256", "old_host_device", "new_host_device", "expected_inode",
        "filesystem_uuid", "runtime_owner_sha256", "process_receipt_sha256",
        "runtime_config_sha256", "launch_sha256",
    }
    if set(value) != required:
        raise ValueError("operator request fields do not match the frozen readmission schema")
    if value.get("schema_version") != OPERATOR_SCHEMA:
        raise ValueError("operator request schema_version is unsupported")
    _canonical_uuid(value.get("request_id"), "request_id")
    source = _bounded_text(value.get("source_root"), "source_root")
    source_path = Path(source)
    if not source_path.is_absolute() or ".." in source_path.parts:
        raise ValueError("source_root must be an absolute path without traversal")
    if str(source_path) != os.path.normpath(source):
        raise ValueError("source_root must use a normalized absolute path")
    if _PROJECT.fullmatch(value.get("compose_project", "")) is None:
        raise ValueError("compose_project is invalid")
    if _ATTEMPT.fullmatch(value.get("development_attempt", "")) is None:
        raise ValueError("development_attempt must be an exact lowercase attempt UUID")
    for key in ("compose_config_sha256", "expected_certificate_sha256", "expected_owner_sha256",
                "runtime_owner_sha256", "process_receipt_sha256", "runtime_config_sha256",
                "launch_sha256"):
        _sha(value.get(key), key)
    for key in ("backend_container_id", "frontend_container_id"):
        if _CONTAINER_ID.fullmatch(value.get(key, "")) is None:
            raise ValueError(key + " must be a complete lowercase Docker container ID")
    if _IMAGE_ID.fullmatch(value.get("old_image_id", "")) is None:
        raise ValueError("old_image_id must be an immutable image ID")
    old_device = _strict_int(value.get("old_host_device"), "old_host_device")
    new_device = _strict_int(value.get("new_host_device"), "new_host_device")
    if old_device == new_device:
        raise ValueError("readmission requires an actual host_device change")
    _strict_int(value.get("expected_inode"), "expected_inode", minimum=1)
    _canonical_uuid(value.get("filesystem_uuid"), "filesystem_uuid")
    return value


def _read_operator_file(path):
    request_path = Path(path).expanduser()
    if not request_path.is_absolute():
        request_path = Path.cwd() / request_path
    raw = host.read_owned_regular(request_path, MAX_OPERATOR_BYTES)
    return parse_operator_bytes(raw), raw, request_path


def _json_sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _record(raw, label):
    if not isinstance(raw, bytes) or len(raw) > MAX_RECORD_BYTES:
        raise ValueError(label + " exceeds its raw evidence limit")
    return {"sha256": _json_sha(raw), "base64": base64.b64encode(raw).decode("ascii")}


def _unrecord(value, label):
    if not isinstance(value, dict) or set(value) != {"sha256", "base64"}:
        raise ValueError(label + " raw archive is malformed")
    expected = _sha(value.get("sha256"), label + " raw archive SHA-256")
    encoded = value.get("base64")
    if not isinstance(encoded, str):
        raise ValueError(label + " raw archive bytes are missing")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError(label + " raw archive is not valid base64") from error
    if len(raw) > MAX_RECORD_BYTES or _json_sha(raw) != expected:
        raise ValueError(label + " raw archive does not match its SHA-256")
    return raw


def _load_managed_context(repo_root, source_root, request):
    """Resolve only already-registered sources and read-only managed identities."""
    if os.name == "nt" or not sys.platform.startswith("linux"):
        _fail("Linux host readmission is supported only on a Linux/WSL host")
    docker_dev_host.require_host()
    repo = Path(repo_root).resolve(strict=True)
    selected = select_checkout(repo, source_root).resolve(strict=True)
    if not selected.is_dir() or selected.is_symlink():
        _fail("selected source is not a real registered checkout")
    if str(selected) != request["source_root"]:
        _fail("operator source_root differs from the selected registered checkout")
    layout = storage.resolve_layout(selected, "docker-all-gpu")
    identity = compose_project_identity(layout)
    if identity["project_name"] != request["compose_project"]:
        _fail("operator Compose project differs from the registered checkout identity")
    configured = toolchain_configuration(selected, identity)
    try:
        helper = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    except (KeyError, TypeError) as error:
        raise ReadmissionError("selected Compose toolchain has no immutable control-helper image") from error
    control = BuildControl(identity, helper)
    return {"repo": repo, "selected": selected, "layout": layout,
            "identity": identity, "control": control}


def _read_control(control, relative, maximum=MAX_CONTROL_BYTES):
    raw = control.read_bytes(relative, maximum=maximum)
    if not isinstance(raw, bytes) or not raw or len(raw) > maximum:
        raise ValueError("managed control record is empty or exceeds its byte limit: " + relative)
    return raw


def _terminal_paths(attempt):
    root = "development/attempts/" + attempt
    return root + "/terminal.json", root + "/compose.json"


def _validate_terminal_and_compose(control, request, identity, raw_terminal, raw_compose, layout):
    terminal = _parse_object(raw_terminal, "retained development terminal receipt")
    compose = _parse_object(raw_compose, "retained Compose document")
    inputs = terminal.get("inputs")
    if not isinstance(inputs, dict):
        raise ValueError("retained development terminal receipt has no inputs object")
    expected_sources = {
        "source_root": identity["source_root"],
        "source_project_id": identity["project_id"],
        "source_worktree_id": identity["worktree_id"],
        "source_checkout_kind": identity["checkout_kind"],
    }
    if (terminal.get("schema") != "fullmag.docker-build-operation.v1"
            or terminal.get("phase") != "development"
            or terminal.get("state") != "succeeded"
            or terminal.get("attempt") != request["development_attempt"]
            or terminal.get("compose_project") != control.project
            or terminal.get("config_sha256") != request["compose_config_sha256"]
            or terminal.get("backend_container") != request["backend_container_id"]
            or terminal.get("frontend_container") != request["frontend_container_id"]
            or any(inputs.get(key) != value for key, value in expected_sources.items())
            or inputs.get("image_id") != request["old_image_id"]
            or terminal.get("image_id", request["old_image_id"]) != request["old_image_id"]):
        raise ValueError("retained development receipt phase, attempt, source, image or service pins differ")
    if _json_sha(canonical(compose)) != request["compose_config_sha256"]:
        raise ValueError("retained Compose canonical SHA-256 differs from operator pins")
    if compose.get("name") != control.project:
        raise ValueError("retained Compose document belongs to another project")
    services = compose.get("services")
    if not isinstance(services, dict) or not all(isinstance(services.get(name), dict)
                                                  for name in ("backend", "frontend")):
        raise ValueError("retained Compose document has no fixed backend/frontend pair")
    state_root = terminal.get("state_root")
    if not isinstance(state_root, str) or not Path(state_root).is_absolute():
        raise ValueError("retained terminal receipt has no absolute state_root")
    state = storage.validate_path(Path(state_root), Path(layout["runtime_root"]),
                                  "retained Linux DEV state root")
    if not state.is_dir() or state.is_symlink():
        raise ValueError("retained terminal state_root is not an existing real directory")
    return terminal, compose, state


def _engine_id():
    result = docker_capture("info", "--format", "{{.ID}}", timeout=30)
    value = result.stdout.decode("utf-8", "strict").strip()
    # Info.ID is an opaque daemon identity, not a container/image digest.
    # Docker Desktop returns UUIDs; older engines also used colon-separated IDs.
    # The complete value is still compared exactly with the retained certificate.
    return _bounded_text(value, "current Docker engine ID", maximum=256)


def _filesystem_uuid(state):
    try:
        result = subprocess.run(
            ["findmnt", "--json", "--target", str(state), "--output", "UUID"],
            capture_output=True, timeout=15, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("cannot observe filesystem UUID for retained state root") from error
    if result.returncode != 0 or len(result.stdout) > 64 * 1024:
        raise ValueError("findmnt did not return a bounded filesystem UUID observation")
    value = _parse_object(result.stdout, "findmnt UUID observation")
    filesystems = value.get("filesystems")
    if not isinstance(filesystems, list) or len(filesystems) != 1 or not isinstance(filesystems[0], dict):
        raise ValueError("findmnt UUID observation is not one unambiguous filesystem")
    observed = filesystems[0].get("uuid")
    _canonical_uuid(observed, "observed filesystem UUID")
    return observed


def _read_native_files(state):
    return {name: host.read_owned_regular(Path(state) / relative, MAX_RECORD_BYTES)
            for name, relative in _NATIVE_RELATIVES.items()}


def _read_runtime_records(control, request):
    records = {}
    for name, relative in _RUNTIME_RECORDS.items():
        raw = _read_control(control, relative, MAX_RECORD_BYTES)
        _parse_object(raw, "native runtime record " + name)
        if _json_sha(raw) != request[_RUNTIME_HASH_FIELDS[name]]:
            raise ValueError("native runtime raw record SHA-256 differs: " + name)
        records[name] = raw
    return records


def _image_config(image_id):
    result = docker_capture("image", "inspect", image_id, timeout=45)
    documents = _parse_json_list(result.stdout, "retained DEV image inspect")
    if len(documents) != 1 or documents[0].get("Id") != image_id:
        raise ValueError("retained DEV image is unavailable by its exact immutable ID")
    config = documents[0].get("Config")
    if not isinstance(config, dict):
        raise ValueError("retained DEV image configuration is missing")
    return config


def _parse_json_list(raw, label):
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys,
                           parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError(label + " is not unambiguous JSON") from error
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError(label + " must return a JSON object array")
    return value


def _validate_stopped_state(actual):
    """Require a previously started container that is unambiguously exited."""
    state = actual.get("State") if isinstance(actual, dict) else None
    if not isinstance(state, dict):
        raise ValueError("retained service has no Docker State object")
    if (state.get("Status") != "exited" or state.get("Running") is not False
            or state.get("Paused") is not False or state.get("Restarting") is not False
            or type(state.get("Pid")) is not int or state["Pid"] != 0
            or type(state.get("ExitCode")) is not int or state["ExitCode"] < 0):
        raise ValueError("retained service is not exactly stopped with a strict integer exit code")

    def timestamp(value, label):
        if not isinstance(value, str) or not value or value.startswith("0001-01-01T"):
            raise ValueError("retained service " + label + " timestamp is missing")
        # Python 3.10's fromisoformat accepts only millisecond/microsecond
        # fractions. Docker emits RFC3339Nano. Parse the whole second with the
        # standard calendar parser and retain all nine fractional digits for
        # ordering; the original inspection strings are never rewritten.
        match = re.fullmatch(
            r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})",
            value,
        )
        if match is None:
            raise ValueError("retained service " + label + " timestamp is malformed")
        zone = "+00:00" if match.group(3) == "Z" else match.group(3)
        try:
            parsed = datetime.fromisoformat(match.group(1) + zone)
        except ValueError as error:
            raise ValueError("retained service " + label + " timestamp is malformed") from error
        stamp = (int(parsed.timestamp()), int((match.group(2) or "").ljust(9, "0")))
        now = datetime.now(timezone.utc)
        if stamp > (int(now.timestamp()) + 600, now.microsecond * 1000):
            raise ValueError("retained service " + label + " timestamp is in the future")
        return stamp

    started = timestamp(state.get("StartedAt"), "StartedAt")
    finished = timestamp(state.get("FinishedAt"), "FinishedAt")
    if finished < started:
        raise ValueError("retained service FinishedAt precedes StartedAt")


def _validate_stopped_service(actual, *, request, service, project, identity,
                              compose, image_config):
    if (actual.get("Id") != request[service + "_container_id"]
            or actual.get("Image") != request["old_image_id"]):
        raise ValueError("retained " + service + " container ID or immutable image differs")
    config = actual.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    if (not isinstance(labels, dict)
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != service
            or any(labels.get(key) != value for key, value in source_labels(identity).items())):
        raise ValueError("retained " + service + " Compose/source labels differ")
    expected_service = compose["services"][service]
    if expected_service.get("image") is not None and config.get("Image") != expected_service.get("image"):
        raise ValueError("retained " + service + " Compose image reference differs")
    _validate_stopped_state(actual)
    import docker_volume_dev as volume_dev
    volume_dev._validate_retained_service(compose, actual, service, image_config)


def _container_mounts_by_target(actual, target):
    mounts = actual.get("Mounts")
    if not isinstance(mounts, list):
        raise ValueError("retained app container has no Docker mount inventory")
    selected = [item for item in mounts if isinstance(item, dict) and item.get("Destination") == target]
    if len(selected) != 1:
        raise ValueError("retained app container has no unique " + target + " mount")
    return selected[0]


def _daemon_state_aliases(compose, actual):
    services = compose.get("services") if isinstance(compose, dict) else None
    if not isinstance(services, dict) or not isinstance(actual, dict):
        raise ValueError("retained Compose state mount identity is incomplete")
    aliases = set()
    for service in ("backend", "frontend"):
        item = actual.get(service)
        service_document = services.get(service)
        if not isinstance(item, dict) or not isinstance(service_document, dict):
            raise ValueError("retained " + service + " Compose identity is missing")
        mounts = item.get("Mounts")
        if not isinstance(mounts, list) or any(not isinstance(mount, dict) for mount in mounts):
            raise ValueError("retained " + service + " app container has no complete mount inventory")
        actual_state = [mount for mount in mounts if mount.get("Destination") == "/state"]

        declared = service_document.get("volumes", [])
        if not isinstance(declared, list) or any(not isinstance(volume, dict) for volume in declared):
            raise ValueError("retained " + service + " Compose volume inventory is malformed")
        for volume in declared:
            target = volume.get("target")
            if (not isinstance(target, str) or not target.startswith("/")
                    or ".." in PurePosixPath(target).parts
                    or str(PurePosixPath(target)) != target):
                raise ValueError("retained " + service + " Compose volume target is not canonical")
        declared_state = [volume for volume in declared if volume.get("target") == "/state"]

        daemon_binds = service_document.get("x-fullmag-daemon-binds", {})
        if not isinstance(daemon_binds, dict):
            raise ValueError("retained " + service + " daemon bind pins are malformed")
        has_daemon_pin = "/state" in daemon_binds
        if (service == "frontend" and not actual_state
                and not declared_state and not has_daemon_pin):
            continue
        if len(actual_state) != 1:
            raise ValueError("retained " + service + " must have exactly one /state mount")
        if len(declared_state) != 1:
            raise ValueError("retained " + service + " must declare exactly one /state mount")
        mount = actual_state[0]
        declaration = declared_state[0]
        if (mount.get("Type") != "bind" or not isinstance(mount.get("Source"), str)
                or not mount["Source"]):
            raise ValueError("retained " + service + " state mount is not a bind")
        source = declaration.get("source")
        if (declaration.get("type") != "bind" or not isinstance(source, str)
                or not Path(source).is_absolute() or ".." in Path(source).parts
                or str(PurePosixPath(source)) != source):
            raise ValueError("retained " + service + " Compose state source is not canonical")
        pinned = daemon_binds.get("/state")
        if not has_daemon_pin or not isinstance(pinned, str) or pinned != mount["Source"]:
            raise ValueError("retained " + service + " state alias is not bound to its Compose pin")
        aliases.add(mount["Source"])
        aliases.add(pinned)
        aliases.add(source)
    return aliases


def _protected_resource_mounts(actual, control_volume):
    mounts = actual["backend"].get("Mounts")
    if not isinstance(mounts, list):
        raise ValueError("retained backend has no mount inventory")
    control_mounts = [item for item in mounts if isinstance(item, dict)
                      and item.get("Type") == "volume" and item.get("Name") == control_volume]
    if not control_mounts:
        raise ValueError("retained backend does not mount the selected control volume")
    ledger = [item for item in mounts if isinstance(item, dict) and item.get("Destination") == "/host-ledger"]
    if len(ledger) != 1:
        raise ValueError("retained backend has no unique host-ledger mount")
    protected = set()
    protected_paths = set()
    for item in [*control_mounts, ledger[0]]:
        kind = item.get("Type")
        if kind == "volume" and isinstance(item.get("Name"), str) and item["Name"]:
            protected.add(("volume", item["Name"]))
        elif kind == "bind" and isinstance(item.get("Source"), str) and item["Source"]:
            protected.add(("bind", item["Source"]))
        else:
            raise ValueError("retained control/ledger mount identity is unresolved")
        source = item.get("Source")
        if isinstance(source, str):
            if (not source.startswith("/") or ".." in PurePosixPath(source).parts
                    or str(PurePosixPath(source)) != source):
                raise ValueError("retained control/ledger daemon mountpoint is unsafe")
            protected_paths.add(source)
    return protected, protected_paths


def _running_inventory():
    listed = docker_capture("ps", "--quiet", "--no-trunc", timeout=60).stdout.decode("utf-8", "strict").split()
    if len(listed) > MAX_RUNNING_CONTAINERS or len(set(listed)) != len(listed):
        raise ValueError("running Docker inventory is duplicated or exceeds its bound")
    if any(_CONTAINER_ID.fullmatch(item) is None for item in listed):
        raise ValueError("running Docker inventory contains an incomplete container ID")
    if not listed:
        return []
    observed = _parse_json_list(docker_capture("inspect", *listed, timeout=90).stdout,
                                "running Docker inspect inventory")
    if len(observed) != len(listed) or {item.get("Id") for item in observed} != set(listed):
        raise ValueError("running Docker inspect inventory changed during observation")
    for item in observed:
        state = item.get("State")
        if (not isinstance(state, dict) or state.get("Running") is not True
                or type(state.get("Pid")) is not int or state["Pid"] <= 0):
            raise ValueError("running Docker inspect inventory disagrees with docker ps")
    after = docker_capture("ps", "--quiet", "--no-trunc", timeout=60).stdout.decode("utf-8", "strict").split()
    if set(after) != set(listed):
        raise ValueError("running Docker container inventory changed during consumer audit")
    return observed


def _under(path, root):
    candidate, parent = PurePosixPath(path), PurePosixPath(root)
    return candidate == parent or parent in candidate.parents


def _assert_no_live_consumers(containers, *, state_paths, control_volume,
                              ledger_mounts, allowed_ids, state_alias_sources=(),
                              protected_paths=(), canonicalize_foreign=None,
                              prove_foreign_disjoint=None):
    """Reject every unproved running bind alias or shared protected resource."""
    allowed = set(allowed_ids)
    known_aliases = set(state_alias_sources)
    if not state_paths or not control_volume or not ledger_mounts:
        raise ValueError("consumer audit has incomplete protected storage identities")
    if len(allowed) != len(allowed_ids):
        raise ValueError("controlled helper ID allowlist is malformed")
    ids = set()
    for item in containers:
        identifier = item.get("Id") if isinstance(item, dict) else None
        if not isinstance(identifier, str) or _CONTAINER_ID.fullmatch(identifier) is None or identifier in ids:
            raise ValueError("running Docker consumer has an invalid or duplicate ID")
        ids.add(identifier)
    if not allowed.issubset(ids):
        raise ValueError("one of the exact controlled readmission helpers is not in the live inventory")

    canonical_paths = []
    for value in (*state_paths, *protected_paths, *state_alias_sources):
        if not isinstance(value, str) or not value.startswith("/") or ".." in PurePosixPath(value).parts:
            raise ValueError("protected state path is unsafe")
        canonical_paths.append(str(PurePosixPath(value)))

    canonical_aliases = {}
    for item in containers:
        if item["Id"] in allowed:
            # These exact IDs were authenticated from the active operation and
            # OWNER.lock process. Labels alone never grant this exception.
            continue
        mounts = item.get("Mounts")
        if not isinstance(mounts, list):
            raise ValueError("running Docker consumer has no complete mount inventory")
        for mount in mounts:
            if not isinstance(mount, dict):
                raise ValueError("running Docker consumer mount is malformed")
            kind = mount.get("Type")
            destination = mount.get("Destination")
            if (kind not in {"bind", "volume", "tmpfs"} or not isinstance(destination, str)
                    or not destination.startswith("/") or ".." in PurePosixPath(destination).parts
                    or str(PurePosixPath(destination)) != destination):
                raise ValueError("running Docker consumer mount identity is unresolved")
            if kind == "volume":
                name = mount.get("Name")
                if not isinstance(name, str) or not name:
                    raise ValueError("running Docker consumer named-volume identity is unresolved")
                if name == control_volume or ("volume", name) in ledger_mounts:
                    raise ValueError("a live Docker consumer references the control volume or ledger")
            elif kind == "bind":
                source = mount.get("Source")
                if (not isinstance(source, str) or not source.startswith("/") or source.startswith("//")
                        or ".." in PurePosixPath(source).parts
                        or str(PurePosixPath(source)) != source):
                    raise ValueError("running Docker consumer bind source is unsafe")
                # Raw protected aliases must win over both a canonical
                # resolver and any future platform-specific disjoint proof.
                if any(_under(source, path) or _under(path, source) for path in canonical_paths):
                    raise ValueError("a live Docker consumer references the retained Linux state/control/ledger")
                if (any(source == prefix.rstrip("/") or source.startswith(prefix)
                        for prefix in _DESKTOP_HOST_PREFIXES)
                        and not source.startswith(_WSL_ALIAS_PREFIXES)):
                    # This is the daemon's Windows namespace, not a path in
                    # the Linux caller's filesystem. Lexical comparison here
                    # cannot establish physical disjointness.
                    raise ValueError("foreign Windows Docker Desktop bind has unresolved storage identity")
                canonical_source = source
                alias_was_authenticated = False
                use_kernel_fallback = False
                if source.startswith(_WSL_ALIAS_PREFIXES) and source not in known_aliases:
                    # Different Desktop bind hashes are not a proof of
                    # different host stores. Prefer the exact registered
                    # incarnation resolver; an unresolved alias needs an
                    # independent physical kernel proof, never a path guess.
                    identifier = item["Id"]
                    if identifier not in canonical_aliases:
                        try:
                            canonical_aliases[identifier] = (
                                canonicalize_foreign(item) if canonicalize_foreign is not None else None
                            )
                        except Exception:
                            # The independent proof below is the only fallback
                            # for a denied or unavailable registration.
                            canonical_aliases[identifier] = None
                    mapping = canonical_aliases[identifier]
                    if mapping is None:
                        use_kernel_fallback = True
                    elif not isinstance(mapping, dict):
                        raise ValueError("foreign Docker bind alias resolver returned a malformed mapping")
                    elif source not in mapping:
                        use_kernel_fallback = True
                    else:
                        mapped = mapping[source]
                        if not isinstance(mapped, str):
                            raise ValueError("authenticated foreign bind source is malformed")
                        try:
                            canonical_source = str(storage.absolute(
                                Path(mapped), "authenticated foreign bind source"))
                        except (OSError, RuntimeError, storage.StorageError) as error:
                            raise ValueError("authenticated foreign bind source is not canonical") from error
                        alias_was_authenticated = True
                paths_to_compare = [source]
                if alias_was_authenticated:
                    paths_to_compare.append(canonical_source)
                if any(_under(candidate, path) or _under(path, candidate)
                       for candidate in paths_to_compare for path in canonical_paths):
                    raise ValueError("a live Docker consumer references the retained Linux state/control/ledger")
                if ("bind", source) in ledger_mounts:
                    raise ValueError("a live Docker consumer references the retained ledger bind")
                if use_kernel_fallback:
                    if prove_foreign_disjoint is None:
                        raise ValueError("foreign Docker Desktop bind alias has unresolved storage identity")
                    try:
                        proof = prove_foreign_disjoint(item, source)
                    except Exception as error:
                        raise ValueError("foreign Docker Desktop bind alias has no current disjoint proof") from error
                    import docker_bind_overlap_probe as overlap_probe
                    try:
                        overlap_probe.validate_foreign_alias_disjoint_proof(
                            proof, alias=source, container_id=identifier)
                    except BuildControlError as error:
                        raise ValueError("foreign Docker Desktop bind alias returned an invalid disjoint proof") from error
                    continue
                if alias_was_authenticated:
                    resolved_text = canonical_source
                else:
                    try:
                        resolved_text = str(storage.absolute(Path(source), "running container bind source"))
                    except (OSError, RuntimeError, storage.StorageError) as error:
                        raise ValueError("running Docker bind alias cannot be authenticated on this host") from error
                if any(_under(resolved_text, path) or _under(path, resolved_text)
                       for path in canonical_paths):
                    raise ValueError("a live Docker consumer aliases the retained Linux state root")


def _validate_runtime_records(control, request):
    return _read_runtime_records(control, request)


def _canonicalize_foreign_alias(context, container):
    try:
        import docker_foreign_bind_identity as foreign_identity
    except ImportError as error:
        raise ValueError("read-only foreign WSL alias authenticator is unavailable") from error
    return foreign_identity.canonical_bind_sources(
        container, repo_root=context["repo"]
    )


def _prove_foreign_alias_for_readmission(control, backend, container, alias, state):
    import docker_bind_overlap_probe as overlap_probe
    return overlap_probe.prove_foreign_alias_disjoint(
        control, backend, container, alias, state
    )


def _observe(context, request, request_raw, request_path, *, plan=None, allowed_ids=()):
    control = context["control"]
    selected, layout, identity = context["selected"], context["layout"], context["identity"]
    current_request = host.read_owned_regular(request_path, MAX_OPERATOR_BYTES)
    if current_request != request_raw or parse_operator_bytes(current_request) != request:
        raise ValueError("operator request bytes changed during readmission")
    terminal_rel, compose_rel = _terminal_paths(request["development_attempt"])
    terminal_raw = _read_control(control, terminal_rel)
    compose_raw = _read_control(control, compose_rel)
    terminal, compose, state = _validate_terminal_and_compose(
        control, request, identity, terminal_raw, compose_raw, layout
    )
    engine_id = _engine_id()
    observed_uuid = _filesystem_uuid(state)
    if observed_uuid != request["filesystem_uuid"]:
        raise ValueError("current filesystem UUID differs from the explicit operator observation")
    volume = docker_dev_host.local_volume(state)
    if (not isinstance(volume, dict) or volume.get("host_device") != request["new_host_device"]
            or type(volume.get("host_device")) is not int):
        raise ValueError("current Linux local volume does not match the pinned new host_device")
    state_stat = host._open_nofollow(state, os.O_RDONLY | os.O_DIRECTORY)
    try:
        state_info = os.fstat(state_stat)
    finally:
        os.close(state_stat)
    if not stat.S_ISDIR(state_info.st_mode) or state_info.st_ino != request["expected_inode"]:
        raise ValueError("fresh retained state inode differs from the operator pin")
    runtime_raw = _validate_runtime_records(control, request)
    native_raw = _read_native_files(state)
    if plan is None:
        plan = native.prepare_readmission(
            state, engine_id=engine_id,
            expected_certificate_sha256=request["expected_certificate_sha256"],
            expected_owner_sha256=request["expected_owner_sha256"],
            old_host_device=request["old_host_device"], new_host_device=request["new_host_device"],
            expected_inode=request["expected_inode"], filesystem_uuid=request["filesystem_uuid"],
        )
        pair = "old/old"
        archived = {name: _unrecord(plan["archived_evidence"][name], "planned " + name)
                    for name in _NATIVE_RELATIVES}
        if archived != native_raw:
            raise ValueError("native store files changed while the readmission plan was prepared")
    else:
        if (plan.get("state_root") != str(state) or plan.get("engine_id") != engine_id
                or plan.get("old_host_device") != request["old_host_device"]
                or plan.get("new_host_device") != request["new_host_device"]
                or plan.get("expected_inode") != request["expected_inode"]
                or plan.get("filesystem_uuid_observation") != request["filesystem_uuid"]
                or plan.get("expected_certificate_sha256") != request["expected_certificate_sha256"]
                or plan.get("expected_owner_sha256") != request["expected_owner_sha256"]):
            raise ValueError("prepared Linux plan no longer matches current host/request pins")
        pair = native.classify_pair(plan)
        old_evidence = {name: _unrecord(plan["archived_evidence"][name], "prepared " + name)
                        for name in _NATIVE_RELATIVES}
        for name in ("sentinel", "restart", "probe"):
            if native_raw[name] != old_evidence[name]:
                raise ValueError("non-certificate native evidence differs from its prepared archive: " + name)
        planned_bytes = _unrecord(plan["planned_new_evidence"]["certificate"], "planned certificate")
        if native_raw["certificate"] not in {old_evidence["certificate"], planned_bytes}:
            raise ValueError("current certificate bytes are not an exact prepared CAS value")
        if native_raw["owner_marker"] not in {old_evidence["owner_marker"], planned_bytes}:
            raise ValueError("current owner marker bytes are not an exact prepared CAS value")
    images = docker_capture("inspect", request["backend_container_id"],
                            request["frontend_container_id"], timeout=60)
    app_documents = _parse_json_list(images.stdout, "pinned DEV container inspect")
    if len(app_documents) != 2:
        raise ValueError("Docker did not inspect exactly the pinned backend/frontend containers")
    actual = {item.get("Id"): item for item in app_documents}
    if set(actual) != {request["backend_container_id"], request["frontend_container_id"]}:
        raise ValueError("pinned DEV container IDs are missing or ambiguous")
    actual_by_service = {"backend": actual[request["backend_container_id"]],
                         "frontend": actual[request["frontend_container_id"]]}
    image_config = _image_config(request["old_image_id"])
    for service in ("backend", "frontend"):
        _validate_stopped_service(
            actual_by_service[service], request=request, service=service,
            project=control.project, identity=identity, compose=compose, image_config=image_config,
        )
    aliases = _daemon_state_aliases(compose, actual_by_service)
    ledger_mounts, protected_paths = _protected_resource_mounts(actual_by_service, control.volume)
    running = _running_inventory()
    allowed = set(allowed_ids)
    if allowed_ids:
        operation = control._active_operation
        if operation is None:
            raise ValueError("controlled helper allowlist has no active BuildControl operation")
        operation_id = control._pin_operation_helper(operation)
        if operation_id not in allowed:
            raise ValueError("active operation helper differs from its authenticated ID")
    _assert_no_live_consumers(
        running,
        state_paths=[str(state), *aliases],
        control_volume=control.volume,
        ledger_mounts=ledger_mounts,
        allowed_ids=allowed,
        state_alias_sources=aliases,
        protected_paths=protected_paths,
        canonicalize_foreign=lambda container: _canonicalize_foreign_alias(context, container),
        prove_foreign_disjoint=lambda container, alias: _prove_foreign_alias_for_readmission(
            control, actual_by_service["backend"], container, alias, state),
    )
    # Planner/classifier performs another complete no-follow readback. Keep the
    # raw old records in the snapshot for immutable archival and resume CAS.
    raw = {
        "request": request_raw,
        "terminal": terminal_raw,
        "compose": compose_raw,
        **native_raw,
        **runtime_raw,
    }
    return {
        "plan": plan, "raw": raw, "pair": pair, "state_root": str(state),
        "context": {"compose_project": control.project, "source_root": str(selected),
                    "source_project_id": identity["project_id"],
                    "source_worktree_id": identity["worktree_id"],
                    "source_checkout_kind": identity["checkout_kind"],
                    "engine_id": engine_id, "filesystem_uuid": observed_uuid,
                    "terminal_attempt": terminal["attempt"],
                    "config_sha256": terminal["config_sha256"],
                    "backend_container_id": request["backend_container_id"],
                    "frontend_container_id": request["frontend_container_id"],
                    "old_image_id": request["old_image_id"]},
    }


def _manifest_bytes(manifest):
    return canonical(manifest)


def _build_manifest(request, request_raw, observation, attempt):
    if set(observation["raw"]) != set(_ARCHIVE_NAMES):
        raise ValueError("readmission observation does not contain every required raw archive")
    archives = {name: _record(observation["raw"][name], "old " + name)
                for name in _ARCHIVE_NAMES}
    return {
        "schema": PREPARED_SCHEMA,
        "operation_attempt": attempt,
        "request_sha256": _json_sha(request_raw),
        "request": request,
        "state_root": observation["state_root"],
        "context": observation["context"],
        "plan": observation["plan"],
        "plan_sha256": observation["plan"]["plan_sha256"],
        "archives": archives,
    }


def _read_resume(control, attempt, prepared_sha256, request, request_raw):
    if _ATTEMPT.fullmatch(attempt or "") is None:
        raise ValueError("resume-attempt must be an exact lowercase 32-character ID")
    _sha(prepared_sha256, "prepared-sha256")
    root = PHASE + "/attempts/" + attempt
    manifest_path = root + "/prepared.json"
    manifest_raw = _read_control(control, manifest_path)
    if _json_sha(manifest_raw) != prepared_sha256:
        raise ValueError("prepared manifest SHA-256 differs from the resume pin")
    manifest = _parse_object(manifest_raw, "prepared readmission manifest")
    if _manifest_bytes(manifest) != manifest_raw:
        raise ValueError("prepared manifest bytes are not canonical")
    if (manifest.get("schema") != PREPARED_SCHEMA
            or manifest.get("operation_attempt") != attempt
            or manifest.get("request_sha256") != _json_sha(request_raw)
            or manifest.get("request") != request
            or manifest.get("plan_sha256") != manifest.get("plan", {}).get("plan_sha256")):
        raise ValueError("prepared manifest request, operation or plan pins differ")
    prior_terminal_raw = _read_control(control, root + "/terminal.json")
    prior_terminal = _parse_object(prior_terminal_raw, "prior readmission terminal receipt")
    if (prior_terminal.get("schema") != "fullmag.docker-build-operation.v1"
            or prior_terminal.get("phase") != PHASE
            or prior_terminal.get("attempt") != attempt
            or prior_terminal.get("state") != "failed-confirmed"
            or prior_terminal.get("prepared_sha256") != prepared_sha256):
        raise ValueError("prior readmission attempt is not a confirmed resumable prepared operation")
    archives = manifest.get("archives")
    if not isinstance(archives, dict) or set(archives) != set(_ARCHIVE_NAMES):
        raise ValueError("prepared manifest archive set is incomplete")
    raw_archives = {name: _unrecord(archives[name], "prepared " + name)
                    for name in _ARCHIVE_NAMES}
    plan = manifest.get("plan")
    if (not isinstance(plan, dict) or plan.get("schema") != native.PLAN_SCHEMA
            or not isinstance(plan.get("archived_evidence"), dict)
            or not isinstance(plan.get("planned_new_evidence"), dict)):
        raise ValueError("prepared manifest has no valid native readmission plan")
    old_plan = {name: _unrecord(plan["archived_evidence"][name], "prepared native " + name)
                for name in _NATIVE_RELATIVES}
    if any(raw_archives[name] != raw for name, raw in old_plan.items()):
        raise ValueError("prepared manifest native archives differ from the planner archive")
    for name, raw in raw_archives.items():
        relative = root + "/archive/" + name + ".bin"
        if _read_control(control, relative, MAX_RECORD_BYTES) != raw:
            raise ValueError("immutable prepared archive changed: " + name)
    cert_new = _unrecord(plan["planned_new_evidence"]["certificate"], "prepared new certificate")
    owner_new = _unrecord(plan["planned_new_evidence"]["owner_marker"], "prepared new owner marker")
    if cert_new != owner_new:
        raise ValueError("prepared new certificate and owner marker bytes differ")
    if (_read_control(control, root + "/planned/certificate.json", MAX_RECORD_BYTES) != cert_new
            or _read_control(control, root + "/planned/owner.json", MAX_RECORD_BYTES) != owner_new):
        raise ValueError("prepared deterministic publication bytes changed")
    return {"attempt": attempt, "prepared_sha256": prepared_sha256,
            "manifest_path": manifest_path, "manifest_raw": manifest_raw,
            "manifest": manifest, "prior_terminal_raw": prior_terminal_raw,
            "archives": raw_archives, "plan": plan, "root": root}


def _archive_matches(observation, archives, *, ignore=()):
    raw = observation.get("raw")
    if not isinstance(raw, dict) or set(raw) != set(_ARCHIVE_NAMES):
        raise ValueError("fresh readmission evidence set is incomplete")
    ignored = set(ignore)
    for name in _ARCHIVE_NAMES:
        if name not in ignored and raw[name] != archives[name]:
            raise ValueError("fresh " + name + " raw bytes differ from the immutable prepared archive")


def _write_once(control, relative, raw):
    current = control.read_bytes(relative, optional=True, maximum=MAX_CONTROL_BYTES)
    if current is not None:
        raise ValueError("new readmission operation path already exists: " + relative)
    control.write_bytes(relative, raw)
    if control.read_bytes(relative, maximum=MAX_CONTROL_BYTES) != raw:
        raise ValueError("control-volume readback differs for new readmission archive: " + relative)


def _persist_prepared(control, operation, request, request_raw, observation):
    root = operation["root"]
    manifest = _build_manifest(request, request_raw, observation,
                               operation["receipt"]["attempt"])
    manifest_raw = _manifest_bytes(manifest)
    if len(manifest_raw) > MAX_CONTROL_BYTES:
        raise ValueError("prepared readmission manifest exceeds the control-volume bound")
    for name in _ARCHIVE_NAMES:
        _write_once(control, root + "/archive/" + name + ".bin", observation["raw"][name])
    new_cert = _unrecord(observation["plan"]["planned_new_evidence"]["certificate"],
                         "planned new certificate")
    new_owner = _unrecord(observation["plan"]["planned_new_evidence"]["owner_marker"],
                          "planned new owner marker")
    _write_once(control, root + "/planned/certificate.json", new_cert)
    _write_once(control, root + "/planned/owner.json", new_owner)
    _write_once(control, root + "/prepared.json", manifest_raw)
    prepared_sha = _json_sha(manifest_raw)
    operation["receipt"].update(
        state="prepared", prepared_relative=root + "/prepared.json",
        prepared_sha256=prepared_sha, native_plan_sha256=observation["plan"]["plan_sha256"],
        filesystem_uuid_observation=observation["context"]["filesystem_uuid"],
    )
    return manifest, manifest_raw, prepared_sha


def _validate_resume_archive_in_operation(control, resume):
    if _read_control(control, resume["manifest_path"]) != resume["manifest_raw"]:
        raise ValueError("prepared manifest changed while acquiring the readmission lease")
    root = resume["root"]
    for name, raw in resume["archives"].items():
        if _read_control(control, root + "/archive/" + name + ".bin", MAX_RECORD_BYTES) != raw:
            raise ValueError("prepared archive changed while acquiring the readmission lease: " + name)
    planned = resume["plan"]["planned_new_evidence"]
    for name, filename in (("certificate", "certificate.json"),
                           ("owner_marker", "owner.json")):
        expected = _unrecord(planned[name], "prepared new " + name)
        if _read_control(control, root + "/planned/" + filename, MAX_RECORD_BYTES) != expected:
            raise ValueError("planned publication bytes changed while acquiring the readmission lease: "
                             + name)
    if _read_control(control, root + "/terminal.json") != resume["prior_terminal_raw"]:
        raise ValueError("prior readmission terminal receipt changed while acquiring the lease")


def _state_pair(plan):
    return native.classify_pair(plan)


def run_transaction(control, request, request_raw, observation, *, execute,
                    reobserve, resume_attempt=None, prepared_sha256=None,
                    owner_lock=None, writer_lock=None, classify=None,
                    revalidate=None, publish=None):
    """Return a read-only plan or execute the pinned two-file CAS transaction.

    Lock and I/O callbacks are injectable for interpretive regressions; normal
    callers use the managed Docker, native host and BuildControl adapters.
    """
    if not execute:
        if resume_attempt is not None or prepared_sha256 is not None:
            raise ValueError("resume requires --execute")
        return {
            "schema": RESULT_SCHEMA, "state": "validated-read-only",
            "compose_project": control.project,
            "request_id": request["request_id"],
            "plan_sha256": observation["plan"]["plan_sha256"],
            "plan": observation["plan"],
            "certificate_sha256": request["expected_certificate_sha256"],
            "owner_sha256": request["expected_owner_sha256"],
            "filesystem_uuid_observation": request["filesystem_uuid"],
            "application_started": False, "native_store_written": False,
        }
    if bool(resume_attempt) != bool(prepared_sha256):
        raise ValueError("resume-attempt and prepared-sha256 must be supplied together")
    classify = classify or _state_pair
    revalidate = revalidate or native.revalidate_readmission
    publish = publish or host.publish_bytes
    owner_lock = owner_lock or _owner_lock
    writer_lock = writer_lock or _writer_lock
    if resume_attempt:
        resume = _read_resume(control, resume_attempt, prepared_sha256, request, request_raw)
        plan = resume["plan"]
        operation_inputs = {
            "source_root": request["source_root"], "compose_project": control.project,
            "request_id": request["request_id"], "development_attempt": request["development_attempt"],
            "resume_attempt": resume_attempt, "prepared_sha256": prepared_sha256,
            "native_plan_sha256": plan["plan_sha256"],
        }
    else:
        resume = None
        plan = observation["plan"]
        if observation.get("pair") != "old/old":
            raise ValueError("new readmission execute requires the exact old/old certificate-owner pair")
        operation_inputs = {
            "source_root": request["source_root"], "compose_project": control.project,
            "request_id": request["request_id"], "development_attempt": request["development_attempt"],
            "native_plan_sha256": plan["plan_sha256"],
        }
    control.prepare()
    with control.operation(PHASE, operation_inputs) as operation:
        operation_id = operation.get("helper_container_id")
        if not isinstance(operation_id, str) or _CONTAINER_ID.fullmatch(operation_id) is None:
            operation_id = control._pin_operation_helper(operation)
        with owner_lock(control) as owner_helper_id:
            if not isinstance(owner_helper_id, str) or _CONTAINER_ID.fullmatch(owner_helper_id) is None:
                raise ValueError("OWNER lock helper ID was not authenticated")
            with writer_lock(Path(observation["state_root"])):
                fresh = reobserve(plan, {operation_id, owner_helper_id})
                archives = resume["archives"] if resume else observation["raw"]
                ignored = {"certificate", "owner_marker"} if resume else set()
                _archive_matches(fresh, archives, ignore=ignored)
                current_pair = classify(plan)
                if resume is None:
                    if current_pair != "old/old":
                        raise ValueError("certificate-owner pair changed before first publication")
                    if fresh["plan"]["plan_sha256"] != plan["plan_sha256"]:
                        raise ValueError("readmission plan changed while acquiring managed locks")
                elif current_pair not in {"old/old", "new/old", "old/new", "new/new"}:
                    raise ValueError("prepared certificate-owner pair is not resumable")
                if current_pair == "old/old":
                    revalidate(plan)
                if resume:
                    _validate_resume_archive_in_operation(control, resume)
                    prepared_manifest = resume["manifest"]
                    prepared_raw = resume["manifest_raw"]
                    prepared_digest = resume["prepared_sha256"]
                else:
                    prepared_manifest, prepared_raw, prepared_digest = _persist_prepared(
                        control, operation, request, request_raw, fresh
                    )
                operation["receipt"].update(
                    prepared_sha256=prepared_digest,
                    prepared_relative=(resume["manifest_path"] if resume
                                       else operation["root"] + "/prepared.json"),
                    native_plan_sha256=plan["plan_sha256"],
                    state="publishing-native-certificate-owner",
                )
                print(json.dumps({
                    "schema": RESULT_SCHEMA, "state": "prepared-for-publication",
                    "operation_attempt": operation["receipt"]["attempt"],
                    "prepared_attempt": resume_attempt or operation["receipt"]["attempt"],
                    "prepared_sha256": prepared_digest,
                    "native_plan_sha256": plan["plan_sha256"],
                }, sort_keys=True), flush=True)
                new_certificate = _unrecord(
                    plan["planned_new_evidence"]["certificate"], "planned new certificate")
                new_owner = _unrecord(
                    plan["planned_new_evidence"]["owner_marker"], "planned new owner marker")
                # Archive writes use short-lived control-volume helpers. Repeat
                # every runtime, engine, UUID, container and consumer guard at
                # the publication boundary after those helpers have exited.
                publish_observation = reobserve(plan, {operation_id, owner_helper_id})
                _archive_matches(
                    publish_observation, archives,
                    ignore={"certificate", "owner_marker"} if resume else set(),
                )
                pair = classify(plan)
                if resume is None and pair != "old/old":
                    raise ValueError("certificate-owner pair changed before first native publication")
                if pair == "old/old":
                    revalidate(plan)
                if pair.split("/", 1)[0] == "old":
                    publish(Path(observation["state_root"]) / host.CERTIFICATE_NAME, new_certificate)
                pair = classify(plan)
                if pair.split("/", 1)[1] == "old":
                    # The second host replacement is independently fenced
                    # against a consumer or provenance change after the first.
                    owner_observation = reobserve(plan, {operation_id, owner_helper_id})
                    _archive_matches(owner_observation, archives,
                                     ignore={"certificate", "owner_marker"})
                    pair = classify(plan)
                    if pair != "new/old":
                        raise ValueError("certificate-owner pair changed before owner-marker publication")
                    publish(Path(observation["state_root"]) / host.OWNER_NAME, new_owner)
                pair = classify(plan)
                if pair != "new/new":
                    raise ValueError("native certificate-owner readback did not reach exact new/new")
                final = reobserve(plan, {operation_id, owner_helper_id})
                _archive_matches(final, archives, ignore={"certificate", "owner_marker"})
                if classify(plan) != "new/new":
                    raise ValueError("native certificate-owner pair changed during final readback")
                operation["receipt"].update(
                    state="readback-verified", prepared_sha256=prepared_digest,
                    native_plan_sha256=plan["plan_sha256"],
                    certificate_sha256=_json_sha(new_certificate),
                    owner_sha256=_json_sha(new_owner),
                    historical_probe_sha256=_json_sha(archives["probe"]),
                    historical_probe_remains_stale=True,
                    application_started=False,
                    fresh_managed_probe_required=True,
                )
        # Do not mark the operation committed until both lock contexts have
        # confirmed clean release. A release error must remain resumable.
        operation["receipt"]["state"] = "succeeded"
        return {
            "schema": RESULT_SCHEMA, "state": "succeeded",
            "compose_project": control.project,
            "request_id": request["request_id"],
            "operation_attempt": operation["receipt"]["attempt"],
            "prepared_attempt": resume_attempt or operation["receipt"]["attempt"],
            "prepared_sha256": prepared_digest,
            "plan_sha256": plan["plan_sha256"],
            "certificate_owner_pair": "new/new",
            "fresh_managed_probe_required": True,
            "application_started": False,
        }


def _readline(process, timeout=90):
    ready, _, _ = select.select([process.stdout], [], [], timeout)
    if not ready:
        raise ControlOutcomeUnknown("OWNER lock helper acknowledgement timed out; resources retained")
    line = process.stdout.readline()
    if not line:
        raise ReadmissionError("OWNER lock helper exited before acknowledging its lock")
    return line.decode("utf-8", "replace").strip()


def _authenticate_owner_helper(control, process, name, script):
    if process.poll() is not None:
        raise ReadmissionError("OWNER lock helper exited before it was authenticated")
    records = _parse_json_list(docker_capture("inspect", name, timeout=30).stdout,
                               "OWNER lock helper inspect")
    if len(records) != 1:
        raise ReadmissionError("OWNER lock helper identity is ambiguous")
    actual = records[0]
    identifier = actual.get("Id")
    config = actual.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    state = actual.get("State")
    host_config = actual.get("HostConfig")
    expected_labels = {
        "com.docker.compose.project": control.project,
        "com.docker.compose.service": "build-control",
        **control.labels,
        **source_labels(control.identity),
    }
    command = config.get("Cmd") if isinstance(config, dict) else None
    expected_command = ["-euo", "pipefail", "-c", control._namespace_guard(script)]
    mounts = actual.get("Mounts")
    expected_mount_count = 2 if control.namespace else 1
    control_mounts = [item for item in mounts if isinstance(item, dict)
                      and item.get("Destination") == "/control"] if isinstance(mounts, list) else []
    registry_mounts = [item for item in mounts if isinstance(item, dict)
                       and item.get("Destination") == "/registry"] if isinstance(mounts, list) else []
    host_mounts = host_config.get("Mounts") if isinstance(host_config, dict) else None
    if (not isinstance(identifier, str) or _CONTAINER_ID.fullmatch(identifier) is None
            or actual.get("Name") != "/" + name
            or actual.get("Image") != control.image
            or not isinstance(config, dict) or config.get("Image") != control.image
            or config.get("Entrypoint") != ["/bin/bash"] or config.get("User") != "65532:65532"
            or not isinstance(labels, dict) or any(labels.get(k) != v for k, v in expected_labels.items())
            or command != expected_command or not isinstance(state, dict)
            or state.get("Running") is not True or type(state.get("Pid")) is not int or state["Pid"] <= 0
            or not isinstance(host_config, dict) or host_config.get("NetworkMode") != "none"
            or host_config.get("Privileged") is not False
            or host_config.get("ReadonlyRootfs") is not True
            or host_config.get("Binds") not in (None, [])
            or host_config.get("Tmpfs") not in (None, {})
            or not isinstance(mounts, list) or len(mounts) != expected_mount_count
            or len(control_mounts) != 1 or control_mounts[0].get("Type") != "volume"
            or control_mounts[0].get("Name") != control.volume or control_mounts[0].get("RW") is not True
            or not isinstance(host_mounts, list) or len(host_mounts) != expected_mount_count):
        raise ReadmissionError("OWNER lock helper does not match its exact managed identity")
    if control.namespace:
        if (len(registry_mounts) != 1 or registry_mounts[0].get("Type") != "volume"
                or registry_mounts[0].get("Name") != control.volume
                or registry_mounts[0].get("RW") is not False):
            raise ReadmissionError("OWNER lock helper namespace registry mount differs")
    expected_targets = {"/control": (False, control.namespace or None)}
    if control.namespace:
        expected_targets["/registry"] = (True, None)
    for mount in host_mounts:
        if not isinstance(mount, dict):
            raise ReadmissionError("OWNER lock helper host mount is malformed")
        target = mount.get("Target")
        expected = expected_targets.get(target)
        options = mount.get("VolumeOptions")
        expected_read_only, expected_subpath = expected if expected is not None else (None, None)
        actual_read_only = mount["ReadOnly"] if "ReadOnly" in mount else False
        if (expected is None or mount.get("Type") != "volume"
                or mount.get("Source") != control.volume
                or type(actual_read_only) is not bool or actual_read_only is not expected_read_only
                or not isinstance(options, dict) or options.get("NoCopy") is not True
                or options.get("Subpath") != expected_subpath):
            raise ReadmissionError("OWNER lock helper host mount differs from its exact control volume")
    return identifier


@contextmanager
def _owner_lock(control):
    token = uuid.uuid4().hex
    name = "fullmag-owner-lock-" + token
    path = control.path(_OWNER_LOCK)
    parent = str(PurePosixPath(path).parent)
    script = (
        f"test -e '{path}'; test ! -L '{path}'; test -f '{path}'; "
        f"test $(stat -c %h '{path}') = 1; "
        f"test \"$(readlink -f '{parent}')\" = '{parent}'; "
        f"exec 9<> '{path}'; flock -n 9; printf 'READY\\n'; "
        "cat >/dev/null; printf 'RELEASED\\n'"
    )
    process = subprocess.Popen(
        control.helper_args(script, name=name), stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    lock_id = None
    ready_seen = False
    released = False
    try:
        if _readline(process) != "READY":
            raise ReadmissionError("Native OWNER.lock is busy or unavailable")
        ready_seen = True
        lock_id = _authenticate_owner_helper(control, process, name, script)
        yield lock_id
    finally:
        if process.stdin is not None and not process.stdin.closed:
            process.stdin.close()
        if ready_seen:
            try:
                release_line = _readline(process, timeout=30)
                released = release_line == "RELEASED"
            except BaseException:
                released = False
        try:
            code = process.wait(timeout=30)
        except subprocess.TimeoutExpired as error:
            raise ControlOutcomeUnknown(
                "OWNER lock helper did not release cleanly; resources retained"
            ) from error
        if ready_seen and (not released or code != 0):
            raise ControlOutcomeUnknown("OWNER lock helper release/readback is unknown")


@contextmanager
def _writer_lock(state):
    lock_path = Path(state) / "runs/docker-all/session-store/WRITER.lock"
    descriptor = host._open_nofollow(lock_path, os.O_RDONLY)
    locked = False
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ReadmissionError("existing host WRITER.lock is not a singly linked regular file")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ReadmissionError("host WRITER.lock is busy") from error
        locked = True
        yield descriptor
    finally:
        if locked:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _request_context(args, request):
    context = _load_managed_context(args.repo_root, args.source_root, request)
    return context


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--execute", action="store_true",
                        help="Archive and publish only the exact prepared host-device transition")
    parser.add_argument("--resume-attempt")
    parser.add_argument("--prepared-sha256")
    args = parser.parse_args(argv)
    try:
        if bool(args.resume_attempt) != bool(args.prepared_sha256):
            raise ValueError("--resume-attempt and --prepared-sha256 must be used together")
        if args.resume_attempt and not args.execute:
            raise ValueError("resume requires --execute")
        request, request_raw, request_path = _read_operator_file(args.request)
        context = _request_context(args, request)
        control = context["control"]
        resume_plan = None
        if args.resume_attempt:
            resume = _read_resume(control, args.resume_attempt, args.prepared_sha256,
                                  request, request_raw)
            resume_plan = resume["plan"]
        observation = _observe(context, request, request_raw, request_path, plan=resume_plan)
        result = run_transaction(
            control, request, request_raw, observation,
            execute=args.execute,
            reobserve=lambda plan, allowed: _observe(
                context, request, request_raw, request_path, plan=plan, allowed_ids=allowed),
            resume_attempt=args.resume_attempt, prepared_sha256=args.prepared_sha256,
        )
        print(json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True))
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError, storage.StorageError) as error:
        parser.exit(2, f"Linux host readmission: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
