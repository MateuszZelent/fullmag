#!/usr/bin/env python3
"""Pure host-side builders for controlled Fullmag Docker orphan recovery.

The Docker lifecycle is owned by the root wrapper.  This module consumes its
bounded observations and produces the exact request and attestation schemas
validated by ``fullmag-session``.  It never invokes Docker, stops a service,
starts a service, or replays a solve.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
import hashlib
import json
import ntpath
import os
from pathlib import Path
import re
import stat
import uuid
from typing import Any


ORPHAN_REQUEST_SCHEMA = "host_worker_orphan_teardown_request.v1"
TEARDOWN_ATTESTATION_SCHEMA = "docker_namespace_teardown_attestation.v1"
FINAL_RECEIPT_SCHEMA = "fullmag.docker.orphan-recovery-receipt.v2"
QUIESCENCE_SCHEMA = "fullmag.shared-ledger-quiescence.v2"
PACKAGE_PROBE_SCHEMA = "fullmag.docker.cached-package-probe.v1"
# Compatibility name only.  This module emits the native orphan schema above.
NATIVE_CANCELLATION_SCHEMA = "runtime_service_failed_no_spawn_cancellation.v1"
NATIVE_ORPHAN_RESULT_SCHEMA = "runtime_service_orphan_teardown_result.v1"

MAX_JSON_BYTES = 512 * 1024
MAX_PATH_BYTES = 4096
MAX_PACKAGE_PROBE_ARTIFACTS = 4096
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
CONTAINER_RE = re.compile(r"^[0-9a-f]{12,64}$")
ENGINE_RE = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")
PORTABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
STORE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class OrphanRecoveryError(ValueError):
    """A recovery pin or lifecycle observation is malformed or stale."""


def _fail(message: str) -> None:
    raise OrphanRecoveryError(message)


def _canonical(value: Any) -> bytes:
    try:
        # This matches fullmag-session::canonical_json_bytes for these
        # operational records: sorted object keys, compact UTF-8 JSON.
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        _fail(f"value cannot be canonicalized: {error}")


def canonical_json_sha256(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        _fail(f"{label} must be an object")
    return dict(value)


def _string(value: Any, label: str, *, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        _fail(f"{label} must be a bounded non-empty string")
    if any(ord(char) < 0x20 or ord(char) == 0x7f for char in value):
        _fail(f"{label} contains a control character")
    return value


def _sha(value: Any, label: str, *, nonzero: bool = False) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        _fail(f"{label} must be a lowercase SHA-256")
    if nonzero and set(value) == {"0"}:
        _fail(f"{label} cannot be an all-zero placeholder")
    return value


def _image(value: Any, label: str) -> str:
    if not isinstance(value, str) or IMAGE_RE.fullmatch(value) is None:
        _fail(f"{label} must be an immutable image ID")
    return value


def _container(value: Any, label: str) -> str:
    if not isinstance(value, str) or CONTAINER_RE.fullmatch(value) is None:
        _fail(f"{label} must be a Docker container ID")
    return value


def validate_engine_id(value: Any, label: str = "Docker engine ID") -> str:
    """Preserve Docker's canonical UUID or legacy digest identity verbatim."""
    if not isinstance(value, str):
        _fail(f"{label} must be an immutable Docker engine ID")
    if ENGINE_RE.fullmatch(value) is not None:
        _sha(value.removeprefix("sha256:"), label, nonzero=True)
        return value
    return _uuid_text(value, label)


def _engine(value: Any, label: str) -> str:
    return validate_engine_id(value, label)


def _portable_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or PORTABLE_ID_RE.fullmatch(value) is None:
        _fail(f"{label} is not a portable repository identifier")
    if value in {".", ".."} or value.endswith("."):
        _fail(f"{label} is not a portable repository identifier")
    stem = value.split(".", 1)[0].upper()
    if stem in {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}:
        _fail(f"{label} is a reserved repository identifier")
    if len(stem) == 4 and stem[:3] in {"COM", "LPT"} and stem[3] in "123456789":
        _fail(f"{label} is a reserved repository identifier")
    return value


def _store_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or STORE_ID_RE.fullmatch(value) is None:
        _fail(f"{label} must use the canonical sha256:<hex> store identity")
    return value


def _uuid_text(value: Any, label: str) -> str:
    if not isinstance(value, str):
        _fail(f"{label} must be a canonical nonzero UUID")
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        _fail(f"{label} must be a canonical nonzero UUID")
    if parsed.int == 0 or str(parsed) != value:
        _fail(f"{label} must be a canonical nonzero UUID")
    return value


def _path(value: Any, label: str) -> str:
    value = _string(value, label, maximum=MAX_PATH_BYTES)
    if "\x00" in value or not (Path(value).is_absolute() or ntpath.isabs(value)):
        _fail(f"{label} must be an absolute POSIX path")
    if any(part == ".." for part in value.replace("\\", "/").split("/")):
        _fail(f"{label} must not contain parent traversal")
    return value


def _same_path(left: Any, right: Any) -> bool:
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    left_norm = left.replace("\\", "/").rstrip("/") or "/"
    right_norm = right.replace("\\", "/").rstrip("/") or "/"
    if re.match(r"^[A-Za-z]:/", left_norm) or re.match(r"^[A-Za-z]:/", right_norm):
        return ntpath.normcase(left_norm) == ntpath.normcase(right_norm)
    return left_norm == right_norm


def _read_regular(path: str | Path, label: str, maximum: int = MAX_JSON_BYTES) -> bytes:
    candidate = Path(path)
    try:
        metadata = candidate.lstat()
    except OSError as error:
        _fail(f"cannot inspect {label}: {error}")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        _fail(f"{label} is not a regular file")
    if metadata.st_size <= 0 or metadata.st_size > maximum:
        _fail(f"{label} exceeds its bounded size")
    try:
        first = candidate.read_bytes()
        second = candidate.read_bytes()
    except OSError as error:
        _fail(f"cannot read {label}: {error}")
    if first != second or len(first) != metadata.st_size:
        _fail(f"{label} changed while it was read")
    return first


def _reject_symlink_ancestors(path: Path, label: str) -> None:
    """Reject symlinked components in an immutable history destination."""

    current = path
    while True:
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            parent = current.parent
            if parent == current:
                return
            current = parent
            continue
        except OSError as error:
            _fail(f"cannot inspect {label} parent: {error}")
        if stat.S_ISLNK(metadata.st_mode):
            _fail(f"{label} has a symlink parent")
        parent = current.parent
        if parent == current:
            return
        current = parent


def _file_sha(path: Any, label: str, maximum: int = MAX_JSON_BYTES) -> str:
    return hashlib.sha256(_read_regular(_path(path, f"{label} path"), label, maximum)).hexdigest()


def _parse_json_file(path: Any, label: str, maximum: int = MAX_JSON_BYTES) -> tuple[dict[str, Any], bytes]:
    raw = _read_regular(_path(path, f"{label} path"), label, maximum)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"{label} is not valid JSON: {error}")
    return _mapping(value, label), raw


def _value_digest(value: Any, label: str) -> str:
    if isinstance(value, Mapping):
        if "sha256" in value:
            digest = _sha(value["sha256"], f"{label}.sha256", nonzero=True)
            if "path" in value:
                if "value" in value and value.get("canonical", False):
                    parsed, _ = _parse_json_file(value["path"], label, 16 * 1024 * 1024)
                    if parsed != _mapping(value["value"], f"{label}.value"):
                        _fail(f"{label} file value differs from its pinned record")
                else:
                    observed = _file_sha(value["path"], label, 16 * 1024 * 1024)
                    if observed != digest:
                        _fail(f"{label} bytes differ from its pinned SHA-256")
            if "value" in value and value.get("canonical", False) and canonical_json_sha256(value["value"]) != digest:
                _fail(f"{label} value differs from its pinned canonical SHA-256")
            return digest
        if "path" in value:
            return _file_sha(value["path"], label, 16 * 1024 * 1024)
        if "value" in value:
            return canonical_json_sha256(value["value"])
    return _sha(value, label, nonzero=True)


