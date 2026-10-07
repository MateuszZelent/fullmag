"""Compact one verified legacy source capsule into the runner source CAS.

The caller must hold the coordinator, heavy-work, and worktree mutation locks
and prove that no process is using the capsule. This module deliberately does
not discover or acquire those locks itself.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
from typing import Any

from .source_store import SourceContentStore, SourceContentStoreError
from .worker_entrypoint import verify_source


RECEIPT_SCHEMA = "fullmag.source-compaction.v1"
_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_READONLY_ATTRIBUTE = 0x1
_MAX_RECEIPT_BYTES = 4 * 1024 * 1024
_CHUNK_SIZE = 1024 * 1024
_CHECKPOINT_FILES = 128


class SourceCompactionError(ValueError):
    """A source capsule or its compaction state cannot be trusted."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _identity(metadata: os.stat_result) -> tuple[int, int]:
    return metadata.st_dev, metadata.st_ino


def _is_reparse(metadata: os.stat_result) -> bool:
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & 0x400
    )


def _absolute_path(value: Path | str, label: str) -> Path:
    try:
        raw = Path(value).expanduser()
    except (TypeError, ValueError, OSError) as error:
        raise SourceCompactionError(f"invalid {label} path") from error
    if not raw.is_absolute() or ".." in raw.parts:
        raise SourceCompactionError(f"{label} path must be absolute and canonical")
    return Path(os.path.abspath(raw))


def _guard_components(path: Path, label: str, *, allow_missing: bool = False) -> None:
    """Reject links and reparse points in every path component."""

    absolute = Path(os.path.abspath(path))
    anchor = Path(absolute.anchor)
    current = anchor
    for part in absolute.parts[len(anchor.parts) :]:
        current = current / part
        try:
            metadata = current.lstat()
        except FileNotFoundError as error:
            if allow_missing:
                return
            raise SourceCompactionError(f"{label} does not exist: {current}") from error
        except OSError as error:
            raise SourceCompactionError(f"cannot inspect {label}: {current}") from error
        if _is_reparse(metadata):
            raise SourceCompactionError(
                f"{label} traverses a symlink or reparse point: {current}"
            )


def _real_directory(path: Path, label: str, *, create: bool = False) -> Path:
    _guard_components(path, label, allow_missing=create)
    try:
        if create:
            path.mkdir(parents=True, exist_ok=True)
        metadata = path.lstat()
    except OSError as error:
        raise SourceCompactionError(f"cannot prepare {label}: {path}") from error
    if _is_reparse(metadata) or not stat.S_ISDIR(metadata.st_mode):
        raise SourceCompactionError(f"{label} is not a real directory: {path}")
    _guard_components(path, label)
    return path


def _regular_file(path: Path, label: str) -> os.stat_result:
    _guard_components(path, label)
    try:
        metadata = path.lstat()
    except OSError as error:
        raise SourceCompactionError(f"cannot inspect {label}: {path}") from error
    if _is_reparse(metadata) or not stat.S_ISREG(metadata.st_mode):
        raise SourceCompactionError(f"{label} is not a regular file: {path}")
    return metadata


def _request_paths(
    storage_root: Path | str,
    capsule_path: Path | str,
) -> tuple[Path, Path, str, str]:
    storage = _absolute_path(storage_root, "storage root")
    capsule = _absolute_path(capsule_path, "source capsule")
    _real_directory(storage, "storage root")
    try:
        relative = capsule.relative_to(storage)
    except ValueError as error:
        raise SourceCompactionError(
            "source capsule is outside the declared storage root"
        ) from error
    parts = relative.parts
    if (
        len(parts) != 4
        or parts[0].casefold() != "runs"
        or parts[3].casefold() != "source"
        or not _ID_RE.fullmatch(parts[1])
        or not _ID_RE.fullmatch(parts[2])
    ):
        raise SourceCompactionError(
            "source capsule path must be exactly runs/<worktree-id>/<capture-id>/source"
        )
    _real_directory(capsule, "source capsule")
    _real_directory(capsule / "tree", "source tree")
    return storage, capsule, parts[1], parts[2]


