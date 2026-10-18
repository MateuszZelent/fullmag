"""Prepare and attest the persistent native backend build cache.

The cache is an ext4 loop-mounted image owned by the canonical project
storage.  Its logical size is fixed, but Windows/9p may fully allocate the
backing file instead of preserving sparse holes.  It is deliberately
independent from the frontend cache and the host ledger.  Source files remain
read-only in the application container; only the unprivileged backend build
directory is writable.
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


SCHEMA = "fullmag.backend-build-cache.v1"
OWNER_SCHEMA = "fullmag.backend-build-cache-owner.v1"
KEY_SCHEMA = "fullmag.backend-build-cache-key.v1"
PROFILE = "backend-build-cache-v1"
MAINTENANCE_PROFILE = "backend-build-cache-maintenance-v1"
MAINTENANCE_SERVICE = "backend-cache-maintenance"
CONSUMER_PROFILE_LABEL = "com.fullmag.backend-cache.profile"
CONSUMER_KEY_LABEL = "com.fullmag.backend-cache.key"
IMAGE_LABEL = "fm-be-cache-v1"
LEGACY_CACHE_SIZE_BYTES = 12 * 1024 * 1024 * 1024
CACHE_SIZE_BYTES = 24 * 1024 * 1024 * 1024
EXTENDED_CACHE_SIZE_BYTES = 40 * 1024 * 1024 * 1024
MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024 * 1024
SUPPORTED_CACHE_SIZE_BYTES = frozenset({
    LEGACY_CACHE_SIZE_BYTES,
    CACHE_SIZE_BYTES,
    EXTENDED_CACHE_SIZE_BYTES,
    MAX_CACHE_SIZE_BYTES,
})
NEW_BACKING_FREE_SPACE_MARGIN_BYTES = 2 * 1024 * 1024 * 1024
GROWTH_FREE_SPACE_MARGIN_BYTES = 2 * 1024 * 1024 * 1024
GROWTH_SCHEMA = "fullmag.backend-build-cache-growth.v1"
GROWTH_V1_SUFFIX = ".growth-v1.json"
GROWTH_V2_SUFFIX = ".growth-v2.json"
GROWTH_V3_SUFFIX = ".growth-v3.json"
MOUNT_TARGET = "/fullmag-backend-cache"
GUEST_TARGET = "/build"
DAEMON_HOST_PREFIX = "/run/desktop/mnt/host"

ENV_SCHEMA = "FULLMAG_BACKEND_CACHE_SCHEMA"
ENV_PROFILE = "FULLMAG_BACKEND_CACHE_PROFILE"
ENV_PROJECT_ID = "FULLMAG_BACKEND_CACHE_PROJECT_ID"
ENV_KEY = "FULLMAG_BACKEND_CACHE_KEY"
ENV_STORAGE_ROOT = "FULLMAG_BACKEND_CACHE_STORAGE_ROOT"
ENV_BACKING_IMAGE = "FULLMAG_BACKEND_CACHE_BACKING_IMAGE"
ENV_LOCK_PATH = "FULLMAG_BACKEND_CACHE_LOCK_PATH"
ENV_MOUNT_ROOT = "FULLMAG_BACKEND_CACHE_MOUNT_ROOT"
ENV_OWNER_MARKER = "FULLMAG_BACKEND_CACHE_OWNER_MARKER"
ENV_SIZE_BYTES = "FULLMAG_BACKEND_CACHE_SIZE_BYTES"
ENV_MOUNT_TARGET = "FULLMAG_BACKEND_CACHE_MOUNT_TARGET"
ENV_FILESYSTEM_UUID = "FULLMAG_BACKEND_CACHE_FILESYSTEM_UUID"
ENV_RUNTIME_IMAGE_ID = "FULLMAG_BACKEND_CACHE_RUNTIME_IMAGE_ID"
ENV_HELPER_IMAGE = "FULLMAG_BACKEND_CACHE_HELPER_IMAGE"
ENV_HELPER_PATH = "FULLMAG_BACKEND_CACHE_HELPER_PATH"
ENV_HOST_PID = "FULLMAG_BACKEND_CACHE_HOST_PID"
ENV_UID = "FULLMAG_BACKEND_CACHE_UID"
ENV_GID = "FULLMAG_BACKEND_CACHE_GID"
ENV_SOURCE_ROOT = "FULLMAG_BACKEND_CACHE_SOURCE_ROOT"
ENV_WORKTREE_ID = "FULLMAG_BACKEND_CACHE_WORKTREE_ID"
ENV_TOOLCHAIN_IMAGE = "FULLMAG_BACKEND_CACHE_TOOLCHAIN_IMAGE_ID"
ENV_LOCK_WAIT = "FULLMAG_BACKEND_CACHE_LOCK_WAIT_SECONDS"
ENV_BACKEND_PACKAGE = "FULLMAG_BACKEND_PACKAGE"

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
_IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_WINDOWS_ABSOLUTE = re.compile(r"^[A-Za-z]:[\\/].*$")
_UUID = re.compile(r"^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$")
_LOOP_DEVICE = re.compile(r"^/dev/loop[0-9]+$")
_CONTAINER_ID = re.compile(r"^[0-9a-f]{12,64}$")


class BackendCacheError(RuntimeError):
    """Raised when backend cache identity or admission cannot be proven."""


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _read_json_output(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str):
        raise BackendCacheError("Docker command returned a non-text result")

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in pairs:
            if key in result:
                raise BackendCacheError(f"Docker JSON contains duplicate key: {key}")
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
    raise BackendCacheError("Docker command did not return JSON")


def _require_image_id(value: str, label: str) -> str:
    if not isinstance(value, str) or _IMAGE_ID.fullmatch(value) is None:
        raise BackendCacheError(f"{label} must be a full immutable image ID")
    return value


def _source_root(value: str | os.PathLike[str]) -> str:
    path = Path(value)
    if not path.is_absolute():
        raise BackendCacheError("source_root must be absolute")
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise BackendCacheError(f"source_root is unavailable: {path}") from exc
    if not resolved.is_dir() or resolved.is_symlink():
        raise BackendCacheError("source_root must be a real directory")
    return str(resolved)


def _require_identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or _IDENTIFIER.fullmatch(value) is None:
        raise BackendCacheError(f"{label} is not a safe cache identifier")
    return value


def cache_key(
    source_root: str | os.PathLike[str],
    worktree_id: str,
    toolchain_image: str,
) -> dict[str, Any]:
    """Return a stable key for checkout/worktree/toolchain identity.

    Authored source files and commit SHA are intentionally absent.  Editing a
    source file therefore reuses the incremental Cargo/CMake cache, while a
    different checkout identity or toolchain image receives a separate cache.
    """

    source = _source_root(source_root)
    worktree = _require_identifier(worktree_id, "worktree_id")
    toolchain = _require_image_id(toolchain_image, "toolchain_image")
    inputs = {
        "source_root": source,
        "worktree_id": worktree,
        "toolchain_image_id": toolchain,
    }
    payload = {"schema": KEY_SCHEMA, **inputs}
    return {"schema": KEY_SCHEMA, "key": _sha256(payload), "inputs": inputs}


def _reject_path_components(value: str, label: str) -> None:
    if "\x00" in value or "\n" in value or "\r" in value:
        raise BackendCacheError(f"{label} contains control characters")
    pieces = value.replace("\\", "/").split("/")
    if any(piece in {".", ".."} for piece in pieces):
        raise BackendCacheError(f"{label} contains a traversal component")


def _daemon_path(value: str | os.PathLike[str], label: str) -> str:
    raw = str(value)
    _reject_path_components(raw, label)
    if _WINDOWS_ABSOLUTE.fullmatch(raw):
        drive = raw[0].lower()
        tail = raw[2:].replace("\\", "/").lstrip("/")
        if not tail:
            raise BackendCacheError(f"{label} is not a file path")
        return f"{DAEMON_HOST_PREFIX}/{drive}/{tail}"
    if not raw.startswith("/"):
        raise BackendCacheError(f"{label} must be absolute")
    return str(PurePosixPath(raw))


def _safe_project_id(layout: Mapping[str, Any]) -> str:
    project = layout.get("project_id") or layout.get("host_ledger_project_id")
    if project is None:
        project_root = layout.get("project_root")
        if project_root is None:
            raise BackendCacheError("storage layout has no project identity")
        try:
            import fullmag_storage
            project = fullmag_storage.identifier(project_root)
        except (ImportError, AttributeError, TypeError, ValueError):
            project = hashlib.sha256(str(Path(project_root).resolve()).encode("utf-8")).hexdigest()[:16]
    return _require_identifier(str(project), "project_id")


def _storage_root(layout: Mapping[str, Any]) -> Path:
    value = layout.get("storage_root")
    if value is None:
        raise BackendCacheError("storage layout has no storage_root")
    root = Path(value)
    if not root.is_absolute() or root == Path(root.anchor):
        raise BackendCacheError("storage_root must be an absolute non-root path")
    return root


def _cache_paths(layout: Mapping[str, Any], key: str) -> dict[str, Any]:
    if _SHA256.fullmatch(key) is None:
        raise BackendCacheError("cache key is not SHA-256")
    project_id = _safe_project_id(layout)
    root = _storage_root(layout)
    build_volumes = root / "build-volumes"
    backing = build_volumes / f"fullmag-backend-build-cache-v1-{key}.ext4"
    lock = Path(str(backing) + ".lock")
    mount_root = PurePosixPath("/mnt") / f"fullmag-backend-cache-{project_id}-{key[:16]}"
    mount = str(mount_root)
    return {
        "project_id": project_id,
        "storage_root": root,
        "build_volumes": build_volumes,
        "backing_image": backing,
        "lock_path": lock,
        "mount_root": mount,
        # This is a Docker-daemon path inside the managed ext4 mount.  Keep it
        # as a PurePosixPath-derived string: resolving it through Windows would
        # silently turn the bind source into a host path on the wrong volume.
        "package_root": str(mount_root / "package"),
        "mount_target": MOUNT_TARGET,
        "owner_marker": f"{mount}/.fullmag-backend-cache-owner.json",
    }


def _require_cache_size(value: Any, label: str = "cache size") -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value not in SUPPORTED_CACHE_SIZE_BYTES:
        raise BackendCacheError(f"{label} must be exactly 12 GiB, 24 GiB, 40 GiB, or 50 GiB")
    return value


def _existing_backing_size(backing: Path) -> int:
    if backing.is_symlink():
        raise BackendCacheError(f"backend cache backing image is a symlink: {backing}")
    if not backing.exists():
        return CACHE_SIZE_BYTES
    if not backing.is_file():
        raise BackendCacheError(f"backend cache backing image is not a regular file: {backing}")
    try:
        size = backing.stat().st_size
    except OSError as exc:
        raise BackendCacheError(f"cannot inspect backend cache backing image: {backing}") from exc
    return _require_cache_size(size, "existing backend cache backing size")


def _guard_new_backing_space(
    backing: Path,
    storage_root: Path,
    size_bytes: int = CACHE_SIZE_BYTES,
) -> None:
    """Reject a new backing when native allocation would exhaust storage.

    Existing backings are already accounted for by the cache identity and are
    admitted by the maintenance helper.  Requiring their full logical size
    again would incorrectly reject reuse after a restart.
    """

    if backing.exists() or backing.is_symlink():
        return
    size_bytes = _require_cache_size(size_bytes)
    required = size_bytes + NEW_BACKING_FREE_SPACE_MARGIN_BYTES
    try:
        free = shutil.disk_usage(storage_root).free
    except OSError as exc:
        raise BackendCacheError(
            f"cannot inspect free space for new backend cache backing: {storage_root}"
        ) from exc
    if free < required:
        raise BackendCacheError(
            "insufficient free space for new backend cache backing: "
            f"{free} bytes free, {required} required"
        )


def _guard_growth_space(
    backing: Path,
    storage_root: Path,
    previous_size: int = LEGACY_CACHE_SIZE_BYTES,
    target_size: int = CACHE_SIZE_BYTES,
) -> None:
    """Require room for one explicit adjacent cache-capacity transition."""

    if backing.is_symlink() or not backing.exists():
        raise BackendCacheError("cannot grow a missing or symlinked backend cache backing")
    previous_size = _require_cache_size(previous_size, "growth source size")
    target_size = _require_cache_size(target_size, "growth target size")
    if (previous_size, target_size) not in {
        (LEGACY_CACHE_SIZE_BYTES, CACHE_SIZE_BYTES),
        (CACHE_SIZE_BYTES, EXTENDED_CACHE_SIZE_BYTES),
        (EXTENDED_CACHE_SIZE_BYTES, MAX_CACHE_SIZE_BYTES),
    }:
        raise BackendCacheError("backend cache growth requires an adjacent supported capacity")
    current = _existing_backing_size(backing)
    if current != previous_size:
        raise BackendCacheError(
            f"backend cache growth requires an exact {previous_size // (1024 ** 3)} GiB backing"
        )
    required = target_size - previous_size + GROWTH_FREE_SPACE_MARGIN_BYTES
    try:
        free = shutil.disk_usage(storage_root).free
    except OSError as exc:
        raise BackendCacheError(
            f"cannot inspect free space for backend cache growth: {storage_root}"
        ) from exc
    if free < required:
        raise BackendCacheError(
            "insufficient free space for backend cache growth: "
            f"{free} bytes free, {required} required"
        )


def _growth_journal_path(backing: Path, previous_size: int, target_size: int) -> Path:
    transition = (previous_size, target_size)
    suffixes = {
        (LEGACY_CACHE_SIZE_BYTES, CACHE_SIZE_BYTES): GROWTH_V1_SUFFIX,
        (CACHE_SIZE_BYTES, EXTENDED_CACHE_SIZE_BYTES): GROWTH_V2_SUFFIX,
        (EXTENDED_CACHE_SIZE_BYTES, MAX_CACHE_SIZE_BYTES): GROWTH_V3_SUFFIX,
    }
    try:
        suffix = suffixes[transition]
    except KeyError as exc:
        raise BackendCacheError("unsupported backend cache growth transition") from exc
    return Path(str(backing) + suffix)


def _growth_journal_is_present(
    backing: Path,
    cache_key_value: str,
    previous_size: int = LEGACY_CACHE_SIZE_BYTES,
    target_size: int = CACHE_SIZE_BYTES,
    state: str | None = None,
) -> bool:
    """Admit only an attested journal for the requested capacity transition."""

    try:
        journal = _growth_journal_path(backing, previous_size, target_size)
    except BackendCacheError:
        return False
    if journal.is_symlink() or not journal.exists() or not journal.is_file():
        return False
    try:
        if journal.stat().st_size > 16 * 1024:
            return False
        value = json.loads(journal.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    return (
        isinstance(value, Mapping)
        and value.get("schema") == GROWTH_SCHEMA
        and value.get("operation") == "grow"
        and value.get("state") in {"started", "succeeded"}
        and (state is None or value.get("state") == state)
        and value.get("cache_key") == cache_key_value
        and value.get("previous_size_bytes") == previous_size
        and value.get("size_bytes") == target_size
    )


def _copy_immutable(source: Path, destination: Path) -> str:
    if source.is_symlink() or not source.is_file():
        raise BackendCacheError(f"managed source is not a regular file: {source}")
    data = source.read_bytes()
    if len(data) > 2 * 1024 * 1024:
        raise BackendCacheError(f"managed source is too large: {source}")
    digest = hashlib.sha256(data).hexdigest()
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() or not destination.is_file() or destination.read_bytes() != data:
            raise BackendCacheError(f"managed destination already differs: {destination}")
        os.chmod(destination, 0o444)
        return digest
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(data)
        os.chmod(temporary, 0o444)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return digest


def _atomic_json(destination: Path, value: Mapping[str, Any]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(_canonical_bytes(value) + b"\n")
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()


def _image_attestation(docker: Callable[..., Any], image_id: str, label: str = "backend cache") -> dict[str, Any]:
    _require_image_id(image_id, label)
    raw = docker("image", "inspect", image_id, timeout=60)
    inspected = _read_json_output(raw)
    if not isinstance(inspected, list) or len(inspected) != 1 or not isinstance(inspected[0], Mapping):
        raise BackendCacheError("image inspect did not return one image")
    image = inspected[0]
    if image.get("Id") != image_id:
        raise BackendCacheError(f"{label} image identity changed")
    config = image.get("Config")
    if not isinstance(config, Mapping) or config.get("Volumes") not in (None, {}):
        raise BackendCacheError(f"{label} image must not declare anonymous volumes")
    if image.get("Os") != "linux" or not isinstance(image.get("Architecture"), str):
        raise BackendCacheError(f"{label} requires a Linux image with an architecture")
    return {"id": image_id, "architecture": image["Architecture"], "os": image["Os"]}


def _compose_config(
    docker: Callable[..., Any],
    overlay: Path,
    project_name: str,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    raw = docker(
        "compose", "-f", str(overlay), "--project-name", project_name,
        "--profile", MAINTENANCE_PROFILE, "config", "--format", "json",
        timeout=60, environment=dict(environment),
    )
    document = _read_json_output(raw)
    if not isinstance(document, Mapping):
        raise BackendCacheError("backend cache Compose config is not an object")
    return dict(document)


def _assert_no_active_consumers(docker: Callable[..., Any], cache_key_value: str, mount_root: str) -> None:
    """Reject an exact-key live backend before maintenance can touch its mount."""

    raw = docker(
        "ps", "--quiet", "--filter", f"label={CONSUMER_KEY_LABEL}={cache_key_value}", timeout=60,
    )
    if not isinstance(raw, str):
        raise BackendCacheError("Docker consumer guard returned a non-text result")
    ids = [item.strip() for item in raw.splitlines() if item.strip()]
    for container_id in ids:
        if _CONTAINER_ID.fullmatch(container_id) is None:
            raise BackendCacheError("Docker consumer guard returned an invalid container ID")
        document = _read_json_output(docker("inspect", container_id, timeout=60))
        if not isinstance(document, list) or len(document) != 1 or not isinstance(document[0], Mapping):
            raise BackendCacheError("active cache consumer inspect returned no container")
        container = document[0]
        config = container.get("Config")
        labels = config.get("Labels") if isinstance(config, Mapping) else None
        if not isinstance(labels, Mapping):
            raise BackendCacheError("active backend cache consumer has no attested labels")
        if (labels.get(CONSUMER_PROFILE_LABEL) != PROFILE
                or labels.get(CONSUMER_KEY_LABEL) != cache_key_value):
            raise BackendCacheError("active backend cache consumer identity changed")
        mounts = container.get("Mounts")
        if not isinstance(mounts, list):
            raise BackendCacheError("active backend cache consumer has no mount inventory")
        observed = [
            mount for mount in mounts
            if isinstance(mount, Mapping)
            and mount.get("Destination") == GUEST_TARGET
            and mount.get("Type") == "bind"
        ]
        if len(observed) != 1 or str(observed[0].get("Source")) != mount_root:
            raise BackendCacheError("active backend cache consumer mount identity changed")
        raise BackendCacheError(f"backend cache {cache_key_value} is already held by container {container_id}")


def _assert_no_mount_consumers(docker: Callable[..., Any], mount_root: str) -> None:
    """Reject every Docker container that still declares the exact cache bind."""

    raw = docker("ps", "--all", "--quiet", timeout=60)
    if not isinstance(raw, str):
        raise BackendCacheError("Docker mount consumer guard returned a non-text result")
    ids = [item.strip() for item in raw.splitlines() if item.strip()]
    for container_id in ids:
        if _CONTAINER_ID.fullmatch(container_id) is None:
            raise BackendCacheError("Docker mount consumer guard returned an invalid container ID")
        document = _read_json_output(docker("inspect", container_id, timeout=60))
        if not isinstance(document, list) or len(document) != 1 or not isinstance(document[0], Mapping):
            raise BackendCacheError("Docker mount consumer inspect returned no container")
        mounts = document[0].get("Mounts")
        if not isinstance(mounts, list):
            raise BackendCacheError("Docker mount consumer has no mount inventory")
        if any(
            isinstance(mount, Mapping)
            and mount.get("Type") == "bind"
            and str(mount.get("Source")) == mount_root
            for mount in mounts
        ):
            raise BackendCacheError(
                f"backend cache mount is still declared by Docker container {container_id}"
            )


def _mount_entries(service: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    mounts = service.get("volumes")
    if not isinstance(mounts, list):
        raise BackendCacheError("backend cache Compose service has no bind list")
    result: list[Mapping[str, Any]] = []
    for mount in mounts:
        if not isinstance(mount, Mapping) or mount.get("type") != "bind":
            raise BackendCacheError("backend cache requires bind mounts only")
        result.append(mount)
    return result


def _validate_overlay_config(document: Mapping[str, Any], environment: Mapping[str, str]) -> None:
    if document.get("volumes") not in (None, {}):
        raise BackendCacheError("backend cache overlay must not define named volumes")
    services = document.get("services")
    if not isinstance(services, Mapping):
        raise BackendCacheError("backend cache overlay has no services")
    backend = services.get("backend")
    maintenance = services.get(MAINTENANCE_SERVICE)
    if not isinstance(backend, Mapping) or not isinstance(maintenance, Mapping):
        raise BackendCacheError("backend cache overlay is missing its services")
    if str(backend.get("image")) != environment[ENV_RUNTIME_IMAGE_ID]:
        raise BackendCacheError("backend cache consumer image mismatch")
    labels = backend.get("labels")
    if (not isinstance(labels, Mapping)
            or labels.get(CONSUMER_PROFILE_LABEL) != environment[ENV_PROFILE]
            or labels.get(CONSUMER_KEY_LABEL) != environment[ENV_KEY]):
        raise BackendCacheError("backend cache consumer labels are not exact")
    if backend.get("read_only") is not True or str(backend.get("user")) not in {"65532", "65532:65532"}:
        raise BackendCacheError("backend cache consumer must be an unprivileged read-only service")
    mounts = _mount_entries(backend)
    matching = [mount for mount in mounts if mount.get("target") == GUEST_TARGET]
    if len(matching) != 1:
        raise BackendCacheError("backend cache overlay must expose exactly one /build bind")
    mount = matching[0]
    if str(mount.get("source")) != environment[ENV_MOUNT_ROOT] or mount.get("read_only") is True:
        raise BackendCacheError("backend cache /build bind is not the resolved writable mount")
    if str(maintenance.get("image")) != environment[ENV_HELPER_IMAGE]:
        raise BackendCacheError("backend cache maintenance image mismatch")
    if maintenance.get("privileged") is not True or maintenance.get("network_mode") != "none":
        raise BackendCacheError("backend cache maintenance isolation changed")
    maintenance_environment = maintenance.get("environment")
    if (not isinstance(maintenance_environment, Mapping)
            or str(maintenance_environment.get(ENV_BACKEND_PACKAGE)) != environment[ENV_BACKEND_PACKAGE]):
        raise BackendCacheError("backend cache maintenance has no attested package root")


def _render_maintenance_config(destination: Path, document: Mapping[str, Any]) -> None:
    services = document.get("services")
    if not isinstance(services, Mapping) or MAINTENANCE_SERVICE not in services:
        raise BackendCacheError("cannot render backend cache maintenance config")
    _atomic_json(
        destination,
        {"name": str(document.get("name", "fullmag-backend-cache")),
         "services": {MAINTENANCE_SERVICE: services[MAINTENANCE_SERVICE]}},
    )


def _validate_host_receipt(
    receipt: Mapping[str, Any],
    values: Mapping[str, Any],
    image_id: str,
    toolchain_image: str,
    *,
    expected_size: int | None = None,
) -> None:
    required = {
        "schema", "profile", "state", "project_id", "cache_key", "backing_image",
        "mount_root", "mount_target", "filesystem", "filesystem_label", "filesystem_uuid",
        "loop_device", "mount_active", "size_bytes", "runtime_image_id", "toolchain_image_id",
        "package_root",
    }
    if not required.issubset(receipt):
        raise BackendCacheError("backend cache maintenance receipt is incomplete")
    if receipt["schema"] != SCHEMA or receipt["profile"] != PROFILE or receipt["state"] != "ready":
        raise BackendCacheError("backend cache maintenance receipt schema/state mismatch")
    if receipt["project_id"] != values["project_id"] or receipt["cache_key"] != values["cache_key"]:
        raise BackendCacheError("backend cache project or key changed")
    if receipt["backing_image"] != _daemon_path(values["backing_image"], "backing_image"):
        raise BackendCacheError("backend cache backing image mismatch")
    if receipt["mount_root"] != values["mount_root"] or receipt["mount_target"] != values["mount_target"]:
        raise BackendCacheError("backend cache mount identity mismatch")
    if receipt["package_root"] != values["package_root"]:
        raise BackendCacheError("backend cache package root mismatch")
    if (receipt["filesystem"] != "ext4" or receipt["filesystem_label"] != IMAGE_LABEL
            or not isinstance(receipt["filesystem_uuid"], str)
            or _UUID.fullmatch(receipt["filesystem_uuid"]) is None):
        raise BackendCacheError("backend cache filesystem is not attested ext4")
    if not _LOOP_DEVICE.fullmatch(str(receipt["loop_device"])) or receipt["mount_active"] is not True:
        raise BackendCacheError("backend cache loop mount is not active")
    receipt_size = _require_cache_size(receipt["size_bytes"], "host receipt size")
    if (expected_size is not None and receipt_size != _require_cache_size(expected_size)
            or receipt["runtime_image_id"] != image_id
            or receipt["toolchain_image_id"] != toolchain_image):
        raise BackendCacheError("backend cache size or image attestation mismatch")


def _validate_growth_receipt(
    receipt: Mapping[str, Any],
    values: Mapping[str, Any],
    image_id: str,
    toolchain_image: str,
    *,
    expected_previous_size: int = LEGACY_CACHE_SIZE_BYTES,
    expected_size: int = CACHE_SIZE_BYTES,
) -> None:
    required = {
        "schema", "profile", "state", "project_id", "cache_key", "backing_image",
        "mount_root", "mount_target", "filesystem", "filesystem_label", "filesystem_uuid",
        "loop_device", "mount_active", "previous_size_bytes", "size_bytes",
        "runtime_image_id", "toolchain_image_id", "owner_token", "growth_receipt",
        "package_root",
    }
    if not required.issubset(receipt):
        raise BackendCacheError("backend cache growth receipt is incomplete")
    if receipt["schema"] != SCHEMA or receipt["profile"] != PROFILE or receipt["state"] != "grown":
        raise BackendCacheError("backend cache growth receipt schema/state mismatch")
    if receipt["project_id"] != values["project_id"] or receipt["cache_key"] != values["cache_key"]:
        raise BackendCacheError("backend cache growth project or key changed")
    if receipt["backing_image"] != _daemon_path(values["backing_image"], "backing_image"):
        raise BackendCacheError("backend cache growth backing image mismatch")
    if receipt["mount_root"] != values["mount_root"] or receipt["mount_target"] != values["mount_target"]:
        raise BackendCacheError("backend cache growth mount identity mismatch")
    if receipt["package_root"] != values["package_root"]:
        raise BackendCacheError("backend cache growth package root mismatch")
    if (receipt["filesystem"] != "ext4" or receipt["filesystem_label"] != IMAGE_LABEL
            or not isinstance(receipt["filesystem_uuid"], str)
            or _UUID.fullmatch(receipt["filesystem_uuid"]) is None
            or receipt["mount_active"] is not True):
        raise BackendCacheError("backend cache growth filesystem is not attested")
    expected_previous_size = _require_cache_size(expected_previous_size, "growth source size")
    expected_size = _require_cache_size(expected_size, "growth target size")
    if (receipt["previous_size_bytes"] != expected_previous_size
            or receipt["size_bytes"] != expected_size
            or receipt["runtime_image_id"] != image_id
            or receipt["toolchain_image_id"] != toolchain_image
            or not isinstance(receipt["owner_token"], str)
            or _UUID.fullmatch(receipt["owner_token"]) is None):
        raise BackendCacheError("backend cache growth size, image, or owner attestation mismatch")
    expected_growth_receipt = _growth_journal_path(
        Path(str(values["backing_image"])), expected_previous_size, expected_size,
    )
    if receipt["growth_receipt"] != _daemon_path(
        str(expected_growth_receipt), "growth_receipt"
    ):
        raise BackendCacheError("backend cache growth journal path mismatch")


def prepare(
    layout: Mapping[str, Any],
    repo: str | os.PathLike[str],
    image: str,
    runroot: str | os.PathLike[str],
    docker: Callable[..., Any],
    *,
    source_root: str | os.PathLike[str],
    toolchain_image: str,
) -> dict[str, Any]:
    """Ensure one persistent backend cache and return its Compose profile."""

    repo_path = Path(repo).resolve(strict=True)
    source = _source_root(source_root)
    worktree_id = layout.get("worktree_id")
    if worktree_id is None:
        worktree_id = layout.get("project_id")
    if worktree_id is None:
        try:
            import fullmag_storage
            worktree_id = fullmag_storage.identifier(repo_path)
        except (ImportError, AttributeError, TypeError, ValueError):
            worktree_id = hashlib.sha256(str(repo_path).encode("utf-8")).hexdigest()[:16]
    identity = cache_key(source, str(worktree_id), toolchain_image)
    paths = _cache_paths(layout, identity["key"])
    capacity = _existing_backing_size(paths["backing_image"])
    _guard_new_backing_space(paths["backing_image"], paths["storage_root"], capacity)
    _require_image_id(image, "runtime image")
    _require_image_id(toolchain_image, "toolchain image")
    run_path = Path(runroot)
    if not run_path.is_absolute() or run_path.is_symlink():
        raise BackendCacheError("backend cache run root must be an absolute real path")
    run_path.mkdir(parents=True, exist_ok=True)

    helper_source = repo_path / "scripts" / "lib" / "docker_backend_cache.sh"
    overlay_source = repo_path / "compose.backend-cache.yaml"
    helper_copy = run_path / "docker_backend_cache.sh"
    overlay_copy = run_path / "compose.backend-cache.yaml"
    helper_sha256 = _copy_immutable(helper_source, helper_copy)
    overlay_sha256 = _copy_immutable(overlay_source, overlay_copy)
    runtime = _image_attestation(docker, image, "runtime")
    toolchain = _image_attestation(docker, toolchain_image, "toolchain")
    values = {**paths, "cache_key": identity["key"], "image_id": image, "toolchain_image_id": toolchain_image}
    project_name = f"fullmag-backend-cache-{paths['project_id']}-{identity['key'][:16]}"
    environment: dict[str, str] = {
        ENV_SCHEMA: SCHEMA,
        ENV_PROFILE: PROFILE,
        ENV_PROJECT_ID: paths["project_id"],
        ENV_KEY: identity["key"],
        ENV_STORAGE_ROOT: _daemon_path(paths["storage_root"], "storage_root"),
        ENV_BACKING_IMAGE: _daemon_path(paths["backing_image"], "backing_image"),
        ENV_LOCK_PATH: _daemon_path(paths["lock_path"], "lock_path"),
        ENV_MOUNT_ROOT: paths["mount_root"],
        ENV_BACKEND_PACKAGE: paths["package_root"],
        ENV_OWNER_MARKER: paths["owner_marker"],
        ENV_SIZE_BYTES: str(capacity),
        ENV_MOUNT_TARGET: paths["mount_target"],
        ENV_FILESYSTEM_UUID: "",
        ENV_RUNTIME_IMAGE_ID: image,
        ENV_HELPER_IMAGE: image,
        ENV_HELPER_PATH: _daemon_path(helper_copy, "helper_copy"),
        ENV_HOST_PID: "1",
        ENV_UID: "65532",
        ENV_GID: "65532",
        ENV_SOURCE_ROOT: source,
        ENV_WORKTREE_ID: str(worktree_id),
        ENV_TOOLCHAIN_IMAGE: toolchain_image,
        ENV_LOCK_WAIT: "120",
    }

    _assert_no_active_consumers(docker, identity["key"], paths["mount_root"])
    configured = _compose_config(docker, overlay_copy, project_name, environment)
    _validate_overlay_config(configured, environment)
    maintenance_config = run_path / "compose.backend-cache-maintenance.json"
    _render_maintenance_config(maintenance_config, configured)
    maintenance_name = f"fullmag-backend-cache-maintenance-{identity['key'][:16]}"
    output = docker(
        "compose", "--project-name", project_name, "-f", str(maintenance_config),
        "--profile", MAINTENANCE_PROFILE, "run", "--rm", "--no-deps", "--name",
        maintenance_name, "--label", f"{CONSUMER_PROFILE_LABEL}={PROFILE}",
        MAINTENANCE_SERVICE, "ensure", timeout=180, environment=environment,
    )
    receipt = _read_json_output(output)
    if not isinstance(receipt, Mapping):
        raise BackendCacheError("backend cache maintenance returned no receipt")
    _validate_host_receipt(receipt, values, image, toolchain_image, expected_size=capacity)
    environment[ENV_FILESYSTEM_UUID] = str(receipt["filesystem_uuid"])
    receipt_path = run_path / "backend-cache-receipt.json"
    _atomic_json(
        receipt_path,
        {
            "schema": SCHEMA, "profile": PROFILE, "state": "ready",
            "cache_key": identity["key"], "identity": identity,
            "project_id": paths["project_id"], "runtime_image": runtime,
            "toolchain_image": toolchain, "host_receipt": dict(receipt),
            "size_bytes": capacity,
            "package_root": paths["package_root"],
            "helper_sha256": helper_sha256, "compose_overlay_sha256": overlay_sha256,
            "environment": environment,
        },
    )
    return {
        "schema": SCHEMA, "profile": PROFILE, "state": "ready",
        "cache_key": identity["key"], "identity": identity,
        "project_id": paths["project_id"], "image_id": image,
        "toolchain_image_id": toolchain_image,
        "size_bytes": capacity,
        "filesystem_uuid": environment[ENV_FILESYSTEM_UUID],
        "mount_root": paths["mount_root"], "guest_target": GUEST_TARGET,
        "package_root": paths["package_root"],
        "environment": environment, "compose_overlay": str(overlay_copy),
        "maintenance_compose": str(maintenance_config),
        "helper_sha256": helper_sha256, "compose_overlay_sha256": overlay_sha256,
        "receipt": dict(receipt), "receipt_path": str(receipt_path),
    }


def grow(
    layout: Mapping[str, Any],
    repo: str | os.PathLike[str],
    image: str,
    runroot: str | os.PathLike[str],
    docker: Callable[..., Any],
    *,
    source_root: str | os.PathLike[str],
    toolchain_image: str,
    target_size: int | None = None,
) -> dict[str, Any]:
    """Grow one attested cache by one supported capacity step.

    This is deliberately separate from :func:`prepare`: an existing backing is
    never resized as a side effect of normal cache admission.  The maintenance
    helper writes a durable started/succeeded journal and fails closed on an
    incomplete or foreign journal.

    A legacy 12 GiB cache keeps its historical default transition to 24 GiB.
    Growing an existing 24 GiB cache requires the caller to explicitly pass
    ``target_size=EXTENDED_CACHE_SIZE_BYTES``.  Growing an existing 40 GiB
    cache likewise requires ``target_size=MAX_CACHE_SIZE_BYTES``; ordinary
    cache preparation never performs either migration implicitly.
    """

    repo_path = Path(repo).resolve(strict=True)
    source = _source_root(source_root)
    worktree_id = layout.get("worktree_id")
    if worktree_id is None:
        worktree_id = layout.get("project_id")
    if worktree_id is None:
        try:
            import fullmag_storage
            worktree_id = fullmag_storage.identifier(repo_path)
        except (ImportError, AttributeError, TypeError, ValueError):
            worktree_id = hashlib.sha256(str(repo_path).encode("utf-8")).hexdigest()[:16]
    identity = cache_key(source, str(worktree_id), toolchain_image)
    paths = _cache_paths(layout, identity["key"])
    capacity = _existing_backing_size(paths["backing_image"])
    previous_size: int
    resuming = False
    if target_size is None:
        if capacity == LEGACY_CACHE_SIZE_BYTES:
            target_size = CACHE_SIZE_BYTES
        elif capacity == CACHE_SIZE_BYTES and _growth_journal_is_present(
            paths["backing_image"], identity["key"],
            LEGACY_CACHE_SIZE_BYTES, CACHE_SIZE_BYTES,
        ):
            # The legacy transition may have resized the backing before its
            # owner marker was published. Resume that exact journal only.
            target_size = CACHE_SIZE_BYTES
            previous_size = LEGACY_CACHE_SIZE_BYTES
            resuming = True
        elif capacity == EXTENDED_CACHE_SIZE_BYTES and _growth_journal_is_present(
            paths["backing_image"], identity["key"],
            CACHE_SIZE_BYTES, EXTENDED_CACHE_SIZE_BYTES,
        ):
            target_size = EXTENDED_CACHE_SIZE_BYTES
            previous_size = CACHE_SIZE_BYTES
            resuming = True
        elif capacity == MAX_CACHE_SIZE_BYTES and _growth_journal_is_present(
            paths["backing_image"], identity["key"],
            EXTENDED_CACHE_SIZE_BYTES, MAX_CACHE_SIZE_BYTES,
        ):
            target_size = MAX_CACHE_SIZE_BYTES
            previous_size = EXTENDED_CACHE_SIZE_BYTES
            resuming = True
        else:
            if capacity == CACHE_SIZE_BYTES:
                required_target = "target_size=EXTENDED_CACHE_SIZE_BYTES"
            elif capacity == EXTENDED_CACHE_SIZE_BYTES:
                required_target = "target_size=MAX_CACHE_SIZE_BYTES"
            else:
                required_target = "an explicit adjacent target_size"
            raise BackendCacheError(
                "growing an existing backend cache requires explicit "
                f"{required_target}"
            )
    target_size = _require_cache_size(target_size, "growth target size")
    if capacity == target_size:
        if target_size == CACHE_SIZE_BYTES:
            previous_size = LEGACY_CACHE_SIZE_BYTES
        elif target_size == EXTENDED_CACHE_SIZE_BYTES:
            previous_size = CACHE_SIZE_BYTES
        elif target_size == MAX_CACHE_SIZE_BYTES:
            previous_size = EXTENDED_CACHE_SIZE_BYTES
        else:  # pragma: no cover - _require_cache_size rejects other targets.
            raise BackendCacheError("backend cache growth target is unsupported")
        if not _growth_journal_is_present(
            paths["backing_image"], identity["key"],
            previous_size, target_size,
        ):
            raise BackendCacheError(
                "backend cache growth found a target-sized backing without an "
                "attested started journal"
            )
        resuming = True
    else:
        previous_size = capacity
    transitions = {
        (LEGACY_CACHE_SIZE_BYTES, CACHE_SIZE_BYTES),
        (CACHE_SIZE_BYTES, EXTENDED_CACHE_SIZE_BYTES),
        (EXTENDED_CACHE_SIZE_BYTES, MAX_CACHE_SIZE_BYTES),
    }
    if (previous_size, target_size) not in transitions:
        raise BackendCacheError(
            "backend cache growth requires an adjacent supported capacity "
            f"(current={capacity}, target={target_size})"
        )
    if not resuming:
        _guard_growth_space(
            paths["backing_image"], paths["storage_root"], previous_size, target_size,
        )
    _require_image_id(image, "runtime image")
    _require_image_id(toolchain_image, "toolchain image")
    run_path = Path(runroot)
    if not run_path.is_absolute() or run_path.is_symlink():
        raise BackendCacheError("backend cache growth run root must be an absolute real path")
    run_path.mkdir(parents=True, exist_ok=True)

    helper_source = repo_path / "scripts" / "lib" / "docker_backend_cache.sh"
    overlay_source = repo_path / "compose.backend-cache.yaml"
    helper_copy = run_path / "docker_backend_cache.grow.sh"
    overlay_copy = run_path / "compose.backend-cache.grow.yaml"
    helper_sha256 = _copy_immutable(helper_source, helper_copy)
    overlay_sha256 = _copy_immutable(overlay_source, overlay_copy)
    runtime = _image_attestation(docker, image, "runtime")
    toolchain = _image_attestation(docker, toolchain_image, "toolchain")
    values = {
        **paths,
        "cache_key": identity["key"],
        "image_id": image,
        "toolchain_image_id": toolchain_image,
    }
    project_name = f"fullmag-backend-cache-grow-{paths['project_id']}-{identity['key'][:16]}"
    environment: dict[str, str] = {
        ENV_SCHEMA: SCHEMA,
        ENV_PROFILE: PROFILE,
        ENV_PROJECT_ID: paths["project_id"],
        ENV_KEY: identity["key"],
        ENV_STORAGE_ROOT: _daemon_path(paths["storage_root"], "storage_root"),
        ENV_BACKING_IMAGE: _daemon_path(paths["backing_image"], "backing_image"),
        ENV_LOCK_PATH: _daemon_path(paths["lock_path"], "lock_path"),
        ENV_MOUNT_ROOT: paths["mount_root"],
        ENV_BACKEND_PACKAGE: paths["package_root"],
        ENV_OWNER_MARKER: paths["owner_marker"],
        ENV_SIZE_BYTES: str(target_size),
        ENV_MOUNT_TARGET: paths["mount_target"],
        ENV_FILESYSTEM_UUID: "",
        ENV_RUNTIME_IMAGE_ID: image,
        ENV_HELPER_IMAGE: image,
        ENV_HELPER_PATH: _daemon_path(helper_copy, "helper_copy"),
        ENV_HOST_PID: "1",
        ENV_UID: "65532",
        ENV_GID: "65532",
        ENV_SOURCE_ROOT: source,
        ENV_WORKTREE_ID: str(worktree_id),
        ENV_TOOLCHAIN_IMAGE: toolchain_image,
        ENV_LOCK_WAIT: "120",
    }

    _assert_no_active_consumers(docker, identity["key"], paths["mount_root"])
    _assert_no_mount_consumers(docker, paths["mount_root"])
    configured = _compose_config(docker, overlay_copy, project_name, environment)
    _validate_overlay_config(configured, environment)
    maintenance_config = run_path / "compose.backend-cache-growth-maintenance.json"
    _render_maintenance_config(maintenance_config, configured)
    maintenance_name = f"fullmag-backend-cache-growth-{identity['key'][:16]}"
    growth_receipt = _growth_journal_path(
        paths["backing_image"], previous_size, target_size,
    )
    output = docker(
        "compose", "--project-name", project_name, "-f", str(maintenance_config),
        "--profile", MAINTENANCE_PROFILE, "run", "--rm", "--no-deps", "--name",
        maintenance_name, "--label", f"{CONSUMER_PROFILE_LABEL}={PROFILE}",
        "-e", f"FULLMAG_BACKEND_CACHE_GROW_FROM_BYTES={previous_size}",
        "-e", f"FULLMAG_BACKEND_CACHE_GROW_TO_BYTES={target_size}",
        "-e", f"FULLMAG_BACKEND_CACHE_GROWTH_RECEIPT={_daemon_path(str(growth_receipt), 'growth_receipt')}",
        MAINTENANCE_SERVICE, "grow", timeout=300, environment=environment,
    )
    receipt = _read_json_output(output)
    if not isinstance(receipt, Mapping):
        raise BackendCacheError("backend cache growth returned no receipt")
    _validate_growth_receipt(
        receipt,
        values,
        image,
        toolchain_image,
        expected_previous_size=previous_size,
        expected_size=target_size,
    )
    environment[ENV_FILESYSTEM_UUID] = str(receipt["filesystem_uuid"])
    receipt_path = run_path / "backend-cache-growth-receipt.json"
    _atomic_json(
        receipt_path,
        {
            "schema": SCHEMA, "profile": PROFILE, "state": "grown",
            "cache_key": identity["key"], "identity": identity,
            "project_id": paths["project_id"], "runtime_image": runtime,
            "toolchain_image": toolchain, "host_receipt": dict(receipt),
            "previous_size_bytes": previous_size,
            "size_bytes": target_size,
            "package_root": paths["package_root"],
            "helper_sha256": helper_sha256, "compose_overlay_sha256": overlay_sha256,
            "environment": environment,
        },
    )
    return {
        "schema": SCHEMA, "profile": PROFILE, "state": "grown",
        "cache_key": identity["key"], "identity": identity,
        "project_id": paths["project_id"], "image_id": image,
        "toolchain_image_id": toolchain_image,
        "previous_size_bytes": previous_size,
        "size_bytes": target_size,
        "filesystem_uuid": environment[ENV_FILESYSTEM_UUID],
        "mount_root": paths["mount_root"], "guest_target": GUEST_TARGET,
        "package_root": paths["package_root"],
        "environment": environment, "compose_overlay": str(overlay_copy),
        "maintenance_compose": str(maintenance_config),
        "helper_sha256": helper_sha256, "compose_overlay_sha256": overlay_sha256,
        "receipt": dict(receipt), "receipt_path": str(receipt_path),
    }


def _container_env(document: Mapping[str, Any]) -> dict[str, str]:
    config = document.get("Config")
    if not isinstance(config, Mapping) or not isinstance(config.get("Env", []), list):
        raise BackendCacheError("backend container environment is malformed")
    result: dict[str, str] = {}
    for value in config["Env"]:
        if isinstance(value, str) and "=" in value:
            name, item = value.split("=", 1)
            result[name] = item
    return result


def validate_container(document: Mapping[str, Any], profile: Mapping[str, Any]) -> dict[str, Any]:
    """Fail closed unless a running backend has the exact writable /build bind."""

    if profile.get("schema") != SCHEMA or profile.get("state") != "ready":
        raise BackendCacheError("backend cache profile is not ready")
    if profile.get("image_id") is not None and document.get("Image") != profile["image_id"]:
        raise BackendCacheError("backend container image identity changed")
    config = document.get("Config")
    if not isinstance(config, Mapping):
        raise BackendCacheError("backend container has no config")
    user = config.get("User")
    if user not in (None, "", "65532", "65532:65532"):
        raise BackendCacheError("backend container is not unprivileged")
    host_config = document.get("HostConfig")
    if config.get("ReadonlyRootfs") is False or (
            isinstance(host_config, Mapping) and host_config.get("ReadonlyRootfs") is False):
        raise BackendCacheError("backend container root is not read-only")
    expected = profile.get("environment")
    if not isinstance(expected, Mapping):
        raise BackendCacheError("backend cache profile has no environment")
    env = _container_env(document)
    for name in (ENV_SCHEMA, ENV_PROFILE, ENV_PROJECT_ID, ENV_KEY,
                 ENV_FILESYSTEM_UUID, ENV_RUNTIME_IMAGE_ID, ENV_TOOLCHAIN_IMAGE):
        if env.get(name) != str(expected[name]):
            raise BackendCacheError(f"backend container cache environment mismatch: {name}")
    labels = config.get("Labels")
    if (not isinstance(labels, Mapping)
            or labels.get(CONSUMER_PROFILE_LABEL) != str(expected[ENV_PROFILE])
            or labels.get(CONSUMER_KEY_LABEL) != str(expected[ENV_KEY])):
        raise BackendCacheError("backend container cache labels mismatch")
    mounts = document.get("Mounts")
    if not isinstance(mounts, list):
        raise BackendCacheError("backend container has no mount list")
    matching = [
        mount for mount in mounts
        if isinstance(mount, Mapping) and mount.get("Destination", mount.get("destination")) == GUEST_TARGET
    ]
    if len(matching) != 1:
        raise BackendCacheError("backend container is missing exactly one /build mount")
    mount = matching[0]
    if mount.get("Type", mount.get("type")) != "bind":
        raise BackendCacheError("backend cache forbids a named /build volume")
    if str(mount.get("Source", mount.get("source"))) != str(profile["mount_root"]):
        raise BackendCacheError("backend container /build source mismatch")
    if mount.get("RW") is False or mount.get("read_only") is True:
        raise BackendCacheError("backend container /build bind is read-only")
    return {
        "schema": SCHEMA, "state": "attested", "cache_key": profile["cache_key"],
        "filesystem_uuid": profile["filesystem_uuid"],
        "target": GUEST_TARGET,
    }
