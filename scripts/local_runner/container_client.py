"""Host-side lifecycle client for the one Fullmag build-runner container.

The host owns the container lifecycle and the bearer token.  The container is
the only Docker consumer that receives ``/var/run/docker.sock``; this module
never accepts a mount, command, or image name from a job request.  All Docker
mutations go through :mod:`local_runner.coordinator`, which pins the native
Docker Desktop context.

This module intentionally has no command-line output.  Callers may render the
returned records after applying their own user-facing policy; no returned
record contains the API token.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import secrets
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any
from urllib.parse import unquote, urlsplit

from fullmag_storage import StorageError, atomic_json, file_lock
from local_runner import coordinator


CONFIG_SCHEMA = "fullmag.local-runner.container.v1"
SECRET_SCHEMA = "fullmag.local-runner.container-secret.v1"
CONTAINER_NAME = "Fullmag_build_runner"
CONTAINER_PORT = 8765
CONTAINER_STORAGE_ROOT = "/storage"
CONTAINER_CONFIG_PATH = "/control/config.json"
DOCKER_SOCKET_PATH = "/var/run/docker.sock"
BUILD_CONFIG_PATH = "/storage/index/local-runner-build-config.json"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
HTTP_TIMEOUT_SECONDS = 10
HTTP_SUBMIT_TIMEOUT_SECONDS = 300

ALLOWED_PROFILES = (
    "fem-cpu-release",
    "fem-gpu-release",
    "fdm-cpu-release",
)

_IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_CONTAINER_ID_RE = re.compile(r"[0-9a-f]{64}\Z")
_CONTAINER_ID_OUTPUT_RE = re.compile(r"[0-9a-f]{12,64}\Z")


class ContainerClientError(RuntimeError):
    """A container configuration, identity, or host API contract failed."""


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject redirects so the bearer header never follows a Location value."""

    def redirect_request(self, *_args: object, **_kwargs: object):
        return None


# ProxyHandler({}) deliberately ignores HTTP(S)_PROXY/NO_PROXY environment
# variables.  The API is a host-local control plane and must connect directly
# to the configured loopback endpoint.
_LOCAL_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    _NoRedirectHandler(),
)


def _owner(value: object) -> str:
    if not isinstance(value, str):
        raise ContainerClientError("Container operator must be nonempty text")
    value = value.strip()
    if not value or len(value) > 128 or any(char in value for char in "\r\n"):
        raise ContainerClientError("Container operator must be nonempty text")
    return value


def _image_id(value: object) -> str:
    if not isinstance(value, str) or not _IMAGE_RE.fullmatch(value):
        raise ContainerClientError("Configure an immutable coordinator image ID")
    return value


