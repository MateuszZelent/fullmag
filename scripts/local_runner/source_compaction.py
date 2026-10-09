"""Compact one verified legacy source capsule into the runner source CAS.

The caller must hold the coordinator, heavy-work, and worktree mutation locks
and prove that no process is using the capsule. This module deliberately does
not discover or acquire those locks itself.
"""

from __future__ import annotations

from datetime import datetime, timezone
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile
import uuid
from typing import Any, Callable

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
        + "\r\n"
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


def _fsync_source_parent(
    directory: Path,
    *,
    owner: _VerifiedDirectoryOwner | None = None,
) -> None:
    """Make a source-capsule directory-entry change durable on POSIX."""

    if os.name == "nt":
        return
    if owner is None or owner.path != directory:
        raise SourceCompactionError("source-parent fsync requires its verified directory owner")
    owner.fsync()


def _windows_api() -> tuple[Any, Any, Any]:
    """Load only the Win32 calls needed to hold and identify directory owners."""

    loader = getattr(ctypes, "WinDLL", None)
    if loader is None:
        raise SourceCompactionError("verified Windows source-parent handles are unavailable")
    try:
        from ctypes import wintypes

        kernel32 = loader("kernel32", use_last_error=True)
    except (AttributeError, OSError) as error:
        raise SourceCompactionError("cannot load Windows source-parent handle APIs") from error
    try:
        kernel32.CreateFileW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
        kernel32.GetFileInformationByHandle.restype = wintypes.BOOL
        kernel32.GetFileInformationByHandleEx.argtypes = [
            wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
        ]
        kernel32.GetFileInformationByHandleEx.restype = wintypes.BOOL
        kernel32.SetFileInformationByHandle.argtypes = [
            wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
        ]
        kernel32.SetFileInformationByHandle.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
    except AttributeError as error:
        raise SourceCompactionError("required Windows owner-handle APIs are unavailable") from error
    return ctypes, wintypes, kernel32


def _windows_error(ctypes_module: Any, action: str) -> SourceCompactionError:
    code = ctypes_module.get_last_error()
    detail = ctypes_module.FormatError(code).strip()
    return SourceCompactionError(f"{action} failed with Win32 error {code}: {detail}")


def _windows_stat_snapshot_format() -> str:
    if sys.implementation.name != "cpython":
        raise SourceCompactionError(
            "Windows stat identity format is unsupported for "
            f"Python implementation {sys.implementation.name!r}"
        )
    version = sys.version_info[:2]
    if version == (3, 11):
        return "legacy"
    if version >= (3, 12):
        return "full_native"
    raise SourceCompactionError(
        f"Windows stat identity format is unsupported for CPython {version[0]}.{version[1]}"
    )


def _windows_handle_info(
    kernel32: Any,
    handle: Any,
    *,
    expected_snapshot: tuple[int, int] | None = None,
    expected_snapshot_format: str | None = None,
    expected_native: tuple[int, int] | None = None,
) -> tuple[tuple[int, int], int]:
    """Return the full native identity, validating a stat snapshot or native ID."""

    if expected_snapshot is not None and expected_native is not None:
        raise SourceCompactionError(
            "Windows handle identity check cannot mix snapshot and native expectations"
        )
    if expected_snapshot is None and expected_snapshot_format is not None:
        raise SourceCompactionError(
            "Windows stat snapshot format requires an expected snapshot"
        )

    from ctypes import wintypes

    class FileTime(ctypes.Structure):
        _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]

    class ByHandleInfo(ctypes.Structure):
        _fields_ = [
            ("attributes", wintypes.DWORD),
            ("created", FileTime),
            ("accessed", FileTime),
            ("written", FileTime),
            ("volume", wintypes.DWORD),
            ("size_high", wintypes.DWORD),
            ("size_low", wintypes.DWORD),
            ("links", wintypes.DWORD),
            ("index_high", wintypes.DWORD),
            ("index_low", wintypes.DWORD),
        ]

    class FileIdInfo(ctypes.Structure):
        _fields_ = [
            ("volume", ctypes.c_uint64),
            ("file_id", ctypes.c_ubyte * 16),
        ]

    info = ByHandleInfo()
    if not kernel32.GetFileInformationByHandle(handle, ctypes.byref(info)):
        raise _windows_error(ctypes, "GetFileInformationByHandle")
    file_id_info = FileIdInfo()
    if not kernel32.GetFileInformationByHandleEx(
            handle, 18, ctypes.byref(file_id_info), ctypes.sizeof(file_id_info)):
        raise _windows_error(ctypes, "GetFileInformationByHandleEx(FileIdInfo)")
    raw_file_id = bytes(file_id_info.file_id)
    if not any(raw_file_id):
        raise SourceCompactionError("Windows filesystem did not provide a stable 128-bit file identity")
    volume = int(file_id_info.volume)
    file_index = int.from_bytes(raw_file_id, "little")
    identity = (volume, file_index)
    legacy_index = (int(info.index_high) << 32) | int(info.index_low)
    legacy_identity = (int(info.volume), legacy_index)
    # CPython 3.11 snapshots use the legacy volume/index pair. CPython 3.12+
    # exposes FileIdInfo's full 128-bit inode. Never try the other format as a
    # fallback: a native high-half change must not pass as a matching legacy ID.
    if expected_native is not None and expected_native != identity:
        raise SourceCompactionError(
            "Windows native handle identity changed "
            f"(expected_native={expected_native!r}, legacy={legacy_identity!r}, "
            f"native={identity!r}, "
            f"file_id={raw_file_id.hex()})"
        )
    if expected_snapshot is not None:
        snapshot_format = expected_snapshot_format or _windows_stat_snapshot_format()
        if snapshot_format == "legacy":
            snapshot_matches = expected_snapshot == legacy_identity
        elif snapshot_format == "full_native":
            snapshot_matches = expected_snapshot == identity
        else:
            raise SourceCompactionError(
                f"unsupported Windows stat snapshot format {snapshot_format!r}"
            )
        if not snapshot_matches:
            raise SourceCompactionError(
                "Windows handle identity differs from stat snapshot "
                f"(format={snapshot_format!r}, expected_snapshot={expected_snapshot!r}, "
                f"legacy={legacy_identity!r}, native={identity!r}, "
                f"file_id={raw_file_id.hex()})"
            )
    if not volume or not file_index:
        raise SourceCompactionError("Windows filesystem did not provide a stable file identity")
    return identity, int(info.attributes)


def _windows_open_handle(
    path: Path,
    *,
    access: int,
    share: int,
    flags: int,
    label: str,
    creation: int = 3,
) -> tuple[Any, Any, Any, Any]:
    ctypes_module, wintypes, kernel32 = _windows_api()
    handle = kernel32.CreateFileW(
        str(path), access, share, None, creation, flags, None,
    )
    invalid = ctypes_module.c_void_p(-1).value
    if handle in (None, invalid):
        raise _windows_error(ctypes_module, f"CreateFileW for {label}")
    return ctypes_module, wintypes, kernel32, handle


