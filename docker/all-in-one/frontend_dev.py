"""Own the optional frontend-only Control Room development process.

The API, Rust service, FEM/GPU process tree, and Windows session storage run
in the separate ``fullmag`` service.  This module owns only the development
Next process and its first, frozen Linux dependency installation.  The host
launcher prepares ``/state/development/workspace`` and mounts the four live
Control Room source directories there read-only.  No source tree, CUDA setup,
or session store is touched by this module.

The public lifecycle is deliberately small so the container entrypoint can
supervise it without giving the frontend permission to restart or reconfigure
the backend::

    if enabled():
        frontend = start(stopping_event)
        check(frontend)
        stop(frontend)

All mutable frontend state, logs, receipts, frozen input bytes, and Linux
dependencies stay below ``/state/development``.  There is no cache pruning or
unbounded operator supplied path.
"""
from __future__ import annotations

import dataclasses
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import subprocess
import sys
import time
import uuid
from typing import Any, Mapping, NoReturn

_MODULE_DIRECTORY = str(Path(__file__).resolve().parent)
if _MODULE_DIRECTORY not in sys.path:
    sys.path.insert(0, _MODULE_DIRECTORY)

try:
    from runtime_service import (
        _assert_no_links as _runtime_assert_no_links,
        _atomic_json as _runtime_atomic_json,
        _bounded_regular as _runtime_bounded_regular,
        _ensure_directory as _runtime_ensure_directory,
        _read_json as _runtime_read_json,
    )
except ImportError as error:  # pragma: no cover - only a broken image layout
    raise RuntimeError("frontend_dev.py requires the adjacent runtime_service.py") from error


INPUTS_SCHEMA = "fullmag.docker-development-inputs.v1"
FREEZE_SCHEMA = "fullmag.docker-development-inputs-freeze.v1"
RECEIPT_SCHEMA = "fullmag.docker-frontend-development-receipt.v1"

INPUTS_PATH = Path("/run/fullmag/development-inputs.json")
DEVELOPMENT_ROOT = Path("/state/development")
WORKSPACE_ROOT = DEVELOPMENT_ROOT / "workspace"
FRONTEND_ROOT = DEVELOPMENT_ROOT / "cache"
PNPM_STORE_ROOT = DEVELOPMENT_ROOT / "pnpm-store"
PNPM_HOME = DEVELOPMENT_ROOT / "pnpm-home"
COREPACK_HOME = DEVELOPMENT_ROOT / "corepack"
HOME_ROOT = DEVELOPMENT_ROOT / "home"
TEMP_ROOT = DEVELOPMENT_ROOT / "tmp"
FREEZE_ROOT = DEVELOPMENT_ROOT / "frozen-inputs"
FREEZE_PATH = DEVELOPMENT_ROOT / "inputs-freeze.json"
RECEIPT_PATH = DEVELOPMENT_ROOT / "frontend-dev-receipt.json"
LOG_PATH = DEVELOPMENT_ROOT / "next.log"

NODE_BINARY = Path("/usr/local/bin/node")
PNPM_BINARY = Path("/usr/local/bin/pnpm")
EXPECTED_NODE_VERSION = "v24.18.0"
EXPECTED_PNPM_VERSION = "10.8.1"

INTERNAL_PORT = 8080
API_PROXY_TARGET = "http://backend:8081"
NEXT_DIST_DIR = ".next-control-room-8080"
NEXT_RELATIVE = Path("node_modules/next/dist/bin/next")
LIVE_DIRECTORY_NAMES = ("app", "src", "public", "scripts")
LIVE_DIRECTORY_PATHS = tuple(f"apps/control-room/{name}" for name in LIVE_DIRECTORY_NAMES)
REQUIRED_MANIFEST_KEYS = frozenset(
    {
        "schema",
        "source_root",
        "source_commit",
        "host_port",
        "workspace_root",
        "frontend_root",
        "files",
        "live_directories",
    }
)
# The host seeder may retain mount provenance beside the fixed runtime
# contract.  It is frozen and included in the digest, but never interpreted as
# a guest path or copied into the workspace.
OPTIONAL_MANIFEST_KEYS = frozenset(
    {"source_selection", "source_volume", "configuration_changes", "backend_build"}
)
GENERATED_RELATIVES = frozenset(
    {
        "apps/control-room/next-env.d.ts",
        "apps/control-room/tsconfig.json",
    }
)
REQUIRED_SEED_RELATIVES = frozenset(
    {
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "apps/control-room/package.json",
        "apps/control-room/next.config.ts",
    }
)
FORBIDDEN_RELATIVE_PARTS = frozenset({".git", "node_modules"})
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
WINDOWS_PATH = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\)")
MAX_INPUTS_BYTES = 512 * 1024
MAX_SEED_FILE_BYTES = 8 * 1024 * 1024
MAX_SEED_TOTAL_BYTES = 64 * 1024 * 1024
MAX_SEED_FILES = 4096
MAX_RELATIVE_BYTES = 512
INSTALL_TIMEOUT_SECONDS = 30 * 60
# A Corepack shim may resolve the packageManager declared by the seeded root
# manifest on its first invocation. Keep that initialization bounded without
# making a healthy cold container fail during ordinary registry latency.
TOOL_TIMEOUT_SECONDS = 30
STOP_TIMEOUT_SECONDS = 15
PROCESS_IDENTITY_FIELDS = (
    "pid_namespace",
    "process_start_time_ticks",
    "session_id",
    "process_group_id",
)


class FrontendDevError(RuntimeError):
    """A deterministic frontend setup, contract, or process failure."""


class FrontendDevUnknown(FrontendDevError):
    """A process timeout or ownership outcome that cannot be inferred safely."""


@dataclasses.dataclass(frozen=True)
class SeedFile:
    relative: str
    sha256: str


@dataclasses.dataclass(frozen=True)
class DevelopmentInputs:
    source_root: str
    source_commit: str
    host_port: int
    workspace_root: Path
    frontend_root: Path
    files: tuple[SeedFile, ...]
    live_directories: tuple[str, ...]
    manifest_digest: str
    manifest: Mapping[str, Any]


@dataclasses.dataclass
class FrontendHandle:
    """A process started by this module and safe for this module to stop."""

    process: subprocess.Popen[Any]
    inputs: DevelopmentInputs
    stopping_event: Any
    kind: str
    pid: int
    owner_token: str
    log_path: Path
    log_stream: Any | None = None
    stopped: bool = False
    process_group_id: int | None = None
    process_identity: Mapping[str, Any] | None = None


def enabled(environment: Mapping[str, str] | None = None) -> bool:
    """Return whether the explicitly selected Docker frontend mode is active."""

    environment = os.environ if environment is None else environment
    return environment.get("FULLMAG_DOCKER_FRONTEND", "") == "dev"


def _fail(message: str) -> None:
    raise FrontendDevError(message)


def _path_without_parent(path: Path, name: str) -> Path:
    if not path.is_absolute() or any(part == ".." for part in path.parts):
        _fail(f"{name} must be absolute without parent traversal")
    return path