def _required_digest(pins: Mapping[str, Any], key: str, label: str, *aliases: str) -> str:
    for candidate in (key, *aliases):
        if candidate in pins:
            return _value_digest(pins[candidate], label)
    _fail(f"missing {label}")


def _canonical_record_digest(value: Any, label: str) -> str:
    """Read a JSON reservation/lease record and hash its canonical value.

    The native ledger hashes the typed record, rather than the incidental
    whitespace and key order of the file that carried it.  These three
    request fields must therefore not accept a raw pretty-printed file hash.
    A bare digest remains valid for callers that already obtained the typed
    canonical digest from the ledger; a path or value is re-derived here.
    """

    if isinstance(value, Mapping):
        if "path" in value:
            parsed, _ = _parse_json_file(value["path"], label, 16 * 1024 * 1024)
            if "value" in value and parsed != _mapping(value["value"], f"{label}.value"):
                _fail(f"{label} file value differs from its pinned record")
            observed = parsed
        elif "value" in value:
            observed = _mapping(value["value"], f"{label}.value")
        elif "sha256" in value:
            return _sha(value["sha256"], f"{label}.sha256", nonzero=True)
        else:
            _fail(f"{label} requires a JSON record path, value, or canonical digest")
        digest = canonical_json_sha256(observed)
        if "sha256" in value and _sha(value["sha256"], f"{label}.sha256", nonzero=True) != digest:
            _fail(f"{label} is not the canonical typed-record SHA-256")
        return digest
    return _sha(value, label, nonzero=True)


def _required_canonical_digest(pins: Mapping[str, Any], key: str, label: str, *aliases: str) -> str:
    for candidate in (key, *aliases):
        if candidate in pins:
            return _canonical_record_digest(pins[candidate], label)
    _fail(f"missing {label}")


