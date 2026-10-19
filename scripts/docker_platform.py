"""Host-specific Docker client selection for the managed DEV route.

Windows keeps using Docker Desktop's ``desktop-linux`` context. Linux uses the
operator-selected local Unix endpoint and rejects remote TCP/SSH endpoints
before any managed Compose work begins.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import unquote, urlsplit


WINDOWS_RUNTIME_UID = 65532
WINDOWS_RUNTIME_GID = 65532
WINDOWS_PROFILE = "windows-folder-v1"
DOCKER_CONTEXT_ENV = "DOCKER_CONTEXT"
DOCKER_HOST_ENV = "DOCKER_HOST"
RUNTIME_UID_ENV = "FULLMAG_RUNTIME_UID"
RUNTIME_GID_ENV = "FULLMAG_RUNTIME_GID"
HOST_PROFILE_ENV = "FULLMAG_HOST_PROFILE"
CERTIFICATE_TARGET_ENV = "FULLMAG_HOST_CERTIFICATE_TARGET"
CERTIFICATE_DIRECTORY_ENV = "FULLMAG_HOST_CERTIFICATE_DIR"
WINDOWS_CERTIFICATE_TARGET = "/run/fullmag/windows-folder-host.json"
LINUX_CERTIFICATE_DIRECTORY_TARGET = "/run/fullmag/host-admission"


class DockerPlatformError(RuntimeError):
    """The current host or Docker endpoint is not admitted for managed DEV."""


def host_profile() -> str:
    if os.name == "nt":
        return WINDOWS_PROFILE
    if sys.platform.startswith("linux"):
        from linux_docker_host import PROFILE

        return PROFILE
    raise DockerPlatformError("Docker DEV supports Windows or Linux hosts")


def runtime_identity() -> tuple[int, int]:
    if os.name == "nt":
        return WINDOWS_RUNTIME_UID, WINDOWS_RUNTIME_GID
    if not sys.platform.startswith("linux"):
        raise DockerPlatformError("Docker DEV supports Windows or Linux hosts")
    from linux_docker_host import runtime_identity as linux_runtime_identity

    identity = linux_runtime_identity()
    if (not isinstance(identity, tuple) or len(identity) != 2
            or any(isinstance(value, bool) or not isinstance(value, int) or value <= 0
                   for value in identity)):
        raise DockerPlatformError("Linux runtime identity must contain nonzero numeric UID and GID")
    return identity


def runtime_identity_record() -> dict[str, Any]:
    uid, gid = runtime_identity()
    return {"profile": host_profile(), "uid": uid, "gid": gid}


def runtime_environment(environment: Mapping[str, str] | None = None) -> dict[str, str]:
    """Return Compose interpolation values for the selected application user."""

    result = dict(os.environ if environment is None else environment)
    if os.name == "nt":
        # Preserve the established Windows Compose defaults and prevent stale
        # Linux values inherited from a shell from changing its service user.
        for name in (RUNTIME_UID_ENV, RUNTIME_GID_ENV, HOST_PROFILE_ENV,
                     CERTIFICATE_TARGET_ENV, CERTIFICATE_DIRECTORY_ENV):
            result.pop(name, None)
        return result
    uid, gid = runtime_identity()
    from linux_docker_host import PROFILE

    result[RUNTIME_UID_ENV] = str(uid)
    result[RUNTIME_GID_ENV] = str(gid)
    result[HOST_PROFILE_ENV] = PROFILE
    result[CERTIFICATE_TARGET_ENV] = LINUX_CERTIFICATE_DIRECTORY_TARGET
    result.pop(CERTIFICATE_DIRECTORY_ENV, None)
    return result


def _run_text(command: Sequence[str], environment: Mapping[str, str]) -> str:
    try:
        result = subprocess.run(
            list(command),
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=dict(environment),
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise DockerPlatformError(f"Cannot inspect the selected Docker context: {error}") from error
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise DockerPlatformError("Cannot inspect the selected Docker context"
                                  + (f": {detail[:1024]}" if detail else ""))
    return result.stdout.strip()


def _context_endpoint(name: str, environment: Mapping[str, str]) -> str:
    if not name or "\x00" in name or "\n" in name:
        raise DockerPlatformError("Docker context name is invalid")
    # `context inspect <name>` reads the selected local context metadata. Strip
    # endpoint overrides here because this is metadata lookup, not daemon use.
    inspection_environment = dict(environment)
    inspection_environment.pop(DOCKER_CONTEXT_ENV, None)
    inspection_environment.pop(DOCKER_HOST_ENV, None)
    output = _run_text(["docker", "context", "inspect", name], inspection_environment)
    try:
        records = json.loads(output)
    except (TypeError, ValueError) as error:
        raise DockerPlatformError("Docker context inspection is not valid JSON") from error
    if (not isinstance(records, list) or len(records) != 1
            or not isinstance(records[0], Mapping)):
        raise DockerPlatformError("Docker context inspection is ambiguous")
    endpoints = records[0].get("Endpoints")
    docker_endpoint = endpoints.get("docker") if isinstance(endpoints, Mapping) else None
    endpoint = docker_endpoint.get("Host") if isinstance(docker_endpoint, Mapping) else None
    if not isinstance(endpoint, str) or not endpoint:
        raise DockerPlatformError("Docker context has no Docker endpoint")
    return endpoint


def _validate_local_unix_endpoint(endpoint: str) -> str:
    if any(ord(character) < 32 for character in endpoint):
        raise DockerPlatformError("Docker endpoint contains control characters")
    parsed = urlsplit(endpoint)
    decoded_path = unquote(parsed.path)
    if (parsed.scheme != "unix" or parsed.netloc or not decoded_path.startswith("/")
            or parsed.query or parsed.fragment
            or any(part in {".", ".."} for part in decoded_path.split("/"))):
        raise DockerPlatformError(
            "Linux Docker DEV requires a local Unix socket endpoint; remote TCP and SSH contexts are refused"
        )
    try:
        endpoint_stat = Path(decoded_path).stat()
    except OSError as error:
        raise DockerPlatformError("Selected Docker Unix socket is unavailable") from error
    if not stat.S_ISSOCK(endpoint_stat.st_mode):
        raise DockerPlatformError("Selected Docker Unix endpoint is not a local socket")
    return endpoint


_PINNED_TARGET: dict[str, Any] | None = None
_PINNED_REQUEST: tuple[str, str, str] | None = None


def _request_key(environment: Mapping[str, str]) -> tuple[str, str, str]:
    return (
        environment.get(DOCKER_CONTEXT_ENV, ""),
        environment.get(DOCKER_HOST_ENV, ""),
        environment.get("DOCKER_CONFIG", ""),
    )


def docker_target(environment: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Resolve and pin the active local Docker target for this host process."""

    global _PINNED_TARGET, _PINNED_REQUEST
    env = dict(os.environ if environment is None else environment)
    if os.name == "nt":
        return {
            "profile": WINDOWS_PROFILE,
            "context_name": "desktop-linux",
            "endpoint": "desktop-linux",
            "selection": "windows-default",
            "cli_options": ("--context", "desktop-linux"),
        }
    if not sys.platform.startswith("linux"):
        raise DockerPlatformError("Docker DEV supports Windows or Linux hosts")

    request = _request_key(env)
    if _PINNED_TARGET is not None:
        if request != _PINNED_REQUEST:
            raise DockerPlatformError("Docker endpoint selection changed during this DEV operation")
        return dict(_PINNED_TARGET)

    selected_context = env.get(DOCKER_CONTEXT_ENV, "").strip()
    host_override = env.get(DOCKER_HOST_ENV, "").strip()
    if selected_context:
        endpoint = _context_endpoint(selected_context, env)
        selection = "DOCKER_CONTEXT"
        cli_options = ("--host", endpoint)
        context_name = selected_context
    elif host_override:
        endpoint = host_override
        selection = "DOCKER_HOST"
        cli_options = ("--host", host_override)
        context_name = None
    else:
        selected_context = _run_text(["docker", "context", "show"], env)
        endpoint = _context_endpoint(selected_context, env)
        selection = "active-context"
        cli_options = ("--host", endpoint)
        context_name = selected_context

    endpoint = _validate_local_unix_endpoint(endpoint)
    _PINNED_TARGET = {
        "profile": host_profile(),
        "context_name": context_name,
        "endpoint": endpoint,
        "selection": selection,
        "cli_options": cli_options,
    }
    _PINNED_REQUEST = request
    return dict(_PINNED_TARGET)


