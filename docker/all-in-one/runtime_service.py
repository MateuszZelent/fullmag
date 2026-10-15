"""Bind the all-in-Docker process tree to the canonical Rust runtime service.

Rust owns admission, attestation, owner validation, launch serialization,
resource pools, receipts, and recovery. This module only handles the fixed
container paths, API binding, canonical CLI calls, and canonical lifecycle CLI calls.
"""
from __future__ import annotations

import dataclasses
import http.client
import json
import os
from pathlib import Path
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
CONFIG_RELATIVE = Path(".fullmag/runtime-service/docker-all.json")
MAX_JSON_BYTES = 256 * 1024
MAX_HTTP_BYTES = 4 * 1024 * 1024
GIB = 1024**3
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
OWNER_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

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


def ensure_configuration(paths: RuntimePaths | None = None) -> dict[str, Any]:
    paths = paths or canonical_paths()
    expected = build_configuration(paths)
    try:
        current = _read_json(paths.config, "runtime service configuration")
    except FileNotFoundError:
        _atomic_json(paths.config, expected, "runtime service configuration")
        return expected
    if current != expected:
        _fail("stable runtime service configuration differs from the operator profile")
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


def initialize_accepted_store(
    paths: RuntimePaths | None = None, cli: Path | None = None
) -> dict[str, Any]:
    """Invoke the Rust fixed-layout bootstrap before starting the API."""

    paths = paths or canonical_paths()
    prepare_storage(paths)
    result = _run_cli(
        paths, ("runtime", "initialize-docker-accepted-store"), timeout=60, cli=cli
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
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
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
    port: int, expected_identity: Mapping[str, Any], *, timeout: float = 2.0
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
    if (
        document.get("schema_version") != "application_service_status.v1"
        or document.get("configured") is not True
        or document.get("state") != "ready"
    ):
        _fail("API runtime-service liveness is not ready")


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
        {"identity": {field: owner.get(field) for field in fields}, "children": compact},
        sort_keys=True,
        separators=(",", ":"),
    )


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
        timeout=10,
    )
    return _owner_from_cli(result, "service-status")


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
) -> RuntimeHandle:
    """Attach or launch the service after API/store admission."""

    paths = paths or canonical_paths()
    prepare_storage(paths)
    configuration = ensure_configuration(paths)
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
        observed = _service_status(paths)
        if _owner_fingerprint(ensured) != _owner_fingerprint(observed):
            raise RuntimeServiceUnknown(
                "runtime owner changed between service-ensure and service-status"
            )
    except Exception as error:
        unknown = (
            error
            if isinstance(error, RuntimeServiceUnknown)
            else RuntimeServiceUnknown(
                f"runtime owner outcome after service-ensure is unknown: {error}"
            )
        )
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
    observed = _service_status(handle.paths)
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
        if full_api_probe:
            fresh_identity, _ = _probe_api_identity(
                handle.paths, handle.api_port, binding["binding"], timeout=5.0
            )
        else:
            _probe_api_liveness(handle.api_port, expected_identity, timeout=2.0)
            fresh_identity = None
    except (RuntimeServiceError, OSError) as error:
        raise RuntimeServiceUnknown(
            f"API identity probe failed during supervision: {error}"
        ) from error
    if fresh_identity is not None and fresh_identity != dict(expected_identity):
        raise RuntimeServiceUnknown(
            "API identity or accepted-store binding changed during supervision"
        )
    owner = _service_status(handle.paths)
    if _owner_fingerprint(owner) != _owner_fingerprint(handle.owner):
        raise RuntimeServiceUnknown("runtime service owner changed during supervision")
