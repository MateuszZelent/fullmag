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

Persistent frontend state, logs, diagnostic receipts, frozen input bytes, and
Linux dependencies stay below ``/state/development``.  The current process
owner receipt is deliberately ephemeral at ``/run/fullmag/frontend-owner``;
there is no cache pruning or unbounded operator supplied path.
"""
from __future__ import annotations

import dataclasses
import errno
try:
    import fcntl
except ImportError:  # pragma: no cover - the managed frontend runs on Linux
    fcntl = None
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import subprocess
import sys
import threading
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

# The manifest is control-plane metadata shared by the two application
# services.  It lives in the frontend namespace of the per-group named control
# volume; dependency trees, Next output, logs and receipts remain below the
# frontend state volume.
FRONTEND_CONTROL_ROOT = Path(
    os.environ.get("FULLMAG_FRONTEND_CONTROL_ROOT", "/opt/fullmag/control/frontend")
)
FRONTEND_CACHE_KEY = os.environ.get("FULLMAG_FRONTEND_CACHE_KEY")
INPUTS_PATH = Path(
    os.environ.get(
        "FULLMAG_DEVELOPMENT_INPUTS_PATH",
        str(FRONTEND_CONTROL_ROOT / "development-inputs.json"),
    )
)
DEVELOPMENT_ROOT = Path("/state/development")
OWNER_ROOT = Path("/run/fullmag/frontend-owner")
WORKSPACE_ROOT = DEVELOPMENT_ROOT / "workspace"
FRONTEND_ROOT = DEVELOPMENT_ROOT / "cache"
PNPM_STORE_ROOT = DEVELOPMENT_ROOT / "pnpm-store"
PNPM_HOME = DEVELOPMENT_ROOT / "pnpm-home"
COREPACK_HOME = DEVELOPMENT_ROOT / "corepack"
HOME_ROOT = DEVELOPMENT_ROOT / "home"
TEMP_ROOT = DEVELOPMENT_ROOT / "tmp"
FREEZE_ROOT = DEVELOPMENT_ROOT / "frozen-inputs"
FREEZE_PATH = DEVELOPMENT_ROOT / "inputs-freeze.json"
# The process-owner receipt is ephemeral per Docker container incarnation. The
# named-volume copy remains diagnostic/history input only and never authorizes a
# new process owner after the container has been recreated.
RECEIPT_PATH = OWNER_ROOT / "receipt.json"
DIAGNOSTIC_RECEIPT_PATH = DEVELOPMENT_ROOT / "frontend-dev-receipt.json"
LOG_PATH = DEVELOPMENT_ROOT / "next.log"
LOG_ROLLBACK_PATH = DEVELOPMENT_ROOT / "next.log.rollback"
MAX_LOG_BYTES = 64 * 1024 * 1024
RUNTIME_LOCK_PATH = FRONTEND_ROOT / ".fullmag-frontend-runtime.lock"

NODE_BINARY = Path("/usr/local/bin/node")
PNPM_BINARY = Path("/usr/local/bin/pnpm")
EXPECTED_NODE_VERSION = "v24.18.0"
EXPECTED_PNPM_VERSION = "10.8.1"

INTERNAL_PORT = 8080
API_PROXY_TARGET = "http://backend:8081"
NEXT_DIST_DIR = ".next-control-room-8080"
NEXT_RELATIVE = Path("node_modules/next/dist/bin/next")
INSPECTOR_SCHEMA = "fullmag.node-inspector.v1"
INSPECTOR_PROFILE = "next-dev"
INSPECTOR_BIND_HOST = "127.0.0.1"
INSPECTOR_BIND_PORT = 0
INSPECTOR_FLAG = f"--inspect={INSPECTOR_BIND_HOST}:{INSPECTOR_BIND_PORT}"
INSPECTOR_LOG_SCAN_BYTES = 64 * 1024
INSPECTOR_OUTPUT_RE = re.compile(
    rb"Debugger listening on (?P<address>ws://(?P<host>[^:/\s]+):(?P<port>[0-9]+)/(?P<target>[^\s]+))"
)
LIVE_DIRECTORY_NAMES = ("app", "src", "public", "scripts")
LIVE_DIRECTORY_PATHS = tuple(f"apps/control-room/{name}" for name in LIVE_DIRECTORY_NAMES)
# Vitest and the frontend smoke contracts execute from the writable workspace
# but read a small, explicit set of repository fixtures outside the live
# Control Room mount.  Keep these entries as symlinks into the readonly source
# bind: copying them would duplicate source data in the named volume and would
# make a stale fixture survive a checkout change.  The allowlist is deliberately
# explicit; no operator-supplied source-relative path is accepted.
SOURCE_CONTAINER_ROOT = Path("/opt/fullmag/source")
READONLY_SOURCE_FIXTURES = (
    (".github", "directory"),
    ("crates", "directory"),
    ("docker", "directory"),
    ("docs", "directory"),
    ("examples", "directory"),
    ("packages", "directory"),
    ("public_docs", "directory"),
    ("scripts", "directory"),
    ("justfile", "file"),
    ("readme.md", "file"),
)
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
    {
        "source_selection", "source_volume", "configuration_changes", "backend_build",
        "worktree_id", "dependency_seed_files", "dependency_seed_sha256",
        "toolpins", "toolpins_sha256",
        "frontend_cache_key",
    }
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
INSTALL_TIMEOUT_SECONDS = 60 * 60
# The pinned pnpm executable can pay cold filesystem and initialization I/O on
# its first invocation. Keep that probe bounded without making a healthy cold
# container fail during ordinary startup latency.
TOOL_TIMEOUT_SECONDS = 120
STOP_TIMEOUT_SECONDS = 15
LOG_TAIL_CHUNK_BYTES = 8 * 1024
LOG_TAIL_POLL_SECONDS = 0.25
LOG_TAIL_STOP_TIMEOUT_SECONDS = 1.0
WATCHPACK_POLLING_ENV = "FULLMAG_WATCHPACK_POLLING_MS"
# Docker Desktop's Windows source mount pays a metadata round trip for each
# Watchpack poll. Five seconds bounds overlapping scans while keeping the HMR
# latency explicit; operators can provide a validated workspace override.
WATCHPACK_POLLING_DEFAULT_MS = 5000
WATCHPACK_POLLING_MIN_MS = 250
WATCHPACK_POLLING_MAX_MS = 10000
NODE_FS_THREADS_ENV = "UV_THREADPOOL_SIZE"
# Keep asynchronous filesystem work bounded for the two-CPU frontend.  The
# live Windows source mount is backed by Docker Desktop's 9p bridge, where a
# large libuv pool turns metadata latency into host kernel contention instead
# of improving cold compilation.
NODE_FS_THREADS = 8
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
    log_tailer: Any | None = None
    runtime_lock: Any | None = None
    stopped: bool = False
    process_group_id: int | None = None
    process_identity: Mapping[str, Any] | None = None
    inspector_log_offset: int | None = None


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


def _validate_control_volume_contract() -> None:
    """Require the launcher-provided cache-key namespace when v2 is active."""

    if FRONTEND_CACHE_KEY is None:
        # Unit tests and the legacy direct Python adapter do not have the
        # Compose resolver's identity environment.  The production Compose
        # overlay requires it, so keeping this compatibility path does not
        # create a shared manifest in the active v2 route.
        return
    if not HEX64.fullmatch(FRONTEND_CACHE_KEY):
        _fail("FULLMAG_FRONTEND_CACHE_KEY must be a lowercase SHA-256")
    expected_root = Path("/opt/fullmag/control") / FRONTEND_CACHE_KEY
    expected_inputs = expected_root / "development-inputs.json"
    if FRONTEND_CONTROL_ROOT != expected_root:
        _fail(
            "FULLMAG_FRONTEND_CONTROL_ROOT must be the cache-key namespace "
            f"{expected_root}"
        )
    if INPUTS_PATH != expected_inputs:
        _fail(
            "FULLMAG_DEVELOPMENT_INPUTS_PATH must be the cache-key manifest "
            f"{expected_inputs}"
        )


def _source_container_root() -> Path:
    """Return the fixed readonly checkout mount used by frontend fixtures."""

    raw = os.environ.get("FULLMAG_FRONTEND_SOURCE_CONTAINER_ROOT", str(SOURCE_CONTAINER_ROOT))
    source = Path(raw)
    if source != SOURCE_CONTAINER_ROOT:
        _fail(
            "FULLMAG_FRONTEND_SOURCE_CONTAINER_ROOT must be the fixed readonly "
            f"source mount {SOURCE_CONTAINER_ROOT}"
        )
    _path_without_parent(source, "frontend source mount")
    try:
        metadata = source.lstat()
    except FileNotFoundError as error:
        raise FrontendDevError(f"frontend source mount is missing: {source}") from error
    except OSError as error:
        raise FrontendDevError(f"cannot inspect frontend source mount: {error}") from error
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        _fail("frontend source mount must be a real directory")
    return source


def _ensure_readonly_source_fixture_links(
    source: Path, workspace: Path | None = None
) -> tuple[str, ...]:
    """Expose allowlisted source fixtures in the named workspace by exact links.

    The helper only creates links below ``workspace``.  It never copies or
    modifies source bytes, and it refuses a pre-existing directory/file or a
    link whose target is not the exact allowlisted path.
    """

    source = _path_without_parent(Path(source), "frontend source mount")
    if workspace is None:
        workspace = WORKSPACE_ROOT
    workspace = _path_without_parent(Path(workspace), "frontend workspace")
    try:
        source_metadata = source.lstat()
        workspace_metadata = workspace.lstat()
    except FileNotFoundError as error:
        raise FrontendDevError("frontend source mount or workspace is missing") from error
    except OSError as error:
        raise FrontendDevError(f"cannot inspect frontend fixture roots: {error}") from error
    if not stat.S_ISDIR(source_metadata.st_mode) or stat.S_ISLNK(source_metadata.st_mode):
        _fail("frontend source mount must be a real directory")
    if not stat.S_ISDIR(workspace_metadata.st_mode) or stat.S_ISLNK(workspace_metadata.st_mode):
        _fail("frontend workspace must be a real named-volume directory")
    source_resolved = source.resolve(strict=True)

    linked: list[str] = []
    for relative, kind in READONLY_SOURCE_FIXTURES:
        source_path = source / relative
        destination = workspace / relative
        try:
            source_metadata = source_path.lstat()
        except FileNotFoundError as error:
            raise FrontendDevError(
                f"required frontend source fixture is missing: {relative}"
            ) from error
        except OSError as error:
            raise FrontendDevError(
                f"cannot inspect frontend source fixture {relative}: {error}"
            ) from error
        if stat.S_ISLNK(source_metadata.st_mode):
            _fail(f"frontend source fixture may not be a symlink: {relative}")
        if kind == "directory" and not stat.S_ISDIR(source_metadata.st_mode):
            _fail(f"frontend source fixture is not a directory: {relative}")
        if kind == "file" and not stat.S_ISREG(source_metadata.st_mode):
            _fail(f"frontend source fixture is not a regular file: {relative}")
        try:
            resolved_source = source_path.resolve(strict=True)
            resolved_source.relative_to(source_resolved)
        except (OSError, RuntimeError, ValueError) as error:
            raise FrontendDevError(
                f"frontend source fixture escapes the readonly source mount: {relative}"
            ) from error
        if resolved_source != source_path:
            _fail(f"frontend source fixture resolves through a link: {relative}")

        parent = destination.parent
        _path_without_parent(parent, f"frontend fixture parent {relative}")
        try:
            parent_metadata = parent.lstat()
        except FileNotFoundError as error:
            raise FrontendDevError(
                f"frontend fixture parent is missing: {parent}"
            ) from error
        if not stat.S_ISDIR(parent_metadata.st_mode) or stat.S_ISLNK(parent_metadata.st_mode):
            _fail(f"frontend fixture parent is not a real directory: {parent}")
        try:
            existing = destination.lstat()
        except FileNotFoundError:
            existing = None
        except OSError as error:
            raise FrontendDevError(
                f"cannot inspect frontend fixture destination {relative}: {error}"
            ) from error
        expected_target = str(source_path)
        if existing is None:
            try:
                destination.symlink_to(expected_target, target_is_directory=(kind == "directory"))
            except OSError as error:
                raise FrontendDevError(
                    f"cannot create readonly frontend fixture link {relative}: {error}"
                ) from error
            existing = destination.lstat()
        if not stat.S_ISLNK(existing.st_mode):
            _fail(
                f"frontend fixture destination must remain a readonly source link: {relative}"
            )
        try:
            actual_target = os.readlink(destination)
        except OSError as error:
            raise FrontendDevError(
                f"cannot read frontend fixture link {relative}: {error}"
            ) from error
        if actual_target != expected_target:
            _fail(
                f"frontend fixture link target differs from the selected source: {relative}"
            )
        linked.append(relative)
    return tuple(linked)


def _ensure_inputs_manifest() -> None:
    """Create the guest manifest and readonly source fixture links once.

    The source bind is readonly and may expose a Windows checkout.  The
    container therefore receives the diagnostic Windows root, worktree ID and
    commit through environment variables prepared by the Compose launcher;
    ``seed_guest`` performs the bounded copy into the frontend state volume.
    Existing manifests are never rewritten during a restart, but the exact
    allowlisted fixture links are revalidated on every start.
    """

    _validate_control_volume_contract()
    source = _source_container_root()
    if INPUTS_PATH.exists():
        _ensure_readonly_source_fixture_links(source)
        return
    host_source_root = os.environ.get("FULLMAG_SOURCE_ROOT")
    worktree_id = os.environ.get("FULLMAG_SOURCE_WORKTREE_ID")
    source_commit = os.environ.get("FULLMAG_SOURCE_COMMIT")
    host_port = os.environ.get("FULLMAG_FRONTEND_HOST_PORT") or os.environ.get(
        "FULLMAG_FRONTEND_CACHE_HOST_PORT"
    )
    if not host_source_root or not worktree_id or not source_commit or not host_port:
        _fail(
            "frontend input manifest is missing and the Compose source identity is incomplete; "
            "set FULLMAG_SOURCE_ROOT, FULLMAG_SOURCE_WORKTREE_ID, FULLMAG_SOURCE_COMMIT "
            "and FULLMAG_FRONTEND_HOST_PORT"
        )
    try:
        source_scripts = source / "scripts"
        if source_scripts.is_dir() and str(source_scripts) not in sys.path:
            # The dev image intentionally contains only the runtime scripts;
            # use the selected readonly checkout for this one bounded seeder.
            sys.path.insert(0, str(source_scripts))
        import docker_development_inputs

        docker_development_inputs.seed_guest(
            source,
            DEVELOPMENT_ROOT,
            int(host_port),
            host_source_root=host_source_root,
            worktree_id=worktree_id,
            source_commit=source_commit,
            manifest_path=INPUTS_PATH,
            frontend_cache_key=FRONTEND_CACHE_KEY,
        )
        _ensure_readonly_source_fixture_links(source)
    except Exception as error:
        if isinstance(error, FrontendDevError):
            raise
        _fail(f"cannot seed frontend named-volume inputs: {error}")


def read_inputs(path: Path | None = None) -> DevelopmentInputs:
    """Read and validate the bounded manifest from the named control volume."""

    if path is None:
        path = INPUTS_PATH
    if path != INPUTS_PATH:
        _fail("development input manifest path is fixed to the named control volume")
    manifest = _read_json(path, "Docker development input manifest")
    _validate_control_volume_contract()
    unexpected_keys = set(manifest) - REQUIRED_MANIFEST_KEYS - OPTIONAL_MANIFEST_KEYS
    if not REQUIRED_MANIFEST_KEYS <= set(manifest) or unexpected_keys:
        _fail("Docker development input manifest has an unexpected field set")
    if manifest.get("schema") != INPUTS_SCHEMA:
        _fail("Docker development input manifest has an unsupported schema")
    manifest_cache_key = manifest.get("frontend_cache_key")
    if manifest_cache_key is not None and (
        not isinstance(manifest_cache_key, str) or not HEX64.fullmatch(manifest_cache_key)
    ):
        _fail("frontend_cache_key must be a lowercase SHA-256")
    if FRONTEND_CACHE_KEY is not None and manifest_cache_key != FRONTEND_CACHE_KEY:
        _fail("Docker development input manifest belongs to a different cache volume")
    source_root = manifest.get("source_root")
    if (
        not isinstance(source_root, str)
        or not source_root
        or len(source_root.encode()) > 2048
        or "\x00" in source_root
    ):
        _fail("source_root must be a bounded diagnostic host path")
    if manifest.get("source_selection") == "live_linux_selected_checkout":
        if (not source_root.startswith("/") or source_root.startswith("//") or source_root == "/"
                or "\\" in source_root or ".." in source_root.split("/")
                or str(PurePosixPath(source_root)) != source_root
                or any(ord(char) < 32 or ord(char) == 127 for char in source_root)):
            _fail("source_root must be a canonical absolute Linux diagnostic path")
    elif not WINDOWS_PATH.match(source_root):
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


def _load_diagnostic_receipt() -> dict[str, Any] | None:
    """Read the named-volume receipt only as cache/failure history.

    A stale ``unknown`` record in this path is deliberately not an owner
    authority: the owner path lives on the per-container tmpfs and is empty
    after a new Docker incarnation.
    """

    try:
        receipt = _read_json(DIAGNOSTIC_RECEIPT_PATH, "frontend diagnostic receipt")
    except FileNotFoundError:
        return None
    if receipt.get("schema") != RECEIPT_SCHEMA:
        _fail("frontend diagnostic receipt has an unsupported schema")
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
        (OWNER_ROOT, "ephemeral frontend owner root"),
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
    _validate_managed_link(
        FRONTEND_ROOT / "node_modules",
        app_root / "node_modules",
        "frontend dependency resolution",
    )


def _prepare_managed_frontend(inputs: DevelopmentInputs) -> Path:
    app_root = inputs.workspace_root / "apps" / "control-room"
    _assert_no_links(app_root, "Control Room app root")
    _ensure_cache_layout(inputs)
    node_modules_target = _ensure_node_modules_layout(inputs)
    _ensure_managed_link(app_root / ".fullmag-frontend", FRONTEND_ROOT, "frontend root")
    _ensure_managed_link(app_root / "out", FRONTEND_ROOT / "out", "static output")
    _ensure_managed_link(app_root / ".next", FRONTEND_ROOT / "next" / "default", "default Next cache")
    _ensure_managed_link(
        app_root / NEXT_DIST_DIR,
        FRONTEND_ROOT / "next" / f"dev-{INTERNAL_PORT}",
        "development Next cache",
    )
    _ensure_managed_link(
        FRONTEND_ROOT / "node_modules",
        app_root / "node_modules",
        "frontend dependency resolution",
    )
    return node_modules_target


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


def _write_tool_probe_log(log_stream: Any | None, message: str) -> None:
    """Append one bounded probe event without changing probe admission."""

    if log_stream is None:
        return
    try:
        log_stream.write(f"{message}\n".encode("utf-8"))
        log_stream.flush()
    except (AttributeError, OSError, TypeError):
        # A probe failure must retain its exact tool error even if the
        # diagnostic stream is unavailable or has just been closed.
        return


def _emit_tool_probe_event(log_stream: Any | None, event: str, **fields: Any) -> None:
    """Emit one probe event to both the durable log and supervisor stdout."""

    def log_value(key: str, value: Any) -> str:
        if key in {"output", "version", "expected"}:
            return repr(value)
        return str(value)

    values = " ".join(f"{key}={log_value(key, value)}" for key, value in fields.items())
    message = f"frontend tool probe {event}"
    if values:
        message = f"{message} {values}"
    _write_tool_probe_log(log_stream, message)
    _write_lifecycle_log(f"tool_probe_{event}", **fields)


def _tool_version(
    executable: Path,
    expected: str,
    name: str,
    *,
    cwd: Path | None = None,
    environment: Mapping[str, str] | None = None,
    log_stream: Any | None = None,
) -> str:
    started = time.monotonic()
    _emit_tool_probe_event(
        log_stream,
        "start",
        name=name,
        executable=executable,
        budget_seconds=TOOL_TIMEOUT_SECONDS,
    )

    def emit_result(status: str, **fields: Any) -> None:
        _emit_tool_probe_event(
            log_stream,
            "result",
            name=name,
            status=status,
            elapsed_seconds=f"{time.monotonic() - started:.3f}",
            budget_seconds=TOOL_TIMEOUT_SECONDS,
            **fields,
        )

    if not executable.is_file() or not os.access(executable, os.X_OK):
        error = f"pinned {name} executable is missing or not executable: {executable}"
        emit_result("missing", error=error)
        _fail(error)
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
        status = "timeout" if isinstance(error, subprocess.TimeoutExpired) else "error"
        emit_result(status, error=str(error))
        if isinstance(error, subprocess.TimeoutExpired):
            elapsed = time.monotonic() - started
            _fail(
                f"pinned {name} version probe timed out after {elapsed:.3f}s "
                f"(budget {TOOL_TIMEOUT_SECONDS}s)"
            )
        _fail(f"pinned {name} version probe failed: {error}")
    version = result.stdout.strip()
    if result.returncode != 0 or not version:
        emit_result("error", output=version, returncode=result.returncode)
        _fail(f"pinned {name} version probe returned {version!r}")
    if version != expected:
        emit_result("mismatch", version=version, expected=expected)
        _fail(f"pinned {name} version is {version!r}; expected {expected!r}")
    emit_result("ok", version=version)
    return version


def _validate_watchpack_polling_ms(value: int) -> int:
    if (
        type(value) is not int
        or not WATCHPACK_POLLING_MIN_MS <= value <= WATCHPACK_POLLING_MAX_MS
    ):
        _fail(
            f"{WATCHPACK_POLLING_ENV} must be an integer between "
            f"{WATCHPACK_POLLING_MIN_MS} and {WATCHPACK_POLLING_MAX_MS} ms; got {value!r}"
        )
    return value


def _watchpack_polling_ms(environment: Mapping[str, str] | None = None) -> int:
    source = os.environ if environment is None else environment
    raw = source.get(WATCHPACK_POLLING_ENV, str(WATCHPACK_POLLING_DEFAULT_MS))
    if not isinstance(raw, str) or re.fullmatch(r"[0-9]+", raw.strip()) is None:
        _fail(
            f"{WATCHPACK_POLLING_ENV} must be an integer between "
            f"{WATCHPACK_POLLING_MIN_MS} and {WATCHPACK_POLLING_MAX_MS} ms; got {raw!r}"
        )
    return _validate_watchpack_polling_ms(int(raw.strip(), 10))


def _safe_environment(
    inputs: DevelopmentInputs,
    *,
    watchpack_polling_ms: int | None = None,
) -> dict[str, str]:
    polling_ms = (
        _watchpack_polling_ms()
        if watchpack_polling_ms is None
        else _validate_watchpack_polling_ms(watchpack_polling_ms)
    )
    environment = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(HOME_ROOT),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "NODE_ENV": "development",
        "FULLMAG_DOCKER_FRONTEND": "dev",
        "FULLMAG_FRONTEND_ROOT": str(FRONTEND_ROOT),
        "FULLMAG_NEXT_DIST_DIR": NEXT_DIST_DIR,
        "WATCHPACK_POLLING": str(polling_ms),
        # Keep Node's filesystem worker pool explicit for the Windows bind
        # mount.  This is deliberately independent of NODE_OPTIONS and is not
        # inherited from the container/operator environment.
        NODE_FS_THREADS_ENV: str(NODE_FS_THREADS),
        "FULLMAG_API_PROXY_TARGET": API_PROXY_TARGET,
        "FULLMAG_API_URL": API_PROXY_TARGET,
        # Frontend smoke scripts execute the pure Python DSL from the
        # validated readonly source link.  Keep the native runtime package
        # out of this process: it belongs to the backend service and is not a
        # frontend fixture dependency.
        "PYTHONPATH": str(WORKSPACE_ROOT / "packages" / "fullmag-py" / "src"),
        "FULLMAG_REPO_ROOT": str(WORKSPACE_ROOT),
        "FULLMAG_WEB_PUBLIC_HOST": "localhost",
        "FULLMAG_WEB_PUBLIC_PORT": str(inputs.host_port),
        # Leave the browser API-base variables unset.  The control-room
        # resolver then uses window.location.origin, so a host browser that
        # reaches the published port through either localhost or 127.0.0.1
        # stays same-origin and uses the Next proxy.  The server-side proxy
        # remains pinned separately by FULLMAG_API_PROXY_TARGET above.
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


def _receipt_base(
    inputs: DevelopmentInputs,
    previous: Mapping[str, Any] | None,
    *,
    watchpack_polling_ms: int | None = None,
) -> dict[str, Any]:
    polling_ms = (
        _watchpack_polling_ms()
        if watchpack_polling_ms is None
        else _validate_watchpack_polling_ms(watchpack_polling_ms)
    )
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
        "watchpack_polling_ms": polling_ms,
        "uv_threadpool_size": NODE_FS_THREADS,
        "inspector": {
            "schema": INSPECTOR_SCHEMA,
            "profile": INSPECTOR_PROFILE,
            "state": "configured",
            "bind_host": INSPECTOR_BIND_HOST,
            "bind_port": INSPECTOR_BIND_PORT,
        },
    }
    failure = _receipt_failure(previous)
    if failure is not None:
        receipt["previous_failure_evidence"] = failure
    return receipt


def _publish_receipt(receipt: Mapping[str, Any]) -> None:
    value = dict(receipt)
    _atomic_json(RECEIPT_PATH, value, "ephemeral frontend owner receipt")
    # Keep the last observed lifecycle bytes for generated-file/freeze gates and
    # diagnostics. This copy is never consulted by _reject_existing_owner.
    _atomic_json(DIAGNOSTIC_RECEIPT_PATH, value, "frontend diagnostic receipt")


def _acquire_runtime_lock() -> Any:
    """Own this cache key across dependency installation and the Next process."""

    if fcntl is None:
        _fail("frontend cache runtime locking is unavailable")
    _assert_no_links(RUNTIME_LOCK_PATH.parent, "frontend runtime lock parent")
    descriptor: int | None = None
    try:
        descriptor = os.open(
            RUNTIME_LOCK_PATH,
            os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
        )
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise FrontendDevError("frontend runtime lock is not a regular file")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise FrontendDevError("frontend cache is already held by an active consumer") from error
        return os.fdopen(descriptor, "a+b", buffering=0)
    except FrontendDevError:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise
    except FileNotFoundError as error:
        _fail(f"frontend runtime lock is missing: {RUNTIME_LOCK_PATH}")
    except OSError as error:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        _fail(f"cannot acquire frontend runtime lock: {error}")


def _release_runtime_lock(lock: Any | None) -> None:
    if lock is None:
        return
    try:
        lock.close()
    except OSError:
        pass


def _assert_runtime_lock_for_log_rotation(runtime_lock: Any) -> None:
    """Require the already-acquired frontend runtime lock for log rotation."""

    if fcntl is None:
        _fail("frontend log rotation requires the existing runtime lock")
    _assert_no_links(RUNTIME_LOCK_PATH.parent, "frontend runtime lock parent")
    try:
        descriptor = runtime_lock.fileno()
        lock_metadata = os.fstat(descriptor)
        path_metadata = os.lstat(RUNTIME_LOCK_PATH)
    except (AttributeError, OSError, ValueError) as error:
        _fail(f"frontend log rotation requires the existing runtime lock: {error}")
    if (
        not stat.S_ISREG(lock_metadata.st_mode)
        or lock_metadata.st_nlink != 1
        or not stat.S_ISREG(path_metadata.st_mode)
        or path_metadata.st_nlink != 1
        or (lock_metadata.st_dev, lock_metadata.st_ino)
        != (path_metadata.st_dev, path_metadata.st_ino)
    ):
        _fail("frontend log rotation requires the existing runtime lock")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        _fail("frontend log rotation requires the existing runtime lock")
    except OSError as error:
        _fail(f"frontend log rotation cannot verify the existing runtime lock: {error}")


def _regular_log_metadata(path: Path, name: str) -> os.stat_result:
    """Inspect one exact log path without following links or opening a FIFO."""

    _path_without_parent(path, name)
    _assert_no_links(path.parent, f"{name} parent")
    descriptor: int | None = None
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY
            | getattr(os, "O_NONBLOCK", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            _fail(f"{name} is not one regular file")
        if metadata.st_size > MAX_LOG_BYTES:
            _fail(f"{name} exceeds its retained size limit; preserve it for explicit review")
        return metadata
    except FileNotFoundError:
        raise
    except FrontendDevError:
        raise
    except OSError as error:
        _fail(f"cannot inspect {name}: {error}")
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _sync_log_directory(path: Path) -> None:
    """Make the directory entry for a completed log rename durable."""

    descriptor: int | None = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        os.fsync(descriptor)
    except OSError as error:
        _fail(f"durable frontend log rotation is unknown: {error}")
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _rotate_log_if_needed(runtime_lock: Any) -> None:
    """Keep one verified previous generation when the current log is full."""

    _assert_runtime_lock_for_log_rotation(runtime_lock)
    if LOG_PATH.name != "next.log" or LOG_ROLLBACK_PATH.name != "next.log.rollback":
        _fail("frontend log rotation paths are not canonical")
    if LOG_PATH.parent != LOG_ROLLBACK_PATH.parent:
        _fail("frontend log rotation paths must share one parent")
    try:
        current = _regular_log_metadata(LOG_PATH, "frontend retained log")
    except FileNotFoundError:
        return
    if current.st_size < MAX_LOG_BYTES:
        return
    try:
        _regular_log_metadata(LOG_ROLLBACK_PATH, "frontend retained log rollback")
    except FileNotFoundError:
        pass
    try:
        os.replace(LOG_PATH, LOG_ROLLBACK_PATH)
        _sync_log_directory(LOG_PATH.parent)
        _write_lifecycle_log("log_rotate", status="complete", bytes=current.st_size,
                             rollback=str(LOG_ROLLBACK_PATH))
    except FrontendDevError:
        raise
    except OSError as error:
        _fail(f"durable frontend log rotation is unknown: {error}")


class _BoundedLog:
    """Pipe child output into a bounded retained file; overflow uses Docker's ring."""

    def __init__(self, stream: Any) -> None:
        self._stream = stream
        self._read_fd, self._write_fd = os.pipe()
        self._closed = False
        self._condition = threading.Condition()
        self._queued = 0
        self._consumed = 0
        self._error: BaseException | None = None
        self._thread = threading.Thread(target=self._drain, name="fullmag-frontend-log-writer", daemon=True)
        self._thread.start()

    def fileno(self) -> int:
        return self._write_fd

    def log_fileno(self) -> int:
        return self._stream.fileno()

    def write(self, data: bytes) -> int:
        view = memoryview(data)
        while view:
            count = os.write(self._write_fd, view)
            with self._condition:
                self._queued += count
            view = view[count:]
        return len(data)

    def flush(self) -> None:
        with self._condition:
            complete = self._condition.wait_for(lambda: self._consumed >= self._queued or self._error is not None, timeout=5)
            if not complete or self._error is not None:
                raise OSError("frontend log writer did not acknowledge bounded output")

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            os.close(self._write_fd)
            self._thread.join(timeout=5)

    def _drain(self) -> None:
        remaining = MAX_LOG_BYTES - os.fstat(self._stream.fileno()).st_size
        overflow_reported = False
        try:
            while chunk := os.read(self._read_fd, 65536):
                retained = min(len(chunk), remaining)
                if retained:
                    self._stream.write(chunk[:retained])
                    self._stream.flush()
                    remaining -= retained
                if retained < len(chunk):
                    if not overflow_reported:
                        _write_lifecycle_log("log_budget", status="bounded", byte_limit=MAX_LOG_BYTES,
                                             overflow="docker-local-log-ring")
                        overflow_reported = True
                    binary = getattr(sys.stdout, "buffer", None)
                    if binary is not None:
                        binary.write(chunk[retained:]); binary.flush()
                    else:
                        sys.stdout.write(chunk[retained:].decode("utf-8", "replace")); sys.stdout.flush()
                with self._condition:
                    self._consumed += len(chunk)
                    self._condition.notify_all()
        except BaseException as error:
            with self._condition:
                self._error = error
                self._condition.notify_all()
        finally:
            os.close(self._read_fd)
            self._stream.close()


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
            | getattr(os, "O_NONBLOCK", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            0o660,
        )
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            os.close(descriptor)
            descriptor = None
            _fail("frontend retained log is not one regular file")
        if metadata.st_size >= MAX_LOG_BYTES:
            os.close(descriptor)
            descriptor = None
            _fail("frontend retained log budget exhausted; preserve logs for explicit review")
        return _BoundedLog(os.fdopen(descriptor, "ab"))
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        _fail(f"cannot open frontend development log: {error}")


