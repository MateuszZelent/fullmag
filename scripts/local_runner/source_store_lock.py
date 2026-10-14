"""Crash-aware private publication locks for the source content store.

The canonical lock is an atomically published, complete owner record. Its
exclusive path is the cross-OS admission gate. Stale recovery is narrower: it
uses a persistent OS-local gate and only removes a record whose exact owner is
provably dead in the current kernel boot and PID/process namespace.
"""

from __future__ import annotations

from contextlib import contextmanager
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import select
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from typing import Iterator, Mapping

if os.name != "nt":
    import fcntl


_OWNER_SCHEMA = "fullmag.source-content-lock.v2"
_MAX_OWNER_BYTES = 16 * 1024
_OWNER_TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_WAIT_SLICE_SECONDS = 0.025
_WINDOWS_BOOT_QUERY_TIMEOUT_SECONDS = 5.0
_RECOVERY_DIRECTORY = ".recovery"
_WINDOWS_NATIVE_PID_NAMESPACE = "windows-native-host-process-space"
_PROCESS_FORK_EPOCH = object()
_FORK_STATE_LOCK = threading.Lock()
_ACTIVE_PUBLICATION_OPERATIONS = 0
_FORK_UNSAFE_AFTER_ACTIVE_OPERATION = False


class SourceStoreLockError(ValueError):
    """A source content publication lock could not be trusted or acquired."""


def _begin_publication_operation() -> object:
    global _ACTIVE_PUBLICATION_OPERATIONS
    with _FORK_STATE_LOCK:
        ensure_publication_process_is_safe()
        _ACTIVE_PUBLICATION_OPERATIONS += 1
        return _PROCESS_FORK_EPOCH


def _end_publication_operation(process_epoch: object) -> None:
    global _ACTIVE_PUBLICATION_OPERATIONS
    with _FORK_STATE_LOCK:
        if process_epoch is not _PROCESS_FORK_EPOCH:
            return
        if _ACTIVE_PUBLICATION_OPERATIONS <= 0:
            raise SourceStoreLockError("source publication operation accounting underflow")
        _ACTIVE_PUBLICATION_OPERATIONS -= 1


def _check_publication_epoch(process_epoch: object) -> None:
    if process_epoch is not _PROCESS_FORK_EPOCH:
        raise SourceStoreLockError(
            "source publication was interrupted by fork during an active lock operation"
        )


def ensure_publication_process_is_safe() -> None:
    if _FORK_UNSAFE_AFTER_ACTIVE_OPERATION:
        raise SourceStoreLockError(
            "source publication is disabled in a process forked during an active lock operation"
        )


def publication_process_is_safe() -> bool:
    return not _FORK_UNSAFE_AFTER_ACTIVE_OPERATION


class _OwnerRecordError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _canonical_json(value: Mapping[str, object]) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


def _same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def _is_reparse(metadata: os.stat_result) -> bool:
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & 0x400
    )


def _guard_components(path: Path, *, allow_missing: bool) -> None:
    absolute = Path(os.path.abspath(path))
    anchor = Path(absolute.anchor)
    current = anchor
    for part in absolute.parts[len(anchor.parts) :]:
        current = current / part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            if allow_missing:
                break
            raise SourceStoreLockError(f"lock path component is missing: {current}")
        except OSError as error:
            raise SourceStoreLockError(
                f"cannot inspect lock path component: {current}"
            ) from error
        if _is_reparse(metadata):
            raise SourceStoreLockError(
                f"lock path traverses a symlink or reparse point: {current}"
            )


def _real_directory(path: Path, *, create: bool) -> Path:
    _guard_components(path, allow_missing=create)
    try:
        if create:
            path.mkdir(parents=True, exist_ok=True)
        metadata = path.lstat()
    except OSError as error:
        raise SourceStoreLockError(f"cannot prepare lock directory: {path}") from error
    if _is_reparse(metadata) or not stat.S_ISDIR(metadata.st_mode):
        raise SourceStoreLockError(f"lock directory is not a real directory: {path}")
    _guard_components(path, allow_missing=False)
    return path


def _regular_path_metadata(path: Path, *, allow_missing: bool) -> os.stat_result | None:
    _guard_components(path, allow_missing=allow_missing)
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        if allow_missing:
            return None
        raise SourceStoreLockError(f"lock file is missing: {path}")
    except OSError as error:
        raise SourceStoreLockError(f"cannot inspect lock file: {path}") from error
    if _is_reparse(metadata) or not stat.S_ISREG(metadata.st_mode):
        raise SourceStoreLockError(f"lock path is not a regular file: {path}")
    return metadata


def _proc_starttime(pid: int) -> tuple[str, str]:
    path = Path(f"/proc/{pid}/stat")
    try:
        raw = path.read_text(encoding="ascii")
        pid_namespace = os.readlink(f"/proc/{pid}/ns/pid")
    except OSError as error:
        raise _OwnerRecordError("linux_process_snapshot_unavailable") from error
    closing_paren = raw.rfind(")")
    if closing_paren < 0:
        raise _OwnerRecordError("linux_process_stat_malformed")
    fields = raw[closing_paren + 1 :].split()
    # tail[0] is field 3 (state), so field 22 (starttime) is index 19.
    if len(fields) <= 19:
        raise _OwnerRecordError("linux_process_stat_malformed")
    try:
        start_ticks = int(fields[19], 10)
    except ValueError as error:
        raise _OwnerRecordError("linux_process_generation_malformed") from error
    if start_ticks < 0 or not pid_namespace.startswith("pid:["):
        raise _OwnerRecordError("linux_process_namespace_malformed")
    return str(start_ticks), pid_namespace