class _VerifiedDirectoryOwner:
    """Keep source and stage directory ownership bound across compaction."""

    def __init__(
        self,
        path: Path,
        expected_identity: tuple[int, int],
        label: str,
    ) -> None:
        self.path = path
        self.expected_identity = expected_identity
        self.label = label
        self.fd: int | None = None
        self.handle: Any = None
        self._ctypes: Any = None
        self._kernel32: Any = None
        self.identity: tuple[int, int] | None = None

    def __enter__(self) -> "_VerifiedDirectoryOwner":
        if os.name == "nt":
            self._ctypes, _wintypes, self._kernel32, self.handle = _windows_open_handle(
                self.path,
                access=0x0001 | 0x0080,  # FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES
                share=0x0001 | 0x0002,  # FILE_SHARE_READ | FILE_SHARE_WRITE; deny delete/rename
                flags=0x02000000 | 0x00200000,  # BACKUP_SEMANTICS | OPEN_REPARSE_POINT
                label=self.label,
            )
            try:
                identity, attributes = _windows_handle_info(
                    self._kernel32,
                    self.handle,
                    expected_snapshot=self.expected_identity,
                )
            except Exception:
                self.close()
                raise
            if attributes & 0x400 or not attributes & 0x10:
                self.close()
                raise SourceCompactionError(f"{self.label} is not a real Windows directory")
        elif os.name == "posix":
            if (not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NOFOLLOW")
                    or not hasattr(os, "fchmod")
                    or os.stat not in os.supports_dir_fd
                    or os.open not in os.supports_dir_fd
                    or os.rename not in os.supports_dir_fd
                    or os.unlink not in os.supports_dir_fd
                    or os.link not in os.supports_dir_fd
                    or os.mkdir not in os.supports_dir_fd
                    or os.rmdir not in os.supports_dir_fd
                    or os.listdir not in os.supports_fd):
                raise SourceCompactionError(
                    "descriptor-relative source-parent operations are unsupported on this POSIX host"
                )
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
            try:
                self.fd = os.open(self.path, flags)
                metadata = os.fstat(self.fd)
            except OSError as error:
                self.close()
                raise SourceCompactionError(f"cannot open verified {self.label}: {self.path}") from error
            if not stat.S_ISDIR(metadata.st_mode) or _is_reparse(metadata):
                self.close()
                raise SourceCompactionError(f"{self.label} is not a real directory")
            identity = _identity(metadata)
        else:
            raise SourceCompactionError(
                f"verified source-parent ownership is unsupported on platform {os.name!r}"
            )
        if os.name != "nt" and identity != self.expected_identity:
            self.close()
            raise SourceCompactionError(f"{self.label} identity changed before compaction")
        self.identity = identity
        try:
            self.verify_path_identity()
        except Exception:
            self.close()
            raise
        return self

    @property
    def device(self) -> int:
        if self.identity is None:
            raise SourceCompactionError(f"{self.label} owner is not open")
        # Filesystem comparisons elsewhere use Python's stat snapshot format.
        return self.expected_identity[0]

    def verify_handle_identity(self) -> None:
        if self.identity is None:
            raise SourceCompactionError(f"{self.label} owner is not open")
        if os.name == "nt":
            identity, attributes = _windows_handle_info(
                self._kernel32, self.handle, expected_native=self.identity
            )
            if attributes & 0x400 or not attributes & 0x10:
                raise SourceCompactionError(f"{self.label} handle no longer names a real directory")
        else:
            metadata = os.fstat(self.fd)
            if not stat.S_ISDIR(metadata.st_mode) or _is_reparse(metadata):
                raise SourceCompactionError(f"{self.label} handle no longer names a real directory")
            identity = _identity(metadata)
        if identity != self.identity:
            raise SourceCompactionError(f"{self.label} handle identity changed")

    def verify_path_identity(self) -> None:
        self.verify_handle_identity()
        try:
            metadata = self.path.lstat()
        except OSError as error:
            raise SourceCompactionError(f"{self.label} path changed during compaction") from error
        if (_is_reparse(metadata) or not stat.S_ISDIR(metadata.st_mode)
                or _identity(metadata) != self.expected_identity):
            raise SourceCompactionError(f"{self.label} path identity changed during compaction")

    def stat_file(self, name: str, label: str) -> os.stat_result:
        if (not isinstance(name, str) or not name or name in {".", ".."}
                or "/" in name or "\\" in name or "\x00" in name):
            raise SourceCompactionError(f"invalid {label} basename")
        self.verify_handle_identity()
        if os.name == "nt":
            self.verify_path_identity()
            file_path = self.path / name
            try:
                return _regular_file(file_path, label)
            except SourceCompactionError:
                if not os.path.lexists(file_path):
                    raise FileNotFoundError(name)
                raise
        try:
            metadata = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        except FileNotFoundError:
            raise
        except OSError as error:
            raise SourceCompactionError(f"cannot inspect {label} relative to its owner") from error
        if _is_reparse(metadata) or not stat.S_ISREG(metadata.st_mode):
            raise SourceCompactionError(f"{label} is not a regular file")
        return metadata

    def list_files(self) -> list[str]:
        self.verify_path_identity()
        if os.name == "posix":
            try:
                names = os.listdir(self.fd)
            except OSError as error:
                raise SourceCompactionError(
                    f"cannot enumerate {self.label} relative to its owner"
                ) from error
        elif os.name == "nt":
            try:
                names = [item.name for item in self.path.iterdir()]
            except OSError as error:
                raise SourceCompactionError(f"cannot enumerate {self.label}") from error
        else:
            raise SourceCompactionError(
                f"verified directory enumeration is unsupported on platform {os.name!r}"
            )
        self.verify_path_identity()
        return names

    def create_file(self, name: str, mode: int) -> tuple[int, tuple[int, int]]:
        if (not isinstance(name, str) or not name or name in {".", ".."}
                or "/" in name or "\\" in name or "\x00" in name):
            raise SourceCompactionError("invalid private compaction-stage basename")
        self.verify_path_identity()
        descriptor: int | None = None
        handle: Any = None
        transferred = False
        try:
            if os.name == "posix":
                flags = (
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW
                    | getattr(os, "O_CLOEXEC", 0)
                )
                descriptor = os.open(name, flags, mode, dir_fd=self.fd)
            elif os.name == "nt":
                _ctypes, _wintypes, kernel32, handle = _windows_open_handle(
                    self.path / name,
                    access=0x40000000 | 0x0080,  # GENERIC_WRITE | FILE_READ_ATTRIBUTES
                    share=0x0001 | 0x0002,  # deny delete/rename while this file is open
                    flags=0x00200000,  # OPEN_REPARSE_POINT
                    label="private compaction stage",
                    creation=1,  # CREATE_NEW
                )
                import msvcrt

                descriptor = msvcrt.open_osfhandle(
                    int(handle), os.O_WRONLY | getattr(os, "O_BINARY", 0)
                )
                handle = None
            else:
                raise SourceCompactionError(
                    f"verified stage creation is unsupported on platform {os.name!r}"
                )
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or _is_reparse(metadata):
                raise SourceCompactionError("private compaction stage is not a regular file")
            identity = _identity(metadata)
            if os.name == "nt":
                native_handle = msvcrt.get_osfhandle(descriptor)
                handle_identity, attributes = _windows_handle_info(
                    self._kernel32, native_handle, expected_snapshot=identity
                )
                if attributes & (0x400 | 0x10):
                    raise SourceCompactionError(
                        "private compaction stage handle identity is unstable"
                    )
                confirmed_identity, confirmed_attributes = _windows_handle_info(
                    self._kernel32,
                    native_handle,
                    expected_native=handle_identity,
                )
                if (confirmed_identity != handle_identity
                        or confirmed_attributes & (0x400 | 0x10)):
                    raise SourceCompactionError(
                        "private compaction stage native handle identity changed"
                    )
            self.verify_path_identity()
            transferred = True
            return descriptor, identity
        except FileExistsError:
            raise SourceCompactionError("private compaction stage already exists")
        except SourceCompactionError:
            raise
        except OSError as error:
            raise SourceCompactionError(
                f"cannot create private compaction stage relative to its owner: {name}"
            ) from error
        finally:
            if handle is not None:
                if not self._kernel32.CloseHandle(handle):
                    raise _windows_error(self._ctypes, "CloseHandle for private stage creation")
            if descriptor is not None and not transferred:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def open_file(
        self,
        name: str,
        label: str,
        *,
        expected_identity: tuple[int, int] | None = None,
    ) -> tuple[int, os.stat_result]:
        if (not isinstance(name, str) or not name or name in {".", ".."}
                or "/" in name or "\\" in name or "\x00" in name):
            raise SourceCompactionError(f"invalid {label} basename")
        self.verify_path_identity()
        descriptor: int | None = None
        handle: Any = None
        transferred = False
        try:
            if os.name == "posix":
                flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
                descriptor = os.open(name, flags, dir_fd=self.fd)
            elif os.name == "nt":
                _ctypes, _wintypes, kernel32, handle = _windows_open_handle(
                    self.path / name,
                    access=0x80000000 | 0x0080,  # GENERIC_READ | FILE_READ_ATTRIBUTES
                    share=0x0001 | 0x0002,  # deny delete/rename while this file is open
                    flags=0x00200000,  # OPEN_REPARSE_POINT
                    label=label,
                )
                identity, attributes = _windows_handle_info(
                    kernel32, handle, expected_snapshot=expected_identity
                )
                if attributes & (0x400 | 0x10):
                    raise SourceCompactionError(f"{label} is not a regular Windows file")
                import msvcrt

                descriptor = msvcrt.open_osfhandle(
                    int(handle), os.O_RDONLY | getattr(os, "O_BINARY", 0)
                )
                handle = None
            else:
                raise SourceCompactionError(
                    f"verified file opening is unsupported on platform {os.name!r}"
                )
            metadata = os.fstat(descriptor)
            if (not stat.S_ISREG(metadata.st_mode) or _is_reparse(metadata)
                    or (expected_identity is not None
                        and _identity(metadata) != expected_identity)):
                raise SourceCompactionError(f"{label} identity changed before opening")
            if os.name == "nt":
                native_handle = msvcrt.get_osfhandle(descriptor)
                confirmed_identity, confirmed_attributes = _windows_handle_info(
                    kernel32, native_handle, expected_native=identity
                )
                if (confirmed_identity != identity
                        or confirmed_attributes & (0x400 | 0x10)):
                    raise SourceCompactionError(
                        f"{label} native handle identity changed while opening"
                    )
            self.verify_path_identity()
            transferred = True
            return descriptor, metadata
        except FileNotFoundError:
            raise
        except SourceCompactionError:
            raise
        except OSError as error:
            raise SourceCompactionError(
                f"cannot open {label} relative to its owner"
            ) from error
        finally:
            if handle is not None:
                if not self._kernel32.CloseHandle(handle):
                    raise _windows_error(self._ctypes, f"CloseHandle for {label}")
            if descriptor is not None and not transferred:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def link_file(
        self,
        name: str,
        source_path: Path,
        expected_identity: tuple[int, int],
        label: str,
    ) -> None:
        self.verify_path_identity()
        source_metadata = _regular_file(source_path, label)
        if _identity(source_metadata) != expected_identity:
            raise SourceCompactionError(f"{label} identity changed before stage linking")
        try:
            if os.name == "posix":
                os.link(
                    source_path, name, dst_dir_fd=self.fd, follow_symlinks=False
                )
            elif os.name == "nt":
                # The owner handle denies parent rename; this basename remains
                # rooted in the pinned directory while CreateHardLinkW runs.
                os.link(source_path, self.path / name, follow_symlinks=False)
            else:
                raise SourceCompactionError(
                    f"verified stage linking is unsupported on platform {os.name!r}"
                )
        except FileExistsError as error:
            raise SourceCompactionError("private compaction stage was replaced before linking") from error
        except SourceCompactionError:
            raise
        except OSError as error:
            raise SourceCompactionError("cannot link verified CAS object into the owned stage") from error
        self.verify_path_identity()
        linked = self.stat_file(name, "linked private compaction stage")
        if _identity(linked) != expected_identity:
            raise SourceCompactionError("linked private stage identity differs from the verified CAS object")

    def _stat_directory(self, name: str, label: str) -> os.stat_result:
        if (not isinstance(name, str) or not name or name in {".", ".."}
                or "/" in name or "\\" in name or "\x00" in name):
            raise SourceCompactionError(f"invalid {label} basename")
        self.verify_handle_identity()
        try:
            if os.name == "posix":
                metadata = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            elif os.name == "nt":
                metadata = (self.path / name).lstat()
            else:
                raise SourceCompactionError(
                    f"verified directory inspection is unsupported on platform {os.name!r}"
                )
        except FileNotFoundError:
            raise
        except OSError as error:
            raise SourceCompactionError(
                f"cannot inspect {label} relative to its owner"
            ) from error
        if _is_reparse(metadata) or not stat.S_ISDIR(metadata.st_mode):
            raise SourceCompactionError(f"{label} is not a real directory")
        return metadata

    def _entry_exists(self, name: str) -> bool:
        if (not isinstance(name, str) or not name or name in {".", ".."}
                or "/" in name or "\\" in name or "\x00" in name):
            raise SourceCompactionError("invalid owner-relative entry basename")
        self.verify_handle_identity()
        try:
            if os.name == "posix":
                os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            elif os.name == "nt":
                os.lstat(self.path / name)
            else:
                raise SourceCompactionError(
                    f"verified entry inspection is unsupported on platform {os.name!r}"
                )
        except FileNotFoundError:
            return False
        except OSError as error:
            raise SourceCompactionError(
                "cannot inspect entry relative to its verified owner"
            ) from error
        return True

    def _create_private_quarantine(
        self,
    ) -> tuple[str, "_VerifiedDirectoryOwner", tuple[int, int]]:
        if os.name != "posix" or self.fd is None:
            raise SourceCompactionError(
                "descriptor-relative stage quarantine is unsupported on this host"
            )
        for _attempt in range(8):
            name = f".compact-quarantine-{uuid.uuid4().hex}"
            quarantine_path = self.path / name
            self.verify_path_identity()
            try:
                os.mkdir(name, 0o700, dir_fd=self.fd)
            except FileExistsError:
                continue
            except OSError as error:
                raise SourceCompactionError(
                    f"cannot create private stage quarantine relative to its owner: {quarantine_path}"
                ) from error

            quarantine_owner: _VerifiedDirectoryOwner | None = None
            try:
                metadata = self._stat_directory(name, "private stage quarantine")
                quarantine_identity = _identity(metadata)
                quarantine_owner = _VerifiedDirectoryOwner(
                    quarantine_path,
                    quarantine_identity,
                    "private stage quarantine",
                )
                quarantine_owner.__enter__()
                if quarantine_owner.device != self.device or quarantine_owner.fd is None:
                    raise SourceCompactionError(
                        "private stage quarantine is not on the stage filesystem"
                    )
                os.fchmod(quarantine_owner.fd, 0o700)
                quarantine_owner.verify_path_identity()
                if stat.S_IMODE(os.fstat(quarantine_owner.fd).st_mode) != 0o700:
                    raise SourceCompactionError(
                        "private stage quarantine could not be bound with mode 0700"
                    )
                self.verify_path_identity()
                return name, quarantine_owner, quarantine_identity
            except Exception as error:
                if quarantine_owner is not None:
                    try:
                        quarantine_owner.close()
                    except Exception:
                        pass
                raise SourceCompactionError(
                    f"cannot bind private stage quarantine; preserving it at {quarantine_path}: {error}"
                ) from error
        raise SourceCompactionError(
            "cannot allocate a unique private stage quarantine name"
        )

    def _remove_private_quarantine(
        self,
        name: str,
        expected_identity: tuple[int, int],
        quarantine_owner: "_VerifiedDirectoryOwner",
    ) -> None:
        quarantine_owner.verify_path_identity()
        if quarantine_owner.list_files():
            raise SourceCompactionError(
                f"private stage quarantine is not empty; preserving it at {quarantine_owner.path}"
            )
        quarantine_metadata = self._stat_directory(
            name, "private stage quarantine"
        )
        if (
            _identity(quarantine_metadata) != expected_identity
            or stat.S_IMODE(quarantine_metadata.st_mode) != 0o700
        ):
            raise SourceCompactionError(
                f"private stage quarantine identity or mode changed; preserving it at {quarantine_owner.path}"
            )
        quarantine_owner.close()
        self.verify_path_identity()
        try:
            os.rmdir(name, dir_fd=self.fd)
        except OSError as error:
            raise SourceCompactionError(
                f"cannot remove empty private stage quarantine {quarantine_owner.path}"
            ) from error
        self.verify_path_identity()
        if self._entry_exists(name):
            raise SourceCompactionError(
                f"private stage quarantine name was replaced after removal: {quarantine_owner.path}"
            )

    def _unlink_file_in_private_owner(
        self,
        name: str,
        expected_identity: tuple[int, int],
        *,
        expected_nlink: int,
    ) -> None:
        if os.name != "posix":
            raise SourceCompactionError(
                "private owner-relative unlink is unsupported on this host"
            )
        self.verify_path_identity()
        metadata = self.stat_file(name, "quarantined compaction stage")
        if (
            _identity(metadata) != expected_identity
            or metadata.st_nlink != expected_nlink
        ):
            raise SourceCompactionError(
                f"quarantined stage identity or link count changed; preserving it at {self.path / name}"
            )
        os.unlink(name, dir_fd=self.fd)

    def unlink_file(
        self,
        name: str,
        expected_identity: tuple[int, int],
        *,
        expected_nlink: int | None = None,
        post_move_check: Callable[
            ["_VerifiedDirectoryOwner", str, os.stat_result], None
        ] | None = None,
    ) -> None:
        self.verify_path_identity()
        metadata = self.stat_file(name, "compaction stage file")
        if _identity(metadata) != expected_identity:
            raise SourceCompactionError("compaction stage identity changed; leaving it untouched")
        if expected_nlink is not None and metadata.st_nlink != expected_nlink:
            raise SourceCompactionError("compaction stage link count changed; leaving it untouched")

        if os.name == "posix":
            if self.fd is None:
                raise SourceCompactionError("verified stage-parent descriptor is not open")
            before_nlink = metadata.st_nlink
            quarantine_name, quarantine_owner, quarantine_identity = (
                self._create_private_quarantine()
            )
            quarantine_entry = quarantine_owner.path / name
            moved = False
            removed = False
            try:
                self.verify_path_identity()
                quarantine_owner.verify_path_identity()
                os.rename(
                    name,
                    name,
                    src_dir_fd=self.fd,
                    dst_dir_fd=quarantine_owner.fd,
                )
                moved = True
                self.verify_path_identity()
                quarantine_owner.verify_path_identity()
                moved_metadata = quarantine_owner.stat_file(
                    name, "quarantined compaction stage"
                )
                if (
                    _identity(moved_metadata) != expected_identity
                    or moved_metadata.st_nlink != before_nlink
                    or (
                        expected_nlink is not None
                        and moved_metadata.st_nlink != expected_nlink
                    )
                ):
                    raise SourceCompactionError(
                        "stage basename changed before quarantine binding; "
                        f"preserving unexpected inode at {quarantine_entry}"
                    )
                if post_move_check is not None:
                    post_move_check(quarantine_owner, name, moved_metadata)
                if self._entry_exists(name):
                    raise SourceCompactionError(
                        "public stage basename was replaced during quarantine; "
                        f"preserving it and {quarantine_entry}"
                    )
                quarantine_owner._unlink_file_in_private_owner(
                    name,
                    expected_identity,
                    expected_nlink=before_nlink,
                )
                removed = True
                quarantine_owner.verify_path_identity()
                if self._entry_exists(name):
                    raise SourceCompactionError(
                        "public stage basename reappeared during quarantine cleanup; "
                        f"preserving it and {quarantine_owner.path}"
                    )
                self._remove_private_quarantine(
                    quarantine_name, quarantine_identity, quarantine_owner
                )
                quarantine_owner = None
            except Exception as error:
                if quarantine_owner is not None:
                    if not moved:
                        try:
                            moved = quarantine_owner._entry_exists(name)
                        except Exception:
                            pass
                    if not moved:
                        try:
                            if quarantine_owner.list_files():
                                quarantine_owner.close()
                            else:
                                self._remove_private_quarantine(
                                    quarantine_name,
                                    quarantine_identity,
                                    quarantine_owner,
                                )
                        except Exception:
                            try:
                                quarantine_owner.close()
                            except Exception:
                                pass
                    else:
                        try:
                            quarantine_owner.close()
                        except Exception:
                            pass
                if moved and not removed:
                    raise SourceCompactionError(
                        f"{error}; preserving stage quarantine entry at {quarantine_entry}"
                    ) from error
                if moved and removed:
                    raise SourceCompactionError(
                        f"{error}; stage quarantine cleanup is incomplete at "
                        f"{self.path / quarantine_name}"
                    ) from error
                raise
            return

        if os.name == "nt":
            if post_move_check is not None:
                raise SourceCompactionError(
                    "Windows handle deletion does not accept POSIX quarantine callbacks"
                )
            ctypes_module, _wintypes, kernel32, handle = _windows_open_handle(
                self.path / name,
                access=0x00010000 | 0x0080,  # DELETE | FILE_READ_ATTRIBUTES
                share=0x0001 | 0x0002,  # deny delete/rename while this file is open
                flags=0x00200000,  # OPEN_REPARSE_POINT
                label="compaction stage deletion",
            )
            try:
                identity, attributes = _windows_handle_info(
                    kernel32, handle, expected_snapshot=expected_identity
                )
                if attributes & (0x400 | 0x10):
                    raise SourceCompactionError(
                        "compaction stage identity changed before handle-bound deletion"
                    )
                confirmed_identity, confirmed_attributes = _windows_handle_info(
                    kernel32, handle, expected_native=identity
                )
                if (confirmed_identity != identity
                        or confirmed_attributes & (0x400 | 0x10)):
                    raise SourceCompactionError(
                        "compaction stage native identity changed before handle-bound deletion"
                    )

                class FileDispositionInfo(ctypes_module.Structure):
                    _fields_ = [("delete_file", _wintypes.BOOL)]

                disposition = FileDispositionInfo(1)
                if not kernel32.SetFileInformationByHandle(
                    handle, 4, ctypes_module.byref(disposition),
                    ctypes_module.sizeof(disposition),
                ):
                    raise _windows_error(
                        ctypes_module, "SetFileInformationByHandle(FileDispositionInfo)"
                    )
            finally:
                if not kernel32.CloseHandle(handle):
                    raise _windows_error(ctypes_module, "CloseHandle for compaction stage deletion")
        else:
            raise SourceCompactionError(
                f"verified stage deletion is unsupported on platform {os.name!r}"
            )
        self.verify_path_identity()
        if os.path.lexists(self.path / name):
            raise SourceCompactionError("compaction stage remains after owner-bound deletion")

    def chmod_file(self, name: str, mode: int, expected_identity: tuple[int, int]) -> None:
        if os.name == "nt":
            _windows_set_readonly(self, name, expected_identity, not bool(mode & 0o222))
            return
        flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        try:
            descriptor = os.open(name, flags, dir_fd=self.fd)
        except OSError as error:
            raise SourceCompactionError("cannot open source file relative to its parent owner") from error
        try:
            metadata = os.fstat(descriptor)
            if (not stat.S_ISREG(metadata.st_mode) or _is_reparse(metadata)
                    or _identity(metadata) != expected_identity):
                raise SourceCompactionError("source file identity changed before permission update")
            os.fchmod(descriptor, mode)
            after = os.fstat(descriptor)
            if _identity(after) != expected_identity or stat.S_IMODE(after.st_mode) != mode:
                raise SourceCompactionError("source file identity changed during permission update")
        finally:
            os.close(descriptor)

    def chmod_directory(self, mode: int) -> None:
        if os.name != "posix" or self.fd is None:
            raise SourceCompactionError("descriptor-relative directory chmod is unavailable")
        self.verify_handle_identity()
        os.fchmod(self.fd, mode)
        if stat.S_IMODE(os.fstat(self.fd).st_mode) != mode:
            raise SourceCompactionError("source parent permissions did not restore through its owner")

    def rename_file_from(
        self,
        source_owner: "_VerifiedDirectoryOwner",
        source_name: str,
        destination_name: str,
    ) -> None:
        self.verify_path_identity()
        source_owner.verify_path_identity()
        source_owner.stat_file(source_name, "private compaction stage")
        if os.name == "nt":
            os.replace(source_owner.path / source_name, self.path / destination_name)
        else:
            os.rename(source_name, destination_name,
                      src_dir_fd=source_owner.fd, dst_dir_fd=self.fd)

    def fsync(self) -> None:
        self.verify_handle_identity()
        if os.name == "posix":
            try:
                os.fsync(self.fd)
            except OSError as error:
                raise SourceCompactionError("cannot sync source parent through its verified owner") from error

    def close(self) -> None:
        if self.fd is not None:
            descriptor, self.fd = self.fd, None
            os.close(descriptor)
        if self.handle is not None:
            handle, self.handle = self.handle, None
            if not self._kernel32.CloseHandle(handle):
                raise _windows_error(self._ctypes, f"CloseHandle for {self.label}")

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> bool:
        self.close()
        return False


