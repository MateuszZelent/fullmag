"""Versioned Docker-VM named-volume backend development cache.

This module is a host-side adapter contract.  It does not inspect or invent a
Windows path for a Docker volume: the Docker Engine volume name and its
attested inspect document are the storage identity.  The v2 cache is a pair
of local named volumes (build and package) with one stable unit identity.

``prepare`` only derives the plan and may create the exact pair when an
explicit Docker callback is supplied.  ``overlay`` describes only the runtime
backend; ``maintenance_overlay`` separately describes the fixed maintenance
service that initializes or reopens owner markers and performs the bounded
readback probe.  ``validate`` admits the pair only after that receipt and
writes the canonical run receipt.  No function removes a volume or performs a
migration.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Mapping

SCHEMA = "fullmag.backend-build-cache.v2"
KEY_SCHEMA = "fullmag.backend-build-cache-key.v2"
OWNER_SCHEMA = "fullmag.backend-build-cache-owner.v2"
PROBE_SCHEMA = "fullmag.backend-build-cache-probe.v2"
MAINTENANCE_RECEIPT_SCHEMA = "fullmag.backend-build-cache-maintenance.v2"
PROFILE = "backend-build-cache-v2"
MAINTENANCE_PROFILE = "backend-build-cache-v2-maintenance"
MAINTENANCE_SERVICE = "backend-cache-volume-maintenance"
VOLUME_DRIVER = "local"
BUILD_VOLUME_ROLE = "build"
PACKAGE_VOLUME_ROLE = "package"
BUILD_TARGET = "/build"
PACKAGE_TARGET = "/opt/fullmag/package"
COMPOSE_BUILD_VOLUME = "backend-cache-build"
COMPOSE_PACKAGE_VOLUME = "backend-cache-package"
MAINTENANCE_ENTRYPOINT = (
    "/usr/local/bin/python3",
    "/opt/fullmag/backend_volume_cache_maintenance.py",
)
BACKEND_SERVICE = "backend"
SUPPORTED_CARGO_PROFILES = frozenset({"backend-dev", "release"})
RECEIPT_NAME = "backend-volume-cache-receipt.json"

LABEL_SCHEMA = "com.fullmag.backend-cache.schema"
LABEL_PROFILE = "com.fullmag.backend-cache.profile"
LABEL_PROJECT = "com.fullmag.backend-cache.project-id"
LABEL_CACHE_KEY = "com.fullmag.backend-cache.key"
LABEL_UNIT = "com.fullmag.backend-cache.unit-key"
LABEL_WORKTREE = "com.fullmag.backend-cache.worktree-id"
LABEL_TOOLCHAIN = "com.fullmag.backend-cache.toolchain-image-id"
LABEL_CARGO_PROFILE = "com.fullmag.backend-cache.cargo-profile"
LABEL_OWNER = "com.fullmag.backend-cache.owner-id"
LABEL_ROLE = "com.fullmag.backend-cache.volume-role"
_LABEL_PREFIX = "com.fullmag.backend-cache."

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
_IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_VOLUME_NAME = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,127}$")
_HEX_OR_ID = re.compile(r"^[0-9a-f]{64}$")
_WINDOWS_ABSOLUTE = re.compile(r"^[A-Za-z]:[\\/].*$")


class BackendVolumeCacheError(RuntimeError):
    """Raised when a named-volume cache cannot be proven exact and owned."""


class VolumeNotFound(BackendVolumeCacheError):
    """The Docker callback reports that one exact volume does not exist."""


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _read_json_output(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str):
        raise BackendVolumeCacheError("Docker command returned a non-text result")

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in pairs:
            if key in result:
                raise BackendVolumeCacheError(
                    f"Docker JSON contains duplicate key: {key}"
                )
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
    raise BackendVolumeCacheError("Docker command did not return JSON")


def _require_image_id(value: str, label: str) -> str:
    if not isinstance(value, str) or _IMAGE_ID.fullmatch(value) is None:
        raise BackendVolumeCacheError(f"{label} must be a full immutable image ID")
    return value


def _require_identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or _IDENTIFIER.fullmatch(value) is None:
        raise BackendVolumeCacheError(f"{label} is not a safe identifier")
    return value


def _source_root(value: str | os.PathLike[str]) -> str:
    path = Path(value)
    if not path.is_absolute() or path.is_symlink():
        raise BackendVolumeCacheError("source_root must be an absolute real directory")
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise BackendVolumeCacheError(f"source_root is unavailable: {path}") from error
    if not resolved.is_dir() or resolved.is_symlink():
        raise BackendVolumeCacheError("source_root must be a real directory")
    return str(resolved)


def _storage_root(layout: Mapping[str, Any]) -> Path:
    value = layout.get("storage_root")
    if not isinstance(value, str) and not isinstance(value, os.PathLike):
        raise BackendVolumeCacheError("storage layout has no storage_root")
    root = Path(value)
    if not root.is_absolute() or root == Path(root.anchor) or root.is_symlink():
        raise BackendVolumeCacheError("storage_root must be an absolute real non-root path")
    return root


def _safe_project_id(layout: Mapping[str, Any]) -> str:
    value = layout.get("project_id")
    if value is None:
        value = layout.get("host_ledger_project_id")
    if value is None:
        project_root = layout.get("project_root")
        if project_root is None:
            raise BackendVolumeCacheError("storage layout has no project identity")
        value = hashlib.sha256(str(Path(project_root).resolve()).encode()).hexdigest()[:16]
    return _require_identifier(str(value), "project_id")


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
        return True
    except ValueError:
        return False


def _receipt_path(layout: Mapping[str, Any], runroot: str | os.PathLike[str]) -> Path:
    root = _storage_root(layout)
    path = Path(runroot)
    if (not path.is_absolute() or path.is_symlink() or not path.is_dir()
            or not _inside(path, root)):
        raise BackendVolumeCacheError(
            "runroot must be an existing non-symlink directory inside canonical storage"
        )
    cursor = path
    while cursor != cursor.parent:
        if cursor.is_symlink():
            raise BackendVolumeCacheError("runroot parent contains a symlink")
        cursor = cursor.parent
    return path / RECEIPT_NAME


def _safe_daemon_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.startswith("/"):
        raise BackendVolumeCacheError(f"{label} must be an absolute daemon path")
    if _WINDOWS_ABSOLUTE.fullmatch(value) or "\\" in value:
        raise BackendVolumeCacheError(f"{label} must not be a Windows path")
    path = PurePosixPath(value)
    if any(part in {"", ".", ".."} for part in path.parts[1:]):
        raise BackendVolumeCacheError(f"{label} has unsafe path components")
    return str(path)


def cache_key(
    source_root: str | os.PathLike[str],
    worktree_id: str,
    toolchain_image: str,
    cargo_profile: str = "backend-dev",
) -> dict[str, Any]:
    """Derive a stable cache identity without the mutable runtime image.

    Source edits and a wrapper-image refresh intentionally reuse the same
    incremental Cargo/CMake cache.  A worktree, compiler/toolchain, profile or
    source-root change receives a different unit.
    """

    source = _source_root(source_root)
    worktree = _require_identifier(worktree_id, "worktree_id")
    toolchain = _require_image_id(toolchain_image, "toolchain_image")
    if cargo_profile not in SUPPORTED_CARGO_PROFILES:
        raise BackendVolumeCacheError(
            f"unsupported cargo profile: {cargo_profile}; expected one of "
            f"{', '.join(sorted(SUPPORTED_CARGO_PROFILES))}"
        )
    inputs = {
        "source_root": source,
        "worktree_id": worktree,
        "toolchain_image_id": toolchain,
        "cargo_profile": cargo_profile,
    }
    return {
        "schema": KEY_SCHEMA,
        "key": _sha256({"schema": KEY_SCHEMA, **inputs}),
        "inputs": inputs,
    }


def _volume_names(project_id: str, unit_key: str) -> dict[str, str]:
    # Keep Docker names bounded.  Full identity remains in labels and receipts.
    name_id = hashlib.sha256(f"{project_id}:{unit_key}".encode()).hexdigest()[:24]
    base = f"fullmag-backend-v2-{name_id}"
    return {
        BUILD_VOLUME_ROLE: f"{base}-build",
        PACKAGE_VOLUME_ROLE: f"{base}-package",
    }


def volume_labels(profile: Mapping[str, Any], role: str) -> dict[str, str]:
    if role not in {BUILD_VOLUME_ROLE, PACKAGE_VOLUME_ROLE}:
        raise BackendVolumeCacheError(f"unknown volume role: {role}")
    return {
        LABEL_SCHEMA: SCHEMA,
        LABEL_PROFILE: PROFILE,
        LABEL_PROJECT: str(profile["project_id"]),
        LABEL_CACHE_KEY: str(profile["cache_key"]),
        LABEL_UNIT: str(profile["unit_key"]),
        LABEL_WORKTREE: str(profile["worktree_id"]),
        LABEL_TOOLCHAIN: str(profile["toolchain_image_id"]),
        LABEL_CARGO_PROFILE: str(profile["cargo_profile"]),
        LABEL_OWNER: str(profile["owner_id"]),
        LABEL_ROLE: role,
    }


# Keep internal callers explicit while exposing the label contract to consumers.
_labels = volume_labels


def mount_specs(profile: Mapping[str, Any]) -> list[dict[str, Any]]:
    volumes = profile["volume_names"]
    return [
        {
            "type": "volume",
            "source": COMPOSE_BUILD_VOLUME,
            "target": BUILD_TARGET,
            "read_only": False,
            "volume": {"nocopy": True},
        },
        {
            "type": "volume",
            "source": COMPOSE_PACKAGE_VOLUME,
            "target": PACKAGE_TARGET,
            "read_only": False,
            "volume": {"nocopy": True},
        },
    ]


_mount_specs = mount_specs


def _cache_environment(profile: Mapping[str, Any]) -> dict[str, str]:
    return {
        "FULLMAG_BACKEND_CACHE_SCHEMA": SCHEMA,
        "FULLMAG_BACKEND_CACHE_PROFILE": PROFILE,
        "FULLMAG_BACKEND_CACHE_PROJECT_ID": str(profile["project_id"]),
        "FULLMAG_BACKEND_CACHE_KEY": str(profile["cache_key"]),
        "FULLMAG_BACKEND_CACHE_UNIT_KEY": str(profile["unit_key"]),
        "FULLMAG_BACKEND_CACHE_OWNER_ID": str(profile["owner_id"]),
        "FULLMAG_BACKEND_CACHE_WORKTREE_ID": str(profile["worktree_id"]),
        "FULLMAG_BACKEND_CACHE_TOOLCHAIN_IMAGE_ID": str(profile["toolchain_image_id"]),
        "FULLMAG_BACKEND_RUNTIME_IMAGE_ID": str(profile["runtime_image_id"]),
        "FULLMAG_BACKEND_CARGO_PROFILE": str(profile["cargo_profile"]),
        "FULLMAG_BACKEND_CACHE_BUILD_VOLUME": profile["volume_names"][BUILD_VOLUME_ROLE],
        "FULLMAG_BACKEND_CACHE_PACKAGE_VOLUME": profile["volume_names"][PACKAGE_VOLUME_ROLE],
        "FULLMAG_BACKEND_PACKAGE": PACKAGE_TARGET,
        "FULLMAG_BACKEND_CACHE_BUILD_ROOT": BUILD_TARGET,
        "FULLMAG_BACKEND_CACHE_PACKAGE_ROOT": PACKAGE_TARGET,
    }


def _container_labels(profile: Mapping[str, Any]) -> dict[str, str]:
    """Return the cache identity labels shared by runtime and maintenance."""

    return {
        LABEL_SCHEMA: SCHEMA,
        LABEL_PROFILE: PROFILE,
        LABEL_PROJECT: str(profile["project_id"]),
        LABEL_CACHE_KEY: str(profile["cache_key"]),
        LABEL_UNIT: str(profile["unit_key"]),
        LABEL_WORKTREE: str(profile["worktree_id"]),
        LABEL_TOOLCHAIN: str(profile["toolchain_image_id"]),
        LABEL_CARGO_PROFILE: str(profile["cargo_profile"]),
        LABEL_OWNER: str(profile["owner_id"]),
    }


def _volume_declarations(profile: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        COMPOSE_BUILD_VOLUME: {
            "name": profile["volume_names"][BUILD_VOLUME_ROLE],
            "external": True,
        },
        COMPOSE_PACKAGE_VOLUME: {
            "name": profile["volume_names"][PACKAGE_VOLUME_ROLE],
            "external": True,
        },
    }


def _maintenance_service(profile: Mapping[str, Any]) -> dict[str, Any]:
    environment = {
        **_cache_environment(profile),
        "FULLMAG_BACKEND_CACHE_MAINTENANCE_PROFILE": MAINTENANCE_PROFILE,
        "FULLMAG_BACKEND_CACHE_MAINTENANCE_ACTION": "ensure",
        "FULLMAG_BACKEND_CACHE_OWNER_UID": "65532",
        "FULLMAG_BACKEND_CACHE_OWNER_GID": "65532",
    }
    return {
        "image": profile["runtime_image_id"],
        "pull_policy": "never",
        "user": "0:0",
        "read_only": True,
        "privileged": False,
        "cap_drop": ["ALL"],
        "cap_add": ["CHOWN"],
        "security_opt": ["no-new-privileges:true"],
        "network_mode": "none",
        "restart": "no",
        "entrypoint": list(MAINTENANCE_ENTRYPOINT),
        "command": ["ensure"],
        "labels": _container_labels(profile),
        "volumes": _mount_specs(profile),
        "environment": environment,
    }


def _plan(
    layout: Mapping[str, Any],
    repo: str | os.PathLike[str],
    image: str,
    runroot: str | os.PathLike[str],
    *,
    source_root: str | os.PathLike[str],
    toolchain_image: str,
    cargo_profile: str,
) -> dict[str, Any]:
    repo_path = Path(repo)
    if not repo_path.is_absolute() or repo_path.is_symlink() or not repo_path.is_dir():
        raise BackendVolumeCacheError("repo must be an absolute real directory")
    image = _require_image_id(image, "runtime image")
    toolchain_image = _require_image_id(toolchain_image, "toolchain image")
    worktree_id = _require_identifier(str(layout.get("worktree_id", "")), "worktree_id")
    project_id = _safe_project_id(layout)
    receipt = _receipt_path(layout, runroot)
    identity = cache_key(source_root, worktree_id, toolchain_image, cargo_profile)
    unit_key = _sha256({
        "schema": SCHEMA,
        "project_id": project_id,
        "cache_key": identity["key"],
        "worktree_id": worktree_id,
        "toolchain_image_id": toolchain_image,
        "cargo_profile": cargo_profile,
    })
    volume_names = _volume_names(project_id, unit_key)
    owner_id = unit_key
    profile = {
        "schema": SCHEMA,
        "profile": PROFILE,
        "state": "prepared",
        "project_id": project_id,
        "worktree_id": worktree_id,
        "cache_key": identity["key"],
        "identity": identity,
        "unit_key": unit_key,
        "owner_id": owner_id,
        "cargo_profile": cargo_profile,
        "runtime_image_id": image,
        "toolchain_image_id": toolchain_image,
        "volume_names": volume_names,
        "volume_roles": {
            BUILD_VOLUME_ROLE: {"target": BUILD_TARGET, "labels": _labels({
                "project_id": project_id, "cache_key": identity["key"],
                "unit_key": unit_key, "worktree_id": worktree_id,
                "toolchain_image_id": toolchain_image,
                "cargo_profile": cargo_profile, "owner_id": owner_id,
            }, BUILD_VOLUME_ROLE)},
            PACKAGE_VOLUME_ROLE: {"target": PACKAGE_TARGET, "labels": _labels({
                "project_id": project_id, "cache_key": identity["key"],
                "unit_key": unit_key, "worktree_id": worktree_id,
                "toolchain_image_id": toolchain_image,
                "cargo_profile": cargo_profile, "owner_id": owner_id,
            }, PACKAGE_VOLUME_ROLE)},
        },
        "mount_root": BUILD_TARGET,
        "build_root": BUILD_TARGET,
        "package_root": PACKAGE_TARGET,
        "receipt_path": str(receipt),
        "host_receipt_path": str(receipt),
        "environment": {},
    }
    profile["environment"] = _cache_environment(profile)
    profile["mounts"] = _mount_specs(profile)
    profile["maintenance_service"] = _maintenance_service(profile)
    return profile


def prepare(
    layout: Mapping[str, Any],
    repo: str | os.PathLike[str],
    image: str,
    runroot: str | os.PathLike[str],
    docker: Callable[..., Any] | None = None,
    *,
    source_root: str | os.PathLike[str],
    toolchain_image: str,
    cargo_profile: str = "backend-dev",
    active_consumers: Iterable[Mapping[str, Any]]
    | Callable[[], Iterable[Mapping[str, Any]]] = (),
) -> dict[str, Any]:
    """Build the v2 plan and optionally create only its exact missing pair.

    ``docker`` is deliberately optional so callers can inspect/compose the
    plan without mutating the Engine.  When provided, it must implement the
    narrow calls documented by ``ensure_volume_pair``; no removal or prune is
    ever attempted.
    """

    profile = _plan(
        layout, repo, image, runroot, source_root=source_root,
        toolchain_image=toolchain_image, cargo_profile=cargo_profile,
    )
    if docker is not None:
        profile["volume_documents"] = ensure_volume_pair(
            docker, profile, active_consumers=active_consumers
        )
    return profile


def prepare_ready(
    layout: Mapping[str, Any],
    repo: str | os.PathLike[str],
    image: str,
    runroot: str | os.PathLike[str],
    docker: Callable[..., Any],
    maintenance: Callable[[Mapping[str, Any], Mapping[str, Any]], Mapping[str, Any]],
    *,
    source_root: str | os.PathLike[str],
    toolchain_image: str,
    cargo_profile: str = "backend-dev",
    active_consumers: Iterable[Mapping[str, Any]]
    | Callable[[], Iterable[Mapping[str, Any]]] = (),
) -> dict[str, Any]:
    """Prepare and admit a pair after a managed guest maintenance callback.

    The callback receives only the immutable cache profile and the separate
    maintenance overlay.  It is responsible for running the fixed helper in
    the managed Docker group and returning its JSON receipt; this adapter does
    not invent a host path for either named volume or create a container.
    """

    profile = prepare(
        layout,
        repo,
        image,
        runroot,
        docker,
        source_root=source_root,
        toolchain_image=toolchain_image,
        cargo_profile=cargo_profile,
        active_consumers=active_consumers,
    )
    if not isinstance(profile.get("volume_documents"), Mapping):
        raise BackendVolumeCacheError("ready cache preparation has no volume receipt")
    if not callable(maintenance):
        raise BackendVolumeCacheError("ready cache preparation requires maintenance callback")
    receipt = maintenance(profile, maintenance_overlay(profile))
    if not isinstance(receipt, Mapping):
        raise BackendVolumeCacheError("maintenance callback returned no JSON receipt")
    return validate(profile, profile["volume_documents"], receipt, active_consumers)


def _normal_volume_document(value: Any, expected_name: str) -> dict[str, Any]:
    parsed = _read_json_output(value)
    if isinstance(parsed, list):
        if len(parsed) != 1:
            raise BackendVolumeCacheError("Docker volume inspect is ambiguous")
        parsed = parsed[0]
    if not isinstance(parsed, Mapping):
        raise BackendVolumeCacheError("Docker volume inspect is not an object")
    result = dict(parsed)
    if result.get("Name") != expected_name:
        raise BackendVolumeCacheError("Docker volume name changed during inspect")
    return result


def _validate_mountpoint(value: Any) -> str:
    if not isinstance(value, str) or not value.startswith("/") or "\\" in value:
        raise BackendVolumeCacheError("named volume has no canonical Linux mountpoint")
    path = PurePosixPath(value)
    if any(part in {"", ".", ".."} for part in path.parts[1:]) or path == PurePosixPath("/"):
        raise BackendVolumeCacheError("named volume mountpoint is unsafe")
    lowered = value.lower()
    if "/run/desktop/mnt/host" in lowered or "/mnt/c" in lowered or "/mnt/d" in lowered:
        raise BackendVolumeCacheError("named volume resolves through a Windows host bind")
    return str(path)


def _validate_volume_document(
    document: Mapping[str, Any], profile: Mapping[str, Any], role: str
) -> dict[str, Any]:
    expected_name = profile["volume_names"][role]
    if document.get("Name") != expected_name or document.get("Driver") != VOLUME_DRIVER:
        raise BackendVolumeCacheError("named volume identity or driver changed")
    options = document.get("Options")
    if options not in (None, {}):
        raise BackendVolumeCacheError("backend cache named volume must not have driver options")
    if document.get("Scope") not in (None, "local"):
        raise BackendVolumeCacheError("backend cache named volume is not local")
    labels = document.get("Labels")
    if not isinstance(labels, Mapping):
        raise BackendVolumeCacheError("backend cache named volume has no labels")
    expected = volume_labels(profile, role)
    for key, value in expected.items():
        if labels.get(key) != value:
            raise BackendVolumeCacheError(f"backend cache named volume label mismatch: {key}")
    if any(key.startswith(_LABEL_PREFIX) and key not in expected for key in labels):
        raise BackendVolumeCacheError("backend cache named volume has an unexpected identity label")
    mountpoint = _validate_mountpoint(document.get("Mountpoint"))
    return {**dict(document), "Mountpoint": mountpoint, "Labels": dict(labels)}


def _validate_volume_documents(
    documents: Mapping[str, Any], profile: Mapping[str, Any]
) -> dict[str, dict[str, Any]]:
    if set(documents) != {BUILD_VOLUME_ROLE, PACKAGE_VOLUME_ROLE}:
        raise BackendVolumeCacheError("backend cache requires an exact build/package volume pair")
    result = {
        role: _validate_volume_document(documents[role], profile, role)
        for role in (BUILD_VOLUME_ROLE, PACKAGE_VOLUME_ROLE)
    }
    build_labels = result[BUILD_VOLUME_ROLE]["Labels"]
    package_labels = result[PACKAGE_VOLUME_ROLE]["Labels"]
    for key in (LABEL_SCHEMA, LABEL_PROFILE, LABEL_PROJECT, LABEL_CACHE_KEY,
                LABEL_UNIT, LABEL_WORKTREE, LABEL_TOOLCHAIN, LABEL_CARGO_PROFILE,
                LABEL_OWNER):
        if build_labels.get(key) != package_labels.get(key):
            raise BackendVolumeCacheError("build/package volume identity is not paired")
    return result


def _selected_volume_mountpoints(profile: Mapping[str, Any]) -> tuple[str, ...]:
    """Return inspected daemon mountpoints when the selected pair is known."""

    documents = profile.get("volume_documents")
    if documents is None:
        return ()
    if not isinstance(documents, Mapping):
        raise BackendVolumeCacheError("backend cache volume inventory is malformed")
    if set(documents) != {BUILD_VOLUME_ROLE, PACKAGE_VOLUME_ROLE}:
        raise BackendVolumeCacheError("backend cache volume inventory is incomplete")
    mountpoints: list[str] = []
    for role in (BUILD_VOLUME_ROLE, PACKAGE_VOLUME_ROLE):
        document = documents[role]
        if not isinstance(document, Mapping):
            raise BackendVolumeCacheError("backend cache volume inventory is malformed")
        if document.get("Name") != profile["volume_names"][role]:
            raise BackendVolumeCacheError("backend cache volume inventory changed")
        mountpoints.append(_validate_mountpoint(document.get("Mountpoint")))
    return tuple(mountpoints)


def _daemon_paths_overlap(first: str, second: str) -> bool:
    """Compare Docker daemon paths without resolving them on the host."""

    def contains(parent: str, child: str) -> bool:
        if parent == "/":
            return child.startswith("/")
        return child == parent or child.startswith(parent + "/")

    return contains(first, second) or contains(second, first)


def _linux_bind_source(value: Any) -> str | None:
    """Classify a bind source without interpreting Windows text as POSIX."""

    if not isinstance(value, str) or not value:
        raise BackendVolumeCacheError("active bind source is malformed")
    if _WINDOWS_ABSOLUTE.fullmatch(value) or value.startswith("\\\\"):
        return None
    if "\\" in value:
        raise BackendVolumeCacheError("active bind source has unsupported path format")
    if value.startswith("//"):
        value = "/" + value.lstrip("/")
    return _safe_daemon_path(value, "active bind source")


def _active_consumer_snapshot(
    source: Iterable[Mapping[str, Any]]
    | Callable[[], Iterable[Mapping[str, Any]]],
) -> tuple[Mapping[str, Any], ...]:
    inventory = source() if callable(source) else source
    if isinstance(inventory, Mapping) or isinstance(inventory, (str, bytes)):
        raise BackendVolumeCacheError("active consumer inventory is not iterable")
    try:
        return tuple(inventory)
    except TypeError as error:
        raise BackendVolumeCacheError(
            "active consumer inventory is not iterable"
        ) from error


def _assert_no_active_consumers(
    profile: Mapping[str, Any], consumers: Iterable[Mapping[str, Any]]
) -> None:
    names = set(profile["volume_names"].values())
    mountpoints = _selected_volume_mountpoints(profile)
    expected_identity = _container_labels(profile)
    exact_identity = (LABEL_OWNER, LABEL_UNIT, LABEL_CACHE_KEY)
    for document in consumers:
        if not isinstance(document, Mapping):
            raise BackendVolumeCacheError("active consumer inspect is not an object")
        state = document.get("State")
        if not isinstance(state, Mapping) or state.get("Running") is not True:
            raise BackendVolumeCacheError("active consumer inventory is not a running inspect")
        config = document.get("Config")
        if not isinstance(config, Mapping):
            raise BackendVolumeCacheError("active consumer has no config inventory")
        labels = config.get("Labels")
        if labels is None:
            labels = {}
        if not isinstance(labels, Mapping):
            raise BackendVolumeCacheError("active consumer label inventory is malformed")
        if all(labels.get(key) == expected_identity[key] for key in exact_identity):
            raise BackendVolumeCacheError(
                "backend cache has an active owned consumer"
            )
        mounts = document.get("Mounts")
        if not isinstance(mounts, list):
            raise BackendVolumeCacheError("active consumer has no mount inventory")
        for mount in mounts:
            if not isinstance(mount, Mapping):
                raise BackendVolumeCacheError("active consumer mount inventory is malformed")
            mount_type = mount.get("Type")
            if not isinstance(mount_type, str):
                raise BackendVolumeCacheError("active consumer mount type is malformed")
            if mount_type == "volume":
                name = mount.get("Name")
                if not isinstance(name, str):
                    raise BackendVolumeCacheError("active consumer volume name is malformed")
                if name in names:
                    raise BackendVolumeCacheError("active consumer mounts backend cache volume")
                source = mount.get("Source")
                if source is not None:
                    source_path = _linux_bind_source(source)
                    if source_path is not None and any(
                        _daemon_paths_overlap(source_path, mountpoint)
                        for mountpoint in mountpoints
                    ):
                        raise BackendVolumeCacheError(
                            "active consumer bind aliases backend cache volume"
                        )
            elif mount_type == "bind":
                source = _linux_bind_source(mount.get("Source"))
                if source is not None and any(
                    _daemon_paths_overlap(source, mountpoint)
                    for mountpoint in mountpoints
                ):
                    raise BackendVolumeCacheError(
                        "active consumer bind aliases backend cache volume"
                    )
            elif mount_type not in {"tmpfs", "npipe", "cluster", "image"}:
                raise BackendVolumeCacheError(
                    "active consumer mount type is unsupported"
                )


def inspect_volume_pair(
    docker: Callable[..., Any], profile: Mapping[str, Any]
) -> dict[str, dict[str, Any]]:
    """Inspect both names; callbacks must raise ``VolumeNotFound`` for absence."""

    documents: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    for role in (BUILD_VOLUME_ROLE, PACKAGE_VOLUME_ROLE):
        name = profile["volume_names"][role]
        try:
            raw = docker("volume", "inspect", name)
        except VolumeNotFound:
            missing.append(role)
            continue
        documents[role] = _normal_volume_document(raw, name)
    if missing and documents:
        raise BackendVolumeCacheError("backend cache has a partial volume pair")
    if missing:
        return {}
    return _validate_volume_documents(documents, profile)


def _create_volume(docker: Callable[..., Any], profile: Mapping[str, Any], role: str) -> None:
    name = profile["volume_names"][role]
    args: list[str] = ["volume", "create", "--driver", VOLUME_DRIVER]
    for key, value in volume_labels(profile, role).items():
        args.extend(("--label", f"{key}={value}"))
    # Deliberately no --opt/--mount/device argument: local named volume must
    # remain in the Docker Engine VM, never point at a Windows bind.
    args.append(name)
    result = docker(*args)
    if isinstance(result, str) and result.strip() and result.strip() != name:
        raise BackendVolumeCacheError("Docker created a different backend cache volume")


def ensure_volume_pair(
    docker: Callable[..., Any],
    profile: Mapping[str, Any],
    *,
    active_consumers: Iterable[Mapping[str, Any]]
    | Callable[[], Iterable[Mapping[str, Any]]] = (),
) -> dict[str, dict[str, Any]]:
    """Create only a completely missing exact pair and return its inspect docs."""

    if callable(active_consumers):
        consumer_snapshot = lambda: _active_consumer_snapshot(active_consumers)
    else:
        fixed_consumers = _active_consumer_snapshot(active_consumers)
        consumer_snapshot = lambda: fixed_consumers
    initial_consumers = consumer_snapshot()
    existing = inspect_volume_pair(docker, profile)
    checked_profile = dict(profile)
    if existing:
        checked_profile["volume_documents"] = existing
    _assert_no_active_consumers(checked_profile, initial_consumers)
    if existing:
        _assert_no_active_consumers(checked_profile, consumer_snapshot())
        return existing
    for role in (BUILD_VOLUME_ROLE, PACKAGE_VOLUME_ROLE):
        _create_volume(docker, profile, role)
    created = _validate_volume_documents(inspect_volume_pair(docker, profile), profile)
    checked_profile["volume_documents"] = created
    _assert_no_active_consumers(checked_profile, consumer_snapshot())
    return created


def _validate_marker(marker: Any, profile: Mapping[str, Any], role: str) -> None:
    if not isinstance(marker, Mapping):
        raise BackendVolumeCacheError("maintenance receipt has no owner marker")
    expected = {
        "schema": OWNER_SCHEMA,
        "state": "owned",
        "unit_key": profile["unit_key"],
        "owner_id": profile["owner_id"],
        "role": role,
        "volume_name": profile["volume_names"][role],
        "uid": 65532,
        "gid": 65532,
    }
    if any(marker.get(key) != value for key, value in expected.items()):
        raise BackendVolumeCacheError("maintenance owner marker is foreign or incomplete")


def _validate_maintenance_receipt(
    receipt: Mapping[str, Any], profile: Mapping[str, Any]
) -> dict[str, Any]:
    if not isinstance(receipt, Mapping):
        raise BackendVolumeCacheError("maintenance receipt is not an object")
    required = {
        "schema", "profile", "state", "project_id", "cache_key",
        "unit_key", "owner_id", "cargo_profile", "runtime_image_id",
        "toolchain_image_id", "volume_names", "markers", "probe",
    }
    if not required.issubset(receipt):
        raise BackendVolumeCacheError("maintenance receipt is incomplete")
    if (receipt["schema"] != MAINTENANCE_RECEIPT_SCHEMA
            or receipt["profile"] != PROFILE
            or receipt["state"] != "ready"):
        raise BackendVolumeCacheError("maintenance receipt schema/state mismatch")
    if (receipt["project_id"] != profile["project_id"]
            or receipt["cache_key"] != profile["cache_key"]
            or receipt["cargo_profile"] != profile["cargo_profile"]):
        raise BackendVolumeCacheError("maintenance receipt cache identity mismatch")
    if (receipt["runtime_image_id"] != profile["runtime_image_id"]
            or receipt["toolchain_image_id"] != profile["toolchain_image_id"]):
        raise BackendVolumeCacheError("maintenance receipt image identity mismatch")
    if receipt["unit_key"] != profile["unit_key"] or receipt["owner_id"] != profile["owner_id"]:
        raise BackendVolumeCacheError("maintenance receipt owner identity mismatch")
    if receipt["volume_names"] != profile["volume_names"]:
        raise BackendVolumeCacheError("maintenance receipt volume pair mismatch")
    markers = receipt["markers"]
    if not isinstance(markers, Mapping) or set(markers) != {BUILD_VOLUME_ROLE, PACKAGE_VOLUME_ROLE}:
        raise BackendVolumeCacheError("maintenance receipt has an incomplete marker pair")
    for role in (BUILD_VOLUME_ROLE, PACKAGE_VOLUME_ROLE):
        _validate_marker(markers[role], profile, role)
    probe = receipt["probe"]
    if (not isinstance(probe, Mapping)
            or probe.get("schema") != PROBE_SCHEMA
            or probe.get("state") != "passed"
            or probe.get("owner_uid") != 65532
            or probe.get("owner_gid") != 65532):
        raise BackendVolumeCacheError("maintenance readback probe did not pass")
    probes = probe.get("volumes")
    if not isinstance(probes, Mapping) or set(probes) != {BUILD_VOLUME_ROLE, PACKAGE_VOLUME_ROLE}:
        raise BackendVolumeCacheError("maintenance probe has an incomplete volume pair")
    for role in (BUILD_VOLUME_ROLE, PACKAGE_VOLUME_ROLE):
        result = probes[role]
        if not isinstance(result, Mapping) or any(
            result.get(name) is not True
            for name in ("regular_marker", "writable", "readonly_reopen", "no_reparse")
        ):
            raise BackendVolumeCacheError("maintenance probe did not prove the owned volume")
    return dict(receipt)


def _validate_receipt_parent(path: Path) -> None:
    if path.is_symlink() or not path.parent.is_dir() or path.parent.is_symlink():
        raise BackendVolumeCacheError("backend cache receipt path is not a regular canonical path")
    cursor = path.parent
    while cursor != cursor.parent:
        if cursor.is_symlink():
            raise BackendVolumeCacheError("backend cache receipt parent contains a symlink")
        cursor = cursor.parent


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    _validate_receipt_parent(path)
    raw = _canonical_bytes(value) + b"\n"
    temporary = path.parent / f".{path.name}.{os.getpid()}.tmp"
    if temporary.exists() or temporary.is_symlink():
        raise BackendVolumeCacheError("backend cache receipt temporary path already exists")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary, flags, 0o600)
    try:
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
            if written <= 0:
                raise BackendVolumeCacheError("backend cache receipt short write")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    try:
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        # Windows has no portable directory-fsync primitive.  The file was
        # fsynced before replace; retain that publication while keeping POSIX
        # directory durability failures fatal.
        if os.name != "nt":
            raise
    else:
        try:
            try:
                os.fsync(directory)
            except OSError:
                if os.name != "nt":
                    raise
        finally:
            os.close(directory)


def validate(
    profile: Mapping[str, Any],
    volume_documents: Mapping[str, Any] | None,
    maintenance_receipt: Mapping[str, Any],
    active_consumers: Iterable[Mapping[str, Any]]
    | Callable[[], Iterable[Mapping[str, Any]]] = (),
    *,
    receipt_path: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Admit exact inspected volumes and a fixed maintenance probe receipt."""

    if profile.get("schema") != SCHEMA or profile.get("profile") != PROFILE:
        raise BackendVolumeCacheError("unsupported backend volume cache profile")
    documents = (profile.get("volume_documents")
                 if volume_documents is None else volume_documents)
    if not isinstance(documents, Mapping):
        raise BackendVolumeCacheError("backend volume cache has no host volume receipt")
    inspected = _validate_volume_documents(documents, profile)
    checked_profile = dict(profile)
    checked_profile["volume_documents"] = inspected
    _assert_no_active_consumers(
        checked_profile, _active_consumer_snapshot(active_consumers)
    )
    maintenance = _validate_maintenance_receipt(maintenance_receipt, profile)
    path = Path(receipt_path or profile["receipt_path"])
    expected_path = Path(profile["receipt_path"])
    if path != expected_path:
        raise BackendVolumeCacheError("backend cache receipt must use the canonical run path")
    receipt = {
        "schema": SCHEMA,
        "profile": PROFILE,
        "state": "ready",
        "project_id": profile["project_id"],
        "worktree_id": profile["worktree_id"],
        "cache_key": profile["cache_key"],
        "unit_key": profile["unit_key"],
        "owner_id": profile["owner_id"],
        "cargo_profile": profile["cargo_profile"],
        "runtime_image_id": profile["runtime_image_id"],
        "toolchain_image_id": profile["toolchain_image_id"],
        "volume_names": dict(profile["volume_names"]),
        "mounts": list(profile["mounts"]),
        "package_root": PACKAGE_TARGET,
        "build_root": BUILD_TARGET,
        "volume_documents": inspected,
        "maintenance_receipt": maintenance,
        "host_receipt_path": str(path),
    }
    _write_json(path, receipt)
    result = dict(profile)
    result.update({
        "state": "ready",
        "volume_documents": inspected,
        "maintenance_receipt": maintenance,
        "receipt_path": str(path),
        "host_receipt_path": str(path),
        "receipt": receipt,
    })
    result["overlay"] = overlay(result)
    result["maintenance_overlay"] = maintenance_overlay(result)
    return result


