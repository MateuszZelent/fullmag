"""Bounded, read-only provenance for a selected user-owned source script."""

from __future__ import annotations

import hashlib
import os
import re
import stat
import unicodedata
from pathlib import Path


SCHEMA = "fullmag.selected-script-origin.v1"
MAX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_RELATIVE_PATH_BYTES = 1024
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_DIRECTORY_FLAGS = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
                    | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
_FILE_FLAGS = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
               | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
_ASCII_UPPER = str.maketrans("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
_RESERVED = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}


def _supports_safe_openat() -> bool:
    return (
        all(hasattr(os, name) for name in ("O_DIRECTORY", "O_NOFOLLOW", "O_NONBLOCK"))
        and os.open in getattr(os, "supports_dir_fd", set())
        and os.stat in getattr(os, "supports_dir_fd", set())
        and os.stat in getattr(os, "supports_follow_symlinks", set())
    )


def _require_safe_openat() -> None:
    if not _supports_safe_openat():
        raise OSError("selected source capture requires no-follow openat support")


def _validated_relative_path(value: object) -> str:
    if (not isinstance(value, str) or not value or "\\" in value
            or value.startswith("/") or value.endswith("/")):
        raise ValueError("source_relative is not a canonical portable relative path")
    if len(value.encode("utf-8")) > MAX_RELATIVE_PATH_BYTES:
        raise ValueError("source_relative exceeds the supported path bound")
    for component in value.split("/"):
        if (not component or component in {".", ".."}
                or len(component.encode("utf-8")) > 255
                or component.endswith((" ", "."))
                or any(unicodedata.category(char) == "Cc" or char in '<>:"|?*'
                       for char in component)):
            raise ValueError("source_relative is not a canonical portable relative path")
        stem = component.split(".", 1)[0].rstrip(" ").translate(_ASCII_UPPER)
        if stem in _RESERVED:
            raise ValueError("source_relative contains a reserved path component")
        if (stem.startswith(("COM", "LPT"))
                and stem[3:] in {"1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"}):
            raise ValueError("source_relative contains a reserved path component")
    return value


def validate_source_origin(value: object) -> dict | None:
    """Validate the exact optional wire DTO; ``None`` is a legacy absence."""
    if value is None:
        return None
    fields = {"schema", "source_relative", "source_sha256", "source_size_bytes"}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("source_origin has an invalid closed shape")
    if value.get("schema") != SCHEMA:
        raise ValueError("source_origin schema is unsupported")
    relative = _validated_relative_path(value.get("source_relative"))
    digest = value.get("source_sha256")
    size = value.get("source_size_bytes")
    if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
        raise ValueError("source_origin SHA-256 must be lowercase hexadecimal")
    if type(size) is not int or not 0 < size <= MAX_SOURCE_BYTES:
        raise ValueError("source_origin size is outside the supported bound")
    return {
        "schema": SCHEMA,
        "source_relative": relative,
        "source_sha256": digest,
        "source_size_bytes": size,
    }


def _canonical_absolute(path: object, name: str) -> str:
    if not isinstance(path, (str, os.PathLike)):
        raise ValueError(f"{name} must be an absolute canonical path")
    try:
        raw = os.fspath(path)
    except TypeError as error:
        raise ValueError(f"{name} must be an absolute canonical path") from error
    if (not isinstance(raw, str) or not raw.startswith("/") or "\\" in raw
            or "\x00" in raw or os.path.normpath(raw) != raw):
        raise ValueError(f"{name} must be an absolute canonical path")
    if any(part in {".", ".."} for part in raw.split("/")[1:]):
        raise ValueError(f"{name} must be an absolute canonical path")
    return raw


