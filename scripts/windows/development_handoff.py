"""Bounded, integrity-checked persistence for Windows authoring handoffs.

This module stores authoring data for a launcher to consume. It does not stop
processes, restore a solver checkpoint, or prove that a later restore succeeded.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import uuid
from typing import Any, Mapping, Sequence


_STORAGE_MODULE_PATH = Path(__file__).resolve().parents[1] / "fullmag_storage.py"
_STORAGE_SPEC = importlib.util.spec_from_file_location(
    "_fullmag_development_handoff_storage", _STORAGE_MODULE_PATH
)
if _STORAGE_SPEC is None or _STORAGE_SPEC.loader is None:  # pragma: no cover - packaging failure
    raise ImportError(f"Cannot load Fullmag storage validators from {_STORAGE_MODULE_PATH}")
_STORAGE = importlib.util.module_from_spec(_STORAGE_SPEC)
_STORAGE_SPEC.loader.exec_module(_STORAGE)


SCHEMA = "fullmag.development-authoring-handoff.v1"
SCENE_ASSET_SCHEMA = "fullmag.development-authoring-handoff.v2"
EMPTY_WORKSPACE_SCHEMA = "fullmag.development-empty-workspace-handoff.v1"
RECEIPT_SCHEMA = "fullmag.development-authoring-handoff-receipt.v1"
HANDOFF_DIRECTORY = "development-handoffs"
MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
MAX_RECEIPT_BYTES = 16 * 1024
MAX_HANDOFF_BYTES = 256 * 1024 * 1024
MAX_ASSET_COUNT = 512
MAX_BINDING_TEXT = 256
MAX_DETAIL_LENGTH = 2048
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SOURCE_SUFFIX = re.compile(r"(?:\.[A-Za-z0-9]{1,16})?")
_UUID_FIELDS = ("api_instance_id", "generation_id")
_SESSION_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_BINDING_FIELDS = frozenset(
    {
        "api_instance_id",
        "session_id",
        "session_epoch",
        "generation_id",
        "source_build_id",
        "target_build_id",
        "source_sha256",
    }
)
_PAYLOAD_FIELDS = frozenset({"scene", "editor", "workspace", "project_document"})
_SNAPSHOT_FIELDS = frozenset(
    {
        "schema",
        "snapshot_id",
        "binding",
        "payload",
        "component_sha256",
        "payload_sha256",
        "assets",
    }
)
_RECEIPT_FIELDS = frozenset(
    {
        "schema",
        "snapshot_id",
        "snapshot_sha256",
        "binding_sha256",
        "state",
        "detail",
        "recorded_at",
        "receipt_sha256",
    }
)


class HandoffError(ValueError):
    """Raised when handoff data, identity, or filesystem state is invalid."""


def _canonical_json(value: Any, label: str, limit: int) -> bytes:
    try:
        _assert_json_data(value, label)
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8", errors="strict")
    except (TypeError, ValueError, RecursionError, UnicodeEncodeError) as error:
        raise HandoffError(f"{label} must be bounded JSON data without NaN or duplicate-compatible keys") from error
    if len(encoded) > limit:
        raise HandoffError(f"{label} exceeds the {limit}-byte limit")
    return encoded


def _assert_json_data(value: Any, label: str, depth: int = 0) -> None:
    if depth > 256:
        raise HandoffError(f"{label} exceeds the maximum JSON nesting depth")
    if value is None or type(value) in (bool, int, str):
        return
    if type(value) is float:
        if not math.isfinite(value):
            raise HandoffError(f"{label} contains a non-finite JSON number")
        return
    if type(value) is list:
        for item in value:
            _assert_json_data(item, label, depth + 1)
        return
    if type(value) is dict:
        for key, item in value.items():
            if not isinstance(key, str):
                raise HandoffError(f"{label} contains a non-string JSON object key")
            _assert_json_data(item, label, depth + 1)
        return
    raise HandoffError(f"{label} contains a non-JSON value of type {type(value).__name__}")


def _reject_constant(value: str) -> None:
    raise HandoffError(f"Non-finite JSON number is not allowed: {value}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise HandoffError(f"Duplicate JSON object key: {key}")
        result[key] = value
    return result


def _strict_json(data: bytes, label: str) -> Any:
    try:
        return json.loads(
            data.decode("utf-8", errors="strict"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except HandoffError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise HandoffError(f"{label} is not valid UTF-8 JSON") from error


def _exact_keys(value: Any, expected: frozenset[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise HandoffError(f"{label} must contain exactly: {', '.join(sorted(expected))}")
    return value


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _validate_binding(value: Any, *, allow_empty_session: bool = False) -> dict[str, Any]:
    binding = _exact_keys(value, _BINDING_FIELDS, "binding")
    normalized = dict(binding)
    for field in _UUID_FIELDS:
        item = normalized[field]
        if not isinstance(item, str):
            raise HandoffError(f"binding.{field} must be a UUID")
        try:
            parsed = uuid.UUID(item)
        except (ValueError, AttributeError) as error:
            raise HandoffError(f"binding.{field} must be a UUID") from error
        if item not in {str(parsed), parsed.hex}:
            raise HandoffError(f"binding.{field} must use lowercase canonical UUID spelling")
    session_id = normalized["session_id"]
    if allow_empty_session and session_id is None:
        pass
    elif not isinstance(session_id, str) or not _SESSION_ID.fullmatch(session_id):
        raise HandoffError("binding.session_id must be a bounded opaque session identity")
    epoch = normalized["session_epoch"]
    if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch < 0:
        raise HandoffError("binding.session_epoch must be a non-negative integer")
    for field in ("source_build_id", "target_build_id"):
        item = normalized[field]
        if (
            not isinstance(item, str)
            or not item
            or len(item) > MAX_BINDING_TEXT
            or any(ord(character) < 32 for character in item)
        ):
            raise HandoffError(f"binding.{field} must be a non-empty bounded string")
    digest = normalized["source_sha256"]
    if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
        raise HandoffError("binding.source_sha256 must be a lowercase SHA256 hex digest")
    return normalized


def _validate_runtime_root(value: os.PathLike[str] | str) -> Path:
    try:
        root = _STORAGE.absolute(value, "development handoff runtime root")
    except (OSError, _STORAGE.StorageError, TypeError, ValueError) as error:
        raise HandoffError(str(error)) from error
    if not root.is_dir():
        raise HandoffError("Development handoff runtime root must be an existing directory")
    _require_directory(root, root, "development handoff runtime root")
    return root


def _contained_path(value: os.PathLike[str] | str, root: Path, label: str) -> Path:
    try:
        return _STORAGE.validate_path(value, root, label)
    except (OSError, _STORAGE.StorageError, TypeError, ValueError) as error:
        raise HandoffError(str(error)) from error


def _is_reparse_point(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _require_directory(path: Path, root: Path, label: str) -> None:
    _contained_path(path, root, label)
    try:
        info = path.lstat()
    except OSError as error:
        raise HandoffError(f"Cannot inspect {label}: {path}") from error
    if _is_reparse_point(info) or not stat.S_ISDIR(info.st_mode):
        raise HandoffError(f"{label} must be a real directory inside the runtime root")


def _require_regular_file(path: Path, root: Path, label: str) -> os.stat_result:
    _contained_path(path, root, label)
    try:
        info = path.lstat()
    except OSError as error:
        raise HandoffError(f"Cannot inspect {label}: {path}") from error
    if _is_reparse_point(info) or not stat.S_ISREG(info.st_mode):
        raise HandoffError(f"{label} must be a regular file inside the runtime root")
    if getattr(info, "st_nlink", 1) != 1:
        raise HandoffError(f"{label} must not have filesystem aliases")
    return info


def _open_regular(path: Path, root: Path, label: str) -> tuple[int, os.stat_result]:
    before = _require_regular_file(path, root, label)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
    except OSError as error:
        raise HandoffError(f"Cannot open {label}: {path}") from error
    if (
        not stat.S_ISREG(opened.st_mode)
        or _is_reparse_point(opened)
        or getattr(opened, "st_nlink", 1) != 1
        or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
    ):
        os.close(descriptor)
        raise HandoffError(f"{label} changed while it was being opened")
    return descriptor, opened


def _read_limited(path: Path, root: Path, label: str, limit: int) -> bytes:
    descriptor, initial = _open_regular(path, root, label)
    try:
        if initial.st_size > limit:
            raise HandoffError(f"{label} exceeds the {limit}-byte read limit")
        chunks: list[bytes] = []
        total = 0
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            while True:
                chunk = stream.read(min(1024 * 1024, limit + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > limit:
                    raise HandoffError(f"{label} exceeds the {limit}-byte read limit")
        final = os.fstat(descriptor)
        if (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns) != (
            initial.st_dev,
            initial.st_ino,
            initial.st_size,
            initial.st_mtime_ns,
        ):
            raise HandoffError(f"{label} changed while it was being read")
        if total != final.st_size:
            raise HandoffError(f"{label} was truncated while it was being read")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _write_new_file(path: Path, root: Path, data: bytes, label: str) -> None:
    _contained_path(path, root, label)
    if path.exists() or path.is_symlink():
        raise HandoffError(f"Refusing to overwrite existing {label}: {path}")
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        raise HandoffError(f"Cannot atomically create {label}: {path}") from error
    _require_regular_file(path, root, label)


def _atomic_replace(path: Path, root: Path, data: bytes, label: str) -> None:
    _contained_path(path, root, label)
    if path.exists() or path.is_symlink():
        _require_regular_file(path, root, label)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    _contained_path(temporary, root, f"temporary {label}")
    try:
        _write_new_file(temporary, root, data, f"temporary {label}")
        _contained_path(path, root, label)
        if path.exists() or path.is_symlink():
            _require_regular_file(path, root, label)
        os.replace(temporary, path)
        _require_regular_file(path, root, label)
        _fsync_directory(path.parent)
    except OSError as error:
        raise HandoffError(f"Cannot atomically update {label}: {path}") from error
    finally:
        if temporary.exists() and not temporary.is_symlink():
            temporary.unlink()


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    try:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        # File fsync remains mandatory; some supported filesystems do not
        # permit opening directories for fsync.
        return


def _handoff_root(runtime_root: Path, *, create: bool = False) -> Path:
    root = _contained_path(runtime_root / HANDOFF_DIRECTORY, runtime_root, "development handoff directory")
    if create:
        try:
            root.mkdir(exist_ok=True)
        except OSError as error:
            raise HandoffError(f"Cannot create development handoff directory: {root}") from error
    _require_directory(root, runtime_root, "development handoff directory")
    return root


def _encode_receipt(value: dict[str, Any]) -> bytes:
    return _canonical_json(value, "handoff receipt", MAX_RECEIPT_BYTES)


def _asset_inputs(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, (list, tuple)) or len(value) > MAX_ASSET_COUNT:
        raise HandoffError(f"assets must be an explicit list of at most {MAX_ASSET_COUNT} entries")
    result = []
    seen_ids: set[str] = set()
    for index, item in enumerate(value):
        asset = _exact_keys(item, frozenset({"asset_id", "source_path", "sha256"}), f"assets[{index}]")
        asset_id = asset["asset_id"]
        if (
            not isinstance(asset_id, str)
            or not asset_id
            or len(asset_id) > 256
            or any(ord(character) < 32 for character in asset_id)
        ):
            raise HandoffError(f"assets[{index}].asset_id must be a bounded non-empty string")
        if asset_id in seen_ids:
            raise HandoffError(f"Duplicate asset id: {asset_id}")
        seen_ids.add(asset_id)
        source_path = asset["source_path"]
        if not isinstance(source_path, str) or not source_path:
            raise HandoffError(f"assets[{index}].source_path must be an absolute runtime-root path")
        digest = asset["sha256"]
        if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
            raise HandoffError(f"assets[{index}].sha256 must be a lowercase SHA256 hex digest")
        result.append({"asset_id": asset_id, "source_path": source_path, "sha256": digest})
    return result


def _copy_asset(
    source: Path,
    destination: Path,
    runtime_root: Path,
    staging_root: Path,
    expected_digest: str,
    remaining_budget: int,
) -> int:
    descriptor, initial = _open_regular(source, runtime_root, "handoff asset source")
    if initial.st_size <= 0:
        os.close(descriptor)
        raise HandoffError("Referenced handoff assets must not be empty")
    if initial.st_size > remaining_budget:
        os.close(descriptor)
        raise HandoffError("Handoff assets exceed the total capsule size limit")
    _contained_path(destination, staging_root, "handoff asset copy")
    digest = hashlib.sha256()
    total = 0
    duplicate = destination.exists()
    if duplicate:
        _require_regular_file(destination, staging_root, "deduplicated handoff asset")
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        output_descriptor = None if duplicate else os.open(destination, flags, 0o600)
        output_stream = None
        try:
            with os.fdopen(descriptor, "rb", closefd=False) as source_stream:
                output_stream = os.fdopen(output_descriptor, "wb") if output_descriptor is not None else None
                try:
                    while True:
                        chunk = source_stream.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > remaining_budget:
                            raise HandoffError("Handoff assets exceed the total capsule size limit")
                        digest.update(chunk)
                        if output_stream is not None:
                            output_stream.write(chunk)
                    if output_stream is not None:
                        output_stream.flush()
                        os.fsync(output_stream.fileno())
                finally:
                    if output_stream is not None:
                        output_stream.close()
        finally:
            if output_descriptor is not None and output_stream is None:
                os.close(output_descriptor)
        final = os.fstat(descriptor)
        if (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns) != (
            initial.st_dev,
            initial.st_ino,
            initial.st_size,
            initial.st_mtime_ns,
        ):
            raise HandoffError("Handoff asset source changed while it was being copied")
    except OSError as error:
        raise HandoffError(f"Cannot copy handoff asset: {source}") from error
    finally:
        os.close(descriptor)
    if total != initial.st_size or digest.hexdigest() != expected_digest:
        raise HandoffError(f"Handoff asset SHA256 or size does not match: {source}")
    if not duplicate:
        _require_regular_file(destination, staging_root, "handoff asset copy")
    else:
        existing = _read_limited(destination, staging_root, "deduplicated handoff asset", remaining_budget)
        if _sha256(existing) != expected_digest:
            raise HandoffError("Content-addressed handoff asset path contains different bytes")
    return total


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _new_receipt(
    snapshot_id: str,
    snapshot_sha256: str,
    binding_sha256: str,
    state: str,
    detail: str | None,
) -> dict[str, Any]:
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "snapshot_id": snapshot_id,
        "snapshot_sha256": snapshot_sha256,
        "binding_sha256": binding_sha256,
        "state": state,
        "detail": detail,
        "recorded_at": _utc_now(),
    }
    receipt["receipt_sha256"] = _sha256(_canonical_json(receipt, "handoff receipt", MAX_RECEIPT_BYTES))
    return receipt


def create_handoff(
    runtime_root: os.PathLike[str] | str,
    binding: Mapping[str, Any],
    scene: dict[str, Any],
    editor: Any,
    workspace: Any,
    project_document: Any,
    *,
    assets: Sequence[Mapping[str, str]],
) -> dict[str, str]:
    """Atomically stage an immutable authoring snapshot and its initial receipt.

    The caller owns semantic reference enumeration. ``assets`` must be passed
    explicitly, including ``[]`` when the SceneDocument references no external
    files. Every source must be a regular file inside ``runtime_root`` and its
    bytes are copied into the capsule after matching the supplied SHA256.
    """
    root = _validate_runtime_root(runtime_root)
    return _stage_handoff(root, binding, scene, editor, workspace, project_document,
                          assets=assets, asset_source_root=root)


def _stage_handoff(
    runtime_root: Path,
    binding: Mapping[str, Any],
    scene: dict[str, Any] | None,
    editor: Any,
    workspace: Any,
    project_document: Any,
    *,
    assets: Sequence[Mapping[str, str]],
    asset_source_root: Path,
    verified_prior_assets: frozenset[str] = frozenset(),
    capsule_schema: str = SCHEMA,
    asset_suffixes: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Private stage boundary; semantic callers supply a resolved source root."""
    root = _validate_runtime_root(runtime_root)
    _require_directory(asset_source_root, asset_source_root, "handoff asset source root")
    _contained_path(root, asset_source_root, "handoff runtime root")
    if not isinstance(capsule_schema, str) or capsule_schema not in {
        SCHEMA,
        SCENE_ASSET_SCHEMA,
        EMPTY_WORKSPACE_SCHEMA,
    }:
        raise HandoffError("Unknown handoff writer schema")
    empty_workspace = capsule_schema == EMPTY_WORKSPACE_SCHEMA
    normalized_binding = _validate_binding(binding, allow_empty_session=empty_workspace)
    if empty_workspace:
        if normalized_binding["session_id"] is not None:
            raise HandoffError("Empty-workspace handoff must not claim a session identity")
        if scene is not None:
            raise HandoffError("Empty-workspace handoff must not contain a scene")
    elif not isinstance(scene, dict):
        raise HandoffError("scene must be the complete canonical SceneDocument JSON object")
    payload = {
        "scene": scene,
        "editor": editor,
        "workspace": workspace,
        "project_document": project_document,
    }
    payload_bytes = _canonical_json(payload, "handoff payload", MAX_SNAPSHOT_BYTES)
    normalized_payload = _strict_json(payload_bytes, "handoff payload")
    component_hashes = {
        name: _sha256(_canonical_json(normalized_payload[name], f"payload.{name}", MAX_SNAPSHOT_BYTES))
        for name in sorted(_PAYLOAD_FIELDS)
    }
    payload_hash = _sha256(payload_bytes)
    normalized_assets = _asset_inputs(assets)
    if empty_workspace:
        if normalized_assets:
            raise HandoffError("Empty-workspace handoff cannot contain assets")
        if asset_suffixes is not None or verified_prior_assets:
            raise HandoffError("Empty-workspace handoff cannot declare asset metadata")
    elif capsule_schema == SCENE_ASSET_SCHEMA:
        if asset_suffixes is None or set(asset_suffixes) != {asset["asset_id"] for asset in normalized_assets}:
            raise HandoffError("Semantic handoff requires a source suffix for every asset")
        if any(not isinstance(suffix, str) or not _SOURCE_SUFFIX.fullmatch(suffix)
               for suffix in asset_suffixes.values()):
            raise HandoffError("Scene asset source suffix is not a bounded file extension")
    elif asset_suffixes is not None:
        raise HandoffError("Legacy handoff cannot declare semantic source suffixes")
    handoff_root = _handoff_root(root, create=True)
    binding_hash = _sha256(_canonical_json(normalized_binding, "handoff binding", 4096))

    for _ in range(4):
        snapshot_id = str(uuid.uuid4())
        final_dir = _contained_path(handoff_root / snapshot_id, root, "handoff capsule")
        staging_dir = _contained_path(handoff_root / f".creating-{snapshot_id}", root, "handoff staging directory")
        if final_dir.exists() or final_dir.is_symlink() or staging_dir.exists() or staging_dir.is_symlink():
            continue
        try:
            staging_dir.mkdir()
            _require_directory(staging_dir, handoff_root, "handoff staging directory")
            asset_dir = _contained_path(staging_dir / "assets", staging_dir, "handoff assets directory")
            if normalized_assets:
                asset_dir.mkdir()
                _require_directory(asset_dir, staging_dir, "handoff assets directory")
            asset_manifest = []
            total_asset_bytes = 0
            for item in normalized_assets:
                source = _contained_path(item["source_path"], asset_source_root, f"asset {item['asset_id']} source")
                if _STORAGE.inside(source, handoff_root) and item["asset_id"] not in verified_prior_assets:
                    raise HandoffError("Handoff assets cannot reference another handoff capsule")
                suffix = asset_suffixes[item["asset_id"]] if asset_suffixes is not None else ".blob"
                asset_name = f"{item['sha256']}{suffix}"
                destination = _contained_path(asset_dir / asset_name, staging_dir, "handoff asset copy")
                size = _copy_asset(
                    source,
                    destination,
                    asset_source_root,
                    staging_dir,
                    item["sha256"],
                    MAX_HANDOFF_BYTES - MAX_SNAPSHOT_BYTES - total_asset_bytes,
                )
                total_asset_bytes += size
                asset_manifest.append(
                    {
                        "asset_id": item["asset_id"],
                        "path": f"assets/{asset_name}",
                        "sha256": item["sha256"],
                        "size_bytes": size,
                    }
                )
            if normalized_assets:
                _fsync_directory(asset_dir)

            snapshot = {
                "schema": capsule_schema,
                "snapshot_id": snapshot_id,
                "binding": normalized_binding,
                "payload": normalized_payload,
                "component_sha256": component_hashes,
                "payload_sha256": payload_hash,
                "assets": asset_manifest,
            }
            snapshot_bytes = _canonical_json(snapshot, "handoff snapshot", MAX_SNAPSHOT_BYTES)
            snapshot_hash = _sha256(snapshot_bytes)
            _write_new_file(staging_dir / "snapshot.json", staging_dir, snapshot_bytes, "handoff snapshot")
            receipt = _new_receipt(snapshot_id, snapshot_hash, binding_hash, "staged", None)
            _write_new_file(staging_dir / "receipt.json", staging_dir, _encode_receipt(receipt), "handoff receipt")
            _fsync_directory(staging_dir)
            if final_dir.exists() or final_dir.is_symlink():
                raise HandoffError("Generated handoff identity already exists")
            os.rename(staging_dir, final_dir)
            _require_directory(final_dir, root, "handoff capsule")
            _fsync_directory(handoff_root)
            return {
                "handoff_id": snapshot_id,
                "snapshot_sha256": snapshot_hash,
                "state": "staged",
            }
        except Exception:
            if staging_dir.exists() and staging_dir.is_dir() and not staging_dir.is_symlink():
                _contained_path(staging_dir, handoff_root, "owned handoff staging directory")
                shutil.rmtree(staging_dir)
            raise
    raise HandoffError("Could not allocate a unique handoff identity")