def overlay(profile: Mapping[str, Any]) -> dict[str, Any]:
    """Render the runtime overlay containing only backend and named volumes."""

    if profile.get("schema") != SCHEMA or profile.get("profile") != PROFILE:
        raise BackendVolumeCacheError("unsupported backend volume cache profile")
    document = {
        "volumes": _volume_declarations(profile),
        "services": {
            BACKEND_SERVICE: {
                "labels": _container_labels(profile),
                "environment": dict(profile.get("environment") or _cache_environment(profile)),
                "volumes": _mount_specs(profile),
            },
        },
    }
    validate_overlay(document, profile)
    return document


def maintenance_overlay(profile: Mapping[str, Any]) -> dict[str, Any]:
    """Render the one-shot maintenance service as a separate overlay."""

    if profile.get("schema") != SCHEMA or profile.get("profile") != PROFILE:
        raise BackendVolumeCacheError("unsupported backend volume cache profile")
    document = {
        "volumes": _volume_declarations(profile),
        "services": {MAINTENANCE_SERVICE: _maintenance_service(profile)},
    }
    validate_maintenance_overlay(document, profile)
    return document


def _validate_volume_declarations(
    volumes: Any, profile: Mapping[str, Any]
) -> None:
    if not isinstance(volumes, Mapping) or set(volumes) != {
        COMPOSE_BUILD_VOLUME, COMPOSE_PACKAGE_VOLUME
    }:
        raise BackendVolumeCacheError("volume cache overlay has an incomplete volume declaration")
    for key, role in ((COMPOSE_BUILD_VOLUME, BUILD_VOLUME_ROLE),
                      (COMPOSE_PACKAGE_VOLUME, PACKAGE_VOLUME_ROLE)):
        declaration = volumes[key]
        if (not isinstance(declaration, Mapping)
                or declaration.get("name") != profile["volume_names"][role]
                or declaration.get("external") is not True
                or any(name in declaration for name in ("driver", "driver_opts", "device"))):
            raise BackendVolumeCacheError("volume cache overlay volume declaration is unsafe")


