"""Retire only private Docker build state for one completed Fullmag worktree.

The caller must first prove registry ownership/integration. This module requires
the selected Compose group to have no retained containers, records an immutable
plan under its BuildControl lease, and never removes a shared volume.
"""

from __future__ import annotations

import hashlib
import json
import re
import posixpath
from pathlib import Path
from typing import Any, Callable, Mapping

from docker_build_control import MIN_FREE_CONTROL_BYTES, docker_capture
from docker_named_volume_safety import (
    DockerNamedVolumeSafetyError,
    validate_local_named_volume,
)

PLAN_SCHEMA = "fullmag.docker-cache-retirement-plan.v1"
CLOSING_SCHEMA = "fullmag.docker-cache-retirement-closing.v1"
RESULT_SCHEMA = "fullmag.docker-cache-retirement.v1"
NAMESPACE_RESULT_SCHEMA = "fullmag.backend-shared-group-retirement.v1"
PLAN_PATH = "cache-retirement/plan.json"
CLOSING_PATH = "cache-retirement/closing.json"
NAMESPACE_RESULT_PATH = "cache-retirement/namespaces.json"
RESULT_PATH = "cache-retirement/result.json"
_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_CONTAINER_ID = re.compile(r"^[0-9a-f]{64}$")
_VOLUME_NAME = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,199}$")
_V1_FRONTEND = re.compile(r"^fullmag-dev-frontend-v1-([0-9a-f]{24})$")


class CacheRetirementError(RuntimeError):
    """Retirement could not prove an exact safe target or outcome."""


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise CacheRetirementError(f"{label} is missing or malformed")
    return value


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise CacheRetirementError(f"{label} is malformed")
    return value


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _capture(args: tuple[str, ...], docker: Callable[..., Any] | None) -> tuple[int, str, str]:
    try:
        result = (docker(*args) if docker is not None
                  else docker_capture(*args, allow_failure=True))
    except Exception as error:
        raise CacheRetirementError(f"Docker command failed: {' '.join(args[:3])}: {error}") from error
    if isinstance(result, str):
        return 0, result, ""
    code = getattr(result, "returncode", None)
    stdout = getattr(result, "stdout", None)
    stderr = getattr(result, "stderr", None)
    if type(code) is not int:
        raise CacheRetirementError("Docker callback returned no process status")
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", "replace")
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", "replace")
    if not isinstance(stdout, str) or not isinstance(stderr, str):
        raise CacheRetirementError("Docker callback returned malformed output")
    return code, stdout, stderr


def _run(args: tuple[str, ...], docker: Callable[..., Any] | None) -> str:
    code, stdout, stderr = _capture(args, docker)
    if code:
        raise CacheRetirementError(
            f"Docker command failed ({code}): {' '.join(args[:3])}: {stderr.strip()[:500]}"
        )
    return stdout


def _list_volumes(filters: Mapping[str, str], docker: Callable[..., Any] | None) -> list[str]:
    args: list[str] = ["volume", "ls", "--quiet"]
    for key, value in filters.items():
        args.extend(("--filter", f"label={key}={value}"))
    names = [line.strip() for line in _run(tuple(args), docker).splitlines() if line.strip()]
    if len(names) > 4096 or len(names) != len(set(names)):
        raise CacheRetirementError("Docker volume inventory is oversized or ambiguous")
    if any(_VOLUME_NAME.fullmatch(name) is None for name in names):
        raise CacheRetirementError("Docker returned an invalid volume name")
    return sorted(names)


def _inspect_volume(name: str, docker: Callable[..., Any] | None) -> dict[str, Any] | None:
    code, stdout, stderr = _capture(("volume", "inspect", name), docker)
    if code:
        lowered = stderr.lower()
        if "no such volume" in lowered or "no such object" in lowered or "volume not found" in lowered:
            return None
        raise CacheRetirementError(f"Volume inspection failed for {name}: {stderr.strip()[:500]}")
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise CacheRetirementError(f"Volume inspection is invalid JSON for {name}") from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], Mapping):
        raise CacheRetirementError(f"Volume inspection is ambiguous for {name}")
    document = dict(value[0])
    if document.get("Name") != name:
        raise CacheRetirementError(f"Volume identity changed for {name}")
    try:
        validate_local_named_volume(document, name)
    except DockerNamedVolumeSafetyError as error:
        raise CacheRetirementError(f"Unsafe Docker volume {name}: {error}") from error
    labels = document.get("Labels")
    if not isinstance(labels, Mapping):
        raise CacheRetirementError(f"Volume labels are malformed for {name}")
    return document


def _container_inventory(docker: Callable[..., Any] | None) -> list[dict[str, Any]]:
    ids = [line.strip() for line in _run(("ps", "--all", "--no-trunc", "--quiet"), docker).splitlines()
           if line.strip()]
    if len(ids) > 8192 or len(ids) != len(set(ids)) or any(_CONTAINER_ID.fullmatch(item) is None for item in ids):
        raise CacheRetirementError("Docker container inventory is oversized or ambiguous")
    if not ids:
        return []
    raw = _run(("inspect", *ids), docker)
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as error:
        raise CacheRetirementError("Docker container inventory is invalid JSON") from error
    if not isinstance(values, list) or len(values) != len(ids):
        raise CacheRetirementError("Docker container inventory is incomplete")
    documents: list[dict[str, Any]] = []
    for item in values:
        if not isinstance(item, Mapping) or not _CONTAINER_ID.fullmatch(str(item.get("Id", ""))):
            raise CacheRetirementError("Docker container inspect is malformed")
        config = item.get("Config")
        mounts = item.get("Mounts")
        labels = config.get("Labels") if isinstance(config, Mapping) else None
        if not isinstance(config, Mapping) or (labels is not None and not isinstance(labels, Mapping)):
            raise CacheRetirementError("Docker container has no complete label inventory")
        if not isinstance(mounts, list) or any(
            not isinstance(mount, Mapping)
            or mount.get("Type") not in {"volume", "bind", "tmpfs", "npipe"}
            or (mount.get("Type") == "volume" and not isinstance(mount.get("Name"), str))
            for mount in mounts
        ):
            raise CacheRetirementError("Docker container has no complete mount inventory")
        normalized = dict(item)
        normalized["Config"] = {**dict(config), "Labels": dict(labels or {})}
        documents.append(normalized)
    if {item["Id"] for item in documents} != set(ids):
        raise CacheRetirementError("Docker container inventory changed during inspection")
    return documents


