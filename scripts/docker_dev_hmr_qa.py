"""Run one bounded, reversible CSS HMR proof against a live volume DEV group.

The proof creates a nonce-scoped App Router page and CSS module in the selected
checkout, observes one same-page CSS HMR change, and removes only those exact
files under a native CAS check. Existing application sources are never
rewritten. Durable intent, file identities, helper protocol and cleanup
records remain below the BuildControl operation directory.
"""
from __future__ import annotations

import argparse
import base64
from collections.abc import Mapping
from contextlib import contextmanager
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import time
import uuid

import docker_dev_browser_qa as browser_qa
from docker_build_control import (
    BuildControl,
    BuildControlError,
    ControlOutcomeUnknown,
    bounded_capture,
    canonical,
    control_read_script,
    docker_capture,
    mirror_console,
    toolchain_configuration,
)
from docker_compose_identity import source_labels


HMR_SCHEMA = "fullmag.docker-dev-hmr-qa.v1"
HMR_RESULT_SCHEMA = "fullmag.docker-dev-hmr-qa-result.v1"
HMR_PROTOCOL_SCHEMA = "fullmag.docker-dev-hmr-protocol.v1"
HMR_PHASE = "browser-hmr-css"
HMR_SERVICE = "browser-hmr-qa"
HMR_HELPER_PATH = "/state/development/workspace/apps/control-room/scripts/docker-dev-hmr-qa.mjs"
PROBE_PROPERTY = "--fm-docker-hmr-probe"
PROBE_ROUTE_PREFIX = "fullmag-hmr-probe-"
HARNESS_SOURCE_RELATIVES = {
    "runner": "apps/control-room/scripts/docker-dev-hmr-qa.mjs",
    "loopback_proxy": "apps/control-room/scripts/lib/browser-qa-loopback-proxy.mjs",
}
MAX_SOURCE_BYTES = 1024 * 1024
MAX_PROTOCOL_BYTES = 256 * 1024
POLL_SECONDS = 0.20
CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{64}$")
NONCE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{7,63}$")
WINDOWS_PROBE_SHARE_MODE = 0x1  # FILE_SHARE_READ; writers/deleters are fenced.


class ConcurrentProbeEdit(ControlOutcomeUnknown):
    """The temporary probe no longer has the operation's CAS value."""

    def __init__(self, message: str, *, relative: str, observed_sha256: str | None = None):
        super().__init__(message)
        self.relative = relative
        self.observed_sha256 = observed_sha256


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _record_sha256(value: object) -> str:
    return _sha256(canonical(value) + b"\n")


def _file_signature(path: Path) -> dict[str, int]:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise BuildControlError(f"HMR probe file cannot be inspected: {path}") from error
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise BuildControlError("HMR probe path is not an unshared regular file")
    return {
        "device": int(metadata.st_dev),
        "inode": int(metadata.st_ino),
        "size": int(metadata.st_size),
        "mtime_ns": int(metadata.st_mtime_ns),
    }


def _signature(value: object) -> dict[str, int]:
    if not isinstance(value, Mapping) or set(value) != {"device", "inode", "size", "mtime_ns"}:
        raise BuildControlError("HMR probe signature is malformed")
    result: dict[str, int] = {}
    for key in ("device", "inode", "size", "mtime_ns"):
        item = value.get(key)
        if type(item) is not int or item < 0:
            raise BuildControlError("HMR probe signature contains an invalid integer")
        result[key] = item
    return result


def _same_inode_signature(signature: Mapping[str, int]) -> dict[str, int]:
    return {key: int(signature[key]) for key in ("device", "inode")}


def _helper_name(attempt: str) -> str:
    if not isinstance(attempt, str) or re.fullmatch(r"[0-9a-f]{32}", attempt) is None:
        raise BuildControlError("HMR helper attempt identity is malformed")
    return "fullmag-browser-hmr-" + attempt


def _signature_matches(actual: Mapping[str, int], expected: Mapping[str, int]) -> bool:
    allowed = {"device", "inode", "size", "mtime_ns"}
    if set(expected) not in ({"device", "inode"}, allowed):
        raise BuildControlError("HMR probe write signature has an invalid identity shape")
    return all(actual.get(key) == value for key, value in expected.items())


def _read_owned_source(path: Path) -> tuple[bytes, dict[str, int]]:
    """Read one bounded target and prove its name remained one regular inode."""
    before = _file_signature(path)
    try:
        if os.name == "nt":
            from windows_folder_host import read_owned_regular
            data = read_owned_regular(path, maximum=MAX_SOURCE_BYTES)
        else:
            with path.open("rb") as stream:
                data = stream.read(MAX_SOURCE_BYTES + 1)
    except (OSError, ValueError) as error:
        raise BuildControlError(f"HMR probe file read was rejected: {path}") from error
    if not isinstance(data, bytes) or not data or len(data) > MAX_SOURCE_BYTES:
        raise BuildControlError("HMR probe file bytes are empty or exceed the bounded limit")
    after = _file_signature(path)
    if before != after:
        raise ConcurrentProbeEdit("HMR probe file changed while it was being read", relative=str(path))
    return data, after


def _validate_harness_source_hashes(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping) or set(value) != {"algorithm", "runner", "loopback_proxy"}:
        raise BuildControlError("HMR harness source hash pins are malformed")
    if value.get("algorithm") != "sha256":
        raise BuildControlError("HMR harness source hash algorithm differs")
    result: dict[str, str] = {"algorithm": "sha256"}
    for key in ("runner", "loopback_proxy"):
        digest = value.get(key)
        if not isinstance(digest, str) or browser_qa.SHA256_RE.fullmatch(digest) is None:
            raise BuildControlError("HMR harness source hash is malformed")
        result[key] = digest
    return result


def _read_harness_source_hashes(selected: Path) -> dict[str, str]:
    selected = selected.resolve(strict=True)
    if selected.is_symlink() or not selected.is_dir():
        raise BuildControlError("HMR harness source root is not a real directory")
    result: dict[str, str] = {"algorithm": "sha256"}
    for key, relative in HARNESS_SOURCE_RELATIVES.items():
        data, _signature = _read_owned_source(selected / relative)
        result[key] = _sha256(data)
    return _validate_harness_source_hashes(result)


def _harness_source_evidence(before: Mapping[str, object], after: Mapping[str, object]) -> dict[str, object]:
    expected_before = _validate_harness_source_hashes(before)
    expected_after = _validate_harness_source_hashes(after)
    return {
        "algorithm": "sha256",
        "runner_before": expected_before["runner"],
        "runner_after": expected_after["runner"],
        "loopback_proxy_before": expected_before["loopback_proxy"],
        "loopback_proxy_after": expected_after["loopback_proxy"],
        "unchanged": expected_before["runner"] == expected_after["runner"] and expected_before["loopback_proxy"] == expected_after["loopback_proxy"],
    }


def _record_bytes(record: Mapping[str, object], *, expected_state: str, expected_relative: str) -> tuple[bytes, dict[str, int]]:
    if record.get("schema") != HMR_SCHEMA or record.get("state") != expected_state:
        raise BuildControlError("HMR probe file record schema/state differs")
    if record.get("relative") != expected_relative:
        raise BuildControlError("HMR probe file record target differs")
    encoded = record.get("bytes_b64")
    if not isinstance(encoded, str) or len(encoded) > MAX_PROTOCOL_BYTES:
        raise BuildControlError("HMR probe file record bytes are missing or oversized")
    try:
        data = base64.b64decode(encoded.encode("ascii"), validate=True)
    except (ValueError, UnicodeEncodeError) as error:
        raise BuildControlError("HMR probe file record bytes are not valid base64") from error
    if len(data) != record.get("bytes") or _sha256(data) != record.get("sha256"):
        raise BuildControlError("HMR probe file record bytes/hash differ")
    return data, _signature(record.get("signature"))


def _validate_intent_bytes(intent: Mapping[str, object], prefix: str, expected: bytes) -> None:
    key = "page_bytes_b64" if prefix == "page" else prefix + "_b64"
    encoded = intent.get(key)
    if not isinstance(encoded, str):
        raise BuildControlError("HMR probe intent bytes are missing")
    try:
        observed = base64.b64decode(encoded.encode("ascii"), validate=True)
    except (ValueError, UnicodeEncodeError) as error:
        raise BuildControlError("HMR probe intent bytes are not valid base64") from error
    if len(observed) != intent.get(prefix + "_bytes") or observed != expected or _sha256(observed) != intent.get(prefix + "_sha256"):
        raise BuildControlError("HMR probe intent bytes/hash differ")


def _directory_signature(path: Path) -> dict[str, int]:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise BuildControlError(f"HMR probe route cannot be inspected: {path}") from error
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_nlink < 1:
        raise BuildControlError("HMR probe route is not a real directory")
    return {"device": int(metadata.st_dev), "inode": int(metadata.st_ino)}


def _directory_record(*, relative: str, signature: Mapping[str, int], nonce: str) -> dict[str, object]:
    record = {"schema": HMR_SCHEMA, "state": "created-directory", "relative": relative, "nonce": nonce, "signature": dict(signature)}
    if len(canonical(record)) > MAX_PROTOCOL_BYTES:
        raise BuildControlError("HMR probe directory record exceeds its protocol budget")
    return record


def _record_directory(record: Mapping[str, object], *, expected_relative: str, nonce: str) -> dict[str, int]:
    if record.get("schema") != HMR_SCHEMA or record.get("state") != "created-directory" or record.get("relative") != expected_relative or record.get("nonce") != nonce:
        raise BuildControlError("HMR probe directory record identity differs")
    value = record.get("signature")
    if not isinstance(value, Mapping) or set(value) != {"device", "inode"} or any(type(value.get(key)) is not int or value.get(key) < 0 for key in ("device", "inode")):
        raise BuildControlError("HMR probe directory signature is malformed")
    return {"device": int(value["device"]), "inode": int(value["inode"])}


def _source_record(*, state: str, relative: str, data: bytes, signature: Mapping[str, int], nonce: str) -> dict[str, object]:
    if len(data) > MAX_SOURCE_BYTES:
        raise BuildControlError("HMR probe file record exceeds its bounded byte budget")
    record: dict[str, object] = {
        "schema": HMR_SCHEMA,
        "state": state,
        "relative": relative,
        "nonce": nonce,
        "bytes": len(data),
        "sha256": _sha256(data),
        "signature": dict(signature),
        "bytes_b64": base64.b64encode(data).decode("ascii"),
    }
    if len(canonical(record)) > MAX_PROTOCOL_BYTES:
        raise BuildControlError("HMR probe file record exceeds its protocol budget")
    return record


def _route_name(nonce: str) -> str:
    if NONCE_RE.fullmatch(nonce) is None:
        raise BuildControlError("HMR nonce is outside its bounded grammar")
    return PROBE_ROUTE_PREFIX + nonce


def _probe_relatives(nonce: str) -> dict[str, str]:
    route = _route_name(nonce)
    route_base = f"apps/control-room/app/{route}"
    return {
        "route": route_base,
        "page": route_base + "/page.tsx",
        "css": f"apps/control-room/src/design/styles/{route}.module.css",
        "url": "/" + route,
    }