def _linux_owner_identity() -> dict[str, object]:
    try:
        kernel = os.uname().release
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text(
            encoding="ascii"
        ).strip().lower()
        uuid.UUID(boot_id)
        pid = os.getpid()
        generation, pid_namespace = _proc_starttime(pid)
        boot_id_after = Path("/proc/sys/kernel/random/boot_id").read_text(
            encoding="ascii"
        ).strip().lower()
    except _OwnerRecordError:
        raise
    except (OSError, ValueError) as error:
        raise _OwnerRecordError("linux_namespace_snapshot_unavailable") from error
    if boot_id_after != boot_id or not kernel:
        raise _OwnerRecordError("linux_boot_identity_changed")
    return {
        "platform": "linux",
        "kernel": kernel,
        "boot_id": boot_id,
        "pid_namespace": pid_namespace,
        "pid": pid,
        "generation": generation,
    }


def _windows_process_creation_time(handle: int) -> int:
    from ctypes import wintypes

    class _FileTime(ctypes.Structure):
        _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetProcessTimes.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime),
    ]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    creation = _FileTime()
    exit_time = _FileTime()
    kernel_time = _FileTime()
    user_time = _FileTime()
    if not kernel32.GetProcessTimes(
        wintypes.HANDLE(handle),
        ctypes.byref(creation),
        ctypes.byref(exit_time),
        ctypes.byref(kernel_time),
        ctypes.byref(user_time),
    ):
        raise _OwnerRecordError("windows_process_generation_query_failed")
    return (int(creation.high) << 32) | int(creation.low)


def _windows_machine_identity() -> str:
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Cryptography",
            0,
            winreg.KEY_READ | getattr(winreg, "KEY_WOW64_64KEY", 0),
        ) as key:
            machine_guid, _ = winreg.QueryValueEx(key, "MachineGuid")
    except (OSError, ImportError) as error:
        raise _OwnerRecordError("windows_host_identity_query_failed") from error
    if not isinstance(machine_guid, str) or not machine_guid.strip():
        raise _OwnerRecordError("windows_host_identity_invalid")
    return hashlib.sha256(machine_guid.strip().casefold().encode("utf-8")).hexdigest()