def compaction_receipt_path(
    storage_root: Path | str,
    capsule_path: Path | str,
) -> Path:
    """Return the exact durable receipt path for a validated capsule path."""

    storage, _, worktree_id, capture_id = _request_paths(storage_root, capsule_path)
    return storage / "index" / "source-compaction" / worktree_id / f"{capture_id}.json"


def _read_receipt(path: Path, *, capsule_relative: str, digest: str) -> dict[str, Any] | None:
    if not os.path.lexists(path):
        return None
    metadata = _regular_file(path, "source-compaction receipt")
    if metadata.st_nlink != 1:
        raise SourceCompactionError("source-compaction receipt has an external hard link")
    if metadata.st_size > _MAX_RECEIPT_BYTES:
        raise SourceCompactionError("source-compaction receipt is too large")
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SourceCompactionError("cannot read source-compaction receipt") from error
    if (
        not isinstance(receipt, dict)
        or receipt.get("schema") != RECEIPT_SCHEMA
        or receipt.get("capsule") != capsule_relative
        or receipt.get("source_digest") != digest
        or receipt.get("state") not in {
            "running",
            "partial_failure",
            "completed",
            "completed_with_protected_files",
        }
        or not isinstance(receipt.get("tree_directories"), list)
    ):
        raise SourceCompactionError("source-compaction receipt identity or structure is invalid")
    return receipt


