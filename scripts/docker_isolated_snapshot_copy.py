"""Create and copy bounded Linux trees without mutating their source."""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import unicodedata


SNAPSHOT_SCHEMA = "fullmag.isolated-tree-snapshot.v1"
DEFAULT_MAX_FILES = 20_000
DEFAULT_MAX_BYTES = 32 * 1024**3
MAX_DIRECTORIES = 20_000
MAX_TREE_ENTRIES = DEFAULT_MAX_FILES + MAX_DIRECTORIES
MAX_DEPTH = 64
MAX_OWNER_BYTES = 64 * 1024
HASH_CHUNK_BYTES = 1024 * 1024
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MANIFEST_KEYS = {
    "schema", "source_root", "root_identity", "directories", "files",
    "total_bytes", "file_count", "directory_count",
}
_FILE_KEYS = {"path", "size", "sha256", "mode", "inode", "mtime_ns"}


class SnapshotError(ValueError):
    """A tree or writer lock could not be proved safe for a snapshot."""


def _linux_only() -> None:
    if (not sys.platform.startswith("linux") or not hasattr(os, "O_NOFOLLOW")
            or not hasattr(os, "O_DIRECTORY")):
        raise RuntimeError("isolated snapshots are supported only on Linux")


def _strict_limit(value: int, label: str) -> int:
    if type(value) is not int or value < 0:
        raise ValueError(label + " must be a nonnegative integer")
    return value


def _identity(metadata: os.stat_result) -> tuple[int, ...]:
    """Capture stable identity fields; ordinary reads may update atime."""
    return (
        metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_nlink,
        metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns,
        metadata.st_uid, metadata.st_gid,
    )


def _directory_flags() -> int:
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def _canonical_existing_directory(value: Path, label: str) -> Path:
    if not isinstance(value, (str, os.PathLike)):
        raise TypeError(label + " must be a path")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise SnapshotError(label + " must be an absolute canonical path")
    try:
        resolved = path.resolve(strict=True)
        metadata = os.stat(path, follow_symlinks=False)
    except OSError as error:
        raise SnapshotError(label + " is missing or cannot be resolved") from error
    if path != resolved or not stat.S_ISDIR(metadata.st_mode):
        raise SnapshotError(label + " must be a canonical real directory")
    if str(path) == "/":
        raise SnapshotError("filesystem root is not a safe snapshot source")
    return path


def _canonical_destination(value: Path) -> tuple[Path, Path, str]:
    if not isinstance(value, (str, os.PathLike)):
        raise TypeError("destination must be a path")
    destination = Path(value)
    if (not destination.is_absolute() or ".." in destination.parts
            or destination.parent == destination):
        raise SnapshotError("destination must be an absolute canonical path")
    try:
        parent = destination.parent.resolve(strict=True)
    except OSError as error:
        raise SnapshotError("destination parent must already exist") from error
    if parent != destination.parent:
        raise SnapshotError("destination parent must not contain symlink components")
    name = destination.name
    _safe_component(name)
    return parent / name, parent, name


def _safe_component(name: str) -> str:
    if (not isinstance(name, str) or not name or name in {".", ".."}
            or "/" in name or "\\" in name or ":" in name
            or unicodedata.normalize("NFC", name) != name):
        raise SnapshotError("tree contains an unsafe or noncanonical path component")
    try:
        name.encode("utf-8", "strict")
    except UnicodeEncodeError as error:
        raise SnapshotError("tree contains a non-UTF-8 path component") from error
    if any(unicodedata.category(character) == "Cc" for character in name):
        raise SnapshotError("tree contains a control character in a path")
    return name


def _safe_relative_path(value: str) -> str:
    if not isinstance(value, str) or not value or value.startswith("/"):
        raise SnapshotError("manifest contains an unsafe relative path")
    parts = value.split("/")
    if any(not part for part in parts):
        raise SnapshotError("manifest path is not canonical")
    for part in parts:
        _safe_component(part)
    if PurePosixPath(value).as_posix() != value:
        raise SnapshotError("manifest path is not canonical")
    return value


def _same_identity(actual: os.stat_result | tuple[int, ...], expected: os.stat_result | tuple[int, ...],
                   label: str) -> None:
    actual_identity = _identity(actual) if isinstance(actual, os.stat_result) else actual
    expected_identity = _identity(expected) if isinstance(expected, os.stat_result) else expected
    if actual_identity != expected_identity:
        raise SnapshotError(label + " changed during the read-only operation")


