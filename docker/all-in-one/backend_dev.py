#!/usr/bin/env python3
"""Direct Compose builder and server for the all-in-one backend image.

Explicit prepare/build operations may receive the existing immutable source
archive.  Development start reads the mounted readonly checkout and Git common
directory itself, writes a closed live-source manifest in the image-owned ext4
build volume, synchronizes those inputs into an immutable shadow, invokes the
repository Make target with the complete CUDA/FEM feature set, and publishes
one package receipt.  The server only consumes a receipt-validated package and
then hands process ownership to the existing all-in-one entrypoint.

This command deliberately has no public build-command option.  The source
contract is data, never a shell script supplied by the caller, and the only
native build command is the canonical ``make install-cli-dev`` or ``make install-cli`` target selected by the validated Cargo profile.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, NoReturn

try:
    import fcntl
except ImportError:  # pragma: no cover - direct backend images are Linux
    fcntl = None  # type: ignore[assignment]

from backend_source import (
    BackendSourceError,
    capture_live_source_manifest,
    extract_frozen_source,
)


RECEIPT_SCHEMA = "fullmag.direct-compose.backend-build-receipt.v1"
LIVE_MANIFEST_SCHEMA = "fullmag.docker-backend-live-source.v1"
LIVE_SOURCE_MODE = "live-shadow-v1"
BACKEND_CARGO_PROFILE = "backend-dev"
SUPPORTED_CARGO_PROFILES = frozenset({"backend-dev", "release"})

MAX_MANIFEST_BYTES = 32 * 1024 * 1024
MAX_SOURCE_BYTES = 16 * 1024 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
GIT_OBJECT_RE = re.compile(r"^[0-9a-f]{40}$")
CAPTURE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")

BUILD_ROOT = Path("/build")
OUTPUT_ROOT = Path("/output")
PACKAGE_ROOT = Path("/opt/fullmag/package")
CONTROL_ROOT = Path("/opt/fullmag/control")
BACKEND_CONTROL_ROOT = CONTROL_ROOT / "backend"
PACKAGE_DEVELOPMENT_DIRNAME = ".development"
PACKAGE_CACHE_RECEIPT_NAME = "backend-volume-cache-receipt.json"
# Build/runtime control records are part of the per-Compose-group control
# named volume.  The host-facing Windows session bind and package volume must
# never be used for these records.
PROVENANCE_PATH = BACKEND_CONTROL_ROOT / "runtime-provenance.json"
CACHE_RECEIPT_PATH = BACKEND_CONTROL_ROOT / PACKAGE_CACHE_RECEIPT_NAME
HOST_ATTESTATION_PATH = Path("/run/fullmag/windows-folder-host.json")
WINDOWS_FOLDER_OWNER_PATH = Path("/state/.fullmag-windows-folder-owner.json")
WINDOWS_FOLDER_HOST_SCHEMA = "fullmag.windows-folder-host.v1"
WINDOWS_FOLDER_DEVELOPMENT_SCHEMA = "fullmag.windows-folder-development-build.v1"
WINDOWS_FOLDER_STORAGE_PROFILE = "windows-folder-v1"
WINDOWS_FOLDER_GATE_TIMEOUT_SECONDS = 120.0
WINDOWS_FOLDER_GATE_POLL_SECONDS = 0.25
PACKAGE_DEVELOPMENT_SCHEMA = "fullmag.direct-compose.package-development.v1"
PACKAGE_DEVELOPMENT_OWNER = "owner.json"
PACKAGE_CANDIDATES_DIRNAME = "candidates"
PACKAGE_BACKUPS_DIRNAME = "backups"
PACKAGE_RETENTION_ARCHIVE_DIRNAME = "retired"
PACKAGE_CANDIDATE_MARKER = ".candidate-owner.json"
PACKAGE_CANDIDATE_SCHEMA = "fullmag.direct-compose.package-candidate.v1"
PACKAGE_CANDIDATE_NAME_RE = re.compile(r"^\.backend-package-candidate-[A-Za-z0-9._-]+$")
PACKAGE_ROTATION_JOURNAL_NAME = "rotation.pending.json"
PACKAGE_ROTATION_JOURNAL_SCHEMA = "fullmag.direct-compose.package-rotation-journal.v1"
MAX_PACKAGE_ROTATION_CHILDREN = 256
MAX_PACKAGE_CANDIDATES = 4
MAX_LEGACY_INSTALL_STAGE_ENTRIES = 65536
MAX_LEGACY_INSTALL_STAGE_LINK_TARGET_BYTES = 4096
MAX_FAILED_CANDIDATE_ENTRIES = 16384
PACKAGE_CANDIDATE_OPTIONAL_FILES = frozenset(
    {
        PACKAGE_CANDIDATE_MARKER,
        "direct-backend-build.log",
        "install-cli-build.log",
        "install-cli-managed-fem-gpu.log",
        "source-identity.json",
    }
)
FAILED_CANDIDATE_DIAGNOSTIC_FILES = frozenset(
    {
        "backend-build-receipt.json",
        "direct-backend-build.log",
        "install-cli-build.log",
        "install-cli-managed-fem-gpu.log",
    }
)
MAX_RETENTION_ARCHIVES = 64
MAX_BUILD_LOG_BYTES = 64 * 1024 * 1024
PACKAGE_CACHE_CONTROL_DIRNAME = "cache-maintenance"
PACKAGE_CACHE_MARKER_NAME = ".fullmag-backend-cache-owner.json"
PACKAGE_CACHE_READBACK_NAME = ".fullmag-backend-cache-readback"
PACKAGE_RETENTION_SCHEMA = "fullmag.direct-compose.package-retention.v1"
PACKAGE_RETENTION_ARCHIVE_COUNT_LIMIT = 8
PACKAGE_RETENTION_ARCHIVE_BYTES_LIMIT = 64 * 1024 * 1024
FAILED_MAKE_DIAGNOSTICS_DIRNAME = "failed-candidate-diagnostics"
FAILED_MAKE_RECEIPT_NAME = "attempt.json"
FAILED_MAKE_LOG_NAME = "direct-backend-build.log"
FAILED_MAKE_SCHEMA = "fullmag.direct-compose.failed-make-attempt.v1"
FAILED_MAKE_RECORD_LIMIT = MAX_RETENTION_ARCHIVES
FAILED_MAKE_LOG_LIMIT = PACKAGE_RETENTION_ARCHIVE_COUNT_LIMIT
FAILED_MAKE_LOG_BYTES_LIMIT = PACKAGE_RETENTION_ARCHIVE_BYTES_LIMIT
FAILED_MAKE_RECEIPT_BYTES_LIMIT = 1024 * 1024
OWNER_MARKER = ".fullmag-direct-backend-owner.json"
WORKSPACE_INVENTORY_SCHEMA = "fullmag.direct-compose.workspace-inventory.v1"
RUNTIME_LOCK_NAME = ".fullmag-backend-runtime.lock"
PERSISTENT_WORKSPACE_DIRS = frozenset(
    {".fullmag-build", ".fullmag-cargo", ".fullmag-rustup"}
)
# Only these children are produced by the canonical Make install targets.
# The .fullmag root itself is retained across retries so an unexpected entry
# cannot be silently discarded as disposable build output.
OWNED_GENERATED_OUTPUT_DIRS = frozenset({"local", "runtimes"})
# Keep the worker-side source policy in lockstep with local_runner.source.
# String exclusions disclose omitted safe paths (for example ordinary
# untracked files); gitlink disclosures are restricted to this exact set.
ALLOWED_EXTERNAL_SOLVER_GITLINKS = frozenset(
    {
        "external_solvers/3",
        "external_solvers/amumax",
        "external_solvers/neuralmag",
        "external_solvers/oommf",
        "external_solvers/plus",
        "external_solvers/tetmag",
    }
)

# ``install-cli-dev`` emits one CUDA-capable binary.  Runtime execution
# profiles select the requested lane from that binary; these four entries are
# part of the receipt so host admission can reject a package missing a lane.
LANES = ("fdm-cpu", "fdm-gpu", "fem-cpu", "fem-gpu")
# Keep the direct development package discoverable by the same registry used by
# the Windows MSI.  These manifests describe runtime selection only; the
# receipt still binds the copied worker and native libraries to the source and
# toolchain identity below.
RUNTIME_MANIFEST_VERSION = "direct-compose-dev"
RUNTIME_MANIFEST_PATHS = (
    "runtimes/cpu-reference/manifest.json",
    "runtimes/fdm-cuda/manifest.json",
    "runtimes/fem-cpu-native/manifest.json",
    "runtimes/fem-gpu/manifest.json",
)
REQUIRED_PACKAGE_PATHS = (
    "bin/fullmag-bin",
    "bin/fullmag-api",
    "bin/fullmag-api-accepted-worker",
    "bin/fullmag-api-accepted-supervisor",
    "bin/fullmag-api-accepted-scheduler",
    "bin/fullmag-runtime-service",
    "bin/fullmag-api-resource-pool",
    "bin/fullmag-api-accepted-fem-preparer",
    "bin/fullmag-api-accepted-fem-preparation-supervisor",
    "bin/fullmag-api-accepted-fem-preparation-scheduler",
    "bin/fullmag-api-preparation-resource-pool",
    "bin/fullmag-api-preparation-retry",
    "_fullmag_core.so",
    "launcher-build-mode",
    *RUNTIME_MANIFEST_PATHS,
)


class BackendBuildError(RuntimeError):
    """A fail-closed direct backend build or package error."""


def _fail(message: str) -> NoReturn:
    raise BackendBuildError(message)


def _canonical(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _log_phase(phase: str, state: str, **fields: object) -> None:
    """Emit a bounded, flushable lifecycle marker without source contents."""

    allowed_fields = frozenset(
        {
            "bytes",
            "cache_mount",
            "duration_ms",
            "error",
            "exit_code",
            "estimated_bytes",
            "files",
            "free_bytes",
            "mode",
            "profile",
            "reason",
            "sparse",
            "target",
        }
    )
    parts = [f"phase={phase}", f"state={state}"]
    for name, value in fields.items():
        if name not in allowed_fields:
            continue
        if isinstance(value, bool):
            encoded = "true" if value else "false"
        elif isinstance(value, int):
            encoded = str(value)
        elif isinstance(value, float):
            encoded = f"{value:.3f}"
        elif isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,64}", value):
            encoded = value
        else:
            continue
        parts.append(f"{name}={encoded}")
    try:
        print("backend-dev: " + " ".join(parts), file=sys.stderr, flush=True)
    except (BrokenPipeError, OSError, ValueError):
        pass


def _sha256_file(path: Path, name: str, maximum: int | None = None) -> tuple[str, os.stat_result]:
    path = _absolute(path, name)
    descriptor = _open_regular(path, name, maximum)
    try:
        before = os.fstat(descriptor)
        digest = hashlib.sha256()
        total = 0
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            total += len(block)
            digest.update(block)
            if maximum is not None and total > maximum:
                _fail(f"{name} exceeds its size bound")
        after = os.fstat(descriptor)
        if _file_signature(before) != _file_signature(after):
            _fail(f"{name} changed while hashing")
        return digest.hexdigest(), before
    finally:
        os.close(descriptor)


def _file_signature(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _absolute(path: Path, name: str) -> Path:
    if not path.is_absolute() or any(part == ".." for part in path.parts):
        _fail(f"{name} must be absolute and cannot contain parent traversal")
    return path


def _assert_no_links(path: Path, name: str) -> None:
    path = _absolute(path, name)
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            _fail(f"cannot inspect {name}: {error}")
        if stat.S_ISLNK(metadata.st_mode) or bool(
            getattr(metadata, "st_file_attributes", 0) & 0x400
        ):
            _fail(f"{name} traverses a link or reparse point: {current}")


def _open_regular(path: Path, name: str, maximum: int | None) -> int:
    path = _absolute(path, name)
    _assert_no_links(path.parent, f"{name} parent")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        _fail(f"cannot open {name}: {error}")
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            _fail(f"{name} is not a regular file")
        if maximum is not None and metadata.st_size > maximum:
            _fail(f"{name} exceeds its size bound")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _read_regular(path: Path, name: str, maximum: int) -> tuple[bytes, os.stat_result]:
    descriptor = _open_regular(path, name, maximum)
    try:
        before = os.fstat(descriptor)
        data = bytearray()
        while len(data) <= maximum:
            block = os.read(descriptor, min(1024 * 1024, maximum + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        if len(data) > maximum:
            _fail(f"{name} exceeds its size bound")
        after = os.fstat(descriptor)
        if _file_signature(before) != _file_signature(after):
            _fail(f"{name} changed while reading")
        return bytes(data), before
    finally:
        os.close(descriptor)


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail(f"JSON object contains duplicate key {key!r}")
        result[key] = value
    return result


def _read_json(path: Path, name: str, maximum: int = MAX_MANIFEST_BYTES) -> tuple[dict[str, Any], bytes]:
    raw, _ = _read_regular(path, name, maximum)
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"{name} is not valid JSON: {error}")
    if not isinstance(value, dict):
        _fail(f"{name} must contain a JSON object")
    return value, raw


def _ensure_directory(path: Path, name: str) -> Path:
    path = _absolute(path, name)
    _assert_no_links(path, name)
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            try:
                current.mkdir()
            except FileExistsError:
                pass
            metadata = current.lstat()
        except OSError as error:
            _fail(f"cannot inspect {name}: {error}")
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            _fail(f"{name} component is not a directory: {current}")
    return path


def _remove_owned_tree(path: Path) -> None:
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode):
        # Remove only this owned directory entry; never traverse its target.
        path.unlink()
        return
    if bool(getattr(metadata, "st_file_attributes", 0) & 0x400):
        _fail(f"owned workspace contains a reparse point: {path}")
    if stat.S_ISDIR(metadata.st_mode):
        for child in path.iterdir():
            _remove_owned_tree(child)
        path.rmdir()
    elif stat.S_ISREG(metadata.st_mode):
        path.unlink()
    else:
        _fail(f"owned workspace contains a special file: {path}")


def _assert_safe_tree(path: Path, name: str) -> None:
    """Reject links, reparse points, and special files before retention work."""

    path = _absolute(path, name)
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & 0x400
    ):
        _fail(f"{name} contains a link or reparse point: {path}")
    if not stat.S_ISDIR(metadata.st_mode):
        _fail(f"{name} is not a directory: {path}")
    pending = [path]
    while pending:
        current = pending.pop()
        try:
            children = tuple(current.iterdir())
        except OSError as error:
            _fail(f"cannot inspect {name}: {error}")
        for child in children:
            child_metadata = child.lstat()
            if stat.S_ISLNK(child_metadata.st_mode) or bool(
                getattr(child_metadata, "st_file_attributes", 0) & 0x400
            ):
                _fail(f"{name} contains a link or reparse point: {child}")
            if stat.S_ISDIR(child_metadata.st_mode):
                pending.append(child)
            elif not stat.S_ISREG(child_metadata.st_mode):
                _fail(f"{name} contains a special file: {child}")


def _fsync_directory(path: Path, name: str) -> None:
    """Make directory-entry publication durable on the package mount."""

    path = _absolute(path, name)
    _assert_no_links(path, name)
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        _fail(f"cannot open {name} for durability: {error}")
    try:
        os.fsync(descriptor)
    except OSError as error:
        _fail(f"cannot fsync {name}: {error}")
    finally:
        os.close(descriptor)


def _fsync_owned_tree(
    path: Path, name: str, *, excluded_children: frozenset[str] = frozenset()
) -> None:
    """Durably sync one verified package tree without hashing it again."""

    path = _absolute(path, name)
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & 0x400
    ):
        _fail(f"{name} contains a link or reparse point: {path}")
    if stat.S_ISREG(metadata.st_mode):
        descriptor = _open_regular(path, name, None)
        try:
            os.fsync(descriptor)
        except OSError as error:
            _fail(f"cannot fsync {name}: {error}")
        finally:
            os.close(descriptor)
        return
    if not stat.S_ISDIR(metadata.st_mode):
        _fail(f"{name} contains a special file: {path}")
    try:
        children = tuple(sorted(path.iterdir(), key=lambda child: child.name))
    except OSError as error:
        _fail(f"cannot inspect {name}: {error}")
    for child in children:
        child_metadata = child.lstat()
        if stat.S_ISLNK(child_metadata.st_mode) or bool(
            getattr(child_metadata, "st_file_attributes", 0) & 0x400
        ):
            _fail(f"{name} contains a link or reparse point: {child}")
        if child.name in excluded_children:
            if not stat.S_ISDIR(child_metadata.st_mode):
                _fail(f"{name} excluded child is not a directory: {child}")
            continue
        _fsync_owned_tree(child, f"{name}/{child.name}")
    _fsync_directory(path, name)


def _ensure_package_development_root(output: Path) -> Path:
    """Create and validate the private control tree inside the package mount."""

    output = _ensure_directory(output, "backend output")
    control = output / PACKAGE_DEVELOPMENT_DIRNAME
    _ensure_directory(control, "backend package development control directory")
    owner = control / PACKAGE_DEVELOPMENT_OWNER
    candidates = control / PACKAGE_CANDIDATES_DIRNAME
    backups = control / PACKAGE_BACKUPS_DIRNAME
    retired = control / PACKAGE_RETENTION_ARCHIVE_DIRNAME
    cache_control = control / PACKAGE_CACHE_CONTROL_DIRNAME
    allowed = {
        PACKAGE_DEVELOPMENT_OWNER,
        PACKAGE_CANDIDATES_DIRNAME,
        PACKAGE_BACKUPS_DIRNAME,
        PACKAGE_RETENTION_ARCHIVE_DIRNAME,
        PACKAGE_CACHE_CONTROL_DIRNAME,
        PACKAGE_ROTATION_JOURNAL_NAME,
    }
    try:
        entries = tuple(control.iterdir())
    except OSError as error:
        _fail(f"cannot inspect backend package development control directory: {error}")
    for entry in entries:
        if entry.name not in allowed:
            _fail(f"backend package development control has an unknown entry: {entry.name}")
        metadata = entry.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            _fail(f"backend package development control contains a symlink: {entry.name}")
    journal = control / PACKAGE_ROTATION_JOURNAL_NAME
    if journal.exists() or journal.is_symlink():
        metadata = journal.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            _fail("backend package rotation journal is not one regular file")
    _ensure_directory(cache_control, "backend cache maintenance control directory")
    try:
        cache_entries = tuple(cache_control.iterdir())
    except OSError as error:
        _fail(f"cannot inspect backend cache maintenance control directory: {error}")
    cache_allowed = {PACKAGE_CACHE_MARKER_NAME, PACKAGE_CACHE_READBACK_NAME}
    cache_names = {entry.name for entry in cache_entries}
    if not cache_names.issubset(cache_allowed) or cache_names not in (
        set(),
        cache_allowed,
    ):
        _fail("backend cache maintenance control has an incomplete or unknown record pair")
    for entry in cache_entries:
        metadata = entry.lstat()
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
        ):
            _fail("backend cache maintenance control contains an unsafe record")
    if owner.exists():
        metadata = owner.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            _fail("backend package development owner marker is not one regular file")
        document, _ = _read_json(
            owner, "backend package development owner marker", 16 * 1024
        )
        if (
            document.get("schema") != PACKAGE_DEVELOPMENT_SCHEMA
            or document.get("state") != "owned"
            or document.get("package_root") != str(output)
        ):
            _fail("backend package development owner marker does not match this mount")
    else:
        if entries and set(entry.name for entry in entries) != {PACKAGE_CACHE_CONTROL_DIRNAME}:
            _fail("backend package development owner marker is missing")
        _write_json(
            owner,
            {
                "schema": PACKAGE_DEVELOPMENT_SCHEMA,
                "state": "owned",
                "package_root": str(output),
            },
            "backend package development owner marker",
        )
    _ensure_directory(candidates, "backend package candidate directory")
    _ensure_directory(backups, "backend package backup directory")
    _ensure_directory(retired, "backend package retention archive directory")
    return control


BACKEND_CACHE_RECEIPT_SCHEMA = "fullmag.direct-compose.backend-volume-cache-receipt.v1"
_CACHE_VOLUME_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,127}$")


def _backend_cache_receipt() -> dict[str, Any] | None:
    """Publish the cache identity inside the per-group control volume.

    The host launcher may prepare and inspect the named volumes, but it must
    not receive a host-side copy of this control record.  The backend owns the
    control volume and therefore publishes the canonical record after opening
    it.  Missing cache environment is retained for the frozen
    ``prepare``/``build`` compatibility path, which does not use the direct
    Compose cache adapter.
    """

    schema = os.environ.get("FULLMAG_BACKEND_CACHE_SCHEMA")
    if schema is None:
        return None
    if schema != "fullmag.backend-build-cache.v2":
        _fail("backend cache schema is unsupported")

    _ensure_directory(CONTROL_ROOT, "backend control volume")
    _ensure_directory(BACKEND_CONTROL_ROOT, "backend control namespace")
    path = CACHE_RECEIPT_PATH
    configured_path = Path(
        os.environ.get("FULLMAG_BACKEND_CACHE_RECEIPT", str(path))
    )
    if configured_path != path:
        _fail("backend cache receipt must remain inside the control named volume")

    def required(name: str) -> str:
        value = os.environ.get(name)
        if not isinstance(value, str) or not value:
            _fail(f"backend cache environment is missing {name}")
        return value

    volume_names = {
        "build": required("FULLMAG_BACKEND_CACHE_BUILD_VOLUME"),
        "package": required("FULLMAG_BACKEND_CACHE_PACKAGE_VOLUME"),
        "control": required("FULLMAG_BUILD_CONTROL_VOLUME"),
    }
    cache_control_volume = required("FULLMAG_BACKEND_CACHE_CONTROL_VOLUME")
    if cache_control_volume != volume_names["control"]:
        _fail("backend cache control volume identities differ")
    if any(_CACHE_VOLUME_NAME_RE.fullmatch(value) is None for value in volume_names.values()):
        _fail("backend cache volume name is invalid")
    if required("FULLMAG_BACKEND_CACHE_BUILD_ROOT") != str(BUILD_ROOT):
        _fail("backend cache build root differs from the fixed named-volume target")
    if required("FULLMAG_BACKEND_CACHE_PACKAGE_ROOT") != str(PACKAGE_ROOT):
        _fail("backend cache package root differs from the fixed named-volume target")
    if required("FULLMAG_BACKEND_CACHE_CONTROL_ROOT") != str(CONTROL_ROOT):
        _fail("backend cache control root differs from the per-group control volume")
    if required("FULLMAG_BACKEND_CACHE_CONTROL_NAMESPACE") != str(BACKEND_CONTROL_ROOT):
        _fail("backend cache control namespace differs from the fixed backend namespace")

    document: dict[str, Any] = {
        "schema": BACKEND_CACHE_RECEIPT_SCHEMA,
        "state": "ready",
        "cache_schema": schema,
        "profile": required("FULLMAG_BACKEND_CACHE_PROFILE"),
        "project_id": required("FULLMAG_BACKEND_CACHE_PROJECT_ID"),
        "cache_key": required("FULLMAG_BACKEND_CACHE_KEY"),
        "unit_key": required("FULLMAG_BACKEND_CACHE_UNIT_KEY"),
        "owner_id": required("FULLMAG_BACKEND_CACHE_OWNER_ID"),
        "worktree_id": required("FULLMAG_BACKEND_CACHE_WORKTREE_ID"),
        "toolchain_image_id": required("FULLMAG_BACKEND_CACHE_TOOLCHAIN_IMAGE_ID"),
        "runtime_image_id": required("FULLMAG_BACKEND_RUNTIME_IMAGE_ID"),
        "cargo_profile": required("FULLMAG_BACKEND_CARGO_PROFILE"),
        "volume_names": volume_names,
        "targets": {
            "build": str(BUILD_ROOT),
            "package": str(PACKAGE_ROOT),
            "control": str(CONTROL_ROOT),
            "receipt": str(path),
        },
        "storage": "docker-named-volume",
    }
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_file():
            _fail("backend cache volume receipt is not one regular file")
        previous, _ = _read_json(path, "backend cache volume receipt", 128 * 1024)
        if previous.get("schema") != BACKEND_CACHE_RECEIPT_SCHEMA:
            _fail("backend cache volume receipt has an unsupported schema")
    _write_json(path, document, "backend cache volume receipt")
    return document


def _prepare_workspace(build_root: Path) -> Path:
    workspace = build_root / "workspace"
    _ensure_directory(build_root, "build root")
    _ensure_directory(workspace, "backend workspace")
    marker = workspace / OWNER_MARKER
    if marker.exists() or marker.is_symlink():
        document, _ = _read_json(marker, "backend workspace owner", 16 * 1024)
        if document.get("schema") != "fullmag.direct-compose.backend-workspace.v1":
            _fail("backend workspace owner marker has an unsupported schema")
        state = document.get("state")
        if state is not None and state not in {"preparing", "ready"}:
            _fail("backend workspace owner marker has an unsupported state")
    else:
        # A failed first extraction may leave only these newly created empty
        # directories. Never adopt an unknown nonempty workspace or cache.
        for child in workspace.iterdir():
            if (child.name not in PERSISTENT_WORKSPACE_DIRS or child.is_symlink()
                    or not child.is_dir() or any(child.iterdir())):
                _fail("backend workspace is nonempty without an owned marker")
        _write_json(marker, {"schema": "fullmag.direct-compose.backend-workspace.v1",
                             "state": "preparing"}, "backend workspace owner")
    for name in PERSISTENT_WORKSPACE_DIRS:
        _ensure_directory(workspace / name, f"persistent workspace directory {name}")
    return workspace


def _workspace_tree_inventory(workspace: Path) -> tuple[dict[str, Path], set[str]]:
    """Inventory owned source entries without traversing persistent mounts."""

    files: dict[str, Path] = {}
    directories: set[str] = set()

    def visit(directory: Path, relative: PurePosixPath) -> None:
        try:
            children = tuple(directory.iterdir())
        except OSError as error:
            _fail(f"cannot inventory backend workspace {directory}: {error}")
        for child in children:
            metadata = child.lstat()
            if stat.S_ISLNK(metadata.st_mode) or bool(
                getattr(metadata, "st_file_attributes", 0) & 0x400
            ):
                _fail(f"backend workspace contains a link or reparse point: {child}")
            child_relative = relative / child.name
            key = child_relative.as_posix()
            if stat.S_ISDIR(metadata.st_mode):
                directories.add(key)
                visit(child, child_relative)
            elif stat.S_ISREG(metadata.st_mode):
                files[key] = child
            else:
                _fail(f"backend workspace contains a special file: {child}")

    for child in tuple(workspace.iterdir()):
        if child.name in PERSISTENT_WORKSPACE_DIRS or child.name in {OWNER_MARKER, ".fullmag"}:
            metadata = child.lstat()
            if child.name in PERSISTENT_WORKSPACE_DIRS and (
                stat.S_ISLNK(metadata.st_mode)
                or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)
                or not stat.S_ISDIR(metadata.st_mode)
            ):
                _fail(f"persistent workspace mount is unsafe: {child}")
            if child.name == ".fullmag" and (
                stat.S_ISLNK(metadata.st_mode)
                or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)
                or not stat.S_ISDIR(metadata.st_mode)
            ):
                _fail(f"generated build output root is unsafe: {child}")
            continue
        metadata = child.lstat()
        if stat.S_ISLNK(metadata.st_mode) or bool(
            getattr(metadata, "st_file_attributes", 0) & 0x400
        ):
            _fail(f"backend workspace contains a link or reparse point: {child}")
        if stat.S_ISDIR(metadata.st_mode):
            directories.add(child.name)
            visit(child, PurePosixPath(child.name))
        elif stat.S_ISREG(metadata.st_mode):
            files[child.name] = child
        else:
            _fail(f"backend workspace contains a special file: {child}")
    return files, directories


def _source_manifest_inventory(capsule: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    raw_files = capsule.get("files")
    if not isinstance(raw_files, list):
        _fail("source manifest files are unavailable for workspace reconciliation")
    inventory: dict[str, dict[str, Any]] = {}
    for raw in raw_files:
        if not isinstance(raw, Mapping):
            _fail("source manifest file inventory entry is not an object")
        path = raw.get("path")
        if not isinstance(path, str) or not path or "\\" in path:
            _fail("source manifest file inventory path is invalid")
        relative = PurePosixPath(path)
        if (
            relative.is_absolute()
            or relative.as_posix() != path
            or any(part in {"", ".", ".."} for part in relative.parts)
        ):
            _fail(f"source manifest file inventory path escapes its root: {path}")
        if relative.parts[0] in PERSISTENT_WORKSPACE_DIRS:
            _fail(f"source manifest attempts to replace persistent mount: {path}")
        if relative.parts[0] == ".fullmag":
            _fail(f"source manifest attempts to replace generated build output: {path}")
        if relative.parts[0] == OWNER_MARKER:
            _fail(f"source manifest attempts to replace workspace ownership: {path}")
        if path in inventory:
            _fail(f"source manifest contains duplicate file inventory path: {path}")
        size = raw.get("size")
        mode = raw.get("mode")
        digest = raw.get("sha256")
        if raw.get("type") != "file" or type(size) is not int or size < 0 or not isinstance(mode, str):
            _fail(f"source manifest file inventory metadata is invalid: {path}")
        if mode not in {"100644", "100755"} or not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
            _fail(f"source manifest file inventory metadata is invalid: {path}")
        inventory[path] = {"size": size, "mode": mode, "sha256": digest}
    return inventory



def _validate_native_identity(value: object, resolved_commit: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        _fail("live manifest native_source_identity must be an object")
    if value.get("schema") != "fullmag.source-snapshot.v2":
        _fail("live manifest native identity schema is unsupported")
    if value.get("head_commit_full") != resolved_commit:
        _fail("live manifest native source commit differs from its manifest")
    for name in ("head_tree_sha256", "dirty_content_sha256", "source_snapshot_sha256"):
        value_for_name = value.get(name)
        if not isinstance(value_for_name, str) or not SHA256_RE.fullmatch(value_for_name):
            _fail(f"live manifest native identity field is invalid: {name}")
    if type(value.get("source_snapshot_dirty")) is not bool or type(value.get("ignored_non_runtime_dirty")) is not bool:
        _fail("live manifest native dirty flags are invalid")
    if not isinstance(value.get("git_status_porcelain_v1"), list) or not isinstance(value.get("dirty_path_content"), list):
        _fail("live manifest native status fields are invalid")
    return dict(value)


def _validate_source_relative_path(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value:
        _fail(f"{label} is not a safe relative source path")
    relative = PurePosixPath(value)
    if relative.is_absolute() or relative.as_posix() != value or any(part in {"", ".", ".."} for part in relative.parts):
        _fail(f"{label} escapes the source root: {value!r}")
    return value


def _validate_live_capsule_classes(capsule: Mapping[str, Any], files: Mapping[str, Any]) -> None:
    file_paths = set(files)
    classes: dict[str, set[str]] = {}
    for field in ("deleted", "included_untracked"):
        raw = capsule.get(field)
        if not isinstance(raw, list):
            _fail(f"live source capsule field is invalid: {field}")
        checked = [_validate_source_relative_path(item, f"live source capsule {field}") for item in raw]
        if checked != sorted(set(checked)):
            _fail(f"live source capsule field is not canonically sorted: {field}")
        classes[field] = set(checked)
    if (
        not classes["included_untracked"] <= file_paths
        or classes["deleted"] & file_paths
        or classes["deleted"] & classes["included_untracked"]
    ):
        _fail("live source capsule path classes overlap")
    raw_excluded = capsule.get("excluded")
    if not isinstance(raw_excluded, list):
        _fail("live source capsule excluded field is invalid")
    for item in raw_excluded:
        if isinstance(item, str):
            path = _validate_source_relative_path(item, "live source capsule exclusion")
            if any(
                file_path == path or file_path.startswith(path + "/")
                for file_path in file_paths
            ):
                _fail(f"live source capsule exclusion overlaps a source file: {path}")
        elif isinstance(item, dict):
            path = _validate_source_relative_path(item.get("path"), "live source capsule Gitlink exclusion")
            if (
                path not in ALLOWED_EXTERNAL_SOLVER_GITLINKS
                or item.get("type") != "gitlink"
                or not isinstance(item.get("pinned_commit"), str)
                or not re.fullmatch(r"[0-9a-f]{40}", item["pinned_commit"])
            ):
                _fail(f"live source capsule Gitlink exclusion is invalid: {path}")
        else:
            _fail("live source capsule exclusion is invalid")


def _source_manifest_digest(capsule: Mapping[str, Any]) -> str:
    try:
        material = {
            "schema_version": capsule["schema_version"],
            "source_mode": capsule["source_mode"],
            "resolved_commit": capsule["resolved_commit"],
            "files": capsule["files"],
            "deleted": capsule["deleted"],
            "included_untracked": capsule["included_untracked"],
            "excluded": capsule["excluded"],
        }
    except KeyError as error:
        _fail(f"live source manifest is missing {error.args[0]}")
    return _sha256_bytes(_canonical(material))


def _validate_live_manifest(document: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, str], str]:
    if document.get("schema") != LIVE_MANIFEST_SCHEMA or document.get("source_mode") != LIVE_SOURCE_MODE:
        _fail("source manifest is not a live-shadow manifest")
    required = {
        "schema", "capture_id", "source_mode", "source_root", "git_common_dir",
        "resolved_commit", "source_digest", "source_snapshot_sha256",
        "native_source_identity", "source_manifest", "source_manifest_sha256",
        "git_object_ids", "created_at", "live_manifest_sha256",
    }
    if set(document) != required:
        _fail("live source manifest fields are incomplete or unexpected")
    capture_id = document.get("capture_id")
    if not isinstance(capture_id, str) or not CAPTURE_ID_RE.fullmatch(capture_id):
        _fail("live source manifest capture id is invalid")
    if not isinstance(document.get("source_root"), str) or not document["source_root"]:
        _fail("live source manifest source_root is invalid")
    if not isinstance(document.get("git_common_dir"), str) or not document["git_common_dir"]:
        _fail("live source manifest git_common_dir is invalid")
    resolved_commit = document.get("resolved_commit")
    if not isinstance(resolved_commit, str) or not re.fullmatch(r"[0-9a-f]{40}", resolved_commit):
        _fail("live source manifest resolved_commit is invalid")
    capsule_value = document.get("source_manifest")
    if not isinstance(capsule_value, dict):
        _fail("live source manifest source_manifest is not an object")
    capsule = dict(capsule_value)
    if capsule.get("schema") != "fullmag.source-capsule.v1" or capsule.get("schema_version") != "fullmag.source-capsule.v1":
        _fail("live source capsule schema is unsupported")
    if capsule.get("source_mode") != "snapshot" or capsule.get("resolved_commit") != resolved_commit:
        _fail("live source capsule is not the requested snapshot")
    for field in ("deleted", "included_untracked", "excluded"):
        if not isinstance(capsule.get(field), list):
            _fail(f"live source capsule field is invalid: {field}")
    files = _source_manifest_inventory(capsule)
    _validate_live_capsule_classes(capsule, files)
    source_digest = capsule.get("source_digest")
    if not isinstance(source_digest, str) or not SHA256_RE.fullmatch(source_digest) or source_digest != _source_manifest_digest(capsule):
        _fail("live source capsule digest does not match its content")
    if document.get("source_digest") != source_digest:
        _fail("live source manifest source digest differs from its capsule")
    nested_hash = _sha256_bytes(_canonical(capsule))
    if document.get("source_manifest_sha256") != nested_hash:
        _fail("live source manifest capsule hash differs")
    native = _validate_native_identity(document.get("native_source_identity"), resolved_commit)
    if document.get("source_snapshot_sha256") != native["source_snapshot_sha256"]:
        _fail("live source manifest native snapshot differs")
    raw_git_objects = document.get("git_object_ids")
    if not isinstance(raw_git_objects, dict):
        _fail("live source manifest git_object_ids is not an object")
    git_objects: dict[str, str] = {}
    for relative, object_id in raw_git_objects.items():
        _validate_source_relative_path(relative, "live source Git object path")
        if relative not in files or not isinstance(object_id, str) or not GIT_OBJECT_RE.fullmatch(object_id):
            _fail(f"live source manifest Git object disclosure is invalid: {relative}")
        git_objects[relative] = object_id
    unsigned = dict(document)
    live_digest = unsigned.pop("live_manifest_sha256", None)
    if not isinstance(live_digest, str) or not SHA256_RE.fullmatch(live_digest) or live_digest != _sha256_bytes(_canonical(unsigned)):
        _fail("live source manifest digest does not match its bytes")
    return capsule, native, git_objects, live_digest


def _read_git_blobs(git_common_root: Path, object_ids: Mapping[str, str]) -> dict[str, bytes]:
    """Read all sparse checkout fallbacks through one Git batch process."""

    if not object_ids:
        return {}
    git_common_root = _absolute(git_common_root, "source Git common root")
    _assert_no_links(git_common_root, "source Git common root")
    unique_ids = tuple(dict.fromkeys(object_ids.values()))
    if any(not GIT_OBJECT_RE.fullmatch(object_id) for object_id in unique_ids):
        _fail("source Git object id is invalid")
    environment = os.environ.copy()
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        process = subprocess.Popen(
            ("git", "--git-dir", str(git_common_root), "cat-file", "--batch"),
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        _fail(f"cannot read sparse source Git objects: {error}")
    assert process.stdin is not None and process.stdout is not None
    by_object: dict[str, bytes] = {}
    try:
        for object_id in unique_ids:
            process.stdin.write((object_id + "\n").encode("ascii"))
            process.stdin.flush()
            header = process.stdout.readline().rstrip(b"\n").split(b" ")
            if len(header) != 3 or header[0].decode("ascii", "replace") != object_id:
                _fail("source Git object response is malformed")
            if header[1] != b"blob":
                _fail("source Git object is not a blob")
            try:
                size = int(header[2])
            except ValueError:
                _fail("source Git object size is invalid")
            if size < 0 or size > MAX_SOURCE_BYTES:
                _fail("source Git object exceeds its size bound")
            content = process.stdout.read(size)
            if len(content) != size or process.stdout.read(1) != b"\n":
                _fail("source Git object is truncated")
            by_object[object_id] = content
    except BaseException:
        try:
            process.kill()
        except OSError:
            pass
        process.wait()
        raise
    finally:
        try:
            process.stdin.close()
        except OSError:
            pass
        process.stdout.close()
    assert process.stderr is not None
    detail = process.stderr.read().decode("utf-8", errors="replace").strip()
    process.stderr.close()
    returncode = process.wait()
    if returncode:
        _fail(f"source Git object read failed: {detail or 'Git error'}")
    return {relative: by_object[object_id] for relative, object_id in object_ids.items()}


def _live_source_path(source_root: Path, relative: str) -> Path:
    path = source_root.joinpath(*PurePosixPath(relative).parts)
    _assert_no_links(path.parent, f"live source parent {relative}")
    return path


def _publish_shadow_bytes(target: Path, data: bytes, mode: int, label: str) -> None:
    _ensure_directory(target.parent, f"shadow source directory {target.parent}")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    except OSError as error:
        _fail(f"cannot publish {label}: {error}")
    finally:
        temporary.unlink(missing_ok=True)


def _copy_live_regular_file(source: Path, target: Path, relative: str, entry: Mapping[str, Any]) -> None:
    _ensure_directory(target.parent, f"shadow source directory {target.parent}")
    source_descriptor = _open_regular(source, f"live source {relative}", MAX_SOURCE_BYTES)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    temporary = Path(temporary_name)
    digest = hashlib.sha256()
    total = 0
    try:
        before = os.fstat(source_descriptor)
        with os.fdopen(descriptor, "wb") as output:
            while True:
                block = os.read(source_descriptor, 1024 * 1024)
                if not block:
                    break
                total += len(block)
                digest.update(block)
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
        after = os.fstat(source_descriptor)
        if total != entry["size"] or digest.hexdigest() != entry["sha256"] or _file_signature(before) != _file_signature(after):
            _fail(f"live source changed while synchronizing: {relative}")
        os.chmod(temporary, 0o555 if entry["mode"] == "100755" else 0o444)
        os.replace(temporary, target)
    except OSError as error:
        _fail(f"cannot synchronize live source {entry['path']}: {error}")
    finally:
        os.close(source_descriptor)
        temporary.unlink(missing_ok=True)


def _make_shadow_source_read_only(workspace: Path, expected: Mapping[str, Mapping[str, Any]]) -> None:
    directories: set[Path] = set()
    for relative in expected:
        parts = PurePosixPath(relative).parts
        directories.update(workspace.joinpath(*parts[:index]) for index in range(1, len(parts)))
        path = workspace.joinpath(*parts)
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            _fail(f"shadow source entry is unsafe: {relative}")
        os.chmod(path, 0o555 if expected[relative]["mode"] == "100755" else 0o444)
    for directory in sorted(directories, key=lambda item: len(item.parts), reverse=True):
        os.chmod(directory, 0o555)


def _sync_live_source_tree(
    source_root: Path,
    git_common_root: Path,
    workspace: Path,
    capsule: Mapping[str, Any],
    git_object_ids: Mapping[str, str],
    live_manifest_sha256: str,
    *,
    preserve_legacy_install_stage: bool = False,
) -> None:
    source_root = _absolute(source_root, "live source root")
    _assert_no_links(source_root, "live source root")
    expected = _source_manifest_inventory(capsule)
    started = time.monotonic()
    _log_phase("sync", "start", files=len(expected))
    _remove_generated_build_output(
        workspace,
        preserve_legacy_install_stage=preserve_legacy_install_stage,
    )
    existing_files, existing_directories = _workspace_tree_inventory(workspace)
    for relative in existing_directories:
        if relative.split("/", 1)[0] not in PERSISTENT_WORKSPACE_DIRS:
            os.chmod(workspace.joinpath(*PurePosixPath(relative).parts), 0o700)
    expected_directories: set[str] = set()
    for relative in expected:
        parts = PurePosixPath(relative).parts
        expected_directories.update(PurePosixPath(*parts[:index]).as_posix() for index in range(1, len(parts)))
    if set(expected) & existing_directories or expected_directories & set(existing_files):
        _fail("live source file/directory transition requires a fresh owned workspace")

    marker_path = workspace / OWNER_MARKER
    marker, _ = _read_json(marker_path, "backend workspace owner", 16 * 1024)
    old_digest = marker.get("source_digest")
    if old_digest is not None and (not isinstance(old_digest, str) or not SHA256_RE.fullmatch(old_digest)):
        _fail("backend workspace owner source digest is invalid")
    inventory_schema = marker.get("workspace_inventory_schema")
    inventory_hash = marker.get("workspace_inventory_sha256")
    if old_digest is not None and (inventory_schema != WORKSPACE_INVENTORY_SCHEMA or inventory_hash != old_digest):
        _fail("backend workspace owner inventory binding is invalid")
    if old_digest is None and (existing_files or existing_directories):
        _remove_workspace_relative_entries(workspace, existing_files, existing_directories)
        existing_files, existing_directories = {}, set()
    new_digest = capsule.get("source_digest")
    if not isinstance(new_digest, str) or not SHA256_RE.fullmatch(new_digest):
        _fail("live source capsule digest is invalid")
    _write_json(marker_path, {
        "schema": "fullmag.direct-compose.backend-workspace.v1",
        "state": "preparing",
        "source_mode": LIVE_SOURCE_MODE,
        "source_digest": new_digest,
        "live_manifest_sha256": live_manifest_sha256,
        "workspace_inventory_schema": WORKSPACE_INVENTORY_SCHEMA,
        "workspace_inventory_sha256": new_digest,
    }, "backend workspace owner")

    sparse_object_ids: dict[str, str] = {}
    for relative, entry in expected.items():
        target = workspace.joinpath(*PurePosixPath(relative).parts)
        _ensure_directory(target.parent, f"shadow source directory {target.parent}")
        existing = existing_files.get(relative)
        if existing is not None:
            digest, metadata = _sha256_file(existing, f"shadow source {relative}", MAX_SOURCE_BYTES)
            if digest == entry["sha256"] and metadata.st_size == entry["size"]:
                continue
        source = _live_source_path(source_root, relative)
        try:
            source.lstat()
        except FileNotFoundError:
            object_id = git_object_ids.get(relative)
            if object_id is None:
                _fail(f"live source is missing manifest file: {relative}")
            sparse_object_ids[relative] = object_id
        else:
            _copy_live_regular_file(source, target, relative, entry)

    sparse_blobs = _read_git_blobs(git_common_root, sparse_object_ids)
    for relative, object_id in sparse_object_ids.items():
        entry = expected[relative]
        target = workspace.joinpath(*PurePosixPath(relative).parts)
        content = sparse_blobs[relative]
        if len(content) != entry["size"] or _sha256_bytes(content) != entry["sha256"]:
            _fail(f"sparse Git object differs from live source manifest: {relative}")
        _publish_shadow_bytes(
            target,
            content,
            0o555 if entry["mode"] == "100755" else 0o444,
            f"sparse source {relative}",
        )

    stale_files = {relative: path for relative, path in existing_files.items() if relative not in expected}
    stale_directories = {relative for relative in existing_directories if relative not in expected_directories}
    _remove_workspace_relative_entries(workspace, stale_files, stale_directories)
    _make_shadow_source_read_only(workspace, expected)
    _write_json(marker_path, {
        "schema": "fullmag.direct-compose.backend-workspace.v1",
        "state": "ready",
        "source_mode": LIVE_SOURCE_MODE,
        "source_digest": new_digest,
        "live_manifest_sha256": live_manifest_sha256,
        "workspace_inventory_schema": WORKSPACE_INVENTORY_SCHEMA,
        "workspace_inventory_sha256": new_digest,
    }, "backend workspace owner")
    _log_phase(
        "sync",
        "complete",
        files=len(expected),
        sparse=len(sparse_object_ids),
        duration_ms=round((time.monotonic() - started) * 1000),
    )


def _verify_shadow_source(workspace: Path, capsule: Mapping[str, Any]) -> None:
    expected = _source_manifest_inventory(capsule)
    files, directories = _workspace_tree_inventory(workspace)
    source_files = {path: value for path, value in files.items() if not path.startswith(".fullmag/")}
    source_directories = {path for path in directories if not path.startswith(".fullmag")}
    expected_directories: set[str] = set()
    for relative in expected:
        parts = PurePosixPath(relative).parts
        expected_directories.update(PurePosixPath(*parts[:index]).as_posix() for index in range(1, len(parts)))
    if set(source_files) != set(expected) or source_directories != expected_directories:
        _fail("shadow source inventory changed during Make")
    for relative, entry in expected.items():
        digest, metadata = _sha256_file(source_files[relative], f"shadow source {relative}", MAX_SOURCE_BYTES)
        if digest != entry["sha256"] or metadata.st_size != entry["size"]:
            _fail(f"shadow source changed during Make: {relative}")

def _legacy_install_stage_signature(
    metadata: os.stat_result,
    kind: str,
    link_target: str | None = None,
) -> tuple[object, ...]:
    """Return bounded metadata for one retained legacy install entry."""

    return (
        kind,
        int(metadata.st_dev),
        int(metadata.st_ino),
        int(metadata.st_mode),
        int(metadata.st_nlink),
        int(metadata.st_size),
        int(metadata.st_mtime_ns),
        int(metadata.st_ctime_ns),
        link_target,
    )


def _snapshot_legacy_install_stage(
    workspace: Path,
) -> dict[str, tuple[object, ...]] | None:
    """Capture bounded metadata without hashing the retained legacy package.

    The direct candidate is published into a separate package-control tree.
    A pre-existing ``.fullmag/local`` tree is therefore retained as an
    independent legacy stage, but it must not be changed by source
    materialization or the candidate Make invocation.  This inventory follows
    directories only, records symlink targets without following them, and
    never reads file contents.
    """

    workspace = _absolute(workspace, "backend workspace")
    stage = workspace / ".fullmag" / "local"
    _assert_no_links(stage.parent, "legacy install stage parent")
    try:
        root_metadata = stage.lstat()
    except FileNotFoundError:
        return None
    except OSError as error:
        _fail(f"cannot inspect retained legacy install stage: {error}")
    if (
        stat.S_ISLNK(root_metadata.st_mode)
        or bool(getattr(root_metadata, "st_file_attributes", 0) & 0x400)
        or not stat.S_ISDIR(root_metadata.st_mode)
    ):
        _fail("retained legacy install stage root is unsafe")

    inventory: dict[str, tuple[object, ...]] = {
        ".": _legacy_install_stage_signature(root_metadata, "directory")
    }
    pending: list[tuple[Path, str]] = [(stage, "")]
    while pending:
        directory, relative = pending.pop()
        try:
            with os.scandir(directory) as iterator:
                children = sorted(iterator, key=lambda entry: entry.name)
        except OSError as error:
            _fail(f"cannot inspect retained legacy install stage {directory}: {error}")
        for entry in children:
            child = Path(entry.path)
            key = f"{relative}/{entry.name}" if relative else entry.name
            try:
                metadata = entry.stat(follow_symlinks=False)
            except OSError as error:
                _fail(f"cannot inspect retained legacy install stage entry {child}: {error}")
            if bool(getattr(metadata, "st_file_attributes", 0) & 0x400):
                _fail(f"retained legacy install stage contains a reparse point: {child}")
            if stat.S_ISDIR(metadata.st_mode):
                kind = "directory"
                link_target = None
            elif stat.S_ISREG(metadata.st_mode):
                kind = "file"
                link_target = None
            elif stat.S_ISLNK(metadata.st_mode):
                try:
                    link_target = os.readlink(child)
                except OSError as error:
                    _fail(f"cannot read retained legacy install stage link {child}: {error}")
                if len(link_target.encode("utf-8", errors="surrogateescape")) > MAX_LEGACY_INSTALL_STAGE_LINK_TARGET_BYTES:
                    _fail(f"retained legacy install stage link target is too long: {child}")
                kind = "symlink"
            else:
                _fail(f"retained legacy install stage contains a special file: {child}")
            if len(inventory) >= MAX_LEGACY_INSTALL_STAGE_ENTRIES:
                _fail("retained legacy install stage exceeds its bounded entry limit")
            inventory[key] = _legacy_install_stage_signature(metadata, kind, link_target)
            if kind == "directory":
                pending.append((child, key))
    return inventory


def _assert_legacy_install_stage_unchanged(
    workspace: Path,
    expected: dict[str, tuple[object, ...]] | None,
    phase: str,
) -> None:
    observed = _snapshot_legacy_install_stage(workspace)
    if observed != expected:
        _fail(
            "direct backend candidate changed the retained .fullmag/local stage "
            f"during {phase}"
        )


def _remove_generated_build_output(
    workspace: Path,
    *,
    preserve_legacy_install_stage: bool = False,
) -> None:
    """Remove owned generated children while preserving the output root.

    Make publishes package files and native-library aliases below ``.fullmag``.
    Those aliases are build output, not source inputs.  Only the two known
    Make-owned children are removed; an unexpected child fails closed rather
    than being treated as disposable user data.
    """

    generated = workspace / ".fullmag"
    if not generated.exists() and not generated.is_symlink():
        return
    metadata = generated.lstat()
    if (
        stat.S_ISLNK(metadata.st_mode)
        or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)
        or not stat.S_ISDIR(metadata.st_mode)
    ):
        _fail(f"generated build output root is unsafe: {generated}")
    children = tuple(generated.iterdir())
    unexpected = sorted(
        child.name for child in children if child.name not in OWNED_GENERATED_OUTPUT_DIRS
    )
    if unexpected:
        _fail(
            "generated build output contains unowned entries: "
            + ", ".join(unexpected)
        )
    for child in children:
        if child.name == "local" and preserve_legacy_install_stage:
            metadata = child.lstat()
            if (
                stat.S_ISLNK(metadata.st_mode)
                or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)
                or not stat.S_ISDIR(metadata.st_mode)
            ):
                _fail(f"retained legacy install stage root is unsafe: {child}")
            continue
        _remove_owned_tree(child)


def _stage_tree_inventory(stage: Path) -> tuple[set[str], set[str]]:
    """Inventory the already verified extraction and reject links/specials."""

    files: set[str] = set()
    directories: set[str] = set()

    def visit(directory: Path, relative: PurePosixPath) -> None:
        try:
            children = tuple(directory.iterdir())
        except OSError as error:
            _fail(f"cannot inspect extracted source {directory}: {error}")
        for child in children:
            metadata = child.lstat()
            if stat.S_ISLNK(metadata.st_mode) or bool(
                getattr(metadata, "st_file_attributes", 0) & 0x400
            ):
                _fail(f"extracted source contains a link or reparse point: {child}")
            child_relative = relative / child.name
            key = child_relative.as_posix()
            if child_relative.parts[0] in PERSISTENT_WORKSPACE_DIRS:
                _fail(f"extracted source attempts to replace persistent mount: {key}")
            if stat.S_ISDIR(metadata.st_mode):
                directories.add(key)
                visit(child, child_relative)
            elif stat.S_ISREG(metadata.st_mode):
                files.add(key)
            else:
                _fail(f"extracted source contains a special file: {child}")

    visit(stage, PurePosixPath())
    return files, directories


def _remove_workspace_relative_entries(
    workspace: Path, files: Mapping[str, Path], directories: set[str]
) -> None:
    """Remove an already validated owned tree, never persistent mounts."""

    for relative in sorted(files, key=lambda value: (value.count("/"), value), reverse=True):
        path = workspace.joinpath(*PurePosixPath(relative).parts)
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            _fail(f"backend workspace entry changed while removing {path}")
        path.unlink()
    for relative in sorted(directories, key=lambda value: (value.count("/"), value), reverse=True):
        path = workspace.joinpath(*PurePosixPath(relative).parts)
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            _fail(f"backend workspace directory changed while removing {path}")
        try:
            path.rmdir()
        except OSError as error:
            _fail(f"cannot remove stale backend workspace directory {path}: {error}")


def _replace_workspace_file(source: Path, target: Path, source_mode: int) -> None:
    parent = target.parent
    _ensure_directory(parent, f"backend workspace source directory {parent}")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        temporary.unlink()
        _copy_regular_file(source, temporary, source_mode, "materialized source")
        os.replace(temporary, target)
    except OSError as error:
        _fail(f"cannot publish reconciled source file {target}: {error}")
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        except OSError as error:
            _fail(f"cannot remove temporary source file {temporary}: {error}")


def _reconcile_source_tree(
    stage: Path,
    workspace: Path,
    capsule: Mapping[str, Any],
    archive_hash: str,
    *,
    preserve_legacy_install_stage: bool = False,
) -> None:
    """Reconcile verified capsule bytes while preserving unchanged mtimes."""

    expected = _source_manifest_inventory(capsule)
    stage_files, _ = _stage_tree_inventory(stage)
    if stage_files != set(expected):
        _fail("extracted source inventory differs from the source manifest")
    _remove_generated_build_output(
        workspace,
        preserve_legacy_install_stage=preserve_legacy_install_stage,
    )
    existing_files, existing_directories = _workspace_tree_inventory(workspace)
    expected_directories: set[str] = set()
    for relative in expected:
        parts = PurePosixPath(relative).parts
        expected_directories.update(
            PurePosixPath(*parts[:index]).as_posix() for index in range(1, len(parts))
        )
    if set(expected) & existing_directories:
        _fail("source file-to-directory transition requires a fresh workspace")
    if expected_directories & set(existing_files):
        _fail("source directory-to-file transition requires a fresh workspace")

    marker_path = workspace / OWNER_MARKER
    marker, _ = _read_json(marker_path, "backend workspace owner", 16 * 1024)
    old_digest = marker.get("source_digest")
    new_digest = capsule.get("source_digest")
    if not isinstance(new_digest, str) or not SHA256_RE.fullmatch(new_digest):
        _fail("source manifest digest is invalid")
    if old_digest is not None and (
        not isinstance(old_digest, str) or not SHA256_RE.fullmatch(old_digest)
    ):
        _fail("backend workspace owner source digest is invalid")
    inventory_schema = marker.get("workspace_inventory_schema")
    inventory_hash = marker.get("workspace_inventory_sha256")
    if inventory_schema is None and inventory_hash is None:
        has_inventory = False
    elif (
        inventory_schema == WORKSPACE_INVENTORY_SCHEMA
        and isinstance(inventory_hash, str)
        and SHA256_RE.fullmatch(inventory_hash)
        and inventory_hash == old_digest
    ):
        has_inventory = True
    else:
        _fail("backend workspace owner inventory binding is invalid")
    if old_digest is None and not has_inventory:
        # A marker without a source digest can only describe an incomplete
        # first attempt. A valid legacy v1 digest is sufficient ownership
        # evidence after the complete tree and per-file checks above, so it
        # must take the normal incremental path even when the digest changes.
        _remove_workspace_relative_entries(workspace, existing_files, existing_directories)
        existing_files = {}
        existing_directories = set()

    _write_json(
        marker_path,
        {
            "schema": "fullmag.direct-compose.backend-workspace.v1",
            "state": "preparing",
            "source_digest": new_digest,
            "source_tar_sha256": archive_hash,
            "workspace_inventory_schema": WORKSPACE_INVENTORY_SCHEMA,
            "workspace_inventory_sha256": new_digest,
        },
        "backend workspace owner",
    )
    for relative, entry in expected.items():
        target = workspace.joinpath(*PurePosixPath(relative).parts)
        source = stage.joinpath(*PurePosixPath(relative).parts)
        _ensure_directory(target.parent, f"backend workspace source directory {target.parent}")
        existing = existing_files.get(relative)
        expected_mode = 0o755 if entry["mode"] == "100755" else 0o644
        if existing is not None:
            digest, metadata = _sha256_file(existing, f"backend workspace source {relative}", MAX_SOURCE_BYTES)
            if digest == entry["sha256"] and metadata.st_size == entry["size"]:
                if (metadata.st_mode & 0o111) != (expected_mode & 0o111):
                    os.chmod(existing, expected_mode)
                continue
        _replace_workspace_file(source, target, expected_mode)

    stale_files = {relative: path for relative, path in existing_files.items() if relative not in expected}
    stale_directories = {relative for relative in existing_directories if relative not in expected_directories}
    _remove_workspace_relative_entries(workspace, stale_files, stale_directories)
    _write_json(
        marker_path,
        {
            "schema": "fullmag.direct-compose.backend-workspace.v1",
            "state": "ready",
            "source_digest": new_digest,
            "source_tar_sha256": archive_hash,
            "workspace_inventory_schema": WORKSPACE_INVENTORY_SCHEMA,
            "workspace_inventory_sha256": new_digest,
        },
        "backend workspace owner",
    )


def _copy_tree(source: Path, destination: Path) -> None:
    for current, dirnames, filenames in os.walk(source, topdown=True, followlinks=False):
        current_path = Path(current)
        relative = current_path.relative_to(source)
        target_dir = destination.joinpath(*relative.parts) if relative.parts else destination
        _ensure_directory(target_dir, f"materialized source directory {relative}")
        for name in dirnames:
            child = current_path / name
            metadata = child.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                _fail(f"source tree contains an unsafe directory entry: {child}")
        for name in filenames:
            child = current_path / name
            metadata = child.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                _fail(f"source tree contains an unsafe file entry: {child}")
            target = target_dir / name
            _copy_regular_file(child, target, metadata.st_mode, "materialized source")


def _copy_regular_file(source: Path, target: Path, source_mode: int, label: str) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(target, flags, 0o644)
    except OSError as error:
        _fail(f"cannot create {label} entry {target}: {error}")
    try:
        with source.open("rb") as source_stream:
            while True:
                block = source_stream.read(1024 * 1024)
                if not block:
                    break
                view = memoryview(block)
                while view:
                    written = os.write(descriptor, view)
                    if written <= 0:
                        _fail(f"short write while copying {label} entry {target}")
                    view = view[written:]
    finally:
        os.close(descriptor)
    os.chmod(target, 0o755 if source_mode & 0o111 else 0o644)


PACKAGE_LIBRARY_PREFIXES = ("libfullmag_fdm.so", "libfullmag_fem.so")


def _resolve_package_library_alias(source_lib: Path, child: Path) -> Path:
    if child.parent != source_lib or not any(
        child.name.startswith(prefix) for prefix in PACKAGE_LIBRARY_PREFIXES
    ):
        _fail(f"package contains an unsupported symlink: {child}")
    try:
        target = child.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        _fail(f"package library symlink cannot be resolved: {child}: {error}")
    if target == source_lib or source_lib not in target.parents:
        _fail(f"package library symlink escapes its lib directory: {child}")
    metadata = target.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        _fail(f"package library symlink target is not a regular file: {child}")
    return target


def _copy_package_tree(source: Path, destination: Path) -> None:
    """Copy runtime output, dereferencing only confined SONAME library aliases."""

    source_lib = source / "lib"
    if source_lib.exists() or source_lib.is_symlink():
        metadata = source_lib.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            _fail("package lib directory is not a regular directory")
    for current, dirnames, filenames in os.walk(source, topdown=True, followlinks=False):
        current_path = Path(current)
        relative = current_path.relative_to(source)
        target_dir = destination.joinpath(*relative.parts) if relative.parts else destination
        _ensure_directory(target_dir, f"package directory {relative}")
        for name in dirnames:
            child = current_path / name
            metadata = child.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                _fail(f"package contains an unsafe directory entry: {child}")
        for name in filenames:
            child = current_path / name
            metadata = child.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                if current_path != source_lib:
                    _fail(f"package contains an out-of-scope symlink: {child}")
                source_file = _resolve_package_library_alias(source_lib, child)
                source_mode = source_file.stat().st_mode
            elif stat.S_ISREG(metadata.st_mode):
                source_file = child
                source_mode = metadata.st_mode
            else:
                _fail(f"package contains an unsafe file entry: {child}")
            target = target_dir / name
            _copy_regular_file(source_file, target, source_mode, "package")


def _write_runtime_manifests(package_root: Path) -> None:
    """Publish the local runtime registry entries for the four-lane package.

    The definitions intentionally mirror the Windows MSI generator.  Public
    status is still computed by RuntimeRegistry from the worker and native
    availability; FEM remains private and experimental in development.
    """

    manifests = (
        (
            "cpu-reference",
            {
                "family": "cpu-reference",
                "version": RUNTIME_MANIFEST_VERSION,
                "worker": "../../bin/fullmag-bin",
                "engines": [
                    {
                        "backend": "fdm",
                        "device": "cpu",
                        "mode": "strict",
                        "precision": "double",
                        "public": True,
                    }
                ],
            },
        ),
        (
            "fdm-cuda",
            {
                "family": "fdm-cuda",
                "version": RUNTIME_MANIFEST_VERSION,
                "worker": "../../bin/fullmag-bin",
                "engines": [
                    {
                        "backend": "fdm",
                        "device": "gpu",
                        "mode": "strict",
                        "precision": "double",
                        "public": True,
                    },
                    {
                        "backend": "fdm",
                        "device": "gpu",
                        "mode": "strict",
                        "precision": "single",
                        "public": False,
                    },
                ],
            },
        ),
        (
            "fem-cpu-native",
            {
                "family": "fem-cpu-native",
                "version": RUNTIME_MANIFEST_VERSION,
                "worker": "../../bin/fullmag-bin",
                "engines": [
                    {
                        "backend": "fem",
                        "device": "cpu",
                        "mode": "strict",
                        "precision": "double",
                        "public": False,
                        "stability": "experimental",
                    }
                ],
            },
        ),
        (
            "fem-gpu",
            {
                "family": "fem-gpu",
                "version": RUNTIME_MANIFEST_VERSION,
                "worker": "../../bin/fullmag-bin",
                "engines": [
                    {
                        "backend": "fem",
                        "device": "gpu",
                        "mode": "strict",
                        "precision": "double",
                        "public": False,
                        "stability": "experimental",
                    }
                ],
            },
        ),
    )
    for family, manifest in manifests:
        _write_json(
            package_root / "runtimes" / family / "manifest.json",
            manifest,
            f"{family} runtime manifest",
        )


def _remove_extracted_source(path: Path) -> None:
    """Make the helper's read-only extraction removable by its owner."""

    if not path.exists() and not path.is_symlink():
        return
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        _fail(f"extracted source root is unsafe: {path}")
    for current, dirnames, filenames in os.walk(path, topdown=False, followlinks=False):
        current_path = Path(current)
        for name in filenames:
            child = current_path / name
            metadata = child.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                _fail(f"extracted source contains an unsafe cleanup entry: {child}")
            child.chmod(0o600)
        for name in dirnames:
            child = current_path / name
            metadata = child.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                _fail(f"extracted source contains an unsafe cleanup directory: {child}")
            child.chmod(0o700)
    path.chmod(0o700)
    _remove_owned_tree(path)


