"""Read-only audit of Windows reparse points in runner execution trees.

The tool never removes or mutates an execution tree, Docker object, mount, or
source capsule.  It is intentionally independent from the retention planner:
retention remains fail-closed for any reparse point, while this tool records the
resolved targets needed for a later, separately authorized cleanup review.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import hashlib
import json
import ntpath
import os
from pathlib import Path
import re
import struct
import sys
from typing import Any, Iterable


TOOL_SCHEMA = "fullmag.runner-execution-reparse-audit.v1"
TOOL_VERSION = "1"
REPARSE_POINT = 0x400
FSCTL_GET_REPARSE_POINT = 0x000900A8
FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
OPEN_EXISTING = 3
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
MAX_REPARSE_BUFFER = 16 * 1024
MAX_CHAIN_DEPTH = 64
SHARED_MOUNT_NAMES = (".fullmag-build", ".fullmag-cargo", ".fullmag-rustup")
GENERATED_EXTRA_ROOTS = frozenset(
    {".fullmag", ".fullmag-build", ".fullmag-cargo", ".fullmag-rustup", "node_modules"}
)
GENERATED_EXTRA_PREFIXES = tuple(
    prefix.casefold().replace("/", "\\")
    for prefix in (
        ".fullmag",
        ".fullmag-build",
        ".fullmag-cargo",
        ".fullmag-rustup",
        "node_modules",
        "apps\\control-room\\.next",
        "apps\\control-room\\node_modules",
        "apps\\control-room\\out",
    )
)
MAX_SOURCE_MANIFEST_BYTES = 64 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

TAG_MOUNT_POINT = 0xA0000003
TAG_SYMLINK = 0xA000000C
TAG_LX_SYMLINK = 0xA000001D


class AuditError(RuntimeError):
    """A fail-closed input or filesystem error."""


def _is_generated_extra(relative: str) -> bool:
    """Return whether an extra path belongs to an explicitly generated root."""

    normalized = relative.replace("/", "\\").strip("\\").casefold()
    return any(
        normalized == prefix or normalized.startswith(prefix + "\\")
        for prefix in GENERATED_EXTRA_PREFIXES
    )


if os.name == "nt":
    _KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _CreateFileW = _KERNEL32.CreateFileW
    _CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    _CreateFileW.restype = wintypes.HANDLE
    _DeviceIoControl = _KERNEL32.DeviceIoControl
    _DeviceIoControl.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        wintypes.LPVOID,
    ]
    _DeviceIoControl.restype = wintypes.BOOL
    _CloseHandle = _KERNEL32.CloseHandle
    _CloseHandle.argtypes = [wintypes.HANDLE]
    _CloseHandle.restype = wintypes.BOOL


def _windows_only() -> None:
    if os.name != "nt":
        raise AuditError("this verifier requires Windows reparse-point APIs")


def _attributes(path: str) -> int:
    try:
        return int(getattr(os.lstat(path), "st_file_attributes", 0))
    except OSError as error:
        raise AuditError(f"cannot lstat {path!r}: {error}") from error


def _is_reparse(path: str) -> bool:
    return bool(_attributes(path) & REPARSE_POINT)


def _normal_absolute_path(raw: str, *, label: str) -> str:
    if not isinstance(raw, str) or not raw:
        raise AuditError(f"{label} must be a non-empty path")
    if not ntpath.isabs(raw):
        raise AuditError(f"{label} must be absolute: {raw!r}")
    drive, tail = ntpath.splitdrive(raw)
    if not drive or not tail:
        raise AuditError(f"{label} must include a drive-rooted path: {raw!r}")
    parts = [part for part in tail.replace("/", "\\").split("\\") if part]
    if ".." in parts:
        raise AuditError(f"{label} contains a parent traversal: {raw!r}")
    return ntpath.normpath(raw)


def _key(path: str) -> str:
    return ntpath.normcase(ntpath.normpath(path))


def _absolute_components(path: str) -> tuple[str, list[str]] | None:
    drive, tail = ntpath.splitdrive(path)
    if not drive or not tail.startswith("\\"):
        return None
    return drive.casefold(), [part for part in tail.replace("/", "\\").split("\\") if part]


def _raw_relative_components(path: str, root: str) -> list[str] | None:
    """Return path components below root without collapsing dot segments."""

    path_drive, path_tail = ntpath.splitdrive(path)
    root_drive, root_tail = ntpath.splitdrive(root)
    if not path_drive or path_drive.casefold() != root_drive.casefold():
        return None
    path_tail = path_tail.replace("/", "\\")
    root_tail = root_tail.replace("/", "\\").rstrip("\\")
    if path_tail.casefold() == root_tail.casefold():
        return []
    prefix = root_tail + "\\"
    if not path_tail.casefold().startswith(prefix.casefold()):
        return None
    suffix = path_tail[len(prefix) :]
    return [part for part in suffix.split("\\") if part]


def _raw_descendant(path: str, ancestor: str) -> bool:
    return _raw_relative_components(path, ancestor) is not None


def _raw_suffix(path: str, ancestor: str) -> str:
    ancestor = ancestor.rstrip("\\/")
    if not path.casefold().startswith(ancestor.casefold() + "\\"):
        if path.casefold() == ancestor.casefold():
            return "."
        raise AuditError(f"path is not below resolved reparse component: {path}")
    suffix = path[len(ancestor) :].lstrip("\\/")
    return suffix or "."


def _within(path: str, root: str) -> bool:
    path_parts = _absolute_components(path)
    root_parts = _absolute_components(root)
    if path_parts is None or root_parts is None:
        return False
    path_drive, raw_path_components = path_parts
    root_drive, root_components = root_parts
    if path_drive != root_drive:
        return False

    def collapse(components: list[str]) -> list[str] | None:
        collapsed: list[str] = []
        for component in components:
            if component in ("", "."):
                continue
            if component == "..":
                if not collapsed:
                    return None
                collapsed.pop()
            else:
                collapsed.append(component)
        return collapsed

    collapsed_path = collapse(raw_path_components)
    collapsed_root = collapse(root_components)
    if collapsed_path is None or collapsed_root is None:
        return False
    if len(collapsed_path) < len(collapsed_root):
        return False
    return [item.casefold() for item in collapsed_path[: len(collapsed_root)]] == [
        item.casefold() for item in collapsed_root
    ]


def _relative(path: str, root: str) -> str:
    if _within(path, root):
        return ntpath.relpath(path, root).replace("/", "\\")
    return ntpath.normpath(path).replace("/", "\\")


def _check_ancestors(root: str) -> None:
    current = root
    while True:
        if _is_reparse(current):
            raise AuditError(f"execution path or ancestor is a reparse point: {current}")
        parent = ntpath.dirname(current)
        if parent == current:
            return
        current = parent


def _read_reparse_buffer(path: str) -> bytes:
    handle = _CreateFileW(
        path,
        0,
        0x00000007,  # FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
        None,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
        None,
    )
    if handle == INVALID_HANDLE_VALUE:
        error = ctypes.get_last_error()
        raise AuditError(f"CreateFileW(reparse) failed for {path}: winerror={error}")
    try:
        output = ctypes.create_string_buffer(MAX_REPARSE_BUFFER)
        returned = wintypes.DWORD()
        ok = _DeviceIoControl(
            handle,
            FSCTL_GET_REPARSE_POINT,
            None,
            0,
            output,
            MAX_REPARSE_BUFFER,
            ctypes.byref(returned),
            None,
        )
        if not ok:
            error = ctypes.get_last_error()
            raise AuditError(
                f"FSCTL_GET_REPARSE_POINT failed for {path}: winerror={error}"
            )
        if returned.value < 8 or returned.value > MAX_REPARSE_BUFFER:
            raise AuditError(
                f"invalid reparse buffer length for {path}: {returned.value}"
            )
        return output.raw[: returned.value]
    finally:
        _CloseHandle(handle)


def _decode_utf16(data: bytes, start: int, length: int, *, label: str) -> str:
    if start < 0 or length < 0 or start % 2 or length % 2:
        raise AuditError(f"invalid UTF-16 bounds for {label}")
    end = start + length
    if end > len(data):
        raise AuditError(f"UTF-16 bounds exceed reparse payload for {label}")
    try:
        return data[start:end].decode("utf-16-le", "strict")
    except UnicodeDecodeError as error:
        raise AuditError(f"invalid UTF-16 target for {label}") from error


def _decode_record(path: str) -> dict[str, Any]:
    buffer = _read_reparse_buffer(path)
    tag, data_length, _reserved = struct.unpack_from("<IHH", buffer, 0)
    payload = buffer[8:]
    if data_length != len(payload):
        raise AuditError(
            f"reparse data length mismatch for {path}: "
            f"header={data_length}, actual={len(payload)}"
        )

    result: dict[str, Any] = {"tag": f"0x{tag:08x}", "data_length": data_length}
    if tag == TAG_SYMLINK:
        if data_length < 12:
            raise AuditError(f"short symbolic-link payload for {path}")
        substitute_offset, substitute_length, print_offset, print_length, flags = (
            struct.unpack_from("<HHHHI", payload, 0)
        )
        if flags not in (0, 1):
            raise AuditError(f"unsupported symbolic-link flags {flags} for {path}")
        result.update(
            {
                "kind": "windows_symlink",
                "flags": flags,
                "direct_target": _decode_utf16(
                    payload,
                    12 + substitute_offset,
                    substitute_length,
                    label=path,
                ),
                "print_target": _decode_utf16(
                    payload,
                    12 + print_offset,
                    print_length,
                    label=path,
                ),
            }
        )
        return result

    if tag == TAG_MOUNT_POINT:
        if data_length < 8:
            raise AuditError(f"short junction payload for {path}")
        substitute_offset, substitute_length, print_offset, print_length = (
            struct.unpack_from("<HHHH", payload, 0)
        )
        result.update(
            {
                "kind": "mount_point_or_junction",
                "direct_target": _decode_utf16(
                    payload,
                    8 + substitute_offset,
                    substitute_length,
                    label=path,
                ),
                "print_target": _decode_utf16(
                    payload,
                    8 + print_offset,
                    print_length,
                    label=path,
                ),
            }
        )
        return result

    if tag == TAG_LX_SYMLINK:
        if data_length < 4:
            raise AuditError(f"short LX symbolic-link payload for {path}")
        version = struct.unpack_from("<I", payload, 0)[0]
        if version != 2:
            raise AuditError(f"unsupported LX symbolic-link version {version} for {path}")
        try:
            target = payload[4:].decode("utf-8", "strict").rstrip("\0")
        except UnicodeDecodeError as error:
            raise AuditError(f"invalid UTF-8 LX target for {path}") from error
        if not target:
            raise AuditError(f"empty LX target for {path}")
        result.update({"kind": "lx_symlink", "version": version, "direct_target": target})
        return result

    result.update({"kind": "unsupported_reparse_tag", "raw_payload_hex": payload.hex()})
    raise AuditError(f"unsupported reparse tag 0x{tag:08x} for {path}")


def _target_path(link: str, target: str) -> str:
    if not isinstance(target, str) or not target:
        raise AuditError(f"empty reparse target for {link}")
    if "\0" in target:
        raise AuditError(f"target contains NUL for {link}")
    normalized = target.replace("/", "\\")
    if normalized.startswith("\\??\\UNC\\"):
        normalized = "\\\\" + normalized[8:]
    elif normalized.startswith("\\??\\"):
        namespaced = normalized[4:]
        if not ntpath.isabs(namespaced):
            raise AuditError(f"unsupported device namespace target for {link}")
        normalized = namespaced
    elif normalized.startswith("\\?\\"):
        namespaced = normalized[4:]
        if namespaced.startswith("UNC\\"):
            normalized = "\\\\" + namespaced[4:]
        elif ntpath.isabs(namespaced):
            normalized = namespaced
        else:
            raise AuditError(f"unsupported device namespace target for {link}")
    if re.match(r"(?i)^volume\{[0-9a-f-]{36}\}(?:\\|$)", normalized):
        raise AuditError(f"volume GUID target is not accepted for {link}")
    drive, _tail = ntpath.splitdrive(normalized)
    if drive and not ntpath.isabs(normalized):
        raise AuditError(f"target uses an ambiguous drive-relative path for {link}")
    if ntpath.isabs(normalized):
        return normalized
    return ntpath.join(ntpath.dirname(link), normalized)


def _enumerate_reparse_points(root: str) -> list[str]:
    paths: list[str] = []

    def on_error(error: OSError) -> None:
        raise AuditError(f"cannot enumerate execution tree below {root}: {error}") from error

    for current, directory_names, file_names in os.walk(
        root, topdown=True, onerror=on_error, followlinks=False
    ):
        kept_directories: list[str] = []
        for name in directory_names:
            path = os.path.join(current, name)
            if _is_reparse(path):
                paths.append(path)
            else:
                kept_directories.append(name)
        directory_names[:] = kept_directories
        for name in file_names:
            path = os.path.join(current, name)
            if _is_reparse(path):
                paths.append(path)
    return sorted(paths, key=lambda value: _relative(value, root).casefold())


def _first_reparse_component(
    path: str,
    root: str,
    link_map: dict[str, str],
) -> str | None:
    """Return the first reparse component in ``path`` below ``root``."""

    components = _raw_relative_components(path, root)
    if components is None:
        return None
    current = root
    for component in components:
        if component in ("", "."):
            continue
        if component == "..":
            current = ntpath.dirname(current)
            continue
        current = ntpath.join(current, component)
        if _key(current) in link_map:
            return current
    return None


def _shared_mount_name(path: str, root: str) -> str | None:
    for mount_name in SHARED_MOUNT_NAMES:
        mount_root = ntpath.join(root, mount_name)
        if _raw_descendant(path, mount_root):
            return mount_name
    return None


def _resolve_records(root: str, paths: Iterable[str]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    records: list[dict[str, Any]] = []
    decoded: dict[str, dict[str, Any]] = {}
    decode_errors: dict[str, str] = {}
    for path in paths:
        relative = _relative(path, root)
        try:
            record = _decode_record(path)
        except AuditError as error:
            decode_errors[_key(path)] = str(error)
            records.append(
                {
                    "path": relative,
                    "status": "decode_error",
                    "error": str(error),
                }
            )
            continue
        record["path"] = relative
        record["_absolute_path"] = path
        decoded[_key(path)] = record

    link_map = {_key(path): path for path in paths}
    status_counts: dict[str, int] = {}
    for record in list(decoded.values()):
        path = record.pop("_absolute_path")
        current: str | None = None
        chain: list[str] = [_relative(path, root)]
        seen: set[str] = {_key(path)}
        status = "safe"
        final_target: str | None = None
        error: str | None = None
        try:
            current = _target_path(path, record["direct_target"])
            for _depth in range(MAX_CHAIN_DEPTH):
                if not _within(current, root):
                    status = "external_target"
                    final_target = current
                    error = "target leaves the exact execution directory"
                    break
                mount_name = _shared_mount_name(current, root)
                if mount_name is not None:
                    status = "shared_mount_target"
                    final_target = current
                    error = f"target enters controlled mount directory {mount_name}"
                    break
                component = _first_reparse_component(current, root, link_map)
                if component is None:
                    final_target = current
                    if not os.path.exists(current):
                        status = "missing_target"
                        error = "resolved target does not exist"
                    break
                component_key = _key(component)
                if component_key in seen:
                    status = "cycle"
                    final_target = current
                    error = "reparse target cycle"
                    break
                if component_key in decode_errors:
                    status = "decode_error"
                    final_target = current
                    error = decode_errors[component_key]
                    break
                seen.add(component_key)
                chain.append(_relative(component, root))
                component_record = decoded[component_key]
                component_target = _target_path(
                    component,
                    component_record["direct_target"],
                )
                if not _within(component_target, root):
                    status = "external_target"
                    final_target = component_target
                    error = "reparse component target leaves the exact execution directory"
                    break
                component_mount_name = _shared_mount_name(component_target, root)
                if component_mount_name is not None:
                    status = "shared_mount_target"
                    final_target = component_target
                    error = (
                        "reparse component target enters controlled mount directory "
                        f"{component_mount_name}"
                    )
                    break
                suffix = _raw_suffix(current, component)
                current = (
                    component_target
                    if suffix == "."
                    else ntpath.join(component_target, suffix)
                )
            else:
                status = "chain_too_deep"
                final_target = current
                error = f"reparse chain exceeds {MAX_CHAIN_DEPTH} entries"
        except AuditError as resolve_error:
            status = "resolve_error"
            final_target = current
            error = str(resolve_error)

        status_counts[status] = status_counts.get(status, 0) + 1
        record["chain"] = chain
        record["resolved_final"] = (
            _relative(final_target, root) if final_target is not None else None
        )
        record["status"] = status
        if error is not None:
            record["error"] = error
        records.append(record)

    records.sort(key=lambda item: str(item.get("path", "")).casefold())
    return records, status_counts


def _canonical_records(records: list[dict[str, Any]]) -> bytes:
    return json.dumps(
        records,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _records_digest(records: list[dict[str, Any]]) -> str:
    return hashlib.sha256(_canonical_records(records)).hexdigest()


def _safe_manifest_relative_path(raw: Any) -> str:
    if not isinstance(raw, str) or not raw:
        raise AuditError("source manifest contains an invalid empty path")
    relative = raw.replace("/", "\\")
    if "\0" in relative or ntpath.isabs(relative) or ntpath.splitdrive(relative)[0]:
        raise AuditError(f"source manifest path is not portable: {raw!r}")
    components = [component for component in relative.split("\\") if component]
    if not components or any(component in (".", "..") for component in components):
        raise AuditError(f"source manifest path contains traversal: {raw!r}")
    return "\\".join(components)


def _sha256_file(path: str) -> tuple[int, str]:
    _check_ancestors(ntpath.dirname(path))
    if _is_reparse(path) or not os.path.isfile(path):
        raise AuditError(f"cannot hash a non-regular or reparse file: {path}")
    size = 0
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                digest.update(chunk)
    except OSError as error:
        raise AuditError(f"cannot hash regular file {path}: {error}") from error
    return size, digest.hexdigest()


def _enumerate_source_tree(root: str) -> tuple[set[str], set[str], list[str]]:
    """Enumerate source-tree file/reparse entries without following links."""

    entries: set[str] = set()
    directories: set[str] = set()
    reparse_entries: list[str] = []

    def on_error(error: OSError) -> None:
        raise AuditError(f"cannot enumerate source capsule tree below {root}: {error}") from error

    for current, directory_names, file_names in os.walk(
        root, topdown=True, onerror=on_error, followlinks=False
    ):
        kept_directories: list[str] = []
        for name in directory_names:
            path = os.path.join(current, name)
            relative = _relative(path, root)
            entries.add(relative)
            directories.add(relative)
            if _is_reparse(path):
                reparse_entries.append(relative)
            else:
                kept_directories.append(name)
        directory_names[:] = kept_directories
        for name in file_names:
            path = os.path.join(current, name)
            relative = _relative(path, root)
            entries.add(relative)
            if _is_reparse(path):
                reparse_entries.append(relative)
    return entries, directories, sorted(reparse_entries, key=str.casefold)


def compare_source_capsule(execution: str, source_capsule: str) -> dict[str, Any]:
    """Compare every source-manifest file with its execution counterpart.

    Generated dependency/build roots are reported as extras instead of being
    silently ignored.  Only files explicitly covered by the immutable source
    manifest participate in the source equality decision.
    """

    _windows_only()
    execution_root = _normal_absolute_path(execution, label="execution")
    capsule_root = _normal_absolute_path(source_capsule, label="source capsule")
    _check_ancestors(execution_root)
    _check_ancestors(capsule_root)
    if _within(execution_root, capsule_root) or _within(capsule_root, execution_root):
        raise AuditError("execution and source capsule paths must not overlap")
    manifest_path = ntpath.join(capsule_root, "manifest.json")
    capsule_tree = ntpath.join(capsule_root, "tree")
    if _is_reparse(capsule_tree) or not os.path.isdir(capsule_tree):
        raise AuditError(f"source capsule tree is not a regular non-reparse directory: {capsule_tree}")
    if _is_reparse(manifest_path) or not os.path.isfile(manifest_path):
        raise AuditError(f"source manifest is not a regular non-reparse file: {manifest_path}")
    manifest_size = os.path.getsize(manifest_path)
    if manifest_size > MAX_SOURCE_MANIFEST_BYTES:
        raise AuditError(f"source manifest exceeds {MAX_SOURCE_MANIFEST_BYTES} bytes")
    try:
        with open(manifest_path, "rb") as stream:
            manifest_bytes = stream.read(MAX_SOURCE_MANIFEST_BYTES + 1)
        if len(manifest_bytes) > MAX_SOURCE_MANIFEST_BYTES:
            raise AuditError(f"source manifest exceeds {MAX_SOURCE_MANIFEST_BYTES} bytes")
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AuditError(f"cannot parse source manifest {manifest_path}: {error}") from error
    if not isinstance(manifest, dict) or not isinstance(manifest.get("entries"), list):
        raise AuditError(f"source manifest has no typed entries list: {manifest_path}")
    if not manifest["entries"]:
        raise AuditError(f"source manifest has no file entries: {manifest_path}")

    missing: list[str] = []
    mismatches: list[dict[str, Any]] = []
    reparse_files: list[str] = []
    capsule_missing: list[str] = []
    capsule_mismatches: list[dict[str, Any]] = []
    capsule_reparse_files: list[str] = []
    checked_files = 0
    checked_bytes = 0
    capsule_checked_files = 0
    capsule_checked_bytes = 0
    expected_top: set[str] = set()
    expected_paths: set[str] = set()
    manifest_files: list[tuple[str, int, str]] = []
    for entry in manifest["entries"]:
        if not isinstance(entry, dict) or entry.get("type") != "file":
            raise AuditError(
                "source manifest contains an unsupported entry; only typed files are accepted"
            )
        relative = _safe_manifest_relative_path(entry.get("path"))
        if relative in expected_paths:
            raise AuditError(f"source manifest contains duplicate path: {relative}")
        expected_paths.add(relative)
        expected_top.add(relative.split("\\", 1)[0])
        capsule_target = ntpath.join(capsule_tree, relative)
        target = ntpath.join(execution_root, relative)
        if not _within(capsule_target, capsule_tree) or not _within(target, execution_root):
            raise AuditError(f"source manifest path escapes execution: {relative}")
        expected_size = entry.get("size")
        expected_sha256 = entry.get("sha256")
        if not isinstance(expected_size, int) or expected_size < 0:
            raise AuditError(f"source manifest has invalid size for {relative}")
        if not isinstance(expected_sha256, str) or SHA256_RE.fullmatch(expected_sha256) is None:
            raise AuditError(f"source manifest has invalid sha256 for {relative}")
        manifest_files.append((relative, expected_size, expected_sha256))

    expected_tree_directories: set[str] = set()
    for relative in expected_paths:
        parts = relative.split("\\")
        for index in range(1, len(parts)):
            expected_tree_directories.add("\\".join(parts[:index]))
    capsule_tree_entries, capsule_tree_directories, tree_reparse_entries = _enumerate_source_tree(
        capsule_tree
    )
    execution_entries, execution_directories, execution_reparse_entries = _enumerate_source_tree(
        execution_root
    )
    capsule_extra_files = sorted(
        capsule_tree_entries - expected_paths - expected_tree_directories,
        key=str.casefold,
    )
    capsule_extra_directories = sorted(
        set(capsule_extra_files) & capsule_tree_directories,
        key=str.casefold,
    )
    execution_extra_entries = sorted(
        execution_entries - expected_paths - expected_tree_directories,
        key=str.casefold,
    )
    execution_extra_directories = sorted(
        set(execution_extra_entries) & execution_directories,
        key=str.casefold,
    )
    unexpected_execution_extra_entries = sorted(
        (
            entry
            for entry in execution_extra_entries
            if not _is_generated_extra(entry)
        ),
        key=str.casefold,
    )
    unexpected_execution_reparse_entries = sorted(
        (
            entry
            for entry in execution_reparse_entries
            if not _is_generated_extra(entry)
        ),
        key=str.casefold,
    )

    for relative, expected_size, expected_sha256 in manifest_files:
        capsule_target = ntpath.join(capsule_tree, relative)
        target = ntpath.join(execution_root, relative)

        try:
            capsule_info = os.lstat(capsule_target)
        except FileNotFoundError:
            capsule_missing.append(relative)
        except OSError as error:
            raise AuditError(f"cannot lstat source capsule file {capsule_target}: {error}") from error
        else:
            if bool(getattr(capsule_info, "st_file_attributes", 0) & REPARSE_POINT):
                capsule_reparse_files.append(relative)
            elif not os.path.isfile(capsule_target):
                capsule_mismatches.append({"path": relative, "reason": "not_regular_file"})
            else:
                actual_size, actual_sha256 = _sha256_file(capsule_target)
                capsule_checked_files += 1
                capsule_checked_bytes += actual_size
                if actual_size != expected_size or actual_sha256 != expected_sha256:
                    capsule_mismatches.append(
                        {
                            "path": relative,
                            "reason": "content_or_size_mismatch",
                            "expected_size": expected_size,
                            "actual_size": actual_size,
                            "expected_sha256": expected_sha256,
                            "actual_sha256": actual_sha256,
                        }
                    )

        try:
            info = os.lstat(target)
        except FileNotFoundError:
            missing.append(relative)
            continue
        except OSError as error:
            raise AuditError(f"cannot lstat source counterpart {target}: {error}") from error
        if bool(getattr(info, "st_file_attributes", 0) & REPARSE_POINT):
            reparse_files.append(relative)
            continue
        if not os.path.isfile(target):
            mismatches.append({"path": relative, "reason": "not_regular_file"})
            continue
        actual_size, actual_sha256 = _sha256_file(target)
        checked_files += 1
        checked_bytes += actual_size
        if actual_size != expected_size or actual_sha256 != expected_sha256:
            mismatches.append(
                {
                    "path": relative,
                    "reason": "content_or_size_mismatch",
                    "expected_size": expected_size,
                    "actual_size": actual_size,
                    "expected_sha256": expected_sha256,
                    "actual_sha256": actual_sha256,
                }
            )

    try:
        actual_top = {
            entry.name
            for entry in os.scandir(execution_root)
        }
    except OSError as error:
        raise AuditError(f"cannot enumerate execution top level: {error}") from error
    extra_top = sorted(actual_top - expected_top, key=str.casefold)
    extra_top_level_generated_only = all(
        item in GENERATED_EXTRA_ROOTS for item in extra_top
    )
    try:
        capsule_top = {entry.name for entry in os.scandir(capsule_root)}
    except OSError as error:
        raise AuditError(f"cannot enumerate source capsule top level: {error}") from error
    capsule_expected_top = {"manifest.json", "tree"}
    capsule_extra_top = sorted(capsule_top - capsule_expected_top, key=str.casefold)
    capsule_missing_top = sorted(capsule_expected_top - capsule_top, key=str.casefold)
    capsule_reparse_files = sorted(
        set(capsule_reparse_files) | set(tree_reparse_entries),
        key=str.casefold,
    )
    capsule_structure_match = not capsule_extra_top and not capsule_missing_top
    capsule_match = (
        not capsule_missing
        and not capsule_mismatches
        and not capsule_reparse_files
        and not capsule_extra_files
        and capsule_structure_match
    )
    return {
        "source_capsule": capsule_root,
        "source_manifest": manifest_path,
        "manifest_source_digest": manifest.get("source_digest"),
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "manifest_entries": len(manifest["entries"]),
        "checked_files": checked_files,
        "checked_bytes": checked_bytes,
        "missing": missing,
        "mismatches": mismatches,
        "reparse_source_files": reparse_files,
        "source_capsule_missing": capsule_missing,
        "source_capsule_mismatches": capsule_mismatches,
        "source_capsule_reparse_files": capsule_reparse_files,
        "source_capsule_extra_files": capsule_extra_files,
        "source_capsule_extra_directories": capsule_extra_directories,
        "source_capsule_extra_top_level": capsule_extra_top,
        "source_capsule_missing_top_level": capsule_missing_top,
        "source_capsule_checked_files": capsule_checked_files,
        "source_capsule_checked_bytes": capsule_checked_bytes,
        "source_capsule_match": capsule_match,
        "execution_extra_entries": execution_extra_entries,
        "execution_extra_directories": execution_extra_directories,
        "execution_reparse_entries": execution_reparse_entries,
        "unexpected_execution_extra_entries": unexpected_execution_extra_entries,
        "unexpected_execution_reparse_entries": unexpected_execution_reparse_entries,
        "extra_top_level": extra_top,
        "extra_top_level_generated_only": extra_top_level_generated_only,
        "source_match": (
            not missing
            and not mismatches
            and not reparse_files
            and extra_top_level_generated_only
            and capsule_match
            and not unexpected_execution_extra_entries
            and not unexpected_execution_reparse_entries
        ),
    }


def audit_execution(
    execution: str | os.PathLike[str],
    source_capsule: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Audit one absolute execution directory without following reparse points."""

    _windows_only()
    root = _normal_absolute_path(os.fspath(execution), label="execution")
    if not os.path.isdir(root):
        raise AuditError(f"execution is not a directory: {root}")
    _check_ancestors(root)
    paths = _enumerate_reparse_points(root)
    records, status_counts = _resolve_records(root, paths)
    for record in records:
        if record.get("status") == "decode_error":
            status_counts["decode_error"] = status_counts.get("decode_error", 0) + 1
    report = {
        "execution": root,
        "reparse_count": len(paths),
        "status_counts": status_counts,
        "all_targets_safe": not paths or status_counts == {"safe": len(paths)},
        "target_record_count": len(records),
        "target_map_record_bytes": len(_canonical_records(records)),
        "target_map_sha256": _records_digest(records),
        "target_records": records,
    }
    if source_capsule is not None:
        report["source_guard"] = compare_source_capsule(root, os.fspath(source_capsule))
    return report


