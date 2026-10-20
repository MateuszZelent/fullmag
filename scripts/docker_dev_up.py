"""Idempotent orchestration for the fixed Docker DEV service group.

The regular ``docker-dev up`` command is a reconciliation operation.  It
reuses a validated group when possible, lets the long lived backend decide
whether its package cache is still valid, and only asks Docker to restart the
backend when the mounted source no longer matches the verified package.

This module deliberately does not build images or inspect an unpinned
historical run.  A group is usable only when its control-volume receipts,
Compose document, container labels, mounts, image identities, and source
checkout all describe the same group.  Unknown or partially admitted state is
reported as a retained-resource error so an operator can recover it explicitly.
"""
from __future__ import annotations

import argparse
from collections.abc import Mapping
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace

from docker_build_control import (
    BuildControl,
    BuildControlError,
    bounded_capture,
    canonical,
    compose_capture,
    docker_capture,
    toolchain_configuration,
)


ATTEMPT_RE = re.compile(r"^[0-9a-f]{32}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{64}$")
SOURCE_MATCH_MARKER = "FULLMAG_SOURCE_MATCH_V1:"
TERMINAL_STATES = frozenset({"succeeded", "failed-confirmed"})
IMAGE_HELPER_SOURCES = (
    ("backend_dev.py", "docker/all-in-one/backend_dev.py"),
    ("backend_source.py", "docker/all-in-one/backend_source.py"),
    ("backend_volume_cache_maintenance.py", "docker/all-in-one/backend_volume_cache_maintenance.py"),
    ("entrypoint.py", "docker/all-in-one/entrypoint.py"),
    ("frontend_dev.py", "docker/all-in-one/frontend_dev.py"),
    ("healthcheck.py", "docker/all-in-one/healthcheck.py"),
    ("linux_native_probe.py", "docker/all-in-one/linux_native_probe.py"),
    ("runtime_service.py", "docker/all-in-one/runtime_service.py"),
    ("windows_folder_probe.py", "docker/all-in-one/windows_folder_probe.py"),
    ("docker_startup_script.py", "scripts/docker_startup_script.py"),
    ("fullmag_storage.py", "scripts/fullmag_storage.py"),
)


class DockerDevUpError(BuildControlError):
    """The existing DEV namespace cannot be safely reconciled."""


class ImageHelperDrift(DockerDevUpError):
    """The retained image-owned helper bytes differ from the selected source."""

    def __init__(self, changed: list[str] | tuple[str, ...]):
        self.changed = tuple(changed)
        names = ", ".join(self.changed) if self.changed else "unknown helper"
        super().__init__(
            "Selected checkout changed image-owned Docker helper(s): "
            f"{names}. The retained image is stale and the managed DEV group "
            "must be recreated before it can be reused"
        )


class ScriptOutputMappingDrift(DockerDevUpError):
    """The retained writable script-output alias differs from current config."""


class BuildInputDrift(DockerDevUpError):
    """The selected checkout no longer matches a retained image input receipt."""

    def __init__(self, changed: list[str] | tuple[str, ...]):
        self.changed = tuple(changed)
        names = ", ".join(self.changed) if self.changed else "unknown input"
        super().__init__(
            "Selected checkout changed retained Docker build input(s): "
            f"{names}; the managed DEV group must be recreated"
        )


class BuildInputUnknown(DockerDevUpError):
    """The retained image input evidence is absent or cannot be authenticated."""


@dataclass(frozen=True)
class RetainedGroup:
    """A validated fixed Compose group and its current service states."""

    repo_root: Path
    source_root: Path
    layout: Mapping[str, object]
    identity: Mapping[str, str]
    control: BuildControl
    attempt: str
    config_sha256: str
    port: int
    document: Mapping[str, object]
    terminal: Mapping[str, object]
    backend_id: str
    frontend_id: str
    backend: Mapping[str, object]
    frontend: Mapping[str, object]

    @property
    def backend_running(self) -> bool:
        return bool(self.backend.get("State", {}).get("Running"))

    @property
    def frontend_running(self) -> bool:
        return bool(self.frontend.get("State", {}).get("Running"))

    @property
    def backend_healthy(self) -> bool:
        return self.backend.get("State", {}).get("Health", {}).get("Status") == "healthy"


def _same_path(left: object, right: object) -> bool:
    if not isinstance(left, (str, os.PathLike)) or not isinstance(right, (str, os.PathLike)):
        return False
    try:
        return os.path.normcase(os.path.normpath(str(Path(left).resolve()))) == os.path.normcase(
            os.path.normpath(str(Path(right).resolve()))
        )
    except (OSError, RuntimeError, ValueError):
        return False


def _json_value(raw: bytes | str, label: str):
    try:
        value = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DockerDevUpError(f"{label} is not valid JSON") from error
    return value


def _json_document(raw: bytes | str, label: str) -> Mapping[str, object]:
    value = _json_value(raw, label)
    if not isinstance(value, Mapping):
        raise DockerDevUpError(f"{label} is not a JSON object")
    return value