def _windows_boot_identity() -> str:
    system_root = os.environ.get("SystemRoot")
    if not isinstance(system_root, str) or not system_root:
        raise _OwnerRecordError("windows_system_root_unavailable")
    powershell = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if not powershell.is_file():
        raise _OwnerRecordError("windows_wmi_query_tool_unavailable")
    script = (
        "$ErrorActionPreference='Stop'; "
        "$os=Get-CimInstance -ClassName Win32_OperatingSystem; "
        "if ($null -eq $os -or $null -eq $os.LastBootUpTime) { exit 3 }; "
        "[Console]::Out.WriteLine($os.LastBootUpTime.ToUniversalTime().ToFileTimeUtc())"
    )
    try:
        completed = subprocess.run(
            [str(powershell), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="ascii",
            timeout=_WINDOWS_BOOT_QUERY_TIMEOUT_SECONDS,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError, UnicodeError) as error:
        raise _OwnerRecordError("windows_boot_query_failed") from error
    value = completed.stdout.strip()
    if completed.returncode != 0 or not re.fullmatch(r"[0-9]{1,20}", value):
        raise _OwnerRecordError("windows_boot_query_unavailable")
    ticks = int(value, 10)
    if ticks <= 0 or ticks > 0xFFFFFFFFFFFFFFFF:
        raise _OwnerRecordError("windows_boot_identity_invalid")
    return str(ticks)


def _windows_owner_identity() -> dict[str, object]:
    from ctypes import wintypes

    try:
        version = sys.getwindowsversion()
        if not version.platform or version.major <= 0 or version.build <= 0:
            raise _OwnerRecordError("windows_kernel_identity_unavailable")
        kernel = f"{version.platform}:{version.major}.{version.minor}.{version.build}"
    except (AttributeError, OSError) as error:
        raise _OwnerRecordError("windows_kernel_identity_unavailable") from error

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.argtypes = []
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    current = kernel32.GetCurrentProcess()
    creation = _windows_process_creation_time(int(current))
    return {
        "platform": "windows",
        "kernel": kernel,
        "boot_id": _windows_boot_identity(),
        "host_id_sha256": _windows_machine_identity(),
        "pid_namespace": _WINDOWS_NATIVE_PID_NAMESPACE,
        "pid": os.getpid(),
        "generation": str(creation),
    }


class _OwnerIdentityState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.identity: dict[str, object] | None = None
        self.unknown_reason: str | None = None


class OwnerIdentityProvider:
    """Cache a successful current-kernel identity for one store operation."""

    def __init__(self) -> None:
        self._states: dict[tuple[object, int], _OwnerIdentityState] = {}

    def current(self) -> tuple[dict[str, object] | None, str | None]:
        process_key = (_PROCESS_FORK_EPOCH, os.getpid())
        state = self._states.get(process_key)
        if state is None:
            # setdefault makes concurrent first calls in a forked child share
            # the same fresh lock instead of touching an inherited parent lock.
            state = self._states.setdefault(process_key, _OwnerIdentityState())
        with state.lock:
            if state.identity is not None:
                return dict(state.identity), None
            if state.unknown_reason is not None:
                return None, state.unknown_reason
            try:
                if sys.platform.startswith("linux"):
                    identity = _linux_owner_identity()
                elif os.name == "nt":
                    identity = _windows_owner_identity()
                else:
                    raise _OwnerRecordError("unsupported_owner_platform")
            except _OwnerRecordError as error:
                # Keep the operation usable, but make this lock unrecoverable
                # automatically if its process dies.
                state.unknown_reason = error.code
                return None, error.code
            state.identity = identity
            return dict(identity), None


def _lock_record_bytes(
    token: str,
    identity: Mapping[str, object] | None,
    identity_error: str | None,
) -> bytes:
    if not _OWNER_TOKEN_RE.fullmatch(token):
        raise SourceStoreLockError("content publication owner token is invalid")
    if (identity is None) == (identity_error is None):
        raise SourceStoreLockError("content publication owner state is invalid")
    record_body: dict[str, object] = {
        "schema": _OWNER_SCHEMA,
        "token": token,
        "owner_identity_status": "available" if identity is not None else "unknown",
        "owner_identity": dict(identity) if identity is not None else None,
        "owner_identity_error": identity_error,
    }
    checksum = hashlib.sha256(_canonical_json(record_body)).hexdigest()
    return _canonical_json({**record_body, "record_sha256": checksum}) + b"\n"


def _decode_lock_record(data: bytes) -> dict[str, object]:
    if not data or len(data) > _MAX_OWNER_BYTES or not data.endswith(b"\n"):
        raise _OwnerRecordError("legacy_or_incomplete_lock_record")

    def unique_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise _OwnerRecordError("duplicate_owner_record_field")
            result[key] = value
        return result

    try:
        parsed = json.loads(data[:-1].decode("ascii"), object_pairs_hook=unique_pairs)
    except _OwnerRecordError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _OwnerRecordError("legacy_or_corrupt_lock_record") from error
    if not isinstance(parsed, dict) or set(parsed) != {
        "schema",
        "token",
        "owner_identity_status",
        "owner_identity",
        "owner_identity_error",
        "record_sha256",
    }:
        raise _OwnerRecordError("legacy_or_corrupt_lock_record")
    if data != _canonical_json(parsed) + b"\n":
        raise _OwnerRecordError("owner_record_encoding_noncanonical")
    if parsed.get("schema") != _OWNER_SCHEMA:
        raise _OwnerRecordError("unsupported_or_legacy_lock_record")
    token = parsed.get("token")
    if not isinstance(token, str) or not _OWNER_TOKEN_RE.fullmatch(token):
        raise _OwnerRecordError("invalid_lock_owner_token")
    checksum = parsed.get("record_sha256")
    body = {key: value for key, value in parsed.items() if key != "record_sha256"}
    if not isinstance(checksum, str) or not _SHA256_RE.fullmatch(checksum):
        raise _OwnerRecordError("owner_record_integrity_missing")
    if hashlib.sha256(_canonical_json(body)).hexdigest() != checksum:
        raise _OwnerRecordError("owner_record_integrity_mismatch")
    status = parsed.get("owner_identity_status")
    identity = parsed.get("owner_identity")
    identity_error = parsed.get("owner_identity_error")
    if status == "unknown":
        if identity is not None or not isinstance(identity_error, str) or not identity_error:
            raise _OwnerRecordError("owner_record_unknown_state_malformed")
    elif status == "available":
        if identity_error is not None or not isinstance(identity, dict):
            raise _OwnerRecordError("owner_record_identity_malformed")
        _validate_owner_identity(identity)
    else:
        raise _OwnerRecordError("owner_record_identity_status_invalid")
    return parsed


def _validate_owner_identity(identity: Mapping[str, object]) -> None:
    common = {"platform", "kernel", "boot_id", "pid_namespace", "pid", "generation"}
    platform_name = identity.get("platform")
    expected = common | ({"host_id_sha256"} if platform_name == "windows" else set())
    if set(identity) != expected:
        raise _OwnerRecordError("owner_record_identity_shape_invalid")
    if not all(
        isinstance(identity.get(key), str) and bool(identity.get(key))
        for key in ("platform", "kernel", "boot_id", "pid_namespace", "generation")
    ):
        raise _OwnerRecordError("owner_record_identity_field_invalid")
    pid = identity.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        raise _OwnerRecordError("owner_record_pid_invalid")
    if platform_name == "linux":
        if not identity["pid_namespace"].startswith("pid:["):
            raise _OwnerRecordError("owner_record_pid_namespace_invalid")
        if not _SHA256_RE.fullmatch(str(identity["boot_id"])):
            # Linux boot IDs are UUIDs, whose text is shorter than a SHA-256.
            try:
                uuid.UUID(str(identity["boot_id"]))
            except ValueError as error:
                raise _OwnerRecordError("owner_record_boot_id_invalid") from error
        if not re.fullmatch(r"[0-9]+", str(identity["generation"])):
            raise _OwnerRecordError("owner_record_generation_invalid")
    elif platform_name == "windows":
        if identity["pid_namespace"] != _WINDOWS_NATIVE_PID_NAMESPACE:
            raise _OwnerRecordError("owner_record_windows_process_domain_invalid")
        if not _SHA256_RE.fullmatch(str(identity["host_id_sha256"])):
            raise _OwnerRecordError("owner_record_windows_host_identity_invalid")
        if not re.fullmatch(r"[0-9]+", str(identity["boot_id"])) or not re.fullmatch(
            r"[0-9]+", str(identity["generation"])
        ):
            raise _OwnerRecordError("owner_record_windows_generation_invalid")
    else:
        raise _OwnerRecordError("owner_record_platform_unsupported")


def _windows_file_handle(
    path: Path,
    *,
    access: int,
    share: int,
    creation: int,
):
    from ctypes import wintypes
    import msvcrt

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    handle = kernel32.CreateFileW(
        str(path),
        access,
        share,
        None,
        creation,
        0x00200000,  # FILE_FLAG_OPEN_REPARSE_POINT
        None,
    )
    invalid_handle = ctypes.c_void_p(-1).value
    if not handle or int(handle) == invalid_handle:
        error = ctypes.get_last_error()
        raise OSError(error, "CreateFileW failed for source-store lock file", str(path))

    kernel32.GetFileType.argtypes = [wintypes.HANDLE]
    kernel32.GetFileType.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    if kernel32.GetFileType(handle) != 1:  # FILE_TYPE_DISK
        kernel32.CloseHandle(handle)
        raise SourceStoreLockError(f"lock path is not a disk file: {path}")
    try:
        descriptor = msvcrt.open_osfhandle(
            int(handle),
            getattr(os, "O_BINARY", 0) | (os.O_RDWR if access & 0x40000000 else os.O_RDONLY),
        )
    except OSError:
        kernel32.CloseHandle(handle)
        raise
    try:
        metadata = os.fstat(descriptor)
        if _is_reparse(metadata) or not stat.S_ISREG(metadata.st_mode):
            raise SourceStoreLockError(f"lock path is a reparse point or non-file: {path}")
    except Exception:
        os.close(descriptor)
        raise
    return descriptor


def _open_regular_file(path: Path, *, writable: bool, gate: bool = False) -> int:
    _regular_path_metadata(path, allow_missing=False)
    if os.name == "nt":
        access = (0x80000000 if not writable else 0x40000000)  # GENERIC_READ/WRITE
        share = 0x1 | 0x2  # FILE_SHARE_READ | FILE_SHARE_WRITE; never share DELETE for gate
        if not gate:
            share |= 0x4  # FILE_SHARE_DELETE for a pinned read of the canonical record
        return _windows_file_handle(
            path,
            access=access,
            share=share,
            creation=3,  # OPEN_EXISTING
        )
    flags = os.O_RDWR if writable else os.O_RDONLY
    flags |= (
        getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise SourceStoreLockError(f"cannot open lock file without following links: {path}") from error
    try:
        opened = os.fstat(descriptor)
        current = _regular_path_metadata(path, allow_missing=False)
        if not stat.S_ISREG(opened.st_mode) or current is None or not _same_identity(opened, current):
            raise SourceStoreLockError(f"lock file identity changed while opening: {path}")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _read_lock_record(path: Path) -> tuple[dict[str, object], os.stat_result]:
    before = _regular_path_metadata(path, allow_missing=False)
    assert before is not None
    descriptor = _open_regular_file(path, writable=False)
    try:
        opened = os.fstat(descriptor)
        if not _same_identity(before, opened):
            raise _OwnerRecordError("lock_identity_changed_while_opening")
        if opened.st_size <= 0 or opened.st_size > _MAX_OWNER_BYTES:
            raise _OwnerRecordError("lock_record_size_invalid")
        chunks: list[bytes] = []
        remaining = _MAX_OWNER_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(4096, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after_open = os.fstat(descriptor)
        after_path = _regular_path_metadata(path, allow_missing=False)
        if (
            after_path is None
            or not _same_identity(before, after_open)
            or not _same_identity(after_open, after_path)
            or opened.st_size != after_open.st_size
            or len(data) != after_open.st_size
        ):
            raise _OwnerRecordError("lock_record_changed_while_reading")
        return _decode_lock_record(data), after_path
    finally:
        os.close(descriptor)


def _linux_process_state(pid: int) -> tuple[str, str, str]:
    starttime, pid_namespace = _proc_starttime(pid)
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except OSError as error:
        raise _OwnerRecordError("linux_process_snapshot_unavailable") from error
    closing_paren = raw.rfind(")")
    if closing_paren < 0:
        raise _OwnerRecordError("linux_process_stat_malformed")
    fields = raw[closing_paren + 1 :].split()
    if not fields or len(fields) <= 19:
        raise _OwnerRecordError("linux_process_stat_malformed")
    return starttime, pid_namespace, fields[0]


def _linux_owner_liveness(
    owner: Mapping[str, object],
    current: Mapping[str, object],
) -> tuple[str, str]:
    if any(owner.get(key) != current.get(key) for key in ("platform", "kernel", "boot_id", "pid_namespace")):
        return "unknown", "owner_namespace_mismatch"
    pid = owner.get("pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return "unknown", "owner_pid_invalid"
    pidfd_open = getattr(os, "pidfd_open", None)
    if not callable(pidfd_open):
        return "unknown", "linux_pidfd_unavailable"
    try:
        pidfd = pidfd_open(pid, 0)
    except ProcessLookupError:
        return "dead", "owner_pid_absent_in_same_namespace"
    except OSError:
        return "unknown", "linux_pidfd_open_failed"
    try:
        try:
            generation, process_namespace, _state = _linux_process_state(pid)
        except _OwnerRecordError as error:
            return "unknown", error.code
        if process_namespace != current["pid_namespace"]:
            # This PID now resolves to a process from a nested PID namespace;
            # it cannot be the original owner in this exact namespace.
            return "dead", "owner_pid_reused_by_other_namespace"
        if generation != owner.get("generation"):
            return "dead", "owner_pid_generation_reused"
        poller = select.poll()
        poller.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
        try:
            events = poller.poll(0)
        except OSError:
            return "unknown", "linux_pidfd_poll_failed"
        if not events:
            return "alive", "owner_process_group_still_live"
        flags = events[0][1]
        if flags & (select.POLLIN | select.POLLHUP):
            # pidfd_open(pid, 0) references the process/thread group, and Linux
            # signals it only after the last thread has exited.
            return "dead", "owner_process_group_exited"
        return "unknown", "linux_pidfd_poll_state_unknown"
    finally:
        os.close(pidfd)


def _windows_snapshot_has_pid(pid: int) -> tuple[bool | None, str]:
    from ctypes import wintypes

    class _ProcessEntry32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessEntry32W)]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessEntry32W)]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    invalid_handle = ctypes.c_void_p(-1).value
    if not snapshot or int(snapshot) == invalid_handle:
        return None, "windows_process_snapshot_failed"
    try:
        entry = _ProcessEntry32W()
        entry.dwSize = ctypes.sizeof(entry)
        if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            error = ctypes.get_last_error()
            return (False, "owner_pid_absent_in_same_namespace") if error == 18 else (None, "windows_process_snapshot_failed")
        while True:
            if int(entry.th32ProcessID) == pid:
                return True, "owner_pid_present"
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                error = ctypes.get_last_error()
                if error == 18:  # ERROR_NO_MORE_FILES
                    return False, "owner_pid_absent_in_same_namespace"
                return None, "windows_process_snapshot_failed"
    finally:
        kernel32.CloseHandle(snapshot)