def _same_directory_object(actual: os.stat_result | tuple[int, ...],
                           expected: os.stat_result | tuple[int, ...], label: str) -> None:
    actual_identity = _identity(actual) if isinstance(actual, os.stat_result) else actual
    expected_identity = _identity(expected) if isinstance(expected, os.stat_result) else expected
    if (actual_identity[:2] != expected_identity[:2]
            or stat.S_IFMT(actual_identity[2]) != stat.S_IFMT(expected_identity[2])):
        raise SnapshotError(label + " no longer names the same directory")


def _open_directory_path(
    path: Path,
) -> tuple[int, list[tuple[int, str, int, tuple[int, ...]]]]:
    """Open every path component without following links and retain parent fds."""
    current = os.open("/", _directory_flags())
    chain: list[tuple[int, str, int, tuple[int, ...]]] = []
    try:
        components = path.parts[1:]
        for component in components:
            _safe_component(component)
            before = os.stat(component, dir_fd=current, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode):
                raise SnapshotError("directory path contains a link or non-directory")
            child = os.open(component, _directory_flags(), dir_fd=current)
            try:
                after = os.fstat(child)
                _same_identity(after, before, "directory path component")
            except BaseException:
                os.close(child)
                raise
            chain.append((current, component, child, _identity(after)))
            current = child
        return current, chain
    except BaseException:
        _close_chain(chain, current)
        raise


def _close_chain(chain: list[tuple[int, str, int, tuple[int, ...]]], root_fd: int) -> None:
    descriptors: set[int] = {root_fd}
    for parent_fd, _name, child_fd, _expected in chain:
        descriptors.add(parent_fd)
        descriptors.add(child_fd)
    for descriptor in descriptors:
        try:
            os.close(descriptor)
        except OSError:
            pass


def _verify_path_chain(chain: list[tuple[int, str, int, tuple[int, ...]]]) -> None:
    for parent_fd, name, child_fd, expected in chain:
        _same_directory_object(os.fstat(child_fd), expected, "directory path component")
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        _same_directory_object(named, expected, "named directory path component")


def _list_directory(directory_fd: int) -> list[str]:
    names: list[str] = []
    with os.scandir(directory_fd) as entries:
        for entry in entries:
            if len(names) >= MAX_TREE_ENTRIES:
                raise SnapshotError("tree exceeds the bounded entry count")
            names.append(entry.name)
    return sorted(names)