def _validate_service_labels(service: Mapping[str, Any], profile: Mapping[str, Any]) -> None:
    labels = service.get("labels")
    if not isinstance(labels, Mapping):
        raise BackendVolumeCacheError("volume cache service labels are missing")
    expected = _container_labels(profile)
    for key, value in expected.items():
        if labels.get(key) != value:
            raise BackendVolumeCacheError(f"volume cache service label mismatch: {key}")
    if any(key.startswith(_LABEL_PREFIX) and key not in expected for key in labels):
        raise BackendVolumeCacheError("volume cache service has an unexpected identity label")


def validate_overlay(document: Mapping[str, Any], profile: Mapping[str, Any]) -> None:
    """Validate the runtime overlay without creating a maintenance service."""

    services = document.get("services")
    if not isinstance(services, Mapping) or set(services) != {BACKEND_SERVICE}:
        raise BackendVolumeCacheError("volume cache overlay has unexpected services")
    _validate_volume_declarations(document.get("volumes"), profile)
    backend = services[BACKEND_SERVICE]
    if not isinstance(backend, Mapping):
        raise BackendVolumeCacheError("volume cache backend service is malformed")
    _validate_service_labels(backend, profile)
    if backend.get("volumes") != _mount_specs(profile):
        raise BackendVolumeCacheError("volume cache backend mounts are not exact")
    environment = backend.get("environment")
    if not isinstance(environment, Mapping):
        raise BackendVolumeCacheError("volume cache backend environment is missing")
    for key, value in _cache_environment(profile).items():
        if environment.get(key) != value:
            raise BackendVolumeCacheError(f"volume cache environment mismatch: {key}")