def _package_artifacts(value: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or not value:
        _fail(f"{label} must be a non-empty artifact list")
    if len(value) > MAX_PACKAGE_PROBE_ARTIFACTS:
        _fail(f"{label} exceeds its artifact bound")
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    previous: str | None = None
    for index, raw in enumerate(value):
        item = _mapping(raw, f"{label}[{index}]")
        if set(item) != {"path", "size", "sha256", "mode"}:
            _fail(f"{label}[{index}] has unexpected fields")
        path = _string(item.get("path"), f"{label}[{index}].path", maximum=MAX_PATH_BYTES)
        parts = path.split("/")
        if (
            path.startswith("/")
            or "\\" in path
            or any(part in {"", ".", ".."} for part in parts)
        ):
            _fail(f"{label}[{index}].path is not a safe relative package path")
        if path in seen:
            _fail(f"{label} repeats artifact path {path!r}")
        if previous is not None and path <= previous:
            _fail(f"{label} is not in canonical path order")
        previous = path
        seen.add(path)
        size = item.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0 or size > (1 << 63) - 1:
            _fail(f"{label}[{index}].size is invalid")
        digest = _sha(item.get("sha256"), f"{label}[{index}].sha256", nonzero=True)
        mode = item.get("mode")
        if mode not in {"100644", "100755"}:
            _fail(f"{label}[{index}].mode is invalid")
        records.append({"path": path, "size": size, "sha256": digest, "mode": mode})
    return records


def _nested_mapping(pins: Mapping[str, Any], key: str, label: str) -> dict[str, Any]:
    value = pins.get(key)
    if not isinstance(value, Mapping):
        _fail(f"missing {label}")
    return dict(value)


def _engine_id(document: Mapping[str, Any], label: str) -> str:
    document = _mapping(document, label)
    return _engine(document.get("ID", document.get("Id", document.get("id"))), f"{label}.id")


def _engine_id_sha(document: Mapping[str, Any], pins: Mapping[str, Any]) -> str:
    engine_id = _engine_id(document, "Docker engine")
    observed = hashlib.sha256(engine_id.encode("utf-8")).hexdigest()
    candidates = []
    if "docker_engine_id_sha256" in pins:
        candidates.append(pins["docker_engine_id_sha256"])
    if isinstance(pins.get("engine"), Mapping) and "sha256" in pins["engine"]:
        candidates.append(pins["engine"]["sha256"])
    for candidate in candidates:
        if _sha(candidate, "docker_engine_id_sha256", nonzero=True) != observed:
            _fail("pinned Docker engine digest differs from the observed engine")
    return observed


def _labels(container: Mapping[str, Any]) -> dict[str, Any]:
    config = _mapping(container.get("Config"), "Docker container Config")
    labels = config.get("Labels")
    if not isinstance(labels, Mapping):
        _fail("Docker container has no labels")
    return dict(labels)


def _host_config(container: Mapping[str, Any]) -> dict[str, Any]:
    return _mapping(container.get("HostConfig"), "Docker container HostConfig")


def _state(container: Mapping[str, Any]) -> dict[str, Any]:
    return _mapping(container.get("State"), "Docker container State")


def _binds(container: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    mounts = container.get("Mounts")
    if not isinstance(mounts, Sequence) or isinstance(mounts, (str, bytes)):
        _fail("Docker container has no mount inventory")
    result: dict[str, dict[str, Any]] = {}
    for mount in mounts:
        item = _mapping(mount, "Docker mount")
        target = _string(item.get("Destination"), "Docker mount destination")
        if target in result:
            _fail(f"Docker container has duplicate mount target {target}")
        result[target] = item
    return result


def _validate_backend_volume_cache(value: Any) -> dict[str, Any]:
    """Validate the ready v2 cache descriptor and its published documents.

    The descriptor is host provenance, while the two named volumes are
    daemon-owned.  This function deliberately delegates the shared label,
    volume-document, and overlay rules to the versioned adapter; an absent or
    unknown schema never falls back to the v1 bind contract.
    """
    value = _mapping(value, "backend volume cache")
    try:
        import docker_backend_volume_cache as adapter
    except ImportError as error:  # pragma: no cover - packaging error
        _fail(f"backend volume cache adapter is unavailable: {error}")
    if value.get("schema") != adapter.SCHEMA or value.get("profile") != adapter.PROFILE:
        _fail("backend volume cache has an unsupported schema")
    if value.get("state") != "ready":
        _fail("backend volume cache is not ready")
    if (value.get("build_root") != adapter.BUILD_TARGET
            or value.get("mount_root") != adapter.BUILD_TARGET
            or value.get("package_root") != adapter.PACKAGE_TARGET):
        _fail("backend volume cache daemon targets are not canonical")
    names = value.get("volume_names")
    if (not isinstance(names, Mapping)
            or set(names) != {adapter.BUILD_VOLUME_ROLE, adapter.PACKAGE_VOLUME_ROLE}
            or any(not isinstance(name, str) or adapter._VOLUME_NAME.fullmatch(name) is None
                   for name in names.values())):
        _fail("backend volume cache does not pin the exact build/package volume pair")
    if value.get("mounts") != adapter.mount_specs(value):
        _fail("backend volume cache mounts are not the canonical nocopy pair")
    environment = value.get("environment")
    if environment != adapter._cache_environment(value):
        _fail("backend volume cache environment is not canonical")
    documents = value.get("volume_documents")
    if not isinstance(documents, Mapping):
        _fail("backend volume cache has no inspected volume documents")
    try:
        inspected = adapter._validate_volume_documents(documents, value)
    except Exception as error:
        _fail(f"backend volume cache volume labels or roles are invalid: {error}")
    if dict(inspected) != dict(documents):
        _fail("backend volume cache volume documents changed during validation")

    receipt = _mapping(value.get("receipt"), "backend volume cache ready receipt")
    receipt_path = _path(value.get("receipt_path"), "backend volume cache receipt")
    raw = _read_regular(receipt_path, "backend volume cache receipt", 16 * 1024 * 1024)
    if "receipt_sha256" in value:
        if hashlib.sha256(raw).hexdigest() != _sha(
                value["receipt_sha256"], "backend volume cache receipt_sha256", nonzero=True):
            _fail("backend volume cache receipt bytes differ from its pin")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"backend volume cache receipt is not valid JSON: {error}")
    if _mapping(parsed, "backend volume cache receipt file") != receipt:
        _fail("backend volume cache receipt differs from its published descriptor")
    if (receipt.get("schema") != adapter.SCHEMA
            or receipt.get("profile") != adapter.PROFILE
            or receipt.get("state") != "ready"
            or receipt.get("project_id") != value.get("project_id")
            or receipt.get("worktree_id") != value.get("worktree_id")
            or receipt.get("cache_key") != value.get("cache_key")
            or receipt.get("unit_key") != value.get("unit_key")
            or receipt.get("owner_id") != value.get("owner_id")
            or receipt.get("cargo_profile") != value.get("cargo_profile")
            or receipt.get("runtime_image_id") != value.get("runtime_image_id")
            or receipt.get("toolchain_image_id") != value.get("toolchain_image_id")
            or receipt.get("volume_names") != dict(names)
            or receipt.get("build_root") != adapter.BUILD_TARGET
            or receipt.get("package_root") != adapter.PACKAGE_TARGET
            or receipt.get("mounts") != value["mounts"]
            or receipt.get("volume_documents") != dict(documents)):
        _fail("backend volume cache ready receipt does not pin the exact pair")
    maintenance_receipt = receipt.get("maintenance_receipt")
    if not isinstance(maintenance_receipt, Mapping):
        _fail("backend volume cache ready receipt has no maintenance proof")
    try:
        adapter._validate_maintenance_receipt(maintenance_receipt, value)
    except Exception as error:
        _fail(f"backend volume cache maintenance proof is invalid: {error}")
    if value.get("maintenance_receipt") != dict(maintenance_receipt):
        _fail("backend volume cache maintenance proof differs from its descriptor")
    if receipt.get("host_receipt_path") is not None and not _same_path(
            receipt["host_receipt_path"], receipt_path):
        _fail("backend volume cache receipt path differs from its host pin")

    overlay = _mapping(value.get("overlay"), "backend volume cache Compose overlay")
    overlay_path = _path(value.get("compose_overlay"), "backend volume cache Compose overlay")
    overlay_raw = _read_regular(overlay_path, "backend volume cache Compose overlay")
    overlay_sha = _sha(value.get("compose_overlay_sha256"),
                       "backend volume cache Compose overlay SHA-256", nonzero=True)
    if hashlib.sha256(overlay_raw).hexdigest() != overlay_sha:
        _fail("backend volume cache Compose overlay bytes differ from its pin")
    try:
        parsed_overlay = json.loads(overlay_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"backend volume cache Compose overlay is not valid JSON: {error}")
    if _mapping(parsed_overlay, "backend volume cache Compose overlay file") != overlay:
        _fail("backend volume cache Compose overlay differs from its published descriptor")
    try:
        if overlay != adapter.overlay(value):
            _fail("backend volume cache Compose overlay is not canonical")
        adapter.validate_overlay(overlay, value)
    except OrphanRecoveryError:
        raise
    except Exception as error:
        _fail(f"backend volume cache Compose overlay is invalid: {error}")

    maintenance = _mapping(value.get("maintenance_overlay"),
                           "backend volume cache maintenance overlay")
    maintenance_path = _path(
        value.get("maintenance_compose_overlay"),
        "backend volume cache maintenance overlay",
    )
    maintenance_raw = _read_regular(
        maintenance_path, "backend volume cache maintenance overlay")
    maintenance_sha = value.get("maintenance_compose_overlay_sha256")
    if maintenance_sha is not None and hashlib.sha256(maintenance_raw).hexdigest() != _sha(
            maintenance_sha, "backend volume cache maintenance overlay SHA-256", nonzero=True):
        _fail("backend volume cache maintenance overlay bytes differ from its pin")
    try:
        parsed_maintenance = json.loads(maintenance_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"backend volume cache maintenance overlay is not valid JSON: {error}")
    if _mapping(parsed_maintenance, "backend volume cache maintenance overlay file") != maintenance:
        _fail("backend volume cache maintenance overlay differs from its published descriptor")
    try:
        if maintenance != adapter.maintenance_overlay(value):
            _fail("backend volume cache maintenance overlay is not canonical")
        adapter.validate_maintenance_overlay(maintenance, value)
    except OrphanRecoveryError:
        raise
    except Exception as error:
        _fail(f"backend volume cache maintenance overlay is invalid: {error}")
    return dict(value)


def _validate_backend_volume_mounts(
    mounts: Mapping[str, Mapping[str, Any]], cache: Mapping[str, Any]
) -> None:
    """Require both daemon-owned v2 volumes by exact Name and role target."""
    try:
        import docker_backend_volume_cache as adapter
    except ImportError as error:  # pragma: no cover - packaging error
        _fail(f"backend volume cache adapter is unavailable: {error}")
    expected = {
        adapter.BUILD_TARGET: adapter.BUILD_VOLUME_ROLE,
        adapter.PACKAGE_TARGET: adapter.PACKAGE_VOLUME_ROLE,
    }
    for target, role in expected.items():
        mount = mounts.get(target)
        if (not isinstance(mount, Mapping)
                or mount.get("Type") != "volume"
                or mount.get("Name") != cache["volume_names"][role]
                or mount.get("RW") is not True):
            _fail(f"backend {target} is not the exact pinned named volume")


def _parse_env(config: Mapping[str, Any]) -> dict[str, str]:
    values: dict[str, str] = {}
    raw = config.get("Env", [])
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        _fail("backend Config.Env is not a list")
    for entry in raw:
        text = _string(entry, "backend environment entry")
        name, separator, value = text.partition("=")
        if not separator or not name or name in values:
            _fail("backend environment contains a malformed or duplicate entry")
        values[name] = value
    return values


def _private_pid(host: Mapping[str, Any]) -> tuple[bool, bool]:
    mode = host.get("PidMode")
    if mode in (None, "", "private"):
        return True, False
    if mode == "host":
        return False, True
    return False, False


def _container_binding(
    container: Mapping[str, Any], pins: Mapping[str, Any], *, stopped: bool, require_binds: bool = True
) -> dict[str, Any]:
    container_id = _container(container.get("Id", container.get("id")), "backend container id")
    backend = _mapping(pins.get("backend", pins), "backend pin")
    expected_id = _container(backend.get("container_id", container_id), "backend.container_id")
    if expected_id != container_id:
        _fail("backend container identity differs from its pin")
    image_id = _image(backend.get("image_id", container.get("Image")), "backend.image_id")
    if container.get("Image") != image_id:
        _fail("backend image identity differs from its pin")
    config = _mapping(container.get("Config"), "backend Config")
    labels = _labels(container)
    project = _string(backend.get("compose_project", labels.get("com.docker.compose.project")), "backend.compose_project")
    if labels.get("com.docker.compose.project") != project or labels.get("com.docker.compose.service") != "backend":
        _fail("container is not the exact dedicated backend Compose service")
    if labels.get("org.fullmag.runtime") not in (None, "docker-all-gpu-v1"):
        _fail("backend runtime label is not the Fullmag runtime")
    if _parse_env(config).get("FULLMAG_DOCKER_ROLE") != "backend":
        _fail("backend role is not explicitly bound to backend")
    host = _host_config(container)
    configured_user = backend.get("user", config.get("User"))
    if config.get("User") != configured_user or configured_user in {None, "", "0", "0:0", "root"} or host.get("Privileged") is not False:
        _fail("backend container is not unprivileged")
    if host.get("ReadonlyRootfs") is not True:
        _fail("backend container must have a readonly root filesystem")
    private_pid, host_pid = _private_pid(host)
    if not private_pid or host_pid:
        _fail("backend container must use a private PID namespace")
    ipc_mode = host.get("IpcMode")
    network_mode = host.get("NetworkMode")
    if (
        ipc_mode in {"host", "container"}
        or (isinstance(ipc_mode, str) and ipc_mode.startswith("container:"))
        or network_mode == "host"
        or (isinstance(network_mode, str) and network_mode.startswith("container:"))
    ):
        _fail("backend container must not share a host or another container namespace")
    devices = host.get("Devices")
    if devices not in (None, []):
        _fail("backend container has arbitrary host device mappings")
    capabilities = host.get("CapAdd") or []
    if not isinstance(capabilities, list) or any(str(item).upper() in {"SYS_ADMIN", "SYS_PTRACE", "ALL"} for item in capabilities):
        _fail("backend container has a dangerous added capability")
    mounts = container.get("Mounts")
    if isinstance(mounts, Sequence) and not isinstance(mounts, (str, bytes)):
        for mount in mounts:
            item = _mapping(mount, "Docker mount")
            destination = str(item.get("Destination", "")).replace("\\", "/").rstrip("/")
            source = str(item.get("Source", ""))
            if destination in {"/var/run/docker.sock", "/run/docker.sock", "/proc", "/sys"} or source.endswith("/docker.sock") or source.endswith("\\docker.sock"):
                _fail("backend container has a host-control or host-observation mount")
    device_requests = host.get("DeviceRequests")
    if not isinstance(device_requests, list) or not device_requests:
        _fail("backend container has no exact GPU DeviceRequests")
    binds = _binds(container)
    cache = None
    if "backend_cache" in pins:
        cache = _validate_backend_volume_cache(pins["backend_cache"])
        _validate_backend_volume_mounts(binds, cache)
    state_bind = _mapping(backend.get("state_bind", binds.get("/state")), "backend.state_bind")
    package_bind = _mapping(backend.get("package_bind", binds.get("/opt/fullmag/package")), "backend.package_bind")
    if require_binds:
        if (state_bind.get("Destination") != "/state"
                or state_bind.get("Type") != "bind"
                or state_bind.get("RW") is not True):
            _fail("backend /state bind is not the expected writable bind")
        actual_state = binds.get("/state")
        if (actual_state is None
                or any(actual_state.get(field) != state_bind.get(field)
                       for field in ("Source", "Destination", "RW", "Type"))):
            _fail("backend /state bind differs from its exact pin")
        if cache is None:
            if (package_bind.get("Destination") != "/opt/fullmag/package"
                    or package_bind.get("Type") != "bind"
                    or package_bind.get("RW") is not True):
                _fail("backend /opt/fullmag/package bind is not the expected writable bind")
            actual_package = binds.get("/opt/fullmag/package")
            if (actual_package is None
                    or any(actual_package.get(field) != package_bind.get(field)
                           for field in ("Source", "Destination", "RW", "Type"))):
                _fail("backend /opt/fullmag/package bind differs from its exact pin")
        else:
            expected_package_name = cache["volume_names"]["package"]
            if (package_bind.get("Destination") != "/opt/fullmag/package"
                    or package_bind.get("Type") != "volume"
                    or package_bind.get("Name") != expected_package_name
                    or package_bind.get("RW") is not True):
                _fail("backend /opt/fullmag/package is not the exact pinned v2 volume")
            actual_package = binds.get("/opt/fullmag/package")
            if (actual_package is None
                    or any(actual_package.get(field) != package_bind.get(field)
                           for field in ("Destination", "RW", "Type", "Name"))):
                _fail("backend /opt/fullmag/package volume differs from its exact pin")
    state = _state(container)
    if stopped:
        if state.get("Status") != "exited" or state.get("Running") is not False or state.get("Pid") != 0:
            _fail("backend teardown is not a factual exited/Pid-0 container")
        if not isinstance(state.get("FinishedAt"), str) or not state["FinishedAt"].strip():
            _fail("backend teardown has no factual FinishedAt")
    elif state.get("Running") is not True or state.get("Status") not in {"running", "restarting"}:
        _fail("backend must be running before the authorized stop")
    observed_config_sha = canonical_json_sha256(config)
    config_sha = backend.get("config_sha256", pins.get("container_config_sha256"))
    if config_sha is not None and _sha(config_sha, "backend container config_sha256", nonzero=True) != observed_config_sha:
        _fail("backend container Config bytes differ from its pinned digest")
    config_sha = observed_config_sha
    return {
        "scope": backend.get("scope", "dedicated_parent"),
        "container_id": container_id,
        "image_id": image_id,
        "compose_project": project,
        "service": "backend",
        "config_sha256": config_sha,
        "private_pid_namespace": private_pid,
        "host_pid": host_pid,
        "sole_worker_scope": backend.get("sole_worker_scope", True),
        "device_requests": device_requests,
        "state_bind": state_bind,
        "package_bind": package_bind,
        **({"backend_cache": cache} if cache is not None else {}),
    }


def _validate_quiescence(value: Any) -> dict[str, Any]:
    value = _mapping(value, "shared-ledger quiescence")
    if value.get("schema") != QUIESCENCE_SCHEMA or value.get("protocol_version") != 2:
        _fail("shared-ledger quiescence is not the v2 contract")
    if value.get("all_shared_ledger_clients_quiescent") is not True or value.get("legacy_clients_allowed") is not False:
        _fail("shared-ledger quiescence is not fail-closed")
    _sha(value.get("manifest_sha256"), "quiescence.manifest_sha256", nonzero=True)
    groups = value.get("groups")
    if not isinstance(groups, Sequence) or isinstance(groups, (str, bytes)) or not groups:
        _fail("shared-ledger quiescence has no group inventory")
    for group in groups:
        group = _mapping(group, "quiescence group")
        _string(group.get("project"), "quiescence group project")
        for field in ("active_containers", "active_native_owners", "active_leases", "active_reservations"):
            count = group.get(field)
            if isinstance(count, bool) or not isinstance(count, int) or count != 0:
                _fail(f"quiescence group {group.get('project')!r} is not empty")
    return value


def _validate_expected(expected: Any) -> dict[str, Any]:
    value = _mapping(expected, "expected orphan evidence")
    if value.get("reservation_state") not in {"committed", "quarantined"}:
        _fail("orphan request has an invalid reservation state")
    if value.get("local_lease_state") != "active" or value.get("started_receipt_absent") is not True or value.get("worker_exit_receipt_absent") is not True:
        _fail("orphan request does not prove an active lease and absent worker receipts")
    if value.get("container_state") != "exited" or value.get("pid") != 0 or value.get("finished_at_required") is not True or value.get("descendant_count") != 0:
        _fail("orphan request does not require factual namespace teardown")
    if value.get("task_outcome") != "unknown" or value.get("solve_replay") is not False:
        _fail("orphan request permits a fabricated outcome or Solve replay")
    return value


def _validate_request_shape(request: Mapping[str, Any]) -> dict[str, Any]:
    request = _mapping(request, "orphan teardown request")
    if request.get("schema_version") != ORPHAN_REQUEST_SCHEMA:
        _fail("unsupported orphan teardown request schema")
    request_id = _uuid_text(request.get("request_id"), "request_id")
    for field in ("store_id", "run_id", "task_id", "attempt_id", "resource_id", "lease_token"):
        _store_id(request.get(field), field) if field == "store_id" else _portable_id(request.get(field), field)
    _string(request.get("host_id"), "host_id")
    epoch = request.get("ownership_epoch")
    if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch <= 0:
        _fail("ownership_epoch must be positive")
    digest_fields = (
        "reservation_request_sha256", "reservation_before_sha256", "lease_before_sha256",
        "runtime_generation_sha256", "run_receipt_sha256", "owner_sha256", "config_sha256",
        "launch_sha256", "host_authorization_sha256", "windows_folder_host_sha256",
        "mount_attestation_sha256", "docker_engine_id_sha256",
    )
    for field in digest_fields:
        _sha(request.get(field), field, nonzero=True)
    gate = _mapping(request.get("worker_launch_gate"), "worker_launch_gate")
    if gate.get("state") != "consumed":
        _fail("orphan teardown requires the original consumed launch gate")
    _uuid_text(gate.get("token"), "worker_launch_gate.token")
    containers = request.get("containers")
    if not isinstance(containers, Sequence) or isinstance(containers, (str, bytes)) or not containers:
        _fail("orphan teardown request has no container bindings")
    seen: set[str] = set()
    for item in containers:
        item = _mapping(item, "orphan container binding")
        if item.get("scope") not in {"worker_container", "dedicated_parent"}:
            _fail("orphan container binding has an unsupported scope")
        cid = _container(item.get("container_id"), "orphan container_id")
        if cid in seen:
            _fail("orphan teardown repeats a container")
        seen.add(cid)
        _image(item.get("image_id"), "orphan container image_id")
        _string(item.get("compose_project"), "orphan container compose_project")
        _string(item.get("service"), "orphan container service")
        _sha(item.get("config_sha256"), "orphan container config_sha256", nonzero=True)
        if item.get("private_pid_namespace") is not True or item.get("host_pid") is not False:
            _fail("orphan container binding is not private and non-host-PID")
        if item["scope"] == "dedicated_parent" and item.get("sole_worker_scope") is not True:
            _fail("dedicated parent must be the sole worker scope")
        if not isinstance(item.get("device_requests"), list) or len(item["device_requests"]) > 128:
            _fail("orphan container device requests are not bounded")
    _validate_expected(request.get("expected"))
    return dict(request)


def _validate_package_probe(
    probe: Any,
    package: Mapping[str, Any],
    *,
    expected_container_id: str | None,
    expected_image_id: str | None,
) -> dict[str, Any]:
    """Validate package bytes observed inside the exact Docker mount.

    The host-side operator cannot read Docker Desktop's Linux VM path.  A
    bounded probe produced by the pinned backend image therefore carries the
    receipt and complete artifact inventory; its container/image identity is
    bound to the Docker inspect supplied to ``build_orphan_request``.
    """

    probe = _mapping(probe, "cached package probe")
    required = {
        "schema", "container_id", "image_id", "package_root", "receipt_path",
        "receipt_sha256", "package_sha256", "read_only_mount", "state",
        "receipt", "artifacts",
    }
    if set(probe) != required:
        _fail("cached package probe fields are incomplete or unexpected")
    if probe.get("schema") != PACKAGE_PROBE_SCHEMA:
        _fail("cached package probe schema is unsupported")
    container_id = _container(probe.get("container_id"), "cached package probe container_id")
    image_id = _image(probe.get("image_id"), "cached package probe image_id")
    if expected_container_id is not None and container_id != _container(expected_container_id, "expected package probe container_id"):
        _fail("cached package probe came from a different backend container")
    if expected_image_id is not None and image_id != _image(expected_image_id, "expected package probe image_id"):
        _fail("cached package probe came from a different backend image")
    if probe.get("package_root") != "/opt/fullmag/package" or probe.get("receipt_path") != "/opt/fullmag/package/backend-build-receipt.json":
        _fail("cached package probe did not read the canonical package mount")
    if probe.get("read_only_mount") is not True or probe.get("state") != "succeeded":
        _fail("cached package probe does not prove a successful readonly package")
    receipt_sha = _sha(probe.get("receipt_sha256"), "cached package probe receipt_sha256", nonzero=True)
    package_sha = _sha(probe.get("package_sha256"), "cached package probe package_sha256", nonzero=True)
    if receipt_sha != package.get("receipt_sha256") or package_sha != package.get("package_sha256"):
        _fail("cached package probe digests differ from the pinned package")
    receipt = _mapping(probe.get("receipt"), "cached package probe receipt")
    if receipt.get("schema") != package["schema"] or receipt.get("state") != "succeeded":
        _fail("cached package probe receipt is not the pinned successful receipt")
    artifacts = _package_artifacts(receipt.get("artifacts"), "cached package probe receipt.artifacts")
    observed_artifacts = _package_artifacts(probe.get("artifacts"), "cached package probe artifacts")
    if artifacts != observed_artifacts:
        _fail("cached package probe artifact inventory differs from its receipt")
    lanes = receipt.get("execution_lanes")
    if not isinstance(lanes, Mapping) or set(lanes) != {"fdm-cpu", "fdm-gpu", "fem-cpu", "fem-gpu"}:
        _fail("cached package probe receipt does not attest all four execution lanes")
    return {
        "schema": PACKAGE_PROBE_SCHEMA,
        "container_id": container_id,
        "image_id": image_id,
        "package_root": "/opt/fullmag/package",
        "receipt_path": "/opt/fullmag/package/backend-build-receipt.json",
        "receipt_sha256": receipt_sha,
        "package_sha256": package_sha,
        "read_only_mount": True,
        "state": "succeeded",
        "receipt": receipt,
        "artifacts": observed_artifacts,
    }


def validate_cached_package_binding(
    value: Any,
    *,
    verify_filesystem: bool = True,
    package_probe: Mapping[str, Any] | None = None,
    expected_container_id: str | None = None,
    expected_image_id: str | None = None,
) -> dict[str, Any]:
    """Validate the exact successful package offered read-only to recovery.

    A local path is read and re-read when no probe is supplied.  A Docker VM
    path must instead include the full same-image package probe; a digest-only
    claim or an explicit ``verify_filesystem=False`` without that probe is
    rejected.
    """

    value = _mapping(value, "cached package")
    root = _path(value.get("root"), "cached package root")
    receipt = _path(value.get("receipt_path"), "cached package receipt")
    expected_receipt = root.rstrip("/\\") + "/backend-build-receipt.json"
    if not _same_path(receipt, expected_receipt):
        _fail("cached package receipt must be the direct package child")
    receipt_sha = _sha(value.get("receipt_sha256"), "cached package receipt_sha256", nonzero=True)
    package_sha = _sha(value.get("package_sha256"), "cached package package_sha256", nonzero=True)
    if value.get("read_only") is not True or value.get("state") != "succeeded":
        _fail("cached package is not a successful readonly package")
    if value.get("schema") != "fullmag.direct-compose.backend-build-receipt.v1":
        _fail("cached package has an unsupported receipt schema")
    embedded_probe = value.get("package_probe")
    if package_probe is not None and embedded_probe is not None and dict(package_probe) != dict(embedded_probe):
        _fail("cached package has conflicting package probes")
    probe = package_probe if package_probe is not None else embedded_probe
    normalized_probe = None
    if probe is not None:
        normalized_probe = _validate_package_probe(
            probe,
            value,
            expected_container_id=expected_container_id,
            expected_image_id=expected_image_id,
        )
    elif not verify_filesystem:
        _fail("cached package without a probe requires filesystem verification")
    else:
        root_path = Path(root)
        if root_path.is_symlink() or not root_path.is_dir():
            _fail("cached package root is not a real directory")
        raw = _read_regular(receipt, "cached package receipt", 16 * 1024 * 1024)
        if hashlib.sha256(raw).hexdigest() != receipt_sha:
            _fail("cached package receipt bytes differ from its pin")
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            _fail(f"cached package receipt is not valid JSON: {error}")
        parsed = _mapping(parsed, "cached package receipt")
        if parsed.get("schema") != value["schema"] or parsed.get("state") != "succeeded":
            _fail("cached package receipt is not a successful direct build")
    result = {
        "root": root,
        "receipt_path": receipt,
        "receipt_sha256": receipt_sha,
        "package_sha256": package_sha,
        "read_only": True,
        "state": "succeeded",
        "schema": value["schema"],
    }
    if normalized_probe is not None:
        result["package_probe"] = normalized_probe
    return result


def _owner_descriptor(pins: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
    owner = _nested_mapping(pins, "owner", "owner descriptor")
    if "value" in owner:
        value = _mapping(owner["value"], "owner descriptor value")
    elif "path" in owner:
        value, _ = _parse_json_file(owner["path"], "owner descriptor")
    else:
        value = _mapping(owner, "owner descriptor value")
    if value.get("state") != "failed":
        _fail("orphan recovery requires a Failed owner descriptor")
    children = value.get("children")
    if not isinstance(children, Sequence) or isinstance(children, (str, bytes)) or len(children) != 2:
        _fail("owner descriptor must have exactly two terminal children")
    roles = {child.get("role") for child in children if isinstance(child, Mapping)}
    if roles != {"compute", "preparation"} or any(
        not isinstance(child, Mapping) or child.get("status") not in {"exited_success", "exited_failure"}
        for child in children
    ):
        _fail("owner descriptor does not prove terminal compute and preparation children")
    digest = _value_digest(owner, "owner descriptor")
    if "path" in owner:
        parsed, _ = _parse_json_file(owner["path"], "owner descriptor")
        if parsed != value:
            _fail("owner descriptor value differs from its pinned file")
    return value, digest


def _run_fields(pins: Mapping[str, Any]) -> dict[str, Any]:
    run = _nested_mapping(pins, "run", "run binding")
    values = {
        "run_id": run.get("run_id", pins.get("run_id")),
        "task_id": run.get("task_id", pins.get("task_id")),
        "attempt_id": run.get("attempt_id", pins.get("attempt_id")),
        "ownership_epoch": run.get("ownership_epoch", pins.get("ownership_epoch")),
        "resource_id": run.get("resource_id", pins.get("resource_id")),
        "lease_token": run.get("lease_token", pins.get("lease_token")),
        "store_id": run.get("store_id", pins.get("store_id")),
        "host_id": run.get("host_id", pins.get("host_id")),
    }
    for key in ("run_id", "task_id", "attempt_id", "resource_id", "lease_token"):
        _portable_id(values[key], f"run.{key}")
    _store_id(values["store_id"], "run.store_id")
    _string(values["host_id"], "run.host_id")
    epoch = values["ownership_epoch"]
    if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch <= 0:
        _fail("run.ownership_epoch must be positive")
    return values


def build_orphan_request(
    pins: Mapping[str, Any], engine_doc: Mapping[str, Any], container_inspect: Mapping[str, Any]
) -> dict[str, Any]:
    """Build the exact native ``WorkerOrphanTeardownRequest`` JSON object.

    ``pins`` may carry SHA strings directly or bounded ``{"path", "sha256"}``
    records.  Supplied files are re-read before the request is produced.  The
    returned object deliberately has no request self-digest: native computes
    it from this exact object.
    """

    pins = _mapping(pins, "orphan recovery pins")
    engine_id = _engine_id(engine_doc, "Docker engine")
    run = _run_fields(pins)
    backend = _mapping(pins.get("backend", pins), "backend pin")
    backend = {**backend, "container_id": backend.get("container_id", container_inspect.get("Id"))}
    binding_pins: dict[str, Any] = {"backend": backend}
    if "backend_cache" in pins:
        binding_pins["backend_cache"] = pins["backend_cache"]
    binding = _container_binding(container_inspect, binding_pins, stopped=False)
    if binding["compose_project"] != pins.get("compose_project", binding["compose_project"]):
        _fail("backend Compose project differs from the pinned project")
    if binding["scope"] != "dedicated_parent" or binding["sole_worker_scope"] is not True:
        _fail("orphan recovery requires the exact dedicated backend parent scope")
    owner, owner_sha = _owner_descriptor(pins)
    request_id = _uuid_text(pins.get("request_id"), "request_id")
    gate = _mapping(pins.get("worker_launch_gate", pins.get("launch_gate")), "worker_launch_gate")
    if gate.get("state") != "consumed":
        _fail("orphan recovery requires the consumed launch gate")
    gate = {"state": "consumed", "token": _uuid_text(gate.get("token"), "worker_launch_gate.token")}
    expected = _validate_expected(pins.get("expected", {
        "reservation_state": "committed",
        "local_lease_state": "active",
        "started_receipt_absent": True,
        "worker_exit_receipt_absent": True,
        "container_state": "exited",
        "pid": 0,
        "finished_at_required": True,
        "descendant_count": 0,
        "task_outcome": "unknown",
        "solve_replay": False,
    }))
    request = {
        "schema_version": ORPHAN_REQUEST_SCHEMA,
        "request_id": request_id,
        "store_id": run["store_id"],
        "host_id": run["host_id"],
        "run_id": run["run_id"],
        "task_id": run["task_id"],
        "attempt_id": run["attempt_id"],
        "ownership_epoch": run["ownership_epoch"],
        "resource_id": run["resource_id"],
        "lease_token": run["lease_token"],
        "reservation_request_sha256": _required_canonical_digest(pins, "reservation_request_sha256", "reservation request", "reservation_request"),
        "reservation_before_sha256": _required_canonical_digest(pins, "reservation_before_sha256", "reservation before", "reservation_before"),
        "lease_before_sha256": _required_canonical_digest(pins, "lease_before_sha256", "lease before", "lease_before"),
        "runtime_generation_sha256": _required_digest(pins, "runtime_generation_sha256", "runtime generation", "runtime_generation"),
        "worker_launch_gate": gate,
        "run_receipt_sha256": _required_digest(pins, "run_receipt_sha256", "run receipt", "run_receipt"),
        "owner_sha256": owner_sha,
        "config_sha256": _required_digest(pins, "config_sha256", "runtime config", "config"),
        "launch_sha256": _required_digest(pins, "launch_sha256", "launch record", "launch"),
        "host_authorization_sha256": _required_digest(pins, "host_authorization_sha256", "host authorization", "host_authorization"),
        "windows_folder_host_sha256": _required_digest(pins, "windows_folder_host_sha256", "Windows folder host certificate", "windows_folder_host", "host_certificate"),
        "mount_attestation_sha256": _required_digest(pins, "mount_attestation_sha256", "mount attestation", "mount_attestation", "host_ledger_attestation"),
        "docker_engine_id_sha256": _engine_id_sha(engine_doc, pins),
        "containers": [{key: binding[key] for key in (
            "scope", "container_id", "image_id", "compose_project", "service", "config_sha256",
            "private_pid_namespace", "host_pid", "sole_worker_scope", "device_requests"
        )}],
        "expected": expected,
    }
    _validate_request_shape(request)
    package = pins.get("cached_package")
    if package is None:
        _fail("orphan recovery requires the verified cached package binding")
    package = validate_cached_package_binding(
        package,
        verify_filesystem=package.get("package_probe") is None,
        expected_container_id=binding["container_id"],
        expected_image_id=binding["image_id"],
    )
    cache = binding.get("backend_cache")
    if cache is None:
        if not _same_path(binding["package_bind"].get("Source"), package["root"]):
            _fail("backend package bind differs from the verified cached package root")
    else:
        if not _same_path(package["root"], cache["package_root"]):
            _fail("backend package root differs from the exact v2 cache target")
        expected_receipt = cache["package_root"].rstrip("/") + "/backend-build-receipt.json"
        if not _same_path(package["receipt_path"], expected_receipt):
            _fail("backend package receipt differs from the exact v2 cache target")
    _validate_quiescence(pins.get("quiescence"))
    return request


def validate_orphan_request(request: Mapping[str, Any]) -> dict[str, Any]:
    """Validate a request before writing it for the native recovery service."""

    return _validate_request_shape(request)


def validate_run_binding(run: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the exact run/lease identity independently of Docker."""

    return _run_fields({"run": run})


def validate_quiescence(value: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the all-groups quiescence proof used before stopping B."""

    return _validate_quiescence(value)


def _manifest_digest(manifest: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    manifest = _mapping(manifest, "teardown manifest")
    path = manifest.get("path", manifest.get("manifest_path"))
    if path is None:
        _fail("teardown manifest requires an external path")
    expected = _sha(manifest.get("sha256", manifest.get("manifest_sha256")), "manifest_sha256", nonzero=True)
    raw = _read_regular(_path(path, "external teardown manifest path"), "external teardown manifest", 16 * 1024 * 1024)
    if hashlib.sha256(raw).hexdigest() != expected:
        _fail("external teardown manifest bytes differ from its SHA-256")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"external teardown manifest is not valid JSON: {error}")
    return expected, _mapping(document, "external teardown manifest")


def _validate_manifest_observation(
    document: Mapping[str, Any], request_container: Mapping[str, Any]
) -> dict[str, Any]:
    """Check the factual before/after proof retained outside the Rust attestation."""

    document = _mapping(document, "external teardown manifest")
    expected_devices = request_container["device_requests"]
    expected_id = request_container["container_id"]
    expected_image = request_container["image_id"]
    before = _mapping(document.get("before"), "external teardown before observation")
    after = _mapping(document.get("after"), "external teardown after observation")
    for label, observed in (("before", before), ("after", after)):
        if observed.get("container_id") != expected_id or observed.get("image_id") != expected_image:
            _fail(f"external teardown {label} observation differs from the exact container")
        if observed.get("service") != "backend" or observed.get("role") != "backend":
            _fail(f"external teardown {label} observation is not the dedicated backend role")
        user = observed.get("user")
        if not isinstance(user, str) or user in {"", "0", "0:0", "root"}:
            _fail(f"external teardown {label} observation is not unprivileged")
        if observed.get("private_pid_namespace") is not True or observed.get("host_pid") is not False:
            _fail(f"external teardown {label} observation is not a private PID namespace")
        if observed.get("device_requests") != expected_devices:
            _fail(f"external teardown {label} DeviceRequests differ from the exact backend")
    if before.get("state") not in {"running", "restarting"} or not isinstance(before.get("pid"), int) or before["pid"] <= 0:
        _fail("external teardown before observation does not prove a live backend")
    if after.get("state") != "exited" or after.get("pid") != 0 or not isinstance(after.get("finished_at"), str) or not after["finished_at"].strip() or after.get("descendant_count") != 0:
        _fail("external teardown after observation does not prove factual exit and no descendants")
    _finished_timestamp(after["finished_at"])
    return {"before": before, "after": after}


def _device_requests_sha(devices: Any) -> str:
    if not isinstance(devices, list):
        _fail("Docker DeviceRequests must be a list")
    return canonical_json_sha256(devices)


def _finished_timestamp(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        _fail("Docker teardown has no FinishedAt")
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as error:
        _fail(f"Docker FinishedAt is not RFC3339: {error}")
    if parsed.tzinfo is None:
        _fail("Docker FinishedAt must include a timezone")
    return parsed.astimezone(timezone.utc)


def _observed_container(request_container: Mapping[str, Any], inspect: Mapping[str, Any], *, stopped: bool) -> dict[str, Any]:
    pins = {"backend": dict(request_container)}
    actual = _container_binding(inspect, pins, stopped=stopped, require_binds=False)
    if actual["container_id"] != request_container["container_id"] or actual["image_id"] != request_container["image_id"]:
        _fail("Docker teardown observation differs from request identity")
    if actual["config_sha256"] != request_container["config_sha256"]:
        _fail("Docker teardown observation differs from request Config digest")
    if actual["device_requests"] != request_container["device_requests"]:
        _fail("Docker teardown observation differs from request DeviceRequests")
    if stopped:
        state = _state(inspect)
        return {
            "state": "exited",
            "pid": 0,
            "finished_at": state["FinishedAt"],
            "descendant_count": 0,
            "private_pid_namespace": True,
            "host_pid": False,
            "device_requests_sha256": _device_requests_sha(actual["device_requests"]),
        }
    return {
        "private_pid_namespace": True,
        "host_pid": False,
        "device_requests_sha256": _device_requests_sha(actual["device_requests"]),
    }


def build_teardown_attestation(
    request: Mapping[str, Any],
    engine_before: Mapping[str, Any],
    engine_after: Mapping[str, Any],
    beforeinspect: Mapping[str, Any],
    afterinspect: Mapping[str, Any],
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    """Build the exact native Docker namespace teardown attestation."""

    request = validate_orphan_request(request)
    before_engine = _engine_id(engine_before, "engine_before")
    after_engine = _engine_id(engine_after, "engine_after")
    expected_engine_sha = hashlib.sha256(before_engine.encode("utf-8")).hexdigest()
    if before_engine != after_engine or expected_engine_sha != request["docker_engine_id_sha256"]:
        _fail("Docker engine identity changed during orphan teardown")
    request_container = request["containers"][0]
    before = _observed_container(request_container, beforeinspect, stopped=False)
    after = _observed_container(request_container, afterinspect, stopped=True)
    _finished_timestamp(after["finished_at"])
    manifest_sha, manifest_document = _manifest_digest(manifest)
    _validate_manifest_observation(manifest_document, request_container)
    release = _mapping(manifest_document.get("device_release"), "device release")
    if release.get("resource_id") != request["resource_id"] or release.get("mapping_detached") is not True:
        _fail("teardown manifest does not prove exact device release")
    mapping_sha = _sha(release.get("mapping_sha256"), "device release mapping_sha256", nonzero=True)
    gpu_uuid = release.get("gpu_uuid")
    if gpu_uuid is not None:
        _string(gpu_uuid, "device release gpu_uuid")
    return {
        "schema_version": TEARDOWN_ATTESTATION_SCHEMA,
        "request_sha256": canonical_json_sha256(request),
        "docker_engine_id_sha256": request["docker_engine_id_sha256"],
        "containers": [{
            "container_id": request_container["container_id"],
            "image_id": request_container["image_id"],
            "config_sha256": request_container["config_sha256"],
            "before": before,
            "after": after,
        }],
        "device_release": {
            "resource_id": request["resource_id"],
            **({"gpu_uuid": gpu_uuid} if gpu_uuid is not None else {}),
            "mapping_sha256": mapping_sha,
            "mapping_detached": True,
        },
        "manifest_sha256": manifest_sha,
        "result": "authoritative_teardown",
    }


def validate_teardown_attestation(request: Mapping[str, Any], attestation: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the native attestation shape and exact request binding."""

    request = validate_orphan_request(request)
    attestation = _mapping(attestation, "teardown attestation")
    if attestation.get("schema_version") != TEARDOWN_ATTESTATION_SCHEMA:
        _fail("unsupported Docker teardown attestation schema")
    if attestation.get("request_sha256") != canonical_json_sha256(request):
        _fail("Docker teardown attestation is for a different request")
    if attestation.get("docker_engine_id_sha256") != request["docker_engine_id_sha256"]:
        _fail("Docker teardown attestation is for a different engine")
    _sha(attestation.get("manifest_sha256"), "attestation.manifest_sha256", nonzero=True)
    observations = attestation.get("containers")
    if not isinstance(observations, list) or len(observations) != len(request["containers"]):
        _fail("Docker teardown attestation container count differs from request")
    for observed in observations:
        observed = _mapping(observed, "Docker teardown observation")
        request_container = next((item for item in request["containers"] if item["container_id"] == observed.get("container_id")), None)
        if request_container is None:
            _fail("Docker teardown attestation has an unknown container")
        if observed.get("image_id") != request_container["image_id"] or observed.get("config_sha256") != request_container["config_sha256"]:
            _fail("Docker teardown attestation container identity differs")
        before = _mapping(observed.get("before"), "Docker before observation")
        after = _mapping(observed.get("after"), "Docker after observation")
        device_sha = _device_requests_sha(request_container["device_requests"])
        if before.get("private_pid_namespace") is not True or before.get("host_pid") is not False or before.get("device_requests_sha256") != device_sha:
            _fail("Docker before observation does not match the private GPU namespace")
        if after.get("state") != "exited" or after.get("pid") != 0 or not after.get("finished_at") or after.get("descendant_count") != 0 or after.get("private_pid_namespace") is not True or after.get("host_pid") is not False or after.get("device_requests_sha256") != device_sha:
            _fail("Docker after observation does not prove factual namespace teardown")
        _finished_timestamp(after["finished_at"])
    release = _mapping(attestation.get("device_release"), "device release")
    if release.get("resource_id") != request["resource_id"] or release.get("mapping_detached") is not True:
        _fail("Docker teardown does not prove exact device release")
    _sha(release.get("mapping_sha256"), "device release mapping_sha256", nonzero=True)
    if attestation.get("result") != "authoritative_teardown":
        _fail("Docker teardown attestation is not authoritative")
    return dict(attestation)


def _validate_native_completion(request: Mapping[str, Any], native_result: Mapping[str, Any]) -> dict[str, Any]:
    """Require the exact completed result emitted by the typed Rust command."""

    result = _mapping(native_result, "native orphan recovery result")
    expected_request_sha = canonical_json_sha256(request)
    expected_fields = {
        "schema_version",
        "status",
        "request_sha256",
        "started",
        "solve_replayed",
        "startup_replayed",
        "result",
    }
    if set(result) != expected_fields:
        _fail("native result has unexpected or missing completion fields")
    if result.get("schema_version") != NATIVE_ORPHAN_RESULT_SCHEMA:
        _fail("native result schema is not the orphan teardown completion contract")
    if result.get("status") != "completed":
        _fail("native result is not a completed orphan recovery")
    if result.get("request_sha256") != expected_request_sha:
        _fail("native result is for a different request")
    for field in ("started", "solve_replayed", "startup_replayed"):
        if result.get(field) is not False:
            _fail(f"native result does not prove {field}=false")
    reservation = _mapping(result.get("result"), "native released reservation")
    if reservation.get("state") != "released":
        _fail("native orphan recovery did not release the exact reservation")
    if reservation.get("request_sha256") != request["reservation_request_sha256"]:
        _fail("native released reservation has a different request identity")
    _sha(reservation.get("release_proof_sha256"), "native release_proof_sha256", nonzero=True)
    gate = _mapping(reservation.get("worker_launch_gate"), "native worker launch gate")
    if gate != request["worker_launch_gate"] or gate.get("state") != "consumed":
        _fail("native released reservation does not retain the consumed launch gate")
    identity = _mapping(reservation.get("identity"), "native released reservation identity")
    expected_identity = {
        "store_id": request["store_id"],
        "run_id": request["run_id"],
        "task_id": request["task_id"],
        "resource_id": request["resource_id"],
        "owner": {
            "kind": "solver",
            "attempt_id": request["attempt_id"],
            "ownership_epoch": request["ownership_epoch"],
        },
        "lease_token": request["lease_token"],
    }
    if identity != expected_identity:
        _fail("native released reservation identity differs from the exact request")
    return result


def finalize(request: Mapping[str, Any], attestation: Mapping[str, Any], native_result: Mapping[str, Any]) -> dict[str, Any]:
    """Build an immutable host receipt after native completion succeeds."""

    request = validate_orphan_request(request)
    attestation = validate_teardown_attestation(request, attestation)
    _validate_native_completion(request, native_result)
    return {
        "schema": FINAL_RECEIPT_SCHEMA,
        "protocol_version": 2,
        "request_sha256": canonical_json_sha256(request),
        "attestation_sha256": canonical_json_sha256(attestation),
        "run_id": request["run_id"],
        "task_id": request["task_id"],
        "container_id": request["containers"][0]["container_id"],
        "outcome": "await_reconciliation",
        "history_immutable": True,
        "solve_replayed": False,
    }


def pin(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return build_teardown_attestation(*args, **kwargs)


def prepare(*args: Any, **kwargs: Any) -> dict[str, Any]:
    return build_orphan_request(*args, **kwargs)


def _publish_no_replace(temporary: Path, candidate: Path) -> None:
    """Atomically publish a same-directory file without replacing a record."""

    if os.name == "nt":
        # MOVEFILE_REPLACE_EXISTING is deliberately omitted.  WRITE_THROUGH
        # makes the flushed temporary bytes reach the volume before the
        # no-replace rename is acknowledged.
        import ctypes
        from ctypes import wintypes

        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.MoveFileExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
        api.MoveFileExW.restype = wintypes.BOOL
        if not api.MoveFileExW(str(temporary), str(candidate), 0x00000008):
            error_code = ctypes.get_last_error()
            if error_code in {80, 183}:  # ERROR_FILE_EXISTS / ERROR_ALREADY_EXISTS
                raise FileExistsError(error_code, "immutable history destination already exists")
            raise OSError(error_code, "atomic no-replace publication failed")
        return

    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    parent_fd = os.open(str(candidate.parent), flags)
    try:
        # A hard link is the POSIX no-replace primitive: it either creates the
        # destination atomically or fails with EEXIST, and never overwrites it.
        os.link(temporary.name, candidate.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
        os.unlink(temporary.name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def write_immutable_json(path: str | Path, value: Mapping[str, Any]) -> str:
    """Publish one canonical history record without overwrite or replay mutation."""

    candidate = Path(_path(str(path), "immutable history path"))
    raw = _canonical(value)
    _reject_symlink_ancestors(candidate.parent, "immutable history path")
    if candidate.exists() or candidate.is_symlink():
        existing = _read_regular(candidate, "existing immutable history record")
        if existing != raw:
            _fail("immutable history record already exists with different bytes")
        return hashlib.sha256(existing).hexdigest()
    parent = candidate.parent
    parent.mkdir(parents=True, exist_ok=True)
    _reject_symlink_ancestors(parent, "immutable history path")
    temporary = parent / f".{candidate.name}.{uuid.uuid4().hex}.tmp"
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_BINARY", 0)
    )
    descriptor = None
    try:
        descriptor = os.open(str(temporary), flags, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            _publish_no_replace(temporary, candidate)
        except FileExistsError:
            existing = _read_regular(candidate, "raced immutable history record")
            if existing != raw:
                _fail("immutable history publication raced with a different record")
        except OSError as error:
            raise error
    except OSError as error:
        _fail(f"cannot publish immutable history record: {error}")
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            if temporary.is_symlink() or temporary.exists():
                temporary.unlink()
        except OSError:
            pass
    return hashlib.sha256(raw).hexdigest()


__all__ = [
    "FINAL_RECEIPT_SCHEMA",
    "NATIVE_CANCELLATION_SCHEMA",
    "NATIVE_ORPHAN_RESULT_SCHEMA",
    "ORPHAN_REQUEST_SCHEMA",
    "OrphanRecoveryError",
    "PACKAGE_PROBE_SCHEMA",
    "TEARDOWN_ATTESTATION_SCHEMA",
    "build_orphan_request",
    "build_teardown_attestation",
    "canonical_json_sha256",
    "finalize",
    "pin",
    "prepare",
    "validate_cached_package_binding",
    "validate_orphan_request",
    "validate_quiescence",
    "validate_run_binding",
    "validate_teardown_attestation",
    "write_immutable_json",
]
