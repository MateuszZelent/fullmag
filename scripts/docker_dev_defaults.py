"""Resolve and validate defaults for activation in a running Docker DEV group.

The ordinary script command deliberately discovers only the bounded ``verified``
receipts for the selected Compose group.  It never chooses a latest historical
attempt and it delegates the live container checks to the existing activation
validator before invoking the pinned activation operation.
"""
from __future__ import annotations

import argparse
from collections.abc import Mapping
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat

import fullmag_storage as storage
from docker_build_control import BuildControl, BuildControlError, canonical, toolchain_configuration
from docker_dev_host import require_host


DEFAULT_PORT = 3197
HOST_SETTINGS_SCHEMA = "fullmag.docker-host-setup.v1"
ATTEMPT_RE = re.compile(r"^[0-9a-f]{32}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_ENV_LINE = re.compile(r"^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$")
_SOURCE_ENV = "FULLMAG_SOURCE_ROOT"
_PORT_ENVS = ("FULLMAG_HTTP_PORT", "FULLMAG_FRONTEND_HOST_PORT")
# Static per-group resource budget; see docker_volume_resources.apply_group_budget.
GROUP_BUDGET_ENVS = (
    "FULLMAG_DEV_BACKEND_CPUS",
    "FULLMAG_DEV_BACKEND_MEMORY_GIB",
    "FULLMAG_DEV_FRONTEND_CPUS",
    "FULLMAG_DEV_FRONTEND_MEMORY_GIB",
)
_VERIFIED_RECEIPTS = (
    "development/verified.json",
    "resume/verified.json",
    "iteration/verified.json",
)
_MAX_DOTENV_BYTES = 256 * 1024
_MAX_SETTINGS_BYTES = 256 * 1024


class DiscoveryError(BuildControlError):
    """A missing or ambiguous default is an activation error."""


@dataclass(frozen=True)
class ScriptDefaults:
    source_root: Path
    port: int


@dataclass(frozen=True)
class ScriptPins:
    attempt: str
    config_sha256: str
    source_root: Path
    port: int
    backend_container_id: str = ""
    frontend_container_id: str = ""


def _bounded_regular(path: Path, maximum: int, label: str) -> bytes | None:
    if any(storage.is_link(candidate) for candidate in (path, *path.parents)):
        raise DiscoveryError(f"{label} traverses a reparse point: {path}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise DiscoveryError(f"cannot read {label}: {path}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise DiscoveryError(f"{label} is not a private regular file: {path}")
        data = bytearray()
        while len(data) <= maximum:
            block = os.read(descriptor, min(64 * 1024, maximum + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        if len(data) > maximum:
            raise DiscoveryError(f"{label} exceeds its bounded size: {path}")
        return bytes(data)
    except DiscoveryError:
        raise
    except OSError as error:
        raise DiscoveryError(f"cannot read {label}: {path}") from error
    finally:
        os.close(descriptor)


def _dotenv_value(raw: str, *, path: Path, line: int) -> str:
    value = raw.strip()
    if value.startswith(("'", '"')):
        if len(value) < 2 or value[-1] != value[0]:
            raise DiscoveryError(f"invalid dotenv value at {path}:{line}")
        return value[1:-1]
    return re.split(r"\s+#", value, maxsplit=1)[0].rstrip()


def _read_dotenv(path: Path) -> dict[str, str]:
    data = _bounded_regular(path, _MAX_DOTENV_BYTES, "main .env")
    if data is None:
        return {}
    values: dict[str, str] = {}
    try:
        lines = data.decode("utf-8-sig").splitlines()
    except UnicodeDecodeError as error:
        raise DiscoveryError(f"main .env is not UTF-8: {path}") from error
    for number, line in enumerate(lines, 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = _ENV_LINE.fullmatch(line)
        if not match:
            continue
        key = match.group(1)
        if key not in {_SOURCE_ENV, *_PORT_ENVS, *GROUP_BUDGET_ENVS,
                       "FULLMAG_PROJECT_STORAGE_ROOT", "FULLMAG_SCRIPT_OUTPUT_DIRECTORY"}:
            continue
        if key in values:
            raise DiscoveryError(f"duplicate {key} in main .env at {path}:{number}")
        values[key] = _dotenv_value(match.group(2), path=path, line=number)
    return values


def _known_checkouts(repo: Path) -> tuple[Path, ...]:
    try:
        records = storage.worktree_records(repo)
    except Exception as error:
        raise DiscoveryError(f"cannot enumerate registered Fullmag checkouts: {error}") from error
    result = []
    for record in records:
        value = record.get("worktree")
        if not isinstance(value, str) or not value:
            raise DiscoveryError("Git returned a worktree without an absolute path")
        candidate = Path(value).resolve()
        if not candidate.is_absolute():
            raise DiscoveryError("Git returned a non-absolute registered checkout")
        result.append(candidate)
    if not result:
        raise DiscoveryError("Git returned no registered Fullmag checkout")
    return tuple(result)


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(os.path.normpath(str(left))) == os.path.normcase(os.path.normpath(str(right)))


def _registered_source(value: object, known: tuple[Path, ...], label: str) -> Path:
    if not isinstance(value, (str, os.PathLike)) or not str(value).strip():
        raise DiscoveryError(f"{label} is empty")
    try:
        candidate = Path(value).resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as error:
        raise DiscoveryError(f"{label} is not an existing checkout") from error
    if candidate not in known or candidate.is_symlink() or not candidate.is_dir():
        raise DiscoveryError(f"{label} is not a registered Fullmag checkout: {candidate}")
    return candidate


def _checkout_containing(path: Path, known: tuple[Path, ...]) -> Path | None:
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return None
    matches = [candidate for candidate in known if resolved == candidate or candidate in resolved.parents]
    return max(matches, key=lambda candidate: len(candidate.parts), default=None)


def _storage_root(repo: Path, main: Path, dotenv: Mapping[str, str], environ: Mapping[str, str]) -> Path:
    raw = environ.get("FULLMAG_PROJECT_STORAGE_ROOT") or dotenv.get("FULLMAG_PROJECT_STORAGE_ROOT")
    if not raw:
        return (main.parent / "storage").resolve()
    candidate = Path(raw)
    if not candidate.is_absolute():
        raise DiscoveryError("FULLMAG_PROJECT_STORAGE_ROOT must be absolute")
    return candidate.resolve()


def _read_host_settings(repo: Path, main: Path, dotenv: Mapping[str, str], environ: Mapping[str, str]) -> dict[str, object]:
    root = _storage_root(repo, main, dotenv, environ)
    path = root / "index" / "docker-host-settings.json"
    data = _bounded_regular(path, _MAX_SETTINGS_BYTES, "Docker host settings")
    if data is None:
        return {}
    try:
        settings = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DiscoveryError(f"Docker host settings are invalid: {path}") from error
    if not isinstance(settings, dict) or settings.get("schema") != HOST_SETTINGS_SCHEMA:
        raise DiscoveryError("Docker host settings have an unsupported schema")
    if settings.get("storage_root") != str(root):
        raise DiscoveryError("Docker host settings belong to another storage root")
    configured_repo = settings.get("repo_root")
    if configured_repo is not None:
        configured_path = Path(str(configured_repo)).resolve()
        if not any(_same_path(configured_path, candidate) for candidate in _known_checkouts(repo)):
            raise DiscoveryError("Docker host settings belong to another Fullmag checkout")
    return settings


def _single_configured_value(values: list[tuple[str, str]], label: str) -> str | None:
    values = [(name, value.strip()) for name, value in values if value.strip()]
    if not values:
        return None
    distinct = {value for _, value in values}
    if len(distinct) != 1:
        names = ", ".join(name for name, _ in values)
        raise DiscoveryError(f"ambiguous {label}; conflicting values from {names}")
    return values[0][1]


def _port(value: object, label: str) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError) as error:
        raise DiscoveryError(f"{label} must be a decimal port") from error
    if not 1024 <= port <= 65535:
        raise DiscoveryError(f"{label} must be between 1024 and 65535")
    return port


def resolve_defaults(
    repo: Path,
    *,
    source_root: Path | str | None = None,
    port: int | str | None = None,
    environ: Mapping[str, str] | None = None,
    cwd: Path | str | None = None,
) -> ScriptDefaults:
    """Resolve source and port with explicit, deterministic precedence."""
    repo = Path(repo).resolve(strict=True)
    environ = os.environ if environ is None else environ
    known = _known_checkouts(repo)
    main = known[0]
    dotenv = _read_dotenv(main / ".env")
    settings = _read_host_settings(repo, main, dotenv, environ)

    if source_root is not None and str(source_root).strip():
        selected = _registered_source(source_root, known, "explicit source root")
    elif environ.get(_SOURCE_ENV, "").strip():
        selected = _registered_source(environ[_SOURCE_ENV], known, _SOURCE_ENV)
    else:
        current = _registered_source(repo, known, "current selected checkout") if repo in known else None
        if current is not None and current != main:
            selected = current
        else:
            current = _checkout_containing(Path.cwd() if cwd is None else Path(cwd), known)
            if current is not None and current != main:
                selected = current
            else:
                dotenv_source = dotenv.get(_SOURCE_ENV, "").strip()
                settings_source = str(settings.get("source_root", "")).strip()
                if dotenv_source:
                    selected = _registered_source(dotenv_source, known, "configured source root")
                elif settings_source:
                    selected = _registered_source(
                        settings_source, known, "saved host-settings source root")
                else:
                    selected = main

    if port is not None:
        resolved_port = _port(port, "explicit port")
    else:
        process_port = _single_configured_value(
            [(name, environ.get(name, "")) for name in _PORT_ENVS], "process port")
        if process_port is not None:
            resolved_port = _port(process_port, "process port")
        else:
            dotenv_port = _single_configured_value(
                [(name, dotenv.get(name, "")) for name in _PORT_ENVS], ".env port")
            if dotenv_port is not None:
                resolved_port = _port(dotenv_port, ".env port")
            elif settings.get("http_port") is not None:
                resolved_port = _port(settings["http_port"], "saved host-settings port")
            else:
                resolved_port = DEFAULT_PORT
    return ScriptDefaults(source_root=selected, port=resolved_port)


def configured_group_budget(
    repo: Path, environ: Mapping[str, str] | None = None
) -> dict[str, int]:
    """Return the operator's per-group budget settings as positive integers.

    The process environment overrides the main checkout's ``.env``.  Unset
    entries are omitted so the caller derives them from Docker capacity.
    """
    repo = Path(repo).resolve(strict=True)
    environ = os.environ if environ is None else environ
    dotenv = _read_dotenv(_known_checkouts(repo)[0] / ".env")
    budget: dict[str, int] = {}
    for name in GROUP_BUDGET_ENVS:
        raw = environ.get(name, "").strip() or dotenv.get(name, "").strip()
        if not raw:
            continue
        if not raw.isdecimal() or int(raw) < 1:
            raise DiscoveryError(f"{name} must be a positive whole number")
        budget[name] = int(raw)
    return budget


def _document_port(document: Mapping[str, object]) -> int:
    services = document.get("services")
    frontend = services.get("frontend") if isinstance(services, Mapping) else None
    ports = frontend.get("ports") if isinstance(frontend, Mapping) else None
    if not isinstance(ports, list) or len(ports) != 1:
        raise DiscoveryError("running frontend has no unambiguous published port")
    published = ports[0].get("published") if isinstance(ports[0], Mapping) else None
    if published is None and isinstance(ports[0], str):
        fields = ports[0].split(":")
        published = fields[-2] if len(fields) >= 2 else None
    return _port(published, "running frontend port")


def _verified_original_attempts(control: BuildControl, current: Mapping[str, object]) -> list[str]:
    current_attempt = current.get("attempt")
    if not isinstance(current_attempt, str) or not ATTEMPT_RE.fullmatch(current_attempt):
        raise DiscoveryError("development/current.json has no valid attempt fence")
    if current.get("state") not in {"succeeded", "failed-confirmed"}:
        raise DiscoveryError("the current development attempt has no admissible terminal state")
    candidates: list[str] = []
    for relative in _VERIFIED_RECEIPTS:
        value = control.read(relative, optional=True)
        if value is None:
            continue
        if not isinstance(value, Mapping) or value.get("state") != "succeeded":
            raise DiscoveryError(f"verified receipt is not a succeeded object: {relative}")
        if relative == "development/verified.json":
            attempt = value.get("attempt")
        else:
            inputs = value.get("inputs")
            attempt = inputs.get("attempt") if isinstance(inputs, Mapping) else None
        if not isinstance(attempt, str) or not ATTEMPT_RE.fullmatch(attempt):
            raise DiscoveryError(f"verified receipt has an invalid development attempt: {relative}")
        if attempt != current_attempt:
            continue
        if attempt not in candidates:
            candidates.append(attempt)
    return candidates


def _validate_live_network(backend_id: str, frontend_id: str, project: str, port: int) -> None:
    """Require the exact loopback frontend and unpublished private backend."""
    import docker_volume_activate as activate

    records = {}
    for service, identifier in (("backend", backend_id), ("frontend", frontend_id)):
        try:
            observed = json.loads(activate._docker_text("inspect", identifier))
        except (TypeError, ValueError) as error:
            raise DiscoveryError(f"running {service} inspection is invalid") from error
        if not isinstance(observed, list) or len(observed) != 1 or not isinstance(observed[0], Mapping):
            raise DiscoveryError(f"running {service} identity is ambiguous")
        records[service] = observed[0]
    for service, record in records.items():
        state = record.get("State")
        health = state.get("Health") if isinstance(state, Mapping) else None
        if not isinstance(state, Mapping) or state.get("Running") is not True:
            raise DiscoveryError(f"running {service} is not running")
        if not isinstance(health, Mapping) or health.get("Status") != "healthy":
            raise DiscoveryError(f"running {service} health is not healthy")
    backend = records["backend"]
    backend_host = backend.get("HostConfig", {})
    if not isinstance(backend_host, Mapping):
        raise DiscoveryError("running backend host configuration is invalid")
    if backend_host.get("PortBindings") or backend_host.get("NetworkMode") in {"host", "none"}:
        raise DiscoveryError("running backend is not an unpublished private service")
    backend_network_settings = backend.get("NetworkSettings", {})
    if not isinstance(backend_network_settings, Mapping):
        raise DiscoveryError("running backend network settings are invalid")
    networks = backend_network_settings.get("Networks", {})
    if not isinstance(networks, Mapping) or len(networks) != 1:
        raise DiscoveryError("running backend does not have one private application network")
    network_name = next(iter(networks))
    if not isinstance(network_name, str) or not network_name:
        raise DiscoveryError("running backend network name is invalid")
    try:
        network = json.loads(activate._docker_text("network", "inspect", network_name))
    except (TypeError, ValueError) as error:
        raise DiscoveryError("running application network inspection is invalid") from error
    if not isinstance(network, list) or len(network) != 1 or not isinstance(network[0], Mapping):
        raise DiscoveryError("running application network identity is ambiguous")
    network_record = network[0]
    labels = network_record.get("Labels", {})
    consumers = network_record.get("Containers", {})
    if not isinstance(labels, Mapping):
        raise DiscoveryError("running application network labels are invalid")
    if (network_record.get("Driver") != "bridge"
            or labels.get("com.docker.compose.project") != project
            or not isinstance(consumers, Mapping)
            or set(consumers) != {backend_id, frontend_id}):
        raise DiscoveryError("running application network has unknown ownership or consumers")
    frontend_network_settings = records["frontend"].get("NetworkSettings", {})
    if not isinstance(frontend_network_settings, Mapping):
        raise DiscoveryError("running frontend network settings are invalid")
    frontend_networks = frontend_network_settings.get("Networks", {})
    if not isinstance(frontend_networks, Mapping) or set(frontend_networks) != {network_name}:
        raise DiscoveryError("running frontend is outside the backend application network")
    frontend_host = records["frontend"].get("HostConfig", {})
    if not isinstance(frontend_host, Mapping):
        raise DiscoveryError("running frontend host configuration is invalid")
    bindings = frontend_host.get("PortBindings")
    expected = {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]}
    if bindings != expected:
        raise DiscoveryError("running frontend does not publish exactly the requested loopback port")


def _discover_pins(
    repo: Path,
    defaults: ScriptDefaults,
    *,
    requested_port: int | None = None,
) -> ScriptPins:
    from docker_dev import _compose_identity, STORAGE_PROFILE
    from docker_development_inputs import select_checkout
    from fullmag_storage import resolve_layout
    import docker_volume_activate as activate

    require_host()
    selected = select_checkout(repo, defaults.source_root)
    layout = resolve_layout(selected, STORAGE_PROFILE)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    try:
        helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    except (KeyError, TypeError) as error:
        raise DiscoveryError("selected toolchain configuration has no immutable helper image") from error
    control = BuildControl(identity, helper_image)
    # A --mount volume helper would implicitly create a missing volume. Prove
    # its existing ownership before invoking any control-volume reader.
    try:
        volumes = json.loads(activate._docker_text("volume", "inspect", control.volume))
    except (TypeError, ValueError) as error:
        raise DiscoveryError("existing DEV control volume inspection is invalid") from error
    if (not isinstance(volumes, list) or len(volumes) != 1
            or not isinstance(volumes[0], Mapping)):
        raise DiscoveryError("existing DEV control volume identity is ambiguous")
    volume = volumes[0]
    labels = volume.get("Labels")
    if (volume.get("Name") != control.volume or volume.get("Driver") != "local"
            or volume.get("Options") or not isinstance(labels, Mapping)
            or any(labels.get(key) != value for key, value in control.shared_labels.items())):
        raise DiscoveryError("existing DEV control volume belongs to another group")
    current = control.read("development/current.json", optional=True)
    if not isinstance(current, Mapping):
        raise DiscoveryError("development/current.json is missing or is not an object")
    candidates: dict[tuple[str, str, str, str], int] = {}
    for attempt in _verified_original_attempts(control, current):
        root = "development/attempts/" + attempt
        terminal = control.read(root + "/terminal.json")
        document = control.read(root + "/compose.json")
        if not isinstance(terminal, Mapping) or not isinstance(document, Mapping):
            raise DiscoveryError("development receipt or Compose document is not an object")
        if terminal.get("compose_project") != control.project or document.get("name") != control.project:
            continue
        config_sha256 = hashlib.sha256(canonical(document)).hexdigest()
        if terminal.get("config_sha256") not in (None, config_sha256):
            continue
        inputs = terminal.get("inputs")
        if not isinstance(inputs, Mapping) or inputs.get("source_root") != str(selected):
            continue
        if inputs.get("source_worktree_id") not in (None, identity["worktree_id"]):
            continue
        image = inputs.get("image_id")
        if not isinstance(image, str) or not IMAGE_ID_RE.fullmatch(image):
            continue
        try:
            runtime_terminals = activate._linked_runtime_terminals(
                control, attempt, terminal, source_root=str(selected), image=image,
                config_sha256=config_sha256,
            )
        except BuildControlError:
            continue
        for runtime_terminal in runtime_terminals:
            try:
                backend_id, frontend_id = activate._validate_running_group(
                    control, identity, document, runtime_terminal, image,
                    source_root=str(selected),
                )
                actual_port = _document_port(document)
                if requested_port is not None and actual_port != requested_port:
                    continue
                _validate_live_network(backend_id, frontend_id, control.project, actual_port)
            except BuildControlError:
                continue
            candidates[(attempt, config_sha256, backend_id, frontend_id)] = actual_port
    if len(candidates) != 1:
        if not candidates:
            raise DiscoveryError("no exactly validated running DEV group matches the selected source")
        raise DiscoveryError("multiple validated running DEV groups match the selected source")
    (attempt, config_sha256, backend_id, frontend_id), actual_port = next(iter(candidates.items()))
    return ScriptPins(attempt=attempt, config_sha256=config_sha256,
                      source_root=selected, port=actual_port,
                      backend_container_id=backend_id,
                      frontend_container_id=frontend_id)


def activate_discovered(args) -> None:
    """Resolve pins, then invoke the unchanged explicit activation operation."""
    require_host()
    repo = Path(args.repo_root).resolve(strict=True)
    defaults = resolve_defaults(repo, source_root=getattr(args, "source_root", None),
                                port=getattr(args, "port", None))
    pins = _discover_pins(
        repo,
        defaults,
        requested_port=(defaults.port if getattr(args, "port", None) is not None else None),
    )
    from docker_volume_activate import activate
    activate(argparse.Namespace(
        repo_root=repo,
        attempt=pins.attempt,
        config_sha256=pins.config_sha256,
        source_root=pins.source_root,
        script=args.script,
        request_id=getattr(args, "request_id", None),
    ))