def audit_executions(
    executions: Iterable[str | os.PathLike[str]],
    source_capsules: Iterable[str | os.PathLike[str]] | None = None,
) -> dict[str, Any]:
    execution_list = list(executions)
    source_list = list(source_capsules or [])
    if not execution_list:
        return {
            "schema": TOOL_SCHEMA,
            "tool_version": TOOL_VERSION,
            "read_only": True,
            "docker_mutated": False,
            "deletion_performed": False,
            "errors": ["at least one execution path is required"],
            "executions": [],
            "all_safe": False,
        }
    if source_list and len(source_list) != len(execution_list):
        return {
            "schema": TOOL_SCHEMA,
            "tool_version": TOOL_VERSION,
            "read_only": True,
            "docker_mutated": False,
            "deletion_performed": False,
            "errors": [
                "--source-capsule must be supplied exactly once per --execution"
            ],
            "executions": [],
            "all_safe": False,
        }
    execution_reports: list[dict[str, Any]] = []
    errors: list[str] = []
    for index, execution in enumerate(execution_list):
        try:
            capsule = source_list[index] if source_list else None
            execution_reports.append(audit_execution(execution, capsule))
        except AuditError as error:
            errors.append(str(error))
    all_links_safe = not errors and all(
        bool(report["all_targets_safe"]) for report in execution_reports
    )
    all_source_matches = not source_list and not errors or (
        bool(source_list)
        and not errors
        and all(bool(report.get("source_guard", {}).get("source_match")) for report in execution_reports)
    )
    return {
        "schema": TOOL_SCHEMA,
        "tool_version": TOOL_VERSION,
        "read_only": True,
        "docker_mutated": False,
        "deletion_performed": False,
        "errors": errors,
        "executions": execution_reports,
        "all_links_safe": all_links_safe,
        "all_source_matches": all_source_matches,
        "all_safe": all_links_safe and all_source_matches,
    }


