"""Per-group DEV resource ledger (ADR 0067 point 1, profile ``group-ledger-v1``).

A volume DEV group keeps its resource ledger in one Docker named volume owned
by its Compose project.  The backend sees it at the historical ``/host-ledger``
path, so the native writer (plain files plus ``flock``) and the stopped-backend
recovery helpers keep their exact layout.  There is no ext4 image, loop device,
privileged ``nsenter`` helper or host capacity descriptor.  The ledger policy is
the group's own static budget; groups never admit reservations against each
other.  Release, qualification and the managed runtime keep ``host-ledger-v1``.

``FULLMAG_DOCKER_HOST_ID`` stays the Docker daemon digest because storage
admission compares it with the engine.  The ledger's logical host identity is
derived from that digest and the Compose project, so two groups on one daemon
never share a host ID, node ID or ledger-root pin.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import PurePosixPath
import re
from typing import Any, Callable, Mapping

from bootstrap_docker_toolchain import (
    CONTROL_ROOT,
    CONTROL_VOLUME_PREFIX,
    CONTROL_VOLUME_SCHEMA,
    control_volume_name,
)

PROFILE = "group-ledger-v1"
MOUNT_TARGET = "/host-ledger"
LEDGER_ROOT = "/host-ledger/ledger"
VOLUME_ROLE = "group-ledger"
# Must match docker_volume_dev._owned_volume naming for VOLUME_ROLE.
VOLUME_PREFIX = "fullmag-dev-" + VOLUME_ROLE + "-v1-"
COMPOSE_VOLUME = "group-ledger"
HOST_ID_SCHEMA = "fullmag.docker-group-ledger-host-id.v1"
ATTESTATION_SCHEMA = "fullmag.docker-group-ledger-attestation.v1"
HOST_ID_ENV = "FULLMAG_GROUP_LEDGER_HOST_ID"
PRIVATE_GROUP_STORAGE_ENV = "FULLMAG_PRIVATE_GROUP_STORAGE"
PRIVATE_GROUP_STORAGE = "group-volume-v1"
# Environment owned by the global host-ledger overlay; never part of a group.
GLOBAL_ONLY_ENVIRONMENT = frozenset({
    "FULLMAG_HOST_LEDGER_STORAGE_ROOT", "FULLMAG_HOST_LEDGER_BACKING_IMAGE",
    "FULLMAG_HOST_LEDGER_MOUNT_ROOT", "FULLMAG_HOST_LEDGER_LOCK_PATH",
    "FULLMAG_HOST_LEDGER_OWNER_MARKER", "FULLMAG_HOST_LEDGER_SIZE_BYTES",
    "FULLMAG_HOST_LEDGER_MOUNT_TARGET", "FULLMAG_HOST_LEDGER_PROJECT_ID",
    "FULLMAG_DOCKER_HOST_CAPACITY_PATH", "FULLMAG_DOCKER_HOST_CAPACITY_SHA256",
    "FULLMAG_DOCKER_HOST_CAPACITY_MIGRATION_SHA256",
})
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_PROJECT = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,254}$")
_CONTROL_VOLUME = re.compile(r"^" + re.escape(CONTROL_VOLUME_PREFIX) + r".+-[0-9a-f]{16}$")
_PRIVATE_SUBPATH = re.compile(r"^(?:private/ledger|namespaces/[0-9a-f]{32}/private/ledger)$")


class GroupLedgerError(RuntimeError):
    """The group ledger identity, mount or environment differs from its contract."""


def _canonical(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _checked(daemon_id_sha256: str, compose_project: str) -> tuple[str, str]:
    if not isinstance(daemon_id_sha256, str) or _HEX64.fullmatch(daemon_id_sha256) is None:
        raise GroupLedgerError("Group ledger requires the verified Docker daemon SHA-256")
    if not isinstance(compose_project, str) or _PROJECT.fullmatch(compose_project) is None:
        raise GroupLedgerError("Group ledger requires an exact Compose project name")
    return daemon_id_sha256, compose_project


def _control_volume(compose_project: str) -> str:
    try:
        return control_volume_name(compose_project)
    except (TypeError, ValueError) as error:
        raise GroupLedgerError("Private group ledger requires a canonical Compose project") from error


def host_id(daemon_id_sha256: str, compose_project: str) -> str:
    """Return the logical ledger host ID of one Compose group on one daemon."""
    daemon_id_sha256, compose_project = _checked(daemon_id_sha256, compose_project)
    return hashlib.sha256(_canonical({
        "schema": HOST_ID_SCHEMA, "profile": PROFILE,
        "daemon_id_sha256": daemon_id_sha256, "compose_project": compose_project,
    })).hexdigest()


def volume_key(daemon_id_sha256: str, compose_project: str, generation: str | None = None) -> str:
    """Return the owned-volume key; the volume is never shared between groups."""
    identity = {
        "schema": "fullmag.docker-group-ledger-volume.v1",
        "host_id": host_id(daemon_id_sha256, compose_project),
    }
    if generation is not None:
        if not isinstance(generation, str) or re.fullmatch(r"[0-9a-f]{32}", generation) is None:
            raise GroupLedgerError("Fresh group ledger requires an exact archive operation")
        identity["fresh_runtime_generation"] = generation
    return hashlib.sha256(_canonical(identity)).hexdigest()


def profile(daemon_id_sha256: str, compose_project: str, volume_name: str,
            image_id: str, *, ledger_subpath: str = "") -> dict[str, Any]:
    """Return the backend Compose fragment and the profile kept for attestation."""
    daemon_id_sha256, compose_project = _checked(daemon_id_sha256, compose_project)
    if not isinstance(volume_name, str) or not volume_name:
        raise GroupLedgerError("Group ledger volume name is required")
    if ledger_subpath:
        if not isinstance(ledger_subpath, str) or _PRIVATE_SUBPATH.fullmatch(ledger_subpath) is None:
            raise GroupLedgerError("Private group ledger subpath is unsafe or names another role")
        if volume_name != _control_volume(compose_project):
            raise GroupLedgerError("Private group ledger must use its canonical Compose control volume")
        private_group_storage = True
    else:
        if ledger_subpath != "" or not volume_name.startswith(VOLUME_PREFIX):
            raise GroupLedgerError("Group ledger volume name differs from its owned prefix")
        private_group_storage = False
    environment = {
        "FULLMAG_DOCKER_HOST_EXECUTION": "1",
        "FULLMAG_DOCKER_HOST_ID": daemon_id_sha256,
        "FULLMAG_HOST_LEDGER_PROFILE": PROFILE,
        "FULLMAG_HOST_LEDGER_ROOT": LEDGER_ROOT,
        HOST_ID_ENV: host_id(daemon_id_sha256, compose_project),
    }
    if private_group_storage:
        environment[PRIVATE_GROUP_STORAGE_ENV] = PRIVATE_GROUP_STORAGE
    mount = {"type": "volume", "source": COMPOSE_VOLUME, "target": MOUNT_TARGET,
             "volume": {"nocopy": True}}
    if private_group_storage:
        mount["volume"]["subpath"] = ledger_subpath
    result = {
        "profile": PROFILE, "image_id": image_id, "compose_project": compose_project,
        "volume_name": volume_name, "environment": environment,
        "backend": {"environment": environment, "volumes": [mount]},
        "compose_volume": {"name": volume_name, "external": True},
    }
    if private_group_storage:
        result["ledger_subpath"] = ledger_subpath
    return result


def retained_profile(document: Mapping[str, Any], image_id: str) -> dict[str, Any]:
    """Rebuild the attestation profile from one retained group Compose document."""
    try:
        backend = document["services"]["backend"]
        environment = backend["environment"]
        volume = document["volumes"][COMPOSE_VOLUME]
        project = document["name"]
    except (KeyError, TypeError) as error:
        raise GroupLedgerError("Retained Compose has no complete group ledger binding") from error
    if not isinstance(volume, Mapping) or volume.get("external") is not True:
        raise GroupLedgerError("Retained group ledger volume is not an external named volume")
    if not isinstance(backend, Mapping) or not isinstance(environment, Mapping):
        raise GroupLedgerError("Retained group ledger service environment is malformed")
    mounts = backend.get("volumes")
    if not isinstance(mounts, list):
        raise GroupLedgerError("Retained backend has no explicit group ledger mount")
    matches = [mount for mount in mounts if isinstance(mount, Mapping)
               and mount.get("target") == MOUNT_TARGET]
    if len(matches) != 1:
        raise GroupLedgerError("Retained backend must declare exactly one group ledger mount")
    mount = matches[0]
    options = mount.get("volume")
    if (mount.get("type") != "volume" or mount.get("source") != COMPOSE_VOLUME
            or mount.get("read_only", False) is not False or not isinstance(options, Mapping)
            or options.get("nocopy") is not True
            or set(options) - {"nocopy", "subpath"}):
        raise GroupLedgerError("Retained group ledger mount differs from its volume contract")
    ledger_subpath = options.get("subpath", "")
    if not isinstance(ledger_subpath, str):
        raise GroupLedgerError("Retained group ledger subpath is malformed")
    private_flag = environment.get(PRIVATE_GROUP_STORAGE_ENV)
    if private_flag not in (None, PRIVATE_GROUP_STORAGE):
        raise GroupLedgerError("Retained group storage profile is unknown")
    expected = profile(environment.get("FULLMAG_DOCKER_HOST_ID"), project,
                       volume.get("name"), image_id, ledger_subpath=ledger_subpath)
    if any(environment.get(key) != value for key, value in expected["environment"].items()):
        raise GroupLedgerError("Retained group ledger environment differs from its project identity")
    if private_flag is None and ledger_subpath:
        raise GroupLedgerError("Retained private group ledger lacks its storage profile marker")
    return expected


def is_group_ledger_backend(environment: Mapping[str, Any]) -> bool:
    return environment.get("FULLMAG_HOST_LEDGER_PROFILE") == PROFILE


def is_group_ledger_mount(mount: Mapping[str, Any]) -> bool:
    """Classify a likely group ledger mount, never prove its private subpath.

    A control-volume name is only a candidate hint; validate_container still
    requires exact HostConfig subpath or a source beneath the inspected volume.
    """
    name = mount.get("Name")
    return (mount.get("Destination") == MOUNT_TARGET and mount.get("Type") == "volume"
            and isinstance(name, str)
            and (name.startswith(VOLUME_PREFIX) or _CONTROL_VOLUME.fullmatch(name) is not None))


def _env_map(config: Mapping[str, Any]) -> dict[str, str]:
    values = {}
    for item in config.get("Env", []) or []:
        if isinstance(item, str) and "=" in item:
            key, value = item.split("=", 1)
            values[key] = value
    return values


def _validate_expected_storage(expected: Mapping[str, Any]) -> str:
    project = expected.get("compose_project")
    volume_name = expected.get("volume_name")
    subpath = expected.get("ledger_subpath", "")
    environment = expected.get("environment")
    if not isinstance(environment, Mapping):
        raise GroupLedgerError("Expected group ledger profile has no environment")
    daemon_id, project = _checked(environment.get("FULLMAG_DOCKER_HOST_ID"), project)
    required_environment = {
        "FULLMAG_DOCKER_HOST_EXECUTION": "1",
        "FULLMAG_DOCKER_HOST_ID": daemon_id,
        "FULLMAG_HOST_LEDGER_PROFILE": PROFILE,
        "FULLMAG_HOST_LEDGER_ROOT": LEDGER_ROOT,
        HOST_ID_ENV: host_id(daemon_id, project),
    }
    if any(environment.get(key) != value for key, value in required_environment.items()):
        raise GroupLedgerError("Expected group ledger environment is inconsistent")
    if subpath:
        if (not isinstance(subpath, str) or _PRIVATE_SUBPATH.fullmatch(subpath) is None
                or volume_name != _control_volume(project)
                or environment.get(PRIVATE_GROUP_STORAGE_ENV) != PRIVATE_GROUP_STORAGE):
            raise GroupLedgerError("Expected private group ledger identity is invalid")
    elif (subpath != "" or not isinstance(volume_name, str)
          or not volume_name.startswith(VOLUME_PREFIX)
          or PRIVATE_GROUP_STORAGE_ENV in environment):
        raise GroupLedgerError("Expected legacy group ledger identity is invalid")
    return subpath


def _validated_volume_mountpoint(volume_name: str, compose_project: str,
                                 docker_text: Callable[..., str]) -> str:
    output = docker_text("volume", "inspect", volume_name)
    try:
        records = json.loads(output.decode("utf-8") if isinstance(output, bytes) else output)
    except (TypeError, ValueError, UnicodeDecodeError) as error:
        raise GroupLedgerError("Private group ledger volume inspect is malformed") from error
    if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], Mapping):
        raise GroupLedgerError("Private group ledger volume inspect is ambiguous")
    record = records[0]
    labels = record.get("Labels")
    expected_labels = {
        "com.fullmag.compose.project": compose_project,
        "com.fullmag.toolchain.control.schema": CONTROL_VOLUME_SCHEMA,
        "com.fullmag.toolchain.control.project": compose_project,
        "com.fullmag.toolchain.control.mount": CONTROL_ROOT,
    }
    mountpoint = record.get("Mountpoint")
    if (record.get("Name") != volume_name or record.get("Driver") != "local"
            or record.get("Options") not in (None, {}) or not isinstance(labels, Mapping)
            or any(labels.get(key) != value for key, value in expected_labels.items())
            or not isinstance(mountpoint, str) or not mountpoint.startswith("/")):
        raise GroupLedgerError("Private group ledger volume mountpoint is not authenticated")
    path = PurePosixPath(mountpoint)
    if str(path) != mountpoint or ".." in path.parts:
        raise GroupLedgerError("Private group ledger mountpoint is not canonical")
    return mountpoint


def _attest_private_subpath(actual: Mapping[str, Any], mount: Mapping[str, Any],
                            expected: Mapping[str, Any], subpath: str,
                            docker_text: Callable[..., str]) -> None:
    host_config = actual.get("HostConfig") or {}
    if not isinstance(host_config, Mapping):
        raise GroupLedgerError("Backend HostConfig is malformed")
    host_mounts = host_config.get("Mounts")
    candidates = []
    if host_mounts is not None:
        if not isinstance(host_mounts, list):
            raise GroupLedgerError("Backend HostConfig mount list is malformed")
        candidates = [item for item in host_mounts if isinstance(item, Mapping)
                      and item.get("Target") == MOUNT_TARGET]
        if len(candidates) > 1:
            raise GroupLedgerError("Backend has duplicate ledger mount declarations")
    if candidates:
        configured = candidates[0]
        if (configured.get("Type") != "volume"
                or configured.get("Source") != expected["volume_name"]):
            raise GroupLedgerError("Backend HostConfig ledger source differs from its group volume")
        options = configured.get("VolumeOptions")
        if options is not None and not isinstance(options, Mapping):
            raise GroupLedgerError("Backend HostConfig volume options are malformed")
        if isinstance(options, Mapping) and "Subpath" in options:
            if options.get("Subpath") != subpath:
                raise GroupLedgerError("Backend HostConfig ledger subpath differs")
            return

    source = mount.get("Source")
    if not isinstance(source, str):
        raise GroupLedgerError("Backend inspect does not expose the private ledger subpath")
    mountpoint = _validated_volume_mountpoint(
        expected["volume_name"], expected["compose_project"], docker_text)
    expected_source = str(PurePosixPath(mountpoint).joinpath(*subpath.split("/")))
    if source != expected_source:
        raise GroupLedgerError("Backend mount source does not contain the authenticated ledger subpath")


def validate_container(actual: Mapping[str, Any], expected: Mapping[str, Any],
                       docker_text: Callable[..., str]) -> dict[str, Any]:
    """Attest that the started backend uses exactly its own group ledger volume."""
    ledger_subpath = _validate_expected_storage(expected)
    container_id = actual.get("Id")
    config = actual.get("Config") or {}
    labels = config.get("Labels") or {}
    if not isinstance(container_id, str) or _HEX64.fullmatch(container_id) is None:
        raise GroupLedgerError("Backend inspect has no exact container ID")
    if (actual.get("Image") != expected["image_id"]
            or labels.get("com.docker.compose.project") != expected["compose_project"]
            or labels.get("com.docker.compose.service") != "backend"):
        raise GroupLedgerError("Backend identity differs from its group ledger profile")
    environment = _env_map(config)
    if any(environment.get(key) != value for key, value in expected["environment"].items()):
        raise GroupLedgerError("Backend did not receive the exact group ledger environment")
    leaked = sorted(GLOBAL_ONLY_ENVIRONMENT & set(environment))
    if leaked:
        raise GroupLedgerError("Backend group ledger carries global host-ledger fields: " + ", ".join(leaked))
    mounts = [mount for mount in actual.get("Mounts", []) or []
              if isinstance(mount, Mapping) and mount.get("Destination") == MOUNT_TARGET]
    if (len(mounts) != 1 or mounts[0].get("Type") != "volume" or mounts[0].get("RW") is not True
            or mounts[0].get("Name") != expected["volume_name"] or mounts[0].get("Driver") != "local"):
        raise GroupLedgerError("Backend must mount exactly its own writable group ledger volume")
    if ledger_subpath:
        _attest_private_subpath(actual, mounts[0], expected, ledger_subpath, docker_text)
    host_config = actual.get("HostConfig") or {}
    if host_config.get("Privileged") or config.get("User") != "65532:65532":
        raise GroupLedgerError("Backend group ledger service isolation differs")
    docker_text("exec", container_id, "/bin/sh", "-ceu",
                "test -d /host-ledger/ledger; test ! -L /host-ledger/ledger; test -w /host-ledger/ledger")
    attestation = {
        "schema": ATTESTATION_SCHEMA, "profile": PROFILE,
        "backend_container_id": container_id, "compose_project": expected["compose_project"],
        "volume_name": expected["volume_name"], "mount_target": MOUNT_TARGET,
        "ledger_root": LEDGER_ROOT, "host_id": expected["environment"][HOST_ID_ENV],
        "daemon_id_sha256": expected["environment"]["FULLMAG_DOCKER_HOST_ID"],
        "backend_verification": "PASS",
    }
    if ledger_subpath:
        attestation["ledger_subpath"] = ledger_subpath
    return attestation
