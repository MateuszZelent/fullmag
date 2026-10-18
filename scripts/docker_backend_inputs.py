"""Prepare immutable backend source inputs for direct Docker Compose builds.

This path deliberately does not submit a managed-runner job.  Native Windows
can capture either the existing archive input or a compact live-shadow
manifest under the resolver-owned build root.  The Linux container verifies
the selected contract and synchronizes the live checkout into its own
read-only build shadow before invoking the canonical Make target.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid
from typing import Any, BinaryIO, Mapping

import fullmag_storage as storage
from local_runner.build_source import bind_identity, native_identity
from local_runner.source import (
    SourceError,
    _current_entry,
    _expand_explicit_paths,
    _git_check_lfs_attributes,
    _index_records,
    _looks_like_lfs_pointer,
    _manifest,
    _normalise_excluded,
    _parse_untracked,
    _read_git_blobs,
    _reject_policy,
    _tree_records,
    _working_tree_dirty,
    capture_source,
)


ARCHIVE_MANIFEST_SCHEMA = "fullmag.docker-backend-source.v1"
LIVE_MANIFEST_SCHEMA = "fullmag.docker-backend-live-source.v1"
LIVE_SOURCE_MODE = "live-shadow-v1"
SOURCE_MANIFEST_SCHEMA = "fullmag.source-capsule.v1"
ARCHIVE_FILENAME = "backend-source.tar"
EMBEDDED_MANIFEST_FILENAME = "backend-source-manifest.json"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SHA40_RE = re.compile(r"^[0-9a-f]{40}$")
CAPTURE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024


class BackendInputError(RuntimeError):
    """The direct backend source archive cannot be created safely."""


def _canonical_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def source_manifest_digest(source_manifest: Mapping[str, Any]) -> str:
    """Reproduce the source-capsule digest without depending on host paths."""

    try:
        material = {
            "schema_version": source_manifest["schema_version"],
            "source_mode": source_manifest["source_mode"],
            "resolved_commit": source_manifest["resolved_commit"],
            "files": source_manifest["files"],
            "deleted": source_manifest["deleted"],
            "included_untracked": source_manifest["included_untracked"],
            "excluded": source_manifest["excluded"],
        }
    except KeyError as error:
        raise BackendInputError(f"source manifest is missing {error.args[0]}") from error
    return _sha256_bytes(_canonical_bytes(material))


def _safe_relative_path(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise BackendInputError(f"{label} is not a valid relative path")
    if "\\" in value:
        raise BackendInputError(f"{label} must use POSIX separators")
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or windows.anchor
        or value != posix.as_posix()
        or any(part in {"", ".", ".."} for part in posix.parts)
    ):
        raise BackendInputError(f"{label} escapes the source root: {value!r}")
    return value


def _validate_sha(value: object, label: str, *, length: int = 64) -> str:
    regex = SHA256_RE if length == 64 else SHA40_RE
    if not isinstance(value, str) or not regex.fullmatch(value):
        raise BackendInputError(f"{label} is not a lowercase SHA-{length * 4} digest")
    return value


def _validate_source_manifest(value: object) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not isinstance(value, dict):
        raise BackendInputError("source_manifest must be a JSON object")
    if value.get("schema") != SOURCE_MANIFEST_SCHEMA or value.get("schema_version") != SOURCE_MANIFEST_SCHEMA:
        raise BackendInputError("source_manifest schema mismatch")
    mode = value.get("source_mode")
    if mode not in {"commit", "snapshot"}:
        raise BackendInputError("source_manifest source_mode is invalid")
    _validate_sha(value.get("resolved_commit"), "source_manifest.resolved_commit", length=40)
    files = value.get("files")
    if not isinstance(files, list):
        raise BackendInputError("source_manifest.files must be a list")
    checked: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(files):
        if not isinstance(raw, dict):
            raise BackendInputError(f"source_manifest.files[{index}] is not an object")
        path = _safe_relative_path(raw.get("path"), f"source_manifest.files[{index}].path")
        if path in seen:
            raise BackendInputError(f"duplicate source manifest path: {path}")
        seen.add(path)
        if raw.get("type") != "file" or raw.get("mode") not in {"100644", "100755"}:
            raise BackendInputError(f"source manifest entry is not a regular file: {path}")
        size = raw.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0 or size > MAX_FILE_BYTES:
            raise BackendInputError(f"source manifest file size is invalid: {path}")
        checked.append({
            "path": path,
            "type": "file",
            "mode": raw["mode"],
            "size": size,
            "sha256": _validate_sha(raw.get("sha256"), f"source manifest file {path}"),
        })
    if checked != sorted(checked, key=lambda item: item["path"]):
        raise BackendInputError("source manifest files are not canonically sorted")
    for field in ("deleted", "included_untracked"):
        paths = value.get(field)
        if not isinstance(paths, list):
            raise BackendInputError(f"source manifest {field} must be a list")
        checked_paths = [_safe_relative_path(path, f"source_manifest.{field}") for path in paths]
        if checked_paths != sorted(set(checked_paths)):
            raise BackendInputError(f"source manifest {field} is not canonically sorted")
    if not isinstance(value.get("excluded"), list):
        raise BackendInputError("source manifest excluded field is invalid")
    file_paths = {entry["path"] for entry in checked}
    deleted_paths = set(value["deleted"])
    untracked_paths = set(value["included_untracked"])
    if (
        file_paths & deleted_paths
        or not untracked_paths <= file_paths
        or deleted_paths & untracked_paths
    ):
        raise BackendInputError("source manifest path classes overlap")
    expected_digest = source_manifest_digest(value)
    if value.get("source_digest") != expected_digest or value.get("source_digest_sha256") != expected_digest:
        raise BackendInputError("source manifest digest does not match its content")
    return deepcopy(value), checked


def _validate_native_identity(value: object, resolved_commit: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BackendInputError("native_source_identity must be a JSON object")
    if value.get("schema") != "fullmag.source-snapshot.v2":
        raise BackendInputError("native_source_identity schema mismatch")
    if value.get("head_commit_full") != resolved_commit:
        raise BackendInputError("native source commit differs from the source manifest")
    _validate_sha(value.get("head_tree_sha256"), "native_source_identity.head_tree_sha256")
    _validate_sha(value.get("dirty_content_sha256"), "native_source_identity.dirty_content_sha256")
    _validate_sha(value.get("source_snapshot_sha256"), "native_source_identity.source_snapshot_sha256")
    if type(value.get("source_snapshot_dirty")) is not bool or type(value.get("ignored_non_runtime_dirty")) is not bool:
        raise BackendInputError("native source dirty flags are invalid")
    if not isinstance(value.get("git_status_porcelain_v1"), list) or not isinstance(value.get("dirty_path_content"), list):
        raise BackendInputError("native source status fields are invalid")
    return deepcopy(value)


def _open_regular(path: Path, label: str) -> tuple[int, os.stat_result]:
    descriptor: int | None = None
    try:
        path_metadata = path.lstat()
        if (
            not stat.S_ISREG(path_metadata.st_mode)
            or stat.S_ISLNK(path_metadata.st_mode)
            or getattr(path_metadata, "st_file_attributes", 0) & 0x400
            or path_metadata.st_nlink != 1
        ):
            raise BackendInputError(f"{label} is not one regular, non-linked file: {path}")
        descriptor = os.open(
            path,
            os.O_RDONLY
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_NONBLOCK", 0),
        )
        metadata = os.fstat(descriptor)
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        raise BackendInputError(f"cannot open {label}: {path}") from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(path_metadata.st_mode)
        or getattr(path_metadata, "st_file_attributes", 0) & 0x400
        or metadata.st_dev != path_metadata.st_dev
        or metadata.st_ino != path_metadata.st_ino
        or metadata.st_nlink != 1
        or metadata.st_size > MAX_FILE_BYTES
    ):
        os.close(descriptor)
        raise BackendInputError(f"{label} is not one regular, non-linked file: {path}")
    return descriptor, metadata


class _HashingReader:
    def __init__(self, stream: BinaryIO):
        self.stream = stream
        self.digest = hashlib.sha256()
        self.size = 0

    def read(self, size: int = -1) -> bytes:
        data = self.stream.read(size)
        self.digest.update(data)
        self.size += len(data)
        return data


def _tar_info(entry: Mapping[str, Any]) -> tarfile.TarInfo:
    info = tarfile.TarInfo(str(entry["path"]))
    info.type = tarfile.REGTYPE
    info.mode = 0o755 if entry["mode"] == "100755" else 0o644
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.size = int(entry["size"])
    return info


def _write_readonly_json(path: Path, value: Mapping[str, Any]) -> None:
    payload = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        stream = os.fdopen(descriptor, "wb")
        descriptor = -1
        with stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        try:
            path.chmod(0o444)
        except OSError:
            pass
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass
        temporary.unlink(missing_ok=True)


def build_backend_archive(
    source_tree: Path,
    source_manifest: Mapping[str, Any],
    native_source_identity: Mapping[str, Any],
    output_dir: Path,
    *,
    capture_id: str,
    source_root: str,
) -> dict[str, Any]:
    """Pack a verified source tree into one tar and one external manifest."""

    if not CAPTURE_ID_RE.fullmatch(capture_id):
        raise BackendInputError("capture_id is not a safe immutable bundle identifier")
    raw_tree = Path(source_tree)
    try:
        raw_tree_metadata = raw_tree.lstat()
    except OSError as error:
        raise BackendInputError("source_tree cannot be inspected") from error
    if (
        stat.S_ISLNK(raw_tree_metadata.st_mode)
        or getattr(raw_tree_metadata, "st_file_attributes", 0) & 0x400
        or not stat.S_ISDIR(raw_tree_metadata.st_mode)
    ):
        raise BackendInputError("source_tree must be a real directory")
    tree = raw_tree.resolve(strict=True)
    if not tree.is_dir():
        raise BackendInputError("source_tree must be a real directory")
    checked_source, files = _validate_source_manifest(dict(source_manifest))
    native = _validate_native_identity(native_source_identity, checked_source["resolved_commit"])
    destination = Path(output_dir).absolute()
    if destination.exists():
        raise BackendInputError(f"backend archive output already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination = destination.resolve()
    destination.mkdir()
    archive = destination / ARCHIVE_FILENAME
    temporary_archive = destination / f".{ARCHIVE_FILENAME}.{uuid.uuid4().hex}.tmp"
    expected_paths = {entry["path"] for entry in files}
    actual_paths: set[str] = set()
    for current, directories, filenames in os.walk(tree, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in tuple(directories):
            path = current_path / name
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
                raise BackendInputError(f"source tree contains a symlink/reparse directory: {path}")
        for name in filenames:
            path = current_path / name
            relative = path.relative_to(tree).as_posix()
            _safe_relative_path(relative, "source tree entry")
            actual_paths.add(relative)
    if actual_paths != expected_paths:
        missing = sorted(expected_paths - actual_paths)
        extra = sorted(actual_paths - expected_paths)
        raise BackendInputError(f"source tree membership differs (missing={missing[:1]}, extra={extra[:1]})")
    try:
        with tarfile.open(temporary_archive, mode="w", format=tarfile.PAX_FORMAT) as output:
            embedded = _canonical_bytes(checked_source)
            embedded_info = tarfile.TarInfo(EMBEDDED_MANIFEST_FILENAME)
            embedded_info.type = tarfile.REGTYPE
            embedded_info.mode = 0o444
            embedded_info.uid = embedded_info.gid = 0
            embedded_info.uname = embedded_info.gname = ""
            embedded_info.mtime = 0
            embedded_info.size = len(embedded)
            output.addfile(embedded_info, io.BytesIO(embedded))
            for entry in files:
                path = tree / entry["path"]
                descriptor, before = _open_regular(path, f"source file {entry['path']}")
                reader: _HashingReader | None = None
                try:
                    with os.fdopen(descriptor, "rb", closefd=False) as stream:
                        reader = _HashingReader(stream)
                        output.addfile(_tar_info(entry), reader)
                    after = os.fstat(descriptor)
                    path_after = path.lstat()
                finally:
                    os.close(descriptor)
                if (
                    reader is None
                    or reader.size != entry["size"]
                    or reader.digest.hexdigest() != entry["sha256"]
                    or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                    != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                    or stat.S_ISLNK(path_after.st_mode)
                    or getattr(path_after, "st_file_attributes", 0) & 0x400
                    or path_after.st_nlink != 1
                ):
                    raise BackendInputError(f"source file changed while archiving: {entry['path']}")
        os.replace(temporary_archive, archive)
        archive_bytes = archive.stat().st_size
        archive_sha256 = _sha256_file(archive)
        receipt = {
            "schema": ARCHIVE_MANIFEST_SCHEMA,
            "capture_id": capture_id,
            "source_mode": checked_source["source_mode"],
            "source_root": str(source_root),
            "resolved_commit": checked_source["resolved_commit"],
            "source_digest": checked_source["source_digest"],
            "backend_source_sha256": checked_source["source_digest"],
            "source_snapshot_sha256": native["source_snapshot_sha256"],
            "native_source_identity": native,
            "source_manifest": checked_source,
            "source_manifest_sha256": _sha256_bytes(_canonical_bytes(checked_source)),
            "archive_filename": ARCHIVE_FILENAME,
            "archive_sha256": archive_sha256,
            "archive_bytes": archive_bytes,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        manifest_path = destination / "manifest.json"
        _write_readonly_json(manifest_path, receipt)
        try:
            archive.chmod(0o444)
        except OSError:
            pass
        return {
            **receipt,
            "archive_path": str(archive),
            "manifest_path": str(manifest_path),
            "output_dir": str(destination),
        }
    except Exception:
        temporary_archive.unlink(missing_ok=True)
        raise


def _sha256_file(path: Path) -> str:
    descriptor, before = _open_regular(path, "backend source archive")
    digest = hashlib.sha256()
    total = 0
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
                total += len(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if total != before.st_size or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
        after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns
    ):
        raise BackendInputError("backend source archive changed while hashing")
    return digest.hexdigest()


def _git_bytes(repo: Path, *arguments: str) -> bytes:
    """Run a read-only native Git query without refreshing the index."""

    environment = os.environ.copy()
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        result = subprocess.run(
            ("git", *arguments),
            cwd=repo,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as error:
        raise BackendInputError(f"cannot run Git source query: {error}") from error
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise BackendInputError(f"Git source query failed: {detail or 'unknown error'}")
    return result.stdout


def _skip_worktree_paths(repo: Path) -> set[str]:
    """Return tracked paths intentionally absent from a sparse checkout."""

    paths: set[str] = set()
    for raw in _git_bytes(repo, "ls-files", "-t", "-z").split(b"\0"):
        if not raw:
            continue
        if len(raw) < 3 or raw[1:2] != b" ":
            raise BackendInputError("cannot parse Git tracked-path status")
        try:
            relative = raw[2:].decode("utf-8")
        except UnicodeDecodeError as error:
            raise BackendInputError("cannot decode Git tracked-path status") from error
        if raw[:1] == b"S":
            paths.add(_safe_relative_path(relative, "Git tracked path"))
    return paths


def _restore_sparse_snapshot_files(
    repo: Path,
    capsule: Path,
    source_manifest: Mapping[str, Any],
) -> dict[str, Any]:
    """Fill only skip-worktree deletions from the canonical HEAD objects.

    ``capture_source(snapshot)`` intentionally reads the live checkout.  A
    sparse checkout therefore reports absent skip-worktree files as deleted;
    direct Docker builds still need those tracked build inputs.  Genuine
    deletions remain deleted and are disclosed in the manifest.
    """

    if source_manifest.get("source_mode") != "snapshot":
        return dict(source_manifest)
    deleted = list(source_manifest.get("deleted", []))
    if not deleted:
        return dict(source_manifest)
    skip_paths = _skip_worktree_paths(repo)
    restore = sorted(set(deleted) & skip_paths)
    if not restore:
        return dict(source_manifest)
    tree = capsule / "tree"
    files = [dict(entry) for entry in source_manifest["files"]]
    entries = [dict(entry) for entry in source_manifest["entries"]]
    by_path = {entry["path"]: entry for entry in files}
    try:
        tree_records = _tree_records(repo, source_manifest["resolved_commit"], [])
        selected_records = {}
        for relative in restore:
            record = tree_records.get(relative)
            if record is None or record[0] not in {"100644", "100755"} or record[1] != "blob":
                raise BackendInputError(f"pinned commit entry is not a regular file: {relative}")
            selected_records[relative] = record
        blobs = _read_git_blobs(repo, selected_records)
    except SourceError as error:
        raise BackendInputError(f"cannot restore sparse source from Git objects: {error}") from error
    try:
        # capture_source locks its completed capsule read-only.  Unlock only
        # the private temporary tree while adding sparse Git-object files.
        for current, directories, _filenames in os.walk(tree, topdown=True, followlinks=False):
            current_path = Path(current)
            metadata = current_path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                raise BackendInputError(f"sparse source tree contains an unsafe directory: {current_path}")
            current_path.chmod(metadata.st_mode & 0o777 | 0o200)
            for name in directories:
                child = current_path / name
                child_metadata = child.lstat()
                if stat.S_ISLNK(child_metadata.st_mode) or not stat.S_ISDIR(child_metadata.st_mode):
                    raise BackendInputError(f"sparse source tree contains an unsafe directory: {child}")
                child.chmod(child_metadata.st_mode & 0o777 | 0o200)
        for relative in restore:
            mode, _kind, _object_id = selected_records[relative]
            content = blobs[relative]
            destination = tree / Path(*relative.split("/"))
            destination.parent.mkdir(parents=True, exist_ok=True)
            for parent in (destination.parent, *destination.parent.parents):
                if parent == tree.parent:
                    break
                metadata = parent.lstat()
                if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                    raise BackendInputError(f"sparse source path traverses an unsafe parent: {relative}")
            if destination.exists() or destination.is_symlink():
                raise BackendInputError(f"sparse source restoration collides with a live entry: {relative}")
            temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
            try:
                temporary.write_bytes(content)
                temporary.chmod(0o755 if mode == "100755" else 0o644)
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
            entry = {
                "path": relative,
                "type": "file",
                "mode": mode,
                "size": len(content),
                "sha256": _sha256_bytes(content),
            }
            by_path[relative] = entry
            entries.append(entry)
    finally:
        for current, directories, filenames in os.walk(tree, topdown=False, followlinks=False):
            current_path = Path(current)
            for name in filenames:
                path = current_path / name
                metadata = path.lstat()
                if stat.S_ISREG(metadata.st_mode):
                    path.chmod(0o555 if metadata.st_mode & stat.S_IXUSR else 0o444)
            for name in directories:
                path = current_path / name
                metadata = path.lstat()
                if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
                    path.chmod(0o555)
            metadata = current_path.lstat()
            if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
                current_path.chmod(0o555)
    updated = deepcopy(dict(source_manifest))
    updated["files"] = sorted(by_path.values(), key=lambda item: item["path"])
    updated["entries"] = sorted(entries, key=lambda item: item["path"])
    updated["deleted"] = [path for path in deleted if path not in set(restore)]
    digest = source_manifest_digest(updated)
    updated["source_digest"] = digest
    updated["source_digest_sha256"] = digest
    manifest_path = capsule / "manifest.json"
    manifest_path.chmod(0o644)
    manifest_path.write_bytes(_canonical_bytes(updated))
    manifest_path.chmod(0o444)
    return updated


def _cleanup_owned_source_staging(staging: Path) -> None:
    """Remove only our temporary capsule, including Windows readonly files."""
    staging = staging.absolute()
    if staging.is_symlink() or not staging.name.startswith(".backend-source-"):
        raise BackendInputError("refusing cleanup of an unowned source staging path")

    def remove_readonly(function, raw_path, error_info):
        target = Path(raw_path).absolute()
        if not target.is_relative_to(staging) or target.is_symlink():
            raise BackendInputError("source staging cleanup escaped its owned directory")
        if not isinstance(error_info[1], PermissionError):
            raise error_info[1]
        target.chmod(0o700)
        function(raw_path)

    shutil.rmtree(staging, onerror=remove_readonly)



def _git_common_directory(repo: Path) -> Path:
    raw = _git_bytes(repo, "rev-parse", "--git-common-dir").decode("utf-8", errors="strict").strip()
    if not raw:
        raise BackendInputError("Git did not return a common object directory")
    common = Path(raw)
    if not common.is_absolute():
        common = repo / common
    try:
        common = common.resolve(strict=True)
    except OSError as error:
        raise BackendInputError("Git common object directory is unavailable") from error
    if not common.is_dir():
        raise BackendInputError("Git common object directory is not a directory")
    return common


def _compact_live_source_manifest(
    repo: Path,
    *,
    include_untracked: tuple[str, ...],
) -> tuple[dict[str, Any], dict[str, str], Path]:
    """Describe the live checkout without copying its bytes into a tar.

    Committed bytes are hashed from Git objects.  Only dirty files that are
    present in the checkout are read from the Windows tree.  A missing
    skip-worktree file is represented by its pinned Git object id so the
    Linux worker can read that object from the read-only common Git mount.
    """

    try:
        head = _git_bytes(repo, "rev-parse", "--verify", "HEAD").decode("ascii").strip()
    except (UnicodeDecodeError, BackendInputError) as error:
        raise BackendInputError("Git HEAD is unavailable for live source manifest") from error
    if not SHA40_RE.fullmatch(head):
        raise BackendInputError("Git HEAD is not a full commit SHA")

    tree_excluded: list[object] = []
    tree = _tree_records(repo, head, tree_excluded)
    index_excluded: list[object] = []
    index = _index_records(repo, index_excluded)
    explicit = _expand_explicit_paths(repo, include_untracked)
    tracked = set(tree) | set(index)
    for relative in sorted(tracked | set(explicit)):
        _reject_policy(relative)
    _git_check_lfs_attributes(repo, tuple(sorted(tracked)), None)

    # The index is authoritative for staged additions/mode changes.  HEAD is
    # retained for sparse paths that have no index entry.
    records: dict[str, tuple[str, str, str]] = {}
    for relative, values in index.items():
        if len(values) != 1 or values[0][2] != 0:
            raise BackendInputError(f"unmerged Git index entry at {relative}")
        mode, object_id, _stage = values[0]
        if mode == "120000":
            raise BackendInputError(f"UNSAFE_SYMLINK: indexed symlink at {relative}")
        records[relative] = (mode, "blob", object_id)
    for relative, record in tree.items():
        records.setdefault(relative, record)

    skip_paths = _skip_worktree_paths(repo)
    sparse_records: dict[str, tuple[str, str, str]] = {}
    entries: list[dict[str, Any]] = []
    deleted: list[str] = []
    for relative in sorted(set(records) | set(explicit)):
        try:
            current = _current_entry(repo, relative)
        except SourceError as error:
            raise BackendInputError(f"live source entry is invalid: {error}") from error
        record = records.get(relative)
        if current.get("type") == "deleted":
            if relative in skip_paths and record is not None and record[0] in {"100644", "100755"}:
                sparse_records[relative] = record
                continue
            if relative in tracked:
                deleted.append(relative)
                continue
            raise BackendInputError(f"explicit untracked source disappeared: {relative}")
        if current.get("type") != "file":
            raise BackendInputError(f"live source entry is not a regular file: {relative}")
        entries.append(dict(current))

    git_object_ids: dict[str, str] = {}
    if sparse_records:
        try:
            blobs = _read_git_blobs(repo, sparse_records)
        except SourceError as error:
            raise BackendInputError(f"cannot read sparse Git objects: {error}") from error
        for relative, (mode, _kind, object_id) in sorted(sparse_records.items()):
            content = blobs.get(relative)
            if content is None:
                raise BackendInputError(f"Git object is missing for sparse source: {relative}")
            if _looks_like_lfs_pointer(content):
                raise BackendInputError(f"UNSUPPORTED_LFS: Git-LFS pointer at {relative}")
            git_object_ids[relative] = object_id
            entries.append({
                "path": relative,
                "type": "file",
                "mode": mode,
                "size": len(content),
                "sha256": _sha256_bytes(content),
            })

    untracked = set(_parse_untracked(repo))
    excluded = [
        *tree_excluded,
        *index_excluded,
        *(relative for relative in sorted(untracked) if relative not in set(explicit)),
    ]
    try:
        source_manifest = _manifest(
            mode="snapshot",
            repo=repo,
            common=_git_common_directory(repo),
            requested_ref=None,
            resolved_commit=head,
            head_commit=head,
            entries=entries,
            dirty=True,
            working_tree_dirty=_working_tree_dirty(repo),
            included_untracked=explicit,
            deleted=deleted,
            excluded=_normalise_excluded(excluded),
        )
    except SourceError as error:
        raise BackendInputError(f"cannot create live source manifest: {error}") from error
    return source_manifest, git_object_ids, _git_common_directory(repo)


def capture_backend_live_manifest(
    repo_root: Path,
    *,
    source_root: Path | None = None,
    output_dir: Path | None = None,
    capture_id: str | None = None,
    profile: str = "docker-all-gpu",
    include_untracked: tuple[str, ...] = (),
    require_windows: bool = True,
) -> dict[str, Any]:
    """Write a compact live-source manifest; never create a source archive."""

    if require_windows and os.name != "nt":
        raise BackendInputError("live backend source capture must run with native Windows Python")
    selected = (Path(source_root) if source_root is not None else Path(repo_root)).resolve(strict=True)
    layout = storage.resolve_layout(selected, profile)
    storage.initialize(layout)
    capture_id = capture_id or uuid.uuid4().hex
    if not CAPTURE_ID_RE.fullmatch(capture_id):
        raise BackendInputError("capture_id is not a safe immutable bundle identifier")
    build_root = Path(layout["build_root"])
    default_parent = storage.validate_path(build_root / "direct-backend-inputs", build_root)
    default_parent.mkdir(parents=True, exist_ok=True)
    final_output = Path(output_dir) if output_dir is not None else default_parent / capture_id
    final_output = storage.validate_path(final_output, build_root, "live backend manifest output")
    if final_output.exists():
        raise BackendInputError(f"live backend manifest output already exists: {final_output}")
    final_output.mkdir(parents=True)

    before = native_identity(selected, "snapshot")
    source_manifest, git_object_ids, common = _compact_live_source_manifest(
        selected, include_untracked=include_untracked
    )
    after = native_identity(selected, "snapshot")
    if before != after:
        raise BackendInputError("selected checkout changed while creating live source manifest")
    checked_source, _ = _validate_source_manifest(source_manifest)
    try:
        # Bind the native snapshot to the exact compact capsule.  Without this
        # check a dirty/untracked native input could be observed by the host
        # probe and silently omitted from the live worker input.
        native = bind_identity(after, checked_source)
    except (KeyError, ValueError) as error:
        raise BackendInputError(
            "selected checkout contains native inputs missing from live source manifest"
        ) from error
    source_manifest_sha256 = _sha256_bytes(_canonical_bytes(checked_source))
    document: dict[str, Any] = {
        "schema": LIVE_MANIFEST_SCHEMA,
        "capture_id": capture_id,
        "source_mode": LIVE_SOURCE_MODE,
        "source_root": str(selected),
        "git_common_dir": str(common),
        "resolved_commit": checked_source["resolved_commit"],
        "source_digest": checked_source["source_digest"],
        "source_snapshot_sha256": native["source_snapshot_sha256"],
        "native_source_identity": native,
        "source_manifest": checked_source,
        "source_manifest_sha256": source_manifest_sha256,
        "git_object_ids": git_object_ids,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    document["live_manifest_sha256"] = _sha256_bytes(_canonical_bytes(document))
    manifest_path = final_output / "manifest.json"
    _write_readonly_json(manifest_path, document)
    return {
        **document,
        "manifest_path": str(manifest_path),
        "output_dir": str(final_output),
    }

def capture_backend_source(
    repo_root: Path,
    *,
    source_root: Path | None = None,
    mode: str = "commit",
    ref: str | None = None,
    include_untracked: tuple[str, ...] = (),
    output_dir: Path | None = None,
    capture_id: str | None = None,
    profile: str = "docker-all-gpu",
    require_windows: bool = True,
) -> dict[str, Any]:
    """Capture a commit/snapshot on the native host, never via the queue."""

    if require_windows and os.name != "nt":
        raise BackendInputError("direct backend source capture must run with native Windows Python")
    selected = (Path(source_root) if source_root is not None else Path(repo_root)).resolve(strict=True)
    layout = storage.resolve_layout(selected, profile)
    storage.initialize(layout)
    capture_id = capture_id or uuid.uuid4().hex
    if not CAPTURE_ID_RE.fullmatch(capture_id):
        raise BackendInputError("capture_id is not a safe immutable bundle identifier")
    build_root = Path(layout["build_root"])
    default_parent = storage.validate_path(build_root / "direct-backend-inputs", build_root)
    default_parent.mkdir(parents=True, exist_ok=True)
    final_output = Path(output_dir) if output_dir is not None else default_parent / capture_id
    final_output = storage.validate_path(final_output, build_root, "direct backend archive output")
    if final_output.exists():
        raise BackendInputError(f"direct backend archive output already exists: {final_output}")
    staging = Path(tempfile.mkdtemp(prefix=f".backend-source-{capture_id}-", dir=default_parent))
    capsule = staging / "capsule"
    capsule.mkdir()
    try:
        before = native_identity(selected, "snapshot") if mode == "snapshot" else None
        source_manifest = capture_source(
            selected,
            capsule,
            mode=mode,
            ref=ref,
            include_untracked=include_untracked,
            content_store=None,
        )
        source_manifest = _restore_sparse_snapshot_files(selected, capsule, source_manifest)
        after = native_identity(selected, mode, source_manifest["resolved_commit"])
        if before is not None and before != after:
            raise BackendInputError("selected checkout changed during backend source capture")
        native = bind_identity(after, source_manifest)
        return build_backend_archive(
            capsule / "tree",
            source_manifest,
            native,
            final_output,
            capture_id=capture_id,
            source_root=str(selected),
        )
    finally:
        _cleanup_owned_source_staging(staging)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    capture = subparsers.add_parser("capture", help="capture one direct-Compose backend source archive")
    capture.add_argument("--repo-root", required=True, type=Path)
    capture.add_argument("--source-root", type=Path)
    capture.add_argument("--mode", choices=("commit", "snapshot"), default="commit")
    capture.add_argument("--ref", help="Git commit/ref for commit mode")
    capture.add_argument("--include-untracked", action="append", default=[])
    capture.add_argument("--output-dir", type=Path)
    capture.add_argument("--capture-id")
    capture.add_argument("--profile", default="docker-all-gpu")
    return parser


def _receipt_summary(result: Mapping[str, Any]) -> dict[str, Any]:
    source_manifest = result.get("source_manifest")
    native = result.get("native_source_identity")
    return {
        "schema": result.get("schema"),
        "capture_id": result.get("capture_id"),
        "source_mode": result.get("source_mode"),
        "resolved_commit": result.get("resolved_commit"),
        "source_digest": result.get("source_digest"),
        "source_snapshot_sha256": result.get("source_snapshot_sha256"),
        "archive_filename": result.get("archive_filename"),
        "archive_sha256": result.get("archive_sha256"),
        "archive_bytes": result.get("archive_bytes"),
        "archive_path": result.get("archive_path"),
        "manifest_path": result.get("manifest_path"),
        "live_manifest_sha256": result.get("live_manifest_sha256"),
        "git_common_dir": result.get("git_common_dir"),
        "output_dir": result.get("output_dir"),
        "file_count": len(source_manifest.get("files", [])) if isinstance(source_manifest, Mapping) else None,
        "deleted_count": len(source_manifest.get("deleted", [])) if isinstance(source_manifest, Mapping) else None,
        "included_untracked_count": len(source_manifest.get("included_untracked", [])) if isinstance(source_manifest, Mapping) else None,
        "native_head_commit_full": native.get("head_commit_full") if isinstance(native, Mapping) else None,
        "native_source_snapshot_sha256": native.get("source_snapshot_sha256") if isinstance(native, Mapping) else None,
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "capture":
        if args.mode == "commit" and not args.ref:
            raise BackendInputError("commit mode requires --ref")
        result = capture_backend_source(
            args.repo_root,
            source_root=args.source_root,
            mode=args.mode,
            ref=args.ref,
            include_untracked=tuple(args.include_untracked),
            output_dir=args.output_dir,
            capture_id=args.capture_id,
            profile=args.profile,
        )
        print(json.dumps(_receipt_summary(result), ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    raise BackendInputError(f"unsupported command: {args.command}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BackendInputError as error:
        print(f"docker backend source capture failed: {error}", file=sys.stderr)
        raise SystemExit(2)