def _log_file_offset(log_stream: Any) -> int | None:
    """Return the append-log boundary before a new Next child is spawned."""

    try:
        return int(os.fstat(getattr(log_stream, "log_fileno", log_stream.fileno)()).st_size)
    except (AttributeError, OSError, ValueError):
        return None


def _read_log_region(log_path: Path, offset: int | None) -> bytes:
    """Read this child's bounded log tail without following links."""

    if offset is None:
        return b""
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        _fail("frontend inspector log offset is invalid")
    _assert_no_links(log_path.parent, "frontend development log parent")
    descriptor: int | None = None
    try:
        descriptor = os.open(
            log_path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        )
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            _fail("frontend development log is not a regular file")
        if metadata.st_size < offset:
            return b""
        start = max(offset, metadata.st_size - INSPECTOR_LOG_SCAN_BYTES)
        os.lseek(descriptor, start, os.SEEK_SET)
        return os.read(descriptor, INSPECTOR_LOG_SCAN_BYTES)
    except FileNotFoundError:
        return b""
    except OSError as error:
        _fail(f"cannot read frontend development log for inspector address: {error}")
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _parse_inspector_output(data: bytes) -> dict[str, Any] | None:
    """Parse the local Node inspector endpoint emitted by the Next child."""

    if not isinstance(data, bytes):
        _fail("frontend inspector output must be bytes")
    marker = b"Debugger listening on "
    observed: dict[str, Any] | None = None
    for line in data.splitlines():
        if marker not in line:
            continue
        match = INSPECTOR_OUTPUT_RE.search(line)
        if match is None:
            _fail("Next emitted an invalid Node inspector address")
        try:
            address = match.group("address").decode("ascii")
            host = match.group("host").decode("ascii")
            port = int(match.group("port"))
            target = match.group("target").decode("ascii")
        except (UnicodeDecodeError, ValueError) as error:
            raise FrontendDevError("Next emitted an undecodable Node inspector address") from error
        if host != INSPECTOR_BIND_HOST:
            _fail("Next Node inspector must bind to the container loopback address")
        if not 1 <= port <= 65535 or not target:
            _fail("Next emitted an invalid Node inspector port or target")
        observed = {
            "address": address,
            "host": host,
            "port": port,
        }
    return observed