def _control_volume_exists(control: BuildControl) -> bool:
    """Check an exact control volume without creating it as a side effect."""

    observed = docker_capture("volume", "inspect", control.volume, allow_failure=True)
    if observed.returncode:
        names = docker_capture("volume", "ls", "--format", "{{.Name}}").stdout.decode(
            "utf-8", "replace"
        ).splitlines()
        if control.volume in names:
            raise DockerDevUpError("Existing DEV control volume could not be inspected; resources retained")
        return False
    try:
        documents = json.loads(observed.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DockerDevUpError("Existing DEV control volume inspection is invalid") from error
    if len(documents) != 1 or not isinstance(documents[0], Mapping):
        raise DockerDevUpError("Existing DEV control volume identity is ambiguous")
    volume = documents[0]
    labels = volume.get("Labels")
    if (
        volume.get("Name") != control.volume
        or volume.get("Driver") != "local"
        or volume.get("Options")
        or not isinstance(labels, Mapping)
        or any(labels.get(key) != value for key, value in control.shared_labels.items())
    ):
        raise DockerDevUpError("Existing DEV control volume belongs to another group; resources retained")
    return True


def _project_service_ids(project: str, service: str) -> list[str]:
    result = docker_capture(
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        "label=com.docker.compose.project=" + project,
        "--filter",
        "label=com.docker.compose.service=" + service,
        "--format",
        "{{.ID}}",
    )
    values = [line.strip() for line in result.stdout.decode("utf-8", "replace").splitlines() if line.strip()]
    if any(not CONTAINER_ID_RE.fullmatch(value) for value in values):
        raise DockerDevUpError(f"Docker returned an invalid {service} container identity")
    return values


def _control_file_exists(control: BuildControl, relative: str) -> bool:
    """Observe a raw control-volume marker without interpreting it as JSON."""

    path = control.path(relative)
    command = (
        f"if test ! -e '{path}'; then if test -L '{path}'; then exit 1; fi; exit 44; fi; "
        f"test ! -L '{path}'; test -f '{path}'; "
        f"test $(stat -c %h '{path}') = 1"
    )
    result = bounded_capture(control.helper_args(command), data=b"", timeout=90)
    if result.returncode == 0:
        return True
    if result.returncode == 44:
        return False
    raise DockerDevUpError(
        "Could not determine whether the DEV operation is active; named resources retained"
    )


def _read_attempt(control: BuildControl, current: Mapping[str, object]) -> tuple[str, Mapping[str, object], Mapping[str, object]]:
    attempt = current.get("attempt")
    if not isinstance(attempt, str) or not ATTEMPT_RE.fullmatch(attempt):
        raise DockerDevUpError("development/current.json has no valid attempt fence")
    state = current.get("state")
    if state not in TERMINAL_STATES:
        raise DockerDevUpError(
            "Existing DEV operation is still active or has unknown outcome "
            f"(state={state!r}); reconcile it explicitly before starting another operation"
        )
    root = "development/attempts/" + attempt
    terminal = control.read(root + "/terminal.json")
    document = control.read(root + "/compose.json")
    if not isinstance(terminal, Mapping) or not isinstance(document, Mapping):
        raise DockerDevUpError("Retained DEV terminal or Compose receipt is not an object")
    if terminal.get("attempt") != attempt or terminal.get("state") != state:
        raise DockerDevUpError("Retained DEV current/terminal receipt identity differs")
    return attempt, terminal, document


def _compose_container_id(document: Mapping[str, object], service: str) -> str:
    try:
        raw = compose_capture(document, "ps", "--all", "--quiet", service).decode(
            "utf-8", "replace"
        )
    except Exception as error:
        raise DockerDevUpError(f"Cannot inspect retained Compose service: {service}") from error
    values = [line.strip() for line in raw.splitlines() if line.strip()]
    if len(values) != 1 or not CONTAINER_ID_RE.fullmatch(values[0]):
        raise DockerDevUpError(f"Retained Compose service identity is ambiguous: {service}")
    return values[0]


def _inspect_retained_service(
    document: Mapping[str, object],
    identity: Mapping[str, str],
    service: str,
    identifier: str,
    image: str,
    terminal: Mapping[str, object],
) -> Mapping[str, object]:
    records = _json_value(docker_capture("inspect", identifier).stdout, service + " inspection")
    # Docker inspect returns one-item arrays.
    if not isinstance(records, list):
        raise DockerDevUpError(f"Retained {service} inspection is not an array")
    if len(records) != 1 or not isinstance(records[0], Mapping):
        raise DockerDevUpError(f"Retained {service} identity is ambiguous")
    actual = records[0]
    config = actual.get("Config", {})
    labels = config.get("Labels", {}) if isinstance(config, Mapping) else None
    if (
        actual.get("Id") != identifier
        or actual.get("Image") != image
        or not isinstance(labels, Mapping)
        or labels.get("com.docker.compose.project") != identity["project_name"]
        or labels.get("com.docker.compose.service") != service
        or labels.get("org.fullmag.source.worktree-id") != identity["worktree_id"]
    ):
        raise DockerDevUpError(f"Retained {service} ownership differs from the selected checkout")
    recorded = terminal.get(service + "_container")
    if recorded is not None and recorded != identifier:
        raise DockerDevUpError(f"Retained {service} incarnation differs from its terminal receipt")
    image_records = _json_value(
        docker_capture("image", "inspect", image).stdout, service + " image inspection"
    )
    if not isinstance(image_records, list) or len(image_records) != 1:
        raise DockerDevUpError(f"Retained {service} image identity is ambiguous")
    image_config = image_records[0].get("Config") if isinstance(image_records[0], Mapping) else None
    if not isinstance(image_config, Mapping):
        raise DockerDevUpError(f"Retained {service} image configuration is missing")
    from docker_volume_dev import _validate_retained_service

    try:
        _validate_retained_service(document, actual, service, image_config)
    except (BuildControlError, KeyError, TypeError, ValueError) as error:
        raise DockerDevUpError(str(error)) from error
    return actual


def _document_port(document: Mapping[str, object]) -> int:
    from docker_dev_defaults import _document_port

    try:
        return _document_port(document)
    except BuildControlError as error:
        raise DockerDevUpError(str(error)) from error


def _validate_retained_network(
    backend: Mapping[str, object],
    frontend: Mapping[str, object],
    backend_id: str,
    frontend_id: str,
    project: str,
    expected_network: str,
    port: int,
) -> None:
    """Validate the fixed private network for running and stopped services.

    Docker removes stopped containers from the network's active consumer map,
    so the stricter running-group validator cannot be used while reconciling a
    stopped group.  The retained map may therefore be empty or contain only
    the currently running members, but it may never contain an unknown ID.
    """

    backend_host = backend.get("HostConfig", {})
    if not isinstance(backend_host, Mapping):
        raise DockerDevUpError("Retained backend host configuration is invalid")
    if backend_host.get("PortBindings") or backend_host.get("NetworkMode") in {"host", "none"}:
        raise DockerDevUpError("Retained backend is not an unpublished private service")
    backend_network_settings = backend.get("NetworkSettings", {})
    frontend_network_settings = frontend.get("NetworkSettings", {})
    backend_networks = (
        backend_network_settings.get("Networks", {})
        if isinstance(backend_network_settings, Mapping)
        else None
    )
    frontend_networks = (
        frontend_network_settings.get("Networks", {})
        if isinstance(frontend_network_settings, Mapping)
        else None
    )
    if not isinstance(backend_networks, Mapping) or len(backend_networks) != 1:
        raise DockerDevUpError("Retained backend does not have one private application network")
    if not isinstance(frontend_networks, Mapping) or len(frontend_networks) != 1:
        raise DockerDevUpError("Retained frontend does not have one private application network")
    network_name = next(iter(backend_networks))
    if (
        not isinstance(network_name, str)
        or not network_name
        or network_name != expected_network
        or network_name not in frontend_networks
    ):
        raise DockerDevUpError("Retained services are on different application networks")
    network_records = _json_value(
        docker_capture("network", "inspect", network_name).stdout,
        "retained application network inspection",
    )
    if not isinstance(network_records, list) or len(network_records) != 1:
        raise DockerDevUpError("Retained application network identity is ambiguous")
    network = network_records[0]
    if not isinstance(network, Mapping):
        raise DockerDevUpError("Retained application network record is not an object")
    labels = network.get("Labels", {})
    consumers = network.get("Containers", {})
    if (
        not isinstance(labels, Mapping)
        or labels.get("com.docker.compose.project") != project
        or labels.get("com.docker.compose.network") != "fullmag"
        or network.get("Name") != expected_network
        or network.get("Driver") != "bridge"
        or not isinstance(consumers, Mapping)
        or not set(consumers).issubset({backend_id, frontend_id})
    ):
        raise DockerDevUpError("Retained application network has unknown ownership or consumers")
    frontend_host = frontend.get("HostConfig", {})
    if not isinstance(frontend_host, Mapping):
        raise DockerDevUpError("Retained frontend host configuration is invalid")
    expected = {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]}
    if frontend_host.get("PortBindings") != expected:
        raise DockerDevUpError("Retained frontend does not publish the requested loopback port")