def _identity(control: Any, layout: Mapping[str, Any]) -> dict[str, str]:
    identity = _mapping(getattr(control, "identity", None), "BuildControl identity")
    worktree_id = _text(layout.get("worktree_id"), "worktree_id")
    if _ID.fullmatch(worktree_id) is None:
        raise CacheRetirementError("worktree_id is not a safe registered identifier")
    if identity.get("checkout_kind") != "worktree" or worktree_id == "master":
        raise CacheRetirementError("Cache retirement is allowed only for a registered non-master worktree")
    source_root = str(Path(_text(layout.get("repo_root"), "repo_root")).resolve(strict=True))
    project_id = layout.get("project_id")
    environment = layout.get("env")
    if project_id is None and isinstance(environment, Mapping):
        project_id = environment.get("FULLMAG_PROJECT_ID")
    if not isinstance(project_id, str) or _ID.fullmatch(project_id) is None:
        raise CacheRetirementError("Resolved Fullmag project_id is invalid")
    if (identity.get("worktree_id") != worktree_id
            or identity.get("project_id") != project_id
            or identity.get("source_root") != source_root):
        raise CacheRetirementError("BuildControl identity differs from the selected registered worktree")
    project = _text(getattr(control, "project", None), "Compose project")
    segment = re.sub(r"[^a-z0-9_-]+", "-", worktree_id).strip("-")
    if project != f"fullmag-worktree-{segment}":
        raise CacheRetirementError("Compose project is not the exact worktree project")
    return {"worktree_id": worktree_id, "source_root": source_root,
            "project_id": project_id, "compose_project": project}


def _group_match(document: Mapping[str, Any], identity: Mapping[str, str]) -> bool:
    labels = document["Config"]["Labels"]
    return (
        labels.get("org.fullmag.source.worktree-id") == identity["worktree_id"]
        or labels.get("org.fullmag.compose.project") == identity["compose_project"]
        or labels.get("com.docker.compose.project") == identity["compose_project"]
    )


def _check_group_empty(
    documents: list[dict[str, Any]], identity: Mapping[str, str], allowed_helpers: set[str] = frozenset()
) -> None:
    for document in documents:
        labels = document["Config"]["Labels"]
        if not _group_match(document, identity):
            continue
        if document["Id"] not in allowed_helpers:
            raise CacheRetirementError(
                "Worktree Compose group still has retained containers; drain and remove all services/helpers first"
            )
        if (labels.get("com.docker.compose.project") != identity["compose_project"]
                or labels.get("org.fullmag.compose.project") != identity["compose_project"]
                or labels.get("org.fullmag.source.project-id") != identity["project_id"]
                or labels.get("org.fullmag.source.worktree-id") != identity["worktree_id"]
                or labels.get("org.fullmag.source.checkout-kind") != "worktree"):
            raise CacheRetirementError("Retirement helper container identity is not exact")