def _materialize_live_source(
    manifest_path: Path,
    source_root: Path,
    git_common_root: Path,
    build_root: Path,
    *,
    preserve_legacy_install_stage: bool = False,
) -> tuple[Path, dict[str, Any], dict[str, Any], str, None, str]:
    document, manifest_bytes = _read_json(manifest_path, "live source manifest", 64 * 1024 * 1024)
    capsule, native, git_object_ids, live_manifest_sha256 = _validate_live_manifest(document)
    manifest_hash = _sha256_bytes(manifest_bytes)
    workspace = _prepare_workspace(build_root)
    _sync_live_source_tree(
        source_root,
        git_common_root,
        workspace,
        capsule,
        git_object_ids,
        live_manifest_sha256,
        preserve_legacy_install_stage=preserve_legacy_install_stage,
    )
    after_document, after_bytes = _read_json(manifest_path, "live source manifest", 64 * 1024 * 1024)
    if after_bytes != manifest_bytes or after_document != document:
        _fail("live source manifest changed during synchronization")
    capsule = dict(capsule)
    capsule["_live_manifest_sha256"] = live_manifest_sha256
    return workspace, capsule, native, manifest_hash, None, LIVE_SOURCE_MODE


def _materialize_source(
    source_tar: Path | None,
    manifest_path: Path,
    build_root: Path,
    *,
    source_root: Path,
    git_common_root: Path,
    preserve_legacy_install_stage: bool = False,
) -> tuple[Path, dict[str, Any], dict[str, Any], str, str | None, str]:
    manifest_path = _absolute(manifest_path, "source manifest")
    document, _manifest_bytes = _read_json(manifest_path, "source manifest", 64 * 1024 * 1024)
    if document.get("schema") == LIVE_MANIFEST_SCHEMA:
        return _materialize_live_source(
            manifest_path,
            source_root,
            git_common_root,
            build_root,
            preserve_legacy_install_stage=preserve_legacy_install_stage,
        )
    if source_tar is None:
        _fail("archive source manifest requires --source-tar")
    source_tar = _absolute(source_tar, "source archive")
    document, manifest_bytes = _read_json(manifest_path, "source manifest", 64 * 1024 * 1024)
    capsule_value = document.get("source_manifest")
    native_value = document.get("native_source_identity")
    if not isinstance(capsule_value, dict) or not isinstance(native_value, dict):
        _fail("source manifest lacks canonical source_manifest/native_source_identity")
    capsule = dict(capsule_value)
    native = dict(native_value)
    manifest_hash = _sha256_bytes(manifest_bytes)
    workspace = _prepare_workspace(build_root)
    stage_parent = Path(tempfile.mkdtemp(prefix=".backend-capsule-", dir=build_root))
    stage = stage_parent / "source"
    try:
        try:
            extracted = extract_frozen_source(source_tar, manifest_path, stage)
        except BackendSourceError as error:
            _fail(f"source archive failed canonical extraction: {error}")
        if extracted.get("source_digest") != capsule.get("source_digest"):
            _fail("source archive source digest differs from the supplied manifest")
        if extracted.get("resolved_commit") != capsule.get("resolved_commit"):
            _fail("source archive commit differs from the supplied manifest")
        archive_hash = extracted.get("archive_sha256")
        if not isinstance(archive_hash, str) or not SHA256_RE.fullmatch(archive_hash):
            _fail("source archive extractor returned an invalid digest")
        if extracted.get("source_snapshot_sha256") != native.get("source_snapshot_sha256"):
            _fail("source archive native identity differs from the supplied manifest")
        after_document, after_manifest_bytes = _read_json(
            manifest_path, "source manifest", 64 * 1024 * 1024
        )
        if after_manifest_bytes != manifest_bytes or after_document != document:
            _fail("source manifest changed during extraction")
        _reconcile_source_tree(
            stage,
            workspace,
            capsule,
            archive_hash,
            preserve_legacy_install_stage=preserve_legacy_install_stage,
        )
        return workspace, capsule, native, manifest_hash, archive_hash, "archive"
    finally:
        _remove_extracted_source(stage)
        try:
            stage_parent.rmdir()
        except OSError:
            pass