def _service_mode(group: RetainedGroup) -> str:
    """Classify the safe lifecycle operation without making a Docker change."""

    if group.backend_running and not group.backend_healthy:
        return "busy-unhealthy-backend"
    if group.backend_running and group.frontend_running:
        return "running-healthy"
    if group.backend_running:
        return "backend-running-frontend-stopped"
    return "backend-stopped"


def _selected_context(args: argparse.Namespace):
    from docker_dev import _compose_identity, _select_source

    repo_root = Path(args.repo_root).resolve(strict=True)
    selected, layout = _select_source(repo_root, args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    try:
        helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"][
            "FULLMAG_CUDA_BASE_IMAGE"
        ]
    except (KeyError, TypeError) as error:
        raise DockerDevUpError("Selected toolchain configuration has no immutable helper image") from error
    control = BuildControl(identity, helper_image)
    return repo_root, selected, layout, identity, control


def _discover_group(args: argparse.Namespace) -> RetainedGroup | None:
    """Discover exactly one retained group, including stopped services."""

    repo_root, selected, layout, identity, control = _selected_context(args)
    backend_ids = _project_service_ids(identity["project_name"], "backend")
    frontend_ids = _project_service_ids(identity["project_name"], "frontend")
    volume_exists = _control_volume_exists(control)
    if not backend_ids and not frontend_ids:
        if volume_exists and _control_file_exists(control, "active"):
            raise DockerDevUpError(
                "DEV control volume has an active operation but no services; "
                "daemon outcome is unknown and resources were retained"
            )
        return None
    if not volume_exists:
        raise DockerDevUpError(
            "Docker DEV containers exist without their authenticated control volume; "
            "resources retained, explicit recovery required"
        )
    if len(backend_ids) != 1 or len(frontend_ids) != 1:
        raise DockerDevUpError(
            "Existing DEV group has missing or duplicate backend/frontend containers; "
            "resources retained"
        )
    if _control_file_exists(control, "active"):
        raise DockerDevUpError(
            "Existing DEV operation is active; automatic up will not interrupt it. "
            "Wait for its terminal receipt or use the explicit recovery route"
        )
    current = control.read("development/current.json", optional=True)
    if not isinstance(current, Mapping):
        raise DockerDevUpError(
            "Existing DEV containers have no authenticated development/current.json; resources retained"
        )
    attempt, terminal, document = _read_attempt(control, current)
    if terminal.get("compose_project") != control.project or document.get("name") != control.project:
        raise DockerDevUpError("Retained DEV Compose identity differs from the selected group")
    config_sha256 = hashlib.sha256(canonical(document)).hexdigest()
    if terminal.get("config_sha256") not in (None, config_sha256):
        raise DockerDevUpError("Retained DEV Compose configuration digest differs")
    inputs = terminal.get("inputs")
    if not isinstance(inputs, Mapping):
        raise DockerDevUpError("Retained DEV terminal has no immutable inputs")
    if not _same_path(inputs.get("source_root"), selected):
        raise DockerDevUpError("Retained DEV source checkout differs from the selected checkout")
    if inputs.get("source_worktree_id") not in (None, identity["worktree_id"]):
        raise DockerDevUpError("Retained DEV source worktree identity differs")
    image = inputs.get("image_id")
    if not isinstance(image, str) or not IMAGE_ID_RE.fullmatch(image):
        raise DockerDevUpError("Retained DEV backend image is not immutable")
    backend_id = _compose_container_id(document, "backend")
    frontend_id = _compose_container_id(document, "frontend")
    if backend_id != backend_ids[0] or frontend_id != frontend_ids[0]:
        raise DockerDevUpError("Retained Compose service identity differs from Docker's project inventory")
    backend = _inspect_retained_service(document, identity, "backend", backend_id, image, terminal)
    frontend_service = document.get("services", {}).get("frontend", {})
    frontend_image = frontend_service.get("image") if isinstance(frontend_service, Mapping) else None
    if not isinstance(frontend_image, str) or not IMAGE_ID_RE.fullmatch(frontend_image):
        raise DockerDevUpError("Retained frontend image is not immutable")
    frontend = _inspect_retained_service(
        document, identity, "frontend", frontend_id, frontend_image, terminal
    )
    port = _document_port(document)
    if bool(backend.get("State", {}).get("Running")) and bool(
        frontend.get("State", {}).get("Running")
    ):
        from docker_dev_defaults import _validate_live_network

        try:
            _validate_live_network(backend_id, frontend_id, control.project, port)
        except BuildControlError as error:
            raise DockerDevUpError(str(error)) from error
        _validate_retained_network(
            backend, frontend, backend_id, frontend_id, control.project,
            identity["network_name"], port
        )
    else:
        _validate_retained_network(
            backend, frontend, backend_id, frontend_id, control.project,
            identity["network_name"], port
        )
    explicit_port = bool(getattr(args, "port_explicit", getattr(args, "port", None) is not None))
    if explicit_port and int(args.port) != port:
        raise DockerDevUpError(
            f"Existing DEV group publishes port {port}; explicit port {args.port} conflicts"
        )
    return RetainedGroup(
        repo_root=repo_root,
        source_root=selected,
        layout=layout,
        identity=identity,
        control=control,
        attempt=attempt,
        config_sha256=config_sha256,
        port=port,
        document=document,
        terminal=terminal,
        backend_id=backend_id,
        frontend_id=frontend_id,
        backend=backend,
        frontend=frontend,
    )


