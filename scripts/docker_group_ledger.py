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
import re
from typing import Any, Callable, Mapping

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
            image_id: str) -> dict[str, Any]:
    """Return the backend Compose fragment and the profile kept for attestation."""
    if not isinstance(volume_name, str) or not volume_name.startswith(VOLUME_PREFIX):
        raise GroupLedgerError("Group ledger volume name differs from its owned prefix")
    environment = {
        "FULLMAG_DOCKER_HOST_EXECUTION": "1",
        "FULLMAG_DOCKER_HOST_ID": daemon_id_sha256,
        "FULLMAG_HOST_LEDGER_PROFILE": PROFILE,
        "FULLMAG_HOST_LEDGER_ROOT": LEDGER_ROOT,
        HOST_ID_ENV: host_id(daemon_id_sha256, compose_project),
    }
    mount = {"type": "volume", "source": COMPOSE_VOLUME, "target": MOUNT_TARGET,
             "volume": {"nocopy": True}}
    return {
        "profile": PROFILE, "image_id": image_id, "compose_project": compose_project,
        "volume_name": volume_name, "environment": environment,
        "backend": {"environment": environment, "volumes": [mount]},
        "compose_volume": {"name": volume_name, "external": True},
    }


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
    expected = profile(environment.get("FULLMAG_DOCKER_HOST_ID"), project, volume.get("name"), image_id)
    if any(environment.get(key) != value for key, value in expected["environment"].items()):
        raise GroupLedgerError("Retained group ledger environment differs from its project identity")
    return expected


def is_group_ledger_backend(environment: Mapping[str, Any]) -> bool:
    return environment.get("FULLMAG_HOST_LEDGER_PROFILE") == PROFILE


def is_group_ledger_mount(mount: Mapping[str, Any]) -> bool:
    """True for a Docker inspect mount of a group ledger (never a global consumer)."""
    name = mount.get("Name")
    return (mount.get("Destination") == MOUNT_TARGET and mount.get("Type") == "volume"
            and isinstance(name, str) and name.startswith(VOLUME_PREFIX))


def _env_map(config: Mapping[str, Any]) -> dict[str, str]:
    values = {}
    for item in config.get("Env", []) or []:
        if isinstance(item, str) and "=" in item:
            key, value = item.split("=", 1)
            values[key] = value
    return values


def validate_container(actual: Mapping[str, Any], expected: Mapping[str, Any],
                       docker_text: Callable[..., str]) -> dict[str, Any]:
    """Attest that the started backend uses exactly its own group ledger volume."""
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
    host_config = actual.get("HostConfig") or {}
    if host_config.get("Privileged") or config.get("User") != "65532:65532":
        raise GroupLedgerError("Backend group ledger service isolation differs")
    docker_text("exec", container_id, "/bin/sh", "-ceu",
                "test -d /host-ledger/ledger; test ! -L /host-ledger/ledger; test -w /host-ledger/ledger")
    return {
        "schema": ATTESTATION_SCHEMA, "profile": PROFILE,
        "backend_container_id": container_id, "compose_project": expected["compose_project"],
        "volume_name": expected["volume_name"], "mount_target": MOUNT_TARGET,
        "ledger_root": LEDGER_ROOT, "host_id": expected["environment"][HOST_ID_ENV],
        "daemon_id_sha256": expected["environment"]["FULLMAG_DOCKER_HOST_ID"],
        "backend_verification": "PASS",
    }
