"""Bounded private persistence for runner retention plans and operation receipts.

Large records use a small manifest and immutable JSON-entry parts. Legacy inline
JSON remains readable up to the historical 4 MiB single-file limit.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid
from collections.abc import Callable, Iterable, Mapping
from typing import Any

from fullmag_storage import atomic_json
from local_runner import retention


INLINE_JSON_BYTES = 4 * 1024 * 1024
MAX_PART_BYTES = 256 * 1024
MAX_ENTRY_BYTES = 128 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_PART_COUNT = 16_384
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_OPTIONAL_ERROR_JSON_BYTES = 16 * 1024
MAX_ERROR_COMPONENT_BYTES = 512
MAX_DYNAMIC_BYTE_COUNT = len(str(sys.maxsize * 4))
MAX_INTEGER_DIGITS = 128
_ERROR_TYPE_FALLBACK = "other_exception"
_ERROR_CODE_FALLBACK = "retention_operation_error"
# Only explicit machine attributes matching these vocabularies become primary identities.
_CANONICAL_ERROR_TYPE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,509}\Z")
_CANONICAL_ERROR_CODE = re.compile(r"[a-z][a-z0-9_]{0,509}\Z")
_MAX_ERROR_COMPONENT_DISPLAY = "x" * (MAX_ERROR_COMPONENT_BYTES - 2)

MANIFEST_SCHEMA = "fullmag.local-runner.retention-document-manifest.v1"
_PARTS_DIRECTORY = "retention-parts"
_ARRAY_MARKER = "__fullmag_retention_array__"
_PLAN_ID = re.compile(r"plan-[a-f0-9]{8,32}\Z")
_SCOPE_NAMES = frozenset(("execution", "sources", "runtime"))
_KIND_NAMES = frozenset(("plan", "operation"))

_PLAN_ARRAY_PATHS = (
    ("candidates",),
    ("retained",),
    ("raw_engine_plan", "candidates"),
    ("raw_engine_plan", "retained"),
    ("raw_runtime_plan", "candidates"),
    ("raw_runtime_plan", "retained"),
    ("raw_runtime_plan", "protected_external"),
    ("raw_runtime_plan", "references"),
    ("raw_runtime_plan", "errors"),
)
_OPERATION_ARRAY_PATHS = (("items",),)


class RetentionPersistenceError(RuntimeError):
    """A bounded retention document could not be safely read or published."""

    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


def _canonical_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise RetentionPersistenceError("invalid_json_value") from error


def _pretty_json_size(value: Any) -> int:
    try:
        encoder = json.JSONEncoder(indent=2, ensure_ascii=False)
        total = sum(len(piece.encode("utf-8")) for piece in encoder.iterencode(value))
    except (TypeError, ValueError, UnicodeError) as error:
        raise RetentionPersistenceError("invalid_json_value") from error
    return total + 1


def _canonical_size_and_hash(value: Any) -> tuple[int, str]:
    digest = hashlib.sha256()
    total = 0
    try:
        encoder = json.JSONEncoder(
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        for piece in encoder.iterencode(value):
            raw = piece.encode("utf-8")
            digest.update(raw)
            total += len(raw)
    except (TypeError, ValueError, UnicodeError) as error:
        raise RetentionPersistenceError("invalid_json_value") from error
    return total, digest.hexdigest()


def _hash_text(value: str) -> tuple[int, str]:
    digest = hashlib.sha256()
    total = 0
    for start in range(0, len(value), 4096):
        raw = value[start : start + 4096].encode("utf-8")
        total += len(raw)
        digest.update(raw)
    return total, digest.hexdigest()


def _bounded_component(
    value: str,
    pattern: re.Pattern[str],
    fallback: str,
) -> tuple[str, int, str, bool]:
    size, digest = _hash_text(value)
    if pattern.fullmatch(value):
        return value, size, digest, False
    return fallback, size, digest, True


def _primary_reason_code(error: BaseException) -> str:
    for attribute in ("reason_code", "code"):
        try:
            explicit = getattr(error, attribute, None)
        except Exception:
            continue
        if isinstance(explicit, str):
            return explicit
    if isinstance(error, OSError) and isinstance(error.errno, int):
        return f"os_error_{error.errno}"
    return _ERROR_CODE_FALLBACK


def failure_fields(
    error: BaseException,
    *,
    summary_key: str,
    label: str,
    optional_bytes_used: int = 0,
) -> dict[str, Any]:
    """Return primary error identity plus bounded, hash-bound optional text."""
    try:
        message = str(error)
    except Exception as formatting_error:
        message = f"<exception string failed: {type(formatting_error).__name__}>"

    message_bytes, message_sha256 = _hash_text(message)
    type_display, type_bytes, type_sha256, type_omitted = _bounded_component(
        type(error).__name__, _CANONICAL_ERROR_TYPE, _ERROR_TYPE_FALLBACK
    )
    code_display, code_bytes, code_sha256, code_omitted = _bounded_component(
        _primary_reason_code(error), _CANONICAL_ERROR_CODE, _ERROR_CODE_FALLBACK
    )
    if not isinstance(optional_bytes_used, int) or isinstance(optional_bytes_used, bool):
        optional_bytes_used = MAX_OPTIONAL_ERROR_JSON_BYTES
    else:
        optional_bytes_used = min(MAX_OPTIONAL_ERROR_JSON_BYTES, max(0, optional_bytes_used))
    remaining = MAX_OPTIONAL_ERROR_JSON_BYTES - optional_bytes_used
    prefix = f"{type_display}: {code_display}"
    if message_bytes <= remaining:
        candidate_summary = f"{prefix}: {message}"
        try:
            candidate_size = len(_canonical_bytes(candidate_summary))
        except RetentionPersistenceError:
            candidate_size = remaining + 1
    else:
        candidate_summary = ""
        candidate_size = remaining + 1
    if candidate_size <= remaining:
        summary = candidate_summary
        used = candidate_size
        omitted = False
    else:
        summary = f"{prefix}: diagnostic message omitted"
        used = 0
        omitted = True

    return {
        summary_key: summary,
        f"{label}_type": type_display,
        f"{label}_type_bytes": type_bytes,
        f"{label}_type_sha256": type_sha256,
        f"{label}_type_omitted": type_omitted,
        f"{label}_code": code_display,
        f"{label}_code_bytes": code_bytes,
        f"{label}_code_sha256": code_sha256,
        f"{label}_code_omitted": code_omitted,
        f"{label}_message_bytes": message_bytes,
        f"{label}_message_sha256": message_sha256,
        f"{label}_message_omitted": omitted,
        "_optional_error_json_bytes": optional_bytes_used + used,
    }


def maximum_failure_fields(*, summary_key: str, label: str) -> dict[str, Any]:
    """Upper-bound one failure descriptor for operation-capacity preflight."""
    summary = "x" * max(0, MAX_OPTIONAL_ERROR_JSON_BYTES - 2)
    max_count = int("9" * MAX_DYNAMIC_BYTE_COUNT)
    # Canonical ASCII identifiers remain readable and fit the 512-byte field cap.
    max_component = _MAX_ERROR_COMPONENT_DISPLAY
    max_hash = "f" * 64
    return {
        summary_key: summary,
        f"{label}_type": max_component,
        f"{label}_type_bytes": max_count,
        f"{label}_type_sha256": max_hash,
        f"{label}_type_omitted": False,
        f"{label}_code": max_component,
        f"{label}_code_bytes": max_count,
        f"{label}_code_sha256": max_hash,
        f"{label}_code_omitted": False,
        f"{label}_message_bytes": max_count,
        f"{label}_message_sha256": max_hash,
        f"{label}_message_omitted": False,
        "_optional_error_json_bytes": MAX_OPTIONAL_ERROR_JSON_BYTES,
    }


def _scope_for(record: Mapping[str, Any], scope: str | None) -> str | None:
    record_scope = record.get("scope")
    if record_scope is not None and (
        not isinstance(record_scope, str) or record_scope not in _SCOPE_NAMES
    ):
        raise RetentionPersistenceError("invalid_document_scope")
    if scope is not None and scope not in _SCOPE_NAMES:
        raise RetentionPersistenceError("invalid_document_scope")
    if scope is not None and record_scope is not None and scope != record_scope:
        raise RetentionPersistenceError("document_scope_mismatch")
    return scope if scope is not None else record_scope


def _validate_identity(record: Mapping[str, Any], plan_id: str, kind: str) -> None:
    if not isinstance(plan_id, str) or _PLAN_ID.fullmatch(plan_id) is None:
        raise RetentionPersistenceError("invalid_plan_id")
    if kind not in _KIND_NAMES:
        raise RetentionPersistenceError("invalid_document_kind")
    if record.get("plan_id") != plan_id:
        raise RetentionPersistenceError("document_plan_id_mismatch")
    record_scope = record.get("scope")
    if record_scope is not None and (
        not isinstance(record_scope, str) or record_scope not in _SCOPE_NAMES
    ):
        raise RetentionPersistenceError("invalid_document_scope")


def _array_paths(kind: str, record: Mapping[str, Any]) -> list[tuple[str, ...]]:
    allowed = _OPERATION_ARRAY_PATHS if kind == "operation" else _PLAN_ARRAY_PATHS
    present = []
    for path in allowed:
        value = _get_path(record, path)
        if isinstance(value, list) and (value or (kind == "operation" and path == ("items",))):
            present.append(path)
    return sorted(present)


def _get_path(value: Any, path: tuple[str, ...]) -> Any:
    current = value
    for key in path:
        if not isinstance(current, Mapping) or key not in current:
            return None
        current = current[key]
    return current


def _set_path(value: dict[str, Any], path: tuple[str, ...], replacement: Any) -> None:
    current: Any = value
    for key in path[:-1]:
        if not isinstance(current, dict) or key not in current:
            raise RetentionPersistenceError("invalid_manifest_payload")
        current = current[key]
    if not isinstance(current, dict) or path[-1] not in current:
        raise RetentionPersistenceError("invalid_manifest_payload")
    current[path[-1]] = replacement


def _array_id(path: tuple[str, ...]) -> str:
    raw = "/".join(path).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def _array_marker(path: tuple[str, ...]) -> dict[str, str]:
    return {_ARRAY_MARKER: _array_id(path)}


def _clone_skeleton(
    value: Any,
    replacements: set[tuple[str, ...]],
    path: tuple[str, ...] = (),
) -> Any:
    if path in replacements:
        return _array_marker(path)
    if isinstance(value, dict):
        return {
            key: _clone_skeleton(child, replacements, path + (key,))
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [
            _clone_skeleton(child, replacements, path + (str(index),))
            for index, child in enumerate(value)
        ]
    return value


def _document_relative_parts(storage: Path, path: Path) -> tuple[str, ...]:
    try:
        absolute = Path(os.path.abspath(os.fspath(path)))
        relative = absolute.relative_to(storage)
    except (OSError, ValueError) as error:
        raise RetentionPersistenceError("document_outside_storage") from error
    if not relative.parts or any(
        part in ("", ".", "..") or "/" in part or "\\" in part
        for part in relative.parts
    ):
        raise RetentionPersistenceError("invalid_document_path")
    return tuple(relative.parts)


def _check_document_location(storage: Path, path: Path, *, must_exist: bool) -> tuple[str, ...]:
    parts = _document_relative_parts(storage, path)
    try:
        if must_exist:
            retention._checked_child(storage, parts, kind="file")
        else:
            retention._checked_child(storage, parts[:-1], kind="directory")
    except retention._PathIssue as error:
        raise RetentionPersistenceError(error.reason) from error
    return parts


def _parts_directory(storage: Path, plan_id: str, kind: str, scope: str, *, create: bool) -> Path:
    components = ("index", _PARTS_DIRECTORY, plan_id, kind, scope)
    current = storage
    seen: list[str] = []
    for component in components:
        current = current / component
        seen.append(component)
        if create:
            try:
                os.mkdir(current, 0o700)
            except FileExistsError:
                pass
            except OSError as error:
                raise RetentionPersistenceError("parts_directory_unavailable") from error
        try:
            retention._checked_child(storage, tuple(seen), kind="directory")
        except retention._PathIssue as error:
            raise RetentionPersistenceError(error.reason) from error
    return current


def _part_filename(
    plan_id: str,
    kind: str,
    scope: str,
    path: tuple[str, ...],
    index: int,
    digest: str,
) -> str:
    return (
        f"{plan_id}.{kind}.{scope}.{_array_id(path)}."
        f"{index:05d}.{digest}.part"
    )


def _part_file_identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_size,
        getattr(info, "st_mtime_ns", 0),
        getattr(info, "st_ctime_ns", 0),
    )


def _part_is_reparse(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & retention._REPARSE_POINT
    )


def _part_is_regular(info: os.stat_result) -> bool:
    return stat.S_ISREG(info.st_mode) and not _part_is_reparse(info)


def _open_windows_nofollow_file(path: Path) -> int:
    """Open a Windows file entry itself, never the target of a reparse point."""
    try:
        import ctypes
        import msvcrt
        from ctypes import wintypes
    except ImportError as error:
        raise RetentionPersistenceError("windows_nofollow_open_unavailable") from error
    loader = getattr(ctypes, "WinDLL", None)
    if not callable(loader):
        raise RetentionPersistenceError("windows_nofollow_open_unavailable")
    try:
        kernel32 = loader("kernel32", use_last_error=True)
        create_file = kernel32.CreateFileW
        create_file.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]
        create_file.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
    except (AttributeError, OSError) as error:
        raise RetentionPersistenceError("windows_nofollow_open_unavailable") from error

    generic_read = 0x80000000
    file_read_attributes = 0x00000080
    share_all = 0x00000001 | 0x00000002 | 0x00000004
    open_existing = 3
    file_attribute_normal = 0x00000080
    file_flag_open_reparse_point = 0x00200000
    handle = create_file(
        str(path),
        generic_read | file_read_attributes,
        share_all,
        None,
        open_existing,
        file_attribute_normal | file_flag_open_reparse_point,
        None,
    )
    invalid_handle = ctypes.c_void_p(-1).value
    if handle in (None, invalid_handle):
        raise OSError(ctypes.get_last_error(), "CreateFileW no-follow", str(path))
    try:
        return msvcrt.open_osfhandle(
            int(handle), os.O_RDONLY | getattr(os, "O_BINARY", 0)
        )
    except Exception:
        kernel32.CloseHandle(handle)
        raise


def _open_nofollow_file(path: Path) -> int:
    if os.name == "nt":
        return _open_windows_nofollow_file(path)
    flags = (
        os.O_RDONLY
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
        | getattr(os, "O_BINARY", 0)
    )
    return os.open(path, flags)


def _read_regular_bytes(storage: Path, relative_parts: tuple[str, ...], max_bytes: int) -> bytes:
    descriptor = -1
    try:
        path = retention._checked_child(storage, relative_parts, kind="file")
        before_open = os.lstat(path)
        if not _part_is_regular(before_open):
            raise RetentionPersistenceError("part_not_regular")
        if before_open.st_size > max_bytes:
            raise RetentionPersistenceError("part_size_exceeded")

        descriptor = _open_nofollow_file(path)
        opened = os.fstat(descriptor)
        if not _part_is_regular(opened) or _part_file_identity(opened) != _part_file_identity(before_open):
            raise RetentionPersistenceError("part_identity_changed")
        if opened.st_size > max_bytes:
            raise RetentionPersistenceError("part_size_exceeded")

        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            raw = stream.read(max_bytes + 1)
            after_read = os.fstat(stream.fileno())
            if (not _part_is_regular(after_read)
                    or _part_file_identity(after_read) != _part_file_identity(opened)):
                raise RetentionPersistenceError("part_identity_changed")

        checked_after_read = retention._checked_child(storage, relative_parts, kind="file")
        after_path = os.lstat(checked_after_read)
        if (not _part_is_regular(after_path)
                or _part_file_identity(after_path) != _part_file_identity(opened)):
            raise RetentionPersistenceError("part_identity_changed")
    except RetentionPersistenceError:
        raise
    except retention._PathIssue as error:
        raise RetentionPersistenceError(error.reason) from error
    except OSError as error:
        raise RetentionPersistenceError("part_unreadable") from error
    finally:
        if descriptor != -1:
            try:
                os.close(descriptor)
            except OSError:
                pass

    if len(raw) > max_bytes:
        raise RetentionPersistenceError("part_size_exceeded")
    if len(raw) != opened.st_size:
        raise RetentionPersistenceError("part_size_changed")
    return raw


def _read_small_object(storage: Path, path: Path) -> dict[str, Any]:
    _check_document_location(storage, path, must_exist=True)
    try:
        value = retention._read_json(path)
    except retention._PathIssue as error:
        if error.reason == "invalid_metadata":
            try:
                if os.lstat(path).st_size > INLINE_JSON_BYTES:
                    raise RetentionPersistenceError("oversized_legacy_document") from error
            except OSError:
                pass
        raise RetentionPersistenceError(error.reason) from error
    if not isinstance(value, Mapping):
        raise RetentionPersistenceError("invalid_document")
    return dict(value)


def _existing_is_manifest(
    storage: Path,
    path: Path,
    plan_id: str,
    kind: str,
    scope: str | None,
) -> bool:
    if not os.path.lexists(path):
        _check_document_location(storage, path, must_exist=False)
        return False
    record = _read_small_object(storage, path)
    if record.get("plan_id") != plan_id:
        raise RetentionPersistenceError("document_plan_id_mismatch")
    schema = record.get("storage_schema")
    if schema is None:
        record_scope = record.get("scope")
        if record_scope is not None and scope is not None and record_scope != scope:
            raise RetentionPersistenceError("document_scope_mismatch")
        return False
    if schema != MANIFEST_SCHEMA:
        raise RetentionPersistenceError("unsupported_document_storage_schema")
    if record.get("kind") != kind:
        raise RetentionPersistenceError("document_kind_mismatch")
    if scope is None or record.get("scope") != scope:
        raise RetentionPersistenceError("document_scope_mismatch")
    return True


def _publish_immutable_part(
    storage: Path,
    parts_dir: Path,
    plan_id: str,
    kind: str,
    scope: str,
    array_path: tuple[str, ...],
    index: int,
    raw: bytes,
    digest: str,
) -> str:
    if len(raw) > MAX_PART_BYTES:
        raise RetentionPersistenceError("part_size_exceeded")
    name = _part_filename(plan_id, kind, scope, array_path, index, digest)
    components = ("index", _PARTS_DIRECTORY, plan_id, kind, scope, name)

    def verify_existing() -> str:
        current = _read_regular_bytes(storage, components, MAX_PART_BYTES)
        if len(current) != len(raw) or hashlib.sha256(current).hexdigest() != digest or current != raw:
            raise RetentionPersistenceError("immutable_part_conflict")
        return name

    try:
        retention._checked_child(storage, components, kind="file")
    except retention._PathIssue as error:
        if error.reason != "missing_run_path":
            raise RetentionPersistenceError(error.reason) from error
    else:
        return verify_existing()

    temporary_name = f".{name}.{uuid.uuid4().hex}.tmp"
    temporary_components = components[:-1] + (temporary_name,)
    temporary = parts_dir / temporary_name
    try:
        with temporary.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        retention._checked_child(storage, temporary_components, kind="file")
        link = getattr(os, "link", None)
        if not callable(link):
            raise RetentionPersistenceError("atomic_no_clobber_unavailable")
        try:
            # Same-directory hard-link creation publishes the complete inode
            # atomically and fails if a concurrent writer already chose name.
            link(temporary, parts_dir / name)
        except FileExistsError:
            return verify_existing()
        except OSError as error:
            if os.path.lexists(parts_dir / name):
                return verify_existing()
            raise RetentionPersistenceError("part_publish_failed") from error

        retention._checked_child(storage, components, kind="file")
        return verify_existing()
    except RetentionPersistenceError:
        raise
    except OSError as error:
        raise RetentionPersistenceError("part_publish_failed") from error
    finally:
        try:
            if os.path.lexists(temporary):
                temporary.unlink()
        except OSError:
            pass


def _manifest_template(
    *,
    plan_id: str,
    kind: str,
    scope: str,
    payload: dict[str, Any],
    payload_size: int,
    payload_digest: str,
    arrays: list[dict[str, Any]],
) -> dict[str, Any]:
    part_count = sum(len(array["parts"]) for array in arrays)
    return {
        "storage_schema": MANIFEST_SCHEMA,
        "kind": kind,
        "plan_id": plan_id,
        "scope": scope,
        "payload_size_bytes": payload_size,
        "payload_sha256": payload_digest,
        "part_count": part_count,
        "arrays": arrays,
        "payload": payload,
    }


def write_document(
    storage_root: str | os.PathLike[str],
    path: str | os.PathLike[str],
    record: Mapping[str, Any],
    *,
    kind: str,
    scope: str | None = None,
) -> None:
    """Atomically persist one private plan or operation document."""
    if not isinstance(record, Mapping):
        raise RetentionPersistenceError("invalid_document")
    value = dict(record)
    plan_id = value.get("plan_id")
    if not isinstance(plan_id, str) or _PLAN_ID.fullmatch(plan_id) is None:
        raise RetentionPersistenceError("invalid_plan_id")
    if kind not in _KIND_NAMES:
        raise RetentionPersistenceError("invalid_document_kind")
    effective_scope = _scope_for(value, scope)
    if effective_scope is not None:
        value["scope"] = effective_scope

    storage = retention._canonical_storage(storage_root)
    document_path = Path(path)
    existing_manifest = _existing_is_manifest(
        storage, document_path, plan_id, kind, effective_scope
    )
    _check_document_location(storage, document_path, must_exist=False)

    payload_size, payload_digest = _canonical_size_and_hash(value)
    if payload_size > MAX_TOTAL_BYTES:
        raise RetentionPersistenceError("document_total_bytes_exceeded")

    array_paths = _array_paths(kind, value)
    pretty_size = _pretty_json_size(value)
    force_manifest = existing_manifest or pretty_size > INLINE_JSON_BYTES
    if not force_manifest:
        for array_path in array_paths:
            array_value = _get_path(value, array_path)
            if not isinstance(array_value, list):
                raise RetentionPersistenceError("invalid_document_array")
            for item in array_value:
                if len(_canonical_bytes(item)) > MAX_ENTRY_BYTES:
                    raise RetentionPersistenceError("document_entry_bytes_exceeded")
        try:
            atomic_json(document_path, value)
        except OSError as error:
            raise RetentionPersistenceError("inline_document_publish_failed") from error
        return

    if effective_scope is None:
        raise RetentionPersistenceError("manifest_scope_required")
    arrays: list[dict[str, Any]] = []
    part_count = 0

    for array_path in array_paths:
        array_value = _get_path(value, array_path)
        if not isinstance(array_value, list):
            raise RetentionPersistenceError("invalid_document_array")
        active_item = kind == "operation" and array_path == ("items",) and bool(array_value)
        stored_values = array_value[:-1] if active_item else array_value
        descriptors: list[dict[str, Any]] = []
        for index, item in enumerate(stored_values):
            raw = _canonical_bytes(item)
            if len(raw) > MAX_ENTRY_BYTES:
                raise RetentionPersistenceError("document_entry_bytes_exceeded")
            if len(raw) > MAX_PART_BYTES:
                raise RetentionPersistenceError("part_size_exceeded")
            part_count += 1
            if part_count > MAX_PART_COUNT:
                raise RetentionPersistenceError("document_part_count_exceeded")
            digest = hashlib.sha256(raw).hexdigest()
            name = _part_filename(plan_id, kind, effective_scope, array_path, index, digest)
            descriptors.append(
                {
                    "index": index,
                    "name": name,
                    "size_bytes": len(raw),
                    "sha256": digest,
                }
            )
        array_record: dict[str, Any] = {
            "path": list(array_path),
            "array_id": _array_id(array_path),
            "count": len(array_value),
            "has_active_item": bool(active_item),
            "parts": descriptors,
        }
        if active_item:
            active_raw = _canonical_bytes(array_value[-1])
            if len(active_raw) > MAX_ENTRY_BYTES:
                raise RetentionPersistenceError("document_entry_bytes_exceeded")
            array_record["active_item"] = array_value[-1]
        arrays.append(array_record)

    skeleton = _clone_skeleton(value, set(array_paths))
    manifest = _manifest_template(
        plan_id=plan_id,
        kind=kind,
        scope=effective_scope,
        payload=skeleton,
        payload_size=payload_size,
        payload_digest=payload_digest,
        arrays=arrays,
    )
    manifest_size = _pretty_json_size(manifest)
    if manifest_size > MAX_MANIFEST_BYTES:
        raise RetentionPersistenceError("manifest_bytes_exceeded")

    parts_dir = _parts_directory(storage, plan_id, kind, effective_scope, create=True)
    for array_path in array_paths:
        array_value = _get_path(value, array_path)
        active_item = kind == "operation" and array_path == ("items",) and bool(array_value)
        stored_values = array_value[:-1] if active_item else array_value
        for index, item in enumerate(stored_values):
            raw = _canonical_bytes(item)
            digest = hashlib.sha256(raw).hexdigest()
            _publish_immutable_part(
                storage,
                parts_dir,
                plan_id,
                kind,
                effective_scope,
                array_path,
                index,
                raw,
                digest,
            )
    try:
        atomic_json(document_path, manifest)
    except OSError as error:
        raise RetentionPersistenceError("manifest_publish_failed") from error


def _manifest_arrays(
    storage: Path,
    manifest: Mapping[str, Any],
    *,
    plan_id: str,
    kind: str,
    scope: str,
    payload_size: int,
) -> dict[tuple[str, ...], list[Any]]:
    raw_arrays = manifest.get("arrays")
    if not isinstance(raw_arrays, list):
        raise RetentionPersistenceError("invalid_manifest_arrays")
    allowed = set(_OPERATION_ARRAY_PATHS if kind == "operation" else _PLAN_ARRAY_PATHS)
    payload = manifest.get("payload")
    if not isinstance(payload, dict):
        raise RetentionPersistenceError("invalid_manifest_payload")

    skeleton_size, _ = _canonical_size_and_hash(payload)
    catalog: list[tuple[tuple[str, ...], list[dict[str, Any]], bool, Any]] = []
    previous_path: tuple[str, ...] | None = None
    all_names: set[str] = set()
    total_parts = 0
    total_part_bytes = 0
    expected_payload_size = skeleton_size

    # Validate the entire descriptor catalog and its exact logical payload size
    # before opening any part. The manifest itself is already bounded at 4 MiB.
    for array in raw_arrays:
        if not isinstance(array, dict):
            raise RetentionPersistenceError("invalid_manifest_array")
        raw_path = array.get("path")
        if not isinstance(raw_path, list) or not raw_path or any(not isinstance(item, str) for item in raw_path):
            raise RetentionPersistenceError("invalid_manifest_array_path")
        array_path = tuple(raw_path)
        if array_path not in allowed or (previous_path is not None and array_path <= previous_path):
            raise RetentionPersistenceError("invalid_manifest_array_order")
        previous_path = array_path
        if array.get("array_id") != _array_id(array_path):
            raise RetentionPersistenceError("manifest_array_identity_mismatch")
        if _get_path(payload, array_path) != _array_marker(array_path):
            raise RetentionPersistenceError("manifest_array_link_mismatch")

        count = array.get("count")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0 or count > MAX_PART_COUNT + 1:
            raise RetentionPersistenceError("manifest_array_count_invalid")
        parts = array.get("parts")
        if not isinstance(parts, list):
            raise RetentionPersistenceError("invalid_manifest_parts")
        active = array.get("has_active_item")
        if type(active) is not bool:
            raise RetentionPersistenceError("invalid_manifest_active_item")
        if kind == "operation" and array_path == ("items",):
            if active != (count > 0) or len(parts) != max(0, count - 1):
                raise RetentionPersistenceError("invalid_manifest_active_item")
        elif active or "active_item" in array or len(parts) != count:
            raise RetentionPersistenceError("invalid_manifest_parts")

        descriptors: list[dict[str, Any]] = []
        array_entry_bytes = 0
        for index, descriptor in enumerate(parts):
            if not isinstance(descriptor, dict):
                raise RetentionPersistenceError("invalid_manifest_part")
            part_index = descriptor.get("index")
            if (not isinstance(part_index, int) or isinstance(part_index, bool)
                    or part_index != index):
                raise RetentionPersistenceError("manifest_part_order_mismatch")
            size = descriptor.get("size_bytes")
            if not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= MAX_ENTRY_BYTES:
                raise RetentionPersistenceError("manifest_part_size_invalid")
            digest = descriptor.get("sha256")
            if not isinstance(digest, str) or re.fullmatch(r"[a-f0-9]{64}", digest) is None:
                raise RetentionPersistenceError("manifest_part_digest_invalid")
            name = descriptor.get("name")
            expected_name = _part_filename(plan_id, kind, scope, array_path, index, digest)
            if name != expected_name or name in all_names:
                raise RetentionPersistenceError("manifest_part_name_invalid")
            all_names.add(name)
            descriptors.append(descriptor)
            total_parts += 1
            total_part_bytes += size
            array_entry_bytes += size
            if total_parts > MAX_PART_COUNT or total_part_bytes > MAX_TOTAL_BYTES:
                raise RetentionPersistenceError("manifest_part_budget_exceeded")

        active_item = None
        if active:
            active_item = array.get("active_item")
            active_size, _ = _canonical_size_and_hash(active_item)
            if active_size > MAX_ENTRY_BYTES:
                raise RetentionPersistenceError("manifest_active_item_too_large")
            array_entry_bytes += active_size
        elif "active_item" in array:
            raise RetentionPersistenceError("unexpected_manifest_active_item")

        array_size = 2 + array_entry_bytes + max(0, count - 1)
        marker_size, _ = _canonical_size_and_hash(_array_marker(array_path))
        expected_payload_size += array_size - marker_size
        catalog.append((array_path, descriptors, active, active_item))

    declared_part_count = manifest.get("part_count")
    if (not isinstance(declared_part_count, int) or isinstance(declared_part_count, bool)
            or declared_part_count != total_parts):
        raise RetentionPersistenceError("manifest_part_count_mismatch")
    if total_parts > MAX_PART_COUNT or total_part_bytes > MAX_TOTAL_BYTES:
        raise RetentionPersistenceError("manifest_part_budget_exceeded")
    if expected_payload_size != payload_size:
        raise RetentionPersistenceError("manifest_payload_size_mismatch")
    if expected_payload_size > MAX_TOTAL_BYTES:
        raise RetentionPersistenceError("manifest_payload_size_exceeded")

    reconstructed: dict[tuple[str, ...], list[Any]] = {}
    actual_total_part_bytes = 0
    for array_path, descriptors, active, active_item in catalog:
        values: list[Any] = []
        for descriptor in descriptors:
            size = descriptor["size_bytes"]
            remaining_budget = MAX_TOTAL_BYTES - actual_total_part_bytes
            if size > remaining_budget:
                raise RetentionPersistenceError("manifest_part_budget_exceeded")
            name = descriptor["name"]
            digest = descriptor["sha256"]
            raw = _read_regular_bytes(
                storage,
                ("index", _PARTS_DIRECTORY, plan_id, kind, scope, name),
                min(MAX_PART_BYTES, remaining_budget),
            )
            if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
                raise RetentionPersistenceError("manifest_part_integrity_mismatch")
            actual_total_part_bytes += len(raw)
            try:
                value = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise RetentionPersistenceError("manifest_part_invalid_json") from error
            if _canonical_bytes(value) != raw:
                raise RetentionPersistenceError("manifest_part_noncanonical")
            values.append(value)
        if active:
            values.append(active_item)
        reconstructed[array_path] = values

    if actual_total_part_bytes != total_part_bytes:
        raise RetentionPersistenceError("manifest_part_budget_mismatch")
    return reconstructed


def read_document(
    storage_root: str | os.PathLike[str],
    path: str | os.PathLike[str],
    *,
    plan_id: str,
    kind: str,
    scope: str | None = None,
) -> dict[str, Any]:
    """Read a bounded legacy inline record or validate every manifest part."""
    if not isinstance(plan_id, str) or _PLAN_ID.fullmatch(plan_id) is None:
        raise RetentionPersistenceError("invalid_plan_id")
    if kind not in _KIND_NAMES:
        raise RetentionPersistenceError("invalid_document_kind")
    storage = retention._canonical_storage(storage_root)
    document_path = Path(path)
    _check_document_location(storage, document_path, must_exist=True)
    manifest = _read_small_object(storage, document_path)
    schema = manifest.get("storage_schema")
    if schema is None:
        _validate_identity(manifest, plan_id, kind)
        record_scope = manifest.get("scope")
        if record_scope is not None and (
            not isinstance(record_scope, str) or record_scope not in _SCOPE_NAMES
        ):
            raise RetentionPersistenceError("invalid_document_scope")
        if record_scope is not None and scope is not None and record_scope != scope:
            raise RetentionPersistenceError("document_scope_mismatch")
        return manifest
    if schema != MANIFEST_SCHEMA:
        raise RetentionPersistenceError("unsupported_document_storage_schema")

    if manifest.get("kind") != kind or manifest.get("plan_id") != plan_id:
        raise RetentionPersistenceError("manifest_identity_mismatch")
    manifest_scope = manifest.get("scope")
    if not isinstance(manifest_scope, str) or manifest_scope not in _SCOPE_NAMES:
        raise RetentionPersistenceError("invalid_manifest_scope")
    if scope is not None and manifest_scope != scope:
        raise RetentionPersistenceError("document_scope_mismatch")
    payload_size = manifest.get("payload_size_bytes")
    payload_digest = manifest.get("payload_sha256")
    if not isinstance(payload_size, int) or isinstance(payload_size, bool) or not 0 <= payload_size <= MAX_TOTAL_BYTES:
        raise RetentionPersistenceError("manifest_payload_size_invalid")
    if not isinstance(payload_digest, str) or re.fullmatch(r"[a-f0-9]{64}", payload_digest) is None:
        raise RetentionPersistenceError("manifest_payload_digest_invalid")

    arrays = _manifest_arrays(
        storage,
        manifest,
        plan_id=plan_id,
        kind=kind,
        scope=manifest_scope,
        payload_size=payload_size,
    )
    payload = manifest.get("payload")
    if not isinstance(payload, dict):
        raise RetentionPersistenceError("invalid_manifest_payload")
    record = payload
    for array_path, values in arrays.items():
        if _get_path(record, array_path) != _array_marker(array_path):
            raise RetentionPersistenceError("manifest_array_link_mismatch")
        _set_path(record, array_path, values)

    _validate_identity(record, plan_id, kind)
    if record.get("scope") != manifest_scope:
        raise RetentionPersistenceError("manifest_scope_mismatch")
    actual_size, actual_digest = _canonical_size_and_hash(record)
    if actual_size != payload_size or actual_digest != payload_digest:
        raise RetentionPersistenceError("manifest_payload_integrity_mismatch")
    return record


def _required_text(candidate: Mapping[str, Any], key: str) -> str:
    value = candidate.get(key)
    if not isinstance(value, str) or not value:
        raise RetentionPersistenceError("operation_candidate_identity_invalid")
    return value


def _required_nonnegative_integer(candidate: Mapping[str, Any], key: str) -> int:
    value = candidate.get(key)
    if (not isinstance(value, int) or isinstance(value, bool) or value < 0
            or len(str(value)) > MAX_INTEGER_DIGITS):
        raise RetentionPersistenceError('operation_candidate_size_invalid')
    return value


def _max_tree_identity() -> dict[str, Any]:
    maximum = int("9" * MAX_INTEGER_DIGITS)
    return {
        "logical_bytes": maximum,
        "files": maximum,
        "links": maximum,
        "fingerprint": "f" * 64,
        "root_device": maximum,
        "root_inode": maximum,
    }


def _max_inode_identity() -> dict[str, int]:
    maximum = int("9" * MAX_INTEGER_DIGITS)
    return {"device": maximum, "inode": maximum}


def operation_outcome_template(
    candidate: Mapping[str, Any],
    *,
    plan_id: str,
    scope: str,
    storage_root: str | os.PathLike[str],
) -> dict[str, Any]:
    """Measure a scope-specific maximal item including paths and fingerprints."""
    if not isinstance(candidate, Mapping):
        raise RetentionPersistenceError("invalid_operation_candidate")
    job_id = _required_text(candidate, "job_id")
    worktree_id = _required_text(candidate, "worktree_id")
    if not retention._valid_component(job_id) or not retention._valid_component(worktree_id):
        raise RetentionPersistenceError("operation_candidate_identity_invalid")
    if scope == "execution":
        target_text = _required_text(candidate, "execution")
        identity = candidate.get("tree_identity")
        if not isinstance(identity, Mapping):
            raise RetentionPersistenceError("operation_candidate_fingerprint_missing")
        target = Path(target_text)
        run_root = target.parent
        quarantine = run_root / (".retention-quarantine-" + plan_id)
        removed_bytes = _required_nonnegative_integer(candidate, "bytes")
        item = {
            "job_id": job_id,
            "status": "interrupted_unknown",
            "removed_logical_bytes": removed_bytes,
            "container_cleanup": {
                "removed_worker_container_id": "f" * 64,
                "directory_sync_capability": "supported",
                "directory_sync_required_for_success": True,
                "directory_entries_synced": True,
                "power_loss_qualification": "not_qualified",
            },
            "path": target_text,
            "quarantine_path": str(quarantine),
            "moved_path": str(quarantine / "execution"),
            "tree_identity": dict(identity),
            "run_root_identity": _max_inode_identity(),
            "deletion_state": "retention_quarantine_removal_not_confirmed",
            "quarantine_identity": _max_inode_identity(),
            "observed_tree_identity": _max_tree_identity(),
            "previous_deletion_state": "rename_outcome_unknown",
        }
        item.update(maximum_failure_fields(summary_key="reason", label="failure"))
        item["reason"] = "x" * max(0, MAX_OPTIONAL_ERROR_JSON_BYTES - 2)
        return item

    if scope == "runtime":
        target_text = candidate.get("package_path", candidate.get("path"))
        if not isinstance(target_text, str) or not target_text:
            raise RetentionPersistenceError("operation_candidate_path_missing")
        package_tree = candidate.get("package_tree")
        if not isinstance(package_tree, Mapping):
            raise RetentionPersistenceError("operation_candidate_fingerprint_missing")
        removed_bytes = _required_nonnegative_integer(candidate, "size_bytes")
        receipt_digest = candidate.get("build_receipt_sha256")
        if not isinstance(receipt_digest, str) or re.fullmatch(r"[a-f0-9]{64}", receipt_digest) is None:
            raise RetentionPersistenceError("operation_candidate_fingerprint_invalid")
        target = Path(target_text)
        run_root = Path(storage_root) / "runs" / worktree_id / job_id
        tombstone = run_root / "artifacts" / "runtime-package-retention.json"
        quarantine = run_root / (".runtime-package-quarantine-" + plan_id)
        item = {
            "job_id": job_id,
            "status": "interrupted_unknown",
            "removed_logical_bytes": removed_bytes,
            "path": target_text,
            "tombstone": str(tombstone),
            "quarantine_path": str(quarantine),
            "moved_path": str(quarantine / "package"),
            "build_receipt_sha256": candidate.get("build_receipt_sha256"),
            "package_tree_identity": dict(package_tree),
            "run_root_identity": _max_inode_identity(),
            "deletion_state": "runtime_quarantine_removal_not_confirmed",
            "quarantine_identity": _max_inode_identity(),
            "observed_package_tree": _max_tree_identity(),
            "previous_deletion_state": "rename_outcome_unknown",
            "reconciliation_error": "x" * max(0, MAX_OPTIONAL_ERROR_JSON_BYTES - 2),
            "reconciliation_type": _MAX_ERROR_COMPONENT_DISPLAY,
            "reconciliation_type_bytes": int("9" * MAX_DYNAMIC_BYTE_COUNT),
            "reconciliation_type_sha256": "f" * 64,
            "reconciliation_type_omitted": False,
            "reconciliation_code": _MAX_ERROR_COMPONENT_DISPLAY,
            "reconciliation_code_bytes": int("9" * MAX_DYNAMIC_BYTE_COUNT),
            "reconciliation_code_sha256": "f" * 64,
            "reconciliation_code_omitted": False,
            "reconciliation_message_bytes": int("9" * MAX_DYNAMIC_BYTE_COUNT),
            "reconciliation_message_sha256": "f" * 64,
            "reconciliation_message_omitted": False,
            "_optional_error_json_bytes": 0,
        }
        item.update(maximum_failure_fields(summary_key="reason", label="failure"))
        # The first failure can consume the whole shared optional-text budget.
        # A later recovery failure still needs its mandatory readable type/code
        # prefix even when its human message is omitted.
        item["reason"] = "x" * max(0, MAX_OPTIONAL_ERROR_JSON_BYTES - 2)
        item["reconciliation_error"] = (
            f"{_MAX_ERROR_COMPONENT_DISPLAY}: {_MAX_ERROR_COMPONENT_DISPLAY}: "
            "diagnostic message omitted"
        )
        item["reconciliation_message_omitted"] = True
        item["_optional_error_json_bytes"] = MAX_OPTIONAL_ERROR_JSON_BYTES
        return item

    if scope == "sources":
        source_text = _required_text(candidate, "path")
        source_digest = _required_text(candidate, "source_digest")
        manifest_digest = _required_text(candidate, "manifest_sha256")
        source = Path(source_text)
        capture_id = source.parent.name
        receipt_path = (
            Path(storage_root)
            / "index"
            / "source-compaction"
            / worktree_id
            / (capture_id + ".json")
        )
        maximum = int("9" * MAX_INTEGER_DIGITS)
        item = {
            "job_id": job_id,
            "status": "partial_error",
            "path": source_text,
            "compaction": {
                "state": "completed_with_protected_files",
                "source_digest": source_digest,
                "converted_count": maximum,
                "skipped_count": maximum,
                "protected_count": maximum,
                "logical_duplicate_bytes": maximum,
                "receipt_path": str(receipt_path),
            },
        }
        if not re.fullmatch(r"[a-f0-9]{64}", manifest_digest):
            raise RetentionPersistenceError("operation_candidate_fingerprint_invalid")
        item.update(maximum_failure_fields(summary_key="reason", label="failure"))
        return item

    raise RetentionPersistenceError("invalid_document_scope")


def preflight_operation_evidence(
    result: Mapping[str, Any],
    candidates: Iterable[Mapping[str, Any]],
    *,
    plan_id: str,
    scope: str,
    outcome_template: Callable[[Mapping[str, Any]], Mapping[str, Any]],
    final_fields: Mapping[str, Any],
) -> dict[str, int]:
    """Prove a bounded complete receipt can be represented before mutation."""
    if not isinstance(result, Mapping) or result.get("plan_id") != plan_id:
        raise RetentionPersistenceError("invalid_operation_result")
    if scope not in _SCOPE_NAMES or result.get("scope") != scope:
        raise RetentionPersistenceError("operation_scope_mismatch")
    if not isinstance(plan_id, str) or _PLAN_ID.fullmatch(plan_id) is None:
        raise RetentionPersistenceError("invalid_plan_id")
    if result.get("items") != []:
        raise RetentionPersistenceError("operation_preflight_requires_empty_items")

    max_result = dict(result)
    max_result.update(dict(final_fields))
    max_result["items"] = []
    base_size = len(_canonical_bytes(max_result))
    item_sizes: list[int] = []
    last_item: dict[str, Any] | None = None
    count = 0
    total_item_bytes = 0

    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            raise RetentionPersistenceError("invalid_operation_candidate")
        item = dict(outcome_template(candidate))
        raw = _canonical_bytes(item)
        if len(raw) > MAX_ENTRY_BYTES:
            raise RetentionPersistenceError("operation_outcome_entry_exceeded")
        count += 1
        if count - 1 > MAX_PART_COUNT:
            raise RetentionPersistenceError("operation_part_count_exceeded")
        item_sizes.append(len(raw))
        total_item_bytes += len(raw)
        last_item = item

    payload_size = base_size + total_item_bytes + max(0, count - 1)
    if payload_size > MAX_TOTAL_BYTES:
        raise RetentionPersistenceError("operation_payload_budget_exceeded")

    descriptors = []
    for index, size in enumerate(item_sizes[:-1]):
        name = _part_filename(plan_id, "operation", scope, ("items",), index, "0" * 64)
        descriptors.append(
            {"index": index, "name": name, "size_bytes": size, "sha256": "0" * 64}
        )
    arrays = [
        {
            "path": ["items"],
            "array_id": _array_id(("items",)),
            "count": count,
            "has_active_item": count > 0,
            "parts": descriptors,
            **({"active_item": last_item} if count > 0 else {}),
        }
    ]
    skeleton = _clone_skeleton(max_result, {("items",)})
    manifest_template = _manifest_template(
        plan_id=plan_id,
        kind="operation",
        scope=scope,
        payload=skeleton,
        payload_size=payload_size,
        payload_digest="0" * 64,
        arrays=arrays,
    )
    manifest_size = _pretty_json_size(manifest_template)
    if manifest_size > MAX_MANIFEST_BYTES:
        raise RetentionPersistenceError("operation_manifest_budget_exceeded")
    if len(descriptors) > MAX_PART_COUNT:
        raise RetentionPersistenceError("operation_part_count_exceeded")
    return {
        "candidate_count": count,
        "payload_size_bytes": payload_size,
        "item_bytes": total_item_bytes,
        "part_count": len(descriptors),
        "manifest_size_bytes": manifest_size,
    }
