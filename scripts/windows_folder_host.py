"""Native Windows attestation for the Docker-owned session folder."""
from __future__ import annotations

import ctypes
from contextlib import contextmanager
import hashlib
import json
import re
import stat
import os
import shutil
import subprocess
import unicodedata
import uuid
from pathlib import Path

import fullmag_storage as storage

HOST_SCHEMA = "fullmag.windows-folder-host.v1"
OWNER_NAME = ".fullmag-windows-folder-owner.json"
HOST_CERT_PATH = "/run/fullmag/windows-folder-host.json"
DEVELOPMENT_BUILD_SCHEMA = "fullmag.windows-folder-development-build.v1"
BOUND_EVIDENCE_MAX_BYTES = 1024 * 1024
_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_COMMIT_RE = re.compile(r"[0-9a-f]{40}")


def _replace_write_through(source, destination):
    if os.name != "nt":
        os.replace(source, destination)
        return
    from ctypes import wintypes
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.MoveFileExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    api.MoveFileExW.restype = wintypes.BOOL
    # Keep atomic same-volume replacement and wait for the move to reach disk.
    if not api.MoveFileExW(str(source), str(destination), 0x1 | 0x8):
        raise ctypes.WinError(ctypes.get_last_error())


@contextmanager
def _pinned_no_reparse_ancestors(path):
    """Hold native directory handles without FILE_SHARE_DELETE during a write.

    The existing bounded reader rejects reparse points at one instant.  Frozen
    file creation also needs to prevent a concurrent rename/delete of any
    ancestor while the exclusive destination handle is opened and verified.
    """
    path = Path(path)
    if os.name != "nt":
        yield
        return
    from ctypes import wintypes

    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    api.CreateFileW.restype = wintypes.HANDLE
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    api.CloseHandle.restype = wintypes.BOOL
    class AttributeTag(ctypes.Structure):
        _fields_ = [("attributes", wintypes.DWORD), ("tag", wintypes.DWORD)]
    api.GetFileInformationByHandleEx.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD
    ]
    api.GetFileInformationByHandleEx.restype = wintypes.BOOL
    invalid = ctypes.c_void_p(-1).value
    handles = []
    ancestors = [path, *path.parents]
    try:
        for ancestor in reversed(ancestors):
            if storage.is_link(ancestor) or not ancestor.is_dir():
                raise ValueError("Owned write traverses a missing or reparse-point ancestor")
            # FILE_READ_ATTRIBUTES, FILE_SHARE_READ|FILE_SHARE_WRITE (no
            # FILE_SHARE_DELETE), OPEN_EXISTING, BACKUP_SEMANTICS and
            # OPEN_REPARSE_POINT.  Omitting FILE_SHARE_DELETE pins the path
            # component against rename/delete until this context exits.
            handle = api.CreateFileW(
                str(ancestor), 0x80, 0x3, None, 3, 0x02000000 | 0x00200000, None
            )
            if handle == invalid:
                raise ctypes.WinError(ctypes.get_last_error())
            attributes = AttributeTag()
            try:
                if not api.GetFileInformationByHandleEx(
                    handle, 9, ctypes.byref(attributes), ctypes.sizeof(attributes)
                ):
                    raise ctypes.WinError(ctypes.get_last_error())
                if not (attributes.attributes & 0x10) or attributes.attributes & 0x400:
                    raise ValueError(
                        "Owned write opened a non-directory or reparse-point ancestor"
                    )
            except BaseException:
                api.CloseHandle(handle)
                raise
            handles.append(handle)
        yield
    finally:
        for handle in reversed(handles):
            api.CloseHandle(handle)