def _inspector_observation_warning(pid: int, error: Exception) -> None:
    """Report bounded inspector telemetry failures without affecting Next."""

    message = str(error).strip() or error.__class__.__name__
    _write_lifecycle_log(
        "next_inspector",
        status="observation-warning",
        launcher_pid=pid,
        error=message[-512:],
    )


def _refresh_inspector_receipt(
    receipt: dict[str, Any],
    *,
    pid: int,
    log_path: Path,
    log_offset: int | None,
    publish: bool,
) -> bool:
    """Publish the endpoint when available; never gate the owned Next process."""

    try:
        observed = _parse_inspector_output(_read_log_region(log_path, log_offset))
        if observed is None:
            return False
        configured = receipt.get("inspector")
        if not isinstance(configured, dict):
            _fail("frontend receipt is missing the Next inspector configuration")
        recorded_launcher_pid = configured.get("launcher_pid")
        if (
            recorded_launcher_pid not in (None, pid)
            or configured.get("profile") != INSPECTOR_PROFILE
        ):
            _fail("frontend receipt Node inspector identity differs from the owned process")
        previous_address = configured.get("address")
        if previous_address == observed["address"] and configured.get("state") == "ready":
            return False
        inspector = dict(configured)
        inspector.pop("pid", None)
        inspector.update(state="ready", launcher_pid=pid, **observed)
        receipt["inspector"] = inspector
        _write_lifecycle_log(
            "next_inspector",
            status="ready",
            launcher_pid=pid,
            address=observed["address"],
            bind_host=INSPECTOR_BIND_HOST,
        )
        if publish:
            _publish_receipt(receipt)
        return True
    except Exception as error:
        _inspector_observation_warning(pid, error)
        return False


