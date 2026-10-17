"""Bind the all-in-Docker process tree to the canonical Rust runtime service.

Rust owns admission, attestation, owner validation, launch serialization,
resource pools, receipts, and recovery. This module only handles the fixed
container paths, API binding, canonical CLI calls, and canonical lifecycle CLI calls.
"""
from __future__ import annotations

from contextlib import contextmanager
import dataclasses
import http.client
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import stat
import subprocess
import time
import uuid
from typing import Any, Mapping, NoReturn, Sequence

STATE_ROOT = Path("/state")
SOURCE_ROOT = Path("/opt/fullmag/source")
PACKAGE_ROOT = Path("/opt/fullmag/package")
IMAGE_ROOT = Path("/opt/fullmag")
HOST_CERTIFICATE = Path("/run/fullmag/windows-folder-host.json")
WORKTREE_ID = TARGET_ID = "docker-all"
COMPUTE_POOL_ID = "docker-all.compute"
PREPARATION_POOL_ID = "docker-all.preparation"
WINDOWS_STORAGE_PROFILE = "windows-folder-v1"
STORAGE_SCHEMA = "fullmag_storage_v1"
RUNTIME_CONFIG_SCHEMA = "runtime_service_config.v1"
HOST_PROFILE_SCHEMA = "fullmag.docker-host-profile.v1"
# This is a path inside the Linux container, even when the source-only
# contract tests are imported by native Windows Python.  PurePosixPath keeps
# the serialized CLI/profile value stable across host operating systems.
HOST_LEDGER_ROOT = PurePosixPath("/host-ledger/ledger")
HOST_LEDGER_PROFILE = "host-ledger-v1"
HOST_RESOURCE_LEDGER_FILE = "HOST_RESOURCE_LEDGER.json"
LEGACY_DOCKER_HOST_ID = "docker-all-host"
MAX_HOST_LEDGER_BYTES = 8 * 1024 * 1024
CONFIG_RELATIVE = Path(".fullmag/runtime-service/docker-all.json")
MAX_JSON_BYTES = 256 * 1024
MAX_HTTP_BYTES = 4 * 1024 * 1024
# The native control probe is bounded at three seconds.  Keep the Python
# request budget above that limit so Windows-folder I/O cannot turn a healthy
# native probe into a transport timeout at the API boundary.
API_LIVENESS_TIMEOUT_SECONDS = 5.0
STARTUP_LIVENESS_GRACE_SECONDS = 30.0
# Process limits for lifecycle calls whose work includes Windows-folder (9p)
# I/O.  The accepted-store bootstrap and diagnostic service-status call can
# legitimately outlive the normal API probe on that mount.
SERVICE_STATUS_CLI_TIMEOUT_SECONDS = 30
STORE_BOOTSTRAP_CLI_TIMEOUT_SECONDS = 180
# A live API observation may be temporarily unprovable while the native
# service is still running.  The API remains fail-closed in that state; this
# window only prevents one bounded transport/probe blip from killing PID 1.
SUPERVISION_GRACE_SECONDS = 30.0
TRANSIENT_LIVENESS_OBSERVATIONS = frozenset(
    {
        ("observation_unknown", "live_probe_failed"),
        ("observation_unknown", "owner_read_failed"),
        ("observation_unknown", "owner_invalid"),
    }
)
MAX_LIVENESS_REASON_BYTES = 2048
# OWNER.json is published atomically while the native service starts. A
# reader may observe the brief absent-name interval, but only for this bounded
# lookup window; malformed, stale, or mismatched owner data remains fatal.
READY_OWNER_MISSING_RETRY_SECONDS = 1.0
READY_OWNER_MISSING_POLL_SECONDS = 0.05
RECOVERY_AUTHORIZATION_ENV = "FULLMAG_RUNTIME_RECOVERY_AUTHORIZATION"
RECOVERY_AUTHORIZATION_SCHEMA = "fullmag.docker-runtime-recovery-authorization.v1"
RECOVERY_REQUEST_SCHEMA = "runtime_service_recovery_request.v1"
MAX_RECOVERY_AUTHORIZATION_BYTES = 512 * 1024
MAX_RECOVERY_LOG_BYTES = 4 * 1024 * 1024
MAX_RECOVERY_ARCHIVED_FILES = 32
RECOVERY_MANDATORY_ARCHIVED_FILES = 12
RECOVERY_ARCHIVED_CONFIGURATION_KEY = "configuration.json"
RECOVERY_ABSENT_SOURCE_REASON = "scheduler_checkpoint_not_published"
GIB = 1024**3
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
OWNER_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
STORE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")

SERVICE_MODE_VARIABLES = (
    "FULLMAG_FDM_EXECUTION",
    "FULLMAG_FEM_EXECUTION",
    "FULLMAG_FEM_ALL_IN_GPU",
    "FULLMAG_FEM_REQUIRE_GPU",
    "FULLMAG_FEM_REQUIRE_CEED",
    "FULLMAG_FEM_MFEM_DEVICE",
    "FULLMAG_FORCE_LOCAL_FEM_GPU",
    "FULLMAG_FORCE_LOCAL_FEM_CPU",
    "FULLMAG_FDM_GPU_INDEX",
    "FULLMAG_FEM_GPU_INDEX",
    "FULLMAG_CUDA_DEVICE_INDEX",
)


class RuntimeServiceError(RuntimeError):
    """A deterministic admission or lifecycle failure."""


class RuntimeServiceUnknown(RuntimeServiceError):
    """A timeout or disconnect left the lifecycle outcome unknown."""


class RuntimeServiceTransient(RuntimeServiceUnknown):
    """A bounded supervision observation could not prove liveness yet."""


class RuntimeServiceTransportError(RuntimeServiceError):
    """The loopback API transport failed before a response was verified."""


class RuntimeServiceNotReady(RuntimeServiceError):
    """The API identity is pinned, but the runtime service is not ready yet."""

    def __init__(
        self,
        *,
        configured: bool,
        state: str,
        reason_code: str,
        reason_message: str,
        retryable: bool,
    ) -> None:
        self.retryable = retryable
        self.configured = configured
        self.state = state
        self.reason_code = reason_code
        self.liveness_observation = {
            "schema_version": "application_service_status.v1",
            "configured": configured,
            "state": state,
            "reason": {"code": reason_code, "message": reason_message},
        }
        super().__init__(
            "API runtime-service liveness is not ready: "
            f"state={state}, reason.code={reason_code}, "
            f"reason.message={reason_message}"
        )


@dataclasses.dataclass(frozen=True)
class RuntimePaths:
    state: Path = STATE_ROOT
    storage: Path = STATE_ROOT
    runs: Path = STATE_ROOT / "runs" / WORKTREE_ID
    store: Path = STATE_ROOT / "runs" / WORKTREE_ID / "session-store"
    state_root: Path = STATE_ROOT / ".fullmag"
    source: Path = SOURCE_ROOT
    package: Path = PACKAGE_ROOT
    config: Path = STATE_ROOT / CONFIG_RELATIVE
    provenance: Path = IMAGE_ROOT / "provenance.json"
    host_certificate: Path = HOST_CERTIFICATE


@dataclasses.dataclass(frozen=True)
class RuntimeHandle:
    paths: RuntimePaths
    configuration: dict[str, Any]
    owner: dict[str, Any]
    api_port: int
    api_identity: Mapping[str, Any] | None = None


def _fail(message: str) -> NoReturn:
    raise RuntimeServiceError(message)