def _windows_owner_liveness(
    owner: Mapping[str, object],
    current: Mapping[str, object],
) -> tuple[str, str]:
    if any(
        owner.get(key) != current.get(key)
        for key in ("platform", "kernel", "boot_id", "host_id_sha256", "pid_namespace")
    ):
        return "unknown", "owner_namespace_mismatch"
    pid = owner.get("pid")
    generation = owner.get("generation")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return "unknown", "owner_pid_invalid"
    if not isinstance(generation, str) or not generation.isdigit():
        return "unknown", "owner_generation_invalid"
    present, snapshot_reason = _windows_snapshot_has_pid(pid)
    if present is None:
        return "unknown", snapshot_reason
    if not present:
        return "dead", snapshot_reason

    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    access = 0x00100000 | 0x1000  # SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
    handle = kernel32.OpenProcess(access, False, pid)
    if not handle:
        return "unknown", "windows_process_handle_open_failed"
    try:
        try:
            creation = _windows_process_creation_time(int(handle))
        except _OwnerRecordError as error:
            return "unknown", error.code
        if str(creation) != generation:
            return "dead", "owner_pid_generation_reused"
        wait_result = kernel32.WaitForSingleObject(handle, 0)
        if wait_result == 0:  # WAIT_OBJECT_0
            return "dead", "owner_process_handle_signaled"
        if wait_result == 0x102:  # WAIT_TIMEOUT
            return "alive", "owner_process_handle_not_signaled"
        return "unknown", "windows_process_wait_failed"
    finally:
        kernel32.CloseHandle(handle)