def publish_evidence(path, value):
    """Flush scoped attestation bytes before atomic Windows write-through publication.

    This is an operational restart barrier, not a power-loss qualification.
    """
    import json
    path = Path(path)
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        _replace_write_through(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _bound_evidence_bytes(value, maximum):
    if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum <= 0:
        raise ValueError("Bound evidence maximum must be a positive integer")
    payload = (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    if len(payload) > maximum:
        raise ValueError("Bound evidence exceeds its size limit")
    return payload


def _validate_bound_target(path):
    path = Path(path)
    if not path.is_absolute():
        raise ValueError("Bound evidence path must be absolute")
    for ancestor in (path, *path.parents):
        if storage.is_link(ancestor):
            raise ValueError("Bound evidence traverses a reparse point")
    if not path.exists():
        raise ValueError("Bound evidence target does not exist")
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError("Bound evidence target is not an unshared regular file")
    return path


def _validate_bound_fd(fd):
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError("Bound evidence target is not an unshared regular file")


def _open_windows_bound_fd(path):
    """Open an existing regular file without following a final reparse point."""
    from ctypes import wintypes
    import msvcrt

    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    api.CreateFileW.restype = wintypes.HANDLE
    api.GetFileInformationByHandleEx.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD
    ]
    api.GetFileInformationByHandleEx.restype = wintypes.BOOL
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    api.CloseHandle.restype = wintypes.BOOL

    class AttributeTag(ctypes.Structure):
        _fields_ = [("attributes", wintypes.DWORD), ("tag", wintypes.DWORD)]

    invalid = ctypes.c_void_p(-1).value
    # GENERIC_READ|GENERIC_WRITE, FILE_SHARE_READ|FILE_SHARE_WRITE (no
    # FILE_SHARE_DELETE), OPEN_EXISTING, and OPEN_REPARSE_POINT.  The
    # ancestor handles held by _pinned_no_reparse_ancestors protect the
    # directory path while this final handle is acquired.
    handle = api.CreateFileW(
        str(path), 0xC0000000, 0x3, None, 3, 0x00200000, None
    )
    if handle == invalid:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        attributes = AttributeTag()
        if not api.GetFileInformationByHandleEx(
            handle, 9, ctypes.byref(attributes), ctypes.sizeof(attributes)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        if attributes.attributes & (0x400 | 0x10):
            raise ValueError("Bound evidence is a directory or reparse point")
        fd = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
        handle = None
        return fd
    finally:
        if handle is not None:
            api.CloseHandle(handle)


@contextmanager
def _open_bound_evidence(path):
    path = _validate_bound_target(path)
    parent_fd = None
    fd = None
    if os.name == "nt":
        with _pinned_no_reparse_ancestors(path.parent):
            fd = _open_windows_bound_fd(path)
            try:
                _validate_bound_fd(fd)
                yield fd, None
            finally:
                os.close(fd)
        return

    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    parent_fd = os.open(str(path.parent), flags)
    try:
        file_flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        fd = os.open(path.name, file_flags, dir_fd=parent_fd)
        _validate_bound_fd(fd)
        yield fd, parent_fd
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent_fd)


def _read_bound_fd(fd, maximum):
    os.lseek(fd, 0, os.SEEK_SET)
    data = os.read(fd, maximum + 1)
    if len(data) > maximum:
        raise ValueError("Bound evidence target exceeds its size limit")
    return data


def _write_bound_fd(fd, payload):
    os.lseek(fd, 0, os.SEEK_SET)
    os.ftruncate(fd, 0)
    offset = 0
    while offset < len(payload):
        written = os.write(fd, payload[offset:])
        if not isinstance(written, int) or written <= 0:
            raise OSError("Bound evidence write made no progress")
        offset += written


def write_bound_evidence(path, value, maximum=BOUND_EVIDENCE_MAX_BYTES):
    """Update an existing bound certificate inode in place and read it back.

    The host certificate is a single-file read-only bind into the backend.
    Replacing its path would leave the container attached to the old inode, so
    this writer never calls ``os.replace``.  It rejects reparse points and
    unshared files, pins the parent on Windows, and restores the previous
    bytes on a write-side failure when the filesystem permits it.
    """
    payload = _bound_evidence_bytes(value, maximum)
    with _open_bound_evidence(path) as (fd, parent_fd):
        previous = _read_bound_fd(fd, maximum)
        try:
            if previous != payload:
                _write_bound_fd(fd, payload)
            os.fsync(fd)
            if _read_bound_fd(fd, maximum) != payload:
                raise ValueError("Bound evidence readback differs from the requested value")
            if parent_fd is not None:
                os.fsync(parent_fd)
        except BaseException:
            try:
                _write_bound_fd(fd, previous)
                os.fsync(fd)
                if parent_fd is not None:
                    os.fsync(parent_fd)
            except BaseException:
                pass
            raise
    return hashlib.sha256(payload).hexdigest()


def read_owned_regular(path, maximum=1024 * 1024):
    """Bounded native read that rejects final reparse points and their ancestors."""
    from ctypes import wintypes
    import msvcrt
    path = Path(path)
    for ancestor in (path, *path.parents):
        if storage.is_link(ancestor):
            raise ValueError("Owned evidence traverses a reparse point")
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                               ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    api.CreateFileW.restype = wintypes.HANDLE
    handle = api.CreateFileW(str(path), 0x80000000, 7, None, 3, 0x00200000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    class AttributeTag(ctypes.Structure):
        _fields_ = [("attributes", wintypes.DWORD), ("tag", wintypes.DWORD)]
    api.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                ctypes.c_void_p, wintypes.DWORD]
    api.GetFileInformationByHandleEx.restype = wintypes.BOOL
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    try:
        attributes = AttributeTag()
        if not api.GetFileInformationByHandleEx(handle, 9, ctypes.byref(attributes), ctypes.sizeof(attributes)):
            raise ctypes.WinError(ctypes.get_last_error())
        if attributes.attributes & (0x400 | 0x10):
            raise ValueError("Owned evidence is a directory or reparse point")
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None
        with os.fdopen(fd, "rb") as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
                raise ValueError("Owned evidence is not a bounded regular file")
            data = stream.read(maximum + 1)
            if len(data) > maximum:
                raise ValueError("Owned evidence exceeded the read limit")
            return data
    finally:
        if handle is not None:
            api.CloseHandle(handle)


def local_volume(path):
    if os.name != "nt":
        raise ValueError("Windows-folder session storage requires native Windows attestation")
    from ctypes import wintypes
    root = Path(path)
    if not root.is_absolute() or len(root.drive) != 2 or root.drive[1] != ":":
        raise ValueError("Session storage must be a local absolute Windows folder, not UNC")
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.GetFileAttributesW.argtypes = [wintypes.LPCWSTR]
    api.GetFileAttributesW.restype = wintypes.DWORD
    for ancestor in (root, *root.parents):
        attributes = api.GetFileAttributesW(str(ancestor))
        if attributes == 0xFFFFFFFF or attributes & 0x400:
            raise ValueError("Session folder has an unknown or reparse-point ancestor")
    api.GetVolumePathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    api.GetVolumePathNameW.restype = wintypes.BOOL
    volume = ctypes.create_unicode_buffer(32768)
    if not api.GetVolumePathNameW(str(root), volume, len(volume)):
        raise ctypes.WinError(ctypes.get_last_error())
    api.GetDriveTypeW.argtypes = [wintypes.LPCWSTR]
    api.GetDriveTypeW.restype = wintypes.UINT
    if api.GetDriveTypeW(volume.value) != 3:
        raise ValueError("Session folder must be on a fixed local Windows volume")
    filesystem = ctypes.create_unicode_buffer(256)
    serial = wintypes.DWORD()
    api.GetVolumeInformationW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD,
                                         ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
                                         ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR, wintypes.DWORD]
    api.GetVolumeInformationW.restype = wintypes.BOOL
    if not api.GetVolumeInformationW(volume.value, None, 0, ctypes.byref(serial), None, None,
                                     filesystem, len(filesystem)):
        raise ctypes.WinError(ctypes.get_last_error())
    if filesystem.value not in {"NTFS", "ReFS"}:
        raise ValueError("Session folder requires local NTFS or ReFS")
    if shutil.disk_usage(root).free < 32 * 1024**2:
        raise ValueError("Session folder has insufficient space for startup preflight")
    return {"host_root": str(root.resolve()), "host_filesystem": filesystem.value,
            "host_drive_type": 3, "host_volume_serial": serial.value,
            "host_root_no_reparse": True}