def _open_directory(path: str) -> int:
    _require_safe_openat()
    descriptor = os.open("/", _DIRECTORY_FLAGS)
    try:
        components = path.split("/")[1:]
        for component in components:
            if not component:
                continue
            child = os.open(component, _DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise ValueError("selected source root is not a directory")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _directory_identity(metadata: os.stat_result) -> tuple[int, int, int]:
    return metadata.st_dev, metadata.st_ino, stat.S_IFMT(metadata.st_mode)


def _file_identity(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        stat.S_IFMT(metadata.st_mode),
        stat.S_IMODE(metadata.st_mode),
        metadata.st_nlink,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _open_parent(root_fd: int, relative: str) -> tuple[int, str, tuple[tuple[int, int, int], ...]]:
    components = relative.split("/")
    current = os.dup(root_fd)
    identities = []
    try:
        for component in components[:-1]:
            child = os.open(component, _DIRECTORY_FLAGS, dir_fd=current)
            metadata = os.fstat(child)
            if not stat.S_ISDIR(metadata.st_mode):
                os.close(child)
                raise ValueError("selected source path has a non-directory component")
            identities.append(_directory_identity(metadata))
            os.close(current)
            current = child
        return current, components[-1], tuple(identities)
    except Exception:
        os.close(current)
        raise


def _read_source(root: str, relative: str) -> tuple[str, int]:
    root_fd = _open_directory(root)
    try:
        root_identity = _directory_identity(os.fstat(root_fd))
        parent_fd, leaf, directory_chain = _open_parent(root_fd, relative)
        try:
            path_before = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISREG(path_before.st_mode) or path_before.st_nlink != 1:
                raise ValueError("selected source must be a singly-linked regular file")
            if not 0 < path_before.st_size <= MAX_SOURCE_BYTES:
                raise ValueError("selected source size is outside the supported bound")
            descriptor = os.open(leaf, _FILE_FLAGS, dir_fd=parent_fd)
            try:
                opened_before = os.fstat(descriptor)
                if (_file_identity(path_before) != _file_identity(opened_before)
                        or not stat.S_ISREG(opened_before.st_mode)
                        or opened_before.st_nlink != 1):
                    raise ValueError("selected source changed while it was opened")
                digest = hashlib.sha256()
                total = 0
                while True:
                    chunk = os.read(descriptor, min(1024 * 1024, MAX_SOURCE_BYTES + 1 - total))
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_SOURCE_BYTES:
                        raise ValueError("selected source exceeds its byte bound")
                    digest.update(chunk)
                opened_after = os.fstat(descriptor)
                path_after = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
                if (_file_identity(opened_before) != _file_identity(opened_after)
                        or _file_identity(opened_after) != _file_identity(path_after)
                        or total != opened_after.st_size):
                    raise ValueError("selected source changed while it was hashed")
                result = digest.hexdigest(), total
            finally:
                os.close(descriptor)
        finally:
            os.close(parent_fd)

        # Rewalk from the selected root after hashing. This pins the path, not
        # merely the inode that happened to be opened before a rename.
        current_root = _open_directory(root)
        try:
            if _directory_identity(os.fstat(current_root)) != root_identity:
                raise ValueError("selected source root changed while it was hashed")
            current_parent, current_leaf, current_chain = _open_parent(current_root, relative)
            try:
                current_path = os.stat(current_leaf, dir_fd=current_parent, follow_symlinks=False)
                if (current_chain != directory_chain
                        or _file_identity(current_path) != _file_identity(opened_after)):
                    raise ValueError("selected source path changed while it was hashed")
            finally:
                os.close(current_parent)
        finally:
            os.close(current_root)
        return result
    finally:
        os.close(root_fd)


def capture_source_origin(script: object, source_root: Path = Path("/opt/fullmag/source")) -> dict | None:
    """Capture the exact selected-tree origin of a user-owned script, if supported."""
    if not isinstance(script, dict) or script.get("origin") != "user_file":
        return None
    script_path = script.get("path")
    if not isinstance(script_path, str) or not script_path.startswith("/"):
        raise ValueError("user_file session script has no absolute path")
    root = _canonical_absolute(source_root, "source_root")
    if script_path == root or not script_path.startswith(root.rstrip("/") + "/"):
        return None
    relative = _validated_relative_path(script_path[len(root.rstrip("/")) + 1:])
    digest, size = _read_source(root, relative)
    return validate_source_origin({
        "schema": SCHEMA,
        "source_relative": relative,
        "source_sha256": digest,
        "source_size_bytes": size,
    })


def revalidate_source_origin(origin: object, script: object, root: Path = Path("/opt/fullmag/source")) -> dict | None:
    """Re-capture and require the witness to remain identical; ``None`` stays absent."""
    expected = validate_source_origin(origin)
    actual = capture_source_origin(script, source_root=root)
    if expected != actual:
        raise ValueError("selected script source origin changed during terminal observation")
    return actual