def _owner_liveness(
    owner: Mapping[str, object],
    current: Mapping[str, object],
) -> tuple[str, str]:
    if owner.get("platform") == "linux" and sys.platform.startswith("linux"):
        return _linux_owner_liveness(owner, current)
    if owner.get("platform") == "windows" and os.name == "nt":
        return _windows_owner_liveness(owner, current)
    return "unknown", "owner_platform_mismatch"


_THREAD_GATES_GUARD = threading.Lock()
_THREAD_GATES: dict[str, threading.Lock] = {}
_ACTIVE_GATE_LEASES: set["_RecoveryGateLease"] = set()


class _RecoveryGateLease:
    def __init__(self) -> None:
        self.descriptor: int | None = None
        self.locked = False


def _before_fork() -> None:
    _FORK_STATE_LOCK.acquire()


def _after_fork_in_parent() -> None:
    _FORK_STATE_LOCK.release()


def _after_fork_in_child() -> None:
    global _ACTIVE_PUBLICATION_OPERATIONS
    global _ACTIVE_GATE_LEASES
    global _FORK_STATE_LOCK
    global _FORK_UNSAFE_AFTER_ACTIVE_OPERATION
    global _PROCESS_FORK_EPOCH
    global _THREAD_GATES
    global _THREAD_GATES_GUARD

    # A fork during publication inherits a parent-owned canonical path lease.
    # Make the child fail closed and close only its duplicated gate descriptors;
    # never issue LOCK_UN or unlink the parent's path.
    if _ACTIVE_PUBLICATION_OPERATIONS:
        _FORK_UNSAFE_AFTER_ACTIVE_OPERATION = True
    for lease in tuple(_ACTIVE_GATE_LEASES):
        descriptor = lease.descriptor
        lease.descriptor = None
        lease.locked = False
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
    _ACTIVE_GATE_LEASES = set()
    _ACTIVE_PUBLICATION_OPERATIONS = 0
    _PROCESS_FORK_EPOCH = object()
    # Neither the global map guard nor any per-path gate lock is safe to reuse
    # in the single surviving child thread after fork.
    _THREAD_GATES_GUARD = threading.Lock()
    _THREAD_GATES = {}
    _FORK_STATE_LOCK = threading.Lock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(
        before=_before_fork,
        after_in_parent=_after_fork_in_parent,
        after_in_child=_after_fork_in_child,
    )