def prepare_probe_link(state):
    """Create only a fresh owned junction for the guest's negative no-follow test."""
    if os.name != "nt":
        raise ValueError("The junction probe requires native Windows")
    directory = Path(state) / ".windows-folder-probe"
    directory.mkdir(exist_ok=False)
    target = directory / "junction-target"
    target.mkdir()
    link = directory / "host-junction"
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    buffer = ctypes.create_unicode_buffer(32768)
    if not api.GetWindowsDirectoryW(buffer, len(buffer)):
        raise ctypes.WinError(ctypes.get_last_error())
    powershell = Path(buffer.value) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    quoted_link = str(link).replace("'", "''")
    quoted_target = str(target).replace("'", "''")
    command = ("New-Item -ItemType Junction -Path '" + quoted_link + "' -Target '" +
               quoted_target + "' -ErrorAction Stop | Out-Null")
    result = subprocess.run([str(powershell), "-NoLogo", "-NoProfile", "-Command", command],
                            text=True, capture_output=True, timeout=15)
    if result.returncode or not storage.is_link(link):
        raise ValueError("Cannot establish the owned Windows junction no-follow probe")
    return directory


def _validate_development_build(development_build):
    if not isinstance(development_build, dict):
        raise ValueError("Development build delegation must be an object")
    required = {
        "schema", "cargo_profile", "toolchain_image_id", "package_root",
        "provenance_path", "group_identity", "source_identity",
    }
    if set(development_build) != required:
        raise ValueError("Development build delegation has an unexpected field set")
    if development_build.get("schema") != DEVELOPMENT_BUILD_SCHEMA:
        raise ValueError("Development build delegation has an unsupported schema")
    if development_build.get("cargo_profile") != "backend-dev":
        raise ValueError("Development build delegation has an unsupported profile")
    toolchain_image_id = development_build.get("toolchain_image_id")
    if (not isinstance(toolchain_image_id, str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", toolchain_image_id)):
        raise ValueError("Development build delegation toolchain image is invalid")
    if development_build.get("package_root") != "/opt/fullmag/package":
        raise ValueError("Development build delegation package root is invalid")
    if development_build.get("provenance_path") != "/opt/fullmag/provenance.json":
        raise ValueError("Development build delegation provenance path is invalid")
    group_identity = development_build.get("group_identity")
    if (not isinstance(group_identity, str) or not group_identity or len(group_identity) > 256
            or any(unicodedata.category(character) == "Cc" for character in group_identity)):
        raise ValueError("Development build delegation group identity is invalid")
    source_identity = development_build.get("source_identity")
    if not isinstance(source_identity, dict) or set(source_identity) != {
        "commit", "source_digest", "source_snapshot_sha256", "native_source_identity_sha256"
    }:
        raise ValueError("Development build delegation source identity is invalid")
    if (not isinstance(source_identity["commit"], str)
            or not _COMMIT_RE.fullmatch(source_identity["commit"])
            or any(not isinstance(source_identity[field], str)
                   or not _SHA256_RE.fullmatch(source_identity[field])
                   for field in ("source_digest", "source_snapshot_sha256",
                                 "native_source_identity_sha256"))):
        raise ValueError("Development build delegation source identity is invalid")
    return dict(development_build)


def attest(state, assembly, engine_id, binary_hashes, development_build=None):
    native = local_volume(state)
    delegated_build = (
        _validate_development_build(development_build)
        if development_build is not None else None
    )
    prepare_probe_link(state)
    owner = str(uuid.uuid4())
    payload = (owner + ":" + assembly["image_id"]).encode("ascii")
    certificate = {"schema": HOST_SCHEMA, "storage_profile": "windows-folder-v1",
                   "role": "session", "owner_scope": "docker-desktop-linux", **native,
                   "owner_token": owner, "engine_id": engine_id,
                   "image_id": assembly["image_id"], "source_commit": assembly["commit"],
                   "binary_hashes": binary_hashes,
                   "artifact_receipt_sha256": assembly["build_receipt_sha256"],
                   "restart_expected_sha256": hashlib.sha256(payload).hexdigest(),
                   "restart_verified": False}
    if delegated_build is not None:
        certificate["development_build"] = delegated_build
    # The folder is new and task-owned. This marker fences native Windows stores;
    # it never grants takeover based on PID or age.
    marker = Path(state) / OWNER_NAME
    if marker.exists():
        raise ValueError("Docker session folder already has owner metadata")
    publish_evidence(marker, certificate)
    return certificate