_SOURCE_PROBE = r'''import hashlib,json
from pathlib import Path

helper_pairs = __IMAGE_HELPER_SOURCES__

def digest(path):
    checksum = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()

changed_helpers = []
for name, relative in helper_pairs:
    try:
        image_digest = digest(Path("/opt/fullmag") / name)
        source_digest = digest(Path("/opt/fullmag/source") / relative)
    except (FileNotFoundError, OSError):
        changed_helpers.append(name + " (missing)")
        continue
    if image_digest != source_digest:
        changed_helpers.append(name)

if changed_helpers:
    print("FULLMAG_SOURCE_MATCH_V1:" + json.dumps({
        "matches": False,
        "image_helpers_match": False,
        "image_helpers_changed": changed_helpers,
    }, sort_keys=True), flush=True)
    raise SystemExit(0)

import sys
sys.path.insert(0, "/opt/fullmag")
import backend_dev
from backend_source import capture_live_source_manifest

with backend_dev._runtime_build_lock(backend_dev.BUILD_ROOT):
    receipt, _receipt_bytes, _children = backend_dev._validated_package(
        backend_dev.PACKAGE_ROOT, "existing backend package", exclude_development_control=True
    )
    _toolchain_image, toolchain = backend_dev._toolchain_identity()
    manifest = capture_live_source_manifest(
        Path("/opt/fullmag/source"), Path("/opt/fullmag/source-git"), backend_dev.BUILD_ROOT
    )
    matches = backend_dev._package_matches_fresh_live_manifest(
        receipt, manifest, toolchain, backend_dev.BACKEND_CARGO_PROFILE
    )
print("FULLMAG_SOURCE_MATCH_V1:" + json.dumps({
    "matches": bool(matches),
    "image_helpers_match": True,
    "image_helpers_changed": [],
}, sort_keys=True), flush=True)
'''
_SOURCE_PROBE = _SOURCE_PROBE.replace("__IMAGE_HELPER_SOURCES__", repr(IMAGE_HELPER_SOURCES))


_HELPER_IMAGE_PROBE = r'''import hashlib,json
from pathlib import Path

helper_pairs = __IMAGE_HELPER_SOURCES__

def digest(path):
    checksum = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()

changed = []
for name, relative in helper_pairs:
    try:
        image_digest = digest(Path("/opt/fullmag") / name)
        source_digest = digest(Path("/opt/fullmag/source") / relative)
    except (FileNotFoundError, OSError):
        changed.append(name + " (missing)")
        continue
    if image_digest != source_digest:
        changed.append(name)
print("FULLMAG_IMAGE_HELPERS_V1:" + json.dumps({
    "match": not changed, "changed": changed,
}, sort_keys=True), flush=True)
'''
_HELPER_IMAGE_PROBE = _HELPER_IMAGE_PROBE.replace(
    "__IMAGE_HELPER_SOURCES__", repr(IMAGE_HELPER_SOURCES)
)


def _helper_drift(value: Mapping[str, object]) -> None:
    if value.get("image_helpers_match") is True or value.get("match") is True:
        return
    changed = value.get("image_helpers_changed", value.get("changed"))
    if isinstance(changed, list) and changed and all(
        isinstance(name, str) and bool(name) for name in changed
    ):
        raise ImageHelperDrift(changed)
    raise DockerDevUpError("Image-helper probe returned an invalid drift result")