def _thread_gate(path: Path) -> threading.Lock:
    key = os.path.normcase(os.path.abspath(path))
    with _THREAD_GATES_GUARD:
        lock = _THREAD_GATES.get(key)
        if lock is None:
            lock = threading.Lock()
            _THREAD_GATES[key] = lock
        return lock


def _open_recovery_gate_descriptor(
    gate_path: Path,
    lease: _RecoveryGateLease,
) -> int:
    with _FORK_STATE_LOCK:
        if _FORK_UNSAFE_AFTER_ACTIVE_OPERATION:
            raise SourceStoreLockError(
                "recovery is disabled in a process forked during an active lock operation"
            )
        if os.name == "nt":
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CreateFileW.argtypes = [
                wintypes.LPCWSTR,
                wintypes.DWORD,
                wintypes.DWORD,
                wintypes.LPVOID,
                wintypes.DWORD,
                wintypes.DWORD,
                wintypes.HANDLE,
            ]
            kernel32.CreateFileW.restype = wintypes.HANDLE
            handle = kernel32.CreateFileW(
                str(gate_path),
                0xC0000000,  # GENERIC_READ | GENERIC_WRITE
                0x1 | 0x2,  # share read/write but deny delete/rename while pinned
                None,
                4,  # OPEN_ALWAYS
                0x00200000,  # FILE_FLAG_OPEN_REPARSE_POINT
                None,
            )
            invalid_handle = ctypes.c_void_p(-1).value
            if not handle or int(handle) == invalid_handle:
                raise OSError(
                    ctypes.get_last_error(),
                    "cannot open pinned recovery gate",
                    str(gate_path),
                )
            import msvcrt

            try:
                descriptor = msvcrt.open_osfhandle(
                    int(handle),
                    os.O_RDWR | getattr(os, "O_BINARY", 0),
                )
            except OSError:
                kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
                kernel32.CloseHandle.restype = wintypes.BOOL
                kernel32.CloseHandle(handle)
                raise
        else:
            flags = (
                os.O_RDWR
                | os.O_CREAT
                | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NONBLOCK", 0)
            )
            descriptor = os.open(gate_path, flags, 0o600)
        lease.descriptor = descriptor
        _ACTIVE_GATE_LEASES.add(lease)
        return descriptor


@contextmanager
def _recovery_gate(root: Path, namespace_identity: Mapping[str, object]) -> Iterator[None]:
    namespace = {
        key: value
        for key, value in namespace_identity.items()
        if key not in {"pid", "generation"}
    }
    namespace_digest = hashlib.sha256(_canonical_json(namespace)).hexdigest()[:32]
    gate_directory = _real_directory(root / _RECOVERY_DIRECTORY, create=True)
    gate_path = gate_directory / f"recovery-{namespace_digest}.lock"
    _guard_components(gate_path, allow_missing=True)
    lease = _RecoveryGateLease()
    thread_gate = _thread_gate(gate_path)
    thread_gate.acquire()
    try:
        descriptor = _open_recovery_gate_descriptor(gate_path, lease)

        opened = os.fstat(descriptor)
        current = _regular_path_metadata(gate_path, allow_missing=False)
        if current is None or not stat.S_ISREG(opened.st_mode) or not _same_identity(opened, current):
            raise SourceStoreLockError("recovery gate identity is not pinned")
        if opened.st_size == 0:
            os.lseek(descriptor, 0, os.SEEK_SET)
            if os.write(descriptor, b"\0") != 1:
                raise OSError(errno.EIO, "short write for recovery gate")
            os.fsync(descriptor)
        if os.name == "nt":
            import msvcrt

            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
        with _FORK_STATE_LOCK:
            if lease.descriptor != descriptor:
                raise SourceStoreLockError("recovery gate descriptor was invalidated after fork")
            lease.locked = True
        opened_after_lock = os.fstat(descriptor)
        current_after_lock = _regular_path_metadata(gate_path, allow_missing=False)
        if (
            current_after_lock is None
            or not _same_identity(opened, opened_after_lock)
            or not _same_identity(opened_after_lock, current_after_lock)
        ):
            raise SourceStoreLockError("recovery gate path changed after locking")
        yield
    finally:
        with _FORK_STATE_LOCK:
            descriptor = lease.descriptor
            locked = lease.locked
            lease.descriptor = None
            lease.locked = False
            _ACTIVE_GATE_LEASES.discard(lease)
            if descriptor is not None:
                try:
                    if locked and os.name == "nt":
                        import msvcrt

                        os.lseek(descriptor, 0, os.SEEK_SET)
                        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                    elif locked:
                        fcntl.flock(descriptor, fcntl.LOCK_UN)
                except OSError:
                    pass
                try:
                    os.close(descriptor)
                except OSError:
                    pass
        thread_gate.release()