def _validate_receipt(
    value: Any,
    snapshot_id: str,
    snapshot_sha256: str,
    binding_sha256: str,
) -> dict[str, Any]:
    receipt = _exact_keys(value, _RECEIPT_FIELDS, "handoff receipt")
    receipt_content = {key: item for key, item in receipt.items() if key != "receipt_sha256"}
    receipt_hash = receipt["receipt_sha256"]
    if not isinstance(receipt_hash, str) or not _SHA256.fullmatch(receipt_hash):
        raise HandoffError("Handoff receipt SHA256 is invalid")
    if _sha256(_canonical_json(receipt_content, "handoff receipt", MAX_RECEIPT_BYTES)) != receipt_hash:
        raise HandoffError("Handoff receipt SHA256 does not match")
    if receipt["schema"] != RECEIPT_SCHEMA or receipt["snapshot_id"] != snapshot_id:
        raise HandoffError("Handoff receipt belongs to a different schema or snapshot")
    if receipt["snapshot_sha256"] != snapshot_sha256 or receipt["binding_sha256"] != binding_sha256:
        raise HandoffError("Handoff receipt does not match its snapshot or binding")
    if not isinstance(receipt["state"], str) or receipt["state"] not in {"staged", "restored", "failed"}:
        raise HandoffError("Handoff receipt has an invalid state")
    detail = receipt["detail"]
    if detail is not None and (
        not isinstance(detail, str)
        or len(detail) > MAX_DETAIL_LENGTH
        or any(ord(character) < 32 and character not in "\t\n\r" for character in detail)
    ):
        raise HandoffError("Handoff receipt detail is invalid")
    recorded_at = receipt["recorded_at"]
    if not isinstance(recorded_at, str) or not recorded_at.endswith("Z"):
        raise HandoffError("Handoff receipt timestamp is invalid")
    try:
        datetime.fromisoformat(recorded_at[:-1] + "+00:00")
    except ValueError as error:
        raise HandoffError("Handoff receipt timestamp is invalid") from error
    return receipt