def _source_matches(group: RetainedGroup) -> bool:
    """Compare the live mounted checkout with the verified package in the guest."""

    result = docker_capture(
        "exec",
        group.backend_id,
        "/usr/local/bin/python3",
        "-B",
        "-c",
        _SOURCE_PROBE,
        timeout=600,
    )
    for line in reversed(result.stdout.decode("utf-8", "replace").splitlines()):
        if not line.startswith(SOURCE_MATCH_MARKER):
            continue
        value = _json_document(line[len(SOURCE_MATCH_MARKER) :], "source-match probe")
        _helper_drift(value)
        matches = value.get("matches")
        if type(matches) is not bool:
            raise DockerDevUpError("Source-match probe returned an invalid result")
        return matches
    raise DockerDevUpError("Source-match probe returned no authenticated result")


def _short_probe_labels(identity: Mapping[str, object]) -> tuple[str, ...]:
    """Return the exact source/project labels for a transient build probe."""

    from docker_compose_identity import source_labels

    try:
        project = identity["project_name"]
        if not isinstance(project, str) or not project:
            raise ValueError("project_name is missing")
        labels = {
            **source_labels(identity),
            "com.docker.compose.project": project,
            "com.docker.compose.service": "build-control",
            "org.fullmag.build.role": "probe",
        }
    except (KeyError, TypeError, ValueError) as error:
        raise DockerDevUpError("Selected source identity cannot label its helper probe") from error
    arguments: list[str] = []
    for key, value in labels.items():
        arguments.extend(("--label", f"{key}={value}"))
    return tuple(arguments)


def _image_helpers_match(group: RetainedGroup) -> bool:
    """Compare a stopped group's pinned image with the selected checkout."""

    service = group.document.get("services", {}).get("backend", {})
    image = service.get("image") if isinstance(service, Mapping) else None
    if not isinstance(image, str) or not IMAGE_ID_RE.fullmatch(image):
        raise DockerDevUpError("Retained backend image is not immutable")
    label_args = _short_probe_labels(group.identity)
    mount = (
        "type=bind,source="
        + str(group.source_root)
        + ",target=/opt/fullmag/source,readonly,bind-recursive=disabled"
    )
    result = docker_capture(
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--runtime",
        "runc",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "32",
        "--memory",
        "64m",
        "--cpus",
        "0.25",
        *label_args,
        "--user",
        "65532:65532",
        "--mount",
        mount,
        "--entrypoint",
        "/usr/local/bin/python3",
        image,
        "-B",
        "-c",
        _HELPER_IMAGE_PROBE,
        timeout=180,
    )
    marker = "FULLMAG_IMAGE_HELPERS_V1:"
    for line in reversed(result.stdout.decode("utf-8", "replace").splitlines()):
        if line.startswith(marker):
            value = _json_document(line[len(marker) :], "image-helper probe")
            _helper_drift(value)
            return True
    raise DockerDevUpError("Image-helper probe returned no authenticated result")


def _verified_build_receipt(
    group: RetainedGroup, relative: str, phase: str
) -> Mapping[str, object]:
    """Read and authenticate one immutable toolchain/image receipt."""

    try:
        receipt = group.control.read(relative, optional=True)
    except (BuildControlError, KeyError, TypeError, ValueError) as error:
        raise BuildInputUnknown(
            f"Cannot read retained {phase} build receipt; explicit recovery is required"
        ) from error
    if not isinstance(receipt, Mapping):
        raise BuildInputUnknown(
            f"Retained {phase} build receipt is missing or not an object; explicit recovery is required"
        )
    if receipt.get("phase") != phase or receipt.get("state") != "succeeded":
        raise BuildInputUnknown(
            f"Retained {phase} build receipt is not a succeeded receipt; explicit recovery is required"
        )
    if receipt.get("compose_project") != group.identity.get("project_name"):
        raise BuildInputUnknown(f"Retained {phase} build receipt belongs to another Compose group")
    image_id = receipt.get("image_id")
    source_digest = receipt.get("source_digest")
    inputs = receipt.get("inputs")
    if (
        not isinstance(image_id, str)
        or not IMAGE_ID_RE.fullmatch(image_id)
        or not isinstance(source_digest, str)
        or not SHA256_RE.fullmatch(source_digest)
        or not isinstance(inputs, Mapping)
    ):
        raise BuildInputUnknown(f"Retained {phase} build receipt inputs are incomplete")
    if hashlib.sha256(canonical(inputs)).hexdigest() != source_digest:
        raise BuildInputUnknown(f"Retained {phase} build receipt input digest is invalid")
    return receipt


def _dependency_input_manifest(source_root: Path) -> list[Mapping[str, str]]:
    """Capture the same bounded dependency inputs used by the toolchain build."""

    try:
        from bootstrap_docker_toolchain import capture_inputs, input_files

        manifest = capture_inputs(source_root)
        eligible = {path.as_posix() for path in input_files(source_root)}
        observed = {
            entry.get("path")
            for entry in manifest
            if isinstance(entry, Mapping)
        }
        if observed != eligible:
            raise ValueError("dependency input inventory differs from the tracked context")
    except (BuildControlError, OSError, RuntimeError, TypeError, ValueError) as error:
        raise BuildInputUnknown(
            "Selected dependency build inputs cannot be authenticated without a build"
        ) from error
    if not isinstance(manifest, list) or any(
        not isinstance(entry, Mapping)
        or not isinstance(entry.get("path"), str)
        or not isinstance(entry.get("sha256"), str)
        or not SHA256_RE.fullmatch(entry["sha256"])
        for entry in manifest
    ):
        raise BuildInputUnknown("Selected dependency input manifest is malformed")
    return manifest