def _windows_set_readonly(
    owner: _VerifiedDirectoryOwner,
    name: str,
    expected_identity: tuple[int, int],
    readonly: bool,
) -> None:
    owner.verify_path_identity()
    ctypes_module, wintypes, kernel32, handle = _windows_open_handle(
        owner.path / name,
        access=0x0080 | 0x0100,  # FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES
        share=0x0001 | 0x0002 | 0x0004,  # allow the verified parent to replace this file
        flags=0x00200000,  # OPEN_REPARSE_POINT
        label="source file permission update",
    )
    try:
        identity, attributes = _windows_handle_info(
            kernel32, handle, expected_snapshot=expected_identity
        )
        if attributes & (0x400 | 0x10):
            raise SourceCompactionError("source file identity changed before Windows permission update")
        currently_readonly = bool(attributes & _READONLY_ATTRIBUTE)
        if currently_readonly == readonly:
            return
        new_attributes = attributes & ~0x80  # FILE_ATTRIBUTE_NORMAL is exclusive
        if readonly:
            new_attributes |= _READONLY_ATTRIBUTE
        else:
            new_attributes &= ~_READONLY_ATTRIBUTE
        if new_attributes == 0:
            new_attributes = 0x80  # FILE_ATTRIBUTE_NORMAL

        class FileBasicInfo(ctypes_module.Structure):
            _fields_ = [
                ("creation_time", ctypes_module.c_longlong),
                ("last_access_time", ctypes_module.c_longlong),
                ("last_write_time", ctypes_module.c_longlong),
                ("change_time", ctypes_module.c_longlong),
                ("attributes", wintypes.DWORD),
            ]

        basic = FileBasicInfo(0, 0, 0, 0, new_attributes)
        if not kernel32.SetFileInformationByHandle(
                handle, 0, ctypes_module.byref(basic), ctypes_module.sizeof(basic)):
            raise _windows_error(ctypes_module, "SetFileInformationByHandle(FileBasicInfo)")
        after_identity, after_attributes = _windows_handle_info(
            kernel32, handle, expected_native=identity
        )
        if (after_identity != identity
                or bool(after_attributes & _READONLY_ATTRIBUTE) != readonly):
            raise SourceCompactionError("Windows source permission update did not preserve file identity")
    finally:
        if not kernel32.CloseHandle(handle):
            raise _windows_error(ctypes_module, "CloseHandle for source file permission update")


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
    *,
    parent_owner: _VerifiedDirectoryOwner | None = None,
    source_name: str | None = None,
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
    if parent_owner is not None:
        if source_name is None:
            raise SourceCompactionError("owner-relative CAS verification requires a source basename")
        source_metadata = parent_owner.stat_file(source_name, "capsule source file")
    else:
        source_metadata = _regular_file(source_file, "capsule source file")
    object_metadata = _regular_file(object_path, "source content object")
    same_object = (
        _identity(source_metadata) == _identity(object_metadata)
        if parent_owner is not None
        else _same_file(source_file, object_path)
    )
    if not same_object:
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
        original = int(item["mode"])
        with _VerifiedDirectoryOwner(
            path, tuple(item["identity"]), "capsule source directory"
        ) as owner:
            current = stat.S_IMODE(os.fstat(owner.fd).st_mode)
            if current == (original | stat.S_IWUSR):
                owner.chmod_directory(original)
                owner.verify_path_identity()
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