def validate_maintenance_overlay(document: Mapping[str, Any], profile: Mapping[str, Any]) -> None:
    """Validate the separate privileged-but-bounded maintenance overlay."""

    services = document.get("services")
    if not isinstance(services, Mapping) or set(services) != {MAINTENANCE_SERVICE}:
        raise BackendVolumeCacheError("maintenance overlay has unexpected services")
    _validate_volume_declarations(document.get("volumes"), profile)
    maintenance = services[MAINTENANCE_SERVICE]
    if not isinstance(maintenance, Mapping):
        raise BackendVolumeCacheError("volume cache maintenance service is malformed")
    _validate_service_labels(maintenance, profile)
    maintenance_environment = maintenance.get("environment")
    if not isinstance(maintenance_environment, Mapping):
        raise BackendVolumeCacheError("volume cache maintenance environment is missing")
    expected_maintenance = {
        "FULLMAG_BACKEND_CACHE_MAINTENANCE_PROFILE": MAINTENANCE_PROFILE,
        "FULLMAG_BACKEND_CACHE_MAINTENANCE_ACTION": "ensure",
        "FULLMAG_BACKEND_CACHE_OWNER_UID": "65532",
        "FULLMAG_BACKEND_CACHE_OWNER_GID": "65532",
    }
    for key, value in expected_maintenance.items():
        if maintenance_environment.get(key) != value:
            raise BackendVolumeCacheError(f"maintenance environment mismatch: {key}")
    if (maintenance.get("image") != profile["runtime_image_id"]
            or maintenance.get("pull_policy") != "never"
            or maintenance.get("restart") != "no"):
        raise BackendVolumeCacheError("volume cache maintenance image policy changed")
    maintenance_pid = maintenance.get("pid")
    if (maintenance.get("read_only") is not True
            or maintenance.get("privileged") is not False
            or maintenance.get("network_mode") != "none"
            or maintenance.get("user") != "0:0"
            or maintenance.get("cap_drop") != ["ALL"]
            or maintenance.get("cap_add") != ["CHOWN"]
            or maintenance.get("security_opt") != ["no-new-privileges:true"]
            or "gpus" in maintenance
            or (isinstance(maintenance_pid, str)
                and maintenance_pid in {"host", "container"})):
        raise BackendVolumeCacheError("volume cache maintenance isolation changed")
    if maintenance.get("volumes") != _mount_specs(profile):
        raise BackendVolumeCacheError("volume cache maintenance mounts are not exact")
    if maintenance.get("entrypoint") != list(MAINTENANCE_ENTRYPOINT) or maintenance.get("command") != ["ensure"]:
        raise BackendVolumeCacheError("volume cache maintenance entrypoint changed")
    for key, value in _cache_environment(profile).items():
        if maintenance_environment.get(key) != value:
            raise BackendVolumeCacheError(f"maintenance environment mismatch: {key}")


