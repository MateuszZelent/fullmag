"""Bound the private Cargo incremental cache in an owned backend workspace.

Cargo's target layout is internal and versioned. This collector only admits
crate-cache directory names confirmed in the repository's local Cargo fixture;
a changed layout fails closed until it is reviewed.
"""
from __future__ import annotations

import errno
import json
import os
import re
import stat
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

OWNER_MARKER = ".fullmag-direct-backend-owner.json"
OWNER_SCHEMA = "fullmag.direct-compose.backend-workspace.v1"
WORKSPACE_INVENTORY_SCHEMA = "fullmag.direct-compose.workspace-inventory.v1"
RETENTION_SCHEMA = "fullmag.backend-compiler-cache-retention.v1"
DEFAULT_MAX_INCREMENTAL_BYTES = 8 * 1024**3
INCREMENTAL_RELATIVE = Path(
    ".fullmag-build/cargo-targets/direct/backend-dev/incremental"
)

# Observed locally: normalized crate name plus a 13-character base-36 hash.
_CARGO_CRATE_DIRECTORY = re.compile(r"^[A-Za-z0-9_]+-[a-z0-9]{13}$")
_RETIRED_DIRECTORY = re.compile(
    r"^\.fullmag-retired-([A-Za-z0-9_]+-[a-z0-9]{13})-([0-9a-f]{32})$"
)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MOUNT_ESCAPE = re.compile(r"\\([0-7]{3})")
_MAX_OWNER_MARKER_BYTES = 16 * 1024
_DIRECTORY_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
)


class BackendCompilerCacheError(RuntimeError):
    """Raised when the owned incremental cache cannot be safely collected."""


@dataclass(frozen=True)
class _File:
    top: str
    device: int
    inode: int
    blocks: int
    mtime_ns: int


def _fail(message: str) -> None:
    raise BackendCompilerCacheError(message)


def _is_sha256(value: Any) -> bool:
    return isinstance(value, str) and _SHA256.fullmatch(value) is not None


def _json_no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("backend workspace owner marker has duplicate JSON keys")
        result[key] = value
    return result