def _image_input_manifest(
    source_root: Path,
    inventory: tuple[tuple[str, str], ...],
    dockerignore: str,
) -> list[Mapping[str, str]]:
    """Hash an image context in the same order and format as BuildKit input capture."""

    try:
        from bootstrap_docker_toolchain import read_input

        names = sorted(
            {relative for _, relative in inventory}
            | {dockerignore}
        )
        return [
            {
                "path": relative,
                "sha256": hashlib.sha256(read_input(source_root, Path(relative))).hexdigest(),
            }
            for relative in names
        ]
    except (BuildControlError, OSError, RuntimeError, TypeError, ValueError) as error:
        raise BuildInputUnknown(
            "Selected runtime image inputs cannot be authenticated without a build"
        ) from error


def _toolchain_identity(group: RetainedGroup) -> Mapping[str, object]:
    try:
        configured = toolchain_configuration(group.source_root, group.identity)
        service = configured["services"]["fem-gpu-toolchain"]
        build = service["build"]
        build_args = build["args"]
        target = build["target"]
        if not isinstance(build_args, Mapping) or not isinstance(target, str):
            raise TypeError("toolchain build configuration is incomplete")
    except (BuildControlError, KeyError, TypeError, ValueError) as error:
        raise BuildInputUnknown(
            "Selected toolchain configuration cannot be authenticated without a build"
        ) from error
    return {
        "source_inputs": _dependency_input_manifest(group.source_root),
        "build_args": dict(build_args),
        "target": target,
    }


def _backend_environment(container: Mapping[str, object]) -> Mapping[str, str]:
    config = container.get("Config")
    environment = config.get("Env") if isinstance(config, Mapping) else None
    if not isinstance(environment, list):
        raise BuildInputUnknown("Retained backend environment is missing image identity bindings")
    values: dict[str, str] = {}
    for item in environment:
        if not isinstance(item, str) or "=" not in item:
            raise BuildInputUnknown("Retained backend environment is malformed")
        key, value = item.split("=", 1)
        if not key or key in values:
            raise BuildInputUnknown("Retained backend environment has duplicate or empty keys")
        values[key] = value
    return values


def _build_inputs_match(group: RetainedGroup) -> bool:
    """Prove that current Docker build inputs still match retained images."""

    toolchain = _verified_build_receipt(group, "toolchain/verified.json", "toolchain")
    development = _verified_build_receipt(group, "image-dev/verified.json", "image-dev")
    backend = _verified_build_receipt(group, "image-backend/verified.json", "image-backend")
    toolchain_image = toolchain["image_id"]
    development_image = development["image_id"]
    backend_image = backend["image_id"]
    toolchain_inputs = toolchain["inputs"]
    development_inputs = development["inputs"]
    backend_inputs = backend["inputs"]
    if (
        not isinstance(toolchain_inputs.get("source_inputs"), list)
        or not isinstance(development_inputs.get("files"), list)
        or not isinstance(backend_inputs.get("files"), list)
        or not IMAGE_ID_RE.fullmatch(str(development_inputs.get("parent_image_id", "")))
        or not IMAGE_ID_RE.fullmatch(str(backend_inputs.get("parent_image_id", "")))
        or backend_inputs.get("parent_image_id") != development_image
    ):
        raise BuildInputUnknown("Retained Docker build receipt lineage is not authenticated")
    actual_image = group.backend.get("Image")
    if actual_image != backend_image:
        raise BuildInputUnknown(
            "Retained backend image is not bound to image-backend/verified.json"
        )
    environment = _backend_environment(group.backend)
    retained_toolchain_image = development_inputs.get("parent_image_id")
    if (
        environment.get("FULLMAG_TOOLCHAIN_IMAGE_ID") != retained_toolchain_image
        or environment.get("FULLMAG_RUNTIME_IMAGE_ID") != backend_image
    ):
        raise BuildInputUnknown(
            "Retained backend toolchain/runtime image bindings differ from verified receipts"
        )

    changed: list[str] = []
    if retained_toolchain_image != toolchain_image:
        # The latest toolchain receipt is the desired build input, while the
        # retained dev/backend receipts may still form a valid older chain.
        # That is an authenticated rebuild requirement, not an unknown receipt.
        changed.append("toolchain")
    current_toolchain = _toolchain_identity(group)
    if hashlib.sha256(canonical(current_toolchain)).hexdigest() != toolchain["source_digest"]:
        if "toolchain" not in changed:
            changed.append("toolchain")
    from docker_dev import BASE_CONTEXT_FILES, RUNTIME_IMAGE_CONTEXT_FILES

    current_development = {
        "parent_image_id": toolchain_image,
        "files": _image_input_manifest(
            group.source_root,
            tuple(BASE_CONTEXT_FILES),
            "docker/all-in-one/Dockerfile.dev.dockerignore",
        ),
    }
    if hashlib.sha256(canonical(current_development)).hexdigest() != development["source_digest"]:
        changed.append("image-dev")
    current_backend = {
        "parent_image_id": development_image,
        "files": _image_input_manifest(
            group.source_root,
            tuple(RUNTIME_IMAGE_CONTEXT_FILES),
            "docker/all-in-one/Dockerfile.backend.dockerignore",
        ),
    }
    if hashlib.sha256(canonical(current_backend)).hexdigest() != backend["source_digest"]:
        changed.append("image-backend")
    if changed:
        raise BuildInputDrift(changed)
    return True