def _try_recover_lock(
    lock_path: Path,
    root: Path,
    current_identity: Mapping[str, object] | None,
    process_epoch: object,
) -> tuple[bool, str]:
    _check_publication_epoch(process_epoch)
    try:
        if current_identity is None:
            return False, "current_owner_namespace_unknown"
        first_record, first_metadata = _read_lock_record(lock_path)
    except _OwnerRecordError as error:
        return False, error.code
    except SourceStoreLockError as error:
        try:
            if _regular_path_metadata(lock_path, allow_missing=True) is None:
                return True, "lock_disappeared"
        except SourceStoreLockError:
            pass
        return False, str(error)
    if first_record.get("owner_identity_status") != "available":
        return False, "lock_owner_identity_unavailable"
    owner_identity = first_record.get("owner_identity")
    if not isinstance(owner_identity, dict):
        return False, "lock_owner_identity_invalid"
    namespace_keys = ("platform", "kernel", "boot_id", "pid_namespace")
    if owner_identity.get("platform") == "windows":
        namespace_keys += ("host_id_sha256",)
    if any(owner_identity.get(key) != current_identity.get(key) for key in namespace_keys):
        return False, "lock_owner_namespace_mismatch"

    try:
        with _recovery_gate(root, current_identity):
            _check_publication_epoch(process_epoch)
            # Never use the pre-gate record to reclaim. Another reclaimer may
            # have removed it and published a different live owner meanwhile.
            record, metadata = _read_lock_record(lock_path)
            token = first_record.get("token")
            if record.get("token") != token or not _same_identity(first_metadata, metadata):
                return False, "lock_owner_changed_before_recovery"
            if record.get("owner_identity_status") != "available":
                return False, "lock_owner_identity_unavailable"
            owner = record.get("owner_identity")
            if not isinstance(owner, dict) or any(
                owner.get(key) != current_identity.get(key) for key in namespace_keys
            ):
                return False, "lock_owner_namespace_mismatch"
            state, reason = _owner_liveness(owner, current_identity)
            _check_publication_epoch(process_epoch)
            if state != "dead":
                return False, f"owner_{state}:{reason}"

            # Re-read the exact name and self-hashed record immediately before
            # the one allowed unlink. No rename/restore sequence is used.
            final_record, final_metadata = _read_lock_record(lock_path)
            current_path_metadata = _regular_path_metadata(lock_path, allow_missing=False)
            if (
                current_path_metadata is None
                or final_record.get("token") != token
                or not _same_identity(metadata, final_metadata)
                or not _same_identity(final_metadata, current_path_metadata)
            ):
                return False, "lock_owner_changed_before_unlink"
            final_owner = final_record.get("owner_identity")
            if not isinstance(final_owner, dict) or any(
                final_owner.get(key) != current_identity.get(key) for key in namespace_keys
            ):
                return False, "lock_owner_namespace_changed"
            path_metadata = _regular_path_metadata(lock_path, allow_missing=False)
            if path_metadata is None or not _same_identity(final_metadata, path_metadata):
                return False, "lock_owner_changed_before_unlink"
            _check_publication_epoch(process_epoch)
            lock_path.unlink()
            return True, "confirmed_dead_owner_lock_removed"
    except _OwnerRecordError as error:
        return False, error.code
    except (OSError, SourceStoreLockError) as error:
        return False, f"recovery_gate_or_unlink_unknown:{type(error).__name__}"


@contextmanager
def publication_lock(
    lock_path: Path,
    root: Path,
    *,
    wait_timeout_seconds: float,
    identity_provider: OwnerIdentityProvider,
) -> Iterator[None]:
    process_epoch = _begin_publication_operation()
    try:
        with _publication_lock_body(
            lock_path,
            root,
            wait_timeout_seconds=wait_timeout_seconds,
            identity_provider=identity_provider,
            process_epoch=process_epoch,
        ):
            yield
    finally:
        _end_publication_operation(process_epoch)