def _assert_no_links(path: Path, name: str) -> None:
    """Use the runtime's no-follow traversal for fixed state and seed paths."""

    _path_without_parent(path, name)
    try:
        _runtime_assert_no_links(path, name)
    except Exception as error:
        if isinstance(error, FrontendDevError):
            raise
        _fail(str(error))


def _ensure_directory(path: Path, name: str) -> Path:
    _path_without_parent(path, name)
    try:
        return _runtime_ensure_directory(path, name)
    except Exception as error:
        if isinstance(error, FrontendDevError):
            raise
        _fail(str(error))


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
    except (OSError, RuntimeError, ValueError):
        return False
    return True


def _bounded_bytes(path: Path, name: str, maximum: int = MAX_SEED_FILE_BYTES) -> bytes:
    try:
        return _runtime_bounded_regular(path, name, maximum)
    except FileNotFoundError:
        raise
    except Exception as error:
        if isinstance(error, FrontendDevError):
            raise
        _fail(str(error))


def _read_json(path: Path, name: str, maximum: int = MAX_INPUTS_BYTES) -> dict[str, Any]:
    try:
        return _runtime_read_json(path, name, maximum)
    except FileNotFoundError:
        raise
    except Exception as error:
        if isinstance(error, FrontendDevError):
            raise
        _fail(str(error))


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _atomic_bytes(path: Path, data: bytes, name: str, *, replace: bool = True) -> None:
    path = _path_without_parent(path, name)
    parent = _ensure_directory(path.parent, f"{name} parent")
    try:
        existing = path.lstat()
    except FileNotFoundError:
        existing = None
    if existing is not None and (stat.S_ISLNK(existing.st_mode) or not replace):
        _fail(f"refusing to replace existing {name}")
    temporary = parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
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
    try:
        os.replace(temporary, path)
        directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError as error:
        _fail(f"durable publication of {name} is unknown: {error}")


def _atomic_json(path: Path, value: Mapping[str, Any], name: str) -> None:
    try:
        _runtime_atomic_json(path, value, name)
    except Exception as error:
        if isinstance(error, FrontendDevError):
            raise
        _fail(str(error))


def _hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _manifest_digest(value: Mapping[str, Any]) -> str:
    return _hash_bytes(_canonical_json(value))


def _relative_path(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value or len(value.encode()) > MAX_RELATIVE_BYTES:
        _fail(f"{name} must be a bounded relative path")
    if "\x00" in value or "\\" in value:
        _fail(f"{name} must use normalized POSIX path syntax")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        _fail(f"{name} must not contain absolute or parent traversal")
    if any(part in FORBIDDEN_RELATIVE_PARTS for part in path.parts):
        _fail(f"{name} traverses a forbidden dependency tree")
    if path.name == ".env" or path.name.startswith(".env."):
        _fail(f"{name} must not include environment files")
    return path.as_posix()


def _canonical_live_directory(value: Any, name: str) -> str:
    if isinstance(value, dict):
        if set(value) != {"name", "source", "target"}:
            _fail(f"{name} mount descriptor has an unexpected field set")
        source = value.get("source")
        if not isinstance(source, str) or not source or len(source.encode()) > 2048 or "\x00" in source:
            _fail(f"{name}.source must be a bounded diagnostic host path")
        raw_name = value.get("name")
        if not isinstance(raw_name, str):
            _fail(f"{name}.name must be a string")
        normalized_name = raw_name.strip().replace("\\", "/")
        if normalized_name.startswith("apps/control-room/"):
            normalized_name = normalized_name[len("apps/control-room/") :]
        if normalized_name not in LIVE_DIRECTORY_NAMES:
            _fail(f"{name}.name is not one of the four live Control Room directories")
        expected_target = str(WORKSPACE_ROOT / "apps" / "control-room" / normalized_name)
        if value.get("target") != expected_target:
            _fail(f"{name}.target is outside the fixed Control Room workspace")
        value = normalized_name
    if not isinstance(value, str):
        _fail(f"{name} must be a string or host mount descriptor")
    normalized = value.strip().replace("\\", "/")
    prefix = "apps/control-room/"
    if normalized.startswith(prefix):
        normalized = normalized[len(prefix) :]
    if normalized not in LIVE_DIRECTORY_NAMES:
        _fail(f"{name} is not one of the four live Control Room directories")
    return normalized


def read_inputs(path: Path | None = None) -> DevelopmentInputs:
    """Read and validate the bounded, fixed-layout host input manifest."""

    if path is None:
        path = INPUTS_PATH
    if path != INPUTS_PATH:
        _fail("development input manifest path is fixed to /run/fullmag/development-inputs.json")
    manifest = _read_json(path, "Docker development input manifest")
    unexpected_keys = set(manifest) - REQUIRED_MANIFEST_KEYS - OPTIONAL_MANIFEST_KEYS
    if not REQUIRED_MANIFEST_KEYS <= set(manifest) or unexpected_keys:
        _fail("Docker development input manifest has an unexpected field set")
    if manifest.get("schema") != INPUTS_SCHEMA:
        _fail("Docker development input manifest has an unsupported schema")
    source_root = manifest.get("source_root")
    if (
        not isinstance(source_root, str)
        or not source_root
        or len(source_root.encode()) > 2048
        or "\x00" in source_root
        or not WINDOWS_PATH.match(source_root)
    ):
        _fail("source_root must be a diagnostic Windows path")
    source_commit = manifest.get("source_commit")
    if not isinstance(source_commit, str) or not HEX40.fullmatch(source_commit):
        _fail("source_commit must be a lowercase full Git commit")
    host_port = manifest.get("host_port")
    if isinstance(host_port, bool) or not isinstance(host_port, int) or not 1024 <= host_port <= 65535:
        _fail("host_port must be an integer in 1024..65535")
    workspace_root = manifest.get("workspace_root")
    frontend_root = manifest.get("frontend_root")
    if workspace_root != str(WORKSPACE_ROOT) or frontend_root != str(FRONTEND_ROOT):
        _fail("Docker development workspace and frontend roots are fixed to /state/development")
    raw_live = manifest.get("live_directories")
    if not isinstance(raw_live, list) or len(raw_live) != len(LIVE_DIRECTORY_NAMES):
        _fail("live_directories must contain exactly four entries")
    live_directories = tuple(_canonical_live_directory(value, "live_directories entry") for value in raw_live)
    if set(live_directories) != set(LIVE_DIRECTORY_NAMES):
        _fail("live_directories must contain app, src, public, and scripts exactly once")
    raw_files = manifest.get("files")
    if not isinstance(raw_files, list) or not raw_files or len(raw_files) > MAX_SEED_FILES:
        _fail("files must be a bounded non-empty list")
    files: list[SeedFile] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_files):
        if not isinstance(item, dict) or set(item) != {"relative", "sha256"}:
            _fail(f"files[{index}] must contain only relative and sha256")
        relative = _relative_path(item.get("relative"), f"files[{index}].relative")
        if relative in seen:
            _fail(f"files contains duplicate path {relative}")
        if any(
            relative == live_path or relative.startswith(f"{live_path}/")
            for live_path in LIVE_DIRECTORY_PATHS
        ):
            _fail(f"files must not include read-only live source directory {relative}")
        digest = item.get("sha256")
        if not isinstance(digest, str) or not HEX64.fullmatch(digest):
            _fail(f"files[{index}].sha256 must be a lowercase SHA-256")
        seen.add(relative)
        files.append(SeedFile(relative, digest))
    missing_required = REQUIRED_SEED_RELATIVES - seen
    if missing_required:
        _fail(f"Docker development seed omitted required files: {sorted(missing_required)}")
    return DevelopmentInputs(
        source_root=source_root,
        source_commit=source_commit,
        host_port=host_port,
        workspace_root=WORKSPACE_ROOT,
        frontend_root=FRONTEND_ROOT,
        files=tuple(files),
        live_directories=live_directories,
        manifest_digest=_manifest_digest(manifest),
        manifest=manifest,
    )