def _unlink_owned_cas_stage(
    stage_owner: _VerifiedDirectoryOwner,
    stage_name: str,
    store: SourceContentStore,
    entry: dict[str, Any],
    expected_identity: tuple[int, int],
) -> bool:
    object_path = store._object_path(entry["sha256"], entry["mode"])
    _guard_components(object_path, "source content object", allow_missing=True)
    if not os.path.lexists(object_path):
        return False

    with store._publication_lock(object_path):
        stage_owner.verify_path_identity()
        object_metadata = store._verify_object(
            object_path,
            digest=entry["sha256"],
            mode=entry["mode"],
            size=entry["size"],
        )
        try:
            stage_metadata = stage_owner.stat_file(
                stage_name, "compaction stage hard link"
            )
        except FileNotFoundError:
            return False
        if _identity(stage_metadata) != _identity(object_metadata):
            return False
        if _identity(stage_metadata) != expected_identity:
            raise SourceCompactionError(
                "compaction stage changed while proving its CAS hard link"
            )
        if stage_metadata.st_nlink < 2:
            raise SourceCompactionError(
                "compaction stage CAS link count is inconsistent; leaving it untouched"
            )

        if os.name == "nt":
            # Read-only attributes belong to the shared inode. Clear them only
            # after the owner-relative stage identity and CAS seal both match.
            try:
                object_path.chmod(0o666)
                stage_owner.unlink_file(stage_name, expected_identity)
            finally:
                if os.path.lexists(object_path):
                    object_path.chmod(
                        0o555 if entry["mode"] == "100755" else 0o444
                    )
        else:
            def verify_quarantined_cas_link(
                quarantine_owner: _VerifiedDirectoryOwner,
                quarantine_name: str,
                moved_metadata: os.stat_result,
            ) -> None:
                if (
                    _identity(moved_metadata) != expected_identity
                    or moved_metadata.st_nlink < 2
                    or not _readonly_seal(moved_metadata, entry["mode"])
                ):
                    raise SourceCompactionError(
                        "quarantined CAS stage identity, links, or seal changed; "
                        f"preserving it at {quarantine_owner.path / quarantine_name}"
                    )
                rebound_object = store._verify_object(
                    object_path,
                    digest=entry["sha256"],
                    mode=entry["mode"],
                    size=entry["size"],
                )
                if _identity(rebound_object) != expected_identity:
                    raise SourceCompactionError(
                        "CAS object identity changed after stage quarantine binding"
                    )

            stage_owner.unlink_file(
                stage_name,
                expected_identity,
                post_move_check=(
                    verify_quarantined_cas_link if os.name == "posix" else None
                ),
            )

        store._verify_object(
            object_path,
            digest=entry["sha256"],
            mode=entry["mode"],
            size=entry["size"],
        )
        stage_owner.verify_path_identity()
        return True