def _open_child_directory(parent_fd: int, name: str,
                          expected: tuple[int, ...] | None = None) -> int:
    before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(before.st_mode):
        raise SnapshotError("tree contains a link or non-directory entry")
    if expected is not None:
        _same_identity(before, expected, "named directory")
    descriptor = os.open(name, _directory_flags(), dir_fd=parent_fd)
    try:
        _same_identity(os.fstat(descriptor), before, "opened directory")
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def _hash_regular_file(parent_fd: int, name: str, relative: str,
                       before: os.stat_result, max_remaining: int) -> str:
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    descriptor = os.open(name, flags, dir_fd=parent_fd)
    try:
        _same_identity(os.fstat(descriptor), before, "opened source file")
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(descriptor, HASH_CHUNK_BYTES)
            if not chunk:
                break
            size += len(chunk)
            if size > max_remaining:
                raise SnapshotError("snapshot exceeds its total byte limit")
            digest.update(chunk)
        after_fd = os.fstat(descriptor)
        _same_identity(after_fd, before, "source file")
        named_after = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        _same_identity(named_after, before, "named source file")
        if size != before.st_size:
            raise SnapshotError("source file size changed while hashing: " + relative)
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def _scan_tree(root: Path, *, max_files: int, max_bytes: int
                ) -> tuple[dict, dict[str, tuple[int, ...]], dict[str, list[str]]]:
    root_fd, chain = _open_directory_path(root)
    records: dict[str, tuple[int, ...]] = {}
    listings: dict[str, list[str]] = {}
    directories: list[str] = []
    files: list[dict] = []
    total_bytes = 0
    seen_directories: set[tuple[int, int]] = set()

    def walk(directory_fd: int, relative_directory: str, depth: int) -> None:
        nonlocal total_bytes
        start = os.fstat(directory_fd)
        if not stat.S_ISDIR(start.st_mode):
            raise SnapshotError("tree contains a non-directory entry")
        current_identity = _identity(start)
        prior_identity = records.setdefault(relative_directory, current_identity)
        _same_identity(current_identity, prior_identity, "source directory")
        inode_key = (start.st_dev, start.st_ino)
        if inode_key in seen_directories:
            raise SnapshotError("tree contains a repeated physical directory")
        seen_directories.add(inode_key)

        names_before = _list_directory(directory_fd)
        for name in names_before:
            _safe_component(name)
        listings[relative_directory] = names_before
        for name in names_before:
            relative = name if not relative_directory else relative_directory + "/" + name
            metadata = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            entry_identity = _identity(metadata)
            records[relative] = entry_identity
            if stat.S_ISDIR(metadata.st_mode):
                if depth >= MAX_DEPTH:
                    raise SnapshotError("tree exceeds the maximum directory depth")
                if len(directories) >= MAX_DIRECTORIES:
                    raise SnapshotError("tree exceeds the bounded directory count")
                child_fd = _open_child_directory(directory_fd, name, entry_identity)
                try:
                    directories.append(relative)
                    walk(child_fd, relative, depth + 1)
                    named_after = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    _same_identity(named_after, entry_identity, "named source directory")
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(metadata.st_mode):
                if metadata.st_nlink != 1:
                    raise SnapshotError("tree contains a hardlinked regular file")
                if len(files) >= max_files:
                    raise SnapshotError("snapshot exceeds its file-count limit")
                if metadata.st_size < 0 or total_bytes + metadata.st_size > max_bytes:
                    raise SnapshotError("snapshot exceeds its total byte limit")
                digest = _hash_regular_file(
                    directory_fd, name, relative, metadata, max_bytes - total_bytes,
                )
                files.append({
                    "path": relative,
                    "size": metadata.st_size,
                    "sha256": digest,
                    "mode": stat.S_IMODE(metadata.st_mode) & 0o777,
                    "inode": metadata.st_ino,
                    "mtime_ns": metadata.st_mtime_ns,
                })
                total_bytes += metadata.st_size
            else:
                raise SnapshotError("tree contains a symlink or special file")
        names_after = _list_directory(directory_fd)
        if names_after != names_before:
            raise SnapshotError("source directory listing changed during snapshot")
        _same_identity(os.fstat(directory_fd), current_identity, "source directory")

    try:
        root_stat = os.fstat(root_fd)
        if not stat.S_ISDIR(root_stat.st_mode):
            raise SnapshotError("source root must be a real directory")
        records[""] = _identity(root_stat)
        walk(root_fd, "", 0)
        _verify_scanned_tree(root, records, listings)
        _verify_path_chain(chain)
        _verify_reopened_path_chain(root, chain)
        manifest = {
            "schema": SNAPSHOT_SCHEMA,
            "source_root": str(root),
            "root_identity": {"device": root_stat.st_dev, "inode": root_stat.st_ino},
            "directories": sorted(directories),
            "files": sorted(files, key=lambda item: item["path"]),
            "total_bytes": total_bytes,
            "file_count": len(files),
            "directory_count": len(directories),
        }
        return manifest, records, listings
    finally:
        _close_chain(chain, root_fd)


def _verify_reopened_path_chain(root: Path,
                                original_chain: list[tuple[int, str, int, tuple[int, ...]]]) -> None:
    reopened_fd, reopened_chain = _open_directory_path(root)
    try:
        original = [entry[3] for entry in original_chain]
        reopened = [entry[3] for entry in reopened_chain]
        if (len(reopened) != len(original)
                or any(left[:3] != right[:3] for left, right in zip(reopened, original))):
            raise SnapshotError("source path resolved to different directories")
        if original_chain:
            _same_directory_object(os.fstat(reopened_fd), original[-1], "source root")
    finally:
        _close_chain(reopened_chain, reopened_fd)


def _verify_scanned_tree(root: Path, records: dict[str, tuple[int, ...]],
                         listings: dict[str, list[str]]) -> None:
    root_fd, chain = _open_directory_path(root)

    def verify(directory_fd: int, relative_directory: str) -> None:
        expected = records[relative_directory]
        _same_identity(os.fstat(directory_fd), expected, "source directory")
        names_before = _list_directory(directory_fd)
        if names_before != listings[relative_directory]:
            raise SnapshotError("source directory listing changed during snapshot")
        for name in names_before:
            relative = name if not relative_directory else relative_directory + "/" + name
            metadata = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            entry_identity = records[relative]
            _same_identity(metadata, entry_identity, "named source entry")
            if stat.S_ISDIR(metadata.st_mode):
                child_fd = _open_child_directory(directory_fd, name, entry_identity)
                try:
                    verify(child_fd, relative)
                    named_after = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    _same_identity(named_after, entry_identity, "named source directory")
                finally:
                    os.close(child_fd)
        if _list_directory(directory_fd) != names_before:
            raise SnapshotError("source directory listing changed during snapshot")
        _same_identity(os.fstat(directory_fd), expected, "source directory")

    try:
        verify(root_fd, "")
        _verify_path_chain(chain)
    finally:
        _close_chain(chain, root_fd)