def _seed_file_path(inputs: DevelopmentInputs, relative: str) -> Path:
    path = inputs.workspace_root.joinpath(*PurePosixPath(relative).parts)
    if not _is_within(path, inputs.workspace_root):
        _fail(f"seed path escapes workspace: {relative}")
    return path


def _validate_seed_files(
    inputs: DevelopmentInputs, *, allow_generated: bool = False
) -> int:
    total = 0
    for seed in inputs.files:
        path = _seed_file_path(inputs, seed.relative)
        if allow_generated and seed.relative in GENERATED_RELATIVES:
            if os.path.lexists(path):
                data = _bounded_bytes(path, f"generated seed {seed.relative}")
                total += len(data)
            continue
        try:
            data = _bounded_bytes(path, f"seed file {seed.relative}")
        except FileNotFoundError as error:
            raise FrontendDevError(f"seed file is missing: {seed.relative}") from error
        total += len(data)
        if total > MAX_SEED_TOTAL_BYTES:
            _fail("Docker development seed exceeds its total size bound")
        if _hash_bytes(data) != seed.sha256:
            _fail(f"seed file hash changed: {seed.relative}")
    return total


def _freeze_manifest(inputs: DevelopmentInputs) -> dict[str, Any]:
    return {
        "schema": FREEZE_SCHEMA,
        "manifest_digest": inputs.manifest_digest,
        "manifest": dict(inputs.manifest),
        "files": [{"relative": file.relative, "sha256": file.sha256} for file in inputs.files],
        "frozen_root": str(FREEZE_ROOT),
    }


def _freeze_inputs(inputs: DevelopmentInputs, *, allow_generated: bool) -> None:
    """Create or verify the durable original input bytes; never refresh them."""

    if FREEZE_PATH.exists():
        frozen = _read_json(FREEZE_PATH, "frozen Docker development inputs")
        if frozen.get("schema") != FREEZE_SCHEMA:
            _fail("frozen Docker development inputs have an unsupported schema")
        expected = _freeze_manifest(inputs)
        if frozen.get("manifest_digest") != expected["manifest_digest"] or frozen.get("manifest") != expected["manifest"]:
            _fail("Docker development configuration or source identity changed; create a new development state")
        if frozen.get("files") != expected["files"]:
            _fail("Docker development dependency file inventory changed; create a new development state")
        if frozen.get("frozen_root") != str(FREEZE_ROOT):
            _fail("frozen Docker development input root is not canonical")
        for seed in inputs.files:
            frozen_path = _seed_file_path(
                dataclasses.replace(inputs, workspace_root=FREEZE_ROOT), seed.relative
            )
            try:
                original = _bounded_bytes(frozen_path, f"frozen seed file {seed.relative}")
            except FileNotFoundError as error:
                raise FrontendDevError(f"frozen seed file is missing: {seed.relative}") from error
            if _hash_bytes(original) != seed.sha256:
                _fail(f"frozen seed file hash is invalid: {seed.relative}")
        _validate_seed_files(inputs, allow_generated=allow_generated)
        return

    if FREEZE_ROOT.exists():
        _fail("partial frozen input state exists without its durable manifest")
    _validate_seed_files(inputs, allow_generated=False)
    _ensure_directory(FREEZE_ROOT, "frozen input root")
    for seed in inputs.files:
        source = _seed_file_path(inputs, seed.relative)
        data = _bounded_bytes(source, f"initial seed file {seed.relative}")
        destination = _seed_file_path(
            dataclasses.replace(inputs, workspace_root=FREEZE_ROOT), seed.relative
        )
        _atomic_bytes(destination, data, f"frozen seed file {seed.relative}", replace=False)
    _atomic_json(FREEZE_PATH, _freeze_manifest(inputs), "frozen Docker development inputs")


def _load_receipt() -> dict[str, Any] | None:
    try:
        receipt = _read_json(RECEIPT_PATH, "frontend development receipt")
    except FileNotFoundError:
        return None
    if receipt.get("schema") != RECEIPT_SCHEMA:
        _fail("frontend development receipt has an unsupported schema")
    return receipt


def _generated_gate(receipt: Mapping[str, Any] | None) -> bool:
    return bool(receipt and receipt.get("generated_files_gate") == "next-started-v1")