def _open_absolute_directory(path: Path) -> int | None:
    if not path.is_absolute() or path == Path(path.anchor) or ".." in path.parts:
        _fail("backend workspace must be an absolute non-root path without traversal")
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        _fail("platform cannot safely open workspace directories without following links")
    descriptor = os.open(path.anchor, _DIRECTORY_FLAGS)
    try:
        for component in path.parts[1:]:
            try:
                child = os.open(component, _DIRECTORY_FLAGS, dir_fd=descriptor)
            except FileNotFoundError:
                os.close(descriptor)
                return None
            except OSError as error:
                if error.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise BackendCompilerCacheError(
                        f"backend workspace path contains a symlink or non-directory: {component}"
                    ) from error
                raise
            os.close(descriptor)
            descriptor = child
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            _fail("backend workspace is not a real directory")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _read_owner_marker(workspace_fd: int, workspace_device: int) -> dict[str, Any]:
    try:
        descriptor = os.open(
            OWNER_MARKER,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
            dir_fd=workspace_fd,
        )
    except OSError as error:
        raise BackendCompilerCacheError(
            f"backend workspace owner marker cannot be opened safely: {error}"
        ) from error
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_dev != workspace_device
        ):
            _fail("backend workspace owner marker is not one regular local file")
        content = bytearray()
        while len(content) <= _MAX_OWNER_MARKER_BYTES:
            chunk = os.read(descriptor, min(4096, _MAX_OWNER_MARKER_BYTES + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
        if len(content) > _MAX_OWNER_MARKER_BYTES:
            _fail("backend workspace owner marker exceeds its size limit")
    finally:
        os.close(descriptor)

    try:
        marker = json.loads(bytes(content), object_pairs_hook=_json_no_duplicates)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise BackendCompilerCacheError(
            "backend workspace owner marker is malformed"
        ) from error
    if not isinstance(marker, Mapping) or marker.get("schema") != OWNER_SCHEMA:
        _fail("backend workspace owner marker has an unsupported schema")
    if marker.get("state") != "ready":
        _fail("backend workspace owner marker is not ready")
    if not _is_sha256(marker.get("source_digest")):
        _fail("backend workspace owner marker has an invalid source digest")

    inventory_present = (
        "workspace_inventory_schema" in marker
        or "workspace_inventory_sha256" in marker
    )
    if inventory_present:
        if (
            marker.get("workspace_inventory_schema") != WORKSPACE_INVENTORY_SCHEMA
            or marker.get("workspace_inventory_sha256") != marker.get("source_digest")
        ):
            _fail("backend workspace owner marker inventory binding is invalid")

    # Current live markers bind their inventory and source-manifest digest.
    # Archive reconciliation emits the same inventory binding plus a tar hash,
    # without source_mode or live_manifest_sha256. Older archive-ready markers
    # may lack inventory fields, so retain their existing source-tar proof.
    source_mode = marker.get("source_mode")
    source_tar_digest = marker.get("source_tar_sha256")
    live_manifest_digest = marker.get("live_manifest_sha256")
    if source_mode == "live-shadow-v1":
        if (
            not inventory_present
            or not _is_sha256(live_manifest_digest)
            or source_tar_digest is not None
        ):
            _fail("backend workspace owner live-source proof is invalid")
    elif source_mode is None:
        if live_manifest_digest is not None or not _is_sha256(source_tar_digest):
            _fail("backend workspace owner archive-source proof is invalid")
    else:
        _fail("backend workspace owner marker has an unsupported ready format")
    return dict(marker)


def _mountpoints() -> set[str]:
    try:
        lines = Path("/proc/self/mountinfo").read_text(encoding="ascii").splitlines()
    except OSError as error:
        raise BackendCompilerCacheError(
            "cannot verify mount boundaries for the compiler cache"
        ) from error
    result: set[str] = set()
    for line in lines:
        fields = line.split()
        if len(fields) < 6:
            _fail("mount table contains a malformed entry")
        mountpoint = _MOUNT_ESCAPE.sub(
            lambda match: chr(int(match.group(1), 8)), fields[4]
        )
        if not mountpoint.startswith("/"):
            _fail("mount table contains a non-absolute mountpoint")
        result.add(mountpoint)
    return result


def _check_mount_boundary(
    absolute_path: Path,
    root_device: int,
    metadata: os.stat_result,
    mountpoints: set[str],
    *,
    is_incremental_root: bool = False,
) -> None:
    if metadata.st_dev != root_device:
        _fail(f"compiler cache crosses a filesystem boundary: {absolute_path}")
    if not is_incremental_root and str(absolute_path) in mountpoints:
        _fail(f"compiler cache crosses a mount boundary: {absolute_path}")


def _open_child_directory(
    parent_fd: int,
    component: str,
    absolute_path: Path,
    root_device: int,
    mountpoints: set[str],
) -> int:
    try:
        descriptor = os.open(component, _DIRECTORY_FLAGS, dir_fd=parent_fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise BackendCompilerCacheError(
                f"symlink or non-directory in compiler cache path: {absolute_path}"
            ) from error
        raise
    metadata = os.fstat(descriptor)
    if not stat.S_ISDIR(metadata.st_mode):
        os.close(descriptor)
        _fail(f"compiler cache entry is not a directory: {absolute_path}")
    try:
        _check_mount_boundary(absolute_path, root_device, metadata, mountpoints)
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def _scan_directory(
    descriptor: int,
    *,
    absolute_directory: Path,
    relative_directory: tuple[str, ...],
    inherited_top: str | None,
    root_device: int,
    mountpoints: set[str],
    files_by_top: dict[str, list[_File]],
) -> None:
    try:
        entries = list(os.scandir(descriptor))
    except OSError as error:
        raise BackendCompilerCacheError(
            f"cannot inventory compiler cache directory: {absolute_directory}"
        ) from error
    for entry in sorted(entries, key=lambda item: item.name):
        name = entry.name
        if name in {"", ".", ".."} or "/" in name or "\x00" in name:
            _fail("compiler cache contains an unsafe entry name")
        absolute_path = absolute_directory / name
        try:
            metadata = entry.stat(follow_symlinks=False)
        except OSError as error:
            raise BackendCompilerCacheError(
                f"compiler cache changed during inventory: {absolute_path}"
            ) from error
        mode = metadata.st_mode
        if stat.S_ISLNK(mode):
            _fail(f"symlink in compiler cache: {absolute_path}")
        if stat.S_ISDIR(mode):
            if not relative_directory:
                if _CARGO_CRATE_DIRECTORY.fullmatch(name):
                    top = name
                elif _RETIRED_DIRECTORY.fullmatch(name):
                    top = name
                else:
                    _fail(f"unknown incremental entry: {name}")
                files_by_top.setdefault(top, [])
            else:
                top = inherited_top
                if top is None:
                    _fail("compiler cache directory is outside a recognized crate entry")
            child_fd = _open_child_directory(
                descriptor, name, absolute_path, root_device, mountpoints
            )
            try:
                opened = os.fstat(child_fd)
                if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
                    _fail(f"compiler cache directory changed during inventory: {absolute_path}")
                _scan_directory(
                    child_fd,
                    absolute_directory=absolute_path,
                    relative_directory=relative_directory + (name,),
                    inherited_top=top,
                    root_device=root_device,
                    mountpoints=mountpoints,
                    files_by_top=files_by_top,
                )
            finally:
                os.close(child_fd)
            continue
        if stat.S_ISREG(mode):
            if not relative_directory or inherited_top is None:
                _fail(f"unknown incremental entry: {name}")
            _check_mount_boundary(absolute_path, root_device, metadata, mountpoints)
            blocks = getattr(metadata, "st_blocks", None)
            if isinstance(blocks, bool) or not isinstance(blocks, int) or blocks < 0:
                _fail(f"compiler cache file has no allocated-block metadata: {absolute_path}")
            files_by_top[inherited_top].append(
                _File(inherited_top, metadata.st_dev, metadata.st_ino, blocks, metadata.st_mtime_ns)
            )
            continue
        _fail(f"special file in compiler cache: {absolute_path}")


def _scan_incremental(
    root_fd: int,
    root_path: Path,
    root_device: int,
    mountpoints: set[str],
) -> dict[str, list[_File]]:
    _check_mount_boundary(
        root_path,
        root_device,
        os.fstat(root_fd),
        mountpoints,
        is_incremental_root=True,
    )
    files_by_top: dict[str, list[_File]] = {}
    _scan_directory(
        root_fd,
        absolute_directory=root_path,
        relative_directory=(),
        inherited_top=None,
        root_device=root_device,
        mountpoints=mountpoints,
        files_by_top=files_by_top,
    )
    return files_by_top


def _allocated_bytes(
    names: set[str], files_by_top: Mapping[str, list[_File]]
) -> int:
    inodes: dict[tuple[int, int], int] = {}
    for name in names:
        for item in files_by_top.get(name, ()):
            identity = (item.device, item.inode)
            inodes[identity] = max(inodes.get(identity, 0), item.blocks)
    return sum(blocks * 512 for blocks in inodes.values())


def _delete_retired_directory(
    root_fd: int,
    name: str,
    root_path: Path,
    root_device: int,
    mountpoints: set[str],
) -> None:
    directory = _open_child_directory(
        root_fd, name, root_path / name, root_device, mountpoints
    )
    try:
        # Recheck the complete tree immediately before the first unlink.
        scratch: dict[str, list[_File]] = {name: []}
        _scan_directory(
            directory,
            absolute_directory=root_path / name,
            relative_directory=(name,),
            inherited_top=name,
            root_device=root_device,
            mountpoints=mountpoints,
            files_by_top=scratch,
        )
        _remove_tree_contents(
            directory,
            absolute_directory=root_path / name,
            root_device=root_device,
            mountpoints=mountpoints,
        )
    finally:
        os.close(directory)
    os.rmdir(name, dir_fd=root_fd)
    os.fsync(root_fd)


def _remove_tree_contents(
    directory_fd: int,
    *,
    absolute_directory: Path,
    root_device: int,
    mountpoints: set[str],
) -> None:
    """Unlink an already inventoried tree using directory-relative calls."""

    try:
        entries = list(os.scandir(directory_fd))
    except OSError as error:
        raise BackendCompilerCacheError(
            f"cannot remove retired compiler cache directory: {absolute_directory}"
        ) from error
    for entry in sorted(entries, key=lambda item: item.name):
        name = entry.name
        path = absolute_directory / name
        try:
            metadata = entry.stat(follow_symlinks=False)
        except OSError as error:
            raise BackendCompilerCacheError(
                f"retired compiler cache changed during removal: {path}"
            ) from error
        if stat.S_ISLNK(metadata.st_mode):
            _fail(f"symlink in retired compiler cache: {path}")
        if stat.S_ISDIR(metadata.st_mode):
            child = _open_child_directory(
                directory_fd, name, path, root_device, mountpoints
            )
            try:
                opened = os.fstat(child)
                if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
                    _fail(f"retired compiler cache changed during removal: {path}")
                _remove_tree_contents(
                    child,
                    absolute_directory=path,
                    root_device=root_device,
                    mountpoints=mountpoints,
                )
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=directory_fd)
            continue
        if stat.S_ISREG(metadata.st_mode):
            _check_mount_boundary(path, root_device, metadata, mountpoints)
            try:
                file_fd = os.open(
                    name,
                    os.O_RDONLY
                    | getattr(os, "O_NOFOLLOW", 0)
                    | getattr(os, "O_CLOEXEC", 0),
                    dir_fd=directory_fd,
                )
            except OSError as error:
                raise BackendCompilerCacheError(
                    f"retired compiler cache file changed during removal: {path}"
                ) from error
            try:
                opened = os.fstat(file_fd)
                if (
                    not stat.S_ISREG(opened.st_mode)
                    or (opened.st_dev, opened.st_ino)
                    != (metadata.st_dev, metadata.st_ino)
                ):
                    _fail(f"retired compiler cache file changed during removal: {path}")
            finally:
                os.close(file_fd)
            os.unlink(name, dir_fd=directory_fd)
            continue
        _fail(f"special file in retired compiler cache: {path}")
    os.fsync(directory_fd)


def _open_incremental_directory(
    workspace_fd: int,
    workspace: Path,
    workspace_device: int,
    mountpoints: set[str],
) -> tuple[int | None, Path]:
    descriptor = os.dup(workspace_fd)
    current_path = workspace
    try:
        for component in INCREMENTAL_RELATIVE.parts:
            current_path = current_path / component
            try:
                child = os.open(component, _DIRECTORY_FLAGS, dir_fd=descriptor)
            except FileNotFoundError:
                os.close(descriptor)
                return None, workspace / INCREMENTAL_RELATIVE
            except OSError as error:
                if error.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise BackendCompilerCacheError(
                        f"symlink or non-directory in incremental cache path: {current_path}"
                    ) from error
                raise
            try:
                _check_mount_boundary(
                    current_path, workspace_device, os.fstat(child), mountpoints
                )
            except BaseException:
                os.close(child)
                raise
            os.close(descriptor)
            descriptor = child
        return descriptor, current_path
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise


def _validated_limit(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _fail("max_incremental_bytes must be a nonnegative integer")
    return value


def collect(
    workspace: Path, *, max_incremental_bytes: int = DEFAULT_MAX_INCREMENTAL_BYTES
) -> dict[str, Any]:
    """Prune oldest whole Cargo crate caches to an allocated-byte limit.

    Only workspace/.fullmag-build/cargo-targets/direct/backend-dev/incremental
    is inspected or changed. The byte budget counts st_blocks * 512 once per
    unique regular-file inode beneath that directory. Hardlinks outside it
    remain intact; their blocks may therefore remain allocated on the device.
    The caller must hold the backend runtime build lock.
    """
    limit = _validated_limit(max_incremental_bytes)
    try:
        workspace_path = Path(workspace)
    except (TypeError, ValueError) as error:
        raise BackendCompilerCacheError("workspace must be a filesystem path") from error
    if not workspace_path.is_absolute() or ".." in workspace_path.parts:
        _fail("workspace must be absolute and contain no traversal component")
    workspace_path = Path(os.path.normpath(str(workspace_path)))

    workspace_fd = _open_absolute_directory(workspace_path)
    if workspace_fd is None:
        return {
            "schema": RETENTION_SCHEMA,
            "state": "missing",
            "workspace": str(workspace_path),
            "incremental_root": str(workspace_path / INCREMENTAL_RELATIVE),
            "accounting": "unique-inode-allocated-blocks",
            "max_incremental_bytes": limit,
            "before_bytes": 0,
            "after_bytes": 0,
            "recovery_bytes_before": 0,
            "removed_bytes": 0,
            "removed_paths": [],
            "removed_crates": [],
            "retained_crates": [],
        }
    incremental_fd: int | None = None
    try:
        workspace_stat = os.fstat(workspace_fd)
        _read_owner_marker(workspace_fd, workspace_stat.st_dev)
        mountpoints = _mountpoints()
        incremental_fd, incremental_path = _open_incremental_directory(
            workspace_fd, workspace_path, workspace_stat.st_dev, mountpoints
        )
        if incremental_fd is None:
            return {
                "schema": RETENTION_SCHEMA,
                "state": "missing",
                "workspace": str(workspace_path),
                "incremental_root": str(incremental_path),
                "accounting": "unique-inode-allocated-blocks",
                "max_incremental_bytes": limit,
                "before_bytes": 0,
                "after_bytes": 0,
                "recovery_bytes_before": 0,
                "removed_bytes": 0,
                "removed_paths": [],
                "removed_crates": [],
                "retained_crates": [],
            }

        root_device = os.fstat(incremental_fd).st_dev
        files_by_top = _scan_incremental(
            incremental_fd, incremental_path, root_device, mountpoints
        )
        active = {
            name for name in files_by_top
            if _CARGO_CRATE_DIRECTORY.fullmatch(name)
        }
        retired = {
            name for name in files_by_top
            if _RETIRED_DIRECTORY.fullmatch(name)
        }
        before_bytes = _allocated_bytes(active, files_by_top)
        recovery_bytes = _allocated_bytes(retired, files_by_top)

        removal_order = sorted(
            active,
            key=lambda name: (
                max((item.mtime_ns for item in files_by_top[name]), default=0),
                name,
            ),
        )
        selected: list[str] = []
        remaining = set(active)
        for name in removal_order:
            if _allocated_bytes(remaining, files_by_top) <= limit:
                break
            selected.append(name)
            remaining.remove(name)

        # The complete incremental tree was verified above, before any rename
        # or unlink. Retired directories are invisible to Cargo and let a later
        # invocation finish cleanup after process interruption.
        removed_paths: list[str] = []
        removed_crates: list[str] = []
        for name in sorted(retired):
            _delete_retired_directory(
                incremental_fd, name, incremental_path, root_device, mountpoints
            )
            removed_paths.append((INCREMENTAL_RELATIVE / name).as_posix())

        for name in selected:
            retired_name = f".fullmag-retired-{name}-{uuid.uuid4().hex}"
            try:
                os.stat(retired_name, dir_fd=incremental_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                _fail("temporary compiler cache retirement name already exists")
            os.rename(
                name,
                retired_name,
                src_dir_fd=incremental_fd,
                dst_dir_fd=incremental_fd,
            )
            os.fsync(incremental_fd)
            _delete_retired_directory(
                incremental_fd, retired_name, incremental_path, root_device, mountpoints
            )
            removed_paths.append((INCREMENTAL_RELATIVE / name).as_posix())
            removed_crates.append(name)

        after_tree = _scan_incremental(
            incremental_fd, incremental_path, root_device, mountpoints
        )
        after_active = {
            name for name in after_tree
            if _CARGO_CRATE_DIRECTORY.fullmatch(name)
        }
        after_bytes = _allocated_bytes(after_active, after_tree)
        if after_bytes > limit:
            _fail("compiler cache remains over its byte budget after collection")
        return {
            "schema": RETENTION_SCHEMA,
            "state": "complete",
            "workspace": str(workspace_path),
            "incremental_root": str(incremental_path),
            "accounting": "unique-inode-allocated-blocks",
            "max_incremental_bytes": limit,
            "before_bytes": before_bytes,
            "after_bytes": after_bytes,
            "recovery_bytes_before": recovery_bytes,
            "removed_bytes": max(0, before_bytes - after_bytes),
            "removed_paths": removed_paths,
            "removed_crates": removed_crates,
            "retained_crates": sorted(after_active),
        }
    finally:
        if incremental_fd is not None:
            os.close(incremental_fd)
        os.close(workspace_fd)
