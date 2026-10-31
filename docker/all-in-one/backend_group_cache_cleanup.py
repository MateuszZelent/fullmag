"""Safe cleanup for one explicitly owned backend group compiler tree."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
from typing import Any, Mapping

MODE_ENV = "FULLMAG_PRIVATE_GROUP_STORAGE"
MODE = "group-volume-v1"
CACHE_RECEIPT_SCHEMA = "fullmag.direct-compose.backend-volume-cache-receipt.v1"
CACHE_SCHEMA = "fullmag.backend-build-cache.v2"
OWNER_SCHEMA = "fullmag.backend-build-cache-owner.v2"
WORKSPACE_SCHEMA = "fullmag.direct-compose.backend-workspace.v1"
CLEANUP_SCHEMA = "fullmag.direct-compose.group-build-cleanup.v1"
OWNER_MARKER = ".fullmag-backend-cache-owner.json"
OWNER_READBACK = ".fullmag-backend-cache-readback"
WORKSPACE_MARKER = ".fullmag-direct-backend-owner.json"
CACHE_ROOT_NAME = ".fullmag-build"
VOLUME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,127}$")
HEX_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_RECORD_BYTES = 1024 * 1024


class BackendGroupCacheCleanupError(RuntimeError):
    """A group build cache could not be proven safe to clean."""


def _fail(message: str) -> None:
    raise BackendGroupCacheCleanupError(message)


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _reparse(metadata: os.stat_result) -> bool:
    return stat.S_ISLNK(metadata.st_mode) or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)


def _plain_directory(path: Path, label: str) -> os.stat_result:
    try:
        metadata = path.lstat()
    except OSError as error:
        _fail(f"cannot inspect {label}: {error}")
    if _reparse(metadata) or not stat.S_ISDIR(metadata.st_mode):
        _fail(f"{label} is not a plain directory")
    return metadata


def _regular_bytes(path: Path, label: str, maximum: int) -> tuple[bytes, os.stat_result]:
    try:
        before = path.lstat()
        if _reparse(before) or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            _fail(f"{label} is not one regular file")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                _fail(f"{label} changed during open")
            if opened.st_size > maximum:
                _fail(f"{label} exceeds its size bound")
            chunks: list[bytes] = []
            total = 0
            while True:
                block = os.read(descriptor, min(65536, maximum + 1 - total))
                if not block:
                    break
                chunks.append(block)
                total += len(block)
                if total > maximum:
                    _fail(f"{label} exceeds its size bound")
            after = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
            ):
                _fail(f"{label} changed while reading")
            return b"".join(chunks), after
        finally:
            os.close(descriptor)
    except BackendGroupCacheCleanupError:
        raise
    except OSError as error:
        _fail(f"cannot read {label}: {error}")


def _read_json(path: Path, label: str) -> dict[str, Any]:
    raw, _ = _regular_bytes(path, label, MAX_RECORD_BYTES)
    try:
        value = json.loads(raw)
    except (TypeError, ValueError, UnicodeDecodeError) as error:
        raise BackendGroupCacheCleanupError(f"{label} is malformed") from error
    if not isinstance(value, dict):
        _fail(f"{label} is not an object")
    return value


def validate_group_cache_identity(
    cache_identity: Mapping[str, Any], *, build_root: Path | None = None,
    package_root: Path | None = None,
) -> dict[str, str]:
    """Validate the profile-independent group binding carried by the cache receipt."""
    if os.environ.get(MODE_ENV) != MODE:
        _fail("private group storage mode is not enabled")
    if not isinstance(cache_identity, Mapping):
        _fail("backend cache identity is missing")
    if (cache_identity.get("schema") != CACHE_RECEIPT_SCHEMA
            or cache_identity.get("cache_schema") != CACHE_SCHEMA
            or cache_identity.get("state") != "ready"
            or cache_identity.get("storage") != "docker-named-volume"):
        _fail("backend cache identity is not a ready named-volume receipt")
    unit_key = cache_identity.get("unit_key")
    owner_id = cache_identity.get("owner_id")
    if not isinstance(unit_key, str) or HEX_RE.fullmatch(unit_key) is None or owner_id != unit_key:
        _fail("backend cache identity has an invalid stable group owner")
    if (os.environ.get("FULLMAG_SHARED_BACKEND_UNIT_KEY") != unit_key
            or os.environ.get("FULLMAG_SHARED_BACKEND_GROUP") != f"groups/{unit_key}"):
        _fail("shared package namespace is not bound to the stable group unit")
    volumes = cache_identity.get("volume_names")
    targets = cache_identity.get("targets")
    if not isinstance(volumes, Mapping) or not isinstance(targets, Mapping):
        _fail("backend cache identity lacks volume names or mount targets")
    names: dict[str, str] = {}
    for role in ("build", "package", "control"):
        value = volumes.get(role)
        if not isinstance(value, str) or VOLUME_RE.fullmatch(value) is None:
            _fail(f"backend cache identity has an invalid {role} volume name")
        names[role] = value
    if names["build"] != names["control"]:
        _fail("group build volume differs from its stable BuildControl volume")
    if os.environ.get("FULLMAG_SHARED_BACKEND_VOLUME") != names["package"]:
        _fail("shared package volume differs from the group cache receipt")
    target_paths: dict[str, Path] = {}
    for role in ("build", "package", "control"):
        raw = targets.get(role)
        path = Path(raw) if isinstance(raw, str) else Path()
        if (not isinstance(raw, str) or not path.is_absolute() or ".." in path.parts
                or (os.name != "nt" and "\\" in raw)):
            _fail(f"backend cache identity has an invalid {role} mount target")
        target_paths[role] = path
    expected_receipt = target_paths["control"] / "backend" / "backend-volume-cache-receipt.json"
    if targets.get("receipt") != str(expected_receipt):
        _fail("backend cache receipt is outside the fixed control namespace")
    if build_root is not None and target_paths["build"] != build_root:
        _fail("backend cache build target differs from the compiler workspace")
    if package_root is not None and target_paths["package"] != package_root:
        _fail("backend cache package target differs from the package mount")
    return {
        "unit_key": unit_key,
        "owner_id": owner_id,
        "build_volume": names["build"],
        "package_volume": names["package"],
        "control_volume": names["control"],
        "build_root": str(target_paths["build"]),
        "package_root": str(target_paths["package"]),
        "control_root": str(target_paths["control"]),
    }


def _validate_build_owner(build_root: Path, binding: Mapping[str, str]) -> os.stat_result:
    root_metadata = _plain_directory(build_root, "group backend build volume root")
    marker_path = build_root / OWNER_MARKER
    marker_raw, marker_metadata = _regular_bytes(marker_path, "group backend build volume owner", 16 * 1024)
    marker = _read_json(marker_path, "group backend build volume owner")
    expected = {
        "schema": OWNER_SCHEMA, "state": "owned", "unit_key": binding["unit_key"],
        "owner_id": binding["owner_id"], "role": "build",
        "volume_name": binding["build_volume"], "uid": 65532, "gid": 65532,
    }
    if marker != expected or marker_raw != _canonical(expected) + b"\n":
        _fail("group backend build volume owner marker differs from the current unit")
    readback_path = build_root / OWNER_READBACK
    readback, _ = _regular_bytes(readback_path, "group backend build volume probe", 16 * 1024)
    expected_probe = b"fullmag-cache-readback:" + hashlib.sha256(_canonical(expected)).hexdigest().encode("ascii")
    if readback != expected_probe:
        _fail("group backend build volume owner probe did not read back")
    if os.name != "nt" and os.geteuid() == 65532 and (
        (marker_metadata.st_uid, marker_metadata.st_gid) != (65532, 65532)
    ):
        _fail("group backend build volume owner record has a foreign OS owner")
    return root_metadata


def _same_volume(metadata: os.stat_result, volume_device: int) -> bool:
    return metadata.st_dev == volume_device


def _scan_cache_tree(root: Path, volume_device: int) -> dict[str, int]:
    counts = {"files": 0, "directories": 0, "bytes": 0}
    if not root.exists() and not root.is_symlink():
        return counts
    metadata = _plain_directory(root, "compiler output root")
    if not _same_volume(metadata, volume_device) or os.path.ismount(root):
        _fail("compiler output root crosses a volume boundary")

    def visit(directory: Path) -> None:
        try:
            entries = tuple(os.scandir(directory))
        except OSError as error:
            _fail(f"cannot inspect compiler output directory: {error}")
        for entry in entries:
            try:
                item = entry.stat(follow_symlinks=False)
            except OSError as error:
                _fail(f"cannot inspect compiler output entry {entry.name}: {error}")
            if _reparse(item):
                # Native caches often contain library symlinks. Count and unlink
                # the directory entry only; never inspect its target.
                counts["files"] += 1
                continue
            if not _same_volume(item, volume_device):
                _fail(f"compiler output crosses a volume boundary: {entry.name}")
            if stat.S_ISDIR(item.st_mode):
                if os.path.ismount(entry.path):
                    _fail(f"compiler output contains a nested mount: {entry.name}")
                counts["directories"] += 1
                visit(Path(entry.path))
            elif stat.S_ISREG(item.st_mode):
                counts["files"] += 1
                counts["bytes"] += item.st_size
            else:
                _fail(f"compiler output contains a special file: {entry.name}")
    visit(root)
    return counts


def _remove_owned_cache_tree(root: Path, _inventory: Mapping[str, int]) -> None:
    """Remove the reserved root without following links at any level."""
    if os.name == "posix" and all(function in os.supports_dir_fd for function in (os.open, os.stat, os.unlink, os.rmdir)):
        nofollow = getattr(os, "O_NOFOLLOW", 0)
        directory = getattr(os, "O_DIRECTORY", 0)
        parent_fd = os.open(root.parent, os.O_RDONLY | directory | nofollow)
        try:
            volume_device = os.fstat(parent_fd).st_dev
            root_meta = os.stat(root.name, dir_fd=parent_fd, follow_symlinks=False)
            if (_reparse(root_meta) or not stat.S_ISDIR(root_meta.st_mode)
                    or not _same_volume(root_meta, volume_device)):
                _fail("compiler output root changed before removal")
            root_fd = os.open(root.name, os.O_RDONLY | directory | nofollow, dir_fd=parent_fd)
            try:
                opened = os.fstat(root_fd)
                if (opened.st_dev, opened.st_ino) != (root_meta.st_dev, root_meta.st_ino):
                    _fail("compiler output root changed during removal")
                _remove_at(root_fd, volume_device)
            finally:
                os.close(root_fd)
            latest = os.stat(root.name, dir_fd=parent_fd, follow_symlinks=False)
            if (latest.st_dev, latest.st_ino) != (root_meta.st_dev, root_meta.st_ino):
                _fail("compiler output root changed before final removal")
            os.rmdir(root.name, dir_fd=parent_fd)
        finally:
            os.close(parent_fd)
        return

    # Windows test/development fallback: every component is lstat-checked and
    # link/reparse entries are rejected before traversing or deleting them.
    volume_device = root.parent.stat().st_dev
    def remove_path(path: Path) -> None:
        metadata = path.lstat()
        if _reparse(metadata):
            if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
                path.rmdir()  # Windows junction: remove the reparse point only.
            else:
                path.unlink()
            return
        if not _same_volume(metadata, volume_device):
            _fail(f"compiler output crossed a volume boundary: {path.name}")
        if stat.S_ISDIR(metadata.st_mode):
            for entry in tuple(path.iterdir()):
                remove_path(entry)
            path.rmdir()
        elif stat.S_ISREG(metadata.st_mode):
            path.unlink()
        else:
            _fail(f"compiler output changed to a special file: {path.name}")
    remove_path(root)


def _remove_at(directory_fd: int, volume_device: int) -> None:
    for name in os.listdir(directory_fd):
        metadata = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if _reparse(metadata):
            # Unlink a link/reparse entry itself without following it.
            os.unlink(name, dir_fd=directory_fd)
            continue
        if not _same_volume(metadata, volume_device):
            _fail(f"compiler output crossed a volume boundary: {name}")
        if stat.S_ISDIR(metadata.st_mode):
            child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                opened = os.fstat(child_fd)
                if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
                    _fail(f"compiler output directory changed during removal: {name}")
                _remove_at(child_fd, volume_device)
            finally:
                os.close(child_fd)
            current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
                _fail(f"compiler output directory changed before removal: {name}")
            os.rmdir(name, dir_fd=directory_fd)
        elif stat.S_ISREG(metadata.st_mode):
            os.unlink(name, dir_fd=directory_fd)
        else:
            _fail(f"compiler output contains a special file: {name}")


def _safe_control_receipt(control_root: Path) -> Path:
    _plain_directory(control_root, "group control volume root")
    backend = control_root / "backend"
    if not backend.exists():
        backend.mkdir()
    _plain_directory(backend, "group backend control namespace")
    return backend / "group-build-cleanup.json"


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    parent = _plain_directory(path.parent, "group build cleanup receipt directory")
    temporary = path.parent / f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp"
    if path.exists() or path.is_symlink():
        _regular_bytes(path, "group build cleanup receipt", MAX_RECORD_BYTES)
    raw = _canonical(value)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(temporary, flags, 0o660)
        try:
            view = memoryview(raw)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    _fail("short write while recording group build cleanup")
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, path)
        if os.name == "posix":
            directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    except BackendGroupCacheCleanupError:
        raise
    except OSError as error:
        try:
            temporary.unlink()
        except OSError:
            pass
        _fail(f"cannot publish group build cleanup receipt: {error}")
    if (parent.st_dev, parent.st_ino) != (path.parent.stat().st_dev, path.parent.stat().st_ino):
        _fail("group build cleanup receipt directory changed during publication")


def _receipt_matches(receipt: Mapping[str, Any], binding: Mapping[str, str], workspace: Path) -> bool:
    return (
        receipt.get("schema") == CLEANUP_SCHEMA
        and receipt.get("unit_key") == binding["unit_key"]
        and receipt.get("owner_id") == binding["owner_id"]
        and receipt.get("build_volume") == binding["build_volume"]
        and receipt.get("package_volume") == binding["package_volume"]
        and receipt.get("workspace") == str(workspace)
        and receipt.get("target") == CACHE_ROOT_NAME
    )


def cleanup_group_compiler_outputs(
    workspace: str | os.PathLike[str], *, cache_identity: Mapping[str, Any],
    phase: str = "pre-build",
) -> dict[str, Any]:
    """Clear only the owned `.fullmag-build` tree and persist resumable evidence."""
    if phase not in {"pre-build", "post-publish"}:
        _fail("group compiler cleanup phase is unsupported")
    workspace = Path(workspace)
    if not workspace.is_absolute() or workspace.name != "workspace":
        _fail("group compiler workspace must be the absolute backend workspace")
    build_root = workspace.parent
    binding = validate_group_cache_identity(cache_identity, build_root=build_root)
    build_metadata = _validate_build_owner(build_root, binding)
    _plain_directory(workspace, "group backend workspace")
    marker = _read_json(workspace / WORKSPACE_MARKER, "backend workspace owner marker")
    if marker.get("schema") != WORKSPACE_SCHEMA or marker.get("state") != "ready":
        _fail("backend workspace source owner is not ready")
    cache_root = workspace / CACHE_ROOT_NAME
    counts = _scan_cache_tree(cache_root, build_metadata.st_dev)
    receipt_path = _safe_control_receipt(Path(binding["control_root"]))
    existing = _read_json(receipt_path, "group build cleanup receipt") if receipt_path.exists() or receipt_path.is_symlink() else None
    if existing is not None and not _receipt_matches(existing, binding, workspace):
        _fail("group cleanup receipt belongs to a different volume or workspace")
    if existing is not None and existing.get("state") == "started":
        started = {**existing, "phase": phase}
        counts = {
            "files": int(existing.get("planned_files", 0)),
            "directories": int(existing.get("planned_directories", 0)),
            "bytes": int(existing.get("planned_bytes", 0)),
        }
    else:
        if existing is not None and existing.get("state") != "completed":
            _fail("group cleanup receipt has an unsupported state")
        started = {
            "schema": CLEANUP_SCHEMA, "state": "started", "phase": phase,
            "unit_key": binding["unit_key"], "owner_id": binding["owner_id"],
            "build_volume": binding["build_volume"],
            "package_volume": binding["package_volume"], "control_volume": binding["control_volume"],
            "workspace": str(workspace), "target": CACHE_ROOT_NAME,
            "started_at_ns": time.time_ns(), "planned_files": counts["files"],
            "planned_directories": counts["directories"], "planned_bytes": counts["bytes"],
        }
        _write_json(receipt_path, started)
    if cache_root.exists() or cache_root.is_symlink():
        try:
            _remove_owned_cache_tree(cache_root, counts)
        except BackendGroupCacheCleanupError:
            raise
        except OSError as error:
            _fail(f"group compiler cleanup was interrupted: {error}")
    result = {
        **started, "state": "completed", "phase": phase,
        "completed_at_ns": time.time_ns(),
        "removed_paths": [CACHE_ROOT_NAME] if counts["files"] or counts["directories"] else [],
        "removed_files": counts["files"], "removed_directories": counts["directories"],
        "removed_bytes": counts["bytes"], "receipt_path": str(receipt_path),
    }
    _write_json(receipt_path, result)
    return result