def _cleanup_stage(
    stage_path: Path,
    *,
    stage_owner: _VerifiedDirectoryOwner,
    store: SourceContentStore,
    entry: dict[str, Any],
    private_identity: tuple[int, int] | None = None,
) -> None:
    if stage_owner.path != stage_path.parent:
        raise SourceCompactionError(
            "compaction stage cleanup received a different stage-parent owner"
        )
    try:
        stage_owner.verify_path_identity()
    except SourceCompactionError as error:
        raise SourceCompactionError(
            f"compaction stage parent identity changed; preserving stage: {stage_path.name}"
        ) from error
    try:
        metadata = stage_owner.stat_file(stage_path.name, "compaction stage file")
    except FileNotFoundError:
        return

    object_path = store._object_path(entry["sha256"], entry["mode"])
    _guard_components(object_path, "source content object", allow_missing=True)
    if os.path.lexists(object_path):
        object_metadata = store._verify_object(
            object_path,
            digest=entry["sha256"],
            mode=entry["mode"],
            size=entry["size"],
        )
        if _identity(metadata) == _identity(object_metadata):
            _unlink_owned_cas_stage(
                stage_owner,
                stage_path.name,
                store,
                entry,
                _identity(metadata),
            )
            return

    if private_identity is None:
        raise SourceCompactionError(
            "unowned private compaction stage remains; preserving it for restart reconciliation"
        )
    if _identity(metadata) != private_identity:
        raise SourceCompactionError(
            "compaction stage identity changed; leaving it untouched"
        )
    if metadata.st_nlink != 1:
        raise SourceCompactionError(
            "unrecognized or externally linked compaction stage; leaving it untouched"
        )
    stage_owner.unlink_file(
        stage_path.name, private_identity, expected_nlink=1
    )