def _write_json(path: Path, value: Mapping[str, Any], name: str) -> None:
    parent = _ensure_directory(path.parent, f"{name} parent")
    data = _canonical(value)
    temporary = parent / f".{path.name}.{os.getpid()}.tmp"
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o660)
        try:
            view = memoryview(data)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    _fail(f"short write while publishing {name}")
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, path)
    except OSError as error:
        try:
            temporary.unlink()
        except OSError:
            pass
        _fail(f"cannot publish {name}: {error}")


@contextmanager
def _runtime_build_lock(build_root: Path):
    """Serialize source replacement and Make against the shared build cache."""

    if fcntl is None:
        _fail("direct backend requires POSIX flock support")
    _ensure_directory(build_root, "build root")
    lock_path = build_root / RUNTIME_LOCK_NAME
    _assert_no_links(lock_path.parent, "backend runtime lock parent")
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(lock_path, flags, 0o660)
    except OSError as error:
        _fail(f"cannot open backend runtime lock: {error}")
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            _fail("backend runtime lock is not one regular file")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError) as error:
            _fail(f"backend runtime cache is already in use: {error}")
        try:
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


def _toolchain_identity() -> tuple[str, dict[str, Any]]:
    image_id = os.environ.get("FULLMAG_TOOLCHAIN_IMAGE_ID", "")
    if not IMAGE_RE.fullmatch(image_id):
        _fail("FULLMAG_TOOLCHAIN_IMAGE_ID must be an immutable sha256 image ID")
    path = Path("/opt/fullmag-deps/share/fullmag/dependency-versions.json")
    dependency, raw = _read_json(path, "FEM dependency manifest", 4 * 1024 * 1024)
    if dependency.get("schema") != "fullmag.docker.fem-gpu-dependencies.v1":
        _fail("FEM dependency manifest schema is unsupported")
    for key in ("declared", "actual", "latest"):
        if not isinstance(dependency.get(key), dict):
            _fail(f"FEM dependency manifest field {key} is invalid")
    commits = dependency["actual"].get("source_commits")
    if not isinstance(commits, dict) or any(not isinstance(commits.get(key), str) or not commits[key] for key in ("mfem", "libceed", "hypre", "petsc", "slepc")):
        _fail("FEM dependency manifest lacks pinned source commits")
    return image_id, {
        "image_id": image_id,
        "dependency_manifest_sha256": _sha256_bytes(raw),
        "dependency_schema": dependency["schema"],
        "actual_source_commits": dict(commits),
    }


def _validate_cargo_profile(value: str) -> str:
    if value not in SUPPORTED_CARGO_PROFILES:
        allowed = ", ".join(sorted(SUPPORTED_CARGO_PROFILES))
        _fail(f"FULLMAG_BACKEND_CARGO_PROFILE must be one of: {allowed}")
    return value


