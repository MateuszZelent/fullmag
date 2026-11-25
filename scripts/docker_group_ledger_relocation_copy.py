"""Copy an inspected ledger under the caller's live native relocation fence.

This module owns byte transfer only. Rust owns reservation states, proofs,
policy, quiescence and preview; the managed caller must keep its fence alive
until source revalidation and target preview both succeed.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import stat


class LedgerCopyError(RuntimeError):
    pass


_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


def _parts(value):
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise LedgerCopyError("Invalid ledger manifest path")
    path = PurePosixPath(value)
    if not path.parts or path.is_absolute() or str(path) != value or any(part in {".", ".."} for part in path.parts):
        raise LedgerCopyError("Ledger manifest path escapes its root")
    return path.parts


def validate_manifest(inspection):
    if not isinstance(inspection, dict) or inspection.get("schema_version") != "fullmag.group-ledger-relocation-inspection.v1":
        raise LedgerCopyError("Native relocation inspection is required")
    rows, directories = inspection.get("manifest"), inspection.get("directories")
    if not isinstance(rows, list) or not rows or not isinstance(directories, list):
        raise LedgerCopyError("Native manifest and directory inventory are required")
    paths = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"path", "size_bytes", "sha256"}:
            raise LedgerCopyError("Malformed native manifest entry")
        _parts(row["path"])
        if type(row["size_bytes"]) is not int or row["size_bytes"] < 0 or not isinstance(row["sha256"], str) or not _SHA256.fullmatch(row["sha256"]):
            raise LedgerCopyError("Invalid native manifest size or SHA-256")
        paths.append(row["path"])
    if paths != sorted(set(paths)) or directories != sorted(set(directories)):
        raise LedgerCopyError("Native manifest must have sorted unique identities")
    directory_set = set(directories)
    for value in directories:
        _parts(value)
    if directory_set.intersection(paths):
        raise LedgerCopyError("Manifest file and directory identities overlap")
    for value in [*directories, *paths]:
        parent = PurePosixPath(value).parent
        while str(parent) != ".":
            if str(parent) not in directory_set:
                raise LedgerCopyError("Native manifest omitted a parent directory")
            parent = parent.parent
    return rows, directories


def _directory(root_fd, parts):
    current = os.dup(root_fd)
    try:
        for part in parts:
            next_fd = os.open(part, _DIR_FLAGS, dir_fd=current)
            os.close(current)
            current = next_fd
        return current
    except BaseException:
        os.close(current)
        raise


def _identity(metadata):
    return (metadata.st_dev, metadata.st_ino, metadata.st_size,
            metadata.st_mtime_ns, metadata.st_ctime_ns, metadata.st_nlink)


def _inventory(root_fd, prefix=""):
    files, directories = [], []
    for name in sorted(os.listdir(root_fd)):
        relative = prefix + name
        _parts(relative)
        metadata = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        if stat.S_ISDIR(metadata.st_mode):
            directories.append(relative)
            child = os.open(name, _DIR_FLAGS, dir_fd=root_fd)
            try:
                nested_files, nested_directories = _inventory(child, relative + "/")
                files.extend(nested_files)
                directories.extend(nested_directories)
            finally:
                os.close(child)
        elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
            files.append(relative)
        else:
            raise LedgerCopyError("Ledger contains a link, device or unsupported entry: " + relative)
    return sorted(files), sorted(directories)


def copy_snapshot(source_root, target_parent, inspection):
    """Create target_parent/ledger without overwriting any existing ledger.

    Both roots are fixed mounts supplied by the managed controller, not paths
    accepted from the inspection JSON. Partial output is retained on failure;
    this function does not publish a migration receipt or authorize adoption.
    """
    rows, directories = validate_manifest(inspection)
    source_root, target_parent = Path(source_root), Path(target_parent)
    if not source_root.is_absolute() or not target_parent.is_absolute():
        raise LedgerCopyError("Relocation mount paths must be absolute")
    source_fd = os.open(source_root, _DIR_FLAGS)
    parent_fd = target_fd = None
    try:
        if _inventory(source_fd) != ([row["path"] for row in rows], directories):
            raise LedgerCopyError("Source inventory differs from native inspection")
        parent_fd = os.open(target_parent, _DIR_FLAGS)
        if _identity(os.fstat(source_fd))[:2] == _identity(os.fstat(parent_fd))[:2]:
            raise LedgerCopyError("Source and target must differ")
        os.mkdir("ledger", 0o750, dir_fd=parent_fd)
        target_fd = os.open("ledger", _DIR_FLAGS, dir_fd=parent_fd)
        for relative in sorted(directories, key=lambda value: (len(_parts(value)), value)):
            parts = _parts(relative)
            parent = _directory(target_fd, parts[:-1])
            try:
                os.mkdir(parts[-1], 0o750, dir_fd=parent)
            finally:
                os.close(parent)
        for row in rows:
            parts = _parts(row["path"])
            source_parent = _directory(source_fd, parts[:-1])
            destination_parent = _directory(target_fd, parts[:-1])
            try:
                read_fd = os.open(parts[-1], _FILE_FLAGS, dir_fd=source_parent)
                with os.fdopen(read_fd, "rb") as source:
                    before = os.fstat(source.fileno())
                    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != row["size_bytes"]:
                        raise LedgerCopyError("Source file shape differs: " + row["path"])
                    write_fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                       stat.S_IMODE(before.st_mode), dir_fd=destination_parent)
                    digest = hashlib.sha256()
                    with os.fdopen(write_fd, "wb") as target:
                        remaining = row["size_bytes"] + 1
                        copied = 0
                        while remaining:
                            block = source.read(min(1024 * 1024, remaining))
                            if not block:
                                break
                            remaining -= len(block)
                            copied += len(block)
                            if copied > row["size_bytes"]:
                                raise LedgerCopyError("Source grew during transfer: " + row["path"])
                            digest.update(block)
                            target.write(block)
                        target.flush()
                        os.fchmod(target.fileno(), stat.S_IMODE(before.st_mode))
                        os.fsync(target.fileno())
                    if digest.hexdigest() != row["sha256"] or _identity(os.fstat(source.fileno())) != _identity(before):
                        raise LedgerCopyError("Source file changed during transfer: " + row["path"])
                os.fsync(destination_parent)
            finally:
                os.close(source_parent)
                os.close(destination_parent)
        expected = ([row["path"] for row in rows], directories)
        if _inventory(source_fd) != expected or _inventory(target_fd) != expected:
            raise LedgerCopyError("Ledger inventory changed during transfer")
        os.fsync(target_fd)
        os.fsync(parent_fd)
        return {"files": len(rows), "directories": len(directories),
                "bytes": sum(row["size_bytes"] for row in rows), "target_preview_required": True}
    finally:
        for descriptor in (target_fd, parent_fd, source_fd):
            if descriptor is not None:
                os.close(descriptor)