def _probe_paths(selected: Path, nonce: str) -> dict[str, Path | str]:
    selected = selected.resolve(strict=True)
    if selected.is_symlink() or not selected.is_dir():
        raise BuildControlError("HMR source root is not a real directory")
    app = selected / "apps" / "control-room" / "app"
    if app.is_symlink() or not app.is_dir():
        raise BuildControlError("HMR App Router root is not a real directory")
    styles = selected / "apps" / "control-room" / "src" / "design" / "styles"
    if styles.is_symlink() or not styles.is_dir():
        raise BuildControlError("HMR design styles root is not a real directory")
    for root in (app, styles):
        parent = root
        while True:
            if parent.is_symlink():
                raise BuildControlError("HMR probe path traverses a reparse point")
            if parent == selected:
                break
            if selected not in parent.parents:
                raise BuildControlError("HMR probe path escapes the selected source root")
            parent = parent.parent
    relative = _probe_relatives(nonce)
    return {
        **relative,
        "route_path": selected / relative["route"],
        "page_path": selected / relative["page"],
        "css_path": selected / relative["css"],
    }


def _ensure_probe_absent(paths: Mapping[str, object]) -> None:
    for key, label in (("route_path", "nonce route"), ("css_path", "CSS module")):
        path = paths[key]
        if not isinstance(path, Path):
            raise BuildControlError("HMR probe path is malformed")
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise ControlOutcomeUnknown(f"HMR {label} absence could not be authenticated") from error
        if metadata:
            raise BuildControlError(f"HMR {label} already exists; existing source preserved")


def _page_bytes(nonce: str) -> bytes:
    route = _route_name(nonce)
    return (
        "'use client';\n\n"
        'import { useEffect, useRef } from "react";\n'
        'import styles from "@/design/styles/' + route + '.module.css";\n\n'
        'export default function FullmagHmrProbePage() {\n'
        '  const markerRef = useRef<HTMLElement | null>(null);\n'
        '  useEffect(() => {\n'
        '    markerRef.current?.setAttribute("data-fullmag-hmr-client", "ready");\n'
        '  }, []);\n'
        '  return (\n'
        '    <main ref={markerRef} data-fullmag-hmr-probe="' + route + '" data-fullmag-hmr-client="pending" className={styles["fm-hmr-probe"]}>\n'
        '      Fullmag HMR probe\n'
        '    </main>\n'
        '  );\n'
        '}\n'
    ).encode("utf-8")


def _css_bytes() -> bytes:
    return b".fm-hmr-probe {\n  display: block;\n  min-height: 1px;\n}\n"


def _candidate_css_bytes(original: bytes, nonce: str) -> bytes:
    if NONCE_RE.fullmatch(nonce) is None:
        raise BuildControlError("HMR nonce is outside its bounded grammar")
    marker = PROBE_PROPERTY.encode("ascii")
    if marker in original:
        raise BuildControlError("HMR probe property already exists in the temporary CSS module")
    newline = b"\r\n" if b"\r\n" in original else b"\n"
    opening = b".fm-hmr-probe {" + newline
    if original.count(opening) != 1:
        raise BuildControlError("HMR probe CSS module does not have one canonical .fm-hmr-probe entry")
    insertion = b"  " + marker + b": hmr-" + nonce.encode("ascii") + b";" + newline
    result = original.replace(opening, opening + insertion, 1)
    if result == original or result.count(marker) != 1:
        raise BuildControlError("HMR CSS candidate did not contain one bounded probe declaration")
    return result


def _windows_api():
    return ctypes.WinDLL("kernel32", use_last_error=True)


def _windows_final_path(handle: int) -> str:
    from ctypes import wintypes

    api = _windows_api()
    api.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    api.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    for size in (512, 2048, 8192, 32768):
        buffer = ctypes.create_unicode_buffer(size)
        length = api.GetFinalPathNameByHandleW(handle, buffer, size, 0)
        if length == 0:
            raise ctypes.WinError(ctypes.get_last_error())
        if length < size:
            value = buffer.value
            if value.startswith("\\\\?\\UNC\\"):
                value = "\\\\" + value[8:]
            elif value.startswith("\\\\?\\"):
                value = value[4:]
            return os.path.normcase(value.rstrip("\\/"))
    raise BuildControlError("HMR probe final path exceeds the native bounded limit")


