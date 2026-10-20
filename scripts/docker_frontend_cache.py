"""Prepare and attest the frontend development state named volume.

The active v2 path keeps pnpm, node_modules, Next cache, logs and receipts in
Docker named volumes owned by the selected Compose group.  Windows storage is
used only for readonly source binds and user data.  The old ext4 adapter is
kept below only as a compatibility implementation for historical receipts;
the exported v2 ``prepare`` and ``validate_container`` functions never call
it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import uuid
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping

from docker_named_volume_safety import (
    DockerNamedVolumeSafetyError,
    validate_local_named_volume,
)


SCHEMA = "fullmag.frontend-cache.v2"
KEY_SCHEMA = "fullmag.frontend-cache-key.v2"
PROFILE = "fullmag-frontend-cache-v2"
MAINTENANCE_PROFILE = "fullmag-frontend-cache-maintenance-v1"
MAINTENANCE_SERVICE = "frontend-cache-maintenance"
STATE_MAINTENANCE_PROFILE = "frontend-cache-maintenance"
STATE_MAINTENANCE_SERVICE = "frontend-cache-maintenance"
CONSUMER_PROFILE_LABEL = "com.fullmag.frontend-cache.profile"
CONSUMER_KEY_LABEL = "com.fullmag.frontend-cache.key"
# ext4 labels are limited to sixteen bytes.
IMAGE_LABEL = "fm-fe-cache-v1"
CACHE_SIZE_BYTES = 8 * 1024 * 1024 * 1024
BACKEND_HEADROOM_BYTES = CACHE_SIZE_BYTES
MAX_COPY_BYTES = 2 * 1024 * 1024
DAEMON_HOST_PREFIX = "/run/desktop/mnt/host"

# This is a cache identity/seed contract, not the effective Watchpack runtime
# setting.  Keep the legacy value so an operator override does not select a
# new dependency/cache backing image.
CACHE_IDENTITY_WATCHPACK_POLLING_KEY = "watchpack_polling_ms"
CACHE_IDENTITY_WATCHPACK_POLLING_MS = "500"
WATCHPACK_POLLING_MIN_MS = 250
WATCHPACK_POLLING_MAX_MS = 10000

DEFAULT_TOOLPINS: dict[str, str] = {
    "node": "v24.18.0",
    "pnpm": "10.8.1",
    CACHE_IDENTITY_WATCHPACK_POLLING_KEY: CACHE_IDENTITY_WATCHPACK_POLLING_MS,
}

CHILD_TARGETS: dict[str, str] = {
    "cache": "/state/development/cache",
    "pnpm_store": "/state/development/pnpm-store",
    "workspace_node_modules": "/state/development/workspace/node_modules",
    "control_room_node_modules": "/state/development/workspace/apps/control-room/node_modules",
}

ENV_PROFILE = "FULLMAG_FRONTEND_CACHE_PROFILE"
ENV_PROJECT_ID = "FULLMAG_FRONTEND_CACHE_PROJECT_ID"
ENV_KEY = "FULLMAG_FRONTEND_CACHE_KEY"
ENV_SCHEMA = "FULLMAG_FRONTEND_CACHE_SCHEMA"
ENV_STORAGE_ROOT = "FULLMAG_FRONTEND_CACHE_STORAGE_ROOT"
ENV_BACKING_IMAGE = "FULLMAG_FRONTEND_CACHE_BACKING_IMAGE"
ENV_LOCK_PATH = "FULLMAG_FRONTEND_CACHE_LOCK_PATH"
ENV_MOUNT_ROOT = "FULLMAG_FRONTEND_CACHE_MOUNT_ROOT"
ENV_OWNER_MARKER = "FULLMAG_FRONTEND_CACHE_OWNER_MARKER"
ENV_SIZE_BYTES = "FULLMAG_FRONTEND_CACHE_SIZE_BYTES"
ENV_MOUNT_TARGET = "FULLMAG_FRONTEND_CACHE_MOUNT_TARGET"
ENV_FILESYSTEM_UUID = "FULLMAG_FRONTEND_CACHE_FILESYSTEM_UUID"
ENV_RUNTIME_IMAGE_ID = "FULLMAG_FRONTEND_CACHE_RUNTIME_IMAGE_ID"
ENV_HELPER_IMAGE = "FULLMAG_FRONTEND_CACHE_HELPER_IMAGE"
ENV_HELPER_PATH = "FULLMAG_FRONTEND_CACHE_HELPER_PATH"
ENV_HOST_PID = "FULLMAG_FRONTEND_CACHE_HOST_PID"
ENV_UID = "FULLMAG_FRONTEND_CACHE_UID"
ENV_GID = "FULLMAG_FRONTEND_CACHE_GID"
ENV_SOURCE_ROOT = "FULLMAG_FRONTEND_CACHE_SOURCE_ROOT"
ENV_WORKTREE_ID = "FULLMAG_FRONTEND_CACHE_WORKTREE_ID"
ENV_HOST_PORT = "FULLMAG_FRONTEND_CACHE_HOST_PORT"
ENV_DEPENDENCY_SEED = "FULLMAG_FRONTEND_CACHE_DEPENDENCY_SEED_SHA256"
ENV_TOOLPINS = "FULLMAG_FRONTEND_CACHE_TOOLPINS_SHA256"
ENV_CACHE_SOURCE = "FULLMAG_FRONTEND_CACHE_CACHE_SOURCE"
ENV_PNPM_SOURCE = "FULLMAG_FRONTEND_CACHE_PNPM_STORE_SOURCE"
ENV_WORKSPACE_NODE_MODULES_SOURCE = "FULLMAG_FRONTEND_CACHE_WORKSPACE_NODE_MODULES_SOURCE"
ENV_CONTROL_ROOM_NODE_MODULES_SOURCE = "FULLMAG_FRONTEND_CACHE_CONTROL_ROOM_NODE_MODULES_SOURCE"

ENV_STATE_SCHEMA = "FULLMAG_FRONTEND_STATE_SCHEMA"
ENV_STATE_PROFILE = "FULLMAG_FRONTEND_STATE_PROFILE"
ENV_STATE_MAINTENANCE_PROFILE = "FULLMAG_FRONTEND_STATE_MAINTENANCE_PROFILE"
ENV_STATE_MAINTENANCE_ACTION = "FULLMAG_FRONTEND_STATE_MAINTENANCE_ACTION"
ENV_STATE_ROOT = "FULLMAG_FRONTEND_STATE_ROOT"
ENV_STATE_PROJECT_ID = "FULLMAG_FRONTEND_STATE_PROJECT_ID"
ENV_STATE_CACHE_KEY = "FULLMAG_FRONTEND_STATE_CACHE_KEY"
ENV_STATE_VOLUME = "FULLMAG_FRONTEND_STATE_VOLUME"
ENV_STATE_OWNER_UID = "FULLMAG_FRONTEND_STATE_OWNER_UID"
ENV_STATE_OWNER_GID = "FULLMAG_FRONTEND_STATE_OWNER_GID"

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_WINDOWS_ABSOLUTE = re.compile(r"^[A-Za-z]:[\\/].*$")
_LOOP_DEVICE = re.compile(r"^/dev/loop[0-9]+$")
_UUID = re.compile(r"^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$")
_CONTAINER_ID = re.compile(r"^[0-9a-f]{12,64}$")


class FrontendCacheError(RuntimeError):
    """Raised when cache identity or mount admission cannot be proven."""


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def default_toolpins() -> dict[str, str]:
    """Return the stable cache-seed pins used by the managed launcher.

    The guest frontend records its effective Watchpack interval separately in
    its runtime receipt.  The v1 host cache keeps the legacy seed value.
    """

    return dict(DEFAULT_TOOLPINS)


def _cache_identity_toolpins(toolpins: Mapping[str, Any] | None = None) -> dict[str, str]:
    """Normalize tool pins without re-keying v1 for a Watchpack override."""

    pins = DEFAULT_TOOLPINS if toolpins is None else {
        str(key): str(value) for key, value in toolpins.items()
    }
    normalized = dict(pins)
    watchpack = normalized.get(CACHE_IDENTITY_WATCHPACK_POLLING_KEY)
    if watchpack is not None:
        if re.fullmatch(r"[0-9]+", watchpack) is None:
            raise FrontendCacheError(
                "watchpack_polling_ms must be an integer polling interval"
            )
        polling_ms = int(watchpack, 10)
        if not WATCHPACK_POLLING_MIN_MS <= polling_ms <= WATCHPACK_POLLING_MAX_MS:
            raise FrontendCacheError(
                "watchpack_polling_ms is outside the bounded runtime interval"
            )
        # Polling changes watcher behavior only; it does not change pnpm,
        # node_modules, or Next dependency artifacts.  Keep the v1 identity
        # at its legacy seed while frontend_dev records the effective value.
        normalized[CACHE_IDENTITY_WATCHPACK_POLLING_KEY] = (
            CACHE_IDENTITY_WATCHPACK_POLLING_MS
        )
    return normalized


def toolpins_digest(toolpins: Mapping[str, Any] | None = None) -> str:
    pins = _cache_identity_toolpins(toolpins)
    return _sha256(pins)


def dependency_seed_digest(entries: Mapping[str, str]) -> str:
    """Hash dependency manifests and package-manager patch files,
    excluding authored source and generated files."""

    normalized = {str(key).replace("\\", "/"): str(value) for key, value in entries.items()}
    return _sha256(normalized)


def _require_sha(value: str, label: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise FrontendCacheError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _require_identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or _IDENTIFIER.fullmatch(value) is None:
        raise FrontendCacheError(f"{label} is not a safe cache identifier")
    return value


def _source_root(value: str | os.PathLike[str]) -> str:
    path = Path(value)
    if not path.is_absolute():
        raise FrontendCacheError("source_root must be absolute")
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise FrontendCacheError(f"source_root is unavailable: {path}") from exc
    if not resolved.is_dir() or resolved.is_symlink():
        raise FrontendCacheError("source_root must be a real directory")
    return str(resolved)


def cache_key(
    source_root: str | os.PathLike[str],
    worktree_id: str,
    host_port: int,
    dependency_seed_sha256: str,
    toolpins: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the stable cache identity.

    Commit SHA and authored TypeScript/CSS/JSON files intentionally do not
    participate.  The returned ``inputs`` object is suitable for receipts.
    """

    source = _source_root(source_root)
    worktree = _require_identifier(worktree_id, "worktree_id")
    if isinstance(host_port, bool) or not isinstance(host_port, int) or not 1 <= host_port <= 65535:
        raise FrontendCacheError("host_port must be a valid TCP port")
    dependency = _require_sha(dependency_seed_sha256, "dependency_seed_sha256")
    pins = _cache_identity_toolpins(toolpins)
    if not pins:
        raise FrontendCacheError("toolpins must not be empty")
    pins_sha256 = toolpins_digest(pins)
    inputs = {
        "source_root": source,
        "worktree_id": worktree,
        "host_port": host_port,
        "dependency_seed_sha256": dependency,
        "toolpins_sha256": pins_sha256,
    }
    payload = {"schema": KEY_SCHEMA, **inputs}
    return {
        "schema": KEY_SCHEMA,
        "key": _sha256(payload),
        "inputs": inputs,
        "toolpins": pins,
    }