def _validate_asset_manifest(value: Any, schema: str = SCHEMA) -> list[dict[str, Any]]:
    if not isinstance(schema, str) or schema not in {SCHEMA, SCENE_ASSET_SCHEMA, EMPTY_WORKSPACE_SCHEMA}:
        raise HandoffError("Unknown handoff asset manifest schema")
    if not isinstance(value, list) or len(value) > MAX_ASSET_COUNT:
        raise HandoffError("Handoff asset manifest is invalid or too large")
    result = []
    seen_ids: set[str] = set()
    total_bytes = 0
    for index, item in enumerate(value):
        asset = _exact_keys(
            item,
            frozenset({"asset_id", "path", "sha256", "size_bytes"}),
            f"handoff asset manifest entry {index}",
        )
        asset_id = asset["asset_id"]
        if not isinstance(asset_id, str) or not asset_id or asset_id in seen_ids or len(asset_id) > 256:
            raise HandoffError("Handoff asset manifest has an invalid or duplicate id")
        seen_ids.add(asset_id)
        digest = asset["sha256"]
        if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
            raise HandoffError("Handoff asset manifest has an invalid SHA256")
        path = asset["path"]
        prefix = f"assets/{digest}"
        valid_path = path == prefix + ".blob" if schema == SCHEMA else (
            isinstance(path, str) and path.startswith(prefix)
            and _SOURCE_SUFFIX.fullmatch(path[len(prefix):]) is not None
        )
        if not valid_path:
            raise HandoffError("Handoff asset path is not content-addressed within the capsule")
        size = asset["size_bytes"]
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise HandoffError("Handoff asset size is invalid")
        total_bytes += size
        if total_bytes > MAX_HANDOFF_BYTES - MAX_SNAPSHOT_BYTES:
            raise HandoffError("Handoff asset manifest exceeds the total capsule size limit")
        result.append(dict(asset))
    return result


