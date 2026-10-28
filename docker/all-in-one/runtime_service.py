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
import sys
import tempfile
import time
import uuid
from typing import Any, Callable, Mapping, NoReturn, Sequence

STATE_ROOT = Path("/state")
SOURCE_ROOT = Path("/opt/fullmag/source")
PACKAGE_ROOT = Path("/opt/fullmag/package")
IMAGE_ROOT = Path("/opt/fullmag")
HOST_CERTIFICATE = Path("/run/fullmag/windows-folder-host.json")
WORKTREE_ID = TARGET_ID = "docker-all"
COMPUTE_POOL_ID = "docker-all.compute"
PREPARATION_POOL_ID = "docker-all.preparation"
WINDOWS_STORAGE_PROFILE = "windows-folder-v1"
LINUX_STORAGE_PROFILE = "linux-native-v1"

STORAGE_SCHEMA = "fullmag_storage_v1"
RUNTIME_CONFIG_SCHEMA = "runtime_service_config.v1"
HOST_PROFILE_SCHEMA = "fullmag.docker-host-profile.v1"
CPU_HOST_PROFILE_SCHEMA = "fullmag.docker-host-profile.v2"
HOST_POLICY_GPU_SCHEMA = "host_resource_ledger_policy.v2"
HOST_POLICY_CPU_SCHEMA = "host_resource_ledger_policy.v3"
HOST_READINESS_GPU_SCHEMA = "host_runtime_readiness.v1"
HOST_READINESS_CPU_SCHEMA = "host_runtime_readiness.v2"
DEVICE_ACCESS_CHOICES = frozenset({"cpu", "gpu"})
# This is a path inside the Linux container, even when the source-only
# contract tests are imported by native Windows Python.  PurePosixPath keeps
# the serialized CLI/profile value stable across host operating systems.
HOST_LEDGER_ROOT = PurePosixPath("/host-ledger/ledger")
HOST_LEDGER_PROFILE = "host-ledger-v1"
# ADR 0067: a volume DEV group's own ledger volume at the same container path.
GROUP_LEDGER_PROFILE = "group-ledger-v1"
GROUP_LEDGER_HOST_ID_ENV = "FULLMAG_GROUP_LEDGER_HOST_ID"
HOST_CAPACITY_ENVIRONMENT = (
    "FULLMAG_DOCKER_HOST_CAPACITY_PATH",
    "FULLMAG_DOCKER_HOST_CAPACITY_SHA256",
    "FULLMAG_DOCKER_HOST_CAPACITY_MIGRATION_SHA256",
)
HOST_RESOURCE_LEDGER_FILE = "HOST_RESOURCE_LEDGER.json"
LEGACY_DOCKER_HOST_ID = "docker-all-host"
MAX_HOST_LEDGER_BYTES = 8 * 1024 * 1024
# The accepted store remains in the host-backed user-data namespace. Every
# lifecycle receipt/configuration file is rooted in the separately mounted
# runtime-control volume.  ``FULLMAG_RUNTIME_SERVICES_ROOT`` is a second view
# of that same volume at the native SessionStore compatibility path; the Rust
# service still receives the unchanged accepted-store root and therefore keeps
# its session/result layout intact.
RUNTIME_CONTROL_ROOT = Path("/opt/fullmag/runtime-control")
BUILD_CONTROL_ROOT = Path("/opt/fullmag/control")
RUNTIME_PROVENANCE_RELATIVE = Path("backend/runtime-provenance.json")
RUNTIME_PROVENANCE_PATH = BUILD_CONTROL_ROOT / RUNTIME_PROVENANCE_RELATIVE
RUNTIME_SERVICES_RELATIVE = Path("runtime-services")
CONFIG_RELATIVE = Path("runtime-service/docker-all.json")
PROCESS_RECEIPT_RELATIVE = Path("runtime-service/process-tree.json")
FEM_MESH_CACHE_ROOT = Path("/build/cache/fem-mesh")
CUDA_CACHE_ROOT = Path("/build/cache/cuda-compute")
MAX_JSON_BYTES = 256 * 1024
MAX_HTTP_BYTES = 4 * 1024 * 1024
# The native control probe is bounded at three seconds.  Keep the Python
# request budget above that limit so Windows-folder I/O cannot turn a healthy
# native probe into a transport timeout at the API boundary.
API_LIVENESS_TIMEOUT_SECONDS = 5.0
API_BINDING_STARTUP_TIMEOUT_SECONDS = 60.0
# A pinned accepted-run restore validates immutable Study/CAS and historical
# proofs before listening. Windows-folder I/O can exceed ordinary API startup.
# This only extends the pre-listen budget; admission and identity checks stay
# unchanged and the native service is not launched before the API is pinned.
ACCEPTED_REATTACH_API_STARTUP_TIMEOUT_SECONDS = 300.0
STARTUP_LIVENESS_GRACE_SECONDS = 30.0
# Process limits for lifecycle calls whose work includes Windows-folder (9p)
# I/O.  The accepted-store bootstrap and diagnostic service-status call can
# legitimately outlive the normal API probe on that mount.
SERVICE_STATUS_CLI_TIMEOUT_SECONDS = 30
STORE_BOOTSTRAP_CLI_TIMEOUT_SECONDS = 180
# A live API observation may be temporarily unprovable while the native
# service is still running.  The API remains fail-closed in that state; this
# window only prevents a busy API (for example a long scene or mesh request on
# the Windows-folder mount) from being killed as if it had failed.
SUPERVISION_GRACE_SECONDS = 120.0
# The complete OpenAPI identity document is large; liveness is still checked
# every second, the full identity only at this interval.
SUPERVISION_FULL_API_PROBE_SECONDS = 30.0
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
# Container namespace recovery is a separate protocol from the legacy
# unknown-owner recovery above.  The authorization document is written to the
# Docker named control volume and is exposed to PID 1 only through these two
# allowlisted variables.  A host path is never accepted at this boundary.
CONTAINER_RECOVERY_AUTHORIZATION_ENV = "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION"
CONTAINER_RECOVERY_AUTHORIZATION_SHA256_ENV = (
    "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION_SHA256"
)
CONTAINER_RECOVERY_AUTHORIZATION_SCHEMA = (
    "fullmag.docker-container-recovery-authorization.v1"
)
CONTAINER_RECOVERY_AUTHORIZATION_SCHEMAS = frozenset({CONTAINER_RECOVERY_AUTHORIZATION_SCHEMA})
CONTAINER_RECOVERY_REQUEST_SCHEMA = "runtime_service_container_recovery_request.v1"
CONTAINER_RECOVERY_TERMINAL_REQUEST_SCHEMA = "runtime_service_container_recovery_request.v3"
CONTAINER_RECOVERY_HELD_MANUAL_REQUEST_SCHEMA = "runtime_service_container_recovery_request.v4"
CONTAINER_RECOVERY_CAPABILITIES_SCHEMA = "runtime_service_container_recovery_capabilities.v1"
CONTAINER_RECOVERY_ATTESTATION_SCHEMA = "docker_namespace_teardown_attestation.v1"
CONTAINER_RECOVERY_ABSENCE_ATTESTATION_SCHEMA = "docker_namespace_absence_attestation.v1"
CONTAINER_RECOVERY_RECEIPT_SCHEMA = "runtime_service_container_recovery.v1"
CONTAINER_RECOVERY_ARCHIVE_SCHEMA = "runtime_service_container_recovery_archive.v1"
CONTAINER_RECOVERY_RELATIVE = PurePosixPath("runtime-services/container-recovery")
MAX_CONTAINER_RECOVERY_AUTHORIZATION_BYTES = 512 * 1024
MAX_CONTAINER_RECOVERY_REQUEST_BYTES = 256 * 1024
MAX_CONTAINER_RECOVERY_RECEIPT_BYTES = 512 * 1024
MAX_CONTAINER_RECOVERY_LOG_BYTES = 4 * 1024 * 1024
CONTAINER_RECOVERY_WRITER_BUSY_MESSAGE = (
    "session store writer is busy root=/host-ledger/ledger "
    "conflict=native descriptor"
)
CONTAINER_RECOVERY_WRITER_BUSY_NATIVE_MESSAGE = (
    "session store writer is busy: root=`/host-ledger/ledger`, "
    "conflict=native descriptor"
)
CONTAINER_RECOVERY_WRITER_BUSY_RETRY_SECONDS = 5.0
CONTAINER_RECOVERY_WRITER_BUSY_SLEEP_SECONDS = 0.1
CONTAINER_RECOVERY_CONTROL_ROOT = Path("/opt/fullmag/control")
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