def _receipt_failure(receipt: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if not receipt or receipt.get("state") not in {
        "failed",
        "unknown",
        "stop-unknown",
        "stop-timeout",
        "stopped-after-failure",
    }:
        return None
    return {
        key: receipt[key]
        for key in ("state", "error", "failure_evidence", "pid", "exit_code")
        if key in receipt
    }


def _read_process_identity(pid: Any) -> dict[str, Any] | None:
    """Read the Linux identity needed to distinguish a live owner from PID reuse."""

    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    stat_path = Path(f"/proc/{pid}/stat")
    namespace_path = Path(f"/proc/{pid}/ns/pid")
    try:
        raw = stat_path.read_bytes()
        namespace = os.readlink(namespace_path)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise FrontendDevUnknown(
            f"cannot establish process identity for pid {pid}: {error}"
        ) from error
    closing_paren = raw.rfind(b")")
    if closing_paren < 0:
        raise FrontendDevUnknown(f"process stat is malformed for pid {pid}")
    fields = raw[closing_paren + 1 :].split()
    # fields[0] is field 3 (state), so field 5/6/22 are indices 2/3/19.
    if len(fields) <= 19:
        raise FrontendDevUnknown(f"process stat is incomplete for pid {pid}")
    try:
        process_group_id = int(fields[2], 10)
        session_id = int(fields[3], 10)
        process_start_time_ticks = int(fields[19], 10)
    except ValueError as error:
        raise FrontendDevUnknown(f"process stat is not numeric for pid {pid}") from error
    if (
        not namespace.startswith("pid:[")
        or process_group_id <= 0
        or session_id <= 0
        or process_start_time_ticks < 0
    ):
        raise FrontendDevUnknown(f"process identity is invalid for pid {pid}")
    return {
        "pid": pid,
        "pid_namespace": namespace,
        "process_start_time_ticks": process_start_time_ticks,
        "session_id": session_id,
        "process_group_id": process_group_id,
    }


def _validated_process_identity(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    pid = value.get("pid")
    namespace = value.get("pid_namespace")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    if not isinstance(namespace, str) or not namespace.startswith("pid:["):
        return None
    identity: dict[str, Any] = {"pid": pid, "pid_namespace": namespace}
    for field in PROCESS_IDENTITY_FIELDS[1:]:
        item = value.get(field)
        if isinstance(item, bool) or not isinstance(item, int):
            return None
        if field == "process_start_time_ticks" and item < 0:
            return None
        if field != "process_start_time_ticks" and item <= 0:
            return None
        identity[field] = item
    return identity


def _receipt_process_identity(receipt: Mapping[str, Any]) -> dict[str, Any] | None:
    value = {"pid": receipt.get("pid")}
    value.update({field: receipt.get(field) for field in PROCESS_IDENTITY_FIELDS})
    return _validated_process_identity(value)


def _identity_matches(expected: Mapping[str, Any], observed: Mapping[str, Any]) -> bool:
    return all(expected.get(field) == observed.get(field) for field in PROCESS_IDENTITY_FIELDS)


def _record_owner_unknown(
    receipt: Mapping[str, Any],
    message: str,
    *,
    expected: Mapping[str, Any] | None = None,
    observed: Mapping[str, Any] | None = None,
) -> NoReturn:
    updated = dict(receipt)
    evidence: dict[str, Any] = {"kind": "owner-identity-unconfirmed", "message": message}
    if expected is not None:
        evidence["expected_process_identity"] = dict(expected)
    if observed is not None:
        evidence["observed_process_identity"] = dict(observed)
    updated.update(state="unknown", error=message, failure_evidence=evidence)
    try:
        _publish_receipt(updated)
    except Exception as error:
        raise FrontendDevUnknown(
            f"{message}; publishing unknown owner receipt failed: {error}"
        ) from error
    raise FrontendDevUnknown(message)


def _reject_existing_owner(receipt: Mapping[str, Any] | None) -> None:
    if not receipt:
        return
    state = receipt.get("state")
    if state in {"unknown", "stop-unknown", "stop-timeout"}:
        raise FrontendDevUnknown(
            "previous frontend shutdown outcome is unknown; explicit recovery is required"
        )
    if state not in {
        "starting",
        "installing",
        "running",
        "stopping",
        "failed",
        "stopped-after-failure",
    }:
        return

    expected = _receipt_process_identity(receipt)
    try:
        observed = _read_process_identity(receipt.get("pid"))
    except FrontendDevUnknown as error:
        _record_owner_unknown(receipt, str(error), expected=expected)

    if state in {"starting", "installing", "running", "stopping"}:
        if expected is not None and observed is not None and _identity_matches(expected, observed):
            _fail("an existing frontend development process is still owned; no takeover or autorestart")
        _record_owner_unknown(
            receipt,
            "frontend process owner identity is missing or no longer matches; explicit recovery is required",
            expected=expected,
            observed=observed,
        )

    # A terminal failure is restartable only after proving that the original
    # private group is gone. This also protects legacy receipts whose leader
    # exited while a pnpm/Next descendant survived.
    if expected is None:
        if receipt.get("pid") is None:
            return
        _record_owner_unknown(
            receipt,
            "terminal frontend receipt has no authenticated process identity; explicit recovery is required",
            observed=observed,
        )
    if observed is not None and _identity_matches(expected, observed):
        _fail("an existing frontend development process is still owned; no takeover or autorestart")
    try:
        group_empty = _group_empty(expected["process_group_id"])
    except FrontendDevUnknown as error:
        _record_owner_unknown(receipt, str(error), expected=expected, observed=observed)
    if not group_empty:
        _record_owner_unknown(
            receipt,
            "terminal frontend receipt still has a live process group; explicit recovery is required",
            expected=expected,
            observed=observed,
        )


def _prepare_state_directories() -> None:
    for path, name in (
        (DEVELOPMENT_ROOT, "development root"),
        (FRONTEND_ROOT, "frontend cache root"),
        (PNPM_STORE_ROOT, "pnpm store"),
        (PNPM_HOME, "pnpm home"),
        (COREPACK_HOME, "Corepack home"),
        (HOME_ROOT, "frontend HOME"),
        (TEMP_ROOT, "frontend temporary root"),
    ):
        _ensure_directory(path, name)


def _ensure_cache_layout(inputs: DevelopmentInputs) -> None:
    if inputs.frontend_root != FRONTEND_ROOT:
        _fail("frontend cache root is not canonical")
    for relative in ("out", "next/default", f"next/dev-{INTERNAL_PORT}"):
        _ensure_directory(FRONTEND_ROOT / relative, f"frontend cache {relative}")


def _ensure_managed_link(link: Path, target: Path, name: str) -> None:
    _assert_no_links(link.parent, f"{name} parent")
    _assert_no_links(target, f"{name} target")
    try:
        metadata = link.lstat()
    except FileNotFoundError:
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError as error:
            _fail(f"cannot create managed frontend link {name}: {error}")
        metadata = link.lstat()
    if not stat.S_ISLNK(metadata.st_mode):
        _fail(f"managed frontend path is not a symlink: {link}")
    try:
        resolved_link = link.resolve(strict=True)
        resolved_target = target.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        _fail(f"cannot resolve managed frontend link {name}: {error}")
    if resolved_link != resolved_target:
        _fail(f"managed frontend link mismatch: {link} -> {resolved_link}; expected {resolved_target}")


def _ensure_node_modules_layout(inputs: DevelopmentInputs) -> Path:
    """Keep pnpm's dependency trees as real directories in the RW workspace.

    PNPM manages two importer roots below the writable workspace.  A symlinked
    importer root makes PNPM resolve virtual-store writes through a non-
    directory path and fail with ``ENOTDIR``; both roots therefore remain real
    directories owned by PNPM.
    """

    workspace_node_modules = inputs.workspace_root / "node_modules"
    _ensure_directory(workspace_node_modules, "workspace node_modules")
    app_root = inputs.workspace_root / "apps" / "control-room"
    _assert_no_links(app_root, "Control Room app root")
    _ensure_directory(app_root / "node_modules", "Control Room node_modules")
    return workspace_node_modules


def _require_real_directory(path: Path, name: str) -> None:
    """Check a state directory without creating or repairing it."""

    _path_without_parent(path, name)
    _assert_no_links(path, name)
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise FrontendDevError(f"{name} is missing: {path}") from error
    except OSError as error:
        raise FrontendDevError(f"cannot inspect {name}: {error}") from error
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        _fail(f"{name} is not a real directory: {path}")
    if bool(getattr(metadata, "st_file_attributes", 0) & 0x400):
        _fail(f"{name} is a reparse point: {path}")


def _validate_managed_link(link: Path, target: Path, name: str) -> None:
    """Validate one managed alias without creating, replacing, or pruning it."""

    _path_without_parent(link, name)
    _assert_no_links(link.parent, f"{name} parent")
    _assert_no_links(target, f"{name} target")
    try:
        metadata = link.lstat()
    except FileNotFoundError as error:
        raise FrontendDevError(f"managed frontend link is missing: {link}") from error
    except OSError as error:
        raise FrontendDevError(f"cannot inspect managed frontend link {name}: {error}") from error
    if not stat.S_ISLNK(metadata.st_mode):
        _fail(f"managed frontend path is not a symlink: {link}")
    try:
        resolved_link = link.resolve(strict=True)
        resolved_target = target.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        _fail(f"cannot resolve managed frontend link {name}: {error}")
    if resolved_link != resolved_target:
        _fail(f"managed frontend link mismatch: {link} -> {resolved_link}; expected {resolved_target}")


def _validate_managed_frontend_layout(inputs: DevelopmentInputs) -> None:
    """Check the immutable cache aliases and PNPM directories during polling."""

    if inputs.frontend_root != FRONTEND_ROOT:
        _fail("frontend cache root is not canonical")
    _require_real_directory(FRONTEND_ROOT, "frontend cache root")
    for relative in ("out", "next/default", f"next/dev-{INTERNAL_PORT}"):
        _require_real_directory(FRONTEND_ROOT / relative, f"frontend cache {relative}")

    app_root = inputs.workspace_root / "apps" / "control-room"
    _assert_no_links(app_root, "Control Room app root")
    _require_real_directory(inputs.workspace_root / "node_modules", "workspace node_modules")
    _require_real_directory(app_root / "node_modules", "Control Room node_modules")
    _validate_managed_link(
        app_root / ".fullmag-frontend", FRONTEND_ROOT, "frontend root"
    )
    _validate_managed_link(app_root / "out", FRONTEND_ROOT / "out", "static output")
    _validate_managed_link(
        app_root / ".next", FRONTEND_ROOT / "next" / "default", "default Next cache"
    )
    _validate_managed_link(
        app_root / NEXT_DIST_DIR,
        FRONTEND_ROOT / "next" / f"dev-{INTERNAL_PORT}",
        "development Next cache",
    )


def _prepare_managed_frontend(inputs: DevelopmentInputs) -> Path:
    app_root = inputs.workspace_root / "apps" / "control-room"
    _assert_no_links(app_root, "Control Room app root")
    _ensure_cache_layout(inputs)
    _ensure_managed_link(app_root / ".fullmag-frontend", FRONTEND_ROOT, "frontend root")
    _ensure_managed_link(app_root / "out", FRONTEND_ROOT / "out", "static output")
    _ensure_managed_link(app_root / ".next", FRONTEND_ROOT / "next" / "default", "default Next cache")
    _ensure_managed_link(
        app_root / NEXT_DIST_DIR,
        FRONTEND_ROOT / "next" / f"dev-{INTERNAL_PORT}",
        "development Next cache",
    )
    return _ensure_node_modules_layout(inputs)


def _validate_live_directories(inputs: DevelopmentInputs) -> None:
    if tuple(sorted(inputs.live_directories)) != tuple(sorted(LIVE_DIRECTORY_NAMES)):
        _fail("live directory contract changed")
    app_root = inputs.workspace_root / "apps" / "control-room"
    _assert_no_links(app_root, "Control Room app root")
    for name in LIVE_DIRECTORY_NAMES:
        path = app_root / name
        _assert_no_links(path, f"read-only live directory {name}")
        try:
            metadata = path.lstat()
        except FileNotFoundError as error:
            raise FrontendDevError(f"read-only live directory is missing: {name}") from error
        if not stat.S_ISDIR(metadata.st_mode):
            _fail(f"read-only live directory is not a directory: {name}")


def _tool_version(
    executable: Path,
    expected: str,
    name: str,
    *,
    cwd: Path | None = None,
    environment: Mapping[str, str] | None = None,
) -> str:
    if not executable.is_file() or not os.access(executable, os.X_OK):
        _fail(f"pinned {name} executable is missing or not executable: {executable}")
    try:
        result = subprocess.run(
            [str(executable), "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(cwd) if cwd is not None else None,
            env=dict(environment) if environment is not None else None,
            text=True,
            timeout=TOOL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        _fail(f"pinned {name} version probe failed: {error}")
    version = result.stdout.strip()
    if result.returncode != 0 or not version:
        _fail(f"pinned {name} version probe returned {version!r}")
    if version != expected:
        _fail(f"pinned {name} version is {version!r}; expected {expected!r}")
    return version


def _safe_environment(inputs: DevelopmentInputs) -> dict[str, str]:
    browser_origin = f"http://localhost:{inputs.host_port}"
    environment = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(HOME_ROOT),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "NODE_ENV": "development",
        "FULLMAG_DOCKER_FRONTEND": "dev",
        "FULLMAG_FRONTEND_ROOT": str(FRONTEND_ROOT),
        "FULLMAG_NEXT_DIST_DIR": NEXT_DIST_DIR,
        "WATCHPACK_POLLING": "500",
        "FULLMAG_API_PROXY_TARGET": API_PROXY_TARGET,
        "FULLMAG_API_URL": API_PROXY_TARGET,
        "FULLMAG_WEB_PUBLIC_HOST": "localhost",
        "FULLMAG_WEB_PUBLIC_PORT": str(inputs.host_port),
        "NEXT_PUBLIC_API_URL": browser_origin,
        "NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL": browser_origin,
        "NEXT_PUBLIC_FULLMAG_API_URL": browser_origin,
        "NEXT_PUBLIC_RUNTIME_HTTP_BASE": browser_origin,
        "PNPM_HOME": str(PNPM_HOME),
        "COREPACK_HOME": str(COREPACK_HOME),
        # Keep Corepack on the exact packageManager selected by the seeded
        # workspace and prevent an interactive/latest-version detour.
        "COREPACK_ENABLE_PROJECT_SPEC": "1",
        "COREPACK_DEFAULT_TO_LATEST": "0",
        "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
        "npm_config_store_dir": str(PNPM_STORE_ROOT),
        "TMPDIR": str(TEMP_ROOT),
        "TEMP": str(TEMP_ROOT),
        "TMP": str(TEMP_ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    for name in ("NO_COLOR", "CI"):
        value = os.environ.get(name)
        if value:
            environment[name] = value
    return environment


def _receipt_base(inputs: DevelopmentInputs, previous: Mapping[str, Any] | None) -> dict[str, Any]:
    receipt: dict[str, Any] = {
        "schema": RECEIPT_SCHEMA,
        "source_root": inputs.source_root,
        "source_commit": inputs.source_commit,
        "host_port": inputs.host_port,
        "workspace_root": str(WORKSPACE_ROOT),
        "frontend_root": str(FRONTEND_ROOT),
        "inputs_manifest_digest": inputs.manifest_digest,
        "internal_port": INTERNAL_PORT,
        "next_dist_dir": NEXT_DIST_DIR,
        "api_proxy_target": API_PROXY_TARGET,
        "live_directories": list(LIVE_DIRECTORY_NAMES),
        "generated_paths": sorted(GENERATED_RELATIVES),
        "log_path": str(LOG_PATH),
        "tool_probe_timeout_seconds": TOOL_TIMEOUT_SECONDS,
    }
    failure = _receipt_failure(previous)
    if failure is not None:
        receipt["previous_failure_evidence"] = failure
    return receipt


def _publish_receipt(receipt: Mapping[str, Any]) -> None:
    _atomic_json(RECEIPT_PATH, dict(receipt), "frontend development receipt")


def _log_stream() -> Any:
    _ensure_directory(DEVELOPMENT_ROOT, "development root")
    descriptor: int | None = None
    try:
        _assert_no_links(LOG_PATH.parent, "frontend development log parent")
        descriptor = os.open(
            LOG_PATH,
            os.O_WRONLY
            | os.O_APPEND
            | os.O_CREAT
            | getattr(os, "O_NOFOLLOW", 0),
            0o660,
        )
        return os.fdopen(descriptor, "ab")
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        _fail(f"cannot open frontend development log: {error}")


def _run_pnpm_install(
    inputs: DevelopmentInputs,
    stopping_event: Any,
    log_stream: Any,
    receipt: dict[str, Any],
) -> None:
    app_root = inputs.workspace_root / "apps" / "control-room"
    environment = _safe_environment(inputs)
    command = [
        str(PNPM_BINARY),
        "--dir",
        str(app_root),
        "install",
        "--frozen-lockfile",
        "--store-dir",
        str(PNPM_STORE_ROOT),
    ]
    receipt.update(state="installing", dependency_install="initial-frozen-pnpm", command=command)
    _publish_receipt(receipt)
    try:
        process = subprocess.Popen(
            command,
            cwd=str(inputs.workspace_root),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=log_stream,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as error:
        _fail(f"frozen pnpm install could not start: {error}")
    try:
        install_handle = _new_handle(process, inputs, stopping_event, "pnpm-install", log_stream)
    except Exception as error:
        owned_handle = getattr(error, "frontend_handle", None)
        if isinstance(owned_handle, FrontendHandle):
            _record_handle_identity(receipt, owned_handle)
            try:
                _publish_receipt(receipt)
            except Exception:
                pass
        raise
    _record_handle_identity(receipt, install_handle)
    try:
        _publish_receipt(receipt)
    except Exception as error:
        _attach_frontend_handle(error, install_handle)
        raise
    deadline = time.monotonic() + INSTALL_TIMEOUT_SECONDS
    try:
        while True:
            returncode = process.poll()
            if returncode is not None:
                if returncode != 0:
                    _fail(f"frozen pnpm install failed with exit code {returncode}")
                if install_handle.process_group_id is None:
                    error = FrontendDevUnknown(
                        "pnpm install exited before its process group could be authenticated"
                    )
                    _attach_frontend_handle(error, install_handle)
                    raise error
                try:
                    group_empty = _wait_for_group_empty(
                        install_handle.process_group_id, STOP_TIMEOUT_SECONDS
                    )
                except FrontendDevUnknown as error:
                    _attach_frontend_handle(error, install_handle)
                    raise
                if not group_empty:
                    error = FrontendDevUnknown(
                        "pnpm install left a live child in its process group"
                    )
                    _attach_frontend_handle(error, install_handle)
                    raise error
                return
            if getattr(stopping_event, "is_set", lambda: False)():
                try:
                    _request_group_shutdown(install_handle, STOP_TIMEOUT_SECONDS)
                except FrontendDevUnknown as error:
                    _attach_frontend_handle(error, install_handle)
                    raise FrontendDevUnknown(
                        "pnpm install did not stop within the bounded shutdown window"
                    ) from error
                raise FrontendDevUnknown("frontend start was cancelled during pnpm install")
            if time.monotonic() >= deadline:
                try:
                    _request_group_shutdown(install_handle, STOP_TIMEOUT_SECONDS)
                except FrontendDevUnknown as shutdown_error:
                    _attach_frontend_handle(shutdown_error, install_handle)
                    raise
                error = FrontendDevUnknown("pnpm install exceeded its bounded startup timeout")
                _attach_frontend_handle(error, install_handle)
                raise error
            time.sleep(0.1)
    except Exception as error:
        _attach_frontend_handle(error, install_handle)
        raise


def _next_binary(inputs: DevelopmentInputs) -> Path:
    app_root = inputs.workspace_root / "apps" / "control-room"
    binary = app_root / NEXT_RELATIVE
    try:
        resolved = binary.resolve(strict=True)
    except FileNotFoundError as error:
        raise FrontendDevError(f"Next binary is missing after frozen install: {binary}") from error
    # ``next`` is a JavaScript entrypoint passed to the pinned Node binary.  It
    # must be a regular file below the state-owned dependency tree; the file
    # itself need not carry an executable bit.
    if not resolved.is_file():
        _fail("Next binary is not a regular file")
    if not _is_within(resolved, inputs.workspace_root / "node_modules"):
        _fail("Next binary resolves outside workspace node_modules")
    return binary


def _attach_frontend_handle(error: Exception, handle: FrontendHandle) -> None:
    setattr(error, "frontend_handle", handle)


def _new_handle(
    process: subprocess.Popen[Any],
    inputs: DevelopmentInputs,
    stopping_event: Any,
    kind: str,
    log_stream: Any,
) -> FrontendHandle:
    handle = FrontendHandle(
        process=process,
        inputs=inputs,
        stopping_event=stopping_event,
        kind=kind,
        pid=process.pid,
        owner_token=str(uuid.uuid4()),
        log_path=LOG_PATH,
        log_stream=log_stream,
    )
    try:
        identity = _read_process_identity(process.pid)
    except Exception as error:
        _attach_frontend_handle(error, handle)
        raise
    if identity is None:
        if process.poll() is None:
            error = FrontendDevUnknown(
                f"cannot establish the owned {kind} process identity for pid {process.pid}"
            )
            _attach_frontend_handle(error, handle)
            raise error
        return handle
    if identity["session_id"] != process.pid or identity["process_group_id"] != process.pid:
        error = FrontendDevUnknown(
            f"owned {kind} process did not create its expected private process group"
        )
        _attach_frontend_handle(error, handle)
        raise error
    handle.process_identity = identity
    handle.process_group_id = identity["process_group_id"]
    return handle


def _record_handle_identity(receipt: dict[str, Any], handle: FrontendHandle) -> None:
    receipt.update(pid=handle.pid, owner_token=handle.owner_token)
    if handle.process_identity is None:
        return
    receipt["process_identity_schema"] = "linux-proc-v1"
    for field in PROCESS_IDENTITY_FIELDS:
        receipt[field] = handle.process_identity[field]


def _confirmed_live_identity(handle: FrontendHandle) -> dict[str, Any]:
    expected = _validated_process_identity(handle.process_identity)
    process_group_id = handle.process_group_id
    if expected is None or process_group_id is None:
        raise FrontendDevUnknown("frontend process identity or process group is unavailable")
    observed = _read_process_identity(handle.pid)
    if observed is None or not _identity_matches(expected, observed):
        raise FrontendDevUnknown("frontend process identity changed or disappeared")
    if observed["process_group_id"] != process_group_id or observed["session_id"] != process_group_id:
        raise FrontendDevUnknown("frontend process group identity changed")
    if handle.process.poll() is not None:
        raise FrontendDevUnknown("frontend process exited before its shutdown signal was sent")
    return observed


def _group_empty(process_group_id: Any) -> bool:
    if isinstance(process_group_id, bool) or not isinstance(process_group_id, int) or process_group_id <= 0:
        raise FrontendDevUnknown("frontend process group identity is invalid")
    killpg = getattr(os, "killpg", None)
    if not callable(killpg):
        raise FrontendDevUnknown("frontend process group supervision is unavailable")
    try:
        killpg(process_group_id, 0)
    except ProcessLookupError:
        return True
    except OSError as error:
        if error.errno == errno.ESRCH:
            return True
        raise FrontendDevUnknown(
            f"cannot prove frontend process group {process_group_id} is empty: {error}"
        ) from error
    return False


def _wait_for_group_empty(process_group_id: int, timeout: float) -> bool:
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        if _group_empty(process_group_id):
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(0.05, remaining))


def _request_group_shutdown(handle: FrontendHandle, timeout: float) -> int | None:
    """Signal and reap an owned process group without force-killing it."""

    _confirmed_live_identity(handle)
    process_group_id = handle.process_group_id
    assert process_group_id is not None
    try:
        os.killpg(process_group_id, signal.SIGTERM)
    except OSError as error:
        raise FrontendDevUnknown(f"cannot request frontend group shutdown: {error}") from error
    try:
        returncode = handle.process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise FrontendDevUnknown(
            "frontend process did not exit within the bounded shutdown window"
        ) from error
    if not _wait_for_group_empty(process_group_id, timeout):
        raise FrontendDevUnknown(
            "frontend process group did not become empty within the bounded shutdown window"
        )
    return returncode


def _assert_not_stopping(stopping_event: Any) -> None:
    if getattr(stopping_event, "is_set", lambda: False)():
        raise FrontendDevUnknown("frontend startup was cancelled during shutdown")


def _start_next(
    inputs: DevelopmentInputs,
    stopping_event: Any,
    log_stream: Any,
    receipt: dict[str, Any],
) -> FrontendHandle:
    _next_binary(inputs)
    app_root = inputs.workspace_root / "apps" / "control-room"
    command = [
        str(NODE_BINARY),
        str(NEXT_RELATIVE),
        "dev",
        "--webpack",
        "--hostname",
        "0.0.0.0",
        "--port",
        str(INTERNAL_PORT),
    ]
    environment = _safe_environment(inputs)
    try:
        process = subprocess.Popen(
            command,
            cwd=str(app_root),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=log_stream,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as error:
        _fail(f"Next development process could not start: {error}")
    try:
        handle = _new_handle(process, inputs, stopping_event, "next", log_stream)
    except Exception as error:
        owned_handle = getattr(error, "frontend_handle", None)
        if isinstance(owned_handle, FrontendHandle):
            _record_handle_identity(receipt, owned_handle)
            try:
                _publish_receipt(receipt)
            except Exception:
                pass
        raise
    receipt.update(
        state="running",
        command=command,
        dependency_install="ready",
        generated_files_gate="next-started-v1",
    )
    _record_handle_identity(receipt, handle)
    try:
        _publish_receipt(receipt)
    except Exception as error:
        _attach_frontend_handle(error, handle)
        raise
    return handle


def start(stopping_event: Any) -> FrontendHandle:
    """Validate the frozen seed, install Linux dependencies once, and spawn Next."""

    if not enabled():
        _fail("Docker frontend development is disabled")
    if stopping_event is None or not hasattr(stopping_event, "is_set"):
        _fail("frontend development requires a stopping event")
    if stopping_event.is_set():
        _fail("frontend development cannot start after shutdown was requested")
    inputs = read_inputs()
    previous = _load_receipt()
    _reject_existing_owner(previous)
    allow_generated = _generated_gate(previous)
    _prepare_state_directories()
    _validate_live_directories(inputs)
    _freeze_inputs(inputs, allow_generated=allow_generated)
    node_modules_target = _prepare_managed_frontend(inputs)
    tool_environment = _safe_environment(inputs)
    receipt = _receipt_base(inputs, previous)
    receipt.update(
        state="starting",
        dependency_root=str(node_modules_target),
        generated_files_gate=("next-started-v1" if allow_generated else "seed-only-v1"),
    )
    _publish_receipt(receipt)
    try:
        node_version = _tool_version(
            NODE_BINARY,
            EXPECTED_NODE_VERSION,
            "Node",
            cwd=inputs.workspace_root,
            environment=tool_environment,
        )
        receipt["tool_versions"] = {"node": node_version}
        _publish_receipt(receipt)
        _assert_not_stopping(stopping_event)
        pnpm_version = _tool_version(
            PNPM_BINARY,
            EXPECTED_PNPM_VERSION,
            "pnpm",
            cwd=inputs.workspace_root,
            environment=tool_environment,
        )
        receipt["tool_versions"]["pnpm"] = pnpm_version
        _publish_receipt(receipt)
        _assert_not_stopping(stopping_event)
    except Exception as error:
        receipt.update(
            state=("unknown" if isinstance(error, FrontendDevUnknown) else "failed"),
            error=str(error),
            failure_evidence={"kind": "tool-version-probe", "message": str(error)},
        )
        try:
            _publish_receipt(receipt)
        except Exception:
            pass
        raise
    log_stream = _log_stream()
    handle: FrontendHandle | None = None
    try:
        if previous is None or previous.get("dependency_install") != "ready":
            _run_pnpm_install(inputs, stopping_event, log_stream, receipt)
            # pnpm owns the real dependency directories below the writable
            # workspace. Re-validate that layout before resolving Next so a
            # package-manager change cannot redirect execution into the
            # Windows source mount.
            _prepare_managed_frontend(inputs)
        _assert_not_stopping(stopping_event)
        _next_binary(inputs)
        _assert_not_stopping(stopping_event)
        handle = _start_next(inputs, stopping_event, log_stream, receipt)
        return handle
    except Exception as error:
        owned_handle = handle or getattr(error, "frontend_handle", None)
        if isinstance(owned_handle, FrontendHandle):
            _attach_frontend_handle(error, owned_handle)
        try:
            receipt.update(
                state=("unknown" if isinstance(error, FrontendDevUnknown) else "failed"),
                error=str(error),
                failure_evidence={"kind": "frontend-start", "message": str(error)},
            )
            _publish_receipt(receipt)
        except Exception:
            pass
        if not isinstance(owned_handle, FrontendHandle):
            log_stream.close()
        raise


def check(handle: FrontendHandle) -> None:
    """Check the owned child and immutable dependency/configuration boundary."""

    if not isinstance(handle, FrontendHandle) or handle.kind != "next":
        _fail("frontend handle is not an owned Next process")
    if (
        isinstance(handle.pid, bool)
        or not isinstance(handle.pid, int)
        or handle.process.pid != handle.pid
        or handle.pid <= 0
    ):
        _fail("frontend handle process identity is invalid")
    receipt = _load_receipt()
    if receipt is None:
        _fail("frontend development receipt is missing for the owned Next process")
    if receipt.get("pid") != handle.pid or receipt.get("owner_token") != handle.owner_token:
        _fail("frontend development receipt belongs to a different process")
    allow_generated = _generated_gate(receipt)
    try:
        current = read_inputs()
        if current.manifest_digest != handle.inputs.manifest_digest:
            _fail("Docker development input manifest changed; restart requires a new seed")
        _validate_live_directories(current)
        _validate_managed_frontend_layout(current)
        _freeze_inputs(current, allow_generated=allow_generated)
    except Exception as error:
        if receipt is not None:
            receipt.update(
                state="failed",
                error=str(error),
                failure_evidence={"kind": "frontend-input-change", "message": str(error)},
            )
            _publish_receipt(receipt)
        raise
    returncode = handle.process.poll()
    if returncode is None:
        try:
            observed = _confirmed_live_identity(handle)
            recorded_identity = _receipt_process_identity(receipt)
            if recorded_identity is None or not _identity_matches(recorded_identity, observed):
                raise FrontendDevUnknown("frontend receipt process identity no longer matches")
        except FrontendDevUnknown as error:
            receipt.update(
                state="unknown",
                error=str(error),
                failure_evidence={"kind": "frontend-owner-identity", "message": str(error)},
            )
            try:
                _publish_receipt(receipt)
            except Exception as publish_error:
                raise FrontendDevUnknown(
                    f"{error}; publishing unknown owner receipt failed: {publish_error}"
                ) from publish_error
            raise
        return
    if receipt is None:
        receipt = _receipt_base(handle.inputs, None)
    receipt.update(
        state="failed",
        exit_code=returncode,
        error=f"Next development process exited with code {returncode}",
        failure_evidence={"kind": "child-exit", "exit_code": returncode},
    )
    _publish_receipt(receipt)
    raise FrontendDevError(f"Next development process exited with code {returncode}")


def _raise_stop_unknown(
    receipt: dict[str, Any],
    state: str,
    message: str,
    evidence: Mapping[str, Any],
    *,
    cause: BaseException | None = None,
) -> NoReturn:
    receipt.update(state=state, error=message, failure_evidence=dict(evidence))
    try:
        _publish_receipt(receipt)
    except Exception as publish_error:
        raise FrontendDevUnknown(
            f"{message}; publishing shutdown receipt failed: {publish_error}"
        ) from publish_error
    error = FrontendDevUnknown(message)
    if cause is not None:
        raise error from cause
    raise error


def stop(handle: FrontendHandle, *, timeout: float = STOP_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Stop only the owned process group; never force-kill or prune."""

    if not isinstance(handle, FrontendHandle):
        _fail("frontend stop requires an owned frontend handle")
    if (
        isinstance(handle.pid, bool)
        or not isinstance(handle.pid, int)
        or handle.process.pid != handle.pid
        or handle.pid <= 0
    ):
        _fail("frontend handle process identity is invalid")
    if not 1 <= timeout <= 60:
        _fail("frontend stop timeout must be between 1 and 60 seconds")
    if handle.stopped:
        return _load_receipt() or {"schema": RECEIPT_SCHEMA, "state": "stopped"}

    receipt = _load_receipt() or _receipt_base(handle.inputs, None)
    recorded_pid = receipt.get("pid")
    recorded_owner = receipt.get("owner_token")
    if recorded_pid is not None and recorded_pid != handle.pid:
        _fail("frontend receipt belongs to a different process")
    if recorded_owner is not None and recorded_owner != handle.owner_token:
        _fail("frontend receipt belongs to a different owner")
    recorded_identity = _receipt_process_identity(receipt)
    handle_identity = _validated_process_identity(handle.process_identity)
    if (
        recorded_identity is None
        or handle_identity is None
        or not _identity_matches(recorded_identity, handle_identity)
    ):
        _raise_stop_unknown(
            receipt,
            "stop-unknown",
            "frontend owner identity is not fully authenticated; recovery is required",
            {"kind": "owner-identity-unconfirmed", "pid": handle.pid},
        )
    if handle.process_group_id != handle_identity["process_group_id"]:
        _raise_stop_unknown(
            receipt,
            "stop-unknown",
            "frontend process group identity is not authenticated; recovery is required",
            {"kind": "process-group-unconfirmed", "pid": handle.pid},
        )

    previous_state = receipt.get("state")
    previous_failure = receipt.get("failure_evidence")
    had_failure = previous_failure is not None or previous_state in {
        "failed",
        "unknown",
        "stop-unknown",
        "stop-timeout",
        "stopped-after-failure",
    }
    returncode = handle.process.poll()
    was_running = returncode is None
    if was_running:
        try:
            observed = _confirmed_live_identity(handle)
        except FrontendDevUnknown as error:
            _raise_stop_unknown(
                receipt,
                "stop-unknown",
                str(error),
                {"kind": "owner-identity-unconfirmed", "pid": handle.pid},
                cause=error,
            )
        if not _identity_matches(recorded_identity, observed):
            _raise_stop_unknown(
                receipt,
                "stop-unknown",
                "frontend receipt owner identity changed before shutdown",
                {"kind": "owner-identity-changed", "pid": handle.pid},
            )

    _record_handle_identity(receipt, handle)
    receipt.update(state="stopping")
    _publish_receipt(receipt)
    deadline = time.monotonic() + timeout
    process_group_id = handle.process_group_id
    assert process_group_id is not None
    if was_running:
        try:
            os.killpg(process_group_id, signal.SIGTERM)
        except OSError as error:
            _raise_stop_unknown(
                receipt,
                "stop-unknown",
                f"cannot request frontend process-group shutdown: {error}",
                {"kind": "group-signal-failed", "pid": handle.pid, "process_group_id": process_group_id},
                cause=error,
            )
        remaining = max(0.0, deadline - time.monotonic())
        try:
            returncode = handle.process.wait(timeout=remaining)
        except subprocess.TimeoutExpired as error:
            _raise_stop_unknown(
                receipt,
                "stop-timeout",
                "frontend process did not exit within the bounded shutdown window",
                {"kind": "shutdown-timeout", "pid": handle.pid},
                cause=error,
            )
    remaining = max(0.0, deadline - time.monotonic())
    try:
        group_empty = _wait_for_group_empty(process_group_id, remaining)
    except FrontendDevUnknown as error:
        _raise_stop_unknown(
            receipt,
            "stop-unknown",
            str(error),
            {"kind": "group-observation-unknown", "pid": handle.pid, "process_group_id": process_group_id},
            cause=error,
        )
    if not group_empty:
        _raise_stop_unknown(
            receipt,
            "stop-timeout",
            "frontend process group did not become empty within the bounded shutdown window",
            {"kind": "group-not-empty", "pid": handle.pid, "process_group_id": process_group_id},
        )

    handle.stopped = True
    if handle.log_stream is not None:
        handle.log_stream.close()
        handle.log_stream = None
    if had_failure or (not was_running and returncode not in (None, 0)):
        receipt.update(
            state="stopped-after-failure",
            exit_code=returncode,
            stopped_at=time.time(),
            failure_evidence=previous_failure
            or {"kind": "child-exit-before-stop", "exit_code": returncode},
        )
    else:
        receipt.update(state="stopped", exit_code=returncode, stopped_at=time.time())
    _publish_receipt(receipt)
    return receipt


__all__ = [
    "DevelopmentInputs",
    "FrontendDevError",
    "FrontendDevUnknown",
    "FrontendHandle",
    "enabled",
    "read_inputs",
    "start",
    "check",
    "stop",
]