def _sweep_stages(
    stage_root: Path,
    entries_by_stage: dict[str, dict[str, Any]],
    store: SourceContentStore,
    *,
    stage_owner: _VerifiedDirectoryOwner,
) -> None:
    if stage_owner.path != stage_root:
        raise SourceCompactionError(
            "stage sweep received a different stage-parent owner"
        )
    stage_owner.verify_path_identity()
    for name in stage_owner.list_files():
        entry = entries_by_stage.get(name)
        if entry is None:
            if name.startswith(".compact-quarantine-"):
                raise SourceCompactionError(
                    "unreconciled stage quarantine remains; preserving it at "
                    f"{stage_root / name}"
                )
            raise SourceCompactionError(
                f"unrecognized file in compaction stage directory: {name}"
            )
        _cleanup_stage(
            stage_root / name,
            stage_owner=stage_owner,
            store=store,
            entry=entry,
        )


def _copy_private_stage(
    source_file: Path,
    stage_path: Path,
    entry: dict[str, Any],
    *,
    source_owner: _VerifiedDirectoryOwner,
    stage_owner: _VerifiedDirectoryOwner,
    source_name: str,
    store: SourceContentStore,
) -> tuple[int, int]:
    before = source_owner.stat_file(source_name, "capsule source file")
    if before.st_nlink != 1:
        raise SourceCompactionError(
            "capsule file acquired an external hard link during compaction"
        )

    digest = hashlib.sha256()
    size = 0
    stage_descriptor: int | None = None
    source_descriptor: int | None = None
    stage_identity: tuple[int, int] | None = None
    try:
        stage_descriptor, stage_identity = stage_owner.create_file(
            stage_path.name, 0o600
        )
        source_descriptor, opened = source_owner.open_file(
            source_name,
            "capsule source file",
            expected_identity=_identity(before),
        )
        if _identity(opened) != _identity(before):
            raise SourceCompactionError(
                "capsule file changed while opening its private stage"
            )

        with os.fdopen(stage_descriptor, "wb") as destination:
            stage_descriptor = None
            with os.fdopen(source_descriptor, "rb") as source:
                source_descriptor = None
                opened = os.fstat(source.fileno())
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

        after = source_owner.stat_file(source_name, "capsule source file")
        stage_owner.verify_path_identity()
        stage_metadata = stage_owner.stat_file(
            stage_path.name, "private compaction stage"
        )
        if (
            _identity(before) != _identity(after)
            or _identity(after_open) != _identity(after)
            or before.st_size != after.st_size
            or size != entry["size"]
            or stage_metadata.st_size != size
            or digest.hexdigest() != entry["sha256"]
            or _identity(stage_metadata) != stage_identity
            or stage_metadata.st_nlink != 1
            or (
                os.name != "nt"
                and bool(before.st_mode & stat.S_IXUSR)
                != (entry["mode"] == "100755")
            )
        ):
            raise SourceCompactionError(
                "private compaction stage does not match the verified capsule file"
            )
        stage_owner.chmod_file(
            stage_path.name,
            0o755 if entry["mode"] == "100755" else 0o644,
            stage_identity,
        )
        return stage_identity
    except Exception as error:
        if stage_descriptor is not None:
            os.close(stage_descriptor)
            stage_descriptor = None
        if source_descriptor is not None:
            os.close(source_descriptor)
            source_descriptor = None
        if stage_identity is not None:
            try:
                _cleanup_stage(
                    stage_path,
                    stage_owner=stage_owner,
                    store=store,
                    entry=entry,
                    private_identity=stage_identity,
                )
            except Exception as cleanup_error:
                raise SourceCompactionError(
                    f"{error}; private stage cleanup failed safely: {cleanup_error}"
                ) from error
        if isinstance(error, SourceCompactionError):
            raise
        if isinstance(error, OSError):
            raise SourceCompactionError(
                f"cannot stage capsule file privately: {source_file}"
            ) from error
        raise
    finally:
        if stage_descriptor is not None:
            os.close(stage_descriptor)
        if source_descriptor is not None:
            os.close(source_descriptor)