def docker_cli_prefix(environment: Mapping[str, str] | None = None) -> list[str]:
    target = docker_target(environment)
    return ["docker", *target["cli_options"]]


def docker_process_environment(environment: Mapping[str, str] | None = None) -> dict[str, str]:
    """Remove ambient endpoint overrides after pinning their exact target."""

    result = dict(os.environ if environment is None else environment)
    if os.name != "nt":
        result.pop(DOCKER_CONTEXT_ENV, None)
        result.pop(DOCKER_HOST_ENV, None)
    return result


def docker_environment(environment: Mapping[str, str] | None = None) -> dict[str, str]:
    """Return a child Docker CLI environment after endpoint selection is pinned."""

    return docker_process_environment(environment)


def target_record() -> dict[str, Any]:
    target = docker_target()
    return {
        "profile": target["profile"],
        "selection": target["selection"],
        "context_name": target["context_name"],
        "endpoint": target["endpoint"],
    }


def certificate_directory(state_root: str | os.PathLike[str]) -> Path:
    """Return an attempt-specific RO-bind directory beside the writable state."""

    state = Path(state_root).resolve(strict=True)
    return state.with_name(state.name + "-host-admission")


def require_local_linux_engine(capture: Callable[..., str]) -> dict[str, Any]:
    """Prove that the pinned endpoint is a reachable Linux engine."""

    target = docker_target()
    info = capture("info", "--format", "{{.ID}}|{{.OSType}}")
    fields = info.strip().split("|", 1)
    if (len(fields) != 2 or not fields[0]
            or re.fullmatch(r"[A-Za-z0-9._:-]{1,256}", fields[0]) is None
            or fields[1] != "linux"):
        raise DockerPlatformError("Selected local Docker endpoint is not a ready Linux engine")
    return {**target_record(), "daemon_id": fields[0]}