def _qualify_running_runtime(group: RetainedGroup) -> None:
    """Require a succeeded receipt for the exact currently running pair."""

    state = group.terminal.get("state")
    if state == "succeeded":
        if (
            group.terminal.get("backend_container") != group.backend_id
            or group.terminal.get("frontend_container") != group.frontend_id
        ):
            raise DockerDevUpError(
                "Running DEV containers have no succeeded receipt for their current incarnations; "
                "use explicit recovery"
            )
        return
    if state != "failed-confirmed":
        raise DockerDevUpError(
            "Running DEV containers have no admissible terminal runtime receipt; use explicit recovery"
        )
    from docker_volume_activate import _linked_runtime_terminals

    try:
        linked = _linked_runtime_terminals(
            group.control,
            group.attempt,
            group.terminal,
            source_root=str(group.source_root),
            image=str(group.backend.get("Image", "")),
            config_sha256=group.config_sha256,
        )
    except (BuildControlError, KeyError, TypeError, ValueError) as error:
        raise DockerDevUpError(
            "Running DEV containers come from a failed start without a linked succeeded runtime receipt; "
            "use explicit recovery"
        ) from error
    if not any(
        terminal.get("backend_container") == group.backend_id
        and terminal.get("frontend_container") == group.frontend_id
        for terminal in linked
    ):
        raise DockerDevUpError(
            "Linked runtime receipts do not match the current DEV container incarnations; "
            "use explicit recovery"
        )


def _script_output_mapping_matches(group: RetainedGroup) -> bool:
    """Compare the retained output alias with the current operator mapping."""

    from docker_script_output_mounts import OUTPUT_ROOT, selected_directory, validate

    try:
        selected = selected_directory(group.source_root)
        validate(group.document)
    except (BuildControlError, KeyError, OSError, RuntimeError, TypeError, ValueError) as error:
        raise ScriptOutputMappingDrift(
            "Retained script-output mapping cannot be authenticated against current configuration"
        ) from error

    services = group.document.get("services")
    backend = services.get("backend") if isinstance(services, Mapping) else None
    if not isinstance(backend, Mapping):
        raise ScriptOutputMappingDrift("Retained Compose document has no backend output mapping")
    mounts = backend.get("volumes")
    environment = backend.get("environment", {})
    descriptor = backend.get("x-fullmag-script-output")
    if not isinstance(mounts, list) or not isinstance(environment, Mapping):
        raise ScriptOutputMappingDrift("Retained backend output mapping is malformed")
    outputs = [mount for mount in mounts if isinstance(mount, Mapping) and mount.get("target") == OUTPUT_ROOT]
    aliases = [
        mount
        for mount in mounts
        if isinstance(mount, Mapping)
        and isinstance(mount.get("target"), str)
        and mount["target"].startswith(OUTPUT_ROOT)
    ]
    if selected is None:
        if aliases or environment.get("FULLMAG_SCRIPT_OUTPUT_ROOT") or environment.get(
            "FULLMAG_SCRIPT_OUTPUT_SOURCE_DIR"
        ) or descriptor:
            raise ScriptOutputMappingDrift(
                "Retained script-output alias is present but current configuration disables it"
            )
        return True
    try:
        relative = selected.resolve(strict=True).relative_to(Path(group.source_root).resolve(strict=True)).as_posix()
    except (OSError, RuntimeError, ValueError) as error:
        raise ScriptOutputMappingDrift(
            "Current script-output directory is outside the selected source checkout"
        ) from error
    source_mounts = [mount for mount in mounts if isinstance(mount, Mapping) and mount.get("target") == "/opt/fullmag/source"]
    if len(aliases) != 1 or len(outputs) != 1 or len(source_mounts) != 1 or not isinstance(descriptor, Mapping):
        raise ScriptOutputMappingDrift("Retained script-output alias is missing or ambiguous")
    source_mount, output_mount = source_mounts[0], outputs[0]
    output_bind = output_mount.get("bind")
    expected_source = Path(group.source_root).resolve(strict=True)
    expected_output = selected.resolve(strict=True)
    if (
        source_mount.get("type") != "bind"
        or source_mount.get("read_only") is not True
        or not _same_path(source_mount.get("source"), expected_source)
        or output_mount.get("type") != "bind"
        or output_mount.get("read_only") is not False
        or not _same_path(output_mount.get("source"), expected_output)
        or not isinstance(output_bind, Mapping)
        or output_bind.get("create_host_path") is not False
        or descriptor.get("schema") != "fullmag.script-output-bind.v1"
        or descriptor.get("source_relative") != relative
        or descriptor.get("target") != OUTPUT_ROOT
        or environment.get("FULLMAG_SCRIPT_OUTPUT_ROOT") != OUTPUT_ROOT
        or environment.get("FULLMAG_SCRIPT_OUTPUT_SOURCE_DIR") != "/opt/fullmag/source/" + relative
    ):
        raise ScriptOutputMappingDrift("Retained script-output alias differs from current configuration")
    return True


def _lifecycle_args(group: RetainedGroup, args: argparse.Namespace, **updates) -> argparse.Namespace:
    values = vars(args).copy()
    values.update(
        repo_root=group.repo_root,
        source_root=group.source_root,
        port=group.port,
        attempt=group.attempt,
        config_sha256=group.config_sha256,
        **updates,
    )
    return argparse.Namespace(**values)


def _stable_activation_request_id(group: RetainedGroup, args: argparse.Namespace) -> str | None:
    """Derive an idempotent activation fence from the admitted script bytes."""

    explicit = getattr(args, "request_id", None)
    if explicit is not None:
        return explicit
    script = getattr(args, "script", None)
    if script is None:
        return None
    import fullmag_storage as storage
    from docker_startup_script import prepare

    try:
        source_commit = storage.git(group.source_root, "rev-parse", "HEAD")
        authorization = prepare(
            group.source_root,
            script,
            request_id="fullmag-activation-probe",
            source_commit=source_commit,
        )
    except (OSError, TypeError, ValueError, storage.StorageError) as error:
        raise DockerDevUpError(
            "Cannot derive a stable script activation request fence from the selected checkout"
        ) from error
    material = b"\0".join(
        value.encode("utf-8")
        for value in (
            group.attempt,
            group.config_sha256,
            authorization.source_relative,
            authorization.source_sha256,
            authorization.source_commit or "",
        )
    )
    return "docker-volume-up-" + hashlib.sha256(material).hexdigest()