def _output_path(path: str) -> str:
    output = _normal_absolute_path(path, label="output")
    parent = ntpath.dirname(output)
    if not os.path.isdir(parent) or _is_reparse(parent):
        raise AuditError(f"output parent must be an existing regular directory: {parent}")
    _check_ancestors(parent)
    if os.path.lexists(output) and _is_reparse(output):
        raise AuditError(f"output must not be a reparse point: {output}")
    return output


def _write_report(
    path: str,
    report: dict[str, Any],
    *,
    forbidden_roots: Iterable[str],
) -> None:
    output = _output_path(path)
    for root in forbidden_roots:
        if _within(output, _normal_absolute_path(root, label="forbidden root")):
            raise AuditError("output must be outside every scanned execution and source capsule")
    if os.path.lexists(output):
        raise AuditError(f"output already exists; choose a new evidence path: {output}")
    payload = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with open(output, "x", encoding="utf-8", newline="\n") as stream:
        stream.write(payload)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execution",
        action="append",
        required=True,
        metavar="ABS_PATH",
        help="absolute execution directory; repeat for multiple exact targets",
    )
    parser.add_argument(
        "--output",
        metavar="ABS_JSON",
        help="optional new JSON evidence path; never writes inside an execution tree",
    )
    parser.add_argument(
        "--source-capsule",
        action="append",
        metavar="ABS_SOURCE_CAPSULE",
        help="optional immutable source capsule; repeat once per --execution",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        report = audit_executions(args.execution, args.source_capsule)
        if args.output:
            _write_report(
                args.output,
                report,
                forbidden_roots=[*args.execution, *(args.source_capsule or [])],
            )
    except AuditError as error:
        print(f"audit error: {error}", file=sys.stderr)
        return 2

    total = sum(int(item["reparse_count"]) for item in report["executions"])
    print(
        f"audited executions={len(report['executions'])} "
        f"reparse_points={total} all_safe={report['all_safe']} "
        f"links_safe={report.get('all_links_safe', False)} "
        f"source_matches={report.get('all_source_matches', False)} "
        f"errors={len(report['errors'])}"
    )
    for item in report["executions"]:
        print(
            f"  {item['execution']}: {item['reparse_count']} "
            f"records {item['status_counts']} "
            f"sha256={item['target_map_sha256']}"
        )
    for error in report["errors"]:
        print(f"  ERROR: {error}", file=sys.stderr)
    return 0 if report["all_safe"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