def _reject_path_components(value: str, label: str) -> None:
    if "\x00" in value or "\n" in value or "\r" in value:
        raise FrontendCacheError(f"{label} contains control characters")
    pieces = value.replace("\\", "/").split("/")
    if any(piece in {".", ".."} for piece in pieces):
        raise FrontendCacheError(f"{label} contains a traversal component")


def _daemon_path(value: str | os.PathLike[str], label: str) -> str:
    raw = str(value)
    _reject_path_components(raw, label)
    if _WINDOWS_ABSOLUTE.fullmatch(raw):
        drive = raw[0].lower()
        tail = raw[2:].replace("\\", "/").lstrip("/")
        if not tail:
            raise FrontendCacheError(f"{label} is not a file path")
        return f"{DAEMON_HOST_PREFIX}/{drive}/{tail}"
    if not raw.startswith("/"):
        raise FrontendCacheError(f"{label} must be absolute")
    return str(PurePosixPath(raw))


def _safe_project_id(layout: Mapping[str, Any]) -> str:
    project = layout.get("project_id") or layout.get("host_ledger_project_id")
    if project is None:
        project_root = layout.get("project_root")
        if project_root is None:
            raise FrontendCacheError("storage layout has no project identity")
        try:
            import fullmag_storage
            project = fullmag_storage.identifier(project_root)
        except (ImportError, AttributeError, TypeError, ValueError):
            project = hashlib.sha256(str(Path(project_root).resolve()).encode("utf-8")).hexdigest()[:16]
    return _require_identifier(str(project), "project_id")


def _storage_root(layout: Mapping[str, Any]) -> Path:
    value = layout.get("storage_root")
    if value is None:
        raise FrontendCacheError("storage layout has no storage_root")
    root = Path(value)
    if not root.is_absolute():
        raise FrontendCacheError("storage_root must be absolute")
    return root


def _cache_paths(layout: Mapping[str, Any], key: str) -> dict[str, Any]:
    project_id = _safe_project_id(layout)
    root = _storage_root(layout)
    build_volumes = root / "build-volumes"
    backing = build_volumes / f"fullmag-frontend-cache-v1-{key}.ext4"
    lock = Path(str(backing) + ".lock")
    mount_root = PurePosixPath("/mnt") / f"fullmag-frontend-cache-{project_id}-{key[:16]}"
    mount = str(mount_root)
    children = {
        name: str(mount_root / child)
        for name, child in (
            ("cache", "cache"),
            ("pnpm_store", "pnpm-store"),
            ("workspace_node_modules", "workspace-node_modules"),
            ("control_room_node_modules", "control-room-node_modules"),
        )
    }
    return {
        "project_id": project_id,
        "storage_root": root,
        "build_volumes": build_volumes,
        "backing_image": backing,
        "lock_path": lock,
        "mount_root": mount,
        "children": children,
        "mount_target": "/fullmag-frontend-cache",
    }


def _read_json_output(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str):
        raise FrontendCacheError("Docker command returned a non-text result")
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in pairs:
            if key in result:
                raise FrontendCacheError(f"Docker JSON contains duplicate key: {key}")
            result[key] = item
        return result

    candidates = [value.strip()]
    candidates.extend(line.strip() for line in reversed(value.splitlines()))
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            return json.loads(candidate, object_pairs_hook=reject_duplicates)
        except json.JSONDecodeError:
            continue
    raise FrontendCacheError("Docker command did not return JSON")


def _copy_immutable(source: Path, destination: Path) -> str:
    if source.is_symlink() or not source.is_file():
        raise FrontendCacheError(f"managed source is not a regular file: {source}")
    source_stat = source.stat()
    if source_stat.st_size > MAX_COPY_BYTES:
        raise FrontendCacheError(f"managed source is too large: {source}")
    data = source.read_bytes()
    source_digest = hashlib.sha256(data).hexdigest()
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() or not destination.is_file() or destination.read_bytes() != data:
            raise FrontendCacheError(f"managed destination already differs: {destination}")
        os.chmod(destination, 0o444)
        return source_digest
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(data)
        os.chmod(temporary, 0o444)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return source_digest