def _absolute(value: str | os.PathLike[str], name: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or any(part == ".." for part in path.parts):
        _fail(f"{name} must be absolute without parent traversal")
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
        if bool(getattr(metadata, "st_file_attributes", 0) & 0x400):
            _fail(f"{name} component is a reparse point: {current}")
    return path


def _bounded_regular(path: Path, name: str, maximum: int = MAX_JSON_BYTES) -> bytes:
    path = _absolute(path, name)
    _assert_no_links(path.parent, f"{name} parent")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
            _fail(f"{name} is not a bounded regular file")
        data = bytearray()
        while len(data) <= maximum:
            chunk = os.read(descriptor, min(64 * 1024, maximum + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > maximum:
            _fail(f"{name} exceeds its size bound")
        return bytes(data)
    finally:
        os.close(descriptor)


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail(f"JSON object contains duplicate key {key!r}")
        result[key] = value
    return result


def _read_json(path: Path, name: str, maximum: int = MAX_JSON_BYTES) -> dict[str, Any]:
    try:
        value = json.loads(
            _bounded_regular(path, name, maximum), object_pairs_hook=_reject_duplicate_keys
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"{name} is not valid JSON: {error}")
    if not isinstance(value, dict):
        _fail(f"{name} must contain a JSON object")
    return value


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _read_recovery_authorization(paths: RuntimePaths, authorization_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Read one host-pinned recovery authorization and its immutable request."""

    authorization = _read_json(
        authorization_path,
        "runtime recovery authorization",
        MAX_RECOVERY_AUTHORIZATION_BYTES,
    )
    if authorization.get("schema_version") != RECOVERY_AUTHORIZATION_SCHEMA:
        _fail("runtime recovery authorization schema is unsupported")
    request_path_value = authorization.get("native_request_path")
    request_sha256 = authorization.get("native_request_sha256")
    request_id = authorization.get("request_id")
    if (
        not isinstance(request_path_value, str)
        or not request_path_value.startswith("/state/")
        or "/../" in request_path_value
        or not isinstance(request_sha256, str)
        or HEX64.fullmatch(request_sha256) is None
        or not isinstance(request_id, str)
        or UUID_RE.fullmatch(request_id) is None
    ):
        _fail("runtime recovery authorization has an invalid native request pin")
    request_path = _absolute(Path(request_path_value), "native recovery request")
    try:
        request_relative = request_path.relative_to(paths.state)
    except ValueError:
        _fail("native recovery request is outside the fixed /state root")
    if request_path != paths.state / request_relative:
        _fail("native recovery request is outside the fixed /state root")
    request_raw = _bounded_regular(
        request_path, "native recovery request", MAX_RECOVERY_AUTHORIZATION_BYTES
    )
    if _sha256_bytes(request_raw) != request_sha256:
        _fail("native recovery request changed after host authorization")
    try:
        request = json.loads(request_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"native recovery request is not valid JSON: {error}")
    if not isinstance(request, dict):
        _fail("native recovery request must contain an object")
    if request.get("schema_version") != RECOVERY_REQUEST_SCHEMA or request.get("request_id") != request_id:
        _fail("native recovery request identity differs from host authorization")
    config_raw = _bounded_regular(paths.config, "runtime service configuration")
    config_sha256 = authorization.get("config_sha256")
    if not isinstance(config_sha256, str) or HEX64.fullmatch(config_sha256) is None:
        _fail("runtime recovery authorization has no configuration digest")
    if _sha256_bytes(config_raw) != config_sha256 or request.get("config_sha256") != config_sha256:
        _fail("runtime recovery configuration changed after host authorization")
    owner_raw = _bounded_regular(
        paths.store / "runtime-services" / "OWNER.json",
        "runtime service owner",
        MAX_RECOVERY_AUTHORIZATION_BYTES,
    )
    launch_raw = _bounded_regular(
        paths.store / "runtime-services" / "LAUNCH.json",
        "runtime service launch record",
        MAX_RECOVERY_AUTHORIZATION_BYTES,
    )
    owner_sha256 = authorization.get("owner_sha256")
    launch_sha256 = authorization.get("launch_sha256")
    if (
        not isinstance(owner_sha256, str)
        or HEX64.fullmatch(owner_sha256) is None
        or _sha256_bytes(owner_raw) != owner_sha256
        or request.get("owner_sha256") != owner_sha256
        or not isinstance(launch_sha256, str)
        or HEX64.fullmatch(launch_sha256) is None
        or _sha256_bytes(launch_raw) != launch_sha256
        or request.get("launch_sha256") != launch_sha256
    ):
        _fail("native owner or launch record changed after host authorization")
    expected_owner = request.get("expected_owner")
    if not isinstance(expected_owner, dict):
        _fail("native recovery request has no typed expected owner")
    return authorization, request


def recover_idle_failure(
    paths: RuntimePaths | None = None,
    *,
    authorization_path: Path | None = None,
    cli: Path | None = None,
    timeout: float = 90.0,
) -> dict[str, Any] | None:
    """Recover exactly one failed native owner under an explicit host fence.

    This operation never drains or starts a service.  The native command is
    the sole owner of the locked ledger mutation (unknown/failed -> failed),
    and its receipt is checked before configuration generation rotation.
    """

    paths = paths or canonical_paths()
    if authorization_path is None:
        configured = os.environ.get(RECOVERY_AUTHORIZATION_ENV)
        if not configured:
            return None
        authorization_path = Path(configured)
    authorization, request = _read_recovery_authorization(paths, Path(authorization_path))
    result = _run_cli(
        paths,
        (
            "runtime",
            "service-recover",
            "--config",
            str(paths.config),
            "--request",
            str(authorization["native_request_path"]),
            "--request-sha256",
            str(authorization["native_request_sha256"]),
        ),
        timeout=timeout,
        cli=cli,
    )
    if not isinstance(result, dict):
        _fail("native runtime recovery returned a non-object")
    return _validate_native_recovery_result(paths, authorization, result)


def _validated_docker_host_id() -> str:
    """Return the daemon attestation required by the canonical host-ledger adapter."""

    if os.environ.get("FULLMAG_HOST_LEDGER_PROFILE") != HOST_LEDGER_PROFILE:
        _fail("Docker host initialization requires the canonical host-ledger-v1 profile")
    value = os.environ.get("FULLMAG_DOCKER_HOST_ID", "")
    if HEX64.fullmatch(value) is None:
        _fail("FULLMAG_DOCKER_HOST_ID must be the verified lowercase Docker daemon SHA-256")
    return value


def _initializer_host_id(daemon_host_id: str) -> str:
    """Select the logical policy ID without replacing an existing host ledger.

    The adapter's daemon digest remains in the process environment for physical
    attestation.  The native factory receives the logical ID already persisted by
    the ledger so a pre-existing legacy ``docker-all-host`` policy stays readable.
    The native service still validates the complete marker, policy, topology and
    readiness under its writer lock after this bounded read.
    """

    ledger_path = Path(HOST_LEDGER_ROOT) / HOST_RESOURCE_LEDGER_FILE
    try:
        document = _read_json(
            ledger_path, "existing host resource ledger", MAX_HOST_LEDGER_BYTES
        )
    except FileNotFoundError:
        # A genuinely fresh ledger is bound to this daemon, never to an arbitrary
        # fallback ID.  Partial markers are rejected by the native initializer.
        return daemon_host_id
    policy = document.get("policy")
    if not isinstance(policy, dict):
        _fail("existing host resource ledger has no validated policy")
    stored_host_id = policy.get("host_id")
    if not isinstance(stored_host_id, str) or not stored_host_id:
        _fail("existing host resource ledger policy has no host_id")
    if stored_host_id not in {LEGACY_DOCKER_HOST_ID, daemon_host_id}:
        _fail("existing host resource ledger host_id differs from the verified Docker daemon")
    return stored_host_id


def _atomic_json(path: Path, value: Mapping[str, Any], name: str) -> None:
    path = _absolute(path, name)
    parent = _ensure_directory(path.parent, f"{name} parent")
    data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
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


def _env_path(environment: Mapping[str, str], name: str, default: Path) -> Path:
    return _absolute(environment.get(name, str(default)), name)


def canonical_paths(environment: Mapping[str, str] | None = None) -> RuntimePaths:
    environment = os.environ if environment is None else environment
    state = _env_path(environment, "FULLMAG_CONTAINER_STATE_ROOT", STATE_ROOT)
    storage = _env_path(environment, "FULLMAG_PROJECT_STORAGE_ROOT", state)
    runs = _env_path(environment, "FULLMAG_RUNS_ROOT", storage / "runs" / WORKTREE_ID)
    state_root = _env_path(environment, "FULLMAG_STATE_ROOT", state / ".fullmag")
    source = _env_path(environment, "FULLMAG_REPO_ROOT", SOURCE_ROOT)
    package = _env_path(environment, "FULLMAG_RUNTIME_ROOT", PACKAGE_ROOT)
    config = state / CONFIG_RELATIVE
    if state != STATE_ROOT or storage != STATE_ROOT:
        _fail("all-in-Docker accepted storage is fixed to /state")
    if runs != STATE_ROOT / "runs" / WORKTREE_ID:
        _fail("FULLMAG_RUNS_ROOT must be /state/runs/docker-all")
    if state_root != STATE_ROOT / ".fullmag":
        _fail("FULLMAG_STATE_ROOT must be /state/.fullmag")
    if source != SOURCE_ROOT or package != PACKAGE_ROOT:
        _fail("all-in-Docker source and package roots are immutable")
    if environment.get("FULLMAG_WORKTREE_ID", WORKTREE_ID) != WORKTREE_ID:
        _fail("FULLMAG_WORKTREE_ID must be docker-all")
    if "FULLMAG_STATE_DIR" in environment and _absolute(
        environment["FULLMAG_STATE_DIR"], "FULLMAG_STATE_DIR"
    ) != state_root:
        _fail("FULLMAG_STATE_DIR must be /state/.fullmag")
    if "FULLMAG_RUNTIME_SERVICE_CONFIG" in environment and _absolute(
        environment["FULLMAG_RUNTIME_SERVICE_CONFIG"], "FULLMAG_RUNTIME_SERVICE_CONFIG"
    ) != config:
        _fail("FULLMAG_RUNTIME_SERVICE_CONFIG is outside the fixed config path")
    return RuntimePaths(
        state=state,
        storage=storage,
        runs=runs,
        store=runs / "session-store",
        state_root=state_root,
        source=source,
        package=package,
        config=config,
        provenance=IMAGE_ROOT / "provenance.json",
        host_certificate=HOST_CERTIFICATE,
    )


def prepare_storage(paths: RuntimePaths | None = None) -> RuntimePaths:
    """Prepare mapped directories and the fixed project marker only."""

    paths = paths or canonical_paths()
    if os.environ.get("FULLMAG_SESSION_STORAGE_PROFILE") != WINDOWS_STORAGE_PROFILE:
        _fail("all-in-Docker storage requires explicit windows-folder-v1 admission")
    _ensure_directory(paths.state, "container state")
    _ensure_directory(paths.state_root, "Fullmag state")
    _ensure_directory(
        paths.state_root / "local-live" / "current",
        "current live workspace",
    )
    _ensure_directory(paths.runs, "accepted runs root")
    _ensure_directory(paths.store.parent, "accepted store parent")
    marker = {"schema": STORAGE_SCHEMA, "project_root": str(IMAGE_ROOT)}
    marker_path = paths.state / ".fullmag-storage.json"
    try:
        current = _read_json(marker_path, "storage marker")
    except FileNotFoundError:
        _atomic_json(marker_path, marker, "storage marker")
    else:
        if current != marker:
            _fail("storage marker belongs to another project or schema")
    return paths


def api_environment(paths: RuntimePaths, config_path: Path | None = None) -> dict[str, str]:
    config_path = _absolute(config_path or paths.config, "runtime service config")
    if config_path != paths.config:
        _fail("runtime service config path is not canonical")
    values = {
        "HOME": str(paths.state),
        "FULLMAG_PROJECT_STORAGE_ROOT": str(paths.storage),
        "FULLMAG_RUNS_ROOT": str(paths.runs),
        "FULLMAG_WORKTREE_ID": WORKTREE_ID,
        "FULLMAG_STATE_ROOT": str(paths.state_root),
        "FULLMAG_STATE_DIR": str(paths.state_root),
        "FULLMAG_REPO_ROOT": str(paths.source),
        "FULLMAG_RUNTIME_ROOT": str(paths.package),
        "FULLMAG_SESSION_STORAGE_PROFILE": WINDOWS_STORAGE_PROFILE,
        "FULLMAG_RUNTIME_SERVICE_CONFIG": str(config_path),
    }
    image_id = os.environ.get("FULLMAG_RUNTIME_IMAGE_ID")
    if image_id:
        values["FULLMAG_RUNTIME_IMAGE_ID"] = image_id
    return values


def process_environment(
    paths: RuntimePaths, *, service: bool = False, config_path: Path | None = None
) -> dict[str, str]:
    environment = dict(os.environ)
    environment.update(api_environment(paths, config_path))
    if "FULLMAG_RUNTIME_PACKAGE_ROOT" in environment:
        environment["FULLMAG_RUNTIME_PACKAGE_ROOT"] = str(paths.package)
    environment.pop("FULLMAG_ACCEPTED_STORE_SCOPE", None)
    if service:
        for name in SERVICE_MODE_VARIABLES:
            environment.pop(name, None)
    return environment


def _positive(environment: Mapping[str, str], name: str, default: int) -> int:
    value = environment.get(name)
    try:
        parsed = default if value is None else int(value, 10)
    except (TypeError, ValueError):
        _fail(f"{name} must be a positive integer")
    if parsed <= 0:
        _fail(f"{name} must be a positive integer")
    return parsed


def build_configuration(
    paths: RuntimePaths | None = None, environment: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """Return the explicit v1 CPU profile admitted by the current API."""

    environment = os.environ if environment is None else environment
    paths = paths or canonical_paths(environment)
    storage = _positive(environment, "FULLMAG_RUNTIME_STORAGE_BYTES", GIB)
    compute = {
        "cpu_millis": _positive(environment, "FULLMAG_RUNTIME_COMPUTE_CPU_MILLIS", 3000),
        "memory_bytes": _positive(
            environment, "FULLMAG_RUNTIME_COMPUTE_MEMORY_BYTES", 6 * GIB
        ),
        "gpu_memory_bytes": 0,
        "storage_bytes": storage,
    }
    preparation = {
        "cpu_millis": _positive(
            environment, "FULLMAG_RUNTIME_PREPARATION_CPU_MILLIS", 1000
        ),
        "memory_bytes": _positive(
            environment, "FULLMAG_RUNTIME_PREPARATION_MEMORY_BYTES", GIB
        ),
        "gpu_memory_bytes": 0,
        "storage_bytes": storage,
    }
    if compute["cpu_millis"] + preparation["cpu_millis"] > 4000:
        _fail("runtime CPU budgets exceed the container limit")
    if compute["memory_bytes"] + preparation["memory_bytes"] > 7 * GIB:
        _fail("runtime memory budgets exceed the container limit minus API headroom")
    return {
        "schema_version": RUNTIME_CONFIG_SCHEMA,
        "store_root": str(paths.store),
        "target_id": TARGET_ID,
        "compute_pool_id": COMPUTE_POOL_ID,
        "preparation_pool_id": PREPARATION_POOL_ID,
        "compute_resources": [
            {"resource_id": "docker-all.compute.cpu", "kind": "cpu", "budget": compute}
        ],
        "preparation_resources": [
            {"resource_id": "docker-all.preparation.cpu", "budget": preparation}
        ],
        "worker_timeout_seconds": 31_536_000,
        "preparation_timeout_seconds": 31_536_000,
        "heartbeat_interval_milliseconds": 1000,
        "startup_timeout_seconds": 60,
        "drain_timeout_seconds": 30,
        "host_execution": None,
    }


def _validate_host_profile(value: Mapping[str, Any], paths: RuntimePaths) -> dict[str, Any]:
    """Check the fixed Docker boundary around the canonical Rust host factory."""
    if value.get("schema_version") != HOST_PROFILE_SCHEMA:
        _fail("native Docker host profile has an unsupported schema")
    config = value.get("configuration")
    if not isinstance(config, dict) or config.get("schema_version") != "runtime_service_config.v2":
        _fail("native Docker host profile requires runtime service configuration v2")
    fixed = {
        "store_root": str(paths.store),
        "target_id": TARGET_ID,
        "compute_pool_id": COMPUTE_POOL_ID,
        "preparation_pool_id": PREPARATION_POOL_ID,
    }
    if any(config.get(key) != expected for key, expected in fixed.items()):
        _fail("native Docker host profile changed the accepted-store or pool boundary")
    host = config.get("host_execution")
    if not isinstance(host, dict) or host.get("ledger_root") != str(HOST_LEDGER_ROOT):
        _fail("native Docker host profile must bind the managed /host-ledger/ledger")
    if host.get("schema_version") != "runtime_service_host_execution.v1":
        _fail("native Docker host execution schema is unsupported")
    generation = value.get("runtime_generation_sha256")
    if (not isinstance(generation, str)
            or not re.fullmatch(r"[0-9a-f]{64}", generation)
            or host.get("runtime_generation_sha256") != generation):
        _fail("Docker host profile must pin the exact native runtime generation")
    if host.get("compute_max_concurrency") != 1 or host.get("preparation_max_concurrency") != 1:
        _fail("Docker host profile requires one compute and one preparation worker")
    policy = host.get("policy")
    if not isinstance(policy, dict) or policy.get("schema_version") != "host_resource_ledger_policy.v2":
        _fail("Docker GPU requires the native readiness/topology-bound host policy v2")
    compute = config.get("compute_resources")
    preparation = config.get("preparation_resources")
    if (not isinstance(compute, list) or len(compute) != 2
            or not all(isinstance(offer, dict) for offer in compute)
            or {offer.get("kind") for offer in compute} != {"cpu", "gpu"}
            or not isinstance(preparation, list) or len(preparation) != 1
            or not isinstance(preparation[0], dict)):
        _fail("Docker host profile requires CPU, GPU and preparation offers")
    placements = host.get("compute_placements")
    prep_placements = host.get("preparation_cpu_ids")
    uuids = policy.get("gpu_vram_bytes_by_uuid")
    if (not isinstance(placements, dict) or not isinstance(prep_placements, dict)
            or not isinstance(uuids, dict) or len(uuids) != 1):
        _fail("Docker host profile lacks exact physical resource placements")
    gpu_uuid, vram = next(iter(uuids.items()))
    if (not isinstance(gpu_uuid, str)
            or not re.fullmatch(r"GPU-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", gpu_uuid)
            or type(vram) is not int or vram <= 0):
        _fail("Docker host profile requires one full physical NVIDIA UUID and measured VRAM")
    cpu_budgets, memory_budgets = [], []
    for offer in [*compute, *preparation]:
        budget = offer.get("budget")
        if not isinstance(budget, dict) or any(
            type(budget.get(key)) is not int or budget[key] <= 0
            for key in ("cpu_millis", "memory_bytes", "storage_bytes")
        ):
            _fail("Docker host profile has an invalid execution budget")
        gpu_bytes = budget.get("gpu_memory_bytes")
        if type(gpu_bytes) is not int or gpu_bytes < 0:
            _fail("Docker host profile has an invalid GPU memory budget")
        if offer.get("kind") == "gpu":
            placement = placements.get(offer.get("resource_id"))
            if (not isinstance(placement, dict) or placement.get("gpu_uuid") != gpu_uuid
                    or not 0 < gpu_bytes <= vram):
                _fail("Docker GPU offer differs from its physical device allocation")
        elif gpu_bytes != 0:
            _fail("Docker CPU/preparation offer cannot reserve GPU memory")
        cpu_budgets.append(budget["cpu_millis"])
        memory_budgets.append(budget["memory_bytes"])
    # Compute offers are mutually exclusive; preparation has its own slot.
    if max(cpu_budgets[:2]) + cpu_budgets[2] > 4000:
        _fail("Docker host offers exceed the backend CPU quota")
    if max(memory_budgets[:2]) + memory_budgets[2] > 7 * GIB:
        _fail("Docker host offers exceed memory minus API headroom")
    return config


def initialize_host_configuration(paths: RuntimePaths) -> dict[str, Any]:
    """Discover native devices and initialize the exact shared Rust ledger."""
    daemon_host_id = _validated_docker_host_id()
    logical_host_id = _initializer_host_id(daemon_host_id)
    executable = paths.package / "bin" / "fullmag-runtime-service"
    _assert_no_links(executable, "runtime service executable")
    if not executable.is_file() or not os.access(executable, os.X_OK):
        _fail("native runtime service executable is unavailable")
    try:
        result = subprocess.run(
            [str(executable), "--initialize-docker-host", "--ledger-root", str(HOST_LEDGER_ROOT),
             "--store-root", str(paths.store), "--host-id", logical_host_id],
            cwd=str(paths.state), env=process_environment(paths, service=True),
            stdin=subprocess.DEVNULL, capture_output=True, timeout=60,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeServiceUnknown(
            "native host initialization timed out; retain the ledger and do not retry automatically"
        ) from error
    if result.returncode:
        detail = (result.stderr or result.stdout).decode("utf-8", errors="replace")[-4096:]
        _fail("native Docker host profile initialization failed: " + detail)
    if len(result.stdout) > MAX_JSON_BYTES:
        _fail("native Docker host profile exceeds its bounded size")
    try:
        value = json.loads(result.stdout, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeServiceError("native Docker host profile is invalid JSON") from error
    if not isinstance(value, dict):
        _fail("native Docker host profile must contain an object")
    return _validate_host_profile(value, paths)


def _retain_previous_configuration(path: Path, raw: bytes) -> None:
    """Retain exact previous bytes before an explicitly authorized rotation."""
    _assert_no_links(path, "previous runtime configuration")
    try:
        descriptor = os.open(
            path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o440
        )
    except FileExistsError:
        if _bounded_regular(path, "previous runtime configuration") != raw:
            _fail("previous runtime configuration backup differs from its digest")
        return
    try:
        view = memoryview(raw)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                _fail("short write retaining previous runtime configuration")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    if _bounded_regular(path, "previous runtime configuration") != raw:
        _fail("previous runtime configuration backup verification failed")


def _rotate_configuration_generation(
    paths: RuntimePaths, current: dict[str, Any], expected: dict[str, Any], previous_sha256: str
) -> None:
    """Change only the generation after the launcher verified an owned stop."""
    old_host, new_host = current.get("host_execution"), expected.get("host_execution")
    if not isinstance(old_host, dict) or not isinstance(new_host, dict):
        _fail("runtime configuration rotation requires the same native host profile")
    old_generation, new_generation = (
        old_host.get("runtime_generation_sha256"), new_host.get("runtime_generation_sha256")
    )
    if (not isinstance(new_generation, str) or not HEX64.fullmatch(new_generation)
            or (old_generation is not None
                and (not isinstance(old_generation, str) or not HEX64.fullmatch(old_generation)))):
        _fail("runtime configuration rotation has an invalid generation")
    old_profile, new_profile = dict(old_host), dict(new_host)
    old_profile.pop("runtime_generation_sha256", None)
    new_profile.pop("runtime_generation_sha256", None)
    if ({**current, "host_execution": old_profile}
            != {**expected, "host_execution": new_profile}):
        _fail("runtime configuration rotation cannot change the operator profile")
    raw = _bounded_regular(paths.config, "runtime configuration before rotation")
    if hashlib.sha256(raw).hexdigest() != previous_sha256:
        _fail("runtime configuration changed since the authorized recreate")
    if json.loads(raw, object_pairs_hook=_reject_duplicate_keys) != current:
        _fail("runtime configuration changed during rotation validation")
    backup = paths.config.with_name(f"docker-all.previous-{previous_sha256}.json")
    _retain_previous_configuration(backup, raw)
    if _bounded_regular(paths.config, "runtime configuration before publication") != raw:
        _fail("runtime configuration changed before generation publication")
    _atomic_json(paths.config, expected, "runtime configuration generation")
    if _read_json(paths.config, "runtime configuration after rotation") != expected:
        _fail("runtime configuration generation publication did not retain the expected profile")


def ensure_configuration(paths: RuntimePaths | None = None) -> dict[str, Any]:
    paths = paths or canonical_paths()
    host_mode = os.environ.get("FULLMAG_DOCKER_HOST_EXECUTION", "0")
    if host_mode not in {"0", "1"}:
        _fail("FULLMAG_DOCKER_HOST_EXECUTION must be 0 or 1")
    previous_sha256 = os.environ.get("FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256")
    if previous_sha256 is not None and (
        host_mode != "1" or not HEX64.fullmatch(previous_sha256)
    ):
        _fail("FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256 requires native host mode and a lowercase SHA-256")
    expected = initialize_host_configuration(paths) if host_mode == "1" else build_configuration(paths)
    try:
        current = _read_json(paths.config, "runtime service configuration")
    except FileNotFoundError:
        if previous_sha256 is not None:
            _fail("authorized recreate runtime configuration is missing")
        _atomic_json(paths.config, expected, "runtime service configuration")
        return expected
    if current != expected:
        if previous_sha256 is None:
            if host_mode != "1":
                _fail("stable runtime service configuration differs from the operator profile")
            # A normal Docker restart has no host-side config digest.  Derive
            # it from the exact current bytes only after the previous native
            # owner has published an authenticated, successful drain.  The
            # lock and all owner/pin/receipt checks remain inside this fence.
            with _authenticated_terminal_drain(paths) as assert_owner_lock:
                previous_sha256 = hashlib.sha256(
                    _bounded_regular(paths.config, "runtime configuration before automatic rotation")
                ).hexdigest()
                assert_owner_lock()
                _rotate_configuration_generation(paths, current, expected, previous_sha256)
        else:
            _rotate_configuration_generation(paths, current, expected, previous_sha256)
        return expected
    return current


def _cli_path(paths: RuntimePaths, cli: Path | None = None) -> Path:
    executable = _absolute(cli or paths.package / "bin" / "fullmag-bin", "fullmag-bin")
    _assert_no_links(executable.parent, "fullmag-bin parent")
    if not executable.is_file() or not os.access(executable, os.X_OK):
        _fail("fullmag-bin bootstrap/lifecycle executable is missing or not executable")
    return executable


def _run_cli(
    paths: RuntimePaths,
    arguments: Sequence[str],
    *,
    timeout: float,
    cli: Path | None = None,
) -> dict[str, Any]:
    executable = _cli_path(paths, cli)
    if timeout <= 0:
        _fail("runtime CLI timeout must be positive")
    process = subprocess.Popen(
        [str(executable), *arguments],
        cwd=str(paths.state),
        env=process_environment(paths, service=True),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise RuntimeServiceUnknown(
            "runtime CLI timed out; outcome is unknown and no retry is allowed"
        ) from error
    if process.returncode != 0:
        detail = (stderr or stdout or "runtime CLI failed").strip()
        raise RuntimeServiceError(f"runtime CLI failed: {detail[-4096:]}")
    if len(stdout.encode()) > MAX_JSON_BYTES:
        _fail("runtime CLI JSON exceeds its bounded size")
    try:
        value = json.loads(stdout, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"runtime CLI returned invalid JSON: {error}")
    if not isinstance(value, dict):
        _fail("runtime CLI must return a JSON object")
    return value


def _recovery_relative_path(value: Any, name: str) -> PurePosixPath:
    """Validate a Rust store-relative recovery path without host path rules."""

    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value:
        _fail(f"{name} must be a relative store path")
    parsed = PurePosixPath(value)
    if any(part in {"", ".", ".."} for part in parsed.parts) or parsed.is_absolute():
        _fail(f"{name} contains parent or empty path components")
    return parsed


def _recovery_store_id(value: Any, name: str) -> str:
    """Mirror the native portable store-id boundary for archive paths."""

    if not isinstance(value, str) or STORE_ID_RE.fullmatch(value) is None:
        _fail(f"{name} is not a native store identifier")
    if value in {".", ".."} or value.endswith("."):
        _fail(f"{name} is not a native store identifier")
    stem = value.split(".", 1)[0].upper()
    if stem in {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"} or (
        len(stem) == 4 and stem[:3] in {"COM", "LPT"} and stem[3] in "123456789"
    ):
        _fail(f"{name} is a reserved native store identifier")
    return value


def _recovery_mandatory_sources(owner: Mapping[str, Any]) -> set[str]:
    """Build the exact twelve-entry inventory emitted by the native helper."""

    owner_token = _recovery_store_id(owner.get("owner_token"), "runtime recovery owner token")
    compute_pool = _recovery_store_id(
        owner.get("compute_pool_id"), "runtime recovery compute pool id"
    )
    preparation_pool = _recovery_store_id(
        owner.get("preparation_pool_id"), "runtime recovery preparation pool id"
    )
    sources = {
        "runtime-services/OWNER.json",
        "runtime-services/OWNER.lock",
        "runtime-services/LAUNCH.json",
        "runtime-services/LAUNCH.lock",
        "runtime-services/STARTUP-GATE.lock",
        f"runtime-services/{owner_token}/compute.stdout.jsonl",
        f"runtime-services/{owner_token}/preparation.stdout.jsonl",
        f"scheduler_pools/{compute_pool}.resources.json",
        f"scheduler_pools/{preparation_pool}.preparation-resources.json",
        f"scheduler_pools/{compute_pool}.json",
        f"scheduler_pools/{preparation_pool}.preparation.json",
        RECOVERY_ARCHIVED_CONFIGURATION_KEY,
    }
    if len(sources) != RECOVERY_MANDATORY_ARCHIVED_FILES:
        _fail("native runtime recovery archive inventory has duplicate mandatory paths")
    return sources


def _recovery_checkpoint_sources(owner: Mapping[str, Any]) -> set[str]:
    compute_pool = _recovery_store_id(
        owner.get("compute_pool_id"), "runtime recovery compute pool id"
    )
    preparation_pool = _recovery_store_id(
        owner.get("preparation_pool_id"), "runtime recovery preparation pool id"
    )
    return {
        f"scheduler_pools/{compute_pool}.json",
        f"scheduler_pools/{preparation_pool}.preparation.json",
    }


def _recovery_log_sources(owner: Mapping[str, Any]) -> set[str]:
    owner_token = _recovery_store_id(owner.get("owner_token"), "runtime recovery owner token")
    prefix = f"runtime-services/{owner_token}/"
    return {
        prefix + name
        for name in (
            "compute.stdout.jsonl",
            "compute.stderr.log",
            "preparation.stdout.jsonl",
            "preparation.stderr.log",
            "compute-publisher.stdout.jsonl",
            "compute-publisher.stderr.log",
            "preparation-publisher.stdout.jsonl",
            "preparation-publisher.stderr.log",
        )
    }


def _observe_recovery_log_sources(paths: RuntimePaths, owner: Mapping[str, Any]) -> set[str]:
    owner_token = _recovery_store_id(owner.get("owner_token"), "runtime recovery owner token")
    log_dir = paths.store / "runtime-services" / owner_token
    _assert_no_links(log_dir, "native recovery scheduler evidence")
    if not log_dir.is_dir() or log_dir.is_symlink():
        _fail("native recovery scheduler evidence directory is missing")
    allowed = _recovery_log_sources(owner)
    observed: set[str] = set()
    try:
        entries = list(log_dir.iterdir())
    except OSError as error:
        _fail(f"cannot enumerate native recovery scheduler evidence: {error}")
    for entry in entries:
        if entry.is_symlink() or not entry.is_file():
            _fail("native recovery scheduler evidence contains a non-regular entry")
        relative = f"runtime-services/{owner_token}/{entry.name}"
        if relative not in allowed:
            _fail(f"native recovery scheduler evidence contains an unexpected entry {entry.name}")
        observed.add(relative)
    mandatory = {
        f"runtime-services/{owner_token}/compute.stdout.jsonl",
        f"runtime-services/{owner_token}/preparation.stdout.jsonl",
    }
    if not mandatory.issubset(observed):
        _fail("native recovery scheduler evidence is missing a mandatory journal")
    return observed


def _validate_native_recovery_result(
    paths: RuntimePaths, authorization: Mapping[str, Any], result: Mapping[str, Any]
) -> dict[str, Any]:
    """Validate the exact Rust recovery receipt and every archived source file."""

    if (
        result.get("schema_version") != "runtime_service_recovery.v1"
        or result.get("status") != "recovered"
        or result.get("outcome") != "failed"
        or result.get("request_id") != authorization.get("request_id")
        or result.get("request_sha256") != authorization.get("native_request_sha256")
        or result.get("config_sha256") != authorization.get("config_sha256")
        or result.get("owner_sha256_before") != authorization.get("owner_sha256")
        or result.get("owner_state_after") != "failed"
    ):
        _fail("native runtime recovery receipt is incomplete or not a failed-owner recovery")
    after = result.get("owner_sha256_after")
    if not isinstance(after, str) or HEX64.fullmatch(after) is None \
            or after == authorization.get("owner_sha256"):
        _fail("native runtime recovery did not publish a new failed-owner descriptor")
    archive_value = result.get("archived_evidence_path")
    if not isinstance(archive_value, str):
        _fail("native runtime recovery omitted its absolute archive manifest path")
    archive_manifest = _absolute(Path(archive_value), "native recovery archive manifest")
    try:
        archive_manifest.relative_to(paths.state)
    except ValueError:
        _fail("native runtime recovery archive is outside the fixed state root")
    expected_archive = paths.store / "runtime-services" / "recovery" / authorization[
        "native_request_sha256"
    ] / "archive" / "manifest.json"
    if archive_manifest != expected_archive:
        _fail("native runtime recovery archive is not bound to the request")
    archived_sha = result.get("archived_evidence_sha256")
    if not isinstance(archived_sha, str) or HEX64.fullmatch(archived_sha) is None:
        _fail("native runtime recovery archive manifest digest is invalid")
    manifest_bytes = _bounded_regular(
        archive_manifest, "native recovery archive manifest", MAX_RECOVERY_AUTHORIZATION_BYTES
    )
    if _sha256_bytes(manifest_bytes) != archived_sha:
        _fail("native runtime recovery archive manifest changed after publication")
    try:
        manifest = json.loads(
            manifest_bytes.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"native runtime recovery archive manifest is not valid JSON: {error}")
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema_version") != "runtime_service_recovery_archive.v1"
        or manifest.get("request_sha256") != authorization.get("native_request_sha256")
        or manifest.get("config_sha256") != authorization.get("config_sha256")
    ):
        _fail("native runtime recovery archive manifest identity differs from the request")
    archived = result.get("archived_files")
    absent = result.get("archived_absent_sources", {})
    if (
        not isinstance(archived, dict)
        or not isinstance(absent, dict)
        or len(archived) + len(absent) < RECOVERY_MANDATORY_ARCHIVED_FILES
        or len(archived) + len(absent) > MAX_RECOVERY_ARCHIVED_FILES
    ):
        _fail("native runtime recovery archive inventory is incomplete")
    if manifest.get("files") != archived:
        _fail("native runtime recovery archive manifest inventory differs from the receipt")
    if manifest.get("absent_sources", {}) != absent:
        _fail("native runtime recovery absent-source inventory differs from the receipt")
    current_owner_path = paths.store / "runtime-services" / "OWNER.json"
    current_owner_raw = _bounded_regular(
        current_owner_path, "native recovery current owner", MAX_JSON_BYTES
    )
    try:
        current_owner = json.loads(
            current_owner_raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"native recovery current owner is not valid JSON: {error}")
    if not isinstance(current_owner, dict):
        _fail("native recovery current owner must contain an object")
    mandatory_sources = _recovery_mandatory_sources(current_owner)
    checkpoint_sources = _recovery_checkpoint_sources(current_owner)
    absent_sources = set(absent)
    if not all(
        isinstance(source, str) and reason == RECOVERY_ABSENT_SOURCE_REASON
        for source, reason in absent.items()
    ):
        _fail("native runtime recovery absent-source reason is invalid")
    if not absent_sources.issubset(checkpoint_sources):
        _fail("native runtime recovery marked a non-checkpoint source absent")
    if set(archived).intersection(absent_sources):
        _fail("native runtime recovery source is both present and absent")
    observed_logs = _observe_recovery_log_sources(paths, current_owner)
    allowed_sources = mandatory_sources | _recovery_log_sources(current_owner)
    coverage = set(archived) | absent_sources
    if not coverage.issuperset(mandatory_sources) or not coverage.issubset(allowed_sources):
        _fail("native runtime recovery archive inventory is missing or contains unexpected evidence")
    if coverage != mandatory_sources | observed_logs:
        _fail("native runtime recovery archive inventory differs from the live namespace")
    owner_source = archived.get("runtime-services/OWNER.json")
    if owner_source != authorization.get("owner_sha256"):
        _fail("native runtime recovery archive does not pin the pre-recovery owner")
    archive_root = archive_manifest.parent
    _assert_no_links(archive_root, "native recovery archive")
    if not archive_root.is_dir() or archive_root.is_symlink():
        _fail("native runtime recovery archive is not a directory")
    for source_value, expected_digest in archived.items():
        source_relative = _recovery_relative_path(source_value, "native archived source path")
        if not isinstance(expected_digest, str) or HEX64.fullmatch(expected_digest) is None:
            _fail("native archived source digest is invalid")
        maximum = (
            MAX_RECOVERY_LOG_BYTES
            if str(source_relative).endswith((".jsonl", ".log"))
            else MAX_JSON_BYTES
        )
        archive_path = archive_root / source_relative.name
        archive_bytes = _bounded_regular(archive_path, "native recovery archive evidence", maximum)
        if _sha256_bytes(archive_bytes) != expected_digest:
            _fail(f"native recovery archive evidence changed: {source_relative}")
        if source_value == RECOVERY_ARCHIVED_CONFIGURATION_KEY:
            if expected_digest != authorization.get("config_sha256"):
                _fail("native recovery raw configuration archive digest is not pinned")
            continue
        source_path = paths.store.joinpath(*source_relative.parts)
        source_bytes = _bounded_regular(source_path, "native recovery source evidence", maximum)
        if source_value == "runtime-services/OWNER.json":
            if _sha256_bytes(source_bytes) != after:
                _fail("native recovery owner descriptor changed outside its pinned transition")
        else:
            if _sha256_bytes(source_bytes) != expected_digest:
                _fail(f"native recovery source evidence changed: {source_relative}")
            if archive_bytes != source_bytes:
                _fail(f"native recovery archive evidence differs: {source_relative}")
    for source_value in absent_sources:
        source_relative = _recovery_relative_path(source_value, "native absent source path")
        source_path = paths.store.joinpath(*source_relative.parts)
        _assert_no_links(source_path.parent, "native absent source parent")
        if os.path.lexists(source_path):
            _fail(f"native recovery absent source exists: {source_relative}")
    return dict(result)


def initialize_accepted_store(
    paths: RuntimePaths | None = None, cli: Path | None = None
) -> dict[str, Any]:
    """Invoke the Rust fixed-layout bootstrap before starting the API."""

    paths = paths or canonical_paths()
    prepare_storage(paths)
    result = _run_cli(
        paths,
        ("runtime", "initialize-docker-accepted-store"),
        timeout=STORE_BOOTSTRAP_CLI_TIMEOUT_SECONDS,
        cli=cli,
    )
    if result.get("schema", result.get("schema_version")) != (
        "fullmag.docker-accepted-store-bootstrap.v1"
    ):
        _fail("Rust accepted-store bootstrap returned an unexpected schema")
    if result.get("store_root") != str(paths.store):
        _fail("Rust accepted-store bootstrap returned a different store root")
    if not isinstance(result.get("binding"), str) or not HEX64.fullmatch(result["binding"]):
        _fail("Rust accepted-store bootstrap returned an invalid binding")
    return result


def _http_json(
    port: int, path: str, *, timeout: float = 5.0
) -> tuple[int, list[tuple[str, str]], dict[str, Any]]:
    if not 1 <= port <= 65535 or not path.startswith("/"):
        _fail("invalid loopback API probe")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request("GET", path, headers={"Host": "localhost", "Connection": "close"})
        response = connection.getresponse()
        body = response.read(MAX_HTTP_BYTES + 1)
        if len(body) > MAX_HTTP_BYTES:
            _fail("API identity response exceeds its bounded size")
        value = json.loads(body, object_pairs_hook=_reject_duplicate_keys)
        if not isinstance(value, dict):
            _fail(f"API {path} response must be a JSON object")
        return response.status, response.getheaders(), value
    except OSError as error:
        raise RuntimeServiceTransportError(
            f"API loopback probe failed for {path}: {error}"
        ) from error
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeServiceError(f"API loopback probe failed for {path}: {error}") from error
    finally:
        connection.close()


def _single_header(headers: list[tuple[str, str]], name: str) -> str:
    values = [value.strip() for key, value in headers if key.lower() == name.lower()]
    if len(values) != 1:
        _fail(f"API header {name} is missing or ambiguous")
    return values[0]


def _source_identity(paths: RuntimePaths) -> tuple[str, str]:
    provenance = _read_json(paths.provenance, "runtime image provenance")
    commit = provenance.get("commit")
    native = provenance.get("native_source_identity")
    snapshot = native.get("source_snapshot_sha256") if isinstance(native, dict) else None
    if not isinstance(commit, str) or not HEX40.fullmatch(commit):
        _fail("runtime image provenance has no pinned source commit")
    if not isinstance(snapshot, str) or not HEX64.fullmatch(snapshot):
        _fail("runtime image provenance has no pinned source snapshot")
    return commit, snapshot


def _probe_api_identity(
    paths: RuntimePaths, port: int, expected_binding: str, *, timeout: float = 5.0
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Validate one complete API identity and return it with the profile document."""

    if timeout <= 0:
        _fail("API probe timeout must be positive")
    if not HEX64.fullmatch(expected_binding):
        _fail("API accepted-store binding must be a lowercase SHA-256")
    commit, snapshot = _source_identity(paths)
    status, headers, document = _http_json(
        port, "/v2/platform/openapi.json", timeout=timeout
    )
    contract_version = _single_header(headers, "x-api-contract-version")
    if status != 200 or contract_version != "1.0.0":
        _fail("API contract identity is not Fullmag v1")
    instance = _single_header(headers, "x-fullmag-api-instance")
    if not UUID_RE.fullmatch(instance):
        _fail("API instance identity is not a canonical UUID")
    build_identity = document.get("x-fullmag-build-identity")
    if not isinstance(build_identity, dict) or build_identity.get("git_commit") != commit:
        _fail("API build commit differs from the image")
    if build_identity.get("source_snapshot_sha256") != snapshot:
        _fail("API source snapshot differs from the image")
    paths_document = document.get("paths")
    if (
        not isinstance(paths_document, dict)
        or "/v2/sessions/current/model/scene" not in paths_document
    ):
        _fail("API v2 contract is incomplete")
    store_binding = document.get("x-fullmag-runtime-store-binding")
    if (
        not isinstance(store_binding, dict)
        or store_binding.get("schema_version") != "runtime_store_binding.v1"
        or store_binding.get("kind") != "accepted_runs"
        or store_binding.get("binding") != expected_binding
    ):
        _fail("API accepted-store binding differs from /state")
    profile_status, _, profile = _http_json(
        port, "/v2/platform/compute/profiles?limit=100", timeout=timeout
    )
    if profile_status != 200:
        _fail("API compute profile route is unavailable")
    return (
        {
            "api_instance_id": instance,
            "api_contract_version": contract_version,
            "build_identity": build_identity,
            "runtime_store_binding": store_binding,
        },
        profile,
    )


def _probe_api_liveness(
    port: int,
    expected_identity: Mapping[str, Any],
    *,
    timeout: float = API_LIVENESS_TIMEOUT_SECONDS,
) -> None:
    """Check the thin authoritative runtime resource and immutable API headers."""

    expected_instance = expected_identity.get("api_instance_id")
    expected_contract = expected_identity.get("api_contract_version")
    if not isinstance(expected_instance, str) or not isinstance(expected_contract, str):
        _fail("runtime handle has incomplete API liveness identity")
    status, headers, document = _http_json(
        port, "/v2/platform/runtime-service", timeout=timeout
    )
    if status != 200 or _single_header(headers, "x-api-contract-version") != expected_contract:
        _fail("API runtime-service liveness contract changed")
    if _single_header(headers, "x-fullmag-api-instance") != expected_instance:
        _fail("API instance identity changed during supervision")
    if document.get("schema_version") != "application_service_status.v1":
        _fail("API runtime-service liveness schema changed")
    configured = document.get("configured")
    state = document.get("state")
    reason = document.get("reason")
    if (
        type(configured) is not bool
        or not isinstance(state, str)
        or not isinstance(reason, dict)
        or not isinstance(reason.get("code"), str)
        or not isinstance(reason.get("message"), str)
        or len(reason["message"].encode("utf-8")) > MAX_LIVENESS_REASON_BYTES
    ):
        _fail("API runtime-service liveness document is invalid")
    if configured is True and state == "ready":
        return
    raise RuntimeServiceNotReady(
        configured=configured,
        state=state,
        reason_code=reason["code"],
        reason_message=reason["message"],
        retryable=(
            configured is True
            and state == "starting"
            and reason["code"] == "owner_starting"
        ),
    )


def _wait_for_api_liveness(
    port: int,
    expected_identity: Mapping[str, Any],
    *,
    timeout: float,
    handle: RuntimeHandle | None = None,
) -> None:
    """Wait briefly for a pinned service to publish ``ready`` during startup.

    Identity, contract, and malformed-observation failures remain fail-closed.
    Only the native service's explicit ``starting`` state is retried without
    an owner handle.  A pinned startup handle may additionally retry the
    typed ``observation_unknown`` liveness observations, but only after a
    fresh exact owner-file proof.  Identity, contract, malformed-owner, and
    pin failures remain fail-closed.
    """

    if timeout <= 0:
        _fail("API liveness startup grace must be positive")
    deadline = time.monotonic() + timeout
    last: BaseException | None = None
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            if last is None:
                _fail("API runtime-service startup grace ended without an observation")
            unknown = RuntimeServiceUnknown(
                f"API runtime-service did not become ready during startup grace: {last}"
            )
            observation = getattr(last, "liveness_observation", None)
            if isinstance(observation, dict):
                unknown.liveness_observation = observation
            raise unknown from last
        try:
            _probe_api_liveness(
                port,
                expected_identity,
                timeout=min(API_LIVENESS_TIMEOUT_SECONDS, remaining),
            )
            return
        except RuntimeServiceNotReady as error:
            if error.retryable:
                last = error
            elif handle is not None and _is_transient_supervision_observation(error):
                # Do not turn an owner-read/live-probe race into a startup
                # grace period unless the exact pinned native owner is still
                # readable.  A changed or malformed owner fails immediately.
                _assert_pinned_ready_owner(handle)
                last = error
            else:
                raise
        except (RuntimeServiceTransportError, OSError) as error:
            if handle is None:
                raise
            # A transport timeout is retryable only while the exact pinned
            # native owner remains readable.  Otherwise startup fails closed.
            _assert_pinned_ready_owner(handle)
            last = error
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            continue
        time.sleep(min(0.2, remaining))


def wait_for_api(
    paths: RuntimePaths, port: int, expected_binding: str, timeout: float = 60.0
) -> Mapping[str, Any]:
    """Pin API source, instance, accepted store, and the v2 profile route."""

    if timeout <= 0:
        _fail("API startup timeout must be positive")
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            identity, profile = _probe_api_identity(
                paths, port, expected_binding, timeout=5.0
            )
            return {**identity, "profiles": profile}
        except (RuntimeServiceError, OSError) as error:
            last_error = error
        time.sleep(0.2)
    raise RuntimeServiceUnknown(f"API binding did not become ready: {last_error}")


def _owner_fingerprint(owner: Mapping[str, Any]) -> str:
    identity = _owner_identity(owner)
    children = owner.get("children")
    if not isinstance(children, list):
        _fail("canonical runtime service output omitted children")
    compact: list[list[Any]] = []
    for child in children:
        if not isinstance(child, dict):
            _fail("canonical runtime service output has an invalid child")
        compact.append([child.get("role"), child.get("pid"), child.get("status")])
    compact.sort(key=lambda item: (str(item[0]), str(item[1])))
    return json.dumps(
        {"identity": identity, "children": compact},
        sort_keys=True,
        separators=(",", ":"),
    )


def _owner_identity(owner: Mapping[str, Any]) -> dict[str, Any]:
    fields = (
        "owner_token",
        "process_start_token",
        "pid",
        "host",
        "target_id",
        "control_address",
        "build_commit",
        "build_snapshot",
        "compute_pool_id",
        "preparation_pool_id",
        "compute_pool_generation",
        "preparation_pool_generation",
    )
    return {field: owner.get(field) for field in fields}


def _owner_child_identity(owner: Mapping[str, Any]) -> list[tuple[Any, Any]]:
    children = owner.get("children")
    if not isinstance(children, list):
        _fail("canonical runtime service output omitted children")
    identity: list[tuple[Any, Any]] = []
    for child in children:
        if not isinstance(child, dict):
            _fail("canonical runtime service output has an invalid child")
        identity.append((child.get("role"), child.get("pid")))
    return sorted(identity, key=lambda item: (str(item[0]), str(item[1])))


def _terminal_owner_children(owner: Mapping[str, Any], *, state: str, name: str) -> None:
    """Require the two native scheduler children for one terminal proof."""

    children = owner.get("children")
    if not isinstance(children, list) or len(children) != 2:
        _fail(f"{name} has no exact compute and preparation child proof")
    by_role: dict[str, Mapping[str, Any]] = {}
    pids: set[int] = set()
    for child in children:
        if not isinstance(child, dict):
            _fail(f"{name} has an invalid scheduler child")
        role = child.get("role")
        pid = child.get("pid")
        if role in by_role or role not in {"compute", "preparation"}:
            _fail(f"{name} has an unexpected scheduler child set")
        if type(pid) is not int or pid <= 0 or pid in pids:
            _fail(f"{name} has an invalid scheduler child pid")
        by_role[role] = child
        pids.add(pid)
    if set(by_role) != {"compute", "preparation"}:
        _fail(f"{name} has an unexpected scheduler child set")
    expected_status = "running" if state == "ready" else "exited_success"
    if any(child.get("status") != expected_status for child in by_role.values()):
        _fail(f"{name} child status is not {expected_status}")


def _validate_terminal_owner(owner: Mapping[str, Any], *, state: str, name: str) -> None:
    if owner.get("schema_version") != "runtime_service_owner.v1":
        _fail(f"{name} schema is unsupported")
    if owner.get("state") != state:
        _fail(f"{name} is not {state}")
    if owner.get("protocol") != "stdin-v1" or owner.get("target_id") != TARGET_ID:
        _fail(f"{name} is bound to a different runtime service")
    token = owner.get("owner_token")
    start_token = owner.get("process_start_token")
    if (not isinstance(token, str) or UUID_RE.fullmatch(token) is None
            or not isinstance(start_token, str) or UUID_RE.fullmatch(start_token) is None):
        _fail(f"{name} has invalid owner identity")
    if type(owner.get("pid")) is not int or owner["pid"] <= 0:
        _fail(f"{name} has an invalid owner pid")
    if not isinstance(owner.get("host"), str) or not owner["host"]:
        _fail(f"{name} has no host identity")
    for field in ("acquired_at", "heartbeat_at"):
        if not isinstance(owner.get(field), str) or not owner[field]:
            _fail(f"{name} has no {field} timestamp")
    for field, pattern in (("build_commit", HEX40), ("build_snapshot", HEX64)):
        value = owner.get(field)
        if not isinstance(value, str) or pattern.fullmatch(value) is None:
            _fail(f"{name} has invalid {field}")
    for field in ("compute_pool_generation", "preparation_pool_generation"):
        if type(owner.get(field)) is not int or owner[field] <= 0:
            _fail(f"{name} has invalid {field}")
    compute_pool = owner.get("compute_pool_id")
    preparation_pool = owner.get("preparation_pool_id")
    if (not isinstance(compute_pool, str) or not compute_pool
            or not isinstance(preparation_pool, str) or not preparation_pool
            or compute_pool == preparation_pool):
        _fail(f"{name} has invalid scheduler pool identity")
    if not isinstance(owner.get("control_address"), str) or not owner["control_address"]:
        _fail(f"{name} has no control address")
    _terminal_owner_children(owner, state=state, name=name)
    _owner_fingerprint(owner)


def _read_authenticated_terminal_drain(paths: RuntimePaths) -> dict[str, Any]:
    """Validate the previous entrypoint's authenticated terminal drain proof."""

    receipt_path = paths.state_root / "runtime-service/process-tree.json"
    receipt = _read_json(receipt_path, "previous runtime service process receipt")
    if (receipt.get("schema") != "fullmag.docker-process-tree.v1"
            or receipt.get("state") != "drained"):
        _fail("runtime configuration rotation requires an authenticated drained process receipt")
    service_owner_present = "service_owner" in receipt
    service_owner = receipt.get("service_owner")
    terminal_owner = receipt.get("terminal_service_owner")
    if not isinstance(terminal_owner, dict) or (
        service_owner_present and not isinstance(service_owner, dict)
    ):
        _fail("drained process receipt has no complete owner transition")
    _validate_terminal_owner(terminal_owner, state="drained", name="terminal service owner")
    if service_owner_present:
        _validate_terminal_owner(service_owner, state="ready", name="previous service owner")

    owner_path = paths.store / "runtime-services" / "OWNER.json"
    owner = _read_json(owner_path, "terminal runtime service owner")
    _validate_terminal_owner(owner, state="drained", name="persisted terminal owner")
    if (_owner_identity(owner) != _owner_identity(terminal_owner)
            or _owner_child_identity(owner) != _owner_child_identity(terminal_owner)):
        _fail("persisted terminal owner differs from the authenticated drain receipt")

    if service_owner_present:
        pin_path = _owner_pin_path(paths, service_owner)
    else:
        # Older failure receipts omitted service_owner when activation failed
        # after service.start().  The durable ready pin is the only compatible
        # source, and it must still match the terminal owner exactly.
        pin_path = _owner_pin_path(paths, terminal_owner)
    pin = _read_json(pin_path, "previous pinned runtime service owner")
    _validate_terminal_owner(pin, state="ready", name="previous pinned service owner")
    if service_owner_present:
        if _owner_fingerprint(pin) != _owner_fingerprint(service_owner):
            _fail("previous pinned service owner differs from the authenticated drain receipt")
    elif (_owner_identity(pin) != _owner_identity(terminal_owner)
          or _owner_child_identity(pin) != _owner_child_identity(terminal_owner)):
        _fail("previous pinned service owner differs from the authenticated drain receipt")
    service_owner = pin if not service_owner_present else service_owner
    if (_owner_identity(service_owner) != _owner_identity(terminal_owner)
            or _owner_child_identity(service_owner) != _owner_child_identity(terminal_owner)):
        _fail("previous pinned service owner differs from the authenticated drain receipt")
    return {"receipt": receipt, "owner": owner, "pin": pin}


def _assert_owner_lock_identity(
    lock_path: Path, descriptor: int, expected_identity: tuple[int, int]
) -> None:
    descriptor_stat = os.fstat(descriptor)
    if not stat.S_ISREG(descriptor_stat.st_mode):
        _fail("runtime service owner lock is not a regular file")
    try:
        path_stat = os.stat(lock_path, follow_symlinks=False)
    except OSError as error:
        _fail(f"runtime service owner lock changed during rotation: {error}")
    if (not stat.S_ISREG(path_stat.st_mode)
            or (path_stat.st_dev, path_stat.st_ino) != expected_identity
            or (descriptor_stat.st_dev, descriptor_stat.st_ino) != expected_identity):
        _fail("runtime service owner lock changed during rotation")


@contextmanager
def _authenticated_terminal_drain(paths: RuntimePaths):
    """Hold the native owner lock while validating and rotating generations."""

    lock_path = paths.store / "runtime-services" / "OWNER.lock"
    _assert_no_links(lock_path, "runtime service owner lock")
    try:
        import fcntl
    except ImportError as error:
        _fail(f"runtime service owner lock cannot be probed on this platform: {error}")
    try:
        descriptor = os.open(lock_path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        _fail("runtime service owner lock is missing; controlled recovery required")
    try:
        descriptor_stat = os.fstat(descriptor)
        if not stat.S_ISREG(descriptor_stat.st_mode):
            _fail("runtime service owner lock is not a regular file")
        expected_identity = (descriptor_stat.st_dev, descriptor_stat.st_ino)
        _assert_owner_lock_identity(lock_path, descriptor, expected_identity)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            _fail("runtime service owner is still active; configuration rotation refused")
        except OSError as error:
            if getattr(error, "errno", None) in {11, 13}:
                _fail("runtime service owner is still active; configuration rotation refused")
            raise
        try:
            _read_authenticated_terminal_drain(paths)
            _assert_owner_lock_identity(lock_path, descriptor, expected_identity)
            yield lambda: _assert_owner_lock_identity(lock_path, descriptor, expected_identity)
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


def _is_transient_supervision_observation(error: BaseException) -> bool:
    """Classify only transport and the typed live-probe observation failure.

    Schema, API identity, accepted-store binding, and owner mismatches remain
    permanent supervision failures.  In particular, ``observation_unknown``
    is transient only for the native ``live_probe_failed``,
    ``owner_read_failed``, or evidence-backed ``owner_invalid`` reasons;
    other reasons in that state must still fail closed immediately.
    """

    if isinstance(error, RuntimeServiceNotReady):
        return (
            error.configured
            and (error.state, error.reason_code) in TRANSIENT_LIVENESS_OBSERVATIONS
        )
    return isinstance(error, (RuntimeServiceTransportError, OSError))


def _assert_pinned_ready_owner(handle: RuntimeHandle) -> dict[str, Any]:
    """Require the bounded owner record to match the attached service pin."""

    try:
        owner = _read_ready_owner(handle.paths)
    except (RuntimeServiceError, OSError) as error:
        raise RuntimeServiceUnknown(
            f"runtime service owner observation failed during supervision: {error}"
        ) from error
    if _owner_fingerprint(owner) != _owner_fingerprint(handle.owner):
        raise RuntimeServiceUnknown("runtime service owner changed during supervision")
    return owner


def _owner_from_cli(result: Mapping[str, Any], operation: str) -> dict[str, Any]:
    if (
        result.get("schema_version") != "runtime_service_discovery.v1"
        or result.get("status") != "ready"
        or not isinstance(result.get("owner"), dict)
    ):
        _fail(f"{operation} did not return a ready canonical owner")
    return dict(result["owner"])


def _service_status(paths: RuntimePaths) -> dict[str, Any]:
    result = _run_cli(
        paths,
        (
            "runtime",
            "service-status",
            "--store",
            str(paths.store),
            "--target",
            TARGET_ID,
            "--timeout-seconds",
            "3",
        ),
        timeout=SERVICE_STATUS_CLI_TIMEOUT_SECONDS,
    )
    return _owner_from_cli(result, "service-status")


def _read_ready_owner(paths: RuntimePaths) -> dict[str, Any]:
    """Read the already-published owner without starting another native CLI."""

    owner_path = paths.store / "runtime-services" / "OWNER.json"
    deadline = time.monotonic() + READY_OWNER_MISSING_RETRY_SECONDS
    while True:
        try:
            owner = _read_json(owner_path, "runtime service owner")
            break
        except FileNotFoundError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise
            time.sleep(min(READY_OWNER_MISSING_POLL_SECONDS, remaining))
    if owner.get("schema_version") != "runtime_service_owner.v1":
        _fail("runtime service owner schema is unsupported")
    if owner.get("state") != "ready":
        _fail("runtime service owner is not ready")
    _owner_fingerprint(owner)
    return owner


def _owner_pin_path(paths: RuntimePaths, owner: Mapping[str, Any]) -> Path:
    token = owner.get("owner_token")
    if not isinstance(token, str) or not OWNER_TOKEN_RE.fullmatch(token):
        _fail("canonical runtime service owner has an invalid owner token")
    return paths.store / "runtime-services" / f"docker-client-{token}.json"


def _pin_owner(paths: RuntimePaths, owner: Mapping[str, Any]) -> Path:
    """Durably pin one canonical owner without taking over another owner pin."""

    path = _owner_pin_path(paths, owner)
    try:
        current = _read_json(path, "pinned runtime service owner")
    except FileNotFoundError:
        pass
    else:
        if _owner_fingerprint(current) != _owner_fingerprint(owner):
            _fail("pinned runtime service owner differs from the confirmed owner")
    _atomic_json(path, owner, "pinned runtime service owner")
    return path


def _attach_pinned_handle(
    error: Exception, handle: RuntimeHandle, *, owner_pin_durable: bool
) -> None:
    setattr(error, "pinned_handle", handle)
    setattr(error, "owner_pin_durable", owner_pin_durable)


def start(
    paths: RuntimePaths | None = None,
    *,
    api_port: int | None = None,
    cli: Path | None = None,
    timeout: float = 90.0,
    expected_binding: str,
    configuration: Mapping[str, Any] | None = None,
) -> RuntimeHandle:
    """Attach or launch the service after API/store admission."""

    paths = paths or canonical_paths()
    prepare_storage(paths)
    if configuration is None:
        configuration = ensure_configuration(paths)
    else:
        persisted = _read_json(paths.config, "runtime service configuration")
        if persisted != configuration:
            _fail("runtime service configuration changed after native host initialization")
        configuration = persisted
    port = api_port or int(os.environ.get("FULLMAG_API_PORT", "8081"))
    if not 1 <= port <= 65535:
        _fail("API port is outside the valid range")
    api_probe = wait_for_api(paths, port, expected_binding, timeout=min(timeout, 60.0))
    api_identity = {
        key: api_probe[key]
        for key in (
            "api_instance_id",
            "api_contract_version",
            "build_identity",
            "runtime_store_binding",
        )
    }
    ensured = _owner_from_cli(
        _run_cli(
            paths,
            ("runtime", "service-ensure", "--config", str(paths.config)),
            timeout=timeout,
            cli=cli,
        ),
        "service-ensure",
    )
    pinned = RuntimeHandle(paths, configuration, ensured, port, api_identity)
    owner_pin_durable = False
    try:
        _pin_owner(paths, ensured)
        owner_pin_durable = True
        # service-ensure already returned the authoritative owner.  Reusing
        # the bounded published OWNER.json avoids a second read-only native
        # CLI, which can time out on Docker Desktop's Windows-folder mount.
        observed = _read_ready_owner(paths)
        if _owner_fingerprint(ensured) != _owner_fingerprint(observed):
            raise RuntimeServiceUnknown(
                "runtime owner changed between service-ensure and startup observation"
            )
        _wait_for_api_liveness(
            port,
            api_identity,
            timeout=min(timeout, STARTUP_LIVENESS_GRACE_SECONDS),
            handle=RuntimeHandle(paths, configuration, observed, port, api_identity),
        )
    except Exception as error:
        unknown = (
            error
            if isinstance(error, RuntimeServiceUnknown)
            else RuntimeServiceUnknown(
                f"runtime owner outcome after service-ensure is unknown: {error}"
            )
        )
        observation = getattr(error, "liveness_observation", None)
        if isinstance(observation, dict):
            unknown.liveness_observation = observation
        _attach_pinned_handle(
            unknown, pinned, owner_pin_durable=owner_pin_durable
        )
        if unknown is error:
            raise
        raise unknown from error
    return RuntimeHandle(paths, configuration, observed, port, api_identity)


def _api_accepts_connections(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25):
            return True
    except OSError:
        return False


def _wait_api_closed(port: int, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while _api_accepts_connections(port):
        if time.monotonic() >= deadline:
            _fail("API is still accepting connections; service drain was not attempted")
        time.sleep(0.1)


def stop(handle: RuntimeHandle, *, timeout: float = 30.0) -> dict[str, Any]:
    """Drain only the owner attached by start; never kill or take over."""

    _wait_api_closed(handle.api_port)
    # The authoritative drain command below validates this same pinned owner;
    # avoid a second read-only native CLI before issuing it.
    observed = _read_ready_owner(handle.paths)
    if _owner_fingerprint(observed) != _owner_fingerprint(handle.owner):
        raise RuntimeServiceUnknown(
            "runtime owner changed before shutdown; no drain request was sent"
        )
    if not 1 <= timeout <= 30:
        _fail("terminal drain timeout must be 1..30 seconds")
    expected_path = _pin_owner(handle.paths, observed)
    result = _run_cli(handle.paths, ("runtime", "service-drain-confirmed",
                      "--config", str(handle.paths.config), "--expected-owner", str(expected_path),
                      "--timeout-seconds", str(int(timeout))), timeout=timeout + 10)
    if result.get("schema_version") != "runtime_service_discovery.v1" or result.get("status") != "drained":
        _fail("Rust did not confirm the terminal runtime service drain")
    terminal = result.get("owner")
    if not isinstance(terminal, dict):
        _fail("Rust terminal drain omitted the service owner")
    for field in ("owner_token", "process_start_token", "pid", "target_id", "control_address"):
        if terminal.get(field) != observed.get(field):
            _fail("runtime owner identity changed during terminal drain")
    children = terminal.get("children")
    if (
        not isinstance(children, list)
        or {child.get("role") for child in children if isinstance(child, dict)}
        != {"compute", "preparation"}
        or any(child.get("status") != "exited_success" for child in children)
    ):
        _fail("runtime service terminal child receipts are incomplete")
    return terminal


def check(handle: RuntimeHandle, *, full_api_probe: bool = True) -> None:
    expected_identity = handle.api_identity
    if not isinstance(expected_identity, Mapping):
        raise RuntimeServiceUnknown("runtime handle has no pinned API identity")
    binding = expected_identity.get("runtime_store_binding")
    if not isinstance(binding, Mapping) or not isinstance(binding.get("binding"), str):
        raise RuntimeServiceUnknown("runtime handle has no pinned API store binding")
    try:
        fresh_identity = None
        if full_api_probe:
            fresh_identity, _ = _probe_api_identity(
                handle.paths, handle.api_port, binding["binding"], timeout=5.0
            )
            if fresh_identity != dict(expected_identity):
                raise RuntimeServiceUnknown(
                    "API identity or accepted-store binding changed during supervision"
                )
        # Prove the exact pinned owner before accepting a transient API
        # observation. A Rust-side owner-read failure is transient only when
        # this bounded, no-CLI proof is currently healthy.
        _assert_pinned_ready_owner(handle)
        # A full identity probe is periodic, but the thin native liveness
        # proof is required on every cycle so a full probe cannot mask a
        # persistent live_probe_failed observation.
        _probe_api_liveness(
            handle.api_port,
            expected_identity,
            timeout=API_LIVENESS_TIMEOUT_SECONDS,
        )
    except (RuntimeServiceError, OSError) as error:
        if isinstance(error, RuntimeServiceUnknown):
            raise
        if _is_transient_supervision_observation(error):
            _assert_pinned_ready_owner(handle)
        error_type = (
            RuntimeServiceTransient
            if _is_transient_supervision_observation(error)
            else RuntimeServiceUnknown
        )
        unknown = error_type(
            f"API identity probe failed during supervision: {error}"
        )
        observation = getattr(error, "liveness_observation", None)
        if isinstance(observation, dict):
            unknown.liveness_observation = observation
        raise unknown from error
    # Recheck after the liveness request so a pin change during the request
    # cannot be mistaken for a healthy observation on the next cycle.
    _assert_pinned_ready_owner(handle)
