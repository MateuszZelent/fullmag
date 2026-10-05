#!/usr/bin/env python3
"""Explicit enrollment and fail-closed resolution for disposable build storage."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import ntpath
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import posixpath
import re
import socket
import stat
from typing import Sequence
import uuid

try:
    import fullmag_storage as storage
except ImportError:  # Support importing as scripts.volatile_build_storage.
    from . import fullmag_storage as storage


SCHEMA = "fullmag.volatile_build_scratch.v1"
REGISTRY_RELATIVE_PATH = Path("index") / "volatile-build-scratch.json"
GATE_RELATIVE_PATH = Path("index") / ".volatile-build-scratch.gate"
DURABLE_MARKER_NAME = ".fullmag-storage.json"
SCRATCH_MARKER_NAME = ".fullmag-scratch.json"

_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_UUID_HEX_RE = re.compile(r"^[0-9a-f]{32}$")
_REGISTRY_KEYS = {"schema", "host_scratch_root", "scratch_id", "durable_marker_sha256"}
_MARKER_KEYS = _REGISTRY_KEYS | {"role", "generation"}


def _portable_path_key(value: str | os.PathLike[str], label: str) -> tuple[str, str]:
    """Normalize an absolute path without interpreting host paths in this OS view."""
    text = os.fspath(value)
    if not isinstance(text, str) or not text:
        raise storage.StorageError(f"{label} must be a non-empty absolute path")

    windows_path = PureWindowsPath(text)
    if windows_path.drive or text.startswith(("\\\\", "//")):
        if not windows_path.is_absolute():
            raise storage.StorageError(f"{label} must be an absolute path: {text}")
        return "windows", ntpath.normcase(ntpath.normpath(text))

    posix_path = PurePosixPath(text)
    if not posix_path.is_absolute():
        raise storage.StorageError(f"{label} must be an absolute path: {text}")
    return "posix", posixpath.normpath(text)


def _is_portable_root(value: str | os.PathLike[str], label: str) -> bool:
    family, normalized = _portable_path_key(value, label)
    if family == "posix":
        return normalized == "/"
    drive, _ = ntpath.splitdrive(os.fspath(value))
    return normalized == ntpath.normcase(ntpath.normpath(drive + ntpath.sep))


def _safe_absolute(value: str | os.PathLike[str], label: str) -> Path:
    try:
        return storage.absolute(value, label)
    except (TypeError, ValueError, OSError) as error:
        raise storage.StorageError(f"Cannot validate {label}: {error}") from error


def _directory_exists(path: Path, label: str, *, required: bool) -> bool:
    if storage.is_link(path):
        raise storage.StorageError(f"{label} must not be a symlink or junction: {path}")
    try:
        info = path.lstat()
    except FileNotFoundError:
        if required:
            raise storage.StorageError(f"{label} does not exist: {path}")
        return False
    except OSError as error:
        raise storage.StorageError(f"Cannot inspect {label} at {path}: {error}") from error
    if not stat.S_ISDIR(info.st_mode):
        raise storage.StorageError(f"{label} must be a regular directory: {path}")
    return True


def _regular_file_exists(path: Path, label: str, *, required: bool) -> bool:
    if storage.is_link(path):
        raise storage.StorageError(f"{label} must not be a symlink or junction: {path}")
    try:
        info = path.lstat()
    except FileNotFoundError:
        if required:
            raise storage.StorageError(f"{label} does not exist: {path}")
        return False
    except OSError as error:
        raise storage.StorageError(f"Cannot inspect {label} at {path}: {error}") from error
    if not stat.S_ISREG(info.st_mode):
        raise storage.StorageError(f"{label} must be a regular file: {path}")
    return True


def _validate_scratch_path(value: str | os.PathLike[str], label: str) -> Path:
    root = _safe_absolute(value, label)
    if _is_portable_root(root, label):
        raise storage.StorageError(f"{label} cannot be a filesystem, drive, or share root: {root}")

    anchor = Path(root.anchor)
    _directory_exists(anchor, f"{label} device root", required=True)
    parent = root.parent
    _safe_absolute(parent, f"{label} parent")
    _directory_exists(parent, f"{label} parent", required=True)
    _directory_exists(root, label, required=False)
    return root


def _ensure_no_overlap(
    scratch_root: Path,
    durable_root: Path,
    forbidden_roots: Sequence[Path],
) -> None:
    candidates = [(durable_root, "durable storage")]
    candidates.extend((Path(item), "forbidden checkout or project root") for item in forbidden_roots)
    for candidate, label in candidates:
        other = _safe_absolute(candidate, label)
        if storage.inside(scratch_root, other) or storage.inside(other, scratch_root):
            raise storage.StorageError(
                f"Volatile scratch root must not overlap {label}: {scratch_root} and {other}"
            )


def _load_json_file(path: Path, label: str) -> dict:
    _regular_file_exists(path, label, required=True)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise storage.StorageError(f"Invalid {label} at {path}: {error}") from error
    if not isinstance(data, dict):
        raise storage.StorageError(f"{label} must contain a JSON object: {path}")
    return data


def _durable_binding(durable_root: str | os.PathLike[str]) -> tuple[Path, str]:
    durable = _safe_absolute(durable_root, "durable storage root")
    _directory_exists(durable, "durable storage root", required=True)
    marker = storage.validate_path(durable / DURABLE_MARKER_NAME, durable, "durable storage marker")
    data = _load_json_file(marker, "durable storage marker")
    if set(data) != {"schema", "project_root"} or data.get("schema") != storage.SCHEMA or \
       not isinstance(data.get("project_root"), str) or not data["project_root"]:
        raise storage.StorageError(f"Durable storage marker has an unsupported schema or shape: {marker}")

    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    marker_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return durable, marker_hash


def _registry_path(durable_root: Path) -> Path:
    return storage.validate_path(
        durable_root / REGISTRY_RELATIVE_PATH, durable_root, "volatile scratch registry"
    )


def _gate_path(durable_root: Path) -> Path:
    return storage.validate_path(
        durable_root / GATE_RELATIVE_PATH, durable_root, "volatile scratch registry gate"
    )


def _read_registry(path: Path, *, required: bool) -> dict | None:
    if not _regular_file_exists(path, "volatile scratch registry", required=required):
        return None
    data = _load_json_file(path, "volatile scratch registry")
    if set(data) != _REGISTRY_KEYS or data.get("schema") != SCHEMA:
        raise storage.StorageError(f"Volatile scratch registry has an unsupported schema or shape: {path}")
    if not isinstance(data.get("host_scratch_root"), str) or \
       _is_portable_root(data["host_scratch_root"], "registered host scratch root"):
        raise storage.StorageError(f"Volatile scratch registry has an invalid host root: {path}")
    if not isinstance(data.get("scratch_id"), str) or not _UUID_HEX_RE.fullmatch(data["scratch_id"]):
        raise storage.StorageError(f"Volatile scratch registry has an invalid scratch ID: {path}")
    if not isinstance(data.get("durable_marker_sha256"), str) or \
       not _HASH_RE.fullmatch(data["durable_marker_sha256"]):
        raise storage.StorageError(f"Volatile scratch registry has an invalid durable marker hash: {path}")
    return data


def _read_scratch_marker(root: Path, registry: dict) -> dict:
    path = storage.validate_path(root / SCRATCH_MARKER_NAME, root, "volatile scratch marker")
    data = _load_json_file(path, "volatile scratch marker")
    if set(data) != _MARKER_KEYS or data.get("schema") != SCHEMA or \
       data.get("role") != "volatile_build_scratch":
        raise storage.StorageError(f"Volatile scratch marker has an unsupported schema or role: {path}")
    for key in _REGISTRY_KEYS - {"schema"}:
        if data.get(key) != registry.get(key):
            raise storage.StorageError(f"Volatile scratch marker does not match its durable enrollment: {path}")
    if not isinstance(data.get("generation"), str) or not _UUID_HEX_RE.fullmatch(data["generation"]):
        raise storage.StorageError(f"Volatile scratch marker has an invalid generation: {path}")
    return data


def _validate_registry_root(
    registry: dict,
    root: Path,
    host_root: str | os.PathLike[str] | None,
) -> None:
    registered_key = _portable_path_key(registry["host_scratch_root"], "registered host scratch root")
    if host_root is None:
        requested_key = _portable_path_key(root, "configured scratch root")
    else:
        requested_key = _portable_path_key(host_root, "trusted host scratch root alias")
    if requested_key != registered_key:
        raise storage.StorageError(
            "Configured volatile scratch root does not match the enrolled host root"
        )


def _entry_identity(path: Path, label: str, *, directory: bool) -> tuple[int, int] | None:
    if storage.is_link(path):
        raise storage.StorageError(f"{label} must not be a symlink or junction: {path}")
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise storage.StorageError(f"Cannot inspect {label} at {path}: {error}") from error
    expected_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not expected_type or not info.st_ino:
        raise storage.StorageError(f"{label} has an unexpected type or no stable filesystem identity: {path}")
    return int(info.st_dev), int(info.st_ino)


def _release_owned_gate(
    gate: Path,
    owner_path: Path,
    gate_identity: tuple[int, int],
    owner_identity: tuple[int, int],
    owner_text: str,
) -> bool:
    """Remove only our unchanged owner record and its now-empty gate directory."""
    try:
        if _entry_identity(gate, "volatile scratch gate", directory=True) != gate_identity:
            return False
        if _entry_identity(owner_path, "volatile scratch gate owner", directory=False) != owner_identity:
            return False
        if owner_path.read_text(encoding="utf-8") != owner_text:
            return False
        entries = list(gate.iterdir())
        if len(entries) != 1 or entries[0] != owner_path:
            return False

        owner_path.unlink()
        if _entry_identity(gate, "volatile scratch gate", directory=True) != gate_identity:
            return False
        if list(gate.iterdir()):
            return False
        gate.rmdir()
        return True
    except (OSError, storage.StorageError):
        return False


@contextmanager
def _registry_gate(durable_root: Path):
    """Admit one cross-view mutator with exclusive mkdir; never steal an existing gate."""
    index = storage.validate_path(durable_root / "index", durable_root, "storage index")
    _directory_exists(index, "storage index", required=True)
    gate = _gate_path(durable_root)
    try:
        gate.mkdir()
    except FileExistsError as error:
        raise storage.StorageError(
            f"Volatile scratch gate already exists; inspect it manually, no owner recovery is attempted: {gate}"
        ) from error
    except OSError as error:
        raise storage.StorageError(f"Cannot create volatile scratch gate {gate}: {error}") from error

    gate_identity = _entry_identity(gate, "volatile scratch gate", directory=True)
    if gate_identity is None:
        raise storage.StorageError(f"Created volatile scratch gate disappeared: {gate}")
    owner_path = storage.validate_path(gate / "owner.json", gate, "volatile scratch gate owner")
    if list(gate.iterdir()):
        raise storage.StorageError(f"New volatile scratch gate contains unexpected data: {gate}")
    owner = {
        "schema": "fullmag.volatile_build_scratch_gate.v1",
        "token": uuid.uuid4().hex,
        "host": socket.gethostname(),
        "pid": os.getpid(),
    }
    owner_text = json.dumps(owner, sort_keys=True, separators=(",", ":")) + "\n"
    try:
        with owner_path.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(owner_text)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        raise storage.StorageError(f"Cannot write volatile scratch gate owner {owner_path}: {error}") from error
    owner_identity = _entry_identity(owner_path, "volatile scratch gate owner", directory=False)
    if owner_identity is None or owner_path.read_text(encoding="utf-8") != owner_text:
        raise storage.StorageError(f"Cannot verify volatile scratch gate owner {owner_path}")
    if _entry_identity(gate, "volatile scratch gate", directory=True) != gate_identity:
        raise storage.StorageError(f"Volatile scratch gate changed during admission: {gate}")

    try:
        yield
    except BaseException:
        _release_owned_gate(gate, owner_path, gate_identity, owner_identity, owner_text)
        raise
    else:
        if not _release_owned_gate(gate, owner_path, gate_identity, owner_identity, owner_text):
            raise storage.StorageError(
                f"Volatile scratch gate ownership changed; gate left in place for inspection: {gate}"
            )


def _ensure_empty_or_missing_root(root: Path) -> None:
    exists = _directory_exists(root, "volatile scratch root", required=False)
    if not exists:
        _directory_exists(root.parent, "volatile scratch parent", required=True)
        return
    marker = storage.validate_path(root / SCRATCH_MARKER_NAME, root, "volatile scratch marker")
    if _regular_file_exists(marker, "volatile scratch marker", required=False):
        raise storage.StorageError(f"Unexpected marker in an unregistered volatile scratch root: {marker}")
    try:
        entries = list(root.iterdir())
    except OSError as error:
        raise storage.StorageError(f"Cannot inspect volatile scratch root {root}: {error}") from error
    if entries:
        raise storage.StorageError(f"Refusing to register non-empty, unmarked volatile scratch root: {root}")


def _ensure_root_exists(root: Path) -> None:
    if _directory_exists(root, "volatile scratch root", required=False):
        return
    _directory_exists(root.parent, "volatile scratch parent", required=True)
    try:
        root.mkdir()
    except FileExistsError:
        pass
    except OSError as error:
        raise storage.StorageError(f"Cannot create enrolled volatile scratch root {root}: {error}") from error
    _validate_scratch_path(root, "volatile scratch root")
    _directory_exists(root, "volatile scratch root", required=True)


def _write_scratch_marker(root: Path, registry: dict, generation: str) -> Path:
    marker = storage.validate_path(root / SCRATCH_MARKER_NAME, root, "volatile scratch marker")
    if _regular_file_exists(marker, "volatile scratch marker", required=False):
        raise storage.StorageError(f"Refusing to replace an existing volatile scratch marker: {marker}")
    try:
        storage.atomic_json(marker, {
            **registry,
            "role": "volatile_build_scratch",
            "generation": generation,
        })
    except OSError as error:
        raise storage.StorageError(f"Cannot write volatile scratch marker {marker}: {error}") from error
    _regular_file_exists(marker, "volatile scratch marker", required=True)
    return marker


def _evidence(
    durable_root: Path,
    root: Path,
    registry: dict,
    generation: str,
) -> dict:
    return {
        "scratch_root": str(root),
        "host_scratch_root": registry["host_scratch_root"],
        "scratch_id": registry["scratch_id"],
        "generation": generation,
        "durable_marker_sha256": registry["durable_marker_sha256"],
        "registration_path": str(_registry_path(durable_root)),
        "marker_path": str(storage.validate_path(root / SCRATCH_MARKER_NAME, root, "volatile scratch marker")),
    }


def register_scratch_root(
    durable_root: Path,
    scratch_root: Path,
    forbidden_roots: Sequence[Path] = (),
) -> dict:
    """Explicitly enroll one empty scratch root against project storage."""
    durable, marker_hash = _durable_binding(durable_root)
    root = _validate_scratch_path(scratch_root, "volatile scratch root")
    _ensure_no_overlap(root, durable, forbidden_roots)

    index = storage.validate_path(durable / "index", durable, "storage index")
    _directory_exists(index, "storage index", required=False)
    if not index.exists():
        try:
            index.mkdir()
        except FileExistsError:
            pass
        except OSError as error:
            raise storage.StorageError(f"Cannot create storage index {index}: {error}") from error
    _directory_exists(index, "storage index", required=True)

    registry_path = _registry_path(durable)
    with _registry_gate(durable):
        current_durable, current_hash = _durable_binding(durable)
        if current_durable != durable or current_hash != marker_hash:
            raise storage.StorageError("Durable storage marker changed during volatile scratch registration")
        registry = _read_registry(registry_path, required=False)
        if registry is not None:
            if registry["durable_marker_sha256"] != marker_hash:
                raise storage.StorageError("Existing volatile scratch enrollment is bound to a different durable marker")
            _validate_registry_root(registry, root, None)
            _directory_exists(root, "volatile scratch root", required=True)
            marker = _read_scratch_marker(root, registry)
            return _evidence(durable, root, registry, marker["generation"])

        _ensure_empty_or_missing_root(root)
        _ensure_root_exists(root)
        _ensure_empty_or_missing_root(root)
        registry = {
            "schema": SCHEMA,
            "host_scratch_root": str(root),
            "scratch_id": uuid.uuid4().hex,
            "durable_marker_sha256": marker_hash,
        }
        try:
            storage.atomic_json(registry_path, registry)
        except OSError as error:
            raise storage.StorageError(f"Cannot write volatile scratch registry {registry_path}: {error}") from error
        generation = uuid.uuid4().hex
        marker = _write_scratch_marker(root, registry, generation)
        _read_scratch_marker(root, registry)
        return _evidence(durable, root, registry, generation)


def resolve_scratch_root(
    durable_root: Path,
    configured_root: Path,
    *,
    initialize: bool = False,
    forbidden_roots: Sequence[Path] = (),
    host_root: str | None = None,
) -> dict:
    """Resolve enrolled scratch storage; never fall back to another location."""
    durable, marker_hash = _durable_binding(durable_root)
    root = _validate_scratch_path(configured_root, "configured volatile scratch root")
    _ensure_no_overlap(root, durable, forbidden_roots)

    registry_path = _registry_path(durable)
    registry = _read_registry(registry_path, required=True)
    if registry["durable_marker_sha256"] != marker_hash:
        raise storage.StorageError("Volatile scratch enrollment belongs to a different durable storage marker")
    _validate_registry_root(registry, root, host_root)

    root_exists = _directory_exists(root, "configured volatile scratch root", required=False)
    if root_exists:
        marker_path = storage.validate_path(root / SCRATCH_MARKER_NAME, root, "volatile scratch marker")
        if _regular_file_exists(marker_path, "volatile scratch marker", required=False):
            marker = _read_scratch_marker(root, registry)
            return _evidence(durable, root, registry, marker["generation"])
    elif not initialize:
        raise storage.StorageError(f"Enrolled volatile scratch root is missing: {root}")

    if not initialize:
        raise storage.StorageError(f"Enrolled volatile scratch marker is missing: {root / SCRATCH_MARKER_NAME}")

    with _registry_gate(durable):
        current_durable, current_hash = _durable_binding(durable)
        current_registry = _read_registry(registry_path, required=True)
        if current_durable != durable or current_hash != marker_hash or current_registry != registry:
            raise storage.StorageError("Volatile scratch enrollment changed while it was being initialized")
        root = _validate_scratch_path(configured_root, "configured volatile scratch root")
        _ensure_no_overlap(root, durable, forbidden_roots)
        _validate_registry_root(registry, root, host_root)
        _ensure_root_exists(root)

        marker_path = storage.validate_path(root / SCRATCH_MARKER_NAME, root, "volatile scratch marker")
        if _regular_file_exists(marker_path, "volatile scratch marker", required=False):
            marker = _read_scratch_marker(root, registry)
            return _evidence(durable, root, registry, marker["generation"])

        try:
            entries = list(root.iterdir())
        except OSError as error:
            raise storage.StorageError(f"Cannot inspect volatile scratch root {root}: {error}") from error
        if entries:
            raise storage.StorageError(
                f"Refusing to initialize non-empty enrolled scratch without its marker: {root}"
            )

        generation = uuid.uuid4().hex
        _write_scratch_marker(root, registry, generation)
        marker = _read_scratch_marker(root, registry)
        return _evidence(durable, root, registry, marker["generation"])


@contextmanager
def scratch_build_lease(durable_root: Path, configured_root: Path, expected_evidence: dict,
                        *, host_root: str | None = None):
    """Exclude reset for the complete write lifetime and reject changed generations."""
    durable, _ = _durable_binding(durable_root)
    with _registry_gate(durable):
        current = resolve_scratch_root(durable, configured_root, host_root=host_root)
        if current != expected_evidence:
            raise storage.StorageError("Scratch identity or generation changed before build admission")
        yield
        current = resolve_scratch_root(durable, configured_root, host_root=host_root)
        if current != expected_evidence:
            raise storage.StorageError("Scratch identity or generation changed during build")