def _atomic_json(destination: Path, value: Mapping[str, Any]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(_canonical_bytes(value) + b"\n")
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()


def _image_attestation(docker: Callable[..., Any], image_id: str) -> dict[str, Any]:
    if not isinstance(image_id, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) is None:
        raise FrontendCacheError("frontend cache requires an immutable image ID")
    raw = docker("image", "inspect", image_id, timeout=60)
    inspected = _read_json_output(raw)
    if not isinstance(inspected, list) or len(inspected) != 1 or not isinstance(inspected[0], Mapping):
        raise FrontendCacheError("image inspect did not return one image")
    image = inspected[0]
    if image.get("Id") != image_id:
        raise FrontendCacheError("frontend cache image identity changed")
    config = image.get("Config")
    if not isinstance(config, Mapping) or config.get("Volumes") not in (None, {}):
        raise FrontendCacheError("frontend cache image must not declare anonymous volumes")
    if image.get("Os") != "linux" or not isinstance(image.get("Architecture"), str):
        raise FrontendCacheError("frontend cache requires a Linux image with an architecture")
    return {"id": image_id, "architecture": image["Architecture"], "os": image["Os"]}


def _compose_config(
    docker: Callable[..., Any],
    overlay: Path,
    project_name: str,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    raw = docker(
        "compose",
        "-f",
        str(overlay),
        "--project-name",
        project_name,
        "--profile",
        MAINTENANCE_PROFILE,
        "config",
        "--format",
        "json",
        timeout=60,
        environment=dict(environment),
    )
    document = _read_json_output(raw)
    if not isinstance(document, Mapping):
        raise FrontendCacheError("frontend cache Compose config is not an object")
    return dict(document)


def _assert_no_active_consumers(
    docker: Callable[..., Any],
    cache_key: str,
    children: Mapping[str, str],
) -> None:
    """Reject an exact-key live consumer before maintenance can touch its mount."""

    raw = docker(
        "ps",
        "--quiet",
        "--filter",
        f"label={CONSUMER_KEY_LABEL}={cache_key}",
        timeout=60,
    )
    if not isinstance(raw, str):
        raise FrontendCacheError("Docker consumer guard returned a non-text result")
    ids = [item.strip() for item in raw.splitlines() if item.strip()]
    for container_id in ids:
        if _CONTAINER_ID.fullmatch(container_id) is None:
            raise FrontendCacheError("Docker consumer guard returned an invalid container ID")
        document = _read_json_output(docker("inspect", container_id, timeout=60))
        if not isinstance(document, list) or len(document) != 1 or not isinstance(document[0], Mapping):
            raise FrontendCacheError("Docker consumer inspect returned no container")
        container = document[0]
        config = container.get("Config")
        labels = config.get("Labels") if isinstance(config, Mapping) else None
        if not isinstance(labels, Mapping):
            raise FrontendCacheError("active cache consumer has no attested labels")
        if (labels.get(CONSUMER_PROFILE_LABEL) != PROFILE
                or labels.get(CONSUMER_KEY_LABEL) != cache_key):
            raise FrontendCacheError("active cache consumer identity changed")
        mounts = container.get("Mounts")
        if not isinstance(mounts, list):
            raise FrontendCacheError("active cache consumer has no mount inventory")
        expected_sources = {
            CHILD_TARGETS[name]: str(children[name])
            for name in CHILD_TARGETS
        }
        observed: dict[str, str] = {}
        for mount in mounts:
            if not isinstance(mount, Mapping):
                continue
            target = str(mount.get("Destination", ""))
            if target in expected_sources and mount.get("Type") == "bind":
                observed[target] = str(mount.get("Source", ""))
        if observed != expected_sources:
            raise FrontendCacheError("active cache consumer mount identity changed")
        raise FrontendCacheError(
            f"frontend cache {cache_key} is already held by container {container_id}"
        )


def _v2_assert_no_active_consumer(
    docker: Callable[..., Any], *, cache_key: str, volume_name: str
) -> None:
    """Do not repair a state volume while its frontend still owns the mount."""

    raw = docker(
        "ps",
        "--quiet",
        "--no-trunc",
        "--filter",
        f"label={CONSUMER_KEY_LABEL}={cache_key}",
        timeout=60,
    )
    if not isinstance(raw, str):
        raise FrontendCacheError("frontend cache consumer guard returned non-text output")
    container_ids = [item.strip() for item in raw.splitlines() if item.strip()]
    for container_id in container_ids:
        if _CONTAINER_ID.fullmatch(container_id) is None:
            raise FrontendCacheError("frontend cache consumer guard returned an invalid container ID")
        inspected = _read_json_output(docker("inspect", container_id, timeout=60))
        if not isinstance(inspected, list) or len(inspected) != 1:
            raise FrontendCacheError("frontend cache consumer inspect returned no container")
        container = inspected[0]
        if not isinstance(container, Mapping):
            raise FrontendCacheError("frontend cache consumer inspect is malformed")
        config = container.get("Config")
        labels = config.get("Labels") if isinstance(config, Mapping) else None
        if (
            not isinstance(labels, Mapping)
            or labels.get(CONSUMER_PROFILE_LABEL) != PROFILE
            or labels.get(CONSUMER_KEY_LABEL) != cache_key
        ):
            raise FrontendCacheError("active frontend cache consumer identity changed")
        state = container.get("State")
        if not isinstance(state, Mapping) or state.get("Running") is not True:
            raise FrontendCacheError("frontend cache consumer inventory changed during inspection")
        mounts = container.get("Mounts")
        if not isinstance(mounts, list):
            raise FrontendCacheError("active frontend cache consumer has no mount inventory")
        state_mounts = [
            mount
            for mount in mounts
            if isinstance(mount, Mapping)
            and mount.get("Destination") == STATE_TARGET
            and mount.get("Type") == "volume"
        ]
        if len(state_mounts) != 1 or state_mounts[0].get("Name") != volume_name:
            raise FrontendCacheError("active frontend cache consumer volume identity changed")
        raise FrontendCacheError(
            f"frontend cache {cache_key} is already held by container {container_id}"
        )


def _mount_entries(service: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    mounts = service.get("volumes")
    if not isinstance(mounts, list):
        raise FrontendCacheError("frontend cache Compose service has no bind list")
    result: list[Mapping[str, Any]] = []
    for mount in mounts:
        if not isinstance(mount, Mapping) or mount.get("type") != "bind":
            raise FrontendCacheError("frontend cache requires bind mounts only")
        result.append(mount)
    return result


def _container_mount_entries(container: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    mounts = container.get("Mounts")
    if not isinstance(mounts, list):
        raise FrontendCacheError("frontend container has no mount list")
    result: list[Mapping[str, Any]] = []
    for mount in mounts:
        if not isinstance(mount, Mapping):
            raise FrontendCacheError("frontend container mount record is malformed")
        result.append(mount)
    return result


def _validate_overlay_config(document: Mapping[str, Any], environment: Mapping[str, str]) -> None:
    if document.get("volumes") not in (None, {}):
        raise FrontendCacheError("frontend cache overlay must not define named volumes")
    services = document.get("services")
    if not isinstance(services, Mapping):
        raise FrontendCacheError("frontend cache overlay has no services")
    frontend = services.get("frontend")
    maintenance = services.get(MAINTENANCE_SERVICE)
    if not isinstance(frontend, Mapping) or not isinstance(maintenance, Mapping):
        raise FrontendCacheError("frontend cache overlay is missing its services")
    labels = frontend.get("labels")
    if (not isinstance(labels, Mapping)
            or labels.get(CONSUMER_PROFILE_LABEL) != environment[ENV_PROFILE]
            or labels.get(CONSUMER_KEY_LABEL) != environment[ENV_KEY]):
        raise FrontendCacheError("frontend cache consumer labels are not exact")
    expected_targets = set(CHILD_TARGETS.values())
    mounts = _mount_entries(frontend)
    actual_targets = {str(mount.get("target")) for mount in mounts}
    if actual_targets != expected_targets:
        raise FrontendCacheError("frontend cache overlay does not expose the exact child targets")
    for mount in mounts:
        if mount.get("read_only") not in (False, None):
            raise FrontendCacheError("frontend cache child binds must be writable")
        target = str(mount.get("target"))
        expected_source = {
            CHILD_TARGETS["cache"]: environment[ENV_CACHE_SOURCE],
            CHILD_TARGETS["pnpm_store"]: environment[ENV_PNPM_SOURCE],
            CHILD_TARGETS["workspace_node_modules"]: environment[ENV_WORKSPACE_NODE_MODULES_SOURCE],
            CHILD_TARGETS["control_room_node_modules"]: environment[ENV_CONTROL_ROOM_NODE_MODULES_SOURCE],
        }[target]
        if str(mount.get("source")) != expected_source:
            raise FrontendCacheError(f"frontend cache source mismatch for {target}")
    if str(maintenance.get("image")) != environment[ENV_HELPER_IMAGE]:
        raise FrontendCacheError("frontend cache maintenance image mismatch")
    if maintenance.get("privileged") is not True or maintenance.get("network_mode") != "none":
        raise FrontendCacheError("frontend cache maintenance isolation changed")


def _render_maintenance_config(destination: Path, document: Mapping[str, Any]) -> None:
    services = document.get("services")
    if not isinstance(services, Mapping) or MAINTENANCE_SERVICE not in services:
        raise FrontendCacheError("cannot render frontend cache maintenance config")
    _atomic_json(
        destination,
        {
            "name": str(document.get("name", "fullmag-frontend-cache")),
            "services": {MAINTENANCE_SERVICE: services[MAINTENANCE_SERVICE]},
        },
    )


def _validate_host_receipt(receipt: Mapping[str, Any], values: Mapping[str, Any], image_id: str) -> None:
    required = {
        "schema",
        "profile",
        "state",
        "project_id",
        "cache_key",
        "backing_image",
        "mount_root",
        "mount_target",
        "filesystem",
        "filesystem_label",
        "filesystem_uuid",
        "loop_device",
        "mount_active",
        "size_bytes",
        "runtime_image_id",
    }
    if not required.issubset(receipt):
        raise FrontendCacheError("frontend cache maintenance receipt is incomplete")
    if receipt["schema"] != SCHEMA or receipt["profile"] != PROFILE or receipt["state"] != "ready":
        raise FrontendCacheError("frontend cache maintenance receipt schema/state mismatch")
    if receipt["project_id"] != values["project_id"] or receipt["cache_key"] != values["cache_key"]:
        raise FrontendCacheError("frontend cache project or key changed")
    if receipt["backing_image"] != _daemon_path(values["backing_image"], "backing_image"):
        raise FrontendCacheError("frontend cache backing image mismatch")
    if receipt["mount_root"] != values["mount_root"] or receipt["mount_target"] != values["mount_target"]:
        raise FrontendCacheError("frontend cache mount identity mismatch")
    if (receipt["filesystem"] != "ext4" or receipt["filesystem_label"] != IMAGE_LABEL
            or not isinstance(receipt["filesystem_uuid"], str)
            or _UUID.fullmatch(receipt["filesystem_uuid"]) is None):
        raise FrontendCacheError("frontend cache filesystem is not attested ext4")
    if not _LOOP_DEVICE.fullmatch(str(receipt["loop_device"])) or receipt["mount_active"] is not True:
        raise FrontendCacheError("frontend cache loop mount is not active")
    if (not isinstance(receipt["size_bytes"], int) or isinstance(receipt["size_bytes"], bool)
            or receipt["size_bytes"] != CACHE_SIZE_BYTES
            or receipt["runtime_image_id"] != image_id):
        raise FrontendCacheError("frontend cache size or image attestation mismatch")


def _require_cache_capacity(
    paths: Mapping[str, Any], *, windows: bool | None = None, phase: str = "before allocation"
) -> None:
    """Windows 9p may allocate the entire backing despite Linux truncate."""
    if windows is None:
        windows = os.name == "nt"
    if not windows:
        return
    existing = Path(paths["backing_image"]).exists()
    required = BACKEND_HEADROOM_BYTES if existing else CACHE_SIZE_BYTES + BACKEND_HEADROOM_BYTES
    free = shutil.disk_usage(paths["storage_root"]).free
    if free < required:
        kind = "existing cache headroom" if existing else "new cache allocation"
        raise FrontendCacheError(
            f"Frontend cache {kind} requires at least {required} free bytes on Windows "
            f"during {phase}; available: {free}. Existing caches and results were retained."
        )


# ---------------------------------------------------------------------------
# v2 named-volume implementation
# ---------------------------------------------------------------------------
#
# These definitions intentionally appear after the historical adapter so a
# checkout that already contains old helper code can be upgraded atomically:
# every exported operation used by the current launcher resolves to the v2
# implementation below.  The v2 route has no call site that creates a host
# backing image, loop mount, maintenance container, or host receipt.

STATE_TARGET = "/state/development"
CONTROL_TARGET = "/opt/fullmag/control"
ENV_VOLUME_NAME = "FULLMAG_FRONTEND_CACHE_VOLUME"
ENV_CONTROL_VOLUME = "FULLMAG_BUILD_CONTROL_VOLUME"
ENV_CONTROL_ROOT = "FULLMAG_FRONTEND_CONTROL_ROOT"
ENV_INPUTS_PATH = "FULLMAG_DEVELOPMENT_INPUTS_PATH"
VOLUME_SCHEMA_LABEL = "com.fullmag.frontend-cache.schema"
VOLUME_PROFILE_LABEL = "com.fullmag.frontend-cache.profile"
VOLUME_PROJECT_LABEL = "com.fullmag.frontend-cache.project"
VOLUME_KEY_LABEL = "com.fullmag.frontend-cache.key"
_V2_VOLUME_PREFIX = "fullmag-frontend-dev-v2"
_FRONTEND_CONTROL_NAMESPACE = "frontend"
FRONTEND_CONTROL_UID = 65532
FRONTEND_CONTROL_GID = 65532
FRONTEND_CONTROL_MODE = "0700"


def _v2_key(
    source_root: str | os.PathLike[str],
    worktree_id: str,
    host_port: int,
    dependency_seed_sha256: str,
    toolpins: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Return a dependency identity whose key is independent of host port."""

    source = _source_root(source_root)
    worktree = _require_identifier(worktree_id, "worktree_id")
    if (
        isinstance(host_port, bool)
        or not isinstance(host_port, int)
        or not 1 <= host_port <= 65535
    ):
        raise FrontendCacheError("host_port must be a valid TCP port")
    dependency = _require_sha(dependency_seed_sha256, "dependency_seed_sha256")
    pins = _cache_identity_toolpins(toolpins)
    if not pins:
        raise FrontendCacheError("toolpins must not be empty")
    pins_sha256 = toolpins_digest(pins)
    inputs = {
        "source_root": source,
        "worktree_id": worktree,
        # Keep the endpoint in receipts, but never in the volume identity.
        "host_port": host_port,
        "dependency_seed_sha256": dependency,
        "toolpins_sha256": pins_sha256,
    }
    payload = {
        "schema": "fullmag.frontend-cache-key.v2",
        "worktree_id": worktree,
        "dependency_seed_sha256": dependency,
        "toolpins_sha256": pins_sha256,
    }
    return {
        "schema": "fullmag.frontend-cache-key.v2",
        "key": _sha256(payload),
        "inputs": inputs,
        "toolpins": pins,
    }


def _v2_project_id(
    layout: Mapping[str, Any], compose_project: str | None = None
) -> str:
    project = (
        compose_project
        or layout.get("compose_project")
        or layout.get("project_id")
        or layout.get("host_ledger_project_id")
    )
    if project is None:
        project_root = layout.get("project_root")
        if project_root is None:
            raise FrontendCacheError("layout has no Compose project identity")
        project = hashlib.sha256(
            str(Path(project_root).resolve()).encode("utf-8")
        ).hexdigest()[:16]
    project = str(project).lower()
    return _require_identifier(project, "compose_project")


def _v2_volume_name(project_id: str, key: str) -> str:
    project = _require_identifier(project_id, "compose_project")
    key = _require_sha(key, "cache_key")
    candidate = f"{project}-{_V2_VOLUME_PREFIX}-{key[:32]}"
    if len(candidate) <= 200:
        return candidate
    digest = hashlib.sha256(project.encode("utf-8")).hexdigest()[:24]
    return f"fullmag-fe-v2-{digest}-{key[:32]}"


def _v2_control_paths(key: str) -> dict[str, str]:
    """Return the cache-key namespace in the shared control volume.

    The control volume is shared by the two application services, while the
    frontend state volume is keyed by dependency identity.  A fixed manifest
    path would therefore let a newer state volume consume metadata belonging
    to an older one.  Keep the namespace deterministic and guest-only; the
    Compose-group helper provisions this directory for UID 65532 before the
    unprivileged frontend starts.
    """

    key = _require_sha(key, "cache_key")
    # The frontend receives only the `frontend` subpath of the shared
    # control volume mounted at CONTROL_TARGET. Keep each dependency identity
    # in its own directory within that restricted namespace.
    root = f"{CONTROL_TARGET}/{key}"
    return {
        "control_root": root,
        "inputs_path": f"{root}/development-inputs.json",
    }


def _v2_cache_paths(
    layout: Mapping[str, Any], key: str, *, compose_project: str | None = None,
    control_volume_name: str | None = None,
) -> dict[str, Any]:
    project_id = _v2_project_id(layout, compose_project)
    if not isinstance(control_volume_name, str) or not control_volume_name:
        raise FrontendCacheError(
            "control_volume_name must be supplied by the Compose-group launcher"
        )
    control = control_volume_name
    _require_identifier(control, "control_volume_name")
    control_paths = _v2_control_paths(key)
    return {
        "project_id": project_id,
        "volume_name": _v2_volume_name(project_id, key),
        "control_volume_name": control,
        "mount_target": STATE_TARGET,
        **control_paths,
    }


def _v2_volume_inspect(
    docker: Callable[..., Any], name: str
) -> Mapping[str, Any] | None:
    try:
        raw = docker("volume", "inspect", name, timeout=60)
    except Exception:
        return None
    inspected = _read_json_output(raw)
    if isinstance(inspected, list) and len(inspected) == 1 and isinstance(inspected[0], Mapping):
        return inspected[0]
    if isinstance(inspected, Mapping):
        return inspected
    raise FrontendCacheError("Docker volume inspect returned no volume record")


def _v2_ensure_volume(
    docker: Callable[..., Any],
    *,
    name: str,
    project_id: str,
    key: str,
    profile: str = PROFILE,
) -> dict[str, Any]:
    labels = {
        VOLUME_SCHEMA_LABEL: SCHEMA,
        VOLUME_PROFILE_LABEL: profile,
        VOLUME_PROJECT_LABEL: project_id,
        VOLUME_KEY_LABEL: key,
    }
    record = _v2_volume_inspect(docker, name)
    if record is None:
        command: list[str] = ["volume", "create"]
        for label, value in labels.items():
            command.extend(["--label", f"{label}={value}"])
        command.append(name)
        docker(*command, timeout=60)
        record = _v2_volume_inspect(docker, name)
    if record is None:
        raise FrontendCacheError(f"Docker did not publish named volume {name}")
    try:
        validate_local_named_volume(record, name)
    except DockerNamedVolumeSafetyError as error:
        raise FrontendCacheError(
            f"frontend development volume has unsafe Docker backing: {error}"
        ) from error
    observed = record.get("Labels")
    if not isinstance(observed, Mapping):
        raise FrontendCacheError("frontend development volume has no labels")
    for label, expected in labels.items():
        if observed.get(label) != expected:
            raise FrontendCacheError(f"frontend development volume label mismatch: {label}")
    return {
        "name": name,
        "driver": str(record.get("Driver", "local")),
        "labels": dict(observed),
        "inspection": dict(record),
    }


def _v2_ensure_control_volume(
    docker: Callable[..., Any], *, name: str, project_id: str
) -> dict[str, Any]:
    """Ensure the shared control volume without claiming its ownership.

    Backend and frontend use this volume together.  An existing volume may
    therefore carry labels from the backend resolver; only its Docker name and
    local driver are authoritative here.  New volumes receive neutral labels
    that the other service can extend without a frontend-cache schema clash.
    """

    record = _v2_volume_inspect(docker, name)
    if record is None:
        docker(
            "volume",
            "create",
            "--label",
            "com.fullmag.build-control.project=" + project_id,
            "--label",
            "com.fullmag.build-control.schema=fullmag-build-control.v1",
            name,
            timeout=60,
        )
        record = _v2_volume_inspect(docker, name)
    if record is None:
        raise FrontendCacheError("Docker did not publish the shared build-control volume")
    try:
        validate_local_named_volume(record, name)
    except DockerNamedVolumeSafetyError as error:
        raise FrontendCacheError(
            f"shared build-control volume has unsafe Docker backing: {error}"
        ) from error
    labels = record.get("Labels")
    if labels is not None and not isinstance(labels, Mapping):
        raise FrontendCacheError("shared build-control volume labels are malformed")
    return {
        "name": name,
        "driver": str(record.get("Driver", "local")),
        "labels": dict(labels or {}),
        "inspection": dict(record),
    }


def reinspect_volumes(profile: Mapping[str, Any], docker: Callable[..., Any]) -> None:
    """Reject changed backing immediately before mounting prepared volumes."""

    if profile.get("schema") != SCHEMA or profile.get("state") != "ready":
        raise FrontendCacheError("frontend cache profile is not ready for volume reinspection")
    for descriptor_key, name_key in (("volume", "volume_name"),
                                     ("control_volume", "control_volume_name")):
        descriptor = profile.get(descriptor_key)
        expected = descriptor.get("inspection") if isinstance(descriptor, Mapping) else None
        name = profile.get(name_key)
        if not isinstance(expected, Mapping) or not isinstance(name, str):
            raise FrontendCacheError("frontend volume has no admitted inspection identity")
        observed = _v2_volume_inspect(docker, name)
        if observed is None:
            raise FrontendCacheError("frontend volume reinspection failed; no resources created")
        try:
            validate_local_named_volume(expected, name)
            validate_local_named_volume(observed, name)
        except DockerNamedVolumeSafetyError as error:
            raise FrontendCacheError(f"frontend volume has unsafe backing: {error}") from error
        if dict(observed) != dict(expected):
            raise FrontendCacheError("frontend volume identity changed since admission")


def _v2_validate_state_maintenance_config(
    document: Mapping[str, Any], environment: Mapping[str, str]
) -> None:
    """Validate the bounded root helper before it can mount the state volume."""

    services = document.get("services")
    if not isinstance(services, Mapping):
        raise FrontendCacheError("frontend state maintenance Compose config has no services")
    service = services.get(STATE_MAINTENANCE_SERVICE)
    if not isinstance(service, Mapping):
        raise FrontendCacheError("frontend state maintenance service is missing")
    if service.get("image") != environment[ENV_RUNTIME_IMAGE_ID]:
        raise FrontendCacheError("frontend state maintenance image identity changed")
    if (
        service.get("user") != "0:0"
        or service.get("read_only") is not True
        or service.get("privileged") is not False
        or service.get("cap_drop") != ["ALL"]
        or service.get("cap_add") != ["CHOWN"]
        or service.get("security_opt") != ["no-new-privileges:true"]
        or service.get("network_mode") != "none"
        or service.get("restart") != "no"
        or service.get("pull_policy") != "never"
        or "gpus" in service
    ):
        raise FrontendCacheError("frontend state maintenance isolation changed")
    if service.get("entrypoint") != [
        "/usr/local/bin/python3",
        "/opt/fullmag/backend_volume_cache_maintenance.py",
    ] or service.get("command") != ["ensure-frontend-state"]:
        raise FrontendCacheError("frontend state maintenance entrypoint changed")
    expected_environment = {
        ENV_STATE_SCHEMA: "fullmag.frontend-development-state-owner.v1",
        ENV_STATE_PROFILE: PROFILE,
        ENV_STATE_MAINTENANCE_PROFILE: "fullmag-frontend-state-maintenance-v1",
        ENV_STATE_MAINTENANCE_ACTION: "ensure",
        ENV_STATE_ROOT: STATE_TARGET,
        ENV_STATE_PROJECT_ID: environment[ENV_PROJECT_ID],
        ENV_STATE_CACHE_KEY: environment[ENV_KEY],
        ENV_STATE_VOLUME: environment[ENV_VOLUME_NAME],
        ENV_STATE_OWNER_UID: "65532",
        ENV_STATE_OWNER_GID: "65532",
    }
    observed_environment = service.get("environment")
    if not isinstance(observed_environment, Mapping):
        raise FrontendCacheError("frontend state maintenance environment is missing")
    for name, expected in expected_environment.items():
        if str(observed_environment.get(name)) != str(expected):
            raise FrontendCacheError(f"frontend state maintenance environment mismatch: {name}")
    mounts = service.get("volumes")
    if not isinstance(mounts, list) or len(mounts) != 1:
        raise FrontendCacheError("frontend state maintenance mount is not exact")
    mount = mounts[0]
    if (
        not isinstance(mount, Mapping)
        or mount.get("type") != "volume"
        or mount.get("source") != "frontend-development-state"
        or mount.get("target") != STATE_TARGET
        or not isinstance(mount.get("volume"), Mapping)
        or mount["volume"].get("nocopy") is not True
        or mount.get("read_only") is True
    ):
        raise FrontendCacheError("frontend state maintenance mount is not exact")
    volumes = document.get("volumes")
    state_volume = volumes.get("frontend-development-state") if isinstance(volumes, Mapping) else None
    if (
        not isinstance(state_volume, Mapping)
        or state_volume.get("name") != environment[ENV_VOLUME_NAME]
        or state_volume.get("external") is not True
    ):
        raise FrontendCacheError("frontend state maintenance volume declaration is unsafe")


def _v2_validate_state_maintenance_receipt(
    receipt: Mapping[str, Any], environment: Mapping[str, str]
) -> dict[str, Any]:
    expected_directories = [
        STATE_TARGET,
        f"{STATE_TARGET}/workspace",
        f"{STATE_TARGET}/workspace/apps",
        f"{STATE_TARGET}/workspace/apps/control-room",
        *[
            f"{STATE_TARGET}/workspace/apps/control-room/{name}"
            for name in ("app", "src", "public", "scripts")
        ],
    ]
    if (
        receipt.get("schema") != "fullmag.frontend-development-state-owner.v1"
        or receipt.get("profile") != PROFILE
        or receipt.get("maintenance_profile") != "fullmag-frontend-state-maintenance-v1"
        or receipt.get("state") != "ready"
        or receipt.get("project_id") != environment[ENV_PROJECT_ID]
        or receipt.get("cache_key") != environment[ENV_KEY]
        or receipt.get("volume_name") != environment[ENV_VOLUME_NAME]
        or receipt.get("root") != STATE_TARGET
        or receipt.get("owner_uid") != 65532
        or receipt.get("owner_gid") != 65532
        or receipt.get("directories") != expected_directories
    ):
        raise FrontendCacheError("frontend state maintenance receipt identity is invalid")
    probe = receipt.get("probe")
    if (
        not isinstance(probe, Mapping)
        or probe.get("state") != "passed"
        or probe.get("recursive_chown") is not False
        or probe.get("live_bind_contents") != "untouched"
        or probe.get("marker_validated") is not True
    ):
        raise FrontendCacheError("frontend state maintenance probe is incomplete")
    return dict(receipt)


def _v2_prepare_frontend_state(
    docker: Callable[..., Any],
    repo: Path,
    overlay: Path,
    project: str,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    """Run the short-lived V2 state handoff before the frontend is mounted."""

    rendered = _read_json_output(
        docker(
            "compose",
            "--project-name",
            project,
            "--project-directory",
            str(repo),
            "-f",
            str(overlay),
            "--profile",
            STATE_MAINTENANCE_PROFILE,
            "config",
            "--format",
            "json",
            timeout=60,
            environment=dict(environment),
        )
    )
    if not isinstance(rendered, Mapping):
        raise FrontendCacheError("frontend state maintenance Compose config is malformed")
    _v2_validate_state_maintenance_config(rendered, environment)
    output = docker(
        "compose",
        "--project-name",
        project,
        "--project-directory",
        str(repo),
        "-f",
        str(overlay),
        "--profile",
        STATE_MAINTENANCE_PROFILE,
        "run",
        "--rm",
        "--no-deps",
        "-T",
        STATE_MAINTENANCE_SERVICE,
        timeout=180,
        environment=dict(environment),
    )
    receipt = _read_json_output(output)
    if not isinstance(receipt, Mapping):
        raise FrontendCacheError("frontend state maintenance returned no receipt")
    return _v2_validate_state_maintenance_receipt(receipt, environment)


def _v2_cache_key(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return _v2_key(*args, **kwargs)


def _v2_prepare(
    layout: Mapping[str, Any],
    repo: str | os.PathLike[str],
    image_id: str,
    run_root: str | os.PathLike[str],
    docker: Callable[..., Any],
    *,
    source_root: str | os.PathLike[str],
    worktree_id: str,
    host_port: int,
    dependency_seed_sha256: str,
    toolpins: Mapping[str, Any] | None = None,
    compose_project: str | None = None,
    control_volume_name: str | None = None,
) -> dict[str, Any]:
    """Create/reuse group-scoped named volumes without host build storage."""

    del run_root
    identity = _v2_key(
        source_root,
        worktree_id,
        host_port,
        dependency_seed_sha256,
        toolpins,
    )
    paths = _v2_cache_paths(
        layout,
        identity["key"],
        compose_project=compose_project,
        control_volume_name=control_volume_name,
    )
    repo_path = Path(repo).resolve(strict=True)
    overlay = repo_path / "compose.frontend-cache.yaml"
    if overlay.is_symlink() or not overlay.is_file():
        raise FrontendCacheError(f"frontend cache Compose overlay is unavailable: {overlay}")
    image = _image_attestation(docker, image_id)
    state_volume = _v2_ensure_volume(
        docker,
        name=paths["volume_name"],
        project_id=paths["project_id"],
        key=identity["key"],
    )
    control_volume = _v2_ensure_control_volume(
        docker,
        name=paths["control_volume_name"],
        project_id=paths["project_id"],
    )
    overlay_sha256 = hashlib.sha256(overlay.read_bytes()).hexdigest()
    environment = {
        ENV_SCHEMA: SCHEMA,
        ENV_PROFILE: PROFILE,
        ENV_PROJECT_ID: paths["project_id"],
        ENV_KEY: identity["key"],
        ENV_VOLUME_NAME: paths["volume_name"],
        ENV_CONTROL_VOLUME: paths["control_volume_name"],
        ENV_CONTROL_ROOT: paths["control_root"],
        ENV_INPUTS_PATH: paths["inputs_path"],
        ENV_MOUNT_TARGET: STATE_TARGET,
        ENV_RUNTIME_IMAGE_ID: image_id,
        ENV_SOURCE_ROOT: identity["inputs"]["source_root"],
        ENV_WORKTREE_ID: identity["inputs"]["worktree_id"],
        ENV_HOST_PORT: str(identity["inputs"]["host_port"]),
        ENV_DEPENDENCY_SEED: identity["inputs"]["dependency_seed_sha256"],
        ENV_TOOLPINS: identity["inputs"]["toolpins_sha256"],
        ENV_STATE_SCHEMA: "fullmag.frontend-development-state-owner.v1",
        ENV_STATE_PROFILE: PROFILE,
        ENV_STATE_MAINTENANCE_PROFILE: "fullmag-frontend-state-maintenance-v1",
        ENV_STATE_MAINTENANCE_ACTION: "ensure",
        ENV_STATE_ROOT: STATE_TARGET,
        ENV_STATE_PROJECT_ID: paths["project_id"],
        ENV_STATE_CACHE_KEY: identity["key"],
        ENV_STATE_VOLUME: paths["volume_name"],
        ENV_STATE_OWNER_UID: "65532",
        ENV_STATE_OWNER_GID: "65532",
    }
    _v2_assert_no_active_consumer(
        docker,
        cache_key=identity["key"],
        volume_name=paths["volume_name"],
    )
    maintenance_receipt = _v2_prepare_frontend_state(
        docker,
        repo_path,
        overlay,
        paths["project_id"],
        environment,
    )
    receipt = {
        "schema": SCHEMA,
        "profile": PROFILE,
        "state": "ready",
        "project_id": paths["project_id"],
        "compose_project": paths["project_id"],
        "cache_key": identity["key"],
        "volume_name": paths["volume_name"],
        "control_volume_name": paths["control_volume_name"],
        "mount_target": STATE_TARGET,
        "control_target": CONTROL_TARGET,
        "control_root": paths["control_root"],
        "inputs_path": paths["inputs_path"],
        "control_owner": {
            "uid": FRONTEND_CONTROL_UID,
            "gid": FRONTEND_CONTROL_GID,
            "mode": FRONTEND_CONTROL_MODE,
        },
        "runtime_image_id": image_id,
        "volume": state_volume,
        "control_volume": control_volume,
        "state_maintenance_receipt": maintenance_receipt,
        "identity": identity,
        "environment": environment,
        "compose_overlay": str(overlay),
        "compose_overlay_sha256": overlay_sha256,
        "qualification": "frontend-named-volume-admission-only",
    }
    return {
        **receipt,
        "image": image,
        "image_id": image_id,
        "children": {
            "state": paths["volume_name"],
            "control": paths["control_volume_name"],
        },
        "guest_targets": {"state": STATE_TARGET, "control": CONTROL_TARGET},
        "maintenance_compose": None,
        "receipt_storage": "docker-named-volume",
        # A guest path inside the named state volume.  It must not be passed to
        # host-side receipt validators as a host filesystem path.
        "receipt_path": f"{STATE_TARGET}/frontend-cache-receipt.json",
    }


def _v2_container_env(document: Mapping[str, Any]) -> dict[str, str]:
    config = document.get("Config")
    if not isinstance(config, Mapping):
        raise FrontendCacheError("frontend container has no config")
    values = config.get("Env", [])
    if not isinstance(values, list):
        raise FrontendCacheError("frontend container environment is malformed")
    result: dict[str, str] = {}
    for value in values:
        if isinstance(value, str) and "=" in value:
            name, item = value.split("=", 1)
            result[name] = item
    return result


def _v2_validate_container(
    document: Mapping[str, Any], profile: Mapping[str, Any]
) -> dict[str, Any]:
    if profile.get("schema") != SCHEMA or profile.get("state") != "ready":
        raise FrontendCacheError("frontend cache profile is not ready")
    if profile.get("image_id") is not None and document.get("Image") != profile["image_id"]:
        raise FrontendCacheError("frontend container image identity changed")
    expected = profile.get("environment")
    if not isinstance(expected, Mapping):
        raise FrontendCacheError("frontend cache profile has no environment")
    control_paths = _v2_control_paths(str(profile.get("cache_key", "")))
    if expected.get(ENV_CONTROL_ROOT) != control_paths["control_root"]:
        raise FrontendCacheError("frontend control namespace is not cache-key scoped")
    if expected.get(ENV_INPUTS_PATH) != control_paths["inputs_path"]:
        raise FrontendCacheError("frontend input manifest is not cache-key scoped")
    env = _v2_container_env(document)
    for name in (
        ENV_SCHEMA,
        ENV_PROFILE,
        ENV_PROJECT_ID,
        ENV_KEY,
        ENV_VOLUME_NAME,
        ENV_CONTROL_VOLUME,
        ENV_CONTROL_ROOT,
        ENV_INPUTS_PATH,
        ENV_MOUNT_TARGET,
        ENV_RUNTIME_IMAGE_ID,
    ):
        if env.get(name) != str(expected[name]):
            raise FrontendCacheError(f"frontend container cache environment mismatch: {name}")
    config = document.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    if (
        not isinstance(labels, Mapping)
        or labels.get(CONSUMER_PROFILE_LABEL) != str(expected[ENV_PROFILE])
        or labels.get(CONSUMER_KEY_LABEL) != str(expected[ENV_KEY])
    ):
        raise FrontendCacheError("frontend container cache labels mismatch")
    mounts = document.get("Mounts")
    if not isinstance(mounts, list):
        raise FrontendCacheError("frontend container has no mount list")
    state_mounts = []
    control_mounts = []
    for mount in mounts:
        if not isinstance(mount, Mapping):
            continue
        target = str(mount.get("Destination", mount.get("destination", "")))
        if target == STATE_TARGET:
            state_mounts.append(mount)
        if target == CONTROL_TARGET:
            control_mounts.append(mount)
        if target in set(CHILD_TARGETS.values()):
            raise FrontendCacheError(f"legacy frontend cache child mount is forbidden: {target}")
    if len(state_mounts) != 1:
        raise FrontendCacheError("frontend container must have exactly one state volume")
    mount = state_mounts[0]
    if mount.get("Type", mount.get("type")) != "volume":
        raise FrontendCacheError("frontend state must be a Docker named volume")
    source = mount.get("Name", mount.get("Source", mount.get("source")))
    if str(source) != str(expected[ENV_VOLUME_NAME]):
        raise FrontendCacheError("frontend state volume identity changed")
    if mount.get("RW") is False or mount.get("read_only") is True:
        raise FrontendCacheError("frontend state volume is read-only")
    if len(control_mounts) != 1:
        raise FrontendCacheError("frontend container must have exactly one control volume")
    control_mount = control_mounts[0]
    if control_mount.get("Type", control_mount.get("type")) != "volume":
        raise FrontendCacheError("frontend control state must be a Docker named volume")
    control_source = control_mount.get(
        "Name", control_mount.get("Source", control_mount.get("source"))
    )
    if str(control_source) != str(expected[ENV_CONTROL_VOLUME]):
        raise FrontendCacheError("frontend control volume identity changed")
    if control_mount.get("RW") is False or control_mount.get("read_only") is True:
        raise FrontendCacheError("frontend control volume is read-only")
    return {
        "schema": SCHEMA,
        "state": "attested",
        "cache_key": profile["cache_key"],
        "volume_name": str(source),
        "control_volume_name": str(control_source),
        "control_root": str(expected[ENV_CONTROL_ROOT]),
        "inputs_path": str(expected[ENV_INPUTS_PATH]),
        "target": STATE_TARGET,
    }


# Export v2 operations.  Assigning aliases here preserves the existing import
# surface while making the active path auditable in one contiguous section.
cache_key = _v2_cache_key
_cache_paths = _v2_cache_paths
prepare = _v2_prepare
validate_container = _v2_validate_container


def prepare(
    layout: Mapping[str, Any],
    repo: str | os.PathLike[str],
    image_id: str,
    run_root: str | os.PathLike[str],
    docker: Callable[..., Any],
    *,
    source_root: str | os.PathLike[str],
    worktree_id: str,
    host_port: int,
    dependency_seed_sha256: str,
    toolpins: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Ensure one stable ext4 cache and return its Compose/runtime profile."""

    identity = cache_key(
        source_root,
        worktree_id,
        host_port,
        dependency_seed_sha256,
        toolpins,
    )
    paths = _cache_paths(layout, identity["key"])
    _require_cache_capacity(paths, phase="before allocation")
    repo_path = Path(repo).resolve(strict=True)
    run_path = Path(run_root)
    if not run_path.is_absolute() or run_path.is_symlink():
        raise FrontendCacheError("frontend cache run root must be an absolute real path")
    run_path.mkdir(parents=True, exist_ok=True)
    helper_source = repo_path / "scripts" / "lib" / "docker_frontend_cache.sh"
    overlay_source = repo_path / "compose.frontend-cache.yaml"
    helper_copy = run_path / "docker_frontend_cache.sh"
    overlay_copy = run_path / "compose.frontend-cache.yaml"
    helper_sha256 = _copy_immutable(helper_source, helper_copy)
    overlay_sha256 = _copy_immutable(overlay_source, overlay_copy)
    image = _image_attestation(docker, image_id)
    values = {
        **paths,
        "cache_key": identity["key"],
        "image_id": image_id,
    }
    project_name = f"fullmag-frontend-cache-{paths['project_id']}-{identity['key'][:16]}"
    environment: dict[str, str] = {
        ENV_SCHEMA: SCHEMA,
        ENV_PROFILE: PROFILE,
        ENV_PROJECT_ID: paths["project_id"],
        ENV_KEY: identity["key"],
        ENV_STORAGE_ROOT: _daemon_path(paths["storage_root"], "storage_root"),
        ENV_BACKING_IMAGE: _daemon_path(paths["backing_image"], "backing_image"),
        ENV_LOCK_PATH: _daemon_path(paths["lock_path"], "lock_path"),
        ENV_MOUNT_ROOT: paths["mount_root"],
        ENV_OWNER_MARKER: f"{paths['mount_root']}/.fullmag-frontend-cache-owner.json",
        ENV_SIZE_BYTES: str(CACHE_SIZE_BYTES),
        ENV_MOUNT_TARGET: paths["mount_target"],
        ENV_FILESYSTEM_UUID: "",
        ENV_RUNTIME_IMAGE_ID: image_id,
        ENV_HELPER_IMAGE: image_id,
        ENV_HELPER_PATH: _daemon_path(helper_copy, "helper_copy"),
        ENV_HOST_PID: "1",
        ENV_UID: "65532",
        ENV_GID: "65532",
        ENV_SOURCE_ROOT: identity["inputs"]["source_root"],
        ENV_WORKTREE_ID: identity["inputs"]["worktree_id"],
        ENV_HOST_PORT: str(identity["inputs"]["host_port"]),
        ENV_DEPENDENCY_SEED: identity["inputs"]["dependency_seed_sha256"],
        ENV_TOOLPINS: identity["inputs"]["toolpins_sha256"],
    }
    for name, source in paths["children"].items():
        environment[
            {
                "cache": ENV_CACHE_SOURCE,
                "pnpm_store": ENV_PNPM_SOURCE,
                "workspace_node_modules": ENV_WORKSPACE_NODE_MODULES_SOURCE,
                "control_room_node_modules": ENV_CONTROL_ROOM_NODE_MODULES_SOURCE,
            }[name]
        ] = source

    _assert_no_active_consumers(docker, identity["key"], paths["children"])
    configured = _compose_config(docker, overlay_copy, project_name, environment)
    _validate_overlay_config(configured, environment)
    maintenance_config = run_path / "compose.frontend-cache-maintenance.json"
    _render_maintenance_config(maintenance_config, configured)
    maintenance_name = f"fullmag-frontend-cache-maintenance-{identity['key'][:16]}"
    output = docker(
        "compose",
        "--project-name",
        project_name,
        "-f",
        str(maintenance_config),
        "--profile",
        MAINTENANCE_PROFILE,
        "run",
        "--rm",
        "--no-deps",
        "--name",
        maintenance_name,
        "--label",
        f"com.fullmag.frontend-cache.profile={PROFILE}",
        MAINTENANCE_SERVICE,
        "ensure",
        timeout=180,
        environment=environment,
    )
    receipt = _read_json_output(output)
    if not isinstance(receipt, Mapping):
        raise FrontendCacheError("frontend cache maintenance returned no receipt")
    _validate_host_receipt(receipt, values, image_id)
    _require_cache_capacity(paths, phase="after allocation")
    environment[ENV_FILESYSTEM_UUID] = str(receipt["filesystem_uuid"])
    receipt_path = run_path / "frontend-cache-receipt.json"
    _atomic_json(
        receipt_path,
        {
            "schema": SCHEMA,
            "profile": PROFILE,
            "state": "ready",
            "cache_key": identity["key"],
            "identity": identity,
            "project_id": paths["project_id"],
            "image": image,
            "host_receipt": dict(receipt),
            "helper_sha256": helper_sha256,
            "compose_overlay_sha256": overlay_sha256,
            "environment": environment,
        },
    )
    return {
        "schema": SCHEMA,
        "profile": PROFILE,
        "state": "ready",
        "cache_key": identity["key"],
        "identity": identity,
        "project_id": paths["project_id"],
        "image_id": image_id,
        "filesystem_uuid": environment[ENV_FILESYSTEM_UUID],
        "mount_root": paths["mount_root"],
        "children": dict(paths["children"]),
        "guest_targets": dict(CHILD_TARGETS),
        "environment": environment,
        "compose_overlay": str(overlay_copy),
        "maintenance_compose": str(maintenance_config),
        "helper_sha256": helper_sha256,
        "compose_overlay_sha256": overlay_sha256,
        "receipt": dict(receipt),
        "receipt_path": str(receipt_path),
    }


def _container_env(document: Mapping[str, Any]) -> dict[str, str]:
    config = document.get("Config")
    if not isinstance(config, Mapping):
        raise FrontendCacheError("frontend container has no config")
    values = config.get("Env", [])
    if not isinstance(values, list):
        raise FrontendCacheError("frontend container environment is malformed")
    result: dict[str, str] = {}
    for value in values:
        if not isinstance(value, str) or "=" not in value:
            continue
        name, item = value.split("=", 1)
        result[name] = item
    return result


def validate_container(document: Mapping[str, Any], profile: Mapping[str, Any]) -> dict[str, Any]:
    """Fail closed unless the running frontend has exactly the cache binds."""

    if profile.get("schema") != SCHEMA or profile.get("state") != "ready":
        raise FrontendCacheError("frontend cache profile is not ready")
    if profile.get("image_id") is not None and document.get("Image") != profile["image_id"]:
        raise FrontendCacheError("frontend container image identity changed")
    expected = profile.get("environment")
    if not isinstance(expected, Mapping):
        raise FrontendCacheError("frontend cache profile has no environment")
    env = _container_env(document)
    for name in (ENV_SCHEMA, ENV_PROFILE, ENV_PROJECT_ID, ENV_KEY, ENV_FILESYSTEM_UUID, ENV_RUNTIME_IMAGE_ID):
        if env.get(name) != str(expected[name]):
            raise FrontendCacheError(f"frontend container cache environment mismatch: {name}")
    config = document.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    if (not isinstance(labels, Mapping)
            or labels.get(CONSUMER_PROFILE_LABEL) != str(expected[ENV_PROFILE])
            or labels.get(CONSUMER_KEY_LABEL) != str(expected[ENV_KEY])):
        raise FrontendCacheError("frontend container cache labels mismatch")
    mounts = _container_mount_entries(document)
    expected_sources = {
        str(profile["guest_targets"][name]): str(profile["children"][name])
        for name in CHILD_TARGETS
    }
    seen: set[str] = set()
    for mount in mounts:
        if mount.get("Type", mount.get("type")) == "volume":
            raise FrontendCacheError("frontend cache forbids named volumes")
        target = str(mount.get("Destination", mount.get("destination", mount.get("target", ""))))
        if target not in expected_sources:
            continue
        if mount.get("Type", mount.get("type")) != "bind":
            raise FrontendCacheError(f"frontend cache target is not a bind: {target}")
        source = mount.get("Source", mount.get("source"))
        if target in seen or str(source) != expected_sources[target]:
            raise FrontendCacheError(f"frontend container cache bind mismatch: {target}")
        if mount.get("RW") is False or mount.get("read_only") is True:
            raise FrontendCacheError(f"frontend container cache bind is read-only: {target}")
        seen.add(target)
    if seen != set(expected_sources):
        raise FrontendCacheError("frontend container is missing a frontend cache bind")
    return {
        "schema": SCHEMA,
        "state": "attested",
        "cache_key": profile["cache_key"],
        "filesystem_uuid": profile["filesystem_uuid"],
        "targets": sorted(seen),
    }


# Keep these aliases at the end of the module: the historical v1 definitions
# above are retained for receipt readers, but must never shadow the active v2
# named-volume implementation.
cache_key = _v2_cache_key
_cache_paths = _v2_cache_paths
prepare = _v2_prepare
validate_container = _v2_validate_container