class RuntimeServiceOwnerStartupFailure(RuntimeServiceUnknown):
    """The API was verified, but native service ownership was not confirmed."""

    def __init__(self, detail: str, *, api_identity: Mapping[str, Any], api_port: int):
        super().__init__(detail)
        self.api_identity = dict(api_identity)
        self.api_port = api_port


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
    # ``state_root`` is the technical runtime-control root for paths returned
    # by ``canonical_paths``.  The legacy default remains for source-only
    # callers that construct RuntimePaths() directly; Docker always supplies
    # the explicit volume path through the environment below.
    state_root: Path = STATE_ROOT / ".fullmag"
    runtime_services: Path | None = None
    source: Path = SOURCE_ROOT
    package: Path = PACKAGE_ROOT
    config: Path = STATE_ROOT / ".fullmag" / CONFIG_RELATIVE
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
        or not request_path_value.startswith("/")
        or "/../" in request_path_value
        or not isinstance(request_sha256, str)
        or HEX64.fullmatch(request_sha256) is None
        or not isinstance(request_id, str)
        or UUID_RE.fullmatch(request_id) is None
    ):
        _fail("runtime recovery authorization has an invalid native request pin")
    request_path = _absolute(Path(request_path_value), "native recovery request")
    request_root = None
    for candidate in (paths.state_root, paths.state):
        try:
            request_relative = request_path.relative_to(candidate)
        except ValueError:
            continue
        if request_path == candidate / request_relative:
            request_root = candidate
            break
    if request_root is None:
        _fail("native recovery request is outside the accepted or runtime-control root")
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
        runtime_services_root(paths) / "OWNER.json",
        "runtime service owner",
        MAX_RECOVERY_AUTHORIZATION_BYTES,
    )
    launch_raw = _bounded_regular(
        runtime_services_root(paths) / "LAUNCH.json",
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
    """Return the ledger host ID bound to the verified Docker daemon.

    ``host-ledger-v1`` uses the daemon digest itself.  A ``group-ledger-v1``
    DEV group uses its launcher-derived ID (daemon digest plus Compose
    project); the daemon digest remains the storage-admission identity.
    """

    profile = os.environ.get("FULLMAG_HOST_LEDGER_PROFILE")
    if profile not in {HOST_LEDGER_PROFILE, GROUP_LEDGER_PROFILE}:
        _fail("Docker host initialization requires the host-ledger-v1 or group-ledger-v1 profile")
    value = os.environ.get("FULLMAG_DOCKER_HOST_ID", "")
    if HEX64.fullmatch(value) is None:
        _fail("FULLMAG_DOCKER_HOST_ID must be the verified lowercase Docker daemon SHA-256")
    if profile == HOST_LEDGER_PROFILE:
        return value
    if any(os.environ.get(name) is not None for name in HOST_CAPACITY_ENVIRONMENT):
        _fail("a group ledger cannot bind the global Docker host capacity descriptor")
    group_host_id = os.environ.get(GROUP_LEDGER_HOST_ID_ENV, "")
    if HEX64.fullmatch(group_host_id) is None or group_host_id == value:
        _fail(GROUP_LEDGER_HOST_ID_ENV + " must be the group's derived lowercase SHA-256")
    return group_host_id


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
    accepted = {daemon_host_id}
    if os.environ.get("FULLMAG_HOST_LEDGER_PROFILE") == HOST_LEDGER_PROFILE:
        accepted.add(LEGACY_DOCKER_HOST_ID)
    if stored_host_id not in accepted:
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


def runtime_services_root(paths: RuntimePaths) -> Path:
    """Return the technical runtime-services view backed by named storage.

    Native Fullmag keeps the relative ``runtime-services`` layout below the
    accepted SessionStore.  Docker mounts the runtime-control named volume at
    that compatibility path as well as at ``runtime_services``.  Keeping this
    lookup in one helper prevents Python lifecycle checks from accidentally
    returning to the host session bind.
    """

    return paths.runtime_services or (paths.store / RUNTIME_SERVICES_RELATIVE)


def process_receipt_path(paths: RuntimePaths) -> Path:
    """Return the authenticated PID-1 receipt in technical runtime storage."""

    return paths.state_root / PROCESS_RECEIPT_RELATIVE


def _store_relative_path(paths: RuntimePaths, relative: PurePosixPath) -> Path:
    """Map native store-relative evidence to its volume-backed runtime view."""

    parts = relative.parts
    if parts and parts[0] == RUNTIME_SERVICES_RELATIVE.name:
        return runtime_services_root(paths).joinpath(*parts[1:])
    return paths.store.joinpath(*parts)


def canonical_paths(environment: Mapping[str, str] | None = None) -> RuntimePaths:
    environment = os.environ if environment is None else environment
    state = _env_path(environment, "FULLMAG_CONTAINER_STATE_ROOT", STATE_ROOT)
    storage = _env_path(environment, "FULLMAG_PROJECT_STORAGE_ROOT", state)
    runs = _env_path(environment, "FULLMAG_RUNS_ROOT", storage / "runs" / WORKTREE_ID)
    runtime_control = _env_path(
        environment, "FULLMAG_RUNTIME_CONTROL_ROOT", RUNTIME_CONTROL_ROOT
    )
    state_root = _env_path(environment, "FULLMAG_STATE_ROOT", runtime_control)
    runtime_services = _env_path(
        environment,
        "FULLMAG_RUNTIME_SERVICES_ROOT",
        runtime_control / RUNTIME_SERVICES_RELATIVE,
    )
    source = _env_path(environment, "FULLMAG_REPO_ROOT", SOURCE_ROOT)
    package = _env_path(environment, "FULLMAG_RUNTIME_ROOT", PACKAGE_ROOT)
    config = runtime_control / CONFIG_RELATIVE
    provenance = _env_path(
        environment, "FULLMAG_RUNTIME_PROVENANCE", IMAGE_ROOT / "provenance.json"
    )
    if (
        "FULLMAG_RUNTIME_PROVENANCE" in environment
        and provenance != RUNTIME_PROVENANCE_PATH
    ):
        _fail("FULLMAG_RUNTIME_PROVENANCE must use the fixed build-control provenance path")
    if state != STATE_ROOT or storage != STATE_ROOT:
        _fail("all-in-Docker accepted storage is fixed to /state")
    if runs != STATE_ROOT / "runs" / WORKTREE_ID:
        _fail("FULLMAG_RUNS_ROOT must be /state/runs/docker-all")
    if state_root != runtime_control:
        _fail("FULLMAG_STATE_ROOT must equal FULLMAG_RUNTIME_CONTROL_ROOT")
    if source != SOURCE_ROOT or package != PACKAGE_ROOT:
        _fail("all-in-Docker source and package roots are immutable")
    if environment.get("FULLMAG_WORKTREE_ID", WORKTREE_ID) != WORKTREE_ID:
        _fail("FULLMAG_WORKTREE_ID must be docker-all")
    if "FULLMAG_STATE_DIR" in environment and _absolute(
        environment["FULLMAG_STATE_DIR"], "FULLMAG_STATE_DIR"
    ) != state_root:
        _fail("FULLMAG_STATE_DIR must equal FULLMAG_RUNTIME_CONTROL_ROOT")
    if "FULLMAG_RUNTIME_SERVICE_CONFIG" in environment and _absolute(
        environment["FULLMAG_RUNTIME_SERVICE_CONFIG"], "FULLMAG_RUNTIME_SERVICE_CONFIG"
    ) != config:
        _fail("FULLMAG_RUNTIME_SERVICE_CONFIG is outside the fixed config path")
    provenance = _env_path(environment, "FULLMAG_PACKAGE_PROVENANCE", provenance)
    if provenance not in {IMAGE_ROOT / "provenance.json", Path("/build/provenance.json"), Path("/opt/fullmag/control/backend/runtime-provenance.json")}:
        _fail("runtime provenance is outside the two fixed package/volume locations")
    return RuntimePaths(
        state=state,
        storage=storage,
        runs=runs,
        store=runs / "session-store",
        state_root=state_root,
        runtime_services=runtime_services,
        source=source,
        package=package,
        config=config,
        provenance=provenance,
        host_certificate=(Path("/run/fullmag/linux-native-host.json")
                          if environment.get("FULLMAG_SESSION_STORAGE_PROFILE") == LINUX_STORAGE_PROFILE
                          else HOST_CERTIFICATE),
    )


def storage_profile() -> str:
    profile = os.environ.get("FULLMAG_SESSION_STORAGE_PROFILE")
    if profile not in {WINDOWS_STORAGE_PROFILE, LINUX_STORAGE_PROFILE}:
        _fail("all-in-Docker storage requires explicit windows-folder-v1 or linux-native-v1 admission")
    return profile


def prepare_storage(paths: RuntimePaths | None = None) -> RuntimePaths:
    """Prepare mapped directories and the fixed project marker only."""

    paths = paths or canonical_paths()
    storage_profile()
    _ensure_directory(paths.state, "container state")
    _ensure_directory(paths.state_root, "runtime control volume")
    _ensure_directory(runtime_services_root(paths), "runtime services volume view")
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
        # HOME is technical process state in the container.  User projects,
        # sessions and results remain addressed through the explicit /state
        # project and runs roots below.
        "HOME": str(paths.state_root),
        "FULLMAG_PROJECT_STORAGE_ROOT": str(paths.storage),
        "FULLMAG_RUNS_ROOT": str(paths.runs),
        "FULLMAG_WORKTREE_ID": WORKTREE_ID,
        "FULLMAG_STATE_ROOT": str(paths.state_root),
        "FULLMAG_STATE_DIR": str(paths.state_root),
        "FULLMAG_RUNTIME_CONTROL_ROOT": str(paths.state_root),
        "FULLMAG_RUNTIME_SERVICES_ROOT": str(runtime_services_root(paths)),
        "FULLMAG_REPO_ROOT": str(paths.source),
        "FULLMAG_RUNTIME_ROOT": str(paths.package),
        "FULLMAG_FEM_MESH_CACHE_DIR": os.environ.get(
            "FULLMAG_FEM_MESH_CACHE_DIR", str(FEM_MESH_CACHE_ROOT)
        ),
        "CUDA_CACHE_PATH": os.environ.get("CUDA_CACHE_PATH", str(CUDA_CACHE_ROOT)),
        "FULLMAG_SESSION_STORAGE_PROFILE": storage_profile(),
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
        environment.pop("FULLMAG_DEVELOPMENT_TERMINAL_OBSERVATION_STDIN", None)
    return environment


ACCEPTED_REATTACH_REQUEST_ENV = "FULLMAG_ACCEPTED_REATTACH_REQUEST"
ACCEPTED_REATTACH_DIGEST_ENV = "FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256"
ACCEPTED_REATTACH_STDIN_ENV = "FULLMAG_DEVELOPMENT_ACCEPTED_REATTACH_STDIN"
ACCEPTED_REATTACH_PROVENANCE = Path("/opt/fullmag/control/backend/runtime-provenance.json")
ACCEPTED_REATTACH_REQUEST_SCHEMA = "fullmag.docker-accepted-run-reattach-request.v1"
ACCEPTED_REATTACH_INPUT_SCHEMA = "fullmag.development-accepted-run-reattach.v1"
ACCEPTED_REATTACH_ACK_SCHEMA = "fullmag.development-accepted-run-reattach-ack.v1"
ACCEPTED_REATTACH_DRAIN_SCHEMA = "fullmag.docker-accepted-run-reattach-drain.v1"
ACCEPTED_REATTACH_RUNTIME_SCHEMA = "fullmag.docker-accepted-run-reattach-runtime.v1"
ACCEPTED_REATTACH_INITIAL_MODE = "held_pending_restore"
ACCEPTED_REATTACH_SUCCESSOR_MODE = "completed_consumed_no_replay"
# The value above is an outcome emitted by the native restore authority.  A
# successor input deliberately does not select an outcome: the native side
# must inspect the accepted catalog, start-release receipt, and lease proofs
# before deciding whether the held run remains pending or is terminally
# consumed.
ACCEPTED_REATTACH_SUCCESSOR_INPUT_MODE = "successor_auto"
ACCEPTED_REATTACH_OUTCOME_MODES = frozenset({
    ACCEPTED_REATTACH_INITIAL_MODE,
    ACCEPTED_REATTACH_SUCCESSOR_MODE,
})
ACCEPTED_REATTACH_INPUT_MODES = frozenset({
    ACCEPTED_REATTACH_INITIAL_MODE,
    ACCEPTED_REATTACH_SUCCESSOR_INPUT_MODE,
})
ACCEPTED_REATTACH_ACK_PREFIX = "restore-ack-"
ACCEPTED_REATTACH_DRAIN_PREFIX = "successor-drain-"
ACCEPTED_REATTACH_FIELDS = frozenset({
    "schema", "run_id", "project_id", "source_request_id", "source_sha256",
    "startup_provenance_sha256", "config_sha256", "proof_path", "proof_sha256",
})
_ACCEPTED_REATTACH_PRE_RESTORE_PROCESS_FIELDS = frozenset({
    "schema", "state", "api_pid", "api_exit_code", "accepted_store",
    "bootstrap", "qualification", "error", "shutdown_error",
})
_ACCEPTED_REATTACH_PRE_RESTORE_API_EXIT_CODE = 101
_ACCEPTED_REATTACH_PRE_RESTORE_API_ERROR = (
    "API binding did not become ready: API loopback probe failed for "
    "/v2/platform/openapi.json: [Errno 111] Connection refused"
)
_ACCEPTED_REATTACH_PRE_RESTORE_SHUTDOWN_ERROR = (
    "no pinned runtime service owner was available for authenticated drain"
)


def _reattach_relative(root: Path, relative: str, name: str) -> Path:
    if not isinstance(relative, str) or not relative or len(relative) > 1024:
        _fail(f"{name} is not a bounded relative path")
    path = PurePosixPath(relative)
    if (path.is_absolute() or str(path) != relative or ".." in path.parts
            or "\\" in relative or ":" in relative):
        _fail(f"{name} must stay inside runtime control")
    return root.joinpath(*path.parts)


def _accepted_reattach_documents(paths: RuntimePaths):
    """Read the explicit request and its digest-bound proof without mutation."""
    environment = process_environment(paths)
    relative = environment.get(ACCEPTED_REATTACH_REQUEST_ENV)
    digest = environment.get(ACCEPTED_REATTACH_DIGEST_ENV)
    if ACCEPTED_REATTACH_STDIN_ENV in environment:
        _fail("accepted-run stdin switch is owned by PID 1")
    if relative is None and digest is None:
        return environment, None, None
    if not relative or not digest or not HEX64.fullmatch(digest):
        _fail("accepted-run reattach requires both request and digest")
    if (environment.get("FULLMAG_STARTUP_ENABLED") == "1"
            or "FULLMAG_DEVELOPMENT_RESTORE_STDIN" in environment):
        _fail("accepted-run reattach cannot repeat startup or authoring restore")
    request_path = _reattach_relative(paths.state_root, relative, "accepted-run request")
    raw = _bounded_regular(request_path, "accepted-run request", 64 * 1024)
    if _sha256_bytes(raw) != digest:
        _fail("accepted-run request digest differs")
    try:
        request = json.loads(raw, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"accepted-run request is not valid JSON: {error}")
    if (not isinstance(request, dict) or set(request) != ACCEPTED_REATTACH_FIELDS
            or request.get("schema") != ACCEPTED_REATTACH_REQUEST_SCHEMA):
        _fail("accepted-run request fields/schema differ")
    for field in ("source_sha256", "startup_provenance_sha256", "config_sha256", "proof_sha256"):
        if not isinstance(request[field], str) or not HEX64.fullmatch(request[field]):
            _fail("accepted-run request has invalid " + field)
    for field in ("run_id", "project_id", "source_request_id"):
        value = request[field]
        if (not isinstance(value, str) or not value or len(value) > 256
                or any(ord(char) < 32 for char in value)):
            _fail("accepted-run request has invalid " + field)
    proof_path = _reattach_relative(paths.state_root, request["proof_path"], "accepted-run proof")
    proof = _bounded_regular(proof_path, "accepted-run proof", 256 * 1024)
    if _sha256_bytes(proof) != request["proof_sha256"]:
        _fail("accepted-run proof digest differs")
    return environment, request, proof


def _accepted_reattach_record_relative(request: Mapping[str, Any], filename: str) -> str:
    """Return one fixed proof-directory record name without accepting a host path."""

    if not isinstance(filename, str) or not filename or "/" in filename or "\\" in filename:
        _fail("accepted-run record filename is invalid")
    parent = PurePosixPath(request["proof_path"]).parent
    relative = str(parent / filename)
    if relative.startswith("../") or relative == "..":
        _fail("accepted-run record path escapes the proof directory")
    return relative


def _accepted_reattach_record_path(
    paths: RuntimePaths, request: Mapping[str, Any], filename: str, name: str
) -> tuple[str, Path]:
    relative = _accepted_reattach_record_relative(request, filename)
    return relative, _reattach_relative(paths.state_root, relative, name)


def _accepted_reattach_api_id(value: object, name: str) -> str:
    if not isinstance(value, str) or UUID_RE.fullmatch(value) is None:
        _fail(f"{name} is not a canonical API instance UUID")
    return value


def _accepted_reattach_json(raw: bytes, name: str) -> dict[str, Any]:
    try:
        value = json.loads(raw, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"{name} is not valid JSON: {error}")
    if not isinstance(value, dict):
        _fail(f"{name} must contain a JSON object")
    return value


ACCEPTED_REATTACH_ACK_FIELDS = frozenset({
    "schema", "state", "restore_mode", "request_sha256", "proof_sha256",
    "run_id", "project_id", "source_request_id", "source_sha256", "config_sha256",
    "activation_attempt", "reconciliation_attempt", "logical_session_id",
    "session_epoch", "api_instance_id", "previous_ack_sha256",
})


def _validate_accepted_reattach_proof_identity(proof: Mapping[str, Any]) -> None:
    """Validate the proof fields copied into the native restore acknowledgement."""

    for field in ("activation_attempt", "reconciliation_attempt", "logical_session_id"):
        value = proof.get(field)
        if not isinstance(value, str) or not value or len(value) > 256:
            _fail("accepted-run proof has invalid " + field)
    session_epoch = proof.get("session_epoch")
    if type(session_epoch) is not int or session_epoch < 0:
        _fail("accepted-run proof has invalid session_epoch")


def _validate_accepted_reattach_ack(
    request: Mapping[str, Any],
    proof: Mapping[str, Any],
    raw: bytes,
    *,
    request_sha256: str,
    expected_previous_ack_sha256: str | None,
    expected_restore_mode: str | None,
    expected_api_instance_id: str | None = None,
) -> dict[str, Any]:
    """Validate a native immutable restore ack, never a Python status marker."""

    if not HEX64.fullmatch(request_sha256):
        _fail("accepted-run request digest is invalid")
    if expected_restore_mode is not None:
        if expected_restore_mode not in ACCEPTED_REATTACH_OUTCOME_MODES:
            _fail("accepted-run restore mode is unsupported")
        accepted_restore_modes = {expected_restore_mode}
    else:
        # A successor input is intentionally outcome-free.  Only the native
        # restore authority may choose between a still-held run and a
        # terminally consumed run after checking its durable proofs.
        accepted_restore_modes = ACCEPTED_REATTACH_OUTCOME_MODES
    if expected_previous_ack_sha256 is not None and not HEX64.fullmatch(expected_previous_ack_sha256):
        _fail("accepted-run previous acknowledgement digest is invalid")
    if expected_restore_mode == ACCEPTED_REATTACH_SUCCESSOR_MODE and expected_previous_ack_sha256 is None:
        _fail("successor accepted-run restore has no previous acknowledgement digest")
    if expected_restore_mode is None and expected_previous_ack_sha256 is None:
        _fail("successor accepted-run restore input has no previous acknowledgement digest")
    # ``held_pending_restore`` is also the native outcome for a successor
    # whose accepted run remains blocked.  Its predecessor is what marks it
    # as a successor generation; the mode string alone cannot do that.
    _validate_accepted_reattach_proof_identity(proof)
    ack = _accepted_reattach_json(raw, "native accepted-run restore acknowledgement")
    if set(ack) != ACCEPTED_REATTACH_ACK_FIELDS:
        _fail("native accepted-run restore acknowledgement fields differ")
    expected = {
        "schema": ACCEPTED_REATTACH_ACK_SCHEMA,
        "state": "consumed",
        "request_sha256": request_sha256,
        "proof_sha256": request["proof_sha256"],
        "run_id": request["run_id"],
        "project_id": request["project_id"],
        "source_request_id": request["source_request_id"],
        "source_sha256": request["source_sha256"],
        "config_sha256": request["config_sha256"],
        "activation_attempt": proof["activation_attempt"],
        "reconciliation_attempt": proof["reconciliation_attempt"],
        "logical_session_id": proof["logical_session_id"],
        "session_epoch": proof["session_epoch"],
        "previous_ack_sha256": expected_previous_ack_sha256,
    }
    for key, value in expected.items():
        if ack.get(key) != value:
            _fail("native accepted-run restore acknowledgement differs: " + key)
    if ack.get("restore_mode") not in accepted_restore_modes:
        _fail("native accepted-run restore acknowledgement has an invalid restore mode")
    api_instance_id = _accepted_reattach_api_id(
        ack.get("api_instance_id"), "native restore API instance"
    )
    if expected_api_instance_id is not None and api_instance_id != expected_api_instance_id:
        _fail("native restore API instance differs from the live API")
    return ack


ACCEPTED_REATTACH_DRAIN_FIELDS = frozenset({
    "schema", "state", "request_sha256", "proof_sha256", "run_id", "project_id",
    "source_request_id", "source_sha256", "config_sha256", "api_instance_id",
    "ack_relative", "ack_sha256", "ready_owner_token", "terminal_process_record_path",
    "terminal_process_record_sha256", "terminal_owner_record_path",
    "terminal_owner_record_sha256", "ready_owner_record_path",
    "ready_owner_record_sha256",
})
# The three record paths below point to immutable raw archives in the same
# proof directory.  Their bytes are archived before the sidecar is published;
# a hash without the bytes would not prove a drained predecessor after
# start() rotates the live OWNER/process records.


def _validate_accepted_reattach_successor_drain(
    paths: RuntimePaths,
    request: Mapping[str, Any],
    proof: Mapping[str, Any],
    *,
    metadata: Mapping[str, Any],
    ack: Mapping[str, Any],
    ack_raw: bytes,
    drain_raw: bytes,
    drain_relative: str,
) -> dict[str, Any]:
    """Bind the old accepted restore to the authenticated successor drain."""

    drain = _accepted_reattach_json(drain_raw, "accepted-run successor drain")
    if set(drain) != ACCEPTED_REATTACH_DRAIN_FIELDS:
        _fail("accepted-run successor drain fields differ")
    ack_sha256 = _sha256_bytes(ack_raw)
    expected = {
        "schema": ACCEPTED_REATTACH_DRAIN_SCHEMA,
        "state": "drained",
        "request_sha256": metadata["request_sha256"],
        "proof_sha256": metadata["proof_sha256"],
        "run_id": request["run_id"],
        "project_id": request["project_id"],
        "source_request_id": request["source_request_id"],
        "source_sha256": request["source_sha256"],
        "config_sha256": request["config_sha256"],
        "api_instance_id": metadata["api_instance_id"],
        "ack_relative": metadata["ack_relative"],
        "ack_sha256": ack_sha256,
    }
    for key, value in expected.items():
        if drain.get(key) != value:
            _fail("accepted-run successor drain differs: " + key)
    if drain_relative != _accepted_reattach_record_relative(
        request, ACCEPTED_REATTACH_DRAIN_PREFIX + str(metadata["api_instance_id"]) + ".json"
    ):
        _fail("accepted-run successor drain path differs")
    api_id = _accepted_reattach_api_id(
        drain.get("api_instance_id"), "accepted-run successor drain API instance"
    )
    if api_id != metadata["api_instance_id"] or api_id != ack.get("api_instance_id"):
        _fail("accepted-run successor drain API instance differs from native acknowledgement")

    current_receipt_raw = _bounded_regular(
        process_receipt_path(paths), "accepted-run drained process receipt", MAX_JSON_BYTES
    )
    current_receipt = _accepted_reattach_json(
        current_receipt_raw, "accepted-run drained process receipt"
    )
    current_metadata = current_receipt.get("accepted_reattach")
    if current_metadata != dict(metadata):
        _fail("accepted-run drained process receipt lacks the native restore binding")

    authenticated = _read_authenticated_terminal_drain(paths)
    terminal_owner_raw = _bounded_regular(
        runtime_services_root(paths) / "OWNER.json",
        "accepted-run terminal owner",
        MAX_JSON_BYTES,
    )
    ready_owner = authenticated["pin"]
    ready_owner_raw = _bounded_regular(
        _owner_pin_path(paths, ready_owner),
        "accepted-run restored ready owner pin",
        MAX_JSON_BYTES,
    )
    archive_specs = (
        ("terminal_process_record_path", "terminal_process_record_sha256",
         current_receipt_raw, "accepted-run archived drained process receipt"),
        ("terminal_owner_record_path", "terminal_owner_record_sha256",
         terminal_owner_raw, "accepted-run archived terminal owner"),
        ("ready_owner_record_path", "ready_owner_record_sha256",
         ready_owner_raw, "accepted-run archived ready owner"),
    )
    for path_field, digest_field, current_raw, name in archive_specs:
        relative = drain.get(path_field)
        expected_digest = drain.get(digest_field)
        if not isinstance(relative, str) or not isinstance(expected_digest, str):
            _fail("accepted-run successor drain archive pin is incomplete")
        expected_relative = _accepted_reattach_record_relative(
            request, relative.rsplit("/", 1)[-1]
        )
        if relative != expected_relative or not HEX64.fullmatch(expected_digest):
            _fail("accepted-run successor drain archive path or digest is invalid")
        archive_raw = _bounded_regular(
            _reattach_relative(paths.state_root, relative, name), name, MAX_JSON_BYTES
        )
        if _sha256_bytes(archive_raw) != expected_digest or archive_raw != current_raw:
            _fail("accepted-run successor drain archive differs from current terminal record")
    if drain.get("ready_owner_token") != ready_owner.get("owner_token"):
        _fail("accepted-run successor drain does not match current authenticated records")
    return drain


def _read_optional_accepted_reattach_record(path: Path, name: str) -> tuple[bytes, dict[str, Any]] | None:
    try:
        raw = _bounded_regular(path, name, MAX_JSON_BYTES)
    except FileNotFoundError:
        return None
    return raw, _accepted_reattach_json(raw, name)


PRE_ACK_RETRY_SCHEMA = "fullmag.docker-accepted-pre-ack-retry.v1"


def _pre_ack_attempt_container(terminal, attempt, project, expected_image):
    """Read the explicit historical container binding from the same operation."""
    if not isinstance(expected_image, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_image):
        _fail("pre-ACK operation has an invalid historical image identity")
    ready = terminal.get("worker_cgroup")
    helper = terminal.get("worker_cgroup_helper")
    if (not isinstance(ready, dict) or not isinstance(helper, dict)
            or ready.get("schema") != "fullmag.worker-cgroup-ready.v1"
            or ready.get("state") != "ready"
            or ready.get("compose_project") != project
            or ready.get("image_id") != expected_image
            or helper.get("state") != "succeeded"
            or helper.get("name") != "fullmag-cgroup-" + attempt
            or not isinstance(helper.get("sha256"), str)
            or not HEX64.fullmatch(helper["sha256"])):
        _fail("pre-ACK operation has no matching canonical container binding")
    container = ready.get("container_id")
    if (not isinstance(container, str) or not HEX64.fullmatch(container)
            or ready.get("container_cgroup") != "/docker/" + container):
        _fail("pre-ACK operation has an invalid historical cgroup container identity")
    if "backend_container" in terminal and terminal["backend_container"] != container:
        _fail("pre-ACK operation backend and cgroup container identities differ")
    return container


def _pre_ack_utc_timestamp_ns(value):
    # Python 3.10's ISO parser does not define support for arbitrary fractional
    # seconds. Validate the UTC calendar separately and retain all nine digits.
    from datetime import datetime
    import calendar
    match = re.fullmatch(
        r"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?Z",
        value if isinstance(value, str) else "",
    )
    if match is None:
        _fail("pre-ACK incarnation timestamp is not bounded UTC RFC3339")
    try:
        base = datetime.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        _fail("pre-ACK incarnation timestamp has an invalid UTC calendar")
    if base.year < 1970:
        _fail("pre-ACK incarnation timestamp predates the Unix epoch")
    fraction = int((match.group(2) or "").ljust(9, "0"))
    return calendar.timegm(base.timetuple()) * 1_000_000_000 + fraction


def _assert_pre_ack_unconsumed(directory: Path) -> None:
    allowed = {"request.json", "proof.json", "terminal-owner.json", "terminal-process.json",
               "pre-ack-retry.json", "pre-ack-api-terminal.json"}
    entries = list(directory.iterdir())
    if len(entries) > 64:
        _fail("pre-ACK retry record inventory exceeds its bound")
    for entry in entries:
        if (entry.name not in allowed or entry.is_symlink() or not entry.is_file()
                or entry.name.startswith((ACCEPTED_REATTACH_ACK_PREFIX, ACCEPTED_REATTACH_DRAIN_PREFIX))
                or entry.name.endswith((".part", ".tmp"))):
            _fail("pre-ACK retry has consumed or uncertain acknowledgement evidence")


def _validate_pre_ack_retry_record(record, raw, request, proof, request_sha, read_record,
                                  *, require_operation=True):
    """Validate one first retry; never authorize another retry or a Solve."""
    expected = {
        "schema": PRE_ACK_RETRY_SCHEMA, "parent": None,
        "request_sha256": request_sha, "proof_sha256": request["proof_sha256"],
        "run_id": request["run_id"], "project_id": request["project_id"],
        "compose_project": proof["compose_project"], "control_volume": proof["control_volume"],
        "original_process_sha256": proof["terminal_process_record_sha256"],
        "owner_sha256": proof["terminal_owner_record_sha256"],
    }
    if "parent" not in record or any(record.get(k) != v for k, v in expected.items()):
        _fail("pre-ACK retry identity or first-retry scope differs")
    for key in ("api_attempt", "preflight_attempt", "operation_attempt"):
        if not isinstance(record.get(key), str) or not re.fullmatch(r"[0-9a-f]{32}", record[key]):
            _fail("pre-ACK retry has an invalid " + key)
    for key in ("api_container", "preflight_container"):
        if not isinstance(record.get(key), str) or not HEX64.fullmatch(record[key]):
            _fail("pre-ACK retry has an invalid " + key)
    if (record["api_attempt"] == record["preflight_attempt"]
            or record["api_container"] == record["preflight_container"]):
        _fail("pre-ACK retry must bind two distinct attempts and container incarnations")
    for kind in ("api", "preflight"):
        terminal_raw, terminal = read_record(
            "development/attempts/" + record[kind + "_attempt"] + "/terminal.json", kind + " attempt"
        )
        if (_sha256_bytes(terminal_raw) != record.get(kind + "_attempt_sha256")
                or terminal.get("state") != "failed-confirmed"
                or terminal.get("compose_project") != proof["compose_project"]
                or terminal.get("control_volume") != proof["control_volume"]
                or terminal.get("inputs", {}).get("image_id") != record.get(kind + "_image")
                or terminal.get("inputs", {}).get("source_root") != proof["source_root"]):
            _fail("pre-ACK retry development attempt differs: " + kind)
        if _pre_ack_attempt_container(
                terminal, record[kind + "_attempt"], proof["compose_project"],
                record[kind + "_image"]) != record[kind + "_container"]:
            _fail("pre-ACK retry recorded container differs: " + kind)
        if kind == "api" and terminal.get("backend_started_at") != record.get("api_incarnation", {}).get("started_at"):
            _fail("pre-ACK retry API attempt start time differs from its journal")
        if kind == "preflight":
            restart = terminal.get("inputs", {}).get("native_failed_restart", {})
            if (restart.get("container_id") != record["api_container"]
                    or restart.get("image_id") != record["api_image"]
                    or restart.get("journal_sha256") != record["api_stop_sha256"]):
                _fail("pre-ACK retry preflight attempt does not bind the stopped API predecessor")
            encoded = json.dumps(restart, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            if _sha256_bytes(encoded) != record.get("native_restart_sha256"):
                _fail("pre-ACK retry native restart metadata payload differs")
    journal_raw, journal = read_record(
        "verification/stop-failed-" + record["api_container"] + ".json", "pre-ACK API stop journal"
    )
    if (_sha256_bytes(journal_raw) != record.get("api_stop_sha256")
            or journal.get("schema") != "fullmag.stop-failed-admission.v1"
            or journal.get("state") != "stopped-confirmed"
            or journal.get("failure_kind") != "native-start-failure"
            or journal.get("failure_mode") != "api-start-failure"
            or journal.get("container_id") != record["api_container"]
            or journal.get("image_id") != record["api_image"]
            or journal.get("container_state") != record.get("api_incarnation")):
        _fail("pre-ACK retry is not bound to the exact API-start stop journal")
    process_raw, process = read_record(
        "runtime-control/" + str(PurePosixPath(request["proof_path"]).parent / "pre-ack-api-terminal.json"),
        "pre-ACK stopped API terminal",
    )
    if (_sha256_bytes(process_raw) != record.get("current_process_sha256")
            or process != journal.get("terminal_process_receipt")
            or process.get("schema") != "fullmag.docker-process-tree.v1"
            or process.get("state") != "shutdown_unknown"
            or type(process.get("api_pid")) is not int or process["api_pid"] <= 0
            or type(process.get("api_exit_code")) is not int or process["api_exit_code"] != -15
            or process.get("runtime_pid") is not None
            or any(k in process for k in ("service_owner", "terminal_service_owner", "accepted_reattach"))):
        _fail("pre-ACK retry stopped API terminal differs")
    probe = journal.get("native_failure_probe", {})
    if (probe.get("api_pid_exists") is not False or probe.get("owner_pid_exists") is not False
            or probe.get("child_pids_exist") is not False or probe.get("native_processes_live") is not False
            or type(probe.get("active_lease_count")) is not int or probe["active_lease_count"] != 0
            or probe.get("failed_owner_sha256") != record["owner_sha256"]
            or any(not isinstance(probe.get(k), list) or any(s != "released" for s in probe[k])
                   for k in ("lease_states", "reservation_states"))):
        _fail("pre-ACK retry has no exact stopped and released native proof")
    if journal.get("terminal_failed_owner_sha256") != record["owner_sha256"]:
        _fail("pre-ACK retry stop journal owner differs from original owner")
    incarnation = record.get("preflight_incarnation", {})
    if (incarnation.get("id") != record["preflight_container"]
            or incarnation.get("image") != record["preflight_image"]
            or type(incarnation.get("pid")) is not int or incarnation["pid"] != 0
            or type(incarnation.get("exit_code")) is not int or incarnation["exit_code"] != 1
            or incarnation.get("status") != "exited" or incarnation.get("oom_killed") is not False):
        _fail("pre-ACK retry preflight incarnation differs")
    try:
        api_end = _pre_ack_utc_timestamp_ns(record["api_incarnation"]["finished_at"])
        pre_start = _pre_ack_utc_timestamp_ns(incarnation["started_at"])
        pre_end = _pre_ack_utc_timestamp_ns(incarnation["finished_at"])
        if not api_end < pre_start <= pre_end:
            _fail("pre-ACK retry incarnation order differs")
    except (KeyError, TypeError, ValueError):
        _fail("pre-ACK retry has invalid incarnation timestamps")
    safety_raw, safety = read_record(
        "pre-ack-retry/attempts/" + record["operation_attempt"] + "/released-observation.json", "pre-ACK released observation"
    )
    if (_sha256_bytes(safety_raw) != record.get("released_observation_sha256")
            or safety.get("schema") != "fullmag.pre-ack-released-observation.v1"
            or type(safety.get("active_count")) is not int or safety["active_count"] != 0
            or not isinstance(safety.get("reservations"), list) or not isinstance(safety.get("leases"), list)):
        _fail("pre-ACK retry released observation differs")
    compose_raw, compose = read_record(
        "development/attempts/" + record["preflight_attempt"] + "/compose.json", "pre-ACK Compose"
    )
    if _sha256_bytes(compose_raw) != record.get("preflight_compose_sha256") or compose.get("name") != proof["compose_project"]:
        _fail("pre-ACK retry Compose identity differs")
    provenance_raw, provenance = read_record(
        "pre-ack-retry/attempts/" + record["operation_attempt"] + "/preflight-provenance.json", "pre-ACK build provenance"
    )
    if (_sha256_bytes(provenance_raw) != record.get("preflight_provenance_sha256")
            or provenance.get("schema") != "fullmag.docker-all-image.v1"
            or provenance.get("state") != "succeeded"
            or provenance.get("source_snapshot_sha256") != record.get("preflight_source_snapshot")):
        _fail("pre-ACK retry immutable build provenance differs")
    log_raw, log_record = read_record(
        "pre-ack-retry/attempts/" + record["operation_attempt"] + "/preflight-log.json", "pre-ACK preflight log"
    )
    log = log_record.get("log")
    if (_sha256_bytes(log_raw) != record.get("preflight_log_sha256")
            or log_record.get("incarnation") != incarnation or not isinstance(log, str)
            or "accepted_reattach_preflight" not in log
            or "current terminal record differs from immutable backing evidence" not in log
            or "[fullmag-backend] Starting API and runtime service" in log
            or "starting fullmag-api" in log):
        _fail("pre-ACK retry does not prove a failure before API spawn")
    if require_operation:
        operation_raw, operation = read_record(
            "pre-ack-retry/attempts/" + record["operation_attempt"] + "/terminal.json", "pre-ACK retry operation"
        )
        if (operation.get("state") != "succeeded" or operation.get("phase") != "pre-ack-retry"
                or operation.get("compose_project") != proof["compose_project"]
                or operation.get("control_volume") != proof["control_volume"]
                or operation.get("retry_record_sha256") != _sha256_bytes(raw)):
            _fail("pre-ACK retry operation is not a bound succeeded publication")
    return record


def _validate_initial_pre_restore_process_delta(
    archive_raw: bytes, current_raw: bytes, owner_raw: bytes
) -> None:
    """Accept only the known API-before-owner terminal receipt transition."""

    archive = _accepted_reattach_json(
        archive_raw, "accepted-run immutable terminal process record"
    )
    current = _accepted_reattach_json(
        current_raw, "accepted-run current terminal process record"
    )
    owner = _accepted_reattach_json(owner_raw, "accepted-run terminal owner record")
    if set(current) != _ACCEPTED_REATTACH_PRE_RESTORE_PROCESS_FIELDS:
        _fail("accepted-run current terminal process record shape differs")
    if set(archive) not in (
        _ACCEPTED_REATTACH_PRE_RESTORE_PROCESS_FIELDS,
        _ACCEPTED_REATTACH_PRE_RESTORE_PROCESS_FIELDS | {"service_owner"},
    ):
        _fail("accepted-run immutable terminal process record shape differs")
    for field in ("schema", "state", "accepted_store", "bootstrap", "qualification"):
        if current.get(field) != archive.get(field):
            _fail("accepted-run terminal process immutable field differs: " + field)
    if (
        current.get("schema") != "fullmag.docker-process-tree.v1"
        or current.get("state") != "shutdown_unknown"
    ):
        _fail("accepted-run current terminal process is not the known pre-restore failure")
    if (
        archive.get("schema") != "fullmag.docker-process-tree.v1"
        or archive.get("state") != "shutdown_unknown"
    ):
        _fail("accepted-run immutable terminal process is not shutdown_unknown")
    if type(current.get("api_pid")) is not int or current["api_pid"] <= 0:
        _fail("accepted-run current terminal process API PID is invalid")
    if (type(current.get("api_exit_code")) is not int
            or current["api_exit_code"] != _ACCEPTED_REATTACH_PRE_RESTORE_API_EXIT_CODE):
        _fail("accepted-run current terminal process API exit code is invalid")
    if current.get("error") != _ACCEPTED_REATTACH_PRE_RESTORE_API_ERROR:
        _fail("accepted-run current terminal process API error differs")
    if (
        current.get("shutdown_error")
        != _ACCEPTED_REATTACH_PRE_RESTORE_SHUTDOWN_ERROR
    ):
        _fail("accepted-run current terminal process shutdown reason differs")
    _validate_terminal_owner(
        owner,
        state="failed",
        name="accepted-run terminal failed owner",
        allowed_child_statuses=(
            ("exited_success", "exited_failure")
            if "service_owner" in archive else ("exited_success",)
        ),
    )
    if "service_owner" in archive:
        retained_ready_owner = archive["service_owner"]
        if not isinstance(retained_ready_owner, dict):
            _fail("accepted-run retained ready owner is not an object")
        _validate_terminal_owner(
            retained_ready_owner,
            state="ready",
            name="accepted-run retained ready owner",
        )
        if (
            _owner_identity(retained_ready_owner) != _owner_identity(owner)
            or _owner_child_identity(retained_ready_owner)
            != _owner_child_identity(owner)
        ):
            _fail("accepted-run retained ready owner differs from failed owner identity")


def accepted_reattach_preflight(paths: RuntimePaths):
    """Pin old records or an authenticated successor drain before rotation.

    The first restore compares the mutable records with the immutable terminal
    archive.  Later restarts must use a native consumed acknowledgement and an
    authenticated drain of that API successor; comparing the new owner with
    the historical owner would reject a legitimate restart.
    """
    environment, request, proof_raw = _accepted_reattach_documents(paths)
    if request is None:
        return None
    proof = _accepted_reattach_json(proof_raw, "accepted-run backing proof")
    if (not isinstance(proof, dict)
            or proof.get("schema") != "fullmag.development-accepted-run-reattach-proof.v1"):
        _fail("accepted-run backing proof schema differs")
    proof_path = _reattach_relative(paths.state_root, request["proof_path"], "accepted-run proof")

    # The first entrypoint invocation has no native ack yet.  It is admitted
    # from the immutable archive and may accept only the explicitly typed
    # API-before-owner failure receipt below.  A later invocation may never
    # infer its phase from a state string or marker: it needs exact drained
    # successor metadata.
    current_receipt_path = process_receipt_path(paths)
    metadata = None
    try:
        current_receipt_raw = _bounded_regular(
            current_receipt_path, "accepted-run current process receipt", MAX_JSON_BYTES
        )
        current_receipt = _accepted_reattach_json(
            current_receipt_raw, "accepted-run current process receipt"
        )
        candidate = current_receipt.get("accepted_reattach")
        if isinstance(candidate, dict):
            metadata = candidate
    except FileNotFoundError:
        current_receipt_raw = None
        current_receipt = None

    request_sha256 = environment[ACCEPTED_REATTACH_DIGEST_ENV]
    if metadata is not None:
        metadata_fields = {
            "schema", "restore_mode", "request_sha256", "proof_sha256", "run_id",
            "project_id", "source_request_id", "source_sha256", "config_sha256",
            "ack_relative", "ack_sha256", "api_instance_id", "previous_ack_sha256",
        }
        if set(metadata) != metadata_fields:
            _fail("accepted-run current receipt has invalid restore metadata")
        expected_metadata = {
            "schema": ACCEPTED_REATTACH_RUNTIME_SCHEMA,
            "request_sha256": request_sha256,
            "proof_sha256": request["proof_sha256"],
            "run_id": request["run_id"],
            "project_id": request["project_id"],
            "source_request_id": request["source_request_id"],
            "source_sha256": request["source_sha256"],
            "config_sha256": request["config_sha256"],
        }
        for key, value in expected_metadata.items():
            if metadata.get(key) != value:
                _fail("accepted-run current receipt restore metadata differs: " + key)
        _validate_accepted_reattach_runtime_metadata(
            metadata, request=request, request_sha256=request_sha256
        )
        api_id = _accepted_reattach_api_id(
            metadata.get("api_instance_id"), "accepted-run current receipt API instance"
        )
        expected_ack_relative = _accepted_reattach_record_relative(
            request, ACCEPTED_REATTACH_ACK_PREFIX + api_id + ".json"
        )
        if metadata.get("ack_relative") != expected_ack_relative:
            _fail("accepted-run current receipt restore acknowledgement path differs")
        if not isinstance(metadata.get("ack_sha256"), str) or not HEX64.fullmatch(metadata["ack_sha256"]):
            _fail("accepted-run current receipt restore acknowledgement digest is invalid")
        previous_ack_sha256 = metadata.get("previous_ack_sha256")
        restore_mode = metadata.get("restore_mode")
        if restore_mode not in ACCEPTED_REATTACH_OUTCOME_MODES:
            _fail("accepted-run current receipt restore mode is invalid")
        if previous_ack_sha256 is None:
            if restore_mode != ACCEPTED_REATTACH_INITIAL_MODE:
                _fail("successor accepted-run restore has no previous acknowledgement digest")
        elif not isinstance(previous_ack_sha256, str) or not HEX64.fullmatch(previous_ack_sha256):
            _fail("successor accepted-run restore has an invalid previous acknowledgement digest")
        ack_record = _read_optional_accepted_reattach_record(
            _reattach_relative(paths.state_root, expected_ack_relative, "native restore acknowledgement"),
            "native accepted-run restore acknowledgement",
        )
        if ack_record is None:
            _fail("accepted-run current receipt references a missing native restore acknowledgement")
        ack_raw, ack = ack_record
        if _sha256_bytes(ack_raw) != metadata["ack_sha256"]:
            _fail("accepted-run native restore acknowledgement digest differs")
        ack = _validate_accepted_reattach_ack(
            request,
            proof,
            ack_raw,
            request_sha256=request_sha256,
            expected_previous_ack_sha256=previous_ack_sha256,
            expected_restore_mode=restore_mode,
            expected_api_instance_id=api_id,
        )
        drain_relative = _accepted_reattach_record_relative(
            request, ACCEPTED_REATTACH_DRAIN_PREFIX + api_id + ".json"
        )
        drain_record = _read_optional_accepted_reattach_record(
            _reattach_relative(paths.state_root, drain_relative, "accepted-run successor drain"),
            "accepted-run successor drain",
        )
        if drain_record is None:
            _fail("accepted-run current receipt has no authenticated successor drain")
        drain_raw, _ = drain_record
        _validate_accepted_reattach_successor_drain(
            paths,
            request,
            proof,
            metadata=metadata,
            ack=ack,
            ack_raw=ack_raw,
            drain_raw=drain_raw,
            drain_relative=drain_relative,
        )
        return {
            "request_sha256": request_sha256,
            "proof_sha256": request["proof_sha256"],
            # This is an input decision, not the previous ACK's outcome.  The
            # native restore path must re-read the catalog/start-release and
            # lease proofs and emit the next ACK outcome.
            "restore_mode": ACCEPTED_REATTACH_SUCCESSOR_INPUT_MODE,
            "previous_ack_relative": metadata["ack_relative"],
            "previous_ack_sha256": metadata["ack_sha256"],
            "previous_drain_relative": drain_relative,
            "previous_drain_sha256": _sha256_bytes(drain_raw),
        }

    # The API-specific acknowledgement filename is not knowable until the
    # native successor receives its new API instance identity.  No mutable
    # marker is accepted as a substitute for that first native acknowledgement.
    owner_relative, owner_expected = (
        proof.get("terminal_owner_record_path"),
        proof.get("terminal_owner_record_sha256"),
    )
    if not isinstance(owner_expected, str) or not HEX64.fullmatch(owner_expected):
        _fail("accepted-run backing record digest is missing or invalid")
    archived_owner = _reattach_relative(
        paths.state_root, owner_relative, "accepted-run backing owner record"
    )
    if (
        archived_owner.parent != proof_path.parent
        or archived_owner.name != "terminal-owner.json"
    ):
        _fail("accepted-run backing owner record is outside its proof directory")
    archive_owner_raw = _bounded_regular(
        archived_owner, "accepted-run immutable terminal owner", 256 * 1024
    )
    current_owner_path = runtime_services_root(paths) / "OWNER.json"
    current_owner_raw = _bounded_regular(
        current_owner_path, "accepted-run current terminal owner", 256 * 1024
    )
    if (
        _sha256_bytes(archive_owner_raw) != owner_expected
        or current_owner_raw != archive_owner_raw
    ):
        _fail("accepted-run current terminal owner differs from immutable backing evidence")

    process_relative, process_expected = (
        proof.get("terminal_process_record_path"),
        proof.get("terminal_process_record_sha256"),
    )
    if not isinstance(process_expected, str) or not HEX64.fullmatch(process_expected):
        _fail("accepted-run backing record digest is missing or invalid")
    archived_process = _reattach_relative(
        paths.state_root, process_relative, "accepted-run backing process record"
    )
    if (
        archived_process.parent != proof_path.parent
        or archived_process.name != "terminal-process.json"
    ):
        _fail("accepted-run backing process record is outside its proof directory")
    archive_process_raw = _bounded_regular(
        archived_process, "accepted-run immutable terminal process", 256 * 1024
    )
    if _sha256_bytes(archive_process_raw) != process_expected:
        _fail("accepted-run immutable terminal process digest differs")
    current_process_raw = _bounded_regular(
        process_receipt_path(paths), "accepted-run current terminal process", 256 * 1024
    )
    retry = None
    if current_process_raw != archive_process_raw:
        retry_relative = _accepted_reattach_record_relative(request, "pre-ack-retry.json")
        retry_path = _reattach_relative(paths.state_root, retry_relative, "pre-ACK retry")
        retry_observation = _read_optional_accepted_reattach_record(retry_path, "pre-ACK retry")
        if retry_observation is None:
            # Retain the remote's exact legacy exit-101 compatibility case.
            _validate_initial_pre_restore_process_delta(
                archive_process_raw, current_process_raw, archive_owner_raw
            )
        else:
            # An existing certificate must validate; never fall back from an
            # invalid or uncertain certificate to the legacy receipt case.
            retry_raw, retry_record = retry_observation
            def read_retry_record(relative, label):
                maximum = 8 * 1024 * 1024 if relative.endswith("/preflight-log.json") else MAX_JSON_BYTES
                data = _bounded_regular(_reattach_relative(BUILD_CONTROL_ROOT, relative, label), label, maximum)
                return data, _accepted_reattach_json(data, label)
            _validate_pre_ack_retry_record(
                retry_record, retry_raw, request, proof, request_sha256, read_retry_record
            )
            if _sha256_bytes(current_process_raw) != retry_record["current_process_sha256"]:
                _fail("pre-ACK retry cannot authorize another API incarnation")
            _assert_pre_ack_unconsumed(retry_path.parent)
            retry = {"pre_ack_retry_path": retry_relative, "pre_ack_retry_sha256": _sha256_bytes(retry_raw)}
    result = {
        "request_sha256": request_sha256,
        "proof_sha256": request["proof_sha256"],
        "restore_mode": ACCEPTED_REATTACH_INITIAL_MODE,
        "previous_ack_relative": None,
        "previous_ack_sha256": None,
        "previous_drain_relative": None,
        "previous_drain_sha256": None,
    }
    if retry is not None:
        result.update(retry)
    return result


@contextmanager
def accepted_reattach_api_input(paths: RuntimePaths, *, preflight=None):
    """Pass a verified same-run request privately after legitimate recovery.

    PID 1 validates old mutable records before recovery. Rust independently
    verifies their immutable raw backing records after owner/process rotation.
    """
    environment, request, proof_raw = _accepted_reattach_documents(paths)
    if request is None:
        yield environment, None
        return
    expected_preflight = {
        "request_sha256": environment[ACCEPTED_REATTACH_DIGEST_ENV],
        "proof_sha256": request["proof_sha256"],
        "restore_mode": preflight.get("restore_mode") if isinstance(preflight, dict) else None,
        "previous_ack_relative": preflight.get("previous_ack_relative") if isinstance(preflight, dict) else None,
        "previous_ack_sha256": preflight.get("previous_ack_sha256") if isinstance(preflight, dict) else None,
        "previous_drain_relative": preflight.get("previous_drain_relative") if isinstance(preflight, dict) else None,
        "previous_drain_sha256": preflight.get("previous_drain_sha256") if isinstance(preflight, dict) else None,
    }
    if isinstance(preflight, dict) and "pre_ack_retry_path" in preflight:
        expected_preflight.update({key: preflight.get(key) for key in ("pre_ack_retry_path", "pre_ack_retry_sha256")})
    if preflight != expected_preflight:
        _fail("accepted-run API input requires the matching early terminal preflight")
    _accepted_reattach_preflight_shape(environment, request, preflight)
    if environment.get("FULLMAG_RUNTIME_PROVENANCE") != str(ACCEPTED_REATTACH_PROVENANCE):
        _fail("accepted-run reattach requires fixed Docker runtime provenance")
    provenance = _read_json(ACCEPTED_REATTACH_PROVENANCE, "accepted-run build provenance")
    commit, snapshot = provenance.get("commit"), provenance.get("source_snapshot_sha256")
    if (provenance.get("schema") != "fullmag.docker-all-image.v1"
            or provenance.get("state") != "succeeded"
            or not isinstance(commit, str) or not HEX40.fullmatch(commit)
            or not isinstance(snapshot, str) or not HEX64.fullmatch(snapshot)):
        _fail("accepted-run reattach requires succeeded pinned build provenance")
    payload = dict(
        request,
        schema=ACCEPTED_REATTACH_INPUT_SCHEMA,
        target_build_id=commit,
        target_source_sha256=snapshot,
        request_sha256=environment[ACCEPTED_REATTACH_DIGEST_ENV],
        restore_mode=preflight["restore_mode"],
        previous_ack_path=preflight["previous_ack_relative"],
        previous_ack_sha256=preflight["previous_ack_sha256"],
        previous_drain_path=preflight["previous_drain_relative"],
        previous_drain_sha256=preflight["previous_drain_sha256"],
    )
    if "pre_ack_retry_path" in preflight:
        payload.update({key: preflight[key] for key in ("pre_ack_retry_path", "pre_ack_retry_sha256")})
    _ensure_directory(paths.state_root, "accepted-run runtime control")
    with tempfile.TemporaryFile(mode="w+b", dir=paths.state_root) as stream:
        stream.write(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf8"))
        stream.seek(0)
        environment[ACCEPTED_REATTACH_STDIN_ENV] = "1"
        yield environment, stream


ACCEPTED_REATTACH_RUNTIME_FIELDS = frozenset({
    "schema", "restore_mode", "request_sha256", "proof_sha256", "run_id", "project_id",
    "source_request_id", "source_sha256", "config_sha256", "ack_relative", "ack_sha256",
    "api_instance_id", "previous_ack_sha256",
})


def _validate_accepted_reattach_runtime_metadata(
    metadata: Mapping[str, Any], *, request: Mapping[str, Any], request_sha256: str
) -> None:
    if set(metadata) != ACCEPTED_REATTACH_RUNTIME_FIELDS:
        _fail("accepted-run runtime metadata fields differ")
    expected = {
        "schema": ACCEPTED_REATTACH_RUNTIME_SCHEMA,
        "request_sha256": request_sha256,
        "proof_sha256": request["proof_sha256"],
        "run_id": request["run_id"],
        "project_id": request["project_id"],
        "source_request_id": request["source_request_id"],
        "source_sha256": request["source_sha256"],
        "config_sha256": request["config_sha256"],
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            _fail("accepted-run runtime metadata differs: " + key)
    restore_mode = metadata.get("restore_mode")
    if restore_mode not in ACCEPTED_REATTACH_OUTCOME_MODES:
        _fail("accepted-run runtime metadata has an unsupported restore mode")
    previous_ack_sha256 = metadata.get("previous_ack_sha256")
    # The held outcome is valid both for the first restore (no predecessor)
    # and for a later successor which is still waiting for Compute.  A
    # predecessor digest therefore distinguishes those two generations;
    # Python must not collapse the held successor into the terminal outcome.
    if previous_ack_sha256 is None:
        if restore_mode != ACCEPTED_REATTACH_INITIAL_MODE:
            _fail("successor accepted-run runtime metadata has no previous acknowledgement")
    elif not isinstance(previous_ack_sha256, str) or not HEX64.fullmatch(previous_ack_sha256):
        _fail("successor accepted-run runtime metadata has an invalid previous acknowledgement")
    api_id = _accepted_reattach_api_id(
        metadata.get("api_instance_id"), "accepted-run runtime API instance"
    )
    ack_relative = metadata.get("ack_relative")
    expected_ack_relative = _accepted_reattach_record_relative(
        request, ACCEPTED_REATTACH_ACK_PREFIX + api_id + ".json"
    )
    if ack_relative != expected_ack_relative:
        _fail("accepted-run runtime metadata acknowledgement path differs")
    if not isinstance(metadata.get("ack_sha256"), str) or not HEX64.fullmatch(metadata["ack_sha256"]):
        _fail("accepted-run runtime metadata has an invalid acknowledgement digest")


def _accepted_reattach_preflight_shape(
    environment: Mapping[str, str], request: Mapping[str, Any], preflight: Mapping[str, Any]
) -> None:
    expected = {
        "request_sha256": environment.get(ACCEPTED_REATTACH_DIGEST_ENV),
        "proof_sha256": request.get("proof_sha256"),
        "restore_mode": preflight.get("restore_mode"),
        "previous_ack_relative": preflight.get("previous_ack_relative"),
        "previous_ack_sha256": preflight.get("previous_ack_sha256"),
        "previous_drain_relative": preflight.get("previous_drain_relative"),
        "previous_drain_sha256": preflight.get("previous_drain_sha256"),
    }
    if "pre_ack_retry_path" in preflight:
        expected.update({key: preflight.get(key) for key in ("pre_ack_retry_path", "pre_ack_retry_sha256")})
    if dict(preflight) != expected:
        _fail("accepted-run API input requires the matching early terminal preflight")
    restore_mode = preflight.get("restore_mode")
    if restore_mode not in ACCEPTED_REATTACH_INPUT_MODES:
        _fail("accepted-run API input has an unsupported restore mode")
    previous_fields = (
        "previous_ack_relative", "previous_ack_sha256",
        "previous_drain_relative", "previous_drain_sha256",
    )
    if restore_mode == ACCEPTED_REATTACH_INITIAL_MODE:
        if any(preflight.get(field) is not None for field in previous_fields):
            _fail("initial accepted-run restore cannot reference successor records")
        if "pre_ack_retry_path" in preflight:
            if (preflight["pre_ack_retry_path"] != _accepted_reattach_record_relative(request, "pre-ack-retry.json")
                    or not isinstance(preflight.get("pre_ack_retry_sha256"), str)
                    or not HEX64.fullmatch(preflight["pre_ack_retry_sha256"])):
                _fail("pre-ACK retry transport path or digest differs")
        return
    if "pre_ack_retry_path" in preflight:
        _fail("successor transport cannot carry a pre-ACK retry")
    for field in ("previous_ack_relative", "previous_drain_relative"):
        value = preflight.get(field)
        try:
            _reattach_relative(Path("/"), value, "accepted-run " + field)
        except (TypeError, RuntimeServiceError):
            _fail("successor accepted-run restore has an invalid " + field)
    for field in ("previous_ack_sha256", "previous_drain_sha256"):
        value = preflight.get(field)
        if not isinstance(value, str) or not HEX64.fullmatch(value):
            _fail("successor accepted-run restore has an invalid " + field)


def accepted_reattach_runtime_ack(
    paths: RuntimePaths, *, preflight: Mapping[str, Any], handle: RuntimeHandle
) -> dict[str, Any]:
    """Consume and authenticate the native restore acknowledgement for this API."""

    environment, request, proof_raw = _accepted_reattach_documents(paths)
    if request is None:
        _fail("accepted-run native restore acknowledgement has no request")
    proof = _accepted_reattach_json(proof_raw, "accepted-run backing proof")
    _accepted_reattach_preflight_shape(environment, request, preflight)
    request_sha256 = environment[ACCEPTED_REATTACH_DIGEST_ENV]
    api_identity = handle.api_identity
    if not isinstance(api_identity, Mapping):
        _fail("accepted-run native restore acknowledgement has no API identity")
    api_id = _accepted_reattach_api_id(
        api_identity.get("api_instance_id"), "accepted-run live API instance"
    )
    ack_relative, ack_path = _accepted_reattach_record_path(
        paths, request, ACCEPTED_REATTACH_ACK_PREFIX + api_id + ".json",
        "native accepted-run restore acknowledgement",
    )
    ack_raw = _bounded_regular(
        ack_path, "native accepted-run restore acknowledgement", MAX_JSON_BYTES
    )
    input_restore_mode = preflight["restore_mode"]
    if input_restore_mode == ACCEPTED_REATTACH_SUCCESSOR_INPUT_MODE:
        # The successor request is deliberately outcome-free.  Passing None
        # makes the validator accept only the two native outcome modes while
        # leaving the choice to the proof-backed Rust restore path.
        expected_restore_mode = None
    elif input_restore_mode in ACCEPTED_REATTACH_OUTCOME_MODES:
        expected_restore_mode = input_restore_mode
    else:
        _fail("accepted-run native restore input mode is unsupported")
    ack = _validate_accepted_reattach_ack(
        request,
        proof,
        ack_raw,
        request_sha256=request_sha256,
        expected_previous_ack_sha256=preflight["previous_ack_sha256"],
        expected_restore_mode=expected_restore_mode,
        expected_api_instance_id=api_id,
    )
    previous_ack_sha256 = preflight["previous_ack_sha256"]
    if previous_ack_sha256 is not None:
        previous_relative = preflight["previous_ack_relative"]
        if not isinstance(previous_relative, str):
            _fail("successor accepted-run restore has no previous acknowledgement path")
        previous_raw = _bounded_regular(
            _reattach_relative(
                paths.state_root, previous_relative,
                "previous native restore acknowledgement",
            ),
            "previous native restore acknowledgement", MAX_JSON_BYTES,
        )
        if _sha256_bytes(previous_raw) != previous_ack_sha256:
            _fail("successor accepted-run previous acknowledgement digest differs")
        previous_ack = _accepted_reattach_json(
            previous_raw, "previous native restore acknowledgement"
        )
        previous_api_id = _accepted_reattach_api_id(
            previous_ack.get("api_instance_id"), "previous native restore API instance"
        )
        expected_previous_relative = _accepted_reattach_record_relative(
            request, ACCEPTED_REATTACH_ACK_PREFIX + previous_api_id + ".json"
        )
        if previous_relative != expected_previous_relative:
            _fail("successor accepted-run previous acknowledgement path differs")
        previous_mode = previous_ack.get("restore_mode")
        previous_previous_sha256 = previous_ack.get("previous_ack_sha256")
        _validate_accepted_reattach_ack(
            request,
            proof,
            previous_raw,
            request_sha256=request_sha256,
            expected_previous_ack_sha256=previous_previous_sha256,
            expected_restore_mode=previous_mode,
            expected_api_instance_id=previous_api_id,
        )
        if previous_api_id == api_id:
            _fail("successor accepted-run restore reused the previous API instance")
    metadata = {
        "schema": ACCEPTED_REATTACH_RUNTIME_SCHEMA,
        # Persist the native decision, never the successor input selector.
        "restore_mode": ack["restore_mode"],
        "request_sha256": request_sha256,
        "proof_sha256": request["proof_sha256"],
        "run_id": request["run_id"],
        "project_id": request["project_id"],
        "source_request_id": request["source_request_id"],
        "source_sha256": request["source_sha256"],
        "config_sha256": request["config_sha256"],
        "ack_relative": ack_relative,
        "ack_sha256": _sha256_bytes(ack_raw),
        "api_instance_id": ack["api_instance_id"],
        "previous_ack_sha256": previous_ack_sha256,
    }
    _validate_accepted_reattach_runtime_metadata(
        metadata, request=request, request_sha256=request_sha256
    )
    return metadata


def _publish_accepted_reattach_record(
    path: Path, value: Mapping[str, Any], name: str
) -> str:
    """Publish an immutable technical record, accepting only an exact replay."""

    raw = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    return _publish_accepted_reattach_raw(path, raw, name)


def _publish_accepted_reattach_raw(path: Path, raw: bytes, name: str) -> str:
    """Create one immutable record without replacing a concurrent writer."""

    if len(raw) > MAX_JSON_BYTES:
        _fail(name + " exceeds its size bound")
    path = _absolute(path, name)
    parent = _ensure_directory(path.parent, f"{name} parent")
    try:
        descriptor = os.open(
            path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o660
        )
    except FileExistsError:
        # Another writer owns the existing name. Its exact bytes, including a
        # partial/failed publication, are retained and can never be overwritten.
        existing = _bounded_regular(path, name, MAX_JSON_BYTES)
        if existing != raw:
            _fail(name + " already exists with different bytes")
        return _sha256_bytes(existing)
    try:
        view = memoryview(raw)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                _fail(f"short write while publishing {name}")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError as error:
        _fail(f"durable publication of {name} is unknown: {error}")
    existing = _bounded_regular(path, name, MAX_JSON_BYTES)
    if existing != raw:
        _fail(name + " changed during publication")
    return _sha256_bytes(existing)


def accepted_reattach_record_drain(
    paths: RuntimePaths, *, runtime: Mapping[str, Any], receipt_path: Path | None = None
) -> str:
    """Record an authenticated successor drain after the final receipt is durable."""

    environment, request, proof_raw = _accepted_reattach_documents(paths)
    if request is None:
        _fail("accepted-run successor drain has no request")
    request_sha256 = environment[ACCEPTED_REATTACH_DIGEST_ENV]
    _validate_accepted_reattach_runtime_metadata(
        runtime, request=request, request_sha256=request_sha256
    )
    receipt_path = receipt_path or process_receipt_path(paths)
    receipt_raw = _bounded_regular(
        receipt_path, "accepted-run drained process receipt", MAX_JSON_BYTES
    )
    receipt = _accepted_reattach_json(receipt_raw, "accepted-run drained process receipt")
    if receipt.get("schema") != "fullmag.docker-process-tree.v1" or receipt.get("state") != "drained":
        _fail("accepted-run successor drain requires a drained process receipt")
    if receipt.get("accepted_reattach") != dict(runtime):
        _fail("accepted-run successor drain receipt metadata differs")
    authenticated = _read_authenticated_terminal_drain(paths)
    terminal_owner_raw = _bounded_regular(
        runtime_services_root(paths) / "OWNER.json",
        "accepted-run terminal owner",
        MAX_JSON_BYTES,
    )
    ready_owner = authenticated["pin"]
    ready_owner_raw = _bounded_regular(
        _owner_pin_path(paths, ready_owner),
        "accepted-run restored ready owner pin",
        MAX_JSON_BYTES,
    )
    ack_raw = _bounded_regular(
        _reattach_relative(paths.state_root, runtime["ack_relative"],
                           "native accepted-run restore acknowledgement"),
        "native accepted-run restore acknowledgement", MAX_JSON_BYTES,
    )
    if _sha256_bytes(ack_raw) != runtime["ack_sha256"]:
        _fail("accepted-run successor drain acknowledgement digest differs")
    api_id = _accepted_reattach_api_id(
        runtime["api_instance_id"], "accepted-run successor drain API instance"
    )
    drain_relative, drain_path = _accepted_reattach_record_path(
        paths, request, ACCEPTED_REATTACH_DRAIN_PREFIX + api_id + ".json",
        "accepted-run successor drain",
    )
    process_archive_relative, process_archive_path = _accepted_reattach_record_path(
        paths, request, "successor-terminal-process-" + api_id + ".json",
        "accepted-run archived drained process receipt",
    )
    terminal_owner_archive_relative, terminal_owner_archive_path = _accepted_reattach_record_path(
        paths, request, "successor-terminal-owner-" + api_id + ".json",
        "accepted-run archived terminal owner",
    )
    ready_owner_archive_relative, ready_owner_archive_path = _accepted_reattach_record_path(
        paths, request, "successor-ready-owner-" + api_id + ".json",
        "accepted-run archived ready owner",
    )
    # Publish the raw records before the sidecar which references them.  The
    # archives are immutable and make the drain independently verifiable after
    # start() rotates OWNER.json and process-tree.json for the successor API.
    process_archive_sha256 = _publish_accepted_reattach_raw(
        process_archive_path, receipt_raw, "accepted-run archived drained process receipt"
    )
    terminal_owner_archive_sha256 = _publish_accepted_reattach_raw(
        terminal_owner_archive_path, terminal_owner_raw, "accepted-run archived terminal owner"
    )
    ready_owner_archive_sha256 = _publish_accepted_reattach_raw(
        ready_owner_archive_path, ready_owner_raw, "accepted-run archived ready owner"
    )
    drain = {
        "schema": ACCEPTED_REATTACH_DRAIN_SCHEMA,
        "state": "drained",
        "request_sha256": runtime["request_sha256"],
        "proof_sha256": runtime["proof_sha256"],
        "run_id": request["run_id"],
        "project_id": request["project_id"],
        "source_request_id": request["source_request_id"],
        "source_sha256": request["source_sha256"],
        "config_sha256": request["config_sha256"],
        "api_instance_id": api_id,
        "ack_relative": runtime["ack_relative"],
        "ack_sha256": runtime["ack_sha256"],
        "ready_owner_token": ready_owner["owner_token"],
        "terminal_process_record_path": process_archive_relative,
        "terminal_process_record_sha256": process_archive_sha256,
        "terminal_owner_record_path": terminal_owner_archive_relative,
        "terminal_owner_record_sha256": terminal_owner_archive_sha256,
        "ready_owner_record_path": ready_owner_archive_relative,
        "ready_owner_record_sha256": ready_owner_archive_sha256,
    }
    if drain_relative != _accepted_reattach_record_relative(
        request, ACCEPTED_REATTACH_DRAIN_PREFIX + api_id + ".json"
    ):
        _fail("accepted-run successor drain path differs")
    return _publish_accepted_reattach_record(
        drain_path, drain, "accepted-run successor drain"
    )


def _positive(environment: Mapping[str, str], name: str, default: int) -> int:
    value = environment.get(name)
    try:
        parsed = default if value is None else int(value, 10)
    except (TypeError, ValueError):
        _fail(f"{name} must be a positive integer")
    if parsed <= 0:
        _fail(f"{name} must be a positive integer")
    return parsed


def _docker_host_budget_limits(environment: Mapping[str, str]) -> tuple[int, int, bool]:
    cpu_value = environment.get("FULLMAG_DOCKER_CPU_MILLIS")
    memory_value = environment.get("FULLMAG_DOCKER_MEMORY_BYTES")
    if (cpu_value is None) != (memory_value is None):
        _fail("FULLMAG_DOCKER_CPU_MILLIS and FULLMAG_DOCKER_MEMORY_BYTES must be set together")
    if cpu_value is None:
        return 4000, 7 * GIB, False

    parsed = []
    for name, value in (
        ("FULLMAG_DOCKER_CPU_MILLIS", cpu_value),
        ("FULLMAG_DOCKER_MEMORY_BYTES", memory_value),
    ):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]+", value):
            _fail(f"{name} must be a positive integer")
        number = int(value, 10)
        if not 0 < number <= 2**64 - 1:
            _fail(f"{name} must be a positive integer")
        parsed.append(number)
    cpu_millis, full_memory_bytes = parsed
    if cpu_millis < 2000 or cpu_millis % 1000:
        _fail("FULLMAG_DOCKER_CPU_MILLIS requires at least two whole CPUs for separate compute and preparation placements")
    if full_memory_bytes <= GIB:
        _fail("FULLMAG_DOCKER_MEMORY_BYTES must exceed 1 GiB of API headroom")
    return cpu_millis, full_memory_bytes - GIB, True


def build_configuration(
    paths: RuntimePaths | None = None, environment: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """Return the separate v1 CPU profile with its legacy fixed limits."""

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


def _validate_host_profile(
    value: Mapping[str, Any], paths: RuntimePaths, device_access: str = "gpu"
) -> dict[str, Any]:
    """Check the Docker budget boundary around the canonical Rust host factory."""
    if device_access not in DEVICE_ACCESS_CHOICES:
        _fail("FULLMAG_DOCKER_DEVICE_ACCESS must be cpu or gpu")
    cpu_limit_millis, memory_limit_bytes, approved_budget = _docker_host_budget_limits(os.environ)
    expected_profile_schema = (
        HOST_PROFILE_SCHEMA if device_access == "gpu" else CPU_HOST_PROFILE_SCHEMA
    )
    if value.get("schema_version") != expected_profile_schema:
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
    expected_policy_schema = (
        HOST_POLICY_GPU_SCHEMA if device_access == "gpu" else HOST_POLICY_CPU_SCHEMA
    )
    if not isinstance(policy, dict) or policy.get("schema_version") != expected_policy_schema:
        _fail(
            "Docker host profile requires the native readiness/topology-bound host policy "
            + expected_policy_schema
        )
    compute = config.get("compute_resources")
    preparation = config.get("preparation_resources")
    expected_compute_kinds = {"cpu", "gpu"} if device_access == "gpu" else {"cpu"}
    expected_compute_count = 2 if device_access == "gpu" else 1
    if (not isinstance(compute, list) or len(compute) != expected_compute_count
            or not all(isinstance(offer, dict) for offer in compute)
            or {offer.get("kind") for offer in compute} != expected_compute_kinds
            or not isinstance(preparation, list) or len(preparation) != 1
            or not isinstance(preparation[0], dict)):
        _fail(
            "Docker host profile requires "
            + ("CPU, GPU and preparation offers" if device_access == "gpu"
               else "one CPU and one preparation offer")
        )
    placements = host.get("compute_placements")
    prep_placements = host.get("preparation_cpu_ids")
    uuids = policy.get("gpu_vram_bytes_by_uuid")
    if device_access == "cpu" and uuids is None:
        uuids = {}
    if (not isinstance(placements, dict) or not isinstance(prep_placements, dict)
            or not isinstance(uuids, dict)):
        _fail("Docker host profile lacks exact physical resource placements")
    gpu_uuid = vram = None
    if device_access == "gpu":
        if len(uuids) != 1:
            _fail("Docker host profile requires one physical GPU capacity")
        gpu_uuid, vram = next(iter(uuids.items()))
        if (not isinstance(gpu_uuid, str)
                or not re.fullmatch(r"GPU-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", gpu_uuid)
                or type(vram) is not int or vram <= 0):
            _fail("Docker host profile requires one full physical NVIDIA UUID and measured VRAM")
    elif uuids:
        _fail("Docker CPU host profile cannot contain GPU capacity")
    if device_access == "cpu":
        identity = value.get("host_identity")
        readiness = value.get("readiness")
        if not isinstance(identity, dict) or identity.get("gpu_uuids") != []:
            _fail("Docker CPU host profile must attest an empty GPU identity")
        if not isinstance(readiness, dict):
            _fail("Docker CPU host profile has no native CPU readiness")
        if (readiness.get("schema_version") != HOST_READINESS_CPU_SCHEMA
                or readiness.get("status") != "ready"
                or readiness.get("source_kind") != "native_fem_cpu_abi"
                or readiness.get("capabilities") != ["fem.cpu"]
                or readiness.get("gpu_runtime_compatibility") != {}
                or readiness.get("gpu_visibility") != "unavailable"):
            _fail("Docker CPU host profile has invalid native CPU readiness")
        for field in ("source_snapshot_sha256", "runtime_identity_sha256",
                      "inventory_sha256", "capabilities_sha256"):
            if not isinstance(readiness.get(field), str) or not HEX64.fullmatch(readiness[field]):
                _fail("Docker CPU host readiness has an invalid " + field)
        if readiness["inventory_sha256"] != policy.get("topology_sha256"):
            _fail("Docker CPU readiness topology differs from host policy")
        if identity.get("inventory_sha256") != readiness["inventory_sha256"]:
            _fail("Docker CPU host identity differs from readiness inventory")
        if identity.get("capabilities_sha256") != readiness["capabilities_sha256"]:
            _fail("Docker CPU host identity differs from readiness capabilities")
        allowed_cpu_ids = policy.get("allowed_cpu_ids")
        if (not isinstance(allowed_cpu_ids, list) or not allowed_cpu_ids
                or any(type(cpu_id) is not int or cpu_id < 0 for cpu_id in allowed_cpu_ids)
                or len(set(allowed_cpu_ids)) != len(allowed_cpu_ids)):
            _fail("Docker CPU host policy has no explicit allowed CPU IDs")
        if identity.get("allowed_cpu_ids") != allowed_cpu_ids:
            _fail("Docker CPU host identity differs from the pinned CPU policy")
    else:
        allowed_cpu_ids = policy.get("allowed_cpu_ids")
        if (not isinstance(value.get("readiness"), dict)
                or value["readiness"].get("schema_version") != HOST_READINESS_GPU_SCHEMA):
            _fail("Docker GPU host profile requires native GPU readiness v1")
    cpu_budgets, memory_budgets = [], []
    for offer_index, offer in enumerate([*compute, *preparation]):
        is_preparation = offer_index == len(compute)
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
        if device_access == "cpu":
            placement = placements.get(offer.get("resource_id"))
            if offer.get("kind") != "cpu" and not is_preparation:
                _fail("Docker CPU host profile contains an unexpected compute kind")
            if is_preparation:
                cpu_ids = prep_placements.get(offer.get("resource_id"))
            else:
                cpu_ids = placement.get("cpu_ids") if isinstance(placement, dict) else None
                if isinstance(placement, dict) and placement.get("gpu_uuid") is not None:
                    _fail("Docker CPU offer cannot have a GPU placement")
            if (not isinstance(cpu_ids, list) or not cpu_ids
                    or any(type(cpu_id) is not int or cpu_id < 0 for cpu_id in cpu_ids)
                    or any(cpu_id not in allowed_cpu_ids for cpu_id in cpu_ids)
                    or len(set(cpu_ids)) != len(cpu_ids)):
                _fail("Docker CPU offer has no pinned allowed CPU placement")
        cpu_budgets.append(budget["cpu_millis"])
        memory_budgets.append(budget["memory_bytes"])
    # Compute offers are mutually exclusive; preparation has its own slot.
    if device_access == "gpu":
        cpu_total = max(cpu_budgets[:2]) + cpu_budgets[2]
        memory_total = max(memory_budgets[:2]) + memory_budgets[2]
    else:
        cpu_total = sum(cpu_budgets)
        memory_total = sum(memory_budgets)
    if cpu_total > cpu_limit_millis:
        _fail("Docker host offers exceed the approved backend CPU budget")
    if memory_total > memory_limit_bytes:
        _fail("Docker host offers exceed approved memory minus API headroom")
    if approved_budget and (cpu_total != cpu_limit_millis or memory_total != memory_limit_bytes):
        _fail("Docker host offers do not match the complete approved backend budget")
    return config


def initialize_host_configuration(
    paths: RuntimePaths, device_access: str = "gpu",
    capacity_authority: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Discover native devices and initialize the exact shared Rust ledger."""
    if device_access not in DEVICE_ACCESS_CHOICES:
        _fail("FULLMAG_DOCKER_DEVICE_ACCESS must be cpu or gpu")
    daemon_host_id = _validated_docker_host_id()
    logical_host_id = _initializer_host_id(daemon_host_id)
    executable = paths.package / "bin" / "fullmag-runtime-service"
    _assert_no_links(executable, "runtime service executable")
    if not executable.is_file() or not os.access(executable, os.X_OK):
        _fail("native runtime service executable is unavailable")
    try:
        result = subprocess.run(
            [str(executable), "--initialize-docker-host", "--ledger-root", str(HOST_LEDGER_ROOT),
             "--store-root", str(paths.store), "--device-access", device_access,
             "--host-id", logical_host_id],
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
    if os.environ.get("FULLMAG_DOCKER_HOST_CAPACITY_MIGRATION_SHA256") is not None and result.stderr:
        # The native receipt is diagnostic output; preserve it in the backend
        # log rather than discarding it with the successful subprocess capture.
        print(result.stderr[-MAX_JSON_BYTES:].decode("utf-8", errors="replace"),
              file=sys.stderr, end="", flush=True)
    if len(result.stdout) > MAX_JSON_BYTES:
        _fail("native Docker host profile exceeds its bounded size")
    try:
        value = json.loads(result.stdout, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeServiceError("native Docker host profile is invalid JSON") from error
    if not isinstance(value, dict):
        _fail("native Docker host profile must contain an object")
    config = _validate_host_profile(value, paths, device_access)
    if capacity_authority is not None:
        capacity_authority.clear()
        evidence = value.get("capacity_migration")
        if evidence is not None:
            descriptor = os.environ.get("FULLMAG_DOCKER_HOST_CAPACITY_SHA256")
            requested = os.environ.get("FULLMAG_DOCKER_HOST_CAPACITY_MIGRATION_SHA256")
            if (not isinstance(evidence, dict)
                    or set(evidence) != {"descriptor_sha256", "historical_policies"}
                    or not isinstance(requested, str) or not HEX64.fullmatch(requested)
                    or descriptor != requested or evidence["descriptor_sha256"] != requested
                    or not isinstance(evidence["historical_policies"], list)
                    or len(evidence["historical_policies"]) > 16
                    or any(not isinstance(policy, dict) for policy in evidence["historical_policies"])):
                _fail("native capacity transition evidence differs from the explicit descriptor")
            capacity_authority.update(
                descriptor_sha256=requested,
                current_policy=config["host_execution"]["policy"],
                historical_policies=evidence["historical_policies"],
            )
    return config


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


def _capacity_projection(config: dict[str, Any]) -> dict[str, Any] | None:
    """Project a configuration onto the fields a measured transition keeps."""
    result = dict(config)
    for name in ("compute_resources", "preparation_resources"):
        offers = result.get(name)
        if (not isinstance(offers, list) or not offers
                or any(not isinstance(offer, dict) or not isinstance(offer.get("budget"), dict)
                       for offer in offers)):
            return None
        result[name] = [
            {**offer, "budget": {
                key: value for key, value in offer["budget"].items()
                if key not in {"cpu_millis", "memory_bytes"}
            }}
            for offer in offers
        ]
    host = result.get("host_execution")
    if not isinstance(host, dict):
        return None
    host = dict(host)
    host.pop("policy", None)
    host.pop("runtime_generation_sha256", None)
    placements = host.get("compute_placements")
    preparation = host.get("preparation_cpu_ids")
    if (not isinstance(placements, dict) or not isinstance(preparation, dict)
            or any(not isinstance(value, dict) for value in placements.values())
            or any(not isinstance(value, list) for value in preparation.values())):
        return None
    # Resource identities, GPU UUIDs, concurrency, paths and timing remain
    # exact, including storage and GPU memory. Only CPU/RAM budgets and CPU
    # masks are permitted to vary.
    host["compute_placements"] = {
        key: {field: value for field, value in placement.items() if field != "cpu_ids"}
        for key, placement in placements.items()
    }
    host["preparation_cpu_ids"] = dict.fromkeys(preparation)
    result["host_execution"] = host
    return result


def _group_ledger_transition_allowed(current: dict[str, Any], expected: dict[str, Any]) -> bool:
    """Allow one move of a DEV group from the global ledger to its own ledger.

    The caller holds the authenticated terminal drain of the previous owner.
    Only the policy (host ID and the group's own budget/topology) and the
    CPU/RAM budgets and masks may change; paths, pools, resource identities,
    GPU placement and concurrency stay exact.  Reservations of the global
    ledger are not carried over (ADR 0067).  A configuration that is already
    bound to this group's host ID never takes this path again.
    """
    if os.environ.get("FULLMAG_HOST_LEDGER_PROFILE") != GROUP_LEDGER_PROFILE:
        return False
    group_host_id = os.environ.get(GROUP_LEDGER_HOST_ID_ENV)
    old_host, new_host = current.get("host_execution"), expected.get("host_execution")
    if (not isinstance(old_host, dict) or not isinstance(new_host, dict)
            or not isinstance(old_host.get("policy"), dict)
            or not isinstance(new_host.get("policy"), dict)
            or not isinstance(group_host_id, str) or not HEX64.fullmatch(group_host_id)):
        return False
    # Only a global identity (daemon digest or legacy ID) may move to the
    # group; a configuration bound to any other group ID never re-binds.
    global_host_ids = {os.environ.get("FULLMAG_DOCKER_HOST_ID"), LEGACY_DOCKER_HOST_ID}
    if (new_host["policy"].get("host_id") != group_host_id
            or old_host["policy"].get("host_id") not in global_host_ids - {None}
            or old_host.get("ledger_root") != str(HOST_LEDGER_ROOT)
            or new_host.get("ledger_root") != str(HOST_LEDGER_ROOT)):
        return False
    old_projection, new_projection = _capacity_projection(current), _capacity_projection(expected)
    return old_projection is not None and old_projection == new_projection


def _capacity_profile_transition_allowed(
    current: dict[str, Any], expected: dict[str, Any], authority: Mapping[str, Any] | None,
) -> bool:
    """Constrain an explicit stopped-consumer transition to native-measured capacity.

    Native validates the complete anchored policy history. This adapter only
    compares that returned evidence and preserves the rest of the profile.
    """
    if not isinstance(authority, Mapping):
        return False
    descriptor = authority.get("descriptor_sha256")
    if (not isinstance(descriptor, str) or not HEX64.fullmatch(descriptor)
            or descriptor != os.environ.get("FULLMAG_DOCKER_HOST_CAPACITY_SHA256")
            or descriptor != os.environ.get("FULLMAG_DOCKER_HOST_CAPACITY_MIGRATION_SHA256")):
        return False
    old_host, new_host = current.get("host_execution"), expected.get("host_execution")
    if not isinstance(old_host, dict) or not isinstance(new_host, dict):
        return False
    history = authority.get("historical_policies")
    if (not isinstance(history, list)
            or new_host.get("policy") != authority.get("current_policy")
            or old_host.get("policy") not in [new_host.get("policy"), *history]):
        return False

    old_projection, new_projection = _capacity_projection(current), _capacity_projection(expected)
    return old_projection is not None and old_projection == new_projection


def _rotate_configuration_generation(
    paths: RuntimePaths, current: dict[str, Any], expected: dict[str, Any], previous_sha256: str,
    *, capacity_authority: Mapping[str, Any] | None = None,
) -> None:
    """Change a generation or explicitly measured capacity after an owned stop."""
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
            != {**expected, "host_execution": new_profile}
            and not _capacity_profile_transition_allowed(current, expected, capacity_authority)
            and not _group_ledger_transition_allowed(current, expected)):
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


POST_BUILD_START_SCHEMA = "fullmag.docker-post-build-failed-owner-start.v1"
POST_BUILD_METADATA_SCHEMA = "fullmag.docker-post-build-failed-owner-continuation.v1"
POST_BUILD_START_ENV = "FULLMAG_DOCKER_POST_BUILD_CONTINUATION"
POST_BUILD_START_SHA_ENV = "FULLMAG_DOCKER_POST_BUILD_CONTINUATION_SHA256"
POST_BUILD_CONSUMED_SCHEMA = "fullmag.docker-post-build-failed-owner-consumed.v1"
POST_BUILD_CONSUMED_RELATIVE = PurePosixPath("post-build-continuation")
POST_BUILD_MAX_BYTES = 512 * 1024
POST_BUILD_TOKEN = re.compile(r"^[0-9a-f]{32}$")
POST_BUILD_IMAGE = re.compile(r"^sha256:[0-9a-f]{64}$")
POST_BUILD_CONTAINER = re.compile(r"^[0-9a-f]{64}$")
POST_BUILD_PROCESS_KEYS = (
    "schema", "state", "api_pid", "api_exit_code", "accepted_store",
    "bootstrap", "qualification", "error", "shutdown_error",
)
POST_BUILD_PROCESS_ERROR = (
    "API binding did not become ready: API loopback probe failed for "
    "/v2/platform/openapi.json: [Errno 111] Connection refused"
)
POST_BUILD_PROCESS_SHUTDOWN_ERROR = (
    "no pinned runtime service owner was available for authenticated drain"
)
POST_BUILD_LIVE_OPERATION_STATES = frozenset(
    {"starting", "starting-services", "running", "recreating-services", "resuming-observation"}
)


def _post_build_canonical(value: Mapping[str, Any]) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode(
        "utf-8"
    )


def _post_build_open_fd(path: Path, name: str, flags: int) -> int:
    """Open one control-volume path with an fd-relative no-follow walk."""

    path = _absolute(path, name)
    if os.open not in getattr(os, "supports_dir_fd", set()):
        _fail(f"{name} requires fd-relative path support")
    parts = path.parts
    if len(parts) < 2:
        _fail(f"{name} is not a regular file path")
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    directory_flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    parent = None
    descriptor = None
    try:
        parent = os.open(path.anchor, directory_flags)
        for component in parts[1:-1]:
            child = os.open(component, directory_flags, dir_fd=parent)
            os.close(parent)
            parent = child
        descriptor = os.open(
            parts[-1], flags | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
            dir_fd=parent,
        )
    except FileNotFoundError:
        raise
    except TypeError as error:
        _fail(f"{name} cannot use fd-relative path resolution: {error}")
    except OSError as error:
        _fail(f"{name} cannot be opened safely: {error}")
    finally:
        if parent is not None:
            os.close(parent)
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        os.close(descriptor)
        _fail(f"{name} is not a single-link regular file")
    return descriptor


def _post_build_read_bytes(path: Path, name: str, maximum: int = POST_BUILD_MAX_BYTES) -> bytes:
    descriptor = _post_build_open_fd(path, name, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    try:
        metadata = os.fstat(descriptor)
        if metadata.st_size > maximum:
            _fail(f"{name} exceeds its size bound")
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


def _post_build_read_optional_bytes(
    path: Path, name: str, maximum: int = POST_BUILD_MAX_BYTES
) -> bytes | None:
    try:
        return _post_build_read_bytes(path, name, maximum)
    except FileNotFoundError:
        return None


def _post_build_json(raw: bytes, name: str, *, canonical: bool = False) -> dict[str, Any]:
    try:
        value = json.loads(
            raw,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=lambda constant: (_ for _ in ()).throw(
                ValueError(f"non-finite JSON constant {constant}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        _fail(f"{name} is not valid JSON: {error}")
    if not isinstance(value, dict):
        _fail(f"{name} must contain a JSON object")
    if canonical and raw != _post_build_canonical(value):
        _fail(f"{name} is not canonical JSON")
    return value


def _post_build_read_json(path: Path, name: str, *, canonical: bool = False) -> tuple[bytes, dict[str, Any]]:
    raw = _post_build_read_bytes(path, name)
    return raw, _post_build_json(raw, name, canonical=canonical)


def _post_build_digest(value: Any, name: str) -> str:
    if not isinstance(value, str) or HEX64.fullmatch(value) is None or set(value) == {"0"}:
        _fail(f"{name} is not a non-zero lowercase SHA-256")
    return value


def _post_build_token(value: Any, name: str) -> str:
    if not isinstance(value, str) or POST_BUILD_TOKEN.fullmatch(value) is None:
        _fail(f"{name} is not a lowercase operation token")
    return value


def _post_build_text(value: Any, name: str, maximum: int = 4096) -> str:
    if (not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value
            or any(ord(character) < 32 for character in value)):
        _fail(f"{name} is not bounded text")
    return value


def _post_build_relative(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024:
        _fail(f"{name} is not a bounded relative path")
    parsed = PurePosixPath(value)
    if (parsed.is_absolute() or str(parsed) != value or "\\" in value or ":" in value
            or any(part in {"", ".", ".."} for part in parsed.parts)):
        _fail(f"{name} escapes its control root")
    return value


def _post_build_control_path(value: Any, name: str) -> Path:
    if not isinstance(value, str) or not value:
        _fail(f"{name} is missing")
    path = _absolute(Path(value), name)
    try:
        relative = path.relative_to(BUILD_CONTROL_ROOT)
    except ValueError:
        _fail(f"{name} is outside the build-control volume")
    if str(path) != value or any(part in {"", ".", ".."} for part in relative.parts):
        _fail(f"{name} is not a canonical build-control path")
    return path



def _post_build_validate_stable_identity(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail("post-build certificate stable identity is not an object")
    profile = value.get("storage_profile")
    if profile == WINDOWS_STORAGE_PROFILE:
        required = {
            "schema", "storage_profile", "role", "owner_scope", "owner_token", "engine_id",
            "host_root", "host_filesystem", "host_drive_type", "host_volume_serial",
            "host_root_no_reparse",
        }
        expected_schema = "fullmag.windows-folder-host.v1"
        expected_scope = "docker-desktop-linux"
    elif profile == LINUX_STORAGE_PROFILE:
        required = {
            "schema", "storage_profile", "role", "owner_scope", "owner_token", "engine_id",
            "host_root", "host_filesystem", "host_platform", "host_device",
            "host_root_no_reparse", "host_inode",
        }
        expected_schema = "fullmag.linux-native-host.v1"
        expected_scope = "docker-linux"
    else:
        _fail("post-build certificate stable identity has an unsupported storage profile")
    if set(value) != required or value.get("schema") != expected_schema \
            or value.get("role") != "session" or value.get("owner_scope") != expected_scope:
        _fail("post-build certificate stable identity fields differ")
    owner_token = value.get("owner_token")
    if profile == WINDOWS_STORAGE_PROFILE:
        if not isinstance(owner_token, str) or re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                owner_token,
        ) is None or set(owner_token.replace("-", "")) == {"0"}:
            _fail("post-build Windows stable owner token is invalid")
    elif (not isinstance(owner_token, str) or re.fullmatch(r"[0-9a-f]{32}", owner_token) is None
          or set(owner_token) == {"0"}):
        _fail("post-build Linux stable owner token is invalid")
    for field, maximum in (("engine_id", 256), ("host_root", 4096), ("host_filesystem", 64)):
        _post_build_text(value.get(field), "post-build stable " + field, maximum)
    if value.get("host_root_no_reparse") is not True:
        _fail("post-build stable identity permits reparse roots")
    if profile == WINDOWS_STORAGE_PROFILE:
        if (type(value.get("host_drive_type")) is not int
                or value["host_drive_type"] != 3
                or type(value.get("host_volume_serial")) is not int
                or value["host_volume_serial"] < 0):
            _fail("post-build Windows stable volume identity is invalid")
    else:
        _post_build_text(value.get("host_platform"), "post-build stable host platform", 64)
        if (type(value.get("host_device")) is not int or value["host_device"] <= 0
                or type(value.get("host_inode")) is not int or value["host_inode"] <= 0):
            _fail("post-build Linux stable volume identity is invalid")
    return dict(value)


def _post_build_certificate_stable_identity(certificate: Mapping[str, Any]) -> dict[str, Any]:
    profile = certificate.get("storage_profile") if isinstance(certificate, Mapping) else None
    fields = (
        {
            "schema", "storage_profile", "role", "owner_scope", "owner_token", "engine_id",
            "host_root", "host_filesystem", "host_drive_type", "host_volume_serial",
            "host_root_no_reparse",
        }
        if profile == WINDOWS_STORAGE_PROFILE else {
            "schema", "storage_profile", "role", "owner_scope", "owner_token", "engine_id",
            "host_root", "host_filesystem", "host_platform", "host_device",
            "host_root_no_reparse", "host_inode",
        }
        if profile == LINUX_STORAGE_PROFILE else set()
    )
    if not fields:
        _fail("post-build host certificate has an unsupported storage profile")
    return _post_build_validate_stable_identity({key: certificate.get(key) for key in fields})

def _post_build_validate_recreate(metadata: Mapping[str, Any]) -> None:
    """Validate the host's completed recreation reference, not Docker semantics."""
    record = metadata.get("recreate_operation")
    fields = {
        "schema", "operation_id", "terminal_relative", "terminal_sha256",
        "retained_relative", "retained_sha256", "prior_terminal_sha256",
        "prior_compose_sha256", "backend_container", "frontend_container", "image_id", "absence",
    }
    if (not isinstance(record, dict) or set(record) != fields
            or record.get("schema") != "fullmag.docker-removed-recreation-container.v1"):
        _fail("post-build recreation reference schema or fields differ")
    token = _post_build_token(record["operation_id"], "post-build recreation attempt")
    prefix = "recreate-services/attempts/" + token
    if (record["terminal_relative"] != prefix + "/terminal.json"
            or record["retained_relative"] != prefix + "/retained-containers.json"):
        _fail("post-build recreation reference paths differ")
    for field in ("terminal_sha256", "retained_sha256", "prior_terminal_sha256", "prior_compose_sha256"):
        _post_build_digest(record[field], "post-build recreation " + field)
    for field in ("backend_container", "frontend_container"):
        if not isinstance(record[field], str) or POST_BUILD_CONTAINER.fullmatch(record[field]) is None:
            _fail("post-build recreation container identity is invalid")
    namespace = metadata["current_namespace"]
    if (record["backend_container"] != namespace["container_id"]
            or record["image_id"] != namespace["image_id"]
            or record["backend_container"] == record["frontend_container"]):
        _fail("post-build recreation does not bind the outgoing namespace")
    absence = record["absence"]
    if not isinstance(absence, dict) or set(absence) != {"backend", "frontend"}:
        _fail("post-build recreation absence fields differ")
    for service in ("backend", "frontend"):
        item = absence[service]
        if (not isinstance(item, dict) or set(item) != {
                "container_id", "inspect_returncode", "inspect_output_sha256",
                "ps_returncode", "ps_output_sha256"}
                or item["container_id"] != record[service + "_container"]
                or type(item["inspect_returncode"]) is not int or item["inspect_returncode"] == 0
                or type(item["ps_returncode"]) is not int or item["ps_returncode"] != 0):
            _fail("post-build recreation absence identity or outcome differs")
        _post_build_digest(item["inspect_output_sha256"], "post-build Docker inspect absence")
        _post_build_digest(item["ps_output_sha256"], "post-build Docker ps absence")


def _post_build_read_recreate(metadata: Mapping[str, Any]) -> None:
    record = metadata["recreate_operation"]
    for path_field, digest_field in (("terminal_relative", "terminal_sha256"), ("retained_relative", "retained_sha256")):
        path = BUILD_CONTROL_ROOT / record[path_field]
        raw = _post_build_read_bytes(path, "post-build recreation evidence")
        if _sha256_bytes(raw) != record[digest_field]:
            _fail("post-build recreation evidence changed after host proof")
        value = _post_build_json(raw, "post-build recreation evidence", canonical=True)
        if path_field == "terminal_relative":
            if (value.get("schema") != "fullmag.docker-build-operation.v1"
                    or value.get("phase") != "recreate-services" or value.get("state") != "succeeded"
                    or value.get("attempt") != record["operation_id"]
                    or value.get("compose_project") != metadata["compose_project"]
                    or value.get("removed_containers") != [record["backend_container"], record["frontend_container"]]):
                _fail("post-build recreation terminal does not confirm the exact removed services")


def _post_build_validate_metadata(metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        _fail("post-build continuation metadata is not an object")
    required = {
        "schema", "state", "operation_id", "compose_project", "source_root", "source_identity",
        "original_stop", "current_namespace", "failed_owner", "current_process",
        "runtime_config", "certificate", "accepted_run", "recreate_operation",
    }
    if set(metadata) != required or metadata.get("schema") != POST_BUILD_METADATA_SCHEMA \
            or metadata.get("state") != "authorized":
        _fail("post-build continuation metadata schema or fields differ")
    _post_build_token(metadata.get("operation_id"), "continuation operation")
    _post_build_text(metadata.get("compose_project"), "continuation Compose project")
    _post_build_text(metadata.get("source_root"), "continuation source root")
    source = metadata["source_identity"]
    if not isinstance(source, dict) or set(source) != {"project_id", "worktree_id", "checkout_kind"}:
        _fail("continuation source identity is incomplete")
    for field in source:
        _post_build_text(source[field], "continuation source " + field, 256)

    original = metadata["original_stop"]
    original_fields = {
        "relative", "sha256", "container_id", "image_id", "failure_kind",
        "native_failure_probe_sha256", "terminal_process_sha256", "terminal_owner_sha256",
    }
    if not isinstance(original, dict) or set(original) != original_fields:
        _fail("continuation original stop record is incomplete")
    _post_build_relative(original["relative"], "continuation original stop path")
    for field in ("sha256", "native_failure_probe_sha256", "terminal_process_sha256", "terminal_owner_sha256"):
        _post_build_digest(original[field], "continuation original stop " + field)
    if (not isinstance(original["container_id"], str)
            or POST_BUILD_CONTAINER.fullmatch(original["container_id"]) is None
            or set(original["container_id"]) == {"0"}):
        _fail("continuation original container is invalid")
    if (not isinstance(original["image_id"], str)
            or POST_BUILD_IMAGE.fullmatch(original["image_id"]) is None
            or set(original["image_id"][7:]) == {"0"}):
        _fail("continuation original image is invalid")
    _post_build_text(original["failure_kind"], "continuation failure kind", 64)

    namespace = metadata["current_namespace"]
    namespace_fields = {"container_id", "image_id", "started_at", "finished_at", "exit_code"}
    if not isinstance(namespace, dict) or set(namespace) != namespace_fields:
        _fail("continuation current namespace is incomplete")
    if (not isinstance(namespace["container_id"], str)
            or POST_BUILD_CONTAINER.fullmatch(namespace["container_id"]) is None
            or set(namespace["container_id"]) == {"0"}):
        _fail("continuation current container is invalid")
    if (not isinstance(namespace["image_id"], str)
            or POST_BUILD_IMAGE.fullmatch(namespace["image_id"]) is None
            or set(namespace["image_id"][7:]) == {"0"}):
        _fail("continuation current image is invalid")
    _post_build_text(namespace["started_at"], "continuation current StartedAt")
    _post_build_text(namespace["finished_at"], "continuation current FinishedAt")
    if type(namespace["exit_code"]) is not int:
        _fail("continuation current exit code is invalid")

    owner = metadata["failed_owner"]
    if not isinstance(owner, dict) or set(owner) != {"relative", "sha256", "identity"}:
        _fail("continuation Failed owner record is incomplete")
    if owner["relative"] != "runtime-control/runtime-services/OWNER.json":
        _fail("continuation Failed owner path differs")
    _post_build_digest(owner["sha256"], "continuation Failed owner")
    identity_fields = {
        "owner_token", "process_start_token", "pid", "host", "target_id", "control_address",
        "build_commit", "build_snapshot", "compute_pool_id", "preparation_pool_id",
        "compute_pool_generation", "preparation_pool_generation",
    }
    if not isinstance(owner["identity"], dict) or set(owner["identity"]) != identity_fields:
        _fail("continuation Failed owner identity differs")

    process = metadata["current_process"]
    process_fields = {
        "relative", "sha256", "immutable_keys", "api_pid", "api_exit_code",
        "error_sha256", "shutdown_error_sha256",
    }
    if not isinstance(process, dict) or set(process) != process_fields:
        _fail("continuation process record is incomplete")
    if process["relative"] != "runtime-control/runtime-service/process-tree.json":
        _fail("continuation process path differs")
    _post_build_digest(process["sha256"], "continuation process")
    if process["immutable_keys"] != list(POST_BUILD_PROCESS_KEYS):
        _fail("continuation process immutable keys differ")
    if (type(process["api_pid"]) is not int or process["api_pid"] <= 0
            or type(process["api_exit_code"]) is not int
            or process["api_exit_code"] != 101):
        _fail("continuation process identity differs")
    for field in ("error_sha256", "shutdown_error_sha256"):
        _post_build_digest(process[field], "continuation process " + field)

    config = metadata["runtime_config"]
    if not isinstance(config, dict) or set(config) != {"relative", "sha256"}:
        _fail("continuation runtime config record is incomplete")
    if config["relative"] != "runtime-control/runtime-service/docker-all.json":
        _fail("continuation runtime config path differs")
    _post_build_digest(config["sha256"], "continuation runtime config")

    certificate = metadata["certificate"]
    certificate_fields = {
        "historical_certificate_sha256", "historical_owner_marker_sha256",
        "stable_identity", "storage_profile", "restart_verified",
    }
    if not isinstance(certificate, dict) or set(certificate) != certificate_fields:
        _fail("continuation certificate is incomplete")
    _post_build_digest(
        certificate["historical_certificate_sha256"], "continuation historical certificate"
    )
    _post_build_digest(
        certificate["historical_owner_marker_sha256"], "continuation historical owner marker"
    )
    stable_identity = _post_build_validate_stable_identity(certificate["stable_identity"])
    if certificate["storage_profile"] != stable_identity["storage_profile"]:
        _fail("continuation certificate profile differs from stable identity")
    if certificate["restart_verified"] is not True:
        _fail("continuation certificate is not restart_verified")

    _post_build_validate_recreate(metadata)
    accepted = metadata["accepted_run"]
    if accepted != {}:
        accepted_fields = {
            "schema", "state", "run_id", "project_id", "store_run_relative", "request_relative",
            "proof_relative", "source_root", "source_relative", "compose_project", "control_volume",
            "logical_session_id", "session_epoch", "stop_verification_relative",
            "terminal_process_record_relative", "terminal_owner_record_relative", "development_attempt",
            "activation_attempt", "reconciliation_attempt", "backend_container", "image_id",
            "request_sha256", "proof_sha256", "terminal_process_record_sha256",
            "terminal_owner_record_sha256", "stop_reconcile_proof_sha256", "stop_verification_sha256",
            "catalog_revision", "task_count",
        }
        if not isinstance(accepted, dict) or set(accepted) != accepted_fields:
            _fail("continuation accepted-run record is incomplete")
        if (accepted["schema"] != "fullmag.docker-accepted-run-reattach-producer.v1"
                or accepted["state"] != "prepared"):
            _fail("continuation accepted-run record is not prepared")
        for field in (
            "request_sha256", "proof_sha256", "terminal_process_record_sha256",
            "terminal_owner_record_sha256", "stop_reconcile_proof_sha256", "stop_verification_sha256",
        ):
            _post_build_digest(accepted[field], "continuation accepted-run " + field)
        for field in (
            "run_id", "project_id", "store_run_relative", "request_relative", "proof_relative",
            "source_root", "source_relative", "compose_project", "control_volume",
            "logical_session_id", "stop_verification_relative",
            "terminal_process_record_relative", "terminal_owner_record_relative",
            "development_attempt", "activation_attempt", "reconciliation_attempt",
        ):
            _post_build_text(accepted[field], "continuation accepted-run " + field)
        for field in (
            "source_relative", "stop_verification_relative", "terminal_process_record_relative",
            "terminal_owner_record_relative",
        ):
            _post_build_relative(accepted[field], "continuation accepted-run " + field)
        accepted_backend = accepted["backend_container"]
        if (not isinstance(accepted_backend, str)
                or POST_BUILD_CONTAINER.fullmatch(accepted_backend) is None):
            _fail("continuation accepted-run backend container is invalid")
        accepted_image = accepted["image_id"]
        if (not isinstance(accepted_image, str)
                or POST_BUILD_IMAGE.fullmatch(accepted_image) is None):
            _fail("continuation accepted-run image is invalid")
        if accepted["stop_verification_relative"] != (
                "verification/stop-failed-" + accepted_backend + ".json"):
            _fail("continuation accepted-run stop path is not bound to its backend")
        if (type(accepted["session_epoch"]) is not int or accepted["session_epoch"] <= 0
                or type(accepted["catalog_revision"]) is not int
                or accepted["catalog_revision"] <= 0
                or type(accepted["task_count"]) is not int
                or accepted["task_count"] <= 0):
            _fail("continuation accepted-run catalog pin is invalid")
    return dict(metadata)


def _post_build_validate_binding_document(binding: Any) -> dict[str, Any]:
    if not isinstance(binding, dict):
        _fail("post-build start binding is not an object")
    required = {
        "schema", "state", "attempt", "receipt_relative", "active_relative", "active_token",
        "continuation_relative", "continuation_sha256", "previous_config_sha256", "continuation",
    }
    if set(binding) != required or binding.get("schema") != POST_BUILD_START_SCHEMA:
        _fail("post-build start binding schema or fields differ")
    if binding.get("state") not in {"pending", "consumed"}:
        _fail("post-build start binding state is unsupported")
    token = _post_build_token(binding.get("attempt"), "post-build start attempt")
    if binding.get("active_relative") != "active" or binding.get("active_token") != token:
        _fail("post-build start binding active marker differs")
    expected_root = f"development/attempts/{token}"
    if binding.get("receipt_relative") != expected_root + "/receipt.json":
        _fail("post-build start binding receipt path differs")
    expected_relative = expected_root + "/post-build-continuation.json"
    if binding.get("continuation_relative") != expected_relative:
        _fail("post-build start binding continuation path differs")
    metadata = _post_build_validate_metadata(binding.get("continuation"))
    metadata_sha = _sha256_bytes(_post_build_canonical(metadata))
    if binding.get("continuation_sha256") != metadata_sha:
        _fail("post-build continuation digest differs")
    previous_sha = _post_build_digest(binding.get("previous_config_sha256"), "post-build previous config")
    if previous_sha != metadata["runtime_config"]["sha256"]:
        _fail("post-build previous config differs from continuation proof")
    return dict(binding)


def _post_build_validate_operation_lock() -> None:
    """Require the host helper's operation lease to remain genuinely held."""

    try:
        import fcntl
    except ImportError as error:
        _fail(f"post-build operation lease cannot be checked: {error}")
    descriptor = _post_build_open_fd(
        BUILD_CONTROL_ROOT / "operation.lock", "post-build operation lock", os.O_RDWR
    )
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        except OSError as error:
            if getattr(error, "errno", None) == 11:
                return
            _fail(f"post-build operation lease cannot be checked: {error}")
        else:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            _fail("post-build operation lease is not held")
    finally:
        os.close(descriptor)


@contextmanager
def _post_build_failed_owner_lock(paths: RuntimePaths):
    """Hold OWNER.lock while rechecking failed-owner evidence and publishing."""

    lock_path = runtime_services_root(paths) / "OWNER.lock"
    _assert_no_links(lock_path, "post-build runtime service owner lock")
    try:
        import fcntl
    except ImportError as error:
        _fail(f"post-build runtime service owner lock cannot be checked: {error}")
    descriptor = _post_build_open_fd(
        lock_path, "post-build runtime service owner lock", os.O_RDWR
    )
    try:
        identity = (os.fstat(descriptor).st_dev, os.fstat(descriptor).st_ino)
        _assert_owner_lock_identity(lock_path, descriptor, identity)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            _fail("post-build runtime service owner is still active")
        except OSError as error:
            if getattr(error, "errno", None) == 11:
                _fail("post-build runtime service owner is still active")
            _fail(f"post-build runtime service owner lock cannot be checked: {error}")
        try:
            _assert_owner_lock_identity(lock_path, descriptor, identity)
            yield lambda: _assert_owner_lock_identity(lock_path, descriptor, identity)
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


def _post_build_validate_process(raw: bytes, process: Mapping[str, Any], proof: Mapping[str, Any]) -> None:
    if set(process) != set(POST_BUILD_PROCESS_KEYS):
        _fail("post-build current process receipt is not the exact nine-key receipt")
    if process.get("schema") != "fullmag.docker-process-tree.v1" or process.get("state") != "shutdown_unknown":
        _fail("post-build current process receipt is not shutdown_unknown")
    if (type(process.get("api_pid")) is not int or process["api_pid"] <= 0
            or type(process.get("api_exit_code")) is not int
            or process.get("api_exit_code") != 101):
        _fail("post-build current process receipt API identity differs")
    store = _post_build_text(process.get("accepted_store"), "post-build accepted store")
    if (not PurePosixPath(store).is_absolute() or ".." in PurePosixPath(store).parts
            or not isinstance(process.get("bootstrap"), dict)
            or process.get("qualification") != "NOT VERIFIED"):
        _fail("post-build current process receipt has invalid store/bootstrap/qualification fields")
    if process.get("error") != POST_BUILD_PROCESS_ERROR \
            or process.get("shutdown_error") != POST_BUILD_PROCESS_SHUTDOWN_ERROR:
        _fail("post-build current process receipt failure text differs")
    process_proof = proof["current_process"]
    if (_sha256_bytes(raw) != process_proof["sha256"]
            or _sha256_bytes(process["error"].encode()) != process_proof["error_sha256"]
            or _sha256_bytes(process["shutdown_error"].encode()) != process_proof["shutdown_error_sha256"]):
        _fail("post-build current process receipt changed after host proof")


def _post_build_validate_current_evidence(
    paths: RuntimePaths, metadata: Mapping[str, Any], accepted_preflight: Mapping[str, Any] | None
) -> None:
    _post_build_read_recreate(metadata)
    expected_project = metadata["compose_project"]
    current_project = os.environ.get("FULLMAG_COMPOSE_PROJECT")
    if current_project is not None and current_project != expected_project:
        _fail("post-build Compose project differs from host proof")
    expected_source = metadata["source_root"]
    current_source = os.environ.get("FULLMAG_SOURCE_HOST_ROOT")
    if current_source is not None and current_source != expected_source:
        _fail("post-build source root differs from host proof")
    for field, environment_name in (
        ("project_id", "FULLMAG_SOURCE_PROJECT_ID"),
        ("worktree_id", "FULLMAG_SOURCE_WORKTREE_ID"),
        ("checkout_kind", "FULLMAG_SOURCE_CHECKOUT_KIND"),
    ):
        observed = os.environ.get(environment_name)
        if observed is not None and observed != metadata["source_identity"][field]:
            _fail("post-build source identity differs from host proof")

    owner_proof = metadata["failed_owner"]
    owner_raw = _post_build_read_bytes(
        runtime_services_root(paths) / "OWNER.json", "post-build current Failed OWNER.json"
    )
    if _sha256_bytes(owner_raw) != owner_proof["sha256"]:
        _fail("post-build current Failed OWNER.json changed after host proof")
    owner = _post_build_json(owner_raw, "post-build current Failed OWNER.json")
    if owner.get("schema_version") != "runtime_service_owner.v1" or owner.get("state") != "failed":
        _fail("post-build current owner is not the retained Failed owner")
    if _owner_identity(owner) != owner_proof["identity"]:
        _fail("post-build current owner identity differs from host proof")

    process_raw, process = _post_build_read_json(
        process_receipt_path(paths), "post-build current process receipt"
    )
    _post_build_validate_process(process_raw, process, metadata)

    certificate_proof = metadata["certificate"]
    certificate_raw = _post_build_read_bytes(paths.host_certificate, "post-build host certificate")
    certificate = _post_build_json(certificate_raw, "post-build host certificate")
    profile = certificate_proof["storage_profile"]
    stable_identity = _post_build_certificate_stable_identity(certificate)
    if (stable_identity != certificate_proof["stable_identity"]
            or certificate.get("restart_verified") is not True):
        _fail("post-build host certificate stable identity differs from host proof")
    # The historical namespace belongs to the outgoing image. The existing
    # storage gates attest the incoming certificate; bind it to this runtime.
    runtime_image = os.environ.get("FULLMAG_RUNTIME_IMAGE_ID")
    if (not isinstance(runtime_image, str) or POST_BUILD_IMAGE.fullmatch(runtime_image) is None
            or runtime_image != certificate.get("image_id")):
        _fail("post-build runtime image differs from the retained host certificate")
    marker_name = (
        ".fullmag-windows-folder-owner.json"
        if profile == WINDOWS_STORAGE_PROFILE else ".fullmag-linux-native-owner.json"
    )
    marker_raw = _post_build_read_bytes(
        paths.state / marker_name, "post-build host owner marker"
    )
    marker = _post_build_json(marker_raw, "post-build host owner marker")
    if marker != certificate:
        _fail("post-build host certificate and owner marker differ")
    profile_env = os.environ.get("FULLMAG_SESSION_STORAGE_PROFILE")
    if profile_env is not None and profile_env != profile:
        _fail("post-build host storage profile differs from host proof")

    accepted = metadata["accepted_run"]
    request = os.environ.get(ACCEPTED_REATTACH_REQUEST_ENV)
    request_sha = os.environ.get(ACCEPTED_REATTACH_DIGEST_ENV)
    if accepted == {}:
        if accepted_preflight is not None or request is not None or request_sha is not None:
            _fail("post-build accepted-run environment was added after host proof")
    else:
        if not isinstance(accepted_preflight, Mapping):
            _fail("post-build accepted-run preflight is unavailable")
        if (request_sha != accepted["request_sha256"]
                or accepted_preflight.get("request_sha256") != accepted["request_sha256"]
                or accepted_preflight.get("proof_sha256") != accepted["proof_sha256"]):
            _fail("post-build accepted-run pins differ from host proof")


def _post_build_consumed_path(paths: RuntimePaths, token: str) -> Path:
    return runtime_services_root(paths) / POST_BUILD_CONSUMED_RELATIVE / token / "consumed.json"


def _post_build_read_consumed(
    paths: RuntimePaths, binding: Mapping[str, Any]
) -> bool:
    token = binding["attempt"]
    raw = _post_build_read_optional_bytes(
        _post_build_consumed_path(paths, token), "post-build consumed record"
    )
    if raw is None:
        return False
    record = _post_build_json(raw, "post-build consumed record", canonical=True)
    required = {
        "schema", "state", "attempt", "binding_sha256", "continuation_sha256",
        "previous_config_sha256", "new_config_sha256",
    }
    if (set(record) != required or record.get("schema") != POST_BUILD_CONSUMED_SCHEMA
            or record.get("state") != "consumed" or record.get("attempt") != token):
        _fail("post-build consumed record schema or fields differ")
    binding_path = _post_build_control_path(
        os.environ[POST_BUILD_START_ENV], "post-build continuation path"
    )
    binding_raw = _post_build_read_bytes(binding_path, "post-build continuation binding")
    _post_build_digest(record.get("new_config_sha256"), "post-build consumed configuration")
    if (record.get("binding_sha256") != _sha256_bytes(binding_raw)
            or record.get("continuation_sha256") != binding["continuation_sha256"]
            or record.get("previous_config_sha256") != binding["previous_config_sha256"]
            or not HEX64.fullmatch(record.get("new_config_sha256", ""))):
        _fail("post-build consumed record pin differs")
    return True


def _post_build_publish_consumed(
    paths: RuntimePaths, binding: Mapping[str, Any], new_config_sha256: str
) -> None:
    binding_path = _post_build_control_path(
        os.environ[POST_BUILD_START_ENV], "post-build continuation path"
    )
    binding_raw = _post_build_read_bytes(binding_path, "post-build continuation binding")
    record = {
        "schema": POST_BUILD_CONSUMED_SCHEMA,
        "state": "consumed",
        "attempt": binding["attempt"],
        "binding_sha256": _sha256_bytes(binding_raw),
        "continuation_sha256": binding["continuation_sha256"],
        "previous_config_sha256": binding["previous_config_sha256"],
        "new_config_sha256": _post_build_digest(new_config_sha256, "post-build new config"),
    }
    _publish_accepted_reattach_record(
        _post_build_consumed_path(paths, binding["attempt"]), record,
        "post-build consumed record",
    )
    current_raw = _post_build_read_bytes(paths.config, "runtime configuration after consumed publication")
    if _sha256_bytes(current_raw) != new_config_sha256:
        _fail("post-build consumed record does not match the published configuration")
    if not _post_build_read_consumed(paths, binding):
        _fail("post-build consumed record publication could not be verified")


def _post_build_binding_state(
    paths: RuntimePaths,
    current_raw: bytes,
    *,
    accepted_preflight: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    configured_path = os.environ.get(POST_BUILD_START_ENV)
    configured_sha = os.environ.get(POST_BUILD_START_SHA_ENV)
    if configured_path is None and configured_sha is None:
        return None
    if not configured_path or not configured_sha:
        _fail("post-build continuation requires both private controls")
    _post_build_digest(configured_sha, "post-build continuation binding digest")
    binding_path = _post_build_control_path(configured_path, "post-build continuation path")
    binding_raw, binding = _post_build_read_json(
        binding_path, "post-build continuation binding", canonical=True
    )
    if _sha256_bytes(binding_raw) != configured_sha:
        _fail("post-build continuation binding digest differs")
    binding = _post_build_validate_binding_document(binding)
    expected_path = BUILD_CONTROL_ROOT / binding["continuation_relative"]
    if binding_path != expected_path:
        _fail("post-build continuation binding path differs")
    receipt_path = _post_build_control_path(
        str(BUILD_CONTROL_ROOT / binding["receipt_relative"]),
        "post-build operation receipt",
    )
    _, receipt = _post_build_read_json(
        receipt_path, "post-build development operation receipt", canonical=True
    )
    metadata = binding["continuation"]
    if (receipt.get("schema") != "fullmag.docker-build-operation.v1"
            or receipt.get("phase") != "development"
            or receipt.get("attempt") != binding["attempt"]
            or receipt.get("compose_project") != metadata["compose_project"]):
        _fail("post-build operation receipt identity differs")
    inputs = receipt.get("inputs")
    if (not isinstance(inputs, dict) or inputs.get("source_root") != metadata["source_root"]
            or inputs.get("source_project_id") != metadata["source_identity"]["project_id"]
            or inputs.get("source_worktree_id") != metadata["source_identity"]["worktree_id"]
            or inputs.get("source_checkout_kind") != metadata["source_identity"]["checkout_kind"]
            or inputs.get("image_id") != os.environ.get("FULLMAG_RUNTIME_IMAGE_ID")
            or receipt.get("post_build_generation") != metadata
            or inputs.get("post_build_generation") != metadata):
        _fail("post-build operation receipt source or continuation differs")
    reference = receipt.get("post_build_start")
    reference_fields = {"schema", "state", "path", "sha256", "continuation_sha256"}
    if (not isinstance(reference, dict) or set(reference) != reference_fields
            or reference.get("schema") != POST_BUILD_START_SCHEMA
            or reference.get("path") != configured_path
            or reference.get("sha256") != configured_sha
            or reference.get("continuation_sha256") != binding["continuation_sha256"]):
        _fail("post-build operation receipt binding reference differs")
    if reference.get("state") not in {"pending", "consumed"}:
        _fail("post-build operation receipt binding state is unsupported")
    if reference["state"] == "consumed" and binding["state"] != "pending":
        _fail("post-build consumed reference has an unexpected binding state")
    if reference["state"] == "pending" and binding["state"] == "consumed":
        _fail("post-build pending reference has a consumed binding")

    if _post_build_read_consumed(paths, binding):
        return {"state": "consumed", "binding": binding}
    if reference["state"] == "consumed":
        _fail("post-build operation marked consumed without an immutable consumed record")

    active_path = _post_build_control_path(
        str(BUILD_CONTROL_ROOT / binding["active_relative"]), "post-build active marker path"
    )
    active_raw = _post_build_read_optional_bytes(active_path, "post-build active marker", 128)
    if active_raw != (binding["active_token"] + "\n").encode("ascii"):
        _fail("post-build active marker differs from the bound attempt")
    terminal_path = receipt_path.with_name("terminal.json")
    if _post_build_read_optional_bytes(terminal_path, "post-build operation terminal") is not None:
        _fail("post-build operation already has a terminal record")
    if receipt.get("state") not in POST_BUILD_LIVE_OPERATION_STATES:
        _fail("post-build operation is not live")
    _post_build_validate_operation_lock()
    return {
        "state": "pending",
        "binding": binding,
        "previous_config_sha256": binding["previous_config_sha256"],
    }

def ensure_configuration(
    paths: RuntimePaths | None = None,
    *,
    accepted_preflight: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    paths = paths or canonical_paths()
    host_mode = os.environ.get("FULLMAG_DOCKER_HOST_EXECUTION", "1")
    if host_mode != "1":
        _fail("Docker runtime requires native host execution; legacy local profile is disabled")
    device_access = os.environ.get("FULLMAG_DOCKER_DEVICE_ACCESS", "gpu")
    if device_access not in DEVICE_ACCESS_CHOICES:
        _fail("FULLMAG_DOCKER_DEVICE_ACCESS must be cpu or gpu")
    previous_sha256 = os.environ.get("FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256")
    if previous_sha256 is not None and (
        host_mode != "1" or not HEX64.fullmatch(previous_sha256)
    ):
        _fail("FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256 requires native host mode and a lowercase SHA-256")
    capacity_authority: dict[str, Any] = {}
    expected = initialize_host_configuration(paths, device_access, capacity_authority)
    try:
        current_raw = _bounded_regular(paths.config, "runtime service configuration")
        current = _post_build_json(current_raw, "runtime service configuration")
    except FileNotFoundError:
        if previous_sha256 is not None or (
            os.environ.get(POST_BUILD_START_ENV) is not None
            or os.environ.get(POST_BUILD_START_SHA_ENV) is not None
        ):
            _fail("authorized recreate runtime configuration is missing")
        _atomic_json(paths.config, expected, "runtime service configuration")
        return expected

    post_build = _post_build_binding_state(
        paths, current_raw, accepted_preflight=accepted_preflight
    )
    if post_build is not None and post_build["state"] == "consumed":
        # A consumed record is a permanent fence for the old host pin, but it
        # does not pin the current generation forever.  Continue through the
        # ordinary authenticated-drain path if the expected generation changed.
        previous_sha256 = None
    elif post_build is not None:
        bound_previous = post_build["previous_config_sha256"]
        if previous_sha256 != bound_previous:
            _fail("post-build continuation does not match the previous config pin")
        expected_raw = (
            json.dumps(expected, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode("utf-8")
        expected_sha256 = _sha256_bytes(expected_raw)
        current_sha256 = _sha256_bytes(current_raw)
        if current_sha256 not in {bound_previous, expected_sha256}:
            _fail("post-build runtime configuration differs from both pinned generations")
        with _post_build_failed_owner_lock(paths) as assert_owner_lock:
            # Re-read the immutable acknowledgement and all mutable evidence
            # under OWNER.lock.  The initial scan may have raced publication.
            if _post_build_read_consumed(paths, post_build["binding"]):
                previous_sha256 = None
            else:
                _post_build_validate_current_evidence(
                    paths, post_build["binding"]["continuation"], accepted_preflight
                )
                assert_owner_lock()
                current_raw = _post_build_read_bytes(
                    paths.config, "runtime service configuration under owner lock"
                )
                current = _post_build_json(
                    current_raw, "runtime service configuration under owner lock"
                )
                current_sha256 = _sha256_bytes(current_raw)
                if current_sha256 not in {bound_previous, expected_sha256}:
                    _fail("post-build runtime configuration changed under owner lock")
                # Recheck the exact operation while holding OWNER.lock, after
                # all evidence reads and immediately before publication.
                refreshed = _post_build_binding_state(
                    paths, current_raw, accepted_preflight=accepted_preflight
                )
                if refreshed != post_build:
                    _fail("post-build operation changed before configuration publication")
                if current_sha256 == expected_sha256:
                    assert_owner_lock()
                    _post_build_publish_consumed(
                        paths, post_build["binding"], expected_sha256
                    )
                    return expected
                _rotate_configuration_generation(
                    paths, current, expected, bound_previous, capacity_authority=capacity_authority,
                )
                published_raw = _post_build_read_bytes(
                    paths.config, "runtime configuration after post-build rotation"
                )
                if _sha256_bytes(published_raw) != expected_sha256:
                    _fail("post-build runtime configuration publication differs")
                assert_owner_lock()
                _post_build_publish_consumed(
                    paths, post_build["binding"], expected_sha256
                )
                return expected

    if current != expected:
        if previous_sha256 is None:
            # A normal Docker restart has no host-side config digest.  Derive
            # it from the exact current bytes only after the previous native
            # owner has published an authenticated, successful drain.
            with _authenticated_terminal_drain(paths) as assert_owner_lock:
                previous_sha256 = hashlib.sha256(
                    _bounded_regular(paths.config, "runtime configuration before automatic rotation")
                ).hexdigest()
                assert_owner_lock()
                _rotate_configuration_generation(paths, current, expected, previous_sha256,
                                                 capacity_authority=capacity_authority)
        else:
            # A direct recreate pin is one-shot.  A stale pin can authorize a
            # second generation only after the normal authenticated drain.
            current_raw = _bounded_regular(
                paths.config, "runtime configuration before stale-pin check"
            )
            if hashlib.sha256(current_raw).hexdigest() != previous_sha256:
                with _authenticated_terminal_drain(paths) as assert_owner_lock:
                    previous_sha256 = hashlib.sha256(
                        _bounded_regular(
                            paths.config,
                            "runtime configuration before stale-pin rotation",
                        )
                    ).hexdigest()
                    assert_owner_lock()
                    _rotate_configuration_generation(paths, current, expected, previous_sha256,
                                                 capacity_authority=capacity_authority)
            else:
                _rotate_configuration_generation(paths, current, expected, previous_sha256,
                                                 capacity_authority=capacity_authority)
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
    raw_output: list[bytes] | None = None,
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
        text=raw_output is None,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise RuntimeServiceUnknown(
            "runtime CLI timed out; outcome is unknown and no retry is allowed"
        ) from error
    if isinstance(stdout, bytes):
        raw_stdout = stdout
        try:
            stdout = stdout.decode("utf-8", "strict")
        except UnicodeDecodeError as error:
            _fail(f"runtime CLI returned invalid UTF-8: {error}")
        stderr = stderr.decode("utf-8", "replace")
    else:
        raw_stdout = stdout.encode("utf-8")
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
    if raw_output is not None:
        raw_output.append(raw_stdout)
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
    log_dir = runtime_services_root(paths) / owner_token
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
    current_owner_path = runtime_services_root(paths) / "OWNER.json"
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
        source_path = _store_relative_path(paths, source_relative)
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
        source_path = _store_relative_path(paths, source_relative)
        _assert_no_links(source_path.parent, "native absent source parent")
        if os.path.lexists(source_path):
            _fail(f"native recovery absent source exists: {source_relative}")
    return dict(result)


def _canonical_container_recovery_json(value: Any) -> bytes:
    """Mirror Rust's sorted, compact canonical JSON used for attestations."""

    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as error:
        _fail(f"container recovery document is not canonical JSON: {error}")


def _read_stable_container_recovery_file(
    path: Path, name: str, maximum: int
) -> bytes:
    """Read a named-volume document twice before using its digest."""

    first = _bounded_regular(path, name, maximum)
    second = _bounded_regular(path, name, maximum)
    if first != second:
        _fail(f"{name} changed during bounded admission")
    return first


def _read_stable_container_recovery_json(
    path: Path, name: str, maximum: int
) -> tuple[dict[str, Any], bytes]:
    raw = _read_stable_container_recovery_file(path, name, maximum)
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"{name} is not valid JSON: {error}")
    if not isinstance(value, dict):
        _fail(f"{name} must contain a JSON object")
    return value, raw


def _container_recovery_hex(value: Any, name: str) -> str:
    if not isinstance(value, str) or HEX64.fullmatch(value) is None:
        _fail(f"{name} must be a lowercase SHA-256")
    return value


def _container_recovery_text(value: Any, name: str, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        _fail(f"{name} must be non-empty text")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        _fail(f"{name} contains a control character")
    if len(value.encode("utf-8")) > maximum:
        _fail(f"{name} exceeds its bounded text size")
    return value


def _container_recovery_control_path(value: Any, name: str) -> Path:
    """Accept only an opaque guest path below the read-only control volume."""

    if not isinstance(value, str) or not value.startswith("/") or "\\" in value:
        _fail(f"{name} must be an absolute POSIX control-volume path")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        _fail(f"{name} contains a control character")
    path = _absolute(Path(value), name)
    try:
        relative = path.relative_to(CONTAINER_RECOVERY_CONTROL_ROOT)
    except ValueError:
        _fail(f"{name} is outside the Docker named control volume")
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        _fail(f"{name} contains an unsafe control-volume component")
    _assert_no_links(path.parent, f"{name} parent")
    return path


def _container_recovery_owner_digest(paths: RuntimePaths) -> tuple[dict[str, Any], bytes, str]:
    owner_path = runtime_services_root(paths) / "OWNER.json"
    owner, raw = _read_stable_container_recovery_json(
        owner_path, "container recovery runtime owner", MAX_CONTAINER_RECOVERY_REQUEST_BYTES
    )
    return owner, raw, _sha256_bytes(raw)


def _container_recovery_expected_outcome(request: Mapping[str, Any]) -> str:
    if request.get("schema_version") == CONTAINER_RECOVERY_HELD_MANUAL_REQUEST_SCHEMA:
        if "retained_cancelled_runs" in request:
            _fail("v4 container recovery cannot carry cancelled-run pins")
        terminal_pins = request.get("retained_terminal_runs")
        held_pins = request.get("retained_held_manual_runs")
        if not isinstance(terminal_pins, list) or not 0 <= len(terminal_pins) <= 128:
            _fail("v4 container recovery requires 0..128 retained terminal run pins")
        if not isinstance(held_pins, list) or not 1 <= len(held_pins) <= 128:
            _fail("v4 container recovery requires 1..128 retained held-manual run pins")
        if len(terminal_pins) + len(held_pins) > 128:
            _fail("v4 container recovery retained run pins exceed the combined limit")
        seen: set[str] = set()
        for pin in terminal_pins:
            if not isinstance(pin, dict) or set(pin) != {
                "run_id", "run_intent_sha256", "run_catalog_sha256", "artifact_catalog_sha256"
            }:
                _fail("invalid v4 retained terminal run pin")
            run_id = _recovery_store_id(pin.get("run_id"), "retained terminal run id")
            if run_id in seen:
                _fail("duplicate v4 retained run pin")
            seen.add(run_id)
            for key in ("run_intent_sha256", "run_catalog_sha256"):
                _container_recovery_hex(pin.get(key), key)
            if pin["artifact_catalog_sha256"] is not None:
                _container_recovery_hex(pin["artifact_catalog_sha256"], "artifact catalog digest")
        for pin in held_pins:
            if not isinstance(pin, dict) or set(pin) != {
                "run_id", "run_intent_sha256", "run_catalog_sha256", "start_release"
            } or pin.get("start_release") != "absent":
                _fail("invalid retained held-manual run pin")
            run_id = _recovery_store_id(pin.get("run_id"), "retained held-manual run id")
            if run_id in seen:
                _fail("duplicate v4 retained run pin")
            seen.add(run_id)
            _container_recovery_hex(pin.get("run_intent_sha256"), "held-manual run intent digest")
            _container_recovery_hex(pin.get("run_catalog_sha256"), "held-manual run catalog digest")
        return "retained_manual_held_runs_recovered"
    if "retained_held_manual_runs" in request:
        _fail("held-manual run pins require container recovery v4")
    if request.get("schema_version") == CONTAINER_RECOVERY_TERMINAL_REQUEST_SCHEMA:
        if request.get("retained_cancelled_runs") is not None:
            _fail("v3 container recovery cannot carry cancelled-only pins")
        pins = request.get("retained_terminal_runs")
        if not isinstance(pins, list) or not 1 <= len(pins) <= 128:
            _fail("v3 container recovery requires 1..128 retained terminal run pins")
        seen = set()
        for pin in pins:
            if not isinstance(pin, dict) or set(pin) != {
                "run_id", "run_intent_sha256", "run_catalog_sha256", "artifact_catalog_sha256"}:
                _fail("invalid retained terminal run pin")
            run_id = _recovery_store_id(pin.get("run_id"), "retained terminal run id")
            if run_id in seen:
                _fail("duplicate retained terminal run pin")
            seen.add(run_id)
            for key in ("run_intent_sha256", "run_catalog_sha256"):
                _container_recovery_hex(pin.get(key), key)
            if pin["artifact_catalog_sha256"] is not None:
                _container_recovery_hex(pin["artifact_catalog_sha256"], "artifact catalog digest")
        return "retained_terminal_runs_recovered"
    if request.get("retained_terminal_runs") is not None:
        _fail("terminal run pins require container recovery v3")
    if request.get("schema_version") == CONTAINER_RECOVERY_REQUEST_SCHEMA:
        if request.get("retained_cancelled_runs") is not None:
            _fail("v1 container recovery cannot retain cancelled runs")
        return "empty_namespace_recovered"
    if request.get("schema_version") != "runtime_service_container_recovery_request.v2":
        _fail("container recovery request schema is unsupported")
    pins = request.get("retained_cancelled_runs")
    if not isinstance(pins, list) or not 1 <= len(pins) <= 128:
        _fail("v2 container recovery requires 1..128 retained run pins")
    seen = set()
    for pin in pins:
        if not isinstance(pin, dict) or set(pin) != {
            "run_id", "run_intent_sha256", "run_catalog_sha256"
        }:
            _fail("invalid retained cancelled run pin")
        run_id = _recovery_store_id(pin.get("run_id"), "retained run id")
        if run_id in seen:
            _fail("duplicate retained cancelled run pin")
        seen.add(run_id)
        _container_recovery_hex(pin.get("run_intent_sha256"), "retained run intent digest")
        _container_recovery_hex(pin.get("run_catalog_sha256"), "retained run catalog digest")
    return "retained_cancelled_runs_recovered"


def _container_recovery_request_sources(
    request: Mapping[str, Any], name: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    expected_owner = request.get("expected_owner")
    if not isinstance(expected_owner, dict):
        _fail(f"{name} has no typed expected owner")
    _container_recovery_expected_outcome(request)
    request_id = request.get("request_id")
    if not isinstance(request_id, str) or UUID_RE.fullmatch(request_id) is None:
        _fail(f"{name} has an invalid request id")
    state = expected_owner.get("state")
    if state not in {"ready", "unknown"}:
        _fail(f"{name} expected owner must be Ready or Unknown")
    if expected_owner.get("target_id") != TARGET_ID:
        _fail(f"{name} expected owner targets another runtime service")
    for field in (
        "config_sha256",
        "owner_sha256",
        "launch_sha256",
        "store_root_sha256",
        "ledger_root_sha256",
        "ledger_snapshot_sha256",
        "docker_engine_id_sha256",
        "docker_manifest_sha256",
        "prior_ready_owner_proof_sha256",
        "device_release_mapping_sha256",
    ):
        _container_recovery_hex(request.get(field), f"{name} {field}")
    application = request.get("application")
    if not isinstance(application, dict):
        _fail(f"{name} has no application pin")
    if application.get("mode") not in {"external_only", "persisted"}:
        _fail(f"{name} has an invalid application pin")
    _container_recovery_hex(application.get("raw_sha256"), f"{name} application raw SHA-256")
    _container_recovery_text(
        request.get("device_release_resource_id"),
        f"{name} device resource id",
        255,
    )
    containers = request.get("containers")
    if not isinstance(containers, list) or len(containers) != 2:
        _fail(f"{name} must pin exactly two containers")
    by_service: dict[str, dict[str, Any]] = {}
    for container in containers:
        if not isinstance(container, dict):
            _fail(f"{name} has an invalid container pin")
        service = container.get("service")
        if service in by_service or service not in {"backend", "frontend"}:
            _fail(f"{name} must pin one backend and one frontend")
        for field in ("container_id", "config_sha256", "device_requests_sha256"):
            _container_recovery_hex(container.get(field), f"{name} container {field}")
        image = container.get("image_id")
        if (
            not isinstance(image, str)
            or not image.startswith("sha256:")
            or HEX64.fullmatch(image[7:]) is None
        ):
            _fail(f"{name} container image identity is invalid")
        _container_recovery_text(container.get("compose_project"), f"{name} Compose project", 255)
        if container.get("private_pid_namespace") is not True or container.get("host_pid") is not False:
            _fail(f"{name} container PID namespace is unsafe")
        by_service[service] = container
    return by_service, expected_owner


def _container_recovery_mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(f"{name} must contain an object")
    return value


def _validate_container_recovery_attestation_document(
    request: Mapping[str, Any],
    request_sha256: str,
    attestation: Mapping[str, Any],
    attestation_sha256: str,
) -> None:
    if attestation.get("schema_version") == CONTAINER_RECOVERY_ABSENCE_ATTESTATION_SCHEMA:
        if (
            (request.get("schema_version") != "runtime_service_container_recovery_request.v2"
             or not isinstance(request.get("retained_cancelled_runs"), list))
            and (request.get("schema_version") != CONTAINER_RECOVERY_TERMINAL_REQUEST_SCHEMA
                 or not isinstance(request.get("retained_terminal_runs"), list))
            and (request.get("schema_version") != CONTAINER_RECOVERY_HELD_MANUAL_REQUEST_SCHEMA
                 or not isinstance(request.get("retained_terminal_runs"), list)
                 or not isinstance(request.get("retained_held_manual_runs"), list))
        ):
            _fail("container namespace absence proof requires a retained-run v2, v3 or v4 request")
        if set(attestation) != {
            "schema_version",
            "request_sha256",
            "docker_engine_id_sha256",
            "containers",
            "device_release",
            "manifest_sha256",
            "result",
        }:
            _fail("container namespace absence attestation has unexpected fields")
        if attestation.get("request_sha256") != request_sha256:
            _fail("container namespace absence attestation targets another request")
        if attestation.get("docker_engine_id_sha256") != request.get("docker_engine_id_sha256"):
            _fail("container namespace absence attestation engine differs from request")
        if attestation.get("manifest_sha256") != request.get("docker_manifest_sha256"):
            _fail("container namespace absence manifest differs from request")
        if attestation.get("result") != "authoritative_namespace_absence":
            _fail("container namespace absence proof is not authoritative")
        for field in ("request_sha256", "docker_engine_id_sha256", "manifest_sha256"):
            _container_recovery_hex(attestation.get(field), f"container namespace absence {field}")
        requested, _ = _container_recovery_request_sources(
            request, "container recovery request"
        )
        observations = attestation.get("containers")
        if not isinstance(observations, list) or len(observations) != len(requested):
            _fail("container namespace absence observation count differs from request")
        seen: set[str] = set()
        for raw in observations:
            observed = _container_recovery_mapping(raw, "container namespace absence observation")
            if set(observed) != {
                "container_id", "image_id", "config_sha256", "service", "absence"
            }:
                _fail("container namespace absence observation has unexpected fields")
            container_id = _container_recovery_hex(
                observed.get("container_id"), "absence container id"
            )
            if container_id in seen:
                _fail("container namespace absence attestation repeats a container")
            seen.add(container_id)
            pin = next(
                (item for item in requested.values() if item.get("container_id") == container_id),
                None,
            )
            if pin is None or any(
                observed.get(field) != pin.get(field)
                for field in ("image_id", "config_sha256", "service")
            ):
                _fail("container namespace absence identity differs from request")
            absence = _container_recovery_mapping(observed.get("absence"), "container absence evidence")
            if set(absence) != {"inspect", "ps_all"}:
                _fail("container namespace absence evidence has unexpected fields")
            inspect = _container_recovery_mapping(absence.get("inspect"), "container inspect absence")
            if set(inspect) != {"outcome", "matched_container_id", "output_sha256"}:
                _fail("container inspect absence has unexpected fields")
            if (
                inspect.get("outcome") != "no_such_object"
                or inspect.get("matched_container_id") != container_id
            ):
                _fail("container inspect absence does not target the exact pinned ID")
            _container_recovery_hex(
                inspect.get("output_sha256"), "container inspect absence output SHA-256"
            )
            ps_all = _container_recovery_mapping(absence.get("ps_all"), "container ps-all absence")
            if set(ps_all) != {"outcome", "output_sha256"}:
                _fail("container ps-all absence has unexpected fields")
            if ps_all.get("outcome") != "empty":
                _fail("Docker ps -a still lists a container in the namespace")
            _container_recovery_hex(
                ps_all.get("output_sha256"), "container ps-all output SHA-256"
            )
        if len(seen) != len(requested):
            _fail("container namespace absence attestation omitted a pinned container")
        release = _container_recovery_mapping(
            attestation.get("device_release"), "container absence device release"
        )
        release_fields = {"resource_id", "mapping_sha256", "mapping_detached"}
        if request.get("device_release_gpu_uuid") is not None:
            release_fields.add("gpu_uuid")
        if set(release) != release_fields:
            _fail("container absence device release has unexpected fields")
        if (
            release.get("resource_id") != request.get("device_release_resource_id")
            or release.get("gpu_uuid") != request.get("device_release_gpu_uuid")
            or release.get("mapping_sha256") != request.get("device_release_mapping_sha256")
            or release.get("mapping_detached") is not True
        ):
            _fail("container absence device release differs from request")
        _container_recovery_hex(attestation_sha256, "container absence attestation SHA-256")
        return

    if attestation.get("schema_version") != CONTAINER_RECOVERY_ATTESTATION_SCHEMA:
        _fail("container recovery teardown attestation schema is unsupported")
    if attestation.get("request_sha256") != request_sha256:
        _fail("container recovery teardown attestation targets another request")
    if attestation.get("docker_engine_id_sha256") != request.get("docker_engine_id_sha256"):
        _fail("container recovery teardown attestation engine differs from request")
    if attestation.get("manifest_sha256") != request.get("docker_manifest_sha256"):
        _fail("container recovery teardown attestation manifest differs from request")
    if attestation.get("result") != "authoritative_teardown":
        _fail("container recovery teardown is not authoritative")
    containers = attestation.get("containers")
    requested, _ = _container_recovery_request_sources(request, "container recovery request")
    if not isinstance(containers, list) or len(containers) != len(requested):
        _fail("container recovery teardown container count differs from request")
    seen: set[str] = set()
    for observed in containers:
        if not isinstance(observed, dict):
            _fail("container recovery teardown has an invalid observation")
        container_id = observed.get("container_id")
        if not isinstance(container_id, str) or container_id in seen:
            _fail("container recovery teardown repeats a container")
        seen.add(container_id)
        requested_container = next(
            (item for item in requested.values() if item.get("container_id") == container_id), None
        )
        if requested_container is None:
            _fail("container recovery teardown contains an unknown container")
        if any(
            observed.get(field) != requested_container.get(field)
            for field in ("image_id", "config_sha256")
        ):
            _fail("container recovery teardown container identity differs from request")
        before = observed.get("before")
        after = observed.get("after")
        if not isinstance(before, dict) or not isinstance(after, dict):
            _fail("container recovery teardown lacks before/after observations")
        if (
            before.get("private_pid_namespace") is not True
            or before.get("host_pid") is not False
            or after.get("state") != "exited"
            or after.get("pid") != 0
            or not isinstance(after.get("finished_at"), str)
            or not after["finished_at"].strip()
            or after.get("descendant_count") != 0
            or after.get("private_pid_namespace") is not True
            or after.get("host_pid") is not False
            or before.get("device_requests_sha256") != requested_container.get("device_requests_sha256")
            or after.get("device_requests_sha256") != requested_container.get("device_requests_sha256")
        ):
            _fail("container recovery teardown has unsafe after-state evidence")
    if len(seen) != len(requested):
        _fail("container recovery teardown omitted a requested container")
    release = attestation.get("device_release")
    if not isinstance(release, dict):
        _fail("container recovery teardown has no device release proof")
    if (
        release.get("resource_id") != request.get("device_release_resource_id")
        or release.get("gpu_uuid") != request.get("device_release_gpu_uuid")
        or release.get("mapping_sha256") != request.get("device_release_mapping_sha256")
        or release.get("mapping_detached") is not True
    ):
        _fail("container recovery teardown device release differs from request")
    _container_recovery_hex(attestation_sha256, "container recovery attestation SHA-256")


def _read_container_recovery_authorization(
    paths: RuntimePaths, authorization_path: Path | None = None
) -> dict[str, Any]:
    configured = os.environ.get(CONTAINER_RECOVERY_AUTHORIZATION_ENV) or None
    if authorization_path is None:
        if not configured:
            _fail("container recovery authorization is not present")
        authorization_path = Path(configured)
    elif configured is not None and Path(configured) != Path(authorization_path):
        _fail("container recovery authorization path differs from the process environment")
    authorization_path = _container_recovery_control_path(
        str(authorization_path), "container recovery authorization"
    )
    expected_auth_sha = os.environ.get(CONTAINER_RECOVERY_AUTHORIZATION_SHA256_ENV) or None
    if expected_auth_sha is None:
        _fail("container recovery authorization SHA-256 is not present")
    expected_auth_sha = _container_recovery_hex(
        expected_auth_sha, "container recovery authorization SHA-256"
    )
    auth_raw = _read_stable_container_recovery_file(
        authorization_path,
        "container recovery authorization",
        MAX_CONTAINER_RECOVERY_AUTHORIZATION_BYTES,
    )
    auth_sha = _sha256_bytes(auth_raw)
    if auth_sha != expected_auth_sha:
        _fail("container recovery authorization changed after host admission")
    try:
        authorization = json.loads(
            auth_raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"container recovery authorization is not valid JSON: {error}")
    if not isinstance(authorization, dict):
        _fail("container recovery authorization must contain an object")
    if authorization.get("schema_version") not in CONTAINER_RECOVERY_AUTHORIZATION_SCHEMAS:
        _fail("container recovery authorization schema is unsupported")
    request_id = authorization.get("request_id")
    if not isinstance(request_id, str) or UUID_RE.fullmatch(request_id) is None:
        _fail("container recovery authorization has an invalid request id")
    for field in (
        "config_sha256",
        "owner_sha256",
        "launch_sha256",
        "operator_authorization_sha256",
        "attestation_sha256",
        "manifest_sha256",
        "prior_stop_journal_sha256",
        "native_request_sha256",
    ):
        _container_recovery_hex(authorization.get(field), f"container recovery authorization {field}")
    for field in ("source_root", "compose_project", "backend_container_id", "frontend_container_id", "old_image_id"):
        _container_recovery_text(authorization.get(field), f"container recovery authorization {field}")
    request_path = _container_recovery_control_path(
        authorization.get("native_request_path"), "container recovery native request"
    )
    attestation_path = _container_recovery_control_path(
        authorization.get("attestation_path"), "container recovery attestation"
    )
    manifest_path = _container_recovery_control_path(
        authorization.get("manifest_path"), "container recovery Docker manifest"
    )
    request, request_raw = _read_stable_container_recovery_json(
        request_path,
        "container recovery native request",
        MAX_CONTAINER_RECOVERY_REQUEST_BYTES,
    )
    request_sha256 = _sha256_bytes(request_raw)
    if request_sha256 != authorization.get("native_request_sha256"):
        _fail("container recovery native request changed after authorization")
    if request.get("request_id") != request_id:
        _fail("container recovery native request identity differs from authorization")
    containers, expected_owner = _container_recovery_request_sources(
        request, "container recovery native request"
    )
    for field in ("config_sha256", "owner_sha256", "launch_sha256"):
        if request.get(field) != authorization.get(field):
            _fail(f"container recovery request {field} differs from authorization")
    if request.get("prior_ready_owner_proof_sha256") != authorization.get("prior_stop_journal_sha256"):
        _fail("container recovery prior-stop proof differs from native request")
    attestation, attestation_raw = _read_stable_container_recovery_json(
        attestation_path,
        "container recovery teardown attestation",
        MAX_CONTAINER_RECOVERY_REQUEST_BYTES,
    )
    # The attestation SHA is canonical JSON, whereas its file is intentionally
    # allowed to use a different stable formatting.
    attestation_sha256 = _sha256_bytes(_canonical_container_recovery_json(attestation))
    if attestation_sha256 != authorization.get("attestation_sha256"):
        _fail("container recovery teardown attestation changed after authorization")
    _validate_container_recovery_attestation_document(
        request, request_sha256, attestation, attestation_sha256
    )
    manifest_raw = _read_stable_container_recovery_file(
        manifest_path,
        "container recovery Docker inspection manifest",
        MAX_CONTAINER_RECOVERY_REQUEST_BYTES,
    )
    if _sha256_bytes(manifest_raw) != authorization.get("manifest_sha256"):
        _fail("container recovery Docker inspection manifest changed after authorization")
    if request.get("docker_manifest_sha256") != authorization.get("manifest_sha256"):
        _fail("container recovery Docker manifest differs from native request")
    if attestation.get("manifest_sha256") != authorization.get("manifest_sha256"):
        _fail("container recovery Docker manifest differs from teardown attestation")
    for service, auth_field in (
        ("backend", "backend_container_id"),
        ("frontend", "frontend_container_id"),
    ):
        if containers[service].get("container_id") != authorization.get(auth_field):
            _fail(f"container recovery {service} container differs from authorization")
    return {
        "authorization": authorization,
        "authorization_raw": auth_raw,
        "authorization_sha256": auth_sha,
        "authorization_path": authorization_path,
        "request": request,
        "request_raw": request_raw,
        "request_sha256": request_sha256,
        "request_path": request_path,
        "attestation": attestation,
        "attestation_raw": attestation_raw,
        "attestation_sha256": attestation_sha256,
        "attestation_path": attestation_path,
        "manifest_path": manifest_path,
        "manifest_raw": manifest_raw,
        "expected_owner": expected_owner,
        "config_sha256": authorization["config_sha256"],
    }


def _container_recovery_expected_sources(owner: Mapping[str, Any]) -> set[str]:
    """Return the native archive's fixed inventory for one old owner."""

    owner_token = _recovery_store_id(owner.get("owner_token"), "container recovery owner token")
    compute_pool = _recovery_store_id(owner.get("compute_pool_id"), "container recovery compute pool id")
    preparation_pool = _recovery_store_id(
        owner.get("preparation_pool_id"), "container recovery preparation pool id"
    )
    return {
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
        "configuration.json",
    }


def _container_recovery_successor_sources(owner: Mapping[str, Any]) -> set[str]:
    """Return the bounded records that a clean successor may republish.

    The recovery archive describes the pre-recovery owner.  A later clean
    service start necessarily rotates the launch record and both scheduler
    resource generations.  Checkpoints may be published during that start,
    so they are included as optional successor records.  The caller still
    validates every record against the authenticated successor owner and the
    pinned runtime configuration.
    """

    compute_pool = _recovery_store_id(
        owner.get("compute_pool_id"), "container recovery successor compute pool id"
    )
    preparation_pool = _recovery_store_id(
        owner.get("preparation_pool_id"),
        "container recovery successor preparation pool id",
    )
    return {
        "runtime-services/LAUNCH.json",
        f"scheduler_pools/{compute_pool}.resources.json",
        f"scheduler_pools/{preparation_pool}.preparation-resources.json",
        f"scheduler_pools/{compute_pool}.json",
        f"scheduler_pools/{preparation_pool}.preparation.json",
    }


def _container_recovery_successor_config_profile(value: Any) -> dict[str, Any]:
    """Normalize the only configuration field rotated by an authenticated restart."""

    if not isinstance(value, dict):
        _fail("container recovery successor configuration must contain an object")
    profile = dict(value)
    host_execution = profile.get("host_execution")
    if host_execution is not None:
        if not isinstance(host_execution, dict):
            _fail("container recovery successor host execution is not an object")
        host_execution = dict(host_execution)
        host_execution.pop("runtime_generation_sha256", None)
        profile["host_execution"] = host_execution
    return profile


def _validate_container_recovery_successor_checkpoint(
    paths: RuntimePaths,
    relative: PurePosixPath,
    owner: Mapping[str, Any],
    name: str,
) -> None:
    """Validate one successor checkpoint while retaining terminal history.

    The empty-store requirement belongs to the initial native recovery before
    the first replacement owner starts.  This successor is a normal service
    owner that has already drained, so cancelled and completed run IDs remain
    valid durable history and must not be deleted or treated as new work.
    """

    path = _store_relative_path(paths, relative)
    if not os.path.lexists(path):
        return
    checkpoint, _ = _read_stable_container_recovery_json(
        path, name, MAX_CONTAINER_RECOVERY_REQUEST_BYTES
    )
    if (
        set(checkpoint)
        != {"schema_version", "pool_id", "sequence", "run_source", "run_ids", "next_run_id"}
        or checkpoint.get("schema_version") != "scheduler_pool_checkpoint.v1"
    ):
        _fail(f"{name} schema is unsupported")
    pool_id = relative.name
    if relative.name.endswith(".preparation.json"):
        pool_id = relative.name[: -len(".preparation.json")]
    elif relative.name.endswith(".json"):
        pool_id = relative.name[: -len(".json")]
    pool_id = _recovery_store_id(pool_id, f"{name} pool id")
    if checkpoint.get("pool_id") != pool_id:
        _fail(f"{name} pool identity differs from its path")
    expected_pool = (
        owner.get("preparation_pool_id")
        if relative.name.endswith(".preparation.json")
        else owner.get("compute_pool_id")
    )
    if checkpoint.get("pool_id") != expected_pool:
        _fail(f"{name} pool identity differs from the successor owner")
    sequence = checkpoint.get("sequence")
    if type(sequence) is not int or sequence <= 0:
        _fail(f"{name} has an invalid sequence")
    run_source = checkpoint.get("run_source")
    if run_source not in {"explicit", "store"}:
        _fail(f"{name} has an invalid run source")
    run_ids = checkpoint.get("run_ids")
    if not isinstance(run_ids, list) or len({value for value in run_ids if isinstance(value, str)}) != len(run_ids):
        _fail(f"{name} has invalid run ids")
    for run_id in run_ids:
        _recovery_store_id(run_id, f"{name} run id")
    next_run_id = checkpoint.get("next_run_id")
    if next_run_id is not None:
        _recovery_store_id(next_run_id, f"{name} next run id")
    if run_source == "explicit" and not run_ids:
        _fail(f"{name} explicit source has no run ids")


def _validate_container_recovery_successor(
    paths: RuntimePaths,
    context: Mapping[str, Any],
    archive_root: Path,
    successor_owner: Mapping[str, Any],
) -> set[str]:
    """Validate the dynamic evidence of one authenticated clean successor.

    This path is used only after ``_read_authenticated_terminal_drain`` has
    authenticated the ready owner, its durable pin, and the drained owner.
    It does not bless arbitrary live-store changes: only the five native
    records which the service republishes on a clean start are exempted from
    the historical archive byte comparison.
    """

    _validate_terminal_owner(
        successor_owner, state="ready", name="authenticated successor service owner"
    )
    if _owner_identity(successor_owner) == _owner_identity(context["expected_owner"]):
        _fail("container recovery successor owner is still the historical owner")
    successor_sources = _container_recovery_successor_sources(successor_owner)

    historical_config, _ = _read_stable_container_recovery_json(
        archive_root / "configuration.json",
        "container recovery archived configuration",
        MAX_CONTAINER_RECOVERY_REQUEST_BYTES,
    )
    current_config, _ = _read_stable_container_recovery_json(
        paths.config,
        "container recovery successor configuration",
        MAX_CONTAINER_RECOVERY_REQUEST_BYTES,
    )
    if _container_recovery_successor_config_profile(current_config) != _container_recovery_successor_config_profile(historical_config):
        _fail("container recovery successor configuration changed its operator profile")
    if current_config.get("target_id") != successor_owner.get("target_id"):
        _fail("container recovery successor configuration targets a different service")
    if current_config.get("compute_pool_id") != successor_owner.get("compute_pool_id") or current_config.get("preparation_pool_id") != successor_owner.get("preparation_pool_id"):
        _fail("container recovery successor configuration differs from owner pool identity")
    launch, _ = _read_stable_container_recovery_json(
        runtime_services_root(paths) / "LAUNCH.json",
        "container recovery successor launch record",
        MAX_CONTAINER_RECOVERY_REQUEST_BYTES,
    )
    historical_launch, _ = _read_stable_container_recovery_json(
        archive_root / "LAUNCH.json",
        "container recovery archived launch record",
        MAX_CONTAINER_RECOVERY_REQUEST_BYTES,
    )
    historical_launch_id = historical_launch.get("launch_id")
    if (
        set(historical_launch)
        != {"schema_version", "launch_id", "state", "pid"}
        or historical_launch.get("schema_version") != "runtime_service_launch.v1"
        or not isinstance(historical_launch_id, str)
        or UUID_RE.fullmatch(historical_launch_id) is None
    ):
        _fail("container recovery archived launch record is unsupported")
    launch_id = launch.get("launch_id")
    if (
        set(launch)
        != {"schema_version", "launch_id", "state", "pid"}
        or
        launch.get("schema_version") != "runtime_service_launch.v1"
        or not isinstance(launch_id, str)
        or UUID_RE.fullmatch(launch_id) is None
        or launch.get("state") != "ready"
        or launch.get("pid") != successor_owner.get("pid")
        or launch_id == historical_launch.get("launch_id")
    ):
        _fail("container recovery successor launch is not the authenticated ready owner")

    compute_pool = successor_owner.get("compute_pool_id")
    preparation_pool = successor_owner.get("preparation_pool_id")
    compute_generation = successor_owner.get("compute_pool_generation")
    preparation_generation = successor_owner.get("preparation_pool_generation")
    historical_owner = context["expected_owner"]
    historical_compute_generation = historical_owner.get("compute_pool_generation")
    historical_preparation_generation = historical_owner.get("preparation_pool_generation")
    if (
        type(compute_generation) is not int
        or compute_generation <= 0
        or type(preparation_generation) is not int
        or preparation_generation <= 0
        or type(historical_compute_generation) is not int
        or historical_compute_generation <= 0
        or type(historical_preparation_generation) is not int
        or historical_preparation_generation <= 0
        or compute_generation <= historical_compute_generation
        or preparation_generation <= historical_preparation_generation
    ):
        _fail("container recovery successor owner has invalid pool generations")
    pool_specs = (
        (
            f"scheduler_pools/{compute_pool}.resources.json",
            "scheduler_resource_pool.v1",
            compute_pool,
            compute_generation,
            "compute_resources",
        ),
        (
            f"scheduler_pools/{preparation_pool}.preparation-resources.json",
            "preparation_resource_pool.v1",
            preparation_pool,
            preparation_generation,
            "preparation_resources",
        ),
    )
    for source, schema, pool_id, generation, config_key in pool_specs:
        relative = PurePosixPath(source)
        record, _ = _read_stable_container_recovery_json(
            _store_relative_path(paths, relative),
            f"container recovery successor {source}",
            MAX_CONTAINER_RECOVERY_REQUEST_BYTES,
        )
        if (
            set(record) != {"schema_version", "pool_id", "generation", "resources"}
            or record.get("schema_version") != schema
            or record.get("pool_id") != pool_id
            or type(record.get("generation")) is not int
            or record.get("generation") != generation
        ):
            _fail(f"container recovery successor pool record differs from owner {source}")
        expected_resources = current_config.get(config_key)
        if not isinstance(expected_resources, list) or record.get("resources") != expected_resources:
            _fail(f"container recovery successor pool resources differ from configuration {source}")

    for source in (
        f"scheduler_pools/{compute_pool}.json",
        f"scheduler_pools/{preparation_pool}.preparation.json",
    ):
        _validate_container_recovery_successor_checkpoint(
            paths,
            PurePosixPath(source),
            successor_owner,
            f"container recovery successor {source}",
        )

    _observe_recovery_log_sources(paths, successor_owner)
    return successor_sources


def _validate_container_recovery_archive(
    paths: RuntimePaths,
    context: Mapping[str, Any],
    result: Mapping[str, Any],
    *,
    authenticated_drained_owner_sha256: str | None = None,
    authenticated_successor_owner: Mapping[str, Any] | None = None,
) -> None:
    request = context["request"]
    authorization = context["authorization"]
    request_sha256 = context["request_sha256"]
    archive_value = result.get("archived_evidence_path")
    expected_archive = (
        paths.store
        / "runtime-services"
        / "container-recovery"
        / request_sha256
        / "archive"
        / "manifest.json"
    )
    if not isinstance(archive_value, str) or _absolute(Path(archive_value), "container recovery archive") != expected_archive:
        _fail("container recovery archive is not request-scoped")
    manifest_path = expected_archive
    manifest_raw = _read_stable_container_recovery_file(
        manifest_path,
        "container recovery archive manifest",
        MAX_CONTAINER_RECOVERY_RECEIPT_BYTES,
    )
    if _sha256_bytes(manifest_raw) != result.get("archived_evidence_sha256"):
        _fail("container recovery archive manifest digest changed")
    try:
        manifest = json.loads(manifest_raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"container recovery archive manifest is not valid JSON: {error}")
    if not isinstance(manifest, dict):
        _fail("container recovery archive manifest must contain an object")
    for field, expected in (
        ("schema_version", CONTAINER_RECOVERY_ARCHIVE_SCHEMA),
        ("request_sha256", request_sha256),
        ("config_sha256", request["config_sha256"]),
        ("attestation_sha256", context["attestation_sha256"]),
        ("ledger_snapshot_sha256", request["ledger_snapshot_sha256"]),
        ("prior_ready_owner_proof_sha256", request["prior_ready_owner_proof_sha256"]),
        ("application", request["application"]),
    ):
        if manifest.get(field) != expected:
            _fail(f"container recovery archive manifest {field} differs from request")
    archived = result.get("archived_files")
    absent = result.get("archived_absent_sources", {})
    if not isinstance(archived, dict) or not isinstance(absent, dict):
        _fail("container recovery archive inventory is not an object")
    if manifest.get("files") != archived or manifest.get("absent_sources", {}) != absent:
        _fail("container recovery archive inventory differs from its manifest")
    if len(archived) + len(absent) < 12 or len(archived) + len(absent) > 32:
        _fail("container recovery archive inventory is outside its bounded size")
    mandatory = _container_recovery_expected_sources(context["expected_owner"])
    absent_names = set(absent)
    if any(value != "scheduler_checkpoint_not_published" for value in absent.values()):
        _fail("container recovery absent-source reason is invalid")
    checkpoint = {
        source
        for source in mandatory
        if source.startswith("scheduler_pools/")
        and not source.endswith((".resources.json", ".preparation-resources.json"))
    }
    if not absent_names.issubset(checkpoint) or set(archived).intersection(absent_names):
        _fail("container recovery archive has an invalid absent-source inventory")
    coverage = set(archived) | absent_names
    if not mandatory.issubset(coverage):
        _fail("container recovery archive is missing mandatory evidence")
    allowed = mandatory | _recovery_log_sources(context["expected_owner"])
    if not coverage.issubset(allowed):
        _fail("container recovery archive contains unexpected evidence")
    observed_logs = _observe_recovery_log_sources(paths, context["expected_owner"])
    if observed_logs - set(archived):
        _fail("container recovery archive omitted a live scheduler journal")
    if set(archived) - mandatory != observed_logs - mandatory:
        _fail("container recovery archive journal inventory changed")
    owner_source = archived.get("runtime-services/OWNER.json")
    if owner_source != authorization.get("owner_sha256"):
        _fail("container recovery archive does not pin the original owner")
    archive_root = manifest_path.parent
    _assert_no_links(archive_root, "container recovery archive")
    if not archive_root.is_dir() or archive_root.is_symlink():
        _fail("container recovery archive is not a directory")
    successor_sources = set()
    successor_optional_sources: set[str] = set()
    if authenticated_successor_owner is not None:
        if authenticated_drained_owner_sha256 is None:
            _fail("container recovery successor is missing its drained-owner proof")
        successor_sources = _validate_container_recovery_successor(
            paths, context, archive_root, authenticated_successor_owner
        )
        successor_optional_sources = _recovery_checkpoint_sources(
            authenticated_successor_owner
        )
    for source, expected_digest in archived.items():
        relative = _recovery_relative_path(source, "container recovery archived source")
        expected_digest = _container_recovery_hex(
            expected_digest, "container recovery archived source digest"
        )
        archive_file = archive_root / relative.name
        maximum = (
            MAX_CONTAINER_RECOVERY_LOG_BYTES
            if str(relative).endswith((".jsonl", ".log"))
            else MAX_CONTAINER_RECOVERY_REQUEST_BYTES
        )
        archive_bytes = _read_stable_container_recovery_file(
            archive_file, "container recovery archived evidence", maximum
        )
        if _sha256_bytes(archive_bytes) != expected_digest:
            _fail(f"container recovery archived evidence changed: {source}")
        if source == "configuration.json":
            if expected_digest != authorization.get("config_sha256"):
                _fail("container recovery configuration archive is not pinned")
            continue
        live_path = _store_relative_path(paths, relative)
        if source in successor_sources and not os.path.lexists(live_path):
            # Checkpoint records are optional on a clean successor.  The
            # successor validator checks identity and shape when one is
            # present; an archived checkpoint may legitimately disappear
            # when the restarted service has not published one yet.
            if source in successor_optional_sources:
                continue
            _fail(f"container recovery successor evidence is missing: {source}")
        live_bytes = _read_stable_container_recovery_file(
            live_path, "container recovery live evidence", maximum
        )
        if source == "runtime-services/OWNER.json":
            # Native recovery archives the pre-recovery owner, then publishes
            # its canonical Failed owner.  A later authenticated terminal
            # drain may publish a Drained owner before the same one-shot
            # Compose authorization is consumed on restart.  Accept that
            # third endpoint only when the caller supplied the digest from
            # the authenticated terminal-drain proof; every other live owner
            # digest means the receipt no longer describes this store.
            allowed_owner_sha256 = {
                request["owner_sha256"],
                result["owner_sha256_after"],
            }
            if authenticated_drained_owner_sha256 is not None:
                allowed_owner_sha256.add(authenticated_drained_owner_sha256)
            live_owner_sha256 = _sha256_bytes(live_bytes)
            if live_owner_sha256 not in allowed_owner_sha256:
                _fail("container recovery live owner changed outside its pinned transition")
            continue
        if source in successor_sources:
            continue
        if live_bytes != archive_bytes:
            _fail(f"container recovery archived evidence differs from live store: {source}")
    for source in absent_names:
        relative = _recovery_relative_path(source, "container recovery absent source")
        live_path = _store_relative_path(paths, relative)
        _assert_no_links(live_path.parent, "container recovery absent-source parent")
        if source in successor_sources:
            continue
        if os.path.lexists(live_path):
            _fail(f"container recovery absent source was published: {source}")


def _validate_container_recovery_receipt(
    paths: RuntimePaths,
    context: Mapping[str, Any],
    result: Mapping[str, Any],
    *,
    authenticated_drained_owner_sha256: str | None = None,
    authenticated_successor_owner: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    request = context["request"]
    authorization = context["authorization"]
    if not isinstance(result, dict):
        _fail("native container recovery returned a non-object")
    if result.get("schema_version") != CONTAINER_RECOVERY_RECEIPT_SCHEMA:
        _fail("native container recovery receipt schema is unsupported")
    if (result.get("status") != "recovered"
            or result.get("outcome") != _container_recovery_expected_outcome(request)):
        _fail("native container recovery did not return a completed recovery")
    for field, expected in (
        ("request_id", request["request_id"]),
        ("request_sha256", context["request_sha256"]),
        ("config_sha256", request["config_sha256"]),
        ("target_id", TARGET_ID),
        ("owner_sha256_before", request["owner_sha256"]),
        ("owner_state_before", request["expected_owner"]["state"]),
        ("owner_state_after", "failed"),
        ("store_root_sha256", request["store_root_sha256"]),
        ("application", request["application"]),
        ("ledger_root_sha256", request["ledger_root_sha256"]),
        ("ledger_snapshot_sha256", request["ledger_snapshot_sha256"]),
        ("attestation_sha256", context["attestation_sha256"]),
        ("docker_manifest_sha256", request["docker_manifest_sha256"]),
        ("prior_ready_owner_proof_sha256", request["prior_ready_owner_proof_sha256"]),
        ("device_release_mapping_sha256", request["device_release_mapping_sha256"]),
    ):
        if result.get(field) != expected:
            _fail(f"native container recovery receipt {field} differs from request")
    owner_after = result.get("owner_sha256_after")
    if HEX64.fullmatch(owner_after or "") is None or owner_after == request["owner_sha256"]:
        _fail("native container recovery did not publish a new failed owner")
    for field, pattern in (("historical_build_commit", HEX40), ("executor_build_commit", HEX40),
                           ("historical_build_snapshot", HEX64), ("executor_build_snapshot", HEX64)):
        if not isinstance(result.get(field), str) or pattern.fullmatch(result[field]) is None:
            _fail(f"native container recovery receipt has invalid {field}")
    if not isinstance(result.get("archived_evidence_sha256"), str):
        _fail("native container recovery receipt has no archive digest")
    _validate_container_recovery_archive(
        paths,
        context,
        result,
        authenticated_drained_owner_sha256=authenticated_drained_owner_sha256,
        authenticated_successor_owner=authenticated_successor_owner,
    )
    return dict(result)


def _container_recovery_pending_markers(paths: RuntimePaths) -> list[Path]:
    root = paths.store / "runtime-services" / "container-recovery"
    _assert_no_links(root, "container recovery marker root")
    try:
        entries = list(root.iterdir())
    except FileNotFoundError:
        return []
    except OSError as error:
        _fail(f"cannot inspect container recovery markers: {error}")
    pending: list[Path] = []
    for entry in entries:
        if entry.is_symlink() or not entry.is_dir() or HEX64.fullmatch(entry.name) is None:
            _fail("container recovery marker directory is invalid")
        receipt_path = entry / "receipt.json"
        try:
            receipt, _ = _read_stable_container_recovery_json(
                receipt_path,
                "container recovery marker",
                MAX_CONTAINER_RECOVERY_RECEIPT_BYTES,
            )
        except FileNotFoundError:
            continue
        if receipt.get("status") != "recovered":
            pending.append(receipt_path)
    return pending


def _container_recovery_process_metadata(
    context: Mapping[str, Any], result: Mapping[str, Any]
) -> dict[str, Any]:
    authorization = context["authorization"]
    request = context["request"]
    return {
        "schema_version": CONTAINER_RECOVERY_AUTHORIZATION_SCHEMA,
        "authorization_sha256": context["authorization_sha256"],
        "operator_authorization_sha256": authorization["operator_authorization_sha256"],
        "request_id": request["request_id"],
        "request_sha256": context["request_sha256"],
        "attestation_sha256": context["attestation_sha256"],
        "config_sha256": request["config_sha256"],
        "owner_sha256": request["owner_sha256"],
        "launch_sha256": request["launch_sha256"],
        "prior_stop_journal_sha256": request["prior_ready_owner_proof_sha256"],
        "owner_sha256_after": result.get("owner_sha256_after"),
    }


def container_recovery_authorization_metadata(
    paths: RuntimePaths, recovery: Mapping[str, Any]
) -> dict[str, Any]:
    """Return the bounded proof copied into the PID-1 process receipt."""

    context = _read_container_recovery_authorization(paths)
    if (
        recovery.get("schema_version") != CONTAINER_RECOVERY_RECEIPT_SCHEMA
        or recovery.get("request_sha256") != context["request_sha256"]
        or recovery.get("attestation_sha256") != context["attestation_sha256"]
    ):
        _fail("container recovery receipt differs from the current authorization")
    return _container_recovery_process_metadata(context, recovery)


def _validate_container_recovery_drained_proof(
    paths: RuntimePaths, context: Mapping[str, Any]
) -> dict[str, Any]:
    drain = _read_authenticated_terminal_drain(paths)
    receipt = drain["receipt"]
    metadata = receipt.get("container_recovery_authorization")
    recovered = receipt.get("container_recovery")
    if not isinstance(metadata, dict) or not isinstance(recovered, dict):
        _fail("persistent container recovery authorization has no drained process proof")
    expected_metadata = _container_recovery_process_metadata(context, recovered)
    if metadata != expected_metadata:
        _fail("drained process proof differs from container recovery authorization")
    current_owner, _, current_owner_sha256 = _container_recovery_owner_digest(paths)
    if current_owner != drain["owner"]:
        _fail("persisted drained owner changed after terminal drain authentication")
    recovered = _validate_container_recovery_receipt(
        paths,
        context,
        recovered,
        authenticated_drained_owner_sha256=current_owner_sha256,
        authenticated_successor_owner=drain["pin"],
    )
    expected_owner = context["expected_owner"]
    if _owner_identity(current_owner) == _owner_identity(expected_owner):
        _fail("container recovery authorization points to the old owner after drain")
    return recovered


@contextmanager
def container_recovery_configuration_override(
    paths: RuntimePaths, recovery: Mapping[str, Any] | None
):
    """Allow one config generation rotation only after native recovery proof."""

    if recovery is None:
        yield
        return
    owner, _, _ = _container_recovery_owner_digest(paths)
    previous = os.environ.get("FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256")
    if owner.get("state") == "failed":
        config_sha256 = recovery.get("config_sha256")
        _container_recovery_hex(config_sha256, "validated container recovery config SHA-256")
        os.environ["FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256"] = config_sha256
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256", None)
        else:
            os.environ["FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256"] = previous


def _container_recovery_binary_sha(paths: RuntimePaths, cli: Path | None) -> str:
    """Hash the canonical lifecycle ELF through a stable no-follow descriptor."""
    executable = _cli_path(paths, cli)
    canonical_executable = _absolute(paths.package / "bin" / "fullmag-bin", "native recovery binary")
    if executable != canonical_executable:
        _fail("v3 container recovery must probe the actual native package executable")
    _assert_no_links(executable, "native recovery binary")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(executable, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= 2 * GIB:
            _fail("native recovery binary is not a bounded regular file")
        digest = hashlib.sha256()
        count = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            if count > before.st_size:
                _fail("native recovery binary grew during identity observation")
            digest.update(chunk)
        after = os.fstat(descriptor)
        named = os.stat(executable, follow_symlinks=False)
        def identity(value):
            return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if count != before.st_size or identity(before) != identity(after) or identity(after) != identity(named):
            _fail("native recovery binary changed during identity observation")
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def _publish_container_capability_proof(paths: RuntimePaths, context, proof) -> None:
    # This explicit runtime-services view is the named control volume. Never
    # fall back to the host-backed store to publish technical build evidence.
    if paths.runtime_services is None:
        _fail("v3 native capability proof requires the explicit runtime-control volume")
    root = runtime_services_root(paths) / "container-recovery" / context["request_sha256"] / "native-capabilities"
    _ensure_directory(root, "native container recovery capability proof directory")
    path = root / (proof["binary_sha256"] + "-" + proof["capabilities_raw_sha256"] + ".json")
    raw = _canonical_container_recovery_json(proof) + b"\n"
    try:
        existing = _read_stable_container_recovery_file(path, "native capability proof", MAX_JSON_BYTES * 2)
    except FileNotFoundError:
        existing = None
    if existing is not None:
        if existing != raw:
            _fail("native capability proof history already contains different bytes")
        return
    # A partial write must never occupy the deterministic immutable name.
    # Only this invocation's disposable temporary is cleaned up. A hard link
    # publishes flushed bytes atomically and refuses to replace any history.
    temporary = root / ("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o660)
    try:
        try:
            view = memoryview(raw)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    _fail("native capability proof write was incomplete")
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        _assert_no_links(root, "native capability publication directory")
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            if _read_stable_container_recovery_file(path, "native capability proof", MAX_JSON_BYTES * 2) != raw:
                _fail("native capability proof history already contains different bytes")
    finally:
        temporary.unlink()
    directory = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _probe_container_recovery_capabilities(paths: RuntimePaths, context, *, cli, timeout):
    """Pure native introspection precedes every first v3/v4 native mutation.

    This gate qualifies the newly built executable inside the backend. It is
    deliberately not evidence about the earlier host container-removal step.
    """
    binary_sha = _container_recovery_binary_sha(paths, cli)
    provenance_raw = _read_stable_container_recovery_file(paths.provenance, "native package provenance", MAX_JSON_BYTES)
    try:
        provenance = json.loads(provenance_raw, object_pairs_hook=_reject_duplicate_keys)
    except (ValueError, UnicodeDecodeError) as error:
        _fail(f"native package provenance is invalid: {error}")
    if not isinstance(provenance, dict):
        _fail("native package provenance must be an object")
    commit, snapshot = _source_identity(paths)
    raw_output: list[bytes] = []
    try:
        capability = _run_cli(paths, ("runtime", "service-container-recovery-capabilities"),
                              timeout=min(timeout, 30.0), cli=cli, raw_output=raw_output)
    except RuntimeServiceError as error:
        _fail("native container recovery capabilities are unavailable; no mutator was invoked: " + str(error))
    if _container_recovery_binary_sha(paths, cli) != binary_sha:
        _fail("native container recovery binary changed during capability probe")
    if _read_stable_container_recovery_file(paths.provenance, "native package provenance", MAX_JSON_BYTES) != provenance_raw:
        _fail("native package provenance changed during capability probe")
    if not isinstance(capability, dict) or set(capability) != {"schema_version", "supported_recovery_schemas", "build_identity"} or capability.get("schema_version") != CONTAINER_RECOVERY_CAPABILITIES_SCHEMA:
        _fail("native container recovery capability document has an unsupported schema")
    supported = capability.get("supported_recovery_schemas")
    if (not isinstance(supported, list) or not 1 <= len(supported) <= 16
            or any(not isinstance(item, str) or len(item) > 128
                   or re.fullmatch(r"runtime_service_container_recovery_request\.v[1-9][0-9]*", item) is None
                   for item in supported)
            or len(set(supported)) != len(supported)
            or context["request"]["schema_version"] not in supported):
        _fail("actual native executable does not support the requested container recovery schema")
    build = capability.get("build_identity")
    if not isinstance(build, dict) or set(build) != {"version", "built_at_utc", "git_commit", "worktree_state", "source_snapshot_sha256"}:
        _fail("native recovery capabilities have an invalid build identity")
    _container_recovery_text(build["version"], "native capability version", 128)
    if (not isinstance(build["built_at_utc"], str)
            or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", build["built_at_utc"]) is None
            or not isinstance(build["worktree_state"], str)
            or build["worktree_state"] not in {"clean", "dirty", "unknown"}
            or build["git_commit"] != commit or build["source_snapshot_sha256"] != snapshot):
        _fail("native capability build identity differs from pinned package provenance")
    if len(raw_output) != 1 or not isinstance(raw_output[0], bytes):
        _fail("native capability probe has no exact raw stdout evidence")
    try:
        raw_document = json.loads(raw_output[0], object_pairs_hook=_reject_duplicate_keys)
    except (ValueError, UnicodeDecodeError) as error:
        _fail(f"native capability stdout evidence is invalid: {error}")
    if raw_document != capability:
        _fail("native capability parsed result differs from its raw stdout")
    proof = {"schema_version": "fullmag.native-container-recovery-capability-proof.v1",
             "request_sha256": context["request_sha256"], "request_schema": context["request"]["schema_version"],
             "binary_path": str(_cli_path(paths, cli)), "binary_sha256": binary_sha,
             "capabilities_raw_sha256": _sha256_bytes(raw_output[0]), "capabilities_raw_utf8": raw_output[0].decode("utf-8"),
             "provenance_sha256": _sha256_bytes(provenance_raw), "build_identity": dict(build)}
    _publish_container_capability_proof(paths, context, proof)
    return proof


def _run_container_recovery_cli(
    paths: RuntimePaths,
    arguments: Sequence[str],
    *,
    timeout: float,
    cli: Path | None,
    binary_sha256: str | None = None,
) -> dict[str, Any]:
    """Retry only the transient native descriptor conflict for this recovery."""

    deadline = time.monotonic() + CONTAINER_RECOVERY_WRITER_BUSY_RETRY_SECONDS
    while True:
        try:
            if binary_sha256 is not None and _container_recovery_binary_sha(paths, cli) != binary_sha256:
                _fail("native container recovery binary changed before mutator invocation")
            return _run_cli(paths, arguments, timeout=timeout, cli=cli)
        except RuntimeServiceError as error:
            message = str(error).removeprefix("runtime CLI failed: ").strip()
            lines = [line.strip() for line in message.splitlines() if line.strip()]
            if lines and lines[0].startswith("[fullmag] version: "):
                lines.pop(0)
            if not lines:
                raise
            native_message = lines.pop(0).removeprefix("Error: ")
            if (native_message not in {
                    CONTAINER_RECOVERY_WRITER_BUSY_MESSAGE,
                    CONTAINER_RECOVERY_WRITER_BUSY_NATIVE_MESSAGE,
                } or lines not in ([], ["Caused by:", "session store writer is busy"])):
                raise
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise
            time.sleep(min(CONTAINER_RECOVERY_WRITER_BUSY_SLEEP_SECONDS, remaining))


def recover_container_namespace(
    paths: RuntimePaths | None = None,
    *,
    authorization_path: Path | None = None,
    cli: Path | None = None,
    timeout: float = 90.0,
) -> dict[str, Any] | None:
    """Recover one explicitly authorized, already stopped Docker namespace."""

    paths = paths or canonical_paths()
    configured = os.environ.get(CONTAINER_RECOVERY_AUTHORIZATION_ENV) or None
    configured_sha = os.environ.get(CONTAINER_RECOVERY_AUTHORIZATION_SHA256_ENV) or None
    if configured is None and configured_sha is None and authorization_path is None:
        pending = _container_recovery_pending_markers(paths)
        if pending:
            _fail("pending container recovery requires a new explicit authorization")
        return None
    if configured is None or configured_sha is None:
        _fail("container recovery authorization path and SHA-256 must be supplied together")
    if os.environ.get(RECOVERY_AUTHORIZATION_ENV):
        _fail("legacy runtime recovery and container recovery are mutually exclusive")
    context = _read_container_recovery_authorization(paths, authorization_path)
    current_owner, current_owner_raw, current_owner_sha256 = _container_recovery_owner_digest(paths)
    state = current_owner.get("state")
    request = context["request"]
    if state == "drained":
        return _validate_container_recovery_drained_proof(paths, context)
    receipt_path = (
        paths.store
        / "runtime-services"
        / "container-recovery"
        / context["request_sha256"]
        / "receipt.json"
    )
    try:
        existing, _ = _read_stable_container_recovery_json(
            receipt_path,
            "container recovery receipt",
            MAX_CONTAINER_RECOVERY_RECEIPT_BYTES,
        )
    except FileNotFoundError:
        existing = None
    if state == "failed" and existing is not None and existing.get("status") == "recovered":
        # A receipt-backed Failed owner is an immutable first-recovery replay;
        # never invoke the native mutator a second time.
        validated = _validate_container_recovery_receipt(paths, context, existing)
        if current_owner_sha256 != validated.get("owner_sha256_after"):
            _fail("container recovery failed owner differs from its immutable receipt")
        return validated
    if existing is not None and existing.get("status") == "recovered":
        _fail("container recovery receipt is complete but the current owner is not its failed owner")
    prepared_failed_owner = state == "failed" and isinstance(existing, dict) and existing.get("status") == "prepared"
    if (
        not prepared_failed_owner
        and (
            current_owner_sha256 != context["authorization"]["owner_sha256"]
            or current_owner != request["expected_owner"]
        )
    ):
        _fail("container recovery authorization does not match the current owner; a new request is required")
    if state not in {"ready", "unknown", "failed"}:
        _fail(f"container recovery cannot run from owner state {state!r}")
    config_raw = _read_stable_container_recovery_file(
        paths.config, "container recovery runtime configuration", MAX_CONTAINER_RECOVERY_REQUEST_BYTES
    )
    if _sha256_bytes(config_raw) != context["config_sha256"]:
        _fail("container recovery runtime configuration changed after authorization")
    launch_raw = _read_stable_container_recovery_file(
        runtime_services_root(paths) / "LAUNCH.json",
        "container recovery runtime launch record",
        MAX_CONTAINER_RECOVERY_REQUEST_BYTES,
    )
    if _sha256_bytes(launch_raw) != context["authorization"]["launch_sha256"]:
        _fail("container recovery runtime launch record changed after authorization")
    recovery_arguments = (
        "runtime",
        "service-recover-container",
        "--config",
        str(paths.config),
        "--request",
        str(context["request_path"]),
        "--request-sha256",
        context["request_sha256"],
        "--attestation",
        str(context["attestation_path"]),
        "--attestation-sha256",
        context["attestation_sha256"],
    )
    capability = None
    if request.get("schema_version") in {
        CONTAINER_RECOVERY_TERMINAL_REQUEST_SCHEMA,
        CONTAINER_RECOVERY_HELD_MANUAL_REQUEST_SCHEMA,
    }:
        capability = _probe_container_recovery_capabilities(paths, context, cli=cli, timeout=timeout)
    result = _run_container_recovery_cli(
        paths,
        recovery_arguments,
        timeout=timeout,
        cli=cli,
        **({"binary_sha256": capability["binary_sha256"]} if capability is not None else {}),
    )
    if capability is not None and (
        not isinstance(result, dict)
        or result.get("executor_build_commit") != capability["build_identity"]["git_commit"]
        or result.get("executor_build_snapshot") != capability["build_identity"]["source_snapshot_sha256"]
    ):
        _fail("native container recovery receipt executor differs from the capability-qualified binary")
    validated = _validate_container_recovery_receipt(paths, context, result)
    _, _, published_owner_sha256 = _container_recovery_owner_digest(paths)
    if published_owner_sha256 != validated.get("owner_sha256_after"):
        _fail("native container recovery failed owner changed after publication")
    return validated


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
    paths: RuntimePaths, port: int, expected_binding: str, *, timeout: float = 5.0,
    deadline: float | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Validate one complete API identity and return it with the profile document."""

    if timeout <= 0:
        _fail("API probe timeout must be positive")
    if not HEX64.fullmatch(expected_binding):
        _fail("API accepted-store binding must be a lowercase SHA-256")

    def request_timeout() -> float:
        if deadline is None:
            return timeout
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeServiceTransportError("API identity probe deadline expired")
        return min(timeout, remaining)

    commit, snapshot = _source_identity(paths)
    status, headers, document = _http_json(
        port, "/v2/platform/openapi.json", timeout=request_timeout()
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
        port, "/v2/platform/compute/profiles?limit=100", timeout=request_timeout()
    )
    if profile_status != 200:
        health_status, health_headers, health = _http_json(
            port, "/v2/platform/health", timeout=request_timeout()
        )
        if (health_status == 200 and health.get("status") == "degraded"
                and _single_header(health_headers, "x-fullmag-api-instance") == instance
                and _single_header(health_headers, "x-api-contract-version") == contract_version):
            # The API has already fenced its failed startup. Keep its verified
            # identity without requiring a compute route or starting an owner.
            raise RuntimeServiceOwnerStartupFailure(
                "API startup entered diagnostic-only mode; inspect API startup logs for the cause",
                api_identity={
                    "api_instance_id": instance,
                    "api_contract_version": contract_version,
                    "build_identity": build_identity,
                    "runtime_store_binding": store_binding,
                },
                api_port=port,
            )
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
    paths: RuntimePaths, port: int, expected_binding: str,
    timeout: float = API_BINDING_STARTUP_TIMEOUT_SECONDS,
    *,
    api_process_poll: Callable[[], int | None] | None = None,
) -> Mapping[str, Any]:
    """Pin API source, instance, accepted store, and the v2 profile route."""

    if (type(timeout) not in (int, float)
            or not 0 < timeout <= ACCEPTED_REATTACH_API_STARTUP_TIMEOUT_SECONDS):
        _fail("API startup timeout must be positive and at most 300 seconds")
    started = time.monotonic()
    deadline = started + timeout
    next_progress = started + 10.0
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            identity, profile = _probe_api_identity(
                paths, port, expected_binding,
                timeout=min(5.0, max(0.001, deadline - time.monotonic())),
                deadline=deadline,
            )
            if time.monotonic() >= deadline:
                raise RuntimeServiceTransportError(
                    "API identity validation exceeded startup deadline"
                )
            return {**identity, "profiles": profile}
        except RuntimeServiceOwnerStartupFailure:
            # Diagnostic availability is a definitive startup outcome, not a
            # transport retry and not evidence of a ready native service.
            raise
        except (RuntimeServiceError, OSError) as error:
            last_error = error
            if api_process_poll is not None and api_process_poll() is not None:
                raise RuntimeServiceUnknown(
                    f"API binding did not become ready: {last_error}"
                ) from error
        now = time.monotonic()
        if now >= next_progress:
            print(
                "[fullmag-backend] Waiting for API binding: "
                f"elapsed_seconds={now - started:.0f} budget_seconds={timeout:.0f}",
                flush=True,
            )
            next_progress = now + 10.0
        time.sleep(min(0.2, max(0.0, deadline - now)))
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


def _terminal_owner_children(
    owner: Mapping[str, Any],
    *,
    state: str,
    name: str,
    allowed_child_statuses: Sequence[str] | None = None,
) -> None:
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
    if allowed_child_statuses is None:
        expected_status = "running" if state == "ready" else "exited_success"
        if any(child.get("status") != expected_status for child in by_role.values()):
            _fail(f"{name} child status is not {expected_status}")
    else:
        expected_statuses = tuple(allowed_child_statuses)
        if any(child.get("status") not in expected_statuses for child in by_role.values()):
            _fail(f"{name} child status is not one of {expected_statuses!r}")


def _validate_terminal_owner(
    owner: Mapping[str, Any],
    *,
    state: str,
    name: str,
    allowed_child_statuses: Sequence[str] | None = None,
) -> None:
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
    _terminal_owner_children(
        owner,
        state=state,
        name=name,
        allowed_child_statuses=allowed_child_statuses,
    )
    _owner_fingerprint(owner)


def _read_authenticated_terminal_drain(paths: RuntimePaths) -> dict[str, Any]:
    """Validate the previous entrypoint's authenticated terminal drain proof."""

    receipt_path = process_receipt_path(paths)
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

    owner_path = runtime_services_root(paths) / "OWNER.json"
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

    lock_path = runtime_services_root(paths) / "OWNER.lock"
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

    owner_path = runtime_services_root(paths) / "OWNER.json"
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
    return runtime_services_root(paths) / f"docker-client-{token}.json"


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


def _accepted_store_owner_pin_path(paths: RuntimePaths, technical_path: Path) -> Path:
    """Return the native store alias after proving both volume views agree.

    Docker mounts ``runtime-control/runtime-services`` at both the technical
    runtime-control path and the accepted SessionStore compatibility path.
    Python writes the pin through the technical view.  Rust deliberately only
    accepts an owner path below its configured accepted store, so pass the
    second view to the CLI only after comparing the exact persisted bytes.
    """

    technical_root = runtime_services_root(paths)
    try:
        relative = technical_path.relative_to(technical_root)
    except ValueError:
        _fail("pinned runtime service owner is outside the technical runtime-services root")
    if len(relative.parts) != 1:
        _fail("pinned runtime service owner path is not canonical")
    accepted_path = paths.store / RUNTIME_SERVICES_RELATIVE / relative
    try:
        technical_bytes = _bounded_regular(
            technical_path, "technical pinned runtime service owner"
        )
        accepted_bytes = _bounded_regular(
            accepted_path, "accepted-store pinned runtime service owner"
        )
    except OSError as error:
        _fail(f"cannot verify the accepted-store owner pin alias: {error}")
    if technical_bytes != accepted_bytes:
        _fail("technical and accepted-store owner pin bytes differ")
    return accepted_path


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
    api_startup_timeout: float | None = None,
    api_process_poll: Callable[[], int | None] | None = None,
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
    api_probe = wait_for_api(
        paths, port, expected_binding,
        timeout=(min(timeout, API_BINDING_STARTUP_TIMEOUT_SECONDS)
                 if api_startup_timeout is None else api_startup_timeout),
        api_process_poll=api_process_poll,
    )
    api_identity = {
        key: api_probe[key]
        for key in (
            "api_instance_id",
            "api_contract_version",
            "build_identity",
            "runtime_store_binding",
        )
    }
    try:
        ensured = _owner_from_cli(
            _run_cli(
                paths,
                ("runtime", "service-ensure", "--config", str(paths.config)),
                timeout=timeout,
                cli=cli,
            ),
            "service-ensure",
        )
    except Exception as error:
        # API liveness and native ownership are different facts. Preserve the
        # verified API identity for fenced diagnostics without inventing an
        # owner handle or retrying an operation with an unknown outcome.
        raise RuntimeServiceOwnerStartupFailure(
            f"runtime service ownership was not confirmed: {error}",
            api_identity=api_identity,
            api_port=port,
        ) from error
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
    technical_path = _pin_owner(handle.paths, observed)
    expected_path = _accepted_store_owner_pin_path(handle.paths, technical_path)
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


# Private terminal observation transport. This grants no admission/recovery
# authority and never activates a script or dispatches a Compute command.
TERMINAL_OBSERVATION_REQUEST_ENV = "FULLMAG_TERMINAL_OBSERVATION_REQUEST"
TERMINAL_OBSERVATION_DIGEST_ENV = "FULLMAG_TERMINAL_OBSERVATION_REQUEST_SHA256"
TERMINAL_OBSERVATION_STDIN_ENV = "FULLMAG_DEVELOPMENT_TERMINAL_OBSERVATION_STDIN"


def _terminal_observation_documents(paths):
    environment = process_environment(paths)
    relative = environment.get(TERMINAL_OBSERVATION_REQUEST_ENV)
    digest = environment.get(TERMINAL_OBSERVATION_DIGEST_ENV)
    if TERMINAL_OBSERVATION_STDIN_ENV in environment:
        _fail("terminal observation stdin switch is owned by PID 1")
    if relative is None and digest is None:
        return environment, None
    if (not isinstance(relative, str)
            or re.fullmatch(r"terminal-observation/[0-9a-f]{64}/request\.json", relative) is None
            or not isinstance(digest, str) or HEX64.fullmatch(digest) is None):
        _fail("terminal observation requires exact private request path and digest")
    if (environment.get("FULLMAG_STARTUP_ENABLED") == "1"
            or any(environment.get(key) is not None for key in (
                "FULLMAG_DEVELOPMENT_RESTORE_STDIN", ACCEPTED_REATTACH_STDIN_ENV,
                ACCEPTED_REATTACH_REQUEST_ENV, ACCEPTED_REATTACH_DIGEST_ENV))):
        _fail("terminal observation cannot combine with startup, authoring or accepted reattach")
    raw = _bounded_regular(_reattach_relative(paths.state_root, relative, "terminal request"),
                           "terminal observation request", 64 * 1024)
    if _sha256_bytes(raw) != digest:
        _fail("terminal observation request CAS differs")
    request = _accepted_reattach_json(raw, "terminal observation request")
    if (set(request) != {"schema", "proof_path", "proof_sha256"}
            or request.get("schema") != "fullmag.terminal-observation-request.v1"
            or request.get("proof_path") != str(PurePosixPath(relative).parent / "proof.json")
            or request.get("proof_sha256") != PurePosixPath(relative).parent.name):
        _fail("terminal observation request fields or proof identity differ")
    proof_raw = _bounded_regular(
        _reattach_relative(paths.state_root, request["proof_path"], "terminal proof"),
        "terminal observation proof", 256 * 1024)
    if _sha256_bytes(proof_raw) != request["proof_sha256"]:
        _fail("terminal observation proof CAS differs")
    proof = _accepted_reattach_json(proof_raw, "terminal observation proof")
    if proof.get("schema") != "fullmag.development-terminal-observation-proof.v1":
        _fail("terminal observation proof schema differs")
    for key in ("run_id", "session_id", "source_root", "compose_project", "control_volume"):
        if not isinstance(proof.get(key), str) or not proof[key] or len(proof[key]) > 4096:
            _fail("terminal observation proof is missing " + key)
    for key in ("native_config_sha256", "terminal_evidence_sha256"):
        if not isinstance(proof.get(key), str) or HEX64.fullmatch(proof[key]) is None:
            _fail("terminal observation proof has invalid " + key)
    return environment, {
        "request_relative": relative, "request_sha256": digest,
        "proof_relative": request["proof_path"], "proof_sha256": request["proof_sha256"],
        "proof": proof,
    }


def terminal_observation_preflight(paths):
    # Read only. Ordinary startup, native admission and namespace recovery keep
    # their existing gates; this value is not a substitute for any native proof.
    return _terminal_observation_documents(paths)[1]


@contextmanager
def terminal_observation_api_input(paths, *, terminal_preflight=None, accepted_preflight=None):
    environment, observation = _terminal_observation_documents(paths)
    if observation is None:
        if terminal_preflight is not None:
            _fail("terminal observation disappeared after preflight")
        with accepted_reattach_api_input(paths, preflight=accepted_preflight) as pair:
            yield pair[0], pair[1], None
        return
    if observation != terminal_preflight or accepted_preflight is not None:
        _fail("terminal observation preflight changed or conflicts with accepted reattach")
    proof = observation["proof"]
    parent = PurePosixPath(observation["proof_relative"]).parent
    lock_path = _reattach_relative(paths.state_root, str(parent / "launch.lock"),
                                  "terminal observation launch mutex")
    import fcntl
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            _fail("terminal observation launch mutex is not a private regular file")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            _fail("terminal observation launch is already owned")
        if environment.get("FULLMAG_RUNTIME_PROVENANCE") != str(ACCEPTED_REATTACH_PROVENANCE):
            _fail("terminal observation requires fixed Docker runtime provenance")
        provenance = _read_json(ACCEPTED_REATTACH_PROVENANCE, "terminal target provenance")
        commit, snapshot, image = (provenance.get(key) for key in
                                  ("commit", "source_snapshot_sha256", "image_id"))
        if (provenance.get("schema") != "fullmag.docker-all-image.v1"
                or provenance.get("state") != "succeeded"
                or not isinstance(commit, str) or HEX40.fullmatch(commit) is None
                or not isinstance(snapshot, str) or HEX64.fullmatch(snapshot) is None
                or not isinstance(image, str) or re.fullmatch("sha256:[0-9a-f]{64}", image) is None
                or environment.get("FULLMAG_RUNTIME_IMAGE_ID") != image):
            _fail("terminal observation target provenance is not the current succeeded build")
        configuration = _bounded_regular(paths.config, "terminal target native config", 64 * 1024)
        config_sha = _sha256_bytes(configuration)
        inspected = _run_cli(paths, [
            "runtime", "service-inspect-terminal-run", "--config", str(paths.config),
            "--config-sha256", config_sha, "--run-id", proof["run_id"],
        ], timeout=30.0)
        if (set(inspected) != {"schema_version", "run_id", "terminal_evidence_sha256",
                              "mutations_applied", "solve_replayed"}
                or inspected.get("schema_version") != "runtime_service_terminal_run_evidence.v1"
                or inspected.get("run_id") != proof["run_id"]
                or inspected.get("terminal_evidence_sha256") != proof["terminal_evidence_sha256"]
                or inspected.get("mutations_applied") is not False
                or inspected.get("solve_replayed") is not False
                or _bounded_regular(paths.config, "terminal target native config", 64 * 1024)
                   != configuration):
            _fail("terminal observation native evidence changed at target launch")
        binding = {
            "schema": "fullmag.terminal-observation-launch.v1",
            "source_proof_sha256": observation["proof_sha256"],
            "source_native_config_sha256": proof["native_config_sha256"],
            "target_build_id": commit, "target_source_sha256": snapshot,
            "target_image_id": image, "native_config_sha256": config_sha,
            "terminal_evidence_sha256": proof["terminal_evidence_sha256"],
        }
        binding_raw = json.dumps(binding, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        binding_sha = _sha256_bytes(binding_raw)
        binding_relative = str(parent / ("launch-" + binding_sha + ".json"))
        binding_path = _reattach_relative(paths.state_root, binding_relative, "terminal launch")
        _publish_accepted_reattach_raw(binding_path, binding_raw, "terminal observation launch binding")
        if _terminal_observation_documents(paths)[1] != observation:
            _fail("terminal observation controls changed before API launch")
        payload = {
            "schema": "fullmag.development-terminal-observation-input.v1",
            "target_build_id": commit, "target_source_sha256": snapshot,
            "target_image_id": image, "proof_path": observation["proof_relative"],
            "proof_sha256": observation["proof_sha256"],
            "launch_path": binding_relative, "launch_sha256": binding_sha,
        }
        launch = {"relative": binding_relative, "sha256": binding_sha, "binding": binding}
        with tempfile.TemporaryFile(mode="w+b", dir=paths.state_root) as stream:
            raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
            if len(raw) > 64 * 1024:
                _fail("terminal observation stdin exceeds its bound")
            stream.write(raw)
            stream.seek(0)
            environment[TERMINAL_OBSERVATION_STDIN_ENV] = "1"
            yield environment, stream, launch
    finally:
        os.close(fd)


def terminal_observation_runtime_receipt(paths, *, preflight, launch, handle):
    if _terminal_observation_documents(paths)[1] != preflight:
        _fail("terminal observation controls changed before native receipt")
    proof = preflight["proof"]
    if not isinstance(launch, dict) or set(launch) != {"relative", "sha256", "binding"}:
        _fail("terminal observation has no exact launch binding")
    binding = launch["binding"]
    if _sha256_bytes(_bounded_regular(
            _reattach_relative(paths.state_root, launch["relative"], "terminal launch"),
            "terminal launch", 64 * 1024)) != launch["sha256"]:
        _fail("terminal observation launch binding CAS differs")
    identity = handle.api_identity
    if not isinstance(identity, Mapping):
        _fail("terminal observation has no authenticated API identity")
    api_id = _accepted_reattach_api_id(identity.get("api_instance_id"), "terminal observation API")
    relative = str(PurePosixPath(preflight["proof_relative"]).parent / ("installed-" + api_id + ".json"))
    raw = _bounded_regular(_reattach_relative(paths.state_root, relative, "terminal installed receipt"),
                           "terminal observation installed receipt", 64 * 1024)
    receipt = _accepted_reattach_json(raw, "terminal observation installed receipt")
    expected = {
        "schema": "fullmag.terminal-observation-restored.v1", "api_instance_id": api_id,
        "run_id": proof["run_id"], "session_id": proof["session_id"],
        "session_epoch": proof["session_epoch"], "scene_revision": proof["scene_revision"],
        "terminal_outcome": "failed", "proof_sha256": preflight["proof_sha256"],
        "launch_sha256": launch["sha256"], "source_image_id": proof["image_id"],
        "source_config_sha256": proof["config_sha256"],
        "target_build_id": binding["target_build_id"],
        "target_source_sha256": binding["target_source_sha256"],
        "target_image_id": binding["target_image_id"],
        "native_config_sha256": binding["native_config_sha256"],
        "terminal_evidence_sha256": proof["terminal_evidence_sha256"],
    }
    if receipt != expected:
        _fail("terminal observation receipt differs from the real target installation")
    code, headers, run = _http_json(8081, "/v2/sessions/current/simulation/runs/current")
    if (code != 200 or _single_header(headers, "x-fullmag-api-instance") != api_id
            or run.get("run_id") != proof["run_id"] or run.get("session_id") != proof["session_id"]
            or run.get("status") != "failed"):
        _fail("terminal observation live readback differs from its native receipt")
    return {
        "schema": "fullmag.terminal-observation-runtime.v1", "api_instance_id": api_id,
        "run_id": proof["run_id"], "session_id": proof["session_id"],
        "proof_sha256": preflight["proof_sha256"], "launch_sha256": launch["sha256"],
        "installed_relative": relative, "installed_sha256": _sha256_bytes(raw),
        "target_build_id": binding["target_build_id"],
        "target_source_sha256": binding["target_source_sha256"],
        "target_image_id": binding["target_image_id"],
    }