def _build_environment(
    workspace: Path, build_root: Path, native: Mapping[str, Any], jobs: int,
    cargo_profile: str = BACKEND_CARGO_PROFILE,
) -> dict[str, str]:
    cargo_profile = _validate_cargo_profile(cargo_profile)
    # Keep native CMake state in the already cache-key-scoped Cargo target
    # volume.  The stable crate-shaped directories preserve Makefile's
    # existing library discovery globs while keeping FDM and FEM caches
    # separate.  The Rust build scripts retain OUT_DIR/native-build as their
    # standalone fallback when this direct Compose environment is absent.
    native_target_build_root = (
        workspace
        / ".fullmag-build"
        / "cargo-targets"
        / "direct"
        / cargo_profile
        / "build"
    )
    native_build_roots = {
        "FULLMAG_FDM_NATIVE_BUILD_ROOT": native_target_build_root
        / "fullmag-fdm-sys-stable"
        / "out"
        / "native-build",
        "FULLMAG_FEM_NATIVE_BUILD_ROOT": native_target_build_root
        / "fullmag-fem-sys-stable"
        / "out"
        / "native-build",
    }
    environment = dict(os.environ)
    environment.update(
        {
            "FULLMAG_WINDOWS_CONTAINER_MANAGED": "1",
            "FULLMAG_DIRECT_COMPOSE": "1",
            "FULLMAG_BACKEND_CARGO_PROFILE": cargo_profile,
            "FULLMAG_RUNNER_WORKSPACE": str(workspace),
            "FULLMAG_CARGO_TARGET_DIR": "/workspace/.fullmag-build/cargo-targets/direct",
            "CARGO_TARGET_DIR": "/workspace/.fullmag-build/cargo-targets/direct",
            "FULLMAG_CARGO_TARGET_ROOT": "/workspace/.fullmag-build/cargo-targets",
            "CARGO_TARGET_ROOT": "/workspace/.fullmag-build/cargo-targets",
            "CARGO_HOME": str(build_root / "cargo"),
            "RUSTUP_HOME": "/root/.rustup",
            "RUSTUP_TOOLCHAIN": "nightly",
            "RUSTUP_AUTO_INSTALL": "0",
            "FULLMAG_BUILD_CPU_ONLY": "0",
            "FULLMAG_FORCE_LOCAL_FEM_CPU": "0",
            "FULLMAG_FORCE_LOCAL_FEM_GPU": "1",
            "FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT": "1",
            "FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME": "1",
            "FULLMAG_USE_MFEM_STACK": "ON",
            "FULLMAG_FEM_ENABLE_CUDA": "ON",
            "FULLMAG_FEM_REQUIRE_GPU": "1",
            "FULLMAG_FEM_REQUIRE_CEED": "1",
            "FULLMAG_FEM_WITH_SLEPC": "ON",
            "FULLMAG_FEM_MFEM_DEVICE": "ceed-cuda:/gpu/cuda/shared",
            "FULLMAG_SOURCE_GIT_COMMIT": str(native["head_commit_full"]),
            "FULLMAG_SOURCE_WORKTREE_STATE": (
                "dirty" if native["source_snapshot_dirty"] else "clean"
            ),
            "FULLMAG_SOURCE_SNAPSHOT_SHA256": str(native["source_snapshot_sha256"]),
            **{name: str(path) for name, path in native_build_roots.items()},
            "CARGO_BUILD_JOBS": str(jobs),
            "CMAKE_BUILD_PARALLEL_LEVEL": str(jobs),
            "CARGO_INCREMENTAL": "1",
            "HOME": str(build_root / "home"),
            "TMPDIR": str(build_root / "tmp"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
    )
    for path in (build_root / "cargo", build_root / "home", build_root / "tmp"):
        _ensure_directory(path, f"build directory {path}")
    return environment


def _hash_package(root: Path) -> list[dict[str, Any]]:
    if root.is_symlink() or not root.is_dir():
        _fail("built package root is not a regular directory")
    for relative in REQUIRED_PACKAGE_PATHS:
        path = root.joinpath(*PurePosixPath(relative).parts)
        if path.is_symlink() or not path.is_file():
            _fail(f"built package is missing required output: {relative}")
        if relative.startswith("bin/") and not os.access(path, os.X_OK):
            _fail(f"built package binary is not executable: {relative}")
    marker = (root / "launcher-build-mode").read_text(encoding="utf-8").strip()
    if marker != "cuda-fem-gpu":
        _fail(f"canonical build did not produce strict CUDA/FEM GPU mode: {marker!r}")
    libraries = []
    for pattern in ("lib/libfullmag_fdm.so*", "lib/libfullmag_fem.so*"):
        matches = sorted(root.glob(pattern))
        if not matches or any(path.is_symlink() or not path.is_file() for path in matches):
            _fail(f"built package is missing native library family: {pattern}")
        libraries.extend(matches)
    selected: set[Path] = set()
    for relative in REQUIRED_PACKAGE_PATHS:
        selected.add(root.joinpath(*PurePosixPath(relative).parts))
    selected.update(libraries)
    records: list[dict[str, Any]] = []
    for path in sorted(selected):
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            _fail(f"built package contains an unsafe output: {path}")
        digest, _ = _sha256_file(path, f"built package {path}", MAX_SOURCE_BYTES)
        records.append(
            {
                "path": path.relative_to(root).as_posix(),
                "size": metadata.st_size,
                "sha256": digest,
                "mode": "100755" if metadata.st_mode & 0o111 else "100644",
            }
        )
    return records


def _package_children(
    root: Path,
    name: str,
    *,
    exclude_development_control: bool = False,
    exclude_candidate_marker: bool = False,
) -> dict[str, tuple[int, int, int, int, int]]:
    """Return package entries, excluding only the owned control directory."""

    root = _absolute(root, name)
    _ensure_directory(root, name)
    children: dict[str, tuple[int, int, int, int, int]] = {}
    try:
        entries = sorted(root.iterdir(), key=lambda path: path.name)
    except OSError as error:
        _fail(f"cannot inspect {name}: {error}")
    for child in entries:
        metadata = child.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            _fail(f"{name} contains an unsafe top-level symlink: {child.name}")
        if child.name == PACKAGE_DEVELOPMENT_DIRNAME:
            if not exclude_development_control:
                _fail(f"{name} contains the reserved development control directory")
            if not stat.S_ISDIR(metadata.st_mode):
                _fail(f"{name} development control entry is not a directory")
            continue
        if exclude_candidate_marker and child.name == PACKAGE_CANDIDATE_MARKER:
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                _fail(f"{name} candidate owner marker is not one regular file")
            continue
        children[child.name] = _file_signature(metadata)
    return children


def _validated_package(
    root: Path,
    name: str,
    *,
    exclude_development_control: bool = False,
    exclude_candidate_marker: bool = False,
) -> tuple[dict[str, Any], bytes, dict[str, tuple[int, int, int, int, int]]]:
    """Validate a complete package and retain its exact receipt/entry snapshot."""

    receipt_path = root / "backend-build-receipt.json"
    receipt, receipt_bytes = _read_json(receipt_path, f"{name} receipt", 8 * 1024 * 1024)
    if receipt.get("schema") != RECEIPT_SCHEMA or receipt.get("state") != "succeeded":
        _fail(f"{name} receipt is not a successful direct-compose receipt")
    lanes = receipt.get("execution_lanes")
    if not isinstance(lanes, dict) or set(lanes) != set(LANES):
        _fail(f"{name} receipt does not attest all four execution lanes")
    records = _hash_package(root)
    if receipt.get("artifacts") != records:
        _fail(f"{name} artifacts differ from its build receipt")
    return receipt, receipt_bytes, _package_children(
        root,
        name,
        exclude_development_control=exclude_development_control,
        exclude_candidate_marker=exclude_candidate_marker,
    )


def _assert_exact_backup_inventory(
    root: Path, receipt: Mapping[str, Any], name: str
) -> None:
    """Reject unrecorded package files before an obsolete backup is removed."""

    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, list):
        _fail(f"{name} receipt artifact inventory is invalid")
    allowed_files = {"backend-build-receipt.json", "rotation.json", "bin/fullmag"}
    for index, artifact in enumerate(artifacts):
        if not isinstance(artifact, Mapping) or not isinstance(artifact.get("path"), str):
            _fail(f"{name} receipt artifact {index} has no safe path")
        allowed_files.add(str(artifact["path"]))
    build_log = root / "direct-backend-build.log"
    if build_log.exists() or build_log.is_symlink():
        allowed_files.add("direct-backend-build.log")
    optional_files = PACKAGE_CANDIDATE_OPTIONAL_FILES - {PACKAGE_CANDIDATE_MARKER}
    actual_files, actual_directories = _stage_tree_inventory(root)
    allowed_directories: set[str] = set()
    for relative in allowed_files:
        parts = PurePosixPath(relative).parts
        allowed_directories.update(
            PurePosixPath(*parts[:index]).as_posix() for index in range(1, len(parts))
        )
    if (
        actual_files - optional_files != allowed_files - optional_files
        or actual_directories != allowed_directories
    ):
        _fail(f"{name} has an unrecognized file or directory inventory")


def _preflight_candidate_storage(build_root: Path, receipt: Mapping[str, Any]) -> None:
    """Reject a known-too-small cache before starting an expensive rebuild.

    The verified package artifacts provide only a lower bound for the next
    candidate.  Compiler scratch, incremental state, and changed artifacts can
    require more space, so passing this check never guarantees the build will
    fit.
    """

    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        _fail("verified backend receipt has no artifact sizes for cache preflight")
    estimated_bytes = 0
    for index, artifact in enumerate(artifacts):
        if not isinstance(artifact, Mapping):
            _fail(f"verified backend receipt artifact {index} is not an object")
        size = artifact.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            _fail(f"verified backend receipt artifact {index} has an invalid size")
        estimated_bytes += size
    try:
        usage = os.statvfs(build_root)
    except OSError as error:
        _fail(f"cannot inspect backend cache space at {build_root}: {error}")
    if usage.f_frsize <= 0 or usage.f_bavail < 0:
        _fail(f"backend cache space probe returned invalid values at {build_root}")
    free_bytes = usage.f_bavail * usage.f_frsize
    _log_phase(
        "space",
        "preflight",
        cache_mount=str(build_root),
        free_bytes=free_bytes,
        estimated_bytes=estimated_bytes,
    )
    if free_bytes < estimated_bytes:
        _log_phase(
            "space",
            "rejected",
            cache_mount=str(build_root),
            free_bytes=free_bytes,
            estimated_bytes=estimated_bytes,
            reason="verified-artifact-lower-bound-exceeds-free-space",
        )
        _fail(
            "insufficient backend cache space before rebuild: "
            f"cache_mount={build_root} free_bytes={free_bytes} "
            f"estimated_candidate_artifact_bytes={estimated_bytes}; "
            "estimate uses the previous verified receipt and excludes compiler "
            "scratch or larger changed outputs, so it is only a lower bound; "
            "previous package and cache were preserved"
        )


BACKEND_BUILD_IDENTITY_FIELDS = (
    "cargo_profile",
    "cargo_target_profile_dir",
    "mode",
    "features",
    "fullmag_build_cpu_only",
    "fem_gpu_required",
    "libceed_required",
)


def _expected_backend_build_identity(cargo_profile: str) -> dict[str, Any]:
    """Return the fixed ABI/build inputs that make a package reusable."""

    cargo_profile = _validate_cargo_profile(cargo_profile)
    return {
        "cargo_profile": cargo_profile,
        "cargo_target_profile_dir": cargo_profile,
        "mode": "cuda-fem-gpu",
        "features": ["cuda", "fem-gpu"],
        "fullmag_build_cpu_only": False,
        "fem_gpu_required": True,
        "libceed_required": True,
    }


def _package_matches_fresh_live_manifest(
    receipt: Mapping[str, Any],
    manifest_path: Path,
    toolchain: Mapping[str, Any],
    cargo_profile: str,
) -> bool:
    """Check whether a verified package exactly matches a fresh source capture.

    Capture ids, timestamps, the manifest digest, and the live-manifest digest
    are intentionally excluded: each start creates a new closed manifest even
    when its source identity is unchanged.  The source/native identities,
    toolchain, and fixed build inputs remain exact bindings.
    """

    source = receipt.get("source")
    native = receipt.get("native_source_identity")
    build = receipt.get("build")
    if not isinstance(source, Mapping) or not isinstance(native, Mapping) or not isinstance(build, Mapping):
        return False
    if receipt.get("native_source_identity_sha256") != _sha256_bytes(_canonical(native)):
        return False
    try:
        document, _ = _read_json(manifest_path, "fresh live source manifest", 64 * 1024 * 1024)
        capsule, fresh_native, _git_object_ids, _live_manifest_sha256 = _validate_live_manifest(document)
    except BackendBuildError:
        # The normal prepare path reads and validates the same manifest and
        # remains fail-closed if the trusted capture is malformed.
        raise
    if (
        source.get("source_mode") != LIVE_SOURCE_MODE
        or source.get("source_digest") != capsule.get("source_digest")
        or source.get("resolved_commit") != capsule.get("resolved_commit")
        or source.get("source_snapshot_sha256") != fresh_native.get("source_snapshot_sha256")
        or dict(native) != fresh_native
        or receipt.get("native_source_identity_sha256")
        != _sha256_bytes(_canonical(fresh_native))
    ):
        return False
    if receipt.get("toolchain") != dict(toolchain):
        return False
    expected_build = _expected_backend_build_identity(cargo_profile)
    return all(build.get(field) == expected_build[field] for field in BACKEND_BUILD_IDENTITY_FIELDS)


def _rename_package_child(source_root: Path, target_root: Path, name: str, label: str) -> None:
    source = source_root / name
    target = target_root / name
    if (not source.exists() and not source.is_symlink()) or source.is_symlink():
        _fail(f"{label} source child is missing or unsafe: {name}")
    if target.exists() or target.is_symlink():
        _fail(f"{label} destination child already exists: {name}")
    try:
        os.rename(source, target)
    except OSError as error:
        _fail(f"cannot atomically move {label} child {name}: {error}")


def _rotation_names(value: object, name: str) -> list[str]:
    result = _retention_child_names(value, name)
    if len(result) > MAX_PACKAGE_ROTATION_CHILDREN:
        _fail(f"{name} child inventory is unbounded")
    return result


def _rotation_identity_map(root: Path, names: list[str], name: str) -> dict[str, list[int]]:
    result: dict[str, list[int]] = {}
    for child_name in names:
        try:
            metadata = (root / child_name).lstat()
        except OSError as error:
            _fail(f"cannot inspect {name} child {child_name}: {error}")
        if stat.S_ISLNK(metadata.st_mode) or not (
            stat.S_ISREG(metadata.st_mode) or stat.S_ISDIR(metadata.st_mode)
        ):
            _fail(f"{name} child is unsafe: {child_name}")
        result[child_name] = [
            int(metadata.st_dev),
            int(metadata.st_ino),
            int(stat.S_IFMT(metadata.st_mode)),
        ]
    return result


def _rotation_validate_identity_map(
    root: Path,
    names: set[str],
    expected: object,
    name: str,
) -> None:
    if not isinstance(expected, dict) or set(expected) != names:
        _fail(f"{name} identity map does not match its child inventory")
    actual = _rotation_identity_map(root, sorted(names), name)
    for child_name in sorted(names):
        value = expected.get(child_name)
        if (
            not isinstance(value, list)
            or len(value) != 3
            or any(isinstance(item, bool) or not isinstance(item, int) or item < 0 for item in value)
            or actual[child_name] != value
        ):
            _fail(f"{name} child identity differs from its rotation journal: {child_name}")


def _rotation_metadata_document(rotation: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schema": "fullmag.direct-compose.package-rotation.v1",
        "state": "succeeded",
        "old_receipt_sha256": rotation.get("old_receipt_sha256"),
        "new_receipt_sha256": rotation["new_receipt_sha256"],
        "old_children": list(rotation["old_children"]),
        "new_children": list(rotation["new_children"]),
    }


def _rotation_journal_document(rotation: Mapping[str, Any], state: str) -> dict[str, Any]:
    if state not in {"prepared", "committed"}:
        _fail("backend package rotation journal state is invalid")
    old_names = _rotation_names(rotation.get("old_children"), "rotation old")
    new_names = _rotation_names(rotation.get("new_children"), "rotation new")
    old_identity = rotation.get("old_identity")
    new_identity = rotation.get("new_identity")
    if not isinstance(old_identity, dict) or set(old_identity) != set(old_names):
        _fail("backend package rotation old identity map is invalid")
    if not isinstance(new_identity, dict) or set(new_identity) != set(new_names):
        _fail("backend package rotation new identity map is invalid")
    old_sha256 = rotation.get("old_receipt_sha256")
    new_sha256 = rotation.get("new_receipt_sha256")
    if old_sha256 is not None and (
        not isinstance(old_sha256, str) or not SHA256_RE.fullmatch(old_sha256)
    ):
        _fail("backend package rotation old receipt hash is invalid")
    if not isinstance(new_sha256, str) or not SHA256_RE.fullmatch(new_sha256):
        _fail("backend package rotation new receipt hash is invalid")
    if bool(old_names) != (old_sha256 is not None):
        _fail("backend package rotation old inventory and receipt disagree")
    return {
        "schema": PACKAGE_ROTATION_JOURNAL_SCHEMA,
        "state": state,
        "output": str(rotation["output"]),
        "candidate": str(rotation["candidate"]),
        "backup": rotation.get("backup"),
        "old_children": old_names,
        "new_children": new_names,
        "old_identity": old_identity,
        "new_identity": new_identity,
        "old_receipt_sha256": old_sha256,
        "new_receipt_sha256": new_sha256,
    }


def _write_rotation_journal(rotation: Mapping[str, Any], state: str) -> None:
    path = _absolute(Path(str(rotation["journal"])), "backend package rotation journal")
    _assert_no_links(path.parent, "backend package rotation journal parent")
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        metadata = None
    except OSError as error:
        _fail(f"cannot inspect backend package rotation journal: {error}")
    if metadata is not None and (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1):
        _fail("backend package rotation journal is not one regular file")
    _write_json(path, _rotation_journal_document(rotation, state), "backend package rotation journal")
    _fsync_directory(path.parent, "backend package development control directory")


def _clear_rotation_journal(rotation: Mapping[str, Any]) -> None:
    path = _absolute(Path(str(rotation["journal"])), "backend package rotation journal")
    _assert_no_links(path.parent, "backend package rotation journal parent")
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        _fail(f"cannot inspect backend package rotation journal: {error}")
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        _fail("backend package rotation journal is not one regular file")
    try:
        path.unlink()
    except OSError as error:
        _fail(f"cannot remove backend package rotation journal: {error}")
    _fsync_directory(path.parent, "backend package development control directory")


def _read_rotation_journal(output: Path, control_root: Path) -> dict[str, Any] | None:
    path = control_root / PACKAGE_ROTATION_JOURNAL_NAME
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as error:
        _fail(f"cannot inspect backend package rotation journal: {error}")
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        _fail("backend package rotation journal is not one regular file")
    document, _ = _read_json(path, "backend package rotation journal", 1024 * 1024)
    required = {
        "schema", "state", "output", "candidate", "backup", "old_children",
        "new_children", "old_identity", "new_identity", "old_receipt_sha256",
        "new_receipt_sha256",
    }
    if set(document) != required or document.get("schema") != PACKAGE_ROTATION_JOURNAL_SCHEMA:
        _fail("backend package rotation journal has unexpected fields")
    if document.get("state") not in {"prepared", "committed"} or document.get("output") != str(output):
        _fail("backend package rotation journal does not match this package")
    candidate = _absolute(Path(str(document.get("candidate"))), "rotation journal candidate")
    if candidate.parent != control_root / PACKAGE_CANDIDATES_DIRNAME or not PACKAGE_CANDIDATE_NAME_RE.fullmatch(candidate.name):
        _fail("backend package rotation journal candidate is outside its namespace")
    backup_value = document.get("backup")
    if backup_value is not None:
        if not isinstance(backup_value, str):
            _fail("backend package rotation journal backup path is invalid")
        backup = _absolute(Path(backup_value), "rotation journal backup")
        if backup.parent != control_root / PACKAGE_BACKUPS_DIRNAME or not re.fullmatch(
            r"\.backend-package-backup-[A-Za-z0-9._-]+", backup.name
        ):
            _fail("backend package rotation journal backup is outside its namespace")
    old_names = _rotation_names(document.get("old_children"), "journal old")
    new_names = _rotation_names(document.get("new_children"), "journal new")
    old_identity = document.get("old_identity")
    new_identity = document.get("new_identity")
    if not isinstance(old_identity, dict) or set(old_identity) != set(old_names):
        _fail("backend package rotation journal old identity map is invalid")
    if not isinstance(new_identity, dict) or set(new_identity) != set(new_names):
        _fail("backend package rotation journal new identity map is invalid")
    old_sha256 = document.get("old_receipt_sha256")
    new_sha256 = document.get("new_receipt_sha256")
    if old_sha256 is not None and (not isinstance(old_sha256, str) or not SHA256_RE.fullmatch(old_sha256)):
        _fail("backend package rotation journal old receipt hash is invalid")
    if not isinstance(new_sha256, str) or not SHA256_RE.fullmatch(new_sha256):
        _fail("backend package rotation journal new receipt hash is invalid")
    if bool(old_names) != (old_sha256 is not None):
        _fail("backend package rotation journal old inventory and receipt disagree")
    if "backend-build-receipt.json" not in new_names or (old_names and "backend-build-receipt.json" not in old_names):
        _fail("backend package rotation journal has no package receipt")
    return {
        "journal": str(path),
        "output": str(output),
        "candidate": str(candidate),
        "backup": backup_value,
        "old_children": old_names,
        "new_children": new_names,
        "old_identity": old_identity,
        "new_identity": new_identity,
        "old_receipt_sha256": old_sha256,
        "new_receipt_sha256": new_sha256,
        "state": document["state"],
    }


def _rollback_package_rotation(
    rotation: Mapping[str, Any], *, tolerate_completed: bool = False
) -> list[str]:
    """Move only this rotation's children back, refusing destination overwrite."""

    output = Path(str(rotation["output"]))
    candidate = Path(str(rotation["candidate"]))
    backup_value = rotation.get("backup")
    backup = Path(str(backup_value)) if backup_value is not None else None
    new_names = [str(name) for name in rotation["new_children"]]
    old_names = [str(name) for name in rotation["old_children"]]
    errors: list[str] = []
    for name in reversed(new_names):
        source = output / name
        target = candidate / name
        if not source.exists() and not source.is_symlink():
            if tolerate_completed and (target.exists() or target.is_symlink()):
                try:
                    _rotation_identity_map(candidate, [name], "completed candidate rollback")
                except (BackendBuildError, OSError) as error:
                    errors.append(str(error))
                continue
            errors.append(f"candidate rollback source is missing: {name}")
            continue
        if target.exists() or target.is_symlink():
            errors.append(f"candidate rollback destination already exists: {name}")
            continue
        try:
            _rotation_identity_map(output, [name], "candidate rollback source")
            _rename_package_child(output, candidate, name, "candidate rollback")
        except (BackendBuildError, OSError) as error:
            errors.append(f"candidate rollback failed for {name}: {error}")
    if backup is not None:
        for name in old_names:
            source = backup / name
            target = output / name
            if not source.exists() and not source.is_symlink():
                if tolerate_completed and (target.exists() or target.is_symlink()):
                    try:
                        _rotation_identity_map(output, [name], "completed old package rollback")
                    except (BackendBuildError, OSError) as error:
                        errors.append(str(error))
                    continue
                errors.append(f"backup rollback source is missing: {name}")
                continue
            if target.exists() or target.is_symlink():
                errors.append(f"old package rollback destination already exists: {name}")
                continue
            try:
                _rotation_identity_map(backup, [name], "old package rollback source")
                _rename_package_child(backup, output, name, "old package rollback")
            except (BackendBuildError, OSError) as error:
                errors.append(f"old package rollback failed for {name}: {error}")
    for directory, label in (
        (output, "backend package output directory after rollback"),
        (candidate, "backend package candidate directory after rollback"),
    ):
        try:
            _fsync_directory(directory, label)
        except (BackendBuildError, OSError) as error:
            errors.append(f"{label} durability sync failed: {error}")
    if backup is not None:
        try:
            _fsync_directory(backup, "backend package backup directory after rollback")
        except (BackendBuildError, OSError) as error:
            errors.append(f"backend package backup directory durability sync failed: {error}")
    return errors


def _rotate_package(
    output: Path,
    candidate: Path,
    control_root: Path,
    previous_children: Mapping[str, tuple[int, int, int, int, int]],
    previous_receipt_bytes: bytes | None,
    candidate_receipt_bytes: bytes,
) -> dict[str, Any]:
    """Atomically replace package children while retaining the previous tree."""

    output = _absolute(output, "backend output")
    control_root = _absolute(control_root, "backend package development control directory")
    if control_root != output / PACKAGE_DEVELOPMENT_DIRNAME:
        _fail("backend package development control directory is not under the package mount")
    _ensure_package_development_root(output)
    current_children = _package_children(
        output, "current backend package", exclude_development_control=True
    )
    if dict(current_children) != dict(previous_children):
        _fail("backend package changed while its build candidate was prepared")
    candidate_children = _package_children(
        candidate,
        "candidate backend package",
        exclude_candidate_marker=True,
    )
    new_names = sorted(candidate_children)
    if "backend-build-receipt.json" not in candidate_children:
        _fail("candidate backend package has no build receipt")
    ordered_new_names = [name for name in new_names if name != "backend-build-receipt.json"]
    ordered_new_names.append("backend-build-receipt.json")
    old_names = sorted(current_children)
    if len(old_names) > MAX_PACKAGE_ROTATION_CHILDREN or len(ordered_new_names) > MAX_PACKAGE_ROTATION_CHILDREN:
        _fail("backend package rotation inventory is unbounded")
    old_identity = _rotation_identity_map(output, old_names, "current backend package")
    new_identity = _rotation_identity_map(candidate, ordered_new_names, "candidate backend package")
    journal = control_root / PACKAGE_ROTATION_JOURNAL_NAME
    if journal.exists() or journal.is_symlink():
        _fail("backend package has a pending rotation journal")
    backup: Path | None = None
    if old_names:
        suffix = candidate.name.removeprefix(".backend-package-candidate-")
        if not suffix or not re.fullmatch(r"[A-Za-z0-9._-]+", suffix):
            _fail("backend package candidate has an unsafe rotation suffix")
        backup = control_root / PACKAGE_BACKUPS_DIRNAME / f".backend-package-backup-{suffix}"
        if backup.exists() or backup.is_symlink():
            _fail("backend package rotation backup already exists")
    old_receipt_sha256 = _sha256_bytes(previous_receipt_bytes) if previous_receipt_bytes is not None else None
    new_receipt_sha256 = _sha256_bytes(candidate_receipt_bytes)
    rotation: dict[str, Any] = {
        "output": str(output),
        "candidate": str(candidate),
        "backup": str(backup) if backup is not None else None,
        "journal": str(journal),
        "old_children": old_names,
        "new_children": ordered_new_names,
        "old_identity": old_identity,
        "new_identity": new_identity,
        "old_receipt_sha256": old_receipt_sha256,
        "new_receipt_sha256": new_receipt_sha256,
    }
    moved_old: list[str] = []
    moved_new: list[str] = []
    try:
        _write_rotation_journal(rotation, "prepared")
        if backup is not None:
            try:
                backup.mkdir()
            except OSError as error:
                _fail(f"cannot create retained backend package backup: {error}")
            _fsync_directory(backup, "backend package backup directory")
            _fsync_directory(backup.parent, "backend package backup directory")
            for name in old_names:
                _rename_package_child(output, backup, name, "old package backup")
                moved_old.append(name)
        for name in ordered_new_names:
            _rename_package_child(candidate, output, name, "candidate package")
            moved_new.append(name)
        _fsync_directory(output, "backend package output directory")
        _fsync_directory(candidate, "backend package candidate directory")
        if backup is not None:
            _write_json(
                backup / "rotation.json",
                _rotation_metadata_document(rotation),
                "backend package rotation metadata",
            )
            _fsync_directory(backup, "backend package backup directory")
        _write_rotation_journal(rotation, "committed")
        return rotation
    except (BackendBuildError, OSError) as error:
        rollback = {**rotation, "old_children": moved_old, "new_children": moved_new}
        rollback_errors = _rollback_package_rotation(rollback)
        if not rollback_errors and backup is not None and backup.exists():
            try:
                if not any(backup.iterdir()):
                    _remove_owned_tree(backup)
                    _fsync_directory(backup.parent, "backend package backup directory")
            except OSError as cleanup_error:
                rollback_errors.append(f"empty backup cleanup failed: {cleanup_error}")
        if rollback_errors:
            _fail(
                "backend package publication failed and rollback is incomplete; "
                f"retained backup={backup}: {'; '.join(rollback_errors)}"
            )
        if isinstance(error, BackendBuildError):
            raise
        _fail(f"backend package publication failed: {error}")


def _finalize_published_candidate(candidate: Path, rotation: Mapping[str, Any]) -> None:
    """Remove only the marker from a candidate after a committed rotation.

    ``_rotate_package`` intentionally excludes the candidate owner marker from
    the package children it moves.  The marker therefore remains as a small
    piece of incomplete-publication evidence until the committed rotation has
    been checked.  This helper validates that exact rotation and refuses to
    remove any payload or unknown entry from the candidate directory.
    """

    candidate = _absolute(candidate, "published backend package candidate")
    if rotation.get("candidate") != str(candidate):
        _fail("published backend package candidate does not match its rotation")
    output_value = rotation.get("output")
    new_names = rotation.get("new_children")
    if not isinstance(output_value, str) or not isinstance(new_names, list):
        _fail("published backend package rotation has no exact successor inventory")
    if any(
        not isinstance(name, str)
        or not name
        or name in {".", ".."}
        or "/" in name
        or "\\" in name
        for name in new_names
    ) or len(new_names) != len(set(new_names)):
        _fail("published backend package rotation successor inventory is unsafe")
    output = _absolute(Path(output_value), "published backend package")
    current_children = _package_children(
        output,
        "published backend package",
        exclude_development_control=True,
    )
    if set(current_children) != set(new_names):
        _fail("published backend package successor inventory differs from rotation")
    try:
        metadata = candidate.lstat()
    except FileNotFoundError:
        # A retry after a completed cleanup is idempotent.  No path is
        # removed in this case.
        return
    except OSError as error:
        _fail(f"cannot inspect published backend package candidate: {error}")
    if (
        stat.S_ISLNK(metadata.st_mode)
        or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)
        or not stat.S_ISDIR(metadata.st_mode)
    ):
        _fail("published backend package candidate is unsafe")
    try:
        entries = tuple(sorted(candidate.iterdir(), key=lambda path: path.name))
    except OSError as error:
        _fail(f"cannot inspect published backend package candidate: {error}")
    if not entries:
        # A crash after unlinking the marker leaves no payload to preserve.
        # Removing this empty directory is the only recovery deletion allowed.
        try:
            candidate.rmdir()
        except OSError as error:
            _fail(f"cannot remove empty published backend package candidate: {error}")
        _fsync_directory(candidate.parent, "backend package candidate directory")
        return
    if len(entries) != 1 or entries[0].name != PACKAGE_CANDIDATE_MARKER:
        _fail("published backend package candidate retains payload or unknown entries")
    marker = entries[0]
    marker_metadata = marker.lstat()
    if not stat.S_ISREG(marker_metadata.st_mode) or marker_metadata.st_nlink != 1:
        _fail("published backend package candidate owner marker is unsafe")
    try:
        marker.unlink()
        _fsync_directory(candidate, "published backend package candidate directory")
        candidate.rmdir()
        _fsync_directory(candidate.parent, "backend package candidate directory")
    except OSError as error:
        _fail(f"cannot finalize published backend package candidate: {error}")