def _port(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ContainerClientError("Coordinator port must be between 1 and 65535")
    return value


def _storage_root(layout: Mapping[str, object]) -> Path:
    if not isinstance(layout, Mapping):
        raise ContainerClientError("A resolved storage layout is required")
    value = layout.get("storage_root")
    if not isinstance(value, (str, os.PathLike)):
        raise ContainerClientError("Resolved layout is missing an absolute storage_root")
    path = Path(value)
    if not path.is_absolute():
        raise ContainerClientError("Resolved storage_root must be absolute")
    try:
        lexical = Path(os.path.abspath(path))
        resolved = path.resolve(strict=False)
    except OSError as error:
        raise ContainerClientError("Cannot resolve the configured storage_root") from error
    if os.path.normcase(str(lexical)) != os.path.normcase(str(resolved)):
        raise ContainerClientError("Resolved storage_root must not traverse a link")
    if path.is_symlink() or resolved == Path(resolved.anchor):
        raise ContainerClientError("Resolved storage_root is not an owned storage directory")
    return resolved


def _container_labels(operator: str) -> dict[str, str]:
    return {
        "com.fullmag.local-runner": "build-coordinator",
        "com.fullmag.local-runner.role": "coordinator",
        "com.fullmag.local-runner.schema": CONFIG_SCHEMA,
        "com.fullmag.local-runner.operator": operator,
    }


def _config_paths(layout: Mapping[str, object], *, create: bool = False) -> tuple[Path, Path, Path]:
    storage = _storage_root(layout)
    index = storage / "index"
    locks = storage / "locks"
    for directory, label in ((index, "storage index"), (locks, "storage locks")):
        if directory.exists() and (directory.is_symlink() or not directory.is_dir()):
            raise ContainerClientError(f"{label} is not an owned directory")
        if create:
            directory.mkdir(parents=True, exist_ok=True)
    public = index / "local-runner-container.json"
    secret = index / "local-runner-container-secret.json"
    for path, label in ((public, "container configuration"), (secret, "container secret")):
        if path.exists() and (path.is_symlink() or not path.is_file()):
            raise ContainerClientError(f"{label} is not an owned regular file")
    return public, secret, locks / "local-runner-container.lock"


def _read_object(path: Path, label: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise ContainerClientError(f"{label} is missing")
    try:
        if path.stat().st_size > 1024 * 1024:
            raise ContainerClientError(f"{label} is too large")
        value = json.loads(path.read_text(encoding="utf-8"))
    except ContainerClientError:
        raise
    except (OSError, ValueError) as error:
        raise ContainerClientError(f"{label} is not valid JSON") from error
    if not isinstance(value, dict):
        raise ContainerClientError(f"{label} must contain a JSON object")
    return value


def _canonical_host_path(value: object) -> str:
    if not isinstance(value, str) or not value:
        return ""
    normalized = value.replace("\\", "/")
    # Docker Desktop may report a Windows bind source through its Linux VM
    # namespace.  Normalize only that documented spelling; do not turn an
    # arbitrary container path into a trusted host path.
    if normalized.casefold().startswith("/host_mnt/") and len(normalized) >= 11:
        drive = normalized[10]
        if drive.isalpha() and normalized[11:12] == "/":
            normalized = drive.upper() + ":" + normalized[11:]
    return os.path.normcase(os.path.normpath(normalized)).replace("\\", "/")


def _same_host_path(left: object, right: Path | str) -> bool:
    expected = str(right)
    actual_key = _canonical_host_path(left)
    expected_key = _canonical_host_path(expected)
    if actual_key == expected_key:
        return True
    # A Docker Desktop response can preserve a path's case/drive spelling
    # differently from Python while still identifying the same bind source.
    try:
        return os.path.normcase(os.path.abspath(str(left))) == os.path.normcase(os.path.abspath(expected))
    except (OSError, TypeError):
        return False


def _public_record(storage: Path, operator: str, image: str, port: int) -> dict[str, Any]:
    return {
        "schema": CONFIG_SCHEMA,
        "operator": operator,
        "image_id": image,
        "container_name": CONTAINER_NAME,
        "host_storage_root": str(storage),
        "storage_root": CONTAINER_STORAGE_ROOT,
        "port": port,
        "endpoint": f"http://127.0.0.1:{port}",
        "labels": _container_labels(operator),
        "build_config_path": BUILD_CONFIG_PATH,
        "allowed_profiles": list(ALLOWED_PROFILES),
    }


def _secret_record(storage: Path, operator: str, token: str, port: int) -> dict[str, Any]:
    return {
        "schema": SECRET_SCHEMA,
        "operator": operator,
        "token": token,
        "host_storage_root": str(storage),
        "storage_root": CONTAINER_STORAGE_ROOT,
        "port": port,
        "build_config_path": BUILD_CONFIG_PATH,
        "allowed_profiles": list(ALLOWED_PROFILES),
    }


_PUBLIC_KEYS = frozenset(_public_record(Path("C:/fullmag-storage"), "operator", "sha256:" + "0" * 64, CONTAINER_PORT))
_SECRET_KEYS = frozenset(_secret_record(Path("C:/fullmag-storage"), "operator", "token", CONTAINER_PORT))


def _validate_public(config: Mapping[str, object], storage: Path, operator: str) -> dict[str, Any]:
    if set(config) != _PUBLIC_KEYS:
        raise ContainerClientError("Container configuration shape mismatch")
    if config.get("schema") != CONFIG_SCHEMA or config.get("operator") != operator:
        raise ContainerClientError("Container configuration owner/schema mismatch")
    if config.get("container_name") != CONTAINER_NAME or config.get("storage_root") != CONTAINER_STORAGE_ROOT:
        raise ContainerClientError("Container configuration identity mismatch")
    if config.get("host_storage_root") != str(storage):
        raise ContainerClientError("Container storage identity mismatch")
    if config.get("labels") != _container_labels(operator):
        raise ContainerClientError("Container labels do not match the operator configuration")
    if config.get("build_config_path") != BUILD_CONFIG_PATH:
        raise ContainerClientError("Container build configuration path mismatch")
    if config.get("allowed_profiles") != list(ALLOWED_PROFILES):
        raise ContainerClientError("Container profile allow-list mismatch")
    _image_id(config.get("image_id"))
    _port(config.get("port"))
    if config.get("endpoint") != f"http://127.0.0.1:{config['port']}":
        raise ContainerClientError("Container endpoint mismatch")
    return dict(config)


def _validate_secret(secret: Mapping[str, object], storage: Path, operator: str, port: int) -> str:
    if set(secret) != _SECRET_KEYS:
        raise ContainerClientError("Container secret shape mismatch")
    if secret.get("schema") != SECRET_SCHEMA or secret.get("operator") != operator:
        raise ContainerClientError("Container secret owner/schema mismatch")
    if secret.get("host_storage_root") != str(storage) or secret.get("storage_root") != CONTAINER_STORAGE_ROOT:
        raise ContainerClientError("Container secret storage identity mismatch")
    if secret.get("port") != port or secret.get("build_config_path") != BUILD_CONFIG_PATH:
        raise ContainerClientError("Container secret runtime configuration mismatch")
    if secret.get("allowed_profiles") != list(ALLOWED_PROFILES):
        raise ContainerClientError("Container secret profile allow-list mismatch")
    token = secret.get("token")
    if not isinstance(token, str) or len(token) < 32 or len(token) > 4096 or any(char.isspace() for char in token):
        raise ContainerClientError("Container secret does not contain a valid API token")
    return token


def _load_config(layout: Mapping[str, object], operator: str) -> tuple[Path, Path, dict[str, Any], str]:
    operator = _owner(operator)
    storage = _storage_root(layout)
    public_path, secret_path, _ = _config_paths(layout)
    public = _validate_public(_read_object(public_path, "Container configuration"), storage, operator)
    secret = _read_object(secret_path, "Container secret")
    token = _validate_secret(secret, storage, operator, public["port"])
    return storage, secret_path, public, token


def configure(
    layout: Mapping[str, object],
    image_id: str | None = None,
    owner: str | None = None,
    port: int = CONTAINER_PORT,
    *,
    image: str | None = None,
) -> dict[str, Any]:
    """Install or update host configuration without contacting Docker.

    The image is an immutable digest and is only validated syntactically here;
    :func:`start` performs the Docker image identity check immediately before
    any container mutation.
    """

    if image_id is None:
        image_id = image
    elif image is not None:
        raise ContainerClientError("Specify only one coordinator image ID")
    operator = _owner(owner)
    image = _image_id(image_id)
    port = _port(port)
    storage = _storage_root(layout)
    storage.mkdir(parents=True, exist_ok=True)
    public_path, secret_path, lock_path = _config_paths(layout, create=True)
    with file_lock(lock_path, "local runner container configuration", blocking=True):
        public_exists = public_path.exists()
        secret_exists = secret_path.exists()
        if public_exists != secret_exists:
            raise ContainerClientError("Container public and secret configuration must be paired")
        token: str
        if public_exists:
            existing = _validate_public(_read_object(public_path, "Container configuration"), storage, operator)
            if existing["image_id"] != image or existing["port"] != port:
                raise ContainerClientError(
                    "Existing coordinator image/port cannot be changed implicitly; use an explicit replacement operation"
                )
            token = _validate_secret(
                _read_object(secret_path, "Container secret"), storage, operator, existing["port"]
            )
        else:
            token = secrets.token_urlsafe(48)
        public = _public_record(storage, operator, image, port)
        secret = _secret_record(storage, operator, token, port)
        atomic_json(secret_path, secret)
        try:
            os.chmod(secret_path, 0o600)
        except OSError:
            # Windows ACLs are controlled by the host account; chmod is a
            # best-effort POSIX hardening step and never changes the contract.
            pass
        atomic_json(public_path, public)
    return dict(public)


def _selected_docker_call(
    docker_call: Callable[[list[str]], object] | None,
    call: Callable[[list[str]], object] | None,
) -> Callable[[list[str]], object]:
    if docker_call is not None and call is not None:
        raise ContainerClientError("Specify only one Docker call adapter")
    selected = docker_call if docker_call is not None else call
    return selected if selected is not None else coordinator.docker


def _docker_text(call: Callable[[list[str]], object], arguments: list[str]) -> str:
    try:
        value = call(arguments)
    except Exception as error:
        if isinstance(error, ContainerClientError):
            raise
        raise ContainerClientError("Docker Desktop coordinator request failed") from error
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ContainerClientError("Docker Desktop returned non-text metadata") from error
    if not isinstance(value, str):
        raise ContainerClientError("Docker Desktop returned an unexpected result")
    return value


def _docker_json(call: Callable[[list[str]], object], arguments: list[str]) -> Any:
    raw = _docker_text(call, arguments)
    try:
        return json.loads(raw)
    except (TypeError, ValueError) as error:
        raise ContainerClientError("Docker Desktop returned invalid JSON metadata") from error


def _verify_image(call: Callable[[list[str]], object], image: str) -> None:
    image = _image_id(image)
    inspected = _docker_json(call, ["image", "inspect", image])
    if (
        not isinstance(inspected, list)
        or len(inspected) != 1
        or not isinstance(inspected[0], Mapping)
        or inspected[0].get("Id") != image
    ):
        raise ContainerClientError("Coordinator image identity mismatch")


def _find_container(call: Callable[[list[str]], object]) -> str | None:
    raw = _docker_text(
        call,
        [
            "ps",
            "-a",
            "--no-trunc",
            "--filter",
            f"name=^/{CONTAINER_NAME}$",
            "--format",
            "{{.ID}}",
        ],
    )
    identifiers = [line.strip() for line in raw.splitlines() if line.strip()]
    if len(identifiers) > 1:
        raise ContainerClientError("More than one coordinator container has the reserved name")
    if not identifiers:
        return None
    if not _CONTAINER_ID_OUTPUT_RE.fullmatch(identifiers[0]):
        raise ContainerClientError("Docker returned an invalid coordinator container ID")
    return identifiers[0]


def _inspect_container(call: Callable[[list[str]], object], container_id: str) -> dict[str, Any]:
    if not _CONTAINER_ID_OUTPUT_RE.fullmatch(container_id):
        raise ContainerClientError("Invalid coordinator container ID")
    inspected = _docker_json(call, ["inspect", container_id])
    if not isinstance(inspected, list) or len(inspected) != 1 or not isinstance(inspected[0], dict):
        raise ContainerClientError("Docker returned invalid coordinator inspection metadata")
    actual_id = inspected[0].get("Id")
    if not isinstance(actual_id, str) or not _CONTAINER_ID_RE.fullmatch(actual_id):
        raise ContainerClientError("Docker returned an invalid coordinator container ID")
    if (len(container_id) == len(actual_id) and actual_id != container_id) or (
        len(container_id) < len(actual_id) and not actual_id.startswith(container_id)
    ):
        raise ContainerClientError("Docker inspection ID does not match the requested container")
    return inspected[0]


def _mount_read_write(mount: Mapping[str, object]) -> bool | None:
    if isinstance(mount.get("RW"), bool):
        return mount["RW"]
    if isinstance(mount.get("ReadOnly"), bool):
        return not mount["ReadOnly"]
    return None


def _attest(
    inspected: Mapping[str, object],
    *,
    storage: Path,
    secret_path: Path,
    public: Mapping[str, object],
    operator: str,
) -> dict[str, Any]:
    identifier = inspected.get("Id")
    if not isinstance(identifier, str) or not _CONTAINER_ID_RE.fullmatch(identifier):
        raise ContainerClientError("Coordinator inspection did not contain an exact container ID")
    if inspected.get("Name") != f"/{CONTAINER_NAME}":
        raise ContainerClientError("Coordinator container name mismatch")
    if inspected.get("Image") != public["image_id"]:
        raise ContainerClientError("Coordinator container image mismatch")
    config = inspected.get("Config")
    if (
        not isinstance(config, Mapping)
        or config.get("Hostname") != CONTAINER_NAME
        or config.get("Labels") != _container_labels(operator)
    ):
        raise ContainerClientError("Coordinator container labels mismatch")
    host = inspected.get("HostConfig")
    if not isinstance(host, Mapping):
        raise ContainerClientError("Coordinator container host configuration is missing")
    restart = host.get("RestartPolicy")
    if not isinstance(restart, Mapping) or restart.get("Name") != "unless-stopped":
        raise ContainerClientError("Coordinator restart policy mismatch")

    mounts = inspected.get("Mounts")
    if not isinstance(mounts, list) or len(mounts) != 3:
        raise ContainerClientError("Coordinator mount set is not exact")
    expected_mounts = {
        "/storage": (storage, True),
        "/control/config.json": (secret_path, False),
        DOCKER_SOCKET_PATH: (DOCKER_SOCKET_PATH, True),
    }
    seen: set[str] = set()
    for mount in mounts:
        if not isinstance(mount, Mapping):
            raise ContainerClientError("Coordinator mount metadata is invalid")
        destination = mount.get("Destination")
        if not isinstance(destination, str) or destination not in expected_mounts or destination in seen:
            raise ContainerClientError("Coordinator mount destination mismatch")
        source, read_write = expected_mounts[destination]
        if mount.get("Type") != "bind" or not _same_host_path(mount.get("Source"), source):
            raise ContainerClientError("Coordinator mount source mismatch")
        if _mount_read_write(mount) is not read_write:
            raise ContainerClientError("Coordinator mount read/write policy mismatch")
        seen.add(destination)
    if seen != set(expected_mounts):
        raise ContainerClientError("Coordinator mount set is incomplete")

    expected_port = str(public["port"])
    bindings = host.get("PortBindings")
    if not isinstance(bindings, Mapping) or set(bindings) != {f"{CONTAINER_PORT}/tcp"}:
        raise ContainerClientError("Coordinator port binding set mismatch")
    binding = bindings.get(f"{CONTAINER_PORT}/tcp")
    if not isinstance(binding, list) or len(binding) != 1 or not isinstance(binding[0], Mapping):
        raise ContainerClientError("Coordinator port binding metadata is invalid")
    if binding[0].get("HostIp") != "127.0.0.1" or str(binding[0].get("HostPort")) != expected_port:
        raise ContainerClientError("Coordinator port binding is not host-local")

    state = inspected.get("State")
    if not isinstance(state, Mapping) or not isinstance(state.get("Status"), str):
        raise ContainerClientError("Coordinator state metadata is invalid")
    running = state.get("Running")
    if not isinstance(running, bool):
        raise ContainerClientError("Coordinator running state metadata is invalid")
    exit_code = state.get("ExitCode")
    if exit_code is not None and (isinstance(exit_code, bool) or not isinstance(exit_code, int)):
        raise ContainerClientError("Coordinator exit code metadata is invalid")
    return {
        "schema": CONFIG_SCHEMA,
        "container_id": identifier,
        "container_name": CONTAINER_NAME,
        "operator": operator,
        "image_id": public["image_id"],
        "port": public["port"],
        "endpoint": public["endpoint"],
        "labels": dict(_container_labels(operator)),
        "mounts": [
            {"destination": destination, "source": str(source), "read_write": read_write}
            for destination, (source, read_write) in expected_mounts.items()
        ],
        "state": state["Status"],
        "running": running,
        "exit_code": exit_code,
    }


def _metadata_without_container(public: Mapping[str, object]) -> dict[str, Any]:
    return {
        "schema": CONFIG_SCHEMA,
        "container_id": None,
        "container_name": CONTAINER_NAME,
        "operator": public["operator"],
        "image_id": public["image_id"],
        "port": public["port"],
        "endpoint": public["endpoint"],
        "labels": dict(public["labels"]),
        "state": "absent",
        "running": False,
    }


def status(
    layout: Mapping[str, object],
    owner: str,
    *,
    docker_call: Callable[[list[str]], object] | None = None,
    call: Callable[[list[str]], object] | None = None,
) -> dict[str, Any]:
    """Return sanitized metadata after exact identity attestation."""

    operator = _owner(owner)
    storage, secret_path, public, _ = _load_config(layout, operator)
    docker = _selected_docker_call(docker_call, call)
    identifier = _find_container(docker)
    if identifier is None:
        return _metadata_without_container(public)
    return _attest(
        _inspect_container(docker, identifier),
        storage=storage,
        secret_path=secret_path,
        public=public,
        operator=operator,
    )


def _start_unlocked(
    layout: Mapping[str, object],
    owner: str,
    *,
    docker_call: Callable[[list[str]], object] | None = None,
    call: Callable[[list[str]], object] | None = None,
) -> dict[str, Any]:
    """Create/start the exact reserved container, never replacing a foreign one."""

    operator = _owner(owner)
    storage, secret_path, public, _ = _load_config(layout, operator)
    docker = _selected_docker_call(docker_call, call)
    image = _image_id(public["image_id"])
    _verify_image(docker, image)
    identifier = _find_container(docker)
    if identifier is not None:
        inspected = _inspect_container(docker, identifier)
        metadata = _attest(
            inspected,
            storage=storage,
            secret_path=secret_path,
            public=public,
            operator=operator,
        )
        if not metadata["running"]:
            _docker_text(docker, ["start", metadata["container_id"]])
            metadata = _attest(
                _inspect_container(docker, metadata["container_id"]),
                storage=storage,
                secret_path=secret_path,
                public=public,
                operator=operator,
            )
        return metadata

    if any("," in str(path) for path in (storage, secret_path)):
        raise ContainerClientError("Storage paths containing commas cannot be bound safely")
    labels = _container_labels(operator)
    command = [
        "create",
        "--name",
        CONTAINER_NAME,
        "--hostname",
        CONTAINER_NAME,
        "--restart",
        "unless-stopped",
    ]
    for key in sorted(labels):
        command.extend(("--label", f"{key}={labels[key]}"))
    command.extend(
        (
            "--publish",
            f"127.0.0.1:{public['port']}:{CONTAINER_PORT}",
            "--mount",
            f"type=bind,source={storage},target={CONTAINER_STORAGE_ROOT}",
            "--mount",
            f"type=bind,source={secret_path},target={CONTAINER_CONFIG_PATH},readonly",
            "--mount",
            f"type=bind,source={DOCKER_SOCKET_PATH},target={DOCKER_SOCKET_PATH}",
            image,
        )
    )
    created = _docker_text(docker, command).strip()
    if not _CONTAINER_ID_OUTPUT_RE.fullmatch(created):
        raise ContainerClientError("Docker did not return an exact coordinator container ID")
    inspected = _inspect_container(docker, created)
    metadata = _attest(
        inspected,
        storage=storage,
        secret_path=secret_path,
        public=public,
        operator=operator,
    )
    _docker_text(docker, ["start", metadata["container_id"]])
    return _attest(
        _inspect_container(docker, metadata["container_id"]),
        storage=storage,
        secret_path=secret_path,
        public=public,
        operator=operator,
    )


def start(
    layout: Mapping[str, object],
    owner: str,
    *,
    docker_call: Callable[[list[str]], object] | None = None,
    call: Callable[[list[str]], object] | None = None,
) -> dict[str, Any]:
    """Serialize create/start against configure and competing start callers."""

    _owner(owner)
    _, _, lock_path = _config_paths(layout)
    try:
        with file_lock(lock_path, "local runner container start", blocking=True):
            return _start_unlocked(layout, owner, docker_call=docker_call, call=call)
    except StorageError as error:
        raise ContainerClientError("Local runner container lifecycle is busy") from error
    except OSError as error:
        raise ContainerClientError("Local runner container lifecycle lock is unavailable") from error


def _request_path(path: str) -> str:
    if not isinstance(path, str) or not path.startswith("/") or "\\" in path:
        raise ContainerClientError("Runner API path must be an absolute local path")
    parsed = urlsplit(path)
    decoded_path = unquote(parsed.path)
    if (
        parsed.scheme
        or parsed.netloc
        or parsed.fragment
        or parsed.query
        or ".." in parsed.path.split("/")
        or ".." in decoded_path.split("/")
    ):
        raise ContainerClientError("Runner API path must not contain a query, fragment, or traversal")
    if not parsed.path or "//" in parsed.path:
        raise ContainerClientError("Runner API path is invalid")
    return parsed.path


def _open_url(request_object: urllib.request.Request, timeout: int):
    return _LOCAL_OPENER.open(request_object, timeout=timeout)


def request(
    layout: Mapping[str, object],
    owner: str,
    method: str,
    path: str,
    payload: object | None = None,
) -> Any:
    """Perform an authenticated bounded JSON request to the host-local API."""

    operator = _owner(owner)
    _, _, public, token = _load_config(layout, operator)
    if not isinstance(method, str) or method.upper() not in {"GET", "POST"}:
        raise ContainerClientError("Runner API supports only GET and POST")
    method = method.upper()
    path = _request_path(path)
    try:
        body = None if payload is None else json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ContainerClientError("Runner API payload is not JSON serializable") from error
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    url = f"{public['endpoint']}{path}"
    request_object = urllib.request.Request(url, data=body, headers=headers, method=method)
    timeout = HTTP_SUBMIT_TIMEOUT_SECONDS if method == "POST" and path == "/jobs" else HTTP_TIMEOUT_SECONDS
    try:
        with _open_url(request_object, timeout) as response:
            length_header = response.headers.get("Content-Length")
            if length_header is not None:
                try:
                    length = int(length_header)
                    if length < 0:
                        raise ContainerClientError("Runner API returned an invalid response length")
                    if length > MAX_RESPONSE_BYTES:
                        raise ContainerClientError("Runner API response exceeds the bounded limit")
                except ValueError as error:
                    raise ContainerClientError("Runner API returned an invalid response length") from error
            content = response.read(MAX_RESPONSE_BYTES + 1)
            if len(content) > MAX_RESPONSE_BYTES:
                raise ContainerClientError("Runner API response exceeds the bounded limit")
    except ContainerClientError:
        raise
    except urllib.error.HTTPError as error:
        raise ContainerClientError(f"Runner API returned HTTP status {error.code}") from error
    except urllib.error.URLError as error:
        raise ContainerClientError("Runner API request failed") from error
    except TimeoutError as error:
        raise ContainerClientError("Runner API request timed out") from error
    if not content:
        return None
    try:
        return json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise ContainerClientError("Runner API returned invalid JSON") from error


def stop(layout: Mapping[str, object], owner: str) -> Any:
    """Ask the container API to stop gracefully; never invoke Docker stop/kill."""

    return request(layout, owner, "POST", "/stop", {})


def _assert_replacement_health(health: object) -> None:
    if not isinstance(health, Mapping) or health.get("ok") is not True:
        raise ContainerClientError("Coordinator health did not confirm a healthy service")
    active_jobs = health.get("active_jobs")
    if not isinstance(active_jobs, list) or active_jobs:
        raise ContainerClientError("Coordinator has active jobs; replacement is refused")
    coordinator_state = health.get("coordinator")
    if not isinstance(coordinator_state, Mapping) or coordinator_state.get("state") not in {"stopped", "paused"}:
        raise ContainerClientError("Coordinator must be stopped or paused before replacement")


def _replace_unlocked(
    layout: Mapping[str, object],
    image_id: str,
    owner: str,
    *,
    docker_call: Callable[[list[str]], object] | None = None,
    call: Callable[[list[str]], object] | None = None,
) -> dict[str, Any]:
    operator = _owner(owner)
    new_image = _image_id(image_id)
    public_path, _, _ = _config_paths(layout)
    storage, secret_path, public, _ = _load_config(layout, operator)
    docker = _selected_docker_call(docker_call, call)

    # This is deliberately before ps/inspect/stop/rm: a replacement image
    # must be proven present and immutable before any container mutation.
    _verify_image(docker, new_image)
    identifier = _find_container(docker)
    if identifier is None:
        raise ContainerClientError("No exact coordinator container exists to replace")
    current = _attest(
        _inspect_container(docker, identifier),
        storage=storage,
        secret_path=secret_path,
        public=public,
        operator=operator,
    )
    if not current["running"]:
        raise ContainerClientError("Coordinator container must be running for authenticated replacement health")

    # This is an external loopback HTTP request.  It does not use the Docker
    # socket and cannot be satisfied by a Docker inspect result.
    _assert_replacement_health(request(layout, operator, "GET", "/health"))

    _docker_text(docker, ["stop", "--time", "10", current["container_id"]])
    terminal = _attest(
        _inspect_container(docker, current["container_id"]),
        storage=storage,
        secret_path=secret_path,
        public=public,
        operator=operator,
    )
    if terminal["running"] or terminal["state"] != "exited":
        raise ContainerClientError("Coordinator did not reach an exited terminal state")

    # Explicit replacement is the only lifecycle path allowed to remove this
    # reserved container.  Never add -f/-v and never remove by name.
    _docker_text(docker, ["rm", current["container_id"]])
    if _find_container(docker) is not None:
        raise ContainerClientError("Coordinator container remained after exact removal")

    updated = dict(public)
    updated["image_id"] = new_image
    _validate_public(updated, storage, operator)
    atomic_json(public_path, updated)

    # The lock is held by replace(), so use the non-locking creation helper.
    # If this fails, the updated public image remains the truthful desired
    # image and no rollback to the removed image is attempted.
    return _start_unlocked(layout, operator, docker_call=docker)


def replace(
    layout: Mapping[str, object],
    image_id: str,
    owner: str,
    *,
    docker_call: Callable[[list[str]], object] | None = None,
    call: Callable[[list[str]], object] | None = None,
) -> dict[str, Any]:
    """Explicitly replace a quiesced coordinator with a verified image."""

    _owner(owner)
    _image_id(image_id)
    _, _, lock_path = _config_paths(layout)
    try:
        with file_lock(lock_path, "local runner container replacement", blocking=True):
            return _replace_unlocked(
                layout,
                image_id,
                owner,
                docker_call=docker_call,
                call=call,
            )
    except StorageError as error:
        raise ContainerClientError("Local runner container lifecycle is busy") from error
    except OSError as error:
        raise ContainerClientError("Local runner container lifecycle lock is unavailable") from error


install = configure


__all__ = [
    "ALLOWED_PROFILES",
    "BUILD_CONFIG_PATH",
    "CONFIG_SCHEMA",
    "CONTAINER_CONFIG_PATH",
    "CONTAINER_NAME",
    "CONTAINER_PORT",
    "CONTAINER_STORAGE_ROOT",
    "ContainerClientError",
    "DOCKER_SOCKET_PATH",
    "HTTP_SUBMIT_TIMEOUT_SECONDS",
    "HTTP_TIMEOUT_SECONDS",
    "MAX_RESPONSE_BYTES",
    "SECRET_SCHEMA",
    "configure",
    "install",
    "request",
    "replace",
    "start",
    "status",
    "stop",
]