def _link_private_stage_to_cas(
    stage_path: Path,
    *,
    source_file: Path,
    source_owner: _VerifiedDirectoryOwner,
    source_name: str,
    source_identity: tuple[int, int],
    stage_owner: _VerifiedDirectoryOwner,
    store: SourceContentStore,
    entry: dict[str, Any],
    private_identity: tuple[int, int],
) -> tuple[int, int]:
    stage_owner.verify_path_identity()
    stage_metadata = stage_owner.stat_file(
        stage_path.name, "private compaction stage"
    )
    if _identity(stage_metadata) != private_identity or stage_metadata.st_nlink != 1:
        raise SourceCompactionError(
            "private stage identity or link count changed before CAS publication"
        )

    source_owner.verify_path_identity()
    source_metadata = source_owner.stat_file(source_name, "capsule source file")
    if _identity(source_metadata) != source_identity or source_metadata.st_nlink != 1:
        raise SourceCompactionError(
            "capsule source identity or link count changed before CAS publication"
        )

    # The private stage was copied and hashed through its owner-relative file
    # handle. The store consumes the source path only as read-only input and
    # verifies its manifest digest before publishing the CAS object.
    object_path = store._ensure_object(
        source_file,
        digest=entry["sha256"],
        mode=entry["mode"],
        size=entry["size"],
    )
    object_metadata = store._verify_object(
        object_path,
        digest=entry["sha256"],
        mode=entry["mode"],
        size=entry["size"],
    )
    if object_metadata.st_dev != stage_owner.device:
        raise SourceCompactionError(
            "source content store and capsule stage are not on the same filesystem"
        )

    source_owner.verify_path_identity()
    source_metadata = source_owner.stat_file(source_name, "capsule source file")
    if _identity(source_metadata) != source_identity or source_metadata.st_nlink != 1:
        raise SourceCompactionError(
            "capsule source identity or link count changed during CAS publication"
        )
    stage_owner.verify_path_identity()
    stage_metadata = stage_owner.stat_file(
        stage_path.name, "private compaction stage"
    )
    if _identity(stage_metadata) != private_identity or stage_metadata.st_nlink != 1:
        raise SourceCompactionError(
            "private stage identity changed during CAS object publication"
        )

    stage_owner.unlink_file(
        stage_path.name, private_identity, expected_nlink=1
    )
    stage_owner.link_file(
        stage_path.name,
        object_path,
        _identity(object_metadata),
        "content object",
    )
    stage_metadata = stage_owner.stat_file(
        stage_path.name, "linked private compaction stage"
    )
    if (
        _identity(stage_metadata) != _identity(object_metadata)
        or not _readonly_seal(object_metadata, entry["mode"])
    ):
        raise SourceCompactionError(
            "private stage was not linked to the verified sealed CAS object"
        )
    return _identity(stage_metadata)


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
    stage_owner: _VerifiedDirectoryOwner,
    store: SourceContentStore,
    directory_records: dict[str, dict[str, Any]],
) -> str:
    # The source-relative parent is carried by the manifest path, not the host path.
    parent_relative = PurePosixPath(entry["path"]).parent.as_posix()
    directory_item = directory_records.get(parent_relative)
    if directory_item is None:
        raise SourceCompactionError("source parent is absent from the directory receipt")
    parent = source_file.parent
    parent_metadata = parent.stat(follow_symlinks=False)
    if _identity(parent_metadata) != tuple(directory_item["identity"]):
        raise SourceCompactionError("source parent directory identity changed")
    parent_identity = tuple(directory_item["identity"])
    source_name = source_file.name
    with _VerifiedDirectoryOwner(parent, parent_identity, "source parent") as parent_owner:
        source_metadata = parent_owner.stat_file(source_name, "capsule source file")
        if _cas_linked(
            source_file, store, entry, parent_owner=parent_owner, source_name=source_name
        ):
            parent_owner.verify_path_identity()
            _fsync_source_parent(parent, owner=parent_owner)
            return "skipped"
        if source_metadata.st_nlink != 1:
            return "protected"
        if stage_owner.path != stage_path.parent:
            raise SourceCompactionError(
                "compaction received a different stage-parent owner"
            )
        stage_owner.verify_path_identity()
        if stage_owner.device != parent_owner.device:
            raise SourceCompactionError(
                "compaction stage and source parent are on different filesystems"
            )

        original_mode = stat.S_IMODE(source_metadata.st_mode)
        was_readonly = _read_only(source_metadata)
        original_identity = _identity(source_metadata)
        stage_owned = False
        stage_identity: tuple[int, int] | None = None
        source_entry_changed = False
        original_directory_mode: int | None = None
        try:
            stage_identity = _copy_private_stage(
                source_file,
                stage_path,
                entry,
                source_owner=parent_owner,
                stage_owner=stage_owner,
                source_name=source_name,
                store=store,
            )
            stage_owned = True
            stage_identity = _link_private_stage_to_cas(
                stage_path,
                source_file=source_file,
                source_owner=parent_owner,
                source_name=source_name,
                source_identity=original_identity,
                stage_owner=stage_owner,
                store=store,
                entry=entry,
                private_identity=stage_identity,
            )
            if not _cas_linked(
                stage_path,
                store,
                entry,
                parent_owner=stage_owner,
                source_name=stage_path.name,
            ):
                raise SourceCompactionError(
                    "private stage was not linked to the verified CAS object"
                )

            if os.name == "posix":
                original_directory_mode = int(directory_item["mode"])
                current_directory_mode = stat.S_IMODE(os.fstat(parent_owner.fd).st_mode)
                if current_directory_mode == original_directory_mode:
                    parent_owner.chmod_directory(original_directory_mode | stat.S_IWUSR)
                elif current_directory_mode != (
                    original_directory_mode | stat.S_IWUSR
                ):
                    raise SourceCompactionError(
                        "source parent directory permissions changed unexpectedly"
                    )

            parent_owner.verify_path_identity()
            current = parent_owner.stat_file(source_name, "capsule source file")
            if _identity(current) != original_identity or current.st_nlink != 1:
                raise SourceCompactionError(
                    "capsule file identity or link count changed before replacement"
                )
            if os.name == "nt" and was_readonly:
                parent_owner.chmod_file(
                    source_name, original_mode | 0o222, original_identity
                )
                current = parent_owner.stat_file(source_name, "capsule source file")
                if _identity(current) != original_identity:
                    raise SourceCompactionError(
                        "capsule file identity changed while clearing read-only state"
                    )

            parent_owner.verify_path_identity()
            stage_metadata = stage_owner.stat_file(
                stage_path.name, "private compaction stage"
            )
            if _identity(stage_metadata) != stage_identity:
                raise SourceCompactionError(
                    "private compaction stage identity changed"
                )
            try:
                parent_owner.rename_file_from(
                    stage_owner, stage_path.name, source_name
                )
                source_entry_changed = True
            except OSError:
                if not _cas_linked(
                    source_file,
                    store,
                    entry,
                    parent_owner=parent_owner,
                    source_name=source_name,
                ):
                    raise
                source_entry_changed = True

            stage_owner.verify_path_identity()
            parent_owner.verify_path_identity()
            if not _cas_linked(
                source_file,
                store,
                entry,
                parent_owner=parent_owner,
                source_name=source_name,
            ):
                raise SourceCompactionError(
                    "atomic replacement did not install the verified CAS hard link"
                )
            parent_owner.verify_path_identity()
            return "converted"
        except Exception as error:
            cleanup_error: Exception | None = None
            try:
                current = parent_owner.stat_file(
                    source_name, "capsule source file"
                )
                if _identity(current) == original_identity:
                    if os.name == "nt" and was_readonly and not _read_only(current):
                        parent_owner.chmod_file(
                            source_name, original_mode, original_identity
                        )
                    if stage_owned:
                        _cleanup_stage(
                            stage_path,
                            stage_owner=stage_owner,
                            store=store,
                            entry=entry,
                            private_identity=stage_identity,
                        )
            except Exception as failure:
                cleanup_error = failure
            if cleanup_error is not None:
                raise SourceCompactionError(
                    f"{error}; safe compaction cleanup failed: {cleanup_error}"
                ) from error
            raise
        finally:
            try:
                if os.name == "posix" and original_directory_mode is not None:
                    current_mode = stat.S_IMODE(os.fstat(parent_owner.fd).st_mode)
                    if current_mode == (
                        original_directory_mode | stat.S_IWUSR
                    ):
                        parent_owner.chmod_directory(original_directory_mode)
                    elif current_mode != original_directory_mode:
                        raise SourceCompactionError(
                            "source parent directory permissions changed unexpectedly"
                        )
            finally:
                if source_entry_changed:
                    _fsync_source_parent(parent, owner=parent_owner)