def _rotation_children(
    root: Path,
    name: str,
    *,
    candidate: bool = False,
    output: bool = False,
) -> set[str] | None:
    try:
        root.lstat()
    except FileNotFoundError:
        return None
    except OSError as error:
        _fail(f"cannot inspect {name}: {error}")
    return set(
        _package_children(
            root,
            name,
            exclude_development_control=output,
            exclude_candidate_marker=candidate,
        )
    )


def _rotation_validate_full(
    root: Path,
    name: str,
    rotation: Mapping[str, Any],
    expected_sha256: str,
    expected_children: set[str],
    identity: object,
    *,
    candidate: bool = False,
    backup: bool = False,
    output: bool = False,
) -> tuple[dict[str, Any], bytes]:
    receipt, receipt_bytes, children = _validated_package(
        root,
        name,
        exclude_development_control=output,
        exclude_candidate_marker=candidate,
    )
    if _sha256_bytes(receipt_bytes) != expected_sha256 or set(children) != expected_children:
        _fail(f"{name} differs from the pending rotation receipt")
    identity_names = expected_children - ({"rotation.json"} if backup else set())
    _rotation_validate_identity_map(root, identity_names, identity, name)
    if candidate:
        _assert_direct_candidate_inventory(
            root, receipt["artifacts"], include_receipt=True
        )
    if backup:
        metadata_path = root / "rotation.json"
        expected = _rotation_metadata_document(rotation)
        try:
            metadata_path.lstat()
        except FileNotFoundError:
            _write_json(metadata_path, expected, "backend package rotation metadata recovery")
            _fsync_directory(root, "backend package backup directory")
        observed, _ = _read_json(
            metadata_path, "backend package rotation metadata", 1024 * 1024
        )
        if observed != expected:
            _fail("pending backend package rotation metadata differs from its journal")
        _assert_exact_backup_inventory(root, receipt, name)
    return receipt, receipt_bytes


def _rotation_remove_empty_backup(rotation: Mapping[str, Any]) -> None:
    value = rotation.get("backup")
    if value is None:
        return
    backup = Path(str(value))
    children = _rotation_children(backup, "pending backend package backup")
    if children is None:
        return
    if children == {"rotation.json"}:
        observed, _ = _read_json(
            backup / "rotation.json", "pending backend package rotation metadata", 1024 * 1024
        )
        if observed != _rotation_metadata_document(rotation):
            _fail("pending backend package rotation metadata differs before cleanup")
    elif children:
        _fail("pending backend package backup is not empty")
    _remove_owned_tree(backup)
    _fsync_directory(backup.parent, "backend package backup directory")


def _rotation_validate_partitions(
    rotation: Mapping[str, Any],
    output: Path,
    candidate: Path,
    backup: Path | None,
) -> tuple[set[str], set[str], set[str], set[str] | None, set[str] | None]:
    """Classify every journaled child before any recovery rename or cleanup."""

    old_names = set(rotation["old_children"])
    new_names = set(rotation["new_children"])
    if old_names and backup is None:
        _fail("pending rotation with an old package has no backup namespace")
    output_children = _rotation_children(
        output, "pending backend package output", output=True
    )
    if output_children is None:
        _fail("pending rotation output is missing")
    candidate_children = _rotation_children(
        candidate, "pending backend package candidate", candidate=True
    )
    backup_children = (
        _rotation_children(backup, "pending backend package backup")
        if backup is not None
        else None
    )
    backup_payload = (backup_children or set()) - {"rotation.json"}
    if output_children - old_names - new_names:
        _fail("pending rotation has unknown current children")
    if candidate_children is not None and candidate_children - new_names:
        _fail("pending rotation has unknown candidate children")
    if backup_payload - old_names:
        _fail("pending rotation has unknown backup children")
    if backup_children and "rotation.json" in backup_children:
        observed, _ = _read_json(
            backup / "rotation.json", "pending backend package rotation metadata", 1024 * 1024
        )
        if observed != _rotation_metadata_document(rotation):
            _fail("pending backend package rotation metadata differs from its journal")

    output_identity = _rotation_identity_map(
        output, sorted(output_children), "pending backend package output"
    )
    candidate_identity = (
        _rotation_identity_map(
            candidate, sorted(candidate_children), "pending backend package candidate"
        )
        if candidate_children is not None
        else {}
    )
    backup_identity = (
        _rotation_identity_map(
            backup, sorted(backup_payload), "pending backend package backup"
        )
        if backup_payload and backup is not None
        else {}
    )
    old_identity = rotation["old_identity"]
    new_identity = rotation["new_identity"]

    def matches(expected: object, name: str, actual: list[int]) -> bool:
        value = expected.get(name) if isinstance(expected, dict) else None
        return (
            isinstance(value, list)
            and len(value) == 3
            and all(
                isinstance(item, int) and not isinstance(item, bool) and item >= 0
                for item in value
            )
            and actual == value
        )

    # Each observed object must be one of the exact old/new objects recorded by
    # the journal.  A top-level name shared by both generations is accepted
    # only when its identity selects exactly one generation.
    for name in sorted(output_children):
        old_match = name in old_names and matches(old_identity, name, output_identity[name])
        new_match = name in new_names and matches(new_identity, name, output_identity[name])
        if old_match == new_match:
            _fail(f"pending rotation output child has no unique journal identity: {name}")
    for name in sorted(candidate_children or set()):
        if name not in new_names or not matches(new_identity, name, candidate_identity[name]):
            _fail(f"pending rotation candidate child has no journal identity: {name}")
    for name in sorted(backup_payload):
        if name not in old_names or not matches(old_identity, name, backup_identity[name]):
            _fail(f"pending rotation backup child has no journal identity: {name}")

    old_locations: dict[str, str] = {}
    for name in sorted(old_names):
        locations: list[str] = []
        if name in output_children and matches(old_identity, name, output_identity[name]):
            locations.append("output")
        if name in backup_payload and matches(old_identity, name, backup_identity[name]):
            locations.append("backup")
        if len(locations) != 1:
            _fail(f"pending rotation old child is missing or duplicated: {name}")
        old_locations[name] = locations[0]

    new_locations: dict[str, str] = {}
    for name in sorted(new_names):
        locations: list[str] = []
        if name in output_children and matches(new_identity, name, output_identity[name]):
            locations.append("output")
        if (
            candidate_children is not None
            and name in candidate_children
            and matches(new_identity, name, candidate_identity[name])
        ):
            locations.append("candidate")
        if len(locations) != 1:
            _fail(f"pending rotation new child is missing or duplicated: {name}")
        new_locations[name] = locations[0]

    moved_old = {name for name, location in old_locations.items() if location == "backup"}
    moved_new = {name for name, location in new_locations.items() if location == "output"}
    return moved_old, moved_new, output_children, candidate_children, backup_children


def _recover_pending_package_rotation(output: Path, control_root: Path, build_root: Path) -> None:
    """Recover one exact journaled rotation while the runtime lock is held."""

    rotation = _read_rotation_journal(output, control_root)
    if rotation is None:
        return
    candidate = Path(str(rotation["candidate"]))
    backup_value = rotation.get("backup")
    backup = Path(str(backup_value)) if backup_value is not None else None
    old_names = set(rotation["old_children"])
    new_names = set(rotation["new_children"])
    moved_old, moved_new, output_children, candidate_children, backup_children = (
        _rotation_validate_partitions(rotation, output, candidate, backup)
    )
    old_sha256 = rotation.get("old_receipt_sha256")
    new_sha256 = str(rotation["new_receipt_sha256"])

    # A complete successor in output plus a complete old rollback in backup is
    # the only published state.  Candidate marker cleanup is then the final
    # idempotent step; no payload is removed from an unknown location.
    if moved_new == new_names and moved_old == old_names:
        if old_names:
            if backup is None:
                _fail("published pending rotation has no verified rollback namespace")
            backup_expected = old_names | (
                {"rotation.json"} if backup_children and "rotation.json" in backup_children else set()
            )
            _rotation_validate_full(
                backup,
                "pending backend package backup",
                rotation,
                str(old_sha256),
                backup_expected,
                rotation["old_identity"],
                backup=True,
            )
        elif backup_children:
            _fail("first published pending rotation has an unexpected backup")
        current, _ = _rotation_validate_full(
            output,
            "published backend package",
            rotation,
            new_sha256,
            new_names,
            rotation["new_identity"],
            output=True,
        )
        if candidate.exists() or candidate.is_symlink():
            if candidate_children:
                _fail("published pending candidate still contains payload")
            entries = tuple(sorted(candidate.iterdir(), key=lambda path: path.name))
            if entries:
                marker = _validate_candidate_marker(candidate, output, build_root, state="ready")
                if marker.get("artifact_inventory_sha256") != _sha256_bytes(
                    _canonical(current["artifacts"])
                ):
                    _fail("published pending candidate marker differs from current package")
            _finalize_published_candidate(candidate, rotation)
        _clear_rotation_journal(rotation)
        return

    # No payload moved: this is the prepared journal state.  Validate both
    # complete generations, then retire only the exact owned candidate/backup.
    if not moved_old and not moved_new:
        if candidate_children is None:
            _fail("unpublished pending rotation lost its candidate")
        _validate_candidate_marker(candidate, output, build_root, state="ready")
        if old_names:
            _rotation_validate_full(
                output,
                "unpublished current backend package",
                rotation,
                str(old_sha256),
                old_names,
                rotation["old_identity"],
                output=True,
            )
        elif output_children:
            _fail("first unpublished pending rotation retained current children")
        _rotation_validate_full(
            candidate,
            "unpublished backend package candidate",
            rotation,
            new_sha256,
            new_names,
            rotation["new_identity"],
            candidate=True,
        )
        _remove_owned_tree(candidate)
        _fsync_directory(candidate.parent, "backend package candidate directory")
        _rotation_remove_empty_backup(rotation)
        _clear_rotation_journal(rotation)
        return

    # Every other partition is a crash during old->backup or candidate->output.
    # Roll back only the names actually observed in their moved locations.  A
    # later crash during this rollback is handled by the same classification.
    if candidate_children is None:
        _fail("partial pending rotation lost its candidate")
    _validate_candidate_marker(candidate, output, build_root, state="ready")
    rollback = {
        **rotation,
        "old_children": sorted(moved_old),
        "new_children": sorted(moved_new),
    }
    rollback_errors = _rollback_package_rotation(rollback, tolerate_completed=True)
    if rollback_errors:
        _fail("pending backend package rollback is incomplete: " + "; ".join(rollback_errors))
    if old_names:
        _rotation_validate_full(
            output,
            "rolled-back backend package",
            rotation,
            str(old_sha256),
            old_names,
            rotation["old_identity"],
            output=True,
        )
    elif _rotation_children(output, "rolled-back first backend package", output=True):
        _fail("first package rollback retained current children")
    _rotation_validate_full(
        candidate,
        "rolled-back backend package candidate",
        rotation,
        new_sha256,
        new_names,
        rotation["new_identity"],
        candidate=True,
    )
    _remove_owned_tree(candidate)
    _fsync_directory(candidate.parent, "backend package candidate directory")
    _rotation_remove_empty_backup(rotation)
    _clear_rotation_journal(rotation)


def _retention_receipt_identity(
    receipt: Mapping[str, Any], name: str
) -> tuple[str, dict[str, Any], dict[str, Any]]:
    """Validate the identity fields used to join a backup to this cache chain."""

    source = receipt.get("source")
    native = receipt.get("native_source_identity")
    toolchain = receipt.get("toolchain")
    build = receipt.get("build")
    if not isinstance(source, Mapping) or not isinstance(native, Mapping):
        _fail(f"{name} has incomplete source identity")
    if not isinstance(toolchain, Mapping) or not isinstance(build, Mapping):
        _fail(f"{name} has incomplete build identity")
    source_mode = source.get("source_mode")
    commit = source.get("resolved_commit")
    source_digest = source.get("source_digest")
    source_snapshot = source.get("source_snapshot_sha256")
    native_snapshot = native.get("source_snapshot_sha256")
    native_digest = receipt.get("native_source_identity_sha256")
    image_id = toolchain.get("image_id")
    if (
        not isinstance(source_mode, str)
        or not source_mode
        or not isinstance(commit, str)
        or not GIT_OBJECT_RE.fullmatch(commit)
        or not isinstance(source_digest, str)
        or not SHA256_RE.fullmatch(source_digest)
        or not isinstance(source_snapshot, str)
        or not SHA256_RE.fullmatch(source_snapshot)
        or native_snapshot != source_snapshot
        or not isinstance(native_digest, str)
        or native_digest != _sha256_bytes(_canonical(native))
        or not isinstance(image_id, str)
        or not IMAGE_RE.fullmatch(image_id)
    ):
        _fail(f"{name} has an invalid source or toolchain identity")
    for field in BACKEND_BUILD_IDENTITY_FIELDS:
        if field not in build:
            _fail(f"{name} is missing build identity field {field}")
    return source_mode, dict(build), dict(toolchain)


def _retention_child_names(value: object, name: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        _fail(f"{name} child list is invalid")
    result = [str(item) for item in value]
    if len(result) != len(set(result)):
        _fail(f"{name} child list contains duplicates")
    if any(
        not item
        or item in {".", ".."}
        or "/" in item
        or "\\" in item
        for item in result
    ):
        _fail(f"{name} child list contains an unsafe path")
    return result


def _validate_retention_archives(
    archive_root: Path, *, verify_disposable_logs: bool = True
) -> list[dict[str, Any]]:
    """Validate archive structure and bindings, optionally hashing legacy logs."""

    try:
        entries = tuple(sorted(archive_root.iterdir(), key=lambda path: path.name))
    except OSError as error:
        _fail(f"cannot inspect backend package retention archive: {error}")
    validated: list[dict[str, Any]] = []
    for archive in entries:
        if not re.fullmatch(r"\.backend-package-backup-[A-Za-z0-9._-]+", archive.name):
            _fail(f"backend package retention archive has an unknown entry: {archive.name}")
        _assert_safe_tree(archive, f"backend package retention archive {archive.name}")
        manifest_path = archive / "retention.json"
        manifest, _ = _read_json(
            manifest_path,
            f"backend package retention archive {archive.name} manifest",
            1024 * 1024,
        )
        manifest_stat = manifest_path.stat()
        if (
            manifest.get("schema") != PACKAGE_RETENTION_SCHEMA
            or manifest.get("state") != "succeeded"
            or manifest.get("backup_name") != archive.name
        ):
            _fail(f"backend package retention archive {archive.name} manifest is invalid")
        retired_at_ns = manifest.get("retired_at_ns")
        if retired_at_ns is None:
            # Legacy archives did not record an order. Filesystem time only
            # chooses which redundant audit copy to retain; it is not proof
            # that any archive is safe to delete.
            retired_at_ns = manifest_stat.st_mtime_ns
        elif (
            isinstance(retired_at_ns, bool)
            or not isinstance(retired_at_ns, int)
            or retired_at_ns < 0
        ):
            _fail(f"backend package retention archive {archive.name} has an invalid order")
        receipt_sha = manifest.get("receipt_sha256")
        rotation_sha = manifest.get("rotation_sha256")
        current_sha = manifest.get("current_receipt_sha256")
        if (
            not isinstance(receipt_sha, str)
            or not SHA256_RE.fullmatch(receipt_sha)
            or not isinstance(rotation_sha, str)
            or not SHA256_RE.fullmatch(rotation_sha)
            or not isinstance(current_sha, str)
            or not SHA256_RE.fullmatch(current_sha)
        ):
            _fail(f"backend package retention archive {archive.name} has invalid hashes")
        metadata = manifest.get("metadata")
        if not isinstance(metadata, list) or not metadata:
            _fail(f"backend package retention archive {archive.name} has no metadata")
        expected = {"retention.json"}
        metadata_by_path: dict[str, Mapping[str, Any]] = {}
        archive_size = manifest_stat.st_size
        for index, record in enumerate(metadata):
            if not isinstance(record, Mapping):
                _fail(f"backend package retention archive metadata {index} is invalid")
            path = record.get("path")
            size = record.get("size")
            digest = record.get("sha256")
            maximum = {
                "backend-build-receipt.json": 8 * 1024 * 1024,
                "rotation.json": 1024 * 1024,
                "direct-backend-build.log": MAX_SOURCE_BYTES,
            }.get(path) if isinstance(path, str) else None
            if (
                maximum is None
                or isinstance(size, bool)
                or not isinstance(size, int)
                or size < 0
                or size > maximum
                or not isinstance(digest, str)
                or not SHA256_RE.fullmatch(digest)
                or path in expected
            ):
                _fail(f"backend package retention archive metadata {index} is invalid")
            expected.add(path)
            metadata_by_path[path] = record
            archived_path = archive / path
            try:
                observed_stat = archived_path.lstat()
            except OSError as error:
                _fail(
                    "cannot inspect backend package retention archive "
                    f"{archive.name}/{path}: {error}"
                )
            if not stat.S_ISREG(observed_stat.st_mode) or observed_stat.st_size != size:
                _fail(f"backend package retention archive {archive.name}/{path} changed")
            archive_size += size
            if path != "direct-backend-build.log" or verify_disposable_logs:
                observed_digest, observed_stat = _sha256_file(
                    archived_path,
                    f"backend package retention archive {archive.name}/{path}",
                    maximum,
                )
                if observed_stat.st_size != size or observed_digest != digest:
                    _fail(f"backend package retention archive {archive.name}/{path} changed")
        required_metadata = {"backend-build-receipt.json", "rotation.json"}
        if not required_metadata.issubset(metadata_by_path):
            _fail(f"backend package retention archive {archive.name} is missing receipt metadata")
        if (
            metadata_by_path["backend-build-receipt.json"]["sha256"] != receipt_sha
            or metadata_by_path["rotation.json"]["sha256"] != rotation_sha
        ):
            _fail(f"backend package retention archive {archive.name} metadata hashes are unbound")
        archived_rotation, _ = _read_json(
            archive / "rotation.json",
            f"backend package retention archive {archive.name} rotation",
            1024 * 1024,
        )
        if archived_rotation.get("old_receipt_sha256") != receipt_sha:
            _fail(
                f"backend package retention archive {archive.name} "
                "rotation is not receipt-bound"
            )
        actual = {child.name for child in archive.iterdir()}
        if actual != expected:
            _fail(f"backend package retention archive {archive.name} has unexpected files")
        validated.append(
            {
                "path": archive,
                "order": retired_at_ns,
                "size": archive_size,
                "metadata": metadata_by_path,
            }
        )
    return validated


def _prune_retention_archives(archive_root: Path) -> int:
    """Keep a bounded, verified set of compact package-retirement evidence."""

    archives = _validate_retention_archives(archive_root, verify_disposable_logs=False)
    ordered = sorted(
        archives,
        key=lambda record: (record["order"], record["path"].name),
        reverse=True,
    )
    retained: list[dict[str, Any]] = []
    retained_bytes = 0
    for record in ordered:
        if len(retained) >= PACKAGE_RETENTION_ARCHIVE_COUNT_LIMIT:
            break
        if retained_bytes + record["size"] > PACKAGE_RETENTION_ARCHIVE_BYTES_LIMIT:
            continue
        retained.append(record)
        retained_bytes += record["size"]
    retained_names = {record["path"].name for record in retained}
    # A legacy log can be kept only when the full retained archive set fits
    # the byte budget and its content still matches the retention manifest.
    for record in retained:
        log_record = record["metadata"].get("direct-backend-build.log")
        if log_record is None:
            continue
        log_path = record["path"] / "direct-backend-build.log"
        observed_digest, observed_stat = _sha256_file(
            log_path,
            f"backend package retention archive {record['path'].name}/direct-backend-build.log",
            MAX_SOURCE_BYTES,
        )
        if (
            observed_stat.st_size != log_record["size"]
            or observed_digest != log_record["sha256"]
        ):
            _fail(
                "backend package retention archive "
                f"{record['path'].name}/direct-backend-build.log changed"
            )
    removed = 0
    for record in archives:
        archive = record["path"]
        if archive.name in retained_names:
            continue
        _remove_owned_tree(archive)
        removed += 1
    if removed:
        _fsync_directory(archive_root, "backend package retention archive directory")
    return removed


def _candidate_marker_path(candidate: Path) -> Path:
    return candidate / PACKAGE_CANDIDATE_MARKER


def _validate_candidate_marker(
    candidate: Path,
    package_root: Path,
    build_root: Path,
    *,
    state: str | None = None,
) -> dict[str, Any]:
    """Validate the worker-owned marker for one incomplete package candidate."""

    candidate = _absolute(candidate, "backend package candidate")
    package_root = _absolute(package_root, "backend package root")
    build_root = _absolute(build_root, "backend build root")
    expected_parent = package_root / PACKAGE_DEVELOPMENT_DIRNAME / PACKAGE_CANDIDATES_DIRNAME
    if candidate.parent != expected_parent or not PACKAGE_CANDIDATE_NAME_RE.fullmatch(candidate.name):
        _fail(f"backend package candidate is outside the owned candidate namespace: {candidate}")
    _assert_no_links(candidate, "backend package candidate")
    metadata = candidate.lstat()
    if not stat.S_ISDIR(metadata.st_mode):
        _fail(f"backend package candidate is not a directory: {candidate}")
    marker = _candidate_marker_path(candidate)
    try:
        marker_metadata = marker.lstat()
    except OSError as error:
        _fail(f"cannot inspect backend package candidate owner marker: {error}")
    if not stat.S_ISREG(marker_metadata.st_mode) or marker_metadata.st_nlink != 1:
        _fail("backend package candidate owner marker is not one regular file")
    document, _ = _read_json(marker, "backend package candidate owner marker", 16 * 1024)
    required = {
        "schema",
        "state",
        "candidate",
        "package_root",
        "build_root",
        "cargo_profile",
    }
    if document.get("state") == "ready":
        required.add("artifact_inventory_sha256")
    if set(document) != required:
        _fail("backend package candidate owner marker has unexpected fields")
    if (
        document.get("schema") != PACKAGE_CANDIDATE_SCHEMA
        or document.get("candidate") != str(candidate)
        or document.get("package_root") != str(package_root)
        or document.get("build_root") != str(build_root)
        or document.get("cargo_profile") != BACKEND_CARGO_PROFILE
        or document.get("state") not in {"building", "ready"}
    ):
        _fail("backend package candidate owner marker does not match this build")
    marker_state = str(document["state"])
    if state is not None and marker_state != state:
        _fail(
            "backend package candidate owner marker has unexpected state: "
            f"{marker_state!r}"
        )
    if marker_state == "ready" and not (
        isinstance(document.get("artifact_inventory_sha256"), str)
        and SHA256_RE.fullmatch(document["artifact_inventory_sha256"])
    ):
        _fail("backend package candidate owner marker has no artifact inventory proof")
    return document


def _write_candidate_marker(
    candidate: Path,
    package_root: Path,
    build_root: Path,
    *,
    state: str,
    records: list[dict[str, Any]] | None = None,
) -> None:
    document: dict[str, Any] = {
        "schema": PACKAGE_CANDIDATE_SCHEMA,
        "state": state,
        "candidate": str(_absolute(candidate, "backend package candidate")),
        "package_root": str(_absolute(package_root, "backend package root")),
        "build_root": str(_absolute(build_root, "backend build root")),
        "cargo_profile": BACKEND_CARGO_PROFILE,
    }
    if records is not None:
        document["artifact_inventory_sha256"] = _sha256_bytes(_canonical(records))
    _write_json(
        _candidate_marker_path(candidate),
        document,
        "backend package candidate owner marker",
    )
    _fsync_directory(candidate, "backend package candidate directory")


def _reject_partial_package_candidates(
    output: Path,
    control_root: Path,
    build_root: Path,
    *,
    current_package: tuple[
        dict[str, Any], bytes, dict[str, tuple[int, int, int, int, int]]
    ]
    | None = None,
) -> None:
    """Recover only a marker-only candidate after a committed package rotation.

    A rotation moves the package payload before the candidate marker is
    removed.  If the worker stops between those operations, the next start may
    remove that marker only after validating the current package's actual
    receipt inventory.  Every other candidate state remains an operator-visible
    failure.  An empty owned candidate directory is also safe to remove: it is
    the only state left by a crash after marker unlink and before ``rmdir``.
    """

    candidates = control_root / PACKAGE_CANDIDATES_DIRNAME
    try:
        iterator = iter(candidates.iterdir())
        entries: list[Path] = []
        for _ in range(MAX_PACKAGE_CANDIDATES + 1):
            try:
                entries.append(next(iterator))
            except StopIteration:
                break
        if len(entries) > MAX_PACKAGE_CANDIDATES:
            _fail("backend package candidate staging exceeds its bounded entry limit")
    except OSError as error:
        _fail(f"cannot inspect backend package candidate staging: {error}")
    for entry in sorted(entries, key=lambda path: path.name):
        metadata = entry.lstat()
        if (
            stat.S_ISLNK(metadata.st_mode)
            or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)
            or not stat.S_ISDIR(metadata.st_mode)
        ):
            _fail(f"backend package candidate staging contains an unsafe entry: {entry.name}")
        try:
            child_entries = tuple(sorted(entry.iterdir(), key=lambda path: path.name))
        except OSError as error:
            _fail(f"cannot inspect backend package candidate {entry.name}: {error}")
        if not child_entries:
            if not PACKAGE_CANDIDATE_NAME_RE.fullmatch(entry.name):
                _fail(
                    "backend package candidate staging contains an unknown empty entry: "
                    f"{entry.name}"
                )
            try:
                entry.rmdir()
                _fsync_directory(entry.parent, "backend package candidate directory")
            except OSError as error:
                _fail(f"cannot remove empty backend package candidate {entry.name}: {error}")
            continue

        marker = _validate_candidate_marker(entry, output, build_root, state=None)
        if marker.get("state") != "ready":
            _fail(
                "backend package candidate from an incomplete prior build is preserved: "
                f"{entry.name}"
            )
        if len(child_entries) != 1 or child_entries[0].name != PACKAGE_CANDIDATE_MARKER:
            _fail(
                "ready backend package candidate retains payload or unknown entries: "
                f"{entry.name}"
            )
        marker_path = child_entries[0]
        marker_metadata = marker_path.lstat()
        if not stat.S_ISREG(marker_metadata.st_mode) or marker_metadata.st_nlink != 1:
            _fail("ready backend package candidate owner marker is unsafe")
        if current_package is None:
            _fail(
                "ready backend package candidate cannot be retired without a verified current package"
            )
        artifacts = current_package[0].get("artifacts")
        if not isinstance(artifacts, list):
            _fail("verified current backend package has no artifact inventory")
        current_inventory_sha256 = _sha256_bytes(_canonical(artifacts))
        if marker.get("artifact_inventory_sha256") != current_inventory_sha256:
            _fail(
                "ready backend package candidate inventory differs from the verified current package"
            )
        try:
            marker_path.unlink()
            _fsync_directory(entry, "backend package candidate directory")
            entry.rmdir()
            _fsync_directory(entry.parent, "backend package candidate directory")
        except OSError as error:
            _fail(f"cannot retire published backend package candidate {entry.name}: {error}")