def _write_receipt(path: Path, receipt: dict[str, Any]) -> None:
    parent = _real_directory(path.parent, "source-compaction receipt directory", create=True)
    _guard_components(path, "source-compaction receipt", allow_missing=True)
    if os.path.lexists(path):
        existing = _regular_file(path, "source-compaction receipt")
        if existing.st_nlink != 1:
            raise SourceCompactionError("source-compaction receipt has an external hard link")
    receipt["updated_at"] = _now()
    encoded = (
        json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")
    if len(encoded) > _MAX_RECEIPT_BYTES:
        raise SourceCompactionError("source-compaction receipt would exceed its size limit")
    descriptor: int | None = None
    temporary: Path | None = None
    try:
        descriptor, name = tempfile.mkstemp(
            prefix=".source-compaction-", suffix=".tmp", dir=parent
        )
        temporary = Path(name)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        _regular_file(temporary, "temporary source-compaction receipt")
        _guard_components(path, "source-compaction receipt", allow_missing=True)
        os.replace(temporary, path)
        temporary = None
        _regular_file(path, "source-compaction receipt")
        if os.name != "nt":
            directory_fd = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    except SourceCompactionError:
        raise
    except OSError as error:
        raise SourceCompactionError(f"cannot persist source-compaction receipt: {path}") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass


def _fsync_source_parent(directory: Path) -> None:
    """Make a source-capsule directory-entry change durable on POSIX."""

    if os.name == "nt":
        return
    descriptor: int | None = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        descriptor = os.open(directory, flags)
        os.fsync(descriptor)
    except OSError as error:
        raise SourceCompactionError(
            f"cannot sync source parent directory: {directory}"
        ) from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _relative_file(tree: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative or "\x00" in relative:
        raise SourceCompactionError("manifest contains an unsafe source path")
    pure = PurePosixPath(relative)
    if (
        pure.is_absolute()
        or pure.as_posix() != relative
        or any(part in {"", ".", ".."} for part in relative.split("/"))
    ):
        raise SourceCompactionError("manifest contains a noncanonical source path")
    path = tree.joinpath(*pure.parts)
    try:
        path.relative_to(tree)
    except ValueError as error:
        raise SourceCompactionError("manifest source path escaped the capsule tree") from error
    _regular_file(path, "capsule source file")
    return path


def _same_file(left: Path, right: Path) -> bool:
    try:
        return os.path.samefile(left, right)
    except OSError as error:
        raise SourceCompactionError(
            "filesystem cannot verify a content-store hard link"
        ) from error


def _readonly_seal(metadata: os.stat_result, mode: str) -> bool:
    if os.name == "nt":
        return bool(getattr(metadata, "st_file_attributes", 0) & _READONLY_ATTRIBUTE)
    expected = 0o555 if mode == "100755" else 0o444
    return stat.S_IMODE(metadata.st_mode) == expected


def _cas_linked(
    source_file: Path,
    store: SourceContentStore,
    entry: dict[str, Any],
) -> bool:
    """Identify a CAS link after verify_source has hashed the capsule bytes.

    A same-inode check makes the full capsule hash also verify the CAS bytes.
    The store seal and Git-mode key are checked from metadata here. Private
    stages are separately hashed by this module and SourceContentStore.
    """

    object_path = store._object_path(entry["sha256"], entry["mode"])
    _guard_components(object_path, "source content object", allow_missing=True)
    if not os.path.lexists(object_path):
        return False
    source_metadata = _regular_file(source_file, "capsule source file")
    object_metadata = _regular_file(object_path, "source content object")
    if not _same_file(source_file, object_path):
        return False
    if _identity(source_metadata) != _identity(object_metadata) or not _readonly_seal(
        object_metadata, entry["mode"]
    ):
        raise SourceCompactionError("capsule hard link does not have the verified CAS seal")
    return True


def _read_only(metadata: os.stat_result) -> bool:
    if os.name == "nt":
        return bool(getattr(metadata, "st_file_attributes", 0) & _READONLY_ATTRIBUTE)
    return not bool(metadata.st_mode & stat.S_IWUSR)


def _directory_records(tree: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for current, directory_names, _file_names in os.walk(tree, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in directory_names:
            path = current_path / name
            metadata = path.lstat()
            if _is_reparse(metadata) or not stat.S_ISDIR(metadata.st_mode):
                raise SourceCompactionError("source tree contains a symlink or reparse point")
        metadata = current_path.stat(follow_symlinks=False)
        relative = "." if current_path == tree else current_path.relative_to(tree).as_posix()
        records.append(
            {
                "path": relative,
                "mode": stat.S_IMODE(metadata.st_mode),
                "identity": list(_identity(metadata)),
            }
        )
    records.sort(key=lambda item: item["path"])
    return records


def _directory_path(tree: Path, relative: str) -> Path:
    if (
        not isinstance(relative, str)
        or "\\" in relative
        or "\x00" in relative
        or (relative != "." and any(part in {"", ".", ".."} for part in relative.split("/")))
    ):
        raise SourceCompactionError("receipt has an unsafe source directory path")
    path = tree if relative == "." else tree.joinpath(*PurePosixPath(relative).parts)
    try:
        path.relative_to(tree)
    except ValueError as error:
        raise SourceCompactionError("receipt directory escaped capsule tree") from error
    return _real_directory(path, "capsule source directory")


def _validate_directory_records(tree: Path, records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    expected: dict[str, dict[str, Any]] = {}
    for item in records:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("path"), str)
            or isinstance(item.get("mode"), bool)
            or not isinstance(item.get("mode"), int)
            or not isinstance(item.get("identity"), list)
            or len(item["identity"]) != 2
        ):
            raise SourceCompactionError("receipt has invalid source directory metadata")
        relative = item["path"]
        if relative in expected or (relative != "." and relative.startswith("/")):
            raise SourceCompactionError("receipt has duplicate or unsafe source directory metadata")
        path = _directory_path(tree, relative)
        metadata = path.stat(follow_symlinks=False)
        if _identity(metadata) != tuple(item["identity"]):
            raise SourceCompactionError("source directory identity differs from its receipt")
        expected[relative] = item
    actual = _directory_records(tree)
    if {item["path"] for item in actual} != set(expected):
        raise SourceCompactionError("source directory membership differs from its receipt")
    return expected


def _restore_directories(tree: Path, records: dict[str, dict[str, Any]]) -> None:
    if os.name == "nt":
        return
    for relative, item in sorted(records.items(), key=lambda pair: pair[0].count("/"), reverse=True):
        path = _directory_path(tree, relative)
        metadata = path.stat(follow_symlinks=False)
        if _identity(metadata) != tuple(item["identity"]):
            raise SourceCompactionError("source directory identity changed during compaction")
        original = int(item["mode"])
        current = stat.S_IMODE(metadata.st_mode)
        if current == (original | stat.S_IWUSR):
            path.chmod(original)
        elif current != original:
            raise SourceCompactionError("source directory permissions changed unexpectedly")


def _stage_name(entry: dict[str, Any]) -> str:
    return f".compact-{entry['sha256']}-{entry['mode']}.tmp"


def _stage_root(storage: Path, worktree_id: str, capture_id: str) -> Path:
    return _real_directory(
        storage / "tmp" / "source-compaction" / worktree_id / capture_id,
        "source-compaction stage directory",
        create=True,
    )


def _stage_path(stage_root: Path, name: str) -> Path:
    if not name.startswith(".compact-") or Path(name).name != name:
        raise SourceCompactionError("recorded compaction stage name is invalid")
    path = stage_root / name
    _guard_components(path, "compaction stage", allow_missing=True)
    return path


def _cleanup_stage(
    stage_path: Path,
    *,
    store: SourceContentStore,
    entry: dict[str, Any],
    private_identity: tuple[int, int] | None = None,
) -> None:
    if not os.path.lexists(stage_path):
        return
    metadata = _regular_file(stage_path, "compaction stage file")
    object_path = store._object_path(entry["sha256"], entry["mode"])
    _guard_components(object_path, "source content object", allow_missing=True)
    if os.path.lexists(object_path) and _same_file(stage_path, object_path):
        store.unlink_stage_link(
            stage_path,
            digest=entry["sha256"],
            mode=entry["mode"],
            size=entry["size"],
        )
        return
    if private_identity is not None and _identity(metadata) != private_identity:
        raise SourceCompactionError("compaction stage identity changed; leaving it untouched")
    if metadata.st_nlink != 1:
        raise SourceCompactionError(
            "unrecognized or externally linked compaction stage; leaving it untouched"
        )
    stage_path.unlink()


def _sweep_stages(
    stage_root: Path,
    entries_by_stage: dict[str, dict[str, Any]],
    store: SourceContentStore,
) -> None:
    for path in stage_root.iterdir():
        entry = entries_by_stage.get(path.name)
        if entry is None:
            raise SourceCompactionError(f"unrecognized file in compaction stage directory: {path.name}")
        _cleanup_stage(path, store=store, entry=entry)


def _copy_private_stage(
    source_file: Path,
    stage_path: Path,
    entry: dict[str, Any],
) -> tuple[int, int]:
    before = _regular_file(source_file, "capsule source file")
    if before.st_nlink != 1:
        raise SourceCompactionError("capsule file acquired an external hard link during compaction")
    digest = hashlib.sha256()
    size = 0
    descriptor: int | None = None
    stage_identity: tuple[int, int] | None = None
    try:
        descriptor = os.open(stage_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        stage_identity = _identity(os.fstat(descriptor))
        with os.fdopen(descriptor, "wb") as destination:
            descriptor = None
            with source_file.open("rb") as source:
                opened = os.fstat(source.fileno())
                if _identity(opened) != _identity(before) or not stat.S_ISREG(opened.st_mode):
                    raise SourceCompactionError("capsule file changed while opening its private stage")
                while True:
                    chunk = source.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    destination.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
                after_open = os.fstat(source.fileno())
                destination.flush()
                os.fsync(destination.fileno())
        after = _regular_file(source_file, "capsule source file")
    except SourceCompactionError:
        if stage_identity is not None:
            try:
                metadata = _regular_file(stage_path, "private compaction stage")
                if _identity(metadata) == stage_identity and metadata.st_nlink == 1:
                    stage_path.unlink()
            except FileNotFoundError:
                pass
        raise
    except OSError as error:
        if stage_identity is not None:
            try:
                metadata = _regular_file(stage_path, "private compaction stage")
                if _identity(metadata) == stage_identity and metadata.st_nlink == 1:
                    stage_path.unlink()
            except FileNotFoundError:
                pass
        raise SourceCompactionError(f"cannot stage capsule file privately: {source_file}") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
    stage_metadata = _regular_file(stage_path, "private compaction stage")
    if (
        _identity(before) != _identity(after)
        or _identity(after_open) != _identity(after)
        or before.st_size != after.st_size
        or size != entry["size"]
        or stage_metadata.st_size != size
        or digest.hexdigest() != entry["sha256"]
        or _same_file(source_file, stage_path)
        or stage_metadata.st_nlink != 1
    ):
        if stage_identity is not None and _identity(stage_metadata) == stage_identity and stage_metadata.st_nlink == 1:
            stage_path.unlink()
        raise SourceCompactionError("private compaction stage does not match the verified capsule file")
    try:
        stage_path.chmod(0o755 if entry["mode"] == "100755" else 0o644)
    except OSError as error:
        if stage_identity is not None:
            try:
                metadata = _regular_file(stage_path, "private compaction stage")
                if _identity(metadata) == stage_identity and metadata.st_nlink == 1:
                    stage_path.unlink()
            except FileNotFoundError:
                pass
        raise SourceCompactionError("cannot set the private compaction-stage mode") from error
    return stage_identity


def _new_receipt(capsule_relative: str, digest: str, tree_directories: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema": RECEIPT_SCHEMA,
        "capsule": capsule_relative,
        "source_digest": digest,
        "state": "running",
        "created_at": _now(),
        "updated_at": _now(),
        "tree_directories": tree_directories,
        "converted_count": 0,
        "skipped_count": 0,
        "protected_count": 0,
        "converted_bytes": 0,
        "skipped_bytes": 0,
        "logical_duplicate_bytes": 0,
        "checkpoint_files": 0,
        "last_error": None,
    }


def _counts_for_invocation(receipt: dict[str, Any]) -> None:
    receipt["logical_duplicate_bytes"] = receipt["converted_bytes"] + receipt["skipped_bytes"]


def _compact_one(
    source_file: Path,
    entry: dict[str, Any],
    *,
    stage_path: Path,
    store: SourceContentStore,
    directory_records: dict[str, dict[str, Any]],
) -> str:
    source_metadata = _regular_file(source_file, "capsule source file")
    if _cas_linked(source_file, store, entry):
        _fsync_source_parent(source_file.parent)
        return "skipped"
    if source_metadata.st_nlink != 1:
        return "protected"
    if stage_path.parent.stat(follow_symlinks=False).st_dev != source_file.parent.stat(follow_symlinks=False).st_dev:
        raise SourceCompactionError("compaction stage and capsule are on different filesystems")

    original_mode = stat.S_IMODE(source_metadata.st_mode)
    was_readonly = _read_only(source_metadata)
    original_identity = _identity(source_metadata)
    # The source-relative parent is carried by the manifest path, not the host path.
    parent_relative = PurePosixPath(entry["path"]).parent.as_posix()
    directory_item = directory_records.get(parent_relative)
    if directory_item is None:
        raise SourceCompactionError("source parent is absent from the directory receipt")
    parent = source_file.parent
    parent_metadata = parent.stat(follow_symlinks=False)
    if _identity(parent_metadata) != tuple(directory_item["identity"]):
        raise SourceCompactionError("source parent directory identity changed")

    stage_owned = False
    source_entry_changed = False
    try:
        stage_identity = _copy_private_stage(source_file, stage_path, entry)
        stage_owned = True
        store.link_file(
            stage_path,
            stage_path,
            digest=entry["sha256"],
            mode=entry["mode"],
            size=entry["size"],
        )
        if not _cas_linked(stage_path, store, entry):
            raise SourceCompactionError("private stage was not linked to the verified CAS object")

        if os.name != "nt":
            original_directory_mode = int(directory_item["mode"])
            current_directory_mode = stat.S_IMODE(parent.stat(follow_symlinks=False).st_mode)
            if current_directory_mode == original_directory_mode:
                parent.chmod(original_directory_mode | stat.S_IWUSR)
            elif current_directory_mode != (original_directory_mode | stat.S_IWUSR):
                raise SourceCompactionError("source parent directory permissions changed unexpectedly")

        current = _regular_file(source_file, "capsule source file")
        if _identity(current) != original_identity or current.st_nlink != 1:
            raise SourceCompactionError("capsule file identity or link count changed before replacement")
        if os.name == "nt" and was_readonly:
            source_file.chmod(original_mode | 0o222)
            current = _regular_file(source_file, "capsule source file")
            if _identity(current) != original_identity:
                raise SourceCompactionError("capsule file identity changed while clearing read-only state")
        try:
            os.replace(stage_path, source_file)
            source_entry_changed = True
        except OSError:
            if not _cas_linked(source_file, store, entry):
                raise
            source_entry_changed = True
        if not _cas_linked(source_file, store, entry):
            raise SourceCompactionError("atomic replacement did not install the verified CAS hard link")
        return "converted"
    except Exception:
        try:
            current = _regular_file(source_file, "capsule source file")
            if _identity(current) == original_identity:
                if os.name == "nt" and was_readonly and not _read_only(current):
                    source_file.chmod(original_mode)
                if stage_owned:
                    _cleanup_stage(
                        stage_path,
                        store=store,
                        entry=entry,
                        private_identity=stage_identity,
                    )
        finally:
            if os.name != "nt":
                current_mode = stat.S_IMODE(parent.stat(follow_symlinks=False).st_mode)
                original_directory_mode = int(directory_item["mode"])
                if current_mode == (original_directory_mode | stat.S_IWUSR):
                    parent.chmod(original_directory_mode)
                elif current_mode != original_directory_mode:
                    raise SourceCompactionError("source parent directory permissions changed unexpectedly")
        raise
    finally:
        if os.name != "nt":
            current_mode = stat.S_IMODE(parent.stat(follow_symlinks=False).st_mode)
            original_directory_mode = int(directory_item["mode"])
            if current_mode == (original_directory_mode | stat.S_IWUSR):
                parent.chmod(original_directory_mode)
        if source_entry_changed:
            _fsync_source_parent(parent)


def _compact_source_capsule(
    storage_root: Path | str,
    capsule_path: Path | str,
    expected_digest: str,
) -> dict[str, object]:
    """Compact one exact historical source capsule into the canonical CAS.

    The receipt is atomically checkpointed every 128 manifest files and on
    completion/failure. A private stage has a deterministic per-content name,
    so restart can identify and clean an interrupted copy or CAS link without
    growing a per-file receipt. Returned bytes are logical bytes represented
    by CAS links; no physical-reclaim estimate is made.
    """

    if not isinstance(expected_digest, str) or not _DIGEST_RE.fullmatch(expected_digest):
        raise SourceCompactionError("expected source digest must be lowercase SHA-256")
    storage, source, worktree_id, capture_id = _request_paths(storage_root, capsule_path)
    try:
        manifest = verify_source(source, expected_digest)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SourceCompactionError(f"source capsule verification failed: {error}") from error
    manifest_bytes = (source / "manifest.json").read_bytes()
    capsule_relative = source.relative_to(storage).as_posix()
    receipt_path = storage / "index" / "source-compaction" / worktree_id / f"{capture_id}.json"
    _guard_components(receipt_path, "source-compaction receipt", allow_missing=True)
    tree = source / "tree"
    tree_directories = _directory_records(tree)
    receipt = _read_receipt(
        receipt_path,
        capsule_relative=capsule_relative,
        digest=expected_digest,
    )
    if receipt is None:
        receipt = _new_receipt(capsule_relative, expected_digest, tree_directories)
        _write_receipt(receipt_path, receipt)
    elif receipt["tree_directories"] != tree_directories:
        # Compare identities and original modes only after restoring an interrupted chmod.
        receipt_records = _validate_directory_records(tree, receipt["tree_directories"])
        _restore_directories(tree, receipt_records)
        tree_directories = _directory_records(tree)
        if receipt["tree_directories"] != tree_directories:
            raise SourceCompactionError("source directory identity or mode differs from its checkpoint")

    directory_records = _validate_directory_records(tree, receipt["tree_directories"])
    _restore_directories(tree, directory_records)
    store = SourceContentStore(storage / "cache" / "source-content-v1")
    stage_root = _stage_root(storage, worktree_id, capture_id)
    entries = [entry for entry in manifest["files"] if entry.get("type") == "file"]
    entries_by_stage = {_stage_name(entry): entry for entry in entries}
    _sweep_stages(stage_root, entries_by_stage, store)

    receipt["state"] = "running"
    receipt["last_error"] = None
    receipt["converted_count"] = 0
    receipt["skipped_count"] = 0
    receipt["protected_count"] = 0
    receipt["converted_bytes"] = 0
    receipt["skipped_bytes"] = 0
    receipt["logical_duplicate_bytes"] = 0
    receipt["checkpoint_files"] = 0
    _write_receipt(receipt_path, receipt)

    processed = 0
    try:
        for entry in entries:
            relative = entry["path"]
            source_file = _relative_file(tree, relative)
            stage_path = _stage_path(stage_root, _stage_name(entry))
            status = _compact_one(
                source_file,
                entry,
                stage_path=stage_path,
                store=store,
                directory_records=directory_records,
            )
            if status == "converted":
                receipt["converted_count"] += 1
                receipt["converted_bytes"] += entry["size"]
            elif status == "skipped":
                receipt["skipped_count"] += 1
                receipt["skipped_bytes"] += entry["size"]
            else:
                receipt["protected_count"] += 1
            processed += 1
            receipt["checkpoint_files"] = processed
            _counts_for_invocation(receipt)
            if processed % _CHECKPOINT_FILES == 0:
                _restore_directories(tree, directory_records)
                _sweep_stages(stage_root, entries_by_stage, store)
                _write_receipt(receipt_path, receipt)

        _restore_directories(tree, directory_records)
        _sweep_stages(stage_root, entries_by_stage, store)
        final_manifest = verify_source(source, expected_digest)
        final_manifest_bytes = (source / "manifest.json").read_bytes()
        if final_manifest["source_digest"] != expected_digest or final_manifest_bytes != manifest_bytes:
            raise SourceCompactionError("source capsule identity changed during compaction")
    except Exception as error:
        try:
            _restore_directories(tree, directory_records)
        except Exception as restore_error:
            error = SourceCompactionError(f"{error}; directory restore failed: {restore_error}")
        receipt["state"] = "partial_failure"
        receipt["last_error"] = str(error)[:2000]
        _counts_for_invocation(receipt)
        try:
            _write_receipt(receipt_path, receipt)
        except Exception as receipt_error:
            raise SourceCompactionError(
                f"source compaction failed: {error}; receipt update failed: {receipt_error}"
            ) from error
        try:
            verify_source(source, expected_digest)
        except Exception as verify_error:
            raise SourceCompactionError(
                f"source compaction failed and capsule verification after failure failed: {verify_error}"
            ) from error
        if isinstance(error, SourceCompactionError):
            raise error
        if isinstance(error, (OSError, ValueError, KeyError, TypeError, SourceContentStoreError)):
            raise SourceCompactionError(f"source compaction failed: {error}") from error
        raise

    _counts_for_invocation(receipt)
    receipt["state"] = (
        "completed_with_protected_files"
        if receipt["protected_count"]
        else "completed"
    )
    receipt["last_error"] = None
    _write_receipt(receipt_path, receipt)
    return {
        "state": receipt["state"],
        "source_digest": expected_digest,
        "converted_count": receipt["converted_count"],
        "skipped_count": receipt["skipped_count"],
        "protected_count": receipt["protected_count"],
        "logical_duplicate_bytes": receipt["logical_duplicate_bytes"],
        "receipt_path": str(receipt_path),
    }


def compact_source_capsule(
    storage_root: Path | str,
    capsule_path: Path | str,
    expected_digest: str,
) -> dict[str, object]:
    """Public fail-closed entrypoint for one capsule compaction."""

    try:
        return _compact_source_capsule(storage_root, capsule_path, expected_digest)
    except SourceCompactionError:
        raise
    except Exception as error:
        raise SourceCompactionError(f"source compaction failed: {error}") from error


__all__ = [
    "RECEIPT_SCHEMA",
    "SourceCompactionError",
    "compact_source_capsule",
    "compaction_receipt_path",
]