def _write_lifecycle_log(event: str, **fields: Any) -> None:
    """Write a short current-phase marker to the container supervisor stdout."""

    values = " ".join(f"{key}={value}" for key, value in fields.items())
    line = f"[fullmag-frontend] lifecycle event={event}"
    if values:
        line = f"{line} {values}"
    try:
        print(line, flush=True)
    except (BrokenPipeError, OSError):
        # Supervisor diagnostics must not change the process ownership or
        # fail-closed startup decisions when stdout is being closed.
        return


class _LogTailer:
    """Bounded read-only tail of the owned log file for Docker stdout."""

    def __init__(self, stream: Any) -> None:
        self._stream = stream
        self._stopping = threading.Event()
        self._stdout_enabled = True
        self._thread = threading.Thread(
            target=self._run,
            name="fullmag-frontend-log-tail",
            daemon=True,
        )

    @classmethod
    def start(cls) -> "_LogTailer":
        _assert_no_links(LOG_PATH, "frontend development log")
        descriptor: int | None = None
        stream: Any | None = None
        try:
            descriptor = os.open(
                LOG_PATH,
                os.O_RDONLY
                | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_NONBLOCK", 0),
            )
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise FrontendDevError("frontend development log is not a regular file")
            stream = os.fdopen(descriptor, "rb")
            descriptor = None
            stream.seek(0, os.SEEK_END)
            tailer = cls(stream)
            tailer._thread.start()
            return tailer
        except (FrontendDevError, OSError, RuntimeError):
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
            raise

    def _write_stdout(self, chunk: bytes) -> None:
        if not self._stdout_enabled:
            return
        try:
            binary = getattr(sys.stdout, "buffer", None)
            if binary is not None:
                binary.write(chunk)
                binary.flush()
            else:
                sys.stdout.write(chunk.decode("utf-8", errors="replace"))
                sys.stdout.flush()
        except (BrokenPipeError, OSError, TypeError, ValueError):
            # Diagnostics must not affect the owned child or startup result.
            self._stdout_enabled = False

    def _run(self) -> None:
        try:
            while not self._stopping.is_set():
                chunk = self._stream.read(LOG_TAIL_CHUNK_BYTES)
                if chunk:
                    self._write_stdout(chunk)
                    continue
                self._stopping.wait(LOG_TAIL_POLL_SECONDS)
        finally:
            self._stream.close()

    def stop(self) -> None:
        self._stopping.set()
        self._thread.join(LOG_TAIL_STOP_TIMEOUT_SECONDS)