def _load_capsule(
    runtime_root: Path,
    handoff_id: str,
    expected_binding: Mapping[str, Any],
) -> dict[str, Any]:
    try:
        parsed_id = uuid.UUID(handoff_id)
    except (ValueError, AttributeError, TypeError) as error:
        raise HandoffError("handoff_id must be a canonical UUID") from error
    if str(parsed_id) != handoff_id:
        raise HandoffError("handoff_id must use canonical UUID spelling")
    handoff_root = _handoff_root(runtime_root)
    capsule = _contained_path(handoff_root / str(parsed_id), runtime_root, "handoff capsule")
    _require_directory(capsule, runtime_root, "handoff capsule")
    snapshot_path = _contained_path(capsule / "snapshot.json", capsule, "handoff snapshot")
    receipt_path = _contained_path(capsule / "receipt.json", capsule, "handoff receipt")
    snapshot_bytes = _read_limited(snapshot_path, capsule, "handoff snapshot", MAX_SNAPSHOT_BYTES)
    receipt_bytes = _read_limited(receipt_path, capsule, "handoff receipt", MAX_RECEIPT_BYTES)
    snapshot_hash = _sha256(snapshot_bytes)
    snapshot = _strict_json(snapshot_bytes, "handoff snapshot")
    _exact_keys(snapshot, _SNAPSHOT_FIELDS, "handoff snapshot")
    if (not isinstance(snapshot["schema"], str)
            or snapshot["schema"] not in {SCHEMA, SCENE_ASSET_SCHEMA, EMPTY_WORKSPACE_SCHEMA}
            or snapshot["snapshot_id"] != str(parsed_id)):
        raise HandoffError("Handoff snapshot belongs to a different schema or identity")
    empty_workspace = snapshot["schema"] == EMPTY_WORKSPACE_SCHEMA
    normalized_expected = _validate_binding(expected_binding, allow_empty_session=empty_workspace)
    binding = _validate_binding(snapshot["binding"], allow_empty_session=empty_workspace)
    if empty_workspace and binding["session_id"] is not None:
        raise HandoffError("Empty-workspace handoff must not claim a session identity")
    if _canonical_json(binding, "snapshot binding", 4096) != _canonical_json(
        normalized_expected, "expected binding", 4096
    ):
        raise HandoffError("Handoff identity does not match the expected API, session, generation, or build")
    binding_hash = _sha256(_canonical_json(binding, "handoff binding", 4096))
    receipt = _validate_receipt(
        _strict_json(receipt_bytes, "handoff receipt"),
        str(parsed_id),
        snapshot_hash,
        binding_hash,
    )
    payload = _exact_keys(snapshot["payload"], _PAYLOAD_FIELDS, "handoff payload")
    if empty_workspace and payload["scene"] is not None:
        raise HandoffError("Empty-workspace handoff must not contain a scene")
    if not empty_workspace and not isinstance(payload["scene"], dict):
        raise HandoffError("Handoff scene is not a canonical SceneDocument JSON object")
    payload_bytes = _canonical_json(payload, "handoff payload", MAX_SNAPSHOT_BYTES)
    if _sha256(payload_bytes) != snapshot["payload_sha256"]:
        raise HandoffError("Handoff payload SHA256 does not match")
    component_hashes = _exact_keys(snapshot["component_sha256"], _PAYLOAD_FIELDS, "component hashes")
    for field in _PAYLOAD_FIELDS:
        digest = component_hashes[field]
        if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
            raise HandoffError(f"Handoff {field} SHA256 is invalid")
        if _sha256(_canonical_json(payload[field], f"payload.{field}", MAX_SNAPSHOT_BYTES)) != digest:
            raise HandoffError(f"Handoff {field} SHA256 does not match")

    asset_manifest = _validate_asset_manifest(snapshot["assets"], snapshot["schema"])
    if empty_workspace and asset_manifest:
        raise HandoffError("Empty-workspace handoff cannot contain assets")
    expected_entries = {"snapshot.json", "receipt.json"}
    if asset_manifest:
        expected_entries.add("assets")
        asset_dir = _contained_path(capsule / "assets", capsule, "handoff assets directory")
        _require_directory(asset_dir, capsule, "handoff assets directory")
        expected_asset_files = set()
        verified_assets = []
        for asset in asset_manifest:
            relative_path = asset["path"]
            asset_path = _contained_path(capsule / relative_path, capsule, "handoff asset")
            asset_bytes = _read_limited(asset_path, capsule, "handoff asset", asset["size_bytes"])
            if len(asset_bytes) != asset["size_bytes"] or _sha256(asset_bytes) != asset["sha256"]:
                raise HandoffError(f"Handoff asset integrity check failed: {asset['asset_id']}")
            expected_asset_files.add(asset_path.name)
            verified_assets.append({
                "asset_id": asset["asset_id"],
                "sha256": asset["sha256"],
                "size_bytes": asset["size_bytes"],
                "storage_path": str(asset_path),
            })
        try:
            actual_asset_files = {entry.name for entry in asset_dir.iterdir()}
        except OSError as error:
            raise HandoffError("Cannot inspect handoff asset directory") from error
        if actual_asset_files != expected_asset_files:
            raise HandoffError("Handoff asset directory contains missing or unclaimed files")
    else:
        verified_assets = []
    try:
        actual_entries = {entry.name for entry in capsule.iterdir()}
    except OSError as error:
        raise HandoffError("Cannot inspect handoff capsule") from error
    if actual_entries != expected_entries:
        raise HandoffError("Handoff capsule is incomplete or contains unrecognized files")

    return {
        "handoff_id": str(parsed_id),
        "schema": snapshot["schema"],
        "snapshot_sha256": snapshot_hash,
        "binding": binding,
        **payload,
        "assets": verified_assets,
        "receipt": receipt,
    }


