"""Native Windows attestation for the Docker-owned session folder."""
from __future__ import annotations

import ctypes
import stat
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import fullmag_storage as storage

HOST_SCHEMA = "fullmag.windows-folder-host.v1"
OWNER_NAME = ".fullmag-windows-folder-owner.json"
HOST_CERT_PATH = "/run/fullmag/windows-folder-host.json"


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


def attest(state, assembly, engine_id, binary_hashes):
    native = local_volume(state)
    prepare_probe_link(state)
    owner = str(uuid.uuid4())
    payload = (owner + ":" + assembly["image_id"]).encode("ascii")
    import hashlib
    certificate = {"schema": HOST_SCHEMA, "storage_profile": "windows-folder-v1",
                   "role": "session", "owner_scope": "docker-desktop-linux", **native,
                   "owner_token": owner, "engine_id": engine_id,
                   "image_id": assembly["image_id"], "source_commit": assembly["commit"],
                   "binary_hashes": binary_hashes,
                   "artifact_receipt_sha256": assembly["build_receipt_sha256"],
                   "restart_expected_sha256": hashlib.sha256(payload).hexdigest(),
                   "restart_verified": False}
    # The folder is new and task-owned. This marker fences native Windows stores;
    # it never grants takeover based on PID or age.
    marker = Path(state) / OWNER_NAME
    if marker.exists():
        raise ValueError("Docker session folder already has owner metadata")
    publish_evidence(marker, certificate)
    return certificate