def _flatten_package_library_aliases(root: Path) -> None:
    """Materialize only the allowed native SONAME aliases in a direct candidate."""

    library_root = root / "lib"
    if not library_root.exists() and not library_root.is_symlink():
        _fail("direct backend package has no library directory")
    metadata = library_root.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        _fail("direct backend package library directory is unsafe")
    for child in sorted(library_root.iterdir(), key=lambda path: path.name):
        if not child.is_symlink():
            continue
        source = _resolve_package_library_alias(library_root, child)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{child.name}.flatten-", dir=library_root
        )
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            temporary.unlink()
            _copy_regular_file(source, temporary, source.stat().st_mode, "package library alias")
            os.replace(temporary, child)
        except OSError as error:
            _fail(f"cannot flatten package library alias {child}: {error}")
        finally:
            temporary.unlink(missing_ok=True)
    _fsync_directory(library_root, "direct backend package library directory")


def _assert_direct_candidate_empty_for_make(candidate: Path) -> None:
    """Require a newly owned candidate to contain only its owner marker."""

    candidate = _absolute(candidate, "backend package candidate")
    try:
        entries = tuple(candidate.iterdir())
    except OSError as error:
        _fail(f"cannot inspect direct backend package candidate before Make: {error}")
    if len(entries) != 1 or entries[0].name != PACKAGE_CANDIDATE_MARKER:
        _fail("direct backend package candidate contains pre-existing payload")
    metadata = entries[0].lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        _fail("direct backend package candidate owner marker is unsafe before Make")


def _discard_direct_make_launcher(root: Path) -> None:
    """Remove Make's repo-local wrapper before package inventory.

    The wrapper is useful for a repo-local ``.fullmag/local`` install, but its
    relative repository and managed-runtime roots are wrong after a candidate
    is moved below ``/opt/fullmag/package``.  The direct candidate is checked
    as marker-only before Make, so this one regular file is an output owned by
    the current invocation; unknown files remain fail-closed for inventory.
    """

    launcher = _absolute(root, "direct backend package") / "bin" / "fullmag"
    _assert_no_links(launcher.parent, "direct Make launcher parent")
    try:
        metadata = launcher.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        _fail(f"cannot inspect direct Make launcher: {error}")
    if (
        stat.S_ISLNK(metadata.st_mode)
        or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
    ):
        _fail("direct Make launcher is not one regular file")
    try:
        launcher.unlink()
    except OSError as error:
        _fail(f"cannot remove direct Make launcher: {error}")
    _fsync_directory(launcher.parent, "direct backend package bin directory")


def _assert_direct_candidate_inventory(
    root: Path,
    records: list[dict[str, Any]],
    *,
    include_receipt: bool = False,
) -> None:
    """Reject Make leftovers before the candidate can enter package rotation."""

    optional_files = set(PACKAGE_CANDIDATE_OPTIONAL_FILES)
    if include_receipt:
        optional_files.add("backend-build-receipt.json")
    allowed_files = set(optional_files)
    allowed_files.update(str(record["path"]) for record in records)
    actual_files, actual_directories = _stage_tree_inventory(root)
    allowed_directories: set[str] = set()
    for relative in allowed_files:
        parts = PurePosixPath(relative).parts
        allowed_directories.update(
            PurePosixPath(*parts[:index]).as_posix() for index in range(1, len(parts))
        )
    if actual_files - optional_files != allowed_files - optional_files:
        _fail("direct backend package candidate has an unrecognized file inventory")
    if actual_directories != allowed_directories:
        _fail("direct backend package candidate has an unrecognized directory inventory")


def _known_failed_candidate_path(relative: str) -> bool:
    if relative in {
        PACKAGE_CANDIDATE_MARKER,
        "direct-backend-build.log",
        "install-cli-build.log",
        "install-cli-managed-fem-gpu.log",
        "source-identity.json",
        "launcher-build-mode",
        "bin/fullmag",
        "backend-build-receipt.json",
        *REQUIRED_PACKAGE_PATHS,
        *RUNTIME_MANIFEST_PATHS,
    }:
        return True
    if relative == "_fullmag_core.so.new":
        return True
    if relative.startswith("bin/") and relative.endswith(".new"):
        return relative[:-4] in {
            path for path in REQUIRED_PACKAGE_PATHS if path.startswith("bin/")
        }
    if not relative.startswith("lib/") or "/" in relative[4:]:
        return False
    return bool(
        re.fullmatch(
            r"libfullmag_(?:fdm|fem)\.so(?:\.[A-Za-z0-9._-]+)?",
            relative[4:],
        )
    )


def _failed_candidate_inventory_is_known(candidate: Path) -> bool:
    """Accept only bounded, marker-owned Make output for failure cleanup."""

    allowed_files = {
        PACKAGE_CANDIDATE_MARKER,
        "direct-backend-build.log",
        "install-cli-build.log",
        "install-cli-managed-fem-gpu.log",
        "source-identity.json",
        "launcher-build-mode",
        "bin/fullmag",
        "backend-build-receipt.json",
        *REQUIRED_PACKAGE_PATHS,
        *RUNTIME_MANIFEST_PATHS,
    }
    allowed_directories: set[str] = {"lib"}
    for relative in allowed_files:
        parts = PurePosixPath(relative).parts
        allowed_directories.update(
            PurePosixPath(*parts[:index]).as_posix() for index in range(1, len(parts))
        )
    pending: list[tuple[Path, str]] = [(candidate, "")]
    seen = 0
    while pending:
        directory, relative = pending.pop()
        try:
            children = tuple(sorted(directory.iterdir(), key=lambda path: path.name))
        except OSError:
            return False
        for child in children:
            child_relative = f"{relative}/{child.name}" if relative else child.name
            try:
                metadata = child.lstat()
            except OSError:
                return False
            seen += 1
            if seen > MAX_FAILED_CANDIDATE_ENTRIES:
                return False
            if stat.S_ISDIR(metadata.st_mode):
                if child_relative not in allowed_directories:
                    return False
                pending.append((child, child_relative))
            elif stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                if metadata.st_nlink != 1 or not _known_failed_candidate_path(child_relative):
                    return False
            else:
                return False
    return True


def _failed_make_paths(build_root: Path, candidate: Path, *, create: bool = False) -> tuple[Path, Path, Path]:
    build_root = _absolute(build_root, "backend build root")
    candidate = _absolute(candidate, "backend package candidate")
    if not PACKAGE_CANDIDATE_NAME_RE.fullmatch(candidate.name):
        _fail("failed Make attempt has an unsafe candidate name")
    namespace = build_root / FAILED_MAKE_DIAGNOSTICS_DIRNAME
    if create:
        _ensure_directory(namespace, "failed Make diagnostics namespace")
    else:
        _assert_no_links(build_root, "backend build root")
    attempt = namespace / candidate.name
    return attempt, attempt / FAILED_MAKE_RECEIPT_NAME, attempt / FAILED_MAKE_LOG_NAME


def _read_failed_make_attempt(
    build_root: Path, candidate: Path
) -> tuple[dict[str, Any], Path, Path] | None:
    """Read one bounded attempt; malformed records are never disposable."""

    attempt, receipt_path, log_path = _failed_make_paths(build_root, candidate)
    try:
        metadata = attempt.lstat()
    except FileNotFoundError:
        return None
    except OSError as error:
        _fail(f"cannot inspect failed Make attempt: {error}")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        _fail("failed Make attempt is not an owned directory")
    names: set[str] = set()
    try:
        iterator = iter(attempt.iterdir())
        for _ in range(3):
            try:
                names.add(next(iterator).name)
            except StopIteration:
                break
        else:
            _fail("failed Make attempt contains too many entries")
    except OSError as error:
        _fail(f"cannot inspect failed Make attempt: {error}")
    if not names.issubset({FAILED_MAKE_RECEIPT_NAME, FAILED_MAKE_LOG_NAME}):
        _fail("failed Make attempt contains an unknown entry")
    receipt_metadata = receipt_path.lstat()
    if not stat.S_ISREG(receipt_metadata.st_mode) or receipt_metadata.st_nlink != 1:
        _fail("failed Make attempt receipt is not one regular file")
    document, _ = _read_json(receipt_path, "failed Make attempt receipt", FAILED_MAKE_RECEIPT_BYTES_LIMIT)
    state = document.get("state")
    required = {"schema", "state", "candidate", "build_root", "log_path", "make_target"}
    if state in {"failed", "succeeded"}:
        required |= {"exit_code", "terminal_at_ns", "log_sha256", "log_size", "log_retired"}
        if document.get("log_retired"):
            required.add("log_retired_at_ns")
    elif state != "building":
        _fail("failed Make attempt receipt has an unknown state")
    if set(document) != required:
        _fail("failed Make attempt receipt has unexpected fields")
    if (
        document.get("schema") != FAILED_MAKE_SCHEMA
        or document.get("candidate") != str(candidate)
        or document.get("build_root") != str(_absolute(build_root, "backend build root"))
        or document.get("log_path") != log_path.relative_to(build_root).as_posix()
        or document.get("make_target") not in {"install-cli", "install-cli-dev"}
    ):
        _fail("failed Make attempt receipt does not match this build")
    if state == "building":
        return document, attempt, log_path
    if (
        isinstance(document.get("exit_code"), bool)
        or not isinstance(document.get("exit_code"), int)
        or not -255 <= document["exit_code"] <= 255
        or isinstance(document.get("terminal_at_ns"), bool)
        or not isinstance(document.get("terminal_at_ns"), int)
        or document["terminal_at_ns"] <= 0
        or isinstance(document.get("log_size"), bool)
        or not isinstance(document.get("log_size"), int)
        or not 0 <= document["log_size"] <= MAX_BUILD_LOG_BYTES
        or not isinstance(document.get("log_sha256"), str)
        or not SHA256_RE.fullmatch(document["log_sha256"])
        or not isinstance(document.get("log_retired"), bool)
        or (state == "failed") == (document["exit_code"] == 0)
    ):
        _fail("failed Make attempt receipt has invalid terminal evidence")
    if document["log_retired"] and (
        isinstance(document.get("log_retired_at_ns"), bool)
        or not isinstance(document.get("log_retired_at_ns"), int)
        or document["log_retired_at_ns"] <= 0
    ):
        _fail("failed Make attempt receipt has invalid retirement evidence")
    if FAILED_MAKE_LOG_NAME in names:
        log_metadata = log_path.lstat()
        if not stat.S_ISREG(log_metadata.st_mode) or log_metadata.st_nlink != 1:
            _fail("failed Make diagnostic log is not one regular file")
        digest, observed = _sha256_file(log_path, "failed Make diagnostic log", MAX_BUILD_LOG_BYTES)
        if observed.st_size != document["log_size"] or digest != document["log_sha256"]:
            _fail("failed Make diagnostic log differs from its receipt")
    elif not document["log_retired"]:
        _fail("failed Make attempt is missing its diagnostic log")
    return document, attempt, log_path


def _begin_failed_make_attempt(build_root: Path, candidate: Path, make_target: str) -> Path:
    attempt, receipt_path, log_path = _failed_make_paths(build_root, candidate, create=True)
    try:
        attempt.lstat()
    except FileNotFoundError:
        pass
    else:
        _fail("failed Make diagnostics already contain this candidate attempt")
    try:
        attempt.mkdir(mode=0o770)
    except OSError as error:
        _fail(f"cannot create failed Make attempt: {error}")
    _write_json(
        receipt_path,
        {
            "schema": FAILED_MAKE_SCHEMA,
            "state": "building",
            "candidate": str(_absolute(candidate, "backend package candidate")),
            "build_root": str(_absolute(build_root, "backend build root")),
            "log_path": log_path.relative_to(_absolute(build_root, "backend build root")).as_posix(),
            "make_target": make_target,
        },
        "failed Make attempt receipt",
    )
    _fsync_directory(attempt, "failed Make attempt directory")
    _fsync_directory(attempt.parent, "failed Make diagnostics namespace")
    return log_path


def _finish_failed_make_attempt(build_root: Path, candidate: Path, exit_code: int) -> dict[str, Any]:
    record = _read_failed_make_attempt(build_root, candidate)
    if record is None or record[0].get("state") != "building":
        _fail("failed Make attempt has no building receipt")
    document, attempt, log_path = record
    # The terminal receipt is the durable witness for the external log.  Sync
    # the completed regular file before hashing it or publishing that receipt.
    _fsync_owned_tree(log_path, "failed Make diagnostic log")
    digest, observed = _sha256_file(log_path, "failed Make diagnostic log", MAX_BUILD_LOG_BYTES)
    document = dict(document)
    document.update({
        "state": "failed" if exit_code else "succeeded",
        "exit_code": exit_code,
        "terminal_at_ns": time.time_ns(),
        "log_sha256": digest,
        "log_size": observed.st_size,
        "log_retired": False,
    })
    _write_json(attempt / FAILED_MAKE_RECEIPT_NAME, document, "failed Make attempt receipt")
    _fsync_directory(attempt, "failed Make attempt directory")
    return document


def _retire_make_log(record: tuple[dict[str, Any], Path, Path]) -> None:
    document, attempt, log_path = record
    if document.get("log_retired"):
        try:
            log_path.lstat()
        except FileNotFoundError:
            return
        _remove_owned_tree(log_path)
        _fsync_directory(attempt, "failed Make attempt directory")
        return
    document = dict(document)
    document.update({"log_retired": True, "log_retired_at_ns": time.time_ns()})
    _write_json(attempt / FAILED_MAKE_RECEIPT_NAME, document, "failed Make attempt receipt")
    _fsync_directory(attempt, "failed Make attempt directory")
    if log_path.exists() or log_path.is_symlink():
        _remove_owned_tree(log_path)
        _fsync_directory(attempt, "failed Make attempt directory")


def _prune_failed_make_logs(build_root: Path, package_root: Path | None = None) -> None:
    """Retire only known terminal failed logs; preserve building/foreign records."""

    build_root = _absolute(build_root, "backend build root")
    namespace = build_root / FAILED_MAKE_DIAGNOSTICS_DIRNAME
    expected_candidate_parent = None
    if package_root is not None:
        expected_candidate_parent = (
            _absolute(package_root, "backend package root")
            / PACKAGE_DEVELOPMENT_DIRNAME
            / PACKAGE_CANDIDATES_DIRNAME
        )
    try:
        _assert_no_links(namespace, "failed Make diagnostics namespace")
        iterator = iter(namespace.iterdir())
        entries = []
        for _ in range(FAILED_MAKE_RECORD_LIMIT + 1):
            try:
                entries.append(next(iterator))
            except StopIteration:
                break
        if len(entries) > FAILED_MAKE_RECORD_LIMIT:
            return
        entries.sort(key=lambda path: path.name)
    except FileNotFoundError:
        return
    except OSError as error:
        _fail(f"cannot inspect failed Make diagnostics namespace: {error}")
    if len(entries) > FAILED_MAKE_RECORD_LIMIT:
        return
    records: list[tuple[dict[str, Any], Path, Path]] = []
    for entry in entries:
        if not PACKAGE_CANDIDATE_NAME_RE.fullmatch(entry.name):
            return
        try:
            receipt, _ = _read_json(entry / FAILED_MAKE_RECEIPT_NAME, "failed Make attempt receipt", FAILED_MAKE_RECEIPT_BYTES_LIMIT)
            candidate_value = receipt.get("candidate")
            if not isinstance(candidate_value, str):
                return
            candidate = Path(candidate_value)
            if (
                expected_candidate_parent is None
                or candidate.parent != expected_candidate_parent
                or candidate.name != entry.name
            ):
                return
            try:
                candidate_metadata = candidate.lstat()
            except FileNotFoundError:
                candidate_metadata = None
            except OSError:
                return
            if candidate_metadata is not None:
                if not stat.S_ISDIR(candidate_metadata.st_mode):
                    return
                _validate_candidate_marker(
                    candidate,
                    expected_candidate_parent.parent.parent,
                    build_root,
                )
            record = _read_failed_make_attempt(build_root, candidate)
        except (BackendBuildError, OSError):
            return
        if record is None or record[1] != entry or record[0].get("state") == "building":
            return
        if record[0].get("state") == "failed" and not record[0].get("log_retired"):
            records.append(record)
    records.sort(key=lambda item: int(item[0]["terminal_at_ns"]))
    total_bytes = sum(int(item[0]["log_size"]) for item in records)
    while len(records) > FAILED_MAKE_LOG_LIMIT or total_bytes > FAILED_MAKE_LOG_BYTES_LIMIT:
        record = records.pop(0)
        total_bytes -= int(record[0]["log_size"])
        _retire_make_log(record)


def _failed_candidate_diagnostics_present(candidate: Path) -> bool:
    """Keep a failed candidate when it contains durable diagnostic evidence."""

    found = False
    for relative in sorted(FAILED_CANDIDATE_DIAGNOSTIC_FILES):
        path = candidate / relative
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            continue
        except OSError:
            # An unreadable diagnostic path must remain available for operator
            # recovery; treating it as present keeps cleanup fail-closed.
            found = True
            continue
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            found = True
            continue
        _fsync_owned_tree(path, f"failed backend candidate diagnostic {relative}")
        found = True
    return found


def _discard_failed_candidate_if_owned(
    candidate: Path,
    package_root: Path,
    build_root: Path,
) -> bool:
    """Drop a known failed candidate; preserve unknown or malformed trees."""

    try:
        _validate_candidate_marker(candidate, package_root, build_root, state="building")
        attempt = _read_failed_make_attempt(build_root, candidate)
        if attempt is not None and attempt[0].get("state") != "failed":
            # A running or successful Make attempt is incomplete publication
            # evidence. Keep the candidate and its external log for retry.
            return False
        if not _failed_candidate_inventory_is_known(candidate):
            return False
        if _failed_candidate_diagnostics_present(candidate):
            # Logs and a partial receipt are the durable failure evidence.  Do
            # not remove their containing candidate merely because every other
            # entry is known; a later operator/recovery pass can inspect it.
            return False
        if attempt is not None:
            _prune_failed_make_logs(build_root, package_root)
        _remove_owned_tree(candidate)
        _fsync_directory(candidate.parent, "backend package candidate directory")
        return True
    except (BackendBuildError, OSError):
        return False