def validate_container(document: Mapping[str, Any], profile: Mapping[str, Any]) -> dict[str, Any]:
    """Fail closed unless the backend owns exactly the two named volume mounts."""

    if profile.get("schema") != SCHEMA or profile.get("state") != "ready":
        raise BackendVolumeCacheError("backend volume cache profile is not ready")
    config = document.get("Config")
    if not isinstance(config, Mapping):
        raise BackendVolumeCacheError("backend container has no config")
    if config.get("User") not in {"65532", "65532:65532"}:
        raise BackendVolumeCacheError("backend container is not unprivileged")
    host_config = document.get("HostConfig")
    if not isinstance(host_config, Mapping):
        raise BackendVolumeCacheError("backend container has no host isolation inventory")
    network_mode = host_config.get("NetworkMode")
    pid_mode = host_config.get("PidMode")
    if (host_config.get("ReadonlyRootfs") is not True
        or host_config.get("Privileged") is not False
        or network_mode == "host"
        or pid_mode == "host"
        or (isinstance(network_mode, str) and network_mode.startswith("container:"))
        or (isinstance(pid_mode, str) and pid_mode.startswith("container:"))
    ):
        raise BackendVolumeCacheError("backend container isolation changed")
    env = {}
    for value in config.get("Env", []):
        if isinstance(value, str) and "=" in value:
            key, item = value.split("=", 1)
            env[key] = item
    for key, value in _cache_environment(profile).items():
        if env.get(key) != value:
            raise BackendVolumeCacheError(f"backend container cache environment mismatch: {key}")
    labels = config.get("Labels")
    if not isinstance(labels, Mapping):
        raise BackendVolumeCacheError("backend container has no cache labels")
    expected_labels = _container_labels(profile)
    for key, value in expected_labels.items():
        if labels.get(key) != value:
            raise BackendVolumeCacheError(f"backend container label mismatch: {key}")
    if any(key.startswith(_LABEL_PREFIX) and key not in expected_labels for key in labels):
        raise BackendVolumeCacheError("backend container has an unexpected identity label")
    mounts = document.get("Mounts")
    if not isinstance(mounts, list):
        raise BackendVolumeCacheError("backend container has no mount inventory")
    binds = host_config.get("Binds")
    if binds is not None and not isinstance(binds, list):
        raise BackendVolumeCacheError("backend container bind inventory is malformed")
    if isinstance(binds, list) and any(
        isinstance(item, str)
        and any(socket_path in item.split(":", 1)[0] for socket_path in ("/var/run/docker.sock", "/run/docker.sock"))
        for item in binds
    ):
        raise BackendVolumeCacheError("backend container exposes the Docker socket")
    expected = {
        BUILD_TARGET: profile["volume_names"][BUILD_VOLUME_ROLE],
        PACKAGE_TARGET: profile["volume_names"][PACKAGE_VOLUME_ROLE],
    }
    matching: dict[str, Mapping[str, Any]] = {}
    for mount in mounts:
        if not isinstance(mount, Mapping):
            raise BackendVolumeCacheError("backend container mount inventory is malformed")
        target = mount.get("Destination", mount.get("destination"))
        source = mount.get("Source", mount.get("source"))
        if (target in {"/var/run/docker.sock", "/run/docker.sock"}
                or source in {"/var/run/docker.sock", "/run/docker.sock"}):
            raise BackendVolumeCacheError("backend container exposes the Docker socket")
        if target not in expected:
            continue
        if target in matching:
            raise BackendVolumeCacheError("backend container has duplicate cache mount")
        if (mount.get("Type", mount.get("type")) != "volume"
                or mount.get("Name", mount.get("name")) != expected[target]
                or mount.get("RW", True) is False
                or mount.get("read_only") is True):
            raise BackendVolumeCacheError("backend container cache mount identity changed")
        matching[target] = mount
    if set(matching) != set(expected):
        raise BackendVolumeCacheError("backend container is missing a cache volume mount")
    return {
        "schema": SCHEMA,
        "state": "attested",
        "unit_key": profile["unit_key"],
        "volume_names": dict(profile["volume_names"]),
        "targets": {BUILD_VOLUME_ROLE: BUILD_TARGET, PACKAGE_VOLUME_ROLE: PACKAGE_TARGET},
    }