def load_handoff(
    runtime_root: os.PathLike[str] | str,
    handoff_id: str,
    expected_binding: Mapping[str, Any],
) -> dict[str, Any]:
    """Load and verify a complete snapshot against the expected source identity."""
    root = _validate_runtime_root(runtime_root)
    return _load_capsule(root, handoff_id, expected_binding)


def _outcome_lock(runtime_root: Path, handoff_root: Path, handoff_id: str):
    lock_root = _contained_path(handoff_root / ".locks", runtime_root, "handoff receipt lock directory")
    if lock_root.exists():
        _require_directory(lock_root, runtime_root, "handoff receipt lock directory")
    else:
        try:
            lock_root.mkdir()
        except FileExistsError:
            pass
        except OSError as error:
            raise HandoffError("Cannot create handoff receipt lock directory") from error
        _require_directory(lock_root, runtime_root, "handoff receipt lock directory")
    lock = _contained_path(lock_root / f"{handoff_id}.lock", runtime_root, "handoff receipt lock")
    try:
        with lock.open("x", encoding="utf-8") as stream:
            stream.write(_utc_now())
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as error:
        raise HandoffError("Another launcher is recording this handoff outcome") from error
    except OSError as error:
        raise HandoffError("Cannot acquire handoff receipt lock") from error
    _require_regular_file(lock, runtime_root, "handoff receipt lock")
    return lock