def _start_log_tailer() -> _LogTailer | None:
    try:
        return _LogTailer.start()
    except (FrontendDevError, OSError, RuntimeError) as error:
        _write_lifecycle_log("log_tail", status="disabled", error=str(error))
        return None


def _stop_log_tailer(log_tailer: _LogTailer | None) -> None:
    if log_tailer is not None:
        log_tailer.stop()


def _run_pnpm_install(
    inputs: DevelopmentInputs,
    stopping_event: Any,
    log_stream: Any,
    receipt: dict[str, Any],
    runtime_lock: Any,
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
    install_started = time.monotonic()
    _write_lifecycle_log(
        "frozen_install_start",
        budget_seconds=INSTALL_TIMEOUT_SECONDS,
        log_path=LOG_PATH,
    )
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
        _write_lifecycle_log(
            "frozen_install_result",
            status="failed",
            elapsed_seconds=f"{time.monotonic() - install_started:.3f}",
            budget_seconds=INSTALL_TIMEOUT_SECONDS,
            error=str(error),
        )
        _fail(f"frozen pnpm install could not start: {error}")
    try:
        install_handle = _new_handle(
            process,
            inputs,
            stopping_event,
            "pnpm-install",
            log_stream,
            runtime_lock=runtime_lock,
        )
    except Exception as error:
        owned_handle = getattr(error, "frontend_handle", None)
        if isinstance(owned_handle, FrontendHandle):
            _record_handle_identity(receipt, owned_handle)
            try:
                _publish_receipt(receipt)
            except Exception:
                pass
        _write_lifecycle_log(
            "frozen_install_result",
            status="failed",
            elapsed_seconds=f"{time.monotonic() - install_started:.3f}",
            budget_seconds=INSTALL_TIMEOUT_SECONDS,
            error=str(error),
        )
        raise
    _record_handle_identity(receipt, install_handle)
    try:
        _publish_receipt(receipt)
    except Exception as error:
        _attach_frontend_handle(error, install_handle)
        _write_lifecycle_log(
            "frozen_install_result",
            status="failed",
            elapsed_seconds=f"{time.monotonic() - install_started:.3f}",
            budget_seconds=INSTALL_TIMEOUT_SECONDS,
            error=str(error),
        )
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
                _write_lifecycle_log(
                    "frozen_install_result",
                    status="ready",
                    elapsed_seconds=f"{time.monotonic() - install_started:.3f}",
                    budget_seconds=INSTALL_TIMEOUT_SECONDS,
                    log_path=LOG_PATH,
                )
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
        _write_lifecycle_log(
            "frozen_install_result",
            status="failed",
            elapsed_seconds=f"{time.monotonic() - install_started:.3f}",
            budget_seconds=INSTALL_TIMEOUT_SECONDS,
            error=str(error),
        )
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


def _dependency_tree_ready(inputs: DevelopmentInputs) -> bool:
    """Require a real state-owned dependency tree before trusting its receipt."""

    _require_real_directory(inputs.workspace_root / "node_modules", "workspace node_modules")
    app_root = inputs.workspace_root / "apps" / "control-room"
    _require_real_directory(app_root / "node_modules", "Control Room node_modules")
    binary = app_root / NEXT_RELATIVE
    try:
        binary.lstat()
    except FileNotFoundError:
        return False
    _next_binary(inputs)
    return True


def _attach_frontend_handle(error: Exception, handle: FrontendHandle) -> None:
    setattr(error, "frontend_handle", handle)


def _new_handle(
    process: subprocess.Popen[Any],
    inputs: DevelopmentInputs,
    stopping_event: Any,
    kind: str,
    log_stream: Any,
    log_tailer: _LogTailer | None = None,
    runtime_lock: Any | None = None,
    inspector_log_offset: int | None = None,
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
        log_tailer=log_tailer,
        runtime_lock=runtime_lock,
        inspector_log_offset=inspector_log_offset,
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


def _next_command() -> list[str]:
    """Run the pinned Next CLI with a local, ephemeral Node inspector."""

    return [
        str(NODE_BINARY),
        str(NEXT_RELATIVE),
        "dev",
        "--webpack",
        INSPECTOR_FLAG,
        "--hostname",
        "0.0.0.0",
        "--port",
        str(INTERNAL_PORT),
    ]


def _start_next(
    inputs: DevelopmentInputs,
    stopping_event: Any,
    log_stream: Any,
    log_tailer: _LogTailer | None,
    receipt: dict[str, Any],
    runtime_lock: Any,
) -> FrontendHandle:
    _next_binary(inputs)
    receipt_polling_ms = receipt.get("watchpack_polling_ms")
    if type(receipt_polling_ms) is not int:
        _fail("frontend receipt is missing the bounded Watchpack polling value")
    watchpack_polling_ms = _validate_watchpack_polling_ms(receipt_polling_ms)
    if receipt.get("uv_threadpool_size") != NODE_FS_THREADS:
        _fail("frontend receipt is missing the pinned Node filesystem thread count")
    app_root = inputs.workspace_root / "apps" / "control-room"
    command = _next_command()
    environment = _safe_environment(inputs, watchpack_polling_ms=watchpack_polling_ms)
    inspector_log_offset = _log_file_offset(log_stream)
    inspector = receipt.get("inspector")
    inspector_configuration_error: FrontendDevError | None = None
    if not isinstance(inspector, dict):
        inspector_configuration_error = FrontendDevError(
            "frontend receipt is missing the Next inspector configuration"
        )
        inspector = {
            "schema": INSPECTOR_SCHEMA,
            "profile": INSPECTOR_PROFILE,
            "state": "configured",
            "bind_host": INSPECTOR_BIND_HOST,
            "bind_port": INSPECTOR_BIND_PORT,
        }
    next_started = time.monotonic()
    _write_lifecycle_log(
        "next_start",
        url=f"http://localhost:{inputs.host_port}",
        internal_port=INTERNAL_PORT,
        inspector_bind=f"{INSPECTOR_BIND_HOST}:{INSPECTOR_BIND_PORT}",
        watchpack_polling_ms=watchpack_polling_ms,
        uv_threadpool_size=NODE_FS_THREADS,
        log_path=LOG_PATH,
    )
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
        inspector = dict(inspector)
        inspector.pop("pid", None)
        inspector.update(state="pending", launcher_pid=process.pid)
        receipt["inspector"] = inspector
        if inspector_configuration_error is not None:
            _inspector_observation_warning(process.pid, inspector_configuration_error)
    except OSError as error:
        _write_lifecycle_log(
            "next_result",
            status="failed",
            elapsed_seconds=f"{time.monotonic() - next_started:.3f}",
            url=f"http://localhost:{inputs.host_port}",
            inspector_bind=f"{INSPECTOR_BIND_HOST}:{INSPECTOR_BIND_PORT}",
            watchpack_polling_ms=watchpack_polling_ms,
            uv_threadpool_size=NODE_FS_THREADS,
            error=str(error),
        )
        _fail(f"Next development process could not start: {error}")
    try:
        handle = _new_handle(
            process,
            inputs,
            stopping_event,
            "next",
            log_stream,
            log_tailer,
            runtime_lock=runtime_lock,
            inspector_log_offset=inspector_log_offset,
        )
    except Exception as error:
        owned_handle = getattr(error, "frontend_handle", None)
        if isinstance(owned_handle, FrontendHandle):
            _record_handle_identity(receipt, owned_handle)
            try:
                _publish_receipt(receipt)
            except Exception:
                pass
        _write_lifecycle_log(
            "next_result",
            status="failed",
            elapsed_seconds=f"{time.monotonic() - next_started:.3f}",
            url=f"http://localhost:{inputs.host_port}",
            inspector_bind=f"{INSPECTOR_BIND_HOST}:{INSPECTOR_BIND_PORT}",
            watchpack_polling_ms=watchpack_polling_ms,
            uv_threadpool_size=NODE_FS_THREADS,
            error=str(error),
        )
        raise
    _refresh_inspector_receipt(
        receipt,
        pid=handle.pid,
        log_path=handle.log_path,
        log_offset=handle.inspector_log_offset,
        publish=False,
    )
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
    _write_lifecycle_log(
        "next_result",
        status="started",
        readiness="owned_process",
        elapsed_seconds=f"{time.monotonic() - next_started:.3f}",
        url=f"http://localhost:{inputs.host_port}",
        inspector_bind=f"{INSPECTOR_BIND_HOST}:{INSPECTOR_BIND_PORT}",
        watchpack_polling_ms=watchpack_polling_ms,
        uv_threadpool_size=NODE_FS_THREADS,
        log_path=LOG_PATH,
    )
    return handle


def start(stopping_event: Any) -> FrontendHandle:
    """Validate the frozen seed, install Linux dependencies once, and spawn Next."""

    if not enabled():
        _fail("Docker frontend development is disabled")
    if stopping_event is None or not hasattr(stopping_event, "is_set"):
        _fail("frontend development requires a stopping event")
    if stopping_event.is_set():
        _fail("frontend development cannot start after shutdown was requested")
    _ensure_inputs_manifest()
    inputs = read_inputs()
    previous = _load_receipt()
    diagnostic_previous = _load_diagnostic_receipt()
    _reject_existing_owner(previous)
    history = previous or diagnostic_previous
    allow_generated = _generated_gate(history)
    _prepare_state_directories()
    _validate_live_directories(inputs)
    _freeze_inputs(inputs, allow_generated=allow_generated)
    watchpack_polling_ms = _watchpack_polling_ms()
    runtime_lock = _acquire_runtime_lock()
    try:
        _rotate_log_if_needed(runtime_lock)
        node_modules_target = _prepare_managed_frontend(inputs)
        tool_environment = _safe_environment(
            inputs, watchpack_polling_ms=watchpack_polling_ms
        )
        receipt = _receipt_base(
            inputs, history, watchpack_polling_ms=watchpack_polling_ms
        )
        receipt.update(
            state="starting",
            dependency_root=str(node_modules_target),
            generated_files_gate=("next-started-v1" if allow_generated else "seed-only-v1"),
        )
        _publish_receipt(receipt)
        _write_lifecycle_log(
            "frontend_start",
            tool_probe_budget_seconds=TOOL_TIMEOUT_SECONDS,
            install_budget_seconds=INSTALL_TIMEOUT_SECONDS,
            watchpack_polling_ms=watchpack_polling_ms,
            log_path=LOG_PATH,
            url=f"http://localhost:{inputs.host_port}",
        )
        log_stream = _log_stream()
    except Exception:
        _release_runtime_lock(runtime_lock)
        raise
    try:
        node_version = _tool_version(
            NODE_BINARY,
            EXPECTED_NODE_VERSION,
            "Node",
            cwd=inputs.workspace_root,
            environment=tool_environment,
            log_stream=log_stream,
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
            log_stream=log_stream,
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
        try:
            log_stream.close()
        except OSError:
            pass
        _release_runtime_lock(runtime_lock)
        raise
    log_tailer = _start_log_tailer()
    handle: FrontendHandle | None = None
    try:
        # A fresh Docker incarnation has no owner receipt, but the named-volume
        # diagnostic copy still records whether this cache was prepared. Use
        # that history only to avoid reinstalling dependencies; ownership
        # authorization remains exclusively on the ephemeral receipt above.
        needs_install = history is None or history.get("dependency_install") != "ready"
        if not needs_install and not _dependency_tree_ready(inputs):
            needs_install = True
            _write_lifecycle_log(
                "dependency_install_reconcile",
                status="missing",
                reason="state-owned dependency tree is absent",
                log_path=LOG_PATH,
            )
        if needs_install:
            _run_pnpm_install(inputs, stopping_event, log_stream, receipt, runtime_lock)
            # pnpm owns the real dependency directories below the writable
            # workspace. Re-validate that layout before resolving Next so a
            # package-manager change cannot redirect execution into the
            # Windows source mount.
            _prepare_managed_frontend(inputs)
        _assert_not_stopping(stopping_event)
        _next_binary(inputs)
        _assert_not_stopping(stopping_event)
        handle = _start_next(inputs, stopping_event, log_stream, log_tailer, receipt, runtime_lock)
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
        _stop_log_tailer(log_tailer)
        if not isinstance(owned_handle, FrontendHandle):
            log_stream.close()
            _release_runtime_lock(runtime_lock)
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
        _refresh_inspector_receipt(
            receipt,
            pid=handle.pid,
            log_path=handle.log_path,
            log_offset=handle.inspector_log_offset,
            publish=True,
        )
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
    if handle.log_tailer is not None:
        handle.log_tailer.stop()
        handle.log_tailer = None
    if handle.log_stream is not None:
        handle.log_stream.close()
        handle.log_stream = None
    runtime_lock = handle.runtime_lock
    handle.runtime_lock = None
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
    try:
        _publish_receipt(receipt)
    finally:
        _release_runtime_lock(runtime_lock)
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