def _expected_backend_profile(control: Any, layout: Mapping[str, Any], identity: Mapping[str, str],
                              labels: Mapping[str, Any], role: str) -> dict[str, Any]:
    import docker_backend_volume_cache as cache

    worktree = labels.get(cache.LABEL_WORKTREE)
    cache_key = labels.get(cache.LABEL_CACHE_KEY)
    toolchain = labels.get(cache.LABEL_TOOLCHAIN)
    cargo_profile = labels.get(cache.LABEL_CARGO_PROFILE)
    unit = labels.get(cache.LABEL_UNIT)
    if (worktree != identity["worktree_id"] or not isinstance(cache_key, str) or _SHA.fullmatch(cache_key) is None
            or not isinstance(toolchain, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", toolchain)
            or cargo_profile not in cache.SUPPORTED_CARGO_PROFILES
            or not isinstance(unit, str) or _SHA.fullmatch(unit) is None):
        raise CacheRetirementError("Backend cache volume identity labels are incomplete")
    project_layout = {**dict(layout), "project_id": identity["project_id"],
                      "compose_project": identity["compose_project"]}
    shared_packages = role == cache.BUILD_VOLUME_ROLE
    try:
        profile = cache._plan(
            project_layout, identity["source_root"], toolchain, layout["storage_root"],
            source_root=identity["source_root"], toolchain_image=toolchain,
            cargo_profile=cargo_profile, control_volume_name=control.volume,
            control_namespace=getattr(control, "namespace", ""),
            shared_packages=shared_packages,
        )
        if profile["cache_key"] != cache_key or profile["unit_key"] != unit:
            raise CacheRetirementError("Backend cache key/unit does not derive from this worktree")
        expected = cache.volume_labels(profile, role)
        if dict(labels) != expected:
            raise CacheRetirementError("Backend cache volume labels are not exact")
        return profile
    except cache.BackendVolumeCacheError as error:
        raise CacheRetirementError(f"Backend cache profile is invalid: {error}") from error


def _backend_volumes(control: Any, layout: Mapping[str, Any], identity: Mapping[str, str],
                     docker: Callable[..., Any] | None, *, allow_orphan_packages: bool = False
                     ) -> tuple[list[dict[str, Any]], list[str]]:
    import docker_backend_volume_cache as cache

    # Scope loosely enough to notice malformed identity labels for this
    # exact project and worktree, then validate the complete set below.
    filters = {cache.LABEL_PROJECT: identity["project_id"],
               cache.LABEL_WORKTREE: identity["worktree_id"]}
    names = _list_volumes(filters, docker)
    builds: dict[str, dict[str, Any]] = {}
    packages: list[dict[str, Any]] = []
    for name in names:
        document = _inspect_volume(name, docker)
        if document is None:
            raise CacheRetirementError(f"Backend cache volume disappeared during inventory: {name}")
        labels = document["Labels"]
        role = labels.get(cache.LABEL_ROLE)
        if role not in {cache.BUILD_VOLUME_ROLE, cache.PACKAGE_VOLUME_ROLE}:
            raise CacheRetirementError(f"Unknown backend cache volume role; retained: {name}")
        profile = _expected_backend_profile(control, layout, identity, labels, role)
        if name != profile["volume_names"][role]:
            raise CacheRetirementError(f"Backend cache volume name is not derived from its identity: {name}")
        try:
            cache._validate_volume_document(document, profile, role)
        except cache.BackendVolumeCacheError as error:
            raise CacheRetirementError(f"Backend cache volume is not exact: {name}: {error}") from error
        item = {"name": name, "kind": "backend-build" if role == cache.BUILD_VOLUME_ROLE else "backend-package",
                "unit_key": profile["unit_key"], "labels": dict(labels),
                "mountpoint": document["Mountpoint"]}
        if role == cache.BUILD_VOLUME_ROLE:
            if item["unit_key"] in builds:
                raise CacheRetirementError("Duplicate backend build cache unit identity")
            builds[item["unit_key"]] = item
        else:
            packages.append(item)
    for package in packages:
        if not allow_orphan_packages and package["unit_key"] not in builds:
            raise CacheRetirementError("Private backend package volume has no verified build-volume owner")
    return sorted([*builds.values(), *packages], key=lambda item: (item["kind"], item["name"])), sorted(builds)


def _frontend_volumes(control: Any, identity: Mapping[str, str],
                      docker: Callable[..., Any] | None) -> list[dict[str, Any]]:
    from docker_frontend_cache import (
        PROFILE, SCHEMA, VOLUME_KEY_LABEL, VOLUME_PROFILE_LABEL,
        VOLUME_PROJECT_LABEL, VOLUME_SCHEMA_LABEL, _v2_volume_name,
    )

    result: dict[str, dict[str, Any]] = {}
    v2_prefix = identity["compose_project"] + "-fullmag-frontend-dev-v2-"
    v2_hash = hashlib.sha256(identity["compose_project"].encode("utf-8")).hexdigest()[:24]
    v2_hashed_prefix = f"fullmag-fe-v2-{v2_hash}-"
    # Catch both malformed names with our project prefix and valid v2 identity
    # labels attached to a renamed volume.
    v2_filters = {VOLUME_SCHEMA_LABEL: SCHEMA, VOLUME_PROFILE_LABEL: PROFILE,
                  VOLUME_PROJECT_LABEL: identity["compose_project"]}
    candidates = set(_list_volumes(v2_filters, docker))
    candidates.update(name for name in _list_volumes({}, docker)
                      if name.startswith((v2_prefix, v2_hashed_prefix)))
    for name in sorted(candidates):
        document = _inspect_volume(name, docker)
        if document is None:
            raise CacheRetirementError(f"Frontend v2 volume disappeared during inventory: {name}")
        labels = document["Labels"]
        key = labels.get(VOLUME_KEY_LABEL)
        expected = {VOLUME_SCHEMA_LABEL: SCHEMA, VOLUME_PROFILE_LABEL: PROFILE,
                    VOLUME_PROJECT_LABEL: identity["compose_project"], VOLUME_KEY_LABEL: key}
        if (not isinstance(key, str) or _SHA.fullmatch(key) is None or dict(labels) != expected
                or name != _v2_volume_name(identity["compose_project"], key)):
            raise CacheRetirementError(f"Frontend v2 volume identity is not exact: {name}")
        result[name] = {"name": name, "kind": "frontend-v2", "labels": dict(labels),
                        "mountpoint": document["Mountpoint"]}

    labels_from_control = {
        key: value for key, value in _mapping(getattr(control, "labels", None), "BuildControl labels").items()
        if isinstance(key, str) and key.startswith("org.fullmag.")
    }
    v1_filters = {**labels_from_control, "org.fullmag.build.role": "frontend"}
    for name in _list_volumes(v1_filters, docker):
        document = _inspect_volume(name, docker)
        if document is None:
            raise CacheRetirementError(f"Legacy frontend volume disappeared during inventory: {name}")
        labels = document["Labels"]
        match = _V1_FRONTEND.fullmatch(name)
        key = labels.get("org.fullmag.build.cache-key")
        expected = {**labels_from_control, "org.fullmag.build.role": "frontend",
                    "org.fullmag.build.cache-key": key}
        if (match is None or not isinstance(key, str) or _SHA.fullmatch(key) is None
                or match.group(1) != key[:24] or dict(labels) != expected):
            raise CacheRetirementError(f"Legacy frontend volume ownership is not exact: {name}")
        result[name] = {"name": name, "kind": "frontend-v1", "labels": dict(labels),
                        "mountpoint": document["Mountpoint"]}
    return sorted(result.values(), key=lambda item: (item["kind"], item["name"]))


def _shared_package(control: Any, identity: Mapping[str, str], docker: Callable[..., Any] | None):
    import docker_shared_build_storage as shared

    name = shared.shared_volume_names(identity["project_id"])[shared.PACKAGE_ROLE]
    document = _inspect_volume(name, docker)
    if document is None:
        return None
    try:
        validated = shared.validate_volume_document(document, identity["project_id"], shared.PACKAGE_ROLE)
    except shared.SharedBuildStorageError as error:
        raise CacheRetirementError(f"Shared package volume identity is unsafe: {error}") from error
    return {"name": name, "labels": dict(validated["Labels"]), "mountpoint": validated["Mountpoint"]}


def _safe_subpath(cache: Any, document: Mapping[str, Any], mount: Mapping[str, Any],
                  target: str, name: str, mountpoint: str) -> str:
    try:
        return cache._observed_volume_subpath(document, mount, target, name, mountpoint)
    except cache.BackendVolumeCacheError as error:
        raise CacheRetirementError(f"Shared package consumer subpath is unknown: {error}") from error


def _registered_other_shared_consumer(document: Mapping[str, Any], identity: Mapping[str, str],
                                      shared_doc: Mapping[str, Any], retiring_units: set[str]) -> None:
    import docker_backend_volume_cache as cache

    labels = document["Config"]["Labels"]
    env_items = document["Config"].get("Env")
    if not isinstance(env_items, list) or any(not isinstance(item, str) for item in env_items):
        raise CacheRetirementError("Shared package consumer environment is malformed")
    environment = dict(item.split("=", 1) for item in env_items if "=" in item)
    volume = shared_doc["name"]
    mounts = [mount for mount in document["Mounts"] if mount.get("Type") == "volume" and mount.get("Name") == volume]
    unit = labels.get(cache.LABEL_UNIT)
    if worktree := labels.get(cache.LABEL_WORKTREE):
        if worktree == identity["worktree_id"]:
            raise CacheRetirementError("A container still consumes the retiring worktree's shared package namespace")
    if isinstance(unit, str) and unit in retiring_units:
        raise CacheRetirementError("A container still consumes a retiring groups/<unit_key> namespace")
    maintenance = cache._is_registered_shared_maintenance(document["Config"], labels, identity["project_id"])
    compose_project = labels.get("com.docker.compose.project")
    worktree = labels.get(cache.LABEL_WORKTREE)
    cache_key = labels.get(cache.LABEL_CACHE_KEY)
    toolchain = labels.get(cache.LABEL_TOOLCHAIN)
    cargo_profile = labels.get(cache.LABEL_CARGO_PROFILE)
    expected_unit = None
    if (labels.get(cache.LABEL_SCHEMA) == cache.SCHEMA
            and labels.get(cache.LABEL_PROFILE) == cache.PROFILE
            and labels.get(cache.LABEL_PROJECT) == identity["project_id"]
            and isinstance(unit, str) and _SHA.fullmatch(unit)
            and labels.get(cache.LABEL_OWNER) == unit
            and isinstance(cache_key, str) and _SHA.fullmatch(cache_key)
            and isinstance(worktree, str) and _ID.fullmatch(worktree)
            and isinstance(toolchain, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", toolchain)
            and cargo_profile in cache.SUPPORTED_CARGO_PROFILES):
        expected_unit = cache._sha256({
            "schema": cache.SCHEMA, "project_id": identity["project_id"],
            "cache_key": cache_key, "worktree_id": worktree,
            "toolchain_image_id": toolchain, "cargo_profile": cargo_profile,
        })
    if expected_unit is None or expected_unit != unit:
        raise CacheRetirementError("Unknown shared package consumer identity; all shared root consumers must be registered")
    expected_compose = ("fullmag-master" if labels.get("org.fullmag.source.checkout-kind") == "main-checkout"
                        else "fullmag-worktree-" + re.sub(r"[^a-z0-9_-]+", "-", worktree).strip("-"))
    if (compose_project != expected_compose
            or labels.get("org.fullmag.source.project-id") != identity["project_id"]
            or labels.get("org.fullmag.source.worktree-id") != worktree
            or labels.get("org.fullmag.source.checkout-kind") not in {"worktree", "main-checkout"}
            or labels.get("org.fullmag.compose.project") != expected_compose
            or environment.get("FULLMAG_SOURCE_PROJECT_ID") != identity["project_id"]
            or environment.get("FULLMAG_SOURCE_WORKTREE_ID") != worktree
            or environment.get("FULLMAG_SOURCE_CHECKOUT_KIND") != labels.get("org.fullmag.source.checkout-kind")
            or environment.get("FULLMAG_BACKEND_CACHE_SCHEMA") != cache.SCHEMA
            or environment.get("FULLMAG_BACKEND_CACHE_PROFILE") != cache.PROFILE
            or environment.get("FULLMAG_BACKEND_CACHE_PROJECT_ID") != identity["project_id"]
            or environment.get("FULLMAG_BACKEND_CACHE_UNIT_KEY") != unit
            or environment.get("FULLMAG_BACKEND_CACHE_OWNER_ID") != unit
            or environment.get("FULLMAG_BACKEND_CACHE_KEY") != cache_key
            or environment.get("FULLMAG_BACKEND_CACHE_WORKTREE_ID") != worktree
            or environment.get("FULLMAG_BACKEND_CACHE_TOOLCHAIN_IMAGE_ID") != toolchain
            or environment.get("FULLMAG_BACKEND_CARGO_PROFILE") != cargo_profile
            or environment.get("FULLMAG_SHARED_BACKEND_STORE") != cache.SHARED_BACKEND_TARGET
            or environment.get("FULLMAG_SHARED_BACKEND_GROUP") != cache.shared_group(unit)):
        raise CacheRetirementError("Shared package consumer labels/environment do not form one exact registered identity")
    source_root = environment.get("FULLMAG_SOURCE_ROOT")
    try:
        observed_key = cache.cache_key(source_root, worktree, toolchain, cargo_profile)["key"]
    except (cache.BackendVolumeCacheError, TypeError) as error:
        raise CacheRetirementError("Shared package consumer source root cannot be qualified") from error
    name_id = hashlib.sha256(f"{identity['project_id']}:{unit}".encode()).hexdigest()[:24]
    if (observed_key != cache_key
            or environment.get("FULLMAG_BACKEND_CACHE_BUILD_VOLUME") != f"fullmag-backend-v2-{name_id}-build"
            or environment.get("FULLMAG_BACKEND_CACHE_PACKAGE_VOLUME") != volume
            or environment.get("FULLMAG_SHARED_BACKEND_VOLUME") != volume):
        raise CacheRetirementError("Shared package consumer cache key or volume names are not derived from its source identity")
    if maintenance is not None:
        if compose_project != labels.get("com.docker.compose.project") or len(mounts) != 1:
            raise CacheRetirementError("Shared maintenance consumer mounts are ambiguous")
        target = mounts[0].get("Destination")
        if (target != cache.PACKAGE_TARGET
                or _safe_subpath(cache, document, mounts[0], target, volume, shared_doc["mountpoint"])
                != cache.shared_group(unit)):
            raise CacheRetirementError("Shared maintenance consumer uses an unexpected group subpath")
        return
    if labels.get("com.docker.compose.service") != cache.BACKEND_SERVICE or len(mounts) != 2:
        raise CacheRetirementError("Shared package root consumer is not an exact backend runtime")
    by_target = {mount.get("Destination"): mount for mount in mounts}
    if set(by_target) != {cache.PACKAGE_TARGET, cache.SHARED_BACKEND_TARGET}:
        raise CacheRetirementError("Shared package runtime mount targets are incomplete or ambiguous")
    if (_safe_subpath(cache, document, by_target[cache.PACKAGE_TARGET], cache.PACKAGE_TARGET,
                      volume, shared_doc["mountpoint"]) != cache.shared_group(unit)
            or _safe_subpath(cache, document, by_target[cache.SHARED_BACKEND_TARGET],
                             cache.SHARED_BACKEND_TARGET, volume, shared_doc["mountpoint"]) != ""):
        raise CacheRetirementError("Shared package runtime root/private aliases do not match the registered group")


def _check_consumers(documents: list[dict[str, Any]], identity: Mapping[str, str],
                     volumes: list[dict[str, Any]], shared_doc: Mapping[str, Any] | None,
                     retiring_units: set[str], allowed_helpers: set[str]) -> None:
    _check_group_empty(documents, identity, allowed_helpers)
    mounts = {item["name"]: item for item in volumes}
    for document in documents:
        helper = document["Id"] in allowed_helpers
        for mount in document["Mounts"]:
            if mount.get("Type") == "volume":
                name = mount.get("Name")
                if name in mounts:
                    raise CacheRetirementError(f"Container {document['Id']} still mounts private cache volume {name}")
            elif mount.get("Type") == "bind":
                import docker_backend_volume_cache as cache
                source = mount.get("Source")
                # Docker Desktop reports unrelated native Windows binds with
                # drive letters, including mixed separators. They are not
                # daemon-local named-volume paths. UNC aliases remain unknown.
                if isinstance(source, str) and source.startswith(("\\\\", "//")):
                    raise CacheRetirementError("Container UNC bind-source inventory is ambiguous")
                try:
                    source = cache._linux_bind_source(source)
                except cache.BackendVolumeCacheError as error:
                    raise CacheRetirementError("Container bind-source inventory is ambiguous") from error
                if source is None:
                    continue
                for item in volumes:
                    root = item["mountpoint"].rstrip("/")
                    if source == root or source.startswith(root + "/") or root.startswith(source.rstrip("/") + "/"):
                        raise CacheRetirementError(f"Container {document['Id']} bind-aliases private cache volume {item['name']}")
                if shared_doc is not None:
                    root = shared_doc["mountpoint"].rstrip("/")
                    if source == root or source.startswith(root + "/") or root.startswith(source.rstrip("/") + "/"):
                        raise CacheRetirementError(f"Container {document['Id']} bind-aliases the shared package volume")
        if shared_doc is not None and any(
            mount.get("Type") == "volume" and mount.get("Name") == shared_doc["name"]
            for mount in document["Mounts"]
        ):
            if helper:
                import docker_backend_volume_cache as cache
                aliases = [mount for mount in document["Mounts"]
                           if mount.get("Type") == "volume" and mount.get("Name") == shared_doc["name"]]
                if len(aliases) != 1 or aliases[0].get("Destination") != cache.SHARED_BACKEND_TARGET:
                    raise CacheRetirementError("Retirement helper shared package mount is ambiguous")
                if _safe_subpath(cache, document, aliases[0], cache.SHARED_BACKEND_TARGET,
                                 shared_doc["name"], shared_doc["mountpoint"]) != "":
                    raise CacheRetirementError("Retirement helper must use the shared package root")
            else:
                _registered_other_shared_consumer(document, identity, shared_doc, retiring_units)


def _plan(identity: Mapping[str, str], task_id: str, owner: str, volumes: list[dict[str, Any]],
          unit_keys: list[str], shared_doc: Mapping[str, Any] | None) -> dict[str, Any]:
    return {
        "schema": PLAN_SCHEMA, "task_id": task_id, "owner": owner,
        **dict(identity), "volumes": volumes,
        "shared_package_volume": dict(shared_doc) if shared_doc is not None else None,
        "namespaces_pending": unit_keys,
    }


def _recheck_inventory(control: Any, layout: Mapping[str, Any], identity: Mapping[str, str],
                       plan: Mapping[str, Any], prior_plan: Mapping[str, Any] | None,
                       docker: Callable[..., Any] | None) -> None:
    backend, live_units = _backend_volumes(
        control, layout, identity, docker, allow_orphan_packages=prior_plan is not None
    )
    frontend = _frontend_volumes(control, identity, docker)
    live = sorted([*backend, *frontend], key=lambda item: (item["kind"], item["name"]))
    live_shared = _shared_package(control, identity, docker)
    planned = plan["volumes"]
    if live_shared != plan["shared_package_volume"]:
        raise CacheRetirementError("Docker shared/private volume inventory changed while acquiring the retirement lease")
    if prior_plan is None:
        if live != planned:
            raise CacheRetirementError("Docker private volume inventory changed while acquiring the retirement lease")
        return

    expected = {item["name"]: item for item in planned}
    if any(expected.get(item["name"]) != item for item in live):
        raise CacheRetirementError("A new or changed private volume appeared after the durable retirement plan")
    if not set(live_units).issubset(set(plan["namespaces_pending"])):
        raise CacheRetirementError("A new backend group namespace appeared after the durable retirement plan")
    # A planned target omitted by `volume ls` is acceptable only when it is
    # genuinely absent, not when its ownership labels changed and hid it.
    for item in planned:
        observed = _inspect_volume(item["name"], docker)
        if observed is not None and (dict(observed["Labels"]) != dict(item["labels"])
                                     or observed.get("Mountpoint") != item["mountpoint"]):
            raise CacheRetirementError(f"Planned volume changed during lease admission: {item['name']}")


def _validate_prior_plan(plan: Any, control: Any, layout: Mapping[str, Any],
                         identity: Mapping[str, str], task_id: str, owner: str) -> dict[str, Any]:
    if not isinstance(plan, Mapping):
        raise CacheRetirementError("Existing retirement plan is malformed")
    expected = {"schema": PLAN_SCHEMA, "task_id": task_id, "owner": owner, **dict(identity)}
    if any(plan.get(key) != value for key, value in expected.items()):
        raise CacheRetirementError("Existing retirement plan belongs to a different task or worktree")
    records = plan.get("volumes")
    if not isinstance(records, list) or len(records) > 64:
        raise CacheRetirementError("Existing retirement plan volume inventory is malformed")
    names: set[str] = set()
    unit_keys: set[str] = set()
    import docker_backend_volume_cache as cache
    from docker_frontend_cache import (
        PROFILE, SCHEMA, VOLUME_KEY_LABEL, VOLUME_PROFILE_LABEL,
        VOLUME_PROJECT_LABEL, VOLUME_SCHEMA_LABEL, _v2_volume_name,
    )
    labels_from_control = {
        key: value for key, value in _mapping(getattr(control, "labels", None), "BuildControl labels").items()
        if isinstance(key, str) and key.startswith("org.fullmag.")
    }
    for item in records:
        if not isinstance(item, Mapping):
            raise CacheRetirementError("Existing retirement plan volume record is malformed")
        name = item.get("name")
        kind = item.get("kind")
        labels = item.get("labels")
        mountpoint = item.get("mountpoint")
        if (not isinstance(name, str) or _VOLUME_NAME.fullmatch(name) is None or name in names
                or not isinstance(labels, Mapping) or not isinstance(mountpoint, str)):
            raise CacheRetirementError("Existing retirement plan volume identity is ambiguous")
        names.add(name)
        try:
            validate_local_named_volume({"Name": name, "Driver": "local", "Options": {},
                                         "Scope": "local", "Mountpoint": mountpoint}, name)
        except DockerNamedVolumeSafetyError as error:
            raise CacheRetirementError(f"Existing retirement plan has unsafe volume backing: {name}") from error
        if kind in {"backend-build", "backend-package"}:
            role = cache.BUILD_VOLUME_ROLE if kind == "backend-build" else cache.PACKAGE_VOLUME_ROLE
            profile = _expected_backend_profile(control, layout, identity, labels, role)
            if (name != profile["volume_names"][role]
                    or dict(labels) != cache.volume_labels(profile, role)
                    or item.get("unit_key") != profile["unit_key"]):
                raise CacheRetirementError("Existing retirement plan has a non-derived backend volume")
            if kind == "backend-build":
                unit_keys.add(profile["unit_key"])
        elif kind == "frontend-v2":
            key = labels.get(VOLUME_KEY_LABEL)
            expected_labels = {VOLUME_SCHEMA_LABEL: SCHEMA, VOLUME_PROFILE_LABEL: PROFILE,
                               VOLUME_PROJECT_LABEL: identity["compose_project"], VOLUME_KEY_LABEL: key}
            if (not isinstance(key, str) or _SHA.fullmatch(key) is None
                    or dict(labels) != expected_labels or name != _v2_volume_name(identity["compose_project"], key)
                    or "unit_key" in item):
                raise CacheRetirementError("Existing retirement plan has a non-derived frontend v2 volume")
        elif kind == "frontend-v1":
            match = _V1_FRONTEND.fullmatch(name)
            key = labels.get("org.fullmag.build.cache-key")
            expected_labels = {**labels_from_control, "org.fullmag.build.role": "frontend",
                               "org.fullmag.build.cache-key": key}
            if (match is None or not isinstance(key, str) or _SHA.fullmatch(key) is None
                    or match.group(1) != key[:24] or dict(labels) != expected_labels or "unit_key" in item):
                raise CacheRetirementError("Existing retirement plan has a non-derived frontend v1 volume")
        else:
            raise CacheRetirementError("Existing retirement plan names an unknown volume class")

    pending = plan.get("namespaces_pending")
    if (not isinstance(pending, list)
            or any(not isinstance(key, str) or _SHA.fullmatch(key) is None for key in pending)
            or pending != sorted(set(pending))):
        raise CacheRetirementError("Existing retirement namespace list is malformed")
    shared_doc = plan.get("shared_package_volume")
    if shared_doc is not None:
        import docker_shared_build_storage as shared
        if not isinstance(shared_doc, Mapping) or not isinstance(shared_doc.get("labels"), Mapping):
            raise CacheRetirementError("Existing retirement shared package volume record is malformed")
        if (shared_doc.get("name") != shared.shared_volume_names(identity["project_id"])[shared.PACKAGE_ROLE]
                or dict(shared_doc["labels"]) != shared.shared_volume_labels(identity["project_id"], shared.PACKAGE_ROLE)
                or pending != sorted(unit_keys)):
            raise CacheRetirementError("Existing retirement shared namespace plan is inconsistent")
        try:
            validate_local_named_volume({"Name": shared_doc["name"], "Driver": "local", "Options": {},
                                         "Scope": "local", "Mountpoint": shared_doc["mountpoint"]}, shared_doc["name"])
        except (KeyError, DockerNamedVolumeSafetyError) as error:
            raise CacheRetirementError("Existing retirement shared package volume is unsafe") from error
    elif pending:
        raise CacheRetirementError("Existing retirement plan has namespaces without a shared package volume")
    return dict(plan)


def _helper_ids(operation: Mapping[str, Any]) -> set[str]:
    values = {operation.get("helper_container_id")}
    extra = operation.get("retirement_helper_ids", ())
    if isinstance(extra, (list, tuple, set)):
        values.update(extra)
    elif extra:
        raise CacheRetirementError("Retirement helper ID inventory is malformed")
    result = {value for value in values if value is not None}
    if any(not isinstance(value, str) or _CONTAINER_ID.fullmatch(value) is None for value in result):
        raise CacheRetirementError("Retirement helper ID is malformed")
    return result


def retire(control: Any, layout: Mapping[str, Any], task_id: str, owner: str, *,
           retire_namespaces: Callable[[list[str], dict[str, Any]], Mapping[str, Any]] | None = None,
           docker: Callable[..., Any] | None = None) -> dict[str, Any]:
    """Remove exact private cache volumes for one already-registered worktree.

    Shared `groups/<unit_key>` paths are delegated to a required guest callback
    whenever the project-shared package volume exists. The shared volume itself
    is never removed.
    """
    if not isinstance(task_id, str) or not task_id.strip() or not isinstance(owner, str) or not owner.strip():
        raise CacheRetirementError("Retirement requires exact nonempty task_id and owner")
    identity = _identity(control, layout)
    before = _container_inventory(docker)
    _check_group_empty(before, identity)

    previous_plan = control.read(PLAN_PATH, optional=True)
    if previous_plan is not None:
        previous_plan = _validate_prior_plan(previous_plan, control, layout, identity, task_id, owner)
    backend, observed_units = _backend_volumes(
        control, layout, identity, docker, allow_orphan_packages=previous_plan is not None
    )
    frontend = _frontend_volumes(control, identity, docker)
    shared_doc = _shared_package(control, identity, docker)
    if shared_doc is not None and retire_namespaces is None:
        raise CacheRetirementError("Shared package volume exists; retire_namespaces callback is required before any deletion")
    volumes = sorted([*backend, *frontend], key=lambda item: (item["kind"], item["name"]))
    unit_keys = observed_units if shared_doc is not None else []
    current_plan = _plan(identity, task_id, owner, volumes, unit_keys, shared_doc)
    if previous_plan is not None:
        planned = {item["name"]: item for item in previous_plan["volumes"]}
        for item in volumes:
            if planned.get(item["name"]) != item:
                raise CacheRetirementError("New or changed private volume appeared after the durable retirement plan")
        if previous_plan["shared_package_volume"] != current_plan["shared_package_volume"]:
            raise CacheRetirementError("Shared package volume changed since the durable retirement plan")
        for item in previous_plan["volumes"]:
            observed = _inspect_volume(item["name"], docker)
            if observed is not None and (dict(observed["Labels"]) != dict(item["labels"])
                                         or observed.get("Mountpoint") != item["mountpoint"]):
                raise CacheRetirementError(f"Planned volume changed; retaining: {item['name']}")
        if previous_plan["shared_package_volume"] is not None:
            observed = _inspect_volume(previous_plan["shared_package_volume"]["name"], docker)
            if observed is None or dict(observed["Labels"]) != dict(previous_plan["shared_package_volume"]["labels"]):
                raise CacheRetirementError("Shared package volume changed or disappeared; retaining all private caches")
        current_plan = previous_plan
        unit_keys = list(previous_plan["namespaces_pending"])
    plan_sha256 = hashlib.sha256(_canonical(current_plan)).hexdigest()
    previous_closing = control.read(CLOSING_PATH, optional=True)
    closing = {"schema": CLOSING_SCHEMA, "state": "closing", "plan_sha256": plan_sha256,
               "task_id": task_id, "owner": owner, **dict(identity)}
    if previous_plan is None and previous_closing is not None:
        raise CacheRetirementError("Closing marker exists without its durable retirement plan")
    if previous_closing is not None and previous_closing != closing:
        raise CacheRetirementError("Existing permanent closing marker differs from the retirement plan")

    previous_namespace = control.read(NAMESPACE_RESULT_PATH, optional=True)
    if previous_namespace is not None and (
        not isinstance(previous_namespace, Mapping)
        or previous_namespace.get("schema") != NAMESPACE_RESULT_SCHEMA
        or previous_namespace.get("state") != "succeeded"
        or previous_namespace.get("plan_sha256") != plan_sha256
        or previous_namespace.get("unit_keys") != unit_keys
    ):
        raise CacheRetirementError("Recorded namespace-retirement receipt differs from the durable plan")
    previous_result = control.read(RESULT_PATH, optional=True)
    if previous_result is not None:
        if (not isinstance(previous_result, Mapping)
                or previous_result.get("schema") != RESULT_SCHEMA
                or previous_result.get("state") != "succeeded"
                or previous_result.get("plan_sha256") != plan_sha256
                or previous_result.get("task_id") != task_id
                or previous_result.get("owner") != owner
                or any(previous_result.get(key) != value for key, value in identity.items())):
            raise CacheRetirementError("Recorded successful retirement receipt differs from the durable plan")
        if current_plan["shared_package_volume"] is not None and previous_namespace is None:
            raise CacheRetirementError("Successful result has no namespace-retirement receipt")
        planned_names = sorted(item["name"] for item in current_plan["volumes"])
        deleted_names = previous_result.get("deleted_volumes")
        absent_names = previous_result.get("already_absent_volumes")
        if (not isinstance(deleted_names, list) or not isinstance(absent_names, list)
                or any(not isinstance(name, str) for name in deleted_names + absent_names)
                or sorted(deleted_names + absent_names) != planned_names
                or set(deleted_names).intersection(absent_names)
                or previous_result.get("namespaces_pending") != unit_keys
                or previous_result.get("namespace_retirement") != (
                    previous_namespace.get("callback_receipt") if previous_namespace is not None else None
                )):
            raise CacheRetirementError("Recorded successful result does not cover the durable plan exactly")
        for item in current_plan["volumes"]:
            if _inspect_volume(item["name"], docker) is not None:
                raise CacheRetirementError("A private volume reappeared after successful retirement; retaining it")
        return dict(previous_result)

    with control.operation(
        "cache-retirement",
        {"task_id": task_id, "owner": owner, **identity, "plan_sha256": plan_sha256},
        minimum_free_bytes=MIN_FREE_CONTROL_BYTES,
    ) as operation:
        helper_ids = _helper_ids(operation)
        _recheck_inventory(control, layout, identity, current_plan, previous_plan, docker)
        documents = _container_inventory(docker)
        _check_consumers(documents, identity, current_plan["volumes"],
                         current_plan["shared_package_volume"], set(unit_keys), helper_ids)
        if previous_plan is None:
            control.write(PLAN_PATH, current_plan)
        if previous_closing is None:
            control.write(CLOSING_PATH, closing)

        namespace_receipt = None
        if current_plan["shared_package_volume"] is not None and previous_namespace is None:
            operation["daemon_pending"] = True
            namespace_receipt = retire_namespaces(list(unit_keys), operation)
            operation["daemon_pending"] = False
            if (not isinstance(namespace_receipt, Mapping)
                    or namespace_receipt.get("state") != "succeeded"
                    or namespace_receipt.get("unit_keys") != list(unit_keys)):
                raise CacheRetirementError("Namespace retirement callback did not attest the exact unit-key set")
            receipt_doc = {"schema": NAMESPACE_RESULT_SCHEMA, "state": "succeeded",
                           "plan_sha256": plan_sha256, "unit_keys": list(unit_keys),
                           "callback_receipt": dict(namespace_receipt)}
            control.write(NAMESPACE_RESULT_PATH, receipt_doc)
        elif previous_namespace is not None:
            namespace_receipt = previous_namespace.get("callback_receipt")

        deleted: list[str] = []
        already_absent: list[str] = []
        for item in current_plan["volumes"]:
            name = item["name"]
            planned_shared = current_plan["shared_package_volume"]
            if planned_shared is not None:
                observed_shared = _inspect_volume(planned_shared["name"], docker)
                if (observed_shared is None
                        or dict(observed_shared["Labels"]) != dict(planned_shared["labels"])
                        or observed_shared.get("Mountpoint") != planned_shared["mountpoint"]):
                    raise CacheRetirementError("Shared package volume changed before private volume deletion")
            observed = _inspect_volume(name, docker)
            if observed is None:
                already_absent.append(name)
                continue
            if (dict(observed["Labels"]) != item["labels"]
                    or observed.get("Mountpoint") != item["mountpoint"]):
                raise CacheRetirementError(f"Private cache volume changed since plan; retained: {name}")
            documents = _container_inventory(docker)
            _check_consumers(documents, identity, [item], current_plan["shared_package_volume"],
                             set(unit_keys), _helper_ids(operation))
            _run(("volume", "rm", name), docker)
            deleted.append(name)

        # The project-scoped shared package volume is protected global state.
        if current_plan["shared_package_volume"] is not None:
            planned_shared = current_plan["shared_package_volume"]
            observed_shared = _inspect_volume(planned_shared["name"], docker)
            if (observed_shared is None or dict(observed_shared["Labels"]) != planned_shared["labels"]
                    or observed_shared.get("Mountpoint") != planned_shared["mountpoint"]):
                raise CacheRetirementError("Shared package volume changed or disappeared; it is never removed here")
        result = {
            "schema": RESULT_SCHEMA, "state": "succeeded", "task_id": task_id, "owner": owner,
            **dict(identity), "plan_sha256": plan_sha256,
            "deleted_volumes": sorted(deleted), "already_absent_volumes": sorted(already_absent),
            "namespaces_pending": list(unit_keys), "namespace_retirement": namespace_receipt,
        }
        control.write(RESULT_PATH, result)
        operation["receipt"].update(state="succeeded", result=result)
        return result