def _activation_args(group: RetainedGroup, args: argparse.Namespace) -> argparse.Namespace:
    values = vars(args).copy()
    values.update(repo_root=group.repo_root, source_root=group.source_root, script=args.script)
    values["request_id"] = _stable_activation_request_id(group, args)
    # ``activate_discovered`` uses an explicit port only when the operator
    # supplied one.  Otherwise it discovers and pins the retained port.
    if not getattr(args, "port_explicit", False):
        values["port"] = None
    else:
        values["port"] = group.port
    return argparse.Namespace(**values)


def _activate_if_requested(group: RetainedGroup, args: argparse.Namespace) -> None:
    if getattr(args, "script", None) is None:
        return
    from docker_dev_defaults import activate_discovered

    activate_discovered(_activation_args(group, args))


def _recreate_after_drift(group: RetainedGroup, args: argparse.Namespace, *, drain: bool) -> None:
    from docker_volume_dev import recreate

    if drain:
        from docker_volume_dev import stop_idle

        stop_idle(_lifecycle_args(group, args, script=None))
    recreate(_lifecycle_args(group, args, script=None))
    refreshed = _discover_group(args)
    if refreshed is None:
        raise DockerDevUpError(
            "DEV group disappeared after managed recreate; activation outcome is unknown"
        )
    if _service_mode(refreshed) != "running-healthy":
        raise DockerDevUpError(
            "Managed recreate did not leave a healthy backend/frontend group; "
            "activation is withheld"
        )
    _qualify_running_runtime(refreshed)
    _activate_if_requested(refreshed, args)


def _reconcile_group(group: RetainedGroup, args: argparse.Namespace) -> None:
    from docker_volume_dev import restart_idle, resume

    mode = _service_mode(group)
    if mode in {"running-healthy", "backend-running-frontend-stopped"}:
        _qualify_running_runtime(group)
    if mode != "busy-unhealthy-backend":
        try:
            _build_inputs_match(group)
        except BuildInputDrift:
            _recreate_after_drift(group, args, drain=group.backend_running)
            return
    try:
        _script_output_mapping_matches(group)
    except ScriptOutputMappingDrift as error:
        if mode == "busy-unhealthy-backend":
            raise DockerDevUpError(
                "Retained script-output mapping changed while the backend is unhealthy; "
                "automatic up will not interrupt its pending operation"
            ) from error
        _recreate_after_drift(group, args, drain=group.backend_running)
        return
    if mode == "busy-unhealthy-backend":
        if not group.frontend_running:
            # A backend that is still compiling owns the active container but
            # has no frontend admission yet.  Resume only observes that
            # retained operation and starts the frontend; it never starts a
            # second backend or interrupts the compiler.
            resume(_lifecycle_args(group, args, restart_backend=False))
            _activate_if_requested(group, args)
            return
        raise DockerDevUpError(
            "Existing backend is running but not healthy; automatic up will not interrupt "
            "a pending build or unknown runtime. Inspect its logs and use explicit recovery"
        )
    if mode == "running-healthy":
        try:
            source_matches = _source_matches(group)
        except ImageHelperDrift:
            # The source probe has authenticated an image-owned helper change.
            # Stop only after the backend has drained, then let the managed
            # recreate route rebuild the pinned image and retain all state.
            _recreate_after_drift(group, args, drain=True)
            return
        if source_matches:
            _activate_if_requested(group, args)
            return
        restart_idle(_lifecycle_args(group, args))
        _activate_if_requested(group, args)
        return
    if mode == "backend-running-frontend-stopped":
        try:
            source_matches = _source_matches(group)
        except ImageHelperDrift:
            _recreate_after_drift(group, args, drain=True)
            return
        resume(_lifecycle_args(group, args, restart_backend=False))
        if not source_matches:
            # Bringing the frontend up first makes restart_idle's safety gate
            # applicable without replacing either named volume.
            restart_idle(_lifecycle_args(group, args))
        _activate_if_requested(group, args)
        return
    # A stopped backend is resumed with the exact retained receipt.  The
    # backend's image-owned start path captures the mounted source and either
    # reuses the verified package or performs the incremental build in /build.
    try:
        _image_helpers_match(group)
    except ImageHelperDrift:
        # A stopped group is safe to recreate immediately: no active runtime
        # can be interrupted, and recreate keeps its recorded state/volumes.
        _recreate_after_drift(group, args, drain=False)
        return
    resume(_lifecycle_args(group, args, restart_backend=True))
    _activate_if_requested(group, args)


def ensure_up(args: argparse.Namespace) -> None:
    """Reconcile one selected DEV group and leave its UI available."""

    group = _discover_group(args)
    if group is None:
        from docker_volume_dev import start

        if getattr(args, "script", None) is None:
            start(args)
            return
        start_args = argparse.Namespace(**vars(args))
        # A regular up must not turn the requested script into startup-mode
        # replay.  Admit the group first, then use the explicit activation
        # operation with its stable request fence.
        start_args.script = None
        start(start_args)
        group = _discover_group(args)
        if group is None:
            raise DockerDevUpError(
                "DEV group disappeared after managed start; activation outcome is unknown"
            )
        _activate_if_requested(group, args)
        return
    _reconcile_group(group, args)