@contextmanager
def _publication_lock_body(
    lock_path: Path,
    root: Path,
    *,
    wait_timeout_seconds: float,
    identity_provider: OwnerIdentityProvider,
    process_epoch: object,
) -> Iterator[None]:
    """Acquire cross-OS admission and recover only a provably dead local owner."""

    _check_publication_epoch(process_epoch)
    _real_directory(root, create=True)
    _regular_path_metadata(lock_path, allow_missing=True)
    identity, identity_error = identity_provider.current()
    token = uuid.uuid4().hex
    record = _lock_record_bytes(token, identity, identity_error)
    _check_publication_epoch(process_epoch)
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".pending-owner-{token}-",
            suffix=".tmp",
            dir=lock_path.parent,
        )
    except OSError as error:
        raise SourceStoreLockError(f"cannot prepare content lock owner record: {lock_path}") from error
    temporary_path = Path(temporary_name)
    try:
        _check_publication_epoch(process_epoch)
    except SourceStoreLockError:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
    temporary_identity: os.stat_result | None = None
    canonical_identity: os.stat_result | None = None
    acquired = False
    last_reason = "lock_busy"
    deadline = time.monotonic() + max(0.0, wait_timeout_seconds)
    try:
        try:
            view = memoryview(record)
            while view:
                _check_publication_epoch(process_epoch)
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError(errno.EIO, "short write for owner record")
                view = view[written:]
            if os.name != "nt":
                _check_publication_epoch(process_epoch)
                os.fchmod(descriptor, 0o400)
            _check_publication_epoch(process_epoch)
            os.fsync(descriptor)
            _check_publication_epoch(process_epoch)
            temporary_identity = os.fstat(descriptor)
            if not stat.S_ISREG(temporary_identity.st_mode):
                raise SourceStoreLockError("prepared owner record is not a regular file")
        except OSError as error:
            raise SourceStoreLockError("cannot persist complete content-lock owner record") from error
        finally:
            os.close(descriptor)

        while True:
            _check_publication_epoch(process_epoch)
            _regular_path_metadata(lock_path, allow_missing=True)
            try:
                os.link(temporary_path, lock_path, follow_symlinks=False)
            except FileExistsError:
                recovered, last_reason = _try_recover_lock(
                    lock_path,
                    root,
                    identity,
                    process_epoch,
                )
                if recovered:
                    continue
                if time.monotonic() >= deadline:
                    raise SourceStoreLockError(
                        f"content publication lock recovery blocked ({last_reason}); "
                        f"operator reconciliation required: {lock_path}"
                    )
                time.sleep(min(_WAIT_SLICE_SECONDS, max(0.0, deadline - time.monotonic())))
                continue
            except OSError as error:
                raise SourceStoreLockError(
                    f"atomic content publication lock failed: {lock_path}"
                ) from error

            if temporary_identity is None:
                raise SourceStoreLockError("prepared owner record identity is unavailable")
            _check_publication_epoch(process_epoch)
            # os.link atomically binds the fully persisted owner record. Mark
            # it releasable now so any failed post-publication check performs
            # the same token-and-inode checked cleanup as a normal exit.
            canonical_identity = temporary_identity
            acquired = True
            current = _regular_path_metadata(lock_path, allow_missing=False)
            temporary_current = _regular_path_metadata(temporary_path, allow_missing=False)
            if (
                current is None
                or temporary_current is None
                or not _same_identity(temporary_identity, current)
                or not _same_identity(temporary_identity, temporary_current)
            ):
                raise SourceStoreLockError("published content lock identity did not match its owner record")
            canonical_identity = current
            _check_publication_epoch(process_epoch)
            try:
                temporary_path.unlink()
            except OSError:
                # A crash here leaves a second link to the complete owner
                # record, not an incomplete canonical lock.
                pass
            _check_publication_epoch(process_epoch)
            break

        _check_publication_epoch(process_epoch)
        yield
    finally:
        if process_epoch is _PROCESS_FORK_EPOCH:
            if acquired and canonical_identity is not None:
                try:
                    current_record, record_metadata = _read_lock_record(lock_path)
                    current_path = _regular_path_metadata(lock_path, allow_missing=False)
                    if (
                        current_record.get("token") != token
                        or current_path is None
                        or not _same_identity(canonical_identity, record_metadata)
                        or not _same_identity(record_metadata, current_path)
                    ):
                        raise SourceStoreLockError(
                            f"content publication lock changed before owner release: {lock_path}"
                        )
                    lock_path.unlink()
                except FileNotFoundError:
                    pass
                except SourceStoreLockError:
                    raise
                except OSError as error:
                    raise SourceStoreLockError(
                        f"cannot release content publication lock: {lock_path}"
                    ) from error
            try:
                temporary_current = _regular_path_metadata(temporary_path, allow_missing=True)
                if (
                    temporary_current is not None
                    and temporary_identity is not None
                    and _same_identity(temporary_identity, temporary_current)
                ):
                    temporary_path.chmod(0o600)
                    temporary_path.unlink()
            except (OSError, SourceStoreLockError):
                # Orphan private owner records are harmless and never considered
                # canonical locks; preserving an uncertain inode is fail-closed.
                pass


__all__ = [
    "OwnerIdentityProvider",
    "SourceStoreLockError",
    "ensure_publication_process_is_safe",
    "publication_process_is_safe",
    "publication_lock",
]