def snapshot_tree(source: Path, *, max_files: int = DEFAULT_MAX_FILES,
                  max_bytes: int = DEFAULT_MAX_BYTES) -> dict:
    """Hash a canonical Linux directory tree without following or writing links."""
    _linux_only()
    max_files = _strict_limit(max_files, "max_files")
    max_bytes = _strict_limit(max_bytes, "max_bytes")
    root = _canonical_existing_directory(source, "source")
    manifest, _records, _listings = _scan_tree(
        root, max_files=max_files, max_bytes=max_bytes,
    )
    return manifest


def _validate_manifest(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != _MANIFEST_KEYS:
        raise SnapshotError("snapshot manifest has an unexpected shape")
    if value.get("schema") != SNAPSHOT_SCHEMA:
        raise SnapshotError("snapshot manifest schema is unsupported")
    source_root = value.get("source_root")
    if not isinstance(source_root, str) or not Path(source_root).is_absolute():
        raise SnapshotError("snapshot manifest source_root is invalid")
    identity = value.get("root_identity")
    if (not isinstance(identity, dict) or set(identity) != {"device", "inode"}
            or any(type(identity[key]) is not int or identity[key] < 0
                   for key in ("device", "inode"))):
        raise SnapshotError("snapshot manifest root identity is invalid")

    directories = value.get("directories")
    if not isinstance(directories, list):
        raise SnapshotError("snapshot manifest directories must be a list")
    normalized_directories = [_safe_relative_path(path) for path in directories]
    if normalized_directories != sorted(set(normalized_directories)):
        raise SnapshotError("snapshot manifest directories are duplicated or unsorted")
    if len(normalized_directories) > MAX_DIRECTORIES:
        raise SnapshotError("snapshot manifest exceeds the bounded directory count")

    raw_files = value.get("files")
    if not isinstance(raw_files, list) or len(raw_files) > DEFAULT_MAX_FILES:
        raise SnapshotError("snapshot manifest files are invalid or over budget")
    files: list[dict] = []
    for row in raw_files:
        if not isinstance(row, dict) or set(row) != _FILE_KEYS:
            raise SnapshotError("snapshot manifest file entry has an unexpected shape")
        path = _safe_relative_path(row["path"])
        if (type(row["size"]) is not int or row["size"] < 0
                or not isinstance(row["sha256"], str)
                or _SHA256.fullmatch(row["sha256"]) is None
                or type(row["mode"]) is not int or not 0 <= row["mode"] <= 0o777
                or type(row["inode"]) is not int or row["inode"] < 0
                or type(row["mtime_ns"]) is not int):
            raise SnapshotError("snapshot manifest file metadata is invalid")
        files.append({
            "path": path,
            "size": row["size"],
            "sha256": row["sha256"],
            "mode": row["mode"],
            "inode": row["inode"],
            "mtime_ns": row["mtime_ns"],
        })
    file_paths = [row["path"] for row in files]
    if file_paths != sorted(set(file_paths)):
        raise SnapshotError("snapshot manifest files are duplicated or unsorted")

    directory_set = set(normalized_directories)
    file_set = set(file_paths)
    if directory_set & file_set:
        raise SnapshotError("snapshot manifest has a path that is both file and directory")
    all_paths = directory_set | file_set
    for relative in all_paths:
        parent = PurePosixPath(relative).parent
        while str(parent) not in {"", "."}:
            if str(parent) not in directory_set:
                raise SnapshotError("snapshot manifest omits a parent directory")
            parent = parent.parent
    total_bytes = value.get("total_bytes")
    file_count = value.get("file_count")
    directory_count = value.get("directory_count")
    if (type(total_bytes) is not int or total_bytes < 0
            or total_bytes != sum(row["size"] for row in files)
            or type(file_count) is not int or file_count != len(files)
            or type(directory_count) is not int or directory_count != len(normalized_directories)):
        raise SnapshotError("snapshot manifest counts or total size are inconsistent")
    return {
        "schema": SNAPSHOT_SCHEMA,
        "source_root": source_root,
        "root_identity": {"device": identity["device"], "inode": identity["inode"]},
        "directories": normalized_directories,
        "files": files,
        "total_bytes": total_bytes,
        "file_count": file_count,
        "directory_count": directory_count,
    }


def _paths_overlap(source: Path, destination: Path) -> bool:
    source_text = str(source)
    destination_text = str(destination)
    return (source_text == destination_text
            or destination_text.startswith(source_text.rstrip("/") + "/")
            or source_text.startswith(destination_text.rstrip("/") + "/"))


def _open_verified_file(source_parent_fd: int, destination_parent_fd: int, name: str,
                        relative: str, expected: tuple[int, ...], max_remaining: int,
                        expected_size: int, expected_sha256: str) -> None:
    metadata = os.stat(name, dir_fd=source_parent_fd, follow_symlinks=False)
    _same_identity(metadata, expected, "named source file")
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise SnapshotError("source file is no longer a singly linked regular file")
    source_fd = os.open(
        name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
        dir_fd=source_parent_fd,
    )
    destination_fd = -1
    try:
        _same_identity(os.fstat(source_fd), expected, "opened source file")
        destination_fd = os.open(
            name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600, dir_fd=destination_parent_fd,
        )
        os.fsync(destination_parent_fd)
        destination_metadata = os.fstat(destination_fd)
        if not stat.S_ISREG(destination_metadata.st_mode) or destination_metadata.st_nlink != 1:
            raise SnapshotError("new destination file is not a private regular file")
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(source_fd, HASH_CHUNK_BYTES)
            if not chunk:
                break
            size += len(chunk)
            if size > max_remaining:
                raise SnapshotError("source grew beyond the verified byte budget")
            digest.update(chunk)
            offset = 0
            while offset < len(chunk):
                written = os.write(destination_fd, chunk[offset:])
                if written <= 0:
                    raise OSError("short write while copying snapshot file")
                offset += written
        source_after = os.fstat(source_fd)
        _same_identity(source_after, expected, "source file")
        named_after = os.stat(name, dir_fd=source_parent_fd, follow_symlinks=False)
        _same_identity(named_after, expected, "named source file")
        if size != metadata.st_size or size != expected_size:
            raise SnapshotError("source file size changed while copying: " + relative)
        if digest.hexdigest() != expected_sha256:
            raise SnapshotError("source file hash differs from the supplied manifest: " + relative)

        mode = (stat.S_IMODE(metadata.st_mode) & 0o777) | stat.S_IRUSR | stat.S_IWUSR
        os.fchmod(destination_fd, mode)
        os.utime(destination_fd, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
        os.fsync(destination_fd)
        destination_after = os.fstat(destination_fd)
        if (not stat.S_ISREG(destination_after.st_mode) or destination_after.st_nlink != 1
                or destination_after.st_size != size):
            raise SnapshotError("copied destination file identity is invalid")
        named_destination = os.stat(
            name, dir_fd=destination_parent_fd, follow_symlinks=False,
        )
        _same_identity(named_destination, destination_after, "named destination file")
    finally:
        if destination_fd >= 0:
            os.close(destination_fd)
        os.close(source_fd)


def _copy_regular_file(source_parent_fd: int, destination_parent_fd: int, name: str,
                       relative: str, expected: tuple[int, ...], max_remaining: int,
                       expected_size: int, expected_sha256: str) -> None:
    """Copy one regular file by descriptor; exposed for deterministic drift tests."""
    _open_verified_file(source_parent_fd, destination_parent_fd, name, relative,
                        expected, max_remaining, expected_size, expected_sha256)


def _copy_tree_contents(source_fd: int, destination_fd: int, relative_directory: str,
                        records: dict[str, tuple[int, ...]],
                        listings: dict[str, list[str]], file_manifest: dict[str, dict],
                        remaining_bytes: list[int]) -> None:
    source_before = os.fstat(source_fd)
    expected_directory = records[relative_directory]
    _same_identity(source_before, expected_directory, "source directory before copy")
    names_before = _list_directory(source_fd)
    if names_before != listings[relative_directory]:
        raise SnapshotError("source directory listing changed before copy")
    for name in names_before:
        relative = name if not relative_directory else relative_directory + "/" + name
        expected = records[relative]
        metadata = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        _same_identity(metadata, expected, "named source entry before copy")
        if stat.S_ISDIR(metadata.st_mode):
            source_child_fd = _open_child_directory(source_fd, name, expected)
            try:
                os.mkdir(name, mode=0o700, dir_fd=destination_fd)
                os.fsync(destination_fd)
                destination_child_fd = os.open(name, _directory_flags(),
                                               dir_fd=destination_fd)
                try:
                    _same_identity(os.fstat(destination_child_fd),
                                   os.stat(name, dir_fd=destination_fd,
                                           follow_symlinks=False),
                                   "new destination directory")
                    _copy_tree_contents(source_child_fd, destination_child_fd, relative,
                                        records, listings, file_manifest, remaining_bytes)
                    final_mode = (stat.S_IMODE(metadata.st_mode) & 0o777) | 0o700
                    os.fchmod(destination_child_fd, final_mode)
                    os.utime(destination_child_fd,
                             ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
                    os.fsync(destination_child_fd)
                    _same_identity(os.fstat(source_child_fd), expected,
                                   "source directory after copy")
                    named_after = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
                    _same_identity(named_after, expected, "named source directory after copy")
                finally:
                    os.close(destination_child_fd)
            finally:
                os.close(source_child_fd)
        elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
            size_before = metadata.st_size
            file_record = file_manifest[relative]
            _copy_regular_file(source_fd, destination_fd, name, relative,
                               expected, remaining_bytes[0], file_record["size"],
                               file_record["sha256"])
            remaining_bytes[0] -= size_before
        else:
            raise SnapshotError("source tree changed to a link or special file during copy")
    if _list_directory(source_fd) != names_before:
        raise SnapshotError("source directory listing changed during copy")
    _same_identity(os.fstat(source_fd), expected_directory, "source directory after copy")
    os.fsync(destination_fd)


def copy_verified_tree(source: Path, destination: Path, manifest: dict) -> dict:
    """Copy a previously snapshotted tree to a fresh, disjoint destination.

    The result keeps the source path and identity, reports the destination in
    ``destination_root``/``destination_identity`` and ``root_identity``, and
    lists the destination files. A failed copy deliberately leaves its partial
    destination in place for inspection; callers must select a fresh path to retry.
    """
    _linux_only()
    trusted_manifest = _validate_manifest(manifest)
    source_root = _canonical_existing_directory(source, "source")
    destination_root, destination_parent, destination_name = _canonical_destination(destination)
    if trusted_manifest["source_root"] != str(source_root):
        raise SnapshotError("manifest source_root differs from the selected source")
    if _paths_overlap(source_root, destination_root):
        raise SnapshotError("source and destination paths overlap")
    parent_check_fd, parent_check_chain = _open_directory_path(destination_parent)
    try:
        try:
            os.stat(destination_name, dir_fd=parent_check_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise SnapshotError("destination already exists")
    finally:
        _close_chain(parent_check_chain, parent_check_fd)

    current_manifest, source_records, source_listings = _scan_tree(
        source_root, max_files=DEFAULT_MAX_FILES, max_bytes=DEFAULT_MAX_BYTES,
    )
    if current_manifest != trusted_manifest:
        raise SnapshotError("source no longer matches the supplied snapshot manifest")

    source_fd = -1
    source_chain: list[tuple[int, str, int, tuple[int, ...]]] = []
    destination_parent_fd = -1
    destination_chain: list[tuple[int, str, int, tuple[int, ...]]] = []
    destination_fd = -1
    try:
        source_fd, source_chain = _open_directory_path(source_root)
        destination_parent_fd, destination_chain = _open_directory_path(destination_parent)
        _verify_path_chain(source_chain)
        _verify_path_chain(destination_chain)
        parent_identity = _identity(os.fstat(destination_parent_fd))
        if any(parent_identity == identity for identity in source_records.values()
               if stat.S_ISDIR(identity[2])):
            raise SnapshotError("destination parent physically overlaps the source tree")
        try:
            os.stat(destination_name, dir_fd=destination_parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise SnapshotError("destination already exists")
        os.mkdir(destination_name, mode=0o700, dir_fd=destination_parent_fd)
        os.fsync(destination_parent_fd)
        destination_fd = os.open(destination_name, _directory_flags(),
                                 dir_fd=destination_parent_fd)
        destination_identity = _identity(os.fstat(destination_fd))
        named_destination = os.stat(destination_name, dir_fd=destination_parent_fd,
                                    follow_symlinks=False)
        _same_identity(named_destination, destination_identity, "new destination root")

        file_manifest = {row["path"]: row for row in trusted_manifest["files"]}
        remaining_bytes = [trusted_manifest["total_bytes"]]
        _copy_tree_contents(source_fd, destination_fd, "", source_records,
                            source_listings, file_manifest, remaining_bytes)
        if remaining_bytes[0] != 0:
            raise SnapshotError("copied byte count differs from the supplied manifest")
        source_root_stat = os.fstat(source_fd)
        os.fchmod(destination_fd,
                  (stat.S_IMODE(source_root_stat.st_mode) & 0o777) | 0o700)
        os.utime(destination_fd,
                 ns=(source_root_stat.st_atime_ns, source_root_stat.st_mtime_ns))
        os.fsync(destination_fd)
        os.fsync(destination_parent_fd)

        destination_manifest = snapshot_tree(destination_root)
        expected_hashes = [(row["path"], row["size"], row["sha256"])
                           for row in trusted_manifest["files"]]
        actual_hashes = [(row["path"], row["size"], row["sha256"])
                         for row in destination_manifest["files"]]
        expected_destination_identity = {
            "device": destination_identity[0], "inode": destination_identity[1],
        }
        if (destination_manifest["root_identity"] != expected_destination_identity
                or destination_manifest["directories"] != trusted_manifest["directories"]
                or actual_hashes != expected_hashes):
            raise SnapshotError("destination content differs from the source manifest")

        final_source, final_records, _final_listings = _scan_tree(
            source_root, max_files=DEFAULT_MAX_FILES, max_bytes=DEFAULT_MAX_BYTES,
        )
        if final_source != trusted_manifest or final_records != source_records:
            raise SnapshotError("source metadata or contents changed during copy")
        _verify_path_chain(source_chain)
        _verify_path_chain(destination_chain)
        _verify_reopened_path_chain(destination_parent, destination_chain)
        _same_directory_object(os.fstat(destination_fd), destination_identity,
                               "destination root during copy")
        _same_directory_object(os.stat(destination_name, dir_fd=destination_parent_fd,
                                       follow_symlinks=False), destination_identity,
                               "named destination root during copy")

        result = dict(destination_manifest)
        result["source_root"] = str(source_root)
        result["source_identity"] = dict(trusted_manifest["root_identity"])
        result["destination_root"] = str(destination_root)
        result["destination_identity"] = {
            "device": destination_identity[0], "inode": destination_identity[1],
        }
        result["root_identity"] = dict(result["destination_identity"])
        return result
    finally:
        if destination_fd >= 0:
            os.close(destination_fd)
        if source_fd >= 0:
            _close_chain(source_chain, source_fd)
        if destination_parent_fd >= 0:
            _close_chain(destination_chain, destination_parent_fd)


def _read_owner_record(store_fd: int) -> tuple[dict, tuple[int, ...], bytes]:
    name = "WRITER.owner.json"
    try:
        before = os.stat(name, dir_fd=store_fd, follow_symlinks=False)
    except OSError as error:
        raise SnapshotError("WRITER.owner.json is missing or unreadable") from error
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise SnapshotError("WRITER.owner.json must be a singly linked regular file")
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                         | os.O_CLOEXEC, dir_fd=store_fd)
    try:
        _same_identity(os.fstat(descriptor), before, "writer owner record")
        if before.st_size > MAX_OWNER_BYTES:
            raise SnapshotError("WRITER.owner.json exceeds its byte limit")
        raw = bytearray()
        while len(raw) <= MAX_OWNER_BYTES:
            chunk = os.read(descriptor, min(HASH_CHUNK_BYTES, MAX_OWNER_BYTES + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        after = os.fstat(descriptor)
        _same_identity(after, before, "writer owner record")
        named_after = os.stat(name, dir_fd=store_fd, follow_symlinks=False)
        _same_identity(named_after, before, "named writer owner record")
        if len(raw) != before.st_size or len(raw) > MAX_OWNER_BYTES:
            raise SnapshotError("WRITER.owner.json changed or exceeds its byte limit")
    finally:
        os.close(descriptor)
    try:
        document = json.loads(raw.decode("utf-8", "strict"),
                              object_pairs_hook=_reject_duplicate_json_keys,
                              parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise SnapshotError("WRITER.owner.json is not unambiguous UTF-8 JSON") from error
    if not isinstance(document, dict):
        raise SnapshotError("WRITER.owner.json must contain a JSON object")
    if document.get("schema") != "fullmag.writer.v1" or document.get("released") is not True:
        raise SnapshotError("WRITER.owner.json does not prove a released writer")
    return document, _identity(before), bytes(raw)


def _reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict:
    document = {}
    for key, value in pairs:
        if key in document:
            raise ValueError("JSON object has a duplicate key")
        document[key] = value
    return document


def _reject_json_constant(value: str) -> None:
    raise ValueError("JSON contains a non-standard numeric value: " + value)


@contextmanager
def hold_source_writer(store_root: Path):
    """Hold ``WRITER.lock`` and yield its read-only store-root directory fd.

    Callers can compare ``os.fstat(fd)`` with the selected store path before
    reading it; the context revalidates that path again before releasing the lock.
    """
    _linux_only()
    store = _canonical_existing_directory(store_root, "store_root")
    store_fd, store_chain = _open_directory_path(store)
    store_identity = _identity(os.fstat(store_fd))
    lock_fd = -1
    locked = False
    try:
        _verify_path_chain(store_chain)
        try:
            os.stat("LOCK", dir_fd=store_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise SnapshotError("legacy LOCK exists; source writer state needs recovery")

        lock_name = "WRITER.lock"
        lock_before = os.stat(lock_name, dir_fd=store_fd, follow_symlinks=False)
        if not stat.S_ISREG(lock_before.st_mode) or lock_before.st_nlink != 1:
            raise SnapshotError("existing WRITER.lock must be a singly linked regular file")
        lock_fd = os.open(lock_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                          | os.O_CLOEXEC, dir_fd=store_fd)
        lock_identity = _identity(lock_before)
        _same_identity(os.fstat(lock_fd), lock_identity, "opened WRITER.lock")
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except BlockingIOError as error:
            raise SnapshotError("source WRITER.lock is busy") from error
        _same_identity(os.fstat(lock_fd), lock_identity, "locked WRITER.lock")
        _same_identity(os.stat(lock_name, dir_fd=store_fd, follow_symlinks=False),
                       lock_identity, "named WRITER.lock")
        _owner, owner_identity, owner_raw = _read_owner_record(store_fd)
        _verify_source_store_path(store, store_fd, store_chain, store_identity)
        try:
            yield store_fd
        except BaseException:
            try:
                _verify_source_writer_state(
                    store, store_fd, store_chain, store_identity, lock_fd,
                    lock_identity, owner_identity, owner_raw,
                )
            finally:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                locked = False
            raise
        else:
            _verify_source_writer_state(
                store, store_fd, store_chain, store_identity, lock_fd,
                lock_identity, owner_identity, owner_raw,
            )
    finally:
        try:
            if locked:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            try:
                if lock_fd >= 0:
                    os.close(lock_fd)
            finally:
                _close_chain(store_chain, store_fd)


def _verify_source_store_path(
    store: Path, store_fd: int,
    store_chain: list[tuple[int, str, int, tuple[int, ...]]],
    store_identity: tuple[int, ...],
) -> None:
    _same_identity(os.fstat(store_fd), store_identity, "locked source store")
    _verify_path_chain(store_chain)
    _verify_reopened_path_chain(store, store_chain)
    _same_identity(os.stat(store, follow_symlinks=False), store_identity,
                   "named locked source store")


def _verify_source_writer_state(
    store: Path, store_fd: int,
    store_chain: list[tuple[int, str, int, tuple[int, ...]]],
    store_identity: tuple[int, ...], lock_fd: int,
    lock_identity: tuple[int, ...], owner_identity: tuple[int, ...], owner_raw: bytes,
) -> None:
    try:
        _verify_writer_records(store_fd, lock_fd, lock_identity, owner_identity, owner_raw)
    finally:
        _verify_source_store_path(store, store_fd, store_chain, store_identity)


def _verify_writer_records(store_fd: int, lock_fd: int,
                           lock_identity: tuple[int, ...],
                           owner_identity: tuple[int, ...], owner_raw: bytes) -> None:
    _same_identity(os.fstat(lock_fd), lock_identity, "WRITER.lock held by snapshot")
    _same_identity(os.stat("WRITER.lock", dir_fd=store_fd, follow_symlinks=False),
                   lock_identity, "named WRITER.lock held by snapshot")
    _owner, current_identity, current_raw = _read_owner_record(store_fd)
    _same_identity(current_identity, owner_identity, "WRITER.owner.json")
    if current_raw != owner_raw:
        raise SnapshotError("WRITER.owner.json contents changed while source lock was held")