def _compact_source_capsule_owned(
    *,
    manifest: dict[str, Any],
    manifest_bytes: bytes,
    expected_digest: str,
    source: Path,
    receipt_path: Path,
    tree: Path,
    directory_records: dict[str, dict[str, Any]],
    receipt: dict[str, Any],
    store: SourceContentStore,
    stage_root: Path,
    stage_owner: _VerifiedDirectoryOwner,
) -> dict[str, object]:
    entries = [entry for entry in manifest["files"] if entry.get("type") == "file"]
    entries_by_stage = {_stage_name(entry): entry for entry in entries}
    try:
        _sweep_stages(
            stage_root, entries_by_stage, store, stage_owner=stage_owner
        )
    except Exception as error:
        receipt["state"] = "partial_failure"
        receipt["last_error"] = str(error)[:2000]
        _counts_for_invocation(receipt)
        try:
            _write_receipt(receipt_path, receipt)
        except Exception as receipt_error:
            raise SourceCompactionError(
                f"stage reconciliation failed: {error}; receipt update failed: {receipt_error}"
            ) from error
        if isinstance(error, SourceCompactionError):
            raise
        raise SourceCompactionError(
            f"stage reconciliation failed: {error}"
        ) from error

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
                stage_owner=stage_owner,
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
                _sweep_stages(
                    stage_root,
                    entries_by_stage,
                    store,
                    stage_owner=stage_owner,
                )
                _write_receipt(receipt_path, receipt)

        _restore_directories(tree, directory_records)
        _sweep_stages(
            stage_root, entries_by_stage, store, stage_owner=stage_owner
        )
        final_manifest = verify_source(source, expected_digest)
        final_manifest_bytes = (source / "manifest.json").read_bytes()
        if (
            final_manifest["source_digest"] != expected_digest
            or final_manifest_bytes != manifest_bytes
        ):
            raise SourceCompactionError(
                "source capsule identity changed during compaction"
            )
    except Exception as error:
        try:
            _restore_directories(tree, directory_records)
        except Exception as restore_error:
            error = SourceCompactionError(
                f"{error}; directory restore failed: {restore_error}"
            )
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
                "source compaction failed and capsule verification after failure "
                f"failed: {verify_error}"
            ) from error
        if isinstance(error, SourceCompactionError):
            raise error
        if isinstance(
            error,
            (OSError, ValueError, KeyError, TypeError, SourceContentStoreError),
        ):
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


def _compact_source_capsule(
    storage_root: Path | str,
    capsule_path: Path | str,
    expected_digest: str,
) -> dict[str, object]:
    """Compact one exact historical source capsule into the canonical CAS.

    The receipt is atomically checkpointed every 128 manifest files and on
    completion/failure. A private stage has a deterministic per-content name.
    Restart removes a stage only when its CAS link can be proved; an unknown
    private inode is preserved and reported for reconciliation. Returned bytes
    are logical bytes represented by CAS links; no physical-reclaim estimate
    is made.
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
    stage_root_metadata = _real_directory(
        stage_root, "compaction stage parent"
    ).stat(follow_symlinks=False)
    with _VerifiedDirectoryOwner(
        stage_root, _identity(stage_root_metadata), "compaction stage parent"
    ) as stage_owner:
        return _compact_source_capsule_owned(
            manifest=manifest,
            manifest_bytes=manifest_bytes,
            expected_digest=expected_digest,
            source=source,
            receipt_path=receipt_path,
            tree=tree,
            directory_records=directory_records,
            receipt=receipt,
            store=store,
            stage_root=stage_root,
            stage_owner=stage_owner,
        )


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