@contextmanager
def _open_existing_probe(path: Path):
    """Hold an existing probe inode with an exclusive writer share contract."""
    if os.name == "nt":
        from ctypes import wintypes
        import msvcrt
        from windows_folder_host import _pinned_no_reparse_ancestors

        api = _windows_api()
        api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        api.CreateFileW.restype = wintypes.HANDLE
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        api.CloseHandle.restype = wintypes.BOOL
        invalid = ctypes.c_void_p(-1).value
        with _pinned_no_reparse_ancestors(path.parent):
            handle = api.CreateFileW(str(path), 0xC0000000, 0x1, None, 3, 0x00200000 | 0x80000000, None)
            if handle == invalid:
                raise ctypes.WinError(ctypes.get_last_error())
            fd = None
            try:
                if _windows_final_path(handle) != os.path.normcase(str(path.resolve(strict=True)).rstrip("\\/")):
                    raise BuildControlError("HMR probe handle final path differs from its selected target")
                fd = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
                handle = None
                metadata = os.fstat(fd)
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                    raise BuildControlError("HMR probe handle is not an unshared regular file")
                yield fd
            finally:
                if fd is not None:
                    os.close(fd)
                if handle is not None:
                    api.CloseHandle(handle)
        return
    import fcntl

    fd = os.open(path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise BuildControlError("HMR probe handle is not an unshared regular file")
        yield fd
    finally:
        os.close(fd)


@contextmanager
def _open_new_probe(path: Path):
    """Create one new probe file exclusively after its intent is durable."""
    if os.name == "nt":
        from ctypes import wintypes
        import msvcrt
        from windows_folder_host import _pinned_no_reparse_ancestors

        api = _windows_api()
        api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        api.CreateFileW.restype = wintypes.HANDLE
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        api.CloseHandle.restype = wintypes.BOOL
        invalid = ctypes.c_void_p(-1).value
        with _pinned_no_reparse_ancestors(path.parent):
            handle = api.CreateFileW(str(path), 0xC0000000, 0x1, None, 1, 0x00200000 | 0x80000000, None)
            if handle == invalid:
                error = ctypes.get_last_error()
                if error == 80:
                    raise FileExistsError(error, "HMR probe path already exists", str(path))
                raise ctypes.WinError(error)
            fd = None
            try:
                fd = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
                handle = None
                yield fd
            finally:
                if fd is not None:
                    os.close(fd)
                if handle is not None:
                    api.CloseHandle(handle)
        return
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(path, flags, 0o644)
    try:
        yield fd
    finally:
        os.close(fd)


def _read_fd(fd: int) -> bytes:
    os.lseek(fd, 0, os.SEEK_SET)
    data = os.read(fd, MAX_SOURCE_BYTES + 1)
    if len(data) > MAX_SOURCE_BYTES:
        raise BuildControlError("HMR probe file exceeds its bounded size limit")
    return data


def _write_fd(fd: int, data: bytes) -> None:
    os.lseek(fd, 0, os.SEEK_SET)
    os.ftruncate(fd, 0)
    offset = 0
    while offset < len(data):
        written = os.write(fd, data[offset:])
        if not isinstance(written, int) or written <= 0:
            raise OSError("HMR probe write made no progress")
        offset += written
    os.fsync(fd)


def _create_probe_file(path: Path, data: bytes) -> dict[str, int]:
    try:
        with _open_new_probe(path) as fd:
            _write_fd(fd, data)
            if _read_fd(fd) != data:
                raise ControlOutcomeUnknown("HMR probe creation readback differs; source remains fenced")
            metadata = os.fstat(fd)
            signature = {
                "device": int(metadata.st_dev),
                "inode": int(metadata.st_ino),
                "size": int(metadata.st_size),
                "mtime_ns": int(metadata.st_mtime_ns),
            }
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise BuildControlError("HMR probe creation did not yield an unshared regular file")
            return signature
    except FileExistsError as error:
        raise BuildControlError("HMR probe path collided; existing source preserved") from error
    except ControlOutcomeUnknown:
        raise
    except (BuildControlError, OSError) as error:
        raise ControlOutcomeUnknown("HMR probe creation outcome is unknown; source remains fenced") from error


def _write_probe_locked(
    path: Path,
    expected: bytes,
    expected_signature: Mapping[str, int],
    data: bytes,
    *,
    relative: str,
    write_started: list[bool] | None = None,
) -> dict[str, int]:
    """Update one owned probe inode under one exclusive handle."""
    with _open_existing_probe(path) as fd:
        metadata = os.fstat(fd)
        signature = {
            "device": int(metadata.st_dev),
            "inode": int(metadata.st_ino),
            "size": int(metadata.st_size),
            "mtime_ns": int(metadata.st_mtime_ns),
        }
        current = _read_fd(fd)
        if current != expected or not _signature_matches(signature, expected_signature):
            raise ConcurrentProbeEdit(
                "HMR probe file was edited before the exclusive write; bytes were preserved",
                relative=relative,
                observed_sha256=_sha256(current),
            )
        try:
            if write_started is not None:
                write_started[0] = True
            _write_fd(fd, data)
            if _read_fd(fd) != data:
                raise ControlOutcomeUnknown("HMR probe write readback differs; source remains fenced")
            metadata = os.fstat(fd)
            return {
                "device": int(metadata.st_dev),
                "inode": int(metadata.st_ino),
                "size": int(metadata.st_size),
                "mtime_ns": int(metadata.st_mtime_ns),
            }
        except ControlOutcomeUnknown:
            raise
        except (BuildControlError, OSError) as error:
            raise ControlOutcomeUnknown("HMR probe write outcome is unknown; source remains fenced") from error


def _file_absent(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return True
    except OSError as error:
        raise ControlOutcomeUnknown("HMR probe absence could not be authenticated") from error
    return False


def _absence_probe(path: Path, relative: str) -> str:
    if not _file_absent(path):
        raise ControlOutcomeUnknown(f"HMR probe path remained after cleanup: {relative}")
    return _record_sha256({"relative": relative, "state": "absent"})


def _remove_probe_windows(path: Path, expected: bytes, expected_signature: Mapping[str, int]) -> bool:
    """Delete exactly the identity-checked Windows file handle, never a re-resolved name."""
    from ctypes import wintypes
    import msvcrt
    from windows_folder_host import _pinned_no_reparse_ancestors

    api = _windows_api()
    api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    api.CreateFileW.restype = wintypes.HANDLE
    api.SetFileInformationByHandle.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
    api.SetFileInformationByHandle.restype = wintypes.BOOL
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    api.CloseHandle.restype = wintypes.BOOL
    invalid = ctypes.c_void_p(-1).value
    with _pinned_no_reparse_ancestors(path.parent):
        # Keep the writer/deleter fence while checking the bytes.  Sharing
        # WRITE or DELETE would permit a foreign edit after the CAS read
        # and before SetFileInformationByHandle removes this same inode.
        handle = api.CreateFileW(str(path), 0x80000000 | 0x00010000 | 0x80, WINDOWS_PROBE_SHARE_MODE, None, 3, 0x00200000 | 0x80, None)
        if handle == invalid:
            error = ctypes.get_last_error()
            if error == 2:
                return False
            raise ctypes.WinError(error)
        fd = None
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            handle = None
            metadata = os.fstat(fd)
            signature = {
                "device": int(metadata.st_dev),
                "inode": int(metadata.st_ino),
                "size": int(metadata.st_size),
                "mtime_ns": int(metadata.st_mtime_ns),
            }
            data = _read_fd(fd)
            if data != expected or not _signature_matches(signature, expected_signature):
                raise ConcurrentProbeEdit("HMR probe cleanup observed a foreign edit", relative=str(path), observed_sha256=_sha256(data))
            disposition = ctypes.c_byte(1)
            if not api.SetFileInformationByHandle(msvcrt.get_osfhandle(fd), 4, ctypes.byref(disposition), ctypes.sizeof(disposition)):
                raise OSError(ctypes.get_last_error(), "SetFileInformationByHandle")
            return True
        finally:
            if fd is not None:
                os.close(fd)
            if handle is not None:
                api.CloseHandle(handle)


def _remove_probe_file(path: Path, expected: bytes, expected_signature: Mapping[str, int], relative: str) -> bool:
    if _file_absent(path):
        return False
    if os.name == "nt":
        try:
            return _remove_probe_windows(path, expected, expected_signature)
        except ConcurrentProbeEdit:
            raise
        except (BuildControlError, OSError) as error:
            raise ControlOutcomeUnknown("HMR probe cleanup could not be confirmed; source remains fenced") from error
    parent_fd = None
    fd = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        parent_fd = os.open(path.parent, flags)
        fd = os.open(path.name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0), dir_fd=parent_fd)
        metadata = os.fstat(fd)
        signature = {
            "device": int(metadata.st_dev),
            "inode": int(metadata.st_ino),
            "size": int(metadata.st_size),
            "mtime_ns": int(metadata.st_mtime_ns),
        }
        data = _read_fd(fd)
        if data != expected or not _signature_matches(signature, expected_signature):
            raise ConcurrentProbeEdit("HMR probe cleanup observed a foreign edit", relative=relative, observed_sha256=_sha256(data))
        os.unlink(path.name, dir_fd=parent_fd)
        return True
    except FileNotFoundError:
        return False
    except ConcurrentProbeEdit:
        raise
    except OSError as error:
        raise ControlOutcomeUnknown("HMR probe cleanup could not be confirmed; source remains fenced") from error
    finally:
        if fd is not None:
            os.close(fd)
        if parent_fd is not None:
            os.close(parent_fd)


def _remove_probe_directory(route_path: Path, expected_signature: Mapping[str, int]) -> None:
    if _file_absent(route_path):
        return
    if route_path.is_symlink() or not route_path.is_dir():
        raise ConcurrentProbeEdit("HMR probe route was replaced by a foreign path", relative=str(route_path))
    if not _signature_matches(_directory_signature(route_path), expected_signature):
        raise ConcurrentProbeEdit("HMR probe route identity changed", relative=str(route_path))
    try:
        entries = list(route_path.iterdir())
    except OSError as error:
        raise ControlOutcomeUnknown("HMR probe route contents could not be observed") from error
    if entries:
        raise ConcurrentProbeEdit("HMR probe route contains foreign entries", relative=str(route_path))
    try:
        route_path.rmdir()
    except OSError as error:
        raise ControlOutcomeUnknown("HMR probe route removal was not confirmed") from error
    if not _file_absent(route_path):
        raise ControlOutcomeUnknown("HMR probe route remained after cleanup")


def _cleanup_probe_files(paths: Mapping[str, object], *, attempt: str, route_signature: Mapping[str, int], page_bytes: bytes, page_signature: Mapping[str, int], css_before: bytes, css_candidate: bytes, css_before_signature: Mapping[str, int], css_candidate_signature: Mapping[str, int]) -> dict[str, object]:
    page_path = paths["page_path"]
    css_path = paths["css_path"]
    route_path = paths["route_path"]
    if not all(isinstance(value, Path) for value in (page_path, css_path, route_path)):
        raise BuildControlError("HMR probe cleanup paths are malformed")
    if not _file_absent(route_path) and not _signature_matches(_directory_signature(route_path), route_signature):
        raise ConcurrentProbeEdit("HMR probe route identity changed", relative=str(paths["route"]))
    page_removed = _remove_probe_file(page_path, page_bytes, page_signature, str(paths["page"]))
    css_current, css_current_signature = _read_owned_source(css_path) if not _file_absent(css_path) else (None, None)
    if css_current is None:
        css_removed = False
        css_state = "absent"
    elif css_current == css_before and _signature_matches(css_current_signature, css_before_signature):
        css_removed = _remove_probe_file(css_path, css_before, css_before_signature, str(paths["css"]))
        css_state = "before"
    elif css_current == css_candidate and _signature_matches(css_current_signature, css_candidate_signature):
        css_removed = _remove_probe_file(css_path, css_candidate, css_candidate_signature, str(paths["css"]))
        css_state = "candidate"
    else:
        raise ConcurrentProbeEdit("HMR CSS probe cleanup observed a foreign or partial file", relative=str(paths["css"]), observed_sha256=_sha256(css_current))
    _remove_probe_directory(route_path, route_signature)
    page_absence_probe = _absence_probe(page_path, str(paths["page"]))
    css_absence_probe = _absence_probe(css_path, str(paths["css"]))
    route_absence_probe = _absence_probe(route_path, str(paths["route"]))
    return {
        "schema": HMR_SCHEMA,
        "state": "absent",
        "attempt": attempt,
        "page_removed": page_removed,
        "css_removed": css_removed,
        "css_observed_state": css_state,
        "page_sha256": _sha256(page_bytes),
        "css_before_sha256": _sha256(css_before),
        "css_candidate_sha256": _sha256(css_candidate),
        "page_absence_probe_sha256": page_absence_probe,
        "css_absence_probe_sha256": css_absence_probe,
        "route_absence_probe_sha256": route_absence_probe,
    }


def _cleanup_reconciled_probe_files(
    paths: Mapping[str, object],
    *,
    attempt: str,
    nonce: str,
    route_record: object,
    page_record: object,
    css_record: object,
    css_candidate_record: object,
    css_restored_record: object,
    page_bytes: bytes,
    css_before: bytes,
    css_candidate: bytes,
) -> dict[str, object]:
    """Remove only records with a durable ownership proof during recovery.

    A host can stop between a source mutation and its control-volume record.
    Missing or malformed records therefore preserve that path and make the
    cleanup explicitly NOT VERIFIED; a complete record for another path may
    still be safely reclaimed.  The helper is required to be absent before
    this function is called.
    """
    page_path = paths["page_path"]
    css_path = paths["css_path"]
    route_path = paths["route_path"]
    if not all(isinstance(value, Path) for value in (page_path, css_path, route_path)):
        raise BuildControlError("HMR reconciliation cleanup paths are malformed")
    preserved: list[dict[str, str]] = []

    def preserve(relative: str, reason: str) -> None:
        if not any(item["relative"] == relative for item in preserved):
            preserved.append({"relative": relative, "reason": reason})

    def absent(path: Path, relative: str) -> bool:
        try:
            return _file_absent(path)
        except ControlOutcomeUnknown as error:
            preserve(relative, str(error))
            return False

    page_signature: dict[str, int] | None = None
    if isinstance(page_record, Mapping):
        try:
            page_expected, page_signature = _record_bytes(page_record, expected_state="created", expected_relative=str(paths["page"]))
            if page_expected != page_bytes:
                preserve(str(paths["page"]), "created record bytes differ from intent")
                page_signature = None
        except BuildControlError as error:
            preserve(str(paths["page"]), str(error))
    elif not absent(page_path, str(paths["page"])):
        preserve(str(paths["page"]), "creation record is missing")
    if page_signature is not None:
        try:
            _remove_probe_file(page_path, page_bytes, page_signature, str(paths["page"]))
        except (ConcurrentProbeEdit, ControlOutcomeUnknown) as error:
            preserve(str(paths["page"]), str(error))

    css_states: list[tuple[str, bytes, dict[str, int]]] = []
    if isinstance(css_record, Mapping):
        try:
            created, signature = _record_bytes(css_record, expected_state="created", expected_relative=str(paths["css"]))
            if created == css_before:
                css_states.append(("before", css_before, signature))
            else:
                preserve(str(paths["css"]), "created record bytes differ from intent")
        except BuildControlError as error:
            preserve(str(paths["css"]), str(error))
    if isinstance(css_candidate_record, Mapping):
        try:
            candidate, signature = _record_bytes(css_candidate_record, expected_state="candidate", expected_relative=str(paths["css"]))
            if candidate == css_candidate:
                css_states.append(("candidate", css_candidate, signature))
            else:
                preserve(str(paths["css"]), "candidate record bytes differ from intent")
        except BuildControlError as error:
            preserve(str(paths["css"]), str(error))
    if isinstance(css_restored_record, Mapping):
        try:
            restored_state = css_restored_record.get("state")
            if restored_state not in {"restored", "restored-after-failure"}:
                raise BuildControlError("restored record state differs")
            restored, signature = _record_bytes(css_restored_record, expected_state=restored_state, expected_relative=str(paths["css"]))
            if restored == css_before:
                css_states.append(("before", css_before, signature))
            else:
                preserve(str(paths["css"]), "restored record bytes differ from intent")
        except BuildControlError as error:
            preserve(str(paths["css"]), str(error))
    if not isinstance(css_record, Mapping) and not isinstance(css_candidate_record, Mapping) and not isinstance(css_restored_record, Mapping):
        if not absent(css_path, str(paths["css"])):
            preserve(str(paths["css"]), "CSS ownership records are missing")
    else:
        try:
            if not _file_absent(css_path):
                current, current_signature = _read_owned_source(css_path)
                match = next(((label, expected, signature) for label, expected, signature in css_states
                              if current == expected and _signature_matches(current_signature, signature)), None)
                if match is None:
                    preserve(str(paths["css"]), "CSS bytes or inode are not a recorded operation value")
                else:
                    try:
                        _remove_probe_file(css_path, match[1], match[2], str(paths["css"]))
                    except (ConcurrentProbeEdit, ControlOutcomeUnknown) as error:
                        preserve(str(paths["css"]), str(error))
        except (BuildControlError, ControlOutcomeUnknown) as error:
            preserve(str(paths["css"]), str(error))

    route_signature: dict[str, int] | None = None
    if isinstance(route_record, Mapping):
        try:
            route_signature = _record_directory(route_record, expected_relative=str(paths["route"]), nonce=nonce)
        except BuildControlError as error:
            preserve(str(paths["route"]), str(error))
    elif not absent(route_path, str(paths["route"])):
        preserve(str(paths["route"]), "directory creation record is missing")
    if route_signature is not None and not absent(route_path, str(paths["route"])):
        try:
            _remove_probe_directory(route_path, route_signature)
        except (ConcurrentProbeEdit, ControlOutcomeUnknown) as error:
            preserve(str(paths["route"]), str(error))

    absence: dict[str, str] = {}
    for path, relative, key in ((page_path, str(paths["page"]), "page_absence_probe_sha256"),
                                (css_path, str(paths["css"]), "css_absence_probe_sha256"),
                                (route_path, str(paths["route"]), "route_absence_probe_sha256")):
        if relative not in {item["relative"] for item in preserved} and absent(path, relative):
            absence[key] = _record_sha256({"relative": relative, "state": "absent"})
    return {
        "schema": HMR_SCHEMA,
        "state": "absent" if not preserved and len(absence) == 3 else "not-verified",
        "attempt": attempt,
        "cleanup_not_verified": bool(preserved),
        "preserved_paths": preserved,
        **absence,
    }


def _validate_nonce(value: object) -> str:
    if not isinstance(value, str) or NONCE_RE.fullmatch(value) is None:
        raise BuildControlError("HMR protocol nonce is malformed")
    return value


def _validate_protocol_record(record: object, *, attempt: str, state: str, nonce: str | None = None) -> Mapping[str, object]:
    if not isinstance(record, Mapping):
        raise BuildControlError("HMR helper protocol record is not an object")
    if record.get("schema") != HMR_PROTOCOL_SCHEMA or record.get("attempt") != attempt or record.get("state") != state:
        raise BuildControlError("HMR helper protocol identity/state differs")
    if nonce is not None and record.get("nonce") != nonce:
        raise BuildControlError("HMR helper protocol nonce differs")
    return record


def _validate_harness_ready(record: Mapping[str, object], expected: Mapping[str, object]) -> None:
    expected_hashes = _validate_harness_source_hashes(expected)
    value = record.get("harness_source_sha256")
    if not isinstance(value, Mapping) or set(value) != {"algorithm", "runner_before", "loopback_proxy_before"}:
        raise BuildControlError("HMR helper ready record lacks exact harness source before hashes")
    if value.get("algorithm") != "sha256" or value.get("runner_before") != expected_hashes["runner"] or value.get("loopback_proxy_before") != expected_hashes["loopback_proxy"]:
        raise BuildControlError("HMR helper ready harness source hashes differ")


def _validate_success_diagnostics(record: Mapping[str, object]) -> None:
    """Reject a helper success that still contains a late browser failure."""
    diagnostics = record.get("diagnostics")
    if not isinstance(diagnostics, Mapping):
        raise BuildControlError("HMR helper terminal lacks browser diagnostics")
    hmr = diagnostics.get("hmr")
    if (not isinstance(hmr, Mapping)
            or diagnostics.get("pageerrors") != []
            or hmr.get("connected") is not True
            or hmr.get("synced") is not True
            or hmr.get("building") is not False
            or type(hmr.get("closed")) is not bool
            or hmr.get("intentional_close") is not True
            or hmr.get("errors") != []
            or hmr.get("failure") is not None):
        raise BuildControlError("HMR helper success contains incomplete or failed browser diagnostics")


def _validate_harness_terminal(record: Mapping[str, object], expected: Mapping[str, object]) -> None:
    expected_hashes = _validate_harness_source_hashes(expected)
    value = record.get("harness_source_sha256")
    if not isinstance(value, Mapping) or set(value) != {"algorithm", "runner_before", "runner_after", "loopback_proxy_before", "loopback_proxy_after", "unchanged"}:
        raise BuildControlError("HMR helper terminal lacks exact harness source before/after hashes")
    if (value.get("algorithm") != "sha256" or value.get("runner_before") != expected_hashes["runner"]
            or value.get("runner_after") != expected_hashes["runner"]
            or value.get("loopback_proxy_before") != expected_hashes["loopback_proxy"]
            or value.get("loopback_proxy_after") != expected_hashes["loopback_proxy"]
            or value.get("unchanged") is not True):
        raise BuildControlError("HMR helper terminal harness source hashes differ")


def _validate_observation(record: object, *, attempt: str, state: str, nonce: str, baseline: Mapping[str, object], expected_property: str, route_path: str) -> Mapping[str, object]:
    value = _validate_protocol_record(record, attempt=attempt, state=state, nonce=nonce)
    if value.get("property") != expected_property or value.get("route_path") != route_path:
        raise BuildControlError("HMR helper observed the wrong route/property")
    if value.get("navigation_count") != 0:
        raise BuildControlError("HMR helper navigated the probe page during the proof")
    for key in ("session", "dom", "document_token"):
        if value.get(key) != baseline.get(key):
            raise BuildControlError(f"HMR helper changed {key} identity")
    return value


def _wait_for_record(control: BuildControl, relative: str, timeout: int) -> object:
    directory, separator, filename = relative.rpartition("/")
    sibling_terminal = f"{directory}/helper-terminal.json" if separator and filename != "helper-terminal.json" else None
    components = relative.split("/")
    expected_attempt = None
    if "attempts" in components:
        index = components.index("attempts")
        if index + 1 < len(components):
            expected_attempt = components[index + 1]
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = control.read(relative, optional=True)
        if value is not None:
            return value
        if sibling_terminal is not None:
            terminal = control.read(sibling_terminal, optional=True)
            if (isinstance(terminal, Mapping)
                    and terminal.get("schema") == HMR_PROTOCOL_SCHEMA
                    and terminal.get("state") == "failed-confirmed"
                    and (expected_attempt is None or terminal.get("attempt") == expected_attempt)):
                detail = str(terminal.get("error", "helper terminal reported failed-confirmed"))[:512]
                raise ControlOutcomeUnknown(
                    f"HMR helper terminal failed while waiting for durable record {relative}: {detail}; resources retained"
                )
        time.sleep(POLL_SECONDS)
    raise ControlOutcomeUnknown(f"Timed out waiting for durable HMR record {relative}; resources retained")


def _control_subpath_from_inspect(document: Mapping[str, object], target: str) -> str | None:
    host = document.get("HostConfig")
    mounts = host.get("Mounts") if isinstance(host, Mapping) else None
    if not isinstance(mounts, list):
        return None
    matches = [item for item in mounts if isinstance(item, Mapping) and item.get("Target") == target]
    if len(matches) != 1:
        return None
    options = matches[0].get("VolumeOptions")
    if not isinstance(options, Mapping):
        return None
    value = options.get("Subpath", options.get("SubPath", options.get("subpath")))
    return value if isinstance(value, str) else None


def _validate_hmr_helper(document: Mapping[str, object], control: BuildControl, identity: Mapping[str, str], frontend_volume: str, browser_image_id: str, selected: Path, expected_subpath: str, expected_route_path: str, expected_attempt: str, expected_harness_source_hashes: Mapping[str, object], *, require_running: bool = True) -> None:
    try:
        browser_qa.validate_source_labels(document, identity)
    except ValueError as error:
        raise ControlOutcomeUnknown(f"HMR helper source identity differs: {error}") from error
    config = document.get("Config")
    host = document.get("HostConfig")
    network_settings = document.get("NetworkSettings")
    state = document.get("State")
    if not isinstance(config, Mapping) or not isinstance(host, Mapping) or not isinstance(network_settings, Mapping) or not isinstance(state, Mapping):
        raise ControlOutcomeUnknown("HMR helper inspect document is incomplete")
    if require_running and state.get("Running") is not True:
        raise ControlOutcomeUnknown("HMR helper is not in the admitted running state")
    labels = config.get("Labels") or {}
    if labels.get("com.docker.compose.project") != control.project or labels.get("com.docker.compose.service") != HMR_SERVICE:
        raise ControlOutcomeUnknown("HMR helper service identity differs")
    if document.get("Image") != browser_image_id or config.get("User") != "65532:65532":
        raise ControlOutcomeUnknown("HMR helper image/user identity differs")
    required_environment = {
        "CONTROL_ROOM_URL=http://frontend:8080",
        "NVIDIA_VISIBLE_DEVICES=void",
        "CONTROL_ROOM_HMR_PROTOCOL=" + HMR_PROTOCOL_SCHEMA,
        "CONTROL_ROOM_HMR_ATTEMPT=" + expected_attempt,
        "CONTROL_ROOM_HMR_ROUTE_PATH=" + expected_route_path,
        "CONTROL_ROOM_HMR_HARNESS_SOURCE_SHA256=" + canonical(_validate_harness_source_hashes(expected_harness_source_hashes)).decode("utf-8"),
    }
    if required_environment - set(config.get("Env") or []):
        raise ControlOutcomeUnknown("HMR helper protocol environment differs")
    if (host.get("ReadonlyRootfs") is not True or host.get("NetworkMode") in {"host", "none"}
            or host.get("ExtraHosts") or host.get("Privileged") is True):
        raise ControlOutcomeUnknown("HMR helper isolation differs")
    if host.get("PortBindings") or (network_settings.get("Ports") or {}):
        raise ControlOutcomeUnknown("HMR helper unexpectedly publishes a port")
    if host.get("DeviceRequests") not in (None, []):
        raise ControlOutcomeUnknown("HMR helper unexpectedly requests a device")
    if "ALL" not in set(host.get("CapDrop") or []) or "no-new-privileges:true" not in set(host.get("SecurityOpt") or []):
        raise ControlOutcomeUnknown("HMR helper lacks capability/security fencing")
    if set(host.get("Tmpfs") or {}) != {"/tmp"}:
        raise ControlOutcomeUnknown("HMR helper temporary filesystem differs")
    if set(network_settings.get("Networks") or {}) != {identity["network_name"]}:
        raise ControlOutcomeUnknown("HMR helper is outside the selected private network")
    mounts = document.get("Mounts") or []
    if not isinstance(mounts, list):
        raise ControlOutcomeUnknown("HMR helper mounts are malformed")
    by_target = {mount.get("Destination"): mount for mount in mounts if isinstance(mount, Mapping)}
    expected_targets = {"/state/development", "/state/development/workspace/apps/control-room/scripts", "/control"}
    if set(by_target) != expected_targets:
        raise ControlOutcomeUnknown("HMR helper mount boundary differs")
    state_mount = by_target["/state/development"]
    script_mount = by_target["/state/development/workspace/apps/control-room/scripts"]
    control_mount = by_target["/control"]
    if state_mount.get("Type") != "volume" or state_mount.get("Name") != frontend_volume or state_mount.get("RW") is not False:
        raise ControlOutcomeUnknown("HMR helper frontend state mount is not readonly")
    if script_mount.get("Type") != "bind" or script_mount.get("RW") is not False or browser_qa._mount_path(script_mount.get("Source")) != browser_qa._mount_path(selected / "apps/control-room/scripts"):
        raise ControlOutcomeUnknown("HMR helper scripts mount is not the readonly selected source")
    if control_mount.get("Type") != "volume" or control_mount.get("Name") != control.volume or control_mount.get("RW") is not True:
        raise ControlOutcomeUnknown("HMR helper control mount is not the selected writable subpath")
    if _control_subpath_from_inspect(document, "/control") != expected_subpath:
        raise ControlOutcomeUnknown("HMR helper control mount does not prove its exact volume subpath")
    if any(target != "/control" and mount.get("RW") is not False for target, mount in by_target.items()):
        raise ControlOutcomeUnknown("HMR helper has a writable source/frontend mount")


def _compose_document(selected: Path, identity: Mapping[str, str], browser_image: str, frontend_volume: str, control: BuildControl, control_subpath: str, port: int, timeout: int, attempt: str, route_path: str, harness_source_hashes: Mapping[str, object]) -> dict[str, object]:
    expected_harness_source_hashes = _validate_harness_source_hashes(harness_source_hashes)
    labels = {**source_labels(identity), "org.fullmag.browser-hmr-qa.schema": HMR_SCHEMA}
    environment = {
        "HOME": "/tmp",
        "LANG": "C.UTF-8",
        "NODE_ENV": "test",
        "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
        "CONTROL_ROOM_URL": "http://frontend:8080",
        "CONTROL_ROOM_PUBLIC_URL": f"http://127.0.0.1:{port}",
        "CONTROL_ROOM_EXPECTED_PLAYWRIGHT_VERSION": browser_qa.PLAYWRIGHT_VERSION,
        "CONTROL_ROOM_HMR_PROTOCOL": HMR_PROTOCOL_SCHEMA,
        "CONTROL_ROOM_HMR_ATTEMPT": attempt,
        "CONTROL_ROOM_HMR_ROUTE_PATH": route_path,
        "CONTROL_ROOM_HMR_HARNESS_SOURCE_SHA256": canonical(expected_harness_source_hashes).decode("utf-8"),
        "CONTROL_ROOM_HMR_TIMEOUT_MS": str(timeout * 1000),
        "CONTROL_ROOM_HMR_MAX_BYTES": str(MAX_PROTOCOL_BYTES),
        "CONTROL_ROOM_BROWSER_GPU_MODE": "swiftshader-webgl-requested",
        "NVIDIA_VISIBLE_DEVICES": "void",
    }
    return {
        "name": identity["project_name"],
        "services": {
            HMR_SERVICE: {
                "image": browser_image,
                "pull_policy": "never",
                "labels": labels,
                "read_only": True,
                "init": True,
                "restart": "no",
                "cap_drop": ["ALL"],
                "security_opt": ["no-new-privileges:true"],
                "pids_limit": 256,
                "mem_limit": "2g",
                "cpus": 2,
                "shm_size": "256m",
                "logging": {"driver": "none"},
                "environment": environment,
                "user": "65532:65532",
                "working_dir": "/state/development/workspace/apps/control-room",
                "command": ["node", HMR_HELPER_PATH],
                "volumes": [
                    {"type": "volume", "source": "frontend-state", "target": "/state/development", "read_only": True, "volume": {"nocopy": True}},
                    {"type": "bind", "source": str(selected / "apps/control-room/scripts"), "target": "/state/development/workspace/apps/control-room/scripts", "read_only": True, "bind": {"create_host_path": False}},
                    {"type": "volume", "source": "build-control", "target": "/control", "read_only": False, "volume": {"nocopy": True, "subpath": control_subpath}},
                ],
                "tmpfs": ["/tmp:rw,nosuid,nodev,size=256m"],
                "networks": {"fullmag": {"aliases": [HMR_SERVICE]}},
            }
        },
        "volumes": {
            "frontend-state": {"name": frontend_volume, "external": True},
            "build-control": {"name": control.volume, "external": True},
        },
        "networks": {"fullmag": {"name": identity["network_name"], "external": True}},
    }


def _browser_image_admission_document(document: Mapping[str, object]) -> dict[str, object]:
    services = document.get("services")
    helper = services.get(HMR_SERVICE) if isinstance(services, Mapping) else None
    if not isinstance(helper, Mapping):
        raise BuildControlError("HMR image admission document has no helper service")
    return {**document, "services": {"browser-qa": dict(helper)}}


def _start_helper(operation: dict[str, object], control: BuildControl, document: Mapping[str, object], identity: Mapping[str, str], frontend_volume: str, browser_image_id: str, selected: Path, control_subpath: str, route_path: str, harness_source_hashes: Mapping[str, object]) -> str:
    attempt = operation["receipt"]["attempt"]
    helper_name = _helper_name(attempt)
    operation["daemon_pending"] = True
    operation["receipt"].update(
        browser_container_name=helper_name,
        browser_image_id=browser_image_id,
        helper_exchange_relative=operation["root"] + "/exchange",
        helper_control_subpath=control_subpath,
    )
    control.write(operation["root"] + "/receipt.json", operation["receipt"])
    name_absence_probe = _confirmed_helper_absence(helper_name)
    operation["receipt"]["browser_container_name_absence_probe_sha256"] = name_absence_probe
    control.write(operation["root"] + "/receipt.json", operation["receipt"])
    result = docker_capture("compose", "--project-name", control.project, "--ansi", "never", "-f", "-", "run", "-d", "-T", "--no-deps", "--name", helper_name, HMR_SERVICE, data=canonical(document), timeout=90, allow_failure=True)
    if result.returncode:
        raise BuildControlError("HMR browser helper could not be started")
    values = [line.strip() for line in result.stdout.decode("utf-8", "replace").splitlines() if line.strip()]
    helper_id = values[-1] if values else ""
    if not CONTAINER_ID_RE.fullmatch(helper_id):
        raise ControlOutcomeUnknown("HMR helper start returned no full container identity")
    observed = browser_qa._inspect(helper_id)
    if observed.get("Name") not in {"/" + helper_name, helper_name}:
        raise ControlOutcomeUnknown("HMR helper deterministic name differs")
    _validate_hmr_helper(observed, control, identity, frontend_volume, browser_image_id, selected, control_subpath, route_path, operation["receipt"]["attempt"], harness_source_hashes)
    operation["receipt"].update(browser_container_name=helper_name, browser_container_id=helper_id, browser_image_id=browser_image_id, helper_exchange_relative=operation["root"] + "/exchange", helper_control_subpath=control_subpath, state="running")
    control.write(operation["root"] + "/receipt.json", operation["receipt"])
    return helper_id


def _confirmed_helper_absence(helper_id: str) -> str:
    from docker_volume_activation_reconcile import _probe_helper_absence

    try:
        probe = _probe_helper_absence(helper_id)
    except Exception as error:
        raise ControlOutcomeUnknown("HMR helper absence could not be authenticated") from error
    if not isinstance(probe, str) or not probe:
        raise ControlOutcomeUnknown("HMR helper inspect did not prove absence")
    return probe


def _wait_browser_helper(helper_id: str, *, expected_exit_codes: set[int]) -> int:
    result = docker_capture("wait", helper_id, timeout=90, allow_failure=True)
    if result.returncode:
        raise ControlOutcomeUnknown("HMR browser helper exit could not be observed; resources retained")
    try:
        exit_code = int(result.stdout.decode("utf-8").strip())
    except (UnicodeDecodeError, ValueError) as error:
        raise ControlOutcomeUnknown("HMR browser helper returned no canonical exit code") from error
    if exit_code not in expected_exit_codes:
        raise ControlOutcomeUnknown("HMR browser helper exit differs from its durable terminal")
    return exit_code


def _remove_helper(operation: dict[str, object], helper_id: str, helper_name: str) -> str:
    operation["daemon_pending"] = True
    try:
        if _wait_browser_helper(helper_id, expected_exit_codes={0}) != 0:
            raise ControlOutcomeUnknown("HMR browser helper returned a non-success exit")
        docker_capture("rm", helper_id, timeout=90, allow_failure=True)
        id_absence_probe = _confirmed_helper_absence(helper_id)
        name_absence_probe = _confirmed_helper_absence(helper_name)
    except (BuildControlError, ControlOutcomeUnknown) as error:
        raise ControlOutcomeUnknown("HMR helper removal was not confirmed; resources retained") from error
    return _record_sha256({
        "container_id": helper_id,
        "container_absence_probe_sha256": id_absence_probe,
        "container_name": helper_name,
        "container_name_absence_probe_sha256": name_absence_probe,
    })


def _write_command(control: BuildControl, root: str, *, attempt: str, state: str, nonce: str, source_sha256: str) -> None:
    control.write(root + "/command.json", {"schema": HMR_PROTOCOL_SCHEMA, "attempt": attempt, "state": state, "nonce": nonce, "source_sha256": source_sha256})


def _validate_live_fence(control: BuildControl, current: Mapping[str, object]) -> None:
    live = control.read("development/current.json")
    if _sha256(canonical(live)) != current.get("development_fence_sha256"):
        raise ControlOutcomeUnknown("Live development receipt changed during HMR proof")


def _app_service_runtime_fence(backend_id: str, frontend_id: str) -> dict[str, object]:
    services: dict[str, object] = {}
    for name, container_id in (("backend", backend_id), ("frontend", frontend_id)):
        document = browser_qa._inspect(container_id)
        state = document.get("State")
        observed_id = document.get("Id")
        if not isinstance(state, Mapping) or state.get("Running") is not True or not isinstance(observed_id, str) or observed_id != container_id:
            raise ControlOutcomeUnknown(f"HMR {name} container runtime identity is incomplete")
        started_at = state.get("StartedAt")
        restart_count = document.get("RestartCount")
        if not isinstance(started_at, str) or not started_at or type(restart_count) is not int or restart_count < 0:
            raise ControlOutcomeUnknown(f"HMR {name} container runtime fence is malformed")
        services[name] = {"container_id": observed_id, "started_at": started_at, "restart_count": restart_count}
    return services


def _validate_app_service_runtime_fence(before: Mapping[str, object], after: Mapping[str, object], backend_id: str, frontend_id: str) -> None:
    for name, expected_id in (("backend", backend_id), ("frontend", frontend_id)):
        first = before.get(name)
        second = after.get(name)
        if not isinstance(first, Mapping) or not isinstance(second, Mapping):
            raise ControlOutcomeUnknown(f"HMR {name} runtime fence is incomplete")
        if (first.get("container_id") != expected_id or second.get("container_id") != expected_id
                or first.get("started_at") != second.get("started_at")
                or first.get("restart_count") != second.get("restart_count")):
            raise ControlOutcomeUnknown(f"HMR {name} restarted or changed during the proof")


def _create_probe(operation: dict[str, object], control: BuildControl, paths: Mapping[str, object], identity: Mapping[str, str], nonce: str, page_bytes: bytes, css_before: bytes, css_candidate: bytes) -> tuple[dict[str, int], dict[str, int], dict[str, int]]:
    route_path = paths["route_path"]
    page_path = paths["page_path"]
    css_path = paths["css_path"]
    if not all(isinstance(value, Path) for value in (route_path, page_path, css_path)):
        raise BuildControlError("HMR probe creation paths are malformed")
    operation["daemon_pending"] = True
    _ensure_probe_absent(paths)
    try:
        if os.name == "nt":
            from windows_folder_host import _pinned_no_reparse_ancestors
            with _pinned_no_reparse_ancestors(route_path.parent):
                route_path.mkdir(mode=0o755)
        else:
            route_path.mkdir(mode=0o755)
    except FileExistsError as error:
        raise BuildControlError("HMR nonce route collided; existing source preserved") from error
    except OSError as error:
        raise ControlOutcomeUnknown("HMR probe route creation outcome is unknown") from error
    if route_path.is_symlink() or not route_path.is_dir():
        raise ControlOutcomeUnknown("HMR probe route creation did not yield a real directory")
    route_signature = _directory_signature(route_path)
    control.write(operation["root"] + "/route-created.json", _directory_record(relative=str(paths["route"]), signature=route_signature, nonce=nonce))
    page_signature = _create_probe_file(page_path, page_bytes)
    control.write(operation["root"] + "/page-created.json", _source_record(state="created", relative=str(paths["page"]), data=page_bytes, signature=page_signature, nonce=nonce))
    css_signature = _create_probe_file(css_path, css_before)
    control.write(operation["root"] + "/css-created.json", _source_record(state="created", relative=str(paths["css"]), data=css_before, signature=css_signature, nonce=nonce))
    return route_signature, page_signature, css_signature


def _run_hmr(operation: dict[str, object], control: BuildControl, document: Mapping[str, object], identity: Mapping[str, str], selected: Path, current: Mapping[str, object], frontend_id: str, frontend_volume: str, browser_image_id: str, public_url: str, port: int, paths: Mapping[str, object], page_bytes: bytes, css_before: bytes, css_candidate: bytes, nonce: str, timeout: int, control_subpath: str, harness_source_hashes: Mapping[str, object]) -> None:
    root = operation["root"]
    exchange = root + "/exchange"
    attempt = operation["receipt"]["attempt"]
    route_path = str(paths["url"])
    css_path = paths["css_path"]
    if not isinstance(css_path, Path):
        raise BuildControlError("HMR CSS probe path is malformed")
    helper_id: str | None = None
    helper_removed = False
    css_candidate_published = False
    css_write_started = [False]
    css_candidate_signature: Mapping[str, int] | None = None
    css_restored_signature: Mapping[str, int] | None = None
    restored = False
    terminal: Mapping[str, object] | None = None
    operation["daemon_pending"] = False
    control.write(root + "/compose.json", document)
    owner = {key: identity[key] for key in ("project_id", "worktree_id", "checkout_kind", "source_root")}
    control.write(root + "/probe-intent.json", {
        "schema": HMR_SCHEMA,
        "state": "creation-intent",
        "attempt": attempt,
        "nonce": nonce,
        "route_relative": paths["route"],
        "page_relative": paths["page"],
        "css_relative": paths["css"],
        "route_path": route_path,
        "owner": owner,
        "page_bytes": len(page_bytes),
        "page_sha256": _sha256(page_bytes),
        "page_bytes_b64": base64.b64encode(page_bytes).decode("ascii"),
        "css_before_bytes": len(css_before),
        "css_before_sha256": _sha256(css_before),
        "css_before_b64": base64.b64encode(css_before).decode("ascii"),
        "css_candidate_bytes": len(css_candidate),
        "css_candidate_sha256": _sha256(css_candidate),
        "css_candidate_b64": base64.b64encode(css_candidate).decode("ascii"),
        "harness_source_sha256": _validate_harness_source_hashes(harness_source_hashes),
        "verification": "NOT VERIFIED",
    })
    public_probe = browser_qa._probe_public_loopback(public_url, min(timeout, 30))
    control.write(root + "/public-loopback-probe.json", public_probe)
    if public_probe.get("state") != "passed":
        raise BuildControlError("HMR selected frontend loopback probe failed")
    operation["receipt"].update(
        browser_container_name=_helper_name(attempt),
        browser_image_id=browser_image_id,
        helper_exchange_relative=exchange,
        helper_control_subpath=control_subpath,
    )
    control.write(root + "/receipt.json", operation["receipt"])
    try:
        route_signature, page_signature, css_created_signature = _create_probe(operation, control, paths, identity, nonce, page_bytes, css_before, css_candidate)
        control.write(root + "/css-candidate-plan.json", _source_record(state="candidate-plan", relative=str(paths["css"]), data=css_candidate, signature=css_created_signature, nonce=nonce))
        backend_id = operation["receipt"].get("inputs", {}).get("backend_container")
        if not isinstance(backend_id, str) or not CONTAINER_ID_RE.fullmatch(backend_id):
            raise BuildControlError("HMR operation has no pinned backend container")
        app_runtime_before = _app_service_runtime_fence(backend_id, frontend_id)
        operation["receipt"].update(app_service_runtime_before=app_runtime_before)
        control.write(root + "/receipt.json", operation["receipt"])
        helper_id = _start_helper(operation, control, document, identity, frontend_volume, browser_image_id, selected, control_subpath, route_path, harness_source_hashes)
        ready = _validate_protocol_record(_wait_for_record(control, exchange + "/helper-ready.json", timeout), attempt=attempt, state="ready")
        _validate_harness_ready(ready, harness_source_hashes)
        if ready.get("property") != "" or ready.get("route_path") != route_path or ready.get("navigation_count") != 0:
            raise BuildControlError("HMR helper baseline is not empty/stable")
        baseline = {key: ready.get(key) for key in ("session", "dom", "document_token")}
        css_candidate_signature = _write_probe_locked(css_path, css_before, css_created_signature, css_candidate, relative=str(paths["css"]), write_started=css_write_started)
        css_candidate_published = True
        control.write(root + "/css-candidate.json", _source_record(state="candidate", relative=str(paths["css"]), data=css_candidate, signature=css_candidate_signature, nonce=nonce))
        _write_command(control, exchange, attempt=attempt, state="candidate", nonce=nonce, source_sha256=_sha256(css_candidate))
        candidate_observation = _wait_for_record(control, exchange + "/helper-candidate.json", timeout)
        _validate_observation(candidate_observation, attempt=attempt, state="candidate-verified", nonce=nonce, baseline=baseline, expected_property="hmr-" + nonce, route_path=route_path)
        css_restored_signature = _write_probe_locked(css_path, css_candidate, css_candidate_signature, css_before, relative=str(paths["css"]), write_started=None)
        restored = True
        control.write(root + "/css-restored.json", _source_record(state="restored", relative=str(paths["css"]), data=css_before, signature=css_restored_signature, nonce=nonce))
        _write_command(control, exchange, attempt=attempt, state="restore", nonce=nonce, source_sha256=_sha256(css_before))
        restore_observation = _wait_for_record(control, exchange + "/helper-restore.json", timeout)
        _validate_observation(restore_observation, attempt=attempt, state="restore-verified", nonce=nonce, baseline=baseline, expected_property="", route_path=route_path)
        terminal = _validate_protocol_record(_wait_for_record(control, exchange + "/helper-terminal.json", timeout), attempt=attempt, state="succeeded", nonce=nonce)
        _validate_harness_terminal(terminal, harness_source_hashes)
        _validate_success_diagnostics(terminal)
        helper_ready_sha256 = _record_sha256(ready)
        helper_candidate_sha256 = _record_sha256(candidate_observation)
        helper_restore_sha256 = _record_sha256(restore_observation)
        helper_terminal_sha256 = _record_sha256(terminal)
        helper_evidence_sha256 = _record_sha256({
            "ready": ready,
            "candidate": candidate_observation,
            "restore": restore_observation,
            "terminal": terminal,
        })
        _validate_live_fence(control, current)
        frontend_after = browser_qa._inspect(frontend_id)
        browser_qa._validate_frontend(frontend_after, control, identity, frontend_volume, current, port)
        helper_absence_probe = _remove_helper(operation, helper_id, _helper_name(attempt))
        helper_removed = True
        operation["receipt"].update(browser_helper_absence_probe_sha256=helper_absence_probe)
        control.write(root + "/helper-absence.json", {
            "schema": HMR_SCHEMA,
            "state": "absent",
            "attempt": attempt,
            "container_name": _helper_name(attempt),
            "absence_probe_sha256": helper_absence_probe,
        })
        control.write(root + "/receipt.json", operation["receipt"])
        browser_qa._validate_live_network(backend_id, frontend_id, control.project, port)
        app_runtime_after = _app_service_runtime_fence(backend_id, frontend_id)
        _validate_app_service_runtime_fence(app_runtime_before, app_runtime_after, backend_id, frontend_id)
        harness_source_after = _read_harness_source_hashes(selected)
        if harness_source_after != _validate_harness_source_hashes(harness_source_hashes):
            control.write(root + "/harness-source-drift.json", {"schema": HMR_SCHEMA, "state": "source-drift-preserved", "attempt": attempt, "before": dict(harness_source_hashes), "after": harness_source_after, "verification": "NOT VERIFIED"})
            raise ControlOutcomeUnknown("HMR harness source changed after helper exit; result remains unknown")
        harness_source_evidence = _harness_source_evidence(harness_source_hashes, harness_source_after)
        cleanup = _cleanup_probe_files(paths, attempt=attempt, route_signature=route_signature, page_bytes=page_bytes, page_signature=page_signature, css_before=css_before, css_candidate=css_candidate, css_before_signature=css_restored_signature, css_candidate_signature=css_candidate_signature)
        control.write(root + "/cleanup.json", cleanup)
        after_state = {"page": "absent", "css": "absent", "route": "absent"}
        result = {
            "schema": HMR_RESULT_SCHEMA,
            "state": "succeeded",
            "attempt": attempt,
            "nonce": nonce,
            "route_path": route_path,
            "page_relative": paths["page"],
            "css_relative": paths["css"],
            "page_before_sha256": _sha256(page_bytes),
            "page_after_cleanup_sha256": None,
            "css_before_sha256": _sha256(css_before),
            "css_candidate_sha256": _sha256(css_candidate),
            "css_after_cleanup_sha256": None,
            "page_absence_probe_sha256": cleanup["page_absence_probe_sha256"],
            "css_absence_probe_sha256": cleanup["css_absence_probe_sha256"],
            "route_absence_probe_sha256": cleanup["route_absence_probe_sha256"],
            "after_state": after_state,
            "candidate": candidate_observation,
            "restore": restore_observation,
            "terminal": terminal,
            "helper_ready_sha256": helper_ready_sha256,
            "helper_candidate_sha256": helper_candidate_sha256,
            "helper_restore_sha256": helper_restore_sha256,
            "helper_terminal_sha256": helper_terminal_sha256,
            "helper_evidence_sha256": helper_evidence_sha256,
            "helper_absence_probe_sha256": helper_absence_probe,
            "harness_source_sha256": harness_source_evidence,
            "app_service_runtime": {"before": app_runtime_before, "after": app_runtime_after},
            "cleanup": cleanup,
        }
        control.write(root + "/result.json", result)
        operation["receipt"].update(state="succeeded", exit_code=0, result_schema=HMR_RESULT_SCHEMA, verification="HMR_OBSERVED_SAME_PAGE_AND_CLEANED", page_before_sha256=_sha256(page_bytes), page_after_cleanup_sha256=None, css_before_sha256=_sha256(css_before), css_candidate_sha256=_sha256(css_candidate), css_after_cleanup_sha256=None, page_absence_probe_sha256=cleanup["page_absence_probe_sha256"], css_absence_probe_sha256=cleanup["css_absence_probe_sha256"], route_absence_probe_sha256=cleanup["route_absence_probe_sha256"], helper_ready_sha256=helper_ready_sha256, helper_candidate_sha256=helper_candidate_sha256, helper_restore_sha256=helper_restore_sha256, helper_terminal_sha256=helper_terminal_sha256, helper_evidence_sha256=helper_evidence_sha256, helper_absence_probe_sha256=helper_absence_probe, harness_source_sha256=harness_source_evidence, app_service_runtime={"before": app_runtime_before, "after": app_runtime_after}, cleanup_state="absent")
    except ConcurrentProbeEdit as error:
        control.write(root + "/source-concurrent-edit.json", {"schema": HMR_SCHEMA, "state": "concurrent-edit-preserved", "attempt": attempt, "relative": error.relative, "observed_sha256": error.observed_sha256, "verification": "NOT VERIFIED"})
        raise
    except BaseException:
        if css_write_started[0] and css_candidate_signature is None:
            control.write(root + "/css-write-outcome-unknown.json", {"schema": HMR_SCHEMA, "state": "write-outcome-unknown", "attempt": attempt, "relative": paths["css"], "css_before_sha256": _sha256(css_before), "css_candidate_sha256": _sha256(css_candidate), "verification": "NOT VERIFIED"})
        if css_candidate_published and not restored:
            if css_candidate_signature is None:
                raise ControlOutcomeUnknown("HMR CSS candidate signature was not retained; probe cleanup is fenced")
            try:
                css_restored_signature = _write_probe_locked(css_path, css_candidate, css_candidate_signature, css_before, relative=str(paths["css"]), write_started=None)
                restored = True
                control.write(root + "/css-restored.json", _source_record(state="restored-after-failure", relative=str(paths["css"]), data=css_before, signature=css_restored_signature, nonce=nonce))
            except ConcurrentProbeEdit as concurrent:
                control.write(root + "/source-concurrent-edit.json", {"schema": HMR_SCHEMA, "state": "concurrent-edit-preserved", "attempt": attempt, "relative": concurrent.relative, "observed_sha256": concurrent.observed_sha256, "verification": "NOT VERIFIED"})
                raise
        raise
    finally:
        if helper_id is not None and not helper_removed and terminal is not None:
            try:
                helper_absence_probe = _remove_helper(operation, helper_id, _helper_name(attempt))
                helper_removed = True
                operation["receipt"].update(browser_helper_absence_probe_sha256=helper_absence_probe)
                control.write(root + "/helper-absence.json", {
                    "schema": HMR_SCHEMA,
                    "state": "absent",
                    "attempt": attempt,
                    "container_name": _helper_name(attempt),
                    "absence_probe_sha256": helper_absence_probe,
                })
                control.write(root + "/receipt.json", operation["receipt"])
            except ControlOutcomeUnknown:
                pass


def _control_raw(control: BuildControl, relative: str, *, optional: bool = False) -> bytes | None:
    result = bounded_capture(control.helper_args(control_read_script(control.path(relative))), data=b"", timeout=60)
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        raise BuildControlError("Cannot read durable HMR control record")
    return result.stdout


def _publish_reconciled_terminal(control: BuildControl, root: str, attempt: str, receipt_sha256: str, terminal: Mapping[str, object]) -> None:
    payload = canonical(terminal) + b"\n"
    payload_b64 = base64.b64encode(payload).decode("ascii")
    expected_sha256 = _sha256(payload)
    # BuildControl publishes a phase pointer only at confirmed completion.
    # It may still refer to a preceding attempt, or be absent on the first run.
    previous_current = _control_raw(control, HMR_PHASE + "/current.json", optional=True)
    if previous_current is not None:
        current = json.loads(previous_current)
        previous_attempt = current.get("attempt") if isinstance(current, Mapping) else None
        if (not isinstance(previous_attempt, str) or re.fullmatch(r"[0-9a-f]{32}", previous_attempt) is None
                or current.get("phase") != HMR_PHASE or current.get("compose_project") != control.project):
            raise ControlOutcomeUnknown("HMR reconciliation current receipt identity differs")
    active_path = control.path("active")
    receipt_path = control.path(root + "/receipt.json")
    terminal_path = control.path(root + "/terminal.json")
    current_path = control.path(HMR_PHASE + "/current.json")

    def quote(value: str) -> str:
        return shlex.quote(value)

    script = f'''set -eu
regular() {{ test ! -L "$1"; test -f "$1"; test "$(stat -c %h "$1")" = 1; }}
exact_active() {{ regular {quote(active_path)}; test "$(cat {quote(active_path)})" = "$FULLMAG_HMR_ACTIVE_TOKEN"; test "$(sha256sum {quote(active_path)} | cut -d' ' -f1)" = "$FULLMAG_HMR_ACTIVE_SHA256"; }}
regular {quote(receipt_path)}
test "$(sha256sum {quote(receipt_path)} | cut -d' ' -f1)" = "$FULLMAG_HMR_RECEIPT_SHA256"
exact_active
publish() {{
  local path="$1" payload="$2" expected="$3" previous="${{4:-}}" parent tmp observed
  parent="${{path%/*}}"; test -n "$parent"; test ! -L "$parent"; test "$(readlink -f "$parent")" = "$parent"; test ! -L "$path"
  if test -e "$path"; then regular "$path"; observed="$(sha256sum "$path" | cut -d' ' -f1)"; if test "$observed" = "$expected"; then return 0; fi; test -n "$previous"; test "$observed" = "$previous"; fi
  tmp="$(mktemp "$parent/.hmr-reconcile.XXXXXXXX")"; trap 'rm -f -- "$tmp"' EXIT
  printf '%s' "$payload" | base64 -d > "$tmp"; regular "$tmp"; test "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$expected"; sync "$tmp"; mv -T -- "$tmp" "$path"; sync "$parent"; trap - EXIT
}}
publish {quote(current_path)} "$FULLMAG_HMR_TERMINAL_B64" "$FULLMAG_HMR_TERMINAL_SHA256" "$FULLMAG_HMR_CURRENT_SHA256"
exact_active
publish {quote(terminal_path)} "$FULLMAG_HMR_TERMINAL_B64" "$FULLMAG_HMR_TERMINAL_SHA256"
printf 'RECONCILED\\n'
'''
    args = control.helper_args(script)
    entrypoint = args.index("--entrypoint")
    args[entrypoint:entrypoint] = ["--env", "FULLMAG_HMR_ACTIVE_TOKEN=" + attempt, "--env", "FULLMAG_HMR_ACTIVE_SHA256=" + _sha256((attempt + "\n").encode()), "--env", "FULLMAG_HMR_RECEIPT_SHA256=" + receipt_sha256, "--env", "FULLMAG_HMR_CURRENT_SHA256=" + (_sha256(previous_current) if previous_current is not None else ""), "--env", "FULLMAG_HMR_TERMINAL_B64=" + payload_b64, "--env", "FULLMAG_HMR_TERMINAL_SHA256=" + expected_sha256]
    result = bounded_capture(args, data=b"", timeout=90)
    if result.returncode or b"RECONCILED\n" not in result.stdout:
        raise ControlOutcomeUnknown("HMR reconciliation terminal publication was not confirmed")
    from docker_volume_activation_reconcile import _probe_helper_absence
    # BuildControl's lease holder uses --rm and can already be gone before
    # docker wait. Authenticate its absence instead of requiring a live name.
    deadline = time.monotonic() + 30
    while _probe_helper_absence("fullmag-control-" + attempt) is None:
        if time.monotonic() >= deadline:
            raise ControlOutcomeUnknown("HMR control lease holder remained after terminal publication")
        time.sleep(POLL_SECONDS)
    if _control_raw(control, "active", optional=True) is not None:
        raise ControlOutcomeUnknown("HMR BuildControl lease remained after reconciliation terminal")


def _reconcile(control: BuildControl, selected: Path, args: argparse.Namespace) -> int:
    attempt = args.reconcile_attempt
    if not isinstance(attempt, str) or re.fullmatch(r"[0-9a-f]{32}", attempt) is None:
        raise BuildControlError("HMR reconciliation requires a full attempt UUID")
    if not isinstance(args.expected_receipt_sha256, str) or not browser_qa.SHA256_RE.fullmatch(args.expected_receipt_sha256):
        raise BuildControlError("HMR reconciliation requires an exact receipt SHA-256")
    root = f"{HMR_PHASE}/attempts/{attempt}"
    if _control_raw(control, "active") != (attempt + "\n").encode():
        raise BuildControlError("HMR reconciliation active fence differs")
    receipt_raw = _control_raw(control, root + "/receipt.json")
    if receipt_raw is None:
        raise BuildControlError("HMR reconciliation receipt is absent")
    if _sha256(receipt_raw) != args.expected_receipt_sha256:
        raise BuildControlError("HMR reconciliation receipt hash differs")
    receipt = json.loads(receipt_raw)
    if (receipt.get("schema") != "fullmag.docker-build-operation.v1" or receipt.get("phase") != HMR_PHASE or receipt.get("attempt") != attempt or receipt.get("compose_project") != control.project or receipt.get("state") not in {"starting", "running", "outcome-unknown-resources-retained"}):
        raise BuildControlError("HMR reconciliation receipt identity differs")
    inputs = receipt.get("inputs")
    if not isinstance(inputs, Mapping) or inputs.get("source_root") != str(selected) or inputs.get("worktree_id") != control.identity["worktree_id"] or inputs.get("compose_project") != control.project:
        raise BuildControlError("HMR reconciliation source identity differs")
    harness_source_hashes = _validate_harness_source_hashes(inputs.get("harness_source_sha256"))
    if _read_harness_source_hashes(selected) != harness_source_hashes:
        raise ControlOutcomeUnknown("HMR harness source changed since admission; resources retained")
    expected_exchange = root + "/exchange"
    if receipt.get("helper_exchange_relative") != expected_exchange:
        raise BuildControlError("HMR reconciliation exchange boundary differs")
    expected_control_subpath = control.subpath(expected_exchange)
    if receipt.get("helper_control_subpath") != expected_control_subpath:
        raise BuildControlError("HMR reconciliation control subpath differs")
    intent = control.read(root + "/probe-intent.json")
    if not isinstance(intent, Mapping) or intent.get("schema") != HMR_SCHEMA or intent.get("state") != "creation-intent" or intent.get("attempt") != attempt:
        raise BuildControlError("HMR reconciliation probe intent is invalid")
    nonce = _validate_nonce(intent.get("nonce"))
    paths = _probe_paths(selected, nonce)
    expected_fields = {"route_relative": "route", "page_relative": "page", "css_relative": "css"}
    if any(intent.get(field) != paths[key] for field, key in expected_fields.items()) or intent.get("route_path") != paths["url"]:
        raise BuildControlError("HMR reconciliation probe path identity differs")
    if (inputs.get("probe_nonce") != nonce or inputs.get("route_relative") != paths["route"]
            or inputs.get("page_relative") != paths["page"] or inputs.get("css_relative") != paths["css"]
            or inputs.get("route_path") != paths["url"] or inputs.get("probe_property") != PROBE_PROPERTY
            or intent.get("harness_source_sha256") != harness_source_hashes):
        raise BuildControlError("HMR reconciliation receipt probe pins differ")
    owner = intent.get("owner")
    expected_owner = {key: control.identity[key] for key in ("project_id", "worktree_id", "checkout_kind", "source_root")}
    if owner != expected_owner:
        raise BuildControlError("HMR reconciliation probe owner differs")
    page_bytes = _page_bytes(nonce)
    css_before = _css_bytes()
    css_candidate = _candidate_css_bytes(css_before, nonce)
    if (intent.get("page_sha256") != _sha256(page_bytes) or intent.get("css_before_sha256") != _sha256(css_before) or intent.get("css_candidate_sha256") != _sha256(css_candidate)
            or inputs.get("page_sha256") != _sha256(page_bytes) or inputs.get("css_before_sha256") != _sha256(css_before)
            or inputs.get("css_candidate_sha256") != _sha256(css_candidate)):
        raise BuildControlError("HMR reconciliation probe byte intent differs")
    _validate_intent_bytes(intent, "page", page_bytes)
    _validate_intent_bytes(intent, "css_before", css_before)
    _validate_intent_bytes(intent, "css_candidate", css_candidate)
    route_record = control.read(root + "/route-created.json", optional=True)
    page_record = control.read(root + "/page-created.json", optional=True)
    css_record = control.read(root + "/css-created.json", optional=True)
    helper_id = receipt.get("browser_container_id")
    if helper_id is not None and (not isinstance(helper_id, str) or not CONTAINER_ID_RE.fullmatch(helper_id)):
        helper_id = None
    helper_name = receipt.get("browser_container_name")
    if helper_name != _helper_name(attempt):
        raise BuildControlError("HMR reconciliation deterministic helper name differs")
    frontend_volume = inputs.get("frontend_volume")
    browser_image_id = receipt.get("browser_image_id")
    control_subpath = receipt.get("helper_control_subpath")
    if not isinstance(frontend_volume, str) or not isinstance(browser_image_id, str) or not isinstance(control_subpath, str):
        raise BuildControlError("HMR reconciliation helper pins are incomplete")
    compose = control.read(root + "/compose.json")
    if not isinstance(compose, Mapping) or not isinstance(compose.get("services"), Mapping) or not isinstance(compose["services"].get(HMR_SERVICE), Mapping):
        raise BuildControlError("HMR reconciliation Compose record is missing")
    service = compose["services"][HMR_SERVICE]
    environment = service.get("environment")
    if (not isinstance(environment, Mapping)
            or environment.get("CONTROL_ROOM_HMR_PROTOCOL") != HMR_PROTOCOL_SCHEMA
            or environment.get("CONTROL_ROOM_HMR_ATTEMPT") != attempt
            or environment.get("CONTROL_ROOM_HMR_ROUTE_PATH") != paths["url"]
            or environment.get("CONTROL_ROOM_HMR_HARNESS_SOURCE_SHA256") != canonical(harness_source_hashes).decode("utf-8")):
        raise BuildControlError("HMR reconciliation Compose protocol pins differ")
    if service.get("command") != ["node", HMR_HELPER_PATH]:
        raise BuildControlError("HMR reconciliation helper command differs")
    mounts = service.get("volumes") or []
    control_mounts = [item for item in mounts if isinstance(item, Mapping) and item.get("target") == "/control"]
    control_volume = control_mounts[0].get("volume") if len(control_mounts) == 1 else None
    if (len(control_mounts) != 1 or service.get("image") != inputs.get("browser_image")
            or control_mounts[0].get("read_only") is not False
            or not isinstance(control_volume, Mapping)
            or control_volume.get("subpath") != control_subpath):
        raise BuildControlError("HMR reconciliation Compose mount/image pins differ")
    helper_identifier = helper_id or helper_name
    helper_observed = docker_capture("inspect", helper_identifier, allow_failure=True, timeout=60)
    absence_probe: str
    terminal: Mapping[str, object] | None
    if helper_observed.returncode == 0:
        try:
            document = json.loads(helper_observed.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ControlOutcomeUnknown("HMR browser helper inspection is invalid; resources retained") from error
        if not isinstance(document, list) or len(document) != 1 or not isinstance(document[0], Mapping):
            raise ControlOutcomeUnknown("HMR browser helper identity is ambiguous; resources retained")
        observed_id = document[0].get("Id")
        if not isinstance(observed_id, str) or not CONTAINER_ID_RE.fullmatch(observed_id):
            raise ControlOutcomeUnknown("HMR browser helper has no full inspected identity; resources retained")
        if helper_id is not None and observed_id != helper_id:
            raise ControlOutcomeUnknown("HMR browser helper ID differs from its receipt")
        helper_id = observed_id
        if document[0].get("Name") not in {"/" + helper_name, helper_name}:
            raise ControlOutcomeUnknown("HMR browser helper name differs from its deterministic admission")
        _validate_hmr_helper(document[0], control, control.identity, frontend_volume, browser_image_id, selected, control_subpath, str(paths["url"]), attempt, harness_source_hashes, require_running=False)
        observed_state = (document[0].get("State") or {}).get("Running")
        if observed_state is True:
            _write_command(control, root + "/exchange", attempt=attempt, state="abort", nonce=nonce, source_sha256=_sha256(css_candidate))
            terminal = _validate_protocol_record(_wait_for_record(control, root + "/exchange/helper-terminal.json", 30), attempt=attempt, state="failed-confirmed", nonce=None)
        else:
            terminal = control.read(root + "/exchange/helper-terminal.json", optional=True)
        if isinstance(terminal, Mapping):
            if terminal.get("state") not in {"failed-confirmed", "succeeded"}:
                raise ControlOutcomeUnknown("HMR browser helper terminal is not a confirmed bounded outcome")
            _validate_protocol_record(terminal, attempt=attempt, state=terminal["state"])
            _validate_harness_terminal(terminal, harness_source_hashes)
            _wait_browser_helper(helper_id, expected_exit_codes={0} if terminal["state"] == "succeeded" else {2})
        docker_capture("rm", helper_id, timeout=90, allow_failure=True)
        id_absence_probe = _confirmed_helper_absence(helper_id)
        name_absence_probe = _confirmed_helper_absence(helper_name)
        absence_probe = _record_sha256({
            "container_id": helper_id,
            "container_absence_probe_sha256": id_absence_probe,
            "container_name": helper_name,
            "container_name_absence_probe_sha256": name_absence_probe,
        })
    else:
        name_absence_probe = _confirmed_helper_absence(helper_name)
        id_absence_probe = _confirmed_helper_absence(helper_id) if helper_id is not None else None
        absence_probe = _record_sha256({
            "container_id": helper_id,
            "container_absence_probe_sha256": id_absence_probe,
            "container_name": helper_name,
            "container_name_absence_probe_sha256": name_absence_probe,
        })
        terminal = control.read(root + "/exchange/helper-terminal.json", optional=True)
        if isinstance(terminal, Mapping):
            if terminal.get("state") not in {"failed-confirmed", "succeeded"}:
                raise ControlOutcomeUnknown("HMR browser helper terminal is not a confirmed bounded outcome")
            _validate_protocol_record(terminal, attempt=attempt, state=terminal["state"])
            _validate_harness_terminal(terminal, harness_source_hashes)
    control.write(root + "/helper-absence.json", {
        "schema": HMR_SCHEMA,
        "state": "absent",
        "attempt": attempt,
        "container_name": helper_name,
        "absence_probe_sha256": absence_probe,
    })
    css_candidate_record = control.read(root + "/css-candidate.json", optional=True)
    css_restored_record = control.read(root + "/css-restored.json", optional=True)
    cleanup = _cleanup_reconciled_probe_files(
        paths,
        attempt=attempt,
        nonce=nonce,
        route_record=route_record,
        page_record=page_record,
        css_record=css_record,
        css_candidate_record=css_candidate_record,
        css_restored_record=css_restored_record,
        page_bytes=page_bytes,
        css_before=css_before,
        css_candidate=css_candidate,
    )
    control.write(root + "/cleanup.json", cleanup)
    terminal = {
        **receipt,
        "state": "failed-confirmed",
        "error": "HMR client outcome was unknown; nonce-scoped probe was reconciled",
        "verification": "NOT VERIFIED",
        "recovery_state": "probe-files-removed" if cleanup["state"] == "absent" else "probe-files-preserved",
        "cleanup_state": cleanup["state"],
        "cleanup_not_verified": cleanup["cleanup_not_verified"],
        "preserved_paths": cleanup["preserved_paths"],
        "route_path": paths["url"],
        "page_before_sha256": _sha256(page_bytes),
        "page_after_cleanup_sha256": None,
        "css_before_sha256": _sha256(css_before),
        "css_candidate_sha256": _sha256(css_candidate),
        "css_after_cleanup_sha256": None,
        "helper_absence_probe_sha256": absence_probe,
        "finished_at": time.time(),
    }
    for key in ("page_absence_probe_sha256", "css_absence_probe_sha256", "route_absence_probe_sha256"):
        if key in cleanup:
            terminal[key] = cleanup[key]
    _publish_reconciled_terminal(control, root, attempt, args.expected_receipt_sha256, terminal)
    mirror_console(json.dumps({"state": "failed-confirmed", "attempt": attempt, "verification": "NOT VERIFIED", "probe_cleanup": cleanup["state"]}) + "\n")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--source-root")
    parser.add_argument("--port", type=int)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--pull-timeout", type=int, default=1800)
    parser.add_argument("--browser-image", default=os.environ.get("FULLMAG_BROWSER_QA_IMAGE", browser_qa.DEFAULT_BROWSER_IMAGE))
    parser.add_argument("--reconcile-attempt")
    parser.add_argument("--expected-receipt-sha256")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    defaults = browser_qa.resolve_defaults(args.repo_root, source_root=args.source_root, port=args.port)
    args.source_root, args.port = defaults.source_root, defaults.port
    if os.name != "nt":
        raise BuildControlError("HMR source publication requires the native Windows operator")
    if not 1 <= args.port <= 65535 or not 30 <= args.timeout <= 300 or not 60 <= args.pull_timeout <= 1800:
        raise BuildControlError("HMR port/timeout/pull-timeout is outside its bounded range")
    browser_qa._validate_browser_image_reference(args.browser_image)
    selected, _layout, identity = browser_qa._resolve_selected(args)
    configured = toolchain_configuration(selected, identity)
    helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, helper_image)
    browser_qa._validate_existing_control_volume(control)
    if args.reconcile_attempt:
        return _reconcile(control, selected, args)
    current, backend_id, frontend_id, frontend_volume, frontend_inputs = browser_qa._read_live_development(control, selected, identity, args.port)
    browser_qa._validate_frontend_volume(control, frontend_volume, frontend_inputs)
    frontend = browser_qa._inspect(frontend_id)
    browser_qa._validate_frontend(frontend, control, identity, frontend_volume, current, args.port)
    browser_qa._validate_live_network(backend_id, frontend_id, control.project, args.port)
    nonce = uuid.uuid4().hex[:32]
    paths = _probe_paths(selected, nonce)
    _ensure_probe_absent(paths)
    harness_source_hashes = _read_harness_source_hashes(selected)
    page_bytes = _page_bytes(nonce)
    css_before = _css_bytes()
    css_candidate = _candidate_css_bytes(css_before, nonce)
    source_commit = current.get("source_commit") or (current.get("inputs") or {}).get("source_commit")
    inputs = {
        "schema": HMR_SCHEMA,
        "source_root": str(selected),
        "source_commit": source_commit,
        "compose_project": control.project,
        "worktree_id": identity["worktree_id"],
        "checkout_kind": identity["checkout_kind"],
        "development_attempt": current.get("attempt"),
        "development_fence_sha256": current.get("development_fence_sha256"),
        "frontend_container": frontend_id,
        "backend_container": backend_id,
        "frontend_volume": frontend_volume,
        "frontend_inputs_sha256": _sha256(canonical(frontend_inputs)),
        "public_loopback_url": f"http://127.0.0.1:{args.port}",
        "browser_url": "http://frontend:8080",
        "browser_image": args.browser_image,
        "browser_image_digest": browser_qa.BROWSER_IMAGE_RE.fullmatch(args.browser_image).group(1),
        "playwright_version": browser_qa.PLAYWRIGHT_VERSION,
        "browser_runtime_timeout": args.timeout,
        "browser_image_pull_timeout": args.pull_timeout,
        "probe_nonce": nonce,
        "route_relative": paths["route"],
        "page_relative": paths["page"],
        "css_relative": paths["css"],
        "route_path": paths["url"],
        "page_sha256": _sha256(page_bytes),
        "css_before_sha256": _sha256(css_before),
        "css_candidate_sha256": _sha256(css_candidate),
        "probe_property": PROBE_PROPERTY,
        "harness_source_sha256": harness_source_hashes,
    }
    public_url = inputs["public_loopback_url"]
    with control.operation(HMR_PHASE, inputs) as operation:
        live_fence = control.read("development/current.json")
        if _sha256(canonical(live_fence)) != current["development_fence_sha256"]:
            raise ControlOutcomeUnknown("Development attempt changed before HMR admission")
        if _probe_paths(selected, nonce)["route_path"] != paths["route_path"]:
            raise BuildControlError("HMR route path changed before its operation lease was acquired")
        if _read_harness_source_hashes(selected) != harness_source_hashes:
            raise ControlOutcomeUnknown("HMR harness source changed before helper launch")
        control_subpath = control.subpath(operation["root"] + "/exchange")
        control.write(operation["root"] + "/exchange/manifest.json", {"schema": HMR_PROTOCOL_SCHEMA, "state": "exchange-created", "attempt": operation["receipt"]["attempt"], "relative": operation["root"] + "/exchange", "control_subpath": control_subpath})
        document = _compose_document(selected, identity, args.browser_image, frontend_volume, control, control_subpath, args.port, args.timeout, operation["receipt"]["attempt"], paths["url"], harness_source_hashes)
        browser_image_id, _ = browser_qa._ensure_browser_image(operation, control, _browser_image_admission_document(document), args.browser_image, args.pull_timeout)
        _run_hmr(operation, control, document, identity, selected, current, frontend_id, frontend_volume, browser_image_id, public_url, args.port, paths, page_bytes, css_before, css_candidate, nonce, args.timeout, control_subpath, harness_source_hashes)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BuildControlError, ControlOutcomeUnknown, OSError, ValueError, json.JSONDecodeError) as error:
        mirror_console(f"docker-dev-hmr-qa: {str(error)[:4096]}\n")
        raise SystemExit(2)