def record_handoff_outcome(
    runtime_root: os.PathLike[str] | str,
    handoff_id: str,
    expected_binding: Mapping[str, Any],
    state: str,
    *,
    detail: str | None = None,
) -> dict[str, Any]:
    """Record staged, restored, or failed with guarded one-way transitions.

    ``staged`` is established by ``create_handoff``. The only subsequent
    transition is ``staged`` to ``restored`` or ``failed``. Exact replays are
    idempotent; terminal replays with different details or state are rejected.
    """
    if not isinstance(state, str) or state not in {"staged", "restored", "failed"}:
        raise HandoffError("Handoff outcome must be staged, restored, or failed")
    if detail is not None and (
        not isinstance(detail, str)
        or len(detail) > MAX_DETAIL_LENGTH
        or any(ord(character) < 32 and character not in "\t\n\r" for character in detail)
    ):
        raise HandoffError("Handoff outcome detail is invalid")
    root = _validate_runtime_root(runtime_root)
    loaded = _load_capsule(root, handoff_id, expected_binding)
    handoff_root = _handoff_root(root)
    lock = _outcome_lock(root, handoff_root, loaded["handoff_id"])
    try:
        # Re-read while holding the per-capsule lock so two launchers cannot
        # both make a transition based on a stale receipt.
        loaded = _load_capsule(root, loaded["handoff_id"], expected_binding)
        current = loaded["receipt"]
        if current["state"] == state and current["detail"] == detail:
            return current
        if current["state"] != "staged" or state not in {"restored", "failed"}:
            raise HandoffError(
                f"Illegal handoff outcome transition: {current['state']} -> {state}"
            )
        receipt = _new_receipt(
            loaded["handoff_id"],
            loaded["snapshot_sha256"],
            _sha256(_canonical_json(loaded["binding"], "handoff binding", 4096)),
            state,
            detail,
        )
        capsule = _contained_path(handoff_root / loaded["handoff_id"], root, "handoff capsule")
        receipt_path = _contained_path(capsule / "receipt.json", capsule, "handoff receipt")
        _atomic_replace(receipt_path, capsule, _encode_receipt(receipt), "handoff receipt")
        return receipt
    finally:
        try:
            _require_regular_file(lock, root, "handoff receipt lock")
            lock.unlink()
            _fsync_directory(lock.parent)
        except FileNotFoundError:
            pass