def _copy_regular_file_fsync(source: Path, target: Path, name: str) -> tuple[str, int]:
    """Copy one owned file into staging and verify the durable readback."""

    _ensure_directory(target.parent, f"{name} destination parent")
    if target.exists() or target.is_symlink():
        _fail(f"{name} destination already exists")
    source_descriptor = _open_regular(source, name, MAX_SOURCE_BYTES)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", dir=target.parent
    )
    temporary = Path(temporary_name)
    digest = hashlib.sha256()
    total = 0
    try:
        before = os.fstat(source_descriptor)
        stream = os.fdopen(descriptor, "wb")
        descriptor = -1
        with stream:
            while True:
                block = os.read(source_descriptor, 1024 * 1024)
                if not block:
                    break
                total += len(block)
                digest.update(block)
                stream.write(block)
            stream.flush()
            os.fsync(stream.fileno())
        after = os.fstat(source_descriptor)
        if _file_signature(before) != _file_signature(after):
            _fail(f"{name} changed while archiving")
        expected_digest = digest.hexdigest()
        if total != before.st_size:
            _fail(f"{name} size changed while archiving")
        os.replace(temporary, target)
        observed_digest, observed = _sha256_file(target, name, MAX_SOURCE_BYTES)
        if observed.st_size != total or observed_digest != expected_digest:
            _fail(f"{name} changed during archive readback")
        _fsync_directory(target.parent, f"{name} staging directory")
        return expected_digest, total
    except OSError as error:
        _fail(f"cannot archive {name}: {error}")
    finally:
        os.close(source_descriptor)
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _archive_retired_backup(
    backup: Path,
    archive_root: Path,
    current_receipt_sha256: str,
    receipt_sha256: str,
    rotation_sha256: str,
) -> None:
    """Archive metadata durably before deleting an obsolete backup."""

    target = archive_root / backup.name
    metadata_names = ["backend-build-receipt.json", "rotation.json"]
    if target.exists() or target.is_symlink():
        manifest, _ = _read_json(
            target / "retention.json",
            f"backend package retention archive {backup.name} manifest",
            1024 * 1024,
        )
        archived_metadata = manifest.get("metadata")
        if (
            manifest.get("schema") != PACKAGE_RETENTION_SCHEMA
            or manifest.get("state") != "succeeded"
            or manifest.get("backup_name") != backup.name
            or manifest.get("receipt_sha256") != receipt_sha256
            or manifest.get("rotation_sha256") != rotation_sha256
            or not isinstance(archived_metadata, list)
        ):
            _fail(f"backend package retention archive does not match backup: {backup.name}")
        archived_names = {
            record.get("path") for record in archived_metadata if isinstance(record, Mapping)
        }
        if not set(metadata_names).issubset(archived_names) or not archived_names.issubset(
            {*metadata_names, "direct-backend-build.log"}
        ):
            _fail(f"backend package retention archive metadata is invalid: {backup.name}")
        for record in archived_metadata:
            if not isinstance(record, Mapping):
                _fail(f"backend package retention archive metadata is invalid: {backup.name}")
            filename = record.get("path")
            if not isinstance(filename, str):
                _fail(f"backend package retention archive metadata is invalid: {backup.name}")
            digest, metadata = _sha256_file(
                backup / filename,
                f"obsolete backend package backup {backup.name}/{filename}",
                MAX_SOURCE_BYTES,
            )
            if digest != record.get("sha256") or metadata.st_size != record.get("size"):
                _fail(f"backend package retention archive source differs: {backup.name}")
        return
    if sum(1 for _ in archive_root.iterdir()) >= MAX_RETENTION_ARCHIVES:
        _fail("backend retention metadata budget exhausted; preserve archives for explicit review")
    temporary = Path(
        tempfile.mkdtemp(prefix=f".{backup.name}.retention-", dir=archive_root)
    )
    try:
        metadata_records: list[dict[str, Any]] = []
        for filename in metadata_names:
            digest, size = _copy_regular_file_fsync(
                backup / filename,
                temporary / filename,
                f"obsolete backend package backup {backup.name}/{filename}",
            )
            metadata_records.append({"path": filename, "size": size, "sha256": digest})
        _write_json(
            temporary / "retention.json",
            {
                "schema": PACKAGE_RETENTION_SCHEMA,
                "state": "succeeded",
                "backup_name": backup.name,
                "receipt_sha256": receipt_sha256,
                "rotation_sha256": rotation_sha256,
                "current_receipt_sha256": current_receipt_sha256,
                "retired_at_ns": time.time_ns(),
                "metadata": metadata_records,
            },
            "backend package retention archive manifest",
        )
        _fsync_directory(temporary, "backend package retention staging directory")
        os.rename(temporary, target)
        _fsync_directory(archive_root, "backend package retention archive directory")
    except (BackendBuildError, OSError):
        if temporary.exists():
            try:
                _remove_owned_tree(temporary)
            except (BackendBuildError, OSError):
                pass
        raise


def _retain_package_backups(
    output: Path,
    control_root: Path,
    current_receipt: Mapping[str, Any],
    current_receipt_bytes: bytes,
) -> None:
    """Retain the direct rollback and retire only a verified older chain."""

    output = _absolute(output, "backend output")
    control_root = _absolute(control_root, "backend package development control directory")
    if control_root != output / PACKAGE_DEVELOPMENT_DIRNAME:
        _fail("backend package retention control directory is not under the package mount")
    _ensure_package_development_root(output)
    archive_root = control_root / PACKAGE_RETENTION_ARCHIVE_DIRNAME
    backups_root = control_root / PACKAGE_BACKUPS_DIRNAME
    candidates_root = control_root / PACKAGE_CANDIDATES_DIRNAME
    _ensure_directory(archive_root, "backend package retention archive directory")
    _ensure_directory(backups_root, "backend package backup directory")
    try:
        if any(candidates_root.iterdir()):
            _fail("backend package candidate staging is not empty during retention")
    except OSError as error:
        _fail(f"cannot inspect backend package candidate staging: {error}")
    _fsync_directory(output, "backend package output directory")
    _fsync_directory(control_root, "backend package development control directory")
    _fsync_directory(backups_root, "backend package backup directory")
    _validate_retention_archives(archive_root, verify_disposable_logs=False)
    current_mode, current_build, current_toolchain = _retention_receipt_identity(
        current_receipt, "current backend package"
    )
    current_sha256 = _sha256_bytes(current_receipt_bytes)
    observed_receipt_bytes, _ = _read_regular(
        output / "backend-build-receipt.json", "current backend package receipt", 8 * 1024 * 1024
    )
    if observed_receipt_bytes != current_receipt_bytes:
        _fail("current backend package receipt changed before backup retention")
    current_children = _package_children(
        output, "current backend package", exclude_development_control=True
    )
    try:
        entries = tuple(sorted(backups_root.iterdir(), key=lambda path: path.name))
    except OSError as error:
        _fail(f"cannot inspect backend package backups: {error}")
    if not entries:
        _prune_retention_archives(archive_root)
        return
    nodes: list[dict[str, Any]] = []
    by_new: dict[str, dict[str, Any]] = {}
    for backup in entries:
        if not re.fullmatch(r"\.backend-package-backup-[A-Za-z0-9._-]+", backup.name):
            _fail(f"backend package backup has an unknown entry: {backup.name}")
        _assert_safe_tree(backup, f"backend package backup {backup.name}")
        receipt, receipt_bytes, children = _validated_package(
            backup, f"backend package backup {backup.name}"
        )
        _assert_exact_backup_inventory(
            backup, receipt, f"backend package backup {backup.name}"
        )
        mode, build, toolchain = _retention_receipt_identity(
            receipt, f"backend package backup {backup.name}"
        )
        if mode != current_mode or build != current_build or toolchain != current_toolchain:
            _fail(f"backend package backup {backup.name} has a different cache identity")
        rotation, rotation_bytes = _read_json(
            backup / "rotation.json",
            f"backend package backup {backup.name} rotation metadata",
            1024 * 1024,
        )
        if (
            rotation.get("schema") != "fullmag.direct-compose.package-rotation.v1"
            or rotation.get("state") != "succeeded"
        ):
            _fail(f"backend package backup {backup.name} rotation metadata is invalid")
        old_sha256 = rotation.get("old_receipt_sha256")
        new_sha256 = rotation.get("new_receipt_sha256")
        if (
            not isinstance(old_sha256, str)
            or not SHA256_RE.fullmatch(old_sha256)
            or not isinstance(new_sha256, str)
            or not SHA256_RE.fullmatch(new_sha256)
            or old_sha256 != _sha256_bytes(receipt_bytes)
        ):
            _fail(f"backend package backup {backup.name} rotation receipt hashes are invalid")
        old_children = _retention_child_names(
            rotation.get("old_children"), f"backend package backup {backup.name} old"
        )
        new_children = _retention_child_names(
            rotation.get("new_children"), f"backend package backup {backup.name} new"
        )
        if set(children) != set(old_children) | {"rotation.json"}:
            _fail(f"backend package backup {backup.name} has unexpected package children")
        node = {
            "path": backup,
            "receipt": receipt,
            "receipt_bytes": receipt_bytes,
            "receipt_sha256": old_sha256,
            "new_receipt_sha256": new_sha256,
            "rotation_sha256": _sha256_bytes(rotation_bytes),
            "old_children": old_children,
            "new_children": new_children,
        }
        if new_sha256 in by_new:
            _fail(f"backend package backups have duplicate successor {new_sha256}")
        by_new[new_sha256] = node
        nodes.append(node)
    direct = by_new.get(current_sha256)
    if direct is None:
        _fail("backend package backups have no direct rollback for the current receipt")
    if set(direct["new_children"]) != set(current_children):
        _fail("direct backend package rollback does not describe the current package")
    chain: set[str] = set()
    chain_nodes: list[dict[str, Any]] = []
    cursor = current_sha256
    while cursor in by_new:
        node = by_new[cursor]
        receipt_sha256 = str(node["receipt_sha256"])
        if node["path"].name in chain:
            _fail("backend package backup chain contains a cycle")
        chain.add(node["path"].name)
        chain_nodes.append(node)
        cursor = receipt_sha256
    if len(chain) != len(nodes):
        _fail("backend package backups contain an unrelated or unreferenced entry")
    for newer, older in zip(chain_nodes, chain_nodes[1:]):
        if set(newer["old_children"]) != set(older["new_children"]):
            _fail("backend package backup chain child sets do not match")
    # The current package and its direct rollback are the two versions that
    # must survive a crash while older backups are removed.  Sync only these
    # small verified trees; the mutable build/cache trees are out of scope.
    _fsync_owned_tree(
        output,
        "current backend package retained tree",
        excluded_children=frozenset({PACKAGE_DEVELOPMENT_DIRNAME}),
    )
    _fsync_owned_tree(direct["path"], "direct backend package rollback retained tree")
    # Walk current -> direct -> older and remove the tail first.  If a later
    # deletion fails, the remaining backups still form a complete chain.
    obsolete = list(reversed(chain_nodes[1:]))
    for node in obsolete:
        _archive_retired_backup(
            node["path"],
            archive_root,
            current_sha256,
            str(node["receipt_sha256"]),
            str(node["rotation_sha256"]),
        )
        _remove_owned_tree(node["path"])
        _fsync_directory(backups_root, "backend package backup directory")
    removed_archives = _prune_retention_archives(archive_root)
    if obsolete or removed_archives:
        _log_phase(
            "retention",
            "complete",
            files=len(obsolete),
            archives_removed=removed_archives,
        )


def _copy_package(
    workspace: Path,
    output: Path,
    *,
    direct_install: bool = False,
    package_root: Path | None = None,
    build_root: Path | None = None,
) -> list[dict[str, Any]]:
    if direct_install:
        if package_root is None or build_root is None:
            _fail("direct package publication has no exact package/build roots")
        _validate_candidate_marker(output, package_root, build_root, state="building")
        _discard_direct_make_launcher(output)
        _flatten_package_library_aliases(output)
        _write_runtime_manifests(output)
        _fsync_owned_tree(output, "direct backend package candidate")
        records = _hash_package(output)
        _assert_direct_candidate_inventory(output, records)
        _write_candidate_marker(
            output,
            package_root,
            build_root,
            state="ready",
            records=records,
        )
        return records
    source = workspace / ".fullmag" / "local"
    if source.is_symlink() or not source.is_dir():
        _fail("canonical Make target did not publish .fullmag/local")
    _ensure_directory(output, "backend output")
    if any(output.iterdir()):
        _fail("backend output must be empty before direct package publication")
    stage = Path(tempfile.mkdtemp(prefix=".backend-package-", dir=output))
    try:
        _copy_package_tree(source, stage)
        _write_runtime_manifests(stage)
        records = _hash_package(stage)
        for child in stage.iterdir():
            destination = output / child.name
            if destination.exists() or destination.is_symlink():
                _fail(f"backend output changed during publication: {destination}")
            os.replace(child, destination)
        return records
    finally:
        if stage.exists():
            _remove_owned_tree(stage)


def _write_console_chunk(chunk: bytes) -> None:
    """Mirror Make output to the container log without making it a build input."""

    stream = getattr(sys.stdout, "buffer", sys.stdout)
    try:
        stream.write(chunk)
    except TypeError:
        stream.write(chunk.decode("utf-8", errors="replace"))
    except (BrokenPipeError, OSError):
        return
    try:
        stream.flush()
    except (BrokenPipeError, OSError):
        pass


def _run_canonical_make(command: list[str], workspace: Path, environment: Mapping[str, str], log_path: Path) -> int:
    started = time.monotonic()
    _log_phase("make", "start", target=command[-1])
    try:
        with log_path.open("wb") as log:
            remaining_log_bytes = MAX_BUILD_LOG_BYTES
            log_truncated = False
            process = subprocess.Popen(
                command,
                cwd=workspace,
                env=dict(environment),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=0,
            )
            assert process.stdout is not None
            with process.stdout:
                while True:
                    chunk = process.stdout.read(1024 * 1024)
                    if not chunk:
                        break
                    log.write(chunk[:remaining_log_bytes])
                    remaining_log_bytes -= min(len(chunk), remaining_log_bytes)
                    log.flush()
                    if not remaining_log_bytes and not log_truncated:
                        _log_phase("make-log", "bounded", byte_limit=MAX_BUILD_LOG_BYTES,
                                   overflow="docker-local-log-ring")
                        log_truncated = True
                    _write_console_chunk(chunk)
            return_code = process.wait()
            _log_phase(
                "make",
                "complete",
                exit_code=return_code,
                duration_ms=round((time.monotonic() - started) * 1000),
            )
            return return_code
    except OSError as error:
        _log_phase(
            "make",
            "failed",
            error=type(error).__name__,
            duration_ms=round((time.monotonic() - started) * 1000),
        )
        _fail(f"cannot execute canonical Make target: {error}")


def _prepare_locked(
    args: argparse.Namespace,
    build_root: Path,
    output: Path,
    jobs: int,
    toolchain: Mapping[str, Any],
    direct_install_root: Path | None = None,
) -> int:
    source_tar = Path(args.source_tar) if args.source_tar is not None else None
    direct_install = direct_install_root is not None
    legacy_stage_before_materialize = (
        _snapshot_legacy_install_stage(build_root / "workspace")
        if direct_install
        else None
    )
    workspace, capsule, native, manifest_hash, archive_hash, source_mode = _materialize_source(
        source_tar,
        Path(args.manifest),
        build_root,
        source_root=Path(args.source_root),
        git_common_root=Path(args.git_common_root),
        preserve_legacy_install_stage=direct_install,
    )
    legacy_stage_before_make: dict[str, tuple[object, ...]] | None = None
    if direct_install:
        _assert_legacy_install_stage_unchanged(
            workspace,
            legacy_stage_before_materialize,
            "source materialization",
        )
        legacy_stage_before_make = _snapshot_legacy_install_stage(workspace)
    cargo_profile = _validate_cargo_profile(
        os.environ.get("FULLMAG_BACKEND_CARGO_PROFILE", BACKEND_CARGO_PROFILE)
    )
    environment = _build_environment(workspace, build_root, native, jobs, cargo_profile)
    if direct_install:
        if direct_install_root != output or cargo_profile != BACKEND_CARGO_PROFILE:
            _fail("direct package publication is reserved for the backend-dev candidate")
        _validate_candidate_marker(output, PACKAGE_ROOT, build_root, state="building")
        _assert_direct_candidate_empty_for_make(output)
        environment.pop("FULLMAG_INTERNAL_INSTALL_ROOT", None)
        environment["FULLMAG_INTERNAL_INSTALL_ROOT"] = str(output)
        build_log = None
    else:
        # A host/Compose variable must never redirect legacy or release Make.
        environment.pop("FULLMAG_INTERNAL_INSTALL_ROOT", None)
        build_log = workspace / ".fullmag" / "local" / "direct-backend-build.log"
    make_target = "install-cli-dev" if cargo_profile == "backend-dev" else "install-cli"
    command = [shutil.which("make") or "/usr/bin/make", make_target]
    if direct_install:
        build_log = _begin_failed_make_attempt(build_root, output, make_target)
    else:
        _ensure_directory(build_log.parent, "backend build log parent")
    assert build_log is not None
    return_code = _run_canonical_make(command, workspace, environment, build_log)
    if direct_install:
        _finish_failed_make_attempt(build_root, output, return_code)
    if direct_install:
        _assert_legacy_install_stage_unchanged(
            workspace,
            legacy_stage_before_make,
            "canonical Make",
        )
    if return_code != 0:
        _fail(f"canonical Make target failed with exit code {return_code}")
    if source_mode == LIVE_SOURCE_MODE:
        _verify_shadow_source(workspace, capsule)
    if direct_install:
        attempt = _read_failed_make_attempt(build_root, output)
        if attempt is None or attempt[0].get("state") != "succeeded":
            _fail("successful Make attempt has no terminal receipt")
        receipt = attempt[0]
        digest, size = _copy_regular_file_fsync(
            build_log,
            output / FAILED_MAKE_LOG_NAME,
            "successful Make diagnostic log",
        )
        if digest != receipt["log_sha256"] or size != receipt["log_size"]:
            _fail("successful Make diagnostic log changed before package publication")
        _fsync_directory(output, "backend package candidate directory")
    result = _publish_completed_build(
        workspace, output, capsule, native, manifest_hash, archive_hash, source_mode,
        toolchain, command, cargo_profile,
        direct_install=direct_install,
        package_root=PACKAGE_ROOT if direct_install else None,
        build_root=build_root if direct_install else None,
    )
    if direct_install:
        attempt = _read_failed_make_attempt(build_root, output)
        if attempt is None or attempt[0].get("state") != "succeeded":
            _fail("successful Make attempt receipt disappeared")
        receipt = attempt[0]
        digest, size = _sha256_file(
            output / FAILED_MAKE_LOG_NAME,
            "published Make diagnostic log",
            MAX_BUILD_LOG_BYTES,
        )
        if digest != receipt["log_sha256"] or size != receipt["log_size"]:
            _fail("published Make diagnostic log differs from its attempt receipt")
        _retire_make_log(attempt)
        _prune_failed_make_logs(build_root, PACKAGE_ROOT)
    return result


def _publish_completed_build(
    workspace: Path, output: Path, capsule: Mapping[str, Any], native: Mapping[str, Any],
    manifest_hash: str, archive_hash: str | None, source_mode: str,
    toolchain: Mapping[str, Any], command: list[str],
    cargo_profile: str,
    *,
    direct_install: bool = False,
    package_root: Path | None = None,
    build_root: Path | None = None,
) -> int:
    """Publish verified artifacts after the canonical Make invocation succeeded."""
    started = time.monotonic()
    _log_phase("package", "start")
    cargo_profile = _validate_cargo_profile(cargo_profile)
    records = _copy_package(
        workspace,
        output,
        direct_install=direct_install,
        package_root=package_root,
        build_root=build_root,
    )
    source_record: dict[str, Any] = {
        "manifest_sha256": manifest_hash,
        "source_mode": source_mode,
        "source_snapshot_sha256": native["source_snapshot_sha256"],
        "source_digest": capsule["source_digest"],
        "resolved_commit": capsule["resolved_commit"],
    }
    if archive_hash is not None:
        source_record["source_tar_sha256"] = archive_hash
    else:
        source_record["live_manifest_sha256"] = capsule.get("_live_manifest_sha256", manifest_hash)
    receipt: dict[str, Any] = {
        "schema": RECEIPT_SCHEMA,
        "state": "succeeded",
        "qualification": "NOT VERIFIED",
        "operation": "direct-compose-build",
        "command": command,
        "source": source_record,
        "native_source_identity": native,
        "native_source_identity_sha256": _sha256_bytes(_canonical(native)),
        "toolchain": toolchain,
        "execution_lanes": {
            lane: {
                "status": "compiled",
                "binary": "bin/fullmag-api",
                "selection": "published_execution_profile",
                "fallback": "forbidden",
            }
            for lane in LANES
        },
        "build": {
            "cargo_profile": cargo_profile,
            "cargo_target_profile_dir": cargo_profile,
            "mode": "cuda-fem-gpu",
            "features": ["cuda", "fem-gpu"],
            "fullmag_build_cpu_only": False,
            "fem_gpu_required": True,
            "libceed_required": True,
            "make_log": "direct-backend-build.log",
        },
        "artifacts": records,
    }
    _write_json(output / "backend-build-receipt.json", receipt, "backend build receipt")
    _log_phase(
        "package",
        "complete",
        files=len(records),
        duration_ms=round((time.monotonic() - started) * 1000),
    )
    return 0


def _prepare(args: argparse.Namespace) -> int:
    build_root = _absolute(Path(args.build_root), "build root")
    output = _absolute(Path(args.output), "backend output")
    jobs = int(args.jobs)
    if jobs < 1 or jobs > 64:
        _fail("jobs must be between 1 and 64")
    _, toolchain = _toolchain_identity()
    with _runtime_build_lock(build_root):
        return _prepare_locked(args, build_root, output, jobs, toolchain)


def _validate_start_output(output: Path, build_root: Path) -> None:
    """Require the dev handoff to use the canonical package mount."""

    output = _absolute(output, "backend output")
    _absolute(build_root, "build root")
    if output != PACKAGE_ROOT:
        _fail("start output must be the canonical /opt/fullmag/package mount")
    _ensure_directory(output, "backend output")


def _capture_start_manifest(args: argparse.Namespace, build_root: Path) -> Path:
    """Capture the current readonly checkout inside the trusted image."""

    started = time.monotonic()
    _log_phase("capture", "start")
    try:
        manifest = capture_live_source_manifest(
            Path(args.source_root),
            Path(args.git_common_root),
            build_root,
        )
    except BackendSourceError as error:
        _log_phase(
            "capture",
            "failed",
            error=type(error).__name__,
            duration_ms=round((time.monotonic() - started) * 1000),
        )
        _fail(f"current live source capture failed: {error}")
    try:
        manifest_bytes = manifest.stat().st_size
    except OSError:
        manifest_bytes = 0
    _log_phase(
        "capture",
        "complete",
        bytes=manifest_bytes,
        duration_ms=round((time.monotonic() - started) * 1000),
    )
    return manifest


def _publish_runtime_provenance(output: Path) -> None:
    """Publish the source identity consumed by runtime-service before exec."""

    receipt_path = output / "backend-build-receipt.json"
    receipt, receipt_bytes = _read_json(
        receipt_path, "backend build receipt", 8 * 1024 * 1024
    )
    if receipt.get("schema") != RECEIPT_SCHEMA or receipt.get("state") != "succeeded":
        _fail("cannot publish runtime provenance from an unsuccessful build receipt")
    source = receipt.get("source")
    native = receipt.get("native_source_identity")
    toolchain = receipt.get("toolchain")
    build = receipt.get("build")
    if not isinstance(source, dict) or not isinstance(native, dict):
        _fail("backend build receipt has incomplete source provenance")
    if not isinstance(toolchain, dict) or not isinstance(build, dict):
        _fail("backend build receipt has incomplete build provenance")
    runtime_image_id = os.environ.get("FULLMAG_RUNTIME_IMAGE_ID", "")
    if not IMAGE_RE.fullmatch(runtime_image_id):
        _fail("FULLMAG_RUNTIME_IMAGE_ID must be an immutable sha256 image ID")
    commit = source.get("resolved_commit")
    snapshot = native.get("source_snapshot_sha256")
    if not isinstance(commit, str) or not GIT_OBJECT_RE.fullmatch(commit):
        _fail("backend build receipt has no pinned source commit")
    if not isinstance(snapshot, str) or not SHA256_RE.fullmatch(snapshot):
        _fail("backend build receipt has no pinned source snapshot")
    if PROVENANCE_PATH.is_symlink():
        _fail("runtime provenance path must not be a symlink")
    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, list):
        _fail("backend build receipt has no artifact provenance")
    binary_hashes = {
        str(record["path"])[len("bin/"):]: record["sha256"]
        for record in artifacts
        if isinstance(record, dict)
        and isinstance(record.get("path"), str)
        and record["path"].startswith("bin/")
        and isinstance(record.get("sha256"), str)
    }
    provenance: dict[str, Any] = {
        "schema": "fullmag.docker-all-image.v1",
        "state": "succeeded",
        "image_id": runtime_image_id,
        "qualification": "NOT VERIFIED",
        "build_kind": "direct-compose",
        "direct_source_provenance": (
            "fullmag.docker-backend-live-source.v1"
            if source.get("source_mode") == LIVE_SOURCE_MODE
            else "fullmag.docker-backend-source.v1"
        ),
        "commit": commit,
        "source_mode": source.get("source_mode"),
        "source_digest": source.get("source_digest"),
        "source_snapshot_sha256": snapshot,
        "native_source_identity": native,
        "native_source_identity_sha256": receipt.get("native_source_identity_sha256"),
        "toolchain": toolchain,
        "toolchain_image_id": toolchain.get("image_id"),
        "cargo_profile": build.get("cargo_profile"),
        "cargo_target_profile_dir": build.get("cargo_target_profile_dir"),
        "package_root": str(output),
        "binary_hashes": binary_hashes,
        "artifacts": artifacts,
        "execution_lanes": receipt.get("execution_lanes"),
        "backend_build_receipt": str(receipt_path),
        "backend_build_receipt_schema": receipt.get("schema"),
        "build_receipt_sha256": _sha256_bytes(receipt_bytes),
    }
    _write_bound_json(PROVENANCE_PATH, provenance, "runtime provenance")


def _write_bound_bytes(path: Path, data: bytes, name: str) -> None:
    """Rewrite an explicitly mounted regular file without replacing its mount."""

    path = _absolute(path, name)
    _assert_no_links(path.parent, f"{name} parent")
    if path.is_symlink():
        _fail(f"{name} must not be a symlink")
    if path in {Path("/build/provenance.json"), BACKEND_CONTROL_ROOT / "runtime-provenance.json"}:
        _write_json(path, json.loads(data), name)
        return
    flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        _fail(f"cannot open mounted {name}: {error}")
    locked = False
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            _fail(f"mounted {name} is not one regular file")
        if fcntl is not None:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (BlockingIOError, OSError) as error:
                _fail(f"mounted {name} is already in use: {error}")
            locked = True
        os.ftruncate(descriptor, 0)
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                _fail(f"short write while publishing {name}")
            view = view[written:]
        os.fsync(descriptor)
        os.lseek(descriptor, 0, os.SEEK_SET)
        observed = bytearray()
        while len(observed) <= len(data):
            block = os.read(descriptor, min(1024 * 1024, len(data) + 1 - len(observed)))
            if not block:
                break
            observed.extend(block)
        observed_bytes = bytes(observed)
        if _sha256_bytes(observed_bytes) != _sha256_bytes(data) or observed_bytes != data:
            _fail(f"mounted {name} changed while publishing")
    except OSError as error:
        _fail(f"cannot publish mounted {name}: {error}")
    finally:
        if locked:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            except OSError:
                pass
        os.close(descriptor)