def admit_storage_path(path: str | os.PathLike[str]) -> dict[str, str]:
    """Validate a host path on the host-specific local storage filesystem."""

    if os.name == "nt":
        from windows_folder_host import local_volume

        return local_volume(Path(path))
    if sys.platform.startswith("linux"):
        from linux_docker_host import local_volume

        return local_volume(Path(path))
    raise DockerPlatformError("Docker DEV supports Windows or Linux hosts")


def read_owned_regular(path: str | os.PathLike[str], *, maximum: int = 8 * 1024 * 1024) -> bytes:
    if os.name == "nt":
        from windows_folder_host import read_owned_regular as reader
    elif sys.platform.startswith("linux"):
        from linux_docker_host import read_owned_regular as reader
    else:
        raise DockerPlatformError("Docker DEV supports Windows or Linux hosts")
    return reader(Path(path), maximum=maximum)


def publish_evidence(path: str | os.PathLike[str], value: Mapping[str, Any]) -> None:
    if os.name == "nt":
        from windows_folder_host import publish_evidence as publisher
    elif sys.platform.startswith("linux"):
        from linux_docker_host import publish_evidence as publisher
    else:
        raise DockerPlatformError("Docker DEV supports Windows or Linux hosts")
    publisher(Path(path), value)


def _reset_for_tests() -> None:
    global _PINNED_TARGET, _PINNED_REQUEST
    _PINNED_TARGET = None
    _PINNED_REQUEST = None