def _write_bound_json(path: Path, value: Mapping[str, Any], name: str) -> None:
    _write_bound_bytes(path, _canonical(value), name)


def _snapshot_bound_provenance() -> bytes | None:
    """Read the prior bound bytes, tolerating only a genuinely absent file."""

    if PROVENANCE_PATH.is_symlink():
        _fail("runtime provenance path must not be a symlink")
    try:
        return _read_regular(PROVENANCE_PATH, "previous runtime provenance", MAX_MANIFEST_BYTES)[0]
    except BackendBuildError:
        if PROVENANCE_PATH.exists():
            raise
        return None


def _restore_bound_provenance(data: bytes) -> None:
    _write_bound_bytes(PROVENANCE_PATH, data, "runtime provenance rollback")


def _start(args: argparse.Namespace) -> int:
    """Build and hand off to the API in this same backend container."""

    _log_phase("start", "begin", mode="backend-dev")
    build_root = _absolute(Path(args.build_root), "build root")
    output = _absolute(Path(args.output), "backend output")
    jobs = int(args.jobs)
    if jobs < 1 or jobs > 64:
        _fail("jobs must be between 1 and 64")
    cargo_profile = _validate_cargo_profile(
        os.environ.get("FULLMAG_BACKEND_CARGO_PROFILE", BACKEND_CARGO_PROFILE)
    )
    if cargo_profile != BACKEND_CARGO_PROFILE:
        _fail("start is reserved for the backend-dev profile; use prepare/build for release")
    _validate_start_output(output, build_root)
    candidate: Path | None = None
    rotation: dict[str, Any] | None = None
    rollback_failed = False
    provenance_before: bytes | None = None
    provenance_publish_started = False
    publication_committed = False
    # Keep the lock across package verification and the exec handoff.  The
    # descriptor is O_CLOEXEC, so the API process does not inherit a stale
    # build lock after execvpe.  A failed build therefore cannot start API.
    with _runtime_build_lock(build_root):
        try:
            control_root = _ensure_package_development_root(output)
            _recover_pending_package_rotation(output, control_root, build_root)
            previous_receipt: tuple[dict[str, Any], bytes, dict[str, tuple[int, int, int, int, int]]] | None
            existing_children = _package_children(
                output,
                "existing backend package",
                exclude_development_control=True,
            )
            if existing_children:
                previous_receipt = _validated_package(
                    output,
                    "existing backend package",
                    exclude_development_control=True,
                )
            else:
                previous_receipt = None
            _reject_partial_package_candidates(
                output,
                control_root,
                build_root,
                current_package=previous_receipt,
            )
            _backend_cache_receipt()
            _prune_failed_make_logs(build_root, output)
            _, toolchain = _toolchain_identity()
            start_args = argparse.Namespace(**vars(args))
            start_args.manifest = _capture_start_manifest(args, build_root)
            start_args.source_tar = None
            if previous_receipt is not None and _package_matches_fresh_live_manifest(
                previous_receipt[0], start_args.manifest, toolchain, cargo_profile
            ):
                _log_phase("start", "cache-hit", source="verified-package")
                provenance_before = _snapshot_bound_provenance()
                provenance_publish_started = True
                _publish_runtime_provenance(output)
                _log_phase("start", "handoff", cache="hit")
                return _serve([])
            if previous_receipt is not None:
                _preflight_candidate_storage(build_root, previous_receipt[0])
            candidate = Path(
                tempfile.mkdtemp(
                    prefix=".backend-package-candidate-",
                    dir=control_root / PACKAGE_CANDIDATES_DIRNAME,
                )
            )
            _write_candidate_marker(
                candidate,
                output,
                build_root,
                state="building",
            )
            try:
                result = _prepare_locked(
                    start_args,
                    build_root,
                    candidate,
                    jobs,
                    toolchain,
                    candidate,
                )
            except (BackendBuildError, OSError):
                if _discard_failed_candidate_if_owned(candidate, output, build_root):
                    candidate = None
                raise
            if result != 0:
                _fail(f"backend preparation failed with exit code {result}")
            candidate_marker = _validate_candidate_marker(
                candidate,
                output,
                build_root,
                state="ready",
            )
            candidate_inventory = _hash_package(candidate)
            if candidate_marker.get("artifact_inventory_sha256") != _sha256_bytes(
                _canonical(candidate_inventory)
            ):
                _fail("candidate backend package owner marker inventory proof differs")
            _candidate_receipt, candidate_receipt_bytes, _candidate_children = _validated_package(
                candidate,
                "candidate backend package",
                exclude_candidate_marker=True,
            )
            if previous_receipt is not None:
                _validated_package(
                    output,
                    "existing backend package",
                    exclude_development_control=True,
                )
            previous_children = previous_receipt[2] if previous_receipt is not None else {}
            previous_receipt_bytes = previous_receipt[1] if previous_receipt is not None else None
            rotation = _rotate_package(
                output,
                candidate,
                control_root,
                previous_children,
                previous_receipt_bytes,
                candidate_receipt_bytes,
            )
            provenance_before = _snapshot_bound_provenance()
            provenance_publish_started = True
            _publish_runtime_provenance(output)
            publication_committed = True
            _finalize_published_candidate(candidate, rotation)
            candidate = None
            journal_cleared = True
            try:
                _clear_rotation_journal(rotation)
            except (BackendBuildError, OSError) as error:
                journal_cleared = False
                _log_phase("package", "rotation-journal-retained", reason=type(error).__name__)
            if journal_cleared:
                try:
                    _retain_package_backups(
                        output,
                        control_root,
                        _candidate_receipt,
                        candidate_receipt_bytes,
                    )
                except (BackendBuildError, OSError) as error:
                    # Publication is already durable.  Unknown or corrupt backup
                    # state is retained and diagnosed; it must never roll back a
                    # valid current package or delete a direct rollback.
                    retention_reason = re.sub(r"[^A-Za-z0-9_.:/-]+", "-", str(error)).strip("-")
                    if not retention_reason:
                        retention_reason = type(error).__name__
                    _log_phase(
                        "retention",
                        "skipped",
                        reason=retention_reason[:64],
                        error=type(error).__name__,
                    )
            else:
                _log_phase("retention", "skipped", reason="pending-rotation-journal")
        except (BackendBuildError, OSError) as error:
            if publication_committed:
                _log_phase(
                    "package", "rotation-finalization-deferred", reason=type(error).__name__
                )
                raise
            rollback_errors: list[str] = []
            if provenance_publish_started:
                if provenance_before is None:
                    rollback_errors.append(
                        "previous runtime provenance bytes were unavailable; outcome is unknown"
                    )
                else:
                    try:
                        _restore_bound_provenance(provenance_before)
                    except (BackendBuildError, OSError) as restore_error:
                        rollback_errors.append(
                            f"runtime provenance rollback failed: {restore_error}"
                        )
            if rotation is not None:
                rollback_errors.extend(_rollback_package_rotation(rotation))
                if rollback_errors:
                    rollback_failed = True
                    _fail(
                        "backend publication failed and rollback is incomplete; "
                        f"retained backup={rotation.get('backup')}: {'; '.join(rollback_errors)}; "
                        f"original error: {error}"
                    )
            raise
        finally:
            if candidate is not None and candidate.exists() and not rollback_failed:
                # A marker-bearing candidate is durable evidence of an
                # incomplete publication.  Preserve it for the next bounded
                # startup audit instead of deleting a partial build.
                _log_phase("package", "candidate-preserved", reason="incomplete-publication")
        _log_phase("start", "handoff")
        return _serve([])


def _read_optional_storage_attestation(path: Path, name: str) -> dict[str, Any] | None:
    """Read one host-owned certificate, treating only an absent/partial write as pending."""

    path = _absolute(path, name)
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as error:
        _fail(f"cannot inspect {name}: {error}")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        _fail(f"{name} is not one regular file")
    if metadata.st_size == 0:
        return None
    try:
        value, _ = _read_json(path, name, 1024 * 1024)
    except BackendBuildError as error:
        # The host writer updates this bound file in place.  A read racing its
        # truncate/write window is retryable; a parsed identity conflict below
        # remains fail-closed.
        if "not valid JSON" in str(error):
            return None
        raise
    return value


def _validate_development_source_identity(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {
        "commit",
        "source_digest",
        "source_snapshot_sha256",
        "native_source_identity_sha256",
    }:
        _fail("Windows-folder development source identity fields are invalid")
    source_identity = dict(value)
    if not isinstance(source_identity["commit"], str) or not GIT_OBJECT_RE.fullmatch(
        source_identity["commit"]
    ):
        _fail("runtime provenance has no valid development source commit")
    for field in ("source_digest", "source_snapshot_sha256", "native_source_identity_sha256"):
        value = source_identity[field]
        if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
            _fail(f"runtime provenance has no valid development source identity: {field}")
    return source_identity  # type: ignore[return-value]


def _development_refresh_publication_pending(
    host: Mapping[str, Any], owner: Mapping[str, Any]
) -> bool:
    """Recognize the bounded bootstrap-to-live audit publication window."""

    if (
        host.get("restart_verified") is not False
        or owner.get("restart_verified") is not False
    ):
        return False
    for document in (host, owner):
        if (
            document.get("schema") != WINDOWS_FOLDER_HOST_SCHEMA
            or document.get("storage_profile") != WINDOWS_FOLDER_STORAGE_PROFILE
            or document.get("role") != "session"
            or document.get("owner_scope") != "docker-desktop-linux"
        ):
            return False
    image_id = os.environ.get("FULLMAG_RUNTIME_IMAGE_ID", "")
    if (
        not IMAGE_RE.fullmatch(image_id)
        or host.get("image_id") != image_id
        or owner.get("image_id") != image_id
        or host.get("owner_token") != owner.get("owner_token")
        or not isinstance(host.get("owner_token"), str)
        or not host["owner_token"]
    ):
        return False

    required_delegation = {
        "schema",
        "cargo_profile",
        "toolchain_image_id",
        "package_root",
        "provenance_path",
        "group_identity",
        "source_identity",
    }
    toolchain = os.environ.get("FULLMAG_TOOLCHAIN_IMAGE_ID", "")
    group_identity = os.environ.get("FULLMAG_COMPOSE_PROJECT", "")
    normalized: list[dict[str, Any]] = []
    for document in (host, owner):
        # The audit fields must exist in both records; their values are the
        # only fields allowed to change during this publication window.
        if any(field not in document for field in (
            "source_commit", "binary_hashes", "artifact_receipt_sha256"
        )):
            return False
        delegation = document.get("development_build")
        if not isinstance(delegation, dict) or set(delegation) != required_delegation:
            return False
        if (
            delegation.get("schema") != WINDOWS_FOLDER_DEVELOPMENT_SCHEMA
            or delegation.get("cargo_profile") != BACKEND_CARGO_PROFILE
            or not IMAGE_RE.fullmatch(toolchain)
            or delegation.get("toolchain_image_id") != toolchain
            or delegation.get("package_root") != str(PACKAGE_ROOT)
            or delegation.get("provenance_path") != str(PROVENANCE_PATH)
            or not group_identity
            or delegation.get("group_identity") != group_identity
        ):
            return False
        _validate_development_source_identity(delegation.get("source_identity"))
        stable = dict(document)
        for field in ("source_commit", "binary_hashes", "artifact_receipt_sha256"):
            stable.pop(field, None)
        stable_delegation = dict(delegation)
        stable_delegation.pop("source_identity")
        stable["development_build"] = stable_delegation
        normalized.append(stable)
    return normalized[0] == normalized[1]


def _validate_windows_folder_attestation(
    host: Mapping[str, Any] | None,
    owner: Mapping[str, Any] | None,
    provenance: Mapping[str, Any],
    receipt_sha256: str,
) -> str:
    """Return ``ready``/``pending`` or fail on a conflicting host identity."""

    if host is None or owner is None:
        return "pending"
    if host != owner:
        if _development_refresh_publication_pending(host, owner):
            return "pending"
        host_without_restart = {
            key: value for key, value in host.items() if key != "restart_verified"
        }
        owner_without_restart = {
            key: value for key, value in owner.items() if key != "restart_verified"
        }
        if (
            host_without_restart == owner_without_restart
            and isinstance(host.get("restart_verified"), bool)
            and isinstance(owner.get("restart_verified"), bool)
        ):
            return "pending"
        _fail("Windows-folder host certificate and owner marker differ")
    if host.get("schema") != WINDOWS_FOLDER_HOST_SCHEMA:
        _fail("Windows-folder host attestation schema is unsupported")
    if (
        host.get("storage_profile") != WINDOWS_FOLDER_STORAGE_PROFILE
        or host.get("role") != "session"
        or host.get("owner_scope") != "docker-desktop-linux"
    ):
        _fail("Windows-folder host attestation scope is invalid")
    image_id = os.environ.get("FULLMAG_RUNTIME_IMAGE_ID", "")
    if not IMAGE_RE.fullmatch(image_id) or host.get("image_id") != image_id:
        _fail("Windows-folder host image identity differs from the running image")
    owner_token = host.get("owner_token")
    if not isinstance(owner_token, str) or not owner_token:
        _fail("Windows-folder host attestation has no owner token")
    if host.get("restart_verified") is not True:
        return "pending"

    delegation = host.get("development_build")
    if delegation is None:
        if host.get("source_commit") != provenance.get("commit"):
            _fail("Windows-folder host source identity differs from runtime provenance")
        if host.get("binary_hashes") != provenance.get("binary_hashes"):
            _fail("Windows-folder host binary identity differs from runtime provenance")
        if host.get("artifact_receipt_sha256") != receipt_sha256:
            _fail("Windows-folder host receipt identity differs from the package")
        return "ready"
    if not isinstance(delegation, dict):
        _fail("Windows-folder development delegation is malformed")
    required = {
        "schema",
        "cargo_profile",
        "toolchain_image_id",
        "package_root",
        "provenance_path",
        "group_identity",
        "source_identity",
    }
    if set(delegation) != required or delegation.get("schema") != WINDOWS_FOLDER_DEVELOPMENT_SCHEMA:
        _fail("Windows-folder development delegation fields are invalid")
    if delegation.get("cargo_profile") != BACKEND_CARGO_PROFILE:
        _fail("Windows-folder development delegation has an invalid Cargo profile")
    toolchain = os.environ.get("FULLMAG_TOOLCHAIN_IMAGE_ID", "")
    if not IMAGE_RE.fullmatch(toolchain) or delegation.get("toolchain_image_id") != toolchain:
        _fail("Windows-folder development delegation toolchain identity differs")
    group_identity = os.environ.get("FULLMAG_COMPOSE_PROJECT", "")
    if (
        delegation.get("package_root") != str(PACKAGE_ROOT)
        or delegation.get("provenance_path") != str(PROVENANCE_PATH)
        or not group_identity
        or delegation.get("group_identity") != group_identity
    ):
        _fail("Windows-folder development delegation is bound to another package or group")
    _validate_development_source_identity(delegation.get("source_identity"))
    if provenance.get("schema") != "fullmag.docker-all-image.v1" or provenance.get("state") != "succeeded":
        _fail("runtime provenance is not a succeeded development build")
    if provenance.get("cargo_profile") != BACKEND_CARGO_PROFILE:
        _fail("runtime provenance has an invalid development Cargo profile")
    if provenance.get("toolchain_image_id") != toolchain:
        _fail("runtime provenance toolchain identity differs from the delegation")
    if provenance.get("package_root") != str(PACKAGE_ROOT):
        _fail("runtime provenance package root differs from the delegation")
    return "ready"


def _validate_linux_native_build(host, provenance, receipt_sha256):
    """Bind Linux host delegation to the verified live package and Compose group."""
    delegation = host.get("development_build")
    if not isinstance(delegation, dict):
        _fail("Linux native DEV requires a development build delegation")
    expected = {
        "cargo_profile": BACKEND_CARGO_PROFILE,
        "toolchain_image_id": os.environ.get("FULLMAG_TOOLCHAIN_IMAGE_ID"),
        "package_root": str(PACKAGE_ROOT),
        "provenance_path": str(PROVENANCE_PATH),
        "group_identity": os.environ.get("FULLMAG_COMPOSE_PROJECT"),
    }
    if (delegation.get("schema") != WINDOWS_FOLDER_DEVELOPMENT_SCHEMA
            or not expected["group_identity"]
            or not IMAGE_RE.fullmatch(expected["toolchain_image_id"] or "")
            or any(delegation.get(key) != value for key, value in expected.items())
            or set(delegation) != {"schema", "source_identity", *expected}):
        _fail("Linux native development delegation differs from package/toolchain/group")
    _validate_development_source_identity(delegation["source_identity"])
    if (provenance.get("schema") != "fullmag.docker-all-image.v1"
            or provenance.get("state") != "succeeded"
            or provenance.get("cargo_profile") != BACKEND_CARGO_PROFILE
            or provenance.get("toolchain_image_id") != expected["toolchain_image_id"]
            or provenance.get("package_root") != str(PACKAGE_ROOT)
            or provenance.get("build_receipt_sha256") != receipt_sha256):
        _fail("Linux native runtime provenance differs from the verified package")


def _wait_for_windows_folder_attestation(
    provenance: Mapping[str, Any], receipt_sha256: str
) -> None:
    """Wait for the host writer's matching cert before handing off to entrypoint."""

    deadline = time.monotonic() + WINDOWS_FOLDER_GATE_TIMEOUT_SECONDS
    while True:
        host = _read_optional_storage_attestation(HOST_ATTESTATION_PATH, "Windows-folder host attestation")
        owner = _read_optional_storage_attestation(WINDOWS_FOLDER_OWNER_PATH, "Windows-folder owner marker")
        if _validate_windows_folder_attestation(host, owner, provenance, receipt_sha256) == "ready":
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail(
                "timed out waiting for a matching Windows-folder host attestation "
                f"after {WINDOWS_FOLDER_GATE_TIMEOUT_SECONDS:g} seconds"
            )
        time.sleep(min(WINDOWS_FOLDER_GATE_POLL_SECONDS, remaining))


def _serve(extra: list[str]) -> int:
    if os.environ.get("FULLMAG_DOCKER_ROLE") == "frontend":
        environment = dict(os.environ)
        command = [sys.executable, "/opt/fullmag/entrypoint.py", *extra]
        _log_phase("api", "exec", mode="frontend")
        os.execvpe(sys.executable, command, environment)
        return 0
    if extra == ["--storage-probe"]:
        environment = dict(os.environ)
        environment["FULLMAG_DOCKER_ROLE"] = "backend"
        command = [sys.executable, "/opt/fullmag/entrypoint.py", *extra]
        _log_phase("api", "exec", mode="storage-probe")
        os.execvpe(sys.executable, command, environment)
        return 0
    package_started = time.monotonic()
    _log_phase("package", "verify-start")
    receipt_path = PACKAGE_ROOT / "backend-build-receipt.json"
    receipt, receipt_bytes = _read_json(receipt_path, "backend build receipt", 8 * 1024 * 1024)
    if receipt.get("schema") != RECEIPT_SCHEMA or receipt.get("state") != "succeeded":
        _fail("runtime package receipt is not a successful direct-compose receipt")
    lanes = receipt.get("execution_lanes")
    if not isinstance(lanes, dict) or set(lanes) != set(LANES):
        _fail("runtime package receipt does not attest all four execution lanes")
    actual_artifacts = _hash_package(PACKAGE_ROOT)
    if receipt.get("artifacts") != actual_artifacts:
        _fail("runtime package artifacts differ from the build receipt")
    _log_phase(
        "package",
        "verify-complete",
        files=len(actual_artifacts),
        duration_ms=round((time.monotonic() - package_started) * 1000),
    )
    receipt_sha256 = _sha256_bytes(receipt_bytes)
    if os.environ.get("FULLMAG_SESSION_STORAGE_PROFILE") == WINDOWS_FOLDER_STORAGE_PROFILE:
        _log_phase("gate", "start", profile=WINDOWS_FOLDER_STORAGE_PROFILE)
        provenance, _ = _read_json(PROVENANCE_PATH, "runtime provenance", 8 * 1024 * 1024)
        try:
            _wait_for_windows_folder_attestation(provenance, receipt_sha256)
        except (BackendBuildError, OSError) as error:
            _log_phase("gate", "failed", error=type(error).__name__)
            raise
        _log_phase("gate", "complete", profile=WINDOWS_FOLDER_STORAGE_PROFILE)
    elif os.environ.get("FULLMAG_SESSION_STORAGE_PROFILE") == "linux-native-v1":
        from linux_native_probe import validate_host
        _log_phase("gate", "start", profile="linux-native-v1")
        deadline = time.monotonic() + 240
        while True:
            try:
                host, _, _ = validate_host()
                provenance, _ = _read_json(PROVENANCE_PATH, "runtime provenance", 8 * 1024 * 1024)
                _validate_linux_native_build(host, provenance, receipt_sha256)
                break
            except (RuntimeError, OSError, json.JSONDecodeError) as error:
                if time.monotonic() >= deadline:
                    raise BackendBuildError("Linux native host admission did not become ready") from error
                time.sleep(0.2)
        _log_phase("gate", "complete", profile="linux-native-v1")
    else:
        _log_phase("gate", "skipped", reason="storage-profile")
    environment = dict(os.environ)
    environment.update(
        {
            "FULLMAG_DOCKER_ROLE": "backend",
            "FULLMAG_RUNTIME_ROOT": str(PACKAGE_ROOT),
            "FULLMAG_RUNTIME_PACKAGE_ROOT": str(PACKAGE_ROOT),
            "FULLMAG_PACKAGE_PROVENANCE": str(PROVENANCE_PATH),
            "FULLMAG_RUNTIME_PROVENANCE": str(PROVENANCE_PATH),
            "FULLMAG_WEB_STATIC_DIR": str(PACKAGE_ROOT / "web"),
            "PATH": f"{PACKAGE_ROOT / 'bin'}:/opt/fullmag-deps/bin:/usr/local/cuda/bin:/usr/local/bin:/usr/bin:/bin",
        }
    )
    command = [sys.executable, "/opt/fullmag/entrypoint.py", *extra]
    _log_phase("api", "exec", mode="backend")
    os.execvpe(sys.executable, command, environment)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="operation", required=True)
    for name in ("prepare", "build"):
        subparser = subparsers.add_parser(name, help="build the direct four-lane package")
        subparser.add_argument("--source-tar", type=Path)
        subparser.add_argument("--manifest", required=True, type=Path)
        subparser.add_argument("--source-root", default=Path("/opt/fullmag/source"), type=Path)
        subparser.add_argument(
            "--git-common-root",
            default=Path(os.environ.get("FULLMAG_SOURCE_GIT_COMMON", "/opt/fullmag/source-git")),
            type=Path,
        )
        subparser.add_argument("--output", default=OUTPUT_ROOT, type=Path)
        subparser.add_argument("--build-root", default=BUILD_ROOT, type=Path)
        subparser.add_argument("--jobs", default=int(os.environ.get("CARGO_BUILD_JOBS", "2")), type=int)
    start = subparsers.add_parser(
        "start", help="build and serve the receipt-validated package in this container"
    )
    start.add_argument("--source-tar", type=Path)
    # Dev ``start`` captures the currently mounted checkout inside the trusted
    # image.  The optional path is retained as a bootstrap compatibility
    # argument for older Compose metadata; it is never the restart source of
    # truth.  Archive ``prepare``/``build`` keep their required manifest.
    start.add_argument("--manifest", type=Path)
    start.add_argument("--source-root", default=Path("/opt/fullmag/source"), type=Path)
    start.add_argument(
        "--git-common-root",
        default=Path(os.environ.get("FULLMAG_SOURCE_GIT_COMMON", "/opt/fullmag/source-git")),
        type=Path,
    )
    start.add_argument("--output", default=PACKAGE_ROOT, type=Path)
    start.add_argument("--build-root", default=BUILD_ROOT, type=Path)
    start.add_argument("--jobs", default=int(os.environ.get("CARGO_BUILD_JOBS", "2")), type=int)
    subparsers.add_parser("serve", help="serve the receipt-validated package")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args, extra = parser.parse_known_args(argv)
    try:
        if args.operation in {"prepare", "build"}:
            if extra:
                parser.error(f"unexpected arguments for {args.operation}: {' '.join(extra)}")
            return _prepare(args)
        if args.operation == "start":
            if extra:
                parser.error(f"unexpected arguments for start: {' '.join(extra)}")
            return _start(args)
        return _serve(extra)
    except BackendBuildError as error:
        print(f"backend-dev: {error}", file=sys.stderr)
        return 2
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f"backend-dev: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
